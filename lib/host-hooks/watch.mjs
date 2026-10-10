import path from "node:path";

import { childProcess, console, Date, fs, process } from "../runtime/host.mjs";
import { parseLimitSeconds } from "../runtime/bounded-child-process.mjs";
import { findGitCommonDir } from "../runtime/run-registry.mjs";
import { storyLabel } from "../engine/story-label.mjs";
import { safeGitRemoteName } from "../engine/git-remote-name.mjs";
import { VERSION } from "../engine/definitions.mjs";
import { cursorOf, isCursor } from "../messaging/cursor.mjs";
import { identityOf, newerVersionSeen } from "../messaging/kinds.mjs";
import { describeWait, waitSnapshot, waitTransitions } from "../waits-registry.mjs";
import { describePreparedStart, resolvePreparedStartsFor } from "./prepared-starts.mjs";
import {
  baseRecords,
  CLOSED_CLAIM_STATUSES,
  foreignWindowMs,
  gitLines,
  gitShowJson,
  heldClaimRefs,
  isFreshForeignStory,
  isOpenStoryKind,
  keepGoingWork,
  remoteBaseRef,
} from "./keep-going.mjs";

/**
 * `agentic-sdlc watch`: an alarm for an idle agent. It waits in the
 * background for the first RELEVANT event and exits printing a short summary,
 * so the host (Claude Code: Bash `run_in_background` re-invokes the agent when
 * the command exits; other hosts: any background process with a deadline)
 * wakes the agent. On timeout it exits 0 with "nessun evento" and the agent
 * re-arms it.
 *
 * Relevant events:
 *   - a new message on the channel for this computer or for everyone (question,
 *     request, answer to one of mine, offer, any message of another computer whatever its kind, never my
 *     own and never the `[auto]` status messages of other computers, except
 *     "released and free to take" / story offers;
 *   - a new story offered here (not owned by another host: the keep-going rule);
 *   - a new plugin release announced by another computer;
 *   - a wait of the registry (see `wait list`) that expires, is resolved or
 *     escalated (for example a dependency merged: the waiting story is ready).
 *
 * Settings (environment, nothing else is hardcoded):
 *   AGENTIC_SDLC_WATCH_TIMEOUT         default deadline (default 30m; --timeout wins)
 *   AGENTIC_SDLC_WATCH_POLL_SECONDS    gap between two channel reads (default 30)
 *   AGENTIC_SDLC_WATCH_STORY_SECONDS   gap between two story scans (default 120)
 *   AGENTIC_SDLC_WATCH_FETCH           off = never `git fetch` the remote for stories
 *   AGENTIC_SDLC_WATCH_STALE_SECONDS   heartbeat age after which a watch counts as gone (default 180)
 *   AGENTIC_SDLC_WATCH_PROMPT          off = the Stop hook never asks to arm a watch
 *   AGENTIC_SDLC_WATCH_PROMPT_MINUTES  minimum gap between two Stop-hook requests (default 10)
 *
 * State (git common dir, per clone): agentic-sdlc/watch.json is owned by the
 * watch (pid, heartbeat, channel cursor, stories already seen);
 * agentic-sdlc/watch-hook.json is owned by the Stop hook (last request).
 */
export const WATCH_ENV = Object.freeze({
  timeout: "AGENTIC_SDLC_WATCH_TIMEOUT",
  poll: "AGENTIC_SDLC_WATCH_POLL_SECONDS",
  story: "AGENTIC_SDLC_WATCH_STORY_SECONDS",
  fetch: "AGENTIC_SDLC_WATCH_FETCH",
  stale: "AGENTIC_SDLC_WATCH_STALE_SECONDS",
  prompt: "AGENTIC_SDLC_WATCH_PROMPT",
  promptMinutes: "AGENTIC_SDLC_WATCH_PROMPT_MINUTES",
});
export const WATCH_STATE_FILE = "watch.json";
export const WATCH_HOOK_STATE_FILE = "watch-hook.json";
export const DEFAULT_TIMEOUT = "30m";
export const DEFAULT_POLL_SECONDS = 30;
export const DEFAULT_STORY_SECONDS = 120;
export const DEFAULT_STALE_SECONDS = 180;
export const DEFAULT_PROMPT_MINUTES = 10;
export const WATCH_COMMAND = "agentic-sdlc watch --timeout 30m";
export const NO_EVENT_TEXT = "nessun evento";
const FIRST_READ_SINCE = "30m";
const KNOWN_LIMIT = 500;
const MAX_TEXT = 140;
const FETCH_TIMEOUT_MS = 20_000;
const OFF_VALUES = new Set(["0", "false", "no", "off", "disabled"]);
const HANDSHAKE = new Set(["join", "welcome"]);

