import path from "node:path";
import { computeStableHash } from "../canonical.mjs";
import { reviewerAuthorConflicts } from "../code-review.mjs";
import { fail, failUsage } from "../cli/user-error.mjs";
import {
  buildPullRequestChecks,
  renderPullRequestChecksMarkdown,
} from "../delivery/pull-request-checks.mjs";
import { getOptionString, normalizeId, requireOption } from "../lifecycle/common.mjs";
import { humanGuidanceLocale } from "../lifecycle/guidance.mjs";
import { codeReviewsRoot, toProjectPath } from "../lifecycle/project.mjs";
import {
  workflowFinalGateReceiptPath,
  workflowStrictGateReceiptPath,
} from "../lifecycle/workflow.mjs";
import { Date, console, fs } from "../runtime/host.mjs";
import { hasValidWorkflowReceiptHash } from "../workflow-canonical-evidence.mjs";
import {
  presentUnderPrivacyRules,
  readCodeReviewRecords,
  readSecretScanRecords,
  readTestRunRecords,
  secretScanCoversDeliveryBase,
  secretScanDeliveryBase,
  secretScanMatchesWorkspace,
  secretScanWorkspaceStateHash,
  validateRecordSchema,
} from "./common.mjs";
import { currentDeliveryExecutionState, readDeliveryAutonomyProfile } from "./delivery.mjs";
import { execGit } from "./git.mjs";
import { ensureInitialized } from "./migration.mjs";
import { resolveProjectFilePath } from "./project.mjs";
import { loadStandingApproval, standingApprovalRefForProfile } from "./standing.mjs";
import { readProjectJson } from "./storage.mjs";

export const DELIVERY_CHECKS_FORMATS = Object.freeze(["markdown", "json"]);

// A test run recorded with this framework is reported as a smoke test.
export const SMOKE_TEST_FRAMEWORK = "smoke";

