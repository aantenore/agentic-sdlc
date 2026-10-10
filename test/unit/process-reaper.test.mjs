import "../helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ancestorPids,
  compilePatterns,
  mentionsPath,
  parseOlderThanSeconds,
  parsePosixPs,
  parseWindowsCim,
  parseWindowsWmic,
  parseWmicDate,
  pluginCacheScope,
  reapOnStopEnabled,
  reapProcesses,
  reapWarning,
  reaperDefaults,
  resolveReaperPolicy,
  selectReapable,
  stopProcess,
} from "../../lib/runtime/process-reaper.mjs";

const ROOT = path.resolve("/work/Projects/shop");
const WORKTREE = path.resolve("/work/Projects/shop-wt/feature");
const PLUGIN = path.resolve("/home/u/.claude/plugins/cache/market/agentic-sdlc/0.135.0");
const row = (pid, ageMinutes, command, ppid = 1) => ({ pid, ppid, age_seconds: ageMinutes * 60, command });

const TABLE = [
  row(100, 30, `node ${PLUGIN}/bin/agentic-sdlc.mjs gate check --root ${ROOT}`),
  row(101, 45, `node ${ROOT}/node_modules/.bin/vitest run`),
  row(102, 20, `npm test --prefix ${WORKTREE}`),
  row(103, 90, `node ${PLUGIN}/bin/agentic-sdlc.mjs observe --root ${ROOT}`),
  row(104, 90, `node ${PLUGIN}/bin/agentic-sdlc.mjs message listen --root ${ROOT}`),
  row(105, 3, `node ${ROOT}/node_modules/.bin/vitest run`),
  row(106, 50, "npm test --prefix /elsewhere/other-project"),
  row(107, 50, `next dev -p 3100 ${ROOT}`),
  row(108, 50, `${ROOT}-other/node_modules/.bin/vitest run`),
  row(109, 50, `node ${PLUGIN}/bin/agentic-sdlc.mjs run --timeout 2h -- npm test ${ROOT}`),
  row(110, 50, `/bin/zsh -lc something ${ROOT}`),
];

const policy = (config, env = {}) => resolveReaperPolicy(config, env);

function select(rows, config = null, extra = {}) {
  const p = policy(config, extra.env);
  return selectReapable(rows, {
    scope: [ROOT, WORKTREE, pluginCacheScope(PLUGIN), ...p.scope_paths],
    include: compilePatterns(p.include_patterns).compiled,
    exclude: compilePatterns(p.exclude_patterns).compiled,
    olderThanSeconds: extra.olderThanSeconds ?? 600,
    protectedPids: extra.protectedPids ?? new Set(),
    platform: "linux",
  }).map((item) => item.pid);
}

test("selection combines scope, include pattern, exclusions and age", () => {
  // 100 plugin command, 101 vitest, 102 npm test in a worktree, 107 next dev; the rest is out.
  assert.deepEqual(select(TABLE), [100, 101, 102, 107]);
  assert.deepEqual(select(TABLE, null, { olderThanSeconds: 40 * 60 }), [101, 107]);
  assert.deepEqual(select(TABLE, null, { olderThanSeconds: 60 }), [100, 101, 102, 105, 107]);
});

test("a server declared in exclude_patterns survives, and a project can add include patterns", () => {
  const reaper = (value) => ({ host_policy: { process_reaper: value } });
  assert.deepEqual(select(TABLE, reaper({ exclude_patterns: ["-p 3100"] })), [100, 101, 102]);
  assert.deepEqual(select(TABLE, reaper({ include_patterns: ["zsh -lc"] })), [100, 101, 102, 107, 110]);
  assert.deepEqual(select(TABLE, reaper({ exclude_patterns: ["-p 3100", "vitest"] })), [100, 102]);
  assert.deepEqual(select(TABLE, null, { env: { AGENTIC_SDLC_REAP_EXCLUDE: "vitest\n;;npm test" } }), [100, 107]);
  assert.deepEqual(select(TABLE, reaper({ use_default_patterns: false, include_patterns: ["zsh -lc"] })), [110]);
});

test("observe, message listen and run wrappers are never selected, whatever the config", () => {
  const config = { host_policy: { process_reaper: { use_default_patterns: false, include_patterns: [".*"] } } };
  const pids = select(TABLE, config);
  for (const excluded of [103, 104, 109]) assert.equal(pids.includes(excluded), false, String(excluded));
});

test("extra scope folders widen the scope", () => {
  assert.deepEqual(select([row(1, 30, "npm test --prefix /elsewhere/other-project")]), []);
  assert.deepEqual(select([row(1, 30, "npm test --prefix /elsewhere/other-project")], { host_policy: { process_reaper: { scope_paths: ["/elsewhere/other-project"] } } }), [1]);
});

test("a sibling folder with the same prefix is not in scope", () => {
  assert.equal(mentionsPath(`vitest ${ROOT}-other/x`, ROOT, "linux"), false);
  assert.equal(mentionsPath(`vitest ${ROOT}/x`, ROOT, "linux"), true);
  assert.equal(mentionsPath(`vitest ${ROOT}`, ROOT, "linux"), true);
  assert.equal(mentionsPath("node C:\\Work\\Shop\\node_modules\\vitest", "c:/work/shop", "win32"), true);
});

