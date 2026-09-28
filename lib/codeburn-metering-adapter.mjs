import { promisify } from "node:util";

import { childProcess, Date, process } from "./runtime/host.mjs";
import {
  DomainValidationError,
  STABLE_JSON_HASH_ALGORITHM,
  computeStableHash,
  immutableJson,
  isPlainRecord,
  normalizeIsoInstant,
  omitKeys,
  requireNonEmptyString,
  requirePlainRecord,
} from "./canonical.mjs";

const { execFile: execFileCallback } = childProcess;

export const CODEBURN_ADAPTER_ID = "codeburn";
export const CODEBURN_REPORT_CONTRACT = "codeburn-report:v0.9.x";
export const METERING_SNAPSHOT_SCHEMA_VERSION = "metering-snapshot:v1";
export const METERING_DELTA_SCHEMA_VERSION = "metering-delta:v1";
export const CODEBURN_METERING_CLASSIFICATION = "estimated";
export const CODEBURN_ENFORCEMENT_CLASSIFICATION = "advisory";
export const CODEBURN_ASSURANCE_CLASSIFICATION = "advisory_observed";

const DEFAULT_EXECUTABLE = "codeburn";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 50 * 1024 * 1024;
const MAX_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_BYTES = 100 * 1024 * 1024;
const SAFE_TEXT_PATTERN = /^[^\u0000-\u001f\u007f]+$/u;
const PROVIDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const CURRENCY_PATTERN = /^[A-Z]{3}$/u;
const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/u;
const QUERY_KEYS = Object.freeze(["from", "project", "provider", "to"]);
const execFile = promisify(execFileCallback);

const ADVISORY_ASSURANCE = Object.freeze({
  classification: CODEBURN_ASSURANCE_CLASSIFICATION,
  enforcement: CODEBURN_ENFORCEMENT_CLASSIFICATION,
  trusted_exact: false,
  metrics: Object.freeze({
    tokens: CODEBURN_METERING_CLASSIFICATION,
    calls: CODEBURN_METERING_CLASSIFICATION,
    cost: CODEBURN_METERING_CLASSIFICATION,
  }),
  reasons: Object.freeze([
    "CodeBurn derives counters from local session logs; this is not a provider-signed usage receipt.",
    "CodeBurn calculates cost from its pricing catalog; this is not invoice or provider Costs API truth.",
  ]),
});

export class CodeBurnExecutionError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "CodeBurnExecutionError";
    this.code = options.code || "codeburn_execution_failed";
    this.exit_code = options.exit_code ?? null;
    this.stderr = options.stderr || "";
  }
}

/**
 * Normalize the only report filters the adapter accepts. Callers cannot pass
 * raw CodeBurn arguments, so values never become switches or shell syntax.
 */
export function normalizeCodeBurnQuery(input) {
  requirePlainRecord(input, "codeburn_query");
  rejectUnknownKeys(input, QUERY_KEYS, "codeburn_query");
  const provider = normalizeProvider(input.provider);
  const project = normalizeSafeValue(input.project, "codeburn_query.project", 1024);
  const from = normalizeCalendarDate(input.from, "codeburn_query.from");
  const to = normalizeCalendarDate(input.to, "codeburn_query.to");
  if (from > to) {
    throw new DomainValidationError("codeburn_query.from must be on or before codeburn_query.to");
  }
  return immutableJson({ provider, project, from, to });
}

export function buildCodeBurnReportArgv(input) {
  const query = normalizeCodeBurnQuery(input);
  return Object.freeze([
    "report",
    "--provider",
    query.provider,
    "--project",
    query.project,
    "--from",
    query.from,
    "--to",
    query.to,
    "--format",
    "json",
  ]);
}

