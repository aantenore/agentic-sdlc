import path from "node:path";
import {
  runsInsideAgentHost,
} from "../agent-host.mjs";
import {
  fail,
  failWithCode,
} from "../cli/user-error.mjs";
import {
  getOptionString,
  requireCoordinationOverrideActor,
} from "../lifecycle/common.mjs";
import {
  crypto,
} from "../runtime/host.mjs";
import {
  parseSharedPayload,
  sealSharedPayload,
  serializeSharedPayload,
} from "../shared-ref-records.mjs";
import {
  CLAIM_SHARED_REF_ROOT,
  ORCHESTRATION_COORDINATION_SETTING,
  buildSharedClaimPayload,
  buildSharedReleasePayload,
  CLAIM_LOCAL_ROOT,
  claimNamespace,
  claimOwnershipKey,
  claimOwnershipRef,
  claimOwnershipRoot,
  ownsClaimRecord,
  claimTrackingRef,
  claimTrackingRoot,
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
  deleteLocalRef,
  isGitRepository,
  knownUnreachableRemote,
  listLocalRefs,
  pushCreateOnlyRef,
  readSharedRefs,
  remoteRefObject,
  resolveSharedScope,
  runGit,
  setLocalRef,
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
    // Kept per remote: pointing the remote elsewhere starts a fresh view, it does not report records as gone.
    trackingRoot: claimTrackingRoot(scope.fingerprint),
    prefix: storyId ? sharedClaimPrefix(storyId) : "",
    timeoutSeconds: policy.coordination.timeout_seconds,
    describe: describeClaimRecord,
  });
  if (!read.available) return { ...base, available: false, error: read.error };
  return { ...base, available: true, error: null, ...interpretSharedClaimRecords(read.records, { problems: read.problems }) };
}

const OWNERSHIP_KIND = "story_claim_ownership";

function proofOf(secret) {
  return crypto.createHash("sha256").update(String(secret), "utf8").digest("hex");
}

/**
 * True when git keeps refs/worktree/ apart for this worktree. Every main
 * worktree has its own; a linked worktree needs a git that knows per-worktree
 * refs, otherwise its ownership records would be visible to the others.
 */
function perWorktreeRefsSupported(context, timeoutSeconds) {
  // Without --path-format (newer git only), paths come relative to the project folder.
  const probe = runGit(context.root, [
    "rev-parse", "--git-dir", "--git-common-dir", "--git-path", `${CLAIM_LOCAL_ROOT}/probe`,
  ], { timeoutSeconds });
  if (!probe.ok) return false;
  const [gitDir, commonDir, probePath] = probe.stdout.split(/\r?\n/u).map((line) => line.trim());
  if (!gitDir || !commonDir || !probePath) return false;
  const normalize = (value) => path.resolve(context.root, value).replace(/\\/gu, "/").replace(/\/+$/u, "");
  if (normalize(gitDir) === normalize(commonDir)) return true;
  return normalize(probePath).startsWith(`${normalize(gitDir)}/`);
}

/**
 * The claims this worktree made itself on one remote, as a map from
 * `<story folder>/<epoch>` to `{ claimant_id, proof, state }`, where `proof`
 * is the hash of the secret kept in the ownership record and `state` is
 * `pending` (written before the push) or `confirmed` (after the claim file
 * was recorded). Read from per-worktree refs git never pushes or fetches; a
 * record without its secret (for example a public claim record copied there)
 * proves nothing.
 */
export function ownedSharedClaims(context, fingerprint, timeoutSeconds) {
  const owned = new Map();
  if (!fingerprint || isGitRepository(context, timeoutSeconds) !== true) return owned;
  const root = `${claimOwnershipRoot(fingerprint)}/`;
  const listed = listLocalRefs(context, [root], timeoutSeconds);
  for (const item of listed.refs || []) {
    const marker = parseSharedPayload(item.message);
    if (marker?.kind !== OWNERSHIP_KIND || !marker.claimant_id || typeof marker.secret !== "string" || marker.secret.length < 32) continue;
    owned.set(item.trackingRef.slice(root.length), {
      claimant_id: marker.claimant_id,
      proof: proofOf(marker.secret),
      state: marker.state === "confirmed" ? "confirmed" : "pending",
    });
  }
  return owned;
}

function writeOwnershipRecord(context, fingerprint, { storyId, epoch, claimantId, secret, state }, timeoutSeconds) {
  const commit = writeRecordCommit(context, timeoutSeconds, serializeSharedPayload(sealSharedPayload({
    kind: OWNERSHIP_KIND,
    version: 1,
    story_id: String(storyId),
    epoch,
    claimant_id: claimantId,
    secret,
    state,
  })));
  if (commit.error) return { error: commit.error };
  return setLocalRef(context, claimOwnershipRef(fingerprint, storyId, epoch), commit.objectName, timeoutSeconds);
}

