import assert from "node:assert/strict";
import test from "node:test";

import { validateAgainstSchema } from "../../lib/json-schema-validator.mjs";

const SCHEMA = "gate-report.schema.json";

function report(overrides = {}) {
  return {
    status: "passed",
    strict: false,
    scope: "all",
    story_id: null,
    release_manifest_id: null,
    checked_at: "2026-01-05T10:00:00Z",
    errors: [],
    warnings: [],
    checked: [],
    ...overrides,
  };
}

test("gate report schema accepts every scope gate check can produce", () => {
  for (const scope of ["story", "all", "release-manifest"]) {
    const result = validateAgainstSchema(report({ scope }), SCHEMA);
    assert.equal(result.valid, true, `${scope}: ${JSON.stringify(result.errors)}`);
  }
  assert.equal(
    validateAgainstSchema(report({ scope: "release-manifest", release_manifest_id: "RELEASE-001" }), SCHEMA).valid,
    true,
  );
});

test("gate report schema rejects an unknown scope and a non-string manifest id", () => {
  assert.equal(validateAgainstSchema(report({ scope: "portfolio" }), SCHEMA).valid, false);
  assert.equal(validateAgainstSchema(report({ release_manifest_id: 7 }), SCHEMA).valid, false);
});
