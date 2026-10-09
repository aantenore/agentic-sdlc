import assert from "node:assert/strict";
import test from "node:test";

import {
  workflowFinalFreshnessDrift,
  workflowFinalStoryRecordChanges,
} from "../../lib/engine/workflow.mjs";

const STORY_ID = "ST-DRIFT";
const REGISTRY = ".sdlc/outputs/registry.json#story=ST-DRIFT";

function file(category, filePath, digit = "a") {
  return {
    category,
    path: filePath,
    present: true,
    file_type: "regular",
    mode: 0o644,
    sha256: digit.repeat(64),
  };
}

function proof(files, registryDigit = "a") {
  return {
    governed_files: files,
    output_registry_projection: { path: REGISTRY, sha256: registryDigit.repeat(64) },
    git_scope: { scoped_changes: [] },
    local_release_scope: [],
  };
}

// Certified with `before`, observed with `before` changed to digit "b" and
// `added` appended, classified as the evaluation does.
function classify(before, added = [], { traceAppendAllowed = false, changed = true } = {}) {
  const certified = proof(before);
  const observed = proof([
    ...before.map((entry) => (changed ? { ...entry, sha256: "b".repeat(64) } : entry)),
    ...added,
  ]);
  return {
    records: workflowFinalStoryRecordChanges(certified, observed, {
      storyId: STORY_ID,
      storyTraceAppendAllowed: () => traceAppendAllowed,
    }),
    drift: workflowFinalFreshnessDrift(certified, observed),
  };
}

const IMMUTABLE = [
  ["contract", ".sdlc/contracts/CONTRACT-DRIFT.json"],
  ["requirement", ".sdlc/requirements/REQ-DRIFT.json"],
  ["requirement_profile", ".sdlc/autonomy/requirements/AUT-REQ-DRIFT.json"],
  ["delivery_profile", ".sdlc/autonomy/deliveries/AUT-DRIFT.json"],
  ["workflow_instance", ".sdlc/workflows/instances/delivery-drift/instance.json"],
  ["workflow_events", ".sdlc/workflows/instances/delivery-drift/events.jsonl"],
  ["workflow_checkpoint", ".sdlc/workflows/instances/delivery-drift/checkpoint.json"],
  ["workflow_definition", ".sdlc/workflows/definitions/software-project/v3.json"],
  ["story_test_record", ".sdlc/tests/ST-DRIFT-test.json"],
  ["story_record", ".sdlc/stories/ST-DRIFT/story.json"],
];

test("every change to an immutable story record is reported, added or changed", () => {
  for (const [category, filePath] of IMMUTABLE) {
    const changed = classify([file(category, filePath)]);
    assert.deepEqual(changed.records, [{ category, path: filePath, change: "changed" }], category);
    assert.deepEqual(changed.drift, [{ kind: "governed_file", path: `${category}:${filePath}`, change: "changed" }]);
    const added = classify([], [file(category, filePath)]);
    assert.deepEqual(added.records, [{ category, path: filePath, change: "added" }], category);
    assert.deepEqual(added.drift, [{ kind: "governed_file", path: `${category}:${filePath}`, change: "added" }]);
  }
});

test("only added base acknowledgements are allowed among the story records", () => {
  const acknowledgement = file("story_record", ".sdlc/stories/ST-DRIFT/base-acknowledgements/ACK-1.json");
  assert.deepEqual(classify([], [acknowledgement]).records, []);
  assert.deepEqual(classify([acknowledgement]).records, [
    { category: "story_record", path: acknowledgement.path, change: "changed" },
  ]);
  const removed = workflowFinalStoryRecordChanges(proof([acknowledgement]), proof([]), { storyId: STORY_ID });
  assert.deepEqual(removed, [{ category: "story_record", path: acknowledgement.path, change: "removed" }]);
});

