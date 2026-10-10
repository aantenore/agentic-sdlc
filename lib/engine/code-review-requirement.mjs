import path from "node:path";
import { deliveryProfileHashMatches } from "../delivery-profile-revisions.mjs";
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
  CODE_REVIEW_DECISIONS,
} from "../autonomy-policy.mjs";
import {
  reviewerAuthorConflicts,
} from "../code-review.mjs";
import {
  requireFormalApprovalActor,
} from "../lifecycle/authorization.mjs";
import {
  getOptionString,
  normalizeId,
  requireOption,
} from "../lifecycle/common.mjs";
import {
  humanGuidanceLocale,
} from "../lifecycle/guidance.mjs";
import {
  codeReviewsRoot,
  toProjectPath,
} from "../lifecycle/project.mjs";
import {
  assertRecordSchema,
  buildAttribution,
  now,
  readCodeReviewRecords,
  uniqueRecordSuffix,
  validateRecordSchema,
} from "./common.mjs";
import {
  execGitOutput,
} from "./git.mjs";
import {
  deliveryAutonomyRoot,
} from "../lifecycle/delivery.mjs";
import {
  currentDeliveryExecutionState,
  effectiveDeliveryProfileStatus,
  readDeliveryAutonomyProfile,
  readPullRequestDeliveryForReview,
} from "./delivery.mjs";
import {
  ensureInitialized,
} from "./migration.mjs";
import {
  output,
} from "./output.mjs";
import {
  readProjectJson,
  safeReadDir,
  writeJsonFile,
} from "./storage.mjs";
import {
  appendTraceEvent,
} from "./story.mjs";

/**
 * Whether a pull-request delivery needs a code review before the plugin
 * merges it. The person chooses it per story when the delivery is proposed,
 * and the choice lives in the approved, hash-bound delivery profile. After
 * approval it can only be changed through a record bound to that exact
 * profile: anyone may add the requirement, only a person may drop it, and
 * nothing drops a project policy that requires a review for every pull
 * request. The requirement is checked only at pull_request.merge.
 */

const CHANGE_KIND = "code_review_requirement_change";
const CHANGE_SCHEMA = "code-review-requirement-change.schema.json";

export const CODE_REVIEW_REQUIREMENT_SOURCES = Object.freeze([
  "project_policy",
  "delivery_profile",
  "standing_approval",
  "delegation",
  "change",
  "project_default",
]);

function requirementChangesRoot(context) {
  return path.join(codeReviewsRoot(context), "requirement-changes");
}

/**
 * Valid changes for this exact profile, oldest first. A change whose content
 * no longer matches its hash, or a drop not made by a person, is ignored.
 */
export function readCodeReviewRequirementChanges(context, profile) {
  const root = requirementChangesRoot(context);
  const changes = [];
  for (const name of safeReadDir(root)) {
    if (!name.endsWith(".json")) continue;
    const filePath = path.join(root, name);
    let record;
    try {
      record = readProjectJson(context, filePath);
    } catch {
      continue;
    }
    if (record?.kind !== CHANGE_KIND
      || record.delivery_profile_id !== profile.id
      || !deliveryProfileHashMatches(profile, record.delivery_profile_hash)) continue;
    if (!validateRecordSchema(record, CHANGE_SCHEMA).valid) continue;
    const { record_hash: recordHash, ...unhashed } = record;
    if (computeStableHash(unhashed) !== recordHash) continue;
    changes.push({ path: toProjectPath(context, filePath), record });
  }
  return changes.sort((left, right) =>
    String(left.record.created_at).localeCompare(String(right.record.created_at), "en")
    || String(left.record.id).localeCompare(String(right.record.id), "en"));
}

/**
 * The review requirement in force for one delivery profile.
 *
 * - `gate_policy.merge_requires_code_review: true` requires a review for
 *   every pull request (`project_policy`); no story choice lowers it.
 * - Otherwise the latest valid change after approval decides (`change`),
 *   then the choice recorded in the profile (`delivery_profile`, or
 *   `standing_approval` when a standing approval's bound supplied it).
 * - A profile proposed before the per-story choice existed follows the
 *   project default (`project_default`) without blocking or asking.
 */
