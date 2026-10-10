import { AsyncLocalStorage } from "node:async_hooks";

import { process } from "../runtime/host.mjs";

/**
 * A read snapshot lets one read-only report (status, the orchestration
 * snapshot, the Observatory model) ask Git the same question many times while
 * running it once. Inside the snapshot, identical Git queries return the
 * answer of the first call; outside it, every call runs as before. Commands
 * that write records or certify a story never open a snapshot, so their
 * checks always observe the repository live.
 */
const storage = new AsyncLocalStorage();

/**
 * Runs `callback` inside a read snapshot; a nested call joins the outer one.
 * `fastChecks` lets the report trust each story's sealed final receipt
 * instead of verifying it again against the repository.
 */
export function withReadSnapshot(
  callback,
  { fastChecks = false, verifyStoryId = null, memoize = true } = {},
) {
  if (storage.getStore()) return callback();
  const memo = new Map();
  memo.fastChecks = fastChecks === true;
  memo.verifyStoryIds = new Set(
    (Array.isArray(verifyStoryId) ? verifyStoryId : [verifyStoryId]).filter(Boolean),
  );
  memo.memoize = memoize !== false;
  return storage.run(memo, callback);
}

/**
 * True inside a read-only report that trusts sealed final receipts: status
 * and the orchestration views, unless AGENTIC_SDLC_STATUS_CHECKS is "full".
 * Gates, claims, and every write keep verifying.
 */
export function readSnapshotFastChecks(storyId = null) {
  const memo = storage.getStore();
  if (memo?.fastChecks !== true) return false;
  // A gate trusts the other stories' sealed receipts but always verifies the
  // story it certifies.
  return !(storyId && memo.verifyStoryIds.has(storyId));
}

/**
 * False when AGENTIC_SDLC_STATUS_CHECKS is "full": every sealed receipt is
 * then verified again against the repository.
 */
export function sealedReceiptTrustEnabled(env = process.env) {
  return String(env.AGENTIC_SDLC_STATUS_CHECKS || "fast").trim().toLowerCase() !== "full";
}

/**
 * Runs the read-only checks that certify one story inside a read snapshot:
 * repeated Git questions run once, the other stories' sealed final receipts
 * are trusted, and `storyId` itself is always verified in full.
 */
export function withStoryCheckSnapshot(storyId, callback) {
  return withReadSnapshot(callback, {
    fastChecks: Boolean(storyId) && sealedReceiptTrustEnabled(),
    verifyStoryId: storyId || null,
  });
}

export function readSnapshotActive() {
  return storage.getStore()?.memoize === true;
}

/**
 * Runs a command that writes records with every Git query live, while trusting
 * the sealed final receipts of stories other than `storyIds`, which are always
 * verified in full. With no story to verify, nothing is trusted.
 */
export function withSealedReceiptTrust(storyIds, callback) {
  const ids = (Array.isArray(storyIds) ? storyIds : [storyIds]).filter(Boolean);
  return withReadSnapshot(callback, {
    fastChecks: ids.length > 0 && sealedReceiptTrustEnabled(),
    verifyStoryId: ids,
    memoize: false,
  });
}

/**
 * The cached answer for `key` inside a read snapshot, computing it on first
 * use. Failures are cached too, so a query that failed once fails the same
 * way for every caller of the same report. Values must be immutable (strings,
 * booleans, frozen data).
 */
export function readSnapshotValue(key, compute) {
  const memo = storage.getStore();
  if (!memo || memo.memoize !== true) return compute();
  if (memo.has(key)) {
    const entry = memo.get(key);
    if (entry.failed) throw entry.error;
    return entry.value;
  }
  try {
    const value = compute();
    memo.set(key, { failed: false, value });
    return value;
  } catch (error) {
    memo.set(key, { failed: true, error });
    throw error;
  }
}
