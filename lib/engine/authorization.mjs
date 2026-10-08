import path from "node:path";
import {
  buildAuthorizationUsageReceipt as buildCanonicalAuthorizationUsageReceipt,
  buildHostApprovalReceipt,
  computeAuthorizationSubjectHash,
  createAuthorizationRevocation,
  validateAuthorizationRevocationIntegrity,
  validateAuthorizationSnapshotAtUse,
  validateAuthorizationSnapshotIntegrity,
  validateHostApprovalReceiptAtUse,
} from "../authorization-receipts.mjs";
import {
  validateAutonomyDecisionIntegrity,
  validateDeliveryExecutionProfileIntegrity,
  validateRequirementExecutionProfileIntegrity,
} from "../autonomy-policy.mjs";
import {
  fail,
} from "../cli/user-error.mjs";
import {
  approvalAuthorizationSettings,
  approvalRequestPrimaryCopy,
  approvalSubjectMatchesActiveScope,
  assertBaselineProposalCanResume,
  assessmentApprovalPath,
  assessmentApprovalSubject,
  authorizationAllowsAction,
  authorizationAllowsApprovalBoundary,
  authorizationAllowsArtifactType,
  authorizationAllowsSubject,
  authorizationApprovalBoundaries,
  authorizationArtifactTypes,
  authorizationLifecyclePath,
  authorizationPath,
  authorizationProposalBindingError,
  authorizationReceiptAccepted,
  authorizationRecordHash,
  authorizationRoot,
  authorizationUseKey,
  authorizationUsePath,
  authorizationUsesRoot,
  autonomyApprovalSubject,
  autonomyApprovalsRoot,
  autonomyLifecycleReceiptHash,
  autonomyProfileApprovalProjection,
  baselineProposalIntentHash,
  buildApprovalRecordScope,
  buildBaselineProposalTraceEvent,
  buildLegacyAuthorizationUses,
  canonicalAuthorizationUseSubject,
  capabilityRecommendationNeedsInstallApproval,
  contractDirectApprovalRequirements,
  failBaselineProposalResume,
  formalApprovalActorDescription,
  getApprovalPolicy,
  hasFormalApprovalAttribution,
  hasFreshApprovedContractApproval,
  hashApprovalSubject,
  hashAuthorizationRecord,
  humanApprovalFields,
  isCanonicalContentAuthorization,
  latestApprovedRecordApproval,
  latestContractApproval,
  legacyAuthorizationBindingErrors,
  normalizeApprovalCollectionScope,
  normalizeApprovalSource,
  normalizeApprovalStatus,
  parseLegacyAuthorizationUses,
  profileTaskStartReceiptSchemaName,
  requireFormalApprovalActor,
  sameLegacyAuthorizationProjection,
  validateApprovalSourceForActor,
  validateAuthorizationUseReceipt,
} from "../lifecycle/authorization.mjs";
import {
  capabilityProfilePath,
  capabilityRecommendationPath,
  capabilityRecordMatchesStory,
  formatCapabilityBindingsForUser,
  formatCapabilityEvidenceForUser,
  formatCapabilityInstallNeeds,
  formatCapabilityPolicyPatchForUser,
  formatCapabilityRecommendationsForUser,
  formatCapabilitySubject,
} from "../lifecycle/capability.mjs";
import {
  assertNotDerivedArtifact,
  buildInferredContext,
  getOptionString,
  hashBuffer,
  isApprovedRecordFresh,
  localTargetBuildCompletionDetails,
  localTargetBuildPreconditionDetails,
  localTargetPredecessorStateMatches,
  normalizeArtifactType,
  normalizeAuthorizedActions,
  normalizeId,
  normalizeListOption,
  normalizeOptionalDateTime,
  normalizeRawListOption,
  requireOption,
  shortHash,
  shortHashFull,
  stableJson,
  upsertById,
} from "../lifecycle/common.mjs";
import {
  APPROVAL_SOURCES,
} from "../lifecycle/constants.mjs";
import {
  compareDeliveryAuthorizationOrder,
  deliveryActionReceiptRef,
  deliveryAutonomyPath,
  deliveryStartReceiptPath,
  formatDeliveryFormatOption,
  formatOutputDeliveryForHuman,
  recommendedDeliveryFormatForContract,
} from "../lifecycle/delivery.mjs";
import {
  unbornGitBase,
} from "../lifecycle/git-base.mjs";
import {
  assistantMessagePresentationFields,
  humanGuidanceLines,
  humanGuidanceLocale,
  safePrimaryGuidanceText,
} from "../lifecycle/guidance.mjs";
import {
  canonicalOutputFormatOptions,
  findOutputTemplate,
  formatBaselineCurrentStateSummary,
  formatBaselineDetectedStack,
  formatBaselineImportedDocuments,
  formatBaselineKeyFiles,
  formatDetectedStackForUser,
  formatExplainedOpenQuestion,
  formatLimitedList,
  renderBaselineReport,
  renderTemplate,
} from "../lifecycle/output.mjs";
import {
  assertNoSymlinkPathSegments,
  autonomyDecisionSemanticProjection,
  autonomyDecisionsRoot,
  dependenciesRoot,
  isDerivedArtifactPath,
  isInsidePath,
  toProjectPath,
} from "../lifecycle/project.mjs";
import {
  baselinePathById,
  baselineRoot,
  buildTraceRequestMetadata,
  contractArtifactTypes,
  isIntactBootstrapPhaseContract,
  newestContract,
  requirementPath,
  storyMutationLockPath,
} from "../lifecycle/story.mjs";
import {
  workflowTraceIntentMatches,
} from "../lifecycle/workflow.mjs";
import {
  Date,
  crypto,
  fs,
} from "../runtime/host.mjs";
import {
  readAssessmentApproval,
  selectApprovedAssessmentBaseline,
} from "./assessment.mjs";
import {
  capabilityRecommendationMatchesStory,
  readCapabilityProfiles,
  readCapabilityRecommendations,
  validateCapabilityRecordSourceHashes,
} from "./capability.mjs";
import {
  assertRecordSchema,
  buildActorFromPrefixedOptions,
  buildAttribution,
  buildRepositorySnapshot,
  buildSourceHashes,
  collectJsonFiles,
  collectManifestSourceFiles,
  compactTimestamp,
  explainOpenQuestion,
  now,
  prepareExecutionContextPreflight,
  readStartedExecutionContextPreflight,
  revalidateExecutionContextPreflightSnapshot,
  shortDate,
  uniqueRecordSuffix,
  userVisibleReviewItems,
} from "./common.mjs";
import {
  VERSION,
} from "./definitions.mjs";
import {
  assertCurrentLocalReleaseTargetState,
  buildLocalReleaseTargetSnapshot,
  currentDeliveryExecutionState,
  deliveryFormatOptionsForContract,
  deliveryFormatOptionsForOutput,
  deliveryQuestionForContract,
  effectiveOutputDelivery,
  evaluateDeliveryAutonomy,
  localReleaseTargetContentManifestErrors,
  localReleaseTargetGovernanceState,
  localReleaseTargetSnapshotErrors,
  outputDeliveryIsFresh,
  readDeliveryAutonomyProfile,
  validateCompletedProviderActionReceipt,
  validateDeliveryActionCheckpointPolicySnapshot,
  validateDeliveryActionEvidence,
  validateDeliveryActionHostAuthority,
} from "./delivery.mjs";
import {
  currentUnbornGitBase,
} from "./git.mjs";
import {
  describeContractForHuman,
} from "./guidance.mjs";
import {
  ensureInitialized,
} from "./migration.mjs";
import {
  buildBaselineDocumentEvidence,
  collectOutputLinkActionRequests,
  collectStoryTemplateIds,
  humanOutputLabel,
  output,
  readOutputRegistry,
  readTemplateFile,
  writeOutputRegistry,
} from "./output.mjs";
import {
  detectProjectStack,
  discoverExistingProjectDocuments,
  pathEntryExistsNoFollow,
  resolveProjectFilePath,
} from "./project.mjs";
import {
  inspectTaskStartReplacementBoundary,
} from "./route.mjs";
import {
  collectPendingProposalRequests,
} from "./pending-proposals.mjs";
import {
  STANDING_APPROVAL_SOURCE,
  STANDING_RECEIPT_AUTHORITY_SOURCE,
  buildStandingDerivedApproval,
  standingDerivedApprovalRecordErrors,
  standingReceiptAuthorityErrors,
} from "./standing.mjs";
import {
  acquireFileLock,
  assertWorkflowStoredTraceIntegrityLocked,
  ensureDir,
  hashFile,
  prepareGovernedTraceEvent,
  readProjectFileExcerpt,
  readProjectJson,
  readProjectMarkdownHeadings,
  readProjectSafe,
  readProjectText,
  readStableRegularFileBuffer,
  removePathGoverned,
  safeReadDir,
  sealPreparedTraceEventLocked,
  withOutputRegistryLock,
  workflowTraceIntegritySnapshotLocked,
  writeJsonFile,
  writeTextFile,
} from "./storage.mjs";
import {
  appendTraceEvent,
  buildBaselineRefreshRequest,
  collectContractClarificationRequests,
  collectContractDependencyFreshnessGaps,
  collectContractReadinessGaps,
  contractIsActiveStoryContract,
  ensureBaselineDirectory,
  executionContextForStory,
  normalizeBaselineSourcePaths,
  readContractById,
  readRequirement,
  readStory,
  selectActiveBaselines,
  validateBaselineSourceHashes,
} from "./story.mjs";
import {
  assertNoPendingWorkflowTraceTransaction,
  syncWorkflowFile,
} from "./workflow.mjs";

export function writeTaskStartReceipt(context, decision, attribution, authorization = null) {
  const receiptPath = decision.story_id
    ? path.join(context.sdlcRoot, "stories", decision.story_id, "task-start.json")
    : path.join(context.sdlcRoot, "reports", "project-task-start.json");
  const priorTaskStart = pathEntryExistsNoFollow(receiptPath)
    ? inspectTaskStartReplacementBoundary(context, receiptPath, {
        story_id: decision.story_id,
        contract_id: decision.contract_id,
        delivery_profile_id: decision.delivery_profile_id,
      })
    : null;
  if (priorTaskStart && !priorTaskStart.allowed) {
    fail(
      `Task start is already immutably recorded at ${toProjectPath(context, receiptPath)} `
      + `(${priorTaskStart.reason}). Continue the existing governed run instead of overwriting it.`,
    );
  }
  let previousTaskStartReceiptRef = null;
  if (priorTaskStart) {
    const historyPath = path.join(
      path.dirname(receiptPath),
      "task-start-history",
      `${normalizeId(String(priorTaskStart.receipt.id))}.json`,
    );
    writeTextFile(
      historyPath,
      priorTaskStart.snapshot.content.toString("utf8"),
    );
    previousTaskStartReceiptRef = {
      id: priorTaskStart.receipt.id,
      path: toProjectPath(context, historyPath),
      hash: priorTaskStart.snapshot.sha256,
    };
    decision.previous_task_start_receipt = {
      ...previousTaskStartReceiptRef,
      contract_id: priorTaskStart.receipt.contract_id || null,
      delivery_profile_id: priorTaskStart.receipt.delivery_profile_ref?.id || null,
    };
  }
  const deliveryProfile = decision.delivery_profile_id
    ? readDeliveryAutonomyProfile(context, decision.delivery_profile_id, { missingOk: true })
    : null;
  const preparedPreflight = deliveryProfile && decision.story_id && decision.contract_id
    ? prepareExecutionContextPreflight(context, decision, attribution, { persist: true })
    : null;
  if (preparedPreflight) {
    decision.execution_context_preflight = preparedPreflight.relativePath;
  }
  let autonomyDecisionRef = null;
  let autonomyDecisionPath = null;
  let autonomyDecisionCreated = false;
  if (decision.autonomy_decision) {
    const decisionPath = path.join(autonomyDecisionsRoot(context), `${normalizeId(decision.autonomy_decision.id)}.json`);
    const decisionExisted = fs.existsSync(decisionPath);
    writeJsonFile(decisionPath, decision.autonomy_decision, { force: false });
    autonomyDecisionPath = decisionPath;
    autonomyDecisionCreated = !decisionExisted;
    decision.autonomy_decision_path = toProjectPath(context, decisionPath);
    autonomyDecisionRef = {
      id: decision.autonomy_decision.id,
      path: decision.autonomy_decision_path,
      hash: decision.autonomy_decision.decision_hash,
    };
  }
  const startBasis = decision.autonomy_decision?.autonomous === true
    ? "bounded-autonomous-profile"
    : decision.autonomy?.task_start_automatic === true
      ? "checkpointed-profile"
      : "explicit-confirmation";
  const rawAuthorityAssurance = authorization?.authority_assurance || deliveryProfile?.authority_assurance || null;
  const taskStartAuthorityAssurance = rawAuthorityAssurance
    && typeof rawAuthorityAssurance === "object"
    && !Array.isArray(rawAuthorityAssurance)
      ? rawAuthorityAssurance
      : {
          mode: "audit_only",
          source: rawAuthorityAssurance ? "legacy-authorization-string" : "declared_cli_attribution",
          verified: false,
          limitation: "Legacy string attribution is recorded but cannot independently prove authority.",
        };
  const workflowInstanceRef = decision.workflow_instance_ref || null;
  // A start on an unborn HEAD records the empty tree as its explicit base; the
  // sealed preflight is the authority when there is one.
  const taskStartUnbornBase = preparedPreflight
    ? (preparedPreflight.receipt.git_base_tree
      ? unbornGitBase(preparedPreflight.receipt.git_base_tree)
      : null)
    : currentUnbornGitBase(context.root);
  const confirmedAt = now();
  const receipt = {
    id: `START-${decision.story_id || "PROJECT"}-${uniqueRecordSuffix()}`,
    kind: "profile_task_start_receipt",
    schema_version: workflowInstanceRef
      ? "profile-task-start-receipt:v2"
      : "profile-task-start-receipt:v1",
    story_id: decision.story_id || null,
    phase: decision.phase || null,
    route: decision.route,
    contract_id: decision.contract_id || null,
    contract_approval_hash: decision.contract_id
      ? latestContractApproval(readContractById(context, decision.contract_id, { missingOk: true }) || {})?.approved_content_hash || null
      : null,
    delivery_profile_ref: deliveryProfile
      ? {
          id: deliveryProfile.id,
          path: toProjectPath(context, deliveryAutonomyPath(context, deliveryProfile.id)),
          hash: deliveryProfile.profile_hash,
        }
      : null,
    autonomy_decision_ref: autonomyDecisionRef,
    ...(workflowInstanceRef ? { workflow_instance_ref: workflowInstanceRef } : {}),
    ...(previousTaskStartReceiptRef
      ? { previous_task_start_receipt_ref: previousTaskStartReceiptRef }
      : {}),
    delivery_start_receipt_ref: null,
    execution_context_preflight_ref: preparedPreflight
      ? {
          id: preparedPreflight.receipt.id,
          path: preparedPreflight.relativePath,
          hash: preparedPreflight.receipt.receipt_hash,
        }
      : null,
    ...(taskStartUnbornBase ? { git_base: taskStartUnbornBase } : {}),
    autonomy_level: decision.autonomy_decision?.effective_level || "supervised",
    start_basis: startBasis,
    status: "confirmed",
    authorization_ref: authorization?.id || null,
    authorization_use_ref: authorization?.__use_receipt?.path || null,
    authority_assurance: taskStartAuthorityAssurance,
    confirmed_by: attribution.actor,
    confirmed_at: confirmedAt,
    audit: { git: attribution.git, run: attribution.run },
  };
  let deliveryStartPath = null;
  if (deliveryProfile && autonomyDecisionRef) {
    const story = decision.story_id ? readStory(context, decision.story_id) : null;
    const contract = decision.contract_id ? readContractById(context, decision.contract_id, { missingOk: true }) : null;
    const localReleaseTargetBaseline = deliveryProfile.delivery_kind === "local_release"
      ? buildLocalReleaseTargetSnapshot(
          context,
          deliveryProfile,
          "task_start",
          confirmedAt,
        )
      : null;
    const startRecordBase = {
      id: `AUT-START-${normalizeId(deliveryProfile.id)}`,
      kind: "delivery_start_receipt",
      schema_version: deliveryProfile.delivery_kind === "local_release"
        ? "delivery-start-receipt:v2"
        : "delivery-start-receipt:v1",
      profile_ref: {
        id: deliveryProfile.id,
        path: toProjectPath(context, deliveryAutonomyPath(context, deliveryProfile.id)),
        hash: deliveryProfile.profile_hash,
      },
      delivery: { id: deliveryProfile.delivery_id, kind: deliveryProfile.delivery_kind },
      story_ref: story
        ? {
            id: story.id,
            path: toProjectPath(context, path.join(context.sdlcRoot, "stories", story.id, "story.json")),
            hash: hashApprovalSubject(story),
          }
        : null,
      contract_ref: contract
        ? {
            id: contract.id,
            path: toProjectPath(context, path.join(context.sdlcRoot, "contracts", `${contract.id}.json`)),
            hash: hashApprovalSubject(contract),
          }
        : null,
      contract_approval_hash: receipt.contract_approval_hash,
      phase: receipt.phase,
      route: receipt.route,
      autonomy_decision_ref: autonomyDecisionRef,
      effective_level: receipt.autonomy_level,
      start_basis: startBasis,
      status: "started",
      started_by: attribution.actor,
      started_at: receipt.confirmed_at,
      ...(localReleaseTargetBaseline
        ? { local_release_target_baseline: localReleaseTargetBaseline }
        : {}),
      audit: receipt.audit,
    };
    const startRecord = {
      ...startRecordBase,
      receipt_hash: autonomyLifecycleReceiptHash(startRecordBase),
      hash_algorithm: "sha256:stable-json:v1",
    };
    assertRecordSchema(startRecord, "delivery-start-receipt.schema.json", `Delivery start receipt ${deliveryProfile.id}`);
    const startPath = deliveryStartReceiptPath(context, deliveryProfile.id);
    writeJsonFile(startPath, startRecord, { atomicCreate: true });
    deliveryStartPath = startPath;
    receipt.delivery_start_receipt_ref = {
      id: startRecord.id,
      path: toProjectPath(context, startPath),
      hash: startRecord.receipt_hash,
    };
    decision.delivery_start_receipt = toProjectPath(context, startPath);
  }
  const priorTaskStartText = priorTaskStart
    ? priorTaskStart.snapshot.content.toString("utf8")
    : null;
  let taskStartWritten = false;
  let rolledBack = false;
  const rollback = () => {
    if (rolledBack) return;
    const failures = [];
    const attempt = (label, action) => {
      try {
        action();
      } catch (error) {
        failures.push(`${label}: ${error.message}`);
      }
    };
    if (taskStartWritten) {
      attempt("task-start receipt", () => {
        if (priorTaskStartText === null) {
          removePathGoverned(receiptPath, { force: true });
        } else {
          writeTextFile(receiptPath, priorTaskStartText, { force: true });
        }
      });
    }
    if (deliveryStartPath) {
      attempt("delivery-start receipt", () => removePathGoverned(deliveryStartPath, { force: true }));
    }
    if (autonomyDecisionCreated && autonomyDecisionPath) {
      attempt("autonomy decision", () => removePathGoverned(autonomyDecisionPath, { force: true }));
    }
    if (preparedPreflight?.created) {
      attempt("execution-context preflight", () =>
        removePathGoverned(preparedPreflight.filePath, { force: true }));
    }
    if (failures.length > 0) {
      fail(
        `Task-start transaction rollback is incomplete (${failures.join("; ")}). `
        + "Repair the listed local records before retrying.",
      );
    }
    rolledBack = true;
  };
  try {
    if (preparedPreflight) {
      revalidateExecutionContextPreflightSnapshot(context, preparedPreflight.receipt);
    }
    assertRecordSchema(
      receipt,
      profileTaskStartReceiptSchemaName(receipt),
      `Task start receipt ${receipt.id}`,
    );
    writeJsonFile(
      receiptPath,
      receipt,
      priorTaskStart ? { force: true } : { atomicCreate: true },
    );
    taskStartWritten = true;
    if (preparedPreflight) {
      revalidateExecutionContextPreflightSnapshot(context, preparedPreflight.receipt);
    }
  } catch (error) {
    try {
      rollback();
    } catch {
      // Preserve the original fail-closed reason. Any remaining orphan is
      // integrity-bound and cannot authorize source evolution without a valid
      // task-start receipt.
    }
    throw error;
  }
  return {
    path: toProjectPath(context, receiptPath),
    rollback,
  };
}

export function collectTaskStartApprovalRequests(context, decision) {
  return collectApprovalRequests(context, {
    storyId: decision.story_id || null,
    phase: decision.phase || null,
    contractId: decision.contract_id || null,
    activeOnly: true,
  });
}

export function contractApprovalGovernanceErrors(context, contract) {
  const approval = latestContractApproval(contract);
  if (!approval) {
    return ["Contract has no approval record"];
  }
  const report = { strict: true, errors: [], warnings: [] };
  validateFormalApprovalRecord(
    context,
    report,
    approval,
    `contract ${contract.id || "unknown"} approval ${approval.id || "unknown"}`,
    approval.approved_by,
    {
      subject_id: contract.id || null,
      artifact_types: contractArtifactTypes(contract),
    },
  );
  return report.errors;
}

