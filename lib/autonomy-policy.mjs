import path from "node:path";

import {
  DomainValidationError,
  STABLE_JSON_HASH_ALGORITHM,
  cloneJson,
  compareCanonicalStrings,
  computeStableHash,
  immutableJson,
  isPlainRecord,
  normalizeIsoInstant,
  normalizeStringList,
  omitKeys,
  requireNonEmptyString,
  requirePlainRecord,
} from "./canonical.mjs";

export const AUTONOMY_LEVELS = Object.freeze([
  "supervised",
  "checkpointed",
  "bounded-autonomous",
]);

export const DELIVERY_KINDS = Object.freeze(["pull_request", "local_release"]);

export const SDLC_PHASES = Object.freeze([
  "discovery",
  "analysis",
  "design",
  "implementation",
  "validation",
  "release",
]);

const PHASE_IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;

export const MATERIAL_DRIFT_FIELDS = Object.freeze([
  "objective",
  "scope",
  "non_goals",
  "acceptance_criteria",
  "nfrs",
  "integrations",
  "data_sensitivity",
  "environment",
  "write_paths",
  "capabilities",
  "budget",
  "release_target",
  "external_or_production_access",
]);

export const AUTONOMY_LEVEL_RANK = Object.freeze(
  Object.fromEntries(AUTONOMY_LEVELS.map((level, index) => [level, index])),
);

const LEVEL_RANK = new Map(AUTONOMY_LEVELS.map((level, index) => [level, index]));
const TERMINAL_DELIVERY_STATES = new Set([
  "cancelled",
  "closed",
  "merged",
  "released",
  "revoked",
  "rolled_back",
  "superseded",
  "terminal",
]);
const NON_MATERIAL_KEYS = new Set([
  "approval_ref",
  "audit",
  "created_at",
  "hash",
  "hash_algorithm",
  "id",
  "kind",
  "path",
  "profile_hash",
  "schema_version",
  "source_hashes",
  "source_paths",
  "status",
  "title",
  "updated_at",
  "version",
]);
const MATERIAL_ALIASES = Object.freeze({
  objective: ["objective", "summary"],
  scope: ["scope"],
  non_goals: ["non_goals", "nonGoals"],
  acceptance_criteria: ["acceptance_criteria", "acceptanceCriteria"],
  nfrs: ["nfrs", "non_functional_requirements", "nonFunctionalRequirements"],
  integrations: ["integrations"],
  data_sensitivity: ["data_sensitivity", "dataSensitivity"],
  environment: ["environment", "environments"],
  write_paths: ["write_paths", "allowed_write_paths", "kb_writes"],
  capabilities: ["capabilities", "allowed_capabilities", "allowed_tools"],
  budget: ["budget", "budget_ref", "execution_budget_ref"],
  release_target: ["release_target", "delivery_target", "target"],
  external_or_production_access: [
    "external_or_production_access",
    "external_access",
    "production_access",
  ],
});

export function normalizeAutonomyLevel(value, label = "autonomy_level") {
  const level = requireNonEmptyString(value, label);
  if (!LEVEL_RANK.has(level)) {
    throw new DomainValidationError(
      `${label} must be one of ${AUTONOMY_LEVELS.join(", ")}`,
    );
  }
  return level;
}

export function compareAutonomyLevels(left, right) {
  return LEVEL_RANK.get(normalizeAutonomyLevel(left, "left_level"))
    - LEVEL_RANK.get(normalizeAutonomyLevel(right, "right_level"));
}

export function mostRestrictiveAutonomyLevel(...values) {
  const flattened = values.flat(Infinity).filter((value) => value !== undefined && value !== null);
  if (flattened.length === 0) {
    return "supervised";
  }
  return flattened
    .map((value, index) => normalizeAutonomyLevel(value, `levels[${index}]`))
    .reduce((current, candidate) => (
      compareAutonomyLevels(candidate, current) < 0 ? candidate : current
    ));
}

export function isAutonomyNarrowing(parentLevel, downstreamLevel) {
  return compareAutonomyLevels(downstreamLevel, parentLevel) <= 0;
}

/** Hash exact canonical content. Callers choose the immutable subject fields. */
export function hashAutonomySubject(subject) {
  if (subject === undefined) {
    throw new DomainValidationError("autonomy subject is required");
  }
  return computeStableHash(subject);
}

export function snapshotMaterialScope(input) {
  const source = requirePlainRecord(
    isPlainRecord(input?.material_scope) ? input.material_scope : input,
    "material_scope",
  );
  const result = {};
  const consumed = new Set();
  for (const [canonical, aliases] of Object.entries(MATERIAL_ALIASES)) {
    const alias = aliases.find((candidate) => source[candidate] !== undefined);
    for (const candidate of aliases) {
      consumed.add(candidate);
    }
    if (alias !== undefined) {
      result[canonical] = cloneJson(source[alias]);
    }
  }
  for (const key of Object.keys(source).sort(compareCanonicalStrings)) {
    if (!consumed.has(key) && !NON_MATERIAL_KEYS.has(key) && source[key] !== undefined) {
      result[key] = cloneJson(source[key]);
    }
  }
  if (Object.keys(result).length === 0) {
    throw new DomainValidationError("material_scope must contain at least one material field");
  }
  return immutableJson(result);
}

export function detectMaterialDrift(approvedInput, currentInput) {
  const approved = snapshotMaterialScope(approvedInput);
  const current = snapshotMaterialScope(currentInput);
  const fields = Array.from(new Set([...Object.keys(approved), ...Object.keys(current)]))
    .sort(compareCanonicalStrings);
  const drift = [];
  for (const field of fields) {
    const approvedValue = Object.hasOwn(approved, field) ? approved[field] : null;
    const currentValue = Object.hasOwn(current, field) ? current[field] : null;
    const approvedHash = computeStableHash(approvedValue);
    const currentHash = computeStableHash(currentValue);
    if (approvedHash !== currentHash) {
      drift.push({
        field,
        reason_code: `material_drift.${normalizeReasonSegment(field)}`,
        approved_hash: approvedHash,
        current_hash: currentHash,
      });
    }
  }
  return immutableJson(drift);
}

export function evaluateHostAuthorityCap(input) {
  if (input === undefined || input === null) {
    return immutableJson({
      max_level: "supervised",
      valid: false,
      reason_codes: ["authority.host_policy_missing"],
    });
  }
  const raw = isPlainRecord(input?.authority_assurance) ? input.authority_assurance : input;
  requirePlainRecord(raw, "host_authority");
  const mode = raw.mode ?? raw.authority_mode;
  if (
    (mode === "host_verified" || raw.source === "ci_attestation")
    && raw.verified === true
    && isPlainRecord(raw.receipt_ref)
  ) {
    return immutableJson({
      max_level: "bounded-autonomous",
      valid: true,
      reason_codes: [],
    });
  }
  if (mode === "audit_only") {
    return immutableJson({
      max_level: "checkpointed",
      valid: true,
      reason_codes: ["authority.audit_only_caps_autonomy"],
    });
  }
  return immutableJson({
    max_level: "supervised",
    valid: false,
    reason_codes: ["authority.host_verification_invalid"],
  });
}

