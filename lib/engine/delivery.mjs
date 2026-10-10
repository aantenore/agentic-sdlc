import path from "node:path";
import { hostLabel } from "../messaging/commands.mjs";
import { deliveryProfileHashMatches, deliveryProfileRevisionHistory } from "../delivery-profile-revisions.mjs";
import { findEvidenceSupersede } from "./evidence-supersede-records.mjs";
import { recordProjectPluginRequirement } from "./plugin-compatibility.mjs";
import {
  validateAssessmentWorkflowIntegrity,
  validateProposalIntegrity,
} from "../assessment-workflow.mjs";
import {
  computeAuthorizationSubjectHash,
  validateAuthorizationRevocationIntegrity,
  validateAuthorizationSnapshotIntegrity,
  validateAuthorizationUsageReceipt as validateCanonicalAuthorizationUsageReceipt,
  validateHostApprovalReceiptAtUse,
} from "../authorization-receipts.mjs";
import {
  AUTONOMY_LEVELS,
  deliveryProfileEffectiveLevel,
  evaluateAutonomyPolicy,
  validateAutonomyDecisionIntegrity,
  validateDeliveryExecutionProfileIntegrity,
} from "../autonomy-policy.mjs";
import {
  inspectBuildIdentity,
} from "../build-identity.mjs";
import {
  computeStableHash,
} from "../canonical.mjs";
import {
  UserError,
  fail,
} from "../cli/user-error.mjs";
import {
  validateContextOptimizationLineage,
  validateContextOptimizationObservation,
} from "../context-optimization.mjs";
import {
  createDefaultDeliveryProviderRegistry,
} from "../delivery/default-providers.mjs";
import {
  providerBindingForAction,
} from "../delivery/provider-compatibility.mjs";
import {
  DeliveryProviderError,
  assertProviderOperationReceiptIntegrity,
} from "../delivery/provider-registry.mjs";
import {
  deliveryProviderOperationSubjectsMatch,
} from "../delivery/provider-subject-compatibility.mjs";
import {
  completionBudgetStatus,
  validateExecutionBudgetIntegrity,
  validateExecutionUsageReceipt,
} from "../execution-budget.mjs";
import {
  actionCheckpointGuidance,
  deliveryAutonomyStatusGuidance,
} from "../human-guidance.mjs";
import {
  approvalAuthorizationSettings,
  assessmentApprovalPath,
  assessmentProposalPath,
  authorizationLifecyclePath,
  authorizationPath,
  authorizationRecordHash,
  authorizationUsePath,
  authorizationUsesRoot,
  autonomyLifecycleReceiptHash,
  canonicalAuthorizationUseSubject,
  hashApprovalSubject,
  latestApprovedRecordApproval,
  latestContractApproval,
  localTargetBuildReceiptRef,
  parsePullRequestUrlIdentity,
  remoteAuthorizationProjection,
  requireFormalApprovalActor,
  validateApprovalSourceForActor,
  validateAuthorizationUseReceipt,
  verificationReceiptPath,
  verificationReceiptSatisfies,
} from "../lifecycle/authorization.mjs";
import {
  capabilityRecommendationPath,
} from "../lifecycle/capability.mjs";
import {
  activeLegacyLocalStartError,
  buildDomainRecord,
  completionReserveRisks,
  getOptionString,
  hashBoundRecordIsValid,
  hashBuffer,
  localTargetBuildCompletionDetails,
  localTargetPredecessorStateMatches,
  matchesAny,
  normalizeId,
  normalizeListOption,
  normalizeListValue,
  normalizeRawListOption,
  pushAllUnique,
  requireCoordinationOverrideActor,
  requireOption,
  shortHash,
  shortHashFull,
  stableJson,
} from "../lifecycle/common.mjs";
import {
  DELIVERY_PROVIDER_ACTIONS,
  DELIVERY_TERMINAL_STATUSES,
  GOVERNED_LOCAL_TARGET_ACTIONS,
  OUTPUT_DELIVERY_MODES,
  OUTPUT_FORMATS,
  OUTPUT_FORMAT_ALIASES,
  OUTPUT_VISUAL_FORMATS,
} from "../lifecycle/constants.mjs";
import {
  assertDeliveryProviderAuthorization,
  buildDeliveryActionCompletionTraceEvent,
  buildDeliveryCheckpointPolicySource,
  buildDeliveryCompletionRequest,
  buildTerminalDeliveryCloseTraceEvent,
  compareDeliveryAuthorizationOrder,
  contractDeliveryDescriptor,
  expandCommitScopeOptions,
  dedupeDeliveryFormatOptions,
  deliveryActionApprovalRecoveryProjection,
  deliveryActionAttemptPath,
  deliveryActionAttemptReceiptRef,
  deliveryActionAttemptsRoot,
  deliveryActionAuthorizationIntentIdentity,
  deliveryActionCheckpointPolicySnapshot,
  deliveryActionEvidenceRevision,
  deliveryActionIntentUseReceiptId,
  deliveryActionReceiptRef,
  deliveryAutonomyPath,
  deliveryAutonomyRoot,
  deliveryProfileRevisionPath,
  deliveryBoundaryCheckpointActions,
  deliveryBudgetBoundary,
  deliveryCheckpointPolicySourcesRoot,
  deliveryCloseReceiptPath,
  deliveryEnvironmentBoundary,
  deliveryExecutionProfileSchemaName,
  deliveryMaterialScope,
  deliveryMergeAuthorization,
  deliveryProviderOperationSubject,
  deliveryStartReceiptPath,
  deliveryStartReceiptRef,
  deliveryTargetAllowedActions,
  governedLocalSmokeCwd,
  localDeliveryRuntimeBoundaryChanged,
  localReleaseArtifactManifestPolicy,
  localReleaseAttemptId,
  localReleaseAttemptReceiptErrors,
  localReleaseBoundaryCheckpointFromSource,
  localReleaseTargetEntryPaths,
  localReleaseTargetHadAbsentEntries,
  localReleaseTargetHadOnlyDirectories,
  localReleaseTargetStructureMatches,
  localTargetBuildContentManifest,
  localSmokeExecutableBase,
  localSmokeInterpreterOptionValueKind,
  normalizeDeliveryAction,
  normalizeGitRepositoryIdentity,
  normalizeSmokeTestCommand,
  pullRequestReadyForReviewCompletion,
  releaseGateReceiptPath,
  releaseManifestPath,
  releasePhaseName,
  resolveDeliveryProviderBinding,
  terminalStatusForDeliveryAction,
  validateDeliveryCheckpointPolicySource,
  validateDeliveryCompletionRequest,
  validateLocalSmokePackageManagerForm,
  validateResolvedLocalSmokeExecutable,
  withProviderCompatibilityProjection,
} from "../lifecycle/delivery.mjs";
import {
  humanGuidanceLines,
  humanGuidanceLocale,
  normalizeClaimStatus,
} from "../lifecycle/guidance.mjs";
import {
  autonomyVerificationTechnicalLines,
  verificationArtifactSha256,
} from "../lifecycle/output.mjs";
import {
  assertNoSymlinkPathSegments,
  assessmentApplicationPath,
  assessmentAuthorizedUseDefinitions,
  assessmentBudgetSnapshotPath,
  assessmentBudgetsRoot,
  assessmentUsageRoot,
  autonomyActionsRoot,
  autonomyDecisionSemanticProjection,
  autonomyExecutionsRoot,
  autonomyRevocationsRoot,
  completionRequestExecutionProjection,
  contextOptimizationObservationsRoot,
  isInsidePath,
  normalizeProjectPathInput,
  pathMatchesApprovedWriteScope,
  readContextOptimizationPolicy,
  recordedPathInside,
  toProjectPath,
} from "../lifecycle/project.mjs";
import {
  configuredPhaseOrder,
  contractExecutionContext,
  latestTraceEvent,
  requirementMaterialScope,
  requirementPath,
  storyLifecycleCertificationLockPath,
} from "../lifecycle/story.mjs";
import {
  assessmentWorkflowPath,
  gateEvidenceArchivePath,
  workflowExecutionStartedAt,
  workflowFinalLocalReleasePathSuperseded,
  workflowTraceIntentMatches,
} from "../lifecycle/workflow.mjs";
import {
  requirementContentHash,
} from "../requirement-lifecycle.mjs";
import {
  Date,
  childProcess,
  fs,
  os,
  process,
} from "../runtime/host.mjs";
import {
  PLUGIN_ROOT,
} from "../runtime/paths.mjs";
import {
  validateVerificationReceiptIntegrity,
} from "../verification-levels.mjs";
import {
  assessmentBudgetLineage,
  evaluateAssessmentBudgetUsage,
  hardLimitMeteringCoverage,
  readAssessmentApplication,
  readAssessmentApproval,
  readAssessmentProposal,
  readAssessmentUsageReceipts,
  validateAssessmentAuthorizationScope,
  validateStoredAssessmentApprovalAuthority,
} from "./assessment.mjs";
import {
  buildApprovalRecord,
  dataOperationReceiptErrors,
  loadAutonomyAuthorityAssurance,
  localTargetBuildAuthorizationErrors,
  localTargetBuildAuthorizationPrecondition,
  localTargetBuildReceiptErrors,
  proposalAuthorizationUseErrors,
  proposalMaterializationSemanticErrors,
  readAuthorization,
  requireAutomationAuthorization,
  validateApprovalEvidenceIntegrity,
  validateAutonomyApprovalRef,
  validateFormalApprovalRecord,
} from "./authorization.mjs";
import {
  currentBaselineRefreshSuggestion,
} from "./baseline-refresh.mjs";
import {
  validateApprovedCapabilityRecommendationForUse,
} from "./capability.mjs";
import {
  codeReviewStatus,
  codeReviewStatusLines,
} from "./code-review-requirement.mjs";
import {
  assertMergeNotManual,
  automaticMergeChosen,
  mergeDecisionSentence,
} from "./merge-decision.mjs";
import {
  assertRecordSchema,
  buildAttribution,
  completedLocalTargetBuildDetails,
  enforceMergeCodeReview,
  latestPassingDataOperation,
  localTargetMaterializationRefErrors,
  nearestExistingParent,
  now,
  passingDataOperationCandidates,
  presentUnderPrivacyRules,
  uniqueRecordSuffix,
  validatePullRequestMergeRuntimeTransition,
  validateRecordSchema,
} from "./common.mjs";
import {
  CLI_OPERATION_CONTEXT,
} from "./definitions.mjs";
import {
  buildDeliveryChecks,
} from "./delivery-checks.mjs";
import {
  mergeFromBaseEvidence,
} from "./merge-from-base.mjs";
import {
  assertGitCommitReceiptCoverage,
  buildCompletedGitCommitDetails,
  execGit,
  execGitOutput,
  gitCommandSucceeds,
  gitCommitReceiptCoverageErrors,
  reviewedPullRequestHeadSha,
  validateCompletedGitCommitReceipt,
  validateCompletedRemoteActionReceipt,
  validateGitCommitCoverageProof,
  validatePullRequestGitBoundary,
  verifyLegacyCompletedGitHubMerge,
  verifyLegacyCompletedGitPush,
} from "./git.mjs";
import {
  cachedGitObjectAnswer,
} from "./git-object-cache.mjs";
import {
  readSnapshotValue,
} from "./read-snapshot.mjs";
import {
  assertDataMigrationPreviewEvidenceCurrent,
  dataMigrationPreviewEvidenceErrors,
  deliveryConcreteIdentity,
  ensureInitialized,
  workflowFinalFreshnessLocalRootIdentity,
} from "./migration.mjs";
import {
  observeDeliveryProviderPrecondition,
} from "./observatory.mjs";
import {
  deliveryMergeCommit,
} from "./story-branch-commits.mjs";
import {
  missingStoryRecords,
  storyBranchRecordPath,
} from "../story-records.mjs";
import {
  orchestrationPolicy,
} from "../story-claim-shared-state.mjs";
import {
  buildActionEvidence,
  humanOutputLabel,
  normalizeOutputExtension,
  output,
  readOutputRegistry,
} from "./output.mjs";
import {
  pathEntryExistsNoFollow,
  plannedRealPath,
  pullRequestChangedPaths,
  readAutonomyProfileRevocation,
  resolveExecutableFromPath,
  resolveProjectFilePath,
} from "./project.mjs";
import {
  acquireFileLock,
  approveDeliveryAutonomyLocked,
  assertWorkflowStoredTraceIntegrityLocked,
  ensureDir,
  governedLocalSmokePayloadBinding,
  hashFile,
  prepareGovernedTraceEvent,
  prepareGovernedTraceMutation,
  proposeDeliveryAutonomyLocked,
  readProjectJson,
  readProjectSafe,
  readStableRegularFileBuffer,
  requireGovernedLocalReleaseTarget,
  revokeDeliveryAutonomyLocked,
  safeReadDir,
  sealPreparedTraceEventLocked,
  stableLocalSmokeExecutableSnapshot,
  workflowTraceIntegritySnapshotLocked,
  writeJsonFile,
  writeTextFile,
} from "./storage.mjs";
import {
  claimMadeOnThisComputer,
  ownsSharedClaim,
  releaseOrphanSharedClaim,
  requireSharedClaimPersonDecision,
  releaseSharedReservation,
  shareStoryClaimRelease,
  sharedReleaseLine,
  sharedReleaseStatus,
  storyClaimPolicy,
} from "./story-claim-shared.mjs";
import {
  gitCommitReceiptShas,
} from "./delivery-commits.mjs";
import {
  enforceDeliveredOverlapReview,
} from "./story-overlap.mjs";
import {
  foreignStoryBranchCommitMessage,
  foreignStoryBranchCommits,
} from "./story-branch-commits.mjs";
import {
  deliveryMetrics,
  describeDeliveryMetrics,
  readableDeliveryActionReceipts,
} from "./delivery-metering.mjs";
import {
  STANDING_APPROVAL_SOURCE,
  STANDING_RECEIPT_AUTHORITY_SOURCE,
  evaluateStandingStepCoverage,
  holdStandingApprovalLock,
  requireStandingActor,
  standingApprovalRefForProfile,
  standingAuthorityAssurance,
  standingFallbackMessage,
  standingReceiptAuthorityErrors,
  traceStandingApprovalEvent,
} from "./standing.mjs";
import {
  appendTraceEvent,
  assertRequirementReadyForDownstream,
  assertStoryOpenForWork,
  collectContractDependencyFreshnessGaps,
  readContractById,
  readRequirementAutonomyProfile,
  readStory,
  readStoryStepRecords,
  readTraceEvents,
  requirementByAutonomyProfileId,
} from "./story.mjs";
import {
  readExternalMergeReceipt,
} from "./external-merge.mjs";
import {
  assertNoPendingWorkflowTraceTransaction,
  ensureWorkflowDirectoryDurably,
  readWorkflowCheckpoint,
  syncWorkflowFile,
  workflowFinalFreshnessLocalPathSnapshot,
} from "./workflow.mjs";
import {
  fileURLToPath,
} from "node:url";

export function applyDeliveryAutonomyToTaskStart(context, result, contract, options) {
  const policy = context.config.autonomy_policy || {};
  if (policy.enabled === false || policy.mode === "off") {
    result.autonomy = { mode: "off", effective_level: "supervised" };
    return true;
  }
  const v2Bound = Array.isArray(contract.requirement_execution_profile_refs)
    && contract.requirement_execution_profile_refs.length > 0;
  if (!v2Bound) {
    if (policy.mode === "enforce_all") {
      result.status = "needs_user_input";
      result.execution_allowed = false;
      result.contract_action = "migrate_requirement_autonomy";
      pushAllUnique(result.blocking_reasons, ["legacy_autonomy_migration_required"]);
      pushAllUnique(result.questions, [
        "This project enforces per-delivery autonomy for all work. Create and approve requirement:v2, then bind a new exact delivery profile.",
      ]);
      return false;
    }
    result.autonomy = {
      mode: "legacy_fallback",
      effective_level: policy.legacy_default || "supervised",
      reason_codes: ["autonomy.legacy_supervised_fallback"],
    };
    return true;
  }
  const explicitProfileId = getOptionString(options, "delivery-profile")
    ? normalizeId(getOptionString(options, "delivery-profile"))
    : null;
  let plannedProfile = null;
  try {
    plannedProfile = contract.delivery_execution_profile_id
      ? readDeliveryAutonomyProfile(context, contract.delivery_execution_profile_id, { missingOk: true })
      : null;
  } catch {
    // The normal validation path below reports an invalid selected record.
    plannedProfile = null;
  }
  result.delivery_kind = plannedProfile?.delivery_kind || null;
  if (policy.mode === "observe" && !explicitProfileId) {
    result.autonomy = {
      mode: "observe",
      effective_level: "supervised",
      reason_codes: ["autonomy.selection_missing_observed"],
    };
    return true;
  }
  if (!explicitProfileId && policy.require_explicit_delivery_selection !== false) {
    result.status = "needs_user_input";
    result.execution_allowed = false;
    result.contract_action = "select_delivery_autonomy";
    pushAllUnique(result.blocking_reasons, ["autonomy_selection_required"]);
    const exactDeliveryLabel = result.delivery_kind === "local_release"
      ? "this exact local release"
      : result.delivery_kind === "pull_request" ? "this exact pull request" : "this exact delivery";
    pushAllUnique(result.questions, [
      `Select the already reviewed autonomy profile for ${exactDeliveryLabel}. Contract ${contract.id} expects ${contract.delivery_execution_profile_id || "a new profile"}; the choice is never inferred from a previous delivery.`,
    ]);
    pushAllUnique(result.next_commands, [
      `agentic-sdlc autonomy delivery status${contract.delivery_execution_profile_id ? ` --id ${contract.delivery_execution_profile_id}` : ""}`,
    ]);
    return false;
  }
  if (!explicitProfileId || explicitProfileId !== contract.delivery_execution_profile_id) {
    result.status = "needs_user_input";
    result.execution_allowed = false;
    result.contract_action = "select_delivery_autonomy";
    pushAllUnique(result.blocking_reasons, ["autonomy_profile_contract_mismatch"]);
    pushAllUnique(result.questions, [
      `Contract ${contract.id} is bound to delivery profile ${contract.delivery_execution_profile_id || "none"}, not ${explicitProfileId || "none"}.`,
    ]);
    return false;
  }
  try {
    const profile = readDeliveryAutonomyProfile(context, explicitProfileId);
    result.delivery_kind = profile.delivery_kind;
    const actualStory = result.story_id ? readStory(context, result.story_id) : null;
    const exactStoryRef = profile.story_refs.length === 1 ? profile.story_refs[0] : null;
    const exactContractRef = profile.contract_refs.length === 1 ? profile.contract_refs[0] : null;
    if (
      !actualStory
      || exactStoryRef?.id !== actualStory.id
      || exactContractRef?.id !== contract.id
    ) {
      fail(`Delivery autonomy profile ${profile.id} is not bound to the exact current story and contract.`);
    }
    const { decision } = evaluateDeliveryAutonomy(context, profile, {
      futureAuthority: true,
      id: `AUT-DEC-${uniqueRecordSuffix()}`,
      phase: result.phase || contract.phase,
      // A local release directory is often the output of the approved build.
      // Bind and validate its planned real path now, but require it to exist
      // only when the protected release.local action is authorized.
      validateRuntimeTarget: profile.delivery_kind === "pull_request",
      forStart: true,
    });
    result.delivery_profile_id = profile.id;
    result.delivery_profile_path = toProjectPath(context, deliveryAutonomyPath(context, profile.id));
    result.autonomy_decision = decision;
    result.autonomy = {
      mode: policy.mode,
      requested_level: decision.requested_level,
      effective_level: decision.effective_level,
      execution_status: decision.execution_status,
      reason_codes: decision.reason_codes,
    };
    const invalidConstraints = decision.source_constraints.filter((constraint) => constraint.valid === false);
    const invalidDecision = decision.blocked
      || invalidConstraints.length > 0
      || decision.material_drift.length > 0;
    result.deterministic_checks.push({
      check: "per_delivery_autonomy",
      status: invalidDecision ? "failed" : "passed",
      details: `${decision.requested_level} -> ${decision.effective_level} for ${profile.delivery_kind} ${profile.delivery_id}`,
    });
    if (invalidDecision) {
      result.status = "needs_user_input";
      result.execution_allowed = false;
      result.contract_action = "repair_delivery_autonomy";
      pushAllUnique(result.blocking_reasons, [
        "autonomy_policy_blocked",
        ...decision.reason_codes,
        ...invalidConstraints.flatMap((constraint) => constraint.reason_codes),
        ...decision.material_drift.map((item) => item.reason_code),
      ]);
      return false;
    }
    return true;
  } catch (error) {
    if (!(error instanceof UserError)) throw error;
    result.status = "needs_user_input";
    result.execution_allowed = false;
    result.contract_action = "repair_delivery_autonomy";
    pushAllUnique(result.blocking_reasons, ["autonomy_profile_invalid"]);
    pushAllUnique(result.questions, [error.message]);
    return false;
  }
}

export function readDeliveryAutonomyProfile(context, profileId, options = {}) {
  const filePath = deliveryAutonomyPath(context, profileId);
  if (!fs.existsSync(filePath)) {
    if (options.missingOk) return null;
    fail(`Delivery autonomy profile ${profileId} does not exist.`);
  }
  const profile = readProjectJson(context, filePath);
  const integrity = validateDeliveryExecutionProfileIntegrity(profile);
  if (!integrity.valid) {
    fail(`Delivery autonomy profile ${profileId} failed integrity validation: ${integrity.errors.join("; ")}`);
  }
  assertRecordSchema(profile, deliveryExecutionProfileSchemaName(profile), `Delivery autonomy profile ${profileId}`);
  return profile;
}

/**
 * The revision of an amended profile that carried `hash`: the live profile
 * itself, or the earlier revision kept beside it. null when the hash belongs
 * to no revision of this profile.
 */
export function readDeliveryProfileAtHash(context, profile, hash) {
  if (!hash || hash === profile.profile_hash) return profile;
  const entry = deliveryProfileRevisionHistory(profile).find((item) => item.profile_hash === hash);
  if (!entry) return null;
  const filePath = deliveryProfileRevisionPath(context, profile.id, entry.revision);
  if (!fs.existsSync(filePath)) {
    fail(`Delivery autonomy profile ${profile.id} lost its earlier revision ${entry.revision}: ${toProjectPath(context, filePath)}.`);
  }
  const earlier = readProjectJson(context, filePath);
  const integrity = validateDeliveryExecutionProfileIntegrity(earlier);
  if (!integrity.valid || earlier.id !== profile.id || earlier.profile_hash !== hash) {
    fail(`Earlier revision ${entry.revision} of delivery autonomy profile ${profile.id} failed integrity validation.`);
  }
  return earlier;
}

export function deliveryTargetFromOptions(context, kind, options) {
  if (kind === "pull_request") {
    const mode = (getOptionString(options, "pr-mode") || "new").toLowerCase();
    if (!["new", "existing"].includes(mode)) {
      fail("Pull-request --pr-mode must be new or existing.");
    }
    const allowedActions = [...new Set(normalizeListOption(options["allow-action"])
      .map((action) => normalizeDeliveryAction(kind, action)))].sort();
    const repository = normalizeGitRepositoryIdentity(requireOption(options, "repository"));
    if (!repository?.startsWith("github.com/")) {
      fail("pull_request repository must be an exact GitHub identity (github.com/owner/repo or owner/repo); other providers need an adapter.");
    }
    const prNumberOption = getOptionString(options, "pr-number");
    const prUrlOption = getOptionString(options, "pr-url");
    const prHeadShaOption = getOptionString(options, "pr-head-sha");
    let existingIdentity = {
      pr_number: null,
      pr_url: null,
      reviewed_head_sha: null,
    };
    if (mode === "new") {
      if (prNumberOption || prUrlOption || prHeadShaOption) {
        fail("--pr-number, --pr-url, and --pr-head-sha are only valid with --pr-mode existing.");
      }
    } else {
      if (!prNumberOption || !/^[1-9]\d*$/u.test(prNumberOption)) {
        fail("Existing pull-request delivery requires --pr-number as a positive integer.");
      }
      if (!prUrlOption) {
        fail("Existing pull-request delivery requires the exact --pr-url.");
      }
      const prNumber = Number(prNumberOption);
      if (!Number.isSafeInteger(prNumber)) {
        fail("--pr-number is outside the supported integer range.");
      }
      const parsedIdentity = parsePullRequestUrlIdentity(
        prUrlOption,
        repository,
        "Existing pull-request --pr-url",
      );
      if (parsedIdentity.number !== prNumber) {
        fail(`Existing pull-request --pr-number ${prNumber} does not match --pr-url number ${parsedIdentity.number}.`);
      }
      if (allowedActions.includes("pull_request.create")) {
        fail("Existing pull-request delivery cannot allow pull_request.create.");
      }
      existingIdentity = {
        pr_number: prNumber,
        pr_url: parsedIdentity.url,
        reviewed_head_sha: reviewedPullRequestHeadSha(
          context,
          requireOption(options, "head"),
          prHeadShaOption,
        ),
      };
    }
    return {
      pull_request_target: {
        repository,
        base_branch: requireOption(options, "base"),
        head_branch: requireOption(options, "head"),
        mode,
        ...existingIdentity,
        // merge_allowed and the merge action always travel together.
        allowed_actions: [...new Set([
          ...(allowedActions.length > 0
            ? allowedActions
            : [
                "repository.read",
                "repository.write",
                "test.run",
                "git.commit",
                "git.push",
                ...(mode === "new" ? ["pull_request.create"] : []),
                "pull_request.update",
              ]),
          ...(options["merge-allowed"] === true ? ["pull_request.merge"] : []),
        ])].sort(),
        merge_allowed: options["merge-allowed"] === true,
      },
      local_release_target: null,
    };
  }
  const rootPath = path.resolve(requireOption(options, "target-root"));
  const writePaths = [...new Set(
    normalizeRawListOption(options["write-path"])
      .map((item) => path.isAbsolute(item) ? path.resolve(item) : path.resolve(rootPath, item)),
  )].sort();
  if (writePaths.length === 0) {
    fail("Local-release delivery autonomy requires at least one explicit --write-path.");
  }
  const smokeCwdOption = getOptionString(options, "smoke-cwd");
  if (!smokeCwdOption && writePaths.length !== 1) {
    fail(
      "Local release with multiple --write-path values requires one explicit --smoke-cwd "
      + "inside the released artifact that the smoke test must verify.",
    );
  }
  const smokeCwd = smokeCwdOption
    ? path.isAbsolute(smokeCwdOption)
      ? path.resolve(smokeCwdOption)
      : path.resolve(rootPath, smokeCwdOption)
    : writePaths[0];
  if (!writePaths.some((writePath) => isInsidePath(writePath, smokeCwd))) {
    fail("Local-release --smoke-cwd must be equal to or inside one approved --write-path.");
  }
  const explicitlyAllowedActions = [...new Set(normalizeListOption(options["allow-action"])
    .map((action) => normalizeDeliveryAction(kind, action)))].sort();
  const allowedActions = [...new Set([
    ...(explicitlyAllowedActions.length > 0
      ? explicitlyAllowedActions
      : ["build.local", "test.run", "release.local"]),
    "rollback.verify",
  ])].sort();
  const dataActionDeclared = allowedActions.includes("data.migrate")
    || allowedActions.includes("data.rollback");
  const dataOptionsDeclared = [
    getOptionString(options, "data-target"),
    getOptionString(options, "backup-path"),
    ...normalizeRawListOption(options["data-scope"]),
    ...normalizeRawListOption(options["migration-preview"]),
  ].some(Boolean);
  if (
    dataActionDeclared
    && (!allowedActions.includes("data.migrate") || !allowedActions.includes("data.rollback"))
  ) {
    fail("Reversible local data changes require both --allow-action data.migrate and --allow-action data.rollback.");
  }
  if (!dataActionDeclared && dataOptionsDeclared) {
    fail("Data migration options require both data.migrate and data.rollback in the approved action set.");
  }
  let dataMigration = null;
  if (dataActionDeclared) {
    const dataTargetOption = requireOption(options, "data-target");
    const backupPathOption = requireOption(options, "backup-path");
    const dataTarget = path.isAbsolute(dataTargetOption)
      ? path.resolve(dataTargetOption)
      : path.resolve(rootPath, dataTargetOption);
    const backupPath = path.isAbsolute(backupPathOption)
      ? path.resolve(backupPathOption)
      : path.resolve(rootPath, backupPathOption);
    if (dataTarget === backupPath) {
      fail("Local data migration --backup-path must differ from --data-target.");
    }
    for (const [label, candidate] of [["--data-target", dataTarget], ["--backup-path", backupPath]]) {
      if (!isInsidePath(rootPath, candidate) || candidate === rootPath) {
        fail(`Local data migration ${label} must be a strict child of --target-root.`);
      }
      if (!writePaths.some((writePath) => isInsidePath(writePath, candidate))) {
        fail(`Local data migration ${label} must be equal to or inside one approved --write-path.`);
      }
    }
    let dataTargetStats;
    try {
      dataTargetStats = fs.lstatSync(dataTarget);
    } catch (error) {
      fail(`Local data migration --data-target must already exist as a regular file: ${error.message}`);
    }
    if (dataTargetStats.isSymbolicLink() || !dataTargetStats.isFile()) {
      fail("Local data migration --data-target must be a real regular file, not a directory or symlink.");
    }
    const scopes = [...new Set(
      normalizeRawListOption(options["data-scope"])
        .map((item) => String(item).trim())
        .filter(Boolean),
    )].sort();
    if (scopes.length === 0) {
      fail("Local data migration requires at least one exact --data-scope.");
    }
    const previewEvidence = buildActionEvidence(context, options["migration-preview"]);
    if (previewEvidence.length === 0) {
      fail("Local data migration requires at least one immutable --migration-preview evidence file.");
    }
    for (const evidence of previewEvidence) {
      const evidencePath = resolveProjectFilePath(context, evidence.path, { mustExist: true, fileOnly: true });
      if (writePaths.some((writePath) => isInsidePath(writePath, evidencePath))) {
        fail("Local data migration preview evidence must be outside every approved mutable write path.");
      }
    }
    dataMigration = {
      target_path: dataTarget,
      scopes,
      preview_evidence: previewEvidence,
      backup: { required: true, path: backupPath },
      rollback_verification_required: true,
    };
  }
  const localReleaseTarget = {
    environment: "local",
    root_path: rootPath,
    allowed_write_paths: writePaths,
    allowed_actions: allowedActions,
    smoke_tests: normalizeListOption(options["smoke-test"]).map(normalizeSmokeTestCommand).sort(),
    smoke_cwd: smokeCwd,
    ...(dataMigration ? { data_migration: dataMigration } : {}),
    rollback: {
      required: true,
      procedure: requireOption(options, "rollback"),
      verification_required: true,
    },
    external_access_allowed: false,
    production_access_allowed: false,
    destructive_actions_allowed: false,
  };
  validateLocalReleaseFilesystemBoundary(localReleaseTarget, { requireExistingRoot: false });
  return {
    pull_request_target: null,
    local_release_target: localReleaseTarget,
  };
}

/** The story a delivery profile is for, the story records policy, and what classifying its record paths needs. */
export function storyRecordsContext(context, profile) {
  let policy;
  try {
    policy = orchestrationPolicy(context.config).story_records;
  } catch {
    policy = { in_branch: "exclude", before_pull_request: "off" };
  }
  const storyId = profile.story_refs?.length === 1 ? profile.story_refs[0].id : null;
  const sdlcFolder = path.relative(context.root, context.sdlcRoot).replace(/\\/gu, "/") || ".sdlc";
  let storyIds = [];
  try {
    storyIds = fs.readdirSync(path.join(context.sdlcRoot, "stories"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    storyIds = [];
  }
  return { policy, storyId, options: { sdlcFolder, storyId, storyIds } };
}

/** The story records a pull request's head lacks (its claim, a completed step); empty when the check is off. */
function storyRecordsMissingAtHead(context, records, headSha) {
  if (!records.storyId || records.policy.before_pull_request === "off" || !headSha) return [];
  const listed = execGitOutput(context.root, [
    "ls-tree", "-r", "--name-only", headSha, "--", `${records.options.sdlcFolder}/stories/${records.storyId}/`,
  ]);
  if (listed === null) return [];
  return missingStoryRecords(String(listed).split(/\r?\n/u).filter(Boolean), records.options);
}

export function buildDeliveryActionDetails(context, profile, action, runtimeTarget, options) {
  if (profile.delivery_kind === "local_release") {
    const details = {
      target_root: profile.local_release_target.root_path,
      allowed_write_paths: profile.local_release_target.allowed_write_paths,
      smoke_cwd: governedLocalSmokeCwd(profile).smokeCwd,
    };
    if (action === "rollback.verify") {
      const verificationEvidence = buildActionEvidence(context, options.evidence)
        .sort((left, right) => left.path.localeCompare(right.path));
      if (verificationEvidence.length === 0) {
        fail("rollback.verify requires at least one immutable --evidence file.");
      }
      if (new Set(verificationEvidence.map((item) => item.path)).size !== verificationEvidence.length) {
        fail("rollback.verify evidence paths must be unique.");
      }
      for (const evidence of verificationEvidence) {
        const evidencePath = resolveProjectFilePath(
          context,
          evidence.path,
          { mustExist: true, fileOnly: true },
        );
        if (
          profile.local_release_target.allowed_write_paths
            .some((writePath) => isInsidePath(writePath, evidencePath))
        ) {
          fail("rollback.verify evidence must stay outside every approved mutable write path.");
        }
      }
      details.rollback_verification = {
        target_root: profile.local_release_target.root_path,
        allowed_write_paths: profile.local_release_target.allowed_write_paths,
        rollback_procedure: profile.local_release_target.rollback.procedure,
        evidence_root: context.root,
        evidence: verificationEvidence,
        ...(profile.local_release_target.data_migration
          ? {
              data_rollback_receipt_ref: requireLatestPassingDataRollback(
                context,
                profile,
              ),
            }
          : {}),
      };
    }
    if (["data.migrate", "data.rollback"].includes(action)) {
      assertDataMigrationPreviewEvidenceCurrent(context, profile.local_release_target.data_migration);
      details.data_migration = structuredClone(profile.local_release_target.data_migration);
    }
    if (action === "release.local" && profile.local_release_target.data_migration) {
      details.data_migration_sequence = requireReversibleDataReleaseSequence(context, profile);
    }
    if (action === "release.local") {
      details.local_release_integrity = localReleaseIntegrityAttestation(context, profile);
    }
    return details;
  }
  const observedPaths = pullRequestChangedPaths(context, runtimeTarget, action);
  const requestedScopePaths = action === "git.commit"
    ? normalizeRawListOption(options["scope-path"]).map((item) => normalizeProjectPathInput(item))
    : [];
  if (action === "git.commit" && requestedScopePaths.length === 0) {
    fail("git.commit requires at least one exact --scope-path to bind the commit file set.");
  }
  const changedPaths = action === "git.commit" ? [...new Set(requestedScopePaths)].sort() : observedPaths;
  if (action === "git.commit") {
    const missing = changedPaths.filter((filePath) => !observedPaths.includes(filePath));
    if (missing.length > 0) {
      fail(`git.commit --scope-path is not currently changed or untracked: ${missing.join(", ")}.`);
    }
    // Each check below must fail closed: an unreadable git result is refused,
    // never read as "nothing staged/unstaged/unmerged".
    const scopeGit = (args) => {
      const output = execGitOutput(context.root, args);
      if (output === null) fail(`git.commit scope could not be verified: git ${args[0]} failed.`);
      return output;
    };
    const stagedPaths = [...new Set(String(
      scopeGit(["diff", "--cached", "--name-only", "--no-renames", "HEAD", "--"]),
    ).split(/\r?\n/u).map((item) => item.trim()).filter(Boolean))].sort();
    if (stableJson(stagedPaths) !== stableJson(changedPaths)) {
      fail("git.commit requires the staged file set to match the exact --scope-path set before authorization.");
    }
    const unstagedScopePaths = [...new Set(String(
      scopeGit(["diff", "--name-only", "--no-renames", "--", ...changedPaths]),
    ).split(/\r?\n/u).map((item) => item.trim()).filter(Boolean))].sort();
    if (unstagedScopePaths.length > 0) {
      fail(`git.commit scope has unstaged changes after staging: ${unstagedScopePaths.join(", ")}.`);
    }
    const unmergedScope = String(
      scopeGit(["ls-files", "--unmerged", "--", ...changedPaths]),
    ).trim();
    if (unmergedScope) {
      fail("git.commit scope contains unmerged index entries.");
    }
  }
  const allowedPaths = profile.constraints?.allowed_write_paths || [];
  const records = storyRecordsContext(context, profile);
  // The story's own records travel on its branch with the code, outside the write scope that bounds the code.
  // Picking up the approved base branch brings in files that are not the story's work: only what differs from the base is charged.
  const mergeFromBase = ["git.commit", "git.push", "pull_request.create", "pull_request.update"].includes(action)
    ? mergeFromBaseEvidence(
      context,
      { base_ref: runtimeTarget.base_ref, base_sha: runtimeTarget.base_sha, head_sha: runtimeTarget.head_sha },
      changedPaths,
      action === "git.commit" ? "index" : "head",
    )
    : null;
  const scopedPaths = mergeFromBase
    ? changedPaths.filter((filePath) => !mergeFromBase.excluded_paths.includes(filePath))
    : changedPaths;
  const storyRecordPaths = records.policy.in_branch === "include" && records.storyId
    ? scopedPaths.filter((filePath) => !pathMatchesApprovedWriteScope(filePath, allowedPaths)
      && storyBranchRecordPath(filePath, records.options))
    : [];
  const outOfScope = scopedPaths.filter((filePath) => !pathMatchesApprovedWriteScope(filePath, allowedPaths)
    && !storyRecordPaths.includes(filePath));
  if (outOfScope.length > 0) {
    fail(`Delivery action ${action} includes paths outside the approved write scope: ${outOfScope.join(", ")}.`);
  }
  const missingRecords = ["pull_request.create", "pull_request.update"].includes(action)
    ? storyRecordsMissingAtHead(context, records, runtimeTarget.head_sha)
    : [];
  if (missingRecords.length > 0 && records.policy.before_pull_request === "refuse") {
    fail(
      `Delivery action ${action} for story ${records.storyId} is refused: the pull request does not carry the story's records `
      + `(${missingRecords.join(", ")}), so merging it would leave the story open on every other computer. `
      + "Commit the story's records on its branch, then request the checkpoint again.",
    );
  }
  if (action === "git.commit") {
    const foreign = foreignStoryBranchCommits(context, profile, runtimeTarget.head_sha);
    if (foreign.length > 0) fail(foreignStoryBranchCommitMessage(action, foreign));
  }
  const details = {
    repository: normalizeGitRepositoryIdentity(profile.pull_request_target.repository),
    base_branch: profile.pull_request_target.base_branch,
    head_branch: profile.pull_request_target.head_branch,
    source_sha: runtimeTarget.head_sha,
    changed_paths: changedPaths,
    allowed_write_paths: allowedPaths,
    ...(storyRecordPaths.length > 0 ? { story_record_paths: storyRecordPaths } : {}),
    ...(mergeFromBase ? { merge_from_base: mergeFromBase } : {}),
    ...(missingRecords.length > 0 ? { story_records_missing: missingRecords } : {}),
  };
  if (action === "git.commit") {
    const objectFormat = String(execGit(context.root, ["rev-parse", "--show-object-format"]) || "").trim();
    const indexTreeOid = String(execGit(context.root, ["write-tree"]) || "").trim();
    if (!/^(?:sha1|sha256)$/u.test(objectFormat) || !/^[a-f0-9]{40,64}$/u.test(indexTreeOid)) {
      fail("git.commit could not bind the staged index to a canonical Git tree.");
    }
    details.commit_snapshot = {
      schema_version: "git-commit-index-snapshot:v1",
      object_format: objectFormat,
      source_head_sha: runtimeTarget.head_sha,
      index_tree_oid: indexTreeOid,
      staged_paths: changedPaths,
    };
  }
  if (action === "git.push") {
    const remote = getOptionString(options, "remote") || (runtimeTarget.matching_remotes.length === 1
      ? runtimeTarget.matching_remotes[0]
      : null);
    if (!remote || !runtimeTarget.matching_remotes.includes(remote)) {
      fail("git.push requires --remote naming one exact matching remote.");
    }
    details.push = {
      remote,
      source_sha: runtimeTarget.head_sha,
      destination_ref: `refs/heads/${profile.pull_request_target.head_branch}`,
      force: false,
      delete: false,
    };
  }
  if (["pull_request.create", "pull_request.update", "pull_request.merge"].includes(action)) {
    const pullRequestMode = profile.pull_request_target.mode || "new";
    if (action === "pull_request.create" && pullRequestMode === "existing") {
      fail("pull_request.create is not valid for an existing pull request pinned by the approved delivery profile.");
    }
    const prUrl = getOptionString(options, "pr-url");
    if (action !== "pull_request.create" && !prUrl) {
      fail(`${action} requires the exact --pr-url shown at the checkpoint.`);
    }
    let parsedIdentity = null;
    if (prUrl) {
      parsedIdentity = parsePullRequestUrlIdentity(
        prUrl,
        profile.pull_request_target.repository,
        `${action} --pr-url`,
      );
    }
    if (
      pullRequestMode === "existing"
      && (
        parsedIdentity?.number !== profile.pull_request_target.pr_number
        || parsedIdentity?.url !== profile.pull_request_target.pr_url
      )
    ) {
      fail(
        `${action} must use the exact existing PR #${profile.pull_request_target.pr_number} `
        + `approved as ${profile.pull_request_target.pr_url}; create and approve a new delivery profile to retarget it.`,
      );
    }
    const canonicalPrUrl = parsedIdentity?.url || null;
    details.pull_request = {
      mode: pullRequestMode,
      pr_number: parsedIdentity?.number || null,
      pr_url: canonicalPrUrl,
      source_sha: runtimeTarget.head_sha,
    };
    if (action === "pull_request.merge") {
      details.merge = {
        pr_url: canonicalPrUrl,
        source_sha: runtimeTarget.head_sha,
        base_sha: runtimeTarget.base_sha,
        force: false,
      };
    }
    if (action === "pull_request.update") {
      const expected = {};
      const expectedTitle = getOptionString(options, "expected-pr-title");
      const expectedBodyHash = getOptionString(options, "expected-pr-body-sha256");
      const expectedState = getOptionString(options, "expected-pr-state");
      const expectedBase = getOptionString(options, "expected-pr-base");
      if (expectedTitle) expected.title = expectedTitle;
      if (expectedBodyHash) {
        if (!/^[a-f0-9]{64}$/u.test(expectedBodyHash)) {
          fail("pull_request.update --expected-pr-body-sha256 must be a lowercase SHA-256 hash.");
        }
        expected.body_sha256 = expectedBodyHash;
      }
      if (expectedState) {
        if (!["draft", "ready"].includes(expectedState)) {
          fail("pull_request.update --expected-pr-state must be exactly draft or ready.");
        }
        expected.is_draft = expectedState === "draft";
      }
      if (expectedBase) {
        if (expectedBase !== profile.pull_request_target.base_branch) {
          fail("pull_request.update cannot retarget the pull request outside the approved base branch.");
        }
        expected.base_branch = expectedBase;
      }
      if (Object.keys(expected).length === 0) {
        fail("pull_request.update requires at least one exact expected PR field.");
      }
      details.pull_request.expected = expected;
    }
  }
  return details;
}

export function verifyDeliveryProviderCompletion(context, profile, action, providerOperation, completedAt) {
  const binding = resolveDeliveryProviderBinding(profile, action);
  if (!binding || !providerOperation?.precondition_receipt) {
    fail(`The authorization for ${action} has no verified starting state.`);
  }
  if (
    providerOperation.binding?.provider_id !== binding.provider_id
    || providerOperation.binding?.action !== action
    || providerOperation.binding?.provider_bindings_hash !== (profile.provider_bindings_hash || null)
  ) {
    fail(`The verification provider for ${action} changed after authorization.`);
  }
  const precondition = assertProviderOperationReceiptIntegrity(providerOperation.precondition_receipt);
  if (
    precondition.provider.id !== binding.provider_id
    || precondition.operation.action !== action
    || precondition.operation.phase !== "precondition"
  ) {
    fail(`The saved starting-state proof for ${action} does not match this delivery.`);
  }
  const registry = createDefaultDeliveryProviderRegistry();
  try {
    const completion = registry.verifyCompletion(binding.provider_id, {
      id: precondition.operation.id,
      action,
      subject: precondition.subject,
      observed_at: completedAt,
    }, precondition, { cwd: context.root });
    assertProviderOperationReceiptIntegrity(completion);
    assertRecordSchema(completion, "provider-operation-receipt.schema.json", `${action} provider completion`);
    return {
      ...providerOperation,
      completion_receipt: completion,
    };
  } catch (error) {
    if (error instanceof DeliveryProviderError) {
      fail(`Could not verify the completed result for ${action}. ${error.message}`);
    }
    throw error;
  }
}

export function approvedLocalSmokeCwd(profile) {
  const { smokeCwd, containingWritePath } = governedLocalSmokeCwd(profile);
  const target = profile.local_release_target || {};
  if (!fs.existsSync(smokeCwd) || !fs.statSync(smokeCwd).isDirectory()) {
    fail(`Local release smoke working directory must exist as a directory before completion: ${smokeCwd}.`);
  }
  const rootPath = path.resolve(String(target.root_path || ""));
  assertNoSymlinkPathSegments(smokeCwd, rootPath);
  if (fs.lstatSync(smokeCwd).isSymbolicLink()) {
    fail(`Local release smoke working directory cannot be a symlink: ${smokeCwd}.`);
  }
  const realWritePath = fs.realpathSync.native(containingWritePath);
  const realSmokeCwd = fs.realpathSync.native(smokeCwd);
  if (!isInsidePath(realWritePath, realSmokeCwd)) {
    fail(`Local release smoke working directory resolves outside its approved write path: ${smokeCwd}.`);
  }
  return smokeCwd;
}

export function validateLocalSmokeCommandBoundary(cwd, argv) {
  const executable = path.basename(String(argv[0] || "")).toLowerCase();
  if (![
    "npm",
    "npm.cmd",
    "npm.exe",
    "npx",
    "npx.cmd",
    "npx.exe",
    "pnpm",
    "pnpm.cmd",
    "pnpm.exe",
    "yarn",
    "yarn.cmd",
    "yarn.exe",
    "bun",
    "bunx",
  ].includes(executable)) {
    return;
  }
  const forbiddenLocationArgs = new Set([
    "--cwd",
    "--dir",
    "--global",
    "--prefix",
    "--workspace",
    "--workspaces",
    "-c",
    "-g",
    "-w",
  ]);
  const locationOverride = argv.slice(1).find((item) => {
    const normalized = String(item).toLowerCase();
    return forbiddenLocationArgs.has(normalized)
      || [...forbiddenLocationArgs].some((flag) => normalized.startsWith(`${flag}=`));
  });
  if (locationOverride) {
    fail(
      `Package-manager smoke test cannot override its governed working directory with ${locationOverride}. `
      + "Run a script from the package.json stored in --smoke-cwd.",
    );
  }
  const manifestPath = path.join(cwd, "package.json");
  if (
    !pathEntryExistsNoFollow(manifestPath)
    || fs.lstatSync(manifestPath).isSymbolicLink()
    || !fs.statSync(manifestPath).isFile()
  ) {
    fail(
      `Package-manager smoke test ${argv[0]} requires a real package.json in the governed `
      + `smoke working directory ${cwd}; parent project packages are never used as release evidence.`,
    );
  }
  const realManifestPath = fs.realpathSync.native(manifestPath);
  if (!isInsidePath(fs.realpathSync.native(cwd), realManifestPath)) {
    fail(`Package-manager smoke manifest resolves outside the governed smoke working directory: ${manifestPath}.`);
  }
}

export function runApprovedLocalSmokeTests(profile, authorizedPolicy) {
  const cwd = approvedLocalSmokeCwd(profile);
  const currentPolicy = localSmokeSandboxPolicyAttestation(profile);
  if (
    !hashBoundRecordIsValid(authorizedPolicy, "policy_hash")
    || stableJson(currentPolicy) !== stableJson(authorizedPolicy)
  ) {
    fail(
      "The exact smoke launcher, runtime executable, sandbox, environment, plugin build, or host "
      + "capability changed after release.local authorization; request a fresh release checkpoint.",
    );
  }
  return authorizedPolicy.launchers.map((launcher) => {
    const argv = launcher.command;
    validateLocalSmokeCommandBoundary(cwd, argv);
    validateLocalSmokePayloadBindingsBeforeSpawn(launcher);
    if (
      !hashBoundRecordIsValid(launcher, "launcher_hash")
      || stableLocalSmokeExecutableSnapshot(launcher.wrapper_executable).sha256
        !== launcher.wrapper_executable_sha256
      || stableLocalSmokeExecutableSnapshot(launcher.command_executable).sha256
        !== launcher.command_executable_sha256
      || stableLocalSmokeExecutableSnapshot(launcher.runtime_executable).sha256
        !== launcher.runtime_executable_sha256
    ) {
      fail("An authorized local smoke launcher changed immediately before execution.");
    }
    const startedAt = now();
    const result = childProcess.spawnSync(launcher.wrapper_executable, launcher.wrapper_args, {
      cwd,
      encoding: "utf8",
      shell: false,
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
      env: launcher.environment,
    });
    const finishedAt = now();
    const stdout = result.stdout || "";
    const stderr = result.stderr || "";
    return {
      command: argv,
      cwd,
      sandbox: launcher.sandbox,
      exit_code: Number.isInteger(result.status) ? result.status : null,
      signal: result.signal || null,
      error_code: result.error?.code || null,
      outcome: !result.error && result.status === 0 ? "passed" : "failed",
      stdout_sha256: hashBuffer(Buffer.from(stdout, "utf8")),
      stderr_sha256: hashBuffer(Buffer.from(stderr, "utf8")),
      started_at: startedAt,
      finished_at: finishedAt,
    };
  });
}

// Local release destinations inside this Git worktree whose files Git sees
// (not ignored, or already tracked). Their files count as repository changes;
// the strict write-scope check accepts them only while they match the released
// artifact manifest, so an ignored or external destination is the safer choice.
export function localReleaseDestinationsVisibleToGit(context, writePaths) {
  if (execGit(context.root, ["rev-parse", "--is-inside-work-tree"]) !== "true") return [];
  return (writePaths || [])
    .filter((writePath) => isInsidePath(context.root, writePath))
    .map((writePath) => toProjectPath(context, writePath))
    .filter((projectPath) => projectPath && projectPath !== ".")
    .filter((projectPath) =>
      !gitCommandSucceeds(context.root, ["check-ignore", "-q", "--", `${projectPath}/`]))
    .sort();
}

export function localSmokeExecutionBoundary() {
  const common = {
    schema_version: "local-smoke-execution-boundary:v1",
    filesystem_writes: "denied",
    readable_files: "host_account_scope",
    confidentiality_isolation: "not_provided",
    transitive_code_attestation: "not_provided",
    external_network: "denied",
    reviewed_code_required: true,
    explicit_entrypoint_binding: "artifact_manifest_bound",
    portable_recommendation: "do_not_depend_on_network_or_listeners",
    recommended_patterns: [
      "exercise an exported API handler in-process",
      "validate built artifact files without opening sockets",
    ],
  };
  if (process.platform === "darwin") {
    return {
      ...common,
      provider: "macos-sandbox-exec-readonly-no-network",
      provider_available: fs.existsSync("/usr/bin/sandbox-exec"),
      loopback_network: "denied",
      listener_based_smoke: "unsupported",
    };
  }
  if (process.platform === "linux") {
    return {
      ...common,
      provider: "linux-bwrap-readonly-no-network",
      provider_available: fs.existsSync("/usr/bin/bwrap"),
      loopback_network: "isolated_namespace_only",
      listener_based_smoke: "namespace_local_only",
    };
  }
  return {
    ...common,
    provider: "unavailable",
    provider_available: false,
    loopback_network: "unavailable",
    listener_based_smoke: "unsupported",
  };
}

export function resolveLocalSmokeExecutable(command, cwd) {
  const rawExecutable = String(command?.[0] || "");
  const hasPathSeparator = rawExecutable.includes("/") || rawExecutable.includes("\\");
  let resolved;
  if (path.isAbsolute(rawExecutable) || hasPathSeparator) {
    const candidate = path.isAbsolute(rawExecutable)
      ? path.resolve(rawExecutable)
      : path.resolve(cwd, rawExecutable);
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile()) {
        fail(`Local smoke executable is not a regular file: ${candidate}.`);
      }
      fs.accessSync(candidate, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
      resolved = {
        candidate,
        realpath: fs.realpathSync.native(candidate),
      };
    } catch (error) {
      if (error instanceof UserError) throw error;
      fail(`Local smoke executable is not available: ${candidate}.`);
    }
  } else {
    resolved = resolveExecutableFromPath(rawExecutable, cwd);
  }
  if (!resolved) {
    fail(
      `Local smoke executable '${rawExecutable}' is not available from the governed PATH. `
      + "Install it or choose a smoke command that is present before authorizing release.local.",
    );
  }
  return resolved;
}

export function localSmokeRuntimeDescriptor(resolvedCommand, command, cwd) {
  validateResolvedLocalSmokeExecutable(resolvedCommand);
  const commandSnapshot = stableLocalSmokeExecutableSnapshot(resolvedCommand.realpath);
  if (!commandSnapshot.shebang) {
    return {
      command_executable: resolvedCommand.realpath,
      command_executable_sha256: commandSnapshot.sha256,
      runtime_executable: resolvedCommand.realpath,
      runtime_executable_sha256: commandSnapshot.sha256,
      interpreter: null,
      execution_argv: [resolvedCommand.realpath, ...command.slice(1)],
    };
  }
  const tokens = commandSnapshot.shebang.split(/\s+/u).filter(Boolean);
  let interpreterName;
  let interpreterSource;
  if (tokens[0] === "/usr/bin/env") {
    if (
      tokens.length !== 2
      || tokens[1].startsWith("-")
      || tokens[1].includes("=")
    ) {
      fail(
        `Local smoke script ${resolvedCommand.realpath} uses an ambiguous /usr/bin/env shebang. `
        + "Use '#!/usr/bin/env <runtime>' without flags or environment assignments.",
      );
    }
    interpreterName = tokens[1];
    interpreterSource = "env-path";
  } else {
    if (tokens.length !== 1 || !path.isAbsolute(tokens[0])) {
      fail(
        `Local smoke script ${resolvedCommand.realpath} must use one absolute interpreter `
        + "or '#!/usr/bin/env <runtime>'.",
      );
    }
    interpreterName = tokens[0];
    interpreterSource = "absolute";
  }
  const interpreter = resolveLocalSmokeExecutable([interpreterName], cwd);
  validateResolvedLocalSmokeExecutable(interpreter);
  const interpreterSnapshot = stableLocalSmokeExecutableSnapshot(interpreter.realpath);
  if (interpreterSnapshot.shebang) {
    fail(
      `Local smoke script ${resolvedCommand.realpath} resolves to nested script interpreter `
      + `${interpreter.realpath}. Choose a native runtime executable so the full launch chain can be attested.`,
    );
  }
  return {
    command_executable: resolvedCommand.realpath,
    command_executable_sha256: commandSnapshot.sha256,
    runtime_executable: interpreter.realpath,
    runtime_executable_sha256: interpreterSnapshot.sha256,
    interpreter: {
      source: interpreterSource,
      requested: interpreterName,
      resolved: interpreter.realpath,
      shebang_sha256: hashBuffer(Buffer.from(commandSnapshot.shebang, "utf8")),
    },
    execution_argv: [
      interpreter.realpath,
      resolvedCommand.realpath,
      ...command.slice(1),
    ],
  };
}

export function localSmokeArgumentPathCandidate(rawArgument, cwd) {
  const raw = String(rawArgument || "");
  let value = raw;
  let source = "argument";
  if (raw.startsWith("file:")) {
    try {
      return {
        resolvedPath: path.resolve(fileURLToPath(raw)),
        source: "file-url",
      };
    } catch {
      fail(`Local smoke payload uses an invalid file URL: ${raw}.`);
    }
  }
  if (raw.startsWith("-")) {
    const separator = raw.indexOf("=");
    if (separator < 0) return null;
    value = raw.slice(separator + 1);
    source = "option-value";
  }
  if (value.startsWith("file:")) {
    try {
      return {
        resolvedPath: path.resolve(fileURLToPath(value)),
        source: `${source}:file-url`,
      };
    } catch {
      fail(`Local smoke payload uses an invalid file URL: ${value}.`);
    }
  }
  const resolvedCandidate = path.resolve(cwd, value);
  const looksLikePath = (
    path.isAbsolute(value)
    || path.win32.isAbsolute(value)
    || value.startsWith(".")
    || value.includes("/")
    || value.includes("\\")
    || fs.existsSync(resolvedCandidate)
    || /\.(?:cjs|cts|js|json|mjs|mts|py|pyw|rb|pl|php|ts|tsx|jsx|wasm|jar|dll|exe)$/iu.test(value)
  );
  return looksLikePath
    ? { resolvedPath: resolvedCandidate, source }
    : null;
}

export function localSmokePayloadBindings(profile, command, resolvedCommand, runtime, cwd) {
  const packageManager = validateLocalSmokePackageManagerForm(command);
  const bindings = [];
  const commandSnapshot = stableLocalSmokeExecutableSnapshot(resolvedCommand.realpath);
  const directRuntimeBase = localSmokeExecutableBase(runtime.runtime_executable);
  const directInterpreter = runtime.interpreter === null
    && /^(?:node(?:js)?|python(?:\d+(?:\.\d+)*)?|ruby|perl|php|deno|bun)(?:[-.]\d.*)?$/u
      .test(directRuntimeBase);
  if (directInterpreter && command.slice(1).some((item) =>
    /^(?:-e|--eval|-c|--print|-p)(?:=|.+)?$/u.test(String(item)))) {
    fail(
      `Local smoke runtime ${runtime.runtime_executable} cannot execute inline code. `
      + "Use a reviewed entrypoint stored in the released artifact.",
    );
  }
  const nodeLikeRuntime = /^(?:node(?:js)?|bun|deno)(?:[-.]\d.*)?$/u.test(directRuntimeBase);
  const pythonRuntime = /^python(?:\d+(?:\.\d+)*)?(?:[-.]\d.*)?$/u.test(directRuntimeBase);
  const rubyRuntime = /^ruby(?:[-.]\d.*)?$/u.test(directRuntimeBase);
  const perlRuntime = /^perl(?:[-.]\d.*)?$/u.test(directRuntimeBase);
  const ambiguousLoader = directInterpreter
    ? command.slice(1).find((item) => {
        const value = String(item);
        return (
          (
            nodeLikeRuntime
            && (
              /^(?:--require|--import|--loader|--experimental-loader|--env-file|--openssl-config|--icu-data-dir|--snapshot-blob)(?:=|$)/u
                .test(value)
              || /^-r(?:=|.+|$)/u.test(value)
            )
          )
          || (pythonRuntime && /^-m(?:.+)?$/u.test(value))
          || (rubyRuntime && /^-(?:r|I)(?:=|.+|$)/u.test(value))
          || (perlRuntime && /^-(?:I|M)(?:=|.+|$)/u.test(value))
        );
      })
    : null;
  if (ambiguousLoader) {
    fail(
      `Local smoke loader option '${ambiguousLoader}' is not allowed. `
      + "Use one explicit reviewed entrypoint inside the released artifact.",
    );
  }
  if (commandSnapshot.shebang && !packageManager) {
    bindings.push(governedLocalSmokePayloadBinding(
      profile,
      cwd,
      resolvedCommand.realpath,
      {
        argumentIndex: 0,
        origin: "command-script",
        forcePath: true,
      },
    ));
  }
  let interpreterEntrypointBound = false;
  let interpreterOptionValueKindPending = null;
  for (let index = 1; index < command.length; index += 1) {
    const argument = command[index];
    const isInterpreterEntrypoint = directInterpreter
      && !interpreterEntrypointBound
      && !interpreterOptionValueKindPending
      && !String(argument).startsWith("-");
    const binding = interpreterOptionValueKindPending === "scalar"
      ? null
      : governedLocalSmokePayloadBinding(
          profile,
          cwd,
          argument,
          {
            argumentIndex: index,
            origin: isInterpreterEntrypoint ? "interpreter-entrypoint" : "argument-path",
            forcePath: isInterpreterEntrypoint,
          },
        );
    if (binding) {
      bindings.push(binding);
      if (isInterpreterEntrypoint) interpreterEntrypointBound = true;
    }
    if (interpreterOptionValueKindPending) {
      interpreterOptionValueKindPending = null;
    } else if (directInterpreter) {
      interpreterOptionValueKindPending = localSmokeInterpreterOptionValueKind(
        directRuntimeBase,
        argument,
      );
    }
  }
  return {
    launcherKind: packageManager
      ? "governed-package-script"
      : commandSnapshot.shebang
        ? "governed-artifact-script"
        : directInterpreter
          ? "direct-interpreter"
          : "attested-native-executable",
    payloadBindings: bindings.filter(Boolean),
  };
}

export function validateLocalSmokePayloadBindingsBeforeSpawn(launcher) {
  for (const binding of launcher.payload_bindings || []) {
    const candidate = path.resolve(binding.resolved_path);
    const governedWritePath = path.resolve(binding.governed_write_path);
    const realPathsExist = fs.existsSync(candidate) && fs.existsSync(governedWritePath);
    const containedLexically = isInsidePath(governedWritePath, candidate);
    const containedByIdentity = realPathsExist && isInsidePath(
      fs.realpathSync.native(governedWritePath),
      fs.realpathSync.native(candidate),
    );
    if (
      binding.binding !== "artifact-manifest-bound"
      || (!containedLexically && !containedByIdentity)
      || !fs.existsSync(candidate)
      || fs.lstatSync(candidate).isSymbolicLink()
      || (!fs.lstatSync(candidate).isFile() && !fs.lstatSync(candidate).isDirectory())
      || !fs.existsSync(governedWritePath)
      || !containedByIdentity
    ) {
      fail(
        `Authorized local smoke payload is no longer a real path inside the released artifact: `
        + `${binding.resolved_path}. Request a fresh release checkpoint after correcting it.`,
      );
    }
  }
}

export function localSmokeSandboxPolicyAttestation(profile) {
  const cwd = governedLocalSmokeCwd(profile).smokeCwd;
  const pluginIdentity = inspectBuildIdentity(PLUGIN_ROOT);
  const launchers = (profile.local_release_target.smoke_tests || []).map((canonicalCommand) => {
    const command = JSON.parse(canonicalCommand);
    const resolvedCommand = resolveLocalSmokeExecutable(command, cwd);
    const runtime = localSmokeRuntimeDescriptor(resolvedCommand, command, cwd);
    const payload = localSmokePayloadBindings(
      profile,
      command,
      resolvedCommand,
      runtime,
      cwd,
    );
    const sandbox = localSmokeSandboxCommand(
      cwd,
      runtime.execution_argv,
    );
    const wrapperExecutable = fs.realpathSync.native(sandbox.executable);
    const wrapperSnapshot = stableLocalSmokeExecutableSnapshot(wrapperExecutable);
    const launcherSubject = {
      command,
      sandbox: sandbox.kind,
      wrapper_executable: wrapperExecutable,
      wrapper_executable_sha256: wrapperSnapshot.sha256,
      wrapper_args: sandbox.args,
      wrapper_args_sha256: computeStableHash(sandbox.args),
      environment: sandbox.env,
      environment_sha256: computeStableHash(sandbox.env),
      command_executable: runtime.command_executable,
      command_executable_sha256: runtime.command_executable_sha256,
      runtime_executable: runtime.runtime_executable,
      runtime_executable_sha256: runtime.runtime_executable_sha256,
      interpreter: runtime.interpreter,
      launcher_kind: payload.launcherKind,
      payload_bindings: payload.payloadBindings,
      hash_algorithm: "sha256:stable-json:v1",
    };
    return {
      ...launcherSubject,
      launcher_hash: computeStableHash(launcherSubject),
    };
  });
  const subject = {
    schema_version: "local-smoke-sandbox-policy:v2",
    host: {
      platform: process.platform,
      arch: process.arch,
    },
    plugin_build: {
      package_version: pluginIdentity.package_version,
      build_fingerprint: pluginIdentity.build_fingerprint,
      git_commit: pluginIdentity.git_commit || null,
      provenance: pluginIdentity.provenance || null,
    },
    boundary: localSmokeExecutionBoundary(),
    smoke_cwd: cwd,
    launchers,
    hash_algorithm: "sha256:stable-json:v1",
  };
  return {
    ...subject,
    policy_hash: computeStableHash(subject),
  };
}

export function localReleaseArtifactManifest(context, profile) {
  const policy = localReleaseArtifactManifestPolicy(context, profile);
  approvedLocalSmokeCwd(profile);
  const snapshotSetOnce = () => ({
    root_identity: workflowFinalFreshnessLocalRootIdentity(policy.root_path),
    paths: policy.allowed_write_paths
      .map((targetPath) => workflowFinalFreshnessLocalPathSnapshot(targetPath)),
  });
  const firstSnapshot = snapshotSetOnce();
  const secondSnapshot = snapshotSetOnce();
  if (stableJson(firstSnapshot) !== stableJson(secondSnapshot)) {
    fail("Local release artifact set changed while being snapshotted.");
  }
  const subject = {
    schema_version: "local-release-artifact-manifest:v1",
    policy,
    ...firstSnapshot,
    hash_algorithm: "sha256:stable-json:v1",
  };
  return {
    ...subject,
    manifest_hash: computeStableHash(subject),
  };
}

// Write paths that hold a declared reversible data file are governed by the
// data.migrate/data.rollback receipts and stay outside the build content
// binding; every other approved write path is the built artifact.
export function localReleaseTargetContentPaths(profile) {
  const migration = profile.local_release_target?.data_migration;
  const dataPaths = [migration?.target_path, migration?.backup?.path]
    .filter(Boolean)
    .map((item) => path.resolve(String(item)));
  return (profile.local_release_target?.allowed_write_paths || [])
    .map((item) => path.resolve(String(item)))
    .sort()
    .filter((writePath) => !dataPaths.some((dataPath) => isInsidePath(writePath, dataPath)));
}

export function localReleaseTargetContentManifest(context, profile) {
  const contentPaths = localReleaseTargetContentPaths(profile);
  const snapshotOnce = () => contentPaths
    .map((targetPath) => workflowFinalFreshnessLocalPathSnapshot(targetPath));
  const first = snapshotOnce();
  const second = snapshotOnce();
  if (stableJson(first) !== stableJson(second)) {
    fail("Local release target content changed while being snapshotted; retry after the copy settles.");
  }
  const subject = {
    schema_version: "local-release-target-content:v1",
    paths: first,
    hash_algorithm: "sha256:stable-json:v1",
  };
  return {
    ...subject,
    manifest_hash: computeStableHash(subject),
  };
}

export function localReleaseTargetContentManifestErrors(profile, manifest) {
  if (!hashBoundRecordIsValid(manifest, "manifest_hash")) {
    return ["build.local content manifest integrity is invalid"];
  }
  const errors = [];
  if (
    manifest.schema_version !== "local-release-target-content:v1"
    || manifest.hash_algorithm !== "sha256:stable-json:v1"
    || !Array.isArray(manifest.paths)
  ) {
    errors.push("build.local content manifest uses an unsupported format");
  } else if (
    stableJson(manifest.paths.map((entry) => entry?.path))
      !== stableJson(localReleaseTargetContentPaths(profile))
  ) {
    errors.push("build.local content manifest does not cover the exact approved write paths");
  }
  return errors;
}

export function localReleaseTargetContentDifferences(recorded, current) {
  const currentByPath = new Map((current?.paths || []).map((entry) => [entry.path, entry]));
  return (recorded?.paths || [])
    .filter((entry) => stableJson(entry) !== stableJson(currentByPath.get(entry.path)))
    .map((entry) => entry.path);
}

export function localReleaseIntegrityAttestation(context, profile) {
  const subject = {
    schema_version: "local-release-integrity:v2",
    smoke_execution_policy: localSmokeSandboxPolicyAttestation(profile),
    artifact_manifest_policy: localReleaseArtifactManifestPolicy(context, profile),
    hash_algorithm: "sha256:stable-json:v1",
  };
  return {
    ...subject,
    integrity_hash: computeStableHash(subject),
  };
}

// The current released artifact still is the smoke-tested one, or every target
// that differs carries exactly the snapshot a later, currently valid lifecycle
// certification recorded. Policy and root identity never change.
export function localReleaseArtifactMatchesCompletion(
  currentManifest,
  completedManifest,
  supersededLocalReleasePaths = null,
) {
  if (stableJson(currentManifest) === stableJson(completedManifest)) return true;
  if (!supersededLocalReleasePaths || supersededLocalReleasePaths.size === 0) return false;
  const {
    paths: currentPaths,
    manifest_hash: ignoredCurrentHash,
    ...currentRest
  } = currentManifest || {};
  const {
    paths: completedPaths,
    manifest_hash: ignoredCompletedHash,
    ...completedRest
  } = completedManifest || {};
  return stableJson(currentRest) === stableJson(completedRest)
    && Array.isArray(currentPaths)
    && Array.isArray(completedPaths)
    && currentPaths.length === completedPaths.length
    && currentPaths.every((entry, index) =>
      entry?.path === completedPaths[index]?.path
      && (
        stableJson(entry) === stableJson(completedPaths[index])
        || workflowFinalLocalReleasePathSuperseded(supersededLocalReleasePaths, entry)
      ));
}

export function localReleaseCompletionIntegrityErrors(context, profile, receipt, authorization, {
  revalidateArtifact = false,
  supersededLocalReleasePaths = null,
  attempt = null,
} = {}) {
  const errors = [];
  const authorized = authorization?.action_details?.local_release_integrity;
  const completion = receipt?.local_release_verification?.integrity;
  if (!authorized) {
    const legacy = authorization?.schema_version !== "delivery-action-receipt:v3"
      && receipt?.schema_version !== "delivery-action-receipt:v3";
    if (legacy) return { errors, legacy: true };
    errors.push("current release authorization is missing its required local-release integrity policy");
    return { errors, legacy: false };
  }
  if (!completion) {
    errors.push("completion is missing the required smoke-bound artifact integrity proof");
    return { errors, legacy: false };
  }
  if (
    authorized.schema_version !== "local-release-integrity:v2"
    || authorized.smoke_execution_policy?.schema_version !== "local-smoke-sandbox-policy:v2"
    || !hashBoundRecordIsValid(authorized, "integrity_hash")
    || !hashBoundRecordIsValid(authorized.smoke_execution_policy, "policy_hash")
    || !hashBoundRecordIsValid(authorized.artifact_manifest_policy, "policy_hash")
  ) {
    errors.push("authorized local-release integrity policy is invalid");
  }
  if (stableJson(completion.authorized_policy) !== stableJson(authorized)) {
    errors.push("completion does not bind the exact authorized smoke and artifact policy");
  }
  if (completion.schema_version !== "local-release-completion-integrity:v2") {
    errors.push("completion uses an unsupported local-release integrity proof version");
  }
  const verification = receipt.local_release_verification;
  const authorizedLaunchers = authorized.smoke_execution_policy?.launchers || [];
  const smokeReceipts = verification?.smoke_test_receipts || [];
  if (
    verification?.target_root !== profile.local_release_target?.root_path
    || stableJson(verification?.allowed_write_paths)
      !== stableJson(profile.local_release_target?.allowed_write_paths)
    || verification?.smoke_cwd !== authorized.smoke_execution_policy?.smoke_cwd
    || stableJson(verification?.smoke_tests)
      !== stableJson(profile.local_release_target?.smoke_tests)
    || smokeReceipts.length !== authorizedLaunchers.length
  ) {
    errors.push("completion does not prove the exact authorized local target and smoke-test set");
  }
  let priorFinishedAt = null;
  const attemptStartedAt = Date.parse(attempt?.started_at || "");
  for (let index = 0; index < smokeReceipts.length; index += 1) {
    const smoke = smokeReceipts[index];
    const launcher = authorizedLaunchers[index];
    const startedAt = Date.parse(smoke?.started_at || "");
    const finishedAt = Date.parse(smoke?.finished_at || "");
    const derivedPassed = smoke?.exit_code === 0
      && smoke?.error_code === null
      && smoke?.signal === null;
    if (
      !launcher
      || stableJson(smoke?.command) !== stableJson(launcher.command)
      || smoke?.cwd !== authorized.smoke_execution_policy?.smoke_cwd
      || smoke?.sandbox !== launcher.sandbox
      || !Number.isFinite(startedAt)
      || !Number.isFinite(finishedAt)
      || finishedAt < startedAt
      || (Number.isFinite(attemptStartedAt) && startedAt < attemptStartedAt)
      || (priorFinishedAt !== null && startedAt < priorFinishedAt)
      || (smoke?.outcome === "passed") !== derivedPassed
    ) {
      errors.push(`smoke receipt ${index + 1} is not an ordered result of its exact authorized launcher`);
    }
    priorFinishedAt = Number.isFinite(finishedAt) ? finishedAt : priorFinishedAt;
  }
  if (!attempt) {
    errors.push("completion does not reference its durable write-ahead local release attempt");
  } else {
    errors.push(...localReleaseAttemptReceiptErrors(
      context,
      profile,
      attempt,
      authorization,
    ));
    if (
      stableJson(receipt.attempt_receipt_ref)
        !== stableJson(deliveryActionAttemptReceiptRef(context, profile, attempt))
    ) {
      errors.push("completion does not bind the exact write-ahead attempt receipt");
    }
    if (
      stableJson(attempt.artifact_before_smoke)
        !== stableJson(completion.pre_smoke_artifact_manifest)
    ) {
      errors.push("completion pre-smoke manifest differs from its write-ahead attempt");
    }
    if (
      stableJson(completionRequestExecutionProjection(attempt.completion_request))
        !== stableJson(completionRequestExecutionProjection(receipt.completion_request))
    ) {
      errors.push("completion operation or evidence differs from its write-ahead attempt");
    }
    if (
      receipt.outcome === "passed"
      && stableJson(attempt.completion_request) !== stableJson(receipt.completion_request)
    ) {
      errors.push("passing completion request differs from its requested write-ahead operation");
    }
  }
  const preManifest = completion.pre_smoke_artifact_manifest;
  const postManifest = completion.post_smoke_artifact_manifest;
  if (
    !hashBoundRecordIsValid(preManifest, "manifest_hash")
    || stableJson(preManifest?.policy) !== stableJson(authorized.artifact_manifest_policy)
  ) {
    errors.push("pre-smoke artifact manifest is invalid or uses another policy");
  }
  if (postManifest && (
    !hashBoundRecordIsValid(postManifest, "manifest_hash")
    || stableJson(postManifest.policy) !== stableJson(authorized.artifact_manifest_policy)
  )) {
    errors.push("post-smoke artifact manifest is invalid or uses another policy");
  }
  if (receipt.outcome === "passed") {
    if (
      completion.artifact_stable_during_smoke !== true
      || !postManifest
      || stableJson(preManifest) !== stableJson(postManifest)
    ) {
      errors.push("passing release does not prove one unchanged artifact before and after smoke");
    }
    if (receipt.local_release_verification?.outcome !== "passed") {
      errors.push("passing release verification has a non-passing outcome");
    }
    if (revalidateArtifact && postManifest) {
      try {
        const currentManifest = localReleaseArtifactManifest(context, profile);
        if (!localReleaseArtifactMatchesCompletion(
          currentManifest,
          postManifest,
          supersededLocalReleasePaths,
        )) {
          errors.push("released artifact changed after its smoke-tested completion");
        }
      } catch {
        errors.push("released artifact can no longer be snapshotted safely");
      }
    }
  } else if (receipt.outcome === "failed") {
    const failedSmoke = (receipt.local_release_verification?.smoke_test_receipts || [])
      .some((item) => item.outcome !== "passed" || item.exit_code !== 0);
    if (
      receipt.local_release_verification?.outcome !== "failed"
      || (!failedSmoke && completion.artifact_stable_during_smoke !== false)
    ) {
      errors.push("failed release attempt does not prove a smoke or artifact-stability failure");
    }
  }
  return { errors, legacy: false };
}

export function localSmokeSandboxCommand(cwd, argv) {
  const governedPathEntries = [
    path.dirname(path.resolve(argv[0])),
    ...(process.platform === "win32"
      ? []
      : ["/usr/bin", "/bin"]),
  ].filter((entry, index, values) => values.indexOf(entry) === index);
  const minimalEnv = Object.fromEntries([
    ["PATH", governedPathEntries.join(path.delimiter)],
    ["TMPDIR", process.env.TMPDIR || os.tmpdir()],
    ["SYSTEMROOT", process.env.SYSTEMROOT],
    ["WINDIR", process.env.WINDIR],
  ].filter(([, value]) => Boolean(value)));
  if (process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec")) {
    const profile = "(version 1) (deny default) (allow process*) (allow file-read*) (allow sysctl-read) (allow mach-lookup)";
    return {
      kind: "macos-sandbox-exec-readonly-no-network",
      executable: "/usr/bin/sandbox-exec",
      args: ["-p", profile, argv[0], ...argv.slice(1)],
      env: minimalEnv,
    };
  }
  if (process.platform === "linux" && fs.existsSync("/usr/bin/bwrap")) {
    return {
      kind: "linux-bwrap-readonly-no-network",
      executable: "/usr/bin/bwrap",
      args: [
        "--unshare-net",
        "--ro-bind", "/", "/",
        "--dev", "/dev",
        "--proc", "/proc",
        "--chdir", cwd,
        "--", argv[0], ...argv.slice(1),
      ],
      env: minimalEnv,
    };
  }
  fail("Local smoke-test execution requires a configured read-only, no-network sandbox on this host.");
}

export function inspectLocalReleaseTargetEntry(rawPath) {
  const entryPath = path.resolve(String(rawPath || ""));
  if (!pathEntryExistsNoFollow(entryPath)) {
    return { path: entryPath, status: "absent" };
  }
  const entryLstat = fs.lstatSync(entryPath);
  if (entryLstat.isSymbolicLink()) {
    fail(`Governed local target entry cannot be a symlink: ${entryPath}.`);
  }
  if (!entryLstat.isDirectory()) {
    fail(`Governed local target entry must be a directory: ${entryPath}.`);
  }
  const realPath = fs.realpathSync.native(entryPath);
  const entryStat = fs.statSync(realPath);
  return {
    path: entryPath,
    status: "directory",
    real_path: realPath,
    device: String(entryStat.dev),
    inode: String(entryStat.ino),
  };
}

export function buildLocalReleaseTargetSnapshot(
  context,
  profile,
  purpose,
  observedAt,
) {
  validateLocalReleaseFilesystemBoundary(profile.local_release_target, {
    requireExistingRoot: false,
  });
  const snapshotBase = {
    schema_version: "local-release-target-snapshot:v1",
    purpose,
    profile_ref: {
      id: profile.id,
      hash: profile.profile_hash,
    },
    workspace_real_path: fs.realpathSync.native(context.root),
    target_root: path.resolve(profile.local_release_target.root_path),
    allowed_write_paths: profile.local_release_target.allowed_write_paths
      .map((item) => path.resolve(item)),
    entries: localReleaseTargetEntryPaths(profile)
      .map((entryPath) => inspectLocalReleaseTargetEntry(entryPath)),
    observed_at: observedAt,
  };
  return {
    ...snapshotBase,
    snapshot_hash: hashApprovalSubject(snapshotBase),
    hash_algorithm: "sha256:stable-json:v1",
  };
}

export function localReleaseTargetSnapshotErrors(context, profile, snapshot, {
  purpose = null,
  requireCurrentWorkspace = false,
} = {}) {
  const errors = [];
  if (
    !snapshot
    || typeof snapshot !== "object"
    || Array.isArray(snapshot)
  ) {
    return ["local target snapshot is missing or invalid"];
  }
  const {
    snapshot_hash: storedHash,
    hash_algorithm: hashAlgorithm,
    ...snapshotBase
  } = snapshot;
  const expectedSnapshotKeys = [
    "allowed_write_paths",
    "entries",
    "hash_algorithm",
    "observed_at",
    "profile_ref",
    "purpose",
    "schema_version",
    "snapshot_hash",
    "target_root",
    "workspace_real_path",
  ];
  if (
    stableJson(Object.keys(snapshot).sort())
      !== stableJson(expectedSnapshotKeys)
  ) {
    errors.push("local target snapshot fields are invalid");
  }
  if (
    snapshot.schema_version !== "local-release-target-snapshot:v1"
    || !["task_start", "build_authorization", "build_completion"].includes(snapshot.purpose)
    || hashAlgorithm !== "sha256:stable-json:v1"
    || storedHash !== hashApprovalSubject(snapshotBase)
  ) {
    errors.push("local target snapshot integrity is invalid");
  }
  if (purpose && snapshot.purpose !== purpose) {
    errors.push(`local target snapshot purpose is not ${purpose}`);
  }
  if (
    snapshot.profile_ref?.id !== profile.id
    || !deliveryProfileHashMatches(profile, snapshot.profile_ref?.hash)
    || stableJson(Object.keys(snapshot.profile_ref || {}).sort())
      !== stableJson(["hash", "id"])
  ) {
    errors.push("local target snapshot is bound to another delivery profile");
  }
  const expectedRoot = path.resolve(profile.local_release_target.root_path);
  const expectedWritePaths = profile.local_release_target.allowed_write_paths
    .map((item) => path.resolve(item));
  const expectedPaths = [expectedRoot, ...expectedWritePaths];
  if (
    !path.isAbsolute(snapshot.workspace_real_path || "")
    || !path.isAbsolute(snapshot.target_root || "")
    ||
    snapshot.target_root !== expectedRoot
    || stableJson(snapshot.allowed_write_paths) !== stableJson(expectedWritePaths)
    || stableJson((snapshot.entries || []).map((entry) => entry?.path))
      !== stableJson(expectedPaths)
  ) {
    errors.push("local target snapshot differs from the exact root or approved write paths");
  }
  if (
    !Array.isArray(snapshot.entries)
    || snapshot.entries.some((entry) => (
      !entry
      || typeof entry !== "object"
      || Array.isArray(entry)
      || !["absent", "directory"].includes(entry.status)
      || (
        entry.status === "absent"
        && Object.keys(entry).sort().join("\u0000") !== ["path", "status"].sort().join("\u0000")
      )
      || (
        entry.status === "directory"
        && (
          !entry.real_path
          || typeof entry.device !== "string"
          || typeof entry.inode !== "string"
          || Object.keys(entry).sort().join("\u0000")
            !== ["device", "inode", "path", "real_path", "status"].sort().join("\u0000")
        )
      )
    ))
  ) {
    errors.push("local target snapshot entries are invalid");
  }
  if (!Number.isFinite(Date.parse(snapshot.observed_at || ""))) {
    errors.push("local target snapshot observation time is invalid");
  }
  if (requireCurrentWorkspace) {
    const currentWorkspace = fs.realpathSync.native(context.root);
    if (snapshot.workspace_real_path !== currentWorkspace) {
      errors.push("local target snapshot belongs to a different workspace location");
    }
  }
  return errors;
}

export function validateLocalReleaseFilesystemBoundary(target, options = {}) {
  const rootPath = path.resolve(String(target?.root_path || ""));
  const requireExistingRoot = options.requireExistingRoot !== false;
  if (!target?.root_path) {
    fail("Local release target root is missing.");
  }
  if (requireExistingRoot && (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory())) {
    const buildCreationGuidance = (target.allowed_actions || []).includes("build.local")
      ? (
          "For a new target, first request build.local without --confirm-action. If it reports "
          + "checkpoint_required, show that decision and repeat with direct approval. Only while "
          + "executing the resulting exact authorized build may the external builder create "
          + "the exact target root and its "
          + "approved child paths. Complete build.local with immutable evidence before "
          + "authorizing rollback.verify, data.migrate, data.rollback, or release.local."
        )
      : (
          "This delivery does not allow build.local. Do not create the target outside governance; "
          + "propose and approve a new one-time delivery profile that includes build.local, then "
          + "use that exact authorized build to create the approved root and complete it with evidence."
        );
    fail(
      `Local release target root must exist before this protected action: ${target.root_path}. `
      + `It may be absent while planning. ${buildCreationGuidance} `
      + "The CLI does not create directories, and an ungoverned mkdir is not a repair.",
    );
  }
  if (fs.existsSync(rootPath) && !fs.statSync(rootPath).isDirectory()) {
    fail(`Local release target root must be a directory: ${rootPath}.`);
  }
  const boundaryRoot = fs.existsSync(rootPath) ? rootPath : nearestExistingParent(rootPath);
  assertNoSymlinkPathSegments(rootPath, boundaryRoot);
  if (fs.existsSync(rootPath) && fs.lstatSync(rootPath).isSymbolicLink()) {
    fail(`Local release target root cannot be a symlink: ${rootPath}.`);
  }
  const realRoot = plannedRealPath(rootPath);
  for (const rawWritePath of target.allowed_write_paths || []) {
    const writePath = path.resolve(String(rawWritePath));
    const relative = path.relative(rootPath, writePath);
    if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      fail(
        `Local release write path must be a strict child of root_path ${rootPath}: ${writePath}. `
        + "Use the stable parent as --target-root and the releasable folder below it as --write-path.",
      );
    }
    assertNoSymlinkPathSegments(writePath, boundaryRoot);
    if (pathEntryExistsNoFollow(writePath) && fs.lstatSync(writePath).isSymbolicLink()) {
      fail(`Local release write path cannot be a symlink: ${writePath}.`);
    }
    const existingBoundary = fs.existsSync(writePath) ? writePath : nearestExistingParent(writePath);
    const realBoundary = fs.realpathSync.native(existingBoundary);
    if (
      fs.existsSync(rootPath)
      && !isInsidePath(realRoot, realBoundary)
    ) {
      fail(`Local release write path resolves outside target root: ${writePath}.`);
    }
  }
  if (target.smoke_cwd !== undefined && target.smoke_cwd !== null) {
    const smokeCwd = path.resolve(String(target.smoke_cwd));
    const containingWritePath = (target.allowed_write_paths || [])
      .map((item) => path.resolve(String(item)))
      .find((writePath) => isInsidePath(writePath, smokeCwd));
    if (!containingWritePath) {
      fail("Local release smoke working directory must stay inside one approved write path.");
    }
    assertNoSymlinkPathSegments(smokeCwd, boundaryRoot);
    if (pathEntryExistsNoFollow(smokeCwd) && fs.lstatSync(smokeCwd).isSymbolicLink()) {
      fail(`Local release smoke working directory cannot be a symlink: ${smokeCwd}.`);
    }
    if (fs.existsSync(smokeCwd) && !fs.statSync(smokeCwd).isDirectory()) {
      fail(`Local release smoke working directory must be a directory: ${smokeCwd}.`);
    }
    if (fs.existsSync(smokeCwd) && fs.existsSync(containingWritePath)) {
      const realWritePath = fs.realpathSync.native(containingWritePath);
      const realSmokeCwd = fs.realpathSync.native(smokeCwd);
      if (!isInsidePath(realWritePath, realSmokeCwd)) {
        fail(`Local release smoke working directory resolves outside its approved write path: ${smokeCwd}.`);
      }
    }
  }
}

export function localReleaseGlobalRoots(platform = process.platform) {
  return platform === "win32"
    ? [process.env.ProgramFiles, process.env.ProgramData]
        .filter(Boolean)
        .map((item) => path.resolve(item))
        .sort()
    : ["/Applications", "/Library", "/usr", "/opt"].map((item) => path.resolve(item)).sort();
}

export function localReleaseBoundarySource(context, target) {
  validateLocalReleaseFilesystemBoundary(target, { requireExistingRoot: false });
  const realWorkspace = fs.realpathSync.native(context.root);
  const realTarget = plannedRealPath(target.root_path);
  const policy = context.config.autonomy_policy?.local_release || {};
  const globalRoots = localReleaseGlobalRoots();
  return {
    schema_version: "delivery-local-boundary-source:v1",
    target_hash: hashApprovalSubject(target),
    platform: process.platform,
    workspace_real_path: realWorkspace,
    target_real_path: realTarget,
    global_roots: globalRoots,
    target_outside_workspace: !isInsidePath(realWorkspace, realTarget),
    target_machine_global: globalRoots.some((rootPath) => isInsidePath(rootPath, realTarget)),
    writes_outside_workspace_require_checkpoint:
      policy.writes_outside_workspace_require_checkpoint !== false,
    machine_global_changes_require_checkpoint:
      policy.machine_global_changes_require_checkpoint !== false,
  };
}

export function localReleaseBoundaryRequiresCheckpoint(context, target) {
  return localReleaseBoundaryCheckpointFromSource(localReleaseBoundarySource(context, target));
}

export function proposeDeliveryAutonomy(context, options) {
  ensureInitialized(context);
  const storyOption = getOptionString(options, "story");
  if (storyOption) assertStoryOpenForWork(context, normalizeId(storyOption), "autonomy delivery propose");
  const profileId = normalizeId(requireOption(options, "id"));
  const deliveryId = normalizeId(requireOption(options, "delivery"));
  const kind = String(requireOption(options, "kind"));
  if (!["pull_request", "local_release"].includes(kind)) {
    fail("Delivery autonomy --kind must be pull_request or local_release.");
  }
  const target = deliveryTargetFromOptions(context, kind, options);
  const concreteIdentity = deliveryConcreteIdentity(kind, target);
  const lockPaths = [
    path.join(autonomyExecutionsRoot(context), `.delivery-${shortHash(`${kind}:${deliveryId}`)}.lock`),
    path.join(autonomyExecutionsRoot(context), `.target-${shortHash(stableJson(concreteIdentity))}.lock`),
    `${deliveryAutonomyPath(context, profileId)}.lock`,
  ].sort();
  const releaseLocks = [];
  try {
    for (const lockPath of lockPaths) releaseLocks.push(acquireFileLock(lockPath));
    return proposeDeliveryAutonomyLocked(context, options, profileId, deliveryId, kind, target, concreteIdentity);
  } finally {
    for (const release of releaseLocks.reverse()) release();
  }
}

export function effectiveDeliveryProfileStatus(context, profile) {
  const revocation = safeReadDir(autonomyRevocationsRoot(context))
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({
      path: path.join(autonomyRevocationsRoot(context), name),
      record: readProjectJson(context, path.join(autonomyRevocationsRoot(context), name)),
    }))
    .filter(({ record }) => record.profile_ref?.id === profile.id && deliveryProfileHashMatches(profile, record.profile_ref?.hash))
    .map(({ path: recordPath }) => ({ path: recordPath, record: readAutonomyProfileRevocation(context, recordPath) }))
    .sort((left, right) => String(left.record.created_at).localeCompare(String(right.record.created_at)))
    .at(-1);
  return revocation
    ? { status: "revoked", revocation: revocation.record, revocation_path: revocation.path }
    : { status: profile.status, revocation: null, revocation_path: null };
}

// Receipts already read and verified in this process, keyed by path and
// schema and reused while the file keeps the same size, mtime, and inode.
// Gates and reports read every action receipt once per delivery profile.
const verifiedLifecycleReceipts = new Map();

function lifecycleReceiptSignature(filePath) {
  try {
    const stat = fs.statSync(filePath, { bigint: true });
    return stat.isFile() ? `${stat.size}:${stat.mtimeNs}:${stat.ino}` : null;
  } catch {
    return null;
  }
}

export function readDeliveryLifecycleReceipt(context, filePath, schemaName, options = {}) {
  if (!fs.existsSync(filePath)) {
    if (options.missingOk) return null;
    fail(`Delivery lifecycle receipt does not exist: ${toProjectPath(context, filePath)}.`);
  }
  const cacheKey = `${schemaName}\u0000${context.root}\u0000${path.resolve(filePath)}`;
  const signature = lifecycleReceiptSignature(filePath);
  const cached = signature ? verifiedLifecycleReceipts.get(cacheKey) : null;
  if (cached && cached.signature === signature) return structuredClone(cached.record);
  const record = readProjectJson(context, filePath);
  assertRecordSchema(record, schemaName, `Delivery lifecycle receipt ${toProjectPath(context, filePath)}`);
  if (record.receipt_hash !== autonomyLifecycleReceiptHash(record)) {
    fail(`Delivery lifecycle receipt hash is stale: ${toProjectPath(context, filePath)}.`);
  }
  if (signature && signature === lifecycleReceiptSignature(filePath)) {
    verifiedLifecycleReceipts.set(cacheKey, { signature, record: structuredClone(record) });
  }
  return record;
}

export function currentDeliveryExecutionState(context, profile) {
  const startPath = deliveryStartReceiptPath(context, profile.id);
  const closePath = deliveryCloseReceiptPath(context, profile.id);
  const start = readDeliveryLifecycleReceipt(
    context,
    startPath,
    "delivery-start-receipt.schema.json",
    { missingOk: true },
  );
  const close = readDeliveryLifecycleReceipt(
    context,
    closePath,
    "delivery-close-receipt.schema.json",
    { missingOk: true },
  );
  if (start && (
    start.profile_ref?.id !== profile.id
    || !deliveryProfileHashMatches(profile, start.profile_ref?.hash)
    || start.delivery?.id !== profile.delivery_id
    || start.delivery?.kind !== profile.delivery_kind
  )) {
    fail(`Delivery start receipt for ${profile.id} does not match the current exact profile.`);
  }
  if (close && (
    !start
    || close.profile_ref?.id !== profile.id
    || !deliveryProfileHashMatches(profile, close.profile_ref?.hash)
    || close.start_receipt_ref?.hash !== start?.receipt_hash
  )) {
    fail(`Delivery close receipt for ${profile.id} does not match its immutable start receipt.`);
  }
  return {
    delivery_id: profile.delivery_id,
    status: close?.terminal_status || (start ? "started" : "open"),
    lifecycle_status: close ? "terminal" : start ? "started" : "available",
    active_run_count: start && !close ? 1 : 0,
    start_receipt: start,
    close_receipt: close,
    start_receipt_path: start ? toProjectPath(context, startPath) : null,
    close_receipt_path: close ? toProjectPath(context, closePath) : null,
  };
}

export function currentDeliveryAutonomyInputs(context, profile, options = {}) {
  const storyRef = profile.story_refs[0];
  const story = readStory(context, storyRef.id);
  if (!story) fail(`Delivery profile ${profile.id} references missing story ${storyRef.id}.`);
  const contractRef = profile.contract_refs[0];
  const contract = readContractById(context, contractRef.id);
  if (contract.delivery_execution_profile_id !== profile.id) {
    fail(`Contract ${contract.id} is not bound to delivery profile ${profile.id}.`);
  }
  const contractFreshnessGaps = collectContractDependencyFreshnessGaps(context, contract);
  if (contractFreshnessGaps.length > 0) {
    fail(
      `Contract ${contract.id} execution context is not current: `
      + contractFreshnessGaps.map((gap) => gap.summary).join("; "),
    );
  }
  const executionContext = {
    storyId: story.id,
    contractId: contract.id,
    profileId: profile.id,
  };
  const requirementProfiles = profile.requirement_profile_refs.map((ref) => {
    const current = readRequirementAutonomyProfile(context, ref.id);
    if (current.profile_hash !== ref.hash) {
      fail(`Delivery profile ${profile.id} has a stale requirement profile reference ${ref.id}.`);
    }
    validateAutonomyApprovalRef(context, current, `Requirement autonomy profile ${ref.id}`);
    return current;
  });
  const currentRequirements = requirementProfiles.map((requirementProfile) => {
    const requirement = requirementByAutonomyProfileId(context, requirementProfile.id);
    assertRequirementReadyForDownstream(
      context,
      requirement,
      `Requirement for profile ${requirementProfile.id}`,
      { executionContext },
    );
    return {
      id: requirement.id,
      version: requirement.revision,
      hash: requirementContentHash(requirement),
      material_scope: requirementMaterialScope(requirement, {
        environment: requirementProfile.constraints.allowed_environments,
        "write-path": requirementProfile.constraints.allowed_write_paths,
        capability: requirementProfile.constraints.allowed_capabilities,
        tool: requirementProfile.constraints.allowed_tools,
      }),
    };
  });
  const target = {
    pull_request_target: profile.pull_request_target,
    local_release_target: profile.local_release_target,
  };
  if (profile.delivery_kind === "local_release") {
    validateLocalReleaseFilesystemBoundary(profile.local_release_target, {
      requireExistingRoot: options.validateRuntimeTarget === true,
    });
  } else if (options.validateRuntimeTarget === true) {
    validatePullRequestGitBoundary(context, profile.pull_request_target);
  }
  const currentScope = deliveryMaterialScope({
    profileId: profile.id,
    deliveryId: profile.delivery_id,
    deliveryKind: profile.delivery_kind,
    requirementProfiles,
    story,
    contract,
    target,
    constraints: profile.constraints,
  });
  return {
    requirementProfiles,
    currentRequirements,
    story,
    contract,
    currentScope,
    currentStoryRefs: [{ id: story.id, hash: hashApprovalSubject(story) }],
    currentContractRefs: [{ id: contract.id, hash: hashApprovalSubject(contract) }],
  };
}

export function evaluateDeliveryAutonomy(context, profile, options = {}) {
  const effectiveStatus = effectiveDeliveryProfileStatus(context, profile);
  if (effectiveStatus.status === "revoked" && options.allowHistorical !== true) {
    fail(`Delivery autonomy profile ${profile.id} is revoked.`);
  }
  if (profile.status !== "active") {
    fail(`Delivery autonomy profile ${profile.id} is '${profile.status}', expected active.`);
  }
  validateAutonomyApprovalRef(context, profile, `Delivery autonomy profile ${profile.id}`, {
    futureAuthority: options.futureAuthority === true,
  });
  const current = currentDeliveryAutonomyInputs(context, profile, options);
  const executionState = currentDeliveryExecutionState(context, profile);
  const evaluatedDeliveryState = options.deliveryStateOverride || {
    delivery_id: executionState.delivery_id,
    status: executionState.status,
    active_run_count: executionState.active_run_count + (options.forStart === true ? 1 : 0),
  };
  const enforcedLevel = deliveryProfileEffectiveLevel(profile);
  const contractLevel = current.contract.autonomy_level || enforcedLevel;
  const capabilityBoundary = deliveryCapabilityBoundary(
    context,
    current.contract,
    enforcedLevel,
  );
  const environmentBoundary = deliveryEnvironmentBoundary(profile);
  const budgetBoundary = deliveryBudgetBoundary(current, enforcedLevel);
  const phase = options.phase || current.story.phase || current.contract.phase;
  if (phase && !configuredPhaseOrder(context).includes(phase)) {
    fail(`Cannot evaluate delivery autonomy for unconfigured phase '${phase}'.`);
  }
  const decision = buildDomainRecord(`Cannot evaluate delivery autonomy ${profile.id}`, () => evaluateAutonomyPolicy({
    id: options.id,
    evaluated_at: options.evaluated_at || now(),
    phase,
    host_policy: { ...profile.authority_assurance, max_level: "bounded-autonomous" },
    project_policy: {
      max_level: context.config.autonomy_policy?.project_max_level || "bounded-autonomous",
      status: context.config.autonomy_policy?.enabled === false ? "disabled" : "active",
    },
    requirement_profiles: current.requirementProfiles,
    current_requirements: current.currentRequirements,
    delivery_profile: profile,
    current_story_refs: current.currentStoryRefs,
    current_contract_refs: current.currentContractRefs,
    current_delivery_scope: current.currentScope,
    delivery_state: evaluatedDeliveryState,
    contract_policy: {
      ...current.contract,
      autonomy_level: contractLevel,
      delivery_profile_ref: { id: profile.id, hash: profile.profile_hash },
    },
    capability_policy: capabilityBoundary,
    environment_policy: environmentBoundary,
    budget_policy: budgetBoundary,
  }));
  const integrity = validateAutonomyDecisionIntegrity(decision);
  if (!integrity.valid) {
    fail(`Autonomy decision ${decision.id} failed integrity validation: ${integrity.errors.join("; ")}`);
  }
  assertRecordSchema(decision, "autonomy-decision.schema.json", `Autonomy decision ${decision.id}`);
  return { decision, current, executionState };
}

export function deliveryCapabilityBoundary(context, contract, requestedLevel) {
  const refs = Array.isArray(contract.capability_recommendation_refs)
    ? contract.capability_recommendation_refs
    : [];
  if (refs.length === 0) {
    return {
      max_level: "checkpointed",
      allowed: true,
      status: "not_verified",
    };
  }
  const executionContext = contractExecutionContext(contract);
  for (const ref of refs) {
    const recommendation = readProjectJson(context, capabilityRecommendationPath(context, ref.id));
    validateApprovedCapabilityRecommendationForUse(
      context,
      recommendation,
      `capability recommendation ${ref.id}`,
      { executionContext },
    );
    const approvedHash = latestApprovedRecordApproval(recommendation)?.approved_content_hash || null;
    if (ref.approved_content_hash && ref.approved_content_hash !== approvedHash) {
      fail(`Capability recommendation ${ref.id} no longer matches contract ${contract.id}.`);
    }
    const unavailable = (recommendation.recommendations || []).filter((item) =>
      !["available"].includes(String(item.availability || "").toLowerCase())
      || (item.install_required && !item.install_approved));
    if (unavailable.length > 0) {
      return {
        max_level: "supervised",
        allowed: false,
        status: "unavailable",
      };
    }
  }
  return {
    max_level: requestedLevel,
    allowed: true,
    status: "approved_evidence",
  };
}

export function approveDeliveryAutonomy(context, options) {
  ensureInitialized(context);
  const profileId = normalizeId(requireOption(options, "id"));
  const profilePath = deliveryAutonomyPath(context, profileId);
  const releaseLock = acquireFileLock(`${profilePath}.lock`);
  try {
    return approveDeliveryAutonomyLocked(context, options, profileId, profilePath);
  } finally {
    releaseLock();
  }
}

export function revokeDeliveryAutonomy(context, options) {
  ensureInitialized(context);
  const profileId = normalizeId(requireOption(options, "id"));
  const reason = requireOption(options, "reason");
  const profilePath = deliveryAutonomyPath(context, profileId);
  const releaseLock = acquireFileLock(`${profilePath}.lock`);
  try {
    return revokeDeliveryAutonomyLocked(context, options, profileId, profilePath, reason);
  } finally {
    releaseLock();
  }
}

export function ensureRevokedDeliveryCloseReceipt(context, profile, revocation) {
  const executionState = currentDeliveryExecutionState(context, profile);
  if (executionState.lifecycle_status === "terminal") {
    return executionState.close_receipt_path;
  }
  if (executionState.lifecycle_status !== "started") {
    return null;
  }
  const closeBase = {
    id: `AUT-CLOSE-${normalizeId(profile.id)}`,
    kind: "delivery_close_receipt",
    schema_version: "delivery-close-receipt:v1",
    profile_ref: {
      id: profile.id,
      path: toProjectPath(context, deliveryAutonomyPath(context, profile.id)),
      hash: profile.profile_hash,
    },
    delivery: { id: profile.delivery_id, kind: profile.delivery_kind },
    start_receipt_ref: {
      id: executionState.start_receipt.id,
      path: executionState.start_receipt_path,
      hash: executionState.start_receipt.receipt_hash,
    },
    terminal_action_receipt_ref: null,
    terminal_status: "revoked",
    reason: revocation.reason,
    approval: revocation.approval,
    closed_by: revocation.approval.approved_by,
    closed_at: now(),
    audit: { git: revocation.audit?.git || {}, run: revocation.audit?.run || {} },
  };
  const closeReceipt = {
    ...closeBase,
    receipt_hash: autonomyLifecycleReceiptHash(closeBase),
    hash_algorithm: "sha256:stable-json:v1",
  };
  assertRecordSchema(closeReceipt, "delivery-close-receipt.schema.json", `Delivery close receipt ${profile.id}`);
  const closePath = deliveryCloseReceiptPath(context, profile.id);
  writeJsonFile(closePath, closeReceipt, { atomicCreate: true });
  return toProjectPath(context, closePath);
}

export function persistDeliveryCheckpointPolicySource(context, preparedSource) {
  ensureDir(deliveryCheckpointPolicySourcesRoot(context));
  const releaseLock = acquireFileLock(`${preparedSource.sourcePath}.lock`);
  try {
    if (fs.existsSync(preparedSource.sourcePath)) {
      const existing = readProjectJson(context, preparedSource.sourcePath);
      const validation = validateDeliveryCheckpointPolicySource(context, existing, preparedSource.ref);
      if (!validation.valid || stableJson(existing) !== stableJson(preparedSource.source)) {
        fail(`Delivery checkpoint policy source ${preparedSource.ref.path} is stale or tampered.`);
      }
      return preparedSource.ref;
    }
    writeJsonFile(preparedSource.sourcePath, preparedSource.source, { atomicCreate: true });
    return preparedSource.ref;
  } finally {
    releaseLock();
  }
}

export function readDeliveryCheckpointPolicySource(context, sourceRef) {
  if (!sourceRef?.path || !sourceRef?.hash || !sourceRef?.effective_config_hash) {
    throw new Error("checkpoint policy source reference is incomplete");
  }
  const sourcePath = resolveProjectFilePath(context, sourceRef.path, { mustExist: true, fileOnly: true });
  const sourcesRoot = path.resolve(deliveryCheckpointPolicySourcesRoot(context));
  const relative = path.relative(sourcesRoot, sourcePath);
  if (
    !relative
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
    || path.dirname(relative) !== "."
    || path.basename(relative, ".json") !== sourceRef.hash
  ) {
    throw new Error("checkpoint policy source reference escapes its content-addressed store");
  }
  const source = readProjectJson(context, sourcePath);
  const validation = validateDeliveryCheckpointPolicySource(context, source, sourceRef);
  if (!validation.valid) {
    throw new Error(validation.errors.join("; "));
  }
  return source;
}

export function deliveryActionCheckpointRequired(context, profile, effectiveLevel, action) {
  const presetCheckpoints = [...new Set(normalizeListValue(
    context.config.autonomy_policy?.presets?.[effectiveLevel]?.checkpoints,
    [],
  ))].sort();
  const profileCheckpoints = [...new Set(profile.checkpoints || [])].sort();
  const checkpoints = new Set([...presetCheckpoints, ...profileCheckpoints]);
  const boundaryActions = deliveryBoundaryCheckpointActions(profile);
  const localBoundarySource = profile.delivery_kind === "local_release"
    ? localReleaseBoundarySource(context, profile.local_release_target)
    : null;
  const localBoundaryCheckpoint = profile.delivery_kind === "local_release"
    && localReleaseBoundaryCheckpointFromSource(localBoundarySource);
  // The person chose automatic merge for this exact profile: the merge needs
  // no confirmation, while code review, CI, and provider checks still apply.
  const automaticMerge = action === "pull_request.merge" && automaticMergeChosen(profile, effectiveLevel);
  return {
    required: effectiveLevel === "supervised"
      || (!automaticMerge && (checkpoints.has(action) || boundaryActions.includes(action)))
      || localBoundaryCheckpoint,
    checkpoints: [...checkpoints].sort(),
    preset_checkpoints: presetCheckpoints,
    profile_checkpoints: profileCheckpoints,
    boundary_actions: boundaryActions,
    local_boundary_checkpoint: localBoundaryCheckpoint,
    local_boundary_source: localBoundarySource,
  };
}

export function validateDeliveryActionCheckpointPolicySnapshot(context, snapshot, profile, effectiveLevel, action) {
  const errors = [];
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return { valid: false, required: null, errors: ["checkpoint policy snapshot is missing"] };
  }
  const { policy_hash: policyHash, ...subject } = snapshot;
  const sortedUnique = (values) => Array.isArray(values)
    && values.every((value) => typeof value === "string" && value.length > 0)
    && stableJson(values) === stableJson([...new Set(values)].sort());
  if (snapshot.schema_version !== "delivery-action-checkpoint-policy:v1") {
    errors.push("checkpoint policy snapshot has an unsupported schema version");
  }
  if (policyHash !== hashApprovalSubject(subject)) {
    errors.push("checkpoint policy snapshot hash is invalid");
  }
  if (
    snapshot.action !== action
    || snapshot.delivery_kind !== profile.delivery_kind
    || snapshot.effective_level !== effectiveLevel
  ) {
    errors.push("checkpoint policy snapshot is bound to a different action boundary");
  }
  if (snapshot.profile_ref?.id !== profile.id || !deliveryProfileHashMatches(profile, snapshot.profile_ref?.hash)) {
    errors.push("checkpoint policy snapshot is bound to a different delivery profile");
  }
  if (
    !sortedUnique(snapshot.preset_checkpoints)
    || !sortedUnique(snapshot.profile_checkpoints)
    || !sortedUnique(snapshot.boundary_actions)
  ) {
    errors.push("checkpoint policy snapshot contains a non-canonical action set");
  }
  const immutableProfileCheckpoints = [...new Set(profile.checkpoints || [])].sort();
  if (stableJson(snapshot.profile_checkpoints) !== stableJson(immutableProfileCheckpoints)) {
    errors.push("checkpoint policy snapshot disagrees with immutable profile checkpoints");
  }
  if (stableJson(snapshot.boundary_actions) !== stableJson(deliveryBoundaryCheckpointActions(profile))) {
    errors.push("checkpoint policy snapshot disagrees with protected boundary actions");
  }
  let policySource = null;
  try {
    policySource = readDeliveryCheckpointPolicySource(context, snapshot.policy_source_ref);
  } catch (error) {
    errors.push(`checkpoint policy snapshot source is invalid: ${error.message}`);
  }
  const sourcePresetCheckpoints = policySource
    ? [...new Set(normalizeListValue(
        policySource.effective_config?.autonomy_policy?.presets?.[effectiveLevel]?.checkpoints,
        [],
      ))].sort()
    : null;
  if (sourcePresetCheckpoints && stableJson(sourcePresetCheckpoints) !== stableJson(snapshot.preset_checkpoints)) {
    errors.push("checkpoint policy snapshot disagrees with its content-addressed preset source");
  }
  if (profile.delivery_kind === "local_release") {
    const localSource = snapshot.local_boundary_source;
    const recordedGlobalRoots = Array.isArray(localSource?.global_roots)
      ? [...new Set(localSource.global_roots)].sort()
      : null;
    const expectedOutsideWorkspace = localSource
      && typeof localSource.workspace_real_path === "string"
      && typeof localSource.target_real_path === "string"
      && typeof localSource.platform === "string"
      ? !recordedPathInside(
          localSource.platform,
          localSource.workspace_real_path,
          localSource.target_real_path,
        )
      : null;
    const expectedMachineGlobal = recordedGlobalRoots && typeof localSource?.target_real_path === "string"
      ? recordedGlobalRoots.some((rootPath) => recordedPathInside(
          localSource.platform,
          rootPath,
          localSource.target_real_path,
        ))
      : null;
    const sourceLocalPolicy = policySource?.effective_config?.autonomy_policy?.local_release || null;
    if (
      !localSource
      || typeof localSource !== "object"
      || Array.isArray(localSource)
      || localSource.schema_version !== "delivery-local-boundary-source:v1"
      || localSource.target_hash !== hashApprovalSubject(profile.local_release_target)
      || !["aix", "darwin", "freebsd", "linux", "openbsd", "sunos", "win32"].includes(localSource.platform)
      || typeof localSource.workspace_real_path !== "string"
      || localSource.workspace_real_path.length === 0
      || typeof localSource.target_real_path !== "string"
      || localSource.target_real_path.length === 0
      || !recordedGlobalRoots
      || stableJson(localSource.global_roots) !== stableJson(recordedGlobalRoots)
      || typeof localSource.target_outside_workspace !== "boolean"
      || localSource.target_outside_workspace !== expectedOutsideWorkspace
      || typeof localSource.target_machine_global !== "boolean"
      || localSource.target_machine_global !== expectedMachineGlobal
      || typeof localSource.writes_outside_workspace_require_checkpoint !== "boolean"
      || typeof localSource.machine_global_changes_require_checkpoint !== "boolean"
      || localSource.writes_outside_workspace_require_checkpoint
        !== (sourceLocalPolicy?.writes_outside_workspace_require_checkpoint !== false)
      || localSource.machine_global_changes_require_checkpoint
        !== (sourceLocalPolicy?.machine_global_changes_require_checkpoint !== false)
      || snapshot.local_boundary_source_hash !== hashApprovalSubject(localSource)
    ) {
      errors.push("checkpoint policy snapshot has an invalid local-boundary source binding");
    } else if (
      snapshot.local_boundary_checkpoint !== localReleaseBoundaryCheckpointFromSource(localSource)
    ) {
      errors.push("checkpoint policy snapshot local-boundary flag is not derived from its recorded source");
    }
  } else if (
    snapshot.local_boundary_checkpoint !== false
    || snapshot.local_boundary_source !== null
    || snapshot.local_boundary_source_hash !== null
  ) {
    errors.push("checkpoint policy snapshot unexpectedly records a local-boundary source");
  }
  if (typeof snapshot.local_boundary_checkpoint !== "boolean" || typeof snapshot.required !== "boolean") {
    errors.push("checkpoint policy snapshot has invalid checkpoint flags");
  }
  const checkpoints = new Set([
    ...(Array.isArray(snapshot.preset_checkpoints) ? snapshot.preset_checkpoints : []),
    ...(Array.isArray(snapshot.profile_checkpoints) ? snapshot.profile_checkpoints : []),
  ]);
  const automaticMerge = action === "pull_request.merge" && automaticMergeChosen(profile, effectiveLevel);
  const expectedRequired = effectiveLevel === "supervised"
    || (!automaticMerge && (
      checkpoints.has(action)
      || (Array.isArray(snapshot.boundary_actions) && snapshot.boundary_actions.includes(action))
    ))
    || snapshot.local_boundary_checkpoint === true;
  if (snapshot.required !== expectedRequired) {
    errors.push("checkpoint policy snapshot does not reproduce its required flag");
  }
  return { valid: errors.length === 0, required: expectedRequired, errors };
}

export function allDeliveryActionReceipts(context) {
  return safeReadDir(autonomyActionsRoot(context))
    .filter((name) => name.endsWith(".json"))
    .map((name) => readDeliveryLifecycleReceipt(
      context,
      path.join(autonomyActionsRoot(context), name),
      "delivery-action-receipt.schema.json",
    ));
}

export function deliveryActionReceipts(context, profileId) {
  return allDeliveryActionReceipts(context)
    .filter((record) => record.profile_ref?.id === profileId);
}

export function deliveryActionAttemptReceipts(context, profileId) {
  return safeReadDir(deliveryActionAttemptsRoot(context, profileId))
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const record = readDeliveryLifecycleReceipt(
        context,
        path.join(deliveryActionAttemptsRoot(context, profileId), name),
        "delivery-action-attempt-receipt.schema.json",
      );
      if (name !== `${normalizeId(record.id)}.json`) {
        fail(`Local release attempt receipt filename is non-canonical: ${name}.`);
      }
      if (record.profile_ref?.id !== profileId) {
        fail(
          `Local release attempt ${record.id} is stored under ${profileId} but references `
          + `${record.profile_ref?.id || "no profile"}.`,
        );
      }
      return record;
    })
    .sort((left, right) => (
      String(left.started_at).localeCompare(String(right.started_at))
      || String(left.id).localeCompare(String(right.id))
    ));
}

export function buildDeliveryActionAuthorizationTraceEvent(
  context,
  profile,
  receipt,
  correlationId = CLI_OPERATION_CONTEXT.correlation_id,
) {
  const storyId = profile.story_refs[0]?.id || null;
  return {
    id: `TR-AUTH-${normalizeId(receipt.id)}`,
    story_id: storyId,
    type: "gate",
    summary: `Authorized ${receipt.action} for exact delivery ${profile.delivery_id}`,
    outcome: "ready",
    actor: receipt.authorized_by,
    requested_by: null,
    authorized_by: null,
    request: null,
    authorization_ref: null,
    action: receipt.action,
    evidence: [
      toProjectPath(
        context,
        path.join(autonomyActionsRoot(context), `${normalizeId(receipt.id)}.json`),
      ),
    ],
    related: [profile.id, profile.delivery_id],
    git: receipt.audit?.git || {},
    run: receipt.audit?.run || {},
    correlation_id: correlationId,
    created_at: receipt.authorized_at,
  };
}

export function ensureDeliveryActionAuthorizationTrace(context, traceEvent) {
  const traceFile = traceEvent.story_id ? `${normalizeId(traceEvent.story_id)}.jsonl` : "project.jsonl";
  const tracePath = path.join(context.sdlcRoot, "traces", traceFile);
  const preparedEvent = prepareGovernedTraceEvent(context, traceEvent);
  const releaseTraceLock = acquireFileLock(`${tracePath}.lock`);
  try {
    assertNoPendingWorkflowTraceTransaction(context, tracePath);
    const snapshot = workflowTraceIntegritySnapshotLocked(context, tracePath);
    if (!snapshot.integrity.valid) {
      fail(
        `Delivery action trace ${traceEvent.id} cannot be recovered because trace integrity failed: `
        + `${snapshot.integrity.errors.map((entry) => entry.code).join(", ") || "invalid trace"}.`,
      );
    }
    const matches = snapshot.records
      .filter((entry) => entry.valid === true && entry.event?.id === preparedEvent.id)
      .map((entry) => entry.event);
    if (matches.length > 1) {
      fail(`Delivery action trace ${traceEvent.id} is duplicated.`);
    }
    if (matches.length === 1) {
      if (!workflowTraceIntentMatches(matches[0], preparedEvent)) {
        fail(`Delivery action trace ${traceEvent.id} has different content.`);
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
      fail(`Delivery action trace ${traceEvent.id} was not committed exactly once.`);
    }
    return { appended: true, event: verifiedEvent };
  } finally {
    releaseTraceLock();
  }
}

export function readDeliveryActionAuthorizationIntent(context, identity, profile) {
  if (!identity || !fs.existsSync(identity.path)) {
    return null;
  }
  const intent = readProjectJson(context, identity.path);
  const {
    intent_hash: storedHash,
    hash_algorithm: hashAlgorithm,
    ...intentBase
  } = intent || {};
  if (
    storedHash !== hashApprovalSubject(intentBase)
    || hashAlgorithm !== "sha256:stable-json:v1"
  ) {
    fail(`Delivery action authorization intent ${identity.id} is stale or tampered.`);
  }
  if (
    intent.kind !== "delivery_action_authorization_intent"
    || intent.schema_version !== "delivery-action-authorization-intent:v1"
    || intent.id !== identity.id
    || intent.transaction_key !== identity.transactionKey
    || intent.request_hash !== identity.requestHash
    || intent.profile_ref?.id !== identity.profileId
    || intent.profile_ref?.hash !== identity.profileHash
    || intent.action !== identity.action
    || intent.profile_ref?.id !== intent.action_receipt?.profile_ref?.id
    || intent.profile_ref?.hash !== intent.action_receipt?.profile_ref?.hash
    || intent.action !== intent.action_receipt?.action
    || intent.authorization_ref?.id !== identity.authorizationId
  ) {
    fail(
      `Delivery action authorization intent ${identity.id} does not match this exact retry. `
      + "Use the original command boundary or create a new delegated authorization.",
    );
  }
  const useReceiptId = deliveryActionIntentUseReceiptId(identity);
  const expectedUsePath = toProjectPath(
    context,
    authorizationUsePath(context, identity.authorizationId, useReceiptId),
  );
  const expectedActionReceiptPath = toProjectPath(
    context,
    path.join(
      autonomyActionsRoot(context),
      `${normalizeId(intent.action_receipt?.id || "missing")}.json`,
    ),
  );
  const expectedTraceEvent = buildDeliveryActionAuthorizationTraceEvent(
    context,
    profile,
    intent.action_receipt,
    intent.trace_event?.correlation_id,
  );
  if (
    intent.authorization_use?.id !== useReceiptId
    || intent.authorization_use?.path !== expectedUsePath
    || intent.authorization_use?.action
      !== `autonomy.delivery.action.${intent.action}`
    || intent.action_receipt?.approval?.approval_source !== "automation"
    || intent.action_receipt?.approval?.authorization_ref !== identity.authorizationId
    || intent.action_receipt?.approval?.authorization_use_ref !== expectedUsePath
    || intent.action_receipt?.status !== "authorized"
    || intent.action_receipt?.outcome !== null
    || intent.action_receipt_path !== expectedActionReceiptPath
    || typeof intent.trace_event?.correlation_id !== "string"
    || intent.trace_event.correlation_id.length === 0
    || stableJson(intent.trace_event) !== stableJson(expectedTraceEvent)
  ) {
    fail(`Delivery action authorization intent ${identity.id} has an invalid use or receipt binding.`);
  }
  const {
    receipt_hash: receiptHash,
    hash_algorithm: receiptHashAlgorithm,
    ...receiptBase
  } = intent.action_receipt;
  if (
    receiptHashAlgorithm !== "sha256:stable-json:v1"
    || receiptHash !== autonomyLifecycleReceiptHash(receiptBase)
  ) {
    fail(`Delivery action authorization intent ${identity.id} contains a stale action receipt.`);
  }
  assertRecordSchema(
    intent.action_receipt,
    "delivery-action-receipt.schema.json",
    `Delivery action authorization intent receipt ${identity.id}`,
  );
  return intent;
}

export function buildDeliveryActionAuthorizationIntent(
  context,
  identity,
  profile,
  action,
  authorization,
  authorizationUse,
  receipt,
  preparedPolicySource,
) {
  const intentBase = {
    id: identity.id,
    kind: "delivery_action_authorization_intent",
    schema_version: "delivery-action-authorization-intent:v1",
    transaction_key: identity.transactionKey,
    request_hash: identity.requestHash,
    profile_ref: {
      id: profile.id,
      path: toProjectPath(context, deliveryAutonomyPath(context, profile.id)),
      hash: profile.profile_hash,
    },
    action,
    authorization_ref: {
      id: authorization.id,
      hash: authorizationRecordHash(authorization),
    },
    authorization_use: {
      id: authorizationUse.id,
      path: authorizationUse.path,
      action: `autonomy.delivery.action.${action}`,
    },
    policy_source_ref: preparedPolicySource.ref,
    action_receipt_path: toProjectPath(
      context,
      path.join(autonomyActionsRoot(context), `${normalizeId(receipt.id)}.json`),
    ),
    action_receipt: receipt,
    trace_event: buildDeliveryActionAuthorizationTraceEvent(context, profile, receipt),
    created_at: receipt.authorized_at,
  };
  return {
    ...intentBase,
    intent_hash: hashApprovalSubject(intentBase),
    hash_algorithm: "sha256:stable-json:v1",
  };
}

export function requireLatestPassingDataRollback(context, profile, beforeReceipt = null) {
  const result = latestPassingDataOperation(
    context,
    profile,
    "data.rollback",
    beforeReceipt,
  );
  if (!result.receipt) {
    fail(
      "rollback.verify for a declared data migration requires a verified data.rollback receipt first: "
      + `${result.errors.join("; ")}.`,
    );
  }
  return deliveryActionReceiptRef(context, result.receipt);
}

export function rollbackVerificationReceiptErrors(context, profile, receipt, actions) {
  const errors = [];
  if (
    receipt?.action !== "rollback.verify"
    || receipt?.status !== "completed"
    || receipt?.outcome !== "passed"
  ) {
    return ["receipt is not a completed passing rollback.verify action"];
  }
  const authorization = actions.find((candidate) =>
    candidate.id === receipt.authorization_receipt_ref?.id
    && candidate.receipt_hash === receipt.authorization_receipt_ref?.hash
    && candidate.action === "rollback.verify"
    && candidate.status === "authorized");
  if (!authorization) {
    return ["receipt lacks its exact rollback.verify authorization"];
  }
  const verification = receipt.rollback_verification;
  const approved = authorization.action_details?.rollback_verification;
  const dataRollbackRef = verification?.data_rollback_receipt_ref || null;
  if (
    verification?.action !== "rollback.verify"
    || verification?.verification !== "evidence_verified"
    || verification?.verified !== true
    || verification?.target_root !== profile.local_release_target?.root_path
    || stableJson(verification?.allowed_write_paths)
      !== stableJson(profile.local_release_target?.allowed_write_paths)
    || verification?.rollback_procedure
      !== profile.local_release_target?.rollback?.procedure
    || verification?.evidence_root !== approved?.evidence_root
    || stableJson(verification?.evidence) !== stableJson(receipt.evidence)
    || stableJson(approved) !== stableJson({
      target_root: verification?.target_root,
      allowed_write_paths: verification?.allowed_write_paths,
      rollback_procedure: verification?.rollback_procedure,
      evidence_root: verification?.evidence_root,
      evidence: verification?.evidence,
      ...(dataRollbackRef ? { data_rollback_receipt_ref: dataRollbackRef } : {}),
    })
  ) {
    errors.push("typed rollback verification differs from the exact local target, procedure, or evidence");
  }
  if (profile.local_release_target?.data_migration) {
    const dataRollbackReceipt = actions.find((candidate) =>
      candidate.id === dataRollbackRef?.id
      && candidate.receipt_hash === dataRollbackRef?.hash
      && candidate.action === "data.rollback"
      && candidate.status === "completed"
      && candidate.outcome === "passed");
    if (!dataRollbackReceipt) {
      errors.push("rollback verification does not bind its exact passing data.rollback receipt");
    } else {
      if (
        stableJson(dataRollbackRef)
        !== stableJson(deliveryActionReceiptRef(context, dataRollbackReceipt))
      ) {
        errors.push("rollback verification data.rollback reference is non-canonical");
      }
      errors.push(...dataOperationReceiptErrors(
        context,
        profile,
        dataRollbackReceipt,
        actions,
      ).map((error) => `bound data.rollback is invalid: ${error}`));
      if (compareDeliveryAuthorizationOrder(dataRollbackReceipt, authorization) >= 0) {
        errors.push("rollback verification was authorized before its bound data.rollback completed");
      }
    }
  } else if (dataRollbackRef) {
    errors.push("standard local rollback verification unexpectedly binds a data.rollback receipt");
  }
  for (const evidence of verification?.evidence || []) {
    try {
      const evidencePath = resolveProjectFilePath(
        context,
        evidence.path,
        { mustExist: true, fileOnly: true },
      );
      if (hashFile(evidencePath) !== evidence.sha256) {
        errors.push(`rollback verification evidence changed: ${evidence.path}`);
      }
    } catch (error) {
      errors.push(`rollback verification evidence is unavailable: ${evidence?.path || "unknown"} (${error.message})`);
    }
  }
  const providerReport = { errors: [] };
  validateCompletedProviderActionReceipt(
    context,
    providerReport,
    profile,
    receipt,
    authorization,
    `rollback.verify receipt ${receipt.id}`,
  );
  errors.push(...providerReport.errors);
  return errors;
}

export function reversibleDataReleaseSequence(context, profile, beforeReceipt = null) {
  if (!profile.local_release_target?.data_migration) {
    return { sequence: null, errors: [] };
  }
  const rollback = latestPassingDataOperation(
    context,
    profile,
    "data.rollback",
    beforeReceipt,
  );
  if (!rollback.receipt) {
    return {
      sequence: null,
      errors: [
        "a passing verified data.rollback is required",
        ...rollback.errors,
      ],
    };
  }
  const { actions, candidates: migrationCandidates } = passingDataOperationCandidates(
    context,
    profile,
    "data.migrate",
    beforeReceipt,
  );
  const finalMigrationCandidate = migrationCandidates
    .filter((receipt) => compareDeliveryAuthorizationOrder(rollback.receipt, receipt) < 0)
    .at(-1) || null;
  const finalMigrationErrors = finalMigrationCandidate
    ? dataOperationReceiptErrors(
        context,
        profile,
        finalMigrationCandidate,
        actions,
      )
    : ["no passing data.migrate exists after the verified data.rollback"];
  if (!finalMigrationCandidate || finalMigrationErrors.length > 0) {
    return {
      sequence: null,
      errors: [
        "a passing data.migrate after the verified data.rollback is required",
        ...finalMigrationErrors,
      ],
    };
  }
  const rollbackVerificationCandidates = actions
    .filter((receipt) =>
      receipt.action === "rollback.verify"
      && receipt.status === "completed"
      && receipt.outcome === "passed"
      && (!beforeReceipt || compareDeliveryAuthorizationOrder(receipt, beforeReceipt) < 0))
    .sort(compareDeliveryAuthorizationOrder);
  const rollbackRef = deliveryActionReceiptRef(context, rollback.receipt);
  const rollbackVerificationCandidate = rollbackVerificationCandidates
    .filter((receipt) =>
      stableJson(receipt.rollback_verification?.data_rollback_receipt_ref)
        === stableJson(rollbackRef))
    .at(-1) || null;
  const rollbackVerificationErrors = rollbackVerificationCandidate
    ? rollbackVerificationReceiptErrors(
        context,
        profile,
        rollbackVerificationCandidate,
        actions,
      )
    : ["no rollback.verify receipt is bound to the latest verified data.rollback"];
  if (!rollbackVerificationCandidate || rollbackVerificationErrors.length > 0) {
    return {
      sequence: null,
      errors: [
        "a passing rollback.verify bound to the latest verified data.rollback is required",
        ...rollbackVerificationErrors,
      ],
    };
  }
  return {
    errors: [],
    sequence: {
      data_rollback_receipt_ref: rollbackRef,
      final_data_migration_receipt_ref: deliveryActionReceiptRef(
        context,
        finalMigrationCandidate,
      ),
      rollback_verification_receipt_ref: deliveryActionReceiptRef(
        context,
        rollbackVerificationCandidate,
      ),
    },
  };
}

export function requireReversibleDataReleaseSequence(context, profile, beforeReceipt = null) {
  const result = reversibleDataReleaseSequence(context, profile, beforeReceipt);
  if (!result.sequence) {
    fail(
      "release.local for a declared data migration requires rollback rehearsal, "
      + `a final migration retry, and bound rollback verification before authorization: ${result.errors.join("; ")}.`,
    );
  }
  return result.sequence;
}

export function latestPassingRollbackVerification(context, profile, beforeReceipt = null) {
  const actions = deliveryActionReceipts(context, profile.id);
  const candidates = actions
    .filter((receipt) =>
      receipt.action === "rollback.verify"
      && receipt.status === "completed"
      && receipt.outcome === "passed"
      && (!beforeReceipt || compareDeliveryAuthorizationOrder(receipt, beforeReceipt) < 0))
    .sort(compareDeliveryAuthorizationOrder)
    .reverse();
  for (const receipt of candidates) {
    const errors = rollbackVerificationReceiptErrors(context, profile, receipt, actions);
    if (errors.length === 0) return { receipt, errors: [] };
  }
  const latest = candidates[0] || null;
  return {
    receipt: null,
    errors: latest
      ? rollbackVerificationReceiptErrors(context, profile, latest, actions)
      : ["no completed passing rollback.verify receipt exists before release.local"],
  };
}

export function localReleaseTargetBaselineState(context, profile, executionState, {
  requireCurrentWorkspace = true,
} = {}) {
  const startReceipt = executionState?.start_receipt;
  if (!startReceipt) {
    fail(`Local target governance for ${profile.id} requires its immutable delivery-start receipt.`);
  }
  const baseline = startReceipt.local_release_target_baseline;
  if (!baseline) {
    fail(activeLegacyLocalStartError(profile));
  }
  const baselineHadAbsence = localReleaseTargetHadAbsentEntries(baseline);
  const baselineErrors = localReleaseTargetSnapshotErrors(context, profile, baseline, {
    purpose: "task_start",
    requireCurrentWorkspace: requireCurrentWorkspace && baselineHadAbsence,
  });
  if (baselineErrors.length > 0) {
    fail(`Immutable local-target baseline for ${profile.id} is invalid: ${baselineErrors.join("; ")}.`);
  }
  if (baseline.observed_at !== startReceipt.started_at) {
    fail(`Immutable local-target baseline for ${profile.id} does not match its delivery-start time.`);
  }
  return {
    legacy: false,
    snapshot: baseline,
    ref: {
      source: "delivery_start",
      receipt_ref: deliveryStartReceiptRef(context, profile, startReceipt),
      snapshot_hash: baseline.snapshot_hash,
    },
  };
}

export function localReleaseTargetGovernanceState(context, profile, executionState, {
  requireCurrentWorkspace = true,
  beforeReceipt = null,
} = {}) {
  let state = localReleaseTargetBaselineState(context, profile, executionState, {
    requireCurrentWorkspace,
  });
  const actions = deliveryActionReceipts(context, profile.id);
  const authorizations = new Map(actions
    .filter((receipt) => receipt.action === "build.local" && receipt.status === "authorized")
    .map((receipt) => [receipt.id, receipt]));
  const invalid = [];
  for (const receipt of actions
    .filter((candidate) =>
      candidate.action === "build.local"
      && candidate.status === "completed"
      && ["passed", "failed"].includes(candidate.outcome)
      && localTargetBuildCompletionDetails(candidate)
      && (!beforeReceipt || compareDeliveryAuthorizationOrder(candidate, beforeReceipt) < 0))
    .sort(compareDeliveryAuthorizationOrder)) {
    const authorization = authorizations.get(receipt.authorization_receipt_ref?.id);
    const errors = localTargetBuildReceiptErrors(
      context,
      profile,
      receipt,
      authorization,
      state,
    );
    if (errors.length > 0) {
      invalid.push(`${receipt.id}: ${errors.join("; ")}`);
      continue;
    }
    state = {
      legacy: false,
      snapshot: localTargetBuildCompletionDetails(receipt).snapshot,
      ref: localTargetBuildReceiptRef(context, receipt),
      buildReceipt: receipt,
      materialized: receipt.outcome === "passed",
    };
  }
  return { ...state, invalid };
}

export function assertCurrentLocalReleaseTargetState(context, profile, state, purpose, observedAt) {
  const current = buildLocalReleaseTargetSnapshot(
    context,
    profile,
    purpose,
    observedAt,
  );
  const contentBuildReceipt = state?.ref?.source === "build.local"
    ? state.buildReceipt
    : state?.contentBuildReceipt || null;
  const recordedContent = localTargetBuildContentManifest(contentBuildReceipt);
  if (!localTargetPredecessorStateMatches(state, current)) {
    const changed = (state?.snapshot?.entries || [])
      .map((entry, index) => ({ entry, observed: current.entries[index] }))
      .filter(({ entry, observed }) => stableJson(entry) !== stableJson(observed))
      .map(({ entry, observed }) => `${entry.path} (${entry.status}${
        entry.real_path && observed?.real_path && entry.real_path !== observed.real_path
          ? ` at ${entry.real_path}, now at ${observed.real_path}`
          : ""} -> ${observed?.status || "missing"})`);
    fail(
      `The exact local target changed outside governed build.local for ${profile.id}`
      + `${changed.length > 0 ? `: ${changed.join(", ")}` : ""}. `
      + (state?.ref?.source === "build.local" && recordedContent
        ? "The target root must keep its identity and every approved write path must stay a real, "
          + "non-symlinked directory at the same resolved location. "
        : "Restore the attested directory identities or start a new delivery. ")
      + "A manual mkdir is not a repair.",
    );
  }
  if (recordedContent && purpose === "build_completion") {
    const currentContent = localReleaseTargetContentManifest(context, profile);
    const differences = localReleaseTargetContentDifferences(recordedContent, currentContent);
    if (differences.length > 0) {
      fail(
        `The content of ${differences.join(", ")} no longer matches the manifest that build.local `
        + `${contentBuildReceipt.id} recorded for ${profile.id}. Install or replace release files only while `
        + "a build.local authorization is open: request build.local again, install the build into the "
        + "approved write paths, complete that build.local with its evidence, then repeat rollback.verify "
        + "and release.local. Restoring exactly the recorded content is the only other repair.",
      );
    }
  }
  return current;
}

export function localReleaseProtectedTargetState(
  context,
  profile,
  executionState,
  options = {},
) {
  const baseline = localReleaseTargetBaselineState(
    context,
    profile,
    executionState,
    {
      requireCurrentWorkspace: options.requireCurrentWorkspace !== false,
    },
  );
  if (localReleaseTargetHadOnlyDirectories(baseline.snapshot)) {
    // An existing destination may be released without any build, so the
    // materialization reference stays the delivery start. Once a
    // content-bound build.local ran, later actions still bind to its content.
    const contentBoundBuild = deliveryActionReceipts(context, profile.id)
      .some((receipt) =>
        receipt.action === "build.local"
        && receipt.status === "completed"
        && localTargetBuildContentManifest(receipt)
        && (!options.beforeReceipt
          || compareDeliveryAuthorizationOrder(receipt, options.beforeReceipt) < 0));
    if (!contentBoundBuild) {
      return { ...baseline, invalid: [] };
    }
    const governed = localReleaseTargetGovernanceState(
      context,
      profile,
      executionState,
      options,
    );
    return {
      ...baseline,
      invalid: governed.invalid,
      contentBuildReceipt: governed.ref?.source === "build.local"
        && localTargetBuildContentManifest(governed.buildReceipt)
        ? governed.buildReceipt
        : null,
    };
  }
  return localReleaseTargetGovernanceState(
    context,
    profile,
    executionState,
    options,
  );
}

/**
 * Host authority of one action authorization. With `futureAuthority` (an
 * authorization not executed yet) the signing key must also be active now;
 * executed and historical records are checked as of their own times.
 */
export function validateDeliveryActionHostAuthority(context, profile, authorization, { futureAuthority = false } = {}) {
  const activeAt = futureAuthority ? now() : null;
  const assurance = authorization.approval?.authority_assurance;
  if (profile.authority_assurance?.mode === "host_verified" && assurance?.mode !== "host_verified") {
    fail(`Delivery action authorization ${authorization.id} requires exact host-verified checkpoint authority.`);
  }
  if (assurance?.mode !== "host_verified") return;
  if (assurance.source === STANDING_RECEIPT_AUTHORITY_SOURCE) {
    // A step confirmed by a signed standing approval: the derived approval
    // must name that receipt, which must also be the one the profile records.
    const errors = standingReceiptAuthorityErrors(context, authorization.approval, assurance.receipt_ref, {
      subject_id: profile.id,
      require_use: true,
      activeAt,
    });
    const profileRef = profile.authority_assurance?.receipt_ref;
    if (profile.authority_assurance?.mode === "host_verified"
      && (profileRef?.id !== assurance.receipt_ref?.id || profileRef?.hash !== assurance.receipt_ref?.hash)) {
      errors.push("it names a different signed standing approval receipt than the delivery profile");
    }
    if (errors.length > 0) {
      fail(`Delivery action authorization ${authorization.id} standing approval authority is invalid: ${errors.join("; ")}`);
    }
    return;
  }
  const receiptRef = assurance.receipt_ref;
  if (!receiptRef?.path || !receiptRef?.hash) {
    fail(`Delivery action authorization ${authorization.id} host authority lacks a receipt reference.`);
  }
  const receiptPath = resolveProjectFilePath(context, receiptRef.path, { mustExist: true, fileOnly: true });
  const hostReceipt = readProjectJson(context, receiptPath);
  assertRecordSchema(hostReceipt, "host-approval-receipt.schema.json", `Delivery action host receipt ${receiptRef.id}`);
  if (hostReceipt.id !== receiptRef.id || hostReceipt.receipt_hash !== receiptRef.hash) {
    fail(`Delivery action authorization ${authorization.id} host receipt reference is stale.`);
  }
  const subject = {
    profile_id: profile.id,
    profile_hash: profile.profile_hash,
    delivery_id: profile.delivery_id,
    action: authorization.action,
    runtime_target: authorization.runtime_target,
    action_details: authorization.action_details,
  };
  let decision;
  try {
    decision = validateHostApprovalReceiptAtUse(hostReceipt, {
      action: `autonomy.delivery.action.${authorization.action}`,
      subject,
      used_at: authorization.authorized_at,
    }, {
      trusted_host_keys: context.config.authority_policy?.trusted_host_keys || [],
      active_at: activeAt,
    });
  } catch (error) {
    fail(`Delivery action authorization ${authorization.id} host receipt is invalid: ${error.message}`);
  }
  if (!decision.valid) {
    fail(`Delivery action authorization ${authorization.id} host receipt is invalid: ${decision.errors.join("; ")}`);
  }
}

export function assertCurrentDeliveryActionAuthorization(context, profile, decision, actionPolicy, authorization) {
  if (
    authorization.profile_ref?.id !== profile.id
    || !deliveryProfileHashMatches(profile, authorization.profile_ref?.hash)
    || authorization.delivery?.id !== profile.delivery_id
    || authorization.delivery?.kind !== profile.delivery_kind
    || authorization.effective_level !== decision.effective_level
  ) {
    fail(`Delivery action authorization ${authorization.id} is stale for the current exact policy boundary.`);
  }
  assertDeliveryProviderAuthorization(context, profile, authorization);
  const checkpointSnapshot = authorization.action_details?.checkpoint_policy;
  let checkpointRequired = actionPolicy.required;
  const auditWarnings = [];
  if (checkpointSnapshot) {
    const snapshotValidation = validateDeliveryActionCheckpointPolicySnapshot(
      context,
      checkpointSnapshot,
      profile,
      decision.effective_level,
      authorization.action,
    );
    if (!snapshotValidation.valid) {
      fail(`Delivery action authorization ${authorization.id} has an invalid checkpoint policy snapshot: ${snapshotValidation.errors.join("; ")}`);
    }
    checkpointRequired = checkpointSnapshot.required;
    if (authorization.checkpoint_required !== checkpointRequired) {
      fail(`Delivery action authorization ${authorization.id} checkpoint flag disagrees with its immutable event-time policy snapshot.`);
    }
    const currentSnapshot = deliveryActionCheckpointPolicySnapshot(
      context,
      profile,
      decision.effective_level,
      authorization.action,
      actionPolicy,
    );
    if (stableJson(checkpointSnapshot) !== stableJson(currentSnapshot)) {
      if (localDeliveryRuntimeBoundaryChanged(checkpointSnapshot, currentSnapshot)) {
        fail(
          `Delivery action authorization ${authorization.id} was approved for a different local target or machine scope; authorize this exact action again.`,
        );
      }
      auditWarnings.push(
        `Delivery action authorization ${authorization.id} remains valid for this exact action; updated approval rules apply to later actions.`,
      );
    }
  } else if (authorization.checkpoint_required !== checkpointRequired) {
    fail(`Delivery action authorization ${authorization.id} is stale for the current exact policy boundary.`);
  }
  if (authorization.action === "git.push") {
    const coverageProof = authorization.action_details?.commit_coverage || null;
    const requiresCoverageProof = Boolean(checkpointSnapshot?.policy_source_ref);
    if (requiresCoverageProof && !coverageProof) {
      fail(`Delivery action authorization ${authorization.id} is missing its required git-commit coverage proof.`);
    }
    if (coverageProof) {
      const coverageErrors = validateGitCommitCoverageProof(
        context,
        profile,
        {
          ...authorization.runtime_target,
          base_sha: authorization.action_details?.base_precondition?.observed_sha,
          remote_branch_sha: authorization.action_details?.push_precondition?.observed_sha || undefined,
        },
        coverageProof,
      );
      if (coverageErrors.length > 0) {
        fail(`Delivery action authorization ${authorization.id} has invalid git-commit coverage: ${coverageErrors.join("; ")}`);
      }
    }
  }
  if (!checkpointRequired) return { checkpointRequired, auditWarnings };
  if (authorization.approval?.status !== "approved") {
    fail(`Delivery action authorization ${authorization.id} lacks the formal approval required by its event-time checkpoint policy.`);
  }
  if (authorization.approval.approval_source === STANDING_APPROVAL_SOURCE) {
    // Revocation, expiry, or a change outside the bounds takes effect at the
    // next step, including the completion of an action it authorized.
    const standingCoverage = evaluateStandingStepCoverage(context, profile, authorization.action);
    if (!standingCoverage || standingCoverage.reasons.length > 0) {
      fail(
        `${standingCoverage ? standingFallbackMessage(standingCoverage, authorization.action) : "The standing approval is no longer bound to this delivery."} `
        + `Authorization ${authorization.id} can no longer be completed under it; after the user confirms, `
        + "complete the new authorization with --authorization-receipt.",
      );
    }
  }
  const subject = {
    profile_id: profile.id,
    profile_hash: profile.profile_hash,
    delivery_id: profile.delivery_id,
    action: authorization.action,
    runtime_target: authorization.runtime_target,
    action_details: authorization.action_details,
  };
  if (authorization.approval.approved_content_hash !== hashApprovalSubject(subject)) {
    fail(`Delivery action authorization ${authorization.id} approval does not bind its exact action subject.`);
  }
  validateApprovalSourceForActor(context, {
    source: authorization.approval.approval_source || null,
    status: authorization.approval.status,
    summary: authorization.approval.summary || null,
    evidence: Array.isArray(authorization.approval.evidence) ? authorization.approval.evidence : [],
    actor: authorization.approval.approved_by || null,
    label: `Delivery action authorization ${authorization.id}`,
  });
  validateApprovalEvidenceIntegrity(
    context,
    authorization.approval,
    `Delivery action authorization ${authorization.id} approval`,
  );
  const report = { strict: true, errors: [], warnings: [] };
  validateFormalApprovalRecord(
    context,
    report,
    authorization.approval,
    `Delivery action authorization ${authorization.id}`,
    authorization.approval.approved_by,
    { subject_id: profile.id },
  );
  if (report.errors.length > 0) {
    fail(`Delivery action authorization ${authorization.id} governance is invalid: ${report.errors.join("; ")}`);
  }
  // A pending authorization still grants authority, so its key must be active now.
  validateDeliveryActionHostAuthority(context, profile, authorization, { futureAuthority: true });
  return { checkpointRequired, auditWarnings };
}

export function buildLocalReleaseActionAttempt(
  context,
  profile,
  authorization,
  completionRequest,
  authorizedIntegrity,
  artifactBeforeSmoke,
) {
  const attemptBase = {
    id: localReleaseAttemptId(authorization, completionRequest),
    kind: "delivery_action_attempt_receipt",
    schema_version: "delivery-action-attempt-receipt:v1",
    profile_ref: {
      id: profile.id,
      path: toProjectPath(context, deliveryAutonomyPath(context, profile.id)),
      hash: profile.profile_hash,
    },
    delivery: {
      id: profile.delivery_id,
      kind: profile.delivery_kind,
    },
    action: "release.local",
    authorization_receipt_ref: deliveryActionReceiptRef(context, authorization),
    completion_request: completionRequest,
    smoke_execution_policy_ref: {
      policy_hash: authorizedIntegrity.smoke_execution_policy.policy_hash,
    },
    artifact_before_smoke: artifactBeforeSmoke,
    started_at: now(),
  };
  const attempt = {
    ...attemptBase,
    receipt_hash: autonomyLifecycleReceiptHash(attemptBase),
    hash_algorithm: "sha256:stable-json:v1",
  };
  assertRecordSchema(
    attempt,
    "delivery-action-attempt-receipt.schema.json",
    `Delivery action attempt receipt ${attempt.id}`,
  );
  return attempt;
}

export function persistLocalReleaseActionAttempt(context, profile, attempt) {
  const attemptPath = deliveryActionAttemptPath(context, profile.id, attempt.id);
  if (fs.existsSync(attemptPath)) {
    const existing = readDeliveryLifecycleReceipt(
      context,
      attemptPath,
      "delivery-action-attempt-receipt.schema.json",
    );
    if (stableJson(existing) !== stableJson(attempt)) {
      fail(
        `Local release attempt ${attempt.id} conflicts with an existing write-ahead receipt. `
        + "The authorization remains consumed; use a fresh authorization after reviewing the prior attempt.",
      );
    }
    fail(
      `Local release attempt ${attempt.id} was already started. The authorization is consumed and `
      + "the smoke command will not be executed again; use a fresh authorization or explicit recovery.",
    );
  }
  ensureWorkflowDirectoryDurably(path.dirname(attemptPath));
  writeJsonFile(attemptPath, attempt, { atomicCreate: true, durable: true });
  return {
    receipt: readDeliveryLifecycleReceipt(
      context,
      attemptPath,
      "delivery-action-attempt-receipt.schema.json",
    ),
    path: toProjectPath(context, attemptPath),
  };
}

export function matchingPersistedDeliveryCompletion(context, profile, action, outcome, options) {
  const evidence = buildActionEvidence(context, options.evidence);
  if (evidence.length === 0) {
    fail(`Delivery action ${action} completion requires at least one immutable --evidence file.`);
  }
  const selectorOption = getOptionString(options, "authorization-receipt");
  const selector = selectorOption ? normalizeId(selectorOption) : null;
  const actions = deliveryActionReceipts(context, profile.id);
  const attemptsById = new Map(
    (action === "release.local" ? deliveryActionAttemptReceipts(context, profile.id) : [])
      .map((attempt) => [attempt.id, attempt]),
  );
  const authorizationsById = new Map(
    actions
      .filter((receipt) => receipt.status === "authorized")
      .map((receipt) => [receipt.id, receipt]),
  );
  const matches = [];
  for (const completion of actions.filter((receipt) =>
    receipt.status === "completed"
    && receipt.action === action
    && deliveryProfileHashMatches(profile, receipt.profile_ref?.hash))) {
    const authorization = authorizationsById.get(completion.authorization_receipt_ref?.id);
    if (
      !authorization
      || authorization.receipt_hash !== completion.authorization_receipt_ref?.hash
    ) {
      fail(`Persisted completion ${completion.id} lacks its exact authorization receipt.`);
    }
    const validation = validateDeliveryCompletionRequest(context, completion, authorization);
    if (validation.legacy) continue;
    if (!validation.valid) {
      fail(`Persisted completion ${completion.id} has an invalid completion identity: ${validation.errors.join("; ")}.`);
    }
    if (selector && authorization.id !== selector) continue;
    const expected = buildDeliveryCompletionRequest(
      context,
      profile,
      action,
      outcome,
      evidence,
      options,
      authorization,
    );
    if (
      completion.completion_request.request_hash === expected.request_hash
      && stableJson(completion.completion_request) === stableJson(expected)
    ) {
      matches.push({ completion, authorization, evidence, derivedFailure: false });
      continue;
    }
    if (
      action === "release.local"
      && outcome === "passed"
      && completion.outcome === "failed"
      && completion.local_release_verification
    ) {
      const attempt = attemptsById.get(completion.attempt_receipt_ref?.id);
      if (
        attempt
        && stableJson(completion.attempt_receipt_ref)
          === stableJson(deliveryActionAttemptReceiptRef(context, profile, attempt))
        && stableJson(attempt.completion_request) === stableJson(expected)
      ) {
        const integrity = localReleaseCompletionIntegrityErrors(
          context,
          profile,
          completion,
          authorization,
          { attempt },
        );
        if (integrity.legacy || integrity.errors.length > 0) {
          fail(
            `Persisted failed completion ${completion.id} has invalid local release integrity: `
            + `${integrity.errors.join("; ") || "missing write-ahead proof"}.`,
          );
        }
        matches.push({
          completion,
          authorization,
          evidence,
          attempt,
          derivedFailure: true,
        });
      }
    }
  }
  if (matches.length > 1) {
    fail(
      `Completion retry identity collision for ${action}: ${matches.map((item) => item.completion.id).join(", ")}. `
      + "No additional completion was recorded.",
    );
  }
  return matches[0] || null;
}

export function recoverPersistedDeliveryCompletion(
  context,
  profile,
  action,
  outcome,
  options,
  executionState,
) {
  const match = matchingPersistedDeliveryCompletion(
    context,
    profile,
    action,
    outcome,
    options,
  );
  if (!match) return false;
  const completionTrace = ensureDeliveryActionAuthorizationTrace(
    context,
    buildDeliveryActionCompletionTraceEvent(context, profile, match.completion),
  );
  let state = executionState;
  let autoClose = null;
  if (match.completion.outcome === "passed" && terminalStatusForDeliveryAction(action)) {
    if (state.lifecycle_status === "started") {
      autoClose = repairTerminalDeliveryClose(context, profile, state);
      state = currentDeliveryExecutionState(context, profile);
    } else if (
      state.lifecycle_status !== "terminal"
      || state.close_receipt?.terminal_action_receipt_ref?.id !== match.completion.id
      || state.close_receipt?.terminal_action_receipt_ref?.hash !== match.completion.receipt_hash
    ) {
      fail(`Persisted terminal completion ${match.completion.id} conflicts with the delivery close state.`);
    } else {
      ensureDeliveryActionAuthorizationTrace(
        context,
        buildTerminalDeliveryCloseTraceEvent(
          context,
          profile,
          state.close_receipt,
          match.completion,
        ),
      );
    }
  }
  if (match.completion.outcome === "failed") {
    fail(
      `Completion ${match.completion.id} was already recorded as failed for ${action}; `
      + (completionTrace.appended
        ? "its missing lifecycle trace was repaired. "
        : "its lifecycle trace was already consistent. ")
      + "No smoke command was executed again and the prior authorization remains consumed. "
      + "Correct the cause and use a fresh authorization.",
    );
  }
  output(options, {
    status: "completed",
    idempotent: true,
    recovery_status: completionTrace.appended || autoClose
      ? "repaired"
      : "already_consistent",
    execution_allowed: false,
    profile_id: profile.id,
    action,
    action_receipt: match.completion,
    action_receipt_path: toProjectPath(
      context,
      path.join(autonomyActionsRoot(context), `${normalizeId(match.completion.id)}.json`),
    ),
    lifecycle_status: state.lifecycle_status,
    terminal_status: state.close_receipt?.terminal_status || autoClose?.receipt?.terminal_status || null,
    close_receipt: state.close_receipt || autoClose?.receipt || null,
    close_receipt_path: state.close_receipt_path || autoClose?.path || null,
  }, [
    `Completion ${match.completion.id} was already recorded for ${action}; no other authorization was consumed.`,
    completionTrace.appended || autoClose
      ? "Recovered the missing lifecycle evidence."
      : "The persisted completion and lifecycle evidence are already consistent.",
  ]);
  return true;
}

export function selectPendingDeliveryActionAuthorization(
  context,
  profile,
  action,
  actions,
  options,
) {
  const attempts = action === "release.local"
    ? deliveryActionAttemptReceipts(context, profile.id)
    : [];
  const attemptedAuthorizationIds = new Set(
    attempts
      .map((receipt) => receipt.authorization_receipt_ref?.id)
      .filter(Boolean),
  );
  const consumedAuthorizationIds = new Set(actions
    .filter((receipt) => receipt.status === "completed")
    .map((receipt) => receipt.authorization_receipt_ref?.id)
    .filter(Boolean));
  for (const authorizationId of attemptedAuthorizationIds) {
    consumedAuthorizationIds.add(authorizationId);
  }
  const matchingAuthorizations = actions
    .filter((receipt) =>
      receipt.action === action
      && receipt.status === "authorized"
      && deliveryProfileHashMatches(profile, receipt.profile_ref?.hash))
    .sort(compareDeliveryAuthorizationOrder);
  const selectorOption = getOptionString(options, "authorization-receipt");
  if (selectorOption) {
    const selector = normalizeId(selectorOption);
    const selected = matchingAuthorizations.find((receipt) => receipt.id === selector);
    if (!selected) {
      fail(
        `Delivery action authorization receipt ${selector} does not authorize ${action} `
        + `for exact profile ${profile.id}.`,
      );
    }
    if (consumedAuthorizationIds.has(selected.id)) {
      const writeAheadAttempt = attempts.find((attempt) =>
        attempt.authorization_receipt_ref?.id === selected.id);
      fail(
        `Delivery action authorization receipt ${selector} is already consumed, and this completion `
        + "request does not match its persisted result. "
        + (writeAheadAttempt
          ? `Write-ahead attempt ${writeAheadAttempt.id} prevents silent re-execution after a crash or failed smoke. `
          : "")
        + "Use a different unconsumed receipt for a new operation.",
      );
    }
    return selected;
  }
  const pending = matchingAuthorizations.filter((receipt) =>
    !consumedAuthorizationIds.has(receipt.id));
  if (pending.length === 0) {
    fail(`Delivery action ${action} must be authorized before recording its outcome.`);
  }
  if (pending.length > 1) {
    fail(
      `More than one unconsumed authorization receipt matches ${action}: `
      + `${pending.map((receipt) => receipt.id).join(", ")}. `
      + "Repeat completion with --authorization-receipt <AUT-ACT-id> so the exact executed operation is unambiguous.",
    );
  }
  return pending[0];
}

export function repairTerminalDeliveryClose(context, profile, executionState) {
  if (executionState.lifecycle_status !== "started") return null;
  const actions = deliveryActionReceipts(context, profile.id);
  const terminalCompletions = actions.filter((receipt) =>
    terminalStatusForDeliveryAction(receipt.action)
    && receipt.status === "completed"
    && receipt.outcome === "passed");
  if (terminalCompletions.length === 0) return null;
  if (terminalCompletions.length > 1) {
    fail(`Delivery ${profile.delivery_id} has multiple passing terminal action receipts; manual recovery is required.`);
  }
  const completion = terminalCompletions[0];
  const validation = { strict: true, errors: [], warnings: [], checked: [] };
  validateDeliveryExecutionReceipts(
    context,
    validation,
    profile,
    executionState,
    `delivery autonomy profile ${profile.id}`,
    { allowRecoverableTerminal: true },
  );
  if (validation.errors.length > 0) {
    fail(`Terminal action receipt ${completion.id} cannot close the delivery: ${validation.errors.join("; ")}`);
  }
  const authorization = actions.find((receipt) =>
    receipt.id === completion.authorization_receipt_ref?.id
    && receipt.receipt_hash === completion.authorization_receipt_ref?.hash
    && receipt.status === "authorized");
  if (!authorization) {
    fail(`Terminal action receipt ${completion.id} lacks its exact authorization receipt.`);
  }
  const terminalStatus = terminalStatusForDeliveryAction(completion.action);
  const closeBase = {
    id: `AUT-CLOSE-${normalizeId(profile.id)}`,
    kind: "delivery_close_receipt",
    schema_version: "delivery-close-receipt:v1",
    profile_ref: {
      id: profile.id,
      path: toProjectPath(context, deliveryAutonomyPath(context, profile.id)),
      hash: profile.profile_hash,
    },
    delivery: { id: profile.delivery_id, kind: profile.delivery_kind },
    start_receipt_ref: {
      id: executionState.start_receipt.id,
      path: executionState.start_receipt_path,
      hash: executionState.start_receipt.receipt_hash,
    },
    terminal_action_receipt_ref: {
      id: completion.id,
      path: toProjectPath(
        context,
        path.join(autonomyActionsRoot(context), `${normalizeId(completion.id)}.json`),
      ),
      hash: completion.receipt_hash,
    },
    terminal_status: terminalStatus,
    reason: `Completed passing terminal action ${completion.action}.`,
    approval: authorization.approval || {
      status: "derived-from-approved-delivery-profile",
      profile_approval_ref: profile.approval_ref,
    },
    closed_by: completion.authorized_by,
    closed_at: now(),
    audit: completion.audit,
  };
  const closeReceipt = {
    ...closeBase,
    receipt_hash: autonomyLifecycleReceiptHash(closeBase),
    hash_algorithm: "sha256:stable-json:v1",
  };
  assertRecordSchema(closeReceipt, "delivery-close-receipt.schema.json", `Delivery close receipt ${profile.id}`);
  const closePath = deliveryCloseReceiptPath(context, profile.id);
  writeJsonFile(closePath, closeReceipt, { atomicCreate: true });
  ensureDeliveryActionAuthorizationTrace(
    context,
    buildTerminalDeliveryCloseTraceEvent(context, profile, closeReceipt, completion),
  );
  return { receipt: closeReceipt, path: toProjectPath(context, closePath), completion };
}

/**
 * The stories a delivery action certifies, for the command wrapper that
 * trusts the other stories' sealed receipts. Empty when the profile cannot be
 * read; the action itself then reports the error.
 */
export function deliveryProfileStoryIds(context, options) {
  try {
    const profileId = normalizeId(requireOption(options, "id"));
    const profile = readDeliveryAutonomyProfile(context, profileId);
    return (profile.story_refs || []).map((ref) => normalizeId(String(ref.id)));
  } catch {
    return [];
  }
}

const RELEASE_PHASE_DELIVERY_ACTIONS = new Set([
  "pull_request.create",
  "pull_request.update",
  "pull_request.merge",
  "release.local",
]);

// A pull-request or local-release action is authorized only once the story's
// task-bound workflow has entered the release phase (or a later one).
function assertWorkflowInReleaseForAction(context, profile, action) {
  if (!RELEASE_PHASE_DELIVERY_ACTIONS.has(action)) return;
  const storyId = profile.story_refs?.length === 1 ? profile.story_refs[0].id : null;
  if (!storyId) return;
  const taskStartPath = path.join(context.sdlcRoot, "stories", storyId, "task-start.json");
  if (!fs.existsSync(taskStartPath)) return;
  let instanceId = null;
  try {
    instanceId = readProjectJson(context, taskStartPath)?.workflow_instance_ref?.id || null;
  } catch {
    return;
  }
  if (!instanceId) return;
  const current = readWorkflowCheckpoint(context, instanceId).checkpoint?.current_state;
  if (!current) return;
  const order = configuredPhaseOrder(context);
  const releasePhase = releasePhaseName(context);
  const currentIndex = order.indexOf(current);
  const releaseIndex = order.indexOf(releasePhase);
  if (currentIndex < 0 || releaseIndex < 0 || currentIndex >= releaseIndex) return;
  fail(
    `Delivery action ${action} needs story ${storyId} in the '${releasePhase}' phase, `
    + `but workflow ${instanceId} is still in '${current}'. `
    + `Run 'workflow instance transition --id ${instanceId} --to ${releasePhase}' first.`,
  );
}

export function evaluateDeliveryAction(context, options) {
  ensureInitialized(context);
  const profileId = normalizeId(requireOption(options, "id"));
  const requestedAction = requireOption(options, "action");
  const profilePath = deliveryAutonomyPath(context, profileId);
  const releaseLock = acquireFileLock(`${profilePath}.lock`);
  let releaseStandingLock = null;
  try {
    const profile = readDeliveryAutonomyProfile(context, profileId);
    const action = normalizeDeliveryAction(profile.delivery_kind, requestedAction);
    if (action === "git.commit" && !getOptionString(options, "outcome")) {
      options = expandCommitScopeOptions(options, () => {
        const staged = execGitOutput(context.root, ["diff", "--cached", "--name-only", "--no-renames", "HEAD", "--"]);
        if (staged === null) fail("git.commit scope could not be verified: git diff failed.");
        return String(staged).split(/\r?\n/u).map((item) => item.trim()).filter(Boolean);
      });
    }
    const executionState = currentDeliveryExecutionState(context, profile);
    const reportedOutcome = getOptionString(options, "outcome");
    let completionOutcome = reportedOutcome;
    let deferredCompletionFailure = null;
    const completingAction = Boolean(reportedOutcome);
    if (completingAction && !["passed", "failed"].includes(reportedOutcome)) {
      fail("Delivery action completion --outcome must be passed or failed.");
    }
    if (!completingAction && options["authorization-receipt"] !== undefined) {
      fail("--authorization-receipt is only valid when recording --outcome passed|failed.");
    }
    if (
      completingAction
      && recoverPersistedDeliveryCompletion(
        context,
        profile,
        action,
        reportedOutcome,
        options,
        executionState,
      )
    ) {
      return;
    }
    if (executionState.lifecycle_status === "terminal") {
      if (completingAction) {
        fail(
          `Delivery ${profile.delivery_id} is already terminal, and this completion request `
          + "does not match its persisted terminal result.",
        );
      }
      const expectedAction = executionState.close_receipt.terminal_status === "merged"
        ? "pull_request.merge"
        : executionState.close_receipt.terminal_status === "released"
          ? "release.local"
          : null;
      if (expectedAction === action && executionState.close_receipt.terminal_action_receipt_ref) {
        const completion = deliveryActionReceipts(context, profile.id).find((receipt) =>
          receipt.id === executionState.close_receipt.terminal_action_receipt_ref.id
          && receipt.receipt_hash === executionState.close_receipt.terminal_action_receipt_ref.hash);
        output(options, {
          status: "terminal",
          idempotent: true,
          lifecycle_status: "terminal",
          terminal_status: executionState.close_receipt.terminal_status,
          action_receipt: completion || null,
          close_receipt: executionState.close_receipt,
          close_receipt_path: executionState.close_receipt_path,
        }, [`Delivery ${profile.delivery_id} is already terminal as ${executionState.close_receipt.terminal_status}.`]);
        return;
      }
    }
    if (executionState.lifecycle_status !== "started") {
      fail(`Delivery action ${action} requires ${profileId} to be started and non-terminal.`);
    }
    const recoveredTerminal = completingAction
      ? null
      : repairTerminalDeliveryClose(context, profile, executionState);
    if (recoveredTerminal) {
      output(options, {
        status: "terminal",
        idempotent_repair: true,
        lifecycle_status: "terminal",
        terminal_status: recoveredTerminal.receipt.terminal_status,
        action_receipt: recoveredTerminal.completion,
        close_receipt: recoveredTerminal.receipt,
        close_receipt_path: recoveredTerminal.path,
      }, [`Recovered terminal close for ${profile.delivery_kind} ${profile.delivery_id}.`]);
      return;
    }
    if (!completingAction) assertWorkflowInReleaseForAction(context, profile, action);
    if (
      profile.delivery_kind === "local_release"
      && !executionState.start_receipt?.local_release_target_baseline
    ) {
      fail(activeLegacyLocalStartError(profile));
    }
    let runtimeTarget = profile.delivery_kind === "pull_request"
      ? validatePullRequestGitBoundary(context, profile.pull_request_target)
      : null;
    const { decision } = evaluateDeliveryAutonomy(context, profile, {
      futureAuthority: true,
      id: `AUT-ACTION-${uniqueRecordSuffix()}`,
      phase: getOptionString(options, "phase") || undefined,
      validateRuntimeTarget: profile.delivery_kind === "pull_request"
        || (profile.delivery_kind === "local_release" && action === "release.local"),
    });
    const invalidConstraints = decision.source_constraints.filter((constraint) => constraint.valid === false);
    if (decision.blocked || invalidConstraints.length > 0 || decision.material_drift.length > 0) {
      fail(`Delivery action ${action} is blocked by the current autonomy evaluation: ${[
        ...decision.reason_codes,
        ...invalidConstraints.flatMap((constraint) => constraint.reason_codes),
        ...decision.material_drift.map((item) => item.reason_code),
      ].filter(Boolean).join(", ") || "invalid delivery boundary"}.`);
    }
    if (action === "pull_request.merge") {
      assertMergeNotManual(profile, { italian: humanGuidanceLocale(options) === "it" });
    }
    const allowedActions = deliveryTargetAllowedActions(profile);
    if (!allowedActions.includes(action)) {
      fail(`Delivery action ${action} is outside the approved action set for ${profileId}.`);
    }
    if (profile.constraints?.forbidden_actions?.includes(action)) {
      fail(`Delivery action ${action} is explicitly forbidden by ${profileId}.`);
    }
    if (action === "pull_request.merge" && !completingAction) {
      enforceMergeCodeReview(context, profile, runtimeTarget);
      for (const storyRef of profile.story_refs || []) enforceDeliveredOverlapReview(context, storyRef.id);
    }
    if (
      !completingAction
      && profile.delivery_kind === "local_release"
      && ["rollback.verify", "data.migrate", "data.rollback", "release.local"].includes(action)
    ) {
      validateLocalReleaseFilesystemBoundary(profile.local_release_target);
    }
    const actionPolicy = deliveryActionCheckpointRequired(context, profile, decision.effective_level, action);
    let checkpointRequired = actionPolicy.required;
    const actionIntentIdentity = !completingAction
      && checkpointRequired
      && options["confirm-action"] === true
      ? deliveryActionAuthorizationIntentIdentity(context, profile, action, options)
      : null;
    const pendingActionIntent = readDeliveryActionAuthorizationIntent(
      context,
      actionIntentIdentity,
      profile,
    );
    const consumedIntentCompletion = pendingActionIntent
      ? deliveryActionReceipts(context, profile.id).find((candidate) =>
          candidate.status === "completed"
          && candidate.authorization_receipt_ref?.id
            === pendingActionIntent.action_receipt.id
          && candidate.authorization_receipt_ref?.hash
            === pendingActionIntent.action_receipt.receipt_hash)
      : null;
    const consumedIntentAttempt = pendingActionIntent && action === "release.local"
      ? deliveryActionAttemptReceipts(context, profile.id).find((candidate) =>
          candidate.authorization_receipt_ref?.id
            === pendingActionIntent.action_receipt.id
          && candidate.authorization_receipt_ref?.hash
            === pendingActionIntent.action_receipt.receipt_hash)
      : null;
    if (consumedIntentCompletion || consumedIntentAttempt) {
      fail(
        `Delivery action authorization intent ${pendingActionIntent.id} was already consumed by `
        + (consumedIntentCompletion
          ? `completion ${consumedIntentCompletion.id}. `
          : `write-ahead attempt ${consumedIntentAttempt.id}. `)
        + "Create a new delegated authorization for a new action attempt.",
      );
    }
    const actionReceiptId = pendingActionIntent?.action_receipt?.id
      || `AUT-ACT-${uniqueRecordSuffix()}`;
    const actionReceiptTimestamp = pendingActionIntent?.action_receipt?.authorized_at
      || now();
    const plannedAuthorizationUse = actionIntentIdentity
      ? {
          id: deliveryActionIntentUseReceiptId(actionIntentIdentity),
          path: toProjectPath(
            context,
            authorizationUsePath(
              context,
              actionIntentIdentity.authorizationId,
              deliveryActionIntentUseReceiptId(actionIntentIdentity),
            ),
          ),
        }
      : null;
    const preparedPolicySource = completingAction ? null : buildDeliveryCheckpointPolicySource(context);
    let actionDetails = completingAction
      ? null
      : buildDeliveryActionDetails(context, profile, action, runtimeTarget, options);
    if (
      !completingAction
      && profile.delivery_kind === "local_release"
      && action === "build.local"
    ) {
      actionDetails = {
        ...actionDetails,
        local_target_build_precondition: localTargetBuildAuthorizationPrecondition(
          context,
          profile,
          executionState,
          actionReceiptTimestamp,
        ),
      };
    }
    if (
      !completingAction
      && profile.delivery_kind === "local_release"
      && GOVERNED_LOCAL_TARGET_ACTIONS.includes(action)
    ) {
      actionDetails = {
        ...actionDetails,
        local_target_materialization_ref: requireGovernedLocalReleaseTarget(
          context,
          profile,
          executionState,
          action,
          actionReceiptTimestamp,
        ),
      };
    }
    if (!completingAction && DELIVERY_PROVIDER_ACTIONS.has(action)) {
      const providerOperation = observeDeliveryProviderPrecondition(
        context,
        profile,
        action,
        actionDetails,
        actionReceiptId,
        actionReceiptTimestamp,
      );
      actionDetails = withProviderCompatibilityProjection(action, actionDetails, providerOperation);
    }
    if (!completingAction && action === "git.push") {
      const baseSha = actionDetails.provider_operation?.precondition_receipt?.proof?.base_sha;
      const commitCoverage = assertGitCommitReceiptCoverage(context, profile, {
        ...runtimeTarget,
        base_sha: baseSha,
        remote_branch_sha: actionDetails.provider_operation?.precondition_receipt?.proof?.previous_sha || null,
      });
      // A head behind the base, or a records sync merge, gives a v2 proof
      // that plugins before the feature cannot verify: they ask for an update.
      if (commitCoverage?.schema_version !== "git-commit-coverage:v1" || commitCoverage.remote_branch_sha) {
        recordProjectPluginRequirement(context, "push-behind-base-records");
      }
      actionDetails = {
        ...actionDetails,
        commit_coverage: commitCoverage,
      };
      // Every pushed commit is mediated; the branch must also hold nothing
      // since the task start that another delivery or the base branch
      // brought in without a merged delivery accounting for it.
      const foreign = foreignStoryBranchCommits(context, profile, runtimeTarget.head_sha);
      if (foreign.length > 0) fail(foreignStoryBranchCommitMessage(action, foreign));
    }
    if (!completingAction) {
      actionDetails = {
        ...actionDetails,
        checkpoint_policy: deliveryActionCheckpointPolicySnapshot(
          context,
          profile,
          decision.effective_level,
          action,
          actionPolicy,
          preparedPolicySource.ref,
        ),
      };
    }
    // A delivery proposed under a standing approval treats every action as a
    // confirmation point. The standing approval stands in for the person only
    // while it is active and the exact step, observed changes, and budget stay
    // inside its bounds; otherwise the normal confirmation applies.
    const standingRef = !completingAction && checkpointRequired && options["confirm-action"] !== true
      ? standingApprovalRefForProfile(profile)
      : null;
    let standingCoverage = null;
    if (standingRef) {
      releaseStandingLock = holdStandingApprovalLock(context, standingRef.id);
      standingCoverage = evaluateStandingStepCoverage(context, profile, action);
    }
    const standingCovers = Boolean(standingCoverage && standingCoverage.reasons.length === 0);
    if (!completingAction && checkpointRequired && options["confirm-action"] !== true && !standingCovers) {
      const standingFallback = standingCoverage
        ? {
            standing_approval_id: standingCoverage.loaded.id,
            covered: false,
            reasons: standingCoverage.reasons,
            explanation: standingFallbackMessage(standingCoverage, action),
          }
        : null;
      if (standingFallback) {
        const fallbackAttribution = buildAttribution(context, options, `autonomy.delivery.action.${action}`);
        appendTraceEvent(context, profile.story_refs[0]?.id || null, {
          type: "gate",
          summary: `Standing approval ${standingFallback.standing_approval_id} does not cover ${action} for `
            + `${profile.delivery_id}; normal confirmation required: ${standingFallback.reasons.join("; ")}`,
          action: "autonomy.standing.fallback",
          actor: fallbackAttribution.actor,
          outcome: "blocked",
          related: [standingFallback.standing_approval_id, profile.id, profile.delivery_id],
          request: {
            id: `standing-approval:${standingFallback.standing_approval_id}:fallback:${profile.id}:${action}:${uniqueRecordSuffix()}`,
            source: "autonomy.standing.fallback",
            standing_approval_id: standingFallback.standing_approval_id,
          },
          git: fallbackAttribution.git,
          run: fallbackAttribution.run,
        });
      }
      const guidance = actionCheckpointGuidance({
        status: "checkpoint_required",
        profile_id: profile.id,
        delivery_id: profile.delivery_id,
        action,
        authority_mode: context.config.authority_policy?.mode || "audit_only",
        authority_verified: false,
        host_receipt_required: (context.config.authority_policy?.mode || "audit_only") === "host_verified",
        execution_performed: false,
        merge_executed: false,
        target_root: profile.local_release_target?.root_path || null,
        smoke_cwd: actionDetails?.smoke_cwd || profile.local_release_target?.smoke_cwd || null,
        smoke_tests: profile.local_release_target?.smoke_tests || [],
        data_target: profile.local_release_target?.data_migration?.target_path || null,
        data_scopes: profile.local_release_target?.data_migration?.scopes || [],
        backup_path: profile.local_release_target?.data_migration?.backup?.path || null,
        preview_evidence: (profile.local_release_target?.data_migration?.preview_evidence || [])
          .map((item) => item.path),
        rollback_evidence: (actionDetails?.rollback_verification?.evidence || [])
          .map((item) => item.path),
        rollback: profile.local_release_target?.rollback?.procedure || null,
        reason_codes: ["autonomy.action_checkpoint_required"],
      }, { locale: humanGuidanceLocale(options) });
      output(options, {
        status: "checkpoint_required",
        execution_allowed: false,
        profile_id: profileId,
        action,
        effective_level: decision.effective_level,
        runtime_target: runtimeTarget,
        action_details: actionDetails,
        checkpoints: actionPolicy.checkpoints,
        reason_codes: [
          "autonomy.action_checkpoint_required",
          ...(standingFallback ? ["autonomy.standing_approval_not_covering"] : []),
        ],
        ...(standingFallback ? { standing_approval: standingFallback } : {}),
        human_guidance: guidance,
      }, [
        ...humanGuidanceLines(guidance, [
          `Delivery: ${profile.delivery_id}`,
          `Canonical action: ${action}`,
          `Profile: ${profile.id}`,
          `Checkpoints: ${(actionPolicy.checkpoints || []).join(", ") || "this exact action"}`,
          ...(standingFallback ? [standingFallback.explanation] : []),
          ...(actionDetails?.story_records_missing
            ? [`Warning: the pull request does not carry the story's records (${actionDetails.story_records_missing.join(", ")}); commit them on the story branch so they merge with the code.`]
            : []),
          "No operation was executed.",
        ], options),
      ]);
      return;
    }
    const attribution = buildAttribution(context, options, `autonomy.delivery.action.${action}`);
    let approval = null;
    let approvalAuthorizationSettings = null;
    if (!completingAction && checkpointRequired && standingCovers) {
      requireStandingActor(attribution, `autonomy delivery action ${action}`);
      approvalAuthorizationSettings = {
        subject: {
          profile_id: profile.id,
          profile_hash: profile.profile_hash,
          delivery_id: profile.delivery_id,
          action,
          runtime_target: runtimeTarget,
          action_details: actionDetails,
        },
        subject_id_field: "profile_id",
        subject_id: profile.id,
        status: "approved",
        scope: `delivery-action:${action}`,
        label: `delivery action ${action} for ${profile.id}`,
        standing: standingCoverage,
      };
      approval = {
        ...buildApprovalRecord(context, options, attribution, approvalAuthorizationSettings),
        authority_assurance: standingAuthorityAssurance(context, standingCoverage),
      };
    } else if (!completingAction && checkpointRequired) {
      requireFormalApprovalActor(context, options, attribution, `Authorizing delivery action ${action}`);
      const subject = {
        profile_id: profile.id,
        profile_hash: profile.profile_hash,
        delivery_id: profile.delivery_id,
        action,
        runtime_target: runtimeTarget,
        action_details: actionDetails,
      };
      const authorityAssurance = loadAutonomyAuthorityAssurance(
        context,
        options,
        `autonomy.delivery.action.${action}`,
        subject,
      );
      approvalAuthorizationSettings = {
        subject,
        subject_id_field: "profile_id",
        subject_id: profile.id,
        status: "approved",
        scope: `delivery-action:${action}`,
        label: `delivery action ${action} for ${profile.id}`,
        record_use: false,
        ...(plannedAuthorizationUse
          ? {
              receipt_id: plannedAuthorizationUse.id,
              used_at: actionReceiptTimestamp,
            }
          : {}),
      };
      const candidateApproval = {
        ...buildApprovalRecord(context, options, attribution, approvalAuthorizationSettings),
        authority_assurance: authorityAssurance,
      };
      if (plannedAuthorizationUse) {
        candidateApproval.authorization_use_ref = plannedAuthorizationUse.path;
      }
      if (pendingActionIntent) {
        const currentAuthorization = readAuthorization(
          context,
          actionIntentIdentity.authorizationId,
        );
        if (
          authorizationRecordHash(currentAuthorization)
            !== pendingActionIntent.authorization_ref.hash
        ) {
          fail(
            `Delivery action authorization intent ${pendingActionIntent.id} `
            + "does not match the current delegated authorization.",
          );
        }
        const storedApproval = pendingActionIntent.action_receipt.approval;
        if (
          stableJson(deliveryActionApprovalRecoveryProjection(candidateApproval))
            !== stableJson(deliveryActionApprovalRecoveryProjection(storedApproval))
        ) {
          fail(
            `Delivery action authorization intent ${pendingActionIntent.id} `
            + "does not match this exact approval retry.",
          );
        }
        approval = storedApproval;
      } else {
        approval = candidateApproval;
      }
    }
    const evidence = buildActionEvidence(context, options.evidence);
    const existingActionReceipts = completingAction ? deliveryActionReceipts(context, profile.id) : [];
    const priorAuthorization = completingAction
      ? selectPendingDeliveryActionAuthorization(
          context,
          profile,
          action,
          existingActionReceipts,
          options,
        )
      : null;
    if (
      completingAction
      && action === "rollback.verify"
      && stableJson(evidence) !== stableJson(
        priorAuthorization?.action_details?.rollback_verification?.evidence || [],
      )
    ) {
      fail("rollback.verify completion must use the exact evidence set bound at authorization.");
    }
    let actionAuditWarnings = [];
    if (completingAction) {
      const authorizationValidation = assertCurrentDeliveryActionAuthorization(
        context,
        profile,
        decision,
        actionPolicy,
        priorAuthorization,
      );
      checkpointRequired = authorizationValidation.checkpointRequired;
      actionAuditWarnings = authorizationValidation.auditWarnings;
    }
    if (completingAction) {
      actionDetails = action === "git.commit" && reportedOutcome === "passed"
        ? buildCompletedGitCommitDetails(context, priorAuthorization, runtimeTarget)
        : priorAuthorization.action_details;
    }
    if (
      completingAction
      && profile.delivery_kind === "local_release"
      && action === "build.local"
    ) {
      actionDetails = completedLocalTargetBuildDetails(
        context,
        profile,
        executionState,
        priorAuthorization,
        actionReceiptTimestamp,
        reportedOutcome,
      );
    }
    if (
      completingAction
      && profile.delivery_kind === "local_release"
      && GOVERNED_LOCAL_TARGET_ACTIONS.includes(action)
    ) {
      requireGovernedLocalReleaseTarget(
        context,
        profile,
        executionState,
        action,
        actionReceiptTimestamp,
        priorAuthorization.action_details?.local_target_materialization_ref,
      );
    }
    let currentLocalReleaseIntegrity = null;
    if (completingAction && action === "release.local") {
      const authorizedIntegrity = priorAuthorization.action_details?.local_release_integrity;
      if (!authorizedIntegrity) {
        fail(
          "This historical release.local authorization does not bind the current smoke runner and "
          + "artifact-manifest policy; request a fresh release checkpoint.",
        );
      }
      currentLocalReleaseIntegrity = localReleaseIntegrityAttestation(context, profile);
      if (stableJson(currentLocalReleaseIntegrity) !== stableJson(authorizedIntegrity)) {
        fail(
          "The smoke runner, plugin build, host capability, executable, environment, or artifact-manifest "
          + "policy changed after release.local authorization; request a fresh release checkpoint.",
        );
      }
    }
    if (completingAction && DELIVERY_PROVIDER_ACTIONS.has(action) && reportedOutcome === "passed") {
      const providerOperation = priorAuthorization.action_details?.provider_operation;
      if (providerOperation?.precondition_receipt) {
        const completedProviderOperation = verifyDeliveryProviderCompletion(
          context,
          profile,
          action,
          providerOperation,
          actionReceiptTimestamp,
        );
        actionDetails = withProviderCompatibilityProjection(
          action,
          priorAuthorization.action_details,
          completedProviderOperation,
        );
      } else if (profile.schema_version === "delivery-execution-profile:v1") {
        if (action === "git.push") {
          actionDetails = {
            ...priorAuthorization.action_details,
            remote_verification: verifyLegacyCompletedGitPush(context, priorAuthorization),
          };
        } else if (action === "pull_request.merge") {
          actionDetails = {
            ...priorAuthorization.action_details,
            provider_verification: verifyLegacyCompletedGitHubMerge(profile, priorAuthorization),
          };
        }
      } else {
        fail(`The authorization for ${action} has no verified starting state.`);
      }
    }
    if (completingAction && action === "pull_request.merge" && reportedOutcome === "passed") {
      runtimeTarget = validatePullRequestGitBoundary(context, profile.pull_request_target);
    }
    if (
      completingAction
      && profile.delivery_kind === "pull_request"
      && (action !== "git.commit" || reportedOutcome === "failed")
    ) {
      if (action === "pull_request.merge" && reportedOutcome === "passed") {
        const completionProof = actionDetails?.provider_operation?.completion_receipt?.proof
          || actionDetails?.provider_verification;
        const transition = validatePullRequestMergeRuntimeTransition(
          context,
          priorAuthorization,
          runtimeTarget,
          completionProof,
        );
        if (!transition.valid) {
          fail(`Delivery action ${action} runtime Git target changed outside the exact proven merge transition: ${transition.errors.join("; ")}.`);
        }
      } else if (stableJson(priorAuthorization.runtime_target) !== stableJson(runtimeTarget)) {
        fail(`Delivery action ${action} runtime Git target changed after authorization; request a fresh checkpoint.`);
      }
    }
    if (completingAction && (action === "git.push" || (action === "pull_request.merge" && reportedOutcome !== "passed"))) {
      const currentDetails = buildDeliveryActionDetails(context, profile, action, runtimeTarget, {
        ...options,
        remote: priorAuthorization.action_details?.push?.remote,
        "pr-url": priorAuthorization.action_details?.merge?.pr_url,
      });
      if (stableJson(currentDetails) !== stableJson(remoteAuthorizationProjection(action, priorAuthorization.action_details))) {
        fail(`Delivery action ${action} exact operation changed after authorization; request a fresh checkpoint.`);
      }
    }
    if (completingAction && evidence.length === 0) {
      fail(`Delivery action ${action} completion requires at least one immutable --evidence file.`);
    }
    if (["data.migrate", "data.rollback"].includes(action)) {
      assertDataMigrationPreviewEvidenceCurrent(
        context,
        profile.local_release_target?.data_migration,
      );
    }
    let localReleaseVerification = null;
    let localReleaseAttempt = null;
    if (action === "release.local" && completingAction) {
      const dataMigrationSequence = profile.local_release_target?.data_migration
        ? requireReversibleDataReleaseSequence(context, profile, priorAuthorization)
        : null;
      if (
        dataMigrationSequence
        && stableJson(dataMigrationSequence)
          !== stableJson(priorAuthorization.action_details?.data_migration_sequence)
      ) {
        fail(
          "release.local reversible data sequence changed after authorization; "
          + "request a fresh release checkpoint.",
        );
      }
      const smokeTests = normalizeListOption(options["smoke-test"]).map(normalizeSmokeTestCommand).sort();
      const approvedSmokeTests = [...(profile.local_release_target?.smoke_tests || [])].sort();
      const approvedSmokeCwd = governedLocalSmokeCwd(profile).smokeCwd;
      const reportedSmokeCwdOption = getOptionString(options, "smoke-cwd");
      const reportedSmokeCwd = reportedSmokeCwdOption
        ? path.isAbsolute(reportedSmokeCwdOption)
          ? path.resolve(reportedSmokeCwdOption)
          : path.resolve(profile.local_release_target.root_path, reportedSmokeCwdOption)
        : approvedSmokeCwd;
      if (stableJson(smokeTests) !== stableJson(approvedSmokeTests)) {
        fail("release.local must report the exact approved smoke-test command set.");
      }
      if (reportedSmokeCwd !== approvedSmokeCwd) {
        fail("release.local --smoke-cwd must match the exact approved smoke working directory.");
      }
      if (getOptionString(options, "rollback") !== profile.local_release_target?.rollback?.procedure) {
        fail("release.local must confirm the exact approved rollback procedure with --rollback.");
      }
      if (reportedOutcome === "passed") {
        validateLocalReleaseFilesystemBoundary(profile.local_release_target);
        const exactSmokeCwd = approvedLocalSmokeCwd(profile);
        for (const canonicalCommand of approvedSmokeTests) {
          validateLocalSmokeCommandBoundary(exactSmokeCwd, JSON.parse(canonicalCommand));
        }
        const requiredRollbackVerification = profile.local_release_target?.rollback
          ?.verification_required === true
          ? latestPassingRollbackVerification(context, profile, priorAuthorization)
          : null;
        if (requiredRollbackVerification && !requiredRollbackVerification.receipt) {
          fail(
            "release.local requires a passing rollback.verify receipt for the exact local target, "
            + `procedure, and immutable evidence before starting smoke: ${requiredRollbackVerification.errors.join("; ")}.`,
          );
        }
        const preSmokeArtifactManifest = localReleaseArtifactManifest(context, profile);
        const requestedCompletion = buildDeliveryCompletionRequest(
          context,
          profile,
          action,
          "passed",
          evidence,
          options,
          priorAuthorization,
        );
        const attemptCandidate = buildLocalReleaseActionAttempt(
          context,
          profile,
          priorAuthorization,
          requestedCompletion,
          currentLocalReleaseIntegrity,
          preSmokeArtifactManifest,
        );
        localReleaseAttempt = persistLocalReleaseActionAttempt(
          context,
          profile,
          attemptCandidate,
        ).receipt;
        if (
          process.env.NODE_ENV === "test"
          && process.env.AGENTIC_SDLC_TEST_DELIVERY_ACTION_FAILURE
            === "after-local-release-attempt-before-smoke"
        ) {
          fail(
            "Simulated interruption after local release attempt persistence and before smoke execution.",
          );
        }
        const smokeTestReceipts = runApprovedLocalSmokeTests(
          profile,
          currentLocalReleaseIntegrity.smoke_execution_policy,
        );
        let postSmokeArtifactManifest = null;
        let artifactStable = false;
        try {
          postSmokeArtifactManifest = localReleaseArtifactManifest(context, profile);
          artifactStable = stableJson(postSmokeArtifactManifest) === stableJson(preSmokeArtifactManifest);
        } catch {
          artifactStable = false;
        }
        if (
          process.env.NODE_ENV === "test"
          && process.env.AGENTIC_SDLC_TEST_DELIVERY_ACTION_FAILURE
            === "after-local-release-smoke-before-completion-receipt"
        ) {
          fail(
            "Simulated interruption after local release smoke and before completion receipt persistence.",
          );
        }
        const failedSmokeTestReceipts = smokeTestReceipts.filter((item) => item.outcome !== "passed");
        const attemptPassed = failedSmokeTestReceipts.length === 0 && artifactStable;
        completionOutcome = attemptPassed ? "passed" : "failed";
        localReleaseVerification = {
          target_root: profile.local_release_target.root_path,
          allowed_write_paths: profile.local_release_target.allowed_write_paths,
          smoke_tests: approvedSmokeTests,
          smoke_cwd: approvedSmokeCwd,
          smoke_test_receipts: smokeTestReceipts,
          outcome: completionOutcome,
          evidence,
          rollback: profile.local_release_target.rollback,
          integrity: {
            schema_version: "local-release-completion-integrity:v2",
            authorized_policy: currentLocalReleaseIntegrity,
            pre_smoke_artifact_manifest: preSmokeArtifactManifest,
            post_smoke_artifact_manifest: postSmokeArtifactManifest,
            artifact_stable_during_smoke: artifactStable,
          },
          ...(requiredRollbackVerification?.receipt
            ? {
                rollback_verification_receipt_ref: deliveryActionReceiptRef(
                  context,
                  requiredRollbackVerification.receipt,
                ),
              }
            : {}),
          ...(dataMigrationSequence
            ? { data_migration_sequence: dataMigrationSequence }
            : {}),
        };
        if (!attemptPassed) {
          const smokeBoundary = localSmokeExecutionBoundary();
          const safeDiagnostics = failedSmokeTestReceipts.map((item) => ({
            command: item.command,
            sandbox: item.sandbox,
            exit_code: item.exit_code,
            signal: item.signal,
            error_code: item.error_code,
            stdout_sha256: item.stdout_sha256,
            stderr_sha256: item.stderr_sha256,
          }));
          deferredCompletionFailure = (
            "release.local verification failed; a failed completion receipt was stored, the authorization "
            + "was consumed, and the delivery remains started. Request a fresh authorization before retrying. "
            + `The current runner denies writes and external network; its loopback policy is `
            + `${smokeBoundary.loopback_network}. Portable smoke tests must not depend on sockets. `
            + "For an API, exercise its exported handler in-process; otherwise validate the built artifact files. "
            + "This runner executes reviewed project code and does not provide host-file confidentiality. "
            + `Artifact stable during smoke: ${artifactStable}. `
            + `Safe smoke diagnostics: ${stableJson(safeDiagnostics)}`
          );
        }
      }
    }
    let rollbackVerification = null;
    if (
      completingAction
      && reportedOutcome === "passed"
      && action === "rollback.verify"
    ) {
      const verification = actionDetails?.rollback_verification;
      const providerProof = actionDetails?.provider_operation?.completion_receipt?.proof;
      if (
        providerProof?.transition !== "rollback_evidence_verified"
        || providerProof?.verified !== true
        || providerProof?.root_path !== verification?.target_root
        || stableJson(providerProof?.allowed_write_paths?.map((item) => item.path))
          !== stableJson(verification?.allowed_write_paths)
        || providerProof?.rollback_procedure !== verification?.rollback_procedure
        || stableJson(
          providerProof?.evidence?.map((item) => ({
            path: toProjectPath(context, item.path),
            sha256: item.sha256,
          })),
        ) !== stableJson(verification?.evidence)
      ) {
        fail("rollback.verify completion lacks exact target, procedure, or immutable evidence proof.");
      }
      rollbackVerification = {
        action: "rollback.verify",
        target_root: verification.target_root,
        allowed_write_paths: verification.allowed_write_paths,
        rollback_procedure: verification.rollback_procedure,
        evidence_root: verification.evidence_root,
        evidence: verification.evidence,
        ...(verification.data_rollback_receipt_ref
          ? { data_rollback_receipt_ref: verification.data_rollback_receipt_ref }
          : {}),
        verification: "evidence_verified",
        verified: true,
      };
    }
    let dataOperationVerification = null;
    if (
      completingAction
      && reportedOutcome === "passed"
      && ["data.migrate", "data.rollback"].includes(action)
    ) {
      const providerProof = actionDetails?.provider_operation?.completion_receipt?.proof;
      const migration = profile.local_release_target.data_migration;
      const expectedTransition = action === "data.migrate" ? "migrated" : "rolled_back";
      if (
        providerProof?.transition !== expectedTransition
        || providerProof?.target?.path !== migration.target_path
        || providerProof?.backup?.path !== migration.backup.path
        || stableJson(providerProof?.scopes) !== stableJson(migration.scopes)
      ) {
        fail(`${action} completion lacks exact target, scope, backup, or transition proof.`);
      }
      dataOperationVerification = {
        action,
        transition: expectedTransition,
        target_path: migration.target_path,
        scopes: migration.scopes,
        backup_path: migration.backup.path,
        preview_evidence: migration.preview_evidence,
        before_target_sha256: providerProof.before_target_sha256,
        after_target_sha256: providerProof.after_target_sha256,
        backup_sha256: providerProof.backup_sha256,
        rollback_procedure: profile.local_release_target.rollback.procedure,
        rollback_verified: action === "data.rollback",
      };
    }
    const authorizationGuidance = !completingAction
      ? actionCheckpointGuidance({
          status: "authorized",
          profile_id: profile.id,
          delivery_id: profile.delivery_id,
          action,
          authority_mode: approval?.authority_assurance?.mode || context.config.authority_policy?.mode || "audit_only",
          authority_verified: approval?.authority_assurance?.verified === true,
          host_receipt_required: (context.config.authority_policy?.mode || "audit_only") === "host_verified",
          execution_performed: false,
          merge_executed: false,
          target_root: profile.local_release_target?.root_path || null,
          smoke_cwd: actionDetails?.smoke_cwd || profile.local_release_target?.smoke_cwd || null,
          smoke_tests: profile.local_release_target?.smoke_tests || [],
          data_target: profile.local_release_target?.data_migration?.target_path || null,
          data_scopes: profile.local_release_target?.data_migration?.scopes || [],
          backup_path: profile.local_release_target?.data_migration?.backup?.path || null,
          preview_evidence: (profile.local_release_target?.data_migration?.preview_evidence || [])
            .map((item) => item.path),
          rollback_evidence: (actionDetails?.rollback_verification?.evidence || [])
            .map((item) => item.path),
          rollback: profile.local_release_target?.rollback?.procedure || null,
        }, { locale: humanGuidanceLocale(options) })
      : null;
    const createdAt = actionReceiptTimestamp;
    const completionRequest = completingAction
      ? buildDeliveryCompletionRequest(
          context,
          profile,
          action,
          completionOutcome,
          evidence,
          options,
          priorAuthorization,
        )
      : null;
    const receiptBase = {
      id: actionReceiptId,
      kind: "delivery_action_receipt",
      schema_version: pendingActionIntent?.action_receipt?.schema_version
        || (
          action === "release.local"
            ? "delivery-action-receipt:v3"
            : "delivery-action-receipt:v2"
        ),
      profile_ref: {
        id: profile.id,
        path: toProjectPath(context, profilePath),
        hash: profile.profile_hash,
      },
      delivery: { id: profile.delivery_id, kind: profile.delivery_kind },
      action,
      effective_level: decision.effective_level,
      checkpoint_required: checkpointRequired,
      approval,
      runtime_target: runtimeTarget,
      action_details: actionDetails,
      authorization_receipt_ref: priorAuthorization
        ? {
            id: priorAuthorization.id,
            path: toProjectPath(
              context,
              path.join(autonomyActionsRoot(context), `${normalizeId(priorAuthorization.id)}.json`),
            ),
            hash: priorAuthorization.receipt_hash,
          }
        : null,
      ...(localReleaseAttempt
        ? {
            attempt_receipt_ref: deliveryActionAttemptReceiptRef(
              context,
              profile,
              localReleaseAttempt,
            ),
          }
        : {}),
      ...(completionRequest ? { completion_request: completionRequest } : {}),
      local_release_verification: localReleaseVerification,
      ...(rollbackVerification ? { rollback_verification: rollbackVerification } : {}),
      ...(dataOperationVerification ? { data_operation_verification: dataOperationVerification } : {}),
      evidence,
      outcome: completionOutcome || null,
      status: completingAction ? "completed" : "authorized",
      authorized_by: pendingActionIntent?.action_receipt?.authorized_by || attribution.actor,
      authorized_at: createdAt,
      audit: pendingActionIntent?.action_receipt?.audit
        || { git: attribution.git, run: attribution.run },
    };
    let receipt = {
      ...receiptBase,
      receipt_hash: autonomyLifecycleReceiptHash(receiptBase),
      hash_algorithm: "sha256:stable-json:v1",
    };
    if (completingAction && action === "release.local" && localReleaseVerification) {
      const completionIntegrity = localReleaseCompletionIntegrityErrors(
        context,
        profile,
        receipt,
        priorAuthorization,
        { attempt: localReleaseAttempt },
      );
      if (completionIntegrity.legacy || completionIntegrity.errors.length > 0) {
        fail(
          "Local release completion proof could not be cross-bound to its authorization and "
          + `write-ahead attempt: ${completionIntegrity.errors.join("; ") || "missing integrity proof"}.`,
        );
      }
    }
    assertRecordSchema(receipt, "delivery-action-receipt.schema.json", `Delivery action receipt ${receipt.id}`);
    if (!completingAction) {
      persistDeliveryCheckpointPolicySource(context, preparedPolicySource);
    }
    const receiptPath = path.join(autonomyActionsRoot(context), `${normalizeId(receipt.id)}.json`);
    let actionAuthorizationIntent = pendingActionIntent;
    if (!completingAction && approval?.approval_source === "automation") {
      if (!actionIntentIdentity || !plannedAuthorizationUse) {
        fail(`Automation approval for ${action} is missing its exact recovery identity.`);
      }
      if (pendingActionIntent) {
        if (stableJson(receipt) !== stableJson(pendingActionIntent.action_receipt)) {
          fail(
            `Delivery action authorization intent ${pendingActionIntent.id} `
            + "does not match the currently validated action boundary.",
          );
        }
        receipt = pendingActionIntent.action_receipt;
      } else {
        const currentAuthorization = readAuthorization(
          context,
          actionIntentIdentity.authorizationId,
        );
        actionAuthorizationIntent = buildDeliveryActionAuthorizationIntent(
          context,
          actionIntentIdentity,
          profile,
          action,
          currentAuthorization,
          plannedAuthorizationUse,
          receipt,
          preparedPolicySource,
        );
        writeJsonFile(actionIntentIdentity.path, actionAuthorizationIntent, {
          atomicCreate: true,
          durable: true,
        });
        actionAuthorizationIntent = readDeliveryActionAuthorizationIntent(
          context,
          actionIntentIdentity,
          profile,
        );
      }
      if (
        stableJson(actionAuthorizationIntent.policy_source_ref)
          !== stableJson(preparedPolicySource.ref)
        || stableJson(actionAuthorizationIntent.action_receipt) !== stableJson(receipt)
      ) {
        fail(
          `Delivery action authorization intent ${actionAuthorizationIntent.id} `
          + "does not bind the validated policy source and action receipt.",
        );
      }
      const existingReceipt = fs.existsSync(receiptPath)
        ? readDeliveryLifecycleReceipt(
            context,
            receiptPath,
            "delivery-action-receipt.schema.json",
          )
        : null;
      if (existingReceipt && stableJson(existingReceipt) !== stableJson(receipt)) {
        fail(`Delivery action receipt ${receipt.id} conflicts with its immutable recovery intent.`);
      }
      const automationAuthorization = requireAutomationAuthorization(
        context,
        options,
        attribution.action,
        {
          ...approvalAuthorizationSettings,
          record_use: true,
          receipt_id: plannedAuthorizationUse.id,
          used_at: actionReceiptTimestamp,
        },
      );
      if (
        automationAuthorization.id !== approval.authorization_ref
        || automationAuthorization.__use_receipt?.receipt?.id !== plannedAuthorizationUse.id
        || automationAuthorization.__use_receipt?.path !== plannedAuthorizationUse.path
      ) {
        fail(`Automation approval for ${action} did not produce its exact authorization-use receipt.`);
      }
      if (
        process.env.NODE_ENV === "test"
        && process.env.AGENTIC_SDLC_TEST_DELIVERY_ACTION_FAILURE
          === "after-authorization-use-before-action-receipt"
        && !pendingActionIntent
      ) {
        fail("Simulated interruption after authorization use and before action receipt persistence.");
      }
    }
    const receiptAlreadyPersisted = fs.existsSync(receiptPath);
    if (receiptAlreadyPersisted) {
      const existingReceipt = readDeliveryLifecycleReceipt(
        context,
        receiptPath,
        "delivery-action-receipt.schema.json",
      );
      if (stableJson(existingReceipt) !== stableJson(receipt)) {
        fail(`Delivery action receipt ${receipt.id} is stale or tampered.`);
      }
    }
    writeJsonFile(receiptPath, receipt, { atomicCreate: true, durable: true });
    if (
      process.env.NODE_ENV === "test"
      && process.env.AGENTIC_SDLC_TEST_DELIVERY_ACTION_FAILURE
        === "after-action-receipt-before-trace"
      && !receiptAlreadyPersisted
      && (actionAuthorizationIntent || completingAction)
    ) {
      fail("Simulated interruption after action receipt persistence and before trace persistence.");
    }
    if (
      process.env.NODE_ENV === "test"
      && process.env.AGENTIC_SDLC_TEST_DELIVERY_ACTION_FAILURE === "after-terminal-completion-receipt"
      && completingAction
      && completionOutcome === "passed"
      && terminalStatusForDeliveryAction(action)
    ) {
      fail("Simulated interruption after the terminal completion receipt was persisted.");
    }
    const autoClose = completingAction && completionOutcome === "passed" && terminalStatusForDeliveryAction(action)
      ? repairTerminalDeliveryClose(context, profile, executionState)
      : null;
    const autoClosePath = autoClose?.path || null;
    if (completingAction) {
      ensureDeliveryActionAuthorizationTrace(
        context,
        buildDeliveryActionCompletionTraceEvent(context, profile, receipt),
      );
    } else if (actionAuthorizationIntent) {
      ensureDeliveryActionAuthorizationTrace(
        context,
        actionAuthorizationIntent.trace_event,
      );
    } else if (!receiptAlreadyPersisted) {
      appendTraceEvent(context, profile.story_refs[0]?.id || null, {
        type: action === "release.local" && completingAction ? "release" : "gate",
        summary: `${completingAction ? "Completed" : "Authorized"} ${action} for exact delivery ${profile.delivery_id}`,
        action,
        actor: attribution.actor,
        outcome: completingAction ? completionOutcome : "ready",
        evidence: [
          toProjectPath(context, receiptPath),
          autoClosePath,
          ...evidence.map((item) => item.path),
        ].filter(Boolean),
        related: [profile.id, profile.delivery_id],
        git: attribution.git,
        run: attribution.run,
      });
    }
    if (!completingAction && !receiptAlreadyPersisted && approval?.approval_source === STANDING_APPROVAL_SOURCE) {
      traceStandingApprovalEvent(context, profile.story_refs[0]?.id || null, attribution, {
        kind: "cover",
        coverage: standingCoverage,
        summary: `Standing approval ${standingCoverage.loaded.id} confirmed ${action} for exact delivery ${profile.delivery_id}`,
        related: [profile.id, profile.delivery_id, receipt.id],
        evidence: [toProjectPath(context, receiptPath)],
      });
    }
    if (deferredCompletionFailure) {
      fail(deferredCompletionFailure.replace(
        "Safe smoke diagnostics: ",
        `Failed completion receipt: ${toProjectPath(context, receiptPath)} (${receipt.id}). `
          + "Safe smoke diagnostics: ",
      ));
    }
    const locale = humanGuidanceLocale(options);
    const italian = locale === "it";
    const completedSuccessfully = completionOutcome === "passed";
    const completionGuidance = completingAction
      ? {
          result: completedSuccessfully
            ? (italian ? "L’operazione protetta è stata completata e registrata con successo." : "The protected operation was completed and recorded successfully.")
            : (italian ? "L’operazione protetta è stata registrata come non riuscita." : "The protected operation was recorded as unsuccessful."),
          impact: autoClosePath
            ? (italian ? "Questa consegna è terminata e la scelta usata per svolgerla non può essere riutilizzata." : "This delivery is finished, and its working choice cannot be reused.")
            : completedSuccessfully
              ? (italian ? "La prova del risultato è stata salvata; il lavoro può continuare soltanto con un altro passo già consentito." : "Evidence of the result was saved; work may continue only with another already allowed step.")
              : (italian ? "Il lavoro resta aperto, ma non deve proseguire finché la causa non viene corretta." : "The work remains open, but it should not continue until the cause is corrected."),
          required_decision: completedSuccessfully
            ? (italian ? "Non devi prendere una nuova decisione per registrare questo risultato." : "You do not need to make a new decision to record this result.")
            : (italian ? "Non approvare un nuovo tentativo finché non è chiaro cosa deve cambiare." : "Do not approve another attempt until it is clear what must change."),
          protection_boundary: italian
            ? "È stata registrata soltanto questa operazione esatta. Il risultato non autorizza altre consegne, distribuzioni, produzione, segreti o modifiche fuori dai limiti concordati."
            : "Only this exact operation was recorded. The result does not authorize another delivery, deployment, production, secrets, or changes outside the agreed limits.",
          next_action: autoClosePath
            ? (italian ? "Se serve altro lavoro, crea una nuova scelta separata per la prossima consegna." : "If more work is needed, create a new separate choice for the next delivery.")
            : completedSuccessfully
              ? (italian ? "Continua soltanto con il prossimo passo già consentito per questa consegna." : "Continue only with the next step already allowed for this delivery.")
              : (italian ? "Correggi la causa e richiedi una nuova autorizzazione prima di riprovare." : "Correct the cause and request a fresh authorization before trying again."),
          details: {
            profile_id: profile.id,
            action,
            outcome: completionOutcome,
            receipt_path: toProjectPath(context, receiptPath),
          },
        }
      : null;
    // The pull-request description is written by the host, not by this
    // command, so authorizing a create or update hands over the generated
    // checks table instead of leaving the body to be assembled from memory.
    const bodyChecks = !completingAction && ["pull_request.create", "pull_request.update"].includes(action)
      ? pullRequestBodyChecks(context, profile, locale)
      : null;
    // Delivered work changes the project, so the next step is to record the
    // new state as the successor of the current baseline.
    const baselineRefresh = completingAction && autoClosePath && completedSuccessfully
      && ["pull_request.merge", "release.local"].includes(action)
      ? currentBaselineRefreshSuggestion(context)
      : null;
    if (baselineRefresh && completionGuidance) {
      completionGuidance.next_action = italian
        ? `Aggiorna lo stato del progetto con ${baselineRefresh.command}: le modifiche che vengono da story consegnate sono approvate dalla policy del progetto.`
        : `Record the delivered state with ${baselineRefresh.command}; changes that come from delivered stories are approved by project policy.`;
    }
    output(options, {
      status: completingAction ? "completed" : "authorized",
      ...(receiptAlreadyPersisted ? { idempotent: true } : {}),
      ...(baselineRefresh ? { baseline_refresh: baselineRefresh } : {}),
      ...(bodyChecks ? { pull_request_body_checks: bodyChecks } : {}),
      execution_allowed: !completingAction,
      profile_id: profile.id,
      action,
      effective_level: decision.effective_level,
      checkpoint_required: checkpointRequired,
      action_receipt: receipt,
      action_receipt_path: toProjectPath(context, receiptPath),
      lifecycle_status: autoClosePath ? "terminal" : "started",
      close_receipt_path: autoClosePath,
      audit_warnings: actionAuditWarnings,
      human_guidance: completingAction ? completionGuidance : authorizationGuidance,
    }, completingAction
      ? humanGuidanceLines(completionGuidance, [
          `- Profile: ${profile.id}`,
          `- Delivery: ${profile.delivery_id}`,
          `- Canonical action: ${action}`,
          `- Outcome: ${completionOutcome}`,
          `- Evidence record: ${toProjectPath(context, receiptPath)}`,
        ].map((line) => line.replace(/^- /u, "")), options)
      : humanGuidanceLines(authorizationGuidance, [
          `Delivery: ${profile.delivery_id}`,
          `Canonical action: ${action}`,
          `Profile: ${profile.id}`,
          `Authorization record: ${toProjectPath(context, receiptPath)}`,
          "No operation was executed by this authorization.",
          ...(bodyChecks
            ? [italian
                ? `Inserisci i controlli registrati nella descrizione della pull request: ${bodyChecks.command}`
                : `Put the recorded checks in the pull-request description: ${bodyChecks.command}`]
            : []),
          ...(approval?.approval_source === STANDING_APPROVAL_SOURCE
            ? [
                `Confirmed by standing approval ${standingCoverage.loaded.id}`
                + `${approval.standing_approval_ref?.host_receipt_ref ? " (signed by the trusted host)" : ""}; `
                + "no separate confirmation was requested.",
              ]
            : []),
        ], options));
  } finally {
    if (releaseStandingLock) releaseStandingLock();
    releaseLock();
  }
}

/**
 * The checks table to put in a pull-request description, with the command that
 * prints it again. The table is informational, so a record that cannot be read
 * leaves the table out and says why; it never stops the authorization.
 */
function pullRequestBodyChecks(context, profile, locale) {
  const command = `agentic-sdlc autonomy delivery checks --id ${profile.id} --format markdown`;
  try {
    return { command, markdown: buildDeliveryChecks(context, profile, { locale }).markdown.trimEnd() };
  } catch (error) {
    // The reason comes from a failure over project records, so it is shown
    // under the same privacy rules as the table.
    let reason = "The checks table could not be built.";
    try {
      reason = presentUnderPrivacyRules(context, String(error?.message || error), "checks table failure");
    } catch {
      // Keep the generic reason rather than print text that could not be checked.
    }
    return { command, markdown: null, unavailable_reason: reason };
  }
}

function readyForReviewCloseBinding(context, profile, executionState) {
  const actions = deliveryActionReceipts(context, profile.id);
  const { completion, errors } = pullRequestReadyForReviewCompletion(profile, actions);
  if (errors.length > 0) {
    fail(`Delivery ${profile.delivery_id} cannot close as ready_for_review: ${errors.join("; ")}.`);
  }
  const validation = { strict: true, errors: [], warnings: [], checked: [] };
  validateDeliveryExecutionReceipts(
    context,
    validation,
    profile,
    executionState,
    `delivery autonomy profile ${profile.id}`,
  );
  if (validation.errors.length > 0) {
    fail(`Delivery ${profile.delivery_id} cannot close as ready_for_review: ${validation.errors.join("; ")}`);
  }
  const authorization = actions.find((receipt) =>
    receipt.id === completion.authorization_receipt_ref?.id
    && receipt.receipt_hash === completion.authorization_receipt_ref?.hash
    && receipt.status === "authorized");
  if (!authorization) {
    fail(`Pull-request completion ${completion.id} lacks its exact authorization receipt.`);
  }
  return {
    completion,
    approval: authorization.approval || {
      status: "derived-from-approved-delivery-profile",
      profile_approval_ref: profile.approval_ref,
    },
  };
}

export function closeDeliveryAutonomy(context, options) {
  ensureInitialized(context);
  const profileId = normalizeId(requireOption(options, "id"));
  const terminalStatus = requireOption(options, "terminal-status");
  const reason = requireOption(options, "reason");
  if (!DELIVERY_TERMINAL_STATUSES.has(terminalStatus)) {
    fail(`Unknown terminal status '${terminalStatus}'.`);
  }
  const profilePath = deliveryAutonomyPath(context, profileId);
  const releaseLock = acquireFileLock(`${profilePath}.lock`);
  try {
    const profile = readDeliveryAutonomyProfile(context, profileId);
    const allowedStatuses = profile.delivery_kind === "pull_request"
      ? new Set(["merged", "ready_for_review", "closed", "cancelled", "superseded", "revoked"])
      : new Set(["released", "rolled_back", "cancelled", "superseded", "revoked"]);
    if (!allowedStatuses.has(terminalStatus)) {
      fail(`${terminalStatus} is not a valid terminal status for ${profile.delivery_kind}.`);
    }
    if (["merged", "merged_externally", "released", "revoked"].includes(terminalStatus)) {
      fail(terminalStatus === "revoked"
        ? "revoked is derived from a validated autonomy delivery revoke record; use autonomy delivery revoke instead."
        : terminalStatus === "merged_externally"
          ? "merged_externally is derived from a person's verified acknowledgement; use autonomy delivery reconcile instead."
        : `${terminalStatus} is derived automatically from a completed passing terminal action receipt; use autonomy delivery action instead.`);
    }
    const state = currentDeliveryExecutionState(context, profile);
    if (state.lifecycle_status === "terminal") {
      fail(`Delivery ${profile.delivery_id} is already terminal as ${state.status}.`);
    }
    if (state.lifecycle_status !== "started") {
      fail(
        `Delivery ${profile.delivery_id} cannot close before its immutable start receipt exists. `
        + `A delivery that never started ends with 'autonomy delivery revoke --id ${profile.id} --reason <reason>'.`,
      );
    }
    const attribution = buildAttribution(context, options, "autonomy.delivery.close");
    // ready_for_review is bound to verified PR evidence under the already
    // approved profile, like merged; every other manual close is a new decision.
    const readyForReview = terminalStatus === "ready_for_review"
      ? readyForReviewCloseBinding(context, profile, state)
      : null;
    if (!readyForReview) {
      requireFormalApprovalActor(context, options, attribution, `Closing delivery ${profile.delivery_id}`);
    }
    const subject = {
      profile_id: profile.id,
      profile_hash: profile.profile_hash,
      start_receipt_hash: state.start_receipt.receipt_hash,
      terminal_status: terminalStatus,
      reason,
    };
    const approval = readyForReview
      ? readyForReview.approval
      : buildApprovalRecord(context, options, attribution, {
          subject,
          subject_id_field: "profile_id",
          subject_id: profile.id,
          status: "approved",
          scope: `delivery-terminal:${terminalStatus}`,
          label: `delivery close ${profile.id}`,
        });
    const closedAt = now();
    const closeBase = {
      id: `AUT-CLOSE-${normalizeId(profile.id)}`,
      kind: "delivery_close_receipt",
      schema_version: "delivery-close-receipt:v1",
      profile_ref: {
        id: profile.id,
        path: toProjectPath(context, profilePath),
        hash: profile.profile_hash,
      },
      delivery: { id: profile.delivery_id, kind: profile.delivery_kind },
      start_receipt_ref: {
        id: state.start_receipt.id,
        path: state.start_receipt_path,
        hash: state.start_receipt.receipt_hash,
      },
      terminal_action_receipt_ref: readyForReview
        ? deliveryActionReceiptRef(context, readyForReview.completion)
        : null,
      terminal_status: terminalStatus,
      reason,
      approval,
      closed_by: attribution.actor,
      closed_at: closedAt,
      audit: { git: attribution.git, run: attribution.run },
    };
    const closeReceipt = {
      ...closeBase,
      receipt_hash: autonomyLifecycleReceiptHash(closeBase),
      hash_algorithm: "sha256:stable-json:v1",
    };
    assertRecordSchema(closeReceipt, "delivery-close-receipt.schema.json", `Delivery close receipt ${profile.id}`);
    const closePath = deliveryCloseReceiptPath(context, profile.id);
    writeJsonFile(closePath, closeReceipt, { atomicCreate: true });
    appendTraceEvent(context, profile.story_refs[0]?.id || null, {
      type: "release",
      summary: `Closed ${profile.delivery_kind} ${profile.delivery_id} as ${terminalStatus}`,
      action: "autonomy.delivery.close",
      actor: attribution.actor,
      outcome: "passed",
      evidence: [toProjectPath(context, closePath)],
      related: [profile.id, profile.delivery_id],
      git: attribution.git,
      run: attribution.run,
    });
    const italian = humanGuidanceLocale(options) === "it";
    const closeGuidance = {
      result: italian
        ? "Questa consegna è stata chiusa come richiesto."
        : "This delivery was closed as requested.",
      impact: italian
        ? "La scelta usata per svolgerla è terminata e non può essere riutilizzata."
        : "Its working choice has ended and cannot be reused.",
      required_decision: italian
        ? "Non devi prendere un’altra decisione per completare questa chiusura."
        : "You do not need to make another decision to complete this closure.",
      protection_boundary: italian
        ? "La chiusura non ha eseguito merge, rilasci, distribuzioni, accessi alla produzione o modifiche fuori dai limiti concordati."
        : "The closure did not merge, release, deploy, access production, or change anything outside the agreed limits.",
      next_action: italian
        ? "Se serve altro lavoro, crea una nuova scelta separata per la prossima consegna."
        : "If more work is needed, create a new separate choice for the next delivery.",
      details: { profile_id: profile.id, terminal_status: terminalStatus },
    };
    output(options, {
      status: "terminal",
      terminal_status: terminalStatus,
      close_receipt: closeReceipt,
      close_receipt_path: toProjectPath(context, closePath),
      human_guidance: closeGuidance,
    }, humanGuidanceLines(closeGuidance, [
      `Profile: ${profile.id}`,
      `Delivery: ${profile.delivery_id}`,
      `Terminal status: ${terminalStatus}`,
      `Evidence record: ${toProjectPath(context, closePath)}`,
    ], options));
  } finally {
    releaseLock();
  }
}

export function showDeliveryAutonomy(context, options) {
  ensureInitialized(context);
  const id = options.id ? normalizeId(String(options.id)) : null;
  const italianMetrics = humanGuidanceLocale(options) === "it";
  let actionReceiptsForMetrics = null;
  const profiles = safeReadDir(deliveryAutonomyRoot(context))
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const fileId = path.basename(name, ".json");
      if (id && fileId !== id) return null;
      try {
        return { profile: readDeliveryAutonomyProfile(context, fileId), read_failure: null };
      } catch {
        let raw = {};
        try {
          raw = readProjectJson(context, path.join(deliveryAutonomyRoot(context), name));
        } catch {
          raw = {};
        }
        const deliveryKind = ["pull_request", "local_release"].includes(raw?.delivery_kind)
          ? raw.delivery_kind
          : "pull_request";
        const requestedLevel = AUTONOMY_LEVELS.includes(raw?.requested_level)
          ? raw.requested_level
          : "supervised";
        let deliveryId = fileId;
        try {
          deliveryId = normalizeId(String(raw?.delivery_id || fileId));
        } catch {
          deliveryId = fileId;
        }
        return {
          profile: {
            id: fileId,
            status: "invalid",
            delivery_id: deliveryId,
            delivery_kind: deliveryKind,
            requested_level: requestedLevel,
            authority_assurance: { mode: "invalid", verified: false },
            pull_request_target: { merge_allowed: false },
          },
          read_failure: {
            code: "autonomy_profile_evaluation_failed",
            message: "The delivery profile could not be validated and no permission was inferred from it.",
          },
        };
      }
    })
    .filter(Boolean)
    .map(({ profile, read_failure: readFailure }) => {
      let execution = {
        lifecycle_status: "unavailable",
        status: "needs_repair",
        active_run_count: 0,
        start_receipt_path: null,
        close_receipt_path: null,
        close_receipt: null,
      };
      let decision = null;
      let evaluationFailure = readFailure;
      let effectiveStatus = evaluationFailure ? "needs_repair" : profile.status;
      if (!evaluationFailure) {
        execution = currentDeliveryExecutionState(context, profile);
        effectiveStatus = effectiveDeliveryProfileStatus(context, profile).status;
        if (profile.status === "active") {
          try {
            decision = evaluateDeliveryAutonomy(context, profile, {
              id: `AUT-STATUS-${uniqueRecordSuffix()}`,
            }).decision;
          } catch {
            decision = null;
            effectiveStatus = "needs_repair";
            evaluationFailure = {
              code: "autonomy_profile_evaluation_failed",
              message: "The approved delivery boundary could not be validated against the current project state.",
            };
          }
        }
      }
      if (evaluationFailure) process.exitCode = 1;
      // Lead time and cost are read from the records only; they never change
      // what the delivery may do.
      let metrics = null;
      if (!readFailure) {
        actionReceiptsForMetrics ??= readableDeliveryActionReceipts(context).receipts;
        metrics = deliveryMetrics(context, profile, { actionReceipts: actionReceiptsForMetrics });
      }
      const guidance = deliveryAutonomyStatusGuidance({
        status: execution.lifecycle_status === "terminal"
          ? "terminal"
          : evaluationFailure
            ? "needs_repair"
            : effectiveStatus,
        profile_id: profile.id,
        delivery_id: profile.delivery_id,
        delivery_kind: profile.delivery_kind,
        requested_level: profile.requested_level,
        effective_level: evaluationFailure ? "supervised" : decision?.effective_level,
        capped_level: profile.effective_level,
        authority_assurance: profile.authority_assurance,
        merge_allowed: profile.pull_request_target?.merge_allowed === true,
        merge_executed: execution.close_receipt?.terminal_status === "merged",
        merged_externally: execution.close_receipt?.terminal_status === "merged_externally",
        reason_codes: evaluationFailure ? [evaluationFailure.code] : decision?.reason_codes || [],
      }, { locale: humanGuidanceLocale(options) });
      return {
        ...profile,
        effective_status: evaluationFailure ? "needs_repair" : effectiveStatus,
        lifecycle_status: execution.lifecycle_status,
        delivery_status: execution.status,
        active_run_count: execution.active_run_count,
        start_receipt_path: execution.start_receipt_path,
        close_receipt_path: execution.close_receipt_path,
        current_autonomy_decision: decision,
        evaluation_failure: evaluationFailure,
        merge_authorization: deliveryMergeAuthorization(profile),
        lead_time: metrics?.lead_time ?? null,
        usage: metrics?.usage ?? null,
        ...(metrics?.usage_error ? { usage_error: metrics.usage_error } : {}),
        metric_lines: metrics ? describeDeliveryMetrics(metrics, { italian: italianMetrics }) : [],
        human_guidance: guidance,
      };
    });
  if (id && profiles.length === 0) fail(`Delivery autonomy profile ${id} does not exist.`);
  const locale = humanGuidanceLocale(options);
  const italian = locale === "it";
  const profilesNeedingRepair = profiles.filter((profile) => profile.effective_status === "needs_repair").length;
  const profilesNeedingDecision = profiles.filter((profile) => profile.effective_status === "proposed").length;
  const activeProfiles = profiles.filter((profile) => profile.lifecycle_status === "started").length;
  const listGuidance = profiles.length === 0
    ? {
        result: italian ? "Non esistono ancora scelte di lavoro per consegne concrete." : "There are no working choices for concrete deliveries yet.",
        impact: italian ? "Nessuna consegna può ereditare automaticamente un livello di autonomia." : "No delivery can inherit a level of autonomy automatically.",
        required_decision: italian ? "Non devi decidere nulla finché non viene preparata una consegna concreta." : "You do not need to decide anything until a concrete delivery is prepared.",
        protection_boundary: italian ? "Il requisito da solo non autorizza lavoro, merge, rilasci, produzione, segreti o modifiche." : "The requirement alone authorizes no work, merge, release, production, secrets, or changes.",
        next_action: italian ? "Quando prepari la prossima consegna, scegli separatamente come devo lavorare." : "When the next delivery is prepared, choose separately how I should work.",
        details: {},
      }
    : {
        result: italian
          ? `Ho trovato ${profiles.length} ${profiles.length === 1 ? "scelta separata" : "scelte separate"} per consegne concrete.`
          : `I found ${profiles.length} separate working ${profiles.length === 1 ? "choice" : "choices"} for concrete deliveries.`,
        impact: profilesNeedingRepair > 0
          ? (italian ? "Almeno una scelta non può essere verificata e non deve essere usata finché non viene corretta." : "At least one choice cannot be verified and must not be used until it is corrected.")
          : activeProfiles > 0
            ? (italian ? "Almeno una consegna è in corso; ogni scelta vale soltanto per la propria consegna e non può essere riutilizzata." : "At least one delivery is in progress; each choice applies only to its own delivery and cannot be reused.")
            : (italian ? "Ogni scelta vale soltanto per la propria consegna e non può essere riutilizzata." : "Each choice applies only to its own delivery and cannot be reused."),
        required_decision: profilesNeedingRepair > 0
          ? (italian ? "Non approvare altro lavoro per la scelta non verificabile finché il problema non è risolto." : "Do not approve more work for the unverifiable choice until the problem is fixed.")
          : profilesNeedingDecision > 0
            ? (italian ? "Esamina separatamente ogni scelta ancora in attesa prima di iniziare quella consegna." : "Review each pending choice separately before starting that delivery.")
            : (italian ? "In questo momento non serve una nuova decisione per le consegne già concordate." : "No new decision is needed now for deliveries already agreed."),
        protection_boundary: italian
          ? "Nessuna scelta vale per un’altra consegna; merge, distribuzione, produzione, segreti e file non concordati restano separati."
          : "No choice applies to another delivery; merges, deployment, production, secrets, and unagreed files remain separate.",
        next_action: profilesNeedingRepair > 0
          ? (italian ? "Apri i dettagli facoltativi della scelta non verificabile e correggila prima di continuare." : "Open the optional details for the unverifiable choice and correct it before continuing.")
          : profilesNeedingDecision > 0
            ? (italian ? "Apri la scelta in attesa e decidi soltanto per quella consegna." : "Open the pending choice and decide only for that delivery.")
            : (italian ? "Continua ogni consegna soltanto entro i limiti già concordati." : "Continue each delivery only within its already agreed limits."),
        details: {
          profile_count: profiles.length,
          needs_repair: profilesNeedingRepair,
          needs_decision: profilesNeedingDecision,
          active: activeProfiles,
        },
      };
  const humanLines = profiles.length === 1
      ? humanGuidanceLines(profiles[0].human_guidance, [
        `Profile: ${profiles[0].id}`,
        `Delivery: ${profiles[0].delivery_id}`,
        `Usability: ${profiles[0].effective_status === "needs_repair" ? "needs repair" : profiles[0].effective_status}`,
        `Requested technical level: ${profiles[0].requested_level}`,
        ...(profiles[0].human_guidance.details.capped_by_ceiling
          ? [`Capped by the approved ceiling: ${profiles[0].human_guidance.details.capped_level}`]
          : []),
        `Effective technical level: ${profiles[0].human_guidance.details.effective_level}`,
        `Lifecycle: ${profiles[0].lifecycle_status}`,
        ...mergeInconsistencyLines(profiles[0]),
        ...profiles[0].metric_lines,
        ...autonomyVerificationTechnicalLines(profiles[0].human_guidance, options),
        ...(profiles[0].human_guidance.details.reason_codes.length > 0
          ? [`Technical reason codes: ${profiles[0].human_guidance.details.reason_codes.join(", ")}`]
          : []),
      ], options)
    : humanGuidanceLines(listGuidance, profiles.flatMap((profile) => [
        `Profile: ${profile.id}`,
        `Delivery: ${profile.delivery_id}`,
        `Usability: ${profile.effective_status === "needs_repair" ? "needs repair" : profile.effective_status}`,
        `Lifecycle: ${profile.lifecycle_status}`,
        ...mergeInconsistencyLines(profile),
        ...profile.metric_lines,
        `Effective technical level: ${profile.human_guidance.details.effective_level}`,
        ...(profile.human_guidance.details.reason_codes.length > 0
          ? [`Technical reason codes: ${profile.human_guidance.details.reason_codes.join(", ")}`]
          : []),
      ]), options);
  output(options, {
    delivery_profiles: profiles.map(({ metric_lines: _lines, ...profile }) => profile),
    human_guidance: profiles.length === 1 ? profiles[0].human_guidance : listGuidance,
  }, humanLines);
}

export function explainDeliveryAutonomy(context, options) {
  ensureInitialized(context);
  const profileId = normalizeId(requireOption(options, "id"));
  const profile = readDeliveryAutonomyProfile(context, profileId);
  if (profile.status !== "active") {
    const guidance = deliveryAutonomyStatusGuidance({
      status: profile.status,
      profile_id: profile.id,
      delivery_id: profile.delivery_id,
      delivery_kind: profile.delivery_kind,
      requested_level: profile.requested_level,
      capped_level: profile.effective_level,
      authority_assurance: profile.authority_assurance,
      merge_allowed: profile.pull_request_target?.merge_allowed === true,
    }, { locale: humanGuidanceLocale(options) });
    const reviewStatus = codeReviewStatus(context, profile);
    output(options, { delivery_profile: profile, autonomy_decision: null, code_review: reviewStatus, human_guidance: guidance }, [
      ...humanGuidanceLines(guidance, [
        `Profile: ${profileId}`,
        `Profile status: ${profile.status}`,
        ...autonomyVerificationTechnicalLines(guidance, options),
      ], options),
      ...codeReviewStatusLines(reviewStatus, { italian: humanGuidanceLocale(options) === "it" }),
      ...mergeDecisionLines(profile, options),
    ]);
    return;
  }
  const { decision } = evaluateDeliveryAutonomy(context, profile, {
    id: `AUT-DEC-${uniqueRecordSuffix()}`,
    phase: getOptionString(options, "phase") || undefined,
  });
  if (options.out) {
    const outputPath = resolveProjectFilePath(context, options.out, { mustExist: false });
    writeJsonFile(outputPath, decision, { force: Boolean(options.force), forceOption: true });
  }
  const guidance = deliveryAutonomyStatusGuidance({
    status: "active",
    profile_id: profile.id,
    delivery_id: profile.delivery_id,
    delivery_kind: profile.delivery_kind,
    requested_level: decision.requested_level,
    effective_level: decision.effective_level,
    authority_assurance: profile.authority_assurance,
    merge_allowed: profile.pull_request_target?.merge_allowed === true,
    reason_codes: decision.reason_codes,
  }, { locale: humanGuidanceLocale(options) });
  const reviewStatus = codeReviewStatus(context, profile);
  output(options, { delivery_profile: profile, autonomy_decision: decision, code_review: reviewStatus, human_guidance: guidance }, [
    ...humanGuidanceLines(guidance, [
      `Profile: ${profile.id}`,
      `Delivery: ${profile.delivery_id}`,
      `Requested technical level: ${decision.requested_level}`,
      `Effective technical level: ${decision.effective_level}`,
      `Execution status: ${decision.execution_status}`,
      ...autonomyVerificationTechnicalLines(guidance, options),
      ...(decision.reason_codes.length > 0 ? [`Technical reason codes: ${decision.reason_codes.join(", ")}`] : []),
    ], options),
    ...codeReviewStatusLines(reviewStatus, { italian: humanGuidanceLocale(options) === "it" }),
    ...mergeDecisionLines(profile, options),
  ]);
}

function mergeInconsistencyLines(profile) {
  const merge = profile.merge_authorization;
  if (!merge || merge.consistent) return [];
  return [
    `Merge authority INCONSISTENT: ${merge.problem}; pull_request.merge stays refused until repaired.`,
    `Repair: autonomy delivery amend --id ${profile.id} --merge-allowed --actor-type human --approval-source explicit-user --summary "<your words>".`,
  ];
}

function mergeDecisionLines(profile, options) {
  return profile.pull_request_target?.merge_decision
    ? [mergeDecisionSentence(profile, { italian: humanGuidanceLocale(options) === "it" })]
    : [];
}

export function validateReleaseManifestIntegrity(context, manifest) {
  const errors = [];
  const schema = validateRecordSchema(manifest, "release-manifest.schema.json");
  errors.push(...schema.errors.map((error) => `${error.instance_path}: ${error.message}`));
  const { manifest_hash: actualHash, hash_algorithm: _algorithm, ...hashSubject } = manifest || {};
  const expectedHash = shortHashFull(stableJson(hashSubject));
  if (!actualHash || actualHash !== expectedHash) {
    errors.push("manifest_hash does not match canonical manifest content");
  }
  if (manifest?.status !== "released") {
    errors.push(`manifest status must be released, received '${manifest?.status || "missing"}'`);
  }
  const project = readProjectSafe(context);
  if (!project || manifest?.project?.id !== project.project_id) {
    errors.push(`manifest project ${manifest?.project?.id || "missing"} does not match ${project?.project_id || "the initialized project"}`);
  }
  if (manifest?.source_revision?.type === "git") {
    if (
      !manifest.audit?.git?.is_git_repo ||
      manifest.source_revision.value !== manifest.audit.git.head_sha ||
      manifest.source_revision.branch !== manifest.audit.git.branch ||
      manifest.source_revision.dirty !== Boolean(manifest.audit.git.is_dirty)
    ) {
      errors.push("manifest source_revision does not match its captured git audit state");
    }
  } else if (manifest?.source_revision?.type === "snapshot") {
    const projectFile = path.join(context.sdlcRoot, "project.json");
    if (
      !fs.existsSync(projectFile) ||
      manifest.source_revision.value !== hashFile(projectFile) ||
      manifest.source_revision.branch !== null ||
      manifest.source_revision.dirty !== false
    ) {
      errors.push("manifest snapshot source_revision does not match the canonical project snapshot");
    }
  } else {
    errors.push("manifest source_revision has an unsupported type");
  }
  const expectedRollbackTarget = manifest?.source_revision?.type === "git" ? manifest.source_revision.value : null;
  if (
    manifest?.rollback?.available !== Boolean(expectedRollbackTarget) ||
    manifest?.rollback?.target_revision !== expectedRollbackTarget ||
    !Array.isArray(manifest?.rollback?.instructions) ||
    manifest.rollback.instructions.length === 0
  ) {
    errors.push("manifest rollback policy is not bound to the released source revision");
  }

  const checkReference = (reference, label, options = {}) => {
    if (!reference?.path) {
      errors.push(`${label} has no path`);
      return null;
    }
    let filePath;
    try {
      filePath = resolveProjectFilePath(context, reference.path, { mustExist: true, fileOnly: true });
      assertNoSymlinkPathSegments(filePath, context.root);
    } catch (error) {
      errors.push(`${label}: ${error.message}`);
      return null;
    }
    if (options.expectedPath && path.resolve(filePath) !== path.resolve(options.expectedPath)) {
      errors.push(`${label} path is not its canonical location`);
    }
    if (options.expectedRoot && !isInsidePath(options.expectedRoot, filePath)) {
      errors.push(`${label} path is outside its canonical record root`);
    }
    let record = null;
    let computedHash = null;
    try {
      if (options.record === false) {
        computedHash = hashFile(filePath);
      } else {
        record = readProjectJson(context, filePath);
        if (reference.id && record.id && normalizeId(record.id) !== normalizeId(reference.id)) {
          errors.push(`${label} reference id does not match record id ${record.id}`);
        }
        if (options.schema) {
          const recordSchema = validateRecordSchema(record, options.schema);
          errors.push(...recordSchema.errors.map((error) => `${label} ${error.instance_path}: ${error.message}`));
        }
        if (options.integrity) {
          const integrity = options.integrity(record);
          if (!integrity.valid) {
            errors.push(...integrity.errors.map((error) => `${label}: ${error}`));
          }
          computedHash = integrity.expected_hash || integrity.expectedHash || null;
        } else {
          computedHash = hashFile(filePath);
        }
      }
    } catch (error) {
      errors.push(`${label}: ${error.message}`);
      return { filePath, record };
    }
    if (!computedHash) {
      errors.push(`${label} has no independently computed digest`);
    } else if (reference.hash !== computedHash) {
      errors.push(`${label} hash is stale for ${reference.path}`);
    }
    return { filePath, record, computedHash };
  };

  const proposalResults = [];
  for (const reference of manifest.requirements || []) {
    checkReference(reference, `requirement ${reference.id}`, {
      expectedPath: requirementPath(context, reference.id),
      schema: "requirement.schema.json",
    });
  }
  for (const reference of manifest.stories || []) {
    checkReference(reference, `story ${reference.id}`, {
      expectedPath: path.join(context.sdlcRoot, "stories", normalizeId(reference.id), "story.json"),
      schema: "story.schema.json",
    });
  }
  for (const reference of manifest.contracts || []) {
    checkReference(reference, `contract ${reference.id}`, {
      expectedPath: path.join(context.sdlcRoot, "contracts", `${normalizeId(reference.id)}.json`),
      schema: "contract.schema.json",
    });
  }
  for (const reference of manifest.proposals || []) {
    proposalResults.push(checkReference(reference, `proposal ${reference.id}`, {
      expectedPath: assessmentProposalPath(context, reference.id),
      schema: "assessment-proposal.schema.json",
      integrity: validateProposalIntegrity,
    }));
  }
  const proposalRecord = proposalResults.find((item) => item?.record)?.record || null;
  if (!proposalRecord || proposalResults.length !== 1) {
    errors.push("released assessment manifest must contain exactly one valid proposal");
  }

  let workflowRecord = null;
  if (manifest.workflow) {
    const workflowResult = checkReference(manifest.workflow, `workflow ${manifest.workflow.id}`, {
      expectedPath: assessmentWorkflowPath(context, manifest.workflow.id),
      schema: "assessment-workflow.schema.json",
      integrity: validateAssessmentWorkflowIntegrity,
    });
    workflowRecord = workflowResult?.record || null;
    if (workflowRecord) {
      if (workflowRecord.state !== manifest.workflow.state || workflowRecord.state !== "completed") {
        errors.push(`workflow ${manifest.workflow.id} is not completed at the released state`);
      }
      if (proposalRecord && workflowRecord.proposal_hash !== proposalRecord.proposal_hash) {
        errors.push("workflow proposal hash does not match the released proposal");
      }
    }
  }

  let applicationRecord = null;
  let approvalRecord = null;
  let authorizationRecord = null;
  if (proposalRecord) {
    try {
      const approval = readAssessmentApproval(context, proposalRecord.id);
      approvalRecord = approval;
      if (
        approval.status !== "approved" ||
        approval.proposal_hash !== proposalRecord.proposal_hash ||
        (workflowRecord && approval.authorization_ref !== workflowRecord.authorization_ref)
      ) {
        errors.push(`assessment approval ${approval.id} is not bound to the released proposal/workflow`);
      }
    } catch (error) {
      errors.push(`assessment approval: ${error.message}`);
    }
    try {
      applicationRecord = readAssessmentApplication(context, proposalRecord.id);
      if (
        applicationRecord.status !== "completed" ||
        applicationRecord.proposal_hash !== proposalRecord.proposal_hash ||
        applicationRecord.release_manifest_ref?.id !== manifest.id ||
        applicationRecord.release_manifest_ref?.manifest_hash !== manifest.manifest_hash
      ) {
        errors.push(`assessment application ${applicationRecord.id} is not completed against this release manifest`);
      }
    } catch (error) {
      errors.push(`assessment application: ${error.message}`);
    }
    const taskStartPath = path.join(context.sdlcRoot, "stories", proposalRecord.story_reservation?.id || "missing", "task-start.json");
    try {
      const taskStart = readProjectJson(context, taskStartPath);
      const taskSchema = validateRecordSchema(taskStart, "task-start-receipt.schema.json");
      errors.push(...taskSchema.errors.map((error) => `task start ${error.instance_path}: ${error.message}`));
      if (
        taskStart.status !== "confirmed" ||
        taskStart.proposal_ref?.id !== proposalRecord.id ||
        taskStart.proposal_ref?.hash !== proposalRecord.proposal_hash ||
        taskStart.budget_ref?.hash !== proposalRecord.execution_budget?.budget_hash
      ) {
        errors.push("task-start receipt is not bound to the released proposal and base budget");
      }
    } catch (error) {
      errors.push(`task-start receipt: ${error.message}`);
    }
    if (workflowRecord?.authorization_ref) {
      try {
        const authorization = readAuthorization(context, workflowRecord.authorization_ref);
        authorizationRecord = authorization;
        const authorizationIntegrity = validateAuthorizationSnapshotIntegrity(authorization);
        if (!authorizationIntegrity.valid) {
          errors.push(...authorizationIntegrity.errors.map((error) => `authorization ${authorization.id}: ${error}`));
        }
        if (
          authorization.proposal_ref?.id !== proposalRecord.id ||
          authorization.proposal_ref?.hash !== proposalRecord.proposal_hash
        ) {
          errors.push(`authorization ${authorization.id} is not bound to the released proposal`);
        }
        if (approvalRecord) {
          const storedAuthority = validateStoredAssessmentApprovalAuthority(context, proposalRecord, approvalRecord);
          validateAssessmentAuthorizationScope(
            context,
            proposalRecord,
            approvalRecord,
            authorization,
            storedAuthority.receipt,
            storedAuthority.receipt ? { path: storedAuthority.path, sha256: storedAuthority.receipt_file_hash } : null,
          );
        }
        const lifecyclePath = authorizationLifecyclePath(context, authorization.id);
        if (fs.existsSync(lifecyclePath)) {
          const lifecycle = readProjectJson(context, lifecyclePath);
          const lifecycleIntegrity = validateAuthorizationRevocationIntegrity(lifecycle);
          if (!lifecycleIntegrity.valid) {
            errors.push(...lifecycleIntegrity.errors.map((error) => `authorization lifecycle ${lifecycle.id}: ${error}`));
          }
          if (lifecycle.authorization_id !== authorization.id || lifecycle.authorization_hash !== authorization.authorization_hash) {
            errors.push(`authorization lifecycle ${lifecycle.id} is not bound to the released authorization`);
          }
        }
      } catch (error) {
        errors.push(`released authorization: ${error.message}`);
      }
    }
    if (approvalRecord && authorizationRecord) {
      try {
        errors.push(...proposalMaterializationSemanticErrors(
          context,
          proposalRecord,
          approvalRecord,
          authorizationRecord.id,
          { release: true },
        ));
      } catch (error) {
        errors.push(`proposal materialization: ${error.message}`);
      }
    }
  }

  const authorizationResults = [];
  for (const reference of manifest.authorization_usage_receipts || []) {
    const result = checkReference(reference, `authorization usage receipt ${reference.id}`, {
      expectedRoot: authorizationUsesRoot(context),
      schema: "authorization-usage-receipt.schema.json",
      integrity: (record) => {
        const validation = validateCanonicalAuthorizationUsageReceipt(record);
        return {
          valid: validation.valid && record.valid_at_use === true && record.decision === "allow",
          expected_hash: validation.expected_hash,
          errors: [
            ...validation.errors,
            ...(record.valid_at_use === true && record.decision === "allow" ? [] : ["authorization was not allowed at use time"]),
          ],
        };
      },
    });
    authorizationResults.push(result);
    if (result?.record && workflowRecord?.authorization_ref && result.record.authorization_id !== workflowRecord.authorization_ref) {
      errors.push(`authorization usage receipt ${reference.id} is not bound to workflow authorization ${workflowRecord.authorization_ref}`);
    }
  }
  if (applicationRecord) {
    const declaredUsePaths = new Set((manifest.authorization_usage_receipts || []).map((reference) => reference.path));
    for (const receiptPath of applicationRecord.authorization_use_refs || []) {
      if (!declaredUsePaths.has(receiptPath)) {
        errors.push(`application authorization receipt ${receiptPath} is missing from the manifest`);
      }
    }
  }
  if (proposalRecord && authorizationRecord) {
    const { uses } = assessmentAuthorizedUseDefinitions(context, proposalRecord);
    const expectedUses = new Map();
    for (const entry of uses) {
      const subject = canonicalAuthorizationUseSubject(entry.settings);
      const key = `${entry.action}:${computeAuthorizationSubjectHash(subject)}`;
      expectedUses.set(key, { action: entry.action, subject });
    }
    const actualUses = new Map();
    for (const result of authorizationResults) {
      const receipt = result?.record;
      if (!receipt) continue;
      let key;
      try {
        key = `${receipt.action}:${computeAuthorizationSubjectHash(receipt.subject)}`;
      } catch (error) {
        errors.push(`authorization receipt ${receipt.id || "unknown"} has no valid subject: ${error.message}`);
        continue;
      }
      if (actualUses.has(key)) {
        errors.push(`authorization action-subject use ${key} appears more than once in the release manifest`);
      }
      actualUses.set(key, receipt);
      if (!expectedUses.has(key)) {
        errors.push(`authorization receipt ${receipt.id} represents an action-subject pair outside the proposal`);
      }
      if (receipt.authorization_hash !== authorizationRecord.authorization_hash) {
        errors.push(`authorization receipt ${receipt.id} is not bound to the released authorization hash`);
      }
    }
    for (const [key, expected] of expectedUses) {
      const receipt = actualUses.get(key);
      if (!receipt) {
        errors.push(`release manifest is missing authorization use ${expected.action} for subject hash ${computeAuthorizationSubjectHash(expected.subject)}`);
        continue;
      }
      const receiptErrors = validateAuthorizationUseReceipt(receipt, {
        authorization_id: authorizationRecord.id,
        action: expected.action,
        proposal_ref: { id: proposalRecord.id, hash: proposalRecord.proposal_hash },
        subject_id: expected.subject.subject_id,
        artifact_types: expected.subject.artifact_types,
        approval_boundaries: expected.subject.approval_boundaries,
      });
      errors.push(...receiptErrors.map((error) => `authorization receipt ${receipt.id}: ${error}`));
    }
    if (actualUses.size !== expectedUses.size) {
      errors.push(`release manifest authorization use set has ${actualUses.size} unique pairs; proposal requires exactly ${expectedUses.size}`);
    }
  }

  let budgetRecord = null;
  if (manifest.budget_decision?.budget_ref) {
    const proposalId = proposalRecord?.id || manifest.workflow?.id;
    const budgetResult = checkReference(
      manifest.budget_decision.budget_ref,
      `execution budget ${manifest.budget_decision.budget_ref.id}`,
      {
        expectedPath: proposalId ? assessmentBudgetSnapshotPath(context, proposalId) : null,
        schema: "execution-budget.schema.json",
        integrity: validateExecutionBudgetIntegrity,
      },
    );
    budgetRecord = budgetResult?.record || null;
  }

  let canonicalUsageReceipts = null;
  if (proposalRecord) {
    try {
      const usageRoot = assessmentUsageRoot(context, proposalRecord.id);
      const canonicalEntries = safeReadDir(usageRoot)
        .filter((name) => name.endsWith(".json"))
        .map((name) => {
          const filePath = path.join(usageRoot, name);
          return { filePath, record: readProjectJson(context, filePath) };
        });
      canonicalUsageReceipts = readAssessmentUsageReceipts(context, proposalRecord.id);
      const canonicalReferences = canonicalEntries
        .map(({ filePath, record }) => ({
          id: record.id,
          path: toProjectPath(context, filePath),
          hash: record.receipt_hash,
        }))
        .sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
      const declaredReferences = (manifest.execution_usage_receipts || [])
        .map((reference) => ({ id: reference.id, path: reference.path, hash: reference.hash }))
        .sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
      if (stableJson(declaredReferences) !== stableJson(canonicalReferences)) {
        errors.push("manifest execution usage receipt set does not exactly match the canonical proposal receipt set");
      }
    } catch (error) {
      errors.push(`canonical execution usage receipts cannot be read: ${error.message}`);
    }
  }

  for (const reference of manifest.execution_usage_receipts || []) {
    const result = checkReference(reference, `execution usage receipt ${reference.id}`, {
      expectedRoot: proposalRecord ? assessmentUsageRoot(context, proposalRecord.id) : assessmentBudgetsRoot(context),
      schema: "execution-usage-receipt.schema.json",
      integrity: (record) => {
        if (!budgetRecord) {
          return { valid: false, expected_hash: null, errors: ["effective execution budget is missing"] };
        }
        const lineage = proposalRecord ? assessmentBudgetLineage(context, proposalRecord.id) : [budgetRecord];
        const receiptBudget = lineage.find((candidate) => candidate.budget_hash === record.budget_hash);
        if (!receiptBudget) {
          return { valid: false, expected_hash: null, errors: ["receipt budget is outside the approved amendment lineage"] };
        }
        return validateExecutionUsageReceipt(record, receiptBudget);
      },
    });
    if (result?.record && proposalRecord && result.record.execution_id !== proposalRecord.id) {
      errors.push(`execution usage receipt ${reference.id} is for ${result.record.execution_id}, expected ${proposalRecord.id}`);
    }
  }

  const contextOptimizationResults = [];
  for (const reference of manifest.context_optimization_observations || []) {
    const result = checkReference(reference, `context optimization observation ${reference.id}`, {
      expectedRoot: proposalRecord
        ? contextOptimizationObservationsRoot(context, proposalRecord.id)
        : path.join(context.sdlcRoot, readContextOptimizationPolicy(context).storage_root),
      schema: "context-optimization-observation.schema.json",
      integrity: validateContextOptimizationObservation,
    });
    contextOptimizationResults.push(result);
    if (result?.record && proposalRecord && (
      result.record.execution_id !== proposalRecord.id ||
      result.record.proposal_hash !== proposalRecord.proposal_hash ||
      result.record.budget_effect?.usage_adjustment_applied !== 0 ||
      result.record.budget_effect?.gate_override !== false
    )) {
      errors.push(`context optimization observation ${reference.id} is not advisory-only evidence for proposal ${proposalRecord.id}`);
    }
  }
  if (contextOptimizationResults.length > 0 && contextOptimizationResults.every((result) => result?.record)) {
    const records = contextOptimizationResults.map((result) => result.record);
    const lineage = validateContextOptimizationLineage(records);
    errors.push(...lineage.errors.map((error) => `context optimization lineage: ${error}`));
    const referencedOrder = (manifest.context_optimization_observations || []).map((reference) => reference.id);
    const canonicalOrder = lineage.ordered.map((observation) => observation.id);
    if (stableJson(referencedOrder) !== stableJson(canonicalOrder)) {
      errors.push("context optimization observations are not in canonical chronological order");
    }
  }

  for (const artifact of manifest.artifacts || []) {
    let artifactPath;
    try {
      artifactPath = resolveProjectFilePath(context, artifact.path, { mustExist: true, fileOnly: true });
      assertNoSymlinkPathSegments(artifactPath, context.root);
      if (hashFile(artifactPath) !== artifact.sha256) {
        errors.push(`artifact ${artifact.id} hash is stale for ${artifact.path}`);
      }
    } catch (error) {
      errors.push(`artifact ${artifact.id}: ${error.message}`);
    }
    const verificationResult = checkReference(
      artifact.verification_receipt_ref,
      `artifact ${artifact.id} verification receipt`,
      {
        expectedPath: verificationReceiptPath(context, artifact.verification_receipt_ref?.id),
        schema: "verification-receipt.schema.json",
        integrity: validateVerificationReceiptIntegrity,
      },
    );
    if (verificationResult?.record) {
      const verification = verificationResult.record;
      if (verificationArtifactSha256(verification) !== artifact.sha256 || !verificationReceiptSatisfies(verification, {
        visual: OUTPUT_VISUAL_FORMATS.has(verification.artifact?.format),
      })) {
        errors.push(`artifact ${artifact.id} verification receipt is not a passing receipt for the released bytes`);
      }
    }
  }

  const gateResults = [];
  for (const reference of manifest.gate_receipts || []) {
    const result = checkReference(reference, `release gate receipt ${reference.id}`, {
      expectedPath: releaseGateReceiptPath(context, reference.id),
      schema: "release-gate-receipt.schema.json",
      integrity: (record) => {
        const { receipt_hash: storedHash, hash_algorithm: algorithm, ...hashSubject } = record || {};
        const recomputed = shortHashFull(stableJson(hashSubject));
        const gateErrors = [];
        if (storedHash !== recomputed) gateErrors.push("release gate receipt hash is invalid");
        if (algorithm !== "sha256:stable-json:v1") gateErrors.push("release gate receipt hash algorithm is invalid");
        if (record.status !== "passed") gateErrors.push("release gate receipt status is not passed");
        if (record.scope?.manifest_id !== manifest.id) gateErrors.push("release gate receipt is scoped to another manifest");
        if (proposalRecord && (
          record.scope?.proposal_ref?.id !== proposalRecord.id ||
          record.scope?.proposal_ref?.hash !== proposalRecord.proposal_hash
        )) gateErrors.push("release gate receipt is scoped to another proposal");
        if (!Array.isArray(record.checks) || record.checks.length === 0 || record.checks.some((check) => check.status !== "passed")) {
          gateErrors.push("release gate receipt has missing or non-passing checks");
        }
        const expectedChecks = [
          { name: "proposal_integrity", subject: manifest.proposals || [], evidence: manifest.proposals || [] },
          { name: "active_scope_lineage", subject: [
            ...(manifest.requirements || []),
            ...(manifest.stories || []),
            ...(manifest.contracts || []),
            ...(manifest.workflow ? [{ id: manifest.workflow.id, path: manifest.workflow.path, hash: manifest.workflow.hash }] : []),
          ], evidence: [
            ...(manifest.requirements || []),
            ...(manifest.stories || []),
            ...(manifest.contracts || []),
            ...(manifest.workflow ? [{ id: manifest.workflow.id, path: manifest.workflow.path, hash: manifest.workflow.hash }] : []),
          ] },
          { name: "layered_output_verification", subject: (manifest.artifacts || []).flatMap((artifact) => [
            artifact.verification_receipt_ref,
            { id: artifact.id, path: artifact.path, hash: artifact.sha256 },
          ]), evidence: (manifest.artifacts || []).flatMap((artifact) => [
            artifact.verification_receipt_ref,
            { id: artifact.id, path: artifact.path, hash: artifact.sha256 },
          ]) },
          { name: "execution_budget", subject: [
            manifest.budget_decision?.budget_ref,
            ...(manifest.execution_usage_receipts || []),
          ].filter(Boolean), evidence: [
            manifest.budget_decision?.budget_ref,
            ...(manifest.execution_usage_receipts || []),
          ].filter(Boolean) },
          ...((manifest.context_optimization_observations || []).length > 0 ? [{
            name: "context_optimization",
            subject: manifest.context_optimization_observations,
            evidence: manifest.context_optimization_observations,
          }] : []),
          { name: "historical_authorization_at_use", subject: manifest.authorization_usage_receipts || [], evidence: manifest.authorization_usage_receipts || [] },
          { name: "source_revision", subject: manifest.source_revision, evidence: [] },
          { name: "rollback", subject: manifest.rollback, evidence: [] },
        ];
        for (const expectedCheck of expectedChecks) {
          const actualCheck = (record.checks || []).find((check) => check.name === expectedCheck.name);
          if (
            !actualCheck ||
            stableJson(actualCheck.evidence || []) !== stableJson(expectedCheck.evidence) ||
            actualCheck.subject_hash !== shortHashFull(stableJson(expectedCheck.subject))
          ) {
            gateErrors.push(`release gate check ${expectedCheck.name} does not exactly match manifest evidence`);
          }
        }
        if ((record.checks || []).length !== expectedChecks.length) {
          gateErrors.push("release gate receipt contains an unexpected check set");
        }
        return { valid: gateErrors.length === 0, expected_hash: recomputed, errors: gateErrors };
      },
    });
    gateResults.push(result);
  }
  if (gateResults.length !== 1 || !gateResults[0]?.record) {
    errors.push("released assessment manifest must contain exactly one valid release gate receipt");
  }

  if (proposalRecord) {
    const expectedStory = proposalRecord.story_reservation?.id;
    const expectedRequirement = proposalRecord.scope?.requirement_id;
    const expectedContract = proposalRecord.contract_draft?.id;
    if ((manifest.stories || []).length !== 1 || manifest.stories[0]?.id !== expectedStory) {
      errors.push(`manifest story scope does not match proposal story ${expectedStory || "missing"}`);
    }
    if ((manifest.requirements || []).length !== 1 || manifest.requirements[0]?.id !== expectedRequirement) {
      errors.push(`manifest requirement scope does not match proposal requirement ${expectedRequirement || "missing"}`);
    }
    if ((manifest.contracts || []).length !== 1 || manifest.contracts[0]?.id !== expectedContract) {
      errors.push(`manifest contract scope does not match proposal contract ${expectedContract || "missing"}`);
    }
    const registry = readOutputRegistry(context, { missingOk: true });
    for (const artifact of manifest.artifacts || []) {
      const link = registry?.links?.find((candidate) => candidate.id === artifact.id);
      if (!link) {
        errors.push(`artifact ${artifact.id} has no canonical output registry link`);
        continue;
      }
      if (
        link.story_id !== expectedStory ||
        link.artifact_type !== artifact.artifact_type ||
        link.artifact_path !== artifact.path ||
        link.template_id !== proposalRecord.deliverable.template_id ||
        stableJson(link.requirements || []) !== stableJson([expectedRequirement]) ||
        link.delivery_format !== proposalRecord.deliverable.delivery.format ||
        link.delivery_extension !== proposalRecord.deliverable.delivery.extension ||
        link.media_type !== proposalRecord.deliverable.delivery.media_type ||
        link.delivery_mode !== proposalRecord.deliverable.delivery.mode ||
        link.fingerprints?.artifact_sha256 !== artifact.sha256 ||
        link.verification_receipt_ref?.id !== artifact.verification_receipt_ref?.id ||
        link.verification_receipt_ref?.hash !== artifact.verification_receipt_ref?.hash ||
        link.verification_receipt_ref?.path !== artifact.verification_receipt_ref?.path
      ) {
        errors.push(`artifact ${artifact.id} does not match its canonical output registry link`);
      }
      if (
        link.authorization_ref !== authorizationRecord?.id ||
        link.authorization_action !== "output.link" ||
        !link.authorization_use_ref
      ) {
        errors.push(`artifact ${artifact.id} output link has no exact proposal-bound output.link authorization`);
      } else {
        errors.push(...proposalAuthorizationUseErrors(
          context,
          link.authorization_use_ref,
          authorizationRecord.id,
          proposalRecord,
          "output.link",
          expectedStory,
          [artifact.artifact_type],
        ).map((error) => `artifact ${artifact.id}: ${error}`));
      }
      if (!link.authorization_use_ref || !(manifest.authorization_usage_receipts || []).some((reference) => reference.path === link.authorization_use_ref)) {
        errors.push(`artifact ${artifact.id} output.link authorization receipt is missing from the manifest`);
      }
    }
  }

  if (proposalRecord && budgetRecord) {
    try {
      if (!canonicalUsageReceipts) {
        throw new Error("canonical proposal receipt set is unavailable");
      }
      const usageReceipts = canonicalUsageReceipts;
      const decision = evaluateAssessmentBudgetUsage(context, proposalRecord.id, budgetRecord, usageReceipts);
      const coverage = hardLimitMeteringCoverage(context, budgetRecord, usageReceipts, {
        execution_started_at: workflowExecutionStartedAt(workflowRecord),
        checkpoint_at: manifest.released_at,
      });
      const declared = manifest.budget_decision || {};
      const expectedReserveRisks = completionReserveRisks(budgetRecord, decision);
      if (!["within_budget", "warning", "completion_reserve"].includes(decision.status)) {
        errors.push(`release budget is not completion-safe: ${decision.status}`);
      }
      if (!coverage.valid) {
        errors.push(`release budget lacks trusted exact coverage for hard-limit metric(s): ${coverage.violations.map((item) => item.metric).join(", ")}`);
      }
      // Manifests written before unmeasured metrics were recorded carry the raw
      // decision status; newer ones record not_measured and the metric list.
      const recordsUnmeasured = Object.hasOwn(declared, "unmeasured_metrics");
      const expectedStatus = recordsUnmeasured ? completionBudgetStatus(decision) : decision.status;
      if (
        declared.status !== expectedStatus ||
        (recordsUnmeasured && stableJson(declared.unmeasured_metrics) !== stableJson(decision.unmeasured_metrics || [])) ||
        declared.receipt_count !== usageReceipts.length ||
        stableJson(declared.usage || {}) !== stableJson(decision.usage || {}) ||
        stableJson(declared.remaining || {}) !== stableJson(decision.remaining || {}) ||
        stableJson(declared.completion_reserve_risks || []) !== stableJson(expectedReserveRisks)
      ) {
        errors.push("manifest budget decision does not match independently aggregated usage receipts");
      }
    } catch (error) {
      errors.push(`manifest budget decision cannot be reconstructed: ${error.message}`);
    }
  }
  return Array.from(new Set(errors));
}

export function assertReleaseManifestIntegrity(context, manifest) {
  const errors = validateReleaseManifestIntegrity(context, manifest);
  if (errors.length > 0) {
    fail(`Release manifest ${manifest?.id || "unknown"} is invalid: ${errors.join("; ")}`);
  }
  return manifest;
}

export function readReleaseManifest(context, value) {
  const raw = String(value || "").trim();
  if (!raw) {
    fail("Release-manifest scope requires --release-manifest <manifest-id-or-path>.");
  }
  const filePath = raw.includes("/") || raw.endsWith(".json")
    ? resolveProjectFilePath(context, raw, { mustExist: true, fileOnly: true })
    : releaseManifestPath(context, normalizeId(raw));
  const configuredRoot = path.dirname(releaseManifestPath(context, "MANIFEST-ROOT-CHECK"));
  if (!isInsidePath(configuredRoot, filePath)) {
    fail(`Release manifest must be stored under ${toProjectPath(context, configuredRoot)}.`);
  }
  resolveProjectFilePath(context, filePath, { mustExist: true, fileOnly: true });
  assertNoSymlinkPathSegments(filePath, context.root);
  const manifest = readProjectJson(context, filePath);
  if (!manifest?.id || path.resolve(filePath) !== path.resolve(releaseManifestPath(context, manifest.id))) {
    fail(`Release manifest ${manifest?.id || "unknown"} is not stored at its canonical id-bound path.`);
  }
  return { filePath, manifest };
}

export function deliveryFormatOptionsForOutput(artifactType = "", phase = null) {
  const normalized = String(artifactType || phase || "").toLowerCase();
  const options = [
    {
      id: "chat-summary",
      label: "Chat summary",
      description: "A concise answer in chat with key points, decisions, risks, and next steps.",
    },
    {
      id: "canonical-document",
      label: "Project document",
      description: "A saved Markdown document that can be reviewed and reused later.",
    },
    {
      id: "document-plus-chat-summary",
      label: "Project document plus chat summary",
      description: "Create the saved document and also explain the outcome briefly in chat.",
    },
    {
      id: "decision-risk-action-list",
      label: "Decision, risk, and action list",
      description: "A compact list of decisions made, risks found, owners or follow-up actions, and open questions.",
    },
  ];

  if (matchesAny(normalized, ["analysis", "assessment", "discovery", "research", "requirement"])) {
    options.push(
      {
        id: "executive-summary",
        label: "Executive summary",
        description: "A short stakeholder-friendly summary before the detailed analysis.",
      },
      {
        id: "detailed-findings",
        label: "Detailed findings",
        description: "Findings with evidence, impact, recommendation, confidence, and affected areas.",
      },
      {
        id: "comparison-table",
        label: "Comparison table",
        description: "Options or alternatives compared by criteria, tradeoffs, risks, and recommendation.",
      },
      {
        id: "architecture-or-flow-view",
        label: "Architecture or flow view",
        description: "A diagram-ready architecture, flow, or component view when the output benefits from structure.",
      },
    );
  }

  if (matchesAny(normalized, ["design", "architecture", "api", "ux", "ui"])) {
    options.push(
      {
        id: "design-rationale",
        label: "Design rationale",
        description: "Design decisions, rejected alternatives, constraints, and tradeoffs.",
      },
      {
        id: "interface-contracts",
        label: "Interface contracts",
        description: "API, component, data, event, or integration contracts that implementation should follow.",
      },
      {
        id: "diagram-ready-summary",
        label: "Diagram-ready summary",
        description: "A concise structure suitable for Mermaid, architecture diagrams, or sequence flows.",
      },
    );
  }

  if (matchesAny(normalized, ["implementation", "code", "patch", "change", "class", "component"])) {
    options.push(
      {
        id: "changed-files-summary",
        label: "Changed files summary",
        description: "List changed files with why each changed and what behavior changed.",
      },
      {
        id: "modified-classes-components",
        label: "Modified classes or components",
        description: "List the important classes, modules, functions, components, routes, or screens touched.",
      },
      {
        id: "diff-review",
        label: "Diff or patch review",
        description: "Show a focused diff-style explanation for review instead of pasting full files.",
      },
      {
        id: "key-code-snippets",
        label: "Key code snippets",
        description: "Show only the most relevant snippets needed to understand the change.",
      },
      {
        id: "tests-and-verification",
        label: "Tests and verification",
        description: "Report commands run, evidence, failures, skipped checks, and residual risk.",
      },
      {
        id: "no-code-summary",
        label: "No-code summary",
        description: "Summarize behavior and changed areas without showing code unless requested.",
      },
    );
  }

  if (matchesAny(normalized, ["validation", "test", "qa", "verification"])) {
    options.push(
      {
        id: "test-evidence",
        label: "Test evidence",
        description: "Commands, results, evidence paths, failing cases, and logs or reports.",
      },
      {
        id: "regression-risk-summary",
        label: "Regression risk summary",
        description: "What was covered, what was not covered, likely regressions, and manual checks.",
      },
      {
        id: "failure-triage",
        label: "Failure triage",
        description: "Failures grouped by root cause, severity, owner, and next action.",
      },
    );
  }

  if (matchesAny(normalized, ["release", "deploy", "deployment", "handoff"])) {
    options.push(
      {
        id: "release-notes",
        label: "Release notes",
        description: "User-visible changes, technical changes, migrations, and known issues.",
      },
      {
        id: "deployment-checklist",
        label: "Deployment checklist",
        description: "Pre-release checks, deploy steps, post-release verification, and rollback criteria.",
      },
      {
        id: "handoff-summary",
        label: "Handoff summary",
        description: "What is done, what is pending, evidence links, risks, and next owner.",
      },
    );
  }

  return dedupeDeliveryFormatOptions(options);
}

export function deliveryQuestionForOutput(artifactType = "", phase = null) {
  const label = humanOutputLabel(artifactType || phase || "this output");
  const optionLabels = deliveryFormatOptionsForOutput(artifactType, phase).map((option) => option.label).join(", ");
  return `How should I present ${label} results to you? Choose one option or combine several: ${optionLabels}. You can also ask for a custom delivery format.`;
}

export function deliveryFormatOptionsForContract(contract) {
  return deliveryFormatOptionsForOutput(contractDeliveryDescriptor(contract), contract.phase);
}

export function deliveryQuestionForContract(contract) {
  const subject = contract.story_id || "this project";
  const optionLabels = deliveryFormatOptionsForContract(contract).map((option) => option.label).join(", ");
  return `How should I present the ${contract.phase} result for ${subject}? Choose one option or combine several: ${optionLabels}. You can also ask for a custom delivery format.`;
}

export function assertDeliveryProfileReservationUnique(context, deliveryProfileId, contractId) {
  if (!deliveryProfileId) return;
  const contractsRoot = path.join(context.sdlcRoot, "contracts");
  for (const name of safeReadDir(contractsRoot).filter((item) => item.endsWith(".json"))) {
    const candidate = readProjectJson(context, path.join(contractsRoot, name));
    if (
      candidate.id !== contractId
      && candidate.delivery_execution_profile_id === deliveryProfileId
    ) {
      fail(`Delivery profile ID ${deliveryProfileId} is already reserved by contract ${candidate.id}; every contract delivery needs a unique profile ID.`);
    }
  }
}

export function storyBoundDeliveryProfiles(context, storyId) {
  const deliveriesRoot = path.join(context.sdlcRoot, "autonomy", "deliveries");
  return safeReadDir(deliveriesRoot)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readProjectJson(context, path.join(deliveriesRoot, name)))
    .filter((profile) =>
      Array.isArray(profile.story_refs)
      && profile.story_refs.some((ref) => ref?.id === storyId));
}

export function storyDeliveryProfileReviewIds(context, storyId, currentStoryHash) {
  const terminalStatuses = new Set([
    ...DELIVERY_TERMINAL_STATUSES,
    "completed",
    "done",
    "expired",
    "rejected",
    "terminal",
  ]);
  return storyBoundDeliveryProfiles(context, storyId)
    .filter((profile) => !terminalStatuses.has(String(profile.status || "active").toLowerCase()))
    .filter((profile) => currentDeliveryExecutionState(context, profile).lifecycle_status !== "terminal")
    .filter((profile) => {
      const reference = profile.story_refs.find((ref) => ref?.id === storyId);
      return reference?.hash !== currentStoryHash;
    })
    .map((profile) => profile.id)
    .filter(Boolean)
    .sort();
}

export function releaseStoryClaim(context, options) {
  const reservation = releaseStoryReservationIfAny(context, options);
  if (reservation) {
    output(options, reservation, [
      reservation.shared_reservation.status === "expired"
        ? `The reservation of story ${reservation.story_id} by ${reservation.shared_reservation.holder.agent} had already expired; the story is free.`
        : `Released the reservation of story ${reservation.story_id} by ${reservation.shared_reservation.holder.agent} through '${reservation.shared_reservation.remote}': other computers can reserve or claim it now.`,
    ]);
    return;
  }
  const result = releaseStoryClaimRecord(context, options);
  const releasedStoryId = result.claim?.story_id || result.story_id;
  output(options, result, [
    result.remote_only
      ? `Story ${releasedStoryId} had no claim file on this computer; released its claim held on the remote`
      : result.already_released
        ? `Story ${releasedStoryId} claim was already ${result.claim.status} on this computer`
        : `Released claim for story ${releasedStoryId}`,
    sharedReleaseLine(releasedStoryId, result.shared_release),
  ].filter(Boolean));
}

/**
 * story release on a story that only has a reservation (story reserve): with
 * no active claim file here, the active reservation on the remote is ended.
 * Returns null when there is none, so the claim release runs as before.
 */
function releaseStoryReservationIfAny(context, options) {
  ensureInitialized(context);
  const id = normalizeId(requireOption(options, "id"));
  const claimPath = path.join(context.sdlcRoot, "stories", id, "claim.json");
  if (pathEntryExistsNoFollow(claimPath)) {
    let claim = null;
    try {
      claim = JSON.parse(readStableRegularFileBuffer(claimPath, context.root).content.toString("utf8"));
    } catch {
      return null;
    }
    if (String(claim?.status || "").toLowerCase() === "active") return null;
  }
  const attribution = buildAttribution(context, options, "story.release");
  const released = releaseSharedReservation(context, {
    storyId: id,
    agent: options.agent ? String(options.agent) : null,
    actor: attribution.actor,
    reason: options.reason ? String(options.reason) : null,
    attribution,
    options,
    releasedAt: now(),
  });
  return released ? { status: "released", story_id: id, shared_reservation: released } : null;
}

export function releaseStoryClaimRecord(context, options, lockOptions = {}) {
  ensureInitialized(context);
  const id = normalizeId(requireOption(options, "id"));
  const storyDir = path.join(context.sdlcRoot, "stories", id);
  const claimPath = path.join(storyDir, "claim.json");
  const attribution = buildAttribution(context, options, "story.release");
  const requestedAgent = options.agent ? String(options.agent) : null;
  let claim;
  let traceEvent;
  let sharedRelease = null;
  let alreadyReleased = false;
  let releaseTaskStartBoundaryLock = () => {};
  let releaseLifecycleLock = () => {};
  let releaseClaimLock = () => {};
  try {
    if (!lockOptions.boundaryAndLifecycleLocked) {
      releaseTaskStartBoundaryLock = acquireFileLock(
        path.join(storyDir, "task-start-boundary.lock"),
      );
      releaseLifecycleLock = acquireFileLock(
        storyLifecycleCertificationLockPath(context, id),
      );
    }
    releaseClaimLock = acquireFileLock(path.join(storyDir, "claim.lock"));
    if (!pathEntryExistsNoFollow(claimPath)) {
      // The claim file is gone, but the remote may still hold a claim made by this computer for this agent.
      const releasedAt = now();
      const orphanClaim = { story_id: id, status: normalizeClaimStatus(options.status || "released") };
      const completion = storyDeliveryCompletion(context, id, orphanClaim);
      const orphan = releaseOrphanSharedClaim(context, {
        storyId: id,
        agent: requestedAgent,
        status: sharedReleaseStatus(orphanClaim.status, { deliveryFinished: Boolean(completion) }),
        reason: options.reason ? String(options.reason) : null,
        releasedAt,
        actor: attribution.actor,
        completion,
        deliveryCommits: completion ? storyDeliveryCommitShas(context, id) : [],
      });
      if (!orphan) fail(`Story ${id} has no claim to release`);
      if (orphan.status === "not_shared") {
        fail(`Story ${id} has no local claim and its shared claim could not be released: ${orphan.error}`);
      }
      const orphanMutation = prepareGovernedTraceMutation(context, id, {
        type: "sync",
        summary: `Story ${id} shared claim released without local claim file`,
        action: "story.release",
        actor: attribution.actor,
        evidence: [],
        related: [id],
        git: attribution.git,
        run: attribution.run,
      });
      try {
        traceEvent = orphanMutation.commit();
      } catch (error) {
        traceEvent = orphanMutation.recoverCommitted();
        if (!traceEvent) throw error;
      } finally {
        orphanMutation.release();
      }
      return {
        status: "released",
        claim_path: null,
        claim: null,
        story_id: id,
        trace_event: traceEvent,
        shared_release: orphan,
        already_released: true,
        remote_only: true,
      };
    }
    const priorClaimSnapshot = readStableRegularFileBuffer(claimPath, context.root);
    claim = JSON.parse(priorClaimSnapshot.content.toString("utf8"));
    if (requestedAgent && claim.agent !== requestedAgent && !options.force) {
      fail(`Story ${id} is claimed by ${claim.agent}, not ${requestedAgent}. Use --force only after coordination.`);
    }
    if (requestedAgent && claim.agent !== requestedAgent && options.force) {
      requireCoordinationOverrideActor(attribution, `Force-releasing story ${id} claimed by another agent`);
    }
    const sharedClaim = claim.shared_claim?.scope === "shared";
    const nextStatus = normalizeClaimStatus(options.status || "released");
    if (sharedClaim && nextStatus === "active") {
      fail(`Story ${id} claim is shared with other computers; claim it again with story claim instead of reactivating it here.`);
    }
    // The claim file travels with git: only this repository's own ownership
    // refs show that the claim was made here. Releasing anyone else's claim
    // is a person's decision, with a reason the holder will see.
    let personDecision = false;
    let ownedHere = false;
    const claimPolicy = storyClaimPolicy(context);
    const foreignShared = sharedClaim
      && claimPolicy.coordination.mode !== "local_only"
      && !ownsSharedClaim(context, claim.shared_claim, claimPolicy.coordination.timeout_seconds);
    // Made by this computer from another worktree (for example a temporary governance one): not a person's decision.
    if (foreignShared) {
      ownedHere = claimMadeOnThisComputer(claim, { host: hostLabel(), email: attribution.git?.user?.email });
    }
    if (foreignShared && !ownedHere) {
      requireSharedClaimPersonDecision(id, {
        epoch: claim.shared_claim.epoch,
        claimant_id: claim.shared_claim.claimant_id,
        agent: claim.agent,
        branch: claim.branch,
        actor: claim.audit?.claimed_by || null,
        claimed_at: claim.claimed_at,
        expires_at: claim.expires_at || null,
      }, { attribution, options, action: "release" });
      personDecision = true;
    }
    if (sharedClaim && String(claim.status || "").toLowerCase() !== "active") {
      // Already ended here, possibly while the remote could not be reached:
      // share that release without rewriting the record.
      alreadyReleased = true;
      const completion = storyDeliveryCompletion(context, id, claim);
      sharedRelease = shareStoryClaimRelease(context, {
        claim,
        status: sharedReleaseStatus(claim.status, { deliveryFinished: Boolean(completion) }),
        completion,
        deliveryCommits: completion ? storyDeliveryCommitShas(context, id) : [],
        reason: personDecision ? getOptionString(options, "reason") : claim.release_reason || null,
        releasedAt: personDecision ? now() : claim.released_at || now(),
        // Who shares the release now, never whoever is named in the claim file.
        agent: requestedAgent,
        actor: attribution.actor,
        personDecision,
        ownedHere,
      });
      return { status: "released", claim_path: claimPath, claim, trace_event: null, shared_release: sharedRelease, already_released: true };
    }
    claim.status = nextStatus;
    claim.released_at = now();
    claim.release_reason = options.reason ? String(options.reason) : null;
    claim.audit = {
      ...(claim.audit || {}),
      released_by: attribution.actor,
      git: attribution.git,
      run: attribution.run,
      ...(ownedHere ? { released_from: { branch: attribution.git?.branch || null, worktree: context.root, host: hostLabel() } } : {}),
    };
    let traceMutation;
    let claimWritten = false;
    try {
      writeJsonFile(claimPath, claim, { force: true });
      claimWritten = true;
      traceMutation = prepareGovernedTraceMutation(context, id, {
        type: "sync",
        summary: `Story ${id} claim ${claim.status}`,
        action: "story.release",
        actor: attribution.actor,
        evidence: [toProjectPath(context, claimPath)],
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
          writeTextFile(
            claimPath,
            priorClaimSnapshot.content.toString("utf8"),
            { force: true },
          );
        } catch (rollbackError) {
          fail(
            `Story ${id} claim release transaction could not restore its exact prior state `
            + `(${rollbackError.message}). Original failure: ${error.message}`,
          );
        }
      }
      throw error;
    } finally {
      traceMutation?.release();
    }
    if (sharedClaim && claim.status !== "active") {
      // Written here first: a release that cannot be shared only keeps the story reserved longer.
      const completion = storyDeliveryCompletion(context, id, claim);
      sharedRelease = shareStoryClaimRelease(context, {
        claim,
        status: sharedReleaseStatus(claim.status, { deliveryFinished: Boolean(completion) }),
        completion,
        deliveryCommits: completion ? storyDeliveryCommitShas(context, id) : [],
        reason: claim.release_reason,
        releasedAt: claim.released_at,
        agent: requestedAgent,
        actor: attribution.actor,
        personDecision,
        ownedHere,
      });
    }
  } finally {
    releaseClaimLock();
    releaseLifecycleLock();
    releaseTaskStartBoundaryLock();
  }
  return {
    status: "released",
    claim_path: claimPath,
    claim,
    trace_event: traceEvent,
    ...(sharedRelease ? { shared_release: sharedRelease } : {}),
    ...(alreadyReleased ? { already_released: true } : {}),
  };
}

export function resolveOperationsReleaseManifestId(context, options) {
  const releaseManifestInput = requireOption(options, "release-manifest");
  const { manifest } = readReleaseManifest(context, releaseManifestInput);
  return manifest.id;
}

export function readPullRequestDeliveryForReview(context, profileId) {
  const profile = readDeliveryAutonomyProfile(context, profileId);
  if (profile.delivery_kind !== "pull_request" || !profile.pull_request_target) {
    fail(`Delivery profile ${profileId} is not a pull-request delivery; only a pull request diff can be reviewed.`);
  }
  const storyId = profile.story_refs?.length === 1 ? profile.story_refs[0].id : null;
  if (!storyId) {
    fail(`Delivery profile ${profileId} does not name exactly one story.`);
  }
  return { profile, storyId };
}

export function releaseManifestEvidenceEntries(context, manifest, manifestPath = null) {
  const entries = [];
  const addReference = (reference, artifactType) => {
    if (!reference?.path) {
      return;
    }
    entries.push({
      id: reference.id || null,
      artifact_type: artifactType,
      path: reference.path,
    });
  };

  if (manifestPath) {
    entries.push({
      id: manifest.id || null,
      artifact_type: "release-manifest",
      path: manifestPath,
    });
  }
  for (const reference of manifest.requirements || []) {
    addReference(reference, "requirement");
  }
  for (const reference of manifest.stories || []) {
    addReference(reference, "story");
  }
  for (const reference of manifest.contracts || []) {
    addReference(reference, "contract");
  }
  for (const reference of manifest.proposals || []) {
    addReference(reference, "assessment-proposal");
  }
  addReference(manifest.workflow, "assessment-workflow");
  for (const artifact of manifest.artifacts || []) {
    addReference(artifact, artifact.artifact_type || "release-artifact");
    addReference(artifact.verification_receipt_ref, "verification-receipt");
  }
  for (const reference of manifest.authorization_usage_receipts || []) {
    addReference(reference, "authorization-usage-receipt");
  }
  for (const reference of manifest.execution_usage_receipts || []) {
    addReference(reference, "execution-usage-receipt");
  }
  for (const reference of manifest.context_optimization_observations || []) {
    addReference(reference, "context-optimization-observation");
  }
  addReference(manifest.budget_decision?.budget_ref, "execution-budget");
  for (const reference of manifest.gate_receipts || []) {
    addReference(reference, "release-gate-receipt");
  }
  for (const reference of manifest.proposals || []) {
    const proposalId = reference.id;
    const proposal = readAssessmentProposal(context, proposalId);
    addReference(proposal.baseline_ref, "approved-baseline");
    if (proposal.deliverable?.template_path) {
      addReference({ id: proposal.deliverable.template_id, path: proposal.deliverable.template_path }, "output-template");
    }
    const approvalFile = assessmentApprovalPath(context, proposalId);
    if (fs.existsSync(approvalFile)) {
      const approval = readAssessmentApproval(context, proposalId);
      addReference({ id: approval.id, path: toProjectPath(context, approvalFile) }, "assessment-approval");
      if (approval.host_receipt_ref) {
        addReference({ id: null, path: approval.host_receipt_ref }, "host-approval-receipt");
      }
    }
    const applicationFile = assessmentApplicationPath(context, proposalId);
    if (fs.existsSync(applicationFile)) {
      const application = readAssessmentApplication(context, proposalId);
      addReference({ id: application.id, path: toProjectPath(context, applicationFile) }, "assessment-application");
      for (const amendment of application.budget_amendments || []) {
        addReference(amendment, "budget-amendment");
      }
      if (application.authorization_ref) {
        const authorizationFile = authorizationPath(context, application.authorization_ref);
        addReference({ id: application.authorization_ref, path: toProjectPath(context, authorizationFile) }, "content-authorization");
        const lifecycleFile = authorizationLifecyclePath(context, application.authorization_ref);
        if (fs.existsSync(lifecycleFile)) {
          addReference({ id: application.authorization_ref, path: toProjectPath(context, lifecycleFile) }, "authorization-lifecycle");
        }
      }
    }
    const taskStartFile = path.join(context.sdlcRoot, "stories", proposal.story_reservation.id, "task-start.json");
    if (fs.existsSync(taskStartFile)) {
      addReference({ id: `START-${proposal.story_reservation.id}`, path: toProjectPath(context, taskStartFile) }, "task-start-receipt");
    }
  }
  return entries;
}

export function collectHistoricalReleaseArtifacts(context, activeManifest, activeManifestFile) {
  const manifestRoot = path.dirname(releaseManifestPath(context, "MANIFEST-ROOT-CHECK"));
  const activeEntries = releaseManifestEvidenceEntries(
    context,
    activeManifest,
    toProjectPath(context, activeManifestFile),
  );
  const activePaths = new Set(activeEntries.map((entry) => {
    const evidencePath = resolveProjectFilePath(context, entry.path, { mustExist: true, fileOnly: true });
    assertNoSymlinkPathSegments(evidencePath, context.root);
    return fs.realpathSync.native(evidencePath);
  }));
  const candidates = new Map();
  let historicalReleaseCount = 0;
  const quarantinedReleases = [];

  for (const name of safeReadDir(manifestRoot).filter((entry) => entry.endsWith(".json")).sort()) {
    const filePath = path.join(manifestRoot, name);
    if (path.resolve(filePath) === path.resolve(activeManifestFile)) {
      continue;
    }
    let historicalManifest;
    try {
      historicalManifest = readProjectJson(context, filePath);
    } catch (error) {
      quarantinedReleases.push({ path: toProjectPath(context, filePath), reason: error.message });
      continue;
    }
    if (historicalManifest.kind !== "release_manifest" || historicalManifest.status !== "released") {
      continue;
    }
    try {
      assertReleaseManifestIntegrity(context, historicalManifest);
    } catch (error) {
      quarantinedReleases.push({ id: historicalManifest.id || null, path: toProjectPath(context, filePath), reason: error.message });
      continue;
    }
    historicalReleaseCount += 1;
    let historicalEntries;
    try {
      historicalEntries = releaseManifestEvidenceEntries(context, historicalManifest, toProjectPath(context, filePath));
    } catch (error) {
      quarantinedReleases.push({ id: historicalManifest.id || null, path: toProjectPath(context, filePath), reason: error.message });
      historicalReleaseCount -= 1;
      continue;
    }
    const releaseCandidates = [];
    try {
      for (const entry of historicalEntries) {
        const evidencePath = resolveProjectFilePath(context, entry.path, { mustExist: true, fileOnly: true });
        assertNoSymlinkPathSegments(evidencePath, context.root);
        const canonicalKey = fs.realpathSync.native(evidencePath);
        if (activePaths.has(canonicalKey) || candidates.has(canonicalKey)) {
          continue;
        }
        releaseCandidates.push([canonicalKey, {
          id: entry.id,
          artifact_type: entry.artifact_type,
          path: toProjectPath(context, evidencePath),
          sha256: hashFile(evidencePath),
          classification: "legacy_history",
          excluded_from_release: true,
          retention: "retain-in-place",
          archive_plan_ref: null,
        }]);
      }
    } catch (error) {
      quarantinedReleases.push({ id: historicalManifest.id || null, path: toProjectPath(context, filePath), reason: error.message });
      historicalReleaseCount -= 1;
      continue;
    }
    for (const [canonicalKey, candidate] of releaseCandidates) {
      candidates.set(canonicalKey, candidate);
    }
  }

  return {
    historical_release_count: historicalReleaseCount,
    active_paths: activeEntries.map((entry) => entry.path).sort(),
    artifacts: Array.from(candidates.values()).sort((left, right) => left.path.localeCompare(right.path)),
    quarantined_releases: quarantinedReleases,
  };
}

export function assertLatestReleasedManifestSelected(context, manifest, manifestFile) {
  const manifestRoot = path.dirname(releaseManifestPath(context, "MANIFEST-ROOT-CHECK"));
  const maxFutureSkewMs = Number(context.config.release_evidence_policy?.max_future_skew_seconds ?? 300) * 1000;
  const candidates = [];
  const quarantined = [];
  for (const name of safeReadDir(manifestRoot).filter((entry) => entry.endsWith(".json")).sort()) {
    const filePath = path.join(manifestRoot, name);
    let candidate;
    try {
      candidate = readProjectJson(context, filePath);
    } catch (error) {
      quarantined.push({ path: toProjectPath(context, filePath), reason: error.message });
      continue;
    }
    if (
      candidate.kind !== "release_manifest" ||
      candidate.status !== "released" ||
      candidate.project?.id !== manifest.project?.id
    ) continue;
    const envelopeErrors = [];
    const schema = validateRecordSchema(candidate, "release-manifest.schema.json");
    envelopeErrors.push(...schema.errors.map((error) => `${error.instance_path}: ${error.message}`));
    const { manifest_hash: storedHash, hash_algorithm: algorithm, ...hashSubject } = candidate;
    if (algorithm !== "sha256:stable-json:v1" || storedHash !== shortHashFull(stableJson(hashSubject))) {
      envelopeErrors.push("manifest hash is invalid");
    }
    if (!candidate.id || path.resolve(filePath) !== path.resolve(releaseManifestPath(context, candidate.id))) {
      envelopeErrors.push("manifest path is not canonically bound to its id");
    }
    const candidateAt = Date.parse(candidate.released_at || "");
    if (!Number.isFinite(candidateAt)) {
      envelopeErrors.push("released_at is invalid");
    } else if (candidateAt > Date.now() + maxFutureSkewMs) {
      envelopeErrors.push(`released_at is more than ${maxFutureSkewMs / 1000} seconds in the future`);
    }
    if (!Array.isArray(candidate.gate_receipts) || candidate.gate_receipts.length !== 1) {
      envelopeErrors.push("manifest must contain exactly one release gate receipt");
    } else {
      try {
        const gateReference = candidate.gate_receipts[0];
        const gatePath = resolveProjectFilePath(context, gateReference.path, { mustExist: true, fileOnly: true });
        if (path.resolve(gatePath) !== path.resolve(releaseGateReceiptPath(context, gateReference.id))) {
          envelopeErrors.push("release gate receipt path is not canonical");
        } else {
          const gate = readProjectJson(context, gatePath);
          const gateSchema = validateRecordSchema(gate, "release-gate-receipt.schema.json");
          envelopeErrors.push(...gateSchema.errors.map((error) => `gate ${error.instance_path}: ${error.message}`));
          const { receipt_hash: gateHash, hash_algorithm: gateAlgorithm, ...gateSubject } = gate;
          if (
            gateAlgorithm !== "sha256:stable-json:v1" ||
            gateHash !== shortHashFull(stableJson(gateSubject)) ||
            gateHash !== gateReference.hash ||
            gate.status !== "passed" ||
            gate.scope?.manifest_id !== candidate.id
          ) {
            envelopeErrors.push("release gate receipt does not attest this manifest envelope");
          }
        }
      } catch (error) {
        envelopeErrors.push(`release gate receipt cannot be verified: ${error.message}`);
      }
    }
    if (envelopeErrors.length > 0) {
      const entry = { id: candidate.id || null, path: toProjectPath(context, filePath), reason: envelopeErrors.join("; ") };
      if (path.resolve(filePath) === path.resolve(manifestFile)) {
        fail(`Selected release manifest ${manifest.id} is not eligible as the active release: ${entry.reason}`);
      }
      quarantined.push(entry);
      continue;
    }
    candidates.push({ candidate, filePath, candidateAt });
  }
  const ordered = candidates.sort((left, right) =>
    left.candidateAt - right.candidateAt ||
    String(left.candidate.id).localeCompare(String(right.candidate.id)) ||
    String(left.candidate.manifest_hash).localeCompare(String(right.candidate.manifest_hash))
  );
  const latest = ordered.at(-1);
  if (!latest || path.resolve(latest.filePath) !== path.resolve(manifestFile)) {
    const latestId = latest?.candidate?.id || "unknown";
    fail([
      `Release ${manifest.id} is not the newest released manifest; deterministic ordering selects ${latestId}.`,
      "What I need: select the newest released manifest, or run an explicit rollback workflow that creates a new release manifest.",
      "Why: migration active classifies every other release as history; selecting an older release would silently archive newer evidence. Equal timestamps are ordered by manifest ID and hash.",
      `Example: agentic-sdlc migration active --release-manifest ${latestId} --apply`,
      "Effect: only evidence older than the selected current release is classified as historical.",
    ].join("\n"));
  }
  return { quarantined_releases: quarantined };
}

export function buildOutputDelivery(options = {}, fallback = null) {
  const requestedFormat = getOptionString(options, "format");
  const formatAlias = String(requestedFormat || fallback?.format || "markdown").trim().toLowerCase();
  const format = OUTPUT_FORMAT_ALIASES[formatAlias];
  if (!format || !OUTPUT_FORMATS[format]) {
    fail(`Invalid output format '${requestedFormat || formatAlias}'. Valid formats: ${Object.keys(OUTPUT_FORMATS).join(", ")}`);
  }

  const descriptor = OUTPUT_FORMATS[format];
  const requestedMode = getOptionString(options, "delivery") || fallback?.mode || "artifact-plus-chat-summary";
  const mode = String(requestedMode).trim().toLowerCase();
  if (!OUTPUT_DELIVERY_MODES.has(mode)) {
    fail(`Invalid delivery mode '${requestedMode}'. Valid modes: ${Array.from(OUTPUT_DELIVERY_MODES).join(", ")}`);
  }

  const requestedExtension = normalizeOutputExtension(getOptionString(options, "extension") || fallback?.extension || descriptor.extension);
  const requestedMediaType = getOptionString(options, "media-type") || fallback?.media_type || descriptor.media_type;
  const requestedGenerator = getOptionString(options, "generator") || fallback?.generator || descriptor.generator;

  if (format !== "custom") {
    if (getOptionString(options, "extension") && requestedExtension !== descriptor.extension) {
      fail(`Output format ${format} requires extension ${descriptor.extension}; received ${requestedExtension}.`);
    }
    if (getOptionString(options, "media-type") && requestedMediaType !== descriptor.media_type) {
      fail(`Output format ${format} requires media type ${descriptor.media_type}; received ${requestedMediaType}.`);
    }
    if (getOptionString(options, "generator") && requestedGenerator !== descriptor.generator) {
      fail(`Output format ${format} uses generator ${descriptor.generator || "none"}; received ${requestedGenerator}.`);
    }
  } else if (!requestedExtension) {
    fail("Custom output format requires --extension (for example --extension .drawio). ");
  }

  return {
    format,
    label: descriptor.label,
    extension: format === "custom" ? requestedExtension : descriptor.extension,
    media_type: format === "custom" ? requestedMediaType : descriptor.media_type,
    generator: format === "custom" ? requestedGenerator : descriptor.generator,
    mode,
  };
}

export function effectiveOutputDelivery(template = {}) {
  return buildOutputDelivery({}, template.delivery || null);
}

export function outputDeliveryIsFresh(template = {}) {
  if (!template.delivery) {
    return true;
  }
  return Boolean(
    template.approved_delivery_hash &&
    template.approved_delivery_hash === hashApprovalSubject(effectiveOutputDelivery(template)),
  );
}

/**
 * How the story's delivery finished, recorded with a plain release shared
 * once that delivery is finished (merged, released, or ready for review,
 * with release evidence): other computers then read the story as done, not
 * free, before its closing records reach the base branch. Null otherwise.
 */
function storyDeliveryCompletion(context, storyId, claim) {
  if (sharedReleaseStatus(claim?.status) !== "released") return null;
  try {
    const readiness = storyReleaseReadiness(context, storyId);
    if (!readiness.ready || !readiness.profile_id) return null;
    const profile = readDeliveryAutonomyProfile(context, readiness.profile_id);
    const state = currentDeliveryExecutionState(context, profile);
    return {
      delivery_id: profile.delivery_id,
      delivery_kind: profile.delivery_kind,
      terminal_status: state.status,
      closed_at: state.close_receipt?.closed_at || null,
      merge_commit: deliveryMergeCommit(context, profile, state),
      close_receipt_hash: state.close_receipt?.receipt_hash || null,
    };
  } catch {
    return null;
  }
}

/** Commits the story's delivery recorded with git.commit receipts, pinned on the remote when it finishes. */
function storyDeliveryCommitShas(context, storyId) {
  try {
    const { profile_id: profileId } = storyReleaseReadiness(context, storyId);
    return profileId ? gitCommitReceiptShas(deliveryActionReceipts(context, profileId)) : [];
  } catch {
    return [];
  }
}

export function storyReleaseReadiness(context, storyId) {
  const missing = [];
  const releaseStep = readStoryStepRecords(context, storyId)
    .find((record) => record.status === "completed" && record.phase === releasePhaseName(context));
  const releaseTrace = latestTraceEvent(readTraceEvents(context, storyId), "release");
  const story = readStory(context, storyId);
  const contract = story?.contract_id
    ? readContractById(context, story.contract_id, { missingOk: true })
    : null;
  const profileId = contract?.delivery_execution_profile_id || null;
  let deliveryReady = false;
  let readyForReviewCloseAvailable = false;
  if (profileId) {
    try {
      const profile = readDeliveryAutonomyProfile(context, profileId);
      const state = currentDeliveryExecutionState(context, profile);
      deliveryReady = state.lifecycle_status === "terminal"
        && ["merged", "merged_externally", "ready_for_review", "released"].includes(state.status);
      readyForReviewCloseAvailable = state.lifecycle_status === "started"
        && profile.delivery_kind === "pull_request"
        && pullRequestReadyForReviewCompletion(profile, deliveryActionReceipts(context, profile.id))
          .errors.length === 0;
    } catch {
      deliveryReady = false;
      readyForReviewCloseAvailable = false;
    }
  }
  if (!deliveryReady) missing.push("terminal successful delivery");
  if (releaseTrace?.outcome !== "passed") missing.push("passing release trace");
  if (!releaseStep) missing.push("completed release step");
  return {
    ready: missing.length === 0,
    missing,
    profile_id: profileId,
    ready_for_review_close_available: readyForReviewCloseAvailable,
  };
}

export function assertReleaseClaimPrecondition(context, storyId, options) {
  if (!options["release-claim"]) {
    return;
  }
  const claimPath = path.join(context.sdlcRoot, "stories", storyId, "claim.json");
  if (!fs.existsSync(claimPath)) {
    fail(`Story ${storyId} has no claim to release`);
  }
  const claim = readProjectJson(context, claimPath);
  if (claim.status !== "active") {
    fail(`Story ${storyId} claim is '${claim.status}', not active`);
  }
}

export function validateCompletedProviderActionReceipt(context, report, profile, receipt, authorization, label) {
  const authorizedOperation = authorization.action_details?.provider_operation;
  const completedOperation = receipt.action_details?.provider_operation;
  if (!authorizedOperation && !completedOperation) return false;
  try {
    if (!authorizedOperation || !completedOperation) {
      throw new Error("provider proof is missing from one side of the action boundary");
    }
    const precondition = assertProviderOperationReceiptIntegrity(authorizedOperation.precondition_receipt);
    const completion = assertProviderOperationReceiptIntegrity(completedOperation.completion_receipt);
    if (authorizedOperation.completion_receipt !== null) {
      throw new Error("authorization unexpectedly contains a completion proof");
    }
    if (
      stableJson(authorizedOperation.binding) !== stableJson(completedOperation.binding)
      || completedOperation.precondition_receipt?.receipt_hash !== precondition.receipt_hash
      || completion.precondition_receipt_ref?.id !== precondition.id
      || completion.precondition_receipt_ref?.hash !== precondition.receipt_hash
      || completion.provider.id !== precondition.provider.id
      || completion.operation.id !== precondition.operation.id
      || completion.operation.action !== receipt.action
      || stableJson(completion.subject) !== stableJson(precondition.subject)
    ) {
      throw new Error("provider completion is not bound to its exact precondition");
    }
    const binding = providerBindingForAction(profile, receipt.action);
    if (
      !binding
      || binding.provider_id !== precondition.provider.id
      || authorizedOperation.binding?.provider_bindings_hash !== (profile.provider_bindings_hash || null)
    ) {
      throw new Error("provider proof does not match the delivery profile binding");
    }
    const expectedSubject = deliveryProviderOperationSubject(
      context,
      profile,
      receipt.action,
      authorization.action_details,
      authorization.authorized_at,
    );
    if (!deliveryProviderOperationSubjectsMatch(receipt.action, precondition.subject, expectedSubject)) {
      throw new Error("provider proof subject differs from the authorized operation");
    }
    if (receipt.action === "git.push" && completion.proof?.observed_sha !== precondition.subject.source_sha) {
      throw new Error("Git provider proof does not show the authorized source at the destination ref");
    }
    if (receipt.action === "pull_request.merge" && (
      completion.proof?.state !== "MERGED"
      || completion.proof?.head_sha !== precondition.subject.source_sha
      || completion.proof?.head_branch !== precondition.subject.head_branch
      || completion.proof?.base_branch !== precondition.subject.base_branch
      || completion.proof?.pr_url !== precondition.subject.pr_url
      || !completion.proof?.merge_commit_sha
      || (precondition.subject.base_sha !== undefined && (
        precondition.proof?.base_sha !== precondition.subject.base_sha
        || completion.proof?.base_sha !== precondition.subject.base_sha
      ))
    )) {
      throw new Error("pull-request provider proof does not show the exact merged head");
    }
    if (receipt.action === "pull_request.create" && (
      completion.proof?.state !== "OPEN"
      || completion.proof?.head_sha !== precondition.subject.source_sha
    )) {
      throw new Error("pull-request provider proof does not show the exact created PR");
    }
    if (receipt.action === "pull_request.update" && (
      completion.proof?.state !== "OPEN"
      || stableJson(completion.proof?.expected) !== stableJson(precondition.subject.expected)
    )) {
      throw new Error("pull-request provider proof does not show the exact requested update");
    }
    if (receipt.action === "release.local" && (
      completion.proof?.root_path !== precondition.subject.root_path
      || completion.proof?.root_identity?.device !== precondition.proof?.root_identity?.device
      || completion.proof?.root_identity?.inode !== precondition.proof?.root_identity?.inode
    )) {
      throw new Error("filesystem provider proof does not preserve the authorized root identity");
    }
    if (receipt.action === "rollback.verify" && (
      completion.proof?.transition !== "rollback_evidence_verified"
      || completion.proof?.verified !== true
      || completion.proof?.root_path !== precondition.subject.root_path
      || completion.proof?.rollback_procedure !== precondition.subject.rollback_procedure
      || completion.proof?.root_identity?.device !== precondition.proof?.root_identity?.device
      || completion.proof?.root_identity?.inode !== precondition.proof?.root_identity?.inode
      || completion.proof?.evidence_root_identity?.device
        !== precondition.proof?.evidence_root_identity?.device
      || completion.proof?.evidence_root_identity?.inode
        !== precondition.proof?.evidence_root_identity?.inode
      || stableJson(
        completion.proof?.evidence?.map((item) => ({
          path: item.path,
          sha256: item.sha256,
        })),
      ) !== stableJson(precondition.subject.evidence)
    )) {
      throw new Error("filesystem provider proof does not verify the exact rollback target, procedure, and evidence");
    }
    if (receipt.action === "data.migrate" && (
      completion.proof?.transition !== "migrated"
      || completion.proof?.target?.path !== precondition.subject.target_path
      || completion.proof?.backup?.path !== precondition.subject.backup_path
      || completion.proof?.before_target_sha256 !== precondition.proof?.target?.sha256
      || completion.proof?.backup_sha256 !== precondition.proof?.target?.sha256
      || completion.proof?.after_target_sha256 !== completion.proof?.target?.sha256
      || completion.proof?.after_target_sha256 === completion.proof?.before_target_sha256
    )) {
      throw new Error("filesystem provider proof does not show the exact migrated target and pre-migration backup");
    }
    if (receipt.action === "data.rollback" && (
      completion.proof?.transition !== "rolled_back"
      || completion.proof?.target?.path !== precondition.subject.target_path
      || completion.proof?.backup?.path !== precondition.subject.backup_path
      || completion.proof?.before_target_sha256 !== precondition.proof?.target?.sha256
      || completion.proof?.backup_sha256 !== precondition.proof?.backup?.sha256
      || completion.proof?.after_target_sha256 !== completion.proof?.backup_sha256
      || completion.proof?.after_target_sha256 !== completion.proof?.target?.sha256
      || completion.proof?.before_target_sha256 === completion.proof?.backup_sha256
      || completion.proof?.after_target_sha256 === completion.proof?.before_target_sha256
    )) {
      throw new Error("filesystem provider proof does not show a real target transition to the exact approved backup");
    }
    const stripCompletion = (details) => {
      const copy = structuredClone(details || {});
      if (copy.provider_operation) copy.provider_operation.completion_receipt = null;
      delete copy.remote_verification;
      delete copy.provider_verification;
      return copy;
    };
    const runtimeTransition = receipt.action === "pull_request.merge"
      ? validatePullRequestMergeRuntimeTransition(context, authorization, receipt.runtime_target, completion.proof)
      : {
          valid: stableJson(receipt.runtime_target) === stableJson(authorization.runtime_target),
          errors: ["the runtime target differs from its exact authorization"],
        };
    if (
      !runtimeTransition.valid
      || stableJson(stripCompletion(receipt.action_details)) !== stableJson(stripCompletion(authorization.action_details))
    ) {
      throw new Error("provider completion differs from the exact authorization boundary");
    }
  } catch (error) {
    report.errors.push(`${label} has invalid provider verification: ${error.message}`);
  }
  return true;
}

export function hashDeliveryActionEvidenceAtRevision(context, receipt, evidencePath) {
  const revision = deliveryActionEvidenceRevision(receipt);
  if (!revision) return null;
  const projectPath = toProjectPath(context, evidencePath);
  if (
    !projectPath
    || path.isAbsolute(projectPath)
    || projectPath === ".."
    || projectPath.startsWith("../")
    || projectPath.includes("\0")
  ) {
    return null;
  }
  // A blob at a commit never changes: inside a read snapshot it is hashed once.
  return readSnapshotValue(
    `git:blob-hash:${JSON.stringify([context.root, revision, projectPath])}`,
    () => cachedGitObjectAnswer(context.root, "blob-sha256", ["cat-file", "blob", `${revision}:${projectPath}`], () => {
      try {
        const blob = childProcess.execFileSync(
          "git",
          ["-C", context.root, "cat-file", "blob", `${revision}:${projectPath}`],
          { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
        );
        return hashBuffer(blob);
      } catch {
        return null;
      }
    }),
  );
}

/**
 * A gate file is rewritten by every later gate run. Its recorded content stays
 * recoverable from the content-addressed copy the gate keeps, or, for records
 * made before that copy existed, from a blob in the project's Git history.
 */
function recoveredGateEvidenceSource(context, evidence, evidencePath) {
  const projectPath = toProjectPath(context, evidencePath);
  if (!/^\.sdlc\/gates\/[A-Za-z0-9._-]+-(?:strict|final)\.json$/u.test(projectPath || "")) return null;
  const archivePath = gateEvidenceArchivePath(evidencePath, evidence.sha256);
  try {
    if (fs.existsSync(archivePath) && hashFile(archivePath) === evidence.sha256) {
      return toProjectPath(context, archivePath);
    }
  } catch {
    // fall through to Git history
  }
  try {
    const commits = childProcess.execFileSync(
      "git",
      ["-C", context.root, "log", "--all", "--format=%H", "--", projectPath],
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true, encoding: "utf8" },
    ).split("\n").filter(Boolean).slice(0, 200);
    for (const commit of commits) {
      try {
        const blob = childProcess.execFileSync(
          "git",
          ["-C", context.root, "cat-file", "blob", `${commit}:${projectPath}`],
          { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
        );
        if (hashBuffer(blob) === evidence.sha256) return `Git revision ${commit.slice(0, 12)}`;
      } catch {
        // the path is absent at this commit
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function validateDeliveryActionEvidence(context, report, receipt, actionLabel, evidence, changedMessage) {
  try {
    const evidencePath = resolveProjectFilePath(context, evidence.path, { mustExist: true, fileOnly: true });
    if (hashFile(evidencePath) === evidence.sha256) return;
    if (hashDeliveryActionEvidenceAtRevision(context, receipt, evidencePath) === evidence.sha256) {
      const warning = `${actionLabel} evidence is verified from its exact Git revision because the current file changed later: ${evidence.path}`;
      if (!report.warnings.includes(warning)) report.warnings.push(warning);
      return;
    }
    const recovered = recoveredGateEvidenceSource(context, evidence, evidencePath);
    if (recovered) {
      const warning = `${actionLabel} evidence was replaced by a later gate run and is verified from ${recovered}: ${evidence.path}`;
      if (!report.warnings.includes(warning)) report.warnings.push(warning);
      return;
    }
    const superseded = findEvidenceSupersede(context, receipt, evidence);
    if (superseded) {
      const note = `evidence ${evidence.path} of ${receipt.id} superseded by a person: ${superseded.reason}`;
      if (!report.warnings.includes(note)) report.warnings.push(note);
      return;
    }
    report.errors.push(`${actionLabel} ${changedMessage}: ${evidence.path}`);
  } catch (error) {
    report.errors.push(`${actionLabel} evidence is unavailable: ${error.message}`);
  }
}

export function validateDeliveryExecutionReceipts(context, report, profile, state, label, options = {}) {
  if (state.lifecycle_status === "available") return;
  const actions = deliveryActionReceipts(context, profile.id);
  const attempts = profile.delivery_kind === "local_release"
    ? deliveryActionAttemptReceipts(context, profile.id)
    : [];
  if (profile.local_release_target?.data_migration) {
    report.errors.push(...dataMigrationPreviewEvidenceErrors(
      context,
      profile.local_release_target.data_migration,
    ).map((error) => `${label} ${error}`));
  }
  const recoverableTerminal = options.allowRecoverableTerminal === true
    && actions.some((receipt) =>
      terminalStatusForDeliveryAction(receipt.action)
      && receipt.status === "completed"
      && receipt.outcome === "passed");
  const historical = state.lifecycle_status === "terminal"
    || effectiveDeliveryProfileStatus(context, profile).status === "revoked"
    || recoverableTerminal;
  if (profile.delivery_kind === "local_release") {
    const baseline = state.start_receipt?.local_release_target_baseline || null;
    if (!baseline) {
      if (
        historical
        && state.start_receipt?.schema_version === "delivery-start-receipt:v1"
      ) {
        const warning = `${label} has a terminal historical v1 start without an immutable local-target baseline; its existing terminal receipts are audited, but the start cannot authorize more work`;
        if (!report.warnings.includes(warning)) report.warnings.push(warning);
      } else {
        report.errors.push(`${label} ${activeLegacyLocalStartError(profile)}`);
      }
    } else {
      const baselineErrors = localReleaseTargetSnapshotErrors(
        context,
        profile,
        baseline,
        {
          purpose: "task_start",
          requireCurrentWorkspace: (
            !historical
            && localReleaseTargetHadAbsentEntries(baseline)
          ),
        },
      );
      if (baseline.observed_at !== state.start_receipt.started_at) {
        baselineErrors.push("local target snapshot does not match its delivery-start time");
      }
      report.errors.push(...baselineErrors.map((error) =>
        `${label} immutable local-target baseline is invalid: ${error}`));
      report.checked.push(`${label} immutable local-target baseline`);
    }
  }
  const consumedAuthorizationIds = new Set(actions
    .filter((receipt) => receipt.status === "completed")
    .map((receipt) => receipt.authorization_receipt_ref?.id)
    .filter(Boolean));
  for (const attempt of attempts) {
    if (attempt.authorization_receipt_ref?.id) {
      consumedAuthorizationIds.add(attempt.authorization_receipt_ref.id);
    }
  }
  const authorizationsById = new Map(actions
    .filter((receipt) => receipt.status === "authorized")
    .map((receipt) => [receipt.id, receipt]));
  const attemptsById = new Map();
  const attemptCountByAuthorization = new Map();
  for (const attempt of attempts) {
    const attemptLabel = `${label} local release attempt ${attempt.id}`;
    if (attemptsById.has(attempt.id)) {
      report.errors.push(`${attemptLabel} duplicates another write-ahead attempt id`);
      continue;
    }
    attemptsById.set(attempt.id, attempt);
    const authorization = authorizationsById.get(attempt.authorization_receipt_ref?.id);
    report.errors.push(...localReleaseAttemptReceiptErrors(
      context,
      profile,
      attempt,
      authorization,
    ).map((error) => `${attemptLabel} is invalid: ${error}`));
    const authorizationKey = `${attempt.authorization_receipt_ref?.id || "missing"}:`
      + `${attempt.authorization_receipt_ref?.hash || "missing"}`;
    attemptCountByAuthorization.set(
      authorizationKey,
      (attemptCountByAuthorization.get(authorizationKey) || 0) + 1,
    );
    report.checked.push(attemptLabel);
  }
  for (const [authorizationKey, count] of attemptCountByAuthorization.entries()) {
    if (count > 1) {
      report.errors.push(
        `${label} action authorization ${authorizationKey} has ${count} write-ahead attempts`,
      );
    }
  }
  const completionCountByAttempt = new Map();
  const liveAuthorizationIds = new Set();
  const liveAuthorizationsByAction = new Map();
  for (const authorization of actions.filter((receipt) =>
    receipt.status === "authorized" && !consumedAuthorizationIds.has(receipt.id))) {
    const current = liveAuthorizationsByAction.get(authorization.action);
    if (!current || compareDeliveryAuthorizationOrder(current, authorization) < 0) {
      liveAuthorizationsByAction.set(authorization.action, authorization);
    }
  }
  for (const authorization of liveAuthorizationsByAction.values()) {
    liveAuthorizationIds.add(authorization.id);
  }
  let expectedEffectiveLevel = "supervised";
  try {
    const start = state.start_receipt;
    const decisionPath = resolveProjectFilePath(context, start.autonomy_decision_ref.path, { mustExist: true, fileOnly: true });
    const startDecision = readProjectJson(context, decisionPath);
    const integrity = validateAutonomyDecisionIntegrity(startDecision);
    if (
      !integrity.valid
      || startDecision.id !== start.autonomy_decision_ref.id
      || startDecision.decision_hash !== start.autonomy_decision_ref.hash
      || startDecision.delivery?.profile_id !== profile.id
      || !deliveryProfileHashMatches(profile, startDecision.delivery?.profile_hash)
      || start.effective_level !== startDecision.effective_level
    ) {
      report.errors.push(`${label} immutable start receipt has a stale or tampered autonomy decision`);
    } else {
      expectedEffectiveLevel = startDecision.effective_level;
      if (!historical) {
        const startedProfile = readDeliveryProfileAtHash(context, profile, startDecision.delivery?.profile_hash) || profile;
        const { decision: freshStartDecision } = evaluateDeliveryAutonomy(context, startedProfile, {
          id: startDecision.id,
          phase: startDecision.phase || undefined,
          evaluated_at: startDecision.evaluated_at,
          allowHistorical: true,
          deliveryStateOverride: {
            delivery_id: profile.delivery_id,
            status: "open",
            active_run_count: 1,
          },
        });
        if (stableJson(autonomyDecisionSemanticProjection(startDecision)) !== stableJson(autonomyDecisionSemanticProjection(freshStartDecision))) {
          report.errors.push(`${label} immutable start decision is not reproducible from its exact profile inputs`);
        }
        expectedEffectiveLevel = freshStartDecision.effective_level;
      }
    }
    const currentContract = readContractById(context, start.contract_ref.id, { missingOk: true });
    const currentStory = readStory(context, start.story_ref.id);
    const profileContractRef = (profile.contract_refs || []).find((ref) => ref.id === start.contract_ref.id);
    const profileStoryRef = (profile.story_refs || []).find((ref) => ref.id === start.story_ref.id);
    if (
      !currentContract
      || !currentStory
      || !profileContractRef
      || !profileStoryRef
      || start.contract_ref.hash !== profileContractRef.hash
      || start.story_ref.hash !== profileStoryRef.hash
      || start.contract_ref.hash !== hashApprovalSubject(currentContract)
      || (!historical && start.story_ref.hash !== hashApprovalSubject(currentStory))
      || start.contract_approval_hash !== latestContractApproval(currentContract)?.approved_content_hash
      || start.delivery?.id !== profile.delivery_id
      || start.delivery?.kind !== profile.delivery_kind
      || start.phase !== startDecision.phase
      || start.phase !== currentContract.phase
    ) {
      report.errors.push(`${label} immutable start receipt is stale for its story, contract, phase, or delivery identity`);
    }
    const taskReceiptPath = path.join(context.sdlcRoot, "stories", start.story_ref.id, "task-start.json");
    if (fs.existsSync(taskReceiptPath)) {
      const taskReceipt = readProjectJson(context, taskReceiptPath);
      const belongsToThisExecution = taskReceipt.delivery_start_receipt_ref?.id === start.id
        || taskReceipt.delivery_profile_ref?.id === profile.id;
      if ((!historical || belongsToThisExecution) && (
        taskReceipt.delivery_start_receipt_ref?.id !== start.id
        || taskReceipt.delivery_start_receipt_ref?.hash !== start.receipt_hash
        || taskReceipt.route !== start.route
        || taskReceipt.phase !== start.phase
      )) {
        report.errors.push(`${label} immutable start receipt disagrees with its task-start receipt`);
      }
    }
  } catch (error) {
    report.errors.push(`${label} immutable start receipt cannot be verified: ${error.message}`);
  }
  for (const receipt of actions) {
    const actionLabel = `${label} action receipt ${receipt.id}`;
    const supersededAuthorization = receipt.status === "authorized"
      && !consumedAuthorizationIds.has(receipt.id)
      && !liveAuthorizationIds.has(receipt.id);
    const receiptHistorical = historical
      || receipt.status === "completed"
      || consumedAuthorizationIds.has(receipt.id)
      || supersededAuthorization;
    if (supersededAuthorization) {
      const warning = `${actionLabel} is superseded by a later unconsumed authorization for the same action`;
      if (!report.warnings.includes(warning)) report.warnings.push(warning);
    }
    if (!deliveryProfileHashMatches(profile, receipt.profile_ref?.hash)) {
      report.errors.push(`${actionLabel} is bound to stale profile content`);
    }
    if (receipt.delivery?.id !== profile.delivery_id || receipt.delivery?.kind !== profile.delivery_kind) {
      report.errors.push(`${actionLabel} is bound to the wrong delivery identity`);
    }
    let canonicalAction = null;
    try {
      canonicalAction = normalizeDeliveryAction(profile.delivery_kind, receipt.action);
    } catch (error) {
      report.errors.push(`${actionLabel} has an invalid action: ${error.message}`);
    }
    if (canonicalAction !== receipt.action || !deliveryTargetAllowedActions(profile).includes(receipt.action)) {
      report.errors.push(`${actionLabel} action is outside the exact profile action catalog`);
    }
    if (
      receipt.status === "authorized"
      && receipt.action === "build.local"
      && state.start_receipt?.local_release_target_baseline
    ) {
      try {
        const predecessor = localReleaseTargetGovernanceState(
          context,
          profile,
          state,
          {
            requireCurrentWorkspace: false,
            beforeReceipt: receipt,
          },
        );
        report.errors.push(...predecessor.invalid.map((error) =>
          `${actionLabel} has invalid predecessor build governance: ${error}`));
        report.errors.push(...localTargetBuildAuthorizationErrors(
          context,
          profile,
          receipt,
          predecessor,
        ).map((error) => `${actionLabel} is invalid: ${error}`));
      } catch (error) {
        report.errors.push(`${actionLabel} build authorization cannot be verified: ${error.message}`);
      }
    }
    if (
      receipt.status === "authorized"
      && profile.delivery_kind === "local_release"
      && GOVERNED_LOCAL_TARGET_ACTIONS.includes(receipt.action)
    ) {
      report.errors.push(...localTargetMaterializationRefErrors(
        context,
        profile,
        state,
        receipt,
      ).map((error) => `${actionLabel} has invalid target materialization: ${error}`));
    }
    if (receipt.status === "authorized" && DELIVERY_PROVIDER_ACTIONS.has(receipt.action)) {
      try {
        assertDeliveryProviderAuthorization(context, profile, receipt);
      } catch (error) {
        report.errors.push(`${actionLabel} provider authorization is invalid: ${error.message}`);
      }
    }
    const actionPolicy = receiptHistorical && profile.delivery_kind === "local_release"
      ? null
      : deliveryActionCheckpointRequired(context, profile, expectedEffectiveLevel, receipt.action);
    if (receipt.effective_level !== expectedEffectiveLevel) {
      report.errors.push(`${actionLabel} effective level differs from the immutable delivery start decision`);
    }
    const checkpointSnapshot = receipt.action_details?.checkpoint_policy;
    const snapshotValidation = checkpointSnapshot
      ? validateDeliveryActionCheckpointPolicySnapshot(
          context,
          checkpointSnapshot,
          profile,
          expectedEffectiveLevel,
          receipt.action,
        )
      : null;
    if (snapshotValidation && !snapshotValidation.valid) {
      report.errors.push(`${actionLabel} has an invalid checkpoint policy snapshot: ${snapshotValidation.errors.join("; ")}`);
    }
    let checkpointRequired = actionPolicy?.required ?? false;
    if (snapshotValidation?.valid) {
      checkpointRequired = checkpointSnapshot.required;
      if (actionPolicy) {
        const currentSnapshot = deliveryActionCheckpointPolicySnapshot(
          context,
          profile,
          expectedEffectiveLevel,
          receipt.action,
          actionPolicy,
        );
        if (stableJson(checkpointSnapshot) !== stableJson(currentSnapshot)) {
          if (
            !receiptHistorical
            && localDeliveryRuntimeBoundaryChanged(checkpointSnapshot, currentSnapshot)
          ) {
            report.errors.push(
              `${actionLabel} was approved for a different local target or machine scope; authorize this exact action again`,
            );
          } else {
            const policyWarning = `${actionLabel} remains valid for this exact action; updated approval rules apply to later actions`;
            if (!report.warnings.includes(policyWarning)) report.warnings.push(policyWarning);
          }
        }
      }
    } else if (receiptHistorical) {
      const immutableLegacyCheckpoint = expectedEffectiveLevel === "supervised"
        || (profile.checkpoints || []).includes(receipt.action)
        || deliveryBoundaryCheckpointActions(profile).includes(receipt.action)
        || receipt.action === "release.local";
      if (immutableLegacyCheckpoint && receipt.checkpoint_required !== true) {
        report.errors.push(`${actionLabel} omits a checkpoint required by its immutable legacy boundary`);
      }
      checkpointRequired = receipt.checkpoint_required === true;
      const legacyWarning = `${label} uses legacy action receipts without an event-time checkpoint policy snapshot; immutable boundaries and recorded approvals were verified`;
      if (!report.warnings.includes(legacyWarning)) report.warnings.push(legacyWarning);
    }
    if (receipt.checkpoint_required !== checkpointRequired) {
      report.errors.push(`${actionLabel} checkpoint flag does not match its exact action policy`);
    }
    if (checkpointRequired && receipt.status === "authorized") {
      if (receipt.approval?.status !== "approved") {
        report.errors.push(`${actionLabel} is missing its required formal checkpoint approval`);
      }
      validateFormalApprovalRecord(
        context,
        report,
        receipt.approval,
        `${actionLabel} approval`,
        receipt.approval?.approved_by,
        { subject_id: profile.id },
      );
      const approvalSubject = {
        profile_id: profile.id,
        profile_hash: profile.profile_hash,
        delivery_id: profile.delivery_id,
        action: receipt.action,
        runtime_target: receipt.runtime_target,
        action_details: receipt.action_details,
      };
      if (receipt.approval?.approved_content_hash !== hashApprovalSubject(approvalSubject)) {
        report.errors.push(`${actionLabel} approval does not bind its exact action and runtime target`);
      }
      try {
        validateApprovalEvidenceIntegrity(context, receipt.approval, `${actionLabel} approval`);
      } catch (error) {
        report.errors.push(`${actionLabel} approval evidence is invalid: ${error.message}`);
      }
      try {
        validateDeliveryActionHostAuthority(context, profile, receipt);
      } catch (error) {
        report.errors.push(`${actionLabel} host authority is invalid: ${error.message}`);
      }
    }
    for (const evidence of receipt.evidence || []) {
      validateDeliveryActionEvidence(
        context,
        report,
        receipt,
        actionLabel,
        evidence,
        "evidence changed after recording",
      );
    }
    if (receipt.status === "completed") {
      if (!Array.isArray(receipt.evidence) || receipt.evidence.length === 0) {
        report.errors.push(`${actionLabel} completion has no immutable evidence`);
      }
      const authorization = actions.find((candidate) =>
        candidate.id === receipt.authorization_receipt_ref?.id
        && candidate.receipt_hash === receipt.authorization_receipt_ref?.hash
        && candidate.action === receipt.action
        && candidate.status === "authorized");
      const releaseAttempt = receipt.attempt_receipt_ref
        ? attemptsById.get(receipt.attempt_receipt_ref.id)
        : null;
      if (receipt.attempt_receipt_ref) {
        if (
          receipt.action !== "release.local"
          || !releaseAttempt
          || stableJson(releaseAttempt.authorization_receipt_ref)
            !== stableJson(receipt.authorization_receipt_ref)
          || stableJson(receipt.attempt_receipt_ref)
            !== stableJson(deliveryActionAttemptReceiptRef(context, profile, releaseAttempt))
        ) {
          report.errors.push(`${actionLabel} has an invalid write-ahead local release attempt reference`);
        } else {
          completionCountByAttempt.set(
            releaseAttempt.id,
            (completionCountByAttempt.get(releaseAttempt.id) || 0) + 1,
          );
        }
        if (!receipt.local_release_verification) {
          report.errors.push(
            `${actionLabel} references a write-ahead attempt without its local release verification`,
          );
        }
      }
      if (!authorization) {
        report.errors.push(`${actionLabel} does not reference its matching authorization receipt`);
      } else if (receipt.effective_level !== authorization.effective_level) {
        report.errors.push(`${actionLabel} completion differs from its authorized effective level`);
      } else {
        const completionRequestValidation = validateDeliveryCompletionRequest(
          context,
          receipt,
          authorization,
        );
        if (completionRequestValidation.legacy) {
          const warning = `${actionLabel} is a legacy completion without an immutable completion request`;
          if (!report.warnings.includes(warning)) report.warnings.push(warning);
        } else if (!completionRequestValidation.valid) {
          report.errors.push(
            `${actionLabel} has an invalid completion identity: `
            + `${completionRequestValidation.errors.join("; ")}`,
          );
        }
        if (receipt.action === "git.commit" && receipt.outcome === "passed") {
          validateCompletedGitCommitReceipt(context, report, receipt, authorization, actionLabel);
        } else if (
          receipt.action === "build.local"
          && state.start_receipt?.local_release_target_baseline
        ) {
          if (!localTargetBuildCompletionDetails(receipt)) {
            report.errors.push(
              `${actionLabel} has no immutable local-target completion snapshot`,
            );
          }
          const predecessor = localReleaseTargetGovernanceState(
            context,
            profile,
            state,
            {
              requireCurrentWorkspace: false,
              beforeReceipt: receipt,
            },
          );
          report.errors.push(...predecessor.invalid.map((error) =>
            `${actionLabel} has invalid predecessor build governance: ${error}`));
          report.errors.push(...localTargetBuildReceiptErrors(
            context,
            profile,
            receipt,
            authorization,
            predecessor,
          ).map((error) => `${actionLabel} is invalid: ${error}`));
        } else if (
          DELIVERY_PROVIDER_ACTIONS.has(receipt.action)
          && (
            receipt.outcome === "passed"
            || receipt.action_details?.provider_operation?.completion_receipt
          )
        ) {
          validateCompletedRemoteActionReceipt(context, report, profile, receipt, authorization, actionLabel);
        } else if (
          stableJson(receipt.runtime_target) !== stableJson(authorization.runtime_target)
          || stableJson(receipt.action_details) !== stableJson(authorization.action_details)
        ) {
          report.errors.push(`${actionLabel} completion differs from its exact authorization boundary`);
        }
      }
      if (receipt.action === "release.local" && receipt.outcome === "passed") {
        const verification = receipt.local_release_verification;
        const commands = (verification?.smoke_test_receipts || []).map((item) => stableJson(item.command)).sort();
        const approvedCommands = [...(profile.local_release_target?.smoke_tests || [])].sort();
        const configuredSmokeCwd = profile.local_release_target?.smoke_cwd
          ? path.resolve(profile.local_release_target.smoke_cwd)
          : null;
        const derivedSmokeCwd = !configuredSmokeCwd
          && profile.local_release_target?.allowed_write_paths?.length === 1
          ? path.resolve(profile.local_release_target.allowed_write_paths[0])
          : null;
        const recordedSmokeCwd = verification?.smoke_cwd
          ? path.resolve(verification.smoke_cwd)
          : null;
        const legacySmokeCwd = !configuredSmokeCwd
          && !recordedSmokeCwd
          && profile.local_release_target?.root_path
          ? path.resolve(profile.local_release_target.root_path)
          : null;
        const expectedSmokeCwd = configuredSmokeCwd || recordedSmokeCwd || legacySmokeCwd;
        if (
          verification?.target_root !== profile.local_release_target?.root_path
          || stableJson(commands) !== stableJson(approvedCommands)
          || (configuredSmokeCwd && recordedSmokeCwd !== configuredSmokeCwd)
          || (recordedSmokeCwd && recordedSmokeCwd !== derivedSmokeCwd && !configuredSmokeCwd)
          || (verification?.smoke_test_receipts || []).some((item) =>
            path.resolve(item.cwd) !== expectedSmokeCwd
            || item.outcome !== "passed"
            || item.exit_code !== 0)
        ) {
          report.errors.push(`${actionLabel} does not prove the exact approved local smoke-test set and target`);
        }
        const integrityValidation = localReleaseCompletionIntegrityErrors(
          context,
          profile,
          receipt,
          authorization,
          {
            revalidateArtifact: true,
            supersededLocalReleasePaths: options.supersededLocalReleasePaths || null,
            attempt: releaseAttempt,
          },
        );
        if (integrityValidation.legacy) {
          const warning = `${actionLabel} is a legacy local release without smoke-bound artifact integrity`;
          if (!report.warnings.includes(warning)) report.warnings.push(warning);
        } else {
          report.errors.push(...integrityValidation.errors.map((error) =>
            `${actionLabel} local release integrity is invalid: ${error}`));
        }
        if (profile.local_release_target?.rollback?.verification_required === true) {
          const rollbackRef = verification?.rollback_verification_receipt_ref;
          const rollbackReceipt = actions.find((candidate) =>
            candidate.id === rollbackRef?.id
            && candidate.receipt_hash === rollbackRef?.hash
            && candidate.action === "rollback.verify"
            && candidate.status === "completed"
            && candidate.outcome === "passed");
          const rollbackErrors = rollbackReceipt
            ? rollbackVerificationReceiptErrors(context, profile, rollbackReceipt, actions)
            : ["release receipt does not reference a completed passing rollback.verify receipt"];
          if (
            rollbackReceipt
            && authorization
            && compareDeliveryAuthorizationOrder(rollbackReceipt, authorization) >= 0
          ) {
            rollbackErrors.push("rollback.verify was not completed before release.local authorization");
          }
          report.errors.push(...rollbackErrors.map((error) =>
            `${actionLabel} lacks its required rollback verification: ${error}`));
        }
        if (profile.local_release_target?.data_migration) {
          const sequenceResult = authorization
            ? reversibleDataReleaseSequence(context, profile, authorization)
            : { sequence: null, errors: ["release.local authorization is missing"] };
          if (
            !sequenceResult.sequence
            || stableJson(verification?.data_migration_sequence)
              !== stableJson(sequenceResult.sequence)
            || stableJson(authorization?.action_details?.data_migration_sequence)
              !== stableJson(sequenceResult.sequence)
          ) {
            report.errors.push(
              `${actionLabel} lacks its exact reversible data release sequence: `
              + `${sequenceResult.errors.join("; ") || "receipt references differ from the verified sequence"}`,
            );
          }
        } else if (verification?.data_migration_sequence) {
          report.errors.push(`${actionLabel} unexpectedly records a reversible data sequence`);
        }
      } else if (
        receipt.action === "release.local"
        && receipt.outcome === "failed"
        && receipt.local_release_verification
      ) {
        const integrityValidation = localReleaseCompletionIntegrityErrors(
          context,
          profile,
          receipt,
          authorization,
          { attempt: releaseAttempt },
        );
        if (integrityValidation.legacy) {
          report.errors.push(`${actionLabel} failed smoke attempt lacks its write-ahead integrity boundary`);
        } else {
          report.errors.push(...integrityValidation.errors.map((error) =>
            `${actionLabel} failed release integrity is invalid: ${error}`));
        }
      }
      if (receipt.action === "rollback.verify" && receipt.outcome === "passed") {
        report.errors.push(...rollbackVerificationReceiptErrors(
          context,
          profile,
          receipt,
          actions,
        ).map((error) => `${actionLabel} is invalid: ${error}`));
      }
      if (["data.migrate", "data.rollback"].includes(receipt.action) && receipt.outcome === "passed") {
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
          report.errors.push(`${actionLabel} lacks its exact reversible data-operation verification`);
        }
      }
      for (const evidence of receipt.local_release_verification?.evidence || []) {
        validateDeliveryActionEvidence(
          context,
          report,
          receipt,
          actionLabel,
          evidence,
          "evidence changed after completion",
        );
      }
    }
    report.checked.push(actionLabel);
  }
  for (const [attemptId, count] of completionCountByAttempt.entries()) {
    if (count > 1) {
      report.errors.push(`${label} local release attempt ${attemptId} has ${count} completions`);
    }
  }
  for (const attempt of attempts) {
    if (!completionCountByAttempt.has(attempt.id)) {
      const warning = `${label} local release attempt ${attempt.id} has no completion; its authorization remains consumed`;
      if (!report.warnings.includes(warning)) report.warnings.push(warning);
    }
  }
  for (const authorization of actions.filter((receipt) => receipt.status === "authorized")) {
    const uses = actions.filter((receipt) =>
      receipt.status === "completed"
      && receipt.authorization_receipt_ref?.id === authorization.id
      && receipt.authorization_receipt_ref?.hash === authorization.receipt_hash);
    const attemptUses = attempts.filter((attempt) =>
      attempt.authorization_receipt_ref?.id === authorization.id
      && attempt.authorization_receipt_ref?.hash === authorization.receipt_hash);
    if (uses.length > 1 || attemptUses.length > 1) {
      report.errors.push(`${label} action authorization ${authorization.id} was consumed more than once`);
    }
    if (
      attemptUses.length === 1
      && uses.some((completion) =>
        completion.action !== "release.local"
        || completion.attempt_receipt_ref?.id !== attemptUses[0].id
        || completion.attempt_receipt_ref?.hash !== attemptUses[0].receipt_hash)
    ) {
      report.errors.push(
        `${label} action authorization ${authorization.id} has a completion outside its write-ahead attempt`,
      );
    }
  }
  for (const authorization of actions.filter((receipt) =>
    receipt.action === "git.push" && receipt.status === "authorized")) {
    const basePrecondition = authorization.action_details?.base_precondition;
    const coverageRuntime = {
      ...authorization.runtime_target,
      base_sha: basePrecondition?.observed_sha,
      remote_branch_sha: authorization.action_details?.push_precondition?.observed_sha || undefined,
    };
    const coverageProof = authorization.action_details?.commit_coverage || null;
    const requiresCoverageProof = Boolean(
      authorization.action_details?.checkpoint_policy?.policy_source_ref,
    );
    const coverageErrors = requiresCoverageProof && !coverageProof
      ? ["Push authorization is missing its required immutable git-commit coverage proof."]
      : gitCommitReceiptCoverageErrors(
          context,
          profile,
          coverageRuntime,
          actions,
          coverageProof,
        );
    if (
      basePrecondition?.provider !== "git-remote"
      || basePrecondition.remote !== authorization.action_details?.push?.remote
      || basePrecondition.base_ref !== `refs/heads/${profile.pull_request_target?.base_branch}`
    ) {
      coverageErrors.unshift("Push authorization lacks the exact live remote base observation.");
    }
    report.errors.push(...coverageErrors.map((error) =>
      `${label} git.push authorization ${authorization.id} has incomplete commit mediation: ${error}`));
  }
  if (
    state.lifecycle_status === "started"
    && options.allowRecoverableTerminal !== true
    && actions.some((receipt) =>
      terminalStatusForDeliveryAction(receipt.action)
      && receipt.status === "completed"
      && receipt.outcome === "passed")
  ) {
    report.errors.push(`${label} has a passing terminal action receipt but no close receipt; rerun that action command to repair the close`);
  }
  if (state.lifecycle_status === "terminal") {
    const close = state.close_receipt;
    if (
      close.delivery?.id !== profile.delivery_id
      || close.delivery?.kind !== profile.delivery_kind
      || (profile.delivery_kind === "pull_request" && !["merged", "merged_externally", "ready_for_review", "closed", "cancelled", "superseded", "revoked"].includes(close.terminal_status))
      || (profile.delivery_kind === "local_release" && !["released", "rolled_back", "cancelled", "superseded", "revoked"].includes(close.terminal_status))
    ) {
      report.errors.push(`${label} terminal receipt has an invalid delivery identity or terminal status`);
    }
    const requiredAction = close.terminal_status === "merged"
      ? "pull_request.merge"
      : close.terminal_status === "released"
        ? "release.local"
        : null;
    if (close.terminal_status === "merged_externally") {
      const external = readExternalMergeReceipt(context, profile);
      const errors = [...external.errors];
      if (!external.receipt && errors.length === 0) errors.push("its external merge receipt is missing");
      if (external.receipt && (
        close.terminal_action_receipt_ref?.id !== external.receipt.id
        || close.terminal_action_receipt_ref?.hash !== external.receipt.receipt_hash
        || close.terminal_action_receipt_ref?.path !== external.path
        || external.receipt.delivery_status_at_reconcile !== "started"
        || stableJson(close.approval) !== stableJson(external.receipt.approval)
      )) {
        errors.push("the close receipt does not bind its exact external merge acknowledgement");
      }
      if (errors.length > 0) {
        report.errors.push(`${label} terminal merged_externally receipt is not proven: ${errors.join("; ")}`);
      }
    } else if (close.terminal_status === "ready_for_review") {
      const { completion, errors } = pullRequestReadyForReviewCompletion(profile, actions);
      if (
        !completion
        || close.terminal_action_receipt_ref?.id !== completion.id
        || close.terminal_action_receipt_ref?.hash !== completion.receipt_hash
      ) {
        errors.push("the close receipt does not bind the latest passing pull-request completion");
      }
      if (errors.length > 0) {
        report.errors.push(`${label} terminal ready_for_review receipt is not proven: ${[...new Set(errors)].join("; ")}`);
      }
    } else if (requiredAction) {
      const completion = actions.find((receipt) =>
        receipt.id === close.terminal_action_receipt_ref?.id
        && receipt.receipt_hash === close.terminal_action_receipt_ref?.hash
        && receipt.action === requiredAction
        && receipt.status === "completed"
        && receipt.outcome === "passed");
      if (!completion) {
        report.errors.push(`${label} terminal ${close.terminal_status} receipt lacks a passing ${requiredAction} completion`);
      }
    } else if (close.terminal_status === "revoked") {
      let revocation = null;
      try {
        revocation = effectiveDeliveryProfileStatus(context, profile).revocation;
      } catch (error) {
        report.errors.push(`${label} terminal revocation cannot be verified: ${error.message}`);
      }
      if (
        !revocation
        || revocation.reason !== close.reason
        || stableJson(revocation.approval) !== stableJson(close.approval)
      ) {
        report.errors.push(`${label} terminal revoked receipt lacks its exact validated revocation approval`);
      }
    } else {
      if (close.approval?.status !== "approved") {
        report.errors.push(`${label} terminal ${close.terminal_status} receipt lacks formal approval`);
        report.checked.push(`${label} terminal receipt ${close.id}`);
        return;
      }
      const closeSubject = {
        profile_id: profile.id,
        profile_hash: profile.profile_hash,
        start_receipt_hash: state.start_receipt.receipt_hash,
        terminal_status: close.terminal_status,
        reason: close.reason,
      };
      if (close.approval.approved_content_hash !== hashApprovalSubject(closeSubject)) {
        report.errors.push(`${label} terminal ${close.terminal_status} approval does not bind its exact close subject`);
      }
      validateFormalApprovalRecord(
        context,
        report,
        close.approval,
        `${label} terminal ${close.terminal_status} approval`,
        close.approval?.approved_by,
        { subject_id: profile.id },
      );
    }
    report.checked.push(`${label} terminal receipt ${close.id}`);
  }
}