export function validateTaskStartReceipt(context, storyId, contract) {
  const receiptPath = path.join(context.sdlcRoot, "stories", storyId, "task-start.json");
  if (!fs.existsSync(receiptPath)) {
    return [`assessment journey has no task-start receipt; run task start --confirm-start for ${storyId}`];
  }
  const receipt = readProjectJson(context, receiptPath);
  const issues = [];
  const story = readStory(context, storyId);
  const expectedProposalRef = story?.proposal_ref
    ? { id: story.proposal_ref.id, hash: story.proposal_ref.hash }
    : null;
  if (receipt.kind === "profile_task_start_receipt") {
    try {
      assertRecordSchema(
        receipt,
        profileTaskStartReceiptSchemaName(receipt),
        `Task start receipt ${receipt.id || storyId}`,
      );
    } catch (error) {
      issues.push(error.message);
    }
  }
  issues.push(...validatePreviousTaskStartReceiptChain(context, receipt));
  let deliveryProfile = null;
  const latestApprovalHash = latestContractApproval(contract)?.approved_content_hash || null;
  if (receipt.status !== "confirmed") {
    issues.push(`task-start receipt status is '${receipt.status || "unknown"}'`);
  }
  if (receipt.contract_id !== contract.id || receipt.contract_approval_hash !== latestApprovalHash) {
    issues.push("task-start receipt does not match the current approved contract");
  }
  if (contract.delivery_execution_profile_id) {
    const profile = readDeliveryAutonomyProfile(context, contract.delivery_execution_profile_id, { missingOk: true });
    deliveryProfile = profile;
    if (
      !profile
      || receipt.delivery_profile_ref?.id !== profile.id
      || receipt.delivery_profile_ref?.hash !== profile.profile_hash
    ) {
      issues.push("task-start receipt does not match the current exact delivery autonomy profile");
    } else {
      try {
        validateAutonomyApprovalRef(context, profile, `Delivery autonomy profile ${profile.id}`);
      } catch (error) {
        issues.push(`task-start receipt delivery autonomy is invalid: ${error.message}`);
      }
    }
    if (receipt.execution_context_preflight_ref) {
      const preflight = readStartedExecutionContextPreflight(context, {
        storyId,
        contractId: contract.id,
        profileId: profile?.id,
      });
      if (!preflight.receipt) {
        issues.push(
          `task-start execution context preflight is invalid: ${preflight.errors.join("; ")}`,
        );
      }
    }
    const decisionRef = receipt.autonomy_decision_ref;
    if (!decisionRef?.path || !decisionRef?.hash) {
      issues.push("task-start receipt has no immutable autonomy decision reference");
    } else {
      try {
        const decisionPath = resolveProjectFilePath(context, decisionRef.path, { mustExist: true, fileOnly: true });
        const autonomyDecision = readProjectJson(context, decisionPath);
        const integrity = validateAutonomyDecisionIntegrity(autonomyDecision);
        if (
          !integrity.valid
          || autonomyDecision.id !== decisionRef.id
          || autonomyDecision.decision_hash !== decisionRef.hash
          || autonomyDecision.delivery?.profile_id !== profile?.id
          || autonomyDecision.delivery?.profile_hash !== profile?.profile_hash
        ) {
          issues.push("task-start receipt autonomy decision is missing, stale, or tampered");
        } else {
          const executionState = currentDeliveryExecutionState(context, profile);
          if (
            receipt.delivery_start_receipt_ref?.id !== executionState.start_receipt?.id
            || receipt.delivery_start_receipt_ref?.hash !== executionState.start_receipt?.receipt_hash
          ) {
            issues.push("task-start receipt does not match the immutable delivery start receipt");
          }
          if (executionState.lifecycle_status !== "terminal") {
            const { decision: freshDecision } = evaluateDeliveryAutonomy(context, profile, {
              id: autonomyDecision.id,
              phase: autonomyDecision.phase || undefined,
              evaluated_at: autonomyDecision.evaluated_at,
            });
            if (stableJson(autonomyDecisionSemanticProjection(autonomyDecision)) !== stableJson(autonomyDecisionSemanticProjection(freshDecision))) {
              issues.push("task-start receipt autonomy decision is not reproducible from the current exact delivery profile");
            }
          }
        }
      } catch (error) {
        issues.push(`task-start receipt autonomy decision cannot be validated: ${error.message}`);
      }
    }
  }
  if (receipt.authorization_ref) {
    const authorization = readAuthorization(context, receipt.authorization_ref, { missingOk: true });
    if (!authorization) {
      issues.push(`task-start receipt authorization ${receipt.authorization_ref} is missing`);
    } else {
      const proposalBindingError = authorizationProposalBindingError(
        authorization,
        expectedProposalRef,
      );
      if (proposalBindingError) {
        issues.push(`task-start receipt: ${proposalBindingError}`);
      }
    }
    if (authorization && receipt.authorization_use_ref) {
      const useReceipt = readAuthorizationUseReceipt(context, receipt.authorization_use_ref, { missingOk: true });
      if (!useReceipt) {
        issues.push(`task-start receipt authorization use ${receipt.authorization_use_ref} is missing`);
      } else {
        issues.push(...validateAuthorizationUseReceipt(useReceipt, {
          authorization_id: receipt.authorization_ref,
          action: "task.start.confirm",
          proposal_ref: expectedProposalRef,
          subject_id: storyId,
          artifact_types: contractArtifactTypes(contract),
        }).map((error) => `task-start receipt: ${error}`));
        if (useReceipt.authorization_hash !== authorizationRecordHash(authorization)) {
          issues.push("task-start receipt authorization use does not match the granted content hash");
        }
        if (!authorizationAllowsAction(authorization, "task.start.confirm")) {
          issues.push(`task-start receipt: Authorization ${authorization.id} does not allow action task.start.confirm.`);
        }
        if (!authorizationAllowsSubject(authorization, storyId)) {
          issues.push(`task-start receipt: Authorization ${authorization.id} does not allow subject ${storyId}.`);
        }
        for (const artifactType of contractArtifactTypes(contract)) {
          if (!authorizationAllowsArtifactType(authorization, artifactType)) {
            issues.push(`task-start receipt: Authorization ${authorization.id} does not allow artifact type ${artifactType}.`);
          }
        }
      }
    } else if (authorization) {
      issues.push(...authorizationUseErrors(authorization, "task.start.confirm", {
        proposal_ref: expectedProposalRef,
        subject_id: storyId,
        artifact_types: contractArtifactTypes(contract),
      }).map((error) => `task-start receipt: ${error}`));
    }
  } else if (
    receipt.confirmed_by?.type !== "human"
    && !(
      deliveryProfile
      && ["checkpointed-profile", "bounded-autonomous-profile"].includes(receipt.start_basis)
    )
  ) {
    issues.push("task-start receipt is neither directly human-confirmed nor backed by delegated authorization");
  }
  return issues;
}

// The verified task-start receipts of a story, newest first. A successor
// delivery archives the replaced receipt, so the chain is the delivery lineage
// of one workflow-bound story. Returns null when the chain cannot be verified.
export function storyTaskStartLineage(context, storyId) {
  const receiptPath = path.join(context.sdlcRoot, "stories", storyId, "task-start.json");
  if (!pathEntryExistsNoFollow(receiptPath)) return [];
  let current;
  try {
    current = readProjectJson(context, receiptPath);
  } catch {
    return null;
  }
  if (validatePreviousTaskStartReceiptChain(context, current).length > 0) return null;
  const lineage = [current];
  let cursor = current;
  while (cursor.previous_task_start_receipt_ref) {
    const archivedPath = resolveProjectFilePath(context, cursor.previous_task_start_receipt_ref.path, {
      mustExist: true,
      fileOnly: true,
    });
    cursor = JSON.parse(readStableRegularFileBuffer(archivedPath, context.root).content.toString("utf8"));
    lineage.push(cursor);
  }
  return lineage;
}

// The first task start of a story's lineage: lifecycle ordering, the
// write-scope baseline, and the secret-scan base stay anchored to it, so a
// successor delivery can never narrow what the story's checks cover.
export function storyOriginalTaskStart(context, storyId) {
  const lineage = storyTaskStartLineage(context, storyId);
  if (lineage === null) return { receipt: null, current: null, successor: false, invalid: true, lineage: null };
  return {
    receipt: lineage.at(-1) || null,
    current: lineage[0] || null,
    successor: lineage.length > 1,
    invalid: false,
    lineage,
  };
}

export function validatePreviousTaskStartReceiptChain(context, receipt, options = {}) {
  const issues = [];
  const expectedStoryId = receipt.story_id || null;
  const seenPaths = new Set();
  const seenIds = new Set([receipt.id].filter(Boolean));
  let current = receipt;
  const maxDepth = Number.isSafeInteger(options.maxDepth) ? options.maxDepth : 32;
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const ref = current.previous_task_start_receipt_ref;
    if (!ref) {
      return issues;
    }
    if (
      !ref.id
      || !ref.path
      || !/^[a-f0-9]{64}$/u.test(String(ref.hash || ""))
    ) {
      issues.push("task-start receipt has a malformed previous task-start reference");
      return issues;
    }
    if (seenPaths.has(ref.path) || seenIds.has(ref.id)) {
      issues.push(`task-start receipt history contains a cycle at ${ref.id}`);
      return issues;
    }
    seenPaths.add(ref.path);
    seenIds.add(ref.id);
    let archived;
    try {
      const archivedPath = resolveProjectFilePath(context, ref.path, {
        mustExist: true,
        fileOnly: true,
      });
      const snapshot = readStableRegularFileBuffer(archivedPath, context.root);
      if (snapshot.sha256 !== ref.hash) {
        issues.push(`task-start receipt history ${ref.path} does not match its recorded hash`);
        return issues;
      }
      archived = JSON.parse(snapshot.content.toString("utf8"));
      assertRecordSchema(
        archived,
        profileTaskStartReceiptSchemaName(archived),
        `Archived task start receipt ${ref.id}`,
      );
    } catch (error) {
      issues.push(`task-start receipt history ${ref.path} cannot be verified: ${error.message}`);
      return issues;
    }
    if (archived.id !== ref.id) {
      issues.push(`task-start receipt history ${ref.path} has id ${archived.id || "(missing)"}, expected ${ref.id}`);
      return issues;
    }
    if (archived.kind !== "profile_task_start_receipt") {
      issues.push(`task-start receipt history ${ref.path} is not a profile task-start receipt`);
      return issues;
    }
    if ((archived.story_id || null) !== expectedStoryId) {
      issues.push(`task-start receipt history ${ref.path} belongs to a different story`);
      return issues;
    }
    current = archived;
  }
  if (current.previous_task_start_receipt_ref) {
    issues.push(`task-start receipt history exceeds the maximum verified depth of ${maxDepth}`);
  }
  return issues;
}

export function createBaselineProposal(context, options) {
  ensureBaselineDirectory(context);
  const id = normalizeId(options.id || `BASELINE-${shortDate()}`);
  const attribution = buildAttribution(context, options, "baseline.propose");
  const requestedDocuments = normalizeRawListOption(options.document);
  const documentPaths = requestedDocuments.length > 0 ? requestedDocuments : discoverExistingProjectDocuments(context);
  const documents = documentPaths.map((rawPath) => buildBaselineDocumentEvidence(context, rawPath));
  const detectedStack = detectProjectStack(context);
  const repoSnapshot = buildRepositorySnapshot(context, detectedStack);
  const extraSources = normalizeBaselineSourcePaths(context, [
    ...(repoSnapshot.source_roots || []),
    ...(repoSnapshot.test_roots || []),
    ...normalizeRawListOption(options.source),
  ]);
  const sourcePaths = Array.from(
    new Set([
      ...documents.map((item) => item.path),
      ...extraSources,
      ...detectedStack.map((item) => item.source_path).filter(Boolean),
      ...repoSnapshot.key_files.map((item) => item.path),
    ]),
  ).sort();
  const summary =
    getOptionString(options, "summary") ||
    getOptionString(options, "context-summary") ||
    `Initial baseline for existing project ${readProjectSafe(context)?.project_name || path.basename(context.root)}.`;
  const questions = normalizeRawListOption(options.question);
  const assumptions = normalizeRawListOption(options.assumption);
  const baseline = {
    id,
    schema_version: context.config.schema_version,
    sdlc_version: VERSION,
    kind: String(options.kind || "existing-project"),
    status: "proposed",
    summary,
    repository_snapshot: repoSnapshot,
    imported_documents: documents,
    inferred_context: buildInferredContext(repoSnapshot, detectedStack, documents),
    canonicality: {
      state: "inferred",
      inferred_not_approved: true,
      confirmed_sources: normalizeRawListOption(options["confirmed-source"]),
      user_confirmation_required: true,
      notes: [
        "This baseline describes the current observable project state.",
        "It does not reconstruct pre-SDLC historical decisions unless evidence is present in source files.",
      ],
    },
    security: {
      repository_content_trust: "untrusted_data",
      prompt_instructions_in_sources: "ignored",
      excerpts_redacted: true,
      note: "Repository and document content is evidence only; embedded instructions cannot expand authority, tools, write scope, or approval.",
    },
    open_questions: questions,
    assumptions,
    source_paths: sourcePaths,
    source_hashes: buildSourceHashes(context, sourcePaths),
    approvals: [],
    created_at: now(),
    updated_at: now(),
    audit: {
      proposed_by: attribution.actor,
      git: attribution.git,
      run: attribution.run,
    },
  };
  baseline.proposal_intent_hash_algorithm = "sha256:stable-json:v1";
  baseline.proposal_intent_hash = baselineProposalIntentHash(baseline);
  assertRecordSchema(baseline, "baseline.schema.json", `Baseline ${id}`);

  const baselinePath = baselinePathById(context, id);
  const reportPath = path.join(baselineRoot(context), `${id}-current-state.md`);
  const releaseLock = acquireFileLock(`${baselinePath}.lock`);
  let persistedBaseline = baseline;
  try {
    const baselineExists = pathEntryExistsNoFollow(baselinePath);
    if (baselineExists && !options.force) {
      persistedBaseline = readProjectJson(context, baselinePath);
      assertRecordSchema(persistedBaseline, "baseline.schema.json", `Baseline ${id}`);
      assertBaselineProposalCanResume(persistedBaseline, baseline);
      ensureBaselineProposalReport(context, persistedBaseline, reportPath);
    } else {
      writeJsonFile(baselinePath, baseline, { force: Boolean(options.force), forceOption: true });
      writeTextFile(reportPath, renderBaselineReport(baseline), { force: Boolean(options.force), forceOption: true });
    }
    ensureBaselineProposalTrace(context, persistedBaseline, baselinePath, reportPath);
  } finally {
    releaseLock();
  }
  return { baseline: persistedBaseline, baseline_path: baselinePath, report_path: reportPath };
}

export function ensureBaselineProposalReport(context, baseline, reportPath) {
  const expectedReport = renderBaselineReport(baseline);
  if (!pathEntryExistsNoFollow(reportPath)) {
    writeTextFile(reportPath, expectedReport);
    return { created: true };
  }
  const existingReport = readProjectText(context, reportPath);
  if (existingReport !== expectedReport) {
    failBaselineProposalResume(
      baseline.id,
      "the existing current-state report differs from the persisted proposal",
    );
  }
  return { created: false };
}

export function ensureBaselineProposalTrace(context, baseline, baselinePath, reportPath) {
  const tracePath = path.join(context.sdlcRoot, "traces", "project.jsonl");
  const traceEvent = buildBaselineProposalTraceEvent(
    context,
    baseline,
    baselinePath,
    reportPath,
  );
  const preparedEvent = prepareGovernedTraceEvent(context, traceEvent);
  assertRecordSchema(preparedEvent, "trace.schema.json", `Baseline proposal trace ${traceEvent.id}`);
  const releaseTraceLock = acquireFileLock(`${tracePath}.lock`);
  try {
    assertNoPendingWorkflowTraceTransaction(context, tracePath);
    const snapshot = workflowTraceIntegritySnapshotLocked(context, tracePath);
    if (!snapshot.integrity.valid) {
      fail(
        `Baseline proposal trace ${traceEvent.id} cannot be recovered because trace integrity failed: `
        + `${snapshot.integrity.errors.map((entry) => entry.code).join(", ") || "invalid trace"}.`,
      );
    }
    const matches = snapshot.records
      .filter((entry) => entry.valid === true && entry.event?.id === preparedEvent.id)
      .map((entry) => entry.event);
    if (matches.length > 1) {
      fail(`Baseline proposal trace ${traceEvent.id} is duplicated.`);
    }
    if (matches.length === 1) {
      if (!workflowTraceIntentMatches(matches[0], preparedEvent)) {
        fail(`Baseline proposal trace ${traceEvent.id} has different content.`);
      }
      syncWorkflowFile(tracePath);
      return { appended: false, event: matches[0] };
    }
    const storedEvent = sealPreparedTraceEventLocked(context, tracePath, preparedEvent);
    const verifiedEvent = assertWorkflowStoredTraceIntegrityLocked(
      context,
      tracePath,
      preparedEvent,
    );
    if (!workflowTraceIntentMatches(storedEvent, preparedEvent)) {
      fail(`Baseline proposal trace ${traceEvent.id} was not committed exactly once.`);
    }
    return { appended: true, event: verifiedEvent };
  } finally {
    releaseTraceLock();
  }
}

export function loadAutonomyAuthorityAssurance(context, options, action, subject) {
  const rawPath = getOptionString(options, "host-receipt-file");
  const required = (context.config.authority_policy?.mode || "audit_only") === "host_verified";
  if (!rawPath) {
    if (required) {
      fail([
        "A signed approval is required; nothing was approved.",
        "Impact: this project does not treat a declared CLI actor as independent proof of identity, so the operation remains blocked.",
        `Next: obtain a trusted host or CI receipt for action ${action} and this exact subject, then pass it with \`--host-receipt-file <path>\`.`,
        `Technical detail: expected subject ${subject.id}; policy mode host_verified.`,
      ].join("\n"));
    }
    return { mode: "audit_only" };
  }
  const filePath = resolveProjectFilePath(context, rawPath, { mustExist: true, fileOnly: true });
  assertNotDerivedArtifact(context, filePath, "Autonomy host approval receipt");
  const receipt = readProjectJson(context, filePath);
  assertRecordSchema(receipt, "host-approval-receipt.schema.json", `Host approval receipt ${toProjectPath(context, filePath)}`);
  let decision;
  try {
    const decidedNow = now();
    decision = validateHostApprovalReceiptAtUse(receipt, { action, subject, used_at: decidedNow }, {
      trusted_host_keys: context.config.authority_policy?.trusted_host_keys || [],
      // A new decision needs a key that is active now, not only one that once was.
      active_at: decidedNow,
    });
  } catch (error) {
    fail(`Host approval receipt ${toProjectPath(context, filePath)} is invalid: ${error.message}`);
  }
  if (!decision.valid) {
    fail(`Host approval receipt ${toProjectPath(context, filePath)} is not valid for ${subject.id}: ${decision.errors.join("; ")}`);
  }
  return {
    mode: "host_verified",
    source: receipt.issued_by?.type === "ci" ? "ci_attestation" : "host_approval_receipt",
    verified: true,
    receipt_ref: { id: receipt.id, path: toProjectPath(context, filePath), hash: receipt.receipt_hash },
  };
}

export function writeAutonomyApproval(context, profile, options, attribution, settings = {}) {
  const profilePath = settings.profilePath;
  const approval = buildApprovalRecord(context, options, attribution, {
    subject: profile,
    subject_id_field: "profile_id",
    subject_id: profile.id,
    status: "approved",
    scope: settings.scope,
    label: settings.label,
    standing: settings.standing || null,
  });
  const envelope = {
    id: `AUT-APR-${uniqueRecordSuffix()}`,
    kind: "autonomy_profile_approval",
    schema_version: "autonomy-profile-approval:v1",
    subject: autonomyApprovalSubject(context, profile, profilePath),
    subject_snapshot: profile,
    authority_action: settings.authorityAction || attribution.action,
    authority_subject: settings.authoritySubject || autonomyApprovalSubject(context, profile, profilePath),
    approval,
    created_at: now(),
  };
  const filePath = path.join(autonomyApprovalsRoot(context), `${normalizeId(envelope.id)}.json`);
  writeJsonFile(filePath, envelope, { force: false });
  return {
    approval,
    envelope,
    ref: { id: envelope.id, path: toProjectPath(context, filePath), hash: hashFile(filePath) },
  };
}

export function validateApprovalEvidenceIntegrity(context, approval, label) {
  for (const evidence of approval?.evidence || []) {
    const evidencePath = resolveProjectFilePath(context, evidence.path, { mustExist: true, fileOnly: true });
    assertNotDerivedArtifact(context, evidencePath, `${label} evidence`);
    if (!evidence.sha256 || hashFile(evidencePath) !== evidence.sha256) {
      fail(`${label} evidence changed after approval: ${evidence.path}.`);
    }
  }
}

