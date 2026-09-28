import { crypto } from "./runtime/host.mjs";
import {
  DomainValidationError,
  STABLE_JSON_HASH_ALGORITHM,
  cloneJson,
  compareCanonicalStrings,
  computeStableHash,
  immutableJson,
  isPlainRecord,
  normalizeIsoInstant,
  normalizeOptionalString,
  normalizeStringList,
  omitKeys,
  requireNonEmptyString,
  requirePlainRecord,
} from "./canonical.mjs";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const AUTHORIZATION_ACTION_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const CONTENT_AUTHORIZATION_V1 = "content-authorization:v1";
const CONTENT_AUTHORIZATION_V2 = "content-authorization:v2";
const AUTHORIZATION_USAGE_RECEIPT_V1 = "authorization-usage-receipt:v1";
const AUTHORIZATION_USAGE_RECEIPT_V2 = "authorization-usage-receipt:v2";
const HOST_CONSTRAINT_FIELDS = new Set([
  "subject_hash",
  "max_authorization_ttl_seconds",
  "no_scope_expansion",
  "no_budget_extension",
  "no_production_access",
  "no_external_access",
]);

export function computeAuthorizationSubjectHash(subject) {
  if (subject === undefined) {
    throw new DomainValidationError("authorization subject is required");
  }
  return computeStableHash(subject);
}

export function computeAuthorizationUseHash(action, subjectHash) {
  const normalizedAction = normalizeAuthorizationAction(action, "authorization_use.action");
  const normalizedSubjectHash = normalizeSha256(subjectHash, "authorization_use.subject_hash");
  return computeStableHash({ action: normalizedAction, subject_hash: normalizedSubjectHash });
}

function normalizeAuthorizationAllowedUses(input) {
  const explicitUses = input.allowed_uses;
  if (explicitUses !== undefined && explicitUses !== null) {
    if (!Array.isArray(explicitUses) || explicitUses.length === 0) {
      throw new DomainValidationError("authorization.allowed_uses must be a non-empty array");
    }
    const uses = canonicalizeAllowedUses(
      explicitUses.map((allowedUse, index) => normalizeAllowedUse(allowedUse, `authorization.allowed_uses[${index}]`)),
    );
    const projectedActions = uniqueCanonical(uses.map((allowedUse) => allowedUse.action));
    const projectedSubjectHashes = uniqueCanonical(uses.map((allowedUse) => allowedUse.subject_hash));
    if (input.allowed_actions !== undefined || input.actions !== undefined) {
      const declaredActions = normalizeAuthorizationActions(
        input.allowed_actions ?? input.actions,
        "authorization.allowed_actions",
      );
      assertCanonicalProjection(declaredActions, projectedActions, "authorization.allowed_actions", "authorization.allowed_uses");
    }
    if (input.allowed_subject_hashes !== undefined || input.subjects !== undefined || input.subject !== undefined) {
      const declaredSubjectHashes = normalizeAuthorizationSubjectHashes(input);
      assertCanonicalProjection(
        declaredSubjectHashes,
        projectedSubjectHashes,
        "authorization.allowed_subject_hashes",
        "authorization.allowed_uses",
      );
    }
    return uses;
  }

  const actions = normalizeAuthorizationActions(
    input.allowed_actions ?? input.actions,
    "authorization.allowed_actions",
  );
  const subjectHashes = normalizeAuthorizationSubjectHashes(input);
  return deriveLegacyAllowedUses(actions, subjectHashes);
}

function authorizationAllowedUses(snapshot) {
  if (snapshot?.schema_version === CONTENT_AUTHORIZATION_V2) {
    if (!Array.isArray(snapshot.allowed_uses) || snapshot.allowed_uses.length === 0) {
      throw new DomainValidationError("authorization.allowed_uses must be a non-empty array for content-authorization:v2");
    }
    const uses = canonicalizeAllowedUses(
      snapshot.allowed_uses.map((allowedUse, index) =>
        normalizeAllowedUse(allowedUse, `authorization.allowed_uses[${index}]`),
      ),
    );
    assertCanonicalProjection(
      normalizeAuthorizationActions(snapshot.allowed_actions, "authorization.allowed_actions"),
      uniqueCanonical(uses.map((allowedUse) => allowedUse.action)),
      "authorization.allowed_actions",
      "authorization.allowed_uses",
    );
    assertCanonicalProjection(
      normalizeAuthorizationSubjectHashes({ allowed_subject_hashes: snapshot.allowed_subject_hashes }),
      uniqueCanonical(uses.map((allowedUse) => allowedUse.subject_hash)),
      "authorization.allowed_subject_hashes",
      "authorization.allowed_uses",
    );
    return uses;
  }
  if (snapshot?.schema_version === CONTENT_AUTHORIZATION_V1) {
    if (Object.hasOwn(snapshot, "allowed_uses")) {
      throw new DomainValidationError("legacy content-authorization:v1 must not declare allowed_uses");
    }
    return deriveLegacyAllowedUses(
      normalizeAuthorizationActions(snapshot.allowed_actions, "authorization.allowed_actions"),
      normalizeAuthorizationSubjectHashes({ allowed_subject_hashes: snapshot.allowed_subject_hashes }),
    );
  }
  throw new DomainValidationError("authorization schema version does not support action-subject bindings");
}

