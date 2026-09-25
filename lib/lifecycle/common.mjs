import crypto from "node:crypto";
import path from "node:path";
import {
  computeStableHash,
} from "../canonical.mjs";
import {
  UnknownCommandError,
} from "../cli/help.mjs";
import {
  CliPresetError,
} from "../cli/presets.mjs";
import {
  UsageError,
  UserError,
  fail,
} from "../cli/user-error.mjs";
import {
  inspectZipContainer as inspectZipContainerStructure,
  readZipEntry as readZipEntryBytes,
} from "../evidence-formats.mjs";
import {
  fileIdentity,
  sameStatTime,
} from "../file-identity.mjs";
import {
  MutationGovernanceError,
} from "../governance/mutation-guard.mjs";
import {
  approvalIssueSeverity,
  hashApprovalSubject,
  latestApprovedRecordApproval,
  sameStableFileIdentity,
} from "./authorization.mjs";
import {
  UnsupportedNodeRuntimeError,
} from "./classes.mjs";
import {
  ACTIVITY_REPORT_VIEWS,
  EXIT_CODES,
  INTERNAL_ERROR_CAUSE_FIELDS,
  LEGACY_CONFIG_PROFILE_ID,
  REPORT_QUERY_SUBJECTS,
  ROUTE_DEFAULT_CONFIDENCE,
  ROUTE_DEFAULT_ROUTES,
  WORK_ITEM_CREATE_TYPES,
  WORK_ITEM_TYPES,
} from "./constants.mjs";
import {
  deliveryAutonomyPath,
  localReleaseTargetHadOnlyDirectories,
  localReleaseTargetStateMatches,
} from "./delivery.mjs";
import {
  withEvidenceFormatFailure,
} from "./output.mjs";
import {
  isDerivedArtifactPath,
  toProjectPath,
} from "./project.mjs";
import {
  defaultRouteActions,
  normalizeRouteActionMap,
  normalizeRouteToken,
} from "./route.mjs";
import {
  baselineRoot,
  traceActorKey,
  traceActorMatches,
} from "./story.mjs";

export function cliHandler(stage, handle) {
  return { stage, handle };
}

export function mutationGovernanceActor(options) {
  const assertedId = getOptionString(options, "actor")
    || getOptionString(options, "actor-name")
    || "local-cli";
  const assertedType = getOptionString(options, "actor-type")
    || (getOptionString(options, "actor") ? "agent" : "system");
  return { type: assertedType, id: assertedId };
}

export function instanceDefinitionReference(instance) {
  return instance.definition_ref
    || instance.workflow_definition_ref
    || instance.effective_definition_ref?.definition_ref
    || instance.definition;
}

export function instanceOverlayReference(instance) {
  return instance.overlay_ref
    || instance.workflow_overlay_ref
    || instance.effective_definition_ref?.overlay_ref
    || instance.overlay
    || null;
}

export function referenceId(reference, prefix) {
  return reference?.id || reference?.[`${prefix}_id`] || null;
}

export function referenceVersion(reference, prefix) {
  return reference?.version || reference?.[`${prefix}_version`] || null;
}

export function rawBooleanOptionRequested(argv, optionName) {
  const exact = `--${optionName}`;
  const inlinePrefix = `${exact}=`;
  let requested = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === exact) {
      const next = argv[index + 1];
      if (next !== undefined && /^(?:true|false)$/iu.test(next)) {
        requested ||= next.toLowerCase() === "true";
        index += 1;
      } else {
        requested = true;
      }
      continue;
    }
    if (arg.startsWith(inlinePrefix)) {
      requested ||= arg.slice(inlinePrefix.length).toLowerCase() === "true";
    }
  }
  return requested;
}

export function rawStringOptionValue(argv, optionName) {
  const exact = `--${optionName}`;
  const inlinePrefix = `${exact}=`;
  let value;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === exact) {
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("-")) {
        value = next;
        index += 1;
      }
      continue;
    }
    if (arg.startsWith(inlinePrefix)) {
      value = arg.slice(inlinePrefix.length);
    }
  }
  return value;
}

/** The exit code for one thrown error, defaulting to the broadest category. */
export function exitCodeForError(error) {
  if (error instanceof UnsupportedNodeRuntimeError) return EXIT_CODES.environmentError;
  if (error instanceof UnknownCommandError) return EXIT_CODES.usageError;
  if (error instanceof CliPresetError) return EXIT_CODES.usageError;
  if (error instanceof UsageError) return EXIT_CODES.usageError;
  if (error instanceof MutationGovernanceError) return EXIT_CODES.governanceDenied;
  if (error instanceof UserError) return EXIT_CODES.userError;
  return EXIT_CODES.internalError;
}

export function internalErrorCauseDetails(error) {
  const cause = {};
  for (const [field, pattern] of Object.entries(INTERNAL_ERROR_CAUSE_FIELDS)) {
    let value;
    try {
      value = error?.[field];
    } catch {
      value = undefined;
    }
    if (typeof value === "string" && pattern.test(value)) cause[field] = value;
  }
  return Object.keys(cause).length > 0 ? { cause } : null;
}

export function cliErrorRedactionResolution(policy, withholdDetails) {
  return Object.freeze({ policy, withholdDetails });
}

