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
import { statusSyncPolicy } from "./status-sync.mjs";
import { mergeDriftPolicy } from "./merge-drift.mjs";
import { storyRecordsPolicy } from "./story-records.mjs";
import { remoteWorkPolicy } from "./remote-work.mjs";
import { Date } from "./runtime/host.mjs";
import { compatibilityFeature, pluginUpdateCommand, requiresNewerPlugin } from "./plugin-compatibility.mjs";

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
// Reservations belong to a computer, not to one worktree: every worktree of this clone sees these refs; git never pushes or fetches them.
export const RESERVATION_LOCAL_ROOT = "refs/agentic-sdlc-local/reservations";
export const ORCHESTRATION_COORDINATION_SETTING = "orchestration_policy.coordination";
// "completed" ends the claim of a story whose delivery is finished: every computer reads the story as done,
// even before its closing records reach the base branch. Versions that do not know it refuse to claim the story.
export const SHARED_RELEASE_STATUSES = Object.freeze(["released", "transferred", "cancelled", "taken_over", "closed", "completed"]);
export const SHARED_COMPLETED_STATUS = "completed";
// Releases after which the story is finished for every computer: completed, or closed (superseded or cancelled).
const SHARED_FINISHED_STATUSES = Object.freeze([SHARED_COMPLETED_STATUS, "closed"]);

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

const CLAIM_IDENTITY_DEFAULT = Object.freeze({ git_user: false, host_label_env: "AGENTIC_SDLC_HOST_LABEL" });

/**
 * What a shared claim says about who made it, beyond the agent label. A
 * shared claim is an immutable record every reader of the remote sees, so
 * nothing personal is added unless the project opts in: git_user adds the
 * git user.name; host_label_env names an environment variable whose value
 * (set per computer, never read from the host name) is added as the
 * computer's label.
 */
function claimIdentityPolicy(configured) {
  if (configured === undefined || configured === null) return CLAIM_IDENTITY_DEFAULT;
  if (!isPlainRecord(configured)) invalid("orchestration_policy.claim_identity must be an object.");
  const gitUser = configured.git_user ?? CLAIM_IDENTITY_DEFAULT.git_user;
  if (typeof gitUser !== "boolean") invalid("orchestration_policy.claim_identity.git_user must be true or false.");
  const hostLabelEnv = configured.host_label_env === undefined ? CLAIM_IDENTITY_DEFAULT.host_label_env : configured.host_label_env;
  if (hostLabelEnv !== null && (typeof hostLabelEnv !== "string" || !/^[A-Z_][A-Z0-9_]{0,99}$/u.test(hostLabelEnv))) {
    invalid("orchestration_policy.claim_identity.host_label_env must be null or an environment variable name (A-Z, 0-9, _).");
  }
  return Object.freeze({ git_user: gitUser, host_label_env: hostLabelEnv });
}

const CLAIM_ACTIVITY_MODES = Object.freeze(["git", "off"]);
// Four hours without a push marks a claim idle unless the project sets idle_after_seconds (null turns it off).
const CLAIM_ACTIVITY_DEFAULT = Object.freeze({ mode: "git", idle_after_seconds: 14_400 });

/**
 * How a claim's last sign of life is read: from git (the last commit on its
 * branch as the remote has it), never from a heartbeat. idle_after_seconds
 * marks a claim idle (a notice only) once that commit is older; when the key
 * is absent the default applies, an explicit null turns the notice off.
 */
function claimActivityPolicy(configured) {
  if (configured === undefined || configured === null) return CLAIM_ACTIVITY_DEFAULT;
  if (!isPlainRecord(configured)) invalid("orchestration_policy.claim_activity must be an object.");
  const mode = configured.mode ?? CLAIM_ACTIVITY_DEFAULT.mode;
  if (!CLAIM_ACTIVITY_MODES.includes(mode)) {
    invalid(`orchestration_policy.claim_activity.mode must be one of ${CLAIM_ACTIVITY_MODES.join(", ")}.`);
  }
  const idle = configured.idle_after_seconds === undefined ? CLAIM_ACTIVITY_DEFAULT.idle_after_seconds : configured.idle_after_seconds;
  if (idle !== null && (!Number.isSafeInteger(idle) || idle < STALE_MIN_SECONDS || idle > STALE_MAX_SECONDS)) {
    invalid(`orchestration_policy.claim_activity.idle_after_seconds must be null or an integer from ${STALE_MIN_SECONDS} to ${STALE_MAX_SECONDS}.`);
  }
  return Object.freeze({ mode, idle_after_seconds: idle });
}

