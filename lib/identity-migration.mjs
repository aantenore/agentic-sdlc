import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { computeStableHash, omitKeys } from "./canonical.mjs";
import {
  computeAuthorizationHash,
  computeAuthorizationSubjectHash,
  computeAuthorizationUseHash,
  validateAuthorizationRevocationIntegrity,
  validateAuthorizationSnapshotIntegrity,
  validateAuthorizationUsageReceipt,
} from "./authorization-receipts.mjs";
import {
  IDENTITY_STAT_OPTIONS,
  fileIdentity,
  sameFileIdentityValues,
} from "./file-identity.mjs";
import { validateAgainstSchema } from "./json-schema-validator.mjs";

const DERIVED_ROOTS = new Set(["cache", "indexes", "locks"]);
const REBUILDABLE_DERIVED_ROOTS = new Set(["cache", "indexes"]);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const LEGACY_AUTHORIZATION_SCHEMA = "authorization:v3";
const LEGACY_AUTHORIZATION_RECEIPTS = new Set([
  "authorization-usage-receipt:legacy-v1",
  "authorization-usage-receipt:legacy-v2",
]);
const CANONICAL_AUTHORIZATION_SCHEMAS = new Set(["content-authorization:v1", "content-authorization:v2"]);
const CANONICAL_AUTHORIZATION_RECEIPTS = new Set([
  "authorization-usage-receipt:v1",
  "authorization-usage-receipt:v2",
]);
const CANONICAL_AUTHORIZATION_REVOCATION = "authorization-revocation:v1";
const PROJECT_BOOTSTRAP_MANIFEST_SCHEMA = "project-bootstrap-manifest:v1";
const PROJECT_BOOTSTRAP_JOURNAL_SCHEMA = "project-bootstrap-journal:v1";
const PROJECT_BOOTSTRAP_MANIFEST_PATH = ".sdlc/bootstrap-manifest.json";
const PROJECT_BOOTSTRAP_JOURNAL_PATH = ".sdlc/bootstrap-journal.json";
const PROJECT_RECORD_PATH = ".sdlc/project.json";
const UNSUPPORTED_SIGNED_SCHEMAS = new Set([
  "host-approval-receipt:v2",
  "metering-attestation:v1",
]);
const MIGRATION_SCHEMA = "identity-migration-receipt:v1";
const TRANSACTION_STRATEGY = "journaled-shadow-tree-directory-swap";
const IDENTITY_EXECUTION_SCHEMA = "identity-migration-execution:v1";
const IDENTITY_DERIVED_PATHS = Object.freeze([
  ".sdlc/cache/kb-cache.json",
  ".sdlc/indexes/kb-index.json",
]);
const NON_OBSERVABLE_RECOVERY_PHASES = new Set(["rolling_back", "rolled_back", "rollback_failed"]);
const PLUGIN_SCHEMA_DIR = fileURLToPath(new URL("../schemas", import.meta.url));
const identityMutationStorage = new AsyncLocalStorage();

function runWithIdentityMutationGateway(gateway, callback) {
  if (gateway === undefined || gateway === null) return callback();
  if (typeof gateway !== "function") throw new TypeError("identity mutation gateway must be a function");
  return identityMutationStorage.run(gateway, callback);
}

function mutateIdentity(operation, targetPath, callback) {
  const gateway = identityMutationStorage.getStore();
  if (!gateway) return callback();
  return gateway(identityMutationRequest(operation, targetPath), callback);
}

function renameIdentityPath(
  sourcePath,
  targetPath,
  expectedSourceIdentity = null,
  expectedSourceDescriptor = null,
) {
  const source = identityMutationRequest("path.rename.source", sourcePath);
  const target = identityMutationRequest("path.rename.target", targetPath);
  return mutateIdentity(source.operation, source.path, () =>
    mutateIdentity(target.operation, target.path, () => {
      revalidateIdentityMutation(source);
      revalidateIdentityMutation(target);
      if (expectedSourceIdentity) {
        assertOwnedTemporaryFile(sourcePath, expectedSourceIdentity, expectedSourceDescriptor);
      }
      return fs.renameSync(sourcePath, targetPath);
    }));
}

function linkIdentityPath(sourcePath, targetPath, expectedSourceIdentity = null) {
  const source = identityMutationRequest("path.link.source", sourcePath);
  const target = identityMutationRequest("path.link.target", targetPath);
  return mutateIdentity(source.operation, source.path, () =>
    mutateIdentity(target.operation, target.path, () => {
      revalidateIdentityMutation(source);
      revalidateIdentityMutation(target);
      if (expectedSourceIdentity) assertOwnedTemporaryFile(sourcePath, expectedSourceIdentity);
      return fs.linkSync(sourcePath, targetPath);
    }));
}

function identityMutationRequest(operation, targetPath) {
  return Object.freeze({ operation, path: path.resolve(targetPath) });
}

function revalidateIdentityMutation(request) {
  const gateway = identityMutationStorage.getStore();
  if (!gateway) return true;
  if (typeof gateway.revalidate !== "function") {
    throw new TypeError("identity mutation gateway must synchronously revalidate dual-path mutations");
  }
  const result = gateway.revalidate(request);
  if (result && typeof result.then === "function") {
    throw new TypeError("identity mutation gateway revalidation must be synchronous");
  }
  if (result !== true) {
    throw new IdentityMigrationError("Identity mutation authorization changed before the dual-path operation.");
  }
  return true;
}

function ensureIdentityDirectory(directoryPath, projectRoot) {
  const root = path.resolve(projectRoot);
  const target = path.resolve(directoryPath);
  if (!isInside(root, target)) {
    throw new IdentityMigrationError("Refusing to create an identity migration directory outside the project root.");
  }
  let current = root;
  for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const existing = lstatIfPresent(current);
    if (existing) {
      if (!existing.isDirectory() || existing.isSymbolicLink()) {
        throw new IdentityMigrationError("Identity migration directory path is not safe.");
      }
      continue;
    }
    mutateIdentity("directory.create", current, () => fs.mkdirSync(current));
  }
}

export class IdentityMigrationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "IdentityMigrationError";
    this.code = "identity_migration_failed";
    this.details = details;
  }
}

export function normalizeIdentityMigrationMapping(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new IdentityMigrationError("Identity migration mapping must be a JSON object.");
  }
  assertOnlyKeys(input, new Set(["source", "target", "from_email", "to_email", "to_name"]), "mapping");
  if (input.source !== undefined) {
    if (!input.source || typeof input.source !== "object" || Array.isArray(input.source)) {
      throw new IdentityMigrationError("source must be a JSON object.");
    }
    assertOnlyKeys(input.source, new Set(["email"]), "source");
  }
  if (input.target !== undefined) {
    if (!input.target || typeof input.target !== "object" || Array.isArray(input.target)) {
      throw new IdentityMigrationError("target must be a JSON object.");
    }
    assertOnlyKeys(input.target, new Set(["email", "name"]), "target");
  }
  const sourceEmail = normalizeEmail(input?.source?.email ?? input?.from_email, "source.email");
  const targetEmail = normalizeEmail(input?.target?.email ?? input?.to_email, "target.email");
  if (sourceEmail.toLowerCase() === targetEmail.toLowerCase()) {
    throw new IdentityMigrationError("Source and target email must differ.");
  }
  const targetName = normalizeOptionalText(input?.target?.name ?? input?.to_name, "target.name");
  return Object.freeze({ sourceEmail, targetEmail, targetName });
}

export function planIdentityMigration({ projectRoot, mapping, createdAt = new Date().toISOString(), reason = null }) {
  const normalized = normalizeIdentityMigrationMapping(mapping);
  const root = canonicalDirectory(projectRoot, "project root");
  const sdlcRoot = canonicalDirectory(path.join(root, ".sdlc"), "SDLC root");
  if (!isInside(root, sdlcRoot)) {
    throw new IdentityMigrationError("SDLC root resolves outside the project root.");
  }
  assertNoSymlinks(sdlcRoot);

  const identityBearingPaths = findIdentityBearingPaths(sdlcRoot, normalized.sourceEmail);
  if (identityBearingPaths.length > 0) {
    throw new IdentityMigrationError(
      "Source identity occurs in an SDLC path; explicit path migration is required before content migration.",
      { paths: identityBearingPaths },
    );
  }

  const sourceDigest = sha256(normalized.sourceEmail.toLowerCase());
  const targetDigest = sha256(normalized.targetEmail.toLowerCase());
  if (normalized.targetName && containsCaseInsensitive(normalized.targetName, normalized.sourceEmail)) {
    throw new IdentityMigrationError("Target name must not retain the source identity in clear text.");
  }
  const normalizedReason = normalizeOptionalText(reason, "reason");
  if (normalizedReason && containsCaseInsensitive(normalizedReason, normalized.sourceEmail)) {
    throw new IdentityMigrationError("Migration reason must not retain the source identity in clear text.");
  }
  const migrationId = `MIG-IDENTITY-${sourceDigest.slice(0, 12)}-${targetDigest.slice(0, 12)}`;
  const receiptRelativePath = `.sdlc/migrations/identity/${migrationId}.json`;
  const receiptPath = path.join(root, receiptRelativePath);
  const documents = loadDocuments(root, sdlcRoot);
  const sourceOccurrencesBefore = countOccurrencesInDocuments(documents, normalized.sourceEmail);

  if (sourceOccurrencesBefore === 0) {
    const derivedOrUnsupportedOccurrences = countRawOccurrences(sdlcRoot, normalized.sourceEmail);
    if (derivedOrUnsupportedOccurrences > 0) {
      throw new IdentityMigrationError(
        "Source identity is absent from canonical records but remains in derived or unsupported SDLC files; rebuild or remove those files before claiming completion.",
        { remaining_occurrences: derivedOrUnsupportedOccurrences },
      );
    }
    const existingReceipt = fs.existsSync(receiptPath) ? readExistingMigrationReceipt(receiptPath, {
      migrationId,
      sourceDigest,
      targetDigest,
      targetName: normalized.targetName,
    }) : null;
    const planHash = existingReceipt?.plan_hash || computeIdentityMigrationPlanHash({
      id: migrationId,
      status: existingReceipt ? "already_applied" : "no_change",
      sourceDigest,
      targetDigest,
      targetName: normalized.targetName,
      sourceOccurrencesBefore: 0,
      changedFiles: [],
      hashRewrites: [],
      receiptPath: existingReceipt ? receiptRelativePath : null,
      inputHashes: snapshotDocumentHashes(documents),
      reason: normalizedReason,
    });
    return Object.freeze({
      id: migrationId,
      status: existingReceipt ? "already_applied" : "no_change",
      plan_hash: planHash,
      source_identity_digest: sourceDigest,
      target_identity_digest: targetDigest,
      source_occurrences_before: 0,
      source_occurrences_after: 0,
      changed_files: [],
      hash_rewrites: [],
      receipt_path: existingReceipt ? receiptRelativePath : null,
      _internal: Object.freeze({ writes: new Map(), root, sdlcRoot, sourceEmail: normalized.sourceEmail }),
    });
  }
  if (fs.existsSync(receiptPath)) {
    throw new IdentityMigrationError("A prior receipt exists but the source identity is still present.", {
      receipt_path: receiptRelativePath,
    });
  }

  const unsupported = findUnsupportedOccurrences(sdlcRoot, normalized.sourceEmail);
  if (unsupported.length > 0) {
    throw new IdentityMigrationError(
      "Source identity occurs in unsupported non-JSON SDLC files; migration stopped without writes.",
      { files: unsupported },
    );
  }
  const excluded = findNonRebuildableExcludedOccurrences(sdlcRoot, normalized.sourceEmail);
  if (excluded.length > 0) {
    throw new IdentityMigrationError(
      "Source identity occurs in excluded SDLC state that the migration cannot rebuild; clear or migrate it explicitly before planning.",
      { files: excluded },
    );
  }
  assertRecordsMigratable(documents, normalized.sourceEmail);
  validateIntegrity(documents, { byteSource: "raw" });

  const originals = snapshotDocumentBytes(documents);
  const inputHashes = snapshotDocumentHashes(documents);
  const replacementCounts = new Map();
  for (const document of documents.values()) {
    const result = replaceInDocument(
      document,
      normalized.sourceEmail,
      normalized.targetEmail,
      normalized.targetName,
    );
    replacementCounts.set(document.relativePath, result.replacements);
  }

  const reconciliation = reconcileIntegrity(documents, originals);
  const sourceOccurrencesAfter = countOccurrencesInDocuments(documents, normalized.sourceEmail);
  if (sourceOccurrencesAfter !== 0) {
    throw new IdentityMigrationError("Source identity remains after the planned structured migration.", {
      remaining_occurrences: sourceOccurrencesAfter,
    });
  }
  validateIntegrity(documents, { byteSource: "rendered" });

  const changedFiles = [];
  const writes = new Map();
  for (const document of documents.values()) {
    const before = originals.get(document.relativePath);
    const after = plannedDocumentBytes(document);
    if (before === after) continue;
    assertDocumentCanBeReserialized(document);
    const beforeStat = fs.lstatSync(document.absolutePath);
    if (!beforeStat.isFile() || beforeStat.isSymbolicLink()) {
      throw new IdentityMigrationError(`Canonical SDLC file is not a safe regular file: ${document.relativePath}.`);
    }
    const mode = beforeStat.mode & 0o7777;
    writes.set(document.absolutePath, after);
    changedFiles.push({
      path: document.relativePath,
      before_sha256: sha256(before),
      after_sha256: sha256(after),
      before_mode: mode,
      after_mode: mode,
      identity_replacements: replacementCounts.get(document.relativePath) || 0,
    });
  }
  changedFiles.sort((left, right) => left.path.localeCompare(right.path));
  const planHash = computeIdentityMigrationPlanHash({
    id: migrationId,
    status: "ready",
    sourceDigest,
    targetDigest,
    targetName: normalized.targetName,
    sourceOccurrencesBefore,
    changedFiles,
    hashRewrites: reconciliation.hashRewrites,
    receiptPath: receiptRelativePath,
    inputHashes,
    reason: normalizedReason,
  });

  const receipt = {
    id: migrationId,
    kind: "identity_migration_receipt",
    schema_version: MIGRATION_SCHEMA,
    status: "applied",
    plan_hash: planHash,
    source_identity_digest: sourceDigest,
    target_identity_digest: targetDigest,
    target_identity: {
      email_digest: targetDigest,
      ...(normalized.targetName ? { name: normalized.targetName } : {}),
    },
    reason: normalizedReason || "Canonical identity correction with integrity-preserving lineage rewrite.",
    source_occurrences_before: sourceOccurrencesBefore,
    source_occurrences_after: 0,
    changed_files: changedFiles,
    hash_rewrites: reconciliation.hashRewrites,
    derived_artifacts: {
      cache: "rebuild_required",
      indexes: "rebuild_required",
    },
    transaction: {
      strategy: TRANSACTION_STRATEGY,
      rollback_on_post_validation_failure: true,
    },
    created_at: normalizeIsoInstant(createdAt),
  };
  receipt.receipt_hash = computeStableHash(receipt);
  receipt.hash_algorithm = "sha256:stable-json:v1";
  const receiptContent = `${JSON.stringify(receipt, null, 2)}\n`;
  writes.set(receiptPath, receiptContent);

  const executionDescriptor = createIdentityExecutionDescriptor({
    id: migrationId,
    planHash,
    root,
    sdlcRoot,
    writes,
    changedFiles,
    receiptPath: receiptRelativePath,
  });

  const publicFields = {
    id: migrationId,
    status: "ready",
    plan_hash: planHash,
    source_identity_digest: sourceDigest,
    target_identity_digest: targetDigest,
    source_occurrences_before: sourceOccurrencesBefore,
    source_occurrences_after: 0,
    changed_files: changedFiles,
    hash_rewrites: reconciliation.hashRewrites,
    receipt_path: receiptRelativePath,
    execution_descriptor: executionDescriptor,
  };
  deepFreezeJson(publicFields);
  deepFreezeJson(receipt);
  const internalDraft = {
    writes,
    root,
    sdlcRoot,
    sourceEmail: normalized.sourceEmail,
    receipt,
    inputHashes,
    planHash,
  };
  const executableHash = computeIdentityMigrationExecutableHash(publicFields, internalDraft);
  return Object.freeze({
    ...publicFields,
    _internal: Object.freeze({ ...internalDraft, executableHash }),
  });
}

export function applyIdentityMigration(plan, options = {}) {
  const execute = () => runWithIdentityMutationGateway(
    options.mutationGateway,
    () => applyIdentityMigrationInternal(plan, options),
  );
  if (
    plan?.status === "ready"
    && typeof options.mutationGateway?.prepare === "function"
  ) {
    const descriptor = validateIdentityExecutionDescriptor(plan);
    return options.mutationGateway.prepare(descriptor, execute);
  }
  return execute();
}