export function parseBooleanOption(key, value) {
  if (value === true || value === false) {
    return value;
  }
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  fail(`Option --${key} expects true or false, received '${value}'`);
}

export function buildLegacyDefaultsProfile(legacyConfig) {
  return {
    id: LEGACY_CONFIG_PROFILE_ID,
    sha256: computeStableHash(legacyConfig),
  };
}

export function validateBranchPolicy(policy = {}) {
  const configured = policy?.branch_patterns ?? (policy?.branch_pattern ? [policy.branch_pattern] : []);
  if (!Array.isArray(configured)) {
    fail("parallel_work.branch_patterns must be an array");
  }
  for (const pattern of configured) {
    const value = String(pattern || "");
    const invalid =
      !value.includes("<story-id>") ||
      /[\\\s~^:?*\[]/.test(value) ||
      value.includes("..") ||
      value.includes("//") ||
      value.startsWith("/") ||
      value.endsWith("/") ||
      value.endsWith(".");
    if (invalid) {
      fail(`Invalid parallel_work branch pattern '${value}'`);
    }
  }
}

export function validateSdlcDirectoryList(values, field) {
  if (values === undefined) {
    return;
  }
  if (!Array.isArray(values)) {
    fail(`${field} must be an array`);
  }
  for (const value of values) {
    assertSafeSdlcRelativeDirectory(value, field);
  }
}

export function assertSafeSdlcRelativeDirectory(value, field) {
  const raw = String(value || "").trim();
  const normalized = path.posix.normalize(raw.replaceAll("\\", "/"));
  if (!raw || raw === "." || normalized === "." || normalized.startsWith("../") || normalized === ".." || path.isAbsolute(raw)) {
    fail(`${field} contains unsafe .sdlc-relative directory '${value}'`);
  }
  if (normalized.split("/").includes("..")) {
    fail(`${field} contains unsafe .sdlc-relative directory '${value}'`);
  }
}

export function validateRoutingPolicy(policy) {
  if (policy === undefined) {
    return;
  }
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    fail("routing_policy must be a JSON object");
  }
  if (policy.routes !== undefined && !Array.isArray(policy.routes)) {
    fail("routing_policy.routes must be an array");
  }
  if (policy.canonical_actions !== undefined && (!policy.canonical_actions || typeof policy.canonical_actions !== "object" || Array.isArray(policy.canonical_actions))) {
    fail("routing_policy.canonical_actions must be an object");
  }
  const confidence = policy.confidence;
  if (confidence !== undefined) {
    if (!confidence || typeof confidence !== "object" || Array.isArray(confidence)) {
      fail("routing_policy.confidence must be an object");
    }
    for (const key of ["auto_route_min", "confirm_min", "ask_below"]) {
      if (confidence[key] !== undefined) {
        const value = Number(confidence[key]);
        if (!Number.isFinite(value) || value < 0 || value > 1) {
          fail(`routing_policy.confidence.${key} must be a number between 0 and 1`);
        }
      }
    }
    if (confidence.always_confirm !== undefined && !Array.isArray(confidence.always_confirm)) {
      fail("routing_policy.confidence.always_confirm must be an array");
    }
  }
}

export function getRoutingPolicy(context) {
  const template = context.templateConfig.routing_policy || {};
  const project = context.config.routing_policy || {};
  const confidence = normalizeRoutingConfidence({
    ...ROUTE_DEFAULT_CONFIDENCE,
    ...(template.confidence || {}),
    ...(project.confidence || {}),
  });
  return {
    routes: new Set([
      ...ROUTE_DEFAULT_ROUTES,
      ...normalizeStringArray(template.routes),
      ...normalizeStringArray(project.routes),
    ]),
    confidence,
    canonical_actions: {
      ...defaultRouteActions(),
      ...normalizeRouteActionMap(template.canonical_actions || template.action_routes),
      ...normalizeRouteActionMap(project.canonical_actions || project.action_routes),
    },
    entity_types: {
      story: ["story"],
      contract: ["contract"],
      requirement: ["requirement"],
      template: ["template", "output_template"],
      ...(template.entity_types || {}),
      ...(project.entity_types || {}),
    },
  };
}

export function normalizeRoutingConfidence(confidence) {
  const normalized = {
    auto_route_min: Number(confidence.auto_route_min),
    confirm_min: Number(confidence.confirm_min),
    ask_below: Number(confidence.ask_below),
    always_confirm: normalizeStringArray(confidence.always_confirm).map(normalizeRouteToken),
  };
  if (!Number.isFinite(normalized.auto_route_min)) {
    normalized.auto_route_min = ROUTE_DEFAULT_CONFIDENCE.auto_route_min;
  }
  if (!Number.isFinite(normalized.confirm_min)) {
    normalized.confirm_min = ROUTE_DEFAULT_CONFIDENCE.confirm_min;
  }
  if (!Number.isFinite(normalized.ask_below)) {
    normalized.ask_below = ROUTE_DEFAULT_CONFIDENCE.ask_below;
  }
  normalized.ask_below = clamp01(normalized.ask_below);
  normalized.confirm_min = clamp01(normalized.confirm_min);
  normalized.auto_route_min = clamp01(normalized.auto_route_min);
  if (normalized.confirm_min < normalized.ask_below) {
    normalized.confirm_min = normalized.ask_below;
  }
  if (normalized.auto_route_min < normalized.confirm_min) {
    normalized.auto_route_min = normalized.confirm_min;
  }
  return normalized;
}

