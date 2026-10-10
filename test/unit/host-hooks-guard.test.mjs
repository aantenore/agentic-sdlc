import "../helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import {
  editedPaths,
  evaluatePreToolUse,
  mainThreadMode,
  orchestratorEditWarning,
  orchestratorSessionContext,
  strictMainThreadVerdict,
  STORY_LABEL_INSTRUCTION,
  sessionStartContext,
} from "../../lib/host-hooks/guard.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOOK = path.join(ROOT, "hooks", "agentic-sdlc-guard.mjs");
// A stand-in project that uses agentic-sdlc: the hook only acts inside one.
const GOVERNED = fs.mkdtempSync(path.join(os.tmpdir(), "hook-governed-"));
fs.mkdirSync(path.join(GOVERNED, ".sdlc"));
after(() => fs.rmSync(GOVERNED, { recursive: true, force: true }));

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
    // Amending an approved delivery is guarded like approving it: by the CLI's approval rules, not by the hook.
    "node bin/agentic-sdlc.mjs autonomy delivery amend --id AUT-1 --merge-allowed --actor-type human --approval-source explicit-user --summary ok",
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

test("delivery usage records change only through the CLI, so no receipt or ledger can be removed", () => {
  for (const payload of [
    { tool_name: "Write", tool_input: { file_path: "/work/p/.sdlc/autonomy/metering/AUT-1/ledger.json", content: "{}" } },
    { tool_name: "Edit", tool_input: { file_path: ".sdlc\\autonomy\\metering\\AUT-1\\usage\\USAGE-1.json" } },
    codexPatch("src/a.mjs", ".sdlc/autonomy/metering/AUT-1/meters/codeburn/deltas/abc.json"),
    shell("rm .sdlc/autonomy/metering/AUT-1/ledger.json"),
    shell("rm -rf .sdlc/autonomy/metering"),
    shell("echo '{}' > .sdlc/autonomy/metering/AUT-1/usage/USAGE-2.json"),
    shell("cd .sdlc/autonomy && rm metering/AUT-1/ledger.json"),
    shell("git checkout HEAD~1 -- .sdlc/autonomy/metering/AUT-1"),
    { tool_name: "PowerShell", tool_input: { command: "Remove-Item .sdlc\\autonomy\\metering\\AUT-1\\ledger.json" } },
  ]) {
    const decision = evaluatePreToolUse(payload);
    assert.equal(decision?.decision, "deny", JSON.stringify(payload));
    assert.match(decision.reason, /written only by the agentic-sdlc CLI/u);
  }
  assert.match(
    evaluatePreToolUse({ tool_name: "Write", tool_input: { file_path: ".sdlc/autonomy/metering/AUT-1/ledger.json" } }).reason,
    /Delivery usage records are append-only[\s\S]*would hide spent cost/u,
  );
  for (const payload of [
    shell("cat .sdlc/autonomy/metering/AUT-1/ledger.json"),
    shell("node bin/agentic-sdlc.mjs budget usage record --delivery AUT-1 --cost-amount 0.5 --currency USD"),
    shell("git add .sdlc/autonomy/metering && git commit -m 'chore: record delivery usage'"),
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
    // Fetching into the refs the CLI keeps of what it has seen would plant records there.
    "git fetch origin 'refs/agentic-sdlc/standing/*:refs/agentic-sdlc-shared/standing/*'",
  ]) {
    assert.equal(evaluatePreToolUse(shell(command))?.decision, "deny", command);
  }
  for (const command of [
    "git ls-remote origin 'refs/agentic-sdlc/*'",
    "git push origin feature/x",
    "git log -1 refs/agentic-sdlc-shared/standing/SA-tag-cleanup/abc/slots/0001",
    "git for-each-ref refs/agentic-sdlc-shared/ && git branch -a",
  ]) {
    assert.equal(evaluatePreToolUse(shell(command)), null, command);
  }
});

