import path from "node:path";

import { Date, fs, process } from "../runtime/host.mjs";
import { resolveMessagingConfig } from "../messaging/config.mjs";
import { PROVIDERS, resolveProvider } from "../messaging/commands.mjs";
import { pendingReplies } from "../messaging/kinds.mjs";
import { readTrackedSharedClaims } from "./shared-claims.mjs";

/**
 * "Now" panel: who is doing what across computers. Active claims come from
 * the local copies of the shared claim records, the workflow phase from the
 * local workflow checkpoints; when project messaging is configured, the
 * latest status of each sender, open questions and free computers come from
 * one bounded read of the topic, cached so the panel never waits on it.
 */
export const OBSERVATORY_NOW_SCHEMA_VERSION = "change-observatory:now:v1";
const ACTIVE_STATES = new Set(["claimed", "reserved", "parked"]);
const READ_SINCE = "12h";
const READ_TIMEOUT_MS = 2500;
const CACHE_MS = 30_000;
const MAX_TEXT = 200;
const MAX_OPEN = 10;
const MAX_MESSAGES = 300;

function shortText(value) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

function timeMs(value) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

const isStatus = (message) => message.kind === "info" && String(message.text ?? "").startsWith("[auto]");
const isOffer = (message) => message.kind === "offer";

/**
 * Pure model of the panel.
 *   claims     shared claims as `readTrackedSharedClaims` returns them
 *   phases     Map story id (upper case) -> { phase, since }
 *   messages   recent topic messages (any order), or null when messaging is off
 *   messaging  "off" | "on" | "unavailable"
 */
export function buildNowModel({ claims = [], phases = new Map(), messages = null, messaging = "off", nowMs = Date.now() } = {}) {
  const work = claims
    .filter((claim) => claim?.storyId && ACTIVE_STATES.has(claim.state))
    .map((claim) => {
      const phase = phases.get(String(claim.storyId).toUpperCase()) ?? null;
      return {
        storyId: claim.storyId,
        state: claim.state,
        who: claim.holder || claim.agent || null,
        agent: claim.agent ?? null,
        branch: claim.branch ?? null,
        phase: phase?.phase ?? null,
        phaseSince: phase?.since ?? null,
        since: claim.claimedAt ?? null,
        health: claim.health ?? null,
        expired: claim.expired === true,
      };
    })
    .sort((left, right) => left.storyId.localeCompare(right.storyId));
  const base = { schemaVersion: OBSERVATORY_NOW_SCHEMA_VERSION, generatedAt: new Date(nowMs).toISOString(), messaging, work };
  if (!Array.isArray(messages)) return { ...base, senders: [], open: [], free: [] };

  const ordered = messages
    .filter((message) => message && message.from)
    .slice()
    .sort((left, right) => (timeMs(left.time) ?? 0) - (timeMs(right.time) ?? 0));
  const bySender = new Map();
  for (const message of ordered) {
    const entry = bySender.get(message.from) ?? { from: message.from, status: null, last: null, offer: null };
    const item = { text: shortText(message.text), time: message.time ?? null, kind: message.kind ?? "info", story: message.story ?? null };
    if (isStatus(message)) entry.status = item;
    if (isOffer(message)) entry.offer = item;
    entry.last = item;
    bySender.set(message.from, entry);
  }
  const senders = [...bySender.values()]
    .map(({ from, status, last }) => ({ from, status, last }))
    .sort((left, right) => (timeMs(right.last?.time) ?? 0) - (timeMs(left.last?.time) ?? 0));
  // A computer is free when its latest presence is an offer, not a status.
  const free = [...bySender.values()]
    .filter((entry) => entry.offer && (timeMs(entry.offer.time) ?? 0) >= (timeMs(entry.status?.time) ?? -1))
    .map((entry) => ({ from: entry.from, time: entry.offer.time }))
    .sort((left, right) => left.from.localeCompare(right.from));
  const waiting = pendingReplies(ordered);
  const open = ordered
    .filter((message) => (waiting[message.id] ?? []).length > 0)
    .reverse()
    .slice(0, MAX_OPEN)
    .map((message) => ({
      id: message.id,
      from: message.from,
      kind: message.kind,
      to: message.to ?? null,
      story: message.story ?? null,
      text: shortText(message.text),
      time: message.time ?? null,
      waitingOn: waiting[message.id],
    }));
  return { ...base, senders, open, free };
}

function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Current workflow phase per story from the local checkpoints: Map id -> { phase, since }. */
export function readWorkflowPhases(projectRoot) {
  const dir = path.join(projectRoot, ".sdlc", "workflows", "instances");
  const phases = new Map();
  let ids = [];
  try {
    ids = fs.readdirSync(dir);
  } catch {
    return phases;
  }
  for (const id of ids) {
    const story = readJson(path.join(dir, id, "instance.json"))?.metadata?.governance_binding?.story_id;
    const checkpoint = readJson(path.join(dir, id, "checkpoint.json"));
    if (!story || !checkpoint?.current_state) continue;
    const key = String(story).toUpperCase();
    const since = checkpoint.updated_at ?? null;
    const known = phases.get(key);
    if (known && (timeMs(known.since) ?? 0) > (timeMs(since) ?? 0)) continue;
    phases.set(key, { phase: String(checkpoint.current_state), since });
  }
  return phases;
}

/**
 * Bounded, cached reader of the project topic. `read()` answers at once with
 * the last result and refreshes in the background once it is older than
 * CACHE_MS; only the very first read waits, at most READ_TIMEOUT_MS.
 */
export function createMessagingSnapshot(projectRoot, { env = process.env, providers = PROVIDERS, clock = () => Date.now() } = {}) {
  let cached = null;
  let pending = null;

  async function fetchOnce() {
    let config;
    try {
      config = resolveMessagingConfig(projectRoot, env);
    } catch {
      return { messaging: "unavailable", messages: null };
    }
    if (!config.enabled) return { messaging: "off", messages: null };
    try {
      const provider = resolveProvider(config, providers);
      const messages = await provider.poll({
        server: config.server,
        topic: config.topic,
        since: READ_SINCE,
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      });
      return { messaging: "on", messages: (Array.isArray(messages) ? messages : []).slice(-MAX_MESSAGES) };
    } catch {
      return { messaging: "unavailable", messages: null };
    }
  }

  function refresh() {
    if (!pending) {
      pending = fetchOnce()
        .then((value) => {
          cached = { at: clock(), value };
          return value;
        })
        .finally(() => {
          pending = null;
        });
    }
    return pending;
  }

  return {
    async read() {
      if (!cached) return refresh();
      if (clock() - cached.at >= CACHE_MS) refresh().catch(() => {});
      return cached.value;
    },
  };
}

/** The panel for one project: local records plus the cached messaging snapshot. */
export async function readNowView(projectRoot, { snapshot, nowMs = Date.now(), redact = (text) => text } = {}) {
  const claims = readTrackedSharedClaims(projectRoot, { nowMs }).claims;
  const phases = readWorkflowPhases(projectRoot);
  const { messaging, messages } = snapshot ? await snapshot.read() : { messaging: "off", messages: null };
  const model = buildNowModel({ claims, phases, messages, messaging, nowMs });
  const clean = (item) => (item && typeof item.text === "string" ? { ...item, text: redact(item.text) } : item);
  return {
    ...model,
    senders: model.senders.map((sender) => ({ ...sender, status: clean(sender.status), last: clean(sender.last) })),
    open: model.open.map(clean),
  };
}