export function parseCodeBurnVersion(output) {
  const raw = normalizeSafeValue(output, "codeburn_version_output", 512);
  const match = raw.match(/(?:^|\s|v)(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?(?:\s|$)/u);
  if (!match) {
    throw new DomainValidationError("CodeBurn version output does not contain a semantic version");
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  const version = `${major}.${minor}.${patch}`;
  return immutableJson({
    version,
    major,
    minor,
    patch,
    supported: major === 0 && minor === 9,
    report_contract: major === 0 && minor === 9 ? CODEBURN_REPORT_CONTRACT : null,
  });
}

/**
 * Detect CodeBurn without invoking a shell. The optional executor exists for
 * deterministic hosts/tests and must implement the execFile promise shape.
 */
export async function detectCodeBurn(options = {}) {
  const execution = normalizeExecutionOptions(options);
  try {
    const result = await execution.executor(
      execution.executable,
      [...execution.prefix_args, "--version"],
      execution.process_options,
    );
    const parsed = parseCodeBurnVersion(normalizeProcessOutput(result?.stdout));
    return immutableJson({
      available: true,
      supported: parsed.supported,
      executable: execution.executable,
      ...parsed,
    });
  } catch (error) {
    if (error instanceof DomainValidationError) {
      return immutableJson({
        available: true,
        supported: false,
        executable: execution.executable,
        version: null,
        major: null,
        minor: null,
        patch: null,
        report_contract: null,
        reason: "unrecognized_version",
      });
    }
    const reason = error?.code === "ENOENT" ? "not_found" : "execution_failed";
    return immutableJson({
      available: false,
      supported: false,
      executable: execution.executable,
      version: null,
      major: null,
      minor: null,
      patch: null,
      report_contract: null,
      reason,
    });
  }
}

/**
 * Execute a bounded CodeBurn 0.9.x JSON report. No raw report argv or shell
 * option is accepted. The returned report is validated before it crosses the
 * adapter.
 */
export async function executeCodeBurnReport(input, options = {}) {
  const query = normalizeCodeBurnQuery(input);
  const argv = buildCodeBurnReportArgv(query);
  const execution = normalizeExecutionOptions(options);
  const detection = await detectCodeBurn({
    ...options,
    executable: execution.executable,
    executor: execution.executor,
  });
  if (!detection.available) {
    throw new CodeBurnExecutionError(
      `CodeBurn executable '${execution.executable}' is not available`,
      { code: detection.reason === "not_found" ? "codeburn_not_found" : "codeburn_detection_failed" },
    );
  }
  if (!detection.supported) {
    throw new CodeBurnExecutionError(
      `CodeBurn ${detection.version || "with an unknown version"} is unsupported; expected 0.9.x`,
      { code: "unsupported_codeburn_version" },
    );
  }

  let result;
  try {
    result = await execution.executor(
      execution.executable,
      [...execution.prefix_args, ...argv],
      execution.process_options,
    );
  } catch (error) {
    throw new CodeBurnExecutionError("CodeBurn report execution failed", {
      cause: error,
      code: "codeburn_report_failed",
      exit_code: normalizeExitCode(error?.code),
      stderr: truncateDiagnostic(normalizeProcessOutput(error?.stderr)),
    });
  }
  const report = parseCodeBurnReport(normalizeProcessOutput(result?.stdout), {
    max_bytes: execution.max_output_bytes,
  });
  assertReportMatchesQuery(report, query);
  return immutableJson({
    adapter: CODEBURN_ADAPTER_ID,
    tool_version: detection.version,
    report_contract: CODEBURN_REPORT_CONTRACT,
    query,
    argv,
    report,
  });
}

export function parseCodeBurnReport(json, options = {}) {
  if (typeof json !== "string" && !Buffer.isBuffer(json)) {
    throw new DomainValidationError("CodeBurn report output must be a string or Buffer");
  }
  const maxBytes = normalizePositiveInteger(
    options.max_bytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    "codeburn_report.max_bytes",
    MAX_OUTPUT_BYTES,
  );
  const byteLength = Buffer.byteLength(json);
  if (byteLength === 0) {
    throw new DomainValidationError("CodeBurn report output is empty");
  }
  if (byteLength > maxBytes) {
    throw new DomainValidationError(`CodeBurn report output exceeds ${maxBytes} bytes`);
  }
  let report;
  try {
    report = JSON.parse(String(json));
  } catch (error) {
    throw new DomainValidationError(`CodeBurn report output is not valid JSON: ${error.message}`);
  }
  assertCodeBurnReport(report);
  return immutableJson(report);
}

/**
 * Validate the stable subset emitted by CodeBurn 0.9.x. Extra properties are
 * deliberately retained so patch releases can add fields without breaking us.
 */
export function validateCodeBurnReport(report) {
  const errors = [];
  if (!isPlainRecord(report)) {
    return Object.freeze({ valid: false, errors: Object.freeze(["report must be a plain object"]) });
  }
  validateNonEmptyString(report.generated, "report.generated", errors);
  if (typeof report.generated === "string") {
    try {
      normalizeIsoInstant(report.generated, "report.generated");
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (typeof report.currency !== "string" || !CURRENCY_PATTERN.test(report.currency)) {
    errors.push("report.currency must be a three-letter uppercase currency code");
  }
  validateNonEmptyString(report.period, "report.period", errors);
  validateNonEmptyString(report.periodKey, "report.periodKey", errors);

  if (!isPlainRecord(report.overview)) {
    errors.push("report.overview must be a plain object");
  } else {
    validateNonNegativeNumber(report.overview.cost, "report.overview.cost", errors);
    validateNonNegativeSafeInteger(report.overview.calls, "report.overview.calls", errors);
    validateNonNegativeSafeInteger(report.overview.sessions, "report.overview.sessions", errors);
    if (!isPlainRecord(report.overview.tokens)) {
      errors.push("report.overview.tokens must be a plain object");
    } else {
      for (const field of ["input", "output", "cacheRead", "cacheWrite"]) {
        validateNonNegativeSafeInteger(report.overview.tokens[field], `report.overview.tokens.${field}`, errors);
      }
    }
  }

  if (!Array.isArray(report.projects)) {
    errors.push("report.projects must be an array");
  } else {
    report.projects.forEach((project, index) => validateReportProject(project, index, errors));
  }
  return Object.freeze({
    valid: errors.length === 0,
    errors: Object.freeze(Array.from(new Set(errors))),
  });
}

export function assertCodeBurnReport(report) {
  const validation = validateCodeBurnReport(report);
  if (!validation.valid) {
    throw new DomainValidationError("CodeBurn 0.9.x report validation failed", validation.errors.map((message) => ({
      code: "invalid_codeburn_report",
      message,
    })));
  }
  return report;
}

/** Normalize CodeBurn into the provider-neutral observation contract. */
export function normalizeCodeBurnObservation(report, context) {
  assertCodeBurnReport(report);
  requirePlainRecord(context, "codeburn_context");
  const query = normalizeCodeBurnQuery(context.query || context);
  const toolVersion = assertSupportedCodeBurnVersion(context.tool_version);
  const argv = context.argv === undefined
    ? buildCodeBurnReportArgv(query)
    : normalizeExpectedArgv(context.argv, query);
  assertReportMatchesQuery(report, query);
  const currency = report.currency;
  const observation = {
    adapter: {
      id: CODEBURN_ADAPTER_ID,
      version: toolVersion,
      report_contract: CODEBURN_REPORT_CONTRACT,
    },
    scope: query,
    captured_at: normalizeIsoInstant(report.generated, "report.generated"),
    cumulative: {
      tokens: {
        input: report.overview.tokens.input,
        output: report.overview.tokens.output,
        cache_read: report.overview.tokens.cacheRead,
        cache_write: report.overview.tokens.cacheWrite,
      },
      calls: report.overview.calls,
      sessions: report.overview.sessions,
      cost: {
        amount: normalizeDecimal(report.overview.cost, "report.overview.cost"),
        currency,
      },
    },
    metering: {
      tokens: CODEBURN_METERING_CLASSIFICATION,
      calls: CODEBURN_METERING_CLASSIFICATION,
      cost: CODEBURN_METERING_CLASSIFICATION,
    },
    assurance: ADVISORY_ASSURANCE,
    source: {
      argv,
      report_hash: computeStableHash(report),
      report_generated_at: normalizeIsoInstant(report.generated, "report.generated"),
      report_period: report.period,
      matched_projects: normalizeMatchedProjects(report.projects, currency),
    },
  };
  return immutableJson(observation);
}

export function buildCodeBurnMeteringSnapshot(input) {
  requirePlainRecord(input, "metering_snapshot_input");
  const id = requireNonEmptyString(input.id, "metering_snapshot_input.id");
  const observation = input.observation
    ? normalizeObservation(input.observation)
    : normalizeCodeBurnObservation(input.report, {
      query: input.query,
      tool_version: input.tool_version,
      argv: input.argv,
    });
  const snapshot = {
    kind: "metering_snapshot",
    schema_version: METERING_SNAPSHOT_SCHEMA_VERSION,
    version: 1,
    id,
    ...observation,
  };
  return immutableJson({
    ...snapshot,
    snapshot_hash: computeMeteringSnapshotHash(snapshot),
    hash_algorithm: STABLE_JSON_HASH_ALGORITHM,
  });
}

export async function collectCodeBurnMeteringSnapshot(input, options = {}) {
  requirePlainRecord(input, "metering_collection");
  const execution = await executeCodeBurnReport(input.query, options);
  return buildCodeBurnMeteringSnapshot({
    id: input.id,
    report: execution.report,
    query: execution.query,
    tool_version: execution.tool_version,
    argv: execution.argv,
  });
}

export function computeMeteringSnapshotHash(snapshot) {
  requirePlainRecord(snapshot, "metering_snapshot");
  return computeStableHash(omitKeys(snapshot, ["snapshot_hash", "hash_algorithm"]));
}

export function validateMeteringSnapshotIntegrity(snapshot) {
  const errors = [];
  if (!isPlainRecord(snapshot)) {
    return Object.freeze({ valid: false, expected_hash: null, errors: Object.freeze(["snapshot must be a plain object"]) });
  }
  let expectedHash = null;
  try {
    expectedHash = computeMeteringSnapshotHash(snapshot);
  } catch (error) {
    errors.push(error.message);
  }
  if (snapshot.kind !== "metering_snapshot") {
    errors.push("snapshot.kind must be 'metering_snapshot'");
  }
  if (snapshot.schema_version !== METERING_SNAPSHOT_SCHEMA_VERSION) {
    errors.push(`snapshot.schema_version must be '${METERING_SNAPSHOT_SCHEMA_VERSION}'`);
  }
  if (snapshot.hash_algorithm !== STABLE_JSON_HASH_ALGORITHM) {
    errors.push(`snapshot.hash_algorithm must be '${STABLE_JSON_HASH_ALGORITHM}'`);
  }
  if (snapshot.snapshot_hash !== expectedHash) {
    errors.push("snapshot.snapshot_hash does not match canonical snapshot content");
  }
  if (!Number.isSafeInteger(snapshot.version) || snapshot.version !== 1) {
    errors.push("snapshot.version must be 1");
  }
  if (typeof snapshot.id !== "string" || snapshot.id.trim() === "") {
    errors.push("snapshot.id must be a non-empty string");
  } else if (snapshot.id !== snapshot.id.trim()) {
    errors.push("snapshot.id must be in canonical trimmed form");
  }
  const observation = omitKeys(snapshot, [
    "kind",
    "schema_version",
    "version",
    "id",
    "snapshot_hash",
    "hash_algorithm",
  ]);
  try {
    const normalized = normalizeObservation(observation);
    if (computeStableHash(normalized) !== computeStableHash(observation)) {
      errors.push("snapshot observation is not in canonical normalized form");
    }
  } catch (error) {
    errors.push(...domainMessages(error));
  }
  return Object.freeze({
    valid: errors.length === 0,
    expected_hash: expectedHash,
    errors: Object.freeze(Array.from(new Set(errors))),
  });
}

/**
 * Subtract two comparable cumulative snapshots. Every counter must remain
 * monotonic; resets, filter changes, currency changes and adapter upgrades fail.
 */
export function calculateMeteringDelta(baseline, current, options = {}) {
  requirePlainRecord(options, "metering_delta_options");
  const baselineSnapshot = assertSnapshotIntegrity(baseline, "baseline");
  const currentSnapshot = assertSnapshotIntegrity(current, "current");
  assertComparableSnapshots(baselineSnapshot, currentSnapshot);
  const id = requireNonEmptyString(options.id, "metering_delta.id");
  const baselineTokens = baselineSnapshot.cumulative.tokens;
  const currentTokens = currentSnapshot.cumulative.tokens;
  const tokens = {};
  for (const field of ["input", "output", "cache_read", "cache_write"]) {
    tokens[field] = subtractMonotonicInteger(
      baselineTokens[field],
      currentTokens[field],
      `cumulative.tokens.${field}`,
    );
  }
  const calls = subtractMonotonicInteger(
    baselineSnapshot.cumulative.calls,
    currentSnapshot.cumulative.calls,
    "cumulative.calls",
  );
  const sessions = subtractMonotonicInteger(
    baselineSnapshot.cumulative.sessions,
    currentSnapshot.cumulative.sessions,
    "cumulative.sessions",
  );
  const cost = subtractMonotonicDecimal(
    baselineSnapshot.cumulative.cost.amount,
    currentSnapshot.cumulative.cost.amount,
    "cumulative.cost.amount",
  );
  const delta = {
    kind: "metering_delta",
    schema_version: METERING_DELTA_SCHEMA_VERSION,
    version: 1,
    id,
    adapter: currentSnapshot.adapter,
    scope: currentSnapshot.scope,
    interval: {
      started_at: baselineSnapshot.captured_at,
      ended_at: currentSnapshot.captured_at,
    },
    baseline_ref: snapshotReference(baselineSnapshot),
    current_ref: snapshotReference(currentSnapshot),
    usage: {
      tokens,
      calls,
      sessions,
      cost: {
        amount: cost,
        currency: currentSnapshot.cumulative.cost.currency,
      },
    },
    metering: currentSnapshot.metering,
    assurance: currentSnapshot.assurance,
  };
  return immutableJson({
    ...delta,
    delta_hash: computeMeteringDeltaHash(delta),
    hash_algorithm: STABLE_JSON_HASH_ALGORITHM,
  });
}

export function computeMeteringDeltaHash(delta) {
  requirePlainRecord(delta, "metering_delta");
  return computeStableHash(omitKeys(delta, ["delta_hash", "hash_algorithm"]));
}

export function validateMeteringDeltaIntegrity(delta) {
  const errors = [];
  if (!isPlainRecord(delta)) {
    return Object.freeze({ valid: false, expected_hash: null, errors: Object.freeze(["delta must be a plain object"]) });
  }
  let expectedHash = null;
  try {
    expectedHash = computeMeteringDeltaHash(delta);
  } catch (error) {
    errors.push(error.message);
  }
  if (delta.kind !== "metering_delta") {
    errors.push("delta.kind must be 'metering_delta'");
  }
  if (delta.schema_version !== METERING_DELTA_SCHEMA_VERSION) {
    errors.push(`delta.schema_version must be '${METERING_DELTA_SCHEMA_VERSION}'`);
  }
  if (delta.hash_algorithm !== STABLE_JSON_HASH_ALGORITHM) {
    errors.push(`delta.hash_algorithm must be '${STABLE_JSON_HASH_ALGORITHM}'`);
  }
  if (delta.delta_hash !== expectedHash) {
    errors.push("delta.delta_hash does not match canonical delta content");
  }
  if (!Number.isSafeInteger(delta.version) || delta.version !== 1) {
    errors.push("delta.version must be 1");
  }
  if (typeof delta.id !== "string" || delta.id.trim() === "" || delta.id !== delta.id.trim()) {
    errors.push("delta.id must be a non-empty canonical trimmed string");
  }
  try {
    const adapter = requirePlainRecord(delta.adapter, "delta.adapter");
    if (adapter.id !== CODEBURN_ADAPTER_ID) {
      errors.push(`delta.adapter.id must be '${CODEBURN_ADAPTER_ID}'`);
    }
    assertSupportedCodeBurnVersion(adapter.version);
    if (adapter.report_contract !== CODEBURN_REPORT_CONTRACT) {
      errors.push(`delta.adapter.report_contract must be '${CODEBURN_REPORT_CONTRACT}'`);
    }
    const normalizedScope = normalizeCodeBurnQuery(delta.scope);
    if (computeStableHash(normalizedScope) !== computeStableHash(delta.scope)) {
      errors.push("delta.scope is not in canonical normalized form");
    }
    validateDeltaIntervalAndReferences(delta);
    normalizeDeltaUsage(delta.usage);
  } catch (error) {
    errors.push(...domainMessages(error));
  }
  if (
    delta.assurance?.classification !== CODEBURN_ASSURANCE_CLASSIFICATION
    || delta.assurance?.trusted_exact !== false
    || delta.assurance?.enforcement !== "advisory"
  ) {
    errors.push("delta assurance must remain advisory and never trusted-exact");
  }
  for (const metric of ["tokens", "calls", "cost"]) {
    if (delta.metering?.[metric] !== "estimated" || delta.assurance?.metrics?.[metric] !== "estimated") {
      errors.push(`delta ${metric} metering must be estimated`);
    }
  }
  if (
    !isPlainRecord(delta.assurance)
    || computeStableHash(delta.assurance) !== computeStableHash(ADVISORY_ASSURANCE)
  ) {
    errors.push("delta assurance is not in canonical CodeBurn advisory form");
  }
  return Object.freeze({
    valid: errors.length === 0,
    expected_hash: expectedHash,
    errors: Object.freeze(Array.from(new Set(errors))),
  });
}

function normalizeExecutionOptions(options) {
  requirePlainRecord(options, "codeburn_execution_options");
  const executable = normalizeSafeValue(options.executable ?? DEFAULT_EXECUTABLE, "codeburn executable", 4096, {
    allowLeadingDash: false,
  });
  const prefixArgs = normalizeExecutablePrefixArgs(options.prefix_args);
  const timeout = normalizePositiveInteger(
    options.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    "codeburn timeout_ms",
    MAX_TIMEOUT_MS,
  );
  const maxOutput = normalizePositiveInteger(
    options.max_output_bytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    "codeburn max_output_bytes",
    MAX_OUTPUT_BYTES,
  );
  const executor = options.executor ?? execFile;
  if (typeof executor !== "function") {
    throw new DomainValidationError("codeburn executor must be a function");
  }
  const cwd = options.cwd === undefined
    ? process.cwd()
    : normalizeSafeValue(options.cwd, "codeburn cwd", 4096);
  if (options.env !== undefined && !isPlainRecord(options.env)) {
    throw new DomainValidationError("codeburn env must be a plain object");
  }
  return {
    executable,
    prefix_args: prefixArgs,
    executor,
    max_output_bytes: maxOutput,
    process_options: {
      cwd,
      env: options.env === undefined ? process.env : { ...process.env, ...options.env },
      encoding: "utf8",
      timeout,
      maxBuffer: maxOutput,
      windowsHide: true,
      shell: false,
    },
  };
}

function normalizeExecutablePrefixArgs(value) {
  if (value === undefined) {
    return Object.freeze([]);
  }
  if (!Array.isArray(value)) {
    throw new DomainValidationError("codeburn prefix_args must be an array");
  }
  if (value.length > 32) {
    throw new DomainValidationError("codeburn prefix_args must contain at most 32 arguments");
  }
  return Object.freeze(value.map((argument, index) => normalizeSafeValue(
    argument,
    `codeburn prefix_args[${index}]`,
    4096,
    { allowLeadingDash: true },
  )));
}

function normalizeObservation(input) {
  requirePlainRecord(input, "metering_observation");
  const adapter = requirePlainRecord(input.adapter, "metering_observation.adapter");
  if (adapter.id !== CODEBURN_ADAPTER_ID) {
    throw new DomainValidationError(`metering_observation.adapter.id must be '${CODEBURN_ADAPTER_ID}'`);
  }
  const adapterVersion = assertSupportedCodeBurnVersion(adapter.version);
  if (adapter.report_contract !== CODEBURN_REPORT_CONTRACT) {
    throw new DomainValidationError(`metering_observation.adapter.report_contract must be '${CODEBURN_REPORT_CONTRACT}'`);
  }
  const scope = normalizeCodeBurnQuery(input.scope);
  const capturedAt = normalizeIsoInstant(input.captured_at, "metering_observation.captured_at");
  const cumulative = normalizeCumulative(input.cumulative);
  assertAdvisoryClassification(input.metering, input.assurance);
  const source = normalizeObservationSource(input.source, scope);
  if (source.report_generated_at !== capturedAt) {
    throw new DomainValidationError("metering_observation.captured_at must equal source.report_generated_at");
  }
  if (source.matched_projects.some((project) => project.cost.currency !== cumulative.cost.currency)) {
    throw new DomainValidationError("matched project currencies must equal cumulative.cost.currency");
  }
  return immutableJson({
    adapter: { id: CODEBURN_ADAPTER_ID, version: adapterVersion, report_contract: CODEBURN_REPORT_CONTRACT },
    scope,
    captured_at: capturedAt,
    cumulative,
    metering: {
      tokens: "estimated",
      calls: "estimated",
      cost: "estimated",
    },
    assurance: ADVISORY_ASSURANCE,
    source,
  });
}

function normalizeCumulative(input) {
  requirePlainRecord(input, "metering_observation.cumulative");
  const tokensInput = requirePlainRecord(input.tokens, "metering_observation.cumulative.tokens");
  const tokens = {};
  for (const field of ["input", "output", "cache_read", "cache_write"]) {
    validateNonNegativeSafeIntegerOrThrow(tokensInput[field], `metering_observation.cumulative.tokens.${field}`);
    tokens[field] = tokensInput[field];
  }
  validateNonNegativeSafeIntegerOrThrow(input.calls, "metering_observation.cumulative.calls");
  validateNonNegativeSafeIntegerOrThrow(input.sessions, "metering_observation.cumulative.sessions");
  const costInput = requirePlainRecord(input.cost, "metering_observation.cumulative.cost");
  const amount = normalizeDecimal(costInput.amount, "metering_observation.cumulative.cost.amount");
  const currency = requireNonEmptyString(costInput.currency, "metering_observation.cumulative.cost.currency");
  if (!CURRENCY_PATTERN.test(currency)) {
    throw new DomainValidationError("metering_observation.cumulative.cost.currency must be a three-letter uppercase currency code");
  }
  return immutableJson({ tokens, calls: input.calls, sessions: input.sessions, cost: { amount, currency } });
}

function normalizeObservationSource(input, scope) {
  requirePlainRecord(input, "metering_observation.source");
  const argv = normalizeExpectedArgv(input.argv, scope);
  const reportHash = requireNonEmptyString(input.report_hash, "metering_observation.source.report_hash");
  if (!/^[a-f0-9]{64}$/u.test(reportHash)) {
    throw new DomainValidationError("metering_observation.source.report_hash must be a lowercase SHA-256 hash");
  }
  const generated = normalizeIsoInstant(
    input.report_generated_at,
    "metering_observation.source.report_generated_at",
  );
  const period = requireNonEmptyString(input.report_period, "metering_observation.source.report_period");
  if (period !== expectedPeriod(scope)) {
    throw new DomainValidationError(`metering_observation.source.report_period must equal '${expectedPeriod(scope)}'`);
  }
  if (!Array.isArray(input.matched_projects)) {
    throw new DomainValidationError("metering_observation.source.matched_projects must be an array");
  }
  const projects = input.matched_projects.map((project, index) => normalizeMatchedProject(project, index));
  return immutableJson({
    argv,
    report_hash: reportHash,
    report_generated_at: generated,
    report_period: period,
    matched_projects: projects.sort(compareMatchedProjects),
  });
}

function normalizeMatchedProjects(projects, currency) {
  return projects.map((project, index) => normalizeMatchedProject({
    name: project.name,
    path: project.path,
    calls: project.calls,
    cost: { amount: normalizeDecimal(project.cost, `report.projects[${index}].cost`), currency },
  }, index)).sort(compareMatchedProjects);
}

function normalizeMatchedProject(input, index) {
  requirePlainRecord(input, `metering_observation.source.matched_projects[${index}]`);
  const name = requireNonEmptyString(input.name, `metering_observation.source.matched_projects[${index}].name`);
  const projectPath = requireNonEmptyString(input.path, `metering_observation.source.matched_projects[${index}].path`);
  validateNonNegativeSafeIntegerOrThrow(input.calls, `metering_observation.source.matched_projects[${index}].calls`);
  const cost = requirePlainRecord(input.cost, `metering_observation.source.matched_projects[${index}].cost`);
  const currency = requireNonEmptyString(cost.currency, `metering_observation.source.matched_projects[${index}].cost.currency`);
  if (!CURRENCY_PATTERN.test(currency)) {
    throw new DomainValidationError(`metering_observation.source.matched_projects[${index}].cost.currency is invalid`);
  }
  return immutableJson({
    name,
    path: projectPath,
    calls: input.calls,
    cost: { amount: normalizeDecimal(cost.amount, `metering_observation.source.matched_projects[${index}].cost.amount`), currency },
  });
}

function validateReportProject(project, index, errors) {
  if (!isPlainRecord(project)) {
    errors.push(`report.projects[${index}] must be a plain object`);
    return;
  }
  validateNonEmptyString(project.name, `report.projects[${index}].name`, errors);
  validateNonEmptyString(project.path, `report.projects[${index}].path`, errors);
  validateNonNegativeNumber(project.cost, `report.projects[${index}].cost`, errors);
  validateNonNegativeSafeInteger(project.calls, `report.projects[${index}].calls`, errors);
}

function assertComparableSnapshots(baseline, current) {
  for (const field of ["id", "version", "report_contract"]) {
    if (baseline.adapter[field] !== current.adapter[field]) {
      throw new DomainValidationError(`Metering snapshots use different adapter.${field}; capture a new baseline`);
    }
  }
  if (computeStableHash(baseline.scope) !== computeStableHash(current.scope)) {
    throw new DomainValidationError("Metering snapshots use different provider/project/date filters; capture a new baseline");
  }
  if (baseline.cumulative.cost.currency !== current.cumulative.cost.currency) {
    throw new DomainValidationError("Metering snapshots use different currencies; capture a new baseline");
  }
  if (Date.parse(current.captured_at) < Date.parse(baseline.captured_at)) {
    throw new DomainValidationError("Current metering snapshot is older than the baseline");
  }
}

function validateDeltaIntervalAndReferences(delta) {
  const interval = requirePlainRecord(delta.interval, "delta.interval");
  const startedAt = normalizeIsoInstant(interval.started_at, "delta.interval.started_at");
  const endedAt = normalizeIsoInstant(interval.ended_at, "delta.interval.ended_at");
  if (Date.parse(endedAt) < Date.parse(startedAt)) {
    throw new DomainValidationError("delta.interval.ended_at must not precede started_at");
  }
  const baselineRef = normalizeSnapshotReference(delta.baseline_ref, "delta.baseline_ref");
  const currentRef = normalizeSnapshotReference(delta.current_ref, "delta.current_ref");
  if (baselineRef.captured_at !== startedAt) {
    throw new DomainValidationError("delta.baseline_ref.captured_at must equal interval.started_at");
  }
  if (currentRef.captured_at !== endedAt) {
    throw new DomainValidationError("delta.current_ref.captured_at must equal interval.ended_at");
  }
  const normalized = { started_at: startedAt, ended_at: endedAt };
  if (computeStableHash(normalized) !== computeStableHash(interval)) {
    throw new DomainValidationError("delta.interval is not in canonical normalized form");
  }
  if (computeStableHash(baselineRef) !== computeStableHash(delta.baseline_ref)) {
    throw new DomainValidationError("delta.baseline_ref is not in canonical normalized form");
  }
  if (computeStableHash(currentRef) !== computeStableHash(delta.current_ref)) {
    throw new DomainValidationError("delta.current_ref is not in canonical normalized form");
  }
}

function normalizeSnapshotReference(input, label) {
  requirePlainRecord(input, label);
  const id = requireNonEmptyString(input.id, `${label}.id`);
  const hash = requireNonEmptyString(input.hash, `${label}.hash`);
  if (!/^[a-f0-9]{64}$/u.test(hash)) {
    throw new DomainValidationError(`${label}.hash must be a lowercase SHA-256 hash`);
  }
  return immutableJson({ id, hash, captured_at: normalizeIsoInstant(input.captured_at, `${label}.captured_at`) });
}

function normalizeDeltaUsage(input) {
  const normalized = normalizeCumulative(input);
  if (computeStableHash(normalized) !== computeStableHash(input)) {
    throw new DomainValidationError("delta.usage is not in canonical normalized form");
  }
  return normalized;
}

function assertSnapshotIntegrity(snapshot, label) {
  const validation = validateMeteringSnapshotIntegrity(snapshot);
  if (!validation.valid) {
    throw new DomainValidationError(`${label} metering snapshot integrity failed`, validation.errors.map((message) => ({
      code: "invalid_metering_snapshot",
      message,
    })));
  }
  return snapshot;
}

function snapshotReference(snapshot) {
  return immutableJson({
    id: snapshot.id,
    hash: snapshot.snapshot_hash,
    captured_at: snapshot.captured_at,
  });
}

function assertAdvisoryClassification(metering, assurance) {
  requirePlainRecord(metering, "metering_observation.metering");
  requirePlainRecord(assurance, "metering_observation.assurance");
  for (const metric of ["tokens", "calls", "cost"]) {
    if (metering[metric] !== "estimated") {
      throw new DomainValidationError(`metering_observation.metering.${metric} must be 'estimated'`);
    }
    if (assurance.metrics?.[metric] !== "estimated") {
      throw new DomainValidationError(`metering_observation.assurance.metrics.${metric} must be 'estimated'`);
    }
  }
  if (
    assurance.classification !== CODEBURN_ASSURANCE_CLASSIFICATION
    || assurance.enforcement !== "advisory"
    || assurance.trusted_exact !== false
  ) {
    throw new DomainValidationError("CodeBurn observations must be advisory and never trusted-exact");
  }
}

function normalizeExpectedArgv(argv, query) {
  if (!Array.isArray(argv) || argv.some((item) => typeof item !== "string")) {
    throw new DomainValidationError("codeburn argv must be an array of strings");
  }
  const expected = buildCodeBurnReportArgv(query);
  if (argv.length !== expected.length || argv.some((item, index) => item !== expected[index])) {
    throw new DomainValidationError("codeburn argv must equal the allowlisted report command for its scope");
  }
  return Object.freeze([...expected]);
}

function assertReportMatchesQuery(report, query) {
  const period = expectedPeriod(query);
  if (report.period !== period) {
    throw new DomainValidationError(`CodeBurn report period '${report.period}' does not match requested period '${period}'`);
  }
}

function expectedPeriod(query) {
  return `${query.from} to ${query.to}`;
}

function assertSupportedCodeBurnVersion(value) {
  const parsed = parseCodeBurnVersion(requireNonEmptyString(value, "codeburn tool_version"));
  if (!parsed.supported) {
    throw new DomainValidationError(`CodeBurn ${parsed.version} is unsupported; expected 0.9.x`);
  }
  return parsed.version;
}

function normalizeProvider(value) {
  const provider = requireNonEmptyString(value, "codeburn_query.provider").toLowerCase();
  if (!PROVIDER_PATTERN.test(provider)) {
    throw new DomainValidationError("codeburn_query.provider must be an option-safe provider identifier");
  }
  return provider;
}

function normalizeSafeValue(value, label, maxLength, options = {}) {
  const normalized = requireNonEmptyString(value, label);
  if (normalized.length > maxLength) {
    throw new DomainValidationError(`${label} must contain at most ${maxLength} characters`);
  }
  if (!SAFE_TEXT_PATTERN.test(normalized)) {
    throw new DomainValidationError(`${label} contains control characters`);
  }
  if (options.allowLeadingDash !== true && normalized.startsWith("-")) {
    throw new DomainValidationError(`${label} must not start with '-'`);
  }
  return normalized;
}

function normalizeCalendarDate(value, label) {
  const date = requireNonEmptyString(value, label);
  if (!DATE_PATTERN.test(date)) {
    throw new DomainValidationError(`${label} must use YYYY-MM-DD`);
  }
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new DomainValidationError(`${label} must be a valid calendar date`);
  }
  return date;
}

function normalizePositiveInteger(value, label, maximum) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new DomainValidationError(`${label} must be an integer from 1 to ${maximum}`);
  }
  return value;
}

function normalizeDecimal(value, label) {
  let decimal;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new DomainValidationError(`${label} must be a finite non-negative number`);
    }
    decimal = expandExponentialNumber(value);
  } else if (typeof value === "string" && DECIMAL_PATTERN.test(value)) {
    decimal = value;
  } else {
    throw new DomainValidationError(`${label} must be a non-negative decimal number or string`);
  }
  const [integer, fraction = ""] = decimal.split(".");
  const trimmedInteger = integer.replace(/^0+(?=\d)/u, "");
  const trimmedFraction = fraction.replace(/0+$/u, "");
  return trimmedFraction ? `${trimmedInteger}.${trimmedFraction}` : trimmedInteger;
}

