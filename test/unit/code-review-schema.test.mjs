import assert from "node:assert/strict";
import test from "node:test";

import { validateAgainstSchema } from "../../lib/json-schema-validator.mjs";

const SCHEMA = "code-review.schema.json";

function approvedRecord(overrides = {}) {
  return {
    kind: "code_review",
    schema_version: "code-review:v1",
    id: "ST-001-code-review-1",
    story_id: "ST-001",
    delivery_id: "PR-ST-001",
    delivery_profile_id: "DAP-ST-001",
    repository: "example/booking",
    base_branch: "main",
    head_branch: "feat/booking",
    base_sha: "a".repeat(40),
    reviewed_head_sha: "c".repeat(40),
    commit_authors: [{ name: "Maria Rossi", email: "maria@example.test" }],
    reviewer: {
      actor_id: "luca",
      actor_type: "human",
      git_name: "Luca Bianchi",
      git_email: "luca@example.test",
    },
    verdict: "approved",
    findings: [{ severity: "minor", summary: "Rename the helper", path: "src/booking.mjs", line: 12 }],
    summary: "Booking diff reviewed",
    reviewed_at: "2026-09-16T10:02:00.000Z",
    requirement_ids: ["REQ-001"],
    actor: { id: "luca", type: "human" },
    git: { branch: "feat/booking" },
    run: { tool: "agentic-sdlc" },
    created_at: "2026-09-16T10:02:00.000Z",
    audit: { created_by: { id: "luca", type: "human" } },
    record_hash: "b".repeat(64),
    hash_algorithm: "sha256:stable-json:v1",
    ...overrides,
  };
}

test("a complete code review record satisfies its contract", () => {
  const result = validateAgainstSchema(approvedRecord(), SCHEMA);
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

test("an approval cannot carry a blocking finding", () => {
  const blocking = [{ severity: "blocking", summary: "Drops the audit trail" }];
  assert.equal(validateAgainstSchema(approvedRecord({ findings: blocking }), SCHEMA).valid, false);
  assert.equal(
    validateAgainstSchema(approvedRecord({ verdict: "changes_requested", findings: blocking }), SCHEMA).valid,
    true,
  );
});

test("a review binds one exact head commit and one identified reviewer", () => {
  for (const field of ["reviewed_head_sha", "base_sha", "reviewer", "delivery_id", "verdict"]) {
    const record = approvedRecord();
    delete record[field];
    assert.equal(validateAgainstSchema(record, SCHEMA).valid, false, `${field} is required`);
  }
  assert.equal(validateAgainstSchema(approvedRecord({ reviewed_head_sha: "HEAD" }), SCHEMA).valid, false);
  assert.equal(validateAgainstSchema(approvedRecord({ reviewed_head_sha: "c".repeat(12) }), SCHEMA).valid, false);
  assert.equal(
    validateAgainstSchema(approvedRecord({ reviewer: { actor_id: "luca", actor_type: "human", git_name: "Luca" } }), SCHEMA).valid,
    false,
  );
  assert.equal(validateAgainstSchema(approvedRecord({ verdict: "lgtm" }), SCHEMA).valid, false);
  assert.equal(validateAgainstSchema(approvedRecord({ extra: true }), SCHEMA).valid, false);
});
