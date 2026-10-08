import path from "node:path";
import {
  transitionAssessmentWorkflow,
} from "../assessment-workflow.mjs";
import {
  AUTONOMY_LEVEL_RANK,
  buildDeliveryExecutionProfile,
  buildDeliveryExecutionProfileV2,
  mostRestrictiveAutonomyLevel,
  normalizeAutonomyLevel,
  validateRequirementExecutionProfileIntegrity,
} from "../autonomy-policy.mjs";
import {
  computeStableHash,
} from "../canonical.mjs";
import {
  UserError,
  fail,
} from "../cli/user-error.mjs";
import {
  initializeCreatedLock,
  removeCreatedLockIfOwned,
} from "../created-lock-file.mjs";
import {
  applyBudgetAmendment,
  budgetInputPolicyErrors,
  buildBudgetAmendment,
  completionBudgetStatus,
  evaluateBudgetUsage,
  validateBudgetAmendmentIntegrity,
  validateExecutionBudgetIntegrity,
  validateExecutionUsageReceipt,
} from "../execution-budget.mjs";
import {
  IDENTITY_STAT_OPTIONS,
  fileIdentity,
  hasStableFileIdentity,
} from "../file-identity.mjs";
import {
  MutationGovernanceError,
  assertMutationExecutionAuthorized,
  createProjectMutationGovernance,
  runWithMutationGovernance,
  withGovernedMutation,
} from "../governance/mutation-guard.mjs";
import {
  deliveryAutonomyApprovalGuidance,
  deliveryAutonomyProposalGuidance,
  requirementAutonomyCeilingGuidance,
} from "../human-guidance.mjs";
import {
  assessmentProposalPath,
  autonomyApprovalSubject,
  autonomyLifecycleReceiptHash,
  contractProposalHumanGuidance,
  hasFreshApprovedContractApproval,
  hashApprovalSubject,
  normalizeApprovalSource,
  requireFormalApprovalActor,
  sameStableFileIdentity,
  validateApprovalSourceForActor,
  validateAuthorizationUseReceipt,
  verificationReceiptSatisfies,
} from "../lifecycle/authorization.mjs";
import {
  mergeCapabilityPolicies,
} from "../lifecycle/capability.mjs";
import {
  buildDomainRecord,
  compactText,
  completionReserveRisks,
  getOptionString,
  hashBuffer,
  hashJsonFileValue,
  mergeList,
  mutationGovernanceActor,
  normalizeId,
  normalizeListOption,
  normalizeOptionalDateTime,
  normalizeRawListOption,
  normalizeScalarOption,
  processIsAlive,
  requireCoordinationOverrideActor,
  requireOption,
  sameStableFileSnapshot,
  shortHash,
  shortHashFull,
  stableJson,
} from "../lifecycle/common.mjs";
import {
  CERTIFIED_TERMINAL_LIFECYCLE_SOURCES,
  INTERNAL_LOCK_REMOTE_STALE_MS,
  INTERNAL_LOCK_STALE_MS,
  INTERNAL_LOCK_WAIT_MS,
  LOCK_STATUSES,
  MAX_TEMPLATE_ASSET_BYTES,
  OUTPUT_VISUAL_FORMATS,
  PROJECT_BOOTSTRAP_JOURNAL_FILE_NAME,
  PROJECT_BOOTSTRAP_MANIFEST_FILE_NAME,
  SDLC_DIR,
  workflowStartTraceIndexCache,
  workflowStartTransactionIndexCache,
} from "../lifecycle/constants.mjs";
import {
  buildReleaseGateReceipt,
  deliveryAutonomyPath,
  deliveryAutonomyRoot,
  deliveryExecutionProfileSchemaName,
  deliveryMaterialScope,
  deliveryProviderBindingsFromOptions,
  deliveryTargetAllowedActions,
  localReleaseTargetHadAbsentEntries,
  normalizeGitEvent,
  releaseGateReceiptPath,
  releaseManifestPath,
} from "../lifecycle/delivery.mjs";
import {
  humanGuidanceLines,
  humanGuidanceLocale,
  normalizeLockStatus,
} from "../lifecycle/guidance.mjs";
import {
  autonomyVerificationTechnicalLines,
  formatTaskStartDecision,
  mutationGovernanceEvidencePaths,
  verificationArtifactSha256,
  verificationDimensionStatus,
} from "../lifecycle/output.mjs";
import {
  assertNoSymlinkPathSegments,
  assessmentAmendmentsRoot,
  assessmentApplicationPath,
  assessmentBudgetSnapshotPath,
  assessmentUsageRoot,
  autonomyDecisionsRoot,
  autonomyRevocationsRoot,
  contextOptimizationRuntimeOptions,
  isInsidePath,
  normalizeProjectPathInput,
  projectBootstrapJournalPath,
  toProjectPath,
} from "../lifecycle/project.mjs";
import {
  assertManualTraceActionIsSafe,
  buildTraceRedactionPolicy,
  contractArtifactTypes,
  failTraceIntegrityWrite,
  normalizeTraceOutcome,
  phaseRank,
  requirementAutonomyPath,
  requirementLifecycleRoot,
  requirementPath,
  requirementsRoot,
  storyAcceptanceCriteria,
  storyMutationLockPath,
} from "../lifecycle/story.mjs";
import {
  assessmentWorkflowPath,
  assessmentWorkflowsRoot,
  extendWorkflowTraceChain,
  rewindInterruptedCompletedWorkflow,
  workflowCheckpointPath,
  workflowEventsPath,
  workflowFinalGateReceiptPath,
  workflowInstancePath,
  workflowInstanceRoot,
  workflowInstanceStagingRoot,
  workflowInstanceStartTransactionPath,
  workflowInstancesRoot,
  workflowIntegrityBlockedGuidance,
  workflowCurrentState,
  workflowTraceAnchorErrors,
  workflowTraceIntentMatches,
} from "../lifecycle/workflow.mjs";
import {
  redactValue,
} from "../observability/redaction.mjs";
import {
  buildRequirementRef,
  buildRequirementRevision,
  buildRequirementSupersession,
  requirementContentHash,
  validateRequirementIntegrity,
} from "../requirement-lifecycle.mjs";
import {
  Date,
  console,
  crypto,
  fs,
  os,
  process,
} from "../runtime/host.mjs";
import {
  recoverTraceIntegrity,
  sealTraceEvent,
  withTraceIntegritySnapshot,
} from "../trace-integrity.mjs";
import {
  buildTraceNarrative,
} from "../trace-narrative.mjs";
import {
  validateVerificationReceiptIntegrity,
} from "../verification-levels.mjs";
import {
  assessmentBudgetLineage,
  authorityAssuranceNote,
  budgetUsageFromOptions,
  buildBudgetExceptionQuestion,
  captureContextOptimization,
  describeBudgetUsageLines,
  describeValidationError,
  effectiveAssessmentBudget,
  evaluateAssessmentBudgetUsage,
  loadBudgetAmendmentHostApprovalReceipt,
  loadStoredBudgetAmendmentHostApprovalReceipt,
  readAssessmentApplication,
  readAssessmentProposal,
  readAssessmentUsageReceipts,
  readAssessmentWorkflow,
  recoverAssessmentCompletionFromManifest,
  registerUsageReceiptsInLedger,
  requireCompletionMeteringCoverage,
  sortUsageReceipts,
} from "./assessment.mjs";
import {
  buildApprovalEvidence,
  buildApprovalRecord,
  buildTraceAuthorityMetadata,
  closeContentAuthorization,
  contractProposalPrimarySummary,
  loadAutonomyAuthorityAssurance,
  readAuthorization,
  readAuthorizationUseReceipt,
  recordOrReuseAuthorizationUse,
  requireAutomationAuthorization,
  writeAutonomyApproval,
  writeTaskStartReceipt,
} from "./authorization.mjs";
import {
  loadCapabilityBindings,
  loadCapabilityPolicy,
  loadCapabilityRecommendationsForContract,
} from "./capability.mjs";
import {
  assertOwnedWriterTemporary,
  assertRecordSchema,
  buildAttribution,
  buildRunMetadata,
  compactTimestamp,
  createDirectoryAllowingConcurrentCreation,
  hashedFileReference,
  isExpired,
  loadOptionalJsonInput,
  now,
  removeOwnedWriterTemporary,
  sleepSync,
  uniqueRecordSuffix,
  writerTemporaryMatches,
} from "./common.mjs";
import {
  CLI_OPERATION_CONTEXT,
  NO_FOLLOW_FLAG,
} from "./definitions.mjs";
import {
  assertCurrentLocalReleaseTargetState,
  assertDeliveryProfileReservationUnique,
  assertReleaseManifestIntegrity,
  currentDeliveryAutonomyInputs,
  currentDeliveryExecutionState,
  effectiveDeliveryProfileStatus,
  ensureRevokedDeliveryCloseReceipt,
  evaluateDeliveryAutonomy,
  localReleaseDestinationsVisibleToGit,
  localReleaseProtectedTargetState,
  localSmokeArgumentPathCandidate,
  localSmokeExecutionBoundary,
  readDeliveryAutonomyProfile,
} from "./delivery.mjs";
import {
  buildGitMetadata,
  resolveExactGitWorkspacePath,
} from "./git.mjs";
import {
  buildDependencyStatus,
  effectiveRequirementStatus,
} from "./guidance.mjs";
import {
  assertDirectoryIdentity,
  captureDirectoryIdentity,
  deliveryConcreteIdentity,
  directoryIdentityMatches,
  ensureInitialized,
  loadEffectiveDefinitionForInstance,
  projectBootstrapArtifactSpecifications,
  projectBootstrapDirectoryPaths,
} from "./migration.mjs";
import {
  readContextOptimizationObservations,
} from "./observatory.mjs";
import {
  buildTraceEvidenceRefs,
  output,
  outputContractsRoot,
  readOutputRegistry,
  snapshotManualTraceEvidence,
  validateContractOutputRefsForCreate,
} from "./output.mjs";
import {
  assertContextSourcePathSafe,
  pathEntryExistsNoFollow,
  resolveProjectFilePath,
  verifyOpenFileMatchesPath,
} from "./project.mjs";
import {
  buildTaskStartDecision,
  inspectTaskStartReplacementBoundary,
} from "./route.mjs";
import {
  appendTraceEvent,
  assertCanonicalRequirementWriteScope,
  assertRequirementReadyForDownstream,
  buildContract,
  buildRequirementProfileFor,
  effectiveStoryLifecycleProjection,
  isClaimExpired,
  linkStoryToContractAfterCreate,
  normalizeRequirementWritePaths,
  readContractById,
  readRequirement,
  readRequirementAutonomyProfile,
  readStory,
  readStoryStepRecords,
  requirementWriteScopeWarnings,
  resolveRequirementSources,
  storyPhaseRank,
  storyRequirementExecutionContext,
  traceIntegrityOptions,
  validateContractReadinessForCreate,
  validateRequirementSourceHashes,
  validateStoryContractLinkForCreate,
} from "./story.mjs";
import {
  consumeStandingDeliveryApproval,
  holdStandingApprovalLock,
  standingAuthorityAssurance,
  standingProfileProposalExtension,
  traceStandingApprovalEvent,
} from "./standing.mjs";
import {
  assertNoPendingWorkflowTraceTransaction,
  currentStoryBoundWorkflowInstance,
  ensureWorkflowDirectoryDurably,
  inspectWorkflowRuntimeIntegrity,
  maybeCrashWorkflowStartForTest,
  prepareWorkflowStartStaging,
  readCompletedWorkflowInstance,
  readWorkflowEvents,
  removeWorkflowFileDurably,
  syncWorkflowDirectory,
  syncWorkflowFile,
  truncateWorkflowFileDurably,
  workflowJsonLinesAtAnchor,
  workflowStartMaterialErrors,
  workflowTraceBytes,
  workflowTraceSealTestHooks,
} from "./workflow.mjs";
import {
  fileURLToPath,
} from "node:url";

export function verifiedMutationGovernanceActor() {
  let credential;
  let assurance;
  try {
    if (typeof process.getuid === "function") {
      credential = `uid:${process.getuid()}`;
    } else {
      credential = `user:${os.userInfo().username}`;
    }
    assurance = "host_os_identity";
  } catch {
    return null;
  }
  const identityHash = crypto.createHash("sha256")
    .update(`${process.platform}\0${credential}`)
    .digest("hex")
    .slice(0, 32);
  return {
    verified: true,
    assurance,
    actor: {
      type: "system",
      id: `host-user-${identityHash}`,
      issuer: `os-${process.platform}`,
    },
  };
}

export async function dispatchWithMutationGovernance(registry, resolution, invocation) {
  const { context, options } = invocation;
  const governance = createProjectMutationGovernance({
    root: context.root,
    governance_policy: context.config?.governance_policy,
    canonical_action: resolution?.canonical_action,
    command_path: resolution?.canonical_path?.join(" "),
    actor: mutationGovernanceActor(options),
    verified_actor: verifiedMutationGovernanceActor(),
    evidence_paths: mutationGovernanceEvidencePaths(options),
  });
  context.mutationGovernanceObservations = governance.observations;
  try {
    return await runWithMutationGovernance(
      governance,
      () => registry.dispatch(resolution, invocation),
    );
  } finally {
    try {
      emitMutationAuditSinkWarning(governance, options);
    } catch {
      // A warning channel must never replace the command's primary result.
    }
  }
}

export function emitMutationAuditSinkWarning(governance, options) {
  const unavailable = governance.observations.some((outcome) =>
    outcome?.reason_codes?.includes("mutation.audit_sink_unavailable"));
  if (!unavailable) return;
  const message = "The command finished, but its safety audit record could not be saved. "
    + "Check the configured audit-events directory; until it is fixed, the audit history is incomplete.";
  if (options.json) {
    console.error(JSON.stringify({
      kind: "agentic_sdlc_warning",
      code: "MUTATION_AUDIT_RECORD_NOT_SAVED",
      message,
    }));
    return;
  }
  console.error(`Warning: ${message}`);
}

export function completeWorkflowStartTransactionLocked(context, journal) {
  const instanceId = journal.request.instance_id;
  assertRecordSchema(journal.instance, "workflow-instance.schema.json", `Workflow instance ${instanceId}`);
  assertRecordSchema(journal.checkpoint, "workflow-checkpoint.schema.json", `Workflow checkpoint for instance ${instanceId}`);
  const finalRoot = workflowInstanceRoot(context, instanceId);
  const stagingRoot = workflowInstanceStagingRoot(context, instanceId);
  if (fs.existsSync(finalRoot)) {
    const errors = workflowStartMaterialErrors(context, finalRoot, journal);
    if (errors.length > 0) fail(`Interrupted workflow start cannot trust the published instance: ${errors.join("; ")}`);
    if (fs.existsSync(stagingRoot)) {
      fail(`Interrupted workflow start has both staged and published data for ${instanceId}.`);
    }
  } else {
    prepareWorkflowStartStaging(context, journal);
    maybeCrashWorkflowStartForTest("after-staging-before-publish");
    renamePathGoverned(stagingRoot, finalRoot);
    syncWorkflowDirectory(path.dirname(stagingRoot));
    syncWorkflowDirectory(workflowInstancesRoot(context));
  }
  for (const fileName of ["instance.json", "events.jsonl", "checkpoint.json"]) {
    syncWorkflowFile(path.join(finalRoot, fileName));
  }
  maybeCrashWorkflowStartForTest("after-publish-before-trace");
  if (
    process.env.NODE_ENV === "test"
    && process.env.AGENTIC_SDLC_TEST_WORKFLOW_START_TRACE_FAILURE === "before-append"
  ) {
    fail("Simulated workflow start trace interruption before append.");
  }
  ensureWorkflowTraceRecordLocked(
    context,
    path.join(context.sdlcRoot, "traces", "project.jsonl"),
    journal.trace_event,
    journal.trace_anchor,
  );
  removeWorkflowFileDurably(workflowInstanceStartTransactionPath(context, instanceId));
}

export function inspectWorkflowTraceOwnershipConflictsLocked(context, instanceId, tracePath) {
  if (!fs.existsSync(tracePath)) return [];
  let traces;
  try {
    traces = readProjectText(context, tracePath)
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    return [`project audit trace cannot be verified: ${error.message}`];
  }
  return traces
    .filter((entry) =>
      ["workflow.instance.start", "workflow.instance.transition"].includes(entry?.action)
      && Array.isArray(entry?.related)
      && entry.related[0] === instanceId)
    .map((entry) => `trace ${entry.id || "without-id"} already claims this instance`);
}

export function inspectWorkflowTraceCoverageLocked(context, instanceId, instance, events, checkpoint, tracePath) {
  if (!fs.existsSync(tracePath)) {
    return {
      valid: false,
      tracePath,
      errors: [`Workflow instance ${instanceId} is missing its project audit trace.`],
    };
  }
  let traces;
  try {
    const snapshot = withTraceIntegritySnapshot(
      traceIntegrityOptions(context, tracePath),
      ({ integrity, records }) => ({ integrity, records }),
    );
    if (!snapshot.integrity.valid) {
      return {
        valid: false,
        tracePath,
        errors: snapshot.integrity.errors.map((entry) =>
          `Workflow instance ${instanceId} project audit trace failed integrity verification (${entry.code || "invalid"}).`),
      };
    }
    traces = snapshot.records
      .filter((entry) => entry.valid === true)
      .map((entry) => entry.event);
  } catch (error) {
    return {
      valid: false,
      tracePath,
      errors: [`Workflow instance ${instanceId} project audit trace cannot be verified: ${error.message}`],
    };
  }

  const errors = [];
  const orderedWorkflowTraces = [];
  const expectedStartId = `TR-WF-START-${String(instance.instance_hash || "").slice(0, 24)}`;
  const startTraces = traces.filter((entry) =>
    entry?.id === expectedStartId
    || (
      entry?.action === "workflow.instance.start"
      && Array.isArray(entry?.related)
      && entry.related[0] === instanceId
    ));
  if (startTraces.length !== 1) {
    errors.push(`Workflow instance ${instanceId} must have exactly one matching start trace.`);
  } else {
    const startTrace = startTraces[0];
    orderedWorkflowTraces.push(startTrace);
    if (
      startTrace.id !== expectedStartId
      || startTrace.action !== "workflow.instance.start"
      || startTrace.created_at !== instance.created_at
      || !Array.isArray(startTrace.related)
      || startTrace.related[0] !== instanceId
    ) {
      errors.push(`Workflow instance ${instanceId} start trace does not match its immutable header.`);
    }
  }

  const expectedTransitionIds = new Set();
  for (const event of events) {
    const expectedId = `TR-WF-${String(event.event_hash || "")}`;
    expectedTransitionIds.add(expectedId);
    const matching = traces.filter((entry) =>
      entry?.id === expectedId
      || (
        entry?.action === "workflow.instance.transition"
        && Array.isArray(entry?.related)
        && entry.related[0] === instanceId
        && entry.related[1] === event.event_hash
      ));
    if (matching.length !== 1) {
      errors.push(`Workflow event ${event.event_hash || "unknown"} must have exactly one matching transition trace.`);
      continue;
    }
    const trace = matching[0];
    orderedWorkflowTraces.push(trace);
    if (
      trace.id !== expectedId
      || trace.action !== "workflow.instance.transition"
      || trace.created_at !== event.timestamp
      || !Array.isArray(trace.related)
      || !trace.related.includes(instanceId)
      || !trace.related.includes(event.event_hash)
    ) {
      errors.push(`Workflow event ${event.event_hash || "unknown"} transition trace does not match its history record.`);
    }
  }
  const unexpectedTransitions = traces.filter((entry) =>
    entry?.action === "workflow.instance.transition"
    && Array.isArray(entry?.related)
    && entry.related[0] === instanceId
    && !expectedTransitionIds.has(entry.id));
  if (unexpectedTransitions.length > 0) {
    errors.push(`Workflow instance ${instanceId} has transition traces that are absent from its event history.`);
  }
  if (orderedWorkflowTraces.length === events.length + 1) {
    const positions = orderedWorkflowTraces.map((trace) => traces.indexOf(trace));
    if (positions.some((position, index) => index > 0 && position <= positions[index - 1])) {
      errors.push(`Workflow instance ${instanceId} audit traces are not in the same order as its event history.`);
    }
    try {
      const observedTraceChain = orderedWorkflowTraces.reduce(
        (previous, trace) => extendWorkflowTraceChain(previous, trace),
        null,
      );
      if (checkpoint.trace_chain_hash !== observedTraceChain) {
        errors.push(`Workflow instance ${instanceId} audit trace content differs from its durable checkpoint.`);
      }
    } catch (error) {
      errors.push(`Workflow instance ${instanceId} audit trace chain cannot be verified: ${error.message}`);
    }
  }
  return { valid: errors.length === 0, tracePath, errors: Array.from(new Set(errors)) };
}

export function blockWorkflowOnIntegrityFailure(context, options, instanceId, integrity, operation) {
  const checkpointPath = integrity.checkpointPath || workflowCheckpointPath(context, instanceId);
  const guidance = workflowIntegrityBlockedGuidance(options, integrity);
  output(options, {
    schema_version: "workflow-instance-integrity-blocked:v1",
    status: "blocked",
    error_code: "WORKFLOW_HISTORY_INTEGRITY_FAILED",
    instance_id: instanceId,
    operation,
    integrity: "invalid",
    errors: integrity.errors || [],
    recovery: integrity.recovery_available === true
      ? {
          available: true,
          request_id: integrity.recovery_request_id,
          target_state: integrity.recovery_target_state,
        }
      : { available: false },
    checkpoint_path: toProjectPath(context, checkpointPath),
    human_guidance: guidance,
  }, humanGuidanceLines(guidance, [
    `Instance: ${instanceId}`,
    `Operation blocked: ${operation}`,
    `Checkpoint path: ${toProjectPath(context, checkpointPath)}`,
    ...(integrity.recovery_available === true ? [
      `Recovery request id: ${integrity.recovery_request_id}`,
      `Recovery destination: ${integrity.recovery_target_state}`,
    ] : []),
    ...(integrity.errors || []).map((error) => `Integrity error: ${error}`),
  ], options));
  process.exitCode = 1;
}

export function workflowJsonLineRecordStateLocked(
  filePath,
  value,
  anchor,
  identityKey,
  recordLabel,
  { recordsMatch = (stored, expected) => stableJson(stored) === stableJson(expected) } = {},
) {
  const anchorErrors = workflowTraceAnchorErrors(anchor);
  if (anchorErrors.length > 0) return { valid: false, exists: false, repairable: false, errors: anchorErrors };
  const bytes = workflowTraceBytes(filePath);
  if (bytes.length < anchor.size_bytes) {
    return { valid: false, exists: false, repairable: false, errors: [`${recordLabel} is shorter than the transaction anchor.`] };
  }
  const prefix = bytes.subarray(0, anchor.size_bytes);
  const prefixHash = crypto.createHash("sha256").update(prefix).digest("hex");
  if (prefixHash !== anchor.prefix_hash) {
    return { valid: false, exists: false, repairable: false, errors: [`${recordLabel} prefix differs from the transaction anchor.`] };
  }
  let parsed = null;
  try {
    parsed = bytes.toString("utf8").split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    // A crash may leave only a prefix of the one deterministic line owned by
    // this transaction. That exact suffix is the only malformed state that
    // recovery is allowed to truncate.
  }
  const expectedLine = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  const suffix = bytes.subarray(anchor.size_bytes);
  if (parsed) {
    const matches = parsed.filter((entry) => entry?.[identityKey] === value?.[identityKey]);
    if (matches.length > 1 || (matches.length === 1 && !recordsMatch(matches[0], value))) {
      return {
        valid: false,
        exists: matches.length > 0,
        repairable: false,
        errors: [`${recordLabel} identity ${value?.[identityKey]} is duplicated or has different content.`],
      };
    }
    return {
      valid: true,
      exists: matches.length === 1,
      stored_record: matches.length === 1 ? matches[0] : null,
      repairable: false,
      suffix_bytes: suffix.length,
      expected_line_bytes: expectedLine.length,
      exact_suffix: suffix.equals(expectedLine),
      errors: [],
    };
  }
  const repairable = suffix.length > 0
    && suffix.length < expectedLine.length
    && expectedLine.subarray(0, suffix.length).equals(suffix);
  return repairable
    ? {
        valid: true,
        exists: false,
        repairable: true,
        suffix_bytes: suffix.length,
        expected_line_bytes: expectedLine.length,
        exact_suffix: false,
        errors: [],
      }
    : { valid: false, exists: false, repairable: false, errors: [`${recordLabel} contains a malformed suffix outside the current transaction.`] };
}

