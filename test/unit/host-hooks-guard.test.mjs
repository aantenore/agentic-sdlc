import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { editedPaths, evaluatePreToolUse, sessionStartContext } from "../../lib/host-hooks/guard.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOOK = path.join(ROOT, "hooks", "agentic-sdlc-guard.mjs");

function shell(command) {
  return { tool_name: "Bash", tool_input: { command } };
}

function codexPatch(...files) {
  return {
    tool_name: "apply_patch",
    turn_id: "turn-1",
    tool_input: { command: ["*** Begin Patch", ...files.map((file) => `*** Update File: ${file}`), "@@", "*** End Patch"].join("\n") },
  };
}

test("only the user can approve a standing approval", () => {
  for (const command of [
    "node bin/agentic-sdlc.mjs autonomy standing approve --id SA-X --actor-type human --approval-source explicit-user --summary ok",
    "npx agentic-sdlc autonomy standing approve --id SA-X",
    "cd /work && node \"/plugins/agentic sdlc/bin/agentic-sdlc.mjs\"   autonomy  standing approve --id SA-X",
    "node bin/agentic-sdlc.mjs autonomy standing \"approve\" --id SA-1 --actor-type human",
    "node bin/agentic-sdlc.mjs autonomy standing \\\n  approve --id SA-1",
  ]) {
    const verdict = evaluatePreToolUse(shell(command));
    assert.equal(verdict?.decision, "deny", command);
    assert.match(verdict.reason, /ask them to run this exact command themselves/u);
  }
  for (const command of [
    "node bin/agentic-sdlc.mjs autonomy standing propose --id SA-X",
    "node bin/agentic-sdlc.mjs autonomy standing revoke --id SA-X --reason stop",
    "node bin/agentic-sdlc.mjs autonomy standing status --json",
    "node bin/agentic-sdlc.mjs autonomy delivery approve --id AUT-1 --standing-approval SA-X",
  ]) {
    assert.equal(evaluatePreToolUse(shell(command)), null, command);
  }
});

test("standing approval records change only through the CLI, in either host's edit tools", () => {
  for (const payload of [
    { tool_name: "Write", tool_input: { file_path: "/work/p/.sdlc/autonomy/standing/SA-X/approval.json", content: "{}" } },
    { tool_name: "Edit", tool_input: { file_path: ".sdlc\\autonomy\\standing\\SA-X\\uses\\0001.json" } },
    { tool_name: "MultiEdit", tool_input: { file_path: ".sdlc/autonomy/standing/SA-X/proposal.json" } },
    codexPatch("src/a.mjs", ".sdlc/autonomy/standing/SA-X/revocation.json"),
    shell("rm -rf .sdlc/autonomy/standing/SA-X/revocation.json"),
    shell("echo '{}' > .sdlc/autonomy/standing/SA-X/approval.json"),
    shell("sed -i 's/a/b/' .sdlc/autonomy/standing/SA-X/proposal.json"),
    shell("git checkout HEAD~1 -- .sdlc/autonomy/standing/SA-X"),
    shell("node -e \"require('fs').unlinkSync('.sdlc/autonomy/standing/SA-X/revocation.json')\""),
    { tool_name: "PowerShell", tool_input: { command: "Remove-Item .sdlc\\autonomy\\standing\\SA-X\\revocation.json" } },
    shell("rm -rf .sdlc/autonomy/standing*"),
    shell("cd .sdlc/autonomy && rm standing/SA-X/revocation.json"),
    shell("find .sdlc -name revocation.json -delete"),
    shell("git checkout HEAD~1 -- .sdlc"),
    shell("node bin/agentic-sdlc.mjs status && rm -rf .sdlc/autonomy/standing/SA-X"),
    { tool_name: "Write", tool_input: { file_path: "/work/p/.sdlc/autonomy/x/../standing/SA-X/approval.json" } },
    { tool_name: "Write", tool_input: { file_path: "/work/p/.SDLC/Autonomy/Standing/SA-X/approval.json" } },
  ]) {
    assert.equal(evaluatePreToolUse(payload)?.decision, "deny", JSON.stringify(payload));
  }
  assert.deepEqual(editedPaths("apply_patch", codexPatch("a.mjs", "b.mjs").tool_input), ["a.mjs", "b.mjs"]);
  for (const payload of [
    { tool_name: "Write", tool_input: { file_path: "src/standing.mjs" } },
    { tool_name: "Edit", tool_input: { file_path: ".sdlc/autonomy/requirements/REQ.json" } },
    codexPatch("lib/standing-approvals.mjs"),
    shell("npm test"),
    shell("cat .sdlc/autonomy/standing/SA-X/approval.json"),
    shell("git add .sdlc/autonomy/standing && git commit -m 'chore: record standing approval'"),
    shell("git diff -- .sdlc/autonomy/standing"),
    shell("ls .sdlc/autonomy/standing 2>/dev/null || echo none"),
    shell("cat .sdlc/autonomy/standing/SA-1/proposal.json 2>&1 | head"),
    shell("git add .sdlc && git commit -m 'chore: record decisions'"),
    shell("node bin/agentic-sdlc.mjs autonomy standing status --json > status.json"),
  ]) {
    assert.equal(evaluatePreToolUse(payload), null, JSON.stringify(payload));
  }
});

