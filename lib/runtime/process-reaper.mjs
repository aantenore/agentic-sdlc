/**
 * `agentic-sdlc processes reap`: stops the current user's development
 * processes that outlived a limit.
 *
 * A process is a candidate when ALL of these hold: it belongs to the current
 * user (POSIX), its command line contains the project root, one of its git
 * worktrees, the plugin cache or a configured extra path; it matches an
 * include pattern; it matches no exclude pattern; and it has run longer than
 * the limit. This process and every ancestor of it (the hook that started the
 * reaper, the agent host, the shell) are never candidates.
 *
 * Defaults live in config/process-reaper.json; a project extends or overrides
 * them in `.sdlc/config.json` -> `host_policy.process_reaper`, and
 * AGENTIC_SDLC_REAP_EXCLUDE adds exclusions. Windows reads processes from
 * `Get-CimInstance Win32_Process` (wmic as a fallback) and stops them with
 * `taskkill /T /F`.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { childProcess, fs, process } from "./host.mjs";
import { parseLimitSeconds } from "./bounded-child-process.mjs";

export const REAP_EXCLUDE_ENV = "AGENTIC_SDLC_REAP_EXCLUDE";
export const REAP_ON_STOP_ENV = "AGENTIC_SDLC_REAP_ON_STOP";
const DEFAULTS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "config", "process-reaper.json");

let cachedDefaults = null;
export function reaperDefaults() {
  cachedDefaults ??= JSON.parse(fs.readFileSync(DEFAULTS_FILE, "utf8"));
  return cachedDefaults;
}

/** `--older-than` value in seconds: a bare number is minutes, else 90s / 10m / 2h / 1d. Null when unreadable. */
export function parseOlderThanSeconds(value) {
  const text = String(value ?? "").trim();
  if (/^\d+$/u.test(text)) return Number(text) * 60;
  return parseLimitSeconds(text);
}

function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim() !== "") : [];
}

function splitEnvPatterns(value) {
  return String(value ?? "").split(/\n|;;/u).map((item) => item.trim()).filter(Boolean);
}

/**
 * The effective policy from the defaults, the project's
 * `host_policy.process_reaper` and the environment. `config` is the parsed
 * `.sdlc/config.json` (or null).
 */
export function resolveReaperPolicy(config, env = process.env, defaults = reaperDefaults()) {
  const own = config?.host_policy?.process_reaper ?? {};
  const keepDefaults = own.use_default_patterns !== false;
  const minutes = Number.isFinite(Number(own.older_than_minutes)) && Number(own.older_than_minutes) > 0
    ? Number(own.older_than_minutes)
    : defaults.older_than_minutes;
  return {
    older_than_seconds: Math.round(minutes * 60),
    kill_after_seconds: defaults.kill_after_seconds,
    warning_throttle_seconds: defaults.warning_throttle_minutes * 60,
    include_patterns: [...(keepDefaults ? stringList(defaults.include_patterns) : []), ...stringList(own.include_patterns)],
    // observe and message listen stay excluded whatever the project says.
    exclude_patterns: [...stringList(defaults.exclude_patterns), ...stringList(own.exclude_patterns), ...splitEnvPatterns(env?.[REAP_EXCLUDE_ENV])],
    scope_paths: stringList(own.scope_paths),
    reap_on_stop: own.reap_on_stop === true,
  };
}

/** True when the opt-in to reap at Stop is on: the environment (1/0) wins over the project's reap_on_stop. */
export function reapOnStopEnabled(policy, env = process.env) {
  const value = String(env?.[REAP_ON_STOP_ENV] ?? "").trim().toLowerCase();
  if (["1", "true", "on", "yes"].includes(value)) return true;
  if (["0", "false", "off", "no"].includes(value)) return false;
  return policy.reap_on_stop === true;
}