export function workflowTraceRecordStateLocked(filePath, value, anchor) {
  return workflowJsonLineRecordStateLocked(
    filePath,
    value,
    anchor,
    "id",
    "Workflow trace",
    { recordsMatch: workflowTraceIntentMatches },
  );
}

export function workflowEventRecordStateLocked(filePath, value, anchor) {
  return workflowJsonLineRecordStateLocked(filePath, value, anchor, "event_hash", "Workflow event history");
}

export function appendWorkflowJsonLineUnlocked(filePath, value) {
  return withGovernedMutation({ operation: "file.append", path: filePath }, () =>
    appendWorkflowJsonLineUnlockedAuthorized(filePath, value));
}

export function appendWorkflowJsonLineUnlockedAuthorized(filePath, value) {
  assertMutationExecutionAuthorized({ operation: "file.append", path: filePath });
  assertNoSymlinkPathSegments(filePath);
  ensureWorkflowDirectoryDurably(path.dirname(filePath));
  const parentIdentity = captureDirectoryIdentity(path.dirname(filePath));
  let descriptor;
  try {
    assertMutationExecutionAuthorized({ operation: "file.append", path: filePath });
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | NO_FOLLOW_FLAG,
      0o600,
    );
    verifyOpenFileMatchesPath(descriptor, filePath, parentIdentity);
    assertMutationExecutionAuthorized({ operation: "file.append", path: filePath });
    fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  syncWorkflowDirectory(path.dirname(filePath));
}

export function recoverWorkflowTraceIntegrityAtAnchorLocked(context, filePath, anchor) {
  const anchored = workflowJsonLinesAtAnchor(filePath, anchor, "Workflow trace");
  if (!anchored.valid) fail(anchored.errors.join("; "));
  try {
    recoverTraceIntegrity(traceIntegrityOptions(context, filePath));
  } catch (error) {
    // A pre-integrity interrupted workflow may have left the exact partial
    // intent described by its journal. That one legacy case is repaired below;
    // every other integrity failure remains fail-closed.
    if (error?.code !== "legacy_prefix_incomplete") {
      failTraceIntegrityWrite(error);
    }
  }
  const recoveredAnchor = workflowJsonLinesAtAnchor(filePath, anchor, "Workflow trace");
  if (!recoveredAnchor.valid) fail(recoveredAnchor.errors.join("; "));
}

export function ensureWorkflowTraceRecordLocked(context, filePath, value, anchor) {
  let repairedLegacyRawAppend = false;
  const beforeRecovery = workflowTraceRecordStateLocked(filePath, value, anchor);
  if (
    beforeRecovery.valid
    && beforeRecovery.exists
    && beforeRecovery.stored_record?._trace_integrity === undefined
  ) {
    if (!beforeRecovery.exact_suffix) {
      fail(`Legacy workflow trace ${value.id} is not the exact transaction suffix; later audit records must be preserved.`);
    }
    const legacySnapshot = workflowTraceIntegritySnapshotLocked(context, filePath);
    if (legacySnapshot.integrity.valid && legacySnapshot.integrity.initialized) {
      syncWorkflowFile(filePath);
      return {
        repaired: false,
        appended: false,
        legacy: true,
        event: beforeRecovery.stored_record,
      };
    }
    const safeUncommittedRawSuffix = (
      legacySnapshot.integrity.valid
      && legacySnapshot.integrity.initialized === false
    ) || (
      legacySnapshot.integrity.valid === false
      && legacySnapshot.integrity.errors.length > 0
      && legacySnapshot.integrity.errors.every((entry) => entry.code === "checkpoint_drift")
    );
    if (!safeUncommittedRawSuffix) {
      fail(`Legacy workflow trace ${value.id} is not a safely recoverable uncommitted suffix.`);
    }
    truncateWorkflowFileDurably(filePath, anchor.size_bytes);
    repairedLegacyRawAppend = true;
  }
  recoverWorkflowTraceIntegrityAtAnchorLocked(context, filePath, anchor);
  let state = workflowTraceRecordStateLocked(filePath, value, anchor);
  if (!state.valid) fail(state.errors.join("; "));
  if (state.exists) {
    const storedEvent = assertWorkflowStoredTraceIntegrityLocked(context, filePath, value);
    syncWorkflowFile(filePath);
    return { repaired: repairedLegacyRawAppend, appended: false, event: storedEvent };
  }
  const repaired = repairedLegacyRawAppend || state.repairable;
  if (repaired) truncateWorkflowFileDurably(filePath, anchor.size_bytes);
  const storedEvent = sealPreparedTraceEventLocked(context, filePath, value);
  state = workflowTraceRecordStateLocked(filePath, value, anchor);
  if (!state.valid || !state.exists || !workflowTraceIntentMatches(storedEvent, value)) {
    fail(state.errors[0] || `Workflow trace ${value.id} was not committed exactly once.`);
  }
  const verifiedEvent = assertWorkflowStoredTraceIntegrityLocked(context, filePath, value);
  return { repaired, appended: true, event: verifiedEvent };
}

export function assertWorkflowStoredTraceIntegrityLocked(context, tracePath, expectedIntent) {
  const snapshot = workflowTraceIntegritySnapshotLocked(context, tracePath);
  if (!snapshot.integrity.valid) {
    fail(`Workflow trace integrity verification failed: ${snapshot.integrity.errors.map((entry) => entry.code).join(", ") || "invalid trace"}`);
  }
  const matches = snapshot.records
    .filter((entry) => entry.valid === true && entry.event?.id === expectedIntent?.id)
    .map((entry) => entry.event);
  if (
    matches.length !== 1
    || !workflowTraceIntentMatches(matches[0], expectedIntent)
    || matches[0]?._trace_integrity?.schema_version !== "trace-integrity-event:v1"
  ) {
    fail(`Workflow trace ${expectedIntent?.id || "unknown"} is missing, duplicated, unsealed, or has different content.`);
  }
  return matches[0];
}

export function workflowTraceIntegritySnapshotLocked(context, tracePath) {
  try {
    return withTraceIntegritySnapshot(
      traceIntegrityOptions(context, tracePath),
      ({ integrity, records }) => ({ integrity, records }),
    );
  } catch (error) {
    failTraceIntegrityWrite(error);
  }
}

export function ensureWorkflowEventRecordLocked(filePath, value, anchor) {
  assertRecordSchema(value, "workflow-transition-event.schema.json", `Workflow transition event ${value?.event_hash || "unknown"}`);
  let state = workflowEventRecordStateLocked(filePath, value, anchor);
  if (!state.valid) fail(state.errors.join("; "));
  if (state.exists && !state.exact_suffix) {
    fail("Workflow event history contains records after the event owned by the pending transaction.");
  }
  if (state.exists) {
    syncWorkflowFile(filePath);
    return { repaired: false, appended: false };
  }
  if (state.suffix_bytes > 0 && !state.repairable) {
    fail("Workflow event history advanced outside the pending transaction.");
  }
  const repaired = state.repairable;
  if (repaired) truncateWorkflowFileDurably(filePath, anchor.size_bytes);
  appendWorkflowJsonLineUnlocked(filePath, value);
  state = workflowEventRecordStateLocked(filePath, value, anchor);
  if (!state.valid || !state.exists || !state.exact_suffix) {
    fail(state.errors[0] || `Workflow event ${value.event_hash} was not committed exactly once.`);
  }
  return { repaired, appended: true };
}

export function startTaskLocked(context, options) {
  let decision = buildTaskStartDecision(context, options);
  const executionRequested = (candidate) => {
    const autonomyAuthorizedStart = candidate.autonomy_decision?.autonomous === true
      || candidate.autonomy?.task_start_automatic === true;
    return (
      candidate.execution_allowed
      && (options["confirm-start"] || autonomyAuthorizedStart)
      && !candidate.assessment_proposal_id
    );
  };
  if (executionRequested(decision)) {
    const boundaryStoryId = decision.story_id;
    const boundaryContractId = decision.contract_id;
    const releaseTaskStartBoundaryLock = acquireFileLock(boundaryStoryId
      ? path.join(
        context.sdlcRoot,
        "stories",
        boundaryStoryId,
        "task-start-boundary.lock",
      )
      : path.join(context.sdlcRoot, "reports", "project-task-start-boundary.lock"));
    let releaseStoryMutationLock = () => {};
    let releaseContractLock = () => {};
    let releaseWorkflowEventLock = () => {};
    try {
      if (boundaryStoryId) {
        releaseStoryMutationLock = acquireFileLock(
          storyMutationLockPath(context, boundaryStoryId),
        );
      }
      if (boundaryContractId) {
        releaseContractLock = acquireFileLock(path.join(
          context.sdlcRoot,
          "contracts",
          `${normalizeId(boundaryContractId)}.json.lock`,
        ));
      }
      // The first decision is useful for presenting a plan, but it is not a
      // write authorization. Rebuild it under the story boundary lock so a
      // concurrent acceptance, contract, profile, or workflow mutation cannot
      // slip between validation and the immutable task-start receipt.
      decision = buildTaskStartDecision(context, options);
      if (decision.story_id !== boundaryStoryId) {
        fail(
          `Task start story changed while acquiring its boundary lock `
          + `(${boundaryStoryId || "(project)"} -> ${decision.story_id || "(project)"}); retry from current intent.`,
        );
      }
      if (decision.contract_id !== boundaryContractId) {
        fail(
          `Task start contract changed while acquiring its mutation locks `
          + `(${boundaryContractId || "(none)"} -> ${decision.contract_id || "(none)"}); retry from current intent.`,
        );
      }
      if (!executionRequested(decision)) {
        output(options, decision, formatTaskStartDecision(decision));
        return;
      }
      const existingTaskStartPath = decision.story_id
        ? path.join(context.sdlcRoot, "stories", decision.story_id, "task-start.json")
        : path.join(context.sdlcRoot, "reports", "project-task-start.json");
      let successorBoundary = null;
      if (pathEntryExistsNoFollow(existingTaskStartPath)) {
        const replacement = inspectTaskStartReplacementBoundary(
          context,
          existingTaskStartPath,
          {
            story_id: decision.story_id,
            contract_id: decision.contract_id,
            delivery_profile_id: decision.delivery_profile_id,
          },
        );
        if (!replacement.allowed) {
          fail(
            `Task start is already immutably recorded at ${toProjectPath(context, existingTaskStartPath)} `
            + `(${replacement.snapshot.sha256}; ${replacement.reason}). `
            + "Continue the existing governed run instead of starting it again.",
          );
        }
        decision.previous_task_start_receipt = {
          path: toProjectPath(context, existingTaskStartPath),
          sha256: replacement.snapshot.sha256,
          contract_id: replacement.receipt.contract_id || null,
          delivery_profile_id: replacement.receipt.delivery_profile_ref?.id || null,
        };
        successorBoundary = replacement;
      }
      const attribution = buildAttribution(context, options, "task.start.confirm");
      const taskContract = decision.contract_id
        ? readContractById(context, decision.contract_id, { missingOk: true })
        : null;
      const authorization = attribution.actor.type === "human" || decision.autonomy?.task_start_automatic === true
        ? null
        : requireAutomationAuthorization(context, options, attribution.action, {
            label: `task start${decision.story_id ? ` for ${decision.story_id}` : ""}`,
            subject_id: decision.story_id || "PROJECT",
            artifact_types: contractArtifactTypes(taskContract || {}),
          });
      decision.authorization_ref = authorization?.id || null;
      decision.authorization_use_ref = authorization?.__use_receipt?.path || null;
      if (decision.story_id) {
        workflowStartTraceIndexCache.delete(context);
        workflowStartTransactionIndexCache.delete(context);
        const workflowProbe = { errors: [] };
        const selectedWorkflow = currentStoryBoundWorkflowInstance(
          context,
          decision.story_id,
          workflowProbe,
        );
        if (workflowProbe.errors.length > 0) {
          fail(
            `Cannot bind task start to the current story workflow: ${workflowProbe.errors.join("; ")}`,
          );
        }
        if (selectedWorkflow) {
          const { instance } = readCompletedWorkflowInstance(context, selectedWorkflow.entry);
          const { effectiveDefinition } = loadEffectiveDefinitionForInstance(context, instance);
          const eventsPath = workflowEventsPath(context, selectedWorkflow.entry);
          releaseWorkflowEventLock = acquireFileLock(`${eventsPath}.lock`);
          const events = readWorkflowEvents(context, selectedWorkflow.entry);
          const integrity = inspectWorkflowRuntimeIntegrity(
            context,
            selectedWorkflow.entry,
            instance,
            effectiveDefinition,
            events,
          );
          if (!integrity.valid) {
            fail(
              `Cannot bind task start to workflow ${instance.id}: `
              + `${(integrity.errors || []).join("; ") || "invalid workflow history"}`,
            );
          }
          const successorOfWorkflowRun = successorBoundary?.workflow_bound === true;
          if (successorOfWorkflowRun) {
            // A successor delivery continues the same story-bound workflow run
            // that the replaced delivery started; it never starts another one.
            const previousRef = successorBoundary.receipt.workflow_instance_ref || {};
            const currentState = workflowCurrentState(integrity.replay, instance, effectiveDefinition);
            if (
              previousRef.id !== instance.id
              || previousRef.hash !== instance.instance_hash
              || previousRef.path !== toProjectPath(context, workflowInstancePath(context, selectedWorkflow.entry))
            ) {
              fail(
                `Story ${decision.story_id} successor delivery must continue workflow ${previousRef.id || "(unknown)"} `
                + `bound by the replaced delivery, not ${instance.id}.`,
              );
            }
            if ((effectiveDefinition.states || []).find((state) => state.id === currentState)?.terminal === true) {
              fail(
                `Story ${decision.story_id} workflow ${instance.id} is already terminal; `
                + "a new delivery needs a new story.",
              );
            }
          } else if (events.length > 0) {
            fail(
              `Story ${decision.story_id} workflow ${instance.id} already has ${events.length} transition event(s). `
              + "Task start must be recorded after workflow start and before the first workflow transition.",
            );
          }
          const completedSteps = successorOfWorkflowRun
            ? []
            : readStoryStepRecords(context, decision.story_id)
              .filter((record) => record.status === "completed");
          if (completedSteps.length > 0) {
            fail(
              `Story ${decision.story_id} already has completed lifecycle steps (${completedSteps
                .map((record) => record.phase || record.step)
                .filter(Boolean)
                .join(", ")}). `
              + "Task start must be recorded before the first completed story step.",
            );
          }
          decision.workflow_instance_ref = {
            id: instance.id,
            path: toProjectPath(context, workflowInstancePath(context, selectedWorkflow.entry)),
            hash: instance.instance_hash,
          };
        } else {
          decision.workflow_instance_ref = null;
          decision.lifecycle_certification_warning =
            `Story ${decision.story_id} has no pre-task story-bound workflow. `
            + "This task may continue for legacy compatibility, but --lifecycle-complete cannot certify it.";
        }
      }
      let receiptTransaction;
      let traceMutation;
      let trace;
      try {
        receiptTransaction = writeTaskStartReceipt(
          context,
          decision,
          attribution,
          authorization,
        );
        decision.task_start_receipt = receiptTransaction.path;
        traceMutation = prepareGovernedTraceMutation(context, decision.story_id || null, {
          type: "decision",
          summary: `${options["confirm-start"] ? "Confirmed" : "Profile-authorized"} start for ${decision.route}${decision.contract_id ? ` under ${decision.contract_id}` : ""}`
            + (successorBoundary?.predecessor
              ? `; replaces delivery ${successorBoundary.predecessor.delivery_profile_id} `
                + `(${successorBoundary.predecessor.terminal_status})`
              : ""),
          action: "task.start.confirm",
          actor: attribution.actor,
          ...buildTraceAuthorityMetadata(context, options, attribution),
          evidence: [
            decision.contract?.path,
            decision.delivery_profile_path,
            decision.autonomy_decision_path,
            decision.execution_context_preflight,
            decision.previous_task_start_receipt?.path,
            successorBoundary?.predecessor?.close_receipt_path,
          ].filter(Boolean),
          related: [
            decision.story_id,
            decision.contract_id,
            decision.delivery_profile_id,
            decision.autonomy_decision?.id,
            successorBoundary?.predecessor?.delivery_profile_id,
          ].filter(Boolean),
          authorization_ref: authorization?.id || null,
          git: attribution.git,
          run: attribution.run,
        });
        try {
          trace = traceMutation.commit();
        } catch (error) {
          trace = traceMutation.recoverCommitted();
          if (!trace) throw error;
        }
      } catch (error) {
        if (receiptTransaction && !trace) {
          receiptTransaction.rollback();
        }
        throw error;
      } finally {
        traceMutation?.release();
      }
      decision.confirmation_trace_id = trace.id;
    } finally {
      releaseWorkflowEventLock();
      releaseContractLock();
      releaseStoryMutationLock();
      releaseTaskStartBoundaryLock();
    }
  }
  output(options, decision, formatTaskStartDecision(decision));
}

export function stableWorkspacePathSnapshot(context, entry) {
  const filePath = resolveExactGitWorkspacePath(context, entry.path);
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return {
      path: entry.path,
      status: entry.status,
      file_type: "missing",
      mode: null,
      content_sha256: null,
    };
  }
  if (stat.isFile()) {
    const snapshot = readStableRegularFileBuffer(filePath, context.root);
    return {
      path: entry.path,
      status: entry.status,
      file_type: snapshot.file_type,
      mode: snapshot.mode,
      content_sha256: snapshot.sha256,
    };
  }
  if (stat.isSymbolicLink()) {
    const snapshot = readStableSymlinkSnapshot(filePath, context.root);
    return {
      path: entry.path,
      status: entry.status,
      file_type: snapshot.file_type,
      mode: snapshot.mode,
      content_sha256: snapshot.sha256,
    };
  }
  if (stat.isDirectory()) {
    fail(
      `Execution context preflight cannot safely exempt dirty directory or submodule ${JSON.stringify(entry.path)}. `
      + "Commit, clean, stash, or isolate that nested worktree before task start.",
    );
  }
  fail(
    `Execution context preflight cannot safely snapshot non-regular workspace path ${JSON.stringify(entry.path)}.`,
  );
}

export function readStableSymlinkSnapshot(filePath, boundaryRoot) {
  assertNoSymlinkPathSegments(path.dirname(filePath), boundaryRoot);
  const parentIdentity = captureDirectoryIdentity(path.dirname(filePath));
  const before = fs.lstatSync(filePath);
  if (!before.isSymbolicLink()) {
    fail(`Workspace path changed type while snapshotting symlink: ${filePath}`);
  }
  const target = fs.readlinkSync(filePath);
  assertDirectoryIdentity(path.dirname(filePath), parentIdentity);
  const after = fs.lstatSync(filePath);
  if (
    !after.isSymbolicLink()
    || !sameStableFileIdentity(before, after)
    || before.mode !== after.mode
    || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs
    || before.ctimeMs !== after.ctimeMs
  ) {
    fail(`Symlink changed while creating its stable snapshot: ${filePath}`);
  }
  return {
    file_type: "symlink",
    mode: after.mode & 0o7777,
    sha256: hashBuffer(Buffer.from(`symlink:${target}`, "utf8")),
  };
}