function normalizeAllowedUse(raw, label) {
  requirePlainRecord(raw, label);
  const action = normalizeAuthorizationAction(raw.action, `${label}.action`);
  let subjectHash;
  if (raw.subject_hash !== undefined && raw.subject_hash !== null) {
    subjectHash = normalizeSha256(raw.subject_hash, `${label}.subject_hash`);
    if (raw.subject !== undefined && computeAuthorizationSubjectHash(raw.subject) !== subjectHash) {
      throw new DomainValidationError(`${label}.subject_hash does not match ${label}.subject`);
    }
  } else if (raw.subject !== undefined) {
    subjectHash = computeAuthorizationSubjectHash(raw.subject);
  } else {
    throw new DomainValidationError(`${label} requires subject or subject_hash`);
  }
  const useHash = computeAuthorizationUseHash(action, subjectHash);
  if (raw.use_hash !== undefined && raw.use_hash !== useHash) {
    throw new DomainValidationError(`${label}.use_hash does not match its action and subject_hash`);
  }
  return { action, subject_hash: subjectHash, use_hash: useHash };
}

function deriveLegacyAllowedUses(actions, subjectHashes) {
  if (actions.length === 0) {
    throw new DomainValidationError("authorization.allowed_actions must contain at least one exact action");
  }
  if (subjectHashes.length === 0) {
    throw new DomainValidationError("authorization requires at least one content-bound subject hash");
  }
  if (actions.length > 1 && subjectHashes.length > 1) {
    throw new DomainValidationError(
      "legacy authorization has multiple actions and multiple subjects, so action-subject bindings are ambiguous and must fail closed",
    );
  }
  return canonicalizeAllowedUses(
    actions.flatMap((action) => subjectHashes.map((subjectHash) => ({
      action,
      subject_hash: subjectHash,
      use_hash: computeAuthorizationUseHash(action, subjectHash),
    }))),
  );
}

function canonicalizeAllowedUses(uses) {
  return Array.from(new Map(uses.map((allowedUse) => [allowedUse.use_hash, allowedUse])).values())
    .sort((left, right) => compareCanonicalStrings(left.use_hash, right.use_hash));
}

function normalizeAuthorizationActions(value, label) {
  const values = value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
  return uniqueCanonical(values.map((action, index) => normalizeAuthorizationAction(action, `${label}[${index}]`)));
}

function normalizeAuthorizationAction(value, label) {
  const action = requireNonEmptyString(value, label).toLowerCase();
  if (!AUTHORIZATION_ACTION_PATTERN.test(action)) {
    throw new DomainValidationError(`${label} must be an exact lowercase authorization action`);
  }
  return action;
}

function normalizeAuthorizationSubjectHashes(input) {
  const hashes = new Set(
    normalizeStringList(input.allowed_subject_hashes, "authorization.allowed_subject_hashes").map((hash) =>
      normalizeSha256(hash, "authorization.allowed_subject_hashes"),
    ),
  );
  const subjects = input.subjects === undefined
    ? input.subject === undefined
      ? []
      : [input.subject]
    : Array.isArray(input.subjects)
      ? input.subjects
      : [input.subjects];
  for (const value of subjects) {
    hashes.add(computeAuthorizationSubjectHash(value));
  }
  return uniqueCanonical(Array.from(hashes));
}

function uniqueCanonical(values) {
  return Array.from(new Set(values)).sort(compareCanonicalStrings);
}

function assertCanonicalProjection(actual, expected, label, sourceLabel) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new DomainValidationError(`${label} must exactly match the projection of ${sourceLabel}`);
  }
}

export function createAuthorizationSnapshot(input) {
  requirePlainRecord(input, "authorization");
  const allowedUses = normalizeAuthorizationAllowedUses(input);
  const actions = uniqueCanonical(allowedUses.map((allowedUse) => allowedUse.action));
  const subjectHashes = uniqueCanonical(allowedUses.map((allowedUse) => allowedUse.subject_hash));
  const validFrom = normalizeIsoInstant(input.valid_from ?? input.granted_at, "authorization.valid_from");
  const expiresAt = input.expires_at ? normalizeIsoInstant(input.expires_at, "authorization.expires_at") : null;
  if (expiresAt && expiresAt <= validFrom) {
    throw new DomainValidationError("authorization.expires_at must be later than valid_from");
  }
  const scope = normalizeRecord(input.scope, "authorization.scope");
  const createdAt = input.created_at
    ? normalizeIsoInstant(input.created_at, "authorization.created_at")
    : validFrom;
  const updatedAt = input.updated_at
    ? normalizeIsoInstant(input.updated_at, "authorization.updated_at")
    : createdAt;
  if (updatedAt < createdAt) {
    throw new DomainValidationError("authorization.updated_at must not be earlier than created_at");
  }
  const snapshot = {
    kind: "content_authorization",
    schema_version: CONTENT_AUTHORIZATION_V2,
    version: 2,
    id: requireNonEmptyString(input.id ?? input.authorization_id, "authorization.id"),
    status: "active",
    proposal_ref: normalizeRecordRequired(input.proposal_ref, "authorization.proposal_ref"),
    allowed_actions: actions,
    allowed_subject_hashes: subjectHashes,
    allowed_uses: allowedUses,
    scope,
    scope_hash: computeStableHash(scope),
    use_policy: normalizeRecordRequired(input.use_policy, "authorization.use_policy"),
    authority_assurance: normalizeRecordRequired(
      input.authority_assurance,
      "authorization.authority_assurance",
    ),
    valid_from: validFrom,
    expires_at: expiresAt,
    granted_by: normalizeRecordRequired(input.granted_by, "authorization.granted_by"),
    approval_source: normalizeOptionalString(input.approval_source, "authorization.approval_source"),
    constraints: normalizeRecord(input.constraints, "authorization.constraints"),
    created_at: createdAt,
    updated_at: updatedAt,
    extensions: normalizeRecord(input.extensions, "authorization.extensions"),
  };
  const authorizationHash = computeAuthorizationHash(snapshot);
  return immutableJson({
    ...snapshot,
    authorization_hash: authorizationHash,
    hash_algorithm: STABLE_JSON_HASH_ALGORITHM,
  });
}

