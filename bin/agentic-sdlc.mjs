#!/usr/bin/env node

import path from "node:path";
import zlib from "node:zlib";
// File system, child processes, OS, randomness, process, console and clock
// come from the host seam, so every code path can run against test doubles.
import {
  requireCodeReview,
  waiveCodeReview,
} from "../lib/engine/code-review-requirement.mjs";
import { rebaseTraceHistory } from "../lib/engine/trace-rebase.mjs";
import {
  childProcess,
  console,
  crypto,
  Date,
  fs,
  os,
  process,
} from "../lib/runtime/host.mjs";
import { PLUGIN_ROOT } from "../lib/runtime/paths.mjs";
import { syncProjectForStatus } from "../lib/engine/status-sync.mjs";
import { assertPluginSatisfiesProject } from "../lib/engine/plugin-compatibility.mjs";
import { withReadSnapshot } from "../lib/engine/read-snapshot.mjs";
import { reconcileExternalMerge } from "../lib/engine/external-merge.mjs";
import { fileURLToPath } from "node:url";
import {
  formatSchemaErrors,
  validateAgainstSchema,
} from "../lib/json-schema-validator.mjs";
import {
  buildAssessmentProposal,
  buildAssessmentUserMessage,
  createAssessmentWorkflow,
  preflightAssessmentProposal,
  transitionAssessmentWorkflow,
  validateAssessmentWorkflowIntegrity,
  validateProposalIntegrity,
} from "../lib/assessment-workflow.mjs";
import {
  applyWorkflowOverlay,
  approveWorkflowDefinition,
  approveWorkflowOverlay,
  buildWorkflowDefinition,
  buildWorkflowOverlay,
  createWorkflowCheckpoint,
  createWorkflowInstance,
  createWorkflowTransition,
  evaluateWorkflowGuards,
  replayWorkflowEvents,
  validateWorkflowDefinition,
  validateWorkflowCheckpoint,
  validateWorkflowOverlay,
  workflowCanonicalEvidenceSchema,
} from "../lib/workflow-engine.mjs";
import {
  SOFTWARE_PROJECT_PHASES,
  buildWorkflowPreset,
  getWorkflowPreset,
  listWorkflowPresets,
} from "../lib/workflow-presets.mjs";
import {
  CANONICAL_WORKFLOW_GUARD_CHECKS,
  WORKFLOW_CANONICAL_EVIDENCE_SCHEMA,
  WORKFLOW_FINAL_GATE_RECEIPT_SCHEMA,
  WORKFLOW_LEGACY_CANONICAL_EVIDENCE_SCHEMA,
  WORKFLOW_LEGACY_FINAL_GATE_RECEIPT_SCHEMA,
  buildLegacyWorkflowCanonicalEvidence,
  buildWorkflowCanonicalEvidence,
  buildWorkflowFinalGateReceipt,
  buildWorkflowStrictGateReceipt,
  hasValidWorkflowReceiptHash,
  selectRequiredOutputRefsForPhase,
} from "../lib/workflow-canonical-evidence.mjs";
import {
  applyBudgetAmendment,
  buildBudgetAmendment,
  buildExecutionUsageReceipt,
  evaluateBudgetUsage,
  normalizeExecutionBudget,
  validateBudgetAmendmentIntegrity,
  validateExecutionBudgetIntegrity,
  validateExecutionUsageReceipt,
} from "../lib/execution-budget.mjs";
import {
  buildVerificationReceipt,
  validateVerificationReceiptIntegrity,
} from "../lib/verification-levels.mjs";
import {
  buildAuthorizationUsageReceipt as buildCanonicalAuthorizationUsageReceipt,
  buildHostApprovalReceipt,
  computeAuthorizationSubjectHash,
  createAuthorizationRevocation,
  createAuthorizationSnapshot,
  validateAuthorizationRevocationIntegrity,
  validateAuthorizationSnapshotAtUse,
  validateAuthorizationSnapshotIntegrity,
  validateAuthorizationUsageReceipt as validateCanonicalAuthorizationUsageReceipt,
  validateHostApprovalReceiptAtUse,
} from "../lib/authorization-receipts.mjs";
import {
  computeExactMeteringPolicyHash,
  validateMeteringAttestationForReceipt,
} from "../lib/metering-attestations.mjs";
import {
  calculateMeteringDelta,
  collectCodeBurnMeteringSnapshot,
  validateMeteringDeltaIntegrity,
  validateMeteringSnapshotIntegrity,
} from "../lib/codeburn-metering-adapter.mjs";
import {
  CODEX_SESSION_ADAPTER_ID,
  calculateCodexSessionMeteringDelta,
  collectCodexSessionMeteringSnapshot,
  mapCodexSessionUsage,
  validateCodexSessionMeteringDelta,
  validateCodexSessionMeteringSnapshot,
} from "../lib/codex-session-metering-adapter.mjs";
import {
  RTK_ADAPTER_ID,
  collectRtkOptimizationTelemetry,
  detectRtk,
  routeRtkCommand,
} from "../lib/rtk-optimization-adapter.mjs";
import {
  buildContextOptimizationObservation,
  buildContextOptimizationLineageDelta,
  optimizationBudgetAdvisory,
  validateContextOptimizationObservation,
  validateContextOptimizationLineage,
} from "../lib/context-optimization.mjs";
import { runObserveCommand } from "../lib/change-observatory/cli.mjs";
import {
  messageListen,
  messageRead,
  messageSend,
  messageSetup,
  messageStatus,
} from "../lib/messaging/commands.mjs";
import { createPortfolioRuntime } from "../lib/change-observatory/portfolio-runtime.mjs";
import {
  launchDedicatedObservatory,
  OBSERVATORY_WORKER_MARKER,
  shouldLaunchDedicatedObservatory,
} from "../lib/change-observatory/runtime.mjs";
import { ObservatoryPathError } from "../lib/change-observatory/path-safety.mjs";
import { createObservatoryConfiguration } from "../lib/change-observatory/configuration.mjs";
import { buildTraceNarrative } from "../lib/trace-narrative.mjs";
import {
  recoverTraceIntegrity,
  sealTraceEvent,
  withTraceIntegritySnapshot,
} from "../lib/trace-integrity.mjs";
import {
  createOperationContext,
  normalizeOperationalError,
} from "../lib/observability/context.mjs";
import {
  createLegacyEvidenceV1RedactionPolicy,
  createHistoricalOperationalEvidenceV1RedactionPolicy,
  createOperationalRedactionPolicy,
  createRedactionPolicyFromSource,
  describeRedactionPolicy,
  redactText,
  redactValue,
  redactValueWithMetadata,
} from "../lib/observability/redaction.mjs";
import {
  buildRequirementProposal,
  buildRequirementRef,
  buildRequirementRevision,
  buildRequirementSupersession,
  requirementContentHash,
  validateRequirementIntegrity,
} from "../lib/requirement-lifecycle.mjs";
import {
  EvidenceFormatError,
  inspectJpegEvidence,
  inspectPdfEvidence,
  inspectPngEvidence,
  inspectWebpEvidence,
  inspectZipContainer as inspectZipContainerStructure,
  readZipEntry as readZipEntryBytes,
} from "../lib/evidence-formats.mjs";
import {
  AUTONOMY_LEVELS,
  AUTONOMY_LEVEL_RANK,
  buildDeliveryExecutionProfile,
  buildDeliveryExecutionProfileV2,
  buildRequirementExecutionProfile,
  mostRestrictiveAutonomyLevel,
  evaluateAutonomyPolicy,
  normalizeAutonomyLevel,
  validateAutonomyDecisionIntegrity,
  validateDeliveryExecutionProfileIntegrity,
  validateRequirementExecutionProfileIntegrity,
} from "../lib/autonomy-policy.mjs";
import {
  providerBindingForAction,
} from "../lib/delivery/provider-compatibility.mjs";
import { buildPullRequestCommitLineage } from "../lib/delivery/pull-request-lineage.mjs";
import {
  DeliveryProviderError,
  assertProviderOperationReceiptIntegrity,
} from "../lib/delivery/provider-registry.mjs";
import {
  DEFAULT_DELIVERY_PROVIDER_SELECTION,
  createDefaultDeliveryProviderRegistry,
} from "../lib/delivery/default-providers.mjs";
import { deliveryProviderOperationSubjectsMatch } from "../lib/delivery/provider-subject-compatibility.mjs";
import {
  IdentityMigrationError,
  applyIdentityMigration,
  planIdentityMigration,
  prepareIdentityMigrationRecovery,
  publicIdentityMigrationPlan,
  recoverIdentityMigration,
  validateIdentityMigrationReceipt,
} from "../lib/identity-migration.mjs";
import { discoverBaselineSourcePaths } from "../lib/baseline-source-discovery.mjs";
import { inspectBuildIdentity } from "../lib/build-identity.mjs";
import { DomainValidationError, computeStableHash } from "../lib/canonical.mjs";
import {
  buildExecutionContextPreflightReceipt,
  executionContextSnapshotRevalidationDecision,
  executionContextSourceEvolutionDecision,
  validateExecutionContextPreflightReceipt,
  workspaceChangeMatchesPreflight,
} from "../lib/execution-context-preflight.mjs";
import { openCanonicalQuerySession } from "../lib/canonical-query-session.mjs";
import { archiveProject } from "../lib/engine/project-archive.mjs";
import { initializeCreatedLock } from "../lib/created-lock-file.mjs";
import {
  IDENTITY_STAT_OPTIONS,
  fileIdentity,
  sameFileIdentityValues,
  sameStatTime,
} from "../lib/file-identity.mjs";
import {
  ProjectPathSafetyError,
  assertNoSymlinkSegmentsWithinBoundary,
} from "../lib/project-path-safety.mjs";
import { SecretScanConfigurationError, scanFiles } from "../lib/secret-scan.mjs";
import {
  CODE_REVIEW_VERDICTS,
  evaluateMergeReviews,
  normalizeCodeReviewFindings,
  parseCommitAuthors,
  reviewerAuthorConflicts,
} from "../lib/code-review.mjs";
import {
  buildConfigMigrationApplyData,
  buildEffectiveConfigLock,
  prepareConfigMigration,
  resolveEffectiveConfig,
  verifyConfigMigrationPlan,
} from "../lib/effective-config.mjs";
import {
  actionCheckpointGuidance,
  deliveryAutonomyApprovalGuidance,
  deliveryAutonomyProposalGuidance,
  deliveryAutonomyStatusGuidance,
  findForbiddenHumanGuidanceTerms,
  gateGuidance,
  requirementAutonomyCeilingGuidance,
} from "../lib/human-guidance.mjs";
import { findCommand } from "../lib/cli/command-catalog.mjs";
import { renderHelp, UnknownCommandError } from "../lib/cli/help.mjs";
import { generateCompletion, SUPPORTED_SHELLS } from "../lib/cli/completion.mjs";
import {
  catalogOptionMetadata,
  commandMutationIntent,
  createCommandHandlerRegistry,
  resolveCommand,
} from "../lib/cli/dispatch.mjs";
import {
  MutationGovernanceError,
  appendJsonLineNoFollow,
  assertMutationExecutionAuthorized,
  consumeBootstrapMutationGrant,
  currentMutationGovernance,
  createBootstrapMutationGrant,
  createProjectMutationGovernance,
  runWithMutationGovernance,
  withGovernedMutation,
  withGovernedMutationBatch,
} from "../lib/governance/mutation-guard.mjs";
import {
  CliPresetError,
  exportCliPresets,
  listCliPresets,
  resolveCliPresets,
  showCliPreset,
} from "../lib/cli/presets.mjs";
import {
  NODE_ENGINE_RANGE,
  NODE_RUNTIME_REQUIREMENT,
  isSupportedNodeRuntime,
  unsupportedNodeRuntimeMessage,
} from "../lib/runtime-support.mjs";
import {
  UserError,
  fail,
  failUsage,
} from "../lib/cli/user-error.mjs";
import {
  approvalAuthorizationSettings,
  approvalIssueSeverity,
  approvalRequestPrimaryCopy,
  approvalSubjectMatchesActiveScope,
  assertBaselineProposalCanResume,
  assessmentApprovalPath,
  assessmentApprovalSubject,
  assessmentApprovalsRoot,
  assessmentProposalPath,
  assessmentProposalsRoot,
  authorityAssuranceLabel,
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
  budgetAmendmentApprovalSubject,
  buildApprovalRecordScope,
  buildBaselineProposalTraceEvent,
  buildLegacyAuthorizationUses,
  buildProposalContextOptimizationDelta,
  canRecoverConsumedLegacyAuthorizationUse,
  canonicalAuthorizationUseSubject,
  capabilityRecommendationNeedsInstallApproval,
  contractDirectApprovalRequirements,
  contractProposalHumanGuidance,
  dependencyProposalPath,
  executeIdentityMutation,
  executePreparedIdentityMutation,
  failBaselineProposalResume,
  formalApprovalActorDescription,
  getApprovalPolicy,
  hasApprovedContractApproval,
  hasFormalApprovalAttribution,
  hasFreshApprovedContractApproval,
  hashApprovalSubject,
  hashAuthorizationRecord,
  humanApprovalFields,
  isCanonicalContentAuthorization,
  latestApprovedRecordApproval,
  latestContractApproval,
  legacyAuthorizationBindingErrors,
  localTargetBuildReceiptRef,
  normalizeApprovalCollectionScope,
  normalizeApprovalSource,
  normalizeApprovalStatus,
  outputLinkAuthorizationId,
  parseLegacyAuthorizationUses,
  parsePullRequestUrlIdentity,
  preparedIdentityWritePath,
  profileTaskStartReceiptSchemaName,
  projectBootstrapInitialIdentityHash,
  remoteAuthorizationProjection,
  requireFormalApprovalActor,
  sameLegacyAuthorizationProjection,
  sameStableFileIdentity,
  storyActionAuthorizationSettings,
  validateApprovalPolicy,
  validateApprovalSourceForActor,
  validateAuthorizationUseReceipt,
  verificationReceiptPath,
  verificationReceiptSatisfies,
} from "../lib/lifecycle/authorization.mjs";
import {
  buildCapabilityPolicy,
  buildDefaultCapabilityPolicyPatch,
  buildDefaultCapabilityRecommendations,
  capabilityDiscoveryRoot,
  capabilityProfilePath,
  capabilityProfilesRoot,
  capabilityRecommendationPath,
  capabilityRecommendationsRoot,
  capabilityRecordMatchesStory,
  capabilityTargetFilesystemPath,
  capabilityTargetValueIsConcrete,
  collectCapabilityPolicyReadinessGaps,
  collectMissingRequiredCapabilityBindings,
  formatCapabilityBindingsForUser,
  formatCapabilityEvidenceForUser,
  formatCapabilityInstallNeeds,
  formatCapabilityPolicyPatchForUser,
  formatCapabilityRecommendationsForUser,
  formatCapabilitySubject,
  mergeCapabilityPolicies,
  normalizeCapabilityBinding,
  normalizeCapabilityBindings,
  normalizeCapabilityEvidence,
  normalizeCapabilityOpenQuestions,
  normalizeCapabilityRecommendationRefs,
  normalizeCapabilityRecommendations,
  normalizeCapabilitySubject,
  validateCapabilityPolicy,
  visitCapabilityTargetValues,
} from "../lib/lifecycle/capability.mjs";
import {
  UnsupportedNodeRuntimeError,
} from "../lib/lifecycle/classes.mjs";
import {
  activeLegacyLocalStartError,
  approvedRecordIssueSeverity,
  arraysEqual,
  assertNotDerivedArtifact,
  boundedNonNegativeIntegerOption,
  boundedPositiveInteger,
  buildDomainRecord,
  buildExecutionPolicy,
  buildInferredContext,
  buildLegacyDefaultsProfile,
  buildQuestionRecords,
  canonicalAbsoluteUrl,
  cliErrorRedactionResolution,
  withheldDetailsMessage,
  cliHandler,
  compactIndexEntry,
  compactText,
  compareReportQueryRecords,
  completionReserveRisks,
  countBy,
  deriveTestRunOutcome,
  exitCodeForError,
  getOptionString,
  getRoutingPolicy,
  hasActorAttribution,
  hashBoundRecordIsValid,
  hashBuffer,
  hashJsonFileValue,
  inferTitle,
  inspectZipContainer,
  instanceDefinitionReference,
  instanceOverlayReference,
  internalErrorCauseDetails,
  isApprovedRecordFresh,
  isEventInsideWindow,
  localTargetBuildCompletionDetails,
  localTargetBuildPreconditionDetails,
  localTargetPredecessorStateMatches,
  mappedCodeBurnUsage,
  matchesAny,
  mergeList,
  mutationGovernanceActor,
  normalizeActivityReportView,
  normalizeActorType,
  normalizeArtifactType,
  normalizeAuthorizedActions,
  normalizeConfidence,
  normalizeExecutionPolicySuggestions,
  normalizeId,
  normalizeListOption,
  normalizeListValue,
  normalizeObject,
  normalizeOptionalDateTime,
  normalizeRawListOption,
  normalizeRecordedCommandArgv,
  normalizeReportQuery,
  normalizeScalarOption,
  normalizeStringArray,
  normalizeText,
  normalizeWorkItemType,
  overlaps,
  parseBooleanOption,
  processIsAlive,
  pushAllUnique,
  rawBooleanOptionRequested,
  rawStringOptionValue,
  readZipEntry,
  referenceId,
  referenceVersion,
  reportQueryFiltersMatch,
  reportQuerySubjectMatches,
  requireCoordinationOverrideActor,
  requireEnumOption,
  requireOption,
  sameStableFileSnapshot,
  scoreEntry,
  secretScanPolicy,
  shortHash,
  shortHashFull,
  shouldIndexFile,
  slugify,
  stableJson,
  summarizeActivityEvents,
  tokenize,
  upsertById,
  validateBranchPolicy,
  validateCommitCoverageProfileRef,
  validateExecutionPolicy,
  validateRoutingPolicy,
  validateSdlcDirectoryList,
  verifyOoxmlSemanticContent,
} from "../lib/lifecycle/common.mjs";
import {
  APPROVAL_SOURCES,
  CACHE_FILE_NAME,
  CATALOG_KNOWN_OPTIONS,
  CATALOG_OPTION_METADATA,
  CLAIM_STATUSES,
  DEFAULT_CODEX_SESSION_METERING_CONFIG,
  DELIVERY_PROVIDER_ACTIONS,
  DELIVERY_TERMINAL_STATUSES,
  EXIT_CODES,
  GOVERNED_LOCAL_TARGET_ACTIONS,
  HANDOFF_STATUSES,
  INTERNAL_LOCK_REMOTE_STALE_MS,
  INTERNAL_LOCK_STALE_MS,
  INTERNAL_LOCK_WAIT_MS,
  LEGACY_STORY_STEP_PHASE_ALIASES,
  LOCK_STATUSES,
  MAX_CLI_ERROR_CONFIG_BYTES,
  MAX_TEMPLATE_ASSET_BYTES,
  OPERATIONAL_REDACTION_POLICY,
  OUTPUT_DELIVERY_MODES,
  OUTPUT_FORMATS,
  OUTPUT_FORMAT_ALIASES,
  OUTPUT_LINK_MODES,
  OUTPUT_VISUAL_FORMATS,
  PHASE_IDENTIFIER_PATTERN,
  PROJECT_BOOTSTRAP_JOURNAL_FILE_NAME,
  PROJECT_BOOTSTRAP_JOURNAL_SCHEMA_VERSION,
  PROJECT_BOOTSTRAP_MANIFEST_FILE_NAME,
  PROJECT_BOOTSTRAP_MANIFEST_INTRODUCED_VERSION,
  PROJECT_BOOTSTRAP_MANIFEST_SCHEMA_VERSION,
  PROJECT_CONFIG_FILE_NAME,
  PROJECT_CONFIG_LOCK_FILE_NAME,
  ROUTE_REQUIRED_INTENT_FIELDS,
  SDLC_DIR,
  SECRET_SCAN_MAX_FILE_BYTES,
  STORY_STATUSES,
  TERMINAL_STORY_STATUSES,
  TRACE_EVIDENCE_POLICY_BINDING_SCHEMA,
  TRACE_EVIDENCE_POLICY_REF_SCHEMA,
  TRACE_EVIDENCE_POLICY_SOURCE_ROOT,
  TRACE_TYPES,
  WORKFLOW_FINAL_FRESHNESS_PROOF_SCHEMA,
  WORKFLOW_FINAL_GIT_OBSERVATION_SCHEMA,
  WORKFLOW_FINAL_GIT_SCOPE_MAX_COMMITS,
  WORKFLOW_FINAL_GIT_SCOPE_MAX_COMMIT_PATHS,
  WORKFLOW_FINAL_GIT_SCOPE_MAX_PATHS,
  WORKFLOW_FINAL_GIT_SCOPE_SCHEMA,
  WORKFLOW_HUMAN_VALUE_LIMITS,
  WORKFLOW_WINDOWS_DIRECTORY_SYNC_UNSUPPORTED,
  WORK_ITEM_CREATE_TYPES,
  workflowStartTraceIndexCache,
  workflowStartTransactionIndexCache,
} from "../lib/lifecycle/constants.mjs";
import {
  assertDeliveryProviderAuthorization,
  buildDeliveryActionCompletionTraceEvent,
  buildDeliveryCheckpointPolicySource,
  buildDeliveryCompletionRequest,
  buildReleaseGateReceipt,
  buildTerminalDeliveryCloseTraceEvent,
  compareDeliveryAuthorizationOrder,
  contractDeliveryDescriptor,
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
  deliveryBoundaryCheckpointActions,
  deliveryBudgetBoundary,
  deliveryCheckpointPolicySourcesRoot,
  deliveryCloseReceiptPath,
  deliveryEnvironmentBoundary,
  deliveryExecutionProfileSchemaName,
  deliveryExecutionRoot,
  deliveryMaterialScope,
  deliveryProviderBindingsFromOptions,
  deliveryProviderOperationSubject,
  deliveryStartReceiptPath,
  deliveryStartReceiptRef,
  deliveryTargetAllowedActions,
  exactGitProjectPath,
  formatDeliveryFormatOption,
  formatOutputDeliveryForHuman,
  gitRuntimeWithoutBaseSha,
  gitRuntimeWithoutHead,
  governedLocalSmokeCwd,
  localDeliveryRuntimeBoundaryChanged,
  localReleaseArtifactManifestPolicy,
  localReleaseAttemptId,
  localReleaseAttemptReceiptErrors,
  localReleaseBoundaryCheckpointFromSource,
  localReleaseTargetEntryPaths,
  localReleaseTargetHadAbsentEntries,
  localReleaseTargetHadOnlyDirectories,
  localSmokeExecutableBase,
  localSmokeInterpreterOptionValueKind,
  normalizeDeliveryAction,
  normalizeGitEvent,
  normalizeGitRepositoryIdentity,
  normalizeSmokeTestCommand,
  recommendedDeliveryFormatForContract,
  releaseGateReceiptPath,
  releaseManifestPath,
  releasePhaseName,
  resolveDeliveryProviderBinding,
  terminalStatusForDeliveryAction,
  validateArtifactDeliveryPath,
  validateDeliveryCheckpointPolicySource,
  validateDeliveryCompletionRequest,
  validateLocalSmokePackageManagerForm,
  validateResolvedLocalSmokeExecutable,
  withProviderCompatibilityProjection,
} from "../lib/lifecycle/delivery.mjs";
import {
  assistantMessagePresentationFields,
  attachAssistantMessagePresentation,
  buildCompactCacheStatus,
  executionContextRecoveryMessage,
  humanGuidanceLines,
  humanGuidanceLocale,
  labelForCommit,
  normalizeClaimStatus,
  normalizeHandoffCloseStatus,
  normalizeHandoffStatus,
  normalizeLockStatus,
  normalizeStoryStatus,
  safePrimaryGuidanceText,
  storyCreationGuidance,
  terminalStoryStatuses,
  userErrorHumanGuidance,
  userFriendlyTaskQuestion,
} from "../lib/lifecycle/guidance.mjs";
import {
  assertTraceEvidencePolicySourceSafety,
  autonomyVerificationTechnicalLines,
  buildHistoricalOperationalEvidenceV1RedactionPolicy,
  buildLegacyEvidenceV1RedactionPolicy,
  buildOutputLinkDecisionSubject,
  buildTemplateResolution,
  canonicalOutputFormatOptions,
  collectOutputArtifactTypes,
  collectStoryOutputLinksForStep,
  createOutputRegistryQueryIndex,
  effectiveOutputDecisions,
  evidenceRepresentationMatchesRef,
  findOutputTemplate,
  findRelatedOutputLinks,
  formatActivityEventForView,
  formatBaselineCurrentStateSummary,
  formatBaselineDetectedStack,
  formatBaselineImportedDocuments,
  formatBaselineKeyFiles,
  formatConfigMigrationChange,
  formatDetectedStackForUser,
  formatExplainedOpenQuestion,
  formatLimitedList,
  formatReportQueryRecord,
  formatRouteDecision,
  formatTaskStartDecision,
  hasApprovedOutputDecision,
  isHumanGuidanceOutput,
  legacyOutputGuidance,
  mutationGovernanceEvidencePaths,
  outputLinkHasMatchingApprovedDecision,
  outputRegistryPairKey,
  outputRenderEvidenceOptions,
  outputResolutionFingerprint,
  outputResolutionGuidance,
  outputResolutionKey,
  relatedOutputLinksFromIndex,
  renderActivityReportMarkdown,
  renderBaselineReport,
  renderGateReportMarkdown,
  renderReportQueryMarkdown,
  renderTemplate,
  safeEvidenceExcerpt,
  shouldVerifyTraceEvidence,
  traceEvidencePolicyBindingKey,
  traceEvidenceRefHash,
  verificationArtifactFormat,
  verificationArtifactSha256,
  verificationDimensionStatus,
} from "../lib/lifecycle/output.mjs";
import {
  assertNoSymlinkPathSegments,
  assertPathInsideRoot,
  assessmentAmendmentsRoot,
  assessmentApplicationPath,
  assessmentApplicationsRoot,
  assessmentAuthorizedUseDefinitions,
  assessmentBudgetMutationLockPath,
  assessmentBudgetSnapshotPath,
  assessmentBudgetsRoot,
  assessmentUsageRoot,
  autonomyActionsRoot,
  autonomyDecisionSemanticProjection,
  autonomyDecisionsRoot,
  autonomyExecutionsRoot,
  autonomyRevocationSubject,
  autonomyRevocationsRoot,
  budgetMeterRoot,
  buildContextOptimizationMetadata,
  codeReviewsRoot,
  collectBudgetMeterSnapshot,
  collectCodeBurnBudgetMeterSnapshot,
  collectCodexSessionBudgetMeterSnapshot,
  completionRequestExecutionProjection,
  configMigrationBootstrapMutations,
  configMigrationChangeSummary,
  configMigrationPlanPresentation,
  configuredRtkOptions,
  contextOptimizationObservationsRoot,
  contextOptimizationRuntimeOptions,
  dependenciesRoot,
  exactMeteringMetrics,
  exactMeteringPolicyTrustErrors,
  executionContextPreflightPath,
  failIncompleteExistingBootstrap,
  isDerivedArtifactPath,
  isInsidePath,
  logicalArchiveRoot,
  mergeMissingConfigDefaults,
  normalizeProjectPathInput,
  normalizeRequestedAutonomyMode,
  openProjectQuerySession,
  operationsRoot,
  pathMatchesApprovedWriteScope,
  projectBootstrapDirectoryAncestorClosure,
  projectBootstrapJournalPath,
  projectBootstrapJournalReference,
  projectBootstrapRecoveryResult,
  projectVersionRequiresBootstrapManifest,
  readContextOptimizationPolicy,
  recordedPathInside,
  resolveBudgetMeterMapping,
  secretScansRoot,
  testRunsRoot,
  toProjectPath,
  validateAutonomyPolicy,
  workItemPath,
  workItemsRoot,
} from "../lib/lifecycle/project.mjs";
import {
  addRouteCheck,
  applyRouteConfidenceGate,
  canonicalIntentCommand,
  canonicalIntentQuestion,
  decideInitProjectRoute,
  decideIntakeRequirementRoute,
  dedupeRouteDecision,
  emptyRouteIntent,
  finalizeAskRoute,
  finalizeConcreteRoute,
  inferTaskPhase,
  isAssessmentRouteIntent,
  normalizeIntentArray,
  normalizeIntentArtifactType,
  normalizeRoutePhase,
  normalizeRouteToken,
  nullableRoutePhase,
  routeActionConfig,
  routeEntityId,
  routeQuestionFromContext,
  routeStoryId,
  taskRouteRequiresContract,
  taskStartAutonomyCopy,
} from "../lib/lifecycle/route.mjs";
import {
  assertManualTraceActionIsSafe,
  assertStoryCommandOptions,
  baselinePathById,
  baselineRoot,
  breakdownPathById,
  budgetMeterBaselinePath,
  buildBudgetMeterBaseline,
  buildStoryDependencyGraph,
  buildStoryRequirementGraph,
  buildTraceRedactionPolicy,
  buildTraceRequestMetadata,
  configuredPhaseOrder,
  configuredStorySteps,
  contractArtifactTypes,
  contractExecutionContext,
  contractNegotiationCommands,
  defaultClaimExpiration,
  defaultNextStoryStep,
  defaultStoryBranch,
  dependencyGraphPath,
  effectiveClaimExpiration,
  failTraceIntegrityWrite,
  findBlockingDependencyCycles,
  hasTraceActor,
  inferStoryArtifactType,
  inferStoryIdFromTraceFile,
  isHardDependencyEdge,
  isIntactBootstrapPhaseContract,
  latestTraceEvent,
  newestContract,
  normalizeStoryRecord,
  normalizeStoryStep,
  normalizeTraceOutcome,
  parseBreakdownItemRef,
  parseDependencyEdge,
  phaseRank,
  rejectLegacyRequirementWriteScope,
  requirementAutonomyPath,
  requirementAutonomyRoot,
  requirementLifecycleRoot,
  requirementMaterialScope,
  requirementPath,
  requirementsRoot,
  resolveIncidentFeedbackPhase,
  storyAcceptanceCriteria,
  storyActionCheckpointSubjectId,
  storyBranchPatterns,
  storyLifecycleCertificationLockPath,
  storyMutationLockPath,
  storyRecordLifecycleProjection,
  storyStepPhase,
  traceActorKey,
  traceActorMatches,
  traceIntegrityCheckpointPath,
  upsertDependencyEdge,
  validateBudgetMeterBaseline,
  validateClaimPolicy,
  validateStoryLifecyclePolicy,
  validateWorkBreakdownPolicy,
  workBreakdownRoot,
} from "../lib/lifecycle/story.mjs";
import {
  assertStoryBoundWorkflowPhaseOrder,
  assessmentWorkflowPath,
  assessmentWorkflowsRoot,
  blockedWorkflowLifecycleProjection,
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
  rewindInterruptedCompletedWorkflow,
  sealWorkflowFinalFreshnessGitScope,
  validateWorkflowDefinitionRecord,
  validateWorkflowOverlayRecord,
  workflowApprovalForDomain,
  workflowCheckpointPath,
  workflowCurrentPhaseEntryAt,
  workflowCurrentState,
  workflowDefinitionPath,
  workflowDefinitionRef,
  workflowDefinitionSummary,
  workflowDefinitionUsesCanonicalEvidence,
  workflowDefinitionsRoot,
  workflowEventsPath,
  workflowExecutionStartedAt,
  workflowFinalFreshnessRecordContains,
  workflowFinalFreshnessReferencedPaths,
  workflowFinalGateReceiptPath,
  workflowFinalGitArguments,
  workflowFinalGitLayerIdentityEqual,
  workflowFinalGitObjectIdentity,
  workflowFinalMissingGitIdentity,
  workflowFinalWorkingTreeIdentity,
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
  workflowIntegrityBlockedGuidance,
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
} from "../lib/lifecycle/workflow.mjs";
import {
  amendAssessmentBudget,
  applyAssessmentProposal,
  approveAssessmentProposal,
  cancelAssessmentProposal,
  captureOptimizationFromCommand,
  completeAssessmentProposal,
  prepareAssessmentProposal,
  showAssessmentProposalStatus,
  showOptimizationStatus,
} from "../lib/engine/assessment.mjs";
import {
  budgetMeterRecordCommand,
  budgetMeterStartCommand,
  budgetStatusCommand,
  budgetUsageRecordCommand,
} from "../lib/engine/delivery-metering.mjs";
import {
  grantAuthorization,
  revokeAuthorization,
  showApprovalRequests,
  showAuthorizations,
} from "../lib/engine/authorization.mjs";
import {
  approveCapabilityProfile,
  approveCapabilityRecommendation,
  proposeCapabilityProfile,
  proposeCapabilityRecommendation,
  showCapabilityInventory,
  showCapabilityStatus,
} from "../lib/engine/capability.mjs";
import {
  applyCliPresetOptions,
  assertProjectRootDirectory,
  buildCliErrorPayload,
  buildContext,
  clearCache,
  createWorkItem,
  handleCliPresetCommand,
  parseArgs,
  rebuildCache,
  rebuildIndex,
  rebuildManifests,
  recordCodeReview,
  recordFeedback,
  recordIncident,
  recordSyncEvent,
  recordTestRun,
  reportActivity,
  reportQuery,
  resolveCliErrorRedactionPolicy,
  runDoctor,
  runOptimizedCommand,
  runSecretScan,
  searchKnowledgeBase,
  showOrchestrationPlan,
} from "../lib/engine/common.mjs";
import {
  CLI_OPERATION_CONTEXT,
  VERSION,
} from "../lib/engine/definitions.mjs";
import {
  approveDeliveryAutonomy,
  closeDeliveryAutonomy,
  evaluateDeliveryAction,
  explainDeliveryAutonomy,
  proposeDeliveryAutonomy,
  releaseStoryClaim,
  revokeDeliveryAutonomy,
  showDeliveryAutonomy,
} from "../lib/engine/delivery.mjs";
import {
  showDeliveryChecks,
} from "../lib/engine/delivery-checks.mjs";
import {
  reserveStory,
  showStoryAvailability,
} from "../lib/engine/story-reservation.mjs";
import {
  parkStory,
  resumeStory,
} from "../lib/engine/story-parking.mjs";
import {
  storyWait,
} from "../lib/engine/story-waits.mjs";
import {
  publishStoryRecords,
} from "../lib/engine/story-records-publish.mjs";
import {
  showBaselineStatus,
  showBreakdownStatus,
  showCacheStatus,
  showConfigStatus,
  showDependencyStatus,
  showOrchestrationStatus,
  showStatus,
} from "../lib/engine/guidance.mjs";
import {
  approveWorkflowDefinitionCommand,
  archiveClosedArtifacts,
  initProject,
  listWorkflowDefinitionsCommand,
  migrateActiveReleaseScope,
  migrateIdentity,
  migrateProjectConfig,
  onboardExistingProject,
  proposeWorkflowDefinition,
  showWorkflowDefinition,
} from "../lib/engine/migration.mjs";
import {
  runPortfolioStatusFromCli,
} from "../lib/engine/observatory.mjs";
import {
  approveOutputTemplate,
  bindHistoricalTraceEvidencePolicy,
  linkOutputArtifact,
  output,
  proposeOutputTemplate,
  resolveOutput,
  showOutputStatus,
} from "../lib/engine/output.mjs";
import {
  assertConfigAllowsCommand,
  pathEntryExistsNoFollow,
} from "../lib/engine/project.mjs";
import {
  decideRoute,
  preflightTask,
  startTask,
} from "../lib/engine/route.mjs";
import {
  dispatchWithMutationGovernance,
  lockPhase,
  releasePhaseLock,
} from "../lib/engine/storage.mjs";
import {
  approveStandingApproval,
  explainStandingApproval,
  proposeStandingApproval,
  revokeStandingApproval,
  showStandingApprovals,
  syncStandingApproval,
} from "../lib/engine/standing.mjs";
import {
  fetchCodeReviews,
  publishCodeReviews,
} from "../lib/engine/review-shared.mjs";
import {
  refreshBaseline,
  withdrawBaselineRefresh,
} from "../lib/engine/baseline-refresh.mjs";
import {
  confirmStoryOverlap,
  showStoryOverlap,
} from "../lib/engine/story-overlap.mjs";
import {
  acknowledgeStoryBaseCommit,
} from "../lib/engine/base-acknowledgements.mjs";
import {
  addStoryAcceptance,
  appendTrace,
  approveBaseline,
  approveBreakdown,
  approveContract,
  approveDependencyGraph,
  approveRequirement,
  cancelStories,
  claimStory,
  closeHandoff,
  compactTraces,
  explainHistoryReadLimitError,
  verifyTraceHistory,
  completeStoryStep,
  createContract,
  createStory,
  createStoryHandoff,
  gateCheck,
  prepareStoryHandoff,
  proposeBaseline,
  proposeBreakdown,
  proposeDependencyGraph,
  proposeRequirement,
  reviseDependencyGraph,
  reviseRequirement,
  setBreakdownPolicy,
  showBreakdownPolicy,
  showRequirementAutonomy,
  showRequirements,
  showStoryDependencies,
  supersedeRequirement,
  supersedeStories,
} from "../lib/engine/story.mjs";
import {
  approveWorkflowOverlayCommand,
  explainWorkflowOverlay,
  proposeWorkflowOverlay,
  showWorkflowInstance,
  startWorkflowInstance,
  transitionWorkflowInstance,
} from "../lib/engine/workflow.mjs";

