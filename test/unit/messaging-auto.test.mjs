import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { alertFor, rememberOwnMessage } from "../../lib/messaging/auto.mjs";
import { pendingQuestions } from "../../lib/host-hooks/keep-going.mjs";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../bin/agentic-sdlc.mjs");
const TOPIC = "sdlc-auto-test-0123456789abcdef";

// A minimal ntfy: JSON publish on "/", NDJSON poll on "/<topic>/json" honouring since=<id>.
async function fakeNtfy() {
  const messages = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (request.method === "POST" && url.pathname === "/") {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const event = { id: `msg${String(messages.length + 1).padStart(9, "0")}`, time: 1760000000 + messages.length, event: "message", ...JSON.parse(body) };
        messages.push(event);
        response.end(JSON.stringify(event));
      });
      return;
    }
    if (request.method === "GET" && url.pathname === `/${TOPIC}/json`) {
      const since = url.searchParams.get("since");
      const after = messages.findIndex((event) => event.id === since);
      response.end(messages.slice(after + 1).map((event) => `${JSON.stringify(event)}\n`).join(""));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, messages, close: () => new Promise((resolve) => server.close(resolve)) };
}

function runCli(args, root, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args, "--root", root], {
      env: { ...process.env, AGENTIC_SDLC_HOST_LABEL: "PC1", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function project(server) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-auto-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  fs.mkdirSync(path.join(root, ".git/agentic-sdlc"));
  if (server) {
    fs.writeFileSync(path.join(root, ".git/agentic-sdlc/messaging.json"), JSON.stringify({ topic: TOPIC, server }));
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
  const ntfy = await fakeNtfy();
  try {
    const root = await project(ntfy.url);
    const gate = await runCli(["gate", "check", "--scope", "all", "--strict"], root);
    assert.equal(gate.code, 1);
    assert.equal(ntfy.messages.length, 1);
    assert.match(ntfy.messages[0].message, /^\[auto\] need help: gate check failed: .*; reply with --kind answer --reply-to <id>$/u);
    assert.ok(ntfy.messages[0].tags.includes("kind:question"));
    assert.ok(ntfy.messages[0].tags.includes("from:PC1"));
    assert.equal((await runCli(["gate", "check", "--scope", "all", "--strict"], root)).code, 1);
    assert.equal(ntfy.messages.length, 1, "the same alert is not repeated");

    ntfy.messages.push({ id: "other0001", time: 1760000100, event: "message", message: "ST-B-002 is mine", tags: ["agentic-sdlc", "from:PC2"] });
    const claim = await runCli(["story", "claim", "--id", "ST-NOPE-001", "--agent", "a1"], root);
    assert.match(claim.stderr, /PC2: ST-B-002 is mine/u);
    assert.doesNotMatch(claim.stderr, /PC1/u, "own messages are not shown");
    const again = await runCli(["story", "claim", "--id", "ST-NOPE-001", "--agent", "a1"], root);
    assert.doesNotMatch(again.stderr, /ST-B-002 is mine/u);
  } finally {
    await ntfy.close();
  }
});

test("without a topic or with the server down nothing changes", async () => {
  const quiet = await project(null);
  const off = await runCli(["gate", "check", "--scope", "all", "--strict"], quiet);
  assert.equal(off.code, 1);
  assert.doesNotMatch(off.stderr, /automatic message|told the other/u);
  const down = await project("http://127.0.0.1:9");
  const started = Date.now();
  const result = await runCli(["gate", "check", "--scope", "all", "--strict"], down);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /automatic message not sent/u);
  assert.ok(Date.now() - started < 10_000);
});

test("a reply sent here counts as answered before the next poll", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-auto-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  fs.mkdirSync(path.join(root, ".git/agentic-sdlc"));
  fs.writeFileSync(path.join(root, ".git/agentic-sdlc/messaging.json"), JSON.stringify({ topic: TOPIC, server: "http://127.0.0.1:9" }));
  const statePath = path.join(root, ".git/agentic-sdlc/messaging-auto.json");
  const question = { id: "Q1", from: "PC2", kind: "question", text: "help?", time: new Date().toISOString() };
  fs.writeFileSync(statePath, JSON.stringify({ own: [], attention: { window: [question] } }));
  assert.equal(pendingQuestions(JSON.parse(fs.readFileSync(statePath, "utf8")), "PC1").length, 1);
  rememberOwnMessage(root, "A1", {}, { from: "PC3", kind: "answer", reply_to: "Q1", text: "done", time: new Date().toISOString() });
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.deepEqual(state.own, ["A1"]);
  assert.deepEqual(pendingQuestions(state, "PC1"), []);
});