export function buildRequirementExecutionProfile(input) {
  requirePlainRecord(input, "requirement_execution_profile");
  const status = normalizeProfileStatus(input.status);
  const requirementRef = normalizeVersionedHashedRef(
    input.requirement_ref,
    "requirement_execution_profile.requirement_ref",
  );
  const autonomyCeiling = normalizeAutonomyLevel(
    input.autonomy_ceiling,
    "requirement_execution_profile.autonomy_ceiling",
  );
  const materialScope = snapshotMaterialScope(input.material_scope);
  const approvalRef = normalizeNullableHashedRef(
    input.approval_ref,
    "requirement_execution_profile.approval_ref",
  );
  if (status === "active" && !approvalRef) {
    throw new DomainValidationError("active requirement execution profiles require approval_ref");
  }
  const createdAt = normalizeRequiredTimestamp(input.created_at ?? input.now, "created_at");
  const updatedAt = normalizeRequiredTimestamp(input.updated_at ?? createdAt, "updated_at");
  const validFrom = normalizeRequiredTimestamp(input.valid_from ?? createdAt, "valid_from");
  const expiresAt = normalizeNullableTimestamp(input.expires_at, "expires_at");
  assertValidWindow(validFrom, expiresAt);
  const profile = {
    kind: "requirement_execution_profile",
    schema_version: "requirement-execution-profile:v1",
    version: normalizePositiveInteger(input.version, 1, "version"),
    id: requireNonEmptyString(input.id, "requirement_execution_profile.id"),
    status,
    requirement_ref: requirementRef,
    autonomy_ceiling: autonomyCeiling,
    phase_levels: normalizePhaseLevels(input.phase_levels, autonomyCeiling, "phase_levels"),
    material_scope: materialScope,
    material_scope_hash: computeStableHash(materialScope),
    constraints: normalizeConstraints(input.constraints),
    checkpoints: normalizeStringList(input.checkpoints, "checkpoints"),
    exception_actions: normalizeStringList(
      input.exception_actions ?? defaultExceptionActions(),
      "exception_actions",
    ),
    authority_assurance: normalizeAuthorityAssurance(input.authority_assurance, approvalRef),
    approval_ref: approvalRef,
    valid_from: validFrom,
    expires_at: expiresAt,
    created_at: createdAt,
    updated_at: updatedAt,
    extensions: normalizeRecord(input.extensions, "extensions"),
  };
  return immutableJson({
    ...profile,
    profile_hash: computeRequirementExecutionProfileHash(profile),
    hash_algorithm: STABLE_JSON_HASH_ALGORITHM,
  });
}

export function computeRequirementExecutionProfileHash(profile) {
  requirePlainRecord(profile, "requirement_execution_profile");
  return computeStableHash(omitKeys(profile, ["profile_hash", "hash_algorithm"]));
}

export function validateRequirementExecutionProfileIntegrity(profile) {
  return validateProfileIntegrity(
    profile,
    "requirement_execution_profile",
    "requirement-execution-profile:v1",
    computeRequirementExecutionProfileHash,
    buildRequirementExecutionProfile,
  );
}

export function buildDeliveryExecutionProfile(input) {
  requirePlainRecord(input, "delivery_execution_profile");
  const status = normalizeProfileStatus(input.status);
  const requestedLevel = normalizeAutonomyLevel(
    input.requested_level,
    "delivery_execution_profile.requested_level",
  );
  const deliveryKind = requireNonEmptyString(input.delivery_kind, "delivery_execution_profile.delivery_kind");
  if (!DELIVERY_KINDS.includes(deliveryKind)) {
    throw new DomainValidationError(
      `delivery_execution_profile.delivery_kind must be one of ${DELIVERY_KINDS.join(", ")}`,
    );
  }
  const approvalRef = normalizeNullableHashedRef(
    input.approval_ref,
    "delivery_execution_profile.approval_ref",
  );
  if (status === "active" && !approvalRef) {
    throw new DomainValidationError("active delivery execution profiles require approval_ref");
  }
  const materialScope = snapshotMaterialScope(input.material_scope);
  const createdAt = normalizeRequiredTimestamp(input.created_at ?? input.now, "created_at");
  const updatedAt = normalizeRequiredTimestamp(input.updated_at ?? createdAt, "updated_at");
  const validFrom = normalizeRequiredTimestamp(input.valid_from ?? createdAt, "valid_from");
  const expiresAt = normalizeNullableTimestamp(input.expires_at, "expires_at");
  assertValidWindow(validFrom, expiresAt);
  const pullRequestTarget = deliveryKind === "pull_request"
    ? normalizePullRequestTarget(input.pull_request_target)
    : null;
  const localReleaseTarget = deliveryKind === "local_release"
    ? normalizeLocalReleaseTarget(input.local_release_target)
    : null;
  const constraints = normalizeConstraints(input.constraints);
  const targetActions = pullRequestTarget?.allowed_actions ?? localReleaseTarget?.allowed_actions ?? [];
  const contradictoryActions = targetActions.filter((action) => constraints.forbidden_actions.includes(action));
  if (contradictoryActions.length > 0) {
    throw new DomainValidationError(
      `delivery target actions are also forbidden: ${contradictoryActions.join(", ")}`,
    );
  }
  const profile = {
    kind: "delivery_execution_profile",
    schema_version: "delivery-execution-profile:v1",
    version: normalizePositiveInteger(input.version, 1, "version"),
    id: requireNonEmptyString(input.id, "delivery_execution_profile.id"),
    status,
    delivery_id: requireNonEmptyString(input.delivery_id, "delivery_execution_profile.delivery_id"),
    delivery_kind: deliveryKind,
    requirement_profile_refs: normalizeHashedRefList(
      input.requirement_profile_refs,
      "requirement_profile_refs",
      { minItems: 1 },
    ),
    story_refs: normalizeHashedRefList(input.story_refs, "story_refs", { minItems: 1 }),
    contract_refs: normalizeHashedRefList(input.contract_refs, "contract_refs", { minItems: 1 }),
    material_scope: materialScope,
    material_scope_hash: computeStableHash(materialScope),
    requested_level: requestedLevel,
    phase_levels: normalizePhaseLevels(input.phase_levels, requestedLevel, "phase_levels"),
    constraints,
    checkpoints: normalizeStringList(
      input.checkpoints ?? defaultCheckpoints(requestedLevel, deliveryKind),
      "checkpoints",
    ),
    use_policy: {
      mode: "exact-delivery",
      reusable_across_deliveries: false,
      max_concurrent_runs: 1,
      close_on_terminal: true,
      require_usage_receipt: true,
    },
    pull_request_target: pullRequestTarget,
    local_release_target: localReleaseTarget,
    authority_assurance: normalizeAuthorityAssurance(input.authority_assurance, approvalRef),
    approval_ref: approvalRef,
    valid_from: validFrom,
    expires_at: expiresAt,
    created_at: createdAt,
    updated_at: updatedAt,
    extensions: normalizeRecord(input.extensions, "extensions"),
  };
  return immutableJson({
    ...profile,
    profile_hash: computeDeliveryExecutionProfileHash(profile),
    hash_algorithm: STABLE_JSON_HASH_ALGORITHM,
  });
}

export function buildDeliveryExecutionProfileV2(input) {
  requirePlainRecord(input, "delivery_execution_profile");
  const legacy = buildDeliveryExecutionProfile(input);
  const {
    profile_hash: _legacyProfileHash,
    hash_algorithm: _legacyHashAlgorithm,
    schema_version: _legacySchemaVersion,
    version: _legacyVersion,
    ...shared
  } = legacy;
  const pullRequestTarget = legacy.delivery_kind === "pull_request"
    ? normalizePullRequestTargetV2(input.pull_request_target)
    : null;
  const providerBindings = normalizeDeliveryProviderBindings(
    input.provider_bindings,
    legacy.delivery_kind,
    pullRequestTarget?.mode || "new",
    legacy.local_release_target,
  );
  const profile = {
    ...shared,
    schema_version: "delivery-execution-profile:v2",
    version: 2,
    pull_request_target: pullRequestTarget,
    provider_bindings: providerBindings,
    provider_bindings_hash: computeStableHash(providerBindings),
  };
  return immutableJson({
    ...profile,
    profile_hash: computeDeliveryExecutionProfileHash(profile),
    hash_algorithm: STABLE_JSON_HASH_ALGORITHM,
  });
}

export function computeDeliveryExecutionProfileHash(profile) {
  requirePlainRecord(profile, "delivery_execution_profile");
  return computeStableHash(omitKeys(profile, ["profile_hash", "hash_algorithm"]));
}

export function validateDeliveryExecutionProfileIntegrity(profile) {
  if (profile?.schema_version === "delivery-execution-profile:v2") {
    const result = validateProfileIntegrity(
      profile,
      "delivery_execution_profile",
      "delivery-execution-profile:v2",
      computeDeliveryExecutionProfileHash,
      buildDeliveryExecutionProfileV2,
    );
    const bindingErrors = [];
    try {
      if (profile.provider_bindings_hash !== computeStableHash(profile.provider_bindings)) {
        bindingErrors.push("profile.provider_bindings_hash does not match its exact provider bindings");
      }
    } catch (error) {
      bindingErrors.push(error.message);
    }
    if (bindingErrors.length === 0) return result;
    return immutableJson({
      ...result,
      valid: false,
      errors: Array.from(new Set([...result.errors, ...bindingErrors])),
    });
  }
  return validateProfileIntegrity(
    profile,
    "delivery_execution_profile",
    "delivery-execution-profile:v1",
    computeDeliveryExecutionProfileHash,
    buildDeliveryExecutionProfile,
  );
}