test("the shared refs of standing approvals are never rewritten by hand", () => {
  for (const command of [
    "git push origin :refs/agentic-sdlc/standing/SA-X/abc/revoked",
    "git update-ref -d refs/agentic-sdlc-shared/standing/SA-X/abc/slots/0001",
    "git push --mirror origin",
    "git push --prune origin 'refs/*:refs/*'",
    "git push origin \":refs/agentic\"\"-sdlc/standing/SA-X/abc/revoked\"",
    "git -C . update-ref -d refs/agentic-sdlc-shared/standing/SA-X/abc/revoked",
    "git fetch --prune origin 'refs/agentic-sdlc/standing/*:refs/agentic-sdlc-shared/standing/*'",
    "git fetch origin '+refs/agentic-sdlc/standing/*:refs/agentic-sdlc-shared/standing/*'",
  ]) {
    assert.equal(evaluatePreToolUse(shell(command))?.decision, "deny", command);
  }
  for (const command of [
    "git fetch origin 'refs/agentic-sdlc/standing/*:refs/agentic-sdlc-shared/standing/*'",
    "git ls-remote origin 'refs/agentic-sdlc/*'",
    "git push origin feature/x",
    "git log -1 refs/agentic-sdlc-shared/standing/SA-tag-cleanup/abc/slots/0001",
    "git for-each-ref refs/agentic-sdlc-shared/ && git branch -a",
  ]) {
    assert.equal(evaluatePreToolUse(shell(command)), null, command);
  }
});

test("malformed payloads never block", () => {
  for (const payload of [null, {}, { tool_name: "Bash" }, { tool_name: "Bash", tool_input: "x" }, { tool_name: "Read", tool_input: { file_path: ".sdlc/autonomy/standing/x" } }]) {
    assert.equal(evaluatePreToolUse(payload), null);
  }
});

test("session context names each standing approval and whether it is shared", () => {
  assert.equal(sessionStartContext({ standing_approvals: [] }), "");
  const context = sessionStartContext({
    standing_approvals: [
      { id: "SA-A", status: "active", used: 1, max_deliveries: 3, expires_at: "2026-11-01T00:00:00.000Z", shared_state: { scope: "shared", remote: "origin", checked: true } },
      { id: "SA-B", status: "active", used: 0, max_deliveries: 1, expires_at: "2026-11-01T00:00:00.000Z", shared_state: { scope: "shared", remote: "origin", checked: false } },
      { id: "SA-C", status: "revoked", used: 0, max_deliveries: 1, expires_at: "2026-11-01T00:00:00.000Z", shared_state: { scope: "local" } },
    ],
  });
  assert.match(context, /SA-A: active, 1 of 3 deliveries used.*shared through 'origin'/u);
  assert.match(context, /SA-B: .*unreachable, so it covers nothing right now/u);
  assert.match(context, /SA-C: revoked.*kept on this computer only/u);
  assert.match(context, /Only the user approves a standing approval/u);
});

