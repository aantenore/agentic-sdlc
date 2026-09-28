import path from "node:path";

import { crypto, fs } from "../../runtime/host.mjs";
import {
  canonicalJson,
  isPlainRecord,
  requireNonEmptyString,
} from "../../canonical.mjs";
import {
  DELIVERY_PROVIDER_SPI_VERSION,
  DeliveryProviderError,
} from "../provider-registry.mjs";

export const LOCAL_FILESYSTEM_PROVIDER_ID = "local-filesystem";

const SUBJECT_KEYS = new Set(["allowed_write_paths", "root_path"]);
const DATA_SUBJECT_KEYS = new Set([
  "backup_path",
  "preview_evidence",
  "rollback",
  "root_path",
  "scopes",
  "target_path",
]);
const DATA_ACTIONS = new Set(["data.migrate", "data.rollback"]);
const ROLLBACK_VERIFICATION_SUBJECT_KEYS = new Set([
  "allowed_write_paths",
  "evidence",
  "evidence_root",
  "rollback_procedure",
  "root_path",
]);
const ROLLBACK_VERIFICATION_ACTION = "rollback.verify";

export function createLocalFilesystemProvider({ filesystem = fs } = {}) {
  assertFilesystemApi(filesystem);
  return Object.freeze({
    id: LOCAL_FILESYSTEM_PROVIDER_ID,
    adapter_version: "1.0.0",
    spi_version: DELIVERY_PROVIDER_SPI_VERSION,
    capabilities: Object.freeze({
      "data.migrate": Object.freeze(["precondition", "completion"]),
      "data.rollback": Object.freeze(["precondition", "completion"]),
      "release.local": Object.freeze(["precondition", "completion"]),
      "rollback.verify": Object.freeze(["precondition", "completion"]),
    }),
    observePrecondition(operation) {
      const action = assertSupportedAction(operation);
      if (action === ROLLBACK_VERIFICATION_ACTION) {
        return inspectRollbackVerificationBoundary(
          filesystem,
          normalizeRollbackVerificationSubject(operation.subject),
        );
      }
      if (DATA_ACTIONS.has(action)) {
        return inspectDataBoundary(
          filesystem,
          normalizeDataOperationSubject(operation.subject, action),
          action,
          { completion: false },
        );
      }
      const subject = normalizeLocalReleaseSubject(operation.subject);
      return inspectBoundary(filesystem, subject);
    },
    verifyCompletion(operation, { precondition_receipt: preconditionReceipt }) {
      const action = assertSupportedAction(operation);
      if (action === ROLLBACK_VERIFICATION_ACTION) {
        const subject = normalizeRollbackVerificationSubject(operation.subject);
        const before = preconditionReceipt?.proof;
        const after = inspectRollbackVerificationBoundary(filesystem, subject);
        assertStableRootIdentity(before, after, action);
        if (
          before?.evidence_root !== after.evidence_root
          || before?.evidence_root_identity?.real_path !== after.evidence_root_identity.real_path
          || before?.evidence_root_identity?.device !== after.evidence_root_identity.device
          || before?.evidence_root_identity?.inode !== after.evidence_root_identity.inode
          || canonicalJson(before?.allowed_write_paths) !== canonicalJson(after.allowed_write_paths)
          || canonicalJson(before?.evidence) !== canonicalJson(after.evidence)
          || before?.rollback_procedure !== after.rollback_procedure
        ) {
          throw new DeliveryProviderError(
            "rollback.verify completion does not preserve the exact target, procedure, and immutable evidence",
            "provider_completion_unproven",
          );
        }
        return {
          ...after,
          transition: "rollback_evidence_verified",
          verified: true,
          rollback_procedure_sha256: crypto
            .createHash("sha256")
            .update(subject.rollback_procedure, "utf8")
            .digest("hex"),
          precondition_receipt_hash: preconditionReceipt.receipt_hash,
        };
      }
      if (DATA_ACTIONS.has(action)) {
        const subject = normalizeDataOperationSubject(operation.subject, action);
        const before = preconditionReceipt?.proof;
        const after = inspectDataBoundary(filesystem, subject, action, { completion: true });
        assertStableRootIdentity(before, after, action);
        if (action === "data.migrate") {
          if (
            before?.target?.sha256 === after.target.sha256
            || after.backup?.status !== "present"
            || after.backup.sha256 !== before?.target?.sha256
          ) {
            throw new DeliveryProviderError(
              "data.migrate completion does not prove a changed target and an exact pre-migration backup",
              "provider_completion_unproven",
            );
          }
          return {
            ...after,
            transition: "migrated",
            before_target_sha256: before.target.sha256,
            after_target_sha256: after.target.sha256,
            backup_sha256: after.backup.sha256,
            precondition_receipt_hash: preconditionReceipt.receipt_hash,
          };
        }
        if (
          before?.backup?.status !== "present"
          || before?.target?.status !== "present"
          || before.target.sha256 === before.backup.sha256
          || after.backup?.status !== "present"
          || after.backup.sha256 !== before.backup.sha256
          || after.target.sha256 !== after.backup.sha256
          || after.target.sha256 === before.target.sha256
        ) {
          throw new DeliveryProviderError(
            "data.rollback completion does not prove a real target transition to the exact approved backup",
            "provider_completion_unproven",
          );
        }
        return {
          ...after,
          transition: "rolled_back",
          before_target_sha256: before.target.sha256,
          after_target_sha256: after.target.sha256,
          backup_sha256: after.backup.sha256,
          precondition_receipt_hash: preconditionReceipt.receipt_hash,
        };
      }
      const subject = normalizeLocalReleaseSubject(operation.subject);
      const before = preconditionReceipt?.proof;
      if (
        before?.root_path !== subject.root_path
        || !isPlainRecord(before?.root_identity)
        || !Array.isArray(before?.allowed_write_paths)
      ) {
        throw new DeliveryProviderError(
          "release.local completion lacks its exact filesystem precondition",
          "provider_precondition_mismatch",
        );
      }
      const after = inspectBoundary(filesystem, subject);
      if (
        before.root_identity.real_path !== after.root_identity.real_path
        || before.root_identity.device !== after.root_identity.device
        || before.root_identity.inode !== after.root_identity.inode
      ) {
        throw new DeliveryProviderError(
          "release.local root identity changed after authorization",
          "provider_completion_unproven",
        );
      }
      return {
        ...after,
        precondition_receipt_hash: preconditionReceipt.receipt_hash,
      };
    },
  });
}