/** The project's parsed `.sdlc/config.json` (nearest folder up the tree that has one) and that folder; config is null when absent or unreadable. */
export function readProjectConfig(start) {
  let current = path.resolve(String(start || process.cwd()));
  for (;;) {
    try {
      if (fs.statSync(path.join(current, ".sdlc")).isDirectory()) {
        let config = null;
        try {
          config = JSON.parse(fs.readFileSync(path.join(current, ".sdlc", "config.json"), "utf8"));
        } catch {
          // no readable config: defaults apply
        }
        return { root: current, config };
      }
    } catch {
      // keep walking up
    }
    const parent = path.dirname(current);
    if (parent === current) return { root: path.resolve(String(start || process.cwd())), config: null };
    current = parent;
  }
}

/** The plugin cache folder that holds this plugin (`.../plugins/cache/<marketplace>/<plugin>`), else the plugin folder itself. */
export function pluginCacheScope(pluginRoot) {
  const normalized = path.resolve(pluginRoot);
  const parts = normalized.split(path.sep);
  const index = parts.lastIndexOf("cache");
  if (index > 0 && parts[index - 1] === "plugins" && parts.length > index + 2) return parts.slice(0, index + 3).join(path.sep);
  return normalized;
}

/** Worktree folders of the repository at `root` (`git worktree list`); [] when git is unavailable. */
export function listWorktrees(root, run = (...args) => childProcess.spawnSync(...args)) {
  try {
    const result = run("git", ["-C", root, "worktree", "list", "--porcelain"], { encoding: "utf8", timeout: 5_000, windowsHide: true });
    if (result.status !== 0) return [];
    return String(result.stdout).split(/\r?\n/u).filter((line) => line.startsWith("worktree ")).map((line) => line.slice("worktree ".length).trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** Folders whose processes are in scope: project root, its worktrees, the plugin cache and the configured extras. */
export function scopePaths({ root, policy, pluginRoot, worktrees = listWorktrees(root) }) {
  const all = [root, ...worktrees, ...(pluginRoot ? [pluginCacheScope(pluginRoot)] : []), ...policy.scope_paths];
  return [...new Set(all.map((item) => path.resolve(item)))];
}

function comparable(text, caseInsensitive) {
  const slashed = String(text).replace(/\\/gu, "/");
  return caseInsensitive ? slashed.toLowerCase() : slashed;
}

/** True when `commandLine` mentions the folder `folder` (not merely a sibling that starts with the same letters). */
export function mentionsPath(commandLine, folder, platform = process.platform) {
  const ci = platform === "win32" || platform === "darwin";
  const haystack = comparable(commandLine, ci);
  const needle = comparable(folder, ci).replace(/\/+$/u, "");
  if (needle === "") return false;
  for (let from = haystack.indexOf(needle); from >= 0; from = haystack.indexOf(needle, from + 1)) {
    const next = haystack[from + needle.length];
    if (next === undefined || /[/\s"':;,)]/u.test(next)) return true;
  }
  return false;
}

/** Compiles patterns; an invalid one is reported in `invalid` and ignored. */
export function compilePatterns(patterns) {
  const compiled = [];
  const invalid = [];
  for (const pattern of patterns) {
    try {
      compiled.push(new RegExp(pattern, "iu"));
    } catch {
      invalid.push(pattern);
    }
  }
  return { compiled, invalid };
}

/** The pids of `selfPid` and all its ancestors, from the process table rows. */
export function ancestorPids(rows, selfPid = process.pid) {
  const parentOf = new Map(rows.map((row) => [row.pid, row.ppid]));
  const protectedPids = new Set([selfPid]);
  for (let pid = parentOf.get(selfPid); Number.isInteger(pid) && pid > 0 && !protectedPids.has(pid); pid = parentOf.get(pid)) protectedPids.add(pid);
  // A hook may be started through a process that already left the table: the parent reported by the OS still counts.
  if (typeof process.ppid === "number" && selfPid === process.pid) protectedPids.add(process.ppid);
  return protectedPids;
}

/**
 * Candidates among `rows` ({ pid, ppid, age_seconds, command }).
 * Pure: everything it needs is passed in.
 */
export function selectReapable(rows, { scope, include, exclude, olderThanSeconds, protectedPids, platform = process.platform }) {
  return rows.filter((row) => {
    if (protectedPids.has(row.pid) || !row.command) return false;
    if (row.age_seconds < olderThanSeconds) return false;
    if (!scope.some((folder) => mentionsPath(row.command, folder, platform))) return false;
    if (include.length > 0 && !include.some((pattern) => pattern.test(row.command))) return false;
    return !exclude.some((pattern) => pattern.test(row.command));
  });
}

// ---- process table -------------------------------------------------------

/** `ps -o etime` ([[dd-]hh:]mm:ss) in seconds; null when unreadable. */
export function parseEtimeSeconds(value) {
  const match = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/u.exec(String(value ?? ""));
  if (!match) return null;
  const [, days = 0, hours = 0, minutes, seconds] = match;
  return Number(days) * 86_400 + Number(hours) * 3_600 + Number(minutes) * 60 + Number(seconds);
}

/** `ps -o pid=,ppid=,etime=,command=` output as rows; unreadable lines are dropped. */
export function parsePosixPs(text) {
  const rows = [];
  for (const line of String(text ?? "").split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/u.exec(line);
    if (!match) continue;
    const age = parseEtimeSeconds(match[3]);
    if (age === null) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), age_seconds: age, command: match[4] });
  }
  return rows;
}

/**
 * `Get-CimInstance Win32_Process | ConvertTo-Json` output as rows. The script
 * emits `CreationDate` as an ISO-8601 string (UTC); `now` is the reference.
 */
export function parseWindowsCim(text, now = Date.now()) {
  let data;
  try {
    data = JSON.parse(String(text ?? "").replace(/^﻿/u, "").trim() || "[]");
  } catch {
    return [];
  }
  const rows = [];
  for (const item of Array.isArray(data) ? data : [data]) {
    const pid = Number(item?.ProcessId);
    const created = Date.parse(item?.CreationDate);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(created)) continue;
    rows.push({ pid, ppid: Number(item.ParentProcessId) || 0, age_seconds: Math.max(0, Math.round((now - created) / 1000)), command: String(item.CommandLine ?? "") });
  }
  return rows;
}

/** wmic CreationDate (`yyyymmddHHMMSS.ffffff+UUU`, UUU = minutes from UTC) as epoch ms; null when unreadable. */
export function parseWmicDate(value) {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.\d+)?([+-]\d{3})?$/u.exec(String(value ?? "").trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second, offset = "+000"] = match;
  return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)) - Number(offset) * 60_000;
}

