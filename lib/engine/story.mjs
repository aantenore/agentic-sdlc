import path from "node:path";
import {
  AUTONOMY_LEVEL_RANK,
  buildRequirementExecutionProfile,
  mostRestrictiveAutonomyLevel,
  normalizeAutonomyLevel,
  validateRequirementExecutionProfileIntegrity,
} from "../autonomy-policy.mjs";
import {
  discoverBaselineSourcePaths,
} from "../baseline-source-discovery.mjs";
import {
  fail,
  failUsage,
} from "../cli/user-error.mjs";
import {
  workspaceChangeMatchesPreflight,
} from "../execution-context-preflight.mjs";
import {
  MutationGovernanceError,
  assertMutationExecutionAuthorized,
  withGovernedMutation,
} from "../governance/mutation-guard.mjs";
import {
  gateGuidance,
  requirementAutonomyCeilingGuidance,
} from "../human-guidance.mjs";
import {
  authorizationAllowsAction,
  authorizationAllowsArtifactType,
  authorizationAllowsSubject,
  authorizationArtifactTypes,
  authorizationProposalBindingError,
  authorizationRecordHash,
  canRecoverConsumedLegacyAuthorizationUse,
  contractDirectApprovalRequirements,
  dependencyProposalPath,
  formalApprovalActorDescription,
  hasApprovedContractApproval,
  hasFormalApprovalAttribution,
  hasFreshApprovedContractApproval,
  hashApprovalSubject,
  humanApprovalFields,
  latestApprovedRecordApproval,
  normalizeApprovalSource,
  normalizeApprovalStatus,
  requireFormalApprovalActor,
  storyActionAuthorizationSettings,
  validateAuthorizationUseReceipt,
} from "../lifecycle/authorization.mjs";
import {
  buildCapabilityPolicy,
  collectCapabilityPolicyReadinessGaps,
  collectMissingRequiredCapabilityBindings,
  normalizeCapabilityBindings,
  normalizeCapabilityRecommendationRefs,
} from "../lifecycle/capability.mjs";
import {
  assertNotDerivedArtifact,
  buildDomainRecord,
  buildExecutionPolicy,
  buildQuestionRecords,
  canonicalAbsoluteUrl,
  getOptionString,
  hasActorAttribution,
  isApprovedRecordFresh,
  mergeList,
  normalizeArtifactType,
  normalizeId,
  normalizeListOption,
  normalizeListValue,
  normalizeOptionalDateTime,
  normalizeRawListOption,
  normalizeWorkItemType,
  requireCoordinationOverrideActor,
  requireOption,
  shortHash,
  shouldIndexFile,
  stableJson,
  summarizeActivityEvents,
  validateExecutionPolicy,
} from "../lifecycle/common.mjs";
import {
  CLAIM_STATUSES,
  HANDOFF_STATUSES,
  LEGACY_STORY_STEP_PHASE_ALIASES,
  SDLC_DIR,
  STORY_STATUSES,
  TERMINAL_STORY_STATUSES,
  TRACE_TYPES,
} from "../lifecycle/constants.mjs";
import {
  compareDeliveryAuthorizationOrder,
  deliveryAutonomyPath,
  deliveryStartReceiptPath,
} from "../lifecycle/delivery.mjs";
import {
  assistantMessagePresentationFields,
  attachAssistantMessagePresentation,
  executionContextRecoveryMessage,
  humanGuidanceLines,
  humanGuidanceLocale,
  normalizeHandoffCloseStatus,
  normalizeHandoffStatus,
  normalizeStoryStatus,
  storyCreationGuidance,
  terminalStoryStatuses,
} from "../lifecycle/guidance.mjs";
import {
  collectStoryOutputLinksForStep,
  createOutputRegistryQueryIndex,
  evidenceRepresentationMatchesRef,
  formatExplainedOpenQuestion,
  formatLimitedList,
  renderBaselineReport,
  renderGateReportMarkdown,
  renderTemplate,
} from "../lifecycle/output.mjs";
import {
  assertNoSymlinkPathSegments,
  autonomyActionsRoot,
  dependenciesRoot,
  isDerivedArtifactPath,
  normalizeProjectPathInput,
  pathMatchesApprovedWriteScope,
  toProjectPath,
} from "../lifecycle/project.mjs";
import {
  assertStoryCommandOptions,
  baselinePathById,
  baselineRoot,
  breakdownPathById,
  configuredPhaseOrder,
  configuredStorySteps,
  contractArtifactTypes,
  contractExecutionContext,
  defaultClaimExpiration,
  defaultNextStoryStep,
  defaultStoryBranch,
  dependencyGraphPath,
  effectiveClaimExpiration,
  findBlockingDependencyCycles,
  hasTraceActor,
  inferStoryArtifactType,
  inferStoryIdFromTraceFile,
  isHardDependencyEdge,
  latestTraceEvent,
  normalizeStoryRecord,
  normalizeStoryStep,
  parseBreakdownItemRef,
  parseDependencyEdge,
  phaseRank,
  rejectLegacyRequirementWriteScope,
  requirementAutonomyPath,
  requirementLifecycleRoot,
  requirementMaterialScope,
  requirementPath,
  requirementsRoot,
  storyAcceptanceCriteria,
  storyActionCheckpointSubjectId,
  storyBranchPatterns,
  storyClosurePath,
  storyLifecycleCertificationLockPath,
  storyMutationLockPath,
  storyRecordLifecycleProjection,
  storyStepPhase,
  traceIntegrityCheckpointPath,
  upsertDependencyEdge,
  validateWorkBreakdownPolicy,
  workBreakdownRoot,
} from "../lifecycle/story.mjs";
import {
  blockedWorkflowLifecycleProjection,
  workflowCurrentPhaseEntryAt,
  workflowFinalGateReceiptPath,
  workflowScopeFromRuntime,
  workflowStrictGateReceiptPath,
} from "../lifecycle/workflow.mjs";
import {
  redactValueWithMetadata,
} from "../observability/redaction.mjs";
import {
  buildStoryClosure,
  buildStoryClosureSubject,
} from "../story-closure.mjs";
import {
  buildRequirementProposal,
  buildRequirementRef,
  requirementContentHash,
  validateRequirementIntegrity,
} from "../requirement-lifecycle.mjs";
import {
  Date,
  fs,
  process,
} from "../runtime/host.mjs";
import {
  withTraceIntegritySnapshot,
} from "../trace-integrity.mjs";
import {
  WORKFLOW_CANONICAL_EVIDENCE_SCHEMA,
  WORKFLOW_FINAL_GATE_RECEIPT_SCHEMA,
  WORKFLOW_LEGACY_CANONICAL_EVIDENCE_SCHEMA,
  WORKFLOW_LEGACY_FINAL_GATE_RECEIPT_SCHEMA,
} from "../workflow-canonical-evidence.mjs";
import {
  workflowCanonicalEvidenceSchema,
} from "../workflow-engine.mjs";
import {
  authorizationUseErrors,
  buildApprovalRecord,
  buildBaselineApprovalRequest,
  collectApprovalRequests,
  contractMatchesStoryApprovalScope,
  createBaselineProposal,
  outputTemplateNeedsApproval,
  plainApprovalRequestCopy,
  readAuthorization,
  readAuthorizationUseReceipt,
  recordOrReuseAuthorizationUse,
  renderApprovalRequestsAssistantMessage,
  validateAuthorizations,
  validateAutonomyApprovalRef,
  validateContractApprovals,
  validateDependencyProposals,
  validateFormalApprovalRecord,
  validateTaskStartReceipt,
  validatedExistingAuthorizationUse,
} from "./authorization.mjs";
import {
  collectCapabilityBindingReadinessGaps,
  validateCapabilityBindings,
  validateCapabilityDiscovery,
  validateContractCapabilityRecommendations,
} from "./capability.mjs";
import {
  appendJsonLine,
  appendRecordSchemaIssues,
  assertRecordSchema,
  buildAttribution,
  buildContextSources,
  buildRunMetadata,
  buildSourceHashMap,
  collectJsonFiles,
  currentWorkspaceChanges,
  ensurePlanningDirectories,
  executionContextSourceEvolution,
  explainOpenQuestion,
  isExpired,
  now,
  parseDateBoundary,
  readAllStories,
  readFeedbackRecords,
  readIncidentRecords,
  readStartedExecutionContextPreflight,
  shortDate,
  uniqueRecordSuffix,
} from "./common.mjs";
import {
  VERSION,
} from "./definitions.mjs";
import {
  assertReleaseClaimPrecondition,
  currentDeliveryExecutionState,
  deliveryActionReceipts,
  effectiveDeliveryProfileStatus,
  evaluateDeliveryAutonomy,
  readDeliveryAutonomyProfile,
  readDeliveryLifecycleReceipt,
  readReleaseManifest,
  releaseStoryClaimRecord,
  reversibleDataReleaseSequence,
  rollbackVerificationReceiptErrors,
  storyBoundDeliveryProfiles,
  storyDeliveryProfileReviewIds,
  validateDeliveryExecutionReceipts,
  validateReleaseManifestIntegrity,
} from "./delivery.mjs";
import {
  buildGitMetadata,
  execGit,
  gitCommandSucceeds,
} from "./git.mjs";
import {
  buildDependencyStatus,
  describeContractForHuman,
  effectiveRequirementStatus,
  showDependencyStatus,
  statusCliCommand,
  storyAcceptanceRecoveryGuidance,
} from "./guidance.mjs";
import {
  ensureInitialized,
} from "./migration.mjs";
import {
  buildCanonicalEvidence,
  buildOutputContractRefs,
  collectOutputContractRefReadinessGaps,
  collectTraceEvidencePolicyBindings,
  loadTraceEvidencePolicySource,
  output,
  outputRegistryPath,
  readOutputRegistry,
  readTemplateFile,
  storyHasOutputLink,
  storyOutputResolveHint,
  strictGateOutputRepair,
  validateApprovedStoryContractForPhaseOutput,
  validateContractOutputRefs,
  validateOutputContracts,
  validateStorySecretScanEvidence,
  validateStoryTestEvidence,
  validateTraceEvidence,
  validateTraceEvidenceRefs,
} from "./output.mjs";
import {
  assertContextSourcePathSafe,
  listProjectFilesUnder,
  pathEntryExistsNoFollow,
  resolveProjectFilePath,
  validateAutonomyRecords,
  validateProject,
} from "./project.mjs";
import {
  inspectTaskStartReplacementBoundary,
  isTaskContractApproved,
} from "./route.mjs";
import {
  acquireFileLock,
  appendTraceLocked,
  approveRequirementLocked,
  buildGovernedTraceEvent,
  createContractLocked,
  ensureDir,
  hashFile,
  humanReadableGateBlocker,
  inferStoryBlockers,
  prepareGovernedTraceMutation,
  readProjectJson,
  readProjectSafe,
  readProjectText,
  readStableRegularFileBuffer,
  removeEmptyDirectoryGoverned,
  removePathGoverned,
  reviseRequirementLocked,
  safeReadDir,
  sealGovernedTraceEvent,
  shouldDependencyBlockStory,
  stableContextSourceSnapshot,
  storyDirectoryExistsBeforeLock,
  supersedeRequirementLocked,
  validateLocks,
  walkFiles,
  withOutputRegistryLock,
  writeJsonFile,
  writeTextFile,
} from "./storage.mjs";
import {
  buildCanonicalEvidenceForWorkflowInstance,
  currentStoryBoundWorkflowInstance,
  deriveCurrentStoryWorkflowScope,
  inspectModernWorkflowTaskStartBinding,
  inspectStoryWorkflowLifecycleRuntime,
  persistWorkflowFinalGateReceipt,
  readWorkflowEvents,
  sealWorkflowStrictGateReceipt,
  validCurrentWorkflowFinalReceipt,
  validLegacyWorkflowFinalReceipt,
  validateCurrentStoryWorkflowCompletion,
  writeWorkflowJsonDurably,
} from "./workflow.mjs";

export function storyPhaseCompletionTraceAttestation(
  context,
  storyId,
  currentState,
  stepName,
  stepRef,
  record,
  stepSnapshot,
) {
  const tracePath = path.join(context.sdlcRoot, "traces", `${storyId}.jsonl`);
  if (!fs.existsSync(tracePath)) {
    return {
      valid: false,
      mode: null,
      event_id: null,
      event_hash: null,
      issues: [`story step '${currentState}' has no sealed story trace`],
    };
  }

  let snapshot;
  try {
    snapshot = withTraceIntegritySnapshot(
      traceIntegrityOptions(context, tracePath),
      ({ integrity, records }) => ({ integrity, records }),
    );
  } catch (error) {
    return {
      valid: false,
      mode: null,
      event_id: null,
      event_hash: null,
      issues: [
        `story step '${currentState}' trace integrity cannot be verified: ${error.message}`,
      ],
    };
  }
  if (!snapshot.integrity.valid) {
    return {
      valid: false,
      mode: null,
      event_id: null,
      event_hash: null,
      issues: [
        `story step '${currentState}' trace integrity is invalid: ${
          (snapshot.integrity.errors || [])
            .map((entry) => entry.code || "invalid")
            .join(", ") || "invalid"
        }`,
      ],
    };
  }
  if (snapshot.records.some((entry) => entry.valid !== true)) {
    return {
      valid: false,
      mode: null,
      event_id: null,
      event_hash: null,
      issues: [`story step '${currentState}' trace contains an invalid record`],
    };
  }

  const candidates = snapshot.records
    .map((entry) => entry.event)
    .filter((event) =>
      event?.action === "story.complete-step"
      && event.story_id === storyId
      && Array.isArray(event.related)
      && event.related.includes(stepName)
      && Array.isArray(event.evidence)
      && event.evidence.includes(stepRef));
  const event = candidates.at(-1) || null;
  if (!event || event?._trace_integrity?.schema_version !== "trace-integrity-event:v1") {
    return {
      valid: false,
      mode: null,
      event_id: event?.id || null,
      event_hash: event?._trace_integrity?.event_hash || null,
      issues: [
        `story step '${currentState}' has no matching sealed story.complete-step event`,
      ],
    };
  }

  const attestation = event.story_step_ref;
  if (attestation !== undefined) {
    const expectedKeys = [
      "completed_at",
      "hash_algorithm",
      "path",
      "phase",
      "record_id",
      "schema_version",
      "sha256",
      "step",
      "story_id",
    ].sort().join("\u0000");
    const actualKeys = attestation
      && typeof attestation === "object"
      && !Array.isArray(attestation)
      ? Object.keys(attestation).sort().join("\u0000")
      : "";
    const valid = actualKeys === expectedKeys
      && attestation.schema_version === "story-step-completion-ref:v1"
      && attestation.hash_algorithm === "sha256:file:v1"
      && attestation.story_id === storyId
      && attestation.step === stepName
      && attestation.phase === currentState
      && attestation.path === stepRef
      && attestation.record_id === record.id
      && attestation.completed_at === record.completed_at
      && /^[a-f0-9]{64}$/u.test(String(attestation.sha256 || ""))
      && attestation.sha256 === stepSnapshot.sha256;
    return {
      valid,
      mode: "exact_file_hash",
      event_id: event.id,
      event_hash: event._trace_integrity.event_hash,
      issues: valid
        ? []
        : [
            `canonical story step for phase '${currentState}' does not match its sealed completion attestation`,
          ],
    };
  }

  const refs = (Array.isArray(event.evidence_refs) ? event.evidence_refs : [])
    .filter((ref) => ref?.path === stepRef);
  if (
    refs.length !== 1
    || refs[0].representation !== "redacted_utf8_v2"
    || !refs[0].policy_source_ref
  ) {
    return {
      valid: false,
      mode: "legacy_evidence_ref",
      event_id: event.id,
      event_hash: event._trace_integrity.event_hash,
      issues: [
        `canonical story step for phase '${currentState}' has no verifiable sealed completion attestation; complete the step again`,
      ],
    };
  }
  try {
    const policy = loadTraceEvidencePolicySource(context, refs[0].policy_source_ref, {
      allowedAlgorithms: ["operational_v2"],
    });
    const presented = redactValueWithMetadata(record, policy);
    if (presented.limited) {
      throw new Error("redaction reached its safety limit");
    }
    const representation = `${JSON.stringify(presented.value)}\n`;
    const valid = evidenceRepresentationMatchesRef(representation, refs[0]);
    return {
      valid,
      mode: "legacy_evidence_ref",
      event_id: event.id,
      event_hash: event._trace_integrity.event_hash,
      issues: valid
        ? []
        : [
            `canonical story step for phase '${currentState}' does not match its sealed completion evidence`,
          ],
    };
  } catch (error) {
    return {
      valid: false,
      mode: "legacy_evidence_ref",
      event_id: event.id,
      event_hash: event._trace_integrity.event_hash,
      issues: [
        `canonical story step for phase '${currentState}' completion evidence cannot be verified: ${error.message}`,
      ],
    };
  }
}

export function currentStoryPhaseCompletionReadiness(
  context,
  storyId,
  instance,
  effectiveDefinition,
  events,
  currentState,
) {
  const enteredAt = workflowCurrentPhaseEntryAt(instance, events, currentState);
  const issues = [];
  const stepNames = [
    currentState,
    ...Array.from(LEGACY_STORY_STEP_PHASE_ALIASES.entries())
      .filter(([, phase]) => phase === currentState)
      .map(([alias]) => alias),
  ];
  const candidates = [];

  if (!(effectiveDefinition.phase_order || []).includes(currentState)) {
    issues.push(`workflow state '${currentState}' is not a configured story phase`);
  }
  if (!enteredAt) {
    issues.push(`workflow phase '${currentState}' has no valid entry timestamp`);
  }
  for (const stepName of stepNames) {
    const stepPath = path.join(
      context.sdlcRoot,
      "stories",
      storyId,
      "steps",
      `${stepName}.json`,
    );
    if (!fs.existsSync(stepPath)) continue;
    const stepRef = toProjectPath(context, stepPath);
    const candidate = {
      stepName,
      stepPath,
      stepRef,
      record: null,
      stepSnapshot: null,
      traceAttestation: null,
      issues: [],
    };
    try {
      candidate.stepSnapshot = readStableRegularFileBuffer(stepPath, context.root);
      candidate.record = JSON.parse(candidate.stepSnapshot.content.toString("utf8"));
      if (
        !candidate.record
        || typeof candidate.record !== "object"
        || Array.isArray(candidate.record)
      ) {
        candidate.issues.push(
          `canonical story step '${stepName}' for phase '${currentState}' must be a JSON object`,
        );
        candidate.record = null;
        candidate.stepSnapshot = null;
      }
    } catch (error) {
      candidate.issues.push(
        `canonical story step '${stepName}' for phase '${currentState}' cannot be read: ${error.message}`,
      );
    }

    const record = candidate.record;
    if (record) {
      if (record.story_id !== storyId) {
        candidate.issues.push(
          `canonical story step '${stepName}' story_id '${record.story_id || "(missing)"}' does not match '${storyId}'`,
        );
      }
      if (record.step !== stepName || record.phase !== currentState) {
        candidate.issues.push(
          `canonical story step '${stepName}' does not match replay phase '${currentState}'`,
        );
      }
      if (record.status !== "completed") {
        candidate.issues.push(
          `canonical story step '${stepName}' for phase '${currentState}' is '${record.status || "(missing)"}', not completed`,
        );
      }
      const completedAt = Date.parse(String(record.completed_at || ""));
      if (!Number.isFinite(completedAt)) {
        candidate.issues.push(
          `canonical story step '${stepName}' for phase '${currentState}' has no valid completed_at`,
        );
      } else if (enteredAt && completedAt < Date.parse(enteredAt)) {
        candidate.issues.push(
          `canonical story step '${stepName}' for phase '${currentState}' was completed before the workflow entered that phase`,
        );
      }
      if (candidate.stepSnapshot) {
        candidate.traceAttestation = storyPhaseCompletionTraceAttestation(
          context,
          storyId,
          currentState,
          stepName,
          stepRef,
          record,
          candidate.stepSnapshot,
        );
        candidate.issues.push(...candidate.traceAttestation.issues);
      }
    }
    candidates.push(candidate);
  }

  if (candidates.length === 0) {
    const expected = stepNames.map((stepName) =>
      toProjectPath(
        context,
        path.join(
          context.sdlcRoot,
          "stories",
          storyId,
          "steps",
          `${stepName}.json`,
        ),
      ));
    issues.push(
      `no completed canonical story step exists for phase '${currentState}' at ${expected.join(" or ")}`,
    );
  }
  issues.push(...candidates.flatMap((candidate) => candidate.issues));
  const selected = candidates
    .filter((candidate) => candidate.issues.length === 0)
    .sort((left, right) =>
      Date.parse(left.record.completed_at) - Date.parse(right.record.completed_at)
      || left.stepName.localeCompare(right.stepName, "en"))
    .at(-1) || null;

  return {
    required: true,
    ready: issues.length === 0,
    story_id: storyId,
    phase: currentState,
    entered_at: enteredAt,
    step: selected?.stepName || null,
    step_path: selected?.stepRef || null,
    step_id: selected?.record?.id || null,
    completed_at: selected?.record?.completed_at || null,
    trace_attestation: selected?.traceAttestation || null,
    issues,
  };
}

export function readContractById(context, contractId, options = {}) {
  const id = normalizeId(contractId);
  const contractPath = path.join(context.sdlcRoot, "contracts", `${id}.json`);
  if (!fs.existsSync(contractPath)) {
    if (options.missingOk) {
      return null;
    }
    return null;
  }
  resolveProjectFilePath(context, toProjectPath(context, contractPath), { mustExist: true, fileOnly: true });
  assertNoSymlinkPathSegments(contractPath, context.root);
  const contract = readProjectJson(context, contractPath);
  contract.__path = contractPath;
  contract.__relative_path = toProjectPath(context, contractPath);
  return contract;
}

export function contractNegotiationQuestion(phase, storyId) {
  const subject = storyId ? `story ${storyId}` : "this project";
  const phaseLabel = phase || "the requested phase";
  return `No approved ${phaseLabel} contract is ready for ${subject}. Confirm the expected output, delivery/presentation format, boundaries, constraints, and approval rules before work starts.`;
}

export function inspectStoryContract(context, story) {
  if (!story.contract_id) {
    return { exists: false, approved: false, contract: null, message: "Story has no contract_id" };
  }
  const contract = readContractById(context, story.contract_id, { missingOk: true });
  if (!contract) {
    return { exists: false, approved: false, contract: null, message: `Missing contract ${story.contract_id}` };
  }
  if (contract.story_id !== story.id) {
    return {
      exists: false,
      approved: false,
      contract,
      message: `Contract ${story.contract_id} is bound to ${contract.story_id || "the project"}, not story ${story.id}`,
    };
  }
  if (story.contract_review_required) {
    return {
      exists: true,
      approved: false,
      review_required: true,
      contract,
      message:
        `Story ${story.id} acceptance criteria changed after contract ${story.contract_id}; `
        + "a new exact contract ID must be created and approved before governed work can continue",
    };
  }
  return {
    exists: true,
    approved: isTaskContractApproved(context, contract),
    review_required: false,
    contract,
    message: collectContractDependencyFreshnessGaps(context, contract).length > 0
      ? `Contract ${story.contract_id} has stale context, output-format, or capability dependencies`
      : story.contract_id,
  };
}

export function readStoryClaim(context, storyId) {
  const claimPath = path.join(context.sdlcRoot, "stories", storyId, "claim.json");
  return fs.existsSync(claimPath) ? readProjectJson(context, claimPath) : null;
}

export function proposeBaseline(context, options) {
  ensureInitialized(context);
  const result = createBaselineProposal(context, options);
  const baselineApprovalRequest = buildBaselineApprovalRequest(context, result.baseline);
  const assistantMessage = renderApprovalRequestsAssistantMessage([baselineApprovalRequest]);
  output(
    options,
    {
      status: "proposed",
      baseline_path: result.baseline_path,
      report_path: result.report_path,
      baseline: result.baseline,
      assistant_message: assistantMessage,
      ...assistantMessagePresentationFields(),
      approval_request: baselineApprovalRequest,
      next_commands: [
        `agentic-sdlc baseline status --id ${result.baseline.id}`,
        `agentic-sdlc baseline approve --id ${result.baseline.id} --actor-type human --approval-source explicit-user --summary "<what the user confirmed>"`,
      ],
    },
    [
      `Proposed baseline ${result.baseline.id}`,
      "",
      ...assistantMessage.split("\n"),
    ],
  );
}

export function approveBaseline(context, options) {
  ensureInitialized(context);
  const id = normalizeId(requireOption(options, "id"));
  const baselinePath = baselinePathById(context, id);
  const reportPath = path.join(baselineRoot(context), `${id}-current-state.md`);
  if (!fs.existsSync(baselinePath)) {
    fail(`Baseline ${id} does not exist`);
  }
  const attribution = buildAttribution(context, options, "baseline.approve");
  requireFormalApprovalActor(context, options, attribution, "Approving a project baseline");
  let baseline;
  let approval;
  const releaseLock = acquireFileLock(`${baselinePath}.lock`);
  try {
    baseline = readProjectJson(context, baselinePath);
    validateBaselineSourceHashes(context, baseline, `baseline ${id}`, { failOnStale: true });
    const approvalSource = normalizeApprovalSource(context, options, attribution, `baseline ${id}`, "approved");
    baseline.canonicality = {
      ...(baseline.canonicality || {}),
      state: approvalSource === "bootstrap" ? "bootstrap" : "confirmed",
      inferred_not_approved: approvalSource === "bootstrap",
      user_confirmation_required: approvalSource === "bootstrap",
    };
    approval = buildApprovalRecord(context, options, attribution, {
      subject: baseline,
      subject_id_field: "baseline_id",
      subject_id: id,
      scope: options.scope || "project-baseline",
      label: `baseline ${id}`,
    });
    baseline.status = approval.provisional ? "provisionally_approved" : "approved";
    baseline.approvals = Array.isArray(baseline.approvals) ? baseline.approvals : [];
    baseline.approvals.push(approval);
    baseline.updated_at = now();
    baseline.audit = {
      ...(baseline.audit || {}),
      approved_by: attribution.actor,
      git: attribution.git,
      run: attribution.run,
    };
    writeJsonFile(baselinePath, baseline, { force: true });
    writeTextFile(reportPath, renderBaselineReport(baseline), { force: true });
  } finally {
    releaseLock();
  }
  appendTraceEvent(context, null, {
    type: "gate",
    summary: approval.summary || `Approved project baseline ${id}`,
    action: "baseline.approve",
    actor: attribution.actor,
    evidence: [
      toProjectPath(context, baselinePath),
      toProjectPath(context, reportPath),
      ...approval.evidence.map((item) => item.path),
    ],
    related: [id],
    git: attribution.git,
    run: attribution.run,
  });
  output(
    options,
    { status: baseline.status, baseline_path: baselinePath, report_path: reportPath, approval, baseline },
    [`Approved baseline ${id}`],
  );
}

export function readRequirement(context, id, options = {}) {
  const filePath = requirementPath(context, id);
  if (!fs.existsSync(filePath)) {
    if (options.missingOk) {
      return null;
    }
    fail(`Requirement ${id} does not exist.`);
  }
  return readProjectJson(context, filePath);
}

export function readRequirementAutonomyProfile(context, profileId, options = {}) {
  const filePath = requirementAutonomyPath(context, profileId);
  if (!fs.existsSync(filePath)) {
    if (options.missingOk) return null;
    fail(`Requirement autonomy profile ${profileId} does not exist.`);
  }
  const profile = readProjectJson(context, filePath);
  const integrity = validateRequirementExecutionProfileIntegrity(profile);
  if (!integrity.valid) {
    fail(`Requirement autonomy profile ${profileId} failed integrity validation: ${integrity.errors.join("; ")}`);
  }
  return profile;
}

export function resolveRequirementSources(context, values) {
  const sourcePaths = normalizeRawListOption(values).map((source) => {
    return stableContextSourceSnapshot(context, source, "Requirement source").projectPath;
  });
  return {
    source_paths: sourcePaths,
    source_hashes: Object.fromEntries(sourcePaths.map((sourcePath) => {
      const snapshot = stableContextSourceSnapshot(context, sourcePath, "Requirement source");
      return [sourcePath, snapshot.sha256];
    })),
  };
}

export function validateRequirementSourceHashes(context, requirement, label, options = {}) {
  const stale = [];
  for (const sourcePath of requirement.source_paths || []) {
    let actual = null;
    let safeSnapshot = false;
    let snapshotError = null;
    try {
      const snapshot = stableContextSourceSnapshot(context, sourcePath, "Requirement source");
      actual = snapshot.sha256;
      safeSnapshot = true;
    } catch (error) {
      actual = null;
      snapshotError = error.message;
    }
    const expected = requirement.source_hashes?.[sourcePath] || null;
    if (!actual || actual !== expected) {
      const evolution = safeSnapshot && options.executionContext
        ? executionContextSourceEvolution(context, {
            ...options.executionContext,
            sourcePath,
            expectedSha256: expected,
            bindingKind: "requirement",
            bindingId: requirement.id,
          })
        : {
            allowed: false,
            reason: safeSnapshot ? "preflight_not_requested" : "unsafe_context_source",
            errors: snapshotError ? [snapshotError] : [],
          };
      if (!evolution.allowed) {
        stale.push({
          path: sourcePath,
          expected,
          actual,
          recovery: executionContextRecoveryMessage(sourcePath),
          preflight_reason: evolution.reason,
          preflight_errors: evolution.errors || [],
        });
      }
    }
  }
  if (stale.length > 0 && options.failOnStale) {
    fail(
      `${label} has stale source evidence: ${stale.map((item) => item.path).join(", ")}. `
      + stale.map((item) => item.recovery).join(" "),
    );
  }
  return stale;
}

export function normalizeRequirementWritePaths(context, rawPaths, options = {}) {
  const label = options.label || "Requirement --write-path";
  const canonical = normalizeListOption(rawPaths).map((rawPath, index) => {
    const resolved = resolveProjectFilePath(context, rawPath, { mustExist: false });
    const projectPath = toProjectPath(context, resolved);
    if (!projectPath || projectPath === ".") {
      fail(
        `${label}[${index}] must name a file or directory inside the target project, not the project root itself.`,
      );
    }
    if (
      projectPath.toLowerCase() === ".git"
      || projectPath.toLowerCase().startsWith(".git/")
    ) {
      fail(
        `${label}[${index}] cannot include Git repository metadata; `
        + "govern source files through requirement scope and Git mutations through delivery actions.",
      );
    }
    return projectPath;
  });
  return [...new Set(canonical)].sort();
}

export function requirementWriteScopeWarnings(options, writePaths) {
  if (writePaths.length > 0) return [];
  return [
    humanGuidanceLocale(options) === "it"
      ? "Lo scope di scrittura del requisito è vuoto: va bene solo per attività di governance senza modifiche a prodotto o output; prima di un lavoro materiale crea una revisione con un --write-path relativo al progetto per ogni area di codice, test, documentazione ed evidenze che potrà cambiare."
      : "The requirement write scope is empty: this is valid only for governance work with no product or output changes; before material work, create a revision with one project-relative --write-path for every code, test, documentation, and evidence area that may change.",
  ];
}

export function assertCanonicalRequirementWriteScope(context, profile, requirementId) {
  const materialPaths = Array.isArray(profile.material_scope?.write_paths)
    ? profile.material_scope.write_paths
    : [];
  const constraintPaths = Array.isArray(profile.constraints?.allowed_write_paths)
    ? profile.constraints.allowed_write_paths
    : [];
  let canonicalMaterial;
  let canonicalConstraints;
  try {
    canonicalMaterial = normalizeRequirementWritePaths(context, materialPaths, {
      label: `Requirement ${requirementId} material scope write path`,
    });
    canonicalConstraints = normalizeRequirementWritePaths(context, constraintPaths, {
      label: `Requirement ${requirementId} allowed write path`,
    });
  } catch (error) {
    rejectLegacyRequirementWriteScope(requirementId, profile.id, error.message);
  }
  if (
    stableJson(materialPaths) !== stableJson(canonicalMaterial)
    || stableJson(constraintPaths) !== stableJson(canonicalConstraints)
    || stableJson(canonicalMaterial) !== stableJson(canonicalConstraints)
  ) {
    rejectLegacyRequirementWriteScope(
      requirementId,
      profile.id,
      "the stored paths are not sorted, unique, project-relative, and identical in material scope and constraints",
    );
  }
  return canonicalMaterial;
}

export function buildRequirementProfileFor(context, requirement, options = {}, settings = {}) {
  const ceiling = normalizeAutonomyLevel(
    settings.ceiling || getOptionString(options, "autonomy-ceiling") || context.config.autonomy_policy?.default_requirement_ceiling || "supervised",
  );
  const profileId = normalizeId(settings.profileId || requirement.autonomy_profile_id);
  const preset = context.config.autonomy_policy?.presets?.[ceiling] || {};
  const canonicalWritePaths = settings.material_scope && settings.constraints
    ? null
    : normalizeRequirementWritePaths(
        context,
        settings.writePaths === undefined ? options["write-path"] : settings.writePaths,
      );
  return buildDomainRecord(`Cannot build autonomy profile ${profileId}`, () => buildRequirementExecutionProfile({
    id: profileId,
    status: settings.status || "proposed",
    requirement_ref: {
      id: requirement.id,
      version: requirement.revision,
      path: toProjectPath(context, requirementPath(context, requirement.id)),
      hash: requirementContentHash(requirement),
    },
    autonomy_ceiling: ceiling,
    phase_levels: settings.phase_levels || {},
    material_scope: settings.material_scope
      || requirementMaterialScope(requirement, options, canonicalWritePaths),
    constraints: settings.constraints || {
      allowed_tools: normalizeListOption(options.tool),
      allowed_capabilities: normalizeListOption(options.capability),
      allowed_environments: normalizeListOption(options.environment).length > 0
        ? normalizeListOption(options.environment)
        : ["local"],
      allowed_write_paths: canonicalWritePaths,
      forbidden_actions: context.config.autonomy_policy?.exception_triggers || [],
      budget_ref: null,
    },
    checkpoints: settings.checkpoints || preset.checkpoints || [],
    exception_actions: context.config.autonomy_policy?.exception_triggers || [],
    authority_assurance: settings.authority_assurance || { mode: "audit_only" },
    approval_ref: settings.approval_ref || null,
    valid_from: settings.valid_from || requirement.created_at,
    expires_at: settings.expires_at ?? getOptionString(options, "expires-at"),
    created_at: settings.created_at || requirement.created_at,
    updated_at: settings.updated_at || requirement.updated_at,
    extensions: settings.extensions || {},
  }));
}

