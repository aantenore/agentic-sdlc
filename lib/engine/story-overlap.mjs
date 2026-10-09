import path from "node:path";
import {
  runsInsideAgentHost,
} from "../agent-host.mjs";
import {
  computeStableHash,
} from "../canonical.mjs";
import {
  fail,
} from "../cli/user-error.mjs";
import {
  deliveredOverlapKey,
  findDeliveredOverlaps,
  sharedWriteRegion,
  unconfirmedDeliveredOverlaps,
} from "../delivered-overlap.mjs";
import {
  getOptionString,
  normalizeId,
  requireOption,
} from "../lifecycle/common.mjs";
import {
  baselinePathById,
  contractExecutionContext,
} from "../lifecycle/story.mjs";
import {
  childProcess,
  Date,
  fs,
} from "../runtime/host.mjs";
import {
  orchestrationPolicy,
} from "../story-claim-shared-state.mjs";
import {
  readStoryBaseAcknowledgements,
} from "./base-acknowledgements.mjs";
import {
  collectDeliveredWorkEvidence,
  gitContentReader,
} from "./baseline-refresh.mjs";
import {
  buildAttribution,
  now,
  readStartedExecutionContextPreflight,
  uniqueRecordSuffix,
} from "./common.mjs";
import {
  currentDeliveryExecutionState,
  readDeliveryAutonomyProfile,
} from "./delivery.mjs";
import {
  ensureInitialized,
} from "./migration.mjs";
import {
  output,
} from "./output.mjs";
import {
  acquireFileLock,
  readProjectJson,
  safeReadDir,
  writeJsonFile,
} from "./storage.mjs";
import {
  appendTraceEvent,
  readContractById,
  readStory,
} from "./story.mjs";

export const STORY_OVERLAP_REVIEW_SCHEMA = "story-overlap-review:v1";
const REVIEW_DIRECTORY = "overlap-reviews";
const ACKNOWLEDGED_BASE_COMMIT = "an accepted base commit";
// Merges are dated when they land; a week of slack absorbs clock skew between
// the computers that made them before an ancestor is missed.
const ANCESTRY_SLACK_MS = 7 * 24 * 60 * 60 * 1000;

function policyOf(context) {
  try {
    return orchestrationPolicy(context.config).delivered_overlap;
  } catch (error) {
    fail(error.message);
  }
}

/** The started, not yet delivered, work of a story: its receipt and baselines. */
function startedStoryWork(context, storyId) {
  const story = readStory(context, storyId);
  if (!story?.contract_id) return null;
  const contract = readContractById(context, story.contract_id, { missingOk: true });
  const executionContext = contractExecutionContext(contract);
  if (!executionContext) return null;
  let profile;
  try {
    profile = readDeliveryAutonomyProfile(context, executionContext.profileId, { missingOk: true });
  } catch {
    return null;
  }
  if (!profile) return null;
  // Delivered or abandoned work has nothing left to merge.
  if (currentDeliveryExecutionState(context, profile).lifecycle_status === "terminal") return null;
  const { receipt } = readStartedExecutionContextPreflight(context, executionContext);
  if (!receipt) return null;
  const baselineIds = [...new Set(receipt.source_snapshots.flatMap((snapshot) => snapshot.bindings
    .filter((binding) => binding.kind === "baseline")
    .map((binding) => binding.id)))].sort();
  return {
    story_id: storyId,
    profile_id: profile.id,
    receipt,
    write_scopes: receipt.requirement_scopes.map((scope) => scope.allowed_write_paths),
    baseline_ids: baselineIds,
  };
}

/**
 * Commits reachable from the commit a story started from, limited to the
 * period in which the deliveries in question could have merged.
 */
function ancestorsSince(context, headSha, sinceMs) {
  try {
    const stdout = childProcess.execFileSync(
      "git",
      ["-C", context.root, "rev-list", `--since=${Math.floor(sinceMs / 1000)}`, headSha],
      { stdio: ["ignore", "pipe", "ignore"], maxBuffer: 512 * 1024 * 1024 },
    );
    return new Set(stdout.toString("utf8").split(/\r?\n/u).filter(Boolean));
  } catch {
    return null;
  }
}

/**
 * Changes other stories merged that this story did not start from. Returns
 * null when the story has no started, undelivered work to check.
 */
