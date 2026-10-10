import { crypto, Date } from "./runtime/host.mjs";

export const STABLE_JSON_HASH_ALGORITHM = "sha256:stable-json:v1";

export class DomainValidationError extends Error {
  constructor(message, issues = []) {
    super(message);
    this.name = "DomainValidationError";
    this.code = "domain_validation_failed";
    this.issues = Object.freeze([...issues]);
  }
}

export function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// Roots frozen recursively by deepFreeze: their content can no longer change,
// so their canonical form and hash are computed once per object identity.
const deepFrozenRoots = new WeakSet();
const canonicalByFrozen = new WeakMap();
const hashByFrozen = new WeakMap();

export function isDeepFrozen(value) {
  return value !== null && typeof value === "object" && deepFrozenRoots.has(value);
}

export function canonicalJson(value) {
  if (!isDeepFrozen(value)) {
    return serializeCanonical(value, new Set(), "$", false);
  }
  let text = canonicalByFrozen.get(value);
  if (text === undefined) {
    text = serializeCanonical(value, new Set(), "$", false);
    canonicalByFrozen.set(value, text);
  }
  return text;
}

export function computeStableHash(value) {
  if (!isDeepFrozen(value)) {
    return crypto.createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
  }
  let hash = hashByFrozen.get(value);
  if (hash === undefined) {
    hash = crypto.createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
    hashByFrozen.set(value, hash);
  }
  return hash;
}

export function cloneJson(value) {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(canonicalJson(value));
}

export function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const item of Object.values(value)) {
    deepFreeze(item, seen);
  }
  deepFrozenRoots.add(value);
  return Object.freeze(value);
}

export function immutableJson(value) {
  return deepFreeze(cloneJson(value));
}

export function omitKeys(value, keys) {
  const omitted = new Set(keys);
  const result = {};
  for (const [key, item] of Object.entries(value || {})) {
    if (!omitted.has(key) && item !== undefined) {
      result[key] = item;
    }
  }
  return result;
}

export function requirePlainRecord(value, label) {
  if (!isPlainRecord(value)) {
    throw new DomainValidationError(`${label} must be a plain object`, [
      { path: label, code: "type", message: "Expected a plain object" },
    ]);
  }
  return value;
}

export function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DomainValidationError(`${label} must be a non-empty string`, [
      { path: label, code: "required", message: "Expected a non-empty string" },
    ]);
  }
  return value.trim();
}

export function normalizeOptionalString(value, label = "value") {
  if (value === undefined || value === null) {
    return null;
  }
  return requireNonEmptyString(value, label);
}

export function normalizeStringList(value, label, options = {}) {
  const values = value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
  const normalized = values.map((item, index) => requireNonEmptyString(item, `${label}[${index}]`));
  const deduplicated = Array.from(new Set(normalized));
  return options.sort === false ? deduplicated : deduplicated.sort(compareCanonicalStrings);
}

export function compareCanonicalStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function normalizeIsoInstant(value, label) {
  const raw = requireNonEmptyString(value, label);
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp) || !/^\d{4}-\d{2}-\d{2}T/.test(raw)) {
    throw new DomainValidationError(`${label} must be an ISO-8601 date-time`, [
      { path: label, code: "format", message: "Expected an ISO-8601 date-time" },
    ]);
  }
  return new Date(timestamp).toISOString();
}

function serializeCanonical(value, ancestors, path, inArray) {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Canonical JSON does not support non-finite number at ${path}`);
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (value === undefined) {
    if (inArray) {
      throw new TypeError(`Canonical JSON does not support undefined array item at ${path}`);
    }
    return undefined;
  }
  if (["bigint", "function", "symbol"].includes(typeof value)) {
    throw new TypeError(`Canonical JSON does not support ${typeof value} at ${path}`);
  }
  if (ancestors.has(value)) {
    throw new TypeError(`Canonical JSON does not support cycles at ${path}`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value.map((item, index) => serializeCanonical(item, ancestors, `${path}[${index}]`, true));
      return `[${items.join(",")}]`;
    }
    if (!isPlainRecord(value)) {
      throw new TypeError(`Canonical JSON requires plain objects at ${path}`);
    }
    const entries = [];
    for (const key of Object.keys(value).sort(compareCanonicalStrings)) {
      const serialized = serializeCanonical(value[key], ancestors, `${path}.${key}`, false);
      if (serialized !== undefined) {
        entries.push(`${JSON.stringify(key)}:${serialized}`);
      }
    }
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}
