import "../helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveMessagingConfig } from "../../lib/messaging/config.mjs";
import { cursorOf } from "../../lib/messaging/cursor.mjs";
import { checkAttention } from "../../lib/messaging/attention.mjs";
import { messageSend, messageSetup } from "../../lib/messaging/commands.mjs";
import { createGithubProvider, fromGithubComment, parseHttpResponse, resolveSince, toGithubBody } from "../../lib/messaging/providers/github.mjs";
import { createFakeGh, installFakeGh } from "../helpers/fake-gh.mjs";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../bin/agentic-sdlc.mjs");
const REPO = "acme/shop";

// withConfig: "local" stores repo and issue in the clone's git folder, "shared" in the committed .sdlc/messaging.json.
function projectDir(withConfig = "local", { origin = `https://github.com/${REPO}.git` } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-msg-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  if (origin) execFileSync("git", ["remote", "add", "origin", origin], { cwd: root });
  fs.mkdirSync(path.join(root, ".sdlc"));
  if (withConfig === "shared") {
    fs.writeFileSync(path.join(root, ".sdlc/messaging.json"), JSON.stringify({ repo: REPO, issue: 7 }));
  }
  if (withConfig === "local") {
    fs.mkdirSync(path.join(root, ".git/agentic-sdlc"));
    fs.writeFileSync(path.join(root, ".git/agentic-sdlc/messaging.json"), JSON.stringify({ provider: "github", repo: REPO, issue: 1 }));
  }
  return root;
}

// A fake gh on PATH plus a channel issue #1, so the CLI never reaches GitHub.
function fakeGhFor(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-gh-"));
  return installFakeGh(dir, { issues: [{ number: 1, title: "Agentic SDLC · canale tra computer", state: "open", labels: [{ name: "agentic-sdlc-channel" }] }], nextIssue: 2, start: Date.now(), ...overrides });
}