export function computeAuthorizationHash(snapshot) {
  requirePlainRecord(snapshot, "authorization");
  return computeStableHash(omitKeys(snapshot, ["authorization_hash", "hash_algorithm"]));
}

export function validateAuthorizationSnapshotIntegrity(snapshot) {
  const errors = [];
  if (!isPlainRecord(snapshot)) {
    return Object.freeze({
      valid: false,
      expected_hash: null,
      errors: Object.freeze(["authorization must be a plain object"]),
    });
  }
  let expectedHash = null;
  try {
    expectedHash = computeAuthorizationHash(snapshot);
  } catch (error) {
    errors.push(error.message);
  }
  if (snapshot?.kind !== "content_authorization") {
    errors.push("authorization.kind must be 'content_authorization'");
  }
  const isV1 = snapshot?.schema_version === CONTENT_AUTHORIZATION_V1;
  const isV2 = snapshot?.schema_version === CONTENT_AUTHORIZATION_V2;
  if (!isV1 && !isV2) {
    errors.push(`authorization.schema_version must be '${CONTENT_AUTHORIZATION_V1}' or '${CONTENT_AUTHORIZATION_V2}'`);
  }
  if (snapshot?.status !== "active") {
    errors.push("authorization.status must be 'active'");
  }
  if (typeof snapshot?.id !== "string" || snapshot.id.trim() === "") {
    errors.push("authorization.id must be a non-empty string");
  }
  if ((isV1 && snapshot?.version !== 1) || (isV2 && snapshot?.version !== 2)) {
    errors.push(`authorization.version must match ${snapshot?.schema_version || "the schema version"}`);
  }
  if (snapshot?.authorization_hash !== expectedHash) {
    errors.push("authorization.authorization_hash does not match canonical authorization content");
  }
  if (snapshot?.hash_algorithm !== STABLE_JSON_HASH_ALGORITHM) {
    errors.push(`authorization.hash_algorithm must be '${STABLE_JSON_HASH_ALGORITHM}'`);
  }
  if (!Array.isArray(snapshot?.allowed_actions) || snapshot.allowed_actions.length === 0) {
    errors.push("authorization.allowed_actions must be a non-empty array");
  } else {
    try {
      const canonicalActions = normalizeAuthorizationActions(snapshot.allowed_actions, "authorization.allowed_actions");
      if (JSON.stringify(canonicalActions) !== JSON.stringify(snapshot.allowed_actions)) {
        errors.push("authorization.allowed_actions must be exact, unique, lowercase, and canonically ordered");
      }
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (!Array.isArray(snapshot?.allowed_subject_hashes) || snapshot.allowed_subject_hashes.length === 0) {
    errors.push("authorization.allowed_subject_hashes must be a non-empty array");
  } else {
    const validHashes = snapshot.allowed_subject_hashes.filter((hash) => typeof hash === "string" && SHA256_PATTERN.test(hash));
    if (validHashes.length !== snapshot.allowed_subject_hashes.length) {
      errors.push("authorization.allowed_subject_hashes must contain lowercase SHA-256 digests");
    }
    const canonicalHashes = Array.from(new Set(validHashes)).sort(compareCanonicalStrings);
    if (JSON.stringify(canonicalHashes) !== JSON.stringify(snapshot.allowed_subject_hashes)) {
      errors.push("authorization.allowed_subject_hashes must be unique and canonically ordered");
    }
  }
  try {
    const allowedUses = authorizationAllowedUses(snapshot);
    if (isV2 && JSON.stringify(allowedUses) !== JSON.stringify(snapshot.allowed_uses)) {
      errors.push("authorization.allowed_uses must be unique and canonically ordered");
    }
  } catch (error) {
    errors.push(error.message);
  }
  if (!isPlainRecord(snapshot.scope) || snapshot.scope_hash !== computeStableHash(snapshot.scope)) {
    errors.push("authorization.scope_hash does not match authorization.scope");
  }
  if (!isPlainRecord(snapshot.granted_by) || Object.keys(snapshot.granted_by).length === 0) {
    errors.push("authorization.granted_by must be a non-empty object");
  }
  for (const field of ["proposal_ref", "use_policy", "authority_assurance"]) {
    if (!isPlainRecord(snapshot[field]) || Object.keys(snapshot[field]).length === 0) {
      errors.push(`authorization.${field} must be a non-empty object`);
    }
  }
  let validFrom = null;
  let expiresAt = null;
  try {
    validFrom = normalizeIsoInstant(snapshot.valid_from, "authorization.valid_from");
    if (validFrom !== snapshot.valid_from) {
      errors.push("authorization.valid_from must be in canonical ISO-8601 UTC form");
    }
  } catch (error) {
    errors.push(error.message);
  }
  if (snapshot.expires_at !== null && snapshot.expires_at !== undefined) {
    try {
      expiresAt = normalizeIsoInstant(snapshot.expires_at, "authorization.expires_at");
      if (expiresAt !== snapshot.expires_at) {
        errors.push("authorization.expires_at must be in canonical ISO-8601 UTC form");
      }
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (validFrom && expiresAt && expiresAt <= validFrom) {
    errors.push("authorization.expires_at must be later than valid_from");
  }
  let createdAt = null;
  let updatedAt = null;
  try {
    createdAt = normalizeIsoInstant(snapshot.created_at, "authorization.created_at");
    if (createdAt !== snapshot.created_at) {
      errors.push("authorization.created_at must be in canonical ISO-8601 UTC form");
    }
  } catch (error) {
    errors.push(error.message);
  }
  try {
    updatedAt = normalizeIsoInstant(snapshot.updated_at, "authorization.updated_at");
    if (updatedAt !== snapshot.updated_at) {
      errors.push("authorization.updated_at must be in canonical ISO-8601 UTC form");
    }
  } catch (error) {
    errors.push(error.message);
  }
  if (createdAt && updatedAt && updatedAt < createdAt) {
    errors.push("authorization.updated_at must not be earlier than created_at");
  }
  return Object.freeze({ valid: errors.length === 0, expected_hash: expectedHash, errors: Object.freeze(errors) });
}

export function createAuthorizationRevocation(input) {
  requirePlainRecord(input, "revocation");
  const revocation = {
    kind: "authorization_revocation",
    schema_version: "authorization-revocation:v1",
    version: 1,
    id: requireNonEmptyString(input.id ?? input.revocation_id, "revocation.id"),
    authorization_id: requireNonEmptyString(input.authorization_id, "revocation.authorization_id"),
    authorization_hash: normalizeSha256(input.authorization_hash, "revocation.authorization_hash"),
    effective_at: normalizeIsoInstant(input.effective_at, "revocation.effective_at"),
    reason: requireNonEmptyString(input.reason, "revocation.reason"),
    revoked_by: normalizeRecordRequired(input.revoked_by, "revocation.revoked_by"),
  };
  return immutableJson({
    ...revocation,
    revocation_hash: computeStableHash(revocation),
    hash_algorithm: STABLE_JSON_HASH_ALGORITHM,
  });
}

export function validateAuthorizationRevocationIntegrity(revocation) {
  const errors = [];
  if (!isPlainRecord(revocation)) {
    return Object.freeze({
      valid: false,
      expected_hash: null,
      errors: Object.freeze(["revocation must be a plain object"]),
    });
  }
  let expectedHash = null;
  try {
    expectedHash = computeStableHash(omitKeys(revocation, ["revocation_hash", "hash_algorithm"]));
  } catch (error) {
    errors.push(error.message);
  }
  if (revocation.kind !== "authorization_revocation") {
    errors.push("revocation.kind must be 'authorization_revocation'");
  }
  if (revocation.schema_version !== "authorization-revocation:v1") {
    errors.push("revocation.schema_version must be 'authorization-revocation:v1'");
  }
  if (revocation.revocation_hash !== expectedHash) {
    errors.push("revocation.revocation_hash does not match canonical revocation content");
  }
  if (revocation.hash_algorithm !== STABLE_JSON_HASH_ALGORITHM) {
    errors.push(`revocation.hash_algorithm must be '${STABLE_JSON_HASH_ALGORITHM}'`);
  }
  if (typeof revocation.authorization_id !== "string" || revocation.authorization_id.trim() === "") {
    errors.push("revocation.authorization_id must be a non-empty string");
  }
  if (typeof revocation.id !== "string" || revocation.id.trim() === "") {
    errors.push("revocation.id must be a non-empty string");
  }
  if (typeof revocation.reason !== "string" || revocation.reason.trim() === "") {
    errors.push("revocation.reason must be a non-empty string");
  }
  if (!isPlainRecord(revocation.revoked_by) || Object.keys(revocation.revoked_by).length === 0) {
    errors.push("revocation.revoked_by must be a non-empty object");
  }
  if (typeof revocation.authorization_hash !== "string" || !SHA256_PATTERN.test(revocation.authorization_hash)) {
    errors.push("revocation.authorization_hash must be a lowercase SHA-256 digest");
  }
  try {
    const effectiveAt = normalizeIsoInstant(revocation.effective_at, "revocation.effective_at");
    if (effectiveAt !== revocation.effective_at) {
      errors.push("revocation.effective_at must be in canonical ISO-8601 UTC form");
    }
  } catch (error) {
    errors.push(error.message);
  }
  return Object.freeze({
    valid: errors.length === 0,
    expected_hash: expectedHash,
    errors: Object.freeze(Array.from(new Set(errors))),
  });
}

export function validateAuthorizationSnapshotAtUse(snapshot, use, revocationsOrOptions = []) {
  requirePlainRecord(use, "authorization_use");
  const integrity = validateAuthorizationSnapshotIntegrity(snapshot);
  const usedAt = normalizeIsoInstant(use.used_at, "authorization_use.used_at");
  const action = normalizeAuthorizationAction(use.action, "authorization_use.action");
  let subjectHash;
  let useHash = null;
  const errors = [...integrity.errors];
  try {
    subjectHash = use.subject_hash
      ? normalizeSha256(use.subject_hash, "authorization_use.subject_hash")
      : computeAuthorizationSubjectHash(use.subject);
    if (use.subject !== undefined && use.subject_hash && computeAuthorizationSubjectHash(use.subject) !== subjectHash) {
      errors.push("authorization_use.subject_hash does not match subject content");
    }
  } catch (error) {
    errors.push(error.message);
    subjectHash = null;
  }
  if (snapshot?.status !== "active") {
    errors.push("authorization snapshot status was not active");
  }
  if (subjectHash) {
    useHash = computeAuthorizationUseHash(action, subjectHash);
    try {
      const allowedUses = authorizationAllowedUses(snapshot);
      if (!allowedUses.some((allowedUse) => allowedUse.use_hash === useHash)) {
        errors.push(`authorization does not allow action '${action}' for the supplied subject content`);
      }
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (snapshot?.valid_from && usedAt < snapshot.valid_from) {
    errors.push("authorization was not active yet at used_at");
  }
  if (snapshot?.expires_at && usedAt >= snapshot.expires_at) {
    errors.push("authorization had expired at used_at");
  }
  const options = Array.isArray(revocationsOrOptions)
    ? { revocations: revocationsOrOptions }
    : requirePlainRecord(revocationsOrOptions, "authorization_use.options");
  if (!Array.isArray(options.revocations || [])) {
    throw new DomainValidationError("authorization_use.options.revocations must be an array");
  }
  const relevantRevocations = [];
  for (const revocation of options.revocations || []) {
    if (revocation?.authorization_id !== snapshot?.id || revocation?.authorization_hash !== snapshot?.authorization_hash) {
      continue;
    }
    const revocationIntegrity = validateAuthorizationRevocationIntegrity(revocation);
    if (!revocationIntegrity.valid) {
      errors.push(`revocation '${revocation?.id || "unknown"}' failed integrity validation`);
      continue;
    }
    if (revocation.effective_at <= usedAt) {
      relevantRevocations.push(revocation);
    }
  }
  const effectiveRevocation = relevantRevocations
    .sort((left, right) => compareCanonicalStrings(left.effective_at, right.effective_at))[0] || null;
  if (effectiveRevocation) {
    errors.push(`authorization was revoked at ${effectiveRevocation.effective_at}`);
  }
  return immutableJson({
    valid: errors.length === 0,
    decision: errors.length === 0 ? "allow" : "deny",
    historical_at_use_time: true,
    authorization_id: snapshot?.id || null,
    authorization_hash: snapshot?.authorization_hash || null,
    action,
    subject_hash: subjectHash,
    use_hash: useHash,
    used_at: usedAt,
    effective_revocation: effectiveRevocation,
    errors,
  });
}

export function buildAuthorizationUsageReceipt(snapshot, use, revocations = []) {
  const decision = validateAuthorizationSnapshotAtUse(snapshot, use, revocations);
  const receipt = {
    kind: "authorization_usage_receipt",
    schema_version: AUTHORIZATION_USAGE_RECEIPT_V2,
    version: 2,
    id: requireNonEmptyString(use.id ?? use.receipt_id, "authorization_usage_receipt.id"),
    authorization_snapshot: cloneJson(snapshot),
    authorization_id: snapshot.id,
    authorization_hash: snapshot.authorization_hash,
    action: decision.action,
    subject: use.subject === undefined ? null : cloneJson(use.subject),
    subject_hash: decision.subject_hash,
    use_hash: decision.use_hash,
    used_at: decision.used_at,
    decision: decision.decision,
    valid_at_use: decision.valid,
    errors: decision.errors,
    effective_revocation: decision.effective_revocation,
    proposal_ref: cloneJson(snapshot.proposal_ref),
    historical_at_use_time: true,
    evidence: normalizeArray(use.evidence, "authorization_usage_receipt.evidence"),
  };
  return immutableJson({
    ...receipt,
    receipt_hash: computeStableHash(receipt),
    hash_algorithm: STABLE_JSON_HASH_ALGORITHM,
  });
}

export function validateAuthorizationUsageReceipt(receipt, revocations = []) {
  const errors = [];
  let expectedHash = null;
  try {
    expectedHash = computeStableHash(omitKeys(receipt, ["receipt_hash", "hash_algorithm"]));
  } catch (error) {
    errors.push(error.message);
  }
  if (receipt?.kind !== "authorization_usage_receipt") {
    errors.push("receipt.kind must be 'authorization_usage_receipt'");
  }
  const isV1 = receipt?.schema_version === AUTHORIZATION_USAGE_RECEIPT_V1;
  const isV2 = receipt?.schema_version === AUTHORIZATION_USAGE_RECEIPT_V2;
  if (!isV1 && !isV2) {
    errors.push(
      `receipt.schema_version must be '${AUTHORIZATION_USAGE_RECEIPT_V1}' or '${AUTHORIZATION_USAGE_RECEIPT_V2}'`,
    );
  }
  if ((isV1 && receipt?.version !== 1) || (isV2 && receipt?.version !== 2)) {
    errors.push(`receipt.version must match ${receipt?.schema_version || "the schema version"}`);
  }
  if (receipt?.receipt_hash !== expectedHash) {
    errors.push("receipt.receipt_hash does not match canonical receipt content");
  }
  if (receipt?.hash_algorithm !== STABLE_JSON_HASH_ALGORITHM) {
    errors.push(`receipt.hash_algorithm must be '${STABLE_JSON_HASH_ALGORITHM}'`);
  }
  if (receipt?.authorization_snapshot?.authorization_hash !== receipt?.authorization_hash) {
    errors.push("receipt authorization snapshot hash does not match receipt.authorization_hash");
  }
  if (receipt?.authorization_snapshot?.id !== receipt?.authorization_id) {
    errors.push("receipt authorization snapshot id does not match receipt.authorization_id");
  }
  try {
    if (computeStableHash(receipt?.authorization_snapshot?.proposal_ref) !== computeStableHash(receipt?.proposal_ref)) {
      errors.push("receipt.proposal_ref does not match the authorization snapshot");
    }
  } catch (error) {
    errors.push(`receipt proposal reference cannot be hashed: ${error.message}`);
  }
  if (receipt?.historical_at_use_time !== true) {
    errors.push("receipt.historical_at_use_time must be true");
  }
  let receiptUseHash = null;
  try {
    receiptUseHash = computeAuthorizationUseHash(receipt.action, receipt.subject_hash);
    if (isV2 && receipt.use_hash !== receiptUseHash) {
      errors.push("receipt.use_hash does not match receipt.action and receipt.subject_hash");
    }
    if (isV1 && receipt.use_hash !== undefined) {
      errors.push("legacy authorization usage receipt must not declare use_hash");
    }
  } catch (error) {
    errors.push(error.message);
  }
  let historicalDecision = null;
  try {
    const receiptRevocations = [receipt.effective_revocation, ...revocations].filter(Boolean);
    historicalDecision = validateAuthorizationSnapshotAtUse(
      receipt.authorization_snapshot,
      {
        action: receipt.action,
        subject: receipt.subject === null ? undefined : receipt.subject,
        subject_hash: receipt.subject_hash,
        used_at: receipt.used_at,
      },
      receiptRevocations,
    );
    if (historicalDecision.decision !== receipt.decision) {
      errors.push("receipt decision does not match authorization validity at used_at");
    }
    if (historicalDecision.valid !== receipt.valid_at_use) {
      errors.push("receipt.valid_at_use does not match authorization validity at used_at");
    }
    if (isV2 && historicalDecision.use_hash !== receipt.use_hash) {
      errors.push("receipt.use_hash does not match the historical authorization decision");
    }
  } catch (error) {
    errors.push(error.message);
  }
  return immutableJson({
    valid: errors.length === 0,
    expected_hash: expectedHash,
    historical_decision: historicalDecision,
    errors,
  });
}

export function buildHostApprovalReceipt(input) {
  requirePlainRecord(input, "host_approval");
  const subjectSource = input.subject === undefined ? input.subject_ref : input.subject;
  if (subjectSource === undefined && !input.subject_hash) {
    throw new DomainValidationError("host_approval requires subject, subject_ref, or subject_hash");
  }
  const subject = subjectSource === undefined ? null : cloneJson(subjectSource);
  const subjectHash = input.subject_hash
    ? normalizeSha256(input.subject_hash, "host_approval.subject_hash")
    : computeAuthorizationSubjectHash(subject);
  if (subject !== null && input.subject_hash && computeAuthorizationSubjectHash(subject) !== subjectHash) {
    throw new DomainValidationError("host_approval.subject_hash does not match subject content");
  }
  const decision = requireNonEmptyString(input.decision, "host_approval.decision");
  if (!["approved", "denied", "changes_requested", "rejected"].includes(decision)) {
    throw new DomainValidationError(
      "host_approval.decision must be approved, denied, changes_requested, or rejected",
    );
  }
  const decidedAt = normalizeIsoInstant(input.decided_at ?? input.approved_at, "host_approval.decided_at");
  const expiresAt = input.expires_at ? normalizeIsoInstant(input.expires_at, "host_approval.expires_at") : null;
  if (expiresAt && expiresAt <= decidedAt) {
    throw new DomainValidationError("host_approval.expires_at must be later than decided_at");
  }
  const questionContract = normalizeHostQuestionContract(input);
  const questionErrors = validateHostQuestionContractMinimum(questionContract);
  if (questionErrors.length > 0) {
    throw new DomainValidationError(`host_approval.question_contract is incomplete: ${questionErrors.join("; ")}`);
  }
  const constraints = normalizeHostConstraints(input.constraints, subjectHash);
  const receipt = {
    kind: "host_approval_receipt",
    schema_version: "host-approval-receipt:v2",
    version: 2,
    id: requireNonEmptyString(input.id ?? input.receipt_id, "host_approval.id"),
    action: normalizeAuthorizationAction(input.action, "host_approval.action"),
    subject,
    subject_hash: subjectHash,
    subject_ref: normalizeNullableRecord(input.subject_ref, "host_approval.subject_ref"),
    checkpoint: normalizeNullableRecord(input.checkpoint, "host_approval.checkpoint"),
    question_contract: questionContract,
    decision,
    response: normalizeNullableRecord(input.response, "host_approval.response"),
    decided_at: decidedAt,
    issued_at: decidedAt,
    expires_at: expiresAt,
    decided_by: normalizeRecordRequired(input.decided_by ?? input.approved_by, "host_approval.decided_by"),
    issued_by: normalizeRecordRequired(input.issued_by ?? input.decided_by ?? input.approved_by, "host_approval.issued_by"),
    host: normalizeNullableRecord(input.host, "host_approval.host"),
    host_message: normalizeNullableJson(input.host_message, "host_approval.host_message"),
    constraints,
    authorization_ref: normalizeOptionalString(input.authorization_ref, "host_approval.authorization_ref"),
    attestation: input.attestation
      ? normalizeHostApprovalAttestation(input.attestation, "host_approval.attestation")
      : null,
  };
  const unsigned = finalizeHostApprovalReceipt(receipt);
  return input.signing ? signHostApprovalReceipt(unsigned, input.signing) : unsigned;
}

export function computeHostApprovalAttestationPayloadHash(receipt) {
  requirePlainRecord(receipt, "host_approval_receipt");
  return computeStableHash(omitKeys(receipt, ["attestation", "receipt_hash", "hash_algorithm"]));
}

export function signHostApprovalReceipt(receipt, signing) {
  requirePlainRecord(receipt, "host_approval_receipt");
  requirePlainRecord(signing, "host_approval_signing");
  const keyId = requireNonEmptyString(signing.key_id, "host_approval_signing.key_id");
  const privateKeyInput = signing.private_key;
  if (!privateKeyInput) {
    throw new DomainValidationError("host_approval_signing.private_key is required");
  }
  let privateKey;
  try {
    privateKey = privateKeyInput instanceof crypto.KeyObject
      ? privateKeyInput
      : crypto.createPrivateKey(privateKeyInput);
  } catch (error) {
    throw new DomainValidationError(`host_approval_signing.private_key is invalid: ${error.message}`);
  }
  if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") {
    throw new DomainValidationError("host_approval_signing.private_key must be an Ed25519 private key");
  }
  const base = omitKeys(receipt, ["attestation", "receipt_hash", "hash_algorithm"]);
  const payloadHash = computeHostApprovalAttestationPayloadHash(base);
  const signature = crypto.sign(null, Buffer.from(payloadHash, "hex"), privateKey).toString("base64");
  return finalizeHostApprovalReceipt({
    ...base,
    attestation: {
      algorithm: "Ed25519",
      key_id: keyId,
      payload_hash: payloadHash,
      signature,
    },
  });
}

export function validateHostApprovalReceiptAtUse(receipt, use, options = {}) {
  requirePlainRecord(receipt, "host_approval_receipt");
  requirePlainRecord(use, "host_approval_use");
  requirePlainRecord(options, "host_approval_validation.options");
  const errors = [];
  let expectedHash = null;
  try {
    expectedHash = computeStableHash(omitKeys(receipt, ["receipt_hash", "hash_algorithm"]));
  } catch (error) {
    errors.push(error.message);
  }
  const usedAt = normalizeIsoInstant(use.used_at, "host_approval_use.used_at");
  const action = normalizeAuthorizationAction(use.action, "host_approval_use.action");
  const subjectHash = use.subject_hash
    ? normalizeSha256(use.subject_hash, "host_approval_use.subject_hash")
    : computeAuthorizationSubjectHash(use.subject);
  if (use.subject !== undefined && use.subject_hash && computeAuthorizationSubjectHash(use.subject) !== subjectHash) {
    errors.push("host_approval_use.subject_hash does not match subject content");
  }
  if (receipt.kind !== "host_approval_receipt") {
    errors.push("receipt.kind must be 'host_approval_receipt'");
  }
  if (receipt.schema_version !== "host-approval-receipt:v2" || receipt.version !== 2) {
    errors.push("receipt must use signed host-approval-receipt:v2");
  }
  if (receipt.receipt_hash !== expectedHash) {
    errors.push("receipt hash is invalid");
  }
  if (receipt.subject !== null) {
    try {
      if (computeAuthorizationSubjectHash(receipt.subject) !== receipt.subject_hash) {
        errors.push("host approval stored subject does not match receipt.subject_hash");
      }
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (receipt.hash_algorithm !== STABLE_JSON_HASH_ALGORITHM) {
    errors.push(`receipt.hash_algorithm must be '${STABLE_JSON_HASH_ALGORITHM}'`);
  }
  if (receipt.decision !== "approved") {
    errors.push("host approval decision was not approved");
  }
  if (receipt.action !== action) {
    errors.push("host approval action does not match use action");
  }
  if (receipt.subject_hash !== subjectHash) {
    errors.push("host approval is not bound to the supplied subject content");
  }
  errors.push(...validateHostQuestionContractMinimum(receipt.question_contract));
  try {
    normalizeHostConstraints(receipt.constraints, receipt.subject_hash);
    if (receipt.constraints.subject_hash !== subjectHash) {
      errors.push("host approval constraints are not bound to the supplied subject hash");
    }
  } catch (error) {
    errors.push(error.message);
  }
  errors.push(...validateHostApprovalAttestation(receipt, options.trusted_host_keys));
  let decidedAt = null;
  let expiresAt = null;
  try {
    decidedAt = normalizeIsoInstant(receipt.decided_at, "host_approval_receipt.decided_at");
    if (decidedAt !== receipt.decided_at) {
      errors.push("host approval decided_at must be in canonical ISO-8601 UTC form");
    }
  } catch (error) {
    errors.push(error.message);
  }
  if (receipt.expires_at !== null && receipt.expires_at !== undefined) {
    try {
      expiresAt = normalizeIsoInstant(receipt.expires_at, "host_approval_receipt.expires_at");
      if (expiresAt !== receipt.expires_at) {
        errors.push("host approval expires_at must be in canonical ISO-8601 UTC form");
      }
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (decidedAt && usedAt < decidedAt) {
    errors.push("host approval was not issued yet at used_at");
  }
  if (expiresAt && usedAt >= expiresAt) {
    errors.push("host approval had expired at used_at");
  }
  return immutableJson({
    valid: errors.length === 0,
    decision: errors.length === 0 ? "allow" : "deny",
    historical_at_use_time: true,
    used_at: usedAt,
    receipt_hash: receipt.receipt_hash,
    attestation_key_id: receipt.attestation?.key_id || null,
    constraints: cloneJson(receipt.constraints || {}),
    errors,
  });
}

function finalizeHostApprovalReceipt(receipt) {
  const subject = omitKeys(receipt, ["receipt_hash", "hash_algorithm"]);
  return immutableJson({
    ...subject,
    receipt_hash: computeStableHash(subject),
    hash_algorithm: STABLE_JSON_HASH_ALGORITHM,
  });
}

function normalizeHostApprovalAttestation(value, label) {
  requirePlainRecord(value, label);
  const algorithm = requireNonEmptyString(value.algorithm, `${label}.algorithm`);
  if (algorithm !== "Ed25519") {
    throw new DomainValidationError(`${label}.algorithm must be 'Ed25519'`);
  }
  const signature = requireNonEmptyString(value.signature, `${label}.signature`);
  if (!BASE64_PATTERN.test(signature)) {
    throw new DomainValidationError(`${label}.signature must be canonical base64`);
  }
  return {
    algorithm,
    key_id: requireNonEmptyString(value.key_id, `${label}.key_id`),
    payload_hash: normalizeSha256(value.payload_hash, `${label}.payload_hash`),
    signature,
  };
}

function validateHostApprovalAttestation(receipt, trustedHostKeys = []) {
  const errors = [];
  let attestation;
  try {
    attestation = normalizeHostApprovalAttestation(receipt.attestation, "host_approval_receipt.attestation");
  } catch (error) {
    return [`host approval attestation is required and invalid: ${error.message}`];
  }
  const expectedPayloadHash = computeHostApprovalAttestationPayloadHash(receipt);
  if (attestation.payload_hash !== expectedPayloadHash) {
    errors.push("host approval attestation payload_hash does not match canonical unsigned receipt content");
  }
  if (!Array.isArray(trustedHostKeys) || trustedHostKeys.length === 0) {
    errors.push("host approval has no configured trusted_host_keys trust root");
    return errors;
  }
  const matchingKeys = trustedHostKeys.filter((candidate) => candidate?.key_id === attestation.key_id);
  if (matchingKeys.length !== 1) {
    errors.push(`host approval key_id '${attestation.key_id}' does not resolve to exactly one trusted host key`);
    return errors;
  }
  const trustedKey = matchingKeys[0];
  if (trustedKey.algorithm !== "Ed25519") {
    errors.push(`trusted host key '${attestation.key_id}' must use Ed25519`);
    return errors;
  }
  let publicKey;
  try {
    publicKey = crypto.createPublicKey(trustedKey.public_key);
  } catch (error) {
    errors.push(`trusted host key '${attestation.key_id}' is invalid: ${error.message}`);
    return errors;
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    errors.push(`trusted host key '${attestation.key_id}' is not an Ed25519 public key`);
    return errors;
  }
  let signature;
  try {
    signature = Buffer.from(attestation.signature, "base64");
    if (signature.length !== 64 || signature.toString("base64") !== attestation.signature) {
      errors.push("host approval attestation signature is not a canonical Ed25519 signature");
      return errors;
    }
  } catch (error) {
    errors.push(`host approval attestation signature cannot be decoded: ${error.message}`);
    return errors;
  }
  if (!crypto.verify(null, Buffer.from(attestation.payload_hash, "hex"), publicKey, signature)) {
    errors.push("host approval attestation signature is not valid for the trusted host key");
  }
  return errors;
}

function validateHostQuestionContractMinimum(questionContract) {
  if (!isPlainRecord(questionContract)) {
    return ["host approval question_contract must be an object"];
  }
  const errors = [];
  for (const field of ["asked", "why"]) {
    if (typeof questionContract[field] !== "string" || questionContract[field].trim() === "") {
      errors.push(`host approval question_contract.${field} must be a non-empty string`);
    }
  }
  for (const field of ["authorizes", "does_not_authorize"]) {
    if (!Array.isArray(questionContract[field]) || questionContract[field].length === 0 ||
        questionContract[field].some((value) => typeof value !== "string" || value.trim() === "")) {
      errors.push(`host approval question_contract.${field} must contain at least one non-empty string`);
    }
  }
  if (!isPlainRecord(questionContract.examples) || Object.keys(questionContract.examples).length === 0) {
    errors.push("host approval question_contract.examples must contain at least one example set");
  } else if (Object.entries(questionContract.examples).some(([, values]) =>
    !Array.isArray(values) || values.length === 0 ||
    values.some((value) => typeof value !== "string" || value.trim() === ""))) {
    errors.push("host approval question_contract.examples entries must contain at least one non-empty string");
  }
  return errors;
}

function normalizeHostConstraints(value, subjectHash) {
  const constraints = normalizeRecordRequired(value, "host_approval.constraints");
  const unsupported = Object.keys(constraints).filter((field) => !HOST_CONSTRAINT_FIELDS.has(field));
  if (unsupported.length > 0) {
    throw new DomainValidationError(
      `host_approval.constraints contains unsupported fields that cannot be enforced: ${unsupported.join(", ")}`,
    );
  }
  const constraintSubjectHash = normalizeSha256(
    constraints.subject_hash,
    "host_approval.constraints.subject_hash",
  );
  if (constraintSubjectHash !== subjectHash) {
    throw new DomainValidationError("host_approval.constraints.subject_hash must match host_approval.subject_hash");
  }
  for (const field of ["no_scope_expansion", "no_budget_extension", "no_production_access", "no_external_access"]) {
    if (constraints[field] !== undefined && typeof constraints[field] !== "boolean") {
      throw new DomainValidationError(`host_approval.constraints.${field} must be a boolean`);
    }
  }
  if (constraints.max_authorization_ttl_seconds !== undefined &&
      (!Number.isInteger(constraints.max_authorization_ttl_seconds) || constraints.max_authorization_ttl_seconds < 1)) {
    throw new DomainValidationError("host_approval.constraints.max_authorization_ttl_seconds must be a positive integer");
  }
  return { ...constraints, subject_hash: constraintSubjectHash };
}

function normalizeSha256(value, label) {
  const hash = requireNonEmptyString(value, label).toLowerCase();
  if (!SHA256_PATTERN.test(hash)) {
    throw new DomainValidationError(`${label} must be a lowercase SHA-256 hex digest`);
  }
  return hash;
}

function normalizeRecord(value, label) {
  if (value === undefined || value === null) {
    return {};
  }
  requirePlainRecord(value, label);
  return cloneJson(value);
}

function normalizeRecordRequired(value, label) {
  requirePlainRecord(value, label);
  if (Object.keys(value).length === 0) {
    throw new DomainValidationError(`${label} must not be empty`);
  }
  return cloneJson(value);
}

function normalizeArray(value, label) {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new DomainValidationError(`${label} must be an array`);
  }
  return cloneJson(value);
}

function normalizeNullableRecord(value, label) {
  if (value === undefined || value === null) {
    return null;
  }
  return normalizeRecord(value, label);
}

function normalizeNullableJson(value, label) {
  if (value === undefined || value === null) {
    return null;
  }
  try {
    return cloneJson(value);
  } catch (error) {
    throw new DomainValidationError(`${label} must be canonical JSON: ${error.message}`);
  }
}

function normalizeHostQuestionContract(input) {
  if (input.question_contract !== undefined && input.question_contract !== null) {
    return normalizeRecord(input.question_contract, "host_approval.question_contract");
  }
  const hasParts = ["question", "why", "authorizes", "excludes", "does_not_authorize", "examples"]
    .some((field) => input[field] !== undefined);
  if (!hasParts) {
    return null;
  }
  return {
    asked: normalizeOptionalString(input.question, "host_approval.question"),
    why: normalizeOptionalString(input.why, "host_approval.why"),
    authorizes: normalizeStringList(input.authorizes, "host_approval.authorizes", { sort: false }),
    does_not_authorize: normalizeStringList(
      input.does_not_authorize ?? input.excludes,
      "host_approval.does_not_authorize",
      { sort: false },
    ),
    examples: normalizeRecord(input.examples, "host_approval.examples"),
  };
}
