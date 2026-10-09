import assert from "node:assert/strict";
import test from "node:test";

import {
  groupRemoteWork,
  relativeAgeText,
  remoteWorkPolicy,
  storiesNamedBy,
  unclaimedRemoteWorkLines,
} from "../../lib/remote-work.mjs";

const NOW = Date.parse("2026-10-09T12:00:00.000Z");

test("a branch or title names a story only as a whole id, and the longest id wins", () => {
  const ids = ["ST-1", "ST-10", "ST-1-2", "ST-REPLAN-002"];
  assert.deepEqual(storiesNamedBy("feature/ST-1", ids), ["ST-1"]);
  assert.deepEqual(storiesNamedBy("feature/st-10-login", ids), ["ST-10"]);
  assert.deepEqual(storiesNamedBy("feature/ST-1-2", ids), ["ST-1-2"]);
  assert.deepEqual(storiesNamedBy("ST-REPLAN-002: retry", ids), ["ST-REPLAN-002"]);
  assert.deepEqual(storiesNamedBy("feature/XST-1", ids), []);
});

test("only branches with work beyond the base, recent enough, are grouped under unheld stories", () => {
  const branches = [
    { branch: "feature/ST-1", last_commit_at: "2026-10-09T11:40:00.000Z", ahead_of_base: 2 },
    { branch: "feature/ST-2", last_commit_at: "2026-10-09T11:40:00.000Z", ahead_of_base: 0 },
    { branch: "old/ST-3", last_commit_at: "2026-01-01T00:00:00.000Z", ahead_of_base: 4 },
    { branch: "feature/ST-4", last_commit_at: "2026-10-09T11:00:00.000Z", ahead_of_base: 1 },
  ];
  const pullRequests = [{ number: 7, url: "https://example.invalid/pr/7", title: "ST-3 replan", head_branch: "x", updated_at: null }];
  const items = groupRemoteWork(["ST-1", "ST-2", "ST-3"], ["ST-4"], { branches, pullRequests, nowMs: NOW, recentWithinSeconds: 86_400 });
  assert.deepEqual(items.map((item) => [item.story_id, item.branches.length, item.pull_requests.length]), [["ST-1", 1, 0], ["ST-3", 0, 1]]);
});

test("the warning is plain language in both languages", () => {
  const items = [{ story_id: "ST-REPLAN-002", branches: [{ branch: "feature/ST-REPLAN-002", last_commit_at: "2026-10-09T11:40:00.000Z" }], pull_requests: [] }];
  assert.match(unclaimedRemoteWorkLines(items, { nowMs: NOW, italian: true })[0],
    /^ST-REPLAN-002 non è prenotata ma sul remote c'è il branch feature\/ST-REPLAN-002 aggiornato 20 minuti fa: forse qualcuno ci sta già lavorando\./u);
  assert.match(unclaimedRemoteWorkLines(items, { nowMs: NOW })[0], /updated 20 minutes ago: someone may already be working on it/u);
  assert.equal(relativeAgeText("2026-10-09T09:00:00.000Z", NOW), "3 hours ago");
  assert.equal(relativeAgeText("bad", NOW, { italian: true }), "in un momento non noto");
});

test("the policy defaults to git only and rejects unknown values", () => {
  assert.deepEqual(remoteWorkPolicy(undefined, () => {}), { mode: "git", pull_requests: "off", recent_within_seconds: null });
  const invalid = (message) => { throw new Error(message); };
  assert.throws(() => remoteWorkPolicy({ pull_requests: "gitlab" }, invalid), /pull_requests/u);
  assert.throws(() => remoteWorkPolicy([], invalid), /must be an object/u);
});
