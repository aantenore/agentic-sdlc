import {
  DomainValidationError,
  STABLE_JSON_HASH_ALGORITHM,
  canonicalJson,
  computeStableHash,
  immutableJson,
  isDeepFrozen,
  isPlainRecord,
  normalizeIsoInstant,
  normalizeStringList,
  requireNonEmptyString,
  requirePlainRecord,
} from "./canonical.mjs";

export const EXECUTION_CONTEXT_PREFLIGHT_SCHEMA = "execution-context-preflight-receipt:v1";

const SHA256 = /^[a-f0-9]{64}$/u;
const SOURCE_DISPOSITIONS = new Set(["authorized_evolution", "immutable_context"]);
const WORKSPACE_FILE_TYPES = new Set(["regular", "symlink", "missing"]);

/**
 * Seal the exact source state that was checked immediately before task start.
 *
 * Callers retain responsibility for safe filesystem reads. This module is
 * deliberately pure so the same classification and integrity rules can be
 * exercised by the CLI, gates, and unit tests.
 */
export function buildExecutionContextPreflightReceipt(input) {
  requirePlainRecord(input, "execution_context_preflight_input");
  const storyRef = normalizeHashedRef(input.story_ref, "execution_context_preflight_input.story_ref");
  const contractRef = normalizeHashedRef(input.contract_ref, "execution_context_preflight_input.contract_ref");
  const deliveryProfileRef = normalizeHashedRef(
    input.delivery_profile_ref,
    "execution_context_preflight_input.delivery_profile_ref",
  );
  const requirementScopes = normalizeRequirementScopes(input.requirement_scopes);
  if (requirementScopes.length === 0) {
    throw new DomainValidationError(
      "execution_context_preflight_input.requirement_scopes must contain at least one approved requirement scope",
    );
  }
  const sources = normalizeSources(input.sources, requirementScopes);
  const workspaceChanges = normalizeWorkspaceChanges(input.workspace_changes);
  const createdAt = normalizeIsoInstant(
    input.created_at,
    "execution_context_preflight_input.created_at",
  );
  const createdBy = requirePlainRecord(
    input.created_by,
    "execution_context_preflight_input.created_by",
  );
  const audit = requirePlainRecord(input.audit, "execution_context_preflight_input.audit");
  const receipt = {
    id: requireNonEmptyString(input.id, "execution_context_preflight_input.id"),
    kind: "execution_context_preflight_receipt",
    schema_version: EXECUTION_CONTEXT_PREFLIGHT_SCHEMA,
    story_ref: storyRef,
    contract_ref: contractRef,
    delivery_profile_ref: deliveryProfileRef,
    requirement_scopes: requirementScopes,
    source_snapshots: sources,
    workspace_changes: workspaceChanges,
    ...normalizeGitBase(input),
    status: "passed",
    created_by: immutableJson(createdBy),
    created_at: createdAt,
    audit: immutableJson(audit),
    hash_algorithm: STABLE_JSON_HASH_ALGORITHM,
  };
  return immutableJson({
    ...receipt,
    receipt_hash: computeExecutionContextPreflightHash(receipt),
  });
}

export function computeExecutionContextPreflightHash(receipt) {
  requirePlainRecord(receipt, "execution_context_preflight_receipt");
  const {
    receipt_hash: ignoredReceiptHash,
    hash_algorithm: ignoredHashAlgorithm,
    ...subject
  } = receipt;
  return computeStableHash(subject);
}

const validationMemo = new WeakMap();

export function validateExecutionContextPreflightReceipt(receipt, expected = {}) {
  if (!isDeepFrozen(receipt)) {
    return validateExecutionContextPreflightReceiptUncached(receipt, expected);
  }
  const key = canonicalJson(expected);
  let byExpected = validationMemo.get(receipt);
  if (!byExpected) {
    byExpected = new Map();
    validationMemo.set(receipt, byExpected);
  }
  if (!byExpected.has(key)) {
    byExpected.set(key, validateExecutionContextPreflightReceiptUncached(receipt, expected));
  }
  return byExpected.get(key);
}

