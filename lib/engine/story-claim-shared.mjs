import {
  fail,
  failWithCode,
} from "../cli/user-error.mjs";
import {
  serializeSharedPayload,
} from "../shared-ref-records.mjs";
import {
  CLAIM_SHARED_REF_ROOT,
  CLAIM_SHARED_TRACKING_ROOT,
  ORCHESTRATION_COORDINATION_SETTING,
  buildSharedClaimPayload,
  buildSharedReleasePayload,
  claimTrackingRef,
  describeClaimRecord,
  describeSharedHolder,
  interpretSharedClaimRecords,
  orchestrationPolicy,
  plainSharedText,
  sharedClaimPrefix,
  sharedClaimRef,
  sharedClaimHolder,
  sharedReleaseRef,
  storySharedClaimState,
} from "../story-claim-shared-state.mjs";
import {
  knownUnreachableRemote,
  pushCreateOnlyRef,
  readSharedRefs,
  resolveSharedScope,
  writeRecordCommit,
} from "./shared-refs.mjs";

/**
 * Git side of story claims shared across computers (see
 * lib/story-claim-shared-state.mjs for the record layout). A claim is created
 * on the remote before the claim file is written, and refused when the remote
 * cannot be reached: claiming is the start of work, so it fails closed. A
 * release is written here first and then shared, so a failure to share it
 * only keeps the story reserved for everyone else a little longer.
 */

/** Effective orchestration policy of the project; an invalid setting stops the command. */
export function storyClaimPolicy(context) {
  try {
    return orchestrationPolicy(context.config);
  } catch (error) {
    fail(`The orchestration configuration is invalid: ${error.message}`);
  }
  return null;
}

/** Where claims are kept: `local`, or `shared` through the configured remote (possibly unavailable). */
export function resolveClaimScope(context, coordination) {
  return resolveSharedScope(context, coordination, ORCHESTRATION_COORDINATION_SETTING);
}

/**
 * Reads the shared claim records with one listing of the remote: of one
 * story, or of every story when `storyId` is null. Returns `{ scope: "local",
 * note }` when claims are not shared, `{ scope: "shared", remote, available:
 * false, error }` when the remote cannot be read, and otherwise the
 * interpretation (`stories`, `problems`) with `available: true`.
 */
export function readSharedClaims(context, policy, { storyId = null, target = null } = {}) {
  const scope = target || resolveClaimScope(context, policy.coordination);
  if (scope.scope !== "shared") return { scope: "local", note: scope.note };
  const base = { scope: "shared", remote: scope.remote, url: scope.url, fingerprint: scope.fingerprint };
  if (scope.unavailable) return { ...base, available: false, error: scope.unavailable };
  const unreachable = knownUnreachableRemote(context, scope.remote);
  if (unreachable !== null) return { ...base, available: false, error: unreachable };
  const read = readSharedRefs(context, {
    remote: scope.remote,
    sharedRoot: CLAIM_SHARED_REF_ROOT,
    trackingRoot: CLAIM_SHARED_TRACKING_ROOT,
    prefix: storyId ? sharedClaimPrefix(storyId) : "",
    timeoutSeconds: policy.coordination.timeout_seconds,
    describe: describeClaimRecord,
  });
  if (!read.available) return { ...base, available: false, error: read.error };
  return { ...base, available: true, error: null, ...interpretSharedClaimRecords(read.records, { problems: read.problems }) };
}

/**
 * Creates one claim or release record on the remote only if it does not
 * exist yet. Returns `{ published: true }`, `{ existing, state }` with the
 * record the remote holds there (re-read after the rejection, never assumed),
 * or `{ error }`.
 */
function publishRecord(context, policy, target, { storyId, epoch, ref, payload }) {
  const timeoutSeconds = policy.coordination.timeout_seconds;
  const commit = writeRecordCommit(context, timeoutSeconds, serializeSharedPayload(payload));
  if (commit.error) return { error: commit.error };
  const pushed = pushCreateOnlyRef(context, {
    url: target.url,
    ref,
    objectName: commit.objectName,
    trackingRef: claimTrackingRef(ref),
    timeoutSeconds,
  });
  if (pushed.pushed) return { published: true };
  if (pushed.timedOut) return { error: pushed.error };
  const read = readSharedClaims(context, policy, { storyId, target });
  if (!read.available) return { error: pushed.error };
  const state = storySharedClaimState(read, storyId);
  const entry = state.epochs.find((item) => item.epoch === epoch);
  const existing = ref.endsWith("/claim") ? entry?.claim : entry?.release;
  return existing ? { existing, state } : { error: pushed.error };
}