function runCli(args, { root, env = {} }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args, "--root", root], {
      env: { ...process.env, AGENTIC_SDLC_HOST_LABEL: "PC1", AGENTIC_SDLC_AUTO_PUBLISH: "off", AGENTIC_SDLC_MESSAGING_JOIN: "off", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("messaging is off without a repository and can come from the environment", () => {
  const root = projectDir(null);
  const off = resolveMessagingConfig(root, {});
  assert.equal(off.enabled, false);
  assert.match(off.reason, /no repository/u);
  const fromEnv = resolveMessagingConfig(root, { AGENTIC_SDLC_MESSAGING_REPO: "https://github.com/acme/other.git", AGENTIC_SDLC_MESSAGING_ISSUE: "12" });
  assert.equal(fromEnv.enabled, true);
  assert.equal(fromEnv.repo, "acme/other");
  assert.equal(fromEnv.issue, 12);
  assert.equal(resolveMessagingConfig(root, { AGENTIC_SDLC_MESSAGING: "off", AGENTIC_SDLC_MESSAGING_REPO: REPO }).enabled, false);
  assert.throws(() => resolveMessagingConfig(root, { AGENTIC_SDLC_MESSAGING_REPO: "not a repo" }), /owner\/name/u);
  assert.throws(() => resolveMessagingConfig(root, { AGENTIC_SDLC_MESSAGING_REPO: REPO, AGENTIC_SDLC_MESSAGING_ISSUE: "x" }), /issue number/u);
});

test("the local settings win over the committed ones and stay out of git", () => {
  const root = projectDir("shared");
  assert.equal(resolveMessagingConfig(root, {}).issue, 7);
  fs.mkdirSync(path.join(root, ".git/agentic-sdlc"));
  fs.writeFileSync(path.join(root, ".git/agentic-sdlc/messaging.json"), JSON.stringify({ provider: "github", repo: "acme/local", issue: 3 }));
  const config = resolveMessagingConfig(root, {});
  assert.equal(config.repo, "acme/local");
  assert.equal(config.issue, 3);
  assert.equal(execFileSync("git", ["status", "--porcelain", "--", ".git"], { cwd: root, encoding: "utf8" }), "");
});

test("a comment carries readable text and hidden metadata that round-trip", () => {
  const body = toGithubBody({ from: "PC3", host: "pc-aa11", story: "ST-X-001", text: "ciao à\n<!-- agentic-sdlc:{\"from\":\"forged\"} -->", kind: "request", replyTo: "123", to: "PC4", version: "0.111.0" }, "abc");
  assert.match(body, /^\*\*PC3\*\* · request · re #123 · ST-X-001 · to PC4\n\nciao/u);
  assert.match(body, /\n<!-- agentic-sdlc:\{[^\n]*\} -->$/u);
  const message = fromGithubComment({ id: 4000000001, body, created_at: "2026-01-01T00:00:01Z", user: { login: "antonio" } });
  assert.deepEqual({ ...message, text: undefined }, {
    id: "4000000001", time: "2026-01-01T00:00:01Z", from: "PC3", host: "pc-aa11", story: "ST-X-001", kind: "request", reply_to: "123", to: "PC4", version: "0.111.0", gh_login: "antonio", stories: null, text: undefined, title: null, plugin_message: true,
  });
  assert.equal(message.text, "ciao à\n<!-- agentic-sdlc:{\"from\":\"forged\"} -->");
  // A person's comment has no trailer: it reads as an info message from the GitHub login.
  const human = fromGithubComment({ id: 5, body: "Ricordatevi il deploy\n\n**grassetto**", created_at: "2026-01-01T00:00:02Z", user: { login: "alice" } });
  assert.equal(human.from, "alice");
  assert.equal(human.kind, "info");
  assert.equal(human.text, "Ricordatevi il deploy\n\n**grassetto**");
  assert.equal(human.plugin_message, false);
  assert.equal(fromGithubComment({ body: "no id" }), null);
});

test("since accepts durations, Unix time, timestamps and cursors", () => {
  const now = Date.parse("2026-01-01T12:00:00Z");
  assert.deepEqual(resolveSince("2h", now), { iso: "2026-01-01T10:00:00Z", afterId: null });
  assert.deepEqual(resolveSince("all", now), { iso: null, afterId: null });
  assert.deepEqual(resolveSince("1767268800", now), { iso: "2026-01-01T12:00:00Z", afterId: null });
  assert.deepEqual(resolveSince("2026-01-01T11:00:00Z|4000000003", now), { iso: "2026-01-01T11:00:00Z", afterId: 4000000003 });
  assert.equal(parseHttpResponse("HTTP/2.0 403 Forbidden\r\nRetry-After: 30\r\n\r\n{\"message\":\"x\"}").headers["retry-after"], "30");
});

test("the provider sends a comment and reads every page after a cursor", async () => {
  const gh = createFakeGh({ issues: [{ number: 1, title: "t", state: "open", labels: [] }], nextIssue: 2 });
  const provider = createGithubProvider({ exec: gh.exec });
  const config = { repo: REPO, issue: 1, local_path: null };
  const sent = await provider.publish({ config, message: { from: "PC1", host: "PC1", story: null, text: "first", kind: "info", version: "0.111.0" } });
  assert.equal(sent.id, "4000000000");
  assert.equal(sent.from, "PC1");
  const post = gh.state.calls.at(-1);
  assert.deepEqual(post.slice(0, 5), ["api", "-i", "--method", "POST", `repos/${REPO}/issues/1/comments`]);
  for (let index = 0; index < 149; index += 1) {
    await provider.publish({ config, message: { from: "PC2", host: "PC2", text: `m${index}`, kind: "info" } });
  }
  const all = await provider.poll({ config, since: "all" });
  assert.equal(all.length, 150);
  assert.equal(gh.state.calls.filter((call) => /comments\?/u.test(call[4])).length, 2, "two pages of 100");
  const cursor = cursorOf(all[99]);
  const rest = await provider.poll({ config, since: cursor });
  assert.equal(rest.length, 50);
  assert.equal(rest[0].id, all[100].id);
  assert.match(gh.state.calls.at(-1)[4], /since=2026-01-01T00:01:40Z/u);
});

test("setup finds the channel issue, or creates it once, and the lowest number wins a race", async () => {
  const root = projectDir(null);
  const gh = createFakeGh();
  const providers = { github: () => createGithubProvider({ exec: gh.exec }) };
  const created = await messageSetup({ root, json: true }, { AGENTIC_SDLC_MESSAGING_AUTO: "off" }, providers);
  assert.equal(created.issue, 1);
  assert.equal(created.created, true);
  assert.equal(gh.state.issues.length, 1);
  assert.deepEqual(gh.state.issues[0].labels, [{ name: "agentic-sdlc-channel" }]);
  const stored = JSON.parse(fs.readFileSync(path.join(root, ".git/agentic-sdlc/messaging.json"), "utf8"));
  assert.deepEqual({ provider: stored.provider, repo: stored.repo, issue: stored.issue }, { provider: "github", repo: REPO, issue: 1 });

  const second = projectDir(null);
  const again = await messageSetup({ root: second, json: true }, { AGENTIC_SDLC_MESSAGING_AUTO: "off" }, providers);
  assert.equal(again.issue, 1);
  assert.equal(again.created, false);
  assert.equal(gh.state.issues.length, 1, "idempotent");

  // Two computers creating together: ours is number 3 while another one just made number 2.
  const racing = createFakeGh({ raceOnCreate: true });
  const racer = await messageSetup({ root: projectDir(null), json: true }, { AGENTIC_SDLC_MESSAGING_AUTO: "off" }, { github: () => createGithubProvider({ exec: racing.exec }) });
  assert.equal(racer.issue, 1);
  assert.equal(racing.state.issues.find((issue) => issue.number === 2).state, "closed");

  // An explicit issue is checked; a missing one is refused.
  await assert.rejects(messageSetup({ root: projectDir(null), issue: "99" }, { AGENTIC_SDLC_MESSAGING_AUTO: "off" }, providers), /Could not set up/u);
  const noOrigin = projectDir(null, { origin: null });
  await assert.rejects(messageSetup({ root: noOrigin }, {}, providers), /--repo owner\/name/u);
});

test("an existing ntfy clone is converted to GitHub with its outbox and useful state kept", () => {
  const root = projectDir(null);
  const dir = path.join(root, ".git/agentic-sdlc");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "messaging.json"), JSON.stringify({ provider: "ntfy", topic: "sdlc-0123456789abcdef", server: "https://ntfy.example.com" }));
  fs.writeFileSync(path.join(dir, "messaging-outbox.json"), JSON.stringify({ items: [{ id: "ob1", message: { text: "queued", kind: "info" } }] }));
  fs.writeFileSync(path.join(dir, "messaging-auto.json"), JSON.stringify({
    cursor: "oldntfyid", own: ["a"], sent: { "k|t": 1 }, warned_at: 5,
    attention: { last_poll: 9, cursor: "x", window: [{ id: "a" }], digested: ["a"], escalated: [] },
  }));
  const config = resolveMessagingConfig(root, {});
  assert.equal(config.enabled, true);
  assert.equal(config.provider, "github");
  assert.equal(config.repo, REPO);
  assert.equal(config.migrated, true);
  const stored = JSON.parse(fs.readFileSync(path.join(dir, "messaging.json"), "utf8"));
  assert.deepEqual(stored, { provider: "github", repo: REPO, migrated_from: "ntfy" });
  const state = JSON.parse(fs.readFileSync(path.join(dir, "messaging-auto.json"), "utf8"));
  assert.deepEqual(state, { sent: { "k|t": 1 }, warned_at: 5, attention: { last_poll: 9 } });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "messaging-outbox.json"), "utf8")).items.length, 1);
  assert.equal(resolveMessagingConfig(root, {}).migrated, false, "converted once");

  // A topic in the committed file (0.52.0) converts to a local GitHub setting too.
  const shared = projectDir(null);
  fs.writeFileSync(path.join(shared, ".sdlc/messaging.json"), JSON.stringify({ provider: "ntfy", topic: "sdlc-0123456789abcdef" }));
  assert.equal(resolveMessagingConfig(shared, {}).repo, REPO);
  // Without a GitHub origin there is nothing to convert to: off, with the way out.
  const orphan = projectDir(null, { origin: null });
  fs.mkdirSync(path.join(orphan, ".git/agentic-sdlc"));
  fs.writeFileSync(path.join(orphan, ".git/agentic-sdlc/messaging.json"), JSON.stringify({ topic: "sdlc-0123456789abcdef" }));
  assert.match(resolveMessagingConfig(orphan, {}).reason, /ntfy is no longer supported/u);
});

