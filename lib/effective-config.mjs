import {
  STABLE_JSON_HASH_ALGORITHM,
  cloneJson,
  compareCanonicalStrings,
  computeStableHash,
  immutableJson,
  isPlainRecord,
  normalizeIsoInstant,
  requireNonEmptyString,
  requirePlainRecord,
} from "./canonical.mjs";

export const EFFECTIVE_CONFIG_LOCK_SCHEMA_VERSION = "effective-config-lock:v1";
export const CONFIG_MIGRATION_PLAN_SCHEMA_VERSION = "config-migration-plan:v1";
export const CONFIG_MIGRATION_RECEIPT_SCHEMA_VERSION = "config-migration-receipt:v1";
export const DEFAULT_CONFIG_PATH = ".sdlc/config.json";
export const DEFAULT_CONFIG_LOCK_PATH = ".sdlc/config.lock.json";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export function resolveEffectiveConfig(input) {
  requirePlainRecord(input, "effective_config_input");
  const projectConfig = requirePlainRecord(input.project_config, "effective_config_input.project_config");
  const configPath = normalizeProjectPath(input.config_path ?? DEFAULT_CONFIG_PATH, "effective_config_input.config_path");
  const rawConfig = cloneJson(projectConfig);
  const rawConfigHash = computeStableHash(rawConfig);

  if (input.lock !== undefined && input.lock !== null) {
    const verification = verifyEffectiveConfigLock({
      lock: input.lock,
      project_config: rawConfig,
      config_path: configPath,
    });
    return immutableJson({
      status: verification.valid ? "locked" : verification.status,
      migration_required: !verification.valid,
      mutation_allowed: verification.valid,
      config_path: configPath,
      raw_config: rawConfig,
      effective_config: rawConfig,
      raw_config_hash: rawConfigHash,
      effective_config_hash: rawConfigHash,
      defaults_profile: verification.defaults_profile,
      inherited_paths: verification.inherited_paths,
      lock_verification: verification,
    });
  }

  const legacyDefaults = requirePlainRecord(
    input.legacy_defaults,
    "effective_config_input.legacy_defaults",
  );
  const defaultsProfile = normalizeDefaultsProfile(
    input.defaults_profile,
    legacyDefaults,
    "effective_config_input.defaults_profile",
  );
  const merged = mergeMissingDefaults(rawConfig, legacyDefaults, "");
  return immutableJson({
    status: "legacy_compat",
    migration_required: true,
    mutation_allowed: true,
    config_path: configPath,
    raw_config: rawConfig,
    effective_config: merged.value,
    raw_config_hash: rawConfigHash,
    effective_config_hash: computeStableHash(merged.value),
    defaults_profile: defaultsProfile,
    inherited_paths: merged.inheritedPaths,
    lock_verification: null,
  });
}

export function buildEffectiveConfigLock(input) {
  requirePlainRecord(input, "effective_config_lock_input");
  const effectiveConfig = requirePlainRecord(
    input.effective_config,
    "effective_config_lock_input.effective_config",
  );
  const configPath = normalizeProjectPath(
    input.config_path ?? DEFAULT_CONFIG_PATH,
    "effective_config_lock_input.config_path",
  );
  const defaultsProfile = normalizeDefaultsProfile(
    input.defaults_profile,
    null,
    "effective_config_lock_input.defaults_profile",
  );
  const inheritedPaths = normalizePointerList(
    input.inherited_paths ?? [],
    "effective_config_lock_input.inherited_paths",
  );
  const createdAt = normalizeIsoInstant(input.created_at, "effective_config_lock_input.created_at");
  const configHash = computeStableHash(effectiveConfig);
  const subject = {
    kind: "effective_config_lock",
    schema_version: EFFECTIVE_CONFIG_LOCK_SCHEMA_VERSION,
    config_path: configPath,
    config_hash: configHash,
    effective_config_hash: configHash,
    defaults_profile: defaultsProfile,
    inherited_paths: inheritedPaths,
    created_at: createdAt,
    hash_algorithm: STABLE_JSON_HASH_ALGORITHM,
  };
  return immutableJson({
    ...subject,
    lock_hash: computeStableHash(subject),
  });
}

