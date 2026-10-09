import assert from "node:assert/strict";
import test from "node:test";

import {
  findMergedStories,
  mergeDriftPolicy,
  subjectNamesStory,
} from "../../lib/merge-drift.mjs";

const invalid = (message) => {
  throw new Error(message);
};

test("merge drift is on by default and validates its values", () => {
  assert.deepEqual(mergeDriftPolicy(undefined, invalid), { mode: "git", base_branch: null, match_commit_subject: true, max_commits_scanned: 500, open_state: "merged_open" });
  assert.deepEqual(mergeDriftPolicy({ mode: "off", base_branch: "release/2.x", max_commits_scanned: 50 }, invalid), {
    mode: "off", base_branch: "release/2.x", match_commit_subject: true, max_commits_scanned: 50, open_state: "merged_open",
  });
  for (const value of ["git", { mode: "provider" }, { base_branch: "a..b" }, { match_commit_subject: 1 }, { max_commits_scanned: 1.5 }, { open_state: "closed" }]) {
    assert.throws(() => mergeDriftPolicy(value, invalid), /orchestration_policy\.merge_drift/u, JSON.stringify(value));
  }
});

test("a commit subject names a story only as a whole id, and a revert never counts", () => {
  assert.equal(subjectNamesStory("feat(replan-001): ST-REPLAN-001", "ST-REPLAN-001"), true);
  assert.equal(subjectNamesStory("Merge pull request #3 from org/feature/ST-REPLAN-001", "ST-REPLAN-001"), true);
  assert.equal(subjectNamesStory("ST-FOUND-0010: next story", "ST-FOUND-001"), false);
  assert.equal(subjectNamesStory("XST-FOUND-001 done", "ST-FOUND-001"), false);
  assert.equal(subjectNamesStory("Revert \"ST-FOUND-001: login\"", "ST-FOUND-001"), false);
  assert.equal(subjectNamesStory("st-found-001 lower case", "ST-FOUND-001"), true);
  assert.equal(subjectNamesStory("ST.1 dotted", "ST.1"), true);
  assert.equal(subjectNamesStory("STX1 dotted", "ST.1"), false);
});

test("the newest delivering commit is found by merged branch or by subject", () => {
  const commits = [
    { sha: "c3", parents: ["c2", "tip-b"], subject: "Merge custom message" },
    { sha: "c2", parents: ["c1"], subject: "feat: ST-A part two" },
    { sha: "c1", parents: ["c0"], subject: "feat: ST-A part one" },
  ];
  const tips = new Map([["ST-B", [{ branch: "feature/ST-B", sha: "tip-b" }]]]);
  assert.deepEqual(findMergedStories(["ST-A", "ST-B", "ST-C"], commits, tips), [
    { story_id: "ST-A", commit: "c2", subject: "feat: ST-A part two", evidence: "commit_subject", branch: null },
    { story_id: "ST-B", commit: "c3", subject: "Merge custom message", evidence: "merged_branch", branch: "feature/ST-B" },
  ]);
  assert.deepEqual(findMergedStories(["ST-A"], commits, new Map(), { matchCommitSubject: false }), []);
});