export function codeReviewRequirement(context, profile) {
  const pullRequest = profile?.delivery_kind === "pull_request";
  const projectRequires = context.config.gate_policy?.merge_requires_code_review === true;
  const choice = pullRequest ? profile.pull_request_target?.code_review || null : null;
  const changes = pullRequest ? readCodeReviewRequirementChanges(context, profile) : [];
  const latest = changes.at(-1) || null;
  let chosen = null;
  let source = "project_default";
  if (latest) {
    chosen = latest.record.decision;
    source = "change";
  } else if (choice) {
    chosen = choice.decision;
    source = choice.source === "standing-approval"
      ? "standing_approval"
      : choice.source === "delegation" ? "delegation" : "delivery_profile";
  }
  const required = pullRequest && (projectRequires || chosen === "required");
  if (projectRequires && chosen !== "required") source = "project_policy";
  return {
    applies: pullRequest,
    required,
    decision: required ? "required" : "not-required",
    source,
    project_requires: projectRequires,
    choice,
    change: latest?.record || null,
    change_path: latest?.path || null,
    change_paths: changes.map((change) => change.path),
  };
}

const SOURCE_TEXT = {
  project_policy: {
    en: "project policy (gate_policy.merge_requires_code_review)",
    it: "regola del progetto (gate_policy.merge_requires_code_review)",
  },
  delivery_profile: {
    en: "chosen by the user for this story",
    it: "scelta dall’utente per questa storia",
  },
  standing_approval: {
    en: "set by the approved standing approval",
    it: "stabilita dall’approvazione permanente approvata",
  },
  delegation: {
    en: "the person's standing answer in their delivery.policy delegation",
    it: "risposta permanente della persona nella sua delega delivery.policy",
  },
  change: {
    en: "changed after the delivery was approved",
    it: "modificata dopo l’approvazione della consegna",
  },
  project_default: {
    en: "project default (no choice recorded for this delivery)",
    it: "default del progetto (nessuna scelta registrata per questa consegna)",
  },
};

/** One plain sentence on the requirement, in the reader's language. */
export function codeReviewRequirementSentence(requirement, { italian = false } = {}) {
  if (!requirement?.applies) return null;
  const locale = italian ? "it" : "en";
  const source = SOURCE_TEXT[requirement.source][locale];
  if (italian) {
    return requirement.required
      ? `Revisione del codice prima del merge: richiesta (${source}). Fino al merge tutto procede in automatico.`
      : `Revisione del codice prima del merge: non richiesta (${source}).`;
  }
  return requirement.required
    ? `Code review before merge: required (${source}). Everything before the merge proceeds automatically.`
    : `Code review before merge: not required (${source}).`;
}

/**
 * The requirement plus the reviews recorded on this computer, for explain and
 * status. A review counts as valid when it approves the current head of the
 * delivery's head branch and its reviewer authored none of the reviewed
 * commits; the merge gate re-checks all of it, including shared reviews.
 */
export function codeReviewStatus(context, profile) {
  const requirement = codeReviewRequirement(context, profile);
  if (!requirement.applies) return { requirement, head_sha: null, reviews: [], valid_reviews: 0 };
  const headBranch = profile.pull_request_target?.head_branch;
  const head = headBranch
    ? String(execGitOutput(context.root, ["rev-parse", "--verify", "--quiet", `refs/heads/${headBranch}^{commit}`]) || "").trim().toLowerCase() || null
    : null;
  const reviews = readCodeReviewRecords(context, profile.id).map((record) => ({
    id: record.id,
    verdict: record.verdict,
    reviewer: record.reviewer?.git_email || record.reviewer?.actor_id || null,
    reviewed_head_sha: record.reviewed_head_sha,
    covers_current_head: Boolean(head) && record.reviewed_head_sha === head,
    independent: reviewerAuthorConflicts(record.reviewer, record.commit_authors).length === 0,
  }));
  return {
    requirement,
    head_sha: head,
    reviews,
    valid_reviews: reviews.filter((review) => review.verdict === "approved" && review.independent && review.covers_current_head).length,
  };
}

