import assert from "node:assert/strict";
import test from "node:test";

import {
  deliveredOverlapPolicy,
  findDeliveredOverlaps,
  sharedWriteRegion,
  unconfirmedDeliveredOverlaps,
  writeScopeRegion,
} from "../../lib/delivered-overlap.mjs";

const A = "a".repeat(64);
const B = "b".repeat(64);

test("a write region is what every requirement scope allows", () => {
  assert.deepEqual(writeScopeRegion([["src", "docs"]]), ["docs", "src"]);
  assert.deepEqual(writeScopeRegion([["src"], ["src/billing", "docs"]]), ["src/billing"]);
  assert.deepEqual(writeScopeRegion([["src/a", "src"]]), ["src"]);
  assert.deepEqual(writeScopeRegion([["."], ["test"]]), ["test"]);
  assert.deepEqual(writeScopeRegion([["src"], ["docs"]]), []);
  assert.deepEqual(writeScopeRegion([]), []);
});

test("two stories share files only where both write regions meet", () => {
  assert.deepEqual(sharedWriteRegion([["src"]], [["src/billing"]]), ["src/billing"]);
  assert.deepEqual(sharedWriteRegion([["src/billing"]], [["src/booking"]]), []);
  assert.deepEqual(sharedWriteRegion([["src/billing.mjs"]], [["src/billing"]]), []);
  assert.deepEqual(sharedWriteRegion([["."]], [["docs/a.md", "src/x"]]), ["docs/a.md", "src/x"]);
});

test("changes other stories merged after this one started are overlaps; seen or own work is not", () => {
  const story = {
    story_id: "ST-2",
    write_scopes: [["src/billing"]],
    context_hashes: { "src/billing/a.mjs": A, "src/api.mjs": A, "README.md": A },
  };
  const delivery = (storyId, sha, changed, extra = {}) => ({
    story_id: storyId,
    delivery_profile_id: `AUT-${storyId}`,
    merge_commit_sha: sha.repeat(40),
    seen: false,
    changed_paths: changed,
    contentSha256: (sourcePath) => (sourcePath === "src/billing/gone.mjs" ? null : B),
    ...extra,
  });
  const { overlaps, unverifiable } = findDeliveredOverlaps(story, [
    delivery("ST-1", "1", ["src/billing/a.mjs", "src/billing/gone.mjs", "src/api.mjs", "docs/other.md"]),
    delivery("ST-0", "0", ["src/billing/a.mjs"], { seen: true }),
    delivery("ST-2", "2", ["src/billing/a.mjs"]),
    delivery("ST-3", "3", undefined),
    delivery("ST-4", "4", ["src/billing/a.mjs"], { seen: undefined }),
  ]);
  assert.deepEqual(overlaps.map((item) => [item.path, item.kind, item.story_id, item.sha256]), [
    ["src/api.mjs", "context", "ST-1", B],
    ["src/billing/a.mjs", "write_scope", "ST-1", B],
    ["src/billing/gone.mjs", "write_scope", "ST-1", null],
  ]);
  assert.deepEqual(unverifiable.map((item) => item.story_id), ["ST-3", "ST-4"]);

  // A review covers exactly the bytes it named: a later change needs a new one.
  const reviewed = [{ overlaps: overlaps.filter((item) => item.kind === "write_scope") }];
  assert.deepEqual(unconfirmedDeliveredOverlaps(overlaps, reviewed).map((item) => item.path), ["src/api.mjs"]);
  const changedAgain = overlaps.map((item) => ({ ...item, sha256: A }));
  assert.equal(unconfirmedDeliveredOverlaps(changedAgain, reviewed).length, 3);
});

test("the overlap policy defaults to confirming write-scope changes and rejects unknown values", () => {
  const invalid = (message) => { throw new Error(message); };
  assert.deepEqual(deliveredOverlapPolicy(undefined, invalid), {
    write_scope: "confirm", context: "warn", confirmation_actor: "any", claim: "warn",
  });
  assert.equal(deliveredOverlapPolicy({ context: "confirm", confirmation_actor: "human" }, invalid).confirmation_actor, "human");
  assert.throws(() => deliveredOverlapPolicy({ write_scope: "block" }, invalid), /write_scope must be one of/u);
  assert.throws(() => deliveredOverlapPolicy([], invalid), /must be an object/u);
});
