// Initialization and failure cleanup for an exclusively created lock file.
//
// Between creating a lock and writing its metadata, another process may judge
// the still-empty lock stale, move it aside and install its own lock at the
// same path. Cleanup after a failed initialization must therefore remove the
// path only while it still holds the exact file this process created.

import fs from "node:fs";

import {
  IDENTITY_STAT_OPTIONS,
  fileIdentity,
  hasStableFileIdentity,
  sameStableFileIdentity,
} from "./file-identity.mjs";

/**
 * True only when `current` (an lstat of the lock path) is a regular file with
 * the same stable identity as the created lock. An unknown or unstable
 * identity cannot prove ownership and is reported as not owned.
 */
export function createdLockStillOwned(createdIdentity, current) {
  if (!current || current.isSymbolicLink?.() || !current.isFile?.()) return false;
  return hasStableFileIdentity(createdIdentity) && sameStableFileIdentity(createdIdentity, current);
}

/**
 * Removes `lockPath` only when it is still the created lock. Returns whether a
 * file was removed. A missing path is not an error.
 */
export function removeCreatedLockIfOwned(lockPath, createdIdentity, deps = fs) {
  let current;
  try {
    current = deps.lstatSync(lockPath, IDENTITY_STAT_OPTIONS);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (!createdLockStillOwned(createdIdentity, current)) return false;
  deps.unlinkSync(lockPath);
  return true;
}

/**
 * Writes `content` to a freshly created lock descriptor and closes it. On any
 * failure the lock is removed only if this process still owns the path, and
 * the original error is rethrown. `authorize` runs before each mutation.
 */
export function initializeCreatedLock({ lockPath, descriptor, content, authorize = () => {} }, deps = fs) {
  let createdIdentity;
  try {
    createdIdentity = fileIdentity(deps.fstatSync(descriptor, IDENTITY_STAT_OPTIONS));
    authorize();
    deps.writeFileSync(descriptor, content);
    deps.closeSync(descriptor);
  } catch (error) {
    try {
      deps.closeSync(descriptor);
    } catch {
      // Preserve the original metadata-write or close error.
    }
    try {
      authorize();
      removeCreatedLockIfOwned(lockPath, createdIdentity, deps);
    } catch {
      // A partially initialized lock remaining on disk is safer than hiding the
      // failure or deleting a lock another process installed at this path.
    }
    throw error;
  }
}