test("the first command after the update sends the old outbox through GitHub", async () => {
  const root = projectDir(null);
  const dir = path.join(root, ".git/agentic-sdlc");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "messaging.json"), JSON.stringify({ topic: "sdlc-0123456789abcdef" }));
  const message = { from: "PC1", host: "PC1", story: null, text: "stuck in the old queue", kind: "info", replyTo: null, to: null };
  fs.writeFileSync(path.join(dir, "messaging-outbox.json"), JSON.stringify({ items: [{ id: "ob1", queued_at: "2026-01-01T00:00:00Z", reason: "HTTP 429", attempts: 1, message }], next_attempt: 1 }));
  const gh = fakeGhFor();
  const result = await runCli(["message", "send", "--text", "after update", "--json"], { root, env: gh.env });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /moved from ntfy to GitHub/u);
  const state = gh.read();
  assert.deepEqual(state.comments.map((comment) => /stuck in the old queue|after update/u.exec(comment.body)?.[0]), ["stuck in the old queue", "after update"]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "messaging.json"), "utf8")).issue, 1, "the channel issue is remembered");
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

test("without gh send queues with the command to run (exit 75) and read reports it", async () => {
  const root = projectDir();
  // A PATH with git but no gh.
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-nogh-"));
  fs.symlinkSync(execFileSync("which", ["git"], { encoding: "utf8" }).trim(), path.join(bin, "git"));
  const env = { PATH: bin };
  const sent = await runCli(["message", "send", "--text", "hello", "--json"], { root, env });
  assert.equal(sent.code, 75);
  assert.match(sent.stderr, /^MESSAGE QUEUED \(not sent yet\):.*gh auth login/mu);
  assert.equal(JSON.parse(sent.stdout).queued, true);
  const listed = await runCli(["message", "outbox", "--json"], { root, env });
  assert.equal(JSON.parse(listed.stdout).count, 1);
  const dropped = await runCli(["message", "outbox", "--drop", JSON.parse(listed.stdout).items[0].id], { root, env });
  assert.equal(dropped.code, 0, dropped.stderr);
  assert.equal(JSON.parse((await runCli(["message", "outbox", "--json"], { root, env })).stdout).count, 0);
  const read = await runCli(["message", "read"], { root, env });
  assert.equal(read.code, 0, read.stderr);
  assert.match(read.stdout, /unavailable/u);
});

