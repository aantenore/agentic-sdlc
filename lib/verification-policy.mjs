import { computeStableHash } from "./canonical.mjs";

export const VERIFICATION_POLICY_SCHEMA_VERSION = "verification-policy:v1";
export const DERIVED_VERIFICATION_SCHEMA_VERSION = "derived-verification:v1";
export const ENFORCE_MODES = Object.freeze(["warn", "block"]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringList(value) {
  return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
}

function assertEnforce(value, label) {
  if (!ENFORCE_MODES.includes(value)) {
    throw new Error(`${label} must be one of: ${ENFORCE_MODES.join(", ")}`);
  }
  return value;
}

/**
 * Merges the bundled default policy with the optional project override
 * (`verification_policy` in the project configuration). Top-level fields of the
 * override replace the default; rules merge by id, and `enabled: false` drops one.
 */
export function resolveVerificationPolicy(defaults, override = null) {
  if (!isRecord(defaults)) throw new Error("The bundled verification policy is not an object.");
  if (override !== null && override !== undefined && !isRecord(override)) {
    throw new Error("verification_policy must be an object.");
  }
  const merged = { ...defaults, ...(override || {}) };
  const rules = new Map();
  for (const rule of [...(defaults.rules || []), ...(override?.rules || [])]) {
    if (!isRecord(rule) || typeof rule.id !== "string" || !rule.id.trim()) {
      throw new Error("Every verification policy rule needs an id.");
    }
    rules.set(rule.id, { ...(rules.get(rule.id) || {}), ...rule });
  }
  const resolved = {
    schema_version: VERIFICATION_POLICY_SCHEMA_VERSION,
    enabled: merged.enabled !== false,
    enforce: assertEnforce(merged.enforce ?? "block", "verification_policy.enforce"),
    backfill_enforce: assertEnforce(merged.backfill_enforce ?? "warn", "verification_policy.backfill_enforce"),
    rules: [...rules.values()].filter((rule) => rule.enabled !== false).map((rule) => {
      for (const field of ["verification_type", "criterion"]) {
        if (typeof rule[field] !== "string" || !rule[field].trim()) {
          throw new Error(`Verification policy rule ${rule.id} needs ${field}.`);
        }
      }
      return {
        id: rule.id,
        verification_type: rule.verification_type,
        when: isRecord(rule.when) ? rule.when : { always: true },
        criterion: rule.criterion,
        explicit_coverage_patterns: stringList(rule.explicit_coverage_patterns),
        evidence_patterns: stringList(rule.evidence_patterns),
      };
    }),
  };
  resolved.policy_hash = computeStableHash(resolved);
  // Guidance text only: kept out of the policy hash so editing it never changes recorded policies.
  resolved.evidence_command_template = typeof merged.evidence_command_template === "string"
    ? merged.evidence_command_template
    : null;
  resolved.evidence_hints = Object.fromEntries([...rules.values()]
    .filter((rule) => rule.enabled !== false && typeof rule.evidence_hint === "string" && rule.evidence_hint.trim())
    .map((rule) => [rule.id, rule.evidence_hint.trim()]));
  return resolved;
}

function normalizePath(value) {
  return String(value).replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
}

function globToRegExp(glob) {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*") {
      if (glob[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
    } else {
      source += char.replace(/[.+?^${}()|[\]\\]/gu, "\\$&");
    }
  }
  return new RegExp(`^${source}$`, "iu");
}

/**
 * A pattern without wildcards matches a whole path segment sequence at any depth
 * ("pages" matches "apps/web/pages/a.ts"). A wildcard pattern without a slash is
 * tested against every path segment; with a slash, against the path and each
 * of its trailing sub-paths.
 */
export function pathMatchesPattern(pattern, filePath) {
  const pat = normalizePath(pattern);
  const target = normalizePath(filePath);
  if (!pat || !target) return false;
  if (!pat.includes("*")) {
    return `/${target}/`.toLowerCase().includes(`/${pat}/`.toLowerCase());
  }
  const regexp = globToRegExp(pat);
  const segments = target.split("/");
  if (!pat.includes("/")) return segments.some((segment) => regexp.test(segment));
  return segments.some((_, index) => regexp.test(segments.slice(index).join("/")));
}

function ruleTriggered(rule, scope) {
  const when = rule.when || {};
  if (when.always === true) return true;
  if (when.has_integrations === true && scope.hasIntegrations) return true;
  const patterns = stringList(when.write_paths);
  return patterns.some((pattern) => scope.writePaths.some((writePath) => pathMatchesPattern(pattern, writePath)));
}

function criterionCoveredBy(rule, explicit) {
  for (const source of rule.explicit_coverage_patterns) {
    let regexp;
    try {
      regexp = new RegExp(source, "iu");
    } catch {
      continue;
    }
    const match = explicit.find((criterion) => regexp.test(criterion));
    if (match) return match;
  }
  return null;
}

export function derivedCriterionId(ruleId) {
  return `DV-${ruleId}`;
}

/**
 * Computes the derived verification criteria for one requirement or story.
 * Explicit criteria are never changed: a rule whose verification type an
 * explicit criterion already covers is reported, not duplicated.
 */
export function computeDerivedVerification(policy, {
  explicit = [],
  writePaths = [],
  hasIntegrations = false,
  disabledReason = null,
  mode = "new",
} = {}) {
  const base = {
    schema_version: DERIVED_VERIFICATION_SCHEMA_VERSION,
    policy_hash: policy.policy_hash,
    mode,
    scope: { write_paths: [...writePaths].sort(), has_integrations: Boolean(hasIntegrations) },
  };
  if (disabledReason || policy.enabled === false) {
    return {
      derived_acceptance: [],
      derived_verification: {
        ...base,
        disabled: true,
        reason: disabledReason || "policy_disabled",
        enforce: null,
        covered_by_explicit: [],
      },
    };
  }
  const scope = { writePaths, hasIntegrations };
  const derived = [];
  const covered = [];
  for (const rule of policy.rules) {
    if (!ruleTriggered(rule, scope)) continue;
    const explicitMatch = criterionCoveredBy(rule, explicit);
    if (explicitMatch) {
      covered.push({ rule_id: rule.id, criterion: explicitMatch });
      continue;
    }
    derived.push({
      id: derivedCriterionId(rule.id),
      rule_id: rule.id,
      verification_type: rule.verification_type,
      text: rule.criterion,
      source: "derived",
      priority: "secondary",
      evidence_patterns: rule.evidence_patterns,
    });
  }
  return {
    derived_acceptance: derived,
    derived_verification: {
      ...base,
      disabled: false,
      reason: null,
      enforce: mode === "backfill" ? policy.backfill_enforce : policy.enforce,
      covered_by_explicit: covered,
    },
  };
}

/** Same derived criteria, ignoring metadata that does not change what is required. */
export function derivedCriteriaEqual(left, right) {
  const ids = (list) => (Array.isArray(list) ? list.map((item) => item.id).sort().join("|") : "");
  return ids(left) === ids(right);
}

/**
 * Derived criteria no passing test run covers yet. A run covers a criterion when
 * it names the criterion id or rule id among its acceptance criteria, or when
 * its framework, command, or summary matches the criterion's evidence patterns
 * (a criterion without patterns is covered by any passing run).
 */
export function uncoveredDerivedCriteria(derived, testRuns) {
  const passing = (testRuns || []).map((entry) => entry.record || entry).filter((run) => run?.outcome === "passed");
  return (derived || []).filter((criterion) => {
    const patterns = (criterion.evidence_patterns || []).flatMap((source) => {
      try {
        return [new RegExp(source, "iu")];
      } catch {
        return [];
      }
    });
    return !passing.some((run) => {
      const named = (run.acceptance_criteria || []).map(String);
      if (named.includes(criterion.id) || named.includes(criterion.rule_id)) return true;
      if (patterns.length === 0) return true;
      const haystack = [run.framework, ...(run.command?.argv || []), run.summary].filter(Boolean).join(" ");
      return patterns.some((regexp) => regexp.test(haystack));
    });
  });
}

export function renderDerivedCriteriaLines(derived, covered = []) {
  return [
    ...derived.map((item) => `${item.id} [${item.verification_type}, secondary]: ${item.text}`),
    ...covered.map((item) => `${item.rule_id}: already covered by explicit criterion "${item.criterion}"`),
  ];
}
