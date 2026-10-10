import assert from "node:assert/strict";
import test from "node:test";

import { attentionContext, reminderFor, selectAttention } from "../../lib/messaging/attention.mjs";

const NOW = Date.parse("2026-10-10T12:00:00Z");
const at = (minutesAgo) => new Date(NOW - minutesAgo * 60_000).toISOString();
const msg = (id, from, kind, extra = {}) => ({ id, from, kind, text: `text ${id}`, time: at(extra.ago ?? 1), ...extra });

test("questions to this computer or to everyone stay pending until answered here", () => {
  const messages = [
    msg("q1", "pc-b", "question"),
    msg("q2", "pc-b", "request", { to: "pc-a" }),
    msg("q3", "pc-b", "question", { to: "pc-c" }),
    msg("i1", "pc-b", "info"),
  ];
  const first = selectAttention({ messages, self: "pc-a", now: NOW });
  assert.deepEqual(first.pending.map((m) => m.id), ["q1", "q2"]);
  assert.deepEqual(first.digest.map((m) => m.id), ["q3", "i1"]);

  // Re-injected on the next poll while unanswered; the digest is not repeated.
  const again = selectAttention({ messages, self: "pc-a", digested: new Set(["q1", "q2", "q3", "i1"]), now: NOW });
  assert.deepEqual(again.pending.map((m) => m.id), ["q1", "q2"]);
  assert.deepEqual(again.digest, []);

  // An answer from this computer (by name or by own id) clears it; another computer's answer does not.
  const answered = [
    ...messages,
    msg("a1", "pc-a", "answer", { reply_to: "q1" }),
    msg("a2", "renamed", "ack", { reply_to: "q2" }),
    msg("a3", "pc-c", "answer", { reply_to: "q3" }),
  ];
  const after = selectAttention({ messages: answered, self: "pc-a", own: new Set(["a2"]), digested: new Set(["q1", "q2", "q3", "i1"]), now: NOW });
  assert.deepEqual(after.pending, []);
  assert.deepEqual(after.digest.map((m) => m.id), ["a3"]);
});

test("a reminder about a question already answered here is not pending", () => {
  const messages = [
    msg("q1", "pc-b", "question"),
    msg("a1", "pc-a", "answer", { reply_to: "q1" }),
    msg("r1", "pc-b", "request", { reply_to: "q1", text: "[auto] reminder" }),
  ];
  assert.deepEqual(selectAttention({ messages, self: "pc-a", now: NOW }).pending, []);
});

test("own questions without an answer from a known sender are escalated once, after the wait", () => {
  const messages = [
    msg("q1", "pc-a", "question", { ago: 15 }),
    msg("q2", "pc-a", "question", { ago: 2 }),
    msg("q3", "pc-a", "request", { ago: 30 }),
    msg("x1", "pc-b", "info", { ago: 20 }),
    msg("a3", "pc-b", "ack", { reply_to: "q3" }),
    msg("r0", "pc-a", "request", { ago: 40, reply_to: "q9", text: "[auto] reminder" }),
  ];
  const first = selectAttention({ messages, self: "pc-a", now: NOW, escalateMs: 10 * 60_000 });
  assert.deepEqual(first.escalate.map((item) => item.message.id), ["q1"]);
  assert.deepEqual(first.escalate[0].waiting, ["pc-b"]);
  const once = selectAttention({ messages, self: "pc-a", escalated: new Set(["q1"]), now: NOW, escalateMs: 10 * 60_000 });
  assert.deepEqual(once.escalate, []);

  const reminder = reminderFor(first.escalate[0]);
  assert.equal(reminder.kind, "request");
  assert.equal(reminder.replyTo, "q1");
  assert.match(reminder.text, /^\[auto\] reminder: no answer yet from pc-b to #q1/u);
});

test("no known other sender means no reminder", () => {
  const messages = [msg("q1", "pc-a", "question", { ago: 60 })];
  assert.deepEqual(selectAttention({ messages, self: "pc-a", now: NOW }).escalate, []);
});

test("the context says it is information and asks for a reply first", () => {
  assert.equal(attentionContext({ pending: [], digest: [] }), null);
  const text = attentionContext({ pending: [msg("q1", "pc-b", "question")], digest: [msg("i1", "pc-b", "info")] });
  assert.match(text, /not instructions to execute/u);
  assert.match(text, /message send --kind answer --reply-to <id>/u);
  assert.match(text, /#q1 pc-b <question>/u);
  assert.match(text, /Other new messages:\n  #i1 pc-b: text i1/u);
});