function normalizeDeliveryProviderBindings(
  input,
  deliveryKind,
  pullRequestMode = "new",
  localReleaseTarget = null,
) {
  if (!Array.isArray(input)) {
    throw new DomainValidationError("delivery_execution_profile.provider_bindings must be an explicit array");
  }
  const expectedActions = deliveryKind === "pull_request"
    ? [
        "git.push",
        ...(pullRequestMode === "existing" ? [] : ["pull_request.create"]),
        "pull_request.merge",
        "pull_request.update",
      ]
    : [
        ...(localReleaseTarget?.data_migration
          ? ["data.migrate", "data.rollback"]
          : []),
        "release.local",
        ...(localReleaseTarget?.rollback?.verification_required === true
          ? ["rollback.verify"]
          : []),
      ];
  if (input.length !== expectedActions.length) {
    throw new DomainValidationError(
      `delivery_execution_profile.provider_bindings must bind exactly: ${expectedActions.join(", ")}`,
    );
  }
  const bindings = input.map((item, index) => {
    const source = requirePlainRecord(item, `provider_bindings[${index}]`);
    const unknown = Object.keys(source).filter((key) => !["action", "provider_id"].includes(key));
    if (unknown.length > 0) {
      throw new DomainValidationError(
        `provider_bindings[${index}] contains unsupported fields: ${unknown.sort().join(", ")}`,
      );
    }
    const action = requireNonEmptyString(source.action, `provider_bindings[${index}].action`).toLowerCase();
    const providerId = requireNonEmptyString(
      source.provider_id,
      `provider_bindings[${index}].provider_id`,
    ).toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]*$/u.test(providerId)) {
      throw new DomainValidationError(`provider_bindings[${index}].provider_id is invalid`);
    }
    return { action, provider_id: providerId };
  }).sort((left, right) => compareCanonicalStrings(left.action, right.action));
  if (stableStringList(bindings.map((binding) => binding.action)) !== stableStringList(expectedActions)) {
    throw new DomainValidationError(
      `delivery_execution_profile.provider_bindings must bind exactly: ${expectedActions.join(", ")}`,
    );
  }
  return immutableJson(bindings);
}

function stableStringList(values) {
  return JSON.stringify(values);
}

export function validateLocalReleaseTargetBoundary(target) {
  const reasons = [];
  try {
    normalizeLocalReleaseTarget(target);
  } catch (error) {
    reasons.push(...issueReasonCodes(error, "local_release.target_invalid"));
  }
  return immutableJson({
    valid: reasons.length === 0,
    reason_codes: Array.from(new Set(reasons)).sort(compareCanonicalStrings),
  });
}

export function validatePullRequestTargetBoundary(target) {
  const reasons = [];
  try {
    target?.mode ? normalizePullRequestTargetV2(target) : normalizePullRequestTarget(target);
  } catch (error) {
    reasons.push(...issueReasonCodes(error, "pull_request.target_invalid"));
  }
  return immutableJson({
    valid: reasons.length === 0,
    reason_codes: Array.from(new Set(reasons)).sort(compareCanonicalStrings),
  });
}

/**
 * Resolve autonomy as the most restrictive intersection of every supplied
 * boundary. Requirement and delivery profiles, current refs, delivery state,
 * and the current material scope are mandatory and fail closed when absent.
 */
export function evaluateAutonomyPolicy(input) {
  requirePlainRecord(input, "autonomy_evaluation");
  const evaluatedAt = normalizeRequiredTimestamp(input.evaluated_at ?? input.now, "evaluated_at");
  const phase = normalizeNullablePhase(input.phase);
  const sourceConstraints = [];
  const allReasons = new Set();
  const materialDrift = [];
  let blocked = false;

  const addConstraint = (source, result) => {
    const reasonCodes = normalizeStringList(result.reason_codes, `${source}.reason_codes`);
    for (const reason of reasonCodes) {
      allReasons.add(reason);
    }
    if (result.blocked === true) {
      blocked = true;
    }
    sourceConstraints.push({
      source,
      level: normalizeAutonomyLevel(result.level, `${source}.level`),
      valid: result.valid !== false,
      blocked: result.blocked === true,
      reason_codes: reasonCodes,
    });
  };

  const hostInput = input.host_policy ?? input.host;
  const hostBoundary = evaluateGenericBoundary("host", hostInput, phase, evaluatedAt);
  const authorityCap = evaluateHostAuthorityCap(hostInput);
  addConstraint("host", {
    ...hostBoundary,
    level: mostRestrictiveAutonomyLevel(hostBoundary.level, authorityCap.max_level),
    valid: hostBoundary.valid && authorityCap.valid,
    reason_codes: [...hostBoundary.reason_codes, ...authorityCap.reason_codes],
  });
  addConstraint(
    "project",
    evaluateGenericBoundary("project", input.project_policy ?? input.project, phase, evaluatedAt),
  );

  const requirementProfiles = normalizeArray(
    input.requirement_profiles ?? input.requirements,
    "requirement_profiles",
  );
  const currentRequirements = currentReferenceMap(
    input.current_requirements,
    "current_requirements",
  );
  const requirementLevels = [];
  if (requirementProfiles.length === 0) {
    addConstraint("requirement", missingBoundary("requirement.profile_missing"));
    requirementLevels.push("supervised");
  } else {
    for (const [index, profile] of requirementProfiles.entries()) {
      const source = `requirement:${profile?.id || index}`;
      const result = evaluateRequirementProfile(
        profile,
        currentRequirements,
        phase,
        evaluatedAt,
      );
      requirementLevels.push(result.level);
      for (const item of result.material_drift) {
        materialDrift.push(item);
      }
      addConstraint(source, result);
    }
  }
  const requirementCeiling = mostRestrictiveAutonomyLevel(requirementLevels);

  const deliveryProfile = input.delivery_profile ?? input.delivery;
  const deliveryResult = evaluateDeliveryProfile({
    profile: deliveryProfile,
    requirementProfiles,
    currentStoryRefs: input.current_story_refs,
    currentContractRefs: input.current_contract_refs,
    currentMaterialScope: input.current_delivery_scope,
    deliveryState: input.delivery_state,
    phase,
    evaluatedAt,
  });
  for (const item of deliveryResult.material_drift) {
    materialDrift.push(item);
  }
  addConstraint("delivery", deliveryResult);
  const requestedLevel = deliveryResult.requested_level;
  if (compareAutonomyLevels(requestedLevel, requirementCeiling) > 0) {
    allReasons.add("autonomy.delivery_exceeds_requirement");
  }

  const contractInput = input.contract_policy ?? input.contract;
  const contractResult = evaluateGenericBoundary("contract", contractInput, phase, evaluatedAt);
  const contractRefReasons = validateContractDeliveryBinding(contractInput, deliveryProfile);
  addConstraint("contract", {
    ...contractResult,
    level: contractRefReasons.length > 0 ? "supervised" : contractResult.level,
    valid: contractResult.valid && contractRefReasons.length === 0,
    reason_codes: [...contractResult.reason_codes, ...contractRefReasons],
  });
  if (
    contractInput
    && compareAutonomyLevels(contractResult.level, mostRestrictiveAutonomyLevel(requirementCeiling, requestedLevel)) > 0
  ) {
    allReasons.add("autonomy.contract_exceeds_delivery");
  }

  addConstraint(
    "capability",
    evaluateGenericBoundary("capability", input.capability_policy ?? input.capability, phase, evaluatedAt),
  );
  addConstraint(
    "environment",
    evaluateGenericBoundary("environment", input.environment_policy ?? input.environment, phase, evaluatedAt),
  );
  addConstraint(
    "budget",
    evaluateGenericBoundary("budget", input.budget_policy ?? input.budget, phase, evaluatedAt),
  );

  let effectiveLevel = mostRestrictiveAutonomyLevel(
    sourceConstraints.map((constraint) => constraint.level),
  );
  if (blocked) {
    effectiveLevel = "supervised";
  }
  const executionStatus = blocked
    ? "blocked"
    : effectiveLevel === "supervised"
      ? "approval_required"
      : effectiveLevel === "checkpointed"
        ? "checkpoint_required"
        : "ready";
  const delivery = validDeliveryDecisionRef(deliveryProfile);
  const decisionBase = {
    kind: "autonomy_decision",
    schema_version: "autonomy-decision:v1",
    version: 1,
    id: requireNonEmptyString(
      input.id ?? `AUT-DEC-${computeStableHash({ delivery, phase, evaluatedAt }).slice(0, 16).toUpperCase()}`,
      "autonomy_decision.id",
    ),
    delivery,
    phase,
    requested_level: requestedLevel,
    effective_level: effectiveLevel,
    execution_status: executionStatus,
    requires_human_approval: !blocked && effectiveLevel === "supervised",
    requires_checkpoint: !blocked && effectiveLevel === "checkpointed",
    autonomous: !blocked && effectiveLevel === "bounded-autonomous",
    blocked,
    source_constraints: sourceConstraints,
    reason_codes: Array.from(allReasons).sort(compareCanonicalStrings),
    material_drift: uniqueDrift(materialDrift),
    evaluated_at: evaluatedAt,
  };
  return immutableJson({
    ...decisionBase,
    decision_hash: computeAutonomyDecisionHash(decisionBase),
    hash_algorithm: STABLE_JSON_HASH_ALGORITHM,
  });
}