function unavailableGuidance(storyId, remote, reason) {
  return {
    en: {
      result: `Story ${storyId} was not assigned: the shared list of who works on what cannot be reached.`,
      impact: "Other computers could not see this assignment, so two of them could start the same work.",
      required_decision: "Wait until the git remote can be reached, or confirm this project is only worked on from this computer.",
      protection_boundary: "Nothing was written on this computer or on the remote.",
      next_action: `Retry when '${remote}' answers again. For single-computer use only, set orchestration_policy.coordination.mode to local_only.`,
      details: { remote, reason },
    },
    it: {
      result: `La story ${storyId} non è stata assegnata: l’elenco condiviso di chi lavora su cosa non è raggiungibile.`,
      impact: "Gli altri computer non vedrebbero questa assegnazione, quindi due di loro potrebbero iniziare lo stesso lavoro.",
      required_decision: "Attendi che il remote git sia raggiungibile, oppure conferma che il progetto si usa da un solo computer.",
      protection_boundary: "Non è stato scritto nulla né su questo computer né sul remote.",
      next_action: `Riprova quando '${remote}' risponde di nuovo. Solo per l’uso da un unico computer, imposta orchestration_policy.coordination.mode su local_only.`,
      details: { remote, reason },
    },
  };
}

function failUnavailable(storyId, remote, reason) {
  failWithCode(
    "STORY_CLAIM_REMOTE_UNAVAILABLE",
    [
      `Story ${storyId} was not claimed: claims are shared through the git remote '${remote}', and ${reason}.`,
      "Claiming is the start of work, so it waits until every computer can see the claim.",
      `Retry when the remote can be reached. If this project is only worked on from this computer, set ${ORCHESTRATION_COORDINATION_SETTING}.mode to local_only.`,
    ].join("\n"),
    unavailableGuidance(storyId, remote, reason),
  );
}

function heldGuidance(storyId, claim, remote) {
  const holder = sharedClaimHolder(claim);
  return {
    en: {
      result: `Story ${storyId} is already being worked on by ${holder.agent} on branch ${holder.branch}.`,
      impact: "Starting it here too would make two people or agents change the same work.",
      required_decision: "Pick another available story, or agree with the current holder that they release it.",
      protection_boundary: "Nothing was written on this computer or on the remote.",
      next_action: "Run orchestrate status to see free stories. Only a person may take the story over, with --force and --reason.",
      details: { remote, holder },
    },
    it: {
      result: `Sulla story ${storyId} sta già lavorando ${holder.agent} sul branch ${holder.branch}.`,
      impact: "Avviarla anche qui farebbe modificare lo stesso lavoro a due persone o agenti.",
      required_decision: "Scegli un’altra story disponibile, oppure concorda con chi la detiene che la rilasci.",
      protection_boundary: "Non è stato scritto nulla né su questo computer né sul remote.",
      next_action: "Esegui orchestrate status per vedere le story libere. Solo una persona può subentrare, con --force e --reason.",
      details: { remote, holder },
    },
  };
}

function failHeld(storyId, holder, remote, { concurrent = false } = {}) {
  failWithCode(
    "STORY_CLAIM_HELD_ELSEWHERE",
    [
      `Story ${storyId} is ${concurrent ? "claimed at the same moment from another computer" : "already claimed"} `
        + `(recorded on the git remote '${remote}'): ${describeSharedHolder(holder)}.`,
      "Ask the holder to release it (story release), or pick another available story (orchestrate status).",
      `Taking it over needs a person: story claim --id ${storyId} --agent <agent> --force --reason "<why>" --actor-type human, run in their own terminal.`,
    ].join("\n"),
    heldGuidance(storyId, holder, remote),
  );
}

function failUntrustworthy(storyId, remote, problems) {
  failWithCode(
    "STORY_CLAIM_SHARED_RECORDS_INVALID",
    [
      `Story ${storyId} was not claimed: its shared claim records on the git remote '${remote}' cannot be trusted.`,
      ...problems.map((problem) => `- ${problem}`),
      "Shared claim records are only ever added by agentic-sdlc; restore the remote's refs/agentic-sdlc/claims refs before claiming.",
    ].join("\n"),
  );
}

/**
 * Claims a story on the shared remote before anything is written here.
 * `newClaimantId()` names the new claim. Returns `{ scope: "local", note }` when claims are not shared, and
 * otherwise `{ scope: "shared", record, takeover, pending_release_shared }`
 * where `record` is what the claim file keeps. Refuses (user error) when the
 * remote cannot be used, when its records cannot be trusted, and when
 * someone else holds the story, unless `force` and `authorizeTakeover`
 * accept a takeover; `authorizeTakeover(holder)` throws when it is not
 * allowed and returns `{ reason }` otherwise.
 */