function readOwnershipSecret(context, fingerprint, storyId, epoch, timeoutSeconds) {
  const listed = listLocalRefs(context, [claimOwnershipRef(fingerprint, storyId, epoch)], timeoutSeconds);
  const marker = parseSharedPayload(listed.refs?.[0]?.message);
  return marker?.kind === OWNERSHIP_KIND ? marker : null;
}

/** True when this worktree made the shared claim a claim file records (its secret matches the claim's proof). */
export function ownsSharedClaim(context, record, timeoutSeconds) {
  if (!record?.remote_fingerprint || !Number.isSafeInteger(record.epoch)) return false;
  const match = /^refs\/agentic-sdlc\/claims\/([^/]+)\/[0-9]{6}\/claim$/u.exec(String(record.ref || ""));
  if (!match) return false;
  return ownsClaimRecord(ownedSharedClaims(context, record.remote_fingerprint, timeoutSeconds), match[1], record);
}

/**
 * Marks this worktree's ownership record of a claim as confirmed once the
 * claim file is written: from then on a missing or different claim file means
 * the claim is held, never an interrupted attempt to clean up.
 */
export function confirmSharedClaimOwnership(context, claim) {
  const record = claim?.shared_claim;
  if (record?.scope !== "shared") return null;
  const timeoutSeconds = storyClaimPolicy(context).coordination.timeout_seconds;
  const marker = readOwnershipSecret(context, record.remote_fingerprint, claim.story_id, record.epoch, timeoutSeconds);
  if (!marker || marker.claimant_id !== record.claimant_id) return { error: "the ownership record of this claim is missing" };
  return writeOwnershipRecord(context, record.remote_fingerprint, {
    storyId: claim.story_id,
    epoch: record.epoch,
    claimantId: record.claimant_id,
    secret: marker.secret,
    state: "confirmed",
  }, timeoutSeconds);
}

/**
 * Creates one claim or release record on the remote only if it does not
 * exist yet. For a claim, `ownership` ({ claimantId, secret }) is first kept
 * here as a pending ownership record, so a push whose outcome is unknown can
 * be recognised later. After a failed or timed-out push the remote ref is
 * listed again: if it holds our record, the record was published. Returns
 * `{ published: true }`, `{ existing, state }` with the record the remote
 * holds there (re-read, never assumed), or `{ error, unclear }` where
 * `unclear` means the record may have reached the remote.
 */
function publishRecord(context, policy, target, { storyId, epoch, ref, payload, ownership = null }) {
  const timeoutSeconds = policy.coordination.timeout_seconds;
  const commit = writeRecordCommit(context, timeoutSeconds, serializeSharedPayload(payload));
  if (commit.error) return { error: commit.error };
  if (ownership) {
    const marked = writeOwnershipRecord(context, target.fingerprint, { storyId, epoch, ...ownership, state: "pending" }, timeoutSeconds);
    if (marked.error) return { error: marked.error };
  }
  const trackingRef = claimTrackingRef(ref, target.fingerprint);
  const pushed = pushCreateOnlyRef(context, { url: target.url, ref, objectName: commit.objectName, trackingRef, timeoutSeconds });
  if (pushed.pushed) return { published: true };
  const landed = remoteRefObject(context, target.url, ref, timeoutSeconds);
  if (landed.objectName === commit.objectName) {
    // The push reached the remote although its answer was lost.
    setLocalRef(context, trackingRef, commit.objectName, timeoutSeconds);
    return { published: true };
  }
  if (landed.error) return { error: pushed.error, unclear: true };
  if (ownership) deleteLocalRef(context, claimOwnershipRef(target.fingerprint, storyId, epoch), timeoutSeconds);
  if (!landed.objectName) return { error: pushed.error };
  const read = readSharedClaims(context, policy, { storyId, target });
  if (!read.available) return { error: pushed.error };
  const state = storySharedClaimState(read, storyId);
  const entry = state.epochs.find((item) => item.epoch === epoch);
  const existing = ref.endsWith("/claim") ? entry?.claim : entry?.release;
  return existing ? { existing, state } : { error: pushed.error };
}

