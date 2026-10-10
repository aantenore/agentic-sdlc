import path from "node:path";

import { console, crypto, Date, fs, process } from "../runtime/host.mjs";
import { parseLimitSeconds } from "../runtime/bounded-child-process.mjs";
import { findGitCommonDir } from "../runtime/run-registry.mjs";
import { UserError } from "../cli/user-error.mjs";
import { isPlainRecord } from "../canonical.mjs";
import { parseSharedPayload, sealSharedPayload, serializeSharedPayload } from "../shared-ref-records.mjs";
import { orchestrationPolicy } from "../story-claim-shared-state.mjs";
import {
  createLocalRef,
  listLocalRefs,
  pushCreateOnlyRef,
  readSharedRefs,
  remoteRefObject,
  resolveSharedScope,
  setLocalRef,
  writeRecordCommit,
} from "./shared-refs.mjs";
import { baseRecords } from "../host-hooks/keep-going.mjs";
import { settingsFor } from "../messaging/attention.mjs";
import { resolveIdentity, selfNamesOf } from "../messaging/identity.mjs";
import { hostLabel } from "../messaging/commands.mjs";
import {
  activeFreeze,
  applyWaitMemory,
  deriveApprovalWaits,
  deriveDelegationWaits,
  deriveDependencyWaits,
  deriveFreezeWaits,
  derivePluginWaits,
  deriveQuestionWaits,
  describeWait,
  interpretExplicitRecords,
  parseWaitTarget,
  planWaitActions,
  resolveWaitsPolicy,
  waitStatusLines,
  waitsByWaiter,
} from "../waits-registry.mjs";

/**
 * Explicit waits (`wait add`, `wait resolve`) and the collection of every
 * wait, explicit and derived, for status, keep-going, watch and the
 * observatory.
 *
 * Explicit waits live on the remote as dedicated refs, like the shared
 * claims, independent of every branch: visible to all computers right after
 * the push, never on main or a story branch, never in conflict.
 *
 *   refs/agentic-sdlc/wait-registry/<wait id>/open      the declaration
 *   refs/agentic-sdlc/wait-registry/<wait id>/resolve   the resolution (created once: the first wins)
 *
 * Each ref is a parentless commit whose message is the sealed JSON payload,
 * pushed create-only (force-with-lease on an empty value). Fetched copies are
 * kept under refs/agentic-sdlc-shared/wait-registry/<remote fingerprint>/.
 * Without a remote (or when the push fails) the record is kept as a local ref
 * with the shared name and listed as not shared. Derived waits are never written.
 */
export const WAIT_REGISTRY_REF_ROOT = "refs/agentic-sdlc/wait-registry";
export const WAIT_REGISTRY_TRACKING_ROOT = "refs/agentic-sdlc-shared/wait-registry";
export const WAIT_MEMORY_FILE = "waits-state.json";
const PAYLOAD_KIND = "wait_registry";
const PAYLOAD_VERSION = 1;
const SETTING = "orchestration_policy.coordination";
const ACTIONS = new Set(["open", "resolve"]);
const DERIVED_ID = /^(?:q|dep|plugin|freeze|approval|delegation):\S{1,200}$/u;
const EXPLICIT_ID = /^WAIT-[A-Za-z0-9_-]{4,80}$/u;

function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function listDir(directory) {
  try {
    return fs.readdirSync(directory);
  } catch {
    return [];
  }
}

function projectConfig(root) {
  return readJson(path.join(root, ".sdlc", "config.json"));
}

/** A wait id as one ref name segment: anything outside [A-Za-z0-9.-] becomes "_<hex>_". */
export function refSegment(id) {
  return String(id).replace(/[^A-Za-z0-9.-]/gu, (char) => `_${char.codePointAt(0).toString(16)}_`);
}

export function segmentId(segment) {
  return String(segment).replace(/_([0-9a-f]{1,6})_/gu, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)));
}

export function waitRegistryRef(waitId, action) {
  return `${WAIT_REGISTRY_REF_ROOT}/${refSegment(waitId)}/${action}`;
}

function trackingRoot(fingerprint) {
  return `${WAIT_REGISTRY_TRACKING_ROOT}/${String(fingerprint || "unknown").slice(0, 16)}`;
}

function coordination(root) {
  try {
    return orchestrationPolicy(projectConfig(root) ?? {}).coordination;
  } catch {
    return null;
  }
}

