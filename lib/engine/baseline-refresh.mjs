import path from "node:path";
import {
  BASELINE_REFRESH_SCHEMA,
  BASELINE_REFRESH_SHARED_ROOT,
  baselineRefreshNamespace,
  baselineRefreshSharedRef,
  baselineRefreshWithdrawalRef,
  buildBaselineRefreshWithdrawalPayload,
  resolveBaselineRefreshClaims,
  baselineRefreshTrackingRef,
  baselineRefreshTrackingRoot,
  buildBaselineRefreshSharedPayload,
  DELIVERED_WORK_APPROVAL_SCOPE,
  DELIVERED_WORK_APPROVAL_SOURCE,
  baselineDeltaEntries,
  baselineDeltaSize,
  computeBaselineDelta,
  explainBaselineDelta,
  liveBaselines,
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
  requireFormalApprovalActor,
} from "../lifecycle/authorization.mjs";
import {
  deliveryAutonomyRoot,
} from "../lifecycle/delivery.mjs";
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
  childProcess,
  crypto,
  fs,
} from "../runtime/host.mjs";
import {
  buildApprovalRecord,
  buildBaselineApprovalRequest,
  createBaselineProposal,
  renderApprovalRequestsAssistantMessage,
} from "./authorization.mjs";
import {
  assertRecordSchema,
  buildAttribution,
  now,
  readStartedExecutionContextPreflight,
} from "./common.mjs";
import {
  currentDeliveryExecutionState,
  readDeliveryAutonomyProfile,
} from "./delivery.mjs";
import {
  externalMergeEvidence,
} from "./external-merge.mjs";
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
  firstLine,
  isGitRepository,
  pushCreateOnlyRef,
  readSharedRefs,
  runGit,
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
  baselineIgnoredSourcePaths,
  readBaselineSummaries,
  readContractById,
  readStory,
} from "./story.mjs";

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

// Baselines that a later refresh replaced; they stay as history. A
// withdrawn successor replaces nothing.
export function supersededBaselineIds(baselines) {
  return new Set(liveBaselines(baselines)
    .map((baseline) => baseline.refresh?.previous_baseline_ref?.id)
    .filter(Boolean));
}

