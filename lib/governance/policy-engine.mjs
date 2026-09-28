import { Date } from "../runtime/host.mjs";
import {
  DomainValidationError,
  STABLE_JSON_HASH_ALGORITHM,
  compareCanonicalStrings,
  computeStableHash,
  immutableJson,
  isPlainRecord,
  normalizeIsoInstant,
  omitKeys,
  requireNonEmptyString,
  requirePlainRecord,
} from "../canonical.mjs";
import {
  computeActorIdentityHash,
  normalizeActorIdentity,
  normalizeExactRefs,
  normalizeGovernanceRef,
  validateCommandSubjectIntegrity,
} from "./command-subject.mjs";

export const GOVERNANCE_POLICY_V1 = "governance-policy:v1";
export const GOVERNANCE_POLICY_DECISION_V1 = "governance-policy-decision:v1";
export const GOVERNANCE_POLICY_USE_RECEIPT_V1 = "governance-policy-use-receipt:v1";
export const GOVERNANCE_POLICY_REVOCATION_V1 = "governance-policy-revocation:v1";

const EXACT_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const REFERENCE_ID_PATTERN = /^(?!\.{1,2}(?:\/|$))(?![^@]*@)[A-Za-z0-9.][A-Za-z0-9._:/+-]{0,511}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const REVOCATION_TARGETS = new Set(["approval", "decision", "policy", "role_binding", "rule"]);
const DECISION_FIELDS = new Set([
  "kind", "schema_version", "version", "id", "policy_ref", "subject", "subject_hash", "actor",
  "actor_identity_hash", "actor_roles", "decision", "reason_codes", "matched_allow_rule_ids",
  "matched_deny_rule_ids", "grant", "evaluated_at", "valid_until", "decision_hash", "hash_algorithm",
]);
const USE_RECEIPT_FIELDS = new Set([
  "kind", "schema_version", "version", "id", "decision_ref", "policy_ref", "subject_hash", "action",
  "actor", "actor_identity_hash", "decision_evaluated_at", "decision_valid_until", "used_at",
  "evidence_refs", "receipt_hash", "hash_algorithm",
]);

/**
 * Creates a stable policy snapshot. Rules never accept wildcards or prefixes:
 * action, scope references, and evidence references are exact values.
 */
export function createGovernancePolicy(input) {
  const base = normalizePolicyBase(input);
  return immutableJson({
    ...base,
    policy_hash: computeGovernancePolicyHash(base),
    hash_algorithm: STABLE_JSON_HASH_ALGORITHM,
  });
}

export function computeGovernancePolicyHash(policy) {
  requirePlainRecord(policy, "governance_policy");
  return computeStableHash(omitKeys(policy, ["policy_hash", "hash_algorithm"]));
}

export function validateGovernancePolicyIntegrity(policy) {
  return validateStableSnapshot(policy, {
    label: "governance policy",
    hashField: "policy_hash",
    computeHash: computeGovernancePolicyHash,
    normalize: (value) => createGovernancePolicy(value),
  });
}

/**
 * Evaluates a policy without touching the filesystem, environment, process, or
 * wall clock. evaluated_at/decision_id must be explicit or supplied through
 * injected now/id functions.
 */