export function validateAutonomyApprovalRef(context, profile, label = `Autonomy profile ${profile?.id || "unknown"}`) {
  if (profile.status !== "active") return null;
  const ref = profile.approval_ref;
  if (!ref?.path || !ref?.hash) {
    fail(`${label} is active but has no immutable approval reference.`);
  }
  const filePath = resolveProjectFilePath(context, ref.path, { mustExist: true, fileOnly: true });
  if (hashFile(filePath) !== ref.hash) {
    fail(`${label} approval reference is stale: ${ref.path}.`);
  }
  const envelope = readProjectJson(context, filePath);
  const approvedSnapshot = envelope.subject_snapshot;
  const snapshotIntegrity = approvedSnapshot?.kind === "requirement_execution_profile"
    ? validateRequirementExecutionProfileIntegrity(approvedSnapshot)
    : approvedSnapshot?.kind === "delivery_execution_profile"
      ? validateDeliveryExecutionProfileIntegrity(approvedSnapshot)
      : { valid: false, errors: ["unknown autonomy profile kind"] };
  if (
    envelope.kind !== "autonomy_profile_approval"
    || envelope.subject?.id !== profile.id
    || envelope.subject?.hash !== profile.extensions?.approved_profile_hash
    || approvedSnapshot?.profile_hash !== envelope.subject?.hash
    || approvedSnapshot?.status !== "proposed"
    || approvedSnapshot?.kind !== profile.kind
    || !snapshotIntegrity.valid
    || stableJson(autonomyProfileApprovalProjection(profile)) !== stableJson(autonomyProfileApprovalProjection(approvedSnapshot))
    || hashApprovalSubject(approvedSnapshot) !== envelope.approval?.approved_content_hash
    || envelope.approval?.status !== "approved"
    || envelope.approval?.hash_algorithm !== "sha256:stable-json:v1"
  ) {
    fail(`${label} approval envelope does not bind the exact proposed profile content.`);
  }
  validateApprovalSourceForActor(context, {
    source: envelope.approval.approval_source || null,
    status: envelope.approval.status,
    summary: envelope.approval.summary || null,
    evidence: Array.isArray(envelope.approval.evidence) ? envelope.approval.evidence : [],
    actor: envelope.approval.approved_by || null,
    label: `${label} approval`,
  });
  validateApprovalEvidenceIntegrity(context, envelope.approval, `${label} approval`);
  const approvalReport = { strict: true, errors: [], warnings: [] };
  validateFormalApprovalRecord(
    context,
    approvalReport,
    envelope.approval,
    `${label} approval`,
    envelope.approval.approved_by,
    { subject_id: profile.id },
  );
  if (approvalReport.errors.length > 0) {
    fail(`${label} approval governance is invalid: ${approvalReport.errors.join("; ")}`);
  }
  if (profile.authority_assurance?.mode === "host_verified") {
    const receiptRef = profile.authority_assurance.receipt_ref;
    if (!receiptRef?.path || !receiptRef?.hash) {
      fail(`${label} claims host_verified authority without a receipt reference.`);
    }
    if (profile.authority_assurance.source === STANDING_RECEIPT_AUTHORITY_SOURCE) {
      // The authority is the signed standing approval: the approval must be
      // derived from it and name exactly the receipt the profile records.
      const errors = standingReceiptAuthorityErrors(context, envelope.approval, receiptRef, { subject_id: profile.id });
      if (errors.length > 0) {
        fail(`${label} claims the authority of a signed standing approval that does not verify: ${errors.join("; ")}`);
      }
      return envelope;
    }
    const receiptPath = resolveProjectFilePath(context, receiptRef.path, { mustExist: true, fileOnly: true });
    const receipt = readProjectJson(context, receiptPath);
    assertRecordSchema(receipt, "host-approval-receipt.schema.json", `${label} host approval receipt`);
    if (receipt.receipt_hash !== receiptRef.hash) {
      fail(`${label} host approval receipt hash is stale.`);
    }
    let decision;
    try {
      decision = validateHostApprovalReceiptAtUse(receipt, {
        action: envelope.authority_action,
        subject: envelope.authority_subject,
        used_at: now(),
      }, {
        trusted_host_keys: context.config.authority_policy?.trusted_host_keys || [],
      });
    } catch (error) {
      fail(`${label} host approval receipt is invalid: ${error.message}`);
    }
    if (!decision.valid) {
      fail(`${label} host approval receipt is no longer valid: ${decision.errors.join("; ")}`);
    }
  }
  return envelope;
}

export function dataOperationReceiptErrors(context, profile, receipt, actions) {
  const errors = [];
  if (
    !["data.migrate", "data.rollback"].includes(receipt?.action)
    || receipt?.status !== "completed"
    || receipt?.outcome !== "passed"
  ) {
    return ["receipt is not a completed passing reversible data action"];
  }
  const authorization = actions.find((candidate) =>
    candidate.id === receipt.authorization_receipt_ref?.id
    && candidate.receipt_hash === receipt.authorization_receipt_ref?.hash
    && candidate.action === receipt.action
    && candidate.status === "authorized");
  if (!authorization) {
    return [`receipt lacks its exact ${receipt.action} authorization`];
  }
  if (
    receipt.profile_ref?.id !== profile.id
    || receipt.profile_ref?.hash !== profile.profile_hash
    || receipt.delivery?.id !== profile.delivery_id
    || receipt.delivery?.kind !== profile.delivery_kind
    || receipt.effective_level !== authorization.effective_level
    || compareDeliveryAuthorizationOrder(authorization, receipt) >= 0
  ) {
    errors.push("reversible data receipt is bound to a different delivery or invalid execution order");
  }
  const checkpointSnapshot = authorization.action_details?.checkpoint_policy;
  const checkpointValidation = checkpointSnapshot
    ? validateDeliveryActionCheckpointPolicySnapshot(
        context,
        checkpointSnapshot,
        profile,
        authorization.effective_level,
        authorization.action,
      )
    : { valid: false, required: null, errors: ["checkpoint policy snapshot is missing"] };
  if (
    !checkpointValidation.valid
    || checkpointValidation.required !== true
    || authorization.checkpoint_required !== true
  ) {
    errors.push(
      `reversible data authorization lacks its required immutable checkpoint: ${checkpointValidation.errors.join("; ")}`,
    );
  }
  const approvalReport = { strict: true, errors: [], warnings: [], checked: [] };
  validateFormalApprovalRecord(
    context,
    approvalReport,
    authorization.approval,
    `${authorization.action} authorization approval`,
    authorization.approval?.approved_by,
    { subject_id: profile.id },
  );
  const approvalSubject = {
    profile_id: profile.id,
    profile_hash: profile.profile_hash,
    delivery_id: profile.delivery_id,
    action: authorization.action,
    runtime_target: authorization.runtime_target,
    action_details: authorization.action_details,
  };
  if (
    authorization.approval?.status !== "approved"
    || authorization.approval?.approved_content_hash !== hashApprovalSubject(approvalSubject)
  ) {
    approvalReport.errors.push("reversible data authorization approval is missing or bound to another action");
  }
  try {
    validateApprovalEvidenceIntegrity(
      context,
      authorization.approval,
      `${authorization.action} authorization approval`,
    );
    validateDeliveryActionHostAuthority(context, profile, authorization);
  } catch (error) {
    approvalReport.errors.push(`reversible data authorization approval is invalid: ${error.message}`);
  }
  errors.push(...approvalReport.errors);

  const providerReport = { errors: [] };
  validateCompletedProviderActionReceipt(
    context,
    providerReport,
    profile,
    receipt,
    authorization,
    `${receipt.action} receipt ${receipt.id}`,
  );
  errors.push(...providerReport.errors);

  const migration = profile.local_release_target?.data_migration;
  const verification = receipt.data_operation_verification;
  const proof = receipt.action_details?.provider_operation?.completion_receipt?.proof;
  const expectedTransition = receipt.action === "data.migrate" ? "migrated" : "rolled_back";
  if (
    !migration
    || verification?.action !== receipt.action
    || verification?.transition !== expectedTransition
    || verification?.target_path !== migration.target_path
    || verification?.backup_path !== migration.backup.path
    || stableJson(verification?.scopes) !== stableJson(migration.scopes)
    || stableJson(verification?.preview_evidence) !== stableJson(migration.preview_evidence)
    || verification?.before_target_sha256 !== proof?.before_target_sha256
    || verification?.after_target_sha256 !== proof?.after_target_sha256
    || verification?.backup_sha256 !== proof?.backup_sha256
    || verification?.rollback_procedure !== profile.local_release_target.rollback.procedure
    || verification?.rollback_verified !== (receipt.action === "data.rollback")
  ) {
    errors.push("reversible data receipt lacks its exact typed operation verification");
  }
  if (
    receipt.action === "data.rollback"
    && (
      proof?.before_target_sha256 === proof?.backup_sha256
      || proof?.after_target_sha256 === proof?.before_target_sha256
    )
  ) {
    errors.push("data.rollback receipt does not prove a real target transition to its backup");
  }
  const evidenceReport = { errors: [], warnings: [] };
  for (const evidence of receipt.evidence || []) {
    validateDeliveryActionEvidence(
      context,
      evidenceReport,
      receipt,
      `${receipt.action} receipt ${receipt.id}`,
      evidence,
      "evidence changed after recording",
    );
  }
  errors.push(...evidenceReport.errors);
  return errors;
}

export function localTargetBuildAuthorizationErrors(
  context,
  profile,
  authorization,
  predecessor,
) {
  const errors = [];
  if (
    authorization?.action !== "build.local"
    || authorization?.status !== "authorized"
    || authorization.profile_ref?.id !== profile.id
    || authorization.profile_ref?.hash !== profile.profile_hash
    || authorization.delivery?.id !== profile.delivery_id
    || authorization.delivery?.kind !== "local_release"
  ) {
    return ["receipt is not a build.local authorization for the exact profile"];
  }
  const precondition = localTargetBuildPreconditionDetails(authorization);
  if (
    !precondition
    || stableJson(Object.keys(precondition).sort())
      !== stableJson(["predecessor_ref", "snapshot"])
    || stableJson(precondition.predecessor_ref) !== stableJson(predecessor.ref)
  ) {
    return ["build.local authorization does not bind its exact predecessor"];
  }
  errors.push(...localReleaseTargetSnapshotErrors(
    context,
    profile,
    precondition.snapshot,
    { purpose: "build_authorization" },
  ));
  if (precondition.snapshot?.observed_at !== authorization.authorized_at) {
    errors.push("build.local authorization snapshot does not match its authorization time");
  }
  if (!localTargetPredecessorStateMatches(predecessor, precondition.snapshot)) {
    errors.push("build.local authorization snapshot differs from its exact predecessor state");
  }
  return errors;
}

export function localTargetBuildReceiptErrors(
  context,
  profile,
  receipt,
  authorization,
  predecessor,
) {
  const errors = [];
  if (
    receipt?.action !== "build.local"
    || receipt?.status !== "completed"
    || !["passed", "failed"].includes(receipt?.outcome)
    || receipt.profile_ref?.id !== profile.id
    || receipt.profile_ref?.hash !== profile.profile_hash
    || receipt.delivery?.id !== profile.delivery_id
    || receipt.delivery?.kind !== "local_release"
  ) {
    return ["receipt is not a completed build.local action for the exact profile"];
  }
  if (
    !authorization
    || authorization.action !== "build.local"
    || authorization.status !== "authorized"
    || authorization.profile_ref?.id !== profile.id
    || authorization.profile_ref?.hash !== profile.profile_hash
    || stableJson(receipt.authorization_receipt_ref)
      !== stableJson(deliveryActionReceiptRef(context, authorization))
    || compareDeliveryAuthorizationOrder(authorization, receipt) >= 0
  ) {
    errors.push("build.local completion lacks its exact antecedent authorization");
  }
  const precondition = localTargetBuildPreconditionDetails(authorization);
  const completion = localTargetBuildCompletionDetails(receipt);
  if (
    !precondition
    || !completion
    || stableJson(Object.keys(precondition || {}).sort())
      !== stableJson(["predecessor_ref", "snapshot"])
    || ![
      stableJson(["precondition_snapshot_hash", "snapshot"]),
      stableJson(["artifact_content", "precondition_snapshot_hash", "snapshot"]),
    ].includes(stableJson(Object.keys(completion || {}).sort()))
    || stableJson(precondition.predecessor_ref) !== stableJson(predecessor.ref)
  ) {
    errors.push("build.local does not bind the exact prior local-target state");
    return errors;
  }
  errors.push(...localReleaseTargetSnapshotErrors(
    context,
    profile,
    precondition.snapshot,
    { purpose: "build_authorization" },
  ));
  errors.push(...localReleaseTargetSnapshotErrors(
    context,
    profile,
    completion.snapshot,
    { purpose: "build_completion" },
  ));
  if (precondition.snapshot?.observed_at !== authorization?.authorized_at) {
    errors.push("build.local authorization snapshot does not match its authorization time");
  }
  if (completion.snapshot?.observed_at !== receipt.authorized_at) {
    errors.push("build.local completion snapshot does not match its completion time");
  }
  if (!localTargetPredecessorStateMatches(predecessor, precondition.snapshot)) {
    errors.push("build.local precondition differs from its exact predecessor snapshot");
  }
  if (completion.precondition_snapshot_hash !== precondition.snapshot?.snapshot_hash) {
    errors.push("build.local completion is not bound to its authorization snapshot");
  }
  const authorizedProjection = structuredClone(receipt.action_details || {});
  delete authorizedProjection.local_target_build_completion;
  if (stableJson(authorizedProjection) !== stableJson(authorization.action_details)) {
    errors.push("build.local completion differs from its exact authorization boundary");
  }
  if (stableJson(receipt.runtime_target) !== stableJson(authorization.runtime_target)) {
    errors.push("build.local completion changed its runtime target");
  }
  if (completion.artifact_content !== undefined) {
    if (receipt.outcome !== "passed") {
      errors.push("failed build.local completion cannot carry a content manifest");
    }
    errors.push(...localReleaseTargetContentManifestErrors(profile, completion.artifact_content));
  }
  if (
    receipt.outcome === "passed"
    && (completion.snapshot?.entries || []).some((entry) => entry.status !== "directory")
  ) {
    errors.push("build.local completion does not materialize the exact root and approved write paths");
  }
  const rootBefore = precondition.snapshot?.entries?.[0];
  const rootAfter = completion.snapshot?.entries?.[0];
  if (
    rootBefore?.status === "directory"
    && stableJson(rootBefore) !== stableJson(rootAfter)
  ) {
    errors.push("build.local replaced the governed target root instead of preserving its identity");
  }
  if (!Array.isArray(receipt.evidence) || receipt.evidence.length === 0) {
    errors.push("build.local completion has no immutable evidence");
  } else {
    const evidenceReport = { errors: [], warnings: [] };
    for (const evidence of receipt.evidence) {
      validateDeliveryActionEvidence(
        context,
        evidenceReport,
        receipt,
        `build.local receipt ${receipt.id}`,
        evidence,
        "evidence changed after recording",
      );
    }
    errors.push(...evidenceReport.errors);
  }
  return errors;
}

export function localTargetBuildAuthorizationPrecondition(
  context,
  profile,
  executionState,
  authorizedAt,
) {
  const state = localReleaseTargetGovernanceState(context, profile, executionState);
  if (state.invalid.length > 0) {
    fail(`Existing build.local governance is invalid: ${state.invalid.join("; ")}.`);
  }
  const snapshot = assertCurrentLocalReleaseTargetState(
    context,
    profile,
    state,
    "build_authorization",
    authorizedAt,
  );
  return {
    predecessor_ref: state.ref,
    snapshot,
  };
}

export function loadHostApprovalReceipt(context, options, proposal) {
  const rawPath = getOptionString(options, "host-receipt-file");
  const required = (context.config.authority_policy?.mode || "audit_only") === "host_verified";
  if (!rawPath) {
    if (required) {
      const expectedSubject = assessmentApprovalSubject(context, proposal);
      const example = buildHostApprovalReceipt({
        id: `HOST-${proposal.id}-EXAMPLE`,
        action: "assessment.proposal.approve",
        subject: expectedSubject,
        subject_ref: expectedSubject,
        checkpoint: { type: "proposal", normal_checkpoint: 2 },
        question_contract: {
          asked: `Approve the exact proposal ${proposal.id} at the displayed hash?`,
          why: "The workflow needs one content-bound authorization before writing the approved requirement, story, template, contract, and task-start receipt.",
          authorizes: ["Only the proposal write set and execution budget."],
          does_not_authorize: ["Scope changes, budget extensions, production access, secrets, or destructive actions."],
          examples: {
            it: [`Approvo la proposta esatta ${proposal.id}; non autorizzo estensioni di ambito o budget.`],
            en: [`I approve exact proposal ${proposal.id}; I do not authorize scope or budget extensions.`],
          },
        },
        decision: "approved",
        response: {
          raw: `I approve ${proposal.id}`,
          normalized_summary: `Approved exact proposal ${proposal.id}.`,
          message_hash: shortHashFull(`I approve ${proposal.id}`),
        },
        decided_at: now(),
        decided_by: { id: "antonio", type: "human" },
        issued_by: { id: "codex-host", type: "system" },
        host: { provider: "codex", thread_id: "thread-id", message_id: "message-id", trust: "host-attested" },
        constraints: {
          subject_hash: computeAuthorizationSubjectHash(expectedSubject),
          no_scope_expansion: true,
          no_budget_extension: true,
          no_production_access: true,
          no_external_access: true,
        },
      });
      fail([
        "This project requires an Ed25519-signed host approval receipt; --actor-type human alone is not trusted identity proof.",
        "Provide --host-receipt-file <path.json>. Its attestation key_id must resolve in authority_policy.trusted_host_keys and sign the canonical payload hash for the exact question, action, proposal subject/hash, constraints, response, host evidence, actor, and decision time.",
        `Unsigned payload example (the host must add attestation and recompute receipt_hash): ${JSON.stringify(example)}`,
      ].join("\n"));
    }
    return {
      assurance: {
        mode: "audit_only",
        source: "declared_cli_attribution",
        verified: false,
        receipt_ref: null,
        limitation: "The CLI records attribution but has no independent host identity proof.",
      },
      assurance_label: "audit_only",
      receipt: null,
      path: null,
    };
  }
  const filePath = resolveProjectFilePath(context, rawPath, { mustExist: true, fileOnly: true });
  assertNotDerivedArtifact(context, filePath, "Host approval receipt");
  const receipt = readProjectJson(context, filePath);
  assertRecordSchema(receipt, "host-approval-receipt.schema.json", `Host approval receipt ${toProjectPath(context, filePath)}`);
  const subject = assessmentApprovalSubject(context, proposal);
  let decision;
  try {
    const decidedNow = now();
    decision = validateHostApprovalReceiptAtUse(receipt, {
      action: "assessment.proposal.approve",
      subject,
      used_at: decidedNow,
    }, {
      trusted_host_keys: context.config.authority_policy?.trusted_host_keys || [],
      active_at: decidedNow,
    });
  } catch (error) {
    fail(`Host approval receipt ${toProjectPath(context, filePath)} is invalid: ${error.message}`);
  }
  if (!decision.valid) {
    fail(`Host approval receipt ${toProjectPath(context, filePath)} is not valid for proposal ${proposal.id}: ${decision.errors.join("; ")}`);
  }
  if (receipt.constraints.no_external_access === true && proposal.capabilities.external_access === true) {
    fail(`Host approval receipt ${toProjectPath(context, filePath)} forbids external access requested by proposal ${proposal.id}.`);
  }
  if (receipt.constraints.no_production_access === true && proposal.capabilities.production_access === true) {
    fail(`Host approval receipt ${toProjectPath(context, filePath)} forbids production access requested by proposal ${proposal.id}.`);
  }
  const ref = { id: receipt.id, path: toProjectPath(context, filePath), hash: receipt.receipt_hash };
  return {
    assurance: {
      mode: "host_verified",
      source: "host_approval_receipt",
      verified: true,
      verified_at: decision.used_at,
      receipt_ref: ref,
    },
    assurance_label: "host_verified",
    receipt: { ...receipt, sha256: hashFile(filePath) },
    path: toProjectPath(context, filePath),
  };
}

export function existingAuthorizationUse(context, authorizationId, action, settings) {
  const key = authorizationUseKey(action, settings);
  const receipt = safeReadDir(authorizationUsesRoot(context, authorizationId))
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({ path: path.join(authorizationUsesRoot(context, authorizationId), name), value: readProjectJson(context, path.join(authorizationUsesRoot(context, authorizationId), name)) }))
    .find((item) => {
      const value = item.value;
      const receiptKey = value.use_key || authorizationUseKey(value.action, value.subject || {});
      return receiptKey === key && authorizationReceiptAccepted(value);
    });
  return receipt ? { receipt: receipt.value, path: toProjectPath(context, receipt.path) } : null;
}

