/**
 * The remote URL a person trusts for each repository, kept outside every repository in a
 * user-level file. The merge and push guard reads the base branch only from that URL, so a
 * repository's own git configuration (remote.origin.url, pushurl, url.*.insteadOf, includes)
 * cannot point it at another remote. Written only by 'agentic-sdlc guard trust-remote'.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const TRUSTED_REMOTES_FILE_ENV = "AGENTIC_SDLC_TRUSTED_REMOTES_FILE";
export const TRUSTED_REMOTES_FILE_NAME = "trusted-remotes.json";
const SCHEMA_VERSION = 1;

/** The user-level file: the environment override, else $XDG_CONFIG_HOME or ~/.config, under agentic-sdlc/. */
export function trustedRemotesFile(env = process.env) {
  const override = String(env?.[TRUSTED_REMOTES_FILE_ENV] ?? "").trim();
  if (override) return path.resolve(override);
  const configHome = String(env?.XDG_CONFIG_HOME ?? "").trim() || path.join(os.homedir(), ".config");
  return path.join(configHome, "agentic-sdlc", TRUSTED_REMOTES_FILE_NAME);
}

/** A repository path as stored: absolute, symlinks resolved, case-folded on Windows. */
export function repositoryKey(top) {
  let resolved = path.resolve(top);
  try {
    resolved = fs.realpathSync(resolved);
  } catch {
    // a path that does not exist is stored as written
  }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** A URL the guard can hand to git as a repository argument: one non-empty word that is not an option. */
export function validRemoteUrl(url) {
  const text = String(url ?? "");
  return text.length > 0 && text.length <= 2048 && !/^-/u.test(text) && !/[\s\0]/u.test(text);
}

function readStore(file) {
  try {
    const store = JSON.parse(fs.readFileSync(file, "utf8"));
    return store && typeof store === "object" && store.remotes && typeof store.remotes === "object" ? store : null;
  } catch {
    return null;
  }
}

/** The trusted URL for a repository toplevel, or null when none is recorded. */
export function trustedRemoteUrl(top, env = process.env) {
  const entry = readStore(trustedRemotesFile(env))?.remotes?.[repositoryKey(top)];
  return entry && validRemoteUrl(entry.url) ? entry.url : null;
}

/** Records (or replaces) the trusted URL of a repository toplevel; returns the file and the entry. */
export function recordTrustedRemote(top, url, actor, env = process.env) {
  if (!validRemoteUrl(url)) throw new Error(`'${url}' is not a usable remote URL.`);
  const file = trustedRemotesFile(env);
  const store = readStore(file) ?? { schema_version: SCHEMA_VERSION, remotes: {} };
  const key = repositoryKey(top);
  const entry = { url, trusted_at: new Date().toISOString(), actor };
  store.schema_version = SCHEMA_VERSION;
  store.remotes[key] = entry;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  return { file, key, entry };
}