const RESERVATION_DEFAULT = Object.freeze({ default_expires_in_seconds: 86_400, max_expires_in_seconds: 2_592_000 });

/**
 * How long a reservation (story reserve) lasts when none is given, and the
 * longest one allowed. A reservation always expires: it books a story
 * before it can start, and nobody should keep it by forgetting it.
 */
function reservationPolicy(configured) {
  if (configured === undefined || configured === null) return RESERVATION_DEFAULT;
  if (!isPlainRecord(configured)) invalid("orchestration_policy.reservation must be an object.");
  const seconds = (key) => {
    const value = configured[key] ?? RESERVATION_DEFAULT[key];
    if (!Number.isSafeInteger(value) || value < STALE_MIN_SECONDS || value > STALE_MAX_SECONDS) {
      invalid(`orchestration_policy.reservation.${key} must be an integer from ${STALE_MIN_SECONDS} to ${STALE_MAX_SECONDS}.`);
    }
    return value;
  };
  const defaultSeconds = seconds("default_expires_in_seconds");
  const maxSeconds = seconds("max_expires_in_seconds");
  if (defaultSeconds > maxSeconds) {
    invalid("orchestration_policy.reservation.default_expires_in_seconds must not exceed max_expires_in_seconds.");
  }
  return Object.freeze({ default_expires_in_seconds: defaultSeconds, max_expires_in_seconds: maxSeconds });
}

const WORKFLOW_HISTORY_CHECKS = Object.freeze(["workflow", "project"]);
const WORKFLOW_HISTORY_DIVERGENCE = Object.freeze(["warn", "off"]);
const WORKFLOW_HISTORY_DEFAULT = Object.freeze({ check: "workflow", divergence: "warn" });

/**
 * How read-only lifecycle views check a story workflow's audit records in the
 * shared project history. That history is one hash chain, so records written
 * on several computers and copied onto one branch afterwards no longer chain
 * as a whole even when every workflow's own records are intact. workflow
 * checks each workflow's own chained records (and reports the divergence);
 * project also requires the whole history to verify first. Writes and
 * trace verify always check the whole history. divergence warn makes status
 * and doctor compare this clone's project history with the remote base
 * branch's and warn before publishing when the two have forked.
 */
function workflowHistoryPolicy(configured) {
  if (configured === undefined || configured === null) return WORKFLOW_HISTORY_DEFAULT;
  if (!isPlainRecord(configured)) invalid("orchestration_policy.workflow_history must be an object.");
  const check = configured.check ?? WORKFLOW_HISTORY_DEFAULT.check;
  if (!WORKFLOW_HISTORY_CHECKS.includes(check)) {
    invalid(`orchestration_policy.workflow_history.check must be one of ${WORKFLOW_HISTORY_CHECKS.join(", ")}.`);
  }
  const divergence = configured.divergence ?? WORKFLOW_HISTORY_DEFAULT.divergence;
  if (!WORKFLOW_HISTORY_DIVERGENCE.includes(divergence)) {
    invalid(`orchestration_policy.workflow_history.divergence must be one of ${WORKFLOW_HISTORY_DIVERGENCE.join(", ")}.`);
  }
  return Object.freeze({ check, divergence });
}

const CERTIFICATION_DRIFT_MODES = Object.freeze(["stale", "reopen"]);
const CERTIFICATION_DRIFT_IGNORED_FILES = Object.freeze(["exclude", "include"]);
const CERTIFICATION_DRIFT_DEFAULT = Object.freeze({ mode: "stale", ignored_files: "exclude" });

/**
 * What a sealed final certification means once the project changes after it
 * (another story, a docs commit, an untracked file in a shared write path).
 * stale keeps the story completed and reports the certification as stale with
 * the changed paths; reopen treats it as no longer certified, as before.
 * ignored_files exclude leaves out files Git ignores (nested .gitignore,
 * .git/info/exclude, core.excludesFile); include also reads them, as before.
 */
