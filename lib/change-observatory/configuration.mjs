import { crypto } from "../runtime/host.mjs";
import {
  createOperationalRedactionPolicy,
} from "../observability/redaction.mjs";
import { readResolvedFileBounded } from "./bounded-file-reader.mjs";
import {
  ObservatoryPathError,
  resolveExistingFileWithin,
  resolveProjectBoundary,
} from "./path-safety.mjs";

const CONFIG_PATH = ".sdlc/config.json";
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;

export async function resolveObservatoryConfiguration(projectRoot, overrides = {}) {
  const snapshot = await resolveObservatoryConfigurationSnapshot(projectRoot, overrides);
  return snapshot.configuration;
}

export async function resolveObservatoryConfigurationSnapshot(projectRoot, overrides = {}) {
  if (!isPlainRecord(overrides)) {
    throw new TypeError("Observatory configuration overrides must be a plain object");
  }
  const canonicalRoot = await resolveProjectBoundary(projectRoot);
  const snapshot = await readProjectObservabilityConfiguration(canonicalRoot);
  return Object.freeze({
    configuration: createObservatoryConfiguration(snapshot.value, overrides),
    revision: snapshot.revision,
  });
}

export async function resolveObservatoryConfigurationRevision(projectRoot) {
  const canonicalRoot = await resolveProjectBoundary(projectRoot);
  return (await readProjectConfigurationBytes(canonicalRoot)).revision;
}

export function createObservatoryConfiguration(projectConfiguration = {}, overrides = {}) {
  if (!isPlainRecord(projectConfiguration)) {
    throw new TypeError("The project observability configuration is invalid");
  }
  if (!isPlainRecord(overrides)) {
    throw new TypeError("Observatory configuration overrides must be a plain object");
  }
  assertSafeConfiguration(projectConfiguration);
  // Always validate configured detectors, even when an embedding caller
  // supplies a stricter runtime policy. An override must not turn a malformed
  // project privacy configuration into a silently accepted one.
  const configuredRedactionPolicy = createOperationalRedactionPolicy(
    redactionOptions(projectConfiguration.redaction),
  );
  const redactionPolicy = overrides.redactionPolicy ?? configuredRedactionPolicy;
  const operationalPolicy = Object.freeze({
    ...operationalOptions(projectConfiguration),
    ...(overrides.operationalPolicy || {}),
  });
  return Object.freeze({ redactionPolicy, operationalPolicy });
}

/**
 * The trusted host keys the project configures, used only to tell whether a
 * displayed signature verifies. Any problem reading them yields no keys, so
 * nothing is shown as verified.
 */
export async function readObservatoryTrustedHostKeys(projectRoot) {
  try {
    const snapshot = await readProjectConfigurationBytes(await resolveProjectBoundary(projectRoot));
    if (snapshot.bytes === null) return [];
    const keys = JSON.parse(snapshot.bytes.toString("utf8"))?.authority_policy?.trusted_host_keys;
    return Array.isArray(keys) ? keys : [];
  } catch {
    return [];
  }
}

async function readProjectObservabilityConfiguration(projectRoot) {
  const snapshot = await readProjectConfigurationBytes(projectRoot);
  if (snapshot.bytes === null) {
    return Object.freeze({ value: Object.freeze({}), revision: snapshot.revision });
  }
  const { bytes } = snapshot;
  try {
    const parsed = JSON.parse(bytes.toString("utf8"));
    const value = parsed?.observability ?? {};
    if (!isPlainRecord(value)) throw new TypeError();
    assertSafeConfiguration(value);
    return Object.freeze({ value, revision: snapshot.revision });
  } catch {
    throw new TypeError("The project observability configuration is invalid");
  }
}

async function readProjectConfigurationBytes(projectRoot) {
  let resolved;
  try {
    resolved = await resolveExistingFileWithin(projectRoot, CONFIG_PATH);
  } catch (error) {
    // Configuration is optional only when it is genuinely absent. A symlink,
    // boundary violation, wrong file type, or unreadable path is a security
    // failure: silently falling back would discard configured privacy rules.
    if (error instanceof ObservatoryPathError && error.code === "source_not_found") {
      return Object.freeze({ bytes: null, revision: "absent" });
    }
    throw error;
  }
  const bytes = await readResolvedFileBounded(resolved, {
    maxBytes: MAX_CONFIG_BYTES,
    boundaryCode: "configuration_boundary_changed",
    tooLargeCode: "configuration_too_large",
    tooLargeMessage: "The project configuration exceeds the supported size limit",
  });
  return Object.freeze({
    bytes,
    revision: `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`,
  });
}

