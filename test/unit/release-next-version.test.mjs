import test from "node:test";
import assert from "node:assert/strict";
import { computeNextVersion, hasVersionCommit, isMergedState } from "../../scripts/release.mjs";

test("next version is minor+1 of the max between main and tags", () => {
  assert.equal(computeNextVersion("0.68.0", ["v0.9.0", "v0.67.1"]), "0.69.0");
  assert.equal(computeNextVersion("0.68.0", ["v0.70.2"]), "0.71.0");
  assert.equal(computeNextVersion("1.2.3", []), "1.3.0");
});

test("detects an existing version bump commit on the branch", () => {
  assert.equal(hasVersionCommit("Fix\nVersione 0.81.0", "0.81.0"), true);
  assert.equal(hasVersionCommit("Versione 0.80.0\nFix", "0.81.0"), false);
  assert.equal(hasVersionCommit("", "0.81.0"), false);
});

test("recognizes a merged PR from gh view output", () => {
  assert.equal(isMergedState('{"state":"MERGED","mergeCommit":{"oid":"abc"}}'), true);
  assert.equal(isMergedState('{"state":"OPEN","mergeCommit":null}'), false);
  assert.equal(isMergedState("not json"), false);
});
