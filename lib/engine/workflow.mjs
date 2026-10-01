import path from "node:path";
import {
  computeStableHash,
} from "../canonical.mjs";
import {
  UserError,
  fail,
} from "../cli/user-error.mjs";
import {
  assertMutationExecutionAuthorized,
  withGovernedMutation,
} from "../governance/mutation-guard.mjs";
import {
  autonomyApprovalsRoot,
  profileTaskStartReceiptSchemaName,
  requireFormalApprovalActor,
} from "../lifecycle/authorization.mjs";
import {
  buildDomainRecord,
  getOptionString,
  hashJsonFileValue,
  instanceDefinitionReference,
  instanceOverlayReference,
  normalizeId,
  referenceId,
  requireOption,
  stableJson,
} from "../lifecycle/common.mjs";
import {
  SDLC_DIR,
  WORKFLOW_FINAL_FRESHNESS_PROOF_SCHEMA,
  WORKFLOW_HUMAN_VALUE_LIMITS,
  WORKFLOW_WINDOWS_DIRECTORY_SYNC_UNSUPPORTED,
  workflowStartTraceIndexCache,
  workflowStartTransactionIndexCache,
} from "../lifecycle/constants.mjs";
import {
  deliveryAutonomyPath,
  deliveryExecutionRoot,
} from "../lifecycle/delivery.mjs";
import {
  humanGuidanceLines,
  humanGuidanceLocale,
} from "../lifecycle/guidance.mjs";
import {
  assertNoSymlinkPathSegments,
  assertPathInsideRoot,
  autonomyActionsRoot,
  autonomyDecisionsRoot,
  autonomyRevocationsRoot,
  isInsidePath,
  toProjectPath,
} from "../lifecycle/project.mjs";
import {
  configuredPhaseOrder,
  requirementAutonomyPath,
  requirementLifecycleRoot,
  requirementPath,
  storyLifecycleCertificationLockPath,
} from "../lifecycle/story.mjs";
import {
  assertStoryBoundWorkflowPhaseOrder,
  buildLegacyWorkflowStrictGateReceipt,
  buildWorkflowStartRequest,
  buildWorkflowStartTraceRecord,
  buildWorkflowStartTransaction,
  buildWorkflowTransitionJournal,
  buildWorkflowTransitionTraceRecord,
  callWorkflowDomain,
  compareWorkflowVersions,
  extendWorkflowTraceChain,
  failWorkflowHumanValue,
  humanizeWorkflowIdentifier,
  normalizeWorkflowVersion,
  parseWorkflowGuardContext,
  sealWorkflowFinalFreshnessGitScope,
  validateWorkflowDefinitionRecord,
  validateWorkflowOverlayRecord,
  workflowApprovalForDomain,
  workflowCheckpointPath,
  workflowCurrentState,
  workflowDefinitionPath,
  workflowDefinitionRef,
  workflowDefinitionSummary,
  workflowDefinitionUsesCanonicalEvidence,
  workflowDefinitionsRoot,
  workflowEventsPath,
  workflowFinalFreshnessRecordContains,
  workflowFinalFreshnessReferencedPaths,
  workflowFinalGateReceiptPath,
  workflowHumanAllSteps,
  workflowHumanDefinitionDetails,
  workflowHumanDisplayIdentifier,
  workflowHumanMainSequence,
  workflowHumanMetadataDifference,
  workflowHumanMetadataLabel,
  workflowHumanSafeValue,
  workflowHumanStateName,
  workflowIdempotentGuidance,
  workflowInstanceCreationLockPath,
  workflowInstancePath,
  workflowInstanceRoot,
  workflowInstanceStagingRoot,
  workflowInstanceStartTransactionPath,
  workflowInstanceStartTransactionsRoot,
  workflowInstancesRoot,
  workflowNextStates,
  workflowOverlayChanges,
  workflowOverlayPath,
  workflowOverlaysRoot,
  workflowPendingTransitionPath,
  workflowPhaseOrderDifference,
  workflowRequiresCurrentPhaseCompletion,
  workflowScopeFromRuntime,
  workflowStartRequestHash,
  workflowStartTransactionErrors,
  workflowStartTransactionHash,
  workflowStrictGateReceiptPath,
  workflowTraceAnchorErrors,
  workflowTraceIntentMatches,
  workflowTransitionJournalErrors,
  workflowTransitionUsesCanonicalEvidence,
  workflowTransitionUsesStrictGate,
  workflowVersionFromFileName,
} from "../lifecycle/workflow.mjs";
import {
  Date,
  crypto,
  fs,
  process,
} from "../runtime/host.mjs";
import {
  withTraceIntegritySnapshot,
} from "../trace-integrity.mjs";
import {
  CANONICAL_WORKFLOW_GUARD_CHECKS,
  WORKFLOW_CANONICAL_EVIDENCE_SCHEMA,
  WORKFLOW_LEGACY_CANONICAL_EVIDENCE_SCHEMA,
  buildLegacyWorkflowCanonicalEvidence,
  buildWorkflowCanonicalEvidence,
  buildWorkflowFinalGateReceipt,
  buildWorkflowStrictGateReceipt,
  hasValidWorkflowReceiptHash,
} from "../workflow-canonical-evidence.mjs";
import {
  applyWorkflowOverlay,
  approveWorkflowOverlay,
  buildWorkflowOverlay,
  createWorkflowCheckpoint,
  createWorkflowInstance,
  createWorkflowTransition,
  evaluateWorkflowGuards,
  replayWorkflowEvents,
  validateWorkflowCheckpoint,
  workflowCanonicalEvidenceSchema,
} from "../workflow-engine.mjs";
import {
  SOFTWARE_PROJECT_PHASES,
} from "../workflow-presets.mjs";
import {
  assessmentNextAction,
  readAssessmentWorkflow,
} from "./assessment.mjs";
import {
  buildApprovalRecord,
} from "./authorization.mjs";
import {
  assertRecordSchema,
  buildAttribution,
  now,
} from "./common.mjs";
import {
  NO_FOLLOW_FLAG,
} from "./definitions.mjs";
import {
  currentDeliveryExecutionState,
  readDeliveryAutonomyProfile,
  storyReleaseReadiness,
} from "./delivery.mjs";
import {
  captureWorkflowFinalFreshnessGitScope,
  workflowFinalFreshnessGitScopeMatches,
} from "./git.mjs";
import {
  statusCliCommand,
} from "./guidance.mjs";
import {
  captureDirectoryIdentity,
  ensureInitialized,
  loadEffectiveDefinitionForInstance,
  matchingApprovedStoryWorkflowDefinition,
  resolveWorkflowDefinitionForRuntime,
  workflowDefinitionForOverlay,
  workflowFinalFreshnessLocalRootIdentity,
} from "./migration.mjs";
import {
  currentCertifiedLifecycleEvidenceMatches,
  output,
  outputContractsRoot,
  outputRegistryPath,
  readOutputRegistry,
} from "./output.mjs";
import {
  resolveProjectFilePath,
  verifyOpenFileMatchesPath,
} from "./project.mjs";
import {
  acquireFileLock,
  blockWorkflowOnIntegrityFailure,
  completeWorkflowStartTransactionLocked,
  ensureWorkflowEventRecordLocked,
  ensureWorkflowTraceRecordLocked,
  inspectWorkflowTraceCoverageLocked,
  inspectWorkflowTraceOwnershipConflictsLocked,
  prepareGovernedTraceEvent,
  readProjectJson,
  readProjectText,
  readStableRegularFileBuffer,
  readStableRegularFileDigest,
  recoverWorkflowTraceIntegrityAtAnchorLocked,
  removeEmptyDirectoryGoverned,
  removePathGoverned,
  safeReadDir,
  walkFiles,
  workflowEventRecordStateLocked,
  workflowTraceRecordStateLocked,
  writeJsonFile,
  writeTextFile,
} from "./storage.mjs";
import {
  appendTraceEvent,
  assertStoryOpenForWork,
  currentStoryPhaseCompletionReadiness,
  currentStoryStrictGateReadiness,
  readContractById,
  readRequirement,
  readRequirementAutonomyProfile,
  readStory,
  readStoryStepRecords,
  traceIntegrityOptions,
  validateCurrentStrictStory,
} from "./story.mjs";

export function workflowFinalFreshnessFileRef(context, category, filePath) {
  const resolved = path.resolve(filePath);
  assertPathInsideRoot(context, resolved, filePath);
  if (!fs.existsSync(resolved)) {
    return {
      category,
      path: toProjectPath(context, resolved),
      present: false,
      file_type: "missing",
      mode: null,
      sha256: null,
    };
  }
  const snapshot = readStableRegularFileBuffer(resolved, context.root);
  return {
    category,
    path: toProjectPath(context, resolved),
    present: true,
    file_type: snapshot.file_type,
    mode: snapshot.mode,
    sha256: snapshot.sha256,
  };
}

