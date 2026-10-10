import {
  DomainValidationError,
  computeStableHash,
  immutableJson,
  normalizeIsoInstant,
  normalizeStringList,
  requireNonEmptyString,
  requirePlainRecord,
} from "./canonical.mjs";

const REQUIREMENT_V2 = "requirement:v2";
const LIFECYCLE_EVENT_V1 = "requirement-lifecycle-event:v1";
const VOLATILE_REQUIREMENT_FIELDS = new Set([
  "approvals",
  "audit",
  "created_at",
  "updated_at",
  "status",
]);

export function buildRequirementProposal(input) {
  requirePlainRecord(input, "requirement");
  const createdAt = normalizeIsoInstant(input.created_at, "requirement.created_at");
  const id = requireNonEmptyString(input.id, "requirement.id");
  const logicalId = requireNonEmptyString(input.logical_id ?? id, "requirement.logical_id");
  const revision = Number(input.revision ?? 1);
  if (!Number.isInteger(revision) || revision < 1) {
    throw new DomainValidationError("requirement.revision must be a positive integer");
  }
  const acceptanceCriteria = normalizeStringList(input.acceptance_criteria, "requirement.acceptance_criteria", { sort: false });
  if (acceptanceCriteria.length === 0) {
    throw new DomainValidationError("requirement.acceptance_criteria must contain at least one observable criterion");
  }
  const sourcePaths = normalizeStringList(input.source_paths, "requirement.source_paths", { sort: true });
  const sourceHashes = normalizeSourceHashes(input.source_hashes, sourcePaths);
  const proposal = {
    id,
    kind: "requirement",
    schema_version: REQUIREMENT_V2,
    logical_id: logicalId,
    revision,
    title: requireNonEmptyString(input.title, "requirement.title"),
    summary: requireNonEmptyString(input.summary, "requirement.summary"),
    status: "proposed",
    acceptance_criteria: acceptanceCriteria,
    non_goals: normalizeStringList(input.non_goals, "requirement.non_goals", { sort: false }),
    constraints: normalizeStringList(input.constraints, "requirement.constraints", { sort: false }),
    non_functional_requirements: normalizeStringList(
      input.non_functional_requirements,
      "requirement.non_functional_requirements",
      { sort: false },
    ),
    integrations: normalizeStringList(input.integrations, "requirement.integrations", { sort: false }),
    source_paths: sourcePaths,
    source_hashes: sourceHashes,
    proposal_ref: input.proposal_ref ?? null,
    previous_revision_ref: normalizePreviousRevisionRef(input.previous_revision_ref),
    autonomy_profile_id: requireNonEmptyString(input.autonomy_profile_id, "requirement.autonomy_profile_id"),
    approvals: [],
    created_at: createdAt,
    updated_at: createdAt,
    audit: input.audit ?? {},
  };
  // Additive fields: absent on records created before derived verification, so their hash is unchanged.
  if (input.derived_verification) {
    proposal.derived_acceptance = input.derived_acceptance ?? [];
    proposal.derived_verification = input.derived_verification;
  }
  return immutableJson(proposal);
}

export function buildRequirementRevision(current, input) {
  requirePlainRecord(current, "current_requirement");
  requirePlainRecord(input, "revision");
  if (current.schema_version !== REQUIREMENT_V2) {
    throw new DomainValidationError("Only requirement:v2 records can be revised through the immutable lifecycle");
  }
  const nextRevision = Number(current.revision) + 1;
  const path = requireNonEmptyString(input.previous_path, "revision.previous_path");
  return buildRequirementProposal({
    id: input.id,
    logical_id: current.logical_id,
    revision: nextRevision,
    title: input.title ?? current.title,
    summary: input.summary ?? current.summary,
    acceptance_criteria: input.acceptance_criteria ?? current.acceptance_criteria,
    non_goals: input.non_goals ?? current.non_goals,
    constraints: input.constraints ?? current.constraints,
    non_functional_requirements: input.non_functional_requirements ?? current.non_functional_requirements,
    integrations: input.integrations ?? current.integrations,
    source_paths: input.source_paths ?? current.source_paths,
    source_hashes: input.source_hashes ?? current.source_hashes,
    proposal_ref: input.proposal_ref ?? null,
    previous_revision_ref: buildRequirementRef(current, path),
    autonomy_profile_id: input.autonomy_profile_id,
    derived_acceptance: input.derived_acceptance,
    derived_verification: input.derived_verification,
    created_at: input.created_at,
    audit: input.audit,
  });
}

