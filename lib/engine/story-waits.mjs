import path from "node:path";
import {
  computeStableHash,
} from "../canonical.mjs";
import {
  fail,
} from "../cli/user-error.mjs";
import {
  getOptionString,
  normalizeId,
  normalizeOptionalDateTime,
  requireOption,
} from "../lifecycle/common.mjs";
import {
  humanGuidanceLocale,
} from "../lifecycle/guidance.mjs";
import {
  defaultClaimExpiration,
  effectiveClaimPolicy,
} from "../lifecycle/story.mjs";
import {
  Date,
  fs,
} from "../runtime/host.mjs";
import {
  serializeSharedPayload,
} from "../shared-ref-records.mjs";
import {
  orchestrationPolicy,
} from "../story-claim-shared-state.mjs";
import {
  DEFAULT_IDLE_AFTER_SECONDS,
  buildSharedWaitPayload,
  classifyClaimHealth,
  claimLeaseEndMs,
  currentWaitRecord,
  evaluateWait,
  parseWaitCondition,
  sharedWaitRecordsOf,
  sharedWaitRef,
  waitTrackingRef,
} from "../story-wait-shared-state.mjs";
import {
  buildAttribution,
  now,
  uniqueRecordSuffix,
} from "./common.mjs";
import {
  currentDeliveryExecutionState,
} from "./delivery.mjs";
import {
  ensureInitialized,
} from "./migration.mjs";
import {
  output,
} from "./output.mjs";
import {
  pushCreateOnlyRef,
  remoteRefObject,
  runGit,
  setLocalRef,
  writeRecordCommit,
} from "./shared-refs.mjs";
import {
  acquireFileLock,
  readProjectJson,
  safeReadDir,
  writeJsonFile,
} from "./storage.mjs";
import {
  ownsSharedClaim,
  resolveClaimScope,
  storyClaimPolicy,
} from "./story-claim-shared.mjs";
import {
  parseDurationSeconds,
} from "./story-reservation.mjs";
import {
  appendTraceEvent,
  effectiveStoryLifecycleProjection,
  readStory,
  readStoryClaim,
} from "./story.mjs";

// The holder of a claim declares a legitimate wait (story wait): on another
// story, on a pull request, or on a person's answer, until a given time. A
// valid wait keeps the claim from being listed as abandoned. Each declaration
// or clearing is one sealed record under the story's waits/ folder (and, when
// claims are shared, a record on the remote under refs/agentic-sdlc/waits/).

export const STORY_WAIT_SCHEMA = "story-wait:v1";
export const STORY_WAIT_DIRECTORY = "waits";
const ACTIONS = new Set(["wait", "clear"]);
// Branches that carry everyone's work: a commit there is no sign of life of one claim.
const SHARED_BRANCH_NAMES = new Set(["main", "master", "trunk", "develop"]);
// Delivery outcomes after which a pull request no longer keeps anyone waiting.
const PULL_REQUEST_DONE = new Set(["merged", "merged_externally", "closed", "cancelled", "superseded", "revoked", "released", "rolled_back"]);

export function storyWaitRoot(context, storyId) {
  return path.join(context.sdlcRoot, "stories", storyId, STORY_WAIT_DIRECTORY);
}

/** The wait and clear records of one story, oldest first; unreadable or altered records count for nothing. */
export function readStoryWaitRecords(context, storyId) {
  const records = [];
  for (const name of safeReadDir(storyWaitRoot(context, storyId)).sort()) {
    if (!name.endsWith(".json")) continue;
    try {
      const record = readProjectJson(context, path.join(storyWaitRoot(context, storyId), name));
      const { record_hash: recordHash, ...content } = record;
      if (record.schema !== STORY_WAIT_SCHEMA || record.story_id !== storyId || !ACTIONS.has(record.action)) continue;
      if (recordHash !== computeStableHash(content)) continue;
      records.push(record);
    } catch {
      // A record that cannot be read protects nothing.
    }
  }
  return records.sort((left, right) =>
    String(left.created_at).localeCompare(String(right.created_at)) || String(left.id).localeCompare(String(right.id)));
}

function safeOrchestrationPolicy(context) {
  try {
    return orchestrationPolicy(context.config);
  } catch {
    return null;
  }
}

/** Seconds a claim lives without renewal (claim_policy.default_ttl_seconds), or null. */
export function claimTtlSeconds(context) {
  const ttl = effectiveClaimPolicy(context).default_ttl_seconds;
  return Number.isFinite(ttl) && ttl > 0 ? ttl : null;
}