export function validatedExistingAuthorizationUse(context, authorization, action, settings) {
  const existing = existingAuthorizationUse(
    context,
    authorization.id,
    action,
    settings,
  );
  if (!existing) {
    return null;
  }
  const errors = validateAuthorizationUseReceipt(existing.receipt, {
    authorization_id: authorization.id,
    action,
    proposal_ref: settings.proposal_ref,
    subject_id: settings.subject_id,
    subject_hash: settings.subject_hash,
    artifact_types: settings.artifact_types,
    approval_boundaries: settings.approval_boundaries,
  });
  const receiptSubject = [
    "authorization-usage-receipt:v1",
    "authorization-usage-receipt:v2",
  ].includes(existing.receipt.schema_version)
    ? existing.receipt.subject || {}
    : existing.receipt;
  const expectedArtifactTypes = authorizationArtifactTypes(settings).sort();
  const actualArtifactTypes = authorizationArtifactTypes({
    artifact_types: receiptSubject.artifact_types || [],
  }).sort();
  if (stableJson(actualArtifactTypes) !== stableJson(expectedArtifactTypes)) {
    errors.push(
      `authorization usage receipt artifact types are ${actualArtifactTypes.join(", ") || "empty"}, `
      + `expected ${expectedArtifactTypes.join(", ") || "empty"}`,
    );
  }
  const expectedApprovalBoundaries = authorizationApprovalBoundaries(settings).sort();
  const actualApprovalBoundaries = authorizationApprovalBoundaries({
    approval_boundaries: receiptSubject.approval_boundaries || [],
  }).sort();
  if (stableJson(actualApprovalBoundaries) !== stableJson(expectedApprovalBoundaries)) {
    errors.push(
      `authorization usage receipt approval boundaries are ${actualApprovalBoundaries.join(", ") || "empty"}, `
      + `expected ${expectedApprovalBoundaries.join(", ") || "empty"}`,
    );
  }
  if (
    Object.hasOwn(settings, "subject_hash")
    && (receiptSubject.subject_hash || null) !== (settings.subject_hash || null)
  ) {
    errors.push("authorization usage receipt is not bound to the exact expected subject hash");
  }
  if (
    errors.length > 0
    || existing.receipt.authorization_hash !== authorizationRecordHash(authorization)
  ) {
    fail(
      `Existing authorization use for ${action} is invalid: `
      + `${errors.join("; ") || "authorization hash mismatch"}`,
    );
  }
  return existing;
}

export function recordOrReuseAuthorizationUse(context, authorization, action, settings) {
  const existing = validatedExistingAuthorizationUse(
    context,
    authorization,
    action,
    settings,
  );
  if (existing) {
    return existing;
  }
  return recordAuthorizationUse(context, authorization, action, settings);
}

export function assertProposalBaselineStillValid(context, proposal) {
  const baseline = selectApprovedAssessmentBaseline(context, proposal.baseline_ref?.id);
  const approvalHash = latestApprovedRecordApproval(baseline)?.approved_content_hash || null;
  if (approvalHash !== proposal.baseline_ref?.approved_content_hash) {
    fail(`Baseline ${baseline.id} approval changed after proposal ${proposal.id} was prepared; prepare a new proposal instead of applying stale scope.`);
  }
}

export function proposalAuthorizationUseErrors(context, reference, authorizationId, proposal, action, subjectId, artifactTypes = []) {
  if (!reference) {
    return [`${action} on ${subjectId} has no authorization usage receipt`];
  }
  let receipt;
  try {
    receipt = readAuthorizationUseReceipt(context, reference);
  } catch (error) {
    return [`${action} authorization usage receipt ${reference} cannot be read: ${error.message}`];
  }
  return validateAuthorizationUseReceipt(receipt, {
    authorization_id: authorizationId,
    action,
    proposal_ref: { id: proposal.id, hash: proposal.proposal_hash },
    subject_id: subjectId,
    artifact_types: artifactTypes,
  });
}

export function proposalRequirementSemanticErrors(context, proposal, approval, authorizationId, record) {
  const expected = {
    id: proposal.scope.requirement_id,
    kind: "requirement",
    schema_version: "requirement:v1",
    title: proposal.scope.title,
    summary: proposal.scope.summary,
    acceptance_criteria: proposal.story_reservation.acceptance_criteria,
    source_paths: [proposal.baseline_ref.path],
    proposal_ref: { id: proposal.id, hash: proposal.proposal_hash },
    approval_ref: approval.id,
  };
  const errors = [];
  for (const [field, value] of Object.entries(expected)) {
    if (stableJson(record?.[field]) !== stableJson(value)) {
      errors.push(`requirement ${expected.id} ${field} differs from the approved proposal`);
    }
  }
  if (!record || !["approved", "active", "completed"].includes(record.status)) {
    errors.push(`requirement ${expected.id} has invalid status ${record?.status || "missing"}`);
  }
  errors.push(...proposalAuthorizationUseErrors(
    context,
    record?.audit?.authorization_use_ref,
    authorizationId,
    proposal,
    "requirement.create",
    expected.id,
    [],
  ));
  if (record?.audit?.authorization_ref !== authorizationId) {
    errors.push(`requirement ${expected.id} references the wrong authorization`);
  }
  return errors;
}

export function proposalStorySemanticErrors(context, proposal, authorizationId, record, options = {}) {
  const reservation = proposal.story_reservation;
  const expected = {
    id: reservation.id,
    title: reservation.title,
    contract_id: proposal.contract_draft.id,
    acceptance: reservation.acceptance_criteria,
    acceptance_criteria: reservation.acceptance_criteria,
    proposal_ref: { id: proposal.id, hash: proposal.proposal_hash },
  };
  const errors = [];
  for (const [field, value] of Object.entries(expected)) {
    if (stableJson(record?.[field]) !== stableJson(value)) {
      errors.push(`story ${reservation.id} ${field} differs from the approved proposal`);
    }
  }
  if (stableJson(record?.links?.requirements || []) !== stableJson([proposal.scope.requirement_id])) {
    errors.push(`story ${reservation.id} requirement lineage differs from the approved proposal`);
  }
  const allowedStatuses = options.release ? ["done"] : ["ready"];
  if (!allowedStatuses.includes(record?.status)) {
    errors.push(`story ${reservation.id} status ${record?.status || "missing"} is not valid for ${options.release ? "release" : "apply"}`);
  }
  errors.push(...proposalAuthorizationUseErrors(
    context,
    record?.audit?.authorization_use_ref,
    authorizationId,
    proposal,
    "story.create",
    reservation.id,
    [],
  ));
  if (record?.audit?.authorization_ref !== authorizationId) {
    errors.push(`story ${reservation.id} references the wrong authorization`);
  }
  return errors;
}

export function proposalContractSemanticErrors(context, proposal, authorizationId, record) {
  const expectedDraft = structuredClone(proposal.contract_draft);
  expectedDraft.proposal_ref = { id: proposal.id, hash: proposal.proposal_hash };
  expectedDraft.status = "draft";
  expectedDraft.approvals = [];
  const expectedContentHash = hashApprovalSubject(expectedDraft);
  const currentContentHash = record ? hashApprovalSubject(record) : null;
  const approval = latestContractApproval(record || {});
  const errors = [];
  if (!record || record.id !== expectedDraft.id || record.story_id !== expectedDraft.story_id || record.proposal_ref?.id !== proposal.id || record.proposal_ref?.hash !== proposal.proposal_hash) {
    errors.push(`contract ${expectedDraft.id} identity/lineage differs from the approved proposal`);
  }
  if (record?.status !== "approved") {
    errors.push(`contract ${expectedDraft.id} is not approved for reuse`);
  }
  if (currentContentHash !== expectedContentHash) {
    errors.push(`contract ${expectedDraft.id} current governed content differs from the approved proposal draft`);
  }
  if (!approval || approval.status !== "approved" || approval.approved_content_hash !== expectedContentHash) {
    errors.push(`contract ${expectedDraft.id} approved content differs from the proposal draft`);
  }
  if (record && !hasFreshApprovedContractApproval(record)) {
    errors.push(`contract ${expectedDraft.id} approval is stale for its current governed content`);
  }
  if (
    approval?.approval_source !== "automation" ||
    approval?.authorization_ref !== authorizationId ||
    approval?.authorization_action !== "contract.approve" ||
    approval?.scope?.subject_id !== expectedDraft.id ||
    approval?.scope?.proposal_ref?.id !== proposal.id ||
    approval?.scope?.proposal_ref?.hash !== proposal.proposal_hash ||
    stableJson(approval?.scope?.artifact_types || []) !== stableJson([proposal.deliverable.artifact_type])
  ) {
    errors.push(`contract ${expectedDraft.id} approval is not the exact delegated proposal approval`);
  }
  errors.push(...proposalAuthorizationUseErrors(
    context,
    approval?.authorization_use_ref,
    authorizationId,
    proposal,
    "contract.approve",
    expectedDraft.id,
    [proposal.deliverable.artifact_type],
  ));
  return errors;
}

export function proposalTaskStartSemanticErrors(context, proposal, authorizationId, contract, record) {
  const storyId = proposal.story_reservation.id;
  const expected = {
    kind: "task_start_receipt",
    schema_version: "task-start-receipt:v2",
    story_id: storyId,
    phase: "analysis",
    route: "classify_artifact",
    contract_id: proposal.contract_draft.id,
    contract_approval_hash: latestContractApproval(contract)?.approved_content_hash || null,
    proposal_ref: { id: proposal.id, hash: proposal.proposal_hash },
    budget_ref: { id: proposal.execution_budget.id, hash: proposal.execution_budget.budget_hash },
    status: "confirmed",
    authorization_ref: authorizationId,
  };
  const errors = [];
  for (const [field, value] of Object.entries(expected)) {
    if (stableJson(record?.[field]) !== stableJson(value)) {
      errors.push(`task-start ${storyId} ${field} differs from the approved proposal`);
    }
  }
  errors.push(...proposalAuthorizationUseErrors(
    context,
    record?.authorization_use_ref,
    authorizationId,
    proposal,
    "task.start.confirm",
    storyId,
    [proposal.deliverable.artifact_type],
  ));
  return errors;
}

export function proposalTemplateSemanticErrors(context, proposal, authorizationId) {
  const registry = readOutputRegistry(context, { missingOk: true });
  const template = registry?.templates?.find((item) => item.id === proposal.deliverable.template_id);
  const errors = [];
  if (!template) {
    return [`output template ${proposal.deliverable.template_id} is missing`];
  }
  if (
    template.type !== proposal.deliverable.artifact_type ||
    template.status !== "approved" ||
    template.path !== proposal.deliverable.template_path ||
    template.proposal_ref?.id !== proposal.id ||
    template.proposal_ref?.hash !== proposal.proposal_hash ||
    template.authorization_ref !== authorizationId ||
    template.authorization_action !== "output.template.approve"
  ) {
    errors.push(`output template ${template.id} differs from the approved proposal`);
  }
  let templatePath;
  try {
    templatePath = resolveProjectFilePath(context, template.path, { mustExist: true, fileOnly: true });
    if (hashFile(templatePath) !== proposal.deliverable.template_source_sha256) {
      errors.push(`output template ${template.id} bytes differ from the approved proposal`);
    }
  } catch (error) {
    errors.push(`output template ${template.id}: ${error.message}`);
  }
  errors.push(...proposalAuthorizationUseErrors(
    context,
    template.authorization_use_ref,
    authorizationId,
    proposal,
    "output.template.approve",
    template.id,
    [proposal.deliverable.artifact_type],
  ));
  return errors;
}

export function proposalMaterializationSemanticErrors(context, proposal, approval, authorizationId, options = {}) {
  const errors = [];
  const requirement = readRequirement(context, proposal.scope.requirement_id, { missingOk: true });
  const story = readStory(context, proposal.story_reservation.id);
  const contract = readContractById(context, proposal.contract_draft.id, { missingOk: true });
  let taskStart = null;
  try {
    taskStart = readProjectJson(context, path.join(context.sdlcRoot, "stories", proposal.story_reservation.id, "task-start.json"));
  } catch (error) {
    errors.push(`task-start ${proposal.story_reservation.id}: ${error.message}`);
  }
  errors.push(...proposalRequirementSemanticErrors(context, proposal, approval, authorizationId, requirement));
  errors.push(...proposalStorySemanticErrors(context, proposal, authorizationId, story, options));
  errors.push(...proposalContractSemanticErrors(context, proposal, authorizationId, contract));
  if (taskStart) {
    errors.push(...proposalTaskStartSemanticErrors(context, proposal, authorizationId, contract, taskStart));
  }
  errors.push(...proposalTemplateSemanticErrors(context, proposal, authorizationId));
  return Array.from(new Set(errors));
}

export function applyProposalRequirement(context, proposal, attribution, authorization, baseSettings, useReceipts) {
  const scope = proposal.scope;
  const id = scope.requirement_id;
  const filePath = requirementPath(context, id);
  const existing = readRequirement(context, id, { missingOk: true });
  if (existing) {
    if (existing.proposal_ref?.id !== proposal.id || existing.proposal_ref?.hash !== proposal.proposal_hash) {
      fail(`Requirement ${id} already exists outside proposal ${proposal.id}; choose a new reserved requirement ID.`);
    }
    return { kind: "requirement", id, status: "reused", path: toProjectPath(context, filePath), sha256: hashFile(filePath) };
  }
  const use = recordOrReuseAuthorizationUse(context, authorization, "requirement.create", {
    ...baseSettings,
    subject_id: id,
    artifact_types: [],
  });
  useReceipts.push(use);
  const record = {
    id,
    kind: "requirement",
    schema_version: "requirement:v1",
    title: scope.title,
    summary: scope.summary,
    status: "approved",
    acceptance_criteria: proposal.story_reservation.acceptance_criteria,
    source_paths: [proposal.baseline_ref.path],
    proposal_ref: { id: proposal.id, hash: proposal.proposal_hash },
    approval_ref: readAssessmentApproval(context, proposal.id).id,
    created_at: now(),
    updated_at: now(),
    audit: {
      created_by: attribution.actor,
      updated_by: attribution.actor,
      authorization_ref: authorization.id,
      authorization_use_ref: use.path,
      git: attribution.git,
      run: attribution.run,
    },
  };
  writeJsonFile(filePath, record);
  return { kind: "requirement", id, status: "created", path: toProjectPath(context, filePath), sha256: hashFile(filePath) };
}

export function applyProposalStory(context, proposal, attribution, authorization, baseSettings, useReceipts, templates = null) {
  const reservation = proposal.story_reservation;
  const storyDir = path.join(context.sdlcRoot, "stories", reservation.id);
  const storyPath = path.join(storyDir, "story.json");
  const existing = readStory(context, reservation.id);
  if (existing) {
    if (existing.proposal_ref?.id !== proposal.id || existing.proposal_ref?.hash !== proposal.proposal_hash) {
      fail(`Story ${reservation.id} already exists outside proposal ${proposal.id}; choose a new reserved story ID.`);
    }
    return { kind: "story", id: reservation.id, status: "reused", path: toProjectPath(context, storyPath), sha256: hashFile(storyPath) };
  }
  const storyPlanTemplate = templates?.plan ?? readTemplateFile(context, "story-plan.md");
  const implementationLogTemplate = templates?.implementation_log ?? readTemplateFile(context, "implementation-log.md");
  const use = recordOrReuseAuthorizationUse(context, authorization, "story.create", {
    ...baseSettings,
    subject_id: reservation.id,
    artifact_types: [],
  });
  useReceipts.push(use);
  ensureDir(storyDir);
  const record = {
    id: reservation.id,
    title: reservation.title,
    schema_version: context.config.schema_version,
    status: "ready",
    phase: reservation.phase || "analysis",
    contract_id: proposal.contract_draft.id,
    work_breakdown_id: null,
    acceptance: reservation.acceptance_criteria,
    acceptance_criteria: reservation.acceptance_criteria,
    links: { requirements: [proposal.scope.requirement_id], decisions: [], tests: [] },
    proposal_ref: { id: proposal.id, hash: proposal.proposal_hash },
    created_at: now(),
    updated_at: now(),
    audit: {
      created_by: attribution.actor,
      updated_by: attribution.actor,
      authorization_ref: authorization.id,
      authorization_use_ref: use.path,
      git: attribution.git,
      run: attribution.run,
    },
  };
  writeJsonFile(storyPath, record);
  writeTextFile(
    path.join(storyDir, "plan.md"),
    renderTemplate(storyPlanTemplate, { STORY_ID: reservation.id }),
  );
  writeTextFile(
    path.join(storyDir, "implementation-log.md"),
    renderTemplate(implementationLogTemplate, { STORY_ID: reservation.id, CREATED_AT: now() }),
  );
  return { kind: "story", id: reservation.id, status: "created", path: toProjectPath(context, storyPath), sha256: hashFile(storyPath) };
}

export function applyProposalTemplate(context, proposal, attribution, authorization, baseSettings, useReceipts) {
  const deliverable = proposal.deliverable;
  const content = String(proposal.extensions?.template_content || "");
  const contentHash = hashBuffer(Buffer.from(content, "utf8"));
  if (!content || contentHash !== deliverable.template_source_sha256) {
    fail(`Proposal ${proposal.id} template content is missing or does not match the approved template hash.`);
  }
  return withOutputRegistryLock(context, () => {
    const registry = readOutputRegistry(context, { create: true, options: {}, action: "assessment.proposal.apply" });
    const existing = findOutputTemplate(registry, deliverable.template_id);
    const templatePath = resolveProjectFilePath(context, deliverable.template_path, { mustExist: false });
    if (existing) {
      if (
        existing.proposal_ref?.id !== proposal.id ||
        existing.proposal_ref?.hash !== proposal.proposal_hash ||
        !fs.existsSync(templatePath) ||
        hashFile(templatePath) !== deliverable.template_source_sha256
      ) {
        fail(`Output template ${deliverable.template_id} already exists with content not authorized by proposal ${proposal.id}.`);
      }
      return { kind: "output_template", id: deliverable.template_id, status: "reused", path: deliverable.template_path, sha256: hashFile(templatePath) };
    }
    const use = recordOrReuseAuthorizationUse(context, authorization, "output.template.approve", {
      ...baseSettings,
      subject_id: deliverable.template_id,
      artifact_types: [deliverable.artifact_type],
    });
    useReceipts.push(use);
    writeTextFile(templatePath, content);
    const record = {
      id: deliverable.template_id,
      type: deliverable.artifact_type,
      status: "approved",
      path: deliverable.template_path,
      summary: proposal.objective,
      preset: deliverable.preset || null,
      delivery: deliverable.delivery,
      source_paths: [proposal.baseline_ref.path],
      proposed_at: proposal.created_at || now(),
      approved_at: now(),
      approved_by: attribution.actor,
      approval_summary: `Approved as part of content-bound assessment proposal ${proposal.id}.`,
      approved_content_hash: hashFile(templatePath),
      approved_delivery_hash: hashApprovalSubject(deliverable.delivery),
      hash_algorithm: "sha256:file:v1",
      approval_evidence: [{ path: toProjectPath(context, assessmentApprovalPath(context, proposal.id)), sha256: hashFile(assessmentApprovalPath(context, proposal.id)) }],
      approval_source: "automation",
      authorization_ref: authorization.id,
      authorization_use_ref: use.path,
      authorization_action: "output.template.approve",
      approval_scope: {
        subject_id: deliverable.template_id,
        delegated_approval: true,
        proposal_ref: { id: proposal.id, hash: proposal.proposal_hash },
        artifact_types: [deliverable.artifact_type],
      },
      explicit_user_confirmation: false,
      provisional: false,
      proposal_ref: { id: proposal.id, hash: proposal.proposal_hash },
      audit: { proposed_by: attribution.actor, approved_by: attribution.actor, git: attribution.git, run: attribution.run },
    };
    upsertById(registry.templates, record);
    registry.decisions.push({
      id: `DEC-${proposal.id}-template`,
      type: "template_approved_by_assessment_proposal",
      status: "recorded",
      template_id: record.id,
      artifact_type: record.type,
      proposal_ref: record.proposal_ref,
      created_at: now(),
    });
    registry.updated_at = now();
    registry.audit = { ...(registry.audit || {}), updated_by: attribution.actor, git: attribution.git, run: attribution.run };
    writeOutputRegistry(context, registry);
    return { kind: "output_template", id: record.id, status: "created_and_approved", path: record.path, sha256: hashFile(templatePath) };
  });
}

export function assertProposalContractReady(context, proposal, contract) {
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    fail(`Proposal ${proposal.id} has no valid contract draft to apply.`);
  }
  const readinessGaps = collectContractReadinessGaps(context, contract);
  if (readinessGaps.length === 0) {
    return;
  }
  fail(
    [
      `Proposal ${proposal.id} cannot apply incomplete contract ${contract.id || "draft"}.`,
      ...readinessGaps.map((gap) => `- ${gap.summary}`),
      "Prepare and approve a corrected proposal before applying it.",
    ].join("\n"),
  );
}

export function assertProposalExistingContractReusable(
  context,
  proposal,
  authorizationId,
) {
  const contractId = proposal.contract_draft?.id;
  if (!contractId) {
    fail(`Proposal ${proposal.id} contract draft has no id.`);
  }
  const existing = readContractById(context, contractId, { missingOk: true });
  if (!existing) {
    return null;
  }
  assertProposalContractReady(context, proposal, existing);
  const semanticErrors = proposalContractSemanticErrors(
    context,
    proposal,
    authorizationId,
    existing,
  );
  if (semanticErrors.length > 0) {
    fail(
      [
        `Proposal ${proposal.id} cannot reuse contract ${contractId}.`,
        ...semanticErrors.map((error) => `- ${error}`),
        "Restore the exact approved proposal contract or prepare a new proposal id before applying.",
      ].join("\n"),
    );
  }
  return existing;
}