export function acquireSharedStoryClaim(context, {
  storyId,
  newClaimantId,
  agent,
  branch,
  actor,
  contract = null,
  taskStart = null,
  claimedAt,
  expiresAt = null,
  force = false,
  localClaim = null,
  authorizeTakeover,
}) {
  const policy = storyClaimPolicy(context);
  const target = resolveClaimScope(context, policy.coordination);
  if (target.scope !== "shared") return { scope: "local", note: target.note };
  if (target.unavailable) failUnavailable(storyId, target.remote, target.unavailable);
  // One id per claim, independent of the computer, so the claim file can name it from anywhere.
  const claimantId = newClaimantId();
  const readState = () => {
    const read = readSharedClaims(context, policy, { storyId, target });
    if (!read.available) failUnavailable(storyId, target.remote, read.error);
    const state = storySharedClaimState(read, storyId);
    if (state.problems.length > 0) failUntrustworthy(storyId, target.remote, state.problems);
    return state;
  };
  let state = readState();
  let takeover = null;
  let pendingReleaseShared = false;
  const recorded = localClaim?.shared_claim?.scope === "shared" ? localClaim.shared_claim : null;
  if (state.active) {
    const active = state.active;
    const ownRecord = recorded && recorded.claimant_id === active.claimant_id && recorded.epoch === active.epoch;
    if (ownRecord && String(localClaim.status || "").toLowerCase() !== "active") {
      // Released on this computer while the remote could not be reached: share that release first.
      const shared = publishRecord(context, policy, target, {
        storyId,
        epoch: active.epoch,
        ref: sharedReleaseRef(storyId, active.epoch),
        payload: buildSharedReleasePayload({
          storyId,
          epoch: active.epoch,
          claimantId: active.claimant_id,
          status: sharedReleaseStatus(localClaim.status),
          reason: localClaim.release_reason || null,
          releasedAt: localClaim.released_at || claimedAt,
          agent: localClaim.agent,
          actor: localClaim.audit?.released_by || actor,
        }),
      });
      if (shared.error) failUnavailable(storyId, target.remote, shared.error);
      pendingReleaseShared = true;
    } else if (!force) {
      failHeld(storyId, active, target.remote);
    } else {
      const decision = authorizeTakeover(active, { ownRecord: Boolean(ownRecord) });
      // The holder as shown and recorded here: text from another computer is made safe first.
      takeover = { holder: sharedClaimHolder(active), reason: decision?.reason || null };
      const released = publishRecord(context, policy, target, {
        storyId,
        epoch: active.epoch,
        ref: sharedReleaseRef(storyId, active.epoch),
        payload: buildSharedReleasePayload({
          storyId,
          epoch: active.epoch,
          claimantId: active.claimant_id,
          status: "taken_over",
          reason: takeover.reason,
          releasedAt: claimedAt,
          agent,
          actor,
          takenOverBy: { claimantId, agent, branch, actor },
        }),
      });
      if (released.error) failUnavailable(storyId, target.remote, released.error);
    }
    state = readState();
    if (state.active) failHeld(storyId, state.active, target.remote, { concurrent: true });
  }
  const epoch = state.next_epoch;
  const ref = sharedClaimRef(storyId, epoch);
  const published = publishRecord(context, policy, target, {
    storyId,
    epoch,
    ref,
    payload: buildSharedClaimPayload({
      storyId,
      epoch,
      claimantId,
      agent,
      branch,
      actor,
      contract,
      taskStart,
      claimedAt,
      expiresAt,
      takeoverOf: takeover ? takeover.holder.epoch : null,
    }),
  });
  if (published.existing && published.existing.claimant_id !== claimantId) {
    failHeld(storyId, published.existing, target.remote, { concurrent: true });
  }
  if (published.error) failUnavailable(storyId, target.remote, published.error);
  return {
    scope: "shared",
    remote: target.remote,
    record: {
      scope: "shared",
      remote: target.remote,
      remote_fingerprint: target.fingerprint,
      ref,
      epoch,
      claimant_id: claimantId,
      ...(takeover
        ? {
            takeover_of: {
              epoch: takeover.holder.epoch,
              claimant_id: takeover.holder.claimant_id,
              agent: takeover.holder.agent,
              branch: takeover.holder.branch,
              actor: takeover.holder.actor || null,
              claimed_at: takeover.holder.claimed_at,
              reason: takeover.reason,
            },
          }
        : {}),
    },
    takeover,
    pending_release_shared: pendingReleaseShared,
  };
}