function assertSafeConfiguration(value) {
  assertExactKeys(value, [
    "enabled",
    "external_sinks",
    "redaction",
    "correlation",
    "metrics",
    "readiness",
    "slo",
    "support_bundle",
  ], "observability");
  assertOptionalSection(value.redaction, [
    "mode",
    "secret_patterns",
    "pii_patterns",
    "identifier_allow_patterns",
    "sensitive_keys",
  ], "observability.redaction");
  assertOptionalSection(value.correlation, ["enabled", "format"], "observability.correlation");
  assertOptionalSection(value.metrics, ["enabled", "cardinality", "external_sinks"], "observability.metrics");
  assertOptionalSection(value.readiness, ["liveness_is_shallow", "warm_before_ready"], "observability.readiness");
  assertOptionalSection(value.slo, [
    "mode",
    "availability_target",
    "readiness_target",
    "minimum_samples",
  ], "observability.slo");
  assertOptionalSection(value.support_bundle, [
    "enabled",
    "max_recent_requests",
    "integrity",
    "authenticity_claimed",
  ], "observability.support_bundle");
  const exact = (candidate, expected) => candidate === undefined || candidate === expected;
  if (
    !exact(value.enabled, true)
    || !exact(value.external_sinks, "disabled")
    || !exact(value.redaction?.mode, "before_persistence_and_presentation")
    || !exact(value.correlation?.enabled, true)
    || !exact(value.correlation?.format, "corr-uuid")
    || !exact(value.metrics?.enabled, true)
    || !exact(value.metrics?.cardinality, "closed")
    || !exact(value.metrics?.external_sinks, "disabled")
    || !exact(value.readiness?.liveness_is_shallow, true)
    || !exact(value.readiness?.warm_before_ready, true)
    || !exact(value.slo?.mode, "advisory")
    || !exact(value.support_bundle?.enabled, true)
    || !exact(value.support_bundle?.integrity, "sha256_of_redacted_canonical_content")
    || !exact(value.support_bundle?.authenticity_claimed, false)
  ) {
    throw new TypeError("The project observability configuration violates its local safety boundary");
  }
}

function assertOptionalSection(value, allowedKeys, label) {
  if (value === undefined) return;
  if (!isPlainRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(value, allowedKeys, label);
}

function assertExactKeys(value, allowedKeys, label) {
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TypeError(`${label} contains an unsupported setting`);
  }
}

function redactionOptions(value) {
  if (value === undefined) return {};
  if (!isPlainRecord(value)) throw new TypeError("The project observability redaction configuration is invalid");
  return compactObject({
    secretPatterns: detectorPatterns(value.secret_patterns, "secret_patterns"),
    piiPatterns: detectorPatterns(value.pii_patterns, "pii_patterns"),
    identifierAllowPatterns: detectorPatterns(value.identifier_allow_patterns, "identifier_allow_patterns"),
    sensitiveKeys: stringArray(value.sensitive_keys, "sensitive_keys"),
  });
}

function operationalOptions(value) {
  if (!isPlainRecord(value)) return {};
  const slo = value.slo;
  const supportBundle = value.support_bundle;
  if (slo !== undefined && !isPlainRecord(slo)) throw new TypeError("The project observability SLO configuration is invalid");
  if (supportBundle !== undefined && !isPlainRecord(supportBundle)) {
    throw new TypeError("The project observability support-bundle configuration is invalid");
  }
  return compactObject({
    maxRecentRequests: optionalPositiveInteger(
      supportBundle?.max_recent_requests,
      "max_recent_requests",
      1_000,
    ),
    availabilityTarget: optionalRatio(slo?.availability_target, "availability_target"),
    readinessTarget: optionalRatio(slo?.readiness_target, "readiness_target"),
    minimumSamples: optionalPositiveInteger(slo?.minimum_samples, "minimum_samples"),
  });
}

function detectorPatterns(value, label) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError(`Observatory ${label} must be an array`);
  return value.map((entry, index) => {
    if (typeof entry === "string") return { name: `${label}_${index + 1}`, pattern: entry };
    if (!isPlainRecord(entry) || typeof entry.name !== "string" || typeof entry.pattern !== "string") {
      throw new TypeError(`Observatory ${label}[${index}] must contain string name and pattern fields`);
    }
    assertExactKeys(entry, ["name", "pattern"], `observability.redaction.${label}[${index}]`);
    return { name: entry.name, pattern: entry.pattern };
  });
}

function stringArray(value, label) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new TypeError(`Observatory ${label} must be an array of non-empty strings`);
  }
  return value;
}

function optionalPositiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`Observatory ${label} must be a positive safe integer no greater than ${maximum}`);
  }
  return value;
}

function optionalRatio(value, label) {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`Observatory ${label} must be between 0 and 1`);
  }
  return value;
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
