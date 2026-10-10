/**
 * Keeps plugin processes from running for hours.
 *
 * Each CLI run writes `<git-common-dir>/agentic-sdlc/runs/<pid>.json` and
 * removes it on exit. A run stops itself after AGENTIC_SDLC_MAX_RUN_MINUTES
 * (default 30, 0 = no limit); `message listen` after
 * AGENTIC_SDLC_LISTEN_MAX_HOURS (default 8, 0 = no limit). The reaper stops
 * registered runs that outlived their limit by a grace period, but only when
 * the process still looks like one of ours, so a reused pid is never touched.
 * The Change Observatory server is never registered and never stopped.
 *
 * Everything here is best effort: a failure never fails the command.
 */
import path from "node:path";

import { childProcess, Date, fs, os, process } from "../runtime/host.mjs";

export const MAX_RUN_MINUTES_ENV = "AGENTIC_SDLC_MAX_RUN_MINUTES";
export const LISTEN_MAX_HOURS_ENV = "AGENTIC_SDLC_LISTEN_MAX_HOURS";
export const DEFAULT_MAX_RUN_MINUTES = 30;
export const DEFAULT_LISTEN_MAX_HOURS = 8;
export const REAP_GRACE_MINUTES = 5;
export const KILL_AFTER_MS = 10_000;
export const LISTEN_ACTION = "message.listen";
// Never registered, never stopped: the Observatory is a server by design.
export const EXCLUDED_ACTIONS = Object.freeze(["observe"]);
const MARKER = "agentic-sdlc";