export function proposeRequirement(context, options, settings = {}) {
  ensureInitialized(context);
  const id = normalizeId(requireOption(options, "id"));
  const title = requireOption(options, "title");
  const summary = getOptionString(options, "summary") || getOptionString(options, "scope-summary");
  if (!summary) {
    fail("Requirement proposal needs --summary explaining the requested outcome and boundary.");
  }
  const acceptanceCriteria = normalizeListOption(options.acceptance);
  if (acceptanceCriteria.length === 0) {
    fail([
      "Requirement proposal needs at least one --acceptance criterion.",
      "What I need: an observable statement that lets a reviewer decide whether the outcome is complete.",
      "Why: a title and summary describe intent but do not define testable success.",
      "Effect: the criterion and the selected autonomy ceiling become immutable inputs to downstream stories, contracts, and deliveries.",
    ].join("\n"));
  }
  if (options.status && String(options.status) !== "proposed") {
    fail("Requirement proposal is always created as 'proposed'. Use requirement approve for a separate content-bound decision.");
  }
  if (options.proposal && !getOptionString(options, "proposal-hash")) {
    fail("A proposal-bound requirement requires both --proposal <id> and --proposal-hash <sha256>.");
  }
  const ceiling = getOptionString(options, "autonomy-ceiling")
    || (settings.legacyAlias ? "supervised" : null);
  if (!ceiling) {
    fail("Requirement proposal needs --autonomy-ceiling supervised|checkpointed|bounded-autonomous. This is a ceiling, not authority for future PRs.");
  }
  normalizeAutonomyLevel(ceiling);
  const attribution = buildAttribution(context, options, settings.legacyAlias ? "requirement.create" : "requirement.propose");
  const profileId = normalizeId(`AUT-${id}-R1`);
  const sources = resolveRequirementSources(context, options.source);
  const createdAt = now();
  const requirement = buildDomainRecord(`Cannot propose requirement ${id}`, () => buildRequirementProposal({
    id,
    logical_id: id,
    revision: 1,
    title,
    summary,
    acceptance_criteria: acceptanceCriteria,
    non_goals: normalizeListOption(options["non-goal"]),
    constraints: normalizeListOption(options.constraint),
    non_functional_requirements: normalizeListOption(options.nfr),
    integrations: normalizeListOption(options.integration),
    ...sources,
    proposal_ref: options.proposal
      ? { id: normalizeId(String(options.proposal)), hash: getOptionString(options, "proposal-hash") }
      : null,
    previous_revision_ref: null,
    autonomy_profile_id: profileId,
    created_at: createdAt,
    audit: {
      created_by: attribution.actor,
      updated_by: attribution.actor,
      git: attribution.git,
      run: attribution.run,
    },
  }));
  const profile = buildRequirementProfileFor(context, requirement, options, { ceiling });
  const writeScopeWarnings = requirementWriteScopeWarnings(
    options,
    profile.constraints.allowed_write_paths,
  );
  const filePath = requirementPath(context, id);
  const profilePath = requirementAutonomyPath(context, profileId);
  assertRecordSchema(requirement, "requirement.schema.json", `Requirement ${id}`);
  assertRecordSchema(profile, "requirement-execution-profile.schema.json", `Requirement autonomy profile ${profileId}`);
  const releaseLock = acquireFileLock(`${filePath}.lock`);
  try {
    writeJsonFile(filePath, requirement, { force: false });
    writeJsonFile(profilePath, profile, { force: false });
  } finally {
    releaseLock();
  }
  appendTraceEvent(context, null, {
    type: "decision",
    summary: `Proposed requirement ${id} with autonomy ceiling ${ceiling}`,
    action: settings.legacyAlias ? "requirement.create" : "requirement.propose",
    actor: attribution.actor,
    evidence: [toProjectPath(context, filePath), toProjectPath(context, profilePath)],
    related: [id, profileId, requirement.proposal_ref?.id].filter(Boolean),
    git: attribution.git,
    run: attribution.run,
  });
  const guidance = requirementAutonomyCeilingGuidance({
    status: "proposed",
    requirement_id: id,
    profile_id: profile.id,
    autonomy_ceiling: ceiling,
    authority_mode: context.config.authority_policy?.mode || "audit_only",
  }, { locale: humanGuidanceLocale(options) });
  output(options, {
    status: "proposed",
    deprecated_alias: Boolean(settings.legacyAlias),
    requirement,
    requirement_path: toProjectPath(context, filePath),
    autonomy_profile: profile,
    autonomy_profile_path: toProjectPath(context, profilePath),
    warnings: writeScopeWarnings,
    human_guidance: guidance,
  }, [
    ...humanGuidanceLines(guidance, [
      `Requirement: ${id} — ${title}`,
      `Maximum technical level: ${ceiling}`,
      "No pull request or local release is authorized by this proposal.",
      ...writeScopeWarnings.map((warning) => `Warning: ${warning}`),
      ...(settings.legacyAlias ? ["Command alias: create (deprecated; use requirement propose)"] : []),
    ], options),
  ]);
}

export function approveRequirement(context, options) {
  ensureInitialized(context);
  const id = normalizeId(requireOption(options, "id"));
  const filePath = requirementPath(context, id);
  const releaseLock = acquireFileLock(`${filePath}.lock`);
  try {
    return approveRequirementLocked(context, options, id, filePath);
  } finally {
    releaseLock();
  }
}

export function reviseRequirement(context, options) {
  ensureInitialized(context);
  const currentId = normalizeId(requireOption(options, "id"));
  const newId = normalizeId(requireOption(options, "new-id"));
  if (currentId === newId) {
    fail("A requirement revision needs a new immutable --new-id.");
  }
  const initialCurrent = readRequirement(context, currentId);
  const lineageLock = path.join(
    requirementLifecycleRoot(context),
    `.logical-${shortHash(initialCurrent.logical_id || initialCurrent.id)}.lock`,
  );
  const releaseLock = acquireFileLock(lineageLock);
  try {
    return reviseRequirementLocked(context, options, currentId, newId);
  } finally {
    releaseLock();
  }
}

export function requirementSupersessionEvents(context) {
  return safeReadDir(requirementLifecycleRoot(context))
    .filter((name) => name.endsWith(".json"))
    .map((name) => readProjectJson(context, path.join(requirementLifecycleRoot(context), name)));
}

export function requirementSupersessionGovernanceErrors(context, event) {
  const report = { strict: true, errors: [], warnings: [] };
  const approval = event?.approval;
  if (!approval || approval.status !== "approved") {
    return [`requirement lifecycle event ${event?.id || "unknown"} has no approved governance record`];
  }
  const subject = {
    current: event.requirement_ref,
    replacement: event.replacement_ref,
    reason: event.reason,
  };
  if (approval.approved_content_hash !== hashApprovalSubject(subject)) {
    report.errors.push(`requirement lifecycle event ${event.id || "unknown"} approval does not bind the exact supersession subject`);
  }
  if (!hasFormalApprovalAttribution(approval.approved_by, approval.approval_source)) {
    report.errors.push(`requirement lifecycle event ${event.id || "unknown"} approval attribution is incomplete`);
  }
  validateFormalApprovalRecord(
    context,
    report,
    approval,
    `requirement lifecycle event ${event.id || "unknown"} approval`,
    approval.approved_by,
    { subject_id: event.requirement_ref?.id || null },
  );
  return report.errors;
}

export function assertRequirementReadyForDownstream(
  context,
  requirement,
  label = `Requirement ${requirement?.id || "unknown"}`,
  options = {},
) {
  if (!requirement) fail(`${label} does not exist.`);
  if (requirement.schema_version !== "requirement:v2") {
    return { legacy: true, autonomy_level: "supervised", profile: null };
  }
  if (requirement.status !== "approved" || !isApprovedRecordFresh(requirement)) {
    fail(`${label} must have a fresh formal approval before downstream story or delivery work.`);
  }
  if (effectiveRequirementStatus(context, requirement).status === "superseded") {
    fail(`${label} is superseded; use its approved replacement revision.`);
  }
  if (options.allowPendingSupersession !== true) {
    const approvedHeads = safeReadDir(requirementsRoot(context))
      .filter((name) => name.endsWith(".json"))
      .map((name) => readProjectJson(context, path.join(requirementsRoot(context), name)))
      .filter((candidate) =>
        candidate.schema_version === "requirement:v2"
        && candidate.logical_id === requirement.logical_id
        && candidate.status === "approved"
        && effectiveRequirementStatus(context, candidate).status !== "superseded");
    if (approvedHeads.length !== 1 || approvedHeads[0]?.id !== requirement.id) {
      fail(`${label} is not the single approved head of logical requirement ${requirement.logical_id}; complete the explicit supersession first.`);
    }
  }
  validateRequirementSourceHashes(context, requirement, label, {
    failOnStale: true,
    executionContext: options.executionContext || null,
  });
  const profile = readRequirementAutonomyProfile(context, requirement.autonomy_profile_id);
  if (profile.status !== "active" || profile.requirement_ref.hash !== requirementContentHash(requirement)) {
    fail(`${label} has no active, current requirement autonomy profile.`);
  }
  validateAutonomyApprovalRef(context, profile, label);
  return { legacy: false, autonomy_level: profile.autonomy_ceiling, profile };
}

export function supersedeRequirement(context, options) {
  ensureInitialized(context);
  const currentId = normalizeId(requireOption(options, "id"));
  const replacementId = normalizeId(requireOption(options, "new-id"));
  const reason = requireOption(options, "reason");
  const initialCurrent = readRequirement(context, currentId);
  const lineageLock = path.join(
    requirementLifecycleRoot(context),
    `.logical-${shortHash(initialCurrent.logical_id || initialCurrent.id)}.lock`,
  );
  const releaseLock = acquireFileLock(lineageLock);
  try {
    return supersedeRequirementLocked(context, options, currentId, replacementId, reason);
  } finally {
    releaseLock();
  }
}

export function showRequirements(context, options) {
  ensureInitialized(context);
  const id = options.id ? normalizeId(String(options.id)) : null;
  const records = safeReadDir(requirementsRoot(context))
    .filter((name) => name.endsWith(".json"))
    .map((name) => readProjectJson(context, path.join(requirementsRoot(context), name)))
    .filter((record) => !id || record.id === id)
    .map((record) => {
      const effective = effectiveRequirementStatus(context, record);
      const profile = record.autonomy_profile_id
        ? readRequirementAutonomyProfile(context, record.autonomy_profile_id, { missingOk: true })
        : null;
      return {
        ...record,
        effective_status: effective.status,
        supersession: effective.event,
        autonomy: profile
          ? {
              profile_id: profile.id,
              status: profile.status,
              ceiling: profile.autonomy_ceiling,
              profile_hash: profile.profile_hash,
              authority_assurance: profile.authority_assurance,
            }
          : { profile_id: null, status: "legacy", ceiling: "supervised", profile_hash: null, authority_assurance: null },
      };
    });
  if (id && records.length === 0) {
    fail(`Requirement ${id} does not exist.`);
  }
  const italian = humanGuidanceLocale(options) === "it";
  const perRequirement = records.map((record) => record.autonomy.profile_id
    ? requirementAutonomyCeilingGuidance({
        status: record.autonomy.status,
        requirement_id: record.id,
        profile_id: record.autonomy.profile_id,
        autonomy_ceiling: record.autonomy.ceiling,
        authority_assurance: record.autonomy.authority_assurance,
      }, { locale: italian ? "it" : "en" })
    : {
        result: italian
          ? "Per questo requisito lavorerò nel modo più prudente e chiederò conferma prima di ogni modifica importante."
          : "For this requirement, I will use the most cautious way of working and ask before every important change.",
        impact: italian
          ? "La modalità di lavoro non è ancora stata concordata nel nuovo formato."
          : "The way of working has not yet been agreed in the current format.",
        required_decision: italian
          ? "Concorda il requisito nel formato attuale prima di scegliere l’autonomia di una consegna."
          : "Agree the requirement in the current format before choosing delivery independence.",
        protection_boundary: italian
          ? "Nessun lavoro, merge o rilascio è autorizzato da questo stato."
          : "This status authorizes no work, merge, or release.",
        next_action: italian
          ? "Aggiorna il requisito, poi scegli separatamente come lavorerò per ogni consegna."
          : "Update the requirement, then choose separately how I will work for each delivery.",
        details: {},
      });
  const aggregateGuidance = records.length === 1
    ? perRequirement[0]
    : {
        result: records.length > 0
          ? (italian ? `Sono stati trovati ${records.length} requisiti.` : `${records.length} requirements were found.`)
          : (italian ? "Non è stato trovato alcun requisito." : "No requirement was found."),
        impact: italian
          ? "Ogni requisito stabilisce soltanto la massima autonomia disponibile; per ogni pull request o rilascio locale la scelta viene fatta separatamente."
          : "Each requirement sets only the maximum available independence; every pull request or local release gets a separate choice.",
        required_decision: italian
          ? "Non serve una decisione per consultare questo elenco."
          : "No decision is needed to review this list.",
        protection_boundary: italian
          ? "L’elenco non autorizza lavoro, merge, rilasci o accessi esterni."
          : "The list authorizes no work, merge, release, or external access.",
        next_action: italian
          ? "Apri il requisito che vuoi rivedere oppure crea la scelta per la prossima consegna."
          : "Open the requirement you want to review, or create the choice for the next delivery.",
        details: {},
      };
  const summaries = records.length > 1
    ? perRequirement.map((guidance, index) => `${italian ? "Requisito" : "Requirement"} ${index + 1}: ${guidance.result}`)
    : [];
  const technical = records.map((record) => [
    `Requirement: ${record.id}`,
    `Status: ${record.effective_status || record.status || "unknown"}`,
    `Maximum technical level: ${record.autonomy.ceiling}`,
    `Title: ${record.title || "untitled"}`,
  ].join("; "));
  output(options, { requirements: records }, humanGuidanceLines(aggregateGuidance, technical, options, summaries));
}

export function showRequirementAutonomy(context, options) {
  ensureInitialized(context);
  const id = normalizeId(requireOption(options, "id"));
  const requirement = readRequirement(context, id);
  const profile = requirement.autonomy_profile_id
    ? readRequirementAutonomyProfile(context, requirement.autonomy_profile_id, { missingOk: true })
    : null;
  const guidance = profile
    ? requirementAutonomyCeilingGuidance({
        status: profile.status,
        requirement_id: id,
        profile_id: profile.id,
        autonomy_ceiling: profile.autonomy_ceiling,
        authority_assurance: profile.authority_assurance,
      }, { locale: humanGuidanceLocale(options) })
    : null;
  output(options, {
    requirement_id: id,
    requirement_status: effectiveRequirementStatus(context, requirement).status,
    legacy_fallback: !profile,
    autonomy_profile: profile,
    human_guidance: guidance,
  }, profile
    ? humanGuidanceLines(guidance, [
        `Requirement: ${id}`,
        `Maximum technical level: ${profile.autonomy_ceiling}`,
        `Profile status: ${profile.status}`,
      ], options)
    : humanGuidanceLines({
        result: humanGuidanceLocale(options) === "it"
          ? "Per questo requisito lavorerò nel modo più prudente."
          : "For this requirement, I will use the most cautious way of working.",
        impact: humanGuidanceLocale(options) === "it"
          ? "Ti chiederò conferma prima di ogni modifica importante perché la modalità di lavoro non è ancora stata concordata nel formato attuale."
          : "I will ask before every important change because the way of working has not yet been agreed in the current format.",
        required_decision: humanGuidanceLocale(options) === "it"
          ? "Concorda il requisito nel formato attuale prima di scegliere l’autonomia di una consegna."
          : "Agree the requirement in the current format before choosing delivery independence.",
        protection_boundary: humanGuidanceLocale(options) === "it"
          ? "Questo stato non autorizza lavoro, merge, rilasci o accessi esterni."
          : "This status authorizes no work, merge, release, or external access.",
        next_action: humanGuidanceLocale(options) === "it"
          ? "Aggiorna il requisito, poi scegli separatamente come lavorerò per ogni pull request o rilascio locale."
          : "Update the requirement, then choose separately how I will work for every pull request or local release.",
        details: {},
      }, [
        `Requirement: ${id}`,
        "Technical fallback: supervised",
        "Migration target: requirement:v2",
      ], options));
}

export function requirementByAutonomyProfileId(context, profileId) {
  return safeReadDir(requirementsRoot(context))
    .filter((name) => name.endsWith(".json"))
    .map((name) => readProjectJson(context, path.join(requirementsRoot(context), name)))
    .find((requirement) => requirement.autonomy_profile_id === profileId) || null;
}

export function storyActionCheckpointPolicy(context, storyId, action) {
  const story = readStory(context, storyId);
  if (!story?.contract_id) {
    return { required: false, story, contract: null, profile: null, profile_ref: null };
  }
  const contract = readContractById(context, story.contract_id, { missingOk: true });
  if (!contract?.delivery_execution_profile_id) {
    return { required: false, story, contract, profile: null, profile_ref: null };
  }
  const profile = readDeliveryAutonomyProfile(context, contract.delivery_execution_profile_id);
  if (!(profile.story_refs || []).some((reference) => reference?.id === storyId)) {
    fail(`Delivery autonomy profile ${profile.id} is not bound to story ${storyId}.`);
  }
  const profileRef = {
    id: profile.id,
    path: toProjectPath(context, deliveryAutonomyPath(context, profile.id)),
    hash: profile.profile_hash,
  };
  return {
    required: (profile.checkpoints || []).includes(action),
    story,
    contract,
    profile,
    profile_ref: profileRef,
  };
}

export function consumeStoryActionCheckpoint(context, storyId, action, options, settings = {}) {
  const policy = storyActionCheckpointPolicy(context, storyId, action);
  const authorizationId = getOptionString(options, "authorization");
  if (!policy.required && !authorizationId) {
    return null;
  }
  const artifactTypes = authorizationArtifactTypes({
    artifact_types: settings.artifact_types || [],
  });
  const artifactGrantArgs = artifactTypes
    .map((artifactType) => ` --allow-artifact-type ${artifactType}`)
    .join("");
  const subjectId = storyActionCheckpointSubjectId(storyId, action, settings);
  if (!authorizationId) {
    fail([
      `${action} is a required checkpoint in exact delivery profile ${policy.profile.id}.`,
      `Grant a human- or CI-approved authorization for action ${action} and subject ${subjectId}, then retry with --authorization <id>.`,
      `Example grant: agentic-sdlc authorization grant --id AUTH-${storyId}-${action.replaceAll(".", "-")} --scope "Approve ${action} for ${subjectId}" --summary "Approve this exact checkpoint" --allow-use ${action}=${subjectId}${artifactGrantArgs} --actor-type human --approval-source explicit-user.`,
      `Effect: only ${action} for ${subjectId} is recorded as approved; the delivery profile and all other protected actions remain unchanged.`,
    ].join("\n"));
  }
  const authorization = readAuthorization(context, normalizeId(authorizationId));
  let authorizationSettings = storyActionAuthorizationSettings(
    policy,
    subjectId,
    artifactTypes,
  );
  let existingUse = validatedExistingAuthorizationUse(
    context,
    authorization,
    action,
    authorizationSettings,
  );
  let errors = authorizationUseErrors(authorization, action, authorizationSettings);
  let reusableExistingUse = existingUse && (
    errors.length === 0
    || canRecoverConsumedLegacyAuthorizationUse(
      authorization,
      errors,
      existingUse,
    )
  )
    ? existingUse
    : null;
  if (errors.length > 0 && subjectId !== storyId) {
    const legacyStorySettings = storyActionAuthorizationSettings(
      policy,
      storyId,
      artifactTypes,
    );
    const legacyExistingUse = validatedExistingAuthorizationUse(
      context,
      authorization,
      action,
      legacyStorySettings,
    );
    const legacyErrors = authorizationUseErrors(
      authorization,
      action,
      legacyStorySettings,
    );
    if (
      legacyErrors.length === 0
      || canRecoverConsumedLegacyAuthorizationUse(
        authorization,
        legacyErrors,
        legacyExistingUse,
      )
    ) {
      authorizationSettings = legacyStorySettings;
      existingUse = legacyExistingUse;
      errors = legacyErrors;
      reusableExistingUse = legacyExistingUse;
    }
  }
  if (errors.length > 0 && !reusableExistingUse) {
    fail(errors[0]);
  }
  const use = reusableExistingUse || recordOrReuseAuthorizationUse(
    context,
    authorization,
    action,
    authorizationSettings,
  );
  return {
    authorization_ref: authorization.id,
    authorization_use_ref: use.path,
    authorization_action: action,
    checkpoint_profile_ref: policy.profile_ref,
  };
}

export function validateStoryActionCheckpoint(
  context,
  storyId,
  action,
  record,
  report,
  label,
  settings = {},
) {
  if (!storyId) {
    return;
  }
  let policy;
  try {
    policy = storyActionCheckpointPolicy(context, storyId, action);
  } catch (error) {
    report.errors.push(`${label} checkpoint policy cannot be verified: ${error.message}`);
    return;
  }
  const hasExplicitAuthorizationEvidence = Boolean(
    record.authorization_ref
    || record.authorization_use_ref
    || record.authorization_action
    || record.checkpoint_profile_ref,
  );
  if (!policy.required && !hasExplicitAuthorizationEvidence) {
    return;
  }
  if (policy.required || record.checkpoint_profile_ref) {
    if (policy.profile_ref && (
      record.checkpoint_profile_ref?.id !== policy.profile_ref.id
      || record.checkpoint_profile_ref?.path !== policy.profile_ref.path
      || record.checkpoint_profile_ref?.hash !== policy.profile_ref.hash
    )) {
      report.errors.push(
        `${label} has no exact checkpoint profile reference for ${action} in ${policy.profile.id}`,
      );
    } else if (!policy.profile_ref && record.checkpoint_profile_ref) {
      report.errors.push(
        `${label} records a checkpoint profile reference even though ${action} has no delivery profile`,
      );
    }
  }
  if (
    !record.authorization_ref
    || !record.authorization_use_ref
    || record.authorization_action !== action
  ) {
    report.errors.push(
      policy.required
        ? `${label} has no exact ${action} authorization receipt required by delivery profile ${policy.profile.id}`
        : `${label} has incomplete explicit ${action} authorization evidence`,
    );
    return;
  }
  const authorization = readAuthorization(context, record.authorization_ref, { missingOk: true });
  if (!authorization) {
    report.errors.push(`${label} references missing authorization ${record.authorization_ref}`);
    return;
  }
  const useReceipt = readAuthorizationUseReceipt(context, record.authorization_use_ref, { missingOk: true });
  if (!useReceipt) {
    report.errors.push(`${label} references missing authorization use receipt ${record.authorization_use_ref}`);
    return;
  }
  const exactSubjectId = storyActionCheckpointSubjectId(storyId, action, settings);
  const receiptSubjectId =
    useReceipt.subject?.subject_id || useReceipt.subject_id || null;
  const expectedSubjectId =
    exactSubjectId !== storyId && receiptSubjectId === storyId
      ? storyId
      : exactSubjectId;
  const authorizationSettings = storyActionAuthorizationSettings(
    policy,
    expectedSubjectId,
    settings.artifact_types || [],
  );
  const proposalBindingError = authorizationProposalBindingError(
    authorization,
    authorizationSettings.proposal_ref,
  );
  if (proposalBindingError) {
    report.errors.push(`${label}: ${proposalBindingError}`);
  }
  for (const error of validateAuthorizationUseReceipt(useReceipt, {
    authorization_id: authorization.id,
    action,
    ...authorizationSettings,
  })) {
    report.errors.push(`${label}: ${error}`);
  }
  if (useReceipt.authorization_hash !== authorizationRecordHash(authorization)) {
    report.errors.push(`${label} authorization use receipt does not match the granted content hash`);
  }
  if (!authorizationAllowsAction(authorization, action)) {
    report.errors.push(`${label}: Authorization ${authorization.id} does not allow action ${action}.`);
  }
  if (!authorizationAllowsSubject(authorization, expectedSubjectId)) {
    report.errors.push(`${label}: Authorization ${authorization.id} does not allow subject ${expectedSubjectId}.`);
  }
  if (expectedSubjectId !== exactSubjectId) {
    report.warnings.push(
      `${label} uses legacy story-wide ${action} subject ${storyId}; `
      + `new grants should bind exact subject ${exactSubjectId}.`,
    );
  }
  for (const artifactType of authorizationSettings.artifact_types) {
    if (!authorizationAllowsArtifactType(authorization, artifactType)) {
      report.errors.push(`${label}: Authorization ${authorization.id} does not allow artifact type ${artifactType}.`);
    }
  }
}

export function selectActiveBaselines(context, storyId = null) {
  const baselines = readBaselines(context);
  if (baselines.length === 0) {
    return [];
  }
  const referencedIds = storyId ? baselineIdsReferencedByStoryContract(context, storyId) : new Set();
  if (referencedIds.size > 0) {
    return baselines.filter((baseline) => referencedIds.has(baseline.id));
  }
  return [baselines.at(-1)];
}

export function baselineIdsReferencedByStoryContract(context, storyId) {
  const story = readStory(context, storyId);
  if (!story?.contract_id) {
    return new Set();
  }
  const contract = readContractById(context, story.contract_id, { missingOk: true });
  if (!contract) {
    return new Set();
  }
  const result = new Set();
  for (const source of contract.contextualization?.context_sources || []) {
    const sourcePath = String(source?.path || source || "").replace(/\\/g, "/");
    const match = sourcePath.match(/^\.sdlc\/baseline\/([^/]+)\.json$/);
    if (match) {
      result.add(match[1]);
    }
  }
  return result;
}

export function baselineIdsReferencedByAllContracts(context) {
  const result = new Set();
  const contractsRoot = path.join(context.sdlcRoot, "contracts");
  for (const contract of collectJsonFiles(context, contractsRoot)) {
    for (const source of contract.contextualization?.context_sources || []) {
      const sourcePath = String(source?.path || source || "").replace(/\\/g, "/");
      const match = sourcePath.match(/^\.sdlc\/baseline\/([^/]+)\.json$/);
      if (match) {
        result.add(match[1]);
      }
    }
  }
  return result;
}

export function buildBaselineRefreshRequest(context, baseline, baselinePath, reportPath, staleSources) {
  const sources = [baselinePath, reportPath].filter((source) => fs.existsSync(path.join(context.root, source)));
  return {
    id: `refresh-baseline-${baseline.id}`,
    type: "baseline_refresh_required",
    status: "needs_refresh",
    summary: `Refresh project context ${baseline.id} before asking for approval or using it as current evidence.`,
    subject_id: baseline.id,
    subject_status: baseline.status || null,
    sources,
    ...humanApprovalFields({
      title: `Refresh project context (${baseline.id})`,
      why_needed: "The project files used for this context changed after it was prepared, so approving the old snapshot would not approve the current project.",
      review_items: [
        baseline.summary ? `Previous project summary: ${baseline.summary}` : null,
        `Changed or missing evidence: ${formatLimitedList(staleSources, 8)}`,
        baseline.source_paths?.length ? `Files that must be read again: ${formatLimitedList(baseline.source_paths, 12)}` : null,
        "What this means: refresh the inferred snapshot, explain the updated contents, and only then request approval if the active approval scope does not already cover it.",
      ],
      approval_meaning: "Refreshing does not approve the project context. It only replaces the outdated snapshot with evidence from the current files.",
      approve_if: "Refresh if these files are still the intended project evidence.",
      change_if: "Change the source list first if files should be added, removed, or treated as non-canonical.",
      after_approval: `After refresh, ${baseline.id} can be summarized from current evidence and approved within the applicable approval scope.`,
      user_prompt: `May I refresh project context ${baseline.id} from its current source files?`,
      approval_phrase: `Refresh project context ${baseline.id}.`,
    }),
    suggested_question: `The evidence behind ${baseline.id} changed. Should I refresh that project context before continuing?`,
    suggested_command: `agentic-sdlc baseline propose --id ${baseline.id} --source <current-path> --force --summary "<updated observable context>"`,
  };
}

export function collectContractClarificationRequests(context, scope = {}) {
  return collectJsonFiles(context, path.join(context.sdlcRoot, "contracts"))
    .filter((contract) => contractMatchesStoryApprovalScope(context, contract, scope))
    .map((contract) => ({
      contract,
      gaps: [
        ...collectContractReadinessGaps(context, contract),
        ...collectContractDependencyFreshnessGaps(context, contract),
      ],
    }))
    .filter((item) => item.gaps.length > 0)
    .map(({ contract, gaps }) => ({
      id: `clarify-contract-${contract.id}`,
      type: "contract_clarification",
      status: "needs_user_input",
      summary: `Clarify contract ${contract.id} before approval: ${gaps.map((gap) => gap.summary).join("; ")}.`,
      subject_id: contract.id,
      subject_status: contract.status || null,
      story_id: contract.story_id || null,
      phase: contract.phase || null,
      gaps: gaps.map((gap) => gap.code),
      sources: [contract.__relative_path],
      ...humanApprovalFields({
        title: `Work brief needs clarification or refresh (${contract.id})`,
        why_needed: "The brief is incomplete or one of its project, output-format, or tool references changed. I need to refresh it before asking you to approve the current work.",
        review_items: [
          ...describeContractForHuman(context, contract),
          ...gaps.flatMap((gap) => [
            `Missing: ${gap.summary}`,
            ...(gap.open_questions || []).map((question, index) => formatExplainedOpenQuestion(question, index + 1)),
          ]),
        ],
        approval_meaning: "This is not an approval yet. It is a request for missing context.",
        approve_if: null,
        change_if: "Answer with the files or facts I should use, or ask me to rewrite the brief with different context.",
        after_approval: "After clarification, the contract can be proposed again for explicit approval.",
        user_prompt: `Which files, facts, constraints, or decisions should guide this work? ${gaps.map((gap) => gap.question).join(" ")}`,
      }),
      suggested_question: `Before approving ${contract.id}, please provide: ${gaps.map((gap) => gap.question).join(" ")}`,
    }));
}

export function contractIsActiveStoryContract(context, contract) {
  if (!contract.story_id) {
    return false;
  }
  const story = readStory(context, contract.story_id);
  return Boolean(story?.contract_id && story.contract_id === contract.id);
}

export function storyRequirementExecutionContext(context, storyId) {
  if (!storyId) {
    return {
      requirements: [],
      requirement_refs: [],
      requirement_profiles: [],
      requirement_profile_refs: [],
      autonomy_ceiling: "supervised",
      has_v2_requirements: false,
    };
  }
  const story = readStory(context, storyId);
  if (!story) fail(`Story ${storyId} does not exist.`);
  const requirements = (story.links?.requirements || []).map((requirementId) => {
    const requirement = readRequirement(context, requirementId, { missingOk: true });
    if (!requirement) fail(`Story ${storyId} references missing requirement ${requirementId}.`);
    return requirement;
  });
  const v2 = [];
  const levels = [];
  for (const requirement of requirements) {
    const ready = assertRequirementReadyForDownstream(context, requirement, `Requirement ${requirement.id}`);
    levels.push(ready.autonomy_level);
    if (!ready.legacy) v2.push({ requirement, profile: ready.profile });
  }
  const storyRefs = new Map((story.requirement_refs || []).map((ref) => [ref.id, ref]));
  for (const { requirement } of v2) {
    const expected = buildRequirementRef(requirement, toProjectPath(context, requirementPath(context, requirement.id)));
    const recorded = storyRefs.get(requirement.id);
    if (!recorded || recorded.content_hash !== expected.content_hash || recorded.revision !== expected.revision) {
      fail(`Story ${storyId} has a stale exact requirement binding for ${requirement.id}; create or revise the story from the current approved requirement.`);
    }
  }
  return {
    requirements,
    requirement_refs: v2.map(({ requirement }) => buildRequirementRef(
      requirement,
      toProjectPath(context, requirementPath(context, requirement.id)),
    )),
    requirement_profiles: v2.map(({ profile }) => profile),
    requirement_profile_refs: v2.map(({ profile }) => ({
      id: profile.id,
      path: toProjectPath(context, requirementAutonomyPath(context, profile.id)),
      hash: profile.profile_hash,
    })),
    autonomy_ceiling: levels.length > 0 ? mostRestrictiveAutonomyLevel(levels) : "supervised",
    has_v2_requirements: v2.length > 0,
  };
}

