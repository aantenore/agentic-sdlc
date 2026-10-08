import path from "node:path";
import readline from "node:readline";

import { Date, fs, os, process } from "./runtime/host.mjs";
import {
  DomainValidationError,
  STABLE_JSON_HASH_ALGORITHM,
  computeStableHash,
  immutableJson,
  isPlainRecord,
  omitKeys,
  requireNonEmptyString,
  requirePlainRecord,
} from "./canonical.mjs";

export const CODEX_SESSION_ADAPTER_ID = "codex-session";
export const CODEX_SESSION_ADAPTER_VERSION = "1.0.0";
export const CODEX_SESSION_REPORT_CONTRACT = "codex-session-token-count:v1";
export const CODEX_SESSION_METERING_CLASSIFICATION = "estimated";
export const CODEX_SESSION_ASSURANCE_CLASSIFICATION = "advisory_observed";

const SNAPSHOT_SCHEMA_VERSION = "metering-snapshot:v1";
const DELTA_SCHEMA_VERSION = "metering-delta:v1";
const THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_DISCOVERED_ENTRIES = 100_000;
const MAX_TARGET_LINE_BYTES = 2 * 1024 * 1024;
const MAX_RELATIVE_PATH_BYTES = 4096;

const ADVISORY_ASSURANCE = Object.freeze({
  classification: CODEX_SESSION_ASSURANCE_CLASSIFICATION,
  enforcement: "advisory",
  trusted_exact: false,
  metrics: Object.freeze({
    tokens: CODEX_SESSION_METERING_CLASSIFICATION,
    calls: CODEX_SESSION_METERING_CLASSIFICATION,
    cost: "unavailable",
  }),
  reasons: Object.freeze([
    "Counters come from Codex token_count events in the exact local session selected by thread id.",
    "The local JSONL is not provider-signed and contains no authoritative pricing.",
  ]),
});

export class CodexSessionMeteringError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "CodexSessionMeteringError";
    this.code = options.code || "codex_session_metering_failed";
  }
}

export function normalizeCodexSessionQuery(input) {
  requirePlainRecord(input, "codex_session_query");
  const unexpected = Object.keys(input).filter((key) => key !== "thread_id");
  if (unexpected.length > 0) {
    throw new DomainValidationError(
      `codex_session_query contains unsupported field(s): ${unexpected.sort().join(", ")}`,
    );
  }
  const threadId = requireNonEmptyString(input.thread_id, "codex_session_query.thread_id");
  if (!THREAD_ID_PATTERN.test(threadId)) {
    throw new DomainValidationError(
      "codex_session_query.thread_id must be an option-safe Codex thread identifier",
    );
  }
  return immutableJson({ thread_id: threadId });
}

export async function collectCodexSessionMeteringSnapshot(input, options = {}) {
  requirePlainRecord(input, "codex_session_collection");
  requirePlainRecord(options, "codex_session_collection.options");
  const id = requireNonEmptyString(input.id, "codex_session_collection.id");
  const query = normalizeCodexSessionQuery(input.query);
  const codexHome = resolveCodexHome(options.codex_home);
  const sessionFile = options.session_file
    ? resolveExplicitSessionFile(options.session_file, codexHome)
    : discoverSessionFile(codexHome, query.thread_id);
  const observation = await parseCodexSessionFile(sessionFile, {
    codex_home: codexHome,
    project_root: options.project_root,
    thread_id: query.thread_id,
  });
  const snapshot = {
    kind: "metering_snapshot",
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    version: 1,
    id,
    adapter: {
      id: CODEX_SESSION_ADAPTER_ID,
      version: CODEX_SESSION_ADAPTER_VERSION,
      report_contract: CODEX_SESSION_REPORT_CONTRACT,
    },
    scope: query,
    captured_at: observation.captured_at,
    cumulative: observation.cumulative,
    metering: {
      tokens: CODEX_SESSION_METERING_CLASSIFICATION,
      calls: CODEX_SESSION_METERING_CLASSIFICATION,
      cost: "unavailable",
    },
    assurance: ADVISORY_ASSURANCE,
    source: observation.source,
  };
  const result = {
    ...snapshot,
    snapshot_hash: computeStableHash(snapshot),
    hash_algorithm: STABLE_JSON_HASH_ALGORITHM,
  };
  const validation = validateCodexSessionMeteringSnapshot(result);
  if (!validation.valid) {
    throw new CodexSessionMeteringError(
      `Codex session snapshot failed integrity validation: ${validation.errors.join("; ")}`,
      { code: "invalid_codex_session_snapshot" },
    );
  }
  return immutableJson(result);
}