function unavailableGuidance(storyId, remote, reason, unclear) {
  return {
    en: {
      result: `Story ${storyId} was not assigned: the shared list of who works on what cannot be reached.`,
      impact: "Other computers could not see this assignment, so two of them could start the same work.",
      required_decision: "Wait until the git remote can be reached, or confirm this project is only worked on from this computer.",
      protection_boundary: unclear
        ? "Nothing was written in this project. The claim may have reached the remote before the connection failed; this computer remembers it, so the next attempt cleans it up."
        : "Nothing was written on this computer or on the remote.",
      next_action: `Retry when '${remote}' answers again. For single-computer use only, set orchestration_policy.coordination.mode to local_only.`,
      details: { remote, reason },
    },
    it: {
      result: `La story ${storyId} non è stata assegnata: l’elenco condiviso di chi lavora su cosa non è raggiungibile.`,
      impact: "Gli altri computer non vedrebbero questa assegnazione, quindi due di loro potrebbero iniziare lo stesso lavoro.",
      required_decision: "Attendi che il remote git sia raggiungibile, oppure conferma che il progetto si usa da un solo computer.",
      protection_boundary: unclear
        ? "Non è stato scritto nulla nel progetto. L’assegnazione potrebbe aver raggiunto il remote prima che la connessione cadesse; questo computer la ricorda, quindi il prossimo tentativo la ripulisce."
        : "Non è stato scritto nulla né su questo computer né sul remote.",
      next_action: `Riprova quando '${remote}' risponde di nuovo. Solo per l’uso da un unico computer, imposta orchestration_policy.coordination.mode su local_only.`,
      details: { remote, reason },
    },
  };
}

function failUnavailable(storyId, remote, reason, { unclear = false } = {}) {
  failWithCode(
    "STORY_CLAIM_REMOTE_UNAVAILABLE",
    [
      `Story ${storyId} was not claimed: claims are shared through the git remote '${remote}', and ${reason}.`,
      unclear
        ? "The claim may have reached the remote before the connection failed; this computer remembers it, and the next story claim releases it before claiming again."
        : "Claiming is the start of work, so it waits until every computer can see the claim.",
      `Retry when the remote can be reached. If this project is only worked on from this computer, set ${ORCHESTRATION_COORDINATION_SETTING}.mode to local_only.`,
    ].join("\n"),
    unavailableGuidance(storyId, remote, reason, unclear),
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
 * `newClaimantId()` names the new claim. Returns `{ scope: "local", note }`
 * when claims are not shared, and otherwise `{ scope: "shared", record,
 * takeover, pending_release_shared }` where `record` is what the claim file
 * keeps. Refuses (user error) when the remote cannot be used, when its
 * records cannot be trusted, and when someone else holds the story, unless
 * `force` and `authorizeTakeover(holder, { ownRecord })` accept a takeover
 * (it throws when not allowed and returns `{ reason }` otherwise). Whether a
 * claim is ours is decided only by this repository's ownership refs, never by
 * the claim file, which travels with git.
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
  const timeoutSeconds = policy.coordination.timeout_seconds;
  if (!perWorktreeRefsSupported(context, timeoutSeconds)) {
    fail(
      `Story ${storyId} was not claimed: this worktree cannot keep its own claim records, because the installed git does not keep `
      + "refs/worktree/ refs apart for each worktree. Claim from the repository's main worktree, or update git.",
    );
  }
  // One id per claim, independent of the computer, and a secret only this worktree keeps.
  const claimantId = newClaimantId();
  const secret = crypto.randomBytes(32).toString("hex");
  const readState = () => {
    const read = readSharedClaims(context, policy, { storyId, target });
    if (!read.available) failUnavailable(storyId, target.remote, read.error);
    const state = storySharedClaimState(read, storyId);
    if (state.problems.length > 0) failUntrustworthy(storyId, target.remote, state.problems);
    return state;
  };
  const releaseOwn = (active, status, reason, releasedAt) => {
    const shared = publishRecord(context, policy, target, {
      storyId,
      epoch: active.epoch,
      ref: sharedReleaseRef(storyId, active.epoch),
      payload: buildSharedReleasePayload({
        storyId,
        epoch: active.epoch,
        claimantId: active.claimant_id,
        status,
        reason,
        releasedAt,
        agent,
        actor,
      }),
    });
    if (shared.error) failUnavailable(storyId, target.remote, shared.error);
  };
  let state = readState();
  let takeover = null;
  let pendingReleaseShared = false;
  if (state.active) {
    const active = state.active;
    const owned = ownedSharedClaims(context, target.fingerprint, timeoutSeconds);
    const ownRecord = ownsClaimRecord(owned, claimNamespace(storyId), active);
    const ownState = ownRecord ? owned.get(claimOwnershipKey(storyId, active.epoch)).state : null;
    const recorded = localClaim?.shared_claim?.scope === "shared" && localClaim.shared_claim.claimant_id === active.claimant_id
      ? localClaim.shared_claim
      : null;
    const localActive = String(localClaim?.status || "").toLowerCase() === "active";
    if (ownRecord && recorded && !localActive) {
      // Released here while the remote could not be reached: share that release first.
      releaseOwn(active, sharedReleaseStatus(localClaim.status), localClaim.release_reason || null, localClaim.released_at || claimedAt);
      pendingReleaseShared = true;
    } else if (ownRecord && !recorded && ownState === "pending") {
      // An earlier attempt from here reached the remote but was never recorded in this project.
      releaseOwn(active, "cancelled", "an interrupted claim from this computer, never recorded in the project", claimedAt);
      pendingReleaseShared = true;
    } else if (!force) {
      failHeld(storyId, active, target.remote);
    } else {
      // A confirmed claim of ours without its claim file here (another branch, for example) is held like any other.
      const decision = authorizeTakeover(active, { ownRecord: ownRecord && Boolean(recorded) });
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
      ownerProof: proofOf(secret),
    }),
    ownership: { claimantId, secret },
  });
  if (published.existing && published.existing.claimant_id !== claimantId) {
    failHeld(storyId, published.existing, target.remote, { concurrent: true });
  }
  if (published.error) failUnavailable(storyId, target.remote, published.error, { unclear: published.unclear });
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
      owner_proof: proofOf(secret),
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