/** Builds the sealed payload of one record. */
export function buildWaitPayload({ waitId, action, waiter = null, on = null, until = null, reason = null, resolution = null, actor = null, createdAt }) {
  if (!ACTIONS.has(action)) throw new Error(`A wait record action must be open or resolve, not ${action}.`);
  return sealSharedPayload({
    kind: PAYLOAD_KIND,
    version: PAYLOAD_VERSION,
    wait_id: String(waitId),
    action,
    waiter: action === "open" ? { host: waiter?.host ?? null, story: waiter?.story ?? null } : null,
    on: action === "open" && on ? { type: String(on.type), ref: String(on.ref) } : null,
    until: action === "open" && until ? String(until) : null,
    reason: reason ? String(reason) : null,
    resolution: action === "resolve" && resolution ? String(resolution) : null,
    actor: actor ? { host: actor.host ?? null, name: actor.name ?? null } : null,
    created_at: String(createdAt),
  });
}

function recordsFromRefs(refs, { shared }) {
  return refs.flatMap(({ message }) => {
    const payload = parseSharedPayload(message);
    if (!isPlainRecord(payload) || payload.kind !== PAYLOAD_KIND || !ACTIONS.has(payload.action)) return [];
    return [{ ...payload, shared }];
  });
}

/**
 * Every explicit wait record known here: fetched from the remote when
 * `fetch` is true (one ls-remote and one fetch of the unseen ones), else only
 * the local copies. Never throws: an unreachable remote leaves the local ones.
 */
export function readWaitRecords(root, { fetch = false, timeoutSeconds = null } = {}) {
  const context = { root };
  const policy = coordination(root);
  const timeout = timeoutSeconds ?? policy?.timeout_seconds ?? 10;
  let note = null;
  if (fetch && policy) {
    const target = resolveSharedScope(context, policy, SETTING);
    if (target.scope === "shared" && !target.unavailable) {
      const read = readSharedRefs(context, {
        remote: target.remote,
        sharedRoot: WAIT_REGISTRY_REF_ROOT,
        trackingRoot: trackingRoot(target.fingerprint),
        timeoutSeconds: timeout,
        describe: (ref) => `the wait record ${ref.slice(WAIT_REGISTRY_REF_ROOT.length + 1)}`,
      });
      if (!read.available) note = `remote not readable (${read.error}): local copies only`;
    } else if (target.unavailable) note = target.unavailable;
  }
  const tracked = listLocalRefs(context, [`${WAIT_REGISTRY_TRACKING_ROOT}/`], timeout);
  const local = listLocalRefs(context, [`${WAIT_REGISTRY_REF_ROOT}/`], timeout);
  const records = [
    ...recordsFromRefs(tracked.refs ?? [], { shared: true }),
    ...recordsFromRefs(local.refs ?? [], { shared: false }),
  ];
  const seen = new Map();
  for (const record of records) {
    const key = `${record.wait_id}\u0000${record.action}`;
    const known = seen.get(key);
    // The shared copy wins over the local one; the first written wins between two shared ones.
    if (!known || (record.shared && !known.shared) || (record.shared === known.shared && String(record.created_at) < String(known.created_at))) seen.set(key, record);
  }
  return { records: [...seen.values()], note };
}

/** Writes one record: pushed create-only when the remote is shared, kept as a local ref otherwise. */
export function writeWaitRecord(root, payload) {
  const context = { root };
  const policy = coordination(root);
  if (!policy) throw new UserError("The project configuration (.sdlc/config.json) cannot be read: orchestration_policy.coordination is needed.");
  const timeoutSeconds = policy.timeout_seconds;
  const ref = waitRegistryRef(payload.wait_id, payload.action);
  const commit = writeRecordCommit(context, timeoutSeconds, serializeSharedPayload(payload));
  if (commit.error) throw new UserError(`The wait record could not be written in git: ${commit.error}`);
  const target = resolveSharedScope(context, policy, SETTING);
  if (target.scope === "shared" && !target.unavailable) {
    const trackingRef = `${trackingRoot(target.fingerprint)}/${ref.slice(WAIT_REGISTRY_REF_ROOT.length + 1)}`;
    const pushed = pushCreateOnlyRef(context, { url: target.url, ref, objectName: commit.objectName, trackingRef, timeoutSeconds });
    if (pushed.pushed) return { status: "shared", remote: target.remote, ref };
    const landed = remoteRefObject(context, target.url, ref, timeoutSeconds);
    if (landed.objectName === commit.objectName) {
      setLocalRef(context, trackingRef, commit.objectName, timeoutSeconds);
      return { status: "shared", remote: target.remote, ref };
    }
    if (landed.objectName) return { status: "exists", remote: target.remote, ref };
    const kept = createLocalRef(context, ref, commit.objectName, timeoutSeconds);
    return { status: "not_shared", remote: target.remote, ref, error: pushed.error || landed.error || "the remote refused the record", ...(kept.error ? { local_error: kept.error } : {}) };
  }
  const kept = createLocalRef(context, ref, commit.objectName, timeoutSeconds);
  if (kept.error) return { status: "exists", ref };
  return { status: "local", ref, note: target.unavailable || target.note || null };
}

