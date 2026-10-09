import {
  isPlainRecord,
} from "./canonical.mjs";
import {
  claimEpochName,
  claimNamespace,
  plainSharedText,
} from "./story-claim-shared-state.mjs";
import {
  parseSharedPayload,
  sealSharedPayload,
} from "./shared-ref-records.mjs";
import { Date } from "./runtime/host.mjs";

/**
 * Declared waits (story wait) and the lease of a claim, as pure rules.
 *
 * A claim expires at a fixed time, but work that is still being pushed is not
 * abandoned: the lease of a claim is renewed by every commit on its branch
 * (there is no heartbeat). A claim whose holder is legitimately waiting (on
 * another story, a pull request, or a person's answer) declares it with
 * story wait; a valid wait keeps the claim from being listed as abandoned.
 *
 * Waits shared across computers are kept on the remote apart from the claims,
 * so plugins that predate them never list or read them:
 *
 *   refs/agentic-sdlc/waits/<story>/<claim epoch>/<wait id>
 *
 * Each record is created only if it does not exist yet; the latest record of
 * the current claim epoch decides (a "clear" record ends the wait).
 */

export const WAIT_SHARED_REF_ROOT = "refs/agentic-sdlc/waits";
export const WAIT_SHARED_TRACKING_ROOT = "refs/agentic-sdlc-shared/waits";
export const WAIT_KINDS = Object.freeze(["dep", "pr", "person"]);
export const WAIT_ACTIONS = Object.freeze(["wait", "clear"]);
// No push for this long marks a claim idle when orchestration_policy.claim_activity.idle_after_seconds is not set.
export const DEFAULT_IDLE_AFTER_SECONDS = 14_400;

const WAIT_KIND = "story_wait_shared";
const PAYLOAD_VERSION = 1;
const WAIT_ID_PATTERN = /^WAIT-[A-Za-z0-9_-]{4,80}$/u;
const RECORD_PATTERN = /^refs\/agentic-sdlc\/waits\/([^/]+)\/([0-9]{6})\/(WAIT-[A-Za-z0-9_-]{4,80})$/u;
const TARGET_MAX_LENGTH = 500;

/** Where the tracked copies of one remote's waits are kept here (see claimTrackingRoot). */
export function waitTrackingRoot(fingerprint) {
  return `${WAIT_SHARED_TRACKING_ROOT}/${String(fingerprint || "unknown").slice(0, 16)}`;
}

export function waitTrackingRef(ref, fingerprint) {
  return `${waitTrackingRoot(fingerprint)}/${ref.slice(WAIT_SHARED_REF_ROOT.length + 1)}`;
}

export function sharedWaitRef(storyId, epoch, waitId) {
  if (!WAIT_ID_PATTERN.test(String(waitId))) throw new Error(`Invalid wait id ${waitId}`);
  return `${WAIT_SHARED_REF_ROOT}/${claimNamespace(storyId)}/${claimEpochName(epoch)}/${waitId}`;
}

/** Human name of one shared wait record, for messages. */
export function describeWaitRecord(ref) {
  const match = RECORD_PATTERN.exec(ref);
  return match ? `the shared wait record ${match[3]} of ${match[1]}` : `the shared wait record ${String(ref).split("/").slice(-3).join("/")}`;
}

/**
 * Reads what a wait is on: `dep:<story>`, `pr:<url>`, or `person:<question>`.
 * Returns `{ kind, target }` or `{ error }`.
 */
export function parseWaitCondition(value) {
  const text = String(value ?? "").trim();
  const match = /^(dep|pr|person):(.+)$/isu.exec(text);
  if (!match) return { error: "--on must be dep:<story-id>, pr:<pull request url>, or person:\"<question>\"." };
  const kind = match[1].toLowerCase();
  const target = match[2].trim().replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").slice(0, TARGET_MAX_LENGTH);
  if (!target) return { error: `--on ${kind}: needs what it waits on.` };
  if (kind === "pr" && !/^https?:\/\/\S+$/iu.test(target)) return { error: "--on pr: needs the pull request's http(s) address." };
  return { kind, target };
}

/** The record that declares or clears a wait, shared through the remote. */
export function buildSharedWaitPayload({
  storyId,
  epoch,
  claimantId,
  waitId,
  action,
  on = null,
  reason = null,
  until = null,
  actor = null,
  createdAt,
}) {
  if (!WAIT_ACTIONS.includes(action)) throw new Error(`A wait action must be one of ${WAIT_ACTIONS.join(", ")}.`);
  return sealSharedPayload({
    kind: WAIT_KIND,
    version: PAYLOAD_VERSION,
    story_id: String(storyId),
    epoch,
    claimant_id: String(claimantId),
    wait_id: String(waitId),
    action,
    on: action === "wait" && on ? { kind: String(on.kind), target: String(on.target) } : null,
    reason: reason ? String(reason) : null,
    until: action === "wait" && until ? String(until) : null,
    actor: actor ? { id: String(actor.id || "unknown"), type: String(actor.type || "unknown") } : null,
    created_at: String(createdAt),
  });
}

/**
 * Shared wait records (`{ ref, message }`) read as a map from a story's ref
 * folder to its readable records, oldest first. A record that cannot be read
 * is left out: a wait only ever protects a claim, so losing one never
 * blocks anything.
 */