function instant(value) {
  const milliseconds = Date.parse(String(value ?? ""));
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

/** A stored record counts only while it matches its schema and its own hash. */
function recordIsIntact(record, schemaName) {
  if (!record || !validateRecordSchema(record, schemaName).valid) return false;
  const { record_hash: recordHash, ...unhashed } = record;
  return computeStableHash(unhashed) === recordHash;
}

function readReferencedRecord(context, reference) {
  if (!reference?.path) return null;
  try {
    return readProjectJson(
      context,
      resolveProjectFilePath(context, reference.path, { mustExist: true, fileOnly: true }),
    );
  } catch {
    return null;
  }
}

/** Whether a record finished inside the window in which this delivery was running. */
function insideDeliveryWindow(window, finishedAt) {
  if (window.start === null) return false;
  const finished = instant(finishedAt);
  if (finished === null || finished < window.start) return false;
  return window.end === null || finished <= window.end;
}

function runSummary(entry) {
  const { path: recordPath, record } = entry;
  return {
    id: record.id,
    path: recordPath,
    argv: record.command?.argv ?? [],
    outcome: record.outcome,
    exit_code: record.exit_code,
    totals: record.totals,
    finished_at: record.finished_at,
    evidence: (record.evidence || []).map((item) => item.path),
  };
}

function collectTestRuns(context, storyId, window, counters) {
  const tests = [];
  const smoke = [];
  for (const entry of readTestRunRecords(context, storyId)) {
    if (!recordIsIntact(entry.record, "test-run.schema.json")) {
      counters.ignored += 1;
      continue;
    }
    if (!insideDeliveryWindow(window, entry.record.finished_at)) continue;
    (entry.record.framework === SMOKE_TEST_FRAMEWORK ? smoke : tests).push(runSummary(entry));
  }
  return { tests, smoke };
}

/**
 * Secret scans for this delivery, each marked with whether it still covers the
 * project as it is now. The test is the one the validation gate applies: the
 * same head, a range reaching the delivery base, and the same uncommitted work.
 */
function collectSecretScans(context, storyId, profile, window, counters) {
  const records = readSecretScanRecords(context, storyId).filter((entry) => {
    if (!recordIsIntact(entry.record, "secret-scan.schema.json")) {
      counters.ignored += 1;
      return false;
    }
    const scannedDelivery = entry.record.delivery_id || null;
    return (scannedDelivery === null || scannedDelivery === profile.delivery_id)
      && insideDeliveryWindow(window, entry.record.finished_at);
  });
  if (records.length === 0) return [];
  const headSha = execGit(context.root, ["rev-parse", "HEAD"]) || null;
  const deliveryBase = secretScanDeliveryBase(context, storyId);
  let workspaceStateHash = null;
  let workspaceReadable = true;
  if (execGit(context.root, ["rev-parse", "--is-inside-work-tree"]) === "true") {
    try {
      workspaceStateHash = secretScanWorkspaceStateHash(context);
    } catch {
      workspaceReadable = false;
    }
  }
  return records.map(({ path: recordPath, record }) => ({
    id: record.id,
    path: recordPath,
    outcome: record.outcome,
    file_count: record.file_count,
    finding_count: (record.findings || []).length,
    head_sha: record.head_sha || null,
    finished_at: record.finished_at,
    current: workspaceReadable
      && (record.head_sha || null) === headSha
      && secretScanCoversDeliveryBase(context, record, deliveryBase)
      && (workspaceStateHash === null || secretScanMatchesWorkspace(record, workspaceStateHash)),
  }));
}

function collectCodeReviews(context, profile, headSha) {
  const reviews = readCodeReviewRecords(context, profile.id).map((record) => ({
    id: record.id,
    path: toProjectPath(context, path.join(codeReviewsRoot(context), `${record.id}.json`)),
    verdict: record.verdict,
    reviewer_id: record.reviewer?.actor_id ?? "",
    reviewed_head_sha: String(record.reviewed_head_sha || "").toLowerCase(),
    reviewed_at: record.reviewed_at,
    // Independence is judged against the authors recorded with the review,
    // exactly as the merge gate judges it.
    independent: reviewerAuthorConflicts(record.reviewer, record.commit_authors).length === 0,
    finding_count: (record.findings || []).length,
    blocking_count: (record.findings || []).filter((finding) => finding.severity === "blocking").length,
  }));
  return {
    required: context.config.gate_policy?.merge_requires_code_review === true,
    reviews,
    head_sha: headSha,
  };
}

function collectGate(context, filePath, schemaFor, storyId, counters) {
  if (!fs.existsSync(filePath)) return null;
  let receipt;
  try {
    receipt = readProjectJson(context, filePath);
  } catch {
    counters.ignored += 1;
    return null;
  }
  const intact = receipt?.status === "passed"
    && receipt.story_id === storyId
    && validateRecordSchema(receipt, schemaFor(receipt)).valid
    && hasValidWorkflowReceiptHash(receipt);
  if (!intact) {
    counters.ignored += 1;
    return null;
  }
  return { path: toProjectPath(context, filePath), checked_at: receipt.checked_at };
}

function collectStandingApproval(context, profile) {
  const reference = standingApprovalRefForProfile(profile);
  if (!reference) return null;
  const loaded = loadStandingApproval(context, reference.id, { missingOk: true });
  if (!loaded) return { id: reference.id, status: "missing", used: false, evidence: [] };
  const use = loaded.uses.find((candidate) => candidate.profile_ref?.id === profile.id) || null;
  return {
    id: reference.id,
    status: loaded.state.status,
    used: use !== null,
    slot: use?.slot ?? null,
    max_deliveries: loaded.state.max_deliveries,
    evidence: [
      toProjectPath(context, path.join(loaded.directory, "proposal.json")),
      ...(loaded.approval ? [toProjectPath(context, path.join(loaded.directory, "approval.json"))] : []),
    ],
  };
}

/**
 * The budget part of the decision recorded when the delivery started, plus
 * whether any execution budget is bound to it. The decision is read from the
 * record the start receipt names and trusted only while its hash still matches.
 */
function collectBudgetDecision(context, profile, execution) {
  const start = execution.start_receipt;
  if (!start) return { state: "not_started" };
  const reference = start.autonomy_decision_ref;
  const decision = readReferencedRecord(context, reference);
  const constraint = decision?.decision_hash === reference?.hash
    ? (decision?.source_constraints || []).find((candidate) => candidate.source === "budget")
    : null;
  if (!constraint) return { state: "unavailable" };
  const contract = readReferencedRecord(context, profile.contract_refs?.[0]);
  const budgetRefs = [
    contract?.execution_budget_ref,
    ...(profile.requirement_profile_refs || [])
      .map((ref) => readReferencedRecord(context, ref)?.constraints?.budget_ref),
  ].filter(Boolean);
  return {
    state: "recorded",
    blocked: constraint.blocked === true || constraint.valid === false,
    bound: budgetRefs.length > 0,
    reason_codes: constraint.reason_codes || [],
    evidence: [reference.path, execution.start_receipt_path].filter(Boolean),
  };
}

/** The checked-out head, but only while the delivery's own head branch is checked out. */
function deliveryHeadSha(context, profile) {
  const branch = execGit(context.root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (!branch || branch !== profile.pull_request_target?.head_branch) return null;
  return execGit(context.root, ["rev-parse", "--verify", "--quiet", "HEAD"]) || null;
}

/**
 * Read what the project recorded for one pull-request delivery. Nothing is
 * run or repaired: a record that cannot be read or fails its own hash is left
 * out and counted, never turned into a pass.
 */
export function collectPullRequestChecksFacts(context, profile) {
  const storyId = profile.story_refs?.[0]?.id;
  if (!storyId) fail(`Delivery profile ${profile.id} does not name a story.`);
  const execution = currentDeliveryExecutionState(context, profile);
  // Records of the same story that belong to an earlier or later delivery stay out.
  const window = {
    start: instant(execution.start_receipt?.started_at),
    end: instant(execution.close_receipt?.closed_at),
  };
  const counters = { ignored: 0 };
  const headSha = deliveryHeadSha(context, profile);
  const { tests, smoke } = collectTestRuns(context, storyId, window, counters);
  return {
    delivery: {
      profile_id: profile.id,
      delivery_id: profile.delivery_id,
      story_id: storyId,
      repository: profile.pull_request_target?.repository,
      base_branch: profile.pull_request_target?.base_branch,
      head_branch: profile.pull_request_target?.head_branch,
    },
    head_sha: headSha,
    tests,
    smoke_tests: smoke,
    secret_scans: collectSecretScans(context, storyId, profile, window, counters),
    code_review: collectCodeReviews(context, profile, headSha),
    gates: {
      strict: collectGate(
        context,
        workflowStrictGateReceiptPath(context, storyId),
        () => "workflow-strict-gate-receipt.schema.json",
        storyId,
        counters,
      ),
      final: collectGate(
        context,
        workflowFinalGateReceiptPath(context, storyId),
        (receipt) => (receipt.schema_version === "workflow-final-gate-receipt:v1"
          ? "workflow-final-gate-receipt-v1.schema.json"
          : "workflow-final-gate-receipt.schema.json"),
        storyId,
        counters,
      ),
    },
    standing_approval: collectStandingApproval(context, profile),
    budget: collectBudgetDecision(context, profile, execution),
    ignored_records: counters.ignored,
  };
}

function checksFormat(options) {
  const requested = getOptionString(options, "format");
  if (requested && !DELIVERY_CHECKS_FORMATS.includes(requested)) {
    failUsage(`--format must be one of: ${DELIVERY_CHECKS_FORMATS.join(", ")}.`);
  }
  if (options.json === true && requested === "markdown") {
    failUsage("--json and --format markdown ask for different output; use --format json or omit one of them.");
  }
  return options.json === true ? "json" : requested || "markdown";
}

/**
 * The checks model of one pull-request delivery and its Markdown table, after
 * the same privacy rules the Change Observatory applies. Both come from one
 * pass over the records, so the table always matches the model.
 */
export function buildDeliveryChecks(context, profile, { locale = "en" } = {}) {
  if (profile.delivery_kind !== "pull_request") {
    fail(
      `Delivery profile ${profile.id} is a ${profile.delivery_kind} delivery; `
      + "the checks table is built for pull-request deliveries.",
    );
  }
  const model = presentUnderPrivacyRules(
    context,
    buildPullRequestChecks(collectPullRequestChecksFacts(context, profile)),
    "delivery checks table",
  );
  return { model, markdown: renderPullRequestChecksMarkdown(model, { locale }) };
}

/**
 * `autonomy delivery checks`: print the table of checks recorded for one
 * pull-request delivery, ready to paste into the pull-request description.
 *
 * The output is the table alone, with no envelope, correlation id, or clock
 * reading, so the same records always produce the same bytes. It is read-only.
 */
export function showDeliveryChecks(context, options) {
  ensureInitialized(context);
  const profileId = normalizeId(requireOption(options, "id"));
  const format = checksFormat(options);
  const locale = humanGuidanceLocale(options);
  const { model, markdown } = buildDeliveryChecks(context, readDeliveryAutonomyProfile(context, profileId), { locale });
  console.log(format === "json" ? JSON.stringify(model, null, 2) : markdown.trimEnd());
}