export function computeAutonomyDecisionHash(decision) {
  requirePlainRecord(decision, "autonomy_decision");
  return computeStableHash(omitKeys(decision, ["decision_hash", "hash_algorithm"]));
}

export const hashAutonomyDecision = computeAutonomyDecisionHash;

export function validateAutonomyDecisionIntegrity(decision) {
  const errors = [];
  let expectedHash = null;
  try {
    expectedHash = computeAutonomyDecisionHash(decision);
  } catch (error) {
    errors.push(error.message);
  }
  if (decision?.kind !== "autonomy_decision") {
    errors.push("autonomy_decision.kind must be 'autonomy_decision'");
  }
  if (decision?.schema_version !== "autonomy-decision:v1") {
    errors.push("autonomy_decision.schema_version must be 'autonomy-decision:v1'");
  }
  if (!decision?.decision_hash || decision.decision_hash !== expectedHash) {
    errors.push("autonomy_decision.decision_hash does not match canonical decision content");
  }
  if (decision?.hash_algorithm !== STABLE_JSON_HASH_ALGORITHM) {
    errors.push(`autonomy_decision.hash_algorithm must be '${STABLE_JSON_HASH_ALGORITHM}'`);
  }
  return immutableJson({
    valid: errors.length === 0,
    actual_hash: decision?.decision_hash || null,
    expected_hash: expectedHash,
    errors: Array.from(new Set(errors)),
  });
}

function evaluateRequirementProfile(profile, currentRequirements, phase, evaluatedAt) {
  const reasons = [];
  const drift = [];
  let valid = true;
  let level = "supervised";
  if (!isPlainRecord(profile)) {
    return { ...missingBoundary("requirement.profile_missing"), material_drift: drift };
  }
  const integrity = validateRequirementExecutionProfileIntegrity(profile);
  if (!integrity.valid) {
    reasons.push("requirement.profile_integrity_invalid");
    valid = false;
  }
  const state = evaluateProfileState(profile, evaluatedAt, "requirement");
  reasons.push(...state.reason_codes);
  valid = valid && state.valid;
  if (valid) {
    level = effectiveProfileLevel(profile, phase, "autonomy_ceiling");
  }
  const current = currentRequirements.get(profile.requirement_ref?.id);
  if (!current) {
    reasons.push("requirement.current_ref_missing");
    valid = false;
    level = "supervised";
  } else if (
    current.hash !== profile.requirement_ref.hash
    || current.version !== profile.requirement_ref.version
  ) {
    reasons.push("requirement.profile_stale");
    valid = false;
    level = "supervised";
    if (current.material_scope) {
      try {
        drift.push(...detectMaterialDrift(profile.material_scope, current.material_scope));
        reasons.push(...drift.map((item) => item.reason_code));
      } catch {
        reasons.push("requirement.current_material_scope_invalid");
      }
    }
  } else if (!current.material_scope) {
    reasons.push("requirement.current_material_scope_missing");
    valid = false;
    level = "supervised";
  } else {
    try {
      drift.push(...detectMaterialDrift(profile.material_scope, current.material_scope));
    } catch {
      reasons.push("requirement.current_material_scope_invalid");
      valid = false;
      level = "supervised";
    }
    if (drift.length > 0) {
      reasons.push(...drift.map((item) => item.reason_code));
      valid = false;
      level = "supervised";
    }
  }
  const authorityCap = evaluateHostAuthorityCap(profile.authority_assurance);
  level = mostRestrictiveAutonomyLevel(level, authorityCap.max_level);
  reasons.push(...authorityCap.reason_codes.map((code) => `requirement.${code}`));
  return {
    level,
    valid,
    blocked: false,
    reason_codes: reasons,
    material_drift: drift,
  };
}

function evaluateDeliveryProfile(options) {
  const {
    profile,
    requirementProfiles,
    currentStoryRefs,
    currentContractRefs,
    currentMaterialScope,
    deliveryState,
    phase,
    evaluatedAt,
  } = options;
  if (!isPlainRecord(profile)) {
    return {
      ...missingBoundary("delivery.profile_missing"),
      requested_level: "supervised",
      material_drift: [],
    };
  }
  const reasons = [];
  const drift = [];
  let valid = true;
  let blocked = false;
  let level = "supervised";
  let requestedLevel = "supervised";
  try {
    requestedLevel = normalizeAutonomyLevel(profile.requested_level, "delivery.requested_level");
  } catch {
    reasons.push("delivery.requested_level_invalid");
    valid = false;
  }
  const integrity = validateDeliveryExecutionProfileIntegrity(profile);
  if (!integrity.valid) {
    reasons.push("delivery.profile_integrity_invalid");
    valid = false;
  }
  const state = evaluateProfileState(profile, evaluatedAt, "delivery");
  reasons.push(...state.reason_codes);
  valid = valid && state.valid;
  const requirementBinding = validateProfileRefSet(
    profile.requirement_profile_refs,
    requirementProfiles.map((item) => ({ id: item.id, hash: item.profile_hash })),
    "delivery.requirement_profile_refs_stale",
  );
  reasons.push(...requirementBinding);
  valid = valid && requirementBinding.length === 0;
  const storyBinding = validateProfileRefSet(
    profile.story_refs,
    currentStoryRefs,
    "delivery.story_refs_stale",
  );
  reasons.push(...storyBinding);
  valid = valid && storyBinding.length === 0;
  const contractBinding = validateProfileRefSet(
    profile.contract_refs,
    currentContractRefs,
    "delivery.contract_refs_stale",
  );
  reasons.push(...contractBinding);
  valid = valid && contractBinding.length === 0;
  if (!isPlainRecord(currentMaterialScope)) {
    reasons.push("delivery.current_material_scope_missing");
    valid = false;
  } else {
    try {
      drift.push(...detectMaterialDrift(profile.material_scope, currentMaterialScope));
    } catch {
      reasons.push("delivery.current_material_scope_invalid");
      valid = false;
    }
    if (drift.length > 0) {
      reasons.push(...drift.map((item) => item.reason_code));
      valid = false;
    }
  }
  const stateResult = validateDeliveryState(profile, deliveryState);
  reasons.push(...stateResult.reason_codes);
  valid = valid && stateResult.valid;
  blocked = blocked || stateResult.blocked;
  const targetResult = profile.delivery_kind === "local_release"
    ? validateLocalReleaseTargetBoundary(profile.local_release_target)
    : validatePullRequestTargetBoundary(profile.pull_request_target);
  if (!targetResult.valid) {
    reasons.push(...targetResult.reason_codes);
    valid = false;
    blocked = true;
  }
  if (valid) {
    level = effectiveProfileLevel(profile, phase, "requested_level");
  }
  const authorityCap = evaluateHostAuthorityCap(profile.authority_assurance);
  level = mostRestrictiveAutonomyLevel(level, authorityCap.max_level);
  reasons.push(...authorityCap.reason_codes.map((code) => `delivery.${code}`));
  return {
    level: blocked ? "supervised" : level,
    requested_level: requestedLevel,
    valid,
    blocked,
    reason_codes: reasons,
    material_drift: drift,
  };
}