function positiveSeconds(value, fallback) {
  const parsed = parseLimitSeconds(value);
  return parsed && parsed > 0 ? parsed : fallback;
}

function isOff(value) {
  return OFF_VALUES.has(String(value ?? "").trim().toLowerCase());
}

function shortText(value) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  } catch {
    // best effort: a missing state only costs a repeated request or a re-read
  }
}

export function watchStatePath(commonDir) {
  return commonDir ? path.join(commonDir, "agentic-sdlc", WATCH_STATE_FILE) : null;
}

function alive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** True when a watch of this clone is running: live pid and a recent heartbeat. */
export function watchActive(commonDir, { env = process.env, now = Date.now(), isAlive = alive } = {}) {
  const file = watchStatePath(commonDir);
  if (!file) return false;
  const state = readJson(file);
  if (!state.pid || !Number.isFinite(Number(state.heartbeat))) return false;
  const staleMs = positiveSeconds(env[WATCH_ENV.stale], DEFAULT_STALE_SECONDS) * 1000;
  return now - Number(state.heartbeat) < staleMs && isAlive(state.pid);
}

/**
 * Stop-hook side. Returns the reason to block ONCE when this computer is idle
 * and no watch is armed, else null. At most one request per window (default
 * 10 minutes); the time is recorded when the request is made.
 */
export function watchPromptDecision(commonDir, { env = process.env, now = Date.now(), isAlive = alive } = {}) {
  if (!commonDir || isOff(env[WATCH_ENV.prompt])) return null;
  if (watchActive(commonDir, { env, now, isAlive })) return null;
  const file = path.join(commonDir, "agentic-sdlc", WATCH_HOOK_STATE_FILE);
  const minutes = Number(env[WATCH_ENV.promptMinutes]);
  const windowMs = (Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_PROMPT_MINUTES) * 60_000;
  const last = Number(readJson(file).blocked_at);
  if (Number.isFinite(last) && now - last < windowMs) return null;
  writeJson(file, { blocked_at: now });
  return `nessun lavoro ora: prima di fermarti lancia in background (run_in_background) \`${WATCH_COMMAND}\` così vieni risvegliato da nuovi messaggi o story; quando esce, gestisci l'evento e rilancialo`;
}

const RELEASED_OFFER = /^\[auto\]\s+(\S+?)\s+released and free to take/iu;
const TERMINAL_STORY_STATUS = new Set(["merged", "done", "completed", "closed", "complete"]);

/** An `[auto]` "released and free to take" offer for a story that is already completed is not work. */
function releasedTerminal(message, isTerminal) {
  if (typeof isTerminal !== "function") return false;
  const id = RELEASED_OFFER.exec(String(message.text ?? ""))?.[1] ?? null;
  if (!id) return false;
  try {
    return isTerminal(message.story || id) === true;
  } catch {
    return false;
  }
}

/**
 * True when the story is terminal on the fetched remote base: closure record,
 * lifecycle-complete (final gate) report, completed operations step, or a
 * merged/done story status. Unknown base or story: false (the offer passes).
 */
export function storyTerminalOnBase(root, storyId, { ref = remoteBaseRef(root) } = {}) {
  if (!ref || !storyId) return false;
  const dir = `.sdlc/stories/${storyId}`;
  const files = new Set(gitLines(root, ["ls-tree", "-r", "--name-only", ref, "--", dir, `.sdlc/reports/${storyId}-lifecycle-complete.json`]) ?? []);
  if (files.has(`${dir}/closure.json`) || files.has(`.sdlc/reports/${storyId}-lifecycle-complete.json`)) return true;
  if (files.has(`${dir}/steps/operations.json`) && String(gitShowJson(root, `${ref}:${dir}/steps/operations.json`)?.status ?? "") === "completed") return true;
  const story = files.has(`${dir}/story.json`) ? gitShowJson(root, `${ref}:${dir}/story.json`) : null;
  const status = String(story?.status ?? story?.workflow?.phase ?? story?.workflow?.state ?? "").toLowerCase();
  return TERMINAL_STORY_STATUS.has(status) || status === "operations";
}

/**
 * Pure: the relevant events among `messages`: every message of another
 * computer, whatever its kind (none, info, answer, ack...), except my own,
 * join/welcome handshakes and the `[auto]` status messages (offers pass).
 *   names  every name/host this computer sent under; own  ids of its messages
 * Returns [{ type: "plugin"|"offer"|"question"|"answer"|"message", message }].
 */
