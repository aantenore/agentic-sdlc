import { Date, fs, process } from "../runtime/host.mjs";
import { UserError } from "../cli/user-error.mjs";
import { VERSION } from "../engine/definitions.mjs";
import { parseLimitSeconds } from "../runtime/bounded-child-process.mjs";
import { AUTO_ENV, rememberOwnMessage } from "./auto.mjs";
import { flushMessageOutbox, formatMessage, PROVIDERS, resolveProvider } from "./commands.mjs";
import { authorOf, learnGhLogin, resolveIdentity, selfNamesOf, storeIdentity } from "./identity.mjs";
import { identityOf } from "./kinds.mjs";
import { localActiveClaims } from "./presence.mjs";
import { recapLines, recapMessages, recapStatus } from "./recap.mjs";
import { nameTakenBy } from "./roster.mjs";

/**
 * Channel handshake. The first messaging command on a clone (and again after a
 * change of name or plugin version) publishes one `join` with the computer's
 * name, host, GitHub login, plugin version and the stories it works on. The
 * other computers answer it once with a `welcome` carrying the same facts, so
 * the newcomer learns who is there. Both are written by the plugin, never by
 * hand, and never change what anyone may do.
 *
 *   AGENTIC_SDLC_MESSAGING_JOIN=off   no automatic join/welcome on this computer
 */
export const JOIN_ENV = "AGENTIC_SDLC_MESSAGING_JOIN";
const OFF_VALUES = new Set(["0", "false", "no", "off", "disabled"]);
const ROSTER_SINCE = "7d";
const WELCOME_WINDOW_MS = 24 * 60 * 60 * 1000;
const WELCOME_LIMIT = 5;
const WELCOMED_KEPT = 100;
const MAX_TIMEOUT_MS = 10_000;

export function joinEnabled(env = process.env) {
  return !OFF_VALUES.has(String(env[JOIN_ENV] ?? "").trim().toLowerCase());
}

function timeoutOf(env, fallbackSeconds) {
  const seconds = parseLimitSeconds(env[AUTO_ENV.timeout]);
  return Math.min((seconds && seconds > 0 ? seconds : fallbackSeconds) * 1000, MAX_TIMEOUT_MS);
}

function claimedStories(root, now = Date.now()) {
  try {
    return localActiveClaims(root, { now }).map((claim) => claim.story).slice(0, 20);
  } catch {
    return [];
  }
}

function storiesNote(stories) {
  return stories.length > 0 ? `story in corso: ${stories.join(", ")}` : "nessuna story in corso";
}

function sameJoin(joined, identity) {
  return Boolean(joined) && joined.name === identity.name && joined.host === identity.host && joined.version === VERSION;
}

/**
 * Publishes this computer's `join` unless it already did for this name and version.
 * `strict` (the user's own command) refuses a name another computer already uses;
 * the host hook skips instead. Any other failure leaves the join for the next time.
 */
export async function ensureJoined(root, config, { env = process.env, providers = PROVIDERS, strict = false, now = Date.now(), stderr = (text) => process.stderr.write(text) } = {}) {
  if (!joinEnabled(env)) return { skipped: "off" };
  let identity = resolveIdentity(root, env);
  if (sameJoin(identity.joined, identity)) return { skipped: "joined" };
  const timeout = timeoutOf(env, strict ? 10 : 3);
  const provider = resolveProvider(config, providers);
  try {
    identity = await learnGhLogin(root, identity, provider, AbortSignal.timeout(timeout));
    const recent = await provider.poll({ config, since: ROSTER_SINCE, signal: AbortSignal.timeout(timeout) });
    const taken = nameTakenBy(recent, identity.name, identity.host);
    if (taken) {
      if (strict) throw new UserError(`The name '${identity.name}' is already used by the computer ${taken.host}. Choose another: agentic-sdlc message identity --name "<name>".`, null, "MESSAGING_NAME_TAKEN");
      return { skipped: "name-taken" };
    }
    const stories = claimedStories(root, now);
    const text = `${identity.name} si è unito al canale (versione ${VERSION}); ${storiesNote(stories)}`;
    const message = { ...authorOf(identity), story: null, text, kind: "join", version: VERSION, stories };
    const sent = await provider.publish({ config, message, signal: AbortSignal.timeout(timeout) });
    storeIdentity(root, { host: identity.host, git_user: identity.git_user, joined: { name: identity.name, host: identity.host, version: VERSION, at: new Date(now).toISOString() } });
    if (sent?.id) rememberOwnMessage(root, sent.id, env, { from: identity.name, host: identity.host, gh_login: identity.gh_login, kind: "join", text, stories, version: VERSION, time: new Date(now).toISOString() });
    const recap = joinRecap(root, recent, identity, { now, stderr });
    return { joined: true, name: identity.name, id: sent?.id ?? null, recap };
  } catch (error) {
    if (error instanceof UserError) throw error;
    return { skipped: "unavailable" };
  }
}