/**
 * Review requirement of every approved pull-request delivery that is not
 * finished yet, for project status. Unreadable profiles are skipped: status
 * reports them elsewhere.
 */
export function openPullRequestReviewOverview(context) {
  const items = [];
  for (const name of safeReadDir(deliveryAutonomyRoot(context))) {
    if (!name.endsWith(".json")) continue;
    try {
      const profile = readDeliveryAutonomyProfile(context, path.basename(name, ".json"));
      if (profile.delivery_kind !== "pull_request" || profile.status !== "active") continue;
      if (effectiveDeliveryProfileStatus(context, profile).status === "revoked") continue;
      if (currentDeliveryExecutionState(context, profile).lifecycle_status === "terminal") continue;
      const status = codeReviewStatus(context, profile);
      items.push({
        profile_id: profile.id,
        delivery_id: profile.delivery_id,
        story_id: profile.story_refs?.[0]?.id || null,
        required: status.requirement.required,
        source: status.requirement.source,
        valid_reviews: status.valid_reviews,
        head_sha: status.head_sha,
      });
    } catch {
      continue;
    }
  }
  return items.sort((left, right) => left.profile_id.localeCompare(right.profile_id, "en"));
}

/** One status line per open pull-request delivery. */
export function openPullRequestReviewLines(items, { italian = false } = {}) {
  return items.map((item) => {
    const source = SOURCE_TEXT[item.source][italian ? "it" : "en"];
    if (italian) {
      return item.required
        ? `Revisione prima del merge per ${item.delivery_id} (storia ${item.story_id}): richiesta, ${source}; revisioni valide del commit attuale: ${item.valid_reviews}`
        : `Revisione prima del merge per ${item.delivery_id} (storia ${item.story_id}): non richiesta, ${source}`;
    }
    return item.required
      ? `Review before merge for ${item.delivery_id} (story ${item.story_id}): required, ${source}; valid reviews of the current head: ${item.valid_reviews}`
      : `Review before merge for ${item.delivery_id} (story ${item.story_id}): not required, ${source}`;
  });
}

/** Human-readable lines for explain and status. */
export function codeReviewStatusLines(status, { italian = false } = {}) {
  if (!status?.requirement?.applies) return [];
  const lines = [codeReviewRequirementSentence(status.requirement, { italian })];
  if (status.requirement.required) {
    const head = status.head_sha ? status.head_sha.slice(0, 12) : (italian ? "non disponibile" : "unavailable");
    lines.push(italian
      ? `Revisioni valide del commit attuale (${head}): ${status.valid_reviews} su ${status.reviews.length} registrate su questo computer.`
      : `Valid reviews of the current head (${head}): ${status.valid_reviews} of ${status.reviews.length} recorded on this computer.`);
  }
  return lines;
}

/**
 * The person's answer to the per-story question, read from the propose
 * options. A pull request needs it; a local release never has one. The
 * answer must be recorded as a person's explicit decision, with their words.
 */
