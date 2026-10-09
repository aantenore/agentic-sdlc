import assert from "node:assert/strict";
import test from "node:test";

import { mergedBranchFromSubject } from "../../lib/merge-drift.mjs";
import {
  classifyStoryRecordPath,
  missingStoryRecords,
  storyRecordsPolicy,
} from "../../lib/story-records.mjs";

const invalid = (message) => {
  throw new Error(message);
};

test("story records travel on the story branch by default and the policy validates its values", () => {
  assert.deepEqual(storyRecordsPolicy(undefined, invalid), { in_branch: "include", before_pull_request: "warn", publish_branch_prefix: "sdlc-records/" });
  assert.equal(storyRecordsPolicy({ before_pull_request: "refuse" }, invalid).before_pull_request, "refuse");
  for (const value of ["yes", { in_branch: "all" }, { before_pull_request: "block" }, { publish_branch_prefix: "../x" }]) {
    assert.throws(() => storyRecordsPolicy(value, invalid), /orchestration_policy\.story_records/u, JSON.stringify(value));
  }
});

test("a record path is the story's own, shared, another story's, or never carried", () => {
  const options = { storyId: "ST-1", storyIds: ["ST-1", "ST-10", "ST-1-A", "ST-2"] };
  assert.equal(classifyStoryRecordPath("src/a.mjs", options), null);
  assert.equal(classifyStoryRecordPath(".sdlc/config.json", options), "excluded");
  assert.equal(classifyStoryRecordPath(".sdlc/cache/kb-cache.json", options), "excluded");
  assert.equal(classifyStoryRecordPath(".sdlc/stories/ST-1/claim.json", options), "own");
  assert.equal(classifyStoryRecordPath(".sdlc/gates/ST-1-final.json", options), "own");
  assert.equal(classifyStoryRecordPath(".sdlc/contracts/contract-ST-1-design.json", options), "own");
  assert.equal(classifyStoryRecordPath(".sdlc/output-contracts/registry.json", options), "shared");
  assert.equal(classifyStoryRecordPath(".sdlc/stories/ST-10/story.json", options), "other_story");
  assert.equal(classifyStoryRecordPath(".sdlc/stories/ST-2/claim.json", options), "other_story");
  assert.equal(classifyStoryRecordPath(".sdlc/stories/ST-1-A/story.json", { ...options, storyId: "ST-1-A" }), "own");
});

test("a pull request lacks its story's records until it carries the claim and a completed step", () => {
  assert.deepEqual(missingStoryRecords([".sdlc/stories/ST-1/story.json"], { storyId: "ST-1" }), [
    ".sdlc/stories/ST-1/claim.json",
    ".sdlc/stories/ST-1/steps/",
  ]);
  assert.deepEqual(missingStoryRecords([".sdlc/stories/ST-1/claim.json", ".sdlc/stories/ST-1/steps/design.json"], { storyId: "ST-1" }), []);
});

test("the branch a merge commit brought in is read from its subject", () => {
  assert.equal(mergedBranchFromSubject("Merge pull request #12 from travelops/feature/ST-CAT-001"), "feature/ST-CAT-001");
  assert.equal(mergedBranchFromSubject("Merge branch 'feature/ST-1' into main"), "feature/ST-1");
  assert.equal(mergedBranchFromSubject("feat: catalog"), null);
});
