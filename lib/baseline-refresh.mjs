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
 *   contentSha256(path) -> sha256 | null (absent) | undefined (unavailable),
 *   prefetch?(paths), changedPaths?() -> string[] | undefined,
 *   closed_at? }], newest delivery first
 *
 * Several stories can change one path between two snapshots: the delivery
 * whose commit holds the final bytes explains it, and every other delivery
 * that changed the path and merged after `since` (the previous snapshot's
 * time) is listed in also_changed_by, so no contribution disappears.
 */
export function explainBaselineDelta(delta, currentHashes, evidences, { since = null } = {}) {
  const explanations = [];
  const unexplained = [];
  const entries = baselineDeltaEntries(delta);
  const prefetched = new Set();
  // A candidate that supports it reads every path of the delta inside its
  // scope at once the first time it is consulted.
  const contentOf = (candidate, sourcePath) => {
    if (candidate.prefetch && !prefetched.has(candidate)) {
      prefetched.add(candidate);
      candidate.prefetch(entries
        .map((entry) => entry.path)
        .filter((entryPath) => pathInsideEveryScope(entryPath, candidate.write_scopes)));
    }
    return candidate.contentSha256(sourcePath);
  };
  // The paths a delivery's merge changed, or null when that is unknown.
  const changedSets = new Map();
  const changedSet = (candidate) => {
    if (!changedSets.has(candidate)) {
      const changed = candidate.changedPaths?.();
      changedSets.set(candidate, Array.isArray(changed) ? new Set(changed) : null);
    }
    return changedSets.get(candidate);
  };
  const changedBy = (candidate, sourcePath) => Boolean(changedSet(candidate)?.has(sourcePath));
  for (const entry of entries) {
    const expected = entry.change === "removed" ? null : currentHashes[entry.path];
    const holds = (candidate) => (
      pathInsideEveryScope(entry.path, candidate.write_scopes)
      && contentOf(candidate, entry.path) === expected
    );
    // A later merge also holds bytes it only carried along; the newest
    // delivery that changed the path (or may have) produced them.
    let evidence = null;
    let carrier = null;
    for (const candidate of evidences || []) {
      if (!holds(candidate)) continue;
      const changed = changedSet(candidate);
      if (changed === null || changed.has(entry.path)) {
        evidence = candidate;
        break;
      }
      carrier ??= candidate;
    }
    evidence ??= carrier;
    if (evidence) {
      const alsoChangedBy = since === null ? [] : (evidences || [])
        .filter((candidate) => (
          candidate !== evidence
          && String(candidate.closed_at || "") > since
          && pathInsideEveryScope(entry.path, candidate.write_scopes)
          && changedBy(candidate, entry.path)
        ))
        .map(deliveryReference);
      explanations.push({
        path: entry.path,
        change: entry.change,
        sha256: expected,
        ...deliveryReference(evidence),
        ...(alsoChangedBy.length > 0 ? { also_changed_by: alsoChangedBy } : {}),
      });
    } else {
      unexplained.push({ path: entry.path, change: entry.change });
    }
  }
  return { explanations, unexplained };
}

function deliveryReference(evidence) {
  return {
    story_id: evidence.story_id,
    delivery_profile_id: evidence.delivery_profile_id,
    merge_commit_sha: evidence.merge_commit_sha,
  };
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

// A successor withdrawn before approval releases the claim: the next refresh
// claims the following generation (`successor-1`, `successor-2`, ...), and the
// withdrawal itself is a create-only record (`withdrawn`, `withdrawn-1`, ...)
// next to the successor it releases. Nothing is ever removed from the remote.
function generationSuffix(generation) {
  return generation ? `-${generation}` : "";
}

export function baselineRefreshSharedRef(previousBaselineId, generation = 0) {
  return `${BASELINE_REFRESH_SHARED_ROOT}/${baselineRefreshNamespace(previousBaselineId)}/successor${generationSuffix(generation)}`;
}

export function baselineRefreshWithdrawalRef(previousBaselineId, generation = 0) {
  return `${BASELINE_REFRESH_SHARED_ROOT}/${baselineRefreshNamespace(previousBaselineId)}/withdrawn${generationSuffix(generation)}`;
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

export const BASELINE_REFRESH_WITHDRAWAL_KIND = "baseline_refresh_withdrawal";

export function buildBaselineRefreshWithdrawalPayload({
  previousBaselineId, successorId, refreshHash, generation, reason, withdrawnBy, withdrawnAt,
}) {
  return sealSharedPayload({
    kind: BASELINE_REFRESH_WITHDRAWAL_KIND,
    version: BASELINE_REFRESH_SHARED_VERSION,
    previous_baseline_id: previousBaselineId,
    successor_id: successorId,
    refresh_hash: refreshHash ?? null,
    generation,
    reason,
    withdrawn_by: withdrawnBy,
    withdrawn_at: withdrawnAt,
  });
}

/** The withdrawal a shared record describes for this baseline, or null when the record is not one. */
export function readBaselineRefreshWithdrawalPayload(message, previousBaselineId) {
  const payload = parseSharedPayload(message);
  if (
    !payload
    || payload.kind !== BASELINE_REFRESH_WITHDRAWAL_KIND
    || payload.version !== BASELINE_REFRESH_SHARED_VERSION
    || payload.previous_baseline_id !== previousBaselineId
    || typeof payload.successor_id !== "string"
  ) {
    return null;
  }
  return payload;
}

/**
 * Reads the shared refresh records of one baseline generation by generation.
 * A generation whose successor has a matching withdrawal is released and the
 * walk moves on. Returns the open successor (still claimed, with its
 * generation) or the first free generation, plus every withdrawn successor.
 * A withdrawal that does not name the successor of its generation releases
 * nothing.
 */
export function resolveBaselineRefreshClaims(records, previousBaselineId) {
  const byRef = new Map((records || []).map((record) => [record.ref, record]));
  const withdrawn = [];
  for (let generation = 0; ; generation += 1) {
    const successorRecord = byRef.get(baselineRefreshSharedRef(previousBaselineId, generation));
    if (!successorRecord) return { open: null, nextGeneration: generation, withdrawn };
    const successor = readBaselineRefreshSharedPayload(successorRecord.message, previousBaselineId);
    const withdrawalRecord = byRef.get(baselineRefreshWithdrawalRef(previousBaselineId, generation));
    const withdrawal = successor && withdrawalRecord
      ? readBaselineRefreshWithdrawalPayload(withdrawalRecord.message, previousBaselineId)
      : null;
    if (
      !successor
      || !withdrawal
      || withdrawal.successor_id !== successor.successor_id
      || (withdrawal.refresh_hash && withdrawal.refresh_hash !== successor.refresh_hash)
    ) {
      return {
        open: { generation, payload: successor || { successor_id: "an unreadable record" }, objectName: successorRecord.objectName },
        nextGeneration: generation + 1,
        withdrawn,
      };
    }
    withdrawn.push({ generation, successor, withdrawal });
  }
}

// A refresh successor withdrawn before approval stays as history and never
// replaces its predecessor.
export const BASELINE_WITHDRAWN_STATUS = "withdrawn";

export function isWithdrawnBaseline(baseline) {
  return baseline?.status === BASELINE_WITHDRAWN_STATUS;
}

/** Baselines that may describe the project: every one except withdrawn successors. */
export function liveBaselines(baselines) {
  return (baselines || []).filter((baseline) => !isWithdrawnBaseline(baseline));
}