/**
 * Catch-up shown once, right after this computer joins: the last messages of the
 * others (already read for the join) and the stories in progress, parked or
 * waiting as last seen on the remote. On stderr, so --json output stays clean;
 * never fails the join.
 */
function joinRecap(root, recent, identity, { now, stderr }) {
  try {
    const messages = recapMessages(recent, identity);
    const status = recapStatus(root, { now });
    stderr?.(`${recapLines({ messages, status, format: (message) => formatMessage(message, identity.name) }).join("\n")}\n`);
    return { messages, status };
  } catch {
    return null;
  }
}

/** The join step of a messaging command: sends queued messages first, tells the user on stderr, never fails the command. */
export async function joinFromCommand(root, config, { env = process.env, providers = PROVIDERS } = {}) {
  await flushMessageOutbox(root, config, { env, providers });
  const result = await ensureJoined(root, config, { env, providers, strict: true });
  if (result.joined) process.stderr.write(`agentic-sdlc: joined the channel as ${result.name} (plugin ${VERSION}).\n`);
  return result;
}

/** Joins in `messages` from other computers that this one has not welcomed yet. */
export function joinsToWelcome({ messages, identity, own = new Set(), welcomed = new Set(), now = Date.now() }) {
  const names = selfNamesOf(identity);
  return messages.filter((message) => {
    if (message.kind !== "join" || !message.id || welcomed.has(String(message.id)) || own.has(String(message.id))) return false;
    if (names.has(message.from) || names.has(identityOf(message))) return false;
    const at = Date.parse(message.time ?? "");
    return !Number.isFinite(at) || now - at < WELCOME_WINDOW_MS;
  }).slice(-WELCOME_LIMIT);
}

function saveWelcomed(statePath, welcomed) {
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(statePath, "utf8")) ?? {};
  } catch {
    state = {};
  }
  fs.writeFileSync(statePath, `${JSON.stringify({ ...state, welcomed: [...welcomed].slice(-WELCOMED_KEPT) }, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Answers new joins with one `welcome` each, for the host hook. `state` is the auto state file
 * content; returns the ids welcomed and writes them down so a join is never welcomed twice.
 */
export async function welcomeJoins(root, { settings, messages, provider, env = process.env, now = Date.now() }) {
  if (!joinEnabled(env)) return [];
  const identity = resolveIdentity(root, env);
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(settings.statePath, "utf8")) ?? {};
  } catch {
    state = {};
  }
  const welcomed = new Set(Array.isArray(state.welcomed) ? state.welcomed.map(String) : []);
  const own = new Set(Array.isArray(state.own) ? state.own.map(String) : []);
  const pending = joinsToWelcome({ messages, identity, own, welcomed, now });
  const done = [];
  const stories = claimedStories(root, now);
  for (const join of pending) {
    // Written down first: two hooks never welcome the same join.
    welcomed.add(String(join.id));
    saveWelcomed(settings.statePath, welcomed);
    const text = `${identity.name} dà il benvenuto a ${join.from ?? "un nuovo computer"} (versione ${VERSION}); ${storiesNote(stories)}`;
    try {
      const sent = await provider.publish({
        config: settings.config,
        message: { ...authorOf(identity), story: null, text, kind: "welcome", replyTo: String(join.id), to: join.from ?? null, version: VERSION, stories },
        signal: AbortSignal.timeout(timeoutOf(env, 3)),
      });
      if (sent?.id) rememberOwnMessage(root, sent.id, env, { from: identity.name, host: identity.host, kind: "welcome", reply_to: String(join.id), text, stories, version: VERSION, time: new Date(now).toISOString() });
      done.push(String(join.id));
    } catch {
      welcomed.delete(String(join.id));
      saveWelcomed(settings.statePath, welcomed);
    }
  }
  return done;
}