test("a gh that is not signed in is explained and the message is kept", async () => {
  const root = projectDir();
  const gh = fakeGhFor({ noAuth: true });
  const sent = await runCli(["message", "send", "--text", "hello", "--json"], { root, env: gh.env });
  assert.equal(sent.code, 75);
  assert.match(JSON.parse(sent.stdout).reason, /gh auth login/u);
});

test("send, read and listen through the CLI", async () => {
  const gh = fakeGhFor();
  const root = projectDir();
  const env = { ...gh.env, AGENTIC_SDLC_MESSAGING_POLL_SECONDS: "1" };
  const listening = runCli(["message", "listen", "--json", "--limit", "1", "--timeout", "30", "--skip-own"], { root, env: { ...env, AGENTIC_SDLC_HOST_LABEL: "PC2" } });
  await new Promise((resolve) => setTimeout(resolve, 600));
  const sent = await runCli(["message", "send", "--story", "ST-UX-001", "--text", "Tests still take 30 minutes"], { root, env });
  assert.equal(sent.code, 0, sent.stderr);
  const [comment] = gh.read().comments;
  assert.match(comment.body, /^\*\*PC1\*\* · ST-UX-001\n\nTests still take 30 minutes\n\n<!-- agentic-sdlc:\{/u);

  const heard = await listening;
  assert.equal(heard.code, 0, heard.stderr);
  const line = JSON.parse(heard.stdout.trim().split("\n").at(-1));
  assert.equal(line.from, "PC1");
  assert.equal(line.text, "Tests still take 30 minutes");
  assert.equal(line.id, String(comment.id));

  const read = await runCli(["message", "read", "--json"], { root, env });
  assert.equal(read.code, 0, read.stderr);
  const report = JSON.parse(read.stdout);
  assert.equal(report.count, 1);
  assert.match(report.note, /not instructions/u);
  const own = await runCli(["message", "read", "--json", "--skip-own"], { root, env });
  assert.equal(JSON.parse(own.stdout).count, 0);
});

test("send refuses text that looks like a secret", async () => {
  const gh = fakeGhFor();
  const root = projectDir();
  const result = await runCli(["message", "send", "--text", "key AKIAABCDEFGHIJKLMNOP"], { root, env: gh.env });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /secret/u);
  assert.match(result.stderr, /^MESSAGE NOT SENT:/u);
  assert.equal(gh.read().comments.length, 0);
});