function isSharedBranch(context, branch) {
  if (SHARED_BRANCH_NAMES.has(branch)) return true;
  return safeOrchestrationPolicy(context)?.merge_drift.base_branch === branch;
}

/**
 * The last commit time (ms) of each claim branch, here and as this clone last
 * fetched it from the remote, read with one git call the first time it is
 * asked. Returns `(branch) => ms | null`; the shared base branches never
 * count, and a project without git has no activity.
 */
export function claimBranchActivity(context) {
  let times = null;
  const policy = safeOrchestrationPolicy(context);
  const remote = policy?.coordination.remote || "origin";
  const timeoutSeconds = policy?.coordination.timeout_seconds || 20;
  return (branch) => {
    const name = String(branch || "");
    if (!name || isSharedBranch(context, name)) return null;
    if (times === null) {
      times = new Map();
      const listed = runGit(context.root, [
        "for-each-ref", "--format=%(refname)%00%(committerdate:iso-strict)", "refs/heads/", `refs/remotes/${remote}/`,
      ], { timeoutSeconds });
      if (listed.ok) {
        for (const line of listed.stdout.split(/\r?\n/u)) {
          const [ref, date] = line.split("\u0000");
          const ms = Date.parse(String(date || ""));
          if (!ref || !Number.isFinite(ms)) continue;
          const short = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref.slice(`refs/remotes/${remote}/`.length);
          times.set(short, Math.max(times.get(short) ?? -Infinity, ms));
        }
      }
    }
    return times.get(name) ?? null;
  };
}

function storyLifecycleDone(context, storyId) {
  const story = readStory(context, storyId);
  if (!story) return "unknown";
  const lifecycle = effectiveStoryLifecycleProjection(context, story);
  return lifecycle.closed || lifecycle.terminal ? "resolved" : "open";
}

function pullRequestState(context, url) {
  const wanted = String(url).replace(/\/+$/u, "");
  const deliveriesRoot = path.join(context.sdlcRoot, "autonomy", "deliveries");
  let found = "unknown";
  for (const name of safeReadDir(deliveriesRoot)) {
    if (!name.endsWith(".json")) continue;
    try {
      const profile = readProjectJson(context, path.join(deliveriesRoot, name));
      if (String(profile.pull_request_target?.pr_url || "").replace(/\/+$/u, "") !== wanted) continue;
      const terminal = currentDeliveryExecutionState(context, profile).close_receipt?.terminal_status || null;
      if (terminal && PULL_REQUEST_DONE.has(terminal)) return "resolved";
      found = "open";
    } catch {
      // A delivery record that cannot be read says nothing about the pull request.
    }
  }
  return found;
}

/**
 * Answers whether what a wait is on is resolved: `dep` from the other story's
 * records (or `storyState(id)` when the caller already knows it), `pr` from
 * this project's delivery records when they know the pull request (unknown
 * otherwise, which keeps the wait). Best effort, never throws.
 */
export function waitResolver(context, { storyState = null } = {}) {
  return (wait) => {
    if (wait.kind === "dep") {
      const known = storyState ? storyState(wait.target) : null;
      if (known) return ["closed", "terminal"].includes(known) ? "resolved" : "open";
      return storyLifecycleDone(context, wait.target);
    }
    if (wait.kind === "pr") return pullRequestState(context, wait.target);
    return "unknown";
  };
}

function claimKey(claim) {
  return {
    epoch: Number.isSafeInteger(claim?.epoch) ? claim.epoch : (Number.isSafeInteger(claim?.shared_claim?.epoch) ? claim.shared_claim.epoch : null),
    claimant_id: claim?.claimant_id || claim?.shared_claim?.claimant_id || null,
    claimed_at: claim?.claimed_at || null,
  };
}

/**
 * Whether the lease of an active claim kept in this checkout still holds
 * although its recorded expiry passed: renewed by a commit on its branch
 * within the claim time to live, or protected by a valid wait recorded here.
 */