export function relevantMessageEvents(messages, { names = new Set(), own = new Set(), installedVersion = VERSION, isTerminal = null } = {}) {
  const mine = (m) => names.has(m.from) || names.has(identityOf(m)) || own.has(String(m.id));
  const others = messages.filter((m) => m?.id && !HANDSHAKE.has(m.kind) && !mine(m));
  const events = [];
  const plugin = newerVersionSeen(others, installedVersion);
  const pluginMessage = plugin ? others.find((m) => m.version === plugin.version) : null;
  if (pluginMessage) events.push({ type: "plugin", message: pluginMessage });
  const answeredByMe = new Set(messages.filter((m) => (m.kind === "answer" || m.kind === "ack") && m.reply_to && mine(m)).map((m) => String(m.reply_to)));
  for (const m of others) {
    if (m === pluginMessage) continue;
    if (String(m.text ?? "").startsWith("[auto]")) {
      if (m.kind === "offer" && !releasedTerminal(m, isTerminal)) events.push({ type: "offer", message: m });
      continue;
    }
    if (m.kind === "offer") events.push({ type: "offer", message: m });
    else if (m.kind === "question" || m.kind === "request") {
      if (!answeredByMe.has(String(m.id))) events.push({ type: "question", message: m });
    } else if (m.kind === "answer" || m.kind === "ack") events.push({ type: "answer", message: m });
    else events.push({ type: "message", message: m });
  }
  return events;
}

const TYPE_LABEL = Object.freeze({ question: "domanda", answer: "risposta", offer: "offerta", message: "messaggio" });

const WAIT_STATE_LABEL = Object.freeze({ resolved: "risolta", expired: "scaduta", escalated: "passata a una persona" });

export function describeEvent(event, { label = (id) => id, now = Date.now() } = {}) {
  if (event.type === "story") return `nuova story libera ${label(event.story)}`;
  if (event.type === "prepared") return `avvio preparato: ${describePreparedStart(event.item)}`;
  if (event.type === "wait") {
    const { id, to, wait } = event.transition;
    const ready = wait?.blocker?.type === "story" && to === "resolved" ? `: ${label(wait.waiter.story)} e' pronta, avvia subito -> \`agentic-sdlc story claim --id ${wait.waiter.story} --agent <nome>\`` : "";
    return `attesa ${WAIT_STATE_LABEL[to] ?? to}: ${wait ? describeWait(wait, now) : id}${ready}`;
  }
  const m = event.message;
  if (event.type === "plugin") return `nuova release del plugin ${m.version} annunciata da ${m.from ?? identityOf(m) ?? "un computer"}: aggiorna con \`claude plugin marketplace update aantenore && claude plugin update agentic-sdlc@aantenore\``;
  const host = m.host && m.host !== m.from ? ` · ${m.host}` : "";
  const story = m.story ? ` su ${label(m.story)}` : "";
  const re = m.reply_to ? ` re #${m.reply_to}` : "";
  return `${TYPE_LABEL[event.type] ?? "messaggio"} di ${m.from ?? identityOf(m) ?? "un computer"}${host}${story} (#${m.id}${re}): ${shortText(m.text)}`;
}

function fetchRemote(root, env) {
  if (isOff(env[WATCH_ENV.fetch])) return;
  try {
    const config = readJson(path.join(root, ".sdlc", "config.json"));
    const { remote } = safeGitRemoteName(config.orchestration_policy?.coordination?.remote, root);
    if (!remote) return;
    childProcess.spawnSync("git", ["-C", root, "fetch", "--quiet", remote], {
      timeout: FETCH_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      windowsHide: true,
      stdio: "ignore",
    });
  } catch {
    // offline: the scan works on what is already fetched
  }
}