function assertSupportedAction(operation) {
  const action = operation?.action;
  if (
    action !== "release.local"
    && action !== ROLLBACK_VERIFICATION_ACTION
    && !DATA_ACTIONS.has(action)
  ) {
    throw new DeliveryProviderError(
      `Local filesystem cannot prove '${action || "missing"}'`,
      "provider_operation_unsupported",
      { provider_id: LOCAL_FILESYSTEM_PROVIDER_ID, action: action || null },
    );
  }
  return action;
}

function normalizeRollbackVerificationSubject(subject) {
  if (!isPlainRecord(subject)) {
    throw new DeliveryProviderError(
      "rollback.verify subject must be an object",
      "provider_operation_invalid",
    );
  }
  const unknown = Object.keys(subject)
    .filter((key) => !ROLLBACK_VERIFICATION_SUBJECT_KEYS.has(key));
  if (unknown.length > 0) {
    throw new DeliveryProviderError(
      `rollback.verify subject contains unsupported fields: ${unknown.sort().join(", ")}`,
      "provider_operation_invalid",
    );
  }
  const localTarget = normalizeLocalReleaseSubject({
    root_path: subject.root_path,
    allowed_write_paths: subject.allowed_write_paths,
  });
  const evidenceRoot = requireAbsolutePath(
    subject.evidence_root,
    "rollback.verify.subject.evidence_root",
  );
  if (path.parse(evidenceRoot).root === evidenceRoot) {
    throw new DeliveryProviderError(
      "rollback.verify evidence_root cannot be a filesystem root",
      "provider_operation_invalid",
    );
  }
  if (!Array.isArray(subject.evidence) || subject.evidence.length === 0) {
    throw new DeliveryProviderError(
      "rollback.verify requires at least one exact evidence file",
      "provider_operation_invalid",
    );
  }
  const evidence = subject.evidence.map((item, index) => {
    if (!isPlainRecord(item) || Object.keys(item).some((key) => !["path", "sha256"].includes(key))) {
      throw new DeliveryProviderError(
        `rollback.verify.subject.evidence[${index}] is invalid`,
        "provider_operation_invalid",
      );
    }
    const evidencePath = requireAbsolutePath(
      item.path,
      `rollback.verify.subject.evidence[${index}].path`,
    );
    if (!strictlyInside(evidenceRoot, evidencePath) || !/^[a-f0-9]{64}$/u.test(item.sha256 || "")) {
      throw new DeliveryProviderError(
        `rollback.verify.subject.evidence[${index}] must be a strict child of evidence_root with a SHA-256 digest`,
        "provider_operation_invalid",
      );
    }
    return { path: evidencePath, sha256: item.sha256 };
  });
  const canonicalEvidence = [...evidence]
    .sort((left, right) => left.path.localeCompare(right.path));
  if (
    new Set(canonicalEvidence.map((item) => item.path)).size !== canonicalEvidence.length
    || JSON.stringify(canonicalEvidence) !== JSON.stringify(evidence)
  ) {
    throw new DeliveryProviderError(
      "rollback.verify evidence must be sorted with unique paths",
      "provider_operation_invalid",
    );
  }
  return {
    ...localTarget,
    rollback_procedure: requireNonEmptyString(
      subject.rollback_procedure,
      "rollback.verify.subject.rollback_procedure",
    ),
    evidence_root: evidenceRoot,
    evidence: canonicalEvidence,
  };
}