function validateExecutionContextPreflightReceiptUncached(receipt, expected) {
  const errors = [];
  if (!isPlainRecord(receipt)) {
    return immutableJson({ valid: false, errors: ["execution context preflight receipt must be an object"] });
  }
  if (receipt.kind !== "execution_context_preflight_receipt") {
    errors.push("execution context preflight receipt kind is invalid");
  }
  if (receipt.schema_version !== EXECUTION_CONTEXT_PREFLIGHT_SCHEMA) {
    errors.push(`execution context preflight schema must be '${EXECUTION_CONTEXT_PREFLIGHT_SCHEMA}'`);
  }
  if (receipt.status !== "passed") {
    errors.push("execution context preflight status must be passed");
  }
  if (receipt.hash_algorithm !== STABLE_JSON_HASH_ALGORITHM) {
    errors.push(`execution context preflight hash_algorithm must be '${STABLE_JSON_HASH_ALGORITHM}'`);
  }
  const gitObjectId = /^[a-f0-9]{40,64}$/u;
  if (receipt.git_head_sha === null) {
    if (!gitObjectId.test(receipt.git_base_tree || "")) {
      errors.push("execution context preflight without a Git commit must name the empty tree base");
    }
  } else if (!gitObjectId.test(receipt.git_head_sha || "") || receipt.git_base_tree !== undefined) {
    errors.push("execution context preflight Git base is invalid");
  }
  for (const [field, expectedRef] of [
    ["story_ref", expected.story_ref],
    ["contract_ref", expected.contract_ref],
    ["delivery_profile_ref", expected.delivery_profile_ref],
  ]) {
    const actualRef = receipt[field];
    if (!validHashedRef(actualRef)) {
      errors.push(`execution context preflight ${field} is invalid`);
    } else if (
      expectedRef
      && (
        actualRef.id !== expectedRef.id
        || actualRef.path !== expectedRef.path
        || actualRef.hash !== expectedRef.hash
      )
    ) {
      errors.push(`execution context preflight ${field} is bound to different content`);
    }
  }
  if (!Array.isArray(receipt.requirement_scopes) || receipt.requirement_scopes.length === 0) {
    errors.push("execution context preflight requirement_scopes is empty");
  }
  if (!Array.isArray(receipt.source_snapshots)) {
    errors.push("execution context preflight source_snapshots must be an array");
  } else {
    const paths = new Set();
    for (const source of receipt.source_snapshots) {
      if (!isPlainRecord(source) || typeof source.path !== "string" || !SHA256.test(source.sha256 || "")) {
        errors.push("execution context preflight contains an invalid source snapshot");
        continue;
      }
      if (paths.has(source.path)) errors.push(`execution context preflight duplicates source ${source.path}`);
      paths.add(source.path);
      if (!SOURCE_DISPOSITIONS.has(source.disposition)) {
        errors.push(`execution context preflight source ${source.path} has invalid disposition`);
      }
      if (
        source.file_type !== undefined
        || source.mode !== undefined
      ) {
        if (source.file_type !== "regular" || !validFileMode(source.mode)) {
          errors.push(`execution context preflight source ${source.path} has invalid stable file identity`);
        }
      }
      if (!Array.isArray(source.bindings) || source.bindings.length === 0) {
        errors.push(`execution context preflight source ${source.path} has no canonical bindings`);
      } else if (source.bindings.some((binding) => (
        !isPlainRecord(binding)
        || typeof binding.kind !== "string"
        || typeof binding.id !== "string"
        || typeof binding.record_path !== "string"
        || !SHA256.test(binding.expected_sha256 || "")
        || binding.expected_sha256 !== source.sha256
      ))) {
        errors.push(`execution context preflight source ${source.path} has an invalid canonical binding`);
      }
    }
  }
  if (!Array.isArray(receipt.workspace_changes)) {
    errors.push("execution context preflight workspace_changes must be an array");
  } else {
    const paths = new Set();
    for (const entry of receipt.workspace_changes) {
      if (
        !isPlainRecord(entry)
        || typeof entry.path !== "string"
        || typeof entry.status !== "string"
        || (
          entry.content_sha256 !== null
          && !SHA256.test(entry.content_sha256 || "")
        )
      ) {
        errors.push("execution context preflight contains an invalid workspace change");
        continue;
      }
      if (paths.has(entry.path)) {
        errors.push(`execution context preflight duplicates workspace change ${entry.path}`);
      }
      paths.add(entry.path);
      if (
        entry.file_type !== undefined
        || entry.mode !== undefined
      ) {
        if (
          !WORKSPACE_FILE_TYPES.has(entry.file_type)
          || !validWorkspaceIdentity(entry)
        ) {
          errors.push(`execution context preflight workspace change ${entry.path} has invalid stable identity`);
        }
      }
    }
  }
  let expectedHash = null;
  try {
    expectedHash = computeExecutionContextPreflightHash(receipt);
  } catch (error) {
    errors.push(`execution context preflight cannot be hashed: ${error.message}`);
  }
  if (!SHA256.test(receipt.receipt_hash || "")) {
    errors.push("execution context preflight receipt_hash is invalid");
  } else if (expectedHash !== receipt.receipt_hash) {
    errors.push("execution context preflight receipt_hash does not match its content");
  }
  return immutableJson({ valid: errors.length === 0, errors, expected_hash: expectedHash });
}