/**
 * `wmic process get CommandLine,CreationDate,ParentProcessId,ProcessId /format:csv`
 * output as rows. The command line may contain commas, so the three trailing
 * numeric columns are read from the end of each line.
 */
export function parseWindowsWmic(text, now = Date.now()) {
  const rows = [];
  for (const line of String(text ?? "").split(/\r?\n/u)) {
    const match = /^[^,]*,(.*),(\d{14}\.\d+[+-]\d{3}),(\d+),(\d+)\s*$/u.exec(line);
    if (!match) continue;
    const created = parseWmicDate(match[2]);
    if (created === null) continue;
    rows.push({ pid: Number(match[4]), ppid: Number(match[3]), age_seconds: Math.max(0, Math.round((now - created) / 1000)), command: match[1] });
  }
  return rows;
}

const POWERSHELL_SCRIPT = "Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ ProcessId = $_.ProcessId; ParentProcessId = $_.ParentProcessId; CommandLine = $_.CommandLine; CreationDate = $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null }) } } | ConvertTo-Json -Compress";

/** The process table: this user's processes on POSIX, every process on Windows (there the scope is the folder, not the owner). */
export function listProcesses({ platform = process.platform, run = (...args) => childProcess.spawnSync(...args), now = Date.now(), uid = typeof process.getuid === "function" ? process.getuid() : null } = {}) {
  const options = { encoding: "utf8", timeout: 20_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 };
  try {
    if (platform === "win32") {
      const powershell = run("powershell", ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL_SCRIPT], options);
      if (powershell.status === 0) {
        const rows = parseWindowsCim(powershell.stdout, now);
        if (rows.length > 0) return rows;
      }
      const wmic = run("wmic", ["process", "get", "CommandLine,CreationDate,ParentProcessId,ProcessId", "/format:csv"], options);
      return wmic.status === 0 ? parseWindowsWmic(wmic.stdout, now) : [];
    }
    const args = uid === null ? ["-A", "-o", "pid=,ppid=,etime=,command="] : ["-U", String(uid), "-o", "pid=,ppid=,etime=,command="];
    const result = run("ps", args, options);
    return result.status === 0 ? parsePosixPs(result.stdout) : [];
  } catch {
    return [];
  }
}