export function workflowFinalFreshnessLocalPathSnapshot(rawPath) {
  const targetPath = path.resolve(String(rawPath));
  let stat;
  try {
    stat = fs.lstatSync(targetPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return {
      path: targetPath,
      present: false,
      kind: "missing",
      file_count: 0,
      entry_count: 0,
      total_bytes: 0,
      tree_hash: computeStableHash([]),
    };
  }
  if (stat.isSymbolicLink()) {
    fail(`Local release freshness target cannot be a symlink: ${targetPath}`);
  }
  const boundaryRoot = stat.isDirectory()
    ? targetPath
    : path.dirname(targetPath);
  const collectStructure = () => {
    const entries = [];
    const visit = (entryPath, relativePath) => {
      const entryStat = fs.lstatSync(entryPath);
      if (entryStat.isSymbolicLink()) {
        fail(`Local release freshness target contains a symlink: ${entryPath}`);
      }
      if (entryStat.isDirectory()) {
        entries.push({
          path: relativePath || ".",
          kind: "directory",
          mode: entryStat.mode & 0o7777,
          filePath: entryPath,
        });
        if (entries.length > 10_000) {
          fail(`Local release freshness target exceeds 10000 entries: ${targetPath}`);
        }
        const names = [];
        const directory = fs.opendirSync(entryPath);
        try {
          let child;
          while ((child = directory.readSync()) !== null) {
            names.push(child.name);
            if (entries.length + names.length > 10_000) {
              fail(`Local release freshness target exceeds 10000 entries: ${targetPath}`);
            }
          }
        } finally {
          directory.closeSync();
        }
        for (const name of names.sort()) {
          visit(
            path.join(entryPath, name),
            relativePath ? `${relativePath}/${name}` : name,
          );
        }
        return;
      }
      if (!entryStat.isFile()) {
        fail(`Local release freshness target contains a non-regular entry: ${entryPath}`);
      }
      entries.push({
        path: relativePath || path.basename(entryPath),
        kind: "regular",
        mode: entryStat.mode & 0o7777,
        filePath: entryPath,
      });
      if (entries.length > 10_000) {
        fail(`Local release freshness target exceeds 10000 entries: ${targetPath}`);
      }
    };
    visit(targetPath, "");
    return entries;
  };
  const snapshotOnce = () => {
    const structure = collectStructure();
    const entries = [];
    let totalBytes = 0;
    for (const entry of structure) {
      if (entry.kind === "directory") {
        entries.push({
          path: entry.path,
          kind: entry.kind,
          mode: entry.mode,
          size_bytes: null,
          sha256: null,
        });
        continue;
      }
      const remainingBytes = (512 * 1024 * 1024) - totalBytes;
      const snapshot = readStableRegularFileDigest(entry.filePath, boundaryRoot, remainingBytes);
      totalBytes += snapshot.size_bytes;
      if (totalBytes > 512 * 1024 * 1024) {
        fail(`Local release freshness target exceeds 512 MiB: ${targetPath}`);
      }
      entries.push({
        path: entry.path,
        kind: entry.kind,
        mode: snapshot.mode,
        size_bytes: snapshot.size_bytes,
        sha256: snapshot.sha256,
      });
    }
    return { entries, totalBytes };
  };
  const firstSnapshot = snapshotOnce();
  const secondSnapshot = snapshotOnce();
  if (stableJson(firstSnapshot) !== stableJson(secondSnapshot)) {
    fail(`Local release target changed while being snapshotted: ${targetPath}`);
  }
  return {
    path: targetPath,
    present: true,
    kind: stat.isDirectory() ? "directory" : "regular",
    file_count: firstSnapshot.entries
      .filter((entry) => entry.kind === "regular").length,
    entry_count: firstSnapshot.entries.length,
    total_bytes: firstSnapshot.totalBytes,
    tree_hash: computeStableHash(firstSnapshot.entries),
  };
}

// Git materializes tracked files with the checkout umask, so a commit on a
// branch followed by a checkout or merge rewrites governed records with other
// permission bits but identical content. Only the executable bit is portable;
// presence, type, and the exact content hash stay bound.
export function workflowFinalPortableFreshnessProjection(proof) {
  const { governed_files: governedFiles, ...rest } = proof || {};
  return {
    ...rest,
    governed_files: (Array.isArray(governedFiles) ? governedFiles : []).map((file) => ({
      ...file,
      mode: file?.file_type === "regular" && Number.isInteger(file.mode)
        ? ((file.mode & 0o100) !== 0 ? "executable" : "non-executable")
        : file?.mode ?? null,
    })),
  };
}

export function workflowFinalFreshnessProofMatches(context, certifiedProof, observedState) {
  if (
    certifiedProof?.schema_version !== WORKFLOW_FINAL_FRESHNESS_PROOF_SCHEMA
    || observedState?.schema_version !== WORKFLOW_FINAL_FRESHNESS_PROOF_SCHEMA
  ) {
    return false;
  }
  const {
    proof_hash: certifiedProofHash,
    git_scope: certifiedGitScope,
    ...certifiedNonGit
  } = certifiedProof;
  const {
    git_scope: observedGitScope,
    ...observedNonGit
  } = observedState;
  return (
    certifiedProofHash === computeStableHash({
      ...certifiedNonGit,
      git_scope: certifiedGitScope,
    })
    && stableJson(workflowFinalPortableFreshnessProjection(certifiedNonGit))
      === stableJson(workflowFinalPortableFreshnessProjection(observedNonGit))
    && workflowFinalFreshnessGitScopeMatches(
      context,
      certifiedGitScope,
      observedGitScope,
    )
  );
}

export function buildWorkflowFinalFreshnessProof(
  context,
  storyId,
  instanceId,
  certifiedProof = null,
) {
  const story = readStory(context, storyId);
  const contract = story?.contract_id
    ? readContractById(context, story.contract_id, { missingOk: true })
    : null;
  const requirementIds = [...new Set([
    ...(story?.links?.requirements || []),
    ...((contract?.requirement_refs || []).map((ref) => ref.id)),
  ].filter(Boolean))].sort();
  const requirements = requirementIds
    .map((id) => readRequirement(context, id, { missingOk: true }))
    .filter(Boolean);
  const requirementProfiles = requirements
    .map((requirement) => requirement.autonomy_profile_id)
    .filter(Boolean)
    .map((id) => readRequirementAutonomyProfile(context, id));
  const deliveryProfileId = contract?.delivery_execution_profile_id || null;
  const deliveryProfile = deliveryProfileId
    ? readDeliveryAutonomyProfile(context, deliveryProfileId)
    : null;
  const registry = readOutputRegistry(context, { missingOk: true });
  const storyLinks = (registry?.links || [])
    .filter((link) => link.story_id === storyId)
    .sort((left, right) => String(left.id).localeCompare(String(right.id), "en"));
  const templateIds = new Set([
    ...((contract?.output_contract_refs || []).map((ref) => ref.template_id)),
    ...storyLinks.map((link) => link.template_id),
  ].filter(Boolean));
  const linkDecisionIds = new Set(storyLinks.map((link) => link.decision_id).filter(Boolean));
  const templates = (registry?.templates || [])
    .filter((template) => templateIds.has(template.id))
    .sort((left, right) => String(left.id).localeCompare(String(right.id), "en"));
  const decisions = (registry?.decisions || [])
    .filter((decision) =>
      decision.story_id === storyId
      || templateIds.has(decision.template_id)
      || linkDecisionIds.has(decision.id))
    .sort((left, right) => String(left.id).localeCompare(String(right.id), "en"));
  const outputProjection = {
    schema_version: registry?.schema_version || null,
    project_id: registry?.project_id || null,
    templates,
    links: storyLinks,
    decisions,
  };
  const scopedIds = new Set([
    storyId,
    story?.contract_id,
    ...requirementIds,
    ...requirementProfiles.map((profile) => profile.id),
    deliveryProfileId,
    ...storyLinks.map((link) => link.id),
    ...templateIds,
  ].filter(Boolean));
  const files = new Map();
  const addFile = (category, filePath) => {
    const ref = workflowFinalFreshnessFileRef(context, category, filePath);
    files.set(`${category}:${ref.path}`, ref);
  };
  const addExistingProjectRef = (category, projectPath) => {
    if (!projectPath || !String(projectPath).startsWith(`${SDLC_DIR}/`)) return;
    const resolved = path.resolve(context.root, ...String(projectPath).split("/"));
    if (isInsidePath(context.root, resolved) && fs.existsSync(resolved)) {
      const stat = fs.lstatSync(resolved);
      if (stat.isDirectory()) {
        const snapshot = workflowFinalFreshnessLocalPathSnapshot(resolved);
        const ref = {
          category,
          path: toProjectPath(context, resolved),
          present: true,
          file_type: "directory",
          mode: stat.mode & 0o7777,
          sha256: snapshot.tree_hash,
        };
        files.set(`${category}:${ref.path}`, ref);
      } else {
        addFile(category, resolved);
      }
    }
  };

  for (const [category, filePath] of [
    ["project", path.join(context.sdlcRoot, "project.json")],
    ["config", path.join(context.sdlcRoot, "config.json")],
    ["config_lock", path.join(context.sdlcRoot, "config.lock.json")],
    ["contract", contract
      ? path.join(context.sdlcRoot, "contracts", `${contract.id}.json`)
      : path.join(context.sdlcRoot, "contracts", "missing.json")],
    ["story_trace", path.join(context.sdlcRoot, "traces", `${storyId}.jsonl`)],
    [
      "story_trace_checkpoint",
      path.join(
        context.sdlcRoot,
        "traces",
        ".integrity",
        `${storyId}.jsonl.checkpoint.json`,
      ),
    ],
    ["workflow_instance", workflowInstancePath(context, instanceId)],
    ["workflow_events", workflowEventsPath(context, instanceId)],
    ["workflow_checkpoint", workflowCheckpointPath(context, instanceId)],
  ]) {
    addFile(category, filePath);
  }
  const storyRoot = path.join(context.sdlcRoot, "stories", storyId);
  for (const filePath of walkFiles(storyRoot)) {
    if (
      filePath.endsWith(".lock")
      || path.basename(filePath).includes(".tmp")
    ) continue;
    addFile("story_record", filePath);
  }
  for (const requirement of requirements) {
    addFile("requirement", requirementPath(context, requirement.id));
  }
  for (const profile of requirementProfiles) {
    addFile("requirement_profile", requirementAutonomyPath(context, profile.id));
  }
  if (deliveryProfile) {
    addFile("delivery_profile", deliveryAutonomyPath(context, deliveryProfile.id));
    for (const filePath of walkFiles(deliveryExecutionRoot(context, deliveryProfile.id))) {
      if (!filePath.endsWith(".lock")) addFile("delivery_execution", filePath);
    }
  }
  for (const root of [
    requirementLifecycleRoot(context),
    autonomyApprovalsRoot(context),
    autonomyDecisionsRoot(context),
    autonomyRevocationsRoot(context),
    autonomyActionsRoot(context),
  ]) {
    for (const name of safeReadDir(root).filter((entry) => entry.endsWith(".json"))) {
      const filePath = path.join(root, name);
      const record = readProjectJson(context, filePath);
      if (workflowFinalFreshnessRecordContains(record, scopedIds)) {
        addFile("related_governance", filePath);
      }
    }
  }
  const instance = readProjectJson(context, workflowInstancePath(context, instanceId));
  addFile(
    "workflow_definition",
    path.join(
      workflowDefinitionsRoot(context),
      instance.definition_ref.id,
      `v${instance.definition_ref.version}.json`,
    ),
  );
  const referencedPaths = new Set();
  for (const record of [
    story,
    contract,
    ...requirements,
    ...requirementProfiles,
    deliveryProfile,
    ...storyLinks,
    ...templates,
    ...decisions,
  ]) {
    workflowFinalFreshnessReferencedPaths(record, referencedPaths);
  }
  for (const link of storyLinks) {
    for (const projectPath of [
      link.artifact_path,
      link.base_artifact,
      link.verification_receipt_ref?.path,
      ...(link.source_paths || []),
    ]) {
      if (!projectPath) continue;
      const resolved = path.resolve(context.root, ...String(projectPath).split("/"));
      if (isInsidePath(context.root, resolved) && fs.existsSync(resolved)) {
        addFile("output_source", resolved);
      }
    }
  }
  for (const projectPath of referencedPaths) {
    addExistingProjectRef("referenced_governance", projectPath);
  }
  for (const name of safeReadDir(path.join(context.sdlcRoot, "tests"))) {
    if (name.startsWith(`${storyId}-`) && name.endsWith(".json")) {
      addFile("story_test_record", path.join(context.sdlcRoot, "tests", name));
    }
  }
  const governedFiles = [...files.values()]
    .sort((left, right) =>
      left.category.localeCompare(right.category, "en")
      || left.path.localeCompare(right.path, "en"));
  const localReleasePaths = deliveryProfile?.delivery_kind === "local_release"
    ? [...new Set(
        (deliveryProfile.local_release_target?.allowed_write_paths || [])
          .filter(Boolean)
          .map((item) => path.resolve(String(item))),
      )].sort()
    : [];
  const certifiedPaths = (certifiedProof?.git_scope?.scoped_changes || [])
    .map((entry) => entry.path);
  const gitObservation = captureWorkflowFinalFreshnessGitScope(
    context,
    storyId,
    requirementProfiles,
    {
      certifiedPaths,
      historyBoundarySha:
        certifiedProof?.git_scope?.certification_head_sha || null,
    },
  );
  const subject = {
    schema_version: WORKFLOW_FINAL_FRESHNESS_PROOF_SCHEMA,
    story_id: storyId,
    workflow_instance_id: instanceId,
    governed_files: governedFiles,
    output_registry_projection: {
      path: `${toProjectPath(context, outputRegistryPath(context))}#story=${storyId}`,
      sha256: computeStableHash(outputProjection),
    },
    local_release_root: deliveryProfile?.delivery_kind === "local_release"
      ? workflowFinalFreshnessLocalRootIdentity(
          deliveryProfile.local_release_target.root_path,
        )
      : null,
    local_release_scope: localReleasePaths
      .map((targetPath) => workflowFinalFreshnessLocalPathSnapshot(targetPath)),
    git_scope: certifiedProof
      ? gitObservation
      : sealWorkflowFinalFreshnessGitScope(gitObservation),
    hash_algorithm: "sha256:stable-json:v1",
  };
  if (certifiedProof) {
    return subject;
  }
  return {
    ...subject,
    proof_hash: computeStableHash(subject),
  };
}

export function sealWorkflowFinalGateReceipt(context, report) {
  const filePath = workflowFinalGateReceiptPath(context, report.story_id);
  const receipt = buildWorkflowFinalGateReceipt(report, {
    final_receipt_path: toProjectPath(context, filePath),
  });
  assertRecordSchema(
    receipt,
    "workflow-final-gate-receipt.schema.json",
    `Final workflow gate receipt ${report.story_id}`,
  );
  return receipt;
}

export function persistWorkflowFinalGateReceipt(context, report) {
  const storyId = normalizeId(report.story_id);
  const storyDir = path.join(context.sdlcRoot, "stories", storyId);
  const claimPath = path.join(storyDir, "claim.json");
  const releaseLifecycleLock = acquireFileLock(
    storyLifecycleCertificationLockPath(context, storyId),
  );
  let releaseClaimLock = () => {};
  let releaseOutputRegistryLock = () => {};
  try {
    releaseClaimLock = acquireFileLock(path.join(storyDir, "claim.lock"));
    releaseOutputRegistryLock = acquireFileLock(
      path.join(outputContractsRoot(context), "registry.lock"),
    );
    if (fs.existsSync(claimPath)) {
      const claim = readProjectJson(context, claimPath);
      if (claim.status === "active") {
        fail(
          `Story ${storyId} has an active claim by ${claim.agent || "an unknown agent"}. `
          + "Release the claim before final lifecycle certification.",
        );
      }
    }
    const freshness = {
      status: "passed",
      strict: true,
      scope: "story",
      lifecycle_complete: true,
      story_id: storyId,
      errors: [],
      warnings: [],
      checked: [],
    };
    validateCurrentStrictStory(
      context,
      storyId,
      freshness,
      { includeProject: true },
    );
    if (freshness.errors.length > 0 || !freshness.lifecycle_workflow) {
      fail(
        `Story ${storyId} changed while final lifecycle certification was being prepared: `
        + `${freshness.errors.join("; ") || "current lifecycle proof is unavailable"}. `
        + "Resolve the current evidence and run the final gate again.",
      );
    }
    report.lifecycle_workflow = freshness.lifecycle_workflow;
    report.checked_at = now();
    report.freshness_proof = buildWorkflowFinalFreshnessProof(
      context,
      storyId,
      freshness.lifecycle_workflow.instance_id,
    );
    const receipt = sealWorkflowFinalGateReceipt(context, report);
    writeWorkflowJsonDurably(
      workflowFinalGateReceiptPath(context, storyId),
      receipt,
      { force: true },
    );
    return receipt;
  } finally {
    releaseOutputRegistryLock();
    releaseClaimLock();
    releaseLifecycleLock();
  }
}

export function sealWorkflowStrictGateReceipt(context, report) {
  const filePath = workflowStrictGateReceiptPath(context, report.story_id);
  const strictReceiptPath = toProjectPath(context, filePath);
  const receipt = report.workflow_scope
    ? buildWorkflowStrictGateReceipt(report, {
        strict_receipt_path: strictReceiptPath,
      })
    : buildLegacyWorkflowStrictGateReceipt(report, strictReceiptPath);
  assertRecordSchema(
    receipt,
    "workflow-strict-gate-receipt.schema.json",
    `Intermediate workflow gate receipt ${report.story_id}`,
  );
  return receipt;
}

export function listVersionedWorkflowRecords(context, rootPath) {
  const records = [];
  for (const id of safeReadDir(rootPath).sort((left, right) => left.localeCompare(right, "en"))) {
    const idPath = path.join(rootPath, id);
    if (!fs.statSync(idPath).isDirectory()) continue;
    for (const fileName of safeReadDir(idPath)) {
      const version = workflowVersionFromFileName(fileName);
      if (!version) continue;
      const filePath = path.join(idPath, fileName);
      if (!fs.statSync(filePath).isFile()) continue;
      records.push({ id, version, path: filePath, record: readProjectJson(context, filePath) });
    }
  }
  return records.sort((left, right) =>
    left.id.localeCompare(right.id, "en") || compareWorkflowVersions(left.version, right.version));
}

export function resolveWorkflowRecord(context, { kind, id, version = null }) {
  const rootPath = kind === "definition" ? workflowDefinitionsRoot(context) : workflowOverlaysRoot(context);
  const normalizedId = normalizeId(id);
  if (version) {
    const filePath = kind === "definition"
      ? workflowDefinitionPath(context, normalizedId, version)
      : workflowOverlayPath(context, normalizedId, version);
    if (!fs.existsSync(filePath)) fail(`Workflow ${kind} ${normalizedId} version ${version} does not exist.`);
    return { id: normalizedId, version: String(version), path: filePath, record: readProjectJson(context, filePath) };
  }
  const candidates = listVersionedWorkflowRecords(context, rootPath).filter((entry) => entry.id === normalizedId);
  if (candidates.length === 0) fail(`Workflow ${kind} ${normalizedId} does not exist.`);
  return candidates.sort((left, right) => compareWorkflowVersions(left.version, right.version)).at(-1);
}

export function parseWorkflowJsonInput(context, options, { fileOption, jsonOption, label }) {
  const fileValue = getOptionString(options, fileOption);
  const jsonValue = getOptionString(options, jsonOption);
  if (Boolean(fileValue) === Boolean(jsonValue)) {
    fail(`${label} needs exactly one of --${fileOption} or --${jsonOption}.`);
  }
  try {
    if (jsonValue) return JSON.parse(jsonValue);
    const filePath = resolveProjectFilePath(context, fileValue, { mustExist: true, fileOnly: true });
    return JSON.parse(readProjectText(context, filePath));
  } catch (error) {
    if (error instanceof UserError) throw error;
    fail(`Unable to read ${label} JSON: ${error.message}`);
  }
}

export function workflowGuidance(options, kind, settings = {}) {
  const italian = humanGuidanceLocale(options) === "it";
  const copy = {
    listed: italian
      ? ["I modi di lavorare disponibili sono stati raccolti.", "Puoi confrontarli prima di scegliere quale usare.", "Non devi decidere nulla finché non vuoi avviare o approvare un nuovo modo di lavorare.", "La consultazione non modifica file, attività in corso o permessi.", "Consulta i dettagli e scegli una voce solo quando serve."]
      : ["The available ways of working have been collected.", "You can compare them before choosing which one to use.", "You do not need to decide anything until you want to start or approve a new way of working.", "This view changes no files, active work, or permissions.", "Review the details and choose an entry only when needed."],
    shown: italian
      ? ["Il modo di lavorare richiesto è stato descritto.", "Puoi vedere passaggi, controlli e stato della versione.", "L’eventuale decisione necessaria è indicata nel riepilogo.", "La consultazione non modifica esecuzioni attive né concede nuovi permessi.", "Segui il prossimo passo indicato per lo stato mostrato."]
      : ["The requested way of working has been described.", "You can review its steps, checks, and version status.", "Any decision required is stated in the summary.", "This view changes no active run and grants no new permission.", "Follow the next step shown for the current status."],
    shown_proposed: italian
      ? ["È stata descritta una proposta di modo di lavorare.", "Resta inattiva finché non viene confermata.", "Decidi se confermare i passaggi e i controlli mostrati oppure chiedere una correzione.", "La consultazione non modifica esecuzioni attive e la conferma non concede permessi di consegna.", "Approva questa versione soltanto se il riepilogo è corretto; altrimenti indica cosa cambiare."]
      : ["A proposed way of working has been described.", "It remains inactive until it is confirmed.", "Decide whether to confirm the displayed steps and checks or request a correction.", "This view changes no active run, and confirmation grants no delivery permission.", "Approve this version only if the summary is correct; otherwise state what should change."],
    shown_approved: italian
      ? ["È stato descritto un modo di lavorare già confermato.", "Può essere scelto per una nuova esecuzione.", "Questa consultazione non richiede alcuna decisione.", "Non modifica esecuzioni attive e non concede nuovi permessi.", "Se è adatto, usalo quando avvii una nuova esecuzione."]
      : ["An already confirmed way of working has been described.", "It can be selected for a new run.", "This view requires no decision.", "It changes no active run and grants no new permission.", "If it fits, select it when starting a new run."],
    proposed: italian
      ? ["È pronta una proposta di modo di lavorare.", "Resta inattiva finché non viene confermata; nessuna attività esistente cambia.", "Conferma soltanto se passaggi, controlli e limiti mostrati sono corretti, altrimenti chiedi una modifica.", "La conferma vale solo per questa versione e non autorizza lavoro, merge, rilasci o accessi esterni.", "Esamina il riepilogo e approva o correggi la proposta."]
      : ["A proposed way of working is ready for review.", "It remains inactive until confirmed, and no existing work changes.", "Confirm only if the displayed steps, checks, and limits are correct; otherwise request a change.", "Confirmation applies only to this version and does not authorize work, merges, releases, or external access.", "Review the summary, then approve or correct the proposal."],
    approved: italian
      ? ["Il modo di lavorare proposto è stato confermato.", "Questa versione può essere scelta per nuove esecuzioni.", "Non devi decidere altro per questa conferma.", "Le esecuzioni già avviate restano invariate e ogni consegna conserva i propri limiti e permessi.", "Puoi avviare una nuova esecuzione quando serve."]
      : ["The proposed way of working has been confirmed.", "This version can now be selected for new runs.", "No further decision is needed for this confirmation.", "Existing runs stay unchanged, and every delivery keeps its own limits and permissions.", "You can start a new run when needed."],
    overlay_proposed: italian
      ? ["È pronto un adattamento del modo di lavorare per questo progetto.", "Resta inattivo finché non viene confermato e non cambia le esecuzioni già avviate.", "Conferma soltanto se le differenze mostrate sono volute, altrimenti chiedi una correzione.", "Non può riscrivere la cronologia, cambiare i passaggi fondamentali o ampliare i permessi.", "Esamina le differenze e approva o correggi l’adattamento."]
      : ["A project-specific adjustment is ready for review.", "It remains inactive until confirmed and does not change runs already started.", "Confirm only if the displayed differences are intended; otherwise request a correction.", "It cannot rewrite history, change the fundamental steps, or widen permissions.", "Review the differences, then approve or correct the adjustment."],
    overlay_explained: italian
      ? ["Le differenze introdotte dall’adattamento sono state raccolte.", "Puoi capire cosa vedranno le nuove esecuzioni prima di usarlo.", "Questa consultazione non richiede una decisione.", "Le esecuzioni già attive, la loro cronologia e i permessi restano invariati.", "Se le differenze sono corrette, usa l’adattamento solo per una nuova esecuzione."]
      : ["The differences introduced by the adjustment have been collected.", "You can see what new runs would use before selecting it.", "This view needs no decision.", "Active runs, their history, and permissions remain unchanged.", "If the differences are right, select the adjustment only for a new run."],
    started: italian
      ? ["È iniziata una nuova esecuzione tracciata.", "Seguirà la versione esatta scelta anche se il modello generale cambierà in futuro.", "Non devi decidere altro finché non raggiunge un passaggio che richiede una scelta.", "L’avvio non concede permessi per modifiche, merge, rilasci o accessi esterni.", "Continua con il prossimo passaggio consentito quando sei pronto."]
      : ["A new tracked run has started.", "It will keep using the exact selected version even if the general model changes later.", "No further decision is needed until it reaches a step that requires one.", "Starting the run grants no permission for changes, merges, releases, or external access.", "Continue with the next permitted step when ready."],
    transitioned: italian
      ? ["L’esecuzione è passata al passo successivo consentito.", "La cronologia è stata estesa senza modificare gli eventi precedenti.", "Non devi decidere altro salvo quanto richiesto dal nuovo passo.", "Il passaggio non amplia i permessi né autorizza azioni esterne.", "Controlla lo stato aggiornato e continua solo con un passaggio consentito."]
      : ["The run moved to the next permitted step.", "Its history was extended without changing earlier events.", "No further decision is needed unless the new step asks for one.", "The transition does not widen permissions or authorize external actions.", "Review the updated status and continue only with a permitted step."],
    instance_shown: italian
      ? ["Lo stato dell’esecuzione è stato ricostruito dalla sua cronologia.", "Puoi vedere dove si trova e quali passaggi sono disponibili.", "Questa consultazione non richiede una decisione.", "La cronologia e i permessi non sono stati modificati.", "Scegli un passaggio successivo solo tra quelli consentiti."]
      : ["The run status was reconstructed from its recorded history.", "You can see where it is and which next steps are available.", "This view needs no decision.", "Its history and permissions were not changed.", "Choose a next step only from those permitted."],
  };
  const [result, impact, required_decision, protection_boundary, next_action] = copy[kind] || copy.shown;
  return { result, impact, required_decision, protection_boundary, next_action, details: settings };
}

export function outputWorkflowResult(options, payload, kind, details = [], summaryLines = []) {
  output(options, payload, humanGuidanceLines(workflowGuidance(options, kind), details, options, summaryLines));
}

export function describeWorkflowGuard(guard, italian) {
  const parameters = guard?.parameters || {};
  workflowHumanDisplayIdentifier(guard?.id, "guard_id", italian);
  if (guard?.id === "always") return null;
  if (guard?.id === "checkpoint-approved") {
    const review = workflowHumanDisplayIdentifier(parameters.checkpoint, "checkpoint", italian);
    return italian
      ? `deve essere confermata la revisione ${review || "prevista"}`
      : `the ${review || "required"} review must be confirmed`;
  }
  if (guard?.id === "context-equals") {
    const subject = parameters.key
      ? workflowHumanMetadataLabel(parameters.key, italian)
      : (italian ? "il dato richiesto" : "the required information");
    const expected = workflowHumanSafeValue(parameters.value, italian, { key: parameters.key || "value" });
    return italian ? `${subject} deve essere ${expected}` : `${subject} must be ${expected}`;
  }
  if (guard?.id === "context-present") {
    const subject = parameters.key
      ? workflowHumanMetadataLabel(parameters.key, italian)
      : (italian ? "il dato richiesto" : "the required information");
    return italian ? `${subject} deve essere disponibile` : `${subject} must be provided`;
  }
  const canonicalDescriptions = {
    "requirement-approved": italian
      ? "il requisito collegato deve risultare approvato e ancora invariato"
      : "the linked requirement must be approved and still unchanged",
    "contract-approved": italian
      ? "l’incarico di lavoro collegato deve risultare approvato e ancora invariato"
      : "the linked work contract must be approved and still unchanged",
    "required-output-linked": italian
      ? "ogni risultato dovuto entro la fase corrente deve essere collegato e verificato"
      : "every output due through the current phase must be linked and verified",
    "strict-gate-passed": italian
      ? "il controllo rigoroso intermedio, legato alla fase corrente della story, deve essere superato"
      : "the story’s phase-bound intermediate strict check must have passed",
    "delivery-terminal": italian
      ? "la consegna esatta deve essere terminata con successo"
      : "the exact delivery must have completed successfully",
  };
  if (canonicalDescriptions[guard?.id]) return canonicalDescriptions[guard.id];
  return italian ? "deve essere soddisfatta la condizione di sicurezza configurata" : "the configured safety condition must be satisfied";
}

export function workflowHumanConditionSentences(definition, italian) {
  return (Array.isArray(definition?.transitions) ? definition.transitions : []).flatMap((transition) => {
    const conditions = (Array.isArray(transition?.guards) ? transition.guards : [])
      .map((guard) => describeWorkflowGuard(guard, italian))
      .filter(Boolean);
    if (conditions.length === 0) return [];
    const from = workflowHumanStateName(definition, transition.from, italian);
    const to = workflowHumanStateName(definition, transition.to, italian);
    return [italian
      ? `Per passare da ${from} a ${to}, ${conditions.join(" e ")}`
      : `To move from ${from} to ${to}, ${conditions.join(" and ")}`];
  });
}

export function workflowHumanAllRoutes(definition, italian) {
  return (definition?.transitions ?? []).map((transition) => {
    workflowHumanDisplayIdentifier(transition.id, "transition_id", italian);
    const from = workflowHumanStateName(definition, transition.from, italian);
    const to = workflowHumanStateName(definition, transition.to, italian);
    const defaultLabel = `${humanizeWorkflowIdentifier(transition.from)} to ${humanizeWorkflowIdentifier(transition.to)}`;
    const label = italian && transition.label === defaultLabel
      ? "collegamento previsto"
      : workflowHumanSafeValue(transition.label, italian, { key: "transition_label" });
    const conditions = (transition.guards ?? [])
      .map((guard) => describeWorkflowGuard(guard, italian))
      .filter(Boolean);
    const rule = conditions.length > 0
      ? conditions.join(italian ? " e " : " and ")
      : (italian ? "non richiede condizioni aggiuntive" : "requires no additional condition");
    return `${from} → ${to} (${label}): ${rule}`;
  });
}

export function workflowHumanOverlayDifferences(definition, overlay, effective, italian) {
  const differences = [];
  const baseLabel = definition?.label ?? definition?.name ?? definition?.title;
  if (overlay?.label && overlay.label !== baseLabel) {
    const before = workflowHumanSafeValue(baseLabel, italian, { key: "label" });
    const after = workflowHumanSafeValue(overlay.label, italian, { key: "label" });
    differences.push(italian
      ? `il nome mostrato cambia da ${before} a ${after}`
      : `the displayed name changes from ${before} to ${after}`);
  }
  if (overlay?.description && overlay.description !== definition?.description) {
    const after = workflowHumanSafeValue(overlay.description, italian, { key: "description" });
    if (definition?.description) {
      const before = workflowHumanSafeValue(definition.description, italian, { key: "description" });
      differences.push(italian
        ? `la descrizione mostrata cambia da ${before} a ${after}`
        : `the displayed description changes from ${before} to ${after}`);
    } else {
      differences.push(italian ? `la descrizione mostrata diventa ${after}` : `the displayed description becomes ${after}`);
    }
  }
  for (const override of overlay?.state_overrides ?? []) {
    const baseState = (definition?.states ?? []).find((entry) => entry.id === override.state_id);
    const effectiveState = (effective?.states ?? []).find((entry) => entry.id === override.state_id);
    const before = workflowHumanStateName(definition, override.state_id, italian);
    const after = workflowHumanStateName(effective, override.state_id, italian);
    if (override.label && before !== after) {
      differences.push(italian
        ? `il passaggio “${before}” viene mostrato come “${after}”`
        : `the “${before}” step is shown as “${after}”`);
    }
    if (override.metadata && Object.keys(override.metadata).length > 0) {
      const difference = workflowHumanMetadataDifference(
        italian ? `informazioni del passaggio “${after || before}”` : `information for the “${after || before}” step`,
        baseState?.metadata,
        effectiveState?.metadata,
        override.metadata,
        italian,
      );
      if (difference) differences.push(difference);
    }
  }
  for (const override of overlay?.transition_overrides ?? []) {
    const baseTransition = (definition?.transitions ?? []).find((entry) => entry.id === override.transition_id);
    const effectiveTransition = (effective?.transitions ?? []).find((entry) => entry.id === override.transition_id);
    const from = workflowHumanStateName(effective, baseTransition?.from, italian);
    const to = workflowHumanStateName(effective, baseTransition?.to, italian);
    if (override.label && override.label !== baseTransition?.label) {
      const label = workflowHumanSafeValue(override.label, italian, { key: "transition_label" });
      differences.push(italian
        ? `il collegamento da “${from}” a “${to}” viene mostrato come ${label}`
        : `the route from “${from}” to “${to}” is shown as ${label}`);
    }
    if ((override.guard_parameters ?? []).length > 0) {
      const conditions = (effectiveTransition?.guards ?? [])
        .map((guard) => describeWorkflowGuard(guard, italian))
        .filter(Boolean);
      differences.push(italian
        ? `per passare da “${from}” a “${to}”, ${conditions.join(" e ") || "si applica la condizione concordata"}`
        : `to move from “${from}” to “${to}”, ${conditions.join(" and ") || "the agreed condition must be met"}`);
    }
    if (override.metadata && Object.keys(override.metadata).length > 0) {
      const difference = workflowHumanMetadataDifference(
        italian ? `informazioni del collegamento da “${from}” a “${to}”` : `information for the route from “${from}” to “${to}”`,
        baseTransition?.metadata,
        effectiveTransition?.metadata,
        override.metadata,
        italian,
      );
      if (difference) differences.push(difference);
    }
  }
  if (overlay?.metadata && Object.keys(overlay.metadata).length > 0) {
    const difference = workflowHumanMetadataDifference(
      italian ? "informazioni generali" : "general information",
      definition?.metadata,
      effective?.metadata,
      overlay.metadata,
      italian,
    );
    if (difference) differences.push(difference);
  }
  if (differences.join("; ").length > WORKFLOW_HUMAN_VALUE_LIMITS.renderedCharacters) {
    failWorkflowHumanValue(italian
      ? `il riepilogo supera ${WORKFLOW_HUMAN_VALUE_LIMITS.renderedCharacters} caratteri`
      : `the review summary exceeds ${WORKFLOW_HUMAN_VALUE_LIMITS.renderedCharacters} characters`, italian);
  }
  return differences;
}

export function workflowHumanReviewLines(
  definition,
  options,
  { overlay = null, effective = definition, requiresConfirmation = true } = {},
) {
  const italian = humanGuidanceLocale(options) === "it";
  const sequence = workflowHumanMainSequence(effective, italian);
  const initial = workflowHumanStateName(effective, effective?.initial_state, italian);
  const allSteps = workflowHumanAllSteps(effective, italian);
  const allRoutes = workflowHumanAllRoutes(effective, italian);
  const conditions = workflowHumanConditionSentences(effective, italian);
  const reviews = (effective?.normal_checkpoints ?? [])
    .map((checkpoint) => workflowHumanDisplayIdentifier(checkpoint, "checkpoint", italian))
    .filter(Boolean);
  const differences = overlay ? workflowHumanOverlayDifferences(definition, overlay, effective, italian) : [];
  const descriptiveDetails = overlay ? [] : workflowHumanDefinitionDetails(effective, italian);
  const lines = [
    `${italian ? "Percorso principale" : "Main sequence"}: ${sequence.join(" → ") || (italian ? "nessun passaggio definito" : "no steps defined")}.`,
    `${italian ? "Punto di partenza" : "Starting point"}: ${initial || (italian ? "non definito" : "not defined")}.`,
    `${italian ? "Tutti i passaggi" : "All steps"}: ${allSteps.join("; ") || (italian ? "nessuno" : "none")}.`,
    `${italian ? "Tutti i collegamenti consentiti" : "All allowed routes"}: ${allRoutes.join("; ") || (italian ? "nessuno" : "none")}.`,
    `${italian ? "Controlli e condizioni" : "Checks and conditions"}: ${conditions.length > 0
      ? `${conditions.join("; ")}.`
      : (italian ? "non sono richieste condizioni aggiuntive tra i passaggi elencati." : "no additional conditions are required between the listed steps.")}`,
    `${italian ? "Momenti ordinari di conferma" : "Usual review moments"}: ${reviews.length > 0
      ? `${reviews.join(", ")}.`
      : (italian ? "questo processo non ne prevede." : "this process defines none.")}`,
    ...(!overlay ? [`${requiresConfirmation
      ? (italian ? "Contenuto descrittivo da confermare" : "Descriptive content to confirm")
      : (italian ? "Contenuto descrittivo" : "Descriptive content")}: ${descriptiveDetails.length > 0
      ? `${descriptiveDetails.join("; ")}.`
      : (italian ? "non sono presenti altre informazioni descrittive." : "there is no additional descriptive information.")}`] : []),
    ...(overlay ? [`${italian ? "Cosa cambia con questo adattamento" : "What this adjustment changes"}: ${differences.length > 0
      ? `${differences.join("; ")}.`
      : (italian ? "non cambia testi, condizioni o informazioni descrittive." : "it changes no wording, conditions, or descriptive information.")}`] : []),
  ];
  if (lines.join("\n").length > WORKFLOW_HUMAN_VALUE_LIMITS.renderedCharacters) {
    failWorkflowHumanValue(italian
      ? `il riepilogo supera ${WORKFLOW_HUMAN_VALUE_LIMITS.renderedCharacters} caratteri`
      : `the review summary exceeds ${WORKFLOW_HUMAN_VALUE_LIMITS.renderedCharacters} characters`, italian);
  }
  return lines;
}

export function proposeWorkflowOverlay(context, options) {
  ensureInitialized(context);
  const id = normalizeId(requireOption(options, "id"));
  const version = normalizeWorkflowVersion(requireOption(options, "overlay-version"), "overlay-version");
  const definitionId = normalizeId(requireOption(options, "definition"));
  const definitionVersion = normalizeWorkflowVersion(requireOption(options, "definition-version"), "definition-version");
  const definitionEntry = resolveWorkflowDefinitionForRuntime(context, definitionId, definitionVersion);
  const definition = definitionEntry.record;
  if (definition.status !== "approved") {
    fail(`Workflow definition ${definitionId} version ${definitionVersion} must be approved before proposing an adjustment.`);
  }
  validateWorkflowDefinitionRecord(definition, `workflow definition ${definitionId}`);
  const custom = parseWorkflowJsonInput(context, options, {
    fileOption: "overlay-file",
    jsonOption: "overlay-json",
    label: "workflow overlay",
  });
  if (!custom || typeof custom !== "object" || Array.isArray(custom)) fail("Workflow overlay JSON must be an object.");
  const summary = getOptionString(options, "summary");
  const input = {
    ...custom,
    id,
    version: Number(version),
    status: "proposed",
    definition_ref: workflowDefinitionRef(definition),
    created_at: custom.created_at || now(),
    ...(summary && !custom.description ? { description: summary } : {}),
  };
  const overlay = callWorkflowDomain("Unable to prepare workflow overlay", () =>
    buildWorkflowOverlay(input, { definition }));
  validateWorkflowOverlayRecord(overlay, definition, `workflow overlay ${id}`);
  const effective = callWorkflowDomain("Unable to calculate the adjusted way of working", () =>
    applyWorkflowOverlay(definition, overlay, { allow_proposed: true }));
  const reviewLines = workflowHumanReviewLines(definition, options, { overlay, effective });
  assertRecordSchema(overlay, "workflow-overlay.schema.json", `Workflow overlay ${id} version ${version}`);
  const filePath = workflowOverlayPath(context, id, version);
  writeJsonFile(filePath, overlay, { force: false });
  const attribution = buildAttribution(context, options, "workflow.overlay.propose");
  appendTraceEvent(context, null, {
    type: "decision",
    outcome: "ready",
    summary: `Proposed workflow overlay ${id} version ${version}`,
    action: "workflow.overlay.propose",
    actor: attribution.actor,
    evidence: [
      toProjectPath(context, filePath),
      ...(definitionEntry.path ? [toProjectPath(context, definitionEntry.path)] : []),
    ],
    related: [id, definitionId],
    git: attribution.git,
    run: attribution.run,
  });
  outputWorkflowResult(options, {
    schema_version: "workflow-overlay-proposal:v1",
    status: "proposed",
    path: toProjectPath(context, filePath),
    overlay,
    effective_summary: workflowDefinitionSummary(effective, "effective"),
  }, "overlay_proposed", [
    `Overlay: ${id} version ${version}`,
    `Definition: ${definitionId} version ${definitionVersion}`,
    `Path: ${toProjectPath(context, filePath)}`,
    `Content hash: ${overlay.overlay_hash}`,
    `Effective hash: ${effective.effective_hash}`,
  ], reviewLines);
}

export function approveWorkflowOverlayCommand(context, options) {
  ensureInitialized(context);
  const id = normalizeId(requireOption(options, "id"));
  const version = normalizeWorkflowVersion(requireOption(options, "overlay-version"), "overlay-version");
  const resolved = resolveWorkflowRecord(context, { kind: "overlay", id, version });
  if (resolved.record.status !== "proposed") {
    fail(`Workflow overlay ${id} version ${version} is '${resolved.record.status}', expected proposed.`);
  }
  const definitionEntry = workflowDefinitionForOverlay(context, resolved.record);
  const definition = definitionEntry.record;
  validateWorkflowOverlayRecord(resolved.record, definition, `workflow overlay ${id}`);
  const effective = callWorkflowDomain("Unable to calculate the adjusted way of working", () =>
    applyWorkflowOverlay(definition, resolved.record, { allow_proposed: true }));
  const reviewLines = workflowHumanReviewLines(definition, options, { overlay: resolved.record, effective });
  const attribution = buildAttribution(context, options, "workflow.overlay.approve");
  requireFormalApprovalActor(context, options, attribution, "Approving a workflow overlay");
  const approval = buildApprovalRecord(context, options, attribution, {
    subject: resolved.record,
    subject_id_field: "overlay_id",
    subject_id: id,
    scope: "workflow-overlay-version",
    label: `workflow overlay ${id} version ${version}`,
    artifact_types: ["workflow-overlay"],
  });
  const approved = callWorkflowDomain("Unable to approve workflow overlay", () =>
    approveWorkflowOverlay(resolved.record, {
      definition,
      approval: workflowApprovalForDomain(approval),
    }));
  validateWorkflowOverlayRecord(approved, definition, `approved workflow overlay ${id}`);
  writeJsonFile(resolved.path, approved, { force: true });
  appendTraceEvent(context, null, {
    type: "gate",
    outcome: "passed",
    summary: approval.summary || `Approved workflow overlay ${id} version ${version}`,
    action: "workflow.overlay.approve",
    actor: attribution.actor,
    authorization_ref: approval.authorization_ref,
    evidence: [toProjectPath(context, resolved.path), ...approval.evidence.map((entry) => entry.path)],
    related: [id, definition.id, approval.id],
    git: attribution.git,
    run: attribution.run,
  });
  outputWorkflowResult(options, {
    schema_version: "workflow-overlay-approval:v1",
    status: "approved",
    path: toProjectPath(context, resolved.path),
    overlay: approved,
    approval,
  }, "approved", [
    `Overlay: ${id} version ${version}`,
    `Approval: ${approval.id}`,
    `Path: ${toProjectPath(context, resolved.path)}`,
  ], reviewLines);
}

export function explainWorkflowOverlay(context, options) {
  ensureInitialized(context);
  const id = normalizeId(requireOption(options, "id"));
  const version = getOptionString(options, "overlay-version");
  const resolved = resolveWorkflowRecord(context, { kind: "overlay", id, version });
  const definitionEntry = workflowDefinitionForOverlay(context, resolved.record);
  validateWorkflowOverlayRecord(resolved.record, definitionEntry.record, `workflow overlay ${id}`);
  const effective = callWorkflowDomain("Unable to calculate the adjusted way of working", () =>
    applyWorkflowOverlay(definitionEntry.record, resolved.record, {
      allow_proposed: resolved.record.status === "proposed",
    }));
  const changes = workflowOverlayChanges(resolved.record);
  outputWorkflowResult(options, {
    schema_version: "workflow-overlay-explanation:v1",
    status: "ready",
    path: toProjectPath(context, resolved.path),
    overlay: resolved.record,
    definition_ref: workflowDefinitionRef(definitionEntry.record),
    changes,
    effective_definition: effective,
  }, "overlay_explained", [
    `Overlay: ${resolved.record.id} version ${resolved.record.version}`,
    `Status: ${resolved.record.status}`,
    `Definition: ${definitionEntry.record.id} version ${definitionEntry.record.version}`,
    `Changes: ${changes.length}`,
    `Effective hash: ${effective.effective_hash}`,
    `Path: ${toProjectPath(context, resolved.path)}`,
  ], workflowHumanReviewLines(definitionEntry.record, options, { overlay: resolved.record, effective }));
}

export function assertStoryWorkflowStartBoundary(context, storyId) {
  if (!readStory(context, storyId)) {
    fail(`Story ${storyId} does not exist and cannot be bound to this workflow instance.`);
  }
  const taskStartPath = path.join(
    context.sdlcRoot,
    "stories",
    storyId,
    "task-start.json",
  );
  if (fs.existsSync(taskStartPath)) {
    fail(
      `Story ${storyId} already has a task-start receipt. `
      + "A story-bound workflow must start before task start; post-hoc workflow replay cannot certify lifecycle completion.",
    );
  }
  const completedSteps = readStoryStepRecords(context, storyId)
    .filter((record) => record.status === "completed");
  if (completedSteps.length > 0) {
    fail(
      `Story ${storyId} already has completed lifecycle steps (${completedSteps
        .map((record) => record.phase || record.step)
        .filter(Boolean)
        .join(", ")}). `
      + "A story-bound workflow must start before the first completed step; post-hoc workflow replay is not allowed.",
    );
  }
}

export function startWorkflowInstance(context, options) {
  ensureInitialized(context);
  const id = normalizeId(requireOption(options, "id"));
  const definitionId = normalizeId(requireOption(options, "definition"));
  const definitionVersion = normalizeWorkflowVersion(requireOption(options, "definition-version"), "definition-version");
  const definitionEntry = resolveWorkflowDefinitionForRuntime(context, definitionId, definitionVersion);
  const definition = definitionEntry.record;
  if (definition.status !== "approved") {
    fail(`Workflow definition ${definitionId} version ${definitionVersion} must be approved before a run can start.`);
  }
  validateWorkflowDefinitionRecord(definition, `workflow definition ${definitionId}`);
  const overlayId = getOptionString(options, "overlay");
  const overlayVersion = getOptionString(options, "overlay-version");
  if (!overlayId && overlayVersion) fail("--overlay-version requires --overlay.");
  let overlayEntry = null;
  let effectiveDefinition = callWorkflowDomain("Unable to calculate the selected way of working", () =>
    applyWorkflowOverlay(definition, null));
  if (overlayId) {
    overlayEntry = resolveWorkflowRecord(context, { kind: "overlay", id: overlayId, version: overlayVersion });
    if (overlayEntry.record.status !== "approved") {
      fail(`Workflow overlay ${overlayEntry.record.id} version ${overlayEntry.record.version} must be approved before a run can start.`);
    }
    const overlayDefinition = workflowDefinitionForOverlay(context, overlayEntry.record);
    if (overlayDefinition.record.definition_hash !== definition.definition_hash) {
      fail(`Workflow overlay ${overlayEntry.record.id} belongs to a different definition version.`);
    }
    effectiveDefinition = callWorkflowDomain("Unable to calculate the adjusted way of working", () =>
      applyWorkflowOverlay(definition, overlayEntry.record));
  }
  const storyOption = getOptionString(options, "story");
  const canonicalEvidenceRequired = workflowDefinitionUsesCanonicalEvidence(effectiveDefinition);
  if (canonicalEvidenceRequired && !storyOption) {
    fail(
      `Workflow definition ${definition.id} uses canonical lifecycle checks. `
      + "Start it with --story <story-id> so every transition is bound to governed project records.",
    );
  }
  let governanceBinding = null;
  let storyId = null;
  if (storyOption) {
    storyId = normalizeId(storyOption);
    if (!readStory(context, storyId)) {
      fail(`Story ${storyId} does not exist and cannot be bound to this workflow instance.`);
    }
    assertStoryBoundWorkflowPhaseOrder(context, effectiveDefinition);
    governanceBinding = {
      story_id: storyId,
      strict_gate_receipt_path: toProjectPath(
        context,
        workflowStrictGateReceiptPath(context, storyId),
      ),
      final_gate_receipt_path: toProjectPath(
        context,
        workflowFinalGateReceiptPath(context, storyId),
      ),
    };
  }
  const attribution = buildAttribution(context, options, "workflow.instance.start");
  const summary = getOptionString(options, "summary");
  const instancePath = workflowInstancePath(context, id);
  const eventsPath = workflowEventsPath(context, id);
  const checkpointPath = workflowCheckpointPath(context, id);
  const tracePath = path.join(context.sdlcRoot, "traces", "project.jsonl");
  const creationLockPath = workflowInstanceCreationLockPath(context, id);
  const startTransactionPath = workflowInstanceStartTransactionPath(context, id);
  const startRequest = buildWorkflowStartRequest(
    id,
    definition,
    overlayEntry,
    effectiveDefinition,
    attribution.actor,
    summary,
    governanceBinding,
  );
  const releaseTaskStartBoundaryLock = storyId
    ? acquireFileLock(path.join(
        context.sdlcRoot,
        "stories",
        storyId,
        "task-start-boundary.lock",
      ))
    : () => {};
  let releaseCreationLock = () => {};
  let instance;
  let checkpoint;
  let recovered = false;
  try {
    if (storyId) {
      assertStoryOpenForWork(context, storyId, "workflow instance start");
      assertStoryWorkflowStartBoundary(context, storyId);
    }
    releaseCreationLock = acquireFileLock(creationLockPath);
    const pending = readWorkflowStartTransaction(context, id);
    let journal;
    if (pending.exists) {
      if (!pending.valid) {
        fail(`Workflow instance ${id} has an unreadable interrupted start record: ${pending.errors.join("; ")}`);
      }
      const errors = workflowStartTransactionErrors(
        pending.journal,
        startRequest,
        effectiveDefinition,
      );
      if (errors.length > 0) {
        fail(`Workflow instance ${id} has an interrupted start that does not match this request: ${errors.join("; ")}`);
      }
      journal = pending.journal;
      instance = journal.instance;
      checkpoint = journal.checkpoint;
      recovered = true;
    } else {
      if (fs.existsSync(workflowInstanceRoot(context, id))) {
        fail(`Workflow instance ${id} already exists.`);
      }
      if (fs.existsSync(workflowInstanceStagingRoot(context, id))) {
        fail(`Workflow instance ${id} has staging data without a trusted start record; remove it only after restoring or auditing the original transaction.`);
      }
      instance = callWorkflowDomain("Unable to start workflow instance", () => createWorkflowInstance({
        id,
        effective_definition: effectiveDefinition,
        created_at: now(),
        actor: attribution.actor,
        ...((summary || governanceBinding)
          ? {
              metadata: {
                ...(summary ? { summary } : {}),
                ...(governanceBinding ? { governance_binding: governanceBinding } : {}),
              },
            }
          : {}),
      }));
      const startTrace = prepareGovernedTraceEvent(
        context,
        buildWorkflowStartTraceRecord(
          context,
          instance,
          definition,
          overlayEntry,
          attribution,
          [instancePath, eventsPath, checkpointPath],
        ),
      );
      checkpoint = callWorkflowDomain("Unable to create the workflow integrity checkpoint", () =>
        createWorkflowCheckpoint({
          instance,
          effective_definition: effectiveDefinition,
          events: [],
          trace_chain_hash: extendWorkflowTraceChain(null, startTrace),
        }));
      journal = { startTrace };
    }
    const releaseTraceLock = acquireFileLock(`${tracePath}.lock`);
    try {
      if (!pending.exists) {
        const ownershipConflicts = inspectWorkflowTraceOwnershipConflictsLocked(context, id, tracePath);
        if (ownershipConflicts.length > 0) {
          fail(`Workflow instance ${id} already has conflicting audit ownership: ${ownershipConflicts.join("; ")}`);
        }
        const traceIntent = inspectWorkflowTraceIntent(context, journal.startTrace);
        if (!traceIntent.valid || traceIntent.exists) {
          fail(traceIntent.errors[0] || `Trace id ${journal.startTrace.id} already exists before the workflow instance was created.`);
        }
        journal = buildWorkflowStartTransaction({
          request: startRequest,
          instance,
          checkpoint,
          trace_event: journal.startTrace,
          trace_anchor: workflowTraceAnchor(tracePath),
        });
        ensureWorkflowDirectoryDurably(path.dirname(startTransactionPath));
        writeWorkflowJsonDurably(startTransactionPath, journal, { atomicCreate: true });
      }
      completeWorkflowStartTransactionLocked(context, journal);
    } finally {
      releaseTraceLock();
    }
  } finally {
    releaseCreationLock();
    releaseTaskStartBoundaryLock();
  }
  outputWorkflowResult(options, {
    schema_version: "workflow-instance-start:v1",
    status: "started",
    instance_path: toProjectPath(context, instancePath),
    events_path: toProjectPath(context, eventsPath),
    checkpoint_path: toProjectPath(context, checkpointPath),
    recovered,
    instance,
    checkpoint,
  }, "started", [
    `Instance: ${id}`,
    `Definition: ${definition.id} version ${definition.version}`,
    ...(overlayEntry ? [`Overlay: ${overlayEntry.record.id} version ${overlayEntry.record.version}`] : []),
    `Initial state: ${instance.current_state || instance.initial_state || effectiveDefinition.initial_state}`,
    ...(governanceBinding ? [
      `Story binding: ${governanceBinding.story_id}`,
      `Strict gate receipt: ${governanceBinding.strict_gate_receipt_path}`,
      `Final gate receipt: ${governanceBinding.final_gate_receipt_path}`,
    ] : []),
    `Path: ${toProjectPath(context, instancePath)}`,
    `Integrity checkpoint: ${toProjectPath(context, checkpointPath)}`,
    ...(recovered ? ["Recovered the exact interrupted start without creating a duplicate instance."] : []),
  ]);
}

export function readWorkflowEvents(context, instanceId) {
  const filePath = workflowEventsPath(context, instanceId);
  if (!fs.existsSync(filePath)) fail(`Workflow instance ${instanceId} is missing its event history.`);
  const raw = readProjectText(context, filePath);
  if (!raw.trim()) return [];
  return raw.split(/\r?\n/u).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      fail(`Workflow instance ${instanceId} event ${index + 1} is not valid JSON: ${error.message}`);
    }
  });
}