export function claimLeaseHolds(context, claim, { nowMs = Date.now() } = {}) {
  try {
    const lastActivityMs = claimBranchActivity(context)(claim?.branch);
    const end = claimLeaseEndMs({
      expiresAt: claim?.expires_at || defaultClaimExpiration(context, claim?.claimed_at),
      lastActivityMs,
      ttlSeconds: claimTtlSeconds(context),
    });
    if (end !== null && end >= nowMs) return true;
    const storyId = claim?.story_id;
    if (!storyId) return false;
    const wait = evaluateWait(
      currentWaitRecord({ local: readStoryWaitRecords(context, storyId), claim: claimKey(claim) }),
      { nowMs, resolve: waitResolver(context) },
    );
    return Boolean(wait?.valid);
  } catch {
    return false;
  }
}

function idleAfterSeconds(policy) {
  if (!policy) return DEFAULT_IDLE_AFTER_SECONDS;
  return policy.claim_activity.mode === "off" ? null : policy.claim_activity.idle_after_seconds;
}

/**
 * Where one held claim stands for status: `{ state, ... }` with state active,
 * waiting (with what, since, until), idle (no push for idle_after_seconds),
 * or abandoned (lease ended and no valid wait: a person decides, with the
 * commands that do it). `holder` is `{ agent, branch, claimed_at,
 * expires_at, epoch, claimant_id }`; `sharedWaits` are the remote's wait
 * records of the story. Never changes anything.
 */
export function storyClaimHealth(context, { storyId, holder, here, nowMs, staleAfterSeconds, sharedWaits = [], activity, resolve }) {
  const policy = safeOrchestrationPolicy(context);
  const lastActivityMs = activity(holder.branch);
  const ttlSeconds = claimTtlSeconds(context);
  const leaseEndMs = claimLeaseEndMs({
    expiresAt: holder.expires_at || defaultClaimExpiration(context, holder.claimed_at),
    claimedAt: holder.claimed_at,
    lastActivityMs,
    ttlSeconds,
    staleAfterSeconds: staleAfterSeconds === undefined ? policy?.stale_claim_after_seconds ?? null : staleAfterSeconds,
  });
  const wait = evaluateWait(currentWaitRecord({
    local: readStoryWaitRecords(context, storyId),
    shared: sharedWaits,
    claim: claimKey(holder),
  }), { nowMs, resolve });
  const idleAfter = idleAfterSeconds(policy);
  const state = classifyClaimHealth({ claimedAt: holder.claimed_at, leaseEndMs, lastActivityMs, wait, idleAfterSeconds: idleAfter, nowMs });
  return {
    state,
    agent: holder.agent || null,
    branch: holder.branch || null,
    here: Boolean(here),
    claimed_at: holder.claimed_at || null,
    last_activity_at: Number.isFinite(lastActivityMs) ? new Date(lastActivityMs).toISOString() : null,
    lease_expires_at: leaseEndMs === null ? null : new Date(leaseEndMs).toISOString(),
    idle_after_seconds: idleAfter,
    ...(wait ? { wait } : {}),
    ...(state === "abandoned" ? { decision_commands: abandonedClaimCommands(storyId) } : {}),
  };
}

/** What a person can run about an abandoned claim; nothing is ever released or taken over by itself. */
export function abandonedClaimCommands(storyId) {
  return [
    `agentic-sdlc story claim --id ${storyId} --agent "<agent>" --force --reason "<why>" --actor-type human`,
    `agentic-sdlc story park --id ${storyId} --reason "<why>" --actor-type human`,
  ];
}

/** One plain sentence about a claim's health, for status lines; "" for an active claim. */
export function claimHealthText(health, { italian = false } = {}) {
  if (!health) return "";
  if (health.state === "waiting" && health.wait) {
    const on = waitConditionText(health.wait, italian);
    return italian
      ? `in attesa di ${on} dal ${health.wait.since} fino a ${health.wait.until}`
      : `waiting on ${on} since ${health.wait.since} until ${health.wait.until}`;
  }
  if (health.state === "idle") {
    const since = health.last_activity_at || health.claimed_at;
    return italian ? `inattiva: nessun push dal ${since}` : `idle: no push since ${since}`;
  }
  if (health.state === "abandoned") {
    return italian
      ? `abbandonata: l'assegnazione è scaduta il ${health.lease_expires_at} senza push né attesa dichiarata; decide una persona`
      : `abandoned: the claim lapsed at ${health.lease_expires_at} with no push and no declared wait; a person decides`;
  }
  return "";
}

function waitConditionText(wait, italian) {
  if (wait.kind === "dep") return italian ? `la story ${wait.target}` : `story ${wait.target}`;
  if (wait.kind === "pr") return italian ? `la pull request ${wait.target}` : `pull request ${wait.target}`;
  return italian ? `una risposta: "${wait.target}"` : `an answer: "${wait.target}"`;
}

