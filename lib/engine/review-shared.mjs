import {
  isPlainRecord,
} from "../canonical.mjs";
import {
  REVIEW_SHARED_REF_ROOT,
  REVIEW_SHARED_TRACKING_ROOT,
  buildSharedReviewPayload,
  describeSharedReviewRef,
  evaluateReceivedReview,
  sharedReviewPrefix,
  sharedReviewRef,
  sharedReviewRefId,
  sharedReviewTrackingPrefix,
  sharedReviewTrackingRef,
} from "../code-review-shared-state.mjs";
import {
  fail,
  failWithCode,
} from "../cli/user-error.mjs";
import {
  getOptionString,
  normalizeId,
  requireOption,
} from "../lifecycle/common.mjs";
import {
  EXIT_CODES,
} from "../lifecycle/constants.mjs";
import {
  process,
} from "../runtime/host.mjs";
import {
  parseSharedPayload,
  serializeSharedPayload,
} from "../shared-ref-records.mjs";
import {
  ORCHESTRATION_COORDINATION_SETTING,
  plainSharedText,
} from "../story-claim-shared-state.mjs";
import {
  buildTraceAuthorityMetadata,
} from "./authorization.mjs";
import {
  buildAttribution,
  codeReviewRangeAuthors,
  readCodeReviewRecords,
  validateRecordSchema,
} from "./common.mjs";
import {
  readPullRequestDeliveryForReview,
} from "./delivery.mjs";
import {
  validatePullRequestGitBoundary,
} from "./git.mjs";
import {
  ensureInitialized,
} from "./migration.mjs";
import {
  output,
} from "./output.mjs";
import {
  isGitRepository,
  knownUnreachableRemote,
  listLocalRefs,
  pushCreateOnlyRef,
  readSharedRefs,
  remoteRefObject,
  resolveSharedScope,
  setLocalRef,
  writeRecordCommit,
} from "./shared-refs.mjs";
import {
  storyClaimPolicy,
} from "./story-claim-shared.mjs";
import {
  appendTraceEvent,
} from "./story.mjs";
import {
  buildTraceNarrative,
} from "../trace-narrative.mjs";

/**
 * Git side of code reviews shared between computers (see
 * lib/code-review-shared-state.mjs for the record layout and the acceptance
 * rules). Reviews travel through the remote named by
 * orchestration_policy.coordination, with its timeout, exactly like story
 * claims; no separate setting exists.
 *
 * Publishing happens only when a person or agent runs `review publish`:
 * nothing here is called automatically, and nothing here pushes a branch.
 * Reading (`review fetch`, and the merge gate through readReceivedCodeReviews)
 * never pushes: it lists the remote, fetches the records not seen here yet
 * into tracking refs, and validates every record it holds against this
 * repository.
 */

const CODE_REVIEW_SCHEMA = "code-review.schema.json";

function reviewSharing(context) {
  const coordination = storyClaimPolicy(context).coordination;
  return { coordination, scope: resolveSharedScope(context, coordination, ORCHESTRATION_COORDINATION_SETTING) };
}

function sharedRefFromTracking(trackingRef) {
  return `${REVIEW_SHARED_REF_ROOT}/${trackingRef.slice(REVIEW_SHARED_TRACKING_ROOT.length + 1)}`;
}

/** Validates every held record of one delivery profile revision against this repository. */
function interpretReceivedRecords(records, { profile, headSha, authors, remote }) {
  const accepted = [];
  const acceptedSources = [];
  const ignored = [];
  for (const { ref, message } of records) {
    const payload = parseSharedPayload(message);
    const schemaValid = isPlainRecord(payload?.review) && validateRecordSchema(payload.review, CODE_REVIEW_SCHEMA).valid;
    const decision = evaluateReceivedReview(payload, {
      profile,
      repository: profile.pull_request_target?.repository,
      headSha,
      authors,
      schemaValid,
      ref,
    });
    const reviewId = (schemaValid && plainSharedText(payload.review.id)) || sharedReviewRefId(ref);
    if (decision.accepted) {
      accepted.push(decision.review);
      acceptedSources.push({ review_id: reviewId, remote, ref });
    } else {
      ignored.push({ review_id: reviewId, ref, reason: decision.reason });
    }
  }
  return { accepted, accepted_sources: acceptedSources, ignored };
}