export function userFriendlyBlockingReason(code, locale = "en", decision = {}) {
  if (code === "autonomy_selection_required") {
    if (decision.delivery_kind === "local_release") {
      return locale === "it"
        ? "Scegli quanto posso lavorare in autonomia per questo solo rilascio locale; nessuna scelta precedente viene riutilizzata."
        : "Choose how independently I may work for this local release only; no earlier choice is reused.";
    }
    if (decision.delivery_kind === "pull_request") {
      return locale === "it"
        ? "Scegli quanto posso lavorare in autonomia per questa sola PR; nessuna scelta precedente viene riutilizzata."
        : "Choose how independently I may work for this pull request only; no earlier choice is reused.";
    }
    return locale === "it"
      ? "Definisci la destinazione di questa consegna e scegli un modo di lavorare valido soltanto per essa."
      : "Define this delivery's destination and choose a working mode that applies only to it.";
  }
  if (locale === "it") {
    const italianExplanations = {
      autonomy_checkpoint_required: "La consegna può procedere da sola tra i momenti di revisione concordati, ma ora ha raggiunto un passaggio che richiede una nuova conferma.",
      autonomy_human_approval_required: "Il perimetro di autonomia scelto richiede ancora una decisione umana esplicita prima di diventare attivo.",
      autonomy_policy_blocked: "L’autonomia richiesta è fuori dai limiti di sicurezza approvati, quindi l’esecuzione resta ferma.",
      autonomy_profile_contract_mismatch: "La scelta di autonomia appartiene a un incarico diverso e non può essere riutilizzata per questa attività.",
      autonomy_profile_invalid: "La scelta di autonomia non corrisponde più a repository, branch, percorsi, azioni o prove approvate e deve essere corretta.",
      autonomy_selection_required: "Scegli il livello di autonomia per questa sola pull request o questo solo rilascio locale; la scelta non viene mai ereditata da una consegna precedente.",
      contract_incomplete: "L’incarico non contiene ancora tutto il contesto necessario per lavorare senza fare supposizioni.",
      contract_needs_approval: "L’incarico esiste ma non è ancora stato approvato per l’esecuzione.",
      contract_negotiation_required: "Prima di produrre lavoro definitivo serve un incarico concordato.",
      contract_not_approved: "L’incarico esiste, ma devi ancora confermarlo o chiedere modifiche.",
      decomposition_precedes_task_start: "La scomposizione viene concordata e registrata prima dell’avvio; non è ancora autorizzazione a eseguire il lavoro.",
      kb_not_initialized: "Il contesto iniziale del progetto non è ancora stato preparato.",
      missing_context: "Mancano informazioni importanti e serve la tua risposta prima di continuare.",
      missing_contract: "Per questo passo non esiste ancora un incarico concordato.",
      requirement_agreement_required: "Prima di scomporre o pianificare il lavoro dobbiamo concordare risultato, criteri osservabili, esclusioni e limite massimo di autonomia.",
      requirement_write_scope_required: "Il requisito approvato non indica alcuna area di codice, test, documentazione o evidenze che questa attività può modificare.",
      requirement_not_approved: "Il requisito indicato non è ancora approvato e corrente, quindi non può guidare la scomposizione.",
      requirement_not_found: "Il requisito indicato non esiste ancora.",
      requirement_reference_required: "Devo sapere quale requisito approvato deve guidare la scomposizione.",
      route_requires_confirmation: "L’azione richiesta è chiara, ma prima di avviarla serve la tua conferma.",
      story_requirement_mismatch: "L’attività indicata non è collegata al requisito approvato che dovrebbe guidarla.",
      story_contract_missing: "L’attività non ha ancora un incarico concordato.",
      story_definition_changed_after_contract: "I criteri di riuscita sono cambiati dopo l’accordo precedente, che non può più autorizzare il lavoro.",
      story_not_found: "L’attività indicata non esiste ancora.",
      story_reference_required: "Devo sapere a quale attività appartiene questo lavoro.",
      task_start_required: "L’attività ha un accordo approvato, ma deve ancora essere avviata in modo governato prima di poterla assegnare.",
      "delivery.authority.audit_only_caps_autonomy": "La scelta è stata salvata, ma questa installazione non può ancora verificare automaticamente chi l’ha approvata. Per sicurezza, procederò da solo soltanto tra i momenti di revisione concordati e ti chiederò conferma nei passaggi delicati.",
      "delivery.concurrent_run_limit_exceeded": "Questa consegna ha già il numero massimo di esecuzioni attive e non è possibile avviarne un’altra.",
      "delivery.story_refs_stale": "L’attività è cambiata dopo l’approvazione della consegna e il perimetro deve essere rivisto.",
    };
    return italianExplanations[code]
      || "Manca una condizione necessaria per continuare in sicurezza; il codice tecnico è riportato soltanto nei dettagli.";
  }
  const explanations = {
    active_claim_exists: "Someone or another agent is already working on the same story, so I should not edit over them.",
    active_claim_expired: "A previous work claim is still recorded but expired; it needs cleanup before new work starts.",
    autonomy_checkpoint_required: "This delivery may proceed independently between agreed checkpoints, but it has reached a step that needs a fresh confirmation.",
    autonomy_human_approval_required: "The selected autonomy boundary still needs an explicit human decision before it can become active.",
    autonomy_policy_blocked: "The requested independence is outside the currently approved safety boundary, so execution remains stopped.",
    autonomy_profile_contract_mismatch: "The autonomy profile belongs to a different work brief and cannot be reused for this task.",
    autonomy_profile_invalid: "The autonomy profile no longer matches its exact repository, branch, paths, actions, or approval evidence and must be repaired.",
    autonomy_selection_required: "Choose how independently the agent may work for this one pull request or local release. The choice is never inherited from an earlier delivery.",
    approved_template_missing: "The structure of the output is not agreed yet. For an assessment, this means confirming the sections and level of detail before I write it.",
    artifact_type_required: "I need to know what kind of output I should create, for example a technical assessment, test plan, or release note.",
    capability_profile_missing: "I have not confirmed which project files, tools, skills, and external access are appropriate for this work.",
    baseline_not_ready: "The active project context is not approved from current evidence yet.",
    contract_incomplete: "The work brief is missing project-specific context, such as which files are trusted inputs or what boundaries I must respect.",
    contract_needs_approval: "The work brief exists, but it has not been approved for execution.",
    contract_negotiation_required: "I need an agreed work brief before producing durable work.",
    contract_not_approved: "The work brief exists, but you still need to confirm it or ask for changes.",
    decomposition_precedes_task_start: "The breakdown is agreed and recorded before task execution; it is not permission to start the work.",
    contract_phase_mismatch: "The selected work brief is for a different kind of work, so it needs to be revised or replaced.",
    contract_revision_requested: "You asked to revise the work brief before starting.",
    "delivery.authority.audit_only_caps_autonomy": "The choice was saved, but this installation cannot yet verify automatically who approved it. For safety, I will work independently only between the agreed review moments and ask again before sensitive steps.",
    "delivery.concurrent_run_limit_exceeded": "This delivery already has the maximum number of active runs, so another run cannot start over it.",
    "delivery.story_refs_stale": "The story changed after this delivery profile was approved, so the exact boundary must be reviewed again.",
    invalid_canonical_intent: "The request was not normalized into a supported action.",
    invalid_intent_json: "The structured request could not be read safely.",
    kb_not_initialized: "The project context store has not been initialized yet.",
    low_confidence: "The request is ambiguous enough that I should ask instead of guessing.",
    missing_acceptance_criteria: "The story does not yet define observable success criteria.",
    missing_context: "Important context is missing, so I need your answer before continuing.",
    missing_contract: "There is no work brief for this step yet.",
    needs_normalization: "The request is still raw natural language and needs to be normalized before the workflow can route it.",
    output_already_linked: "An output already exists for this story and type; I need to know whether to reuse it, update it, or create a separate one.",
    phase_skip_requires_confirmation: "Skipping a phase is a deliberate choice and needs explicit confirmation.",
    requirement_agreement_required: "Before planning or decomposing work, we need to agree the outcome, observable acceptance criteria, exclusions, and maximum autonomy boundary.",
    requirement_write_scope_required: "The approved requirement does not name any code, test, documentation, or evidence area that this work may change.",
    requirement_not_approved: "The referenced requirement is not current and approved yet, so it cannot drive decomposition.",
    requirement_not_found: "The referenced requirement does not exist yet.",
    requirement_reference_required: "I need to know which approved requirement should drive this decomposition.",
    route_requires_confirmation: "The requested action is clear, but starting it still needs your go-ahead.",
    story_requirement_mismatch: "The referenced story is not linked to the approved requirement that should govern it.",
    story_contract_missing: "The story does not yet have an agreed work brief.",
    story_definition_changed_after_contract: "The success criteria changed after the previous agreement, so it can no longer authorize this work.",
    story_not_found: "The referenced story does not exist yet.",
    story_reference_required: "I need to know which story this work belongs to.",
    task_start_required: "The work brief is approved, but this exact work still needs a governed task start before anyone can claim it.",
    unknown_requested_action: "The normalized action is not one of the supported workflow actions.",
    unknown_route: "The workflow could not map this request to a supported route.",
  };
  if (explanations[code]) {
    return explanations[code];
  }
  return String(code || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function initBootstrapMutations(context) {
  const directories = projectBootstrapDirectoryPaths(context);
  const files = [
    ...projectBootstrapArtifactSpecifications(context).map((artifact) => artifact.path),
    path.join(context.sdlcRoot, PROJECT_BOOTSTRAP_JOURNAL_FILE_NAME),
    path.join(context.sdlcRoot, PROJECT_BOOTSTRAP_MANIFEST_FILE_NAME),
  ];
  const exact = [
    ...directories.map((directoryPath) => ({ operation: "directory.create", path: directoryPath })),
    ...files.map((filePath) => ({ operation: "file.write", path: filePath })),
  ];
  return [...new Map(exact.map((entry) => [`${entry.operation}\0${path.resolve(entry.path)}`, entry])).values()];
}

export function governedAssessmentWorkflows(context) {
  const governedStates = new Set(["authorized", "running", "verifying", "exception_pending"]);
  return fs.existsSync(assessmentWorkflowsRoot(context))
    ? safeReadDir(assessmentWorkflowsRoot(context))
      .filter((name) => name.endsWith(".json"))
      .map((name) => readAssessmentWorkflow(context, name.slice(0, -5)))
      .filter((workflow) => governedStates.has(workflow.state))
    : [];
}

export function readProjectBootstrapJournal(context) {
  const journalPath = projectBootstrapJournalPath(context);
  const journal = readProjectJson(context, journalPath);
  assertRecordSchema(
    journal,
    "project-bootstrap-journal.schema.json",
    "Project bootstrap journal",
  );
  const { journal_hash: storedHash, ...hashSubject } = journal;
  if (
    journal.hash_algorithm !== "sha256:stable-json:v1"
    || storedHash !== computeStableHash(hashSubject)
    || journal.request_hash !== computeStableHash(journal.request)
  ) {
    fail(
      `Existing ${SDLC_DIR} bootstrap journal is stale or tampered. No files were changed. `
      + "Restore the canonical bootstrap records from version control.",
    );
  }
  return journal;
}

export function approveRequirementLocked(context, options, id, filePath) {
  const requirement = readRequirement(context, id);
  if (requirement.schema_version !== "requirement:v2") {
    fail(`Requirement ${id} is legacy requirement:v1; create an immutable requirement:v2 revision before approval.`);
  }
  if (requirement.status !== "proposed") {
    fail(`Requirement ${id} is '${requirement.status}', expected proposed.`);
  }
  const integrity = validateRequirementIntegrity(requirement);
  if (!integrity.valid) {
    fail(`Requirement ${id} failed integrity validation: ${integrity.errors.join("; ")}`);
  }
  validateRequirementSourceHashes(context, requirement, `Requirement ${id}`, { failOnStale: true });
  const profilePath = requirementAutonomyPath(context, requirement.autonomy_profile_id);
  const proposedProfile = readRequirementAutonomyProfile(context, requirement.autonomy_profile_id);
  if (proposedProfile.status !== "proposed") {
    fail(`Requirement autonomy profile ${proposedProfile.id} is '${proposedProfile.status}', expected proposed.`);
  }
  const profileIntegrity = validateRequirementExecutionProfileIntegrity(proposedProfile);
  if (!profileIntegrity.valid) {
    fail(
      `Requirement autonomy profile ${proposedProfile.id} failed integrity validation: `
      + profileIntegrity.errors.join("; "),
    );
  }
  if (proposedProfile.requirement_ref.hash !== requirementContentHash(requirement)) {
    fail(`Requirement autonomy profile ${proposedProfile.id} is stale for requirement ${id}.`);
  }
  const canonicalWritePaths = assertCanonicalRequirementWriteScope(context, proposedProfile, id);
  const attribution = buildAttribution(context, options, "requirement.approve");
  requireFormalApprovalActor(context, options, attribution, "Approving a requirement and its autonomy ceiling");
  const authorityAssurance = loadAutonomyAuthorityAssurance(
    context,
    options,
    "requirement.approve",
    {
      kind: "requirement_autonomy_approval",
      id,
      requirement_hash: requirementContentHash(requirement),
      profile_hash: proposedProfile.profile_hash,
    },
  );
  const requirementApproval = buildApprovalRecord(context, options, attribution, {
    subject: requirement,
    subject_id_field: "requirement_id",
    subject_id: id,
    status: "approved",
    scope: "requirement-and-autonomy-ceiling",
    label: `requirement ${id}`,
  });
  const profileApproval = writeAutonomyApproval(context, proposedProfile, options, attribution, {
    profilePath,
    scope: "requirement-autonomy-ceiling",
    label: `requirement autonomy profile ${proposedProfile.id}`,
    authorityAction: "requirement.approve",
    authoritySubject: {
      kind: "requirement_autonomy_approval",
      id,
      requirement_hash: requirementContentHash(requirement),
      profile_hash: proposedProfile.profile_hash,
    },
  });
  const updatedAt = now();
  const activeProfile = buildRequirementProfileFor(context, requirement, options, {
    ceiling: proposedProfile.autonomy_ceiling,
    status: "active",
    phase_levels: proposedProfile.phase_levels,
    material_scope: proposedProfile.material_scope,
    constraints: proposedProfile.constraints,
    checkpoints: proposedProfile.checkpoints,
    authority_assurance: authorityAssurance,
    approval_ref: profileApproval.ref,
    valid_from: proposedProfile.valid_from,
    expires_at: proposedProfile.expires_at,
    created_at: proposedProfile.created_at,
    updated_at: updatedAt,
    extensions: {
      ...proposedProfile.extensions,
      approved_profile_hash: proposedProfile.profile_hash,
    },
  });
  const approvedRequirement = {
    ...requirement,
    status: "approved",
    approvals: [...(requirement.approvals || []), requirementApproval],
    updated_at: updatedAt,
    audit: {
      ...(requirement.audit || {}),
      updated_by: attribution.actor,
      git: attribution.git,
      run: attribution.run,
    },
  };
  assertRecordSchema(activeProfile, "requirement-execution-profile.schema.json", `Requirement autonomy profile ${activeProfile.id}`);
  assertRecordSchema(approvedRequirement, "requirement.schema.json", `Requirement ${id}`);
  writeJsonFile(profilePath, activeProfile, { force: true });
  writeJsonFile(filePath, approvedRequirement, { force: true });
  appendTraceEvent(context, null, {
    type: "gate",
    summary: `Approved requirement ${id} and autonomy ceiling ${activeProfile.autonomy_ceiling}`,
    action: "requirement.approve",
    actor: attribution.actor,
    evidence: [toProjectPath(context, filePath), toProjectPath(context, profilePath), profileApproval.ref.path],
    related: [id, activeProfile.id],
    git: attribution.git,
    run: attribution.run,
  });
  const guidance = requirementAutonomyCeilingGuidance({
    status: "approved",
    requirement_id: id,
    profile_id: activeProfile.id,
    autonomy_ceiling: activeProfile.autonomy_ceiling,
    authority_assurance: activeProfile.authority_assurance,
  }, { locale: humanGuidanceLocale(options) });
  const writeScopeWarnings = requirementWriteScopeWarnings(options, canonicalWritePaths);
  output(options, {
    status: "approved",
    requirement: approvedRequirement,
    autonomy_profile: activeProfile,
    requirement_approval: requirementApproval,
    autonomy_approval: profileApproval.envelope,
    warnings: writeScopeWarnings,
    human_guidance: guidance,
  }, [
    ...humanGuidanceLines(guidance, [
      `Requirement: ${id}`,
      `Maximum technical level: ${activeProfile.autonomy_ceiling}`,
      "This approval does not authorize any pull request, local release, merge, or deployment.",
      ...writeScopeWarnings.map((warning) => `Warning: ${warning}`),
    ], options),
  ]);
}

export function reviseRequirementLocked(context, options, currentId, newId) {
  const current = readRequirement(context, currentId);
  if (current.schema_version !== "requirement:v2") {
    fail(`Requirement ${currentId} is legacy requirement:v1 and cannot use the immutable revision command.`);
  }
  if (effectiveRequirementStatus(context, current).status === "superseded") {
    fail(`Requirement ${currentId} is superseded and cannot be revised again.`);
  }
  const existingChild = safeReadDir(requirementsRoot(context))
    .filter((name) => name.endsWith(".json"))
    .map((name) => readProjectJson(context, path.join(requirementsRoot(context), name)))
    .find((candidate) => candidate.previous_revision_ref?.id === currentId);
  if (existingChild) {
    fail(`Requirement ${currentId} already has immutable child revision ${existingChild.id}; revise the current lineage head instead.`);
  }
  const currentProfile = readRequirementAutonomyProfile(context, current.autonomy_profile_id);
  const ceiling = getOptionString(options, "autonomy-ceiling") || currentProfile.autonomy_ceiling;
  normalizeAutonomyLevel(ceiling);
  const writePaths = options["write-path"] === undefined
    ? normalizeRequirementWritePaths(
        context,
        currentProfile.constraints?.allowed_write_paths
          ?? currentProfile.material_scope?.write_paths
          ?? [],
        { label: `Requirement ${currentId} inherited write path` },
      )
    : normalizeRequirementWritePaths(context, options["write-path"]);
  const profileId = normalizeId(`AUT-${newId}-R${Number(current.revision) + 1}`);
  const sourceValues = options.source === undefined ? current.source_paths : options.source;
  const sources = resolveRequirementSources(context, sourceValues);
  const attribution = buildAttribution(context, options, "requirement.revise");
  const createdAt = now();
  const revision = buildDomainRecord(`Cannot revise requirement ${currentId}`, () => buildRequirementRevision(current, {
    id: newId,
    previous_path: toProjectPath(context, requirementPath(context, currentId)),
    title: options.title === undefined ? current.title : requireOption(options, "title"),
    summary: options.summary === undefined && options["scope-summary"] === undefined
      ? current.summary
      : getOptionString(options, "summary", "scope-summary"),
    acceptance_criteria: options.acceptance === undefined ? current.acceptance_criteria : normalizeListOption(options.acceptance),
    non_goals: options["non-goal"] === undefined ? current.non_goals : normalizeListOption(options["non-goal"]),
    constraints: options.constraint === undefined ? current.constraints : normalizeListOption(options.constraint),
    non_functional_requirements: options.nfr === undefined ? current.non_functional_requirements : normalizeListOption(options.nfr),
    integrations: options.integration === undefined ? current.integrations : normalizeListOption(options.integration),
    ...sources,
    proposal_ref: null,
    autonomy_profile_id: profileId,
    created_at: createdAt,
    audit: {
      created_by: attribution.actor,
      updated_by: attribution.actor,
      git: attribution.git,
      run: attribution.run,
    },
  }));
  const profile = buildRequirementProfileFor(context, revision, options, {
    ceiling,
    profileId,
    writePaths,
  });
  const filePath = requirementPath(context, newId);
  const profilePath = requirementAutonomyPath(context, profileId);
  assertRecordSchema(revision, "requirement.schema.json", `Requirement ${newId}`);
  assertRecordSchema(profile, "requirement-execution-profile.schema.json", `Requirement autonomy profile ${profileId}`);
  writeJsonFile(filePath, revision, { force: false });
  writeJsonFile(profilePath, profile, { force: false });
  appendTraceEvent(context, null, {
    type: "decision",
    summary: `Revised requirement ${currentId} as immutable revision ${newId}`,
    action: "requirement.revise",
    actor: attribution.actor,
    evidence: [toProjectPath(context, filePath), toProjectPath(context, profilePath)],
    related: [currentId, newId, profileId],
    git: attribution.git,
    run: attribution.run,
  });
  const writeScopeWarnings = requirementWriteScopeWarnings(options, writePaths);
  output(options, {
    status: "proposed",
    requirement: revision,
    autonomy_profile: profile,
    warnings: writeScopeWarnings,
  }, [
    `Proposed immutable revision ${newId} from ${currentId}`,
    ...(options["write-path"] === undefined
      ? ["Write scope: inherited from the previous revision."]
      : ["Write scope: replaced by the explicitly supplied project-relative paths."]),
    ...writeScopeWarnings.map((warning) => `Warning: ${warning}`),
    "Approve the new revision, then supersede the old revision explicitly.",
  ]);
}

export function supersedeRequirementLocked(context, options, currentId, replacementId, reason) {
  const current = readRequirement(context, currentId);
  const replacement = readRequirement(context, replacementId);
  assertRequirementReadyForDownstream(context, current, `Requirement ${currentId}`, { allowPendingSupersession: true });
  assertRequirementReadyForDownstream(context, replacement, `Replacement requirement ${replacementId}`, { allowPendingSupersession: true });
  const expectedCurrentRef = buildRequirementRef(
    current,
    toProjectPath(context, requirementPath(context, currentId)),
  );
  if (
    current.logical_id !== replacement.logical_id
    || Number(replacement.revision) !== Number(current.revision) + 1
    || replacement.previous_revision_ref?.id !== expectedCurrentRef.id
    || replacement.previous_revision_ref?.revision !== expectedCurrentRef.revision
    || replacement.previous_revision_ref?.content_hash !== expectedCurrentRef.content_hash
  ) {
    fail(`Replacement ${replacementId} must be the exact direct child revision of ${currentId}.`);
  }
  if (effectiveRequirementStatus(context, current).status === "superseded") {
    fail(`Requirement ${currentId} is already superseded.`);
  }
  const attribution = buildAttribution(context, options, "requirement.supersede");
  requireFormalApprovalActor(context, options, attribution, "Superseding a requirement revision");
  const subject = {
    current: buildRequirementRef(current, toProjectPath(context, requirementPath(context, currentId))),
    replacement: buildRequirementRef(replacement, toProjectPath(context, requirementPath(context, replacementId))),
    reason,
  };
  const approval = buildApprovalRecord(context, options, attribution, {
    subject,
    subject_id_field: "requirement_id",
    subject_id: currentId,
    status: "approved",
    scope: "requirement-supersession",
    label: `supersession ${currentId} -> ${replacementId}`,
  });
  const event = buildDomainRecord(`Cannot supersede requirement ${currentId}`, () => buildRequirementSupersession({
    id: `REQ-SUP-${uniqueRecordSuffix()}`,
    requirement_ref: subject.current,
    replacement_ref: subject.replacement,
    reason,
    approval,
    created_at: now(),
    audit: { actor: attribution.actor, git: attribution.git, run: attribution.run },
  }));
  assertRecordSchema(event, "requirement-lifecycle-event.schema.json", `Requirement supersession ${event.id}`);
  const eventPath = path.join(requirementLifecycleRoot(context), `${normalizeId(event.id)}.json`);
  writeJsonFile(eventPath, event, { force: false });
  appendTraceEvent(context, null, {
    type: "gate",
    summary: `Superseded requirement ${currentId} with ${replacementId}`,
    action: "requirement.supersede",
    actor: attribution.actor,
    evidence: [toProjectPath(context, eventPath)],
    related: [currentId, replacementId],
    git: attribution.git,
    run: attribution.run,
  });
  output(options, { status: "superseded", event, event_path: toProjectPath(context, eventPath) }, [
    `Superseded ${currentId} with ${replacementId}`,
    "The old requirement file was not mutated; the lifecycle event is append-only.",
  ]);
}

export function stableLocalSmokeExecutableSnapshot(filePath) {
  const firstDigest = readStableRegularFileDigest(
    filePath,
    path.dirname(filePath),
    512 * 1024 * 1024,
  );
  const prefix = readStableRegularFilePrefix(filePath, path.dirname(filePath), 4096);
  const secondDigest = readStableRegularFileDigest(
    filePath,
    path.dirname(filePath),
    512 * 1024 * 1024,
  );
  if (stableJson(firstDigest) !== stableJson(secondDigest)) {
    fail(`Local smoke executable changed while being attested: ${filePath}.`);
  }
  const firstLine = prefix.toString("utf8").split(/\r?\n/u, 1)[0] || "";
  return {
    ...firstDigest,
    shebang: firstLine.startsWith("#!") ? firstLine.slice(2).trim() : null,
  };
}

export function governedLocalSmokePayloadBinding(profile, cwd, rawArgument, {
  argumentIndex,
  origin,
  forcePath = false,
} = {}) {
  const candidate = forcePath
    ? {
        resolvedPath: String(rawArgument).startsWith("file:")
          ? path.resolve(fileURLToPath(String(rawArgument)))
          : path.resolve(cwd, String(rawArgument)),
        source: "interpreter-entrypoint",
      }
    : localSmokeArgumentPathCandidate(rawArgument, cwd);
  if (!candidate) return null;
  const allowedWritePaths = [...new Set(
    (profile.local_release_target?.allowed_write_paths || [])
      .map((item) => path.resolve(String(item))),
  )].sort();
  const governedWritePath = allowedWritePaths.find((writePath) => {
    if (isInsidePath(writePath, candidate.resolvedPath)) return true;
    if (!fs.existsSync(writePath) || !fs.existsSync(candidate.resolvedPath)) return false;
    return isInsidePath(
      fs.realpathSync.native(writePath),
      fs.realpathSync.native(candidate.resolvedPath),
    );
  });
  if (!governedWritePath) {
    fail(
      `Local smoke payload '${rawArgument}' resolves outside the released artifact: `
      + `${candidate.resolvedPath}. Put the reviewed entrypoint inside an allowed write path.`,
    );
  }
  if (fs.existsSync(candidate.resolvedPath)) {
    const candidateLstat = fs.lstatSync(candidate.resolvedPath);
    if (candidateLstat.isSymbolicLink()) {
      fail(`Local smoke payload cannot be a symlink: ${candidate.resolvedPath}.`);
    }
    if (!candidateLstat.isFile() && !candidateLstat.isDirectory()) {
      fail(`Local smoke payload must be a regular artifact path: ${candidate.resolvedPath}.`);
    }
    if (fs.existsSync(governedWritePath)) {
      const realGovernedWritePath = fs.realpathSync.native(governedWritePath);
      const realCandidate = fs.realpathSync.native(candidate.resolvedPath);
      if (!isInsidePath(realGovernedWritePath, realCandidate)) {
        fail(
          `Local smoke payload resolves outside its governed artifact path: `
          + `${candidate.resolvedPath}.`,
        );
      }
    }
  }
  return {
    argument_index: argumentIndex,
    argument: String(rawArgument),
    origin,
    source: candidate.source,
    resolved_path: candidate.resolvedPath,
    governed_write_path: governedWritePath,
    binding: "artifact-manifest-bound",
  };
}

export function proposeDeliveryAutonomyLocked(context, options, profileId, deliveryId, kind, target, concreteIdentity) {
  for (const name of safeReadDir(deliveryAutonomyRoot(context)).filter((item) => item.endsWith(".json"))) {
    const existing = readDeliveryAutonomyProfile(context, path.basename(name, ".json"));
    if (existing.id === profileId || existing.delivery_kind !== kind) continue;
    const sameDeliveryId = existing.delivery_id === deliveryId;
    const existingTarget = {
      pull_request_target: existing.pull_request_target,
      local_release_target: existing.local_release_target,
    };
    const sameConcreteTarget = stableJson(deliveryConcreteIdentity(kind, existingTarget)) === stableJson(concreteIdentity);
    if (!sameDeliveryId && !sameConcreteTarget) continue;
    const state = currentDeliveryExecutionState(context, existing);
    if (effectiveDeliveryProfileStatus(context, existing).status !== "revoked" && state.lifecycle_status !== "terminal") {
      fail(`Delivery ${kind} ${deliveryId} or its exact target already has non-terminal autonomy profile ${existing.id}.`);
    }
  }
  const storyId = normalizeId(requireOption(options, "story"));
  const contractId = normalizeId(requireOption(options, "contract"));
  const requirementIds = normalizeListOption(options.requirement).map(normalizeId);
  if (requirementIds.length === 0) {
    fail("Delivery autonomy proposal needs at least one --requirement.");
  }
  const requestedLevel = normalizeAutonomyLevel(requireOption(options, "level"));
  const requirements = requirementIds.map((id) => readRequirement(context, id));
  const requirementProfiles = requirements.map((requirement) => {
    const ready = assertRequirementReadyForDownstream(context, requirement, `Requirement ${requirement.id}`);
    if (ready.legacy) {
      fail(`Requirement ${requirement.id} is legacy; create and approve requirement:v2 before selecting per-delivery autonomy.`);
    }
    return ready.profile;
  });
  const ceiling = mostRestrictiveAutonomyLevel(requirementProfiles.map((profile) => profile.autonomy_ceiling));
  const levelRank = AUTONOMY_LEVEL_RANK;
  if (levelRank[requestedLevel] > levelRank[ceiling]) {
    fail(`Delivery level ${requestedLevel} exceeds the most restrictive requirement ceiling ${ceiling}.`);
  }
  const story = readStory(context, storyId);
  if (!story) fail(`Story ${storyId} does not exist.`);
  const linkedRequirements = new Set(story.links?.requirements || []);
  for (const requirementId of requirementIds) {
    if (!linkedRequirements.has(requirementId)) {
      fail(`Story ${storyId} is not bound to requirement ${requirementId}.`);
    }
  }
  const contract = readContractById(context, contractId);
  if (contract.story_id !== storyId) {
    fail(`Contract ${contractId} is bound to ${contract.story_id || "the project"}, not ${storyId}.`);
  }
  if (contract.status !== "approved" || !hasFreshApprovedContractApproval(contract)) {
    fail(`Contract ${contractId} must be formally approved and fresh before selecting autonomy for a PR or local release.`);
  }
  if (contract.delivery_execution_profile_id !== profileId) {
    fail(`Contract ${contractId} must name --delivery-profile ${profileId} before this exact delivery profile is proposed.`);
  }
  const contractLevel = normalizeAutonomyLevel(contract.autonomy_level || "supervised");
  if (levelRank[requestedLevel] > levelRank[contractLevel]) {
    fail(`Delivery level ${requestedLevel} exceeds contract boundary ${contractLevel}. Revise the contract or choose a narrower delivery level.`);
  }
  const pullRequestWritePaths = kind === "pull_request"
    ? normalizeRawListOption(options["write-path"]).map((rawPath) => {
        const resolved = resolveProjectFilePath(context, rawPath, { mustExist: false });
        const relative = toProjectPath(context, resolved);
        if (!relative || relative === ".") {
          fail("Pull-request --write-path must be narrower than the repository root.");
        }
        return relative;
      })
    : [];
  if (kind === "pull_request" && pullRequestWritePaths.length === 0) {
    fail("Pull-request delivery autonomy requires at least one explicit project-relative --write-path.");
  }
  const constraints = {
    allowed_tools: [...new Set(contract.allowed_tools || [])].sort(),
    allowed_capabilities: [...new Set([
      ...(contract.capability_bindings || []).map((binding) => binding.name).filter(Boolean),
      ...(contract.allowed_tools || []),
    ])].sort(),
    allowed_environments: kind === "local_release" ? ["local"] : ["pull_request"],
    allowed_write_paths: kind === "local_release"
      ? target.local_release_target.allowed_write_paths
      : [...new Set(pullRequestWritePaths)].sort(),
    forbidden_actions: [...new Set(context.config.autonomy_policy?.exception_triggers || [])].sort(),
    budget_ref: null,
  };
  const materialScope = deliveryMaterialScope({
    profileId,
    deliveryId,
    deliveryKind: kind,
    requirementProfiles,
    story,
    contract,
    target,
    constraints,
  });
  const createdAt = now();
  const providerBindings = deliveryProviderBindingsFromOptions(context, kind, options, target);
  const profileInput = {
    schema_version: "delivery-execution-profile:v2",
    id: profileId,
    status: "proposed",
    delivery_id: deliveryId,
    delivery_kind: kind,
    requirement_profile_refs: requirementProfiles.map((profile) => ({
      id: profile.id,
      path: toProjectPath(context, requirementAutonomyPath(context, profile.id)),
      hash: profile.profile_hash,
    })),
    story_refs: [{
      id: storyId,
      path: toProjectPath(context, path.join(context.sdlcRoot, "stories", storyId, "story.json")),
      hash: hashApprovalSubject(story),
    }],
    contract_refs: [{
      id: contractId,
      path: toProjectPath(context, path.join(context.sdlcRoot, "contracts", `${contractId}.json`)),
      hash: hashApprovalSubject(contract),
    }],
    material_scope: materialScope,
    requested_level: requestedLevel,
    phase_levels: {},
    constraints,
    checkpoints: context.config.autonomy_policy?.presets?.[requestedLevel]?.checkpoints,
    provider_bindings: providerBindings,
    ...target,
    authority_assurance: { mode: "audit_only" },
    approval_ref: null,
    valid_from: createdAt,
    expires_at: getOptionString(options, "expires-at"),
    created_at: createdAt,
    updated_at: createdAt,
    extensions: {
      requirement_ids: requirementIds,
      exact_delivery_selection: true,
    },
  };
  let profile = buildDomainRecord(`Cannot propose delivery autonomy ${profileId}`, () => buildDeliveryExecutionProfileV2(profileInput));
  if (getOptionString(options, "standing-approval")) {
    // Under a standing approval every delivery action becomes a confirmation
    // point: each one is either covered by the standing approval at that
    // moment or confirmed by a person.
    const standing = standingProfileProposalExtension(context, options, profile);
    profile = buildDomainRecord(`Cannot propose delivery autonomy ${profileId}`, () => buildDeliveryExecutionProfileV2({
      ...profileInput,
      checkpoints: standing.checkpoints,
      extensions: { ...profileInput.extensions, standing_approval_ref: standing.standing_approval_ref },
    }));
  }
  assertRecordSchema(profile, deliveryExecutionProfileSchemaName(profile), `Delivery autonomy profile ${profileId}`);
  const profilePath = deliveryAutonomyPath(context, profileId);
  writeJsonFile(profilePath, profile, { force: false });
  const attribution = buildAttribution(context, options, "autonomy.delivery.propose");
  appendTraceEvent(context, storyId, {
    type: "decision",
    summary: `Proposed ${requestedLevel} autonomy for ${kind} ${deliveryId}`,
    action: "autonomy.delivery.propose",
    actor: attribution.actor,
    evidence: [toProjectPath(context, profilePath)],
    related: [profileId, deliveryId, storyId, contractId, ...requirementIds],
    git: attribution.git,
    run: attribution.run,
  });
  const authorityEffectiveCap = (context.config.authority_policy?.mode || "audit_only") === "host_verified"
    ? "bounded-autonomous"
    : "checkpointed";
  const effectiveProposalLevel = authorityEffectiveCap === "checkpointed" && requestedLevel === "bounded-autonomous"
    ? "checkpointed"
    : requestedLevel;
  const effectivePreset = context.config.autonomy_policy?.presets?.[effectiveProposalLevel] || {};
  const targetActions = new Set(deliveryTargetAllowedActions(profile));
  const deliveryCheckpointActions = new Map([
    ["build.local", "build.local"],
    ["release.local", "release.local"],
    ["data.migrate", "data.migrate"],
    ["data.rollback", "data.rollback"],
    ["rollback.verify", "rollback.verify"],
    ["sync.commit", "git.commit"],
    ["sync.push", "git.push"],
    ["sync.pr", "pull_request.update"],
    ["pull_request.merge", "pull_request.merge"],
    ["deploy.remote", "deploy.remote"],
  ]);
  const relevantCheckpoints = (effectivePreset.checkpoints || profile.checkpoints || []).filter((checkpoint) => {
    const targetAction = deliveryCheckpointActions.get(checkpoint);
    if (!targetAction) return true;
    if (targetActions.has(targetAction)) return true;
    return kind === "pull_request" && checkpoint === "pull_request.merge";
  });
  const review = {
    profile_id: profileId,
    delivery: { id: deliveryId, kind },
    exact_unit: { story_id: storyId, contract_id: contractId, requirement_ids: requirementIds },
    requirement_ceilings: requirementProfiles.map((item) => ({
      profile_id: item.id,
      ceiling: item.autonomy_ceiling,
    })),
    most_restrictive_requirement_ceiling: ceiling,
    contract_ceiling: contractLevel,
    requested_level: requestedLevel,
    authority_effective_cap: authorityEffectiveCap,
    target: kind === "pull_request" ? profile.pull_request_target : profile.local_release_target,
    allowed_actions: deliveryTargetAllowedActions(profile),
    allowed_write_paths: constraints.allowed_write_paths,
    automatic_phases: effectivePreset.automatic_phases || [],
    checkpoints: relevantCheckpoints,
    forbidden_actions: constraints.forbidden_actions,
    proposal_authority_mode: profile.authority_assurance.mode,
    provider_bindings: profile.provider_bindings,
    non_reusable: true,
    ...(kind === "local_release"
      ? {
          smoke_execution_boundary: localSmokeExecutionBoundary(),
          destinations_visible_to_git: localReleaseDestinationsVisibleToGit(
            context,
            profile.local_release_target.allowed_write_paths,
          ),
        }
      : {}),
  };
  const projectName = readProjectSafe(context)?.project_name || path.basename(context.root);
  const guidance = deliveryAutonomyProposalGuidance({
    status: "proposed",
    profile_id: profileId,
    delivery_id: deliveryId,
    delivery_kind: kind,
    project_name: projectName,
    project_root: context.root,
    repository: profile.pull_request_target?.repository,
    base_branch: profile.pull_request_target?.base_branch,
    head_branch: profile.pull_request_target?.head_branch,
    target_root: profile.local_release_target?.root_path,
    smoke_cwd: profile.local_release_target?.smoke_cwd || null,
    smoke_execution_boundary: kind === "local_release" ? localSmokeExecutionBoundary() : null,
    destinations_visible_to_git: review.destinations_visible_to_git || [],
    allowed_write_paths: review.allowed_write_paths,
    review_moments: review.checkpoints,
    expires_at: profile.expires_at,
    requested_level: requestedLevel,
    effective_level: effectiveProposalLevel,
    authority_mode: context.config.authority_policy?.mode || "audit_only",
    authority_verified: false,
    merge_allowed: profile.pull_request_target?.merge_allowed === true,
    reason_codes: review.authority_effective_cap === "checkpointed" && requestedLevel === "bounded-autonomous"
      ? ["delivery.authority.audit_only_caps_autonomy"]
      : [],
  }, { locale: humanGuidanceLocale(options) });
  output(options, {
    status: "proposed",
    delivery_profile: profile,
    delivery_profile_path: toProjectPath(context, profilePath),
    review,
    human_guidance: guidance,
  }, [
    ...humanGuidanceLines(guidance, [
      `Profile: ${profileId}`,
      `Delivery: ${deliveryId}; story ${storyId}; contract ${contractId}`,
      `Project: ${projectName} (${context.root})`,
      `Destination: ${kind === "pull_request"
        ? profile.pull_request_target.mode === "existing"
          ? `existing PR #${profile.pull_request_target.pr_number} ${profile.pull_request_target.pr_url}; ${profile.pull_request_target.head_branch} from ${profile.pull_request_target.base_branch}`
          : `new PR in ${profile.pull_request_target.repository}; ${profile.pull_request_target.head_branch} from ${profile.pull_request_target.base_branch}`
        : profile.local_release_target.root_path}`,
      `Requested technical level: ${requestedLevel}`,
      `Highest currently enforceable level: ${guidance.details.effective_level}`,
      ...autonomyVerificationTechnicalLines(guidance, options),
      `Allowed actions: ${review.allowed_actions.join(", ")}`,
      `Allowed write paths: ${review.allowed_write_paths.join(", ")}`,
      ...(kind === "local_release"
        ? [
            `Smoke working directory: ${profile.local_release_target.smoke_cwd}`,
            `Smoke execution provider: ${review.smoke_execution_boundary.provider}; `
              + `external network ${review.smoke_execution_boundary.external_network}; `
              + `loopback ${review.smoke_execution_boundary.loopback_network}.`,
            "Smoke trust boundary: writes are denied, but host-file confidentiality is not provided; "
              + "run reviewed project code only.",
            ...(review.destinations_visible_to_git.length > 0
              ? [
                  `Warning: release destination inside the repository and not ignored by Git: ${review.destinations_visible_to_git.join(", ")}. `
                    + "Its files count as story changes and pass the strict write-scope check only while they "
                    + "match the released artifact manifest; add it to .gitignore (or .git/info/exclude) "
                    + "or choose a destination outside the repository.",
                ]
              : []),
          ]
        : []),
      `Checkpoints: ${review.checkpoints.join(", ") || "global exceptions only"}`,
      `Expires at: ${profile.expires_at || "delivery lifecycle only"}`,
    ], options),
  ]);
}

export function approveDeliveryAutonomyLocked(context, options, profileId, profilePath) {
  const standingId = getOptionString(options, "standing-approval");
  if (!standingId) return approveDeliveryAutonomyUnderLocks(context, options, profileId, profilePath);
  // Held until the active delivery is written, so a revocation cannot land
  // between the slot consumption and the derived approval.
  const releaseStandingLock = holdStandingApprovalLock(context, standingId);
  try {
    return approveDeliveryAutonomyUnderLocks(context, options, profileId, profilePath);
  } finally {
    releaseStandingLock();
  }
}

function approveDeliveryAutonomyUnderLocks(context, options, profileId, profilePath) {
  const proposed = readDeliveryAutonomyProfile(context, profileId);
  if (proposed.status !== "proposed") {
    fail(`Delivery autonomy profile ${profileId} is '${proposed.status}', expected proposed.`);
  }
  currentDeliveryAutonomyInputs(context, proposed);
  const attribution = buildAttribution(context, options, "autonomy.delivery.approve");
  const standingCoverage = getOptionString(options, "standing-approval")
    ? consumeStandingDeliveryApproval(context, options, proposed, attribution)
    : null;
  if (!standingCoverage) {
    requireFormalApprovalActor(context, options, attribution, "Approving per-delivery autonomy");
  }
  const approvalSubject = autonomyApprovalSubject(context, proposed, profilePath);
  // A signed standing approval passes its receipt on as the delivery's
  // authority, so its later actions must carry the same signed authority.
  const authorityAssurance = standingCoverage
    ? standingAuthorityAssurance(context, standingCoverage)
    : loadAutonomyAuthorityAssurance(
        context,
        options,
        "autonomy.delivery.approve",
        approvalSubject,
      );
  const approval = writeAutonomyApproval(context, proposed, options, attribution, {
    profilePath,
    scope: `exact-${proposed.delivery_kind}:${proposed.delivery_id}`,
    label: `delivery autonomy profile ${profileId}`,
    authorityAction: "autonomy.delivery.approve",
    authoritySubject: approvalSubject,
    standing: standingCoverage,
  });
  const profileBuilder = proposed.schema_version === "delivery-execution-profile:v2"
    ? buildDeliveryExecutionProfileV2
    : buildDeliveryExecutionProfile;
  const active = buildDomainRecord(`Cannot activate delivery autonomy ${profileId}`, () => profileBuilder({
    ...proposed,
    status: "active",
    authority_assurance: authorityAssurance,
    approval_ref: approval.ref,
    updated_at: now(),
    extensions: { ...proposed.extensions, approved_profile_hash: proposed.profile_hash },
  }));
  assertRecordSchema(active, deliveryExecutionProfileSchemaName(active), `Delivery autonomy profile ${profileId}`);
  const { decision } = evaluateDeliveryAutonomy(context, active, {
    id: `AUT-DEC-${uniqueRecordSuffix()}`,
    phase: getOptionString(options, "phase") || undefined,
  });
  const decisionPath = path.join(autonomyDecisionsRoot(context), `${normalizeId(decision.id)}.json`);
  writeJsonFile(profilePath, active, { force: true });
  writeJsonFile(decisionPath, decision, { force: false });
  appendTraceEvent(context, active.story_refs[0]?.id || null, {
    type: "gate",
    summary: `Approved ${active.requested_level} autonomy for ${active.delivery_kind} ${active.delivery_id}; effective ${decision.effective_level}`
      + (standingCoverage ? ` under standing approval ${standingCoverage.loaded.id}` : ""),
    action: "autonomy.delivery.approve",
    actor: attribution.actor,
    evidence: [toProjectPath(context, profilePath), approval.ref.path, toProjectPath(context, decisionPath)],
    related: [profileId, active.delivery_id, ...(standingCoverage ? [standingCoverage.loaded.id] : [])],
    git: attribution.git,
    run: attribution.run,
  });
  if (standingCoverage) {
    traceStandingApprovalEvent(context, active.story_refs[0]?.id || null, attribution, {
      kind: "use",
      coverage: standingCoverage,
      summary: `Delivery ${active.delivery_id} uses standing approval ${standingCoverage.loaded.id} `
        + `(delivery ${standingCoverage.use.slot} of ${standingCoverage.loaded.proposal.max_deliveries})`,
      related: [profileId, active.delivery_id],
      evidence: [standingCoverage.use_path, approval.ref.path],
    });
  }
  const guidance = deliveryAutonomyApprovalGuidance({
    status: "active",
    profile_id: active.id,
    delivery_id: active.delivery_id,
    delivery_kind: active.delivery_kind,
    requested_level: decision.requested_level,
    effective_level: decision.effective_level,
    authority_assurance: active.authority_assurance,
    merge_allowed: active.pull_request_target?.merge_allowed === true,
    reason_codes: decision.reason_codes,
  }, { locale: humanGuidanceLocale(options) });
  output(options, {
    status: "active",
    delivery_profile: active,
    approval: approval.envelope,
    autonomy_decision: decision,
    decision_path: toProjectPath(context, decisionPath),
    human_guidance: guidance,
  }, [
    ...humanGuidanceLines(guidance, [
      `Profile: ${active.id}`,
      `Delivery: ${active.delivery_id}`,
      `Requested technical level: ${active.requested_level}`,
      `Effective technical level: ${decision.effective_level}`,
      `Approval evidence: ${active.authority_assurance?.verified ? "trusted signature verified" : "recorded and hash-bound; identity not independently verified"}`,
      ...autonomyVerificationTechnicalLines(guidance, options),
      ...(decision.reason_codes.length > 0 ? [`Technical reason codes: ${decision.reason_codes.join(", ")}`] : []),
    ], options),
  ]);
}

export function revokeDeliveryAutonomyLocked(context, options, profileId, profilePath, reason) {
  const profile = readDeliveryAutonomyProfile(context, profileId);
  const currentStatus = effectiveDeliveryProfileStatus(context, profile);
  if (currentStatus.status === "revoked") {
    if (currentStatus.revocation.reason !== reason) {
      fail(`Delivery autonomy profile ${profileId} is already revoked for a different exact reason.`);
    }
    const repairedClosePath = ensureRevokedDeliveryCloseReceipt(context, profile, currentStatus.revocation);
    output(options, {
      status: "revoked",
      idempotent: true,
      revocation: currentStatus.revocation,
      close_receipt_path: repairedClosePath,
    }, [`Delivery autonomy profile ${profileId} is already revoked; lifecycle receipts are complete.`]);
    return;
  }
  const attribution = buildAttribution(context, options, "autonomy.delivery.revoke");
  requireFormalApprovalActor(context, options, attribution, "Revoking per-delivery autonomy");
  const subject = { profile_id: profileId, profile_hash: profile.profile_hash, reason };
  const approval = buildApprovalRecord(context, options, attribution, {
    subject,
    subject_id_field: "profile_id",
    subject_id: profileId,
    status: "approved",
    scope: "delivery-autonomy-revocation",
    label: `delivery autonomy revocation ${profileId}`,
  });
  const recordBase = {
    id: `AUT-REV-${uniqueRecordSuffix()}`,
    kind: "autonomy_profile_revocation",
    schema_version: "autonomy-profile-revocation:v1",
    profile_ref: { id: profileId, path: toProjectPath(context, profilePath), hash: profile.profile_hash },
    reason,
    approval,
    created_at: now(),
    audit: { actor: attribution.actor, git: attribution.git, run: attribution.run },
  };
  const record = {
    ...recordBase,
    receipt_hash: autonomyLifecycleReceiptHash(recordBase),
    hash_algorithm: "sha256:stable-json:v1",
  };
  assertRecordSchema(record, "autonomy-profile-revocation.schema.json", `Autonomy profile revocation ${record.id}`);
  const recordPath = path.join(autonomyRevocationsRoot(context), `${normalizeId(record.id)}.json`);
  writeJsonFile(recordPath, record, { atomicCreate: true });
  const closePath = ensureRevokedDeliveryCloseReceipt(context, profile, record);
  appendTraceEvent(context, profile.story_refs[0]?.id || null, {
    type: "gate",
    summary: `Revoked autonomy profile ${profileId}`,
    action: "autonomy.delivery.revoke",
    actor: attribution.actor,
    evidence: [toProjectPath(context, recordPath), closePath].filter(Boolean),
    related: [profileId, profile.delivery_id],
    git: attribution.git,
    run: attribution.run,
  });
  output(options, {
    status: "revoked",
    revocation: record,
    close_receipt_path: closePath,
  }, [`Revoked delivery autonomy profile ${profileId}`]);
}

export function requireGovernedLocalReleaseTarget(
  context,
  profile,
  executionState,
  action,
  observedAt,
  expectedRef = null,
) {
  const state = localReleaseProtectedTargetState(
    context,
    profile,
    executionState,
  );
  if (state.invalid.length > 0) {
    fail(`Existing build.local governance is invalid: ${state.invalid.join("; ")}.`);
  }
  const baselineHadAbsence = !state.legacy
    && localReleaseTargetHadAbsentEntries(
      executionState.start_receipt.local_release_target_baseline,
    );
  if (
    baselineHadAbsence
    && (
      state.ref.source !== "build.local"
      || state.materialized !== true
      || state.buildReceipt?.outcome !== "passed"
    )
  ) {
    fail(
      `${action} requires a completed passing build.local receipt because the exact target root was `
      + "absent at task start or an approved write path was absent at task start. "
      + "An ungoverned mkdir is not a repair.",
    );
  }
  assertCurrentLocalReleaseTargetState(
    context,
    profile,
    state,
    action === "build.local" ? "build_authorization" : "build_completion",
    observedAt,
  );
  if (expectedRef && stableJson(expectedRef) !== stableJson(state.ref)) {
    fail(
      `${action} no longer follows the exact local-target materialization receipt bound at authorization.`,
    );
  }
  return state.ref;
}

export function recordBudgetUsageLocked(context, options, proposalId, suppliedReceipt = null, extraOutput = {}) {
  const proposal = readAssessmentProposal(context, proposalId);
  const workflow = readAssessmentWorkflow(context, proposalId);
  const budget = effectiveAssessmentBudget(context, proposalId);
  const receipt = suppliedReceipt || budgetUsageFromOptions(context, options, proposalId, budget);
  const validation = validateExecutionUsageReceipt(receipt, budget);
  if (!validation.valid) {
    fail(`Usage receipt failed integrity validation: ${validation.errors.join("; ")}`);
  }
  ensureDir(assessmentUsageRoot(context, proposalId));
  const receiptPath = path.join(assessmentUsageRoot(context, proposalId), `${normalizeId(receipt.id)}.json`);
  let idempotent = false;
  if (fs.existsSync(receiptPath)) {
    const existing = readProjectJson(context, receiptPath);
    if (existing.receipt_hash !== receipt.receipt_hash || stableJson(existing) !== stableJson(receipt)) {
      fail([
        `Usage receipt id '${receipt.id}' is already registered with different canonical content.`,
        "Usage receipts are append-only: choose a new --id for a new observation.",
        "--force never overwrites a usage receipt because that would rewrite budget history.",
      ].join("\n"));
    }
    idempotent = true;
  } else {
    if (!["running", "verifying", "exception_pending"].includes(workflow.state)) {
      fail(`New budget usage can be recorded only while an assessment is running, verifying, or awaiting an exception decision; ${proposalId} is ${workflow.state}. An identical existing receipt may still be replayed safely.`);
    }
    // A new receipt must also meet the rules that stored history is not
    // re-checked against (for example, cumulative values need a trusted source).
    const incoming = validateExecutionUsageReceipt(receipt, budget, { incoming: true });
    if (!incoming.valid) {
      fail(`Usage receipt ${receipt.id} was not recorded: ${incoming.errors.join("; ")}`);
    }
    // Validate the candidate history in memory first: a receipt that would make
    // the history invalid (for example a regressing cumulative counter) must
    // never reach disk, or every later status, record, and meter call would fail.
    const candidateReceipts = sortUsageReceipts([...readAssessmentUsageReceipts(context, proposalId), receipt]);
    try {
      evaluateBudgetUsage(budget, candidateReceipts, { accepted_receipt_budgets: assessmentBudgetLineage(context, proposalId) });
    } catch (error) {
      fail([
        `Usage receipt ${receipt.id} was not recorded: it is inconsistent with the usage already recorded for ${proposalId}.`,
        `Reason: ${describeValidationError(error)}`,
        "Nothing was written; the existing budget history is unchanged.",
      ].join("\n"));
    }
    writeJsonFile(receiptPath, receipt);
  }
  if (["running", "verifying", "exception_pending"].includes(workflow.state)) {
    // Bind the receipt into the hash-sealed ledger so a later deletion is
    // detected. A replay also registers a receipt left behind by an
    // interrupted earlier record.
    registerUsageReceiptsInLedger(context, proposalId);
  }
  const receipts = readAssessmentUsageReceipts(context, proposalId);
  const decision = evaluateAssessmentBudgetUsage(context, proposalId, budget, receipts);
  const reserveRisks = completionReserveRisks(budget, decision);
  const mustPause = ["soft_limit", "hard_limit", "metering_violation"].includes(decision.status) || reserveRisks.length > 0;
  let nextWorkflow = workflow;
  if (mustPause && ["running", "verifying"].includes(workflow.state)) {
    try {
      nextWorkflow = transitionAssessmentWorkflow(workflow, "exception_pending", {
        at: now(),
        proposal_hash: proposal.proposal_hash,
        authorization_ref: workflow.authorization_ref,
        actor: buildAttribution(context, options, "budget.usage.record").actor,
        reason: reserveRisks.length > 0 ? "Completion reserve reached." : `Budget decision: ${decision.status}.`,
        evidence: [toProjectPath(context, receiptPath)],
        idempotency_key: `budget:${receipt.receipt_hash}`,
      });
      writeJsonFile(assessmentWorkflowPath(context, proposalId), nextWorkflow, { force: true });
    } catch (error) {
      fail(`Usage was recorded, but workflow transition failed: ${error.message}`);
    }
  }
  const exceptionQuestion = mustPause
    ? buildBudgetExceptionQuestion(proposalId, budget, decision, reserveRisks)
    : null;
  output(options, {
    ...extraOutput,
    status: mustPause ? "exception_pending" : decision.status,
    registration_status: idempotent ? "idempotent_replay" : "created",
    idempotent,
    proposal_id: proposalId,
    receipt,
    receipt_path: toProjectPath(context, receiptPath),
    aggregate: decision,
    completion_reserve_risks: reserveRisks,
    workflow: nextWorkflow,
    assistant_message: exceptionQuestion,
  }, [
    idempotent
      ? `Usage ${receipt.id} was already registered with the same hash; reused it without changing history.`
      : `Recorded usage ${receipt.id} for ${proposalId}.`,
    `Budget status: ${decision.status}.`,
    ...describeBudgetUsageLines(budget, decision),
    ...(exceptionQuestion ? ["", exceptionQuestion] : []),
  ]);
}

export function amendAssessmentBudgetLocked(context, options, proposalId) {
  const proposal = readAssessmentProposal(context, proposalId);
  const workflow = readAssessmentWorkflow(context, proposalId);
  const application = readAssessmentApplication(context, proposalId);
  const lineage = assessmentBudgetLineage(context, proposalId);
  const currentBudget = lineage.at(-1);
  const changes = loadOptionalJsonInput(context, options, "budget-json", "budget-file", "budget amendment");
  if (!changes || Object.keys(changes).length === 0) {
    fail("Budget amendment requires --budget-json or --budget-file with the exact changed limits. Example: --budget-json '{\"limits\":{\"steps\":{\"soft\":20,\"hard\":30}}}'.");
  }
  const reason = getOptionString(options, "reason") || getOptionString(options, "summary");
  if (!reason) {
    fail("Budget amendment requires --reason explaining why the approved tranche cannot complete within the current limit.");
  }
  const amendmentId = normalizeId(options.id || `BAMEND-${proposalId}-${uniqueRecordSuffix()}`);
  ensureDir(assessmentAmendmentsRoot(context, proposalId));
  const amendmentPath = path.join(assessmentAmendmentsRoot(context, proposalId), `${amendmentId}.json`);
  const existing = fs.existsSync(amendmentPath) ? readProjectJson(context, amendmentPath) : null;
  if (existing) {
    assertRecordSchema(existing, "budget-amendment.schema.json", `Existing budget amendment ${amendmentId}`);
    const integrity = validateBudgetAmendmentIntegrity(existing);
    if (!integrity.valid) {
      fail(`Existing budget amendment ${amendmentId} failed immutable content validation: ${integrity.errors.join("; ")}`);
    }
  }
  if (!existing && workflow.state !== "exception_pending") {
    fail([
      `A new budget amendment is allowed only while ${proposalId} is in exception_pending; current state is ${workflow.state}.`,
      "Record trusted usage until a soft/hard/reserve boundary pauses the workflow, then approve one explicit versioned amendment.",
      "Completed, cancelled, rejected, and ordinary running workflows cannot be retroactively re-budgeted.",
    ].join("\n"));
  }
  const attribution = buildAttribution(context, options, "budget.amend");
  requireFormalApprovalActor(context, options, attribution, "Approving a budget amendment");
  const source = normalizeApprovalSource(context, options, attribution, `budget amendment for ${proposalId}`, "approved");
  if (!["explicit-user", "ci"].includes(source)) {
    fail("A budget extension requires direct explicit-user or CI approval; automation cannot extend its own budget.");
  }
  const approvalEvidence = buildApprovalEvidence(context, options);
  // Mirror assessment proposal approval: the approver's own decision
  // (--summary or --approval-evidence) is required, separately from the
  // justification in --reason, which the requester may have written.
  validateApprovalSourceForActor(context, {
    source,
    status: "approved",
    summary: getOptionString(options, "summary"),
    evidence: approvalEvidence,
    actor: attribution.actor,
    label: `budget amendment for ${proposalId}`,
  });
  const baseBudget = existing
    ? lineage.find((candidate) => candidate.budget_hash === existing.base_budget_hash)
    : currentBudget;
  if (!baseBudget) {
    fail(`Existing amendment ${amendmentId} references a base budget outside the approved lineage.`);
  }
  const metadata = {
    id: amendmentId,
    reason,
    created_at: existing?.created_at || now(),
    requested_by: attribution.actor,
    approved_by: attribution.actor,
    proposal_ref: { id: proposalId, hash: proposal.proposal_hash },
    approval_source: source,
    // A replay keeps the decision text recorded with the original amendment
    // (older amendments have none), so its immutable hash does not change.
    approval_summary: existing ? existing.approval_summary : getOptionString(options, "summary"),
    approval_evidence: approvalEvidence,
  };
  let provisional;
  try {
    provisional = buildBudgetAmendment(baseBudget, changes, metadata, { allow_decrease: false });
  } catch (error) {
    fail(`Invalid budget amendment: ${error.message}`);
  }
  if (!existing) {
    // Only problems the amendment introduces are refused, so a budget approved
    // under older rules can still be extended.
    const budgetPolicy = { maxima: context.config.budget_policy?.maxima || {} };
    const inherited = new Set(budgetInputPolicyErrors(baseBudget, budgetPolicy));
    // An unreadable project maximum bounds nothing, so it is never treated as inherited.
    const introduced = budgetInputPolicyErrors(provisional.result_budget, budgetPolicy)
      .filter((problem) => !inherited.has(problem) || /cannot be read/u.test(problem));
    if (introduced.length > 0) {
      fail([
        `Invalid budget amendment ${amendmentId}:`,
        ...introduced.map((problem) => `- ${problem}`),
        "Nothing was written.",
      ].join("\n"));
    }
  }
  const hostApprovalReceiptRef = existing && !getOptionString(options, "host-receipt-file")
    ? (existing.host_approval_receipt_ref
      ? loadStoredBudgetAmendmentHostApprovalReceipt(context, proposal, existing)
      : loadBudgetAmendmentHostApprovalReceipt(context, options, proposal, provisional))
    : loadBudgetAmendmentHostApprovalReceipt(context, options, proposal, provisional);
  let amendment;
  try {
    amendment = buildBudgetAmendment(baseBudget, changes, {
      ...metadata,
      host_approval_receipt_ref: hostApprovalReceiptRef,
    }, { allow_decrease: false });
  } catch (error) {
    fail(`Invalid budget amendment: ${error.message}`);
  }
  assertRecordSchema(amendment, "budget-amendment.schema.json", `Budget amendment ${amendment.id}`);
  if (existing) {
    if (existing.amendment_hash !== amendment.amendment_hash || stableJson(existing) !== stableJson(amendment)) {
      fail([
        `Budget amendment id '${amendmentId}' is already bound to different canonical content.`,
        "Amendments are immutable and append-only; --force cannot replace one.",
        "Replay the exact same request, or use a new amendment id after another exception checkpoint.",
      ].join("\n"));
    }
  }

  let amendmentResultBudget;
  try {
    amendmentResultBudget = applyBudgetAmendment(baseBudget, amendment);
  } catch (error) {
    fail(`Budget amendment ${amendmentId} cannot be applied to its recorded base: ${error.message}`);
  }

  const references = application.budget_amendments || [];
  const matchingReferences = references.filter((item) => item.id === amendmentId);
  if (matchingReferences.length > 1) {
    fail(`Assessment application contains duplicate references for budget amendment ${amendmentId}.`);
  }
  const existingReference = matchingReferences[0] || null;
  if (existingReference && (
    existingReference.path !== toProjectPath(context, amendmentPath)
    || existingReference.amendment_hash !== amendment.amendment_hash
    || existingReference.result_budget_hash !== amendment.result_budget_hash
  )) {
    fail(`Existing amendment ${amendmentId} is not registered consistently in the assessment application.`);
  }
  if (!existingReference && currentBudget.budget_hash !== amendment.base_budget_hash) {
    fail(`Existing amendment ${amendmentId} cannot be recovered after a different budget was appended to its base.`);
  }
  if (!existingReference && workflow.state !== "exception_pending") {
    fail(`Unregistered amendment seed ${amendmentId} can be recovered only while the workflow is exception_pending; current state is ${workflow.state}.`);
  }

  let nextApplication = application;
  const recoveryActions = [];
  if (!existingReference) {
    if (application.effective_budget?.budget_hash !== amendment.base_budget_hash) {
      fail(`Unregistered amendment seed ${amendmentId} does not start from the application's effective budget.`);
    }
    if (application.updated_at && amendment.created_at < application.updated_at) {
      fail(`Unregistered amendment seed ${amendmentId} predates the current assessment application and cannot be replayed safely.`);
    }
    nextApplication = structuredClone(application);
    nextApplication.effective_budget = amendmentResultBudget;
    nextApplication.budget_amendments = [...references, {
      id: amendment.id,
      path: toProjectPath(context, amendmentPath),
      amendment_hash: amendment.amendment_hash,
      result_budget_hash: amendmentResultBudget.budget_hash,
    }];
    nextApplication.updated_at = amendment.created_at;
    delete nextApplication.application_hash;
    delete nextApplication.hash_algorithm;
    nextApplication.application_hash = shortHashFull(stableJson(nextApplication));
    nextApplication.hash_algorithm = "sha256:stable-json:v1";
    assertRecordSchema(nextApplication, "assessment-application.schema.json", `Recovered assessment application ${proposalId}`);
  }

  const effectiveBudget = existingReference ? currentBudget : amendmentResultBudget;
  const candidateLineage = existingReference ? lineage : [...lineage, amendmentResultBudget];
  const receipts = readAssessmentUsageReceipts(context, proposalId);
  let decision;
  try {
    decision = evaluateBudgetUsage(effectiveBudget, receipts, {
      accepted_receipt_budgets: candidateLineage,
    });
  } catch (error) {
    fail(`The proposed budget amendment cannot be evaluated against existing usage: ${error.message}`);
  }

  if (!existing) {
    // The immutable amendment is the transaction recovery seed. Every later write is derived from it.
    writeJsonFile(amendmentPath, amendment);
  }

  const budgetSnapshotPath = assessmentBudgetSnapshotPath(context, proposalId);
  let snapshotNeedsRecovery = !fs.existsSync(budgetSnapshotPath);
  if (!snapshotNeedsRecovery) {
    const snapshot = readProjectJson(context, budgetSnapshotPath);
    assertRecordSchema(snapshot, "execution-budget.schema.json", `Effective budget snapshot ${proposalId}`);
    const integrity = validateExecutionBudgetIntegrity(snapshot);
    if (!integrity.valid) {
      fail(`Effective budget snapshot ${proposalId} failed immutable content validation: ${integrity.errors.join("; ")}`);
    }
    if (snapshot.budget_hash !== effectiveBudget.budget_hash) {
      const recoverablePreCommitSnapshot = !existingReference && snapshot.budget_hash === amendment.base_budget_hash;
      if (!recoverablePreCommitSnapshot) {
        fail(`Effective budget snapshot ${proposalId} conflicts with amendment ${amendmentId}; refusing to overwrite non-transactional content.`);
      }
      snapshotNeedsRecovery = true;
    }
  }
  ensureDir(path.dirname(assessmentBudgetSnapshotPath(context, proposalId)));
  if (snapshotNeedsRecovery) {
    writeJsonFile(budgetSnapshotPath, effectiveBudget, { force: true });
    recoveryActions.push("effective_budget_snapshot");
  }
  if (!existingReference) {
    writeJsonFile(assessmentApplicationPath(context, proposalId), nextApplication, { force: true });
    recoveryActions.push("assessment_application");
  }

  let nextWorkflow = workflow;
  const amendmentTransitionKey = `amend:${amendment.amendment_hash}`;
  const hasAmendmentTransition = (workflow.history || []).some((entry) => entry.idempotency_key === amendmentTransitionKey && entry.to === "running");
  const isLatestAmendment = nextApplication.budget_amendments?.at(-1)?.id === amendment.id;
  if (isLatestAmendment && decision.allowed_to_start_next) {
    if (workflow.state === "exception_pending") {
      nextWorkflow = transitionAssessmentWorkflow(workflow, "running", {
        at: amendment.created_at,
        proposal_hash: proposal.proposal_hash,
        authorization_ref: workflow.authorization_ref,
        actor: attribution.actor,
        reason: `Approved budget amendment ${amendment.id}: ${reason}`,
        evidence: [toProjectPath(context, amendmentPath)],
        idempotency_key: amendmentTransitionKey,
      });
      writeJsonFile(assessmentWorkflowPath(context, proposalId), nextWorkflow, { force: true });
      recoveryActions.push("assessment_workflow");
    } else if (!hasAmendmentTransition) {
      fail(`Workflow state ${workflow.state} is missing the transition bound to amendment ${amendment.id}; refusing ambiguous recovery.`);
    }
  } else if (isLatestAmendment && !decision.allowed_to_start_next && workflow.state !== "exception_pending") {
    fail(`Budget amendment ${amendment.id} still blocks execution, but workflow state is ${workflow.state}; refusing inconsistent recovery.`);
  }
  const reserveRisks = completionReserveRisks(effectiveBudget, decision);
  const stillPaused = !decision.allowed_to_start_next;
  const exceptionQuestion = stillPaused
    ? buildBudgetExceptionQuestion(proposalId, effectiveBudget, decision, reserveRisks)
    : null;
  const authorityLabel = amendment.host_approval_receipt_ref ? "host_verified" : "audit_only";
  const authorityNote = authorityAssuranceNote(authorityLabel, "budget amendment");
  output(options, {
    authority_assurance_label: authorityLabel,
    authority_note: authorityNote,
    status: stillPaused ? "exception_pending" : "amended",
    registration_status: existing ? "idempotent_replay" : "created",
    idempotent: Boolean(existing),
    recovered: Boolean(existing && recoveryActions.length > 0),
    recovery_actions: recoveryActions,
    proposal_id: proposalId,
    amendment,
    amendment_path: toProjectPath(context, amendmentPath),
    effective_budget: effectiveBudget,
    aggregate: decision,
    completion_reserve_risks: reserveRisks,
    workflow: nextWorkflow,
    assistant_message: exceptionQuestion,
  }, [
    existing
      ? `Budget amendment ${amendment.id} was replayed at the same immutable hash${recoveryActions.length ? ` and recovered: ${recoveryActions.join(", ")}` : "; no state was duplicated"}.`
      : `Approved versioned budget amendment ${amendment.id} for ${proposalId}.`,
    `Authority assurance: ${authorityLabel}`,
    authorityNote,
    `Base budget remains immutable at ${amendment.base_budget_hash}.`,
    `Effective budget is now ${effectiveBudget.budget_hash}.`,
    stillPaused
      ? `Recorded usage is still blocked (${decision.status}); the workflow remains exception_pending.`
      : `Recorded usage is now allowed (${decision.status}); the workflow resumed running.`,
    "The amendment changes only the stated limits; scope and authority boundaries are unchanged.",
    ...(exceptionQuestion ? ["", exceptionQuestion] : []),
  ]);
}

export async function completeAssessmentProposalLocked(context, options, id) {
  const proposal = readAssessmentProposal(context, id);
  let workflow = readAssessmentWorkflow(context, id);
  const application = readAssessmentApplication(context, id);
  const manifestId = normalizeId(`RELEASE-${id}`);
  const manifestFile = releaseManifestPath(context, manifestId);
  const gateId = normalizeId(`GATE-${manifestId}`);
  const gateFile = releaseGateReceiptPath(context, gateId);
  let existingGateReceipt = null;
  if (fs.existsSync(gateFile)) {
    existingGateReceipt = readProjectJson(context, gateFile);
    const { receipt_hash: storedGateHash, hash_algorithm: gateAlgorithm, ...gateHashSubject } = existingGateReceipt;
    if (
      storedGateHash !== shortHashFull(stableJson(gateHashSubject)) ||
      gateAlgorithm !== "sha256:stable-json:v1" ||
      existingGateReceipt.status !== "passed" ||
      existingGateReceipt.scope?.manifest_id !== manifestId ||
      existingGateReceipt.scope?.proposal_ref?.id !== proposal.id ||
      existingGateReceipt.scope?.proposal_ref?.hash !== proposal.proposal_hash
    ) {
      fail(`Existing release gate receipt ${gateId} is invalid or belongs to different release content.`);
    }
  }
  if (fs.existsSync(manifestFile)) {
    const manifest = readProjectJson(context, manifestFile);
    recoverAssessmentCompletionFromManifest(context, options, proposal, workflow, application, manifestFile, manifest);
    return;
  }
  if (workflow.state === "completed") {
    workflow = rewindInterruptedCompletedWorkflow(workflow);
  }
  if (!["running", "verifying", "exception_pending"].includes(workflow.state)) {
    fail(`Assessment ${id} cannot complete from state '${workflow.state}'. Resolve any exception or apply the authorized proposal first.`);
  }

  const budget = application.effective_budget || proposal.execution_budget;
  const usageReceipts = readAssessmentUsageReceipts(context, id);
  const evaluatedBudgetDecision = evaluateAssessmentBudgetUsage(context, id, budget, usageReceipts);
  const meteringCheckpointAt = existingGateReceipt?.generated_at || now();
  const { decision: budgetDecision } = requireCompletionMeteringCoverage(
    context,
    id,
    budget,
    usageReceipts,
    evaluatedBudgetDecision,
    workflow,
    meteringCheckpointAt,
  );
  const reserveRisks = completionReserveRisks(budget, budgetDecision);
  if (["soft_limit", "hard_limit", "metering_violation"].includes(budgetDecision.status)) {
    fail(buildBudgetExceptionQuestion(id, budget, budgetDecision, reserveRisks));
  }
  if (workflow.state === "exception_pending" && budgetDecision.status !== "completion_reserve") {
    fail(`Assessment ${id} has an unresolved exception. Only a completion_reserve decision may enter the completion-only path.`);
  }

  const registry = readOutputRegistry(context);
  const link = registry.links.find((item) =>
    item.story_id === proposal.story_reservation.id &&
    item.artifact_type === proposal.deliverable.artifact_type &&
    item.template_id === proposal.deliverable.template_id &&
    item.artifact_path === proposal.deliverable.artifact_path
  );
  if (!link) {
    fail([
      `Assessment ${id} cannot complete because the approved deliverable is not linked.`,
      `Expected: ${proposal.deliverable.artifact_path} as ${proposal.deliverable.artifact_type} with template ${proposal.deliverable.template_id}.`,
      `Example: agentic-sdlc output link --story ${proposal.story_reservation.id} --type ${proposal.deliverable.artifact_type} --artifact ${proposal.deliverable.artifact_path} --template ${proposal.deliverable.template_id} --mode new --requirement ${proposal.scope.requirement_id}`,
    ].join("\n"));
  }
  const verification = link.verification_receipt;
  const visual = OUTPUT_VISUAL_FORMATS.has(proposal.deliverable.delivery.format);
  if (!verificationReceiptSatisfies(verification, { visual })) {
    fail(`Assessment ${id} output is not fully verified. Required dimensions: container=verified, content=verified, render=${visual ? "verified" : "not-required"}.`);
  }
  if (verification.kind !== "verification_receipt" || !link.verification_receipt_ref) {
    fail(`Assessment ${id} output uses a legacy inline verification assertion. Re-link the artifact to create a canonical, persisted verification receipt.`);
  }
  const verificationIntegrity = validateVerificationReceiptIntegrity(verification);
  if (!verificationIntegrity.valid) {
    fail(`Assessment ${id} verification receipt failed integrity validation: ${verificationIntegrity.errors.join("; ")}`);
  }
  assertRecordSchema(verification, "verification-receipt.schema.json", `Verification receipt ${verification.id}`);
  const verificationFile = resolveProjectFilePath(context, link.verification_receipt_ref.path, { mustExist: true, fileOnly: true });
  const persistedVerification = readProjectJson(context, verificationFile);
  if (
    link.verification_receipt_ref.hash !== verification.receipt_hash ||
    stableJson(persistedVerification) !== stableJson(verification)
  ) {
    fail(`Assessment ${id} persisted verification receipt does not match the linked immutable receipt.`);
  }
  const artifactPath = resolveProjectFilePath(context, link.artifact_path, { mustExist: true, fileOnly: true });
  const artifactSha256 = hashFile(artifactPath);
  if (artifactSha256 !== verificationArtifactSha256(verification)) {
    fail(`Assessment artifact ${link.artifact_path} changed after verification.`);
  }

  const requirementFile = requirementPath(context, proposal.scope.requirement_id);
  const storyPath = path.join(context.sdlcRoot, "stories", proposal.story_reservation.id, "story.json");
  const contractPath = path.join(context.sdlcRoot, "contracts", `${proposal.contract_draft.id}.json`);
  for (const [label, filePath] of [
    ["requirement", requirementFile],
    ["story", storyPath],
    ["contract", contractPath],
  ]) {
    if (!fs.existsSync(filePath)) {
      fail(`Assessment ${id} cannot complete because its approved ${label} record is missing: ${toProjectPath(context, filePath)}.`);
    }
  }

  const attribution = buildAttribution(context, options, "assessment.proposal.complete");
  const auditGit = existingGateReceipt?.audit?.git || attribution.git;
  if (auditGit?.is_git_repo && auditGit.head_sha && typeof auditGit.is_dirty !== "boolean") {
    // The release manifest records whether its source revision was clean; an
    // unknown worktree state must not be written down as clean.
    fail(`Assessment ${id} cannot complete because Git could not report whether the worktree is clean.`);
  }
  const authorization = readAuthorization(context, workflow.authorization_ref);
  const use = recordOrReuseAuthorizationUse(context, authorization, "assessment.proposal.complete", {
    proposal_ref: { id, hash: proposal.proposal_hash },
    subject_id: id,
    artifact_types: [proposal.deliverable.artifact_type],
  });
  const contextOptimization = existingGateReceipt
    ? { status: "recovery_reuse", persisted: false, telemetry: null, observation: null, path: null }
    : await captureContextOptimization(context, id, "complete", contextOptimizationRuntimeOptions(options));
  const completionAt = existingGateReceipt?.generated_at || now();
  const completionActor = existingGateReceipt?.actor || attribution.actor;
  const completionAudit = existingGateReceipt?.audit || { git: attribution.git, run: attribution.run };
  if (workflow.state === "exception_pending") {
    workflow = transitionAssessmentWorkflow(workflow, "running", {
      at: completionAt,
      proposal_hash: proposal.proposal_hash,
      authorization_ref: authorization.id,
      actor: completionActor,
      reason: "Completion reserve permits only the already-authorized verification and release path.",
      evidence: [link.artifact_path, link.verification_receipt_ref.path],
      idempotency_key: `completion-reserve:${artifactSha256}`,
    });
  }
  if (workflow.state === "running") {
    workflow = transitionAssessmentWorkflow(workflow, "verifying", {
      at: completionAt,
      proposal_hash: proposal.proposal_hash,
      authorization_ref: authorization.id,
      actor: completionActor,
      reason: "The canonical output is linked; running final verification and release-manifest checks.",
      evidence: [link.artifact_path, link.verification_receipt_ref.path],
      idempotency_key: `verify:${artifactSha256}`,
    });
  }
  const completedWorkflow = transitionAssessmentWorkflow(workflow, "completed", {
    at: completionAt,
    proposal_hash: proposal.proposal_hash,
    authorization_ref: authorization.id,
    actor: completionActor,
    reason: "Canonical output, budget, lineage, authorization-use, and release evidence checks passed.",
    evidence: [link.artifact_path, link.verification_receipt_ref.path, toProjectPath(context, manifestFile)],
    idempotency_key: `complete:${artifactSha256}`,
  });
  assertRecordSchema(completedWorkflow, "assessment-workflow.schema.json", `Assessment workflow ${id}`);

  const story = readStory(context, proposal.story_reservation.id);
  story.status = "done";
  story.updated_at = completionAt;
  story.audit = { ...(story.audit || {}), updated_by: completionActor, git: completionAudit.git, run: completionAudit.run };

  const proposalRef = hashedFileReference(context, id, assessmentProposalPath(context, id), proposal.proposal_hash);
  const requirementRef = hashedFileReference(context, proposal.scope.requirement_id, requirementFile);
  const storyRef = {
    id: proposal.story_reservation.id,
    path: toProjectPath(context, storyPath),
    hash: hashJsonFileValue(story),
  };
  const contractRef = hashedFileReference(context, proposal.contract_draft.id, contractPath);
  const workflowRef = {
    id,
    path: toProjectPath(context, assessmentWorkflowPath(context, id)),
    hash: completedWorkflow.workflow_hash,
    state: "completed",
  };
  const verificationRef = {
    id: verification.id,
    path: link.verification_receipt_ref.path,
    hash: verification.receipt_hash,
  };
  const budgetFile = assessmentBudgetSnapshotPath(context, id);
  ensureDir(path.dirname(budgetFile));
  writeJsonFile(budgetFile, budget, { force: fs.existsSync(budgetFile) });
  const budgetRef = hashedFileReference(context, budget.id, budgetFile, budget.budget_hash);

  const authorizationUsePaths = Array.from(new Set([
    ...(application.authorization_use_refs || []),
    link.authorization_use_ref,
    use.path,
  ].filter(Boolean)));
  const authorizationUseRefs = authorizationUsePaths.map((receiptPath) => {
    const receipt = readAuthorizationUseReceipt(context, receiptPath);
    const errors = validateAuthorizationUseReceipt(receipt, { authorization_id: authorization.id });
    if (errors.length > 0) {
      fail(`Release authorization receipt ${receipt.id || receiptPath} is invalid: ${errors.join("; ")}`);
    }
    return { id: receipt.id, path: receiptPath, hash: receipt.receipt_hash };
  });
  const executionUsageRefs = usageReceipts.map((receipt) => ({
    id: receipt.id,
    path: toProjectPath(context, path.join(assessmentUsageRoot(context, id), `${normalizeId(receipt.id)}.json`)),
    hash: receipt.receipt_hash,
  }));
  const contextOptimizationRefs = readContextOptimizationObservations(context, id).map(({ filePath, observation }) => ({
    id: observation.id,
    path: toProjectPath(context, filePath),
    hash: observation.observation_hash,
  }));
  const project = readProjectSafe(context);
  const sourceRevision = completionAudit.git.is_git_repo && completionAudit.git.head_sha
    ? { type: "git", value: completionAudit.git.head_sha, branch: completionAudit.git.branch, dirty: Boolean(completionAudit.git.is_dirty) }
    : { type: "snapshot", value: hashFile(path.join(context.sdlcRoot, "project.json")), branch: null, dirty: false };
  const rollback = {
    available: Boolean(completionAudit.git.is_git_repo && completionAudit.git.head_sha),
    instructions: completionAudit.git.is_git_repo
      ? ["Create a reviewed revert of the released source revision; preserve this manifest and all immutable receipts as audit evidence."]
      : ["Restore the project from a verified snapshot; preserve this manifest and all immutable receipts as audit evidence."],
    target_revision: completionAudit.git.head_sha || null,
  };

  const candidateGateReceipt = buildReleaseGateReceipt(context, {
    id: gateId,
    manifest_id: manifestId,
    proposal_ref: proposalRef,
    generated_at: completionAt,
    actor: completionActor,
    audit: completionAudit,
    checks: [
      { name: "proposal_integrity", evidence: [proposalRef] },
      { name: "active_scope_lineage", evidence: [
        requirementRef,
        storyRef,
        contractRef,
        { id: workflowRef.id, path: workflowRef.path, hash: workflowRef.hash },
      ] },
      { name: "layered_output_verification", evidence: [verificationRef, { id: link.id, path: link.artifact_path, hash: artifactSha256 }] },
      { name: "execution_budget", evidence: [budgetRef, ...executionUsageRefs] },
      ...(contextOptimizationRefs.length > 0 ? [{ name: "context_optimization", evidence: contextOptimizationRefs }] : []),
      { name: "historical_authorization_at_use", evidence: authorizationUseRefs },
      { name: "source_revision", subject: sourceRevision, evidence: [] },
      { name: "rollback", subject: rollback, evidence: [] },
    ],
  });
  const gateReceipt = existingGateReceipt || candidateGateReceipt;
  if (existingGateReceipt && existingGateReceipt.receipt_hash !== candidateGateReceipt.receipt_hash) {
    fail(`Existing release gate receipt ${gateId} does not match the reconstructed release evidence.`);
  }
  assertRecordSchema(gateReceipt, "release-gate-receipt.schema.json", `Release gate receipt ${gateId}`);
  const gateRef = { id: gateId, path: toProjectPath(context, gateFile), hash: gateReceipt.receipt_hash };

  const manifest = {
    kind: "release_manifest",
    schema_version: "release-manifest:v1",
    version: 1,
    id: manifestId,
    status: "released",
    project: { id: project.project_id, name: project.project_name },
    source_revision: sourceRevision,
    requirements: [requirementRef],
    stories: [storyRef],
    contracts: [contractRef],
    proposals: [proposalRef],
    workflow: workflowRef,
    artifacts: [{
      id: link.id,
      artifact_type: link.artifact_type,
      path: link.artifact_path,
      sha256: artifactSha256,
      verification_receipt_ref: verificationRef,
    }],
    authorization_usage_receipts: authorizationUseRefs,
    execution_usage_receipts: executionUsageRefs,
    context_optimization_observations: contextOptimizationRefs,
    budget_decision: {
      budget_ref: budgetRef,
      status: completionBudgetStatus(budgetDecision),
      unmeasured_metrics: [...(budgetDecision.unmeasured_metrics || [])],
      receipt_count: usageReceipts.length,
      usage: budgetDecision.usage,
      remaining: budgetDecision.remaining,
      completion_reserve_risks: reserveRisks,
    },
    gate_receipts: [gateRef],
    rollback,
    legacy_history_policy: "logically_archived_out_of_release_scope",
    generated_at: completionAt,
    released_at: completionAt,
    audit: { actor: completionActor, git: completionAudit.git, run: completionAudit.run },
  };
  manifest.manifest_hash = shortHashFull(stableJson(manifest));
  manifest.hash_algorithm = "sha256:stable-json:v1";
  assertRecordSchema(manifest, "release-manifest.schema.json", `Release manifest ${manifestId}`);

  application.status = "completed";
  application.completed_at = completionAt;
  application.output_ref = {
    id: link.id,
    path: link.artifact_path,
    verification_receipt_ref: verificationRef,
  };
  application.release_manifest_ref = { id: manifestId, path: toProjectPath(context, manifestFile), manifest_hash: manifest.manifest_hash };
  application.authorization_use_refs = authorizationUsePaths;
  delete application.application_hash;
  delete application.hash_algorithm;
  application.application_hash = shortHashFull(stableJson(application));
  application.hash_algorithm = "sha256:stable-json:v1";
  assertRecordSchema(application, "assessment-application.schema.json", `Assessment application ${application.id}`);

  ensureDir(path.dirname(gateFile));
  ensureDir(path.dirname(manifestFile));
  const completionTargets = [
    { path: storyPath, value: story, force: true },
    { path: gateFile, value: gateReceipt, force: false },
    { path: assessmentApplicationPath(context, id), value: application, force: true },
    { path: manifestFile, value: manifest, force: false },
    { path: assessmentWorkflowPath(context, id), value: completedWorkflow, force: true },
  ].map((target) => ({
    ...target,
    existed: fs.existsSync(target.path),
    original: fs.existsSync(target.path) ? readProjectText(context, target.path) : null,
  }));
  try {
    for (const target of completionTargets) {
      writeJsonFile(target.path, target.value, { force: target.force });
    }
    assertReleaseManifestIntegrity(context, manifest);
  } catch (error) {
    const rollbackErrors = [];
    for (const target of completionTargets.reverse()) {
      try {
        if (target.existed) {
          writeTextFile(target.path, target.original, { force: true });
        } else if (fs.existsSync(target.path)) {
          assertNoSymlinkPathSegments(target.path, context.root);
          removePathGoverned(target.path);
        }
      } catch (rollbackError) {
        rollbackErrors.push(`${toProjectPath(context, target.path)}: ${rollbackError.message}`);
      }
    }
    if (rollbackErrors.length > 0) {
      fail(`Release validation failed (${error.message}) and transactional rollback was incomplete: ${rollbackErrors.join("; ")}`);
    }
    throw error;
  }
  closeContentAuthorization(context, authorization.id, `Assessment workflow ${id} completed.`, completionActor);
  appendTraceEvent(context, proposal.story_reservation.id, {
    type: "release",
    outcome: "passed",
    summary: `Completed assessment workflow ${id} with verified canonical output`,
    action: "assessment.proposal.complete",
    actor: completionActor,
    evidence: [link.artifact_path, toProjectPath(context, manifestFile), toProjectPath(context, gateFile)],
    related: [id, manifestId, link.id],
    authorization_ref: authorization.id,
    git: completionAudit.git,
    run: completionAudit.run,
  });
  const unmeasuredMetrics = manifest.budget_decision.unmeasured_metrics || [];
  const budgetWarning = unmeasuredMetrics.length > 0
    ? `Warning: no usage was recorded for ${unmeasuredMetrics.join(", ")}, so the budget could not be checked for ${unmeasuredMetrics.length === 1 ? "it" : "them"}.`
    : null;
  output(options, {
    status: "completed",
    proposal_id: id,
    workflow: completedWorkflow,
    application,
    release_manifest: manifest,
    budget: budgetDecision,
    budget_status: manifest.budget_decision.status,
    unmeasured_metrics: unmeasuredMetrics,
    budget_warning: budgetWarning,
    context_optimization: contextOptimization,
  }, [
    `Completed assessment ${id}.`,
    `Budget: ${manifest.budget_decision.status}.`,
    ...(budgetWarning ? [budgetWarning] : []),
    `Canonical output: ${link.artifact_path}`,
    `Verification: container verified, content verified, render ${verificationDimensionStatus(verification, "render_verified")}.`,
    `Release manifest: ${toProjectPath(context, manifestFile)}`,
    `Authorization ${authorization.id} is closed; it cannot be reused for future work.`,
    `Context optimization: ${contextOptimization?.status || "unavailable"}; budget usage adjustment 0.`,
  ]);
}

export function readProjectFileExcerpt(context, relativePath, maxLength = 220) {
  try {
    const filePath = resolveProjectFilePath(context, relativePath, { mustExist: true, fileOnly: true });
    return compactText(readProjectText(context, filePath), maxLength);
  } catch {
    return null;
  }
}

export function readProjectMarkdownHeadings(context, relativePath, maxHeadings = 8) {
  try {
    const filePath = resolveProjectFilePath(context, relativePath, { mustExist: true, fileOnly: true });
    return readProjectText(context, filePath)
      .split(/\r?\n/)
      .map((line) => line.match(/^(#{1,3})\s+(.+?)\s*$/))
      .filter(Boolean)
      .map((match) => match[2].replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, maxHeadings);
  } catch {
    return [];
  }
}

/**
 * Pre-lock guard that a story exists, answered from its directory instead of
 * its `story.json`.
 *
 * Whoever holds the story lock rewrites `story.json` by renaming a temporary
 * file over it. On Windows a process still waiting for that lock which touches
 * the file at that moment can see it mid-replacement and fail with `EPERM`,
 * `EACCES`, or `EBUSY`, and its short-lived handle can make the holder's rename
 * fail the same way. The story directory is never replaced by those writers,
 * so checking it keeps every access to `story.json` under the lock, where the
 * record is read again and a missing story is still refused.
 */
export function storyDirectoryExistsBeforeLock(context, storyId) {
  return pathEntryExistsNoFollow(path.join(context.sdlcRoot, "stories", normalizeId(storyId)));
}

export function createContractLocked(context, options, settings) {
  const {
    phase,
    storyId,
    deliveryProfileId,
    id,
    contractPath,
  } = settings;
  if (storyId) {
    const story = readStory(context, storyId);
    if (!story) {
      fail(`Story ${storyId} does not exist; create it before creating story contract ${id}.`);
    }
    if (storyAcceptanceCriteria(story).length === 0) {
      fail(
        `Story ${storyId} has no observable acceptance criteria. `
        + `Run 'story acceptance add --id ${storyId} --acceptance <criterion>' before contract setup.`,
      );
    }
    const taskStartPath = path.join(context.sdlcRoot, "stories", storyId, "task-start.json");
    if (pathEntryExistsNoFollow(taskStartPath)) {
      const replacement = inspectTaskStartReplacementBoundary(
        context,
        taskStartPath,
        {
          story_id: storyId,
          contract_id: id,
          delivery_profile_id: deliveryProfileId,
        },
      );
      if (!replacement.allowed) {
        fail(
          `Story ${storyId} already has an immutable task-start boundary (${replacement.reason}); `
          + "only a new contract and delivery choice after the previous delivery is terminal may continue the same story.",
        );
      }
    }
  }
  const requirementContext = storyRequirementExecutionContext(context, storyId);
  if (
    requirementContext.has_v2_requirements
    && ["implementation", "validation", "release"].includes(phase)
    && ["enforce_new_only", "enforce_all"].includes(context.config.autonomy_policy?.mode)
    && !deliveryProfileId
  ) {
    fail(`A ${phase} contract for requirement:v2 needs --delivery-profile <new-profile-id>. The exact PR or local release selection is approved separately.`);
  }
  const autonomyLevel = normalizeAutonomyLevel(
    getOptionString(options, "level") || requirementContext.autonomy_ceiling,
  );
  const levelRank = AUTONOMY_LEVEL_RANK;
  if (levelRank[autonomyLevel] > levelRank[requirementContext.autonomy_ceiling]) {
    fail(`Contract autonomy ${autonomyLevel} exceeds requirement ceiling ${requirementContext.autonomy_ceiling}.`);
  }
  const recommendationContext = loadCapabilityRecommendationsForContract(context, options);
  const explicitCapabilityPolicy = loadCapabilityPolicy(context, options);
  const explicitCapabilityBindings = loadCapabilityBindings(context, options);
  const executionSuggestions = recommendationContext.execution_policy_suggestions;
  const contract = buildContract(context, phase, {
    id,
    story_id: storyId,
    requirement_refs: requirementContext.requirement_refs,
    requirement_execution_profile_refs: requirementContext.requirement_profile_refs,
    delivery_execution_profile_id: deliveryProfileId,
    autonomy_level: autonomyLevel,
    owner_agent: options["owner-agent"],
    status: String(options.status || "draft"),
    context_summary: options["context-summary"],
    context_files: normalizeRawListOption(options["context-file"]),
    questions: normalizeRawListOption(options.question),
    qa: normalizeRawListOption(options.qa),
    constraints: normalizeListOption(options.constraint),
    assumptions: normalizeListOption(options.assumption),
    inputs: normalizeListOption(options.input),
    outputs: normalizeListOption(options.output),
    output_refs: normalizeRawListOption(options["output-ref"]),
    validation: normalizeListOption(options.validation),
    allowed_tools: normalizeListOption(options.tool),
    kb_writes: normalizeListOption(options["kb-write"]),
    metrics: normalizeListOption(options.metric),
    model: options.model === undefined ? executionSuggestions.model : options.model,
    reasoning: options.reasoning === undefined ? executionSuggestions.reasoning : options.reasoning,
    execution_notes: mergeList(
      executionSuggestions.notes,
      normalizeRawListOption(options["execution-note"]),
    ),
    capability_policy: mergeCapabilityPolicies(recommendationContext.policy_patch, explicitCapabilityPolicy),
    capability_bindings: [
      ...recommendationContext.bindings,
      ...explicitCapabilityBindings,
    ],
    capability_recommendation_refs: recommendationContext.refs,
    questions: mergeList(normalizeRawListOption(options.question), recommendationContext.open_questions),
    audit_options: options,
    audit_action: "contract.create",
  });
  validateContractReadinessForCreate(context, contract, options);
  validateContractOutputRefsForCreate(context, normalizeRawListOption(options["output-ref"]), options);
  assertDeliveryProfileReservationUnique(context, deliveryProfileId, id);
  const storyLink = validateStoryContractLinkForCreate(context, storyId, id, options);
  const previousContractSnapshot = pathEntryExistsNoFollow(contractPath)
    ? readStableRegularFileBuffer(contractPath, context.root)
    : null;
  if (previousContractSnapshot) {
    let previousContract;
    try {
      previousContract = JSON.parse(previousContractSnapshot.content.toString("utf8"));
    } catch {
      fail(`Existing contract ${id} does not contain valid canonical JSON and cannot be overwritten.`);
    }
    const previousStoryId = previousContract.story_id
      ? normalizeId(String(previousContract.story_id))
      : null;
    if (previousStoryId !== storyId) {
      fail(
        `Contract ID ${id} is already bound to ${previousStoryId || "the project"}, not ${storyId || "the project"}. `
        + "It cannot be reassigned with --force; use a new contract ID.",
      );
    }
    if (
      previousContract.status !== "draft"
      || (Array.isArray(previousContract.approvals) && previousContract.approvals.length > 0)
    ) {
      fail(
        `Contract ${id} is already reviewed or no longer a draft and is immutable. `
        + "Preserve it as history and create a new exact contract ID.",
      );
    }
  }
  let linkedStory;
  try {
    writeJsonFile(contractPath, contract, { force: Boolean(options.force), forceOption: true });
    linkedStory = linkStoryToContractAfterCreate(context, storyLink, contract, contractPath);
  } catch (error) {
    try {
      if (previousContractSnapshot) {
        writeTextFile(
          contractPath,
          previousContractSnapshot.content.toString("utf8"),
          { force: true },
        );
      } else if (pathEntryExistsNoFollow(contractPath)) {
        removePathGoverned(contractPath, { force: true });
      }
    } catch (rollbackError) {
      fail(
        `Contract ${id} creation failed and its exact prior file state could not be restored: `
        + `${rollbackError.message}. Original failure: ${error.message}`,
      );
    }
    throw error;
  }
  const guidance = contractProposalHumanGuidance(contract, options);
  output(
    options,
    {
      status: "proposed",
      write_status: "created",
      contract_path: contractPath,
      contract,
      story_link: linkedStory,
      human_guidance: guidance,
    },
    humanGuidanceLines(
      guidance,
      [
        `Contract: ${id}`,
        `Phase: ${phase}`,
        `Lifecycle status: ${contract.status}`,
        `Path: ${toProjectPath(context, contractPath)}`,
        ...(contract.contextualization?.summary
          ? [`Context summary: ${contract.contextualization.summary}`]
          : []),
        ...(storyId ? [`Story: ${storyId}`] : []),
      ],
      options,
      contractProposalPrimarySummary(contract, options),
    ),
  );
}

export function readProjectSafe(context) {
  const projectPath = path.join(context.sdlcRoot, "project.json");
  if (!fs.existsSync(projectPath)) {
    return null;
  }
  return readProjectJson(context, projectPath);
}

export function shouldDependencyBlockStory(context, edge, story) {
  if (!story || edge.blocks === "none") {
    return true;
  }
  return storyPhaseRank(context, story) >= phaseRank(edge.blocks);
}

export function lockPhase(context, options) {
  ensureInitialized(context);
  const phase = String(requireOption(options, "phase"));
  if (!context.config.phases[phase]) {
    fail(`Unknown phase '${phase}'. Valid phases: ${Object.keys(context.config.phases).join(", ")}`);
  }
  const scope = String(options.scope || phase);
  const expiresAt = options["expires-at"] ? normalizeOptionalDateTime(options["expires-at"], "expires-at") : null;
  const lockMutexPath = path.join(context.sdlcRoot, "locks", `.phase-${shortHash(`${phase}:${scope}`)}.lock`);
  const releaseLock = acquireFileLock(lockMutexPath);
  let lock;
  let lockPath;
  let lockId;
  const attribution = buildAttribution(context, options, "phase.lock");
  try {
    const conflictingLock = readActiveLocks(context).find(
      (candidate) => candidate.phase === phase && String(candidate.scope || candidate.phase) === scope,
    );
    if (conflictingLock && !options.force) {
      fail(
        `Phase ${phase} scope ${scope} already has active lock ${conflictingLock.id}. Release it first or use --force after coordination.`,
      );
    }
    if (conflictingLock && options.force) {
      requireCoordinationOverrideActor(attribution, `Overriding phase lock ${conflictingLock.id}`);
      const conflictingPath = path.join(context.sdlcRoot, "locks", `${normalizeId(conflictingLock.id)}.json`);
      conflictingLock.status = "cancelled";
      conflictingLock.released_at = now();
      conflictingLock.release_reason = `Replaced by coordinated override from ${attribution.actor.id}`;
      conflictingLock.audit = {
        ...(conflictingLock.audit || {}),
        released_by: attribution.actor,
        git: attribution.git,
        run: attribution.run,
      };
      writeJsonFile(conflictingPath, conflictingLock, { force: true });
    }
    lockId = normalizeId(String(options.id || `LOCK-${phase}-${uniqueRecordSuffix()}`));
    lockPath = path.join(context.sdlcRoot, "locks", `${lockId}.json`);
    lock = {
      id: lockId,
      phase,
      scope,
      status: "active",
      reason: options.reason ? String(options.reason) : null,
      expires_at: expiresAt,
      created_at: now(),
      audit: {
        locked_by: attribution.actor,
        git: attribution.git,
        run: attribution.run,
      },
    };
    assertRecordSchema(lock, "phase-lock.schema.json", `Phase lock ${lockId}`);
    writeJsonFile(lockPath, lock, { force: Boolean(options.force), forceOption: true });
  } finally {
    releaseLock();
  }
  appendTraceEvent(context, null, {
    type: "lock",
    summary: `Phase ${phase} locked: ${lock.reason || lock.scope}`,
    action: "phase.lock",
    actor: attribution.actor,
    evidence: [toProjectPath(context, lockPath)],
    related: [phase, lockId],
    git: attribution.git,
    run: attribution.run,
  });
  output(options, { status: "locked", lock_path: lockPath, lock }, [`Locked phase ${phase} with ${lockId}`]);
}

export function releasePhaseLock(context, options) {
  ensureInitialized(context);
  const id = normalizeId(requireOption(options, "id"));
  const lockPath = path.join(context.sdlcRoot, "locks", `${id}.json`);
  if (!fs.existsSync(lockPath)) {
    fail(`Phase lock ${id} does not exist`);
  }
  const lock = readProjectJson(context, lockPath);
  const attribution = buildAttribution(context, options, "phase.release");
  lock.status = normalizeLockStatus(options.status || "released");
  lock.released_at = now();
  lock.release_reason = options.reason ? String(options.reason) : null;
  lock.audit = {
    ...(lock.audit || {}),
    released_by: attribution.actor,
    git: attribution.git,
    run: attribution.run,
  };
  writeJsonFile(lockPath, lock, { force: true });
  appendTraceEvent(context, null, {
    type: "lock",
    summary: `Phase lock ${id} ${lock.status}`,
    action: "phase.release",
    actor: attribution.actor,
    evidence: [toProjectPath(context, lockPath)],
    related: [lock.phase, id],
    git: attribution.git,
    run: attribution.run,
  });
  output(options, { status: lock.status, lock_path: lockPath, lock }, [`Released phase lock ${id}`]);
}

export function appendTraceLocked(context, options, type, summary, storyId) {
  if (storyId && ["test", "release"].includes(type)) {
    const finalReceiptExists = fs.existsSync(
      workflowFinalGateReceiptPath(context, storyId),
    );
    const lifecycle = effectiveStoryLifecycleProjection(
      context,
      readStory(context, storyId),
    );
    const repairOutcome = type === "test"
      ? options.outcome === "passed"
      : ["passed", "ready"].includes(options.outcome);
    if (
      (
        lifecycle.terminal
        && CERTIFIED_TERMINAL_LIFECYCLE_SOURCES.includes(lifecycle.source)
      )
      || (finalReceiptExists && !repairOutcome)
    ) {
      fail(
        `Story ${storyId} already has a terminal lifecycle receipt. `
        + "An invalidated receipt permits only passing in-place repair evidence before recertification; "
        + "create a new governed story for later failed attempts or different lifecycle evidence.",
      );
    }
  }
  const traceFile = storyId ? `${storyId}.jsonl` : "project.jsonl";
  const tracePath = path.join(context.sdlcRoot, "traces", traceFile);
  const attribution = buildAttribution(context, options, `trace.${type}`);
  const gitEvent = options["git-event"] ? normalizeGitEvent(options["git-event"]) : null;
  let narrative;
  try {
    narrative = buildTraceNarrative(options);
  } catch (error) {
    fail(error.message);
  }
  const { evidence, unverified: unverifiedEvidence } = normalizeManualTraceEvidence(
    context,
    normalizeListOption(options.evidence).map(normalizeProjectPathInput),
  );
  const event = {
    id: `TR-${compactTimestamp()}-${crypto.randomBytes(3).toString("hex")}`,
    story_id: storyId,
    type,
    summary,
    outcome: options.outcome ? normalizeTraceOutcome(options.outcome) : null,
    actor: attribution.actor,
    ...buildTraceAuthorityMetadata(context, options, attribution),
    action: normalizeScalarOption(options.action, "action") || type,
    evidence,
    related: normalizeListOption(options.related),
    ...(narrative ? { narrative } : {}),
    git: {
      ...attribution.git,
      event: gitEvent,
    },
    run: attribution.run,
    correlation_id: CLI_OPERATION_CONTEXT.correlation_id,
    created_at: now(),
  };
  assertManualTraceActionIsSafe(event);
  const snapshottedEvent = snapshotManualTraceEvidence(context, event);
  const sealedEvent = sealGovernedTraceEvent(context, tracePath, snapshottedEvent);
  output(options, {
    status: "appended",
    trace_path: toProjectPath(context, tracePath),
    event: sealedEvent,
    evidence_unverified: unverifiedEvidence,
  }, [
    `Appended ${type} trace ${sealedEvent.id}`,
    ...unverifiedEvidence.map((projectPath) => `Evidence not verified: ${projectPath} does not exist, so only its path was recorded (no content fingerprint).`),
  ]);
}

/**
 * Evidence names a file inside the project or an http(s) URL. Local paths
 * outside the project (absolute paths elsewhere, ../ escapes, or symlinks
 * leaving the project) are refused; a missing in-project path is recorded as
 * a path only and reported as not verified, because no fingerprint of its
 * content can be sealed. An http(s) URL is kept exactly as given as a
 * non-file reference; it is never fetched or fingerprinted. Other URI
 * schemes such as file: are refused like paths outside the project.
 */
const EVIDENCE_URL_PATTERN = /^https?:\/\/[^\s/?#]{1,255}[^\s]{0,4096}$/iu;
// Any other URI scheme (file:, ftp:, data:, ...) is neither a project file
// nor a web reference. A single letter followed by a colon is a Windows
// drive and is handled as a local path.
const NON_WEB_URI_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:/u;

export function normalizeManualTraceEvidence(context, rawPaths) {
  const evidence = [];
  const unverified = [];
  for (const value of rawPaths) {
    if (EVIDENCE_URL_PATTERN.test(value)) {
      evidence.push(value);
      continue;
    }
    if (NON_WEB_URI_PATTERN.test(value)) {
      fail(
        `Evidence must name a file inside this project or an http(s) URL: ${value}. `
        + "Copy the evidence into the project and pass its project-relative path.",
      );
    }
    let resolved;
    try {
      resolved = resolveProjectFilePath(context, value, { mustExist: false });
    } catch (error) {
      if (!(error instanceof UserError)) throw error;
      fail(
        `Evidence path must name a file inside this project: ${value}. `
        + "Copy the evidence into the project and pass its project-relative path.",
      );
    }
    const projectPath = toProjectPath(context, resolved);
    // A name such as "..reports/r.txt" is inside the project; only a ".."
    // path segment leaves it.
    if (!projectPath || projectPath === ".." || projectPath.startsWith("../") || path.isAbsolute(projectPath)) {
      fail(`Evidence path must name a file inside this project: ${value}.`);
    }
    if (!fs.existsSync(resolved)) {
      unverified.push(projectPath);
    } else if (!fs.statSync(resolved).isFile()) {
      fail(`Evidence path must name a file, not a directory: ${projectPath}.`);
    }
    evidence.push(projectPath);
  }
  return { evidence, unverified };
}

export function withOutputRegistryLock(context, callback) {
  const releaseLock = acquireFileLock(path.join(outputContractsRoot(context), "registry.lock"));
  try {
    return callback();
  } finally {
    releaseLock();
  }
}

export function hashFile(filePath) {
  return hashBuffer(fs.readFileSync(filePath));
}

export function readStableRegularFileBuffer(filePath, boundaryRoot) {
  assertNoSymlinkPathSegments(filePath, boundaryRoot);
  const parentIdentity = captureDirectoryIdentity(path.dirname(filePath));
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | NO_FOLLOW_FLAG);
    const before = verifyOpenFileMatchesPath(descriptor, filePath, parentIdentity);
    const content = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    verifyOpenFileMatchesPath(descriptor, filePath, parentIdentity);
    if (
      !sameStableFileIdentity(before, after)
      || before.size !== after.size
      || before.mode !== after.mode
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
      || content.byteLength !== after.size
    ) {
      fail(`File changed while creating its stable snapshot: ${filePath}`);
    }
    return {
      content,
      file_type: "regular",
      mode: after.mode & 0o7777,
      size_bytes: after.size,
      sha256: hashBuffer(content),
    };
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

export function readStableRegularFileDigest(filePath, boundaryRoot, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    fail("Stable file digest maxBytes must be a non-negative safe integer.");
  }
  assertNoSymlinkPathSegments(filePath, boundaryRoot);
  const parentIdentity = captureDirectoryIdentity(path.dirname(filePath));
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | NO_FOLLOW_FLAG);
    const before = verifyOpenFileMatchesPath(descriptor, filePath, parentIdentity);
    if (before.size > maxBytes) {
      fail(`Local release freshness target exceeds 512 MiB: ${filePath}`);
    }
    const digest = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    let position = 0;
    while (total < before.size) {
      const bytesRead = fs.readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.byteLength, before.size - total),
        position,
      );
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
      total += bytesRead;
      position += bytesRead;
    }
    const after = fs.fstatSync(descriptor);
    verifyOpenFileMatchesPath(descriptor, filePath, parentIdentity);
    if (
      !sameStableFileIdentity(before, after)
      || before.size !== after.size
      || before.mode !== after.mode
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
      || total !== after.size
    ) {
      fail(`File changed while creating its stable digest: ${filePath}`);
    }
    return {
      file_type: "regular",
      mode: after.mode & 0o7777,
      size_bytes: after.size,
      sha256: digest.digest("hex"),
    };
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

export function readStableRegularFilePrefix(filePath, boundaryRoot, maxBytes = 4096) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    fail("Stable file prefix maxBytes must be a positive safe integer.");
  }
  assertNoSymlinkPathSegments(filePath, boundaryRoot);
  const parentIdentity = captureDirectoryIdentity(path.dirname(filePath));
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | NO_FOLLOW_FLAG);
    const before = verifyOpenFileMatchesPath(descriptor, filePath, parentIdentity);
    const buffer = Buffer.allocUnsafe(Math.min(maxBytes, Math.max(before.size, 1)));
    const bytesRead = before.size > 0
      ? fs.readSync(descriptor, buffer, 0, Math.min(buffer.byteLength, before.size), 0)
      : 0;
    const after = fs.fstatSync(descriptor);
    verifyOpenFileMatchesPath(descriptor, filePath, parentIdentity);
    if (
      !sameStableFileIdentity(before, after)
      || before.size !== after.size
      || before.mode !== after.mode
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
    ) {
      fail(`File changed while reading its stable prefix: ${filePath}`);
    }
    return buffer.subarray(0, bytesRead);
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

export function stableContextSourceSnapshot(context, rawPath, label = "Context source") {
  const filePath = resolveProjectFilePath(context, rawPath, { mustExist: true, fileOnly: true });
  assertContextSourcePathSafe(context, filePath, label);
  return {
    filePath,
    projectPath: toProjectPath(context, filePath),
    ...readStableRegularFileBuffer(filePath, context.root),
  };
}

export function sealGovernedTraceEvent(context, tracePath, event) {
  const preparedEvent = prepareGovernedTraceEvent(context, event);
  const releaseLegacyTraceLock = acquireFileLock(`${tracePath}.lock`);
  try {
    assertNoPendingWorkflowTraceTransaction(context, tracePath);
    return sealPreparedTraceEventLocked(context, tracePath, preparedEvent);
  } finally {
    releaseLegacyTraceLock();
  }
}

export function prepareGovernedTraceEvent(context, event) {
  const redactionPolicy = buildTraceRedactionPolicy(context);
  const evidenceRefs = buildTraceEvidenceRefs(context, event, redactionPolicy);
  const redacted = redactValue({
    ...event,
    evidence_refs: evidenceRefs,
  }, redactionPolicy);
  if (!redacted || typeof redacted !== "object" || Array.isArray(redacted)) {
    fail("Trace redaction reached its safety limit; no event was persisted.");
  }
  return redacted;
}

export function sealPreparedTraceEventLocked(context, tracePath, preparedEvent) {
  try {
    return sealTraceEvent({
      ...traceIntegrityOptions(context, tracePath),
      event: preparedEvent,
      hooks: workflowTraceSealTestHooks(preparedEvent),
    }).event;
  } catch (error) {
    failTraceIntegrityWrite(error);
  }
}

export function buildGovernedTraceEvent(context, storyId, event) {
  const normalizedStoryId = storyId ? normalizeId(String(storyId)) : null;
  return {
    id: event.id || `TR-${compactTimestamp()}-${crypto.randomBytes(3).toString("hex")}`,
    story_id: normalizedStoryId,
    type: event.type,
    summary: event.summary,
    outcome: event.outcome || null,
    actor: event.actor,
    requested_by: event.requested_by || null,
    authorized_by: event.authorized_by || null,
    request: event.request || null,
    authorization_ref: event.authorization_ref || null,
    action: event.action || event.type,
    evidence: event.evidence || [],
    related: event.related || [],
    ...(event.narrative ? { narrative: event.narrative } : {}),
    ...(event.story_step_ref ? { story_step_ref: event.story_step_ref } : {}),
    git: event.git || buildGitMetadata(context.root),
    run: event.run || buildRunMetadata({}),
    correlation_id: event.correlation_id || CLI_OPERATION_CONTEXT.correlation_id,
    created_at: event.created_at || now(),
  };
}

export function prepareGovernedTraceMutation(context, storyId, event) {
  const normalizedStoryId = storyId ? normalizeId(String(storyId)) : null;
  const traceFile = normalizedStoryId ? `${normalizedStoryId}.jsonl` : "project.jsonl";
  const tracePath = path.join(context.sdlcRoot, "traces", traceFile);
  const preparedEvent = prepareGovernedTraceEvent(
    context,
    buildGovernedTraceEvent(context, normalizedStoryId, event),
  );
  const releaseLegacyTraceLock = acquireFileLock(`${tracePath}.lock`);
  let released = false;
  let committed = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseLegacyTraceLock();
  };
  try {
    assertNoPendingWorkflowTraceTransaction(context, tracePath);
    const integrityOptions = traceIntegrityOptions(context, tracePath);
    recoverTraceIntegrity(integrityOptions);
    withTraceIntegritySnapshot(integrityOptions, ({ integrity }) => {
      if (!integrity.valid) {
        fail(
          `Trace integrity blocked the governed mutation: `
          + `${(integrity.errors || []).map((item) => item.code || item.message || item).join("; ") || "invalid trace state"}.`,
        );
      }
      return true;
    });
  } catch (error) {
    release();
    if (error instanceof UserError || error instanceof MutationGovernanceError) throw error;
    failTraceIntegrityWrite(error);
  }
  return {
    event_id: preparedEvent.id,
    trace_path: tracePath,
    commit() {
      if (committed) {
        fail(`Trace mutation ${preparedEvent.id} has already been committed.`);
      }
      committed = true;
      return sealPreparedTraceEventLocked(context, tracePath, preparedEvent);
    },
    recoverCommitted() {
      try {
        const integrityOptions = traceIntegrityOptions(context, tracePath);
        recoverTraceIntegrity(integrityOptions);
        return withTraceIntegritySnapshot(integrityOptions, ({ integrity, records }) => {
          if (!integrity.valid) return null;
          return records
            .filter((record) => record.valid === true)
            .map((record) => record.event)
            .find((candidate) => candidate?.id === preparedEvent.id)
            || null;
        });
      } catch {
        return null;
      }
    },
    release,
  };
}

export function humanReadableGateBlocker(error, locale = "en") {
  const text = String(error || "");
  const italian = locale === "it";
  const rules = [
    {
      pattern: /lifecycle completion|complete lifecycle|terminal .* delivery/i,
      en: "The final lifecycle is not complete yet: every configured phase and the exact delivery must finish successfully.",
      it: "Il ciclo finale non è ancora completo: tutte le fasi configurate e la consegna esatta devono terminare con successo.",
    },
    {
      pattern: /outside the approved requirement write paths|changed-path scope/i,
      en: "At least one changed file is outside the approved implementation area.",
      it: "Almeno un file modificato si trova fuori dall’area di implementazione approvata.",
    },
    {
      pattern: /output ref .*not (?:linked|satisfied)|has no .*output|missing .*output/i,
      en: "The agreed deliverable or implementation evidence has not been linked to this work item yet.",
      it: "Il risultato concordato o la prova di implementazione non è ancora collegato a questa attività.",
    },
    {
      pattern: /has no contract_id|contract .*missing|contract .*not approved/i,
      en: "This work item does not have a valid approved work brief.",
      it: "Questa attività non ha un incarico di lavoro valido e approvato.",
    },
    {
      pattern: /baseline .*stale|baseline .*missing|source .*stale|source .*missing/i,
      en: "The project context used for this work is missing or no longer current.",
      it: "Il contesto di progetto usato per questa attività manca o non è più aggiornato.",
    },
    {
      pattern: /test trace|test evidence|latest test/i,
      en: "A required passing test result or its evidence is missing.",
      it: "Manca un risultato di test superato richiesto oppure la relativa prova.",
    },
    {
      pattern: /approval|human gate/i,
      en: "A required approval is missing, expired, or no longer matches the exact work.",
      it: "Un’approvazione richiesta manca, è scaduta o non corrisponde più al lavoro esatto.",
    },
  ];
  const matched = rules.find((rule) => rule.pattern.test(text));
  if (matched) return italian ? matched.it : matched.en;
  return italian
    ? "Un record obbligatorio manca, è obsoleto o non è coerente; i dettagli tecnici sono riportati sotto."
    : "A required project record is missing, outdated, or inconsistent; technical details are shown below.";
}

export function inferStoryBlockers(
  context,
  story,
  claim,
  dependencyStatus = null,
  lifecycle = null,
) {
  const blockers = [];
  const effectiveLifecycle = lifecycle
    || effectiveStoryLifecycleProjection(context, story);
  if (effectiveLifecycle.closed) {
    return blockers;
  }
  if (effectiveLifecycle.blocked) {
    blockers.push(effectiveLifecycle.source === "invalid_story_closure"
      ? "invalid or unapproved story closure record"
      : "invalid or unreadable final lifecycle receipt");
  }
  if (story.id && story.__folder_id && story.id !== story.__folder_id) {
    blockers.push(`story id ${story.id} does not match folder ${story.__folder_id}`);
  }
  if (storyAcceptanceCriteria(story).length === 0) {
    blockers.push("missing acceptance criteria");
  }
  if (story.contract_review_required) {
    blockers.push("story acceptance changed and requires a new approved contract");
  } else if (story.contract_id) {
    const contractPath = path.join(context.sdlcRoot, "contracts", `${story.contract_id}.json`);
    if (!fs.existsSync(contractPath)) {
      blockers.push(`missing contract ${story.contract_id}`);
    }
  }
  if (claim && claim.status === "active" && isClaimExpired(context, claim)) {
    blockers.push("active claim is expired");
  }
  blockers.push(...(dependencyStatus || buildDependencyStatus(context, story.id)).blockers);
  return blockers;
}

export function readLocks(context) {
  const locksRoot = path.join(context.sdlcRoot, "locks");
  return safeReadDir(locksRoot)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readProjectJson(context, path.join(locksRoot, name)));
}

