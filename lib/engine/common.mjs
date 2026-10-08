import path from "node:path";
import {
  inspectBuildIdentity,
} from "../build-identity.mjs";
import {
  computeStableHash,
} from "../canonical.mjs";
import {
  createObservatoryConfiguration,
} from "../change-observatory/configuration.mjs";
import {
  UnknownCommandError,
} from "../cli/help.mjs";
import {
  CliPresetError,
  exportCliPresets,
  listCliPresets,
  resolveCliPresets,
  showCliPreset,
} from "../cli/presets.mjs";
import {
  UsageError,
  UserError,
  fail,
  failUsage,
} from "../cli/user-error.mjs";
import {
  UnsupportedNodeRuntimeError,
} from "../lifecycle/classes.mjs";
import {
  agentHostEnvValue,
  detectAgentHost,
  namesAgentHost,
} from "../agent-host.mjs";
import {
  CODE_REVIEW_VERDICTS,
  evaluateMergeReviews,
  normalizeCodeReviewFindings,
  parseCommitAuthors,
  reviewerAuthorConflicts,
} from "../code-review.mjs";
import {
  resolveEffectiveConfig,
} from "../effective-config.mjs";
import {
  buildExecutionContextPreflightReceipt,
  executionContextSnapshotRevalidationDecision,
  executionContextSourceEvolutionDecision,
  validateExecutionContextPreflightReceipt,
} from "../execution-context-preflight.mjs";
import {
  IDENTITY_STAT_OPTIONS,
  sameFileIdentityValues,
} from "../file-identity.mjs";
import {
  MutationGovernanceError,
  appendJsonLineNoFollow,
  assertMutationExecutionAuthorized,
  withGovernedMutation,
} from "../governance/mutation-guard.mjs";
import {
  formatSchemaErrors,
  matchesRfc3339DateTime,
  validateAgainstSchema,
} from "../json-schema-validator.mjs";
import {
  hashApprovalSubject,
} from "../lifecycle/authorization.mjs";
import {
  capabilityProfilePath,
  capabilityRecommendationPath,
} from "../lifecycle/capability.mjs";
import {
  assertNotDerivedArtifact,
  boundedNonNegativeIntegerOption,
  boundedPositiveInteger,
  buildDomainRecord,
  buildLegacyDefaultsProfile,
  cliErrorRedactionResolution,
  withheldDetailsMessage,
  compactIndexEntry,
  compareReportQueryRecords,
  countBy,
  deriveTestRunOutcome,
  getOptionString,
  inferTitle,
  internalErrorCauseDetails,
  isEventInsideWindow,
  localTargetBuildPreconditionDetails,
  localTargetPredecessorStateMatches,
  normalizeActivityReportView,
  normalizeActorType,
  normalizeId,
  normalizeListOption,
  normalizeListValue,
  normalizeObject,
  normalizeOptionalDateTime,
  normalizeRawListOption,
  normalizeRecordedCommandArgv,
  normalizeReportQuery,
  normalizeStringArray,
  normalizeText,
  normalizeWorkItemType,
  parseBooleanOption,
  reportQueryFiltersMatch,
  reportQuerySubjectMatches,
  requireEnumOption,
  requireOption,
  scoreEntry,
  secretScanPolicy,
  shouldIndexFile,
  stableJson,
  summarizeActivityEvents,
  tokenize,
} from "../lifecycle/common.mjs";
import {
  CACHE_FILE_NAME,
  EXIT_CODES,
  MAX_CLI_ERROR_CONFIG_BYTES,
  OPERATIONAL_REDACTION_POLICY,
  PROJECT_CONFIG_FILE_NAME,
  PROJECT_CONFIG_LOCK_FILE_NAME,
  SDLC_DIR,
  SECRET_SCAN_MAX_FILE_BYTES,
  WORK_ITEM_CREATE_TYPES,
} from "../lifecycle/constants.mjs";
import {
  compareDeliveryAuthorizationOrder,
  deliveryAutonomyPath,
  gitRuntimeWithoutBaseSha,
  localReleaseTargetHadAbsentEntries,
  normalizeGitEvent,
} from "../lifecycle/delivery.mjs";
import {
  taskStartGitBase,
} from "../lifecycle/git-base.mjs";
import {
  humanGuidanceLines,
  humanGuidanceLocale,
  userErrorHumanGuidance,
} from "../lifecycle/guidance.mjs";
import {
  buildTemplateResolution,
  collectOutputArtifactTypes,
  createOutputRegistryQueryIndex,
  formatActivityEventForView,
  formatReportQueryRecord,
  outputResolutionKey,
  renderActivityReportMarkdown,
  renderReportQueryMarkdown,
  safeEvidenceExcerpt,
  terminalSafeText,
} from "../lifecycle/output.mjs";
import {
  assertNoSymlinkPathSegments,
  buildContextOptimizationMetadata,
  codeReviewsRoot,
  contextOptimizationRuntimeOptions,
  dependenciesRoot,
  executionContextPreflightPath,
  isDerivedArtifactPath,
  mergeMissingConfigDefaults,
  normalizeProjectPathInput,
  openProjectQuerySession,
  operationsRoot,
  readContextOptimizationPolicy,
  secretScansRoot,
  testRunsRoot,
  toProjectPath,
  workItemPath,
  workItemsRoot,
} from "../lifecycle/project.mjs";
import {
  baselinePathById,
  buildStoryDependencyGraph,
  buildTraceRedactionPolicy,
  buildStoryRequirementGraph,
  defaultStoryBranch,
  normalizeStoryRecord,
  requirementAutonomyPath,
  requirementPath,
  resolveIncidentFeedbackPhase,
  traceActorKey,
  traceActorMatches,
  workBreakdownRoot,
} from "../lifecycle/story.mjs";
import {
  normalizeOperationalError,
} from "../observability/context.mjs";
import {
  RedactionLimitError,
  redactText,
  redactValue,
  redactValueInChunks,
} from "../observability/redaction.mjs";
import {
  assertNoSymlinkSegmentsWithinBoundary,
} from "../project-path-safety.mjs";
import {
  routeRtkCommand,
} from "../rtk-optimization-adapter.mjs";
import {
  NODE_ENGINE_RANGE,
  NODE_RUNTIME_REQUIREMENT,
  isSupportedNodeRuntime,
} from "../runtime-support.mjs";
import {
  Date,
  childProcess,
  console,
  crypto,
  fs,
  process,
} from "../runtime/host.mjs";
import {
  sharedClaimView,
  storySharedClaimState,
} from "../story-claim-shared-state.mjs";
import {
  sharedClaimsOverview,
  storyClaimPolicy,
} from "./story-claim-shared.mjs";
import {
  PLUGIN_ROOT,
} from "../runtime/paths.mjs";
import {
  SecretScanConfigurationError,
  scanFiles,
} from "../secret-scan.mjs";
import {
  acquireOptimizationRunBudgetGate,
  executeOptimizationRunWithBudgetGate,
} from "./assessment.mjs";
import {
  buildTraceAuthorityMetadata,
  collectApprovalManifestEntries,
  collectApprovalQueryRecords,
  dataOperationReceiptErrors,
  storyOriginalTaskStart,
} from "./authorization.mjs";
import {
  readCapabilityProfile,
} from "./capability.mjs";
import {
  BOOLEAN_OPTIONS,
  CLI_OPERATION_CONTEXT,
  DEFAULT_TEMPLATE_DIR,
  KNOWN_OPTIONS,
  NO_FOLLOW_FLAG,
  REPEATABLE_OPTIONS,
  VERSION,
} from "./definitions.mjs";
import {
  buildLocalReleaseTargetSnapshot,
  currentDeliveryExecutionState,
  deliveryActionReceipts,
  localReleaseProtectedTargetState,
  localReleaseTargetContentManifest,
  localReleaseTargetGovernanceState,
  readDeliveryAutonomyProfile,
  readPullRequestDeliveryForReview,
  resolveOperationsReleaseManifestId,
} from "./delivery.mjs";
import {
  buildGitMetadata,
  currentUnbornGitBase,
  execGit,
  execGitOutput,
  gitCommandSucceeds,
  gitConfigValue,
  gitEmptyTreeId,
  gitHeadIsUnborn,
  readExactGitWorkspaceStatus,
  readGitBlobAt,
  resolveSecretScanCommit,
  secretScanGitPaths,
  validatePullRequestGitBoundary,
} from "./git.mjs";
import {
  buildDependencyStatus,
  buildReportQueryNormalizationGuidance,
  configStatusCommand,
  configStatusGuidance,
  defaultHumanActorId,
  getIndexStatus,
} from "./guidance.mjs";
import {
  captureDirectoryIdentity,
  ensureInitialized,
  inspectProjectRecord,
  isKbInitialized,
} from "./migration.mjs";
import {
  buildFeedbackEvidence,
  buildOutputResolution,
  buildTestRunEvidence,
  collectOutputQueryRecords,
  humanOutputLabel,
  output,
  readOutputRegistry,
  readRequiredTemplateConfig,
} from "./output.mjs";
import {
  collectProjectKeyFiles,
  detectConfiguredRtk,
  detectProjectStack,
  inferSourceRoots,
  inferTestRoots,
  knowledgeSourceRoots,
  normalizePreflightWritePaths,
  resolveProjectFilePath,
  validateSdlcConfig,
  verifyConfiguredRtk,
  verifyOpenFileMatchesPath,
} from "./project.mjs";
import {
  acquireFileLock,
  assertStableDirectory,
  ensureDir,
  hashFile,
  inferStoryBlockers,
  readJson,
  readLocks,
  readProjectJson,
  readProjectJsonBounded,
  readProjectSafe,
  readProjectText,
  displayProjectFilePath,
  removePathGoverned,
  resolveStableTemplateDirectory,
  safeReadDir,
  stableContextSourceSnapshot,
  stableWorkspacePathSnapshot,
  walkFiles,
  writeJsonFile,
  writeTextFile,
} from "./storage.mjs";
import {
  TRACE_HISTORY_READ_LIMIT_BYTES,
  TRACE_SIZE_WARNING_RATIO,
  formatTraceSizeMiB,
  inspectTraceHistory,
  traceIntegrityRecoveryText,
  traceRecoveryNeededText,
  traceSizeWarningLines,
  traceUnverifiableText,
} from "./story.mjs";
import {
  appendTraceEvent,
  assertRequirementReadyForDownstream,
  buildDependencyQuery,
  collectContractQueryRecords,
  collectHandoffQueryRecords,
  collectStoryQueryRecords,
  collectStoryStepQueryRecords,
  collectTraceQueryRecords,
  effectiveStoryLifecycleProjection,
  inferStoryOrchestrationState,
  readAllTraceEvents,
  readContractById,
  readDependencyGraph,
  readHandoffs,
  readRequirement,
  readRequirementAutonomyProfile,
  readStory,
  readStoryStepRecords,
  secretScanStoryWritePaths,
  selectActiveBaselines,
  storyOrchestrationNextAction,
} from "./story.mjs";

export function buildCliErrorPayload(
  error,
  options = {},
  errorRedaction = resolveCliErrorRedactionPolicy(options),
) {
  const italian = (() => {
    try {
      return humanGuidanceLocale(options) === "it";
    } catch {
      return false;
    }
  })();
  const unknown = error instanceof UnknownCommandError;
  const errorRedactionPolicy = errorRedaction.policy;
  const describeUnknown = unknown && !errorRedaction.withholdDetails;
  const expected = unknown
    || error instanceof UserError
    || error instanceof CliPresetError
    || error instanceof MutationGovernanceError;
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
  const internalDetails = normalized.error.details;
  const code = errorRedaction.withholdDetails
    ? "OBSERVABILITY_CONFIGURATION_INVALID"
    : unknown
    ? error.code
    : error instanceof CliPresetError
      ? "CLI_PRESET_ERROR"
      : error instanceof UnsupportedNodeRuntimeError
        ? "UNSUPPORTED_NODE_RUNTIME"
      : error instanceof UsageError
        ? "USAGE_ERROR"
      : error instanceof UserError
        ? error.errorCode || "USER_ERROR"
      : error instanceof MutationGovernanceError
        ? error.code
      : "INTERNAL_ERROR";
  const redactedUnknownPath = describeUnknown
    ? redactText(error.path || "", errorRedactionPolicy)
    : unknown ? "[REDACTED]" : "";
  const redactedUnknownSuggestions = describeUnknown
    ? (error.suggestions || []).map((value) => redactText(value, errorRedactionPolicy))
    : [];
  const message = describeUnknown
    ? redactText(`Unknown command: ${error.path || "(empty)"}`, errorRedactionPolicy)
    : normalized.error.message;
  const customGuidance = userErrorHumanGuidance(error, italian);
  const guidance = describeUnknown
    ? {
        result: italian ? "Non ho trovato l’azione richiesta." : "The requested action was not found.",
        impact: italian ? "Nessun progetto è stato aperto o modificato." : "No project was opened or changed.",
        required_decision: italian ? "Scegli se correggere la formulazione oppure usare l’aiuto principale." : "Choose whether to correct the wording or use the main help.",
        protection_boundary: italian ? "File locali, repository remoti, rilasci e produzione restano invariati." : "Local files, remote repositories, releases, and production remain unchanged.",
        next_action: italian ? "Controlla la scrittura e riprova con una delle azioni suggerite." : "Check the spelling and try one of the suggested actions.",
        details: { path: redactedUnknownPath, suggestions: redactedUnknownSuggestions },
      }
    : customGuidance || {
        result: italian ? "Il comando non è stato completato." : "The command could not be completed.",
        impact: italian ? "Il risultato richiesto non è disponibile e il programma non continuerà automaticamente." : "The requested result is unavailable, and the software will not continue automatically.",
        required_decision: italian ? "Non devi approvare nulla finché il problema non è stato corretto." : "You do not need to approve anything until the problem is corrected.",
        protection_boundary: italian ? "Le regole di sicurezza e i limiti già concordati restano invariati." : "Existing safety rules and agreed limits remain unchanged.",
        next_action: italian ? "Correggi il problema descritto nella diagnosi e riprova." : "Correct the problem described in the diagnosis and try again.",
        details: {
          code,
          message,
          ...(internalDetails ? internalDetails : {}),
          ...(error instanceof MutationGovernanceError
            ? { mutation: redactValue(error.details, errorRedactionPolicy) }
            : {}),
        },
      };
  return {
    schema_version: "agentic-sdlc-cli-error:v1",
    status: "error",
    correlation_id: CLI_OPERATION_CONTEXT.correlation_id,
    error: {
      code,
      message,
      retryable: normalized.error.retryable,
      ...(internalDetails ? { details: internalDetails } : {}),
      ...(unknown ? {
        path: redactedUnknownPath,
        suggestions: redactedUnknownSuggestions,
      } : {}),
    },
    human_guidance: guidance,
  };
}

/** Refuse a --root that cannot be a project folder before anything reads or writes under it. */
export function assertProjectRootDirectory(root) {
  let entry;
  try {
    entry = fs.statSync(root);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      fail(`Project root does not exist: ${root}. Create the folder or correct --root.`);
    }
    throw error;
  }
  if (!entry.isDirectory()) {
    fail(`Project root is not a directory: ${root}. Pass the project folder as --root.`);
  }
}

export function resolveCliErrorRedactionPolicy(options) {
  let configPath;
  let root = null;
  let settingsStage = false;
  try {
    root = path.resolve(String(options.root || process.cwd()));
    configPath = path.join(root, SDLC_DIR, PROJECT_CONFIG_FILE_NAME);
    // A root that is missing, not a directory, or itself a symlink has no
    // trusted configuration to protect; the command's own refusal names the
    // actual problem, still under the operational redaction policy.
    let rootEntry;
    try {
      rootEntry = fs.lstatSync(root);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
        return cliErrorRedactionResolution(OPERATIONAL_REDACTION_POLICY, false);
      }
      throw error;
    }
    if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
      return cliErrorRedactionResolution(OPERATIONAL_REDACTION_POLICY, false);
    }
    let entry;
    try {
      entry = fs.lstatSync(configPath);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        return cliErrorRedactionResolution(OPERATIONAL_REDACTION_POLICY, true, diagnoseConfigurationProblem(root));
      }
      // Missing is optional only when no parent segment is a symlink. A
      // symlinked knowledge-base path could hide a configured privacy policy.
      assertNoSymlinkPathSegments(configPath, root);
      return cliErrorRedactionResolution(OPERATIONAL_REDACTION_POLICY, false);
    }
    if (!entry.isFile() || entry.isSymbolicLink()) {
      return cliErrorRedactionResolution(OPERATIONAL_REDACTION_POLICY, true, diagnoseConfigurationProblem(root));
    }
    resolveProjectFilePath({ root }, configPath, { mustExist: true, fileOnly: true });
    assertNoSymlinkPathSegments(configPath, root);
    const config = readProjectJsonBounded(
      { root },
      configPath,
      MAX_CLI_ERROR_CONFIG_BYTES,
    );
    if (config === null || typeof config !== "object" || Array.isArray(config)) {
      return cliErrorRedactionResolution(OPERATIONAL_REDACTION_POLICY, true, "config_not_json");
    }
    settingsStage = true;
    return cliErrorRedactionResolution(
      createObservatoryConfiguration(config.observability ?? {}).redactionPolicy,
      false,
    );
  } catch {
    const reason = settingsStage ? "config_settings" : diagnoseConfigurationProblem(root);
    return cliErrorRedactionResolution(OPERATIONAL_REDACTION_POLICY, true, reason);
  }
}

// Names the problem class of an unusable project configuration without ever
// echoing file contents. Returns null when the cause cannot be established, so
// the caller keeps the generic withheld message.
function diagnoseConfigurationProblem(root) {
  try {
    const sdlcPath = path.join(root, SDLC_DIR);
    if (fs.lstatSync(sdlcPath).isSymbolicLink()) return "sdlc_symlink";
    const configPath = path.join(sdlcPath, PROJECT_CONFIG_FILE_NAME);
    const entry = fs.lstatSync(configPath);
    if (entry.isSymbolicLink()) return "config_symlink";
    if (!entry.isFile()) return "config_not_json";
    if (entry.size > MAX_CLI_ERROR_CONFIG_BYTES) return "config_too_large";
    try {
      JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch (error) {
      return error instanceof SyntaxError ? "config_not_json" : null;
    }
    return null;
  } catch {
    return null;
  }
}

export function parseArgs(argv) {
  const options = {};
  const positionals = [];
  let help = false;
  let version = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--version" || arg === "-v") {
      version = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const raw = arg.slice(2);
      const equalsIndex = raw.indexOf("=");
      const key = equalsIndex >= 0 ? raw.slice(0, equalsIndex) : raw;
      if (!key || !KNOWN_OPTIONS.has(key)) {
        failUsage(`Unknown option --${key || raw}`);
      }
      const inlineValue = equalsIndex >= 0 ? raw.slice(equalsIndex + 1) : undefined;
      let value = inlineValue;
      if (BOOLEAN_OPTIONS.has(key)) {
        const next = argv[index + 1];
        if (value === undefined && next !== undefined && /^(?:true|false)$/i.test(next)) {
          value = parseBooleanOption(key, next);
          index += 1;
        } else {
          value = value === undefined ? true : parseBooleanOption(key, value);
        }
      } else if (value === undefined) {
        const next = argv[index + 1];
        // A negative number is a value, not an option: let the command explain
        // why it is not accepted instead of reporting a missing value.
        if (next === undefined || (next.startsWith("-") && !/^-\d/u.test(next))) {
          failUsage(`Missing value for option --${key}`);
        }
        value = next;
        index += 1;
      }
      addOption(options, key, value);
      continue;
    }
    positionals.push(arg);
  }

  return { options, positionals, help, version };
}

export function addOption(options, key, value) {
  if (options[key] === undefined) {
    options[key] = value;
    return;
  }
  if (!REPEATABLE_OPTIONS.has(key)) {
    failUsage(`Option --${key} may only be provided once`);
  }
  if (!Array.isArray(options[key])) {
    options[key] = [options[key]];
  }
  options[key].push(value);
}

export function applyCliPresetOptions(parsed) {
  const explicitOptions = { ...parsed.options };
  const cliPresets = explicitOptions["cli-preset"];
  delete explicitOptions["cli-preset"];
  if (cliPresets === undefined) {
    return { ...parsed, options: explicitOptions, cliPresets: [] };
  }
  const resolved = resolveCliPresets(cliPresets, {
    cwd: process.cwd(),
    explicitOptions,
  });
  return {
    ...parsed,
    options: { ...resolved.options },
    cliPresets: Array.isArray(cliPresets) ? [...cliPresets] : [cliPresets],
    cliPresetResolution: resolved,
  };
}