export function evaluateGovernancePolicy(input, dependencies = {}) {
  requirePlainRecord(input, "governance_evaluation");
  const policy = assertPolicyIntegrity(input.policy);
  const subject = assertSubjectIntegrity(input.subject);
  const actor = normalizeActorIdentity(input.actor, "governance_evaluation.actor");
  const evaluatedAt = resolveInjectedInstant(
    input.evaluated_at,
    dependencies.now,
    "governance_evaluation.evaluated_at",
  );
  const decisionId = resolveInjectedId(
    input.decision_id ?? input.id,
    dependencies.id,
    "governance_evaluation.decision_id",
    "decision",
  );
  const revocations = normalizeRevocations(input.revocations ?? []);
  const approvals = normalizeApprovals(input.approvals ?? []);
  const actorIdentityHash = computeActorIdentityHash(actor);
  const policyRef = hashedRef("policy", policy.id, policy.policy_hash);
  const reasons = new Set();
  const matchedAllowRuleIds = [];
  const matchedDenyRuleIds = [];
  let grant = null;

  if (!isActiveWindow(policy.valid_from, policy.expires_at, evaluatedAt)) {
    reasons.add(evaluatedAt < policy.valid_from ? "policy.not_yet_valid" : "policy.expired");
  }
  if (isTargetRevoked(policyRef, revocations, evaluatedAt)) {
    reasons.add("policy.revoked");
  }

  const actorBindings = activeBindingsForActor(policy, actor, revocations, evaluatedAt);
  const actorRoles = uniqueStrings(actorBindings.map((binding) => binding.role));
  const subjectTarget = exactTargetKey(subject.command.action, subject.scope_refs, subject.evidence_refs);
  const activeRules = policy.rules.filter((rule) => (
    isActiveWindow(rule.valid_from, rule.expires_at, evaluatedAt)
    && !isTargetRevoked(ruleRef(rule), revocations, evaluatedAt)
  ));
  const exactRules = activeRules.filter((rule) => exactRuleTargetKey(rule) === subjectTarget);

  if (reasons.size === 0) {
    for (const rule of exactRules.filter((candidate) => candidate.effect === "deny")) {
      if (rule.actor_roles.length === 0 || intersects(rule.actor_roles, actorRoles)) {
        matchedDenyRuleIds.push(rule.id);
      }
    }
    if (matchedDenyRuleIds.length > 0) {
      reasons.add("rule.explicit_deny");
    }
  }

  if (reasons.size === 0) {
    const allowRules = exactRules.filter((rule) => rule.effect === "allow");
    const allowFailureReasons = new Set();
    for (const rule of allowRules) {
      matchedAllowRuleIds.push(rule.id);
      const result = evaluateAllowRule({
        policy,
        rule,
        actor,
        actorBindings,
        actorRoles,
        subject,
        approvals,
        revocations,
        evaluatedAt,
      });
      if (result.allowed) {
        grant = result.grant;
        break;
      }
      result.reason_codes.forEach((reason) => allowFailureReasons.add(reason));
    }
    if (!grant) {
      allowFailureReasons.forEach((reason) => reasons.add(reason));
      if (allowRules.length === 0) {
        reasons.add(exactRules.length === 0 ? "rule.no_exact_match" : "rule.no_allow");
      } else if (reasons.size === 0) {
        reasons.add("rule.conditions_not_met");
      }
    }
  }

  const allowed = grant !== null && matchedDenyRuleIds.length === 0 && reasons.size === 0;
  if (!allowed && reasons.size === 0) {
    reasons.add("policy.default_deny");
  }
  const validUntil = allowed
    ? computeGrantValidUntil(policy, grant, evaluatedAt)
    : null;
  const base = {
    kind: "governance_policy_decision",
    schema_version: GOVERNANCE_POLICY_DECISION_V1,
    version: 1,
    id: decisionId,
    policy_ref: policyRef,
    subject,
    subject_hash: subject.subject_hash,
    actor,
    actor_identity_hash: actorIdentityHash,
    actor_roles: actorRoles,
    decision: allowed ? "allow" : "deny",
    reason_codes: uniqueStrings(Array.from(reasons)),
    matched_allow_rule_ids: uniqueStrings(matchedAllowRuleIds),
    matched_deny_rule_ids: uniqueStrings(matchedDenyRuleIds),
    grant,
    evaluated_at: evaluatedAt,
    valid_until: validUntil,
  };
  return immutableJson({
    ...base,
    decision_hash: computeGovernanceDecisionHash(base),
    hash_algorithm: STABLE_JSON_HASH_ALGORITHM,
  });
}

export const evaluatePolicy = evaluateGovernancePolicy;
export const createGovernancePolicyDecision = evaluateGovernancePolicy;

export function computeGovernanceDecisionHash(decision) {
  requirePlainRecord(decision, "governance_decision");
  return computeStableHash(omitKeys(decision, ["decision_hash", "hash_algorithm"]));
}

export function validateGovernanceDecisionIntegrity(decision) {
  const basic = validateStableSnapshot(decision, {
    label: "governance decision",
    hashField: "decision_hash",
    computeHash: computeGovernanceDecisionHash,
    allowedKeys: DECISION_FIELDS,
  });
  const errors = [...basic.errors];
  if (isPlainRecord(decision)) {
    if (decision.kind !== "governance_policy_decision"
      || decision.schema_version !== GOVERNANCE_POLICY_DECISION_V1
      || decision.version !== 1) {
      errors.push("governance decision schema version is unsupported");
    }
    const subjectIntegrity = validateCommandSubjectIntegrity(decision.subject);
    if (!subjectIntegrity.valid) {
      errors.push("governance decision contains an invalid command subject");
    } else if (decision.subject_hash !== decision.subject.subject_hash) {
      errors.push("governance decision subject hash does not match its subject");
    }
    try {
      if (computeStableHash(normalizeActorIdentity(decision.actor)) !== computeStableHash(decision.actor)) {
        errors.push("governance decision actor is not in canonical identity form");
      }
      if (decision.actor_identity_hash !== computeActorIdentityHash(decision.actor)) {
        errors.push("governance decision actor identity hash does not match its actor");
      }
    } catch (error) {
      errors.push(error.message);
    }
    if (decision.decision === "allow") {
      if (!isPlainRecord(decision.grant) || !decision.valid_until) {
        errors.push("an allow decision requires a grant and validity boundary");
      }
    } else if (decision.decision === "deny") {
      if (decision.grant !== null || decision.valid_until !== null) {
        errors.push("a deny decision must not carry a grant");
      }
    } else {
      errors.push("governance decision must be allow or deny");
    }
  }
  return immutableJson({ valid: errors.length === 0, expected_hash: basic.expected_hash, errors: uniqueStrings(errors) });
}