function evaluateGenericBoundary(source, input, phase, evaluatedAt) {
  if (input === undefined || input === null) {
    return missingBoundary(`${source}.policy_missing`);
  }
  if (typeof input === "string") {
    return {
      level: normalizeAutonomyLevel(input, `${source}.level`),
      valid: true,
      blocked: false,
      reason_codes: [],
    };
  }
  if (!isPlainRecord(input)) {
    return missingBoundary(`${source}.policy_invalid`);
  }
  const reasons = [];
  let valid = true;
  let blocked = false;
  let level;
  try {
    level = genericBoundaryLevel(input, phase, source);
  } catch {
    level = "supervised";
    valid = false;
    reasons.push(`${source}.level_invalid`);
  }
  const status = input.status === undefined || input.status === null
    ? null
    : String(input.status).trim().toLowerCase();
  if (["blocked", "failed", "hard_limit", "metering_violation", "unavailable"].includes(status)) {
    reasons.push(`${source}.blocked`);
    level = "supervised";
    valid = false;
    blocked = true;
  } else if (["disabled", "expired", "revoked", "stale"].includes(status)) {
    reasons.push(`${source}.${status}`);
    level = "supervised";
    valid = false;
  }
  if (input.allowed === false || input.available === false) {
    reasons.push(`${source}.not_allowed`);
    level = "supervised";
    valid = false;
    blocked = true;
  }
  if (source === "budget" && input.allowed_to_start_next === false) {
    reasons.push("budget.start_not_allowed");
    level = "supervised";
    valid = false;
    blocked = true;
  }
  if (input.expires_at && Date.parse(input.expires_at) <= Date.parse(evaluatedAt)) {
    reasons.push(`${source}.expired`);
    level = "supervised";
    valid = false;
  }
  return { level, valid, blocked, reason_codes: reasons };
}

function genericBoundaryLevel(input, phase, source) {
  const phaseLevels = input.phase_levels ?? input.phase_overrides;
  if (phase && isPlainRecord(phaseLevels) && phaseLevels[phase] !== undefined) {
    return normalizeAutonomyLevel(phaseLevels[phase], `${source}.phase_levels.${phase}`);
  }
  for (const key of ["max_level", "autonomy_ceiling", "requested_level", "autonomy_level", "level"]) {
    if (input[key] !== undefined && input[key] !== null) {
      return normalizeAutonomyLevel(input[key], `${source}.${key}`);
    }
  }
  if (Array.isArray(input.allowed_levels) && input.allowed_levels.length > 0) {
    return input.allowed_levels
      .map((item, index) => normalizeAutonomyLevel(item, `${source}.allowed_levels[${index}]`))
      .reduce((current, candidate) => (
        compareAutonomyLevels(candidate, current) > 0 ? candidate : current
      ));
  }
  if (input.allowed === true || input.available === true || input.allowed_to_start_next === true) {
    return "bounded-autonomous";
  }
  throw new DomainValidationError(`${source} does not declare an autonomy boundary`);
}

function validateContractDeliveryBinding(contractInput, deliveryProfile) {
  if (!isPlainRecord(contractInput)) {
    return ["contract.delivery_profile_ref_missing"];
  }
  const ref = contractInput.delivery_profile_ref ?? contractInput.autonomy_profile_ref;
  if (!isPlainRecord(ref) || !isPlainRecord(deliveryProfile)) {
    return ["contract.delivery_profile_ref_missing"];
  }
  if (ref.id !== deliveryProfile.id || ref.hash !== deliveryProfile.profile_hash) {
    return ["contract.delivery_profile_ref_stale"];
  }
  return [];
}

function validateDeliveryState(profile, state) {
  if (!isPlainRecord(state)) {
    return {
      valid: false,
      blocked: false,
      reason_codes: ["delivery.state_missing"],
    };
  }
  const reasons = [];
  let valid = true;
  let blocked = false;
  if (state.delivery_id !== profile.delivery_id) {
    reasons.push("delivery.state_mismatch");
    valid = false;
  }
  const status = String(state.status || "").trim().toLowerCase();
  if (TERMINAL_DELIVERY_STATES.has(status)) {
    reasons.push("delivery.profile_terminal");
    valid = false;
    blocked = true;
  }
  if (
    state.active_run_count !== undefined
    && (!Number.isSafeInteger(state.active_run_count) || state.active_run_count > 1 || state.active_run_count < 0)
  ) {
    reasons.push("delivery.concurrent_run_limit_exceeded");
    valid = false;
    blocked = true;
  }
  return { valid, blocked, reason_codes: reasons };
}

function evaluateProfileState(profile, evaluatedAt, source) {
  const reasons = [];
  let valid = true;
  if (profile.status === "revoked") {
    reasons.push(`${source}.profile_revoked`);
    valid = false;
  } else if (profile.status !== "active") {
    reasons.push(`${source}.profile_not_active`);
    valid = false;
  }
  const now = Date.parse(evaluatedAt);
  if (!profile.valid_from || Date.parse(profile.valid_from) > now) {
    reasons.push(`${source}.profile_not_yet_valid`);
    valid = false;
  }
  if (profile.expires_at && Date.parse(profile.expires_at) <= now) {
    reasons.push(`${source}.profile_expired`);
    valid = false;
  }
  return { valid, reason_codes: reasons };
}

function effectiveProfileLevel(profile, phase, baseField) {
  if (phase && profile.phase_levels?.[phase]) {
    return normalizeAutonomyLevel(profile.phase_levels[phase], `${profile.id}.phase_levels.${phase}`);
  }
  return normalizeAutonomyLevel(profile[baseField], `${profile.id}.${baseField}`);
}

function normalizeProfileStatus(value) {
  const status = requireNonEmptyString(value ?? "proposed", "profile.status");
  if (!["proposed", "active", "revoked"].includes(status)) {
    throw new DomainValidationError("profile.status must be proposed, active, or revoked");
  }
  return status;
}

function normalizePhaseLevels(input, parentLevel, label) {
  if (input === undefined || input === null) {
    return immutableJson({});
  }
  requirePlainRecord(input, label);
  const result = {};
  for (const key of Object.keys(input).sort(compareCanonicalStrings)) {
    if (!PHASE_IDENTIFIER_PATTERN.test(key)) {
      throw new DomainValidationError(`${label}.${key} is not a portable phase identifier`);
    }
    const level = normalizeAutonomyLevel(input[key], `${label}.${key}`);
    if (!isAutonomyNarrowing(parentLevel, level)) {
      throw new DomainValidationError(`${label}.${key} cannot expand ${parentLevel} to ${level}`);
    }
    result[key] = level;
  }
  return immutableJson(result);
}

function normalizeConstraints(input) {
  const source = input === undefined || input === null ? {} : requirePlainRecord(input, "constraints");
  return immutableJson({
    allowed_tools: normalizeStringList(source.allowed_tools, "constraints.allowed_tools"),
    allowed_capabilities: normalizeStringList(
      source.allowed_capabilities,
      "constraints.allowed_capabilities",
    ),
    allowed_environments: normalizeStringList(
      source.allowed_environments,
      "constraints.allowed_environments",
    ),
    allowed_write_paths: normalizeStringList(
      source.allowed_write_paths,
      "constraints.allowed_write_paths",
    ),
    forbidden_actions: normalizeStringList(source.forbidden_actions, "constraints.forbidden_actions"),
    budget_ref: normalizeNullableHashedRef(source.budget_ref, "constraints.budget_ref"),
  });
}

function normalizeAuthorityAssurance(input, approvalRef) {
  const source = input === undefined || input === null
    ? { mode: "audit_only" }
    : requirePlainRecord(input, "authority_assurance");
  const mode = source.mode ?? source.authority_mode;
  if (mode === "audit_only") {
    return immutableJson({
      mode: "audit_only",
      source: "declared_cli_attribution",
      verified: false,
      receipt_ref: null,
    });
  }
  if (mode === "host_verified") {
    const receiptRef = normalizeNullableHashedRef(
      source.receipt_ref ?? approvalRef,
      "authority_assurance.receipt_ref",
    );
    if (!receiptRef) {
      throw new DomainValidationError("host_verified authority requires receipt_ref");
    }
    const authoritySource = source.source ?? "host_approval_receipt";
    if (!["host_approval_receipt", "ci_attestation"].includes(authoritySource)) {
      throw new DomainValidationError("host_verified authority source is invalid");
    }
    return immutableJson({
      mode: "host_verified",
      source: authoritySource,
      verified: true,
      receipt_ref: receiptRef,
    });
  }
  throw new DomainValidationError("authority_assurance.mode must be audit_only or host_verified");
}

