import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveMessagingConfig } from "../../lib/messaging/config.mjs";
import { messageSend } from "../../lib/messaging/commands.mjs";
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

test("an unreachable messaging server fails send and is reported by read", async () => {
  const root = projectDir();
  const env = { AGENTIC_SDLC_MESSAGING_SERVER: "http://127.0.0.1:9" };
  const sent = await runCli(["message", "send", "--text", "hello", "--json"], { root, env });
  assert.notEqual(sent.code, 0);
  assert.match(sent.stderr, /^MESSAGE NOT SENT:/u);
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
    assert.deepEqual(ntfy.messages[0].tags.filter((tag) => !tag.startsWith("v:")), ["agentic-sdlc", "from:PC1", "host:PC1", "story:ST-UX-001"]);

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
    assert.match(result.stderr, /^MESSAGE NOT SENT:/u);
    assert.equal(ntfy.messages.length, 0);
  } finally {
    await ntfy.close();
  }
});

test("send accepts the text as one argument and refuses both forms together", async () => {
  const ntfy = await fakeNtfy();
  const root = projectDir();
  const env = { AGENTIC_SDLC_MESSAGING_SERVER: ntfy.url };
  try {
    const sent = await runCli(["message", "send", "Build is green", "--sender", "X"], { root, env });
    assert.equal(sent.code, 0, sent.stderr);
    assert.equal(ntfy.messages.length, 1);
    assert.equal(ntfy.messages[0].message, "Build is green");
    const both = await runCli(["message", "send", "one", "--text", "two"], { root, env });
    assert.notEqual(both.code, 0);
    assert.match(both.stderr.split("\n")[0], /^MESSAGE NOT SENT: .*not both/u);
    const many = await runCli(["message", "send", "one", "two"], { root, env });
    assert.notEqual(many.code, 0);
    assert.match(many.stderr, /^MESSAGE NOT SENT:/u);
    assert.equal(ntfy.messages.length, 1);
  } finally {
    await ntfy.close();
  }
});

test("the Observatory never shows or serves messaging settings", async () => {
  const { buildObservatoryViewModel } = await import("../../lib/change-observatory/normalizer.mjs");
  const { readSourceRecord } = await import("../../lib/change-observatory/source-reader.mjs");
  const root = projectDir("shared");
  fs.writeFileSync(path.join(root, ".sdlc/project.json"), JSON.stringify({ project_id: "P-1", name: "Demo" }));
  const model = JSON.stringify(await buildObservatoryViewModel(root));
  assert.doesNotMatch(model, /messaging\.json/u);
  assert.equal(model.includes(TOPIC), false);
  await assert.rejects(readSourceRecord(root, ".sdlc/messaging.json"), /settings/u);
});

test("kinds travel in tags, pending replies are listed and --skip-own honours an explicit --sender", async () => {
  const ntfy = await fakeNtfy();
  const root = projectDir();
  const env = { AGENTIC_SDLC_MESSAGING_SERVER: ntfy.url };
  try {
    const asked = JSON.parse((await runCli(["message", "send", "--json", "--kind", "question", "--sender", "PC1", "--text", "who can publish?"], { root, env: { ...env, AGENTIC_SDLC_HOST_LABEL: "PC1" } })).stdout);
    assert.equal(asked.kind, "question");
    assert.ok(ntfy.messages[0].tags.includes("kind:question"));
    await runCli(["message", "send", "--json", "--sender", "PC2", "--text", "hello"], { root, env: { ...env, AGENTIC_SDLC_HOST_LABEL: "PC2" } });
    const read = JSON.parse((await runCli(["message", "read", "--json"], { root, env: { ...env, AGENTIC_SDLC_HOST_LABEL: "PC1" } })).stdout);
    assert.deepEqual(read.messages[0].pending_replies, ["PC2"]);
    await runCli(["message", "send", "--json", "--kind", "answer", "--reply-to", asked.id, "--sender", "PC2", "--text", "me"], { root, env: { ...env, AGENTIC_SDLC_HOST_LABEL: "PC2" } });
    const after = JSON.parse((await runCli(["message", "read", "--json"], { root, env: { ...env, AGENTIC_SDLC_HOST_LABEL: "PC1" } })).stdout);
    assert.deepEqual(after.messages[0].pending_replies, []);
    assert.equal(after.messages[2].reply_to, asked.id);
    const refused = await runCli(["message", "send", "--kind", "answer", "--text", "x"], { root, env });
    assert.notEqual(refused.code, 0);
    // everything sent from this clone is skipped, even under other --sender names; a foreign message is not
    ntfy.messages.push({ id: "foreign0001", time: 1760001000, event: "message", message: "hi", tags: ["agentic-sdlc", "from:PC7"] });
    const other = JSON.parse((await runCli(["message", "read", "--json", "--skip-own"], { root, env: { ...env, AGENTIC_SDLC_HOST_LABEL: "PC9" } })).stdout);
    assert.equal(other.count, 1);
  } finally {
    await ntfy.close();
  }
});

test("send fails with a quota hint when the server answers HTTP 429", async () => {
  const root = projectDir();
  const providers = {
    ntfy: () => ({
      publish: async () => {
        throw new Error('ntfy publish failed with HTTP 429: {"code":42908,"error":"limit reached: daily message quota reached"}');
      },
    }),
  };
  const env = { AGENTIC_SDLC_MESSAGING_SERVER: "http://127.0.0.1:9", AGENTIC_SDLC_MESSAGING_TOPIC: "agentic-sdlc-test-topic-0001" };
  await assert.rejects(
    messageSend({ root, text: "hello" }, env, providers),
    (error) => /HTTP 429/u.test(error.message) && /quota giornaliera/u.test(error.message),
  );
});
