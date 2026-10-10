import "../helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { describeEvent, relevantMessageEvents, runWatch, watchActive, watchPromptDecision, WATCH_ENV, NO_EVENT_TEXT } from "../../lib/host-hooks/watch.mjs";

const names = new Set(["Antonio", "pc1"]);
const msg = (id, extra = {}) => ({ id: String(id), from: "Alice", host: "pc2", time: "2026-01-01T00:00:00Z", kind: "info", text: "ciao", ...extra });

test("message filter: questions, requests, offers and direct messages are relevant", () => {
  const events = relevantMessageEvents([
    msg(1, { kind: "question", text: "serve aiuto su ST-1?" }),
    msg(2, { kind: "request", to: "pc1" }),
    msg(3, { kind: "info" }),
    msg(4, { kind: "info", to: "Antonio" }),
    msg(5, { kind: "offer", text: "ST-9 released and free to take." }),
    msg(6, { kind: "answer", reply_to: "100" }),
  ], { names, own: new Set(["100"]), installedVersion: "1.0.0" });
  assert.deepEqual(events.map((event) => [event.message.id, event.type]), [["1", "question"], ["2", "question"], ["4", "message"], ["5", "offer"], ["6", "answer"]]);
});

test("message filter: skips own messages, handshakes, other-addressed, answered and [auto] status", () => {
  const events = relevantMessageEvents([
    msg(1, { kind: "question", from: "Antonio" }),
    msg(2, { kind: "question", host: "pc1", from: "Other" }),
    msg(3, { kind: "join" }),
    msg(4, { kind: "welcome" }),
    msg(5, { kind: "request", to: "pc9" }),
    msg(6, { kind: "question" }),
    msg(7, { kind: "answer", from: "Antonio", reply_to: "6" }),
    msg(8, { kind: "info", text: "[auto] ST-1 claimed: work started" }),
    msg(9, { kind: "request", text: "[auto] reminder: no answer yet" }),
    msg(10, { kind: "info", to: "pc1" }),
    msg(11, { kind: "answer", reply_to: "999" }),
  ], { names, own: new Set(["1"]), installedVersion: "1.0.0" });
  assert.deepEqual(events.map((event) => event.message.id), ["10"]);
});

test("message filter: [auto] offers pass; a newer plugin version announced is an event, an older one is not", () => {
  const pass = relevantMessageEvents([msg(1, { kind: "offer", text: "[auto] ST-2 released and free to take." })], { names, installedVersion: "1.0.0" });
  assert.deepEqual(pass.map((event) => event.type), ["offer"]);
  const update = relevantMessageEvents([msg(2, { version: "1.2.0", text: "[auto] plugin 1.2.0" }), msg(3, { version: "0.9.0" })], { names, installedVersion: "1.0.0" });
  assert.deepEqual(update.map((event) => [event.type, event.message.id]), [["plugin", "2"]]);
  assert.match(describeEvent(update[0]), /release del plugin 1\.2\.0.*Alice/u);
});

test("describeEvent: readable summary with sender, computer and story label", () => {
  const text = describeEvent({ type: "question", message: msg(7, { kind: "question", story: "ST-X", text: "puoi guardare?" }) }, { label: (id) => `${id} (titolo)` });
  assert.match(text, /^domanda di Alice · pc2 su ST-X \(titolo\)/u);
  assert.match(describeEvent({ type: "story", story: "ST-Y" }, { label: (id) => `${id} (titolo)` }), /^nuova story libera ST-Y \(titolo\)/u);
});

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watch-"));
  fs.mkdirSync(path.join(root, ".git"));
  return root;
}

