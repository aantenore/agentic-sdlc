import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildRunRecord,
  findGitCommonDir,
  limitMinutesFor,
  looksLikeOurRun,
  maxRunMinutes,
  parseEtime,
  parsePsLines,
  readRuns,
  reapStaleRuns,
  reapUnregisteredProcesses,
  removeRunRecord,
  selectStaleProcesses,
  selectStaleRuns,
  startWatchdog,
  summarizeArgv,
  watchdogStep,
  writeRunRecord,
} from "../../lib/runtime/run-registry.mjs";

const NOW = Date.parse("2026-01-01T12:00:00Z");
const minutesAgo = (minutes) => new Date(NOW - minutes * 60_000).toISOString();
const entry = (pid, command, ageMinutes, max = 30) => ({ file: `${pid}.json`, record: { pid, command, started_at: minutesAgo(ageMinutes), max_minutes: max } });

test("limits come from the environment with safe defaults", () => {
  assert.equal(maxRunMinutes({}), 10);
  assert.equal(maxRunMinutes({ AGENTIC_SDLC_MAX_RUN_MINUTES: "0" }), 0);
  assert.equal(maxRunMinutes({ AGENTIC_SDLC_MAX_RUN_MINUTES: "nope" }), 10);
  assert.equal(limitMinutesFor("message.listen", {}), 480);
  assert.equal(limitMinutesFor("message.listen", { AGENTIC_SDLC_LISTEN_MAX_HOURS: "2" }), 120);
});

test("etime parses every ps format", () => {
  assert.equal(parseEtime("05:03"), 303);
  assert.equal(parseEtime("01:00:00"), 3600);
  assert.equal(parseEtime("2-00:00:01"), 172_801);
  assert.equal(parseEtime("bad"), null);
});

test("stale selection honours limit, grace, listen hours, exclusions and filters", () => {
  const entries = [
    entry(1, "status", 34), entry(2, "status", 36), entry(3, "message.listen", 481, 480),
    entry(4, "observe", 9999), entry(5, "gate.check", 9999, 0), { file: "6.json", record: null },
  ];
  assert.deepEqual(selectStaleRuns(entries, { now: NOW }).map((item) => item.record?.pid ?? null), [2, 3, null]);
  assert.deepEqual(selectStaleRuns(entries, { now: NOW, olderThanMinutes: 400 }).map((item) => item.record?.pid ?? null), [3, 5, null]);
  assert.deepEqual(selectStaleRuns(entries, { now: NOW, pid: 1 }).map((item) => item.record?.pid ?? null), [1]);
});

test("argv summary keeps option names and drops their values", () => {
  assert.equal(summarizeArgv(["message", "send", "--text", "secret words", "--story=ST-1"]), "message send --text --story");
});

test("only our non-Observatory processes are recognized", () => {
  assert.equal(looksLikeOurRun("node /x/agentic-sdlc/0.70.0/bin/agentic-sdlc.mjs gate check"), true);
  assert.equal(looksLikeOurRun("node /x/agentic-sdlc/bin/agentic-sdlc.mjs observe --no-open"), false);
  assert.equal(looksLikeOurRun("/usr/bin/vim notes"), false);
  assert.equal(looksLikeOurRun(null), false);
});

test("unregistered processes from older versions are selected from ps lines", () => {
  const rows = parsePsLines([
    "  101    45:00 node /home/u/.claude/plugins/cache/agentic-sdlc/0.52.0/bin/agentic-sdlc.mjs workflow status",
    "  102    20:00 node /home/u/.claude/plugins/cache/agentic-sdlc/0.70.0/bin/agentic-sdlc.mjs gate check",
    "  103 01:00:00 node /home/u/agentic-sdlc/bin/agentic-sdlc.mjs observe --no-open",
    "  104 07:00:00 /usr/local/bin/node /p/agentic-sdlc/0.60.0/bin/agentic-sdlc.mjs message listen --json",
    "  105 09:00:00 node /p/agentic-sdlc/0.60.0/bin/agentic-sdlc.mjs message listen --json",
    "  106 05:00:00 vim /p/agentic-sdlc/bin/agentic-sdlc.mjs",
    "  107 05:00:00 node /p/agentic-sdlc/hooks/agentic-sdlc-guard.mjs stop",
    "garbage",
  ].join("\n"));
  assert.equal(rows.length, 7);
  assert.deepEqual(selectStaleProcesses(rows, { maxMinutes: 30, listenHours: 8, selfPid: 1 }).map((row) => row.pid), [101, 105]);
  assert.deepEqual(selectStaleProcesses(rows, { maxMinutes: 0, listenHours: 0, selfPid: 1 }), []);
  assert.deepEqual(selectStaleProcesses(rows, { maxMinutes: 30, listenHours: 8, selfPid: 101 }).map((row) => row.pid), [105]);
});

