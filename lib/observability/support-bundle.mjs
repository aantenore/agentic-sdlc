import { crypto, Date } from "../runtime/host.mjs";
import { canonicalJson } from "../canonical.mjs";
import { createCorrelationId, isValidCorrelationId } from "./context.mjs";
import {
  DEFAULT_OPERATIONAL_REDACTION_POLICY,
  redactText,
  redactValueWithMetadata,
} from "./redaction.mjs";

const SECTION_NAME_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export const DEFAULT_SUPPORT_BUNDLE_SECTIONS = Object.freeze([
  "environment",
  "health",
  "metrics",
  "slo",
  "versions",
]);

export class SupportBundleError extends TypeError {
  constructor(message, code = "support_bundle_invalid") {
    super(message);
    this.name = "SupportBundleError";
    this.code = code;
  }
}

export function createSupportBundle(input, dependencies = {}) {
  requirePlainRecord(input, "support bundle input");
  requirePlainRecord(dependencies, "support bundle dependencies");
  requirePlainRecord(input.sections, "support bundle sections");

  const policy = input.redactionPolicy ?? DEFAULT_OPERATIONAL_REDACTION_POLICY;
  const allowedSections = normalizeAllowedSections(
    input.allowedSections ?? DEFAULT_SUPPORT_BUNDLE_SECTIONS,
  );
  const sectionNames = Object.keys(input.sections).sort();
  if (sectionNames.some((name) => redactText(name, policy) !== name)) {
    throw new SupportBundleError(
      "Support bundle section names must not contain private metadata",
      "support_bundle_section_name_unsafe",
    );
  }
  const unexpected = sectionNames.filter((name) => !allowedSections.has(name));
  if (unexpected.length > 0) {
    throw new SupportBundleError(
      `Support bundle contains non-allowlisted sections: ${unexpected.join(", ")}`,
      "support_bundle_section_not_allowed",
    );
  }
  const selected = {};
  for (const name of sectionNames) selected[name] = input.sections[name];
  const redaction = redactValueWithMetadata(selected, policy);
  const correlationId = normalizeCorrelationId(
    input.context?.correlation_id
      ?? input.correlationId
      ?? createCorrelationId(dependencies.randomUUID),
  );
  const now = dependencies.now ?? (() => new Date());
  if (typeof now !== "function") {
    throw new SupportBundleError("now must be a function");
  }
  const generatedAt = normalizeInstant(input.generatedAt ?? now());

  const payload = deepFreeze({
    schema_version: "agentic-sdlc-support-bundle:v1",
    generated_at: generatedAt,
    correlation_id: correlationId,
    included_sections: redaction.limited ? [] : sectionNames,
    withheld_sections: redaction.limited ? sectionNames : [],
    redaction: {
      applied: redaction.redactions > 0,
      redactions: redaction.redactions,
      limited: redaction.limited,
      limit: redaction.limit,
    },
    sections: redaction.limited ? {} : redaction.value,
  });
  const digest = sha256Canonical(payload);
  return deepFreeze({
    ...payload,
    integrity: {
      algorithm: "sha256",
      representation: "utf8_canonical_json_of_redacted_payload",
      digest,
      assurance: "content_integrity_only_not_authenticity",
    },
  });
}

export function verifySupportBundleDigest(bundle) {
  try {
    if (!isPlainRecord(bundle) || !isPlainRecord(bundle.integrity)) return false;
    if (!hasExactKeys(bundle, [
      "correlation_id",
      "generated_at",
      "included_sections",
      "integrity",
      "redaction",
      "schema_version",
      "sections",
      "withheld_sections",
    ])) return false;
    if (!validateSupportBundlePayload(bundle)) return false;
    const integrityKeys = Object.keys(bundle.integrity).sort();
    if (integrityKeys.join("\0") !== [
      "algorithm",
      "assurance",
      "digest",
      "representation",
    ].join("\0")) return false;
    if (
      bundle.integrity.algorithm !== "sha256"
      || bundle.integrity.representation !== "utf8_canonical_json_of_redacted_payload"
      || bundle.integrity.assurance !== "content_integrity_only_not_authenticity"
      || typeof bundle.integrity.digest !== "string"
      || !SHA256_PATTERN.test(bundle.integrity.digest)
    ) {
      return false;
    }
    const payload = {};
    for (const [key, value] of Object.entries(bundle)) {
      if (key !== "integrity") payload[key] = value;
    }
    const expected = Buffer.from(bundle.integrity.digest, "hex");
    const actual = Buffer.from(sha256Canonical(payload), "hex");
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function validateSupportBundlePayload(bundle) {
  if (
    bundle.schema_version !== "agentic-sdlc-support-bundle:v1"
    || !isValidCorrelationId(bundle.correlation_id)
    || typeof bundle.generated_at !== "string"
    || !isCanonicalInstant(bundle.generated_at)
    || !isPlainRecord(bundle.sections)
    || !isPlainRecord(bundle.redaction)
    || !hasExactKeys(bundle.redaction, ["applied", "limit", "limited", "redactions"])
    || typeof bundle.redaction.applied !== "boolean"
    || typeof bundle.redaction.limited !== "boolean"
    || !Number.isSafeInteger(bundle.redaction.redactions)
    || bundle.redaction.redactions < 0
    || bundle.redaction.applied !== (bundle.redaction.redactions > 0)
    || (bundle.redaction.limited
      ? typeof bundle.redaction.limit !== "string" || bundle.redaction.limit === ""
      : bundle.redaction.limit !== null)
    || !isSectionList(bundle.included_sections)
    || !isSectionList(bundle.withheld_sections)
  ) {
    return false;
  }
  const included = bundle.included_sections;
  const withheld = bundle.withheld_sections;
  if (included.some((name) => withheld.includes(name))) return false;
  const sectionNames = Object.keys(bundle.sections).sort();
  if (bundle.redaction.limited) {
    return sectionNames.length === 0 && included.length === 0;
  }
  return withheld.length === 0 && included.join("\0") === sectionNames.join("\0");
}

function isCanonicalInstant(value) {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isSectionList(value) {
  return Array.isArray(value)
    && new Set(value).size === value.length
    && value.every((name) => typeof name === "string" && SECTION_NAME_PATTERN.test(name))
    && value.join("\0") === [...value].sort().join("\0");
}

function hasExactKeys(value, expected) {
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function sha256Canonical(value) {
  return crypto.createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function normalizeAllowedSections(input) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new SupportBundleError("allowedSections must be a non-empty array");
  }
  const sections = input.map((value, index) => {
    if (typeof value !== "string" || !SECTION_NAME_PATTERN.test(value)) {
      throw new SupportBundleError(`allowedSections[${index}] has an invalid section name`);
    }
    return value;
  });
  if (new Set(sections).size !== sections.length) {
    throw new SupportBundleError("allowedSections contains duplicates");
  }
  return new Set(sections);
}

function normalizeCorrelationId(value) {
  if (!isValidCorrelationId(value)) {
    throw new SupportBundleError("correlationId must use the form corr-<uuid>");
  }
  return value.toLowerCase();
}

function normalizeInstant(value) {
  if (value === null || value === "" || typeof value === "boolean") {
    throw new SupportBundleError("generatedAt must be a valid date-time");
  }
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new SupportBundleError("generatedAt must be a valid date-time");
  }
  return date.toISOString();
}

function requirePlainRecord(value, label) {
  if (!isPlainRecord(value)) throw new SupportBundleError(`${label} must be a plain object`);
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