function clock() {
  let t = 1_000_000;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

function context({ rounds = [], stories = [[]] } = {}) {
  let poll = 0;
  let scan = 0;
  return {
    provider: { poll: async () => rounds[Math.min(poll++, rounds.length - 1)] ?? [] },
    config: {},
    names,
    own: new Set(),
    label: (id) => `${id} (titolo)`,
    scanStories: async () => stories[Math.min(scan++, stories.length - 1)],
    polls: () => poll,
  };
}

const env = { [WATCH_ENV.poll]: "10", [WATCH_ENV.story]: "10" };

test("watch exits on the first relevant message, ignoring the baseline and irrelevant ones", async () => {
  const root = repo();
  try {
    const ctx = context({ rounds: [[msg(1, { kind: "question", time: "2026-01-01T00:00:00Z" })], [msg(2, { kind: "info" })], [msg(3, { kind: "question", story: "ST-X", text: "serve aiuto" })]] });
    const result = await runWatch(root, { env, timeout: "30m", context: ctx, ...clock() });
    assert.equal(result.status, "event");
    assert.deepEqual(result.events.map((event) => event.id), ["3"]);
    assert.match(result.summary, /domanda di Alice · pc2 su ST-X \(titolo\)/u);
    assert.equal(watchActive(path.join(root, ".git")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("watch exits on a new free story, not on stories seen at start or created here", async () => {
  const root = repo();
  try {
    const ctx = context({ stories: [[{ id: "ST-1", own: false }], [{ id: "ST-1", own: false }, { id: "ST-2", own: true }], [{ id: "ST-1", own: false }, { id: "ST-2", own: true }, { id: "ST-3", own: false }]] });
    const result = await runWatch(root, { env, timeout: "30m", context: ctx, ...clock() });
    assert.equal(result.status, "event");
    assert.deepEqual(result.events, [{ type: "story", story: "ST-3" }]);
    assert.equal(result.summary, "nuova story libera ST-3 (titolo)");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("watch times out with exit-0 semantics and 'nessun evento'", async () => {
  const root = repo();
  try {
    const ctx = context({ rounds: [[msg(1, { kind: "info" })]] });
    const result = await runWatch(root, { env, timeout: "60s", context: ctx, ...clock() });
    assert.equal(result.status, "timeout");
    assert.equal(result.summary, NO_EVENT_TEXT);
    assert.ok(ctx.polls() >= 2 && ctx.polls() <= 8);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a second watch does not start while one is active", async () => {
  const root = repo();
  try {
    const common = path.join(root, ".git");
    const { now } = clock();
    fs.mkdirSync(path.join(common, "agentic-sdlc"));
    fs.writeFileSync(path.join(common, "agentic-sdlc", "watch.json"), JSON.stringify({ pid: 4242, heartbeat: now() }));
    const result = await runWatch(root, { env, timeout: "30m", context: context(), now, sleep: async () => {}, isAlive: () => true });
    assert.equal(result.status, "active");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Stop hook: blocks once without a watch, passes with an active watch, anti-loop window", () => {
  const root = repo();
  try {
    const common = path.join(root, ".git");
    const t0 = 5_000_000;
    const first = watchPromptDecision(common, { env: {}, now: t0, isAlive: () => true });
    assert.match(first, /agentic-sdlc watch --timeout 30m/u);
    assert.match(first, /run_in_background/u);
    assert.equal(watchPromptDecision(common, { env: {}, now: t0 + 60_000 }), null);
    assert.match(watchPromptDecision(common, { env: {}, now: t0 + 10 * 60_000 + 1 }), /watch/u);
    // active watch: pass-through, whatever the window
    fs.writeFileSync(path.join(common, "agentic-sdlc", "watch.json"), JSON.stringify({ pid: 4242, heartbeat: t0 + 3_600_000 }));
    assert.equal(watchPromptDecision(common, { env: {}, now: t0 + 3_600_000 + 1000, isAlive: () => true }), null);
    // stale heartbeat or dead pid: no longer active
    assert.equal(watchActive(common, { env: {}, now: t0 + 3_600_000 + 10 * 60_000, isAlive: () => true }), false);
    assert.equal(watchActive(common, { env: {}, now: t0 + 3_600_000 + 1000, isAlive: () => false }), false);
    assert.equal(watchActive(common, { env: {}, now: t0 + 3_600_000 + 1000, isAlive: () => true }), true);
    // switches
    assert.equal(watchPromptDecision(common, { env: { [WATCH_ENV.prompt]: "off" }, now: t0 + 99_000_000 }), null);
    assert.equal(watchPromptDecision(null, { env: {}, now: t0 }), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