export function currentBaselineRefreshSuggestion(context) {
  const baselines = readBaselineSummaries(context);
  const superseded = supersededBaselineIds(baselines);
  const current = liveBaselines(baselines).filter((baseline) => !superseded.has(baseline.id)).at(-1);
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
  const baselines = readBaselineSummaries(context);
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
  // Newest delivery first: the latest merge of a path is the one that holds
  // its current bytes, so the search usually stops at the first candidate.
  return evidences.sort((a, b) => b.closed_at.localeCompare(a.closed_at) || a.story_id.localeCompare(b.story_id));
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

/**
 * True when a baseline records bytes of a path that another story's merged
 * delivery produced after this story started: the merge is not in the
 * history of the commit the story started from (startSha; null for a story
 * started before the first commit). The story was planned without that
 * work, so its branch may not hold those bytes yet, whatever the other
 * delivery's write scope. What the story itself changes stays bound by its
 * changed-path perimeter.
 */
export function deliveredWorkAfterStoryStart(context, baselineId, {
  storyId,
  sourcePath,
  expectedSha256,
  startSha,
  evidences = null,
}) {
  if (startSha && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(startSha)) return false;
  const candidates = evidences || collectDeliveredWorkEvidence(context, baselineId);
  return candidates.some((evidence) => (
    evidence.story_id !== storyId
    && evidence.contentSha256(sourcePath) === expectedSha256
    && !(startSha && gitSucceeds(context.root, ["merge-base", "--is-ancestor", evidence.merge_commit_sha, startSha]))
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
    if (state.lifecycle_status !== "terminal") return null;
    // Merged through the plugin, or merged by a person outside it and
    // acknowledged afterwards: either way the code is on the base branch.
    const external = state.status === "merged" ? null : externalMergeEvidence(context, profile, state);
    if (state.status !== "merged" && !external) return null;
    const mergeCommitSha = external
      ? external.merge_commit_sha
      : mergedCommitSha(context, state.close_receipt);
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
    const reader = gitContentReader(context, mergeCommitSha);
    return {
      story_id: story.id,
      delivery_profile_id: profile.id,
      merge_commit_sha: mergeCommitSha,
      closed_at: String(external ? external.merged_at : state.close_receipt?.closed_at || ""),
      write_scopes: receipt.requirement_scopes.map((scope) => scope.allowed_write_paths),
      contentSha256: reader.read,
      prefetch: reader.prefetch,
      changedPaths: reader.changedPaths,
    };
  } catch {
    // A delivery whose records cannot be verified explains nothing.
    return null;
  }
}

export function mergedCommitSha(context, closeReceipt) {
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
// file, or undefined when the commit is not available in this clone. prefetch
// reads many paths of the commit with one git process.
export function gitContentReader(context, commitSha) {
  const cache = new Map();
  let available = null;
  const isAvailable = () => {
    if (available === null) available = gitSucceeds(context.root, ["cat-file", "-e", `${commitSha}^{commit}`]);
    return available;
  };
  const prefetch = (sourcePaths) => {
    if (!isAvailable()) return;
    const missing = [...new Set(sourcePaths)].filter((sourcePath) => !cache.has(sourcePath) && !/[\r\n]/u.test(sourcePath));
    if (missing.length === 0) return;
    let stdout;
    try {
      stdout = childProcess.execFileSync("git", ["-C", context.root, "cat-file", "--batch"], {
        input: missing.map((sourcePath) => `${commitSha}:${sourcePath}\n`).join(""),
        stdio: ["pipe", "pipe", "ignore"],
        maxBuffer: 1024 * 1024 * 1024,
      });
    } catch {
      return;
    }
    let offset = 0;
    for (const sourcePath of missing) {
      const end = stdout.indexOf(0x0a, offset);
      if (end < 0) return;
      const header = stdout.subarray(offset, end).toString("utf8");
      offset = end + 1;
      const match = header.match(/^[0-9a-f]+ (\S+) (\d+)$/u);
      if (!match) {
        cache.set(sourcePath, null);
        continue;
      }
      const size = Number(match[2]);
      cache.set(sourcePath, match[1] === "blob" ? hashBuffer(stdout.subarray(offset, offset + size)) : null);
      offset += size + 1;
    }
  };
  const read = (sourcePath) => {
    if (!isAvailable()) return undefined;
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
  // Paths the commit changed against its first parent: what the delivery
  // brought to the branch it merged into. undefined when Git cannot tell.
  let changed = null;
  const changedPaths = () => {
    if (changed !== null) return changed;
    changed = undefined;
    if (!isAvailable()) return changed;
    try {
      const stdout = childProcess.execFileSync(
        "git",
        ["-C", context.root, "diff-tree", "-r", "-z", "--name-only", "--no-renames", "--no-commit-id", `${commitSha}^1`, commitSha],
        { stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 },
      );
      changed = stdout.toString("utf8").split("\0").filter(Boolean);
    } catch {
      changed = undefined;
    }
    return changed;
  };
  return { read, prefetch, changedPaths };
}

function gitSucceeds(root, args) {
  try {
    childProcess.execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

function sharedRefreshScope(context) {
  let coordination;
  try {
    coordination = orchestrationPolicy(context.config).coordination;
  } catch (error) {
    fail(error.message);
  }
  return { coordination, scope: resolveSharedScope(context, coordination, ORCHESTRATION_COORDINATION_SETTING) };
}

function readRefreshRecords(context, scope, coordination, previousId) {
  return readSharedRefs(context, {
    remote: scope.remote,
    sharedRoot: BASELINE_REFRESH_SHARED_ROOT,
    trackingRoot: baselineRefreshTrackingRoot(scope.fingerprint),
    prefix: `${baselineRefreshNamespace(previousId)}/`,
    timeoutSeconds: coordination.timeout_seconds,
    describe: (name) => `the refresh record ${name}`,
  });
}

/**
 * Successor ids withdrawn on the remote for this baseline, so a new refresh
 * never reuses the id of a withdrawn one. Best effort: when the remote cannot
 * be read here, the claim that follows reports it.
 */
function sharedWithdrawnSuccessorIds(context, previousId) {
  const { coordination, scope } = sharedRefreshScope(context);
  if (scope.scope === "local" || scope.unavailable) return new Set();
  const read = readRefreshRecords(context, scope, coordination, previousId);
  if (!read.available) return new Set();
  return new Set(resolveBaselineRefreshClaims(read.records, previousId).withdrawn.map((item) => item.successor.successor_id));
}

/**
 * Claims the single successor of a baseline on the project's git remote
 * before anything is written, using the story-claim coordination setting.
 * Without a remote (or with sharing turned off) the refresh stays on this
 * computer, where the create-only baseline file is the arbiter. A successor
 * withdrawn before approval releases its generation; the next claim takes the
 * following one.
 */
export function claimBaselineRefreshSuccessor(context, { previousId, successorId, refreshHash, orphanNote = null }) {
  const { coordination, scope } = sharedRefreshScope(context);
  if (scope.scope === "local") return { scope: "local", note: scope.note };
  const unreachable = (reason) => fail(
    `Baseline ${previousId} was not refreshed: another computer may already have refreshed it, and ${reason}. `
    + "Nothing was written; try again when the git remote is reachable.",
  );
  if (scope.unavailable) unreachable(scope.unavailable);
  const timeoutSeconds = coordination.timeout_seconds;
  const read = () => readRefreshRecords(context, scope, coordination, previousId);
  // The same successor (same id and same recorded content) may claim again,
  // for example when it is approved after being proposed.
  const ours = (payload) => payload.successor_id === successorId && payload.refresh_hash === refreshHash;
  const refuse = (payload) => fail(
    `Baseline ${previousId} was already refreshed as ${payload.successor_id} on another computer`
    + (payload.successor_id === successorId ? " with different content" : "")
    + `. ${orphanNote || "Nothing was written here."} Pull the project records and run the refresh again: `
    + `it continues from ${payload.successor_id} and re-reads the current files, so the next snapshot holds both changes.`,
  );
  const refuseWithdrawn = () => fail(
    `Baseline ${successorId} was withdrawn as the successor of ${previousId} and is never claimed or approved again. `
    + `${orphanNote ? "" : "Nothing was written here. "}Pull the project records and run baseline refresh --from ${previousId} again: `
    + "the new refresh gets its own id.",
  );
  const decide = (records) => {
    const claims = resolveBaselineRefreshClaims(records, previousId);
    if (claims.withdrawn.some((item) => item.successor.successor_id === successorId)) refuseWithdrawn();
    if (claims.open && ours(claims.open.payload)) return { done: true, ref: baselineRefreshSharedRef(previousId, claims.open.generation) };
    if (claims.open) refuse(claims.open.payload);
    return { done: false, generation: claims.nextGeneration };
  };
  const before = read();
  if (!before.available) unreachable(before.error);
  const first = decide(before.records);
  if (first.done) return { scope: "shared", ref: first.ref };
  const ref = baselineRefreshSharedRef(previousId, first.generation);
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
    if (record) {
      const landed = decide(after.records);
      if (landed.done) return { scope: "shared", ref: landed.ref };
    }
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

export function nextRefreshBaselineId(context, previousId, excludedIds = new Set()) {
  const stem = previousId.replace(/-R\d+$/u, "");
  const match = previousId.match(/-R(\d+)$/u);
  let revision = match ? Number(match[1]) + 1 : 2;
  while (
    fs.existsSync(baselinePathById(context, `${stem}-R${revision}`))
    || excludedIds.has(`${stem}-R${revision}`)
  ) revision += 1;
  return `${stem}-R${revision}`;
}

function refreshComparedHashes(previousHashes, ignoredPaths) {
  const ignored = new Set(ignoredPaths);
  return Object.fromEntries(Object.entries(previousHashes || {})
    .filter(([sourcePath]) => !ignored.has(sourcePath)));
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

/**
 * The newest baseline of the refresh line that starts at this one. A refresh
 * asked from a baseline another computer already refreshed continues from
 * that successor, so it re-reads the current files on top of it instead of
 * replaying an older delta.
 */
export function latestBaselineInLine(context, baselineId) {
  const baselines = liveBaselines(readBaselineSummaries(context));
  let current = baselineId;
  const visited = new Set([current]);
  for (;;) {
    const successor = baselines.find((baseline) => baseline.refresh?.previous_baseline_ref?.id === current);
    if (!successor || visited.has(successor.id)) return current;
    visited.add(successor.id);
    current = successor.id;
  }
}

const CHECKOUT_TIMEOUT_SECONDS = 30;

function checkoutGit(context, args) {
  return runGit(context.root, args, { timeoutSeconds: CHECKOUT_TIMEOUT_SECONDS });
}

/**
 * The branches a refresh may read: the base branches of the project's
 * pull-request deliveries and the default branch of the coordination remote
 * (`refs/remotes/<remote>/HEAD`); when neither is known, a local `main` or
 * `master`. Head branches of deliveries are story branches.
 */
function refreshBaseBranches(context, remote) {
  const bases = new Set();
  const heads = new Set();
  const root = deliveryAutonomyRoot(context);
  for (const name of safeReadDir(root).filter((entry) => entry.endsWith(".json")).sort()) {
    try {
      const profile = readProjectJson(context, path.join(root, name));
      const target = profile?.pull_request_target;
      if (profile?.delivery_kind !== "pull_request" || !target) continue;
      if (typeof target.base_branch === "string" && target.base_branch) bases.add(target.base_branch);
      if (typeof target.head_branch === "string" && target.head_branch) heads.add(target.head_branch);
    } catch {
      // A profile that cannot be read names no branch.
    }
  }
  const remoteHead = checkoutGit(context, ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`]);
  const remoteDefault = remoteHead.ok ? firstLine(remoteHead.stdout) : "";
  if (remoteDefault.startsWith(`${remote}/`)) bases.add(remoteDefault.slice(remote.length + 1));
  if (bases.size === 0) {
    for (const candidate of ["main", "master"]) {
      if (checkoutGit(context, ["rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`]).ok) bases.add(candidate);
    }
  }
  for (const head of heads) bases.delete(head);
  return { bases: [...bases].sort(), heads };
}

// Paths of the refresh scope whose working-tree state differs from HEAD
// (modified, added, removed, or untracked); project records under .sdlc are
// written by the plugin itself and never count.
function uncommittedScopePaths(context, inputs) {
  const scope = [...inputs.roots, ...inputs.documents, ...inputs.files];
  if (scope.length === 0) return [];
  const listed = checkoutGit(context, [
    "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--",
    ...scope.map((entry) => `:(literal)${entry}`),
    ":(exclude).sdlc",
  ]);
  if (!listed.ok) return [];
  return listed.stdout.split("\u0000").filter((entry) => entry.length > 3).map((entry) => entry.slice(3));
}

/**
 * A refresh records the state every new story starts from, so it reads the
 * base branch as committed. It is refused on another branch (a story branch
 * not merged yet), on a detached HEAD that is not the tip of a base branch,
 * and, inside its own scope, over changes that are not committed; each has an
 * explicit override. A project outside git, or a repository without a first
 * commit, has nothing to compare and is not checked. When no base branch is
 * known (no delivery, no remote default, no main or master), the branch is
 * not checked either.
 */
function inspectRefreshCheckout(context, options, previousId, inputs) {
  const italian = humanGuidanceLocale(options) === "it";
  if (isGitRepository(context, CHECKOUT_TIMEOUT_SECONDS) !== true) return null;
  const head = checkoutGit(context, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (!head.ok) return null;
  const commit = firstLine(head.stdout);
  let remote = "origin";
  try {
    remote = orchestrationPolicy(context.config).coordination.remote;
  } catch {
    remote = "origin";
  }
  const branchResult = checkoutGit(context, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const branch = branchResult.ok ? firstLine(branchResult.stdout) || null : null;
  const { bases } = refreshBaseBranches(context, remote);
  let baseCheck;
  if (bases.length === 0) {
    baseCheck = "base_unknown";
  } else if (branch && bases.includes(branch)) {
    baseCheck = "base_branch";
  } else {
    // Another branch or a detached HEAD whose files are exactly those of a
    // base branch tip (a story branch right after its merge, a CI checkout of
    // the base) records the same state.
    const treeOf = (rev) => {
      const result = checkoutGit(context, ["rev-parse", "--verify", "--quiet", `${rev}^{tree}`]);
      return result.ok ? firstLine(result.stdout) : null;
    };
    const headTree = treeOf("HEAD");
    const atBase = Boolean(headTree) && bases
      .flatMap((base) => [`refs/heads/${base}`, `refs/remotes/${remote}/${base}`])
      .some((ref) => treeOf(ref) === headTree);
    baseCheck = atBase ? "at_base_tip" : "not_base_branch";
  }
  if (baseCheck === "not_base_branch") {
    if (options["allow-non-base-branch"] !== true) {
      const where = branch
        ? (italian ? `il branch attuale è ${branch}` : `the current branch is ${branch}`)
        : (italian ? `HEAD è staccato su ${commit.slice(0, 12)}` : `HEAD is detached at ${commit.slice(0, 12)}`);
      const baseList = bases.join(italian ? " o " : " or ");
      fail(italian
        ? `Il baseline ${previousId} non è stato aggiornato: ${where}, non il branch base ${baseList}. `
          + "Un aggiornamento registra lo stato del progetto da cui parte ogni story, quindi legge il branch base e non un branch di story non ancora integrato. "
          + `Passa al branch base (git switch ${bases[0]}), scarica gli aggiornamenti ed esegui di nuovo l’aggiornamento; usa --allow-non-base-branch solo se questo checkout è davvero lo stato del progetto da registrare. Non è stato scritto nulla.`
        : `Baseline ${previousId} was not refreshed: ${where}, not the base branch ${baseList}. `
          + "A refresh records the project state every story starts from, so it reads the base branch, not a story branch that is not merged yet. "
          + `Switch to the base branch (git switch ${bases[0]}), pull, and run the refresh again; pass --allow-non-base-branch only if this checkout really is the project state to record. Nothing was written.`);
    }
    baseCheck = "overridden";
  }
  return {
    branch,
    commit,
    base_branches: bases,
    base_branch_check: baseCheck,
    uncommitted: uncommittedScopePaths(context, inputs),
  };
}

// Inside decorate: only uncommitted paths the two snapshots describe matter.
function assertRefreshWorkingTree(options, previousId, inspected, previousHashes, currentHashes) {
  if (!inspected) return null;
  const relevant = inspected.uncommitted
    .filter((sourcePath) => Object.hasOwn(previousHashes, sourcePath) || Object.hasOwn(currentHashes, sourcePath))
    .sort();
  let workingTree = "clean";
  if (relevant.length > 0) {
    if (options["allow-uncommitted-changes"] !== true) {
      const italian = humanGuidanceLocale(options) === "it";
      const listed = `${relevant.slice(0, 10).join(", ")}${relevant.length > 10 ? (italian ? ` e altri ${relevant.length - 10}` : ` and ${relevant.length - 10} more`) : ""}`;
      fail(italian
        ? `Il baseline ${previousId} non è stato aggiornato: ${relevant.length} file nel suo ambito hanno modifiche non salvate in un commit: ${listed}. `
          + "Lo stato registrato deve descrivere il lavoro consegnato: fai il commit e consegna queste modifiche (oppure annullale) ed esegui di nuovo l’aggiornamento; "
          + "usa --allow-uncommitted-changes solo per registrarle così come sono, per la revisione di una persona. Non è stato scritto nulla."
        : `Baseline ${previousId} was not refreshed: ${relevant.length} file(s) in its scope have changes that are not committed: ${listed}. `
          + "The recorded state must describe delivered work: commit and deliver these changes (or discard them) and run the refresh again; "
          + "pass --allow-uncommitted-changes only to record them as they are, for a person's review. Nothing was written.");
    }
    workingTree = "overridden";
  }
  return {
    branch: inspected.branch,
    commit: inspected.commit,
    base_branches: inspected.base_branches,
    base_branch_check: inspected.base_branch_check,
    working_tree: workingTree,
    ...(workingTree === "overridden" ? { uncommitted_paths: relevant } : {}),
  };
}

export function refreshBaseline(context, options) {
  ensureInitialized(context);
  const requestedId = normalizeId(requireOption(options, "from"));
  if (!fs.existsSync(baselinePathById(context, requestedId))) fail(`Baseline ${requestedId} does not exist.`);
  const previousId = latestBaselineInLine(context, requestedId);
  const previousPath = baselinePathById(context, previousId);
  const previous = readProjectJson(context, previousPath);
  if (previous.status !== "approved" || !latestApprovedRecordApproval(previous) || !isApprovedRecordFresh(previous)) {
    fail(
      `Baseline ${previousId}${previousId === requestedId ? "" : ` (the latest refresh of ${requestedId})`} is ${previous.status || "unapproved"}; `
      + "a refresh starts only from an approved baseline. "
      + `Review and approve ${previousId} first, then run the refresh again.`
      + (previousId !== requestedId && previous.refresh?.previous_baseline_ref?.id
        ? ` If ${previousId} should not replace its predecessor (for example it was recorded from a story branch), withdraw it: `
          + `agentic-sdlc baseline refresh withdraw --id ${previousId} --reason "<why>" --actor-type human --approval-source explicit-user --summary "<what the user confirmed>".`
        : ""),
    );
  }
  const inputs = refreshSourceInputs(context, previous);
  const inspected = inspectRefreshCheckout(context, options, previousId, inputs);
  const id = options.id
    ? normalizeId(String(options.id))
    : nextRefreshBaselineId(context, previousId, sharedWithdrawnSuccessorIds(context, previousId));
  if (fs.existsSync(baselinePathById(context, id))) {
    fail(`Baseline ${id} already exists; choose another --id. A refresh never replaces an existing baseline.`);
  }
  const previousApproval = latestApprovedRecordApproval(previous);
  const evidences = collectDeliveredWorkEvidence(context, previousId);
  const anchorRef = baselineRefreshAnchorRef(context, previous);
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
      // Files the previous snapshot hashed that Git now ignores are left out
      // of the new one; they are set aside, not reported as removals.
      const ignoredPaths = [...baselineIgnoredSourcePaths(context, previous)]
        .filter((sourcePath) =>
          Object.hasOwn(previous.source_hashes || {}, sourcePath)
          && !Object.hasOwn(baseline.source_hashes || {}, sourcePath))
        .sort();
      delta = computeBaselineDelta(
        refreshComparedHashes(previous.source_hashes, ignoredPaths),
        baseline.source_hashes || {},
      );
      if (baselineDeltaSize(delta) === 0) {
        fail(`Baseline ${previousId} still describes every file in its scope; nothing to refresh.`);
      }
      const checkout = assertRefreshWorkingTree(options, previousId, inspected, previous.source_hashes || {}, baseline.source_hashes || {});
      const { explanations, unexplained } = explainBaselineDelta(delta, baseline.source_hashes || {}, evidences, {
        since: String(previous.created_at || ""),
      });
      baseline.refresh = {
        schema: BASELINE_REFRESH_SCHEMA,
        previous_baseline_ref: {
          id: previous.id,
          path: toProjectPath(context, previousPath),
          approved_content_hash: previousApproval.approved_content_hash,
        },
        ...(anchorRef ? { anchor_baseline_ref: anchorRef } : {}),
        delta,
        ...(ignoredPaths.length > 0 ? { ignored_paths: ignoredPaths } : {}),
        explanations,
        unexplained,
        ...(checkout ? { checkout } : {}),
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
    baseline_id: id,
    baseline_path: toProjectPath(context, result.baseline_path),
    report_path: toProjectPath(context, result.report_path),
    previous_baseline_id: previousId,
    requested_from: requestedId,
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

/**
 * Records the withdrawal of a successor on the git remote: a create-only
 * record next to the successor claim of the same generation, which releases
 * that generation for the next refresh. The successor claim stays where it
 * is, so every computer still sees what was proposed and that it was
 * withdrawn.
 */
function shareBaselineRefreshWithdrawal(context, { previousId, successorId, refreshHash, reason, withdrawnBy }) {
  const { coordination, scope } = sharedRefreshScope(context);
  if (scope.scope === "local") return { scope: "local", found: false, note: scope.note };
  const unreachable = (reason) => fail(
    `Baseline ${successorId} was not withdrawn: ${reason}. Nothing was written; try again when the git remote is reachable.`,
  );
  if (scope.unavailable) unreachable(scope.unavailable);
  const read = () => readRefreshRecords(context, scope, coordination, previousId);
  const withdrawnHere = (claims) => claims.withdrawn.find((item) => item.successor.successor_id === successorId);
  const before = read();
  if (!before.available) unreachable(before.error);
  const claims = resolveBaselineRefreshClaims(before.records, previousId);
  const already = withdrawnHere(claims);
  if (already) {
    return { scope: "shared", found: true, already: true, ref: baselineRefreshWithdrawalRef(previousId, already.generation) };
  }
  if (claims.open?.payload.successor_id !== successorId) return { scope: "shared", found: false };
  // A successor with the same id but other content was claimed by another
  // computer: the one here is an orphan, and the remote claim is not ours to release.
  if (refreshHash && claims.open.payload.refresh_hash !== refreshHash) return { scope: "shared", found: false, orphan: true };
  const ref = baselineRefreshWithdrawalRef(previousId, claims.open.generation);
  const commit = writeRecordCommit(context, coordination.timeout_seconds, serializeSharedPayload(buildBaselineRefreshWithdrawalPayload({
    previousBaselineId: previousId,
    successorId,
    refreshHash: claims.open.payload.refresh_hash ?? null,
    generation: claims.open.generation,
    reason,
    withdrawnBy,
    withdrawnAt: now(),
  })));
  if (commit.error) unreachable(commit.error);
  const pushed = pushCreateOnlyRef(context, {
    url: scope.url,
    ref,
    objectName: commit.objectName,
    trackingRef: baselineRefreshTrackingRef(ref, scope.fingerprint),
    timeoutSeconds: coordination.timeout_seconds,
  });
  if (!pushed.pushed) {
    const after = read();
    if (!after.available || !withdrawnHere(resolveBaselineRefreshClaims(after.records, previousId))) unreachable(pushed.error);
  }
  return { scope: "shared", found: true, already: false, ref };
}

/**
 * Withdraws a refresh successor that was proposed and never approved: the
 * record stays as history with status `withdrawn`, who withdrew it and why,
 * and the shared successor claim is released so the predecessor can be
 * refreshed again. The predecessor becomes the current baseline again.
 */
export function withdrawBaselineRefresh(context, options) {
  ensureInitialized(context);
  const id = normalizeId(requireOption(options, "id"));
  const reasonOption = String(requireOption(options, "reason")).trim();
  if (!reasonOption) fail("--reason must explain why the refresh is withdrawn.");
  const fromOption = options.from ? normalizeId(String(options.from)) : null;
  const baselinePath = baselinePathById(context, id);
  const local = fs.existsSync(baselinePath) ? readProjectJson(context, baselinePath) : null;
  let previousId = fromOption;
  if (local) {
    const recordedPrevious = local.refresh?.previous_baseline_ref?.id;
    if (!recordedPrevious) {
      fail(`Baseline ${id} is not the successor of a refresh; only a refreshed baseline that is still proposed can be withdrawn.`);
    }
    if (fromOption && fromOption !== recordedPrevious) fail(`Baseline ${id} refreshes ${recordedPrevious}, not ${fromOption}.`);
    previousId = recordedPrevious;
    if (["approved", "provisionally_approved"].includes(local.status)) {
      fail(
        `Baseline ${id} is approved and is never withdrawn: work may already start from it. `
        + `Record the current state as its successor with baseline refresh --from ${id} instead.`,
      );
    }
  } else if (!previousId) {
    fail(
      `Baseline ${id} does not exist on this computer. To withdraw a successor recorded only on the git remote, `
      + "name the baseline it refreshes with --from <baseline-id>.",
    );
  }
  const alreadyWithdrawn = local?.status === "withdrawn";
  const refreshHash = local ? baselineRefreshHash(local) : null;
  const attribution = buildAttribution(context, options, "baseline.refresh.withdraw");
  let approval = local?.withdrawal?.approval || null;
  const reason = alreadyWithdrawn ? local.withdrawal?.reason || reasonOption : reasonOption;
  if (!alreadyWithdrawn) {
    if (!local && sharedRefreshScope(context).scope.scope === "local") {
      fail(`Baseline ${id} does not exist on this computer and refreshes are not shared through a git remote here; there is nothing to withdraw.`);
    }
    requireFormalApprovalActor(context, options, attribution, "Withdrawing a proposed baseline refresh");
    approval = buildApprovalRecord(context, options, attribution, {
      subject: { baseline_id: id, previous_baseline_id: previousId, refresh_hash: refreshHash, reason },
      subject_id_field: "baseline_id",
      subject_id: id,
      status: "approved",
      scope: "baseline-refresh-withdrawal",
      label: `baseline refresh withdrawal ${id}`,
    });
  }
  const withdrawer = alreadyWithdrawn ? local.withdrawal?.withdrawn_by || attribution.actor : attribution.actor;
  const shared = shareBaselineRefreshWithdrawal(context, {
    previousId,
    successorId: id,
    refreshHash,
    reason,
    withdrawnBy: { type: withdrawer?.type || null, id: withdrawer?.id || null },
  });
  if (!local && !shared.found) {
    fail(`The git remote records no open successor ${id} of baseline ${previousId}; nothing was withdrawn.`);
  }
  let baseline = local;
  const reportPath = path.join(path.dirname(baselinePath), `${id}-current-state.md`);
  if (local && !alreadyWithdrawn) {
    const releaseLock = acquireFileLock(`${baselinePath}.lock`);
    try {
      baseline = readProjectJson(context, baselinePath);
      if (baseline.status !== "withdrawn") {
        if (["approved", "provisionally_approved"].includes(baseline.status)) {
          fail(`Baseline ${id} was approved meanwhile and is never withdrawn.`);
        }
        baseline.withdrawal = {
          reason,
          previous_status: baseline.status,
          withdrawn_at: now(),
          withdrawn_by: attribution.actor,
          approval,
          shared_ref: shared.ref || null,
          git: attribution.git,
          run: attribution.run,
        };
        baseline.status = "withdrawn";
        baseline.updated_at = now();
        assertRecordSchema(baseline, "baseline.schema.json", `Baseline ${id}`);
        writeJsonFile(baselinePath, baseline, { force: true });
        writeTextFile(reportPath, renderBaselineReport(baseline), { force: true });
      }
    } finally {
      releaseLock();
    }
  }
  if (!alreadyWithdrawn) {
    appendTraceEvent(context, null, {
      type: "gate",
      summary: `Withdrew proposed baseline ${id}, the refresh of ${previousId}: ${reason}`,
      action: "baseline.refresh.withdraw",
      actor: attribution.actor,
      evidence: local ? [toProjectPath(context, baselinePath), toProjectPath(context, reportPath)] : [],
      related: [previousId, id],
      git: attribution.git,
      run: attribution.run,
    });
  }
  const italian = humanGuidanceLocale(options) === "it";
  const sharedLine = shared.scope === "shared" && shared.found
    ? (italian
      ? `Il remote git registra il ritiro (${shared.ref}); ${previousId} può essere aggiornato di nuovo da qualsiasi computer.`
      : `The git remote records the withdrawal (${shared.ref}); ${previousId} can be refreshed again from any computer.`)
    : shared.orphan
      ? (italian
        ? `Il remote git registra un altro ${id} per ${previousId}: quello di questo computer era orfano e il remote non è stato modificato.`
        : `The git remote records another ${id} for ${previousId}: the one on this computer was an orphan, and the remote was left unchanged.`)
      : (italian
        ? "Gli aggiornamenti non sono condivisi tramite un remote git: il ritiro vale per questo progetto."
        : "Refreshes are not shared through a git remote: the withdrawal applies to this project.");
  output(options, {
    status: "withdrawn",
    idempotent: alreadyWithdrawn,
    baseline_id: id,
    previous_baseline_id: previousId,
    baseline_path: local ? toProjectPath(context, baselinePath) : null,
    reason,
    shared: { scope: shared.scope, recorded: Boolean(shared.found), ref: shared.ref || null, orphan: Boolean(shared.orphan) },
    withdrawal: baseline?.withdrawal || null,
    next_commands: [`agentic-sdlc baseline refresh --from ${previousId}`],
  }, [
    italian
      ? `${alreadyWithdrawn ? "Già ritirato" : "Ritirato"}: il baseline proposto ${id} non sostituisce più ${previousId}, che torna a essere lo stato attuale del progetto.`
      : `${alreadyWithdrawn ? "Already withdrawn" : "Withdrawn"}: proposed baseline ${id} no longer replaces ${previousId}, which is the current project state again.`,
    sharedLine,
    italian
      ? `Dal branch base, registra di nuovo lo stato attuale con: agentic-sdlc baseline refresh --from ${previousId}`
      : `From the base branch, record the current state again with: agentic-sdlc baseline refresh --from ${previousId}`,
  ]);
}

const ANCHOR_APPROVAL_SOURCES = new Set(["explicit-user", "ci"]);

function approvalRef(baseline) {
  return { id: baseline.id, approved_content_hash: latestApprovedRecordApproval(baseline)?.approved_content_hash || null };
}

function anchorApprovalErrors(baseline) {
  const approval = latestApprovedRecordApproval(baseline);
  if (!approval || !isApprovedRecordFresh(baseline)) return [`baseline ${baseline.id} has no current approval`];
  if (approval.approval_source === "explicit-user") {
    return approval.approved_by?.type === "human" ? [] : [`baseline ${baseline.id} explicit-user approval has no human approver`];
  }
  if (approval.approval_source === "ci") {
    return approval.approved_by?.type === "ci" ? [] : [`baseline ${baseline.id} CI approval has no CI approver`];
  }
  return [`baseline ${baseline.id} approval source ${approval.approval_source || "missing"} cannot anchor a delivered-work refresh`];
}

function readBaselineIfPresent(context, id) {
  const filePath = baselinePathById(context, id);
  return fs.existsSync(filePath) ? readProjectJson(context, filePath) : null;
}

/**
 * The approval by a person or CI that a refresh line rests on: the baseline
 * itself when a person or CI approved it, otherwise the anchor its refresh
 * recorded. Refreshes written before anchors were recorded are followed back
 * through their predecessors once.
 */
export function baselineRefreshAnchorRef(context, baseline) {
  const visited = new Set();
  let current = baseline;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    const source = latestApprovedRecordApproval(current)?.approval_source;
    if (ANCHOR_APPROVAL_SOURCES.has(source)) return approvalRef(current);
    if (source !== DELIVERED_WORK_APPROVAL_SOURCE) return null;
    if (current.refresh?.anchor_baseline_ref?.id) return current.refresh.anchor_baseline_ref;
    const previousId = current.refresh?.previous_baseline_ref?.id;
    current = previousId ? readBaselineIfPresent(context, previousId) : null;
  }
  return null;
}

// The approval a delivered-work refresh rests on. Each refresh pins the
// approval hash of its predecessor and names the approval by a person or CI
// at the start of its line, so the check reads three records whatever the
// length of the line: the baseline, its predecessor, and that anchor. Every
// earlier refresh was verified in full while it was the active baseline.
export function deliveredWorkApprovalChainErrors(context, baseline) {
  const approval = latestApprovedRecordApproval(baseline);
  if (!approval || !isApprovedRecordFresh(baseline)) {
    return [`baseline ${baseline.id} has no current approval`];
  }
  if (ANCHOR_APPROVAL_SOURCES.has(approval.approval_source)) return anchorApprovalErrors(baseline);
  if (approval.approval_source !== DELIVERED_WORK_APPROVAL_SOURCE) {
    return anchorApprovalErrors(baseline);
  }
  const errors = [];
  if (approval.approved_by?.type !== "system" || approval.scope !== DELIVERED_WORK_APPROVAL_SCOPE) {
    errors.push(`baseline ${baseline.id} delivered-work approval must be a system approval with scope ${DELIVERED_WORK_APPROVAL_SCOPE}`);
  }
  const previousRef = baseline.refresh?.previous_baseline_ref;
  if (baseline.refresh?.schema !== BASELINE_REFRESH_SCHEMA || !previousRef?.id) {
    errors.push(`baseline ${baseline.id} has no baseline refresh record`);
    return errors;
  }
  const previous = readBaselineIfPresent(context, previousRef.id);
  if (!previous) {
    errors.push(`baseline ${baseline.id} references missing baseline ${previousRef.id}`);
    return errors;
  }
  if (latestApprovedRecordApproval(previous)?.approved_content_hash !== previousRef.approved_content_hash) {
    errors.push(`baseline ${baseline.id} no longer matches the approval of ${previous.id}`);
  }
  const anchorRef = baselineRefreshAnchorRef(context, baseline);
  if (!anchorRef?.id) {
    errors.push(`baseline ${baseline.id} rests on no approval by a person or CI`);
    return errors;
  }
  const expectedAnchor = baselineRefreshAnchorRef(context, previous);
  if (expectedAnchor?.id !== anchorRef.id || expectedAnchor?.approved_content_hash !== anchorRef.approved_content_hash) {
    errors.push(`baseline ${baseline.id} names anchor ${anchorRef.id}, but ${previous.id} rests on ${expectedAnchor?.id || "none"}`);
  }
  const anchor = readBaselineIfPresent(context, anchorRef.id);
  if (!anchor) {
    errors.push(`baseline ${baseline.id} rests on missing baseline ${anchorRef.id}`);
    return errors;
  }
  if (latestApprovedRecordApproval(anchor)?.approved_content_hash !== anchorRef.approved_content_hash) {
    errors.push(`baseline ${baseline.id} no longer matches the approval of its anchor ${anchor.id}`);
  }
  errors.push(...anchorApprovalErrors(anchor));
  return errors;
}

/**
 * Re-verify an approval recorded from delivered work. The records alone must
 * reproduce the delta and its attribution; Git content is compared whenever
 * the delivered commit is available in this clone.
 */
export function deliveredWorkBaselineApprovalErrors(context, baseline) {
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
  for (const error of deliveredWorkApprovalChainErrors(context, previous)) {
    errors.push(`${label} rests on an invalid approval: ${error}`);
  }
  const recordedAnchor = refresh.anchor_baseline_ref;
  if (recordedAnchor) {
    const expectedAnchor = baselineRefreshAnchorRef(context, previous);
    if (expectedAnchor?.id !== recordedAnchor.id || expectedAnchor?.approved_content_hash !== recordedAnchor.approved_content_hash) {
      errors.push(`${label} names anchor ${recordedAnchor.id}, but ${previous.id} rests on ${expectedAnchor?.id || "none"}`);
    }
  }
  const ignoredPaths = Array.isArray(refresh.ignored_paths) ? refresh.ignored_paths : [];
  if (ignoredPaths.some((sourcePath) =>
    !Object.hasOwn(previous.source_hashes || {}, sourcePath)
    || Object.hasOwn(baseline.source_hashes || {}, sourcePath))) {
    errors.push(`${label} sets aside ignored files that do not match the two snapshots`);
  }
  const delta = computeBaselineDelta(
    refreshComparedHashes(previous.source_hashes, ignoredPaths),
    baseline.source_hashes || {},
  );
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
    for (const contributor of item.also_changed_by || []) {
      const known = evidences.some((candidate) => (
        candidate.story_id === contributor.story_id
        && candidate.delivery_profile_id === contributor.delivery_profile_id
        && candidate.merge_commit_sha === contributor.merge_commit_sha
        && pathInsideEveryScope(item.path, candidate.write_scopes)
      ));
      if (!known) {
        errors.push(`${label} credits ${item.path} also to delivery ${contributor.delivery_profile_id}, which no longer proves it`);
      }
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