export function calculateCodexSessionMeteringDelta(baseline, current, options = {}) {
  requirePlainRecord(options, "codex_session_delta.options");
  const baselineSnapshot = assertSnapshot(baseline, "baseline");
  const currentSnapshot = assertSnapshot(current, "current");
  if (computeStableHash(baselineSnapshot.scope) !== computeStableHash(currentSnapshot.scope)) {
    throw new DomainValidationError(
      "Codex session snapshots use different thread ids; capture a new baseline",
    );
  }
  if (baselineSnapshot.source.session_identity_hash !== currentSnapshot.source.session_identity_hash) {
    throw new DomainValidationError(
      "Codex session identity changed after baseline capture",
    );
  }
  if (Date.parse(currentSnapshot.captured_at) < Date.parse(baselineSnapshot.captured_at)) {
    throw new DomainValidationError("Current Codex session snapshot is older than the baseline");
  }
  if (currentSnapshot.source.file_size_bytes < baselineSnapshot.source.file_size_bytes) {
    throw new DomainValidationError("Codex session JSONL was truncated after baseline capture");
  }

  const tokenFields = [
    "total",
    "input",
    "output",
    "cache_read",
    "cache_write",
    "reasoning_output",
  ];
  const tokens = Object.fromEntries(tokenFields.map((field) => [
    field,
    subtractMonotonicInteger(
      baselineSnapshot.cumulative.tokens[field],
      currentSnapshot.cumulative.tokens[field],
      `cumulative.tokens.${field}`,
    ),
  ]));
  const calls = subtractMonotonicInteger(
    baselineSnapshot.cumulative.calls,
    currentSnapshot.cumulative.calls,
    "cumulative.calls",
  );
  const delta = {
    kind: "metering_delta",
    schema_version: DELTA_SCHEMA_VERSION,
    version: 1,
    id: requireNonEmptyString(options.id, "codex_session_delta.id"),
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
      sessions: 0,
      cost: { amount: "0", currency: "USD" },
    },
    metering: currentSnapshot.metering,
    assurance: currentSnapshot.assurance,
  };
  return immutableJson({
    ...delta,
    delta_hash: computeStableHash(delta),
    hash_algorithm: STABLE_JSON_HASH_ALGORITHM,
  });
}

export function validateCodexSessionMeteringSnapshot(value) {
  const errors = [];
  if (!isPlainRecord(value)) {
    return Object.freeze({
      valid: false,
      expected_hash: null,
      errors: Object.freeze(["snapshot must be a plain object"]),
    });
  }
  const expectedHash = computeStableHash(omitKeys(value, ["snapshot_hash", "hash_algorithm"]));
  if (value.kind !== "metering_snapshot") errors.push("snapshot.kind must be metering_snapshot");
  if (value.schema_version !== SNAPSHOT_SCHEMA_VERSION) {
    errors.push(`snapshot.schema_version must be ${SNAPSHOT_SCHEMA_VERSION}`);
  }
  if (value.version !== 1) errors.push("snapshot.version must be 1");
  if (typeof value.id !== "string" || value.id.trim() === "") {
    errors.push("snapshot.id must be a non-empty string");
  }
  if (value.hash_algorithm !== STABLE_JSON_HASH_ALGORITHM) {
    errors.push(`snapshot.hash_algorithm must be ${STABLE_JSON_HASH_ALGORITHM}`);
  }
  if (value.snapshot_hash !== expectedHash) {
    errors.push("snapshot.snapshot_hash does not match canonical content");
  }
  validateAdapter(value.adapter, errors, "snapshot.adapter");
  validateScope(value.scope, errors, "snapshot.scope");
  validateCumulative(value.cumulative, errors, "snapshot.cumulative");
  validateClassification(value.metering, value.assurance, errors);
  validateSource(value.source, value.scope, errors);
  if (!isIsoInstant(value.captured_at)) errors.push("snapshot.captured_at must be an ISO-8601 instant");
  if (value.captured_at !== value.source?.event_timestamp) {
    errors.push("snapshot.captured_at must equal source.event_timestamp");
  }
  return Object.freeze({
    valid: errors.length === 0,
    expected_hash: expectedHash,
    errors: Object.freeze(Array.from(new Set(errors))),
  });
}