export function handleCliPresetCommand(subcommand, rest, parsed) {
  const options = parsed.options;
  const locale = humanGuidanceLocale(options);
  const italian = locale === "it";
  if (subcommand === "list") {
    if (rest.length > 0) failUsage("preset list does not accept positional values.");
    const presets = listCliPresets();
    if (options.json) {
      console.log(JSON.stringify({ schema_version: "agentic-sdlc-cli-preset-list-v1", presets }, null, 2));
      return;
    }
    console.log([
      `${italian ? "Risultato" : "Outcome"}: ${italian ? "Sono disponibili impostazioni di presentazione sicure e incluse nel plugin." : "Safe built-in presentation settings are available."}`,
      `${italian ? "Cosa cambia in pratica" : "What this changes in practice"}: ${italian ? "Puoi scegliere lingua, formato macchina, livello di dettaglio o apertura del browser senza ampliare i permessi." : "You can choose language, machine output, diagnostic detail, or browser behavior without widening permissions."}`,
      `${italian ? "Cosa devi decidere" : "What you need to decide"}: ${italian ? "Scegli soltanto l’impostazione di presentazione che preferisci." : "Choose only the presentation setting you prefer."}`,
      `${italian ? "Cosa resta protetto" : "What remains protected"}: ${italian ? "Queste impostazioni non possono approvare azioni, cambiare destinazioni o ampliare i file modificabili." : "These settings cannot approve actions, change targets, or widen writable files."}`,
      `${italian ? "Prossimo passo" : "Next step"}: ${italian ? "Consulta i dettagli facoltativi e scegli una voce." : "Review the optional details and choose one entry."}`,
      "",
      `${italian ? "Dettagli tecnici (facoltativi)" : "Technical details (optional)"}:`,
      ...presets.map((preset) => `- ${preset.id}: ${preset.description[locale]} | ${JSON.stringify(preset.options)}`),
    ].join("\n"));
    return;
  }
  if (subcommand === "show") {
    const id = rest[0] || getOptionString(options, "id");
    if (!id || rest.length > 1) failUsage("preset show needs exactly one preset name.");
    const preset = showCliPreset(id);
    if (options.json) {
      console.log(JSON.stringify(preset, null, 2));
      return;
    }
    console.log([
      `${italian ? "Risultato" : "Outcome"}: ${preset.description[locale]}`,
      `${italian ? "Cosa cambia in pratica" : "What this changes in practice"}: ${italian ? "Questa scelta modifica soltanto come vengono presentati i risultati." : "This choice changes only how results are presented."}`,
      `${italian ? "Cosa devi decidere" : "What you need to decide"}: ${italian ? "Decidi se questa presentazione è adatta alla singola esecuzione." : "Decide whether this presentation suits the current run."}`,
      `${italian ? "Cosa resta protetto" : "What remains protected"}: ${italian ? "Non autorizza operazioni e non cambia il perimetro del lavoro." : "It authorizes no operation and does not change the work boundary."}`,
      `${italian ? "Prossimo passo" : "Next step"}: ${italian ? "Applicala soltanto se corrisponde alla presentazione desiderata." : "Apply it only if it matches the presentation you want."}`,
      "",
      `${italian ? "Dettagli tecnici (facoltativi)" : "Technical details (optional)"}:`,
      `- id: ${preset.id}`,
      `- options: ${JSON.stringify(preset.options)}`,
      `- sha256: ${preset.sha256}`,
    ].join("\n"));
    return;
  }
  if (subcommand === "export") {
    const references = [...rest, ...(parsed.cliPresets || [])];
    if (references.length === 0) failUsage("preset export needs at least one preset name or @file.json reference.");
    console.log(exportCliPresets(references, { cwd: process.cwd() }));
    return;
  }
  failUsage("preset needs one subcommand: list, show, or export.");
}

export function buildContext(options) {
  const root = path.resolve(String(options.root || process.cwd()));
  const bundledTemplateDirectory = resolveStableTemplateDirectory(DEFAULT_TEMPLATE_DIR);
  const templateDirectory = options["template-dir"] === undefined
    ? bundledTemplateDirectory
    : resolveStableTemplateDirectory(String(options["template-dir"]));
  const templateDir = templateDirectory.path;
  const templateConfig = validateSdlcConfig(
    readRequiredTemplateConfig(templateDir, templateDirectory.identity),
  );
  const projectConfigPath = path.join(root, SDLC_DIR, PROJECT_CONFIG_FILE_NAME);
  const configLockPath = path.join(root, SDLC_DIR, PROJECT_CONFIG_LOCK_FILE_NAME);
  if (fs.existsSync(projectConfigPath)) {
    resolveProjectFilePath({ root }, projectConfigPath, { mustExist: true, fileOnly: true });
    assertNoSymlinkPathSegments(projectConfigPath, root);
  }
  if (fs.existsSync(configLockPath)) {
    resolveProjectFilePath({ root }, configLockPath, { mustExist: true, fileOnly: true });
    assertNoSymlinkPathSegments(configLockPath, root);
  }
  const templateDefaultsProfile = {
    id: `${templateConfig.config_schema_version}@plugin-${VERSION}`,
    sha256: computeStableHash(templateConfig),
  };
  const projectConfigExists = fs.existsSync(projectConfigPath);
  const rawProjectConfig = projectConfigExists ? readProjectJson({ root }, projectConfigPath) : null;
  const projectConfigLock = fs.existsSync(configLockPath) ? readProjectJson({ root }, configLockPath) : null;
  const projectConfigSnapshotHash = rawProjectConfig ? computeStableHash(rawProjectConfig) : null;
  const projectConfigLockSnapshotHash = projectConfigLock ? computeStableHash(projectConfigLock) : null;
  const legacyConfig = projectConfigExists && !projectConfigLock
    ? validateSdlcConfig(
        readJson(path.join(DEFAULT_TEMPLATE_DIR, "config-compat", "sdlc-config-v1-0.11.0.json")),
      )
    : null;
  const legacyDefaultsProfile = legacyConfig
    ? buildLegacyDefaultsProfile(legacyConfig)
    : null;
  let configResolutionError = null;
  let configState;
  if (projectConfigExists) {
    try {
      configState = resolveEffectiveConfig({
        project_config: rawProjectConfig,
        ...(legacyConfig ? { legacy_defaults: legacyConfig, defaults_profile: legacyDefaultsProfile } : {}),
        lock: projectConfigLock,
        config_path: `${SDLC_DIR}/${PROJECT_CONFIG_FILE_NAME}`,
      });
    } catch (error) {
      configResolutionError = error.message;
      configState = {
        status: "invalid",
        migration_required: true,
        mutation_allowed: false,
        raw_config: rawProjectConfig,
        effective_config: rawProjectConfig,
        raw_config_hash: computeStableHash(rawProjectConfig),
        effective_config_hash: computeStableHash(rawProjectConfig),
        defaults_profile: null,
        inherited_paths: [],
        lock_verification: null,
      };
    }
  } else if (
    projectConfigLock
    || fs.existsSync(path.join(root, SDLC_DIR, "project.json"))
  ) {
    // An initialized project without its configuration must not fall back to
    // the bundled defaults: that would silently drop project privacy rules
    // (custom redaction) and every other agreed policy. Fail closed instead.
    // When the lock proves that the missing file held exactly the bundled
    // defaults, copying those defaults back restores the agreed rules.
    const defaultsSource = projectConfigLock?.config_hash
      && projectConfigLock.config_hash === computeStableHash(templateConfig)
      ? path.join(templateDir, "sdlc-config.json")
      : null;
    configResolutionError = missingProjectConfigMessage(defaultsSource);
    configState = {
      status: "missing",
      restorable_defaults_path: defaultsSource,
      migration_required: false,
      mutation_allowed: false,
      raw_config: null,
      effective_config: templateConfig,
      raw_config_hash: null,
      effective_config_hash: null,
      defaults_profile: null,
      inherited_paths: [],
      lock_verification: null,
    };
  } else {
    configState = {
        status: "uninitialized",
        migration_required: false,
        mutation_allowed: true,
        raw_config: null,
        effective_config: templateConfig,
        raw_config_hash: null,
        effective_config_hash: computeStableHash(templateConfig),
        defaults_profile: templateDefaultsProfile,
        inherited_paths: [],
        lock_verification: null,
      };
  }
  let configValidationError = null;
  let selectedConfig;
  try {
    selectedConfig = validateSdlcConfig(configState.effective_config);
  } catch (error) {
    configValidationError = [configResolutionError, error.message].filter(Boolean).join("; ");
    const fallbackConfig = rawProjectConfig
      ? mergeMissingConfigDefaults(rawProjectConfig, legacyConfig || templateConfig)
      : templateConfig;
    try {
      selectedConfig = validateSdlcConfig(fallbackConfig);
    } catch {
      selectedConfig = templateConfig;
    }
    configState = {
      ...configState,
      status: "invalid",
      migration_required: true,
      mutation_allowed: false,
    };
  }
  if (!configValidationError && configResolutionError) {
    configValidationError = configResolutionError;
  }
  return {
    root,
    sdlcRoot: path.join(root, SDLC_DIR),
    templateDir,
    templateDirIdentity: templateDirectory.identity,
    bundledTemplateDir: bundledTemplateDirectory.path,
    bundledTemplateDirIdentity: bundledTemplateDirectory.identity,
    config: selectedConfig,
    templateConfig,
    legacyConfig,
    projectConfigPath,
    configLockPath,
    rawProjectConfig,
    projectConfigLock,
    projectConfigSnapshotHash,
    projectConfigLockSnapshotHash,
    configState,
    configValidationError,
    legacyDefaultsProfile,
    templateDefaultsProfile,
  };
}

export function missingProjectConfigMessage(defaultsSource = null) {
  const target = `${SDLC_DIR}/${PROJECT_CONFIG_FILE_NAME}`;
  return `The project configuration ${target} is missing, but this project is initialized `
    + `(${SDLC_DIR}/project.json or ${SDLC_DIR}/${PROJECT_CONFIG_LOCK_FILE_NAME} exists). `
    + "Commands that read or write project history are blocked so that the project's privacy (redaction) rules "
    + "and other agreed policies are not silently replaced by the defaults; `trace verify` still works. "
    + (defaultsSource
      ? `The confirmed configuration lock matches the bundled defaults exactly, so the missing file held only defaults: `
        + `restore it by copying ${JSON.stringify(defaultsSource)} to ${target} `
        + `(for example: cp ${JSON.stringify(defaultsSource)} ${target}), then run agentic-sdlc doctor.`
      : `Restore ${target} from version control (for example: git checkout -- ${target}), then retry.`);
}

export function missingProjectConfigGuidance(defaultsSource = null) {
  const target = `${SDLC_DIR}/${PROJECT_CONFIG_FILE_NAME}`;
  return {
    en: {
      result: "The project's saved rules are missing, so this command did not run.",
      impact: "Nothing was read or changed: without the saved rules, private details could be shown or recorded under the default rules instead of the agreed ones.",
      required_decision: "You do not need to approve anything; restore the missing rules file first.",
      protection_boundary: "Project history, files, remote repositories, and releases remain unchanged.",
      next_action: defaultsSource
        ? `The saved rules were the bundled defaults: copy them back to ${target} with the command in the technical details, then run the command again.`
        : `Restore ${target} from version control, then run the command again.`,
    },
    it: {
      result: "Le regole salvate del progetto mancano, quindi questo comando non è stato eseguito.",
      impact: "Nulla è stato letto o modificato: senza le regole salvate, dati riservati potrebbero essere mostrati o registrati con le regole predefinite invece di quelle concordate.",
      required_decision: "Non devi approvare nulla; ripristina prima il file delle regole mancante.",
      protection_boundary: "Cronologia del progetto, file, repository remoti e rilasci restano invariati.",
      next_action: defaultsSource
        ? `Le regole salvate erano quelle predefinite: ricopiale in ${target} con il comando nei dettagli tecnici, poi esegui di nuovo il comando.`
        : `Ripristina ${target} dal controllo di versione, poi esegui di nuovo il comando.`,
    },
  };
}

export function validateRecordSchema(record, schemaName) {
  const schemaPath = path.join(PLUGIN_ROOT, "schemas", schemaName);
  if (!fs.existsSync(schemaPath)) {
    return { valid: true, errors: [] };
  }
  return validateAgainstSchema(record, schemaName, { schemaDir: path.dirname(schemaPath) });
}

export function assertRecordSchema(record, schemaName, label) {
  const result = validateRecordSchema(record, schemaName);
  if (!result.valid) {
    fail(formatSchemaErrors(label, result.errors));
  }
  return record;
}

export function appendRecordSchemaIssues(report, record, schemaName, label) {
  const result = validateRecordSchema(record, schemaName);
  for (const error of result.errors || []) {
    report.errors.push(`${label} schema: ${error.instance_path || "$"} ${error.message}`);
  }
  return result.valid;
}

export function prepareExecutionContextPreflight(context, decision, attribution, options = {}) {
  const story = readStory(context, decision.story_id);
  const contract = readContractById(context, decision.contract_id);
  const deliveryProfile = readDeliveryAutonomyProfile(context, decision.delivery_profile_id);
  if (!story || contract?.story_id !== story.id) {
    fail("Execution context preflight requires one current story and its exact approved work brief.");
  }
  if (
    deliveryProfile.story_refs?.length !== 1
    || deliveryProfile.story_refs[0].id !== story.id
    || deliveryProfile.contract_refs?.length !== 1
    || deliveryProfile.contract_refs[0].id !== contract.id
  ) {
    fail("Execution context preflight requires one delivery profile bound to the exact story and work brief.");
  }
  const requirementProfiles = deliveryProfile.requirement_profile_refs.map((ref) => {
    const profile = readRequirementAutonomyProfile(context, ref.id);
    if (profile.profile_hash !== ref.hash || profile.status !== "active") {
      fail(`Execution context preflight found stale requirement scope ${ref.id}.`);
    }
    return profile;
  });
  const sourceInputs = [];
  const addSources = (kind, id, recordPath, sourcePaths, sourceHashes) => {
    for (const sourcePathRaw of sourcePaths || []) {
      const sourcePath = normalizeProjectPathInput(sourcePathRaw);
      const expectedSha256 = sourceHashes?.[sourcePath] || null;
      if (!expectedSha256) {
        fail(`Execution context preflight cannot bind ${kind} ${id} source ${sourcePath}: its approved hash is missing.`);
      }
      const snapshot = stableContextSourceSnapshot(context, sourcePath, "Execution context source");
      const currentSha256 = snapshot.sha256;
      if (currentSha256 !== expectedSha256) {
        fail(
          `Execution context changed before task start: ${sourcePath} no longer matches approved ${kind} ${id}. `
          + "Restore the reviewed file, or create and approve a new immutable revision before rerunning task preflight.",
        );
      }
      sourceInputs.push({
        path: snapshot.projectPath,
        sha256: currentSha256,
        file_type: snapshot.file_type,
        mode: snapshot.mode,
        binding: {
          kind,
          id,
          record_path: toProjectPath(context, recordPath),
          expected_sha256: expectedSha256,
        },
      });
    }
  };

  for (const baseline of selectActiveBaselines(context, story.id)) {
    addSources(
      "baseline",
      baseline.id,
      baselinePathById(context, baseline.id),
      baseline.source_paths || Object.keys(baseline.source_hashes || {}),
      baseline.source_hashes || {},
    );
  }
  for (const requirementId of story.links?.requirements || []) {
    const requirement = readRequirement(context, requirementId);
    addSources(
      "requirement",
      requirement.id,
      requirementPath(context, requirement.id),
      requirement.source_paths || Object.keys(requirement.source_hashes || {}),
      requirement.source_hashes || {},
    );
  }
  for (const recommendationRef of contract.capability_recommendation_refs || []) {
    const recommendation = readProjectJson(
      context,
      capabilityRecommendationPath(context, recommendationRef.id),
    );
    addSources(
      "capability_recommendation",
      recommendation.id,
      capabilityRecommendationPath(context, recommendation.id),
      recommendation.source_paths || Object.keys(recommendation.source_hashes || {}),
      recommendation.source_hashes || {},
    );
    const profile = readCapabilityProfile(context, recommendation.profile_id);
    addSources(
      "capability_profile",
      profile.id,
      capabilityProfilePath(context, profile.id),
      profile.source_paths || Object.keys(profile.source_hashes || {}),
      profile.source_hashes || {},
    );
  }
  for (const source of contract.contextualization?.context_sources || []) {
    const sourcePath = normalizeProjectPathInput(source?.path || source);
    const expectedSha256 = source?.sha256 || null;
    addSources(
      "contract_context",
      contract.id,
      path.join(context.sdlcRoot, "contracts", `${contract.id}.json`),
      [sourcePath],
      expectedSha256 ? { [sourcePath]: expectedSha256 } : {},
    );
  }

  const headSha = execGit(context.root, ["rev-parse", "--verify", "HEAD"]);
  // A repository without its first commit starts from Git's empty tree; any
  // other missing or malformed HEAD stays unverifiable.
  const unbornBase = headSha ? null : currentUnbornGitBase(context.root);
  if (!unbornBase && (!headSha || !/^[a-f0-9]{40,64}$/iu.test(headSha))) {
    fail("Execution context preflight requires a verifiable Git HEAD before task start.");
  }
  const receipt = buildDomainRecord("Cannot seal execution context preflight", () =>
    buildExecutionContextPreflightReceipt({
      id: `PREFLIGHT-${deliveryProfile.id}`,
      story_ref: {
        id: story.id,
        path: path.posix.join(SDLC_DIR, "stories", story.id, "story.json"),
        hash: hashApprovalSubject(story),
      },
      contract_ref: {
        id: contract.id,
        path: path.posix.join(SDLC_DIR, "contracts", `${contract.id}.json`),
        hash: hashApprovalSubject(contract),
      },
      delivery_profile_ref: {
        id: deliveryProfile.id,
        path: toProjectPath(context, deliveryAutonomyPath(context, deliveryProfile.id)),
        hash: deliveryProfile.profile_hash,
      },
      requirement_scopes: requirementProfiles.map((profile) => ({
        profile_ref: {
          id: profile.id,
          path: toProjectPath(context, requirementAutonomyPath(context, profile.id)),
          hash: profile.profile_hash,
        },
        allowed_write_paths: normalizePreflightWritePaths(
          context,
          profile.constraints?.allowed_write_paths || [],
        ),
      })),
      sources: sourceInputs,
      workspace_changes: currentWorkspaceChanges(context),
      git_head_sha: unbornBase ? null : headSha,
      ...(unbornBase ? { git_base_tree: unbornBase.base_tree } : {}),
      created_by: attribution.actor,
      created_at: now(),
      audit: { git: attribution.git, run: attribution.run },
    }));
  assertRecordSchema(
    receipt,
    "execution-context-preflight-receipt.schema.json",
    `Execution context preflight ${receipt.id}`,
  );
  const filePath = executionContextPreflightPath(context, deliveryProfile.id);
  const relativePath = toProjectPath(context, filePath);
  if (options.persist !== true) {
    return { receipt, filePath, relativePath, created: false };
  }
  revalidateExecutionContextPreflightSnapshot(context, receipt);
  if (fs.existsSync(filePath)) {
    const existing = readProjectJson(context, filePath);
    const integrity = validateExecutionContextPreflightReceipt(existing, {
      story_ref: receipt.story_ref,
      contract_ref: receipt.contract_ref,
      delivery_profile_ref: receipt.delivery_profile_ref,
    });
    if (!integrity.valid) {
      fail(`Existing execution context preflight ${relativePath} is invalid: ${integrity.errors.join("; ")}`);
    }
    if (
      existing.git_head_sha !== receipt.git_head_sha
      || (existing.git_base_tree ?? null) !== (receipt.git_base_tree ?? null)
      || stableJson(existing.workspace_changes) !== stableJson(receipt.workspace_changes)
    ) {
      fail(
        `Incomplete task-start recovery refused: Git HEAD or the dirty workspace changed after orphan preflight ${relativePath}. `
        + "Restore the exact preflight state or discard it through the governed recovery flow, then rerun task preflight.",
      );
    }
    revalidateExecutionContextPreflightSnapshot(context, existing);
    return { receipt: existing, filePath, relativePath, created: false };
  }
  writeJsonFile(filePath, receipt, { atomicCreate: true });
  try {
    revalidateExecutionContextPreflightSnapshot(context, receipt);
  } catch (error) {
    removePathGoverned(filePath, { force: true });
    throw error;
  }
  return { receipt, filePath, relativePath, created: true };
}

export function currentWorkspaceChanges(context) {
  const beforeEntries = readExactGitWorkspaceStatus(context);
  const firstSnapshot = beforeEntries.map((entry) => stableWorkspacePathSnapshot(context, entry));
  const afterEntries = readExactGitWorkspaceStatus(context);
  if (stableJson(beforeEntries) !== stableJson(afterEntries)) {
    fail("Git workspace status changed while execution context was being snapshotted; retry after filesystem activity settles.");
  }
  const secondSnapshot = afterEntries.map((entry) => stableWorkspacePathSnapshot(context, entry));
  if (stableJson(firstSnapshot) !== stableJson(secondSnapshot)) {
    fail("Git workspace file identity changed while execution context was being snapshotted; retry after filesystem activity settles.");
  }
  return secondSnapshot.sort((left, right) => (
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  ));
}

export function revalidateExecutionContextPreflightSnapshot(context, receipt) {
  const sourceSnapshots = (receipt.source_snapshots || []).map((source) => {
    const current = stableContextSourceSnapshot(context, source.path, "Execution context source");
    return {
      path: current.projectPath,
      sha256: current.sha256,
      file_type: current.file_type,
      mode: current.mode,
    };
  });
  const currentHeadSha = execGit(context.root, ["rev-parse", "--verify", "HEAD"]);
  const currentUnbornBase = currentHeadSha ? null : currentUnbornGitBase(context.root);
  const current = {
    git_head_sha: currentHeadSha || null,
    ...(currentUnbornBase ? { git_base_tree: currentUnbornBase.base_tree } : {}),
    source_snapshots: sourceSnapshots,
    workspace_changes: currentWorkspaceChanges(context),
  };
  const decision = executionContextSnapshotRevalidationDecision(receipt, current);
  if (!decision.valid) {
    fail(
      `Execution context changed while task start was being sealed: ${decision.errors.join("; ")}. `
      + "No mutable-context authority was created; retry after restoring a stable reviewed state.",
    );
  }
  return true;
}