/**
 * Decide whether one changed source is explicitly covered by the immutable
 * pre-change snapshot. A hash mismatch alone never grants evolution.
 */
export function executionContextSourceEvolutionDecision(receipt, expected) {
  const integrity = validateExecutionContextPreflightReceipt(receipt, expected);
  if (!integrity.valid) {
    return immutableJson({ allowed: false, reason: "preflight_invalid", errors: integrity.errors });
  }
  const sourcePath = normalizeProjectPath(expected.path);
  const snapshot = receipt.source_snapshots.find((item) => item.path === sourcePath);
  if (!snapshot) {
    return immutableJson({ allowed: false, reason: "source_not_snapshotted", errors: [] });
  }
  const binding = snapshot.bindings.find((item) => (
    item.kind === expected.binding_kind
    && item.id === expected.binding_id
    && item.expected_sha256 === expected.expected_sha256
  ));
  if (!binding) {
    return immutableJson({ allowed: false, reason: "source_binding_mismatch", errors: [] });
  }
  if (snapshot.disposition !== "authorized_evolution") {
    return immutableJson({ allowed: false, reason: "source_is_immutable_context", errors: [] });
  }
  if (snapshot.file_type !== "regular" || !validFileMode(snapshot.mode)) {
    return immutableJson({
      allowed: false,
      reason: "source_snapshot_lacks_stable_identity",
      errors: ["mutable context requires a symlink-free regular-file snapshot with mode metadata"],
    });
  }
  return immutableJson({
    allowed: true,
    reason: "authorized_post_start_evolution",
    snapshot_sha256: snapshot.sha256,
  });
}

/**
 * Decide whether a file that a baseline's discovery scope now finds, but whose
 * hash the baseline never recorded, was created by the started task. Task
 * preflight refuses uncovered files, so a file absent from the sealed snapshot
 * and from the pre-existing workspace changes appeared after start; it is
 * accepted only inside every applicable requirement write scope.
 */
export function executionContextNewSourceDecision(receipt, expected) {
  const integrity = validateExecutionContextPreflightReceipt(receipt, expected);
  if (!integrity.valid) {
    return immutableJson({ allowed: false, reason: "preflight_invalid", errors: integrity.errors });
  }
  const sourcePath = normalizeProjectPath(expected.path);
  if (receipt.source_snapshots.some((item) => item.path === sourcePath)) {
    return immutableJson({ allowed: false, reason: "source_was_snapshotted", errors: [] });
  }
  if (receipt.workspace_changes.some((item) => item.path === sourcePath)) {
    return immutableJson({ allowed: false, reason: "source_predates_start", errors: [] });
  }
  const inScope = receipt.requirement_scopes.length > 0 && receipt.requirement_scopes.every((scope) => (
    scope.allowed_write_paths.length > 0
    && pathMatchesScope(sourcePath, scope.allowed_write_paths)
  ));
  return immutableJson(inScope
    ? { allowed: true, reason: "authorized_post_start_creation", errors: [] }
    : { allowed: false, reason: "outside_requirement_write_scope", errors: [] });
}