function applyIdentityMigrationInternal(plan, { rebuildDerived, validateAfter, transactionObserver } = {}) {
  if (!plan || plan.status !== "ready") {
    return publicPlan(plan);
  }
  const suppliedInternal = plan._internal;
  if (!(suppliedInternal?.writes instanceof Map)) {
    throw new IdentityMigrationError("Migration plan does not contain executable writes.");
  }
  if (plan.plan_hash !== suppliedInternal.planHash) {
    throw new IdentityMigrationError("Migration plan hash does not match its executable snapshot.");
  }
  if (
    !SHA256_PATTERN.test(suppliedInternal.executableHash || "")
    || computeIdentityMigrationExecutableHash(plan, suppliedInternal) !== suppliedInternal.executableHash
  ) {
    throw new IdentityMigrationError("Migration executable snapshot changed after planning.");
  }
  const internal = Object.freeze({
    ...suppliedInternal,
    writes: new Map(suppliedInternal.writes),
    inputHashes: new Map(Array.from(suppliedInternal.inputHashes || [], ([key, value]) => [
      key,
      Object.freeze({ ...value }),
    ])),
  });
  const execution = resolveIdentityExecutionDescriptor(plan, internal);
  assertPlanPreconditions(plan, internal);
  if (fs.statSync(internal.root).dev !== fs.statSync(internal.sdlcRoot).dev) {
    throw new IdentityMigrationError("Identity migration requires the project root and .sdlc tree on the same filesystem.");
  }
  if (lstatIfPresent(execution.transactionRoot)) {
    throw new IdentityMigrationError("Identity migration execution directory already exists; no files were changed.");
  }
  const lockPath = path.join(internal.root, ".sdlc-identity-migration.lock");
  const lock = acquireLock(lockPath, plan.id, plan.plan_hash, execution);
  const transactionRoot = path.join(internal.root, lock.transactionRootName);
  const shadowRoot = path.join(transactionRoot, "shadow", ".sdlc");
  const backupRoot = path.join(transactionRoot, "original");
  const updatePhase = (phase, patch = {}) => {
    lock.update({ ...patch, phase });
    notifyTransactionObserver(transactionObserver, phase, plan);
  };
  let derivedRebuilt = false;
  let releaseAllowed = false;
  let committed = false;
  let beforeManifestHash = null;
  let beforeRootIdentity = null;
  let afterManifestHash = null;
  let shadowRootIdentity = null;
  let transactionRootIdentity = null;
  let activationReached = false;
  try {
    notifyTransactionObserver(transactionObserver, "acquired", plan);
    beforeManifestHash = computeTreeManifestHash(internal.sdlcRoot);
    beforeRootIdentity = captureDirectoryIdentity(internal.sdlcRoot, internal.root);
    updatePhase("preparing_shadow", {
      before_manifest_hash: beforeManifestHash,
      expected_receipt_path: plan.receipt_path,
      expected_receipt_hash: internal.receipt.receipt_hash,
    });
    mutateIdentity("directory.create", transactionRoot, () => fs.mkdirSync(transactionRoot));
    transactionRootIdentity = captureDirectoryIdentity(transactionRoot, internal.root);
    ensureIdentityDirectory(path.dirname(shadowRoot), internal.root);
    mutateIdentity("directory.copy", shadowRoot, () => fs.cpSync(
      internal.sdlcRoot,
      shadowRoot,
      { recursive: true, errorOnExist: true, dereference: false },
    ));
    shadowRootIdentity = captureDirectoryIdentity(shadowRoot, transactionRoot);
    const shadowInternal = remapIdentityMigrationInternal(internal, shadowRoot);
    for (const [filePath, content] of shadowInternal.writes) {
      atomicWrite(filePath, content, shadowInternal.root, execution);
    }
    const shadowDocuments = loadDocuments(shadowInternal.root, shadowRoot);
    if (countOccurrencesInDocuments(shadowDocuments, internal.sourceEmail) !== 0) {
      throw new IdentityMigrationError("Prepared shadow tree still contains the source identity in canonical records.");
    }
    assertAppliedPlanState(plan, shadowInternal);
    validateIntegrity(shadowDocuments);
    const stagedView = Object.freeze({
      projectRoot: shadowInternal.root,
      sdlcRoot: shadowRoot,
      logicalProjectRoot: internal.root,
      phase: "prepared",
      execution_descriptor: plan.execution_descriptor,
    });
    if (typeof rebuildDerived === "function") {
      const canonicalBeforeRebuild = computeTreeManifestHash(shadowRoot, {
        excludeFirstSegments: REBUILDABLE_DERIVED_ROOTS,
      });
      rebuildDerived(stagedView);
      assertDirectoryIdentity(shadowRoot, shadowRootIdentity, transactionRoot);
      if (computeTreeManifestHash(shadowRoot, { excludeFirstSegments: REBUILDABLE_DERIVED_ROOTS }) !== canonicalBeforeRebuild) {
        throw new IdentityMigrationError("Identity migration derived rebuild callback mutated canonical SDLC records.");
      }
      derivedRebuilt = true;
    }
    const remaining = countRawOccurrences(shadowRoot, internal.sourceEmail);
    if (remaining !== 0) {
      throw new IdentityMigrationError("Prepared shadow tree still contains the source identity after derived rebuild.", {
        remaining_occurrences: remaining,
      });
    }
    assertAppliedPlanState(plan, shadowInternal);
    validateIntegrity(loadDocuments(shadowInternal.root, shadowRoot));
    if (typeof validateAfter === "function") {
      const beforeValidationHash = computeTreeManifestHash(shadowRoot);
      validateAfter(stagedView);
      assertDirectoryIdentity(shadowRoot, shadowRootIdentity, transactionRoot);
      if (computeTreeManifestHash(shadowRoot) !== beforeValidationHash) {
        throw new IdentityMigrationError("Identity migration validation callback mutated the prepared shadow tree.");
      }
    }
    fsyncTree(transactionRoot);
    assertDirectoryIdentity(shadowRoot, shadowRootIdentity, transactionRoot);
    afterManifestHash = computeTreeManifestHash(shadowRoot);
    updatePhase("shadow_prepared", { after_manifest_hash: afterManifestHash });

    if (computeTreeManifestHash(internal.sdlcRoot) !== beforeManifestHash) {
      throw new IdentityMigrationError("Live SDLC tree changed while the migration shadow was being prepared.");
    }

    updatePhase("swap_intent");
    renameIdentityPath(internal.sdlcRoot, backupRoot);
    fsyncDirectory(internal.root);
    fsyncDirectory(transactionRoot);
    if (computeTreeManifestHash(backupRoot) !== beforeManifestHash) {
      throw new IdentityMigrationError(
        "Live SDLC tree changed at the directory-swap boundary; the uncommitted backup was preserved for manual recovery.",
      );
    }
    updatePhase("original_moved");
    if (computeTreeManifestHash(backupRoot) !== beforeManifestHash) {
      throw new IdentityMigrationError(
        "The moved pre-migration tree changed before activation; its backup was preserved for authenticated recovery.",
      );
    }
    updatePhase("activate_intent");
    renameIdentityPath(shadowRoot, internal.sdlcRoot);
    activationReached = true;
    fsyncDirectory(internal.root);
    fsyncDirectory(path.dirname(shadowRoot));
    updatePhase("shadow_activated");
    assertActivatedDirectoryIdentity(internal.sdlcRoot, shadowRootIdentity, internal.root);
    if (computeTreeManifestHash(internal.sdlcRoot) !== afterManifestHash) {
      throw new IdentityMigrationError("Activated SDLC tree does not match the validated shadow manifest.");
    }
    assertAppliedPlanState(plan, internal);
    validateIntegrity(loadDocuments(internal.root, internal.sdlcRoot));
    fsyncTree(internal.sdlcRoot);
    if (computeTreeManifestHash(backupRoot) !== beforeManifestHash) {
      throw new IdentityMigrationError(
        "The pre-migration backup changed after activation; automatic cleanup was refused to prevent data loss.",
      );
    }
    updatePhase("committed", { after_manifest_hash: afterManifestHash });
    assertActivatedDirectoryIdentity(internal.sdlcRoot, shadowRootIdentity, internal.root);
    if (computeTreeManifestHash(internal.sdlcRoot) !== afterManifestHash) {
      throw new IdentityMigrationError(
        "Activated SDLC tree changed while recording the durable commit; automatic cleanup was refused.",
      );
    }
    if (computeTreeManifestHash(backupRoot) !== beforeManifestHash) {
      throw new IdentityMigrationError(
        "The pre-migration backup changed while committing; automatic cleanup was refused to prevent data loss.",
      );
    }
    committed = true;
    releaseAllowed = true;
    return Object.freeze({
      ...publicPlan(plan),
      status: "applied",
      derived_artifacts: derivedRebuilt
        ? { cache: "rebuilt", indexes: "rebuilt" }
        : { cache: "rebuild_required", indexes: "rebuild_required" },
    });
  } catch (error) {
    if (
      activationReached
      && !activatedTreeMatchesExpectedState(
        internal.sdlcRoot,
        shadowRootIdentity,
        internal.root,
        afterManifestHash,
      )
    ) {
      try {
        updatePhase("rollback_failed", {
          rollback_error_digest: sha256("activated SDLC tree changed outside the migration transaction"),
        });
      } catch {}
      throw new IdentityMigrationError(
        `Identity migration requires authenticated recovery because the activated SDLC tree changed concurrently: ${error.message}`,
        { cause_code: error.code || error.name || "unknown", recovery_required: true },
      );
    }
    try {
      updatePhase("rolling_back");
      rollbackIdentityTransaction(
        internal.root,
        internal.sdlcRoot,
        transactionRoot,
        backupRoot,
        beforeManifestHash,
      );
      updatePhase("rolled_back");
      if (beforeRootIdentity && beforeManifestHash) {
        assertActivatedDirectoryIdentity(internal.sdlcRoot, beforeRootIdentity, internal.root);
        if (computeTreeManifestHash(internal.sdlcRoot) !== beforeManifestHash) {
          throw new IdentityMigrationError("Rolled-back SDLC tree changed before transaction cleanup.");
        }
      }
      releaseAllowed = true;
    } catch (rollbackError) {
      try { updatePhase("rollback_failed", { rollback_error_digest: sha256(rollbackError.message) }); } catch {}
      throw new IdentityMigrationError(
        `Identity migration failed and durable recovery is required: ${error.message}; rollback failed: ${rollbackError.message}`,
        { cause_code: error.code || error.name || "unknown", recovery_required: true },
      );
    }
    throw new IdentityMigrationError(`Identity migration rolled back: ${error.message}`, {
      cause_code: error.code || error.name || "unknown",
    });
  } finally {
    if (releaseAllowed) {
      if (committed) updatePhase("finalized");
      if (committed) assertActivatedDirectoryIdentity(internal.sdlcRoot, shadowRootIdentity, internal.root);
      if (committed && computeTreeManifestHash(internal.sdlcRoot) !== afterManifestHash) {
        releaseAllowed = false;
        throw new IdentityMigrationError(
          "Identity migration post-state changed before final cleanup; the transaction and lock were preserved for authenticated recovery.",
          { recovery_required: true },
        );
      }
      if (committed && computeTreeManifestHash(backupRoot) !== beforeManifestHash) {
        releaseAllowed = false;
        try {
          updatePhase("rollback_failed", {
            rollback_error_digest: sha256("pre-migration backup changed before final cleanup"),
          });
        } catch {}
        throw new IdentityMigrationError(
          "Identity migration committed, but the pre-migration backup changed before cleanup; the transaction and lock were preserved for authenticated recovery.",
          { recovery_required: true },
        );
      }
      if (transactionRootIdentity) {
        assertDirectoryIdentity(transactionRoot, transactionRootIdentity, internal.root);
        mutateIdentity("directory.remove", transactionRoot, () =>
          fs.rmSync(transactionRoot, { recursive: true, force: true }));
      }
      fsyncDirectory(internal.root);
      lock.release();
    }
  }
}

function notifyTransactionObserver(observer, phase, plan) {
  if (typeof observer !== "function" || NON_OBSERVABLE_RECOVERY_PHASES.has(phase)) return;
  try {
    observer(Object.freeze({
      phase,
      migration_id: plan.id,
      plan_hash: plan.plan_hash,
    }));
  } catch {
    // Transaction telemetry must never alter migration semantics.
  }
}

export function recoverIdentityMigration(input) {
  return runWithIdentityMutationGateway(
    input?.mutationGateway,
    () => recoverIdentityMigrationInternal(input),
  );
}

export function prepareIdentityMigrationRecovery({ projectRoot, recoveryNonce = null, planHash = null }) {
  const inspected = inspectIdentityMigrationRecovery(projectRoot, recoveryNonce, planHash);
  if (inspected.status === "no_recovery_needed") {
    return Object.freeze({ status: inspected.status, exact_mutations: Object.freeze([]) });
  }
  const claimNonces = Object.freeze(Array.from(
    { length: 3 },
    () => crypto.randomBytes(12).toString("hex"),
  ));
  const exactMutations = identityRecoveryExactMutations(
    inspected.root,
    inspected.lockRecord,
    claimNonces,
  );
  const prepared = {
    schema_version: "identity-migration-recovery-preparation:v1",
    root: inspected.root,
    recovery_nonce: inspected.lockRecord.nonce,
    plan_hash: inspected.lockRecord.plan_hash,
    process_id: process.pid,
    lock_identity: { dev: Number(inspected.lockStat.dev), ino: Number(inspected.lockStat.ino) },
    lock_record_hash: computeStableHash(inspected.lockRecord),
    claim_nonces: claimNonces,
    exact_mutations: exactMutations,
  };
  prepared.preparation_hash = computeStableHash(prepared);
  return deepFreezeJson(prepared);
}

function recoverIdentityMigrationInternal({
  projectRoot,
  recoveryNonce = null,
  planHash = null,
  recoveryPreparation = null,
}) {
  const inspected = inspectIdentityMigrationRecovery(projectRoot, recoveryNonce, planHash);
  if (inspected.status === "no_recovery_needed") {
    return Object.freeze({ status: "no_recovery_needed", recovered: false });
  }
  const { root, lockPath, lockStat, lockState, lockRecord } = inspected;
  const claimNonces = recoveryPreparation === null
    ? null
    : validateIdentityRecoveryPreparation(recoveryPreparation, inspected);

  const recoveryClaim = acquireRecoveryClaim(root, lockRecord, claimNonces);
  try {
    try {
      assertOwnedLock(lockPath, fileIdentity(lockStat), lockRecord.nonce);
    } catch {
      throw new IdentityMigrationError("Identity migration lock changed while authenticated recovery was being claimed.");
    }
    const journalPath = path.join(root, lockRecord.journal_path);
    let record = lockRecord;
    const journalStat = lstatIfPresent(journalPath);
    if (journalStat) {
      if (!journalStat.isFile() || journalStat.isSymbolicLink()) {
        throw new IdentityMigrationError("Identity migration recovery journal is not a safe regular file.");
      }
      const journalRecord = readRecoveryJson(journalPath, "identity migration journal");
      if (lockState.anchored) {
        validateRecoveryRecord(journalRecord);
        assertSameRecoveryTransaction(journalRecord, lockRecord);
        // The append-only lock checkpoint is authoritative. A replaced, stale,
        // or not-yet-anchored journal can never move recovery backwards.
        if (
          journalRecord.generation === lockRecord.generation
          && journalRecord.journal_hash !== lockRecord.journal_hash
        ) {
          throw new IdentityMigrationError("Identity migration journal conflicts with its durable lock checkpoint.");
        }
      } else {
        record = journalRecord;
        validateRecoveryRecord(record, lockRecord);
      }
    }

    const transactionRoot = path.join(root, record.transaction_root);
    const liveRoot = path.join(root, ".sdlc");
    const backupRoot = path.join(transactionRoot, "original");
    const transactionStat = lstatIfPresent(transactionRoot);
    if (transactionStat) {
      if (!transactionStat.isDirectory() || transactionStat.isSymbolicLink()) {
        throw new IdentityMigrationError("Identity migration recovery transaction root is unsafe.");
      }
    }

    let status;
    if (["committed", "finalized"].includes(record.phase)) {
      if (!recoveryCommitIsComplete(root, record)) {
        throw new IdentityMigrationError("Committed identity migration does not match its durable post-migration manifest.");
      }
      status = "committed";
    } else if (lstatIfPresent(backupRoot)) {
      rollbackIdentityTransaction(
        root,
        liveRoot,
        transactionRoot,
        backupRoot,
        record.before_manifest_hash || null,
      );
      status = "rolled_back";
    } else {
      if (!fs.existsSync(liveRoot)) {
        throw new IdentityMigrationError("Identity migration recovery found neither a live tree nor a rollback backup.");
      }
      const liveMatchesBefore = record.before_manifest_hash
        && computeTreeManifestHash(liveRoot) === record.before_manifest_hash;
      if (["rolling_back", "rolled_back"].includes(record.phase) && liveMatchesBefore) {
        status = "rolled_back";
      } else if (
        ["acquired", "preparing_shadow", "shadow_prepared", "swap_intent"].includes(record.phase)
        && (!record.before_manifest_hash || liveMatchesBefore)
      ) {
        status = "cleared_before_swap";
      } else {
        throw new IdentityMigrationError("Identity migration recovery state is ambiguous because its rollback backup is missing.");
      }
    }

    mutateIdentity("directory.remove", transactionRoot, () =>
      fs.rmSync(transactionRoot, { recursive: true, force: true }));
    fsyncDirectory(root);
    removeOwnedLock(
      lockPath,
      fileIdentity(lockStat),
      lockRecord.nonce,
      journalPath,
    );
    if (lstatIfPresent(lockPath) || lstatIfPresent(journalPath)) {
      throw new IdentityMigrationError("Identity migration recovery could not release the verified lock and journal.");
    }
    return Object.freeze({
      status,
      recovered: true,
      migration_id: record.migration_id,
      phase: record.phase,
    });
  } finally {
    recoveryClaim.release();
  }
}