export function readStartedExecutionContextPreflight(context, {
  storyId,
  contractId,
  profileId,
} = {}) {
  const errors = [];
  if (!storyId || !contractId || !profileId) {
    return { receipt: null, errors: ["execution context identity is incomplete"] };
  }
  const story = readStory(context, storyId);
  const contract = readContractById(context, contractId, { missingOk: true });
  let profile = null;
  try {
    profile = readDeliveryAutonomyProfile(context, profileId, { missingOk: true });
  } catch (error) {
    errors.push(`delivery profile cannot be verified: ${error.message}`);
  }
  if (!story || !contract || !profile) {
    return { receipt: null, errors: [...errors, "story, work brief, or delivery profile is missing"] };
  }
  const taskStartPath = path.join(context.sdlcRoot, "stories", storyId, "task-start.json");
  if (!fs.existsSync(taskStartPath)) {
    return { receipt: null, errors: ["confirmed task-start receipt is missing"] };
  }
  const taskStart = readProjectJson(context, taskStartPath);
  const preflightRef = taskStart.execution_context_preflight_ref;
  if (!preflightRef?.path || !preflightRef?.hash || !preflightRef?.id) {
    return { receipt: null, errors: ["immutable pre-change execution context receipt is missing"] };
  }
  const expectedPath = executionContextPreflightPath(context, profileId);
  let preflightPath;
  try {
    preflightPath = resolveProjectFilePath(context, preflightRef.path, { mustExist: true, fileOnly: true });
  } catch (error) {
    return { receipt: null, errors: [`execution context receipt cannot be read: ${error.message}`] };
  }
  if (path.resolve(preflightPath) !== path.resolve(expectedPath)) {
    errors.push("execution context receipt is outside the exact delivery execution directory");
  }
  const receipt = readProjectJson(context, preflightPath);
  const expectedRefs = {
    story_ref: {
      id: story.id,
      path: path.posix.join(SDLC_DIR, "stories", story.id, "story.json"),
      hash: hashApprovalSubject(story),
    },
    contract_ref: {
      id: contract.id,
      path: path.posix.join(SDLC_DIR, "contracts", `${contract.id}.json`),
      hash: hashApprovalSubject(contract),
    },
    delivery_profile_ref: {
      id: profile.id,
      path: toProjectPath(context, deliveryAutonomyPath(context, profile.id)),
      hash: profile.profile_hash,
    },
  };
  const integrity = validateExecutionContextPreflightReceipt(receipt, expectedRefs);
  errors.push(...integrity.errors);
  if (preflightRef.id !== receipt.id || preflightRef.hash !== receipt.receipt_hash) {
    errors.push("task-start receipt does not bind the exact execution context preflight");
  }
  if (
    taskStart.status !== "confirmed"
    || taskStart.story_id !== storyId
    || taskStart.contract_id !== contractId
    || taskStart.delivery_profile_ref?.id !== profileId
    || taskStart.delivery_profile_ref?.hash !== profile.profile_hash
  ) {
    errors.push("execution context preflight is not attached to this exact confirmed task start");
  }
  const executionState = currentDeliveryExecutionState(context, profile);
  if (
    !executionState.start_receipt
    || taskStart.delivery_start_receipt_ref?.id !== executionState.start_receipt.id
    || taskStart.delivery_start_receipt_ref?.hash !== executionState.start_receipt.receipt_hash
  ) {
    errors.push("execution context preflight has no matching immutable delivery start");
  }
  const preflightTime = Date.parse(receipt.created_at || "");
  const taskStartTime = Date.parse(taskStart.confirmed_at || "");
  if (
    !Number.isFinite(preflightTime)
    || !Number.isFinite(taskStartTime)
    || preflightTime > taskStartTime
  ) {
    errors.push("execution context preflight was not sealed before task confirmation");
  }
  const startBase = taskStartGitBase(taskStart);
  if (
    startBase.kind === "none"
    || (startBase.kind === "commit" && receipt.git_head_sha !== startBase.sha)
    || (
      startBase.kind === "unborn"
      && (receipt.git_head_sha !== null || receipt.git_base_tree !== startBase.tree)
    )
  ) {
    errors.push("execution context preflight and task start use different Git baselines");
  }
  const expectedRequirementScopes = profile.requirement_profile_refs.map((ref) => {
    const current = readRequirementAutonomyProfile(context, ref.id);
    return {
      profile_ref: {
        id: current.id,
        path: toProjectPath(context, requirementAutonomyPath(context, current.id)),
        hash: current.profile_hash,
      },
      allowed_write_paths: normalizePreflightWritePaths(
        context,
        current.constraints?.allowed_write_paths || [],
      ),
    };
  }).sort((left, right) => left.profile_ref.id.localeCompare(right.profile_ref.id));
  if (stableJson(receipt.requirement_scopes) !== stableJson(expectedRequirementScopes)) {
    errors.push("execution context preflight no longer matches the approved requirement write scopes");
  }
  return { receipt: errors.length === 0 ? receipt : null, errors };
}

export function executionContextSourceEvolution(context, {
  storyId,
  contractId,
  profileId,
  sourcePath,
  expectedSha256,
  bindingKind,
  bindingId,
} = {}) {
  const started = readStartedExecutionContextPreflight(context, {
    storyId,
    contractId,
    profileId,
  });
  if (!started.receipt) {
    return {
      allowed: false,
      reason: "preflight_unavailable",
      errors: started.errors,
    };
  }
  return executionContextSourceEvolutionDecision(started.receipt, {
    story_ref: started.receipt.story_ref,
    contract_ref: started.receipt.contract_ref,
    delivery_profile_ref: started.receipt.delivery_profile_ref,
    path: normalizeProjectPathInput(sourcePath),
    expected_sha256: expectedSha256,
    binding_kind: bindingKind,
    binding_id: bindingId,
  });
}

export async function runDoctor(context, options) {
  const checks = [];
  const add = (id, status, details) => checks.push({ id, status, details });
  const nodeVersion = process.versions.node;
  add(
    "node-runtime",
    isSupportedNodeRuntime(nodeVersion) ? "passed" : "failed",
    `Node ${nodeVersion}; requires ${NODE_RUNTIME_REQUIREMENT} (${NODE_ENGINE_RANGE})`,
  );

  const packagePath = path.join(PLUGIN_ROOT, "package.json");
  const manifestPath = path.join(PLUGIN_ROOT, ".codex-plugin", "plugin.json");
  try {
    const pkg = readJson(packagePath);
    const manifest = readJson(manifestPath);
    const metadataConsistent = pkg.version === VERSION
      && manifest.version === VERSION
      && pkg.engines?.node === NODE_ENGINE_RANGE;
    add(
      "version-consistency",
      metadataConsistent ? "passed" : "failed",
      `CLI ${VERSION}, package ${pkg.version}, manifest ${manifest.version}, Node engines ${pkg.engines?.node || "missing"}`,
    );
    const firstPrompt = Array.isArray(manifest.interface?.defaultPrompt) ? manifest.interface.defaultPrompt[0] : manifest.interface?.defaultPrompt;
    add(
      "assessment-entry-point",
      firstPrompt === "Contextualize this project and prepare an initial technical assessment." ? "passed" : "failed",
      firstPrompt || "missing first starter prompt",
    );
  } catch (error) {
    add("plugin-metadata", "failed", error.message);
  }

  try {
    const identity = inspectBuildIdentity(PLUGIN_ROOT);
    const versionMatches = identity.package_version === VERSION;
    const fingerprintValid = /^[a-f0-9]{64}$/u.test(identity.build_fingerprint);
    const sourceState = typeof identity.git_dirty === "boolean"
      ? `, source ${identity.git_dirty ? "dirty" : "clean"}`
      : "";
    const provenanceState = identity.provenance
      ? `, provenance ${identity.provenance}`
      : ", provenance not embedded (allowed for source checkouts and generic npm installs)";
    add(
      "build-identity",
      versionMatches && fingerprintValid ? "passed" : "failed",
      `package ${identity.package_version}, fingerprint ${identity.build_fingerprint || "missing"}${sourceState}${provenanceState}`,
    );
  } catch (error) {
    add("build-identity", "failed", error.message);
  }

  const configGuidance = configStatusGuidance(context, humanGuidanceLocale(options));
  const configRecovery = configStatusCommand(context.configState.status);
  add(
    "effective-config",
    context.configState.status === "locked"
      ? "passed"
      : ["drifted", "invalid", "missing"].includes(context.configState.status)
        ? "failed"
        : "not_applicable",
    (context.configState.status === "missing" ? [] : [
      configGuidance.result,
      configGuidance.next_action,
    ]).concat([
      ...(configRecovery ? [`${configRecovery.label}: ${configRecovery.command}`] : []),
      ...(context.configValidationError ? [`Config validation: ${context.configValidationError}`] : []),
    ]).join(" "),
  );

  for (const [id, relativePath] of [
    ["core-skill", "skills/agentic-sdlc/SKILL.md"],
    ["assessment-skill", "skills/agentic-sdlc-assessment/SKILL.md"],
    ["assessment-agent-card", "skills/agentic-sdlc-assessment/agents/openai.yaml"],
    ["assessment-preset", "templates/technical-assessment.md"],
    ["rtk-optimization-adapter", "lib/rtk-optimization-adapter.mjs"],
    ["caveman-response-skill", "skills/caveman/SKILL.md"],
    ["caveman-agent-card", "skills/caveman/agents/openai.yaml"],
    ["codex-session-metering-adapter", "lib/codex-session-metering-adapter.mjs"],
    ["token-efficiency-autoconfiguration", "scripts/autoconfigure-token-efficiency.py"],
    ["context-optimization-domain", "lib/context-optimization.mjs"],
    ["context-optimization-schema", "schemas/context-optimization-observation.schema.json"],
    ["project-bootstrap-manifest-schema", "schemas/project-bootstrap-manifest.schema.json"],
    ["project-bootstrap-journal-schema", "schemas/project-bootstrap-journal.schema.json"],
    ["observatory-entry-point", "lib/change-observatory/index.mjs"],
    ["observatory-launcher", "lib/change-observatory/cli.mjs"],
    ["observatory-skill", "skills/change-observatory/SKILL.md"],
    ["observatory-agent-card", "skills/change-observatory/agents/openai.yaml"],
    ["observatory-ui", "ui/change-observatory/index.html"],
    ["observatory-ui-app", "ui/change-observatory/app.js"],
    ["observatory-ui-style", "ui/change-observatory/styles.css"],
  ]) {
    const filePath = path.join(PLUGIN_ROOT, relativePath);
    add(id, fs.existsSync(filePath) && fs.statSync(filePath).isFile() ? "passed" : "failed", relativePath);
  }

  const optimizationPolicy = readContextOptimizationPolicy(context);
  add(
    "caveman-response-provider",
    optimizationPolicy.response_provider.mode === "disabled"
      ? "not_applicable"
      : (
          optimizationPolicy.response_provider.id === "caveman"
          && optimizationPolicy.response_provider.version === "1.9.1"
          && optimizationPolicy.response_provider.usage_accounting === "measured_net_usage_only"
        )
        ? "passed"
        : "failed",
    optimizationPolicy.response_provider.mode === "disabled"
      ? "Response compression is disabled by policy."
      : `Caveman ${optimizationPolicy.response_provider.version} ${optimizationPolicy.response_provider.mode}; budget limits use measured net usage only`,
  );
  if (!optimizationPolicy.enabled || optimizationPolicy.mode === "disabled") {
    add("rtk-optimization-provider", "not_applicable", "Context optimization is disabled by policy.");
  } else {
    const telemetry = await verifyConfiguredRtk(context, contextOptimizationRuntimeOptions(options));
    const detection = telemetry.detection;
    const required = optimizationPolicy.fallback === "error";
    const operational = telemetry.status === "operational";
    const status = operational ? "passed" : required ? "failed" : "not_applicable";
    add(
      "rtk-optimization-provider",
      status,
      operational
        ? `RTK ${detection.version}; automatic provider and gain contract are operational`
        : detection?.available
          ? `RTK ${detection.version || "unknown"} failed provider validation (${telemetry.reason || detection.reason || telemetry.status})`
          : `RTK unavailable (${detection?.reason || telemetry.reason || telemetry.status}); native fallback remains enabled`,
    );
  }

  if (fs.existsSync(context.sdlcRoot)) {
    const projectRecord = isKbInitialized(context) ? inspectProjectRecord(context) : null;
    add(
      "project-kb",
      projectRecord?.valid ? "passed" : "failed",
      projectRecord ? projectRecord.message : `${SDLC_DIR} exists without project.json`,
    );
    let registry = null;
    let registryError = null;
    try {
      registry = readOutputRegistry(context, { missingOk: true });
    } catch (error) {
      if (!(error instanceof UserError)) throw error;
      registryError = error.message;
    }
    add("output-registry", registry ? "passed" : "failed", registry ? `${SDLC_DIR}/output-contracts/registry.json` : registryError || "missing output registry");
    if (projectRecord?.valid) {
      const history = inspectTraceHistory(context);
      const pathsIn = (state) => history.files
        .filter((file) => file.state === state)
        .map((file) => `${file.path} (${file.errors.map((issue) => issue.code).join(", ") || "invalid"})`)
        .join(", ");
      add(
        "trace-integrity",
        history.status === "violated" ? "failed" : history.files_checked === 0 ? "not_applicable" : "passed",
        history.status === "violated"
          ? `History changed unexpectedly in ${pathsIn("violated")}. ${traceIntegrityRecoveryText(false)}`
          : history.status === "recovery_needed"
            ? `Interrupted write in ${pathsIn("recoverable")}. ${traceRecoveryNeededText(false)}`
            : history.status === "unverifiable"
              ? `Too large to verify: ${pathsIn("unverifiable")}. ${traceUnverifiableText(false)}`
              : history.files_checked === 0
                ? "No history recorded yet."
                : `${history.files_checked} history file(s) match their recorded fingerprints (local tamper evidence, not proof of authenticity).`,
      );
      if (["recovery_needed", "unverifiable"].includes(history.status)) {
        checks.at(-1).warning = true;
      }
      const sizeWarnings = traceSizeWarningLines(history, false);
      add(
        "trace-size",
        history.files.some((file) => file.size_state === "over_limit") ? "failed" : "passed",
        sizeWarnings.length > 0
          ? sizeWarnings.join(" ")
          : `Every history file is below ${Math.round(TRACE_SIZE_WARNING_RATIO * 100)}% of the ${formatTraceSizeMiB(TRACE_HISTORY_READ_LIMIT_BYTES)} read limit.`,
      );
      if (sizeWarnings.length > 0 && !history.files.some((file) => file.size_state === "over_limit")) {
        checks.at(-1).warning = true;
      }
    }
  } else {
    add("project-kb", "not_applicable", `No ${SDLC_DIR} directory at ${context.root}`);
  }

  const failed = checks.filter((check) => check.status === "failed");
  const payload = {
    status: failed.length === 0 ? "passed" : "failed",
    plugin_root: PLUGIN_ROOT,
    project_root: context.root,
    version: VERSION,
    checks,
  };
  const italian = humanGuidanceLocale(options) === "it";
  const passed = failed.length === 0;
  const guidance = {
    result: passed
      ? (italian ? "Tutti i controlli di salute disponibili sono riusciti." : "All available health checks passed.")
      : (italian ? "Alcuni controlli di salute hanno trovato un problema." : "Some health checks found a problem."),
    impact: passed
      ? (italian ? "Gli strumenti locali e i dati del progetto controllati qui sono pronti per il normale utilizzo." : "The local tools and project data checked here are ready for normal use.")
      : (italian ? "Una funzione che dipende dal controllo non riuscito potrebbe non funzionare correttamente." : "A feature that depends on the failed check may not work correctly."),
    required_decision: passed
      ? (italian ? "Non devi decidere nulla in base a questi controlli." : "You do not need to decide anything based on these checks.")
      : (italian ? "Non approvare attività che dipendono dal controllo non riuscito finché il problema non è corretto." : "Do not approve work that depends on the failed check until the problem is corrected."),
    protection_boundary: italian
      ? "La diagnosi ha soltanto letto lo stato locale; non ha modificato file, pubblicato, rilasciato, distribuito o eseguito merge."
      : "The diagnosis only read local state; it did not change files, publish, release, deploy, or merge anything.",
    next_action: passed
      ? (italian ? "Puoi continuare con il prossimo passo già concordato." : "You can continue with the next step already agreed.")
      : (italian ? "Correggi il primo controllo non riuscito nei dettagli facoltativi, poi ripeti la diagnosi." : "Correct the first failed check in the optional details, then run the diagnosis again."),
    details: { status: payload.status, failed_checks: failed.map((check) => check.id) },
  };
  payload.human_guidance = guidance;
  if (failed.length > 0) {
    process.exitCode = 1;
  }
  output(options, payload, humanGuidanceLines(guidance, [
    `Agentic SDLC doctor: ${payload.status}`,
    ...checks.map((check) => `${check.warning ? "WARN" : check.status === "passed" ? "PASS" : check.status === "not_applicable" ? "N/A" : "FAIL"} ${check.id}: ${check.details}`),
  ], options));
}

export async function runOptimizedCommand(context, options) {
  if (options.json) fail("optimization run streams child output and does not support --json");
  const raw = requireOption(options, "command-json");
  let command;
  try {
    command = JSON.parse(raw);
  } catch (error) {
    fail(`--command-json must be valid JSON: ${error.message}`);
  }
  let route;
  try {
    route = routeRtkCommand(command, {
      profile: getOptionString(options, "profile") || "auto",
      exact: options.exact === true,
      cwd: context.root,
    });
  } catch (error) {
    fail(error.message);
  }
  let executable;
  let argv;
  let nativeFallback = null;
  if (route.mode === "native") {
    executable = route.execution_command[0];
    argv = route.execution_command.slice(1);
  } else {
    const policy = readContextOptimizationPolicy(context);
    if (!policy.enabled || policy.mode === "disabled") {
      executable = route.execution_command[0];
      argv = route.execution_command.slice(1);
    } else {
      const releaseDetectionGate = acquireOptimizationRunBudgetGate(context, options);
      releaseDetectionGate();
      const detection = await detectConfiguredRtk(context, contextOptimizationRuntimeOptions(options));
      const providerUsable = detection.available && detection.supported;
      if (!providerUsable && policy.fallback === "error") {
        fail(`RTK is required for optimization run but unavailable: ${detection.reason || "unsupported"}`);
      }
      executable = providerUsable ? detection.executable : route.execution_command[0];
      argv = providerUsable
        ? [...policy.provider.command.arguments, ...route.rtk_arguments]
        : route.execution_command.slice(1);
      nativeFallback = providerUsable && policy.fallback === "native"
        ? route.execution_command
        : null;
    }
  }
  await executeOptimizationRunWithBudgetGate(context, options, {
    executable,
    argv,
    nativeFallback,
  });
}

export function finishSpawnedCommand(result, executable) {
  if (!result.started) {
    fail(`Cannot start command '${executable}': ${result.error?.message || "unknown error"}`);
  }
  if (result.signal) {
    process.exitCode = ({ SIGHUP: 129, SIGINT: 130, SIGQUIT: 131, SIGKILL: 137, SIGTERM: 143 })[result.signal] || 1;
    return;
  }
  process.exitCode = result.exit_code;
}

export function spawnCommandWithoutShell(executable, argv, cwd, options = {}) {
  return new Promise((resolve) => {
    let started = false;
    const child = childProcess.spawn(executable, argv, {
      cwd,
      stdio: "inherit",
      shell: false,
      windowsHide: true,
    });
    child.once("spawn", () => {
      started = true;
      options.onSpawn?.();
    });
    child.once("error", (error) => resolve({ started: false, exit_code: null, signal: null, error }));
    child.once("close", (exitCode, signal) => resolve({ started, exit_code: exitCode ?? 1, signal, error: null }));
  });
}

export function validatePullRequestMergeRuntimeTransition(context, authorization, runtimeTarget, completionProof) {
  const errors = [];
  const authorizedRuntime = authorization?.runtime_target;
  const merge = authorization?.action_details?.merge;
  const providerPrecondition = authorization?.action_details?.provider_operation?.precondition_receipt;
  const authorizedBaseSha = authorizedRuntime?.base_sha;
  const observedBaseSha = runtimeTarget?.base_sha;
  const sourceSha = merge?.source_sha;
  const mergeCommitSha = completionProof?.merge_commit_sha;
  const exactGitOid = (value) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value || "");

  if (
    stableJson(gitRuntimeWithoutBaseSha(authorizedRuntime))
      !== stableJson(gitRuntimeWithoutBaseSha(runtimeTarget))
  ) {
    errors.push("the Git branch, source SHA, base ref, remote set, or remote identity changed after authorization");
  }
  if (
    ![authorizedBaseSha, observedBaseSha, sourceSha, mergeCommitSha].every(exactGitOid)
    || runtimeTarget?.head_sha !== sourceSha
  ) {
    errors.push("the merge runtime does not preserve its exact authorized base and source SHAs");
  }
  const providerSubject = providerPrecondition?.subject;
  const providerProof = providerPrecondition?.proof;
  const hasBaseBinding = [merge?.base_sha, providerSubject?.base_sha, providerProof?.base_sha]
    .some((value) => value !== undefined);
  if (hasBaseBinding && (
    merge?.base_sha !== authorizedBaseSha
    || providerSubject?.base_sha !== authorizedBaseSha
    || providerProof?.base_sha !== authorizedBaseSha
  )) {
    errors.push("the merge authorization does not cross-bind its runtime, action, provider subject, and open-PR base SHA");
  }
  if (completionProof?.base_sha !== undefined && completionProof.base_sha !== authorizedBaseSha) {
    errors.push("the merged PR proof reports a different base SHA from the authorization");
  }
  if (errors.length > 0) return { valid: false, mode: null, errors };

  if (observedBaseSha === authorizedBaseSha) {
    return { valid: true, mode: "base-tracking-stale", errors: [] };
  }

  if (
    !hasBaseBinding
    || merge?.base_sha !== authorizedBaseSha
    || providerSubject?.base_sha !== authorizedBaseSha
    || providerProof?.base_sha !== authorizedBaseSha
    || completionProof?.base_sha !== authorizedBaseSha
  ) {
    errors.push("the advanced base is not bound to the exact GitHub base SHA observed at authorization and completion");
  }
  if (!mergeCommitSha || observedBaseSha !== mergeCommitSha) {
    errors.push("the local base tracking ref does not point to the exact merge result proven by GitHub");
  }
  if (errors.length > 0) return { valid: false, mode: null, errors };

  if (mergeCommitSha === sourceSha) {
    if (execGit(context.root, ["merge-base", authorizedBaseSha, sourceSha]) !== authorizedBaseSha) {
      errors.push("the proven fast-forward result is not descended from the authorized base SHA");
      return { valid: false, mode: null, errors };
    }
    return { valid: true, mode: "fast-forward", errors: [] };
  }

  const parentLine = execGit(context.root, ["rev-list", "--parents", "-n", "1", mergeCommitSha]);
  const commitAndParents = String(parentLine || "").split(/\s+/u).filter(Boolean);
  if (
    commitAndParents.length === 3
    && commitAndParents[0] === mergeCommitSha
    && commitAndParents[1] === authorizedBaseSha
    && commitAndParents[2] === sourceSha
  ) {
    return { valid: true, mode: "merge-commit", errors: [] };
  }
  if (
    commitAndParents.length === 2
    && commitAndParents[0] === mergeCommitSha
    && commitAndParents[1] === authorizedBaseSha
  ) {
    return { valid: true, mode: "squash", errors: [] };
  }

  errors.push("the exact GitHub merge result is neither a bounded fast-forward, merge commit, nor squash from the authorized base");
  return { valid: false, mode: null, errors };
}