export function createContract(context, options) {
  ensureInitialized(context);
  const phase = requireOption(options, "phase");
  if (!context.config.phases[phase]) {
    fail(`Unknown phase '${phase}'. Valid phases: ${Object.keys(context.config.phases).join(", ")}`);
  }
  const storyId = options.story ? normalizeId(String(options.story)) : null;
  const deliveryProfileId = getOptionString(options, "delivery-profile")
    ? normalizeId(getOptionString(options, "delivery-profile"))
    : null;
  const id = normalizeId(
    options.id || (storyId ? `contract-${storyId}-${phase}` : `contract-${phase}-${shortDate()}`),
  );
  const contractPath = path.join(context.sdlcRoot, "contracts", `${id}.json`);
  let releaseDeliveryProfileLock = () => {};
  let releaseTaskStartBoundaryLock = () => {};
  let releaseStoryLock = () => {};
  let releaseContractLock;
  try {
    if (deliveryProfileId) {
      releaseDeliveryProfileLock = acquireFileLock(
        path.join(context.sdlcRoot, "contracts", `.delivery-profile-${shortHash(deliveryProfileId)}.lock`),
      );
    }
    if (storyId) {
      if (!storyDirectoryExistsBeforeLock(context, storyId)) {
        fail(`Story ${storyId} does not exist; create it before creating story contract ${id}.`);
      }
      releaseTaskStartBoundaryLock = acquireFileLock(path.join(
        context.sdlcRoot,
        "stories",
        storyId,
        "task-start-boundary.lock",
      ));
      releaseStoryLock = acquireFileLock(storyMutationLockPath(context, storyId));
    }
    releaseContractLock = acquireFileLock(`${contractPath}.lock`);
    return createContractLocked(context, options, {
      phase,
      storyId,
      deliveryProfileId,
      id,
      contractPath,
    });
  } finally {
    releaseContractLock?.();
    releaseStoryLock();
    releaseTaskStartBoundaryLock();
    releaseDeliveryProfileLock();
  }
}

export function validateStoryContractLinkForCreate(context, storyId, contractId, options = {}) {
  if (!storyId) {
    return null;
  }
  const story = readStory(context, storyId);
  if (!story) {
    fail(`Story ${storyId} does not exist; create the story before creating story contract ${contractId}.`);
  }
  const currentContractId = story.contract_id ? normalizeId(String(story.contract_id)) : null;
  const staleContractId = story.contract_review_required?.contract_id
    ? normalizeId(String(story.contract_review_required.contract_id))
    : null;
  if (
    story.contract_review_required
    && (contractId === staleContractId || contractId === currentContractId)
  ) {
    fail(
      [
        `Story ${storyId} acceptance criteria changed after contract ${staleContractId || currentContractId}.`,
        `Contract ID ${contractId} is historical and cannot be overwritten, even with --force.`,
        "Create a new exact contract ID and pass --replace-story-contract so the earlier reviewed record remains auditable.",
      ].join("\n"),
    );
  }
  if (currentContractId && currentContractId !== contractId && !options["replace-story-contract"]) {
    fail(
      [
        `Story ${storyId} already references contract ${currentContractId}.`,
        `Refusing to create story contract ${contractId} without updating the story link.`,
        "Use --replace-story-contract only for explicit contract renegotiation or recovery.",
      ].join("\n"),
    );
  }
  return {
    story_id: storyId,
    current_contract_id: currentContractId,
    should_link: currentContractId !== contractId,
    contract_review_required: story.contract_review_required || null,
  };
}

export function linkStoryToContractAfterCreate(context, storyLink, contract, contractPath) {
  if (!storyLink || (!storyLink.should_link && !storyLink.contract_review_required)) {
    return storyLink ? { status: "already_linked", story_id: storyLink.story_id, contract_id: contract.id } : null;
  }
  const storyPath = path.join(context.sdlcRoot, "stories", storyLink.story_id, "story.json");
  const storySnapshot = readStableRegularFileBuffer(storyPath, context.root);
  let story;
  try {
    story = JSON.parse(storySnapshot.content.toString("utf8"));
  } catch {
    fail(`Story ${storyLink.story_id} does not contain valid canonical JSON.`);
  }
  story.contract_id = contract.id;
  delete story.contract_review_required;
  story.updated_at = now();
  story.audit = {
    ...(story.audit || {}),
    updated_by: contract.audit?.updated_by || contract.audit?.created_by || null,
    git: contract.audit?.git || buildGitMetadata(context.root),
    run: contract.audit?.run || buildRunMetadata({}),
  };
  assertRecordSchema(story, "story.schema.json", `Story ${storyLink.story_id}`);
  const prospectiveStoryHash = hashApprovalSubject(story);
  const traceMutation = prepareGovernedTraceMutation(context, storyLink.story_id, {
    type: "decision",
    summary: storyLink.contract_review_required
      ? `Replaced the stale work brief for revised story ${storyLink.story_id} with contract ${contract.id}`
      : `Linked story ${storyLink.story_id} to contract ${contract.id}`,
    action: "contract.story-link",
    actor: contract.audit?.updated_by || contract.audit?.created_by || null,
    related: [storyLink.story_id, contract.id],
    git: contract.audit?.git,
    run: contract.audit?.run,
    request: {
      id: `contract-story-link:${storyLink.story_id}:${contract.id}:${prospectiveStoryHash}`,
      source: "contract.story-link",
      story_id: storyLink.story_id,
      previous_contract_id: storyLink.current_contract_id,
      contract_id: contract.id,
      prospective_story_hash: prospectiveStoryHash,
      replaced_stale_contract: Boolean(storyLink.contract_review_required),
    },
  });
  let trace;
  let storyWritten = false;
  try {
    writeJsonFile(storyPath, story, { force: true });
    storyWritten = true;
    refreshContractContextAfterStoryLink(context, contract, contractPath, storyPath);
    try {
      trace = traceMutation.commit();
    } catch (error) {
      trace = traceMutation.recoverCommitted();
      if (!trace) throw error;
    }
  } catch (error) {
    if (storyWritten && !trace) {
      try {
        writeTextFile(storyPath, storySnapshot.content.toString("utf8"), { force: true });
      } catch (rollbackError) {
        fail(
          `Story ${storyLink.story_id} contract-link transaction could not restore its exact prior bytes: `
          + `${rollbackError.message}. Original failure: ${error.message}`,
        );
      }
    }
    throw error;
  } finally {
    traceMutation.release();
  }
  return {
    status: storyLink.contract_review_required
      ? "review_refreshed"
      : storyLink.current_contract_id ? "replaced" : "linked",
    story_id: storyLink.story_id,
    previous_contract_id: storyLink.current_contract_id,
    contract_id: contract.id,
    story_path: storyPath,
    trace_event: trace,
  };
}

export function refreshContractContextAfterStoryLink(context, contract, contractPath, storyPath) {
  const storyProjectPath = toProjectPath(context, storyPath);
  const sources = contract.contextualization?.context_sources;
  if (!Array.isArray(sources) || !sources.some((source) => source.path === storyProjectPath)) {
    return;
  }
  const refreshed = buildContextSources(context, [storyProjectPath])[0];
  contract.contextualization.context_sources = sources.map((source) => (
    source.path === storyProjectPath ? refreshed : source
  ));
  contract.updated_at = now();
  writeJsonFile(contractPath, contract, { force: true });
}

