import path from "node:path";
import { Date, fs, process } from "../runtime/host.mjs";
import { scanFiles } from "../secret-scan.mjs";
import { parseLimitSeconds } from "../runtime/bounded-child-process.mjs";
import { localMessagingPath, resolveMessagingConfig } from "./config.mjs";
import { VERSION } from "../engine/definitions.mjs";
import { cursorOf, isCursor } from "./cursor.mjs";
import { identityOf, newerVersionSeen, pendingReplies } from "./kinds.mjs";
import { authorFor, formatMessage, PROVIDERS, READ_NOTE, resolveProvider } from "./commands.mjs";
import { resolveIdentity, selfNamesOf } from "./identity.mjs";

/**
 * Automatic messages, on top of the opt-in channel.
 *
 * Once a clone has a channel, the plugin itself tells the other computers when
 * a gate fails, a story is parked or put on wait, or a command stops on a git
 * time limit; and before `story claim` and `task start` it shows the messages
 * that arrived since it last looked. Without a channel nothing happens and no
 * network call is made. Every step is best effort: a slow or unreachable GitHub,
 * a broken state file or a refused text never changes what the command does
 * or its exit code, and never waits longer than the short limit below.
 *
 *   AGENTIC_SDLC_MESSAGING_AUTO=off               keeps `message` commands, stops automatic ones
 *   AGENTIC_SDLC_MESSAGING_AUTO_TIMEOUT_SECONDS   network limit for one automatic step (default 3)
 *
 * The read position and recent sends live next to the channel settings, in
 * <git-common-dir>/agentic-sdlc/messaging-auto.json, never in git.
 */
export const AUTO_ENV = Object.freeze({
  switch: "AGENTIC_SDLC_MESSAGING_AUTO",
  timeout: "AGENTIC_SDLC_MESSAGING_AUTO_TIMEOUT_SECONDS",
});
export const AUTO_STATE_FILE = "messaging-auto.json";
const DEFAULT_TIMEOUT_SECONDS = 3;
const FIRST_READ_SINCE = "12h";
const SHOWN_LIMIT = 10;
// The same alert for the same story is sent once in this window.
const REPEAT_WINDOW_MS = 30 * 60 * 1000;
// A failed automatic send is reported on stderr at most once in this window.
const WARN_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_DETAIL = 300;
const OWN_IDS_LIMIT = 200;
const OFF_VALUES = new Set(["0", "false", "no", "off", "disabled"]);
const READ_BEFORE = new Set(["story.claim", "task.start"]);

function timeoutMs(env) {
  const seconds = parseLimitSeconds(env[AUTO_ENV.timeout]);
  return (seconds && seconds > 0 ? seconds : DEFAULT_TIMEOUT_SECONDS) * 1000;
}

/** The enabled settings and state file path, or null when automatic messages are off here. */
function autoConfig(root, env) {
  if (OFF_VALUES.has(String(env[AUTO_ENV.switch] ?? "").trim().toLowerCase())) return null;
  let config;
  try {
    config = resolveMessagingConfig(root, env);
  } catch {
    return null;
  }
  if (!config.enabled || !PROVIDERS[config.provider]) return null;
  const local = config.local_path ?? localMessagingPath(root);
  return { config, statePath: local ? path.join(path.dirname(local), AUTO_STATE_FILE) : null };
}

function readState(statePath) {
  if (!statePath) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeState(statePath, state) {
  if (!statePath) return;
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // Losing the position only means some messages are shown again.
  }
}

/** Ids of the messages this computer sent, kept in the auto state file. */
export function ownMessageIds(root, env = process.env) {
  const settings = autoConfig(root, env);
  const own = settings ? readState(settings.statePath).own : null;
  return new Set(Array.isArray(own) ? own.map(String) : []);
}

/**
 * Records a message this computer sent. When the sent message is given, it also joins the cached
 * attention window, so a reply counts as answered right away instead of after the next poll.
 */
export function rememberOwnMessage(root, id, env = process.env, message = null) {
  const settings = autoConfig(root, env);
  if (!settings?.statePath || !id) return;
  const state = readState(settings.statePath);
  const own = Array.isArray(state.own) ? state.own : [];
  const next = { ...state, own: [...own, String(id)].slice(-OWN_IDS_LIMIT) };
  if (message && state.attention && Array.isArray(state.attention.window)) {
    const window = state.attention.window.filter((item) => item?.id !== String(id));
    next.attention = { ...state.attention, window: [...window, { ...message, id: String(id) }] };
  }
  writeState(settings.statePath, next);
}

