import assert from "node:assert/strict";
import test from "node:test";

import { validateAgainstSchema } from "../../lib/json-schema-validator.mjs";

const SCHEMA = "test-run.schema.json";

function passingRecord(overrides = {}) {
  return {
    kind: "test_run",
    schema_version: "test-run:v1",
    id: "ST-001-test-run-1",
    story_id: "ST-001",
    phase: "validation",
    summary: "Full suite on the reviewed branch",
    framework: "node:test",
    command: { argv: ["npm", "test"], cwd: "." },
    exit_code: 0,
    outcome: "passed",
    totals: { passed: 12, failed: 0, skipped: 1 },
    started_at: "2026-09-16T10:00:00.000Z",
    finished_at: "2026-09-16T10:02:00.000Z",
    duration_ms: 120_000,
    evidence: [
      { path: ".sdlc/tests/ST-001-run.log", size_bytes: 480, sha256: "a".repeat(64) },
    ],
    acceptance_criteria: ["The booking suite passes"],
    requirement_ids: ["REQ-001"],
    actor: { id: "maria", type: "human" },
    git: { branch: "feat/booking" },
    run: { tool: "agentic-sdlc" },
    created_at: "2026-09-16T10:02:00.000Z",
    audit: { created_by: { id: "maria", type: "human" } },
    record_hash: "b".repeat(64),
    hash_algorithm: "sha256:stable-json:v1",
    ...overrides,
  };
}

function errorKeywords(record) {
  return validateAgainstSchema(record, SCHEMA).errors.map((error) => error.keyword);
}

test("a complete test run record satisfies its contract", () => {
  const result = validateAgainstSchema(passingRecord(), SCHEMA);
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

test("a passing outcome cannot be asserted over a failing command", () => {
  assert.equal(validateAgainstSchema(passingRecord({ exit_code: 1 }), SCHEMA).valid, false);
  assert.equal(
    validateAgainstSchema(passingRecord({ totals: { passed: 12, failed: 3, skipped: 0 } }), SCHEMA).valid,
    false,
  );
  assert.equal(
    validateAgainstSchema(passingRecord({ totals: { passed: 0, failed: 0, skipped: 0 } }), SCHEMA).valid,
    false,
    "a run that executed no test case cannot be recorded as passed",
  );
});

test("a failing outcome cannot be recorded over a clean command", () => {
  assert.equal(validateAgainstSchema(passingRecord({ outcome: "failed" }), SCHEMA).valid, false);
  assert.equal(
    validateAgainstSchema(passingRecord({
      outcome: "failed",
      exit_code: 1,
      totals: { passed: 10, failed: 2, skipped: 0 },
    }), SCHEMA).valid,
    true,
  );
});

test("the record must bind an executed command and hashed output", () => {
  assert.equal(errorKeywords(passingRecord({ evidence: [] })).includes("minItems"), true);
  assert.equal(
    errorKeywords(passingRecord({ command: { argv: [], cwd: "." } })).includes("minItems"),
    true,
  );
  assert.equal(
    errorKeywords(passingRecord({
      evidence: [{ path: ".sdlc/tests/ST-001-run.log", size_bytes: 480 }],
    })).includes("required"),
    true,
    "evidence without a hash is not evidence",
  );
});

test("the record refuses undeclared fields and unknown outcomes", () => {
  assert.equal(
    errorKeywords(passingRecord({ asserted_by_agent: true })).includes("additionalProperties"),
    true,
  );
  assert.equal(errorKeywords(passingRecord({ outcome: "green" })).includes("enum"), true);
  assert.equal(errorKeywords(passingRecord({ kind: "test-run" })).includes("const"), true);
  assert.equal(errorKeywords(passingRecord({ exit_code: 300 })).includes("maximum"), true);
});

test("timestamps and identifiers are mandatory", () => {
  for (const field of ["id", "story_id", "command", "exit_code", "totals", "evidence", "started_at", "finished_at"]) {
    const record = passingRecord();
    delete record[field];
    assert.equal(
      validateAgainstSchema(record, SCHEMA).valid,
      false,
      `${field} must be required`,
    );
  }
  assert.equal(errorKeywords(passingRecord({ started_at: "16/09/2026" })).includes("format"), true);
});