/** Creates immutable proof that one still-valid allow decision was consumed. */
export function createGovernanceUseReceipt(input, dependencies = {}) {
  requirePlainRecord(input, "governance_use");
  const decision = assertDecisionIntegrity(input.decision);
  if (decision.decision !== "allow") {
    throw new DomainValidationError("a denied governance decision cannot be used");
  }
  const usedAt = resolveInjectedInstant(input.used_at, dependencies.now, "governance_use.used_at");
  const id = resolveInjectedId(input.receipt_id ?? input.id, dependencies.id, "governance_use.receipt_id", "use_receipt");
  if (usedAt < decision.evaluated_at) {
    throw new DomainValidationError("governance_use.used_at must not be earlier than the decision");
  }
  if (decision.valid_until === null || usedAt >= decision.valid_until) {
    throw new DomainValidationError("governance decision expired before use");
  }
  const revocations = normalizeRevocations(input.revocations ?? []);
  const policy = assertPolicyIntegrity(input.policy);
  const replayedDecision = evaluateGovernancePolicy({
    policy,
    subject: decision.subject,
    actor: decision.actor,
    approvals: input.approvals ?? [],
    revocations,
    evaluated_at: decision.evaluated_at,
    decision_id: decision.id,
  });
  if (replayedDecision.decision_hash !== decision.decision_hash) {
    throw new DomainValidationError("governance decision does not replay from the supplied policy and approvals");
  }
  const protectedRefs = [
    decision.policy_ref,
    hashedRef("decision", decision.id, decision.decision_hash),
    decision.grant.rule_ref,
    ...decision.grant.actor_binding_refs,
    ...decision.grant.approval_refs.map((approval) => hashedRef("approval", approval.id, approval.hash)),
    ...decision.grant.approval_refs.flatMap((approval) => approval.binding_refs),
  ];
  if (protectedRefs.some((ref) => isTargetRevoked(ref, revocations, usedAt))) {
    throw new DomainValidationError("governance decision or one of its grants was revoked before use");
  }
  const evidenceRefs = normalizeExactRefs(input.evidence_refs ?? [], "governance_use.evidence_refs", { requireHash: true });
  const base = {
    kind: "governance_policy_use_receipt",
    schema_version: GOVERNANCE_POLICY_USE_RECEIPT_V1,
    version: 1,
    id,
    decision_ref: hashedRef("decision", decision.id, decision.decision_hash),
    policy_ref: decision.policy_ref,
    subject_hash: decision.subject_hash,
    action: decision.subject.command.action,
    actor: decision.actor,
    actor_identity_hash: decision.actor_identity_hash,
    decision_evaluated_at: decision.evaluated_at,
    decision_valid_until: decision.valid_until,
    used_at: usedAt,
    evidence_refs: evidenceRefs,
  };
  return immutableJson({
    ...base,
    receipt_hash: computeGovernanceUseReceiptHash(base),
    hash_algorithm: STABLE_JSON_HASH_ALGORITHM,
  });
}

export const createGovernancePolicyUseReceipt = createGovernanceUseReceipt;

export function computeGovernanceUseReceiptHash(receipt) {
  requirePlainRecord(receipt, "governance_use_receipt");
  return computeStableHash(omitKeys(receipt, ["receipt_hash", "hash_algorithm"]));
}

export function validateGovernanceUseReceiptIntegrity(receipt) {
  const basic = validateStableSnapshot(receipt, {
    label: "governance use receipt",
    hashField: "receipt_hash",
    computeHash: computeGovernanceUseReceiptHash,
    allowedKeys: USE_RECEIPT_FIELDS,
  });
  const errors = [...basic.errors];
  if (isPlainRecord(receipt)) {
    if (receipt.kind !== "governance_policy_use_receipt"
      || receipt.schema_version !== GOVERNANCE_POLICY_USE_RECEIPT_V1
      || receipt.version !== 1) {
      errors.push("governance use receipt schema version is unsupported");
    }
    try {
      if (computeStableHash(normalizeActorIdentity(receipt.actor)) !== computeStableHash(receipt.actor)) {
        errors.push("governance use receipt actor is not in canonical identity form");
      }
      if (receipt.actor_identity_hash !== computeActorIdentityHash(receipt.actor)) {
        errors.push("governance use receipt actor identity hash does not match its actor");
      }
      if (normalizeIsoInstant(receipt.used_at, "governance_use_receipt.used_at") < normalizeIsoInstant(receipt.decision_evaluated_at, "governance_use_receipt.decision_evaluated_at")) {
        errors.push("governance use receipt predates its decision");
      }
      if (normalizeIsoInstant(receipt.used_at, "governance_use_receipt.used_at") >= normalizeIsoInstant(receipt.decision_valid_until, "governance_use_receipt.decision_valid_until")) {
        errors.push("governance use receipt is later than its decision validity boundary");
      }
      const evidenceRefs = normalizeExactRefs(receipt.evidence_refs, "governance_use_receipt.evidence_refs", { requireHash: true });
      if (computeStableHash(evidenceRefs) !== computeStableHash(receipt.evidence_refs)) {
        errors.push("governance use receipt evidence references are not canonical");
      }
      normalizeHashedRef(receipt.decision_ref, "governance_use_receipt.decision_ref");
      normalizeHashedRef(receipt.policy_ref, "governance_use_receipt.policy_ref");
    } catch (error) {
      errors.push(error.message);
    }
  }
  return immutableJson({ valid: errors.length === 0, expected_hash: basic.expected_hash, errors: uniqueStrings(errors) });
}

