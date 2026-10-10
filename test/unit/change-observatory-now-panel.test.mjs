import assert from "node:assert/strict";
import test from "node:test";

import { buildNowModel, createMessagingSnapshot } from "../../lib/change-observatory/now-panel.mjs";

const NOW = Date.parse("2026-10-10T12:00:00Z");
const at = (minutesAgo) => new Date(NOW - minutesAgo * 60_000).toISOString();

const CLAIMS = [
  { storyId: "ST-2", state: "claimed", agent: "codex", holder: "Antonio, mac", branch: "feature/ST-2", claimedAt: at(90), health: "active" },
  { storyId: "ST-1", state: "parked", agent: "claude", branch: "feature/ST-1", claimedAt: at(300) },
  { storyId: "ST-0", state: "completed", completion: "delivered" },
];

const MESSAGES = [
  { id: "m1", from: "mac", kind: "info", text: "[auto] stato: ST-2 in fase build da 5 min", time: at(20) },
  { id: "m2", from: "pc-b", kind: "question", text: "Chi prende ST-3?", time: at(15) },
  { id: "m3", from: "pc-c", kind: "info", text: "[auto] stato: ST-9 in fase test", time: at(60) },
  { id: "m4", from: "pc-c", kind: "offer", text: "[auto] libero: posso prendere lavoro o aiutare", time: at(10) },
  { id: "m5", from: "mac", kind: "answer", reply_to: "m2", text: "io", time: at(5) },
  { id: "m6", from: "mac", kind: "request", to: "pc-b", text: "Rivedi la PR", time: at(4) },
];

test("active claims become work rows with their workflow phase; completed ones are left out", () => {
  const model = buildNowModel({
    claims: CLAIMS,
    phases: new Map([["ST-2", { phase: "build", since: at(5) }]]),
    nowMs: NOW,
  });
  assert.equal(model.messaging, "off");
  assert.deepEqual(model.work.map((row) => row.storyId), ["ST-1", "ST-2"]);
  const st2 = model.work[1];
  assert.equal(st2.who, "Antonio, mac");
  assert.equal(st2.branch, "feature/ST-2");
  assert.equal(st2.phase, "build");
  assert.equal(st2.since, at(90));
  assert.equal(model.work[0].state, "parked");
  assert.equal(model.work[0].phase, null);
  assert.deepEqual([model.senders, model.open, model.free], [[], [], []]);
});

test("messages give the latest status per sender, open questions and free computers", () => {
  const model = buildNowModel({ claims: CLAIMS, messages: MESSAGES.slice().reverse(), messaging: "on", nowMs: NOW });
  const mac = model.senders.find((sender) => sender.from === "mac");
  assert.match(mac.status.text, /ST-2 in fase build/u);
  assert.equal(mac.last.text, "Rivedi la PR");
  assert.equal(model.senders[0].from, "mac", "most recent sender first");
  assert.deepEqual(model.free, [{ from: "pc-c", time: at(10) }]);
  // m2 waits on pc-c (mac answered); m6 waits on pc-b.
  assert.deepEqual(model.open.map((item) => [item.id, item.waitingOn]), [["m6", ["pc-b"]], ["m2", ["pc-c"]]]);
});

test("a status after an offer means the computer is busy again", () => {
  const model = buildNowModel({
    messages: [
      { id: "a", from: "pc-c", kind: "offer", text: "[auto] libero", time: at(30) },
      { id: "b", from: "pc-c", kind: "info", text: "[auto] stato: ST-4", time: at(1) },
    ],
    messaging: "on",
    nowMs: NOW,
  });
  assert.deepEqual(model.free, []);
});

test("the messaging snapshot is skipped when messaging is off and cached otherwise", async () => {
  const off = createMessagingSnapshot("/nonexistent", { env: { AGENTIC_SDLC_MESSAGING: "off" } });
  assert.deepEqual(await off.read(), { messaging: "off", messages: null });

  let polls = 0;
  let clock = 0;
  const providers = { ntfy: () => ({ poll: async () => { polls += 1; return [MESSAGES[0]]; } }) };
  const env = { AGENTIC_SDLC_MESSAGING_TOPIC: "topic_test" };
  const on = createMessagingSnapshot(process.cwd(), { env, providers, clock: () => clock });
  assert.equal((await on.read()).messaging, "on");
  await on.read();
  assert.equal(polls, 1, "served from cache");
  clock = 60_000;
  await on.read();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(polls, 2, "refreshed in background once stale");

  const failing = createMessagingSnapshot(process.cwd(), {
    env,
    providers: { ntfy: () => ({ poll: async () => { throw new Error("down"); } }) },
  });
  assert.deepEqual(await failing.read(), { messaging: "unavailable", messages: null });
});