/**
 * Code reviews of one delivery profile revision received from other
 * computers, validated for the head being merged.
 *
 * With `fetch` (the default), the remote is listed and the records not seen
 * here yet are fetched into tracking refs, bounded by the coordination
 * timeout. When the remote is not configured, sharing is off, or the remote
 * cannot be reached, `available` is false with the `error`, and the records
 * fetched earlier are still read and validated. Never pushes.
 *
 * `authors` are the authors of base..head read from this repository; the
 * record's own commit_authors are ignored. Records are returned intact in
 * `accepted` (for evaluateMergeReviews, which decides by the latest
 * independent verdict), with their origin in the parallel `accepted_sources`.
 *
 * @returns {{ scope: string, remote: string|null, available: boolean, error: string|null,
 *   accepted: object[], accepted_sources: { review_id: string, remote: string|null, ref: string }[],
 *   ignored: { review_id: string, ref: string, reason: string }[], problems: string[] }}
 */
export function readReceivedCodeReviews(context, profile, { headSha, authors, fetch = true } = {}) {
  const { coordination, scope } = reviewSharing(context);
  const timeoutSeconds = coordination.timeout_seconds;
  const result = {
    scope: scope.scope,
    remote: scope.remote || null,
    available: false,
    error: null,
    accepted: [],
    accepted_sources: [],
    ignored: [],
    problems: [],
  };
  if (isGitRepository(context, timeoutSeconds) !== true) {
    return { ...result, error: "this project is not a git repository" };
  }
  let records = null;
  if (scope.scope !== "shared") {
    result.error = scope.note;
  } else if (scope.unavailable) {
    result.error = scope.unavailable;
  } else if (fetch) {
    const unreachable = knownUnreachableRemote(context, scope.remote);
    if (unreachable !== null) {
      result.error = unreachable;
    } else {
      const read = readSharedRefs(context, {
        remote: scope.remote,
        sharedRoot: REVIEW_SHARED_REF_ROOT,
        trackingRoot: REVIEW_SHARED_TRACKING_ROOT,
        prefix: sharedReviewPrefix(profile),
        timeoutSeconds,
        describe: describeSharedReviewRef,
      });
      if (read.available) {
        result.available = true;
        records = read.records;
        result.problems = read.problems.map((problem) => problem.message);
      } else {
        result.error = read.error;
      }
    }
  }
  if (records === null) {
    // Records received earlier stay valid evidence while the remote cannot be asked.
    const listed = listLocalRefs(context, [sharedReviewTrackingPrefix(profile)], timeoutSeconds);
    if (listed.error) return { ...result, error: result.error ? `${result.error}; ${listed.error}` : listed.error };
    records = listed.refs.map((item) => ({ ref: sharedRefFromTracking(item.trackingRef), message: item.message }));
  }
  return {
    ...result,
    ...interpretReceivedRecords(records, { profile, headSha, authors, remote: result.remote }),
  };
}

function sharingUnavailableGuidance(profileId, remote, reason) {
  return {
    en: {
      result: `The code reviews of ${profileId} were not shared.`,
      impact: "Other computers cannot see these reviews until they are published.",
      required_decision: `Make the git remote '${remote}' reachable, or name another remote in ${ORCHESTRATION_COORDINATION_SETTING}.remote.`,
      protection_boundary: "Nothing was written on the remote; the reviews stay recorded on this computer.",
      next_action: `Run review publish --delivery ${profileId} again once the remote can be used.`,
      details: { remote, reason },
    },
    it: {
      result: `Le revisioni del codice di ${profileId} non sono state condivise.`,
      impact: "Gli altri computer non vedono queste revisioni finché non vengono pubblicate.",
      required_decision: `Rendi raggiungibile il remote git '${remote}', oppure indica un altro remote in ${ORCHESTRATION_COORDINATION_SETTING}.remote.`,
      protection_boundary: "Non è stato scritto nulla sul remote; le revisioni restano registrate su questo computer.",
      next_action: `Esegui di nuovo review publish --delivery ${profileId} quando il remote è utilizzabile.`,
      details: { remote, reason },
    },
  };
}