function buildCliRuntimeHandlerRegistry() {
  const bootstrap = (handle) => cliHandler("bootstrap", handle);
  const preConfig = (handle) => cliHandler("pre-config", handle);
  const project = (handle) => cliHandler("project", handle);
  const call = (handler) => project(({ context, options }) => handler(context, options));
  // Read-only reports answer repeated Git questions once per run.
  const report = (handler) => project(({ context, options }) =>
    withReadSnapshot(() => handler(context, options), {
      fastChecks: String(process.env.AGENTIC_SDLC_STATUS_CHECKS || "fast").trim().toLowerCase() !== "full",
    }));

  return createCommandHandlerRegistry({
    help: bootstrap(({ options, resolution }) => {
      console.log(renderHelp(resolution.args, {
        locale: humanGuidanceLocale(options),
        json: options.json === true,
        version: VERSION,
      }));
    }),
    completion: bootstrap(({ options, resolution }) => {
      const [shell, ...extra] = resolution.args;
      if (!shell || extra.length > 0 || !SUPPORTED_SHELLS.includes(String(shell).toLowerCase())) {
        failUsage(`Completion needs exactly one shell: ${SUPPORTED_SHELLS.join(", ")}.`);
      }
      console.log(generateCompletion(shell, { json: options.json === true }));
    }),
    "preset.list": bootstrap(({ parsed, resolution }) => handleCliPresetCommand("list", resolution.args, parsed)),
    "preset.show": bootstrap(({ parsed, resolution }) => handleCliPresetCommand("show", resolution.args, parsed)),
    "preset.export": bootstrap(({ parsed, resolution }) => handleCliPresetCommand("export", resolution.args, parsed)),
    observe: bootstrap(runObserveFromCli),
    // Messages need only the project folder: they read no governed records.
    "message.status": bootstrap(({ options }) => messageStatus(options)),
    "message.setup": bootstrap(({ options }) => messageSetup(options)),
    "message.send": bootstrap(({ options }) => messageSend(options)),
    "message.read": bootstrap(({ options }) => messageRead(options)),
    "message.listen": bootstrap(({ options }) => messageListen(options)),
    "portfolio.status": bootstrap(runPortfolioStatusFromCli),
    "config.status": preConfig(({ context, options }) => showConfigStatus(context, options)),
    "config.migrate": preConfig(({ context, options }) => migrateProjectConfig(context, options)),
    init: preConfig(({ context, options }) => initProject(context, options)),
    "project.archive": preConfig(({ context, options }) => archiveProject(context, options)),
    doctor: preConfig(({ context, options }) => runDoctor(context, options)),
    "optimization.status": call(showOptimizationStatus),
    "optimization.capture": call(captureOptimizationFromCommand),
    "optimization.run": call(runOptimizedCommand),
    "onboard.existing-project": call(onboardExistingProject),
    "baseline.propose": call(proposeBaseline),
    "baseline.approve": call(approveBaseline),
    "baseline.refresh": call(refreshBaseline),
    "baseline.refresh.withdraw": call(withdrawBaselineRefresh),
    "baseline.status": call(showBaselineStatus),
    "assessment.proposal.prepare": call(prepareAssessmentProposal),
    "assessment.proposal.approve": call(approveAssessmentProposal),
    "assessment.proposal.apply": call(applyAssessmentProposal),
    "assessment.proposal.complete": call(completeAssessmentProposal),
    "assessment.proposal.cancel": call(cancelAssessmentProposal),
    "assessment.proposal.status": call(showAssessmentProposalStatus),
    "workflow.definition.list": call(listWorkflowDefinitionsCommand),
    "workflow.definition.show": call(showWorkflowDefinition),
    "workflow.definition.propose": call(proposeWorkflowDefinition),
    "workflow.definition.approve": call(approveWorkflowDefinitionCommand),
    "workflow.overlay.propose": call(proposeWorkflowOverlay),
    "workflow.overlay.approve": call(approveWorkflowOverlayCommand),
    "workflow.overlay.explain": call(explainWorkflowOverlay),
    "workflow.instance.start": call(startWorkflowInstance),
    "workflow.instance.transition": call(transitionWorkflowInstance),
    "workflow.instance.status": project(({ context, options }) => showWorkflowInstance(context, options, { explain: false })),
    "workflow.instance.explain": project(({ context, options }) => showWorkflowInstance(context, options, { explain: true })),
    "budget.usage.record": call(budgetUsageRecordCommand),
    "budget.meter.start": call(budgetMeterStartCommand),
    "budget.meter.record": call(budgetMeterRecordCommand),
    "budget.amend": call(amendAssessmentBudget),
    "budget.status": call(budgetStatusCommand),
    "requirement.propose": project(({ context, options, resolution }) => proposeRequirement(context, options, {
      legacyAlias: resolution.matched_path.join(" ") === "requirement create",
    })),
    "requirement.approve": call(approveRequirement),
    "requirement.revise": call(reviseRequirement),
    "requirement.supersede": call(supersedeRequirement),
    "requirement.status": call(showRequirements),
    "autonomy.requirement.status": call(showRequirementAutonomy),
    "autonomy.delivery.propose": call(proposeDeliveryAutonomy),
    "autonomy.delivery.approve": call(approveDeliveryAutonomy),
    "autonomy.delivery.revoke": call(revokeDeliveryAutonomy),
    "autonomy.delivery.action": call(evaluateDeliveryAction),
    "autonomy.delivery.close": call(closeDeliveryAutonomy),
    "autonomy.delivery.reconcile": call(reconcileExternalMerge),
    "autonomy.delivery.status": call(showDeliveryAutonomy),
    "autonomy.delivery.explain": call(explainDeliveryAutonomy),
    "autonomy.delivery.checks": call(showDeliveryChecks),
    "autonomy.standing.propose": call(proposeStandingApproval),
    "autonomy.standing.approve": call(approveStandingApproval),
    "autonomy.standing.revoke": call(revokeStandingApproval),
    "autonomy.standing.status": call(showStandingApprovals),
    "autonomy.standing.explain": call(explainStandingApproval),
    "autonomy.standing.sync": call(syncStandingApproval),
    "contract.create": call(createContract),
    "contract.approve": call(approveContract),
    "story.create": call(createStory),
    "story.acceptance.add": call(addStoryAcceptance),
    "story.claim": call(claimStory),
    "story.release": call(releaseStoryClaim),
    "story.reserve": call(reserveStory),
    "story.availability": call(showStoryAvailability),
    "story.park": call(parkStory),
    "story.resume": call(resumeStory),
    "story.wait": call(storyWait),
    "story.publish-records": call(publishStoryRecords),
    "story.overlap": report(showStoryOverlap),
    "story.overlap.confirm": call(confirmStoryOverlap),
    "story.base.acknowledge": call(acknowledgeStoryBaseCommit),
    "story.complete-step": call(completeStoryStep),
    "story.prepare-handoff": call(prepareStoryHandoff),
    "story.handoff.close": call(closeHandoff),
    "story.handoff": call(createStoryHandoff),
    "story.deps": report(showStoryDependencies),
    "story.supersede": call(supersedeStories),
    "story.cancel": call(cancelStories),
    "work.item.create": call(createWorkItem),
    "breakdown.policy.show": call(showBreakdownPolicy),
    "breakdown.policy.set": call(setBreakdownPolicy),
    "breakdown.propose": call(proposeBreakdown),
    "breakdown.approve": call(approveBreakdown),
    "breakdown.status": call(showBreakdownStatus),
    "dependency.propose": call(proposeDependencyGraph),
    "dependency.approve": call(approveDependencyGraph),
    "dependency.revise": call(reviseDependencyGraph),
    "dependency.status": report(showDependencyStatus),
    "capability.profile.propose": call(proposeCapabilityProfile),
    "capability.profile.approve": call(approveCapabilityProfile),
    "capability.profile.status": call(showCapabilityStatus),
    "capability.recommend": call(proposeCapabilityRecommendation),
    "capability.approve": call(approveCapabilityRecommendation),
    "capability.status": call(showCapabilityStatus),
    "capability.inventory": call(showCapabilityInventory),
    "approval.requests": call(showApprovalRequests),
    "authorization.grant": call(grantAuthorization),
    "authorization.status": call(showAuthorizations),
    "authorization.revoke": call(revokeAuthorization),
    "task.preflight": call(preflightTask),
    "task.start": call(startTask),
    "handoff.close": call(closeHandoff),
    "phase.lock": call(lockPhase),
    "phase.release": call(releasePhaseLock),
    "trace.append": call(appendTrace),
    "trace.evidence.bind": call(bindHistoricalTraceEvidencePolicy),
    "trace.compact": call(compactTraces),
    "trace.verify": call(verifyTraceHistory),
    "trace.rebase": call(rebaseTraceHistory),
    "sync.record": call(recordSyncEvent),
    "test.record": call(recordTestRun),
    "incident.record": call(recordIncident),
    "feedback.record": call(recordFeedback),
    "secret.scan": call(runSecretScan),
    "review.record": call(recordCodeReview),
    "review.require": call(requireCodeReview),
    "review.waive": call(waiveCodeReview),
    "review.publish": call(publishCodeReviews),
    "review.fetch": call(fetchCodeReviews),
    "output.template.propose": call(proposeOutputTemplate),
    "output.template.approve": call(approveOutputTemplate),
    "output.resolve": call(resolveOutput),
    "output.link": call(linkOutputArtifact),
    "output.status": call(showOutputStatus),
    "cache.rebuild": call(rebuildCache),
    "cache.status": call(showCacheStatus),
    "cache.clear": call(clearCache),
    "manifest.rebuild": call(rebuildManifests),
    "archive.closed": call(archiveClosedArtifacts),
    "migration.active": call(migrateActiveReleaseScope),
    "migration.identity": call(migrateIdentity),
    "report.activity": call(reportActivity),
    "report.query": call(reportQuery),
    "index.rebuild": call(rebuildIndex),
    "kb.search": project(({ context, options, resolution }) => searchKnowledgeBase(context, options, resolution.args)),
    // A gate answers repeated Git questions once per run; the lifecycle-complete
    // gate writes and re-checks the final receipt, so it keeps reading live.
    "gate.check": project(({ context, options }) => (options["lifecycle-complete"] === true
      ? gateCheck(context, options)
      : withReadSnapshot(() => gateCheck(context, options)))),
    "orchestrate.status": report(showOrchestrationStatus),
    "orchestrate.plan": report(showOrchestrationPlan),
    "route.decide": call(decideRoute),
    status: report(showStatus),
  });
}

