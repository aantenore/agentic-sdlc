import {
  computeStableHash,
  isPlainRecord,
} from "./canonical.mjs";
import {
  coordinationPolicy,
  parseSharedPayload,
  sealSharedPayload,
} from "./shared-ref-records.mjs";
import { deliveredOverlapPolicy } from "./delivered-overlap.mjs";
import { Date } from "./runtime/host.mjs";

/**
 * Story claims shared across computers. A claim file and its lock only
 * serialize processes on one checkout, so every claim is also created as a
 * ref on the project's git remote before the claim file is written:
 *
 *   refs/agentic-sdlc/claims/<story>/<epoch>/claim     who holds the story
 *   refs/agentic-sdlc/claims/<story>/<epoch>/release   when and how it ended
 *
 * Both refs are created only if they do not exist yet, so the remote is the
 * single arbiter: of two computers claiming the next epoch of one story at
 * the same time, exactly one push is accepted. A story is free when its
 * latest epoch has a release (or no epoch exists); claiming it again creates
 * the next epoch. This module holds the pure rules (policy, ref names,
 * payloads, interpretation); running git lives in the engine.
 */

export const CLAIM_SHARED_REF_ROOT = "refs/agentic-sdlc/claims";
export const CLAIM_SHARED_TRACKING_ROOT = "refs/agentic-sdlc-shared/claims";
// Per-worktree refs: git keeps refs/worktree/ apart for every worktree and never pushes or fetches them.
export const CLAIM_LOCAL_ROOT = "refs/worktree/agentic-sdlc/claims";
export const ORCHESTRATION_COORDINATION_SETTING = "orchestration_policy.coordination";
export const SHARED_RELEASE_STATUSES = Object.freeze(["released", "transferred", "cancelled", "taken_over", "closed"]);

const CLAIM_KIND = "story_claim_shared_claim";
const RELEASE_KIND = "story_claim_shared_release";
const PAYLOAD_VERSION = 1;
const EPOCH_DIGITS = 6;
const MAX_EPOCH = 999_999;
const STALE_MIN_SECONDS = 60;
const STALE_MAX_SECONDS = 31_536_000;
const RECORD_PATTERN = /^refs\/agentic-sdlc\/claims\/([^/]+)\/([0-9]{6})\/(claim|release)$/u;

export class OrchestrationPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = "OrchestrationPolicyError";
  }
}

function invalid(message) {
  throw new OrchestrationPolicyError(message);
}

/**
 * Effective orchestration policy. `coordination` decides whether claims are
 * shared through the git remote (auto, required, local_only);
 * `stale_claim_after_seconds` lists a claim as stale once it is that old,
 * even before it expires (null: only its expiry counts).
 */
export function orchestrationPolicy(config = {}) {
  const configured = isPlainRecord(config?.orchestration_policy) ? config.orchestration_policy : {};
  const coordination = coordinationPolicy(configured.coordination, { setting: ORCHESTRATION_COORDINATION_SETTING, invalid });
  const staleAfter = configured.stale_claim_after_seconds ?? null;
  if (staleAfter !== null
    && (!Number.isSafeInteger(staleAfter) || staleAfter < STALE_MIN_SECONDS || staleAfter > STALE_MAX_SECONDS)) {
    invalid(`orchestration_policy.stale_claim_after_seconds must be null or an integer from ${STALE_MIN_SECONDS} to ${STALE_MAX_SECONDS}.`);
  }
  return Object.freeze({
    coordination,
    stale_claim_after_seconds: staleAfter,
    delivered_overlap: deliveredOverlapPolicy(configured.delivered_overlap, invalid),
  });
}

/**
 * The ref folder of one story. Ids made of letters, digits, `-`, and `_` are
 * used as they are; any other id (a dot can form names git refuses) is
 * spelled safely and kept apart by a short hash of the exact id.
 */
export function claimNamespace(storyId) {
  const id = String(storyId);
  if (/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(id)) return id;
  return `${id.replace(/[^A-Za-z0-9_-]/gu, "_")}-${computeStableHash({ story_id: id }).slice(0, 12)}`;
}

export function claimEpochName(epoch) {
  return String(epoch).padStart(EPOCH_DIGITS, "0");
}

/** Path below the claims root that holds every record of one story. */
export function sharedClaimPrefix(storyId) {
  return `${claimNamespace(storyId)}/`;
}

export function sharedClaimRef(storyId, epoch) {
  return `${CLAIM_SHARED_REF_ROOT}/${claimNamespace(storyId)}/${claimEpochName(epoch)}/claim`;
}

export function sharedReleaseRef(storyId, epoch) {
  return `${CLAIM_SHARED_REF_ROOT}/${claimNamespace(storyId)}/${claimEpochName(epoch)}/release`;
}