export function storyDeliveredOverlaps(context, storyId) {
  const work = startedStoryWork(context, storyId);
  if (!work) return null;
  const acknowledged = readStoryBaseAcknowledgements(context, storyId);
  if (work.baseline_ids.length === 0 && acknowledged.length === 0) return null;
  const contextHashes = {};
  const evidences = new Map();
  for (const baselineId of work.baseline_ids) {
    const baselinePath = baselinePathById(context, baselineId);
    if (!fs.existsSync(baselinePath)) continue;
    Object.assign(contextHashes, readProjectJson(context, baselinePath).source_hashes || {});
    for (const evidence of collectDeliveredWorkEvidence(context, baselineId)) {
      if (evidence.story_id === storyId) continue;
      evidences.set(`${evidence.story_id}\u0000${evidence.merge_commit_sha}`, evidence);
    }
  }
  const candidates = [...evidences.values()];
  const startSha = work.receipt.git_head_sha;
  let ancestors = new Set();
  if (startSha && candidates.length > 0) {
    const oldest = Math.min(...candidates.map((evidence) => Date.parse(evidence.closed_at) || 0));
    ancestors = ancestorsSince(context, startSha, Math.max(0, oldest - ANCESTRY_SLACK_MS));
  }
  const deliveries = candidates.map((evidence) => ({
    story_id: evidence.story_id,
    delivery_profile_id: evidence.delivery_profile_id,
    merge_commit_sha: evidence.merge_commit_sha,
    // Work already in the commit the story started from was part of what it read.
    seen: ancestors === null ? undefined : ancestors.has(evidence.merge_commit_sha),
    get changed_paths() {
      return evidence.changedPaths?.();
    },
    contentSha256: evidence.contentSha256,
  }));
  // Base commits a person accepted for this story came from outside any
  // delivery; files they changed inside its scope still need a review.
  for (const record of acknowledged) {
    deliveries.push({
      story_id: ACKNOWLEDGED_BASE_COMMIT,
      delivery_profile_id: record.id,
      merge_commit_sha: record.commit_sha,
      seen: false,
      changed_paths: record.paths,
      contentSha256: gitContentReader(context, record.commit_sha).read,
    });
  }
  const { overlaps, unverifiable } = findDeliveredOverlaps({
    story_id: storyId,
    write_scopes: work.write_scopes,
    context_hashes: contextHashes,
  }, deliveries);
  const reviews = readStoryOverlapReviews(context, storyId);
  return {
    story_id: storyId,
    overlaps,
    unconfirmed: unconfirmedDeliveredOverlaps(overlaps, reviews),
    unverifiable,
    reviews: reviews.map((review) => ({ id: review.id, created_at: review.created_at, overlaps: review.overlaps.length })),
  };
}

function reviewRoot(context, storyId) {
  return path.join(context.sdlcRoot, "stories", storyId, REVIEW_DIRECTORY);
}

/** Overlap reviews of a story whose content still matches their recorded hash. */
export function readStoryOverlapReviews(context, storyId) {
  const root = reviewRoot(context, storyId);
  const reviews = [];
  for (const name of safeReadDir(root).filter((entry) => entry.endsWith(".json")).sort()) {
    try {
      const review = readProjectJson(context, path.join(root, name));
      const { review_hash: recorded, ...subject } = review;
      if (
        review.schema === STORY_OVERLAP_REVIEW_SCHEMA
        && review.story_id === storyId
        && Array.isArray(review.overlaps)
        && recorded === computeStableHash(subject)
      ) {
        reviews.push(review);
      }
    } catch {
      // An unreadable review confirms nothing.
    }
  }
  return reviews;
}

function shortSha(sha) {
  return String(sha || "").slice(0, 12);
}

function describeOverlap(storyId, overlap) {
  const change = overlap.sha256 === null ? "removed" : "changed";
  const where = overlap.kind === "write_scope" ? "inside its write scope" : "that it read as context";
  return `${overlap.story_id} ${change} ${overlap.path} (${where}, merge ${shortSha(overlap.merge_commit_sha)}) after story ${storyId} started`;
}

function confirmCommand(storyId) {
  return `agentic-sdlc story overlap confirm --id ${storyId} --summary "<what you checked and changed>"`;
}