export function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

export function pushAllUnique(target, values) {
  for (const value of values) {
    if (value && !target.includes(value)) {
      target.push(value);
    }
  }
}

export function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value)));
}

export function arraysEqual(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

export function parseSemanticVersion(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.exec(
    String(value || "").trim(),
  );
  if (!match) return null;
  const core = match.slice(1, 4).map(Number);
  if (core.some((part) => !Number.isSafeInteger(part))) return null;
  const prerelease = match[4] ? match[4].split(".") : [];
  if (prerelease.some((part) => /^\d+$/u.test(part) && !Number.isSafeInteger(Number(part)))) {
    return null;
  }
  return { core, prerelease };
}

export function compareSemanticVersions(left, right) {
  const parsedLeft = parseSemanticVersion(left);
  const parsedRight = parseSemanticVersion(right);
  if (!parsedLeft || !parsedRight) return null;
  for (let index = 0; index < parsedLeft.core.length; index += 1) {
    if (parsedLeft.core[index] !== parsedRight.core[index]) {
      return parsedLeft.core[index] < parsedRight.core[index] ? -1 : 1;
    }
  }
  if (parsedLeft.prerelease.length === 0 || parsedRight.prerelease.length === 0) {
    if (parsedLeft.prerelease.length === parsedRight.prerelease.length) return 0;
    return parsedLeft.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(parsedLeft.prerelease.length, parsedRight.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = parsedLeft.prerelease[index];
    const rightPart = parsedRight.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    }
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/u.test(leftPart);
    const rightNumeric = /^\d+$/u.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) < Number(rightPart) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

export function buildDomainRecord(label, factory) {
  try {
    return factory();
  } catch (error) {
    fail(`${label}: ${error.message}`);
  }
}

export function canonicalAbsoluteUrl(value) {
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString().replace(/\/$/u, "");
  } catch {
    return null;
  }
}

export function hashBoundRecordIsValid(record, hashField) {
  if (!record || typeof record !== "object" || !/^[a-f0-9]{64}$/u.test(String(record[hashField] || ""))) {
    return false;
  }
  const subject = { ...record };
  delete subject[hashField];
  return record[hashField] === computeStableHash(subject);
}

export function activeLegacyLocalStartError(profile) {
  return (
    `Active local delivery ${profile.id} has a legacy start receipt without an immutable `
    + "local-target baseline, so it cannot authorize or complete another action. Create, approve, "
    + "and start a new exact delivery profile; changing the root or recomputing receipt hashes "
    + "cannot upgrade the historical start."
  );
}

export function localTargetBuildCompletionDetails(receipt) {
  return receipt?.action_details?.local_target_build_completion || null;
}

export function localTargetBuildPreconditionDetails(receipt) {
  return receipt?.action_details?.local_target_build_precondition || null;
}

export function localTargetPredecessorStateMatches(predecessor, observedSnapshot) {
  const baselineRoot = predecessor?.snapshot?.entries?.[0];
  const observedRoot = observedSnapshot?.entries?.[0];
  if (
    ["delivery_start", "legacy_delivery_start"].includes(predecessor?.ref?.source)
    && baselineRoot?.status === "directory"
    && localReleaseTargetHadOnlyDirectories(predecessor.snapshot)
  ) {
    return stableJson(baselineRoot) === stableJson(observedRoot);
  }
  return localReleaseTargetStateMatches(predecessor?.snapshot, observedSnapshot);
}

export function validateCommitCoverageProfileRef(context, profile, profileRef, label) {
  const expectedPath = toProjectPath(context, deliveryAutonomyPath(context, profile.id));
  if (
    profileRef?.id !== profile.id
    || profileRef?.path !== expectedPath
    || profileRef?.hash !== profile.profile_hash
  ) {
    return [`${label} profile reference is stale or non-canonical`];
  }
  return [];
}

export function mappedCodeBurnUsage(delta, budget, mapping) {
  const token = delta.usage.tokens;
  const total = [token.input, token.output, token.cache_read, token.cache_write]
    .reduce((sum, value) => sum + BigInt(value), 0n);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail("CodeBurn total token delta exceeds the JavaScript safe integer range.");
  }
  const sourceValues = {
    "tokens.total": Number(total),
    "tokens.input": token.input,
    "tokens.output": token.output,
    "tokens.cache_read": token.cache_read,
    "tokens.cache_write": token.cache_write,
    calls: delta.usage.calls,
    cost: delta.usage.cost,
  };
  const usage = {};
  for (const [metric, source] of Object.entries(mapping)) {
    if (source === "cost") {
      if (delta.usage.cost.currency !== budget.limits[metric].currency) {
        fail(`CodeBurn currency ${delta.usage.cost.currency} does not match budget metric ${metric} currency ${budget.limits[metric].currency}.`);
      }
      usage[metric] = delta.usage.cost;
    } else {
      usage[metric] = sourceValues[source];
    }
  }
  return usage;
}

export function completionReserveRisks(budget, decision) {
  const reserve = Number(budget.completion_reserve_percent ?? 0);
  if (!Number.isFinite(reserve) || reserve <= 0) {
    return [];
  }
  const threshold = 100 - reserve;
  return Object.entries(decision.utilization_percent || {})
    .filter(([, percent]) => percent !== null && Number(percent) >= threshold)
    .map(([metric, percent]) => ({ metric, utilization_percent: Number(percent), reserve_percent: reserve }));
}

