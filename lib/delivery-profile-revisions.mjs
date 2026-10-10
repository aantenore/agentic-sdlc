/**
 * Revisions of one approved delivery profile. `autonomy delivery amend`
 * widens a profile in place (same id, a new revision, a new hash) without
 * touching the contract that names it. The revision chain lives in the
 * profile's own hashed content, so the hashes of earlier revisions can be
 * trusted: receipts and steps recorded under an earlier revision stay valid
 * because a revision only ever widens the boundary the earlier one approved.
 */

function revisionRecord(profile) {
  const revision = profile?.extensions?.revision;
  return revision && typeof revision === "object" && !Array.isArray(revision) ? revision : null;
}

/** 1 for a profile that was never amended. */
export function deliveryProfileRevisionNumber(profile) {
  const number = revisionRecord(profile)?.number;
  return Number.isInteger(number) && number > 0 ? number : 1;
}

/** Entries { revision, profile_hash } of the earlier revisions, oldest first. */
export function deliveryProfileRevisionHistory(profile) {
  const history = revisionRecord(profile)?.history;
  return Array.isArray(history)
    ? history.filter((entry) => entry && typeof entry.profile_hash === "string")
    : [];
}

/** The hashes a receipt may carry for this profile: its own and every earlier revision's. */
export function deliveryProfileAcceptedHashes(profile) {
  return [profile?.profile_hash, ...deliveryProfileRevisionHistory(profile).map((entry) => entry.profile_hash)]
    .filter((hash) => typeof hash === "string");
}

/** True when `hash` is the profile's current hash or one of its earlier revisions' hashes. */
export function deliveryProfileHashMatches(profile, hash) {
  return typeof hash === "string" && hash.length > 0 && deliveryProfileAcceptedHashes(profile).includes(hash);
}
