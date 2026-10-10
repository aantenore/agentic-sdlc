import assert from "node:assert/strict";
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
  removeRunRecord,
  selectStaleProcesses,
  selectStaleRuns,
  summarizeArgv,
  writeRunRecord,
} from "../../lib/runtime/run-registry.mjs";

const NOW = Date.parse("2026-01-01T12:00:00Z");
const minutesAgo = (minutes) => new Date(NOW - minutes * 60_000).toISOString();
const entry = (pid, command, ageMinutes, max = 30) => ({ file: `${pid}.json`, record: { pid, command, started_at: minutesAgo(ageMinutes), max_minutes: max } });

test("limits come from the environment with safe defaults", () => {
  assert.equal(maxRunMinutes({}), 30);
  assert.equal(maxRunMinutes({ AGENTIC_SDLC_MAX_RUN_MINUTES: "0" }), 0);
  assert.equal(maxRunMinutes({ AGENTIC_SDLC_MAX_RUN_MINUTES: "nope" }), 30);
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