function inspectRollbackVerificationBoundary(filesystem, subject) {
  const target = inspectBoundary(filesystem, subject);
  const evidenceRootStats = lstatRequired(
    filesystem,
    subject.evidence_root,
    "rollback.verify evidence_root",
  );
  if (evidenceRootStats.isSymbolicLink() || !evidenceRootStats.isDirectory()) {
    throw new DeliveryProviderError(
      "rollback.verify evidence_root must be a real directory, not a symlink",
      "provider_boundary_invalid",
    );
  }
  const evidenceRootRealPath = realpath(filesystem, subject.evidence_root);
  const evidence = subject.evidence.map((expected) => {
    const observed = inspectDataFile(
      filesystem,
      subject.evidence_root,
      evidenceRootRealPath,
      expected.path,
      { required: true, label: "rollback.verify evidence" },
    );
    if (observed.sha256 !== expected.sha256) {
      throw new DeliveryProviderError(
        `rollback.verify evidence changed: ${expected.path}`,
        "provider_boundary_invalid",
      );
    }
    return observed;
  });
  return {
    ...target,
    rollback_procedure: subject.rollback_procedure,
    evidence_root: subject.evidence_root,
    evidence_root_identity: identity(
      evidenceRootStats,
      evidenceRootRealPath,
      "directory",
    ),
    evidence,
  };
}

function normalizeLocalReleaseSubject(subject) {
  if (!isPlainRecord(subject)) {
    throw new DeliveryProviderError("release.local subject must be an object", "provider_operation_invalid");
  }
  const unknown = Object.keys(subject).filter((key) => !SUBJECT_KEYS.has(key));
  if (unknown.length > 0) {
    throw new DeliveryProviderError(
      `release.local subject contains unsupported fields: ${unknown.sort().join(", ")}`,
      "provider_operation_invalid",
    );
  }
  const rootPath = requireAbsolutePath(subject.root_path, "release.local.subject.root_path");
  if (path.parse(rootPath).root === rootPath) {
    throw new DeliveryProviderError("release.local root_path cannot be a filesystem root", "provider_operation_invalid");
  }
  if (!Array.isArray(subject.allowed_write_paths) || subject.allowed_write_paths.length === 0) {
    throw new DeliveryProviderError("release.local requires at least one exact allowed_write_path", "provider_operation_invalid");
  }
  const allowedWritePaths = subject.allowed_write_paths.map((item, index) => {
    const writePath = requireAbsolutePath(item, `release.local.subject.allowed_write_paths[${index}]`);
    if (!strictlyInside(rootPath, writePath)) {
      throw new DeliveryProviderError(
        `release.local allowed_write_path must be a strict child of ${rootPath}: ${writePath}`,
        "provider_operation_invalid",
      );
    }
    return writePath;
  });
  const canonical = [...new Set(allowedWritePaths)].sort();
  if (canonical.length !== allowedWritePaths.length || JSON.stringify(canonical) !== JSON.stringify(allowedWritePaths)) {
    throw new DeliveryProviderError(
      "release.local allowed_write_paths must be sorted and unique",
      "provider_operation_invalid",
    );
  }
  return { root_path: rootPath, allowed_write_paths: canonical };
}