export function verifyEffectiveConfigLock(input) {
  requirePlainRecord(input, "effective_config_lock_verification_input");
  const projectConfig = requirePlainRecord(
    input.project_config,
    "effective_config_lock_verification_input.project_config",
  );
  const expectedConfigPath = normalizeProjectPath(
    input.config_path ?? DEFAULT_CONFIG_PATH,
    "effective_config_lock_verification_input.config_path",
  );
  const lock = input.lock;
  const errors = [];
  if (!isPlainRecord(lock)) {
    return immutableJson({
      valid: false,
      status: "invalid",
      errors: [{ code: "lock_not_object", path: "$", message: "Effective config lock must be an object" }],
      expected_config_hash: computeStableHash(projectConfig),
      defaults_profile: null,
      inherited_paths: [],
    });
  }

  if (lock.kind !== "effective_config_lock") addIssue(errors, "kind_invalid", "/kind", "Lock kind is invalid");
  if (lock.schema_version !== EFFECTIVE_CONFIG_LOCK_SCHEMA_VERSION) {
    addIssue(errors, "schema_version_invalid", "/schema_version", "Lock schema version is unsupported");
  }
  if (lock.config_path !== expectedConfigPath) {
    addIssue(errors, "config_path_mismatch", "/config_path", "Lock is bound to another config path");
  }
  if (lock.hash_algorithm !== STABLE_JSON_HASH_ALGORITHM) {
    addIssue(errors, "hash_algorithm_invalid", "/hash_algorithm", "Lock hash algorithm is unsupported");
  }

  const expectedConfigHash = computeStableHash(projectConfig);
  if (lock.config_hash !== expectedConfigHash) {
    addIssue(errors, "config_hash_mismatch", "/config_hash", "Project config changed after the lock was created");
  }
  if (lock.effective_config_hash !== expectedConfigHash) {
    addIssue(
      errors,
      "effective_config_hash_mismatch",
      "/effective_config_hash",
      "Locked effective config does not match the materialized project config",
    );
  }

  let defaultsProfile = null;
  try {
    defaultsProfile = normalizeDefaultsProfile(lock.defaults_profile, null, "lock.defaults_profile");
  } catch (error) {
    addIssue(errors, "defaults_profile_invalid", "/defaults_profile", error.message);
  }
  let inheritedPaths = [];
  try {
    inheritedPaths = normalizePointerList(lock.inherited_paths, "lock.inherited_paths");
    if (JSON.stringify(inheritedPaths) !== JSON.stringify(lock.inherited_paths)) {
      addIssue(errors, "inherited_paths_not_canonical", "/inherited_paths", "Inherited paths must be sorted and unique");
    }
  } catch (error) {
    addIssue(errors, "inherited_paths_invalid", "/inherited_paths", error.message);
  }
  try {
    normalizeIsoInstant(lock.created_at, "lock.created_at");
  } catch (error) {
    addIssue(errors, "created_at_invalid", "/created_at", error.message);
  }

  if (!isSha256(lock.lock_hash)) {
    addIssue(errors, "lock_hash_invalid", "/lock_hash", "Lock hash must be a lowercase SHA-256 digest");
  } else {
    const { lock_hash: storedHash, ...subject } = lock;
    if (computeStableHash(subject) !== storedHash) {
      addIssue(errors, "lock_hash_mismatch", "/lock_hash", "Lock envelope hash is invalid");
    }
  }

  const driftCodes = new Set([
    "config_hash_mismatch",
    "effective_config_hash_mismatch",
  ]);
  const drifted = errors.length > 0 && errors.every((issue) => driftCodes.has(issue.code));
  return immutableJson({
    valid: errors.length === 0,
    status: errors.length === 0 ? "locked" : drifted ? "drifted" : "invalid",
    errors,
    expected_config_hash: expectedConfigHash,
    defaults_profile: defaultsProfile,
    inherited_paths: inheritedPaths,
  });
}

