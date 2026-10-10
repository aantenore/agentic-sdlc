import path from "node:path";
import { crypto, Date, fs, process } from "../runtime/host.mjs";
import { localMessagingPath } from "./config.mjs";

/**
 * Local outbox for messages the server refused for a temporary reason (quota
 * reached, server error, network down, timeout). Nothing is lost: the message
 * waits here, in <git-common-dir>/agentic-sdlc/messaging-outbox.json (mode
 * 0600, never in git), and is sent in order by the next `message send`,
 * `message read|listen`, host hook check or `message outbox --flush`.
 *
 *   AGENTIC_SDLC_MESSAGING_OUTBOX_RETRY_MINUTES   minimum gap between two automatic attempts (default 5);
 *                                                 it doubles after each failure, up to 12 times the gap
 *
 * Permanent refusals (HTTP 4xx other than 429, invalid text) are never queued.
 */
export const OUTBOX_ENV = Object.freeze({ retry: "AGENTIC_SDLC_MESSAGING_OUTBOX_RETRY_MINUTES" });
export const OUTBOX_FILE = "messaging-outbox.json";
export const DEFAULT_RETRY_MINUTES = 5;
const MAX_BACKOFF_FACTOR = 12;
const MAX_ITEMS = 50;
const MAX_REASON = 300;

/** Path of the outbox file for a project root, or null outside a git clone. */
export function outboxPath(root) {
  const local = localMessagingPath(root);
  return local ? path.join(path.dirname(local), OUTBOX_FILE) : null;
}

function read(file) {
  if (!file) return { items: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const items = Array.isArray(parsed?.items) ? parsed.items.filter((item) => item && typeof item.id === "string" && item.message) : [];
    return { ...(parsed && typeof parsed === "object" ? parsed : {}), items };
  } catch {
    return { items: [] };
  }
}

function write(file, state) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

/** True for a refusal worth retrying later: quota (429), server error (5xx), network failure or timeout. */
export function isTemporaryFailure(error) {
  const text = String(error?.message ?? error ?? "");
  const status = Number(/HTTP (\d{3})/u.exec(text)?.[1]);
  if (Number.isFinite(status) && status > 0) return status === 429 || status >= 500 || status === 408;
  return true;
}

export function retryGapMs(env = process.env) {
  const minutes = Number(env[OUTBOX_ENV.retry]);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_RETRY_MINUTES) * 60_000;
}

function shortReason(reason) {
  const text = String(reason ?? "").replace(/\s+/gu, " ").trim();
  return text.length > MAX_REASON ? `${text.slice(0, MAX_REASON - 1)}…` : text;
}

/** The queued messages and the state of the retry schedule. */
export function readOutbox(root) {
  const state = read(outboxPath(root));
  return {
    items: state.items,
    reason: state.items.at(-1)?.reason ?? state.last_error ?? null,
    next_attempt: state.next_attempt ?? null,
    notified: state.notified === true,
  };
}

/** Ids of the messages the queued answers reply to: those questions are being answered. */
export function queuedReplyIds(items) {
  return new Set((items ?? []).map((item) => item?.message?.replyTo).filter(Boolean).map(String));
}

/** Queues a message (oldest first, bounded). Returns the queue entry, or null when there is no place to keep it. */
export function enqueue(root, message, reason, now = Date.now(), env = process.env) {
  const file = outboxPath(root);
  if (!file) return null;
  const state = read(file);
  const item = { id: `ob${crypto.randomBytes(4).toString("hex")}`, queued_at: new Date(now).toISOString(), reason: shortReason(reason), attempts: 1, message };
  const items = [...state.items, item].slice(-MAX_ITEMS);
  write(file, { ...state, items, notified: false, last_error: item.reason, ...(state.next_attempt ? {} : { failures: 1, next_attempt: now + retryGapMs(env) }) });
  return item;
}

/** Removes one entry. Returns true when it existed. */
export function dropFromOutbox(root, id) {
  const file = outboxPath(root);
  const state = read(file);
  const items = state.items.filter((item) => item.id !== id);
  if (items.length === state.items.length) return false;
  write(file, { ...state, items });
  return true;
}

/** Marks the "messages in queue" notice as shown, so the Stop hook mentions it once. */
export function markNotified(root) {
  const file = outboxPath(root);
  const state = read(file);
  if (state.items.length > 0 && !state.notified) write(file, { ...state, notified: true });
}

/**
 * Sends the queued messages in order, stopping at the first refusal. Unless
 * `force`, nothing is attempted before the scheduled time; each failure doubles
 * the wait (up to 12 times the base gap), so a server in quota is not hammered.
 * `provider.publish` does the sending; `onSent(item, sent)` records the message
 * as this computer's own. Never throws.
 * A queued message the server now refuses for good (HTTP 4xx other than 429) is dropped and reported in `rejected`.
 * Returns { attempted, sent: [{ item, id }], rejected: [{ item, reason }], remaining, reason }.
 */
export async function flushOutbox(root, { config, provider, env = process.env, now = Date.now(), force = false, timeoutMs = 3000, onSent = null, version = null } = {}) {
  const file = outboxPath(root);
  const state = read(file);
  const result = { attempted: false, sent: [], rejected: [], remaining: state.items.length, reason: state.items.at(-1)?.reason ?? null };
  if (state.items.length === 0 || !provider || !config) return result;
  if (!force && Number.isFinite(state.next_attempt) && now < state.next_attempt) return result;
  const gap = retryGapMs(env);
  // Claim the slot first, so parallel hooks and commands do not all try at once.
  write(file, { ...state, next_attempt: now + gap });
  result.attempted = true;
  for (const item of state.items) {
    try {
      const sent = await provider.publish({
        server: config.server,
        topic: config.topic,
        message: { ...item.message, version: item.message.version ?? version },
        signal: AbortSignal.timeout(timeoutMs),
      });
      result.sent.push({ item, id: sent?.id ?? null });
      try {
        onSent?.(item, sent);
      } catch {
        // The message is out; remembering it is a convenience.
      }
    } catch (error) {
      const reason = shortReason(String(error?.name === "TimeoutError" || error?.name === "AbortError" ? "no answer in time" : error?.message ?? error).split("\n")[0]);
      if (!isTemporaryFailure(error)) {
        result.rejected.push({ item, reason });
        continue;
      }
      result.reason = reason;
      const latest = read(file);
      const done = new Set([...result.sent, ...result.rejected].map((entry) => entry.item.id));
      const items = latest.items.filter((entry) => !done.has(entry.id)).map((entry) => (entry.id === item.id ? { ...entry, reason, attempts: (entry.attempts ?? 1) + 1 } : entry));
      const failures = Number(state.failures || 0) + 1;
      write(file, { ...latest, items, failures, last_error: reason, next_attempt: now + gap * Math.min(2 ** failures, MAX_BACKOFF_FACTOR) });
      result.remaining = items.length;
      return result;
    }
  }
  const latest = read(file);
  const done = new Set([...result.sent, ...result.rejected].map((entry) => entry.item.id));
  const items = latest.items.filter((entry) => !done.has(entry.id));
  write(file, { items, notified: false });
  result.remaining = items.length;
  result.reason = null;
  return result;
}