export function validateCodexSessionMeteringDelta(value) {
  const errors = [];
  if (!isPlainRecord(value)) {
    return Object.freeze({
      valid: false,
      expected_hash: null,
      errors: Object.freeze(["delta must be a plain object"]),
    });
  }
  const expectedHash = computeStableHash(omitKeys(value, ["delta_hash", "hash_algorithm"]));
  if (value.kind !== "metering_delta") errors.push("delta.kind must be metering_delta");
  if (value.schema_version !== DELTA_SCHEMA_VERSION) {
    errors.push(`delta.schema_version must be ${DELTA_SCHEMA_VERSION}`);
  }
  if (value.version !== 1) errors.push("delta.version must be 1");
  if (value.hash_algorithm !== STABLE_JSON_HASH_ALGORITHM) {
    errors.push(`delta.hash_algorithm must be ${STABLE_JSON_HASH_ALGORITHM}`);
  }
  if (value.delta_hash !== expectedHash) {
    errors.push("delta.delta_hash does not match canonical content");
  }
  validateAdapter(value.adapter, errors, "delta.adapter");
  validateScope(value.scope, errors, "delta.scope");
  validateCumulative(value.usage, errors, "delta.usage");
  validateClassification(value.metering, value.assurance, errors);
  if (!isIsoInstant(value.interval?.started_at) || !isIsoInstant(value.interval?.ended_at)) {
    errors.push("delta.interval must contain ISO-8601 instants");
  } else if (Date.parse(value.interval.ended_at) < Date.parse(value.interval.started_at)) {
    errors.push("delta.interval.ended_at must not precede started_at");
  }
  validateSnapshotReference(value.baseline_ref, value.interval?.started_at, errors, "delta.baseline_ref");
  validateSnapshotReference(value.current_ref, value.interval?.ended_at, errors, "delta.current_ref");
  return Object.freeze({
    valid: errors.length === 0,
    expected_hash: expectedHash,
    errors: Object.freeze(Array.from(new Set(errors))),
  });
}

export function mapCodexSessionUsage(delta, budget, mapping) {
  const integrity = validateCodexSessionMeteringDelta(delta);
  if (!integrity.valid) {
    throw new DomainValidationError(
      "Codex session delta failed integrity validation",
      integrity.errors,
    );
  }
  requirePlainRecord(budget, "budget");
  requirePlainRecord(mapping, "codex_session_metric_mapping");
  const token = delta.usage.tokens;
  const sourceValues = {
    "tokens.total": token.total,
    "tokens.input": token.input,
    "tokens.output": token.output,
    "tokens.cache_read": token.cache_read,
    "tokens.cache_write": token.cache_write,
    calls: delta.usage.calls,
  };
  const usage = {};
  for (const [metric, source] of Object.entries(mapping)) {
    if (!Object.hasOwn(sourceValues, source)) {
      throw new DomainValidationError(
        `Codex session metric mapping '${source}' is unsupported`,
      );
    }
    usage[metric] = sourceValues[source];
  }
  return immutableJson(usage);
}