export function passingDataOperationCandidates(context, profile, action, beforeReceipt = null) {
  const actions = deliveryActionReceipts(context, profile.id);
  return {
    actions,
    candidates: actions
      .filter((receipt) =>
        receipt.action === action
        && receipt.status === "completed"
        && receipt.outcome === "passed"
        && (!beforeReceipt || compareDeliveryAuthorizationOrder(receipt, beforeReceipt) < 0))
      .sort(compareDeliveryAuthorizationOrder),
  };
}

export function latestPassingDataOperation(context, profile, action, beforeReceipt = null) {
  const { actions, candidates } = passingDataOperationCandidates(
    context,
    profile,
    action,
    beforeReceipt,
  );
  const latest = candidates.at(-1) || null;
  const errors = latest
    ? dataOperationReceiptErrors(context, profile, latest, actions)
    : [`no completed passing ${action} receipt exists`];
  return {
    receipt: errors.length === 0 ? latest : null,
    errors,
  };
}

export function completedLocalTargetBuildDetails(
  context,
  profile,
  executionState,
  authorization,
  completedAt,
  outcome,
) {
  const state = localReleaseTargetGovernanceState(context, profile, executionState);
  const precondition = localTargetBuildPreconditionDetails(authorization);
  if (
    !precondition
    || stableJson(precondition.predecessor_ref) !== stableJson(state.ref)
    || !localTargetPredecessorStateMatches(state, precondition.snapshot)
  ) {
    fail(
      "build.local authorization no longer follows the exact local-target predecessor; "
      + "request a fresh build authorization.",
    );
  }
  const completionSnapshot = buildLocalReleaseTargetSnapshot(
    context,
    profile,
    "build_completion",
    completedAt,
  );
  if (
    outcome === "passed"
    && completionSnapshot.entries.some((entry) => entry.status !== "directory")
  ) {
    fail(
      "Passing build.local completion requires the exact target root and every approved "
      + "write path to exist as real directories.",
    );
  }
  const rootBefore = precondition.snapshot.entries[0];
  if (
    rootBefore.status === "directory"
    && stableJson(rootBefore) !== stableJson(completionSnapshot.entries[0])
  ) {
    fail("build.local cannot replace the governed target root identity.");
  }
  return {
    ...authorization.action_details,
    local_target_build_completion: {
      precondition_snapshot_hash: precondition.snapshot.snapshot_hash,
      snapshot: completionSnapshot,
      ...(outcome === "passed"
        ? { artifact_content: localReleaseTargetContentManifest(context, profile) }
        : {}),
    },
  };
}

export function localTargetMaterializationRefErrors(
  context,
  profile,
  executionState,
  authorization,
) {
  if (!executionState.start_receipt?.local_release_target_baseline) {
    return [];
  }
  const state = localReleaseProtectedTargetState(
    context,
    profile,
    executionState,
    {
      requireCurrentWorkspace: false,
      beforeReceipt: authorization,
    },
  );
  const errors = [...state.invalid];
  const targetHadAbsence = localReleaseTargetHadAbsentEntries(
    executionState.start_receipt.local_release_target_baseline,
  );
  if (
    targetHadAbsence
    && (
      state.ref.source !== "build.local"
      || state.materialized !== true
      || state.buildReceipt?.outcome !== "passed"
    )
  ) {
    errors.push("protected local action has no antecedent passing build.local for its absent-at-start root");
  }
  if (
    stableJson(authorization.action_details?.local_target_materialization_ref)
      !== stableJson(state.ref)
  ) {
    errors.push("protected local action does not reference its exact antecedent target materialization");
  }
  return errors;
}

export function codeBurnQuery(context, options, config, stored = null) {
  if (stored) {
    return stored;
  }
  const date = new Date().toISOString().slice(0, 10);
  return {
    provider: getOptionString(options, "provider") || config.provider || "codex",
    project: getOptionString(options, "project") || readProjectSafe(context)?.project_name || path.basename(context.root),
    from: getOptionString(options, "from") || date,
    to: getOptionString(options, "to") || getOptionString(options, "from") || date,
  };
}

export function codexSessionQuery(_context, options, _config, stored = null) {
  if (stored) return stored;
  const threadId = getOptionString(options, "thread-id") || process.env.CODEX_THREAD_ID;
  if (!threadId) {
    fail([
      "Codex session metering requires CODEX_THREAD_ID from the host or an explicit --thread-id.",
      "Inside a Codex task the host sets CODEX_THREAD_ID; outside one, pass the exact task id with --thread-id <id>.",
      "On a host that does not run Codex tasks there is no Codex session to read. Either:",
      "- enable the codeburn adapter with that host's log provider (budget_policy.metering_adapters.codeburn.enabled = true and .provider)",
      "  and use --adapter codeburn; or",
      "- record usage manually, for example: agentic-sdlc budget usage record --proposal <proposal-id> --input-tokens <n> --output-tokens <n>",
      "Manual and adapter observations are estimated; they drive soft limits and warnings, not hard limits.",
    ].join("\n"));
  }
  return { thread_id: threadId };
}

export function hashedFileReference(context, id, filePath, logicalHash = null) {
  return {
    id: normalizeId(id),
    path: toProjectPath(context, filePath),
    hash: logicalHash || hashFile(filePath),
  };
}

export function userVisibleReviewItems(request) {
  return (request.review_items || [])
    .map((item) => simplifyReviewItemForUser(request, item))
    .filter(Boolean);
}

