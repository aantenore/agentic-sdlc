import {
  CLAIM_SHARED_REF_ROOT,
  CLAIM_SHARED_TRACKING_ROOT,
  holderIdentityText,
  interpretSharedClaimRecords,
  plainSharedText,
  sharedClaimHolder,
} from "../story-claim-shared-state.mjs";
import { listLocalRefs } from "../engine/shared-refs.mjs";

export const OBSERVATORY_CLAIMS_SCHEMA_VERSION = "change-observatory:claims:v1";
const DEFAULT_TIMEOUT_SECONDS = 5;

/**
 * Shared story claims as this clone last saw them on the remote. Only the
 * local copies kept by `status`, `story claim`, and the other claim commands
 * are read: no network access and no write, so opening the Observatory never
 * waits for the remote. `checked` is false when there is nothing to read.
 */
export function readTrackedSharedClaims(projectRoot, {
  timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  listRefs = listLocalRefs,
} = {}) {
  const listed = listRefs({ root: projectRoot }, [`${CLAIM_SHARED_TRACKING_ROOT}/`], timeoutSeconds);
  if (listed.error) return emptyClaims({ error: "Shared claims could not be read on this computer." });
  // One tracking folder per remote; the busiest one is the remote in use.
  const byRemote = new Map();
  for (const item of listed.refs ?? []) {
    const rest = String(item.trackingRef ?? "").slice(CLAIM_SHARED_TRACKING_ROOT.length + 1);
    const slash = rest.indexOf("/");
    if (slash <= 0) continue;
    const remote = rest.slice(0, slash);
    if (!byRemote.has(remote)) byRemote.set(remote, []);
    byRemote.get(remote).push({ ref: `${CLAIM_SHARED_REF_ROOT}/${rest.slice(slash + 1)}`, message: item.message });
  }
  if (!byRemote.size) return emptyClaims();
  const records = [...byRemote.values()].sort((left, right) => right.length - left.length)[0];
  const interpreted = interpretSharedClaimRecords(records);
  const claims = [];
  for (const state of interpreted.stories.values()) {
    if (!state.story_id) continue;
    if (state.active) {
      const holder = sharedClaimHolder(state.active);
      claims.push({
        storyId: plainSharedText(state.story_id),
        state: holder.reservation ? "reserved" : "claimed",
        agent: holder.agent,
        holder: holderIdentityText(holder),
        branch: holder.branch,
        claimedAt: holder.claimed_at,
        expiresAt: holder.expires_at,
      });
    } else if (state.completed) {
      claims.push({
        storyId: plainSharedText(state.story_id),
        state: "completed",
        completion: plainSharedText(state.completed.status),
        endedAt: plainSharedText(state.completed.released_at ?? state.completed.created_at ?? null),
      });
    }
  }
  claims.sort((left, right) => left.storyId.localeCompare(right.storyId));
  return { schemaVersion: OBSERVATORY_CLAIMS_SCHEMA_VERSION, checked: true, error: null, claims };
}

function emptyClaims({ error = null } = {}) {
  return { schemaVersion: OBSERVATORY_CLAIMS_SCHEMA_VERSION, checked: false, error, claims: [] };
}