function inspectIdentityMigrationRecovery(projectRoot, recoveryNonce, planHash) {
  const root = canonicalDirectory(projectRoot, "project root");
  const lockPath = path.join(root, ".sdlc-identity-migration.lock");
  const lockStat = lstatIfPresent(lockPath, IDENTITY_STAT_OPTIONS);
  if (!lockStat) {
    return Object.freeze({ status: "no_recovery_needed", root, lockPath });
  }
  if (!lockStat.isFile() || lockStat.isSymbolicLink()) {
    throw new IdentityMigrationError("Identity migration recovery lock is not a safe regular file.");
  }
  const lockState = readIdentityMigrationLock(lockPath);
  const lockRecord = lockState.record;
  if (!/^[a-f0-9]{24}$/u.test(recoveryNonce || "") || recoveryNonce !== lockRecord.nonce) {
    throw new IdentityMigrationError("Identity migration recovery nonce does not match the verified lock.");
  }
  if (!SHA256_PATTERN.test(planHash || "") || planHash !== lockRecord.plan_hash) {
    throw new IdentityMigrationError("Identity migration recovery plan hash does not match the verified lock.");
  }
  if (lockRecord.host !== os.hostname()) {
    throw new IdentityMigrationError("Cannot prove that an identity migration lock owned by another host is inactive.");
  }
  if (processAppearsAlive(lockRecord.pid)) {
    throw new IdentityMigrationError("Identity migration recovery refused because the recorded owner process is still alive.");
  }
  return Object.freeze({ status: "recovery_ready", root, lockPath, lockStat, lockState, lockRecord });
}

function readRecoveryJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new IdentityMigrationError(`Cannot read ${label}: ${error.message}`);
  }
}

function validateRecoveryRecord(record, lockRecord = null) {
  const nonce = record?.nonce;
  if (
    !["identity-migration-lock:v1", "identity-migration-lock:v2"].includes(record?.schema_version)
    || !/^[a-f0-9]{24}$/u.test(nonce || "")
    || record?.transaction_root !== `.sdlc-identity-migration-txn-${nonce}`
    || record?.journal_path !== `.sdlc-identity-migration-journal-${nonce}.json`
    || !/^MIG-IDENTITY-[a-f0-9]{12}-[a-f0-9]{12}$/u.test(record?.migration_id || "")
    || !Number.isInteger(record?.pid)
    || record.pid <= 0
    || typeof record?.host !== "string"
    || !SHA256_PATTERN.test(record?.plan_hash || "")
    || !Number.isInteger(record?.generation)
    || record.generation < 0
  ) {
    throw new IdentityMigrationError("Identity migration recovery record is malformed.");
  }
  if (
    lockRecord
    && (
      record.nonce !== lockRecord.nonce
      || record.migration_id !== lockRecord.migration_id
      || record.transaction_root !== lockRecord.transaction_root
      || record.journal_path !== lockRecord.journal_path
      || record.plan_hash !== lockRecord.plan_hash
      || record.pid !== lockRecord.pid
      || record.host !== lockRecord.host
      || record.created_at !== lockRecord.created_at
      || record.generation <= lockRecord.generation
    )
  ) {
    throw new IdentityMigrationError("Identity migration journal does not belong to the verified lock.");
  }
  if (record.expected_receipt_path !== undefined) {
    const normalized = normalizeReferencePath(record.expected_receipt_path);
    if (!normalized.startsWith(".sdlc/migrations/identity/")) {
      throw new IdentityMigrationError("Identity migration recovery receipt path is outside the migration receipt directory.");
    }
  }
  if (record.expected_receipt_hash !== undefined && !SHA256_PATTERN.test(record.expected_receipt_hash)) {
    throw new IdentityMigrationError("Identity migration recovery receipt hash is invalid.");
  }
  for (const field of ["before_manifest_hash", "after_manifest_hash", "rollback_error_digest"]) {
    if (record[field] !== undefined && !SHA256_PATTERN.test(record[field])) {
      throw new IdentityMigrationError(`Identity migration recovery ${field} is invalid.`);
    }
  }
  const phases = new Set([
    "acquired",
    "preparing_shadow",
    "shadow_prepared",
    "swap_intent",
    "original_moved",
    "activate_intent",
    "shadow_activated",
    "rolling_back",
    "rolled_back",
    "rollback_failed",
    "committed",
    "finalized",
  ]);
  if (!phases.has(record.phase)) throw new IdentityMigrationError("Identity migration recovery phase is invalid.");
  if (lockRecord || record.schema_version === "identity-migration-lock:v2") {
    const expectedJournalHash = computeStableHash(omitKeys(record, ["journal_hash"]));
    if (record.journal_hash !== expectedJournalHash) {
      throw new IdentityMigrationError("Identity migration recovery journal hash is invalid.");
    }
  }
}

function assertSameRecoveryTransaction(record, base) {
  if (
    record.nonce !== base.nonce
    || record.migration_id !== base.migration_id
    || record.transaction_root !== base.transaction_root
    || record.journal_path !== base.journal_path
    || record.plan_hash !== base.plan_hash
    || record.pid !== base.pid
    || record.host !== base.host
    || record.created_at !== base.created_at
  ) {
    throw new IdentityMigrationError("Identity migration checkpoint does not belong to the verified transaction.");
  }
}

function processAppearsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function identityRecoveryExactMutations(root, lockRecord, claimNonces) {
  const claimPath = path.join(root, `.sdlc-identity-migration-recovery-${lockRecord.nonce}.lock`);
  const transactionRoot = path.join(root, lockRecord.transaction_root);
  const backupRoot = path.join(transactionRoot, "original");
  const liveRoot = path.join(root, ".sdlc");
  const values = [
    { operation: "path.link.target", path: claimPath },
    { operation: "lock.reclaim", path: claimPath },
    { operation: "lock.release", path: claimPath },
    { operation: "directory.remove", path: transactionRoot },
    { operation: "directory.remove", path: liveRoot },
    { operation: "path.rename.source", path: backupRoot },
    { operation: "path.rename.target", path: liveRoot },
    { operation: "file.remove", path: path.join(root, lockRecord.journal_path) },
    { operation: "lock.release", path: path.join(root, ".sdlc-identity-migration.lock") },
  ];
  for (const claimNonce of claimNonces) {
    const temporaryPath = `${claimPath}.${process.pid}.${claimNonce}.tmp`;
    values.push(
      { operation: "file.write", path: temporaryPath },
      { operation: "file.remove", path: temporaryPath },
      { operation: "path.link.source", path: temporaryPath },
    );
  }
  const unique = new Map(values.map((value) => [
    `${value.operation}\u0000${path.resolve(value.path)}`,
    Object.freeze({ operation: value.operation, path: path.resolve(value.path) }),
  ]));
  return Object.freeze([...unique.values()].sort((left, right) =>
    `${left.operation}\u0000${left.path}`.localeCompare(`${right.operation}\u0000${right.path}`, "en")));
}

function validateIdentityRecoveryPreparation(prepared, inspected) {
  if (!prepared || typeof prepared !== "object" || Array.isArray(prepared)) {
    throw new IdentityMigrationError("Identity migration recovery preparation is missing or invalid.");
  }
  const expectedHash = computeStableHash(omitKeys(prepared, ["preparation_hash"]));
  const claimNonces = prepared.claim_nonces;
  if (
    prepared.schema_version !== "identity-migration-recovery-preparation:v1"
    || prepared.preparation_hash !== expectedHash
    || prepared.root !== inspected.root
    || prepared.recovery_nonce !== inspected.lockRecord.nonce
    || prepared.plan_hash !== inspected.lockRecord.plan_hash
    || prepared.process_id !== process.pid
    || prepared.lock_identity?.dev !== Number(inspected.lockStat.dev)
    || prepared.lock_identity?.ino !== Number(inspected.lockStat.ino)
    || prepared.lock_record_hash !== computeStableHash(inspected.lockRecord)
    || !Array.isArray(claimNonces)
    || claimNonces.length !== 3
    || new Set(claimNonces).size !== claimNonces.length
    || claimNonces.some((value) => !/^[a-f0-9]{24}$/u.test(value || ""))
  ) {
    throw new IdentityMigrationError("Identity migration recovery preparation no longer matches the verified lock.");
  }
  const expectedMutations = identityRecoveryExactMutations(
    inspected.root,
    inspected.lockRecord,
    claimNonces,
  );
  if (computeStableHash(prepared.exact_mutations) !== computeStableHash(expectedMutations)) {
    throw new IdentityMigrationError("Identity migration recovery preparation has a different physical mutation set.");
  }
  return Object.freeze([...claimNonces]);
}

