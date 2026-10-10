import assert from "node:assert/strict";
import test from "node:test";

import { shouldDependencyBlockStory } from "../../lib/engine/storage.mjs";

// A receipt check validates its story at the certified workflow phase it
// already knows; the story's lifecycle projection (which verifies that same
// receipt) is never asked, so the context here has nothing to project from.
const story = { id: "ST-A" };

test("a known phase decides whether a dependency edge blocks, without a lifecycle lookup", () => {
  const edge = { blocks: "implementation" };
  assert.equal(shouldDependencyBlockStory({}, edge, story, "release"), true);
  assert.equal(shouldDependencyBlockStory({}, edge, story, "implementation"), true);
  assert.equal(shouldDependencyBlockStory({}, edge, story, "Design"), false);
});

test("an edge that blocks nothing, or no story, always counts as blocking", () => {
  assert.equal(shouldDependencyBlockStory({}, { blocks: "none" }, story, "discovery"), true);
  assert.equal(shouldDependencyBlockStory({}, { blocks: "release" }, null, "discovery"), true);
});