/**
 * Records seen here are kept per remote (by its credential-free
 * fingerprint), so pointing the remote elsewhere starts a fresh view instead
 * of reporting every earlier record as gone.
 */
export function claimTrackingRoot(fingerprint) {
  return `${CLAIM_SHARED_TRACKING_ROOT}/${String(fingerprint || "unknown").slice(0, 16)}`;
}

/** Maps a shared record ref to the tracking ref that keeps it here. */
export function claimTrackingRef(ref, fingerprint) {
  return `${claimTrackingRoot(fingerprint)}/${ref.slice(CLAIM_SHARED_REF_ROOT.length + 1)}`;
}

/** Root of the claims this worktree made itself on one remote; never pushed, never fetched. */
export function claimOwnershipRoot(fingerprint) {
  return `${CLAIM_LOCAL_ROOT}/${String(fingerprint || "unknown").slice(0, 16)}`;
}

/**
 * The ref that holds this worktree's proof of a claim: a local record with a
 * random secret whose hash is the claim's `owner_proof`. It lives only in this
 * worktree's own refs (git never carries it to another clone or worktree),
 * unlike the claim file, which is committed and travels with the branch, and
 * it cannot be rebuilt from the public claim record.
 */
export function claimOwnershipRef(fingerprint, storyId, epoch) {
  return `${claimOwnershipRoot(fingerprint)}/${claimNamespace(storyId)}/${claimEpochName(epoch)}`;
}

/** Key of one claim in an ownership map: `<story folder>/<epoch>`. */
export function claimOwnershipKey(storyId, epoch) {
  return `${claimNamespace(storyId)}/${claimEpochName(epoch)}`;
}

/** Human name of one shared record, for messages. */
export function describeClaimRecord(ref) {
  const match = RECORD_PATTERN.exec(ref);
  if (!match) return `the shared record ${ref.split("/").slice(-3).join("/")}`;
  return `the shared ${match[3]} record ${Number(match[2])} of ${match[1]}`;
}

function actorRef(actor) {
  return actor ? { id: String(actor.id || "unknown"), type: String(actor.type || "unknown") } : null;
}

/** The claim record: who holds the story, for which approved work, on which branch, since when. */
export function buildSharedClaimPayload({
  storyId,
  epoch,
  claimantId,
  agent,
  branch,
  actor,
  contract = null,
  taskStart = null,
  claimedAt,
  expiresAt = null,
  takeoverOf = null,
  ownerProof = null,
}) {
  return sealSharedPayload({
    kind: CLAIM_KIND,
    version: PAYLOAD_VERSION,
    story_id: String(storyId),
    epoch,
    claimant_id: String(claimantId),
    agent: String(agent),
    branch: String(branch),
    actor: actorRef(actor),
    contract: contract ? { id: String(contract.id), approval_hash: contract.approval_hash ? String(contract.approval_hash) : null } : null,
    task_start: taskStart ? { id: taskStart.id ? String(taskStart.id) : null, hash: String(taskStart.hash) } : null,
    claimed_at: String(claimedAt),
    expires_at: expiresAt ? String(expiresAt) : null,
    takeover_of: takeoverOf,
    // Hash of a secret only the claiming worktree keeps: proves ownership without revealing it.
    owner_proof: ownerProof ? String(ownerProof) : null,
  });
}

/** The release record that ends one claim, so the story can be claimed again. */
export function buildSharedReleasePayload({
  storyId,
  epoch,
  claimantId,
  status,
  reason = null,
  releasedAt,
  agent = null,
  actor = null,
  takenOverBy = null,
}) {
  if (!SHARED_RELEASE_STATUSES.includes(status)) {
    throw new OrchestrationPolicyError(`A shared claim release status must be one of ${SHARED_RELEASE_STATUSES.join(", ")}.`);
  }
  return sealSharedPayload({
    kind: RELEASE_KIND,
    version: PAYLOAD_VERSION,
    story_id: String(storyId),
    epoch,
    claimant_id: String(claimantId),
    status,
    reason: reason ? String(reason) : null,
    released_at: String(releasedAt),
    released_by: { agent: agent ? String(agent) : null, actor: actorRef(actor) },
    taken_over_by: takenOverBy
      ? {
          claimant_id: String(takenOverBy.claimantId),
          agent: String(takenOverBy.agent),
          branch: String(takenOverBy.branch),
          actor: actorRef(takenOverBy.actor),
        }
      : null,
  });
}

function emptyStoryState(namespace, storyId = null) {
  return {
    namespace,
    story_id: storyId,
    epochs: [],
    latest: null,
    active: null,
    next_epoch: 1,
    problems: [],
    warnings: [],
  };
}