export function readWorkflowInstance(context, id) {
  const instancePath = workflowInstancePath(context, id);
  if (!fs.existsSync(instancePath)) fail(`Workflow instance ${id} does not exist.`);
  return { instancePath, instance: readProjectJson(context, instancePath) };
}

export function readCompletedWorkflowInstance(context, id) {
  const releaseCreationLock = acquireFileLock(workflowInstanceCreationLockPath(context, id));
  try {
    // A workflow start publishes several durable records. Waiting on the
    // creation lock prevents status or transition from observing that set
    // before its trace has committed or the whole start has rolled back.
    if (fs.existsSync(workflowInstanceStartTransactionPath(context, id))) {
      fail(`Workflow instance ${id} has an interrupted start. Status and transitions remain unavailable; repeat the exact start command to complete it safely.`);
    }
    return readWorkflowInstance(context, id);
  } finally {
    releaseCreationLock();
  }
}

export function readWorkflowCheckpoint(context, instanceId) {
  const checkpointPath = workflowCheckpointPath(context, instanceId);
  if (!fs.existsSync(checkpointPath)) {
    return {
      valid: false,
      checkpoint: null,
      checkpointPath,
      errors: [`Workflow instance ${instanceId} is missing its durable integrity checkpoint.`],
    };
  }
  try {
    return {
      valid: true,
      checkpoint: JSON.parse(readProjectText(context, checkpointPath)),
      checkpointPath,
      errors: [],
    };
  } catch (error) {
    return {
      valid: false,
      checkpoint: null,
      checkpointPath,
      errors: [`Workflow instance ${instanceId} integrity checkpoint cannot be read: ${error.message}`],
    };
  }
}