/** Stories on the fetched remote base that this clone does not have yet and are offerable here. [{ id, own }] */
function remoteStories(root, { selfHost, selfEmail, now, env }) {
  const ref = remoteBaseRef(root);
  if (!ref) return [];
  const files = gitLines(root, ["ls-tree", "-r", "--name-only", ref, "--", ".sdlc/stories"]) ?? [];
  const closed = new Set(baseRecords(root)?.closed ?? []);
  const held = heldClaimRefs(root);
  const claimed = new Set();
  const withStory = [];
  for (const file of files) {
    const match = /^\.sdlc\/stories\/([^/]+)\/(story|claim)\.json$/u.exec(file);
    if (!match) continue;
    if (match[2] === "story") withStory.push(match[1]);
    else if (!CLOSED_CLAIM_STATUSES.has(String(gitShowJson(root, `${ref}:${file}`)?.status ?? "").toLowerCase())) claimed.add(match[1]);
  }
  const out = [];
  for (const id of withStory) {
    if (closed.has(id) || claimed.has(id) || held.has(id)) continue;
    const story = gitShowJson(root, `${ref}:.sdlc/stories/${id}/story.json`);
    if (!story || !isOpenStoryKind(story)) continue;
    if (isFreshForeignStory(story, { selfHost, selfEmail, now, windowMs: foreignWindowMs(env) })) continue;
    out.push({ id, own: Boolean(selfHost) && story.audit?.run?.host === selfHost });
  }
  return out;
}

/** Stories this computer could take now: local ones (keep-going rule) plus the ones only on the fetched remote base. [{ id, own }] */
export async function scanStories(root, { env = process.env, now = Date.now() } = {}) {
  fetchRemote(root, env);
  const work = await keepGoingWork(root, { env, now });
  const { hostLabel } = await import("../messaging/commands.mjs");
  const selfHost = hostLabel(env);
  const selfEmail = gitLines(root, ["config", "user.email"])?.[0] ?? null;
  const local = (work.ready ?? work.available ?? []).map((id) => {
    const story = readJson(path.join(root, ".sdlc", "stories", id, "story.json"));
    return { id, own: Boolean(selfHost) && story.audit?.run?.host === selfHost };
  });
  const seen = new Set(local.map((item) => item.id));
  return [...local, ...remoteStories(root, { selfHost, selfEmail, now, env }).filter((item) => !seen.has(item.id))];
}

