import assert from "node:assert/strict";
import test from "node:test";

import {
  STORY_STATES,
  applySharedClaims,
  storyState,
  storyStateCounts,
} from "../../ui/change-observatory/insights.js";
import { setLocale, t } from "../../ui/change-observatory/i18n.js";

const story = (id, state) => ({ id, state, iteration: { id }, phases: [] });

test("a parked story and an expired claim get their own states, never an unknown one", () => {
  assert.equal(storyState({ phases: [], parked: { reason: "merge conflict" } }), "parked");
  assert.equal(storyState({ phases: [], claimExpired: { agent: "codex" } }), "abandoned");
  assert.equal(storyState({ phases: [], parked: { reason: "x" }, closure: { event: "cancelled" } }), "stopped");
  const keys = new Set(STORY_STATES.map((state) => state.key));
  for (const key of ["parked", "abandoned", "waiting", "live"]) assert.ok(keys.has(key), key);
});

test("shared claims from other computers: parked, expired claim, expired reservation", () => {
  const stories = applySharedClaims([
    story("ST-1", "open"), story("ST-2", "open"), story("ST-3", "idle"), story("ST-4", "open"), story("ST-5", "delivered"),
  ], [
    { storyId: "ST-1", state: "parked", agent: "codex", reason: "conflict", expired: false },
    { storyId: "ST-2", state: "claimed", agent: "codex", holder: "Antonio, mac", expired: true },
    { storyId: "ST-3", state: "reserved", agent: "codex", expired: true },
    { storyId: "ST-4", state: "claimed", agent: "codex", expired: false },
    { storyId: "ST-5", state: "parked", agent: "codex", expired: false },
  ]);
  assert.deepEqual(stories.map((entry) => entry.state), ["parked", "abandoned", "idle", "live", "delivered"]);
  assert.equal(stories[2].holder, undefined, "an expired reservation holds nothing");
  const counts = storyStateCounts(stories);
  assert.equal(Object.values(counts).reduce((sum, value) => sum + value, 0), stories.length);
  assert.equal(counts.parked, 1);
  assert.equal(counts.abandoned, 1);
});

test("the new state labels read in Italian", () => {
  setLocale("it");
  try {
    assert.equal(t("Parked"), "Parcheggiata");
    assert.equal(t("Needs a decision"), "Da decidere");
  } finally {
    setLocale("en");
  }
});
