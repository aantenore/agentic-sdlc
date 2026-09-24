import assert from "node:assert/strict";
import test from "node:test";

import { validateAgainstSchema } from "../../lib/json-schema-validator.mjs";

const SCHEMA = "feedback.schema.json";

function passingRecord(overrides = {}) {
  return {
    kind: "feedback",
    schema_version: "feedback:v1",
    id: "ST-001-feedback-1",
    story_id: "ST-001",
    release_manifest_id: "RELEASE-ASSESS-001",
    phase: "operations",
    source: "monitoring",
    sentiment: "negative",
    summary: "Error rate rose after release",
    requirement_ids: ["REQ-001"],
    evidence: [
      { path: ".sdlc/operations/dashboard-snapshot.png", size_bytes: 480, sha256: "a".repeat(64) },
    ],
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

test("a complete feedback record satisfies its contract", () => {
  const result = validateAgainstSchema(passingRecord(), SCHEMA);
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

test("feedback with no separate evidence file may record an empty evidence list", () => {
  const result = validateAgainstSchema(passingRecord({ evidence: [] }), SCHEMA);
  assert.equal(result.valid, true);
});

test("sentiment may be null when not applicable", () => {
  const result = validateAgainstSchema(passingRecord({ sentiment: null }), SCHEMA);
  assert.equal(result.valid, true);
});

test("the record binds a story and a release manifest", () => {
  for (const field of ["story_id", "release_manifest_id"]) {
    const record = passingRecord();
    delete record[field];
    assert.equal(validateAgainstSchema(record, SCHEMA).valid, false, `${field} must be required`);
  }
});

test("source is restricted to the four declared origins", () => {
  assert.equal(errorKeywords(passingRecord({ source: "support-ticket" })).includes("enum"), true);
  for (const source of ["user", "monitoring", "review", "other"]) {
    assert.equal(validateAgainstSchema(passingRecord({ source }), SCHEMA).valid, true);
  }
});

test("sentiment is restricted to the three declared values or null", () => {
  assert.equal(errorKeywords(passingRecord({ sentiment: "mixed" })).includes("enum"), true);
});

test("evidence entries must be fully hashed", () => {
  assert.equal(
    errorKeywords(passingRecord({
      evidence: [{ path: ".sdlc/operations/dashboard-snapshot.png", size_bytes: 480 }],
    })).includes("required"),
    true,
    "evidence without a hash is not evidence",
  );
});

test("the record refuses undeclared fields and a mistyped kind or schema_version", () => {
  assert.equal(errorKeywords(passingRecord({ asserted_by_agent: true })).includes("additionalProperties"), true);
  assert.equal(errorKeywords(passingRecord({ kind: "feedback_record" })).includes("const"), true);
  assert.equal(errorKeywords(passingRecord({ schema_version: "feedback:v2" })).includes("const"), true);
});

test("identifiers and summary are mandatory", () => {
  for (const field of ["id", "source", "summary", "evidence"]) {
    const record = passingRecord();
    delete record[field];
    assert.equal(validateAgainstSchema(record, SCHEMA).valid, false, `${field} must be required`);
  }
});