function inspectBoundary(filesystem, subject) {
  const rootStats = lstatRequired(filesystem, subject.root_path, "release.local root_path");
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new DeliveryProviderError(
      "release.local root_path must be a real directory, not a symlink",
      "provider_boundary_invalid",
    );
  }
  const rootRealPath = realpath(filesystem, subject.root_path);
  const allowed = subject.allowed_write_paths.map((writePath) =>
    inspectAllowedPath(filesystem, subject.root_path, rootRealPath, writePath));
  return {
    root_path: subject.root_path,
    root_identity: identity(rootStats, rootRealPath, "directory"),
    allowed_write_paths: allowed,
  };
}

function normalizeDataOperationSubject(subject, action) {
  if (!isPlainRecord(subject)) {
    throw new DeliveryProviderError(`${action} subject must be an object`, "provider_operation_invalid");
  }
  const unknown = Object.keys(subject).filter((key) => !DATA_SUBJECT_KEYS.has(key));
  if (unknown.length > 0) {
    throw new DeliveryProviderError(
      `${action} subject contains unsupported fields: ${unknown.sort().join(", ")}`,
      "provider_operation_invalid",
    );
  }
  const rootPath = requireAbsolutePath(subject.root_path, `${action}.subject.root_path`);
  const targetPath = requireAbsolutePath(subject.target_path, `${action}.subject.target_path`);
  const backupPath = requireAbsolutePath(subject.backup_path, `${action}.subject.backup_path`);
  if (path.parse(rootPath).root === rootPath) {
    throw new DeliveryProviderError(`${action} root_path cannot be a filesystem root`, "provider_operation_invalid");
  }
  if (!strictlyInside(rootPath, targetPath) || !strictlyInside(rootPath, backupPath)) {
    throw new DeliveryProviderError(
      `${action} target_path and backup_path must be strict children of root_path`,
      "provider_operation_invalid",
    );
  }
  if (targetPath === backupPath) {
    throw new DeliveryProviderError(`${action} target_path and backup_path must differ`, "provider_operation_invalid");
  }
  const scopes = normalizeCanonicalStrings(subject.scopes, `${action}.subject.scopes`);
  const previewEvidence = normalizePreviewEvidence(subject.preview_evidence, action);
  const rollback = requireNonEmptyString(subject.rollback, `${action}.subject.rollback`);
  return {
    root_path: rootPath,
    target_path: targetPath,
    scopes,
    preview_evidence: previewEvidence,
    backup_path: backupPath,
    rollback,
  };
}

function normalizeCanonicalStrings(values, label) {
  if (
    !Array.isArray(values)
    || values.length === 0
    || values.some((value) => typeof value !== "string" || value.trim() !== value || value.length === 0)
  ) {
    throw new DeliveryProviderError(`${label} must be a non-empty exact string list`, "provider_operation_invalid");
  }
  const canonical = [...new Set(values)].sort();
  if (JSON.stringify(canonical) !== JSON.stringify(values)) {
    throw new DeliveryProviderError(`${label} must be sorted and unique`, "provider_operation_invalid");
  }
  return canonical;
}

