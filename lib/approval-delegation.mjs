import { CODE_REVIEW_DECISIONS, MERGE_DECISION_MODES } from "./autonomy-policy.mjs";
import { computeStableHash, cloneJson } from "./canonical.mjs";
import { Date } from "./runtime/host.mjs";

/**
 * Approval delegation: a person signs once an explicit, limited, revocable
 * delegation that lets the agent apply named person-only approvals on their
 * behalf. This module holds the pure rules (action classes, exclusions, scope,
 * validity window, hashing, validity at use). Reading and writing records
 * lives in the engine.
 */

export const DELEGATION_SCHEMA_VERSION = "approval-delegation:v1";
export const DELEGATION_REVOCATION_SCHEMA_VERSION = "approval-delegation-revocation:v1";
export const DELEGATION_USE_SCHEMA_VERSION = "approval-delegation-use:v1";
export const DELEGATED_APPROVAL_SOURCE = "delegated";
export const DELEGATION_HASH_ALGORITHM = "sha256:stable-json:v1";
export const DELEGATION_ID_PATTERN = /^DLG-[A-Z0-9][A-Z0-9._-]*$/u;
export const DELEGATION_GRANT_ACTION = "autonomy.delegation.grant";
export const DELEGATION_REVOKE_ACTION = "autonomy.delegation.revoke";

/** Set on the parsed options only by a verified delegation; argv cannot produce a symbol key. */
export const VERIFIED_DELEGATION_USE = Symbol("verified-delegation-use");

/**
 * Named action classes a delegation may cover, each mapped to the command
 * that applies it. A command accepts a delegation only for its own class.
 */
export const DELEGABLE_ACTIONS = Object.freeze({
  "requirement.approve": "requirement approve",
  "requirement.supersede": "requirement supersede",
  "breakdown.approve": "breakdown approve",
  "dependency.approve": "dependency approve",
  "contract.approve": "contract approve",
  "evidence.supersede": "autonomy delivery evidence supersede",
  "base.acknowledge": "story base acknowledge",
  "overlap.confirm": "story overlap confirm",
  "output.link": "output link",
  "story.abandon": "story abandon",
  "delivery.policy": "autonomy delivery propose",
});

/**
 * The person's standing answers a delivery.policy delegation carries, signed
 * with the grant: each key maps to the values the person may choose. The
 * delegation records the exact values; the agent never picks them.
 */
export const DELIVERY_POLICY_ACTION = "delivery.policy";
export const DELIVERY_POLICY_KEYS = Object.freeze({
  "code-review": Object.freeze({ field: "code_review", values: CODE_REVIEW_DECISIONS }),
  merge: Object.freeze({ field: "merge", values: MERGE_DECISION_MODES }),
});

/**
 * What no delegation can ever cover, even when listed: these stay with the
 * person who runs them in their own terminal.
 */
export const DELEGATION_NEVER_DELEGABLE = Object.freeze([
  Object.freeze({
    id: "protected-branch.push-merge",
    pattern: /^(?:git\.)?(?:push|merge|force[._-]?push)\b|^pull[._-]?request\.merge$|protected/iu,
    reason: "pushing or merging a protected branch outside the governed delivery chain",
  }),
  Object.freeze({
    id: "ungoverned-escape",
    pattern: /ungoverned|^AGENTIC_SDLC_ALLOW_/iu,
    reason: "the AGENTIC_SDLC_ALLOW_UNGOVERNED_* escape variables",
  }),
  Object.freeze({
    id: "deploy-production",
    pattern: /deploy|production|^prod\b|release\.remote/iu,
    reason: "deploys and production access",
  }),
  Object.freeze({
    id: "secrets",
    pattern: /secret|credential|token|password|api[._-]?key/iu,
    reason: "secrets and credentials",
  }),
  Object.freeze({
    id: "installs",
    pattern: /install/iu,
    reason: "installing software, plugins or capabilities",
  }),
  Object.freeze({
    id: "delegation-itself",
    pattern: /^(?:autonomy\.)?delegation\./iu,
    reason: "granting or revoking delegations (only the person does that)",
  }),
]);

export const DELEGATION_MAX_VALIDITY_DAYS = 90;

function invalid(message) {
  const error = new Error(message);
  error.code = "DELEGATION_INVALID";
  return error;
}

/** The exclusion an action name falls under, or null. */
export function delegationExclusion(action) {
  const name = String(action || "").trim();
  return DELEGATION_NEVER_DELEGABLE.find((item) => item.pattern.test(name)) || null;
}

