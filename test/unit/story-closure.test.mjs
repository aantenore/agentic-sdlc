import test from "node:test";
import assert from "node:assert/strict";

import { DomainValidationError } from "../../lib/canonical.mjs";
import { findForbiddenHumanGuidanceTerms } from "../../lib/human-guidance.mjs";
import { statusHumanGuidance } from "../../lib/engine/guidance.mjs";
import {
  STORY_CLOSURE_SCHEMA,
  buildStoryClosure,
  buildStoryClosureSubject,
} from "../../lib/story-closure.mjs";

const HASH = "a".repeat(64);

function ref(id) {
  return { id, path: `.sdlc/stories/${id}/story.json`, content_hash: HASH };
}

test("closure subjects are canonical and bind the replacement to the event", () => {
  const subject = buildStoryClosureSubject({
    event: "Superseded",
    stories: [ref("ST-002"), ref("ST-001")],
    replacement: ref("ST-MVP"),
    breakdown: { id: "BD-1", path: ".sdlc/work-breakdown/BD-1.json", content_hash: HASH },
    reason: " One story now delivers the work ",
  });
  assert.equal(subject.event, "superseded");
  assert.deepEqual(subject.stories.map((item) => item.id), ["ST-001", "ST-002"]);
  assert.equal(subject.reason, "One story now delivers the work");
  assert.equal(Object.isFrozen(subject), true);

  const invalid = [
    { event: "superseded", stories: [ref("ST-001")], replacement: null, reason: "x" },
    { event: "cancelled", stories: [ref("ST-001")], replacement: ref("ST-MVP"), reason: "x" },
    { event: "superseded", stories: [ref("ST-001")], replacement: ref("ST-001"), reason: "x" },
    { event: "cancelled", stories: [], reason: "x" },
    { event: "cancelled", stories: [ref("ST-001"), ref("ST-001")], reason: "x" },
    { event: "done", stories: [ref("ST-001")], reason: "x" },
    { event: "cancelled", stories: [{ ...ref("ST-001"), content_hash: "short" }], reason: "x" },
    { event: "cancelled", stories: [ref("ST-001")], reason: " " },
  ];
  for (const input of invalid) {
    assert.throws(() => buildStoryClosureSubject(input), DomainValidationError, JSON.stringify(input));
  }
});

test("a closure record belongs to exactly one story of its approved subject", () => {
  const subject = { event: "cancelled", stories: [ref("ST-001")], replacement: null, breakdown: null, reason: "Dropped" };
  const record = buildStoryClosure({
    id: "CLOSE-ST-001-1",
    story_id: "ST-001",
    subject,
    approval: { status: "approved" },
    created_at: "2026-09-30T10:00:00.000Z",
    audit: {},
  });
  assert.equal(record.kind, "story_closure");
  assert.equal(record.schema_version, STORY_CLOSURE_SCHEMA);
  assert.equal(record.event, "cancelled");
  assert.equal(record.status, "cancelled");
  assert.equal(record.replacement_id, null);
  assert.throws(() => buildStoryClosure({
    id: "CLOSE-ST-002-1",
    story_id: "ST-002",
    subject,
    created_at: "2026-09-30T10:00:00.000Z",
  }), /does not include story ST-002/u);
});

test("every project status outcome stays in plain language", () => {
  const kinds = [
    "review_decision", "resolve_blocker", "repair_claim", "start_story_workflow",
    "define_custom_workflow", "advance_story_workflow", "repair_output_link",
    "repair_strict_gate_evidence", "reapprove_output_template", "seal_strict_gate",
    "certify_lifecycle", "recertify_lifecycle", "complete_release_evidence",
    "release_story_claim", "continue_assessment", "lifecycle_not_certifiable",
    "inspect_story_workflow", "start_available_work", "continue_active_work",
    "onboard_project", "agree_requirement", "none",
  ];
  for (const italian of [false, true]) {
    for (const kind of kinds) {
      const guidance = statusHumanGuidance({ kind, reason: "test" }, {}, { italian });
      assert.deepEqual(findForbiddenHumanGuidanceTerms(guidance), [], `${kind} (${italian ? "it" : "en"})`);
    }
  }
});

test("a started-story closure binds terminal deliveries without delivered work", () => {
  const startedWork = (overrides = {}) => ({
    story_id: "ST-001",
    task_start: { path: ".sdlc/stories/ST-001/task-start.json", sha256: HASH },
    deliveries: [{
      id: "AUT-1",
      profile_hash: HASH,
      terminal_status: "cancelled",
      close_receipt: { path: ".sdlc/autonomy/executions/AUT-1/close.json", sha256: HASH },
    }],
    claim: { path: ".sdlc/stories/ST-001/claim.json", agent: "codex", status_before: "active" },
    ...overrides,
  });
  const subject = buildStoryClosureSubject({
    event: "cancelled",
    stories: [ref("ST-001")],
    reason: "Withdrawn",
    started_work: startedWork(),
  });
  assert.equal(subject.started_work.deliveries[0].terminal_status, "cancelled");

  const invalid = [
    { stories: [ref("ST-001"), ref("ST-002")], started_work: startedWork() },
    { stories: [ref("ST-002")], started_work: startedWork() },
    { stories: [ref("ST-001")], started_work: startedWork({ deliveries: [] }) },
    {
      stories: [ref("ST-001")],
      started_work: startedWork({
        deliveries: [{ ...startedWork().deliveries[0], terminal_status: "released" }],
      }),
    },
    {
      stories: [ref("ST-001")],
      started_work: startedWork({
        deliveries: [{ ...startedWork().deliveries[0], terminal_status: "merged" }],
      }),
    },
    {
      stories: [ref("ST-001")],
      breakdown: { id: "BD-1", path: ".sdlc/work-breakdown/BD-1.json", content_hash: HASH },
      started_work: startedWork(),
    },
  ];
  for (const input of invalid) {
    assert.throws(
      () => buildStoryClosureSubject({ event: "cancelled", reason: "x", ...input }),
      DomainValidationError,
      JSON.stringify(input),
    );
  }
});