function acquireRecoveryClaim(root, lockRecord, preparedClaimNonces = null) {
  const claimPath = path.join(root, `.sdlc-identity-migration-recovery-${lockRecord.nonce}.lock`);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const claimNonce = preparedClaimNonces?.[attempt] ?? crypto.randomBytes(12).toString("hex");
    const temporaryPath = `${claimPath}.${process.pid}.${claimNonce}.tmp`;
    const record = {
      schema_version: "identity-migration-recovery-claim:v1",
      migration_id: lockRecord.migration_id,
      plan_hash: lockRecord.plan_hash,
      transaction_nonce: lockRecord.nonce,
      pid: process.pid,
      host: os.hostname(),
      claim_nonce: claimNonce,
      created_at: new Date().toISOString(),
    };
    let descriptor;
    let identity = null;
    let published = false;
    try {
      descriptor = mutateIdentity("file.write", temporaryPath, () => fs.openSync(temporaryPath, "wx", 0o600));
      identity = fileIdentity(fs.fstatSync(descriptor, IDENTITY_STAT_OPTIONS));
      mutateIdentity("file.write", temporaryPath, () =>
        fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`));
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      linkIdentityPath(temporaryPath, claimPath);
      published = true;
      mutateIdentity("file.remove", temporaryPath, () => fs.rmSync(temporaryPath));
      fsyncDirectory(root);
      return {
        release: () => {
          if (!unlinkVerifiedRecoveryClaim(claimPath, identity, claimNonce)) {
            throw new IdentityMigrationError("Identity migration recovery claim ownership changed before release.");
          }
        },
      };
    } catch (error) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch {}
      }
      try {
        // A prepared claim nonce is deterministic, so another recovery may own
        // this temporary path; remove it only when this attempt created it.
        removeOwnedTemporaryFile(temporaryPath, identity);
      } catch {}
      if (published && identity) {
        try { unlinkVerifiedRecoveryClaim(claimPath, identity, claimNonce); } catch {}
      }
      if (error?.code !== "EEXIST") {
        throw new IdentityMigrationError(`Cannot acquire identity migration recovery claim: ${error.message}`);
      }
    }

    let stat;
    let existing;
    try {
      stat = fs.lstatSync(claimPath, IDENTITY_STAT_OPTIONS);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new IdentityMigrationError("Identity migration recovery claim is not a safe regular file.");
      }
      existing = readRecoveryJson(claimPath, "identity migration recovery claim");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (
      existing?.schema_version !== "identity-migration-recovery-claim:v1"
      || existing.migration_id !== lockRecord.migration_id
      || existing.plan_hash !== lockRecord.plan_hash
      || existing.transaction_nonce !== lockRecord.nonce
      || !Number.isInteger(existing.pid)
      || existing.pid <= 0
      || typeof existing.host !== "string"
      || !/^[a-f0-9]{24}$/u.test(existing.claim_nonce || "")
    ) {
      throw new IdentityMigrationError("Identity migration recovery claim is malformed or belongs to another transaction.");
    }
    if (existing.host !== os.hostname()) {
      throw new IdentityMigrationError("Cannot prove that an identity migration recovery claim on another host is inactive.");
    }
    if (processAppearsAlive(existing.pid)) {
      throw new IdentityMigrationError("Identity migration recovery is already running in another process.");
    }
    const removed = unlinkVerifiedRecoveryClaim(
      claimPath,
      fileIdentity(stat),
      existing.claim_nonce,
      "lock.reclaim",
    );
    if (!removed && fs.existsSync(claimPath)) {
      throw new IdentityMigrationError("Identity migration recovery claim changed during verified takeover.");
    }
  }
  throw new IdentityMigrationError("Identity migration recovery claim remained contended after verified takeover attempts.");
}

function unlinkVerifiedRecoveryClaim(claimPath, expectedIdentity, claimNonce, operation = "lock.release") {
  if (!fs.existsSync(claimPath)) return false;
  const stat = fs.lstatSync(claimPath, IDENTITY_STAT_OPTIONS);
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || !sameFileIdentityValues(stat, expectedIdentity)
  ) return false;
  const current = readRecoveryJson(claimPath, "identity migration recovery claim");
  if (current?.claim_nonce !== claimNonce) return false;
  mutateIdentity(operation, claimPath, () => fs.rmSync(claimPath));
  fsyncDirectory(path.dirname(claimPath));
  return true;
}

function recoveryCommitIsComplete(root, record) {
  if (
    !["committed", "finalized"].includes(record.phase)
    || !record.expected_receipt_path
    || !record.expected_receipt_hash
    || !SHA256_PATTERN.test(record.after_manifest_hash || "")
  ) return false;
  const liveRoot = path.join(root, ".sdlc");
  if (!fs.existsSync(liveRoot) || computeTreeManifestHash(liveRoot) !== record.after_manifest_hash) return false;
  const receiptPath = path.join(root, normalizeReferencePath(record.expected_receipt_path));
  if (!fs.existsSync(receiptPath) || fs.lstatSync(receiptPath).isSymbolicLink()) return false;
  const receipt = readRecoveryJson(receiptPath, "identity migration receipt");
  return validateIdentityMigrationReceipt(receipt).valid && receipt.receipt_hash === record.expected_receipt_hash;
}

function remapIdentityMigrationInternal(internal, shadowRoot) {
  const shadowProjectRoot = path.dirname(shadowRoot);
  const writes = new Map();
  for (const [filePath, content] of internal.writes) {
    const relativePath = path.relative(internal.root, filePath);
    if (!relativePath || path.isAbsolute(relativePath) || relativePath.split(path.sep).includes("..")) {
      throw new IdentityMigrationError("Planned migration write cannot be mapped into the shadow tree.");
    }
    writes.set(path.join(shadowProjectRoot, relativePath), content);
  }
  return {
    ...internal,
    root: shadowProjectRoot,
    sdlcRoot: shadowRoot,
    writes,
  };
}

function rollbackIdentityTransaction(projectRoot, liveRoot, transactionRoot, backupRoot, expectedManifestHash = null) {
  if (!isInside(projectRoot, transactionRoot) || !isInside(transactionRoot, backupRoot)) {
    throw new IdentityMigrationError("Identity migration rollback paths escape the project root.");
  }
  const backupStat = lstatIfPresent(backupRoot);
  const liveStat = lstatIfPresent(liveRoot);
  const backupExists = Boolean(backupStat);
  const liveExists = Boolean(liveStat);
  if (backupExists) {
    if (!backupStat.isDirectory() || backupStat.isSymbolicLink()) {
      throw new IdentityMigrationError("Identity migration rollback backup is not a safe directory.");
    }
    if (expectedManifestHash && computeTreeManifestHash(backupRoot) !== expectedManifestHash) {
      throw new IdentityMigrationError("Identity migration rollback backup does not match the durable pre-migration manifest.");
    }
    if (liveExists) {
      if (!liveStat.isDirectory() || liveStat.isSymbolicLink()) {
        throw new IdentityMigrationError("Identity migration live tree is not a safe directory for rollback.");
      }
      mutateIdentity("directory.remove", liveRoot, () =>
        fs.rmSync(liveRoot, { recursive: true, force: true }));
    }
    renameIdentityPath(backupRoot, liveRoot);
    fsyncDirectory(projectRoot);
    fsyncDirectory(transactionRoot);
    if (expectedManifestHash && computeTreeManifestHash(liveRoot) !== expectedManifestHash) {
      throw new IdentityMigrationError("Restored SDLC tree does not match the durable pre-migration manifest.");
    }
    return;
  }
  if (!liveExists) {
    throw new IdentityMigrationError("Neither the live SDLC tree nor its rollback backup is available.");
  }
  if (!liveStat.isDirectory() || liveStat.isSymbolicLink()) {
    throw new IdentityMigrationError("Identity migration live tree is not a safe directory.");
  }
  if (expectedManifestHash && computeTreeManifestHash(liveRoot) !== expectedManifestHash) {
    throw new IdentityMigrationError("Live SDLC tree does not match the durable pre-migration manifest.");
  }
}

function assertPlanPreconditions(plan, internal) {
  assertNoSymlinks(internal.sdlcRoot);
  if (!(internal.inputHashes instanceof Map)) {
    throw new IdentityMigrationError("Migration plan does not contain canonical input preconditions.");
  }
  const currentDocuments = loadDocuments(internal.root, internal.sdlcRoot);
  if (currentDocuments.size !== internal.inputHashes.size) {
    throw new IdentityMigrationError("Canonical SDLC files changed after migration planning.");
  }
  for (const [relativePath, expectedState] of internal.inputHashes) {
    const current = currentDocuments.get(relativePath);
    if (
      !current
      || sha256(current.raw) !== expectedState?.sha256
      || (fs.lstatSync(current.absolutePath).mode & 0o7777) !== expectedState?.mode
    ) {
      throw new IdentityMigrationError(`Canonical SDLC file changed after planning: ${relativePath}.`);
    }
  }
  for (const changed of plan.changed_files || []) {
    const filePath = path.resolve(internal.root, changed.path);
    if (!isInside(internal.root, filePath) || !fs.existsSync(filePath) || fs.lstatSync(filePath).isSymbolicLink()) {
      throw new IdentityMigrationError(`Planned source file is missing or unsafe: ${changed.path}.`);
    }
    const currentHash = sha256(fs.readFileSync(filePath));
    if (currentHash !== changed.before_sha256) {
      throw new IdentityMigrationError(`Planned source file changed after planning: ${changed.path}.`);
    }
    if ((fs.lstatSync(filePath).mode & 0o7777) !== changed.before_mode) {
      throw new IdentityMigrationError(`Planned source file mode changed after planning: ${changed.path}.`);
    }
  }
  if (plan.receipt_path) {
    const receiptPath = path.resolve(internal.root, plan.receipt_path);
    if (!isInside(internal.root, receiptPath)) {
      throw new IdentityMigrationError("Migration receipt path resolves outside the project root.");
    }
    if (fs.existsSync(receiptPath)) {
      throw new IdentityMigrationError("Migration receipt appeared after planning; refusing to overwrite it.");
    }
  }
}

function assertAppliedPlanState(plan, internal) {
  for (const changed of plan.changed_files || []) {
    const filePath = path.resolve(internal.root, changed.path);
    if (!isInside(internal.root, filePath) || !fs.existsSync(filePath) || fs.lstatSync(filePath).isSymbolicLink()) {
      throw new IdentityMigrationError(`Applied file is missing or unsafe: ${changed.path}.`);
    }
    if (sha256(fs.readFileSync(filePath)) !== changed.after_sha256) {
      throw new IdentityMigrationError(`Applied file does not match the planned post-state: ${changed.path}.`);
    }
    if ((fs.lstatSync(filePath).mode & 0o7777) !== changed.after_mode) {
      throw new IdentityMigrationError(`Applied file mode does not match the planned post-state: ${changed.path}.`);
    }
  }
  const receiptPath = path.resolve(internal.root, plan.receipt_path);
  const receipt = readExistingMigrationReceipt(receiptPath, {
    migrationId: plan.id,
    sourceDigest: plan.source_identity_digest,
    targetDigest: plan.target_identity_digest,
  });
  if (receipt.plan_hash !== plan.plan_hash) {
    throw new IdentityMigrationError("Applied identity migration receipt is not bound to the reviewed plan.");
  }
  if (receipt.receipt_hash !== internal.receipt.receipt_hash) {
    throw new IdentityMigrationError("Applied identity migration receipt differs from the planned receipt.");
  }
}

export function publicIdentityMigrationPlan(plan) {
  return publicPlan(plan);
}

export function validateIdentityMigrationReceipt(receipt) {
  const errors = [];
  const schemaValidation = validateAgainstSchema(receipt, "identity-migration-receipt.schema.json", {
    schemaDir: PLUGIN_SCHEMA_DIR,
  });
  errors.push(...schemaValidation.errors.map((error) => `${error.instance_path}: ${error.message}`));
  if (receipt?.kind !== "identity_migration_receipt") errors.push("receipt kind is invalid");
  if (receipt?.schema_version !== MIGRATION_SCHEMA) errors.push("receipt schema version is invalid");
  if (!SHA256_PATTERN.test(receipt?.plan_hash || "")) errors.push("receipt plan hash is invalid");
  if (!SHA256_PATTERN.test(receipt?.source_identity_digest || "")) errors.push("source identity digest is invalid");
  if (!SHA256_PATTERN.test(receipt?.target_identity_digest || "")) errors.push("target identity digest is invalid");
  if (receipt?.source_identity_digest === receipt?.target_identity_digest) {
    errors.push("source and target identity digests must differ");
  }
  if (receipt?.target_identity?.email_digest !== receipt?.target_identity_digest) {
    errors.push("target identity digest does not match the target identity record");
  }
  const expectedId = SHA256_PATTERN.test(receipt?.source_identity_digest || "")
    && SHA256_PATTERN.test(receipt?.target_identity_digest || "")
    ? `MIG-IDENTITY-${receipt.source_identity_digest.slice(0, 12)}-${receipt.target_identity_digest.slice(0, 12)}`
    : null;
  if (expectedId && receipt?.id !== expectedId) errors.push("receipt id does not match the identity digests");
  if (receipt?.source_occurrences_after !== 0) errors.push("receipt does not attest a clean post-state");
  const changedPaths = new Set();
  let identityReplacementTotal = 0;
  for (const changed of receipt?.changed_files || []) {
    let normalizedPath = null;
    try {
      normalizedPath = normalizeReferencePath(changed?.path);
    } catch {
      errors.push(`changed file ${changed?.path || "unknown"} does not use a canonical project path`);
    }
    if (normalizedPath && !normalizedPath.startsWith(".sdlc/")) {
      errors.push(`changed file ${normalizedPath} is outside the SDLC tree`);
    }
    if (normalizedPath && changedPaths.has(normalizedPath)) {
      errors.push(`changed file path is duplicated: ${normalizedPath}`);
    }
    if (normalizedPath) changedPaths.add(normalizedPath);
    if (changed?.before_sha256 === changed?.after_sha256) {
      errors.push(`changed file ${changed?.path || "unknown"} does not record a hash transition`);
    }
    if (changed?.before_mode !== changed?.after_mode) {
      errors.push(`changed file ${changed?.path || "unknown"} does not preserve its filesystem mode`);
    }
    if (Number.isInteger(changed?.identity_replacements)) {
      identityReplacementTotal += changed.identity_replacements;
    }
  }
  if (
    Number.isInteger(receipt?.source_occurrences_before)
    && identityReplacementTotal < receipt.source_occurrences_before
  ) {
    errors.push("changed files do not account for every source identity occurrence");
  }
  const rewriteTransitions = new Map();
  const rewriteEntries = new Set();
  for (const rewrite of receipt?.hash_rewrites || []) {
    if (rewrite?.before_hash === rewrite?.after_hash) {
      errors.push(`hash rewrite ${rewrite?.id || "unknown"} does not record a hash transition`);
    }
    const priorTarget = rewriteTransitions.get(rewrite?.before_hash);
    if (priorTarget && priorTarget !== rewrite?.after_hash) {
      errors.push(`hash rewrite ${rewrite?.before_hash || "unknown"} has ambiguous post-migration targets`);
    }
    if (rewrite?.before_hash) rewriteTransitions.set(rewrite.before_hash, rewrite?.after_hash);
    const rewriteKey = `${rewrite?.kind || "unknown"}:${rewrite?.id || ""}:${rewrite?.before_hash || ""}:${rewrite?.after_hash || ""}`;
    if (rewriteEntries.has(rewriteKey)) {
      errors.push(`hash rewrite ${rewrite?.id || "unknown"} is duplicated`);
    }
    rewriteEntries.add(rewriteKey);
  }
  const expectedHash = computeStableHash(omitKeys(receipt, ["receipt_hash", "hash_algorithm"]));
  if (receipt?.receipt_hash !== expectedHash) errors.push("receipt hash does not match canonical content");
  if (receipt?.hash_algorithm !== "sha256:stable-json:v1") errors.push("receipt hash algorithm is invalid");
  return { valid: errors.length === 0, expected_hash: expectedHash, errors };
}

function reconcileIntegrity(documents, originals) {
  const hashRewrites = new Map();
  const fileHashLineage = new Map();
  for (const [relativePath, bytes] of originals) {
    fileHashLineage.set(relativePath, new Set([sha256(bytes)]));
  }

  const maximumPasses = Math.max(32, documents.size * 4);
  for (let pass = 0; pass < maximumPasses; pass += 1) {
    let changed = false;

    const subjectMappings = new Map();
    for (const document of documents.values()) {
      for (const record of document.records) {
        if (isImmutableIntegrityRecord(record)) continue;
        changed = rewriteCanonicalReceiptSubjectBinding(
          record,
          document.relativePath,
          subjectMappings,
          hashRewrites,
        ) || changed;
      }
    }
    changed = replaceExactHashes(documents, subjectMappings) || changed;

    const contentMappings = new Map();
    for (const document of documents.values()) {
      for (const record of document.records) {
        if (isImmutableIntegrityRecord(record)) continue;
        changed = rewriteApprovedRecordHashes(record, document.relativePath, contentMappings, hashRewrites) || changed;
        changed = rewriteCanonicalAuthorizations(record, document.relativePath, contentMappings, hashRewrites) || changed;
      }
    }
    changed = replaceExactHashes(documents, contentMappings) || changed;

    const revocationMappings = new Map();
    for (const document of documents.values()) {
      for (const record of document.records) {
        if (isImmutableIntegrityRecord(record)) continue;
        changed = rewriteCanonicalRevocations(record, document.relativePath, revocationMappings, hashRewrites) || changed;
      }
    }
    changed = replaceExactHashes(documents, revocationMappings) || changed;

    const receiptMappings = new Map();
    for (const document of documents.values()) {
      for (const record of document.records) {
        if (isImmutableIntegrityRecord(record)) continue;
        changed = rewriteSupportedReceiptHash(record, document.relativePath, receiptMappings, hashRewrites) || changed;
      }
    }
    changed = replaceExactHashes(documents, receiptMappings) || changed;

    const currentFileState = new Map();
    for (const document of documents.values()) {
      const bytes = plannedDocumentBytes(document);
      const state = { sha256: sha256(bytes), size_bytes: Buffer.byteLength(bytes) };
      currentFileState.set(document.relativePath, state);
      fileHashLineage.get(document.relativePath).add(state.sha256);
    }
    changed = rewriteFileReferences(documents, currentFileState, fileHashLineage) || changed;
    if (!changed) {
      return { hashRewrites: Array.from(hashRewrites.values()).sort(compareRewrite) };
    }
  }
  throw new IdentityMigrationError("Integrity reconciliation did not converge; cyclic or unsupported hash lineage detected.");
}

function rewriteCanonicalReceiptSubjectBinding(record, relativePath, mappings, rewrites) {
  if (!CANONICAL_AUTHORIZATION_RECEIPTS.has(record?.schema_version) || record.subject === null || record.subject === undefined) {
    return false;
  }
  let changed = false;
  const beforeSubjectHash = record.subject_hash;
  const afterSubjectHash = computeAuthorizationSubjectHash(record.subject);
  if (beforeSubjectHash !== afterSubjectHash) {
    record.subject_hash = afterSubjectHash;
    addHashMapping(mappings, beforeSubjectHash, afterSubjectHash, `${relativePath}#${record.id || "authorization-subject"}`);
    addRewrite(rewrites, "authorization_subject", record.id, beforeSubjectHash, afterSubjectHash);
    changed = true;
  }
  if (record.schema_version === "authorization-usage-receipt:v2") {
    const beforeUseHash = record.use_hash;
    const afterUseHash = computeAuthorizationUseHash(record.action, record.subject_hash);
    if (beforeUseHash !== afterUseHash) {
      record.use_hash = afterUseHash;
      addHashMapping(mappings, beforeUseHash, afterUseHash, `${relativePath}#${record.id || "authorization-use"}`);
      addRewrite(rewrites, "authorization_use", record.id, beforeUseHash, afterUseHash);
      changed = true;
    }
  }
  return changed;
}

function rewriteApprovedRecordHashes(record, relativePath, mappings, rewrites) {
  let changed = false;
  if (record?.schema_version === LEGACY_AUTHORIZATION_SCHEMA && typeof record.approved_content_hash === "string") {
    const before = record.approved_content_hash;
    const after = hashLegacyAuthorization(record);
    if (before !== after) {
      record.approved_content_hash = after;
      addHashMapping(mappings, before, after, `${relativePath}#${record.id || "authorization"}`);
      addRewrite(rewrites, "authorization", record.id, before, after);
      changed = true;
    }
  }
  visitMutableIntegrityObjects(record, (candidate) => {
    if (!Array.isArray(candidate?.approvals) || candidate.approvals.length === 0) return;
    const after = hashApprovalSubject(candidate);
    for (const approval of candidate.approvals) {
      if (typeof approval?.approved_content_hash !== "string" || approval.approved_content_hash === after) continue;
      if (integrityBoundaryKind(approval, false, "approval")) {
        throw new IdentityMigrationError(
          `Identity migration would alter an approval hash inside unsupported or signed immutable lineage at ${relativePath}.`,
          { path: relativePath, schema_version: approval.schema_version || null },
        );
      }
      const before = approval.approved_content_hash;
      approval.approved_content_hash = after;
      addHashMapping(mappings, before, after, `${relativePath}#${approval.id || candidate.id || "approval"}`);
      addRewrite(rewrites, "approval", approval.id || candidate.id, before, after);
      changed = true;
    }
  });
  return changed;
}

function rewriteCanonicalAuthorizations(record, relativePath, mappings, rewrites) {
  let changed = false;
  visitMutableIntegrityObjects(record, (candidate) => {
    if (!CANONICAL_AUTHORIZATION_SCHEMAS.has(candidate?.schema_version)) return;
    if (candidate.schema_version === "content-authorization:v2") {
      const normalizedUses = candidate.allowed_uses.map((allowedUse) => {
        const beforeUseHash = allowedUse.use_hash;
        const afterUseHash = computeAuthorizationUseHash(allowedUse.action, allowedUse.subject_hash);
        if (beforeUseHash !== afterUseHash) {
          addHashMapping(mappings, beforeUseHash, afterUseHash, `${relativePath}#${candidate.id || "authorization-use"}`);
          addRewrite(rewrites, "authorization_use", candidate.id, beforeUseHash, afterUseHash);
          changed = true;
        }
        return { action: allowedUse.action, subject_hash: allowedUse.subject_hash, use_hash: afterUseHash };
      });
      const uniqueUses = Array.from(new Map(normalizedUses.map((allowedUse) => [allowedUse.use_hash, allowedUse])).values())
        .sort((left, right) => left.use_hash.localeCompare(right.use_hash));
      const actions = Array.from(new Set(uniqueUses.map((allowedUse) => allowedUse.action))).sort();
      const subjectHashes = Array.from(new Set(uniqueUses.map((allowedUse) => allowedUse.subject_hash))).sort();
      if (JSON.stringify(candidate.allowed_uses) !== JSON.stringify(uniqueUses)) {
        candidate.allowed_uses = uniqueUses;
        changed = true;
      }
      if (JSON.stringify(candidate.allowed_actions) !== JSON.stringify(actions)) {
        candidate.allowed_actions = actions;
        changed = true;
      }
      if (JSON.stringify(candidate.allowed_subject_hashes) !== JSON.stringify(subjectHashes)) {
        candidate.allowed_subject_hashes = subjectHashes;
        changed = true;
      }
    }

    const beforeScopeHash = candidate.scope_hash;
    const afterScopeHash = computeStableHash(candidate.scope);
    if (beforeScopeHash !== afterScopeHash) {
      candidate.scope_hash = afterScopeHash;
      addHashMapping(mappings, beforeScopeHash, afterScopeHash, `${relativePath}#${candidate.id || "authorization-scope"}`);
      addRewrite(rewrites, "authorization_scope", candidate.id, beforeScopeHash, afterScopeHash);
      changed = true;
    }

    const beforeAuthorizationHash = candidate.authorization_hash;
    const afterAuthorizationHash = computeAuthorizationHash(candidate);
    if (beforeAuthorizationHash !== afterAuthorizationHash) {
      candidate.authorization_hash = afterAuthorizationHash;
      addHashMapping(mappings, beforeAuthorizationHash, afterAuthorizationHash, `${relativePath}#${candidate.id || "authorization"}`);
      addRewrite(rewrites, "authorization", candidate.id, beforeAuthorizationHash, afterAuthorizationHash);
      changed = true;
    }
  });
  return changed;
}

function rewriteCanonicalRevocations(record, relativePath, mappings, rewrites) {
  let changed = false;
  visitMutableIntegrityObjects(record, (candidate) => {
    if (candidate?.schema_version !== CANONICAL_AUTHORIZATION_REVOCATION) return;
    const before = candidate.revocation_hash;
    const after = computeStableHash(omitKeys(candidate, ["revocation_hash", "hash_algorithm"]));
    if (before === after) return;
    candidate.revocation_hash = after;
    addHashMapping(mappings, before, after, `${relativePath}#${candidate.id || "revocation"}`);
    addRewrite(rewrites, "revocation", candidate.id, before, after);
    changed = true;
  });
  return changed;
}

function rewriteSupportedReceiptHash(record, relativePath, mappings, rewrites) {
  if (!record || typeof record !== "object" || Array.isArray(record) || typeof record.receipt_hash !== "string") {
    return false;
  }
  const supported = LEGACY_AUTHORIZATION_RECEIPTS.has(record.schema_version)
    || CANONICAL_AUTHORIZATION_RECEIPTS.has(record.schema_version);
  if (!supported) return false;
  const before = record.receipt_hash;
  const after = computeStableHash(omitKeys(record, ["receipt_hash", "hash_algorithm"]));
  if (before === after) return false;
  record.receipt_hash = after;
  addHashMapping(mappings, before, after, `${relativePath}#${record.id || "receipt"}`);
  addRewrite(rewrites, "receipt", record.id, before, after);
  return true;
}

function replaceExactHashes(documents, mappings) {
  if (mappings.size === 0) return false;
  let changed = false;
  for (const document of documents.values()) {
    for (const record of document.records) {
      changed = replaceMappedHashesIntegrity(record, mappings, (immutable) => {
        const affected = findMappedHashes(immutable, mappings);
        if (affected.length > 0) {
          throw new IdentityMigrationError(
            `Identity migration would alter unsupported or signed immutable lineage at ${document.relativePath}.`,
            { path: document.relativePath, schema_version: immutable.schema_version || null },
          );
        }
      }) || changed;
    }
  }
  return changed;
}

function rewriteFileReferences(documents, currentState, lineage) {
  let changed = false;
  for (const document of documents.values()) {
    for (const record of document.records) {
      visitIntegrityObjects(record, (candidate, immutable) => {
        if (!isSupportedFileReference(candidate)) return;
        const normalizedPath = normalizeReferencePath(candidate.path);
        const state = currentState.get(normalizedPath);
        const knownHashes = lineage.get(normalizedPath);
        if (!state || !knownHashes) {
          if (immutable || isHistoricalLineageDocument(document)) return;
          const materialized = readMaterializedFileReferenceState(document.projectRoot, normalizedPath);
          if (materialized) {
            validateMaterializedFileReference(candidate, materialized, document.relativePath, normalizedPath);
            return;
          }
          if (normalizedPath.startsWith(".sdlc/") && !isHistoricalEvidenceSnapshot(candidate)) {
            throw new IdentityMigrationError(`File reference target is not materialized canonical SDLC state at ${document.relativePath}.`, {
              referenced_path: normalizedPath,
            });
          }
          return;
        }
        const hashKeys = fileReferenceHashKeys(candidate, state, knownHashes);
        if (hashKeys.length === 0 && isHistoricalEvidenceSnapshot(candidate)) return;
        if (hashKeys.length === 0) {
          throw new IdentityMigrationError(`File reference hash semantics are ambiguous at ${document.relativePath}.`, {
            referenced_path: normalizedPath,
          });
        }
        for (const key of hashKeys) {
          if (typeof candidate[key] === "string" && knownHashes.has(candidate[key]) && candidate[key] !== state.sha256) {
            if (immutable) {
              throw new IdentityMigrationError(
                `Identity migration would alter a file reference inside unsupported or signed immutable lineage at ${document.relativePath}.`,
                { path: document.relativePath, referenced_path: normalizedPath },
              );
            }
            candidate[key] = state.sha256;
            if (Number.isInteger(candidate.size_bytes)) {
              candidate.size_bytes = state.size_bytes;
            }
            changed = true;
          }
        }
      });
    }
  }
  return changed;
}

function validateIntegrity(documents, { byteSource = "raw" } = {}) {
  const authorizations = new Map();
  for (const document of documents.values()) {
    for (const record of document.records) {
      if (record?.schema_version === LEGACY_AUTHORIZATION_SCHEMA) {
        const expected = hashLegacyAuthorization(record);
        if (record.approved_content_hash !== expected) {
          throw new IdentityMigrationError(`Authorization integrity failed at ${document.relativePath}.`);
        }
        authorizations.set(record.id, record);
      }
      visitObjects(record, (candidate) => {
        if (CANONICAL_AUTHORIZATION_SCHEMAS.has(candidate?.schema_version)) {
          assertSchemaValid(candidate, "content-authorization.schema.json", document.relativePath);
          const validation = validateAuthorizationSnapshotIntegrity(candidate);
          if (!validation.valid) {
            throw new IdentityMigrationError(
              `Canonical authorization integrity failed at ${document.relativePath}: ${validation.errors.join("; ")}`,
            );
          }
          const existing = authorizations.get(candidate.id);
          if (existing && authorizationRecordHash(existing) !== candidate.authorization_hash) {
            throw new IdentityMigrationError(`Authorization lineage is ambiguous for ${candidate.id} at ${document.relativePath}.`);
          }
          authorizations.set(candidate.id, candidate);
        }
        if (candidate?.schema_version === CANONICAL_AUTHORIZATION_REVOCATION) {
          const validation = validateAuthorizationRevocationIntegrity(candidate);
          if (!validation.valid) {
            throw new IdentityMigrationError(
              `Authorization revocation integrity failed at ${document.relativePath}: ${validation.errors.join("; ")}`,
            );
          }
        }
      });
      visitObjects(record, (candidate) => {
        if (!Array.isArray(candidate?.approvals)) return;
        const expected = hashApprovalSubject(candidate);
        for (const approval of candidate.approvals) {
          if (approval?.approved_content_hash && approval.approved_content_hash !== expected) {
            throw new IdentityMigrationError(`Approval integrity failed at ${document.relativePath}.`);
          }
        }
      });
    }
  }
  for (const document of documents.values()) {
    for (const record of document.records) {
      if (CANONICAL_AUTHORIZATION_RECEIPTS.has(record?.schema_version)) {
        assertSchemaValid(record, "authorization-usage-receipt.schema.json", document.relativePath);
        if (record.effective_revocation) {
          const revocation = record.effective_revocation;
          const validation = validateAuthorizationRevocationIntegrity(revocation);
          if (!validation.valid) {
            throw new IdentityMigrationError(`Embedded authorization revocation integrity failed at ${document.relativePath}.`);
          }
          if (revocation.authorization_id !== record.authorization_id || revocation.authorization_hash !== record.authorization_hash) {
            throw new IdentityMigrationError(`Embedded authorization revocation lineage failed at ${document.relativePath}.`);
          }
        }
        const validation = validateAuthorizationUsageReceipt(record);
        if (!validation.valid) {
          throw new IdentityMigrationError(
            `Canonical authorization receipt integrity failed at ${document.relativePath}: ${validation.errors.join("; ")}`,
          );
        }
        const authorization = authorizations.get(record.authorization_id);
        if (authorization && record.authorization_hash !== authorizationRecordHash(authorization)) {
          throw new IdentityMigrationError(`Canonical authorization receipt lineage failed at ${document.relativePath}.`);
        }
        continue;
      }
      if (record?.schema_version === MIGRATION_SCHEMA) {
        const validation = validateIdentityMigrationReceipt(record);
        if (!validation.valid) {
          throw new IdentityMigrationError(
            `Historical identity migration receipt integrity failed at ${document.relativePath}: ${validation.errors.join("; ")}`,
          );
        }
        continue;
      }
      if (LEGACY_AUTHORIZATION_RECEIPTS.has(record?.schema_version)) {
        const expected = computeStableHash(omitKeys(record, ["receipt_hash", "hash_algorithm"]));
        if (record.receipt_hash !== expected) {
          throw new IdentityMigrationError(`Authorization receipt integrity failed at ${document.relativePath}.`);
        }
        const authorization = authorizations.get(record.authorization_id);
        if (authorization && record.authorization_hash !== authorizationRecordHash(authorization)) {
          throw new IdentityMigrationError(`Authorization receipt lineage failed at ${document.relativePath}.`);
        }
      }
    }
  }
  validateProjectBootstrapLineage(documents);
  validateFileReferences(documents, byteSource);
}

function validateProjectBootstrapLineage(documents) {
  const manifestDocument = documents.get(PROJECT_BOOTSTRAP_MANIFEST_PATH);
  const journalDocument = documents.get(PROJECT_BOOTSTRAP_JOURNAL_PATH);
  if (!manifestDocument && !journalDocument) return;

  const project = singleCanonicalJsonRecord(
    documents.get(PROJECT_RECORD_PATH),
    PROJECT_RECORD_PATH,
    { required: true },
  );
  const manifest = singleCanonicalJsonRecord(
    manifestDocument,
    PROJECT_BOOTSTRAP_MANIFEST_PATH,
  );
  const journal = singleCanonicalJsonRecord(
    journalDocument,
    PROJECT_BOOTSTRAP_JOURNAL_PATH,
  );

  if (manifest) {
    assertSchemaValid(
      manifest,
      "project-bootstrap-manifest.schema.json",
      PROJECT_BOOTSTRAP_MANIFEST_PATH,
    );
    const expectedManifestHash = computeStableHash(
      omitKeys(manifest, ["manifest_hash"]),
    );
    if (
      manifest.schema_version !== PROJECT_BOOTSTRAP_MANIFEST_SCHEMA
      || manifest.hash_algorithm !== "sha256:stable-json:v1"
      || manifest.manifest_hash !== expectedManifestHash
    ) {
      throw new IdentityMigrationError(
        `Project bootstrap manifest integrity failed at ${PROJECT_BOOTSTRAP_MANIFEST_PATH}.`,
      );
    }
    if (
      project
      && manifest.project_binding_sha256
        !== computeStableHash({ project_id: project.project_id })
    ) {
      throw new IdentityMigrationError(
        `Project bootstrap manifest belongs to a different project at ${PROJECT_BOOTSTRAP_MANIFEST_PATH}.`,
      );
    }
  }

  if (!journal) {
    // Compatibility for projects sealed before the recovery journal existed.
    if (manifest?.bootstrap_journal || project?.bootstrap_journal) {
      throw new IdentityMigrationError(
        `Project bootstrap journal is missing at ${PROJECT_BOOTSTRAP_JOURNAL_PATH}.`,
      );
    }
    return;
  }

  assertSchemaValid(
    journal,
    "project-bootstrap-journal.schema.json",
    PROJECT_BOOTSTRAP_JOURNAL_PATH,
  );
  const expectedJournalHash = computeStableHash(
    omitKeys(journal, ["journal_hash"]),
  );
  if (
    journal.schema_version !== PROJECT_BOOTSTRAP_JOURNAL_SCHEMA
    || journal.hash_algorithm !== "sha256:stable-json:v1"
    || journal.journal_hash !== expectedJournalHash
    || journal.request_hash !== computeStableHash(journal.request)
  ) {
    throw new IdentityMigrationError(
      `Project bootstrap journal integrity failed at ${PROJECT_BOOTSTRAP_JOURNAL_PATH}.`,
    );
  }

  const expectedJournalReference = {
    path: PROJECT_BOOTSTRAP_JOURNAL_PATH,
    schema_version: PROJECT_BOOTSTRAP_JOURNAL_SCHEMA,
    request_hash: journal.request_hash,
  };
  if (
    !project?.bootstrap_journal
    || !manifest?.bootstrap_journal
    || computeStableHash(project.bootstrap_journal)
      !== computeStableHash(expectedJournalReference)
    || computeStableHash(manifest.bootstrap_journal)
      !== computeStableHash(expectedJournalReference)
  ) {
    throw new IdentityMigrationError(
      `Project bootstrap journal binding failed at ${PROJECT_BOOTSTRAP_JOURNAL_PATH}.`,
    );
  }

  if (journal.status !== "completed" || !manifest) {
    throw new IdentityMigrationError(
      "Identity migration requires a completed project bootstrap manifest and journal.",
    );
  }
  const preparedManifest = journal.prepared_manifest;
  const expectedCompletedManifestReference = {
    path: PROJECT_BOOTSTRAP_MANIFEST_PATH,
    schema_version: PROJECT_BOOTSTRAP_MANIFEST_SCHEMA,
    manifest_hash: manifest.manifest_hash,
    hash_algorithm: "sha256:stable-json:v1",
  };
  if (
    computeStableHash(preparedManifest) !== computeStableHash(manifest)
    || computeStableHash(journal.completed_manifest_ref)
      !== computeStableHash(expectedCompletedManifestReference)
  ) {
    throw new IdentityMigrationError(
      `Project bootstrap journal does not bind the exact immutable manifest at ${PROJECT_BOOTSTRAP_JOURNAL_PATH}.`,
    );
  }
}

function singleCanonicalJsonRecord(document, relativePath, options = {}) {
  if (!document) {
    if (options.required) {
      throw new IdentityMigrationError(
        `Required canonical project record is missing at ${relativePath}.`,
      );
    }
    return null;
  }
  if (document.jsonl || document.records.length !== 1) {
    throw new IdentityMigrationError(
      `Canonical project record must contain one JSON object at ${relativePath}.`,
    );
  }
  const record = document.records[0];
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new IdentityMigrationError(
      `Canonical project record is invalid at ${relativePath}.`,
    );
  }
  return record;
}

