import {
  STABLE_JSON_HASH_ALGORITHM,
  computeStableHash,
  isPlainRecord,
} from "./canonical.mjs";
import { Date } from "./runtime/host.mjs";

/**
 * Standing approvals: a user-approved, bounded, revocable delegation that lets
 * repeated low-risk deliveries proceed without a fresh confirmation for each
 * one. This module holds the pure rules (record shapes, hashing, state and
 * bound evaluation). Reading and writing records lives in the engine.
 */

export const STANDING_APPROVAL_SCHEMA_VERSION = "standing-approval:v1";
export const STANDING_APPROVAL_DECISION_SCHEMA_VERSION = "standing-approval-decision:v1";
export const STANDING_APPROVAL_USE_SCHEMA_VERSION = "standing-approval-use:v1";
export const STANDING_APPROVAL_SOURCE = "standing-approval";
export const STANDING_APPROVAL_LEVEL = "checkpointed";
export const STANDING_APPROVAL_DESTINATIONS = Object.freeze(["local_release", "pull_request"]);

/**
 * Fallback values for projects whose configuration predates
 * standing_approval_policy. The shipped configuration template carries the
 * same keys, so a project changes them in its own configuration.
 */
export const STANDING_APPROVAL_POLICY_DEFAULTS = Object.freeze({
  enabled: true,
  max_validity_days: 30,
  max_deliveries: 20,
  max_changed_files: 200,
  max_changed_lines: 5000,
  expiry_warning_hours: 72,
});

/** Delivery actions a standing approval may confirm, per destination. */
export const STANDING_COVERABLE_ACTIONS = Object.freeze({
  local_release: Object.freeze(["build.local", "release.local", "rollback.verify", "test.run"]),
  pull_request: Object.freeze([
    "git.commit",
    "git.push",
    "pull_request.create",
    "pull_request.update",
    "repository.read",
    "repository.write",
    "test.run",
  ]),
});

/**
 * What no standing approval can ever cover, whatever its bounds say. These are
 * CLI invariants recorded on every standing approval so the limit is legible.
 */
export const STANDING_NEVER_COVERED = Object.freeze([
  "data.migrate",
  "data.rollback",
  "deploy.remote",
  "git.force_push",
  "production.access",
  "pull_request.merge",
  "tracked_file_deletion_outside_scope",
]);

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const RECIPE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const CURRENCY_PATTERN = /^[A-Z]{3}$/u;
const GLOB_CHARACTERS = /[*?]/u;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const HASH_FIELDS = Object.freeze(["record_hash", "hash_algorithm"]);

export class StandingApprovalError extends Error {
  constructor(message) {
    super(message);
    this.name = "StandingApprovalError";
  }
}

function invalid(message) {
  throw new StandingApprovalError(message);
}

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  const number = typeof value === "string" && /^[0-9]+$/u.test(value.trim())
    ? Number(value.trim())
    : value;
  if (!Number.isSafeInteger(number) || number < 1) {
    invalid(`${label} must be a positive integer.`);
  }
  if (number > maximum) {
    invalid(`${label} must not exceed ${maximum}.`);
  }
  return number;
}

function positiveAmount(value, label) {
  if (value === undefined || value === null || value === "") return null;
  const text = String(value).trim();
  if (!/^[0-9]+(?:\.[0-9]{1,6})?$/u.test(text) || Number(text) <= 0) {
    invalid(`${label} must be a positive decimal amount.`);
  }
  return Number(text);
}

function requireText(value, label, maximum = 2000) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) invalid(`${label} is required.`);
  if (text.length > maximum) invalid(`${label} must be at most ${maximum} characters.`);
  return text;
}

function instant(value, label) {
  const text = typeof value === "string" ? value.trim() : "";
  const parsed = Date.parse(text);
  if (!text || !Number.isFinite(parsed) || !/^\d{4}-\d{2}-\d{2}T/u.test(text)) {
    invalid(`${label} must be an ISO-8601 timestamp.`);
  }
  return new Date(parsed).toISOString();
}

/** Effective policy: configured values over the documented fallbacks. */
export function standingApprovalPolicy(config = {}) {
  const configured = isPlainRecord(config?.standing_approval_policy)
    ? config.standing_approval_policy
    : {};
  const policy = { ...STANDING_APPROVAL_POLICY_DEFAULTS };
  for (const key of Object.keys(STANDING_APPROVAL_POLICY_DEFAULTS)) {
    if (configured[key] !== undefined) policy[key] = configured[key];
  }
  if (typeof policy.enabled !== "boolean") invalid("standing_approval_policy.enabled must be a boolean.");
  for (const key of ["max_validity_days", "max_deliveries", "max_changed_files", "max_changed_lines", "expiry_warning_hours"]) {
    positiveInteger(policy[key], `standing_approval_policy.${key}`);
  }
  return Object.freeze(policy);
}