export function validateContractReadinessForCreate(context, contract, options = {}) {
  if (options["allow-incomplete-contract"]) {
    return;
  }
  const gaps = collectContractReadinessGaps(context, contract);
  if (gaps.length === 0) {
    return;
  }
  const askTopics = normalizeListValue(context.config.contract_generation?.ask_when_missing, []);
  fail(
    [
      "Contract creation requires enough agreed input to guide the phase.",
      ...gaps.flatMap((gap) => [
        `- ${gap.summary}`,
        gap.question ? `  Exact clarification needed: ${gap.question}` : null,
      ]),
      "Ask the user for the missing information before creating the contract.",
      storyOutputResolveHint(contract),
      askTopics.length > 0 ? `Configured ask-when-missing topics: ${askTopics.join(", ")}.` : null,
      "Use --allow-incomplete-contract only to persist an explicit clarification, migration, or recovery draft; do not use it to start phase work.",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

export function collectContractReadinessGaps(context, contract) {
  const contextualization = contract.contextualization || {};
  const questions = Array.isArray(contextualization.questions) ? contextualization.questions : [];
  const openQuestions = questions.filter((question) => question.status !== "answered");
  const answeredQuestions = questions.filter((question) => question.status === "answered");
  const contextSources = Array.isArray(contextualization.context_sources) ? contextualization.context_sources : [];
  const capabilityRefs = Array.isArray(contract.capability_recommendation_refs) ? contract.capability_recommendation_refs : [];
  const hasContextAnchor =
    Boolean(String(contextualization.summary || "").trim()) ||
    contextSources.length > 0 ||
    answeredQuestions.length > 0 ||
    capabilityRefs.length > 0;
  const gaps = [];
  if (!hasContextAnchor) {
    gaps.push({
      code: "missing_context",
      summary: "missing project-specific context",
      question: "Which project files, facts, constraints, or prior decisions should guide this work?",
    });
  }
  if (openQuestions.length > 0) {
    const explainedQuestions = openQuestions.map((item) => explainOpenQuestion(context, item));
    gaps.push({
      code: "open_questions",
      summary: `${openQuestions.length} open question${openQuestions.length === 1 ? "" : "s"} must be answered or explicitly moved into a clarification draft`,
      question: explainedQuestions.map((item, index) => formatExplainedOpenQuestion(item, index + 1)).join("\n"),
      open_questions: explainedQuestions,
    });
  }
  gaps.push(...collectCapabilityPolicyReadinessGaps(contract));
  const capabilityReadiness = collectCapabilityBindingReadinessGaps(context, contract);
  gaps.push(...capabilityReadiness.gaps);
  for (const missing of collectMissingRequiredCapabilityBindings(contract, {
    bindings: capabilityReadiness.bindings,
  })) {
    gaps.push({
      code: "missing_capability_binding",
      summary: `required ${missing.type} capability '${missing.name}' has no concrete binding`,
      question:
        `Which concrete target and permissions should '${missing.name}' use? `
        + `Recreate the work brief with --capability-binding-json for the required ${missing.type} capability, `
        + `or record an explicit open contract question that names both '${missing.type}' and '${missing.name}' before approval.`,
      capability_type: missing.type,
      capability_name: missing.name,
    });
  }
  gaps.push(...collectOutputContractRefReadinessGaps(context, contract));
  return gaps;
}

export function collectContractDependencyFreshnessGaps(context, contract) {
  const gaps = [];
  const executionContext = contractExecutionContext(contract);
  const addGap = (code, summary, question) => {
    if (!gaps.some((gap) => gap.code === code && gap.summary === summary)) {
      gaps.push({ code, summary, question });
    }
  };

  for (const source of contract.contextualization?.context_sources || []) {
    const sourcePath = source?.path || source;
    if (!sourcePath) {
      addGap("invalid_context_source", "a context source has no path", "Refresh the work brief because one of its context sources is invalid.");
      continue;
    }
    try {
      const resolved = resolveProjectFilePath(context, sourcePath, { mustExist: false });
      let currentMatches = false;
      let safeSnapshot = false;
      let snapshotError = null;
      try {
        const snapshot = stableContextSourceSnapshot(context, resolved, "Contract context source");
        safeSnapshot = true;
        currentMatches = Boolean(source.sha256 && snapshot.sha256 === source.sha256);
      } catch (error) {
        snapshotError = error.message;
      }
      if (!currentMatches) {
        const evolution = source.sha256 && safeSnapshot && executionContext
          ? executionContextSourceEvolution(context, {
              ...executionContext,
              sourcePath,
              expectedSha256: source.sha256,
              bindingKind: "contract_context",
              bindingId: contract.id,
            })
          : { allowed: false };
        if (!evolution.allowed) {
          addGap(
            fs.existsSync(resolved) ? "stale_context_source" : "missing_context_source",
            snapshotError
              ? `context source ${sourcePath} is unsafe: ${snapshotError}`
              : `context source ${sourcePath} changed outside its approved pre-change snapshot`,
            snapshotError || executionContextRecoveryMessage(sourcePath),
          );
        }
      }
    } catch (error) {
      addGap("invalid_context_source", `context source ${sourcePath} is invalid`, `Refresh the work brief after correcting context source ${sourcePath}: ${error.message}`);
    }
  }

  const registry = readOutputRegistry(context, { missingOk: true });
  const templates = new Map((registry?.templates || []).map((template) => [template.id, template]));
  for (const ref of contract.output_contract_refs || []) {
    const template = templates.get(ref.template_id);
    if (!template) {
      addGap("missing_output_template", `output template ${ref.template_id} is missing`, `Create and review the required ${ref.artifact_type || "output"} format before refreshing the work brief.`);
      continue;
    }
    if (template.type !== ref.artifact_type || outputTemplateNeedsApproval(context, template)) {
      addGap("stale_output_template", `output template ${ref.template_id} is not approved for its current structure and delivery format`, `Review the current structure and canonical file format of ${ref.template_id}, then refresh the work brief.`);
    }
  }

  if ((contract.capability_recommendation_refs || []).length > 0) {
    const report = { strict: true, errors: [], warnings: [], checked: [] };
    validateContractCapabilityRecommendations(context, report, contract, `contract ${contract.id || "unknown"}`);
    for (const issue of [...report.errors, ...report.warnings]) {
      addGap("stale_capability_context", issue, "Refresh the capability evidence or tool recommendation, then refresh the work brief inside the approved scope.");
    }
  }

  return gaps;
}

export function validateContractAutonomyBinding(context, contract, options = {}) {
  const profileRefs = Array.isArray(contract.requirement_execution_profile_refs)
    ? contract.requirement_execution_profile_refs
    : [];
  for (const ref of profileRefs) {
    const profile = readRequirementAutonomyProfile(context, ref.id);
    if (profile.status !== "active" || profile.profile_hash !== ref.hash) {
      fail(`Contract ${contract.id} has a stale requirement autonomy profile reference ${ref.id}.`);
    }
    validateAutonomyApprovalRef(context, profile, `Requirement autonomy profile ${ref.id}`);
  }
  if (profileRefs.length === 0 || !["implementation", "validation", "release"].includes(contract.phase)) {
    return null;
  }
  if (!contract.delivery_execution_profile_id) {
    if (!["enforce_new_only", "enforce_all"].includes(context.config.autonomy_policy?.mode)) {
      return null;
    }
    fail(`Contract ${contract.id} requires an explicit delivery autonomy profile before approval.`);
  }
  const profile = readDeliveryAutonomyProfile(context, contract.delivery_execution_profile_id, {
    missingOk: options.requireDelivery === false,
  });
  if (!profile && options.requireDelivery === false) {
    return null;
  }
  const executionState = currentDeliveryExecutionState(context, profile);
  const historicalTerminal = executionState.lifecycle_status === "terminal";
  if (
    profile.status !== "active"
    || (effectiveDeliveryProfileStatus(context, profile).status !== "active" && !historicalTerminal)
  ) {
    fail(`Delivery autonomy profile ${profile.id} is not active for contract ${contract.id}.`);
  }
  validateAutonomyApprovalRef(context, profile, `Delivery autonomy profile ${profile.id}`);
  const ref = profile.contract_refs.find((item) => item.id === contract.id);
  if (!ref || ref.hash !== hashApprovalSubject(contract)) {
    fail(`Delivery autonomy profile ${profile.id} is stale for contract ${contract.id}.`);
  }
  const levelRank = AUTONOMY_LEVEL_RANK;
  const contractLevel = normalizeAutonomyLevel(contract.autonomy_level || "supervised");
  if (levelRank[profile.requested_level] > levelRank[contractLevel]) {
    fail(`Delivery autonomy ${profile.requested_level} exceeds contract boundary ${contractLevel}.`);
  }
  return profile;
}

export function approveContract(context, options) {
  ensureInitialized(context);
  const id = normalizeId(requireOption(options, "id"));
  const contractPath = path.join(context.sdlcRoot, "contracts", `${id}.json`);
  if (!pathEntryExistsNoFollow(contractPath)) {
    fail(`Contract ${id} does not exist`);
  }
  const attribution = buildAttribution(context, options, "contract.approve");
  const approvalStatus = normalizeApprovalStatus(options.status || "approved");
  const initialContract = readProjectJson(context, contractPath);
  let expectedStoryId = initialContract.story_id
    ? normalizeId(String(initialContract.story_id))
    : null;
  let result = null;
  for (let attempt = 0; attempt < 4 && !result; attempt += 1) {
    let releaseTaskStartBoundaryLock = () => {};
    let releaseStoryLock = () => {};
    let releaseContractLock = () => {};
    let retryWithStoryId = null;
    let shouldRetry = false;
    try {
      if (expectedStoryId) {
        releaseTaskStartBoundaryLock = acquireFileLock(path.join(
          context.sdlcRoot,
          "stories",
          expectedStoryId,
          "task-start-boundary.lock",
        ));
        releaseStoryLock = acquireFileLock(storyMutationLockPath(context, expectedStoryId));
      }
      releaseContractLock = acquireFileLock(`${contractPath}.lock`);
      const contractSnapshot = readStableRegularFileBuffer(contractPath, context.root);
      let contract;
      try {
        contract = JSON.parse(contractSnapshot.content.toString("utf8"));
      } catch {
        fail(`Contract ${id} does not contain valid canonical JSON.`);
      }
      const actualStoryId = contract.story_id
        ? normalizeId(String(contract.story_id))
        : null;
      if (actualStoryId !== expectedStoryId) {
        retryWithStoryId = actualStoryId;
        shouldRetry = true;
      } else {
        if (actualStoryId) {
          const taskStartPath = path.join(
            context.sdlcRoot,
            "stories",
            actualStoryId,
            "task-start.json",
          );
          if (pathEntryExistsNoFollow(taskStartPath)) {
            const replacement = inspectTaskStartReplacementBoundary(
              context,
              taskStartPath,
              {
                story_id: actualStoryId,
                contract_id: id,
                delivery_profile_id: contract.delivery_execution_profile_id || null,
              },
            );
            if (!replacement.allowed) {
              fail(
                `Contract ${id} cannot receive another approval or status change after story `
                + `${actualStoryId} has started (${replacement.reason}). `
                + "Only a different successor contract and delivery choice may be approved after the prior delivery is terminal.",
              );
            }
          }
        }
        if (approvalStatus === "approved") {
          const readinessGaps = collectContractReadinessGaps(context, contract);
          if (readinessGaps.length > 0) {
            fail(
              [
                `Contract ${id} cannot be approved because its work brief is incomplete.`,
                ...readinessGaps.flatMap((gap) => [
                  `- ${gap.summary}`,
                  gap.question ? `  Exact clarification needed: ${gap.question}` : null,
                ]),
                "Revise or recreate the contract with the missing agreed boundaries, then approve the new exact content.",
              ]
                .filter(Boolean)
                .join("\n"),
            );
          }
        }
        validateContractAutonomyBinding(context, contract, { requireDelivery: false });
        if (contract.human_gate === true) {
          requireFormalApprovalActor(context, options, attribution, "Approving a human-gated contract");
        }
        const directApprovalRequirements = contractDirectApprovalRequirements(contract);
        const approval = buildApprovalRecord(context, options, attribution, {
          subject: contract,
          subject_id_field: "contract_id",
          subject_id: id,
          artifact_types: contractArtifactTypes(contract),
          approval_boundaries: directApprovalRequirements,
          status: approvalStatus,
          scope: String(options.scope || "contract"),
          label: `contract ${id}`,
        });
        contract.approvals = Array.isArray(contract.approvals) ? contract.approvals : [];
        contract.approvals.push(approval);
        if (approval.status === "approved" && !options["preserve-status"]) {
          contract.status = "approved";
        } else if (["changes_requested", "rejected"].includes(approval.status) && !options["preserve-status"]) {
          contract.status = approval.status;
        }
        contract.updated_at = now();
        contract.audit = {
          ...(contract.audit || {}),
          updated_by: attribution.actor,
          git: attribution.git,
          run: attribution.run,
        };
        const approvedContractHash = hashApprovalSubject(contract);
        const traceMutation = prepareGovernedTraceMutation(context, actualStoryId, {
          type: "gate",
          summary: approval.summary || `Contract ${id} ${approval.status}`,
          action: "contract.approve",
          actor: attribution.actor,
          related: [id],
          git: attribution.git,
          run: attribution.run,
          request: {
            id: `contract-approve:${id}:${approval.id}:${approvedContractHash}`,
            source: "contract.approve",
            contract_id: id,
            approval_id: approval.id,
            approval_status: approval.status,
            approved_content_hash: approval.approved_content_hash || null,
            resulting_contract_hash: approvedContractHash,
          },
        });
        let trace;
        let contractWritten = false;
        try {
          writeJsonFile(contractPath, contract, { force: true });
          contractWritten = true;
          try {
            trace = traceMutation.commit();
          } catch (error) {
            trace = traceMutation.recoverCommitted();
            if (!trace) throw error;
          }
        } catch (error) {
          if (contractWritten && !trace) {
            try {
              writeTextFile(
                contractPath,
                contractSnapshot.content.toString("utf8"),
                { force: true },
              );
            } catch (rollbackError) {
              fail(
                `Contract ${id} approval transaction could not restore its exact prior bytes: `
                + `${rollbackError.message}. Original failure: ${error.message}`,
              );
            }
          }
          throw error;
        } finally {
          traceMutation.release();
        }
        result = { contract, approval, trace };
      }
    } finally {
      releaseContractLock();
      releaseStoryLock();
      releaseTaskStartBoundaryLock();
    }
    if (shouldRetry) {
      expectedStoryId = retryWithStoryId;
    }
  }
  if (!result) {
    fail(`Contract ${id} changed its story binding repeatedly while approval was being prepared; retry later.`);
  }
  output(
    options,
    {
      status: result.approval.status,
      contract_path: contractPath,
      approval: result.approval,
      contract: result.contract,
      trace_event: result.trace,
    },
    [`Recorded ${result.approval.status} approval for contract ${id}`],
  );
}

export function buildContract(context, phase, overrides = {}) {
  const template = context.config.phases[phase];
  if (!template) {
    fail(`Unknown phase '${phase}'`);
  }
  const project = readProjectSafe(context);
  const contextSources = buildContextSources(context, overrides.context_files || []);
  const questions = buildQuestionRecords(overrides.questions || [], overrides.qa || []);
  const attribution = buildAttribution(
    context,
    overrides.audit_options || {},
    overrides.audit_action || "contract.create",
  );
  return {
    id: overrides.id,
    schema_version: context.config.schema_version,
    sdlc_version: VERSION,
    project: project
      ? {
          project_id: project.project_id,
          project_name: project.project_name,
        }
      : null,
    phase,
    story_id: overrides.story_id || null,
    requirement_refs: overrides.requirement_refs || [],
    requirement_execution_profile_refs: overrides.requirement_execution_profile_refs || [],
    delivery_execution_profile_id: overrides.delivery_execution_profile_id || null,
    autonomy_level: overrides.autonomy_level || "supervised",
    status: overrides.status || "draft",
    purpose: template.purpose,
    owner_agent: String(overrides.owner_agent || template.owner_agent),
    inputs: mergeList(template.inputs, overrides.inputs),
    outputs: mergeList(template.outputs, overrides.outputs),
    output_contract_refs: buildOutputContractRefs(
      overrides.output_refs || [],
      configuredPhaseOrder(context),
    ),
    validation: mergeList(template.validation, overrides.validation),
    allowed_tools: mergeList(template.allowed_tools, overrides.allowed_tools),
    kb_writes: mergeList(template.kb_writes, overrides.kb_writes),
    human_gate: Boolean(template.human_gate),
    metrics: mergeList(template.metrics, overrides.metrics),
    execution_policy: buildExecutionPolicy(context, overrides),
    capability_policy: buildCapabilityPolicy(overrides.capability_policy),
    capability_bindings: normalizeCapabilityBindings(overrides.capability_bindings || []),
    capability_recommendation_refs: normalizeCapabilityRecommendationRefs(overrides.capability_recommendation_refs || []),
    contextualization: {
      summary: overrides.context_summary ? String(overrides.context_summary) : null,
      context_sources: contextSources,
      questions,
      constraints: [...(overrides.constraints || [])],
      assumptions: [...(overrides.assumptions || [])],
      open_questions: questions.filter((question) => question.status !== "answered").length,
    },
    approvals: [],
    created_at: now(),
    updated_at: now(),
    audit: {
      created_by: attribution.actor,
      updated_by: attribution.actor,
      git: attribution.git,
      run: attribution.run,
    },
  };
}

export function findStoryInFlightWorkTrace(context, storyId) {
  return readTraceEvents(context, storyId).find((event) =>
    ["implementation", "test", "release"].includes(String(event.type || "").toLowerCase())
    || ["output.link", "story.complete-step", "task.start.confirm"].includes(event.action));
}

export function assertStoryWorkspaceFilesAreRegular(context, storyDir) {
  for (const name of ["plan.md", "implementation-log.md"]) {
    const filePath = path.join(storyDir, name);
    if (!fs.existsSync(filePath)) {
      fail(`Story workspace is incomplete: ${toProjectPath(context, filePath)} is missing.`);
    }
    readStableRegularFileBuffer(filePath, context.root);
  }
}

export function createStory(context, options) {
  ensureInitialized(context);
  assertStoryCommandOptions(
    options,
    "story create",
    ["id", "title", "requirement", "acceptance", "phase", "status"],
  );
  const id = normalizeId(requireOption(options, "id"));
  const title = requireOption(options, "title");
  const storyDir = path.join(context.sdlcRoot, "stories", id);
  const storyPath = path.join(storyDir, "story.json");
  const releaseStoryLock = acquireFileLock(storyMutationLockPath(context, id));
  try {
    if (fs.existsSync(storyPath)) {
      fail(
        `Story ${id} already exists and story create cannot rewrite it. `
        + `To add missing success criteria, use 'story acceptance add --id ${id} --acceptance <criterion>'.`,
      );
    }
    if (fs.existsSync(storyDir) && safeReadDir(storyDir).length > 0) {
      fail(
        `Story workspace ${toProjectPath(context, storyDir)} exists without story.json. `
        + "Refusing to overwrite orphaned plan, log, claim, step, or output files; recover or archive that workspace explicitly.",
      );
    }
    const phase = String(options.phase || "design");
    if (!context.config.phases[phase]) {
      fail(`Unknown phase '${phase}'. Valid phases: ${Object.keys(context.config.phases).join(", ")}`);
    }
    const status = normalizeStoryStatus(options.status || "draft");
    if (!["draft", "ready"].includes(status)) {
      fail("A new story may start only as draft or ready; lifecycle status changes require the governed workflow.");
    }
    const storyPlanTemplate = readTemplateFile(context, "story-plan.md");
    const implementationLogTemplate = readTemplateFile(context, "implementation-log.md");
    const acceptanceCriteria = normalizeListOption(options.acceptance);
    if (status === "ready" && acceptanceCriteria.length === 0) {
      fail("A ready story requires at least one observable --acceptance criterion.");
    }
    const requirementIds = normalizeListOption(options.requirement).map(normalizeId);
    const requirementRefs = [];
    const requirementLevels = [];
    for (const requirementId of requirementIds) {
      const requirement = readRequirement(context, requirementId, { missingOk: true });
      if (!requirement) {
        if (context.config.autonomy_policy?.mode === "enforce_all") {
          fail(`Requirement ${requirementId} does not exist; agree and persist the requirement before creating story ${id}.`);
        }
        requirementLevels.push("supervised");
        continue;
      }
      const ready = assertRequirementReadyForDownstream(context, requirement, `Requirement ${requirementId}`);
      requirementLevels.push(ready.autonomy_level);
      if (!ready.legacy) {
        requirementRefs.push(buildRequirementRef(
          requirement,
          toProjectPath(context, requirementPath(context, requirementId)),
        ));
      }
    }
    const attribution = buildAttribution(context, options, "story.create");
    const createdAt = now();
    const story = {
      id,
      title,
      schema_version: context.config.schema_version,
      status,
      phase,
      contract_id: null,
      work_breakdown_id: null,
      acceptance: acceptanceCriteria,
      acceptance_criteria: acceptanceCriteria,
      requirement_refs: requirementRefs,
      autonomy_ceiling: requirementLevels.length > 0
        ? mostRestrictiveAutonomyLevel(requirementLevels)
        : "supervised",
      links: {
        requirements: requirementIds,
        decisions: [],
        tests: [],
      },
      created_at: createdAt,
      updated_at: createdAt,
      audit: {
        created_by: attribution.actor,
        updated_by: attribution.actor,
        git: attribution.git,
        run: attribution.run,
      },
    };

    ensureDir(storyDir);
    writeJsonFile(storyPath, story);
    writeTextFile(
      path.join(storyDir, "plan.md"),
      renderTemplate(storyPlanTemplate, { STORY_ID: id }),
    );
    writeTextFile(
      path.join(storyDir, "implementation-log.md"),
      renderTemplate(implementationLogTemplate, { STORY_ID: id, CREATED_AT: createdAt }),
    );

    const guidance = storyCreationGuidance(options, story);
    output(
      options,
      {
        status: "created",
        story_path: storyDir,
        story,
        human_guidance: guidance,
      },
      humanGuidanceLines(
        guidance,
        [
          `Created story workspace ${id}`,
          `Path: ${path.relative(context.root, storyDir)}`,
          ...(acceptanceCriteria.length === 0
            ? [
                `Required before contract setup: agentic-sdlc story acceptance add --id ${id} --acceptance <criterion>`,
              ]
            : []),
        ],
        options,
      ),
    );
  } finally {
    releaseStoryLock();
  }
}

export function addStoryAcceptance(context, options) {
  ensureInitialized(context);
  assertStoryCommandOptions(
    options,
    "story acceptance add",
    ["id", "acceptance", "summary"],
  );
  const id = normalizeId(requireOption(options, "id"));
  const additions = normalizeListOption(options.acceptance);
  if (additions.length === 0) {
    fail("story acceptance add requires at least one --acceptance <criterion>.");
  }
  const storyDir = path.join(context.sdlcRoot, "stories", id);
  const storyPath = path.join(storyDir, "story.json");
  // The record itself is checked again under the story lock below; before the
  // lock only the directory is touched, for the reason given at
  // storyDirectoryExistsBeforeLock.
  if (!storyDirectoryExistsBeforeLock(context, id)) {
    fail(`Story ${id} does not exist; create it before adding acceptance criteria.`);
  }
  const releaseTaskStartBoundaryLock = acquireFileLock(
    path.join(storyDir, "task-start-boundary.lock"),
  );
  let releaseStoryLock = () => {};
  let releaseLifecycleLock = () => {};
  let releaseClaimLock = () => {};
  try {
    releaseStoryLock = acquireFileLock(storyMutationLockPath(context, id));
    if (!pathEntryExistsNoFollow(storyPath)) {
      fail(`Story ${id} does not exist; create it before adding acceptance criteria.`);
    }
    releaseLifecycleLock = acquireFileLock(
      storyLifecycleCertificationLockPath(context, id),
    );
    releaseClaimLock = acquireFileLock(path.join(storyDir, "claim.lock"));
    const storySnapshot = readStableRegularFileBuffer(storyPath, context.root);
    assertStoryWorkspaceFilesAreRegular(context, storyDir);
    let story;
    try {
      story = normalizeStoryRecord(JSON.parse(storySnapshot.content.toString("utf8")));
    } catch {
      fail(`Story workspace ${id} does not contain valid canonical story JSON.`);
    }
    if (!story || story.id !== id) {
      fail(`Story workspace ${id} does not contain a matching canonical story record.`);
    }
    const taskStartPath = path.join(storyDir, "task-start.json");
    if (pathEntryExistsNoFollow(taskStartPath)) {
      readStableRegularFileBuffer(taskStartPath, context.root);
      fail(
        `Story ${id} already has a task-start receipt. `
        + "Revise and re-approve the governed work before starting; acceptance criteria cannot change in-flight.",
      );
    }
    const lifecycle = effectiveStoryLifecycleProjection(context, story);
    if (lifecycle.blocked) {
      fail(
        `Story ${id} lifecycle is blocked (${lifecycle.source}); `
        + "repair its governed workflow evidence before changing acceptance criteria.",
      );
    }
    if (TERMINAL_STORY_STATUSES.has(String(story.status || "").toLowerCase()) || lifecycle.terminal) {
      fail(
        `Story ${id} is terminal (${lifecycle.source || story.status}); `
        + "its acceptance criteria are immutable.",
      );
    }
    const workflowProbe = { errors: [] };
    const selectedWorkflow = currentStoryBoundWorkflowInstance(context, id, workflowProbe);
    if (workflowProbe.errors.length > 0) {
      fail(
        `Story ${id} workflow state cannot be verified before acceptance recovery: `
        + `${workflowProbe.errors.join("; ")}.`,
      );
    }
    if (selectedWorkflow) {
      const workflowEvents = readWorkflowEvents(context, selectedWorkflow.entry);
      if (workflowEvents.length > 0) {
        fail(
          `Story ${id} already has ${workflowEvents.length} governed workflow transition(s); `
          + "acceptance criteria cannot change in-flight.",
        );
      }
    }
    const completedSteps = readStoryStepRecords(context, id)
      .filter((record) => record.status === "completed");
    if (completedSteps.length > 0) {
      fail(
        `Story ${id} already has completed lifecycle work `
        + `(${completedSteps.map((record) => record.phase || record.step).filter(Boolean).join(", ")}); `
        + "acceptance criteria cannot change in-flight.",
      );
    }
    const legacyWorkTrace = findStoryInFlightWorkTrace(context, id);
    if (legacyWorkTrace) {
      fail(
        `Story ${id} already has governed work trace ${legacyWorkTrace.id || legacyWorkTrace.action} `
        + `(${legacyWorkTrace.action || legacyWorkTrace.type}); acceptance criteria cannot change in-flight.`,
      );
    }
    const claim = readStoryClaim(context, id);
    if (claim?.status === "active") {
      fail(
        `Story ${id} has an active claim by ${claim.agent || "an unknown agent"}; `
        + "release the claim before revising its pre-start acceptance criteria.",
      );
    }
    const boundProfiles = storyBoundDeliveryProfiles(context, id);
    const startedDeliveryProfileIds = boundProfiles
      .filter((profile) => pathEntryExistsNoFollow(deliveryStartReceiptPath(context, profile.id)))
      .map((profile) => profile.id)
      .sort();
    if (startedDeliveryProfileIds.length > 0) {
      fail(
        `Story ${id} already has delivery-start evidence for `
        + `${startedDeliveryProfileIds.join(", ")}; acceptance criteria cannot change in-flight.`,
      );
    }
    const previousCriteria = storyAcceptanceCriteria(story);
    const nextCriteria = mergeList(previousCriteria, additions);
    const addedCriteria = nextCriteria.filter((criterion) => !previousCriteria.includes(criterion));
    if (addedCriteria.length === 0) {
      const currentHash = hashApprovalSubject(story);
      const deliveryProfileIds = storyDeliveryProfileReviewIds(context, id, currentHash);
      const contractReviewRequired = Boolean(story.contract_review_required);
      const previousContractId = story.contract_review_required?.contract_id || story.contract_id || null;
      const guidance = storyAcceptanceRecoveryGuidance(options, id, {
        changed: false,
        contractReviewRequired,
        previousContractId,
        deliveryProfileIds,
      });
      output(
        options,
        {
          status: "unchanged",
          story_path: storyPath,
          story,
          added_acceptance_criteria: [],
          current_story_hash: currentHash,
          downstream_review_required: contractReviewRequired || deliveryProfileIds.length > 0,
          contract_review_required: contractReviewRequired,
          previous_contract_id: previousContractId,
          delivery_profile_ids: deliveryProfileIds,
          human_guidance: guidance,
        },
        humanGuidanceLines(
          guidance,
          [`Story ${id} already contains every supplied acceptance criterion; no file was rewritten.`],
          options,
        ),
      );
      return;
    }
    const attribution = buildAttribution(context, options, "story.acceptance.add");
    const previousHash = hashApprovalSubject(story);
    const changedAt = now();
    const priorContractReview = story.contract_review_required
      && typeof story.contract_review_required === "object"
      ? story.contract_review_required
      : null;
    const previousContractId = priorContractReview?.contract_id || story.contract_id || null;
    const contractReview = previousContractId
      ? {
          schema_version: "story-contract-review:v1",
          reason: "acceptance_criteria_changed",
          contract_id: previousContractId,
          previous_story_hash: priorContractReview?.previous_story_hash || previousHash,
          added_acceptance_criteria: mergeList(
            priorContractReview?.added_acceptance_criteria || [],
            addedCriteria,
          ),
          changed_at: changedAt,
        }
      : null;
    const updatedStory = {
      ...story,
      acceptance: nextCriteria,
      acceptance_criteria: nextCriteria,
      ...(contractReview ? { contract_review_required: contractReview } : {}),
      updated_at: changedAt,
      audit: {
        ...(story.audit || {}),
        created_by: story.audit?.created_by || attribution.actor,
        updated_by: attribution.actor,
        git: attribution.git,
        run: attribution.run,
      },
    };
    assertRecordSchema(updatedStory, "story.schema.json", `Story ${id}`);
    const currentHash = hashApprovalSubject(updatedStory);
    const deliveryProfileIds = storyDeliveryProfileReviewIds(context, id, currentHash);
    const traceMutation = prepareGovernedTraceMutation(context, id, {
      type: "decision",
      summary: getOptionString(options, "summary")
        || `Added ${addedCriteria.length} acceptance criterion/criteria to story ${id}`,
      action: "story.acceptance.add",
      actor: attribution.actor,
      related: [id, previousContractId, ...deliveryProfileIds].filter(Boolean),
      git: attribution.git,
      run: attribution.run,
      request: {
        id: `story-acceptance-add:${id}:${currentHash}`,
        summary: "Add observable acceptance criteria without rebinding governed story state.",
        source: "story.acceptance.add",
        previous_story_hash: previousHash,
        current_story_hash: currentHash,
        added_acceptance_criteria: addedCriteria,
        contract_review_required: Boolean(contractReview),
        previous_contract_id: previousContractId,
        downstream_delivery_profiles_requiring_review: deliveryProfileIds,
      },
    });
    let trace;
    let storyWritten = false;
    try {
      const concurrentWorkTrace = findStoryInFlightWorkTrace(context, id);
      if (concurrentWorkTrace) {
        fail(
          `Story ${id} acquired governed work trace `
          + `${concurrentWorkTrace.id || concurrentWorkTrace.action} `
          + `(${concurrentWorkTrace.action || concurrentWorkTrace.type}) while acceptance recovery was waiting; `
          + "acceptance criteria cannot change in-flight.",
        );
      }
      writeJsonFile(storyPath, updatedStory, { force: true });
      storyWritten = true;
      try {
        trace = traceMutation.commit();
      } catch (error) {
        trace = traceMutation.recoverCommitted();
        if (!trace) throw error;
      }
    } catch (error) {
      if (storyWritten && !trace) {
        try {
          writeTextFile(storyPath, storySnapshot.content.toString("utf8"), { force: true });
        } catch {
          fail(
            `Story ${id} acceptance transaction could not restore its exact pre-change bytes. `
            + `Recover ${toProjectPath(context, storyPath)} from the recorded previous hash ${previousHash} before retrying.`,
          );
        }
      }
      throw error;
    } finally {
      traceMutation.release();
    }
    const guidance = storyAcceptanceRecoveryGuidance(options, id, {
      changed: true,
      contractReviewRequired: Boolean(contractReview),
      previousContractId,
      deliveryProfileIds,
    });
    output(
      options,
      {
        status: "updated",
        story_path: storyPath,
        story: updatedStory,
        previous_story_hash: previousHash,
        current_story_hash: currentHash,
        added_acceptance_criteria: addedCriteria,
        downstream_review_required: Boolean(contractReview) || deliveryProfileIds.length > 0,
        contract_review_required: Boolean(contractReview),
        previous_contract_id: previousContractId,
        delivery_profile_ids: deliveryProfileIds,
        trace_event: trace,
        human_guidance: guidance,
      },
      humanGuidanceLines(
        guidance,
        [
          `Added ${addedCriteria.length} acceptance criterion/criteria to story ${id}.`,
          "Exact requirement references, contract history, breakdown, phase, status, audit origin, plan, and implementation log were preserved.",
          ...(contractReview
            ? [`Contract ${previousContractId} remains historical but is marked for mandatory replacement and approval.`]
            : []),
          ...(deliveryProfileIds.length > 0
            ? [
                `Stale delivery profile(s): ${deliveryProfileIds.join(", ")}.`,
                "Use a new delivery-profile ID after the new contract is approved.",
              ]
            : []),
        ],
        options,
      ),
    );
  } finally {
    releaseClaimLock();
    releaseLifecycleLock();
    releaseStoryLock();
    releaseTaskStartBoundaryLock();
  }
}

export function showBreakdownPolicy(context, options) {
  ensureInitialized(context);
  const policy = readEffectiveBreakdownPolicy(context);
  output(options, policy, [
    `Delivery unit: ${policy.delivery_unit}`,
    `Strict gate unit: ${policy.strict_gate_unit}`,
    `Levels: ${policy.levels.join(", ")}`,
    `Claimable units: ${policy.claimable_units.join(", ")}`,
  ]);
}

export function setBreakdownPolicy(context, options) {
  ensureInitialized(context);
  ensurePlanningDirectories(context);
  const current = readEffectiveBreakdownPolicy(context);
  const policy = {
    ...current,
    levels: options.levels ? normalizeListOption(options.levels).map((item) => normalizeWorkItemType(item, { allowStory: true })) : current.levels,
    default_flow: options["default-flow"] ? normalizeListOption(options["default-flow"]) : current.default_flow,
    delivery_unit: options["delivery-unit"]
      ? normalizeWorkItemType(options["delivery-unit"], { allowStory: true })
      : current.delivery_unit,
    strict_gate_unit: options["strict-gate-unit"]
      ? normalizeWorkItemType(options["strict-gate-unit"], { allowStory: true })
      : current.strict_gate_unit,
    task_gate: options["task-gate"] ? String(options["task-gate"]) : current.task_gate,
  };
  validateWorkBreakdownPolicy(policy);
  const attribution = buildAttribution(context, options, "breakdown.policy.set");
  const record = {
    schema_version: context.config.schema_version,
    policy,
    updated_at: now(),
    audit: {
      updated_by: attribution.actor,
      git: attribution.git,
      run: attribution.run,
    },
  };
  const policyPath = path.join(workBreakdownRoot(context), "project-policy.json");
  writeJsonFile(policyPath, record, { force: true });
  output(options, { status: "updated", policy_path: policyPath, policy }, [`Updated breakdown policy at ${toProjectPath(context, policyPath)}`]);
}

export function proposeBreakdown(context, options) {
  ensureInitialized(context);
  ensurePlanningDirectories(context);
  const id = normalizeId(requireOption(options, "id"));
  if (id === "project-policy") {
    fail("breakdown id 'project-policy' is reserved");
  }
  const requirementId = normalizeId(requireOption(options, "requirement"));
  assertRequirementReadyForDownstream(
    context,
    readRequirement(context, requirementId, { missingOk: true }),
    `Requirement ${requirementId}`,
  );
  const items = normalizeRawListOption(options.item).map(parseBreakdownItemRef);
  if (items.length === 0) {
    fail("breakdown propose requires at least one --item type:id.");
  }
  const attribution = buildAttribution(context, options, "breakdown.propose");
  const breakdown = {
    id,
    schema_version: context.config.schema_version,
    status: "proposed",
    requirement_id: requirementId,
    items,
    rationale: getOptionString(options, "rationale") || null,
    approvals: [],
    created_at: now(),
    updated_at: now(),
    audit: {
      created_by: attribution.actor,
      updated_by: attribution.actor,
      git: attribution.git,
      run: attribution.run,
    },
  };
  assertRecordSchema(breakdown, "work-breakdown.schema.json", `Work breakdown ${id}`);
  const breakdownPath = breakdownPathById(context, id);
  const releaseLock = acquireFileLock(`${breakdownPath}.lock`);
  try {
    writeJsonFile(breakdownPath, breakdown, { force: Boolean(options.force), forceOption: true });
  } finally {
    releaseLock();
  }
  output(options, { status: "proposed", breakdown_path: breakdownPath, breakdown }, [`Proposed breakdown ${id}`]);
}

export function approveBreakdown(context, options) {
  ensureInitialized(context);
  const id = normalizeId(requireOption(options, "id"));
  const breakdownPath = breakdownPathById(context, id);
  if (!fs.existsSync(breakdownPath)) {
    fail(`Breakdown ${id} does not exist`);
  }
  const attribution = buildAttribution(context, options, "breakdown.approve");
  requireFormalApprovalActor(context, options, attribution, "Approving a work breakdown");
  let breakdown;
  let approval;
  const releaseLock = acquireFileLock(`${breakdownPath}.lock`);
  try {
    breakdown = readProjectJson(context, breakdownPath);
    approval = buildApprovalRecord(context, options, attribution, {
      subject: breakdown,
      subject_id_field: "breakdown_id",
      subject_id: id,
      scope: options.scope || "work-breakdown",
      label: `breakdown ${id}`,
    });
    breakdown.status = "approved";
    breakdown.approvals = Array.isArray(breakdown.approvals) ? breakdown.approvals : [];
    breakdown.approvals.push(approval);
    breakdown.updated_at = now();
    breakdown.audit = {
      ...(breakdown.audit || {}),
      updated_by: attribution.actor,
      git: attribution.git,
      run: attribution.run,
    };
    writeJsonFile(breakdownPath, breakdown, { force: true });
  } finally {
    releaseLock();
  }
  output(options, { status: "approved", breakdown_path: breakdownPath, approval, breakdown }, [`Approved breakdown ${id}`]);
}

export function proposeDependencyGraph(context, options) {
  ensureInitialized(context);
  ensurePlanningDirectories(context);
  const id = normalizeId(requireOption(options, "id"));
  if (id === "graph") {
    fail("dependency id 'graph' is reserved");
  }
  const requirementId = options.requirement ? normalizeId(String(options.requirement)) : null;
  const edges = normalizeRawListOption(options.edge).map(parseDependencyEdge);
  if (edges.length === 0) {
    fail("dependency propose requires at least one --edge from:to:type:blocks:required_state.");
  }
  const attribution = buildAttribution(context, options, "dependency.propose");
  const proposal = {
    id,
    schema_version: context.config.schema_version,
    status: "proposed",
    requirement_id: requirementId,
    edges,
    rationale: getOptionString(options, "rationale") || null,
    approvals: [],
    created_at: now(),
    updated_at: now(),
    audit: {
      created_by: attribution.actor,
      updated_by: attribution.actor,
      git: attribution.git,
      run: attribution.run,
    },
  };
  const proposalPath = dependencyProposalPath(context, id);
  const releaseLock = acquireFileLock(path.join(dependenciesRoot(context), "graph.lock"));
  try {
    writeJsonFile(proposalPath, proposal, { force: Boolean(options.force), forceOption: true });
  } finally {
    releaseLock();
  }
  output(options, { status: "proposed", dependency_path: proposalPath, dependency: proposal }, [`Proposed dependency graph ${id}`]);
}

export function approveDependencyGraph(context, options) {
  ensureInitialized(context);
  const id = normalizeId(requireOption(options, "id"));
  const proposalPath = dependencyProposalPath(context, id);
  if (!fs.existsSync(proposalPath)) {
    fail(`Dependency proposal ${id} does not exist`);
  }
  const attribution = buildAttribution(context, options, "dependency.approve");
  requireFormalApprovalActor(context, options, attribution, "Approving dependency graph changes");
  let proposal;
  let graph;
  let approval;
  const releaseLock = acquireFileLock(path.join(dependenciesRoot(context), "graph.lock"));
  try {
    proposal = readProjectJson(context, proposalPath);
    approval = buildApprovalRecord(context, options, attribution, {
      subject: proposal,
      subject_id_field: "dependency_id",
      subject_id: id,
      scope: options.scope || "dependency-graph",
      label: `dependency ${id}`,
    });
    proposal.status = "approved";
    proposal.approvals = Array.isArray(proposal.approvals) ? proposal.approvals : [];
    proposal.approvals.push(approval);
    proposal.updated_at = now();
    proposal.audit = {
      ...(proposal.audit || {}),
      updated_by: attribution.actor,
      git: attribution.git,
      run: attribution.run,
    };

    graph = readDependencyGraph(context, { missingOk: true });
    for (const edge of proposal.edges || []) {
      upsertDependencyEdge(graph, {
        ...edge,
        proposal_id: id,
        requirement_id: proposal.requirement_id || null,
        rationale: proposal.rationale || null,
        approved_at: now(),
        approved_by: attribution.actor,
      });
    }
    graph.updated_at = now();
    graph.audit = {
      ...(graph.audit || {}),
      updated_by: attribution.actor,
      git: attribution.git,
      run: attribution.run,
    };
    // Write the canonical graph first. A retry is idempotent because edges are upserted.
    writeJsonFile(dependencyGraphPath(context), graph, { force: true });
    writeJsonFile(proposalPath, proposal, { force: true });
  } finally {
    releaseLock();
  }
  output(options, { status: "approved", dependency_path: proposalPath, graph_path: dependencyGraphPath(context), approval, dependency: proposal, graph }, [`Approved dependency graph ${id}`]);
}

export function showStoryDependencies(context, options) {
  showDependencyStatus(context, { ...options, story: requireOption(options, "id") });
}

export function ensureBaselineDirectory(context) {
  ensureDir(baselineRoot(context));
}

export function readBaselines(context) {
  return safeReadDir(baselineRoot(context))
    .filter((name) => name.endsWith(".json"))
    .map((name) => readProjectJson(context, path.join(baselineRoot(context), name)))
    .sort((a, b) => {
      const createdComparison = String(a.created_at || "").localeCompare(String(b.created_at || ""));
      return createdComparison || String(a.id).localeCompare(String(b.id));
    });
}

export function normalizeBaselineSourcePaths(context, rawPaths) {
  for (const rawPath of rawPaths) {
    const resolved = resolveProjectFilePath(context, rawPath, { mustExist: true });
    assertContextSourcePathSafe(context, resolved, "Baseline source");
  }
  const discovery = discoverBaselineSourcePaths({
    projectRoot: context.root,
    requestedPaths: rawPaths,
    policy: context.config.baseline_policy,
  });
  if (discovery.truncated) {
    fail(
      `Baseline source discovery reached its ${discovery.policy.max_discovered_files}-file limit. `
      + "Narrow --source or raise baseline_policy.max_discovered_files explicitly; no silent partial baseline was created.",
    );
  }
  return discovery.paths;
}

export function validateBaselineSourceHashes(context, baseline, label, options = {}) {
  const issues = [];
  const sourceHashes = baseline.source_hashes || {};
  const sourcePaths = new Set([...(baseline.source_paths || []), ...Object.keys(sourceHashes)]);
  for (const sourcePath of sourcePaths) {
    const expectedHash = sourceHashes[sourcePath];
    if (!expectedHash) {
      issues.push(`${label} source ${sourcePath} has no recorded hash`);
    } else {
      let currentMatches = false;
      let safeSnapshot = false;
      let snapshotError = null;
      try {
        const snapshot = stableContextSourceSnapshot(context, sourcePath, "Baseline source");
        safeSnapshot = true;
        currentMatches = snapshot.sha256 === expectedHash;
      } catch (error) {
        snapshotError = error.message;
      }
      if (currentMatches) continue;
      const evolution = safeSnapshot && options.executionContext
        ? executionContextSourceEvolution(context, {
            ...options.executionContext,
            sourcePath,
            expectedSha256: expectedHash,
            bindingKind: "baseline",
            bindingId: baseline.id,
          })
        : { allowed: false };
      if (!evolution.allowed) {
        issues.push(
          snapshotError
            ? `${label} source ${sourcePath} is unsafe: ${snapshotError}`
            : `${label} source ${sourcePath} is missing or changed outside its approved pre-change snapshot. `
              + executionContextRecoveryMessage(sourcePath),
        );
      }
    }
  }
  if (options.failOnStale && issues.length > 0) {
    fail(issues.join("; "));
  }
  if (options.collectOnly) {
    return issues;
  }
  return issues;
}

export function readEffectiveBreakdownPolicy(context) {
  const configured = context.config.work_breakdown_policy || {};
  const defaults = {
    levels: ["requirement", "epic", "story", "task"],
    default_flow: ["requirement", "story"],
    optional_levels: ["epic", "task"],
    delivery_unit: "story",
    claimable_units: ["story", "task"],
    strict_gate_unit: "story",
    task_gate: "light",
  };
  const policyPath = path.join(workBreakdownRoot(context), "project-policy.json");
  const projectPolicy = fs.existsSync(policyPath) ? readProjectJson(context, policyPath).policy || {} : {};
  const policy = {
    ...defaults,
    ...configured,
    ...projectPolicy,
  };
  policy.levels = normalizeListValue(policy.levels, defaults.levels).map((item) => normalizeWorkItemType(item, { allowStory: true }));
  policy.default_flow = normalizeListValue(policy.default_flow, defaults.default_flow);
  policy.optional_levels = normalizeListValue(policy.optional_levels, defaults.optional_levels);
  policy.claimable_units = normalizeListValue(policy.claimable_units, defaults.claimable_units).map((item) => normalizeWorkItemType(item, { allowStory: true }));
  policy.delivery_unit = normalizeWorkItemType(policy.delivery_unit || defaults.delivery_unit, { allowStory: true });
  policy.strict_gate_unit = normalizeWorkItemType(policy.strict_gate_unit || defaults.strict_gate_unit, { allowStory: true });
  policy.task_gate = String(policy.task_gate || defaults.task_gate);
  return policy;
}

export function readBreakdowns(context) {
  const root = workBreakdownRoot(context);
  return safeReadDir(root)
    .filter((name) => name.endsWith(".json") && name !== "project-policy.json")
    .map((name) => readProjectJson(context, path.join(root, name)));
}

export function readDependencyGraph(context, options = {}) {
  const graphPath = dependencyGraphPath(context);
  if (!fs.existsSync(graphPath)) {
    if (!options.missingOk) {
      fail("Missing .sdlc/dependencies/graph.json. Run dependency approve first.");
    }
    return {
      schema_version: context.config.schema_version,
      status: "approved",
      edges: [],
      updated_at: null,
      audit: {},
    };
  }
  const graph = readProjectJson(context, graphPath);
  graph.edges = Array.isArray(graph.edges) ? graph.edges : [];
  return graph;
}

// Returns the closed lifecycle of a superseded or cancelled story, else null.
function dependencyStoryClosure(context, storyId, query = null) {
  const cached = query?.lifecycle_by_story?.get(storyId);
  if (cached) return cached.closed ? cached : null;
  const story = query?.stories_by_id?.get(storyId) || readStory(context, storyId);
  if (!story) return null;
  const projection = storyClosureLifecycleProjection(
    context,
    story,
    String(story.status || "unknown").toLowerCase(),
    String(story.phase || "unknown").toLowerCase(),
  );
  return projection?.closed ? projection : null;
}

// Follows superseded stories to the story that replaced them. A story closed
// without a replacement can never satisfy a dependency.
export function resolveDependencyUpstream(context, storyId, query = null) {
  const chain = [storyId];
  let current = storyId;
  while (chain.length <= 32) {
    const lifecycle = dependencyStoryClosure(context, current, query);
    if (!lifecycle) return { story_id: current, chain, closed_without_replacement: false };
    const next = lifecycle.status === "superseded" ? lifecycle.closure?.replacement_id : null;
    if (!next || chain.includes(next)) break;
    chain.push(next);
    current = next;
  }
  return { story_id: current, chain, closed_without_replacement: true };
}

export function isDependencyEdgeInactive(context, edge, query = null) {
  return dependencyStoryClosure(context, edge.from, query) !== null;
}

export function inspectDependencyEdge(context, edge, story = null, query = null) {
  const dependent = dependencyStoryClosure(context, edge.from, query);
  if (dependent) {
    return {
      blocking: false,
      satisfied: true,
      inactive: true,
      message: `${edge.from} is ${dependent.status}; its dependency on ${edge.to} no longer applies`,
    };
  }
  const blocking = isHardDependencyEdge(edge)
    && shouldDependencyBlockStory(context, edge, story);
  const upstream = resolveDependencyUpstream(context, edge.to, query);
  if (upstream.closed_without_replacement) {
    return {
      blocking,
      satisfied: false,
      message: `${edge.from} depends on ${edge.to}, which was closed without a replacement `
        + `(${edge.type}, ${edge.blocks}); revise the dependency or close ${edge.from}`,
    };
  }
  if (upstream.story_id === edge.from) {
    return {
      blocking: false,
      satisfied: true,
      message: `${edge.from} depends on ${edge.to}, which ${edge.from} superseded`,
    };
  }
  const replaced = upstream.story_id !== edge.to;
  const effectiveEdge = replaced ? { ...edge, to: upstream.story_id } : edge;
  const satisfied = isDependencySatisfied(context, effectiveEdge, query);
  const message = `${edge.from} depends on ${edge.to}`
    + `${replaced ? ` (superseded by ${upstream.story_id})` : ""}`
    + ` (${edge.type}, ${edge.blocks}, requires ${edge.required_state})`;
  if (!satisfied) {
    return { blocking, satisfied, message };
  }
  const stale = dependencyUpstreamArtifactChanged(context, effectiveEdge, query);
  if (stale && !hasDependencyRevalidationTrace(context, edge.from, effectiveEdge, stale.since, query)) {
    return {
      blocking,
      satisfied: false,
      message: `${edge.from} requires revalidation because upstream artifact ${stale.artifact_path} changed after linking`,
    };
  }
  return { blocking: false, satisfied: true, message };
}

export function storyPhaseRank(context, story) {
  const lifecycle = effectiveStoryLifecycleProjection(context, story);
  const value = String(lifecycle.phase || lifecycle.status || "").toLowerCase();
  return phaseRank(value);
}

export function isDependencySatisfied(context, edge, query = null) {
  const upstream = query?.stories_by_id?.get(edge.to) || readStory(context, edge.to);
  if (!upstream) {
    return false;
  }
  const lifecycle = query?.lifecycle_by_story?.get(edge.to)
    || effectiveStoryLifecycleProjection(context, upstream);
  const effectiveStatus = lifecycle.status;
  const effectivePhase = lifecycle.phase;
  const state = String(edge.required_state || "").toLowerCase();
  if (lifecycle.blocked && isHardDependencyEdge(edge)) {
    return false;
  }
  if (edge.type === "requires_contract" || state === "contract_approved") {
    let contractState = query?.contract_state_by_story?.get(upstream.id);
    if (!contractState) {
      contractState = inspectStoryContract(context, upstream);
      query?.contract_state_by_story?.set(upstream.id, contractState);
    }
    return contractState.exists && contractState.approved;
  }
  if (edge.type === "requires_artifact" || state === "artifact_linked") {
    return storyHasOutputLink(context, edge.to, query);
  }
  if (["exists", "none"].includes(state)) {
    return true;
  }
  if (lifecycle.blocked) {
    return false;
  }
  if (state === "ready") {
    return ["ready", "implementation", "in_progress", "review", "validation", "release", "done"]
      .includes(String(effectiveStatus));
  }
  if (state === "validated") {
    return ["validation", "release", "done"].includes(String(effectiveStatus))
      || effectivePhase === "validation"
      || effectivePhase === "release";
  }
  if (state === "done") {
    return lifecycle.terminal;
  }
  return effectiveStatus === state || effectivePhase === state;
}

export function dependencyUpstreamArtifactChanged(context, edge, query = null) {
  if (!["requires_artifact", "blocks"].includes(edge.type)) {
    return null;
  }
  const registry = query?.registry || readOutputRegistry(context, { missingOk: true });
  const links = query?.registry_index
    ? query.registry_index.links_by_story.get(edge.to) || []
    : (registry?.links || []).filter((link) => link.story_id === edge.to);
  for (const link of links) {
    if (!link.artifact_path || !link.fingerprints?.artifact_sha256) {
      continue;
    }
    const artifactPath = resolveProjectFilePath(context, link.artifact_path, { mustExist: false });
    const currentHash = fs.existsSync(artifactPath) ? hashFile(artifactPath) : null;
    if (currentHash && currentHash !== link.fingerprints.artifact_sha256) {
      return {
        artifact_path: link.artifact_path,
        since: link.updated_at || link.created_at || null,
      };
    }
  }
  return null;
}

export function hasDependencyRevalidationTrace(context, storyId, edge, since, query = null) {
  const sinceTime = since ? Date.parse(since) : 0;
  const events = query?.traces_by_story?.get(storyId) || readTraceEvents(context, storyId);
  return events.some((event) => {
    const eventTime = Date.parse(String(event.created_at || ""));
    return (
      event.action === "dependency.revalidate" &&
      (!Number.isFinite(sinceTime) || !Number.isFinite(eventTime) || eventTime >= sinceTime) &&
      Array.isArray(event.related) &&
      event.related.includes(edge.to)
    );
  });
}

export function buildDependencyQuery(context, { stories = [], traceEvents = [], session = null } = {}) {
  const graph = readDependencyGraph(context, { missingOk: true });
  const edgesByStory = new Map();
  for (const edge of graph.edges || []) {
    for (const storyId of new Set([edge.from, edge.to])) {
      if (!storyId) continue;
      const edges = edgesByStory.get(storyId) || [];
      edges.push(edge);
      edgesByStory.set(storyId, edges);
    }
  }
  const tracesByStory = new Map();
  for (const event of traceEvents) {
    if (!event.story_id) continue;
    const events = tracesByStory.get(event.story_id) || [];
    events.push(event);
    tracesByStory.set(event.story_id, events);
  }
  const registry = readOutputRegistry(context, { missingOk: true });
  const lifecycleByStory = new Map(
    stories
      .filter((story) => story?.id && story.__folder_id === story.id)
      .map((story) => [story.id, effectiveStoryLifecycleProjection(context, story)]),
  );
  return {
    graph,
    edges_by_story: edgesByStory,
    // Edges owned by superseded or cancelled stories no longer take part in cycles.
    cycles: findBlockingDependencyCycles((graph.edges || [])
      .filter((edge) => !lifecycleByStory.get(edge.from)?.closed)),
    stories_by_id: new Map(
      stories
        .filter((story) => story?.id && story.__folder_id === story.id)
        .map((story) => [story.id, story]),
    ),
    lifecycle_by_story: lifecycleByStory,
    traces_by_story: tracesByStory,
    registry,
    registry_index: createOutputRegistryQueryIndex(registry),
    contract_state_by_story: new Map(),
    session,
  };
}

export function claimStory(context, options) {
  ensureInitialized(context);
  const id = normalizeId(requireOption(options, "id"));
  const agent = requireOption(options, "agent");
  const claimedAt = now();
  const expiresAt = options["expires-at"]
    ? normalizeOptionalDateTime(options["expires-at"], "expires-at")
    : defaultClaimExpiration(context, claimedAt);
  const storyDir = path.join(context.sdlcRoot, "stories", id);
  if (!fs.existsSync(path.join(storyDir, "story.json"))) {
    fail(`Story ${id} does not exist. Create it with 'story create' first.`);
  }

  const claimPath = path.join(storyDir, "claim.json");
  const releaseTaskStartBoundaryLock = acquireFileLock(
    path.join(storyDir, "task-start-boundary.lock"),
  );
  let releaseLifecycleLock = () => {};
  let releaseClaimLock = () => {};
  let claim;
  let traceEvent;
  const attribution = buildAttribution(context, options, "story.claim");
  try {
    releaseLifecycleLock = acquireFileLock(
      storyLifecycleCertificationLockPath(context, id),
    );
    releaseClaimLock = acquireFileLock(path.join(storyDir, "claim.lock"));
    const story = readStory(context, id);
    if (storyAcceptanceCriteria(story).length === 0) {
      fail(
        `Story ${id} has no observable acceptance criteria and cannot be claimed. `
        + `Add one with 'story acceptance add --id ${id} --acceptance <criterion>' first.`,
        {
          en: {
            result: "This work item cannot be assigned yet because it has no observable success criterion.",
            impact: "No assignment was created and work remains paused.",
            required_decision: "State at least one verifiable result that will show when this work is complete.",
            protection_boundary: "Existing files, agreements, delivery choices, and remote systems remain unchanged.",
            next_action: "Add the observable criterion, then retry the assignment.",
            details: {},
          },
          it: {
            result: "Questa attività non può ancora essere assegnata perché non ha un criterio di successo osservabile.",
            impact: "Non è stata creata alcuna assegnazione e il lavoro resta fermo.",
            required_decision: "Indica almeno un risultato verificabile che dimostri quando l’attività è completa.",
            protection_boundary: "File, accordi, scelte di consegna e sistemi remoti restano invariati.",
            next_action: "Aggiungi il criterio osservabile, poi riprova l’assegnazione.",
            details: {},
          },
        },
      );
    }
    if (story.contract_review_required) {
      fail(
        `Story ${id} acceptance criteria changed after its previous contract and it cannot be claimed. `
        + "Create and approve a new exact contract with --replace-story-contract, run task start, then retry story claim.",
        {
          en: {
            result: "This work item cannot be assigned because its success criteria changed after the previous agreement.",
            impact: "No assignment was created and the previous agreement cannot authorize the revised work.",
            required_decision: "Review the revised criteria and approve a new work agreement before starting.",
            protection_boundary: "Existing files, historical agreements, delivery choices, and remote systems remain unchanged.",
            next_action: "Prepare and approve the new agreement, start the revised work, then retry the assignment.",
            details: {},
          },
          it: {
            result: "Questa attività non può essere assegnata perché i criteri di successo sono cambiati dopo l’accordo precedente.",
            impact: "Non è stata creata alcuna assegnazione e l’accordo precedente non può autorizzare il lavoro aggiornato.",
            required_decision: "Rivedi i criteri aggiornati e approva un nuovo accordo di lavoro prima dell’avvio.",
            protection_boundary: "File, accordi storici, scelte di consegna e sistemi remoti restano invariati.",
            next_action: "Prepara e approva il nuovo accordo, avvia il lavoro aggiornato, poi riprova l’assegnazione.",
            details: {},
          },
        },
      );
    }
    const lifecycle = effectiveStoryLifecycleProjection(context, story);
    if (lifecycle.blocked) {
      fail(
        `Story ${id} has an invalid or unreadable final lifecycle receipt and cannot be claimed. `
        + "Inspect the bound workflow and restore valid certification evidence first.",
      );
    }
    if (lifecycle.terminal) {
      fail(`Story ${id} is in terminal status '${lifecycle.status}' and cannot be claimed.`);
    }
    const contractState = inspectStoryContract(context, story);
    const taskStartIssues = contractState.exists && contractState.approved
      ? validateTaskStartReceipt(context, id, contractState.contract)
      : [contractState.message || "the current work agreement is not approved"];
    if (!contractState.exists || !contractState.approved || taskStartIssues.length > 0) {
      fail(
        [
          `Story ${id} cannot be claimed before its current approved contract and immutable task start are valid.`,
          ...taskStartIssues.map((issue) => `- ${issue}`),
          `Run task start --story ${id} --confirm-start for the current approved contract, then retry story claim.`,
        ].join("\n"),
        {
          en: {
            result: "This work item cannot be assigned because its current work agreement has not been validly started.",
            impact: "No assignment was created and no phase work may begin.",
            required_decision: "Confirm the exact current work agreement and start only that agreed work.",
            protection_boundary: "Existing files, agreements, delivery choices, and remote systems remain unchanged.",
            next_action: "Complete the governed task start, then retry the assignment.",
            details: {},
          },
          it: {
            result: "Questa attività non può essere assegnata perché l’accordo di lavoro corrente non è stato avviato validamente.",
            impact: "Non è stata creata alcuna assegnazione e nessuna fase di lavoro può iniziare.",
            required_decision: "Conferma l’accordo di lavoro corrente e avvia soltanto il lavoro concordato.",
            protection_boundary: "File, accordi, scelte di consegna e sistemi remoti restano invariati.",
            next_action: "Completa l’avvio governato, poi riprova l’assegnazione.",
            details: {},
          },
        },
      );
    }
    const claimExists = pathEntryExistsNoFollow(claimPath);
    const priorClaimSnapshot = claimExists
      ? readStableRegularFileBuffer(claimPath, context.root)
      : null;
    if (claimExists && !options.force) {
      const existing = readProjectJson(context, claimPath);
      if (existing.status === "active") {
        fail(`Story ${id} already has an active claim by ${existing.agent}. Release it first or use --force after coordination.`);
      }
    }
    if (claimExists && options.force) {
      const existing = readProjectJson(context, claimPath);
      if (existing.status === "active") {
        requireCoordinationOverrideActor(attribution, `Force-claiming active story ${id}`);
      }
    }
    const checkpoint = consumeStoryActionCheckpoint(
      context,
      id,
      "story.claim",
      options,
    );
    claim = {
      story_id: id,
      agent: String(agent),
      branch: String(options.branch || defaultStoryBranch(context, id)),
      status: "active",
      claimed_at: claimedAt,
      expires_at: expiresAt,
      notes: options.notes ? String(options.notes) : null,
      ...(checkpoint || {}),
      audit: {
        claimed_by: attribution.actor,
        git: attribution.git,
        run: attribution.run,
      },
    };
    let traceMutation;
    let claimWritten = false;
    try {
      assertRecordSchema(claim, "claim.schema.json", `Claim for story ${id}`);
      writeJsonFile(claimPath, claim, { force: Boolean(options.force || claimExists), forceOption: true });
      claimWritten = true;
      traceMutation = prepareGovernedTraceMutation(context, id, {
        type: "claim",
        summary: `Story ${id} claimed by ${agent}`,
        action: "story.claim",
        actor: attribution.actor,
        evidence: [
          toProjectPath(context, claimPath),
          claim.authorization_use_ref,
          claim.checkpoint_profile_ref?.path,
        ].filter(Boolean),
        related: [id],
        git: attribution.git,
        run: attribution.run,
      });
      try {
        traceEvent = traceMutation.commit();
      } catch (error) {
        traceEvent = traceMutation.recoverCommitted();
        if (!traceEvent) throw error;
      }
    } catch (error) {
      if (claimWritten && !traceEvent) {
        try {
          if (priorClaimSnapshot) {
            writeTextFile(
              claimPath,
              priorClaimSnapshot.content.toString("utf8"),
              { force: true },
            );
          } else if (pathEntryExistsNoFollow(claimPath)) {
            removePathGoverned(claimPath, { force: true });
          }
        } catch (rollbackError) {
          fail(
            `Story ${id} claim transaction could not restore its exact prior state `
            + `(${rollbackError.message}). Original failure: ${error.message}`,
          );
        }
      }
      throw error;
    } finally {
      traceMutation?.release();
    }
  } finally {
    releaseClaimLock();
    releaseLifecycleLock();
    releaseTaskStartBoundaryLock();
  }
  output(
    options,
    { status: "claimed", claim_path: claimPath, claim, trace_event: traceEvent },
    [`Claimed story ${id} for ${agent}`],
  );
}

export function createStoryHandoff(context, options) {
  const result = createStoryHandoffRecord(context, options);
  output(options, result, [`Created handoff ${result.handoff.id}`]);
}

export function createStoryHandoffRecord(context, options) {
  ensureInitialized(context);
  const storyId = normalizeId(requireOption(options, "id"));
  const storyPath = path.join(context.sdlcRoot, "stories", storyId, "story.json");
  if (!fs.existsSync(storyPath)) {
    fail(`Story ${storyId} does not exist`);
  }
  const toAgent = requireOption(options, "to-agent");
  const attribution = buildAttribution(context, options, "story.handoff");
  const handoffId = normalizeId(String(options["handoff-id"] || `HND-${storyId}-${uniqueRecordSuffix()}`));
  const handoffPath = path.join(context.sdlcRoot, "handoffs", `${handoffId}.json`);
  const handoff = {
    id: handoffId,
    story_id: storyId,
    from_actor: attribution.actor,
    to_agent: String(toAgent),
    status: normalizeHandoffStatus(options.status || "open"),
    summary: options.summary ? String(options.summary) : null,
    required_artifacts: normalizeListOption(options.artifact).map(normalizeProjectPathInput),
    open_items: normalizeListOption(options["open-item"]),
    created_at: now(),
    audit: {
      created_by: attribution.actor,
      git: attribution.git,
      run: attribution.run,
    },
  };
  assertRecordSchema(handoff, "handoff.schema.json", `Handoff ${handoffId}`);
  writeJsonFile(handoffPath, handoff, { force: Boolean(options.force), forceOption: true });
  appendTraceEvent(context, storyId, {
    type: "handoff",
    summary: handoff.summary || `Story ${storyId} handed off to ${toAgent}`,
    action: "story.handoff",
    actor: attribution.actor,
    evidence: [toProjectPath(context, handoffPath)],
    related: [storyId, handoffId],
    git: attribution.git,
    run: attribution.run,
  });
  return { status: "created", handoff_path: handoffPath, handoff };
}

export function completeStoryStep(context, options) {
  ensureInitialized(context);
  const storyId = normalizeId(requireOption(options, "id"));
  if (!readStory(context, storyId)) {
    fail(`Story ${storyId} does not exist`);
  }
  const releaseTaskStartBoundaryLock = acquireFileLock(
    path.join(context.sdlcRoot, "stories", storyId, "task-start-boundary.lock"),
  );
  let releaseLifecycleLock = () => {};
  try {
    releaseLifecycleLock = acquireFileLock(
      storyLifecycleCertificationLockPath(context, storyId),
    );
    const story = readStory(context, storyId);
    if (!story) {
      fail(`Story ${storyId} does not exist`);
    }
    const lifecycle = effectiveStoryLifecycleProjection(context, story);
    if (lifecycle.terminal) {
      fail(
        `Story ${storyId} lifecycle is already certified `
        + `(${lifecycle.source}); its completed steps cannot be changed.`,
      );
    }
    assertReleaseClaimPrecondition(context, storyId, options);
    const step = normalizeStoryStep(context, requireOption(options, "step"));
    const stepPhase = storyStepPhase(context, step);
    const summary = getOptionString(options, "summary") || null;
    const outputTypes = normalizeListOption(options.type).map(normalizeArtifactType);
    const contract = validateApprovedStoryContractForPhaseOutput(
      context,
      story,
      "story.complete-step",
      outputTypes.map((artifactType) => ({
        artifact_type: artifactType,
        phase: stepPhase,
      })),
      options,
    );
    const phaseOutputRefs = (contract?.output_contract_refs || [])
      .filter((ref) => ref.phase === stepPhase);
    for (const ref of phaseOutputRefs) {
      if (!outputTypes.includes(ref.artifact_type)) {
        fail(
          `Story ${storyId} ${stepPhase} step requires --type ${ref.artifact_type} `
          + `because approved contract ${contract.id} assigns that output to this phase.`,
        );
      }
    }
    const artifactEvidence = buildCanonicalEvidence(context, normalizeListOption(options.artifact), "Story step artifact");
    const extraEvidence = buildCanonicalEvidence(context, normalizeListOption(options.evidence), "Story step evidence");
    if (!summary && outputTypes.length === 0 && artifactEvidence.length === 0 && extraEvidence.length === 0) {
      fail("Complete-step requires --summary, --type, --artifact, or --evidence.");
    }

    const registry = readOutputRegistry(context, { missingOk: true });
    const outputLinks = collectStoryOutputLinksForStep(
      context,
      registry,
      storyId,
      outputTypes,
    ).filter((link) =>
      !contract
      || (contract.output_contract_refs || []).some((ref) =>
        ref.artifact_type === link.artifact_type
        && ref.template_id === link.template_id
        && ref.mode === link.mode
        && (!ref.phase || ref.phase === stepPhase)));
    if (outputTypes.length > 0) {
      const linkedTypes = new Set(outputLinks.map((link) => link.artifact_type));
      for (const artifactType of outputTypes) {
        if (!linkedTypes.has(artifactType)) {
          fail(
            `Story ${storyId} has no linked ${artifactType} output. Run output resolve/link before completing this step.`,
          );
        }
      }
    }
    for (const ref of phaseOutputRefs) {
      const exactLinks = outputLinks.filter((link) =>
        link.artifact_type === ref.artifact_type
        && link.template_id === ref.template_id
        && link.mode === ref.mode);
      if (exactLinks.length !== 1) {
        fail(
          `Story ${storyId} ${stepPhase} step requires one exact linked output `
          + `${ref.artifact_type}:${ref.template_id}:${ref.mode}; found ${exactLinks.length}.`,
        );
      }
    }
    if (["validation", "release"].includes(step)) {
      if (artifactEvidence.length === 0 && extraEvidence.length === 0 && outputLinks.length === 0) {
        fail(`${step} completion requires --artifact, --evidence, or a linked output; a summary alone is not release evidence.`);
      }
      const requiredTraceType = step === "validation" ? "test" : "release";
      const acceptableOutcomes = step === "validation" ? ["passed"] : ["ready", "passed"];
      const supportingTrace = latestTraceEvent(readTraceEvents(context, storyId), requiredTraceType);
      if (!supportingTrace || !acceptableOutcomes.includes(supportingTrace.outcome)) {
        fail(
          `${step} completion requires the latest ${requiredTraceType} trace to have outcome `
          + `${acceptableOutcomes.join(" or ")}.`,
        );
      }
    }

    const checkpoint = consumeStoryActionCheckpoint(
      context,
      storyId,
      "story.complete-step",
      options,
      { artifact_types: outputTypes, step },
    );
    const attribution = buildAttribution(context, options, "story.complete-step");
    const stepDir = path.join(context.sdlcRoot, "stories", storyId, "steps");
    const stepPath = path.join(stepDir, `${step}.json`);
    const historyPath = path.join(stepDir, "history.jsonl");
    const stepDirectoryExisted = pathEntryExistsNoFollow(stepDir);
    const relativeStepPath = toProjectPath(context, stepPath);
    const record = {
      id: normalizeId(String(options["completion-id"] || `STEP-${storyId}-${step}-${uniqueRecordSuffix()}`)),
      story_id: storyId,
      step,
      status: "completed",
      phase: stepPhase,
      summary,
      output_types: outputTypes,
      output_links: outputLinks.map((link) => ({
        id: link.id,
        artifact_type: link.artifact_type,
        artifact_path: link.artifact_path,
        template_id: link.template_id,
        mode: link.mode,
        base_artifact: link.base_artifact || null,
        requirements: Array.isArray(link.requirements) ? link.requirements : [],
      })),
      artifacts: artifactEvidence,
      evidence: extraEvidence,
      next_step: options["next-step"]
        ? normalizeStoryStep(context, options["next-step"])
        : defaultNextStoryStep(context, step),
      completed_at: now(),
      ...(checkpoint || {}),
      audit: {
        completed_by: attribution.actor,
        git: attribution.git,
        run: attribution.run,
      },
    };
    const priorStepSnapshot = pathEntryExistsNoFollow(stepPath)
      ? readStableRegularFileBuffer(stepPath, context.root)
      : null;
    const priorHistorySnapshot = pathEntryExistsNoFollow(historyPath)
      ? readStableRegularFileBuffer(historyPath, context.root)
      : null;
    let stepWritten = false;
    let historyWritten = false;
    let traceMutation;
    let traceEvent;
    try {
      writeJsonFile(stepPath, record, { force: true });
      stepWritten = true;
      const stepSnapshot = readStableRegularFileBuffer(stepPath, context.root);
      const storyStepRef = {
        schema_version: "story-step-completion-ref:v1",
        story_id: storyId,
        step,
        phase: stepPhase,
        path: relativeStepPath,
        record_id: record.id,
        completed_at: record.completed_at,
        sha256: stepSnapshot.sha256,
        hash_algorithm: "sha256:file:v1",
      };
      appendJsonLine(historyPath, record);
      historyWritten = true;
      traceMutation = prepareGovernedTraceMutation(context, storyId, {
        type: "gate",
        summary: summary || `Completed ${step} for ${storyId}`,
        action: "story.complete-step",
        actor: attribution.actor,
        evidence: Array.from(new Set([
          relativeStepPath,
          ...record.artifacts.map((item) => item.path),
          ...record.evidence.map((item) => item.path),
          ...record.output_links.map((item) => item.artifact_path).filter(Boolean),
          record.authorization_use_ref,
          record.checkpoint_profile_ref?.path,
        ].filter(Boolean))),
        related: [storyId, step, ...record.output_links.map((item) => item.id)],
        story_step_ref: storyStepRef,
        git: attribution.git,
        run: attribution.run,
      });
      try {
        traceEvent = traceMutation.commit();
      } catch (error) {
        traceEvent = traceMutation.recoverCommitted();
        if (!traceEvent) throw error;
      }
    } catch (error) {
      if (!traceEvent) {
        const rollbackFailures = [];
        const restore = (label, filePath, snapshot, written) => {
          if (!written) return;
          try {
            if (snapshot) {
              writeTextFile(filePath, snapshot.content.toString("utf8"), { force: true });
            } else if (pathEntryExistsNoFollow(filePath)) {
              removePathGoverned(filePath, { force: true });
            }
          } catch (rollbackError) {
            rollbackFailures.push(`${label}: ${rollbackError.message}`);
          }
        };
        restore("story step history", historyPath, priorHistorySnapshot, historyWritten);
        restore("story step record", stepPath, priorStepSnapshot, stepWritten);
        if (
          !stepDirectoryExisted
          && pathEntryExistsNoFollow(stepDir)
          && fs.readdirSync(stepDir).length === 0
        ) {
          try {
            removeEmptyDirectoryGoverned(stepDir);
          } catch (rollbackError) {
            rollbackFailures.push(`story step directory: ${rollbackError.message}`);
          }
        }
        if (rollbackFailures.length > 0) {
          fail(
            `Story ${storyId} step transaction could not restore exact prior state `
            + `(${rollbackFailures.join("; ")}). Original failure: ${error.message}`,
          );
        }
      }
      throw error;
    } finally {
      traceMutation?.release();
    }

    const release = options["release-claim"]
      ? releaseStoryClaimRecord(context, {
          ...options,
          id: storyId,
          status: "released",
          reason: getOptionString(options, "reason") || `Completed ${step}; story prepared for handoff`,
        }, { boundaryAndLifecycleLocked: true })
      : null;

    output(
      options,
      { status: "completed", step_path: stepPath, step: record, trace_event: traceEvent, release },
      [
        `Completed ${step} for story ${storyId}`,
        `Step record: ${relativeStepPath}`,
        release ? `Released claim for story ${storyId}` : null,
      ].filter(Boolean),
    );
  } finally {
    releaseLifecycleLock();
    releaseTaskStartBoundaryLock();
  }
}

export function prepareStoryHandoff(context, options) {
  ensureInitialized(context);
  const storyId = normalizeId(requireOption(options, "id"));
  if (!readStory(context, storyId)) {
    fail(`Story ${storyId} does not exist`);
  }
  assertReleaseClaimPrecondition(context, storyId, options);
  requireOption(options, "to-agent");
  const handoffId = normalizeId(String(options["handoff-id"] || `HND-${storyId}-${uniqueRecordSuffix()}`));
  const packagePath = path.join(context.sdlcRoot, "stories", storyId, "handoffs", `${handoffId}-package.json`);
  const handoffPackage = buildStoryHandoffPackage(context, storyId, handoffId, options);
  writeJsonFile(packagePath, handoffPackage, { force: Boolean(options.force), forceOption: true });

  const existingArtifacts = normalizeListOption(options.artifact);
  const handoffOptions = {
    ...options,
    id: storyId,
    "handoff-id": handoffId,
    artifact: [...existingArtifacts, toProjectPath(context, packagePath)],
  };
  const handoff = createStoryHandoffRecord(context, handoffOptions);
  const release = options["release-claim"]
    ? releaseStoryClaimRecord(context, {
        ...options,
        id: storyId,
        status: "released",
        reason: getOptionString(options, "reason") || `Prepared handoff ${handoffId}`,
      })
    : null;

  output(
    options,
    {
      status: "prepared",
      handoff_id: handoffId,
      package_path: packagePath,
      package: handoffPackage,
      handoff: handoff.handoff,
      release,
    },
    [
      `Prepared handoff ${handoffId} for story ${storyId}`,
      `Handoff package: ${toProjectPath(context, packagePath)}`,
      release ? `Released claim for story ${storyId}` : null,
    ].filter(Boolean),
  );
}

export function closeHandoff(context, options) {
  ensureInitialized(context);
  const handoffId = normalizeId(requireOption(options, "id"));
  const handoffPath = path.join(context.sdlcRoot, "handoffs", `${handoffId}.json`);
  if (!fs.existsSync(handoffPath)) {
    fail(`Handoff ${handoffId} does not exist`);
  }
  const handoff = readProjectJson(context, handoffPath);
  const status = normalizeHandoffCloseStatus(options.status || "closed");
  const attribution = buildAttribution(context, options, "handoff.close");
  handoff.status = status;
  handoff.closed_at = now();
  handoff.close_summary = getOptionString(options, "summary") || null;
  handoff.open_items = normalizeListOption(options["open-item"]);
  handoff.audit = {
    ...(handoff.audit || {}),
    closed_by: attribution.actor,
    git: attribution.git,
    run: attribution.run,
  };
  assertRecordSchema(handoff, "handoff.schema.json", `Handoff ${handoffId}`);
  writeJsonFile(handoffPath, handoff, { force: true });
  appendTraceEvent(context, handoff.story_id || null, {
    type: "handoff",
    summary: handoff.close_summary || `Handoff ${handoffId} ${status}`,
    action: "handoff.close",
    actor: attribution.actor,
    evidence: [toProjectPath(context, handoffPath)],
    related: [handoff.story_id, handoffId].filter(Boolean),
    git: attribution.git,
    run: attribution.run,
  });
  output(options, { status, handoff_path: handoffPath, handoff }, [`Handoff ${handoffId} ${status}`]);
}

export function appendTrace(context, options) {
  ensureInitialized(context);
  const type = String(requireOption(options, "type"));
  if (!TRACE_TYPES.has(type)) {
    fail(`Unknown trace type '${type}'. Valid types: ${Array.from(TRACE_TYPES).join(", ")}`);
  }
  const summary = requireOption(options, "summary");
  const storyId = options.story ? normalizeId(String(options.story)) : null;
  if (storyId && !readStory(context, storyId)) {
    fail(`Story ${storyId} does not exist`);
  }
  const releaseLifecycleLock = storyId && ["test", "release"].includes(type)
    ? acquireFileLock(storyLifecycleCertificationLockPath(context, storyId))
    : () => {};
  try {
    appendTraceLocked(context, options, type, summary, storyId);
  } finally {
    releaseLifecycleLock();
  }
}

export function appendOperationsPhaseGateChecks(context, report, storyId, story) {
  if (story?.phase !== "operations") return;
  const incidents = readIncidentRecords(context, storyId);
  const feedbackItems = readFeedbackRecords(context, storyId);
  report.checked.push(`${incidents.length} incident record(s) for story ${storyId}`);
  report.checked.push(`${feedbackItems.length} feedback record(s) for story ${storyId}`);
  if (incidents.length === 0 && feedbackItems.length === 0) {
    report.warnings.push(
      `Story ${storyId} is in the operations phase with no incident or feedback records yet.`,
    );
  }
}

export function secretScanStoryWritePaths(context, storyId) {
  const story = readStory(context, storyId);
  const requirementIds = Array.isArray(story?.links?.requirements) ? story.links.requirements.filter(Boolean) : [];
  const writePaths = new Set();
  for (const requirementId of requirementIds) {
    const requirement = readRequirement(context, requirementId, { missingOk: true });
    if (!requirement?.autonomy_profile_id) continue;
    let profile;
    try {
      profile = readRequirementAutonomyProfile(context, requirement.autonomy_profile_id);
    } catch {
      continue;
    }
    for (const writePath of profile.constraints?.allowed_write_paths || []) {
      writePaths.add(String(writePath));
    }
  }
  const files = [];
  for (const writePath of writePaths) {
    const base = writePath.replace(/\*+.*$/u, "").replace(/\/$/u, "");
    if (!base) continue;
    const resolved = resolveProjectFilePath(context, base, { mustExist: false });
    if (!fs.existsSync(resolved)) continue;
    if (fs.statSync(resolved).isDirectory()) files.push(...listProjectFilesUnder(context, resolved));
    else files.push(toProjectPath(context, resolved));
  }
  return files;
}

export function collectTraceQueryRecords(context, session = null) {
  return readAllTraceEvents(context, { session })
    .filter((event) => event.type !== "invalid")
    .map((event) => ({
      kind: "activity",
      id: event.id || `${event.source?.path}:${event.source?.line}`,
      summary: event.summary || event.action || event.type,
      created_at: event.created_at || null,
      updated_at: event.created_at || null,
      actor: event.actor || null,
      requested_by: event.requested_by || null,
      authorized_by: event.authorized_by || null,
      request: event.request || null,
      action: event.action || event.type || null,
      event_type: event.type || null,
      story_id: event.story_id || null,
      artifact_type: inferArtifactTypeFromTrace(event),
      requirements: [],
      phase: null,
      status: null,
      text: stableJson(event),
      sources: [event.source].filter(Boolean),
      raw: event,
    }));
}

export function collectStoryQueryRecords(context, registry = null, registryIndex = null, stories = null) {
  return (stories || readAllStories(context)).map((story) => {
    const storyLinks = registryIndex
      ? registryIndex.links_by_story.get(story.id) || []
      : (registry?.links || []).filter((link) => link.story_id === story.id);
    const storyOutputTypes = storyLinks
      .filter((link) => link.artifact_type)
      .map((link) => link.artifact_type);
    return {
      kind: "stories",
      id: story.id,
      summary: story.title || story.id,
      created_at: story.created_at || null,
      updated_at: story.updated_at || story.created_at || null,
      actor: story.audit?.created_by || story.audit?.updated_by || null,
      requested_by: null,
      authorized_by: null,
      request: null,
      action: "story.create",
      event_type: "story",
      story_id: story.id,
      artifact_type: storyOutputTypes[0] || inferStoryArtifactType(story),
      artifact_types: storyOutputTypes,
      requirements: Array.isArray(story.links?.requirements) ? story.links.requirements : [],
      phase: story.phase || null,
      status: story.status || null,
      text: stableJson(story),
      sources: [{ path: `.sdlc/stories/${story.id}/story.json`, line: 1 }],
      raw: story,
    };
  });
}

export function collectStoryStepQueryRecords(context, stories = null, session = null) {
  const records = [];
  for (const story of stories || readAllStories(context)) {
    for (const step of readStoryStepRecords(context, story.id, session)) {
      records.push({
        kind: "story_steps",
        id: step.id || `${story.id}:${step.step}`,
        summary: step.summary || `${story.id} ${step.step} completed`,
        created_at: step.completed_at || null,
        updated_at: step.completed_at || null,
        actor: step.audit?.completed_by || null,
        requested_by: null,
        authorized_by: null,
        request: null,
        action: "story.complete-step",
        event_type: "gate",
        story_id: story.id,
        artifact_type: Array.isArray(step.output_types) ? step.output_types[0] || null : null,
        artifact_types: Array.isArray(step.output_types) ? step.output_types : [],
        requirements: Array.isArray(story.links?.requirements) ? story.links.requirements : [],
        phase: step.phase || story.phase || null,
        status: step.status || null,
        text: stableJson(step),
        sources: [{ path: `.sdlc/stories/${story.id}/steps/${step.step}.json`, line: 1 }],
        raw: step,
      });
    }
  }
  return records;
}

export function collectContractQueryRecords(context, session = null) {
  return collectJsonFiles(context, path.join(context.sdlcRoot, "contracts"), session).map((contract) => ({
    kind: "contracts",
    id: contract.id || path.basename(contract.__path, ".json"),
    summary: `${contract.phase || "unknown"} contract ${contract.id || path.basename(contract.__path, ".json")}`,
    created_at: contract.created_at || null,
    updated_at: contract.updated_at || contract.created_at || null,
    actor: contract.audit?.created_by || contract.audit?.updated_by || null,
    requested_by: null,
    authorized_by: null,
    request: null,
    action: "contract.create",
    event_type: "contract",
    story_id: contract.story_id || null,
    artifact_type: Array.isArray(contract.output_contract_refs) ? contract.output_contract_refs[0]?.artifact_type || null : null,
    artifact_types: Array.isArray(contract.output_contract_refs) ? contract.output_contract_refs.map((ref) => ref.artifact_type).filter(Boolean) : [],
    requirements: [],
    phase: contract.phase || null,
    status: contract.status || null,
    text: stableJson(contract),
    sources: [{ path: contract.__relative_path, line: 1 }],
    raw: contract,
  }));
}

export function collectHandoffQueryRecords(context) {
  return readHandoffs(context).map((handoff) => ({
    kind: "handoffs",
    id: handoff.id,
    summary: handoff.summary || `Handoff ${handoff.id} to ${handoff.to_agent}`,
    created_at: handoff.created_at || null,
    updated_at: handoff.closed_at || handoff.created_at || null,
    actor: handoff.from_actor || handoff.audit?.created_by || null,
    requested_by: null,
    authorized_by: null,
    request: null,
    action: handoff.closed_at ? "handoff.close" : "story.handoff",
    event_type: "handoff",
    story_id: handoff.story_id || null,
    artifact_type: null,
    requirements: [],
    phase: null,
    status: handoff.status || null,
    text: stableJson(handoff),
    sources: [{ path: `.sdlc/handoffs/${handoff.id}.json`, line: 1 }],
    raw: handoff,
  }));
}

export function inferArtifactTypeFromTrace(event) {
  if (event.action === "output.link" && Array.isArray(event.related)) {
    return event.related.find((item) => String(item).includes("-analysis") || String(item).includes("summary")) || null;
  }
  return null;
}

export function readAllTraceEvents(context, options = {}) {
  const tracesRoot = path.join(context.sdlcRoot, "traces");
  const storyFilter = options.story ? normalizeId(options.story) : null;
  if (options.session) {
    return options.session.traceEvents({ storyId: storyFilter, includeInvalid: true }).map((event) => {
      if (event.type === "invalid") {
        return {
          type: "invalid",
          summary: event.error?.message || "Invalid canonical trace event",
          source: event.source,
        };
      }
      const sourceFile = event.source?.path
        ? path.basename(event.source.path.replaceAll("/", path.sep))
        : null;
      return {
        ...event,
        story_id: event.story_id || (sourceFile ? inferStoryIdFromTraceFile(sourceFile) : null),
      };
    });
  }
  const files = walkFiles(tracesRoot)
    .filter((filePath) => filePath.endsWith(".jsonl"))
    .filter((filePath) => !storyFilter || path.basename(filePath) === `${storyFilter}.jsonl`);
  const events = [];
  for (const filePath of files) {
    const sourcePath = toProjectPath(context, filePath);
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!line.trim()) {
        return;
      }
      try {
        const event = JSON.parse(line);
        events.push({
          ...event,
          story_id: event.story_id || inferStoryIdFromTraceFile(filePath),
          source: { path: sourcePath, line: index + 1 },
        });
      } catch (error) {
        events.push({
          type: "invalid",
          summary: error.message,
          source: { path: sourcePath, line: index + 1 },
        });
      }
    });
  }
  return events;
}