/** The channel as the watch needs it; null provider when messaging is off. */
export async function createWatchContext(root, { env = process.env, providers } = {}) {
  const scanWaits = async () => (await (await import("../engine/wait-registry.mjs")).collectWaits(root, { env })).waits;
  const context = { provider: null, config: null, names: new Set(), own: new Set(), label: (id) => storyLabel(root, id, env), scanStories: () => scanStories(root, { env }), scanWaits, isTerminal: (id) => { fetchRemote(root, env); return storyTerminalOnBase(root, id); } };
  context.resolvePrepared = () => resolvePreparedStartsFor(root, { env });
  try {
    const { settingsFor } = await import("../messaging/attention.mjs");
    const settings = settingsFor(root, env);
    if (!settings) return context;
    const { PROVIDERS, resolveProvider, hostLabel } = await import("../messaging/commands.mjs");
    const { resolveIdentity, selfNamesOf } = await import("../messaging/identity.mjs");
    const { ownMessageIds } = await import("../messaging/auto.mjs");
    const identity = resolveIdentity(root, env);
    context.config = settings.config;
    context.provider = resolveProvider(settings.config, providers ?? PROVIDERS);
    context.names = new Set([...selfNamesOf(identity), hostLabel(env)].filter(Boolean));
    context.refreshOwn = () => ownMessageIds(root, env);
    context.own = await context.refreshOwn();
  } catch {
    context.provider = null;
  }
  return context;
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isoNow(now) {
  return new Date(now).toISOString().replace(/\.\d{3}Z$/u, "Z");
}

/**
 * Waits for the first relevant event. Returns
 * { status: "event"|"timeout"|"active", events, summary }.
 * `context` (see createWatchContext) and `sleep`/`now` are injectable for tests.
 */
export async function runWatch(root, { env = process.env, timeout, context = null, now = () => Date.now(), sleep = realSleep, signal = null, pid = process.pid, isAlive = alive } = {}) {
  const commonDir = findGitCommonDir(root);
  const stateFile = watchStatePath(commonDir);
  const ctx = context ?? await createWatchContext(root, { env });
  const timeoutSeconds = positiveSeconds(timeout ?? env[WATCH_ENV.timeout], positiveSeconds(DEFAULT_TIMEOUT, 1800));
  const pollMs = positiveSeconds(env[WATCH_ENV.poll], DEFAULT_POLL_SECONDS) * 1000;
  const storyMs = positiveSeconds(env[WATCH_ENV.story], DEFAULT_STORY_SECONDS) * 1000;
  const started = now();
  const startedMs = Math.floor(started / 1000) * 1000;
  const deadline = started + timeoutSeconds * 1000;
  const saved = stateFile ? readJson(stateFile) : {};
  if (stateFile && watchActive(commonDir, { env, now: started, isAlive }) && Number(saved.pid) !== pid) {
    return { status: "active", events: [], summary: `watch già attivo (pid ${saved.pid}): non serve rilanciarlo` };
  }
  let cursor = isCursor(saved.cursor) ? saved.cursor : null;
  const known = new Set(Array.isArray(saved.known_stories) ? saved.known_stories : []);
  let baselineStories = !Array.isArray(saved.known_stories);
  // Wait states seen last time (null: first scan is the baseline).
  let waitStates = saved.waits && typeof saved.waits === "object" && !Array.isArray(saved.waits) ? saved.waits : null;
  const persist = (extra = {}) => {
    if (!stateFile) return;
    writeJson(stateFile, { pid, started_at: isoNow(started), heartbeat: now(), deadline: isoNow(deadline), cursor, known_stories: [...known].slice(-KNOWN_LIMIT), ...(waitStates ? { waits: waitStates } : {}), ...extra });
  };
  const release = () => persist({ pid: null, heartbeat: null });
  persist();
  let nextStories = 0;
  let nextPrepared = 0;
  let baselineMessages = cursor === null;
  try {
    for (;;) {
      const events = [];
      const at = now();
      if (ctx.provider && ctx.config) {
        try {
          const since = cursor ?? FIRST_READ_SINCE;
          const fresh = await ctx.provider.poll({ config: ctx.config, since, signal: AbortSignal.timeout(Math.max(pollMs, 10_000)) });
          const last = [...fresh].reverse().map(cursorOf).find(Boolean);
          if (last) cursor = last;
          else if (baselineMessages) cursor = `${isoNow(at)}|0`;
          // first read: only what arrived since the watch started counts (no gap before the first poll)
          const news = baselineMessages ? fresh.filter((m) => Date.parse(m.time) >= startedMs) : fresh;
          if (news.length > 0) {
            const own = ctx.refreshOwn ? await ctx.refreshOwn() : ctx.own;
            events.push(...relevantMessageEvents(news, { names: ctx.names, own, isTerminal: ctx.isTerminal }));
          }
          baselineMessages = false;
        } catch {
          // channel unreachable this round: retry at the next poll
        }
      }
      if (at >= nextStories && ctx.scanStories) {
        nextStories = at + storyMs;
        try {
          const stories = await ctx.scanStories();
          const fresh = baselineStories ? [] : stories.filter((item) => !known.has(item.id) && !item.own);
          for (const item of stories) known.add(item.id);
          baselineStories = false;
          for (const item of fresh) events.push({ type: "story", story: item.id });
        } catch {
          // local scan failed: try again at the next scan
        }
      }
      if (ctx.resolvePrepared && at >= nextPrepared) {
        nextPrepared = at + storyMs;
        try {
          for (const item of await ctx.resolvePrepared()) events.push({ type: "prepared", story: item.story_id, item });
        } catch {
          // preparations unreadable this round: looked at again at the next scan
        }
      }
      if (ctx.scanWaits) {
        try {
          const waits = await ctx.scanWaits();
          if (waitStates !== null) for (const transition of waitTransitions(waitStates, waits)) events.push({ type: "wait", transition });
          waitStates = waitSnapshot(waits);
        } catch {
          // waits unreadable this round: compared again at the next one
        }
      }
      persist();
      if (events.length > 0) {
        const summary = events.map((event) => describeEvent(event, { label: ctx.label, now: now() })).join("\n");
        release();
        return { status: "event", events: events.map((event) => ({ type: event.type, ...(event.transition ? { id: event.transition.id, state: event.transition.to, story: event.transition.wait?.waiter?.story ?? null } : event.story ? { story: event.story } : { id: event.message.id, from: event.message.from, story: event.message.story ?? null, text: shortText(event.message.text) }) })), summary };
      }
      if (signal?.aborted || now() >= deadline) {
        release();
        return { status: "timeout", events: [], summary: NO_EVENT_TEXT };
      }
      await sleep(Math.max(0, Math.min(pollMs, deadline - now())), signal);
    }
  } catch (error) {
    release();
    throw error;
  }
}

/** CLI entry: prints the summary (or JSON) and always exits 0, so the agent re-arms on "nessun evento". */
export async function watchCommand(options, env = process.env) {
  const root = path.resolve(String(options.root || process.cwd()));
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const result = await runWatch(root, { env, timeout: options.timeout, signal: controller.signal, sleep: (ms, signal) => new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    }) });
    if (options.json === true) console.log(JSON.stringify(result));
    else console.log(result.summary);
    return result;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