async function runObserveFromCli({ options, rawArgs }) {
  try {
    if (shouldLaunchDedicatedObservatory()) {
      const termination = await launchDedicatedObservatory({
        argv: rawArgs,
        scriptPath: fileURLToPath(import.meta.url),
      });
      process.exitCode = termination.exitCode;
      return;
    }
    await runObserveCommand({
      projectRoot: path.resolve(String(options.root || process.cwd())),
      portfolioManifest: options["portfolio-manifest"],
      host: options.host,
      port: options.port,
      openBrowser: options["no-open"] !== true,
      json: options.json === true,
      // Without --locale the observatory follows the locale recorded for the project.
      locale: options.locale === undefined ? undefined : humanGuidanceLocale(options),
    }, {
      parentIpcExpected: Object.hasOwn(process.env, OBSERVATORY_WORKER_MARKER)
        && process.env[OBSERVATORY_WORKER_MARKER] === "1",
    });
  } catch (error) {
    if (error instanceof TypeError) fail(error.message);
    if (options["portfolio-manifest"] !== undefined && error instanceof ObservatoryPathError) {
      fail(
        `The portfolio could not be opened: ${error.message}. `
        + "Check --root and the explicit relative path passed to --portfolio-manifest.",
      );
    }
    throw error;
  }
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const rawJsonRequested = rawBooleanOptionRequested(rawArgs, "json");
  const rawLocale = rawStringOptionValue(rawArgs, "locale");
  let parsed = { options: rawLocale === undefined ? {} : { locale: rawLocale } };
  try {
    if (!isSupportedNodeRuntime(process.versions.node)) {
      throw new UnsupportedNodeRuntimeError(process.versions.node, rawLocale);
    }
    parsed = parseArgs(rawArgs);
    parsed = applyCliPresetOptions(parsed);
    if (parsed.options.locale !== undefined) humanGuidanceLocale(parsed.options);
    if (parsed.version) {
      console.log(parsed.options.json === true
        ? JSON.stringify(inspectBuildIdentity(PLUGIN_ROOT), null, 2)
        : VERSION);
      return;
    }
    if (parsed.help || parsed.positionals.length === 0) {
      const helpPath = parsed.positionals[0] === "help"
        ? parsed.positionals.slice(1)
        : parsed.positionals;
      console.log(renderHelp(helpPath, {
        locale: humanGuidanceLocale(parsed.options),
        json: parsed.options.json === true,
        version: VERSION,
      }));
      return;
    }
    const resolution = resolveCommand(parsed.positionals);
    if (!resolution && findCommand(parsed.positionals)?.kind === "group") {
      // A command family named without an action (for example `portfolio`)
      // shows what it offers instead of reporting an unknown command.
      console.log(renderHelp(parsed.positionals, {
        locale: humanGuidanceLocale(parsed.options),
        json: parsed.options.json === true,
        version: VERSION,
      }));
      return;
    }
    const registry = buildCliRuntimeHandlerRegistry();
    const invocation = {
      options: parsed.options,
      parsed,
      rawArgs,
    };
    const handler = resolution ? registry.get(resolution.canonical_action) : null;
    if (resolution?.command.arguments === "none" && resolution.args.length > 0) {
      const commandPath = resolution.canonical_path.join(" ");
      failUsage(
        `Unexpected argument '${resolution.args[0]}' for '${commandPath}'; it accepts only --options. `
        + `See 'agentic-sdlc help ${commandPath}'.`,
      );
    }
    if (handler?.stage === "bootstrap" && resolution.canonical_action !== "observe") {
      await registry.dispatch(resolution, invocation);
      return;
    }
    if (!resolution && parsed.positionals[0] === "preset") {
      const [, subcommand, ...rest] = parsed.positionals;
      handleCliPresetCommand(subcommand, rest, parsed);
      return;
    }

    const resolvedRoot = path.resolve(String(parsed.options.root || process.cwd()));
    assertProjectRootDirectory(resolvedRoot);
    const isIdentityRecovery = resolution?.canonical_action === "migration.identity"
      && parsed.options.recover === true;
    const identityMigrationLockPath = path.join(resolvedRoot, ".sdlc-identity-migration.lock");
    if (pathEntryExistsNoFollow(identityMigrationLockPath) && !isIdentityRecovery) {
      fail(
        "An identity migration transaction is active or interrupted. "
        + "Run the authenticated identity recovery workflow before any other command.",
      );
    }
    if (isIdentityRecovery) {
      // Deliberate bootstrap exception: the identity module must restore the
      // shadowed .sdlc tree before project config can be trusted or dispatched.
      // Its transaction is independently bound to the exact journal, nonce,
      // plan hash, canonical roots, and recovery claim; no other command enters
      // this branch. createBootstrapMutationGrant tests the same exact boundary.
      await registry.dispatch(resolution, { ...invocation, context: { root: resolvedRoot } });
      return;
    }
    if (resolution?.canonical_action === "observe") {
      await registry.dispatch(resolution, invocation);
      return;
    }
    let context = buildContext(parsed.options);
    if (resolution?.canonical_action === "status") {
      // Status first brings this clone up to date; when that moved the
      // checkout, the records are read again from the new commit.
      const statusSync = syncProjectForStatus(context, parsed.options);
      if (statusSync?.head_changed) context = buildContext(parsed.options);
      context.statusSync = statusSync;
    }
    if (handler?.stage === "pre-config") {
      // Doctor reports the plugin version check itself.
      if (resolution.canonical_action !== "doctor") assertPluginSatisfiesProject(context, resolution, parsed.options);
      if (resolution?.canonical_action === "config.migrate" && parsed.options.apply === true) {
        // Deliberate bootstrap exception: only the exact reviewed plan hash may
        // enter migrateProjectConfig's transactional grant. The current config
        // is the object being repaired, so it cannot authorize its own repair.
        await registry.dispatch(resolution, { ...invocation, context });
        return;
      }
      if (resolution?.canonical_action === "project.archive" && parsed.options.apply === true) {
        // Deliberate bootstrap exception: the archive moves the very records
        // that hold the governance policy and then re-runs the first-time
        // bootstrap, which cannot nest inside an active governance context.
        // The command itself refuses agents, published or shared state, a
        // stale plan hash, and anything but a person or CI approval.
        await registry.dispatch(resolution, { ...invocation, context });
        return;
      }
      await dispatchWithMutationGovernance(registry, resolution, { ...invocation, context });
      return;
    }
    assertConfigAllowsCommand(context, resolution, parsed.options, parsed.positionals);
    // Records written by a newer plugin stop changes here and warn on reads.
    assertPluginSatisfiesProject(context, resolution, parsed.options);
    if (!resolution || !handler) {
      failUsage(`Unknown command: ${parsed.positionals.slice(0, 2).join(" ")}`);
    }
    await dispatchWithMutationGovernance(registry, resolution, { ...invocation, context });
  } catch (caught) {
    const error = explainHistoryReadLimitError(caught);
    const jsonRequested = parsed.options?.json === true || rawJsonRequested;
    const errorRedaction = error instanceof UnsupportedNodeRuntimeError
      ? cliErrorRedactionResolution(OPERATIONAL_REDACTION_POLICY, false)
      : resolveCliErrorRedactionPolicy(parsed.options);
    const errorRedactionPolicy = errorRedaction.policy;
    const failureExitCode = errorRedaction.withholdDetails
      ? EXIT_CODES.userError
      : exitCodeForError(error);
    if (error instanceof UnknownCommandError) {
      if (jsonRequested) {
        console.error(JSON.stringify(buildCliErrorPayload(error, parsed.options, errorRedaction), null, 2));
        process.exitCode = failureExitCode;
        return;
      }
      const safeMessage = errorRedaction.withholdDetails
        ? withheldDetailsMessage(errorRedaction)
        : redactText(error.message, errorRedactionPolicy);
      console.error(`${safeMessage}\nCorrelation ID: ${CLI_OPERATION_CONTEXT.correlation_id}`);
      process.exitCode = failureExitCode;
      return;
    }
    const expected = error instanceof UserError
      || error instanceof CliPresetError
      || error instanceof MutationGovernanceError;
    {
      const italian = (() => {
        try {
          return humanGuidanceLocale(parsed.options) === "it";
        } catch {
          return false;
        }
      })();
      const labels = italian
        ? {
            outcome: "Risultato",
            impact: "Cosa cambia in pratica",
            decision: "Cosa devi decidere",
            protection: "Cosa resta protetto",
            next: "Prossimo passo",
            details: "Dettagli tecnici (facoltativi)",
          }
        : {
            outcome: "Outcome",
            impact: "What this changes in practice",
            decision: "What you need to decide",
            protection: "What remains protected",
            next: "Next step",
            details: "Technical details (optional)",
          };
      if (jsonRequested) {
        console.error(JSON.stringify(buildCliErrorPayload(error, parsed.options, errorRedaction), null, 2));
        process.exitCode = failureExitCode;
        return;
      }
      const normalized = normalizeOperationalError(
        errorRedaction.withholdDetails
          ? {
              code: "observability_configuration_invalid",
              message: withheldDetailsMessage(errorRedaction),
              statusCode: 400,
              retryable: false,
            }
          : expected
          ? { code: "user_error", message: error.message, statusCode: 400, retryable: false }
          : { code: "internal_error", message: "The command could not be completed.", statusCode: 500, retryable: false },
        {
          context: CLI_OPERATION_CONTEXT,
          redactionPolicy: errorRedactionPolicy,
          details: errorRedaction.withholdDetails || expected ? null : internalErrorCauseDetails(error),
        },
      );
      const customGuidance = userErrorHumanGuidance(error, italian);
      if (customGuidance) {
        console.error(humanGuidanceLines(
          customGuidance,
          [
            `Error: ${normalized.error.message}`,
            `Correlation ID: ${CLI_OPERATION_CONTEXT.correlation_id}`,
          ],
          parsed.options,
        ).join("\n"));
        process.exitCode = failureExitCode;
        return;
      }
      console.error([
        `${labels.outcome}: ${italian ? "Il comando non è stato completato." : "The command could not be completed."}`,
        `${labels.impact}: ${italian ? "Il risultato richiesto non è disponibile e il programma non continuerà automaticamente." : "The requested result is unavailable, and the software will not continue automatically."}`,
        `${labels.decision}: ${italian ? "Non devi approvare nulla finché il problema non è stato corretto." : "You do not need to approve anything until the problem is corrected."}`,
        `${labels.protection}: ${italian ? "Le regole di sicurezza e i limiti già concordati restano invariati." : "Existing safety rules and agreed limits remain unchanged."}`,
        `${labels.next}: ${italian ? "Consulta la diagnosi facoltativa, correggi il problema e riprova." : "Review the optional diagnosis, correct the problem, and try again."}`,
        "",
        `${labels.details}:`,
        `- Error: ${normalized.error.message}`,
        ...(normalized.error.details?.cause
          ? [`- Cause: ${Object.entries(normalized.error.details.cause).map(([key, value]) => `${key}=${value}`).join(" ")}`]
          : []),
        `- Correlation ID: ${CLI_OPERATION_CONTEXT.correlation_id}`,
      ].join("\n"));
      process.exitCode = failureExitCode;
      return;
    }
  }
}

executeIdentityMutation.revalidate = function revalidateIdentityMutation(request) {
  assertMutationExecutionAuthorized(request);
  return true;
};

executePreparedIdentityMutation.revalidate = function revalidatePreparedIdentityMutation(request) {
  assertMutationExecutionAuthorized(request);
  return true;
};

executePreparedIdentityMutation.prepare = function prepareIdentityMutationBatch(descriptor, effect) {
  if (!descriptor || !Array.isArray(descriptor.exact_mutations)) {
    throw new MutationGovernanceError(
      "Identity migration is missing its reviewed exact mutation descriptor",
      "MUTATION_BATCH_INVALID",
    );
  }
  return withGovernedMutationBatch(descriptor.exact_mutations, effect);
};

await main();
