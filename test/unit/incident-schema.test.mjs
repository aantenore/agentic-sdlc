import assert from "node:assert/strict";
import test from "node:test";

import { validateAgainstSchema } from "../../lib/json-schema-validator.mjs";

const SCHEMA = "incident.schema.json";

function passingRecord(overrides = {}) {
  return {
    kind: "incident",
    schema_version: "incident:v1",
    id: "ST-001-incident-1",
    story_id: "ST-001",
    release_manifest_id: "RELEASE-ASSESS-001",
    phase: "operations",
    severity: "sev2",
    detected_at: "2026-09-16T10:00:00.000Z",
    resolved_at: "2026-09-16T10:20:00.000Z",
    summary: "Checkout latency spike",
    impact: "5% of checkouts timed out for 20 minutes",
    actions: ["Rolled back the checkout service"],
    requirement_ids: ["REQ-001"],
    actor: { id: "maria", type: "human" },
    git: { branch: "main" },
    run: { tool: "agentic-sdlc" },
    created_at: "2026-09-16T10:20:00.000Z",
    audit: { created_by: { id: "maria", type: "human" } },
    record_hash: "b".repeat(64),
    hash_algorithm: "sha256:stable-json:v1",
    ...overrides,
  };
}

function errorKeywords(record) {
  return validateAgainstSchema(record, SCHEMA).errors.map((error) => error.keyword);
}

test("a complete incident record satisfies its contract", () => {
  const result = validateAgainstSchema(passingRecord(), SCHEMA);
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

test("an open incident may record a null resolved_at", () => {
  const result = validateAgainstSchema(passingRecord({ resolved_at: null }), SCHEMA);
  assert.equal(result.valid, true);
});

test("the record binds a story and a release manifest", () => {
  for (const field of ["story_id", "release_manifest_id"]) {
    const record = passingRecord();
    delete record[field];
    assert.equal(validateAgainstSchema(record, SCHEMA).valid, false, `${field} must be required`);
  }
  assert.equal(errorKeywords(passingRecord({ story_id: "" })).includes("minLength"), true);
  assert.equal(errorKeywords(passingRecord({ release_manifest_id: "" })).includes("minLength"), true);
});

test("severity is restricted to the four declared levels", () => {
  assert.equal(errorKeywords(passingRecord({ severity: "sev5" })).includes("enum"), true);
  for (const severity of ["sev1", "sev2", "sev3", "sev4"]) {
    assert.equal(validateAgainstSchema(passingRecord({ severity }), SCHEMA).valid, true);
  }
});

test("the record refuses undeclared fields and a mistyped kind or schema_version", () => {
  assert.equal(errorKeywords(passingRecord({ asserted_by_agent: true })).includes("additionalProperties"), true);
  assert.equal(errorKeywords(passingRecord({ kind: "incident_record" })).includes("const"), true);
  assert.equal(errorKeywords(passingRecord({ schema_version: "incident:v2" })).includes("const"), true);
});

test("timestamps, summary, and impact are mandatory", () => {
  for (const field of ["id", "detected_at", "resolved_at", "summary", "impact", "actions"]) {
    const record = passingRecord();
    delete record[field];
    assert.equal(validateAgainstSchema(record, SCHEMA).valid, false, `${field} must be required`);
  }
  assert.equal(errorKeywords(passingRecord({ detected_at: "16/09/2026" })).includes("format"), true);
});
