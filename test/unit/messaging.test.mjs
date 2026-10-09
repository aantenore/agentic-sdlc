import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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

function projectDir(withConfig = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-msg-"));
  fs.mkdirSync(path.join(root, ".sdlc"));
  if (withConfig) {
    fs.writeFileSync(path.join(root, ".sdlc/messaging.json"), JSON.stringify({ provider: "ntfy", server: "https://ntfy.sh", topic: TOPIC }));
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

test("messaging is off without the project file or the topic variable", () => {
  const root = projectDir(false);
  assert.equal(resolveMessagingConfig(root, {}).enabled, false);
  const fromEnv = resolveMessagingConfig(root, { AGENTIC_SDLC_MESSAGING_TOPIC: TOPIC });
  assert.equal(fromEnv.enabled, true);
  assert.equal(fromEnv.server, "https://ntfy.sh");
});

test("environment variables override the project file", () => {
  const root = projectDir();
  const config = resolveMessagingConfig(root, {
    AGENTIC_SDLC_MESSAGING_TOPIC: "other-topic-0123456789",
    AGENTIC_SDLC_MESSAGING_SERVER: "https://ntfy.example.com/",
  });
  assert.equal(config.topic, "other-topic-0123456789");
  assert.equal(config.server, "https://ntfy.example.com");
  assert.equal(resolveMessagingConfig(root, { AGENTIC_SDLC_MESSAGING: "off" }).enabled, false);
  assert.throws(() => resolveMessagingConfig(root, { AGENTIC_SDLC_MESSAGING_SERVER: "http://ntfy.example.com" }), /https/u);
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

test("setup writes a random topic once", async () => {
  const root = projectDir(false);
  const first = await runCli(["message", "setup", "--json"], { root });
  assert.equal(first.code, 0, first.stderr);
  const written = JSON.parse(fs.readFileSync(path.join(root, ".sdlc/messaging.json"), "utf8"));
  assert.match(written.topic, /^sdlc-[0-9a-f]{24}$/u);
  const second = await runCli(["message", "setup"], { root });
  assert.notEqual(second.code, 0);
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