function authorizationRecordHash(record) {
  return record?.authorization_hash || record?.approved_content_hash || null;
}

function assertSchemaValid(record, schemaName, relativePath) {
  const validation = validateAgainstSchema(record, schemaName, { schemaDir: PLUGIN_SCHEMA_DIR });
  if (!validation.valid) {
    throw new IdentityMigrationError(
      `${schemaName} validation failed at ${relativePath}: ${validation.errors.slice(0, 8).map((error) => `${error.instance_path}: ${error.message}`).join("; ")}`,
    );
  }
}

function validateFileReferences(documents, byteSource) {
  const states = new Map();
  for (const document of documents.values()) {
    const bytes = byteSource === "rendered" ? plannedDocumentBytes(document) : document.raw;
    states.set(document.relativePath, {
      sha256: sha256(bytes),
      size_bytes: Buffer.byteLength(bytes),
    });
  }
  for (const document of documents.values()) {
    for (const record of document.records) {
      visitIntegrityObjects(record, (candidate, immutable) => {
        if (!isSupportedFileReference(candidate)) return;
        const normalizedPath = normalizeReferencePath(candidate.path);
        const state = states.get(normalizedPath);
        if (!state) {
          if (immutable || isHistoricalLineageDocument(document)) return;
          const materialized = readMaterializedFileReferenceState(document.projectRoot, normalizedPath);
          if (materialized) {
            validateMaterializedFileReference(candidate, materialized, document.relativePath, normalizedPath);
            return;
          }
          if (normalizedPath.startsWith(".sdlc/") && !isHistoricalEvidenceSnapshot(candidate)) {
            throw new IdentityMigrationError(`File reference target is not materialized canonical SDLC state at ${document.relativePath}.`, {
              referenced_path: normalizedPath,
            });
          }
          return;
        }
        const hashKeys = fileReferenceHashKeys(candidate, state);
        if (hashKeys.length === 0 && isHistoricalEvidenceSnapshot(candidate)) return;
        if (hashKeys.length === 0) {
          throw new IdentityMigrationError(`File reference hash semantics are ambiguous at ${document.relativePath}.`, {
            referenced_path: normalizedPath,
          });
        }
        for (const key of hashKeys) {
          if (typeof candidate[key] !== "string" || !SHA256_PATTERN.test(candidate[key])) {
            throw new IdentityMigrationError(`File reference ${key} is invalid at ${document.relativePath}.`, {
              referenced_path: normalizedPath,
            });
          }
          if (candidate[key] !== state.sha256) {
            throw new IdentityMigrationError(`File reference lineage failed at ${document.relativePath}.`, {
              referenced_path: normalizedPath,
              hash_field: key,
            });
          }
        }
        if (hashKeys.length > 0 && Object.hasOwn(candidate, "size_bytes") && candidate.size_bytes !== state.size_bytes) {
          throw new IdentityMigrationError(`File reference size failed at ${document.relativePath}.`, {
            referenced_path: normalizedPath,
          });
        }
      });
    }
  }
}

function isSupportedFileReference(candidate) {
  const hashAlgorithm = candidate && typeof candidate === "object"
    ? Object.entries(candidate).find(([key]) => normalizeIntegrityKey(key) === "hash_algorithm")?.[1]
    : null;
  if (typeof hashAlgorithm === "string" && hashAlgorithm !== "sha256:file:v1") return false;
  return Boolean(
    candidate
    && typeof candidate === "object"
    && !Array.isArray(candidate)
    && typeof candidate.path === "string"
    && (
      Object.hasOwn(candidate, "sha256")
      || (
        Object.hasOwn(candidate, "hash")
        && (
          Number.isInteger(candidate.size_bytes)
          || (!Object.hasOwn(candidate, "id") && !Object.hasOwn(candidate, "kind"))
        )
      )
    ),
  );
}

function readMaterializedFileReferenceState(projectRoot, relativePath) {
  const filePath = path.resolve(projectRoot, relativePath);
  if (!isInside(projectRoot, filePath)) {
    throw new IdentityMigrationError("Materialized file reference resolves outside the project root.", {
      referenced_path: relativePath,
    });
  }
  assertNoSymlinkPathSegments(projectRoot, filePath);
  const stat = lstatIfPresent(filePath);
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new IdentityMigrationError("Materialized file reference is not a safe regular file.", {
      referenced_path: relativePath,
    });
  }
  const bytes = fs.readFileSync(filePath);
  return { sha256: sha256(bytes), size_bytes: bytes.byteLength };
}

function validateMaterializedFileReference(candidate, state, documentPath, referencedPath) {
  if (isHistoricalEvidenceSnapshot(candidate)) return;
  const hashKeys = fileReferenceHashKeys(candidate, state, new Set([state.sha256]));
  if (hashKeys.length === 0) {
    throw new IdentityMigrationError(`File reference hash semantics are ambiguous at ${documentPath}.`, {
      referenced_path: referencedPath,
    });
  }
  for (const key of hashKeys) {
    if (!SHA256_PATTERN.test(candidate[key] || "") || candidate[key] !== state.sha256) {
      throw new IdentityMigrationError(`Materialized file reference lineage failed at ${documentPath}.`, {
        referenced_path: referencedPath,
        hash_field: key,
      });
    }
  }
  if (Object.hasOwn(candidate, "size_bytes") && candidate.size_bytes !== state.size_bytes) {
    throw new IdentityMigrationError(`Materialized file reference size failed at ${documentPath}.`, {
      referenced_path: referencedPath,
    });
  }
}

function fileReferenceHashKeys(candidate, state, knownHashes = null) {
  const keys = [];
  if (
    Object.hasOwn(candidate, "sha256")
    && (
      !isHistoricalEvidenceSnapshot(candidate)
      || candidate.sha256 === state.sha256
      || knownHashes?.has(candidate.sha256)
    )
  ) keys.push("sha256");
  if (
    Object.hasOwn(candidate, "hash")
    && (
      candidate.hash === state.sha256
      || knownHashes?.has(candidate.hash)
      || Number.isInteger(candidate.size_bytes)
      || (!Object.hasOwn(candidate, "id") && !Object.hasOwn(candidate, "kind"))
    )
  ) keys.push("hash");
  return keys;
}

function isHistoricalEvidenceSnapshot(candidate) {
  return candidate?.trust === "untrusted_project_evidence" && typeof candidate?.excerpt === "string";
}

function isHistoricalLineageDocument(document) {
  return document.jsonl || document.relativePath.startsWith(".sdlc/traces/");
}