export function simplifyReviewItemForUser(request, item) {
  const text = String(item || "").trim();
  if (!text) {
    return null;
  }
  if (/^Allowed tools:/.test(text)) {
    return `Tools and access being approved: ${text.replace(/^Allowed tools:\s*/, "")}`;
  }
  if (/^Template file:/.test(text)) {
    return `Template source: ${text.replace(/^Template file:\s*/, "")}`;
  }
  if (/^Template content to review:/.test(text)) {
    return `Proposed document structure: ${text.replace(/^Template content to review:\s*/, "")}`;
  }
  if (/^Decision scope:/.test(text)) {
    return `Decision scope: this only approves the document structure for ${humanOutputLabel(request.artifact_type || "this output")} work. It does not approve the final content.`;
  }
  if (/^(?:Assessment|Document) sections:/.test(text)) {
    const sections = text
      .replace(/^(?:Assessment|Document) sections:\s*/, "")
      .split(/\s*>\s*/)
      .filter((section) => section && !/-v\d+$/i.test(section));
    return `Document sections: ${sections.join(", ")}`;
  }
  if (/^Output type:/.test(text)) {
    return `Output: ${humanOutputLabel(text.replace(/^Output type:\s*/, ""))}`;
  }
  if (/^Story:/.test(text)) {
    return `Work item: ${text.replace(/^Story:\s*/, "")}`;
  }
  if (/^Purpose: Translate approved discovery output/.test(text)) {
    return "Goal: produce a clear technical assessment with architecture, boundaries, risks, and recommendations.";
  }
  if (/^Expected outputs:/.test(text)) {
    const outputs = text
      .replace(/^Expected outputs:\s*/, "")
      .split(/\s*,\s*/)
      .map((item) => humanOutputLabel(item.split(":")[0]))
      .filter(Boolean);
    return `Expected output: ${outputs.join(", ")}`;
  }
  if (/^Missing: missing project-specific context/.test(text)) {
    return "Missing: I need to know which project files, facts, constraints, or decisions should guide the work.";
  }
  if (/^Missing: missing agreed output format/.test(text)) {
    return "Missing: I need to know what output this work should produce.";
  }
  return text
    .replace(/--[A-Za-z0-9-]+(?:\s+[A-Za-z0-9:|<>\-]+)?/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function explainOpenQuestion(context, rawQuestion) {
  const record = typeof rawQuestion === "string" ? { question: rawQuestion } : rawQuestion || {};
  const question = String(record.question || record.prompt || "").trim();
  const policy = context.config.open_question_guidance || {};
  const categories = Array.isArray(policy.categories)
    ? policy.categories
    : Object.entries(policy.categories || {}).map(([id, category]) => ({ id, ...category }));
  const lower = question.toLowerCase();
  const matched = categories.find((category) =>
    normalizeListValue(category.keywords, []).some((keyword) => lower.includes(String(keyword).toLowerCase())),
  );
  const fallback = policy.fallback || {};
  const guidance = matched || fallback;
  const configuredExamples = record.example_answers || record.examples || guidance.example_answers;
  const examples = configuredExamples && typeof configuredExamples === "object" && !Array.isArray(configuredExamples)
    ? normalizeListValue(configuredExamples.it || configuredExamples.en, [])
    : normalizeListValue(configuredExamples, []);
  return {
    question,
    what_is_requested: record.what_is_requested || guidance.what_is_requested || "Provide the concrete fact or choice that removes this ambiguity.",
    why_needed: record.why_needed || guidance.why_needed || "Without this answer, different reasonable implementations could produce different scope, behavior, or output.",
    example_answers: examples.length
      ? examples
      : ["Indica l’opzione preferita e i limiti importanti; per esempio: «Usa l’API esistente, non aggiungere un nuovo servizio e mantieni la retrocompatibilità»."],
    effect_of_answer: record.effect_of_answer || guidance.effect_of_answer || "The answer will be written into the contract and become a testable execution boundary.",
  };
}

export function buildAttribution(context, options = {}, action = "unknown") {
  return {
    action,
    actor: buildActor(options, context.root),
    git: buildGitMetadata(context.root),
    run: buildRunMetadata(options),
    recorded_at: now(),
  };
}

export function buildActor(options = {}, root = process.cwd()) {
  const explicitActor = getOptionString(options, "actor");
  const commandAgent = getOptionString(options, "agent");
  const requestedActorType = getOptionString(options, "actor-type");
  const explicitActorType = requestedActorType ? normalizeActorType(requestedActorType) : null;
  const explicitActorName = getOptionString(options, "actor-name");
  const explicitActorEmail = getOptionString(options, "actor-email");
  const host = detectAgentHost();
  const envAgent = agentHostEnvValue(host, "agent_name");
  const envCiActor = process.env.CI ? process.env.GITHUB_ACTOR || "ci" : null;
  const actorType = explicitActorType || inferActorType(options, explicitActor || commandAgent || envAgent || envCiActor || host.id);
  const id =
    explicitActor ||
    commandAgent ||
    (actorType === "human" ? defaultHumanActorId(root) : null) ||
    (actorType === "ci" ? envCiActor || explicitActorName || "ci" : null) ||
    envAgent ||
    envCiActor ||
    host.id;
  const useGitIdentity = actorType === "human";
  const name =
    explicitActorName ||
    (actorType === "agent" && id === host.id ? host.name : null) ||
    (useGitIdentity ? process.env.GIT_AUTHOR_NAME || gitConfigValue(root, "user.name") : null) ||
    null;
  const email =
    explicitActorEmail ||
    (useGitIdentity ? process.env.GIT_AUTHOR_EMAIL || gitConfigValue(root, "user.email") : null) ||
    null;

  return {
    id,
    type: actorType,
    name,
    email,
    source: explicitActor || commandAgent || explicitActorType || explicitActorName || explicitActorEmail
      ? "cli"
      : envAgent || envCiActor || useGitIdentity || host.detected ? "environment" : "default",
  };
}

export function buildActorFromPrefixedOptions(options = {}, prefix, root = process.cwd(), defaults = {}) {
  const id = getOptionString(options, prefix);
  if (!id) {
    return null;
  }
  return {
    id,
    type: normalizeActorType(getOptionString(options, `${prefix}-type`) || defaults.type || "unknown"),
    name: getOptionString(options, `${prefix}-name`) || null,
    email: getOptionString(options, `${prefix}-email`) || null,
    source: getOptionString(options, `${prefix}-source`) || defaults.source || "cli",
  };
}

export function inferActorType(options = {}, actorId = "") {
  if (options.agent || agentHostEnvValue(detectAgentHost(), "agent_name") || namesAgentHost(actorId)) {
    return "agent";
  }
  if (process.env.GITHUB_ACTOR || process.env.CI) {
    return "ci";
  }
  if (process.env.USER) {
    return "human";
  }
  return "unknown";
}

export function buildRunMetadata(options = {}) {
  const host = detectAgentHost();
  return {
    run_id: getOptionString(options, "run-id") || agentHostEnvValue(host, "run_id"),
    thread_id: getOptionString(options, "thread-id") || agentHostEnvValue(host, "thread_id"),
    session_id: getOptionString(options, "session-id") || agentHostEnvValue(host, "session_id"),
    tool: "agentic-sdlc-cli",
    version: VERSION,
  };
}

export function buildContextSources(context, contextFiles) {
  return contextFiles.map((rawPath) => {
    const snapshot = stableContextSourceSnapshot(context, rawPath, "Contract context source");
    const resolved = snapshot.filePath;
    const content = snapshot.content;
    const text = content.toString("utf8");
    return {
      path: snapshot.projectPath,
      sha256: snapshot.sha256,
      size_bytes: content.length,
      excerpt: safeEvidenceExcerpt(resolved, text, 1200),
      trust: "untrusted_project_evidence",
    };
  });
}

export function createWorkItem(context, options) {
  ensureInitialized(context);
  ensurePlanningDirectories(context);
  const type = normalizeWorkItemType(requireOption(options, "type"));
  if (!WORK_ITEM_CREATE_TYPES.has(type)) {
    fail(`work item create supports only ${Array.from(WORK_ITEM_CREATE_TYPES).join(", ")} in this version.`);
  }
  const id = normalizeId(requireOption(options, "id"));
  const title = requireOption(options, "title");
  const requirementIds = normalizeListOption(options.requirement).map(normalizeId);
  for (const requirementId of requirementIds) {
    assertRequirementReadyForDownstream(
      context,
      readRequirement(context, requirementId, { missingOk: true }),
      `Requirement ${requirementId}`,
    );
  }
  const attribution = buildAttribution(context, options, "work_item.create");
  const item = {
    id,
    type,
    title,
    schema_version: context.config.schema_version,
    status: String(options.status || "draft"),
    parent_id: options.parent ? normalizeId(String(options.parent)) : null,
    story_id: options.story ? normalizeId(String(options.story)) : null,
    requirement_ids: requirementIds,
    acceptance: normalizeListOption(options.acceptance),
    acceptance_criteria: normalizeListOption(options.acceptance),
    created_at: now(),
    updated_at: now(),
    audit: {
      created_by: attribution.actor,
      updated_by: attribution.actor,
      git: attribution.git,
      run: attribution.run,
    },
  };
  assertRecordSchema(item, "work-item.schema.json", `Work item ${id}`);
  const itemPath = workItemPath(context, type, id);
  writeJsonFile(itemPath, item, { force: Boolean(options.force), forceOption: true });
  output(
    options,
    { status: "created", work_item_path: itemPath, work_item: item },
    [`Created ${type} ${id}`, `Path: ${toProjectPath(context, itemPath)}`],
  );
}

export function ensurePlanningDirectories(context) {
  ensureDir(workItemsRoot(context));
  ensureDir(path.join(workItemsRoot(context), "epics"));
  ensureDir(path.join(workItemsRoot(context), "tasks"));
  ensureDir(workBreakdownRoot(context));
  ensureDir(dependenciesRoot(context));
}

export function buildRepositorySnapshot(context, detectedStack = detectProjectStack(context)) {
  const keyFiles = collectProjectKeyFiles(context);
  return {
    root_name: path.basename(context.root),
    git: buildGitMetadata(context.root),
    detected_stack: detectedStack,
    key_files: keyFiles,
    package_scripts: readPackageScripts(context),
    package_summary: readPackageSummary(context),
    source_roots: inferSourceRoots(context),
    test_roots: inferTestRoots(context),
    ci_files: keyFiles.filter((item) => item.path.startsWith(".github/") || item.path.includes("ci") || item.path.includes("workflow")),
  };
}

export function readPackageSummary(context) {
  const packageJsonPath = path.join(context.root, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return null;
  }
  try {
    const pkg = readProjectJson(context, packageJsonPath);
    return {
      name: pkg.name || null,
      description: pkg.description || null,
      version: pkg.version || null,
      private: Boolean(pkg.private),
      runtime_dependencies: Object.keys(pkg.dependencies || {}).sort(),
      development_dependencies: Object.keys(pkg.devDependencies || {}).sort(),
    };
  } catch {
    return null;
  }
}

export function fileSummary(context, filePath) {
  return {
    path: toProjectPath(context, filePath),
    sha256: hashFile(filePath),
    size_bytes: fs.statSync(filePath).size,
  };
}

export function readPackageScripts(context) {
  const packageJsonPath = path.join(context.root, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return {};
  }
  try {
    const pkg = readProjectJson(context, packageJsonPath);
    return normalizeObject(pkg.scripts);
  } catch {
    return {};
  }
}

export function loadOptionalJsonInput(context, options, inlineKey, fileKey, label) {
  const inline = getOptionString(options, inlineKey);
  const file = getOptionString(options, fileKey);
  if (inline && file) {
    fail(`Use only one of --${inlineKey} or --${fileKey}.`);
  }
  if (!inline && !file) {
    return {};
  }
  try {
    if (file) {
      const filePath = resolveProjectFilePath(context, file, { mustExist: true, fileOnly: true });
      assertNotDerivedArtifact(context, filePath, label);
      return JSON.parse(readProjectText(context, filePath));
    }
    return JSON.parse(inline);
  } catch (error) {
    fail(`Invalid ${label} JSON: ${error.message}`);
  }
}

export function buildSourceHashes(context, sourcePaths) {
  const hashes = {};
  for (const sourcePath of sourcePaths || []) {
    const snapshot = stableContextSourceSnapshot(context, sourcePath, "Canonical context source");
    hashes[sourcePath] = snapshot.sha256;
  }
  return hashes;
}

export function recordSyncEvent(context, options) {
  ensureInitialized(context);
  const event = normalizeGitEvent(requireOption(options, "event"));
  const storyId = options.story ? normalizeId(String(options.story)) : null;
  if (storyId && !readStory(context, storyId)) {
    fail(`Story ${storyId} does not exist`);
  }
  const attribution = buildAttribution(context, options, `sync.${event}`);
  const summary = options.summary ? String(options.summary) : `Recorded git ${event}`;
  const traceEvent = appendTraceEvent(context, storyId, {
    type: "sync",
    summary,
    action: `sync.${event}`,
    actor: attribution.actor,
    ...buildTraceAuthorityMetadata(context, options, attribution),
    evidence: normalizeListOption(options.evidence).map(normalizeProjectPathInput),
    related: normalizeListOption(options.related),
    git: {
      ...attribution.git,
      event,
      remote: getOptionString(options, "remote") || null,
      upstream: execGit(context.root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]),
      before_sha: getOptionString(options, "before-sha") || null,
      after_sha: getOptionString(options, "after-sha") || attribution.git.head_sha,
      pr_url: getOptionString(options, "pr-url") || null,
    },
    run: attribution.run,
  });
  output(options, { status: "recorded", event: traceEvent }, [`Recorded sync ${event}`]);
}

export function recordTestRun(context, options) {
  ensureInitialized(context);
  const storyId = normalizeId(requireOption(options, "story"));
  const story = readStory(context, storyId);
  if (!story) {
    fail(`Story ${storyId} does not exist`);
  }
  const argv = normalizeRecordedCommandArgv(requireOption(options, "command"));
  requireOption(options, "exit-code");
  const exitCode = boundedNonNegativeIntegerOption(options, "exit-code", { maximum: 255 });
  const totals = {
    passed: boundedNonNegativeIntegerOption(options, "passed", { maximum: 1_000_000 }),
    failed: boundedNonNegativeIntegerOption(options, "failed", { maximum: 1_000_000 }),
    skipped: boundedNonNegativeIntegerOption(options, "skipped", { maximum: 1_000_000 }),
  };
  const outcome = deriveTestRunOutcome(exitCode, totals);
  const evidence = buildTestRunEvidence(context, options);

  const cwdInput = getOptionString(options, "cwd");
  const cwd = cwdInput
    ? toProjectPath(context, resolveProjectFilePath(context, cwdInput, { mustExist: true, directoryOnly: true })) || "."
    : ".";
  const startedAtInput = getOptionString(options, "started-at");
  const finishedAt = now();
  const startedAt = startedAtInput
    ? new Date(normalizeOptionalDateTime(startedAtInput, "started-at")).toISOString()
    : finishedAt;
  const durationMs = Date.parse(finishedAt) - Date.parse(startedAt);
  if (!Number.isSafeInteger(durationMs) || durationMs < 0) {
    fail("--started-at must be an RFC 3339 timestamp that is not later than the moment the record is written.");
  }

  const phase = getOptionString(options, "phase") || story.phase || null;
  if (phase && !context.config.phases[phase]) {
    fail(`Unknown phase '${phase}'. Use one of: ${Object.keys(context.config.phases).join(", ")}`);
  }
  const id = normalizeId(options.id ? String(options.id) : `${storyId}-test-run-${uniqueRecordSuffix()}`);
  const attribution = buildAttribution(context, options, "test.record");
  const record = {
    kind: "test_run",
    schema_version: "test-run:v1",
    id,
    story_id: storyId,
    phase,
    summary: getOptionString(options, "summary") || `Recorded ${outcome} test run for ${storyId}`,
    framework: getOptionString(options, "framework") || null,
    command: { argv, cwd },
    exit_code: exitCode,
    outcome,
    totals,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: durationMs,
    evidence,
    acceptance_criteria: normalizeListOption(options.acceptance),
    requirement_ids: normalizeListOption(options.requirement).map(normalizeId),
    actor: attribution.actor,
    git: attribution.git,
    run: attribution.run,
    created_at: finishedAt,
    audit: {
      created_by: attribution.actor,
      git: attribution.git,
      run: attribution.run,
    },
    hash_algorithm: "sha256:stable-json:v1",
  };
  record.record_hash = computeStableHash(record);
  assertRecordSchema(record, "test-run.schema.json", `Test run ${id}`);

  const recordPath = path.join(testRunsRoot(context), `${id}.json`);
  assertNotDerivedArtifact(context, recordPath, "Test run record");
  writeJsonFile(recordPath, record, { force: Boolean(options.force), forceOption: true });

  const projectRecordPath = toProjectPath(context, recordPath);
  const traceEvent = appendTraceEvent(context, storyId, {
    type: "test",
    summary: record.summary,
    outcome,
    action: "test.record",
    actor: attribution.actor,
    ...buildTraceAuthorityMetadata(context, options, attribution),
    evidence: [projectRecordPath, ...evidence.map((item) => item.path)],
    related: record.requirement_ids,
    git: attribution.git,
    run: attribution.run,
  });

  output(
    options,
    {
      status: "recorded",
      test_run_path: projectRecordPath,
      test_run: record,
      event: traceEvent,
    },
    [
      `Recorded ${outcome} test run ${id} for story ${storyId}`,
      `Command: ${argv.join(" ")} (exit ${exitCode})`,
      `Results: ${totals.passed} passed, ${totals.failed} failed, ${totals.skipped} skipped`,
      `Path: ${projectRecordPath}`,
    ],
  );
}

export function readTestRunRecords(context, storyId) {
  const normalizedStoryId = storyId ? normalizeId(String(storyId)) : null;
  const records = [];
  for (const name of safeReadDir(testRunsRoot(context))) {
    if (!name.endsWith(".json")) continue;
    const recordPath = path.join(testRunsRoot(context), name);
    let record;
    try {
      record = readProjectJson(context, recordPath);
    } catch {
      continue;
    }
    if (record?.kind !== "test_run") continue;
    if (normalizedStoryId && record.story_id !== normalizedStoryId) continue;
    records.push({ path: toProjectPath(context, recordPath), record });
  }
  return records.sort((left, right) =>
    String(left.record.finished_at || "").localeCompare(String(right.record.finished_at || ""), "en")
    || String(left.record.id || "").localeCompare(String(right.record.id || ""), "en"));
}

/** Incident timestamps must satisfy the schema's RFC 3339 date-time format, not just Date.parse. */
function normalizeIncidentTimestamp(value, label) {
  const timestamp = normalizeOptionalDateTime(value, label);
  if (!matchesRfc3339DateTime(timestamp)) {
    fail(`Invalid --${label} '${value}'. Use an RFC 3339 date-time such as 2026-01-05T10:00:00Z.`);
  }
  return timestamp;
}

export function recordIncident(context, options) {
  ensureInitialized(context);
  const storyId = normalizeId(requireOption(options, "story"));
  const story = readStory(context, storyId);
  if (!story) {
    fail(`Story ${storyId} does not exist`);
  }
  const releaseManifestId = resolveOperationsReleaseManifestId(context, options);
  const severity = requireEnumOption(options, "severity", ["sev1", "sev2", "sev3", "sev4"]);
  const summary = requireOption(options, "summary");
  const impact = requireOption(options, "impact");
  const detectedAtInput = getOptionString(options, "detected-at");
  const detectedAt = detectedAtInput ? normalizeIncidentTimestamp(detectedAtInput, "detected-at") : now();
  const resolvedAtInput = getOptionString(options, "resolved-at");
  const resolvedAt = resolvedAtInput ? normalizeIncidentTimestamp(resolvedAtInput, "resolved-at") : null;
  if (resolvedAt && Date.parse(resolvedAt) < Date.parse(detectedAt)) {
    fail(detectedAtInput
      ? `--resolved-at ${resolvedAt} is earlier than --detected-at ${detectedAt}.`
      : `--resolved-at ${resolvedAt} is earlier than the default detection time ${detectedAt}; pass --detected-at.`);
  }
  const actions = normalizeListOption(options["incident-action"]);
  const phase = resolveIncidentFeedbackPhase(context, options, story);
  const id = normalizeId(options.id ? String(options.id) : `${storyId}-incident-${uniqueRecordSuffix()}`);
  const attribution = buildAttribution(context, options, "incident.record");
  const createdAt = now();
  const record = {
    kind: "incident",
    schema_version: "incident:v1",
    id,
    story_id: storyId,
    release_manifest_id: releaseManifestId,
    phase,
    severity,
    detected_at: detectedAt,
    resolved_at: resolvedAt,
    summary,
    impact,
    actions,
    requirement_ids: normalizeListOption(options.requirement).map(normalizeId),
    actor: attribution.actor,
    git: attribution.git,
    run: attribution.run,
    created_at: createdAt,
    audit: {
      created_by: attribution.actor,
      git: attribution.git,
      run: attribution.run,
    },
    hash_algorithm: "sha256:stable-json:v1",
  };
  record.record_hash = computeStableHash(record);
  assertRecordSchema(record, "incident.schema.json", `Incident ${id}`);

  const recordPath = path.join(operationsRoot(context), `${id}.json`);
  assertNotDerivedArtifact(context, recordPath, "Incident record");
  writeJsonFile(recordPath, record, { force: Boolean(options.force), forceOption: true });
  const projectRecordPath = toProjectPath(context, recordPath);

  const traceEvent = appendTraceEvent(context, storyId, {
    type: "release",
    summary: record.summary,
    action: "incident.record",
    actor: attribution.actor,
    ...buildTraceAuthorityMetadata(context, options, attribution),
    evidence: [projectRecordPath],
    related: record.requirement_ids,
    git: attribution.git,
    run: attribution.run,
  });

  output(
    options,
    {
      status: "recorded",
      incident_path: projectRecordPath,
      incident: record,
      event: traceEvent,
    },
    [
      `Recorded ${severity} incident ${id} for story ${storyId}`,
      `Release manifest: ${releaseManifestId}`,
      `Path: ${projectRecordPath}`,
    ],
  );
}

export function readIncidentRecords(context, storyId) {
  const normalizedStoryId = storyId ? normalizeId(String(storyId)) : null;
  const records = [];
  for (const name of safeReadDir(operationsRoot(context))) {
    if (!name.endsWith(".json")) continue;
    const recordPath = path.join(operationsRoot(context), name);
    let record;
    try {
      record = readProjectJson(context, recordPath);
    } catch {
      continue;
    }
    if (record?.kind !== "incident") continue;
    if (normalizedStoryId && record.story_id !== normalizedStoryId) continue;
    records.push({ path: toProjectPath(context, recordPath), record });
  }
  return records.sort((left, right) =>
    String(left.record.detected_at || "").localeCompare(String(right.record.detected_at || ""), "en")
    || String(left.record.id || "").localeCompare(String(right.record.id || ""), "en"));
}

export function recordFeedback(context, options) {
  ensureInitialized(context);
  const storyId = normalizeId(requireOption(options, "story"));
  const story = readStory(context, storyId);
  if (!story) {
    fail(`Story ${storyId} does not exist`);
  }
  const releaseManifestId = resolveOperationsReleaseManifestId(context, options);
  const source = requireEnumOption(options, "feedback-source", ["user", "monitoring", "review", "other"]);
  const summary = requireOption(options, "summary");
  const sentimentInput = getOptionString(options, "sentiment");
  if (sentimentInput && !["positive", "neutral", "negative"].includes(sentimentInput)) {
    fail("--sentiment must be one of: positive, neutral, negative");
  }
  const sentiment = sentimentInput || null;
  const evidence = buildFeedbackEvidence(context, options);
  const phase = resolveIncidentFeedbackPhase(context, options, story);
  const id = normalizeId(options.id ? String(options.id) : `${storyId}-feedback-${uniqueRecordSuffix()}`);
  const attribution = buildAttribution(context, options, "feedback.record");
  const createdAt = now();
  const record = {
    kind: "feedback",
    schema_version: "feedback:v1",
    id,
    story_id: storyId,
    release_manifest_id: releaseManifestId,
    phase,
    source,
    sentiment,
    summary,
    evidence,
    requirement_ids: normalizeListOption(options.requirement).map(normalizeId),
    actor: attribution.actor,
    git: attribution.git,
    run: attribution.run,
    created_at: createdAt,
    audit: {
      created_by: attribution.actor,
      git: attribution.git,
      run: attribution.run,
    },
    hash_algorithm: "sha256:stable-json:v1",
  };
  record.record_hash = computeStableHash(record);
  assertRecordSchema(record, "feedback.schema.json", `Feedback ${id}`);

  const recordPath = path.join(operationsRoot(context), `${id}.json`);
  assertNotDerivedArtifact(context, recordPath, "Feedback record");
  writeJsonFile(recordPath, record, { force: Boolean(options.force), forceOption: true });
  const projectRecordPath = toProjectPath(context, recordPath);

  const traceEvent = appendTraceEvent(context, storyId, {
    type: "release",
    summary: record.summary,
    action: "feedback.record",
    actor: attribution.actor,
    ...buildTraceAuthorityMetadata(context, options, attribution),
    evidence: [projectRecordPath, ...evidence.map((item) => item.path)],
    related: record.requirement_ids,
    git: attribution.git,
    run: attribution.run,
  });

  output(
    options,
    {
      status: "recorded",
      feedback_path: projectRecordPath,
      feedback: record,
      event: traceEvent,
    },
    [
      `Recorded ${source} feedback ${id} for story ${storyId}`,
      `Release manifest: ${releaseManifestId}`,
      `Path: ${projectRecordPath}`,
    ],
  );
}

export function readFeedbackRecords(context, storyId) {
  const normalizedStoryId = storyId ? normalizeId(String(storyId)) : null;
  const records = [];
  for (const name of safeReadDir(operationsRoot(context))) {
    if (!name.endsWith(".json")) continue;
    const recordPath = path.join(operationsRoot(context), name);
    let record;
    try {
      record = readProjectJson(context, recordPath);
    } catch {
      continue;
    }
    if (record?.kind !== "feedback") continue;
    if (normalizedStoryId && record.story_id !== normalizedStoryId) continue;
    records.push({ path: toProjectPath(context, recordPath), record });
  }
  return records.sort((left, right) =>
    String(left.record.created_at || "").localeCompare(String(right.record.created_at || ""), "en")
    || String(left.record.id || "").localeCompare(String(right.record.id || ""), "en"));
}

/**
 * Resolve which files one delivery changed.
 *
 * The preferred source is the committed range between the delivery's base and
 * the current head. Unless the caller names the range, uncommitted and
 * untracked files are scanned with it, since the scan reads the working tree
 * and work in progress would otherwise go unread. A story with no base to
 * compare against falls back to the uncommitted workspace, and a local release
 * with neither falls back to the files inside the write paths the story's
 * approved requirement profiles recorded. A repository without commits is
 * scanned from its working tree with no head. Every source names the same head
 * commit and, when it read uncommitted files, the state of the working tree,
 * so a stored record always states which project state was scanned.
 */
export function resolveSecretScanTargets(context, storyId, options) {
  if (execGit(context.root, ["rev-parse", "--is-inside-work-tree"]) !== "true") {
    if (getOptionString(options, "base") || getOptionString(options, "head")) {
      fail("--base and --head need the project to be a Git worktree.");
    }
    return {
      source: "story_write_paths",
      base_sha: null,
      head_sha: null,
      workspace_state_hash: null,
      paths: secretScanStoryWritePaths(context, storyId),
    };
  }
  const explicitRange = Boolean(getOptionString(options, "base") || getOptionString(options, "head"));
  if (!explicitRange && !execGit(context.root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])) {
    // A repository without its first commit has no head to name: everything in
    // it is uncommitted work, scanned from the working tree.
    const workspacePaths = secretScanGitPaths(context, ["ls-files", "--cached", "--others", "--exclude-standard"]);
    return {
      source: workspacePaths.length > 0 ? "git_workspace" : "story_write_paths",
      base_sha: null,
      head_sha: null,
      workspace_state_hash: secretScanWorkspaceStateHash(context),
      paths: workspacePaths.length > 0 ? workspacePaths : secretScanStoryWritePaths(context, storyId),
    };
  }
  const headSha = resolveSecretScanCommit(context, getOptionString(options, "head") || "HEAD", "head");
  const workspacePaths = [
    ...secretScanGitPaths(context, ["diff", "--name-only", "--no-renames", "HEAD", "--"]),
    ...secretScanGitPaths(context, ["ls-files", "--others", "--exclude-standard"]),
  ];
  const workspaceStateHash = secretScanWorkspaceStateHash(context);
  const baseCandidate = getOptionString(options, "base") || secretScanDeliveryBase(context, storyId);
  if (baseCandidate) {
    // The empty tree is the base of a delivery that started before the first
    // commit; it names no commit, so it is compared as a tree.
    const baseSha = baseCandidate === gitEmptyTreeId(context.root)
      ? baseCandidate
      : resolveSecretScanCommit(context, baseCandidate, "base");
    const rangePaths = secretScanGitPaths(
      context,
      ["diff", "--name-only", "--no-renames", `${baseSha}..${headSha}`, "--"],
    );
    // An explicit range scans exactly that range and binds no working tree
    // state, so the gate accepts it only while the working tree is clean.
    // A range file the working tree has changed since the head is also read as
    // the head holds it: an uncommitted edit must not hide a credential the
    // delivery committed.
    const changedSinceHead = new Set(
      secretScanGitPaths(context, ["diff", "--name-only", "--no-renames", headSha, "--"]),
    );
    return {
      source: "git_range",
      base_sha: baseSha,
      head_sha: headSha,
      workspace_state_hash: explicitRange ? null : workspaceStateHash,
      paths: explicitRange ? rangePaths : [...rangePaths, ...workspacePaths],
      committed_paths: rangePaths.filter((item) => changedSinceHead.has(item)),
    };
  }
  if (workspacePaths.length > 0) {
    return {
      source: "git_workspace",
      base_sha: null,
      head_sha: headSha,
      workspace_state_hash: workspaceStateHash,
      paths: workspacePaths,
    };
  }
  return {
    source: "story_write_paths",
    base_sha: null,
    head_sha: headSha,
    workspace_state_hash: workspaceStateHash,
    paths: secretScanStoryWritePaths(context, storyId),
  };
}

/**
 * A digest of the uncommitted project state outside `.sdlc/`: every changed or
 * untracked path with the hash of its current content. Staging a file does not
 * change it; editing, adding, or deleting one does. A clean worktree has the
 * digest of an empty list.
 */
export function secretScanWorkspaceStateHash(context) {
  return computeStableHash(currentWorkspaceChanges(context).map((entry) => ({
    path: entry.path,
    file_type: entry.file_type,
    content_sha256: entry.content_sha256,
  })));
}

/**
 * Whether a scan record read the working tree as it is now. A record that
 * binds no workspace state, including one written before scans bound it,
 * stands for the committed head alone, so it only matches a clean worktree.
 */
export function secretScanMatchesWorkspace(record, currentWorkspaceStateHash) {
  return (record.workspace_state_hash || computeStableHash([])) === currentWorkspaceStateHash;
}

/**
 * The commit a story's delivery started from: the head its task start
 * recorded. A scan has to compare against this commit, or an older one, to
 * cover every change the delivery made. Null when the story has no task start
 * or its recorded head is not a commit of this repository.
 */
export const UNVERIFIABLE_SECRET_SCAN_BASE = "unverifiable-task-start";

export function secretScanDeliveryBase(context, storyId) {
  const taskStartPath = path.join(context.sdlcRoot, "stories", storyId, "task-start.json");
  if (!fs.existsSync(taskStartPath)) return null;
  let recordedBase;
  try {
    const original = storyOriginalTaskStart(context, storyId);
    // An unverifiable lineage must never narrow the scan range: no scan can
    // cover this sentinel, so the story stays blocked until it is repaired.
    if (original.invalid) return UNVERIFIABLE_SECRET_SCAN_BASE;
    recordedBase = taskStartGitBase(original.receipt || readProjectJson(context, taskStartPath));
  } catch {
    return UNVERIFIABLE_SECRET_SCAN_BASE;
  }
  if (recordedBase.kind === "unborn") {
    // The delivery started before the first commit, so its base is the empty
    // tree. While HEAD is still unborn there is no committed range to cover;
    // once the first commit exists the range from the empty tree is every
    // committed file. A tree that is not this repository's empty tree is not
    // a base any scan can cover.
    if (recordedBase.tree !== gitEmptyTreeId(context.root)) return UNVERIFIABLE_SECRET_SCAN_BASE;
    return gitHeadIsUnborn(context.root) ? null : recordedBase.tree;
  }
  const commitSha = recordedBase.kind === "commit" ? recordedBase.sha : null;
  return commitSha
    && /^[a-f0-9]{7,64}$/iu.test(commitSha)
    && gitCommandSucceeds(context.root, ["cat-file", "-e", `${commitSha}^{commit}`])
    ? commitSha.toLowerCase()
    : null;
}

/**
 * Whether a scan record compared against the delivery base or an ancestor of
 * it. A record over a narrower range, or over the workspace alone, leaves
 * committed delivery changes unread, so it cannot vouch for the delivery.
 */
export function secretScanCoversDeliveryBase(context, record, deliveryBase) {
  if (!deliveryBase) return true;
  if (deliveryBase === UNVERIFIABLE_SECRET_SCAN_BASE) return false;
  const baseSha = String(record.base_sha || "").toLowerCase();
  if (record.source !== "git_range" || !baseSha) return false;
  return baseSha === deliveryBase
    || gitCommandSucceeds(context.root, ["merge-base", "--is-ancestor", baseSha, deliveryBase]);
}

export function readSecretScanFiles(context, projectPaths) {
  const files = [];
  const unreadable = [];
  for (const projectPath of [...new Set(projectPaths)].sort((left, right) => left.localeCompare(right, "en"))) {
    let resolved;
    try {
      resolved = resolveProjectFilePath(context, projectPath, { mustExist: false });
      assertNoSymlinkSegmentsWithinBoundary(context.root, resolved);
    } catch {
      unreadable.push(projectPath);
      continue;
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      unreadable.push(projectPath);
      continue;
    }
    const content = fs.readFileSync(resolved);
    if (content.length > SECRET_SCAN_MAX_FILE_BYTES || content.includes(0)) {
      unreadable.push(projectPath);
      continue;
    }
    files.push({ path: toProjectPath(context, resolved), content: content.toString("utf8") });
  }
  return { files, unreadable };
}

/**
 * Read paths as the commit `headSha` holds them, skipping any the commit does
 * not contain. Oversized and binary blobs are reported as unreadable, like the
 * working tree files readSecretScanFiles skips.
 */
export function readSecretScanCommittedFiles(context, headSha, projectPaths) {
  const files = [];
  const unreadable = [];
  if (!headSha) return { files, unreadable };
  for (const projectPath of [...new Set(projectPaths)].sort((left, right) => left.localeCompare(right, "en"))) {
    let blob;
    try {
      blob = readGitBlobAt(context, headSha, projectPath, SECRET_SCAN_MAX_FILE_BYTES);
    } catch {
      unreadable.push(projectPath);
      continue;
    }
    if (!blob) continue;
    if (blob.oversized || blob.content.includes(0)) {
      unreadable.push(projectPath);
      continue;
    }
    files.push({ path: projectPath, content: blob.content.toString("utf8") });
  }
  return { files, unreadable };
}

