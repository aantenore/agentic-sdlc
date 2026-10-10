import assert from "node:assert/strict";
import test from "node:test";

import { decideKeepGoing, MAX_IDENTICAL_BLOCKS, nextStoryStep, pendingQuestions } from "../../lib/host-hooks/keep-going.mjs";

const claim = { storyId: "ST-1", next: nextStoryStep({ storyId: "ST-1", completedSteps: ["discovery", "analysis", "design", "implementation"] }) };

test("next step follows the lifecycle, then the strict gate", () => {
  assert.match(claim.next.command, /complete-step --id ST-1 --step validation/u);
  const all = ["discovery", "analysis", "design", "implementation", "validation", "release", "operations"];
  assert.match(nextStoryStep({ storyId: "ST-1", completedSteps: all }).command, /gate check --story ST-1 .*--strict --lifecycle-complete/u);
});

test("blocks with the next step while there is work, stays silent without work", () => {
  const blocked = decideKeepGoing({ claims: [claim] });
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /ST-1/u);
  assert.equal(decideKeepGoing({}).block, false);
  assert.equal(decideKeepGoing({ claims: [claim], disabled: true }).block, false);
});

test("human decisions never block, they are only mentioned", () => {
  const result = decideKeepGoing({ human: ["claim di ST-2 scaduta"] });
  assert.equal(result.block, false);
  assert.match(result.note, /ST-2/u);
});

test("available stories only when no claim or question", () => {
  assert.match(decideKeepGoing({ available: ["ST-3"] }).reason, /ST-3/u);
  assert.doesNotMatch(decideKeepGoing({ claims: [claim], available: ["ST-3"] }).reason, /ST-3/u);
});

test("allows the stop after identical consecutive blocks", () => {
  let state = {};
  const blocks = [];
  for (let index = 0; index < MAX_IDENTICAL_BLOCKS + 1; index += 1) {
    const result = decideKeepGoing({ claims: [claim], previous: state, stopHookActive: index > 0 });
    blocks.push(result.block);
    state = result.state;
  }
  assert.deepEqual(blocks, [...Array(MAX_IDENTICAL_BLOCKS).fill(true), false]);
  assert.equal(decideKeepGoing({ claims: [claim], previous: state, stopHookActive: false }).block, true);
});

test("pending questions are those to this computer not yet answered", () => {
  const state = { own: [], attention: { window: [
    { id: "a", kind: "question", from: "pc-2", text: "pronto?" },
    { id: "b", kind: "question", from: "pc-2", to: "pc-3", text: "altro" },
    { id: "c", kind: "request", from: "pc-2", text: "fatto" },
    { id: "d", kind: "answer", from: "pc-1", reply_to: "c" },
  ] } };
  assert.deepEqual(pendingQuestions(state, "pc-1").map((q) => q.id), ["a"]);
});
