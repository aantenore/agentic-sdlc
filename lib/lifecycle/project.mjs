import path from "node:path";
import {
  AUTONOMY_LEVELS,
} from "../autonomy-policy.mjs";
import {
  openCanonicalQuerySession,
} from "../canonical-query-session.mjs";
import {
  fail,
} from "../cli/user-error.mjs";
import {
  collectCodeBurnMeteringSnapshot,
} from "../codeburn-metering-adapter.mjs";
import {
  collectCodexSessionMeteringSnapshot,
} from "../codex-session-metering-adapter.mjs";
import {
  currentMutationGovernance,
} from "../governance/mutation-guard.mjs";
import {
  computeExactMeteringPolicyHash,
} from "../metering-attestations.mjs";
import {
  describeRedactionPolicy,
} from "../observability/redaction.mjs";
import {
  ProjectPathSafetyError,
  assertNoSymlinkSegmentsWithinBoundary,
} from "../project-path-safety.mjs";
import {
  RTK_ADAPTER_ID,
} from "../rtk-optimization-adapter.mjs";
import {
  assessmentProposalPath,
} from "./authorization.mjs";
import {
  assertSafeSdlcRelativeDirectory,
  compareSemanticVersions,
  getOptionString,
  hashBuffer,
  normalizeId,
} from "./common.mjs";
import {
  AUTONOMY_ROLLOUT_MODES,
  PROJECT_BOOTSTRAP_JOURNAL_FILE_NAME,
  PROJECT_BOOTSTRAP_JOURNAL_SCHEMA_VERSION,
  PROJECT_BOOTSTRAP_MANIFEST_FILE_NAME,
  PROJECT_BOOTSTRAP_MANIFEST_INTRODUCED_VERSION,
  PROJECT_CONFIG_LOCK_FILE_NAME,
  SDLC_DIR,
  TRACE_EVIDENCE_POLICY_SOURCE_ROOT,
} from "./constants.mjs";
import {
  deliveryExecutionRoot,
} from "./delivery.mjs";
import {
  assertTraceEvidencePolicySourceSafety,
} from "./output.mjs";
import {
  buildTraceRedactionPolicy,
  traceIntegrityCheckpointPath,
} from "./story.mjs";
import {
  assessmentWorkflowDirectory,
} from "./workflow.mjs";

export function mergeMissingConfigDefaults(projectConfig, templateConfig) {
  if (!projectConfig || typeof projectConfig !== "object" || Array.isArray(projectConfig)) {
    return projectConfig;
  }
  const merge = (current, defaults) => {
    if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) {
      return current === undefined ? structuredClone(defaults) : current;
    }
    if (current === undefined) {
      return structuredClone(defaults);
    }
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return current;
    }
    const result = { ...current };
    for (const [key, value] of Object.entries(defaults)) {
      result[key] = merge(current[key], value);
    }
    return result;
  };
  return merge(projectConfig, templateConfig);
}

export function normalizeRequestedAutonomyMode(options) {
  const requested = getOptionString(options, "autonomy-mode");
  if (!requested) return null;
  if (!AUTONOMY_ROLLOUT_MODES.has(requested)) {
    fail(
      `Invalid --autonomy-mode '${requested}'. Valid values: `
      + `${Array.from(AUTONOMY_ROLLOUT_MODES).join(", ")}.`,
    );
  }
  return requested;
}

export function configMigrationChangeSummary(plan) {
  if (plan.mode === "already_locked") {
    return "The current configuration and lock already match; applying this plan will make no changes.";
  }
  if (plan.mode === "update_config") {
    return `Applying this plan will update ${plan.changes.length} reviewed project policy value(s) and replace the matching lock.`;
  }
  if (plan.mode === "reconcile_drift") {
    return "Applying this plan will accept the current materialized configuration and replace its stale lock.";
  }
  if (plan.changes.length === 0) {
    return "Applying this plan will keep the current configuration and create its first lock.";
  }
  return `Applying this plan will materialize ${plan.changes.length} reviewed configuration change(s) and create a matching lock.`;
}

