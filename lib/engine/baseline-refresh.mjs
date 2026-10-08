import childProcess from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import {
  BASELINE_REFRESH_SCHEMA,
  BASELINE_REFRESH_SHARED_ROOT,
  baselineRefreshNamespace,
  baselineRefreshSharedRef,
  baselineRefreshTrackingRef,
  baselineRefreshTrackingRoot,
  buildBaselineRefreshSharedPayload,
  readBaselineRefreshSharedPayload,
  DELIVERED_WORK_APPROVAL_SCOPE,
  DELIVERED_WORK_APPROVAL_SOURCE,
  baselineDeltaEntries,
  baselineDeltaSize,
  computeBaselineDelta,
  explainBaselineDelta,
  pathInsideEveryScope,
  sameBaselineDelta,
} from "../baseline-refresh.mjs";
import {
  computeStableHash,
} from "../canonical.mjs";
import {
  fail,
} from "../cli/user-error.mjs";
import {
  serializeSharedPayload,
} from "../shared-ref-records.mjs";
import {
  ORCHESTRATION_COORDINATION_SETTING,
  orchestrationPolicy,
} from "../story-claim-shared-state.mjs";
import {
  hashApprovalSubject,
  latestApprovedRecordApproval,
} from "../lifecycle/authorization.mjs";
import {
  getOptionString,
  hashBuffer,
  isApprovedRecordFresh,
  normalizeId,
  requireOption,
} from "../lifecycle/common.mjs";
import {
  humanGuidanceLocale,
} from "../lifecycle/guidance.mjs";
import {
  renderBaselineReport,
} from "../lifecycle/output.mjs";
import {
  toProjectPath,
} from "../lifecycle/project.mjs";
import {
  baselinePathById,
} from "../lifecycle/story.mjs";
import {
  fs,
} from "../runtime/host.mjs";
import {
  buildBaselineApprovalRequest,
  createBaselineProposal,
  renderApprovalRequestsAssistantMessage,
} from "./authorization.mjs";
import {
  buildAttribution,
  now,
  readStartedExecutionContextPreflight,
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
  resolveProjectFilePath,
} from "./project.mjs";
import {
  pushCreateOnlyRef,
  readSharedRefs,
  resolveSharedScope,
  writeRecordCommit,
} from "./shared-refs.mjs";
import {
  acquireFileLock,
  readProjectJson,
  safeReadDir,
  writeJsonFile,
  writeTextFile,
} from "./storage.mjs";
import {
  appendTraceEvent,
  readBaselines,
  readContractById,
  readStory,
} from "./story.mjs";

const MAX_APPROVAL_CHAIN = 64;
const DELIVERED_WORK_ACTOR = Object.freeze({
  id: "agentic-sdlc-baseline-refresh",
  type: "system",
  name: null,
  email: null,
  source: "policy",
});

export function deliveredRefreshApprovalEnabled(context) {
  return context.config?.baseline_policy?.auto_approve_explained_refresh === true;
}

// Baselines that a later refresh replaced; they stay as history.
export function supersededBaselineIds(baselines) {
  return new Set(baselines
    .map((baseline) => baseline.refresh?.previous_baseline_ref?.id)
    .filter(Boolean));
}

export function currentBaselineRefreshSuggestion(context) {
  const baselines = readBaselines(context);
  const superseded = supersededBaselineIds(baselines);
  const current = baselines.filter((baseline) => !superseded.has(baseline.id)).at(-1);
  if (!current || current.status !== "approved") return null;
  return {
    from: current.id,
    command: `agentic-sdlc baseline refresh --from ${current.id}`,
  };
}

/**
 * Every baseline connected to this one through refreshes: its predecessors
 * and successors. Stories that started from any of them worked on the same
 * line of project history, possibly on other computers at the same time.
 */
export function baselineLineage(context, baselineId) {
  const baselines = readBaselines(context);
  const previousOf = new Map(baselines
    .filter((baseline) => baseline.refresh?.previous_baseline_ref?.id)
    .map((baseline) => [baseline.id, baseline.refresh.previous_baseline_ref.id]));
  const lineage = new Set([baselineId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [successor, previous] of previousOf) {
      if (lineage.has(successor) !== lineage.has(previous)) {
        lineage.add(successor);
        lineage.add(previous);
        changed = true;
      }
    }
  }
  return lineage;
}

/**
 * Delivered work that may explain a change since the given baseline: every
 * merged pull-request delivery whose task started from that baseline or from
 * another baseline of the same lineage.
 */
