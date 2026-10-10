import fs from "node:fs";
import path from "node:path";
import { fail } from "../cli/user-error.mjs";
import {
  computeDerivedVerification,
  renderDerivedCriteriaLines,
  resolveVerificationPolicy,
  uncoveredDerivedCriteria,
} from "../verification-policy.mjs";
import { assistantMessagePresentationFields } from "../lifecycle/guidance.mjs";
import { getOptionString, normalizeId } from "../lifecycle/common.mjs";
import { storyAcceptanceCriteria, storyMutationLockPath } from "../lifecycle/story.mjs";
import { toProjectPath } from "../lifecycle/project.mjs";
import { buildAttribution, assertRecordSchema, readAllStories, readTestRunRecords } from "./common.mjs";
import { readTemplateFile, output } from "./output.mjs";
import { acquireFileLock, writeJsonFile } from "./storage.mjs";
import { pathEntryExistsNoFollow } from "./project.mjs";
import { storyBoundDeliveryProfiles } from "./delivery.mjs";
import {
  appendTraceEvent,
  readRequirement,
  readRequirementAutonomyProfile,
  readStoryClaim,
} from "./story.mjs";
import { ensureInitialized } from "./migration.mjs";

const NOT_OPEN_STORY_STATUSES = new Set(["done", "cancelled", "superseded", "closed"]);

/** The bundled default policy merged with the project's `verification_policy` override. */
export function loadVerificationPolicy(context) {
  let defaults;
  try {
    defaults = JSON.parse(readTemplateFile(context, "verification-policy.json"));
  } catch (error) {
    fail(`The bundled verification policy is not usable: ${error.message}`);
  }
  try {
    return resolveVerificationPolicy(defaults, context.config?.verification_policy ?? null);
  } catch (error) {
    fail(`verification_policy is not usable: ${error.message}`);
  }
}

export function derivedVerificationOptedOut(options) {
  return options?.["no-derived-verification"] === true || options?.["no-derived-verification"] === "true";
}

/** Derived criteria for a requirement proposal or revision. */
export function deriveRequirementVerification(context, { acceptance, writePaths, integrations, optedOut }) {
  return computeDerivedVerification(loadVerificationPolicy(context), {
    explicit: acceptance,
    writePaths,
    hasIntegrations: (integrations || []).length > 0,
    disabledReason: optedOut ? "--no-derived-verification" : null,
  });
}

function storyRequirementScope(context, story) {
  const ids = [...new Set([
    ...(story.links?.requirements || []),
    ...(story.requirement_refs || []).map((ref) => ref.id),
  ])];
  const explicit = [...storyAcceptanceCriteria(story)];
  const writePaths = new Set();
  let hasIntegrations = false;
  for (const id of ids) {
    const requirement = readRequirement(context, id, { missingOk: true });
    if (!requirement) continue;
    explicit.push(...(requirement.acceptance_criteria || []));
    hasIntegrations ||= (requirement.integrations || []).length > 0;
    const profile = requirement.autonomy_profile_id
      ? readRequirementAutonomyProfile(context, requirement.autonomy_profile_id, { missingOk: true })
      : null;
    for (const writePath of profile?.constraints?.allowed_write_paths || []) writePaths.add(writePath);
  }
  return { explicit, writePaths: [...writePaths], hasIntegrations };
}

/** Derived criteria for a story, from its own and its requirements' criteria and write scope. */
export function deriveStoryVerification(context, story, { optedOut = false, mode = "new" } = {}) {
  const scope = storyRequirementScope(context, story);
  return computeDerivedVerification(loadVerificationPolicy(context), {
    explicit: scope.explicit,
    writePaths: scope.writePaths,
    hasIntegrations: scope.hasIntegrations,
    disabledReason: optedOut ? "--no-derived-verification" : null,
    mode,
  });
}

export function withDerivedFields(record, derivation) {
  return {
    ...record,
    derived_acceptance: derivation.derived_acceptance,
    derived_verification: derivation.derived_verification,
  };
}

/** Text shown to the person and the agent next to the explicit criteria. */
export function derivedVerificationMessage(subjectLabel, derivation) {
  const verification = derivation.derived_verification;
  if (verification.disabled) {
    return `Derived verification is off for ${subjectLabel} (${verification.reason}); only the explicit criteria apply.`;
  }
  const lines = renderDerivedCriteriaLines(derivation.derived_acceptance, verification.covered_by_explicit);
  if (lines.length === 0) return `No derived verification criteria are needed for ${subjectLabel}.`;
  const evidence = derivation.derived_acceptance.length > 0
    ? ` Produce them too and record each with 'test record --acceptance <id>' (enforcement: ${verification.enforce}).`
    : "";
  return [
    `Derived verification for ${subjectLabel} (secondary to the explicit acceptance criteria):`,
    ...lines.map((line) => `- ${line}`),
  ].join("\n") + evidence;
}

export function derivedVerificationOutputFields(subjectLabel, derivation) {
  const message = derivedVerificationMessage(subjectLabel, derivation);
  return {
    derived_acceptance: derivation.derived_acceptance,
    derived_verification: derivation.derived_verification,
    assistant_message: message,
    ...assistantMessagePresentationFields(),
  };
}

/**
 * Strict-gate check: derived criteria of a story need passing test evidence.
 * `enforce` is stored with the record (block for new records, warn for backfill).
 */
