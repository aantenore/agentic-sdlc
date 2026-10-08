const POLICY_STATE = new WeakMap();
const OPERATIONAL_CREDENTIAL_ASSIGNMENTS = Symbol("operationalCredentialAssignments");
const LEGACY_EVIDENCE_V1_BEHAVIOR = Symbol("legacyEvidenceV1Behavior");
const EXACT_IDENTIFIER_PATTERNS = Symbol("exactIdentifierPatterns");
const EXACT_SENSITIVE_KEYS = Symbol("exactSensitiveKeys");
const EXACT_CREDENTIAL_ASSIGNMENT_PATTERN = Symbol("exactCredentialAssignmentPattern");
const REDACTION_ALGORITHM = Symbol("redactionAlgorithm");
const LEGACY_EMAIL_LINEAR_ENGINE = "legacy_email_linear_v1";

export const REDACTION_POLICY_SOURCE_SCHEMA = "agentic-sdlc-redaction-policy-source:v1";

export const REDACTION_PLACEHOLDER = "[REDACTED]";
export const REDACTION_LIMIT_PLACEHOLDER = "[REDACTED:LIMIT_EXCEEDED]";

const DEFAULT_LIMITS = Object.freeze({
  maxDepth: 24,
  maxNodes: 10_000,
  maxStringLength: 262_144,
  maxOutputChars: 1_048_576,
  maxMatches: 2_000,
  maxPatterns: 64,
  maxPatternLength: 512,
});
const CUSTOM_PATTERN_MAX_REPETITION = 256;

const LEGACY_EVIDENCE_V1_SENSITIVE_KEYS = Object.freeze([
  "access_token",
  "api_key",
  "authorization",
  "client_secret",
  "cookie",
  "password",
  "private_key",
  "refresh_token",
  "secret",
  "set_cookie",
  "token",
]);

const DEFAULT_SENSITIVE_KEYS = Object.freeze([
  ...LEGACY_EVIDENCE_V1_SENSITIVE_KEYS,
  "account_key",
  "credential",
  "credentials",
  "passphrase",
  "passwd",
  "pwd",
]);

const BUILTIN_IDENTIFIER_PATTERNS = Object.freeze([
  Object.freeze({
    name: "sha_digest",
    pattern: /^(?:(?:sha(?:1|224|256|384|512))[:=-])?(?:[a-f0-9]{40}|[a-f0-9]{56}|[a-f0-9]{64}|[a-f0-9]{96}|[a-f0-9]{128})$/iu,
  }),
  Object.freeze({
    name: "uuid",
    pattern: /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu,
  }),
  Object.freeze({
    name: "correlation_id",
    pattern: /^corr-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu,
  }),
  Object.freeze({
    name: "authorization_action_id",
    pattern: /^AUT-ACT-\d{17}-[a-f0-9]{6}$/u,
  }),
]);