export function normalizeAuthorizedActions(value) {
  const actions = normalizeListOption(value).map((action) => action.toLowerCase());
  for (const action of actions) {
    if (action !== "*" && !/^[a-z0-9][a-z0-9._-]*(?:\.\*)?$/.test(action)) {
      fail(`Invalid authorized action '${action}'. Use an exact CLI action such as contract.approve, a prefix such as capability.*, or *.`);
    }
  }
  return Array.from(new Set(actions));
}

export function matchesAny(value, terms) {
  return terms.some((term) => value.includes(term));
}

export function compactText(value, maxLength = 220) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

export function buildExecutionPolicy(context, overrides = {}) {
  const config = context.config.execution_policy || {};
  const runtime = String(config.runtime || "codex");
  const allowedReasoningLevels = normalizeReasoningLevels(config.reasoning_levels);
  const rawModel = normalizeScalarOption(
    overrides.model === undefined ? config.default_model : overrides.model,
    "model",
  );
  const rawReasoning = normalizeScalarOption(
    overrides.reasoning === undefined ? config.default_reasoning : overrides.reasoning,
    "reasoning",
  );
  const model = buildExecutionPolicySelection(rawModel, "value");
  const reasoning = buildExecutionPolicySelection(rawReasoning, "level", {
    allowedValues: allowedReasoningLevels,
    optionName: "reasoning",
  });

  return {
    runtime,
    model,
    reasoning,
    notes: [...(overrides.execution_notes || [])],
  };
}

export function buildExecutionPolicySelection(rawValue, valueKey, options = {}) {
  if (!rawValue || rawValue.toLowerCase() === "inherit") {
    return {
      mode: "inherit",
      [valueKey]: null,
    };
  }

  const value = valueKey === "level" ? rawValue.toLowerCase() : rawValue;
  if (options.allowedValues && !options.allowedValues.includes(value)) {
    fail(
      `Unknown --${options.optionName} '${rawValue}'. Valid values: ${options.allowedValues.join(", ")}`,
    );
  }

  return {
    mode: "override",
    [valueKey]: value,
  };
}

export function normalizeExecutionPolicySuggestions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { model: undefined, reasoning: undefined, notes: [] };
  }
  return {
    model: value.model && typeof value.model === "object" ? value.model.value || undefined : value.model || undefined,
    reasoning: value.reasoning && typeof value.reasoning === "object" ? value.reasoning.level || undefined : value.reasoning || undefined,
    notes: normalizeListValue(value.notes, []),
  };
}

export function approvedRecordIssueSeverity(context, report, record) {
  if (record?.status !== "approved") {
    return "warnings";
  }
  return approvalIssueSeverity(context, report, latestApprovedRecordApproval(record));
}

export function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (!value || typeof value !== "object") {
    return JSON.stringify(value);
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}

export function normalizeActorType(value) {
  const normalized = String(value || "unknown").trim().toLowerCase();
  const allowed = ["human", "agent", "system", "ci", "unknown"];
  if (!allowed.includes(normalized)) {
    fail(`Unknown --actor-type '${value}'. Valid values: ${allowed.join(", ")}`);
  }
  return normalized;
}

export function getOptionString(options = {}, ...keys) {
  for (const key of keys) {
    if (options[key] !== undefined) {
      return normalizeScalarOption(options[key], key);
    }
  }
  return null;
}

export function buildQuestionRecords(questions, qaItems) {
  const records = questions.map((question) => ({
    question,
    answer: null,
    status: "open",
  }));
  for (const item of qaItems) {
    const [question, ...answerParts] = String(item).split("|");
    const answer = answerParts.join("|").trim();
    records.push({
      question: question.trim(),
      answer: answer || null,
      status: answer ? "answered" : "open",
    });
  }
  return records.filter((record) => record.question);
}

export function mergeList(base, additions = []) {
  const merged = [...base];
  for (const item of additions) {
    if (!merged.includes(item)) {
      merged.push(item);
    }
  }
  return merged;
}

export function buildInferredContext(repoSnapshot, detectedStack, documents) {
  const primaryDocument = documents.find((document) => /(^|\/)readme\./i.test(document.path)) || documents[0] || null;
  return {
    product_signal: repoSnapshot.package_summary?.description || primaryDocument?.excerpt || null,
    document_map: documents.map((document) => ({
      path: document.path,
      title: document.title || null,
      headings: document.headings || [],
      summary: document.excerpt || null,
    })),
    architecture_signals: documents
      .filter((document) => /architecture|design|adr|api|requirement/i.test(`${document.path} ${(document.headings || []).join(" ")}`))
      .map((document) => ({ path: document.path, headings: document.headings || [], summary: document.excerpt || null })),
    component_roots: repoSnapshot.source_roots || [],
    runtime_and_validation_scripts: repoSnapshot.package_scripts || {},
    stack_summary: detectedStack.map((item) => `${item.type}:${item.name}`),
    likely_entrypoints: repoSnapshot.key_files.map((item) => item.path),
    test_surface: Object.keys(repoSnapshot.package_scripts || {}).filter((script) => /test|check|lint|smoke/i.test(script)),
    imported_document_count: documents.length,
    confidence: detectedStack.length > 0 || documents.length > 0 ? 0.7 : 0.35,
    caveats: [
      "This is inferred from repository files and imported documents.",
      "Historical authorship, prior approvals, and rationale are unknown unless present in evidence files.",
    ],
  };
}