export function applyProposalContract(context, proposal, attribution, authorization, baseSettings, useReceipts) {
  const draft = structuredClone(proposal.contract_draft);
  const contractPath = path.join(context.sdlcRoot, "contracts", `${draft.id}.json`);
  const existing = readContractById(context, draft.id, { missingOk: true });
  if (existing) {
    if (existing.proposal_ref?.id !== proposal.id || existing.proposal_ref?.hash !== proposal.proposal_hash) {
      fail(`Contract ${draft.id} already exists outside proposal ${proposal.id}.`);
    }
    assertProposalContractReady(context, proposal, existing);
    const semanticErrors = proposalContractSemanticErrors(
      context,
      proposal,
      authorization.id,
      existing,
    );
    if (semanticErrors.length > 0) {
      fail(`Contract ${draft.id} cannot be reused: ${semanticErrors.join("; ")}`);
    }
    return { kind: "contract", id: draft.id, status: "reused", path: toProjectPath(context, contractPath), sha256: hashFile(contractPath), contract: existing };
  }
  assertProposalContractReady(context, proposal, draft);
  const use = recordOrReuseAuthorizationUse(context, authorization, "contract.approve", {
    ...baseSettings,
    subject_id: draft.id,
    artifact_types: [proposal.deliverable.artifact_type],
  });
  useReceipts.push(use);
  draft.proposal_ref = { id: proposal.id, hash: proposal.proposal_hash };
  draft.status = "draft";
  draft.approvals = [];
  const approval = {
    id: `APR-${draft.id}-${uniqueRecordSuffix()}`,
    contract_id: draft.id,
    status: "approved",
    summary: `Approved as part of content-bound assessment proposal ${proposal.id}.`,
    scope: {
      subject_id: draft.id,
      delegated_approval: true,
      proposal_ref: { id: proposal.id, hash: proposal.proposal_hash },
      artifact_types: [proposal.deliverable.artifact_type],
      authorization_ref: authorization.id,
    },
    evidence: [{ path: toProjectPath(context, assessmentApprovalPath(context, proposal.id)), sha256: hashFile(assessmentApprovalPath(context, proposal.id)) }],
    approval_source: "automation",
    authorization_ref: authorization.id,
    authorization_use_ref: use.path,
    authorization_action: "contract.approve",
    explicit_user_confirmation: false,
    provisional: false,
    approved_content_hash: hashApprovalSubject(draft),
    hash_algorithm: "sha256:stable-json:v1",
    approved_by: attribution.actor,
    git: attribution.git,
    run: attribution.run,
    created_at: now(),
  };
  draft.approvals.push(approval);
  draft.status = "approved";
  draft.updated_at = now();
  draft.audit = { ...(draft.audit || {}), updated_by: attribution.actor, git: attribution.git, run: attribution.run };
  const releaseStoryLock = acquireFileLock(storyMutationLockPath(context, draft.story_id));
  let releaseContractLock;
  try {
    releaseContractLock = acquireFileLock(`${contractPath}.lock`);
    const story = readStory(context, draft.story_id);
    if (!story || story.contract_id !== draft.id) {
      fail(`Reserved story ${draft.story_id} is missing or is not bound to contract ${draft.id}.`);
    }
    writeJsonFile(contractPath, draft);
  } finally {
    releaseContractLock?.();
    releaseStoryLock();
  }
  return { kind: "contract", id: draft.id, status: "created_and_approved", path: toProjectPath(context, contractPath), sha256: hashFile(contractPath), contract: draft };
}

export function applyProposalTaskStart(context, proposal, attribution, authorization, baseSettings, useReceipts, contract) {
  const storyId = proposal.story_reservation.id;
  const receiptPath = path.join(context.sdlcRoot, "stories", storyId, "task-start.json");
  if (fs.existsSync(receiptPath)) {
    const existing = readProjectJson(context, receiptPath);
    if (existing.proposal_ref?.id !== proposal.id || existing.proposal_ref?.hash !== proposal.proposal_hash) {
      fail(`Story ${storyId} already has a task-start receipt outside proposal ${proposal.id}.`);
    }
    return { kind: "task_start", id: existing.id, status: "reused", path: toProjectPath(context, receiptPath), sha256: hashFile(receiptPath) };
  }
  const use = recordOrReuseAuthorizationUse(context, authorization, "task.start.confirm", {
    ...baseSettings,
    subject_id: storyId,
    artifact_types: [proposal.deliverable.artifact_type],
  });
  useReceipts.push(use);
  const proposalUnbornBase = currentUnbornGitBase(context.root);
  const receipt = {
    id: `START-${storyId}-${uniqueRecordSuffix()}`,
    kind: "task_start_receipt",
    schema_version: "task-start-receipt:v2",
    story_id: storyId,
    phase: "analysis",
    route: "classify_artifact",
    contract_id: contract.id,
    contract_approval_hash: latestContractApproval(contract)?.approved_content_hash || null,
    proposal_ref: { id: proposal.id, hash: proposal.proposal_hash },
    budget_ref: { id: proposal.execution_budget.id, hash: proposal.execution_budget.budget_hash },
    status: "confirmed",
    authorization_ref: authorization.id,
    authorization_use_ref: use.path,
    authority_assurance: authorization.authority_assurance || "audit_only",
    ...(proposalUnbornBase ? { git_base: proposalUnbornBase } : {}),
    confirmed_by: attribution.actor,
    confirmed_at: now(),
    audit: { git: attribution.git, run: attribution.run },
  };
  writeJsonFile(receiptPath, receipt);
  return { kind: "task_start", id: receipt.id, status: "created", path: toProjectPath(context, receiptPath), sha256: hashFile(receiptPath) };
}

export function closeContentAuthorization(context, authorizationId, reason, actor) {
  const filePath = authorizationPath(context, authorizationId);
  const releaseLock = acquireFileLock(`${filePath}.lock`);
  try {
    const record = readAuthorization(context, authorizationId);
    if (isCanonicalContentAuthorization(record)) {
      if (record.__lifecycle) {
        return { ...record, effective_status: "closed", lifecycle_ref: toProjectPath(context, authorizationLifecyclePath(context, authorizationId)) };
      }
      const effectiveAt = now();
      const lifecycle = createAuthorizationRevocation({
        id: `ACLOSE-${record.id}-${shortHash(effectiveAt)}`,
        authorization_id: record.id,
        authorization_hash: record.authorization_hash,
        effective_at: effectiveAt,
        reason,
        revoked_by: actor,
      });
      const lifecyclePath = authorizationLifecyclePath(context, authorizationId);
      ensureDir(path.dirname(lifecyclePath));
      writeJsonFile(lifecyclePath, lifecycle);
      return { ...record, effective_status: "closed", lifecycle_ref: toProjectPath(context, lifecyclePath) };
    }
    if (["closed", "revoked"].includes(record.status)) {
      return record;
    }
    record.status = "closed";
    record.closed_at = now();
    record.closed_reason = reason;
    record.updated_at = now();
    record.audit = { ...(record.audit || {}), closed_by: actor };
    writeJsonFile(filePath, record, { force: true });
    return record;
  } finally {
    releaseLock();
  }
}

export function grantAuthorization(context, options) {
  ensureInitialized(context);
  const id = normalizeId(requireOption(options, "id"));
  const scope = getOptionString(options, "scope");
  const summary = getOptionString(options, "summary");
  const declaredActions = normalizeAuthorizedActions(options["allow-action"]);
  const declaredSubjects = normalizeListOption(options["allow-subject"])
    .map((subject) => subject === "*" ? "*" : normalizeId(subject));
  const explicitUses = parseLegacyAuthorizationUses(options["allow-use"]);
  const projectedActions = Array.from(new Set(explicitUses.map((use) => use.action)));
  const projectedSubjects = Array.from(new Set(explicitUses.map((use) => use.subject_id)));
  if (explicitUses.length > 0 && declaredActions.length > 0 &&
      !sameLegacyAuthorizationProjection(declaredActions, projectedActions)) {
    fail("--allow-action values must exactly match the action projection of --allow-use pairs.");
  }
  if (explicitUses.length > 0 && declaredSubjects.length > 0 &&
      !sameLegacyAuthorizationProjection(declaredSubjects, projectedSubjects)) {
    fail("--allow-subject values must exactly match the subject projection of --allow-use pairs.");
  }
  const allowedActions = explicitUses.length > 0 ? projectedActions : declaredActions;
  const allowedSubjects = explicitUses.length > 0 ? projectedSubjects : declaredSubjects;
  if (!scope || !summary || allowedActions.length === 0) {
    fail("Authorization grant requires --scope, --summary, and at least one --allow-action or --allow-use action=subject pair.");
  }
  const authorityPolicy = context.config.authority_policy || {};
  if (!authorityPolicy.allow_wildcards && allowedActions.some((action) => action === "*" || action.endsWith(".*"))) {
    fail("Wildcard authorization actions are disabled. List each exact --allow-action so the grant cannot silently expand.");
  }
  const attribution = buildAttribution(context, options, "authorization.grant");
  requireFormalApprovalActor(context, options, attribution, "Granting delegated automation authorization");
  if (!['human', 'ci'].includes(attribution.actor.type)) {
    fail("Granting delegated automation authorization requires --actor-type human or ci.");
  }
  const source = normalizeApprovalSource(context, options, attribution, `authorization ${id}`, "approved");
  if (!['explicit-user', 'ci'].includes(source)) {
    fail("Authorization grants must come from explicit-user or ci approval, not automation or bootstrap.");
  }
  if (source === "explicit-user" && attribution.actor.type !== "human") {
    fail("Authorization grants with approval_source explicit-user require --actor-type human.");
  }
  if (source === "ci" && attribution.actor.type !== "ci") {
    fail("Authorization grants with approval_source ci require --actor-type ci.");
  }
  const defaultTtlSeconds = Number(authorityPolicy.default_ttl_seconds || 0);
  const expiresAt = options["expires-at"]
    ? normalizeOptionalDateTime(options["expires-at"], "expires-at")
    : defaultTtlSeconds > 0
      ? new Date(Date.now() + defaultTtlSeconds * 1000).toISOString()
      : null;
  const proposalId = getOptionString(options, "proposal");
  const proposalHash = getOptionString(options, "proposal-hash");
  if (Boolean(proposalId) !== Boolean(proposalHash)) {
    fail("Proposal-bound authorization requires both --proposal and --proposal-hash.");
  }
  const maxUsesRaw = getOptionString(options, "max-uses");
  const maxUses = maxUsesRaw === null ? null : Number(maxUsesRaw);
  if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1)) {
    fail("--max-uses must be a positive integer.");
  }
  const allowedUses = explicitUses.length > 0
    ? explicitUses
    : buildLegacyAuthorizationUses(allowedActions, allowedSubjects, {
      label: `Authorization ${id}`,
      failOnAmbiguous: true,
    });
  const record = {
    id,
    kind: "content_authorization",
    schema_version: "authorization:v3",
    status: "active",
    scope,
    summary,
    allowed_actions: allowedActions,
    allowed_uses: allowedUses,
    allowed_artifact_types: normalizeListOption(options["allow-artifact-type"]).map(normalizeArtifactType),
    allowed_approval_boundaries: normalizeListOption(options["allow-boundary"]),
    allowed_subjects: allowedSubjects,
    proposal_ref: proposalId ? { id: normalizeId(proposalId), hash: proposalHash } : null,
    use_policy: {
      replay: "deny_same_action_subject",
      max_uses: maxUses,
    },
    authority_assurance: getOptionString(options, "authority-assurance") || authorityPolicy.mode || "audit_only",
    expires_at: expiresAt,
    approval_source: source,
    approval_evidence: buildApprovalEvidence(context, options),
    granted_by: attribution.actor,
    created_at: now(),
    updated_at: now(),
    audit: {
      git: attribution.git,
      run: attribution.run,
    },
  };
  if (!authorityPolicy.allow_wildcards && record.allowed_subjects.includes("*")) {
    fail("Wildcard subjects are disabled. List each exact --allow-subject.");
  }
  record.approved_content_hash = hashAuthorizationRecord(record);
  record.hash_algorithm = "sha256:stable-json:v2";
  assertRecordSchema(record, "authorization.schema.json", `Authorization ${id}`);
  ensureDir(authorizationRoot(context));
  writeJsonFile(authorizationPath(context, id), record, { force: Boolean(options.force), forceOption: true });
  appendTraceEvent(context, null, {
    type: "decision",
    summary: `Granted delegated authorization ${id}: ${summary}`,
    action: "authorization.grant",
    actor: attribution.actor,
    evidence: [toProjectPath(context, authorizationPath(context, id)), ...record.approval_evidence.map((item) => item.path)],
    related: [id, ...allowedActions],
    git: attribution.git,
    run: attribution.run,
  });
  output(options, { status: "active", authorization: record }, [
    `Granted authorization ${id}`,
    `Scope: ${scope}`,
    `Allowed actions: ${allowedActions.join(", ")}`,
  ]);
}

export function readAuthorization(context, id, options = {}) {
  const filePath = authorizationPath(context, id);
  if (!fs.existsSync(filePath)) {
    if (options.missingOk) {
      return null;
    }
    fail(`Authorization ${id} does not exist.`);
  }
  const record = readProjectJson(context, filePath);
  const lifecyclePath = authorizationLifecyclePath(context, id);
  if (fs.existsSync(lifecyclePath)) {
    Object.defineProperty(record, "__lifecycle", {
      value: readProjectJson(context, lifecyclePath),
      enumerable: false,
      configurable: false,
    });
  }
  return record;
}

export function showAuthorizations(context, options) {
  ensureInitialized(context);
  const id = getOptionString(options, "id");
  const records = id
    ? [readAuthorization(context, normalizeId(id))]
    : collectJsonFiles(context, authorizationRoot(context));
  output(options, { authorizations: records }, records.length
    ? records.map((record) => `${record.id}: ${record.status}, scope ${record.scope}, actions ${(record.allowed_actions || []).join(", ")}`)
    : ["No delegated automation authorizations found."]);
}

export function revokeAuthorization(context, options) {
  ensureInitialized(context);
  const id = normalizeId(requireOption(options, "id"));
  const attribution = buildAttribution(context, options, "authorization.revoke");
  if (!['human', 'ci'].includes(attribution.actor.type)) {
    fail("Revoking delegated automation authorization requires --actor-type human or ci.");
  }
  const filePath = authorizationPath(context, id);
  const releaseLock = acquireFileLock(`${filePath}.lock`);
  let result;
  try {
    const record = readAuthorization(context, id);
    if (isCanonicalContentAuthorization(record)) {
      const reason = getOptionString(options, "reason") || "Revoked by an authorized human or CI actor.";
      const revocation = createAuthorizationRevocation({
        id: `AREVOKE-${id}-${uniqueRecordSuffix()}`,
        authorization_id: id,
        authorization_hash: record.authorization_hash,
        effective_at: now(),
        reason,
        revoked_by: attribution.actor,
      });
      const lifecyclePath = authorizationLifecyclePath(context, id);
      ensureDir(path.dirname(lifecyclePath));
      writeJsonFile(lifecyclePath, revocation, { force: Boolean(options.force), forceOption: true });
      result = {
        status: "revoked",
        authorization: record,
        revocation,
        lifecycle_path: toProjectPath(context, lifecyclePath),
      };
    } else {
      record.status = "revoked";
      record.revoked_at = now();
      record.revocation_reason = getOptionString(options, "reason") || null;
      record.updated_at = now();
      record.audit = {
        ...(record.audit || {}),
        revoked_by: attribution.actor,
        git: attribution.git,
        run: attribution.run,
      };
      writeJsonFile(filePath, record, { force: true, durable: true });
      result = { status: "revoked", authorization: record };
    }
  } finally {
    releaseLock();
  }
  output(options, result, [`Revoked authorization ${id}`]);
}

export function authorizationUseErrors(record, action, settings = {}) {
  const errors = [];
  if (record.__lifecycle?.effective_at && Date.parse(record.__lifecycle.effective_at) <= Date.now()) {
    errors.push(`Authorization ${record.id} was closed or revoked at ${record.__lifecycle.effective_at}.`);
  }
  const proposalBindingError = authorizationProposalBindingError(
    record,
    settings.proposal_ref ?? null,
  );
  if (proposalBindingError) {
    errors.push(proposalBindingError);
  }
  if (isCanonicalContentAuthorization(record)) {
    try {
      const decision = validateAuthorizationSnapshotAtUse(record, {
        action: String(action || "").trim().toLowerCase(),
        subject: canonicalAuthorizationUseSubject(settings),
        used_at: now(),
      }, record.__lifecycle ? [record.__lifecycle] : []);
      errors.push(...decision.errors.map((error) => `Authorization ${record.id}: ${error}`));
    } catch (error) {
      errors.push(`Authorization ${record.id} cannot validate this action-subject use: ${error.message}`);
    }
    return Array.from(new Set(errors));
  }
  if (record.status !== "active") {
    errors.push(`Authorization ${record.id} is ${record.status || "inactive"}.`);
  }
  if (record.expires_at && Date.parse(record.expires_at) <= Date.now()) {
    errors.push(`Authorization ${record.id} expired at ${record.expires_at}.`);
  }
  if (record.approved_content_hash !== hashAuthorizationRecord(record)) {
    errors.push(`Authorization ${record.id} changed after it was granted.`);
  }
  errors.push(...legacyAuthorizationBindingErrors(record, action, settings.subject_id));
  for (const artifactType of authorizationArtifactTypes(settings)) {
    if (!authorizationAllowsArtifactType(record, artifactType)) {
      errors.push(`Authorization ${record.id} does not allow artifact type ${artifactType}.`);
    }
  }
  for (const boundary of authorizationApprovalBoundaries(settings)) {
    if (!authorizationAllowsApprovalBoundary(record, boundary)) {
      errors.push(`Authorization ${record.id} does not allow approval boundary ${boundary}.`);
    }
  }
  return errors;
}

export function existingExactAuthorizationUse(context, authorization, action, settings = {}) {
  if (!settings.receipt_id) {
    return null;
  }
  const expectedReceiptId = normalizeId(settings.receipt_id);
  const receiptPath = authorizationUsePath(context, authorization.id, expectedReceiptId);
  if (!fs.existsSync(receiptPath)) {
    return null;
  }
  const receipt = readProjectJson(context, receiptPath);
  const receiptErrors = validateAuthorizationUseReceipt(receipt, {
    authorization_id: authorization.id,
    action,
    subject_id: settings.subject_id,
    proposal_ref: settings.proposal_ref,
    subject_hash: settings.subject_hash,
    artifact_types: settings.artifact_types,
    approval_boundaries: settings.approval_boundaries,
  });
  if (receipt.id !== expectedReceiptId) {
    receiptErrors.push(
      `authorization usage receipt id is ${receipt.id || "missing"}, expected ${expectedReceiptId}`,
    );
  }
  if (settings.used_at && receipt.used_at !== settings.used_at) {
    receiptErrors.push(
      `authorization usage receipt time is ${receipt.used_at || "missing"}, expected ${settings.used_at}`,
    );
  }
  if (
    receiptErrors.length > 0
    || receipt.authorization_hash !== authorizationRecordHash(authorization)
  ) {
    fail(
      `Delivery action authorization use ${receipt.id || expectedReceiptId} `
      + `cannot be recovered: ${receiptErrors.join("; ") || "authorization hash mismatch"}.`,
    );
  }
  return {
    receipt,
    path: toProjectPath(context, receiptPath),
    authorization,
  };
}