export function runSecretScan(context, options) {
  ensureInitialized(context);
  const storyId = normalizeId(requireOption(options, "story"));
  const story = readStory(context, storyId);
  if (!story) {
    fail(`Story ${storyId} does not exist`);
  }
  const policy = secretScanPolicy(context);
  const startedAt = now();
  const targets = resolveSecretScanTargets(context, storyId, options);
  const workingTree = readSecretScanFiles(context, targets.paths);
  const committed = readSecretScanCommittedFiles(context, targets.head_sha, targets.committed_paths || []);
  const unreadable = [...new Set([...workingTree.unreadable, ...committed.unreadable])];

  let scan;
  try {
    scan = scanFiles(
      [...workingTree.files, ...committed.files],
      { rules: policy.rules, excludePaths: policy.excludePaths },
    );
  } catch (error) {
    if (error instanceof SecretScanConfigurationError) {
      fail(`gate_policy.secret_scan is not usable: ${error.message}`);
    }
    throw error;
  }
  // A path read both from the working tree and from the head is one scanned
  // file, and a match both versions share is one finding.
  const seenFindings = new Set();
  scan = {
    ...scan,
    scanned_paths: [...new Set(scan.scanned_paths)],
    skipped_paths: [...new Set(scan.skipped_paths)],
    findings: scan.findings.filter((finding) => {
      const key = stableJson(finding);
      if (seenFindings.has(key)) return false;
      seenFindings.add(key);
      return true;
    }),
  };

  const phase = getOptionString(options, "phase") || story.phase || null;
  if (phase && !context.config.phases[phase]) {
    fail(`Unknown phase '${phase}'. Use one of: ${Object.keys(context.config.phases).join(", ")}`);
  }
  const id = normalizeId(options.id ? String(options.id) : `${storyId}-secret-scan-${uniqueRecordSuffix()}`);
  const attribution = buildAttribution(context, options, "secret.scan");
  const finishedAt = now();
  const record = {
    kind: "secret_scan",
    schema_version: "secret-scan:v1",
    id,
    story_id: storyId,
    delivery_id: getOptionString(options, "delivery") || null,
    phase,
    summary: getOptionString(options, "summary")
      || `Scanned ${scan.scanned_paths.length} changed file(s) of ${storyId} for credentials`,
    base_sha: targets.base_sha,
    head_sha: targets.head_sha,
    workspace_state_hash: targets.workspace_state_hash,
    source: targets.source,
    file_count: scan.scanned_paths.length,
    scanned_paths: scan.scanned_paths,
    excluded_paths: [...scan.skipped_paths, ...unreadable]
      .sort((left, right) => left.localeCompare(right, "en")),
    rule_set_hash: scan.rule_set_hash,
    rule_ids: scan.rules.map((rule) => rule.id),
    findings: scan.findings,
    outcome: scan.outcome,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    requirement_ids: normalizeListOption(options.requirement).map(normalizeId),
    actor: attribution.actor,
    git: attribution.git,
    run: attribution.run,
    created_at: finishedAt,
    audit: {
      created_by: attribution.actor,
      git: attribution.git,
      run: attribution.run,
    },
    hash_algorithm: "sha256:stable-json:v1",
  };
  record.record_hash = computeStableHash(record);
  assertRecordSchema(record, "secret-scan.schema.json", `Secret scan ${id}`);

  const recordPath = path.join(secretScansRoot(context), `${id}.json`);
  assertNotDerivedArtifact(context, recordPath, "Secret scan record");
  writeJsonFile(recordPath, record, { force: Boolean(options.force), forceOption: true });
  const projectRecordPath = toProjectPath(context, recordPath);

  const traceEvent = appendTraceEvent(context, storyId, {
    type: "gate",
    summary: record.summary,
    outcome: scan.outcome === "clean" ? "passed" : "failed",
    action: "secret.scan",
    actor: attribution.actor,
    ...buildTraceAuthorityMetadata(context, options, attribution),
    evidence: [projectRecordPath],
    related: record.requirement_ids,
    git: attribution.git,
    run: attribution.run,
  });

  const deliveryBase = secretScanDeliveryBase(context, storyId);
  const coversDelivery = secretScanCoversDeliveryBase(context, record, deliveryBase);
  const lines = [
    scan.outcome === "clean"
      ? `No credential pattern matched in ${record.file_count} scanned file(s) of story ${storyId}`
      : `Found ${record.findings.length} credential match(es) in ${record.file_count} scanned file(s) of story ${storyId}`,
    `Source: ${record.source}${record.head_sha ? ` (head ${record.head_sha.slice(0, 12)}` : " (no Git head"}${record.base_sha ? `, base ${record.base_sha.slice(0, 12)})` : ")"}`,
    ...record.findings.map((finding) => `${finding.path}:${finding.line} ${finding.rule} ${finding.redacted_match}`),
    `Path: ${projectRecordPath}`,
  ];
  if (!coversDelivery) {
    lines.push(
      `This scan does not reach the delivery base ${deliveryBase.slice(0, 12)} recorded at task start, `
      + "so the validation gate does not accept it; scan again without --base to cover the whole delivery.",
    );
  }
  if (scan.outcome !== "clean") {
    lines.push("Remove each credential from the file, rotate it at its provider, then run secret scan again.");
    const committedPaths = new Set(targets.committed_paths || []);
    if (record.findings.some((finding) => committedPaths.has(finding.path))) {
      lines.push("A file the delivery committed is also read as the head holds it, so commit the removal before scanning again.");
    }
  }
  // A scan with findings reports the blocked status so the human-readable
  // envelope frames it as a refused request, which is what the exit code says.
  output(
    options,
    {
      status: scan.outcome === "clean" ? "clean" : "blocked",
      outcome: scan.outcome,
      secret_scan_path: projectRecordPath,
      covers_delivery_base: coversDelivery,
      secret_scan: record,
      event: traceEvent,
    },
    lines,
  );
  if (scan.outcome !== "clean") {
    process.exitCode = EXIT_CODES.userError;
  }
}

export function readSecretScanRecords(context, storyId) {
  const normalizedStoryId = storyId ? normalizeId(String(storyId)) : null;
  const records = [];
  for (const name of safeReadDir(secretScansRoot(context))) {
    if (!name.endsWith(".json")) continue;
    const recordPath = path.join(secretScansRoot(context), name);
    let record;
    try {
      record = readProjectJson(context, recordPath);
    } catch {
      continue;
    }
    if (record?.kind !== "secret_scan") continue;
    if (normalizedStoryId && record.story_id !== normalizedStoryId) continue;
    records.push({ path: toProjectPath(context, recordPath), record });
  }
  return records.sort((left, right) =>
    String(left.record.finished_at || "").localeCompare(String(right.record.finished_at || ""), "en")
    || String(left.record.id || "").localeCompare(String(right.record.id || ""), "en"));
}

/**
 * Author identities of every commit in base..head, read from the repository.
 */
export function codeReviewRangeAuthors(context, baseSha, headSha) {
  const log = execGitOutput(context.root, ["log", "--format=%an%x00%ae", `${baseSha}..${headSha}`, "--"]);
  // Reviewer independence is proven against these authors, so an unreadable
  // range must refuse rather than look like a range with no authors.
  if (log === null) fail(`Cannot read the commit authors of ${baseSha}..${headSha}; reviewer independence cannot be proven.`);
  return parseCommitAuthors(log);
}

export function recordCodeReview(context, options) {
  ensureInitialized(context);
  const profileId = normalizeId(requireOption(options, "delivery"));
  const verdict = requireOption(options, "verdict");
  if (!CODE_REVIEW_VERDICTS.includes(verdict)) {
    fail(`--verdict must be one of: ${CODE_REVIEW_VERDICTS.join(", ")}.`);
  }
  let findings;
  try {
    findings = normalizeCodeReviewFindings(normalizeRawListOption(options.finding));
  } catch (error) {
    if (error instanceof TypeError) fail(`--finding is invalid: ${error.message}.`);
    throw error;
  }
  if (verdict === "approved" && findings.some((finding) => finding.severity === "blocking")) {
    fail("An approved review cannot carry a blocking finding; record --verdict changes_requested instead.");
  }
  const { profile, storyId } = readPullRequestDeliveryForReview(context, profileId);
  const target = profile.pull_request_target;
  // The reviewed commit is whatever the head branch points at now, read from
  // the repository. A caller-supplied commit would let a review of one state
  // stand in for another.
  const runtimeTarget = validatePullRequestGitBoundary(context, target);
  if (!runtimeTarget.base_sha || !runtimeTarget.head_sha) {
    fail(`Delivery ${profile.delivery_id} has no resolvable base and head commit to review.`);
  }
  const attribution = buildAttribution(context, options, "review.record");
  const gitName = attribution.git.user?.name || null;
  const gitEmail = attribution.git.user?.email || null;
  if (!gitName || !gitEmail) {
    fail("The reviewer's Git identity is incomplete: set git config user.name and user.email before recording a review.");
  }
  const reviewer = {
    actor_id: attribution.actor.id,
    actor_type: attribution.actor.type,
    git_name: gitName,
    git_email: gitEmail,
  };
  const commitAuthors = codeReviewRangeAuthors(context, runtimeTarget.base_sha, runtimeTarget.head_sha);
  const conflicts = reviewerAuthorConflicts(reviewer, commitAuthors);
  const reviewedAt = now();
  const id = normalizeId(options.id ? String(options.id) : `${storyId}-code-review-${uniqueRecordSuffix()}`);
  const record = {
    kind: "code_review",
    schema_version: "code-review:v1",
    id,
    story_id: storyId,
    delivery_id: profile.delivery_id,
    delivery_profile_id: profile.id,
    repository: target.repository,
    base_branch: target.base_branch,
    head_branch: target.head_branch,
    base_sha: runtimeTarget.base_sha.toLowerCase(),
    reviewed_head_sha: runtimeTarget.head_sha.toLowerCase(),
    commit_authors: commitAuthors,
    reviewer,
    verdict,
    findings,
    summary: getOptionString(options, "summary")
      || `Code review of ${profile.delivery_id} at ${runtimeTarget.head_sha.slice(0, 12)}: ${verdict}`,
    reviewed_at: reviewedAt,
    requirement_ids: normalizeListOption(options.requirement).map(normalizeId),
    actor: attribution.actor,
    git: attribution.git,
    run: attribution.run,
    created_at: reviewedAt,
    audit: {
      created_by: attribution.actor,
      git: attribution.git,
      run: attribution.run,
    },
    hash_algorithm: "sha256:stable-json:v1",
  };
  record.record_hash = computeStableHash(record);
  assertRecordSchema(record, "code-review.schema.json", `Code review ${id}`);

  const recordPath = path.join(codeReviewsRoot(context), `${id}.json`);
  assertNotDerivedArtifact(context, recordPath, "Code review record");
  writeJsonFile(recordPath, record, { force: Boolean(options.force), forceOption: true });
  const projectRecordPath = toProjectPath(context, recordPath);

  const traceEvent = appendTraceEvent(context, storyId, {
    type: "gate",
    summary: record.summary,
    outcome: verdict === "approved" && conflicts.length === 0 ? "passed" : "failed",
    action: "review.record",
    actor: attribution.actor,
    ...buildTraceAuthorityMetadata(context, options, attribution),
    evidence: [projectRecordPath],
    related: record.requirement_ids,
    git: attribution.git,
    run: attribution.run,
  });

  const lines = [
    `Recorded ${verdict} review of ${profile.delivery_id} at head ${record.reviewed_head_sha.slice(0, 12)} by ${reviewer.actor_id} <${reviewer.git_email}>`,
    `Range: ${record.base_sha.slice(0, 12)}..${record.reviewed_head_sha.slice(0, 12)} (${commitAuthors.length} author(s))`,
    ...findings.map((finding) =>
      `${finding.severity}: ${finding.summary}${finding.path ? ` (${finding.path}${finding.line ? `:${finding.line}` : ""})` : ""}`),
    `Path: ${projectRecordPath}`,
  ];
  if (conflicts.length > 0) {
    lines.push(
      "This reviewer also authored commits in the reviewed range, so this review does not satisfy the merge gate. "
      + "A reviewer whose actor and Git email differ from every author must review it.",
    );
  }
  output(
    options,
    {
      status: "recorded",
      verdict,
      independent: conflicts.length === 0,
      code_review_path: projectRecordPath,
      code_review: record,
      event: traceEvent,
    },
    lines,
  );
}

/**
 * Code review records for one delivery profile whose content still matches
 * its schema and its own record hash. A record edited after it was written is
 * not evidence of the review it claims.
 */
export function readCodeReviewRecords(context, profileId) {
  const records = [];
  for (const name of safeReadDir(codeReviewsRoot(context))) {
    if (!name.endsWith(".json")) continue;
    let record;
    try {
      record = readProjectJson(context, path.join(codeReviewsRoot(context), name));
    } catch {
      continue;
    }
    if (record?.kind !== "code_review" || record.delivery_profile_id !== profileId) continue;
    if (!validateRecordSchema(record, "code-review.schema.json").valid) continue;
    const { record_hash: recordHash, ...unhashed } = record;
    if (computeStableHash(unhashed) !== recordHash) continue;
    records.push(record);
  }
  return records;
}

/**
 * Enforces gate_policy.merge_requires_code_review before pull_request.merge.
 *
 * The flag is read as `=== true`. A project that never declared it keeps the
 * merge gate it agreed to, so a plugin update cannot start refusing merges in
 * a project that did not opt in; the current template declares it, and an
 * existing project adopts it through the reviewed `config migrate` path.
 *
 * When on, the merge needs an approved `code-review:v1` record for this
 * delivery at exactly the head being merged, by a reviewer whose actor and Git
 * email differ from every author of base..head.
 */
export function enforceMergeCodeReview(context, profile, runtimeTarget) {
  if (context.config.gate_policy?.merge_requires_code_review !== true) {
    return;
  }
  const headSha = String(runtimeTarget?.head_sha || "").toLowerCase();
  const authors = runtimeTarget?.base_sha
    ? codeReviewRangeAuthors(context, runtimeTarget.base_sha, headSha)
    : [];
  const decision = evaluateMergeReviews(readCodeReviewRecords(context, profile.id), {
    deliveryProfileId: profile.id,
    headSha,
    authors,
  });
  if (decision.allowed) {
    return;
  }
  const shortHead = headSha.slice(0, 12);
  const reasons = {
    no_review_for_head: {
      message: `no approved code review exists for head ${shortHead}`,
      en: `No code review was recorded for the commit being merged (${shortHead}). A review of an earlier commit does not cover later changes.`,
      it: `Non è stata registrata alcuna revisione del codice per il commit da unire (${shortHead}). La revisione di un commit precedente non copre le modifiche successive.`,
    },
    reviewer_is_author: {
      message: `review ${decision.review?.id} was recorded by an author of the reviewed range`,
      en: "The only review for this commit was recorded by someone who also authored commits in the pull request.",
      it: "L’unica revisione per questo commit è stata registrata da chi ha anche scritto commit nella pull request.",
    },
    changes_requested: {
      message: `the latest independent review ${decision.review?.id} requested changes`,
      en: "The latest independent review of this commit requested changes.",
      it: "L’ultima revisione indipendente di questo commit ha richiesto modifiche.",
    },
  }[decision.reason];
  const details = {
    delivery_profile_id: profile.id,
    delivery_id: profile.delivery_id,
    head_sha: headSha,
    reason: decision.reason,
    review_id: decision.review?.id || null,
  };
  fail(
    `Delivery action pull_request.merge is refused for ${profile.id}: ${reasons.message}. `
    + `Run 'review record --delivery ${profile.id} --verdict approved' as a reviewer who is not an author of the pull request.`,
    {
      en: {
        result: "The pull request cannot be merged yet.",
        impact: reasons.en,
        required_decision: "A person who did not author any commit in this pull request reviews the current diff.",
        protection_boundary: "Nothing was merged, pushed, or recorded as authorized.",
        next_action: `The reviewer records the outcome with 'review record --delivery ${profile.id} --verdict approved', then the merge is requested again.`,
        details,
      },
      it: {
        result: "La pull request non può ancora essere unita.",
        impact: reasons.it,
        required_decision: "Una persona che non ha scritto alcun commit di questa pull request revisiona il diff corrente.",
        protection_boundary: "Nulla è stato unito, inviato o registrato come autorizzato.",
        next_action: `Il revisore registra l’esito con 'review record --delivery ${profile.id} --verdict approved', poi il merge viene richiesto di nuovo.`,
        details,
      },
    },
  );
}

export function rebuildCache(context, options) {
  ensureInitialized(context);
  const cache = buildCache(context);
  const cachePath = path.join(context.sdlcRoot, "cache", CACHE_FILE_NAME);
  assertRecordSchema(cache, "cache.schema.json", "Local SDLC cache");
  writeJsonFile(cachePath, cache, { force: true });
  output(
    options,
    { status: "rebuilt", cache_path: cachePath, entries: cache.full_text_index.length },
    [`Rebuilt local SDLC cache with ${cache.full_text_index.length} indexed entries`],
  );
}

export function clearCache(context, options) {
  ensureInitialized(context);
  const cacheRoot = resolveProjectFilePath(context, path.join(SDLC_DIR, "cache"), { mustExist: false });
  assertNoSymlinkPathSegments(cacheRoot, context.root);
  removePathGoverned(cacheRoot, { recursive: true, force: true });
  ensureDir(cacheRoot);
  output(options, { status: "cleared", cache_root: cacheRoot }, [`Cleared local SDLC cache at ${cacheRoot}`]);
}

export function reportActivity(context, options) {
  ensureInitialized(context);
  const report = buildActivityReport(context, options);
  if (options.out) {
    writeActivityReport(context, report, options);
  }
  const italian = humanGuidanceLocale(options) === "it";
  output(
    options,
    report,
    humanGuidanceLines(activityReportGuidance(report, options, italian), [
      ...reportPresentationNotices(report, italian),
      `${italian ? "Report attività" : "Activity report"} (${report.view})`,
      `${italian ? "Periodo" : "Window"}: ${report.window.since} -> ${report.window.until}`,
      `${italian ? "Eventi" : "Events"}: ${report.summary.event_count}`,
      ...(options.out ? [`${italian ? "Salvato in" : "Saved to"}: ${displayProjectFilePath(context, options.out)}`] : []),
      ...report.items.map((item) => `${terminalSafeText(item.created_at || "unknown")} ${terminalSafeText(item.story_id || "project")} ${terminalSafeText(item.action)}: ${terminalSafeText(item.summary)}`),
      report.items.length === 0
        ? (italian ? "Nessun evento registrato in questo periodo" : "No canonical trace events in this window")
        : null,
    ].filter(Boolean), options),
  );
}

/** Integrity and readability notices shown first in every human report. */
export function reportPresentationNotices(report, italian = false) {
  const notices = [];
  const pathsIn = (state) => (report.integrity?.files || [])
    .filter((file) => file.state === state)
    .map((file) => file.path)
    .join(", ");
  if (report.integrity?.status === "violated") {
    notices.push(italian
      ? `ATTENZIONE: la cronologia è cambiata in modo inatteso (${pathsIn("violated")}); gli eventi mostrati potrebbero essere stati modificati. Esegui agentic-sdlc trace verify.`
      : `WARNING: history changed unexpectedly (${pathsIn("violated")}); events shown may have been altered. Run agentic-sdlc trace verify.`);
  }
  if (pathsIn("recoverable")) {
    notices.push(`${italian ? "Nota" : "Note"} (${pathsIn("recoverable")}): ${traceRecoveryNeededText(italian)}`);
  }
  if (pathsIn("unverifiable")) {
    notices.push(`${italian ? "Nota" : "Note"} (${pathsIn("unverifiable")}): ${traceUnverifiableText(italian)}`);
  }
  const unreadable = Array.isArray(report.parse_errors) ? report.parse_errors.length : 0;
  if (unreadable > 0) {
    notices.push(italian
      ? `${unreadable} ${unreadable === 1 ? "riga della cronologia non è stata letta" : "righe della cronologia non sono state lette"} e ${unreadable === 1 ? "non compare" : "non compaiono"} in questo report.`
      : `${unreadable} history ${unreadable === 1 ? "line" : "lines"} could not be read and ${unreadable === 1 ? "is" : "are"} not shown in this report.`);
  }
  return notices;
}

export function activityReportGuidance(report, options = {}, italian = false) {
  const count = report.summary.event_count;
  const violated = report.integrity?.status === "violated";
  const result = violated
    ? (italian
      ? "La cronologia del progetto è cambiata in modo inatteso: il report potrebbe contenere eventi modificati."
      : "The project history changed unexpectedly: this report may include altered events.")
    : count === 0
      ? (italian ? "Nel periodo scelto non ci sono attività registrate." : "No activity was recorded in the chosen period.")
      : (italian
        ? `Il report attività è pronto: ${count} ${count === 1 ? "evento registrato" : "eventi registrati"} nel periodo scelto.`
        : `The activity report is ready: ${count} recorded event${count === 1 ? "" : "s"} in the chosen period.`);
  return {
    result,
    impact: options.out
      ? (italian ? "Il report è stato salvato nel file indicato; la cronologia non è stata modificata." : "The report was saved to the requested file; the history itself was not changed.")
      : (italian ? "Il report ha soltanto letto la cronologia; nulla è stato modificato." : "The report only read the history; nothing was changed."),
    required_decision: violated
      ? (italian ? "Non basare decisioni su questo report finché la cronologia non è stata verificata." : "Do not base decisions on this report until the history has been verified.")
      : (italian ? "Non devi decidere nulla per questo report." : "You do not need to decide anything for this report."),
    protection_boundary: italian
      ? "I dati riservati sono oscurati con le regole di privacy del progetto prima di essere mostrati."
      : "Private details are hidden with the project's privacy rules before anything is shown.",
    next_action: violated
      ? (italian ? "Verifica la cronologia con agentic-sdlc trace verify e ripristinala dal controllo di versione se la modifica non era voluta." : "Verify the history with agentic-sdlc trace verify and restore it from version control if the change was not intended.")
      : count === 0
        ? (italian ? "Allarga il periodo con --since (per esempio --since 30d) se ti aspettavi delle attività." : "Widen the period with --since (for example --since 30d) if you expected activity.")
        : options.out
          ? (italian ? "Condividi il file salvato con chi deve leggerlo." : "Share the saved file with the people who need it.")
          : (italian ? "Per conservarne una copia, ripeti il comando con --out <file>.md." : "To keep a copy, run the command again with --out <file>.md."),
  };
}

