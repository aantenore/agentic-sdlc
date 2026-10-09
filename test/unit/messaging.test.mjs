import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveMessagingConfig } from "../../lib/messaging/config.mjs";
import { fromNtfyEvent, toNtfyPayload } from "../../lib/messaging/providers/ntfy.mjs";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../bin/agentic-sdlc.mjs");
const TOPIC = "sdlc-test-0123456789abcdef";

// withConfig: "local" stores the topic in the clone's git folder, "shared"
// commits-style in .sdlc/messaging.json (how 0.52.0 wrote it).
function projectDir(withConfig = "local") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-msg-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  fs.mkdirSync(path.join(root, ".sdlc"));
  if (withConfig === "shared") {
    fs.writeFileSync(path.join(root, ".sdlc/messaging.json"), JSON.stringify({ provider: "ntfy", server: "https://ntfy.sh", topic: TOPIC }));
  }
  if (withConfig === "local") {
    fs.mkdirSync(path.join(root, ".git/agentic-sdlc"));
    fs.writeFileSync(path.join(root, ".git/agentic-sdlc/messaging.json"), JSON.stringify({ topic: TOPIC }));
  }
  return root;
}

// A minimal ntfy: JSON publish on "/", NDJSON poll and stream on "/<topic>/json".
async function fakeNtfy() {
  const messages = [];
  const listeners = new Set();
  let counter = 0;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (request.method === "POST" && url.pathname === "/") {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const payload = JSON.parse(body);
        counter += 1;
        const event = { id: `msg${String(counter).padStart(9, "0")}`, time: 1760000000 + counter, event: "message", ...payload };
        messages.push(event);
        for (const listener of listeners) listener.write(`${JSON.stringify(event)}\n`);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(event));
      });
      return;
    }
    if (request.method === "GET" && url.pathname === `/${TOPIC}/json`) {
      if (url.searchParams.get("poll") === "1") {
        response.end(`${messages.map((event) => JSON.stringify(event)).join("\n")}\n`);
        return;
      }
      response.write(`${JSON.stringify({ id: "open", event: "open", topic: TOPIC })}\n`);
      listeners.add(response);
      request.on("close", () => listeners.delete(response));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    messages,
    listenerCount: () => listeners.size,
    close: () => new Promise((resolve) => {
      for (const listener of listeners) listener.end();
      server.close(resolve);
    }),
  };
}

function runCli(args, { root, env = {} }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args, "--root", root], {
      env: { ...process.env, AGENTIC_SDLC_HOST_LABEL: "PC1", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr, child }));
    resolve.child = child;
  });
}

test("messaging is off without a topic", () => {
  const root = projectDir(null);
  const off = resolveMessagingConfig(root, {});
  assert.equal(off.enabled, false);
  assert.match(off.reason, /no topic/u);
  const fromEnv = resolveMessagingConfig(root, { AGENTIC_SDLC_MESSAGING_TOPIC: TOPIC });
  assert.equal(fromEnv.enabled, true);
  assert.equal(fromEnv.server, "https://ntfy.sh");
});

test("environment variables override the local and committed settings", () => {
  const root = projectDir("shared");
  const config = resolveMessagingConfig(root, {
    AGENTIC_SDLC_MESSAGING_TOPIC: "other-topic-0123456789",
    AGENTIC_SDLC_MESSAGING_SERVER: "https://ntfy.example.com/",
  });
  assert.equal(config.topic, "other-topic-0123456789");
  assert.equal(config.server, "https://ntfy.example.com");
  assert.equal(resolveMessagingConfig(root, { AGENTIC_SDLC_MESSAGING: "off" }).enabled, false);
  assert.throws(() => resolveMessagingConfig(root, { AGENTIC_SDLC_MESSAGING_SERVER: "http://ntfy.example.com" }), /https/u);
  assert.equal(resolveMessagingConfig(root, {}).topic_in_git, true);
});

test("the local topic wins over a committed one and stays out of git", () => {
  const root = projectDir("shared");
  fs.mkdirSync(path.join(root, ".git/agentic-sdlc"));
  fs.writeFileSync(path.join(root, ".git/agentic-sdlc/messaging.json"), JSON.stringify({ topic: "local-topic-0123456789" }));
  const config = resolveMessagingConfig(root, {});
  assert.equal(config.topic, "local-topic-0123456789");
  assert.equal(config.server, "https://ntfy.sh");
  assert.equal(config.topic_in_git, false);
  assert.equal(execFileSync("git", ["status", "--porcelain", "--", ".git"], { cwd: root, encoding: "utf8" }), "");
});