export function configMigrationPlanPresentation(plan, { full = false } = {}) {
  if (full) {
    return {
      detail_level: "full",
      omitted_fields: [],
      plan_complete: true,
      plan_hash_verification: "self-contained",
      plan,
    };
  }
  const {
    target_config: _targetConfig,
    ...compactPlan
  } = plan;
  return {
    detail_level: "compact",
    omitted_fields: ["plan.target_config"],
    plan_complete: false,
    plan_hash_verification: "requires_full_preview",
    plan: compactPlan,
  };
}

export function configMigrationBootstrapMutations(context, plan) {
  const transactionLock = path.join(context.sdlcRoot, "locks", "config-migration.lock");
  const receiptPath = path.join(
    context.sdlcRoot,
    "migrations",
    "config",
    `MIG-CONFIG-${plan.plan_hash.slice(0, 16)}.json`,
  );
  const tracePath = path.join(context.sdlcRoot, "traces", "project.jsonl");
  const traceCheckpoint = traceIntegrityCheckpointPath(tracePath);
  const traceCheckpointBackup = `${traceCheckpoint}.previous`;
  const tracePolicy = buildTraceRedactionPolicy(context);
  const tracePolicySource = describeRedactionPolicy(tracePolicy);
  assertTraceEvidencePolicySourceSafety(tracePolicySource);
  const tracePolicyBytes = `${JSON.stringify(tracePolicySource, null, 2)}\n`;
  const tracePolicyPath = path.join(
    context.root,
    TRACE_EVIDENCE_POLICY_SOURCE_ROOT,
    `${hashBuffer(Buffer.from(tracePolicyBytes, "utf8"))}.json`,
  );
  const exact = [
    ["directory.create", path.join(context.sdlcRoot, "locks")],
    ["lock.acquire", transactionLock],
    ["lock.reclaim", transactionLock],
    ["lock.release", transactionLock],
    ["file.write", context.projectConfigPath],
    ["file.write", context.configLockPath],
    ["file.remove", context.configLockPath],
    ["directory.create", path.join(context.sdlcRoot, "migrations")],
    ["directory.create", path.join(context.sdlcRoot, "migrations", "config")],
    ["file.write", receiptPath],
    ["file.remove", receiptPath],
    ["directory.create", path.dirname(tracePolicyPath)],
    ["lock.acquire", `${tracePolicyPath}.lock`],
    ["lock.release", `${tracePolicyPath}.lock`],
    ["file.write", tracePolicyPath],
    ["lock.acquire", `${tracePath}.lock`],
    ["lock.release", `${tracePath}.lock`],
    ["directory.create", path.dirname(traceCheckpoint)],
    ["path.chmod", path.dirname(traceCheckpoint)],
    ["lock.acquire", `${traceCheckpoint}.lock`],
    ["lock.remove", `${traceCheckpoint}.lock`],
    ["file.append", tracePath],
    ["file.truncate", tracePath],
    ["file.write", traceCheckpoint],
    ["file.remove", traceCheckpoint],
    ["path.rename.source", traceCheckpoint],
    ["path.rename.target", traceCheckpoint],
    ["path.rename.source", traceCheckpointBackup],
    ["path.rename.target", traceCheckpointBackup],
    ["file.remove", traceCheckpointBackup],
  ].map(([operation, filePath]) => ({ operation, path: filePath }));
  return [...new Map(exact.map((entry) => [`${entry.operation}\0${path.resolve(entry.path)}`, entry])).values()];
}