export function prepareConfigMigration(input) {
  requirePlainRecord(input, "config_migration_input");
  const projectConfig = requirePlainRecord(input.project_config, "config_migration_input.project_config");
  const configPath = normalizeProjectPath(input.config_path ?? DEFAULT_CONFIG_PATH, "config_migration_input.config_path");
  const lockPath = normalizeProjectPath(input.lock_path ?? DEFAULT_CONFIG_LOCK_PATH, "config_migration_input.lock_path");
  const rawConfig = cloneJson(projectConfig);
  const sourceConfigHash = computeStableHash(rawConfig);
  let targetConfig;
  let defaultsProfile;
  let inheritedPaths;
  let mode;
  let lockVerification = null;

  if (input.lock !== undefined && input.lock !== null) {
    lockVerification = verifyEffectiveConfigLock({
      lock: input.lock,
      project_config: rawConfig,
      config_path: configPath,
    });
    if (lockVerification.valid) {
      targetConfig = rawConfig;
      defaultsProfile = lockVerification.defaults_profile;
      inheritedPaths = lockVerification.inherited_paths;
      mode = "already_locked";
    } else if (lockVerification.status === "drifted") {
      targetConfig = rawConfig;
      defaultsProfile = normalizeDefaultsProfile(
        input.defaults_profile ?? input.lock.defaults_profile,
        input.legacy_defaults ?? null,
        "config_migration_input.defaults_profile",
      );
      inheritedPaths = [];
      mode = "reconcile_drift";
    } else {
      throw new TypeError("Cannot prepare a config migration from an invalid effective-config lock");
    }
  } else {
    const legacyDefaults = requirePlainRecord(input.legacy_defaults, "config_migration_input.legacy_defaults");
    defaultsProfile = normalizeDefaultsProfile(
      input.defaults_profile,
      legacyDefaults,
      "config_migration_input.defaults_profile",
    );
    const merged = mergeMissingDefaults(rawConfig, legacyDefaults, "");
    targetConfig = merged.value;
    inheritedPaths = merged.inheritedPaths;
    // mergeMissingDefaults only fills in missing object keys; phase_order is
    // an array, so a phase introduced by a newer bundled template (its own
    // key already merged into targetConfig.phases above) would otherwise be
    // silently absent from targetConfig.phase_order, an inconsistent target
    // config. Append any such phase, in the bundled template's order, without
    // touching the project's existing phase_order content or order.
    if (Array.isArray(rawConfig.phase_order) && Array.isArray(legacyDefaults.phase_order)) {
      const configuredPhases = new Set(rawConfig.phase_order);
      const newPhases = legacyDefaults.phase_order.filter((phase) => !configuredPhases.has(phase));
      if (newPhases.length > 0) {
        targetConfig = {
          ...targetConfig,
          phase_order: [...rawConfig.phase_order, ...newPhases],
        };
        inheritedPaths = [...inheritedPaths, "/phase_order"].sort(compareCanonicalStrings);
      }
    }
    mode = inheritedPaths.length > 0 ? "materialize_legacy_defaults" : "adopt_lock";
  }

  if (input.target_config !== undefined) {
    targetConfig = cloneJson(requirePlainRecord(
      input.target_config,
      "config_migration_input.target_config",
    ));
    if (mode === "already_locked" && computeStableHash(targetConfig) !== sourceConfigHash) {
      mode = "update_config";
    }
  }

  const changes = diffJson(rawConfig, targetConfig, "");
  const targetConfigHash = computeStableHash(targetConfig);
  const subject = {
    kind: "config_migration_plan",
    schema_version: CONFIG_MIGRATION_PLAN_SCHEMA_VERSION,
    status: mode === "already_locked" ? "already_applied" : "ready",
    mode,
    config_path: configPath,
    lock_path: lockPath,
    source_config_hash: sourceConfigHash,
    source_lock_hash: isSha256(input.lock?.lock_hash) ? input.lock.lock_hash : null,
    target_config_hash: targetConfigHash,
    effective_config_hash: targetConfigHash,
    defaults_profile: defaultsProfile,
    inherited_paths: inheritedPaths,
    changes,
    target_config: targetConfig,
    hash_algorithm: STABLE_JSON_HASH_ALGORITHM,
  };
  return immutableJson({
    ...subject,
    plan_hash: computeStableHash(subject),
  });
}