/**
 * Adds every unreviewed overlap of a started story to a gate report: as an
 * error when the policy asks for confirmation on a strict gate, otherwise as
 * a warning.
 */
export function validateStoryDeliveredOverlaps(context, report, storyId) {
  const policy = policyOf(context);
  if (policy.write_scope === "off" && policy.context === "off") return;
  let result;
  try {
    result = storyDeliveredOverlaps(context, storyId);
  } catch (error) {
    report.warnings.push(`story ${storyId} overlap with delivered work could not be checked: ${error.message}`);
    return;
  }
  if (!result) return;
  for (const overlap of result.unconfirmed) {
    const mode = policy[overlap.kind];
    if (mode === "off") continue;
    const message = `${describeOverlap(storyId, overlap)}; review the merged change, then record it with '${confirmCommand(storyId)}'`;
    report[mode === "confirm" && report.strict ? "errors" : "warnings"].push(message);
  }
  for (const delivery of result.unverifiable) {
    report.warnings.push(
      `story ${storyId} cannot tell whether ${delivery.story_id} (merge ${shortSha(delivery.merge_commit_sha)}) overlaps its work: `
      + "the merge commit or the commit the story started from is not in this clone",
    );
  }
}

/** Refuses a merge while the story has unreviewed overlaps the policy asks to confirm. */
export function enforceDeliveredOverlapReview(context, storyId) {
  const policy = policyOf(context);
  const result = storyDeliveredOverlaps(context, storyId);
  if (!result) return;
  const blocking = result.unconfirmed.filter((overlap) => policy[overlap.kind] === "confirm");
  if (blocking.length === 0) return;
  fail(
    [
      `Story ${storyId} cannot merge yet: work merged by other stories after it started changed files it depends on.`,
      ...blocking.map((overlap) => `- ${describeOverlap(storyId, overlap)}`),
      "Bring the merged changes into this branch, check that this story's work still holds with them, then record the review:",
      confirmCommand(storyId),
    ].join("\n"),
    {
      en: {
        result: `The merge of story ${storyId} was not authorized.`,
        impact: "Other work changed the same files after this story started, so its plan and checks may rest on an outdated version.",
        required_decision: "Review the other story's merged change against this story and adjust this work where needed.",
        protection_boundary: "Nothing was merged and no record was changed.",
        next_action: "Record the review with story overlap confirm, then retry the merge.",
        details: { story_id: storyId, overlaps: blocking },
      },
      it: {
        result: `Il merge della story ${storyId} non è stato autorizzato.`,
        impact: "Altro lavoro ha modificato gli stessi file dopo l’avvio di questa story, quindi piano e verifiche potrebbero basarsi su una versione superata.",
        required_decision: "Rivedi la modifica già integrata dall’altra story rispetto a questa e adegua il lavoro dove serve.",
        protection_boundary: "Nessun merge è stato eseguito e nessun record è stato modificato.",
        next_action: "Registra la revisione con story overlap confirm, poi riprova il merge.",
        details: { story_id: storyId, overlaps: blocking },
      },
    },
  );
}

export function showStoryOverlap(context, options) {
  ensureInitialized(context);
  const id = normalizeId(requireOption(options, "id"));
  if (!readStory(context, id)) fail(`Story ${id} does not exist.`);
  const result = storyDeliveredOverlaps(context, id);
  const payload = result
    ? { status: result.unconfirmed.length > 0 ? "review_needed" : "clear", ...result }
    : { status: "not_applicable", story_id: id, overlaps: [], unconfirmed: [], unverifiable: [], reviews: [] };
  output(options, payload, [
    payload.status === "not_applicable"
      ? `Story ${id} has no started work waiting to merge.`
      : `Story ${id}: ${payload.unconfirmed.length} unreviewed and ${payload.overlaps.length - payload.unconfirmed.length} reviewed change(s) from other stories.`,
    ...payload.unconfirmed.map((overlap) => `- ${describeOverlap(id, overlap)}`),
    ...payload.unverifiable.map((delivery) => `- ${delivery.story_id} (merge ${shortSha(delivery.merge_commit_sha)}) could not be compared in this clone`),
    ...(payload.unconfirmed.length > 0 ? [`Next: ${confirmCommand(id)}`] : []),
  ]);
}

