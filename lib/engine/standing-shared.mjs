import {
  buildSharedRevocationPayload,
  buildSharedSlotPayload,
  interpretSharedRefs,
  serializeSharedPayload,
  standingSharedRevocationRef,
  standingSharedSlotRef,
  standingSharedTrackingPrefix,
  STANDING_SHARED_REF_ROOT,
  STANDING_SHARED_TRACKING_ROOT,
  standingSharedNamespace,
} from "../standing-shared-state.mjs";
import {
  createLocalRef,
  forgetSharedRefState,
  isGitRepository,
  knownUnreachableRemote,
  listLocalRefs,
  pushCreateOnlyRef,
  readSharedRefs,
  resolveSharedScope,
  writeRecordCommit,
} from "./shared-refs.mjs";

export { remoteFingerprint } from "./shared-refs.mjs";

/**
 * Standing-approval side of the shared coordination records: used delivery
 * slots and revocations under refs/agentic-sdlc/standing/. Running git, the
 * remote checks, and the never-forget tracking refs live in shared-refs.mjs;
 * failures come back as data so the caller can fall back to the normal
 * confirmation.
 *
 * Shared records are only ever added: fetched records stay in local tracking
 * refs (never pruned or overwritten), so a revocation or a used slot seen once
 * is never forgotten, and a record that later disappears from or changes on
 * the remote makes the shared state untrustworthy.
 */

const COORDINATION_SETTING = "standing_approval_policy.coordination";
const fetchedState = new Map();

/** Forgets everything learned in this process, so the next read asks git again. */
export function forgetSharedStandingState() {
  forgetSharedRefState();
  fetchedState.clear();
}

/**
 * Where this project shares standing-approval state: `local` when sharing is
 * off or (in auto mode) no remote is configured; otherwise `shared`, possibly
 * with `unavailable` when the remote cannot be used.
 */
export function resolveStandingScope(context, coordination) {
  return resolveSharedScope(context, coordination, COORDINATION_SETTING);
}

/** The sharing scope recorded on a standing approval when it is proposed. */
export function standingCoordinationRecord(context, coordination) {
  const scope = resolveStandingScope(context, coordination);
  return scope.scope === "shared" && !scope.unavailable
    ? { scope: "shared", remote: scope.remote, remote_fingerprint: scope.fingerprint }
    : { scope: "local", remote: null, remote_fingerprint: null };
}

/** Records kept only in this repository: a revocation survives a deleted or cleaned record file. */
const LOCAL_REF_ROOT = "refs/agentic-sdlc-local/standing";

function localRevocationRef(proposal) {
  return `${LOCAL_REF_ROOT}/${standingSharedNamespace(proposal)}/revoked`;
}

function localPrefix(proposal) {
  return `${LOCAL_REF_ROOT}/${standingSharedNamespace(proposal)}/`;
}

/**
 * What this repository remembers on its own, whatever the sharing scope: its
 * revocation and used slots (so deleting or cleaning record files undoes
 * neither), and whether shared records were ever seen.
 */
function readLocalRecords(context, proposal, timeoutSeconds) {
  if (isGitRepository(context, timeoutSeconds) === false) {
    return { localRevoked: null, localSlots: [], localErrors: [], seenShared: false };
  }
  const listed = listLocalRefs(context, [localPrefix(proposal), standingSharedTrackingPrefix(proposal)], timeoutSeconds);
  if (listed.error) return { error: listed.error, localRevoked: null, localSlots: [], seenShared: false };
  const refs = listed.refs;
  const local = refs.filter((item) => item.trackingRef.startsWith(localPrefix(proposal)));
  const sharedPrefix = `${STANDING_SHARED_REF_ROOT}/${standingSharedNamespace(proposal)}/`;
  const interpreted = interpretSharedRefs(proposal, local.map((item) => ({
    ref: `${sharedPrefix}${item.trackingRef.slice(localPrefix(proposal).length)}`,
    message: item.message,
  })));
  const hasLocalRevocation = local.some((item) => item.trackingRef === localRevocationRef(proposal));
  return {
    localRevoked: hasLocalRevocation ? (interpreted.revoked || { reason: "the local revocation record cannot be read" }) : null,
    localSlots: interpreted.slots,
    localErrors: interpreted.errors,
    seenShared: refs.some((item) => !item.trackingRef.startsWith(localPrefix(proposal))),
  };
}

function sharedRecordLabel(ref) {
  const slot = /\/slots\/([0-9]{4})$/u.exec(ref);
  return slot ? `slot ${Number(slot[1])}` : "the revocation";
}

/**
 * Reads the shared refs of one standing approval: one listing of the remote,
 * one fetch when it holds records not seen here yet, and one local listing.
 * The result is cached for the rest of this command; publishing clears it.
 */