// ---- stopping ------------------------------------------------------------

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Stops one process: SIGTERM then SIGKILL after `killAfterSeconds` (POSIX); taskkill /T /F (Windows). Returns the outcome. */
export async function stopProcess(pid, { platform = process.platform, killAfterSeconds = 5, signal = (target, name) => process.kill(target, name), alive = isAlive, run = (...args) => childProcess.spawnSync(...args), wait = pause } = {}) {
  if (platform === "win32") {
    const result = run("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 15_000 });
    return result.status === 0 ? "killed" : "failed";
  }
  try {
    signal(pid, "SIGTERM");
  } catch (error) {
    return error?.code === "ESRCH" ? "gone" : "failed";
  }
  const deadline = Date.now() + killAfterSeconds * 1000;
  while (Date.now() < deadline && alive(pid)) await wait(200);
  if (!alive(pid)) return "terminated";
  try {
    signal(pid, "SIGKILL");
    return "killed";
  } catch (error) {
    return error?.code === "ESRCH" ? "terminated" : "failed";
  }
}

function describe(row) {
  return { pid: row.pid, age_minutes: Math.round(row.age_seconds / 6) / 10, command: row.command };
}

/**
 * Finds the processes over the limit and, unless `dryRun`, stops them.
 * `rows` (a process table) and `stop` can be replaced for tests.
 */
export async function reapProcesses({
  root,
  config = null,
  olderThanSeconds,
  dryRun = false,
  env = process.env,
  pluginRoot = null,
  platform = process.platform,
  rows = null,
  worktrees,
  selfPid = process.pid,
  stop = stopProcess,
} = {}) {
  const policy = resolveReaperPolicy(config, env);
  const limit = olderThanSeconds ?? policy.older_than_seconds;
  const table = rows ?? listProcesses({ platform });
  const include = compilePatterns(policy.include_patterns);
  const exclude = compilePatterns(policy.exclude_patterns);
  const selected = selectReapable(table, {
    scope: scopePaths({ root, policy, pluginRoot, ...(worktrees === undefined ? {} : { worktrees }) }),
    include: include.compiled,
    exclude: exclude.compiled,
    olderThanSeconds: limit,
    protectedPids: ancestorPids(table, selfPid),
    platform,
  });
  const processes = [];
  for (const row of selected) {
    const entry = describe(row);
    entry.outcome = dryRun ? "found" : await stop(row.pid, { platform, killAfterSeconds: policy.kill_after_seconds });
    processes.push(entry);
  }
  return {
    older_than_minutes: Math.round(limit / 6) / 10,
    dry_run: dryRun,
    invalid_patterns: [...include.invalid, ...exclude.invalid],
    processes,
  };
}

/** The Stop-hook warning for a dry-run result, or "" when nothing is over the limit. */
export function reapWarning(result, { maxListed = 3, width = 60 } = {}) {
  const count = result.processes.length;
  if (count === 0) return "";
  const listed = result.processes.slice(0, maxListed).map((item) => `${item.pid} ${item.command.slice(0, width)}`).join("; ");
  const more = count > maxListed ? ` e altri ${count - maxListed}` : "";
  return `${count} processi oltre ${result.older_than_minutes} min: ${listed}${more}, esegui \`agentic-sdlc processes reap\`.`;
}

