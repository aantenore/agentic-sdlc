import {
  CLAIM_SHARED_REF_ROOT,
  CLAIM_SHARED_TRACKING_ROOT,
  holderIdentityText,
  interpretSharedClaimRecords,
  plainSharedText,
  sharedClaimHolder,
} from "../story-claim-shared-state.mjs";
import {
  DEFAULT_IDLE_AFTER_SECONDS,
  WAIT_SHARED_REF_ROOT,
  WAIT_SHARED_TRACKING_ROOT,
  classifyClaimHealth,
  claimLeaseEndMs,
  currentWaitRecord,
  evaluateWait,
  interpretSharedWaitRecords,
  sharedWaitRecordsOf,
} from "../story-wait-shared-state.mjs";
import { listLocalRefs, runGit } from "../engine/shared-refs.mjs";

export const OBSERVATORY_CLAIMS_SCHEMA_VERSION = "change-observatory:claims:v1";
const DEFAULT_TIMEOUT_SECONDS = 5;
const DEFAULT_TTL_SECONDS = 86_400;

/**
 * Shared story claims as this clone last saw them on the remote. Only the
 * local copies kept by `status`, `story claim`, and the other claim commands
 * are read: no network access and no write, so opening the Observatory never
 * waits for the remote. `checked` is false when there is nothing to read.
 */
export function readTrackedSharedClaims(projectRoot, {
  timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  listRefs = listLocalRefs,
  lastCommits = null,
  nowMs = Date.now(),
  ttlSeconds = DEFAULT_TTL_SECONDS,
  idleAfterSeconds = DEFAULT_IDLE_AFTER_SECONDS,
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
  const [remoteKey, records] = [...byRemote.entries()].sort((left, right) => right[1].length - left[1].length)[0];
  const interpreted = interpretSharedClaimRecords(records);
  const waits = readTrackedWaits(projectRoot, remoteKey, listRefs, timeoutSeconds);
  const activity = lastCommits ?? branchCommitTimes(projectRoot, timeoutSeconds);
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
        // Active, waiting (a declared wait holds), idle (no recent push), or abandoned (a person decides).
        ...(holder.reservation ? {} : claimHealthOf(state, holder, waits, activity, { nowMs, ttlSeconds, idleAfterSeconds })),
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

/** The declared waits this clone last saw on the same remote, by story folder. */
function readTrackedWaits(projectRoot, remoteKey, listRefs, timeoutSeconds) {
  const root = `${WAIT_SHARED_TRACKING_ROOT}/${remoteKey}/`;
  const listed = listRefs({ root: projectRoot }, [root], timeoutSeconds);
  if (listed.error) return new Map();
  return interpretSharedWaitRecords((listed.refs ?? []).map((item) => ({
    ref: `${WAIT_SHARED_REF_ROOT}/${String(item.trackingRef ?? "").slice(root.length)}`,
    message: item.message,
  })));
}

/** Last commit time (ms) of each branch here and as fetched from any remote, read once; `(branch) => ms | null`. */
function branchCommitTimes(projectRoot, timeoutSeconds) {
  let times = null;
  return (branch) => {
    if (!branch || ["main", "master", "trunk", "develop"].includes(branch)) return null;
    if (times === null) {
      times = new Map();
      const listed = runGit(projectRoot, ["for-each-ref", "--format=%(refname)%00%(committerdate:iso-strict)", "refs/heads/", "refs/remotes/"], { timeoutSeconds });
      for (const line of listed.ok ? listed.stdout.split(/\r?\n/u) : []) {
        const [ref, date] = line.split("\u0000");
        const ms = Date.parse(String(date || ""));
        if (!ref || !Number.isFinite(ms)) continue;
        const short = ref.startsWith("refs/heads/") ? ref.slice(11) : ref.split("/").slice(3).join("/");
        times.set(short, Math.max(times.get(short) ?? -Infinity, ms));
      }
    }
    return times.get(branch) ?? null;
  };
}

function claimHealthOf(state, holder, waits, activity, { nowMs, ttlSeconds, idleAfterSeconds }) {
  const lastActivityMs = activity(holder.branch);
  const leaseEndMs = claimLeaseEndMs({ expiresAt: holder.expires_at, claimedAt: holder.claimed_at, lastActivityMs, ttlSeconds });
  const wait = evaluateWait(currentWaitRecord({
    shared: sharedWaitRecordsOf(waits, state.story_id),
    claim: { epoch: holder.epoch, claimant_id: holder.claimant_id, claimed_at: holder.claimed_at },
  }), { nowMs });
  const health = classifyClaimHealth({ claimedAt: holder.claimed_at, leaseEndMs, lastActivityMs, wait, idleAfterSeconds, nowMs });
  return {
    health,
    lastActivityAt: Number.isFinite(lastActivityMs) ? new Date(lastActivityMs).toISOString() : null,
    ...(health === "waiting" ? { wait: { kind: wait.kind, target: wait.target, since: wait.since, until: wait.until } } : {}),
  };
}

function emptyClaims({ error = null } = {}) {
  return { schemaVersion: OBSERVATORY_CLAIMS_SCHEMA_VERSION, checked: false, error, claims: [] };
}