export function workspaceChangeMatchesPreflight(receipt, current) {
  const integrity = validateExecutionContextPreflightReceipt(receipt);
  if (!integrity.valid) return false;
  const path = normalizeProjectPath(current.path);
  const snapshot = receipt.workspace_changes.find((item) => item.path === path);
  return Boolean(
    snapshot
    && WORKSPACE_FILE_TYPES.has(snapshot.file_type)
    && validWorkspaceIdentity(snapshot)
    && snapshot.file_type === current.file_type
    && snapshot.mode === current.mode
    && snapshot.status === current.status
    && snapshot.content_sha256 === (current.content_sha256 ?? null),
  );
}

export function executionContextSnapshotRevalidationDecision(receipt, current) {
  const integrity = validateExecutionContextPreflightReceipt(receipt);
  if (!integrity.valid) {
    return immutableJson({ valid: false, errors: integrity.errors });
  }
  requirePlainRecord(current, "execution_context_current_snapshot");
  const errors = [];
  if (
    current.git_head_sha !== receipt.git_head_sha
    || (current.git_base_tree ?? null) !== (receipt.git_base_tree ?? null)
  ) {
    errors.push("Git HEAD changed while sealing execution context");
  }
  const currentSources = new Map(
    (current.source_snapshots || []).map((source) => [normalizeProjectPath(source.path), source]),
  );
  for (const source of receipt.source_snapshots || []) {
    const observed = currentSources.get(source.path);
    if (!observed) {
      errors.push(`execution context source disappeared while sealing: ${source.path}`);
      continue;
    }
    if (
      observed.sha256 !== source.sha256
      || observed.file_type !== source.file_type
      || observed.mode !== source.mode
    ) {
      errors.push(`execution context source changed while sealing: ${source.path}`);
    }
  }
  let currentWorkspace = [];
  try {
    currentWorkspace = normalizeWorkspaceChanges(current.workspace_changes);
  } catch (error) {
    errors.push(`workspace changed while sealing: ${error.message}`);
  }
  if (
    errors.length === 0
    && computeStableHash(currentWorkspace) !== computeStableHash(receipt.workspace_changes)
  ) {
    errors.push("workspace status or file identity changed while sealing execution context");
  }
  return immutableJson({ valid: errors.length === 0, errors });
}