export function collectDeliveredWorkEvidence(context, previousBaselineId) {
  const lineage = baselineLineage(context, previousBaselineId);
  const evidences = [];
  for (const storyId of safeReadDir(path.join(context.sdlcRoot, "stories")).sort()) {
    const evidence = deliveredWorkEvidenceForStory(context, storyId, lineage);
    if (evidence) evidences.push(evidence);
  }
  return evidences;
}

/**
 * True when merged work by another story produced exactly these bytes of a
 * path (null: removed) inside its own write scope. A started story bound to
 * an older baseline keeps working when other computers deliver around it.
 */
export function deliveredWorkExplainsSource(context, baselineId, { storyId, sourcePath, sha256, evidences = null }) {
  const candidates = evidences || collectDeliveredWorkEvidence(context, baselineId);
  return candidates.some((evidence) => (
    evidence.story_id !== storyId
    && pathInsideEveryScope(sourcePath, evidence.write_scopes)
    && evidence.contentSha256(sourcePath) === sha256
  ));
}

function deliveredWorkEvidenceForStory(context, storyId, lineage) {
  try {
    const story = readStory(context, storyId);
    if (!story?.contract_id) return null;
    const contract = readContractById(context, story.contract_id, { missingOk: true });
    const profileId = contract?.delivery_execution_profile_id;
    if (!profileId) return null;
    const profile = readDeliveryAutonomyProfile(context, profileId, { missingOk: true });
    if (!profile || profile.delivery_kind !== "pull_request") return null;
    const state = currentDeliveryExecutionState(context, profile);
    if (state.lifecycle_status !== "terminal" || state.status !== "merged") return null;
    const mergeCommitSha = mergedCommitSha(context, state.close_receipt);
    if (!mergeCommitSha) return null;
    const started = readStartedExecutionContextPreflight(context, {
      storyId: story.id,
      contractId: contract.id,
      profileId: profile.id,
    });
    const receipt = started.receipt;
    if (!receipt) return null;
    const startedFromBaseline = receipt.source_snapshots.some((snapshot) => snapshot.bindings
      .some((binding) => binding.kind === "baseline" && lineage.has(binding.id)));
    if (!startedFromBaseline) return null;
    return {
      story_id: story.id,
      delivery_profile_id: profile.id,
      merge_commit_sha: mergeCommitSha,
      write_scopes: receipt.requirement_scopes.map((scope) => scope.allowed_write_paths),
      contentSha256: gitContentReader(context, mergeCommitSha),
    };
  } catch {
    // A delivery whose records cannot be verified explains nothing.
    return null;
  }
}

function mergedCommitSha(context, closeReceipt) {
  const ref = closeReceipt?.terminal_action_receipt_ref;
  if (!ref?.path) return null;
  const receiptPath = resolveProjectFilePath(context, ref.path, { mustExist: true, fileOnly: true });
  const receipt = readProjectJson(context, receiptPath);
  if (receipt.id !== ref.id || receipt.receipt_hash !== ref.hash || receipt.action !== "pull_request.merge") {
    return null;
  }
  const proof = receipt.action_details?.provider_operation?.completion_receipt?.proof
    || receipt.action_details?.provider_verification;
  const sha = String(proof?.merge_commit_sha || "").toLowerCase();
  return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(sha) ? sha : null;
}

// sha256 of a path at a commit: a hex digest, null when the commit has no such
// file, or undefined when the commit is not available in this clone.
function gitContentReader(context, commitSha) {
  const cache = new Map();
  let available = null;
  return (sourcePath) => {
    if (available === null) available = gitSucceeds(context.root, ["cat-file", "-e", `${commitSha}^{commit}`]);
    if (!available) return undefined;
    if (cache.has(sourcePath)) return cache.get(sourcePath);
    let digest = null;
    try {
      const content = childProcess.execFileSync(
        "git",
        ["-C", context.root, "cat-file", "blob", `${commitSha}:${sourcePath}`],
        { stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1024 * 1024 * 1024 },
      );
      digest = hashBuffer(content);
    } catch {
      digest = null;
    }
    cache.set(sourcePath, digest);
    return digest;
  };
}