function certificationDriftPolicy(configured) {
  if (configured === undefined || configured === null) return CERTIFICATION_DRIFT_DEFAULT;
  if (!isPlainRecord(configured)) invalid("orchestration_policy.certification_drift must be an object.");
  const mode = configured.mode ?? CERTIFICATION_DRIFT_DEFAULT.mode;
  if (!CERTIFICATION_DRIFT_MODES.includes(mode)) {
    invalid(`orchestration_policy.certification_drift.mode must be one of ${CERTIFICATION_DRIFT_MODES.join(", ")}.`);
  }
  const ignoredFiles = configured.ignored_files ?? CERTIFICATION_DRIFT_DEFAULT.ignored_files;
  if (!CERTIFICATION_DRIFT_IGNORED_FILES.includes(ignoredFiles)) {
    invalid(`orchestration_policy.certification_drift.ignored_files must be one of ${CERTIFICATION_DRIFT_IGNORED_FILES.join(", ")}.`);
  }
  return Object.freeze({ mode, ignored_files: ignoredFiles });
}

const STATUS_LIST_LIMIT_DEFAULT = 5;
const STATUS_LIST_LIMIT_MAX = 100;

function statusListLimit(value) {
  const limit = value ?? STATUS_LIST_LIMIT_DEFAULT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > STATUS_LIST_LIMIT_MAX) {
    invalid(`orchestration_policy.status_list_limit must be an integer from 1 to ${STATUS_LIST_LIMIT_MAX}.`);
  }
  return limit;
}

/**
 * Effective orchestration policy. `coordination` decides whether claims are
 * shared through the git remote (auto, required, local_only);
 * `stale_claim_after_seconds` lists a claim as stale once it is that old,
 * even before it expires (null: only its expiry counts); `status_sync`
 * decides how status brings this clone up to date first; `merge_drift`
 * decides whether status reports open stories already merged;
 * `status_list_limit` bounds how many stories or records status names in
 * each of its lists; `claim_identity` says what a shared claim records about
 * who made it; `reservation` bounds how long a story reserve lasts;
 * `unclaimed_remote_work` decides how status looks for work on the remote
 * that names a story nobody claimed; `workflow_history` decides how lifecycle
 * views check workflow records in the shared project history;
 * `certification_drift` decides what later project changes mean for a story
 * whose final certification is sealed.
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
    status_sync: statusSyncPolicy(configured.status_sync, invalid),
    merge_drift: mergeDriftPolicy(configured.merge_drift, invalid),
    story_records: storyRecordsPolicy(configured.story_records, invalid),
    status_list_limit: statusListLimit(configured.status_list_limit),
    claim_identity: claimIdentityPolicy(configured.claim_identity),
    claim_activity: claimActivityPolicy(configured.claim_activity),
    reservation: reservationPolicy(configured.reservation),
    unclaimed_remote_work: remoteWorkPolicy(configured.unclaimed_remote_work, invalid),
    workflow_history: workflowHistoryPolicy(configured.workflow_history),
    certification_drift: certificationDriftPolicy(configured.certification_drift),
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

/** Root of the reservations this clone made on one remote; shared by its worktrees, never pushed or fetched. */
export function reservationOwnershipRoot(fingerprint) {
  return `${RESERVATION_LOCAL_ROOT}/${String(fingerprint || "unknown").slice(0, 16)}`;
}

/** The ref that holds this clone's proof of one reservation (see claimOwnershipRef). */
export function reservationOwnershipRef(fingerprint, storyId, epoch) {
  return `${reservationOwnershipRoot(fingerprint)}/${claimNamespace(storyId)}/${claimEpochName(epoch)}`;
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
  identity = null,
  reservation = false,
  parked = null,
}) {
  const plainIdentity = sharedIdentity(identity);
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
    // Only when the project opted in (orchestration_policy.claim_identity); older readers ignore it.
    ...(plainIdentity ? { identity: plainIdentity } : {}),
    // A reservation (story reserve) books the story before its task start; older readers see an ordinary claim.
    ...(reservation ? { reservation: true } : {}),
    // A parked story (story park): a person set it aside until story resume. Older readers see a reservation without expiry.
    ...(reservation && parked ? { parked: sharedParkedRecord(parked) } : {}),
  });
}