function assertRecordsMigratable(documents, sourceEmail) {
  for (const document of documents.values()) {
    for (const record of document.records) {
      if (countTextOccurrences(JSON.stringify(record), sourceEmail) === 0) continue;
      visitImmutableIntegrityObjects(record, (immutable, kind) => {
        if (countTextOccurrences(JSON.stringify(immutable), sourceEmail) === 0) return;
        if (kind === "signed") {
          throw new IdentityMigrationError(
            `Source identity occurs in signed lineage at ${document.relativePath}; reissue that attestation instead.`,
            { path: document.relativePath, schema_version: immutable.schema_version || null },
          );
        }
        throw new IdentityMigrationError(
          `Source identity occurs in unsupported immutable lineage at ${document.relativePath}.`,
          { path: document.relativePath, schema_version: immutable.schema_version || null },
        );
      });
    }
  }
}

function isSignedIntegrityRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  if (UNSUPPORTED_SIGNED_SCHEMAS.has(record.schema_version)) return true;
  if (/(?:^|[-_:])signed(?:[-_:]|$)/iu.test(String(record.schema_version || ""))) return true;
  for (const [key, value] of Object.entries(record)) {
    if (value === null || value === undefined) continue;
    const normalizedKey = normalizeIntegrityKey(key);
    if (/(?:^|_)(?:sig|signature|signatures|attestation|attestations|proof|proofs|jws|jwt)(?:_|$)/u.test(normalizedKey)) {
      return true;
    }
  }
  return false;
}

function isOpaqueIntegrityRecord(record, { root = true, role = null } = {}) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  if (!root && isRootOnlySupportedIntegrityObject(record)) return true;
  if (isSupportedIdentityIntegrityObject(record)) return false;
  if (isSupportedFileReference(record)) return false;
  if (hasUnsupportedExplicitFileReferenceAlgorithm(record)) return true;
  const normalizedEntries = Object.entries(record).map(([key, value]) => [normalizeIntegrityKey(key), value]);
  if (normalizedEntries.some(([key, value]) => ["receipt_hash", "attestation_hash"].includes(key) && typeof value === "string")) {
    return true;
  }
  const hashAlgorithm = normalizedEntries.find(([key]) => key === "hash_algorithm")?.[1];
  const ownHashKeys = normalizedEntries
    .filter(([key, value]) => (key === "hash" || key.endsWith("_hash")) && typeof value === "string")
    .map(([key]) => key);
  if (ownHashKeys.length === 0) return false;
  if (hashAlgorithm === "sha256:file:v1") return false;
  if (typeof hashAlgorithm !== "string") {
    return ownHashKeys.some((key) => isImplicitSelfHashKey(key, role, record));
  }
  return role !== "approval" || ownHashKeys.some((key) => key !== "approved_content_hash");
}

function hasUnsupportedExplicitFileReferenceAlgorithm(record) {
  if (
    !record
    || typeof record !== "object"
    || Array.isArray(record)
    || typeof record.path !== "string"
    || !Object.hasOwn(record, "sha256")
  ) return false;
  const hashAlgorithm = Object.entries(record)
    .find(([key]) => normalizeIntegrityKey(key) === "hash_algorithm")?.[1];
  return typeof hashAlgorithm === "string" && hashAlgorithm !== "sha256:file:v1";
}

function isImplicitSelfHashKey(key, role, record) {
  if (role === "approval" && key === "approved_content_hash") return false;
  if ([
    "approved_content_hash",
    "approved_delivery_hash",
    "authorization_hash",
    "contract_approval_hash",
    "current_content_hash",
    "previous_hash",
    "revocation_hash",
    "subject_hash",
    "use_hash",
  ].includes(key)) return false;
  if (key === "hash" && (Object.hasOwn(record, "id") || Object.hasOwn(record, "kind"))) return false;
  return key === "hash" || /(?:^|_)(?:attestation|content|envelope|integrity|manifest|receipt|record|self|snapshot)_hash$/u.test(key);
}

function normalizeIntegrityKey(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/-/gu, "_")
    .toLowerCase();
}

function isRootOnlySupportedIntegrityObject(candidate) {
  return candidate?.schema_version === LEGACY_AUTHORIZATION_SCHEMA
    || LEGACY_AUTHORIZATION_RECEIPTS.has(candidate?.schema_version)
    || CANONICAL_AUTHORIZATION_RECEIPTS.has(candidate?.schema_version);
}

function isSupportedIdentityIntegrityObject(candidate) {
  return candidate?.schema_version === LEGACY_AUTHORIZATION_SCHEMA
    || LEGACY_AUTHORIZATION_RECEIPTS.has(candidate?.schema_version)
    || CANONICAL_AUTHORIZATION_SCHEMAS.has(candidate?.schema_version)
    || CANONICAL_AUTHORIZATION_RECEIPTS.has(candidate?.schema_version)
    || candidate?.schema_version === CANONICAL_AUTHORIZATION_REVOCATION;
}

function isImmutableIntegrityRecord(record) {
  return isSignedIntegrityRecord(record) || isOpaqueIntegrityRecord(record, { root: true });
}

function findMappedHashes(record, mappings) {
  const matches = new Set();
  walkReadOnly(record, (value) => {
    if (typeof value === "string" && mappings.has(value)) matches.add(value);
  });
  return Array.from(matches).sort();
}

function walkReadOnly(value, visitor) {
  visitor(value);
  if (Array.isArray(value)) {
    for (const item of value) walkReadOnly(item, visitor);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      visitor(key);
      walkReadOnly(item, visitor);
    }
  }
}

function hashLegacyAuthorization(record) {
  if (record?.hash_algorithm === "sha256:stable-json:v1") {
    return hashApprovalSubject(omitKeys(record, ["approved_content_hash", "hash_algorithm", "revoked_at", "revocation_reason"]));
  }
  return hashApprovalSubject(omitKeys(record, [
    "approved_content_hash",
    "hash_algorithm",
    "status",
    "updated_at",
    "revoked_at",
    "revocation_reason",
    "consumed_at",
    "closed_at",
    "closed_reason",
    "use_count",
  ]));
}

function hashApprovalSubject(value) {
  return computeStableHash(stripApprovalVolatileFields(value));
}

function stripApprovalVolatileFields(value, depth = 0) {
  if (Array.isArray(value)) return value.map((item) => stripApprovalVolatileFields(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  const volatile = depth === 0
    ? new Set(["__path", "__relative_path", "approvals", "audit", "created_at", "updated_at", "approved_at", "approved_by", "status"])
    : new Set();
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => !volatile.has(key))
      .map((key) => [key, stripApprovalVolatileFields(value[key], depth + 1)]),
  );
}

function loadDocuments(root, sdlcRoot) {
  const documents = new Map();
  for (const filePath of collectFiles(sdlcRoot)) {
    const relativeToSdlc = normalizeProjectPath(path.relative(sdlcRoot, filePath));
    const firstSegment = relativeToSdlc.split("/")[0];
    if (DERIVED_ROOTS.has(firstSegment)) continue;
    if (!filePath.endsWith(".json") && !filePath.endsWith(".jsonl")) continue;
    const relativePath = normalizeProjectPath(path.relative(root, filePath));
    const raw = fs.readFileSync(filePath, "utf8");
    let records;
    try {
      records = filePath.endsWith(".jsonl")
        ? raw.split(/\r?\n/u).filter((line) => line.trim() !== "").map((line) => JSON.parse(line))
        : [JSON.parse(raw)];
    } catch (error) {
      throw new IdentityMigrationError(`Cannot parse canonical SDLC file ${relativePath}: ${error.message}`);
    }
    documents.set(relativePath, {
      absolutePath: filePath,
      relativePath,
      projectRoot: root,
      raw,
      jsonl: filePath.endsWith(".jsonl"),
      records,
      originalSemanticHash: computeStableHash(records),
      unsafeNumericLiterals: findUnsafeIntegerLiterals(raw),
    });
  }
  return documents;
}

function renderDocument(document) {
  if (document.jsonl) {
    return document.records.length === 0 ? "" : `${document.records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  }
  return `${JSON.stringify(document.records[0], null, 2)}\n`;
}

function plannedDocumentBytes(document) {
  return computeStableHash(document.records) === document.originalSemanticHash
    ? document.raw
    : renderDocument(document);
}

function assertDocumentCanBeReserialized(document) {
  if (document.unsafeNumericLiterals.length > 0) {
    throw new IdentityMigrationError(
      `Canonical SDLC file ${document.relativePath} contains numeric literals that cannot be represented losslessly by the JSON runtime.`,
      { path: document.relativePath, literals: document.unsafeNumericLiterals },
    );
  }
  for (const record of document.records) {
    visitImmutableIntegrityObjects(record, (immutable, kind) => {
      if (integrityEnvelopeUsesCanonicalSerialization(immutable, kind)) return;
      throw new IdentityMigrationError(
        `Canonical SDLC file ${document.relativePath} cannot be reserialized without changing byte-sensitive ${kind} lineage.`,
        { path: document.relativePath, schema_version: immutable.schema_version || null, integrity_kind: kind },
      );
    });
  }
}

function integrityEnvelopeUsesCanonicalSerialization(record, kind) {
  if (kind === "signed") return false;
  let canonical = false;
  const allowedKeys = new Set(["canonicalization", "hash_algorithm", "serialization"]);
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      const normalizedKey = normalizeIntegrityKey(key);
      if (
        typeof item === "string"
        && allowedKeys.has(normalizedKey)
        && /(?:stable-json|canonical-json|rfc\s*8785|\bjcs\b)/iu.test(item)
      ) canonical = true;
      visit(item);
    }
  };
  visit(record);
  return canonical;
}

function findUnsafeIntegerLiterals(raw) {
  const unsafe = new Set();
  let inString = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (!/[\d-]/u.test(character) || (character === "-" && !/\d/u.test(raw[index + 1] || ""))) continue;
    const match = raw.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u);
    if (!match) continue;
    const token = match[0];
    index += token.length - 1;
    const parsed = Number(token);
    const rendered = Number.isFinite(parsed) ? JSON.stringify(parsed) : null;
    if (
      (Object.is(parsed, -0) && token.startsWith("-"))
      || !rendered
      || normalizeJsonNumberLexeme(token) !== normalizeJsonNumberLexeme(rendered)
    ) {
      if (unsafe.size < 8) unsafe.add(token.slice(0, 128));
    }
  }
  return Array.from(unsafe);
}

function normalizeJsonNumberLexeme(token) {
  const match = String(token).match(/^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u);
  if (!match) return null;
  const sign = match[1];
  const integerDigits = match[2];
  const fractionalDigits = match[3] || "";
  const exponent = Number.parseInt(match[4] || "0", 10);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 10_000) return `noncanonical:${token}`;
  const digits = `${integerDigits}${fractionalDigits}`;
  const decimalPosition = integerDigits.length + exponent;
  let expanded;
  if (decimalPosition <= 0) expanded = `0.${"0".repeat(-decimalPosition)}${digits}`;
  else if (decimalPosition >= digits.length) expanded = `${digits}${"0".repeat(decimalPosition - digits.length)}`;
  else expanded = `${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
  const [rawWhole, rawFraction = ""] = expanded.split(".");
  const whole = rawWhole.replace(/^0+(?=\d)/u, "") || "0";
  const fraction = rawFraction.replace(/0+$/u, "");
  if (whole === "0" && fraction === "") return "0";
  return `${sign}${whole}${fraction ? `.${fraction}` : ""}`;
}

function replaceInDocument(document, source, target, targetName) {
  let replacements = 0;
  for (const record of document.records) {
    if (targetName) {
      visitMutableIntegrityObjects(record, (candidate) => {
        if (
          typeof candidate.email === "string" &&
          candidate.email.toLowerCase() === source.toLowerCase() &&
          typeof candidate.name === "string" &&
          candidate.name !== targetName
        ) {
          candidate.name = targetName;
          replacements += 1;
        }
      });
    }
    walkMutableIntegrity(record, (value) => {
      if (typeof value !== "string") return value;
      const result = replaceCaseInsensitive(value, source, target);
      replacements += result.count;
      return result.value;
    });
  }
  return { replacements };
}

function integrityBoundaryKind(value, root, role = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (isSignedIntegrityRecord(value)) return "signed";
  if (isOpaqueIntegrityRecord(value, { root, role })) return "opaque";
  return null;
}

function visitImmutableIntegrityObjects(value, visitor, root = true, role = null) {
  if (!value || typeof value !== "object") return;
  if (!Array.isArray(value)) {
    const kind = integrityBoundaryKind(value, root, role);
    if (kind) {
      visitor(value, kind);
      return;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) visitImmutableIntegrityObjects(item, visitor, false, role === "approvals" ? "approval" : null);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    visitImmutableIntegrityObjects(item, visitor, false, key === "approvals" ? "approvals" : null);
  }
}

function visitMutableIntegrityObjects(value, visitor, root = true, role = null) {
  if (!value || typeof value !== "object") return;
  if (!Array.isArray(value)) {
    if (integrityBoundaryKind(value, root, role)) return;
    visitor(value);
  }
  if (Array.isArray(value)) {
    for (const item of value) visitMutableIntegrityObjects(item, visitor, false, role === "approvals" ? "approval" : null);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    visitMutableIntegrityObjects(item, visitor, false, key === "approvals" ? "approvals" : null);
  }
}

function visitIntegrityObjects(value, visitor, root = true, role = null) {
  if (!value || typeof value !== "object") return;
  if (!Array.isArray(value)) {
    if (integrityBoundaryKind(value, root, role)) {
      visitObjects(value, (candidate) => visitor(candidate, true));
      return;
    }
    visitor(value, false);
  }
  if (Array.isArray(value)) {
    for (const item of value) visitIntegrityObjects(item, visitor, false, role === "approvals" ? "approval" : null);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    visitIntegrityObjects(item, visitor, false, key === "approvals" ? "approvals" : null);
  }
}

function walkMutableIntegrity(value, transform, onImmutable = () => {}, root = true, role = null) {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      value[index] = walkMutableIntegrity(
        value[index],
        transform,
        onImmutable,
        false,
        role === "approvals" ? "approval" : null,
      );
    }
    return value;
  }
  if (value && typeof value === "object") {
    if (integrityBoundaryKind(value, root, role)) {
      onImmutable(value);
      return value;
    }
    for (const key of Object.keys(value)) {
      value[key] = walkMutableIntegrity(
        value[key],
        transform,
        onImmutable,
        false,
        key === "approvals" ? "approvals" : null,
      );
    }
    return value;
  }
  return transform(value);
}

function replaceMappedHashesIntegrity(value, mappings, onImmutable, root = true, role = null) {
  if (Array.isArray(value)) {
    let changed = false;
    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];
      const replacement = typeof item === "string" ? mappings.get(item) : null;
      if (replacement && replacement !== item) {
        value[index] = replacement;
        changed = true;
        continue;
      }
      changed = replaceMappedHashesIntegrity(
        item,
        mappings,
        onImmutable,
        false,
        role === "approvals" ? "approval" : null,
      ) || changed;
    }
    return changed;
  }
  if (!value || typeof value !== "object") return false;
  if (integrityBoundaryKind(value, root, role)) {
    onImmutable(value);
    return false;
  }

  let changed = false;
  for (const [key, item] of Object.entries(value)) {
    const replacementKey = mappings.get(key) || key;
    if (replacementKey !== key && Object.hasOwn(value, replacementKey)) {
      throw new IdentityMigrationError("Hash-key lineage rewrite would collide with an existing JSON object key.", {
        historical_hash: key,
        replacement_hash: replacementKey,
      });
    }
    changed = replaceMappedHashesIntegrity(
      item,
      mappings,
      onImmutable,
      false,
      key === "approvals" ? "approvals" : null,
    ) || changed;
    const replacementValue = typeof item === "string" ? mappings.get(item) : null;
    if (replacementValue && replacementValue !== item) {
      value[key] = replacementValue;
      changed = true;
    }
    if (replacementKey !== key) {
      const currentValue = value[key];
      delete value[key];
      value[replacementKey] = currentValue;
      changed = true;
    }
  }
  return changed;
}

function visitObjects(value, visitor) {
  if (!value || typeof value !== "object") return;
  if (!Array.isArray(value)) visitor(value);
  for (const item of Array.isArray(value) ? value : Object.values(value)) visitObjects(item, visitor);
}

function countOccurrencesInDocuments(documents, needle) {
  let count = 0;
  for (const document of documents.values()) {
    for (const record of document.records) count += countTextOccurrences(JSON.stringify(record), needle);
  }
  return count;
}

function countRawOccurrences(root, needle) {
  let count = 0;
  for (const filePath of collectFiles(root)) {
    if (!fs.lstatSync(filePath).isFile()) continue;
    count += countIdentityOccurrencesInFile(filePath, needle);
  }
  return count;
}

function findUnsupportedOccurrences(sdlcRoot, needle) {
  const files = [];
  for (const filePath of collectFiles(sdlcRoot)) {
    const relative = normalizeProjectPath(path.relative(sdlcRoot, filePath));
    if (DERIVED_ROOTS.has(relative.split("/")[0])) continue;
    if (filePath.endsWith(".json") || filePath.endsWith(".jsonl")) continue;
    const count = countIdentityOccurrencesInFile(filePath, needle);
    if (count > 0) files.push({ path: `.sdlc/${relative}`, occurrences: count });
  }
  return files;
}

function findNonRebuildableExcludedOccurrences(sdlcRoot, needle) {
  const files = [];
  for (const filePath of collectFiles(sdlcRoot)) {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile()) continue;
    const relative = normalizeProjectPath(path.relative(sdlcRoot, filePath));
    const firstSegment = relative.split("/")[0];
    if (!DERIVED_ROOTS.has(firstSegment) || REBUILDABLE_DERIVED_ROOTS.has(firstSegment)) continue;
    const count = countIdentityOccurrencesInFile(filePath, needle);
    if (count > 0) files.push({ path: `.sdlc/${relative}`, occurrences: count });
  }
  return files;
}