/** The release status recorded on the remote for a claim file status. */
export function sharedReleaseStatus(claimStatus) {
  const status = String(claimStatus || "").toLowerCase();
  return ["released", "transferred", "cancelled"].includes(status) ? status : "released";
}

/**
 * Shares the release of a claim that was recorded on the remote. Returns
 * null when the claim was never shared, otherwise `{ status, remote, ... }`:
 * `shared`; `already_shared`; `taken_over` (someone else had already taken
 * the story over, with who, when, and why); or `not_shared` with the reason,
 * in which case running `story release` again shares it later.
 */
export function shareStoryClaimRelease(context, { claim, status, reason = null, releasedAt, agent = null, actor = null }) {
  const record = claim?.shared_claim;
  if (!record || record.scope !== "shared" || !record.claimant_id || !Number.isSafeInteger(record.epoch)) return null;
  const storyId = claim.story_id;
  const policy = storyClaimPolicy(context);
  const notShared = (error) => ({ status: "not_shared", remote: record.remote, error });
  if (policy.coordination.mode === "local_only") {
    return notShared(`sharing is turned off (${ORCHESTRATION_COORDINATION_SETTING}.mode is local_only)`);
  }
  const target = resolveClaimScope(context, { ...policy.coordination, remote: record.remote, mode: "required" });
  if (target.unavailable || !target.url) return notShared(target.unavailable || `the git remote '${record.remote}' is not configured`);
  if (record.remote_fingerprint && target.fingerprint !== record.remote_fingerprint) {
    return notShared(`the git remote '${record.remote}' is not the one this claim was made on`);
  }
  const unreachable = knownUnreachableRemote(context, target.remote);
  if (unreachable !== null) return notShared(unreachable);
  const result = publishRecord(context, policy, target, {
    storyId,
    epoch: record.epoch,
    ref: sharedReleaseRef(storyId, record.epoch),
    payload: buildSharedReleasePayload({
      storyId,
      epoch: record.epoch,
      claimantId: record.claimant_id,
      status,
      reason,
      releasedAt,
      agent,
      actor,
    }),
  });
  if (result.published) return { status: "shared", remote: record.remote, epoch: record.epoch };
  if (result.existing) {
    if (result.existing.claimant_id !== record.claimant_id) {
      return notShared(`the remote holds another claim's release under claim ${record.epoch}`);
    }
    if (result.existing.status === "taken_over") {
      const by = result.existing.taken_over_by;
      return {
        status: "taken_over",
        remote: record.remote,
        epoch: record.epoch,
        taken_over_by: by
          ? { agent: plainSharedText(by.agent), branch: plainSharedText(by.branch), actor: by.actor ? { id: plainSharedText(by.actor.id), type: plainSharedText(by.actor.type) } : null }
          : null,
        released_at: plainSharedText(result.existing.released_at),
        reason: plainSharedText(result.existing.reason, 500),
      };
    }
    return { status: "already_shared", remote: record.remote, epoch: record.epoch };
  }
  return notShared(result.error);
}

/** Human line about a shared release result, or null when nothing was shared. */
export function sharedReleaseLine(storyId, sharedRelease) {
  if (!sharedRelease) return null;
  switch (sharedRelease.status) {
    case "shared":
    case "already_shared":
      return `Release shared through '${sharedRelease.remote}': other computers can claim story ${storyId} now.`;
    case "taken_over":
      return `Story ${storyId} had already been taken over by ${sharedRelease.taken_over_by?.agent || "someone else"} `
        + `on branch ${sharedRelease.taken_over_by?.branch || "unknown"} at ${sharedRelease.released_at}`
        + `${sharedRelease.reason ? ` (${sharedRelease.reason})` : ""}.`;
    default:
      return `Release NOT shared through '${sharedRelease.remote}' (${sharedRelease.error}); other computers still see story ${storyId} as claimed. `
        + `Run story release --id ${storyId} again when the remote can be reached.`;
  }
}

/**
 * Claims of every story as all computers see them, read with one listing of
 * the remote, for orchestrate status and status. Never refuses: an
 * unreachable remote is reported with `checked: false`.
 */
export function sharedClaimsOverview(context) {
  const policy = storyClaimPolicy(context);
  const base = { stale_claim_after_seconds: policy.stale_claim_after_seconds };
  const read = readSharedClaims(context, policy);
  if (read.scope !== "shared") return { ...base, scope: "local", remote: null, checked: false, note: read.note, interpreted: null };
  if (!read.available) return { ...base, scope: "shared", remote: read.remote, checked: false, error: read.error, interpreted: null };
  return { ...base, scope: "shared", remote: read.remote, checked: true, error: null, problems: read.problems, interpreted: read };
}