export function recordAuthorizationUse(context, authorization, action, settings = {}) {
  const authorizationFile = authorizationPath(context, authorization.id);
  const releaseLock = acquireFileLock(`${authorizationFile}.lock`);
  try {
    const current = readAuthorization(context, authorization.id);
    const proposalBindingError = authorizationProposalBindingError(
      current,
      settings.proposal_ref ?? null,
    );
    if (proposalBindingError) {
      fail(proposalBindingError);
    }
    const exactRecovery = existingExactAuthorizationUse(
      context,
      current,
      action,
      settings,
    );
    if (exactRecovery) {
      return exactRecovery;
    }
    const errors = authorizationUseErrors(current, action, settings);
    if (errors.length > 0) {
      fail(errors[0]);
    }
    const useKey = authorizationUseKey(action, settings);
    const usesRoot = authorizationUsesRoot(context, current.id);
    const previous = safeReadDir(usesRoot)
      .filter((name) => name.endsWith(".json"))
      .map((name) => readProjectJson(context, path.join(usesRoot, name)));
    if (current.use_policy?.replay !== "allow" && previous.some((receipt) => {
      const receiptKey = receipt.use_key || authorizationUseKey(receipt.action, receipt.subject || {});
      return receiptKey === useKey && authorizationReceiptAccepted(receipt);
    })) {
      fail(`Authorization ${current.id} was already used for ${action} on ${settings.subject_id || "this subject"}; create a new grant or a versioned amendment instead of replaying it.`);
    }
    const maxUses = Number(current.use_policy?.max_uses || 0);
    const previousAccepted = previous.filter(authorizationReceiptAccepted).length;
    if (maxUses > 0 && previousAccepted >= maxUses) {
      fail(`Authorization ${current.id} has reached its maximum of ${maxUses} accepted use(s).`);
    }
    const usedAt = settings.used_at || now();
    const requestedReceiptId = settings.receipt_id
      ? normalizeId(settings.receipt_id)
      : null;
    let receipt;
    if (isCanonicalContentAuthorization(current)) {
      try {
        receipt = buildCanonicalAuthorizationUsageReceipt(current, {
          id: requestedReceiptId || `AUSE-${current.id}-${uniqueRecordSuffix()}`,
          action: String(action || "").trim().toLowerCase(),
          subject: canonicalAuthorizationUseSubject(settings),
          used_at: usedAt,
          evidence: settings.evidence || [],
        }, current.__lifecycle ? [current.__lifecycle] : []);
      } catch (error) {
        fail(`Cannot create authorization usage receipt for ${current.id}: ${error.message}`);
      }
      if (!receipt.valid_at_use || receipt.decision !== "allow") {
        fail(`Authorization ${current.id} is not valid for ${action}: ${(receipt.errors || []).join("; ")}`);
      }
    } else {
      const allowedUsesAtUse = Array.isArray(current.allowed_uses) && current.allowed_uses.length > 0
        ? current.allowed_uses
        : buildLegacyAuthorizationUses(current.allowed_actions, current.allowed_subjects, {
          label: `Authorization ${current.id}`,
        });
      receipt = {
        id: requestedReceiptId || `AUSE-${current.id}-${uniqueRecordSuffix()}`,
        kind: "authorization_usage_receipt",
        schema_version: "authorization-usage-receipt:legacy-v2",
        authorization_id: current.id,
        authorization_hash: current.approved_content_hash,
        proposal_ref: current.proposal_ref || settings.proposal_ref || null,
        action: String(action || "").trim().toLowerCase(),
        subject_id: settings.subject_id || null,
        artifact_types: authorizationArtifactTypes(settings).sort(),
        approval_boundaries: authorizationApprovalBoundaries(settings).sort(),
        scope: current.scope,
        authority_assurance: current.authority_assurance || "audit_only",
        authorization_snapshot: {
          status_at_use: current.status,
          expires_at: current.expires_at || null,
          allowed_actions: current.allowed_actions || [],
          allowed_subjects: current.allowed_subjects || [],
          allowed_uses: allowedUsesAtUse,
          allowed_artifact_types: current.allowed_artifact_types || [],
          allowed_approval_boundaries: current.allowed_approval_boundaries || [],
        },
        use_key: useKey,
        status: "accepted",
        used_at: usedAt,
        valid_at_use: true,
      };
      receipt.receipt_hash = shortHashFull(stableJson(receipt));
      receipt.hash_algorithm = "sha256:stable-json:v1";
    }
    ensureDir(usesRoot);
    const receiptPath = authorizationUsePath(context, current.id, receipt.id);
    writeJsonFile(receiptPath, receipt, { durable: true });
    const acceptedCount = previousAccepted + 1;
    if (!isCanonicalContentAuthorization(current)) {
      current.use_count = acceptedCount;
      if (maxUses > 0 && acceptedCount >= maxUses) {
        current.status = "consumed";
        current.consumed_at = usedAt;
      }
      current.updated_at = usedAt;
      writeJsonFile(authorizationFile, current, { force: true, durable: true });
    }
    return { receipt, path: toProjectPath(context, receiptPath), authorization: current };
  } finally {
    releaseLock();
  }
}

export function readAuthorizationUseReceipt(context, reference, options = {}) {
  if (!reference) {
    return null;
  }
  const relative = String(reference).replace(/\\/g, "/");
  const configuredRoot = authorizationUsesRoot(context);
  const filePath = resolveProjectFilePath(context, relative, {
    mustExist: !options.missingOk,
    fileOnly: !options.missingOk,
  });
  if (!isInsidePath(configuredRoot, filePath) || path.resolve(filePath) === path.resolve(configuredRoot)) {
    if (options.missingOk) {
      return null;
    }
    fail(`Invalid authorization use receipt reference '${reference}'.`);
  }
  if (!fs.existsSync(filePath)) {
    return null;
  }
  assertNoSymlinkPathSegments(filePath, context.root);
  return readProjectJson(context, filePath);
}

export function requireAutomationAuthorization(context, options, action, settings = {}) {
  const id = getOptionString(options, "authorization");
  if (!id) {
    fail(`${settings.label || action} uses delegated automation approval and requires --authorization <id>. Free-text --scope is not sufficient.`);
  }
  const record = readAuthorization(context, normalizeId(id));
  const exactRecovery = existingExactAuthorizationUse(
    context,
    record,
    action,
    settings,
  );
  if (exactRecovery) {
    Object.defineProperty(record, "__use_receipt", {
      value: exactRecovery,
      enumerable: false,
      configurable: false,
    });
    return record;
  }
  const errors = authorizationUseErrors(record, action, settings);
  if (errors.length > 0) {
    fail(errors[0]);
  }
  const requestedScope = getOptionString(options, "scope");
  if (requestedScope && requestedScope !== record.scope) {
    fail(`--scope '${requestedScope}' does not match authorization ${record.id} scope '${record.scope}'.`);
  }
  if (settings.record_use === false) {
    return record;
  }
  const use = recordAuthorizationUse(context, record, action, settings);
  Object.defineProperty(use.authorization, "__use_receipt", {
    value: use,
    enumerable: false,
    configurable: false,
  });
  return use.authorization;
}

export function showApprovalRequests(context, options) {
  ensureInitialized(context);
  const storyId = options.story ? normalizeId(String(options.story)) : null;
  const requests = collectApprovalRequests(context, { storyId, includeProposals: true });
  const assistantMessage = renderApprovalRequestsAssistantMessage(requests);
  const internalRefreshOnly = requests.length > 0
    && requests.every((request) => request.status === "needs_internal_refresh");
  const guidance = approvalRequestsHumanGuidance(requests, options, { internalRefreshOnly });
  output(
    options,
    {
      kind: "approval_requests",
      story_id: storyId,
      status: requests.length
        ? (internalRefreshOnly ? "needs_internal_refresh" : "needs_user_input")
        : "clear",
      generated_at: now(),
      assistant_message: assistantMessage,
      human_guidance: guidance,
      internal_refresh_only: internalRefreshOnly,
      ...assistantMessagePresentationFields(),
      requests,
      source_paths: Array.from(new Set(requests.flatMap((request) => request.sources || []))).sort(),
    },
    humanGuidanceLines(
      guidance,
      approvalAssistantMessageLinesForLocale(requests, options, assistantMessage),
      options,
      approvalRequestsPrimarySummary(requests, options, { internalRefreshOnly }),
    ),
  );
}

export function approvalRequestsHumanGuidance(requests, options, { internalRefreshOnly = false } = {}) {
  const italian = humanGuidanceLocale(options) === "it";
  if (requests.length === 0) {
    return {
      result: italian ? "Non ci sono decisioni in attesa." : "There are no decisions waiting for you.",
      impact: italian ? "Il lavoro può proseguire con il prossimo passo già concordato." : "Work can continue with the next step already agreed.",
      required_decision: italian ? "Non devi decidere nulla adesso." : "You do not need to decide anything now.",
      protection_boundary: italian ? "Questo controllo non amplia il lavoro né autorizza altre modifiche, merge o rilasci." : "This check does not widen the work or authorize other changes, merges, or releases.",
      next_action: italian ? "Continua con il prossimo passo già concordato." : "Continue with the next step already agreed.",
      details: { request_count: 0 },
    };
  }
  if (internalRefreshOnly) {
    return {
      result: italian ? "Devo aggiornare alcuni riferimenti al progetto prima di continuare." : "I need to refresh some project references before continuing.",
      impact: italian ? "L'obiettivo e i limiti concordati non cambiano; aggiornerò soltanto i riferimenti divenuti obsoleti." : "The agreed goal and limits do not change; I will only update references that became outdated.",
      required_decision: italian ? "Non devi approvare nulla: il lavoro concordato non è cambiato." : "You do not need to approve anything because the agreed work has not changed.",
      protection_boundary: italian ? "L'aggiornamento non aggiunge attività, strumenti, file, merge o rilasci." : "The refresh adds no work, tools, files, merges, or releases.",
      next_action: italian ? "Aggiornerò i riferimenti e ripeterò il controllo prima di proseguire." : "I will refresh the references and repeat the check before continuing.",
      details: { request_count: requests.length, internal_refresh_only: true },
    };
  }
  const count = requests.length;
  return {
    result: italian
      ? `${count === 1 ? "C'è una scelta" : `Ci sono ${count} scelte`} da confermare prima di continuare.`
      : `${count === 1 ? "One choice needs" : `${count} choices need`} your answer before work continues.`,
    impact: italian ? "Il lavoro resta fermo finché non confermi, correggi o rifiuti le scelte riepilogate qui sotto." : "Work remains paused until you confirm, correct, or reject the choices summarized below.",
    required_decision: italian ? "Per ogni voce, indica in parole normali se va bene o cosa deve cambiare." : "For each item, say in ordinary language whether it is right or what should change.",
    protection_boundary: italian ? "La risposta vale solo per le voci mostrate; non autorizza altre consegne, merge, rilasci, produzione o accesso a segreti." : "Your answer applies only to the items shown; it does not authorize other deliveries, merges, releases, production, or secret access.",
    next_action: italian ? "Leggi il riepilogo qui sotto e rispondi voce per voce." : "Read the summary below and answer item by item.",
    details: { request_count: count, internal_refresh_only: false },
  };
}

export function approvalRequestsPrimarySummary(requests, options, { internalRefreshOnly = false } = {}) {
  if (requests.length === 0) return [];
  const italian = humanGuidanceLocale(options) === "it";
  const heading = internalRefreshOnly
    ? (italian ? "Riferimenti da aggiornare:" : "References to refresh:")
    : (italian ? "Scelte da esaminare:" : "Choices to review:");
  return [
    heading,
    ...requests.flatMap((request, index) => {
      const copy = approvalRequestPrimaryCopy(request, italian);
      const highlights = approvalRequestPrimaryHighlights(request, italian);
      return [
        `${index + 1}. ${copy.label} — ${copy.decision}`,
        ...highlights.map((highlight) => `   ${italian ? "Cosa comprende" : "What it includes"}: ${highlight}`),
      ];
    }),
  ];
}

export function approvalRequestPrimaryHighlights(request, italian = false) {
  return userVisibleReviewItems(request)
    .map((item) => safePrimaryGuidanceText(item, request))
    .filter(Boolean)
    .map((item) => italian
      ? localizeApprovalHighlightItalian(request, item)
      : item)
    .filter(Boolean)
    .slice(0, 2);
}

export function localizeApprovalHighlightItalian(request, item) {
  if (request.type === "capability_profile_approval") {
    if (item.startsWith("What this is:")) {
      return "Definisce le evidenze del progetto, i controlli locali e i limiti degli strumenti utilizzabili; non approva il risultato dell’implementazione né l’accordo di lavoro.";
    }
    if (item.startsWith("Work scope:")) {
      return `Ambito del lavoro: ${item.slice("Work scope:".length).trim()
        .replace(/\bscope project\b/gu, "progetto")
        .replace(/\bphase\b/gu, "fase")
        .replace(/\bwork item\b/gu, "attività")}`;
    }
  }
  if (request.type === "capability_recommendation_approval") {
    if (item.startsWith("What this is:")) {
      return "Elenca gli strumenti, i permessi, le destinazioni e le eventuali installazioni consentite per questo lavoro; non approva il risultato finale.";
    }
    if (item.startsWith("Based on approved evidence and boundaries:")) {
      return `Basato sulle evidenze e sui limiti già approvati: ${item.slice("Based on approved evidence and boundaries:".length).trim()}`;
    }
  }
  if (request.type === "output_template_approval") {
    if (item.startsWith("What this is:")) {
      return "Definisce struttura, livello di dettaglio e modalità di consegna del risultato; non approva il contenuto finale né l’accordo di lavoro.";
    }
    if (item.startsWith("Decision scope:")) {
      return "Questa decisione approva soltanto la struttura del risultato mostrato, non il suo contenuto finale.";
    }
  }
  if (item.startsWith("Confidence:")) {
    return `Affidabilità stimata: ${item.slice("Confidence:".length).trim()}`;
  }
  return item
    .replace(/^Purpose:/u, "Obiettivo:")
    .replace(/^Context:/u, "Contesto:")
    .replace(/^Expected output:/u, "Risultato atteso:")
    .replace(/^Validation:/u, "Verifica:");
}

export function collectApprovalRequests(context, options = {}) {
  const scope = normalizeApprovalCollectionScope(options);
  const baselineRequests = collectBaselineApprovalRequests(context, scope.storyId);
  if (baselineRequests.length > 0) {
    return baselineRequests;
  }
  const requests = [
    ...collectCapabilityProfileApprovalRequests(context, scope.storyId),
    ...collectCapabilityRecommendationApprovalRequests(context, scope.storyId),
    ...collectOutputTemplateApprovalRequests(context, scope.storyId),
    ...collectContractClarificationRequests(context, scope),
    ...collectContractApprovalRequests(context, scope),
    ...collectOutputLinkActionRequests(context, scope),
    // Proposals waiting for a person (requirements, breakdowns, delivery
    // autonomy, workflows, standing approvals) are listed where a person looks
    // for pending decisions; task-start scoping and gates keep their own set.
    ...(options.includeProposals === true && !scope.activeOnly
      ? collectPendingProposalRequests(context, { storyId: scope.storyId })
      : []),
  ];
  return scope.activeOnly
    ? filterApprovalRequestsForActiveScope(context, requests, scope)
    : requests;
}

export function activeContractForApprovalScope(context, scope) {
  if (scope.contractId) {
    return readContractById(context, scope.contractId, { missingOk: true });
  }
  if (scope.storyId) {
    const story = readStory(context, scope.storyId);
    if (story?.contract_id) {
      return readContractById(context, story.contract_id, { missingOk: true });
    }
    const candidates = collectJsonFiles(context, path.join(context.sdlcRoot, "contracts"))
      .filter((contract) => contract.story_id === scope.storyId)
      .filter((contract) => !scope.phase || contract.phase === scope.phase);
    return candidates.length > 0 ? newestContract(candidates) : null;
  }
  return null;
}

export function filterApprovalRequestsForActiveScope(context, requests, scope) {
  const activeContract = activeContractForApprovalScope(context, scope);
  const templateIds = new Set((activeContract?.output_contract_refs || []).map((ref) => ref.template_id).filter(Boolean));
  const recommendationIds = new Set(
    (activeContract?.capability_recommendation_refs || []).map((ref) => ref.id).filter(Boolean),
  );
  const recommendationProfileIds = new Set(
    (activeContract?.capability_recommendation_refs || []).map((ref) => ref.profile_id).filter(Boolean),
  );
  return requests.filter((request) => {
    if (request.type?.startsWith("baseline_")) {
      return true;
    }
    if (
      request.type === "contract_approval"
      || request.type === "contract_clarification"
      || request.type === "output_link_required"
    ) {
      return true;
    }
    if (request.type === "output_template_approval") {
      return templateIds.has(request.subject_id);
    }
    if (request.type?.startsWith("capability_recommendation_")) {
      if (recommendationIds.has(request.subject_id)) {
        return true;
      }
      const recommendation = readCapabilityRecommendations(context)
        .find((candidate) => candidate.id === request.subject_id);
      if (!recommendation) return false;
      const profile = readCapabilityProfiles(context)
        .find((candidate) => candidate.id === recommendation.profile_id);
      return approvalSubjectMatchesActiveScope(profile?.subject, scope);
    }
    if (request.type?.startsWith("capability_profile_")) {
      if (recommendationProfileIds.has(request.subject_id)) {
        return true;
      }
      const profile = readCapabilityProfiles(context)
        .find((candidate) => candidate.id === request.subject_id);
      return approvalSubjectMatchesActiveScope(profile?.subject, scope);
    }
    return (
      Boolean(scope.storyId && request.story_id === scope.storyId)
      || Boolean(scope.phase && request.phase === scope.phase)
      || Boolean(scope.contractId && request.subject_id === scope.contractId)
    );
  });
}

export function renderApprovalRequestsAssistantMessage(requests) {
  if (!requests.length) {
    return [
      "There are no pending SDLC approvals or clarifications.",
      "I can continue with the next operational step when needed.",
    ].join("\n");
  }
  const internalRefreshOnly = requests.every((request) => request.status === "needs_internal_refresh");
  return [
    internalRefreshOnly
      ? "I need to refresh internal project references before I continue; this does not ask you to approve a changed scope."
      : "I need your decision before I continue.",
    "Plainly: I am checking that I use the right project context, produce the output in the right format, and stay inside the work you actually want. You do not need to know the workflow terms; answer the questions in normal language.",
    "I will summarize the relevant file contents here. Links and file paths are supporting evidence, not homework for you.",
    "Important: your approval applies only to the item or items shown in this message. If I create a new format, evidence/boundary set, tool choice, work brief, or start confirmation later, I must show what is inside it and ask again unless you already gave a broader scope.",
    "",
    ...requests.flatMap((request, index) => formatHumanApprovalRequest(request, index + 1)),
    internalRefreshOnly ? null : "You can answer in natural language, for example:",
    internalRefreshOnly ? null : '- "Use README.md, package.json, and src/ as the trusted context; the proposed output format is fine."',
    internalRefreshOnly ? null : '- "The sections are fine, but also include deployment risks."',
    internalRefreshOnly ? null : '- "Do not start yet; first explain item 2 in simpler terms."',
  ].filter(Boolean).join("\n");
}

export function approvalAssistantMessageLinesForLocale(requests, options, englishMessage) {
  if (humanGuidanceLocale(options) !== "it") {
    return englishMessage.split("\n");
  }
  if (requests.length === 0) {
    return [
      "Non ci sono approvazioni o chiarimenti SDLC in attesa.",
      "Quando serve, posso continuare con il prossimo passo operativo.",
    ];
  }
  const internalRefreshOnly = requests.every((request) => request.status === "needs_internal_refresh");
  const lines = [
    internalRefreshOnly
      ? "Devo aggiornare alcuni riferimenti interni al progetto; non ti sto chiedendo di approvare un ambito diverso."
      : "Ho bisogno della tua decisione prima di continuare.",
    "In breve: sto verificando di usare il contesto corretto, produrre il risultato nel formato concordato e restare entro i limiti del lavoro richiesto.",
    "La risposta vale soltanto per le voci mostrate e non autorizza decisioni future, altre consegne, merge, rilasci o accessi non concordati.",
    "",
  ];
  for (const [index, request] of requests.entries()) {
    const copy = approvalRequestPrimaryCopy(request, true);
    const targetedHighlights = [
      "capability_profile_approval",
      "capability_recommendation_approval",
      "output_template_approval",
    ].includes(request.type)
      ? approvalRequestPrimaryHighlights(request, true)
      : [];
    const scopeLine = request.type === "capability_profile_approval"
      && (request.phase || request.story_id)
      ? [
          "   Ambito del lavoro: "
          + [
            request.phase ? `fase ${request.phase}` : null,
            request.story_id ? `attività ${request.story_id}` : null,
          ].filter(Boolean).join(", "),
        ]
      : [];
    lines.push(
      `${index + 1}. ${copy.label}${request.subject_id ? ` (${request.subject_id})` : ""}`,
      ...scopeLine,
      ...targetedHighlights.map((highlight) => `   Cosa comprende: ${highlight}`),
      `   Decisione richiesta: ${copy.decision}`,
      "   Ambito della risposta: vale solo per questa voce; un nuovo formato, strumento, accordo di lavoro o avvio richiede una nuova conferma.",
      "",
    );
  }
  if (!internalRefreshOnly) {
    lines.push(
      "Puoi rispondere in linguaggio naturale, per esempio:",
      '- "Va bene questo insieme di evidenze e limiti."',
      '- "La struttura va bene, ma aggiungi i rischi di rilascio."',
      '- "Non iniziare ancora: spiegami meglio la seconda voce."',
    );
  }
  return lines;
}

export function collectBaselineApprovalRequests(context, storyId = null) {
  const executionContext = storyId ? executionContextForStory(context, storyId) : null;
  return selectActiveBaselines(context, storyId)
    .filter((baseline) => {
      const approved = String(baseline.status || "").toLowerCase() === "approved";
      const stale =
        validateBaselineSourceHashes(context, baseline, `baseline ${baseline.id}`, {
          collectOnly: true,
          executionContext,
        }).length > 0 ||
        (approved && !isApprovedRecordFresh(baseline));
      return !approved || stale;
    })
    .map((baseline) => buildBaselineApprovalRequest(context, baseline));
}

export function collectCapabilityProfileApprovalRequests(context, storyId = null) {
  const executionContext = storyId ? executionContextForStory(context, storyId) : null;
  return readCapabilityProfiles(context)
    .filter(
      (profile) =>
        profile.status !== "approved" ||
        !isApprovedRecordFresh(profile) ||
        validateCapabilityRecordSourceHashes(context, profile, `capability profile ${profile.id}`, {
          collectOnly: true,
          executionContext,
          bindingKind: "capability_profile",
        }).length > 0,
    )
    .filter((profile) => capabilityRecordMatchesStory(context, profile, storyId))
    .map((profile) => buildCapabilityProfileApprovalRequest(context, profile, { executionContext }));
}

