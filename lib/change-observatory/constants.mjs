import { SOFTWARE_PROJECT_PHASES } from "../workflow-presets.mjs";

export const OBSERVATORY_VIEW_SCHEMA_VERSION = "change-observatory:view:v1";
export const OBSERVATORY_SOURCE_SCHEMA_VERSION = "change-observatory:source:v1";
export const OBSERVATORY_HEALTH_SCHEMA_VERSION = "change-observatory:health:v1";

// The phases come from the software-project workflow definition, so the
// Observatory shows the same steps the workflow runs (including operations).
export const SDLC_PHASES = SOFTWARE_PROJECT_PHASES;

export const PROVENANCE_STATES = Object.freeze([
  "recorded",
  "inferred",
  "missing",
  "malformed",
]);

export const CANONICAL_SOURCE_EXTENSIONS = Object.freeze([
  ".json",
  ".jsonl",
  ".md",
  ".markdown",
  ".txt",
]);

// Top-level .sdlc folders read first, so a project that outgrows the limits
// below still shows its stories; bulky reports and run logs come last.
export const KNOWLEDGE_BASE_SCAN_PRIORITY = Object.freeze([
  "project.json",
  "stories",
  "requirements",
  "contracts",
  "dependencies",
  "traces",
  "workflows",
  "tests",
]);

export function orderKnowledgeBaseEntries(entries) {
  const rank = (entry) => {
    const index = KNOWLEDGE_BASE_SCAN_PRIORITY.indexOf(String(entry.name).toLowerCase());
    return index < 0 ? KNOWLEDGE_BASE_SCAN_PRIORITY.length : index;
  };
  return [...entries].sort((left, right) => rank(left) - rank(right));
}

export const DEFAULT_OBSERVATORY_LIMITS = Object.freeze({
  maxFiles: 8_192,
  maxEntries: 65_536,
  maxDepth: 16,
  maxFileBytes: 1_048_576,
  maxSourceBytes: 1_048_576,
  maxAssetBytes: 5_242_880,
  maxTotalBytes: 67_108_864,
  maxJsonLines: 5_000,
  maxRecords: 10_000,
  maxCollectionItems: 5_000,
  maxTextChars: 4_000,
  maxDiagnostics: 100,
});

export const SECURITY_HEADERS = Object.freeze({
  "Cache-Control": "no-store",
  "Content-Security-Policy": [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "font-src 'self'",
  ].join("; "),
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
});

export function normalizeObservatoryLimits(overrides = {}) {
  if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new TypeError("Observatory limits must be an object");
  }

  const limits = { ...DEFAULT_OBSERVATORY_LIMITS };
  for (const key of Object.keys(limits)) {
    if (overrides[key] === undefined) {
      continue;
    }
    if (!Number.isSafeInteger(overrides[key]) || overrides[key] < 1) {
      throw new TypeError(`Observatory limit ${key} must be a positive safe integer`);
    }
    limits[key] = overrides[key];
  }
  return Object.freeze(limits);
}