/**
 * Interprets shared claim records (`{ ref, message }` under their shared
 * names) and the problems found while reading them (`{ ref, message }`).
 * Returns `{ stories, problems }`: `stories` maps a story's ref folder to its
 * epochs, latest claim, active claim (or null), next epoch number, problems
 * that make its shared state untrustworthy, and warnings. `problems` lists
 * what cannot be attributed to any story.
 */
export function interpretSharedClaimRecords(records, { problems = [] } = {}) {
  const stories = new Map();
  const globalProblems = [];
  const stateFor = (namespace) => {
    if (!stories.has(namespace)) stories.set(namespace, emptyStoryState(namespace));
    return stories.get(namespace);
  };
  const entries = new Map();
  const entryFor = (namespace, epoch) => {
    const key = `${namespace}\u0000${epoch}`;
    if (!entries.has(key)) entries.set(key, { namespace, epoch, claim: null, release: null, unreadable: [] });
    return entries.get(key);
  };
  for (const { ref, message } of records) {
    const match = RECORD_PATTERN.exec(ref);
    if (!match) {
      const namespace = ref.startsWith(`${CLAIM_SHARED_REF_ROOT}/`) ? ref.slice(CLAIM_SHARED_REF_ROOT.length + 1).split("/")[0] : null;
      const text = `unexpected shared claim record ${ref.split("/").slice(-3).join("/")}`;
      if (namespace) stateFor(namespace).problems.push(text);
      else globalProblems.push(text);
      continue;
    }
    const [, namespace, epochText, recordKind] = match;
    const epoch = Number(epochText);
    const entry = entryFor(namespace, epoch);
    const state = stateFor(namespace);
    state.next_epoch = Math.max(state.next_epoch, epoch + 1);
    const payload = parseSharedPayload(message);
    const bound = payload
      && payload.version === PAYLOAD_VERSION
      && typeof payload.story_id === "string"
      && claimNamespace(payload.story_id) === namespace
      && payload.epoch === epoch;
    if (recordKind === "claim" && bound && payload.kind === CLAIM_KIND && payload.claimant_id) {
      entry.claim = payload;
    } else if (recordKind === "release" && bound && payload.kind === RELEASE_KIND && SHARED_RELEASE_STATUSES.includes(payload.status)) {
      entry.release = payload;
    } else {
      entry.unreadable.push(recordKind);
      state.problems.push(`the shared ${recordKind} record ${epoch} cannot be read`);
    }
  }
  for (const problem of problems) {
    const match = /^refs\/agentic-sdlc\/claims\/([^/]+)\//u.exec(problem.ref || "");
    if (match) stateFor(match[1]).problems.push(problem.message);
    else globalProblems.push(problem.message);
  }
  for (const entry of entries.values()) {
    const state = stateFor(entry.namespace);
    state.epochs.push(entry);
  }
  for (const state of stories.values()) {
    state.epochs.sort((left, right) => left.epoch - right.epoch);
    const storyIds = new Set(state.epochs.flatMap((entry) => [entry.claim?.story_id, entry.release?.story_id]).filter(Boolean));
    if (storyIds.size > 1) {
      state.problems.push(`the shared claim records of ${state.namespace} name different stories (${[...storyIds].sort().join(", ")})`);
    }
    state.story_id = [...storyIds][0] || null;
    for (const entry of state.epochs) {
      if (entry.release && !entry.claim && !entry.unreadable.includes("claim")) {
        state.problems.push(`the shared release record ${entry.epoch} has no claim record`);
      }
      if (entry.release && entry.claim && entry.release.claimant_id !== entry.claim.claimant_id) {
        state.problems.push(`the shared release record ${entry.epoch} belongs to another claim`);
      }
    }
    const claimed = state.epochs.filter((entry) => entry.claim);
    state.latest = claimed.at(-1) || null;
    state.active = state.latest && !state.latest.release && !state.latest.unreadable.includes("release")
      ? state.latest.claim
      : null;
    for (const entry of claimed.slice(0, -1)) {
      if (!entry.release) state.warnings.push(`claim ${entry.epoch} was never released before claim ${state.latest.epoch}`);
    }
    if (state.next_epoch > MAX_EPOCH) state.problems.push("the story has used every shared claim number");
  }
  return { stories, problems: globalProblems };
}

/** Shared claim state of one story within an interpretation (empty when it has no records). */
export function storySharedClaimState(interpreted, storyId) {
  const namespace = claimNamespace(storyId);
  return interpreted?.stories?.get(namespace) || emptyStoryState(namespace, String(storyId));
}

/**
 * True when a shared claim should be listed as stale: it expired, or it is
 * older than the configured age.
 */
