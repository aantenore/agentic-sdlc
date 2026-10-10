import path from "node:path";

import { Date, fs } from "./runtime/host.mjs";
import { PLUGIN_ROOT } from "./runtime/paths.mjs";
import { parseLimitSeconds } from "./runtime/bounded-child-process.mjs";
import { expectsReply, identityOf, pendingReplies } from "./messaging/kinds.mjs";
import { buildRoster } from "./messaging/roster.mjs";

/**
 * Waits registry: who (a computer or a story) waits for what, since when,
 * until when, and the rule that resolves the wait. Pure rules only; reading
 * the records and the channel is done by lib/engine/wait-registry.mjs.
 *
 * A wait is
 *   { id, source: "derived"|"explicit", waiter: { host, story }, blocker: { type, ref, ... },
 *     since, until, rule, state: open|resolved|expired|escalated, resolution, reason }
 *
 * Derived waits are computed every time from data that already exists
 * (dependencies, the channel, the roster, pending approvals, delegations) and
 * are never written. Explicit waits are declared with `wait add` and kept as
 * shared refs on the remote (see the engine module).
 */
export const WAIT_TYPES = Object.freeze(["person", "question", "story", "pr", "plugin_version", "freeze", "approval", "delegation"]);
export const WAIT_STATES = Object.freeze(["open", "resolved", "expired", "escalated", "stale"]);
export const WAIT_RULES = Object.freeze({
  question: "decide_and_announce",
  story: "dependency_merged",
  plugin_version: "request_update",
  freeze: "resume_after_freeze",
  approval: "escalate_once",
  delegation: "escalate_once",
  person: "escalate_once",
  pr: "check_on_expiry",
});
export const WAIT_DEFAULTS_FILE = path.join(PLUGIN_ROOT, "config", "waits.json");
export const UPDATE_COMMAND = "claude plugin marketplace update aantenore && claude plugin update agentic-sdlc@aantenore";
const ESCALATING = new Set(["approval", "delegation", "person"]);
const MEMORY_KEEP_MS = 30 * 24 * 3600 * 1000;
const MAX_TEXT = 140;
const SELF = "self";
const EVERYONE = "*";

let cachedDefaults = null;

export function waitDefaults() {
  if (!cachedDefaults) {
    try {
      cachedDefaults = JSON.parse(fs.readFileSync(WAIT_DEFAULTS_FILE, "utf8"));
    } catch {
      cachedDefaults = {};
    }
  }
  return cachedDefaults;
}

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function patterns(list) {
  return (Array.isArray(list) ? list : []).flatMap((source) => {
    try {
      return [new RegExp(String(source), "iu")];
    } catch {
      return [];
    }
  });
}

/** Effective policy: the plugin defaults (config/waits.json) overridden by `host_policy.waits`. */
export function resolveWaitsPolicy(config = null, defaults = waitDefaults()) {
  const own = config?.host_policy?.waits && typeof config.host_policy.waits === "object" ? config.host_policy.waits : {};
  const pick = (key, fallback) => positive(own[key], positive(defaults[key], fallback));
  return Object.freeze({
    question_decide_after_ms: pick("question_decide_after_minutes", 10) * 60_000,
    // Older than this a question/request is "stale": listed, never blocking (host_policy.waits.question_max_age).
    question_max_age_ms: (parseLimitSeconds(own.question_max_age ?? defaults.question_max_age ?? "2h") ?? 7200) * 1000,
    plugin_update_request_every_ms: pick("plugin_update_request_every_minutes", 60) * 60_000,
    freeze_default_ms: pick("freeze_default_minutes", 30) * 60_000,
    explicit_default_until: String(own.explicit_default_until ?? defaults.explicit_default_until ?? "2h"),
    explicit_max_seconds: parseLimitSeconds(own.explicit_max_until ?? defaults.explicit_max_until ?? "7d") ?? 7 * 86_400,
    escalate_approvals: (own.escalate_approvals ?? defaults.escalate_approvals) !== false,
    escalate_delegations: (own.escalate_delegations ?? defaults.escalate_delegations) !== false,
    list_limit: pick("list_limit", 20),
    freeze_patterns: patterns(Array.isArray(own.freeze_patterns) ? own.freeze_patterns : defaults.freeze_patterns),
  });
}

function timeMs(value) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function shortText(value) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