export function validateDerivedVerificationEvidence(context, storyId, story, report) {
  const verification = story?.derived_verification;
  const derived = Array.isArray(story?.derived_acceptance) ? story.derived_acceptance : [];
  if (!verification || verification.disabled || derived.length === 0) return;
  report.checked.push(`derived verification evidence for story ${storyId}`);
  const missing = uncoveredDerivedCriteria(derived, readTestRunRecords(context, storyId));
  if (missing.length === 0) return;
  const bucket = verification.enforce === "block" ? "errors" : "warnings";
  report[bucket].push(
    `Story ${storyId} has derived verification criteria without passing test evidence: `
    + `${missing.map((item) => `${item.id} (${item.verification_type})`).join(", ")}; `
    + `run the checks and record each with 'test record --story ${storyId} --acceptance <criterion-id> ...'`
    + (bucket === "warnings" ? " (warning only: enforcement is warn for this story)" : ""),
  );
}

function inFlightReasons(context, story) {
  const storyDir = path.join(context.sdlcRoot, "stories", story.id);
  const reasons = [];
  if (story.contract_id) reasons.push("contract_bound");
  if (pathEntryExistsNoFollow(path.join(storyDir, "task-start.json"))) reasons.push("task_started");
  const claim = readStoryClaim(context, story.id);
  if (claim && String(claim.status || "").toLowerCase() === "active") reasons.push("claimed");
  if (storyBoundDeliveryProfiles(context, story.id).length > 0) reasons.push("delivery_profile_bound");
  return reasons;
}

function isOpenStory(context, story) {
  if (NOT_OPEN_STORY_STATUSES.has(String(story.status || "").toLowerCase())) return false;
  return !pathEntryExistsNoFollow(path.join(context.sdlcRoot, "stories", story.id, "closure.json"));
}

function backfillOne(context, options, storyId, policy) {
  const storyPath = path.join(context.sdlcRoot, "stories", storyId, "story.json");
  const release = acquireFileLock(storyMutationLockPath(context, storyId));
  try {
    const story = fs.existsSync(storyPath) ? JSON.parse(fs.readFileSync(storyPath, "utf8")) : null;
    if (!story) return { id: storyId, status: "missing" };
    if (!isOpenStory(context, story)) return { id: storyId, status: "not_open" };
    if (story.derived_verification) {
      return { id: storyId, status: "unchanged", derived: (story.derived_acceptance || []).map((item) => item.id) };
    }
    const derivation = deriveStoryVerification(context, story, { mode: "backfill" });
    const derivedIds = derivation.derived_acceptance.map((item) => item.id);
    const reasons = inFlightReasons(context, story);
    if (reasons.length > 0) {
      return { id: storyId, status: "report_only", reasons, derived: derivedIds, derived_acceptance: derivation.derived_acceptance };
    }
    const attribution = buildAttribution(context, options, "story.derive-verification");
    const updated = {
      ...withDerivedFields(story, derivation),
      updated_at: new Date().toISOString(),
      audit: { ...(story.audit || {}), updated_by: attribution.actor, git: attribution.git, run: attribution.run },
    };
    assertRecordSchema(updated, "story.schema.json", `Story ${storyId}`);
    writeJsonFile(storyPath, updated, { force: true });
    appendTraceEvent(context, storyId, {
      type: "decision",
      summary: `Added ${derivedIds.length} derived verification criteria to story ${storyId} (policy ${policy.policy_hash.slice(0, 12)})`,
      action: "story.derive-verification",
      actor: attribution.actor,
      evidence: [toProjectPath(context, storyPath)],
      related: [storyId],
      git: attribution.git,
      run: attribution.run,
    });
    return { id: storyId, status: "updated", derived: derivedIds, derived_acceptance: derivation.derived_acceptance };
  } finally {
    release();
  }
}

/** `story derive-verification`: idempotent, additive, never touches explicit acceptance. */
export function deriveStoriesVerification(context, options) {
  ensureInitialized(context);
  const allOpen = options["all-open"] === true;
  const requested = getOptionString(options, "id");
  if (allOpen === Boolean(requested)) {
    fail("story derive-verification needs exactly one of --id <story-id> or --all-open.");
  }
  const policy = loadVerificationPolicy(context);
  const ids = allOpen
    ? readAllStories(context).filter((story) => isOpenStory(context, story)).map((story) => story.id)
    : [normalizeId(requested)];
  const results = ids.map((id) => backfillOne(context, options, id, policy));
  const counts = {};
  for (const result of results) counts[result.status] = (counts[result.status] || 0) + 1;
  const reportOnly = results.filter((result) => result.status === "report_only");
  const lines = [
    `Derived verification (${policy.enabled ? "policy on" : "policy off"}): ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ") || "no stories"}`,
    ...results.map((result) => `- ${result.id}: ${result.status}${result.reasons ? ` (${result.reasons.join(", ")})` : ""}${result.derived?.length ? ` -> ${result.derived.join(", ")}` : ""}`),
    ...(reportOnly.length > 0
      ? ["Report only: the story record is bound by a contract, task start, claim or delivery profile, and changing it would make them stale. The criteria above are still expected from the agent; they are not gated."]
      : []),
  ];
  output(options, {
    status: "ok",
    policy_hash: policy.policy_hash,
    counts,
    results,
    assistant_message: lines.join("\n"),
    ...assistantMessagePresentationFields(),
  }, lines);
}