/** Normalizes --actions; throws on wildcards, excluded or unknown classes. */
export function normalizeDelegationActions(values) {
  const list = (Array.isArray(values) ? values : [values])
    .flatMap((value) => String(value ?? "").split(","))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (list.length === 0) throw invalid("--actions must list at least one action class.");
  const excluded = [];
  const unknown = [];
  for (const action of list) {
    if (action === "*" || action.endsWith(".*")) {
      throw invalid("A delegation lists each action class by name; wildcards are not accepted.");
    }
    const exclusion = delegationExclusion(action);
    if (exclusion) excluded.push(`${action} (${exclusion.reason})`);
    else if (!Object.hasOwn(DELEGABLE_ACTIONS, action)) unknown.push(action);
  }
  if (excluded.length > 0) {
    throw invalid(`Never delegable, even when listed: ${excluded.join("; ")}. The person keeps running these in their own terminal.`);
  }
  if (unknown.length > 0) {
    throw invalid(`Unknown action class: ${unknown.join(", ")}. Delegable classes: ${Object.keys(DELEGABLE_ACTIONS).join(", ")}.`);
  }
  return [...new Set(list)].sort();
}

/**
 * Parses --delivery-policy code-review=<required|not-required>,merge=<mode>
 * into { code_review, merge }. At least one key; each key at most once.
 */
export function parseDeliveryPolicy(value) {
  const pairs = String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  if (pairs.length === 0) {
    throw invalid(`--delivery-policy must give at least one answer: ${Object.keys(DELIVERY_POLICY_KEYS).map((key) => `${key}=<${DELIVERY_POLICY_KEYS[key].values.join("|")}>`).join(",")}.`);
  }
  const policy = {};
  for (const pair of pairs) {
    const match = /^([a-z-]+)\s*=\s*([a-z-]+)$/iu.exec(pair);
    const key = match?.[1].toLowerCase();
    const spec = key ? DELIVERY_POLICY_KEYS[key] : null;
    if (!spec) throw invalid(`--delivery-policy: '${pair}' is not one of ${Object.keys(DELIVERY_POLICY_KEYS).map((name) => `${name}=<value>`).join(", ")}.`);
    const answer = match[2].toLowerCase();
    if (!spec.values.includes(answer)) throw invalid(`--delivery-policy: ${key} must be one of ${spec.values.join(", ")}; got ${answer}.`);
    if (Object.hasOwn(policy, spec.field)) throw invalid(`--delivery-policy names ${key} more than once.`);
    policy[spec.field] = answer;
  }
  return policy;
}

export function formatDeliveryPolicy(policy) {
  return Object.entries(DELIVERY_POLICY_KEYS)
    .filter(([, spec]) => policy?.[spec.field])
    .map(([key, spec]) => `${key}=${policy[spec.field]}`)
    .join(",");
}

/** The words a delivery choice answered by a delegation carries. */
export function delegatedChoiceStatement(record) {
  return `scelta di ${delegationGrantorName(record)} per delega ${record.id}`;
}

/** Parses --scope project|requirement:<REQ>|story:<ST>. */
export function parseDelegationScope(value) {
  const text = String(value ?? "").trim();
  if (text.toLowerCase() === "project") return { kind: "project", id: null };
  const match = /^(requirement|story):([A-Za-z0-9][A-Za-z0-9._-]*)$/u.exec(text);
  if (!match) throw invalid("--scope must be project, requirement:<REQ-id> or story:<ST-id>.");
  return { kind: match[1], id: match[2].toUpperCase() };
}

export function formatDelegationScope(scope) {
  return scope?.kind === "project" ? "project" : `${scope?.kind}:${scope?.id}`;
}

/**
 * Parses --until: an ISO date or date-time, or a duration such as 30d, 12h or
 * 2w. Returns the expiry instant; it must be in the future and within the
 * maximum validity.
 */
export function parseDelegationUntil(value, { now = new Date(), maxDays = DELEGATION_MAX_VALIDITY_DAYS } = {}) {
  const text = String(value ?? "").trim();
  if (!text) throw invalid("--until must give an expiry: a date (2026-11-30), a date-time, or a duration such as 30d.");
  const start = new Date(now).getTime();
  let expires;
  const duration = /^(\d{1,4})\s*([hdw])$/iu.exec(text);
  if (duration) {
    const hours = { h: 1, d: 24, w: 24 * 7 }[duration[2].toLowerCase()];
    expires = start + Number(duration[1]) * hours * 3_600_000;
  } else if (/^\d{4}-\d{2}-\d{2}$/u.test(text)) {
    expires = Date.parse(`${text}T23:59:59.999Z`);
  } else {
    expires = Date.parse(text);
  }
  if (!Number.isFinite(expires)) throw invalid(`--until '${text}' is neither a date nor a duration such as 30d.`);
  if (expires <= start) throw invalid(`--until '${text}' is already in the past.`);
  if (expires - start > maxDays * 24 * 3_600_000) {
    throw invalid(`--until '${text}' exceeds the maximum validity of ${maxDays} days; grant a shorter delegation and renew it.`);
  }
  return new Date(expires).toISOString();
}