/** What a parked reservation records: why and since when, as plain text. */
function sharedParkedRecord(parked) {
  return {
    reason: parked.reason ? String(parked.reason) : null,
    parked_at: parked.parked_at ? String(parked.parked_at) : null,
    park_id: parked.park_id ? String(parked.park_id) : null,
    // When a person should look at it again (story park --review-at); older readers ignore it.
    ...(parked.review_at ? { review_at: String(parked.review_at) } : {}),
  };
}

/** True when a shared record is the reservation that keeps a parked story aside (story park). */
export function isSharedParking(claim) {
  return isSharedReservation(claim) && isPlainRecord(claim?.parked);
}

const IDENTITY_MAX_LENGTH = 80;

/** { user, host } with only the parts present, or null when neither is. */
function sharedIdentity(identity) {
  if (!identity) return null;
  const clean = (value) => {
    const text = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").trim().slice(0, IDENTITY_MAX_LENGTH) : "";
    return text || null;
  };
  const user = clean(identity.user);
  const host = clean(identity.host);
  if (!user && !host) return null;
  return { ...(user ? { user } : {}), ...(host ? { host } : {}) };
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
  completion = null,
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
    // Only a completed release says how the story finished; other releases keep their original shape.
    ...(status === SHARED_COMPLETED_STATUS
      ? {
          completion: sharedCompletionRecord(completion),
          // Plugins that know this field ask for an update instead of reading a status they predate.
          minimum_plugin_version: compatibilityFeature("shared-claim-completed").since,
        }
      : {}),
  });
}

const COMPLETION_TEXT_FIELDS = Object.freeze(["delivery_id", "delivery_kind", "terminal_status", "closed_at", "merge_commit", "close_receipt_hash"]);

/** What a completed release records about the finished delivery: plain text fields only, each one optional. */
function sharedCompletionRecord(completion) {
  const record = {};
  for (const field of COMPLETION_TEXT_FIELDS) {
    const value = completion?.[field];
    record[field] = value === null || value === undefined || value === "" ? null : String(value);
  }
  return record;
}

/**
 * Plain view of a release that finished the story (completed, or closed when
 * superseded or cancelled), safe to show: who ended it, when, and how its
 * delivery finished.
 */
export function sharedCompletionView(release) {
  if (!SHARED_FINISHED_STATUSES.includes(release?.status)) return null;
  const completion = isPlainRecord(release.completion) ? release.completion : {};
  return {
    status: release.status,
    epoch: release.epoch,
    reason: plainSharedText(release.reason, 500),
    released_at: plainSharedText(release.released_at),
    agent: plainSharedText(release.released_by?.agent),
    ...Object.fromEntries(COMPLETION_TEXT_FIELDS.map((field) => [field, plainSharedText(completion[field])])),
  };
}