export function createGovernanceRevocation(input, dependencies = {}) {
  requirePlainRecord(input, "governance_revocation");
  const effectiveAt = resolveInjectedInstant(
    input.effective_at,
    dependencies.now,
    "governance_revocation.effective_at",
  );
  const createdAt = input.created_at === undefined
    ? effectiveAt
    : normalizeIsoInstant(input.created_at, "governance_revocation.created_at");
  if (createdAt > effectiveAt) {
    throw new DomainValidationError("governance_revocation.created_at must not be later than effective_at");
  }
  const id = resolveInjectedId(input.id, dependencies.id, "governance_revocation.id", "revocation");
  const target = normalizeHashedRef(input.target, "governance_revocation.target");
  if (!REVOCATION_TARGETS.has(target.kind)) {
    throw new DomainValidationError(`governance_revocation.target.kind '${target.kind}' is unsupported`);
  }
  const base = {
    kind: "governance_policy_revocation",
    schema_version: GOVERNANCE_POLICY_REVOCATION_V1,
    version: 1,
    id,
    target,
    effective_at: effectiveAt,
    reason: requireNonEmptyString(input.reason, "governance_revocation.reason"),
    revoked_by: normalizeActorIdentity(input.revoked_by, "governance_revocation.revoked_by"),
    created_at: createdAt,
  };
  return immutableJson({
    ...base,
    revocation_hash: computeGovernanceRevocationHash(base),
    hash_algorithm: STABLE_JSON_HASH_ALGORITHM,
  });
}

export const createGovernancePolicyRevocation = createGovernanceRevocation;

export function computeGovernanceRevocationHash(revocation) {
  requirePlainRecord(revocation, "governance_revocation");
  return computeStableHash(omitKeys(revocation, ["revocation_hash", "hash_algorithm"]));
}

export function validateGovernanceRevocationIntegrity(revocation) {
  const basic = validateStableSnapshot(revocation, {
    label: "governance revocation",
    hashField: "revocation_hash",
    computeHash: computeGovernanceRevocationHash,
    normalize: (value) => createGovernanceRevocation(value),
  });
  const errors = [...basic.errors];
  if (isPlainRecord(revocation)) {
    if (revocation.kind !== "governance_policy_revocation"
      || revocation.schema_version !== GOVERNANCE_POLICY_REVOCATION_V1
      || revocation.version !== 1) {
      errors.push("governance revocation schema version is unsupported");
    }
    try {
      const target = normalizeHashedRef(revocation.target, "governance_revocation.target");
      if (!REVOCATION_TARGETS.has(target.kind)) {
        errors.push("governance revocation target kind is unsupported");
      }
      normalizeActorIdentity(revocation.revoked_by, "governance_revocation.revoked_by");
      const createdAt = normalizeIsoInstant(revocation.created_at, "governance_revocation.created_at");
      const effectiveAt = normalizeIsoInstant(revocation.effective_at, "governance_revocation.effective_at");
      if (createdAt > effectiveAt) {
        errors.push("governance revocation was created after its effective time");
      }
    } catch (error) {
      errors.push(error.message);
    }
  }
  return immutableJson({ valid: errors.length === 0, expected_hash: basic.expected_hash, errors: uniqueStrings(errors) });
}

function normalizePolicyBase(input) {
  requirePlainRecord(input, "governance_policy");
  const validFrom = normalizeIsoInstant(input.valid_from, "governance_policy.valid_from");
  const expiresAt = normalizeNullableInstant(input.expires_at, "governance_policy.expires_at");
  assertWindow(validFrom, expiresAt, "governance_policy");
  const createdAt = input.created_at === undefined
    ? validFrom
    : normalizeIsoInstant(input.created_at, "governance_policy.created_at");
  if (createdAt > validFrom) {
    throw new DomainValidationError("governance_policy.created_at must not be later than valid_from");
  }
  const decisionTtlSeconds = normalizeInteger(
    input.decision_ttl_seconds ?? 300,
    "governance_policy.decision_ttl_seconds",
    1,
    86_400,
  );
  const bindings = normalizeRoleBindings(input.role_bindings ?? [], validFrom, expiresAt);
  const rules = normalizeRules(input.rules ?? [], validFrom, expiresAt);
  assertUniqueIds(bindings, "governance_policy.role_bindings");
  assertUniqueIds(rules, "governance_policy.rules");
  return {
    kind: "governance_policy",
    schema_version: GOVERNANCE_POLICY_V1,
    version: 1,
    id: normalizeReferenceId(input.id, "governance_policy.id"),
    status: "active",
    valid_from: validFrom,
    expires_at: expiresAt,
    decision_ttl_seconds: decisionTtlSeconds,
    role_bindings: bindings,
    rules,
    created_at: createdAt,
  };
}