export function readActiveLocks(context) {
  return readLocks(context).filter((lock) => lock.status === "active" && !isExpired(lock.expires_at));
}

export function validateLocks(context, report) {
  const activeScopes = new Map();
  for (const lock of readLocks(context)) {
    const label = `lock ${lock.id || "unknown"}`;
    if (!lock.id || !lock.phase || !lock.status) {
      report.errors.push(`${label} is missing id, phase, or status`);
    }
    if (!LOCK_STATUSES.has(String(lock.status || "").toLowerCase())) {
      report.errors.push(`${label} has unknown status '${lock.status}'`);
    }
    if (lock.expires_at && !Number.isFinite(Date.parse(String(lock.expires_at)))) {
      report.errors.push(`${label} has invalid expires_at '${lock.expires_at}'`);
    }
    if (lock.status === "active" && isExpired(lock.expires_at)) {
      const severity = report.strict ? "errors" : "warnings";
      report[severity].push(`${label} expired at ${lock.expires_at}`);
    } else if (lock.status === "active") {
      const scopeKey = `${lock.phase}:${lock.scope || lock.phase}`;
      const existing = activeScopes.get(scopeKey);
      if (existing) {
        const severity = report.strict ? "errors" : "warnings";
        report[severity].push(`${label} conflicts with active ${existing} on ${scopeKey}`);
      } else {
        activeScopes.set(scopeKey, label);
      }
      report.warnings.push(`${label} is active for phase ${lock.phase}`);
    }
    report.checked.push(label);
  }
}

