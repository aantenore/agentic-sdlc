import "../helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { AGENT_HOST_OVERRIDE_ENV, detectAgentHost, namesAgentHost } from "../../lib/agent-host.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(repoRoot, "bin/agentic-sdlc.mjs");
const HOST_VARIABLES = [
  "CI", "GITHUB_ACTIONS", "GITHUB_ACTOR", "CODEX_AGENT_NAME", "CODEX_THREAD_ID", "CODEX_RUN_ID",
  "CODEX_SESSION_ID", "CODEX_USER_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", AGENT_HOST_OVERRIDE_ENV,
];

function run(args, extraEnv = {}) {
  const env = { ...process.env };
  for (const key of HOST_VARIABLES) delete env[key];
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 60_000, env: { ...env, ...extraEnv } });
}

test("the agent host is detected from its marker variables, with an explicit override", () => {
  assert.deepEqual([detectAgentHost({}).id, detectAgentHost({}).detected], ["codex", false]);
  assert.equal(detectAgentHost({ CLAUDECODE: "1" }).id, "claude-code");
  assert.equal(detectAgentHost({ CLAUDECODE: "1" }).name, "Claude Code");
  assert.equal(detectAgentHost({ CODEX_THREAD_ID: "thread-1" }).id, "codex");
  assert.equal(detectAgentHost({ CODEX_THREAD_ID: "thread-1" }).detected, true);
  assert.equal(detectAgentHost({ CLAUDECODE: "1", [AGENT_HOST_OVERRIDE_ENV]: "Codex" }).id, "codex");
  assert.equal(detectAgentHost({ CLAUDECODE: " " }).detected, false);
  assert.throws(() => detectAgentHost({ [AGENT_HOST_OVERRIDE_ENV]: "unknown-host" }), /must be one of: codex, claude-code/u);
  assert.equal(namesAgentHost("claude-code-reviewer"), true);
  assert.equal(namesAgentHost("maria"), false);
});

test("records without an explicit actor name the host that ran the command", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-agent-host-")));
  assert.equal(run(["init", "--root", root, "--project-name", "Agent host"]).status, 0);
  const append = (env) => {
    const result = run(["trace", "append", "--root", root, "--type", "decision", "--summary", "Recorded", "--json"], env);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).event;
  };

  const claude = append({ CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "session-claude" });
  assert.deepEqual(
    [claude.actor.id, claude.actor.type, claude.actor.name, claude.actor.source],
    ["claude-code", "agent", "Claude Code", "environment"],
  );
  assert.equal(claude.run.session_id, "session-claude");

  const codex = append({ CODEX_THREAD_ID: "thread-codex" });
  assert.deepEqual([codex.actor.id, codex.actor.name, codex.run.thread_id], ["codex", "Codex", "thread-codex"]);

  const fallback = append({});
  assert.deepEqual([fallback.actor.id, fallback.actor.source], ["codex", "default"]);

  const overridden = append({ CLAUDECODE: "1", [AGENT_HOST_OVERRIDE_ENV]: "codex" });
  assert.equal(overridden.actor.id, "codex");
});