function normalizeSources(values, requirementScopes) {
  if (!Array.isArray(values)) {
    throw new DomainValidationError("execution_context_preflight_input.sources must be an array");
  }
  const grouped = new Map();
  for (const [index, raw] of values.entries()) {
    requirePlainRecord(raw, `execution_context_preflight_input.sources[${index}]`);
    const path = normalizeProjectPath(
      requireNonEmptyString(raw.path, `execution_context_preflight_input.sources[${index}].path`),
    );
    const sha256 = normalizeSha256(raw.sha256, `execution_context_preflight_input.sources[${index}].sha256`);
    const binding = normalizeSourceBinding(
      raw.binding,
      `execution_context_preflight_input.sources[${index}].binding`,
    );
    if (binding.expected_sha256 !== sha256) {
      throw new DomainValidationError(
        `execution context changed before task start: ${path} no longer matches ${binding.kind} ${binding.id}`,
      );
    }
    const existing = grouped.get(path);
    if (existing && existing.sha256 !== sha256) {
      throw new DomainValidationError(`execution context has conflicting approved hashes for ${path}`);
    }
    const entry = existing || { path, sha256, bindings: [] };
    const fileType = requireNonEmptyString(
      raw.file_type,
      `execution_context_preflight_input.sources[${index}].file_type`,
    );
    const mode = normalizeFileMode(
      raw.mode,
      `execution_context_preflight_input.sources[${index}].mode`,
    );
    if (fileType !== "regular") {
      throw new DomainValidationError(
        `execution_context_preflight_input.sources[${index}] must be a symlink-free regular file`,
      );
    }
    if (
      existing
      && (
        existing.file_type !== fileType
        || existing.mode !== mode
      )
    ) {
      throw new DomainValidationError(`execution context has conflicting file identities for ${path}`);
    }
    entry.file_type = fileType;
    entry.mode = mode;
    if (!entry.bindings.some((item) => (
      item.kind === binding.kind
      && item.id === binding.id
      && item.record_path === binding.record_path
      && item.expected_sha256 === binding.expected_sha256
    ))) {
      entry.bindings.push(binding);
    }
    grouped.set(path, entry);
  }
  return [...grouped.values()]
    .map((entry) => ({
      ...entry,
      bindings: entry.bindings.sort(compareBindings),
      disposition: requirementScopes.every((scope) => (
        scope.allowed_write_paths.length > 0
        && pathMatchesScope(entry.path, scope.allowed_write_paths)
      ))
        ? "authorized_evolution"
        : "immutable_context",
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function normalizeRequirementScopes(values) {
  if (!Array.isArray(values)) {
    throw new DomainValidationError("execution_context_preflight_input.requirement_scopes must be an array");
  }
  return values.map((raw, index) => {
    requirePlainRecord(raw, `execution_context_preflight_input.requirement_scopes[${index}]`);
    return {
      profile_ref: normalizeHashedRef(
        raw.profile_ref,
        `execution_context_preflight_input.requirement_scopes[${index}].profile_ref`,
      ),
      allowed_write_paths: normalizeStringList(
        raw.allowed_write_paths,
        `execution_context_preflight_input.requirement_scopes[${index}].allowed_write_paths`,
      ).map(normalizeProjectPath),
    };
  }).sort((left, right) => left.profile_ref.id.localeCompare(right.profile_ref.id));
}

function normalizeWorkspaceChanges(values) {
  if (!Array.isArray(values)) {
    throw new DomainValidationError("execution_context_preflight_input.workspace_changes must be an array");
  }
  return values.map((raw, index) => {
    requirePlainRecord(raw, `execution_context_preflight_input.workspace_changes[${index}]`);
    const contentSha256 = raw.content_sha256 === null
      ? null
      : normalizeSha256(
          raw.content_sha256,
          `execution_context_preflight_input.workspace_changes[${index}].content_sha256`,
        );
    return {
      path: normalizeProjectPath(
        requireNonEmptyString(raw.path, `execution_context_preflight_input.workspace_changes[${index}].path`),
      ),
      status: normalizeWorkspaceStatus(
        raw.status,
        `execution_context_preflight_input.workspace_changes[${index}].status`,
      ),
      file_type: normalizeWorkspaceFileType(
        raw.file_type,
        `execution_context_preflight_input.workspace_changes[${index}].file_type`,
      ),
      mode: normalizeWorkspaceMode(
        raw.file_type,
        raw.mode,
        `execution_context_preflight_input.workspace_changes[${index}].mode`,
      ),
      content_sha256: contentSha256,
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

function normalizeWorkspaceStatus(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new DomainValidationError(`${label} must be a non-empty string`);
  }
  // Git porcelain v1 uses the two status columns positionally. In particular,
  // " M" and "M " describe different index/worktree states, so trimming here
  // would weaken the exact pre-start dirty-worktree snapshot.
  return value;
}

function normalizeWorkspaceFileType(value, label) {
  const normalized = requireNonEmptyString(value, label);
  if (!WORKSPACE_FILE_TYPES.has(normalized)) {
    throw new DomainValidationError(`${label} must be regular, symlink, or missing`);
  }
  return normalized;
}

function normalizeWorkspaceMode(fileType, value, label) {
  if (fileType === "missing") {
    if (value !== null) {
      throw new DomainValidationError(`${label} must be null for a missing path`);
    }
    return null;
  }
  return normalizeFileMode(value, label);
}

function normalizeFileMode(value, label) {
  if (!validFileMode(value)) {
    throw new DomainValidationError(`${label} must be an integer Unix mode between 0 and 4095`);
  }
  return value;
}

function validFileMode(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 0o7777;
}

function validWorkspaceIdentity(entry) {
  if (entry.file_type === "missing") {
    return entry.mode === null && entry.content_sha256 === null;
  }
  return validFileMode(entry.mode) && SHA256.test(entry.content_sha256 || "");
}

function normalizeSourceBinding(raw, label) {
  requirePlainRecord(raw, label);
  return {
    kind: requireNonEmptyString(raw.kind, `${label}.kind`),
    id: requireNonEmptyString(raw.id, `${label}.id`),
    record_path: normalizeProjectPath(requireNonEmptyString(raw.record_path, `${label}.record_path`)),
    expected_sha256: normalizeSha256(raw.expected_sha256, `${label}.expected_sha256`),
  };
}

function normalizeHashedRef(raw, label) {
  requirePlainRecord(raw, label);
  return {
    id: requireNonEmptyString(raw.id, `${label}.id`),
    path: normalizeProjectPath(requireNonEmptyString(raw.path, `${label}.path`)),
    hash: normalizeSha256(raw.hash, `${label}.hash`),
  };
}

function validHashedRef(ref) {
  return isPlainRecord(ref)
    && typeof ref.id === "string"
    && ref.id.length > 0
    && typeof ref.path === "string"
    && ref.path.length > 0
    && SHA256.test(ref.hash || "");
}

function normalizeSha256(value, label) {
  const normalized = requireNonEmptyString(value, label).toLowerCase();
  if (!SHA256.test(normalized)) throw new DomainValidationError(`${label} must be a SHA-256 digest`);
  return normalized;
}

// A preflight names the commit HEAD pointed at, or on an unborn HEAD no commit
// and Git's empty tree as the explicit base.
function normalizeGitBase(input) {
  const hasTree = input.git_base_tree !== undefined && input.git_base_tree !== null;
  if (input.git_head_sha === null || input.git_head_sha === undefined) {
    if (!hasTree) {
      throw new DomainValidationError(
        "execution_context_preflight_input.git_head_sha must be a full Git commit SHA, "
        + "or git_base_tree must name the empty tree of an unborn HEAD",
      );
    }
    return {
      git_head_sha: null,
      git_base_tree: normalizeSha256OrGitSha(
        input.git_base_tree,
        "execution_context_preflight_input.git_base_tree",
      ),
    };
  }
  if (hasTree) {
    throw new DomainValidationError(
      "execution_context_preflight_input.git_base_tree is only valid without a Git commit SHA",
    );
  }
  return {
    git_head_sha: normalizeSha256OrGitSha(
      input.git_head_sha,
      "execution_context_preflight_input.git_head_sha",
    ),
  };
}

function normalizeSha256OrGitSha(value, label) {
  const normalized = requireNonEmptyString(value, label).toLowerCase();
  if (!/^[a-f0-9]{40,64}$/u.test(normalized)) {
    throw new DomainValidationError(`${label} must be a full Git commit SHA`);
  }
  return normalized;
}

function normalizeProjectPath(value) {
  return String(value || "")
    .replaceAll("\\", "/")
    .replace(/^(?:\.\/)+/u, "")
    .replace(/\/+$/u, "");
}

function pathMatchesScope(sourcePath, allowedPaths) {
  return allowedPaths.some((allowedPath) => (
    sourcePath === allowedPath || sourcePath.startsWith(`${allowedPath}/`)
  ));
}

function compareBindings(left, right) {
  return `${left.kind}\u0000${left.id}\u0000${left.record_path}`
    .localeCompare(`${right.kind}\u0000${right.id}\u0000${right.record_path}`);
}