export function resolveStableTemplateDirectory(requestedPath) {
  const resolvedPath = path.resolve(requestedPath);
  try {
    const requestedBefore = fs.lstatSync(resolvedPath, IDENTITY_STAT_OPTIONS);
    if (requestedBefore.isSymbolicLink()) {
      fail(`Template directory itself must not be a symlink: ${resolvedPath}`);
    }
    if (!requestedBefore.isDirectory()) {
      fail(`Template directory must be a readable directory: ${resolvedPath}`);
    }
    const canonicalPath = fs.realpathSync.native(resolvedPath);
    const canonicalEntry = fs.lstatSync(canonicalPath, IDENTITY_STAT_OPTIONS);
    const requestedAfter = fs.lstatSync(resolvedPath, IDENTITY_STAT_OPTIONS);
    if (
      canonicalEntry.isSymbolicLink()
      || !canonicalEntry.isDirectory()
      || !sameStableFileIdentity(requestedBefore, canonicalEntry)
      || !sameStableFileIdentity(requestedBefore, requestedAfter)
    ) {
      fail(`Template directory changed while resolving it: ${resolvedPath}`);
    }
    const identity = captureDirectoryIdentity(canonicalPath);
    if (
      identity.realpath !== canonicalPath
      || !sameStableFileIdentity(requestedBefore, identity)
      || !directoryIdentityMatches(canonicalPath, identity)
    ) {
      fail(`Template directory changed while pinning its identity: ${resolvedPath}`);
    }
    return { path: canonicalPath, identity };
  } catch (error) {
    if (error instanceof UserError) {
      throw error;
    }
    fail(`Unable to resolve template directory ${resolvedPath}: ${error.message}`);
  }
}