async function parseCodexSessionFile(sessionFile, options) {
  const fileStat = fs.lstatSync(sessionFile);
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw new CodexSessionMeteringError(
      `Refusing linked or non-file Codex session: ${sessionFile}`,
      { code: "unsafe_codex_session_file" },
    );
  }
  const input = fs.createReadStream(sessionFile, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let sessionMeta = null;
  let latest = null;
  let previousTotal = null;
  let calls = 0;
  try {
    for await (const line of lines) {
      if (!line.includes('"session_meta"') && !line.includes('"token_count"')) {
        continue;
      }
      if (Buffer.byteLength(line) > MAX_TARGET_LINE_BYTES) {
        throw new CodexSessionMeteringError(
          "Codex session metadata or token_count line exceeds the supported size",
          { code: "oversized_codex_session_line" },
        );
      }
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        throw new CodexSessionMeteringError(
          "Codex session contains malformed metadata or token_count JSON",
          { code: "malformed_codex_session_event" },
        );
      }
      if (entry?.type === "session_meta") {
        const candidateId = entry.payload?.id ?? entry.payload?.session_id;
        if (candidateId === options.thread_id && sessionMeta === null) {
          sessionMeta = {
            id: candidateId,
            cwd: typeof entry.payload?.cwd === "string" ? entry.payload.cwd : null,
            source: typeof entry.payload?.source === "string" ? entry.payload.source : null,
          };
        }
        continue;
      }
      if (entry?.type !== "event_msg" || entry.payload?.type !== "token_count") {
        continue;
      }
      const info = entry.payload?.info;
      // A token_count event without info carries only rate-limit context and
      // no counters yet; any event that does carry counters must be valid.
      if (info === null || info === undefined) continue;
      const total = normalizeTokenUsage(info?.total_token_usage);
      if (!total || !isIsoInstant(entry.timestamp)) {
        throw new CodexSessionMeteringError(
          `Codex session contains an invalid token_count event${isIsoInstant(entry.timestamp) ? ` at ${entry.timestamp}` : " without a valid timestamp"}: `
            + "its counters are missing, negative, or not whole numbers",
          { code: "malformed_codex_session_event" },
        );
      }
      if (previousTotal !== null && total.total < previousTotal) {
        throw new CodexSessionMeteringError(
          "Codex cumulative token counter regressed inside the selected session",
          { code: "codex_session_counter_reset" },
        );
      }
      if (previousTotal === null || total.total > previousTotal) calls += 1;
      previousTotal = total.total;
      latest = {
        captured_at: new Date(Date.parse(entry.timestamp)).toISOString(),
        total,
        rate_limits: normalizeRateLimits(entry.payload?.rate_limits),
        event_hash: computeStableHash({
          timestamp: entry.timestamp,
          total_token_usage: entry.payload.info.total_token_usage,
          rate_limits: normalizeRateLimits(entry.payload?.rate_limits),
        }),
      };
    }
  } finally {
    lines.close();
    input.destroy();
  }
  if (!sessionMeta) {
    throw new CodexSessionMeteringError(
      `Codex session does not contain session_meta for thread ${options.thread_id}`,
      { code: "codex_session_identity_mismatch" },
    );
  }
  if (!latest) {
    throw new CodexSessionMeteringError(
      `Codex session ${options.thread_id} contains no usable token_count event`,
      { code: "codex_session_token_count_missing" },
    );
  }
  assertProjectBinding(sessionMeta.cwd, options.project_root);
  const nonCachedInput = Math.max(
    0,
    latest.total.input - latest.total.cacheRead - latest.total.cacheWrite,
  );
  const relativePath = path.relative(options.codex_home, sessionFile).split(path.sep).join("/");
  if (
    relativePath.startsWith("../")
    || path.isAbsolute(relativePath)
    || Buffer.byteLength(relativePath) > MAX_RELATIVE_PATH_BYTES
  ) {
    throw new CodexSessionMeteringError(
      "Resolved Codex session path escapes CODEX_HOME",
      { code: "codex_session_path_escape" },
    );
  }
  return {
    captured_at: latest.captured_at,
    cumulative: {
      tokens: {
        total: latest.total.total,
        input: nonCachedInput,
        output: latest.total.output,
        cache_read: latest.total.cacheRead,
        cache_write: latest.total.cacheWrite,
        reasoning_output: latest.total.reasoningOutput,
      },
      calls,
      sessions: 1,
      cost: { amount: "0", currency: "USD" },
    },
    source: {
      session_id: sessionMeta.id,
      session_identity_hash: computeStableHash({
        id: sessionMeta.id,
        cwd: sessionMeta.cwd,
        source: sessionMeta.source,
      }),
      project_scope_hash: computeStableHash({ cwd: sessionMeta.cwd }),
      relative_path: relativePath,
      file_size_bytes: fileStat.size,
      event_timestamp: latest.captured_at,
      event_hash: latest.event_hash,
      rate_limits: latest.rate_limits,
      shell: false,
      authentication_required: false,
    },
  };
}