/** Creates one shared review ref only if it does not exist yet, and reports what the remote holds there. */
function publishReview(context, scope, coordination, profile, review) {
  const timeoutSeconds = coordination.timeout_seconds;
  const ref = sharedReviewRef(profile, review.id);
  const base = { review_id: review.id, verdict: review.verdict, reviewed_head_sha: review.reviewed_head_sha, ref };
  // Asked first: git reports pushing an identical record commit (same content, same second) as a success.
  const present = remoteRefObject(context, scope.url, ref, timeoutSeconds);
  if (present.error) return { ...base, status: "not_published", error: present.error, stop: true };
  if (!present.objectName) {
    const commit = writeRecordCommit(context, timeoutSeconds, serializeSharedPayload(buildSharedReviewPayload({ profile, review })));
    if (commit.error) return { ...base, status: "not_published", error: commit.error, stop: true };
    const trackingRef = sharedReviewTrackingRef(ref);
    const pushed = pushCreateOnlyRef(context, { url: scope.url, ref, objectName: commit.objectName, trackingRef, timeoutSeconds });
    if (pushed.pushed) return { ...base, status: "published" };
    if (pushed.timedOut) return { ...base, status: "not_published", error: pushed.error, stop: true };
    const landed = remoteRefObject(context, scope.url, ref, timeoutSeconds);
    if (landed.error) return { ...base, status: "not_published", error: pushed.error, stop: true };
    if (landed.objectName === commit.objectName) {
      // The push reached the remote although its answer was lost.
      setLocalRef(context, trackingRef, commit.objectName, timeoutSeconds);
      return { ...base, status: "published" };
    }
    if (!landed.objectName) return { ...base, status: "not_published", error: pushed.error };
  }
  // The remote already holds a record under this name: read it, never assume it.
  const read = readSharedRefs(context, {
    remote: scope.remote,
    sharedRoot: REVIEW_SHARED_REF_ROOT,
    trackingRoot: REVIEW_SHARED_TRACKING_ROOT,
    prefix: sharedReviewPrefix(profile),
    timeoutSeconds,
    describe: describeSharedReviewRef,
  });
  if (!read.available) return { ...base, status: "not_published", error: read.error, stop: true };
  const held = parseSharedPayload(read.records.find((record) => record.ref === ref)?.message);
  if (held?.review?.record_hash === review.record_hash && held.delivery_profile_hash === profile.profile_hash) {
    return { ...base, status: "already_present" };
  }
  return { ...base, status: "conflict", error: "the remote already holds a different record under this review's name" };
}

function publishLine(result, remote) {
  const head = String(result.reviewed_head_sha || "").slice(0, 12);
  switch (result.status) {
    case "published":
      return `Published ${result.verdict} review ${result.review_id} (head ${head}) to the git remote '${remote}'.`;
    case "already_present":
      return `Review ${result.review_id} is already on the git remote '${remote}'.`;
    case "conflict":
      return `Review ${result.review_id} was NOT published: ${result.error}.`;
    default:
      return `Review ${result.review_id} was NOT published: ${result.error}.`;
  }
}

/**
 * `review publish --delivery <profile-id> [--review <id>]`: shares the valid
 * code reviews of one delivery profile recorded on this computer (all of
 * them, or the one named) through the coordination remote, each with a
 * create-only push of its own ref. Only review records are pushed: no branch,
 * and in particular not the pull request's head branch.
 */