/** `tipo:ref` of `wait add --on`. Returns { type, ref } or { error }. */
export function parseWaitTarget(value) {
  const match = /^([a-z_]+):(.+)$/isu.exec(String(value ?? "").trim());
  const type = match?.[1]?.toLowerCase();
  if (!match || !WAIT_TYPES.includes(type)) return { error: `--on must be <type>:<ref> with type one of: ${WAIT_TYPES.join(", ")}.` };
  const ref = match[2].replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").trim().slice(0, 300);
  return ref ? { type, ref } : { error: `--on ${type}: needs what it waits on (message id, story id, PR, version...).` };
}

function wait({ id, source = "derived", waiter, blocker, since = null, until = null, state = "open", resolution = null, reason = null, extra = {} }) {
  return { id, source, waiter: { host: waiter?.host ?? null, story: waiter?.story ?? null }, blocker, since, until, rule: WAIT_RULES[blocker.type] ?? null, state, resolution, reason, ...extra };
}

/**
 * Story dependencies: an edge "from depends on to" (any type but relates)
 * whose target is not merged yet is an open wait of `from`; once the target is
 * merged and `from` is not done yet, the wait is resolved and `from` is ready.
 */
export function deriveDependencyWaits({ edges = [], isDone = () => false } = {}) {
  const out = [];
  const seen = new Set();
  for (const edge of edges) {
    if (!edge?.from || !edge?.to || edge.type === "relates" || isDone(edge.from)) continue;
    const id = `dep:${edge.from}->${edge.to}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const merged = isDone(edge.to);
    out.push(wait({
      id,
      waiter: { story: edge.from },
      blocker: { type: "story", ref: edge.to },
      state: merged ? "resolved" : "open",
      resolution: merged ? `${edge.to} mergiata: ${edge.from} pronta` : null,
    }));
  }
  return out;
}

const RELEASE_ANNOUNCEMENT = /\brilasciat[oa]\s+(?:il\s+plugin\s+)?agentic-sdlc\b|\bagentic-sdlc\s+v?\d+\.\d+\.\d+\s+rilasciat[oa]\b/iu;

/**
 * "rilasciato agentic-sdlc X" announcements: informational, superseded by the
 * next release, never a question waiting for a decision.
 */
export function isReleaseAnnouncement(message) {
  return RELEASE_ANNOUNCEMENT.test(String(message?.text ?? ""));
}

/** Messages in the reply-to thread of `message` (the root and everything replying down the chain). */
function threadMembers(messages, message) {
  const byId = new Map(messages.filter((m) => m?.id).map((m) => [String(m.id), m]));
  const rootOf = (m) => {
    let current = m;
    for (let hops = 0; current?.reply_to && byId.has(String(current.reply_to)) && hops < 50; hops += 1) current = byId.get(String(current.reply_to));
    return String(current?.id ?? "");
  };
  const root = rootOf(message);
  return root ? messages.filter((m) => m !== message && (rootOf(m) === root || String(m.reply_to ?? "") === String(message.id))) : [];
}

/**
 * Questions and requests on the channel still without an answer, with their
 * age. The asker waits; after `question_decide_after_ms` the wait is expired
 * and, for this computer's own questions, the rule suggests deciding; after
 * `question_max_age_ms` it is stale (listed, never blocking).
 *
 * Not waits at all: plugin release announcements; a request that got ANY
 * later message from the recipient in its reply-to thread (or an ack/answer);
 * a request naming a story (`message.story`) whose state changed since
 * (`storyChangedSince(storyId, sinceMs)`).
 */
export function deriveQuestionWaits({ messages = [], names = new Set(), own = new Set(), now = Date.now(), policy = resolveWaitsPolicy(), storyChangedSince = () => false } = {}) {
  const waiting = pendingReplies(messages);
  const mine = (m) => names.has(m.from) || names.has(identityOf(m)) || own.has(String(m.id));
  const position = new Map(messages.map((m, index) => [m, index]));
  const later = (a, b) => {
    const left = timeMs(a.time);
    const right = timeMs(b.time);
    return left !== null && right !== null ? left > right : position.get(a) > position.get(b);
  };
  return messages
    .filter((m) => expectsReply(m) && m.id && !String(m.text ?? "").startsWith("[auto]") && !isReleaseAnnouncement(m))
    .flatMap((m) => {
      const since = timeMs(m.time);
      const repliers = new Set(threadMembers(messages, m).filter((other) => later(other, m)).map(identityOf));
      const waitingOn = (waiting[m.id] ?? []).filter((sender) => !repliers.has(sender));
      if (waitingOn.length === 0) return [];
      if (m.story && since !== null && storyChangedSince(m.story, since)) return [];
      const deadline = since === null ? null : since + policy.question_decide_after_ms;
      const stale = since !== null && now - since >= policy.question_max_age_ms;
      return [wait({
        id: `q:${m.id}`,
        waiter: { host: mine(m) ? SELF : identityOf(m), story: m.story ?? null },
        blocker: { type: "question", ref: String(m.id), waiting_on: waitingOn, text: shortText(m.text) },
        since: m.time ?? null,
        until: iso(deadline),
        state: stale ? "stale" : deadline !== null && now >= deadline ? "expired" : "open",
        extra: { mine: mine(m) },
      })];
    });
}

/** Computers of the channel with an older plugin than the newest seen: the channel waits for their update. */
export function derivePluginWaits({ messages = [], names = new Set(), currentVersion } = {}) {
  const roster = buildRoster(messages, currentVersion ? { currentVersion } : {});
  return roster.participants
    .filter((entry) => entry.outdated && entry.host && !names.has(entry.host) && !names.has(entry.name))
    .map((entry) => wait({
      id: `plugin:${entry.host}`,
      waiter: { host: EVERYONE },
      blocker: { type: "plugin_version", ref: entry.host, name: entry.name, version: entry.version, newest: roster.newest_version },
      since: entry.last_seen,
    }));
}

/**
 * End of a freeze announced on the channel: an explicit `--kind freeze`
 * message with `until`, else an announcement such as "30 minuti senza
 * merge/push su main" (patterns in host_policy.waits.freeze_patterns).
 */
export function freezeUntil(message, policy = resolveWaitsPolicy()) {
  const start = timeMs(message?.time);
  if (message?.kind === "freeze") {
    const until = timeMs(message.until);
    if (until !== null) return until;
    return start === null ? null : start + policy.freeze_default_ms;
  }
  if (start === null) return null;
  for (const pattern of policy.freeze_patterns) {
    const match = pattern.exec(String(message?.text ?? ""));
    if (match) return start + positive(match[1], policy.freeze_default_ms / 60_000) * 60_000;
  }
  return null;
}

export function deriveFreezeWaits({ messages = [], now = Date.now(), policy = resolveWaitsPolicy() } = {}) {
  return messages.flatMap((m) => {
    if (!m?.id || String(m.text ?? "").startsWith("[auto]")) return [];
    const until = freezeUntil(m, policy);
    if (until === null) return [];
    return [wait({
      id: `freeze:${m.id}`,
      waiter: { host: EVERYONE },
      blocker: { type: "freeze", ref: String(m.id), by: m.from ?? identityOf(m), text: shortText(m.text) },
      since: m.time ?? null,
      until: iso(until),
      state: now < until ? "open" : "expired",
    })];
  });
}

/** The freeze in force now (the one that ends last), or null. */
export function activeFreeze(waits = [], now = Date.now()) {
  return waits
    .filter((item) => item.blocker?.type === "freeze" && item.state === "open" && (timeMs(item.until) ?? 0) > now)
    .sort((a, b) => (timeMs(b.until) ?? 0) - (timeMs(a.until) ?? 0))[0] ?? null;
}

/** Proposals waiting for a person (status approval requests): { id, subject_id, story_id, summary, suggested_command }. */
export function deriveApprovalWaits(requests = []) {
  return requests.filter((request) => request?.id).map((request) => wait({
    id: `approval:${request.id}`,
    waiter: { host: SELF, story: request.story_id ?? null },
    blocker: { type: "approval", ref: String(request.subject_id ?? request.id), command: request.suggested_command ?? null, text: shortText(request.summary) },
  }));
}

/** Expired approval delegations: the agent waits for a person to grant them again. */
export function deriveDelegationWaits(delegations = []) {
  return delegations.filter((item) => item?.id && item.state === "expired").map((item) => wait({
    id: `delegation:${item.id}`,
    waiter: { host: SELF },
    blocker: {
      type: "delegation",
      ref: item.id,
      command: `agentic-sdlc autonomy delegation grant --id ${item.id} --scope ${item.scope ?? "project"} --actions ${(item.actions ?? []).join(",") || "<azioni>"} --until <durata> --summary "<decisione>" --actor-type human --approval-source explicit-user`,
    },
    since: item.expires_at ?? null,
    until: item.expires_at ?? null,
    state: "expired",
  }));
}

/**
 * Explicit records ({ wait_id, action: open|resolve, ... }) as waits and as
 * resolutions of derived waits (a `resolve` without `open`).
 */
export function interpretExplicitRecords(records = [], { now = Date.now() } = {}) {
  const byId = new Map();
  for (const record of records) {
    if (!record?.wait_id || !["open", "resolve"].includes(record.action)) continue;
    const entry = byId.get(record.wait_id) ?? {};
    if (!entry[record.action] || String(record.created_at) < String(entry[record.action].created_at)) entry[record.action] = record;
    byId.set(record.wait_id, entry);
  }
  const waits = [];
  const resolutions = new Map();
  for (const [id, entry] of byId) {
    if (entry.resolve) resolutions.set(id, entry.resolve);
    if (!entry.open) continue;
    const opened = entry.open;
    const until = timeMs(opened.until);
    waits.push(wait({
      id,
      source: "explicit",
      waiter: opened.waiter,
      blocker: { type: opened.on?.type, ref: opened.on?.ref },
      since: opened.created_at ?? null,
      until: opened.until ?? null,
      reason: opened.reason ?? null,
      state: entry.resolve ? "resolved" : until !== null && now >= until ? "expired" : "open",
      resolution: entry.resolve?.resolution ?? null,
      extra: { shared: opened.shared ?? null },
    }));
  }
  return { waits, resolutions };
}

/** Derived waits closed by `wait resolve` (the decision recorded) and the ones already escalated here. */
export function applyWaitMemory(waits, { resolutions = new Map(), memory = {} } = {}) {
  const escalated = memory.escalated ?? {};
  return waits.map((item) => {
    const resolved = resolutions.get(item.id);
    if (resolved && item.state !== "resolved") return { ...item, state: "resolved", resolution: resolved.resolution ?? null };
    if (escalated[item.id] && (item.state === "open" || item.state === "expired")) return { ...item, state: "escalated", escalated_at: iso(escalated[item.id]) };
    return item;
  });
}

function prune(map = {}, now) {
  return Object.fromEntries(Object.entries(map).filter(([, at]) => Number.isFinite(Number(at)) && now - Number(at) < MEMORY_KEEP_MS));
}

/**
 * The resolution rules. Returns the suggestions for the agent, the messages
 * to send (each once: memory keeps when) and the new memory.
 *   memory  { escalated: { waitId: ms }, update_requests: { host: ms } }
 */
export function planWaitActions(waits = [], { now = Date.now(), policy = resolveWaitsPolicy(), memory = {} } = {}) {
  const escalated = prune(memory.escalated, now);
  const updates = prune(memory.update_requests, now);
  const suggestions = [];
  const messages = [];
  for (const item of waits) {
    const type = item.blocker?.type;
    if (type === "question" && item.mine && item.state === "expired") {
      const minutes = Math.round((now - (timeMs(item.since) ?? now)) / 60_000);
      suggestions.push({
        wait_id: item.id,
        text: `nessuna risposta a #${item.blocker.ref} da ${minutes} min (${item.blocker.text}): decidi, annuncia la decisione e procedi`,
        command: `agentic-sdlc message send --kind info${item.waiter.story ? ` --story ${item.waiter.story}` : ""} --text "Decisione su #${item.blocker.ref}: <decisione>" && agentic-sdlc wait resolve --id ${item.id} --resolution "<decisione>"`,
      });
    } else if (type === "story" && item.state === "resolved" && item.source === "derived") {
      suggestions.push({
        wait_id: item.id,
        text: `${item.blocker.ref} mergiata: ${item.waiter.story} e' pronta, avvia subito`,
        command: `agentic-sdlc story claim --id ${item.waiter.story} --agent <nome>`,
        ready: item.waiter.story,
      });
    } else if (type === "plugin_version" && item.state === "open") {
      const last = Number(updates[item.blocker.ref] ?? 0);
      if (now - last >= policy.plugin_update_request_every_ms) {
        updates[item.blocker.ref] = now;
        messages.push({
          wait_id: item.id,
          kind: "request",
          to: item.blocker.ref,
          text: `[auto] aggiorna il plugin: hai ${item.blocker.version ?? "?"}, l'ultima e' ${item.blocker.newest} -> \`${UPDATE_COMMAND}\` poi /reload-plugins`,
        });
      }
    } else if (type === "freeze" && item.state === "expired") {
      const ended = timeMs(item.until) ?? 0;
      if (now - ended < policy.freeze_default_ms) {
        suggestions.push({ wait_id: item.id, text: `freeze di ${item.blocker.by ?? "un computer"} finito: riprendi le azioni sospese (record da pubblicare, push, merge)`, command: "agentic-sdlc next" });
      }
    } else if (ESCALATING.has(type) && (item.state === "open" || item.state === "expired") && !escalated[item.id]) {
      const enabled = type === "approval" ? policy.escalate_approvals : type === "delegation" ? policy.escalate_delegations : item.state === "expired";
      if (!enabled || (item.source === "explicit" && item.state !== "expired")) continue;
      escalated[item.id] = now;
      const command = item.blocker.command ? ` -> \`${item.blocker.command}\`` : "";
      messages.push({
        wait_id: item.id,
        kind: "request",
        to: null,
        story: item.waiter.story ?? null,
        text: `[auto] serve una persona (${type} ${item.blocker.ref})${item.blocker.text ? `: ${item.blocker.text}` : item.reason ? `: ${item.reason}` : ""}${command}`,
      });
    } else if (item.source === "explicit" && item.state === "expired") {
      suggestions.push({ wait_id: item.id, text: `attesa ${item.id} su ${type}:${item.blocker.ref} scaduta: verifica e decidi`, command: `agentic-sdlc wait resolve --id ${item.id} --resolution "<esito>"` });
    }
  }
  return { suggestions, messages, memory: { ...memory, escalated, update_requests: updates } };
}