export function verifyConfigMigrationPlan(plan) {
  if (!isPlainRecord(plan)) {
    return immutableJson({ valid: false, errors: ["plan_not_object"], expected_plan_hash: null });
  }
  const { plan_hash: storedHash, ...subject } = plan;
  const expectedHash = computeStableHash(subject);
  const errors = [];
  if (plan.schema_version !== CONFIG_MIGRATION_PLAN_SCHEMA_VERSION) errors.push("schema_version_invalid");
  if (plan.hash_algorithm !== STABLE_JSON_HASH_ALGORITHM) errors.push("hash_algorithm_invalid");
  if (!isSha256(storedHash)) errors.push("plan_hash_invalid");
  else if (storedHash !== expectedHash) errors.push("plan_hash_mismatch");
  if (computeStableHash(plan.target_config) !== plan.target_config_hash) errors.push("target_config_hash_mismatch");
  return immutableJson({ valid: errors.length === 0, errors, expected_plan_hash: expectedHash });
}

export function buildConfigMigrationApplyData(input) {
  requirePlainRecord(input, "config_migration_apply_input");
  const plan = requirePlainRecord(input.plan, "config_migration_apply_input.plan");
  const currentProjectConfig = requirePlainRecord(
    input.current_project_config,
    "config_migration_apply_input.current_project_config",
  );
  const expectedPlanHash = requireHash(input.expected_plan_hash, "config_migration_apply_input.expected_plan_hash");
  const verification = verifyConfigMigrationPlan(plan);
  if (!verification.valid) {
    throw new TypeError(`Config migration plan failed integrity validation: ${verification.errors.join(", ")}`);
  }
  if (plan.plan_hash !== expectedPlanHash) {
    throw new TypeError("Config migration plan hash does not match the reviewed plan");
  }
  if (computeStableHash(currentProjectConfig) !== plan.source_config_hash) {
    throw new TypeError("Project config changed after the migration plan was reviewed");
  }
  if (plan.status === "already_applied") {
    const currentLock = requirePlainRecord(
      input.current_lock,
      "config_migration_apply_input.current_lock",
    );
    if (currentLock.lock_hash !== plan.source_lock_hash) {
      throw new TypeError("Effective config lock changed after the migration plan was reviewed");
    }
    const lockVerification = verifyEffectiveConfigLock({
      lock: currentLock,
      project_config: currentProjectConfig,
      config_path: plan.config_path,
    });
    if (!lockVerification.valid) {
      throw new TypeError("Current effective config lock failed integrity validation");
    }
    return immutableJson({
      status: "already_applied",
      config: cloneJson(plan.target_config),
      lock: cloneJson(currentLock),
      receipt: null,
    });
  }

  const appliedAt = normalizeIsoInstant(input.applied_at, "config_migration_apply_input.applied_at");
  const audit = input.audit === undefined ? {} : requirePlainRecord(input.audit, "config_migration_apply_input.audit");
  const lock = buildEffectiveConfigLock({
    effective_config: plan.target_config,
    config_path: plan.config_path,
    defaults_profile: plan.defaults_profile,
    inherited_paths: plan.inherited_paths,
    created_at: appliedAt,
  });
  const receiptId = `MIG-CONFIG-${plan.plan_hash.slice(0, 16)}`;
  const receiptSubject = {
    id: receiptId,
    kind: "config_migration_receipt",
    schema_version: CONFIG_MIGRATION_RECEIPT_SCHEMA_VERSION,
    status: "applied",
    mode: plan.mode,
    plan_hash: plan.plan_hash,
    config_path: plan.config_path,
    lock_path: plan.lock_path,
    source_config_hash: plan.source_config_hash,
    target_config_hash: plan.target_config_hash,
    effective_config_hash: plan.effective_config_hash,
    defaults_profile: plan.defaults_profile,
    inherited_paths: plan.inherited_paths,
    changes: plan.changes,
    lock_hash: lock.lock_hash,
    applied_at: appliedAt,
    audit: cloneJson(audit),
    hash_algorithm: STABLE_JSON_HASH_ALGORITHM,
  };
  const receipt = {
    ...receiptSubject,
    receipt_hash: computeStableHash(receiptSubject),
  };
  return immutableJson({
    status: "ready_to_apply",
    config: cloneJson(plan.target_config),
    lock,
    receipt,
  });
}