export function selectStableTemplateAsset(filePath, options = {}) {
  const parentPath = path.dirname(filePath);
  const parentIdentity = options.parentIdentity ?? captureDirectoryIdentity(parentPath);
  assertDirectoryIdentity(parentPath, parentIdentity);
  let selected;
  try {
    selected = fs.lstatSync(filePath, IDENTITY_STAT_OPTIONS);
  } catch (error) {
    if (options.allowMissing && error?.code === "ENOENT") {
      assertDirectoryIdentity(parentPath, parentIdentity);
      return null;
    }
    throw error;
  }
  if (selected.isSymbolicLink() || !selected.isFile()) {
    fail(options.invalidMessage || `Template asset must be a readable regular file: ${filePath}`);
  }
  assertDirectoryIdentity(parentPath, parentIdentity);
  const selectedAgain = fs.lstatSync(filePath, IDENTITY_STAT_OPTIONS);
  if (!sameStableFileSnapshot(selected, selectedAgain)) {
    fail(`Template asset changed while selecting it: ${filePath}`);
  }
  return {
    filePath,
    parentIdentity,
    selectedStat: selected,
  };
}

export function readStableTemplateAsset(selection) {
  return readFileFromStableParent(selection.filePath, selection.parentIdentity, {
    maxBytes: MAX_TEMPLATE_ASSET_BYTES,
    tooLargeMessage: `Template asset exceeds ${MAX_TEMPLATE_ASSET_BYTES} bytes: ${selection.filePath}`,
    expectedStat: selection.selectedStat,
    identityMismatchMessage: `Template asset changed after selection: ${selection.filePath}`,
  });
}