function resolveCodexHome(configured) {
  const raw = configured ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new CodexSessionMeteringError("CODEX_HOME must be a non-empty path");
  }
  const absolute = path.resolve(raw);
  let resolved;
  try {
    resolved = fs.realpathSync(absolute);
  } catch (error) {
    throw new CodexSessionMeteringError(`Could not resolve CODEX_HOME ${absolute}`, {
      cause: error,
      code: "codex_home_unavailable",
    });
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new CodexSessionMeteringError(`CODEX_HOME is not a directory: ${resolved}`);
  }
  return resolved;
}

function resolveExplicitSessionFile(configured, codexHome) {
  const absolute = path.resolve(requireNonEmptyString(configured, "codex_session_file"));
  try {
    if (fs.lstatSync(absolute).isSymbolicLink()) {
      throw new CodexSessionMeteringError(
        `Refusing linked Codex session file: ${absolute}`,
        { code: "unsafe_codex_session_file" },
      );
    }
  } catch (error) {
    if (error instanceof CodexSessionMeteringError) throw error;
    throw new CodexSessionMeteringError(`Could not inspect Codex session file ${absolute}`, {
      cause: error,
      code: "codex_session_file_missing",
    });
  }
  let resolved;
  try {
    resolved = fs.realpathSync(absolute);
  } catch (error) {
    throw new CodexSessionMeteringError(`Could not resolve Codex session file ${absolute}`, {
      cause: error,
      code: "codex_session_file_missing",
    });
  }
  assertInside(codexHome, resolved);
  return resolved;
}

function discoverSessionFile(codexHome, threadId) {
  const roots = ["sessions", "archived_sessions"]
    .map((name) => path.join(codexHome, name))
    .filter((candidate) => {
      try {
        return fs.statSync(candidate).isDirectory();
      } catch {
        return false;
      }
    });
  const matches = [];
  let entries = 0;
  const stack = [...roots];
  while (stack.length > 0) {
    const current = stack.pop();
    const currentStat = fs.lstatSync(current);
    if (!currentStat.isDirectory() || currentStat.isSymbolicLink()) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      entries += 1;
      if (entries > MAX_DISCOVERED_ENTRIES) {
        throw new CodexSessionMeteringError(
          "Codex session discovery exceeded the supported entry limit",
          { code: "codex_session_discovery_limit" },
        );
      }
      const candidate = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(candidate);
      } else if (
        entry.isFile()
        && entry.name.endsWith(".jsonl")
        && entry.name.includes(threadId)
      ) {
        assertInside(codexHome, fs.realpathSync(candidate));
        matches.push({ path: candidate, mtime: fs.statSync(candidate).mtimeMs });
      }
    }
  }
  if (matches.length === 0) {
    throw new CodexSessionMeteringError(
      `No local Codex session found for thread ${threadId}`,
      { code: "codex_session_not_found" },
    );
  }
  matches.sort((left, right) => right.mtime - left.mtime || left.path.localeCompare(right.path));
  return matches[0].path;
}

function normalizeTokenUsage(value) {
  if (!isPlainRecord(value)) return null;
  const input = nonNegativeSafeInteger(value.input_tokens);
  const output = nonNegativeSafeInteger(value.output_tokens);
  const cacheRead = nonNegativeSafeInteger(value.cached_input_tokens);
  const cacheWrite = nonNegativeSafeInteger(value.cache_write_input_tokens);
  const reasoningOutput = nonNegativeSafeInteger(value.reasoning_output_tokens);
  const total = nonNegativeSafeInteger(value.total_tokens);
  if ([input, output, cacheRead, cacheWrite, reasoningOutput, total].includes(null)) {
    return null;
  }
  if (total !== input + output) {
    throw new CodexSessionMeteringError(
      "Codex token_count total_tokens does not equal input_tokens + output_tokens",
      { code: "invalid_codex_token_total" },
    );
  }
  if (cacheRead + cacheWrite > input) {
    throw new CodexSessionMeteringError(
      "Codex cached input counters exceed input_tokens",
      { code: "invalid_codex_cache_total" },
    );
  }
  return { total, input, output, cacheRead, cacheWrite, reasoningOutput };
}