function waitUntil(options, createdAt, policy) {
  const value = getOptionString(options, "until");
  if (!value) fail("story wait needs --until: a time (ISO-8601) or a duration such as 12h, 3d, or 1w.");
  const createdMs = Date.parse(createdAt);
  const seconds = parseDurationSeconds(value);
  const untilMs = seconds !== null ? createdMs + seconds * 1000 : Date.parse(normalizeOptionalDateTime(value, "until"));
  if (!(untilMs > createdMs)) fail("A wait must end in the future.");
  const maxSeconds = policy.reservation.max_expires_in_seconds;
  if (untilMs - createdMs > maxSeconds * 1000) {
    fail(
      `A wait lasts at most ${maxSeconds} seconds (orchestration_policy.reservation.max_expires_in_seconds). `
      + "Choose a shorter one; declare it again when it ends.",
    );
  }
  return new Date(untilMs).toISOString();
}

function writeWaitRecord(context, storyId, record) {
  const sealed = { ...record, record_hash: computeStableHash(record) };
  const root = storyWaitRoot(context, storyId);
  fs.mkdirSync(root, { recursive: true });
  const recordPath = path.join(root, `${record.id}.json`);
  writeJsonFile(recordPath, sealed);
  return { record: sealed, recordPath, projectPath: path.relative(context.root, recordPath).split(path.sep).join("/") };
}

/** Shares one wait record through the remote; `{ status: "shared", ref }` or `{ status: "not_shared", error }`. */
function publishWait(context, policy, target, payload, storyId, epoch, waitId) {
  const timeoutSeconds = policy.coordination.timeout_seconds;
  const ref = sharedWaitRef(storyId, epoch, waitId);
  const commit = writeRecordCommit(context, timeoutSeconds, serializeSharedPayload(payload));
  if (commit.error) return { status: "not_shared", remote: target.remote, error: commit.error };
  const trackingRef = waitTrackingRef(ref, target.fingerprint);
  const pushed = pushCreateOnlyRef(context, { url: target.url, ref, objectName: commit.objectName, trackingRef, timeoutSeconds });
  if (pushed.pushed) return { status: "shared", remote: target.remote, ref };
  const landed = remoteRefObject(context, target.url, ref, timeoutSeconds);
  if (landed.objectName === commit.objectName) {
    setLocalRef(context, trackingRef, commit.objectName, timeoutSeconds);
    return { status: "shared", remote: target.remote, ref };
  }
  return { status: "not_shared", remote: target.remote, error: pushed.error || landed.error || "the remote refused the record" };
}

/**
 * story wait: the holder of a story's claim says it is legitimately waiting
 * (on another story, a pull request, or a person's answer) until a given
 * time, or clears that wait. The claim is not changed; while the wait holds,
 * status lists the story as waiting instead of abandoned.
 */