export function readWorkflowStartTransaction(context, instanceId) {
  const transactionPath = workflowInstanceStartTransactionPath(context, instanceId);
  if (!fs.existsSync(transactionPath)) {
    return { exists: false, valid: true, transactionPath, journal: null, errors: [] };
  }
  try {
    return {
      exists: true,
      valid: true,
      transactionPath,
      journal: JSON.parse(readProjectText(context, transactionPath)),
      errors: [],
    };
  } catch (error) {
    return {
      exists: true,
      valid: false,
      transactionPath,
      journal: null,
      errors: [`Interrupted workflow start record cannot be read: ${error.message}`],
    };
  }
}

export function workflowStartMaterialErrors(context, rootPath, journal) {
  if (!fs.existsSync(rootPath)) return ["instance directory is missing"];
  let entries;
  try {
    entries = safeReadDir(rootPath).sort();
  } catch (error) {
    return [error.message];
  }
  const expectedEntries = ["checkpoint.json", "events.jsonl", "instance.json"];
  const errors = stableJson(entries) === stableJson(expectedEntries)
    ? []
    : [`instance directory contains unexpected entries: ${entries.join(", ") || "none"}`];
  const instancePath = path.join(rootPath, "instance.json");
  const eventsPath = path.join(rootPath, "events.jsonl");
  const checkpointPath = path.join(rootPath, "checkpoint.json");
  try {
    if (stableJson(readProjectJson(context, instancePath)) !== stableJson(journal.instance)) {
      errors.push("instance header differs from the start transaction");
    }
    if (readProjectText(context, eventsPath) !== "") {
      errors.push("new instance event history is not empty");
    }
    if (stableJson(readProjectJson(context, checkpointPath)) !== stableJson(journal.checkpoint)) {
      errors.push("instance checkpoint differs from the start transaction");
    }
  } catch (error) {
    errors.push(error.message);
  }
  return errors;
}

export function prepareWorkflowStartStaging(context, journal) {
  const instanceId = journal.request.instance_id;
  const stagingRoot = workflowInstanceStagingRoot(context, instanceId);
  ensureWorkflowDirectoryDurably(stagingRoot);
  const expectedFiles = new Map([
    ["instance.json", Buffer.from(`${JSON.stringify(journal.instance, null, 2)}\n`, "utf8")],
    ["events.jsonl", Buffer.alloc(0)],
    ["checkpoint.json", Buffer.from(`${JSON.stringify(journal.checkpoint, null, 2)}\n`, "utf8")],
  ]);
  const entries = safeReadDir(stagingRoot).sort();
  const unexpected = entries.filter((entry) => !expectedFiles.has(entry));
  if (unexpected.length > 0) {
    fail(`Workflow instance ${instanceId} staging data contains unexpected entries: ${unexpected.join(", ")}`);
  }
  for (const [fileName, expectedBytes] of expectedFiles) {
    writeWorkflowStartStagingFileDurably(path.join(stagingRoot, fileName), expectedBytes, fileName);
  }
  const errors = workflowStartMaterialErrors(context, stagingRoot, journal);
  if (errors.length > 0) fail(`Workflow start staging validation failed: ${errors.join("; ")}`);
  return stagingRoot;
}

export function writeWorkflowStartStagingFileDurably(filePath, expectedBytes, fileName) {
  return withGovernedMutation({ operation: "file.write", path: filePath }, () =>
    writeWorkflowStartStagingFileDurablyAuthorized(filePath, expectedBytes, fileName));
}

export function writeWorkflowStartStagingFileDurablyAuthorized(filePath, expectedBytes, fileName) {
  assertMutationExecutionAuthorized({ operation: "file.write", path: filePath });
  assertNoSymlinkPathSegments(filePath);
  const parentPath = path.dirname(filePath);
  const parentIdentity = captureDirectoryIdentity(parentPath);
  let descriptor;
  let writeRequired = true;
  try {
    if (fs.existsSync(filePath)) {
      const entry = fs.lstatSync(filePath);
      if (entry.isSymbolicLink() || !entry.isFile()) {
        fail(`Workflow start staging entry is not a regular file: ${fileName}`);
      }
      descriptor = fs.openSync(filePath, fs.constants.O_RDWR | NO_FOLLOW_FLAG);
      verifyOpenFileMatchesPath(descriptor, filePath, parentIdentity);
      const existing = fs.readFileSync(descriptor);
      if (existing.equals(expectedBytes)) {
        fs.fsyncSync(descriptor);
        writeRequired = false;
      } else if (
        existing.length > expectedBytes.length
        || !expectedBytes.subarray(0, existing.length).equals(existing)
      ) {
        fail(`Workflow start staging entry differs from its durable journal: ${fileName}`);
      }
    } else {
      assertMutationExecutionAuthorized({ operation: "file.write", path: filePath });
      descriptor = fs.openSync(
        filePath,
        fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW_FLAG,
        0o600,
      );
      verifyOpenFileMatchesPath(descriptor, filePath, parentIdentity);
    }
    if (writeRequired) {
      assertMutationExecutionAuthorized({ operation: "file.write", path: filePath });
      fs.ftruncateSync(descriptor, 0);
      if (
        process.env.NODE_ENV === "test"
        && process.env.AGENTIC_SDLC_TEST_WORKFLOW_START_CRASH_PHASE === `during-staging-${fileName}`
        && expectedBytes.length > 1
      ) {
        writeWorkflowBufferAtStart(
          descriptor,
          expectedBytes.subarray(0, Math.floor(expectedBytes.length / 2)),
          filePath,
        );
        fs.fsyncSync(descriptor);
        process.kill(process.pid, "SIGKILL");
      }
      writeWorkflowBufferAtStart(descriptor, expectedBytes, filePath);
      fs.fsyncSync(descriptor);
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  syncWorkflowDirectory(parentPath);
}

export function writeWorkflowBufferAtStart(descriptor, bytes, filePath) {
  assertMutationExecutionAuthorized({ operation: "file.write", path: filePath });
  let offset = 0;
  while (offset < bytes.length) {
    assertMutationExecutionAuthorized({ operation: "file.write", path: filePath });
    const written = fs.writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
    if (written <= 0) fail("Workflow staging write made no progress.");
    offset += written;
  }
}

export function maybeCrashWorkflowStartForTest(phase) {
  if (
    process.env.NODE_ENV === "test"
    && process.env.AGENTIC_SDLC_TEST_WORKFLOW_START_CRASH_PHASE === phase
  ) {
    process.kill(process.pid, "SIGKILL");
  }
}

export function readWorkflowPendingTransition(context, instanceId) {
  const pendingPath = workflowPendingTransitionPath(context, instanceId);
  if (!fs.existsSync(pendingPath)) return { exists: false, valid: true, pendingPath, journal: null, errors: [] };
  try {
    return {
      exists: true,
      valid: true,
      pendingPath,
      journal: JSON.parse(readProjectText(context, pendingPath)),
      errors: [],
    };
  } catch (error) {
    return {
      exists: true,
      valid: false,
      pendingPath,
      journal: null,
      errors: [`Pending workflow transition cannot be read: ${error.message}`],
    };
  }
}

export function inspectWorkflowTraceIntent(context, traceEvent) {
  const tracePath = path.join(context.sdlcRoot, "traces", "project.jsonl");
  if (!fs.existsSync(tracePath)) return { valid: true, exists: false, tracePath, errors: [] };
  try {
    const matches = readProjectText(context, tracePath)
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.id === traceEvent.id);
    if (matches.length === 0) return { valid: true, exists: false, tracePath, errors: [] };
    if (matches.length !== 1 || !workflowTraceIntentMatches(matches[0], traceEvent)) {
      return { valid: false, exists: true, tracePath, errors: [`Trace id ${traceEvent.id} is duplicated or has different content.`] };
    }
    return { valid: true, exists: true, tracePath, errors: [] };
  } catch (error) {
    return { valid: false, exists: false, tracePath, errors: [`Workflow trace cannot be verified: ${error.message}`] };
  }
}

export function workflowJsonLinesAtAnchor(filePath, anchor, label) {
  const anchorErrors = workflowTraceAnchorErrors(anchor);
  if (anchorErrors.length > 0) return { valid: false, records: [], errors: anchorErrors };
  const bytes = workflowTraceBytes(filePath);
  if (bytes.length < anchor.size_bytes) {
    return { valid: false, records: [], errors: [`${label} is shorter than its transaction anchor.`] };
  }
  const prefix = bytes.subarray(0, anchor.size_bytes);
  const prefixHash = crypto.createHash("sha256").update(prefix).digest("hex");
  if (prefixHash !== anchor.prefix_hash) {
    return { valid: false, records: [], errors: [`${label} prefix differs from its transaction anchor.`] };
  }
  if (prefix.length > 0 && prefix.at(-1) !== 0x0A) {
    return { valid: false, records: [], errors: [`${label} anchor does not end at a complete record boundary.`] };
  }
  try {
    return {
      valid: true,
      records: prefix.toString("utf8").split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line)),
      errors: [],
    };
  } catch (error) {
    return { valid: false, records: [], errors: [`${label} anchor cannot be parsed: ${error.message}`] };
  }
}

export function recoverPendingWorkflowTransition(context, instanceId, instance, effectiveDefinition, expected) {
  const pending = readWorkflowPendingTransition(context, instanceId);
  if (!pending.exists || !pending.valid) return pending;
  const errors = workflowTransitionJournalErrors(pending.journal, instance, effectiveDefinition, expected);
  if (errors.length > 0) return { ...pending, valid: false, errors };
  const journal = pending.journal;
  const eventsPath = workflowEventsPath(context, instanceId);
  const checkpointPath = workflowCheckpointPath(context, instanceId);
  const tracePath = path.join(context.sdlcRoot, "traces", "project.jsonl");
  const releaseTraceLock = acquireFileLock(`${tracePath}.lock`);
  try {
    const eventState = workflowEventRecordStateLocked(eventsPath, journal.event, journal.event_anchor);
    if (!eventState.valid) return { ...pending, valid: false, errors: eventState.errors };
    if (eventState.exists && !eventState.exact_suffix) {
      return { ...pending, valid: false, errors: ["Pending workflow event is not the exact tail of its anchored history."] };
    }
    if (!eventState.exists && eventState.suffix_bytes > 0 && !eventState.repairable) {
      return { ...pending, valid: false, errors: ["Workflow event history advanced outside the pending transition."] };
    }
    let traceState = workflowTraceRecordStateLocked(tracePath, journal.trace_event, journal.trace_anchor);
    if (!traceState.valid) {
      recoverWorkflowTraceIntegrityAtAnchorLocked(context, tracePath, journal.trace_anchor);
      traceState = workflowTraceRecordStateLocked(tracePath, journal.trace_event, journal.trace_anchor);
    }
    if (!traceState.valid) return { ...pending, valid: false, errors: traceState.errors };
    const base = workflowJsonLinesAtAnchor(eventsPath, journal.event_anchor, "Workflow event history");
    if (!base.valid) return { ...pending, valid: false, errors: base.errors };
    if (base.records.length !== journal.from_sequence) {
      return { ...pending, valid: false, errors: ["Pending workflow event anchor has the wrong sequence length."] };
    }
    const checkpointRead = readWorkflowCheckpoint(context, instanceId);
    if (!checkpointRead.valid) return { ...pending, valid: false, errors: checkpointRead.errors };
    const currentCheckpoint = checkpointRead.checkpoint;
    const currentIsBase = currentCheckpoint.checkpoint_hash === journal.from_checkpoint_hash;
    const currentIsTarget = currentCheckpoint.checkpoint_hash === journal.checkpoint.checkpoint_hash;
    if (!currentIsBase && !currentIsTarget) {
      return { ...pending, valid: false, errors: ["Pending workflow transition does not match the current checkpoint."] };
    }
    if (currentIsBase && currentCheckpoint.trace_chain_hash !== journal.from_trace_chain_hash) {
      return { ...pending, valid: false, errors: ["Pending workflow transition does not match the current audit trace chain."] };
    }
    if (currentIsBase) {
      const baseReplay = replayWorkflowEvents({
        instance,
        effective_definition: effectiveDefinition,
        events: base.records,
        checkpoint: currentCheckpoint,
      }, { require_checkpoint: true });
      if (!baseReplay.valid) return { ...pending, valid: false, errors: baseReplay.errors };
    }
    const targetEvents = [...base.records, journal.event];
    const targetReplay = replayWorkflowEvents({
      instance,
      effective_definition: effectiveDefinition,
      events: targetEvents,
      checkpoint: journal.checkpoint,
    }, { require_checkpoint: true });
    if (!targetReplay.valid) return { ...pending, valid: false, errors: targetReplay.errors };
    ensureWorkflowEventRecordLocked(eventsPath, journal.event, journal.event_anchor);
    if (!currentIsTarget) {
      assertRecordSchema(journal.checkpoint, "workflow-checkpoint.schema.json", `Workflow checkpoint for instance ${instanceId}`);
      writeWorkflowJsonDurably(checkpointPath, journal.checkpoint, { force: true });
    }
    else syncWorkflowFile(checkpointPath);
    ensureWorkflowTraceRecordLocked(context, tracePath, journal.trace_event, journal.trace_anchor);
    removeWorkflowFileDurably(pending.pendingPath);
    return {
      ...pending,
      valid: true,
      recovered: true,
      events: targetEvents,
      checkpoint: journal.checkpoint,
      trace_event: journal.trace_event,
    };
  } finally {
    releaseTraceLock();
  }
}