function emptyStoryState(namespace, storyId = null) {
  return {
    namespace,
    story_id: storyId,
    epochs: [],
    latest: null,
    active: null,
    completed: null,
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
  // A record seen before but gone from the remote stays here as evidence, yet no longer holds the story.
  const goneRefs = new Set(problems.filter((problem) => problem.gone).map((problem) => problem.ref));
  const entries = new Map();
  const entryFor = (namespace, epoch) => {
    const key = `${namespace}\u0000${epoch}`;
    if (!entries.has(key)) entries.set(key, { namespace, epoch, claim: null, release: null, unreadable: [], gone: false });
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
    if (goneRefs.has(ref)) entry.gone = true;
    const state = stateFor(namespace);
    state.next_epoch = Math.max(state.next_epoch, epoch + 1);
    const payload = parseSharedPayload(message);
    // A record that declares a newer plugin is never interpreted by this one.
    const newer = payload && requiresNewerPlugin(payload.minimum_plugin_version) ? payload.minimum_plugin_version : null;
    const bound = payload
      && !newer
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
      state.problems.push(newer
        ? `the shared ${recordKind} record ${epoch} was written by a newer plugin version (${newer} or later); update the plugin: ${pluginUpdateCommand()}`
        : payload
          ? `the shared ${recordKind} record ${epoch} cannot be read; it may come from a newer plugin version, update the plugin: ${pluginUpdateCommand()}`
          : `the shared ${recordKind} record ${epoch} cannot be read`);
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
    state.active = state.latest && !state.latest.release && !state.latest.gone && !state.latest.unreadable.includes("release")
      ? state.latest.claim
      : null;
    // The latest claim ended with the story finished (delivered, superseded, or cancelled): it is done, not free.
    state.completed = state.latest && !state.latest.gone && SHARED_FINISHED_STATUSES.includes(state.latest.release?.status)
      ? state.latest.release
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

/** True when a shared record is a reservation (story reserve) rather than a claim of started work. */
export function isSharedReservation(claim) {
  return claim?.reservation === true;
}

/**
 * True when a reservation is past its expiry. A reservation ends by itself
 * then: the story is free again without a takeover, unlike a claim, which
 * stays held (and listed as stale) until it is released or taken over.
 */
export function sharedReservationExpired(claim, nowMs) {
  if (!isSharedReservation(claim)) return false;
  const expires = Date.parse(String(claim.expires_at || ""));
  return Number.isFinite(expires) && expires <= nowMs;
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
    ...(isSharedReservation(claim) ? { reservation: true } : {}),
    ...(isSharedParking(claim)
      ? {
          parked: {
            reason: plainSharedText(claim.parked.reason, 500),
            parked_at: plainSharedText(claim.parked.parked_at),
            park_id: plainSharedText(claim.parked.park_id),
            ...(claim.parked.review_at ? { review_at: plainSharedText(claim.parked.review_at) } : {}),
          },
        }
      : {}),
    ...(isPlainRecord(claim.identity)
      ? { identity: { user: plainSharedText(claim.identity.user, IDENTITY_MAX_LENGTH), host: plainSharedText(claim.identity.host, IDENTITY_MAX_LENGTH) } }
      : {}),
  };
}

/** "Antonio, mac-studio" from a holder's identity, or null. */
export function holderIdentityText(holder) {
  const parts = [holder?.identity?.user, holder?.identity?.host].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : null;
}

/** One line naming the holder of a shared claim, for messages. */
export function describeSharedHolder(claim) {
  const holder = sharedClaimHolder(claim);
  if (!holder) return "nobody";
  const identity = holderIdentityText(holder);
  const actor = identity
    ? ` (${identity})`
    : holder.actor?.id && holder.actor.id !== holder.agent ? ` (${holder.actor.type || "actor"} ${holder.actor.id})` : "";
  const expiry = holder.expires_at ? `, until ${holder.expires_at}` : "";
  if (holder.parked) {
    return `parked by ${holder.actor?.id || holder.agent}${actor} since ${holder.parked.parked_at || holder.claimed_at}`
      + `${holder.parked.reason ? ` (${holder.parked.reason})` : ""}, until a person runs story resume`;
  }
  if (holder.reservation) return `reserved by ${holder.agent}${actor} since ${holder.claimed_at}${expiry}`;
  return `${holder.agent}${actor} on branch ${holder.branch}, since ${holder.claimed_at}${expiry}`;
}

/**
 * What every computer sees about one story, next to this checkout's claim
 * file: `state` is free, claimed, stale, completed (the story's delivery finished: `completed` says how), or untrustworthy; `holder` is the
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
  // An expired reservation ends by itself: it no longer holds the story.
  const expiredReservation = sharedReservationExpired(state.active, nowMs) ? state.active : null;
  const active = expiredReservation ? null : state.active;
  // Only this worktree's ownership records say a claim was made here; the claim file travels with git.
  const here = Boolean(active && ownsClaimRecord(owned, state.namespace, active));
  // A parked story stays aside until a person resumes it: it never becomes stale.
  const stale = !isSharedParking(active) && sharedClaimIsStale(active, { nowMs, staleAfterSeconds });
  const completed = active ? null : sharedCompletionView(state.completed);
  const view = {
    state: state.problems.length > 0 ? "untrustworthy" : active ? (stale ? "stale" : "claimed") : completed ? "completed" : "free",
    holder: sharedClaimHolder(active),
    here,
    latest_epoch: state.latest?.epoch ?? null,
    problems: [...state.problems],
    warnings: [...state.warnings],
    ...(expiredReservation ? { expired_reservation: sharedClaimHolder(expiredReservation) } : {}),
    ...(completed ? { completed } : {}),
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
  // The claim file travels with git: once the remote ended (or lost) the claim it records, the file is outdated.
  if (localActive && recorded && !(active && active.claimant_id === recorded.claimant_id)) view.local_claim_outdated = true;
  return view;
}