/**
 * Normalizes one project-relative write path or glob. Absolute paths, parent
 * segments, and the governance record tree are refused so a bound can never
 * reach outside the project or over its own evidence.
 */
export function normalizeStandingWritePath(value) {
  const text = String(value ?? "").trim().replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
  if (!text || text === ".") invalid("A standing approval write path must be narrower than the project root.");
  if (text.startsWith("/") || /^[A-Za-z]:/u.test(text)) {
    invalid(`Standing approval write path must be project-relative: ${value}.`);
  }
  const segments = text.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    invalid(`Standing approval write path must not contain empty, '.' or '..' segments: ${value}.`);
  }
  if (segments[0] === ".sdlc" || segments[0] === ".git") {
    invalid(`Standing approval write path must not cover governance or repository metadata: ${value}.`);
  }
  if (segments.some((segment) => segment === "**") && /[^/]\*\*|\*\*[^/]/u.test(text)) {
    invalid(`Standing approval glob '**' must be a whole path segment: ${value}.`);
  }
  return text;
}

function globExpression(pattern) {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      const followedBySlash = pattern[index + 2] === "/";
      expression += followedBySlash ? "(?:[^/]+/)*" : ".*";
      index += followedBySlash ? 2 : 1;
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
    }
  }
  return new RegExp(`${expression}$`, "u");
}