export function validateAutonomyPolicy(policy) {
  if (policy === undefined) {
    return;
  }
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    fail("autonomy_policy must be an object");
  }
  if (!AUTONOMY_ROLLOUT_MODES.has(String(policy.mode || ""))) {
    fail("autonomy_policy.mode must be off, observe, enforce_new_only, or enforce_all");
  }
  const levels = Array.isArray(policy.allowed_levels) ? policy.allowed_levels : [];
  const requiredLevels = AUTONOMY_LEVELS;
  if (requiredLevels.some((level) => !levels.includes(level))) {
    fail(`autonomy_policy.allowed_levels must include ${requiredLevels.join(", ")}`);
  }
  const deliveryKinds = Array.isArray(policy.delivery_kinds) ? policy.delivery_kinds : [];
  if (["pull_request", "local_release"].some((kind) => !deliveryKinds.includes(kind))) {
    fail("autonomy_policy.delivery_kinds must include pull_request and local_release");
  }
  assertSafeSdlcRelativeDirectory(policy.storage_root || "autonomy", "autonomy_policy.storage_root");
}

export function projectBootstrapDirectoryAncestorClosure(context, directoryPaths) {
  const projectRoot = path.resolve(context.root);
  const sdlcRoot = path.resolve(context.sdlcRoot);
  if (sdlcRoot !== path.resolve(projectRoot, SDLC_DIR)) {
    fail("Project bootstrap directory inventory is not bound to the canonical .sdlc root.");
  }
  assertNoSymlinkSegmentsWithinBoundary(projectRoot, sdlcRoot);

  const closure = new Map();
  for (const directoryPath of directoryPaths) {
    let current = path.resolve(String(directoryPath));
    if (!isInsidePath(sdlcRoot, current)) {
      fail(`Project bootstrap directory escapes the canonical .sdlc root: ${directoryPath}`);
    }
    assertNoSymlinkSegmentsWithinBoundary(projectRoot, current);
    while (true) {
      closure.set(current, current);
      if (current === sdlcRoot) break;
      const parent = path.dirname(current);
      if (parent === current || !isInsidePath(sdlcRoot, parent)) {
        fail(`Project bootstrap directory has an ambiguous ancestor chain: ${directoryPath}`);
      }
      current = parent;
    }
  }
  closure.set(sdlcRoot, sdlcRoot);
  return [...closure.values()].sort((left, right) => {
    const depthDifference = left.split(path.sep).length - right.split(path.sep).length;
    return depthDifference || left.localeCompare(right);
  });
}

export function readContextOptimizationPolicy(context) {
  const configured = context.config.context_optimization_policy || {};
  const provider = configured.provider || {};
  const command = provider.command || {};
  return {
    enabled: configured.enabled !== false,
    mode: configured.mode || "automatic",
    fallback: configured.fallback || "native",
    storage_root: configured.storage_root || "context-optimization",
    provider: {
      id: provider.id || RTK_ADAPTER_ID,
      minimum_version: provider.minimum_version || "0.43.0",
      command: {
        executable: command.executable || "rtk",
        arguments: Array.isArray(command.arguments) ? command.arguments : [],
      },
    },
    response_provider: {
      id: configured.response_provider?.id || "caveman",
      version: configured.response_provider?.version || "1.9.1",
      skill: configured.response_provider?.skill || "../caveman/SKILL.md",
      mode: configured.response_provider?.mode || "adaptive",
      default_intensity: configured.response_provider?.default_intensity || "full",
      auto_clarity: configured.response_provider?.auto_clarity !== false,
      usage_accounting: configured.response_provider?.usage_accounting || "measured_net_usage_only",
    },
    telemetry: {
      enabled: configured.telemetry?.enabled !== false,
      include_in_budget_status: configured.telemetry?.include_in_budget_status !== false,
      auto_capture: Array.isArray(configured.telemetry?.auto_capture)
        ? configured.telemetry.auto_capture
        : ["apply", "checkpoint", "complete"],
    },
    budget_trigger_statuses: Array.isArray(configured.budget_trigger_statuses)
      ? configured.budget_trigger_statuses
      : ["warning", "soft_limit", "completion_reserve"],
  };
}