/**
 * Changes between two snapshots ({ id: state }) that wake a watch: a wait
 * resolved, expired or escalated, or gone (counted as resolved).
 */
export function waitTransitions(previous = {}, waits = []) {
  const current = new Map(waits.map((item) => [item.id, item]));
  const events = [];
  for (const item of waits) {
    const before = previous[item.id];
    if (before === undefined) {
      if (item.state === "resolved" && item.source === "derived") continue;
      if (item.state !== "open" && item.state !== "stale") events.push({ id: item.id, from: null, to: item.state, wait: item });
      continue;
    }
    if (before !== item.state && item.state !== "open" && item.state !== "stale") events.push({ id: item.id, from: before, to: item.state, wait: item });
  }
  for (const [id, before] of Object.entries(previous)) {
    if (!current.has(id) && before !== "resolved") events.push({ id, from: before, to: "resolved", wait: null });
  }
  return events;
}

export function waitSnapshot(waits = []) {
  return Object.fromEntries(waits.map((item) => [item.id, item.state]));
}

function age(ms, now) {
  if (ms === null) return "?";
  const minutes = Math.max(0, Math.round((now - ms) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} g`;
}

const TYPE_LABEL = Object.freeze({
  person: "una persona",
  question: "risposta a",
  story: "la story",
  pr: "la PR",
  plugin_version: "aggiornamento plugin di",
  freeze: "fine freeze",
  approval: "approvazione umana di",
  delegation: "nuova delega",
});

export function waiterLabel(waiter = {}) {
  const host = waiter.host === SELF ? "questo computer" : waiter.host === EVERYONE ? "tutti" : waiter.host;
  return [waiter.story, host].filter(Boolean).join(" @ ") || "questo computer";
}

/** One line: "<what> da <age>, scadenza <time> [stato]". */
export function describeWait(item, now = Date.now()) {
  const until = timeMs(item.until);
  const deadline = until === null ? "" : until > now ? `, scade tra ${age(now - (until - now), now)}` : `, scaduta da ${age(until, now)}`;
  const waitingOn = Array.isArray(item.blocker?.waiting_on) && item.blocker.waiting_on.length > 0 ? ` (attende ${item.blocker.waiting_on.join(", ")})` : "";
  const state = item.state === "open" ? "" : ` [${item.state}${item.resolution ? `: ${shortText(item.resolution)}` : ""}]`;
  return `${TYPE_LABEL[item.blocker?.type] ?? item.blocker?.type} ${item.blocker?.ref}${waitingOn} da ${age(timeMs(item.since), now)}${deadline}${state} (${item.id})`;
}

/** Open, expired and escalated waits grouped by waiter: [{ waiter, items }]. */
export function waitsByWaiter(waits = [], { includeResolved = false } = {}) {
  const groups = new Map();
  for (const item of waits) {
    if (!includeResolved && item.state === "resolved") continue;
    const key = waiterLabel(item.waiter);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups].map(([waiter, items]) => ({ waiter, items })).sort((a, b) => a.waiter.localeCompare(b.waiter));
}

/** Lines of the "In attesa di" section of status, per waiter. */
export function waitStatusLines(waits = [], { now = Date.now(), limit = 20 } = {}) {
  const groups = waitsByWaiter(waits);
  if (groups.length === 0) return [];
  const lines = ["In attesa di:"];
  let shown = 0;
  for (const group of groups) {
    lines.push(`  ${group.waiter}:`);
    for (const item of group.items) {
      if (shown >= limit) break;
      lines.push(`    - ${describeWait(item, now)}`);
      shown += 1;
    }
  }
  const total = groups.reduce((sum, group) => sum + group.items.length, 0);
  if (total > shown) lines.push(`  ... e altre ${total - shown}`);
  return lines;
}
