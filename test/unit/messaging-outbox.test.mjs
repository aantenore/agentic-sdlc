import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { decideKeepGoing, pendingQuestions } from "../../lib/host-hooks/keep-going.mjs";
import { flushMessageOutbox, messageOutbox, messageSend, messageStatus } from "../../lib/messaging/commands.mjs";
import { selectAttention } from "../../lib/messaging/attention.mjs";
import { ownMessageIds } from "../../lib/messaging/auto.mjs";
import { enqueue, isTemporaryFailure, outboxPath, readOutbox, OUTBOX_ENV } from "../../lib/messaging/outbox.mjs";

const TOPIC = "agentic-sdlc-test-topic-0001";
const quiet = (fn) => async (...args) => {
  const log = console.log;
  console.log = () => {};
  try { return await fn(...args); } finally { console.log = log; }
};
const send = quiet(messageSend);

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-outbox-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  const env = { AGENTIC_SDLC_MESSAGING_TOPIC: TOPIC, AGENTIC_SDLC_HOST_LABEL: "PC1", AGENTIC_SDLC_MESSAGING_AUTO: "on" };
  return { root, env };
}

// A provider whose publish answers from a script: an Error to refuse, anything else to accept.
function scripted(...answers) {
  const calls = [];
  let counter = 0;
  return {
    calls,
    providers: {
      ntfy: () => ({
        publish: async ({ message }) => {
          calls.push(message);
          const answer = answers.length > 0 ? answers.shift() : "ok";
          if (answer instanceof Error) throw answer;
          counter += 1;
          return { id: `sent${String(counter).padStart(8, "0")}` };
        },
      }),
    },
  };
}

const quota = () => new Error('ntfy publish failed with HTTP 429: {"code":42908,"error":"limit reached"}');

test("a 429 queues the message in a 0600 outbox file with the reason", async () => {
  const { root, env } = project();
  const { providers } = scripted(quota());
  const result = await send({ root, text: "hello", kind: "answer", "reply-to": "q1" }, env, providers);
  assert.equal(result.queued, true);
  assert.equal(result.sent, false);
  assert.match(result.reason, /HTTP 429/u);
  const file = outboxPath(root);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const outbox = readOutbox(root);
  assert.equal(outbox.items.length, 1);
  assert.equal(outbox.items[0].message.replyTo, "q1");
  assert.match(outbox.items[0].reason, /429/u);
});

test("network errors and timeouts are temporary; other 4xx and validation are not", async () => {
  assert.equal(isTemporaryFailure(new Error("fetch failed")), true);
  assert.equal(isTemporaryFailure(Object.assign(new Error("aborted"), { name: "TimeoutError" })), true);
  assert.equal(isTemporaryFailure(new Error("ntfy publish failed with HTTP 503")), true);
  assert.equal(isTemporaryFailure(quota()), true);
  assert.equal(isTemporaryFailure(new Error("ntfy publish failed with HTTP 400: bad")), false);
  assert.equal(isTemporaryFailure(new Error("ntfy publish failed with HTTP 403")), false);
  const { root, env } = project();
  const { providers } = scripted(new Error("ntfy publish failed with HTTP 400: bad request"));
  await assert.rejects(send({ root, text: "hello" }, env, providers), /HTTP 400/u);
  assert.equal(readOutbox(root).items.length, 0);
  await assert.rejects(send({ root, text: "" }, env, providers), /needs --text/u);
  assert.equal(readOutbox(root).items.length, 0);
});

test("a successful flush sends in order, empties the queue and remembers the ids", async () => {
  const { root, env } = project();
  const { providers, calls } = scripted(quota(), "ok", "ok");
  await send({ root, text: "first", kind: "answer", "reply-to": "q1" }, env, providers);
  // Force the schedule open, as if the wait had passed.
  const file = outboxPath(root);
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...state, next_attempt: 0 }));
  const second = await send({ root, text: "second" }, env, providers);
  assert.equal(second.sent, true);
  assert.deepEqual(calls.map((message) => message.text), ["first", "first", "second"]);
  assert.equal(readOutbox(root).items.length, 0);
  const own = ownMessageIds(root, env);
  assert.equal(own.size, 2);
  assert.equal(calls[1].replyTo, "q1");
});