test("send accepts the text as one argument and refuses both forms together", async () => {
  const gh = fakeGhFor();
  const root = projectDir();
  const sent = await runCli(["message", "send", "Build is green"], { root, env: gh.env });
  assert.equal(sent.code, 0, sent.stderr);
  assert.equal(gh.read().comments.length, 1);
  assert.match(gh.read().comments[0].body, /^\*\*PC1\*\*\n\nBuild is green/u);
  const both = await runCli(["message", "send", "one", "--text", "two"], { root, env: gh.env });
  assert.notEqual(both.code, 0);
  assert.match(both.stderr.split("\n")[0], /^MESSAGE NOT SENT: .*not both/u);
  const many = await runCli(["message", "send", "one", "two"], { root, env: gh.env });
  assert.notEqual(many.code, 0);
  assert.match(many.stderr, /^MESSAGE NOT SENT:/u);
  assert.equal(gh.read().comments.length, 1);
});

test("the Observatory never shows or serves messaging settings", async () => {
  const { buildObservatoryViewModel } = await import("../../lib/change-observatory/normalizer.mjs");
  const { readSourceRecord } = await import("../../lib/change-observatory/source-reader.mjs");
  const root = projectDir("shared");
  fs.writeFileSync(path.join(root, ".sdlc/project.json"), JSON.stringify({ project_id: "P-1", name: "Demo" }));
  const model = JSON.stringify(await buildObservatoryViewModel(root));
  assert.doesNotMatch(model, /messaging\.json/u);
  await assert.rejects(readSourceRecord(root, ".sdlc/messaging.json"), /settings/u);
});