function findIdentityBearingPaths(sdlcRoot, needle) {
  return collectFiles(sdlcRoot, true)
    .map((filePath) => `.sdlc/${normalizeProjectPath(path.relative(sdlcRoot, filePath))}`)
    .filter((relativePath) => containsCaseInsensitive(relativePath, needle));
}

function containsCaseInsensitive(value, needle) {
  if (!needle) return false;
  return String(value).toLowerCase().includes(String(needle).toLowerCase());
}

function countIdentityOccurrencesInFile(filePath, needle) {
  const raw = fs.readFileSync(filePath, "utf8");
  const literalCount = countTextOccurrences(raw, needle);
  if (!filePath.endsWith(".json") && !filePath.endsWith(".jsonl")) return literalCount;
  try {
    const records = filePath.endsWith(".jsonl")
      ? raw.split(/\r?\n/u).filter((line) => line.trim() !== "").map((line) => JSON.parse(line))
      : [JSON.parse(raw)];
    const semanticCount = records.reduce(
      (total, record) => total + countTextOccurrences(JSON.stringify(record), needle),
      0,
    );
    return Math.max(literalCount, semanticCount);
  } catch {
    return literalCount;
  }
}

function countTextOccurrences(value, needle) {
  if (!needle) return 0;
  return value.match(identityTokenExpression(needle, "giu"))?.length || 0;
}

function replaceCaseInsensitive(value, source, target) {
  const expression = identityTokenExpression(source, "giu");
  let count = 0;
  return {
    value: value.replace(expression, () => {
      count += 1;
      return target;
    }),
    get count() { return count; },
  };
}

function identityTokenExpression(value, flags) {
  const emailTokenCharacter = "A-Z0-9!#$%&'*+/=?^_`{|}~@-";
  return new RegExp(
    `(?<![${emailTokenCharacter}])(?<![A-Z0-9]\\.)${escapeRegExp(value)}(?![${emailTokenCharacter}])(?!\\.[A-Z0-9])`,
    flags,
  );
}

function readExistingMigrationReceipt(receiptPath, expected) {
  let receipt;
  try {
    receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  } catch (error) {
    throw new IdentityMigrationError(`Existing identity migration receipt cannot be read: ${error.message}`);
  }
  const validation = validateIdentityMigrationReceipt(receipt);
  if (!validation.valid) {
    throw new IdentityMigrationError(`Existing identity migration receipt is invalid: ${validation.errors.join("; ")}`);
  }
  if (
    receipt.id !== expected.migrationId ||
    receipt.source_identity_digest !== expected.sourceDigest ||
    receipt.target_identity_digest !== expected.targetDigest ||
    receipt.target_identity?.email_digest !== expected.targetDigest ||
    (expected.targetName && receipt.target_identity?.name !== expected.targetName)
  ) {
    throw new IdentityMigrationError("Existing identity migration receipt does not match the requested source and target digests.");
  }
  return receipt;
}

function addHashMapping(mappings, before, after, source) {
  if (!SHA256_PATTERN.test(before) || !SHA256_PATTERN.test(after) || before === after) return;
  const existing = mappings.get(before);
  if (existing && existing !== after) {
    throw new IdentityMigrationError("One historical hash maps to multiple post-migration hashes.", {
      source,
      historical_hash: before,
    });
  }
  mappings.set(before, after);
}

function addRewrite(rewrites, kind, id, before, after) {
  if (before === after) return;
  const key = `${kind}:${id || "unknown"}:${before}`;
  const existing = rewrites.get(key);
  if (existing && existing.after_hash !== after) {
    throw new IdentityMigrationError("Hash rewrite lineage is ambiguous.", { kind, id });
  }
  rewrites.set(key, { kind, id: id || null, before_hash: before, after_hash: after });
}

function compareRewrite(left, right) {
  return `${left.kind}:${left.id || ""}:${left.before_hash}`.localeCompare(`${right.kind}:${right.id || ""}:${right.before_hash}`);
}

function snapshotDocumentBytes(documents) {
  return new Map(Array.from(documents.values()).map((document) => [document.relativePath, document.raw]));
}

function publicPlan(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    throw new IdentityMigrationError("Identity migration plan must be an object.");
  }
  return {
    id: plan.id,
    status: plan.status,
    plan_hash: plan.plan_hash,
    source_identity_digest: plan.source_identity_digest,
    target_identity_digest: plan.target_identity_digest,
    source_occurrences_before: plan.source_occurrences_before,
    source_occurrences_after: plan.source_occurrences_after,
    changed_files: plan.changed_files,
    hash_rewrites: plan.hash_rewrites,
    receipt_path: plan.receipt_path,
    execution_descriptor: plan.execution_descriptor ?? null,
  };
}

function createIdentityExecutionDescriptor({
  id,
  planHash,
  root,
  sdlcRoot,
  writes,
  changedFiles,
  receiptPath,
}) {
  const nonce = computeStableHash({
    schema_version: IDENTITY_EXECUTION_SCHEMA,
    migration_id: id,
    changed_files: changedFiles.map((entry) => ({
      path: entry.path,
      before_sha256: entry.before_sha256,
      after_sha256: entry.after_sha256,
      before_mode: entry.before_mode,
      after_mode: entry.after_mode,
    })),
    receipt_path: receiptPath,
  }).slice(0, 24);
  const transactionRoot = path.join(root, `.sdlc-identity-migration-txn-${nonce}`);
  const shadowRoot = path.join(transactionRoot, "shadow", ".sdlc");
  const backupRoot = path.join(transactionRoot, "original");
  const lockPath = path.join(root, ".sdlc-identity-migration.lock");
  const lockTempPath = path.join(root, `.sdlc-identity-migration-lock.${nonce}.tmp`);
  const journalPath = path.join(root, `.sdlc-identity-migration-journal-${nonce}.json`);
  const journalTempPath = path.join(root, `.sdlc-identity-migration-journal-${nonce}.${nonce}.tmp`);
  const exactByKey = new Map();
  const preparedByTarget = new Map();
  const asProjectPath = (absolutePath) => {
    const relative = path.relative(root, absolutePath);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new IdentityMigrationError("Identity execution descriptor path escapes the project root.");
    }
    return relative.split(path.sep).join("/");
  };
  const add = (operation, absolutePath) => {
    const projectPath = asProjectPath(absolutePath);
    exactByKey.set(`${operation}\0${projectPath}`, { operation, path: projectPath });
  };
  const addPreparedWrite = (targetPath, { existing, genericForce = false }) => {
    if (existing && !genericForce) {
      for (const operation of ["file.write", "file.truncate", "path.chmod"]) add(operation, targetPath);
      return;
    }
    const tempPath = path.join(
      path.dirname(targetPath),
      `.${path.basename(targetPath)}.identity-${nonce}.tmp`,
    );
    preparedByTarget.set(path.resolve(targetPath), tempPath);
    add("file.write", tempPath);
    add("file.remove", tempPath);
    add("path.rename.source", tempPath);
    add("path.rename.target", targetPath);
    if (!genericForce) add("path.chmod", tempPath);
    if (genericForce) add("file.write", targetPath);
  };
  const addMissingShadowParents = (liveTargetPath, shadowTargetPath) => {
    const missing = [];
    let current = path.dirname(liveTargetPath);
    while (current !== sdlcRoot && isInside(sdlcRoot, current) && !fs.existsSync(current)) {
      missing.push(current);
      current = path.dirname(current);
    }
    for (const liveDirectory of missing.reverse()) {
      add("directory.create", path.join(shadowRoot, path.relative(sdlcRoot, liveDirectory)));
    }
    if (!fs.existsSync(path.dirname(liveTargetPath)) && missing.length === 0) {
      add("directory.create", path.dirname(shadowTargetPath));
    }
  };

  add("file.write", lockTempPath);
  add("file.remove", lockTempPath);
  add("path.link.source", lockTempPath);
  add("path.link.target", lockPath);
  add("file.append", lockPath);
  add("lock.release", lockPath);
  add("file.write", journalTempPath);
  add("file.remove", journalTempPath);
  add("path.rename.source", journalTempPath);
  add("path.rename.target", journalPath);
  add("file.remove", journalPath);
  add("directory.create", transactionRoot);
  add("directory.create", path.join(transactionRoot, "shadow"));
  add("directory.copy", shadowRoot);
  add("directory.remove", transactionRoot);
  add("path.rename.source", sdlcRoot);
  add("path.rename.target", backupRoot);
  add("path.rename.source", shadowRoot);
  add("path.rename.target", sdlcRoot);
  add("directory.remove", sdlcRoot);
  add("path.rename.source", backupRoot);

  for (const liveTargetPath of writes.keys()) {
    const shadowTargetPath = path.join(shadowRoot, path.relative(sdlcRoot, liveTargetPath));
    addMissingShadowParents(liveTargetPath, shadowTargetPath);
    addPreparedWrite(shadowTargetPath, { existing: fs.existsSync(liveTargetPath) });
  }
  for (const relativePath of IDENTITY_DERIVED_PATHS) {
    const liveTargetPath = path.join(root, ...relativePath.split("/"));
    const shadowTargetPath = path.join(shadowRoot, path.relative(sdlcRoot, liveTargetPath));
    addMissingShadowParents(liveTargetPath, shadowTargetPath);
    addPreparedWrite(shadowTargetPath, { existing: fs.existsSync(liveTargetPath), genericForce: true });
  }

  const exactMutations = [...exactByKey.values()].sort((left, right) => {
    const leftKey = `${left.operation}\0${left.path}`;
    const rightKey = `${right.operation}\0${right.path}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  const preparedWrites = [...preparedByTarget.entries()].map(([targetPath, temporaryPath]) => ({
    target_path: asProjectPath(targetPath),
    temporary_path: asProjectPath(temporaryPath),
  })).sort((left, right) => left.target_path < right.target_path ? -1 : left.target_path > right.target_path ? 1 : 0);
  const base = {
    schema_version: IDENTITY_EXECUTION_SCHEMA,
    migration_id: id,
    plan_hash: planHash,
    nonce,
    transaction_root: asProjectPath(transactionRoot),
    lock_path: asProjectPath(lockPath),
    lock_temporary_path: asProjectPath(lockTempPath),
    journal_path: asProjectPath(journalPath),
    journal_temporary_path: asProjectPath(journalTempPath),
    prepared_writes: preparedWrites,
    exact_mutations: exactMutations,
  };
  return deepFreezeJson({ ...base, descriptor_hash: computeStableHash(base) });
}

function validateIdentityExecutionDescriptor(plan) {
  const descriptor = plan?.execution_descriptor;
  if (
    !descriptor
    || descriptor.schema_version !== IDENTITY_EXECUTION_SCHEMA
    || descriptor.migration_id !== plan.id
    || descriptor.plan_hash !== plan.plan_hash
    || descriptor.descriptor_hash !== computeStableHash(omitKeys(descriptor, ["descriptor_hash"]))
  ) {
    throw new IdentityMigrationError("Identity migration execution descriptor is missing or changed after review.");
  }
  return descriptor;
}

function resolveIdentityExecutionDescriptor(plan, internal) {
  const descriptor = validateIdentityExecutionDescriptor(plan);
  const expected = createIdentityExecutionDescriptor({
    id: plan.id,
    planHash: plan.plan_hash,
    root: internal.root,
    sdlcRoot: internal.sdlcRoot,
    writes: internal.writes,
    changedFiles: plan.changed_files,
    receiptPath: plan.receipt_path,
  });
  if (computeStableHash(descriptor) !== computeStableHash(expected)) {
    throw new IdentityMigrationError("Identity migration execution paths no longer match the reviewed plan.");
  }
  const absolute = (projectPath) => path.join(internal.root, ...projectPath.split("/"));
  return Object.freeze({
    nonce: descriptor.nonce,
    transactionRoot: absolute(descriptor.transaction_root),
    lockTempPath: absolute(descriptor.lock_temporary_path),
    journalPath: absolute(descriptor.journal_path),
    journalTempPath: absolute(descriptor.journal_temporary_path),
    preparedTempPaths: new Map(descriptor.prepared_writes.map((entry) => [
      absolute(entry.target_path),
      absolute(entry.temporary_path),
    ])),
  });
}

function computeIdentityMigrationExecutableHash(plan, internal) {
  const writes = Array.from(internal.writes || [], ([filePath, content]) => ({
    path: path.resolve(String(filePath)),
    size_bytes: Buffer.byteLength(content),
    sha256: sha256(content),
  })).sort((left, right) => left.path.localeCompare(right.path));
  const inputSnapshot = Array.from(internal.inputHashes || [], ([relativePath, state]) => ({
    path: String(relativePath),
    sha256: state?.sha256,
    mode: state?.mode,
  })).sort((left, right) => left.path.localeCompare(right.path));
  return computeStableHash({
    schema_version: "identity-migration-executable:v1",
    public_plan: publicPlan(plan),
    root: internal.root,
    sdlc_root: internal.sdlcRoot,
    source_identity_digest: sha256(String(internal.sourceEmail || "").toLowerCase()),
    receipt: internal.receipt,
    input_snapshot: inputSnapshot,
    writes,
    plan_hash: internal.planHash,
  });
}

function deepFreezeJson(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Array.isArray(value) ? value : Object.values(value)) deepFreezeJson(item);
  return Object.freeze(value);
}

function snapshotDocumentHashes(documents) {
  return new Map(Array.from(documents.values()).map((document) => [document.relativePath, {
    sha256: sha256(document.raw),
    mode: fs.lstatSync(document.absolutePath).mode & 0o7777,
  }]));
}

function computeIdentityMigrationPlanHash({
  id,
  status,
  sourceDigest,
  targetDigest,
  targetName,
  sourceOccurrencesBefore,
  changedFiles,
  hashRewrites,
  receiptPath,
  inputHashes,
  reason,
}) {
  return computeStableHash({
    schema_version: "identity-migration-plan:v1",
    transaction_strategy: TRANSACTION_STRATEGY,
    id,
    status,
    source_identity_digest: sourceDigest,
    target_identity: {
      email_digest: targetDigest,
      name: targetName || null,
    },
    source_occurrences_before: sourceOccurrencesBefore,
    canonical_input_snapshot: Array.from(inputHashes, ([pathValue, state]) => ({
      path: pathValue,
      sha256: state.sha256,
      mode: state.mode,
    })).sort((left, right) => left.path.localeCompare(right.path)),
    changed_files: changedFiles,
    hash_rewrites: hashRewrites,
    receipt_path: receiptPath,
    reason: reason || "Canonical identity correction with integrity-preserving lineage rewrite.",
  });
}

function acquireLock(lockPath, migrationId, planHash, execution) {
  const nonce = execution.nonce;
  const transactionRootName = path.basename(execution.transactionRoot);
  const journalName = path.basename(execution.journalPath);
  const journalPath = path.join(path.dirname(lockPath), journalName);
  const temporaryPath = execution.lockTempPath;
  const baseRecord = {
    schema_version: "identity-migration-lock:v2",
    migration_id: migrationId,
    plan_hash: planHash,
    pid: process.pid,
    host: os.hostname(),
    nonce,
    transaction_root: transactionRootName,
    journal_path: journalName,
    phase: "acquired",
    generation: 0,
    created_at: new Date().toISOString(),
  };
  baseRecord.journal_hash = computeStableHash(baseRecord);
  let journalRecord = baseRecord;
  let lastAnchorHash = baseRecord.journal_hash;
  let checkpointStateAmbiguous = false;
  let descriptor;
  let identity = null;
  let published = false;
  try {
    descriptor = mutateIdentity("file.write", temporaryPath, () =>
      fs.openSync(temporaryPath, "wx", 0o600));
    identity = fileIdentity(fs.fstatSync(descriptor, IDENTITY_STAT_OPTIONS));
    mutateIdentity("file.write", temporaryPath, () =>
      fs.writeFileSync(descriptor, `${JSON.stringify(baseRecord)}\n`));
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    assertOwnedTemporaryFile(temporaryPath, identity);
    linkIdentityPath(temporaryPath, lockPath, identity);
    published = true;
    removeOwnedTemporaryFile(temporaryPath, identity);
    fsyncDirectory(path.dirname(lockPath));
    return {
      nonce,
      transactionRootName,
      update: (patch) => {
        if (checkpointStateAmbiguous) {
          throw new IdentityMigrationError("Identity migration lock checkpoint state is ambiguous; durable recovery is required.");
        }
        const nextRecord = {
          ...journalRecord,
          ...patch,
          generation: journalRecord.generation + 1,
          updated_at: new Date().toISOString(),
        };
        delete nextRecord.journal_hash;
        nextRecord.journal_hash = computeStableHash(nextRecord);
        assertOwnedLock(lockPath, identity, nonce);
        writeDurableJsonAtomic(
          journalPath,
          nextRecord,
          path.dirname(lockPath),
          execution.journalTempPath,
        );
        try {
          lastAnchorHash = appendDurableLockAnchor(
            lockPath,
            identity,
            nextRecord,
            lastAnchorHash,
          );
          journalRecord = nextRecord;
        } catch (error) {
          try {
            const recoveredCheckpoint = readIdentityMigrationLock(lockPath);
            if (
              recoveredCheckpoint.anchored
              && recoveredCheckpoint.record.generation === nextRecord.generation
              && recoveredCheckpoint.record.journal_hash === nextRecord.journal_hash
            ) {
              journalRecord = nextRecord;
              lastAnchorHash = recoveredCheckpoint.anchorHash;
            } else {
              checkpointStateAmbiguous = true;
            }
          } catch {
            checkpointStateAmbiguous = true;
          }
          throw error;
        }
      },
      release: () => {
        removeOwnedLock(lockPath, identity, nonce, journalPath);
        if (lstatIfPresent(lockPath) || lstatIfPresent(journalPath)) {
          throw new IdentityMigrationError("Identity migration completed but its verified lock or journal could not be released.");
        }
      },
    };
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    if (published && identity) removeOwnedLock(lockPath, identity, nonce);
    try {
      removeOwnedTemporaryFile(temporaryPath, identity);
    } catch {}
    const suffix = error?.code === "EEXIST"
      ? " Inspect and remove the existing lock only after confirming no migration is running."
      : "";
    throw new IdentityMigrationError(`Cannot acquire identity migration lock: ${error.message}.${suffix}`);
  }
}

function assertOwnedLock(lockPath, expectedIdentity, nonce) {
  const stat = fs.lstatSync(lockPath, IDENTITY_STAT_OPTIONS);
  if (!stat.isFile() || stat.isSymbolicLink() || !sameFileIdentityValues(stat, expectedIdentity)) {
    throw new IdentityMigrationError("Identity migration lock ownership changed during the transaction.");
  }
  const current = readIdentityMigrationLock(lockPath).record;
  if (current?.nonce !== nonce) {
    throw new IdentityMigrationError("Identity migration lock nonce changed during the transaction.");
  }
}

function appendDurableLockAnchor(lockPath, expectedIdentity, record, previousAnchorHash) {
  const anchor = {
    schema_version: "identity-migration-lock-anchor:v1",
    previous_anchor_hash: previousAnchorHash,
    record,
  };
  anchor.anchor_hash = computeStableHash(anchor);
  const descriptor = mutateIdentity("file.append", lockPath, () =>
    fs.openSync(lockPath, fs.constants.O_WRONLY | fs.constants.O_APPEND));
  let checkpointDurable = false;
  try {
    const stat = fs.fstatSync(descriptor, IDENTITY_STAT_OPTIONS);
    if (!sameFileIdentityValues(stat, expectedIdentity)) {
      throw new IdentityMigrationError("Identity migration lock changed before its durable checkpoint append.");
    }
    mutateIdentity("file.append", lockPath, () =>
      fs.writeFileSync(descriptor, `${JSON.stringify(anchor)}\n`));
    fs.fsyncSync(descriptor);
    checkpointDurable = true;
  } finally {
    try {
      fs.closeSync(descriptor);
    } catch (error) {
      if (!checkpointDurable) throw error;
    }
  }
  return anchor.anchor_hash;
}

function readIdentityMigrationLock(lockPath) {
  let raw;
  try {
    raw = fs.readFileSync(lockPath, "utf8");
  } catch (error) {
    throw new IdentityMigrationError(`Cannot read identity migration lock: ${error.message}`);
  }
  try {
    const singleRecord = JSON.parse(raw);
    validateRecoveryRecord(singleRecord);
    return { record: singleRecord, anchored: false, anchorHash: null };
  } catch (error) {
    if (error instanceof IdentityMigrationError) throw error;
  }
  const lines = raw.split(/\r?\n/u).filter((line) => line !== "");
  if (lines.length === 0) throw new IdentityMigrationError("Identity migration lock is empty.");
  let base;
  try {
    base = JSON.parse(lines[0]);
  } catch (error) {
    throw new IdentityMigrationError(`Cannot parse identity migration lock header: ${error.message}`);
  }
  validateRecoveryRecord(base);
  if (base.schema_version === "identity-migration-lock:v1") {
    if (lines.length !== 1) throw new IdentityMigrationError("Legacy identity migration lock has unexpected trailing checkpoints.");
    return { record: base, anchored: false, anchorHash: null };
  }
  let record = base;
  let previousAnchorHash = base.journal_hash;
  for (const [index, line] of lines.slice(1).entries()) {
    let anchor;
    try {
      anchor = JSON.parse(line);
    } catch (error) {
      throw new IdentityMigrationError(`Cannot parse identity migration lock checkpoint ${index + 1}: ${error.message}`);
    }
    const expectedAnchorHash = computeStableHash(omitKeys(anchor, ["anchor_hash"]));
    if (
      anchor?.schema_version !== "identity-migration-lock-anchor:v1"
      || anchor.previous_anchor_hash !== previousAnchorHash
      || anchor.anchor_hash !== expectedAnchorHash
      || !anchor.record
      || anchor.record.generation !== record.generation + 1
    ) {
      throw new IdentityMigrationError("Identity migration lock checkpoint chain is malformed or replayed.");
    }
    validateRecoveryRecord(anchor.record);
    assertSameRecoveryTransaction(anchor.record, record);
    record = anchor.record;
    previousAnchorHash = anchor.anchor_hash;
  }
  return { record, anchored: true, anchorHash: previousAnchorHash };
}

function removeOwnedLock(lockPath, expectedIdentity, nonce, journalPath = null) {
  try {
    assertOwnedLock(lockPath, expectedIdentity, nonce);
    const journalStat = journalPath ? lstatIfPresent(journalPath) : null;
    if (journalStat) {
      if (!journalStat.isFile() || journalStat.isSymbolicLink()) return;
      const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
      if (journal?.nonce !== nonce) return;
      mutateIdentity("file.remove", journalPath, () => fs.rmSync(journalPath));
    }
    mutateIdentity("lock.release", lockPath, () => fs.rmSync(lockPath));
    fsyncDirectory(path.dirname(lockPath));
  } catch {
    // Never remove an unverified or replaced lock.
  }
}

function assertOwnedTemporaryFile(temporaryPath, expectedIdentity, descriptor = null) {
  if (!expectedIdentity) {
    throw new IdentityMigrationError("Identity migration does not own the prepared temporary file.");
  }
  let opened = null;
  if (descriptor !== null && descriptor !== undefined) {
    try {
      opened = fs.fstatSync(descriptor, IDENTITY_STAT_OPTIONS);
    } catch {
      throw new IdentityMigrationError("Identity migration temporary-file handle changed before use.");
    }
    if (!opened.isFile()
      || !sameFileIdentityValues(opened, expectedIdentity)) {
      throw new IdentityMigrationError("Identity migration temporary-file handle changed before use.");
    }
  }
  const entry = fs.lstatSync(temporaryPath, IDENTITY_STAT_OPTIONS);
  if (entry.isSymbolicLink()
    || !entry.isFile()
    || !sameFileIdentityValues(entry, expectedIdentity)
    || (opened && !sameFileIdentityValues(entry, opened))) {
    throw new IdentityMigrationError("Identity migration temporary-file ownership changed before use.");
  }
}

function removeOwnedTemporaryFile(temporaryPath, expectedIdentity) {
  if (!expectedIdentity) return false;
  const entry = lstatIfPresent(temporaryPath, IDENTITY_STAT_OPTIONS);
  if (!entry) return false;
  if (entry.isSymbolicLink()
    || !entry.isFile()
    || !sameFileIdentityValues(entry, expectedIdentity)) {
    return false;
  }
  mutateIdentity("file.remove", temporaryPath, () => fs.rmSync(temporaryPath));
  return true;
}

function atomicWrite(filePath, content, projectRoot, execution = null) {
  const resolved = path.resolve(filePath);
  if (!isInside(projectRoot, resolved)) throw new IdentityMigrationError("Refusing to write outside the project root.");
  assertNoSymlinkPathSegments(projectRoot, resolved);
  ensureIdentityDirectory(path.dirname(resolved), projectRoot);
  assertNoSymlinkPathSegments(projectRoot, resolved);
  const parentIdentity = captureDirectoryIdentity(path.dirname(resolved), projectRoot);
  const existing = lstatIfPresent(resolved, IDENTITY_STAT_OPTIONS);
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new IdentityMigrationError("Refusing to replace a migration target that is not a safe regular file.");
    }
    const flags = fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0);
    const descriptor = mutateIdentity("file.write", resolved, () => fs.openSync(resolved, flags));
    try {
      const opened = fs.fstatSync(descriptor, IDENTITY_STAT_OPTIONS);
      if (!sameFileIdentityValues(opened, existing)) {
        throw new IdentityMigrationError("Migration target changed while it was being opened in the shadow tree.");
      }
      mutateIdentity("file.truncate", resolved, () => fs.ftruncateSync(descriptor, 0));
      mutateIdentity("file.write", resolved, () => fs.writeFileSync(descriptor, content));
      mutateIdentity("path.chmod", resolved, () => fs.fchmodSync(descriptor, Number(existing.mode) & 0o7777));
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    assertDirectoryIdentity(path.dirname(resolved), parentIdentity, projectRoot);
    const after = fs.lstatSync(resolved, IDENTITY_STAT_OPTIONS);
    if (!sameFileIdentityValues(after, existing) || (Number(after.mode) & 0o7777) !== (Number(existing.mode) & 0o7777)) {
      throw new IdentityMigrationError("Migration target identity or mode changed during the shadow write.");
    }
    return;
  }
  const tempPath = execution?.preparedTempPaths.get(resolved)
    ?? path.join(path.dirname(resolved), `.${path.basename(resolved)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  let descriptor;
  let tempIdentity = null;
  try {
    descriptor = mutateIdentity("file.write", tempPath, () => fs.openSync(tempPath, "wx", 0o600));
    tempIdentity = fileIdentity(fs.fstatSync(descriptor, IDENTITY_STAT_OPTIONS));
    mutateIdentity("file.write", tempPath, () => fs.writeFileSync(descriptor, content));
    mutateIdentity("path.chmod", tempPath, () => fs.fchmodSync(descriptor, 0o600));
    assertDirectoryIdentity(path.dirname(resolved), parentIdentity, projectRoot);
    assertOwnedTemporaryFile(tempPath, tempIdentity, descriptor);
    renameIdentityPath(tempPath, resolved, tempIdentity, descriptor);
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    removeOwnedTemporaryFile(tempPath, tempIdentity);
  }
}

function writeDurableJsonAtomic(filePath, value, projectRoot, preparedTempPath = null) {
  const resolved = path.resolve(filePath);
  if (!isInside(projectRoot, resolved)) {
    throw new IdentityMigrationError("Refusing to write a migration journal outside the project root.");
  }
  const parent = path.dirname(resolved);
  assertNoSymlinkPathSegments(projectRoot, resolved);
  const tempPath = preparedTempPath
    ?? path.join(parent, `.${path.basename(resolved)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  let descriptor;
  let tempIdentity = null;
  try {
    descriptor = mutateIdentity("file.write", tempPath, () => fs.openSync(tempPath, "wx", 0o600));
    tempIdentity = fileIdentity(fs.fstatSync(descriptor, IDENTITY_STAT_OPTIONS));
    mutateIdentity("file.write", tempPath, () =>
      fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`));
    fs.fsyncSync(descriptor);
    assertOwnedTemporaryFile(tempPath, tempIdentity, descriptor);
    renameIdentityPath(tempPath, resolved, tempIdentity, descriptor);
    fsyncDirectory(parent);
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    removeOwnedTemporaryFile(tempPath, tempIdentity);
  }
}