function normalizeRateLimits(value) {
  if (!isPlainRecord(value)) return null;
  const normalizeWindow = (window) => {
    if (!isPlainRecord(window)) return null;
    return {
      used_percent: finiteNumberOrNull(window.used_percent),
      window_minutes: nonNegativeSafeInteger(window.window_minutes),
      resets_at: finiteNumberOrNull(window.resets_at),
    };
  };
  return {
    limit_id: typeof value.limit_id === "string" ? value.limit_id : null,
    primary: normalizeWindow(value.primary),
    secondary: normalizeWindow(value.secondary),
    credits: isPlainRecord(value.credits) ? {
      has_credits: typeof value.credits.has_credits === "boolean" ? value.credits.has_credits : null,
      unlimited: typeof value.credits.unlimited === "boolean" ? value.credits.unlimited : null,
      balance: finiteNumberOrNull(value.credits.balance),
    } : null,
    spend_control_reached: typeof value.spend_control_reached === "boolean"
      ? value.spend_control_reached
      : null,
    rate_limit_reached_type: typeof value.rate_limit_reached_type === "string"
      ? value.rate_limit_reached_type
      : null,
  };
}

function assertProjectBinding(sessionCwd, projectRoot) {
  if (!projectRoot) return;
  if (typeof sessionCwd !== "string" || sessionCwd.trim() === "") {
    throw new CodexSessionMeteringError(
      "Codex session metadata does not contain a project cwd",
      { code: "codex_session_project_missing" },
    );
  }
  const expected = normalizeComparablePath(projectRoot);
  const actual = normalizeComparablePath(sessionCwd);
  if (actual !== expected) {
    throw new CodexSessionMeteringError(
      "Codex session cwd does not match the target project root",
      { code: "codex_session_project_mismatch" },
    );
  }
}