function normalizePreviewEvidence(values, action) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new DeliveryProviderError(
      `${action}.subject.preview_evidence must not be empty`,
      "provider_operation_invalid",
    );
  }
  const normalized = values.map((item, index) => {
    if (
      !isPlainRecord(item)
      || Object.keys(item).some((key) => !["path", "sha256"].includes(key))
      || typeof item.path !== "string"
      || item.path.length === 0
      || !/^[a-f0-9]{64}$/u.test(item.sha256 || "")
    ) {
      throw new DeliveryProviderError(
        `${action}.subject.preview_evidence[${index}] is invalid`,
        "provider_operation_invalid",
      );
    }
    return { path: item.path, sha256: item.sha256 };
  }).sort((left, right) => left.path.localeCompare(right.path));
  if (
    new Set(normalized.map((item) => item.path)).size !== normalized.length
    || JSON.stringify(normalized) !== JSON.stringify(values)
  ) {
    throw new DeliveryProviderError(
      `${action}.subject.preview_evidence must be sorted with unique paths`,
      "provider_operation_invalid",
    );
  }
  return normalized;
}

function inspectDataBoundary(filesystem, subject, action, { completion }) {
  const rootStats = lstatRequired(filesystem, subject.root_path, `${action} root_path`);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new DeliveryProviderError(
      `${action} root_path must be a real directory, not a symlink`,
      "provider_boundary_invalid",
    );
  }
  const rootRealPath = realpath(filesystem, subject.root_path);
  const target = inspectDataFile(
    filesystem,
    subject.root_path,
    rootRealPath,
    subject.target_path,
    { required: true, label: `${action} target_path` },
  );
  const backup = inspectDataFile(
    filesystem,
    subject.root_path,
    rootRealPath,
    subject.backup_path,
    { required: action === "data.rollback" || completion, label: `${action} backup_path` },
  );
  if (
    action === "data.migrate"
    && backup.status === "present"
    && backup.sha256 !== target.sha256
    && !completion
  ) {
    throw new DeliveryProviderError(
      "data.migrate existing backup does not match the current target",
      "provider_boundary_invalid",
    );
  }
  return {
    root_path: subject.root_path,
    root_identity: identity(rootStats, rootRealPath, "directory"),
    target,
    backup,
    scopes: subject.scopes,
    preview_evidence: subject.preview_evidence,
    rollback: subject.rollback,
  };
}

function inspectDataFile(filesystem, rootPath, rootRealPath, targetPath, { required, label }) {
  const inspected = inspectAllowedPath(filesystem, rootPath, rootRealPath, targetPath);
  if (inspected.status === "absent") {
    if (required) {
      throw new DeliveryProviderError(`${label} does not exist: ${targetPath}`, "provider_boundary_invalid");
    }
    return inspected;
  }
  if (inspected.identity?.type !== "file") {
    throw new DeliveryProviderError(`${label} must be a real regular file`, "provider_boundary_invalid");
  }
  let bytes;
  try {
    bytes = filesystem.readFileSync(targetPath);
  } catch (error) {
    throw new DeliveryProviderError(
      `${label} could not be read: ${error?.message || error}`,
      "provider_observation_failed",
    );
  }
  return {
    ...inspected,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    byte_size: String(bytes.length),
  };
}

function assertStableRootIdentity(before, after, action) {
  if (
    before?.root_path !== after.root_path
    || !isPlainRecord(before?.root_identity)
    || before.root_identity.real_path !== after.root_identity.real_path
    || before.root_identity.device !== after.root_identity.device
    || before.root_identity.inode !== after.root_identity.inode
  ) {
    throw new DeliveryProviderError(
      `${action} root identity changed after authorization`,
      "provider_completion_unproven",
    );
  }
}

