import "../helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { alertFor, rememberOwnMessage } from "../../lib/messaging/auto.mjs";
import { pendingQuestions } from "../../lib/host-hooks/keep-going.mjs";
import { installFakeGh } from "../helpers/fake-gh.mjs";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../bin/agentic-sdlc.mjs");
const CONFIG = { provider: "github", repo: "acme/shop", issue: 1 };

// A fake gh on PATH serving an in-file GitHub with the channel issue #1; no test reaches the real one.
function fakeGh() {
  return installFakeGh(fs.mkdtempSync(path.join(os.tmpdir(), "agentic-gh-")), {
    issues: [{ number: 1, title: "Agentic SDLC · canale tra computer", state: "open", labels: [{ name: "agentic-sdlc-channel" }] }],
    nextIssue: 2,
    start: Date.now(),
  });
}

function runCli(args, root, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args, "--root", root], {
      env: { ...process.env, AGENTIC_SDLC_HOST_LABEL: "PC1", AGENTIC_SDLC_MESSAGING_JOIN: "off", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function project(configured) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-auto-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  fs.mkdirSync(path.join(root, ".git/agentic-sdlc"));
  if (configured) {
    fs.writeFileSync(path.join(root, ".git/agentic-sdlc/messaging.json"), JSON.stringify(CONFIG));
  }
  const init = await runCli(["init"], root);
  assert.equal(init.code, 0, init.stderr);
  return root;
}

test("alerts name the story and the reason, and ignore ordinary runs", () => {
  const gate = alertFor("gate.check", { story: "st-a-001" }, { exitCode: 1, blockers: ["x needs y"] });
  assert.equal(gate.kind, "question");
  assert.match(gate.text, /^need help: gate check failed for ST-A-001: x needs y; reply with --kind answer --reply-to <id>$/u);
  assert.equal(alertFor("gate.check", { story: "ST-A-001" }, { exitCode: 0 }), null);
  assert.match(alertFor("story.park", { id: "ST-A-001", reason: "waiting for the API" }).text, /parked: waiting for the API/u);
  assert.match(alertFor("story.wait", { id: "ST-A-001", on: "dep:ST-B-002" }).text, /waiting on dep:ST-B-002/u);
  assert.equal(alertFor("story.wait", { id: "ST-A-001", clear: true }), null);
  assert.match(alertFor("story.wait", { id: "ST-A-001", on: "dep:ST-B-002" }).text, /blocked by ST-B-002/u);
  assert.match(alertFor("story.claim", { id: "ST-A-001" }).text, /ST-A-001 claimed/u);
  const released = alertFor("story.release", { id: "ST-A-001" });
  assert.equal(released.kind, "offer");
  assert.match(released.next, /story availability/u);
  const doneRelease = alertFor("story.release", { id: "ST-A-001" }, { extra: { story: "ST-A-001", unblocked: [], completed: true } });
  assert.notEqual(doneRelease.kind, "offer");
  assert.match(doneRelease.text, /ST-A-001 released: completed/u);
  assert.doesNotMatch(doneRelease.text, /free to take/u);
  const merged = alertFor("autonomy.delivery.action", { id: "AUT-1", action: "pull_request.merge", outcome: "passed" }, { extra: { story: "ST-A-001", unblocked: ["ST-C-003"] } });
  assert.match(merged.text, /merged for ST-A-001\. Now unblocked: ST-C-003/u);
  assert.match(merged.next, /task start --story ST-C-003/u);
  assert.equal(alertFor("autonomy.delivery.action", { id: "AUT-1", action: "git.push", outcome: "passed" }).text, "git push done.");
  assert.match(alertFor("story.publish-records", { id: "ST-A-001" }, { extra: { unblocked: [] } }).text, /records of ST-A-001 published/u);
  assert.match(alertFor("gate.check", { story: "ST-A-001", "lifecycle-complete": true }, { exitCode: 0 }).text, /certified/u);
  assert.match(alertFor("baseline.refresh", {}, { exitCode: 0 }).text, /baseline refreshed/u);
  const timeout = Object.assign(new Error("git fetch origin did not finish within 20s: the remote may be slow"), { code: "ETIMEDOUT" });
  assert.equal(alertFor("status", {}, { error: timeout }).kind, "question");
  assert.match(alertFor("status", {}, { error: timeout }).text, /status stopped on a time limit \(git fetch origin did not finish within 20s\)/u);
  assert.equal(alertFor("status", {}, { error: new Error("other") }), null);
});

test("a failing gate tells the other computers once, and claims show new messages once", async () => {
  const gh = fakeGh();
  const root = await project(true);
  const env = gh.env;
  const gate = await runCli(["gate", "check", "--scope", "all", "--strict"], root, env);
  assert.equal(gate.code, 1);
  assert.equal(gh.read().comments.length, 1);
  const [comment] = gh.read().comments;
  assert.match(comment.body, /^\*\*PC1\*\* · question\n\n\[auto\] need help: gate check failed: .*; reply with --kind answer --reply-to <id>\n\n<!-- agentic-sdlc:/u);
  assert.equal((await runCli(["gate", "check", "--scope", "all", "--strict"], root, env)).code, 1);
  assert.equal(gh.read().comments.length, 1, "the same alert is not repeated");

  gh.write((state) => {
    const at = new Date(Date.now() + 5000).toISOString().replace(/\.\d{3}Z$/u, "Z");
    state.comments.push({ id: 4999999990, issue: 1, body: "**PC2**\n\nST-B-002 is mine\n\n<!-- agentic-sdlc:{\"v\":1,\"from\":\"PC2\",\"kind\":\"info\"} -->", created_at: at, updated_at: at, user: { login: "antonio" } });
  });
  const claim = await runCli(["story", "claim", "--id", "ST-NOPE-001", "--agent", "a1"], root, env);
  assert.match(claim.stderr, /PC2 \(antonio\): ST-B-002 is mine/u);
  assert.doesNotMatch(claim.stderr, /PC1/u, "own messages are not shown");
  const again = await runCli(["story", "claim", "--id", "ST-NOPE-001", "--agent", "a1"], root, env);
  assert.doesNotMatch(again.stderr, /ST-B-002 is mine/u);
});

test("without a channel or with GitHub unreachable nothing changes", async () => {
  const quiet = await project(false);
  const off = await runCli(["gate", "check", "--scope", "all", "--strict"], quiet);
  assert.equal(off.code, 1);
  assert.doesNotMatch(off.stderr, /automatic message|told the other/u);
  const down = await project(true);
  const gh = fakeGh();
  gh.write((state) => { state.noAuth = true; });
  const started = Date.now();
  const result = await runCli(["gate", "check", "--scope", "all", "--strict"], down, gh.env);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /automatic message not sent/u);
  assert.ok(Date.now() - started < 10_000);
});

test("a reply sent here counts as answered before the next poll", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-auto-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  fs.mkdirSync(path.join(root, ".git/agentic-sdlc"));
  fs.writeFileSync(path.join(root, ".git/agentic-sdlc/messaging.json"), JSON.stringify(CONFIG));
  const statePath = path.join(root, ".git/agentic-sdlc/messaging-auto.json");
  const question = { id: "Q1", from: "PC2", kind: "question", text: "help?", time: new Date().toISOString() };
  fs.writeFileSync(statePath, JSON.stringify({ own: [], attention: { window: [question] } }));
  assert.equal(pendingQuestions(JSON.parse(fs.readFileSync(statePath, "utf8")), "PC1").length, 1);
  rememberOwnMessage(root, "A1", {}, { from: "PC3", kind: "answer", reply_to: "Q1", text: "done", time: new Date().toISOString() });
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.deepEqual(state.own, ["A1"]);
  assert.deepEqual(pendingQuestions(state, "PC1"), []);
});