test("this process and all its ancestors are protected, and an unrelated pid is not", () => {
  const table = [row(10, 99, "init", 0), row(20, 99, "claude", 10), row(30, 99, "hook", 20), row(40, 99, "reaper", 30), row(50, 99, "other", 10)];
  const protectedPids = ancestorPids(table, 40);
  assert.deepEqual([...protectedPids].filter((pid) => pid !== process.ppid).sort((a, b) => a - b), [10, 20, 30, 40]);
  assert.equal(protectedPids.has(50), false);
  const cyclic = [row(1, 1, "a", 2), row(2, 1, "b", 1)];
  assert.ok(ancestorPids(cyclic, 1).has(2));
});

test("dry run lists, a real run stops through the injected stopper, once per process", async () => {
  const config = { host_policy: { process_reaper: { older_than_minutes: 10 } } };
  const stopped = [];
  const common = { root: ROOT, config, env: {}, pluginRoot: PLUGIN, platform: "linux", rows: TABLE, worktrees: [WORKTREE], selfPid: 999 };
  const dry = await reapProcesses({ ...common, dryRun: true, stop: async (pid) => stopped.push(pid) });
  assert.deepEqual(dry.processes.map((item) => [item.pid, item.outcome]), [[100, "found"], [101, "found"], [102, "found"], [107, "found"]]);
  assert.equal(stopped.length, 0);
  assert.equal(dry.older_than_minutes, 10);
  const real = await reapProcesses({ ...common, stop: async (pid) => { stopped.push(pid); return "terminated"; } });
  assert.deepEqual(stopped, [100, 101, 102, 107]);
  assert.ok(real.processes.every((item) => item.outcome === "terminated"));
  const protectedSelf = await reapProcesses({ ...common, selfPid: 101, dryRun: true });
  assert.deepEqual(protectedSelf.processes.map((item) => item.pid), [100, 102, 107]);
  const bad = await reapProcesses({ ...common, dryRun: true, config: { host_policy: { process_reaper: { exclude_patterns: ["("] } } } });
  assert.deepEqual(bad.invalid_patterns, ["("]);
});

test("policy defaults come from the shipped file and the project, env opt-in wins", () => {
  const defaults = reaperDefaults();
  assert.equal(policy(null).older_than_seconds, defaults.older_than_minutes * 60);
  assert.equal(policy({ host_policy: { process_reaper: { older_than_minutes: 3 } } }).older_than_seconds, 180);
  assert.equal(policy({ host_policy: { process_reaper: { older_than_minutes: -4 } } }).older_than_seconds, 600);
  assert.equal(reapOnStopEnabled(policy(null), {}), false);
  assert.equal(reapOnStopEnabled(policy(null), { AGENTIC_SDLC_REAP_ON_STOP: "1" }), true);
  assert.equal(reapOnStopEnabled(policy({ host_policy: { process_reaper: { reap_on_stop: true } } }), {}), true);
  assert.equal(reapOnStopEnabled(policy({ host_policy: { process_reaper: { reap_on_stop: true } } }), { AGENTIC_SDLC_REAP_ON_STOP: "0" }), false);
  for (const pattern of defaults.include_patterns.concat(defaults.exclude_patterns)) assert.doesNotThrow(() => new RegExp(pattern, "iu"), pattern);
  assert.equal(parseOlderThanSeconds("10"), 600);
  assert.equal(parseOlderThanSeconds("90s"), 90);
  assert.equal(parseOlderThanSeconds("2h"), 7200);
  assert.equal(parseOlderThanSeconds("x"), null);
});

test("the plugin cache scope is the plugin folder inside plugins/cache", () => {
  assert.equal(pluginCacheScope(PLUGIN), path.resolve("/home/u/.claude/plugins/cache/market/agentic-sdlc"));
  assert.equal(pluginCacheScope("/src/agentic-sdlc"), path.resolve("/src/agentic-sdlc"));
});

test("ps output is parsed with pid, ppid, elapsed time and the whole command", () => {
  const rows = parsePosixPs([
    "  100     1 01:02:03 node /a/b.mjs --x",
    "  101   100    05:07 npm test",
    " 5 1 2-03:04:05 sleep 600",
    "garbage",
    "  7 1 notatime cmd",
  ].join("\n"));
  assert.deepEqual(rows, [
    { pid: 100, ppid: 1, age_seconds: 3723, command: "node /a/b.mjs --x" },
    { pid: 101, ppid: 100, age_seconds: 307, command: "npm test" },
    { pid: 5, ppid: 1, age_seconds: 183845, command: "sleep 600" },
  ]);
});