export function buildCapabilityProfileApprovalRequest(context, profile, options = {}) {
  const profilePath = toProjectPath(context, capabilityProfilePath(context, profile.id));
  const staleSources = validateCapabilityRecordSourceHashes(
    context,
    profile,
    `capability profile ${profile.id}`,
    {
      collectOnly: true,
      executionContext: options.executionContext,
      bindingKind: "capability_profile",
    },
  );
  if (profile.status === "approved" && (!isApprovedRecordFresh(profile) || staleSources.length > 0)) {
    return {
      id: `refresh-capability-profile-${profile.id}`,
      type: "capability_profile_refresh_required",
      status: "needs_internal_refresh",
      summary: `Refresh capability evidence ${profile.id}; its sources or approved snapshot changed.`,
      subject_id: profile.id,
      story_id: profile.subject?.story_id || null,
      sources: [profilePath, ...(profile.source_paths || [])].filter(Boolean),
      ...humanApprovalFields({
        title: `Refresh project evidence and boundaries (${profile.id})`,
        why_needed: "The evidence behind this internal capability record changed. I must rebuild it before relying on it; refreshing does not broaden permissions.",
        review_items: [
          `Previous scope: ${formatCapabilitySubject(profile.subject)}`,
          staleSources.length ? `Changed evidence: ${formatLimitedList(staleSources, 8)}` : "The approved record content changed after approval.",
          `Current source files: ${formatLimitedList(profile.source_paths || [], 10)}`,
        ],
        approval_meaning: "No new approval is created by this refresh. A material boundary change still requires a decision.",
        after_approval: "After refresh, the current policy or combined proposal determines whether a fresh approval is needed.",
      }),
      suggested_command: `agentic-sdlc capability profile propose --id ${profile.id}${profile.subject?.story_id ? ` --story ${profile.subject.story_id}` : ""}${profile.subject?.phase ? ` --phase ${profile.subject.phase}` : ""}${profile.source_paths?.[0] ? ` --context-file ${profile.source_paths[0]}` : ""} --force`,
    };
  }
  return {
    id: `approve-capability-profile-${profile.id}`,
    type: "capability_profile_approval",
    status: "needs_explicit_user_approval",
    summary: "Confirm or revise the evidence and boundaries I may use before choosing tools for the work.",
    subject_id: profile.id,
    subject_status: profile.status || null,
    story_id: profile.subject?.story_id || null,
    phase: profile.subject?.phase || null,
    sources: [profilePath, ...(profile.source_paths || [])].filter(Boolean),
    ...humanApprovalFields({
      title: `Project evidence and boundaries (${profile.id})`,
      why_needed: "Before I choose tools for this work, I need you to confirm the boundaries: which project evidence I can rely on and what kind of local checks are acceptable.",
      review_items: [
        "What this is: the list of project evidence, local checks, and tool boundaries I may use. It is not the implementation result or other final content, and it does not approve the final work brief.",
        `Work scope: ${formatCapabilitySubject(profile.subject)}`,
        profile.detected_stack?.length ? `Project signals found: ${formatDetectedStackForUser(profile.detected_stack)}` : null,
        profile.evidence?.length ? `Evidence I used to build this profile: ${formatCapabilityEvidenceForUser(profile.evidence)}` : null,
        profile.constraints?.length ? `Boundaries already recorded: ${profile.constraints.join("; ")}` : null,
        profile.source_paths?.length ? `Source files behind this proposal: ${formatLimitedList(profile.source_paths, 10)}` : null,
        profile.confidence !== undefined ? `Confidence: ${profile.confidence}` : null,
      ],
      approval_meaning: "If you approve it, I can use these boundaries to choose the concrete tools for the work. I still need approval for the final work brief unless your broader scope already covers it.",
      approve_if: "Approve if local repository/document reading and the detected project signals are accurate enough for this work.",
      change_if: "Ask for changes if I should not run tests, should not use certain files, should include a Word/document skill, or should avoid any tool category.",
      after_approval: "Then I can choose the allowed tools based on these boundaries.",
      user_prompt: "Can I use this evidence and boundary set, or should I change the allowed files, checks, or tool limits first?",
      approval_phrase: "Use this evidence and boundary set.",
    }),
    suggested_question: "After reading the explanation above, do you approve this evidence and boundary set, or should it be revised?",
    suggested_command: `agentic-sdlc capability profile approve --id ${profile.id} --actor-type human --approval-source explicit-user --summary "<user-approved capability profile>"`,
  };
}

export function collectCapabilityRecommendationApprovalRequests(context, storyId = null) {
  const executionContext = storyId ? executionContextForStory(context, storyId) : null;
  return readCapabilityRecommendations(context)
    .filter(
      (recommendation) =>
        recommendation.status !== "approved" ||
        !isApprovedRecordFresh(recommendation) ||
        validateCapabilityRecordSourceHashes(
          context,
          recommendation,
          `capability recommendation ${recommendation.id}`,
          {
            collectOnly: true,
            executionContext,
            bindingKind: "capability_recommendation",
          },
        ).length > 0 ||
        capabilityRecommendationNeedsInstallApproval(recommendation),
    )
    .filter((recommendation) => capabilityRecommendationMatchesStory(context, recommendation, storyId))
    .map((recommendation) => buildCapabilityRecommendationApprovalRequest(
      context,
      recommendation,
      { executionContext },
    ));
}

export function buildCapabilityRecommendationApprovalRequest(context, recommendation, options = {}) {
  const recommendationPath = toProjectPath(context, capabilityRecommendationPath(context, recommendation.id));
  const needsInstallApproval = capabilityRecommendationNeedsInstallApproval(recommendation);
  const staleSources = validateCapabilityRecordSourceHashes(
    context,
    recommendation,
    `capability recommendation ${recommendation.id}`,
    {
      collectOnly: true,
      executionContext: options.executionContext,
      bindingKind: "capability_recommendation",
    },
  );
  if (
    recommendation.status === "approved" &&
    !needsInstallApproval &&
    (!isApprovedRecordFresh(recommendation) || staleSources.length > 0)
  ) {
    return {
      id: `refresh-capability-recommendation-${recommendation.id}`,
      type: "capability_recommendation_refresh_required",
      status: "needs_internal_refresh",
      summary: `Refresh tool recommendation ${recommendation.id}; its approved evidence is stale.`,
      subject_id: recommendation.id,
      sources: [recommendationPath, ...(recommendation.source_paths || [])].filter(Boolean),
      ...humanApprovalFields({
        title: `Refresh allowed-tool recommendation (${recommendation.id})`,
        why_needed: "The approved tool recommendation or its evidence changed. I must rebuild it before use; this refresh cannot add installs, external access, secrets, or new permissions.",
        review_items: [
          `Profile: ${recommendation.profile_id || "unknown"}`,
          staleSources.length ? `Changed evidence: ${formatLimitedList(staleSources, 8)}` : "The approved recommendation content changed after approval.",
          `Previous tools: ${formatCapabilityRecommendationsForUser(recommendation.recommendations || [])}`,
        ],
        approval_meaning: "No new permission is granted by refreshing the internal record.",
        after_approval: "A materially different tool or permission set must return to the combined proposal.",
      }),
      suggested_command: `agentic-sdlc capability recommend --id ${recommendation.id} --profile ${recommendation.profile_id} --force`,
    };
  }
  return {
    id: `approve-capability-recommendation-${recommendation.id}`,
    type: "capability_recommendation_approval",
    status: needsInstallApproval ? "needs_install_approval" : "needs_explicit_user_approval",
    summary: "Confirm or revise the concrete tools and permissions I may use for the work.",
    subject_id: recommendation.id,
    subject_status: recommendation.status || null,
    sources: [recommendationPath, ...(recommendation.source_paths || [])].filter(Boolean),
    ...humanApprovalFields({
      title: `Allowed tools for this work (${recommendation.id})`,
      why_needed: "This is the concrete list of skills, tools, connectors, models, permissions, and installs I would be allowed to use for the work.",
      review_items: [
        "What this is: the concrete list of tools, permissions, targets, and install choices I may use. It does not approve the final document.",
        recommendation.profile_id ? `Based on approved evidence and boundaries: ${recommendation.profile_id}` : null,
        recommendation.recommendations?.length ? `Recommended capabilities: ${formatCapabilityRecommendationsForUser(recommendation.recommendations)}` : null,
        formatCapabilityPolicyPatchForUser(recommendation.policy_patch),
        recommendation.bindings?.length ? `Specific bindings or targets: ${formatCapabilityBindingsForUser(recommendation.bindings)}` : null,
        ...(recommendation.open_questions || []).map((question, index) =>
          formatExplainedOpenQuestion(explainOpenQuestion(context, question), index + 1),
        ),
        recommendation.open_questions?.length ? null : "Missing information: none listed; this is waiting for approval or requested changes.",
        needsInstallApproval ? `Install decision needed: ${formatCapabilityInstallNeeds(recommendation.recommendations)}` : "Install decision: no new installation approval is needed.",
      ],
      approval_meaning: "If you approve it, I can use these tools and permissions in the work brief. I still need approval for the brief itself unless your broader scope already covers it.",
      approve_if: "Approve if the listed tools, permissions, targets, and install choices are acceptable for this work.",
      change_if: "Ask for changes if you want to remove a tool, forbid installs, avoid running tests, add Word document generation, or restrict local filesystem access.",
      after_approval: "Then I can use these tool choices when creating or updating the work brief.",
      user_prompt: "Can I use these tools and permissions, or should I change tools, installs, external access, or targets first?",
      approval_phrase: "Use these tool choices.",
    }),
    suggested_question: "After reading the explanation above, do you approve these tool choices, or should they be revised?",
    suggested_command: `agentic-sdlc capability approve --id ${recommendation.id} --actor-type human --approval-source explicit-user --summary "<user-approved capability recommendation>"${needsInstallApproval ? " --approve-install" : ""}`,
  };
}

export function buildBaselineApprovalRequest(context, baseline) {
  const baselinePath = `.sdlc/baseline/${baseline.id}.json`;
  const reportPath = `.sdlc/baseline/${baseline.id}-current-state.md`;
  const staleSources = validateBaselineSourceHashes(context, baseline, `baseline ${baseline.id}`, { collectOnly: true });
  if (staleSources.length > 0) {
    return buildBaselineRefreshRequest(context, baseline, baselinePath, reportPath, staleSources);
  }
  const reportHeadings = readProjectMarkdownHeadings(context, reportPath, 8);
  const reportExcerpt = readProjectFileExcerpt(context, reportPath, 900);
  const currentStateSummary = formatBaselineCurrentStateSummary(baseline, reportExcerpt);
  const sources = [baselinePath, reportPath].filter((source) => fs.existsSync(path.join(context.root, source)));
  return {
    id: `approve-baseline-${baseline.id}`,
    type: "baseline_approval",
    status: "needs_explicit_user_approval",
    summary: `Approve or revise baseline ${baseline.id} before treating inferred project facts as canonical.`,
    subject_id: baseline.id,
    subject_status: baseline.status || null,
    sources,
    ...humanApprovalFields({
      title: `Project context (${baseline.id})`,
      why_needed: "I inspected the project and inferred some facts. Before I rely on them, you should confirm they are accurate enough for this work.",
      review_items: [
        baseline.summary ? `Project summary I inferred: ${baseline.summary}` : null,
        formatBaselineDetectedStack(baseline),
        formatBaselineImportedDocuments(baseline),
        formatBaselineKeyFiles(baseline),
        reportHeadings.length ? `Current-state report covers: ${reportHeadings.join(", ")}` : null,
        currentStateSummary ? `Current-state summary to approve: ${currentStateSummary}` : null,
        baseline.source_paths?.length ? `Evidence files used: ${formatLimitedList(baseline.source_paths, 12)}` : null,
        baseline.assumptions?.length ? `Assumptions I recorded: ${baseline.assumptions.join(" ")}` : null,
        ...(baseline.open_questions || []).map((question, index) =>
          formatExplainedOpenQuestion(explainOpenQuestion(context, question), index + 1),
        ),
      ],
      approval_meaning: "If you approve it, I can use these project facts as trusted context instead of asking again or guessing.",
      approve_if: "Approve if the project summary, stack, documents, important files, assumptions, and open questions are accurate enough for the work you requested.",
      change_if: "Ask for changes if sources are missing, the inferred stack is wrong, the project description is misleading, or you want to add or remove canonical facts.",
      after_approval: `Then I can treat ${baseline.id} as trusted project context.`,
      user_prompt: `Can I use the inferred project context ${baseline.id}, or should I correct it first?`,
      approval_phrase: `Use project context ${baseline.id}.`,
    }),
    suggested_question: `After reading the summary above, do you approve baseline ${baseline.id} as canonical, or should it be revised?`,
    suggested_command: `agentic-sdlc baseline approve --id ${baseline.id} --actor-type human --approval-source explicit-user --summary "<user-confirmed baseline>"`,
  };
}

export function collectOutputTemplateApprovalRequests(context, storyId = null) {
  const registry = readOutputRegistry(context, { missingOk: true });
  if (!registry) {
    return [];
  }
  const relevantTemplateIds = storyId ? collectStoryTemplateIds(context, storyId, registry) : null;
  return (registry.templates || [])
    .filter((template) => !relevantTemplateIds || relevantTemplateIds.has(template.id) || outputTemplateNeedsApproval(context, template))
    .filter((template) => outputTemplateNeedsApproval(context, template))
    .map((template) => buildOutputTemplateApprovalRequest(context, template));
}

export function outputTemplateNeedsApproval(context, template) {
  if (template.status !== "approved" || !template.path || !template.approved_content_hash) {
    return true;
  }
  const templatePath = resolveProjectFilePath(context, template.path, { mustExist: false });
  return (
    !fs.existsSync(templatePath) ||
    !fs.statSync(templatePath).isFile() ||
    hashFile(templatePath) !== template.approved_content_hash ||
    !outputDeliveryIsFresh(template)
  );
}

export function buildOutputTemplateApprovalRequest(context, template) {
  const templateExcerpt = template.path ? readProjectFileExcerpt(context, template.path, 1200) : null;
  const templateHeadings = template.path ? readProjectMarkdownHeadings(context, template.path, 10) : [];
  const delivery = effectiveOutputDelivery(template);
  return {
    id: `approve-output-template-${template.id}`,
    type: "output_template_approval",
    status: "needs_explicit_user_approval",
    summary: `Agree output format ${template.id} for ${template.type} before using it as a contract output.`,
    subject_id: template.id,
    subject_status: template.status || null,
    artifact_type: template.type || null,
    sources: [template.path, ".sdlc/output-contracts/registry.json"].filter(Boolean),
    ...humanApprovalFields({
      title: `Output format (${template.id})`,
      why_needed: "Before I create the result, I need to confirm its sections, level of detail, and canonical file format.",
      review_items: [
        "What this is: the proposed structure and delivery style for the result. It does not approve the final content or the work brief.",
        `Decision scope: this only approves the document structure for ${template.type || "this"} outputs. It does not approve the final content.`,
        `Output type: ${template.type || "unknown"}`,
        `Canonical result: ${formatOutputDeliveryForHuman(delivery)}. This choice is enforced when the output file is linked.`,
        template.summary ? `Summary: ${template.summary}` : null,
        templateHeadings.length ? `Document sections: ${templateHeadings.join(" > ")}` : null,
        template.path ? `Template file: ${template.path}` : null,
        `Template content to review: ${templateExcerpt || "unavailable"}`,
      ],
      delivery_format_options: [
        ...canonicalOutputFormatOptions(),
        ...deliveryFormatOptionsForOutput(template.type),
      ],
      recommended_delivery_format: formatOutputDeliveryForHuman(delivery),
      delivery_question: `Should the canonical result remain ${delivery.label} (${delivery.extension}) with delivery mode ${delivery.mode}, or should I change it before approval?`,
      approval_meaning: "If you approve it, I can create the result using this structure and must deliver the canonical file in the selected format. You will still review the actual content afterwards.",
      approve_if: "Approve if these sections match the result you expect.",
      change_if: "Ask for changes if you want different sections, more detail, less detail, or a different presentation.",
      after_approval: `Then I can use ${template.id} as the output format.`,
      user_prompt: `Is this output format OK, or should I change the sections before creating the result?`,
      approval_phrase: `The output format ${template.id} is OK.`,
    }),
    suggested_question: `After reviewing the template structure, do you approve output format ${template.id} for ${template.type}?`,
    suggested_command: `agentic-sdlc output template approve --id ${template.id} --actor-type human --approval-source explicit-user --summary "<user-approved output format>"`,
  };
}

export function collectContractApprovalRequests(context, scope = {}) {
  return collectJsonFiles(context, path.join(context.sdlcRoot, "contracts"))
    .filter((contract) => contractMatchesStoryApprovalScope(context, contract, scope))
    .filter((contract) => collectContractReadinessGaps(context, contract).length === 0)
    .filter((contract) => collectContractDependencyFreshnessGaps(context, contract).length === 0)
    .filter((contract) => contract.human_gate === true && (contract.status !== "approved" || !hasFreshApprovedContractApproval(contract)))
    .map((contract) => ({
      id: `approve-contract-${contract.id}`,
      type: "contract_approval",
      status: "needs_explicit_user_approval",
      summary: `Approve or revise ${contract.phase} contract ${contract.id} before phase work proceeds.`,
      subject_id: contract.id,
      subject_status: contract.status || null,
      story_id: contract.story_id || null,
      phase: contract.phase || null,
      sources: [contract.__relative_path],
      ...humanApprovalFields({
        title: `Work brief (${contract.id})`,
        why_needed: "This is the short operating brief for the work: what I should do, what context to use, what output to produce, and what boundaries to respect.",
        review_items: describeContractForHuman(context, contract),
        delivery_format_options: deliveryFormatOptionsForContract(contract),
        recommended_delivery_format: recommendedDeliveryFormatForContract(contract),
        delivery_question: deliveryQuestionForContract(contract),
        approval_meaning: "If you approve it, I can start the work under this brief. You are not approving the final result yet.",
        approve_if: "Approve if the objective, context, boundaries, tools, and expected output match what you want.",
        change_if: "Ask for changes if the scope is unclear, important files are missing, or the output is not what you want.",
        after_approval: `Then the step can start, and outputs must still follow the approved template.`,
        user_prompt: `Can I use this work brief, or should I change scope, context, output, or criteria first?`,
        approval_phrase: `Use work brief ${contract.id}.`,
      }),
      suggested_question: `Review contract ${contract.id}. Do you approve this phase contract, or should it be changed?`,
      suggested_command: `agentic-sdlc contract approve --id ${contract.id} --actor-type human --approval-source explicit-user --summary "<user-approved contract>"`,
    }));
}

export function contractMatchesStoryApprovalScope(context, contract, rawScope = {}) {
  const scope = typeof rawScope === "string"
    ? normalizeApprovalCollectionScope({ storyId: rawScope })
    : normalizeApprovalCollectionScope(rawScope);
  if (scope.contractId) {
    return contract.id === scope.contractId;
  }
  if (scope.storyId) {
    if (scope.phase && contract.phase !== scope.phase) {
      return false;
    }
    const story = readStory(context, scope.storyId);
    if (story?.contract_id) {
      return contract.id === story.contract_id;
    }
    return contract.story_id === scope.storyId;
  }
  if (scope.phase) {
    return contract.phase === scope.phase && !contract.story_id;
  }
  if (isIntactBootstrapPhaseContract(context, contract)) {
    return false;
  }
  if (contract.story_id && !contractIsActiveStoryContract(context, contract)) {
    return false;
  }
  return true;
}

export function formatHumanApprovalRequest(request, index = null) {
  const prefix = index === null ? "-" : `${index}.`;
  const plain = plainApprovalRequestCopy(request);
  const reviewItems = userVisibleReviewItems(request);
  const reviewLimit = request.type === "baseline_approval" ? 10 : 8;
  const lines = [
    `${prefix} ${plain.title}`,
    plain.explanation ? `   In plain language: ${plain.explanation}` : null,
    request.why_needed ? `   Why it matters: ${request.why_needed}` : null,
    reviewItems.length ? "   What is inside this item:" : null,
    ...reviewItems.slice(0, reviewLimit).map((item) => `   - ${item}`),
    request.delivery_format_options?.length ? "   How I can present the result:" : null,
    ...(request.delivery_format_options || []).slice(0, 10).map((option) => `   - ${formatDeliveryFormatOption(option)}`),
    request.recommended_delivery_format ? `   Suggested presentation: ${request.recommended_delivery_format}` : null,
    request.delivery_question ? `   Presentation question: ${request.delivery_question}` : null,
    request.approval_meaning ? `   If you say yes: ${request.approval_meaning}` : null,
    `   Scope of your answer: it applies only to ${plain.title}. It does not approve later format, tool, brief, or start decisions unless I show them or you already gave a broader scope.`,
    request.approve_if ? `   Say yes if: ${request.approve_if}` : null,
    request.change_if ? `   Ask for changes if: ${request.change_if}` : null,
    request.after_approval ? `   After that: ${request.after_approval}` : null,
    request.user_prompt ? "   What I need from you: approve this item, ask me to change it, or provide missing information." : null,
    request.user_prompt ? `   Decision needed: ${request.user_prompt}` : null,
    request.approval_phrase ? `   Example answer: "${plain.example || request.approval_phrase}"` : null,
    "",
  ];
  return lines.filter((line) => line !== null && line !== undefined);
}

