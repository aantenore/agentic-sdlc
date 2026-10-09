// Work that lands while a story is still in progress. Two stories may start
// from the same project state and both change the same area: Git merges the
// text, but the second story was planned and written without the first one's
// change. These helpers find such overlaps so they are reviewed before merge.
import { pathInsideEveryScope } from "./baseline-refresh.mjs";

export const DELIVERED_OVERLAP_KINDS = Object.freeze(["write_scope", "context"]);
export const DELIVERED_OVERLAP_MODES = Object.freeze(["confirm", "warn", "off"]);
export const CLAIM_OVERLAP_MODES = Object.freeze(["warn", "off"]);
export const OVERLAP_CONFIRMATION_ACTORS = Object.freeze(["any", "human"]);

const DEFAULT_POLICY = Object.freeze({
  write_scope: "confirm",
  context: "warn",
  confirmation_actor: "any",
  claim: "warn",
});

/**
 * The validated delivered-overlap policy, with defaults for every key a
 * project leaves out. invalid(message) reports a wrong value.
 */
export function deliveredOverlapPolicy(configured, invalid) {
  if (configured === undefined || configured === null) return DEFAULT_POLICY;
  if (typeof configured !== "object" || Array.isArray(configured)) {
    invalid("orchestration_policy.delivered_overlap must be an object.");
  }
  const pick = (key, allowed) => {
    const value = configured[key] ?? DEFAULT_POLICY[key];
    if (!allowed.includes(value)) {
      invalid(`orchestration_policy.delivered_overlap.${key} must be one of ${allowed.join(", ")}.`);
    }
    return value;
  };
  return Object.freeze({
    write_scope: pick("write_scope", DELIVERED_OVERLAP_MODES),
    context: pick("context", DELIVERED_OVERLAP_MODES),
    confirmation_actor: pick("confirmation_actor", OVERLAP_CONFIRMATION_ACTORS),
    claim: pick("claim", CLAIM_OVERLAP_MODES),
  });
}

/**
 * The area a set of requirement write scopes allows: a path must lie inside
 * every scope, so the region is the intersection of each scope's prefixes.
 * "." stands for the whole project.
 */
export function writeScopeRegion(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0) return [];
  let region = null;
  for (const allowedPaths of scopes) {
    const prefixes = Array.isArray(allowedPaths) ? allowedPaths.map(normalizePrefix).filter(Boolean) : [];
    region = region === null ? minimalPrefixes(prefixes) : intersectPrefixes(region, prefixes);
    if (region.length === 0) return [];
  }
  return region;
}

/** The paths (as prefixes) both sets of write scopes allow, empty when they are disjoint. */
export function sharedWriteRegion(leftScopes, rightScopes) {
  return intersectPrefixes(writeScopeRegion(leftScopes), writeScopeRegion(rightScopes));
}

/**
 * Changes delivered by other stories that this story has not seen.
 *
 * story: { story_id, write_scopes, context_hashes } where context_hashes are
 *   the baseline's recorded hashes this story started from.
 * deliveries: [{ story_id, delivery_profile_id, merge_commit_sha,
 *   seen: true | false | undefined (cannot tell),
 *   changed_paths: string[] | undefined (cannot tell),
 *   contentSha256(path) }]
 *
 * A changed path inside the story's own write scope is a "write_scope"
 * overlap; a changed path the story only read from its baseline is a
 * "context" overlap. Deliveries that cannot be checked are listed as
 * unverifiable rather than silently ignored.
 */
export function findDeliveredOverlaps(story, deliveries) {
  const overlaps = [];
  const unverifiable = [];
  const contextHashes = story.context_hashes || {};
  for (const delivery of deliveries || []) {
    if (delivery.story_id === story.story_id || delivery.seen === true) continue;
    const reference = {
      story_id: delivery.story_id,
      delivery_profile_id: delivery.delivery_profile_id,
      merge_commit_sha: delivery.merge_commit_sha,
    };
    if (delivery.seen === undefined || !Array.isArray(delivery.changed_paths)) {
      unverifiable.push(reference);
      continue;
    }
    for (const sourcePath of [...new Set(delivery.changed_paths)].sort()) {
      const kind = pathInsideEveryScope(sourcePath, story.write_scopes)
        ? "write_scope"
        : Object.hasOwn(contextHashes, sourcePath) ? "context" : null;
      if (!kind) continue;
      const sha256 = delivery.contentSha256(sourcePath);
      if (sha256 === undefined) {
        unverifiable.push(reference);
        break;
      }
      overlaps.push({ path: sourcePath, kind, ...reference, sha256 });
    }
  }
  return { overlaps, unverifiable: uniqueBy(unverifiable, (item) => item.merge_commit_sha) };
}

/** Identity of one overlap: the same path, delivery, and delivered bytes. */
export function deliveredOverlapKey(overlap) {
  return [overlap.path, overlap.story_id, overlap.merge_commit_sha, overlap.sha256 ?? "removed"].join("\u0000");
}

/** Overlaps no review of this story has confirmed yet. */
export function unconfirmedDeliveredOverlaps(overlaps, reviews) {
  const confirmed = new Set((reviews || []).flatMap((review) => (review.overlaps || []).map(deliveredOverlapKey)));
  return (overlaps || []).filter((overlap) => !confirmed.has(deliveredOverlapKey(overlap)));
}

function normalizePrefix(value) {
  const text = String(value || "").trim().replace(/\\/gu, "/").replace(/^\.\/+/u, "").replace(/\/+$/u, "");
  return text === "" ? "." : text;
}

function contains(outer, inner) {
  return outer === "." || inner === outer || inner.startsWith(`${outer}/`);
}

function minimalPrefixes(prefixes) {
  const unique = [...new Set(prefixes)].sort();
  return unique.filter((prefix) => !unique.some((other) => other !== prefix && contains(other, prefix)));
}

function intersectPrefixes(left, right) {
  const result = [];
  for (const a of left) {
    for (const b of right) {
      if (contains(a, b)) result.push(b);
      else if (contains(b, a)) result.push(a);
    }
  }
  return minimalPrefixes(result);
}

function uniqueBy(items, keyOf) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyOf(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
