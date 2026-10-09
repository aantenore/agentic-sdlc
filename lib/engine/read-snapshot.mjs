import { AsyncLocalStorage } from "node:async_hooks";

/**
 * A read snapshot lets one read-only report (status, the orchestration
 * snapshot, the Observatory model) ask Git the same question many times while
 * running it once. Inside the snapshot, identical Git queries return the
 * answer of the first call; outside it, every call runs as before. Commands
 * that write records or certify a story never open a snapshot, so their
 * checks always observe the repository live.
 */
const storage = new AsyncLocalStorage();

/** Runs `callback` inside a read snapshot; a nested call joins the outer one. */
export function withReadSnapshot(callback) {
  if (storage.getStore()) return callback();
  return storage.run(new Map(), callback);
}

export function readSnapshotActive() {
  return Boolean(storage.getStore());
}

/**
 * The cached answer for `key` inside a read snapshot, computing it on first
 * use. Failures are cached too, so a query that failed once fails the same
 * way for every caller of the same report. Values must be immutable (strings,
 * booleans, frozen data).
 */
export function readSnapshotValue(key, compute) {
  const memo = storage.getStore();
  if (!memo) return compute();
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