test("the shared refs of story claims are never forged, deleted, or rewritten by hand", () => {
  for (const command of [
    "git push origin :refs/agentic-sdlc/claims/ST-1/000001/claim",
    "git push origin HEAD:refs/agentic-sdlc/claims/ST-1/000002/claim",
    "git push --force origin abc123:refs/agentic-sdlc/claims/ST-1/000001/release",
    "git update-ref refs/agentic-sdlc/claims/ST-1/000001/release HEAD",
    "git update-ref -d refs/agentic-sdlc-shared/claims/ST-1/000001/claim",
    "git fetch origin '+refs/agentic-sdlc/claims/*:refs/agentic-sdlc-shared/claims/*'",
    "git fetch --prune origin 'refs/agentic-sdlc/claims/*:refs/agentic-sdlc-shared/claims/*'",
    "rm -rf .git/refs/agentic-sdlc-shared/claims",
    "git fetch origin 'refs/agentic-sdlc/claims/*:refs/agentic-sdlc-shared/claims/*'",
  ]) {
    const decision = evaluatePreToolUse(shell(command));
    assert.equal(decision?.decision, "deny", command);
  }
  assert.match(evaluatePreToolUse(shell("git push origin :refs/agentic-sdlc/claims/ST-1/000001/claim")).reason, /story claims/u);
  for (const command of [
    "git ls-remote origin 'refs/agentic-sdlc/claims/*'",
    "git for-each-ref refs/agentic-sdlc-shared/claims/",
    "git log -1 --format=%B refs/agentic-sdlc-shared/claims/ST-1/000001/claim",
    "git fetch origin refs/agentic-sdlc/claims/ST-1/000001/claim",
    "node bin/agentic-sdlc.mjs story claim --id ST-1 --agent worker --branch feature/ST-1",
    "node bin/agentic-sdlc.mjs story release --id ST-1 --reason done",
    "node bin/agentic-sdlc.mjs orchestrate status --json",
  ]) {
    assert.equal(evaluatePreToolUse(shell(command)), null, command);
  }
});

test("the proof of this worktree's own claims cannot be planted, forged, or batch-written", () => {
  for (const command of [
    "git fetch origin refs/agentic-sdlc/claims/ST-1/000001/claim:refs/agentic-sdlc-local/claims/0123456789abcdef/ST-1/000001",
    "git fetch origin refs/agentic-sdlc/claims/ST-1/000001/claim:refs/worktree/agentic-sdlc/claims/0123456789abcdef/ST-1/000001",
    "git update-ref refs/worktree/agentic-sdlc/claims/0123456789abcdef/ST-1/000001 HEAD",
    "git update-ref -d refs/worktree/agentic-sdlc/claims/0123456789abcdef/ST-1/000001",
    "printf 'create refs/worktree/agentic-sdlc/claims/x/ST-1/000001 abc' | git update-ref --stdin",
    "cat batch.txt | git update-ref --stdin",
    "git update-ref --stdin < /tmp/batch.txt",
    "git clone --mirror https://example.invalid/r.git --config 'remote.origin.fetch=refs/agentic-sdlc/*:refs/agentic-sdlc-shared/*'",
    "rm -rf .git/worktrees/second/refs/worktree/agentic-sdlc",
    "rm -rf .git/refs/worktree/agentic-sdlc/claims",
    "rm -rf .git/refs/agentic-sdlc",
  ]) {
    assert.equal(evaluatePreToolUse(shell(command))?.decision, "deny", command);
  }
  for (const command of [
    "git for-each-ref refs/worktree/agentic-sdlc/",
    "git fetch origin refs/agentic-sdlc/claims/ST-1/000001/claim",
    "git clone --mirror https://example.invalid/r.git /tmp/mirror",
    "git update-ref refs/heads/topic HEAD",
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
      { id: "SA-D", status: "active", used: 0, max_deliveries: 2, expires_at: "2026-11-01T00:00:00.000Z", shared_state: { scope: "local" }, assurance: "host_verified" },
    ],
  });
  assert.match(context, /SA-A: active, 1 of 3 deliveries used.*shared through 'origin'\.$/mu);
  assert.match(context, /SA-D: active.*kept on this computer only; approval signed by the trusted host\./u);
  assert.match(context, /SA-B: .*unreachable, so it covers nothing right now/u);
  assert.match(context, /SA-C: revoked.*kept on this computer only/u);
  assert.match(context, /Only the user approves a standing approval/u);
});