export function listOrNone(values) {
  return values.length ? values.map((value) => `- ${value}`) : ["- None"];
}

export function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function normalizeConfidence(value) {
  const confidence = Number(value);
  if (!Number.isFinite(confidence)) {
    fail("Capability confidence must be a number between 0 and 1");
  }
  return clamp01(confidence);
}

export function normalizeWorkItemType(value, options = {}) {
  const normalized = String(value || "").trim().toLowerCase().replace(/\s+/g, "-");
  const allowed = options.allowStory ? WORK_ITEM_TYPES : WORK_ITEM_CREATE_TYPES;
  if (!allowed.has(normalized)) {
    fail(`Unknown work item type '${value}'. Valid values: ${Array.from(allowed).join(", ")}`);
  }
  return normalized;
}

export function normalizeListValue(value, fallback = []) {
  if (!Array.isArray(value)) {
    return [...fallback];
  }
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

export function isApprovedRecordFresh(record) {
  const latest = latestApprovedRecordApproval(record);
  return Boolean(latest?.approved_content_hash && latest.approved_content_hash === hashApprovalSubject(record));
}

export function normalizeRecordedCommandArgv(value) {
  const raw = String(value || "").trim();
  let argv;
  try {
    argv = JSON.parse(raw);
  } catch {
    fail(`--command must be a JSON argument vector, for example '["npm","test"]': ${raw}`);
  }
  if (
    !Array.isArray(argv)
    || argv.length === 0
    || argv.some((item) => typeof item !== "string" || item.length === 0 || item.includes("\0"))
  ) {
    fail("--command must be a non-empty JSON array of non-empty strings.");
  }
  return argv;
}

export function boundedNonNegativeIntegerOption(options, key, { defaultValue = 0, maximum } = {}) {
  const raw = options[key];
  const value = raw === undefined || raw === null || raw === "" || raw === true
    ? defaultValue
    : Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    fail(`--${key} must be an integer between 0 and ${maximum}`);
  }
  return value;
}

export function deriveTestRunOutcome(exitCode, totals) {
  if (exitCode !== 0 || totals.failed > 0) {
    return "failed";
  }
  return totals.passed > 0 ? "passed" : "skipped";
}

export function requireEnumOption(options, key, values) {
  const value = requireOption(options, key);
  if (!values.includes(value)) {
    fail(`--${key} must be one of: ${values.join(", ")}`);
  }
  return value;
}

/**
 * Reads gate_policy.secret_scan from the effective project configuration.
 *
 * `enabled` is compared against true and not against false. A project whose
 * configuration predates this block keeps the gate it agreed to; only a project
 * initialized from the current template, or migrated through the reviewed
 * `config migrate` path, gets the blocking check. Rules and exclusions are
 * project data merged over the shipped defaults by the scanner, so a project
 * can retune one pattern without restating the rest.
 */
export function secretScanPolicy(context) {
  return {
    enabled: context.config.gate_policy?.secret_scan?.enabled === true,
    rules: Array.isArray(context.config.gate_policy?.secret_scan?.rules)
      ? context.config.gate_policy.secret_scan.rules
      : [],
    excludePaths: Array.isArray(context.config.gate_policy?.secret_scan?.exclude_paths)
      ? context.config.gate_policy.secret_scan.exclude_paths
      : [],
  };
}

export function normalizeReportQuery(rawQuery, options = {}) {
  if (!rawQuery || typeof rawQuery !== "object" || Array.isArray(rawQuery)) {
    fail("Report query must be a JSON object.");
  }
  const subjects = normalizeStringArray(rawQuery.subjects || rawQuery.subject || ["activity"]).map((subject) =>
    String(subject).trim().toLowerCase(),
  );
  if (subjects.length === 0) {
    fail("Report query subjects cannot be empty.");
  }
  for (const subject of subjects) {
    if (!REPORT_QUERY_SUBJECTS.has(subject)) {
      fail(`Unknown report query subject '${subject}'. Valid subjects: ${Array.from(REPORT_QUERY_SUBJECTS).join(", ")}`);
    }
  }
  const time = rawQuery.time && typeof rawQuery.time === "object" && !Array.isArray(rawQuery.time) ? rawQuery.time : {};
  const filters = rawQuery.filters && typeof rawQuery.filters === "object" && !Array.isArray(rawQuery.filters) ? rawQuery.filters : {};
  const limit = boundedPositiveInteger(rawQuery.limit ?? options.limit, "limit", {
    defaultValue: 50,
    maximum: 500,
  });
  const sort = String(rawQuery.sort || "created_at_desc");
  if (!["created_at_desc", "created_at_asc", "updated_at_desc", "updated_at_asc", "kind_asc"].includes(sort)) {
    fail("Report query sort must be created_at_desc, created_at_asc, updated_at_desc, updated_at_asc, or kind_asc.");
  }
  return {
    intent: String(rawQuery.intent || "find_records"),
    confidence: rawQuery.confidence === undefined ? null : Number(rawQuery.confidence),
    subjects,
    time: {
      since: time.since || options.since || null,
      until: time.until || options.until || null,
      field: String(time.field || "created_at"),
    },
    filters: normalizeReportQueryFilters(filters),
    sort,
    limit,
  };
}