export function plainApprovalRequestCopy(request) {
  switch (request.type) {
    case "baseline_approval":
      return {
        title: `Project context (${request.subject_id})`,
        explanation: "I inferred facts about the project. Confirming them lets me use those facts as trusted context instead of guessing.",
        example: `Use project context ${request.subject_id}.`,
      };
    case "output_template_approval":
      return {
        title: `Output format (${request.subject_id})`,
        explanation: "This is the structure of the result I will create: sections, level of detail, and presentation style.",
        example: `The output format ${request.subject_id} is OK.`,
      };
    case "capability_profile_approval":
      return {
        title: `Project evidence and boundaries (${request.subject_id})`,
        explanation: "This defines which project evidence, local checks, and tool boundaries I may use. It is not approval of the implementation result, other final content, or work brief.",
        example: "Use this evidence and boundary set.",
      };
    case "capability_recommendation_approval":
      return {
        title: `Allowed tools for this work (${request.subject_id})`,
        explanation: "This is the concrete list of skills, tools, connectors, permissions, and installs I would be allowed to use.",
        example: "Use these tool choices.",
      };
    case "contract_clarification":
      return {
        title: `Missing work context (${request.subject_id})`,
        explanation: "I need to know which files, facts, constraints, or decisions should guide the work before I start.",
        example: "Use the listed files as context and include current architecture, risks, and recommendations.",
      };
    case "contract_approval":
      return {
        title: `Work brief (${request.subject_id})`,
        explanation: "This confirms what I am allowed to do and what output I should produce. It is not approval of the final result.",
        example: `Use work brief ${request.subject_id}.`,
      };
    case "output_link_required":
      return {
        title: `Official output file (${request.artifact_type || request.subject_id})`,
        explanation: "I need to know which generated file should be treated as the official result for later checks.",
      };
    default:
      return {
        title: request.title || request.summary,
        explanation: null,
      };
  }
}

export function contractProposalPrimarySummary(contract, options) {
  const italian = humanGuidanceLocale(options) === "it";
  const request = {
    id: contract.id,
    subject_id: contract.id,
    story_id: contract.story_id,
    artifact_type: (contract.output_contract_refs || []).map((ref) => ref.artifact_type),
  };
  const overview = [contract.contextualization?.summary, contract.purpose]
    .map((item) => safePrimaryGuidanceText(item, request))
    .find(Boolean);
  const expectedResults = (contract.outputs || [])
    .map((item) => safePrimaryGuidanceText(humanOutputLabel(item), request))
    .filter(Boolean)
    .slice(0, 4);
  const checks = (contract.validation || [])
    .map((item) => safePrimaryGuidanceText(item, request))
    .filter(Boolean)
    .slice(0, 2);
  return [
    overview ? `${italian ? "Lavoro proposto" : "Proposed work"}: ${overview}` : null,
    expectedResults.length
      ? `${italian ? "Risultati attesi" : "Expected results"}: ${expectedResults.join("; ")}`
      : null,
    checks.length
      ? `${italian ? "Come verrà controllato" : "How it will be checked"}: ${checks.join("; ")}`
      : null,
  ].filter(Boolean);
}

export function buildApprovalEvidence(context, options = {}) {
  return normalizeListOption(options["approval-evidence"]).map((rawPath) => {
    const evidencePath = resolveProjectFilePath(context, rawPath, { mustExist: true, fileOnly: true });
    assertNotDerivedArtifact(context, evidencePath, "Approval evidence");
    return {
      path: toProjectPath(context, evidencePath),
      sha256: hashFile(evidencePath),
    };
  });
}

export function buildApprovalRecord(context, options, attribution, settings = {}) {
  if (settings.standing) {
    return buildStandingDerivedApproval(context, attribution, settings.standing, settings);
  }
  if (options["standing-approval"] !== undefined) {
    fail(`${settings.label || "This approval"} cannot be derived from a standing approval.`);
  }
  const status = normalizeApprovalStatus(settings.status || options.status || "approved");
  const evidence = buildApprovalEvidence(context, options);
  const summary = getOptionString(options, "summary") || null;
  const source = normalizeApprovalSource(context, options, attribution, settings.label || "approval", status);
  validateApprovalSourceForActor(context, {
    source,
    status,
    summary,
    evidence,
    actor: attribution.actor,
    label: settings.label || "approval",
  });
  const authorization = source === "automation"
    ? requireAutomationAuthorization(context, options, attribution.action, settings)
    : null;
  const scope = buildApprovalRecordScope(source, { ...settings, authorization });
  const approvedContentHash = status === "approved" ? hashApprovalSubject(settings.subject) : null;
  return {
    id: `APR-${compactTimestamp()}-${crypto.randomBytes(3).toString("hex")}`,
    ...(settings.subject_id_field && settings.subject_id ? { [settings.subject_id_field]: settings.subject_id } : {}),
    status,
    summary,
    scope,
    evidence,
    approval_source: source,
    authorization_ref: authorization?.id || null,
    authorization_use_ref: authorization?.__use_receipt?.path || null,
    authorization_action: authorization ? attribution.action : null,
    explicit_user_confirmation: source === "explicit-user",
    provisional: source === "bootstrap",
    approved_content_hash: approvedContentHash,
    hash_algorithm: approvedContentHash ? "sha256:stable-json:v1" : null,
    approved_by: attribution.actor,
    git: attribution.git,
    run: attribution.run,
    created_at: now(),
  };
}

export function validateFormalApprovalRecord(context, report, approval, label, actor, settings = {}) {
  if (!approval || approval.status !== "approved") {
    return;
  }
  const policy = getApprovalPolicy(context);
  const source = approval.approval_source || null;
  if (source === STANDING_APPROVAL_SOURCE) {
    if (!["agent", "system", "ci", "human"].includes(actor?.type)) {
      report.errors.push(`${label} derived from a standing approval has no recorded actor`);
    }
    for (const error of standingDerivedApprovalRecordErrors(context, approval, settings)) {
      report.errors.push(`${label} derived from a standing approval is invalid: ${error}`);
    }
    return;
  }
  if (report.strict && policy.formal_approval_requires_explicit_source && !source) {
    const severity = policy.legacy_approval_behavior === "warn" ? "warnings" : "errors";
    report[severity].push(`${label} is a legacy approval without approval_source; re-approve with explicit-user, ci, automation, or bootstrap source`);
  }
  if (source && (!APPROVAL_SOURCES.has(source) || !policy.accepted_sources.includes(source))) {
    report.errors.push(`${label} has invalid approval_source '${source}'`);
  }
  if (report.strict && source === "bootstrap" && !policy.allow_bootstrap_approvals_in_strict_gate) {
    report.errors.push(`${label} is bootstrap/provisional and cannot satisfy strict gate; re-approve with explicit-user or ci`);
  }
  if (source === "explicit-user" && actor?.type !== "human") {
    report.errors.push(`${label} approval_source explicit-user requires a human approver`);
  }
  if (source === "ci" && actor?.type !== "ci") {
    report.errors.push(`${label} approval_source ci requires a CI approver`);
  }
  if (source === "automation" && !["agent", "system", "ci"].includes(actor?.type)) {
    report.errors.push(`${label} approval_source automation requires an agent, system, or CI approver`);
  }
  if (source === "automation" && report.strict) {
    const authorizationSettings = approvalAuthorizationSettings(approval, settings);
    const scopedAuthorizationId = authorizationSettings.scope.authorization_ref || null;
    const authorizationId = approval.authorization_ref || scopedAuthorizationId || null;
    if (!authorizationId) {
      report.errors.push(`${label} automation approval has no persistent authorization_ref`);
    } else {
      const authorization = readAuthorization(context, authorizationId, { missingOk: true });
      const action = approval.authorization_action || null;
      if (approval.authorization_ref && scopedAuthorizationId && approval.authorization_ref !== scopedAuthorizationId) {
        report.errors.push(`${label} authorization_ref does not match its approved scope authorization ${scopedAuthorizationId}`);
      }
      if (!authorization) {
        report.errors.push(`${label} references missing authorization ${authorizationId}`);
      } else {
        if (!action) {
          report.errors.push(`${label} is missing an authorized action`);
        } else if (approval.authorization_use_ref) {
          const useReceipt = readAuthorizationUseReceipt(context, approval.authorization_use_ref, { missingOk: true });
          if (!useReceipt) {
            report.errors.push(`${label} references missing authorization use receipt ${approval.authorization_use_ref}`);
          } else {
            for (const error of validateAuthorizationUseReceipt(useReceipt, {
              authorization_id: authorizationId,
              action,
              subject_id: authorizationSettings.subject_id,
              proposal_ref: authorizationSettings.proposal_ref,
              subject_hash: authorizationSettings.subject_hash,
              artifact_types: authorizationSettings.artifact_types,
              approval_boundaries: authorizationSettings.approval_boundaries,
            })) {
              report.errors.push(`${label}: ${error}`);
            }
            if (useReceipt.authorization_hash !== authorizationRecordHash(authorization)) {
              report.errors.push(`${label} authorization use receipt does not match the granted content hash`);
            }
            if (!authorizationAllowsAction(authorization, action)) {
              report.errors.push(`${label}: Authorization ${authorization.id} does not allow action ${action}.`);
            }
            if (!authorizationAllowsSubject(authorization, authorizationSettings.subject_id)) {
              report.errors.push(`${label}: Authorization ${authorization.id} does not allow subject ${authorizationSettings.subject_id}.`);
            }
            for (const artifactType of authorizationSettings.artifact_types) {
              if (!authorizationAllowsArtifactType(authorization, artifactType)) {
                report.errors.push(`${label}: Authorization ${authorization.id} does not allow artifact type ${artifactType}.`);
              }
            }
          }
        } else {
          for (const error of authorizationUseErrors(authorization, action, authorizationSettings)) {
            report.errors.push(`${label}: ${error}`);
          }
          report.warnings.push(`${label} is a legacy automation approval without immutable authorization_use_ref`);
        }
        if (
          authorizationSettings.scope.approval_level &&
          authorizationSettings.scope.approval_level !== authorization.scope
        ) {
          report.errors.push(`${label} approval level does not match authorization ${authorizationId} scope`);
        }
      }
    }
  }
  if (
    report.strict &&
    source === "explicit-user" &&
    policy.require_summary_or_evidence_for_explicit_user &&
    !approval.summary &&
    !approval.approval_summary &&
    (!Array.isArray(approval.evidence || approval.approval_evidence) || (approval.evidence || approval.approval_evidence).length === 0)
  ) {
    report.errors.push(`${label} explicit-user approval requires summary or evidence`);
  }
  if (
    report.strict &&
    source === "automation" &&
    policy.require_summary_or_evidence_for_automation &&
    !approval.summary &&
    !approval.approval_summary &&
    (!Array.isArray(approval.evidence || approval.approval_evidence) || (approval.evidence || approval.approval_evidence).length === 0)
  ) {
    report.errors.push(`${label} automation approval requires summary or evidence describing the delegated approval level and scope`);
  }
}

export function buildTraceAuthorityMetadata(context, options = {}, attribution = null) {
  const activeAttribution = attribution || buildAttribution(context, options, "trace.attribution");
  const requestedBy = buildActorFromPrefixedOptions(options, "requested-by", context.root, {
    type: "human",
    source: "cli",
  });
  const authorizedBy = buildActorFromPrefixedOptions(options, "authorized-by", context.root, {
    type: "human",
    source: "cli",
  });
  const request = buildTraceRequestMetadata(options, activeAttribution);
  return {
    ...(requestedBy ? { requested_by: requestedBy } : {}),
    ...(authorizedBy ? { authorized_by: authorizedBy } : {}),
    ...(request ? { request } : {}),
  };
}

export function readDependencyProposals(context) {
  return safeReadDir(dependenciesRoot(context))
    .filter((name) => name.endsWith(".json") && name !== "graph.json")
    .map((name) => readProjectJson(context, path.join(dependenciesRoot(context), name)))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

export function collectApprovalQueryRecords(context, session = null) {
  return collectApprovalManifestEntries(context, session).map((approval) => ({
    kind: "approvals",
    id: approval.approval_id || `${approval.subject_id}:approval`,
    summary: `${approval.subject_id} approval ${approval.status || "unknown"}`,
    created_at: approval.created_at || null,
    updated_at: approval.created_at || null,
    actor: approval.actor || null,
    requested_by: null,
    authorized_by: null,
    request: null,
    action: "approve",
    event_type: "gate",
    story_id: null,
    artifact_type: null,
    requirements: [],
    phase: null,
    status: approval.status || null,
    text: stableJson(approval),
    sources: [{ path: approval.subject_path, line: 1 }],
    raw: approval,
  }));
}

export function collectApprovalManifestEntries(context, session = null) {
  const entries = [];
  for (const filePath of collectManifestSourceFiles(context, session).filter((candidate) => candidate.endsWith(".json"))) {
    let data;
    try {
      data = session ? session.readJson(toProjectPath(context, filePath)) : readProjectJson(context, filePath);
    } catch {
      continue;
    }
    const relativePath = toProjectPath(context, filePath);
    for (const approval of data.approvals || []) {
      entries.push({
        subject_id: data.id || data.project_id || path.basename(filePath, ".json"),
        subject_path: relativePath,
        approval_id: approval.id || null,
        status: approval.status || null,
        approval_source: approval.approval_source || null,
        actor: approval.approved_by || approval.actor || null,
        created_at: approval.created_at || approval.approved_at || null,
      });
    }
    if (data.approval_source || data.approved_by || data.approved_at) {
      entries.push({
        subject_id: data.id || path.basename(filePath, ".json"),
        subject_path: relativePath,
        approval_id: data.id || null,
        status: data.status || null,
        approval_source: data.approval_source || null,
        actor: data.approved_by || data.audit?.decided_by || null,
        created_at: data.approved_at || data.created_at || null,
      });
    }
  }
  return entries.sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
}

export function readArtifactGeneratorReceipt(context, receiptFile, artifactPath, delivery) {
  const required = context.config.verification_policy?.require_generator_receipt !== false;
  if (!receiptFile) {
    if (required) {
      fail(`${delivery.label} requires --receipt-file <artifact-generator-receipt.json> proving which capability generated this exact artifact.`);
    }
    return null;
  }
  const filePath = resolveProjectFilePath(context, receiptFile, { mustExist: true, fileOnly: true });
  assertNotDerivedArtifact(context, filePath, "Artifact generator receipt");
  const receipt = readProjectJson(context, filePath);
  assertRecordSchema(receipt, "artifact-generator-receipt.schema.json", `Generator receipt ${toProjectPath(context, filePath)}`);
  const { receipt_hash: receiptHash, hash_algorithm: _algorithm, ...hashSubject } = receipt;
  if (receiptHash !== shortHashFull(stableJson(hashSubject))) {
    fail(`Generator receipt ${toProjectPath(context, filePath)} failed its immutable content hash check.`);
  }
  const generatorName = typeof receipt.generator === "string" ? receipt.generator : receipt.generator?.name;
  if (generatorName !== delivery.generator) {
    fail(`Generator receipt names '${generatorName || "unknown"}', but approved delivery requires '${delivery.generator}'.`);
  }
  if (receipt.artifact_sha256 !== hashFile(artifactPath)) {
    fail(`Generator receipt is not bound to the current ${path.basename(artifactPath)} hash.`);
  }
  if (receipt.artifact_path && receipt.artifact_path !== toProjectPath(context, artifactPath)) {
    fail(`Generator receipt artifact_path '${receipt.artifact_path}' does not match '${toProjectPath(context, artifactPath)}'.`);
  }
  return {
    id: receipt.id,
    path: toProjectPath(context, filePath),
    hash: receipt.receipt_hash,
  };
}

export function validateAuthorizations(context, report) {
  for (const authorization of collectJsonFiles(context, authorizationRoot(context))) {
    const label = `authorization ${authorization.id || "unknown"}`;
    if (isCanonicalContentAuthorization(authorization)) {
      // collectJsonFiles annotates each record with __path/__relative_path for
      // reporting; strip them before recomputing the canonical content hash, or
      // every canonical authorization would fail integrity validation here.
      const { __path, __relative_path, ...authorizationSnapshot } = authorization;
      const integrity = validateAuthorizationSnapshotIntegrity(authorizationSnapshot);
      if (!integrity.valid) {
        report.errors.push(`${label} failed canonical integrity validation: ${integrity.errors.join("; ")}`);
      }
      if (!["explicit-user", "ci"].includes(authorization.approval_source)) {
        report.errors.push(`${label} must be granted by explicit-user or ci approval`);
      }
      if (authorization.approval_source === "explicit-user" && authorization.granted_by?.type !== "human") {
        report.errors.push(`${label} explicit-user grant requires a human actor`);
      }
      if (authorization.approval_source === "ci" && authorization.granted_by?.type !== "ci") {
        report.errors.push(`${label} CI grant requires a CI actor`);
      }
      const lifecyclePath = authorizationLifecyclePath(context, authorization.id);
      if (fs.existsSync(lifecyclePath)) {
        const lifecycle = readProjectJson(context, lifecyclePath);
        const lifecycleIntegrity = validateAuthorizationRevocationIntegrity(lifecycle);
        if (!lifecycleIntegrity.valid) {
          report.errors.push(`${label} lifecycle receipt failed integrity validation: ${lifecycleIntegrity.errors.join("; ")}`);
        }
        if (lifecycle.authorization_id !== authorization.id || lifecycle.authorization_hash !== authorization.authorization_hash) {
          report.errors.push(`${label} lifecycle receipt is not bound to the immutable authorization snapshot`);
        }
      } else if (authorization.expires_at && Date.parse(authorization.expires_at) <= Date.now()) {
        report.warnings.push(`${label} expired at ${authorization.expires_at}`);
      }
      report.checked.push(label);
      continue;
    }
    for (const field of ["id", "status", "scope", "summary", "allowed_actions", "approval_source", "granted_by", "approved_content_hash"]) {
      if (authorization[field] === undefined || authorization[field] === null || authorization[field] === "") {
        report.errors.push(`${label} is missing ${field}`);
      }
    }
    if (!Array.isArray(authorization.allowed_actions) || authorization.allowed_actions.length === 0) {
      report.errors.push(`${label} must allow at least one explicit action`);
    }
    if (!Array.isArray(authorization.allowed_subjects)) {
      report.errors.push(`${label} allowed_subjects must be an array`);
    }
    if (!Array.isArray(authorization.allowed_artifact_types)) {
      report.errors.push(`${label} allowed_artifact_types must be an array`);
    }
    if (
      authorization.allowed_approval_boundaries !== undefined &&
      !Array.isArray(authorization.allowed_approval_boundaries)
    ) {
      report.errors.push(`${label} allowed_approval_boundaries must be an array`);
    }
    if (!['explicit-user', 'ci'].includes(authorization.approval_source)) {
      report.errors.push(`${label} must be granted by explicit-user or ci approval`);
    }
    if (authorization.approval_source === "explicit-user" && authorization.granted_by?.type !== "human") {
      report.errors.push(`${label} explicit-user grant requires a human actor`);
    }
    if (authorization.approval_source === "ci" && authorization.granted_by?.type !== "ci") {
      report.errors.push(`${label} CI grant requires a CI actor`);
    }
    if (authorization.approved_content_hash && authorization.approved_content_hash !== hashAuthorizationRecord(authorization)) {
      report.errors.push(`${label} changed after grant`);
    }
    if (authorization.status === "active" && authorization.expires_at && Date.parse(authorization.expires_at) <= Date.now()) {
      report.warnings.push(`${label} expired at ${authorization.expires_at}`);
    }
    report.checked.push(label);
  }
}

export function validateDependencyProposals(context, report, storyId = null) {
  for (const proposal of readDependencyProposals(context)) {
    const relevant = !storyId || (proposal.edges || []).some((edge) => edge.from === storyId || edge.to === storyId);
    if (!relevant) {
      continue;
    }
    const label = `dependency proposal ${proposal.id || "unknown"}`;
    if (!proposal.id || !proposal.status || !Array.isArray(proposal.edges)) {
      report.errors.push(`${label} is missing id, status, or edges`);
    }
    if (proposal.status === "approved") {
      const approval = latestApprovedRecordApproval(proposal);
      if (!approval || !hasFormalApprovalAttribution(approval.approved_by, approval.approval_source)) {
        report.errors.push(`${label} approval must be attributed to ${formalApprovalActorDescription(approval?.approval_source)}`);
      }
      validateFormalApprovalRecord(context, report, approval, `${label} approval ${approval?.id || "unknown"}`, approval?.approved_by);
      if (!isApprovedRecordFresh(proposal)) {
        report.errors.push(`${label} approval is stale`);
      }
    }
    report.checked.push(label);
  }
}

export function validateContractApprovals(context, report, contract, label) {
  for (const approval of contract.approvals || []) {
    const approvalLabel = `${label} approval ${approval.id || "unknown"}`;
    if (approval.status === "approved") {
      const actor = approval.approved_by;
      if (!hasFormalApprovalAttribution(actor, approval.approval_source)) {
        report.errors.push(`${approvalLabel} is missing ${formalApprovalActorDescription(approval.approval_source)} approval attribution`);
      }
      validateFormalApprovalRecord(context, report, approval, approvalLabel, actor, {
        subject_id: contract.id,
        artifact_types: contractArtifactTypes(contract),
        approval_boundaries: contractDirectApprovalRequirements(contract),
      });
      for (const evidence of approval.evidence || []) {
        const evidencePath = resolveProjectFilePath(context, evidence.path || evidence, { mustExist: false });
        if (!fs.existsSync(evidencePath)) {
          report.errors.push(`${approvalLabel} references missing approval evidence ${evidence.path || evidence}`);
        } else if (isDerivedArtifactPath(context, evidencePath)) {
          report.errors.push(`${approvalLabel} uses derived cache/index evidence ${evidence.path || evidence}`);
        } else if (evidence.sha256 && evidence.sha256 !== hashFile(evidencePath)) {
          report.errors.push(`${approvalLabel} approval evidence changed after approval: ${evidence.path || evidence}`);
        }
      }
    }
  }
}