/** A file is inside a bound when it equals or sits under a prefix, or matches a glob. */
export function standingPathAllowed(filePath, patterns) {
  const normalized = String(filePath ?? "").replace(/\\/gu, "/").replace(/^\.\//u, "");
  return patterns.some((pattern) => (GLOB_CHARACTERS.test(pattern)
    ? globExpression(pattern).test(normalized)
    : normalized === pattern || normalized.startsWith(`${pattern}/`)));
}

/**
 * A delivery write root (a directory or file the delivery may write) is inside
 * the bound only when a plain prefix contains it; a glob cannot vouch for every
 * file a whole directory may later hold.
 */
export function standingWriteRootAllowed(writeRoot, patterns) {
  const normalized = String(writeRoot ?? "").replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
  return patterns.some((pattern) => (GLOB_CHARACTERS.test(pattern)
    ? !GLOB_CHARACTERS.test(normalized) && globExpression(pattern).test(normalized)
    : normalized === pattern || normalized.startsWith(`${pattern}/`)));
}

export function standingRecordHash(record) {
  const subject = {};
  for (const [key, value] of Object.entries(record || {})) {
    if (!HASH_FIELDS.includes(key)) subject[key] = value;
  }
  return computeStableHash(subject);
}

function sealed(record) {
  return {
    ...record,
    record_hash: standingRecordHash(record),
    hash_algorithm: STABLE_JSON_HASH_ALGORITHM,
  };
}

/** Builds the immutable proposal. Every bound is mandatory except the budget. */
export function buildStandingApprovalProposal(input, { now, policy }) {
  if (!isPlainRecord(input)) invalid("Standing approval input must be an object.");
  const id = requireText(input.id, "Standing approval --id", 128);
  if (!ID_PATTERN.test(id)) invalid(`Standing approval id '${id}' must use letters, digits, '.', '_' or '-'.`);
  const recipeId = requireText(input.recipe_id, "Standing approval --recipe", 64).toLowerCase();
  if (!RECIPE_PATTERN.test(recipeId)) {
    invalid(`Standing approval recipe '${recipeId}' must use lowercase letters, digits, '.', '_' or '-'.`);
  }
  const description = requireText(input.description, "Standing approval --description");
  const destination = String(input.destination ?? "").trim();
  if (!STANDING_APPROVAL_DESTINATIONS.includes(destination)) {
    invalid(`Standing approval --destination must be one of ${STANDING_APPROVAL_DESTINATIONS.join(", ")}.`);
  }
  const requirementRefs = Array.isArray(input.requirement_refs) ? input.requirement_refs : [];
  if (requirementRefs.length === 0) invalid("Standing approval needs at least one --requirement.");
  const writePaths = [...new Set((input.allowed_write_paths || []).map(normalizeStandingWritePath))].sort();
  if (writePaths.length === 0) invalid("Standing approval needs at least one --write-path.");
  const maxFiles = positiveInteger(input.max_changed_files, "Standing approval --max-changed-files", policy.max_changed_files);
  const maxLines = positiveInteger(input.max_changed_lines, "Standing approval --max-changed-lines", policy.max_changed_lines);
  const maxDeliveries = positiveInteger(input.max_deliveries, "Standing approval --max-deliveries", policy.max_deliveries);
  const createdAt = instant(now, "Standing approval creation time");
  const expiresAt = instant(input.expires_at, "Standing approval --expires-at");
  const lifetime = Date.parse(expiresAt) - Date.parse(createdAt);
  if (lifetime <= 0) invalid("Standing approval --expires-at must be in the future.");
  if (lifetime > policy.max_validity_days * DAY_MS) {
    invalid(`Standing approval --expires-at must be within ${policy.max_validity_days} days (standing_approval_policy.max_validity_days).`);
  }
  const perDelivery = positiveAmount(input.budget?.per_delivery_amount, "Standing approval --budget-per-delivery");
  const total = positiveAmount(input.budget?.total_amount, "Standing approval --budget-total");
  let budget = null;
  if (perDelivery !== null || total !== null) {
    const currency = String(input.budget?.currency ?? "").trim().toUpperCase();
    if (!CURRENCY_PATTERN.test(currency)) invalid("Standing approval budget needs --currency as an ISO-4217 code.");
    if (perDelivery !== null && total !== null && perDelivery > total) {
      invalid("Standing approval --budget-per-delivery must not exceed --budget-total.");
    }
    budget = { currency, per_delivery_amount: perDelivery, total_amount: total };
  }
  for (const ref of requirementRefs) {
    if (!ref?.id || !ref?.profile_id || !SHA256_PATTERN.test(String(ref.profile_hash || ""))) {
      invalid("Standing approval requirement references must name an approved requirement and its hash.");
    }
  }
  const bindings = input.bindings || {};
  for (const key of ["config_hash", "policy_hash", "project_hash"]) {
    if (!SHA256_PATTERN.test(String(bindings[key] || ""))) invalid(`Standing approval binding ${key} is missing.`);
  }
  return sealed({
    kind: "standing_approval",
    schema_version: STANDING_APPROVAL_SCHEMA_VERSION,
    id,
    status: "proposed",
    work_kind: { recipe_id: recipeId, description },
    scope: {
      project_id: requireText(input.scope?.project_id, "Standing approval project id", 256),
      project_root: requireText(input.scope?.project_root, "Standing approval project root", 4096),
    },
    requirement_refs: [...requirementRefs]
      .map((ref) => ({ id: String(ref.id), profile_id: String(ref.profile_id), profile_hash: String(ref.profile_hash) }))
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
    allowed_write_paths: writePaths,
    limits: { max_changed_files: maxFiles, max_changed_lines: maxLines },
    destination: {
      kind: destination,
      merge_allowed: false,
      deploy_allowed: false,
      production_allowed: false,
    },
    delivery_level: STANDING_APPROVAL_LEVEL,
    covered_actions: [...STANDING_COVERABLE_ACTIONS[destination]],
    never_covered: [...STANDING_NEVER_COVERED],
    max_deliveries: maxDeliveries,
    valid_from: createdAt,
    expires_at: expiresAt,
    budget,
    bindings: {
      config_hash: String(bindings.config_hash),
      policy_hash: String(bindings.policy_hash),
      project_hash: String(bindings.project_hash),
    },
    created_at: createdAt,
    audit: { proposed_by: input.actor ?? null },
  });
}

export function buildStandingApprovalDecision({
  id,
  decision,
  proposal,
  approval,
  reason = null,
  createdAt,
  actor = null,
}) {
  if (!["approved", "revoked"].includes(decision)) invalid("Standing approval decision must be approved or revoked.");
  if (decision === "revoked") requireText(reason, "Standing approval revocation --reason");
  return sealed({
    kind: "standing_approval_decision",
    schema_version: STANDING_APPROVAL_DECISION_SCHEMA_VERSION,
    id,
    decision,
    standing_approval_ref: { id: proposal.id, record_hash: proposal.record_hash },
    reason: decision === "revoked" ? String(reason).trim() : null,
    approval,
    created_at: instant(createdAt, "Standing approval decision time"),
    audit: { actor },
  });
}

export function buildStandingApprovalUse({
  proposal,
  approvalDecision,
  slot,
  delivery,
  profileRef,
  storyId,
  contractId,
  createdAt,
  actor = null,
}) {
  return sealed({
    kind: "standing_approval_use",
    schema_version: STANDING_APPROVAL_USE_SCHEMA_VERSION,
    id: `${proposal.id}-USE-${String(slot).padStart(4, "0")}`,
    standing_approval_ref: {
      id: proposal.id,
      record_hash: proposal.record_hash,
      approval_hash: approvalDecision.record_hash,
    },
    slot,
    max_deliveries: proposal.max_deliveries,
    delivery: { id: String(delivery.id), kind: String(delivery.kind) },
    profile_ref: { id: String(profileRef.id), hash: String(profileRef.hash) },
    story_id: storyId ? String(storyId) : null,
    contract_id: contractId ? String(contractId) : null,
    created_at: instant(createdAt, "Standing approval use time"),
    audit: { actor },
  });
}

/** Hash, kind, and lineage errors for one set of standing-approval records. */
export function standingApprovalIntegrityErrors({ proposal, approval = null, revocation = null, uses = [] }) {
  const errors = [];
  if (!isPlainRecord(proposal) || proposal.kind !== "standing_approval"
    || proposal.schema_version !== STANDING_APPROVAL_SCHEMA_VERSION) {
    return ["the standing approval record is not a standing-approval:v1 record"];
  }
  if (proposal.record_hash !== standingRecordHash(proposal)) {
    errors.push("the standing approval record changed after it was proposed");
  }
  if (stableArray(proposal.covered_actions) !== stableArray(STANDING_COVERABLE_ACTIONS[proposal.destination?.kind] || [])
    || proposal.destination?.merge_allowed !== false
    || proposal.destination?.deploy_allowed !== false
    || proposal.destination?.production_allowed !== false
    || proposal.delivery_level !== STANDING_APPROVAL_LEVEL) {
    errors.push("the standing approval record widens what the CLI allows a standing approval to cover");
  }
  for (const [label, record, expected] of [
    ["approval", approval, "approved"],
    ["revocation", revocation, "revoked"],
  ]) {
    if (!record) continue;
    if (record.kind !== "standing_approval_decision"
      || record.schema_version !== STANDING_APPROVAL_DECISION_SCHEMA_VERSION
      || record.decision !== expected) {
      errors.push(`the standing approval ${label} record has the wrong kind`);
      continue;
    }
    if (record.record_hash !== standingRecordHash(record)) {
      errors.push(`the standing approval ${label} record changed after it was written`);
    }
    if (record.standing_approval_ref?.id !== proposal.id
      || record.standing_approval_ref?.record_hash !== proposal.record_hash) {
      errors.push(`the standing approval ${label} record is bound to different content`);
    }
    if (record.approval?.status !== "approved") {
      errors.push(`the standing approval ${label} lacks a formal approval`);
    }
  }
  if (revocation && !approval) errors.push("the standing approval was revoked before it was approved");
  const slots = new Set();
  for (const use of uses) {
    if (use?.kind !== "standing_approval_use" || use.schema_version !== STANDING_APPROVAL_USE_SCHEMA_VERSION) {
      errors.push("a standing approval use record has the wrong kind");
      continue;
    }
    if (use.record_hash !== standingRecordHash(use)) {
      errors.push(`standing approval use ${use.id} changed after it was written`);
    }
    if (!approval
      || use.standing_approval_ref?.id !== proposal.id
      || use.standing_approval_ref?.record_hash !== proposal.record_hash
      || use.standing_approval_ref?.approval_hash !== approval.record_hash) {
      errors.push(`standing approval use ${use.id} is bound to different content`);
    }
    if (!Number.isSafeInteger(use.slot) || use.slot < 1 || use.slot > proposal.max_deliveries || slots.has(use.slot)) {
      errors.push(`standing approval use ${use.id} has an invalid delivery slot`);
    }
    slots.add(use.slot);
    if (approval && Date.parse(use.created_at) < Date.parse(approval.created_at)) {
      errors.push(`standing approval use ${use.id} predates the approval`);
    }
    if (Date.parse(use.created_at) > Date.parse(proposal.expires_at)) {
      errors.push(`standing approval use ${use.id} was recorded after expiry`);
    }
    if (revocation && Date.parse(use.created_at) > Date.parse(revocation.created_at)) {
      errors.push(`standing approval use ${use.id} was recorded after revocation`);
    }
  }
  return errors;
}

function stableArray(values) {
  return JSON.stringify([...(Array.isArray(values) ? values : [])].map(String).sort());
}

/**
 * Derives the current status. Precedence: invalid, revoked, proposed,
 * disabled, expired, stale (bound project, configuration, or policy changed),
 * exhausted, active. Only "active" covers anything.
 */
export function deriveStandingApprovalState({
  proposal,
  approval = null,
  revocation = null,
  uses = [],
  integrityErrors = [],
  nowMs,
  currentBindings = null,
  policy = STANDING_APPROVAL_POLICY_DEFAULTS,
}) {
  const used = uses.length;
  const maxDeliveries = Number(proposal?.max_deliveries) || 0;
  const expiresMs = Date.parse(proposal?.expires_at ?? "");
  const reasons = [];
  let status;
  if (integrityErrors.length > 0) {
    status = "invalid";
    reasons.push(...integrityErrors);
  } else if (revocation) {
    status = "revoked";
    reasons.push(`it was revoked: ${revocation.reason}`);
  } else if (!approval) {
    status = "proposed";
    reasons.push("it has not been approved yet");
  } else if (policy.enabled !== true) {
    status = "disabled";
    reasons.push("standing approvals are disabled by the project configuration");
  } else if (!Number.isFinite(expiresMs) || nowMs >= expiresMs) {
    status = "expired";
    reasons.push(`it expired at ${proposal.expires_at}`);
  } else if (currentBindings && ["config_hash", "policy_hash", "project_hash"]
    .some((key) => currentBindings[key] !== proposal.bindings?.[key])) {
    status = "stale";
    for (const [key, label] of [
      ["project_hash", "the project identity"],
      ["config_hash", "the project configuration"],
      ["policy_hash", "the approval and autonomy policy"],
    ]) {
      if (currentBindings[key] !== proposal.bindings?.[key]) reasons.push(`${label} changed after approval`);
    }
  } else if (used >= maxDeliveries) {
    status = "exhausted";
    reasons.push(`all ${maxDeliveries} deliveries were used`);
  } else {
    status = "active";
  }
  const warnings = [];
  if (status === "active" && Number.isFinite(expiresMs)
    && expiresMs - nowMs <= Number(policy.expiry_warning_hours) * HOUR_MS) {
    warnings.push(`expires soon, at ${proposal.expires_at}`);
  }
  if (status === "active" && maxDeliveries - used === 1) {
    warnings.push("one delivery left");
  }
  return {
    status,
    covers: status === "active",
    used,
    remaining: Math.max(0, maxDeliveries - used),
    max_deliveries: maxDeliveries,
    expires_at: proposal?.expires_at ?? null,
    reasons,
    warnings,
  };
}

/**
 * Static bounds a delivery must satisfy before it may rely on the standing
 * approval: destination, no merge, level, requirements, and write roots.
 */
export function standingDeliveryBoundReasons(proposal, delivery) {
  const reasons = [];
  if (delivery.kind !== proposal.destination.kind) {
    reasons.push(`this delivery is a ${delivery.kind.replace("_", " ")}, but the standing approval covers only ${proposal.destination.kind.replace("_", " ")} deliveries`);
  }
  if (delivery.merge_allowed === true) {
    reasons.push("merging a pull request is never covered by a standing approval");
  }
  if (delivery.level !== undefined && delivery.level !== proposal.delivery_level) {
    reasons.push(`the delivery asks for ${delivery.level} work, but the standing approval covers only ${proposal.delivery_level} work`);
  }
  const allowedRequirements = new Set(proposal.requirement_refs.map((ref) => ref.id));
  const extra = (delivery.requirement_ids || []).filter((id) => !allowedRequirements.has(id));
  if (extra.length > 0) reasons.push(`requirement ${extra.join(", ")} is outside the standing approval`);
  const covered = new Set(proposal.covered_actions);
  const uncovered = (delivery.allowed_actions || []).filter((action) => !covered.has(action));
  if (uncovered.length > 0) {
    reasons.push(`the delivery allows ${uncovered.join(", ")}, which a standing approval never covers`);
  }
  if (delivery.outside_project_paths?.length > 0) {
    reasons.push(`the delivery writes outside the project: ${delivery.outside_project_paths.join(", ")}`);
  }
  const outside = (delivery.write_roots || [])
    .filter((writeRoot) => !standingWriteRootAllowed(writeRoot, proposal.allowed_write_paths));
  if (outside.length > 0) {
    reasons.push(`the delivery may write outside the allowed paths: ${outside.join(", ")}`);
  }
  if (delivery.authority_mode === "host_verified") {
    reasons.push("this project requires a trusted signed approval for each action, which a standing approval cannot provide");
  }
  return reasons;
}

export function standingActionReasons(proposal, action) {
  if (STANDING_NEVER_COVERED.includes(action)) {
    return [`${action} is never covered by a standing approval`];
  }
  if (!proposal.covered_actions.includes(action)) {
    return [`${action} is outside what this standing approval covers`];
  }
  return [];
}

/**
 * Observed change bounds. `changes` lists every changed path since the
 * delivery started (governance records excluded) with added and deleted line
 * counts; a binary or unmeasurable change fails closed.
 */
export function standingChangeReasons(proposal, changes) {
  if (!changes || changes.measurable !== true) {
    return [`the changed files cannot be measured: ${changes?.error || "no measurement is available"}`];
  }
  const reasons = [];
  const files = changes.files || [];
  const outside = files.filter((file) => !standingPathAllowed(file.path, proposal.allowed_write_paths));
  const deletedOutside = outside.filter((file) => file.deleted_file === true);
  if (deletedOutside.length > 0) {
    reasons.push(`tracked files outside the allowed paths were deleted: ${listSample(deletedOutside.map((file) => file.path))}`);
  }
  const changedOutside = outside.filter((file) => file.deleted_file !== true);
  if (changedOutside.length > 0) {
    reasons.push(`files outside the allowed paths changed: ${listSample(changedOutside.map((file) => file.path))}`);
  }
  const binary = files.filter((file) => file.binary === true);
  if (binary.length > 0) {
    reasons.push(`binary changes cannot be measured in lines: ${listSample(binary.map((file) => file.path))}`);
  }
  if (files.length > proposal.limits.max_changed_files) {
    reasons.push(`${files.length} files changed, above the limit of ${proposal.limits.max_changed_files}`);
  }
  const lines = files.reduce((total, file) => total + (Number(file.added) || 0) + (Number(file.deleted) || 0), 0);
  if (lines > proposal.limits.max_changed_lines) {
    reasons.push(`${lines} lines changed, above the limit of ${proposal.limits.max_changed_lines}`);
  }
  return reasons;
}

/** A configured budget needs a measurement; without one the delivery is not covered. */
export function standingBudgetReasons(proposal, measurement) {
  if (!proposal.budget) return [];
  if (!measurement || measurement.measurable !== true) {
    return [`a cost budget is set, but this delivery's cost cannot be measured${measurement?.reason ? ` (${measurement.reason})` : ""}`];
  }
  const reasons = [];
  if (measurement.currency !== proposal.budget.currency) {
    reasons.push(`delivery cost is measured in ${measurement.currency}, not ${proposal.budget.currency}`);
    return reasons;
  }
  if (proposal.budget.per_delivery_amount !== null && measurement.delivery_amount > proposal.budget.per_delivery_amount) {
    reasons.push(`this delivery cost ${measurement.delivery_amount} ${measurement.currency}, above the per-delivery budget`);
  }
  if (proposal.budget.total_amount !== null && measurement.total_amount > proposal.budget.total_amount) {
    reasons.push(`deliveries under this standing approval cost ${measurement.total_amount} ${measurement.currency}, above the total budget`);
  }
  return reasons;
}

function listSample(values, limit = 8) {
  const sorted = [...new Set(values)].sort();
  return sorted.length > limit
    ? `${sorted.slice(0, limit).join(", ")} and ${sorted.length - limit} more`
    : sorted.join(", ");
}

/**
 * Historical validity of a derived approval: it must have been created while
 * the standing approval was approved, unexpired, and not yet revoked.
 */
export function standingDerivedApprovalErrors({ derived, proposal, approval, revocation }) {
  const errors = [];
  const ref = derived?.standing_approval_ref;
  if (!ref?.id || ref.id !== proposal?.id || ref.record_hash !== proposal?.record_hash
    || ref.approval_hash !== approval?.record_hash) {
    errors.push("it does not reference the exact approved standing approval");
    return errors;
  }
  const createdMs = Date.parse(derived.created_at ?? "");
  if (!Number.isFinite(createdMs)) {
    errors.push("it has no valid creation time");
    return errors;
  }
  if (createdMs < Date.parse(approval.created_at)) errors.push("it predates the standing approval");
  if (createdMs >= Date.parse(proposal.expires_at)) errors.push("it was created after the standing approval expired");
  if (revocation && createdMs >= Date.parse(revocation.created_at)) {
    errors.push("it was created after the standing approval was revoked");
  }
  return errors;
}