function shortText(value) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL - 1)}…` : text;
}

function listOf(ids) {
  return ids.slice(0, 5).join(", ") + (ids.length > 5 ? ` and ${ids.length - 5} more` : "");
}

function startSuggestion(ids) {
  return `agentic-sdlc task start --story ${ids[0]} (check 'story availability --id ${ids[0]}' first)`;
}

function storyOf(options) {
  const value = String(options?.story ?? options?.id ?? "").trim().toUpperCase();
  return /^[A-Z0-9._-]{1,64}$/u.test(value) ? value : null;
}

function isTimeout(error) {
  for (let current = error, depth = 0; current && depth < 5; current = current.cause, depth += 1) {
    if (current.code === "ETIMEDOUT" || /did not finish within/u.test(String(current.message ?? ""))) return true;
  }
  return false;
}

/** A problem shared as a question, so the other computers are reminded until someone answers. */
function helpText(problem) {
  return `need help: ${problem}; reply with --kind answer --reply-to <id>`;
}

/**
 * Remember how the last command ended, next to the messaging state, so the
 * host hook can remind the agent to share a failure that was not announced.
 * Best effort; does nothing while automatic messages are off.
 */
export function recordRunOutcome(root, { action, failed, error, alerted }, env = process.env) {
  try {
    const settings = autoConfig(root, env);
    if (!settings?.statePath) return;
    const state = readState(settings.statePath);
    if (failed) {
      state.last_failure = { action: String(action ?? ""), error: shortText(error ?? "exit code not zero"), at: Date.now(), alerted: alerted === true, reminded: false };
    } else if (!state.last_failure) {
      return;
    } else {
      delete state.last_failure;
    }
    writeState(settings.statePath, state);
  } catch {
    // best effort
  }
}

/** The reminder for an unannounced failure not yet reminded, or null. */
export function failureReminder(failure) {
  if (!failure || typeof failure !== "object" || failure.alerted === true || failure.reminded === true) return null;
  const command = String(failure.action || "command").replace(/\./gu, " ");
  return `The last agentic-sdlc command (${command}) failed: ${failure.error}. Share the problem now and ask for help before going on: `
    + "agentic-sdlc message send --kind question --text \"<command, exact error, story, what you already tried>\". "
    + "Open problems are solved before new stories start.";
}

/**
 * The alert a finished command should send, or null. `outcome` is what the
 * command ended with: its error, if any, and the exit code it set.
 */
export function alertFor(action, options, outcome = {}) {
  const story = storyOf(options);
  const command = String(action ?? "command").replace(/\./gu, " ");
  if (outcome.error && isTimeout(outcome.error)) {
    const step = String(outcome.error.message ?? "").split(":")[0];
    return { key: `timeout:${action}`, story, kind: "question", text: helpText(`${command} stopped on a time limit${step ? ` (${shortText(step)})` : ""}${story ? ` on ${story}` : ""}`) };
  }
  if (outcome.error) return null;
  const unblocked = Array.isArray(outcome.extra?.unblocked) ? outcome.extra.unblocked : [];
  const unblockedNote = unblocked.length > 0 ? ` Now unblocked: ${listOf(unblocked)}.` : "";
  const unblockedOffer = unblocked.length > 0
    ? { kind: "offer", next: startSuggestion(unblocked) }
    : {};
  if (action === "story.claim" && outcome.exitCode !== 1 && story) {
    return { key: `claim:${story}`, story, text: `${story} claimed: work started on this computer, please do not start it elsewhere.` };
  }
  if (action === "story.release" && story) {
    return { key: `release:${story}`, story, kind: "offer", text: `${story} released and free to take.`, next: `agentic-sdlc story availability --id ${story}, then story claim --id ${story} --agent <name>` };
  }
  if (action === "autonomy.delivery.action" && options?.action === "pull_request.merge" && options?.outcome === "passed" && outcome.exitCode !== 1) {
    const merged = outcome.extra?.story ?? null;
    return { key: `merge:${merged}`, story: merged, ...unblockedOffer, text: `delivery merged${merged ? ` for ${merged}` : ""}.${unblockedNote}` };
  }
  if (action === "autonomy.delivery.reconcile" && outcome.exitCode !== 1) {
    const merged = outcome.extra?.story ?? null;
    return { key: `merge:${merged ?? options?.id}`, story: merged, ...unblockedOffer, text: `external merge acknowledged${merged ? ` for ${merged}` : ""}.${unblockedNote}` };
  }
  if (action === "story.publish-records" && story) {
    return { key: `publish:${story}`, story, ...unblockedOffer, text: `records of ${story} published.${unblockedNote}` };
  }
  if (action === "gate.check" && options?.["lifecycle-complete"] === true && outcome.exitCode !== 1 && story) {
    return { key: `certified:${story}`, story, ...unblockedOffer, text: `${story} lifecycle-complete certified.${unblockedNote}` };
  }
  if (action === "workflow.instance.transition" && outcome.exitCode !== 1 && options?.to) {
    const owner = outcome.extra?.story ?? null;
    return { key: `phase:${owner ?? options.id}:${options.to}`, story: owner, text: `${owner ?? `workflow ${shortText(options.id)}`} entered phase ${shortText(options.to)}.` };
  }
  if (action === "autonomy.delivery.action" && ["git.commit", "git.push", "pull_request.create"].includes(options?.action)
    && options?.outcome === "passed" && outcome.exitCode !== 1) {
    const owner = outcome.extra?.story ?? null;
    const url = options.action === "pull_request.create" && options["pr-url"] ? ` ${shortText(options["pr-url"])}` : "";
    return { key: `${options.action}:${owner ?? options.id}`, story: owner, text: `${options.action.replace(/[._]/gu, " ")} done${owner ? ` for ${owner}` : ""}.${url}` };
  }
  if (action === "test.record" && outcome.exitCode !== 1 && story) {
    const passed = String(options?.["exit-code"] ?? "") === "0";
    const counts = ["passed", "failed", "skipped"].filter((name) => options?.[name] !== undefined).map((name) => `${shortText(options[name])} ${name}`).join(", ");
    return { key: `test:${story}`, story, text: `tests for ${story} ${passed ? "passed" : "failed"}${counts ? ` (${counts})` : ""}.` };
  }
  if (action === "gate.check" && options?.strict === true && options?.["lifecycle-complete"] !== true && outcome.exitCode !== 1 && !outcome.error && story) {
    return { key: `strict:${story}`, story, text: `${story} strict gate passed.` };
  }
  if (action === "baseline.refresh" && outcome.exitCode !== 1 && options?.["dry-run"] !== true) {
    return { key: "baseline-refresh", story: null, text: "baseline refreshed: re-read the project state before starting new work (agentic-sdlc baseline status)." };
  }
  if (action === "gate.check" && outcome.exitCode === 1) {
    const blocker = Array.isArray(outcome.blockers) && outcome.blockers.length > 0 ? `: ${shortText(outcome.blockers[0])}` : "";
    return { key: `gate:${story}`, story, kind: "question", text: helpText(`gate check failed${story ? ` for ${story}` : ""}${blocker}`) };
  }
  if (action === "autonomy.delivery.evidence.supersede") {
    const record = outcome.result?.evidence_supersede;
    if (!record) return null;
    const owner = outcome.result.story_id || story;
    const who = record.recorded_by?.name || record.recorded_by?.type || "a person";
    return {
      key: `evidence-supersede:${record.receipt_ref.id}:${shortText(record.evidence.path)}`,
      story: owner,
      text: `${who} superseded evidence ${shortText(record.evidence.path)} of receipt ${record.receipt_ref.id}${owner ? ` (${owner})` : ""}: ${shortText(record.reason)}. `
        + `Whoever holds ${owner ?? "the story"}: pull main, then run gate check --strict --lifecycle-complete${owner ? ` for ${owner}` : ""}. `
        + "Publish the .sdlc records on main so every computer sees the record.",
    };
  }
  if (action === "story.park") {
    const reason = options?.reason ? `: ${shortText(options.reason)}` : "";
    return { key: `park:${story}`, story, text: `${story ?? "story"} parked${reason}` };
  }
  if (action === "story.wait" && options?.clear !== true && options?.on !== undefined) {
    const until = options.until !== undefined ? ` until ${shortText(options.until)}` : "";
    const blocking = /^dep:(.+)$/iu.exec(String(options.on))?.[1];
    return {
      key: `wait:${story}:${options.on}`,
      story,
      text: `${story ?? "story"} waiting on ${shortText(options.on)}${until}${blocking ? ` (blocked by ${shortText(blocking)})` : ""}`,
    };
  }
  return null;
}

/** Send `alert` to the project's channel; quiet, bounded and never failing. */
export async function sendAutoAlert(root, alert, { env = process.env, providers = PROVIDERS, stderr } = {}) {
  if (!alert) return { skipped: "no alert" };
  const settings = autoConfig(root, env);
  if (!settings) return { skipped: "off" };
  const state = readState(settings.statePath);
  const sent = state.sent && typeof state.sent === "object" ? state.sent : {};
  const fingerprint = `${alert.key}|${alert.text}`;
  const last = Number(sent[fingerprint]);
  const at = Date.now();
  if (Number.isFinite(last) && at - last < REPEAT_WINDOW_MS) return { skipped: "repeat" };
  const text = `[auto] ${alert.text}${alert.next ? ` Suggested next step (not run automatically): ${alert.next}` : ""}`;
  if (scanFiles([{ path: "message", content: text }]).outcome !== "clean") return { skipped: "secret" };
  const author = authorFor(root, env);
  const from = author.from;
  let published;
  try {
    published = await resolveProvider(settings.config, providers).publish({
      config: settings.config,
      message: { ...author, story: alert.story, text, kind: alert.kind ?? "info", version: VERSION },
      signal: AbortSignal.timeout(timeoutMs(env)),
    });
  } catch (error) {
    if (!(at - Number(state.warned_at) < WARN_WINDOW_MS)) {
      stderr?.(`agentic-sdlc: automatic message not sent (${error?.name === "TimeoutError" ? "no answer in time" : shortText(error?.message)}).\n`);
      writeState(settings.statePath, { ...state, warned_at: at });
    }
    return { skipped: "unavailable" };
  }
  if (published?.id) {
    const own = Array.isArray(state.own) ? state.own : [];
    state.own = [...own, String(published.id)].slice(-OWN_IDS_LIMIT);
  }
  for (const [key, time] of Object.entries(sent)) if (!(at - Number(time) < REPEAT_WINDOW_MS)) delete sent[key];
  sent[fingerprint] = at;
  writeState(settings.statePath, { ...state, sent });
  stderr?.(`agentic-sdlc: told the other computers: ${alert.text}\n`);
  return { sent: true, from, text };
}

/**
 * Show the messages from other computers that arrived since this clone last
 * looked, on stderr so --json output stays clean. Returns the messages shown.
 */
export async function showNewMessages(root, { env = process.env, providers = PROVIDERS, stderr } = {}) {
  const settings = autoConfig(root, env);
  if (!settings) return { skipped: "off", messages: [] };
  const state = readState(settings.statePath);
  const since = isCursor(state.cursor) ? state.cursor : FIRST_READ_SINCE;
  let messages;
  try {
    messages = await resolveProvider(settings.config, providers).poll({
      config: settings.config,
      since,
      signal: AbortSignal.timeout(timeoutMs(env)),
    });
  } catch {
    return { skipped: "unavailable", messages: [] };
  }
  const last = [...messages].reverse().find((message) => cursorOf(message));
  if (last && cursorOf(last) !== state.cursor) writeState(settings.statePath, { ...readState(settings.statePath), cursor: cursorOf(last) });
  const identity = resolveIdentity(root, env);
  const self = identity.name;
  const names = selfNamesOf(identity);
  const mine = new Set(Array.isArray(state.own) ? state.own : []);
  const pending = pendingReplies(messages);
  const others = messages.filter((message) => !names.has(message.from) && !names.has(identityOf(message)) && !mine.has(message.id)).slice(-SHOWN_LIMIT);
  if (others.length > 0) {
    stderr?.(`agentic-sdlc: new messages from other computers. ${READ_NOTE}\n${others.map((message) => `  ${formatMessage(message, self, pending[message.id])}`).join("\n")}\n`);
  }
  const newer = newerVersionSeen(others, VERSION);
  if (newer) stderr?.(`agentic-sdlc: ${newer.from ?? "another computer"} uses plugin ${newer.version}; this one is ${VERSION}. Consider updating the plugin.\n`);
  return { messages: others };
}

export function readsMessagesBefore(action) {
  return READ_BEFORE.has(action);
}