function normalizePullRequestTarget(input) {
  const source = requirePlainRecord(input, "pull_request_target");
  const baseBranch = requireNonEmptyString(source.base_branch, "pull_request_target.base_branch");
  const headBranch = requireNonEmptyString(source.head_branch, "pull_request_target.head_branch");
  if (baseBranch === headBranch) {
    throw new DomainValidationError("pull_request_target head and base branches must differ");
  }
  const allowedActions = normalizeStringList(source.allowed_actions, "pull_request_target.allowed_actions");
  if (allowedActions.length === 0) {
    throw new DomainValidationError("pull_request_target.allowed_actions must not be empty");
  }
  if (source.merge_allowed !== true && allowedActions.includes("pull_request.merge")) {
    throw new DomainValidationError(
      "pull_request_target.allowed_actions cannot include pull_request.merge when merge_allowed is false",
    );
  }
  return immutableJson({
    repository: requireNonEmptyString(source.repository, "pull_request_target.repository"),
    base_branch: baseBranch,
    head_branch: headBranch,
    allowed_actions: allowedActions,
    merge_allowed: source.merge_allowed === true,
  });
}

function normalizePullRequestRepositoryIdentity(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  let host = null;
  let repositoryPath = raw;
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(raw)) {
    try {
      const parsed = new URL(raw);
      host = parsed.hostname;
      repositoryPath = parsed.pathname;
    } catch {
      return null;
    }
  }
  repositoryPath = repositoryPath
    .replace(/^\/+|\/+$/gu, "")
    .replace(/\.git$/iu, "")
    .toLowerCase();
  const segments = repositoryPath.split("/").filter(Boolean);
  if (!host && segments.length === 2) host = "github.com";
  if (!host && segments.length >= 3 && segments[0].includes(".")) {
    host = segments.shift();
    repositoryPath = segments.join("/");
  }
  return host && repositoryPath.includes("/")
    ? `${String(host).toLowerCase()}/${repositoryPath}`
    : null;
}

function normalizeExistingPullRequestUrl(value, repository, number) {
  const raw = requireNonEmptyString(value, "pull_request_target.pr_url");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new DomainValidationError("pull_request_target.pr_url must be an absolute URL");
  }
  const segments = parsed.pathname.replace(/^\/+|\/+$/gu, "").split("/");
  const urlRepository = segments.length >= 2
    ? `${parsed.hostname.toLowerCase()}/${segments[0].toLowerCase()}/${segments[1].replace(/\.git$/iu, "").toLowerCase()}`
    : null;
  if (
    parsed.protocol !== "https:"
    || parsed.search
    || parsed.hash
    || parsed.hostname.toLowerCase() !== "github.com"
    || urlRepository !== normalizePullRequestRepositoryIdentity(repository)
    || segments[2] !== "pull"
    || Number(segments[3]) !== number
    || !/^[1-9]\d*$/u.test(segments[3] || "")
    || segments.length !== 4
  ) {
    throw new DomainValidationError(
      "pull_request_target.pr_url must identify the exact approved PR number in its repository",
    );
  }
  parsed.pathname = `/${segments[0].toLowerCase()}/${segments[1].replace(/\.git$/iu, "").toLowerCase()}/pull/${number}`;
  parsed.hash = "";
  parsed.search = "";
  return parsed.toString().replace(/\/$/u, "");
}

function normalizePullRequestTargetV2(input) {
  const source = requirePlainRecord(input, "pull_request_target");
  const legacy = normalizePullRequestTarget(source);
  if (source.mode === undefined) {
    // Preserve byte-for-byte reconstruction of v2 profiles created before PR identity modes existed.
    return legacy;
  }
  const mode = requireNonEmptyString(source.mode, "pull_request_target.mode").toLowerCase();
  if (!["new", "existing"].includes(mode)) {
    throw new DomainValidationError("pull_request_target.mode must be new or existing");
  }
  if (mode === "new") {
    if (
      source.pr_number !== undefined && source.pr_number !== null
      || source.pr_url !== undefined && source.pr_url !== null
      || source.reviewed_head_sha !== undefined && source.reviewed_head_sha !== null
    ) {
      throw new DomainValidationError(
        "new pull_request_target cannot pre-bind pr_number, pr_url, or reviewed_head_sha",
      );
    }
    return immutableJson({
      ...legacy,
      mode,
      pr_number: null,
      pr_url: null,
      reviewed_head_sha: null,
    });
  }
  const prNumber = Number(source.pr_number);
  if (!Number.isSafeInteger(prNumber) || prNumber < 1) {
    throw new DomainValidationError("existing pull_request_target.pr_number must be a positive integer");
  }
  if (legacy.allowed_actions.includes("pull_request.create")) {
    throw new DomainValidationError(
      "existing pull_request_target.allowed_actions cannot include pull_request.create",
    );
  }
  const reviewedHeadSha = source.reviewed_head_sha === null || source.reviewed_head_sha === undefined
    ? null
    : requireNonEmptyString(source.reviewed_head_sha, "pull_request_target.reviewed_head_sha").toLowerCase();
  if (reviewedHeadSha && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(reviewedHeadSha)) {
    throw new DomainValidationError(
      "pull_request_target.reviewed_head_sha must be a full lowercase Git commit SHA",
    );
  }
  return immutableJson({
    ...legacy,
    mode,
    pr_number: prNumber,
    pr_url: normalizeExistingPullRequestUrl(source.pr_url, legacy.repository, prNumber),
    reviewed_head_sha: reviewedHeadSha,
  });
}