export function persistWorkflowTransitionTransaction(
  context,
  instanceId,
  instance,
  effectiveDefinition,
  events,
  transition,
  priorCheckpoint,
  attribution,
  summary,
) {
  const eventsPath = workflowEventsPath(context, instanceId);
  const checkpointPath = workflowCheckpointPath(context, instanceId);
  const pendingPath = workflowPendingTransitionPath(context, instanceId);
  const traceEvent = prepareGovernedTraceEvent(
    context,
    buildWorkflowTransitionTraceRecord(
      context,
      instanceId,
      transition.event.to,
      transition.event,
      attribution,
      summary,
    ),
  );
  const nextCheckpoint = callWorkflowDomain("Unable to update the workflow integrity checkpoint", () =>
    createWorkflowCheckpoint({
      instance,
      effective_definition: effectiveDefinition,
      events: [...events, transition.event],
      trace_chain_hash: extendWorkflowTraceChain(priorCheckpoint.trace_chain_hash, traceEvent),
    }));
  const tracePath = path.join(context.sdlcRoot, "traces", "project.jsonl");
  const releaseTraceLock = acquireFileLock(`${tracePath}.lock`);
  try {
    const priorTraceCoverage = inspectWorkflowTraceCoverageLocked(
      context,
      instanceId,
      instance,
      events,
      priorCheckpoint,
      tracePath,
    );
    if (!priorTraceCoverage.valid) {
      fail(`Workflow audit trace changed before the transition commit: ${priorTraceCoverage.errors.join("; ")}`);
    }
    const traceIntent = inspectWorkflowTraceIntent(context, traceEvent);
    if (!traceIntent.valid || traceIntent.exists) {
      fail(traceIntent.errors[0] || `Trace id ${traceEvent.id} already exists before the transition was recorded.`);
    }
    const journal = buildWorkflowTransitionJournal(
      instance,
      priorCheckpoint,
      transition.event,
      nextCheckpoint,
      traceEvent,
      workflowTraceAnchor(eventsPath),
      workflowTraceAnchor(tracePath),
    );
    writeWorkflowJsonDurably(pendingPath, journal, { atomicCreate: true });
    ensureWorkflowEventRecordLocked(eventsPath, transition.event, journal.event_anchor);
    maybeInterruptWorkflowTransitionForTest("after-event-before-checkpoint");
    assertRecordSchema(nextCheckpoint, "workflow-checkpoint.schema.json", `Workflow checkpoint for instance ${instanceId}`);
    writeWorkflowJsonDurably(checkpointPath, nextCheckpoint, { force: true });
    maybeInterruptWorkflowTransitionForTest("after-checkpoint-before-trace");
    ensureWorkflowTraceRecordLocked(context, tracePath, traceEvent, journal.trace_anchor);
    maybeInterruptWorkflowTransitionForTest("after-trace-before-journal-clear");
    removeWorkflowFileDurably(pendingPath);
    return { checkpoint: nextCheckpoint, trace_event: traceEvent };
  } finally {
    releaseTraceLock();
  }
}

export function maybeInterruptWorkflowTransitionForTest(phase) {
  if (
    process.env.NODE_ENV === "test"
    && process.env.AGENTIC_SDLC_TEST_WORKFLOW_FAILURE_PHASE === phase
  ) {
    fail(`Simulated workflow persistence interruption at ${phase}.`);
  }
}

export function inspectWorkflowRuntimeIntegrity(context, instanceId, instance, effectiveDefinition, events) {
  const pending = readWorkflowPendingTransition(context, instanceId);
  if (pending.exists) {
    const journalErrors = pending.valid
      ? workflowTransitionJournalErrors(pending.journal, instance, effectiveDefinition)
      : pending.errors;
    const recoveryAvailable = pending.valid && journalErrors.length === 0;
    return {
      valid: false,
      checkpoint: null,
      checkpointPath: workflowCheckpointPath(context, instanceId),
      pendingPath: pending.pendingPath,
      recovery_available: recoveryAvailable,
      recovery_request_id: recoveryAvailable ? pending.journal.event.idempotency_key : null,
      recovery_target_state: recoveryAvailable ? pending.journal.event.to : null,
      errors: recoveryAvailable
        ? ["A workflow transition was interrupted and must be retried with the same request before status can be trusted."]
        : journalErrors,
    };
  }
  const checkpointRead = readWorkflowCheckpoint(context, instanceId);
  if (!checkpointRead.valid) return checkpointRead;
  let validation;
  try {
    validation = validateWorkflowCheckpoint(checkpointRead.checkpoint, {
      instance,
      effective_definition: effectiveDefinition,
    });
  } catch (error) {
    return {
      ...checkpointRead,
      valid: false,
      errors: [`Workflow instance ${instanceId} integrity checkpoint is invalid: ${error.message}`],
    };
  }
  if (validation !== true && validation?.valid !== true) {
    return {
      ...checkpointRead,
      valid: false,
      errors: Array.isArray(validation?.errors) && validation.errors.length > 0
        ? validation.errors
        : [`Workflow instance ${instanceId} integrity checkpoint is invalid.`],
    };
  }
  let replay;
  try {
    replay = replayWorkflowEvents({
      instance,
      effective_definition: effectiveDefinition,
      events,
      checkpoint: checkpointRead.checkpoint,
    }, { require_checkpoint: true });
  } catch (error) {
    return {
      ...checkpointRead,
      valid: false,
      errors: [`Workflow instance ${instanceId} history cannot be replayed safely: ${error.message}`],
    };
  }
  if (replay?.valid !== true) {
    return {
      ...checkpointRead,
      valid: false,
      replay,
      errors: Array.isArray(replay?.errors) && replay.errors.length > 0
        ? replay.errors
        : [`Workflow instance ${instanceId} history failed integrity validation.`],
    };
  }
  const traceCoverage = inspectWorkflowTraceCoverage(
    context,
    instanceId,
    instance,
    events,
    checkpointRead.checkpoint,
  );
  return {
    ...checkpointRead,
    valid: traceCoverage.valid,
    replay,
    trace_coverage: traceCoverage,
    errors: traceCoverage.errors,
  };
}

export function inspectWorkflowTraceCoverage(context, instanceId, instance, events, checkpoint) {
  const tracePath = path.join(context.sdlcRoot, "traces", "project.jsonl");
  const releaseTraceLock = acquireFileLock(`${tracePath}.lock`);
  try {
    return inspectWorkflowTraceCoverageLocked(context, instanceId, instance, events, checkpoint, tracePath);
  } finally {
    releaseTraceLock();
  }
}