export function sharedClaimIsStale(claim, { nowMs, staleAfterSeconds = null }) {
  if (!claim) return false;
  const expires = Date.parse(String(claim.expires_at || ""));
  if (Number.isFinite(expires) && expires < nowMs) return true;
  const claimed = Date.parse(String(claim.claimed_at || ""));
  return staleAfterSeconds !== null && Number.isFinite(claimed) && claimed + staleAfterSeconds * 1000 < nowMs;
}

/**
 * Text written by another computer, safe to show: control characters (which
 * could rewrite a terminal) are replaced and the length is bounded.
 */
export function plainSharedText(value, maxLength = 200) {
  if (value === null || value === undefined) return null;
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?").slice(0, maxLength);
}

function plainActor(actor) {
  return actor ? { id: plainSharedText(actor.id), type: plainSharedText(actor.type) } : null;
}

/** Plain view of who holds a shared claim. */
export function sharedClaimHolder(claim) {
  if (!claim) return null;
  return {
    epoch: claim.epoch,
    claimant_id: plainSharedText(claim.claimant_id),
    agent: plainSharedText(claim.agent),
    branch: plainSharedText(claim.branch),
    actor: plainActor(claim.actor),
    claimed_at: plainSharedText(claim.claimed_at),
    expires_at: plainSharedText(claim.expires_at),
  };
}

/** One line naming the holder of a shared claim, for messages. */
export function describeSharedHolder(claim) {
  const holder = sharedClaimHolder(claim);
  if (!holder) return "nobody";
  const actor = holder.actor?.id && holder.actor.id !== holder.agent ? ` (${holder.actor.type || "actor"} ${holder.actor.id})` : "";
  const expiry = holder.expires_at ? `, until ${holder.expires_at}` : "";
  return `${holder.agent}${actor} on branch ${holder.branch}, since ${holder.claimed_at}${expiry}`;
}

/**
 * What every computer sees about one story, next to this checkout's claim
 * file: `state` is free, claimed, stale, or untrustworthy; `holder` is the
 * active shared claim; `here` says whether this worktree made that claim
 * (`owned` maps `<story folder>/<epoch>` to `{ claimant_id, proof }` for each
 * claim made here, from refs git never carries to another clone or worktree). `ended_here` tells the holder of an active local claim that
 * the remote has ended it (for example a takeover, with who, when, and why);
 * `not_shared` flags an active local claim other computers cannot see.
 */
/**
 * True when this worktree's ownership record proves the shared claim:
 * same claimant id, and the hash of its secret is the claim's owner_proof.
 */
export function ownsClaimRecord(owned, namespace, claim) {
  if (!claim?.owner_proof) return false;
  const marker = owned?.get(`${namespace}/${claimEpochName(claim.epoch)}`);
  return Boolean(marker && marker.claimant_id === claim.claimant_id && marker.proof === claim.owner_proof);
}

export function sharedClaimView(state, localClaim, { nowMs, staleAfterSeconds = null, owned = new Map() }) {
  const recorded = localClaim?.shared_claim?.scope === "shared" ? localClaim.shared_claim : null;
  const localActive = String(localClaim?.status || "").toLowerCase() === "active";
  const active = state.active;
  // Only this worktree's ownership records say a claim was made here; the claim file travels with git.
  const here = Boolean(active && ownsClaimRecord(owned, state.namespace, active));
  const stale = sharedClaimIsStale(active, { nowMs, staleAfterSeconds });
  const view = {
    state: state.problems.length > 0 ? "untrustworthy" : active ? (stale ? "stale" : "claimed") : "free",
    holder: sharedClaimHolder(active),
    here,
    latest_epoch: state.latest?.epoch ?? null,
    problems: [...state.problems],
    warnings: [...state.warnings],
  };
  if (localActive && recorded && ownsClaimRecord(owned, state.namespace, { ...recorded, epoch: recorded.epoch })) {
    const own = state.epochs.find((entry) => entry.epoch === recorded.epoch);
    if (!own?.claim || own.claim.claimant_id !== recorded.claimant_id) {
      view.problems.push(`this computer's claim ${recorded.epoch} is not on the remote`);
      view.state = "untrustworthy";
    } else if (own.release) {
      const by = own.release.taken_over_by || own.release.released_by || null;
      view.ended_here = {
        status: own.release.status,
        released_at: plainSharedText(own.release.released_at),
        reason: plainSharedText(own.release.reason, 500),
        by: by ? { agent: plainSharedText(by.agent), branch: plainSharedText(by.branch), actor: plainActor(by.actor) } : null,
      };
    }
  }
  if (localActive && !recorded) view.not_shared = true;
  return view;
}