function normalizeRoleBindings(values, policyValidFrom, policyExpiresAt) {
  if (!Array.isArray(values)) {
    throw new DomainValidationError("governance_policy.role_bindings must be an array");
  }
  const result = values.map((raw, index) => {
    requirePlainRecord(raw, `governance_policy.role_bindings[${index}]`);
    const validFrom = raw.valid_from === undefined
      ? policyValidFrom
      : normalizeIsoInstant(raw.valid_from, `governance_policy.role_bindings[${index}].valid_from`);
    const expiresAt = raw.expires_at === undefined
      ? policyExpiresAt
      : normalizeNullableInstant(raw.expires_at, `governance_policy.role_bindings[${index}].expires_at`);
    assertNestedWindow(validFrom, expiresAt, policyValidFrom, policyExpiresAt, `governance_policy.role_bindings[${index}]`);
    return immutableJson({
      id: normalizeReferenceId(raw.id, `governance_policy.role_bindings[${index}].id`),
      role: normalizeExactName(raw.role, `governance_policy.role_bindings[${index}].role`),
      actor: normalizeActorIdentity(raw.actor, `governance_policy.role_bindings[${index}].actor`),
      valid_from: validFrom,
      expires_at: expiresAt,
    });
  });
  return immutableJson(result.sort((left, right) => compareCanonicalStrings(left.id, right.id)));
}

function normalizeRules(values, policyValidFrom, policyExpiresAt) {
  if (!Array.isArray(values)) {
    throw new DomainValidationError("governance_policy.rules must be an array");
  }
  const result = values.map((raw, index) => {
    const label = `governance_policy.rules[${index}]`;
    requirePlainRecord(raw, label);
    const effect = requireNonEmptyString(raw.effect, `${label}.effect`).toLowerCase();
    if (effect !== "allow" && effect !== "deny") {
      throw new DomainValidationError(`${label}.effect must be allow or deny`);
    }
    const validFrom = raw.valid_from === undefined
      ? policyValidFrom
      : normalizeIsoInstant(raw.valid_from, `${label}.valid_from`);
    const expiresAt = raw.expires_at === undefined
      ? policyExpiresAt
      : normalizeNullableInstant(raw.expires_at, `${label}.expires_at`);
    assertNestedWindow(validFrom, expiresAt, policyValidFrom, policyExpiresAt, label);
    const actorRoles = normalizeNames(raw.actor_roles ?? [], `${label}.actor_roles`);
    if (effect === "allow" && actorRoles.length === 0) {
      throw new DomainValidationError(`${label}.actor_roles must contain at least one role for an allow rule`);
    }
    const quorum = normalizeQuorum(raw.quorum, `${label}.quorum`);
    const separationOfDuties = normalizeSeparationOfDuties(
      raw.separation_of_duties ?? [],
      `${label}.separation_of_duties`,
    );
    if (effect === "deny" && (quorum !== null || separationOfDuties.length > 0)) {
      throw new DomainValidationError(`${label} deny rules must not depend on quorum or separation-of-duties checks`);
    }
    if (effect === "allow" && separationOfDuties.length > 0 && quorum === null) {
      throw new DomainValidationError(`${label}.separation_of_duties requires a quorum`);
    }
    return immutableJson({
      id: normalizeReferenceId(raw.id, `${label}.id`),
      effect,
      action: normalizeExactName(raw.action, `${label}.action`),
      scope_refs: normalizeExactRefs(raw.scope_refs ?? [], `${label}.scope_refs`),
      evidence_refs: normalizeExactRefs(raw.evidence_refs ?? [], `${label}.evidence_refs`, { requireHash: true }),
      actor_roles: actorRoles,
      quorum,
      separation_of_duties: separationOfDuties,
      valid_from: validFrom,
      expires_at: expiresAt,
    });
  });
  return immutableJson(result.sort((left, right) => compareCanonicalStrings(left.id, right.id)));
}