export function codeReviewChoiceFromOptions(context, options, kind, { standing = null, delegated = null } = {}) {
  const raw = getOptionString(options, "code-review");
  if (kind !== "pull_request") {
    if (raw) fail("--code-review applies only to pull-request deliveries; a local release is never reviewed before merge.");
    return null;
  }
  const delegatedDecision = delegated?.policy?.code_review;
  if (delegatedDecision) {
    if (raw) {
      fail(`Delegation ${delegated.id} already gives the person's answer on code review (${delegatedDecision}); drop --code-review or the delegation.`);
    }
    return {
      decision: delegatedDecision,
      source: "delegation",
      actor_id: delegated.actor_id,
      user_words: delegated.statement,
      standing_approval_id: null,
      decided_at: now(),
      delegation_id: delegated.id,
    };
  }
  if (!raw) {
    const bound = standing?.proposal?.destination?.code_review;
    if (standing && CODE_REVIEW_DECISIONS.includes(bound)) {
      return {
        decision: bound,
        source: "standing-approval",
        actor_id: null,
        user_words: null,
        standing_approval_id: standing.id,
        decided_at: now(),
      };
    }
    fail(
      "A new pull-request delivery needs the user's answer on code review before merge: "
      + "--code-review required|not-required, with --code-review-actor-type human, "
      + "--code-review-approval-source explicit-user, and --code-review-summary quoting the user's answer. "
      + "Ask the user; never infer it from earlier stories. "
      + "If the person signed a delegation covering delivery.policy, pass --approval-source delegated --delegation <DLG-id> instead.",
    );
  }
  if (!CODE_REVIEW_DECISIONS.includes(raw)) {
    fail(`--code-review must be one of: ${CODE_REVIEW_DECISIONS.join(", ")}.`);
  }
  const actorType = getOptionString(options, "code-review-actor-type");
  const approvalSource = getOptionString(options, "code-review-approval-source");
  if (actorType !== "human" || approvalSource !== "explicit-user") {
    fail(
      "The code review choice is the user's decision: record it with --code-review-actor-type human "
      + "and --code-review-approval-source explicit-user. An agent or system cannot make it.",
    );
  }
  const userWords = getOptionString(options, "code-review-summary");
  if (!userWords) {
    fail("--code-review-summary must quote the user's answer to the code review question.");
  }
  return {
    decision: raw,
    source: "explicit-user",
    actor_id: getOptionString(options, "code-review-actor") || "user",
    user_words: userWords,
    standing_approval_id: null,
    decided_at: now(),
  };
}

function writeRequirementChange(context, options, profile, storyId, { decision, previous, approvalSource, summary, attribution }) {
  const createdAt = now();
  const id = normalizeId(`${storyId}-review-requirement-${uniqueRecordSuffix()}`);
  const record = {
    kind: CHANGE_KIND,
    schema_version: "code-review-requirement-change:v1",
    id,
    story_id: storyId,
    delivery_id: profile.delivery_id,
    delivery_profile_id: profile.id,
    delivery_profile_hash: profile.profile_hash,
    decision,
    previous_decision: previous,
    approval_source: approvalSource,
    summary,
    actor: attribution.actor,
    git: attribution.git,
    run: attribution.run,
    created_at: createdAt,
    hash_algorithm: "sha256:stable-json:v1",
  };
  record.record_hash = computeStableHash(record);
  assertRecordSchema(record, CHANGE_SCHEMA, `Code review requirement change ${id}`);
  const recordPath = path.join(requirementChangesRoot(context), `${id}.json`);
  writeJsonFile(recordPath, record, { force: false });
  const projectPath = toProjectPath(context, recordPath);
  const event = appendTraceEvent(context, storyId, {
    type: "decision",
    summary,
    action: decision === "required" ? "review.require" : "review.waive",
    actor: attribution.actor,
    evidence: [projectPath],
    related: [profile.id, profile.delivery_id],
    git: attribution.git,
    run: attribution.run,
  });
  return { record, path: projectPath, event };
}

/** `review require`: adds the review requirement to an approved delivery. Anyone may tighten it. */
export function requireCodeReview(context, options) {
  ensureInitialized(context);
  const profileId = normalizeId(requireOption(options, "delivery"));
  const { profile, storyId } = readPullRequestDeliveryForReview(context, profileId);
  const italian = humanGuidanceLocale(options) === "it";
  const current = codeReviewRequirement(context, profile);
  if (current.required) {
    output(options, { status: "unchanged", code_review_requirement: current }, [
      codeReviewRequirementSentence(current, { italian }),
    ]);
    return;
  }
  const attribution = buildAttribution(context, options, "review.require");
  const written = writeRequirementChange(context, options, profile, storyId, {
    decision: "required",
    previous: current.decision,
    approvalSource: getOptionString(options, "approval-source") || null,
    summary: getOptionString(options, "summary")
      || `Code review before merge is now required for ${profile.delivery_id}`,
    attribution,
  });
  const updated = codeReviewRequirement(context, profile);
  output(options, {
    status: "required",
    code_review_requirement: updated,
    change: written.record,
    change_path: written.path,
    event: written.event,
  }, [
    codeReviewRequirementSentence(updated, { italian }),
    italian
      ? `Vale anche per la consegna in corso: il merge di ${profile.delivery_id} richiede una revisione approvata del commit da unire.`
      : `It applies to the delivery in progress too: merging ${profile.delivery_id} needs an approved review of the commit being merged.`,
    `Path: ${written.path}`,
  ]);
}