export function configuredRtkOptions(context, trust) {
  const policy = readContextOptimizationPolicy(context);
  if (!trust?.allowed || !trust.execution_executable) {
    throw new Error("RTK provider options require an allowed, resolved invocation");
  }
  return {
    executable: trust.execution_executable,
    prefix_args: policy.provider.command.arguments,
    minimum_version: policy.provider.minimum_version,
    cwd: context.root,
  };
}

export function contextOptimizationRuntimeOptions(options = {}, extra = {}) {
  return {
    ...extra,
    allow_custom_provider: options["trust-custom-rtk-command"] === true,
  };
}

export function contextOptimizationExecutionRoot(context, proposalId) {
  const configured = readContextOptimizationPolicy(context).storage_root;
  assertSafeSdlcRelativeDirectory(configured, "context_optimization_policy.storage_root");
  return path.join(context.sdlcRoot, configured, normalizeId(proposalId));
}

export function contextOptimizationObservationsRoot(context, proposalId) {
  return path.join(contextOptimizationExecutionRoot(context, proposalId), "observations");
}

export function projectBootstrapJournalPath(context) {
  return path.join(context.sdlcRoot, PROJECT_BOOTSTRAP_JOURNAL_FILE_NAME);
}

export function projectBootstrapJournalReference(requestHash) {
  return {
    path: `${SDLC_DIR}/${PROJECT_BOOTSTRAP_JOURNAL_FILE_NAME}`,
    schema_version: PROJECT_BOOTSTRAP_JOURNAL_SCHEMA_VERSION,
    request_hash: requestHash,
  };
}

export function projectBootstrapRecoveryResult(context, project, configLock, manifest) {
  return {
    payload: {
      status: "initialized",
      recovered: true,
      root: context.root,
      sdlc_root: context.sdlcRoot,
      project,
      config_lock: {
        path: `${SDLC_DIR}/${PROJECT_CONFIG_LOCK_FILE_NAME}`,
        hash: configLock.lock_hash,
      },
      bootstrap_manifest: {
        path: `${SDLC_DIR}/${PROJECT_BOOTSTRAP_MANIFEST_FILE_NAME}`,
        hash: manifest.manifest_hash,
      },
      contracts_created: [],
    },
    messages: [
      `Recovered the exact interrupted Agentic SDLC bootstrap at ${SDLC_DIR}.`,
      `Project: ${project.project_name} (${project.project_id})`,
      "No project identity or core bootstrap record was regenerated.",
      `Bootstrap completion sealed: ${SDLC_DIR}/${PROJECT_BOOTSTRAP_MANIFEST_FILE_NAME}`,
    ],
  };
}

export function projectVersionRequiresBootstrapManifest(version) {
  const comparison = compareSemanticVersions(
    version,
    PROJECT_BOOTSTRAP_MANIFEST_INTRODUCED_VERSION,
  );
  return comparison === null || comparison >= 0;
}

export function failIncompleteExistingBootstrap(problems) {
  fail(
    `Existing ${SDLC_DIR} bootstrap is incomplete: ${problems.join("; ")}. No files were changed. `
    + "Restore the canonical files or completed bootstrap manifest from version control. "
    + "If this directory came only from an interrupted first onboarding, preserve any useful evidence and archive the incomplete .sdlc outside the project before rerunning onboard.",
  );
}

export function autonomyRoot(context) {
  const configured = context.config.autonomy_policy?.storage_root || "autonomy";
  assertSafeSdlcRelativeDirectory(configured, "autonomy_policy.storage_root");
  return path.join(context.sdlcRoot, configured);
}

export function autonomyDecisionsRoot(context) {
  return path.join(autonomyRoot(context), "decisions");
}

export function autonomyRevocationsRoot(context) {
  return path.join(autonomyRoot(context), "revocations");
}

export function autonomyExecutionsRoot(context) {
  return path.join(autonomyRoot(context), "executions");
}

