/**
 * Opt-in automatic plugin update for Claude Code (AGENTIC_SDLC_AUTO_UPDATE=1).
 *
 *   - maybeAutoUpdate: starts, detached, `claude plugin marketplace update <m>` then
 *     `claude plugin update <plugin>@<m>`, throttled by a timestamp file and logged.
 *   - newerSibling / syncInPlace: the cache keeps one folder per version next to the one a session
 *     uses; the entry points delegate to the newest one, and its files are copied over the active
 *     folder (file by file, temp file then rename) so skill and command texts read from disk are new.
 *
 * Everything is configured through the environment; without the opt-in nothing here runs.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const AUTO_UPDATE_ENV = Object.freeze({
  enabled: "AGENTIC_SDLC_AUTO_UPDATE",
  intervalMinutes: "AGENTIC_SDLC_AUTO_UPDATE_INTERVAL_MINUTES",
  timeoutSeconds: "AGENTIC_SDLC_AUTO_UPDATE_TIMEOUT_SECONDS",
  claudeBin: "AGENTIC_SDLC_AUTO_UPDATE_CLAUDE_BIN",
  syncDirs: "AGENTIC_SDLC_AUTO_UPDATE_SYNC_DIRS",
  forwarded: "AGENTIC_SDLC_FORWARDED",
});
const DEFAULT_INTERVAL_MINUTES = 15;
const DEFAULT_TIMEOUT_SECONDS = 120;
const DEFAULT_SYNC_DIRS = ["skills", "commands", "hooks", "lib", "bin", "templates", "schemas", "docs"];
const STATE_FILE = "agentic-sdlc-auto-update.json";
const LOG_FILE = "agentic-sdlc-auto-update.log";
export const SYNC_MARKER = ".agentic-sdlc-synced-version";
const ROOTS_LIMIT = 20;
const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), "auto-update-worker.mjs");

export function autoUpdateEnabled(env = process.env) {
  return ["1", "true", "yes", "on"].includes(String(env?.[AUTO_UPDATE_ENV.enabled] ?? "").trim().toLowerCase());
}

export function parseSemver(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(String(value ?? ""));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function compareSemver(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  for (let index = 0; index < 3; index += 1) if (left[index] !== right[index]) return left[index] - right[index];
  return 0;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** { marketplace, plugin, version, versionsDir } when root is <...>/plugins/cache/<marketplace>/<plugin>/<semver>, else null. */
export function cacheLayout(root, plugin = "agentic-sdlc") {
  const resolved = path.resolve(String(root || ""));
  const versionsDir = path.dirname(resolved);
  const marketplaceDir = path.dirname(versionsDir);
  const cacheDir = path.dirname(marketplaceDir);
  if (!parseSemver(path.basename(resolved)) || path.basename(versionsDir) !== plugin) return null;
  if (path.basename(cacheDir) !== "cache" || path.basename(path.dirname(cacheDir)) !== "plugins") return null;
  return { marketplace: path.basename(marketplaceDir), plugin, version: path.basename(resolved), versionsDir };
}

/** The marketplace name: from the install path, else from the manifest next to the plugin. */
export function marketplaceOf(root) {
  const layout = cacheLayout(root);
  if (layout) return layout.marketplace;
  const name = readJson(path.join(root, ".claude-plugin", "marketplace.json"))?.name;
  return typeof name === "string" && name ? name : null;
}

/** The highest sibling version folder newer than the one at `root` (complete and not orphaned), or null. */
export function newerSibling(root, requiredFile = null) {
  const layout = cacheLayout(root);
  if (!layout) return null;
  let best = null;
  let names = [];
  try {
    names = fs.readdirSync(layout.versionsDir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!parseSemver(name) || compareSemver(name, layout.version) <= 0) continue;
    if (best && compareSemver(name, best.version) <= 0) continue;
    const dir = path.join(layout.versionsDir, name);
    if (!fs.existsSync(path.join(dir, ".claude-plugin", "plugin.json")) || fs.existsSync(path.join(dir, ".orphaned_at"))) continue;
    if (requiredFile && !fs.existsSync(path.join(dir, requiredFile))) continue;
    best = { version: name, root: dir };
  }
  return best;
}

function walk(directory, base = directory) {
  const files = [];
  let entries = [];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(full, base));
    else if (entry.isFile()) files.push(path.relative(base, full));
  }
  return files;
}

/**
 * Copies the files of the newest sibling version over the active folder, one temp file and rename each,
 * then writes a marker with the synced version. Only an active folder in the plugin cache and a sibling
 * with a higher version qualify. Returns { synced, version?, files?, reason? }.
 */