function hashable(record) {
  const copy = cloneJson(record);
  delete copy.record_hash;
  delete copy.hash_algorithm;
  return copy;
}

export function delegationRecordHash(record) {
  return computeStableHash(hashable(record));
}

export function sealDelegationRecord(record) {
  const base = hashable(record);
  return { ...base, record_hash: computeStableHash(base), hash_algorithm: DELEGATION_HASH_ALGORITHM };
}

export function delegationHashValid(record) {
  return Boolean(record?.record_hash) && record.record_hash === delegationRecordHash(record);
}

/** Who granted the delegation, in words. */
export function delegationGrantorName(record) {
  const actor = record?.grantor || {};
  return actor.name || actor.id || "una persona";
}

/** The sentence every delegated record carries. */
export function delegatedApprovalStatement(record) {
  return `approvato dall'agente per delega ${record.id} di ${delegationGrantorName(record)}`;
}

/**
 * Whether the scope covers the target. A target names the requirement and/or
 * story the command acts on; one with neither is covered only by a project
 * scope.
 */
export function delegationScopeCovers(scope, target = {}) {
  if (scope?.kind === "project") return true;
  const story = target.story ? String(target.story).toUpperCase() : null;
  const requirements = (target.requirements || [])
    .concat(target.requirement ? [target.requirement] : [])
    .map((item) => String(item).toUpperCase());
  if (scope?.kind === "story") return Boolean(story) && story === scope.id;
  if (scope?.kind === "requirement") return requirements.includes(scope.id);
  return false;
}

/**
 * Validity of one delegation for one use. Checks, in order: hash, approval,
 * revocation, validity window, action class (and exclusions), scope.
 */
export function evaluateDelegationUse(record, { action, target = {}, now = new Date(), revocation = null } = {}) {
  const errors = [];
  if (!record || record.schema_version !== DELEGATION_SCHEMA_VERSION) {
    return { valid: false, errors: ["the record is not an approval delegation"] };
  }
  if (!delegationHashValid(record)) {
    errors.push(`its hash does not match its content (record ${record.id} was altered after it was granted)`);
  }
  const approval = record.approval || {};
  if (record.status !== "approved" || approval.status !== "approved"
    || approval.approval_source !== "explicit-user" || record.grantor?.type !== "human") {
    errors.push("it was not approved by a person with --approval-source explicit-user");
  }
  if (revocation) {
    errors.push(`it was revoked on ${revocation.revoked_at} by ${revocation.revoked_by?.name || revocation.revoked_by?.id || "a person"}: ${revocation.reason}`);
  }
  const at = new Date(now).getTime();
  const from = Date.parse(record.valid_from || "");
  const until = Date.parse(record.expires_at || "");
  if (!Number.isFinite(until) || at >= until) errors.push(`it expired on ${record.expires_at}`);
  if (Number.isFinite(from) && at < from) errors.push(`it is valid only from ${record.valid_from}`);
  const exclusion = delegationExclusion(action);
  if (exclusion) {
    errors.push(`${action} is never delegable (${exclusion.reason})`);
  } else if (!Object.hasOwn(DELEGABLE_ACTIONS, action)) {
    errors.push(`${action} is not a delegable action class`);
  } else if (!(record.actions || []).includes(action)) {
    errors.push(`it does not cover the action ${action} (it covers: ${(record.actions || []).join(", ")})`);
  }
  if (!delegationScopeCovers(record.scope, target)) {
    const what = [target.story && `story ${target.story}`, target.requirement && `requirement ${target.requirement}`]
      .filter(Boolean).join(", ") || "a project-wide subject";
    errors.push(`its scope ${formatDelegationScope(record.scope)} does not cover ${what}`);
  }
  return { valid: errors.length === 0, errors };
}

/** Delegations grouped for status: active, expiring soon, expired, revoked. */
export function classifyDelegation(record, { now = new Date(), revocation = null, warningHours = 72 } = {}) {
  if (revocation) return "revoked";
  if (!delegationHashValid(record)) return "invalid";
  const at = new Date(now).getTime();
  const until = Date.parse(record.expires_at || "");
  if (!Number.isFinite(until) || at >= until) return "expired";
  return until - at <= warningHours * 3_600_000 ? "expiring" : "active";
}
