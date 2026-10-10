import assert from "node:assert/strict";
import test from "node:test";

import { sharedClaimStoryNotices } from "../../lib/engine/guidance.mjs";

const view = (holder) => ({ holder, problems: [], warnings: [], state: "claimed", here: false });

test("a remote claim on a closed or terminal story is reported as expired, not as active work", () => {
  const holder = { agent: "claude-pc3", branch: "feature/ST-1" };
  for (const state of ["closed", "terminal"]) {
    const story = { id: "ST-1", orchestration_state: state, shared_claim: view(holder) };
    assert.deepEqual(sharedClaimStoryNotices(story, true), ["ST-1: claim scaduto su story chiusa, rilascialo con story release"]);
    assert.match(sharedClaimStoryNotices(story, false)[0], /expired claim on a closed story/u);
  }
});

test("open stories and reservations get no expired-claim notice", () => {
  assert.deepEqual(sharedClaimStoryNotices({ id: "ST-1", orchestration_state: "claimed", shared_claim: view({ agent: "a" }) }, true), []);
  assert.deepEqual(sharedClaimStoryNotices({ id: "ST-1", orchestration_state: "closed", shared_claim: view({ agent: "a", reservation: true }) }, true), []);
});