function gitSucceeds(root, args) {
  try {
    childProcess.execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Claims the single successor of a baseline on the project's git remote
 * before anything is written, using the story-claim coordination setting.
 * Without a remote (or with sharing turned off) the refresh stays on this
 * computer, where the create-only baseline file is the arbiter.
 */
export function claimBaselineRefreshSuccessor(context, { previousId, successorId, refreshHash, orphanNote = null }) {
  let coordination;
  try {
    coordination = orchestrationPolicy(context.config).coordination;
  } catch (error) {
    fail(error.message);
  }
  const scope = resolveSharedScope(context, coordination, ORCHESTRATION_COORDINATION_SETTING);
  if (scope.scope === "local") return { scope: "local", note: scope.note };
  const unreachable = (reason) => fail(
    `Baseline ${previousId} was not refreshed: another computer may already have refreshed it, and ${reason}. `
    + "Nothing was written; try again when the git remote is reachable.",
  );
  if (scope.unavailable) unreachable(scope.unavailable);
  const timeoutSeconds = coordination.timeout_seconds;
  const ref = baselineRefreshSharedRef(previousId);
  const read = () => readSharedRefs(context, {
    remote: scope.remote,
    sharedRoot: BASELINE_REFRESH_SHARED_ROOT,
    trackingRoot: baselineRefreshTrackingRoot(scope.fingerprint),
    prefix: `${baselineRefreshNamespace(previousId)}/`,
    timeoutSeconds,
    describe: (name) => `the refresh record ${name}`,
  });
  const winner = (records) => {
    const record = records.find((item) => item.ref === ref);
    return record ? readBaselineRefreshSharedPayload(record.message, previousId) || { successor_id: "an unreadable record" } : null;
  };
  // The same successor (same id and same recorded content) may claim again,
  // for example when it is approved after being proposed.
  const ours = (payload) => payload.successor_id === successorId && payload.refresh_hash === refreshHash;
  const refuse = (payload) => fail(
    `Baseline ${previousId} was already refreshed as ${payload.successor_id} on another computer`
    + (payload.successor_id === successorId ? " with different content" : "")
    + `. ${orphanNote || "Nothing was written here."} Pull the project records, then run baseline refresh --from ${payload.successor_id}; `
    + "changes delivered from either baseline are still attributed to their stories.",
  );
  const before = read();
  if (!before.available) unreachable(before.error);
  const existing = winner(before.records);
  if (existing && ours(existing)) return { scope: "shared", ref };
  if (existing) refuse(existing);
  const commit = writeRecordCommit(context, timeoutSeconds, serializeSharedPayload(buildBaselineRefreshSharedPayload({
    previousBaselineId: previousId,
    successorId,
    refreshHash,
    createdAt: now(),
  })));
  if (commit.error) unreachable(commit.error);
  const pushed = pushCreateOnlyRef(context, {
    url: scope.url,
    ref,
    objectName: commit.objectName,
    trackingRef: baselineRefreshTrackingRef(ref, scope.fingerprint),
    timeoutSeconds,
  });
  if (!pushed.pushed) {
    const after = read();
    if (!after.available) unreachable(pushed.error);
    const record = after.records.find((item) => item.ref === ref);
    if (record?.objectName === commit.objectName) return { scope: "shared", ref };
    const landed = record ? winner(after.records) : null;
    if (landed && ours(landed)) return { scope: "shared", ref };
    if (landed) refuse(landed);
    unreachable(pushed.error);
  }
  return { scope: "shared", ref };
}

export function baselineRefreshHash(baseline) {
  return computeStableHash({ source_hashes: baseline.source_hashes, refresh: baseline.refresh });
}

/**
 * A refreshed baseline can be approved only while it is the one successor
 * the remote recorded for its predecessor; a successor another computer
 * replaced first is an orphan and is never approved.
 */
export function assertBaselineRefreshNotOrphaned(context, baseline) {
  const previousId = baseline.refresh?.previous_baseline_ref?.id;
  if (!previousId) return;
  claimBaselineRefreshSuccessor(context, {
    previousId,
    successorId: baseline.id,
    refreshHash: baselineRefreshHash(baseline),
    orphanNote: `${baseline.id} on this computer is an orphan and cannot be approved.`,
  });
}

export function nextRefreshBaselineId(context, previousId) {
  const stem = previousId.replace(/-R\d+$/u, "");
  const match = previousId.match(/-R(\d+)$/u);
  let revision = match ? Number(match[1]) + 1 : 2;
  while (fs.existsSync(baselinePathById(context, `${stem}-R${revision}`))) revision += 1;
  return `${stem}-R${revision}`;
}

function refreshSourceInputs(context, previous) {
  const exists = (sourcePath) => {
    try {
      resolveProjectFilePath(context, sourcePath, { mustExist: true });
      return true;
    } catch {
      return false;
    }
  };
  const roots = (previous.source_discovery?.requested_paths || [
    ...(previous.repository_snapshot?.source_roots || []),
    ...(previous.repository_snapshot?.test_roots || []),
  ]).filter(exists);
  const documents = (previous.imported_documents || [])
    .map((document) => document.path)
    .filter((documentPath) => documentPath && exists(documentPath));
  const underRoot = (sourcePath) => roots.some((root) => root === "." || sourcePath.startsWith(`${root}/`));
  const files = (previous.source_paths || [])
    .filter((sourcePath) => !documents.includes(sourcePath) && !underRoot(sourcePath) && exists(sourcePath));
  return { roots, documents, files };
}

function buildDeliveredWorkApproval(baseline, previous, attribution) {
  const approvedContentHash = hashApprovalSubject(baseline);
  const explained = baseline.refresh.explanations;
  const stories = [...new Set(explained.map((entry) => entry.story_id))].sort();
  return {
    id: `APR-${now().replace(/[-:.TZ]/gu, "")}-${crypto.randomBytes(3).toString("hex")}`,
    baseline_id: baseline.id,
    status: "approved",
    summary: `All ${explained.length} change(s) since ${previous.id} come from delivered stories: ${stories.join(", ") || "none"}.`,
    scope: DELIVERED_WORK_APPROVAL_SCOPE,
    previous_baseline_id: previous.id,
    evidence: [],
    approval_source: DELIVERED_WORK_APPROVAL_SOURCE,
    authorization_ref: null,
    authorization_use_ref: null,
    authorization_action: null,
    explicit_user_confirmation: false,
    provisional: false,
    approved_content_hash: approvedContentHash,
    hash_algorithm: "sha256:stable-json:v1",
    approved_by: { ...DELIVERED_WORK_ACTOR },
    requested_by: attribution.actor,
    git: attribution.git,
    run: attribution.run,
    created_at: now(),
  };
}

export function refreshBaseline(context, options) {
  ensureInitialized(context);
  const previousId = normalizeId(requireOption(options, "from"));
  const previousPath = baselinePathById(context, previousId);
  if (!fs.existsSync(previousPath)) fail(`Baseline ${previousId} does not exist.`);
  const previous = readProjectJson(context, previousPath);
  if (previous.status !== "approved" || !latestApprovedRecordApproval(previous) || !isApprovedRecordFresh(previous)) {
    fail(
      `Baseline ${previousId} is ${previous.status || "unapproved"}; a refresh starts only from an approved baseline. `
      + `Approve it first, or replace the proposal with baseline propose --id ${previousId} --force.`,
    );
  }
  const superseding = readBaselines(context)
    .find((baseline) => baseline.refresh?.previous_baseline_ref?.id === previousId);
  if (superseding) {
    fail(`Baseline ${previousId} was already refreshed by ${superseding.id}; refresh from ${superseding.id} instead.`);
  }
  const id = options.id ? normalizeId(String(options.id)) : nextRefreshBaselineId(context, previousId);
  if (fs.existsSync(baselinePathById(context, id))) {
    fail(`Baseline ${id} already exists; choose another --id. A refresh never replaces an existing baseline.`);
  }
  const inputs = refreshSourceInputs(context, previous);
  const previousApproval = latestApprovedRecordApproval(previous);
  const evidences = collectDeliveredWorkEvidence(context, previousId);
  let delta = null;
  const result = createBaselineProposal(context, {
    ...options,
    id,
    kind: previous.kind,
    document: inputs.documents,
    source: [...inputs.roots, ...inputs.files],
    question: previous.open_questions || [],
    assumption: previous.assumptions || [],
    summary: getOptionString(options, "summary") || `Current project state after the work delivered since ${previousId}.`,
    force: false,
  }, {
    decorate(baseline) {
      delta = computeBaselineDelta(previous.source_hashes || {}, baseline.source_hashes || {});
      if (baselineDeltaSize(delta) === 0) {
        fail(`Baseline ${previousId} still describes every file in its scope; nothing to refresh.`);
      }
      const { explanations, unexplained } = explainBaselineDelta(delta, baseline.source_hashes || {}, evidences);
      baseline.refresh = {
        schema: BASELINE_REFRESH_SCHEMA,
        previous_baseline_ref: {
          id: previous.id,
          path: toProjectPath(context, previousPath),
          approved_content_hash: previousApproval.approved_content_hash,
        },
        delta,
        explanations,
        unexplained,
      };
      // Last step before writing: a refresh another computer already made
      // stops here with nothing written.
      claimBaselineRefreshSuccessor(context, {
        previousId,
        successorId: baseline.id,
        refreshHash: baselineRefreshHash(baseline),
      });
    },
  });

  let baseline = result.baseline;
  const attribution = buildAttribution(context, options, "baseline.refresh");
  const autoApprove = deliveredRefreshApprovalEnabled(context)
    && baseline.refresh.unexplained.length === 0
    && deliveredWorkApprovalChainErrors(context, previous).length === 0;
  if (autoApprove) {
    const releaseLock = acquireFileLock(`${result.baseline_path}.lock`);
    try {
      baseline = readProjectJson(context, result.baseline_path);
      baseline.canonicality = {
        ...(baseline.canonicality || {}),
        state: "confirmed",
        inferred_not_approved: false,
        user_confirmation_required: false,
      };
      const approval = buildDeliveredWorkApproval(baseline, previous, attribution);
      baseline.status = "approved";
      baseline.approvals = [...(baseline.approvals || []), approval];
      baseline.updated_at = now();
      writeJsonFile(result.baseline_path, baseline, { force: true });
      writeTextFile(result.report_path, renderBaselineReport(baseline), { force: true });
    } finally {
      releaseLock();
    }
  }
  appendTraceEvent(context, null, {
    type: "gate",
    summary: autoApprove
      ? `Refreshed baseline ${previousId} as ${id}; every change comes from delivered work`
      : `Proposed baseline ${id} to refresh ${previousId}; ${baseline.refresh.unexplained.length} change(s) need review`,
    action: "baseline.refresh",
    actor: attribution.actor,
    evidence: [toProjectPath(context, result.baseline_path), toProjectPath(context, result.report_path)],
    related: [previousId, id],
    git: attribution.git,
    run: attribution.run,
  });

  const approvalRequest = autoApprove ? null : buildBaselineApprovalRequest(context, baseline);
  const italian = humanGuidanceLocale(options) === "it";
  const counts = Object.fromEntries(["added", "changed", "removed"].map((change) => [change, delta[change].length]));
  const unexplained = baseline.refresh.unexplained;
  const lines = autoApprove
    ? [
        italian
          ? `Il baseline ${id} sostituisce ${previousId} ed è approvato: ogni modifica viene da story consegnate.`
          : `Baseline ${id} replaces ${previousId} and is approved: every change comes from delivered stories.`,
        `added ${counts.added}, changed ${counts.changed}, removed ${counts.removed}`,
      ]
    : [
        italian
          ? `Il baseline ${id} è proposto per sostituire ${previousId}; ${unexplained.length} modifiche non vengono da story consegnate e richiedono la tua revisione.`
          : `Baseline ${id} is proposed to replace ${previousId}; ${unexplained.length} change(s) do not come from delivered stories and need your review.`,
        ...unexplained.slice(0, 20).map((entry) => `- ${entry.change}: ${entry.path}`),
        "",
        ...renderApprovalRequestsAssistantMessage([approvalRequest]).split("\n"),
      ];
  output(options, {
    status: baseline.status,
    baseline_path: toProjectPath(context, result.baseline_path),
    report_path: toProjectPath(context, result.report_path),
    previous_baseline_id: previousId,
    delta: counts,
    explained: baseline.refresh.explanations.length,
    unexplained,
    auto_approved: autoApprove,
    approval_request: approvalRequest,
    next_commands: autoApprove
      ? []
      : [`agentic-sdlc baseline approve --id ${id} --actor-type human --approval-source explicit-user --summary "<what the user confirmed>"`],
    baseline,
  }, lines);
}

// The approval a delivered-work refresh rests on: the predecessor must carry a
// person's (or CI's) approval, directly or through earlier verified refreshes.
export function deliveredWorkApprovalChainErrors(context, baseline, depth = 0) {
  const approval = latestApprovedRecordApproval(baseline);
  if (!approval || !isApprovedRecordFresh(baseline)) {
    return [`baseline ${baseline.id} has no current approval`];
  }
  if (approval.approval_source === "explicit-user") {
    return approval.approved_by?.type === "human" ? [] : [`baseline ${baseline.id} explicit-user approval has no human approver`];
  }
  if (approval.approval_source === "ci") {
    return approval.approved_by?.type === "ci" ? [] : [`baseline ${baseline.id} CI approval has no CI approver`];
  }
  if (approval.approval_source === DELIVERED_WORK_APPROVAL_SOURCE) {
    if (depth >= MAX_APPROVAL_CHAIN) return [`baseline ${baseline.id} refresh chain is longer than ${MAX_APPROVAL_CHAIN}`];
    return deliveredWorkBaselineApprovalErrors(context, baseline, { depth: depth + 1 }).errors;
  }
  return [`baseline ${baseline.id} approval source ${approval.approval_source || "missing"} cannot anchor a delivered-work refresh`];
}

/**
 * Re-verify an approval recorded from delivered work. The records alone must
 * reproduce the delta and its attribution; Git content is compared whenever
 * the delivered commit is available in this clone.
 */
export function deliveredWorkBaselineApprovalErrors(context, baseline, { depth = 0 } = {}) {
  const errors = [];
  const warnings = [];
  const label = `baseline ${baseline.id} delivered-work approval`;
  const approval = latestApprovedRecordApproval(baseline);
  const refresh = baseline.refresh;
  if (!deliveredRefreshApprovalEnabled(context)) {
    errors.push(`${label} is no longer allowed by baseline_policy.auto_approve_explained_refresh`);
  }
  if (approval?.approved_by?.type !== "system" || approval?.scope !== DELIVERED_WORK_APPROVAL_SCOPE) {
    errors.push(`${label} must be a system approval with scope ${DELIVERED_WORK_APPROVAL_SCOPE}`);
  }
  if (refresh?.schema !== BASELINE_REFRESH_SCHEMA || !refresh.previous_baseline_ref?.id) {
    errors.push(`${label} has no baseline refresh record`);
    return { errors, warnings };
  }
  if (approval?.previous_baseline_id !== refresh.previous_baseline_ref.id) {
    errors.push(`${label} names a different previous baseline from its refresh record`);
  }
  const previousPath = baselinePathById(context, refresh.previous_baseline_ref.id);
  if (!fs.existsSync(previousPath)) {
    errors.push(`${label} references missing baseline ${refresh.previous_baseline_ref.id}`);
    return { errors, warnings };
  }
  const previous = readProjectJson(context, previousPath);
  if (latestApprovedRecordApproval(previous)?.approved_content_hash !== refresh.previous_baseline_ref.approved_content_hash) {
    errors.push(`${label} no longer matches the approval of ${previous.id}`);
  }
  for (const error of deliveredWorkApprovalChainErrors(context, previous, depth)) {
    errors.push(`${label} rests on an invalid approval: ${error}`);
  }
  const delta = computeBaselineDelta(previous.source_hashes || {}, baseline.source_hashes || {});
  if (!sameBaselineDelta(delta, refresh.delta)) {
    errors.push(`${label} records a delta that differs from the two snapshots`);
  }
  if ((refresh.unexplained || []).length > 0) {
    errors.push(`${label} covers ${refresh.unexplained.length} unexplained change(s)`);
  }
  const explanations = refresh.explanations || [];
  const entries = baselineDeltaEntries(delta);
  if (
    explanations.length !== entries.length
    || !entries.every((entry) => explanations.some((item) => item.path === entry.path && item.change === entry.change))
  ) {
    errors.push(`${label} does not attribute every change exactly once`);
  }
  const evidences = collectDeliveredWorkEvidence(context, previous.id);
  for (const item of explanations) {
    const expected = item.change === "removed" ? null : baseline.source_hashes?.[item.path];
    if (item.sha256 !== expected) {
      errors.push(`${label} attributes different bytes to ${item.path}`);
      continue;
    }
    const evidence = evidences.find((candidate) => (
      candidate.story_id === item.story_id
      && candidate.delivery_profile_id === item.delivery_profile_id
      && candidate.merge_commit_sha === item.merge_commit_sha
    ));
    if (!evidence || !pathInsideEveryScope(item.path, evidence.write_scopes)) {
      errors.push(`${label} attributes ${item.path} to delivery ${item.delivery_profile_id}, which no longer proves it`);
      continue;
    }
    const content = evidence.contentSha256(item.path);
    if (content === undefined) {
      warnings.push(`${label} could not compare ${item.path} with commit ${item.merge_commit_sha}, which is not in this clone`);
    } else if (content !== expected) {
      errors.push(`${label}: commit ${item.merge_commit_sha} does not hold the recorded bytes of ${item.path}`);
    }
  }
  return { errors, warnings };
}