function expandExponentialNumber(value) {
  const text = String(Object.is(value, -0) ? 0 : value);
  if (!/[eE]/u.test(text)) {
    return text;
  }
  const [coefficient, exponentText] = text.toLowerCase().split("e");
  const exponent = Number(exponentText);
  const [integer, fraction = ""] = coefficient.split(".");
  const digits = `${integer}${fraction}`;
  const decimalIndex = integer.length + exponent;
  if (decimalIndex <= 0) {
    return `0.${"0".repeat(-decimalIndex)}${digits}`;
  }
  if (decimalIndex >= digits.length) {
    return `${digits}${"0".repeat(decimalIndex - digits.length)}`;
  }
  return `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
}

function subtractMonotonicInteger(baseline, current, label) {
  if (current < baseline) {
    throw new DomainValidationError(`${label} decreased from ${baseline} to ${current}; cumulative counters are not comparable`);
  }
  return current - baseline;
}

function subtractMonotonicDecimal(baseline, current, label) {
  const left = decimalParts(normalizeDecimal(baseline, `${label}.baseline`));
  const right = decimalParts(normalizeDecimal(current, `${label}.current`));
  const scale = Math.max(left.scale, right.scale);
  const leftScaled = left.units * (10n ** BigInt(scale - left.scale));
  const rightScaled = right.units * (10n ** BigInt(scale - right.scale));
  if (rightScaled < leftScaled) {
    throw new DomainValidationError(`${label} decreased from ${baseline} to ${current}; cumulative counters are not comparable`);
  }
  return formatDecimalUnits(rightScaled - leftScaled, scale);
}

function decimalParts(value) {
  const [integer, fraction = ""] = value.split(".");
  return { units: BigInt(`${integer}${fraction}`), scale: fraction.length };
}

function formatDecimalUnits(units, scale) {
  if (scale === 0) {
    return units.toString();
  }
  const digits = units.toString().padStart(scale + 1, "0");
  const value = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return normalizeDecimal(value, "metering delta cost");
}

function rejectUnknownKeys(input, allowed, label) {
  const unexpected = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new DomainValidationError(`${label} contains unsupported field(s): ${unexpected.sort().join(", ")}`);
  }
}

function validateNonEmptyString(value, label, errors) {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${label} must be a non-empty string`);
  }
}

function validateNonNegativeNumber(value, label, errors) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    errors.push(`${label} must be a finite non-negative number`);
  }
}

function validateNonNegativeSafeInteger(value, label, errors) {
  if (!Number.isSafeInteger(value) || value < 0) {
    errors.push(`${label} must be a non-negative safe integer`);
  }
}

function validateNonNegativeSafeIntegerOrThrow(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DomainValidationError(`${label} must be a non-negative safe integer`);
  }
}

function compareMatchedProjects(left, right) {
  const leftKey = `${left.path}\u0000${left.name}`;
  const rightKey = `${right.path}\u0000${right.name}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function normalizeProcessOutput(value) {
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  return typeof value === "string" ? value : "";
}

function normalizeExitCode(value) {
  return Number.isSafeInteger(value) ? value : null;
}

function truncateDiagnostic(value) {
  return value.length <= 2048 ? value : `${value.slice(0, 2048)}…`;
}

function domainMessages(error) {
  if (Array.isArray(error?.issues) && error.issues.length > 0) {
    return error.issues.map((issue) => issue.message || String(issue));
  }
  return [error?.message || String(error)];
}