/**
 * A person's decision about a claim made on another computer: taking the
 * story over, or releasing that claim from here. It needs a human or CI
 * actor and --reason (recorded on the remote for the holder to see), and is
 * refused inside an agent's session. Returns `{ reason }`.
 */
export function requireSharedClaimPersonDecision(storyId, claim, { attribution, options, action = "take over" }) {
  const holder = sharedClaimHolder(claim) || {};
  const command = action === "release"
    ? `agentic-sdlc story release --id ${storyId} --reason "<why the holder cannot release it>" --actor-type human`
    : `agentic-sdlc story claim --id ${storyId} --agent <agent> --force --reason "<why the current holder cannot continue>" --actor-type human`;
  if (runsInsideAgentHost()) {
    failWithCode(
      "STORY_CLAIM_TAKEOVER_NEEDS_PERSON",
      [
        `Story ${storyId} is claimed on another computer by ${describeSharedHolder(claim)}.`,
        `Only a person can decide to ${action} it from here, outside the agent's session. Show them who holds it and ask them to run, in their own terminal:`,
        command,
      ].join("\n"),
      {
        en: {
          result: `Story ${storyId} was left unchanged: ${holder.agent} holds it on branch ${holder.branch} from another computer.`,
          impact: "Their work continues to count as the only active work on this story.",
          required_decision: "A person decides whether the current holder has stopped and the story should be freed or move here.",
          protection_boundary: "Nothing was written on this computer or on the remote.",
          next_action: "Ask the user to run the command in their own terminal, with the reason.",
          details: { holder },
        },
        it: {
          result: `La story ${storyId} non è stata modificata: la detiene ${holder.agent} sul branch ${holder.branch} da un altro computer.`,
          impact: "Il suo lavoro resta l’unico attivo su questa story.",
          required_decision: "Una persona decide se chi la detiene si è fermato e se la story va liberata o deve passare qui.",
          protection_boundary: "Non è stato scritto nulla né su questo computer né sul remote.",
          next_action: "Chiedi all’utente di eseguire il comando nel proprio terminale, con il motivo.",
          details: { holder },
        },
      },
    );
  }
  requireCoordinationOverrideActor(attribution, `Acting on story ${storyId}, claimed on another computer by ${holder.agent}`);
  const reason = getOptionString(options, "reason");
  if (!reason) {
    fail(
      `Acting on story ${storyId}, claimed on another computer by ${describeSharedHolder(claim)}, requires --reason, `
      + "which is recorded on the remote for the holder to see.",
    );
  }
  return { reason };
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
 * in which case running `story release` again shares it later. A claim made
 * on another computer is released only with `personDecision` (see
 * requireSharedClaimPersonDecision). `agent` and `actor` name who releases.
 */
export function shareStoryClaimRelease(context, {
  claim,
  status,
  reason = null,
  releasedAt,
  agent = null,
  actor = null,
  personDecision = false,
}) {
  const record = claim?.shared_claim;
  if (!record || record.scope !== "shared" || !record.claimant_id || !Number.isSafeInteger(record.epoch)) return null;
  const storyId = claim.story_id;
  const policy = storyClaimPolicy(context);
  const notShared = (error) => ({ status: "not_shared", remote: record.remote, error });
  if (policy.coordination.mode === "local_only") {
    return notShared(`sharing is turned off (${ORCHESTRATION_COORDINATION_SETTING}.mode is local_only)`);
  }
  if (!personDecision && !ownsSharedClaim(context, record, policy.coordination.timeout_seconds)) {
    return notShared("the claim was made on another computer; release it there, or a person releases it from here with --reason");
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
  return {
    ...base,
    scope: "shared",
    remote: read.remote,
    checked: true,
    error: null,
    problems: read.problems,
    interpreted: read,
    owned: ownedSharedClaims(context, read.fingerprint, policy.coordination.timeout_seconds),
  };
}
