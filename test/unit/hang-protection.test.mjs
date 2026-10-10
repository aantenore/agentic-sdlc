import "../helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  boundChildProcess,
  describeGitCall,
  gitTimeoutSeconds,
  parseLimitSeconds,
} from "../../lib/runtime/bounded-child-process.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(repoRoot, "bin/agentic-sdlc.mjs");

test("limits read as durations; 0 turns one off and a bad value keeps the default", () => {
  assert.equal(parseLimitSeconds("90s"), 90);
  assert.equal(parseLimitSeconds("10m"), 600);
  assert.equal(parseLimitSeconds("0"), 0);
  assert.equal(parseLimitSeconds("soon"), null);
  assert.equal(gitTimeoutSeconds({}), 300);
  assert.equal(gitTimeoutSeconds({ AGENTIC_SDLC_GIT_TIMEOUT_SECONDS: "0" }), 0);
  assert.equal(gitTimeoutSeconds({ AGENTIC_SDLC_GIT_TIMEOUT_SECONDS: "x" }), 300);
  assert.equal(describeGitCall(["-C", "/repo", "-c", "a=b", "status", "--porcelain"]), "git status --porcelain");
});

test("a git call without a limit gets one and never prompts; other programs are untouched", () => {
  const calls = [];
  const fake = {
    execFileSync: (file, args, options) => {
      calls.push({ file, options });
      return "";
    },
  };
  const bounded = boundChildProcess(fake, { env: () => ({ PATH: "/bin" }), stderr: () => {} });
  bounded.execFileSync("git", ["status"], { encoding: "utf8" });
  bounded.execFileSync("git", ["fetch"], { timeout: 1_000 });
  bounded.execFileSync("node", ["-v"], { encoding: "utf8" });
  assert.equal(calls[0].options.timeout, 300_000);
  assert.equal(calls[0].options.env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(calls[1].options.timeout, 1_000);
  assert.equal(calls[2].options.timeout, undefined);
});

test("a git call that runs out of time names the command and its likely cause", () => {
  const bounded = boundChildProcess(childProcess, {
    env: () => ({ ...process.env, AGENTIC_SDLC_GIT_TIMEOUT_SECONDS: "1" }),
    stderr: () => {},
  });
  assert.throws(
    () => bounded.execFileSync("git", ["-c", "alias.hang=!sleep 3", "hang"], { stdio: "ignore" }),
    /git hang did not finish within 1s: another git process may hold the repository .*AGENTIC_SDLC_GIT_TIMEOUT_SECONDS/u,
  );
});

test("a slow command says it is still working on stderr only", () => {
  let now = 0;
  const lines = [];
  const bounded = boundChildProcess({ spawnSync: () => { now += 6_000; return { status: 0 }; } }, {
    env: () => ({}),
    stderr: (line) => lines.push(line),
    clock: () => now,
    startedAt: 0,
    label: () => "orchestrate status",
  });
  bounded.spawnSync("git", ["fetch", "origin"], {});
  assert.match(lines[0], /^agentic-sdlc orchestrate status: still working \(6s; last step git fetch origin 6s\)/u);
  const quiet = [];
  boundChildProcess({ spawnSync: () => { now += 6_000; return { status: 0 }; } }, {
    env: () => ({ AGENTIC_SDLC_PROGRESS: "off" }),
    stderr: (line) => quiet.push(line),
    clock: () => now,
    startedAt: 0,
  }).spawnSync("git", ["status"], {});
  assert.deepEqual(quiet, []);
});

test("optimization run stops a command that prints nothing, with exit code 124", { skip: process.platform === "win32" }, () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-sdlc-hang-"));
  try {
    childProcess.spawnSync("git", ["init", "-q"], { cwd: project });
    fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "x", scripts: { test: "echo started && sleep 20" } }));
    const started = Date.now();
    const result = childProcess.spawnSync(process.execPath, [
      cli, "optimization", "run", "--command-json", JSON.stringify(["npm", "test"]), "--idle-timeout", "2s",
    ], { cwd: project, encoding: "utf8", timeout: 60_000 });
    assert.equal(result.status, 124, result.stderr);
    assert.match(result.stdout, /started/u);
    assert.match(result.stderr, /stopping the command, it printed nothing for 2s \(--idle-timeout\)/u);
    assert.ok(Date.now() - started < 15_000, "the whole process tree was stopped");
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});