function normalizeQuorum(raw, label) {
  if (raw === undefined || raw === null) {
    return null;
  }
  requirePlainRecord(raw, label);
  const roles = normalizeNames(raw.roles ?? [], `${label}.roles`);
  if (roles.length === 0) {
    throw new DomainValidationError(`${label}.roles must contain at least one role`);
  }
  if (raw.distinct_identities !== undefined && raw.distinct_identities !== true) {
    throw new DomainValidationError(`${label}.distinct_identities must be true`);
  }
  return immutableJson({
    minimum: normalizeInteger(raw.minimum, `${label}.minimum`, 1, 32),
    roles,
    distinct_identities: true,
  });
}

function normalizeSeparationOfDuties(values, label) {
  if (!Array.isArray(values)) {
    throw new DomainValidationError(`${label} must be an array`);
  }
  const entries = values.map((raw, index) => {
    requirePlainRecord(raw, `${label}[${index}]`);
    const leftRole = normalizeExactName(raw.left_role, `${label}[${index}].left_role`);
    const rightRole = normalizeExactName(raw.right_role, `${label}[${index}].right_role`);
    if (leftRole === rightRole) {
      throw new DomainValidationError(`${label}[${index}] roles must be distinct`);
    }
    return immutableJson({ left_role: leftRole, right_role: rightRole });
  });
  const deduped = new Map(entries.map((entry) => [`${entry.left_role}\u0000${entry.right_role}`, entry]));
  if (deduped.size !== entries.length) {
    throw new DomainValidationError(`${label} must not contain duplicate constraints`);
  }
  return immutableJson(Array.from(deduped.values()).sort((left, right) => compareCanonicalStrings(
    `${left.left_role}\u0000${left.right_role}`,
    `${right.left_role}\u0000${right.right_role}`,
  )));
}

function normalizeApprovals(values) {
  if (!Array.isArray(values)) {
    throw new DomainValidationError("governance_evaluation.approvals must be an array");
  }
  const approvals = values.map((raw, index) => {
    const label = `governance_evaluation.approvals[${index}]`;
    requirePlainRecord(raw, label);
    const base = {
      id: normalizeReferenceId(raw.id, `${label}.id`),
      actor: normalizeActorIdentity(raw.actor, `${label}.actor`),
      subject_hash: normalizeSha256(raw.subject_hash, `${label}.subject_hash`),
      approved_at: normalizeIsoInstant(raw.approved_at, `${label}.approved_at`),
      expires_at: normalizeNullableInstant(raw.expires_at, `${label}.expires_at`),
      evidence_ref: normalizeGovernanceRef(raw.evidence_ref, `${label}.evidence_ref`, { requireHash: true }),
    };
    assertWindow(base.approved_at, base.expires_at, label);
    const hash = computeStableHash(base);
    if (raw.approval_hash !== undefined && normalizeSha256(raw.approval_hash, `${label}.approval_hash`) !== hash) {
      throw new DomainValidationError(`${label}.approval_hash does not match its content`);
    }
    return immutableJson({ ...base, approval_hash: hash });
  });
  assertUniqueIds(approvals, "governance_evaluation.approvals");
  return immutableJson(approvals.sort((left, right) => compareCanonicalStrings(left.id, right.id)));
}

function evaluateAllowRule(context) {
  const {
    policy,
    rule,
    actor,
    actorBindings,
    actorRoles,
    subject,
    approvals,
    revocations,
    evaluatedAt,
  } = context;
  const reasons = new Set();
  const qualifyingActorBindings = actorBindings.filter((binding) => rule.actor_roles.includes(binding.role));
  if (!intersects(rule.actor_roles, actorRoles)) {
    reasons.add("actor.role_not_bound");
  }

  const approvalParticipants = [];
  if (rule.quorum !== null) {
    for (const approval of approvals) {
      if (approval.subject_hash !== subject.subject_hash
        || !isActiveWindow(approval.approved_at, approval.expires_at, evaluatedAt)
        || isTargetRevoked(approvalRef(approval), revocations, evaluatedAt)) {
        continue;
      }
      const allBindings = activeBindingsForActor(policy, approval.actor, revocations, evaluatedAt);
      const bindings = allBindings.filter((binding) => rule.quorum.roles.includes(binding.role));
      if (bindings.length === 0) {
        continue;
      }
      approvalParticipants.push({
        approval,
        bindings,
        roles: uniqueStrings(allBindings.map((binding) => binding.role)),
      });
    }
    const distinct = new Map();
    for (const participant of approvalParticipants) {
      const identityHash = computeActorIdentityHash(participant.approval.actor);
      if (!distinct.has(identityHash)) {
        distinct.set(identityHash, participant);
      }
    }
    if (distinct.size < rule.quorum.minimum) {
      reasons.add("quorum.distinct_identities_not_met");
    }
  }

  if (reasons.size === 0 && rule.separation_of_duties.length > 0) {
    const participants = [
      { identity_hash: computeActorIdentityHash(actor), roles: actorRoles },
      ...approvalParticipants.map(({ approval, roles }) => ({
        identity_hash: computeActorIdentityHash(approval.actor),
        roles,
      })),
    ];
    for (const constraint of rule.separation_of_duties) {
      const left = new Set(participants.filter(({ roles }) => roles.includes(constraint.left_role)).map(({ identity_hash }) => identity_hash));
      const right = new Set(participants.filter(({ roles }) => roles.includes(constraint.right_role)).map(({ identity_hash }) => identity_hash));
      if (Array.from(left).some((identity) => right.has(identity))) {
        reasons.add("separation_of_duties.identity_overlap");
      }
    }
  }

  if (reasons.size > 0) {
    return immutableJson({ allowed: false, reason_codes: uniqueStrings(Array.from(reasons)), grant: null });
  }

  const distinctApprovals = new Map();
  for (const participant of approvalParticipants) {
    const identityHash = computeActorIdentityHash(participant.approval.actor);
    if (!distinctApprovals.has(identityHash)) {
      distinctApprovals.set(identityHash, participant);
    }
  }
  const selectedApprovals = rule.quorum === null
    ? []
    : Array.from(distinctApprovals.values()).slice(0, rule.quorum.minimum);
  const grant = immutableJson({
    rule_ref: ruleRef(rule),
    actor_binding_refs: qualifyingActorBindings.map(bindingRef).sort(compareHashedRefs),
    approval_refs: selectedApprovals.map(({ approval, bindings }) => immutableJson({
      id: approval.id,
      hash: approval.approval_hash,
      actor: approval.actor,
      actor_identity_hash: computeActorIdentityHash(approval.actor),
      evidence_ref: approval.evidence_ref,
      approved_at: approval.approved_at,
      expires_at: approval.expires_at,
      binding_refs: bindings.map(bindingRef).sort(compareHashedRefs),
    })),
    rule_expires_at: rule.expires_at,
    binding_expires_at: qualifyingActorBindings.map((binding) => binding.expires_at),
    approval_expires_at: selectedApprovals.map(({ approval }) => approval.expires_at),
  });
  return immutableJson({ allowed: true, reason_codes: [], grant });
}

