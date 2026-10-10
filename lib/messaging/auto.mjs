import path from "node:path";
import { fs, process } from "../runtime/host.mjs";
import { scanFiles } from "../secret-scan.mjs";
import { parseLimitSeconds } from "../runtime/bounded-child-process.mjs";
import { localMessagingPath, resolveMessagingConfig } from "./config.mjs";
import { formatMessage, PROVIDERS, READ_NOTE, resolveProvider, senderLabel } from "./commands.mjs";

/**
 * Automatic messages, on top of the opt-in topic.
 *
 * Once a clone has a topic, the plugin itself tells the other computers when
 * a gate fails, a story is parked or put on wait, or a command stops on a git
 * time limit; and before `story claim` and `task start` it shows the messages
 * that arrived since it last looked. Without a topic nothing happens and no
 * network call is made. Every step is best effort: a slow or missing server,
 * a broken state file or a refused text never changes what the command does
 * or its exit code, and never waits longer than the short limit below.
 *
 *   AGENTIC_SDLC_MESSAGING_AUTO=off               keeps `message` commands, stops automatic ones
 *   AGENTIC_SDLC_MESSAGING_AUTO_TIMEOUT_SECONDS   network limit for one automatic step (default 3)
 *
 * The read position and recent sends live next to the topic, in
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
const MAX_DETAIL = 300;
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

function shortText(value) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL - 1)}…` : text;
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

/**
 * The alert a finished command should send, or null. `outcome` is what the
 * command ended with: its error, if any, and the exit code it set.
 */
export function alertFor(action, options, outcome = {}) {
  const story = storyOf(options);
  const command = String(action ?? "command").replace(/\./gu, " ");
  if (outcome.error && isTimeout(outcome.error)) {
    const step = String(outcome.error.message ?? "").split(":")[0];
    return { key: `timeout:${action}`, story, text: `${command} stopped on a time limit${step ? ` (${shortText(step)})` : ""}.` };
  }
  if (outcome.error) return null;
  if (action === "gate.check" && outcome.exitCode === 1) {
    const blocker = Array.isArray(outcome.blockers) && outcome.blockers.length > 0 ? `: ${shortText(outcome.blockers[0])}` : "";
    return { key: `gate:${story}`, story, text: `gate check failed${story ? ` for ${story}` : ""}${blocker}` };
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
    return { key: `wait:${story}:${options.on}`, story, text: `${story ?? "story"} waiting on ${shortText(options.on)}${until}` };
  }
  return null;
}

/** Send `alert` to the project's topic; quiet, bounded and never failing. */
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
  const text = `[auto] ${alert.text}`;
  if (scanFiles([{ path: "message", content: text }]).outcome !== "clean") return { skipped: "secret" };
  let from;
  try {
    from = senderLabel({}, env);
  } catch {
    from = senderLabel({}, {});
  }
  try {
    await resolveProvider(settings.config, providers).publish({
      server: settings.config.server,
      topic: settings.config.topic,
      message: { from, story: alert.story, text },
      signal: AbortSignal.timeout(timeoutMs(env)),
    });
  } catch (error) {
    stderr?.(`agentic-sdlc: automatic message not sent (${error?.name === "TimeoutError" ? "no answer in time" : shortText(error?.message)}).\n`);
    return { skipped: "unavailable" };
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
  const since = typeof state.cursor === "string" && /^[A-Za-z0-9]{1,32}$/u.test(state.cursor) ? state.cursor : FIRST_READ_SINCE;
  let messages;
  try {
    messages = await resolveProvider(settings.config, providers).poll({
      server: settings.config.server,
      topic: settings.config.topic,
      since,
      signal: AbortSignal.timeout(timeoutMs(env)),
    });
  } catch {
    return { skipped: "unavailable", messages: [] };
  }
  const lastId = [...messages].reverse().find((message) => message.id)?.id;
  if (lastId && lastId !== state.cursor) writeState(settings.statePath, { ...readState(settings.statePath), cursor: lastId });
  const self = senderLabel({}, env);
  const others = messages.filter((message) => message.id !== state.cursor && message.from !== self).slice(-SHOWN_LIMIT);
  if (others.length > 0) {
    stderr?.(`agentic-sdlc: new messages from other computers. ${READ_NOTE}\n${others.map((message) => `  ${formatMessage(message, self)}`).join("\n")}\n`);
  }
  return { messages: others };
}

export function readsMessagesBefore(action) {
  return READ_BEFORE.has(action);
}