test("the hook blocks only with exit status 2 and a reason, the signal both hosts honour", () => {
  const run = (event, payload) => spawnSync(process.execPath, [HOOK, event], { input: JSON.stringify(payload), encoding: "utf8" });
  const blocked = run("pre-tool-use", shell("node bin/agentic-sdlc.mjs autonomy standing approve --id SA-X"));
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /Only the user can approve/u);
  assert.equal(blocked.stdout, "");
  const codex = run("pre-tool-use", codexPatch(".sdlc/autonomy/standing/SA-X/approval.json"));
  assert.equal(codex.status, 2);
  const allowed = run("pre-tool-use", shell("npm test"));
  assert.equal(allowed.status, 0);
  assert.equal(`${allowed.stdout}${allowed.stderr}`, "");
  const garbage = spawnSync(process.execPath, [HOOK, "pre-tool-use"], { input: "{not json", encoding: "utf8" });
  assert.equal(garbage.status, 0);
  const quiet = run("session-start", { cwd: ROOT, source: "startup" });
  assert.equal(quiet.status, 0);
});

test("one hooks.json fits both hosts: plain command handlers, a known blocking signal, the shared root variable", () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, "hooks", "hooks.json"), "utf8"));
  assert.deepEqual(Object.keys(hooks).sort(), ["description", "hooks"]);
  assert.deepEqual(Object.keys(hooks.hooks).sort(), ["PreToolUse", "SessionStart"]);
  for (const groups of Object.values(hooks.hooks)) {
    for (const group of groups) {
      assert.deepEqual(Object.keys(group).sort(), ["hooks", "matcher"]);
      for (const handler of group.hooks) {
        assert.deepEqual(Object.keys(handler).sort(), ["command", "timeout", "type"]);
        assert.equal(handler.type, "command");
        assert.match(handler.command, /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/agentic-sdlc-guard\.mjs" (?:pre-tool-use|session-start)$/u);
      }
    }
  }
  // An exact-name alternation selects Codex's apply_patch and both hosts' shell tool.
  assert.match(hooks.hooks.PreToolUse[0].matcher, /^[A-Za-z_|]+$/u);
  for (const tool of ["Bash", "apply_patch", "Write", "Edit"]) {
    assert.ok(hooks.hooks.PreToolUse[0].matcher.split("|").includes(tool), tool);
  }
});

test("clearing the agent session markers or hiding the command does not get past the guard", () => {
  for (const command of [
    "CLAUDECODE= node bin/agentic-sdlc.mjs autonomy standing appr\\ove --id X --actor-type human",
    "env -u CLAUDECODE node bin/agentic-sdlc.mjs autonomy standing $'approve' --id X",
    "A=approve; unset CLAUDECODE; node bin/agentic-sdlc.mjs autonomy standing $A --id X",
    "CLAUDECODE= node bin/agentic-sdl?.mjs autonomy standing approve --id X",
    "export CODEX_THREAD_ID=",
    "env -i PATH=$PATH node bin/agentic-sdlc.mjs status",
  ]) {
    assert.equal(evaluatePreToolUse(shell(command))?.decision, "deny", command);
  }
  assert.equal(evaluatePreToolUse({ tool_name: "PowerShell", tool_input: { command: "$env:CLAUDECODE = ''; node bin/agentic-sdlc.mjs status" } })?.decision, "deny");
  assert.equal(evaluatePreToolUse({ tool_name: "PowerShell", tool_input: { command: "Remove-Item Env:CODEX_THREAD_ID" } })?.decision, "deny");
});

test("only commands that write the records themselves are denied", () => {
  for (const command of [
    "rm -rf .sdlc/autonomy/stand?ng",
    "cd .sdlc && rm -rf autonomy/standing",
    "cat x.json > .sdlc/autonomy/standing/SA-1/approval.json",
    "git clean -fdx",
    "git clean -fd .",
    "git stash -u",
  ]) {
    assert.equal(evaluatePreToolUse(shell(command))?.decision, "deny", command);
  }
  for (const command of [
    "git pull --rebase && git add .sdlc/autonomy/standing && git commit -m 'chore: record'",
    "git checkout -b x && cat .sdlc/autonomy/standing/SA-1/proposal.json",
    "npm test > /tmp/t.log; ls .sdlc/autonomy/standing",
    "git fetch && git merge origin/main && git log -- .sdlc/autonomy/standing",
    "cat .sdlc/autonomy/standing/SA-1/proposal.json > /tmp/p.json",
    "git restore --staged .sdlc",
    "git clean -fd -- src/",
    "git clean -fd -e .sdlc",
    "git stash",
  ]) {
    assert.equal(evaluatePreToolUse(shell(command)), null, command);
  }
  const variable = "R=refs/agentic-sdlc; git push origin :$R/standing/SA-X/abc/revoked";
  assert.equal(evaluatePreToolUse(shell(variable))?.decision, "deny");
});