export function normalizeReportQueryFilters(filters) {
  return {
    actor: normalizeStringArray(filters.actor),
    executor: normalizeStringArray(filters.executor || filters.executed_by),
    requester: normalizeStringArray(filters.requester || filters.requested_by || filters.requestedBy),
    authorizer: normalizeStringArray(filters.authorizer || filters.authorized_by || filters.authorizedBy),
    story_id: normalizeStringArray(filters.story_id || filters.story),
    requirement: normalizeStringArray(filters.requirement || filters.requirements),
    artifact_type: normalizeStringArray(filters.artifact_type || filters.output_type),
    event_type: normalizeStringArray(filters.event_type || filters.type),
    action: normalizeStringArray(filters.action),
    phase: normalizeStringArray(filters.phase),
    status: normalizeStringArray(filters.status),
    kind: normalizeStringArray(filters.kind),
    path: normalizeStringArray(filters.path),
    text: normalizeStringArray(filters.text || filters.contains),
  };
}

export function reportQuerySubjectMatches(record, query) {
  return query.subjects.includes("all") || query.subjects.includes(record.kind);
}

export function reportQueryFiltersMatch(record, query) {
  const filters = query.filters;
  return (
    listFilterMatches(filters.kind, record.kind) &&
    actorFilterMatches(filters.actor, record.actor) &&
    actorFilterMatches(filters.executor, record.actor) &&
    actorFilterMatches(filters.requester, record.requested_by) &&
    actorFilterMatches(filters.authorizer, record.authorized_by) &&
    listFilterMatches(filters.story_id, record.story_id) &&
    listFilterOverlaps(filters.requirement, record.requirements || []) &&
    listFilterOverlaps(filters.artifact_type, [record.artifact_type, ...(record.artifact_types || [])].filter(Boolean)) &&
    listFilterMatches(filters.event_type, record.event_type) &&
    listFilterMatches(filters.action, record.action) &&
    listFilterMatches(filters.phase, record.phase) &&
    listFilterMatches(filters.status, record.status) &&
    listFilterOverlaps(filters.path, (record.sources || []).map((source) => source.path)) &&
    textFilterMatches(filters.text, record.text)
  );
}

export function actorFilterMatches(filters, actor) {
  if (!filters.length) {
    return true;
  }
  return filters.some((filter) => traceActorMatches(actor, filter));
}

export function listFilterMatches(filters, value) {
  if (!filters.length) {
    return true;
  }
  return filters.map(normalizeQueryToken).includes(normalizeQueryToken(value));
}

export function listFilterOverlaps(filters, values) {
  if (!filters.length) {
    return true;
  }
  const normalizedValues = new Set((Array.isArray(values) ? values : [values]).map(normalizeQueryToken));
  return filters.some((filter) => normalizedValues.has(normalizeQueryToken(filter)));
}

export function textFilterMatches(filters, text) {
  if (!filters.length) {
    return true;
  }
  const normalized = normalizeText(text).toLowerCase();
  return filters.every((filter) => normalizeText(filter).toLowerCase().split(" ").filter(Boolean).every((term) => normalized.includes(term)));
}

export function normalizeQueryToken(value) {
  return String(value || "").trim().toLowerCase();
}

export function compareReportQueryRecords(left, right, sort) {
  if (sort === "kind_asc") {
    return `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`);
  }
  const field = sort.startsWith("updated_at") ? "updated_at" : "created_at";
  const direction = sort.endsWith("_asc") ? 1 : -1;
  return direction * String(left[field] || "").localeCompare(String(right[field] || ""));
}

export function countBy(items, keyOrFn) {
  const result = {};
  for (const item of items) {
    const key = typeof keyOrFn === "function" ? keyOrFn(item) : item[keyOrFn];
    result[key || "unknown"] = (result[key || "unknown"] || 0) + 1;
  }
  return result;
}

export function normalizeActivityReportView(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!ACTIVITY_REPORT_VIEWS.has(normalized)) {
    fail(`Unknown activity report view '${value}'. Valid values: ${Array.from(ACTIVITY_REPORT_VIEWS).join(", ")}`);
  }
  return normalized;
}

export function isEventInsideWindow(event, sinceDate, untilDate) {
  const timestamp = Date.parse(String(event.created_at || ""));
  return Number.isFinite(timestamp) && timestamp >= sinceDate.getTime() && timestamp <= untilDate.getTime();
}

export function summarizeActivityEvents(events) {
  const byType = {};
  const byAction = {};
  const byStory = {};
  const byActor = {};
  for (const event of events) {
    incrementCounter(byType, event.type || "unknown");
    incrementCounter(byAction, event.action || event.type || "unknown");
    incrementCounter(byStory, event.story_id || "project");
    incrementCounter(byActor, traceActorKey(event.actor));
  }
  return {
    event_count: events.length,
    story_count: Object.keys(byStory).filter((storyId) => storyId !== "project").length,
    by_type: byType,
    by_action: byAction,
    by_story: byStory,
    by_actor: byActor,
    first_event_at: events[0]?.created_at || null,
    last_event_at: events.at(-1)?.created_at || null,
  };
}