function nonNegativeInteger(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = Number(String(value).trim());
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function maxRunMinutes(env = process.env) {
  return nonNegativeInteger(env?.[MAX_RUN_MINUTES_ENV], DEFAULT_MAX_RUN_MINUTES);
}

export function listenMaxHours(env = process.env) {
  return nonNegativeInteger(env?.[LISTEN_MAX_HOURS_ENV], DEFAULT_LISTEN_MAX_HOURS);
}

/** The limit, in minutes, for one action (0 = none). */
export function limitMinutesFor(action, env = process.env) {
  return action === LISTEN_ACTION ? listenMaxHours(env) * 60 : maxRunMinutes(env);
}

/** The git common dir for a folder, found without starting git; null outside a repository. */
export function findGitCommonDir(start) {
  let current = path.resolve(String(start || process.cwd()));
  for (;;) {
    const dotGit = path.join(current, ".git");
    try {
      const stat = fs.statSync(dotGit);
      if (stat.isDirectory()) return dotGit;
      if (stat.isFile()) {
        const match = /^gitdir:\s*(.+?)\s*$/mu.exec(fs.readFileSync(dotGit, "utf8"));
        if (!match) return null;
        const gitDir = path.resolve(current, match[1]);
        try {
          return path.resolve(gitDir, fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim());
        } catch {
          return gitDir;
        }
      }
    } catch {
      // keep walking up
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function runsDirectory(commonDir) {
  return path.join(commonDir, "agentic-sdlc", "runs");
}

export function locksDirectory(commonDir) {
  return path.join(commonDir, "agentic-sdlc", "locks");
}

/** Lock files of single-flight commands, with their parsed holder (null when unreadable). */
export function readLocks(commonDir) {
  let names = [];
  try {
    names = fs.readdirSync(locksDirectory(commonDir)).filter((name) => name.endsWith(".lock"));
  } catch {
    return [];
  }
  return names.map((name) => {
    const file = path.join(locksDirectory(commonDir), name);
    try {
      const holder = JSON.parse(fs.readFileSync(file, "utf8"));
      return { file, holder: holder && typeof holder === "object" ? holder : null };
    } catch {
      return { file, holder: null };
    }
  });
}

/**
 * True when a lock holder no longer protects anything: unreadable, its process
 * is gone or is not one of ours, or it outlived the run limit plus grace.
 */
export function isLockStale(holder, { now = Date.now(), alive = isAlive, commandLine = commandLineOf, env = process.env, graceMinutes = REAP_GRACE_MINUTES } = {}) {
  const pid = Number(holder?.pid);
  if (!holder || !Number.isSafeInteger(pid) || pid <= 0 || !alive(pid)) return true;
  const limit = maxRunMinutes(env);
  if (limit > 0 && ageMinutes(holder, now) > limit + graceMinutes) return true;
  const line = commandLine(pid);
  return line !== null && !looksLikeOurRun(line);
}

/** Remove stale lock files; returns the files removed. */
export function reapStaleLocks(commonDir, options = {}) {
  const removed = [];
  if (!commonDir) return removed;
  for (const { file, holder } of readLocks(commonDir)) {
    try {
      if (Number(holder?.pid) === process.pid) continue;
      if (!isLockStale(holder, options)) continue;
      fs.rmSync(file, { force: true });
      removed.push(file);
    } catch {
      // best effort
    }
  }
  return removed;
}

/** Option names only: values may hold message text or other private data. */
export function summarizeArgv(argv) {
  const words = [];
  for (const arg of argv.map(String)) {
    if (arg.startsWith("--")) words.push(arg.split("=")[0]);
    else if (words.length === 0 || !words.at(-1).startsWith("--")) {
      if (words.some((word) => word.startsWith("--"))) continue;
      words.push(arg.slice(0, 40));
    }
  }
  return words.slice(0, 12).join(" ");
}

export function buildRunRecord({ pid, action, argv = [], root, maxMinutes, now = Date.now(), host = os.hostname() }) {
  return {
    pid,
    started_at: new Date(now).toISOString(),
    command: action,
    argv: summarizeArgv(argv),
    root,
    host: process.env.AGENTIC_SDLC_HOST_LABEL || host,
    max_minutes: maxMinutes,
  };
}

export function writeRunRecord(commonDir, record) {
  const directory = runsDirectory(commonDir);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${record.pid}.json`);
  fs.writeFileSync(file, `${JSON.stringify(record)}\n`);
  return file;
}

export function removeRunRecord(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // best effort
  }
}

export function readRuns(commonDir) {
  let names = [];
  try {
    names = fs.readdirSync(runsDirectory(commonDir)).filter((name) => /^\d+\.json$/u.test(name));
  } catch {
    return [];
  }
  return names.map((name) => {
    const file = path.join(runsDirectory(commonDir), name);
    try {
      const record = JSON.parse(fs.readFileSync(file, "utf8"));
      return { file, record: record && typeof record === "object" ? record : null };
    } catch {
      return { file, record: null };
    }
  });
}

export function ageMinutes(record, now = Date.now()) {
  const started = Date.parse(record?.started_at);
  return Number.isFinite(started) ? Math.max(0, (now - started) / 60_000) : Infinity;
}

/** `ps -o etime` ([[dd-]hh:]mm:ss) in seconds; null when unreadable. */
export function parseEtime(value) {
  const match = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/u.exec(String(value ?? ""));
  if (!match) return null;
  const [, days = 0, hours = 0, minutes, seconds] = match;
  return Number(days) * 86_400 + Number(hours) * 3_600 + Number(minutes) * 60 + Number(seconds);
}

/**
 * Entries to stop or clean. Without `olderThanMinutes` or `pid`, a run is
 * stale once it outlived its own limit plus the grace period (`message listen`
 * gets no grace: its limit is already hours). Runs with no limit are never
 * stale by default. Excluded actions are never selected.
 */
export function selectStaleRuns(entries, { now = Date.now(), olderThanMinutes, pid, graceMinutes = REAP_GRACE_MINUTES } = {}) {
  return entries.filter(({ record }) => {
    if (!record) return pid === undefined;
    if (EXCLUDED_ACTIONS.includes(record.command)) return false;
    if (pid !== undefined) return Number(record.pid) === Number(pid);
    const age = ageMinutes(record, now);
    if (olderThanMinutes !== undefined) return age >= Number(olderThanMinutes);
    const limit = Number(record.max_minutes);
    if (!Number.isFinite(limit) || limit <= 0) return false;
    return age > limit + (record.command === LISTEN_ACTION ? 0 : graceMinutes);
  });
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** The process command line on POSIX; null on Windows or when unknown. */
export function commandLineOf(pid) {
  if (process.platform === "win32") return null;
  try {
    const result = childProcess.spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 3_000, windowsHide: true });
    return result.status === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

/** True only when the command line proves this is one of our runs and not the Observatory. */
export function looksLikeOurRun(commandLine) {
  if (!commandLine || !commandLine.includes(MARKER)) return false;
  return !/\sobserve(?:\s|$)/u.test(commandLine);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Stop stale runs and drop records of dead ones. `force` (an explicit
 * `runs stop`) also stops a run whose command line cannot be read (Windows).
 * Returns what happened, one entry per record touched.
 */
export function reapStaleRuns(commonDir, options = {}) {
  const results = [];
  if (!commonDir) return results;
  const {
    now = Date.now(), olderThanMinutes, pid, force = false,
    alive = isAlive, commandLine = commandLineOf, kill = (target, signal) => process.kill(target, signal),
    wait = sleep, killAfterMs = KILL_AFTER_MS,
  } = options;
  try {
    const terminated = [];
    for (const entry of selectStaleRuns(readRuns(commonDir), { now, olderThanMinutes, pid })) {
      const target = Number(entry.record?.pid);
      if (!entry.record || !Number.isSafeInteger(target) || target <= 0 || !alive(target)) {
        removeRunRecord(entry.file);
        results.push({ pid: target || null, outcome: "removed" });
        continue;
      }
      if (target === process.pid) continue;
      const line = commandLine(target);
      if (!looksLikeOurRun(line) && !(force && line === null)) {
        // A reused pid or an unreadable command line: leave the process alone.
        if (line !== null) removeRunRecord(entry.file);
        results.push({ pid: target, outcome: "skipped" });
        continue;
      }
      try {
        kill(target, "SIGTERM");
        terminated.push(entry);
        results.push({ pid: target, command: entry.record.command, outcome: "stopped" });
      } catch {
        results.push({ pid: target, outcome: "skipped" });
      }
    }
    if (terminated.length > 0) {
      const deadline = Date.now() + killAfterMs;
      while (Date.now() < deadline && terminated.some((entry) => alive(Number(entry.record.pid)))) wait(200);
      for (const entry of terminated) {
        const target = Number(entry.record.pid);
        const line = alive(target) ? commandLine(target) : undefined;
        // Still running and still ours (pid not reused meanwhile): escalate.
        if (line !== undefined && (looksLikeOurRun(line) || (force && line === null))) {
          try {
            kill(target, "SIGKILL");
          } catch {
            // already gone
          }
        }
        removeRunRecord(entry.file);
      }
    }
  } catch {
    // best effort
  }
  reapStaleLocks(commonDir, { alive, commandLine });
  return results;
}

/** `ps -o pid=,etime=,command=` lines as rows; unreadable lines are dropped. */
export function parsePsLines(text) {
  const rows = [];
  for (const line of String(text ?? "").split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/u.exec(line);
    if (!match) continue;
    const seconds = parseEtime(match[2]);
    if (seconds === null) continue;
    rows.push({ pid: Number(match[1]), age_seconds: seconds, command: match[3] });
  }
  return rows;
}

const PLUGIN_BIN = /agentic-sdlc[^\s]*[\\/]bin[\\/]agentic-sdlc\.mjs(?:\s|$)/u;

/**
 * Plugin CLI processes (any installed version, registered or not) that ran
 * past their limit: commands after AGENTIC_SDLC_MAX_RUN_MINUTES, `message
 * listen` after its hour limit. The Observatory and this process are never selected.
 */
export function selectStaleProcesses(rows, { maxMinutes, listenHours, selfPid = process.pid, graceMinutes = 0 } = {}) {
  return rows.filter((row) => {
    const program = path.basename(String(row.command).split(/\s+/u)[0] || "");
    if (row.pid === selfPid || !/^node(?:\.exe)?$/iu.test(program)) return false;
    if (!PLUGIN_BIN.test(row.command) || !looksLikeOurRun(row.command)) return false;
    const listen = /\smessage\s+listen(?:\s|$)/u.test(row.command);
    const limit = listen ? listenHours * 60 : maxMinutes + graceMinutes;
    if (!(Number(listen ? listenHours : maxMinutes) > 0)) return false;
    return row.age_seconds / 60 > limit;
  });
}

/** This user's plugin processes from `ps`; [] on Windows or when ps fails. */
export function listPluginProcesses() {
  if (process.platform === "win32" || typeof process.getuid !== "function") return [];
  try {
    const result = childProcess.spawnSync("ps", ["-U", String(process.getuid()), "-o", "pid=,etime=,command="], { encoding: "utf8", timeout: 3_000, windowsHide: true });
    return result.status === 0 ? parsePsLines(result.stdout) : [];
  } catch {
    return [];
  }
}

const SCAN_EVERY_MS = 5 * 60_000;
const SCAN_BUILD = import.meta.url;

/**
 * Also stops plugin processes that are not in the registry (started by older
 * versions). Throttled to once every few minutes per repository.
 */
export function reapUnregisteredProcesses(commonDir, { env = process.env, rows, kill = (target, signal) => process.kill(target, signal), alive = isAlive, wait = sleep, now = Date.now(), commandLine = commandLineOf, killAfterMs = KILL_AFTER_MS } = {}) {
  const stopped = [];
  try {
    if (!rows) {
      if (commonDir) {
        const stamp = path.join(runsDirectory(commonDir), ".scan");
        try {
          // A different plugin build scans at once: the first command after an update stops old runs.
          if (now - fs.statSync(stamp).mtimeMs < SCAN_EVERY_MS && fs.readFileSync(stamp, "utf8") === SCAN_BUILD) return stopped;
        } catch {
          // first scan
        }
        fs.mkdirSync(runsDirectory(commonDir), { recursive: true });
        fs.writeFileSync(stamp, SCAN_BUILD);
      }
      rows = listPluginProcesses();
    }
    for (const row of selectStaleProcesses(rows, { maxMinutes: maxRunMinutes(env), listenHours: listenMaxHours(env) })) {
      try {
        kill(row.pid, "SIGTERM");
        stopped.push(row.pid);
      } catch {
        // not ours or gone
      }
    }
    if (stopped.length > 0) {
      const deadline = Date.now() + killAfterMs;
      while (Date.now() < deadline && stopped.some(alive)) wait(200);
      for (const pid of stopped.filter((target) => alive(target) && looksLikeOurRun(commandLine(target)))) {
        try {
          kill(pid, "SIGKILL");
        } catch {
          // gone
        }
      }
    }
  } catch {
    // best effort
  }
  return stopped;
}

export const WATCHDOG_POLL_MS = 5_000;
export const WATCHDOG_KILL_AFTER_MS = KILL_AFTER_MS;
// The watchdog never outlives the limit by more than this, whatever happens.
export const WATCHDOG_HARD_STOP_MS = 60_000;

/**
 * One watchdog tick: "exit" (parent gone or hard stop reached), "term" (limit
 * exceeded), "kill" (SIGTERM ignored for killAfterMs) or "wait". Pure, and
 * serialized into the watchdog process, so it must not reference anything
 * outside its parameters.
 */
export function watchdogStep({ alive, elapsedMs, limitMs, termSentAtMs = null, killAfterMs, hardStopMs }) {
  if (!alive) return "exit";
  if (termSentAtMs !== null) {
    if (elapsedMs - termSentAtMs >= killAfterMs) return "kill";
    return elapsedMs >= limitMs + hardStopMs ? "exit" : "wait";
  }
  if (elapsedMs >= limitMs + hardStopMs) return "exit";
  return elapsedMs >= limitMs ? "term" : "wait";
}

/** Source of the detached watchdog process. Arguments: pid limitMs pollMs killAfterMs hardStopMs logFile recordFile. */
export function watchdogScript() {
  return `"use strict";
const fs = require("node:fs");
const step = ${watchdogStep.toString()};
const [pid, limitMs, pollMs, killAfterMs, hardStopMs] = process.argv.slice(1, 6).map(Number);
const [logFile, recordFile] = process.argv.slice(6, 8);
const startMs = Date.now();
let termSentAtMs = null;
const alive = () => { try { process.kill(pid, 0); return true; } catch (error) { return error && error.code === "EPERM"; } };
const signal = (name) => { try { process.kill(pid, process.platform === "win32" ? undefined : name); } catch {} };
const tick = () => {
  const elapsedMs = Date.now() - startMs;
  const action = step({ alive: alive(), elapsedMs, limitMs, termSentAtMs, killAfterMs, hardStopMs });
  if (action === "term") {
    try { if (logFile) fs.appendFileSync(logFile, new Date().toISOString() + " pid " + pid + " exceeded " + Math.round(limitMs / 60000 * 100) / 100 + " min; SIGTERM\\n"); } catch {}
    signal("SIGTERM");
    termSentAtMs = elapsedMs;
    if (process.platform === "win32") termSentAtMs = -killAfterMs;
  } else if (action === "kill") {
    if (process.platform !== "win32") signal("SIGKILL");
    try { if (logFile) fs.appendFileSync(logFile, new Date().toISOString() + " pid " + pid + " ignored SIGTERM; SIGKILL\\n"); } catch {}
    try { if (recordFile) fs.rmSync(recordFile, { force: true }); } catch {}
    process.exit(0);
  } else if (action === "exit") {
    process.exit(0);
  }
};
setInterval(tick, pollMs);
`;
}

/**
 * Start a detached process that stops `pid` once it runs past `limitMinutes`,
 * even when its event loop is blocked in synchronous calls (timers and signal
 * handlers then never run). It exits as soon as the parent is gone. Returns
 * the child, or null when disabled or when it cannot start.
 */
export function startWatchdog({ pid = process.pid, limitMinutes, logFile = "", recordFile = "", pollMs = WATCHDOG_POLL_MS, killAfterMs = WATCHDOG_KILL_AFTER_MS, hardStopMs = WATCHDOG_HARD_STOP_MS, spawn = childProcess.spawn } = {}) {
  if (!(Number(limitMinutes) > 0)) return null;
  try {
    const args = [pid, Math.round(limitMinutes * 60_000), pollMs, killAfterMs, hardStopMs, logFile || "", recordFile || ""].map(String);
    const child = spawn(process.execPath, ["-e", watchdogScript(), ...args], { detached: true, stdio: "ignore", windowsHide: true });
    child.on?.("error", () => {});
    child.unref?.();
    return child;
  } catch {
    return null;
  }
}

/**
 * Register this run and arm its self-stop timer. Returns a function that
 * removes the record and calls `release` (the single-flight lock); it also runs on exit and on SIGINT/SIGTERM.
 */
export function registerCurrentRun({ action, argv, root, env = process.env, stderr = (text) => process.stderr.write(text), exitCode = 4, release = () => {} }) {
  if (EXCLUDED_ACTIONS.includes(action)) {
    process.once("exit", release);
    return release;
  }
  const maxMinutes = limitMinutesFor(action, env);
  let file = null;
  const commonDir = findGitCommonDir(root);
  if (commonDir) {
    try {
      reapStaleRuns(commonDir);
      reapUnregisteredProcesses(commonDir, { env });
      file = writeRunRecord(commonDir, buildRunRecord({ pid: process.pid, action, argv, root, maxMinutes }));
    } catch {
      file = null;
    }
  }
  const watchdog = startWatchdog({
    limitMinutes: maxMinutes,
    logFile: commonDir ? path.join(runsDirectory(commonDir), "watchdog.log") : "",
    recordFile: file || "",
  });
  const cleanup = () => {
    if (file) removeRunRecord(file);
    file = null;
    try {
      watchdog?.kill();
    } catch {
      // already gone
    }
    try {
      release();
    } catch {
      // best effort
    }
  };
  process.once("exit", cleanup);
  if (action !== LISTEN_ACTION) {
    // `message listen` handles these signals itself and then exits normally.
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const onSignal = () => {
        cleanup();
        process.removeListener(signal, onSignal);
        process.kill(process.pid, signal);
      };
      process.on(signal, onSignal);
    }
  }
  if (maxMinutes > 0) {
    const listen = action === LISTEN_ACTION;
    const timer = setTimeout(() => {
      stderr(listen
        ? `agentic-sdlc: message listen stopped after ${maxMinutes / 60} hours; rerun it or raise ${LISTEN_MAX_HOURS_ENV}.\n`
        : `agentic-sdlc: stopped after ${maxMinutes} minutes; rerun or raise ${MAX_RUN_MINUTES_ENV}.\n`);
      cleanup();
      process.exit(listen ? 0 : exitCode);
    }, maxMinutes * 60_000);
    timer.unref();
  }
  return cleanup;
}