export function interpretSharedWaitRecords(records = []) {
  const byStory = new Map();
  for (const { ref, message } of records) {
    const match = RECORD_PATTERN.exec(ref);
    if (!match) continue;
    const [, namespace, epochText, waitId] = match;
    const payload = parseSharedPayload(message);
    if (!payload
      || payload.kind !== WAIT_KIND
      || payload.version !== PAYLOAD_VERSION
      || typeof payload.story_id !== "string"
      || claimNamespace(payload.story_id) !== namespace
      || payload.epoch !== Number(epochText)
      || payload.wait_id !== waitId
      || !WAIT_ACTIONS.includes(payload.action)
      || (payload.action === "wait" && (!isPlainRecord(payload.on) || !WAIT_KINDS.includes(payload.on.kind)))) {
      continue;
    }
    if (!byStory.has(namespace)) byStory.set(namespace, []);
    byStory.get(namespace).push(payload);
  }
  for (const list of byStory.values()) list.sort(compareWaitRecords);
  return byStory;
}

function compareWaitRecords(left, right) {
  return String(left.created_at).localeCompare(String(right.created_at))
    || String(left.wait_id ?? left.id).localeCompare(String(right.wait_id ?? right.id));
}

/** The shared wait records of one story (oldest first), from an interpretation. */
export function sharedWaitRecordsOf(interpretedWaits, storyId) {
  return interpretedWaits?.get(claimNamespace(storyId)) || [];
}

/**
 * The wait in force for one claim: the latest record that belongs to it,
 * local (`.sdlc/stories/<id>/waits/`) or shared, as a plain view
 * `{ id, kind, target, reason, since, until, source }`; null when the latest
 * record clears it or there is none. A shared claim's records are matched by
 * epoch and claimant, a claim kept on this computer only by its claim time.
 */
export function currentWaitRecord({ local = [], shared = [], claim }) {
  if (!claim) return null;
  const epoch = Number.isSafeInteger(claim.epoch) ? claim.epoch : null;
  const claimantId = claim.claimant_id ? String(claim.claimant_id) : null;
  const matches = (record) => {
    if (epoch !== null) {
      const recordEpoch = record.epoch ?? record.claim?.epoch ?? null;
      const recordClaimant = record.claimant_id ?? record.claim?.claimant_id ?? null;
      return recordEpoch === epoch && (!claimantId || !recordClaimant || recordClaimant === claimantId);
    }
    return Boolean(record.claim?.claimed_at) && record.claim.claimed_at === claim.claimed_at;
  };
  const candidates = [
    ...local.filter(matches).map((record) => ({ ...record, source: "local", wait_id: record.id })),
    ...shared.filter(matches).map((record) => ({ ...record, source: "remote" })),
  ].sort(compareWaitRecords);
  const latest = candidates.at(-1);
  if (!latest || latest.action !== "wait") return null;
  return {
    id: plainSharedText(latest.wait_id),
    kind: plainSharedText(latest.on?.kind),
    target: plainSharedText(latest.on?.target, TARGET_MAX_LENGTH),
    reason: plainSharedText(latest.reason, 500),
    since: plainSharedText(latest.created_at),
    until: plainSharedText(latest.until),
    source: latest.source,
  };
}

/**
 * Whether a declared wait still holds: before its `until`, and while what it
 * waits on is unresolved. `resolve(wait)` answers "resolved", "open", or
 * "unknown" (unknown keeps the wait valid). Returns the wait with `valid`
 * and, when it no longer holds, `ended: "expired" | "resolved"`.
 */
export function evaluateWait(wait, { nowMs, resolve = () => "unknown" }) {
  if (!wait) return null;
  const untilMs = Date.parse(String(wait.until || ""));
  if (!Number.isFinite(untilMs) || untilMs < nowMs) return { ...wait, valid: false, ended: "expired" };
  let resolution = "unknown";
  try {
    resolution = wait.kind === "person" ? "open" : resolve(wait);
  } catch {
    resolution = "unknown";
  }
  if (resolution === "resolved") return { ...wait, valid: false, ended: "resolved" };
  return { ...wait, valid: true, condition: resolution };
}

/**
 * When a claim's lease ends, in milliseconds: its recorded (or default)
 * expiry, renewed by the last commit on its branch plus the claim time to
 * live, and cut by stale_claim_after_seconds counted from the later of the
 * claim and that commit. Null when nothing bounds it.
 */
export function claimLeaseEndMs({ expiresAt = null, claimedAt = null, lastActivityMs = null, ttlSeconds = null, staleAfterSeconds = null }) {
  const expires = Date.parse(String(expiresAt || ""));
  const renewed = Number.isFinite(lastActivityMs) && Number.isFinite(ttlSeconds) ? lastActivityMs + ttlSeconds * 1000 : NaN;
  const candidates = [expires, renewed].filter(Number.isFinite);
  let end = candidates.length > 0 ? Math.max(...candidates) : null;
  if (staleAfterSeconds !== null && staleAfterSeconds !== undefined) {
    const claimed = Date.parse(String(claimedAt || ""));
    const anchor = Math.max(...[claimed, lastActivityMs].filter(Number.isFinite));
    if (Number.isFinite(anchor)) {
      const cut = anchor + staleAfterSeconds * 1000;
      end = end === null ? cut : Math.min(end, cut);
    }
  }
  return end;
}

/**
 * Where a held claim stands: `waiting` (a valid declared wait), `abandoned`
 * (its lease ended and nothing protects it: a person decides), `idle` (no
 * commit for idle_after_seconds), or `active`. Never frees anything by itself.
 */
export function classifyClaimHealth({ claimedAt, leaseEndMs, lastActivityMs, wait, idleAfterSeconds, nowMs }) {
  if (wait?.valid) return "waiting";
  if (leaseEndMs !== null && leaseEndMs < nowMs) return "abandoned";
  if (idleAfterSeconds !== null && idleAfterSeconds !== undefined) {
    const anchor = Number.isFinite(lastActivityMs) ? lastActivityMs : Date.parse(String(claimedAt || ""));
    if (Number.isFinite(anchor) && anchor + idleAfterSeconds * 1000 < nowMs) return "idle";
  }
  return "active";
}