test("the hook blocks only with exit status 2 and a reason, the signal both hosts honour", () => {
  const run = (event, payload) => spawnSync(process.execPath, [HOOK, event], { input: JSON.stringify({ cwd: GOVERNED, ...payload }), encoding: "utf8" });
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

test("the hook never acts in a project that does not use agentic-sdlc", () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "hook-plain-"));
  try {
    for (const command of ["git clean -fdx", "git stash -u", "export CLAUDECODE=", "node bin/agentic-sdlc.mjs autonomy standing approve --id X"]) {
      const result = spawnSync(process.execPath, [HOOK, "pre-tool-use"], {
        input: JSON.stringify({ cwd: plain, tool_name: "Bash", tool_input: { command } }),
        encoding: "utf8",
      });
      assert.equal(result.status, 0, command);
      assert.equal(result.stderr, "", command);
    }
  } finally {
    fs.rmSync(plain, { recursive: true, force: true });
  }
  const governed = spawnSync(process.execPath, [HOOK, "pre-tool-use"], {
    input: JSON.stringify({ cwd: path.join(GOVERNED, "sub", "dir"), tool_name: "Bash", tool_input: { command: "git clean -fdx" } }),
    encoding: "utf8",
  });
  assert.equal(governed.status, 2, "a subfolder of a governed project is still guarded");
});