// ---- memory of the rules (escalations sent, update requests) ------------------------------------------------

export function waitMemoryPath(root) {
  const common = findGitCommonDir(root);
  return common ? path.join(common, "agentic-sdlc", WAIT_MEMORY_FILE) : null;
}

export function readWaitMemory(root) {
  const file = waitMemoryPath(root);
  return (file && readJson(file)) || {};
}

export function writeWaitMemory(root, memory) {
  const file = waitMemoryPath(root);
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(memory)}\n`, { mode: 0o600 });
  } catch {
    // best effort: the worst case is one repeated message
  }
}

// ---- collection ---------------------------------------------------------------------------------------------

/** Story done here: closure record, final gate, lifecycle-complete report, or closed on the fetched base. */
function doneStories(root) {
  const sdlc = path.join(root, ".sdlc");
  const done = new Set();
  for (const id of listDir(path.join(sdlc, "stories"))) if (fs.existsSync(path.join(sdlc, "stories", id, "closure.json"))) done.add(id);
  for (const name of listDir(path.join(sdlc, "gates"))) if (name.endsWith("-final.json")) done.add(name.slice(0, -"-final.json".length));
  for (const name of listDir(path.join(sdlc, "reports"))) if (name.endsWith("-lifecycle-complete.json")) done.add(name.slice(0, -"-lifecycle-complete.json".length));
  return done;
}

function baseClosed(root) {
  try {
    return new Set(baseRecords(root)?.closed ?? []);
  } catch {
    return new Set();
  }
}

const STORY_STATE_ACTION = /^(?:story|gate|lifecycle|delivery)\./u;
const TRACE_TAIL_CHARS = 256 * 1024;

/**
 * True when the story changed state after `sinceMs`: a closure record exists or
 * its trace (tail) holds a story/gate/lifecycle/delivery action created later.
 */
export function storyChangedSince(root, storyId, sinceMs) {
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,80}$/u.test(String(storyId))) return false;
  const sdlc = path.join(root, ".sdlc");
  try {
    const closure = fs.statSync(path.join(sdlc, "stories", storyId, "closure.json"));
    if (closure.mtimeMs > sinceMs) return true;
  } catch {
    // no closure record
  }
  const file = path.join(sdlc, "traces", `${storyId}.jsonl`);
  let text;
  try {
    text = fs.readFileSync(file, "utf8").slice(-TRACE_TAIL_CHARS);
  } catch {
    return false;
  }
  return text.split("\n").some((line) => {
    if (!line.includes('"action"')) return false;
    try {
      const entry = JSON.parse(line);
      const at = Date.parse(entry.created_at ?? "");
      return Number.isFinite(at) && at > sinceMs && STORY_STATE_ACTION.test(String(entry.action ?? ""));
    } catch {
      return false;
    }
  });
}

/** The cached channel window and this computer's names (no network). */
export function cachedChannel(root, env = process.env) {
  try {
    const settings = settingsFor(root, env);
    if (!settings) return { messages: [], names: new Set(), own: new Set(), self: null };
    const state = readJson(settings.statePath) ?? {};
    const identity = resolveIdentity(root, env);
    const window = Array.isArray(state.attention?.window) ? state.attention.window : [];
    return { messages: window, names: new Set([...selfNamesOf(identity), hostLabel(env)].filter(Boolean)), own: new Set((state.own ?? []).map(String)), self: identity.name };
  } catch {
    return { messages: [], names: new Set(), own: new Set(), self: null };
  }
}

/**
 * Every wait of the project, explicit and derived, with the rules applied.
 *   messages/names/own  the channel (default: the cached window of the attention hook)
 *   approvals           approval requests (status passes them; hooks may pass a reader)
 *   delegations         delegation overview items
 *   fetch               read the explicit waits from the remote first
 * Returns { waits, freeze, actions, policy, note }.
 */
export function collectWaits(root, { env = process.env, now = Date.now(), channel = null, approvals = [], delegations = [], fetch = false, memory = null } = {}) {
  const policy = resolveWaitsPolicy(projectConfig(root));
  const sdlc = path.join(root, ".sdlc");
  const edges = readJson(path.join(sdlc, "dependencies", "graph.json"))?.edges ?? [];
  const done = doneStories(root);
  for (const id of baseClosed(root)) done.add(id);
  const chan = channel ?? cachedChannel(root, env);
  const { records, note } = readWaitRecords(root, { fetch });
  const explicit = interpretExplicitRecords(records, { now });
  const remembered = memory ?? readWaitMemory(root);
  const derived = [
    ...deriveDependencyWaits({ edges, isDone: (id) => done.has(id) }),
    ...deriveQuestionWaits({ messages: chan.messages, names: chan.names, own: chan.own, now, policy, storyChangedSince: (id, since) => storyChangedSince(root, id, since) }),
    ...derivePluginWaits({ messages: chan.messages, names: chan.names }),
    ...deriveFreezeWaits({ messages: chan.messages, now, policy }),
    ...deriveApprovalWaits(approvals),
    ...deriveDelegationWaits(delegations),
  ];
  const waits = applyWaitMemory([...explicit.waits, ...derived], { resolutions: explicit.resolutions, memory: remembered });
  const actions = planWaitActions(waits, { now, policy, memory: remembered });
  return { waits, freeze: policy.freezes_enabled ? activeFreeze(waits, now) : null, actions, policy, note };
}

/** Pending approvals and expired delegations through the engine (for the hooks); empty on any failure. */
export async function readHumanWaits(root) {
  try {
    const { buildContext } = await import("./common.mjs");
    const { collectPendingProposalRequests } = await import("./pending-proposals.mjs");
    const { delegationOverview } = await import("./delegation.mjs");
    const context = buildContext({ root });
    return { approvals: collectPendingProposalRequests(context), delegations: delegationOverview(context) };
  } catch {
    return { approvals: [], delegations: [] };
  }
}

// ---- CLI ----------------------------------------------------------------------------------------------------

function projectRoot(options) {
  return path.resolve(String(options.root || process.cwd()));
}

function emit(options, payload, lines) {
  if (options.json === true) console.log(JSON.stringify(payload, null, 2));
  else console.log(lines.join("\n"));
}

function actor(root, env) {
  try {
    return { host: hostLabel(env), name: resolveIdentity(root, env).name };
  } catch {
    return { host: null, name: null };
  }
}

function untilFrom(value, policy, nowMs) {
  const text = String(value ?? policy.explicit_default_until).trim();
  const seconds = parseLimitSeconds(text);
  const at = seconds ? nowMs + seconds * 1000 : Date.parse(text);
  if (!Number.isFinite(at) || at <= nowMs) throw new UserError("--until must be a duration such as 30m, 2h, 3d, or a future ISO time.");
  if (at - nowMs > policy.explicit_max_seconds * 1000) throw new UserError(`A wait lasts at most ${policy.explicit_max_seconds} seconds (host_policy.waits.explicit_max_until).`);
  return new Date(at).toISOString();
}

function sharedLine(result) {
  if (result.status === "shared") return `Condivisa tramite '${result.remote}' (${result.ref}): ogni computer la vede.`;
  if (result.status === "local") return `Registrata solo qui (${result.note ?? "nessun remote condiviso"}).`;
  if (result.status === "exists") return "Esisteva gia' un record con lo stesso id: nulla di nuovo scritto.";
  return `NON condivisa (${result.error}): tenuta come ref locale; rilancia quando il remote e' raggiungibile.`;
}