test("sender and story round-trip through ntfy tags", () => {
  const payload = toNtfyPayload(TOPIC, { from: "PC1", story: "ST-UX-001", text: "ciao à" });
  const message = fromNtfyEvent({ id: "x", time: 1760000000, event: "message", ...payload });
  assert.equal(message.from, "PC1");
  assert.equal(message.story, "ST-UX-001");
  assert.equal(message.text, "ciao à");
  assert.equal(fromNtfyEvent({ event: "keepalive" }), null);
  assert.equal(fromNtfyEvent({ id: "y", event: "message", message: "plain curl" }).from, null);
});

test("setup creates a topic or stores a shared one, only in the git folder", async () => {
  const root = projectDir(null);
  const first = await runCli(["message", "setup", "--json"], { root });
  assert.equal(first.code, 0, first.stderr);
  const local = path.join(root, ".git/agentic-sdlc/messaging.json");
  const created = JSON.parse(fs.readFileSync(local, "utf8"));
  assert.match(created.topic, /^sdlc-[0-9a-f]{24}$/u);
  assert.equal(fs.existsSync(path.join(root, ".sdlc/messaging.json")), false);

  const joined = await runCli(["message", "setup", "--topic", TOPIC], { root });
  assert.equal(joined.code, 0, joined.stderr);
  assert.equal(JSON.parse(fs.readFileSync(local, "utf8")).topic, TOPIC);
  assert.equal((await runCli(["message", "setup", "--topic", "short"], { root })).code === 0, false);

});

test("a computer without messaging set up keeps working: commands succeed and send nothing", async () => {
  const root = projectDir(null);
  for (const args of [
    ["message", "send", "--text", "hello"],
    ["message", "read"],
    ["message", "listen", "--timeout", "1"],
    ["message", "status"],
  ]) {
    const result = await runCli(args, { root });
    assert.equal(result.code, 0, `${args.join(" ")}: ${result.stderr}`);
    assert.match(result.stdout, /not set up|off/u);
  }
  const json = await runCli(["message", "send", "--text", "hello", "--json"], { root });
  assert.equal(JSON.parse(json.stdout).skipped, true);
  // A broken settings file is reported, not fatal.
  fs.writeFileSync(path.join(root, ".sdlc/messaging.json"), "{not json");
  assert.equal((await runCli(["message", "read"], { root })).code, 0);
});

test("an unreachable messaging server is reported without failing", async () => {
  const root = projectDir();
  const env = { AGENTIC_SDLC_MESSAGING_SERVER: "http://127.0.0.1:9" };
  const sent = await runCli(["message", "send", "--text", "hello", "--json"], { root, env });
  assert.equal(sent.code, 0, sent.stderr);
  assert.equal(JSON.parse(sent.stdout).unavailable, true);
  const read = await runCli(["message", "read"], { root, env });
  assert.equal(read.code, 0, read.stderr);
  assert.match(read.stdout, /unavailable/u);
});

test("send, read and listen through the CLI", async () => {
  const ntfy = await fakeNtfy();
  const root = projectDir();
  const env = { AGENTIC_SDLC_MESSAGING_SERVER: ntfy.url };
  try {
    const listening = runCli(["message", "listen", "--json", "--limit", "1", "--timeout", "20", "--skip-own"], { root, env: { ...env, AGENTIC_SDLC_HOST_LABEL: "PC2" } });
    for (let attempt = 0; attempt < 100 && ntfy.listenerCount() === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const sent = await runCli(["message", "send", "--story", "ST-UX-001", "--text", "Tests still take 30 minutes"], { root, env });
    assert.equal(sent.code, 0, sent.stderr);
    assert.equal(ntfy.messages.length, 1);
    assert.deepEqual(ntfy.messages[0].tags, ["agentic-sdlc", "from:PC1", "story:ST-UX-001"]);

    const heard = await listening;
    assert.equal(heard.code, 0, heard.stderr);
    const line = JSON.parse(heard.stdout.trim().split("\n").at(-1));
    assert.equal(line.from, "PC1");
    assert.equal(line.text, "Tests still take 30 minutes");

    const read = await runCli(["message", "read", "--json"], { root, env });
    assert.equal(read.code, 0, read.stderr);
    const report = JSON.parse(read.stdout);
    assert.equal(report.count, 1);
    assert.match(report.note, /not instructions/u);
    const own = await runCli(["message", "read", "--json", "--skip-own"], { root, env });
    assert.equal(JSON.parse(own.stdout).count, 0);
  } finally {
    await ntfy.close();
  }
});

test("send refuses text that looks like a secret", async () => {
  const ntfy = await fakeNtfy();
  const root = projectDir();
  try {
    const result = await runCli(["message", "send", "--text", "key AKIAABCDEFGHIJKLMNOP"], { root, env: { AGENTIC_SDLC_MESSAGING_SERVER: ntfy.url } });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /secret/u);
    assert.equal(ntfy.messages.length, 0);
  } finally {
    await ntfy.close();
  }
});