export function compactTraces(context, options) {
  ensureInitialized(context);
  const storyId = options.story ? normalizeId(options.story) : null;
  const beforeDate = options.before ? parseDateBoundary(options.before, "before") : null;
  const events = readAllTraceEvents(context, { story: storyId })
    .filter((event) => event.type !== "invalid")
    .filter((event) => !beforeDate || Date.parse(String(event.created_at || "")) < beforeDate.getTime())
    .sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
  const sourcePaths = Array.from(new Set(events.map((event) => event.source?.path).filter(Boolean))).sort();
  const id = normalizeId(`CMP-${storyId || "project"}-${uniqueRecordSuffix()}`);
  const compaction = {
    id,
    kind: "trace_compaction",
    schema_version: context.config.schema_version,
    story_id: storyId,
    generated_at: now(),
    cutoff_before: beforeDate ? beforeDate.toISOString() : null,
    canonical_source_retained: true,
    event_count: events.length,
    summary: summarizeActivityEvents(events),
    timeline: events.slice(-100).map((event) => ({
      id: event.id || null,
      created_at: event.created_at || null,
      story_id: event.story_id || null,
      type: event.type || null,
      action: event.action || null,
      summary: event.summary || null,
      actor: event.actor || null,
      sources: [event.source].filter(Boolean),
    })),
    source_paths: sourcePaths,
    source_hashes: buildSourceHashMap(context, sourcePaths),
    audit: {
      generated_by: buildAttribution(context, options, "trace.compact").actor,
      git: buildGitMetadata(context.root),
      run: buildRunMetadata(options),
    },
  };
  const outputPath = options.out
    ? resolveProjectFilePath(context, options.out, { mustExist: false })
    : path.join(context.sdlcRoot, "traces", "compactions", `${id}.json`);
  assertNotDerivedArtifact(context, outputPath, "Trace compaction");
  writeJsonFile(outputPath, compaction, { force: Boolean(options.force), forceOption: true });
  appendTraceEvent(context, storyId, {
    type: "decision",
    summary: `Compacted ${events.length} trace events into ${toProjectPath(context, outputPath)}`,
    action: "trace.compact",
    actor: compaction.audit.generated_by,
    evidence: [toProjectPath(context, outputPath)],
    related: [id, storyId].filter(Boolean),
    git: compaction.audit.git,
    run: compaction.audit.run,
  });
  output(
    options,
    { status: "compacted", compaction_path: outputPath, compaction },
    [`Compacted ${events.length} trace events into ${toProjectPath(context, outputPath)}`],
  );
}

export function traceIntegrityOptions(context, tracePath) {
  return {
    boundaryRoot: context.sdlcRoot,
    tracePath,
    dependencies: traceIntegrityGovernanceDependencies(tracePath),
  };
}

export function traceIntegrityGovernanceDependencies(tracePath) {
  const canonicalTracePath = fs.existsSync(tracePath)
    ? fs.realpathSync.native(tracePath)
    : path.join(fs.realpathSync.native(path.dirname(tracePath)), path.basename(tracePath));
  const checkpointPath = traceIntegrityCheckpointPath(canonicalTracePath);
  const lockPath = `${checkpointPath}.lock`;
  const descriptorMutations = new Map();

  const logicalPath = (candidate) => {
    const resolved = path.resolve(candidate);
    const checkpointDirectory = path.dirname(checkpointPath);
    const name = path.basename(resolved);
    const temporaryPrefix = `.${path.basename(checkpointPath)}.`;
    if (
      path.dirname(resolved) === checkpointDirectory
      && name.startsWith(temporaryPrefix)
      && name.endsWith(".tmp")
    ) {
      // Same-directory random temp names implement one exact checkpoint write;
      // they never widen the policy path beyond the canonical checkpoint.
      return checkpointPath;
    }
    return resolved;
  };
  const requestForOpen = (filePath, flags) => {
    const resolved = path.resolve(filePath);
    const mapped = logicalPath(resolved);
    if (resolved === lockPath) return { operation: "lock.acquire", path: lockPath };
    const append = typeof flags === "number" && (flags & fs.constants.O_APPEND) !== 0;
    if (append) return { operation: "file.append", path: mapped };
    if (mapped === canonicalTracePath) return { operation: "file.truncate", path: mapped };
    return { operation: "file.write", path: mapped };
  };
  const mutatingOpen = (flags) => {
    if (typeof flags === "string") return /[+awx]/u.test(flags);
    return (flags & (
      fs.constants.O_WRONLY
      | fs.constants.O_RDWR
      | fs.constants.O_APPEND
      | fs.constants.O_CREAT
      | fs.constants.O_EXCL
      | fs.constants.O_TRUNC
    )) !== 0;
  };
  const guardedDescriptorMutation = (descriptor, callback) => {
    const request = descriptorMutations.get(descriptor);
    if (!request) {
      throw new MutationGovernanceError(
        "A trace writer tried to use a descriptor without an exact file authorization",
        "MUTATION_GOVERNANCE_DESCRIPTOR_UNBOUND",
      );
    }
    return withGovernedMutation(request, () => {
      assertMutationExecutionAuthorized(request);
      return callback();
    });
  };

  return {
    openSync(filePath, flags, mode) {
      if (!mutatingOpen(flags)) return fs.openSync(filePath, flags, mode);
      const request = requestForOpen(filePath, flags);
      return withGovernedMutation(request, () => {
        assertMutationExecutionAuthorized(request);
        const descriptor = fs.openSync(filePath, flags, mode);
        descriptorMutations.set(descriptor, request);
        return descriptor;
      });
    },
    closeSync(descriptor) {
      try {
        return fs.closeSync(descriptor);
      } finally {
        descriptorMutations.delete(descriptor);
      }
    },
    writeSync(descriptor, buffer, offset, length, position) {
      return guardedDescriptorMutation(
        descriptor,
        () => fs.writeSync(descriptor, buffer, offset, length, position),
      );
    },
    appendWriteSync(descriptor, buffer, offset, length, position) {
      return guardedDescriptorMutation(
        descriptor,
        () => fs.writeSync(descriptor, buffer, offset, length, position),
      );
    },
    ftruncateSync(descriptor, length) {
      return guardedDescriptorMutation(descriptor, () => fs.ftruncateSync(descriptor, length));
    },
    mkdirSync(directoryPath, options) {
      return withGovernedMutation({ operation: "directory.create", path: directoryPath }, () => {
        assertMutationExecutionAuthorized({ operation: "directory.create", path: directoryPath });
        return fs.mkdirSync(directoryPath, options);
      });
    },
    chmodSync(filePath, mode) {
      return withGovernedMutation({ operation: "path.chmod", path: filePath }, () => {
        assertMutationExecutionAuthorized({ operation: "path.chmod", path: filePath });
        return fs.chmodSync(filePath, mode);
      });
    },
    renameSync(sourcePath, targetPath) {
      const source = logicalPath(sourcePath);
      const target = logicalPath(targetPath);
      return withGovernedMutation({ operation: "path.rename.source", path: source }, () =>
        withGovernedMutation({ operation: "path.rename.target", path: target }, () => {
          assertMutationExecutionAuthorized({ operation: "path.rename.source", path: source });
          assertMutationExecutionAuthorized({ operation: "path.rename.target", path: target });
          return fs.renameSync(sourcePath, targetPath);
        }));
    },
    unlinkSync(filePath) {
      const target = logicalPath(filePath);
      const operation = path.resolve(filePath) === lockPath ? "lock.remove" : "file.remove";
      return withGovernedMutation({ operation, path: target }, () => {
        assertMutationExecutionAuthorized({ operation, path: target });
        return fs.unlinkSync(filePath);
      });
    },
  };
}