export function reportQuery(context, options) {
  ensureInitialized(context);
  const queryLoad = loadReportQuery(context, options);
  const italian = humanGuidanceLocale(options) === "it";
  if (!queryLoad.query) {
    const guidance = buildReportQueryNormalizationGuidance(options, queryLoad);
    output(options, guidance, humanGuidanceLines({
      result: italian
        ? "Nessuna risposta: questa domanda richiede una query strutturata."
        : "No answer: this question needs a structured query.",
      impact: italian
        ? "Il testo libero viene conservato solo come contesto; nessun record è stato cercato."
        : "Free text is kept only as context; no records were searched.",
      required_decision: italian
        ? "Non devi decidere nulla; chiedi al tuo agente di sviluppo di tradurre la domanda in una query."
        : "You do not need to decide anything; ask your coding agent to turn the question into a query.",
      protection_boundary: italian ? "Nulla è stato modificato." : "Nothing was changed.",
      next_action: italian
        ? "Ripeti il comando con --query-json o --query-file contenente una query strutturata (vedi i dettagli)."
        : "Run the command again with --query-json or --query-file containing a structured query (see the details).",
    }, [
      "Report query needs canonical normalization.",
      "Pass --query-json or --query-file with a report query object.",
      "Raw natural language is recorded only as context and is not keyword-matched by the CLI.",
      `Example: agentic-sdlc report query --query-json '${JSON.stringify(REPORT_QUERY_HELP_EXAMPLE)}'`,
    ], options));
    return;
  }
  const report = buildReportQueryResult(context, queryLoad.query, options);
  if (options.out) {
    writeReportQueryResult(context, report, options);
  }
  const count = report.summary.result_count;
  output(
    options,
    report,
    humanGuidanceLines({
      result: report.integrity?.status === "violated"
        ? (italian
          ? "La cronologia del progetto è cambiata in modo inatteso: i risultati potrebbero contenere eventi modificati."
          : "The project history changed unexpectedly: the results may include altered events.")
        : count === 0
          ? (italian ? "Nessun record corrisponde alla query." : "No recorded item matches the query.")
          : (italian
            ? `${count} ${count === 1 ? "record corrisponde" : "record corrispondono"} alla query.`
            : `${count} recorded item${count === 1 ? " matches" : "s match"} the query.`),
      impact: italian ? "La query ha soltanto letto i record del progetto." : "The query only read project records.",
      required_decision: italian ? "Non devi decidere nulla per questa query." : "You do not need to decide anything for this query.",
      protection_boundary: italian
        ? "I dati riservati sono oscurati con le regole di privacy del progetto prima di essere mostrati."
        : "Private details are hidden with the project's privacy rules before anything is shown.",
      next_action: count === 0
        ? (italian ? "Allarga i filtri o il periodo della query se ti aspettavi dei risultati." : "Widen the query filters or period if you expected results.")
        : (italian ? "Esamina i risultati nei dettagli." : "Review the results in the details."),
    }, [
      ...reportPresentationNotices(report, italian),
      `Report query: ${report.status}`,
      `Matched: ${count}`,
      ...report.results.map((item) => `${terminalSafeText(item.created_at || item.updated_at || "unknown")} ${terminalSafeText(item.kind)} ${terminalSafeText(item.id)}: ${terminalSafeText(item.summary)}`),
      count === 0 ? "No canonical KB records matched this query" : null,
    ].filter(Boolean), options),
  );
}

export const REPORT_QUERY_HELP_EXAMPLE = Object.freeze({
  intent: "find_records",
  subjects: ["activity"],
  filters: { event_type: ["decision"] },
  time: { since: "30d" },
});

/**
 * Apply the project's privacy rules to a report at presentation time, exactly
 * as the Change Observatory does, so stdout and saved copies never show more
 * than the configured redaction allows.
 */
export function presentRedactedReport(context, report) {
  return presentUnderPrivacyRules(context, report, "report");
}

/**
 * Redact a presentation payload item by item, each with its own budget, so a
 * large but legitimate payload (hundreds of events or proposals) is never
 * replaced as a whole by a limit placeholder. A single value that still
 * exceeds a limit stops the command with its location instead of printing a
 * partial or empty result.
 */
export function presentUnderPrivacyRules(context, value, label) {
  try {
    return redactValueInChunks(value, buildTraceRedactionPolicy(context));
  } catch (error) {
    if (!(error instanceof RedactionLimitError)) throw error;
    fail(
      `The ${label} could not be presented safely under the project's privacy rules: `
      + `the value at ${error.location || "$"} exceeds the redaction limit '${error.limit}'. `
      + "Nothing was printed or written. Narrow the request (for example with --since, --until, --story, or query filters).",
    );
  }
}

export function loadReportQuery(context, options = {}) {
  const json = getOptionString(options, "query-json");
  const file = getOptionString(options, "query-file");
  if (json && file) {
    fail("Use either --query-json or --query-file, not both.");
  }
  if (json) {
    return { source: "query-json", query: loadOptionalJsonInput(context, options, "query-json", "query-file", "Report query") };
  }
  if (file) {
    const queryPath = resolveProjectFilePath(context, file, { mustExist: true, fileOnly: true });
    assertNotDerivedArtifact(context, queryPath, "Report query file");
    return { source: toProjectPath(context, queryPath), query: readProjectJson(context, queryPath) };
  }
  return { source: "missing", query: null, raw_text: getOptionString(options, "text", "query") || null };
}

export function buildReportQueryResult(context, rawQuery, options = {}) {
  const query = normalizeReportQuery(rawQuery, options);
  const session = openProjectQuerySession(context);
  const allRecords = collectReportQueryRecords(context, session);
  const filtered = allRecords
    .filter((record) => reportQuerySubjectMatches(record, query))
    .filter((record) => reportQueryTimeMatches(record, query))
    .filter((record) => reportQueryFiltersMatch(record, query))
    .sort((left, right) => compareReportQueryRecords(left, right, query.sort))
    .slice(0, query.limit)
    .map(formatReportQueryRecord);
  const sourcePaths = Array.from(
    new Set(filtered.flatMap((record) => (record.sources || []).map((source) => source.path).filter(Boolean))),
  ).sort();
  const result = {
    kind: "report_query_result",
    status: "matched",
    schema_version: context.config.schema_version,
    generated_at: now(),
    query,
    summary: {
      result_count: filtered.length,
      by_kind: countBy(filtered, "kind"),
      by_actor: countBy(filtered, (record) => traceActorKey(record.actor)),
      by_requester: countBy(
        filtered.filter((record) => record.requested_by),
        (record) => traceActorKey(record.requested_by),
      ),
      by_authorizer: countBy(
        filtered.filter((record) => record.authorized_by),
        (record) => traceActorKey(record.authorized_by),
      ),
      by_story: countBy(filtered, (record) => record.story_id || "project"),
    },
    results: filtered,
    integrity: reportIntegritySummary(context),
    source_paths: sourcePaths,
    source_hashes: buildSourceHashMap(context, sourcePaths, session),
    source_policy: "Query results cite canonical .sdlc files. Cache and indexes are never query evidence.",
  };
  return presentRedactedReport(context, result);
}

/** History integrity as reported alongside every report. */
export function reportIntegritySummary(context, files = null) {
  const history = inspectTraceHistory(context, { files });
  return {
    status: history.status,
    check: history.check,
    mode: history.mode,
    authenticity_claimed: false,
    files_checked: history.files_checked,
    violations: history.violations,
    recoverable: history.recoverable,
    unverifiable: history.unverifiable,
    files: history.files
      .filter((file) => file.state !== "valid")
      .map((file) => ({ path: file.path, state: file.state, errors: file.errors })),
  };
}

export function collectReportQueryRecords(context, session = openProjectQuerySession(context)) {
  const registry = readOutputRegistry(context, { missingOk: true });
  const registryIndex = createOutputRegistryQueryIndex(registry);
  const stories = readAllStories(context, session);
  return [
    ...collectTraceQueryRecords(context, session),
    ...collectStoryQueryRecords(context, registry, registryIndex, stories),
    ...collectStoryStepQueryRecords(context, stories, session),
    ...collectOutputQueryRecords(context, registry),
    ...collectContractQueryRecords(context, session),
    ...collectHandoffQueryRecords(context),
    ...collectWorkItemQueryRecords(context, session),
    ...collectApprovalQueryRecords(context, session),
    ...collectTestQueryRecords(context, session),
  ];
}

export function collectWorkItemQueryRecords(context, session = null) {
  const roots = [path.join(workItemsRoot(context), "epics"), path.join(workItemsRoot(context), "tasks")];
  return roots.flatMap((root) =>
    collectJsonFiles(context, root, session).map((item) => ({
      kind: "work_items",
      id: item.id || path.basename(item.__path, ".json"),
      summary: item.title || item.summary || item.id || path.basename(item.__path, ".json"),
      created_at: item.created_at || null,
      updated_at: item.updated_at || item.created_at || null,
      actor: item.audit?.created_by || item.audit?.updated_by || null,
      requested_by: null,
      authorized_by: null,
      request: null,
      action: "work.item.create",
      event_type: "work_item",
      story_id: item.story_id || item.story || null,
      artifact_type: null,
      requirements: item.requirement_id ? [item.requirement_id] : normalizeStringArray(item.requirements),
      phase: null,
      status: item.status || null,
      text: stableJson(item),
      sources: [{ path: item.__relative_path, line: 1 }],
      raw: item,
    })),
  );
}

export function collectTestQueryRecords(context, session = null) {
  return collectJsonFiles(context, path.join(context.sdlcRoot, "tests"), session).map((testRecord) => ({
    kind: "tests",
    id: testRecord.id || path.basename(testRecord.__path, ".json"),
    summary: testRecord.summary || testRecord.id || path.basename(testRecord.__path, ".json"),
    created_at: testRecord.created_at || null,
    updated_at: testRecord.updated_at || testRecord.created_at || null,
    actor: testRecord.audit?.created_by || testRecord.audit?.updated_by || null,
    requested_by: null,
    authorized_by: null,
    request: null,
    action: "test.evidence",
    event_type: "test",
    story_id: testRecord.story_id || null,
    artifact_type: null,
    requirements: normalizeStringArray(testRecord.requirements),
    phase: "validation",
    status: testRecord.status || null,
    text: stableJson(testRecord),
    sources: [{ path: testRecord.__relative_path, line: 1 }],
    raw: testRecord,
  }));
}

export function reportQueryTimeMatches(record, query) {
  if (!query.time.since && !query.time.until) {
    return true;
  }
  const fields = query.time.field === "updated_at" ? ["updated_at"] : query.time.field === "any" ? ["created_at", "updated_at"] : ["created_at"];
  const timestamps = fields.map((field) => Date.parse(String(record[field] || ""))).filter(Number.isFinite);
  if (timestamps.length === 0) {
    return false;
  }
  const since = query.time.since ? parseDateBoundary(query.time.since, "query.time.since") : null;
  const until = query.time.until ? parseDateBoundary(query.time.until, "query.time.until", { defaultNow: true }) : null;
  return timestamps.some((timestamp) => (!since || timestamp >= since.getTime()) && (!until || timestamp <= until.getTime()));
}

export function writeReportQueryResult(context, rawReport, options) {
  const report = presentRedactedReport(context, rawReport);
  const reportPath = resolveProjectFilePath(context, options.out, { mustExist: false });
  assertNotDerivedArtifact(context, reportPath, "Report query result");
  if (path.extname(reportPath).toLowerCase() === ".md") {
    writeTextFile(reportPath, renderReportQueryMarkdown(report), { force: Boolean(options.force), forceOption: true });
    return;
  }
  writeJsonFile(reportPath, report, { force: Boolean(options.force), forceOption: true });
}

export function buildActivityReport(context, options = {}) {
  const session = openProjectQuerySession(context);
  const view = normalizeActivityReportView(options.view || "business");
  const untilDate = parseDateBoundary(options.until || "now", "until", { defaultNow: true });
  const sinceDate = parseDateBoundary(options.since || "3d", "since", { relativeTo: untilDate });
  if (sinceDate.getTime() > untilDate.getTime()) {
    fail(
      `--since (${sinceDate.toISOString()}) is after --until (${untilDate.toISOString()}). `
      + `${options.until ? "" : "--until defaults to now when it is omitted, so a --since in the future also needs a later --until. "}`
      + "Use an earlier --since, for example --since 7d.",
    );
  }
  const storyFilter = options.story ? normalizeId(options.story) : null;
  const actorFilter = getOptionString(options, "actor") || null;
  const allEvents = readAllTraceEvents(context, { story: storyFilter, session });
  const filteredEvents = allEvents
    .filter((event) => event.type !== "invalid")
    .filter((event) => isEventInsideWindow(event, sinceDate, untilDate))
    .filter((event) => !actorFilter || traceActorMatches(event.actor, actorFilter))
    .sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
  const items = filteredEvents.map((event) => formatActivityEventForView(event, view));
  const summary = summarizeActivityEvents(filteredEvents);
  const sourcePaths = Array.from(new Set(filteredEvents.map((event) => event.source?.path).filter(Boolean))).sort();
  const report = {
    kind: "activity_report",
    schema_version: context.config.schema_version,
    generated_at: now(),
    view,
    window: {
      since: sinceDate.toISOString(),
      until: untilDate.toISOString(),
    },
    filters: {
      story_id: storyFilter,
      actor: actorFilter,
    },
    summary,
    items,
    parse_errors: allEvents.filter((event) => event.type === "invalid").map((event) => event.source),
    unreadable_lines: allEvents.filter((event) => event.type === "invalid").length,
    integrity: reportIntegritySummary(
      context,
      storyFilter ? [path.join(context.sdlcRoot, "traces", `${storyFilter}.jsonl`)] : null,
    ),
    source_paths: sourcePaths,
    source_hashes: buildSourceHashMap(context, sourcePaths, session),
    source_policy: "Only canonical .sdlc trace files are summarized; cache and indexes are not cited as evidence.",
  };
  return presentRedactedReport(context, report);
}

export function parseDateBoundary(value, label, options = {}) {
  const raw = String(value || "").trim();
  if (raw === "now") {
    return options.defaultNow || !options.relativeTo ? new Date() : new Date(options.relativeTo);
  }
  const relative = raw.match(/^(\d+)([dhm])$/i);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const millis = unit === "d" ? amount * 86400000 : unit === "h" ? amount * 3600000 : amount * 60000;
    const base = options.relativeTo ? new Date(options.relativeTo) : new Date();
    return new Date(base.getTime() - millis);
  }
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) {
    fail(`Invalid --${label} '${value}'. Use ISO date/time, now, or a relative duration like 3d, 12h, 30m.`);
  }
  return new Date(timestamp);
}

export function writeActivityReport(context, rawReport, options) {
  const report = presentRedactedReport(context, rawReport);
  const reportPath = resolveProjectFilePath(context, options.out, { mustExist: false });
  assertNotDerivedArtifact(context, reportPath, "Activity report");
  if (path.extname(reportPath).toLowerCase() === ".md") {
    writeTextFile(reportPath, renderActivityReportMarkdown(report), { force: Boolean(options.force), forceOption: true });
    return;
  }
  writeJsonFile(reportPath, report, { force: Boolean(options.force), forceOption: true });
}

export function rebuildManifests(context, options) {
  ensureInitialized(context);
  const manifest = buildKnowledgeManifest(context, options);
  const manifestPath = path.join(context.sdlcRoot, "manifests", "kb-manifest.json");
  writeJsonFile(manifestPath, manifest, { force: true });
  output(
    options,
    { status: "rebuilt", manifest_path: manifestPath, manifest },
    [
      `Rebuilt KB manifest: ${toProjectPath(context, manifestPath)}`,
      `Stories: ${manifest.summary.stories}`,
      `Trace events: ${manifest.summary.trace_events}`,
      `Approvals: ${manifest.summary.approvals}`,
    ],
  );
}

export function buildKnowledgeManifest(context, options = {}) {
  const generatedAt = now();
  const session = openProjectQuerySession(context);
  const sourceFiles = collectManifestSourceFiles(context, session);
  const sourcePaths = sourceFiles.map((filePath) => toProjectPath(context, filePath)).sort();
  const stories = readAllStories(context, session);
  const registry = readOutputRegistry(context, { missingOk: true });
  const registryIndex = createOutputRegistryQueryIndex(registry);
  const traceEvents = readAllTraceEvents(context, { session }).filter((event) => event.type !== "invalid");
  const lastTraceByStory = new Map();
  for (const event of traceEvents) {
    if (event.story_id) lastTraceByStory.set(event.story_id, event);
  }
  const approvals = collectApprovalManifestEntries(context, session);
  const contracts = collectJsonFiles(context, path.join(context.sdlcRoot, "contracts"), session).map((contract) => ({
    id: contract.id || path.basename(contract.__path, ".json"),
    phase: contract.phase || null,
    story_id: contract.story_id || null,
    status: contract.status || null,
    path: contract.__relative_path,
  }));
  return {
    kind: "kb_manifest",
    schema_version: context.config.schema_version,
    story_projection_schema_version: "effective-story-lifecycle:v1",
    generated_at: generatedAt,
    canonical_root: SDLC_DIR,
    summary: {
      stories: stories.length,
      contracts: contracts.length,
      output_templates: registry?.templates?.length || 0,
      output_links: registry?.links?.length || 0,
      trace_events: traceEvents.length,
      approvals: approvals.length,
      source_files: sourcePaths.length,
    },
    stories: stories.map((story) => {
      const claimPath = path.join(context.sdlcRoot, "stories", story.id, "claim.json");
      const claim = fs.existsSync(claimPath) ? readProjectJson(context, claimPath) : null;
      const lifecycle = effectiveStoryLifecycleProjection(context, story);
      return {
        id: story.id,
        title: story.title,
        status: story.status,
        phase: story.phase,
        record_status: story.status,
        record_phase: story.phase,
        effective_status: lifecycle.status,
        effective_phase: lifecycle.phase,
        lifecycle_terminal: lifecycle.terminal,
        lifecycle_blocked: lifecycle.blocked,
        lifecycle_source: lifecycle.source,
        workflow_instance_id: lifecycle.workflow_instance_id,
        ...(lifecycle.certification ? { certification: lifecycle.certification } : {}),
        contract_id: story.contract_id || null,
        requirements: Array.isArray(story.links?.requirements) ? story.links.requirements : [],
        active_claim: claim?.status === "active" ? { agent: claim.agent, branch: claim.branch, expires_at: claim.expires_at || null } : null,
        completed_steps: readStoryStepRecords(context, story.id, session).map((record) => ({
          step: record.step,
          completed_at: record.completed_at,
          output_types: record.output_types || [],
        })),
        output_links: (registryIndex.links_by_story.get(story.id) || [])
          .map((link) => ({
            id: link.id,
            artifact_type: link.artifact_type,
            artifact_path: link.artifact_path,
            mode: link.mode,
            template_id: link.template_id,
          })),
        last_trace: lastTraceByStory.get(story.id) || null,
      };
    }),
    contracts,
    output_contracts: {
      templates: (registry?.templates || []).map((template) => ({
        id: template.id,
        type: template.type,
        status: template.status,
        path: template.path,
        approved_at: template.approved_at || null,
      })),
      links: (registry?.links || []).map((link) => ({
        id: link.id,
        story_id: link.story_id,
        artifact_type: link.artifact_type,
        artifact_path: link.artifact_path,
        template_id: link.template_id,
        mode: link.mode,
        requirements: link.requirements || [],
      })),
    },
    activity: summarizeActivityEvents(traceEvents),
    approvals,
    source_paths: sourcePaths,
    source_hashes: buildSourceHashMap(context, sourcePaths, session),
    audit: {
      generated_by: buildAttribution(context, options, "manifest.rebuild").actor,
      git: buildGitMetadata(context.root),
      run: buildRunMetadata(options),
    },
  };
}

export function collectManifestSourceFiles(context, session = null) {
  return collectKnowledgeSourceFiles(context, session).filter((filePath) => {
    const relative = path.relative(context.sdlcRoot, filePath);
    return !relative.startsWith(`manifests${path.sep}`);
  });
}

export function collectJsonFiles(context, root, session = null) {
  if (session) {
    return session.jsonRecords({ under: toProjectPath(context, root) }).map((record) => ({
      ...record.value,
      __path: path.join(context.root, ...record.path.split("/")),
      __relative_path: record.path,
    }));
  }
  return walkFiles(root)
    .filter((filePath) => filePath.endsWith(".json"))
    .map((filePath) => {
      const data = readProjectJson(context, filePath);
      data.__path = filePath;
      data.__relative_path = toProjectPath(context, filePath);
      return data;
    });
}

export function validateActiveManifestRecordSchemas(context, manifest) {
  const typedReferences = [
    ...(manifest.requirements || []).map((reference) => [reference, "requirement.schema.json", "requirement"]),
    ...(manifest.stories || []).map((reference) => [reference, "story.schema.json", "story"]),
    ...(manifest.contracts || []).map((reference) => [reference, "contract.schema.json", "contract"]),
    ...(manifest.proposals || []).map((reference) => [reference, "assessment-proposal.schema.json", "assessment proposal"]),
    ...[manifest.workflow].filter(Boolean).map((reference) => [reference, "assessment-workflow.schema.json", "assessment workflow"]),
    ...(manifest.authorization_usage_receipts || []).map((reference) => [reference, "authorization-usage-receipt.schema.json", "authorization usage receipt"]),
    ...(manifest.execution_usage_receipts || []).map((reference) => [reference, "execution-usage-receipt.schema.json", "execution usage receipt"]),
    ...(manifest.context_optimization_observations || []).map((reference) => [reference, "context-optimization-observation.schema.json", "context optimization observation"]),
    ...(manifest.gate_receipts || []).map((reference) => [reference, "release-gate-receipt.schema.json", "release gate receipt"]),
    ...[manifest.budget_decision?.budget_ref].filter(Boolean).map((reference) => [reference, "execution-budget.schema.json", "execution budget"]),
    ...(manifest.artifacts || []).map((artifact) => [artifact.verification_receipt_ref, "verification-receipt.schema.json", "verification receipt"]),
  ];
  for (const [reference, schemaName, label] of typedReferences) {
    const filePath = resolveProjectFilePath(context, reference.path, { mustExist: true, fileOnly: true });
    assertRecordSchema(readProjectJson(context, filePath), schemaName, `${label} ${reference.id}`);
  }
  return typedReferences.length;
}