test("registry records are written, read, reaped and removed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runs-"));
  fs.mkdirSync(path.join(root, ".git"));
  fs.mkdirSync(path.join(root, "sub"));
  const commonDir = findGitCommonDir(path.join(root, "sub"));
  assert.equal(commonDir, path.join(root, ".git"));
  const record = buildRunRecord({ pid: 999_001, action: "status", argv: ["status"], root, maxMinutes: 30, now: NOW - 60 * 60_000, host: "h" });
  const file = writeRunRecord(commonDir, record);
  writeRunRecord(commonDir, { ...record, pid: 999_002 });
  assert.equal(readRuns(commonDir).length, 2);
  const signals = [];
  const results = reapStaleRuns(commonDir, {
    now: NOW,
    alive: (pid) => pid === 999_001 && signals.length === 0,
    commandLine: () => "node /x/agentic-sdlc/bin/agentic-sdlc.mjs status",
    kill: (pid, signal) => signals.push([pid, signal]),
    wait: () => {},
  });
  assert.deepEqual(signals, [[999_001, "SIGTERM"]]);
  assert.deepEqual(results.map((item) => item.outcome).sort(), ["removed", "stopped"]);
  assert.equal(readRuns(commonDir).length, 0);
  removeRunRecord(file);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a reused pid is left alone", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runs-"));
  writeRunRecord(root, buildRunRecord({ pid: 999_003, action: "status", root, maxMinutes: 30, now: NOW - 60 * 60_000, host: "h" }));
  const signals = [];
  const results = reapStaleRuns(root, { now: NOW, alive: () => true, commandLine: () => "/usr/bin/python3 server.py", kill: (...args) => signals.push(args) });
  assert.deepEqual(signals, []);
  assert.equal(results[0].outcome, "skipped");
  fs.rmSync(root, { recursive: true, force: true });
});

test("watchdog step: waits, terminates past the limit, kills when ignored, never outlives the parent", () => {
  const base = { alive: true, limitMs: 60_000, killAfterMs: 10_000, hardStopMs: 60_000 };
  assert.equal(watchdogStep({ ...base, alive: false, elapsedMs: 0 }), "exit");
  assert.equal(watchdogStep({ ...base, elapsedMs: 59_999 }), "wait");
  assert.equal(watchdogStep({ ...base, elapsedMs: 60_000 }), "term");
  assert.equal(watchdogStep({ ...base, elapsedMs: 65_000, termSentAtMs: 60_000 }), "wait");
  assert.equal(watchdogStep({ ...base, elapsedMs: 70_000, termSentAtMs: 60_000 }), "kill");
  assert.equal(watchdogStep({ ...base, elapsedMs: 120_000 }), "exit");
  assert.equal(watchdogStep({ ...base, alive: false, elapsedMs: 70_000, termSentAtMs: 60_000 }), "exit");
});

test("watchdog is disabled with a zero limit", () => {
  assert.equal(startWatchdog({ limitMinutes: 0, spawn: () => assert.fail("must not spawn") }), null);
});

