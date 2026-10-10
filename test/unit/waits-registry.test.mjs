import { createBareOrigin, createFixtureDir } from "../helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  activeFreeze,
  applyWaitMemory,
  deriveApprovalWaits,
  deriveDependencyWaits,
  deriveFreezeWaits,
  deriveQuestionWaits,
  freezeUntil,
  planWaitActions,
  resolveWaitsPolicy,
  waitSnapshot,
  waitStatusLines,
} from "../../lib/waits-registry.mjs";
import { decideKeepGoing } from "../../lib/host-hooks/keep-going.mjs";
import { runWatch } from "../../lib/host-hooks/watch.mjs";
import { refSegment, segmentId, waitAdd, waitList, waitResolve } from "../../lib/engine/wait-registry.mjs";

const NOW = Date.parse("2026-10-10T12:00:00Z");
const at = (minutesAgo) => new Date(NOW - minutesAgo * 60_000).toISOString();
const policy = resolveWaitsPolicy(null);

test("dependency: open while the target is not merged, resolved and ready once it is", () => {
  const edges = [{ from: "ST-2", to: "ST-1", type: "depends_on" }, { from: "ST-3", to: "ST-1", type: "relates" }];
  const open = deriveDependencyWaits({ edges, isDone: () => false });
  assert.deepEqual(open.map((item) => [item.id, item.state, item.waiter.story, item.blocker.type, item.blocker.ref]), [["dep:ST-2->ST-1", "open", "ST-2", "story", "ST-1"]]);
  assert.deepEqual(planWaitActions(open, { now: NOW, policy }).suggestions, []);
  const merged = deriveDependencyWaits({ edges, isDone: (id) => id === "ST-1" });
  assert.equal(merged[0].state, "resolved");
  const { suggestions } = planWaitActions(merged, { now: NOW, policy });
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].ready, "ST-2");
  assert.match(suggestions[0].command, /story claim --id ST-2/u);
  // The waiting story done: nothing left.
  assert.deepEqual(deriveDependencyWaits({ edges, isDone: () => true }), []);
});

test("unanswered own question: after 10 minutes the rule suggests deciding and recording the decision", () => {
  const names = new Set(["pc1"]);
  const messages = [
    { id: "q1", from: "pc1", host: "pc1", kind: "question", text: "JSON o YAML?", time: at(12) },
    { id: "q2", from: "pc1", host: "pc1", kind: "question", text: "Chi rivede?", time: at(3) },
    { id: "x", from: "pc2", host: "pc2", kind: "info", text: "ciao", time: at(20) },
  ];
  const waits = deriveQuestionWaits({ messages, names, now: NOW, policy });
  assert.deepEqual(waits.map((item) => [item.id, item.state, item.mine]), [["q:q1", "expired", true], ["q:q2", "open", true]]);
  const { suggestions } = planWaitActions(waits, { now: NOW, policy });
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].wait_id, "q:q1");
  assert.match(suggestions[0].text, /decidi, annuncia la decisione e procedi/u);
  assert.match(suggestions[0].command, /wait resolve --id q:q1 --resolution/u);
  // The decision recorded as the resolution closes the wait.
  const resolved = applyWaitMemory(waits, { resolutions: new Map([["q:q1", { resolution: "JSON" }]]) });
  assert.equal(resolved[0].state, "resolved");
  assert.equal(resolved[0].resolution, "JSON");
  assert.deepEqual(planWaitActions(resolved, { now: NOW, policy }).suggestions, []);
  // Answered by the other computer: no wait at all.
  assert.deepEqual(deriveQuestionWaits({ messages: [...messages, { id: "a", from: "pc2", host: "pc2", kind: "answer", reply_to: "q1", time: at(1) }], names, now: NOW, policy }).map((item) => item.id), ["q:q2"]);
});

test("freeze: explicit --kind freeze and the text form; it suspends publish-records and expires", () => {
  assert.equal(freezeUntil({ kind: "freeze", until: "2026-10-10T12:30:00Z", time: at(5) }, policy), Date.parse("2026-10-10T12:30:00Z"));
  assert.equal(freezeUntil({ kind: "info", text: "Rilascio: 20 minuti senza merge/push su main", time: at(5) }, policy), NOW + 15 * 60_000);
  assert.equal(freezeUntil({ kind: "info", text: "nessun freeze", time: at(5) }, policy), null);
  const messages = [{ id: "f1", from: "pc2", kind: "freeze", until: "2026-10-10T12:30:00Z", text: "release", time: at(5) }];
  const during = deriveFreezeWaits({ messages, now: NOW, policy });
  const freeze = activeFreeze(during, NOW);
  assert.equal(freeze.id, "freeze:f1");
  const unpublished = [{ storyId: "ST-1", base: "origin/main", files: ["a", "b"], command: "agentic-sdlc story publish-records --id ST-1 --to-base" }];
  const blocked = decideKeepGoing({ unpublished, waits: { list: during, suggestions: [], freeze }, now: NOW });
  assert.equal(blocked.block, false, "no publish request during the freeze");
  assert.match(blocked.note, /sospesi fino alla fine del freeze/u);
  const later = NOW + 31 * 60_000;
  const after = deriveFreezeWaits({ messages, now: later, policy });
  assert.equal(after[0].state, "expired");
  assert.equal(activeFreeze(after, later), null);
  const { suggestions } = planWaitActions(after, { now: later, policy });
  assert.match(suggestions[0].text, /freeze .* finito: riprendi le azioni sospese/u);
  const resumed = decideKeepGoing({ unpublished, waits: { list: after, suggestions, freeze: null }, now: later });
  assert.equal(resumed.block, true);
  assert.match(resumed.reason, /publish-records --id ST-1/u);
});