export function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`Unable to read JSON file ${filePath}: ${error.message}`);
  }
}

export function readProjectJson(context, filePath) {
  try {
    return JSON.parse(readProjectText(context, filePath));
  } catch (error) {
    if (error instanceof UserError) {
      throw error;
    }
    fail(`Unable to read JSON file ${displayProjectFilePath(context, filePath)}: ${error.message}`);
  }
}

/**
 * Present a file inside the project as a portable project-relative path, so
 * errors and suggested commands do not disclose the local directory layout.
 */
export function displayProjectFilePath(context, filePath) {
  if (!context?.root) return String(filePath);
  const absolute = path.resolve(String(context.root), String(filePath));
  const relative = path.relative(path.resolve(String(context.root)), absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return String(filePath);
  return relative.split(path.sep).join("/");
}

export function readProjectJsonBounded(context, filePath, maxBytes) {
  try {
    resolveProjectFilePath(context, filePath, { mustExist: true, fileOnly: true });
    assertNoSymlinkPathSegments(filePath, context.root);
    const parentIdentity = captureDirectoryIdentity(path.dirname(filePath));
    const realRoot = fs.realpathSync.native(context.root);
    if (!isInsidePath(realRoot, parentIdentity.realpath)) {
      fail(`Project file parent resolves outside the target project root: ${filePath}`);
    }
    return JSON.parse(readFileFromStableParent(filePath, parentIdentity, {
      maxBytes,
      tooLargeMessage: "Project privacy configuration exceeds its safe read limit.",
    }));
  } catch (error) {
    if (error instanceof UserError) throw error;
    fail(`Unable to read bounded JSON project file: ${error.message}`);
  }
}

export function readProjectText(context, filePath) {
  resolveProjectFilePath(context, filePath, { mustExist: true, fileOnly: true });
  assertNoSymlinkPathSegments(filePath, context.root);
  const parentIdentity = captureDirectoryIdentity(path.dirname(filePath));
  const realRoot = fs.realpathSync.native(context.root);
  if (!isInsidePath(realRoot, parentIdentity.realpath)) {
    fail(`Project file parent resolves outside the target project root: ${filePath}`);
  }
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | NO_FOLLOW_FLAG);
    verifyOpenFileMatchesPath(descriptor, filePath, parentIdentity);
    return fs.readFileSync(descriptor, "utf8");
  } catch (error) {
    if (error instanceof UserError) {
      throw error;
    }
    fail(`Unable to read project file ${filePath}: ${error.message}`);
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

export function writeJsonFile(filePath, value, options = {}) {
  writeTextFile(filePath, `${JSON.stringify(value, null, 2)}\n`, options);
}

export function removePathGoverned(filePath, options = {}) {
  const operation = options.recursive ? "directory.remove" : "file.remove";
  return withGovernedMutation({ operation, path: filePath }, () => {
    assertMutationExecutionAuthorized({ operation, path: filePath });
    fs.rmSync(filePath, options);
    return true;
  });
}

export function removeEmptyDirectoryGoverned(directoryPath) {
  return withGovernedMutation({ operation: "directory.remove", path: directoryPath }, () => {
    assertMutationExecutionAuthorized({ operation: "directory.remove", path: directoryPath });
    fs.rmdirSync(directoryPath);
    return true;
  });
}

export function renamePathGoverned(sourcePath, targetPath) {
  return withGovernedMutation({ operation: "path.rename.source", path: sourcePath }, () =>
    withGovernedMutation({ operation: "path.rename.target", path: targetPath }, () => {
      assertMutationExecutionAuthorized({ operation: "path.rename.source", path: sourcePath });
      assertMutationExecutionAuthorized({ operation: "path.rename.target", path: targetPath });
      fs.renameSync(sourcePath, targetPath);
      return true;
    }));
}

export function writeTextFile(filePath, content, options = {}) {
  if (options.preauthorizedMutation) {
    assertMutationExecutionAuthorized({ operation: "file.write", path: filePath });
    return writeTextFileAuthorized(filePath, content, options);
  }
  return withGovernedMutation({ operation: "file.write", path: filePath }, () =>
    writeTextFileAuthorized(filePath, content, options));
}

/**
 * Error text for a refused overwrite. The path is shown relative to the
 * enclosing project so home-directory paths do not leak into CLI errors, and
 * --force is suggested only by writers whose command honours it.
 */
function existingFileMessage(filePath, options = {}) {
  let displayPath = path.basename(filePath);
  for (let directory = path.dirname(filePath); ; directory = path.dirname(directory)) {
    if (path.basename(directory) !== SDLC_DIR && fs.existsSync(path.join(directory, SDLC_DIR))) {
      displayPath = path.relative(directory, filePath).split(path.sep).join("/");
      break;
    }
    if (path.dirname(directory) === directory) break;
  }
  const remedy = options.forceOption ? "Use --force to overwrite it." : "Use a new immutable record id.";
  return `File already exists: ${displayPath}. ${remedy}`;
}

export function writeTextFileAuthorized(filePath, content, options = {}) {
  assertMutationExecutionAuthorized({ operation: "file.write", path: filePath });
  assertNoSymlinkPathSegments(filePath);
  const parentPath = path.dirname(filePath);
  ensureDir(parentPath, { preauthorizedMutation: options.preauthorizedMutation });
  const parentIdentity = captureDirectoryIdentity(parentPath);
  if (fs.existsSync(filePath) && !options.force) {
    if (fs.lstatSync(filePath).isSymbolicLink()) {
      fail(`Refusing to write through symlink: ${filePath}`);
    }
    const existing = readFileFromStableParent(filePath, parentIdentity, {
      ...(options.maxExistingBytes === undefined
        ? {}
        : {
            maxBytes: options.maxExistingBytes,
            tooLargeMessage: `Existing immutable file exceeds its expected size: ${filePath}`,
          }),
    });
    if (existing === content) {
      if (options.durable) syncWorkflowFile(filePath);
      return false;
    }
    fail(existingFileMessage(filePath, options));
  }
  if (options.atomicCreate || !options.force) {
    // A new record becomes visible only once it is complete: the content is
    // written and flushed to a temporary file that is then hard-linked into
    // place. A crash mid-write leaves at most a stray temporary file, never an
    // empty or truncated record that would block every later gate check.
    const tempPath = path.join(
      parentPath,
      `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`,
    );
    let tempIdentity = null;
    try {
      tempIdentity = writeFileToStableParent(tempPath, content, parentIdentity, {
        ...options,
        durable: true,
        governanceTargetPath: filePath,
      });
      assertDirectoryIdentity(parentPath, parentIdentity);
      assertOwnedWriterTemporary(tempPath, tempIdentity);
      try {
        assertMutationExecutionAuthorized({ operation: "file.write", path: filePath });
        assertOwnedWriterTemporary(tempPath, tempIdentity);
        fs.linkSync(tempPath, filePath);
      } catch (error) {
        if (error?.code === "EEXIST") {
          fail(existingFileMessage(filePath, options));
        }
        throw error;
      }
      if (options.durable) syncWorkflowDirectory(parentPath);
    } finally {
      if (directoryIdentityMatches(parentPath, parentIdentity)) {
        removeOwnedWriterTemporary(
          tempPath,
          tempIdentity,
          { operation: "file.write", path: filePath },
        );
      }
    }
    return true;
  }
  if (options.force) {
    const tempPath = options.preparedTempPath ?? path.join(
      parentPath,
      `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`,
    );
    if (options.preparedTempPath && path.dirname(path.resolve(tempPath)) !== path.resolve(parentPath)) {
      fail(`Prepared identity migration temp path must stay beside its target: ${filePath}`);
    }
    const executePhysical = (request, callback) => {
      if (options.preauthorizedMutation) {
        assertMutationExecutionAuthorized(request);
        return callback();
      }
      return withGovernedMutation(request, () => {
        assertMutationExecutionAuthorized(request);
        return callback();
      });
    };
    let tempIdentity = null;
    try {
      if (options.preparedTempPath) {
        tempIdentity = executePhysical({ operation: "file.write", path: tempPath }, () =>
          writeFileToStableParent(tempPath, content, parentIdentity, {
            governanceTargetPath: tempPath,
          }));
      } else {
        tempIdentity = writeFileToStableParent(tempPath, content, parentIdentity, {
          governanceTargetPath: filePath,
        });
      }
      assertDirectoryIdentity(parentPath, parentIdentity);
      assertOwnedWriterTemporary(tempPath, tempIdentity);
      if (options.preparedTempPath) {
        executePhysical({ operation: "path.rename.source", path: tempPath }, () =>
          executePhysical({ operation: "path.rename.target", path: filePath }, () => {
            assertOwnedWriterTemporary(tempPath, tempIdentity);
            return fs.renameSync(tempPath, filePath);
          }));
      } else {
        assertMutationExecutionAuthorized({ operation: "file.write", path: filePath });
        assertOwnedWriterTemporary(tempPath, tempIdentity);
        fs.renameSync(tempPath, filePath);
      }
    } finally {
      if (directoryIdentityMatches(parentPath, parentIdentity)) {
        if (options.preparedTempPath) {
          if (writerTemporaryMatches(tempPath, tempIdentity)) {
            executePhysical({ operation: "file.remove", path: tempPath }, () =>
              fs.rmSync(tempPath));
          }
        } else {
          removeOwnedWriterTemporary(
            tempPath,
            tempIdentity,
            { operation: "file.write", path: filePath },
          );
        }
      }
    }
    return true;
  }
  return true;
}

export function readFileFromStableParent(filePath, parentIdentity, options = {}) {
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | NO_FOLLOW_FLAG);
    const before = verifyOpenFileMatchesPath(descriptor, filePath, parentIdentity);
    if (
      options.expectedStat
      && !sameStableFileSnapshot(options.expectedStat, fs.fstatSync(descriptor, IDENTITY_STAT_OPTIONS))
    ) {
      fail(options.identityMismatchMessage || `File changed after selection: ${filePath}`);
    }
    if (options.maxBytes === undefined) return fs.readFileSync(descriptor, "utf8");
    const maxBytes = options.maxBytes;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) fail("Stable read maxBytes must be a positive safe integer.");
    if (before.size > maxBytes) fail(options.tooLargeMessage || "Project file exceeds its safe read limit.");
    const chunks = [];
    let total = 0;
    let position = 0;
    while (total <= maxBytes) {
      const remaining = maxBytes + 1 - total;
      if (remaining <= 0) break;
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const bytesRead = fs.readSync(descriptor, chunk, 0, chunk.byteLength, position);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
      position += bytesRead;
    }
    if (total > maxBytes) fail(options.tooLargeMessage || "Project file exceeds its safe read limit.");
    const after = fs.fstatSync(descriptor);
    verifyOpenFileMatchesPath(descriptor, filePath, parentIdentity);
    if (
      !sameStableFileIdentity(before, after)
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
      || total !== after.size
    ) {
      fail(`File changed while reading it: ${filePath}`);
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

export function writeFileToStableParent(filePath, content, parentIdentity, options = {}) {
  assertMutationExecutionAuthorized({
    operation: "file.write",
    path: options.governanceTargetPath ?? filePath,
  });
  assertDirectoryIdentity(path.dirname(filePath), parentIdentity);
  let descriptor;
  let created = false;
  let complete = false;
  let createdIdentity = null;
  try {
    assertMutationExecutionAuthorized({
      operation: "file.write",
      path: options.governanceTargetPath ?? filePath,
    });
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW_FLAG,
      0o666,
    );
    created = true;
    verifyOpenFileMatchesPath(descriptor, filePath, parentIdentity);
    createdIdentity = fileIdentity(fs.fstatSync(descriptor, IDENTITY_STAT_OPTIONS));
    assertMutationExecutionAuthorized({
      operation: "file.write",
      path: options.governanceTargetPath ?? filePath,
    });
    fs.writeFileSync(descriptor, content);
    if (options.durable) fs.fsyncSync(descriptor);
    complete = true;
    return createdIdentity;
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    if (created && !complete && directoryIdentityMatches(path.dirname(filePath), parentIdentity)) {
      removeOwnedWriterTemporary(filePath, createdIdentity, {
        operation: "file.write",
        path: options.governanceTargetPath ?? filePath,
      });
    }
  }
}