export function appendTraceEvent(context, storyId, event) {
  const normalizedStoryId = storyId ? normalizeId(String(storyId)) : null;
  const traceFile = normalizedStoryId ? `${normalizedStoryId}.jsonl` : "project.jsonl";
  const tracePath = path.join(context.sdlcRoot, "traces", traceFile);
  const traceEvent = buildGovernedTraceEvent(context, normalizedStoryId, event);
  return sealGovernedTraceEvent(context, tracePath, traceEvent);
}

export function validateCurrentStrictStory(
  context,
  storyId,
  report,
  {
    includeProject = false,
    workflow = null,
    skipChangedPathScope = false,
  } = {},
) {
  if (includeProject) {
    validateProject(context, report);
  }
  validateAuthorizations(context, report);
  validateBaselines(context, report, storyId);
  validateLocks(context, report);
  validateAutonomyRecords(context, report, storyId);

  let currentWorkflow = workflow;
  const story = readStory(context, storyId);
  validateDependencyProposals(context, report, storyId);
  if (story?.contract_id) {
    validateContracts(
      context,
      report,
      new Set([story.contract_id]),
      { workflow: currentWorkflow },
    );
  }
  validateCapabilityDiscovery(context, report, storyId);
  validateTraces(context, report, storyId);
  validateHandoffs(context, report, storyId);
  validateStory(context, storyId, report, {
    skipChangedPathScope,
    workflowPhase: currentWorkflow?.scope?.current_phase || null,
  });
  validateOutputContracts(context, report, storyId);
  if (report.lifecycle_complete === true) {
    validateStoryLifecycleCompletion(context, storyId, report);
  }
  if (
    report.lifecycle_complete !== true
    && !currentWorkflow
    && report.errors.length === 0
  ) {
    currentWorkflow = deriveCurrentStoryWorkflowScope(
      context,
      storyId,
      report,
    );
  }
  return { workflow: currentWorkflow };
}

export function gateCheck(context, options) {
  ensureInitialized(context);
  const attribution = buildAttribution(context, options, "gate.check");
  const storyId = options.story ? normalizeId(String(options.story)) : null;
  const releaseManifestInput = getOptionString(options, "release-manifest");
  const scope = String(options.scope || (releaseManifestInput ? "release-manifest" : storyId ? "story" : "all"));
  const report = {
    status: "passed",
    strict: Boolean(options.strict),
    scope,
    lifecycle_complete: Boolean(options["lifecycle-complete"]),
    certification_level: options["lifecycle-complete"]
      ? "lifecycle_complete"
      : options.strict && scope === "story" ? "strict_intermediate" : "standard",
    story_id: storyId,
    release_manifest_id: null,
    checked_at: now(),
    root: ".",
    root_name: path.basename(context.root),
    actor: attribution.actor,
    git: attribution.git,
    run: attribution.run,
    errors: [],
    warnings: [],
    checked: [],
  };
  const strictStoryScope =
    report.strict === true
    && scope === "story"
    && Boolean(storyId);
  let strictStoryWorkflow = null;

  if (!["story", "all", "release-manifest"].includes(scope)) {
    fail("Gate scope must be 'story', 'release-manifest', or 'all'.");
  }
  if (scope === "story" && !storyId) {
    fail("Gate scope 'story' requires --story.");
  }
  if (scope === "release-manifest" && !releaseManifestInput) {
    fail("Gate scope 'release-manifest' requires --release-manifest <manifest-id-or-path>.");
  }
  if (options["lifecycle-complete"] && (!options.strict || scope !== "story")) {
    fail("--lifecycle-complete requires --strict with one exact --story.");
  }
  validateProject(context, report);

  if (scope === "release-manifest") {
    const { filePath, manifest } = readReleaseManifest(context, releaseManifestInput);
    report.release_manifest_id = manifest.id || null;
    for (const error of validateReleaseManifestIntegrity(context, manifest)) {
      report.errors.push(`release manifest ${manifest.id || "unknown"}: ${error}`);
    }
    report.checked.push(`release manifest ${manifest.id || toProjectPath(context, filePath)}`);
    for (const reference of manifest.requirements || []) {
      const requirementFile = resolveProjectFilePath(context, reference.path, { mustExist: false });
      if (fs.existsSync(requirementFile)) {
        appendRecordSchemaIssues(report, readProjectJson(context, requirementFile), "requirement.schema.json", `requirement ${reference.id}`);
        report.checked.push(`requirement ${reference.id}`);
      }
    }
    for (const reference of manifest.proposals || []) {
      const proposalFile = resolveProjectFilePath(context, reference.path, { mustExist: false });
      if (fs.existsSync(proposalFile)) {
        appendRecordSchemaIssues(report, readProjectJson(context, proposalFile), "assessment-proposal.schema.json", `proposal ${reference.id}`);
      }
    }
    if (manifest.workflow?.path) {
      const workflowFile = resolveProjectFilePath(context, manifest.workflow.path, { mustExist: false });
      if (fs.existsSync(workflowFile)) {
        appendRecordSchemaIssues(report, readProjectJson(context, workflowFile), "assessment-workflow.schema.json", `workflow ${manifest.workflow.id}`);
      }
    }
    for (const reference of manifest.authorization_usage_receipts || []) {
      const receiptFile = resolveProjectFilePath(context, reference.path, { mustExist: false });
      if (fs.existsSync(receiptFile)) {
        appendRecordSchemaIssues(report, readProjectJson(context, receiptFile), "authorization-usage-receipt.schema.json", `authorization usage receipt ${reference.id}`);
      }
    }
    for (const reference of manifest.execution_usage_receipts || []) {
      const receiptFile = resolveProjectFilePath(context, reference.path, { mustExist: false });
      if (fs.existsSync(receiptFile)) {
        appendRecordSchemaIssues(report, readProjectJson(context, receiptFile), "execution-usage-receipt.schema.json", `execution usage receipt ${reference.id}`);
      }
    }
    for (const reference of manifest.context_optimization_observations || []) {
      const observationFile = resolveProjectFilePath(context, reference.path, { mustExist: false });
      if (fs.existsSync(observationFile)) {
        appendRecordSchemaIssues(report, readProjectJson(context, observationFile), "context-optimization-observation.schema.json", `context optimization observation ${reference.id}`);
      }
    }
    for (const reference of manifest.gate_receipts || []) {
      const receiptFile = resolveProjectFilePath(context, reference.path, { mustExist: false });
      if (fs.existsSync(receiptFile)) {
        appendRecordSchemaIssues(report, readProjectJson(context, receiptFile), "release-gate-receipt.schema.json", `release gate receipt ${reference.id}`);
      }
    }
    for (const reference of manifest.contracts || []) report.checked.push(`contract ${reference.id}`);
    for (const reference of manifest.stories || []) {
      report.checked.push(`story ${reference.id}`);
      validateTraces(context, report, reference.id, {
        required: storyTraceIsExpected(context, reference.id),
      });
    }
    validateTraces(context, report, null, { projectOnly: true });
    for (const artifact of manifest.artifacts || []) report.checked.push(`artifact ${artifact.id}`);
    report.warnings.push("Historical records outside this release manifest are logically archived out of the active release scope and were not used to decide this gate.");
  } else if (!strictStoryScope) {
    validateAuthorizations(context, report);
    validateBaselines(context, report, storyId && scope === "story" ? storyId : null);
    validateLocks(context, report);
    validateAutonomyRecords(context, report, storyId && scope === "story" ? storyId : null);
  }

  if (storyId && scope === "story") {
    if (strictStoryScope) {
      ({ workflow: strictStoryWorkflow } = validateCurrentStrictStory(
        context,
        storyId,
        report,
      ));
    } else {
      const story = readStory(context, storyId);
      validateDependencyProposals(context, report, storyId);
      if (story?.contract_id) {
        validateContracts(context, report, new Set([story.contract_id]));
      }
      validateCapabilityDiscovery(context, report, storyId);
      validateTraces(context, report, storyId);
      validateHandoffs(context, report, storyId);
      validateStory(context, storyId, report);
      validateOutputContracts(context, report, storyId);
    }
    appendOperationsPhaseGateChecks(context, report, storyId, readStory(context, storyId));
  } else if (scope === "all") {
    validateDependencyProposals(context, report);
    validateContracts(context, report);
    validateCapabilityDiscovery(context, report);
    validateTraces(context, report);
    validateHandoffs(context, report);
    const storiesRoot = path.join(context.sdlcRoot, "stories");
    for (const entry of safeReadDir(storiesRoot)) {
      const storyJson = path.join(storiesRoot, entry, "story.json");
      if (fs.existsSync(storyJson)) {
        validateStory(context, entry, report);
        appendOperationsPhaseGateChecks(context, report, entry, readProjectJson(context, storyJson));
      }
    }
    validateOutputContracts(context, report);
  }

  report.approval_requests = collectApprovalRequests(context, {
    storyId: scope === "story" ? storyId : null,
  });
  if (scope === "release-manifest") {
    report.approval_requests = [];
  }
  report.assistant_message = renderApprovalRequestsAssistantMessage(report.approval_requests);
  attachAssistantMessagePresentation(report);

  if (
    report.errors.length === 0
    && report.strict === true
    && scope === "story"
    && options["lifecycle-complete"] !== true
  ) {
    const workflow = strictStoryWorkflow;
    if (
      workflow
      && workflowCanonicalEvidenceSchema(workflow.effective_definition)
        === WORKFLOW_CANONICAL_EVIDENCE_SCHEMA
    ) {
      report.workflow_scope = workflow.scope;
      report.checked.push(
        `workflow scope ${workflow.scope.instance_id}@${workflow.scope.current_phase}`,
      );
    } else if (workflow) {
      report.checked.push(
        `legacy workflow evidence ${workflow.scope.instance_id}@${workflow.scope.current_phase}`,
      );
    }
  }

  if (report.errors.length > 0) {
    report.status = "failed";
    process.exitCode = 1;
  }
  const locale = humanGuidanceLocale(options);
  const plainBlockers = Array.from(new Set(report.errors.map((item) => humanReadableGateBlocker(item, locale))));
  const guidance = gateGuidance({ ...report, human_blockers: plainBlockers }, { locale });
  report.human_guidance = guidance;
  if (
    report.status === "passed"
    && report.strict === true
    && scope === "story"
  ) {
    if (options["lifecycle-complete"] === true) {
      const finalReceipt = persistWorkflowFinalGateReceipt(context, report);
      Object.assign(report, finalReceipt);
    } else {
      const strictReceipt = sealWorkflowStrictGateReceipt(context, report);
      const strictReceiptPath = workflowStrictGateReceiptPath(context, storyId);
      writeWorkflowJsonDurably(strictReceiptPath, strictReceipt, { force: true });
      Object.assign(report, strictReceipt);
    }
  }
  if (options.out) {
    writeGateReport(context, report, options);
  }

  const blockerSummary = plainBlockers.length > 0
    ? [
        locale === "it" ? "Cosa bisogna sistemare:" : "What needs fixing:",
        ...plainBlockers.map((item) => `- ${item}`),
      ]
    : [];
  const followUpSummary = report.approval_requests.length > 0
    ? [
        "",
        locale === "it" ? "Altre verifiche registrate:" : "Other recorded follow-ups:",
        ...report.approval_requests.slice(0, 5).map((request) => {
          const title = plainApprovalRequestCopy(request).title;
          if (request.status === "needs_internal_refresh") {
            return locale === "it"
              ? `- Aggiornare i riferimenti interni per ${title}; questo non approva né amplia l’ambito.`
              : `- Refresh internal references for ${title}; this neither approves nor expands the scope.`;
          }
          return locale === "it"
            ? `- Serve ancora una decisione per ${title}.`
            : `- A decision is still needed for ${title}.`;
        }),
      ]
    : [];
  output(
    options,
    report,
    [
      ...humanGuidanceLines(guidance, [
        `Scope checked: ${scope}${storyId ? `; story ${storyId}` : ""}`,
        `Certification level: ${report.certification_level}`,
        `Items checked: ${report.checked.length}`,
        `Blocking issues: ${report.errors.length}`,
        `Warnings: ${report.warnings.length}`,
        `Recorded follow-ups: ${report.approval_requests.length}`,
        ...report.errors.map((item) => `Blocker: ${item}`),
        ...report.warnings.map((item) => `Warning: ${item}`),
        ...(report.final_receipt_path
          ? [`Final lifecycle receipt: ${report.final_receipt_path}`]
          : []),
      ], options, blockerSummary),
      ...followUpSummary,
    ],
  );
}

export function readStory(context, storyId) {
  const id = normalizeId(storyId);
  const storyPath = path.join(context.sdlcRoot, "stories", id, "story.json");
  return fs.existsSync(storyPath) ? normalizeStoryRecord(readProjectJson(context, storyPath)) : null;
}

export function writeGateReport(context, report, options) {
  assertRecordSchema(report, "gate-report.schema.json", `Gate report ${report.story_id || "project"}`);
  const reportPath = resolveProjectFilePath(context, options.out, { mustExist: false });
  assertNotDerivedArtifact(context, reportPath, "Gate report");
  const extension = path.extname(reportPath).toLowerCase();
  if (extension === ".md") {
    writeTextFile(reportPath, renderGateReportMarkdown(report), { force: Boolean(options.force), forceOption: true });
    return;
  }
  writeJsonFile(reportPath, report, { force: Boolean(options.force), forceOption: true });
}

export function currentStoryStrictGateReadiness(
  context,
  storyId,
  instance,
  effectiveDefinition,
  integrity,
  currentState,
) {
  const strictPath = workflowStrictGateReceiptPath(context, storyId);
  if (!fs.existsSync(strictPath)) {
    return {
      ready: false,
      reason: "missing",
      issues: [`Intermediate strict gate receipt ${toProjectPath(context, strictPath)} is missing.`],
    };
  }
  try {
    return withOutputRegistryLock(context, () => {
    const canonicalEvidenceSchema =
      workflowCanonicalEvidenceSchema(effectiveDefinition)
      || WORKFLOW_LEGACY_CANONICAL_EVIDENCE_SCHEMA;
    const modern =
      canonicalEvidenceSchema === WORKFLOW_CANONICAL_EVIDENCE_SCHEMA;
    const evidence = buildCanonicalEvidenceForWorkflowInstance(
      context,
      instance,
      canonicalEvidenceSchema,
      modern
        ? {
            current_phase: currentState,
            phase_order: effectiveDefinition.phase_order,
            require_all: false,
          }
        : null,
      modern
        ? workflowScopeFromRuntime(
            instance,
            effectiveDefinition,
            integrity,
            currentState,
          )
        : null,
    );
    const check = evidence.checks?.strict_gate_passed;
    const issues = check?.satisfied === true
      ? []
      : Array.isArray(check?.issues) && check.issues.length > 0
        ? check.issues.map((issue) => String(issue))
        : ["The intermediate strict gate receipt is not valid for the current workflow state."];
    const receipt = readProjectJson(context, strictPath);
    const checkedAt = Date.parse(String(receipt.checked_at || ""));
    if (!Number.isFinite(checkedAt)) {
      issues.push("The intermediate strict gate receipt has no valid checked_at timestamp.");
    } else {
      const currentStepCompletedAt = readStoryStepRecords(context, storyId)
        .filter((record) =>
          record.status === "completed"
          && record.phase === currentState
          && Number.isFinite(Date.parse(String(record.completed_at || ""))))
        .map((record) => Date.parse(record.completed_at))
        .sort((left, right) => right - left)[0] || null;
      if (currentStepCompletedAt && currentStepCompletedAt > checkedAt) {
        issues.push(
          `The intermediate strict gate predates completion of the current '${currentState}' step.`,
        );
      }
      const newerLifecycleTrace = readTraceEvents(context, storyId)
        .filter((event) => ["test", "release"].includes(event.type))
        .find((event) => {
          const createdAt = Date.parse(String(event.created_at || ""));
          return !Number.isFinite(createdAt) || createdAt > checkedAt;
        });
      if (newerLifecycleTrace) {
        issues.push(
          `The intermediate strict gate predates current ${newerLifecycleTrace.type} evidence.`,
        );
      }
    }
    const currentValidation = {
      status: "passed",
      strict: true,
      scope: "story",
      lifecycle_complete: false,
      story_id: storyId,
      errors: [],
      warnings: [],
      checked: [],
    };
    validateCurrentStrictStory(
      context,
      storyId,
      currentValidation,
      {
        includeProject: true,
        workflow: {
          instance,
          effective_definition: effectiveDefinition,
          integrity,
          scope: workflowScopeFromRuntime(
            instance,
            effectiveDefinition,
            integrity,
            currentState,
          ),
        },
      },
    );
    issues.push(...currentValidation.errors.map((issue) => String(issue)));
    const uniqueIssues = Array.from(new Set(issues));
    let repair = uniqueIssues.length > 0
      ? strictGateOutputRepair(context, storyId, uniqueIssues)
      : null;
    if (!repair && currentValidation.errors.length > 0) {
      const diagnosticCommand = statusCliCommand(
        "gate", "check", "--strict", "--story", storyId,
      );
      repair = {
        kind: "repair_strict_gate_evidence",
        reason: "current_strict_gate_evidence_invalid",
        label:
          "Inspect the strict-gate blockers, repair the invalid current project evidence, then run the strict gate again.",
        command: diagnosticCommand,
        diagnostic: true,
        repair_steps: [
          {
            kind: "diagnose_strict_gate_blockers",
            command: diagnosticCommand,
          },
        ],
      };
    }
    return {
      ready: uniqueIssues.length === 0,
      reason: uniqueIssues.length === 0 ? "current" : "stale",
      issues: uniqueIssues,
      repair,
    };
    });
  } catch (error) {
    return {
      ready: false,
      reason: "invalid",
      issues: [
        error.message
          || "The intermediate strict gate receipt cannot be verified.",
      ],
      repair: null,
    };
  }
}

export function storyOrchestrationNextAction(context, story) {
  const storyId = normalizeId(story.id);
  const record = readStory(context, storyId);
  const phase = record?.phase || story.phase || "implementation";
  if (!record) {
    return {
      action: "inspect_story",
      command: `agentic-sdlc status --full`,
      claim: null,
      issues: [`Story ${storyId} cannot be read from its canonical workspace.`],
    };
  }
  let contractState;
  try {
    contractState = inspectStoryContract(context, record);
  } catch (error) {
    return {
      action: "repair_contract",
      command: `agentic-sdlc approval requests --story ${storyId}`,
      claim: null,
      issues: [error.message],
    };
  }
  if (!contractState.exists) {
    return {
      action: "create_contract",
      command:
        `agentic-sdlc contract create --phase ${phase} --story ${storyId} `
        + `--id contract-${storyId}-${phase}`,
      claim: null,
      issues: [contractState.message],
    };
  }
  if (!contractState.approved) {
    return {
      action: contractState.review_required ? "replace_contract" : "approve_contract",
      command: contractState.review_required
        ? (
            `agentic-sdlc contract create --phase ${phase} --story ${storyId} `
            + "--id <new-contract-id> --replace-story-contract"
          )
        : `agentic-sdlc approval requests --story ${storyId}`,
      claim: null,
      issues: [contractState.message],
    };
  }
  let taskStartIssues;
  try {
    taskStartIssues = validateTaskStartReceipt(context, storyId, contractState.contract);
  } catch (error) {
    taskStartIssues = [error.message];
  }
  if (taskStartIssues.length > 0) {
    return {
      action: "task_start",
      command:
        `agentic-sdlc task start --story ${storyId} --contract-id ${contractState.contract.id} `
        + "--intent-json '<normalized implement_story intent>' --confirm-start",
      claim: null,
      issues: taskStartIssues,
    };
  }
  const claim =
    `agentic-sdlc story claim --id ${storyId} --agent <agent> `
    + `--branch ${defaultStoryBranch(context, storyId)}`;
  return {
    action: "claim_story",
    command: claim,
    claim,
    issues: [],
  };
}

export function inferStoryOrchestrationState(
  context,
  story,
  claim,
  blockers = null,
  lifecycle = null,
) {
  const effectiveLifecycle = lifecycle
    || effectiveStoryLifecycleProjection(context, story);
  if (effectiveLifecycle.closed) {
    return "closed";
  }
  if (effectiveLifecycle.terminal) {
    return "terminal";
  }
  if (effectiveLifecycle.blocked) {
    return "blocked";
  }
  if (claim && claim.status === "active") {
    return isClaimExpired(context, claim) ? "stale" : "claimed";
  }
  return (
    blockers
    || inferStoryBlockers(context, story, claim, null, effectiveLifecycle)
  ).length > 0
    ? "blocked"
    : "available";
}

export function readLastTraceEvent(context, storyId) {
  const events = readTraceEvents(context, storyId).filter((event) => event.type !== "invalid");
  return events.length ? events[events.length - 1] : null;
}

export function readHandoffs(context) {
  const handoffsRoot = path.join(context.sdlcRoot, "handoffs");
  return safeReadDir(handoffsRoot)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readProjectJson(context, path.join(handoffsRoot, name)));
}

export function readStoryStepRecords(context, storyId, session = null) {
  if (session) {
    return session.listFiles({
      under: `stories/${storyId}/steps`,
      extensions: [".json"],
      recursive: false,
    })
      .map((file) => session.readJson(file.path))
      .sort((a, b) => String(a.completed_at || "").localeCompare(String(b.completed_at || "")));
  }
  const stepsRoot = path.join(context.sdlcRoot, "stories", storyId, "steps");
  return safeReadDir(stepsRoot)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readProjectJson(context, path.join(stepsRoot, name)))
    .sort((a, b) => String(a.completed_at || "").localeCompare(String(b.completed_at || "")));
}

export function buildStoryHandoffPackage(context, storyId, handoffId, options = {}) {
  const story = readStory(context, storyId);
  const claimPath = path.join(context.sdlcRoot, "stories", storyId, "claim.json");
  const registry = readOutputRegistry(context, { missingOk: true });
  const storyLinks = (registry?.links || []).filter((link) => link.story_id === storyId);
  const dependencyStatus = buildDependencyStatus(context, storyId);
  const traceLimit = Math.max(1, Number(options["trace-limit"] || 25));
  const traceEvents = readTraceEvents(context, storyId).filter((event) => event.type !== "invalid");
  const handoffs = readHandoffs(context).filter((handoff) => handoff.story_id === storyId);
  const sourceFiles = collectStoryHandoffSourceFiles(context, storyId);
  const sourcePaths = sourceFiles.map((filePath) => toProjectPath(context, filePath)).sort();
  return {
    id: normalizeId(`PKG-${handoffId}`),
    kind: "story_handoff_package",
    schema_version: context.config.schema_version,
    story_id: storyId,
    handoff_id: handoffId,
    generated_at: now(),
    summary: getOptionString(options, "summary") || null,
    story: {
      id: story.id,
      title: story.title,
      status: story.status,
      phase: story.phase,
      contract_id: story.contract_id || null,
      requirements: Array.isArray(story.links?.requirements) ? story.links.requirements : [],
      acceptance: storyAcceptanceCriteria(story),
      acceptance_criteria: storyAcceptanceCriteria(story),
    },
    active_claim: fs.existsSync(claimPath) ? readProjectJson(context, claimPath) : null,
    completed_steps: readStoryStepRecords(context, storyId),
    output_links: storyLinks,
    dependency_status: {
      blockers: dependencyStatus.blockers,
      warnings: dependencyStatus.warnings,
      edges: dependencyStatus.edges,
    },
    handoffs: handoffs.map((handoff) => ({
      id: handoff.id,
      status: handoff.status,
      to_agent: handoff.to_agent,
      summary: handoff.summary || null,
      open_items: Array.isArray(handoff.open_items) ? handoff.open_items : [],
      created_at: handoff.created_at || null,
    })),
    recent_traces: traceEvents.slice(-traceLimit).map((event) => ({
      id: event.id || null,
      created_at: event.created_at || null,
      type: event.type || null,
      action: event.action || null,
      summary: event.summary || null,
      actor: event.actor || null,
      evidence: Array.isArray(event.evidence) ? event.evidence : [],
      related: Array.isArray(event.related) ? event.related : [],
      git: event.git || null,
      run: event.run || null,
    })),
    source_paths: sourcePaths,
    source_hashes: buildSourceHashMap(context, sourcePaths),
    audit: {
      generated_by: buildAttribution(context, options, "story.prepare-handoff").actor,
      git: buildGitMetadata(context.root),
      run: buildRunMetadata(options),
    },
  };
}

export function collectStoryHandoffSourceFiles(context, storyId) {
  const storyDir = path.join(context.sdlcRoot, "stories", storyId);
  const files = [];
  for (const filePath of walkFiles(storyDir)) {
    if (shouldIndexFile(context, filePath) && !filePath.includes(`${path.sep}handoffs${path.sep}`)) {
      files.push(filePath);
    }
  }
  const tracePath = path.join(context.sdlcRoot, "traces", `${storyId}.jsonl`);
  if (fs.existsSync(tracePath)) {
    files.push(tracePath);
  }
  const registryPath = outputRegistryPath(context);
  if (fs.existsSync(registryPath)) {
    files.push(registryPath);
  }
  const graphPath = dependencyGraphPath(context);
  if (fs.existsSync(graphPath)) {
    files.push(graphPath);
  }
  return Array.from(new Set(files)).sort((a, b) => a.localeCompare(b));
}

// Trace types that prove a story's delivery work began. A story with any of
// them, or with the lifecycle records checked below, cannot be closed.
const STORY_CLOSURE_WORK_TRACE_TYPES = new Set([
  "claim",
  "handoff",
  "implementation",
  "release",
  "sync",
  "test",
]);

export function storyClosureContentHash(story) {
  const {
    __folder_id: _folderId,
    __path: _path,
    __relative_path: _relativePath,
    ...record
  } = normalizeStoryRecord(story) || {};
  return hashApprovalSubject(record);
}

export function storyClosureStoryRef(context, story) {
  return {
    id: story.id,
    path: toProjectPath(
      context,
      path.join(context.sdlcRoot, "stories", normalizeId(story.id), "story.json"),
    ),
    content_hash: storyClosureContentHash(story),
  };
}

export function readStoryClosure(context, storyId) {
  const closurePath = storyClosurePath(context, storyId);
  if (!pathEntryExistsNoFollow(closurePath)) return null;
  return readProjectJson(context, closurePath);
}

export function storyClosureGovernanceErrors(context, closure, story) {
  const label = `story closure ${closure?.id || "unknown"}`;
  const report = { strict: true, errors: [], warnings: [] };
  if (!appendRecordSchemaIssues(report, closure, "story-closure.schema.json", label)) {
    return report.errors;
  }
  let subject;
  try {
    subject = buildStoryClosureSubject(closure.subject);
  } catch (error) {
    return [`${label} has an invalid subject: ${error.message}`];
  }
  if (closure.story_id !== story?.id) {
    report.errors.push(`${label} belongs to ${closure.story_id}, not ${story?.id || "unknown"}`);
  }
  if (
    closure.event !== subject.event
    || closure.replacement_id !== (subject.replacement?.id || null)
  ) {
    report.errors.push(`${label} does not match its approved subject`);
  }
  const storyRef = subject.stories.find((ref) => ref.id === story?.id);
  if (!storyRef) {
    report.errors.push(`${label} approved subject does not include ${story?.id || "the story"}`);
  } else if (storyRef.content_hash !== storyClosureContentHash(story)) {
    report.errors.push(`${label}: story ${story.id} changed after it was closed`);
  }
  const approval = closure.approval;
  if (!approval || approval.status !== "approved") {
    report.errors.push(`${label} has no approved governance record`);
    return report.errors;
  }
  if (approval.approved_content_hash !== hashApprovalSubject(closure.subject)) {
    report.errors.push(`${label} approval does not bind the exact closure subject`);
  }
  if (!hasFormalApprovalAttribution(approval.approved_by, approval.approval_source)) {
    report.errors.push(`${label} approval attribution is incomplete`);
  }
  validateFormalApprovalRecord(
    context,
    report,
    approval,
    `${label} approval`,
    approval.approved_by,
    { subject_id: approval.story_id || null },
  );
  return report.errors;
}

// A valid closure makes the story terminal without rewriting story.json; any
// unreadable or unapproved closure fails closed as a blocked lifecycle.
export function storyClosureLifecycleProjection(context, story, rawStatus, rawPhase) {
  const storyId = String(story?.id || "").trim();
  if (!storyId) return null;
  let closure;
  try {
    closure = readStoryClosure(context, storyId);
  } catch {
    return blockedWorkflowLifecycleProjection(rawStatus, rawPhase, "invalid_story_closure");
  }
  if (!closure) return null;
  if (storyClosureGovernanceErrors(context, closure, story).length > 0) {
    return blockedWorkflowLifecycleProjection(rawStatus, rawPhase, "invalid_story_closure");
  }
  return {
    status: closure.event,
    phase: rawPhase,
    terminal: true,
    blocked: false,
    closed: true,
    source: "story_closure",
    workflow_instance_id: null,
    closure: {
      id: closure.id,
      event: closure.event,
      replacement_id: closure.replacement_id,
      breakdown_id: closure.subject?.breakdown?.id || null,
      path: toProjectPath(context, storyClosurePath(context, storyId)),
    },
  };
}

export function storyClosureStartedWorkIssues(context, storyId) {
  const issues = [];
  const storyDir = path.join(context.sdlcRoot, "stories", storyId);
  if (pathEntryExistsNoFollow(path.join(storyDir, "claim.json"))) {
    issues.push("it has a work assignment");
  }
  if (pathEntryExistsNoFollow(path.join(storyDir, "task-start.json"))) {
    issues.push("its governed work has started");
  }
  if (safeReadDir(path.join(storyDir, "steps")).some((name) => name.endsWith(".json"))) {
    issues.push("it has completed lifecycle steps");
  }
  const probe = { errors: [] };
  const workflow = currentStoryBoundWorkflowInstance(context, storyId, probe);
  if (workflow || probe.errors.length > 0) {
    issues.push("it has a governed workflow run");
  }
  if (
    pathEntryExistsNoFollow(workflowFinalGateReceiptPath(context, storyId))
    || pathEntryExistsNoFollow(workflowStrictGateReceiptPath(context, storyId))
  ) {
    issues.push("it has lifecycle certification records");
  }
  const deliveries = storyBoundDeliveryProfiles(context, storyId).map((profile) => profile.id);
  if (deliveries.length > 0) {
    issues.push(`it is bound to delivery ${deliveries.sort().join(", ")}`);
  }
  const registry = readOutputRegistry(context, { missingOk: true });
  if ((registry?.links || []).some((link) => link.story_id === storyId)) {
    issues.push("it has linked outputs");
  }
  if (readTraceEvents(context, storyId).some((event) => STORY_CLOSURE_WORK_TRACE_TYPES.has(event.type))) {
    issues.push("its history records delivery work");
  }
  return issues;
}

function storyClosureRequirementIds(story) {
  return [...new Set([
    ...(Array.isArray(story?.links?.requirements) ? story.links.requirements : []),
    ...(Array.isArray(story?.requirement_refs) ? story.requirement_refs.map((ref) => ref?.id) : []),
  ].filter(Boolean).map((id) => normalizeId(id)))];
}

export function supersedeStories(context, options) {
  return closeStories(context, options, "superseded");
}

export function cancelStories(context, options) {
  return closeStories(context, options, "cancelled");
}