export function buildCache(context) {
  const generatedAt = now();
  const session = openProjectQuerySession(context);
  const sourceSnapshot = collectKnowledgeSourceSnapshot(context, session);
  const sourceFiles = sourceSnapshot.source_paths
    .map((relativePath) => path.join(context.root, ...relativePath.split("/")));
  const sourceHashes = { ...sourceSnapshot.source_hashes };
  const fullTextIndex = [];
  for (const filePath of sourceFiles) {
    const relativePath = toProjectPath(context, filePath);
    const sourceHash = sourceHashes[relativePath];
    const raw = session.readTextAtHash(relativePath, sourceHash);
    fullTextIndex.push({
      path: relativePath,
      title: inferTitle(filePath, raw),
      extension: path.extname(filePath),
      size_bytes: Buffer.byteLength(raw),
      snippet: normalizeText(raw).slice(0, 240),
      search_text: normalizeText(raw),
      source_paths: [relativePath],
      source_hashes: {
        [relativePath]: sourceHash,
      },
      generated_at: generatedAt,
      schema_version: context.config.schema_version,
    });
  }

  const registry = readOutputRegistry(context, { missingOk: true });
  const stories = readAllStories(context, session);
  const registryIndex = createOutputRegistryQueryIndex(registry);
  const templateResolution = buildTemplateResolution(registry);
  const storyRequirementGraph = buildStoryRequirementGraph(stories);
  const dependencyGraph = {
    approved: readDependencyGraph(context, { missingOk: true }),
    derived_story_links: buildStoryDependencyGraph(stories),
  };
  const artifactFingerprints = buildArtifactFingerprints(context, registry);
  const outputResolutions = {};
  const artifactTypes = collectOutputArtifactTypes(context, registry);
  for (const story of stories) {
    for (const artifactType of artifactTypes) {
      outputResolutions[outputResolutionKey(story.id, artifactType)] = buildOutputResolution(context, story.id, artifactType, {
        registry,
        registry_index: registryIndex,
        story,
        cache_used: false,
      });
    }
  }

  return {
    schema_version: context.config.schema_version,
    generated_at: generatedAt,
    root: context.root,
    source_paths: Object.keys(sourceHashes).sort(),
    source_hashes: sourceHashes,
    full_text_index: fullTextIndex,
    story_requirement_graph: storyRequirementGraph,
    artifact_fingerprints: artifactFingerprints,
    template_resolution: templateResolution,
    kb_summaries: fullTextIndex.map((entry) => ({
      path: entry.path,
      title: entry.title,
      snippet: entry.snippet,
      source_paths: entry.source_paths,
      source_hashes: entry.source_hashes,
      generated_at: entry.generated_at,
      schema_version: entry.schema_version,
    })),
    dependency_graph: dependencyGraph,
    output_resolutions: outputResolutions,
  };
}

export function validateCacheMetadata(context, cache) {
  const errors = [];
  const required = context.config.cache_policy?.required_entry_metadata || [
    "source_paths",
    "source_hashes",
    "generated_at",
    "schema_version",
  ];
  for (const [collectionName, entries] of Object.entries({
    full_text_index: cache.full_text_index,
    kb_summaries: cache.kb_summaries,
  })) {
    if (!Array.isArray(entries)) {
      errors.push(`${collectionName} must be an array`);
      continue;
    }
    entries.forEach((entry, index) => {
      for (const field of required) {
        if (entry[field] === undefined || entry[field] === null) {
          errors.push(`${collectionName}[${index}] is missing ${field}`);
        }
      }
      for (const sourcePath of entry.source_paths || []) {
        const resolved = resolveProjectFilePath(context, sourcePath, { mustExist: false });
        if (isDerivedArtifactPath(context, resolved)) {
          errors.push(`${collectionName}[${index}] uses derived source ${sourcePath}`);
        }
      }
    });
  }
  return errors;
}

export function nearestExistingParent(filePath) {
  let current = path.dirname(path.resolve(filePath));
  while (!fs.existsSync(current)) {
    const next = path.dirname(current);
    if (next === current) {
      return current;
    }
    current = next;
  }
  return current;
}

export function collectKnowledgeSourceSnapshot(context, session = openProjectQuerySession(context)) {
  return session.sourceSnapshot({
    under: knowledgeSourceRoots(context),
    extensions: context.config.indexable_extensions,
  });
}

export function collectKnowledgeSourceFiles(context, session = null) {
  if (session) {
    return collectKnowledgeSourceSnapshot(context, session).source_paths
      .map((relativePath) => path.join(context.root, ...relativePath.split("/")));
  }
  const sourceDirs = knowledgeSourceRoots(context).filter((directory) => directory !== "project.json");
  const files = [];
  const rootFiles = [path.join(context.sdlcRoot, "project.json")].filter((filePath) => fs.existsSync(filePath));
  files.push(...rootFiles);
  for (const directory of sourceDirs) {
    const dirPath = path.join(context.sdlcRoot, directory);
    if (!fs.existsSync(dirPath)) {
      continue;
    }
    for (const filePath of walkFiles(dirPath)) {
      if (shouldIndexFile(context, filePath)) {
        files.push(filePath);
      }
    }
  }
  return Array.from(new Set(files)).sort((a, b) => a.localeCompare(b));
}

export function readAllStories(context, session = null) {
  if (session) {
    return session.stories()
      .map(normalizeStoryRecord)
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }
  const storiesRoot = path.join(context.sdlcRoot, "stories");
  return safeReadDir(storiesRoot)
    .map((entry) => {
      const storyPath = path.join(storiesRoot, entry, "story.json");
      return fs.existsSync(storyPath) ? readProjectJson(context, storyPath) : null;
    })
    .filter(Boolean)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

export function buildArtifactFingerprints(context, registry) {
  const paths = new Set();
  for (const template of registry?.templates || []) {
    if (template.path) {
      paths.add(template.path);
    }
  }
  for (const link of registry?.links || []) {
    if (link.artifact_path) {
      paths.add(link.artifact_path);
    }
    if (link.base_artifact) {
      paths.add(link.base_artifact);
    }
  }
  return Array.from(paths)
    .sort()
    .map((relativePath) => {
      const filePath = resolveProjectFilePath(context, relativePath, { mustExist: false });
      return {
        path: relativePath,
        exists: fs.existsSync(filePath),
        sha256: fs.existsSync(filePath) ? hashFile(filePath) : null,
        size_bytes: fs.existsSync(filePath) ? fs.statSync(filePath).size : null,
      };
    });
}

export function rebuildIndex(context, options) {
  ensureInitialized(context);
  const index = buildIndex(context);
  const indexPath = path.join(context.sdlcRoot, "indexes", "kb-index.json");
  writeJsonFile(indexPath, index, { force: true });
  output(
    options,
    { status: "rebuilt", index_path: indexPath, entries: index.entries.length },
    [`Rebuilt knowledge index with ${index.entries.length} entries`],
  );
}

export function searchKnowledgeBase(context, options, rest) {
  ensureInitialized(context);
  const query = String(options.query || rest.join(" ")).trim();
  if (!query) {
    fail("Provide a query with 'kb search <query>' or --query.");
  }
  const limit = boundedPositiveInteger(options.limit, "limit", {
    defaultValue: 10,
    maximum: 100,
  });
  const indexStatus = getIndexStatus(context);
  const index = indexStatus.valid ? indexStatus.index : buildIndex(context);
  const terms = tokenize(query);
  const results = index.entries
    .map((entry) => ({ entry, score: scoreEntry(entry, terms) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const jsonResults = options.full ? results : results.map(({ entry, score }) => ({
    score,
    entry: compactIndexEntry(entry, index.source_hashes?.[entry.path]),
  }));
  const omittedBytes = options.full
    ? 0
    : results.reduce((total, { entry }) => total + Buffer.byteLength(entry.search_text || "", "utf8"), 0);
  output(
    options,
    {
      query,
      index_status: indexStatus.valid ? "valid" : "rebuilt_in_memory",
      limit,
      results: jsonResults,
      ...(options.full ? {} : {
        context_optimization: buildContextOptimizationMetadata({
          profile: "kb-search-compact:v1",
          omittedFields: ["results[].entry.search_text"],
          omittedBytes,
          fullPayloadFlag: "--full",
        }),
      }),
    },
    results.length
      ? results.map(({ entry, score }) => `${score.toFixed(2)} ${entry.path}: ${entry.snippet}`)
      : [`No KB results for '${query}'`],
  );
}

export function showOrchestrationPlan(context, options) {
  ensureInitialized(context);
  const snapshot = buildOrchestrationSnapshot(context, { sharedClaims: true });
  const limit = boundedPositiveInteger(options.limit, "limit", {
    defaultValue: 20,
    maximum: 100,
  });
  const candidates = snapshot.stories
    .filter((story) => story.orchestration_state === "available")
    .slice(0, limit)
    .map((story) => {
      const next = storyOrchestrationNextAction(context, story);
      return {
        story_id: story.id,
        title: story.title,
        phase: story.phase,
        suggested_branch: defaultStoryBranch(context, story.id),
        suggested_action: next.action,
        suggested_command: next.command,
        suggested_claim: next.claim,
        readiness_issues: next.issues,
      };
    });
  output(
    options,
    { ...snapshot, candidates },
    candidates.length
      ? [
          `Available work lanes: ${candidates.length}`,
          ...candidates.map((item) =>
            `${item.story_id}: ${item.title} (${item.phase}) -> `
            + `${item.suggested_action}: ${item.suggested_command}`),
        ]
      : ["No available story lanes. Check blocked, claimed, or stale stories with 'orchestrate status --json'."],
  );
}

/**
 * Stories with their orchestration state. With `sharedClaims`, the claims
 * of every computer are read from the git remote (one listing) when claims
 * are shared and some story is still open: a story claimed elsewhere is not
 * available here, and a claim older than
 * orchestration_policy.stale_claim_after_seconds is stale.
 */
export function buildOrchestrationSnapshot(context, { sharedClaims = false } = {}) {
  const staleAfterSeconds = sharedClaims ? storyClaimPolicy(context).stale_claim_after_seconds : null;
  const nowMs = Date.now();
  const session = openProjectQuerySession(context);
  const storyRecords = session.listFiles({
    under: "stories",
    extensions: [".json"],
    names: ["story.json"],
  })
    .filter((file) => file.canonical_path.split("/").length === 3)
    .map((file) => {
      const entry = file.canonical_path.split("/")[1];
      return normalizeStoryRecord({ ...session.readJson(file.path), __folder_id: entry });
    });
  const claimByStory = new Map(
    session.listFiles({ under: "stories", extensions: [".json"], names: ["claim.json"] })
      .filter((file) => file.canonical_path.split("/").length === 3)
      .map((file) => [file.canonical_path.split("/")[1], session.readJson(file.path)]),
  );
  const traceEvents = readAllTraceEvents(context, { session }).filter((event) => event.type !== "invalid");
  const lastTraceByStory = new Map();
  for (const event of traceEvents) {
    if (event.story_id) lastTraceByStory.set(event.story_id, event);
  }
  const dependencyQuery = buildDependencyQuery(context, {
    stories: storyRecords,
    traceEvents,
    session,
  });
  const localStories = storyRecords
    .map((story) => {
      const entry = story.__folder_id;
      const lifecycle = dependencyQuery.lifecycle_by_story.get(story.id || entry)
        || effectiveStoryLifecycleProjection(context, story);
      const projectedStory = {
        ...story,
        status: lifecycle.status,
        phase: lifecycle.phase,
      };
      const claim = claimByStory.get(entry) || null;
      const lastTrace = lastTraceByStory.get(story.id || entry) || null;
      const dependencyStatus = buildDependencyStatus(context, story.id || entry, dependencyQuery);
      const blockers = inferStoryBlockers(
        context,
        projectedStory,
        claim,
        dependencyStatus,
        lifecycle,
      );
      return {
        id: story.id || entry,
        title: story.title || entry,
        status: lifecycle.status,
        phase: lifecycle.phase,
        record_status: story.status || "unknown",
        record_phase: story.phase || "unknown",
        lifecycle_source: lifecycle.source,
        workflow_instance_id: lifecycle.workflow_instance_id,
        ...(lifecycle.certification ? { certification: lifecycle.certification } : {}),
        contract_id: story.contract_id || null,
        claim,
        last_trace: lastTrace,
        dependency_edges: dependencyStatus.edges,
        warnings: dependencyStatus.warnings,
        orchestration_state: inferStoryOrchestrationState(
          context,
          projectedStory,
          claim,
          blockers,
          lifecycle,
        ),
        blockers,
        ...(lifecycle.closed ? { closure: lifecycle.closure } : {}),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  // Nothing to coordinate once every story is finished: the remote is not asked.
  const shared = sharedClaims && localStories.some((story) => !["closed", "terminal"].includes(story.orchestration_state))
    ? sharedClaimsOverview(context)
    : null;
  const stories = localStories.map((story) => {
    if (!sharedClaims) return story;
    const sharedView = shared?.checked
      ? sharedClaimView(storySharedClaimState(shared.interpreted, story.id), story.claim, { nowMs, staleAfterSeconds, owned: shared.owned })
      : null;
    return {
      ...story,
      orchestration_state: sharedOrchestrationState(story.orchestration_state, story.claim, sharedView, { nowMs, staleAfterSeconds }),
      ...(sharedView ? { shared_claim: sharedView } : {}),
    };
  });

  const locks = readLocks(context);
  const handoffs = readHandoffs(context);

  const summary = {
    total: stories.length,
    available: stories.filter((story) => story.orchestration_state === "available").length,
    claimed: stories.filter((story) => story.orchestration_state === "claimed").length,
    blocked: stories.filter((story) => story.orchestration_state === "blocked").length,
    stale: stories.filter((story) => story.orchestration_state === "stale").length,
    terminal: stories.filter((story) => story.orchestration_state === "terminal").length,
    closed: stories.filter((story) => story.orchestration_state === "closed").length,
    active_locks: locks.filter((lock) => lock.status === "active" && !isExpired(lock.expires_at)).length,
  };

  return {
    checked_at: now(),
    root: context.root,
    summary,
    stories,
    locks,
    handoffs,
    ...(shared
      ? {
          shared_claims: {
            scope: shared.scope,
            remote: shared.remote,
            checked: shared.checked,
            ...(shared.note ? { note: shared.note } : {}),
            ...(shared.error ? { error: shared.error } : {}),
            problems: shared.problems || [],
            stale_claim_after_seconds: staleAfterSeconds,
          },
        }
      : {}),
  };
}

/**
 * Adjusts the state seen in this checkout with what every computer sees: a
 * story another computer holds is claimed (or stale) here too, and a claim
 * older than the configured age is stale.
 */
function sharedOrchestrationState(localState, claim, sharedView, { nowMs, staleAfterSeconds }) {
  if (["closed", "terminal"].includes(localState)) return localState;
  if (sharedView?.holder && !sharedView.here) return sharedView.state === "stale" ? "stale" : "claimed";
  if (localState === "claimed" && staleAfterSeconds !== null) {
    const claimedAt = Date.parse(String(claim?.claimed_at || ""));
    if (Number.isFinite(claimedAt) && claimedAt + staleAfterSeconds * 1000 < nowMs) return "stale";
  }
  return localState;
}

export function buildSourceHashMap(context, relativePaths, session = null) {
  const result = {};
  for (const relativePath of relativePaths) {
    if (session) {
      try {
        result[relativePath] = session.hash(relativePath);
      } catch (error) {
        if (error?.code !== "path_missing") throw error;
      }
      continue;
    }
    const filePath = resolveProjectFilePath(context, relativePath, { mustExist: false });
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      result[relativePath] = hashFile(filePath);
    }
  }
  return result;
}

export function isExpired(value) {
  if (!value) {
    return false;
  }
  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) && timestamp < Date.now();
}

export function buildIndex(context) {
  const session = openProjectQuerySession(context);
  const sourceSnapshot = collectKnowledgeSourceSnapshot(context, session);
  const sourceFiles = sourceSnapshot.source_paths
    .map((relativePath) => path.join(context.root, ...relativePath.split("/")));
  const sourceHashes = { ...sourceSnapshot.source_hashes };
  const entries = [];
  for (const filePath of sourceFiles) {
    const relativePath = toProjectPath(context, filePath);
    const extension = path.extname(filePath);
    const raw = session.readTextAtHash(relativePath, sourceHashes[relativePath]);
    const text = normalizeText(raw);
    entries.push({
      path: relativePath,
      title: inferTitle(filePath, raw),
      extension,
      size_bytes: Buffer.byteLength(raw),
      snippet: text.slice(0, 240),
      search_text: text,
    });
  }
  return {
    schema_version: context.config.schema_version,
    generated_at: now(),
    root: context.root,
    source_paths: Object.keys(sourceHashes).sort(),
    source_hashes: sourceHashes,
    entries,
  };
}

export function writerTemporaryMatches(filePath, expectedIdentity) {
  if (!expectedIdentity) return false;
  try {
    const entry = fs.lstatSync(filePath, IDENTITY_STAT_OPTIONS);
    return !entry.isSymbolicLink()
      && entry.isFile()
      && sameFileIdentityValues(entry, expectedIdentity);
  } catch {
    return false;
  }
}

export function assertOwnedWriterTemporary(filePath, expectedIdentity) {
  if (!writerTemporaryMatches(filePath, expectedIdentity)) {
    fail(`Temporary file ownership changed before publication: ${filePath}`);
  }
}

export function removeOwnedWriterTemporary(filePath, expectedIdentity, authorization) {
  if (!writerTemporaryMatches(filePath, expectedIdentity)) return false;
  assertMutationExecutionAuthorized(authorization);
  fs.rmSync(filePath);
  return true;
}

export function appendJsonLine(filePath, value) {
  return withGovernedMutation({ operation: "file.append", path: filePath }, () => {
    assertMutationExecutionAuthorized({ operation: "file.append", path: filePath });
    assertNoSymlinkPathSegments(filePath);
    ensureDir(path.dirname(filePath));
    const releaseLock = acquireFileLock(`${filePath}.lock`);
    try {
      assertJsonLineTailComplete(filePath);
      assertMutationExecutionAuthorized({ operation: "file.append", path: filePath });
      appendJsonLineNoFollow(filePath, value);
    } finally {
      releaseLock();
    }
  });
}

export function assertJsonLineTailComplete(filePath) {
  if (!fs.existsSync(filePath)) return;
  assertNoSymlinkPathSegments(filePath);
  const parentIdentity = captureDirectoryIdentity(path.dirname(filePath));
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | NO_FOLLOW_FLAG);
    verifyOpenFileMatchesPath(descriptor, filePath, parentIdentity);
    const size = fs.fstatSync(descriptor).size;
    if (size === 0) return;
    const finalByte = Buffer.allocUnsafe(1);
    const bytesRead = fs.readSync(descriptor, finalByte, 0, 1, size - 1);
    if (bytesRead !== 1 || finalByte[0] !== 0x0A) {
      fail(`Cannot append to an incomplete JSONL record: ${filePath}. Recover the interrupted owner first.`);
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/**
 * Create one directory, treating a concurrent creation as success.
 *
 * `mkdir` is deliberately not recursive: creating each segment separately is
 * what lets the symlink check above run on every one of them. That leaves a
 * window where another process creates the same directory between the
 * existence check and the call, so a failure there is an expected outcome
 * rather than a fault.
 *
 * The race is recognized by its result, not by its error code. `EEXIST` is the
 * POSIX answer, but Windows reports concurrent directory work as `EPERM`,
 * `EACCES`, or `EBUSY` — the same spread the internal lock already allows for.
 * Checking whether the path is now a stable directory covers every one of them
 * and still cannot hide a real failure: a `mkdir` refused for permissions
 * leaves nothing behind, so the original error is rethrown. A path that lost
 * the race must still pass the symlink check, because the entry that won it
 * could have been planted by another process.
 */
export function createDirectoryAllowingConcurrentCreation(dirPath) {
  try {
    fs.mkdirSync(dirPath);
    return true;
  } catch (error) {
    if (!fs.existsSync(dirPath)) throw error;
    assertStableDirectory(dirPath);
    return false;
  }
}

export function countFiles(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return 0;
  }
  return walkFiles(dirPath).length;
}

export function countCanonicalRecords(directory, dirPath) {
  if (directory !== "stories") {
    return countFiles(dirPath);
  }
  return safeReadDir(dirPath).filter((entry) => {
    const recordPath = path.join(dirPath, entry, "story.json");
    try {
      const stat = fs.lstatSync(recordPath);
      return stat.isFile() && !stat.isSymbolicLink();
    } catch {
      return false;
    }
  }).length;
}

export function now() {
  return new Date().toISOString();
}

export function shortDate() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, "");
}

export function compactTimestamp() {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

export function uniqueRecordSuffix() {
  return `${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${crypto.randomBytes(3).toString("hex")}`;
}