/** `wait add --on <type:ref> [--until <duration>] [--story <id>] [--reason <text>]` */
export async function waitAdd(options, env = process.env) {
  const root = projectRoot(options);
  const policy = resolveWaitsPolicy(projectConfig(root));
  const on = parseWaitTarget(options.on);
  if (on.error) throw new UserError(on.error);
  const nowMs = Date.now();
  const until = untilFrom(options.until, policy, nowMs);
  const story = options.story === undefined ? null : String(options.story).trim();
  if (story !== null && !/^[A-Za-z][A-Za-z0-9_.-]{0,80}$/u.test(story)) throw new UserError("--story must be a story id such as ST-UX-001.");
  const who = actor(root, env);
  const waitId = `WAIT-${new Date(nowMs).toISOString().replace(/\D/gu, "").slice(0, 14)}-${crypto.randomBytes(3).toString("hex")}`;
  const payload = buildWaitPayload({ waitId, action: "open", waiter: { host: who.host, story }, on, until, reason: options.reason ?? null, actor: who, createdAt: new Date(nowMs).toISOString() });
  const result = writeWaitRecord(root, payload);
  const out = { id: waitId, waiter: payload.waiter, on, until, reason: payload.reason, shared: result };
  emit(options, out, [`Attesa ${waitId}: ${story ?? who.host ?? "questo computer"} aspetta ${on.type}:${on.ref} fino a ${until}.`, sharedLine(result)]);
  return out;
}

