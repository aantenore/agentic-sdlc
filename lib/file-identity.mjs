// File identity helpers shared by lock ownership and TOCTOU checks.
//
// Identity reads must use `{ bigint: true }` stats: NTFS file ids are 64-bit
// (48-bit MFT index + 16-bit sequence) and routinely exceed 2^53, so the
// default Number stats can round two different files to the same `ino`.
// Number stats (for example from injected test doubles) are still accepted
// and compared exactly as long as they are integers.

export const IDENTITY_STAT_OPTIONS = Object.freeze({ bigint: true });

function identityPart(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  return undefined;
}

/** True when the stats carry a usable dev/ino pair (ino 0 means "no stable id"). */
export function hasStableFileIdentity(stats) {
  const dev = identityPart(stats?.dev);
  const ino = identityPart(stats?.ino);
  return dev !== undefined && ino !== undefined && ino !== 0n;
}

/** Exact dev/ino equality; false unless both sides have a stable identity. */
export function sameStableFileIdentity(left, right) {
  return hasStableFileIdentity(left)
    && hasStableFileIdentity(right)
    && identityPart(left.dev) === identityPart(right.dev)
    && identityPart(left.ino) === identityPart(right.ino);
}

/**
 * Compares a stat timestamp (`mtime`, `ctime`, ...) at the best precision both
 * sides offer: nanoseconds for bigint stats, otherwise the `*Ms` value.
 */
export function sameStatTime(left, right, name) {
  const leftNs = left?.[`${name}Ns`];
  const rightNs = right?.[`${name}Ns`];
  if (typeof leftNs === "bigint" && typeof rightNs === "bigint") return leftNs === rightNs;
  const leftMs = Number(left?.[`${name}Ms`]);
  const rightMs = Number(right?.[`${name}Ms`]);
  // Bigint stats expose whole milliseconds; align a Number side before comparing.
  if (typeof leftNs === "bigint" || typeof rightNs === "bigint") return Math.floor(leftMs) === Math.floor(rightMs);
  return leftMs === rightMs;
}
