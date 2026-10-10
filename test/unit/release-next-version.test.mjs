import test from "node:test";
import assert from "node:assert/strict";
import { computeNextVersion } from "../../scripts/release.mjs";

test("next version is minor+1 of the max between main and tags", () => {
  assert.equal(computeNextVersion("0.68.0", ["v0.9.0", "v0.67.1"]), "0.69.0");
  assert.equal(computeNextVersion("0.68.0", ["v0.70.2"]), "0.71.0");
  assert.equal(computeNextVersion("1.2.3", []), "1.3.0");
});