/** `wait resolve --id <wait id> --resolution <text>`: explicit or derived (the decision recorded). */
export async function waitResolve(options, env = process.env) {
  const root = projectRoot(options);
  const id = String(options.id ?? "").trim();
  if (!EXPLICIT_ID.test(id) && !DERIVED_ID.test(id)) throw new UserError("--id must be a wait id as shown by wait list (WAIT-..., q:<message>, dep:<story>-><story>, approval:..., ...).");
  const resolution = String(options.resolution ?? "").trim();
  if (!resolution) throw new UserError("wait resolve needs --resolution <what was decided or happened>.");
  const known = readWaitRecords(root, { fetch: true }).records;
  if (EXPLICIT_ID.test(id) && !known.some((record) => record.wait_id === id && record.action === "open")) {
    throw new UserError(`No wait ${id} is known here. 'wait list' shows them.`);
  }
  const already = known.find((record) => record.wait_id === id && record.action === "resolve");
  if (already) {
    const out = { id, status: "already_resolved", resolution: already.resolution, resolved_at: already.created_at };
    emit(options, out, [`Attesa ${id} gia' risolta il ${already.created_at}: ${already.resolution ?? "-"}.`]);
    return out;
  }
  const who = actor(root, env);
  const payload = buildWaitPayload({ waitId: id, action: "resolve", resolution, actor: who, reason: options.reason ?? null, createdAt: new Date().toISOString() });
  const result = writeWaitRecord(root, payload);
  const out = { id, status: result.status === "exists" ? "already_resolved" : "resolved", resolution, shared: result };
  emit(options, out, [result.status === "exists" ? `Attesa ${id} gia' risolta da un altro computer.` : `Attesa ${id} risolta: ${resolution}.`, sharedLine(result)]);
  return out;
}

/** `wait list [--all] [--json]`: every wait, by waiter, with the suggested action. */
export async function waitList(options, env = process.env) {
  const root = projectRoot(options);
  const now = Date.now();
  const human = await readHumanWaits(root);
  const collected = await collectWaits(root, { env, now, fetch: options.offline !== true, ...human });
  const waits = options.all === true ? collected.waits : collected.waits.filter((item) => item.state !== "resolved");
  const payload = {
    count: waits.length,
    waits,
    by_waiter: waitsByWaiter(waits, { includeResolved: options.all === true }).map((group) => ({ waiter: group.waiter, ids: group.items.map((item) => item.id) })),
    freeze: collected.freeze,
    suggestions: collected.actions.suggestions,
    ...(collected.note ? { note: collected.note } : {}),
  };
  const lines = waits.length === 0
    ? ["Nessuna attesa aperta."]
    : options.all === true
      ? waits.map((item) => `- ${describeWait(item, now)}`)
      : waitStatusLines(waits, { now, limit: collected.policy.list_limit });
  if (collected.freeze) lines.push(`Freeze in corso fino a ${collected.freeze.until} (${collected.freeze.blocker.by ?? "?"}): niente merge/push su main e niente publish-records.`);
  for (const suggestion of collected.actions.suggestions) lines.push(`Suggerito: ${suggestion.text} -> \`${suggestion.command}\``);
  if (collected.note) lines.push(`Nota: ${collected.note}`);
  emit(options, payload, lines);
  return payload;
}