function inspectAllowedPath(filesystem, rootPath, rootRealPath, writePath) {
  const relative = path.relative(rootPath, writePath);
  const components = relative.split(path.sep).filter(Boolean);
  let current = rootPath;
  let missing = false;
  let finalStats = null;
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]);
    if (missing) continue;
    const stats = lstatOptional(filesystem, current);
    if (!stats) {
      missing = true;
      continue;
    }
    if (stats.isSymbolicLink()) {
      throw new DeliveryProviderError(
        `release.local path contains a symlink component: ${current}`,
        "provider_boundary_invalid",
      );
    }
    if (index < components.length - 1 && !stats.isDirectory()) {
      throw new DeliveryProviderError(
        `release.local path has a non-directory parent component: ${current}`,
        "provider_boundary_invalid",
      );
    }
    if (index === components.length - 1) finalStats = stats;
  }
  if (missing) {
    const existingParent = nearestExistingParent(filesystem, writePath, rootPath);
    const parentRealPath = realpath(filesystem, existingParent);
    if (!insideOrEqual(rootRealPath, parentRealPath)) {
      throw new DeliveryProviderError(
        `release.local missing path would escape its real root: ${writePath}`,
        "provider_boundary_invalid",
      );
    }
    return {
      path: writePath,
      status: "absent",
      nearest_existing_parent: parentRealPath,
    };
  }
  const writeRealPath = realpath(filesystem, writePath);
  if (!strictlyInside(rootRealPath, writeRealPath)) {
    throw new DeliveryProviderError(
      `release.local path resolves outside its real root: ${writePath}`,
      "provider_boundary_invalid",
    );
  }
  return {
    path: writePath,
    status: "present",
    identity: identity(finalStats, writeRealPath, fileType(finalStats)),
  };
}

function nearestExistingParent(filesystem, targetPath, rootPath) {
  let current = path.dirname(targetPath);
  while (strictlyInside(rootPath, current) || current === rootPath) {
    const stats = lstatOptional(filesystem, current);
    if (stats) {
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new DeliveryProviderError(
          `release.local nearest existing parent is not a real directory: ${current}`,
          "provider_boundary_invalid",
        );
      }
      return current;
    }
    if (current === rootPath) break;
    current = path.dirname(current);
  }
  throw new DeliveryProviderError("release.local could not resolve a safe existing parent", "provider_boundary_invalid");
}

function identity(stats, realPath, type) {
  return {
    real_path: realPath,
    device: String(stats.dev),
    inode: String(stats.ino),
    type,
  };
}

function fileType(stats) {
  if (stats.isDirectory()) return "directory";
  if (stats.isFile()) return "file";
  return "other";
}

function lstatRequired(filesystem, targetPath, label) {
  const stats = lstatOptional(filesystem, targetPath);
  if (!stats) {
    throw new DeliveryProviderError(`${label} does not exist: ${targetPath}`, "provider_boundary_invalid");
  }
  return stats;
}

function lstatOptional(filesystem, targetPath) {
  try {
    return filesystem.lstatSync(targetPath, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw new DeliveryProviderError(
      `release.local could not inspect ${targetPath}: ${error?.message || error}`,
      "provider_observation_failed",
    );
  }
}

function realpath(filesystem, targetPath) {
  try {
    return typeof filesystem.realpathSync.native === "function"
      ? filesystem.realpathSync.native(targetPath)
      : filesystem.realpathSync(targetPath);
  } catch (error) {
    throw new DeliveryProviderError(
      `release.local could not resolve ${targetPath}: ${error?.message || error}`,
      "provider_observation_failed",
    );
  }
}

function requireAbsolutePath(value, label) {
  const targetPath = requireNonEmptyString(value, label);
  if (!path.isAbsolute(targetPath) || targetPath.includes("\0") || path.normalize(targetPath) !== targetPath) {
    throw new DeliveryProviderError(`${label} must be a normalized absolute path`, "provider_operation_invalid");
  }
  return targetPath;
}

function strictlyInside(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function insideOrEqual(rootPath, candidatePath) {
  return rootPath === candidatePath || strictlyInside(rootPath, candidatePath);
}

function assertFilesystemApi(filesystem) {
  if (
    !filesystem
    || typeof filesystem.lstatSync !== "function"
    || typeof filesystem.realpathSync !== "function"
    || typeof filesystem.readFileSync !== "function"
  ) {
    throw new DeliveryProviderError(
      "local-filesystem requires lstatSync, realpathSync, and readFileSync APIs",
      "provider_invalid",
    );
  }
}