export function readSharedStandingState(context, proposal, coordination) {
  const target = resolveStandingScope(context, coordination);
  const recorded = proposal.coordination || null;
  const local = readLocalRecords(context, proposal, coordination.timeout_seconds);
  const localRevoked = local.localRevoked || null;
  const localSlots = local.localSlots || [];
  if (target.scope !== "shared") {
    const sharedBefore = (recorded?.scope === "shared" || local.seenShared) && coordination.mode !== "local_only";
    if (sharedBefore || local.error) {
      return {
        scope: "shared",
        remote: recorded?.remote || coordination.remote,
        available: false,
        error: local.error || `shared records were used for it, but the git remote '${coordination.remote}' is no longer configured`,
        slots: [],
        revoked: null,
        localRevoked,
        localSlots,
        errors: [],
      };
    }
    return { ...target, localRevoked, localSlots };
  }
  const base = { scope: "shared", remote: target.remote, slots: [], revoked: null, localRevoked, localSlots, errors: [] };
  if (target.unavailable) return { ...base, available: false, error: target.unavailable };
  if (recorded?.scope === "shared" && recorded.remote_fingerprint && recorded.remote_fingerprint !== target.fingerprint) {
    return { ...base, available: false, error: `the git remote '${target.remote}' is not the one this standing approval was approved with` };
  }
  const unreachable = knownUnreachableRemote(context, target.remote);
  if (unreachable !== null) return { ...base, available: false, error: unreachable };
  const key = `${context.root}\u0000${target.remote}\u0000${proposal.id}\u0000${proposal.record_hash}`;
  if (fetchedState.has(key)) return fetchedState.get(key);
  const read = readSharedRefs(context, {
    remote: target.remote,
    sharedRoot: STANDING_SHARED_REF_ROOT,
    trackingRoot: STANDING_SHARED_TRACKING_ROOT,
    prefix: `${standingSharedNamespace(proposal)}/`,
    timeoutSeconds: coordination.timeout_seconds,
    describe: sharedRecordLabel,
  });
  if (!read.available) return { ...base, available: false, error: read.error };
  const interpreted = interpretSharedRefs(proposal, read.records);
  const state = {
    ...base,
    available: true,
    error: null,
    slots: interpreted.slots,
    revoked: interpreted.revoked,
    errors: [...read.problems.map((problem) => problem.message), ...interpreted.errors],
  };
  fetchedState.set(key, state);
  return state;
}

/** Writes one payload as a parentless commit with an empty tree and returns its object name. */
function payloadCommit(context, timeoutSeconds, payload) {
  return writeRecordCommit(context, timeoutSeconds, serializeSharedPayload(payload));
}

/**
 * Creates one shared ref only if it does not exist on the remote yet. Returns
 * `{ published: true }`; `{ existing }` with the record the remote already
 * holds there (re-read after the rejection, never assumed); or `{ error }`.
 */
function publishSharedRef(context, coordination, remote, proposal, ref, payload) {
  const timeoutSeconds = coordination.timeout_seconds;
  const target = resolveStandingScope(context, { ...coordination, remote, mode: "required" });
  if (target.unavailable || !target.url) return { error: target.unavailable || `the git remote '${remote}' is not configured` };
  const commit = payloadCommit(context, timeoutSeconds, payload);
  if (commit.error) return { error: commit.error };
  const pushed = pushCreateOnlyRef(context, {
    url: target.url,
    ref,
    objectName: commit.objectName,
    // Our own record is kept as seen, so it is checked like any other shared record.
    trackingRef: `${STANDING_SHARED_TRACKING_ROOT}/${ref.slice(STANDING_SHARED_REF_ROOT.length + 1)}`,
    timeoutSeconds,
  });
  fetchedState.clear();
  if (pushed.pushed) return { published: true };
  if (pushed.timedOut) return { error: pushed.error };
  const state = readSharedStandingState(context, proposal, { ...coordination, remote, mode: "required" });
  if (!state.available) return { error: pushed.error };
  const existing = ref.endsWith("/revoked")
    ? state.revoked
    : state.slots.find((slot) => standingSharedSlotRef(proposal, slot.slot) === ref) || null;
  return existing ? { existing } : { error: pushed.error };
}

/**
 * Claims one slot on the remote for this exact delivery profile. A slot the
 * remote already holds for the same delivery profile counts as claimed.
 */
export function claimSharedStandingSlot(context, coordination, remote, { proposal, slot, delivery, profileRef }) {
  const result = publishSharedRef(
    context,
    coordination,
    remote,
    proposal,
    standingSharedSlotRef(proposal, slot),
    buildSharedSlotPayload({ proposal, slot, delivery, profileRef }),
  );
  if (!result.existing) return result;
  const same = result.existing.delivery?.id === delivery.id
    && result.existing.delivery?.kind === delivery.kind
    && result.existing.profile_ref?.id === profileRef.id
    && result.existing.profile_ref?.hash === profileRef.hash;
  return same ? { published: true, already: true } : { conflict: true, holder: result.existing };
}

/**
 * Keeps a revocation in this repository's own refs, whatever the sharing
 * scope, so deleting or cleaning the revocation file does not undo it.
 */
export function recordLocalStandingRevocation(context, coordination, { proposal, revocation }) {
  const commit = payloadCommit(context, coordination.timeout_seconds, buildSharedRevocationPayload({ proposal, revocation }));
  if (commit.error) return { error: commit.error };
  createLocalRef(context, localRevocationRef(proposal), commit.objectName, coordination.timeout_seconds);
  fetchedState.clear();
  return { recorded: true };
}

/** Keeps a used slot in this repository's own refs, whatever the sharing scope. */
export function recordLocalStandingSlot(context, coordination, { proposal, slot, delivery, profileRef }) {
  const commit = payloadCommit(context, coordination.timeout_seconds, buildSharedSlotPayload({ proposal, slot, delivery, profileRef }));
  if (commit.error) return { error: commit.error };
  const ref = `${localPrefix(proposal)}slots/${String(slot).padStart(4, "0")}`;
  const updated = createLocalRef(context, ref, commit.objectName, coordination.timeout_seconds);
  fetchedState.clear();
  return updated.created ? { recorded: true } : { error: updated.error };
}

/** Publishes a revocation; a valid shared revocation already on the remote counts as published. */
export function publishSharedStandingRevocation(context, coordination, remote, { proposal, revocation }) {
  const result = publishSharedRef(
    context,
    coordination,
    remote,
    proposal,
    standingSharedRevocationRef(proposal),
    buildSharedRevocationPayload({ proposal, revocation }),
  );
  return result.existing ? { published: true, already: true } : result;
}