export function syncInPlace(activeRoot, { env = process.env } = {}) {
  const layout = cacheLayout(activeRoot);
  if (!layout) return { synced: false, reason: "not-in-cache" };
  const source = newerSibling(activeRoot);
  if (!source) return { synced: false, reason: "no-newer-version" };
  const marker = fs.existsSync(path.join(activeRoot, SYNC_MARKER)) ? String(fs.readFileSync(path.join(activeRoot, SYNC_MARKER), "utf8")).trim() : null;
  if (parseSemver(marker) && compareSemver(marker, source.version) >= 0) return { synced: false, reason: "already-synced", version: marker };
  const configured = String(env?.[AUTO_UPDATE_ENV.syncDirs] ?? "").split(",").map((name) => name.trim()).filter(Boolean);
  let files = 0;
  for (const dir of configured.length ? configured : DEFAULT_SYNC_DIRS) {
    if (path.isAbsolute(dir) || dir.split(/[\\/]/u).includes("..")) continue;
    for (const relative of walk(path.join(source.root, dir), source.root)) {
      const from = path.join(source.root, relative);
      const to = path.join(activeRoot, relative);
      const content = fs.readFileSync(from);
      try {
        if (content.equals(fs.readFileSync(to))) continue;
      } catch {
        // missing target: written below
      }
      fs.mkdirSync(path.dirname(to), { recursive: true });
      const temp = `${to}.${process.pid}.tmp`;
      fs.writeFileSync(temp, content, { mode: fs.statSync(from).mode });
      fs.renameSync(temp, to);
      files += 1;
    }
  }
  fs.writeFileSync(path.join(activeRoot, SYNC_MARKER), `${source.version}\n`);
  return { synced: true, version: source.version, files };
}

export function stateDirectory(env = process.env, home = os.homedir()) {
  return env?.CLAUDE_PLUGIN_DATA || path.join(home, ".claude");
}

export function autoUpdatePaths(env = process.env, home = os.homedir()) {
  const directory = stateDirectory(env, home);
  return { state: path.join(directory, STATE_FILE), log: path.join(directory, LOG_FILE) };
}

function positive(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

/** Remembers the plugin folder this session uses, so a later update can sync it in place. */
export function rememberActiveRoot(activeRoot, { env = process.env, home = os.homedir() } = {}) {
  if (!cacheLayout(activeRoot)) return;
  const { state: file } = autoUpdatePaths(env, home);
  const state = readJson(file) ?? {};
  const roots = [...new Set([...(Array.isArray(state.roots) ? state.roots : []), path.resolve(activeRoot)])]
    .filter((root) => fs.existsSync(root)).slice(-ROOTS_LIMIT);
  writeState(file, { ...state, roots });
}

/** Syncs every remembered active folder that has a newer sibling; returns the results. */
export function syncRememberedRoots({ env = process.env, home = os.homedir() } = {}) {
  const roots = readJson(autoUpdatePaths(env, home).state)?.roots;
  return (Array.isArray(roots) ? roots : []).map((root) => {
    try {
      return { root, ...syncInPlace(root, { env }) };
    } catch (error) {
      return { root, synced: false, reason: String(error?.message ?? error) };
    }
  });
}

/**
 * Starts the update when opted in and not throttled. `reason` is "session-start", "stop" or "announced"
 * (then `announcedVersion` is the version another computer reported; a new one bypasses the throttle once).
 * Never waits for the update and never throws. Returns { started, reason }.
 */
export function maybeAutoUpdate({ reason, announcedVersion = null, env = process.env, now = Date.now(), pluginRoot, home = os.homedir(), launch = spawn } = {}) {
  try {
    if (!autoUpdateEnabled(env)) return { started: false, reason: "off" };
    const active = env.CLAUDE_PLUGIN_ROOT || pluginRoot;
    const marketplace = marketplaceOf(pluginRoot || active);
    const plugin = readJson(path.join(pluginRoot || active, ".claude-plugin", "plugin.json"))?.name ?? "agentic-sdlc";
    if (!marketplace) return { started: false, reason: "no-marketplace" };
    const paths = autoUpdatePaths(env, home);
    if (reason === "session-start" && active) rememberActiveRoot(active, { env, home });
    // Files of a version already in the cache reach the active folder without waiting for the next update.
    if (active) syncRememberedRoots({ env, home });
    const state = readJson(paths.state) ?? {};
    const intervalMs = positive(env[AUTO_UPDATE_ENV.intervalMinutes], DEFAULT_INTERVAL_MINUTES) * 60_000;
    const newAnnouncement = reason === "announced" && announcedVersion && state.last_announced !== announcedVersion;
    if (!newAnnouncement && Number.isFinite(state.last_attempt) && now - state.last_attempt < intervalMs) return { started: false, reason: "throttled" };
    writeState(paths.state, { ...state, last_attempt: now, ...(newAnnouncement ? { last_announced: announcedVersion } : {}) });
    const job = {
      claudeBin: env[AUTO_UPDATE_ENV.claudeBin] || "claude",
      marketplace,
      plugin,
      timeoutMs: positive(env[AUTO_UPDATE_ENV.timeoutSeconds], DEFAULT_TIMEOUT_SECONDS) * 1000,
      log: paths.log,
      reason,
    };
    const child = launch(process.execPath, [WORKER, JSON.stringify(job)], { detached: true, stdio: "ignore", windowsHide: true });
    child.on?.("error", () => {});
    child.unref?.();
    return { started: true, reason };
  } catch {
    return { started: false, reason: "error" };
  }
}