export function autonomyActionsRoot(context) {
  return path.join(autonomyRoot(context), "actions");
}

export function executionContextPreflightPath(context, profileId) {
  return path.join(deliveryExecutionRoot(context, profileId), "context-preflight.json");
}

export function pathMatchesApprovedWriteScope(filePath, allowedPaths) {
  const normalized = String(filePath || "").replace(/\\/gu, "/").replace(/^\.\//u, "");
  return allowedPaths.some((allowedPath) => {
    const allowed = String(allowedPath || "").replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/\/$/u, "");
    return normalized === allowed || normalized.startsWith(`${allowed}/`);
  });
}

export function recordedPathInside(platform, parent, child) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const relative = pathApi.relative(pathApi.resolve(parent), pathApi.resolve(child));
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${pathApi.sep}`)
    && !pathApi.isAbsolute(relative)
  );
}

export function autonomyRevocationSubject(record) {
  return {
    profile_id: record.profile_ref?.id,
    profile_hash: record.profile_ref?.hash,
    reason: record.reason,
  };
}

export function completionRequestExecutionProjection(request) {
  if (!request || typeof request !== "object") return null;
  const projection = { ...request };
  delete projection.outcome;
  delete projection.request_hash;
  return projection;
}

export function assessmentsRoot(context) {
  const configured = context.config.assessment_workflow?.storage_root || "assessments";
  assertSafeSdlcRelativeDirectory(configured, "assessment_workflow.storage_root");
  return path.join(context.sdlcRoot, configured);
}

export function assessmentApplicationsRoot(context) {
  return assessmentWorkflowDirectory(context, "applications", "applications");
}

export function assessmentBudgetsRoot(context, proposalId = null) {
  const configured = context.config.budget_policy?.storage_root || "budgets";
  assertSafeSdlcRelativeDirectory(configured, "budget_policy.storage_root");
  const root = path.join(context.sdlcRoot, configured);
  return proposalId ? path.join(root, normalizeId(proposalId)) : root;
}

export function assessmentApplicationPath(context, id) {
  return path.join(assessmentApplicationsRoot(context), `${normalizeId(id)}.json`);
}

export function assessmentBudgetSnapshotPath(context, proposalId) {
  return path.join(assessmentBudgetsRoot(context, proposalId), "effective-budget.json");
}

export function assessmentAuthorizedUseDefinitions(context, proposal) {
  const proposalRef = {
    id: proposal.id,
    path: toProjectPath(context, assessmentProposalPath(context, proposal.id)),
    hash: proposal.proposal_hash,
  };
  return {
    proposalRef,
    uses: [
      {
        action: "assessment.proposal.apply",
        settings: {
          proposal_ref: proposalRef,
          subject_id: proposal.id,
          artifact_types: [proposal.deliverable.artifact_type],
        },
      },
      ...proposal.write_set.map((entry) => ({
        action: entry.action,
        settings: {
          proposal_ref: proposalRef,
          subject_id: entry.subject_id,
          artifact_types: entry.artifact_types || [],
        },
      })),
      {
        action: "assessment.proposal.complete",
        settings: {
          proposal_ref: proposalRef,
          subject_id: proposal.id,
          artifact_types: [proposal.deliverable.artifact_type],
        },
      },
    ],
  };
}

export function assessmentUsageRoot(context, proposalId) {
  return path.join(assessmentBudgetsRoot(context, proposalId), "usage");
}

export function assessmentAmendmentsRoot(context, proposalId) {
  return path.join(assessmentBudgetsRoot(context, proposalId), "amendments");
}

export function assessmentBudgetMutationLockPath(context, proposalId) {
  return path.join(assessmentBudgetsRoot(context, proposalId), "mutation.lock");
}

export function exactMeteringMetrics(receipt) {
  return Object.entries(receipt?.metering || {})
    .filter(([, level]) => level === "exact")
    .map(([metric]) => metric)
    .sort();
}

export function exactMeteringPolicyTrustErrors(context, budget) {
  const hardMetrics = Object.entries(budget?.limits || {})
    .filter(([, spec]) => spec.hard !== null && spec.hard !== undefined)
    .map(([metric]) => metric);
  if (hardMetrics.length === 0) return [];
  const policy = context.config.budget_policy?.exact_metering;
  const approvedHash = budget?.extensions?.exact_metering_policy_hash;
  if (!policy || !approvedHash) {
    return ["hard-limit budget is missing its approved exact_metering policy hash"];
  }
  let currentHash;
  try {
    currentHash = computeExactMeteringPolicyHash(policy);
  } catch (error) {
    return [`current exact_metering policy cannot be hashed: ${error.message}`];
  }
  return currentHash === approvedHash
    ? []
    : [`exact_metering policy changed after budget approval (approved ${approvedHash}, current ${currentHash}); prepare and approve a new proposal`];
}

export function budgetMeterRoot(context, proposalId, adapterId) {
  return path.join(assessmentBudgetsRoot(context, proposalId), "metering", normalizeId(adapterId));
}

export function resolveBudgetMeterMapping(budget, config, adapter) {
  const allowedSources = new Set(adapter.supported_sources);
  if (!config.metric_mapping || typeof config.metric_mapping !== "object" || Array.isArray(config.metric_mapping)) {
    fail(`${adapter.label} metric_mapping must be a configuration object.`);
  }
  const mapping = {};
  for (const [metric, source] of Object.entries(config.metric_mapping)) {
    if (!Object.hasOwn(budget.limits, metric)) {
      continue;
    }
    if (!allowedSources.has(source)) {
      fail(`${adapter.label} metric_mapping.${metric} uses unsupported source '${source}'.`);
    }
    const spec = budget.limits[metric];
    if (source === "cost" && !spec.currency) {
      fail(`${adapter.label} cost mapping requires budget metric '${metric}' to declare currency.`);
    }
    if (source.startsWith("tokens.") && spec.unit !== "tokens") {
      fail(`${adapter.label} token source '${source}' requires budget metric '${metric}' to use unit 'tokens'.`);
    }
    mapping[metric] = source;
  }
  if (Object.keys(mapping).length === 0) {
    fail(`${adapter.label} has no configured mapping for this budget. Budget metrics: ${Object.keys(budget.limits).join(", ")}.`);
  }
  return Object.fromEntries(Object.entries(mapping).sort(([left], [right]) => left.localeCompare(right)));
}

export function budgetMeterExecutionOptions(context, config) {
  const command = config.command;
  return {
    cwd: context.root,
    ...(command ? {
      executable: command.executable,
      prefix_args: command.arguments,
    } : {}),
  };
}

export async function collectCodeBurnBudgetMeterSnapshot(context, _proposalId, config, query, idPrefix) {
  try {
    return await collectCodeBurnMeteringSnapshot(
      {
        id: normalizeId(`${idPrefix}-SNAPSHOT`),
        query,
      },
      budgetMeterExecutionOptions(context, config),
    );
  } catch (error) {
    fail(`CodeBurn collection failed: ${error.message}${error.stderr ? `; ${error.stderr}` : ""}`);
  }
}

export async function collectCodexSessionBudgetMeterSnapshot(
  context,
  _proposalId,
  _config,
  query,
  idPrefix,
  options,
) {
  try {
    return await collectCodexSessionMeteringSnapshot(
      {
        id: normalizeId(`${idPrefix}-SNAPSHOT`),
        query,
      },
      {
        project_root: context.root,
        session_file: getOptionString(options, "session-file") || undefined,
      },
    );
  } catch (error) {
    fail(`Codex session collection failed: ${error.message}`);
  }
}

export async function collectBudgetMeterSnapshot(
  context,
  proposalId,
  adapter,
  config,
  query,
  idPrefix,
  options,
) {
  return adapter.collect(context, proposalId, config, query, idPrefix, options);
}

export function workItemsRoot(context) {
  return path.join(context.sdlcRoot, "work-items");
}

export function dependenciesRoot(context) {
  return path.join(context.sdlcRoot, "dependencies");
}

export function workItemPath(context, type, id) {
  const directory = type === "epic" ? "epics" : type === "task" ? "tasks" : `${type}s`;
  return path.join(workItemsRoot(context), directory, `${id}.json`);
}

export function testRunsRoot(context) {
  return path.join(context.sdlcRoot, "tests");
}

export function operationsRoot(context) {
  return path.join(context.sdlcRoot, "operations");
}

export function secretScansRoot(context) {
  return path.join(context.sdlcRoot, "security");
}

export function codeReviewsRoot(context) {
  return path.join(context.sdlcRoot, "reviews");
}

export function logicalArchiveRoot(context) {
  return configuredSdlcDirectory(
    context,
    context.config.release_evidence_policy?.archive_directory,
    "archive",
    "release_evidence_policy.archive_directory",
  );
}

export function configuredSdlcDirectory(context, configuredValue, fallback, label) {
  const raw = String(configuredValue || fallback).trim().replaceAll("\\", "/");
  const relative = raw.startsWith(`${SDLC_DIR}/`) ? raw.slice(`${SDLC_DIR}/`.length) : raw;
  assertSafeSdlcRelativeDirectory(relative, label);
  return path.join(context.sdlcRoot, relative);
}

export function normalizeProjectPathInput(rawPath) {
  return String(rawPath || "").trim().replace(/\\/g, "/");
}

export function assertPathInsideRoot(context, resolvedPath, label) {
  if (!isInsidePath(context.root, resolvedPath)) {
    fail(`Path must stay inside the target project root: ${label}`);
  }
}

export function toProjectPath(context, filePath) {
  return path.relative(context.root, path.resolve(filePath)).split(path.sep).join("/");
}

export function isDerivedArtifactPath(context, filePath) {
  if (!isInsidePath(context.sdlcRoot, filePath)) {
    return false;
  }
  const relative = path.relative(context.sdlcRoot, path.resolve(filePath));
  const first = relative.split(path.sep)[0];
  const derived = new Set(context.config.cache_policy?.derived_directories || ["cache", "indexes"]);
  return derived.has(first);
}

export function openProjectQuerySession(context) {
  return openCanonicalQuerySession({
    root: context.root,
    canonicalRoot: SDLC_DIR,
    derivedDirectories: context.config.cache_policy?.derived_directories,
  });
}

export function autonomyDecisionSemanticProjection(decision) {
  if (!decision || typeof decision !== "object") return null;
  const {
    id: _id,
    evaluated_at: _evaluatedAt,
    decision_hash: _decisionHash,
    hash_algorithm: _hashAlgorithm,
    ...semantic
  } = decision;
  return semantic;
}

export function assertNoSymlinkPathSegments(filePath, boundaryRoot = currentMutationGovernance()?.root) {
  const resolved = path.resolve(filePath);
  if (!boundaryRoot) {
    fail(`Cannot validate path without a trusted project boundary: ${resolved}`);
  }
  try {
    assertNoSymlinkSegmentsWithinBoundary(path.resolve(boundaryRoot), resolved);
  } catch (error) {
    if (error instanceof ProjectPathSafetyError) {
      fail(error.message);
    }
    throw error;
  }
}

export function isInsidePath(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export function buildContextOptimizationMetadata({ profile, omittedFields, omittedBytes, fullPayloadFlag }) {
  return {
    profile,
    lossless_for_reported_fields: true,
    omitted_fields: omittedFields,
    omitted_bytes: omittedBytes,
    estimated_tokens_avoided: Math.ceil(omittedBytes / 4),
    full_payload_flag: fullPayloadFlag,
  };
}