function fsyncTree(root) {
  if (!fs.existsSync(root)) return;
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new IdentityMigrationError("Cannot fsync an SDLC tree whose root is not a safe directory.");
  }
  for (const filePath of collectFiles(root)) {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    // Windows requires a writable handle for FlushFileBuffers; POSIX can
    // durably flush a regular file opened read-only without weakening modes.
    const descriptor = fs.openSync(filePath, process.platform === "win32" ? "r+" : "r");
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  }
  const directories = collectFiles(root, true)
    .filter((filePath) => fs.lstatSync(filePath).isDirectory())
    .sort((left, right) => right.length - left.length);
  for (const directory of directories) fsyncDirectory(directory);
  fsyncDirectory(root);
}

function computeTreeManifestHash(root, { excludeFirstSegments = new Set() } = {}) {
  if (!fs.existsSync(root)) {
    throw new IdentityMigrationError("Cannot hash a missing SDLC tree.");
  }
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new IdentityMigrationError("Cannot hash an SDLC tree whose root is not a safe directory.");
  }
  const entries = collectFiles(root, true).filter((filePath) => {
    const relativePath = normalizeProjectPath(path.relative(root, filePath));
    return !excludeFirstSegments.has(relativePath.split("/")[0]);
  }).map((filePath) => {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      throw new IdentityMigrationError("Cannot hash an SDLC tree containing symbolic links.");
    }
    const relativePath = normalizeProjectPath(path.relative(root, filePath));
    if (stat.isDirectory()) return { path: relativePath, type: "directory", mode: stat.mode & 0o7777 };
    if (stat.isFile()) {
      return {
        path: relativePath,
        type: "file",
        mode: stat.mode & 0o7777,
        size_bytes: stat.size,
        sha256: sha256(fs.readFileSync(filePath)),
      };
    }
    throw new IdentityMigrationError(`Cannot hash unsupported filesystem entry ${relativePath}.`);
  });
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return computeStableHash({
    schema_version: "identity-migration-tree-manifest:v1",
    root_mode: rootStat.mode & 0o7777,
    entries,
  });
}

function fsyncDirectory(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, "r");
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EPERM", "EISDIR"].includes(error?.code)) throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function captureDirectoryIdentity(directoryPath, projectRoot) {
  const lstat = fs.lstatSync(directoryPath);
  const stat = fs.statSync(directoryPath, IDENTITY_STAT_OPTIONS);
  const realpath = fs.realpathSync.native(directoryPath);
  if (lstat.isSymbolicLink() || !lstat.isDirectory() || !stat.isDirectory() || !isInside(projectRoot, realpath)) {
    throw new IdentityMigrationError("Write directory resolves outside the project root.");
  }
  return { ...fileIdentity(stat), realpath };
}

function assertDirectoryIdentity(directoryPath, expected, projectRoot) {
  const current = captureDirectoryIdentity(directoryPath, projectRoot);
  if (!sameFileIdentityValues(current, expected) || current.realpath !== expected.realpath) {
    throw new IdentityMigrationError("Write directory changed during the migration transaction.");
  }
}

function assertActivatedDirectoryIdentity(directoryPath, expected, projectRoot) {
  if (!expected) throw new IdentityMigrationError("Activated SDLC root identity was not captured.");
  const lstat = fs.lstatSync(directoryPath);
  const stat = fs.statSync(directoryPath, IDENTITY_STAT_OPTIONS);
  const realpath = fs.realpathSync.native(directoryPath);
  if (
    lstat.isSymbolicLink()
    || !lstat.isDirectory()
    || !sameFileIdentityValues(stat, expected)
    || realpath !== path.resolve(directoryPath)
    || !isInside(projectRoot, realpath)
  ) {
    throw new IdentityMigrationError("Activated SDLC root identity changed during the migration transaction.");
  }
}

function activatedTreeMatchesExpectedState(directoryPath, expected, projectRoot, manifestHash) {
  if (!expected || !SHA256_PATTERN.test(manifestHash || "")) return false;
  try {
    assertActivatedDirectoryIdentity(directoryPath, expected, projectRoot);
    return computeTreeManifestHash(directoryPath) === manifestHash;
  } catch {
    return false;
  }
}

function assertNoSymlinks(root) {
  for (const filePath of collectFiles(root, true)) {
    if (fs.lstatSync(filePath).isSymbolicLink()) {
      throw new IdentityMigrationError(`Refusing SDLC tree containing symlink: ${normalizeProjectPath(path.relative(root, filePath))}`);
    }
  }
}

function assertNoSymlinkPathSegments(root, target) {
  let current = path.resolve(root);
  const relative = path.relative(current, path.resolve(target));
  for (const segment of relative.split(path.sep).filter(Boolean).slice(0, -1)) {
    current = path.join(current, segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new IdentityMigrationError(`Refusing write through symlinked directory: ${current}`);
    }
  }
}

function collectFiles(root, includeDirectories = false) {
  const entries = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name);
      if (includeDirectories) entries.push(filePath);
      if (entry.isDirectory()) visit(filePath);
      else if (!includeDirectories) entries.push(filePath);
    }
  };
  visit(root);
  return entries.sort();
}

function canonicalDirectory(value, label) {
  const resolved = path.resolve(String(value || ""));
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch (error) {
    throw new IdentityMigrationError(`${label} does not exist: ${error.message}`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new IdentityMigrationError(`${label} must be a real directory.`);
  return fs.realpathSync.native(resolved);
}

function lstatIfPresent(filePath, options) {
  try {
    return fs.lstatSync(filePath, options);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeEmail(value, label) {
  const normalized = String(value || "").trim();
  if (!EMAIL_PATTERN.test(normalized)) throw new IdentityMigrationError(`${label} must be a valid email address.`);
  return normalized;
}

function normalizeOptionalText(value, label) {
  if (value === undefined || value === null || value === "") return null;
  const normalized = String(value).trim();
  if (!normalized || /[\u0000-\u001f\u007f]/u.test(normalized)) throw new IdentityMigrationError(`${label} contains invalid control characters.`);
  return normalized;
}

function assertOnlyKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new IdentityMigrationError(`${label} contains unsupported field(s): ${unknown.sort().join(", ")}.`);
  }
}

function normalizeIsoInstant(value) {
  const parsed = Date.parse(String(value || ""));
  if (!Number.isFinite(parsed)) throw new IdentityMigrationError("createdAt must be an ISO-8601 instant.");
  return new Date(parsed).toISOString();
}

function normalizeProjectPath(value) {
  return String(value).replaceAll("\\", "/").replace(/^\.\//u, "");
}

function normalizeReferencePath(value) {
  const raw = String(value);
  if (
    !raw
    || /[\u0000-\u001f\u007f]/u.test(raw)
    || raw.includes("\\")
    || raw.startsWith("/")
    || /^[A-Za-z]:/u.test(raw)
    || raw.startsWith("./")
    || raw.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new IdentityMigrationError("File reference path must be a canonical relative project path without dot segments.", {
      referenced_path: raw,
    });
  }
  return raw;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}