function normalizeComparablePath(value) {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function assertInside(root, candidate) {
  const relative = path.relative(root, candidate);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new CodexSessionMeteringError(
    `Codex session path escapes CODEX_HOME: ${candidate}`,
    { code: "codex_session_path_escape" },
  );
}

function validateAdapter(value, errors, label) {
  if (
    value?.id !== CODEX_SESSION_ADAPTER_ID
    || value?.version !== CODEX_SESSION_ADAPTER_VERSION
    || value?.report_contract !== CODEX_SESSION_REPORT_CONTRACT
  ) {
    errors.push(`${label} must identify ${CODEX_SESSION_ADAPTER_ID} ${CODEX_SESSION_ADAPTER_VERSION}`);
  }
}

function validateScope(value, errors, label) {
  try {
    const normalized = normalizeCodexSessionQuery(value);
    if (computeStableHash(normalized) !== computeStableHash(value)) {
      errors.push(`${label} is not canonical`);
    }
  } catch (error) {
    errors.push(error.message);
  }
}

function validateCumulative(value, errors, label) {
  const tokenFields = ["total", "input", "output", "cache_read", "cache_write", "reasoning_output"];
  for (const field of tokenFields) {
    if (!Number.isSafeInteger(value?.tokens?.[field]) || value.tokens[field] < 0) {
      errors.push(`${label}.tokens.${field} must be a non-negative safe integer`);
    }
  }
  if (!Number.isSafeInteger(value?.calls) || value.calls < 0) {
    errors.push(`${label}.calls must be a non-negative safe integer`);
  }
  if (!Number.isSafeInteger(value?.sessions) || value.sessions < 0) {
    errors.push(`${label}.sessions must be a non-negative safe integer`);
  }
  if (value?.cost?.amount !== "0" || value?.cost?.currency !== "USD") {
    errors.push(`${label}.cost must remain unavailable as 0 USD`);
  }
}

function validateClassification(metering, assurance, errors) {
  if (
    metering?.tokens !== "estimated"
    || metering?.calls !== "estimated"
    || metering?.cost !== "unavailable"
  ) {
    errors.push("Codex session metering classification is invalid");
  }
  if (computeStableHash(assurance) !== computeStableHash(ADVISORY_ASSURANCE)) {
    errors.push("Codex session assurance must remain advisory_observed and not trusted-exact");
  }
}

function validateSource(value, scope, errors) {
  if (!isPlainRecord(value)) {
    errors.push("snapshot.source must be a plain object");
    return;
  }
  if (value.session_id !== scope?.thread_id) errors.push("source.session_id must match scope.thread_id");
  for (const field of ["session_identity_hash", "project_scope_hash", "event_hash"]) {
    if (!HASH_PATTERN.test(value[field] || "")) errors.push(`source.${field} must be a SHA-256 hash`);
  }
  if (
    typeof value.relative_path !== "string"
    || value.relative_path.startsWith("../")
    || path.posix.isAbsolute(value.relative_path)
  ) {
    errors.push("source.relative_path must stay inside CODEX_HOME");
  }
  if (!Number.isSafeInteger(value.file_size_bytes) || value.file_size_bytes < 0) {
    errors.push("source.file_size_bytes must be a non-negative safe integer");
  }
  if (!isIsoInstant(value.event_timestamp)) errors.push("source.event_timestamp must be an ISO instant");
  if (value.shell !== false || value.authentication_required !== false) {
    errors.push("Codex session collection must be local, shell-free, and authentication-free");
  }
  validateRateLimits(value.rate_limits, errors);
}

function validateRateLimits(value, errors) {
  if (value === null) return;
  if (!isPlainRecord(value)) {
    errors.push("source.rate_limits must be a plain object or null");
    return;
  }
  for (const label of ["primary", "secondary"]) {
    const window = value[label];
    if (window === null) continue;
    if (
      !isPlainRecord(window)
      || !nullableFiniteNumber(window.used_percent)
      || !nullableNonNegativeSafeInteger(window.window_minutes)
      || !nullableFiniteNumber(window.resets_at)
    ) {
      errors.push(`source.rate_limits.${label} is invalid`);
    }
  }
  const credits = value.credits;
  if (
    credits !== null
    && (
      !isPlainRecord(credits)
      || !nullableBoolean(credits.has_credits)
      || !nullableBoolean(credits.unlimited)
      || !nullableFiniteNumber(credits.balance)
    )
  ) {
    errors.push("source.rate_limits.credits is invalid");
  }
  if (!nullableBoolean(value.spend_control_reached)) {
    errors.push("source.rate_limits.spend_control_reached is invalid");
  }
  if (value.rate_limit_reached_type !== null && typeof value.rate_limit_reached_type !== "string") {
    errors.push("source.rate_limits.rate_limit_reached_type is invalid");
  }
}

function nullableFiniteNumber(value) {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function nullableNonNegativeSafeInteger(value) {
  return value === null || (Number.isSafeInteger(value) && value >= 0);
}

function nullableBoolean(value) {
  return value === null || typeof value === "boolean";
}

function validateSnapshotReference(value, expectedTimestamp, errors, label) {
  if (
    typeof value?.id !== "string"
    || !HASH_PATTERN.test(value?.hash || "")
    || value?.captured_at !== expectedTimestamp
  ) {
    errors.push(`${label} is invalid`);
  }
}

function assertSnapshot(value, label) {
  const validation = validateCodexSessionMeteringSnapshot(value);
  if (!validation.valid) {
    throw new DomainValidationError(
      `${label} Codex session snapshot failed integrity validation`,
      validation.errors,
    );
  }
  return value;
}

function snapshotReference(snapshot) {
  return {
    id: snapshot.id,
    hash: snapshot.snapshot_hash,
    captured_at: snapshot.captured_at,
  };
}

function subtractMonotonicInteger(baseline, current, label) {
  if (current < baseline) {
    throw new DomainValidationError(
      `${label} decreased from ${baseline} to ${current}; cumulative counters are not comparable`,
    );
  }
  return current - baseline;
}

function nonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function finiteNumberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isIsoInstant(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T/u.test(value)
    && Number.isFinite(Date.parse(value));
}