export function storyWait(context, options) {
  ensureInitialized(context);
  const id = normalizeId(requireOption(options, "id"));
  if (!readStory(context, id)) fail(`Story ${id} does not exist.`);
  const clear = options.clear === true;
  const italian = humanGuidanceLocale(options) === "it";
  if (clear && (options.on !== undefined || options.until !== undefined)) fail("Use --clear alone, or --on with --until; not both.");
  const claim = readStoryClaim(context, id);
  if (String(claim?.status || "").toLowerCase() !== "active") {
    fail(`Story ${id} has no active claim on this computer: only the holder of its claim declares a wait (story claim first).`);
  }
  const policy = storyClaimPolicy(context);
  const sharedRecord = claim.shared_claim?.scope === "shared" ? claim.shared_claim : null;
  if (sharedRecord && !ownsSharedClaim(context, sharedRecord, policy.coordination.timeout_seconds)) {
    fail(`Story ${id} is claimed by ${claim.agent} from another worktree or computer: only the holder of the claim declares a wait.`);
  }
  const createdAt = now();
  let on = null;
  let until = null;
  if (!clear) {
    const parsed = parseWaitCondition(getOptionString(options, "on"));
    if (parsed.error) fail(parsed.error);
    on = parsed;
    if (on.kind === "dep") {
      on.target = normalizeId(on.target);
      if (on.target === id) fail("A story cannot wait on itself.");
      if (!readStory(context, on.target)) fail(`Story ${on.target} does not exist.`);
    }
    until = waitUntil(options, createdAt, policy);
  }
  const reason = getOptionString(options, "reason") || null;
  const attribution = buildAttribution(context, options, "story.wait");
  const releaseLock = acquireFileLock(path.join(storyWaitRoot(context, id), "..", "waits.lock"));
  let result;
  try {
    const key = claimKey(claim);
    const current = evaluateWait(
      currentWaitRecord({ local: readStoryWaitRecords(context, id), claim: key }),
      { nowMs: Date.parse(createdAt), resolve: waitResolver(context) },
    );
    if (clear && !current) {
      result = { status: "no_wait", story_id: id };
    } else {
      const waitId = `WAIT-${uniqueRecordSuffix()}`;
      let shared = { status: "local", note: null };
      if (sharedRecord) {
        const target = resolveClaimScope(context, policy.coordination);
        if (target.scope === "shared" && !target.unavailable) {
          shared = publishWait(context, policy, target, buildSharedWaitPayload({
            storyId: id,
            epoch: sharedRecord.epoch,
            claimantId: sharedRecord.claimant_id,
            waitId,
            action: clear ? "clear" : "wait",
            on,
            reason,
            until,
            actor: attribution.actor,
            createdAt,
          }), id, sharedRecord.epoch, waitId);
        } else {
          shared = { status: "not_shared", remote: target.remote || null, error: target.unavailable || target.note || "claims are not shared" };
        }
      }
      const written = writeWaitRecord(context, id, {
        schema: STORY_WAIT_SCHEMA,
        id: waitId,
        story_id: id,
        action: clear ? "clear" : "wait",
        on,
        reason,
        until,
        claim: { agent: claim.agent || null, branch: claim.branch || null, claimed_at: key.claimed_at, epoch: key.epoch, claimant_id: key.claimant_id },
        actor: attribution.actor,
        shared: shared.status === "shared" ? { remote: shared.remote, ref: shared.ref } : null,
        git: attribution.git,
        created_at: createdAt,
      });
      appendTraceEvent(context, id, {
        type: "decision",
        action: clear ? "story.wait.clear" : "story.wait",
        summary: clear
          ? `Story ${id}: the declared wait was cleared${reason ? `: ${reason}` : ""}`
          : `Story ${id} waits on ${on.kind}:${on.target} until ${until}${reason ? `: ${reason}` : ""}`,
        actor: attribution.actor,
        evidence: [written.projectPath],
        related: on?.kind === "dep" ? [id, on.target] : [id],
        git: attribution.git,
        run: attribution.run,
      });
      result = {
        status: clear ? "cleared" : "waiting",
        story_id: id,
        ...(clear ? {} : { wait: { kind: on.kind, target: on.target, since: createdAt, until, reason } }),
        wait_path: written.recordPath,
        wait_record: written.record,
        shared_wait: shared,
      };
    }
  } finally {
    releaseLock();
  }
  const shared = result.shared_wait;
  output(options, result, result.status === "no_wait"
    ? [italian ? `Story ${id}: nessuna attesa dichiarata da togliere.` : `Story ${id}: there is no declared wait to clear.`]
    : [
        result.status === "cleared"
          ? (italian ? `Story ${id}: attesa tolta; l'assegnazione torna a contare sui push.` : `Story ${id}: wait cleared; the claim counts on pushes again.`)
          : (italian
            ? `Story ${id} in attesa di ${waitConditionText({ kind: on.kind, target: on.target }, true)} fino a ${until}: finché vale, l'assegnazione non risulta abbandonata.`
            : `Story ${id} waits on ${waitConditionText({ kind: on.kind, target: on.target }, false)} until ${until}: while it holds, the claim is not listed as abandoned.`),
        shared.status === "shared"
          ? (italian ? `Condivisa tramite '${shared.remote}': ogni computer la vede.` : `Shared through '${shared.remote}': every computer sees it.`)
          : shared.status === "not_shared"
            ? (italian
              ? `NON condivisa (${shared.error}); rilancia il comando quando il remote è raggiungibile.`
              : `NOT shared (${shared.error}); run the command again when the remote can be reached.`)
            : (italian ? "Registrata su questo progetto." : "Recorded in this project."),
      ]);
}

/** Wait records of one story on the remote, from a shared claims read (empty when there is none). */
export function sharedWaitsOf(interpreted, storyId) {
  return sharedWaitRecordsOf(interpreted?.waits, storyId);
}
