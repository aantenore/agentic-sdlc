import assert from "node:assert/strict";
import test from "node:test";

import {
  baselineDeltaEntries,
  computeBaselineDelta,
  explainBaselineDelta,
  pathInsideEveryScope,
  sameBaselineDelta,
} from "../../lib/baseline-refresh.mjs";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

test("the delta lists added, changed, and removed paths in a stable order", () => {
  const delta = computeBaselineDelta(
    { "src/app.mjs": A, "src/old.mjs": B, "README.md": C },
    { "src/app.mjs": B, "src/new.mjs": A, "README.md": C },
  );
  assert.deepEqual(delta, { added: ["src/new.mjs"], changed: ["src/app.mjs"], removed: ["src/old.mjs"] });
  assert.deepEqual(baselineDeltaEntries(delta).map((entry) => entry.change), ["added", "changed", "removed"]);
  assert.equal(sameBaselineDelta(delta, structuredClone(delta)), true);
  assert.equal(sameBaselineDelta(delta, { ...delta, removed: [] }), false);
});

test("a path is in scope only when every requirement scope allows it", () => {
  assert.equal(pathInsideEveryScope("src/a.mjs", [["src"], ["src/a.mjs", "docs"]]), true);
  assert.equal(pathInsideEveryScope("src/a.mjs", [["src"], ["docs"]]), false);
  assert.equal(pathInsideEveryScope("srcx/a.mjs", [["src"]]), false);
  assert.equal(pathInsideEveryScope("src/a.mjs", []), false);
  assert.equal(pathInsideEveryScope("src/a.mjs", [[]]), false);
});

test("a change is explained only by a delivery whose commit holds the exact bytes inside its scope", () => {
  const delta = { added: ["src/new.mjs"], changed: ["src/app.mjs", "README.md"], removed: ["src/old.mjs"] };
  const current = { "src/new.mjs": A, "src/app.mjs": B, "README.md": C };
  const commitContent = { "src/new.mjs": A, "src/app.mjs": A, "README.md": C };
  const evidence = {
    story_id: "ST-1",
    delivery_profile_id: "AUT-1",
    merge_commit_sha: "1".repeat(40),
    write_scopes: [["src"]],
    contentSha256: (sourcePath) => commitContent[sourcePath] ?? null,
  };
  const { explanations, unexplained } = explainBaselineDelta(delta, current, [evidence]);
  assert.deepEqual(explanations.map((item) => [item.path, item.change, item.sha256]), [
    ["src/new.mjs", "added", A],
    ["src/old.mjs", "removed", null],
  ]);
  assert.deepEqual(unexplained, [
    // Edited after the merge: the delivered commit holds other bytes.
    { path: "src/app.mjs", change: "changed" },
    // Outside the delivery's write scope.
    { path: "README.md", change: "changed" },
  ]);

  const unavailable = { ...evidence, contentSha256: () => undefined };
  assert.equal(explainBaselineDelta(delta, current, [unavailable]).explanations.length, 0);
});

test("a started story accepts bytes that another story's merged delivery produced", async () => {
  const { deliveredWorkExplainsSource } = await import("../../lib/engine/baseline-refresh.mjs");
  const evidences = [{
    story_id: "ST-OTHER",
    delivery_profile_id: "AUT-OTHER",
    merge_commit_sha: "2".repeat(40),
    write_scopes: [["src/billing"]],
    contentSha256: (sourcePath) => ({ "src/billing/a.mjs": A })[sourcePath] ?? null,
  }];
  const explains = (storyId, sourcePath, sha256) =>
    deliveredWorkExplainsSource(null, "BASELINE-INITIAL", { storyId, sourcePath, sha256, evidences });
  assert.equal(explains("ST-MINE", "src/billing/a.mjs", A), true);
  assert.equal(explains("ST-MINE", "src/billing/gone.mjs", null), true);
  // Edited after the merge, outside the other story's scope, or its own work.
  assert.equal(explains("ST-MINE", "src/billing/a.mjs", B), false);
  assert.equal(explains("ST-MINE", "src/app.mjs", null), false);
  assert.equal(explains("ST-OTHER", "src/billing/a.mjs", A), false);
});

test("each delivery reads every delta path inside its scope at once, newest delivery first", () => {
  const delta = { added: ["src/a.mjs", "src/b.mjs"], changed: ["docs/c.md"], removed: [] };
  const current = { "src/a.mjs": A, "src/b.mjs": B, "docs/c.md": C };
  const prefetches = [];
  const delivery = (storyId, content) => {
    const cache = new Map();
    return {
      story_id: storyId,
      delivery_profile_id: `AUT-${storyId}`,
      merge_commit_sha: "3".repeat(40),
      write_scopes: [["src"]],
      prefetch: (paths) => {
        prefetches.push([storyId, paths]);
        for (const sourcePath of paths) cache.set(sourcePath, content[sourcePath] ?? null);
      },
      contentSha256: (sourcePath) => {
        assert.equal(cache.has(sourcePath), true, `${sourcePath} was read before its batch`);
        return cache.get(sourcePath);
      },
    };
  };
  const { explanations, unexplained } = explainBaselineDelta(delta, current, [
    delivery("ST-NEW", { "src/a.mjs": A, "src/b.mjs": B }),
    delivery("ST-OLD", { "src/a.mjs": C }),
  ]);
  assert.deepEqual(explanations.map((item) => [item.path, item.story_id]), [["src/a.mjs", "ST-NEW"], ["src/b.mjs", "ST-NEW"]]);
  assert.deepEqual(unexplained, [{ path: "docs/c.md", change: "changed" }]);
  // The newest delivery explains everything, so the older one is never read.
  assert.deepEqual(prefetches, [["ST-NEW", ["src/a.mjs", "src/b.mjs"]]]);
});