export function publishCodeReviews(context, options) {
  ensureInitialized(context);
  const profileId = normalizeId(requireOption(options, "delivery"));
  const { profile, storyId } = readPullRequestDeliveryForReview(context, profileId);
  const requested = getOptionString(options, "review");
  let reviews = readCodeReviewRecords(context, profile.id);
  if (requested) {
    const reviewId = normalizeId(requested);
    reviews = reviews.filter((review) => review.id === reviewId);
    if (reviews.length === 0) {
      fail(
        `Code review ${reviewId} of delivery profile ${profile.id} is not recorded on this computer, `
        + "or its content no longer matches its schema or record hash.",
      );
    }
  }
  if (reviews.length === 0) {
    fail(`No valid code review of delivery profile ${profile.id} is recorded on this computer; record one with review record first.`);
  }
  const { coordination, scope } = reviewSharing(context);
  const remote = scope.remote || coordination.remote;
  if (scope.scope !== "shared" || scope.unavailable || !scope.url) {
    const reason = scope.unavailable || scope.note || `the git remote '${remote}' is not configured`;
    failWithCode(
      "CODE_REVIEW_SHARING_UNAVAILABLE",
      [
        `The code reviews of ${profile.id} were not shared: ${reason}.`,
        `Reviews are shared through the git remote named by ${ORCHESTRATION_COORDINATION_SETTING}.remote; nothing was written on any remote.`,
      ].join("\n"),
      sharingUnavailableGuidance(profile.id, remote, reason),
    );
  }
  reviews.sort((left, right) =>
    String(left.reviewed_at || "").localeCompare(String(right.reviewed_at || ""), "en")
    || String(left.id).localeCompare(String(right.id), "en"));
  const results = [];
  let stopped = null;
  for (const review of reviews) {
    if (review.repository !== profile.pull_request_target?.repository) {
      results.push({
        review_id: review.id,
        verdict: review.verdict,
        reviewed_head_sha: review.reviewed_head_sha,
        ref: null,
        status: "not_published",
        error: `it is for repository ${review.repository}, not ${profile.pull_request_target?.repository}`,
      });
      continue;
    }
    if (stopped) {
      results.push({
        review_id: review.id,
        verdict: review.verdict,
        reviewed_head_sha: review.reviewed_head_sha,
        ref: sharedReviewRef(profile, review.id),
        status: "not_published",
        error: stopped,
      });
      continue;
    }
    const { stop, ...result } = publishReview(context, scope, coordination, profile, review);
    // An unreachable remote is not asked again for every remaining review.
    if (stop) stopped = result.error;
    results.push(result);
  }
  const complete = results.every((result) => ["published", "already_present"].includes(result.status));
  const lines = [
    ...results.map((result) => publishLine(result, remote)),
    "Only review records were pushed: no branch was pushed or changed.",
    `On another computer, run review fetch --delivery ${profile.id} to receive them.`,
  ];
  const attribution = buildAttribution(context, options, "review.publish");
  const traceEvent = appendTraceEvent(context, storyId, {
    type: "sync",
    summary: `Shared ${results.filter((result) => result.status === "published").length} code review(s) of ${profile.id} `
      + `through the git remote '${remote}'`,
    outcome: complete ? "passed" : "failed",
    action: "review.publish",
    actor: attribution.actor,
    ...buildTraceAuthorityMetadata(context, options, attribution),
    narrative: buildTraceNarrative({
      "input-summary": ["source: local", `remote: ${remote}`, `delivery profile: ${profile.id}`],
      "output-summary": results.map((result) => `${result.review_id}: ${result.status}${result.error ? ` (${result.error})` : ""}`),
    }),
    related: [profile.id, ...results.map((result) => result.review_id)],
    git: attribution.git,
    run: attribution.run,
  });
  output(
    options,
    {
      status: complete ? "published" : "incomplete",
      delivery_profile_id: profile.id,
      remote,
      reviews: results,
      event: traceEvent,
    },
    lines,
  );
  if (!complete) process.exitCode = EXIT_CODES.userError;
}

/**
 * `review fetch --delivery <profile-id>`: receives the code reviews other
 * computers shared for one delivery profile (read-only on the remote) and
 * lists each one as accepted or ignored, with the reason, for the current
 * head of the delivery's head branch. Received reviews stay in git refs; no
 * record file is written.
 */