function computeGrantValidUntil(policy, grant, evaluatedAt) {
  const ttlBoundary = new Date(Date.parse(evaluatedAt) + (policy.decision_ttl_seconds * 1000)).toISOString();
  const candidates = [
    ttlBoundary,
    policy.expires_at,
    grant.rule_expires_at,
    ...grant.binding_expires_at,
    ...grant.approval_expires_at,
  ].filter((value) => value !== null);
  return candidates.sort(compareCanonicalStrings)[0];
}

function activeBindingsForActor(policy, actor, revocations, at) {
  const identityHash = computeActorIdentityHash(actor);
  return policy.role_bindings.filter((binding) => (
    computeActorIdentityHash(binding.actor) === identityHash
    && isActiveWindow(binding.valid_from, binding.expires_at, at)
    && !isTargetRevoked(bindingRef(binding), revocations, at)
  ));
}

function normalizeRevocations(values) {
  if (!Array.isArray(values)) {
    throw new DomainValidationError("governance revocations must be an array");
  }
  return immutableJson(values.map((revocation, index) => {
    const integrity = validateGovernanceRevocationIntegrity(revocation);
    if (!integrity.valid) {
      throw new DomainValidationError(`governance revocation ${index} is invalid: ${integrity.errors.join("; ")}`);
    }
    return immutableJson(revocation);
  }).sort((left, right) => compareCanonicalStrings(left.id, right.id)));
}

function isTargetRevoked(reference, revocations, at) {
  return revocations.some((revocation) => (
    revocation.effective_at <= at
    && revocation.target.kind === reference.kind
    && revocation.target.id === reference.id
    && revocation.target.hash === reference.hash
  ));
}

function assertPolicyIntegrity(policy) {
  const integrity = validateGovernancePolicyIntegrity(policy);
  if (!integrity.valid) {
    throw new DomainValidationError(`governance policy is invalid: ${integrity.errors.join("; ")}`);
  }
  return immutableJson(policy);
}

function assertSubjectIntegrity(subject) {
  const integrity = validateCommandSubjectIntegrity(subject);
  if (!integrity.valid) {
    throw new DomainValidationError(`governance command subject is invalid: ${integrity.errors.join("; ")}`);
  }
  return immutableJson(subject);
}

function assertDecisionIntegrity(decision) {
  const integrity = validateGovernanceDecisionIntegrity(decision);
  if (!integrity.valid) {
    throw new DomainValidationError(`governance decision is invalid: ${integrity.errors.join("; ")}`);
  }
  return immutableJson(decision);
}

