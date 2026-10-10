import { Date } from "../runtime/host.mjs";
import { VERSION } from "../engine/definitions.mjs";
import { identityOf, isOlderVersion } from "./kinds.mjs";

/**
 * Participants of the channel, from the messages themselves (join, welcome,
 * heartbeat, any message of the plugin). One entry per computer (its host id).
 *   stories   from the latest message that lists them (join, welcome, heartbeat)
 *   duplicate another computer uses the same name
 *   outdated  runs a plugin older than the newest one seen (or than this one)
 */
export function buildRoster(messages, { currentVersion = VERSION } = {}) {
  const byHost = new Map();
  for (const message of messages) {
    if (message.plugin_message === false) continue;
    const key = identityOf(message);
    if (!key) continue;
    const entry = byHost.get(key) ?? { host: message.host ?? null, name: null, gh_login: null, version: null, last_seen: null, stories: [] };
    entry.name = message.from ?? entry.name;
    entry.host = message.host ?? entry.host;
    entry.gh_login = message.gh_login ?? entry.gh_login;
    entry.version = message.version ?? entry.version;
    entry.last_seen = message.time ?? entry.last_seen;
    if (Array.isArray(message.stories)) entry.stories = message.stories;
    byHost.set(key, entry);
  }
  const entries = [...byHost.values()];
  const users = new Map();
  for (const entry of entries) users.set(entry.name, (users.get(entry.name) ?? 0) + 1);
  const newest = entries.map((entry) => entry.version).filter(Boolean).concat(currentVersion).reduce((best, version) => (isOlderVersion(best, version) ? version : best));
  const participants = entries
    .map((entry) => ({ ...entry, duplicate: users.get(entry.name) > 1, outdated: isOlderVersion(entry.version, newest) }))
    .sort((a, b) => String(b.last_seen).localeCompare(String(a.last_seen)));
  return { participants, duplicates: [...users].filter(([, count]) => count > 1).map(([name]) => name), newest_version: newest };
}

/** The other computer that already uses `name`, or null. */
export function nameTakenBy(messages, name, host) {
  return buildRoster(messages).participants.find((entry) => entry.name === name && entry.host !== host) ?? null;
}

export function formatRoster(roster, now = Date.now()) {
  if (roster.participants.length === 0) return ["Nobody has been seen in the channel in this period."];
  return roster.participants.map((entry) => {
    const seen = Date.parse(entry.last_seen ?? "");
    const ago = Number.isFinite(seen) ? `${Math.max(0, Math.round((now - seen) / 60_000))} min ago` : "?";
    const flags = [entry.duplicate ? "DUPLICATE NAME" : null, entry.outdated ? `OLD VERSION (newest ${roster.newest_version})` : null].filter(Boolean);
    return `${entry.name}${entry.gh_login ? ` (${entry.gh_login})` : ""} · host ${entry.host ?? "?"} · plugin ${entry.version ?? "?"} · last seen ${ago}`
      + ` · stories ${entry.stories.length > 0 ? entry.stories.join(", ") : "none"}${flags.length > 0 ? ` · ${flags.join(", ")}` : ""}`;
  });
}