function closeStories(context, options, event) {
  ensureInitialized(context);
  const verb = event === "superseded" ? "supersede" : "cancel";
  const action = `story.${verb}`;
  const reason = requireOption(options, "reason");
  const explicitIds = normalizeListOption(options.id).map((id) => normalizeId(id));
  const breakdownOption = getOptionString(options, "from-breakdown");
  const breakdownId = breakdownOption ? normalizeId(breakdownOption) : null;
  if (explicitIds.length === 0 && !breakdownId) {
    failUsage(`story ${verb} needs --id <story-id> or --from-breakdown <breakdown-id>.`);
  }
  const replacementId = event === "superseded"
    ? normalizeId(requireOption(options, "by"))
    : null;
  if (event === "cancelled" && options.by !== undefined) {
    failUsage("story cancel does not accept --by; use story supersede to name a replacement story.");
  }

  let breakdown = null;
  let breakdownStoryIds = [];
  if (breakdownId) {
    const breakdownPath = breakdownPathById(context, breakdownId);
    if (!pathEntryExistsNoFollow(breakdownPath)) {
      fail(`Breakdown ${breakdownId} does not exist.`);
    }
    breakdown = readProjectJson(context, breakdownPath);
    if (breakdown.status !== "approved" || !isApprovedRecordFresh(breakdown)) {
      fail(`Breakdown ${breakdownId} must be approved and current before its stories can be closed together.`);
    }
    breakdownStoryIds = (breakdown.items || [])
      .filter((item) => item?.type === "story" && item.id)
      .map((item) => normalizeId(item.id));
    if (breakdownStoryIds.length === 0) {
      fail(`Breakdown ${breakdownId} has no story items to close.`);
    }
  }
  const storyIds = [...new Set([...explicitIds, ...breakdownStoryIds])]
    .sort((left, right) => left.localeCompare(right, "en"));
  if (replacementId && storyIds.includes(replacementId)) {
    fail(
      `Story ${replacementId} cannot supersede itself. `
      + "Name a replacement story outside the stories being closed.",
    );
  }

  const attribution = buildAttribution(context, options, action);
  requireFormalApprovalActor(
    context,
    options,
    attribution,
    event === "superseded" ? "Superseding a story" : "Cancelling a story",
  );

  for (const storyId of storyIds) {
    if (!readStory(context, storyId)) fail(`Story ${storyId} does not exist.`);
  }
  // Same lock order as task start and claims, one story at a time in id order.
  const releases = [];
  try {
    for (const storyId of storyIds) {
      const storyDir = path.join(context.sdlcRoot, "stories", storyId);
      releases.push(acquireFileLock(path.join(storyDir, "task-start-boundary.lock")));
      releases.push(acquireFileLock(storyLifecycleCertificationLockPath(context, storyId)));
      releases.push(acquireFileLock(path.join(storyDir, "claim.lock")));
    }
    return closeStoriesLocked(context, options, {
      event,
      verb,
      action,
      reason,
      storyIds,
      replacementId,
      breakdown,
      attribution,
    });
  } finally {
    for (const release of releases.reverse()) release();
  }
}

function closeStoriesLocked(context, options, {
  event,
  verb,
  action,
  reason,
  storyIds,
  replacementId,
  breakdown,
  attribution,
}) {
  const stories = storyIds.map((storyId) => readStory(context, storyId));
  const refusals = [];
  for (const story of stories) {
    const lifecycle = effectiveStoryLifecycleProjection(context, story);
    const issues = lifecycle.closed ? [] : storyClosureStartedWorkIssues(context, story.id);
    if (lifecycle.closed) {
      refusals.push(`${story.id} is already ${lifecycle.status}`);
    } else if (issues.length > 0) {
      refusals.push(`${story.id} was already started: ${issues.join("; ")}`);
    } else if (lifecycle.blocked) {
      refusals.push(`${story.id} lifecycle cannot be verified (${lifecycle.source})`);
    } else if (lifecycle.terminal) {
      refusals.push(`${story.id} is already complete`);
    }
  }

  const graph = readDependencyGraph(context, { missingOk: true });
  const closing = new Set(storyIds);
  let replacement = null;
  if (replacementId) {
    replacement = readStory(context, replacementId);
    if (!replacement) {
      refusals.push(`replacement story ${replacementId} does not exist`);
    } else {
      const replacementLifecycle = effectiveStoryLifecycleProjection(context, replacement);
      if (replacementLifecycle.closed) {
        refusals.push(`replacement story ${replacementId} is itself ${replacementLifecycle.status}`);
      }
      const replacementRequirements = storyClosureRequirementIds(replacement);
      for (const story of stories) {
        const requirements = storyClosureRequirementIds(story);
        if (
          requirements.length > 0
          && !requirements.some((id) => replacementRequirements.includes(id))
        ) {
          refusals.push(`${story.id} and replacement ${replacementId} share no requirement`);
        }
      }
      for (const edge of graph.edges || []) {
        if (edge.from === replacementId && closing.has(edge.to) && isHardDependencyEdge(edge)) {
          refusals.push(`replacement ${replacementId} depends on ${edge.to}, which it would supersede`);
        }
      }
    }
  } else {
    for (const edge of graph.edges || []) {
      if (!closing.has(edge.to) || closing.has(edge.from) || !isHardDependencyEdge(edge)) continue;
      const dependent = readStory(context, edge.from);
      if (dependent && effectiveStoryLifecycleProjection(context, dependent).closed) continue;
      refusals.push(
        `${edge.from} depends on ${edge.to}; close ${edge.from} too, `
        + `or use story supersede to name the story that replaces ${edge.to}`,
      );
    }
  }
  if (refusals.length > 0) {
    fail([
      `Cannot ${verb} ${storyIds.join(", ")}; nothing was changed. `
      + "Only stories whose work never started can be closed this way.",
      ...[...new Set(refusals)].map((item) => `- ${item}`),
    ].join("\n"));
  }

  const subject = buildDomainRecord(`Cannot ${verb} ${storyIds.join(", ")}`, () => buildStoryClosureSubject({
    event,
    stories: stories.map((story) => storyClosureStoryRef(context, story)),
    replacement: replacement ? storyClosureStoryRef(context, replacement) : null,
    breakdown: breakdown
      ? {
          id: breakdown.id,
          path: toProjectPath(context, breakdownPathById(context, breakdown.id)),
          content_hash: hashApprovalSubject(breakdown),
        }
      : null,
    reason,
  }));
  const approval = buildApprovalRecord(context, options, attribution, {
    subject,
    subject_id_field: "story_id",
    subject_id: storyIds.length === 1 ? storyIds[0] : breakdown?.id || storyIds.join(","),
    status: "approved",
    scope: "story-closure",
    label: `${event} ${storyIds.join(", ")}${replacementId ? ` by ${replacementId}` : ""}`,
  });
  const createdAt = now();
  const suffix = uniqueRecordSuffix();
  const closures = stories.map((story) => {
    const record = buildDomainRecord(`Cannot ${verb} story ${story.id}`, () => buildStoryClosure({
      id: `CLOSE-${story.id}-${suffix}`,
      story_id: story.id,
      subject,
      approval,
      created_at: createdAt,
      audit: { actor: attribution.actor, git: attribution.git, run: attribution.run },
    }));
    assertRecordSchema(record, "story-closure.schema.json", `Story closure ${record.id}`);
    return { record, path: storyClosurePath(context, story.id) };
  });
  for (const closure of closures) {
    writeJsonFile(closure.path, closure.record, { force: false });
  }
  const closurePaths = closures.map((closure) => toProjectPath(context, closure.path));
  appendTraceEvent(context, null, {
    type: "decision",
    summary: replacementId
      ? `Superseded never-started ${storyIds.join(", ")} with ${replacementId}: ${reason}`
      : `Cancelled never-started ${storyIds.join(", ")}: ${reason}`,
    action,
    actor: attribution.actor,
    evidence: closurePaths,
    related: [...storyIds, replacementId, breakdown?.id].filter(Boolean),
    git: attribution.git,
    run: attribution.run,
  });
  output(
    options,
    {
      status: event,
      stories: storyIds,
      replacement_id: replacementId,
      breakdown_id: breakdown?.id || null,
      approval_id: approval.id,
      closures: closures.map((closure) => ({
        id: closure.record.id,
        story_id: closure.record.story_id,
        path: toProjectPath(context, closure.path),
      })),
    },
    humanGuidanceLines(storyClosureGuidance(event, options), [
      replacementId
        ? `Superseded ${storyIds.join(", ")} with ${replacementId}`
        : `Cancelled ${storyIds.join(", ")}`,
      ...closurePaths.map((closurePath) => `Closure record: ${closurePath}`),
      "Story records were not rewritten; each closure record is immutable and approved.",
    ], options),
  );
}

function storyClosureGuidance(event, options) {
  const italian = humanGuidanceLocale(options) === "it";
  const superseded = event === "superseded";
  if (italian) {
    return {
      result: superseded
        ? "Le attività mai avviate sono state chiuse perché un’altra attività ne consegna il lavoro."
        : "Le attività mai avviate sono state chiuse e non saranno consegnate.",
      impact: "Non compaiono più come lavoro disponibile o bloccato e non trattengono le attività che ne dipendevano.",
      required_decision: "Non serve un’altra decisione; la chiusura approvata resta nella cronologia del progetto.",
      protection_boundary: "Le attività originali non sono state riscritte; nulla è stato pubblicato, rilasciato o unito.",
      next_action: superseded
        ? "Continua con l’attività che ora consegna il lavoro."
        : "Controlla lo stato del progetto per il prossimo lavoro disponibile.",
    };
  }
  return {
    result: superseded
      ? "The never-started work was closed because another story now delivers it."
      : "The never-started work was closed and will not be delivered.",
    impact: "It no longer appears as available or blocked work and no longer holds back work that depended on it.",
    required_decision: "No further decision is needed; the approved closure stays in the project history.",
    protection_boundary: "The original stories were not rewritten; nothing was published, released, or merged.",
    next_action: superseded
      ? "Continue with the story that now delivers the work."
      : "Check the project status for the next available work.",
  };
}

export function effectiveStoryLifecycleProjection(context, story) {
  const rawStatus = String(story?.status || "unknown").toLowerCase();
  const rawPhase = String(story?.phase || "unknown").toLowerCase();
  const terminalStatuses = terminalStoryStatuses(context);
  const rawTerminal = terminalStatuses.includes(rawStatus);
  const storyId = String(story?.id || "").trim();
  if (!storyId) {
    return storyRecordLifecycleProjection(rawStatus, rawPhase, rawTerminal);
  }
  const closureProjection = storyClosureLifecycleProjection(context, story, rawStatus, rawPhase);
  if (closureProjection) return closureProjection;

  const receiptPath = workflowFinalGateReceiptPath(context, storyId);
  const receiptExists = fs.existsSync(receiptPath);
  let receipt = null;
  if (receiptExists) {
    try {
      receipt = readProjectJson(context, receiptPath);
    } catch {
      return blockedWorkflowLifecycleProjection(
        rawStatus,
        rawPhase,
        "invalid_workflow_final_receipt",
      );
    }
  }

  const probe = { errors: [] };
  const selected = currentStoryBoundWorkflowInstance(context, storyId, probe);
  if (probe.errors.length > 0) {
    return blockedWorkflowLifecycleProjection(
      rawStatus,
      rawPhase,
      "invalid_story_workflow",
      selected?.entry || null,
    );
  }
  let runtime = null;
  try {
    if (selected) runtime = inspectStoryWorkflowLifecycleRuntime(context, selected, storyId);
  } catch {
    return blockedWorkflowLifecycleProjection(
      rawStatus,
      rawPhase,
      "invalid_story_workflow",
      selected?.entry || null,
    );
  }
  if (runtime && !runtime.valid) {
    return blockedWorkflowLifecycleProjection(
      rawStatus,
      rawPhase,
      "invalid_story_workflow",
      selected.entry,
    );
  }
  if (
    runtime?.modern
    && (
      receiptExists
      || runtime.event_count > 0
      || fs.existsSync(path.join(context.sdlcRoot, "stories", storyId, "task-start.json"))
    )
  ) {
    const taskStartBinding = inspectModernWorkflowTaskStartBinding(
      context,
      storyId,
      runtime.instance,
    );
    if (!taskStartBinding.valid) {
      return blockedWorkflowLifecycleProjection(
        rawStatus,
        rawPhase,
        "invalid_story_workflow",
        selected.entry,
      );
    }
    runtime.task_start_binding = taskStartBinding;
  }

  if (!receiptExists) {
    if (!runtime?.modern) {
      return storyRecordLifecycleProjection(
        rawStatus,
        rawPhase,
        rawTerminal,
        selected?.entry || null,
      );
    }
    if (runtime.terminal) {
      return blockedWorkflowLifecycleProjection(
        rawStatus,
        rawPhase,
        "missing_workflow_final_receipt",
        selected.entry,
      );
    }
    if (rawTerminal) {
      return blockedWorkflowLifecycleProjection(
        rawStatus,
        rawPhase,
        "story_workflow_lifecycle_conflict",
        selected.entry,
      );
    }
    return storyRecordLifecycleProjection(
      rawStatus,
      rawPhase,
      rawTerminal,
      selected.entry,
    );
  }

  if (receipt.schema_version === WORKFLOW_LEGACY_FINAL_GATE_RECEIPT_SCHEMA) {
    if (
      runtime?.modern
      || !validLegacyWorkflowFinalReceipt(context, storyId, receipt)
    ) {
      return blockedWorkflowLifecycleProjection(
        rawStatus,
        rawPhase,
        "invalid_workflow_final_receipt",
        selected?.entry || null,
      );
    }
    return storyRecordLifecycleProjection(
      rawStatus,
      rawPhase,
      rawTerminal,
      selected?.entry || null,
    );
  }
  if (
    receipt.schema_version !== WORKFLOW_FINAL_GATE_RECEIPT_SCHEMA
    || !selected
    || !runtime?.modern
  ) {
    return blockedWorkflowLifecycleProjection(
      rawStatus,
      rawPhase,
      "invalid_workflow_final_receipt",
      selected?.entry || null,
    );
  }

  try {
    const finalReceipt = validCurrentWorkflowFinalReceipt(
      context,
      storyId,
      runtime.instance,
    );
    if (!finalReceipt.valid) {
      return blockedWorkflowLifecycleProjection(
        rawStatus,
        rawPhase,
        "invalid_workflow_final_receipt",
        runtime.instance.id,
      );
    }
    return {
      status: terminalStatuses.includes("done")
        ? "done"
        : terminalStatuses[0] || "done",
      phase: finalReceipt.current_phase
        || configuredPhaseOrder(context).at(-1)
        || rawPhase,
      terminal: true,
      blocked: false,
      source: "workflow_final_receipt",
      workflow_instance_id: runtime.instance.id,
    };
  } catch {
    return blockedWorkflowLifecycleProjection(
      rawStatus,
      rawPhase,
      "invalid_workflow_final_receipt",
      selected.entry,
    );
  }
}

export function isClaimExpired(context, claim) {
  return isExpired(effectiveClaimExpiration(context, claim));
}

export function validateBaselines(context, report, storyId = null) {
  const allBaselines = readBaselines(context);
  const storyExecutionContext = storyId ? executionContextForStory(context, storyId) : null;
  const referencedIds = storyId
    ? baselineIdsReferencedByStoryContract(context, storyId)
    : baselineIdsReferencedByAllContracts(context);
  const activeIds = new Set([
    ...selectActiveBaselines(context, storyId).map((baseline) => baseline.id),
    ...referencedIds,
  ]);
  const availableIds = new Set(allBaselines.map((baseline) => baseline.id));
  for (const baselineId of referencedIds) {
    if (!availableIds.has(baselineId)) {
      report.errors.push(`Referenced baseline ${baselineId} is missing from .sdlc/baseline`);
    }
  }
  const baselines = report.scope === "story"
    ? allBaselines.filter((baseline) => activeIds.has(baseline.id))
    : allBaselines;
  for (const baseline of baselines) {
    const label = `baseline ${baseline.id || "unknown"}`;
    const baselineStatus = String(baseline.status || "").toLowerCase();
    const active = activeIds.has(baseline.id);
    if (!baseline.id || !baseline.schema_version || !baseline.status || !baseline.kind) {
      report.errors.push(`${label} is missing id, schema_version, status, or kind`);
    }
    for (const issue of validateBaselineSourceHashes(context, baseline, label, {
      collectOnly: true,
      executionContext: active ? storyExecutionContext : null,
    })) {
      const severity = active && ["approved", "provisionally_approved"].includes(baselineStatus) && report.strict ? "errors" : "warnings";
      report[severity].push(issue);
    }
    if (report.strict && active && baselineStatus && baselineStatus !== "approved") {
      report.errors.push(
        `${label} is '${baseline.status}'; strict gate requires explicit baseline approval before phase work treats inferred project facts as canonical`,
      );
    }
    if (active && baselineStatus === "approved") {
      const approval = latestApprovedRecordApproval(baseline);
      if (!approval || !hasFormalApprovalAttribution(approval.approved_by, approval.approval_source)) {
        report.errors.push(`${label} approval must be attributed to ${formalApprovalActorDescription(approval?.approval_source)}`);
      }
      validateFormalApprovalRecord(context, report, approval, `${label} approval ${approval?.id || "unknown"}`, approval?.approved_by);
      if (!isApprovedRecordFresh(baseline)) {
        report.errors.push(`${label} approval is stale`);
      }
    }
    if (active && baselineStatus === "provisionally_approved" && report.strict) {
      report.errors.push(`${label} is provisionally approved; explicit user or CI approval is required for strict gate`);
    }
    report.checked.push(label);
  }
}

export function executionContextForStory(context, storyId) {
  const story = readStory(context, storyId);
  if (!story?.contract_id) return null;
  const contract = readContractById(context, story.contract_id, { missingOk: true });
  return contract ? contractExecutionContext(contract) : null;
}

export function validateHandoffs(context, report, storyId = null) {
  const handoffs = readHandoffs(context).filter((handoff) => !storyId || handoff.story_id === storyId);
  for (const handoff of handoffs) {
    const label = `handoff ${handoff.id || "unknown"}`;
    if (!handoff.id || !handoff.story_id || !handoff.status || !handoff.to_agent) {
      report.errors.push(`${label} is missing id, story_id, status, or to_agent`);
    }
    if (handoff.story_id && !readStory(context, handoff.story_id)) {
      report.errors.push(`${label} references missing story ${handoff.story_id}`);
    }
    if (!HANDOFF_STATUSES.has(String(handoff.status || "").toLowerCase())) {
      report.errors.push(`${label} has unknown status '${handoff.status}'`);
    }
    for (const artifact of handoff.required_artifacts || []) {
      const artifactPath = resolveProjectFilePath(context, artifact, { mustExist: false });
      if (!fs.existsSync(artifactPath)) {
        report.errors.push(`${label} references missing required artifact ${artifact}`);
      } else if (isDerivedArtifactPath(context, artifactPath)) {
        report.errors.push(`${label} uses derived cache/index artifact ${artifact} as handoff evidence`);
      }
    }
    const openItems = Array.isArray(handoff.open_items) ? handoff.open_items.filter(Boolean) : [];
    if (openItems.length > 0) {
      const severity = report.strict && context.config.handoff_policy?.open_items_block_strict_gate !== false ? "errors" : "warnings";
      report[severity].push(`${label} has open items: ${openItems.join("; ")}`);
    }
    if (handoff.status === "open") {
      const severity = report.strict && context.config.handoff_policy?.open_items_block_strict_gate !== false ? "warnings" : "warnings";
      report[severity].push(`${label} is still open`);
    }
    report.checked.push(label);
  }
}

export function validateRequirementLineage(context, report, storyId = null) {
  const scopedIds = storyId ? new Set(readStory(context, storyId)?.links?.requirements || []) : null;
  const allRequirements = safeReadDir(requirementsRoot(context))
    .filter((name) => name.endsWith(".json"))
    .map((name) => readProjectJson(context, path.join(requirementsRoot(context), name)))
    .filter((requirement) => requirement.schema_version === "requirement:v2");
  const scopedLogicalIds = scopedIds
    ? new Set(allRequirements.filter((item) => scopedIds.has(item.id)).map((item) => item.logical_id))
    : null;
  const relevant = scopedLogicalIds
    ? allRequirements.filter((item) => scopedLogicalIds.has(item.logical_id))
    : allRequirements;
  const byId = new Map(relevant.map((item) => [item.id, item]));
  const groups = new Map();
  for (const requirement of relevant) {
    const values = groups.get(requirement.logical_id) || [];
    values.push(requirement);
    groups.set(requirement.logical_id, values);
  }
  for (const [logicalId, requirements] of groups) {
    const revisions = new Set();
    const children = new Map();
    for (const requirement of requirements) {
      if (revisions.has(requirement.revision)) {
        report.errors.push(`requirement lineage ${logicalId} contains duplicate revision ${requirement.revision}`);
      }
      revisions.add(requirement.revision);
      const previous = requirement.previous_revision_ref;
      if (requirement.revision === 1) {
        if (previous !== null) report.errors.push(`requirement ${requirement.id} revision 1 must not have a parent`);
        continue;
      }
      const parent = byId.get(previous?.id);
      if (!parent || parent.logical_id !== logicalId) {
        report.errors.push(`requirement ${requirement.id} references a missing or cross-lineage parent`);
        continue;
      }
      const expected = buildRequirementRef(parent, toProjectPath(context, requirementPath(context, parent.id)));
      if (
        requirement.revision !== parent.revision + 1
        || previous.revision !== expected.revision
        || previous.content_hash !== expected.content_hash
      ) {
        report.errors.push(`requirement ${requirement.id} is not the exact direct child of ${parent.id}`);
      }
      const childIds = children.get(parent.id) || [];
      childIds.push(requirement.id);
      children.set(parent.id, childIds);
    }
    for (const [parentId, childIds] of children) {
      if (childIds.length > 1) {
        report.errors.push(`requirement lineage ${logicalId} forks at ${parentId}: ${childIds.sort().join(", ")}`);
      }
    }
    const approvedHeads = requirements.filter((requirement) =>
      requirement.status === "approved"
      && effectiveRequirementStatus(context, requirement).status !== "superseded");
    if (approvedHeads.length > 1) {
      report.errors.push(`requirement lineage ${logicalId} has multiple approved heads: ${approvedHeads.map((item) => item.id).sort().join(", ")}`);
    }
    report.checked.push(`requirement lineage ${logicalId}`);
  }
  for (const event of requirementSupersessionEvents(context)) {
    const current = byId.get(event.requirement_ref?.id);
    const replacement = byId.get(event.replacement_ref?.id);
    if (!current && !replacement) continue;
    if (
      !current
      || !replacement
      || replacement.previous_revision_ref?.id !== current.id
      || replacement.revision !== current.revision + 1
      || event.requirement_ref?.content_hash !== requirementContentHash(current)
      || event.replacement_ref?.content_hash !== requirementContentHash(replacement)
    ) {
      report.errors.push(`requirement lifecycle event ${event.id || "unknown"} does not bind a direct immutable revision edge`);
    }
  }
}

export function validateContracts(
  context,
  report,
  contractIds = null,
  validationContext = {},
) {
  const contractsRoot = path.join(context.sdlcRoot, "contracts");
  const files = safeReadDir(contractsRoot).filter((name) => {
    if (!name.endsWith(".json")) {
      return false;
    }
    if (!contractIds) {
      return true;
    }
    return contractIds.has(path.basename(name, ".json"));
  });
  if (files.length === 0) {
    report.errors.push("No contracts found under .sdlc/contracts");
    return;
  }
  for (const file of files) {
    const contract = readProjectJson(context, path.join(contractsRoot, file));
    const label = `contract ${file}`;
    appendRecordSchemaIssues(report, contract, "contract.schema.json", label);
    for (const field of context.config.gate_policy.contract_required_fields) {
      if (contract[field] === undefined || contract[field] === null || contract[field] === "") {
        report.errors.push(`${label} is missing required field '${field}'`);
      }
    }
    for (const field of ["inputs", "outputs", "validation", "allowed_tools", "kb_writes"]) {
      if (!Array.isArray(contract[field]) || contract[field].length === 0) {
        report.errors.push(`${label} field '${field}' must be a non-empty array`);
      }
    }
    if (!context.config.phases[contract.phase]) {
      report.errors.push(`${label} has unknown phase '${contract.phase}'`);
    }
    if (!contract.project || !contract.project.project_id || !contract.project.project_name) {
      report.errors.push(`${label} must be bound to a project with project_id and project_name`);
    }
    if (!contract.contextualization || typeof contract.contextualization !== "object") {
      report.errors.push(`${label} must include contextualization metadata`);
    } else if (report.strict) {
      if (!contract.contextualization.summary) {
        report.errors.push(`${label} strict gate requires contextualization.summary`);
      }
      const openQuestionCount = (contract.contextualization.questions || []).filter(
        (question) => question?.status !== "answered",
      ).length;
      if (Number(contract.contextualization.open_questions || 0) !== openQuestionCount) {
        report.errors.push(
          `${label} contextualization.open_questions does not match the ${openQuestionCount} open question record(s)`,
        );
      }
      if (openQuestionCount > 0) {
        report.errors.push(`${label} strict gate blocks open contract questions`);
      }
    }
    validateContractApprovals(context, report, contract, label);
    validateContractContextSources(context, report, contract, label);
    if (report.strict && contract.human_gate === true && contract.status !== "approved") {
      report.errors.push(`${label} strict gate requires contract.status to be approved`);
    }
    if (report.strict && contract.human_gate === true && !hasApprovedContractApproval(contract)) {
      report.errors.push(`${label} strict gate requires an approved human gate record`);
    }
    if (report.strict && contract.human_gate === true && !hasFreshApprovedContractApproval(contract)) {
      report.errors.push(`${label} approved human gate is stale or missing approved_content_hash; re-approve the contract`);
    }
    validateContractOutputRefs(
      context,
      report,
      contract,
      label,
      validationContext,
    );
    validateExecutionPolicy(context, contract, label, report);
    validateCapabilityBindings(context, contract, label, report);
    validateContractCapabilityRecommendations(context, report, contract, label);
    if ((contract.requirement_execution_profile_refs || []).length > 0) {
      try {
        const deliveryProfile = validateContractAutonomyBinding(context, contract);
        if (deliveryProfile) {
          const executionState = currentDeliveryExecutionState(context, deliveryProfile);
          validateDeliveryExecutionReceipts(context, report, deliveryProfile, executionState, label);
          if (executionState.lifecycle_status !== "terminal") {
            const { decision } = evaluateDeliveryAutonomy(context, deliveryProfile, {
              id: `AUT-GATE-${uniqueRecordSuffix()}`,
              phase: contract.phase,
            });
            const invalidSources = decision.source_constraints.filter((constraint) => !constraint.valid);
            if (decision.blocked || invalidSources.length > 0) {
              report.errors.push(
                `${label} autonomy decision is not valid: ${[
                  ...decision.reason_codes,
                  ...invalidSources.flatMap((constraint) => constraint.reason_codes),
                ].filter(Boolean).join(", ") || "unknown boundary"}`,
              );
            }
          }
          report.checked.push(`delivery autonomy profile ${deliveryProfile.id}`);
        }
      } catch (error) {
        report.errors.push(`${label} autonomy validation failed: ${error.message}`);
      }
    } else if (report.strict) {
      report.warnings.push(`${label} has no requirement:v2 autonomy bindings and is restricted to supervised legacy behavior`);
    }
    report.checked.push(label);
  }
}

export function validateContractContextSources(context, report, contract, label) {
  const executionContext = contractExecutionContext(contract);
  for (const source of contract.contextualization?.context_sources || []) {
    const sourcePath = source?.path || source;
    if (!sourcePath) {
      report.errors.push(`${label} has a context source without path`);
      continue;
    }
    let snapshot;
    try {
      snapshot = stableContextSourceSnapshot(context, sourcePath, "Contract context source");
    } catch (error) {
      report.errors.push(`${label} context source ${sourcePath} is invalid: ${error.message}`);
      continue;
    }
    if (!source.sha256) {
      report.errors.push(`${label} context source ${sourcePath} has no recorded hash`);
      continue;
    }
    const currentMatches = snapshot.sha256 === source.sha256;
    if (!currentMatches) {
      const evolution = executionContext
        ? executionContextSourceEvolution(context, {
            ...executionContext,
            sourcePath,
            expectedSha256: source.sha256,
            bindingKind: "contract_context",
            bindingId: contract.id,
          })
        : { allowed: false };
      if (!evolution.allowed) {
        report.errors.push(
          `${label} context source ${sourcePath} is missing or changed outside its approved pre-change snapshot. `
          + executionContextRecoveryMessage(sourcePath),
        );
      }
    }
  }
}

export function validateTraces(context, report, storyId = null, options = {}) {
  const tracesRoot = path.join(context.sdlcRoot, "traces");
  const candidates = new Map();
  const addCandidate = (filePath, required = false) => {
    const resolved = path.resolve(filePath);
    candidates.set(resolved, Boolean(candidates.get(resolved)) || required);
  };
  if (storyId) {
    addCandidate(
      path.join(tracesRoot, `${storyId}.jsonl`),
      options.required === true || storyTraceIsExpected(context, storyId),
    );
  } else if (options.projectOnly) {
    const projectTrace = path.join(tracesRoot, "project.jsonl");
    const projectCheckpoint = traceIntegrityCheckpointPath(projectTrace);
    if (fs.existsSync(projectTrace) || fs.existsSync(projectCheckpoint)) {
      addCandidate(projectTrace);
    }
  } else {
    for (const filePath of walkFiles(tracesRoot).filter((candidate) => candidate.endsWith(".jsonl"))) {
      addCandidate(filePath);
    }
    const integrityRoot = path.join(tracesRoot, ".integrity");
    for (const checkpointPath of walkFiles(integrityRoot).filter((candidate) => candidate.endsWith(".jsonl.checkpoint.json"))) {
      const traceName = path.basename(checkpointPath, ".checkpoint.json");
      addCandidate(path.join(tracesRoot, traceName));
    }
    const storiesRoot = path.join(context.sdlcRoot, "stories");
    for (const candidateStoryId of safeReadDir(storiesRoot)) {
      if (storyTraceIsExpected(context, candidateStoryId)) {
        addCandidate(path.join(tracesRoot, `${candidateStoryId}.jsonl`), true);
      }
    }
  }
  const files = [...candidates.keys()].sort();
  const requireActor = context.config.trace_policy?.require_actor !== false;
  for (const filePath of files) {
    // CLI diagnostics are a portable public contract. Do not leak the host
    // path separator into JSON reports or human-readable gate output.
    const relativeTracePath = path.relative(context.sdlcRoot, filePath).split(path.sep).join("/");
    const label = `trace ${relativeTracePath}`;
    const traceExists = fs.existsSync(filePath);
    const checkpointExists = fs.existsSync(traceIntegrityCheckpointPath(filePath));
    if (!traceExists && !checkpointExists) {
      if (candidates.get(filePath)) {
        report.errors.push(`${label} is missing for a story whose governed work has started`);
      }
      continue;
    }
    let snapshotPresent = traceExists;
    try {
      withTraceIntegritySnapshot({
        boundaryRoot: context.sdlcRoot,
        tracePath: filePath,
        hooks: traceGateSnapshotTestHooks(filePath),
      }, ({ integrity, records, present }) => {
        snapshotPresent = present;
        if (!integrity.valid) {
          const entries = Array.isArray(integrity.errors) ? integrity.errors : [];
          if (entries.length === 0) {
            report.errors.push(`${label} failed local integrity verification`);
          }
          for (const entry of entries) {
            report.errors.push(`${label} integrity ${entry.code || "invalid"} at ${entry.scope || "trace"}`);
          }
        }
        if (integrity.initialized) report.checked.push(`${label} local integrity checkpoint`);
        if (present) {
          validateTraceSnapshotRecords(context, report, filePath, label, records, requireActor);
        }
      });
    } catch (error) {
      const code = /^[a-z][a-z0-9_.-]{0,63}$/u.test(String(error?.code || ""))
        ? error.code
        : "verification_failed";
      report.errors.push(`${label} local integrity verification failed (${code})`);
    }
    if (!snapshotPresent) continue;
    report.checked.push(label);
  }
}

export function validateTraceSnapshotRecords(context, report, filePath, label, records, requireActor) {
  const fileName = path.basename(filePath, ".jsonl");
  const expectedStoryId = fileName === "project" ? null : fileName;
  const latestOutcomeEvents = new Map();
  const evidencePolicyBindings = collectTraceEvidencePolicyBindings(context, report, records, label);
  for (const record of records) {
    const index = record.line - 1;
    if (!record.valid) {
      report.errors.push(`${label}:${record.line} is not valid JSON`);
      continue;
    }
    const event = record.event;
    if (!TRACE_TYPES.has(event.type)) {
      report.errors.push(`${label}:${index + 1} has unknown type '${event.type}'`);
    }
    if ((event.story_id || null) !== expectedStoryId) {
      report.errors.push(`${label}:${index + 1} story_id must match ${expectedStoryId || "project trace"}`);
    }
    if (event.story_id && !readStory(context, event.story_id)) {
      report.errors.push(`${label}:${index + 1} references missing story ${event.story_id}`);
    }
    if (!event.summary || typeof event.summary !== "string") {
      report.errors.push(`${label}:${index + 1} is missing summary`);
    }
    if (!event.created_at || typeof event.created_at !== "string") {
      report.errors.push(`${label}:${index + 1} is missing created_at`);
    }
    if (requireActor && !hasTraceActor(event)) {
      report.errors.push(`${label}:${index + 1} is missing actor attribution`);
    }
    if (event.requested_by !== undefined && event.requested_by !== null && !hasActorAttribution(event.requested_by)) {
      report.errors.push(`${label}:${index + 1} has invalid requested_by attribution`);
    }
    if (event.authorized_by !== undefined && event.authorized_by !== null && !hasActorAttribution(event.authorized_by)) {
      report.errors.push(`${label}:${index + 1} has invalid authorized_by attribution`);
    }
    if (!event.action || typeof event.action !== "string") {
      report.errors.push(`${label}:${index + 1} is missing action`);
    }
    if (!event.git || typeof event.git !== "object") {
      report.errors.push(`${label}:${index + 1} is missing git metadata`);
    }
    if (!event.run || typeof event.run !== "object") {
      report.errors.push(`${label}:${index + 1} is missing run metadata`);
    }
    validateProtectedAutonomyTrace(context, report, event, `${label}:${index + 1}`);
    if (report.strict && event._trace_integrity) {
      validateTraceEvidenceRefs(
        context,
        report,
        event,
        `${label}:${index + 1}`,
        evidencePolicyBindings,
      );
    }
    if (report.strict && ["test", "release"].includes(event.type)) {
      validateTraceEvidence(context, report, event, `${label}:${index + 1}`);
      latestOutcomeEvents.set(event.type, { event, line: index + 1 });
    }
  }
  for (const [type, latest] of latestOutcomeEvents) {
    const acceptableOutcomes = type === "test" ? ["passed"] : ["ready", "passed"];
    if (!acceptableOutcomes.includes(latest.event.outcome)) {
      report.errors.push(
        `${label}:${latest.line} latest ${type} trace outcome must be ${acceptableOutcomes.join(" or ")}, found '${latest.event.outcome || "missing"}'`,
      );
    }
  }
}