test("append-only records may gain files but never change or lose one", () => {
  for (const [category, filePath] of [
    ["delivery_execution", ".sdlc/autonomy/executions/AUT-DRIFT/external-merge.json"],
    ["related_governance", ".sdlc/autonomy/approvals/APPROVAL-1.json"],
  ]) {
    assert.deepEqual(classify([], [file(category, filePath)]).records, [], category);
    assert.deepEqual(classify([file(category, filePath)]).records, [{ category, path: filePath, change: "changed" }]);
    assert.deepEqual(
      workflowFinalStoryRecordChanges(proof([file(category, filePath)]), proof([]), { storyId: STORY_ID }),
      [{ category, path: filePath, change: "removed" }],
    );
  }
});

test("the story trace may only gain allowed events, and its checkpoint follows it", () => {
  const trace = file("story_trace", ".sdlc/traces/ST-DRIFT.jsonl");
  const checkpoint = file("story_trace_checkpoint", ".sdlc/traces/.integrity/ST-DRIFT.jsonl.checkpoint.json");
  assert.deepEqual(classify([trace, checkpoint], [], { traceAppendAllowed: true }).records, []);
  assert.deepEqual(classify([trace, checkpoint]).records, [
    { category: "story_trace", path: trace.path, change: "changed" },
    { category: "story_trace_checkpoint", path: checkpoint.path, change: "changed" },
  ]);
  // A checkpoint that moved without its trace, or a trace that appeared.
  assert.deepEqual(classify([checkpoint], [], { traceAppendAllowed: true }).records, [
    { category: "story_trace_checkpoint", path: checkpoint.path, change: "changed" },
  ]);
  assert.deepEqual(classify([], [trace], { traceAppendAllowed: true }).records, [
    { category: "story_trace", path: trace.path, change: "added" },
  ]);
});

test("shared records only make the certification stale", () => {
  for (const [category, filePath] of [
    ["project", ".sdlc/project.json"],
    ["config", ".sdlc/config.json"],
    ["config_lock", ".sdlc/config.lock.json"],
    ["referenced_governance", ".sdlc/baseline/BASE-1.json"],
  ]) {
    for (const result of [classify([file(category, filePath)]), classify([], [file(category, filePath)])]) {
      assert.deepEqual(result.records, [], category);
      assert.equal(result.drift.length, 1, category);
    }
  }
});

test("a referenced record of the story itself follows the rule of the record it names", () => {
  const ownRecord = file("referenced_governance", ".sdlc/stories/ST-DRIFT/notes.json");
  assert.deepEqual(classify([ownRecord]).records, [
    { category: "referenced_governance", path: ownRecord.path, change: "changed" },
  ]);
  const ownTrace = file("referenced_governance", ".sdlc/traces/ST-DRIFT.jsonl");
  assert.deepEqual(classify([ownTrace], [], { traceAppendAllowed: true }).records, []);
  assert.deepEqual(classify([ownTrace]).records, [
    { category: "referenced_governance", path: ownTrace.path, change: "changed" },
  ]);
  const otherStory = file("referenced_governance", ".sdlc/stories/ST-OTHER/story.json");
  assert.deepEqual(classify([otherStory]).records, []);
});

test("a changed output registry projection is reported and records are sorted and capped", () => {
  const changes = workflowFinalStoryRecordChanges(proof([]), proof([], "b"), { storyId: STORY_ID });
  assert.deepEqual(changes, [{ category: "output_registry_projection", path: REGISTRY, change: "changed" }]);
  const many = Array.from({ length: 60 }, (_, index) =>
    file("story_record", `.sdlc/stories/ST-DRIFT/item-${String(index).padStart(2, "0")}.json`));
  const records = classify([...many, file("contract", ".sdlc/contracts/CONTRACT-DRIFT.json")]).records;
  assert.equal(records.length, 50);
  assert.equal(records[0].category, "contract");
  assert.equal(records[1].path, ".sdlc/stories/ST-DRIFT/item-00.json");
});