export function acquireFileLock(lockPath) {
  return withGovernedMutation({ operation: "lock.acquire", path: lockPath }, () =>
    acquireFileLockAuthorized(lockPath));
}

export function acquireFileLockAuthorized(lockPath) {
  assertMutationExecutionAuthorized({ operation: "lock.acquire", path: lockPath });
  assertNoSymlinkPathSegments(lockPath);
  ensureDir(path.dirname(lockPath));
  const nonce = crypto.randomBytes(12).toString("hex");
  const metadata = {
    pid: process.pid,
    host: os.hostname(),
    nonce,
    created_at: now(),
  };
  const deadline = Date.now() + INTERNAL_LOCK_WAIT_MS;
  let descriptor;
  while (true) {
    try {
      assertMutationExecutionAuthorized({ operation: "lock.acquire", path: lockPath });
      descriptor = fs.openSync(lockPath, "wx");
      break;
    } catch (error) {
      const existingLock = error?.code === "EEXIST";
      const transientWindowsContention = process.platform === "win32"
        && ["EPERM", "EACCES", "EBUSY"].includes(error?.code);
      if (!existingLock && !transientWindowsContention) {
        throw error;
      }
      if (existingLock && reclaimStaleInternalLock(lockPath)) {
        continue;
      }
      if (Date.now() >= deadline) {
        if (transientWindowsContention) {
          fail(`Cannot acquire internal lock after transient Windows file-system contention: ${lockPath}`);
        }
        fail(`Resource is locked by another SDLC operation: ${lockPath}`);
      }
      sleepSync(25);
    }
  }
  // On failure the lock is removed only while the path still holds the file
  // created above; a concurrent stale-lock reclaim may have replaced it.
  initializeCreatedLock({
    lockPath,
    descriptor,
    content: JSON.stringify(metadata),
    authorize: () => assertMutationExecutionAuthorized({ operation: "lock.acquire", path: lockPath }),
  });
  return () => {
    withGovernedMutation({ operation: "lock.release", path: lockPath }, () => {
      try {
        const current = fs.existsSync(lockPath) ? JSON.parse(fs.readFileSync(lockPath, "utf8")) : null;
        if (current?.nonce === nonce) {
          assertMutationExecutionAuthorized({ operation: "lock.release", path: lockPath });
          fs.rmSync(lockPath, { force: true });
        }
      } catch {
        // Best effort cleanup; a remaining lock is safer than silent concurrent writes.
      }
    });
  };
}

/**
 * Judges the lock file at `lockPath`. Returns `{ missing: true }` when it is
 * gone, `{ stale: false }` while its owner may still hold it, and
 * `{ stale: true, identity }` when it may be reclaimed. The identity comes from
 * the descriptor the metadata was read through, so the verdict applies only to
 * that exact file.
 */
function inspectInternalLock(lockPath) {
  let metadata = null;
  let ageMs = 0;
  let identity;
  let descriptor;
  try {
    descriptor = fs.openSync(lockPath, fs.constants.O_RDONLY | NO_FOLLOW_FLAG);
    identity = fs.fstatSync(descriptor, IDENTITY_STAT_OPTIONS);
    // Without a stable identity the reclaim cannot prove it removes the file it
    // judged, and every later check would report progress without any.
    if (!identity.isFile() || !hasStableFileIdentity(identity)) return { stale: false };
    ageMs = Date.now() - Number(identity.mtimeMs);
    try {
      metadata = JSON.parse(fs.readFileSync(descriptor, "utf8"));
      const createdAt = Date.parse(String(metadata.created_at || ""));
      if (Number.isFinite(createdAt)) ageMs = Date.now() - createdAt;
    } catch {
      metadata = null;
    }
  } catch (error) {
    return error?.code === "ENOENT" ? { missing: true } : { stale: false };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  const localOwner = !metadata?.host || metadata.host === os.hostname();
  if (localOwner && Number.isInteger(metadata?.pid)) {
    // A dead local process cannot still own the lock. Reclaim immediately so
    // durable journals can recover from SIGKILL or power-loss equivalents
    // without an artificial thirty-second outage. A recycled live PID stays
    // conservative and keeps the lock.
    if (processIsAlive(metadata.pid)) return { stale: false };
  } else {
    if (ageMs < INTERNAL_LOCK_STALE_MS) return { stale: false };
    if (metadata?.host && metadata.host !== os.hostname() && ageMs < INTERNAL_LOCK_REMOTE_STALE_MS) {
      return { stale: false };
    }
  }
  return { stale: true, identity };
}

/**
 * Deletes `filePath` only if it is still the file judged stale. The file is
 * moved aside first and its identity checked there; a different file moved by
 * a lost race is linked back unless another file already took its place.
 * Returns false only when the judged file is still in place, so callers wait
 * instead of retrying at once.
 */
function removeJudgedLockFile(filePath, judged, lockPath) {
  const stalePath = `${filePath}.stale-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    if (!sameStableFileIdentity(judged, fs.lstatSync(filePath, IDENTITY_STAT_OPTIONS))) return true;
    assertMutationExecutionAuthorized({ operation: "lock.reclaim", path: lockPath });
    fs.renameSync(filePath, stalePath);
  } catch (error) {
    return error?.code === "ENOENT";
  }
  try {
    if (!sameStableFileIdentity(judged, fs.lstatSync(stalePath, IDENTITY_STAT_OPTIONS))) {
      assertMutationExecutionAuthorized({ operation: "lock.reclaim", path: lockPath });
      fs.linkSync(stalePath, filePath);
    }
  } catch {
    // The moved file cannot be put back; a newer file already holds the path.
  } finally {
    assertMutationExecutionAuthorized({ operation: "lock.reclaim", path: lockPath });
    fs.rmSync(stalePath, { force: true });
  }
  return true;
}

export function reclaimStaleInternalLock(lockPath) {
  const verdict = inspectInternalLock(lockPath);
  if (verdict.missing) return true;
  if (!verdict.stale) return false;
  // Several waiters can judge the same dead lock at once. Reclaiming is
  // serialized through an exclusive claim file: without it, a waiter acting on
  // an old verdict could remove the lock another waiter has just installed,
  // and both would then believe they hold it. The claim name ends in ".lock"
  // so record scans skip it like any other lock.
  const claimPath = `${lockPath}.reclaim.lock`;
  return withGovernedMutation({ operation: "lock.reclaim", path: lockPath }, () => {
    let descriptor;
    try {
      assertMutationExecutionAuthorized({ operation: "lock.reclaim", path: lockPath });
      descriptor = fs.openSync(claimPath, "wx");
    } catch (error) {
      if (error?.code !== "EEXIST") return false;
      // A waiter that died while holding the claim would block this lock
      // forever, so a dead claim is reclaimed the same way as a dead lock.
      const claim = inspectInternalLock(claimPath);
      if (claim.missing) return true;
      return claim.stale ? removeJudgedLockFile(claimPath, claim.identity, lockPath) : false;
    }
    const claimIdentity = fileIdentity(fs.fstatSync(descriptor, IDENTITY_STAT_OPTIONS));
    initializeCreatedLock({
      lockPath: claimPath,
      descriptor,
      content: JSON.stringify({ pid: process.pid, host: os.hostname(), created_at: now() }),
      authorize: () => assertMutationExecutionAuthorized({ operation: "lock.reclaim", path: lockPath }),
    });
    try {
      // Judge the lock again now that only this waiter may reclaim it. The
      // earlier verdict may describe a file that is already gone, and file
      // systems that reuse inode numbers at once (Linux) would let its
      // identity match the live lock that replaced it.
      const current = inspectInternalLock(lockPath);
      if (current.missing) return true;
      if (!current.stale) return false;
      return removeJudgedLockFile(lockPath, current.identity, lockPath);
    } finally {
      assertMutationExecutionAuthorized({ operation: "lock.reclaim", path: lockPath });
      removeCreatedLockIfOwned(claimPath, claimIdentity);
    }
  });
}

/**
 * Refuse a path that exists but is not a real directory. A symlink here would
 * redirect every later write out of the project, so this check runs on every
 * path segment and again whenever a directory turns out to already exist.
 */
export function assertStableDirectory(dirPath) {
  const entry = fs.lstatSync(dirPath);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    fail(`Refusing unstable directory path: ${dirPath}`);
  }
}

export function ensureDir(dirPath, options = {}) {
  if (fs.existsSync(dirPath)) {
    assertStableDirectory(dirPath);
    return false;
  }
  const parentPath = path.dirname(dirPath);
  ensureDir(parentPath, options);
  if (options.preauthorizedMutation) {
    assertMutationExecutionAuthorized({ operation: "directory.create", path: dirPath });
    return createDirectoryAllowingConcurrentCreation(dirPath);
  }
  return withGovernedMutation({ operation: "directory.create", path: dirPath }, () => {
    assertMutationExecutionAuthorized({ operation: "directory.create", path: dirPath });
    return createDirectoryAllowingConcurrentCreation(dirPath);
  });
}

export function safeReadDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return [];
  }
  if (fs.lstatSync(dirPath).isSymbolicLink()) {
    fail(`Refusing to read through symlinked directory: ${dirPath}`);
  }
  if (!fs.statSync(dirPath).isDirectory()) {
    fail(`Expected directory but found another file type: ${dirPath}`);
  }
  const entries = fs.readdirSync(dirPath);
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry);
    if (fs.lstatSync(entryPath).isSymbolicLink()) {
      fail(`Refusing symlinked canonical entry: ${entryPath}`);
    }
  }
  return entries;
}

export function walkFiles(startDir) {
  const results = [];
  for (const entry of safeReadDir(startDir)) {
    const fullPath = path.join(startDir, entry);
    const stat = fs.lstatSync(fullPath);
    if (stat.isSymbolicLink()) {
      continue;
    }
    if (stat.isDirectory()) {
      results.push(...walkFiles(fullPath));
    } else if (stat.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}