export function traceGateSnapshotTestHooks(filePath) {
  if (process.env.NODE_ENV !== "test") return {};
  const traceName = path.basename(filePath);
  const requested = process.env.AGENTIC_SDLC_TEST_TRACE_GATE_SWAP;
  const targetPath = requested === traceName
    ? filePath
    : requested === `${traceName}.checkpoint`
      ? traceIntegrityCheckpointPath(filePath)
      : null;
  if (!targetPath) return {};
  return {
    after_snapshot_verified() {
      // Deliberate NODE_ENV=test-only adversarial mutation. Production trace
      // writes use traceIntegrityGovernanceDependencies above.
      const bytes = fs.readFileSync(targetPath);
      if (process.platform === "win32") {
        fs.appendFileSync(targetPath, " ");
        return;
      }
      const replacement = `${targetPath}.test-semantic-swap`;
      fs.writeFileSync(replacement, bytes);
      fs.renameSync(replacement, targetPath);
    },
  };
}

export function storyTraceIsExpected(context, storyId) {
  return fs.existsSync(path.join(context.sdlcRoot, "stories", storyId, "task-start.json"));
}

export function validateProtectedAutonomyTrace(context, report, event, label) {
  if (!event.story_id) return;
  const mappedAction = {
    "sync.commit": "git.commit",
    "sync.push": "git.push",
    "sync.merge": "pull_request.merge",
    "git.commit": "git.commit",
    "git.push": "git.push",
    "pull_request.merge": "pull_request.merge",
    "release.local": "release.local",
  }[event.action];
  if (!mappedAction) return;
  const requiredStatus = event.action === mappedAction && event.outcome === "ready"
    ? "authorized"
    : "completed";
  const evidence = new Set(Array.isArray(event.evidence) ? event.evidence : []);
  const related = new Set(Array.isArray(event.related) ? event.related : []);
  const actionsRoot = path.resolve(autonomyActionsRoot(context));
  const matching = [];
  for (const evidencePath of evidence) {
    try {
      const resolved = resolveProjectFilePath(context, evidencePath, { mustExist: true, fileOnly: true });
      const relative = path.relative(actionsRoot, resolved);
      if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || path.dirname(relative) !== ".") {
        continue;
      }
      const receipt = readDeliveryLifecycleReceipt(
        context,
        resolved,
        "delivery-action-receipt.schema.json",
      );
      const profile = readDeliveryAutonomyProfile(context, receipt.profile_ref?.id || "missing", { missingOk: true });
      const executionState = profile ? currentDeliveryExecutionState(context, profile) : null;
      const start = executionState?.start_receipt;
      const startStoryRef = (profile?.story_refs || []).find((ref) => ref.id === start?.story_ref?.id);
      if (
        !profile
        || !start
        || receipt.profile_ref?.hash !== profile.profile_hash
        || receipt.delivery?.id !== profile.delivery_id
        || receipt.delivery?.kind !== profile.delivery_kind
        || start.profile_ref?.id !== profile.id
        || start.profile_ref?.hash !== profile.profile_hash
        || start.delivery?.id !== profile.delivery_id
        || start.delivery?.kind !== profile.delivery_kind
        || start.story_ref?.id !== event.story_id
        || !startStoryRef
        || start.story_ref?.hash !== startStoryRef.hash
        || !related.has(profile.id)
        || !related.has(profile.delivery_id)
        || receipt.action !== mappedAction
        || receipt.status !== requiredStatus
        || path.basename(resolved) !== `${normalizeId(receipt.id)}.json`
      ) {
        continue;
      }
      if (event.action === "sync.commit" && event.git?.after_sha
        && receipt.action_details?.commit?.after_sha !== event.git.after_sha) {
        continue;
      }
      if (event.action === "sync.push" && (
        (event.git?.after_sha && receipt.action_details?.push?.source_sha !== event.git.after_sha)
        || (event.git?.remote && receipt.action_details?.push?.remote !== event.git.remote)
      )) {
        continue;
      }
      if (event.action === "sync.merge" && event.git?.pr_url
        && canonicalAbsoluteUrl(receipt.action_details?.merge?.pr_url) !== canonicalAbsoluteUrl(event.git.pr_url)) {
        continue;
      }
      matching.push(receipt);
    } catch (error) {
      if (String(evidencePath).replace(/\\/gu, "/").startsWith(`${SDLC_DIR}/autonomy/actions/`)) {
        report.errors.push(`${label} cannot validate protected action receipt ${evidencePath}: ${error.message}`);
      }
    }
  }
  if (matching.length !== 1) {
    report.errors.push(
      `${label} protected action ${event.action} requires one exact ${requiredStatus} ${mappedAction} receipt in trace evidence`,
    );
  }
}

/**
 * The lifecycle phases the story gates enforce against.
 *
 * Workflow transitions never rewrite story.json, so a story bound to a valid
 * workflow instance is in the instance's current phase and nowhere else. A
 * caller that already holds the replayed runtime passes its phase; otherwise
 * the bound instance is read here. A story without a readable bound workflow
 * keeps the phase and status its story.json records.
 */
export function storyGatePhases(context, storyId, story, workflowPhase = null) {
  let phase = workflowPhase;
  if (!phase) {
    try {
      const selected = currentStoryBoundWorkflowInstance(context, storyId, { errors: [] });
      const runtime = selected
        ? inspectStoryWorkflowLifecycleRuntime(context, selected, storyId)
        : null;
      phase = runtime?.valid ? runtime.current_phase : null;
    } catch {
      phase = null;
    }
  }
  return new Set(phase ? [phase] : [story.phase, story.status].filter(Boolean));
}

export function validateStory(
  context,
  storyId,
  report,
  { skipChangedPathScope = false, workflowPhase = null } = {},
) {
  const storyDir = path.join(context.sdlcRoot, "stories", storyId);
  const storyPath = path.join(storyDir, "story.json");
  if (!fs.existsSync(storyPath)) {
    report.errors.push(`Story ${storyId} is missing story.json`);
    return;
  }
  const story = normalizeStoryRecord(readProjectJson(context, storyPath));
  const executionContext = executionContextForStory(context, storyId);
  for (const field of context.config.gate_policy.story_required_fields) {
    if (story[field] === undefined || story[field] === null || story[field] === "") {
      report.errors.push(`Story ${storyId} is missing required field '${field}'`);
    }
  }
  if (story.id !== storyId) {
    report.errors.push(`Story ${storyId} story.json id '${story.id}' must match its folder id`);
  }
  if (!STORY_STATUSES.has(String(story.status || "").toLowerCase())) {
    report.errors.push(`Story ${storyId} has unknown status '${story.status}'`);
  }
  if (!context.config.phases[story.phase]) {
    report.errors.push(`Story ${storyId} has unknown phase '${story.phase}'`);
  }
  // gate_policy.implementation_requires_acceptance_criteria, read from the
  // effective project configuration like its sibling implementation_requires_claim.
  // Defaults to enabled, which is the behaviour this check already had.
  if (
    context.config.gate_policy?.implementation_requires_acceptance_criteria !== false
    && storyAcceptanceCriteria(story).length === 0
  ) {
    const severity = story.status === "draft" ? "warnings" : "errors";
    report[severity].push(`Story ${storyId} has no acceptance criteria`);
  }
  if (story.contract_review_required) {
    const staleContractId = story.contract_review_required.contract_id
      || story.contract_id
      || "the previous contract";
    report.errors.push(
      `Story ${storyId} acceptance criteria changed after contract ${staleContractId}; `
      + "create and approve a new exact contract ID before governed lifecycle work can continue",
    );
  }
  const isImplementationLike = ["implementation", "in_progress", "review", "validation", "release", "done"].includes(
    String(story.status),
  ) || story.phase === "implementation";
  const currentPhaseCompleted = readStoryStepRecords(context, storyId).some(
    (record) => record.status === "completed" && record.phase === story.phase,
  );
  const requiresActiveClaim = isImplementationLike && story.status !== "done" && !currentPhaseCompleted;
  if (context.config.gate_policy.implementation_requires_claim && isImplementationLike) {
    const claimPath = path.join(storyDir, "claim.json");
    if (!fs.existsSync(claimPath)) {
      if (requiresActiveClaim) {
        report.errors.push(`Story ${storyId} requires an active claim before implementation`);
      }
    } else {
      const claim = readProjectJson(context, claimPath);
      validateClaim(context, storyId, claim, report, { requireActive: requiresActiveClaim });
    }
  }
  if (story.contract_id) {
    let contract = null;
    try {
      contract = readContractById(context, story.contract_id, { missingOk: true });
    } catch (error) {
      report.errors.push(`Story ${storyId} has invalid contract_id '${story.contract_id}': ${error.message}`);
    }
    if (!contract) {
      report.errors.push(`Story ${storyId} references missing contract ${story.contract_id}`);
    } else {
      if (contract.story_id !== storyId) {
        report.errors.push(`Story ${storyId} contract ${story.contract_id} is bound to ${contract.story_id || "the project"}`);
      }
    }
  } else {
    const severity = report.strict ? "errors" : "warnings";
    report[severity].push(`Story ${storyId} has no contract_id`);
  }
  const requirementIds = Array.isArray(story.links?.requirements) ? story.links.requirements.filter(Boolean) : [];
  const storyRequirementProfiles = [];
  if (story.proposal_ref && requirementIds.length === 0) {
    report.errors.push(`Story ${storyId} is proposal-bound but has no canonical requirement link`);
  }
  for (const requirementId of requirementIds) {
    const requirement = readRequirement(context, requirementId, { missingOk: true });
    if (!requirement) {
      const severity = story.proposal_ref || report.strict ? "errors" : "warnings";
      report[severity].push(`Story ${storyId} references missing requirement ${requirementId}`);
      continue;
    }
    appendRecordSchemaIssues(report, requirement, "requirement.schema.json", `requirement ${requirementId}`);
    if (requirement.schema_version === "requirement:v2") {
      const label = `requirement ${requirementId}`;
      const integrity = validateRequirementIntegrity(requirement);
      for (const error of integrity.errors || []) {
        report.errors.push(`${label}: ${error}`);
      }
      if (requirement.status !== "approved" || !isApprovedRecordFresh(requirement)) {
        report.errors.push(`${label} must have a fresh formal approval`);
      }
      for (const stale of validateRequirementSourceHashes(context, requirement, label, {
        executionContext,
      })) {
        report.errors.push(`${label} source ${stale.path} is missing or changed. ${stale.recovery}`);
      }
      if (effectiveRequirementStatus(context, requirement).status === "superseded") {
        report.errors.push(`${label} is superseded and cannot remain an active story input`);
      }
      const exactRef = (story.requirement_refs || []).find((ref) => ref.id === requirementId);
      const expectedRef = buildRequirementRef(
        requirement,
        toProjectPath(context, requirementPath(context, requirementId)),
      );
      if (
        !exactRef
        || exactRef.content_hash !== expectedRef.content_hash
        || exactRef.revision !== expectedRef.revision
      ) {
        report.errors.push(`Story ${storyId} has no current exact binding for ${label}`);
      }
      try {
        const profile = readRequirementAutonomyProfile(context, requirement.autonomy_profile_id);
        storyRequirementProfiles.push(profile);
        appendRecordSchemaIssues(
          report,
          profile,
          "requirement-execution-profile.schema.json",
          `requirement autonomy profile ${profile.id}`,
        );
        if (profile.status !== "active" || profile.requirement_ref.hash !== requirementContentHash(requirement)) {
          report.errors.push(`${label} autonomy profile ${profile.id} is inactive or stale`);
        }
        validateAutonomyApprovalRef(context, profile, `Requirement autonomy profile ${profile.id}`);
        report.checked.push(`requirement autonomy profile ${profile.id}`);
      } catch (error) {
        report.errors.push(`${label} autonomy validation failed: ${error.message}`);
      }
    } else if (report.strict) {
      report.warnings.push(`requirement ${requirementId} is legacy requirement:v1 and is restricted to supervised autonomy`);
    }
    if (
      story.proposal_ref &&
      (requirement.proposal_ref?.id !== story.proposal_ref.id || requirement.proposal_ref?.hash !== story.proposal_ref.hash)
    ) {
      report.errors.push(`Story ${storyId} and requirement ${requirementId} are bound to different proposal content`);
    }
  }
  if (
    report.strict
    && !skipChangedPathScope
    && context.config.gate_policy?.strict_mode?.requires_write_scope_integrity !== false
    && storyRequirementProfiles.length > 0
  ) {
    validateStoryChangedPathsWithinRequirementScope(context, storyId, storyRequirementProfiles, report);
  }
  const traceEvents = readTraceEvents(context, storyId);
  const phases = storyGatePhases(context, storyId, story, workflowPhase);
  validateStoryTestEvidence(context, storyId, story, traceEvents, report, { phases });
  // The lifecycle-complete gate re-checks the scan so commits made after
  // validation are covered. Re-validating an already sealed receipt skips it,
  // like the changed-path scope: the head may move once the story is certified.
  validateStorySecretScanEvidence(context, storyId, story, report, {
    phases,
    required: report.lifecycle_complete === true && !skipChangedPathScope,
  });
  // gate_policy.release_requires_release_trace, read from the effective project
  // configuration like validation_requires_test_trace. Defaults to enabled.
  const latestReleaseTrace = latestTraceEvent(traceEvents, "release");
  if (
    context.config.gate_policy?.release_requires_release_trace !== false
    && phases.has("release")
    && !["ready", "passed"].includes(latestReleaseTrace?.outcome)
  ) {
    report.errors.push(`Story ${storyId} is in release but has no ready release trace`);
  }
  validateStoryBreakdown(context, story, report);
  validateStoryDependencies(context, story, report);
  validateStoryStepRecords(context, storyId, report);
  report.checked.push(`story ${storyId}`);
}

export function validateStoryChangedPathsWithinRequirementScope(context, storyId, requirementProfiles, report) {
  if (execGit(context.root, ["rev-parse", "--is-inside-work-tree"]) !== "true") {
    report.errors.push(
      `Story ${storyId} cannot verify approved write paths because the project is not a Git worktree`,
    );
    return;
  }
  const taskStartPath = path.join(context.sdlcRoot, "stories", storyId, "task-start.json");
  const taskStart = fs.existsSync(taskStartPath) ? readProjectJson(context, taskStartPath) : null;
  const baselineSha = taskStart?.audit?.git?.head_sha || null;
  if (
    !baselineSha
    || !/^[a-f0-9]{40,64}$/iu.test(baselineSha)
    || !gitCommandSucceeds(context.root, ["cat-file", "-e", `${baselineSha}^{commit}`])
    || !gitCommandSucceeds(context.root, ["merge-base", "--is-ancestor", baselineSha, "HEAD"])
  ) {
    report.errors.push(
      `Story ${storyId} changed-path scope has no verifiable task-start Git baseline`,
    );
    return;
  }
  const committedPaths = String(
    execGit(context.root, ["diff", "--name-only", "--no-renames", `${baselineSha}..HEAD`, "--"]) || "",
  ).split(/\r?\n/u).map((item) => item.trim()).filter(Boolean);
  const allowedWritePaths = [...new Set(requirementProfiles.flatMap((profile) =>
    profile.constraints?.allowed_write_paths || []))];
  const outsideApprovedScope = (filePath) =>
    allowedWritePaths.length === 0
    || !pathMatchesApprovedWriteScope(filePath, allowedWritePaths);
  const committedOutside = committedPaths
    .filter((filePath) => filePath !== SDLC_DIR && !filePath.startsWith(`${SDLC_DIR}/`))
    .filter(outsideApprovedScope);
  const currentWorkspace = currentWorkspaceChanges(context);
  const storyExecutionContext = executionContextForStory(context, storyId);
  const startedPreflight = readStartedExecutionContextPreflight(
    context,
    storyExecutionContext || {},
  );
  const currentByPath = new Map(currentWorkspace.map((entry) => [entry.path, entry]));
  const workspaceOutside = currentWorkspace
    .filter((entry) => outsideApprovedScope(entry.path))
    .filter((entry) => (
      !startedPreflight.receipt
      || !workspaceChangeMatchesPreflight(startedPreflight.receipt, entry)
    ))
    .map((entry) => entry.path);
  const removedOrRestoredPreexistingOutside = (startedPreflight.receipt?.workspace_changes || [])
    .filter((entry) => outsideApprovedScope(entry.path))
    .filter((entry) => !currentByPath.has(entry.path))
    .map((entry) => entry.path);
  const outside = [...new Set([
    ...committedOutside,
    ...workspaceOutside,
    ...removedOrRestoredPreexistingOutside,
  ])].sort();
  if (outside.length > 0) {
    report.errors.push(
      `Story ${storyId} changed files outside the approved requirement write paths: ${outside.join(", ")} (detected after task preflight)`,
    );
  }
  report.checked.push(`story ${storyId} changed-path scope`);
}

export function validateStoryLifecycleCompletion(context, storyId, report) {
  const steps = readStoryStepRecords(context, storyId)
    .filter((record) => record.status === "completed");
  const completedPhases = new Set(steps.map((record) => record.phase));
  const requiredPhases = normalizeListValue(
    context.config.phase_order,
    ["discovery", "analysis", "design", "implementation", "validation", "release"],
  );
  const missingPhases = requiredPhases.filter((phase) => !completedPhases.has(phase));
  if (missingPhases.length > 0) {
    report.errors.push(
      `Story ${storyId} lifecycle completion requires completed phases: ${missingPhases.join(", ")}`,
    );
  }

  const orderedCompletions = requiredPhases
    .map((phase) => steps
      .filter((record) => record.phase === phase)
      .sort((left, right) => String(left.completed_at).localeCompare(String(right.completed_at)))[0])
    .filter(Boolean);
  for (let index = 1; index < orderedCompletions.length; index += 1) {
    if (Date.parse(orderedCompletions[index].completed_at) < Date.parse(orderedCompletions[index - 1].completed_at)) {
      report.errors.push(
        `Story ${storyId} lifecycle phases were not completed in configured order`,
      );
      break;
    }
  }
  const traceEvents = readTraceEvents(context, storyId);
  const latestTestTrace = latestTraceEvent(traceEvents, "test");
  const latestReleaseTrace = latestTraceEvent(traceEvents, "release");
  if (latestTestTrace?.outcome !== "passed") {
    report.errors.push(`Story ${storyId} lifecycle completion requires the latest test trace to pass`);
  }
  if (latestReleaseTrace?.outcome !== "passed") {
    report.errors.push(`Story ${storyId} lifecycle completion requires the latest release trace to pass`);
  }

  const story = readStory(context, storyId);
  const contract = story?.contract_id
    ? readContractById(context, story.contract_id, { missingOk: true })
    : null;
  const deliveryProfileId = contract?.delivery_execution_profile_id || null;
  let deliveryClosedAt = null;
  if (!deliveryProfileId) {
    report.errors.push(`Story ${storyId} lifecycle completion requires one exact delivery profile`);
  } else {
    try {
      const profile = readDeliveryAutonomyProfile(context, deliveryProfileId);
      const state = currentDeliveryExecutionState(context, profile);
      const successfulStatuses = profile.delivery_kind === "local_release"
        ? ["released"]
        : ["merged", "ready_for_review"];
      if (
        state.lifecycle_status !== "terminal"
        || !successfulStatuses.includes(state.status)
      ) {
        report.errors.push(
          `Story ${storyId} lifecycle completion requires terminal ${profile.delivery_kind} delivery; found ${state.status}`,
        );
      } else {
        deliveryClosedAt = state.close_receipt?.closed_at || null;
      }
      if (profile.local_release_target?.rollback?.verification_required === true) {
        const actions = deliveryActionReceipts(context, profile.id);
        const releaseCompletion = actions.find((receipt) =>
          receipt.id === state.close_receipt?.terminal_action_receipt_ref?.id
          && receipt.receipt_hash === state.close_receipt?.terminal_action_receipt_ref?.hash
          && receipt.action === "release.local"
          && receipt.status === "completed"
          && receipt.outcome === "passed");
        const rollbackRef = releaseCompletion?.local_release_verification
          ?.rollback_verification_receipt_ref;
        const rollbackReceipt = actions.find((receipt) =>
          receipt.id === rollbackRef?.id
          && receipt.receipt_hash === rollbackRef?.hash
          && receipt.action === "rollback.verify"
          && receipt.status === "completed"
          && receipt.outcome === "passed");
        const rollbackErrors = rollbackReceipt
          ? rollbackVerificationReceiptErrors(context, profile, rollbackReceipt, actions)
          : ["no exact passing rollback.verify receipt is bound to the local release"];
        const releaseAuthorization = releaseCompletion
          ? actions.find((receipt) =>
              receipt.id === releaseCompletion.authorization_receipt_ref?.id
              && receipt.receipt_hash === releaseCompletion.authorization_receipt_ref?.hash
              && receipt.action === "release.local"
              && receipt.status === "authorized")
          : null;
        if (
          rollbackReceipt
          && releaseAuthorization
          && compareDeliveryAuthorizationOrder(rollbackReceipt, releaseAuthorization) >= 0
        ) {
          rollbackErrors.push("rollback.verify was not completed before release.local authorization");
        }
        if (rollbackErrors.length > 0) {
          report.errors.push(
            `Story ${storyId} lifecycle completion requires verified rollback evidence for its exact local target and procedure: ${rollbackErrors.join("; ")}`,
          );
        }
        report.checked.push(`story ${storyId} local rollback verification`);
      }
      if (profile.local_release_target?.data_migration) {
        const actions = deliveryActionReceipts(context, profile.id);
        const passing = (action) => actions
          .filter((receipt) =>
            receipt.action === action
            && receipt.status === "completed"
            && receipt.outcome === "passed")
          .sort(compareDeliveryAuthorizationOrder);
        const rollbackReceipts = passing("data.rollback");
        const migrationReceipts = passing("data.migrate");
        const latestRollback = rollbackReceipts.at(-1) || null;
        const finalMigration = latestRollback
          ? migrationReceipts.filter((receipt) =>
              compareDeliveryAuthorizationOrder(latestRollback, receipt) < 0).at(-1) || null
          : null;
        const releaseCompletion = actions.find((receipt) =>
          receipt.id === state.close_receipt?.terminal_action_receipt_ref?.id
          && receipt.receipt_hash === state.close_receipt?.terminal_action_receipt_ref?.hash
          && receipt.action === "release.local"
          && receipt.status === "completed"
          && receipt.outcome === "passed");
        const releaseAuthorization = releaseCompletion
          ? actions.find((receipt) =>
              receipt.id === releaseCompletion.authorization_receipt_ref?.id
              && receipt.receipt_hash === releaseCompletion.authorization_receipt_ref?.hash
              && receipt.action === "release.local"
              && receipt.status === "authorized")
          : null;
        const sequenceResult = releaseAuthorization
          ? reversibleDataReleaseSequence(context, profile, releaseAuthorization)
          : { sequence: null, errors: ["release.local authorization is missing"] };
        if (!latestRollback?.data_operation_verification?.rollback_verified) {
          report.errors.push(
            `Story ${storyId} lifecycle completion requires a passing verified data.rollback for its declared migration`,
          );
        }
        if (!finalMigration) {
          report.errors.push(
            `Story ${storyId} lifecycle completion requires a passing data.migrate after the verified rollback`,
          );
        } else if (
          !releaseCompletion
          || compareDeliveryAuthorizationOrder(finalMigration, releaseCompletion) >= 0
        ) {
          report.errors.push(
            `Story ${storyId} lifecycle completion requires release.local after the final verified data.migrate`,
          );
        }
        if (
          !sequenceResult.sequence
          || stableJson(releaseCompletion?.local_release_verification?.data_migration_sequence)
            !== stableJson(sequenceResult.sequence)
          || stableJson(releaseAuthorization?.action_details?.data_migration_sequence)
            !== stableJson(sequenceResult.sequence)
        ) {
          report.errors.push(
            `Story ${storyId} lifecycle completion requires an exact reversible data release sequence: `
            + `${sequenceResult.errors.join("; ") || "release receipt references differ"}`,
          );
        }
        report.checked.push(`story ${storyId} reversible data migration and rollback verification`);
      }
      report.checked.push(`story ${storyId} terminal delivery ${profile.delivery_id}`);
    } catch (error) {
      report.errors.push(`Story ${storyId} lifecycle delivery cannot be verified: ${error.message}`);
    }
  }
  validateCurrentStoryWorkflowCompletion(context, storyId, report, {
    deliveryClosedAt,
    releaseTrace: latestReleaseTrace,
  });
  report.checked.push(`story ${storyId} complete lifecycle`);
}

export function validateStoryStepRecords(context, storyId, report) {
  const stepsRoot = path.join(context.sdlcRoot, "stories", storyId, "steps");
  for (const fileName of safeReadDir(stepsRoot).filter((name) => name.endsWith(".json"))) {
    const stepPath = path.join(stepsRoot, fileName);
    const record = readProjectJson(context, stepPath);
    const label = `story step ${storyId}/${path.basename(fileName, ".json")}`;
    if (record.story_id !== storyId) {
      report.errors.push(`${label} story_id must match ${storyId}`);
    }
    const validSteps = new Set(configuredStorySteps(context));
    if (!record.step || !validSteps.has(String(record.step))) {
      report.errors.push(`${label} has unknown step '${record.step}'`);
    }
    if (record.status !== "completed") {
      report.errors.push(`${label} has unsupported status '${record.status}'`);
    }
    if (!record.completed_at || !Number.isFinite(Date.parse(String(record.completed_at)))) {
      report.errors.push(`${label} is missing valid completed_at`);
    }
    const stepArtifacts = Array.isArray(record.artifacts) ? record.artifacts : [];
    const stepEvidence = Array.isArray(record.evidence) ? record.evidence : [];
    if (record.artifacts !== undefined && !Array.isArray(record.artifacts)) {
      report.errors.push(`${label} artifacts must be an array`);
    }
    if (record.evidence !== undefined && !Array.isArray(record.evidence)) {
      report.errors.push(`${label} evidence must be an array`);
    }
    for (const item of [...stepArtifacts, ...stepEvidence]) {
      const evidencePath = resolveProjectFilePath(context, item.path || item, { mustExist: false });
      const evidenceLabel = item.path || item;
      if (!fs.existsSync(evidencePath)) {
        report.errors.push(`${label} references missing evidence ${evidenceLabel}`);
      } else if (isDerivedArtifactPath(context, evidencePath)) {
        report.errors.push(`${label} uses derived cache/index evidence ${evidenceLabel}`);
      } else if (item.sha256 && hashFile(evidencePath) !== item.sha256) {
        report.errors.push(`${label} evidence changed after step completion: ${evidenceLabel}`);
      }
    }
    if (report.strict && Array.isArray(record.output_types) && record.output_types.length > 0) {
      const linkedTypes = new Set((record.output_links || []).map((link) => link.artifact_type));
      for (const artifactType of record.output_types) {
        if (!linkedTypes.has(artifactType)) {
          report.errors.push(`${label} completed ${artifactType} without a linked output`);
        }
      }
    }
    if (report.strict && ["validation", "release"].includes(record.step)) {
      const substantiveEvidence = stepArtifacts.length + stepEvidence.length + (record.output_links || []).length;
      if (substantiveEvidence === 0) {
        report.errors.push(`${label} has no artifact, evidence, or linked output`);
      }
      const requiredTraceType = record.step === "validation" ? "test" : "release";
      const acceptableOutcomes = record.step === "validation" ? ["passed"] : ["ready", "passed"];
      const supportingTrace = latestTraceEvent(readTraceEvents(context, storyId), requiredTraceType);
      if (!supportingTrace || !acceptableOutcomes.includes(supportingTrace.outcome)) {
        report.errors.push(`${label} has no ${requiredTraceType} trace with outcome ${acceptableOutcomes.join(" or ")}`);
      }
    }
    validateStoryActionCheckpoint(
      context,
      storyId,
      "story.complete-step",
      record,
      report,
      label,
      {
        artifact_types: Array.isArray(record.output_types) ? record.output_types : [],
        step: record.step,
      },
    );
    report.checked.push(label);
  }
}

export function validateStoryBreakdown(context, story, report) {
  const breakdowns = readBreakdowns(context);
  const storyRefs = new Set([story.id]);
  const referenced = breakdowns.filter((breakdown) =>
    (breakdown.items || []).some((item) => item.type === "story" && storyRefs.has(item.id)) ||
    (story.work_breakdown_id && breakdown.id === story.work_breakdown_id),
  );
  if (referenced.length === 0) {
    return;
  }
  const implementationLike = ["implementation", "in_progress", "review", "validation", "release", "done"].includes(String(story.status)) ||
    ["implementation", "validation", "release"].includes(String(story.phase));
  for (const breakdown of referenced) {
    const label = `breakdown ${breakdown.id}`;
    if (breakdown.status !== "approved") {
      const severity = report.strict && implementationLike ? "errors" : "warnings";
      report[severity].push(`Story ${story.id} references ${label} but it is not approved`);
      continue;
    }
    if (!isApprovedRecordFresh(breakdown)) {
      report.errors.push(`Story ${story.id} references ${label} but its approval is stale; re-approve the breakdown`);
    }
    const approval = latestApprovedRecordApproval(breakdown);
    validateFormalApprovalRecord(context, report, approval, `${label} approval ${approval?.id || "unknown"}`, approval?.approved_by);
  }
}

export function validateStoryDependencies(context, story, report) {
  const graph = readDependencyGraph(context, { missingOk: true });
  const relevant = (graph.edges || []).filter((edge) => edge.from === story.id);
  if (relevant.length === 0) {
    return;
  }
  for (const edge of relevant) {
    const state = inspectDependencyEdge(context, edge, story);
    if (!state.satisfied) {
      const severity = report.strict && state.blocking ? "errors" : "warnings";
      report[severity].push(`Story ${story.id} dependency ${state.message}`);
    }
  }
  for (const cycle of findBlockingDependencyCycles(graph.edges || [])) {
    if (cycle.includes(story.id)) {
      report.errors.push(`Story ${story.id} is part of blocking dependency cycle: ${cycle.join(" -> ")}`);
    }
  }
}

export function validateClaim(context, storyId, claim, report, options = {}) {
  if (claim.story_id !== storyId) {
    report.errors.push(`Story ${storyId} claim.story_id must match story id`);
  }
  if (!CLAIM_STATUSES.has(String(claim.status || "").toLowerCase())) {
    report.errors.push(`Story ${storyId} claim has unknown status '${claim.status}'`);
  }
  if (options.requireActive !== false && claim.status !== "active") {
    report.errors.push(`Story ${storyId} requires an active claim, found '${claim.status}'`);
  } else if (options.requireActive === false && !["active", "released", "transferred"].includes(claim.status)) {
    report.errors.push(`Story ${storyId} completed work has unsupported claim status '${claim.status}'`);
  }
  if (!claim.agent) {
    report.errors.push(`Story ${storyId} active claim is missing agent`);
  }
  if (!claim.branch) {
    report.errors.push(`Story ${storyId} active claim is missing branch`);
  } else {
    const expectedBranches = storyBranchPatterns(context, storyId);
    if (!expectedBranches.includes(claim.branch)) {
      const severity = report.strict && context.config.claim_policy?.require_branch_pattern !== false ? "errors" : "warnings";
      report[severity].push(`Story ${storyId} claim branch '${claim.branch}' does not match expected ${expectedBranches.join(" or ")}`);
    }
  }
  if (claim.expires_at && !Number.isFinite(Date.parse(String(claim.expires_at)))) {
    report.errors.push(`Story ${storyId} active claim has invalid expires_at '${claim.expires_at}'`);
  }
  if (isClaimExpired(context, claim)) {
    report.errors.push(`Story ${storyId} active claim expired at ${effectiveClaimExpiration(context, claim)}`);
  }
  const actor = claim.audit?.claimed_by;
  if (!actor || !actor.id) {
    report.warnings.push(`Story ${storyId} claim has no audit.claimed_by actor`);
  }
  validateStoryActionCheckpoint(
    context,
    storyId,
    "story.claim",
    claim,
    report,
    `Story ${storyId} claim`,
  );
}

export function readTraceEvents(context, storyId) {
  const tracePath = path.join(context.sdlcRoot, "traces", `${storyId}.jsonl`);
  if (!fs.existsSync(tracePath)) {
    return [];
  }
  return readProjectText(context, tracePath)
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { type: "invalid" };
      }
    });
}