export function syncWorkflowDirectory(directoryPath) {
  let descriptor;
  let opened = false;
  try {
    descriptor = fs.openSync(directoryPath, fs.constants.O_RDONLY);
    opened = true;
    fs.fsyncSync(descriptor);
    return true;
  } catch (error) {
    // On Windows the directory can be opened for metadata inspection while
    // FlushFileBuffers on that directory handle is unsupported. Do not hide
    // ACL/path failures raised by openSync itself.
    if (
      process.platform === "win32"
      && opened
      && WORKFLOW_WINDOWS_DIRECTORY_SYNC_UNSUPPORTED.has(error?.code)
    ) {
      return false;
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function syncWorkflowFile(filePath) {
  assertNoSymlinkPathSegments(filePath);
  const parentIdentity = captureDirectoryIdentity(path.dirname(filePath));
  let descriptor;
  try {
    // FlushFileBuffers requires a write-capable handle on Windows.
    descriptor = fs.openSync(filePath, fs.constants.O_RDWR | NO_FOLLOW_FLAG);
    verifyOpenFileMatchesPath(descriptor, filePath, parentIdentity);
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  syncWorkflowDirectory(path.dirname(filePath));
}

export function ensureWorkflowDirectoryDurably(directoryPath) {
  if (fs.existsSync(directoryPath)) {
    const entry = fs.lstatSync(directoryPath);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      fail(`Refusing unstable workflow directory: ${directoryPath}`);
    }
    return false;
  }
  const parentPath = path.dirname(directoryPath);
  ensureWorkflowDirectoryDurably(parentPath);
  return withGovernedMutation({ operation: "directory.create", path: directoryPath }, () => {
    assertMutationExecutionAuthorized({ operation: "directory.create", path: directoryPath });
    fs.mkdirSync(directoryPath);
    syncWorkflowDirectory(parentPath);
    return true;
  });
}

export function workflowTraceBytes(filePath) {
  if (!fs.existsSync(filePath)) return Buffer.alloc(0);
  assertNoSymlinkPathSegments(filePath);
  const entry = fs.lstatSync(filePath);
  if (entry.isSymbolicLink() || !entry.isFile()) fail(`Workflow trace is not a regular file: ${filePath}`);
  return fs.readFileSync(filePath);
}

export function workflowTraceAnchor(filePath) {
  const bytes = workflowTraceBytes(filePath);
  return {
    size_bytes: bytes.length,
    prefix_hash: crypto.createHash("sha256").update(bytes).digest("hex"),
  };
}

export function truncateWorkflowFileDurably(filePath, size) {
  return withGovernedMutation({ operation: "file.truncate", path: filePath }, () =>
    truncateWorkflowFileDurablyAuthorized(filePath, size));
}

export function truncateWorkflowFileDurablyAuthorized(filePath, size) {
  assertMutationExecutionAuthorized({ operation: "file.truncate", path: filePath });
  assertNoSymlinkPathSegments(filePath);
  const parentIdentity = captureDirectoryIdentity(path.dirname(filePath));
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDWR | NO_FOLLOW_FLAG);
    verifyOpenFileMatchesPath(descriptor, filePath, parentIdentity);
    assertMutationExecutionAuthorized({ operation: "file.truncate", path: filePath });
    fs.ftruncateSync(descriptor, size);
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  syncWorkflowDirectory(path.dirname(filePath));
}

export function writeWorkflowJsonDurably(filePath, value, options = {}) {
  const written = writeJsonFile(filePath, value, options);
  syncWorkflowFile(filePath);
  return written;
}

export function writeWorkflowTextDurably(filePath, value, options = {}) {
  const written = writeTextFile(filePath, value, options);
  syncWorkflowFile(filePath);
  return written;
}

export function removeWorkflowFileDurably(filePath) {
  if (!fs.existsSync(filePath)) return false;
  assertNoSymlinkPathSegments(filePath);
  const parentPath = path.dirname(filePath);
  removePathGoverned(filePath);
  syncWorkflowDirectory(parentPath);
  return true;
}

export function removeWorkflowDirectoryIfEmptyDurably(directoryPath) {
  try {
    removeEmptyDirectoryGoverned(directoryPath);
    syncWorkflowDirectory(path.dirname(directoryPath));
    return true;
  } catch (error) {
    if (["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error?.code)) return false;
    throw error;
  }
}

export function buildCanonicalEvidenceForWorkflowInstance(
  context,
  instance,
  canonicalEvidenceSchema,
  outputScope = null,
  workflowScope = null,
) {
  const binding = instance?.metadata?.governance_binding;
  if (!binding?.story_id || !binding?.final_gate_receipt_path) {
    fail(
      `Workflow instance ${instance?.id || "unknown"} is missing its immutable story and final-gate binding. `
      + "Start a new governed instance with --story <story-id>.",
    );
  }
  const storyId = normalizeId(binding.story_id);
  const expectedGatePath = workflowFinalGateReceiptPath(context, storyId);
  const boundGatePath = resolveProjectFilePath(context, binding.final_gate_receipt_path, {
    mustExist: false,
  });
  if (path.resolve(boundGatePath) !== path.resolve(expectedGatePath)) {
    fail(`Workflow instance ${instance.id} final-gate binding does not match story ${storyId}.`);
  }
  const expectedStrictGatePath = workflowStrictGateReceiptPath(context, storyId);
  const boundStrictGatePath = binding.strict_gate_receipt_path
    ? resolveProjectFilePath(context, binding.strict_gate_receipt_path, { mustExist: false })
    : null;
  if (boundStrictGatePath && path.resolve(boundStrictGatePath) !== path.resolve(expectedStrictGatePath)) {
    fail(`Workflow instance ${instance.id} strict-gate binding does not match story ${storyId}.`);
  }
  const story = readStory(context, storyId);
  const requirements = (story?.requirement_refs || [])
    .map((reference) => readRequirement(context, reference?.id, { missingOk: true }))
    .filter(Boolean);
  const contract = story?.contract_id
    ? readContractById(context, story.contract_id, { missingOk: true })
    : null;
  const outputRegistry = readOutputRegistry(context, { missingOk: true });
  const deliveryProfile = contract?.delivery_execution_profile_id
    ? readDeliveryAutonomyProfile(context, contract.delivery_execution_profile_id, { missingOk: true })
    : null;
  const deliveryCloseReceipt = deliveryProfile
    ? currentDeliveryExecutionState(context, deliveryProfile).close_receipt
    : null;
  const strictGatePath = boundStrictGatePath || expectedStrictGatePath;
  const useLegacyFinalGate = !binding.strict_gate_receipt_path
    && !fs.existsSync(strictGatePath)
    && fs.existsSync(expectedGatePath);
  const gateReport = fs.existsSync(strictGatePath)
    ? readProjectJson(context, strictGatePath)
    : useLegacyFinalGate
      ? readProjectJson(context, expectedGatePath)
      : null;
  if (gateReport) {
    const legacyFinalSchema = gateReport.schema_version === "workflow-final-gate-receipt:v1";
    assertRecordSchema(
      gateReport,
      useLegacyFinalGate
        ? legacyFinalSchema
          ? "workflow-final-gate-receipt-v1.schema.json"
          : "workflow-final-gate-receipt.schema.json"
        : "workflow-strict-gate-receipt.schema.json",
      useLegacyFinalGate
        ? `Legacy final workflow gate receipt ${binding.final_gate_receipt_path}`
        : `Intermediate workflow gate receipt ${toProjectPath(context, strictGatePath)}`,
    );
  }
  const evidenceBuilder =
    canonicalEvidenceSchema === WORKFLOW_LEGACY_CANONICAL_EVIDENCE_SCHEMA
      ? buildLegacyWorkflowCanonicalEvidence
      : buildWorkflowCanonicalEvidence;
  return buildDomainRecord(
    `Cannot build canonical workflow evidence for ${instance.id}`,
    () => evidenceBuilder({
      instance,
      story,
      requirements,
      contract,
      output_registry: outputRegistry,
      output_scope: outputScope,
      workflow_scope: workflowScope,
      gate_report: gateReport,
      delivery_profile: deliveryProfile,
      delivery_close_receipt: deliveryCloseReceipt,
      observed_at: now(),
    }),
  );
}

export function transitionWorkflowInstance(context, options) {
  ensureInitialized(context);
  const id = normalizeId(requireOption(options, "id"));
  const to = requireOption(options, "to");
  const idempotencyKey = normalizeId(requireOption(options, "request-id"));
  const { instance } = readCompletedWorkflowInstance(context, id);
  const { effectiveDefinition } = loadEffectiveDefinitionForInstance(context, instance);
  const eventsPath = workflowEventsPath(context, id);
  const checkpointPath = workflowCheckpointPath(context, id);
  const storyId = instance.metadata?.governance_binding?.story_id
    ? normalizeId(instance.metadata.governance_binding.story_id)
    : null;
  const requiresCurrentPhaseCompletion =
    workflowRequiresCurrentPhaseCompletion(instance, effectiveDefinition);
  let releaseTaskStartBoundaryLock = () => {};
  let releaseLifecycleLock = () => {};
  let releaseEventLock = () => {};
  let result;
  let events;
  let integrityFailure = null;
  let attribution;
  try {
    if (storyId) {
      releaseTaskStartBoundaryLock = acquireFileLock(path.join(
        context.sdlcRoot,
        "stories",
        storyId,
        "task-start-boundary.lock",
      ));
      releaseLifecycleLock = acquireFileLock(
        storyLifecycleCertificationLockPath(context, storyId),
      );
      const currentStory = readStory(context, storyId);
      if (!currentStory) {
        fail(`Workflow ${id} references missing story ${storyId}.`);
      }
      if (currentStory.contract_review_required) {
        fail(
          `Workflow ${id} cannot transition while story ${storyId} requires a new exact contract `
          + "for its revised acceptance criteria.",
        );
      }
    }
    releaseEventLock = acquireFileLock(`${eventsPath}.lock`);
    const recovery = recoverPendingWorkflowTransition(context, id, instance, effectiveDefinition, {
      requestId: idempotencyKey,
      targetState: to,
    });
    if (!recovery.valid) {
      integrityFailure = {
        ...recovery,
        checkpointPath,
      };
    } else {
      events = readWorkflowEvents(context, id);
      const integrity = inspectWorkflowRuntimeIntegrity(context, id, instance, effectiveDefinition, events);
      if (!integrity.valid) {
        integrityFailure = integrity;
      } else {
        attribution = buildAttribution(context, options, "workflow.instance.transition");
        const currentState = workflowCurrentState(integrity.replay, instance, effectiveDefinition);
        const idempotentReplay = events.some((event) => event.idempotency_key === idempotencyKey);
        const definedTransition = (effectiveDefinition.transitions || []).some((transition) =>
          transition.from === currentState && transition.to === to);
        if (
          !idempotentReplay
          && definedTransition
          && requiresCurrentPhaseCompletion
        ) {
          const phaseCompletion = currentStoryPhaseCompletionReadiness(
            context,
            storyId,
            instance,
            effectiveDefinition,
            events,
            currentState,
          );
          if (!phaseCompletion.ready) {
            fail(
              `Workflow transition ${id} from ${currentState} to ${to} cannot leave phase `
              + `'${currentState}' before its canonical story step is completed: `
              + `${phaseCompletion.issues.join("; ")}. Complete the phase with `
              + `'story complete-step --id ${storyId} --step ${currentState}' `
              + "and its required evidence or authorization, then retry the transition.",
            );
          }
        }
        const usesCanonicalEvidence = !idempotentReplay
          && workflowTransitionUsesCanonicalEvidence(effectiveDefinition, currentState, to);
        const usesStrictGate = !idempotentReplay
          && storyId
          && workflowTransitionUsesStrictGate(effectiveDefinition, currentState, to);
        if (usesStrictGate) {
          const strictGate = currentStoryStrictGateReadiness(
            context,
            storyId,
            instance,
            effectiveDefinition,
            integrity,
            currentState,
          );
          if (!strictGate.ready) {
            const recoveryCommand = strictGate.repair?.command
              || statusCliCommand(
                "gate", "check", "--strict", "--story", storyId,
              );
            fail(
              `Workflow transition ${id} from ${currentState} to ${to} cannot use the intermediate strict gate: `
              + `${strictGate.issues.join("; ")} `
              + (
                strictGate.repair?.diagnostic === true
                  ? `Run '${recoveryCommand}' to inspect the blockers, repair them, and then retry the transition.`
                  : `Run '${recoveryCommand}' and retry the transition.`
              ),
            );
          }
        }
        const canonicalEvidenceSchema = usesCanonicalEvidence
          ? workflowCanonicalEvidenceSchema(effectiveDefinition)
          : null;
        const canonicalEvidence = usesCanonicalEvidence
          ? buildCanonicalEvidenceForWorkflowInstance(
              context,
              instance,
              canonicalEvidenceSchema,
              canonicalEvidenceSchema === WORKFLOW_CANONICAL_EVIDENCE_SCHEMA
                ? {
                    current_phase: currentState,
                    phase_order: effectiveDefinition.phase_order,
                    require_all: false,
                  }
                : null,
              canonicalEvidenceSchema === WORKFLOW_CANONICAL_EVIDENCE_SCHEMA
                ? workflowScopeFromRuntime(
                    instance,
                    effectiveDefinition,
                    integrity,
                    currentState,
                  )
                : null,
            )
          : null;
        result = callWorkflowDomain("Unable to move workflow instance", () => createWorkflowTransition({
          instance,
          effective_definition: effectiveDefinition,
          events,
          checkpoint: integrity.checkpoint,
          to,
          timestamp: now(),
          actor: attribution.actor,
          idempotency_key: idempotencyKey,
          context: parseWorkflowGuardContext(options),
        }, {
          require_checkpoint: true,
          ...(canonicalEvidence ? { canonical_evidence: canonicalEvidence } : {}),
        }));
        if (!result.idempotent) {
          maybeInterleaveConflictingWorkflowTraceForTest(context, id);
          persistWorkflowTransitionTransaction(
            context,
            id,
            instance,
            effectiveDefinition,
            events,
            result,
            integrity.checkpoint,
            attribution,
            getOptionString(options, "summary"),
          );
        }
      }
    }
  } finally {
    releaseEventLock();
    releaseLifecycleLock();
    releaseTaskStartBoundaryLock();
  }
  if (integrityFailure) {
    blockWorkflowOnIntegrityFailure(context, options, id, integrityFailure, "transition");
    return;
  }
  const currentState = result.replay.current_state || result.replay.state;
  const payload = {
    schema_version: "workflow-instance-transition:v1",
    status: result.idempotent ? "unchanged" : "transitioned",
    idempotent: result.idempotent === true,
    instance_id: id,
    current_state: currentState,
    events_path: toProjectPath(context, eventsPath),
    checkpoint_path: toProjectPath(context, checkpointPath),
    event: result.event,
    replay: result.replay,
  };
  const details = [
    `Instance: ${id}`,
    `State: ${currentState}`,
    `Sequence: ${result.event.sequence}`,
    `Event hash: ${result.event.event_hash}`,
    `Path: ${toProjectPath(context, eventsPath)}`,
    `Integrity checkpoint: ${toProjectPath(context, checkpointPath)}`,
  ];
  if (result.idempotent) {
    const guidance = workflowIdempotentGuidance(options);
    output(options, { ...payload, human_guidance: guidance }, humanGuidanceLines(guidance, details, options));
    return;
  }
  outputWorkflowResult(options, payload, "transitioned", details);
}

export function maybeInterleaveConflictingWorkflowTraceForTest(context, instanceId) {
  if (
    process.env.NODE_ENV !== "test"
    || process.env.AGENTIC_SDLC_TEST_WORKFLOW_TRACE_INTERLEAVING !== "conflicting-transition-trace"
  ) {
    return;
  }
  appendTraceEvent(context, null, {
    type: "implementation",
    summary: `Simulated conflicting trace for ${instanceId}`,
    outcome: "passed",
    actor: { id: "workflow-interleaving-test", type: "system", name: "Workflow interleaving test" },
    action: "workflow.instance.transition",
    related: [instanceId, "f".repeat(64)],
  });
}

export function showWorkflowInstance(context, options, { explain = false } = {}) {
  ensureInitialized(context);
  const id = normalizeId(requireOption(options, "id"));
  const { instancePath, instance } = readCompletedWorkflowInstance(context, id);
  const { definitionEntry, overlayEntry, effectiveDefinition } = loadEffectiveDefinitionForInstance(context, instance);
  const eventsPath = workflowEventsPath(context, id);
  const storyId = instance.metadata?.governance_binding?.story_id
    ? normalizeId(instance.metadata.governance_binding.story_id)
    : null;
  const requiresCurrentPhaseCompletion =
    workflowRequiresCurrentPhaseCompletion(instance, effectiveDefinition);
  const releaseLifecycleLock = storyId && requiresCurrentPhaseCompletion
    ? acquireFileLock(storyLifecycleCertificationLockPath(context, storyId))
    : () => {};
  let releaseLock = () => {};
  let events;
  let integrity;
  let currentState;
  let currentPhaseCompletion = null;
  try {
    releaseLock = acquireFileLock(`${eventsPath}.lock`);
    events = readWorkflowEvents(context, id);
    integrity = inspectWorkflowRuntimeIntegrity(context, id, instance, effectiveDefinition, events);
    if (integrity.valid) {
      currentState = workflowCurrentState(integrity.replay, instance, effectiveDefinition);
      currentPhaseCompletion = requiresCurrentPhaseCompletion
        ? currentStoryPhaseCompletionReadiness(
            context,
            storyId,
            instance,
            effectiveDefinition,
            events,
            currentState,
          )
        : null;
      // A terminal state's readiness cannot be judged from its own phase
      // alone once other configured phases (such as release) precede it:
      // tampering with an earlier phase's sealed step must still block
      // certification, not just an invalid current phase. Fold every other
      // configured phase's readiness into the reported completion so a
      // caller reading current_phase_completion sees the real blocker.
      const terminalCandidate = (effectiveDefinition.states || [])
        .find((state) => state.id === currentState)?.terminal === true;
      if (requiresCurrentPhaseCompletion && terminalCandidate && currentPhaseCompletion) {
        const otherPhaseReadiness = configuredPhaseOrder(context)
          .filter((phase) => phase !== currentState)
          .map((phase) =>
            currentStoryPhaseCompletionReadiness(
              context,
              storyId,
              instance,
              effectiveDefinition,
              events,
              phase,
            ))
          .filter((readiness) => !readiness.ready);
        if (otherPhaseReadiness.length > 0) {
          currentPhaseCompletion = {
            ...currentPhaseCompletion,
            ready: false,
            issues: [
              ...currentPhaseCompletion.issues,
              ...otherPhaseReadiness.flatMap((readiness) => readiness.issues),
            ],
          };
        }
      }
    }
  } finally {
    releaseLock();
    releaseLifecycleLock();
  }
  if (!integrity.valid) {
    blockWorkflowOnIntegrityFailure(context, options, id, integrity, explain ? "explain" : "status");
    return;
  }
  const replay = integrity.replay;
  const nextStates = workflowNextStates(effectiveDefinition, currentState);
  const outgoingTransitions = (effectiveDefinition.transitions || [])
    .filter((transition) => transition.from === currentState);
  const canonicalOutgoing = outgoingTransitions.filter((transition) =>
    (transition.guards || []).some((guard) =>
      Object.hasOwn(CANONICAL_WORKFLOW_GUARD_CHECKS, guard?.id)));
  const canonicalEvidenceSchema = canonicalOutgoing.length > 0
    ? workflowCanonicalEvidenceSchema(effectiveDefinition)
    : null;
  const canonicalEvidence = canonicalOutgoing.length > 0
    ? buildCanonicalEvidenceForWorkflowInstance(
        context,
        instance,
        canonicalEvidenceSchema,
        canonicalEvidenceSchema === WORKFLOW_CANONICAL_EVIDENCE_SCHEMA
          ? {
              current_phase: currentState,
              phase_order: effectiveDefinition.phase_order,
              require_all: false,
            }
          : null,
        canonicalEvidenceSchema === WORKFLOW_CANONICAL_EVIDENCE_SCHEMA
          ? workflowScopeFromRuntime(
              instance,
              effectiveDefinition,
              integrity,
              currentState,
            )
          : null,
      )
    : null;
  const stateTerminal = (effectiveDefinition.states || [])
    .find((state) => state.id === currentState)?.terminal === true;
  const finalReceipt = storyId && stateTerminal
    ? validCurrentWorkflowFinalReceipt(context, storyId, instance)
    : null;
  const hasStrictGateOutgoing = outgoingTransitions.some((transition) =>
    (transition.guards || []).some((guard) =>
      guard?.id === "strict-gate-passed"));
  const strictGateReadiness = storyId && hasStrictGateOutgoing
    ? currentStoryStrictGateReadiness(
        context,
        storyId,
        instance,
        effectiveDefinition,
        integrity,
        currentState,
      )
    : null;
  const nextTransitionChecks = outgoingTransitions.map((transition) => {
    const phaseCompletionBlocked =
      currentPhaseCompletion
      && !currentPhaseCompletion.ready;
    if (!canonicalOutgoing.includes(transition)) {
      return {
        transition_id: transition.id,
        to: transition.to,
        canonical: false,
        allowed: phaseCompletionBlocked
          ? false
          : (transition.guards || []).length === 0 ? true : null,
        guard_results: [],
      };
    }
    const evaluated = evaluateWorkflowGuards(
      transition.guards,
      {},
      undefined,
      canonicalEvidence,
    );
    const usesStrictGate = (transition.guards || []).some((guard) =>
      guard?.id === "strict-gate-passed");
    const strictGateBlocked =
      usesStrictGate
      && strictGateReadiness
      && !strictGateReadiness.ready;
    const guardResults = strictGateBlocked
      ? evaluated.results.map((result) =>
          result.guard_id === "strict-gate-passed"
            ? {
                ...result,
                allowed: false,
                reason: "The intermediate strict gate is invalid or stale for the current workflow state",
                issues: strictGateReadiness.issues,
                repair_action: strictGateReadiness.repair || null,
              }
            : result)
      : evaluated.results;
    return {
      transition_id: transition.id,
      to: transition.to,
      canonical: true,
      allowed: evaluated.allowed && !strictGateBlocked && !phaseCompletionBlocked,
      guard_results: guardResults,
    };
  });
  const readyNextStates = nextTransitionChecks
    .filter((transition) => transition.allowed === true)
    .map((transition) => transition.to);
  const currentPhaseCompletionReady =
    !currentPhaseCompletion || currentPhaseCompletion.ready;
  let instanceStatus;
  if (stateTerminal) {
    if (!currentPhaseCompletionReady) {
      instanceStatus = "blocked";
    } else if (!storyId || finalReceipt?.valid) {
      instanceStatus = "terminal";
    } else if (finalReceipt?.exists) {
      instanceStatus = "blocked";
    } else {
      instanceStatus = "awaiting_certification";
    }
  } else {
    instanceStatus =
      nextTransitionChecks.length > 0
      && nextTransitionChecks.every((transition) => transition.allowed === false)
        ? "blocked"
        : "ready";
  }
  outputWorkflowResult(options, {
    schema_version: explain ? "workflow-instance-explanation:v1" : "workflow-instance-status:v1",
    status: instanceStatus,
    terminal:
      stateTerminal
      && currentPhaseCompletionReady
      && (!storyId || finalReceipt?.valid === true),
    state_terminal: stateTerminal,
    final_receipt_exists: finalReceipt?.exists ?? null,
    final_receipt_valid: finalReceipt?.valid ?? null,
    instance,
    current_state: currentState,
    current_phase_completion: currentPhaseCompletion,
    next_states: nextStates,
    ready_next_states: readyNextStates,
    next_transition_checks: nextTransitionChecks,
    canonical_evidence_hash: canonicalEvidence?.evidence_hash ?? null,
    event_count: events.length,
    integrity: replay.integrity,
    replay,
    checkpoint_path: toProjectPath(context, integrity.checkpointPath),
    checkpoint: integrity.checkpoint,
    ...(explain ? { events } : {}),
  }, "instance_shown", [
    `Instance: ${id}`,
    `Current state: ${currentState}`,
    ...(currentPhaseCompletion
      ? [
          `Current phase completion: ${currentPhaseCompletion.ready ? "ready" : "blocked"}`,
          ...currentPhaseCompletion.issues.map((issue) => `Phase completion blocker: ${issue}`),
        ]
      : []),
    `Terminal lifecycle: ${
      stateTerminal
      && currentPhaseCompletionReady
      && (!storyId || finalReceipt?.valid === true)
        ? "yes"
        : "no"
    }`,
    ...(finalReceipt
      ? [
          `Final receipt exists: ${finalReceipt.exists ? "yes" : "no"}`,
          `Final receipt valid: ${finalReceipt.valid ? "yes" : "no"}`,
        ]
      : []),
    `Next states: ${nextStates.join(", ") || "none"}`,
    ...nextTransitionChecks
      .filter((transition) => transition.canonical)
      .map((transition) =>
        `Canonical readiness ${transition.to}: ${transition.allowed ? "ready" : "blocked"}; `
        + transition.guard_results.map((result) => `${result.guard_id}=${result.allowed}`).join(", ")),
    `Events: ${events.length}`,
    `Definition: ${definitionEntry.record.id} version ${definitionEntry.record.version}`,
    ...(overlayEntry ? [`Overlay: ${overlayEntry.record.id} version ${overlayEntry.record.version}`] : []),
    `Instance path: ${toProjectPath(context, instancePath)}`,
    `Events path: ${toProjectPath(context, eventsPath)}`,
    `Integrity checkpoint: ${toProjectPath(context, integrity.checkpointPath)}`,
  ]);
}

export function workflowTraceSealTestHooks(event) {
  if (
    process.env.NODE_ENV !== "test"
    || event?.action !== "workflow.instance.start"
    || process.env.AGENTIC_SDLC_TEST_WORKFLOW_START_TRACE_FAILURE !== "after-append-before-sync"
  ) {
    return {};
  }
  return {
    after_append_write() {
      fail("Simulated workflow start trace interruption after append.");
    },
  };
}

export function assertNoPendingWorkflowTraceTransaction(context, tracePath) {
  const projectTracePath = path.join(context.sdlcRoot, "traces", "project.jsonl");
  if (path.resolve(tracePath) !== path.resolve(projectTracePath)) return;
  const pending = [];
  const startsRoot = workflowInstanceStartTransactionsRoot(context);
  for (const entry of safeReadDir(startsRoot)) {
    if (entry.endsWith(".json") && fs.existsSync(path.join(startsRoot, entry))) {
      pending.push(`start:${entry.slice(0, -5)}`);
    }
  }
  const instancesRoot = workflowInstancesRoot(context);
  for (const entry of safeReadDir(instancesRoot)) {
    if (entry.startsWith(".")) continue;
    const pendingPath = path.join(instancesRoot, entry, "pending-transition.json");
    if (fs.existsSync(pendingPath)) pending.push(`transition:${entry}`);
  }
  if (pending.length > 0) {
    fail(`Project trace has a pending workflow transaction (${pending.sort().join(", ")}); recover it before appending another audit event.`);
  }
}

export function validCurrentWorkflowFinalReceipt(context, storyId, instance) {
  const receiptPath = workflowFinalGateReceiptPath(context, storyId);
  if (!fs.existsSync(receiptPath)) return { exists: false, valid: false };
  try {
    const receipt = readProjectJson(context, receiptPath);
    assertRecordSchema(
      receipt,
      "workflow-final-gate-receipt.schema.json",
      `Final workflow gate receipt ${storyId}`,
    );
    const { effectiveDefinition } = loadEffectiveDefinitionForInstance(context, instance);
    const eventsPath = workflowEventsPath(context, instance.id);
    const releaseLock = acquireFileLock(`${eventsPath}.lock`);
    let events;
    let integrity;
    try {
      events = readWorkflowEvents(context, instance.id);
      integrity = inspectWorkflowRuntimeIntegrity(
        context,
        instance.id,
        instance,
        effectiveDefinition,
        events,
      );
    } finally {
      releaseLock();
    }
    const currentPhase = integrity.valid
      ? workflowCurrentState(integrity.replay, instance, effectiveDefinition)
      : null;
    const terminalState = (effectiveDefinition.states || [])
      .find((state) => state.id === currentPhase);
    const terminalEvent = events.at(-1) || null;
    const proof = receipt.lifecycle_workflow || {};
    const checkpoint = integrity.checkpoint || {};
    const taskStartBinding = inspectModernWorkflowTaskStartBinding(
      context,
      storyId,
      instance,
    );
    const taskStart = taskStartBinding.task_start;
    const currentFreshnessProof = buildWorkflowFinalFreshnessProof(
      context,
      storyId,
      instance.id,
      receipt.freshness_proof,
    );
    return {
      exists: true,
      valid:
        hasValidWorkflowReceiptHash(receipt)
        && receipt.freshness_proof?.schema_version
          === WORKFLOW_FINAL_FRESHNESS_PROOF_SCHEMA
        && receipt.freshness_proof?.story_id === storyId
        && receipt.freshness_proof?.workflow_instance_id === instance.id
        && receipt.freshness_proof?.proof_hash
          === computeStableHash((({ proof_hash: ignored, ...subject }) => subject)(
            receipt.freshness_proof,
          ))
        && workflowFinalFreshnessProofMatches(
          context,
          receipt.freshness_proof,
          currentFreshnessProof,
        )
        && integrity.valid
        && receipt.story_id === storyId
        && receipt.lifecycle_workflow?.instance_id === instance.id
        && receipt.lifecycle_workflow?.instance_hash === instance.instance_hash
        && proof.story_id === storyId
        && terminalState?.terminal === true
        && currentPhase === configuredPhaseOrder(context).at(-1)
        && proof.effective_hash === effectiveDefinition.effective_hash
        && proof.terminal_state === currentPhase
        && proof.event_count === events.length
        && proof.checkpoint_ref?.path
          === toProjectPath(context, workflowCheckpointPath(context, instance.id))
        && proof.checkpoint_ref?.checkpoint_hash === checkpoint.checkpoint_hash
        && proof.checkpoint_ref?.sequence === checkpoint.sequence
        && proof.checkpoint_ref?.last_event_hash === checkpoint.last_event_hash
        && proof.checkpoint_ref?.trace_chain_hash === checkpoint.trace_chain_hash
        && proof.terminal_event_ref?.event_hash === terminalEvent?.event_hash
        && proof.terminal_event_ref?.sequence === terminalEvent?.sequence
        && proof.terminal_event_ref?.timestamp === terminalEvent?.timestamp
        && taskStartBinding.valid
        && proof.task_start_ref?.id === taskStart?.id
        && proof.task_start_ref?.path === toProjectPath(context, taskStartBinding.path)
        && proof.task_start_ref?.hash === taskStartBinding.hash
        && proof.task_start_ref?.confirmed_at === taskStart?.confirmed_at
        && currentCertifiedLifecycleEvidenceMatches(
          context,
          storyId,
          proof,
          receipt.checked_at,
          {
            workflow: {
              instance,
              effective_definition: effectiveDefinition,
              integrity,
              scope: workflowScopeFromRuntime(
                instance,
                effectiveDefinition,
                integrity,
                currentPhase,
              ),
            },
          },
        ),
      current_phase: currentPhase,
      workflow_instance_id: instance.id,
    };
  } catch {
    return { exists: true, valid: false };
  }
}

export function buildStoryWorkflowNextAction(context, story) {
  if (!story?.id) return null;
  const taskStartPath = path.join(context.sdlcRoot, "stories", story.id, "task-start.json");
  const completedSteps = readStoryStepRecords(context, story.id)
    .filter((record) => record.status === "completed");
  const probe = { errors: [] };
  const selected = currentStoryBoundWorkflowInstance(context, story.id, probe);
  if (probe.errors.length > 0) {
    return {
      kind: "inspect_story_workflow",
      reason: "workflow_state_unreadable",
      label: "Inspect the story workflow before continuing.",
      command: statusCliCommand("workflow", "definition", "list"),
      protected: true,
      story_id: story.id,
    };
  }
  if (!selected) {
    if (fs.existsSync(taskStartPath)) {
      const taskStart = readProjectJson(context, taskStartPath);
      if (
        taskStart.kind === "task_start_receipt"
        && taskStart.schema_version === "task-start-receipt:v2"
        && taskStart.story_id === story.id
        && taskStart.proposal_ref?.id
      ) {
        const assessmentId = normalizeId(taskStart.proposal_ref.id);
        let assessmentState = "missing_workflow";
        try {
          const assessmentWorkflow = readAssessmentWorkflow(
            context,
            assessmentId,
            { missingOk: true },
          );
          assessmentState = assessmentWorkflow?.state || "missing_workflow";
        } catch {
          assessmentState = "unreadable";
        }
        return {
          kind: "continue_assessment",
          reason: `assessment_${assessmentState}`,
          label:
            `Continue assessment ${assessmentId}: ${assessmentNextAction(assessmentState, assessmentId)}.`,
          command: statusCliCommand(
            "assessment", "proposal", "status", "--id", assessmentId,
          ),
          protected: true,
          story_id: story.id,
          assessment_id: assessmentId,
          assessment_state: assessmentState,
        };
      }
    }
    if (fs.existsSync(taskStartPath) || completedSteps.length > 0) {
      return {
        kind: "lifecycle_not_certifiable",
        reason: "workflow_missing_before_task_or_step",
        label:
          "This legacy task has no pre-task workflow binding; a post-hoc workflow cannot certify lifecycle completion.",
        command: null,
        protected: true,
        story_id: story.id,
      };
    }
    const configured = configuredPhaseOrder(context);
    const stock = configured.length === SOFTWARE_PROJECT_PHASES.length
      && configured.every((phase, index) => phase === SOFTWARE_PROJECT_PHASES[index]);
    const definition = stock ? null : matchingApprovedStoryWorkflowDefinition(context);
    if (!stock && !definition) {
      return {
        kind: "define_custom_workflow",
        reason: "custom_phase_order_needs_matching_workflow",
        label:
          `Define and approve a story-bound workflow with this exact phase order: ${configured.join(" -> ")}.`,
        command: statusCliCommand("workflow", "definition", "propose", "--help"),
        protected: true,
        story_id: story.id,
        configured_phase_order: configured,
      };
    }
    const definitionId = stock ? "software-project" : definition.id;
    const definitionVersion = stock ? "3" : definition.version;
    return {
      kind: "start_story_workflow",
      reason: "story_workflow_not_started",
      label: "Start the governed story workflow before task start or the first completed step.",
      command: statusCliCommand(
        "workflow", "instance", "start",
        "--id", `DELIVERY-${story.id}`,
        "--definition", definitionId,
        "--definition-version", definitionVersion,
        "--story", story.id,
      ),
      protected: true,
      story_id: story.id,
      definition_id: definitionId,
      definition_version: definitionVersion,
    };
  }

  let instance;
  let effectiveDefinition;
  let events;
  let integrity;
  try {
    ({ instance } = readCompletedWorkflowInstance(context, selected.entry));
    ({ effectiveDefinition } = loadEffectiveDefinitionForInstance(context, instance));
    const eventsPath = workflowEventsPath(context, selected.entry);
    const releaseEventLock = acquireFileLock(`${eventsPath}.lock`);
    try {
      events = readWorkflowEvents(context, selected.entry);
      integrity = inspectWorkflowRuntimeIntegrity(
        context,
        selected.entry,
        instance,
        effectiveDefinition,
        events,
      );
    } finally {
      releaseEventLock();
    }
  } catch {
    return {
      kind: "inspect_story_workflow",
      reason: "workflow_state_unreadable",
      label: "Inspect the bound story workflow before continuing.",
      command: statusCliCommand("workflow", "instance", "status", "--id", selected.entry),
      protected: true,
      story_id: story.id,
      workflow_instance_id: selected.entry,
    };
  }
  if (!integrity.valid) {
    return {
      kind: "inspect_story_workflow",
      reason: "workflow_state_unreadable",
      label: "Inspect the bound story workflow before continuing.",
      command: statusCliCommand("workflow", "instance", "status", "--id", selected.entry),
      protected: true,
      story_id: story.id,
      workflow_instance_id: selected.entry,
    };
  }
  const currentState = workflowCurrentState(
    integrity.replay,
    instance,
    effectiveDefinition,
  );
  if (!fs.existsSync(taskStartPath)) {
    return {
      kind: "start_available_work",
      reason: "workflow_started_before_task",
      label: "The story workflow is bound; provide the governed task intent before starting work.",
      command: statusCliCommand("help", "task", "start"),
      protected: true,
      story_id: story.id,
      workflow_instance_id: selected.entry,
    };
  }
  const terminal = (effectiveDefinition.states || [])
    .find((state) => state.id === currentState)?.terminal === true;
  if (terminal) {
    const finalReceipt = validCurrentWorkflowFinalReceipt(context, story.id, instance);
    if (finalReceipt.valid) return null;
    if (finalReceipt.exists) {
      return {
        kind: "recertify_lifecycle",
        reason: "final_lifecycle_receipt_invalid",
        label:
          "The final lifecycle receipt no longer matches current governed evidence; repair any reported evidence drift and reseal this exact story lifecycle.",
        command: statusCliCommand(
          "gate", "check",
          "--strict",
          "--story", story.id,
          "--lifecycle-complete",
        ),
        protected: true,
        story_id: story.id,
        workflow_instance_id: selected.entry,
      };
    }
  }
  // Release evidence and the active claim must clear once the workflow enters
  // "release", not only once it reaches the terminal phase: a phase configured
  // after release (such as operations) makes "release" itself non-terminal,
  // but delivery still has to close before that later phase is entered.
  if (currentState === "release" || terminal) {
    const releaseReadiness = storyReleaseReadiness(context, story.id);
    if (!releaseReadiness.ready) {
      // A PR delivery without merge whose latest verified PR completion is
      // current can only move forward by closing as ready_for_review.
      const command = releaseReadiness.ready_for_review_close_available
        ? statusCliCommand(
            "autonomy", "delivery", "close",
            "--id", releaseReadiness.profile_id,
            "--terminal-status", "ready_for_review",
            "--reason", "The pull request is open for review at its verified head",
          )
        : releaseReadiness.profile_id
          ? statusCliCommand("autonomy", "delivery", "status", "--id", releaseReadiness.profile_id)
          : statusCliCommand("help", "trace", "append");
      return {
        kind: "complete_release_evidence",
        reason: "release_phase_evidence_incomplete",
        label: `Complete release evidence before final certification: ${releaseReadiness.missing.join(", ")}.`,
        command,
        protected: true,
        story_id: story.id,
        workflow_instance_id: selected.entry,
        missing_release_evidence: releaseReadiness.missing,
      };
    }
    const claimPath = path.join(context.sdlcRoot, "stories", story.id, "claim.json");
    if (fs.existsSync(claimPath)) {
      const claim = readProjectJson(context, claimPath);
      if (claim.status === "active") {
        return {
          kind: "release_story_claim",
          reason: "final_certification_requires_released_claim",
          label: "Release the completed story claim before final lifecycle certification.",
          command: statusCliCommand("story", "release", "--id", story.id),
          protected: true,
          story_id: story.id,
          workflow_instance_id: selected.entry,
          claimed_by: claim.agent || null,
        };
      }
    }
  }
  if (terminal) {
    return {
      kind: "certify_lifecycle",
      reason: "workflow_terminal",
      label: "Certify the complete local lifecycle after release evidence and terminal delivery are ready.",
      command: statusCliCommand(
        "gate", "check", "--strict", "--story", story.id, "--lifecycle-complete",
      ),
      protected: true,
      story_id: story.id,
      workflow_instance_id: selected.entry,
    };
  }
  const currentStepCompleted = completedSteps.some((record) => record.phase === currentState);
  const outgoingTransition = (effectiveDefinition.transitions || [])
    .find((transition) => transition.from === currentState) || null;
  const nextState = outgoingTransition?.to || null;
  const nextStateRequiresStrictGate = (outgoingTransition?.guards || [])
    .some((guard) => guard?.id === "strict-gate-passed");
  if (currentStepCompleted && nextStateRequiresStrictGate) {
    const strictGate = currentStoryStrictGateReadiness(
      context,
      story.id,
      instance,
      effectiveDefinition,
      integrity,
      currentState,
    );
    if (!strictGate.ready) {
      if (strictGate.repair) {
        return {
          ...strictGate.repair,
          protected: true,
          story_id: story.id,
          workflow_instance_id: selected.entry,
          strict_gate_issues: strictGate.issues,
        };
      }
      return {
        kind: "seal_strict_gate",
        reason: strictGate.reason === "missing"
          ? "release_transition_needs_strict_gate"
          : "release_transition_strict_gate_stale",
        label: strictGate.reason === "missing"
          ? "Seal the intermediate strict receipt before entering the release phase."
          : "Re-run the intermediate strict gate because its receipt is invalid or older than current evidence.",
        command: statusCliCommand("gate", "check", "--strict", "--story", story.id),
        protected: true,
        story_id: story.id,
        workflow_instance_id: selected.entry,
        strict_gate_issues: strictGate.issues,
      };
    }
  }
  if (currentStepCompleted && nextState) {
    return {
      kind: "advance_story_workflow",
      reason: "current_phase_completed",
      label: `Advance the governed workflow from ${currentState} to ${nextState}.`,
      command: statusCliCommand(
        "workflow", "instance", "transition",
        "--id", selected.entry,
        "--to", nextState,
        "--request-id", `${selected.entry}-${currentState}-to-${nextState}`,
      ),
      protected: true,
      story_id: story.id,
      workflow_instance_id: selected.entry,
      current_phase: currentState,
      next_phase: nextState,
    };
  }
  return {
    kind: "inspect_story_workflow",
    reason: "current_phase_in_progress",
    label: `Complete the governed '${currentState}' step before advancing the workflow.`,
    command: statusCliCommand("workflow", "instance", "status", "--id", selected.entry),
    protected: false,
    story_id: story.id,
    workflow_instance_id: selected.entry,
    current_phase: currentState,
  };
}

export function validLegacyWorkflowFinalReceipt(context, storyId, receipt) {
  try {
    assertRecordSchema(
      receipt,
      "workflow-final-gate-receipt-v1.schema.json",
      `Legacy final workflow gate receipt ${storyId}`,
    );
    const {
      receipt_hash: receiptHash,
      ...legacyHashSubject
    } = receipt;
    return (
      hasValidWorkflowReceiptHash(receipt)
      || receiptHash === computeStableHash(legacyHashSubject)
    )
      && receipt.story_id === storyId
      && receipt.final_receipt_path
        === toProjectPath(context, workflowFinalGateReceiptPath(context, storyId));
  } catch {
    return false;
  }
}

export function inspectModernWorkflowTaskStartBinding(context, storyId, instance) {
  const taskStartPath = path.join(
    context.sdlcRoot,
    "stories",
    storyId,
    "task-start.json",
  );
  if (!fs.existsSync(taskStartPath)) {
    return { valid: false, task_start: null, path: taskStartPath, hash: null };
  }
  try {
    const taskStart = readProjectJson(context, taskStartPath);
    assertRecordSchema(
      taskStart,
      "profile-task-start-receipt.schema.json",
      `Task-start receipt for story ${storyId}`,
    );
    const workflowRef = taskStart.workflow_instance_ref;
    const expectedInstancePath = toProjectPath(
      context,
      workflowInstancePath(context, instance.id),
    );
    return {
      valid:
        taskStart.kind === "profile_task_start_receipt"
        && taskStart.schema_version === "profile-task-start-receipt:v2"
        && taskStart.story_id === storyId
        && workflowRef?.id === instance.id
        && workflowRef?.path === expectedInstancePath
        && workflowRef?.hash === instance.instance_hash,
      task_start: taskStart,
      path: taskStartPath,
      hash: hashJsonFileValue(taskStart),
    };
  } catch {
    return { valid: false, task_start: null, path: taskStartPath, hash: null };
  }
}

export function inspectStoryWorkflowLifecycleRuntime(context, selected, storyId) {
  const { instance } = readCompletedWorkflowInstance(context, selected.entry);
  if (instance.id !== selected.entry) {
    return {
      valid: false,
      modern: false,
      instance,
      current_phase: null,
      terminal: false,
      event_count: null,
    };
  }
  const binding = instance.metadata?.governance_binding || {};
  const modern = Boolean(binding.strict_gate_receipt_path);
  const expectedStrictPath = workflowStrictGateReceiptPath(context, storyId);
  const expectedFinalPath = workflowFinalGateReceiptPath(context, storyId);
  const strictPath = modern
    ? resolveProjectFilePath(context, binding.strict_gate_receipt_path, {
        mustExist: false,
      })
    : null;
  const finalPath = binding.final_gate_receipt_path
    ? resolveProjectFilePath(context, binding.final_gate_receipt_path, {
        mustExist: false,
      })
    : null;
  if (
    binding.story_id !== storyId
    || !finalPath
    || path.resolve(finalPath) !== path.resolve(expectedFinalPath)
    || (modern && path.resolve(strictPath) !== path.resolve(expectedStrictPath))
  ) {
    return {
      valid: false,
      modern: true,
      instance,
      current_phase: null,
      terminal: false,
      event_count: null,
    };
  }
  const { effectiveDefinition } = loadEffectiveDefinitionForInstance(context, instance);
  const eventsPath = workflowEventsPath(context, instance.id);
  const releaseLock = acquireFileLock(`${eventsPath}.lock`);
  let events;
  let integrity;
  try {
    events = readWorkflowEvents(context, instance.id);
    integrity = inspectWorkflowRuntimeIntegrity(
      context,
      instance.id,
      instance,
      effectiveDefinition,
      events,
    );
  } finally {
    releaseLock();
  }
  const currentPhase = integrity.valid
    ? workflowCurrentState(integrity.replay, instance, effectiveDefinition)
    : null;
  const terminalState = (effectiveDefinition.states || [])
    .find((state) => state.id === currentPhase);
  return {
    valid: integrity.valid,
    modern,
    instance,
    current_phase: currentPhase,
    event_count: events.length,
    terminal:
      terminalState?.terminal === true
      && currentPhase === configuredPhaseOrder(context).at(-1),
  };
}

export function deriveCurrentStoryWorkflowScope(context, storyId, report) {
  const initialErrorCount = report.errors.length;
  const selected = currentStoryBoundWorkflowInstance(context, storyId, report);
  if (!selected || report.errors.length > initialErrorCount) {
    return null;
  }
  const instanceId = selected.entry;
  try {
    const { instance } = readCompletedWorkflowInstance(context, instanceId);
    if (
      instance.id !== instanceId
      || instance.metadata?.governance_binding?.story_id !== storyId
    ) {
      report.errors.push(
        `Story ${storyId} workflow scope cannot use instance ${instanceId}: `
        + "the immutable instance id or story binding does not match",
      );
      return null;
    }
    const { effectiveDefinition } = loadEffectiveDefinitionForInstance(context, instance);
    const phaseDifference = workflowPhaseOrderDifference(context, effectiveDefinition);
    if (!phaseDifference.exact) {
      report.errors.push(
        `Story ${storyId} workflow scope cannot use workflow ${instanceId}: `
        + `configured [${phaseDifference.configured.join(", ")}], `
        + `pinned [${phaseDifference.selected.join(", ")}]`,
      );
      return null;
    }
    const eventsPath = workflowEventsPath(context, instanceId);
    const releaseLock = acquireFileLock(`${eventsPath}.lock`);
    let integrity;
    try {
      const events = readWorkflowEvents(context, instanceId);
      integrity = inspectWorkflowRuntimeIntegrity(
        context,
        instanceId,
        instance,
        effectiveDefinition,
        events,
      );
    } finally {
      releaseLock();
    }
    if (!integrity.valid) {
      report.errors.push(
        `Story ${storyId} workflow scope cannot verify workflow ${instanceId}: `
        + `${(integrity.errors || []).join("; ") || "invalid workflow history"}`,
      );
      return null;
    }
    const currentPhase = workflowCurrentState(
      integrity.replay,
      instance,
      effectiveDefinition,
    );
    return {
      instance,
      effective_definition: effectiveDefinition,
      integrity,
      scope: workflowScopeFromRuntime(
        instance,
        effectiveDefinition,
        integrity,
        currentPhase,
      ),
    };
  } catch (error) {
    report.errors.push(
      `Story ${storyId} workflow scope cannot read workflow ${instanceId}: ${error.message}`,
    );
    return null;
  }
}

export function workflowStartTraceIndex(context) {
  const cached = workflowStartTraceIndexCache.get(context);
  if (cached) return cached;
  const tracePath = path.join(context.sdlcRoot, "traces", "project.jsonl");
  if (!fs.existsSync(tracePath)) {
    const empty = { valid: true, error: null, by_story: new Map() };
    workflowStartTraceIndexCache.set(context, empty);
    return empty;
  }
  let snapshot;
  try {
    snapshot = withTraceIntegritySnapshot(
      traceIntegrityOptions(context, tracePath),
      ({ integrity, records }) => ({ integrity, records }),
    );
  } catch (error) {
    const failed = { valid: false, error: error.message, by_story: new Map() };
    workflowStartTraceIndexCache.set(context, failed);
    return failed;
  }
  if (!snapshot.integrity.valid) {
    const failed = {
      valid: false,
      error: "the project audit trace is invalid",
      by_story: new Map(),
    };
    workflowStartTraceIndexCache.set(context, failed);
    return failed;
  }
  const byStory = new Map();
  const addStoryStart = (storyId, instanceId) => {
    const normalizedStoryId = normalizeId(storyId);
    const storyPath = path.join(
      context.sdlcRoot,
      "stories",
      normalizedStoryId,
      "story.json",
    );
    if (!fs.existsSync(storyPath)) return;
    const instanceIds = byStory.get(normalizedStoryId) || new Set();
    instanceIds.add(instanceId);
    byStory.set(normalizedStoryId, instanceIds);
  };
  for (const entry of snapshot.records) {
    const event = entry.valid === true ? entry.event : null;
    if (
      event?.action !== "workflow.instance.start"
      || !Array.isArray(event.related)
    ) {
      continue;
    }
    try {
      const instanceId = normalizeId(event.related[0]);
      const explicitStoryId = event.workflow_story_id;
      const instancePath = workflowInstancePath(context, instanceId);
      const expectedEvidence = [
        toProjectPath(context, instancePath),
        toProjectPath(context, workflowEventsPath(context, instanceId)),
        toProjectPath(context, workflowCheckpointPath(context, instanceId)),
      ];
      if (
        event.story_id !== null
        || event.type !== "implementation"
        || event.outcome !== "ready"
        || stableJson(event.evidence || []) !== stableJson(expectedEvidence)
        || !Number.isFinite(Date.parse(String(event.created_at || "")))
      ) {
        throw new Error(
          `workflow start trace ${event.id || instanceId} is not a canonical workflow start record`,
        );
      }

      if (fs.existsSync(instancePath)) {
        const instance = readProjectJson(context, instancePath);
        if (
          event.id !== `TR-WF-START-${String(instance.instance_hash || "").slice(0, 24)}`
          || event.created_at !== instance.created_at
        ) {
          throw new Error(
            `workflow start trace ${event.id || instanceId} does not match its immutable instance header`,
          );
        }
        const definitionRef = instanceDefinitionReference(instance);
        const definitionId = normalizeId(referenceId(definitionRef, "definition"));
        const overlayRef = instanceOverlayReference(instance);
        const overlayId = overlayRef
          ? normalizeId(referenceId(overlayRef, "overlay"))
          : null;
        const expectedPrefix = [
          instanceId,
          definitionId,
          ...(overlayId ? [overlayId] : []),
        ];
        if (
          event.related.length < expectedPrefix.length
          || expectedPrefix.some(
            (relatedId, index) => event.related[index] !== relatedId,
          )
          || event.related.length > expectedPrefix.length + 1
        ) {
          throw new Error(
            `workflow start trace ${event.id || instanceId} does not match its immutable instance references`,
          );
        }
        const relatedStoryId = event.related.length === expectedPrefix.length + 1
          ? normalizeId(event.related.at(-1))
          : null;
        if (explicitStoryId !== undefined && explicitStoryId !== null) {
          const normalizedStoryId = normalizeId(explicitStoryId);
          if (
            relatedStoryId !== normalizedStoryId
            || instance.metadata?.governance_binding?.story_id !== normalizedStoryId
          ) {
            throw new Error(
              `workflow start trace ${event.id || instanceId} has a mismatched explicit story binding`,
            );
          }
          addStoryStart(normalizedStoryId, instanceId);
        } else if (relatedStoryId) {
          addStoryStart(relatedStoryId, instanceId);
        }
        continue;
      }

      if (!/^TR-WF-START-[a-f0-9]{24}$/u.test(String(event.id || ""))) {
        throw new Error(
          `workflow start trace ${event.id || instanceId} has no canonical immutable identity`,
        );
      }
      if (explicitStoryId !== undefined && explicitStoryId !== null) {
        const normalizedStoryId = normalizeId(explicitStoryId);
        if (event.related.at(-1) !== normalizedStoryId) {
          throw new Error(
            `workflow start trace ${event.id || instanceId} has a mismatched explicit story binding`,
          );
        }
        addStoryStart(normalizedStoryId, instanceId);
        continue;
      }

      // Trace records created before workflow_story_id was introduced still
      // place a story binding last. When the instance itself is missing, that
      // final relation is the only durable recovery evidence left.
      if (event.related.length >= 3) {
        addStoryStart(event.related.at(-1), instanceId);
      }
    } catch (error) {
      const failed = {
        valid: false,
        error: error.message || "a workflow start trace has invalid binding metadata",
        by_story: new Map(),
      };
      workflowStartTraceIndexCache.set(context, failed);
      return failed;
    }
  }
  const result = { valid: true, error: null, by_story: byStory };
  workflowStartTraceIndexCache.set(context, result);
  return result;
}

export function workflowStartTraceCandidatesForStory(context, storyId, report) {
  const traceIndex = workflowStartTraceIndex(context);
  if (!traceIndex.valid) {
    report.errors.push(
      `Story ${storyId} cannot recover its workflow binding from the audit trace: ${traceIndex.error}`,
    );
    return [];
  }
  const instanceIds = traceIndex.by_story.get(storyId) || new Set();
  const candidates = [];
  for (const instanceId of instanceIds) {
    const instancePath = workflowInstancePath(context, instanceId);
    if (!fs.existsSync(instancePath)) {
      report.errors.push(
        `Story ${storyId} workflow start trace points to missing instance ${instanceId}`,
      );
      continue;
    }
    try {
      candidates.push({
        entry: instanceId,
        instance: readProjectJson(context, instancePath),
        selected_by: "workflow_start_trace",
      });
    } catch (error) {
      report.errors.push(
        `Story ${storyId} workflow start trace points to unreadable instance ${instanceId}: ${error.message}`,
      );
    }
  }
  return candidates;
}

export function workflowStartTransactionIndex(context) {
  const cached = workflowStartTransactionIndexCache.get(context);
  if (cached) return cached;
  const result = { global_errors: [], by_story: new Map() };
  for (const fileName of safeReadDir(workflowInstanceStartTransactionsRoot(context))) {
    if (!fileName.endsWith(".json")) continue;
    const transactionPath = path.join(
      workflowInstanceStartTransactionsRoot(context),
      fileName,
    );
    let journal;
    try {
      journal = readProjectJson(context, transactionPath);
      if (
        journal?.transaction_hash !== workflowStartTransactionHash(journal)
        || journal?.request?.intent_hash
          !== workflowStartRequestHash(journal?.request || {})
      ) {
        throw new Error("its immutable transaction hash is invalid");
      }
    } catch (error) {
      result.global_errors.push(
        `interrupted workflow start ${fileName} is unreadable: ${error.message}`,
      );
      continue;
    }
    let effectiveDefinition;
    try {
      ({ effectiveDefinition } = loadEffectiveDefinitionForInstance(
        context,
        journal.instance,
      ));
      const errors = workflowStartTransactionErrors(
        journal,
        journal.request,
        effectiveDefinition,
      );
      if (errors.length > 0) {
        throw new Error(errors.join("; "));
      }
    } catch (caught) {
      result.global_errors.push(
        `interrupted workflow start ${fileName} is invalid: ${caught.message}`,
      );
      continue;
    }
    const storyId =
      journal.instance?.metadata?.governance_binding?.story_id || null;
    if (!storyId) continue;
    const entries = result.by_story.get(storyId) || [];
    entries.push({
      instance_id: journal.request?.instance_id || fileName,
      error: null,
    });
    result.by_story.set(storyId, entries);
  }
  workflowStartTransactionIndexCache.set(context, result);
  return result;
}

export function inspectInterruptedWorkflowStartsForStory(context, storyId, report) {
  const index = workflowStartTransactionIndex(context);
  for (const error of index.global_errors) {
    report.errors.push(`Story ${storyId} cannot proceed while ${error}`);
  }
  for (const entry of index.by_story.get(storyId) || []) {
    report.errors.push(
      entry.error
        ? `Story ${storyId} interrupted workflow start ${entry.instance_id} ${entry.error}`
        : `Story ${storyId} has interrupted workflow start ${entry.instance_id}; repeat the exact workflow instance start command before task start or scheduling.`,
    );
  }
}

export function currentStoryBoundWorkflowInstance(context, storyId, report) {
  inspectInterruptedWorkflowStartsForStory(context, storyId, report);
  let taskBoundCandidate = null;
  let taskStart = null;
  const taskStartPath = path.join(
    context.sdlcRoot,
    "stories",
    storyId,
    "task-start.json",
  );
  if (fs.existsSync(taskStartPath)) {
    try {
      taskStart = readProjectJson(context, taskStartPath);
    } catch (error) {
      report.errors.push(
        `Story ${storyId} cannot select its task-bound workflow because task start is unreadable: ${error.message}`,
      );
      return null;
    }
    const profileTaskStart = taskStart?.kind === "profile_task_start_receipt";
    const assessmentTaskStart = taskStart?.kind === "task_start_receipt";
    try {
      if (profileTaskStart) {
        assertRecordSchema(
          taskStart,
          profileTaskStartReceiptSchemaName(taskStart),
          `Task-start receipt for story ${storyId}`,
        );
      } else if (assessmentTaskStart) {
        assertRecordSchema(
          taskStart,
          "task-start-receipt.schema.json",
          `Assessment task-start receipt for story ${storyId}`,
        );
      } else {
        fail(`Story ${storyId} has an unsupported task-start receipt kind.`);
      }
    } catch (error) {
      report.errors.push(
        `Story ${storyId} task-start receipt is invalid: ${error.message}`,
      );
      return null;
    }
    const taskWorkflowRef = profileTaskStart
      ? taskStart.workflow_instance_ref || null
      : null;
    if (
      profileTaskStart
      && taskStart.schema_version === "profile-task-start-receipt:v2"
      && !taskWorkflowRef
    ) {
      report.errors.push(
        `Story ${storyId} task start is missing its required immutable workflow reference`,
      );
      return null;
    }
    if (taskWorkflowRef) {
      try {
        const instanceId = normalizeId(taskWorkflowRef.id);
        const expectedPath = workflowInstancePath(context, instanceId);
        if (
          taskWorkflowRef.path !== toProjectPath(context, expectedPath)
          || !fs.existsSync(expectedPath)
        ) {
          report.errors.push(
            `Story ${storyId} task start points to a missing or non-canonical workflow instance`,
          );
          return null;
        }
        const instance = readProjectJson(context, expectedPath);
        if (
          instance.id !== instanceId
          || taskWorkflowRef.hash !== instance.instance_hash
        ) {
          report.errors.push(
            `Story ${storyId} task-bound workflow reference does not match its immutable instance`,
          );
          return null;
        }
        taskBoundCandidate = {
          entry: instanceId,
          instance,
          selected_by: "task_start",
        };
      } catch (error) {
        report.errors.push(
          `Story ${storyId} task-bound workflow reference is invalid: ${error.message}`,
        );
        return null;
      }
    }
  }
  const candidates = [];
  for (const entry of safeReadDir(workflowInstancesRoot(context))
    .sort((left, right) => left.localeCompare(right, "en"))) {
    if (entry.startsWith(".")) continue;
    const instancePath = path.join(workflowInstancesRoot(context), entry, "instance.json");
    if (!fs.existsSync(instancePath)) continue;
    let instance;
    try {
      instance = readProjectJson(context, instancePath);
    } catch (error) {
      report.errors.push(
        `Story ${storyId} cannot select its current workflow while instance ${entry} is unreadable: ${error.message}`,
      );
      continue;
    }
    if (instance.metadata?.governance_binding?.story_id !== storyId) continue;
    if (!Number.isFinite(Date.parse(String(instance.created_at || "")))) {
      report.errors.push(
        `Story ${storyId} workflow instance ${instance.id || entry} has no valid immutable creation time`,
      );
      continue;
    }
    candidates.push({ entry, instance });
  }
  const tracedCandidates = workflowStartTraceCandidatesForStory(
    context,
    storyId,
    report,
  );
  if (tracedCandidates.length > 0) {
    const boundInstanceIds = new Set(candidates.map((candidate) => candidate.entry));
    const traceOnlyCandidates = tracedCandidates.filter(
      (candidate) => !boundInstanceIds.has(candidate.entry),
    );
    if (traceOnlyCandidates.length > 0) {
      report.errors.push(
        `Story ${storyId} workflow start trace no longer matches its immutable story binding`,
      );
      candidates.push(...traceOnlyCandidates);
    }
  }
  if (candidates.length === 0) {
    if (taskBoundCandidate) {
      report.errors.push(
        `Story ${storyId} task-bound workflow no longer has its immutable story binding`,
      );
    }
    return taskBoundCandidate;
  }
  // One story may retain older immutable runs. The current run is the newest
  // immutable instance; the stable id is the deterministic tie-breaker.
  candidates.sort((left, right) =>
    String(left.instance.created_at).localeCompare(String(right.instance.created_at), "en")
    || String(left.instance.id || left.entry).localeCompare(String(right.instance.id || right.entry), "en"));
  const selected = candidates.at(-1);
  if (taskBoundCandidate && selected.entry !== taskBoundCandidate.entry) {
    report.errors.push(
      `Story ${storyId} current workflow does not match the exact instance bound by task start`,
    );
  }
  return selected;
}

export function validateCurrentStoryWorkflowCompletion(
  context,
  storyId,
  report,
  { deliveryClosedAt = null, releaseTrace = null } = {},
) {
  const selected = currentStoryBoundWorkflowInstance(context, storyId, report);
  if (!selected) {
    report.errors.push(
      `Story ${storyId} lifecycle completion requires one current story-bound workflow instance`,
    );
    return;
  }
  const instanceId = selected.entry;
  const label = `story ${storyId} current workflow instance ${instanceId}`;
  try {
    const { instance } = readCompletedWorkflowInstance(context, instanceId);
    if (instance.id !== instanceId) {
      report.errors.push(`${label} immutable id does not match its canonical directory`);
    }
    const binding = instance.metadata?.governance_binding;
    const expectedStrictPath = workflowStrictGateReceiptPath(context, storyId);
    const expectedFinalPath = workflowFinalGateReceiptPath(context, storyId);
    const strictPath = binding?.strict_gate_receipt_path
      ? resolveProjectFilePath(context, binding.strict_gate_receipt_path, { mustExist: false })
      : null;
    const finalPath = binding?.final_gate_receipt_path
      ? resolveProjectFilePath(context, binding.final_gate_receipt_path, { mustExist: false })
      : null;
    if (
      binding?.story_id !== storyId
      || (strictPath && path.resolve(strictPath) !== path.resolve(expectedStrictPath))
      || !finalPath
      || path.resolve(finalPath) !== path.resolve(expectedFinalPath)
    ) {
      report.errors.push(`${label} has an invalid immutable story or gate binding`);
    }

    const { effectiveDefinition } = loadEffectiveDefinitionForInstance(context, instance);
    const phaseDifference = workflowPhaseOrderDifference(context, effectiveDefinition);
    if (!phaseDifference.exact) {
      report.errors.push(
        `${label} does not match the configured phase order `
        + `[${phaseDifference.configured.join(", ")}]; pinned workflow order is `
        + `[${phaseDifference.selected.join(", ")}]`,
      );
    }

    const eventsPath = workflowEventsPath(context, instanceId);
    const releaseLock = acquireFileLock(`${eventsPath}.lock`);
    let events;
    let integrity;
    try {
      events = readWorkflowEvents(context, instanceId);
      integrity = inspectWorkflowRuntimeIntegrity(
        context,
        instanceId,
        instance,
        effectiveDefinition,
        events,
      );
    } finally {
      releaseLock();
    }
    if (!integrity.valid) {
      report.errors.push(
        `${label} failed instance, event, checkpoint, or audit-trace integrity: `
        + `${(integrity.errors || []).join("; ") || "invalid workflow history"}`,
      );
      report.checked.push(label);
      return;
    }

    const currentState = workflowCurrentState(integrity.replay, instance, effectiveDefinition);
    const terminalState = (effectiveDefinition.states || [])
      .find((state) => state.id === currentState);
    const configuredTerminalState = configuredPhaseOrder(context).at(-1);
    if (
      terminalState?.terminal !== true
      || currentState !== configuredTerminalState
    ) {
      report.errors.push(
        `${label} must be terminal in configured final phase '${configuredTerminalState}'; found '${currentState}'`,
      );
    }

    const terminalEvent = events.at(-1) || null;
    const terminalAt = terminalEvent?.to === currentState
      && Number.isFinite(Date.parse(String(terminalEvent.timestamp || "")))
      ? terminalEvent.timestamp
      : null;
    if (!terminalAt) {
      report.errors.push(`${label} has no valid terminal transition event`);
    }

    const taskStartPath = path.join(context.sdlcRoot, "stories", storyId, "task-start.json");
    const taskStart = fs.existsSync(taskStartPath)
      ? readProjectJson(context, taskStartPath)
      : null;
    const workflowCreatedAt = Number.isFinite(Date.parse(String(instance.created_at || "")))
      ? instance.created_at
      : null;
    const taskStartedAt = Number.isFinite(Date.parse(String(taskStart?.confirmed_at || "")))
      ? taskStart.confirmed_at
      : null;
    const expectedInstancePath = toProjectPath(context, workflowInstancePath(context, instanceId));
    const taskWorkflowRef = taskStart?.workflow_instance_ref || null;
    if (!taskStart) {
      report.errors.push(`${label} has no task-start receipt to prove the pre-task workflow binding`);
    } else if (!taskWorkflowRef) {
      report.errors.push(
        `${label} was not bound by task start. Start the story-bound workflow before task start; `
        + "a post-hoc replay cannot be lifecycle-certified.",
      );
    } else if (
      taskWorkflowRef.id !== instance.id
      || taskWorkflowRef.hash !== instance.instance_hash
      || taskWorkflowRef.path !== expectedInstancePath
    ) {
      report.errors.push(`${label} does not match the exact workflow instance bound by task start`);
    }
    if (!taskStartedAt) {
      report.errors.push(`${label} has no valid task-start timestamp`);
    } else if (
      workflowCreatedAt
      && Date.parse(workflowCreatedAt) > Date.parse(taskStartedAt)
    ) {
      report.errors.push(
        `${label} started after task start; post-hoc workflow replay cannot certify lifecycle completion`,
      );
    }

    const requiredPhases = configuredPhaseOrder(context);
    const phaseCompletionReadiness = requiredPhases.map((phase) =>
      currentStoryPhaseCompletionReadiness(
        context,
        storyId,
        instance,
        effectiveDefinition,
        events,
        phase,
      ));
    for (const completion of phaseCompletionReadiness) {
      if (!completion.ready) {
        report.errors.push(
          `${label} phase '${completion.phase}' completion is not currently attested: `
          + `${completion.issues.join("; ")}`,
        );
      }
    }
    const completionByPhase = new Map(
      phaseCompletionReadiness.map((completion) => [completion.phase, completion]),
    );
    const firstTransitionAt = events.length > 0
      && Number.isFinite(Date.parse(String(events[0]?.timestamp || "")))
      ? events[0].timestamp
      : null;
    const earliestPhaseCompletionAt = phaseCompletionReadiness
      .map((completion) => completion.completed_at)
      .filter((timestamp) => Number.isFinite(Date.parse(String(timestamp || ""))))
      .sort((left, right) => String(left).localeCompare(String(right), "en"))[0] || null;
    if (
      taskStartedAt
      && firstTransitionAt
      && Date.parse(taskStartedAt) > Date.parse(firstTransitionAt)
    ) {
      report.errors.push(
        `${label} task start occurred after the first workflow transition; `
        + "replayed or post-transition task-start evidence cannot certify lifecycle completion",
      );
    }
    if (
      taskStartedAt
      && earliestPhaseCompletionAt
      && Date.parse(taskStartedAt) > Date.parse(earliestPhaseCompletionAt)
    ) {
      report.errors.push(
        `${label} task start occurred after the first completed story step; `
        + "replayed or post-completion task-start evidence cannot certify lifecycle completion",
      );
    }
    const entryByPhase = new Map();
    if (workflowCreatedAt) {
      entryByPhase.set(effectiveDefinition.initial_state, {
        entered_at: workflowCreatedAt,
        event_hash: null,
      });
    }
    for (const event of events) {
      if (
        requiredPhases.includes(event.to)
        && !entryByPhase.has(event.to)
        && Number.isFinite(Date.parse(String(event.timestamp || "")))
      ) {
        entryByPhase.set(event.to, {
          entered_at: event.timestamp,
          event_hash: event.event_hash,
        });
      }
    }
    const phaseTimeline = requiredPhases.map((phase, index) => {
      const entry = entryByPhase.get(phase) || null;
      const completion = completionByPhase.get(phase) || null;
      if (!entry) {
        report.errors.push(`${label} has no verified entry into configured phase '${phase}'`);
      }
      if (!completion?.ready) {
        report.errors.push(`${label} has no verified completed story step for configured phase '${phase}'`);
      }
      if (
        entry
        && completion?.completed_at
        && Date.parse(entry.entered_at) > Date.parse(completion.completed_at)
      ) {
        report.errors.push(
          `${label} entered phase '${phase}' after that phase had already been completed`,
        );
      }
      const previousPhase = requiredPhases[index - 1] || null;
      const previousCompletion = previousPhase
        ? completionByPhase.get(previousPhase) || null
        : null;
      if (
        entry
        && previousCompletion?.completed_at
        && Date.parse(entry.entered_at) < Date.parse(previousCompletion.completed_at)
      ) {
        report.errors.push(
          `${label} entered phase '${phase}' before phase '${previousPhase}' was completed`,
        );
      }
      return {
        phase,
        entered_at: entry?.entered_at || null,
        entry_event_hash: entry?.event_hash || null,
        completed_at: completion?.completed_at || null,
        completion_record_id: completion?.step_id || null,
      };
    });

    // Release evidence (terminal delivery, release trace) must be produced
    // during or after the release phase, so this compares against when the
    // workflow entered "release" specifically - not `terminalAt`, which is
    // the entry time of whatever phase is configured as terminal today and
    // may no longer be "release" (for example, once operations follows it).
    // Workflows without a "release" state fall back to the terminal phase,
    // which is what this check always compared against before.
    const releaseEnteredAt = entryByPhase.get("release")?.entered_at || terminalAt || null;
    for (const [dependency, timestamp] of [
      ["terminal delivery", deliveryClosedAt],
      ["latest passing release trace", releaseTrace?.created_at],
    ]) {
      if (
        releaseEnteredAt
        && Number.isFinite(Date.parse(String(timestamp || "")))
        && Date.parse(releaseEnteredAt) > Date.parse(timestamp)
      ) {
        report.errors.push(
          `${label} entered the release phase after the ${dependency}; release entry must precede release evidence`,
        );
      }
    }
    report.lifecycle_workflow = {
      selection_policy: "latest-created-at-then-instance-id:v1",
      story_id: storyId,
      instance_id: instance.id,
      instance_hash: instance.instance_hash,
      effective_hash: effectiveDefinition.effective_hash,
      checkpoint_ref: {
        path: toProjectPath(context, workflowCheckpointPath(context, instanceId)),
        checkpoint_hash: integrity.checkpoint.checkpoint_hash,
        sequence: integrity.checkpoint.sequence,
        last_event_hash: integrity.checkpoint.last_event_hash,
        trace_chain_hash: integrity.checkpoint.trace_chain_hash,
      },
      terminal_state: currentState,
      terminal_event_ref: terminalEvent
        ? {
            event_hash: terminalEvent.event_hash,
            sequence: terminalEvent.sequence,
            timestamp: terminalEvent.timestamp,
          }
        : null,
      event_count: events.length,
      task_start_ref: taskStart
        ? {
            id: taskStart.id,
            path: toProjectPath(context, taskStartPath),
            hash: hashJsonFileValue(taskStart),
            confirmed_at: taskStart.confirmed_at,
          }
        : null,
      phase_timeline: phaseTimeline,
      release_trace_at: releaseTrace?.created_at || null,
      delivery_closed_at: deliveryClosedAt,
    };
  } catch (error) {
    report.errors.push(`${label} cannot be verified: ${error.message}`);
  }
  report.checked.push(label);
}
