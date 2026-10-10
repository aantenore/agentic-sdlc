import "../helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  exitCodeFor,
  launchSpec,
  parseDeadlineSeconds,
  quoteWindowsArgument,
  runWithDeadline,
  TIMEOUT_EXIT_CODE,
} from "../../lib/runtime/timed-run.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(ROOT, "bin", "agentic-sdlc.mjs");
const quiet = { stdout: () => {}, stderr: () => {} };

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

test("deadline durations need a unit-aware positive value", () => {
  assert.equal(parseDeadlineSeconds("90s"), 90);
  assert.equal(parseDeadlineSeconds("10m"), 600);
  assert.equal(parseDeadlineSeconds("2h"), 7200);
  assert.equal(parseDeadlineSeconds("0"), null);
  assert.equal(parseDeadlineSeconds("soon"), null);
  assert.equal(parseDeadlineSeconds(undefined), null);
});

test("a command that ends before the deadline returns its own exit code", async () => {
  assert.equal(await runWithDeadline({ argv: [process.execPath, "-e", "process.exit(0)"], timeoutSeconds: 30, ...quiet }), 0);
  assert.equal(await runWithDeadline({ argv: [process.execPath, "-e", "process.exit(7)"], timeoutSeconds: 30, ...quiet }), 7);
  assert.equal(await runWithDeadline({ argv: ["agentic-sdlc-no-such-command-xyz"], timeoutSeconds: 30, ...quiet }), 127);
  assert.equal(exitCodeFor(null, "SIGTERM"), 143);
  assert.equal(exitCodeFor(3, null), 3);
});

test("output passes through and is copied to --log", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "timed-run-log-"));
  try {
    const out = [];
    const err = [];
    const log = path.join(dir, "nested", "run.log");
    const code = await runWithDeadline({
      argv: [process.execPath, "-e", "console.log('to-out');console.error('to-err');process.exit(2)"],
      timeoutSeconds: 30,
      logFile: log,
      stdout: (chunk) => out.push(String(chunk)),
      stderr: (chunk) => err.push(String(chunk)),
    });
    assert.equal(code, 2);
    assert.match(out.join(""), /to-out/u);
    assert.match(err.join(""), /to-err/u);
    const text = fs.readFileSync(log, "utf8");
    assert.match(text, /to-out/u);
    assert.match(text, /to-err/u);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("at the deadline the whole tree is stopped, grandchildren included, with exit 124", { skip: process.platform === "win32" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "timed-run-tree-"));
  const pidFile = path.join(dir, "grandchild.pid");
  const grandchild = "setInterval(() => {}, 1000)";
  const child = `const { spawn } = require('node:child_process');`
    + `const g = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' });`
    + `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));`
    + "setInterval(() => {}, 1000)";
  const messages = [];
  let grandchildPid = null;
  try {
    const started = Date.now();
    const code = await runWithDeadline({ argv: [process.execPath, "-e", child], timeoutSeconds: 1, graceMs: 2000, stdout: () => {}, stderr: (text) => messages.push(text) });
    assert.equal(code, TIMEOUT_EXIT_CODE);
    assert.ok(Date.now() - started < 15_000);
    assert.match(messages.join(""), /deadline of 1s reached/u);
    grandchildPid = Number(fs.readFileSync(pidFile, "utf8"));
    assert.ok(grandchildPid > 0);
    // The kill is delivered before runWithDeadline resolves; allow the OS a moment to reap.
    for (let attempt = 0; attempt < 40 && isAlive(grandchildPid); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(isAlive(grandchildPid), false, "the grandchild must be gone");
  } finally {
    if (grandchildPid && isAlive(grandchildPid)) process.kill(grandchildPid, "SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a command that ignores SIGTERM is killed after the grace period", { skip: process.platform === "win32" }, async () => {
  const stubborn = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";
  const code = await runWithDeadline({ argv: [process.execPath, "-e", stubborn], timeoutSeconds: 1, graceMs: 300, ...quiet });
  assert.equal(code, TIMEOUT_EXIT_CODE);
});

test("Windows uses taskkill /T /F for the tree and cmd.exe for shims", async () => {
  const calls = [];
  const { killTree } = await import("../../lib/runtime/timed-run.mjs");
  await killTree(4321, { platform: "win32", run: (...args) => calls.push(args) });
  assert.deepEqual(calls[0].slice(0, 2), ["taskkill", ["/pid", "4321", "/T", "/F"]]);

  assert.deepEqual(launchSpec(["node.exe", "a b"], "win32"), { file: "node.exe", args: ["a b"], options: {} });
  const shim = launchSpec(["npm", "run", "test one"], "win32");
  assert.deepEqual(shim.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(shim.args[3], '"npm run "test one""');
  assert.equal(shim.options.windowsVerbatimArguments, true);
  assert.deepEqual(launchSpec(["npm", "test"], "linux"), { file: "npm", args: ["test"], options: {} });
  assert.equal(quoteWindowsArgument("plain"), "plain");
  assert.equal(quoteWindowsArgument('say "hi"'), '"say \\"hi\\""');
});

test("the CLI passes everything after -- to the command, requires a deadline and keeps the exit code", () => {
  const run = (...args) => spawnSync(process.execPath, [CLI, "run", ...args], { encoding: "utf8", env: { ...process.env, AGENTIC_SDLC_RUN_DEADLINE: "" } });
  const ok = run("--timeout", "30s", "--", process.execPath, "-e", "console.log(process.argv.slice(1).join('|'));process.exit(5)", "--", "--flag", "x");
  assert.equal(ok.status, 5);
  assert.equal(ok.stdout.trim(), "--flag|x");
  const missing = run("--", process.execPath, "-e", "0");
  assert.equal(missing.status, 2);
  assert.match(missing.stderr + missing.stdout, /needs a deadline/u);
  const none = run("--timeout", "30s");
  assert.notEqual(none.status, 0);
  assert.match(none.stderr + none.stdout, /needs the command after --/u);
  const late = run("--timeout", "1s", "--", process.execPath, "-e", "setInterval(() => {}, 1000)");
  assert.equal(late.status, 124);
  assert.match(late.stderr, /deadline of 1s reached/u);
});