test("approval: one message to the person with the exact command, then escalated and never repeated", () => {
  const waits = deriveApprovalWaits([{ id: "approve-breakdown-BRK-1", subject_id: "BRK-1", summary: "Work breakdown (BRK-1) is proposed", suggested_command: "agentic-sdlc breakdown approve --id BRK-1 --actor-type human" }]);
  const first = planWaitActions(waits, { now: NOW, policy, memory: {} });
  assert.equal(first.messages.length, 1);
  assert.match(first.messages[0].text, /breakdown approve --id BRK-1/u);
  const marked = applyWaitMemory(waits, { memory: first.memory });
  assert.equal(marked[0].state, "escalated");
  const second = planWaitActions(marked, { now: NOW + 3_600_000, policy, memory: first.memory });
  assert.equal(second.messages.length, 0);
  // Escalated waits on a person never block keep-going: they are only noted.
  const decision = decideKeepGoing({ waits: { list: marked, suggestions: [], freeze: null }, now: NOW });
  assert.equal(decision.block, false);
  assert.match(decision.note, /persona gia' avvisata/u);
  assert.match(waitStatusLines(marked, { now: NOW }).join("\n"), /^In attesa di:\n {2}questo computer:\n {4}- approvazione umana di BRK-1/u);
});

test("watch wakes up when a wait expires", async () => {
  const root = createFixtureDir();
  const open = { id: "WAIT-1", source: "explicit", waiter: { host: "pc1", story: null }, blocker: { type: "pr", ref: "12" }, since: at(10), until: at(-1), state: "open" };
  let clock = NOW;
  let scans = 0;
  const context = {
    provider: null,
    scanStories: null,
    label: (id) => id,
    scanWaits: async () => {
      scans += 1;
      return [{ ...open, state: clock >= NOW + 60_000 ? "expired" : "open" }];
    },
  };
  const result = await runWatch(root, { env: {}, timeout: "10m", context, now: () => clock, sleep: async (ms) => { clock += ms; } });
  assert.equal(result.status, "event");
  assert.ok(scans >= 2, "the first scan is the baseline");
  assert.deepEqual(result.events, [{ type: "wait", id: "WAIT-1", state: "expired", story: null }]);
  assert.match(result.summary, /attesa scaduta: la PR 12/u);
  assert.deepEqual(waitSnapshot([open]), { "WAIT-1": "open" });
});

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: process.env }).trim();
}

function clone(dir) {
  git(dir, ["init", "--quiet", "--initial-branch=main"]);
  fs.mkdirSync(path.join(dir, ".sdlc"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".sdlc", "config.json"), "{}\n");
  return dir;
}

async function quiet(run) {
  const log = console.log;
  console.log = () => {};
  try {
    return await run();
  } finally {
    console.log = log;
  }
}

test("explicit waits: add on one clone, list and resolve from another through shared refs", async () => {
  assert.equal(segmentId(refSegment("dep:ST-1->ST_2")), "dep:ST-1->ST_2");
  const a = clone(createFixtureDir());
  const bare = createBareOrigin(a);
  const b = clone(createFixtureDir());
  git(b, ["remote", "add", "origin", bare]);
  const env = { AGENTIC_SDLC_HOST_LABEL: "pc-a", AGENTIC_SDLC_WAIT_RULES: "off" };
  const added = await quiet(() => waitAdd({ root: a, on: "person:Antonio", until: "1h", story: "ST-7", reason: "scelta del layout", json: true }, env));
  assert.equal(added.shared.status, "shared");
  assert.match(git(bare, ["for-each-ref", "--format=%(refname)", "refs/agentic-sdlc/wait-registry"]), new RegExp(`${added.id}/open`, "u"));
  assert.equal(git(a, ["branch", "--list"]), "", "no branch is touched");
  const listed = await quiet(() => waitList({ root: b, json: true }, { AGENTIC_SDLC_HOST_LABEL: "pc-b" }));
  const seen = listed.waits.find((item) => item.id === added.id);
  assert.deepEqual([seen.state, seen.waiter.story, seen.blocker.type, seen.blocker.ref], ["open", "ST-7", "person", "Antonio"]);
  const resolved = await quiet(() => waitResolve({ root: b, id: added.id, resolution: "layout a due colonne", json: true }, { AGENTIC_SDLC_HOST_LABEL: "pc-b" }));
  assert.equal(resolved.status, "resolved");
  const again = await quiet(() => waitResolve({ root: a, id: added.id, resolution: "altro", json: true }, env));
  assert.equal(again.status, "already_resolved", "the first resolution wins");
  const open = await quiet(() => waitList({ root: a, json: true }, env));
  assert.equal(open.waits.some((item) => item.id === added.id), false);
  const all = await quiet(() => waitList({ root: a, all: true, json: true }, env));
  const closed = all.waits.find((item) => item.id === added.id);
  assert.deepEqual([closed.state, closed.resolution], ["resolved", "layout a due colonne"]);
  await assert.rejects(() => waitAdd({ root: a, on: "nothing:x" }, env), /--on must be <type>:<ref>/u);
});

test("message send --kind freeze --until: the end as an ISO time, only for that kind", async () => {
  const { freezeUntilOption } = await import("../../lib/messaging/commands.mjs");
  assert.equal(freezeUntilOption("freeze", "30m", NOW), new Date(NOW + 30 * 60_000).toISOString());
  assert.equal(freezeUntilOption("info", undefined, NOW), null);
  assert.throws(() => freezeUntilOption("info", "30m", NOW), /only for --kind freeze/u);
  assert.throws(() => freezeUntilOption("freeze", undefined, NOW), /needs --until/u);
});