function normalizeLocalReleaseTarget(input) {
  const source = requirePlainRecord(input, "local_release_target");
  if (source.environment !== "local") {
    throw new DomainValidationError("local_release_target.environment must be 'local'");
  }
  const rootPath = normalizeAbsoluteBoundaryPath(source.root_path, "local_release_target.root_path");
  if (rootPath === path.parse(rootPath).root) {
    throw new DomainValidationError("local_release_target.root_path cannot be a filesystem root");
  }
  const allowedWritePaths = normalizeRequiredStringList(
    source.allowed_write_paths,
    "local_release_target.allowed_write_paths",
  ).map((item, index) => {
    const normalized = normalizeAbsoluteBoundaryPath(item, `local_release_target.allowed_write_paths[${index}]`);
    const relative = path.relative(rootPath, normalized);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new DomainValidationError(
        `local_release_target.allowed_write_paths[${index}] must be a strict child of root_path`,
      );
    }
    return normalized;
  });
  const canonicalAllowedWritePaths = Array.from(new Set(allowedWritePaths))
    .sort(compareCanonicalStrings);
  const hasSmokeCwd = source.smoke_cwd !== undefined && source.smoke_cwd !== null;
  const smokeCwd = hasSmokeCwd
    ? normalizeAbsoluteBoundaryPath(source.smoke_cwd, "local_release_target.smoke_cwd")
    : null;
  if (smokeCwd && !canonicalAllowedWritePaths.some((allowedPath) => {
    const relative = path.relative(allowedPath, smokeCwd);
    return relative === "" || (
      relative !== ".."
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative)
    );
  })) {
    throw new DomainValidationError(
      "local_release_target.smoke_cwd must be equal to or inside one allowed_write_path",
    );
  }
  const rollback = requirePlainRecord(source.rollback, "local_release_target.rollback");
  if (rollback.required !== true) {
    throw new DomainValidationError("local_release_target.rollback.required must be true");
  }
  const rollbackVerificationRequired = rollback.verification_required === true;
  if (
    rollback.verification_required !== undefined
    && rollback.verification_required !== true
  ) {
    throw new DomainValidationError(
      "local_release_target.rollback.verification_required must be true when present",
    );
  }
  for (const key of [
    "external_access_allowed",
    "production_access_allowed",
    "destructive_actions_allowed",
  ]) {
    if (source[key] !== false) {
      throw new DomainValidationError(`local_release_target.${key} must be false`);
    }
  }
  const allowedActions = normalizeRequiredStringList(source.allowed_actions, "local_release_target.allowed_actions");
  const forbiddenLocalActions = new Set([
    "deploy.remote",
    "production.access",
    "external.access",
    "destructive.action",
    "secret.access",
  ]);
  const unsafeActions = allowedActions.filter((action) => forbiddenLocalActions.has(action));
  if (unsafeActions.length > 0) {
    throw new DomainValidationError(
      `local_release_target.allowed_actions contains non-local or unsafe action: ${unsafeActions.join(", ")}`,
    );
  }
  const declaresDataMigration = allowedActions.includes("data.migrate")
    || allowedActions.includes("data.rollback");
  if (rollbackVerificationRequired !== allowedActions.includes("rollback.verify")) {
    throw new DomainValidationError(
      "local_release_target rollback verification requires both rollback.verification_required and rollback.verify",
    );
  }
  if (
    declaresDataMigration
    && (!allowedActions.includes("data.migrate") || !allowedActions.includes("data.rollback"))
  ) {
    throw new DomainValidationError(
      "local_release_target reversible data changes require both data.migrate and data.rollback",
    );
  }
  if (!declaresDataMigration && source.data_migration !== undefined && source.data_migration !== null) {
    throw new DomainValidationError(
      "local_release_target.data_migration requires both data.migrate and data.rollback",
    );
  }
  const dataMigration = declaresDataMigration
    ? normalizeDataMigration(
        source.data_migration,
        rootPath,
        canonicalAllowedWritePaths,
      )
    : null;
  const smokeTests = normalizeSmokeTests(source.smoke_tests, "local_release_target.smoke_tests");
  return immutableJson({
    environment: "local",
    root_path: rootPath,
    allowed_write_paths: canonicalAllowedWritePaths,
    allowed_actions: allowedActions,
    smoke_tests: smokeTests,
    ...(smokeCwd ? { smoke_cwd: smokeCwd } : {}),
    ...(dataMigration ? { data_migration: dataMigration } : {}),
    rollback: {
      required: true,
      procedure: requireNonEmptyString(rollback.procedure, "local_release_target.rollback.procedure"),
      ...(rollbackVerificationRequired ? { verification_required: true } : {}),
    },
    external_access_allowed: false,
    production_access_allowed: false,
    destructive_actions_allowed: false,
  });
}

function normalizeDataMigration(input, rootPath, allowedWritePaths) {
  const source = requirePlainRecord(input, "local_release_target.data_migration");
  const targetPath = normalizeAbsoluteBoundaryPath(
    source.target_path,
    "local_release_target.data_migration.target_path",
  );
  const backup = requirePlainRecord(
    source.backup,
    "local_release_target.data_migration.backup",
  );
  if (backup.required !== true) {
    throw new DomainValidationError(
      "local_release_target.data_migration.backup.required must be true",
    );
  }
  const backupPath = normalizeAbsoluteBoundaryPath(
    backup.path,
    "local_release_target.data_migration.backup.path",
  );
  if (targetPath === backupPath) {
    throw new DomainValidationError(
      "local_release_target.data_migration backup.path must differ from target_path",
    );
  }
  for (const [label, candidate] of [
    ["target_path", targetPath],
    ["backup.path", backupPath],
  ]) {
    if (!pathInsideOrEqual(rootPath, candidate) || candidate === rootPath) {
      throw new DomainValidationError(
        `local_release_target.data_migration.${label} must be a strict child of root_path`,
      );
    }
    if (!allowedWritePaths.some((allowedPath) => pathInsideOrEqual(allowedPath, candidate))) {
      throw new DomainValidationError(
        `local_release_target.data_migration.${label} must be inside one allowed_write_path`,
      );
    }
  }
  const scopes = normalizeRequiredStringList(
    source.scopes,
    "local_release_target.data_migration.scopes",
  );
  const previewEvidence = normalizeDataMigrationPreviewEvidence(source.preview_evidence);
  if (source.rollback_verification_required !== true) {
    throw new DomainValidationError(
      "local_release_target.data_migration.rollback_verification_required must be true",
    );
  }
  return immutableJson({
    target_path: targetPath,
    scopes,
    preview_evidence: previewEvidence,
    backup: {
      required: true,
      path: backupPath,
    },
    rollback_verification_required: true,
  });
}

function normalizeDataMigrationPreviewEvidence(input) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new DomainValidationError(
      "local_release_target.data_migration.preview_evidence must not be empty",
    );
  }
  const evidence = input.map((item, index) => {
    const source = requirePlainRecord(
      item,
      `local_release_target.data_migration.preview_evidence[${index}]`,
    );
    const evidencePath = requireNonEmptyString(
      source.path,
      `local_release_target.data_migration.preview_evidence[${index}].path`,
    );
    const sha256 = requireNonEmptyString(
      source.sha256,
      `local_release_target.data_migration.preview_evidence[${index}].sha256`,
    );
    if (!/^[a-f0-9]{64}$/u.test(sha256)) {
      throw new DomainValidationError(
        `local_release_target.data_migration.preview_evidence[${index}].sha256 must be a lowercase SHA-256 digest`,
      );
    }
    return { path: evidencePath, sha256 };
  }).sort((left, right) => compareCanonicalStrings(left.path, right.path));
  if (new Set(evidence.map((item) => item.path)).size !== evidence.length) {
    throw new DomainValidationError(
      "local_release_target.data_migration.preview_evidence paths must be unique",
    );
  }
  return immutableJson(evidence);
}

function pathInsideOrEqual(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function normalizeSmokeTests(input, label) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new DomainValidationError(`${label} must be a non-empty array of shell-free argv commands`);
  }
  const commands = input.map((command, index) => {
    let argv = command;
    if (typeof command === "string") {
      try {
        argv = JSON.parse(command);
      } catch {
        throw new DomainValidationError(`${label}[${index}] must be a JSON argv array`);
      }
    }
    if (
      !Array.isArray(argv)
      || argv.length === 0
      || argv.some((item) => typeof item !== "string" || item.length === 0 || item.includes("\0"))
    ) {
      throw new DomainValidationError(`${label}[${index}] must be a non-empty array of non-empty strings`);
    }
    const executable = path.basename(argv[0]).toLowerCase();
    if ([
      "sh",
      "bash",
      "zsh",
      "dash",
      "ksh",
      "csh",
      "tcsh",
      "fish",
      "cmd",
      "cmd.exe",
      "powershell",
      "powershell.exe",
      "pwsh",
      "pwsh.exe",
    ].includes(executable)) {
      throw new DomainValidationError(`${label}[${index}] cannot invoke a shell executable`);
    }
    if (["env", "xargs", "nice", "nohup", "arch", "xcrun"].includes(executable)) {
      throw new DomainValidationError(`${label}[${index}] cannot invoke an indirect command dispatcher`);
    }
    if (
      /^(?:node(?:js)?|python(?:\d+(?:\.\d+)*)?|ruby|perl|php)(?:[-.]\d.*)?$/u.test(executable)
      && argv.slice(1).some((item) =>
        /^(?:-e|--eval|-c|--print|-p)(?:=|.+)?$/u.test(String(item)))
    ) {
      throw new DomainValidationError(`${label}[${index}] cannot execute inline interpreter code`);
    }
    if (["npx", "npx.cmd", "npx.exe", "bunx"].includes(executable)) {
      throw new DomainValidationError(`${label}[${index}] cannot invoke a package dispatcher`);
    }
    if ([
      "npm",
      "npm.cmd",
      "npm.exe",
      "pnpm",
      "pnpm.cmd",
      "pnpm.exe",
      "yarn",
      "yarn.cmd",
      "yarn.exe",
      "bun",
    ].includes(executable)) {
      const operation = String(argv[1] || "").toLowerCase();
      if (
        !(
          operation === "test"
          || (operation === "run" && typeof argv[2] === "string" && !argv[2].startsWith("-"))
        )
      ) {
        throw new DomainValidationError(
          `${label}[${index}] package manager must use test or run <reviewed-script>`,
        );
      }
    }
    return JSON.stringify(argv);
  });
  const unique = Array.from(new Set(commands)).sort(compareCanonicalStrings);
  if (unique.length !== commands.length) {
    throw new DomainValidationError(`${label} must not contain duplicate commands`);
  }
  return unique;
}