// The first operational_v2 detector set. Policy sources stored with trace
// evidence must contain at least these detectors, so this list is frozen: a
// later detector is added to OPERATIONAL_EXTENDED_SECRET_PATTERNS instead, which
// keeps every previously written policy source verifiable.
const OPERATIONAL_V2_BASELINE_SECRET_PATTERNS = Object.freeze([
  Object.freeze({ name: "common_access_token", pattern: /\b(?:AKIA[A-Z0-9]{16}|gh[opsur]_[A-Za-z0-9_]{20,262144}|github_pat_[A-Za-z0-9_]{20,262144}|glpat-[A-Za-z0-9_-]{20,262144}|sk-(?:proj-)?[A-Za-z0-9_-]{20,262144}|sk_(?:live|test)_[A-Za-z0-9_-]{16,262144}|xox[baprs]-[A-Za-z0-9-]{16,262144})\b/gu }),
  Object.freeze({ name: "bearer_credential", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,262144}/giu }),
  Object.freeze({ name: "basic_credential", pattern: /\bBasic\s+[A-Za-z0-9+/]{8,262144}={0,2}/giu }),
  Object.freeze({ name: "json_web_token", pattern: /\beyJ[A-Za-z0-9_-]{5,4096}\.[A-Za-z0-9_-]{5,131072}\.[A-Za-z0-9_-]{10,8192}\b/gu }),
  Object.freeze({ name: "cookie_header", pattern: /\b(?:Set-Cookie|Cookie)\s*:\s*[^\r\n]{1,262144}/giu }),
  Object.freeze({ name: "url_userinfo", pattern: /\b[a-z][a-z0-9+.-]{0,20}:\/\/[^/\s:?#]{0,262144}:[^/\s?#]{0,262144}@/giu }),
  Object.freeze({ name: "private_key_block", pattern: /-----BEGIN [A-Z ]{0,32}PRIVATE KEY-----[\s\S]{0,262144}?(?:-----END [A-Z ]{0,32}PRIVATE KEY-----|$)/gu }),
]);

// Additional credential shapes. Every detector is anchored on a documented
// vendor prefix or an explicit command-line/configuration context, so plain
// identifiers, paths and hashes stay readable.
const OPERATIONAL_EXTENDED_SECRET_PATTERNS = Object.freeze([
  Object.freeze({
    name: "vendor_access_token",
    pattern: /\b(?:ASIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{35}|npm_[A-Za-z0-9]{36}|hf_[A-Za-z0-9]{30,64}|rk_(?:live|test)_[A-Za-z0-9]{16,262144}|SG\.[A-Za-z0-9_-]{16,64}\.[A-Za-z0-9_-]{16,128}|gldt-[A-Za-z0-9_-]{20,262144})(?![A-Za-z0-9_-])/gu,
  }),
  Object.freeze({
    name: "slack_webhook_url",
    pattern: /\bhttps:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9_/-]{8,4096}/gu,
  }),
  Object.freeze({
    name: "cli_secret_option_value",
    pattern: /(?<=(?:^|\s)--(?:password|passwd|pass|token|access-token|api-key|apikey|secret|client-secret)\s{1,16})(?:"[^"\r\n]{1,4096}"|'[^'\r\n]{1,4096}'|[^\s"'-][^\s"']{0,4095})/gu,
  }),
  Object.freeze({
    name: "cli_user_credential",
    pattern: /(?<=(?:^|\s)(?:-u|--user)\s{1,16})(?:"[^"\r\n:]{0,256}:[^"\r\n]{1,4096}"|'[^'\r\n:]{0,256}:[^'\r\n]{1,4096}'|[^\s"':]{0,256}:[^\s"']{1,4096})/gu,
  }),
  Object.freeze({
    name: "container_registry_auth",
    pattern: /(?<="auth"\s{0,16}:\s{0,16}")[A-Za-z0-9+/]{12,262144}={0,2}(?=")/gu,
  }),
]);

export const BUILTIN_OPERATIONAL_SECRET_PATTERNS = Object.freeze([
  ...OPERATIONAL_V2_BASELINE_SECRET_PATTERNS,
  ...OPERATIONAL_EXTENDED_SECRET_PATTERNS,
]);

export const BUILTIN_OPERATIONAL_PII_PATTERNS = Object.freeze([
  // Email fields are deliberately bounded. The common unbounded form using
  // three `+` quantifiers can become quadratic on a long non-email string.
  Object.freeze({ name: "email", pattern: /\b[^\s@]{1,64}@[^\s@]{1,189}\.[^\s@]{1,63}\b/giu }),
]);

// These detectors and their allowlist semantics are frozen solely so evidence
// references written by the first redacted_utf8_v1 implementation remain
// verifiable. New redaction must use createOperationalRedactionPolicy instead:
// entropy alone is not evidence that an identifier is a secret.
const LEGACY_EVIDENCE_V1_SECRET_PATTERNS = Object.freeze([
  Object.freeze({ name: "common_access_token", pattern: /\b(?:AKIA[A-Z0-9]{16}|gh[opsu]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|sk_(?:live|test)_[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/gu }),
  Object.freeze({ name: "bearer_value", pattern: /(?<=\bBearer\s)[A-Za-z0-9._~+/=-]{16,}/giu }),
  Object.freeze({ name: "generic_high_entropy_candidate", pattern: /\b[A-Za-z0-9_-]{32,}\b/gu }),
]);

const LEGACY_EVIDENCE_V1_PII_PATTERNS = Object.freeze([
  // The historical writer used /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/giu. Replaying
  // that expression directly is quadratic on adversarial non-email input, so
  // the compatibility engine below implements the same token and word-boundary
  // semantics with a linear scanner.
  Object.freeze({ name: "email", engine: LEGACY_EMAIL_LINEAR_ENGINE }),
]);

const HISTORICAL_OPERATIONAL_V1_CREDENTIAL_ASSIGNMENT_PREFIX_PATTERN = /(?:["'](?=[A-Za-z0-9_])|\b)[A-Za-z0-9_]{0,128}(?:access[_-]?token|api[_-]?key|authorization|client[_-]?secret|password|private[_-]?key|refresh[_-]?token|secret[_-]?access[_-]?key|secret[_-]?key|secret|storage[_-]?account[_-]?key|token)["']?\s*[:=]\s*/giu;
const CREDENTIAL_ASSIGNMENT_PREFIX_PATTERN = /(?:["'](?=[A-Za-z0-9_])|\b)[A-Za-z0-9_]{0,128}(?:access[_-]?token|account[_-]?key|api[_-]?key|authorization|client[_-]?secret|credentials?|passphrase|passwd|password|private[_-]?key|pwd|refresh[_-]?token|secret[_-]?access[_-]?key|secret[_-]?key|secret|storage[_-]?account[_-]?key|token)["']?\s*[:=]\s*/giu;

// Built-in detectors are immutable, reviewed source code. User-provided
// patterns are deliberately held to a narrower, provably bounded grammar so a
// project configuration cannot introduce catastrophic regexp backtracking on
// the CLI or Observatory event loop.
const TRUSTED_BUILTIN_PATTERNS = new WeakSet([
  ...BUILTIN_IDENTIFIER_PATTERNS,
  ...BUILTIN_OPERATIONAL_SECRET_PATTERNS,
  ...BUILTIN_OPERATIONAL_PII_PATTERNS,
  ...LEGACY_EVIDENCE_V1_SECRET_PATTERNS,
  ...LEGACY_EVIDENCE_V1_PII_PATTERNS,
]);
const AUDITED_MULTI_QUANTIFIER_PATTERN_SOURCES = new Set([
  ...BUILTIN_IDENTIFIER_PATTERNS,
  ...BUILTIN_OPERATIONAL_SECRET_PATTERNS,
  ...BUILTIN_OPERATIONAL_PII_PATTERNS,
  ...LEGACY_EVIDENCE_V1_SECRET_PATTERNS,
  ...LEGACY_EVIDENCE_V1_PII_PATTERNS,
].filter((entry) => entry.pattern).map((entry) => entry.pattern.source));
AUDITED_MULTI_QUANTIFIER_PATTERN_SOURCES.add(CREDENTIAL_ASSIGNMENT_PREFIX_PATTERN.source);
AUDITED_MULTI_QUANTIFIER_PATTERN_SOURCES.add(
  HISTORICAL_OPERATIONAL_V1_CREDENTIAL_ASSIGNMENT_PREFIX_PATTERN.source,
);

export class RedactionConfigurationError extends TypeError {
  constructor(message) {
    super(message);
    this.name = "RedactionConfigurationError";
    this.code = "redaction_configuration_invalid";
  }
}

export class RedactionLimitError extends Error {
  constructor(limit) {
    super(`Redaction stopped at configured limit '${limit}'`);
    this.name = "RedactionLimitError";
    this.code = "redaction_limit_exceeded";
    this.limit = limit;
  }
}

export function createRedactionPolicy(options = {}) {
  requirePlainRecord(options, "redaction options");
  const limits = normalizeLimits(options.limits);
  const replacement = normalizeReplacement(options.replacement);
  const secrets = normalizeSecrets(options.secrets, replacement);
  const secretPatterns = normalizePatterns(options.secretPatterns, "secretPatterns", limits);
  const piiPatterns = normalizePatterns(options.piiPatterns, "piiPatterns", limits);
  const customIdentifiers = normalizePatterns(
    options.identifierAllowPatterns,
    "identifierAllowPatterns",
    limits,
  );
  const patternCount = secretPatterns.length + piiPatterns.length + customIdentifiers.length;
  if (patternCount > limits.maxPatterns) {
    throw new RedactionConfigurationError(
      `Configured patterns exceed maxPatterns (${limits.maxPatterns})`,
    );
  }

  const sensitiveKeys = normalizeSensitiveKeys(
    options.sensitiveKeys,
    options[EXACT_SENSITIVE_KEYS] !== true,
  );
  const credentialAssignments = options[OPERATIONAL_CREDENTIAL_ASSIGNMENTS] === true;
  const assignmentPatternInput = options[EXACT_CREDENTIAL_ASSIGNMENT_PATTERN]
    ?? { name: "credential_assignment_prefix", pattern: CREDENTIAL_ASSIGNMENT_PREFIX_PATTERN };
  const credentialAssignmentDetector = credentialAssignments
    ? normalizePatterns([assignmentPatternInput], "credentialAssignmentPattern", limits)[0]
    : null;
  const publicPolicy = Object.freeze({
    schema_version: "agentic-sdlc-redaction-policy:v1",
    replacement,
    limits,
    sensitive_keys: Object.freeze([...sensitiveKeys].sort()),
    detector_count: secretPatterns.length + piiPatterns.length,
    identifier_allowlist: Object.freeze([
      ...BUILTIN_IDENTIFIER_PATTERNS.map(({ name }) => name),
      ...customIdentifiers.map(({ name }) => name),
    ]),
  });
  POLICY_STATE.set(publicPolicy, Object.freeze({
    limits,
    replacement,
    secrets,
    patterns: Object.freeze([...secretPatterns, ...piiPatterns]),
    identifierPatterns: Object.freeze(
      options[EXACT_IDENTIFIER_PATTERNS] === true
        ? [...customIdentifiers]
        : [...BUILTIN_IDENTIFIER_PATTERNS, ...customIdentifiers],
    ),
    sensitiveKeys: new Set(sensitiveKeys),
    credentialAssignments,
    credentialAssignmentDetector,
    legacyEvidenceV1: options[LEGACY_EVIDENCE_V1_BEHAVIOR] === true,
    algorithm: options[REDACTION_ALGORITHM] ?? null,
  }));
  return publicPolicy;
}

export const DEFAULT_REDACTION_POLICY = createRedactionPolicy();

export function createOperationalRedactionPolicy(options = {}) {
  requirePlainRecord(options, "operational redaction options");
  const secretPatterns = options.secretPatterns ?? [];
  const piiPatterns = options.piiPatterns ?? [];
  if (!Array.isArray(secretPatterns) || !Array.isArray(piiPatterns)) {
    throw new RedactionConfigurationError("operational detector patterns must be arrays");
  }
  return createRedactionPolicy({
    ...options,
    [OPERATIONAL_CREDENTIAL_ASSIGNMENTS]: true,
    secretPatterns: [...BUILTIN_OPERATIONAL_SECRET_PATTERNS, ...secretPatterns],
    piiPatterns: [...BUILTIN_OPERATIONAL_PII_PATTERNS, ...piiPatterns],
  });
}

export const DEFAULT_OPERATIONAL_REDACTION_POLICY = createOperationalRedactionPolicy();

/** Frozen policy used by the later historical v1 writer before v2 bindings. */
export function createHistoricalOperationalEvidenceV1RedactionPolicy(options = {}) {
  requirePlainRecord(options, "historical operational evidence v1 redaction options");
  const secretPatterns = options.secretPatterns ?? [];
  const piiPatterns = options.piiPatterns ?? [];
  if (!Array.isArray(secretPatterns) || !Array.isArray(piiPatterns)) {
    throw new RedactionConfigurationError("historical operational evidence detector patterns must be arrays");
  }
  return createRedactionPolicy({
    ...options,
    [REDACTION_ALGORITHM]: "operational_evidence_v1",
    [OPERATIONAL_CREDENTIAL_ASSIGNMENTS]: true,
    [EXACT_CREDENTIAL_ASSIGNMENT_PATTERN]: {
      name: "credential_assignment_prefix",
      pattern: HISTORICAL_OPERATIONAL_V1_CREDENTIAL_ASSIGNMENT_PREFIX_PATTERN,
    },
    [EXACT_SENSITIVE_KEYS]: true,
    sensitiveKeys: [
      ...LEGACY_EVIDENCE_V1_SENSITIVE_KEYS,
      ...(options.sensitiveKeys ?? []),
    ],
    secretPatterns: [...OPERATIONAL_V2_BASELINE_SECRET_PATTERNS, ...secretPatterns],
    piiPatterns: [...BUILTIN_OPERATIONAL_PII_PATTERNS, ...piiPatterns],
  });
}

/**
 * Minimum operational_v2 policy that every stored policy source must contain.
 * It is a verification baseline only; new redaction uses
 * createOperationalRedactionPolicy, which adds the extended detectors.
 */
export function createOperationalBaselineRedactionPolicy() {
  return createRedactionPolicy({
    [OPERATIONAL_CREDENTIAL_ASSIGNMENTS]: true,
    secretPatterns: [...OPERATIONAL_V2_BASELINE_SECRET_PATTERNS],
    piiPatterns: [...BUILTIN_OPERATIONAL_PII_PATTERNS],
  });
}

/**
 * Recreate the exact detector and allowlist behavior used by historical
 * redacted_utf8_v1 evidence references. This policy is compatibility-only and
 * must never be used to write a new evidence reference.
 */
export function createLegacyEvidenceV1RedactionPolicy(options = {}) {
  requirePlainRecord(options, "legacy evidence v1 redaction options");
  const secretPatterns = options.secretPatterns ?? [];
  const piiPatterns = options.piiPatterns ?? [];
  if (!Array.isArray(secretPatterns) || !Array.isArray(piiPatterns)) {
    throw new RedactionConfigurationError("legacy evidence detector patterns must be arrays");
  }
  return createRedactionPolicy({
    ...options,
    [LEGACY_EVIDENCE_V1_BEHAVIOR]: true,
    [EXACT_SENSITIVE_KEYS]: true,
    sensitiveKeys: [
      ...LEGACY_EVIDENCE_V1_SENSITIVE_KEYS,
      ...(options.sensitiveKeys ?? []),
    ],
    secretPatterns: [...LEGACY_EVIDENCE_V1_SECRET_PATTERNS, ...secretPatterns],
    piiPatterns: [...LEGACY_EVIDENCE_V1_PII_PATTERNS, ...piiPatterns],
  });
}

/**
 * Return the complete, JSON-safe policy source that determines redacted bytes.
 * Literal secret values are intentionally not serializable because persisting
 * them would defeat evidence redaction; trace policies never contain them.
 */
export function describeRedactionPolicy(policy) {
  const state = requirePolicy(policy);
  if (state.secrets.length > 0) {
    throw new RedactionConfigurationError("policies with literal secrets cannot be serialized");
  }
  return deepFreeze({
    schema_version: REDACTION_POLICY_SOURCE_SCHEMA,
    algorithm: state.algorithm ?? (state.legacyEvidenceV1
      ? "legacy_evidence_v1"
      : state.credentialAssignments
        ? "operational_v2"
        : "generic_v1"),
    replacement: state.replacement,
    limits: { ...state.limits },
    sensitive_keys: [...state.sensitiveKeys].sort(),
    detectors: state.patterns.map(describeDetector),
    identifier_allow_patterns: state.identifierPatterns.map(describeDetector),
    credential_assignment_detector: state.credentialAssignmentDetector
      ? describeDetector(state.credentialAssignmentDetector)
      : null,
    semantics: {
      credential_assignments: state.credentialAssignments,
      legacy_evidence_v1: state.legacyEvidenceV1,
    },
  });
}

/** Reconstruct only a fully specified, supported policy source. */
export function createRedactionPolicyFromSource(source) {
  requirePlainRecord(source, "redaction policy source");
  assertExactKeys(source, [
    "schema_version",
    "algorithm",
    "replacement",
    "limits",
    "sensitive_keys",
    "detectors",
    "identifier_allow_patterns",
    "credential_assignment_detector",
    "semantics",
  ], "redaction policy source");
  if (source.schema_version !== REDACTION_POLICY_SOURCE_SCHEMA) {
    throw new RedactionConfigurationError("unsupported redaction policy source schema");
  }
  const supportedAlgorithms = new Set([
    "generic_v1",
    "operational_v2",
    "operational_evidence_v1",
    "legacy_evidence_v1",
  ]);
  if (!supportedAlgorithms.has(source.algorithm)) {
    throw new RedactionConfigurationError("unsupported redaction policy source algorithm");
  }
  requirePlainRecord(source.semantics, "redaction policy source semantics");
  assertExactKeys(
    source.semantics,
    ["credential_assignments", "legacy_evidence_v1"],
    "redaction policy source semantics",
  );
  if (
    typeof source.semantics.credential_assignments !== "boolean"
    || typeof source.semantics.legacy_evidence_v1 !== "boolean"
  ) {
    throw new RedactionConfigurationError("redaction policy source semantics must be boolean");
  }
  const expectedSemantics = {
    generic_v1: [false, false],
    operational_v2: [true, false],
    operational_evidence_v1: [true, false],
    legacy_evidence_v1: [false, true],
  }[source.algorithm];
  if (
    source.semantics.credential_assignments !== expectedSemantics[0]
    || source.semantics.legacy_evidence_v1 !== expectedSemantics[1]
  ) {
    throw new RedactionConfigurationError("redaction policy algorithm and semantics disagree");
  }
  if (!Array.isArray(source.sensitive_keys)) {
    throw new RedactionConfigurationError("redaction policy sensitive_keys must be an array");
  }
  if (
    source.semantics.credential_assignments !== (source.credential_assignment_detector !== null)
  ) {
    throw new RedactionConfigurationError("redaction policy credential assignment detector is inconsistent");
  }
  const credentialAssignmentDetector = source.credential_assignment_detector === null
    ? null
    : normalizePolicySourceDetectors(
        [source.credential_assignment_detector],
        "credential_assignment_detector",
      )[0];
  const policy = createRedactionPolicy({
    replacement: source.replacement,
    limits: source.limits,
    sensitiveKeys: source.sensitive_keys,
    [EXACT_SENSITIVE_KEYS]: true,
    secretPatterns: normalizePolicySourceDetectors(source.detectors, "detectors"),
    identifierAllowPatterns: normalizePolicySourceDetectors(
      source.identifier_allow_patterns,
      "identifier_allow_patterns",
    ),
    [EXACT_IDENTIFIER_PATTERNS]: true,
    [OPERATIONAL_CREDENTIAL_ASSIGNMENTS]: source.semantics.credential_assignments,
    [EXACT_CREDENTIAL_ASSIGNMENT_PATTERN]: credentialAssignmentDetector,
    [LEGACY_EVIDENCE_V1_BEHAVIOR]: source.semantics.legacy_evidence_v1,
    [REDACTION_ALGORITHM]: source.algorithm,
  });
  if (JSON.stringify(describeRedactionPolicy(policy)) !== JSON.stringify(source)) {
    throw new RedactionConfigurationError("redaction policy source is not in canonical form");
  }
  return policy;
}

export function isAllowedIdentifier(value, policy = DEFAULT_REDACTION_POLICY) {
  const state = requirePolicy(policy);
  if (typeof value !== "string" || value.length === 0 || value.length > state.limits.maxStringLength) {
    return false;
  }
  return isAllowedByState(value, state);
}

export function redactText(value, policy = DEFAULT_REDACTION_POLICY) {
  if (typeof value !== "string") {
    throw new TypeError("redactText value must be a string");
  }
  const state = requirePolicy(policy);
  const budget = {
    nodes: 1,
    outputChars: 0,
    matches: 0,
    redactions: 0,
  };
  try {
    return redactString(value, state, budget);
  } catch {
    return REDACTION_LIMIT_PLACEHOLDER;
  }
}

export function redactValue(value, policy = DEFAULT_REDACTION_POLICY) {
  return redactValueWithMetadata(value, policy).value;
}

export function redactValueWithMetadata(value, policy = DEFAULT_REDACTION_POLICY) {
  const state = requirePolicy(policy);
  const budget = {
    nodes: 0,
    outputChars: 0,
    matches: 0,
    redactions: 0,
  };
  try {
    const redacted = walkValue(value, state, budget, 0, new Set());
    return deepFreeze({
      value: redacted,
      redactions: budget.redactions,
      limited: false,
      limit: null,
    });
  } catch (error) {
    const limit = error instanceof RedactionLimitError ? error.limit : "redactionFailure";
    return Object.freeze({
      value: REDACTION_LIMIT_PLACEHOLDER,
      redactions: budget.redactions,
      limited: true,
      limit,
    });
  }
}

function walkValue(value, state, budget, depth, ancestors) {
  consume(budget, "nodes", 1, state.limits.maxNodes);
  if (depth > state.limits.maxDepth) {
    throw new RedactionLimitError("maxDepth");
  }
  if (value === null || typeof value === "boolean") {
    consumeOutput(budget, String(value).length, state);
    return value;
  }
  if (typeof value === "string") {
    return redactString(value, state, budget);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new RedactionLimitError("unsupportedValue");
    }
    consumeOutput(budget, String(value).length, state);
    return Object.is(value, -0) ? 0 : value;
  }
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "object") {
    throw new RedactionLimitError("unsupportedValue");
  }
  if (ancestors.has(value)) {
    throw new RedactionLimitError("cyclicValue");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => walkValue(item, state, budget, depth + 1, ancestors));
    }
    if (!isPlainRecord(value)) {
      throw new RedactionLimitError("unsupportedValue");
    }
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      consumeOutput(budget, key.length, state);
      const redactedKey = state.legacyEvidenceV1 ? key : redactString(key, state, budget);
      const presentedKey = uniquePresentedKey(result, redactedKey, state, budget);
      let presented;
      if (state.sensitiveKeys.has(normalizeKey(key))) {
        presented = state.replacement;
        budget.redactions += item === state.replacement ? 0 : 1;
        consumeOutput(budget, state.replacement.length, state);
      } else {
        presented = walkValue(item, state, budget, depth + 1, ancestors);
      }
      if (state.legacyEvidenceV1 && presentedKey === "__proto__") {
        // The frozen v1 writer assigned with result[key] = value. For this
        // special key JavaScript invoked Object.prototype.__proto__ instead of
        // creating an own property, so JSON.stringify omitted it. Skipping the
        // property reproduces those bytes without mutating any prototype.
        continue;
      }
      // Assignment to the special __proto__ key mutates an ordinary object's
      // prototype instead of creating data. Define every key explicitly so
      // attacker-controlled JSON remains an inert, own enumerable property.
      Object.defineProperty(result, presentedKey, {
        value: presented,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function redactString(value, state, budget) {
  if (value.length > state.limits.maxStringLength) {
    throw new RedactionLimitError("maxStringLength");
  }
  if (value === state.replacement || value === REDACTION_LIMIT_PLACEHOLDER) {
    consumeOutput(budget, value.length, state);
    return value;
  }

  let result = value;
  for (const secret of state.secrets) {
    result = replaceLiteral(result, secret, state, budget);
  }
  if (state.legacyEvidenceV1) {
    return redactStringWithLegacyEvidenceV1Semantics(result, state, budget);
  }
  if (state.credentialAssignments) {
    result = replaceCredentialAssignments(result, state, budget);
  }

  // Explicit secret/PII detectors and credential detectors are authoritative.
  // Identifier allowlists are for classification/introspection and can never
  // neutralize an explicit privacy rule or a known credential shape.
  for (const detector of state.patterns) {
    const pattern = detector.pattern;
    pattern.lastIndex = 0;
    result = result.replace(pattern, (...args) => {
      const match = args[0];
      consume(budget, "matches", 1, state.limits.maxMatches);
      if (match === state.replacement || match === REDACTION_LIMIT_PLACEHOLDER) {
        return match;
      }
      budget.redactions += 1;
      return state.replacement;
    });
  }

  consumeOutput(budget, result.length, state);
  return result;
}

function redactStringWithLegacyEvidenceV1Semantics(value, state, budget) {
  let result = value;
  if (!isAllowedByState(result, state)) {
    for (const detector of state.patterns) {
      if (detector.engine === LEGACY_EMAIL_LINEAR_ENGINE) {
        result = replaceLegacyEmailCandidates(result, state, budget);
        continue;
      }
      const pattern = new RegExp(detector.source, detector.flags);
      result = result.replace(pattern, (...args) => {
        const match = args[0];
        consume(budget, "matches", 1, state.limits.maxMatches);
        if (
          match === state.replacement
          || match === REDACTION_LIMIT_PLACEHOLDER
          || isAllowedByState(match, state)
        ) {
          return match;
        }
        budget.redactions += 1;
        return state.replacement;
      });
    }
  }
  consumeOutput(budget, result.length, state);
  return result;
}

function replaceLegacyEmailCandidates(value, state, budget) {
  const parts = [];
  let cursor = 0;
  let segmentStart = 0;
  while (segmentStart < value.length) {
    while (segmentStart < value.length && isLegacyEmailWhitespace(value[segmentStart])) {
      segmentStart += 1;
    }
    if (segmentStart >= value.length) break;
    let tokenEnd = segmentStart;
    while (tokenEnd < value.length && !isLegacyEmailWhitespace(value[tokenEnd])) tokenEnd += 1;
    const separators = [segmentStart - 1];
    for (let index = segmentStart; index < tokenEnd; index += 1) {
      if (value[index] === "@") separators.push(index);
    }
    separators.push(tokenEnd);
    for (let index = 1; index < separators.length - 1; index += 1) {
      const at = separators[index];
      const leftFloor = separators[index - 1] + 1;
      const rightCeiling = separators[index + 1];
      const start = firstLegacyWordBoundary(value, Math.max(leftFloor, cursor), at);
      const end = lastLegacyWordBoundary(value, at + 1, rightCeiling);
      if (start < 0 || end < 0 || start >= at || end <= at + 1) continue;
      const domain = value.slice(at + 1, end);
      const dot = domain.lastIndexOf(".");
      if (dot <= 0 || dot >= domain.length - 1 || start < cursor) continue;
      consume(budget, "matches", 1, state.limits.maxMatches);
      parts.push(value.slice(cursor, start), state.replacement);
      budget.redactions += 1;
      cursor = end;
    }
    segmentStart = tokenEnd + 1;
  }
  if (parts.length === 0) return value;
  parts.push(value.slice(cursor));
  return parts.join("");
}

function firstLegacyWordBoundary(value, start, end) {
  for (let index = start; index < end; index += 1) {
    if (legacyWordCharacter(value[index - 1]) !== legacyWordCharacter(value[index])) return index;
  }
  return -1;
}

function lastLegacyWordBoundary(value, start, end) {
  for (let index = end; index > start; index -= 1) {
    if (legacyWordCharacter(value[index - 1]) !== legacyWordCharacter(value[index])) return index;
  }
  return -1;
}

function legacyWordCharacter(character) {
  return typeof character === "string" && /\w/iu.test(character);
}

function isLegacyEmailWhitespace(character) {
  return typeof character === "string" && /\s/u.test(character);
}

function replaceCredentialAssignments(value, state, budget) {
  const pattern = state.credentialAssignmentDetector.pattern;
  pattern.lastIndex = 0;
  const parts = [];
  let cursor = 0;
  let match;
  while ((match = pattern.exec(value)) !== null) {
    if (match.index < cursor) continue;
    const valueStart = pattern.lastIndex;
    const end = credentialAssignmentEnd(value, valueStart);
    consume(budget, "matches", 1, state.limits.maxMatches);
    parts.push(value.slice(cursor, match.index), state.replacement);
    budget.redactions += 1;
    cursor = end;
    pattern.lastIndex = Math.max(pattern.lastIndex, end);
  }
  if (parts.length === 0) return value;
  parts.push(value.slice(cursor));
  return parts.join("");
}

function credentialAssignmentEnd(value, start) {
  const quote = value[start];
  if (quote === "\"" || quote === "'") {
    let escaped = false;
    for (let index = start + 1; index < value.length; index += 1) {
      const character = value[index];
      if (character === "\r" || character === "\n") return index;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === quote) return index + 1;
    }
    return value.length;
  }
  let end = start;
  while (end < value.length && value[end] !== "\r" && value[end] !== "\n") end += 1;
  return end;
}

function uniquePresentedKey(target, candidate, state, budget) {
  if (!Object.hasOwn(target, candidate)) return candidate;
  let index = 2;
  let unique = `${candidate}#${index}`;
  while (Object.hasOwn(target, unique)) {
    index += 1;
    unique = `${candidate}#${index}`;
  }
  consumeOutput(budget, unique.length - candidate.length, state);
  return unique;
}

function replaceLiteral(value, secret, state, budget) {
  let cursor = 0;
  let index = value.indexOf(secret, cursor);
  if (index === -1) return value;
  const parts = [];
  while (index !== -1) {
    consume(budget, "matches", 1, state.limits.maxMatches);
    parts.push(value.slice(cursor, index), state.replacement);
    budget.redactions += 1;
    cursor = index + secret.length;
    index = value.indexOf(secret, cursor);
  }
  parts.push(value.slice(cursor));
  return parts.join("");
}

function isAllowedByState(value, state) {
  return state.identifierPatterns.some((detector) => {
    const pattern = detector.pattern
      ?? new RegExp(detector.source, detector.flags.replace("g", ""));
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}

function normalizeLimits(input) {
  if (input !== undefined) requirePlainRecord(input, "redaction limits");
  const result = {};
  for (const [name, fallback] of Object.entries(DEFAULT_LIMITS)) {
    const value = input?.[name] ?? fallback;
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RedactionConfigurationError(`${name} must be a positive safe integer`);
    }
    result[name] = value;
  }
  for (const name of Object.keys(input || {})) {
    if (!Object.hasOwn(DEFAULT_LIMITS, name)) {
      throw new RedactionConfigurationError(`Unknown redaction limit '${name}'`);
    }
  }
  return Object.freeze(result);
}

function normalizeReplacement(value) {
  if (value === undefined) return REDACTION_PLACEHOLDER;
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new RedactionConfigurationError("replacement must be a string between 1 and 128 characters");
  }
  return value;
}

function normalizeSecrets(input, replacement) {
  if (input === undefined) return Object.freeze([]);
  if (!Array.isArray(input)) {
    throw new RedactionConfigurationError("secrets must be an array");
  }
  const values = [];
  for (const [index, value] of input.entries()) {
    if (typeof value !== "string" || value.length === 0) {
      throw new RedactionConfigurationError(`secrets[${index}] must be a non-empty string`);
    }
    if (value === replacement || value === REDACTION_LIMIT_PLACEHOLDER) {
      throw new RedactionConfigurationError(`secrets[${index}] conflicts with a redaction placeholder`);
    }
    values.push(value);
  }
  return Object.freeze([...new Set(values)].sort((left, right) => right.length - left.length));
}

function normalizeSensitiveKeys(input, includeDefaults = true) {
  if (input !== undefined && !Array.isArray(input)) {
    throw new RedactionConfigurationError("sensitiveKeys must be an array");
  }
  const values = [...(includeDefaults ? DEFAULT_SENSITIVE_KEYS : []), ...(input ?? [])];
  return [...new Set(values.map((value, index) => {
    if (typeof value !== "string" || value.trim() === "") {
      throw new RedactionConfigurationError(`sensitiveKeys[${index}] must be a non-empty string`);
    }
    return normalizeKey(value);
  }))];
}

function normalizePatterns(input, label, limits) {
  if (input === undefined) return Object.freeze([]);
  if (!Array.isArray(input)) {
    throw new RedactionConfigurationError(`${label} must be an array`);
  }
  return Object.freeze(input.map((entry, index) => {
    let name = `${label}[${index}]`;
    let pattern = entry;
    if (isPlainRecord(entry)) {
      name = typeof entry.name === "string" && entry.name.trim() !== "" ? entry.name.trim() : name;
      if (entry.engine === LEGACY_EMAIL_LINEAR_ENGINE) {
        assertExactKeys(entry, ["name", "engine"], `${label}[${index}]`);
        return Object.freeze({ name, engine: LEGACY_EMAIL_LINEAR_ENGINE });
      }
      pattern = entry.pattern;
    }
    if (name.length > 128) {
      throw new RedactionConfigurationError(`${label}[${index}] name must not exceed 128 characters`);
    }
    const source = pattern instanceof RegExp ? pattern.source : pattern;
    const inputFlags = pattern instanceof RegExp ? pattern.flags : "u";
    if (typeof source !== "string" || source.length === 0 || source.length > limits.maxPatternLength) {
      throw new RedactionConfigurationError(
        `${label}[${index}] pattern must contain 1-${limits.maxPatternLength} characters`,
      );
    }
    assertSafePatternSource(source, `${label}[${index}]`, {
      trustedBuiltin: (
        (isPlainRecord(entry) && TRUSTED_BUILTIN_PATTERNS.has(entry))
        || AUDITED_MULTI_QUANTIFIER_PATTERN_SOURCES.has(source)
      ),
    });
    const flags = normalizeFlags(inputFlags, `${label}[${index}]`);
    let compiled;
    try {
      compiled = new RegExp(source, flags.replace("g", ""));
    } catch (error) {
      throw new RedactionConfigurationError(`${label}[${index}] is not a valid regular expression`);
    }
    if (compiled.test("")) {
      throw new RedactionConfigurationError(`${label}[${index}] must not match an empty string`);
    }
    return Object.freeze({ name, source, flags, pattern: new RegExp(source, flags) });
  }));
}

function describeDetector(detector) {
  if (detector.engine === LEGACY_EMAIL_LINEAR_ENGINE) {
    return { name: detector.name, engine: LEGACY_EMAIL_LINEAR_ENGINE };
  }
  const source = detector.source ?? detector.pattern?.source;
  const flags = detector.flags ?? normalizeFlags(detector.pattern?.flags ?? "u", detector.name);
  return { name: detector.name, source, flags };
}

function normalizePolicySourceDetectors(value, label) {
  if (!Array.isArray(value)) {
    throw new RedactionConfigurationError(`redaction policy ${label} must be an array`);
  }
  return value.map((entry, index) => {
    requirePlainRecord(entry, `redaction policy ${label}[${index}]`);
    if (entry.engine === LEGACY_EMAIL_LINEAR_ENGINE) {
      assertExactKeys(entry, ["name", "engine"], `redaction policy ${label}[${index}]`);
      return { name: entry.name, engine: entry.engine };
    }
    assertExactKeys(entry, ["name", "source", "flags"], `redaction policy ${label}[${index}]`);
    if (typeof entry.flags !== "string") {
      throw new RedactionConfigurationError(`redaction policy ${label}[${index}] flags must be a string`);
    }
    let pattern;
    try {
      pattern = new RegExp(entry.source, entry.flags);
    } catch {
      throw new RedactionConfigurationError(`redaction policy ${label}[${index}] is invalid`);
    }
    return { name: entry.name, pattern };
  });
}

function assertSafePatternSource(source, label, { trustedBuiltin = false } = {}) {
  if (!trustedBuiltin && /\\(?:[1-9]|k<)/u.test(source)) {
    throw new RedactionConfigurationError(`${label} uses unsupported regular-expression backreferences`);
  }
  if (!trustedBuiltin && /\(\?(?!:)/u.test(source)) {
    throw new RedactionConfigurationError(`${label} uses unsupported regular-expression assertions or groups`);
  }

  const groups = [];
  let variableQuantifiers = 0;
  let escaped = false;
  let inClass = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (inClass) {
      if (character === "]") inClass = false;
      continue;
    }
    if (character === "[") {
      inClass = true;
      continue;
    }
    if (character === "(") {
      groups.push({ hasAlternation: false, hasQuantifier: false });
      if (source.startsWith("(?:", index)) index += 2;
      continue;
    }
    if (character === "|") {
      if (groups.length > 0) groups.at(-1).hasAlternation = true;
      continue;
    }
    if (character === ")") {
      const group = groups.pop();
      if (!group) continue;
      const quantifierLength = regexQuantifierLength(source, index + 1);
      if (quantifierLength > 0) {
        const quantifier = source
          .slice(index + 1, index + 1 + quantifierLength)
          .replace(/\?$/u, "");
        if (!trustedBuiltin) assertCustomQuantifier(quantifier, label);
        if (isVariableQuantifier(quantifier)) variableQuantifiers += 1;
      }
      if (quantifierLength > 0 && (group.hasAlternation || group.hasQuantifier)) {
        throw new RedactionConfigurationError(
          `${label} contains a nested or ambiguous quantified group`,
        );
      }
      if (groups.length > 0 && (group.hasQuantifier || quantifierLength > 0)) {
        groups.at(-1).hasQuantifier = true;
      }
      if (quantifierLength > 0) index += quantifierLength;
      continue;
    }
    const quantifierLength = regexQuantifierLength(source, index);
    if (quantifierLength > 0) {
      const quantifier = source.slice(index, index + quantifierLength).replace(/\?$/u, "");
      if (!trustedBuiltin) assertCustomQuantifier(quantifier, label);
      if (isVariableQuantifier(quantifier)) variableQuantifiers += 1;
      if (groups.length > 0) groups.at(-1).hasQuantifier = true;
      index += quantifierLength - 1;
    }
  }

  if (!trustedBuiltin && variableQuantifiers > 1) {
    throw new RedactionConfigurationError(
      `${label} contains multiple variable quantifiers; use fixed-width fields or separate detectors`,
    );
  }
}

function assertCustomQuantifier(value, label) {
  if (value === "*" || value === "+" || /^\{\d+,\}$/u.test(value)) {
    throw new RedactionConfigurationError(
      `${label} contains an unbounded quantifier; configure an explicit maximum`,
    );
  }
  const match = value.match(/^\{(\d+)(?:,(\d+))?\}$/u);
  const maximum = match ? Number(match[2] ?? match[1]) : value === "?" ? 1 : null;
  if (maximum !== null && maximum > CUSTOM_PATTERN_MAX_REPETITION) {
    throw new RedactionConfigurationError(
      `${label} repetition exceeds the safe maximum (${CUSTOM_PATTERN_MAX_REPETITION})`,
    );
  }
}

function isVariableQuantifier(value) {
  if (value === "*" || value === "+" || value === "?") return true;
  const match = value.match(/^\{(\d+)(?:,(\d*))?\}$/u);
  if (!match || match[2] === undefined) return false;
  if (match[2] === "") return true;
  const minimum = Number(match[1]);
  const maximum = Number(match[2]);
  return minimum !== maximum;
}

function regexQuantifierLength(source, index) {
  const character = source[index];
  if (character === "*" || character === "+" || character === "?") {
    return source[index + 1] === "?" ? 2 : 1;
  }
  if (character !== "{") return 0;
  const match = source.slice(index).match(/^\{\d+(?:,\d*)?\}\??/u);
  return match?.[0].length ?? 0;
}

function normalizeFlags(flags, label) {
  const values = new Set();
  for (const flag of flags) {
    if (!["g", "i", "m", "s", "u"].includes(flag)) {
      throw new RedactionConfigurationError(`${label} uses unsupported regular-expression flag '${flag}'`);
    }
    values.add(flag);
  }
  values.delete("g");
  values.add("g");
  return [...values].sort().join("");
}

function consume(budget, field, amount, limit) {
  budget[field] += amount;
  if (budget[field] > limit) {
    throw new RedactionLimitError(
      field === "nodes" ? "maxNodes" : field === "matches" ? "maxMatches" : field,
    );
  }
}

function consumeOutput(budget, amount, state) {
  consume(budget, "outputChars", amount, state.limits.maxOutputChars);
}

function requirePolicy(policy) {
  const state = POLICY_STATE.get(policy);
  if (!state) {
    throw new RedactionConfigurationError("policy must be created with createRedactionPolicy");
  }
  return state;
}

function normalizeKey(value) {
  return value.replace(/[^a-z0-9]/giu, "").toLowerCase();
}

function requirePlainRecord(value, label) {
  if (!isPlainRecord(value)) {
    throw new RedactionConfigurationError(`${label} must be a plain object`);
  }
}

function assertExactKeys(value, keys, label) {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) {
    throw new RedactionConfigurationError(`${label} contains unsupported or missing fields`);
  }
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const item of Object.values(value)) deepFreeze(item, seen);
  return Object.freeze(value);
}