test("backoff: nothing is attempted before the schedule, and each failure doubles the wait", async () => {
  const { root, env } = project();
  const { providers, calls } = scripted(quota());
  await send({ root, text: "a" }, env, providers);
  assert.equal(calls.length, 1);
  // Inside the wait a new send is queued behind the first without touching the server.
  const second = await send({ root, text: "b" }, env, providers);
  assert.equal(second.queued, true);
  assert.equal(calls.length, 1);
  assert.equal(readOutbox(root).items.length, 2);
  // At the scheduled time one attempt is made, fails, and the next one is further away.
  const config = { enabled: true, provider: "ntfy", server: "http://127.0.0.1:9", topic: TOPIC };
  const gap = 5 * 60_000;
  const t0 = readOutbox(root).next_attempt;
  const failing = scripted(quota(), quota());
  const first = await flushMessageOutbox(root, config, { env, providers: failing.providers });
  assert.equal(first.attempted, false, "still inside the wait");
  const realNow = Date.now;
  Date.now = () => t0 + 1;
  try {
    const { flushOutbox } = await import("../../lib/messaging/outbox.mjs");
    const run1 = await flushOutbox(root, { config, provider: failing.providers.ntfy(), env, now: t0 + 1 });
    assert.equal(run1.attempted, true);
    assert.equal(run1.sent.length, 0);
    assert.equal(failing.calls.length, 1, "stops at the first refusal");
    const next1 = readOutbox(root).next_attempt;
    assert.equal(next1, t0 + 1 + gap * 4);
    const run2 = await flushOutbox(root, { config, provider: failing.providers.ntfy(), env, now: next1 + 1 });
    assert.equal(run2.attempted, true);
    assert.equal(readOutbox(root).next_attempt, next1 + 1 + gap * 8);
  } finally {
    Date.now = realNow;
  }
});

test("the retry gap is configurable", async () => {
  const { root, env } = project();
  const { providers } = scripted(quota());
  await send({ root, text: "a" }, { ...env, [OUTBOX_ENV.retry]: "1" }, providers);
  const outbox = readOutbox(root);
  const wait = outbox.next_attempt - Date.now();
  assert.ok(wait > 0 && wait <= 60_000, `wait ${wait}`);
});

test("a queued message the server refuses for good is dropped on flush", async () => {
  const { root, env } = project();
  enqueue(root, { from: "PC1", host: "PC1", story: null, text: "bad", kind: "info", replyTo: null, to: null }, "offline", 1);
  enqueue(root, { from: "PC1", host: "PC1", story: null, text: "good", kind: "info", replyTo: null, to: null }, "offline", 1);
  const { providers, calls } = scripted(new Error("ntfy publish failed with HTTP 400: nope"), "ok");
  const config = { enabled: true, provider: "ntfy", server: "http://127.0.0.1:9", topic: TOPIC };
  const flushed = await flushMessageOutbox(root, config, { env, providers, force: true });
  assert.equal(flushed.rejected.length, 1);
  assert.equal(flushed.sent.length, 1);
  assert.equal(readOutbox(root).items.length, 0);
  assert.equal(calls.length, 2);
});

test("a queued answer settles its question for keep-going and attention", () => {
  const items = [{ id: "ob1", message: { replyTo: "q1", kind: "answer", text: "x" }, reason: "HTTP 429" }];
  const window = [
    { id: "q1", from: "pc-2", kind: "question", text: "ok?", time: new Date().toISOString() },
    { id: "q2", from: "pc-2", kind: "question", text: "and?", time: new Date().toISOString() },
  ];
  const state = { attention: { window }, own: [] };
  assert.deepEqual(pendingQuestions(state, "PC1").map((q) => q.id), ["q1", "q2"]);
  assert.deepEqual(pendingQuestions(state, "PC1", items).map((q) => q.id), ["q2"]);
  const queued = new Set(["q1"]);
  assert.deepEqual(selectAttention({ messages: window, self: "PC1", queued }).pending.map((m) => m.id), ["q2"]);
  // keep-going: the queue is a one-time, non-blocking note.
  const outbox = { count: 1, reason: "HTTP 429", notified: false };
  const decision = decideKeepGoing({ questions: [], outbox });
  assert.equal(decision.block, false);
  assert.match(decision.note, /1 messaggi in coda, non ancora inviati \(HTTP 429\).*AGENTIC_SDLC_MESSAGING_SERVER/u);
  assert.equal(decideKeepGoing({ questions: [], outbox: { ...outbox, notified: true } }).note, null);
});

test("message status and message outbox show the queue; --drop removes one", async () => {
  const { root, env } = project();
  const { providers } = scripted(quota());
  await send({ root, text: "hello" }, env, providers);
  const logs = [];
  const log = console.log;
  console.log = (line) => logs.push(line);
  try {
    const status = messageStatus({ root, json: true }, env);
    assert.equal(status.outbox.count, 1);
    const listed = await messageOutbox({ root, json: true }, env, providers);
    assert.equal(listed.count, 1);
    await messageOutbox({ root, drop: listed.items[0].id }, env, providers);
  } finally {
    console.log = log;
  }
  assert.equal(readOutbox(root).items.length, 0);
  await assert.rejects(messageOutbox({ root, drop: "nope" }, env, providers), /No queued message/u);
});