export function incrementCounter(target, key) {
  target[key] = (target[key] || 0) + 1;
}

export function normalizeArtifactType(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(normalized)) {
    fail(`Invalid artifact type '${value}'. Use lowercase letters, numbers, dots, underscores, and hyphens.`);
  }
  return normalized;
}

export function verifyOoxmlSemanticContent(filePath, entries, format, rootXml) {
  if (format === "docx") {
    const text = Array.from(rootXml.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/gi))
      .map((match) => match[1].replace(/<[^>]+>/g, " ").trim())
      .filter(Boolean)
      .join(" ");
    if (text.length < 20) {
      fail(`${path.basename(filePath)} has a Word document container but no meaningful document text.`);
    }
    return [`Word document contains ${text.length} visible text character(s)`];
  }
  if (format === "xlsx") {
    const sheetDeclarations = Array.from(rootXml.matchAll(/<(?:\w+:)?sheet\b/gi)).length;
    const worksheetEntries = Array.from(entries.keys()).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name));
    if (sheetDeclarations === 0 || worksheetEntries.length === 0) {
      fail(`${path.basename(filePath)} has a workbook container but no declared worksheet.`);
    }
    const populated = worksheetEntries.filter((name) => {
      const xml = readZipEntry(filePath, entries.get(name)).toString("utf8");
      return /<(?:\w+:)?c\b|<(?:\w+:)?v\b|<(?:\w+:)?is\b/i.test(xml);
    });
    if (populated.length === 0) {
      fail(`${path.basename(filePath)} declares worksheet(s), but none contains cells or values.`);
    }
    return [`workbook declares ${sheetDeclarations} sheet(s)`, `${populated.length} worksheet(s) contain cells or values`];
  }
  const slideDeclarations = Array.from(rootXml.matchAll(/<(?:\w+:)?sldId\b/gi)).length;
  const slideEntries = Array.from(entries.keys()).filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name));
  if (slideDeclarations === 0 || slideEntries.length === 0) {
    fail(`${path.basename(filePath)} has a presentation container but no slide.`);
  }
  const visibleText = slideEntries.flatMap((name) => {
    const xml = readZipEntry(filePath, entries.get(name)).toString("utf8");
    return Array.from(xml.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/gi)).map((match) => match[1].trim());
  }).filter(Boolean).join(" ");
  if (visibleText.length < 20) {
    fail(`${path.basename(filePath)} contains slide containers but no meaningful slide text.`);
  }
  return [`presentation declares ${slideDeclarations} slide(s)`, `slides contain ${visibleText.length} visible text character(s)`];
}

export function inspectZipContainer(filePath, requiredEntries = []) {
  return withEvidenceFormatFailure(() => inspectZipContainerStructure(filePath, requiredEntries));
}

export function readZipEntry(filePath, entry) {
  return withEvidenceFormatFailure(() => readZipEntryBytes(filePath, entry));
}

export function assertNotDerivedArtifact(context, filePath, label) {
  if (isDerivedArtifactPath(context, filePath)) {
    fail(`${label} cannot be under .sdlc/cache or .sdlc/indexes because those directories are derived artifacts.`);
  }
}

export function upsertById(items, item) {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index >= 0) {
    items[index] = item;
  } else {
    items.push(item);
  }
}

export function shouldIndexFile(context, filePath) {
  if (isDerivedArtifactPath(context, filePath)) {
    return false;
  }
  const extension = path.extname(filePath);
  return context.config.indexable_extensions.includes(extension);
}

export function overlaps(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length === 0 || right.length === 0) {
    return false;
  }
  const rightSet = new Set(right);
  return left.some((item) => rightSet.has(item));
}

export function shortHash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 8);
}

