import {
  computeStableHash,
} from "./canonical.mjs";
import {
  parseSharedPayload,
  sealSharedPayload,
} from "./shared-ref-records.mjs";

// A baseline refresh records the successor snapshot of the project together
// with the exact difference from the approved snapshot it replaces and, for
// every changed path, the delivered work that produced those bytes. The
// functions here are pure: callers supply the evidence they read from the
// project records and from Git.

export const BASELINE_REFRESH_SCHEMA = "baseline-refresh:v1";
export const DELIVERED_WORK_APPROVAL_SOURCE = "delivered-work";
export const DELIVERED_WORK_APPROVAL_SCOPE = "baseline-refresh:delivered-work";
export const BASELINE_REFRESH_CHANGES = Object.freeze(["added", "changed", "removed"]);

export function computeBaselineDelta(previousHashes = {}, currentHashes = {}) {
  const added = [];
  const changed = [];
  const removed = [];
  for (const [sourcePath, hash] of Object.entries(currentHashes)) {
    if (!Object.hasOwn(previousHashes, sourcePath)) added.push(sourcePath);
    else if (previousHashes[sourcePath] !== hash) changed.push(sourcePath);
  }
  for (const sourcePath of Object.keys(previousHashes)) {
    if (!Object.hasOwn(currentHashes, sourcePath)) removed.push(sourcePath);
  }
  return {
    added: added.sort(),
    changed: changed.sort(),
    removed: removed.sort(),
  };
}

export function baselineDeltaEntries(delta) {
  return BASELINE_REFRESH_CHANGES.flatMap((change) => (delta?.[change] || [])
    .map((sourcePath) => ({ path: sourcePath, change })));
}

export function baselineDeltaSize(delta) {
  return baselineDeltaEntries(delta).length;
}

export function pathInsideEveryScope(sourcePath, scopes) {
  return Array.isArray(scopes) && scopes.length > 0 && scopes.every((allowedPaths) => (
    Array.isArray(allowedPaths)
    && allowedPaths.length > 0
    && allowedPaths.some((allowedPath) => (
      allowedPath === "."
      || sourcePath === allowedPath
      || sourcePath.startsWith(`${allowedPath}/`)
    ))
  ));
}

/**
 * Attribute every changed path to delivered work. A path is explained by a
 * delivery when it lies inside every requirement write scope that delivery
 * started under, and the delivered commit holds exactly the bytes the new
 * snapshot records (or no file, for a removal). Anything else is unexplained
 * and needs a person's review.
 *
 * evidences: [{ story_id, delivery_profile_id, merge_commit_sha, write_scopes,
 *   contentSha256(path) -> sha256 | null (absent) | undefined (unavailable) }]
 */
export function explainBaselineDelta(delta, currentHashes, evidences) {
  const explanations = [];
  const unexplained = [];
  for (const entry of baselineDeltaEntries(delta)) {
    const expected = entry.change === "removed" ? null : currentHashes[entry.path];
    const evidence = (evidences || []).find((candidate) => (
      pathInsideEveryScope(entry.path, candidate.write_scopes)
      && candidate.contentSha256(entry.path) === expected
    ));
    if (evidence) {
      explanations.push({
        path: entry.path,
        change: entry.change,
        sha256: expected,
        story_id: evidence.story_id,
        delivery_profile_id: evidence.delivery_profile_id,
        merge_commit_sha: evidence.merge_commit_sha,
      });
    } else {
      unexplained.push({ path: entry.path, change: entry.change });
    }
  }
  return { explanations, unexplained };
}

export function sameBaselineDelta(left, right) {
  return BASELINE_REFRESH_CHANGES.every((change) => {
    const a = left?.[change] || [];
    const b = right?.[change] || [];
    return a.length === b.length && a.every((value, index) => value === b[index]);
  });
}

// One refresh per approved baseline across every computer of a project: the
// successor is claimed as a create-only ref on the git remote, the same way
// story claims are, before any file is written. Of two computers refreshing
// the same baseline at once, exactly one push is accepted; the other is told
// which successor won and refreshes from it after pulling.
export const BASELINE_REFRESH_SHARED_ROOT = "refs/agentic-sdlc/baseline-refresh";
export const BASELINE_REFRESH_TRACKING_ROOT = "refs/agentic-sdlc-shared/baseline-refresh";
export const BASELINE_REFRESH_SHARED_KIND = "baseline_refresh_shared";
export const BASELINE_REFRESH_SHARED_VERSION = 1;

export function baselineRefreshNamespace(baselineId) {
  const id = String(baselineId);
  if (/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(id)) return id;
  return `${id.replace(/[^A-Za-z0-9_-]/gu, "_")}-${computeStableHash({ baseline_id: id }).slice(0, 12)}`;
}

export function baselineRefreshSharedRef(previousBaselineId) {
  return `${BASELINE_REFRESH_SHARED_ROOT}/${baselineRefreshNamespace(previousBaselineId)}/successor`;
}

export function baselineRefreshTrackingRoot(fingerprint) {
  return `${BASELINE_REFRESH_TRACKING_ROOT}/${String(fingerprint || "unknown").slice(0, 16)}`;
}

export function baselineRefreshTrackingRef(ref, fingerprint) {
  return `${baselineRefreshTrackingRoot(fingerprint)}/${ref.slice(BASELINE_REFRESH_SHARED_ROOT.length + 1)}`;
}

export function buildBaselineRefreshSharedPayload({ previousBaselineId, successorId, refreshHash, createdAt }) {
  return sealSharedPayload({
    kind: BASELINE_REFRESH_SHARED_KIND,
    version: BASELINE_REFRESH_SHARED_VERSION,
    previous_baseline_id: previousBaselineId,
    successor_id: successorId,
    refresh_hash: refreshHash,
    created_at: createdAt,
  });
}

/** The successor a shared record names for this baseline, or null when the record is not one. */
export function readBaselineRefreshSharedPayload(message, previousBaselineId) {
  const payload = parseSharedPayload(message);
  if (
    !payload
    || payload.kind !== BASELINE_REFRESH_SHARED_KIND
    || payload.version !== BASELINE_REFRESH_SHARED_VERSION
    || payload.previous_baseline_id !== previousBaselineId
    || typeof payload.successor_id !== "string"
  ) {
    return null;
  }
  return payload;
}