function mergeMissingDefaults(current, defaults, pointer) {
  const result = Object.create(null);
  const inheritedPaths = [];
  for (const key of Object.keys(current).sort(compareCanonicalStrings)) {
    defineDataProperty(result, key, cloneJson(current[key]));
  }
  for (const key of Object.keys(defaults).sort(compareCanonicalStrings)) {
    const childPointer = `${pointer}/${escapeJsonPointer(key)}`;
    if (!Object.hasOwn(current, key)) {
      defineDataProperty(result, key, cloneJson(defaults[key]));
      inheritedPaths.push(childPointer);
      continue;
    }
    if (isPlainRecord(current[key]) && isPlainRecord(defaults[key])) {
      const merged = mergeMissingDefaults(current[key], defaults[key], childPointer);
      defineDataProperty(result, key, merged.value);
      inheritedPaths.push(...merged.inheritedPaths);
    }
  }
  return {
    value: cloneJson(result),
    inheritedPaths: inheritedPaths.sort(compareCanonicalStrings),
  };
}

function diffJson(before, after, pointer) {
  if (computeStableHash(before) === computeStableHash(after)) return [];
  if (isPlainRecord(before) && isPlainRecord(after)) {
    const changes = [];
    const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort(compareCanonicalStrings);
    for (const key of keys) {
      const childPointer = `${pointer}/${escapeJsonPointer(key)}`;
      if (!Object.hasOwn(before, key)) {
        changes.push({ operation: "add", path: childPointer, after: cloneJson(after[key]) });
      } else if (!Object.hasOwn(after, key)) {
        changes.push({ operation: "remove", path: childPointer, before: cloneJson(before[key]) });
      } else {
        changes.push(...diffJson(before[key], after[key], childPointer));
      }
    }
    return changes;
  }
  return [{ operation: "replace", path: pointer || "", before: cloneJson(before), after: cloneJson(after) }];
}

function normalizeDefaultsProfile(value, defaults, label) {
  const profile = requirePlainRecord(value, label);
  const id = requireNonEmptyString(profile.id, `${label}.id`);
  const expectedHash = defaults === null
    ? requireHash(profile.sha256, `${label}.sha256`)
    : computeStableHash(requirePlainRecord(defaults, `${label}.defaults`));
  if (profile.sha256 !== undefined && profile.sha256 !== expectedHash) {
    throw new TypeError(`${label}.sha256 does not match the defaults payload`);
  }
  return { id, sha256: expectedHash };
}

function normalizePointerList(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const normalized = value.map((item, index) => {
    const pointer = requireNonEmptyString(item, `${label}[${index}]`);
    if (!pointer.startsWith("/") || /~(?![01])/u.test(pointer)) {
      throw new TypeError(`${label}[${index}] must be a canonical JSON pointer`);
    }
    return pointer;
  });
  return Array.from(new Set(normalized)).sort(compareCanonicalStrings);
}

function normalizeProjectPath(value, label) {
  const normalized = requireNonEmptyString(value, label).replaceAll("\\", "/");
  if (
    normalized.startsWith("/")
    || normalized === "."
    || normalized.split("/").includes("..")
    || !normalized.startsWith(".sdlc/")
  ) {
    throw new TypeError(`${label} must be a portable .sdlc-relative path`);
  }
  return normalized;
}

function requireHash(value, label) {
  if (!isSha256(value)) throw new TypeError(`${label} must be a lowercase SHA-256 digest`);
  return value;
}

function isSha256(value) {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function addIssue(target, code, path, message) {
  target.push({ code, path, message });
}

function defineDataProperty(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function escapeJsonPointer(value) {
  return String(value).replaceAll("~", "~0").replaceAll("/", "~1");
}