export function shortHashFull(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

export function hashJsonFileValue(value) {
  return hashBuffer(Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
}

export function hashBuffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export function validateExecutionPolicy(context, contract, label, report) {
  const policy = contract.execution_policy;
  if (!policy || typeof policy !== "object") {
    return;
  }
  if (policy.runtime !== "codex") {
    report.errors.push(`${label} execution_policy.runtime must be 'codex'`);
  }
  validateExecutionPolicySelection(policy.model, "model", "value", label, report);
  validateExecutionPolicySelection(policy.reasoning, "reasoning", "level", label, report, {
    allowedValues: normalizeReasoningLevels(context.config.execution_policy?.reasoning_levels),
  });
  if (!Array.isArray(policy.notes)) {
    report.errors.push(`${label} execution_policy.notes must be an array`);
  }
}

export function validateExecutionPolicySelection(selection, name, valueKey, label, report, options = {}) {
  if (!selection || typeof selection !== "object") {
    report.errors.push(`${label} execution_policy.${name} must be an object`);
    return;
  }
  if (!["inherit", "override"].includes(selection.mode)) {
    report.errors.push(`${label} execution_policy.${name}.mode must be 'inherit' or 'override'`);
  }
  const value = selection[valueKey];
  if (selection.mode === "override") {
    if (typeof value !== "string" || value.trim() === "") {
      report.errors.push(`${label} execution_policy.${name}.${valueKey} is required when mode is 'override'`);
    } else if (options.allowedValues && !options.allowedValues.includes(value)) {
      report.errors.push(
        `${label} execution_policy.${name}.${valueKey} '${value}' is not allowed. Valid values: ${options.allowedValues.join(", ")}`,
      );
    }
  }
}

export function hasActorAttribution(actor) {
  if (typeof actor === "string") {
    return actor.trim().length > 0;
  }
  return Boolean(actor && typeof actor === "object" && String(actor.id || "").trim());
}

export function scoreEntry(entry, terms) {
  const text = entry.search_text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    const occurrences = text.split(term).length - 1;
    score += occurrences;
    if (entry.path.toLowerCase().includes(term)) {
      score += 2;
    }
    if (String(entry.title || "").toLowerCase().includes(term)) {
      score += 3;
    }
  }
  return score;
}

export function inferTitle(filePath, raw) {
  if (filePath.endsWith(".md")) {
    const header = raw.split(/\r?\n/).find((line) => line.startsWith("# "));
    return header ? header.replace(/^#\s+/, "").trim() : path.basename(filePath);
  }
  if (filePath.endsWith(".json")) {
    try {
      const data = JSON.parse(raw);
      return data.title || data.id || data.project_name || path.basename(filePath);
    } catch {
      return path.basename(filePath);
    }
  }
  return path.basename(filePath);
}

export function sameStableFileSnapshot(left, right) {
  return sameStableFileIdentity(left, right)
    && fileIdentity(left).dev === fileIdentity(right).dev
    && Number(left.mode) === Number(right.mode)
    && Number(left.size) === Number(right.size)
    && sameStatTime(left, right, "mtime")
    && sameStatTime(left, right, "ctime");
}

export function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function normalizeText(value) {
  return String(value)
    .replace(/[{}\[\]",:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function redactSensitiveText(value) {
  return String(value)
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi, "[REDACTED:PRIVATE_KEY]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED:AWS_ACCESS_KEY]")
    .replace(/\b(?:gh[opusr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,})\b/g, "[REDACTED:ACCESS_TOKEN]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, "$1[REDACTED:TOKEN]")
    .replace(/\b((?:api[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|password|passwd|pwd)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED:SECRET]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:/]+:)[^@\s/]+@/gi, "$1[REDACTED:PASSWORD]@");
}

export function tokenize(query) {
  return normalizeText(query)
    .toLowerCase()
    .split(" ")
    .filter((term) => term.length > 1);
}

export function normalizeListOption(value) {
  if (value === undefined || value === null || value === true) {
    return [];
  }
  const values = Array.isArray(value) ? value : [value];
  return values
    .flatMap((item) => String(item).split("|"))
    .map((item) => item.trim())
    .filter(Boolean);
}

export function normalizeRawListOption(value) {
  if (value === undefined || value === null || value === true) {
    return [];
  }
  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => String(item).trim()).filter(Boolean);
}

export function normalizeScalarOption(value, key) {
  if (value === undefined || value === null || value === true) {
    return null;
  }
  if (Array.isArray(value)) {
    if (value.length > 1) {
      fail(`Option --${key} can be used only once`);
    }
    return normalizeScalarOption(value[0], key);
  }
  const text = String(value).trim();
  return text || null;
}

export function normalizeReasoningLevels(value) {
  const fallback = ["inherit", "minimal", "low", "medium", "high"];
  const levels = Array.isArray(value) && value.length > 0 ? value : fallback;
  return levels.map((level) => String(level).trim().toLowerCase()).filter(Boolean);
}

export function requireCoordinationOverrideActor(attribution, action) {
  if (!["human", "ci"].includes(attribution.actor?.type)) {
    fail(`${action} requires --actor-type human or an approved CI actor after coordination.`);
  }
}

export function normalizeOptionalDateTime(value, label) {
  const text = String(value || "").trim();
  const timestamp = Date.parse(text);
  if (!text || !Number.isFinite(timestamp)) {
    fail(`Invalid --${label} '${value}'. Use an ISO-8601 date-time.`);
  }
  return text;
}

export function normalizeId(value) {
  const normalized = String(value).trim().replace(/\s+/g, "-");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(normalized)) {
    fail(`Invalid id '${value}'. Use only letters, numbers, dots, underscores, and hyphens; do not use path separators.`);
  }
  if (normalized.endsWith(".")) {
    fail(`Invalid id '${value}'. IDs cannot end with a period because they must remain portable across supported filesystems.`);
  }
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(normalized)) {
    fail(`Invalid id '${value}'. This name is reserved by Windows and cannot be used for a portable project artifact.`);
  }
  return normalized;
}

export function slugify(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-") || "project";
}

export function requireOption(options, key) {
  const value = options[key];
  if (value === undefined || value === true || value === "") {
    fail(`Missing required option --${key}`);
  }
  return String(value);
}

export function compactIndexEntry(entry, sourceHash = null) {
  return {
    path: entry.path,
    title: entry.title,
    extension: entry.extension,
    size_bytes: entry.size_bytes,
    snippet: entry.snippet,
    source_hash: sourceHash,
  };
}

export function boundedPositiveInteger(rawValue, label, options = {}) {
  const defaultValue = options.defaultValue;
  const maximum = options.maximum;
  const value = rawValue === undefined || rawValue === null || rawValue === ""
    ? defaultValue
    : Number(rawValue);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    fail(`--${label} must be an integer between 1 and ${maximum}`);
  }
  return value;
}