function validateStableSnapshot(value, options) {
  const errors = [];
  if (!isPlainRecord(value)) {
    return immutableJson({ valid: false, expected_hash: null, errors: [`${options.label} must be a plain object`] });
  }
  let expectedHash = null;
  try {
    if (options.allowedKeys) {
      const unknownKeys = Object.keys(value).filter((key) => !options.allowedKeys.has(key));
      if (unknownKeys.length > 0) {
        errors.push(`${options.label} contains unsupported fields`);
      }
    }
    expectedHash = options.computeHash(value);
    if (value[options.hashField] !== expectedHash) {
      errors.push(`${options.label} hash does not match its content`);
    }
    if (value.hash_algorithm !== STABLE_JSON_HASH_ALGORITHM) {
      errors.push(`${options.label} hash algorithm is invalid`);
    }
    if (options.normalize) {
      const normalized = options.normalize(value);
      if (computeStableHash(normalized) !== computeStableHash(value)) {
        errors.push(`${options.label} is not in canonical form`);
      }
    }
  } catch (error) {
    errors.push(error.message);
  }
  return immutableJson({ valid: errors.length === 0, expected_hash: expectedHash, errors: uniqueStrings(errors) });
}

function ruleRef(rule) {
  return hashedRef("rule", rule.id, computeStableHash(rule));
}

function bindingRef(binding) {
  return hashedRef("role_binding", binding.id, computeStableHash(binding));
}

function approvalRef(approval) {
  return hashedRef("approval", approval.id, approval.approval_hash);
}

function hashedRef(kind, id, hash) {
  return immutableJson({ kind, id, hash });
}

function normalizeHashedRef(raw, label) {
  return normalizeGovernanceRef(raw, label, { requireHash: true });
}

function compareHashedRefs(left, right) {
  return compareCanonicalStrings(`${left.kind}\u0000${left.id}\u0000${left.hash}`, `${right.kind}\u0000${right.id}\u0000${right.hash}`);
}

function exactRuleTargetKey(rule) {
  return exactTargetKey(rule.action, rule.scope_refs, rule.evidence_refs);
}

function exactTargetKey(action, scopeRefs, evidenceRefs) {
  return computeStableHash({ action, scope_refs: scopeRefs, evidence_refs: evidenceRefs });
}

function isActiveWindow(validFrom, expiresAt, at) {
  return at >= validFrom && (expiresAt === null || at < expiresAt);
}

function assertNestedWindow(validFrom, expiresAt, parentValidFrom, parentExpiresAt, label) {
  assertWindow(validFrom, expiresAt, label);
  if (validFrom < parentValidFrom || (parentExpiresAt !== null && (expiresAt === null || expiresAt > parentExpiresAt))) {
    throw new DomainValidationError(`${label} validity must stay within its policy validity`);
  }
}

function assertWindow(validFrom, expiresAt, label) {
  if (expiresAt !== null && expiresAt <= validFrom) {
    throw new DomainValidationError(`${label}.expires_at must be later than valid_from`);
  }
}

function normalizeNullableInstant(value, label) {
  return value === undefined || value === null ? null : normalizeIsoInstant(value, label);
}

function resolveInjectedInstant(explicit, injected, label) {
  let value = explicit;
  if (value === undefined || value === null) {
    if (typeof injected !== "function") {
      throw new DomainValidationError(`${label} is required unless a time provider is injected`);
    }
    value = injected();
  }
  return normalizeIsoInstant(value, label);
}

function resolveInjectedId(explicit, injected, label, kind) {
  let value = explicit;
  if (value === undefined || value === null) {
    if (typeof injected !== "function") {
      throw new DomainValidationError(`${label} is required unless an id provider is injected`);
    }
    value = injected(kind);
  }
  return normalizeReferenceId(value, label);
}

function normalizeInteger(value, label, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new DomainValidationError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function normalizeExactName(value, label) {
  const normalized = requireNonEmptyString(value, label).toLowerCase();
  if (!EXACT_NAME_PATTERN.test(normalized)) {
    throw new DomainValidationError(`${label} must be an exact lowercase name without wildcards`);
  }
  return normalized;
}

function normalizeReferenceId(value, label) {
  const normalized = requireNonEmptyString(value, label);
  if (!REFERENCE_ID_PATTERN.test(normalized)) {
    throw new DomainValidationError(`${label} must be a safe exact reference id`);
  }
  return normalized;
}

function normalizeNames(values, label) {
  if (!Array.isArray(values)) {
    throw new DomainValidationError(`${label} must be an array`);
  }
  return immutableJson(uniqueStrings(values.map((value, index) => normalizeExactName(value, `${label}[${index}]`))));
}

function normalizeSha256(value, label) {
  const normalized = requireNonEmptyString(value, label).toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) {
    throw new DomainValidationError(`${label} must be a lowercase SHA-256 digest`);
  }
  return normalized;
}

function assertUniqueIds(values, label) {
  const ids = new Set();
  for (const value of values) {
    if (ids.has(value.id)) {
      throw new DomainValidationError(`${label} contains duplicate id '${value.id}'`);
    }
    ids.add(value.id);
  }
}

function uniqueStrings(values) {
  return Array.from(new Set(values)).sort(compareCanonicalStrings);
}

function intersects(left, right) {
  const rightSet = new Set(right);
  return left.some((value) => rightSet.has(value));
}