test("watchdog stops a child blocked in synchronous work that ignores SIGTERM", { timeout: 20_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-"));
  const logFile = path.join(dir, "watchdog.log");
  const recordFile = path.join(dir, "run.json");
  fs.writeFileSync(recordFile, "{}");
  const blocked = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); while (true) {}"], { stdio: "ignore" });
  const exited = new Promise((resolve) => blocked.once("exit", (code, signal) => resolve(signal)));
  const watchdog = startWatchdog({ pid: blocked.pid, limitMinutes: 0.01, logFile, recordFile, pollMs: 100, killAfterMs: 500 });
  try {
    assert.equal(await exited, "SIGKILL");
    await new Promise((resolve) => (watchdog.exitCode === null ? watchdog.once("exit", resolve) : resolve()));
    assert.match(fs.readFileSync(logFile, "utf8"), /SIGTERM[\s\S]*SIGKILL/u);
    assert.equal(fs.existsSync(recordFile), false);
  } finally {
    blocked.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("watchdog exits as soon as the parent is gone", { timeout: 10_000 }, async () => {
  const parent = spawn(process.execPath, ["-e", "setTimeout(() => {}, 200)"], { stdio: "ignore" });
  const watchdog = startWatchdog({ pid: parent.pid, limitMinutes: 30, pollMs: 100 });
  const code = await new Promise((resolve) => watchdog.once("exit", resolve));
  assert.equal(code, 0);
});

test("reaper escalates to SIGKILL only when the pid still runs our command", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reap-kill-"));
  try {
    for (const pid of [101, 102]) writeRunRecord(dir, buildRunRecord({ pid, action: "gate.check", argv: ["gate", "check"], root: dir, maxMinutes: 1, now: NOW - 60 * 60_000 }));
    const signals = [];
    const lines = { 101: "node /x/agentic-sdlc/bin/agentic-sdlc.mjs gate check", 102: "node /x/agentic-sdlc/bin/agentic-sdlc.mjs gate check" };
    const terminated = new Set();
    reapStaleRuns(dir, {
      now: NOW,
      alive: () => true,
      commandLine: (pid) => (terminated.has(102) && pid === 102 ? "/usr/bin/other" : lines[pid]),
      kill: (pid, signal) => { signals.push(`${pid}:${signal}`); if (signal === "SIGTERM") terminated.add(pid); },
      wait: () => {},
      killAfterMs: 0,
    });
    assert.deepEqual(signals.sort(), ["101:SIGKILL", "101:SIGTERM", "102:SIGTERM"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("running processes of any older version past the run limit are selected right after an update", () => {
  const rows = parsePsLines([
    "  201    31:00 node /Users/u/.claude/plugins/cache/aantenore/agentic-sdlc/0.41.0/bin/agentic-sdlc.mjs gate check --strict --lifecycle-complete",
    "  202    29:00 node /Users/u/.claude/plugins/cache/aantenore/agentic-sdlc/0.71.0/bin/agentic-sdlc.mjs gate check --strict",
    "  203 02:10:00 /opt/homebrew/bin/node /Users/u/.codex/plugins/cache/aantenore/agentic-sdlc/0.30.2/bin/agentic-sdlc.mjs story complete-step",
    "  204 07:59:00 node /Users/u/.codex/plugins/cache/aantenore/agentic-sdlc/0.30.2/bin/agentic-sdlc.mjs message listen",
    "  205 3-00:00:00 node /Users/u/.claude/plugins/cache/aantenore/agentic-sdlc/0.20.0/bin/agentic-sdlc.mjs observe",
  ].join("\n"));
  assert.deepEqual(selectStaleProcesses(rows, { maxMinutes: 30, listenHours: 8, selfPid: 1 }).map((row) => row.pid), [201, 203]);
});

test("unregistered stale processes that ignore SIGTERM get SIGKILL after re-checking the command line", () => {
  const rows = parsePsLines([
    "  301    40:00 node /p/agentic-sdlc/0.50.0/bin/agentic-sdlc.mjs gate check",
    "  302    40:00 node /p/agentic-sdlc/0.50.0/bin/agentic-sdlc.mjs gate check",
  ].join("\n"));
  const signals = [];
  const stopped = reapUnregisteredProcesses(null, {
    env: {},
    rows,
    alive: () => true,
    wait: () => {},
    killAfterMs: 0,
    commandLine: (pid) => (pid === 301 ? rows[0].command : "/usr/bin/reused"),
    kill: (pid, signal) => signals.push(`${pid}:${signal}`),
  });
  assert.deepEqual(stopped, [301, 302]);
  assert.deepEqual(signals, ["301:SIGTERM", "302:SIGTERM", "301:SIGKILL"]);
});