export function fetchCodeReviews(context, options) {
  ensureInitialized(context);
  const profileId = normalizeId(requireOption(options, "delivery"));
  const { profile, storyId } = readPullRequestDeliveryForReview(context, profileId);
  // The same head resolution as review record and the merge gate: what the head branch points at now.
  const runtimeTarget = validatePullRequestGitBoundary(context, profile.pull_request_target);
  if (!runtimeTarget.base_sha || !runtimeTarget.head_sha) {
    fail(`Delivery ${profile.delivery_id} has no resolvable base and head commit to check reviews against.`);
  }
  const headSha = runtimeTarget.head_sha.toLowerCase();
  const authors = codeReviewRangeAuthors(context, runtimeTarget.base_sha, headSha);
  const received = readReceivedCodeReviews(context, profile, { headSha, authors, fetch: true });
  const remote = received.remote || storyClaimPolicy(context).coordination.remote;
  const acceptedSummaries = received.accepted.map((review, index) => ({
    review_id: received.accepted_sources[index].review_id,
    verdict: review.verdict,
    reviewer: { actor_id: plainSharedText(review.reviewer?.actor_id), git_email: plainSharedText(review.reviewer?.git_email) },
    reviewed_at: plainSharedText(review.reviewed_at),
    reviewed_head_sha: review.reviewed_head_sha,
    ref: received.accepted_sources[index].ref,
  }));
  const shortHead = headSha.slice(0, 12);
  const lines = [
    received.available
      ? `Fetched shared code reviews of ${profile.id} from the git remote '${remote}' (head ${shortHead}).`
      : `The git remote '${remote}' was not read: ${received.error}. Showing reviews received earlier (head ${shortHead}).`,
    ...acceptedSummaries.map((review) =>
      `accepted: ${review.verdict} review ${review.review_id} by ${review.reviewer.actor_id} <${review.reviewer.git_email}>`),
    ...received.ignored.map((item) => `ignored: review ${item.review_id}: ${item.reason}`),
    ...received.problems.map((problem) => `note: ${problem}`),
    acceptedSummaries.length + received.ignored.length === 0 ? "No shared review was received for this delivery profile." : null,
    "Received reviews are kept in git refs under refs/agentic-sdlc-shared/reviews/, not as files under .sdlc/reviews.",
  ].filter(Boolean);
  const attribution = buildAttribution(context, options, "review.fetch");
  const traceEvent = appendTraceEvent(context, storyId, {
    type: "sync",
    summary: received.available
      ? `Received ${acceptedSummaries.length} valid shared code review(s) of ${profile.id} from the git remote '${remote}' `
        + `(${received.ignored.length} ignored)`
      : `Shared code reviews of ${profile.id} could not be fetched from the git remote '${remote}'`,
    outcome: received.available ? "passed" : "failed",
    action: "review.fetch",
    actor: attribution.actor,
    ...buildTraceAuthorityMetadata(context, options, attribution),
    narrative: buildTraceNarrative({
      "input-summary": ["source: shared", `remote: ${remote}`, `head: ${headSha}`],
      "output-summary": [
        ...acceptedSummaries.map((review) => `accepted ${review.review_id} (${review.verdict})`),
        ...received.ignored.map((item) => `ignored ${item.review_id}: ${item.reason}`),
        ...(received.available ? [] : [`not fetched: ${received.error}`]),
      ],
    }),
    related: [profile.id, ...acceptedSummaries.map((review) => review.review_id)],
    git: attribution.git,
    run: attribution.run,
  });
  output(
    options,
    {
      status: received.available ? "fetched" : "unavailable",
      delivery_profile_id: profile.id,
      head_sha: headSha,
      source: "shared",
      remote,
      available: received.available,
      error: received.error,
      accepted: acceptedSummaries,
      ignored: received.ignored,
      problems: received.problems,
      event: traceEvent,
    },
    lines,
  );
  if (!received.available) process.exitCode = EXIT_CODES.userError;
}