export function requirementContentHash(requirement) {
  requirePlainRecord(requirement, "requirement");
  const subject = {};
  for (const [key, value] of Object.entries(requirement)) {
    if (!VOLATILE_REQUIREMENT_FIELDS.has(key)) {
      subject[key] = value;
    }
  }
  return computeStableHash(subject);
}

export function buildRequirementRef(requirement, relativePath) {
  return immutableJson({
    id: requireNonEmptyString(requirement?.id, "requirement.id"),
    path: requireNonEmptyString(relativePath, "requirement.path"),
    content_hash: requirementContentHash(requirement),
    revision: normalizeRevision(requirement?.revision),
  });
}

export function buildRequirementSupersession(input) {
  requirePlainRecord(input, "requirement_supersession");
  const createdAt = normalizeIsoInstant(input.created_at, "requirement_supersession.created_at");
  const event = {
    id: requireNonEmptyString(input.id, "requirement_supersession.id"),
    kind: "requirement_lifecycle_event",
    schema_version: LIFECYCLE_EVENT_V1,
    event: "superseded",
    requirement_ref: normalizeRequirementRef(input.requirement_ref, "requirement_supersession.requirement_ref"),
    replacement_ref: normalizeRequirementRef(input.replacement_ref, "requirement_supersession.replacement_ref"),
    reason: requireNonEmptyString(input.reason, "requirement_supersession.reason"),
    approval: input.approval ?? {},
    created_at: createdAt,
    audit: input.audit ?? {},
  };
  if (event.requirement_ref.id === event.replacement_ref.id) {
    throw new DomainValidationError("A requirement revision cannot supersede itself");
  }
  return immutableJson(event);
}

export function validateRequirementIntegrity(requirement) {
  const errors = [];
  try {
    if (requirement?.schema_version !== REQUIREMENT_V2) {
      errors.push("requirement.schema_version must be 'requirement:v2'");
      return Object.freeze({ valid: false, errors: Object.freeze(errors) });
    }
    const rebuilt = buildRequirementProposal({
      ...requirement,
      status: "proposed",
      approvals: [],
      created_at: requirement.created_at,
    });
    if (requirementContentHash(rebuilt) !== requirementContentHash(requirement)) {
      errors.push("requirement content is not canonical");
    }
  } catch (error) {
    errors.push(error.message);
  }
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

function normalizeSourceHashes(value, sourcePaths) {
  const hashes = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const normalized = {};
  for (const sourcePath of sourcePaths) {
    const hash = hashes[sourcePath];
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) {
      throw new DomainValidationError(`requirement.source_hashes is missing a SHA-256 digest for ${sourcePath}`);
    }
    normalized[sourcePath] = hash;
  }
  for (const key of Object.keys(hashes)) {
    if (!sourcePaths.includes(key)) {
      throw new DomainValidationError(`requirement.source_hashes contains unreferenced path ${key}`);
    }
  }
  return normalized;
}

function normalizePreviousRevisionRef(value) {
  if (value === undefined || value === null) return null;
  return normalizeRequirementRef(value, "requirement.previous_revision_ref");
}

function normalizeRequirementRef(value, label) {
  requirePlainRecord(value, label);
  const contentHash = requireNonEmptyString(value.content_hash, `${label}.content_hash`);
  if (!/^[a-f0-9]{64}$/.test(contentHash)) {
    throw new DomainValidationError(`${label}.content_hash must be a lowercase SHA-256 digest`);
  }
  return {
    id: requireNonEmptyString(value.id, `${label}.id`),
    path: requireNonEmptyString(value.path, `${label}.path`),
    content_hash: contentHash,
    revision: normalizeRevision(value.revision),
  };
}

function normalizeRevision(value) {
  const revision = Number(value ?? 1);
  if (!Number.isInteger(revision) || revision < 1) {
    throw new DomainValidationError("requirement revision must be a positive integer");
  }
  return revision;
}