test("one hooks.json fits both hosts: plain command handlers, a known blocking signal, the shared root variable", () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, "hooks", "hooks.json"), "utf8"));
  assert.deepEqual(Object.keys(hooks).sort(), ["description", "hooks"]);
  assert.deepEqual(Object.keys(hooks.hooks).sort(), ["PostToolUse", "PreToolUse", "SessionEnd", "SessionStart", "Stop", "UserPromptSubmit"]);
  for (const groups of Object.values(hooks.hooks)) {
    for (const group of groups) {
      assert.deepEqual(Object.keys(group).sort(), ["hooks", "matcher"]);
      for (const handler of group.hooks) {
        assert.deepEqual(Object.keys(handler).sort(), ["command", "timeout", "type"]);
        assert.equal(handler.type, "command");
        assert.match(handler.command, /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/agentic-sdlc-guard\.mjs" (?:pre-tool-use|session-start|post-tool-use|user-prompt-submit|stop|session-end)$/u);
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

test("interpreters, brace globs, and git's own ref storage do not get past the guard", () => {
  for (const command of [
    "node -e \"delete process.env.CLAUDECODE; import('./bin/agentic-sdlc.mjs')\" autonomy standing approve --id X",
    "python3 -c \"import os,subprocess; os.environ.pop('CLAUDECODE'); subprocess.run(['node','bin/agentic-sdlc.mjs'])\"",
    "rm -rf .git/refs/agentic-sdlc-local",
    "rm -f .sdlc/autonomy/s{t,}anding/SA-1/revocation.json",
    "rm -rf .sdlc/auto*/standing",
    "git clean -fd -- :/",
    "git clean -fd -- ./.sdlc",
  ]) {
    assert.equal(evaluatePreToolUse(shell(command))?.decision, "deny", command);
  }
  for (const command of [
    "git clean -n",
    "git clean -ndx",
    "git clean -fd src/",
    "git clean -fdX",
    "git stash show -u",
    "grep -rn 'CLAUDECODE=' lib",
    "env -i PATH=/usr/bin node --version",
    "node -e \"console.log(require('./.sdlc/autonomy/standing/SA-1/proposal.json').id)\"",
    "git push origin HEAD:$BRANCH && git ls-remote origin 'refs/agentic-sdlc/*'",
  ]) {
    assert.equal(evaluatePreToolUse(shell(command)), null, command);
  }
});

test("only a person supersedes a recorded evidence file", () => {
  const verdict = evaluatePreToolUse(shell("node bin/agentic-sdlc.mjs autonomy delivery evidence supersede --id AUT-1 --receipt AUT-ACT-1 --path a.txt"));
  assert.equal(verdict?.decision, "deny");
  assert.match(verdict.reason, /ask the user to run this exact command themselves/u);
});

test("only a person abandons a story, and a message that mentions it is not blocked", () => {
  const verdict = evaluatePreToolUse(shell("node bin/agentic-sdlc.mjs story abandon --id ST-DEMO-001 --reason x --actor-type human"));
  assert.equal(verdict?.decision, "deny");
  assert.match(verdict.reason, /ask the user to run this exact command themselves/u);
  assert.equal(evaluatePreToolUse(shell("git commit -m \"docs: story abandon per ST-DEMO-001\"")), null);
});

test("only a person acknowledges a merge made outside the plugin", () => {
  for (const command of [
    "node bin/agentic-sdlc.mjs autonomy delivery reconcile --id AUT-1 --pr-url https://github.com/o/r/pull/1 --actor-type human",
    "npx agentic-sdlc autonomy delivery \"reconcile\" --id AUT-1",
  ]) {
    const verdict = evaluatePreToolUse(shell(command));
    assert.equal(verdict?.decision, "deny", command);
    assert.match(verdict.reason, /ask the user to run this exact command themselves/u);
  }
  assert.equal(evaluatePreToolUse(shell("cat .sdlc/autonomy/executions/AUT-1/external-merge.json")), null);
  assert.equal(evaluatePreToolUse(shell("rm .sdlc/autonomy/executions/AUT-1/external-merge.json"))?.decision, "deny");
  assert.equal(evaluatePreToolUse({
    tool_name: "Write",
    tool_input: { file_path: ".sdlc/autonomy/executions/AUT-1/external-merge.json", content: "{}" },
  })?.decision, "deny");
  assert.equal(evaluatePreToolUse(shell("node bin/agentic-sdlc.mjs autonomy delivery status --id AUT-1")), null);
});

test("only a person archives a project, and archived records are never changed by hand", () => {
  for (const command of [
    "node bin/agentic-sdlc.mjs project archive --apply --plan-hash abc --reason x --actor-type human",
    "npx agentic-sdlc project \"archive\" --reinit --apply",
  ]) {
    const verdict = evaluatePreToolUse(shell(command));
    assert.equal(verdict?.decision, "deny", command);
    assert.match(verdict.reason, /ask them to run this exact command themselves/u);
  }
  // The plan is read-only and stays open to agents.
  assert.equal(evaluatePreToolUse(shell("node bin/agentic-sdlc.mjs project archive --json")), null);
  assert.equal(evaluatePreToolUse(shell("cat .sdlc-archive/ARCHIVE-1/archive-manifest.json")), null);
  assert.equal(evaluatePreToolUse(shell("ls .sdlc-archive")), null);
  for (const command of [
    "rm -rf .sdlc-archive",
    "mv .sdlc-archive/ARCHIVE-1 /tmp/x",
    "echo {} > .sdlc-archive/ARCHIVE-1/archive-manifest.json",
  ]) {
    assert.equal(evaluatePreToolUse(shell(command))?.decision, "deny", command);
  }
  assert.equal(evaluatePreToolUse({
    tool_name: "Write",
    tool_input: { file_path: "/work/p/.sdlc-archive/ARCHIVE-1/archive-manifest.json", content: "{}" },
  })?.decision, "deny");
  // The raw shell still cannot do what the command does.
  assert.equal(evaluatePreToolUse(shell("mv .sdlc .sdlc-archive/x"))?.decision, "deny");
  assert.equal(evaluatePreToolUse(shell("rm -rf .sdlc"))?.decision, "deny");
});

test("a message that only mentions a person-only command is allowed", () => {
  const text = "ho preparato: agentic-sdlc autonomy delivery evidence supersede --id X; poi agentic-sdlc autonomy standing approve";
  assert.equal(evaluatePreToolUse(shell(`node /p/bin/agentic-sdlc.mjs message send --to a --text "${text}"`)), null);
  assert.equal(evaluatePreToolUse(shell(`agentic-sdlc message send --text '${text}'`)), null);
});

test("person-only commands stay blocked when really invoked", () => {
  const supersede = "autonomy delivery evidence supersede --id AUT-1 --receipt R --path a.txt";
  for (const command of [
    `node /p/bin/agentic-sdlc.mjs ${supersede}`,
    `FOO=1 npx agentic-sdlc ${supersede}`,
    `echo ok && agentic-sdlc ${supersede}`,
    `agentic-sdlc autonomy "standing" approve --id S1`,
    `agentic-sdlc project archive --apply`,
  ]) assert.equal(evaluatePreToolUse(shell(command))?.decision, "deny", command);
  assert.equal(evaluatePreToolUse(shell("agentic-sdlc project archive")), null);
});

test("person-only commands stay blocked inside sh -c", () => {
  const inner = "node bin/agentic-sdlc.mjs autonomy delivery reconcile --id AUT-1";
  assert.equal(evaluatePreToolUse(shell(`sh -c "${inner}"`))?.decision, "deny");
  assert.equal(evaluatePreToolUse(shell(`bash -lc '${inner}'`))?.decision, "deny");
  assert.equal(evaluatePreToolUse(shell(`agentic-sdlc message send --text "$(${inner})"`))?.decision, "deny");
});

test("a merge outside the governed action is blocked unless an open authorization covers it", () => {
  const authorized = (number) => (attempt) => attempt.number === number;
  const env = {};
  const check = (command, isMergeAuthorized = () => false, extra = env) => evaluatePreToolUse(shell(command), { env: extra, isMergeAuthorized });
  for (const command of [
    "gh pr merge 12 --merge",
    "gh pr merge https://github.com/o/r/pull/12 --squash",
    "cd x && gh pr merge --merge",
    "bash -c 'gh pr merge 12'",
    "GH_TOKEN=x gh -R o/r pr merge 12",
    "gh api -X PUT repos/o/r/pulls/12/merge",
    "git push origin main",
    "git push origin HEAD:refs/heads/master",
  ]) {
    const verdict = check(command);
    assert.equal(verdict?.decision, "deny", command);
    assert.match(verdict.reason, /autonomy delivery action --action pull_request\.merge/u);
    assert.match(verdict.reason, /AGENTIC_SDLC_ALLOW_UNGOVERNED_MERGE=1/u);
  }
  assert.equal(check("gh pr merge 12 --merge", authorized(12)), null);
  assert.equal(check("gh pr merge https://github.com/o/r/pull/12", authorized(12)), null);
  assert.equal(check("gh pr merge 13", authorized(12))?.decision, "deny");
  assert.equal(check("gh pr merge 12", () => false, { AGENTIC_SDLC_ALLOW_UNGOVERNED_MERGE: "1" }), null);
  // An inline assignment in the command is not the person's environment.
  assert.equal(check("AGENTIC_SDLC_ALLOW_UNGOVERNED_MERGE=1 gh pr merge 12")?.decision, "deny");
});

test("mentions of a merge and ordinary pushes stay allowed", () => {
  const deniedAll = () => false;
  for (const command of [
    "git commit -m 'run gh pr merge 12 later'",
    "echo gh pr merge 12",
    "gh pr view 12",
    "gh api repos/o/r/pulls/12/merge",
    "git push origin feature/x",
    "git push -u origin HEAD:feature/x",
    "git push origin --delete main",
  ]) {
    assert.equal(evaluatePreToolUse(shell(command), { env: {}, isMergeAuthorized: deniedAll }), null, command);
  }
  // Without the checker (library use) nothing is added to the existing rules.
  assert.equal(evaluatePreToolUse(shell("gh pr merge 12")), null);
});

test("the hook reads open pull_request.merge receipts of the project and its worktrees", async () => {
  const { mergeAuthorized } = await import("../../lib/host-hooks/merge-authorization.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hook-merge-"));
  try {
    const actions = path.join(root, ".sdlc", "autonomy", "actions");
    fs.mkdirSync(actions, { recursive: true });
    const receipt = (id, extra) => fs.writeFileSync(path.join(actions, `${id}.json`), JSON.stringify({ kind: "delivery_action_receipt", id, ...extra }));
    const merge = { action: "pull_request.merge", action_details: { head_branch: "feat/a", merge: { pr_url: "https://github.com/o/r/pull/7" } } };
    receipt("A1", { ...merge, status: "authorized" });
    assert.equal(mergeAuthorized(root, root, { number: 7, branch: null }), true);
    assert.equal(mergeAuthorized(root, root, { number: null, branch: "feat/a" }), true);
    assert.equal(mergeAuthorized(root, root, { number: 8, branch: null }), false);
    receipt("A2", { action: "pull_request.merge", status: "completed", authorization_receipt_ref: { id: "A1" } });
    assert.equal(mergeAuthorized(root, root, { number: 7, branch: null }), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a push to a claimed story branch needs an open git.push authorization", async () => {
  const { storyPushAuthorized } = await import("../../lib/host-hooks/merge-authorization.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hook-push-"));
  try {
    const sdlc = path.join(root, ".sdlc");
    fs.mkdirSync(path.join(sdlc, "stories", "ST-1"), { recursive: true });
    fs.mkdirSync(path.join(sdlc, "autonomy", "actions"), { recursive: true });
    fs.writeFileSync(path.join(sdlc, "stories", "ST-1", "claim.json"), JSON.stringify({ story_id: "ST-1", status: "active", branch: "feature/ST-1" }));
    const receipt = (id, extra) => fs.writeFileSync(path.join(sdlc, "autonomy", "actions", `${id}.json`), JSON.stringify({ kind: "delivery_action_receipt", id, ...extra }));
    const check = (branches) => storyPushAuthorized(root, root, { branches });
    assert.equal(check(["feature/ST-1"]), false);
    assert.equal(check(["codex/ST-1"]), false);
    assert.equal(check(["feature/other"]), true);
    assert.equal(check(["main"]), true);
    receipt("P1", { action: "git.push", status: "authorized", action_details: { head_branch: "feature/ST-1" } });
    assert.equal(check(["feature/ST-1"]), true);
    assert.equal(check(["codex/ST-1"]), false);
    receipt("P2", { action: "git.push", status: "completed", authorization_receipt_ref: { id: "P1" } });
    assert.equal(check(["feature/ST-1"]), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the hook blocks story pushes without authorization and leaves other pushes alone", () => {
  const options = (storyBranches, env = {}) => ({ env, isStoryPushAuthorized: (attempt) => !attempt.branches.some((branch) => storyBranches.includes(branch)) });
  for (const command of ["git push origin feature/ST-1", "git push -u origin HEAD:feature/ST-1", "cd x && git push origin feature/ST-1", "bash -c 'git push origin feature/ST-1'", "git push -f origin +feature/ST-1"]) {
    const verdict = evaluatePreToolUse(shell(command), options(["feature/ST-1"]));
    assert.equal(verdict?.decision, "deny", command);
    assert.match(verdict.reason, /autonomy delivery action --action git\.push/u);
    assert.match(verdict.reason, /AGENTIC_SDLC_ALLOW_UNGOVERNED_GIT=1/u);
  }
  assert.equal(evaluatePreToolUse(shell("git push origin feature/ST-1"), options([])), null);
  assert.equal(evaluatePreToolUse(shell("git push origin feature/other"), options(["feature/ST-1"])), null);
  assert.equal(evaluatePreToolUse(shell("echo git push origin feature/ST-1"), options(["feature/ST-1"])), null);
  assert.equal(evaluatePreToolUse(shell("git push origin feature/ST-1"), options(["feature/ST-1"], { AGENTIC_SDLC_ALLOW_UNGOVERNED_GIT: "1" })), null);
});

test("the hook blocks hand-written git internal files", () => {
  for (const command of [
    "git rev-parse HEAD > .git/MERGE_HEAD",
    "echo msg > .git/MERGE_MSG",
    "printf 'x' >> \".git/MERGE_MSG\"",
    "echo abc | tee .git/MERGE_HEAD",
    "cp /tmp/x .git/HEAD",
    "bash -c 'echo ref: refs/heads/x > .git/HEAD'",
    "echo abc > .git/refs/heads/feature/x",
    "echo abc > .git/worktrees/w/MERGE_HEAD",
  ]) {
    const verdict = evaluatePreToolUse(shell(command), { env: {} });
    assert.equal(verdict?.decision, "deny", command);
    assert.match(verdict.reason, /AGENTIC_SDLC_ALLOW_UNGOVERNED_GIT=1/u);
  }
  for (const command of ["cat .git/MERGE_HEAD", "echo .git/MERGE_HEAD", "git commit -m 'do not write > .git/MERGE_MSG'", "git merge --abort", "echo x > notes.txt"]) {
    assert.equal(evaluatePreToolUse(shell(command), { env: {} }), null, command);
  }
  assert.equal(evaluatePreToolUse(shell("echo m > .git/MERGE_MSG"), { env: { AGENTIC_SDLC_ALLOW_UNGOVERNED_GIT: "1" } }), null);
});

test("host_policy.main_thread is free unless the project sets orchestrator", () => {
  assert.equal(mainThreadMode(undefined), "free");
  assert.equal(mainThreadMode({}), "free");
  assert.equal(mainThreadMode({ host_policy: {} }), "free");
  assert.equal(mainThreadMode({ host_policy: { main_thread: "other" } }), "free");
  assert.equal(mainThreadMode({ host_policy: { main_thread: "free" } }), "free");
  assert.equal(mainThreadMode({ host_policy: { main_thread: "orchestrator" } }), "orchestrator");
});

test("the orchestrator instruction appears only in orchestrator mode", () => {
  assert.equal(orchestratorSessionContext("free"), "");
  const context = orchestratorSessionContext("orchestrator");
  assert.match(context, /only coordinates/u);
  assert.match(context, /background subagents/u);
  assert.match(context, /read-only command is fine inline/u);
  assert.match(context, /controlled background processes/u);
  assert.match(context, /explicit deadline/u);
  assert.match(context, /no process is left running/u);
  assert.match(context, /must never block/u);
  assert.match(context, /more than about 10 seconds/u);
  assert.match(context, /run_in_background/u);
});

test("the orchestrator guard warns on a main-thread edit and leaves subagents and other tools alone", () => {
  const edit = (extra = {}) => ({ tool_name: "Edit", tool_input: { file_path: "src/a.js" }, ...extra });
  assert.match(orchestratorEditWarning(edit(), "orchestrator"), /main thread/u);
  for (const tool_name of ["Write", "NotebookEdit"]) {
    assert.notEqual(orchestratorEditWarning({ tool_name, tool_input: {} }, "orchestrator"), "");
  }
  assert.equal(orchestratorEditWarning(edit({ agent_id: "agent-1", agent_type: "worker" }), "orchestrator"), "");
  assert.equal(orchestratorEditWarning(edit(), "free"), "");
  assert.equal(orchestratorEditWarning(shell("ls"), "orchestrator"), "");
  assert.equal(evaluatePreToolUse(edit()), null);
});

test("the hook adds the orchestrator context and warning without blocking", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "hook-orchestrator-"));
  try {
    fs.mkdirSync(path.join(project, ".sdlc"));
    const run = (event, payload) => spawnSync(process.execPath, [HOOK, event], { input: JSON.stringify({ cwd: project, ...payload }), encoding: "utf8" });
    const edit = { tool_name: "Edit", tool_input: { file_path: path.join(project, "a.js") } };
    assert.equal(run("session-start", {}).stdout.trim(), STORY_LABEL_INSTRUCTION);
    assert.equal(run("pre-tool-use", edit).stdout, "");
    fs.writeFileSync(path.join(project, ".sdlc", "config.json"), JSON.stringify({ host_policy: { main_thread: "orchestrator" } }));
    assert.match(run("session-start", {}).stdout, /only coordinates/u);
    const main = run("pre-tool-use", edit);
    assert.equal(main.status, 0);
    assert.match(JSON.parse(main.stdout).hookSpecificOutput.additionalContext, /main thread/u);
    assert.equal(run("pre-tool-use", { ...edit, agent_id: "agent-1" }).stdout, "");
    assert.equal(run("pre-tool-use", shell("ls")).stdout, "");
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("a repository listed in AGENTIC_SDLC_UNGOVERNED_REPOS is left out of the merge and push guard", async () => {
  const { isUngovernedRepo, ungovernedRepos } = await import("../../lib/host-hooks/merge-authorization.mjs");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "hook-optout-"));
  try {
    const free = path.join(base, "free");
    const other = path.join(base, "other");
    for (const dir of [free, other]) {
      fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
      assert.equal(spawnSync("git", ["init", "-q"], { cwd: dir }).status, 0);
    }
    const env = { AGENTIC_SDLC_UNGOVERNED_REPOS: [free, "relative/ignored"].join(path.delimiter) };
    assert.equal(ungovernedRepos(env).length, 1);
    assert.equal(isUngovernedRepo(free, [], env), true);
    assert.equal(isUngovernedRepo(path.join(free, "sub"), [], env), true);
    assert.equal(isUngovernedRepo(other, [], env), false);
    assert.equal(isUngovernedRepo(free, [], {}), false);
    // git -C decides the repository, absolute or relative to the working directory.
    assert.equal(isUngovernedRepo(other, [free], env), true);
    assert.equal(isUngovernedRepo(free, [other], env), false);
    assert.equal(isUngovernedRepo(free, ["../other"], env), false);
    assert.equal(isUngovernedRepo(other, ["../free"], env), true);

    const options = (cwd) => ({
      env: {},
      isMergeAuthorized: () => false,
      isStoryPushAuthorized: () => false,
      isUngovernedRepo: (attempt) => isUngovernedRepo(cwd, attempt.dirs, env),
    });
    for (const command of ["git push origin main", "git push", "git push origin feature/x", "gh pr merge 12"]) {
      assert.equal(evaluatePreToolUse(shell(command), options(free)), null, command);
      assert.equal(evaluatePreToolUse(shell(command), options(other))?.decision, "deny", command);
    }
    assert.equal(evaluatePreToolUse(shell(`git -C ${free} push origin main`), options(other)), null);
    assert.equal(evaluatePreToolUse(shell(`git -C ${other} push origin main`), options(free))?.decision, "deny");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("strict main-thread mode: env wins over the project and the session context says it is enforced", () => {
  assert.equal(mainThreadMode({ host_policy: { main_thread: "free" } }, { AGENTIC_SDLC_MAIN_THREAD: "strict" }), "strict");
  assert.equal(mainThreadMode({ host_policy: { main_thread: "strict" } }, { AGENTIC_SDLC_MAIN_THREAD: "bogus" }), "strict");
  assert.equal(mainThreadMode({}, {}), "free");
  assert.match(orchestratorSessionContext("strict"), /enforced/u);
});

test("strict main-thread mode denies main edits and unlisted foreground shell, never subagents", () => {
  const edit = (extra = {}) => ({ tool_name: "Edit", tool_input: { file_path: "src/a.js" }, ...extra });
  const verdict = (payload, env = {}) => strictMainThreadVerdict(payload, "strict", env);
  const denied = verdict(edit());
  assert.equal(denied?.decision, "deny");
  assert.match(denied.reason, /delega a un subagent \(Agent tool\) o lancia il comando in background/u);
  assert.equal(verdict({ tool_name: "Write", tool_input: {} })?.decision, "deny");
  assert.equal(verdict({ tool_name: "NotebookEdit", tool_input: {} })?.decision, "deny");
  assert.equal(verdict(edit({ agent_id: "a1" })), null);
  assert.equal(verdict({ ...shell("npm test"), agent_id: "a1" }), null);
  for (const tool_name of ["Agent", "Task", "Read", "Grep", "Glob", "SendMessage"]) assert.equal(verdict({ tool_name, tool_input: {} }), null);
  assert.equal(strictMainThreadVerdict(edit(), "orchestrator"), null);
  assert.equal(verdict(shell("npm test"))?.decision, "deny");
  assert.equal(verdict({ tool_name: "Bash", tool_input: { command: "npm test", run_in_background: true } }), null);
  for (const command of ["git status | head", "git status && git log --oneline | head -5", "grep 'a|b' f 2>/dev/null", "ls > /dev/null", "gh pr view 3", "claude plugin list", "agentic-sdlc message read --text"]) {
    assert.equal(verdict(shell(command)), null, command);
  }
  for (const command of ["git status && npm test", "echo x > out.txt", "cat a >> b", "ls & npm test", "echo $(npm test)", "find . -delete", "git branch -D x"]) {
    assert.equal(verdict(shell(command))?.decision, "deny", command);
  }
});

test("strict main-thread mode honours the custom allowlist", () => {
  const env = { AGENTIC_SDLC_MAIN_THREAD_ALLOW: "npm test\n^make lint;;^tsc --noEmit" };
  for (const command of ["npm test", "make lint", "tsc --noEmit", "git status && npm test"]) {
    assert.equal(strictMainThreadVerdict(shell(command), "strict", env), null, command);
  }
  assert.equal(strictMainThreadVerdict(shell("npm run build"), "strict", env)?.decision, "deny");
  assert.equal(strictMainThreadVerdict(shell("npm test > out.txt"), "strict", env)?.decision, "deny");
});

test("strict main-thread mode denies edits inside the project and worktrees, allows them outside", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "strict-root-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "strict-out-"));
  try {
    const roots = [root];
    const edit = (file_path) => ({ tool_name: "Write", cwd: root, tool_input: { file_path } });
    const verdict = (payload) => strictMainThreadVerdict(payload, "strict", { HOME: outside }, { roots });
    assert.equal(verdict(edit(path.join(root, "src", "a.js")))?.decision, "deny");
    assert.equal(verdict(edit("src/a.js"))?.decision, "deny");
    assert.equal(verdict(edit(path.join(outside, "scratch.txt"))), null);
    assert.equal(verdict(edit(path.join(outside, ".claude", "projects", "p", "memory", "m.md"))), null);
    assert.equal(strictMainThreadVerdict(edit(path.join(outside, "x")), "strict", {})?.decision, "deny");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