/**
 * Records that the story was checked against every change other stories
 * merged since it started. The review names each change by path, delivery,
 * and exact bytes, so a later change needs a new review.
 */
export function confirmStoryOverlap(context, options) {
  ensureInitialized(context);
  const id = normalizeId(requireOption(options, "id"));
  const summary = getOptionString(options, "summary");
  if (!summary) fail("story overlap confirm requires --summary describing what was checked.");
  if (!readStory(context, id)) fail(`Story ${id} does not exist.`);
  const policy = policyOf(context);
  const attribution = buildAttribution(context, options, "story.overlap.confirm");
  if (policy.confirmation_actor === "human" && (attribution.actor?.type !== "human" || runsInsideAgentHost())) {
    fail(
      `orchestration_policy.delivered_overlap.confirmation_actor requires a person to confirm the overlap review of story ${id}. `
      + `Ask them to run, in their own terminal: ${confirmCommand(id)} --actor-type human`,
    );
  }
  const root = reviewRoot(context, id);
  const releaseLock = acquireFileLock(path.join(context.sdlcRoot, "stories", id, "overlap-review.lock"));
  try {
    const result = storyDeliveredOverlaps(context, id);
    if (!result) fail(`Story ${id} has no started work waiting to merge; there is nothing to review.`);
    if (result.unconfirmed.length === 0) {
      output(options, { status: "clear", story_id: id, recorded: false, overlaps: result.overlaps.length }, [
        `Story ${id} has no unreviewed change from other stories.`,
      ]);
      return;
    }
    const createdAt = now();
    const review = {
      schema: STORY_OVERLAP_REVIEW_SCHEMA,
      id: `OVR-${uniqueRecordSuffix()}`,
      story_id: id,
      summary,
      overlaps: result.unconfirmed
        .map(({ path: sourcePath, kind, story_id: storyId, delivery_profile_id: profileId, merge_commit_sha: sha, sha256 }) => ({
          path: sourcePath,
          kind,
          story_id: storyId,
          delivery_profile_id: profileId,
          merge_commit_sha: sha,
          sha256,
        }))
        .sort((a, b) => deliveredOverlapKey(a).localeCompare(deliveredOverlapKey(b))),
      confirmed_by: attribution.actor,
      git: attribution.git,
      created_at: createdAt,
    };
    review.review_hash = computeStableHash(review);
    fs.mkdirSync(root, { recursive: true });
    const reviewPath = path.join(root, `${review.id}.json`);
    writeJsonFile(reviewPath, review);
    const relativePath = path.relative(context.root, reviewPath).split(path.sep).join("/");
    appendTraceEvent(context, id, {
      type: "decision",
      action: "story.overlap.confirm",
      summary: `Reviewed ${review.overlaps.length} change(s) other stories merged after ${id} started: ${summary}`,
      actor: attribution.actor,
      evidence: [relativePath],
      related: [id, ...new Set(review.overlaps.map((overlap) => overlap.story_id))],
      git: attribution.git,
      run: attribution.run,
    });
    output(options, { status: "recorded", story_id: id, review_path: reviewPath, review }, [
      `Recorded the overlap review of story ${id}: ${review.overlaps.length} change(s) from ${[...new Set(review.overlaps.map((overlap) => overlap.story_id))].join(", ")}.`,
    ]);
  } finally {
    releaseLock();
  }
}

/**
 * Other stories in progress whose write scope shares files with this one.
 * Used as a warning when a story is claimed; it never blocks.
 */
export function storyClaimOverlapWarnings(context, storyId) {
  if (policyOf(context).claim === "off") return [];
  const mine = startedStoryWork(context, storyId);
  if (!mine) return [];
  const warnings = [];
  for (const otherId of safeReadDir(path.join(context.sdlcRoot, "stories")).sort()) {
    if (otherId === storyId) continue;
    let other;
    try {
      other = startedStoryWork(context, otherId);
    } catch {
      continue;
    }
    if (!other) continue;
    const shared = sharedWriteRegion(mine.write_scopes, other.write_scopes);
    if (shared.length > 0) warnings.push({ story_id: otherId, shared_paths: shared });
  }
  return warnings;
}