function normalizeAbsoluteBoundaryPath(value, label) {
  const raw = requireNonEmptyString(value, label);
  if (raw.startsWith("~") || /[$*?{}\[\]]/u.test(raw)) {
    throw new DomainValidationError(`${label} must not contain home aliases, variables, or globs`);
  }
  if (!path.isAbsolute(raw)) {
    throw new DomainValidationError(`${label} must be absolute`);
  }
  return path.normalize(raw);
}

function normalizeRequiredStringList(input, label) {
  const values = normalizeStringList(input, label);
  if (values.length === 0) {
    throw new DomainValidationError(`${label} must not be empty`);
  }
  return values;
}

function normalizeHashedRefList(input, label, options = {}) {
  const values = normalizeArray(input, label);
  if (values.length < (options.minItems || 0)) {
    throw new DomainValidationError(`${label} must contain at least ${options.minItems} item(s)`);
  }
  const refs = values.map((item, index) => normalizeHashedRef(item, `${label}[${index}]`));
  const byId = new Map();
  for (const ref of refs) {
    if (byId.has(ref.id)) {
      throw new DomainValidationError(`${label} contains duplicate id '${ref.id}'`);
    }
    byId.set(ref.id, ref);
  }
  return immutableJson(Array.from(byId.values()).sort((left, right) => (
    compareCanonicalStrings(left.id, right.id)
  )));
}

function normalizeHashedRef(input, label) {
  const source = requirePlainRecord(input, label);
  const hash = requireNonEmptyString(
    source.hash ?? source.profile_hash ?? source.content_hash ?? source.approved_content_hash,
    `${label}.hash`,
  );
  if (!/^[a-f0-9]{64}$/u.test(hash)) {
    throw new DomainValidationError(`${label}.hash must be a lowercase SHA-256 digest`);
  }
  return immutableJson({
    id: requireNonEmptyString(source.id, `${label}.id`),
    path: source.path === undefined || source.path === null
      ? null
      : requireNonEmptyString(source.path, `${label}.path`),
    hash,
  });
}

function normalizeVersionedHashedRef(input, label) {
  const ref = normalizeHashedRef(input, label);
  return immutableJson({
    ...ref,
    version: normalizePositiveInteger(input.version, null, `${label}.version`),
  });
}

function normalizeNullableHashedRef(input, label) {
  return input === undefined || input === null ? null : normalizeHashedRef(input, label);
}

function currentReferenceMap(input, label) {
  const result = new Map();
  for (const [index, item] of normalizeArray(input, label).entries()) {
    if (!isPlainRecord(item)) {
      continue;
    }
    const refSource = isPlainRecord(item.requirement_ref) ? item.requirement_ref : item;
    try {
      const ref = normalizeVersionedHashedRef(refSource, `${label}[${index}]`);
      result.set(ref.id, {
        ...ref,
        material_scope: isPlainRecord(item.material_scope) ? item.material_scope : null,
      });
    } catch {
      // Invalid current evidence is treated exactly like a missing reference.
    }
  }
  return result;
}

function validateProfileRefSet(expectedInput, actualInput, reasonCode) {
  let expected;
  let actual;
  try {
    expected = normalizeHashedRefList(expectedInput, "expected_refs", { minItems: 1 });
    actual = normalizeHashedRefList(actualInput, "actual_refs", { minItems: 1 });
  } catch {
    return [reasonCode];
  }
  if (expected.length !== actual.length) {
    return [reasonCode];
  }
  const actualById = new Map(actual.map((item) => [item.id, item.hash]));
  return expected.every((item) => actualById.get(item.id) === item.hash) ? [] : [reasonCode];
}

function validateProfileIntegrity(profile, kind, schemaVersion, hashFunction, builder) {
  const errors = [];
  let expectedHash = null;
  try {
    expectedHash = hashFunction(profile);
  } catch (error) {
    errors.push(error.message);
  }
  if (profile?.kind !== kind) {
    errors.push(`profile.kind must be '${kind}'`);
  }
  if (profile?.schema_version !== schemaVersion) {
    errors.push(`profile.schema_version must be '${schemaVersion}'`);
  }
  if (!profile?.profile_hash || profile.profile_hash !== expectedHash) {
    errors.push("profile.profile_hash does not match canonical profile content");
  }
  if (profile?.hash_algorithm !== STABLE_JSON_HASH_ALGORITHM) {
    errors.push(`profile.hash_algorithm must be '${STABLE_JSON_HASH_ALGORITHM}'`);
  }
  try {
    const normalized = builder(profile);
    if (normalized.profile_hash !== profile.profile_hash) {
      errors.push("profile is not in canonical normalized form");
    }
  } catch (error) {
    errors.push(error.message);
  }
  return immutableJson({
    valid: errors.length === 0,
    actual_hash: profile?.profile_hash || null,
    expected_hash: expectedHash,
    errors: Array.from(new Set(errors)),
  });
}

function validDeliveryDecisionRef(profile) {
  if (
    !isPlainRecord(profile)
    || !DELIVERY_KINDS.includes(profile.delivery_kind)
    || typeof profile.profile_hash !== "string"
  ) {
    return null;
  }
  return {
    id: profile.delivery_id,
    kind: profile.delivery_kind,
    profile_id: profile.id,
    profile_hash: profile.profile_hash,
  };
}

function missingBoundary(reasonCode) {
  return {
    level: "supervised",
    valid: false,
    blocked: false,
    reason_codes: [reasonCode],
  };
}

function normalizeNullablePhase(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const phase = requireNonEmptyString(value, "phase");
  if (!PHASE_IDENTIFIER_PATTERN.test(phase)) {
    throw new DomainValidationError("phase must be a portable phase identifier");
  }
  return phase;
}

function normalizePositiveInteger(value, fallback, label) {
  const selected = value === undefined || value === null ? fallback : value;
  if (!Number.isSafeInteger(selected) || selected < 1) {
    throw new DomainValidationError(`${label} must be a positive integer`);
  }
  return selected;
}

function normalizeRequiredTimestamp(value, label) {
  if (value === undefined || value === null) {
    throw new DomainValidationError(`${label} is required`);
  }
  return normalizeIsoInstant(value, label);
}

function normalizeNullableTimestamp(value, label) {
  return value === undefined || value === null ? null : normalizeIsoInstant(value, label);
}

function assertValidWindow(validFrom, expiresAt) {
  if (expiresAt && Date.parse(expiresAt) <= Date.parse(validFrom)) {
    throw new DomainValidationError("expires_at must be later than valid_from");
  }
}

function normalizeRecord(value, label) {
  if (value === undefined || value === null) {
    return immutableJson({});
  }
  return immutableJson(requirePlainRecord(value, label));
}

function normalizeArray(value, label) {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new DomainValidationError(`${label} must be an array`);
  }
  return value;
}

function defaultCheckpoints(level, deliveryKind) {
  if (level === "supervised") {
    return deliveryKind === "pull_request"
      ? ["before_start", "before_push", "before_merge"]
      : ["before_start", "before_local_release"];
  }
  if (level === "checkpointed") {
    return deliveryKind === "pull_request" ? ["before_merge"] : ["before_local_release"];
  }
  return [];
}

function defaultExceptionActions() {
  return [
    "budget.extend",
    "capability.install",
    "destructive.action",
    "external.access",
    "external.communication",
    "gate.bypass",
    "production.access",
    "scope.change",
    "secret.access",
  ];
}

function normalizeReasonSegment(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "_")
    .replace(/^[_-]+|[_-]+$/gu, "") || "unknown";
}

function issueReasonCodes(error, fallback) {
  const issues = Array.isArray(error?.issues) ? error.issues : [];
  if (issues.length === 0) {
    return [fallback];
  }
  return issues.map((issue) => `${fallback}.${normalizeReasonSegment(issue.code || "invalid")}`);
}

function uniqueDrift(items) {
  const byKey = new Map();
  for (const item of items) {
    byKey.set(`${item.field}:${item.approved_hash}:${item.current_hash}`, item);
  }
  return Array.from(byKey.values()).sort((left, right) => (
    compareCanonicalStrings(left.field, right.field)
  ));
}