/**
 * `review waive`: drops the requirement for one approved delivery. Only a
 * person may do it, outside an agent session, and never below a project
 * policy that requires a review for every pull request.
 */
export function waiveCodeReview(context, options) {
  ensureInitialized(context);
  const profileId = normalizeId(requireOption(options, "delivery"));
  const { profile, storyId } = readPullRequestDeliveryForReview(context, profileId);
  const italian = humanGuidanceLocale(options) === "it";
  const current = codeReviewRequirement(context, profile);
  if (current.project_requires) {
    fail(
      `The project requires a code review before every pull request merge (gate_policy.merge_requires_code_review), so it cannot be dropped for ${profile.delivery_id}.`,
      {
        en: {
          result: "The code review requirement was not changed.",
          impact: "The project policy requires a review for every pull request.",
          required_decision: "Only a reviewed configuration change can lower the project policy.",
          protection_boundary: "Nothing was recorded.",
          next_action: "Change gate_policy.merge_requires_code_review through 'config migrate' if the whole project should stop requiring reviews.",
        },
        it: {
          result: "Il requisito di revisione del codice non è stato modificato.",
          impact: "La regola del progetto richiede una revisione per ogni pull request.",
          required_decision: "Solo una modifica revisionata della configurazione può abbassare la regola del progetto.",
          protection_boundary: "Nulla è stato registrato.",
          next_action: "Modifica gate_policy.merge_requires_code_review tramite 'config migrate' se l’intero progetto non deve più richiedere revisioni.",
        },
      },
    );
  }
  if (!current.required) {
    output(options, { status: "unchanged", code_review_requirement: current }, [
      codeReviewRequirementSentence(current, { italian }),
    ]);
    return;
  }
  if (runsInsideAgentHost()) {
    fail(
      "Dropping a required code review is the user's own decision and cannot run inside an agent session. "
      + `The user runs 'review waive --delivery ${profile.id} --actor-type human --approval-source explicit-user --summary "<their words>"' in their own terminal.`,
      {
        en: {
          result: "The code review requirement was not changed.",
          impact: "An agent cannot remove a review the user asked for.",
          required_decision: "The user decides, in their own terminal, to drop the review for this story.",
          protection_boundary: "Nothing was recorded; the merge still needs an approved review.",
          next_action: `The user runs 'review waive --delivery ${profile.id}' outside the agent session.`,
        },
        it: {
          result: "Il requisito di revisione del codice non è stato modificato.",
          impact: "Un agente non può rimuovere una revisione richiesta dall’utente.",
          required_decision: "L’utente decide, dal proprio terminale, di rinunciare alla revisione per questa storia.",
          protection_boundary: "Nulla è stato registrato; il merge richiede ancora una revisione approvata.",
          next_action: `L’utente esegue 'review waive --delivery ${profile.id}' fuori dalla sessione dell’agente.`,
        },
      },
    );
  }
  const attribution = buildAttribution(context, options, "review.waive");
  requireFormalApprovalActor(context, options, attribution, "Dropping a required code review");
  const approvalSource = getOptionString(options, "approval-source");
  if (attribution.actor.type !== "human" || approvalSource !== "explicit-user") {
    fail("Dropping a required code review needs --actor-type human and --approval-source explicit-user.");
  }
  const summary = getOptionString(options, "summary");
  if (!summary) fail("--summary must quote the user's decision to drop the code review.");
  const written = writeRequirementChange(context, options, profile, storyId, {
    decision: "not-required",
    previous: current.decision,
    approvalSource,
    summary,
    attribution,
  });
  const updated = codeReviewRequirement(context, profile);
  output(options, {
    status: "not_required",
    code_review_requirement: updated,
    change: written.record,
    change_path: written.path,
    event: written.event,
  }, [
    codeReviewRequirementSentence(updated, { italian }),
    `Path: ${written.path}`,
  ]);
}