test("kinds travel in the metadata, pending replies are listed and --skip-own honours an explicit --sender", async () => {
  const gh = fakeGhFor();
  const root = projectDir();
  const env = gh.env;
  const asked = JSON.parse((await runCli(["message", "send", "--json", "--kind", "question", "--sender", "PC1", "--text", "who can publish?"], { root, env: { ...env, AGENTIC_SDLC_HOST_LABEL: "PC1" } })).stdout);
  assert.equal(asked.kind, "question");
  assert.match(gh.read().comments[0].body, /^\*\*PC1\*\* · question\n/u);
  await runCli(["message", "send", "--json", "--sender", "PC2", "--text", "hello"], { root, env: { ...env, AGENTIC_SDLC_HOST_LABEL: "PC2" } });
  const read = JSON.parse((await runCli(["message", "read", "--json"], { root, env: { ...env, AGENTIC_SDLC_HOST_LABEL: "PC1" } })).stdout);
  assert.deepEqual(read.messages[0].pending_replies, ["PC2"]);
  await runCli(["message", "send", "--json", "--kind", "answer", "--reply-to", asked.id, "--sender", "PC2", "--text", "me"], { root, env: { ...env, AGENTIC_SDLC_HOST_LABEL: "PC2" } });
  const after = JSON.parse((await runCli(["message", "read", "--json"], { root, env: { ...env, AGENTIC_SDLC_HOST_LABEL: "PC1" } })).stdout);
  assert.deepEqual(after.messages[0].pending_replies, []);
  assert.equal(after.messages[2].reply_to, asked.id);
  const refused = await runCli(["message", "send", "--kind", "answer", "--text", "x"], { root, env });
  assert.notEqual(refused.code, 0);
  // everything sent from this clone is skipped, even under other --sender names; a person's comment is not
  const later = new Date(Date.now() + 3_600_000).toISOString().replace(/\.\d{3}Z$/u, "Z");
  gh.write((state) => state.comments.push({ id: 4999999999, issue: 1, body: "from a person", created_at: later, updated_at: later, user: { login: "alice" } }));
  const other = JSON.parse((await runCli(["message", "read", "--json", "--skip-own"], { root, env: { ...env, AGENTIC_SDLC_HOST_LABEL: "PC9" } })).stdout);
  assert.equal(other.count, 1);
  assert.equal(other.messages[0].from, "alice");
});

test("send queues and waits when GitHub answers a secondary rate limit", async () => {
  const root = projectDir();
  const gh = createFakeGh({ issues: [{ number: 1, title: "t", state: "open", labels: [] }], nextIssue: 2 });
  gh.state.faults.push({ status: 403, message: "You have exceeded a secondary rate limit.", headers: { "Retry-After": "120" } });
  const providers = { github: () => createGithubProvider({ exec: gh.exec }) };
  const queued = await messageSend({ root, text: "hello", json: true }, { AGENTIC_SDLC_HOST_LABEL: "PC1", AGENTIC_SDLC_MESSAGING_JOIN: "off" }, providers);
  assert.equal(queued.queued, true);
  assert.match(queued.reason, /HTTP 403/u);
  assert.match(queued.reason, /retry in 120s/u);
  const outbox = JSON.parse(fs.readFileSync(path.join(root, ".git/agentic-sdlc/messaging-outbox.json"), "utf8"));
  assert.ok(outbox.next_attempt - Date.parse(outbox.items[0].queued_at) >= 119_000, "waits at least the retry-after");
});

test("the attention hook reads GitHub at most once per interval and keeps a cursor", async () => {
  const root = projectDir();
  const gh = createFakeGh({ issues: [{ number: 1, title: "t", state: "open", labels: [] }], nextIssue: 2, start: Date.now() });
  const providers = { github: () => createGithubProvider({ exec: gh.exec }) };
  const env = { AGENTIC_SDLC_HOST_LABEL: "PC1" };
  const other = createGithubProvider({ exec: gh.exec });
  const sent = await other.publish({ config: { repo: REPO, issue: 1 }, message: { from: "PC2", host: "PC2", kind: "question", text: "who can publish?", version: "0.111.0" } });
  const first = await checkAttention(root, { env, providers, now: Date.now() });
  assert.match(first, new RegExp(`#${sent.id} PC2 <question>: who can publish\\?`, "u"));
  const reads = () => gh.state.calls.filter((call) => /comments\?/u.test(call[4])).length;
  assert.equal(reads(), 1);
  const state = JSON.parse(fs.readFileSync(path.join(root, ".git/agentic-sdlc/messaging-auto.json"), "utf8"));
  assert.equal(state.attention.cursor, cursorOf(sent));
  assert.equal(await checkAttention(root, { env, providers, now: Date.now() + 10_000 }), null);
  assert.equal(reads(), 1, "inside the 30 second gap there is no read");
  await checkAttention(root, { env, providers, now: Date.now() + 31_000 });
  assert.equal(reads(), 2);
  assert.match(gh.state.calls.at(-1)[4], /since=/u, "later reads ask only for what is new");
});