test("Windows: CIM JSON and wmic CSV are parsed into the same rows", () => {
  const now = Date.parse("2026-03-01T12:00:00Z");
  const cim = JSON.stringify([
    { ProcessId: 10, ParentProcessId: 4, CommandLine: "node C:\\Work\\Shop\\x.js", CreationDate: "2026-03-01T11:30:00.0000000Z" },
    { ProcessId: 11, ParentProcessId: 10, CommandLine: null, CreationDate: "2026-03-01T11:59:00.0000000Z" },
    { ProcessId: 0, ParentProcessId: 0, CommandLine: "x", CreationDate: "2026-03-01T11:59:00.0000000Z" },
    { ProcessId: 12, ParentProcessId: 1, CommandLine: "no date", CreationDate: null },
  ]);
  assert.deepEqual(parseWindowsCim(cim, now), [
    { pid: 10, ppid: 4, age_seconds: 1800, command: "node C:\\Work\\Shop\\x.js" },
    { pid: 11, ppid: 10, age_seconds: 60, command: "" },
  ]);
  // A single process comes out of ConvertTo-Json as an object, not an array; a BOM and noise are tolerated.
  assert.equal(parseWindowsCim(`\uFEFF${JSON.stringify({ ProcessId: 5, ParentProcessId: 1, CommandLine: "a", CreationDate: "2026-03-01T11:00:00Z" })}`, now)[0].age_seconds, 3600);
  assert.deepEqual(parseWindowsCim("not json", now), []);

  assert.equal(parseWmicDate("20260301113000.000000+000"), Date.parse("2026-03-01T11:30:00Z"));
  assert.equal(parseWmicDate("20260301133000.000000+120"), Date.parse("2026-03-01T11:30:00Z"));
  assert.equal(parseWmicDate("bad"), null);
  const csv = [
    "Node,CommandLine,CreationDate,ParentProcessId,ProcessId",
    "PC1,\"node C:\\Work\\Shop\\a.js\",20260301113000.000000+000,4,10",
    "PC1,node --opt=a,b C:\\Work\\Shop\\b.js,20260301115900.000000+000,10,11",
    "PC1,,20260301115900.000000+000,0,0",
    "",
  ].join("\r\n");
  const rows = parseWindowsWmic(csv, now);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { pid: 10, ppid: 4, age_seconds: 1800, command: "\"node C:\\Work\\Shop\\a.js\"" });
  assert.deepEqual(rows[1], { pid: 11, ppid: 10, age_seconds: 60, command: "node --opt=a,b C:\\Work\\Shop\\b.js" });
});

test("Windows stops through taskkill /T /F; POSIX escalates from SIGTERM to SIGKILL", async () => {
  const calls = [];
  const outcome = await stopProcess(77, { platform: "win32", run: (...args) => { calls.push(args); return { status: 0 }; } });
  assert.equal(outcome, "killed");
  assert.deepEqual(calls[0].slice(0, 2), ["taskkill", ["/pid", "77", "/T", "/F"]]);
  assert.equal(await stopProcess(77, { platform: "win32", run: () => ({ status: 128 }) }), "failed");

  const signals = [];
  const stubborn = await stopProcess(5, { platform: "linux", killAfterSeconds: 0.05, signal: (pid, name) => signals.push(name), alive: () => true, wait: async () => {} });
  assert.equal(stubborn, "killed");
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  signals.length = 0;
  let checks = 0;
  const polite = await stopProcess(5, { platform: "linux", signal: (pid, name) => signals.push(name), alive: () => (checks += 1) < 3, wait: async () => {} });
  assert.equal(polite, "terminated");
  assert.deepEqual(signals, ["SIGTERM"]);
  const missing = await stopProcess(5, { platform: "linux", signal: () => { throw Object.assign(new Error("x"), { code: "ESRCH" }); } });
  assert.equal(missing, "gone");
});

test("the warning names the count, the limit, the first processes and the command", () => {
  const result = { older_than_minutes: 10, processes: [1, 2, 3, 4].map((pid) => ({ pid, age_minutes: 12, command: `node long-${pid}` })) };
  const text = reapWarning(result);
  assert.match(text, /^4 processi oltre 10 min: 1 node long-1; 2 node long-2; 3 node long-3 e altri 1, esegui `agentic-sdlc processes reap`\.$/u);
  assert.equal(reapWarning({ older_than_minutes: 10, processes: [] }), "");
});

test("a real process of ours is found and then stopped (the only real kill in this file)", { skip: process.platform === "win32" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reaper-real-"));
  const marker = `reaper-marker-${process.pid}-${Date.now()}`;
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", path.join(dir, marker)], { stdio: "ignore" });
  try {
    await new Promise((resolve) => child.once("spawn", resolve));
    const config = { host_policy: { process_reaper: { include_patterns: [marker], scope_paths: [dir] } } };
    const common = { root: dir, config, env: {}, olderThanSeconds: 0, worktrees: [] };
    const dry = await reapProcesses({ ...common, dryRun: true });
    assert.deepEqual(dry.processes.map((item) => item.pid), [child.pid]);
    assert.equal(process.kill(child.pid, 0), true);
    const real = await reapProcesses(common);
    assert.deepEqual(real.processes.map((item) => [item.pid, item.outcome]), [[child.pid, "terminated"]]);
    await new Promise((resolve) => (child.exitCode !== null || child.signalCode ? resolve() : child.once("exit", resolve)));
    assert.equal(child.signalCode, "SIGTERM");
  } finally {
    if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
