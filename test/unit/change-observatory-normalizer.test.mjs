import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  OBSERVATORY_VIEW_SCHEMA_VERSION,
  buildObservatoryViewModel,
  readSourceRecord,
} from "../../lib/change-observatory/index.mjs";
import {
  createRecordIndex,
  recordIndexEntry,
} from "../../lib/change-observatory/record-index.mjs";

const FIXED_TIME = "2026-07-16T09:00:00.000Z";
const INTENTABI_EVENT_ID = "123e4567-e89b-42d3-a456-426614174000";
const INTENTABI_PATH = `.sdlc/observations/intentabi/${INTENTABI_EVENT_ID}.json`;

function intentAbiEnvelope(overrides = {}) {
  const digest = (character) => `hmac-sha256:evidence:${character.repeat(64)}`;
  return {
    schema: "io.github.aantenore.intentabi/authenticated-codex-shadow-evidence/v1alpha1",
    eventId: INTENTABI_EVENT_ID,
    keyId: "intentabi-test",
    evidence: {
      schema: "io.github.aantenore.intentabi/codex-shadow-evidence/v1alpha1",
      mode: "shadow",
      submitted: "original",
      inputKind: "text",
      bindingDigest: digest("a"),
      originalDigest: digest("b"),
      optionsDigest: "unavailable:not-provided",
      execution: {
        status: "succeeded",
        outputDigest: "unavailable:opaque-output",
      },
      preparation: {
        outcome: "candidate-observed",
        reason: "CANDIDATE_ATTESTED",
        candidateDigest: digest("c"),
        selectedCodecDigest: digest("d"),
        reasonSetDigest: digest("e"),
        promotionBindingDigest: digest("f"),
        proof: "present-unverified",
      },
    },
    mac: digest("9"),
    ...overrides,
  };
}

test("builds deterministic immutable record buckets in canonical input order", () => {
  const records = [
    { id: "A", group: "shared", tags: ["first", "common"] },
    { id: "B", group: "other", tags: ["common"] },
    { id: "C", group: "shared", tags: ["last", "common"] },
  ];
  const index = createRecordIndex(records, {
    byGroup: (record) => [recordIndexEntry(record.group, record)],
    byTag: (record) => record.tags.map((tag, tagIndex) =>
      recordIndexEntry(tag, { record, tagIndex })),
  });

  assert.deepEqual(index.get("byGroup", "shared").map((record) => record.id), ["A", "C"]);
  assert.deepEqual(
    index.get("byTag", "common").map(({ record, tagIndex }) => [record.id, tagIndex]),
    [["A", 1], ["B", 0], ["C", 1]],
  );
  assert.deepEqual([...index.keys("byGroup")], ["shared", "other"]);
  assert.equal(index.size("byTag"), 3);
  assert.equal(Object.isFrozen(index.get("byGroup", "shared")), true);
  assert.equal(Object.isFrozen(index.get("byGroup", "missing")), true);
  assert.throws(() => index.get("unknown", "shared"), /Unknown record index/u);
});

test("bounds multi-valued record indexes without reordering retained entries", () => {
  const records = [
    { id: "A", tags: ["one", "two", "three"] },
    { id: "B", tags: ["four", "five", "six"] },
  ];
  const index = createRecordIndex(records, {
    byTag: (record) => record.tags.map((tag, tagIndex) =>
      recordIndexEntry(tag, { record, tagIndex })),
    direct: (record) => [recordIndexEntry(record.id, record)],
  }, {
    maxEntriesByIndex: { byTag: 4, direct: 2 },
  });

  assert.deepEqual(
    [...index.entries("byTag")].map(([key, [{ record, tagIndex }]]) => [key, record.id, tagIndex]),
    [
      ["one", "A", 0],
      ["two", "A", 1],
      ["three", "A", 2],
      ["four", "B", 0],
    ],
  );
  assert.equal(index.entryCount("byTag"), 4);
  assert.equal(index.truncated("byTag"), true);
  assert.equal(index.entryCount("direct"), 2);
  assert.equal(index.truncated("direct"), false);
  assert.deepEqual([...index.keys("direct")], ["A", "B"]);
});

test("retains later primary index entries when earlier optional fan-out fills the budget", () => {
  const records = [
    { id: "A", tags: ["a-primary", "a-extra-1", "a-extra-2", "a-extra-3"] },
    { id: "B", tags: ["b-primary"] },
  ];
  const index = createRecordIndex(records, {
    byTag: (record) => record.tags.map((tag, tagIndex) => recordIndexEntry(
      tag,
      { record, tagIndex },
      { priority: tagIndex === 0 ? 1 : 0 },
    )),
  }, {
    maxEntriesByIndex: { byTag: 3 },
  });

  assert.deepEqual(
    [...index.entries("byTag")].map(([key, [{ record, tagIndex }]]) => [
      key,
      record.id,
      tagIndex,
    ]),
    [
      ["a-primary", "A", 0],
      ["a-extra-1", "A", 1],
      ["b-primary", "B", 0],
    ],
  );
  assert.equal(index.entryCount("byTag"), 3);
  assert.equal(index.truncated("byTag"), true);
});

test("direct record indexes preserve generic buckets without retained heap candidates", () => {
  const records = [
    { id: "A", key: "shared" },
    { id: "B", key: null },
    { id: "C", key: "" },
    { id: "D", key: "shared" },
    { id: "E", key: "other" },
  ];
  const definitions = {
    lookup(record) {
      if (record.id === "A") return [recordIndexEntry(record.key, { marker: record.id })];
      if (record.id === "D") {
        return [recordIndexEntry(record.key, undefined, { priority: 7 })];
      }
      if (record.id === "E") return [recordIndexEntry(record.key, null)];
      return [recordIndexEntry(record.key, record)];
    },
  };

  const generic = createRecordIndex(records, definitions);
  const direct = createRecordIndex(records, definitions, { directIndexes: ["lookup"] });

  assert.deepEqual([...direct.entries("lookup")], [...generic.entries("lookup")]);
  assert.deepEqual(direct.get("lookup", "shared"), [{ marker: "A" }, records[3]]);
  assert.deepEqual(direct.get("lookup", "other"), [null]);
  assert.equal(direct.has("lookup", null), false);
  assert.equal(direct.has("lookup", ""), false);
  assert.equal(direct.size("lookup"), 2);
  assert.equal(direct.entryCount("lookup"), 3);
  assert.equal(direct.truncated("lookup"), false);
  assert.equal(Object.isFrozen(direct.get("lookup", "shared")), true);
  assert.equal(Object.isFrozen(direct.get("lookup", "missing")), true);
});

test("direct record indexes retain exact priority and budget semantics on fallback", () => {
  const records = [
    { id: "A", priority: 0 },
    { id: "B", priority: 2 },
    { id: "C", priority: 1 },
    { id: "D", priority: 3 },
    { id: "E", priority: 0 },
  ];
  const definitions = {
    lookup: (record) => [recordIndexEntry(
      record.id,
      record,
      { priority: record.priority },
    )],
  };
  const options = { maxEntriesByIndex: { lookup: 2 } };
  const generic = createRecordIndex(records, definitions, options);
  const direct = createRecordIndex(records, definitions, {
    ...options,
    directIndexes: ["lookup"],
  });

  assert.deepEqual([...direct.entries("lookup")], [...generic.entries("lookup")]);
  assert.deepEqual([...direct.keys("lookup")], ["B", "D"]);
  assert.equal(direct.entryCount("lookup"), 2);
  assert.equal(direct.truncated("lookup"), true);
  assert.equal(Object.isFrozen(direct.get("lookup", "B")), true);
});

test("validates direct record index declarations and one-entry selectors", () => {
  const records = [{ id: "A" }];
  const definitions = {
    lookup: (record) => [recordIndexEntry(record.id, record)],
  };

  assert.throws(
    () => createRecordIndex(records, definitions, { directIndexes: {} }),
    /directIndexes must be an array/u,
  );
  assert.throws(
    () => createRecordIndex(records, definitions, { directIndexes: [""] }),
    /must contain non-empty strings/u,
  );
  assert.throws(
    () => createRecordIndex(records, definitions, { directIndexes: ["missing"] }),
    /Unknown direct record index 'missing'/u,
  );
  assert.throws(
    () => createRecordIndex(records, {
      lookup: (record) => [
        recordIndexEntry(record.id, record),
        recordIndexEntry(`${record.id}-duplicate`, record),
      ],
    }, { directIndexes: ["lookup"] }),
    /must return at most one entry/u,
  );
  assert.throws(
    () => createRecordIndex(records, { lookup: () => ({ key: "A" }) }, {
      directIndexes: ["lookup"],
    }),
    /must return an array/u,
  );
  assert.throws(
    () => createRecordIndex(records, { lookup: () => [{}] }, {
      directIndexes: ["lookup"],
    }),
    /returned an invalid entry/u,
  );
  assert.throws(
    () => createRecordIndex(records, { lookup: () => [{ key: "A", priority: -1 }] }, {
      directIndexes: ["lookup"],
    }),
    /returned an invalid entry priority/u,
  );
});

test("normalizes representative SDLC lineage with explicit provenance and narrative", async (t) => {
  const root = await createProject(t);
  await writeJson(root, ".sdlc/project.json", {
    schema_version: "0.1.0",
    sdlc_version: "0.6.0",
    project_id: "demo-project",
    project_name: "Demo Project",
  });
  await writeJson(root, ".sdlc/requirements/REQ-1.json", {
    schema_version: "requirement:v1",
    id: "REQ-1",
    title: "Show delivery lineage",
    summary: "Make recorded delivery evidence readable.",
    status: "approved",
  });
  await writeJson(root, ".sdlc/contracts/contract-ST-1-implementation.json", {
    schema_version: "0.1.0",
    id: "contract-ST-1-implementation",
    story_id: "ST-1",
    phase: "implementation",
    purpose: "Implement the recorded story.",
    status: "approved",
    inputs: ["REQ-1"],
    outputs: ["implementation evidence"],
    approvals: [{
      id: "APR-1",
      status: "approved",
      summary: "Approved implementation contract.",
      created_at: "2026-07-16T08:30:00Z",
    }],
  });
  await writeJson(root, ".sdlc/stories/ST-1/story.json", {
    schema_version: "0.1.0",
    id: "ST-1",
    title: "Build the Observatory core",
    phase: "implementation",
    status: "draft",
  });
  await writeJson(root, ".sdlc/stories/ST-1/task-start.json", {
    id: "START-1",
    story_id: "ST-1",
    phase: "implementation",
    status: "confirmed",
    confirmed_at: "2026-07-16T08:40:00Z",
  });
  await writeJsonLines(root, ".sdlc/traces/ST-1.jsonl", [
    {
      id: "TR-REQUEST",
      story_id: "ST-1",
      type: "decision",
      action: "task.start.confirm",
      summary: "Confirmed implementation start.",
      request: { summary: "Implement the Observatory core." },
      created_at: "2026-07-16T08:40:00Z",
    },
    {
      id: "TR-IMPLEMENT",
      story_id: "ST-1",
      type: "implementation",
      summary: "Added a safe read-only API.",
      evidence: ["test/unit/change-observatory-server.test.mjs"],
      narrative: {
        schema_version: "trace-narrative:v1",
        input_summaries: ["Approved core contract."],
        output_summaries: ["Versioned model and loopback API."],
        rationale_summary: "Keep the plugin dependency-free.",
        explanation: {
          text: "The plugin can now explain recorded project changes locally.",
          kind: "codex-generated",
          scope: "recorded-evidence-only",
        },
        alternatives: ["Hosted dashboard"],
      },
      created_at: "2026-07-16T08:50:00Z",
    },
    {
      id: "TR-TEST",
      story_id: "ST-1",
      type: "test",
      outcome: "passed",
      summary: "Core tests passed.",
      created_at: "2026-07-16T08:55:00Z",
    },
    {
      id: "TR-APPROVE",
      story_id: "ST-1",
      type: "gate",
      action: "contract.approve",
      summary: "Approved the dependency-free implementation boundary.",
      created_at: "2026-07-16T08:39:00Z",
    },
    {
      id: "TR-SYNC",
      story_id: "ST-1",
      type: "sync",
      action: "story.release",
      summary: "Story claim released.",
      created_at: "2026-07-16T08:59:00Z",
    },
  ]);

  const model = await buildObservatoryViewModel(root, { clock: () => new Date(FIXED_TIME) });

  assert.equal(model.schemaVersion, OBSERVATORY_VIEW_SCHEMA_VERSION);
  assert.equal(model.generatedAt, FIXED_TIME);
  assert.deepEqual(model.project, {
    id: "demo-project",
    name: "Demo Project",
    sdlcVersion: "0.6.0",
    provenance: "recorded",
    sourceRefs: [{ path: ".sdlc/project.json" }],
    textTruncated: false,
  });
  assert.equal(model.summary.asked.some((item) => item.id === "REQ-1"), true);
  assert.equal(model.summary.asked.some((item) => item.summary === "Implement the Observatory core."), true);
  assert.equal(model.contracts.length, 1);
  assert.equal(model.decisions.some((item) => item.id === "APR-1" && item.type === "approval"), true);
  assert.equal(model.changes.length, 2);
  assert.equal(model.verification.some((item) => item.id === "TR-TEST"), true);
  assert.equal(model.summary.changed[0].id, "TR-IMPLEMENT");
  assert.equal(model.summary.decided[0].id, "TR-APPROVE");

  const implementation = model.changes.find((item) => item.id === "TR-IMPLEMENT");
  assert.deepEqual(implementation.explanation, {
    text: "The plugin can now explain recorded project changes locally.",
    authoring: "codex-generated",
    provenance: "recorded",
    sourceRefs: [{ path: ".sdlc/traces/ST-1.jsonl", line: 2, pointer: "/narrative" }],
    truncated: false,
  });
  assert.equal(implementation.inputs[0].title, "Approved core contract.");
  assert.equal(implementation.outputs[0].title, "Versioned model and loopback API.");
  assert.equal(implementation.alternatives[0].title, "Hosted dashboard");
  assert.equal(implementation.evidence[0].title, "test/unit/change-observatory-server.test.mjs");

  const iteration = model.iterations[0];
  assert.equal(iteration.id, "ST-1");
  assert.deepEqual(
    iteration.phases.find((phase) => phase.phase === "implementation"),
    {
      phase: "implementation",
      status: "inProgress",
      provenance: "inferred",
      sourceRefs: [{ path: ".sdlc/stories/ST-1/task-start.json" }],
    },
  );
  assert.equal(iteration.phases.find((phase) => phase.phase === "analysis").provenance, "missing");

  for (const collection of [
    model.summary.asked,
    model.summary.changed,
    model.summary.decided,
    model.iterations,
    model.contracts,
    model.decisions,
    model.changes,
    model.verification,
    model.records,
  ]) {
    for (const item of collection) {
      assert.match(item.provenance, /^(recorded|inferred|missing|malformed)$/);
      assert.ok(Array.isArray(item.sourceRefs));
    }
  }
});

test("keeps the representative v1 wire model deterministic with one dossier copy", async (t) => {
  const root = await createProject(t);
  const writeCompactJson = (relativePath, value) =>
    writeText(root, relativePath, `${JSON.stringify(value)}\n`);
  await writeCompactJson(".sdlc/project.json", {
    schema_version: "0.1.0",
    project_id: "compat",
    project_name: "Compatibility",
  });
  await writeCompactJson(".sdlc/requirements/REQ-C.json", {
    schema_version: "requirement:v1",
    id: "REQ-C",
    title: "Keep output stable",
    summary: "Preserve the v1 view.",
  });
  await writeCompactJson(".sdlc/contracts/CONTRACT-C.json", {
    schema_version: "0.1.0",
    id: "CONTRACT-C",
    story_id: "ST-C",
    status: "approved",
    purpose: "Implement compat.",
  });
  await writeCompactJson(".sdlc/stories/ST-C/story.json", {
    schema_version: "0.1.0",
    id: "ST-C",
    title: "Compatibility story",
    summary: "Stable output",
    phase: "implementation",
    status: "in_progress",
    contract_id: "CONTRACT-C",
    links: { requirements: ["REQ-C"], decisions: [], tests: [] },
  });
  await writeJsonLines(root, ".sdlc/traces/ST-C.jsonl", [{
    id: "TR-C-REQ",
    story_id: "ST-C",
    type: "decision",
    action: "task.start.confirm",
    summary: "Confirmed work.",
    request: { summary: "Implement compatibility." },
    created_at: "2026-07-16T08:00:00Z",
  }, {
    id: "TR-C-IMP",
    story_id: "ST-C",
    type: "implementation",
    summary: "Implemented compatibility.",
    evidence: ["artifact.txt"],
    created_at: "2026-07-16T08:10:00Z",
  }, {
    id: "TR-C-TEST",
    story_id: "ST-C",
    type: "test",
    outcome: "passed",
    summary: "Compatibility passed.",
    created_at: "2026-07-16T08:20:00Z",
  }]);

  const model = await buildObservatoryViewModel(root, {
    clock: () => new Date(FIXED_TIME),
    limits: { maxCollectionItems: 1_000 },
  });
  const digest = crypto.createHash("sha256").update(JSON.stringify(model)).digest("hex");

  assert.equal(digest, "572d0c5cb33591e635451ebecb0e086681dd013db5b3f8e2764c6c4e94572f69");
});

test("builds proof-bound dossiers without cross-story, shared, or ambiguous lineage", async (t) => {
  const root = await createProject(t);
  await writeJson(root, ".sdlc/project.json", {
    schema_version: "0.1.0",
    project_id: "dossier-boundary",
    project_name: "Dossier Boundary",
  });
  await writeJson(root, ".sdlc/requirements/REQ-SHARED.json", {
    schema_version: "requirement:v1",
    id: "REQ-SHARED",
    title: "Shared product outcome",
    summary: "A requirement explicitly shared by two stories.",
  });
  for (const storyId of ["ST-A", "ST-B"]) {
    await writeJson(root, `.sdlc/stories/${storyId}/story.json`, {
      schema_version: "0.1.0",
      id: storyId,
      title: `Story ${storyId}`,
      summary: `Summary ${storyId}`,
      phase: "implementation",
      status: "in_progress",
      contract_id: `CONTRACT-${storyId}`,
      links: { requirements: ["REQ-SHARED"], decisions: [], tests: [] },
    });
    await writeJson(root, `.sdlc/contracts/CONTRACT-${storyId}.json`, {
      schema_version: "0.1.0",
      id: `CONTRACT-${storyId}`,
      story_id: storyId,
      phase: "implementation",
      purpose: `Contract ${storyId}`,
      status: "approved",
    });
  }
  await writeJson(root, ".sdlc/decisions/DEC-UNIQUE.json", {
    schema_version: "0.1.0",
    id: "DEC-UNIQUE",
    summary: "A uniquely addressed decision.",
  });
  await writeJson(root, ".sdlc/decisions/DUPLICATE-ONE.json", {
    schema_version: "0.1.0",
    id: "DUPLICATE-ID",
    summary: "First duplicate.",
  });
  await writeJson(root, ".sdlc/decisions/DUPLICATE-TWO.json", {
    schema_version: "0.1.0",
    id: "DUPLICATE-ID",
    summary: "Second duplicate.",
  });
  await writeJson(root, ".sdlc/decisions/REQ-ONLY.json", {
    schema_version: "0.1.0",
    id: "DEC-REQ-ONLY",
    requirement_id: "REQ-SHARED",
    summary: "A requirement-only record must not fan out across stories.",
  });
  await writeJson(root, ".sdlc/tests/A.json", {
    schema_version: "test-evidence:v1",
    id: "TEST-A",
    story_id: "ST-A",
    outcome: "passed",
    summary: "A verification passed.",
  });
  await writeJson(root, ".sdlc/tests/shared.json", {
    schema_version: "test-evidence:v1",
    id: "TEST-SHARED",
    outcome: "passed",
    summary: "A path cited by both stories is not dossier evidence.",
  });
  await writeJson(root, ".sdlc/tests/mismatch.json", {
    schema_version: "test-evidence:v1",
    id: "TEST-B-OWNED",
    story_id: "ST-B",
    outcome: "passed",
    summary: "Evidence owned by B.",
  });
  await writeJsonLines(root, ".sdlc/tests/multi.jsonl", [
    { id: "TEST-MULTI-1", outcome: "passed" },
    { id: "TEST-MULTI-2", outcome: "passed" },
  ]);
  await writeJsonLines(root, ".sdlc/tests/single.jsonl", [
    { id: "TEST-SINGLE-JSONL", outcome: "passed" },
  ]);
  await writeText(root, ".sdlc/tests/broken.json", "{not-json");
  await writeJson(root, ".sdlc/stories/ST-A/steps/implementation.json", {
    id: "STEP-A",
    story_id: "ST-A",
    phase: "implementation",
    status: "completed",
    summary: "Completed the implementation step.",
  });
  await writeJsonLines(root, ".sdlc/traces/ST-A.jsonl", [
    {
      id: "IMP-A",
      story_id: "ST-A",
      type: "implementation",
      summary: "Implemented A.",
      request: { summary: "Deliver A." },
      related: ["DEC-UNIQUE", "DUPLICATE-ID"],
      evidence: [
        ".sdlc/tests/A.json",
        ".sdlc/tests/shared.json",
        ".sdlc/tests/mismatch.json",
        ".sdlc/tests/multi.jsonl",
        ".sdlc/tests/single.jsonl",
        ".sdlc/tests/broken.json",
        ".sdlc/../outside.json",
      ],
      narrative: {
        schema_version: "trace-narrative:v1",
        rationale_summary: "A recorded rationale, not an explanation.",
      },
      created_at: "2026-07-16T08:50:00Z",
    },
    {
      id: "CROSS-A",
      story_id: "ST-A",
      type: "implementation",
      summary: "A-owned evidence that also names B in related.",
      related: ["ST-B"],
    },
    {
      id: "RELEASE-A",
      story_id: "ST-A",
      type: "release",
      summary: "Released product A.",
      outcome: "passed",
    },
    {
      id: "SYNC-A",
      story_id: "ST-A",
      type: "sync",
      action: "story.release",
      summary: "Released an operational claim only.",
    },
  ]);
  await writeJsonLines(root, ".sdlc/traces/ST-B.jsonl", [{
    id: "IMP-B",
    story_id: "ST-B",
    contract_id: "CONTRACT-ST-A",
    type: "implementation",
    summary: "Implemented B without leaking through A's contract.",
    evidence: [".sdlc/tests/shared.json"],
  }]);

  const model = await buildObservatoryViewModel(root, { clock: () => FIXED_TIME });
  assert.equal(model.schemaVersion, OBSERVATORY_VIEW_SCHEMA_VERSION);
  assert.equal(model.dossiers.length, 2);
  const dossierA = model.dossiers.find((dossier) => dossier.storyId === "ST-A");
  const dossierB = model.dossiers.find((dossier) => dossier.storyId === "ST-B");
  assert.ok(dossierA);
  assert.ok(dossierB);
  assert.equal(dossierA.schemaVersion, "change-observatory:iteration-dossier:v1");
  assert.equal(dossierA.iterationId, "ST-A");
  assert.equal(dossierA.title, "Story ST-A");
  assert.equal(dossierA.summary, "Summary ST-A");
  const iterationA = model.iterations.find((iteration) => iteration.id === "ST-A");
  assert.deepEqual(iterationA.dossier, dossierA);
  assert.equal(Object.getOwnPropertyDescriptor(iterationA, "dossier").enumerable, false);
  const serializedModel = JSON.parse(JSON.stringify(model));
  assert.equal(
    Object.hasOwn(serializedModel.iterations.find((iteration) => iteration.id === "ST-A"), "dossier"),
    false,
  );
  assert.equal(serializedModel.dossiers.some((dossier) => dossier.storyId === "ST-A"), true);
  assert.equal(dossierA.lanes.asked.items.some((item) => item.id === "REQ-SHARED"), true);
  assert.equal(dossierA.lanes.asked.items.some((item) => item.id === "ST-A"), true);
  assert.equal(dossierB.lanes.asked.items.some((item) => item.id === "REQ-SHARED"), true);
  assert.equal(dossierA.lanes.decided.items.some((item) => item.id === "DEC-REQ-ONLY"), false);
  assert.equal(dossierB.lanes.decided.items.some((item) => item.id === "DEC-REQ-ONLY"), false);
  assert.equal(dossierA.lanes.decided.items.some((item) => item.id === "DEC-UNIQUE"), true);
  assert.equal(dossierA.lanes.decided.items.some((item) => item.id === "DUPLICATE-ID"), false);
  assert.equal(dossierB.lanes.done.items.some((item) => item.id === "CROSS-A"), false);
  assert.equal(dossierA.lanes.done.items.some((item) => item.id === "IMP-B"), false);

  const implementation = dossierA.lanes.done.items.find((item) => item.id === "IMP-A");
  assert.equal(implementation.rationale.text, "A recorded rationale, not an explanation.");
  assert.equal(implementation.narrative.rationaleSummary, "A recorded rationale, not an explanation.");
  assert.equal(implementation.narrative.generatedExplanation, null);
  assert.equal(implementation.explanation.text, "Implemented A.");
  assert.notEqual(implementation.explanation.text, implementation.rationale.text);
  assert.equal(implementation.storyId, "ST-A");
  assert.deepEqual(implementation.related, ["DEC-UNIQUE", "DUPLICATE-ID"]);
  assert.equal(implementation.linkage.status, "linked");
  assert.equal(implementation.linkage.via.includes("story_id"), true);

  const verifiedIdsA = dossierA.lanes.verified.items.map((item) => item.id);
  assert.equal(verifiedIdsA.includes("TEST-A"), true);
  assert.equal(verifiedIdsA.includes("TEST-SHARED"), false);
  assert.equal(verifiedIdsA.includes("TEST-B-OWNED"), false);
  assert.equal(verifiedIdsA.includes("TEST-MULTI-1"), false);
  assert.equal(verifiedIdsA.includes("TEST-SINGLE-JSONL"), false);
  assert.equal(verifiedIdsA.some((id) => String(id).includes("broken.json")), false);
  assert.equal(verifiedIdsA.includes("RELEASE-A"), true);
  assert.equal(dossierA.lanes.done.items.some((item) => item.id === "SYNC-A"), true);
  assert.equal(dossierA.lanes.verified.items.some((item) => item.id === "SYNC-A"), false);
  assert.equal(dossierA.lanes.done.items.some((item) => item.id === "STEP-A"), true);
  assert.equal(dossierA.lanes.verified.items.some((item) => item.id === "STEP-A"), true);
  assert.equal(model.unlinked.some((item) => item.id === "DEC-REQ-ONLY"), true);
  assert.equal(model.unlinked.some((item) => item.id === "TEST-SHARED"), true);
  for (const code of [
    "dossier_cross_story_link_blocked",
    "dossier_link_target_ambiguous",
    "dossier_evidence_link_shared",
    "dossier_evidence_target_jsonl_unsupported",
    "dossier_evidence_target_malformed",
    "dossier_evidence_path_noncanonical",
  ]) {
    assert.equal(model.diagnostics.some((diagnostic) => diagnostic.code === code), true, code);
  }
});

test("projects autonomy records and links them only through explicit dossier references", async (t) => {
  const root = await createProject(t);
  const hash = (character) => character.repeat(64);
  await writeJson(root, ".sdlc/project.json", {
    schema_version: "0.1.0",
    project_id: "autonomy-lineage",
    project_name: "Autonomy Lineage",
  });
  await writeJson(root, ".sdlc/requirements/REQ-A.json", {
    schema_version: "requirement:v2",
    id: "REQ-A",
    title: "Deliver A",
    autonomy_profile_id: "AUT-REQ-A",
  });
  await writeJson(root, ".sdlc/stories/ST-A/story.json", {
    schema_version: "0.1.0",
    id: "ST-A",
    title: "Story A",
    phase: "implementation",
    status: "in_progress",
    contract_id: "CONTRACT-A",
    links: { requirements: ["REQ-A"], decisions: [], tests: [] },
  });
  await writeJson(root, ".sdlc/stories/ST-B/story.json", {
    schema_version: "0.1.0",
    id: "ST-B",
    title: "Story B",
    phase: "implementation",
    status: "in_progress",
    links: { requirements: [], decisions: [], tests: [] },
  });
  await writeJson(root, ".sdlc/contracts/CONTRACT-A.json", {
    schema_version: "0.1.0",
    id: "CONTRACT-A",
    story_id: "ST-A",
    phase: "implementation",
    status: "approved",
    requirement_execution_profile_refs: [{ id: "AUT-REQ-A", hash: hash("a") }],
    delivery_execution_profile_id: "AUT-PR-A",
  });
  await writeJson(root, ".sdlc/contracts/CONTRACT-CROSS-A.json", {
    schema_version: "0.1.0",
    id: "CONTRACT-CROSS-A",
    story_id: "ST-A",
    phase: "implementation",
    status: "approved",
    delivery_execution_profile_id: "AUT-PR-B",
  });
  await writeJson(root, ".sdlc/autonomy/requirements/AUT-REQ-A.json", {
    kind: "requirement_execution_profile",
    schema_version: "requirement-execution-profile:v1",
    id: "AUT-REQ-A",
    status: "active",
    requirement_ref: { id: "REQ-A", version: 1, hash: hash("b") },
    autonomy_ceiling: "checkpointed",
    created_at: "2026-07-16T08:00:00Z",
  });
  await writeJson(root, ".sdlc/custom-policy/requirements/AUT-REQ-ORPHAN.json", {
    kind: "requirement_execution_profile",
    schema_version: "requirement-execution-profile:v1",
    id: "AUT-REQ-ORPHAN",
    status: "active",
    requirement_ref: { id: "REQ-ORPHAN", version: 1, hash: hash("c") },
    autonomy_ceiling: "bounded-autonomous",
  });
  for (const [storyId, deliveryId, profileId, level] of [
    ["ST-A", "PR-A", "AUT-PR-A", "checkpointed"],
    ["ST-B", "PR-B", "AUT-PR-B", "bounded-autonomous"],
  ]) {
    await writeJson(root, `.sdlc/autonomy/deliveries/${profileId}.json`, {
      kind: "delivery_execution_profile",
      schema_version: "delivery-execution-profile:v1",
      id: profileId,
      status: "active",
      delivery_id: deliveryId,
      delivery_kind: "pull_request",
      requested_level: level,
      story_refs: [{ id: storyId, hash: hash("d") }],
      contract_refs: [{ id: storyId === "ST-A" ? "CONTRACT-A" : "CONTRACT-B", hash: hash("e") }],
      profile_hash: hash(storyId === "ST-A" ? "f" : "1"),
      created_at: "2026-07-16T08:10:00Z",
    });
  }
  for (const [deliveryId, profileId, decisionId, level, status] of [
    ["PR-A", "AUT-PR-A", "AUT-DEC-A", "checkpointed", "checkpoint_required"],
    ["PR-B", "AUT-PR-B", "AUT-DEC-B", "bounded-autonomous", "ready"],
  ]) {
    await writeJson(root, `.sdlc/autonomy/decisions/${decisionId}.json`, {
      kind: "autonomy_decision",
      schema_version: "autonomy-decision:v1",
      id: decisionId,
      delivery: {
        id: deliveryId,
        kind: "pull_request",
        profile_id: profileId,
        profile_hash: profileId === "AUT-PR-A" ? hash("f") : hash("1"),
      },
      phase: "implementation",
      requested_level: level,
      effective_level: level,
      execution_status: status,
      reason_codes: profileId === "AUT-PR-A" ? ["authority.audit_only_cap"] : [],
      evaluated_at: "2026-07-16T08:20:00Z",
    });
  }
  await writeJson(root, ".sdlc/stories/ST-A/task-start.json", {
    id: "START-A",
    story_id: "ST-A",
    phase: "implementation",
    status: "confirmed",
    delivery_profile_ref: { id: "AUT-PR-A", hash: hash("f") },
    autonomy_decision_ref: { id: "AUT-DEC-A", hash: hash("2") },
  });

  const model = await buildObservatoryViewModel(root, { clock: () => FIXED_TIME });
  const dossierA = model.dossiers.find((dossier) => dossier.storyId === "ST-A");
  const dossierB = model.dossiers.find((dossier) => dossier.storyId === "ST-B");
  const decidedA = dossierA.lanes.decided.items.map((item) => item.id);
  const decidedB = dossierB.lanes.decided.items.map((item) => item.id);

  assert.equal(decidedA.includes("AUT-REQ-A"), true);
  assert.equal(decidedA.includes("AUT-PR-A"), true);
  assert.equal(decidedA.includes("AUT-DEC-A"), true);
  assert.equal(decidedA.includes("AUT-PR-B"), false);
  assert.equal(decidedA.includes("AUT-DEC-B"), false);
  assert.equal(decidedB.includes("AUT-PR-B"), true);
  assert.equal(decidedB.includes("AUT-DEC-B"), true);
  assert.equal(decidedB.includes("AUT-REQ-A"), false);

  const requirementProfile = model.decisions.find((item) => item.id === "AUT-REQ-A");
  assert.equal(requirementProfile.type, "requirement-execution-profile");
  assert.equal(requirementProfile.title, "Approved working limit for this request");
  assert.equal(
    requirementProfile.summary,
    "This sets how independently a delivery may be configured; every code change or local installation still needs its own agreement.",
  );
  assert.equal(requirementProfile.humanStatus, "In effect");
  const deliveryProfile = model.decisions.find((item) => item.id === "AUT-PR-A");
  assert.equal(deliveryProfile.title, "Approved working agreement for this code change");
  assert.equal(
    deliveryProfile.summary,
    "The approved way of working applies only to this code change and cannot be reused for another change or installation.",
  );
  assert.equal(deliveryProfile.humanStatus, "In effect");
  const autonomyDecision = model.decisions.find((item) => item.id === "AUT-DEC-A");
  assert.equal(autonomyDecision.status, "checkpoint_required");
  assert.equal(autonomyDecision.title, "Review needed before the next protected step");
  assert.equal(
    autonomyDecision.summary,
    "Routine work has reached a boundary where the recorded evidence must be reviewed before continuing.",
  );
  assert.equal(autonomyDecision.humanStatus, "Review needed");
  const readyDecision = model.decisions.find((item) => item.id === "AUT-DEC-B");
  assert.equal(readyDecision.title, "This work may continue");
  assert.equal(readyDecision.humanStatus, "Ready to continue");
  assert.equal(
    new Set([
      requirementProfile.humanTitle,
      deliveryProfile.humanTitle,
      autonomyDecision.humanTitle,
      readyDecision.humanTitle,
    ]).size,
    4,
    "different autonomy record kinds and states remain distinguishable without identifiers",
  );
  for (const item of [requirementProfile, deliveryProfile, autonomyDecision, readyDecision]) {
    assert.doesNotMatch(
      `${item.humanTitle}\n${item.humanSummary}\n${item.humanStatus}`,
      /\b(?:bounded-autonomous|checkpointed|audit_only|profile|receipt|ceiling|AUT-[A-Z0-9-]+)\b/iu,
    );
  }
  assert.equal(
    model.records.find((record) => record.id === "AUT-REQ-ORPHAN").kind,
    "requirement-execution-profile",
  );
  assert.equal(model.unlinked.some((item) => item.id === "AUT-REQ-ORPHAN"), true);
  assert.equal(
    model.diagnostics.some((diagnostic) => diagnostic.code === "dossier_cross_story_link_blocked"),
    true,
  );
});

test("fails closed when canonical story IDs are duplicated", async (t) => {
  const root = await createProject(t);
  await writeJson(root, ".sdlc/project.json", {
    schema_version: "0.1.0",
    project_id: "duplicate-stories",
    project_name: "Duplicate Stories",
  });
  await writeJson(root, ".sdlc/stories/first/story.json", {
    schema_version: "0.1.0",
    id: "ST-DUPLICATE",
    title: "First duplicate",
    phase: "implementation",
    status: "in_progress",
  });
  await writeJson(root, ".sdlc/stories/second/story.json", {
    schema_version: "0.1.0",
    id: "ST-DUPLICATE",
    title: "Second duplicate",
    phase: "validation",
    status: "in_progress",
  });

  const model = await buildObservatoryViewModel(root, { clock: () => FIXED_TIME });
  assert.equal(model.dossiers.length, 0);
  assert.equal(
    model.iterations.filter((iteration) => iteration.id === "ST-DUPLICATE")
      .every((iteration) => iteration.dossier === null),
    true,
  );
  assert.equal(
    model.diagnostics.some((diagnostic) => diagnostic.code === "dossier_story_id_ambiguous"),
    true,
  );
});

test("keeps stories with colliding bounded display IDs in separate dossiers", async (t) => {
  const root = await createProject(t);
  const storyA = "ST-COLLISION-A";
  const storyB = "ST-COLLISION-B";
  const displayId = storyA.slice(0, 8);
  await writeJson(root, ".sdlc/project.json", {
    schema_version: "0.1.0",
    project_id: "story-id-collision",
    project_name: "Story ID Collision",
  });
  for (const [storyId, title, traceId] of [
    [storyA, "Alpha", "TR-A"],
    [storyB, "Beta", "TR-B"],
  ]) {
    await writeJson(root, `.sdlc/stories/${storyId}/story.json`, {
      id: storyId,
      title,
      phase: "implementation",
      status: "in_progress",
    });
    await writeJsonLines(root, `.sdlc/traces/${traceId}.jsonl`, [{
      id: traceId,
      story_id: storyId,
      type: "implementation",
      summary: `Implemented ${title}.`,
    }]);
  }

  const model = await buildObservatoryViewModel(root, {
    clock: () => FIXED_TIME,
    limits: { maxTextChars: 8 },
  });
  const dossierA = model.dossiers.find((dossier) => dossier.title === "Alpha");
  const dossierB = model.dossiers.find((dossier) => dossier.title === "Beta");

  assert.equal(model.dossiers.length, 2);
  assert.equal(dossierA.storyId, displayId);
  assert.equal(dossierB.storyId, displayId);
  assert.equal(dossierA.lanes.asked.items.some((item) => item.title === "Alpha"), true);
  assert.equal(dossierB.lanes.asked.items.some((item) => item.title === "Beta"), true);
  assert.deepEqual(dossierA.lanes.done.items.map((item) => item.id), ["TR-A"]);
  assert.deepEqual(dossierB.lanes.done.items.map((item) => item.id), ["TR-B"]);
  assert.equal(model.iterations.find((iteration) => iteration.title === "Alpha").dossier, dossierA);
  assert.equal(model.iterations.find((iteration) => iteration.title === "Beta").dossier, dossierB);
  assert.equal(
    model.diagnostics.some((diagnostic) => diagnostic.code === "dossier_story_id_ambiguous"),
    false,
  );
});

test("retains a long canonical story record in its own bounded-display dossier", async (t) => {
  const root = await createProject(t);
  const storyId = "ST-SELF-LONG-IDENTITY";
  await writeJson(root, ".sdlc/project.json", {
    schema_version: "0.1.0",
    project_id: "long-self-story",
    project_name: "Long Self Story",
  });
  await writeJson(root, `.sdlc/stories/${storyId}/story.json`, {
    id: storyId,
    title: "Self",
    phase: "analysis",
    status: "in_progress",
  });

  const model = await buildObservatoryViewModel(root, {
    clock: () => FIXED_TIME,
    limits: { maxTextChars: 5 },
  });
  const dossier = model.dossiers.find((item) => item.title === "Self");

  assert.ok(dossier);
  assert.equal(dossier.storyId, storyId.slice(0, 5));
  assert.equal(dossier.lanes.asked.items.some((item) => item.type === "story"), true);
  assert.equal(
    model.diagnostics.some((diagnostic) => diagnostic.code === "dossier_cross_story_link_blocked"),
    false,
  );
});

test("orders dossiers deterministically and enforces one global nested-item limit", async (t) => {
  const populate = async (root, reverse) => {
    const records = [
      ["json", ".sdlc/project.json", {
        schema_version: "0.1.0",
        project_id: "bounded-dossiers",
        project_name: "Bounded Dossiers",
      }],
      ...["ST-A", "ST-B"].flatMap((storyId) => [
        ["json", `.sdlc/requirements/REQ-${storyId}.json`, {
          schema_version: "requirement:v1",
          id: `REQ-${storyId}`,
          title: `Requirement ${storyId}`,
        }],
        ["json", `.sdlc/stories/${storyId}/story.json`, {
          schema_version: "0.1.0",
          id: storyId,
          title: `Story ${storyId}`,
          phase: "implementation",
          status: "in_progress",
          contract_id: `CONTRACT-${storyId}`,
          links: { requirements: [`REQ-${storyId}`], decisions: [], tests: [] },
        }],
        ["json", `.sdlc/contracts/CONTRACT-${storyId}.json`, {
          schema_version: "0.1.0",
          id: `CONTRACT-${storyId}`,
          story_id: storyId,
          status: "approved",
        }],
        ["jsonl", `.sdlc/traces/${storyId}.jsonl`, [{
          id: `IMP-${storyId}`,
          story_id: storyId,
          type: "implementation",
          summary: `Implemented ${storyId}`,
          request: { summary: `Deliver ${storyId}` },
        }]],
      ]),
    ];
    for (const [format, relativePath, value] of reverse ? [...records].reverse() : records) {
      if (format === "jsonl") await writeJsonLines(root, relativePath, value);
      else await writeJson(root, relativePath, value);
    }
  };
  const firstRoot = await createProject(t);
  const secondRoot = await createProject(t);
  await populate(firstRoot, false);
  await populate(secondRoot, true);
  const options = { clock: () => FIXED_TIME, limits: { maxCollectionItems: 3 } };
  const first = await buildObservatoryViewModel(firstRoot, options);
  const second = await buildObservatoryViewModel(secondRoot, options);

  assert.deepEqual(first.dossiers, second.dossiers);
  const nestedItems = first.dossiers.reduce(
    (total, dossier) => total + Object.values(dossier.lanes)
      .reduce((laneTotal, lane) => laneTotal + lane.items.length, 0),
    0,
  );
  assert.equal(nestedItems, 3);
  assert.equal(
    first.diagnostics.some((diagnostic) => diagnostic.code === "dossier_nested_items_truncated"),
    true,
  );
  assert.equal(
    first.dossiers.some((dossier) => Object.values(dossier.lanes)
      .some((lane) => lane.status === "malformed")),
    true,
  );
});

test("bounds optional fan-out without losing direct story lineage or cross-story controls", async (t) => {
  const root = await createProject(t);
  await writeJson(root, ".sdlc/project.json", {
    schema_version: "0.1.0",
    project_id: "bounded-fanout",
    project_name: "Bounded Fanout",
  });
  for (const storyId of ["ST-A", "ST-B"]) {
    await writeJson(root, `.sdlc/stories/${storyId}/story.json`, {
      schema_version: "0.1.0",
      id: storyId,
      title: `Story ${storyId}`,
      phase: "implementation",
      status: "in_progress",
      links: { requirements: [], decisions: [], tests: [] },
    });
    await writeJsonLines(root, `.sdlc/traces/${storyId}.jsonl`, [1, 2].map((index) => ({
      id: `${storyId}-IMP-${index}`,
      story_id: storyId,
      type: "implementation",
      summary: `Implemented ${storyId} ${index}.`,
      related: ["ST-A", "ST-B", "ST-X-1", "ST-X-2", "ST-X-3", "ST-X-4", "ST-X-5"],
    })));
  }
  await writeJson(root, ".sdlc/decisions/DEC-APPROVALS.json", {
    schema_version: "decision:v1",
    id: "DEC-APPROVALS",
    summary: "A decision with intentionally wide approvals.",
    approvals: Array.from({ length: 7 }, (_, index) => ({
      id: `APR-${index + 1}`,
      status: "approved",
      summary: `Approval ${index + 1}`,
    })),
  });

  const model = await buildObservatoryViewModel(root, {
    clock: () => FIXED_TIME,
    limits: { maxCollectionItems: 5, maxRecords: 9 },
  });
  const dossierA = model.dossiers.find((dossier) => dossier.storyId === "ST-A");
  const dossierB = model.dossiers.find((dossier) => dossier.storyId === "ST-B");

  assert.deepEqual(
    dossierA.lanes.done.items.map((item) => item.id),
    ["ST-A-IMP-1", "ST-A-IMP-2"],
  );
  assert.equal(dossierB.lanes.done.items.some((item) => item.id === "ST-B-IMP-1"), true);
  assert.equal(dossierB.lanes.done.items.some((item) => item.id.startsWith("ST-A")), false);
  assert.deepEqual(model.decisions.map((item) => item.id), ["APR-1", "APR-2", "APR-3", "APR-4", "APR-5"]);
  for (const code of [
    "record_fanout_truncated",
    "record_index_truncated",
    "dossier_cross_story_link_blocked",
    "dossier_nested_items_truncated",
  ]) {
    assert.equal(model.diagnostics.some((diagnostic) => diagnostic.code === code), true, code);
  }
});

test("does not let earlier optional fan-out evict a later delivery ownership link", async (t) => {
  const root = await createProject(t);
  await writeJson(root, ".sdlc/autonomy/deliveries/00-WIDE.json", {
    id: "AUT-WIDE",
    story_refs: Array.from({ length: 5 }, (_, index) => ({ id: `ST-X-${index + 1}` })),
  });
  await writeJson(root, ".sdlc/autonomy/deliveries/ZZ-TARGET.json", {
    id: "AUT-TARGET",
    story_refs: [{ id: "ST-A" }],
  });
  await writeJson(root, ".sdlc/project.json", {
    schema_version: "0.1.0",
    project_id: "primary-index-lineage",
    project_name: "Primary Index Lineage",
  });
  await writeJson(root, ".sdlc/stories/ST-A/story.json", {
    schema_version: "0.1.0",
    id: "ST-A",
    title: "Story A",
    phase: "implementation",
    status: "in_progress",
  });

  const model = await buildObservatoryViewModel(root, {
    clock: () => FIXED_TIME,
    limits: { maxCollectionItems: 5, maxRecords: 4 },
  });
  const dossier = model.dossiers.find((item) => item.storyId === "ST-A");

  assert.ok(dossier);
  assert.equal(dossier.lanes.decided.items.some((item) => item.id === "AUT-TARGET"), true);
  assert.equal(dossier.lanes.decided.items.some((item) => item.id === "AUT-WIDE"), false);
  assert.equal(model.unlinked.some((item) => item.id === "AUT-WIDE"), true);
  assert.equal(
    model.diagnostics.some((diagnostic) => diagnostic.code === "record_index_truncated"),
    true,
  );
});

test("keeps canonical relationship keys while bounding identifier display", async (t) => {
  const root = await createProject(t);
  const storyId = "ST-LONG-000001";
  const contractId = "CONTRACT-LONG-000001";
  const requirementId = "REQ-LONG-000001";
  const profileId = "PROFILE-LONG-000001";
  const bounded = (value) => value.slice(0, 10);
  await writeJson(root, ".sdlc/project.json", {
    schema_version: "0.1.0",
    project_id: "bounded-index-ids",
    project_name: "Bounded Index IDs",
  });
  await writeJson(root, `.sdlc/stories/${storyId}/story.json`, {
    id: storyId,
    title: "Long identifier story",
    phase: "implementation",
    status: "in_progress",
    contract_id: contractId,
  });
  await writeJson(root, `.sdlc/stories/${storyId}/steps/implementation.json`, {
    id: "STEP",
    phase: "implementation",
    status: "completed",
  });
  await writeJson(root, ".sdlc/contracts/LONG.json", {
    id: contractId,
    story_id: storyId,
    status: "approved",
  });
  await writeJson(root, ".sdlc/requirements/LONG.json", {
    id: requirementId,
    title: "Long requirement",
  });
  await writeJson(root, ".sdlc/work-breakdown/LONG.json", {
    id: "WB",
    requirement_id: requirementId,
    items: [{ type: "story", id: storyId }],
  });
  await writeJson(root, ".sdlc/decisions/RELATED.json", {
    id: "DEC-REL",
    summary: "Related by a bounded story ID.",
    related: [storyId],
  });
  await writeJson(root, ".sdlc/autonomy/deliveries/LONG.json", {
    id: profileId,
    story_refs: [{ id: storyId }],
  });
  await writeJson(root, ".sdlc/autonomy/decisions/LONG.json", {
    id: "AUT-DEC",
    delivery: { profile_id: profileId },
  });
  await writeJsonLines(root, ".sdlc/traces/LONG.jsonl", [{
    id: "TR-ST",
    story_id: storyId,
    type: "implementation",
    summary: "Linked by story ID.",
  }, {
    id: "TR-CT",
    contract_id: contractId,
    type: "implementation",
    summary: "Linked by contract ID.",
  }]);

  const model = await buildObservatoryViewModel(root, {
    clock: () => FIXED_TIME,
    limits: { maxTextChars: 10 },
  });
  const dossier = model.dossiers.find((item) => item.storyId === bounded(storyId));

  assert.ok(dossier);
  assert.equal(dossier.lanes.asked.items.some((item) => item.id === bounded(requirementId)), true);
  assert.equal(dossier.lanes.contract.items.some((item) => item.id === bounded(contractId)), true);
  assert.equal(dossier.lanes.decided.items.some((item) => item.id === "DEC-REL"), true);
  assert.equal(dossier.lanes.decided.items.some((item) => item.id === bounded(profileId)), true);
  assert.equal(dossier.lanes.decided.items.some((item) => item.id === "AUT-DEC"), true);
  assert.equal(dossier.lanes.done.items.some((item) => item.id === "TR-ST"), true);
  assert.equal(dossier.lanes.done.items.some((item) => item.id === "TR-CT"), true);
  assert.equal(
    model.iterations.find((item) => item.id === bounded(storyId)).phases
      .find((phase) => phase.phase === "implementation").status,
    "complete",
  );
});

test("bounds many unlinked fan-out records while preserving total count and order", async (t) => {
  const root = await createProject(t);
  await writeJson(root, ".sdlc/project.json", {
    schema_version: "0.1.0",
    project_id: "bounded-unlinked",
    project_name: "Bounded Unlinked",
  });
  await writeJsonLines(root, ".sdlc/traces/unlinked.jsonl", Array.from(
    { length: 12 },
    (_, index) => ({
      id: `UN-${String(index + 1).padStart(2, "0")}`,
      type: "implementation",
      summary: `Unlinked implementation ${index + 1}.`,
      related: Array.from({ length: 5 }, (__, relatedIndex) =>
        `MISSING-${index + 1}-${relatedIndex + 1}`),
      created_at: `2026-07-16T08:${String(index).padStart(2, "0")}:00Z`,
    }),
  ));
  const options = {
    clock: () => FIXED_TIME,
    limits: { maxCollectionItems: 3 },
  };

  const first = await buildObservatoryViewModel(root, options);
  const second = await buildObservatoryViewModel(root, options);

  assert.deepEqual(first, second);
  assert.deepEqual(first.unlinked.map((item) => item.id), ["UN-12", "UN-11", "UN-10"]);
  assert.equal(first.snapshots.counts.unlinked, 12);
  assert.equal(
    first.diagnostics.some((diagnostic) =>
      diagnostic.code === "collection_truncated"
      && diagnostic.message.includes("unlinked")),
    true,
  );
  assert.equal(
    first.diagnostics.some((diagnostic) => diagnostic.code === "record_fanout_truncated"),
    true,
  );
});

test("projects content-free IntentABI evidence and links it only through an explicit story trace", async (t) => {
  const root = await createProject(t);
  await writeJson(root, ".sdlc/project.json", {
    schema_version: "0.1.0",
    project_id: "intentabi-project",
    project_name: "IntentABI Project",
  });
  await writeJson(root, ".sdlc/stories/ST-INTENT/story.json", {
    schema_version: "0.1.0",
    id: "ST-INTENT",
    title: "Observe intent evidence",
    status: "draft",
  });
  await writeJson(root, INTENTABI_PATH, intentAbiEnvelope());
  await writeJsonLines(root, ".sdlc/traces/ST-INTENT.jsonl", [{
    id: "TR-INTENTABI-LINK",
    story_id: "ST-INTENT",
    type: "handoff",
    summary: "Linked content-free intent evidence.",
    evidence: [INTENTABI_PATH],
  }]);

  const model = await buildObservatoryViewModel(root, { clock: () => FIXED_TIME });

  assert.equal(model.schemaVersion, OBSERVATORY_VIEW_SCHEMA_VERSION);
  assert.equal(model.semanticObservations.length, 1);
  assert.deepEqual(model.semanticObservations[0], {
    id: INTENTABI_EVENT_ID,
    type: "intentabi-codex-shadow",
    title: "IntentABI shadow observation",
    summary: "Content-free IntentABI shadow evidence.",
    status: "candidate-observed",
    phase: null,
    action: null,
    intent: null,
    timestamp: null,
    provenance: "recorded",
    sourceRefs: [
      { path: INTENTABI_PATH },
      { path: ".sdlc/traces/ST-INTENT.jsonl", line: 1, pointer: "/evidence/0" },
    ],
    rawHref: `/api/v1/source?path=${encodeURIComponent(INTENTABI_PATH)}`,
    mode: "shadow",
    submitted: "original",
    outcome: "candidate-observed",
    reason: "CANDIDATE_ATTESTED",
    proof: "present-unverified",
    macStatus: "present-not-verified",
    link: {
      status: "linked",
      storyId: "ST-INTENT",
      traceIds: ["TR-INTENTABI-LINK"],
      sourceRefs: [
        { path: ".sdlc/traces/ST-INTENT.jsonl", line: 1, pointer: "/evidence/0" },
      ],
    },
  });
  assert.equal(model.snapshots.counts.semanticObservations, 1);
  assert.deepEqual(model.summary, { asked: [], changed: [], decided: [] });
  assert.equal(model.contracts.length, 0);
  assert.equal(model.changes.length, 0);
  assert.equal(model.decisions.length, 0);
  assert.equal(model.verification.length, 0);
  assert.ok(model.iterations[0].phases.every((phase) => phase.status === "missing"));
  assert.equal(
    model.diagnostics.some((diagnostic) =>
      diagnostic.code === "schema_version_missing" && diagnostic.sourceRefs[0]?.path === INTENTABI_PATH),
    false,
  );

  const source = await readSourceRecord(root, INTENTABI_PATH);
  assert.equal(source.contentProjection, "intentabi-observatory:v1");
  assert.deepEqual(source.data, {
    eventId: INTENTABI_EVENT_ID,
    mode: "shadow",
    submitted: "original",
    outcome: "candidate-observed",
    reason: "CANDIDATE_ATTESTED",
    proof: "present-unverified",
    macStatus: "present-not-verified",
  });
  assert.equal(JSON.stringify(source).includes("hmac-sha256"), false);
  assert.equal(JSON.stringify(source).includes("keyId"), false);
  assert.equal(Object.hasOwn(source, "sha256"), false);
  assert.equal(Object.hasOwn(source, "sizeBytes"), false);
});

test("keeps incomplete IntentABI trace links explicit and bounds diagnostic references", async (t) => {
  const root = await createProject(t);
  await writeJson(root, ".sdlc/project.json", {
    schema_version: "0.1.0",
    project_id: "intentabi-incomplete-links",
    project_name: "IntentABI Incomplete Links",
  });
  await writeJson(root, INTENTABI_PATH, intentAbiEnvelope());
  await writeJsonLines(root, ".sdlc/traces/incomplete.jsonl", Array.from({ length: 15 }, (_, index) => ({
    ...(index % 2 === 0 ? { id: `TR-INCOMPLETE-${index}` } : { story_id: "ST-INCOMPLETE" }),
    type: "handoff",
    summary: "Incomplete explicit link.",
    evidence: [INTENTABI_PATH],
  })));

  const model = await buildObservatoryViewModel(root, { clock: () => FIXED_TIME });

  assert.equal(model.semanticObservations.length, 1);
  assert.equal(model.semanticObservations[0].link.status, "unlinked");
  const diagnostic = model.diagnostics.find((item) => item.code === "intentabi_link_incomplete");
  assert.ok(diagnostic);
  assert.equal(diagnostic.sourceRefs.length, 12);
  assert.equal(diagnostic.sourceRefs.some((reference) => reference.pointer === "/evidence/0"), true);
});

test("bounds IntentABI trace-link indexing without inferring omitted links", async (t) => {
  const root = await createProject(t);
  await writeJson(root, ".sdlc/project.json", {
    schema_version: "0.1.0",
    project_id: "intentabi-bounded-links",
    project_name: "IntentABI Bounded Links",
  });
  await writeJson(root, INTENTABI_PATH, intentAbiEnvelope());
  await writeJsonLines(root, ".sdlc/traces/bounded.jsonl", [{
    id: "TR-BOUNDED",
    story_id: "ST-BOUNDED",
    type: "handoff",
    summary: "The relevant reference is beyond the configured per-record limit.",
    evidence: ["unrelated-one", "unrelated-two", INTENTABI_PATH],
  }]);

  const model = await buildObservatoryViewModel(root, {
    clock: () => FIXED_TIME,
    limits: { maxCollectionItems: 2 },
  });

  assert.equal(model.semanticObservations.length, 1);
  assert.equal(model.semanticObservations[0].link.status, "unlinked");
  assert.equal(
    model.diagnostics.some((item) => item.code === "intentabi_link_index_truncated"),
    true,
  );
});

test("keeps unlinked IntentABI evidence unlinked and omits non-contract content fail-closed", async (t) => {
  const root = await createProject(t);
  await writeJson(root, ".sdlc/project.json", {
    schema_version: "0.1.0",
    project_id: "intentabi-boundary",
    project_name: "IntentABI Boundary",
  });
  await writeJson(root, INTENTABI_PATH, intentAbiEnvelope());
  await writeJsonLines(root, ".sdlc/traces/project.jsonl", [{
    id: "TR-NO-STORY",
    type: "handoff",
    summary: "A path without story lineage is insufficient.",
    evidence: [INTENTABI_PATH],
  }]);
  const unsafePath = ".sdlc/observations/intentabi/PROMPT_SECRET.json";
  await writeJson(root, unsafePath, intentAbiEnvelope({
    eventId: "123e4567-e89b-42d3-a456-426614174001",
    prompt: "PROMPT_MUST_NOT_APPEAR",
    candidate: "CANDIDATE_MUST_NOT_APPEAR",
    output: "OUTPUT_MUST_NOT_APPEAR",
  }));
  const outsidePath = ".sdlc/PROMPT_OUTSIDE_NAMESPACE.json";
  await writeJson(root, outsidePath, intentAbiEnvelope({
    eventId: "123e4567-e89b-42d3-a456-426614174004",
  }));

  const model = await buildObservatoryViewModel(root, { clock: () => FIXED_TIME });

  assert.equal(model.semanticObservations.length, 1);
  assert.deepEqual(model.semanticObservations[0].link, {
    status: "unlinked",
    storyId: null,
    traceIds: [],
    sourceRefs: [],
  });
  assert.equal(model.semanticObservations[0].phase, null);
  assert.equal(model.semanticObservations[0].timestamp, null);
  assert.equal(JSON.stringify(model).includes("MUST_NOT_APPEAR"), false);
  assert.equal(JSON.stringify(model).includes("PROMPT_SECRET"), false);
  assert.equal(JSON.stringify(model).includes("PROMPT_OUTSIDE_NAMESPACE"), false);
  assert.equal(model.diagnostics.some((diagnostic) => diagnostic.code === "intentabi_envelope_malformed"), true);
  assert.equal(
    model.diagnostics.some((diagnostic) => diagnostic.code === "intentabi_observation_path_noncanonical"),
    true,
  );
  const unsafeRecord = model.records.find((record) => record.path === unsafePath);
  assert.equal(unsafeRecord, undefined);
  assert.equal(model.records.every(Boolean), true);
  assert.equal(model.snapshots.counts.records, model.records.length);

  const unsafeSource = await readSourceRecord(root, unsafePath);
  assert.equal(unsafeSource.provenance, "malformed");
  assert.equal(unsafeSource.parseError, "invalid_intentabi_path");
  assert.equal(unsafeSource.contentOmitted, true);
  assert.equal(Object.hasOwn(unsafeSource, "data"), false);
  assert.equal(Object.hasOwn(unsafeSource, "sha256"), false);
  assert.equal(Object.hasOwn(unsafeSource, "sizeBytes"), false);
  assert.equal(JSON.stringify(unsafeSource).includes("MUST_NOT_APPEAR"), false);
  assert.equal(JSON.stringify(unsafeSource).includes("PROMPT_SECRET"), false);

  const outsideSource = await readSourceRecord(root, outsidePath);
  assert.equal(outsideSource.provenance, "malformed");
  assert.equal(outsideSource.parseError, "invalid_intentabi_path");
  assert.equal(outsideSource.contentOmitted, true);
  assert.equal(JSON.stringify(outsideSource).includes("PROMPT_OUTSIDE_NAMESPACE"), false);

  const unsafeJsonlPath = ".sdlc/observations/intentabi/events.jsonl";
  const safeEntry = intentAbiEnvelope({
    eventId: "123e4567-e89b-42d3-a456-426614174002",
  });
  const unsafeEntry = {
    ...intentAbiEnvelope({ eventId: "123e4567-e89b-42d3-a456-426614174003" }),
    prompt: "JSONL_PROMPT_MUST_NOT_APPEAR",
  };
  await writeJsonLines(root, unsafeJsonlPath, [safeEntry, unsafeEntry]);
  const jsonlSource = await readSourceRecord(root, unsafeJsonlPath);
  assert.equal(jsonlSource.provenance, "malformed");
  assert.equal(jsonlSource.parseError, "invalid_intentabi_path");
  assert.equal(jsonlSource.contentOmitted, true);
  assert.equal(Object.hasOwn(jsonlSource, "entries"), false);
  assert.equal(JSON.stringify(jsonlSource).includes("JSONL_PROMPT_MUST_NOT_APPEAR"), false);

  const unsupportedPath = ".sdlc/observations/intentabi/raw.txt";
  await writeText(root, unsupportedPath, "RAW_PROMPT_MUST_NOT_APPEAR");
  const unsupportedSource = await readSourceRecord(root, unsupportedPath);
  assert.equal(unsupportedSource.parseError, "invalid_intentabi_path");
  assert.equal(unsupportedSource.contentOmitted, true);
  assert.equal(JSON.stringify(unsupportedSource).includes("RAW_PROMPT_MUST_NOT_APPEAR"), false);
});

test("returns bounded missing-state diagnostics for empty and absent knowledge bases", async (t) => {
  const absent = await createProject(t, { knowledgeBase: false });
  const missingModel = await buildObservatoryViewModel(absent, { clock: () => FIXED_TIME });
  assert.equal(missingModel.iterations.length, 0);
  assert.equal(missingModel.project.provenance, "missing");
  assert.equal(missingModel.diagnostics[0].code, "knowledge_base_missing");

  const empty = await createProject(t);
  await writeJson(empty, ".sdlc/CACHE/derived.json", { secret: "not canonical" });
  await writeJson(empty, ".sdlc/InDeXeS/derived.json", { secret: "not canonical" });
  const emptyModel = await buildObservatoryViewModel(empty, { clock: () => FIXED_TIME });
  assert.equal(emptyModel.records.length, 0);
  assert.equal(emptyModel.records.some((record) => /\/(?:cache|indexes)\//i.test(record.path)), false);
  assert.equal(emptyModel.diagnostics.some((diagnostic) => diagnostic.code === "project_record_missing"), true);
  assert.ok(emptyModel.diagnostics.every((diagnostic) => diagnostic.sourceRefs.every((ref) => !path.isAbsolute(ref.path))));
});

test("bounds aggregate traversal across many empty directories", async (t) => {
  const root = await createProject(t);
  for (let index = 0; index < 6; index += 1) {
    await fs.mkdir(path.join(root, ".sdlc", `empty-${index}`));
  }

  const options = { clock: () => FIXED_TIME, limits: { maxEntries: 4 } };
  const first = await buildObservatoryViewModel(root, options);
  const second = await buildObservatoryViewModel(root, options);

  assert.deepEqual(second, first);
  assert.equal(first.records.length, 0);
  assert.equal(
    first.diagnostics.some((diagnostic) => (
      diagnostic.code === "max_entries_exceeded"
      && diagnostic.sourceRefs[0]?.path === ".sdlc"
    )),
    true,
  );
});

test("skips an oversized directory atomically at the aggregate entry limit", async (t) => {
  const root = await createProject(t);
  await writeJson(root, ".sdlc/project.json", {
    schema_version: "0.1.0",
    project_id: "entry-limit",
    project_name: "Entry Limit",
  });
  const wide = path.join(root, ".sdlc", "z-wide");
  await fs.mkdir(wide);
  for (let index = 0; index < 3; index += 1) {
    await fs.writeFile(path.join(wide, `ignored-${index}.bin`), "x\n", "utf8");
  }

  const model = await buildObservatoryViewModel(root, {
    clock: () => FIXED_TIME,
    limits: { maxEntries: 4 },
  });

  assert.equal(model.project.id, "entry-limit");
  assert.deepEqual(model.records.map((record) => record.path), [".sdlc/project.json"]);
  assert.equal(
    model.diagnostics.some((diagnostic) => (
      diagnostic.code === "max_entries_exceeded"
      && diagnostic.sourceRefs[0]?.path === ".sdlc/z-wide"
    )),
    true,
  );
});

test("tolerates legacy records and isolates malformed JSON and JSONL", async (t) => {
  const root = await createProject(t);
  await writeJson(root, ".sdlc/project.json", {
    project_id: "legacy",
    project_name: "Legacy Project",
  });
  await writeText(root, ".sdlc/stories/ST-OLD/story.json", "{not-json");
  await writeText(root, ".sdlc/traces/ST-OLD.jsonl", [
    JSON.stringify({ id: "TR-OK", type: "decision", summary: "Recorded legacy decision." }),
    "{broken-line",
  ].join("\n"));

  const model = await buildObservatoryViewModel(root, {
    clock: () => FIXED_TIME,
    limits: { maxDiagnostics: 2 },
  });

  assert.equal(model.project.name, "Legacy Project");
  assert.equal(model.decisions.some((item) => item.id === "TR-OK"), true);
  assert.equal(model.records.some((record) => record.path.endsWith("story.json") && record.provenance === "malformed"), true);
  assert.equal(model.records.some((record) => record.line === 2 && record.provenance === "malformed"), true);
  assert.ok(model.diagnostics.length <= 2);
  assert.equal(model.diagnostics.some((diagnostic) => diagnostic.code === "diagnostics_truncated"), true);
});

test("materializes only the configured JSONL prefix and records deterministic truncation", async (t) => {
  const root = await createProject(t);
  await writeJson(root, ".sdlc/project.json", {
    schema_version: "0.1.0",
    project_id: "jsonl-prefix",
    project_name: "JSONL Prefix",
  });
  await writeJsonLines(root, ".sdlc/traces/prefix.jsonl", Array.from({ length: 20 }, (_, index) => ({
    id: `TR-${String(index + 1).padStart(2, "0")}`,
    type: "decision",
    summary: `Trace ${index + 1}`,
  })));

  const first = await buildObservatoryViewModel(root, {
    clock: () => FIXED_TIME,
    limits: { maxJsonLines: 2 },
  });
  const second = await buildObservatoryViewModel(root, {
    clock: () => FIXED_TIME,
    limits: { maxJsonLines: 2 },
  });

  assert.deepEqual(first, second);
  assert.deepEqual(first.decisions.map((item) => item.id), ["TR-01", "TR-02"]);
  assert.deepEqual(
    first.records.filter((record) => record.type === "trace").map((record) => record.line),
    [1, 2],
  );
  assert.equal(
    first.diagnostics.some((diagnostic) => diagnostic.code === "max_json_lines_exceeded"),
    true,
  );
});

test("does not report JSONL overflow for exactly the line limit plus a terminal newline", async (t) => {
  const root = await createProject(t);
  await writeJson(root, ".sdlc/project.json", {
    schema_version: "0.1.0",
    project_id: "jsonl-exact-limit",
    project_name: "JSONL Exact Limit",
  });
  await writeJsonLines(root, ".sdlc/traces/exact.jsonl", [{
    id: "TR-01",
    type: "decision",
    summary: "Trace 1",
  }, {
    id: "TR-02",
    type: "decision",
    summary: "Trace 2",
  }]);

  const model = await buildObservatoryViewModel(root, {
    clock: () => FIXED_TIME,
    limits: { maxJsonLines: 2 },
  });

  assert.deepEqual(model.decisions.map((item) => item.id), ["TR-01", "TR-02"]);
  assert.equal(
    model.diagnostics.some((diagnostic) => diagnostic.code === "max_json_lines_exceeded"),
    false,
  );
});

test("keeps bounded summary ranking and collection ordering stable across compaction batches", async (t) => {
  const root = await createProject(t);
  await writeJson(root, ".sdlc/project.json", {
    schema_version: "0.1.0",
    project_id: "bounded-ranking",
    project_name: "Bounded Ranking",
  });
  const older = Array.from({ length: 6 }, (_, index) => ({
    id: `OLD-${index + 1}`,
    type: "implementation",
    summary: `Older implementation ${index + 1}`,
    created_at: "2026-07-16T08:00:00Z",
  }));
  const tied = ["Z-TOP", "A-TOP", "M-TOP"].map((id) => ({
    id,
    type: "implementation",
    summary: `Tied implementation ${id}`,
    created_at: "2026-07-16T09:00:00Z",
  }));
  const newerSync = ["S-3", "S-1", "S-2"].map((id) => ({
    id,
    type: "sync",
    action: "story.release",
    summary: `Newer sync ${id}`,
    created_at: "2026-07-16T10:00:00Z",
  }));
  await writeJsonLines(root, ".sdlc/traces/ranking.jsonl", [...older, ...tied, ...newerSync]);

  const model = await buildObservatoryViewModel(root, {
    clock: () => FIXED_TIME,
    limits: { maxCollectionItems: 3 },
  });

  assert.deepEqual(model.summary.changed.map((item) => item.id), ["Z-TOP", "A-TOP", "M-TOP"]);
  assert.deepEqual(model.changes.map((item) => item.id), ["S-1", "S-2", "S-3"]);
});

test("redacts explicitly stored private reasoning from normalized and source views", async (t) => {
  const root = await createProject(t);
  await writeJson(root, ".sdlc/project.json", {
    schema_version: "0.1.0",
    project_id: "redaction",
    project_name: "Redaction",
  });
  await writeJsonLines(root, ".sdlc/traces/project.jsonl", [{
    id: "TR-PRIVATE",
    type: "decision",
    summary: "A safe recorded summary.",
    chain_of_thought: "must never be exposed",
    narrative: {
      generated_explanation: "unsafe narrative",
      rationale: "unsafe rationale",
      chain_of_thought_included: true,
    },
  }, {
    id: "TR-PRIVATE-VARIANTS",
    type: "decision",
    summary: "A second safe summary.",
    inputs: ["TOP_LEVEL_INPUT_SECRET"],
    outputs: ["TOP_LEVEL_OUTPUT_SECRET"],
    evidence: ["TOP_LEVEL_EVIDENCE_SECRET"],
    chainOfThought: "camel secret",
    "private-reasoning": "kebab secret",
    reasoningTrace: "trace secret",
    narrative: {
      explanation: { text: "MODEL_SECRET", kind: "codex-generated" },
      rationaleSummary: "RATIONALE_SECRET",
      input_summaries: ["INPUT_SECRET"],
      output_summaries: ["OUTPUT_SECRET"],
      alternatives: ["ALTERNATIVE_SECRET"],
      evidence: ["EVIDENCE_SECRET"],
      chainOfThoughtIncluded: true,
    },
  }]);

  const model = await buildObservatoryViewModel(root, { clock: () => FIXED_TIME });
  const decision = model.decisions.find((item) => item.id === "TR-PRIVATE");
  assert.equal(decision.explanation.text, "A safe recorded summary.");
  const privateDiagnostic = model.diagnostics.find(
    (diagnostic) => diagnostic.code === "private_reasoning_redacted",
  );
  assert.equal(privateDiagnostic.occurrences, 2);
  const variants = model.decisions.find((item) => item.id === "TR-PRIVATE-VARIANTS");
  assert.equal(variants.explanation.text, "A second safe summary.");
  assert.deepEqual(variants.inputs, []);
  assert.deepEqual(variants.outputs, []);
  assert.deepEqual(variants.alternatives, []);
  assert.deepEqual(variants.evidence, []);
  assert.equal(JSON.stringify(variants).includes("SECRET"), false);

  const source = await readSourceRecord(root, ".sdlc/traces/project.jsonl");
  assert.equal(source.entries[0].data.chain_of_thought, "[redacted]");
  assert.equal(source.entries[0].data.narrative.generated_explanation, "[redacted]");
  assert.equal(source.entries[0].data.narrative.rationale, "[redacted]");
  assert.deepEqual(source.redactions, [
    "/0/chain_of_thought",
    "/0/narrative/generated_explanation",
    "/0/narrative/rationale",
    "/1/chainOfThought",
    "/1/private-reasoning",
    "/1/reasoningTrace",
    "/1/narrative/explanation",
    "/1/narrative/rationaleSummary",
    "/1/narrative/input_summaries",
    "/1/narrative/output_summaries",
    "/1/narrative/alternatives",
    "/1/narrative/evidence",
  ]);
  assert.equal(source.entries[1].data.chainOfThought, "[redacted]");
  assert.equal(source.entries[1].data["private-reasoning"], "[redacted]");
  assert.equal(source.entries[1].data.narrative.explanation, "[redacted]");
  assert.equal(JSON.stringify(source).includes("MODEL_SECRET"), false);
});

test("bounds private-reasoning traversal iteratively and fails closed on extreme nesting", async (t) => {
  const root = await createProject(t);
  await writeJson(root, ".sdlc/project.json", {
    schema_version: "0.1.0",
    project_id: "deep-reasoning-scan",
    project_name: "Deep Reasoning Scan",
  });
  const depth = 12_000;
  const nested = `${'{"next":'.repeat(depth)}{"safe":true}${"}".repeat(depth)}`;
  await writeText(
    root,
    ".sdlc/decisions/DEEP.json",
    `{"id":"DEC-DEEP","summary":"A safe bounded summary.","payload":${nested}}\n`,
  );

  const model = await buildObservatoryViewModel(root, { clock: () => FIXED_TIME });
  const decision = model.decisions.find((item) => item.id === "DEC-DEEP");
  assert.ok(decision);
  assert.equal(decision.explanation.text, "A safe bounded summary.");
  assert.equal(decision.narrative, null);
  assert.equal(
    model.diagnostics.some((diagnostic) => diagnostic.code === "private_reasoning_scan_limited"),
    true,
  );
  assert.equal(
    model.diagnostics.some((diagnostic) => diagnostic.code === "private_reasoning_redacted"),
    true,
  );
});

test("fails closed before materializing an excessively wide private-reasoning stack", async (t) => {
  const root = await createProject(t);
  await writeJson(root, ".sdlc/project.json", {
    schema_version: "0.1.0",
    project_id: "wide-reasoning-scan",
    project_name: "Wide Reasoning Scan",
  });
  await writeJson(root, ".sdlc/decisions/WIDE.json", {
    id: "DEC-WIDE",
    summary: "A safe bounded summary.",
    payload: Array.from({ length: 25_100 }, () => ({})),
  });

  const model = await buildObservatoryViewModel(root, { clock: () => FIXED_TIME });
  const decision = model.decisions.find((item) => item.id === "DEC-WIDE");

  assert.ok(decision);
  assert.equal(decision.explanation.text, "A safe bounded summary.");
  assert.equal(decision.narrative, null);
  assert.equal(
    model.diagnostics.some((diagnostic) => diagnostic.code === "private_reasoning_scan_limited"),
    true,
  );
});

test("malformed structured sources fail closed without returning private bytes", async (t) => {
  const root = await createProject(t);
  await writeText(root, ".sdlc/private.json", '{"privateReasoning":"JSON_SECRET"');
  await writeText(root, ".sdlc/private.jsonl", '{"chain-of-thought":"JSONL_SECRET"\n');

  const malformedJson = await readSourceRecord(root, ".sdlc/private.json");
  assert.equal(malformedJson.provenance, "malformed");
  assert.equal(malformedJson.contentOmitted, true);
  assert.equal(Object.hasOwn(malformedJson, "raw"), false);
  assert.equal(JSON.stringify(malformedJson).includes("JSON_SECRET"), false);

  const malformedJsonl = await readSourceRecord(root, ".sdlc/private.jsonl");
  assert.equal(malformedJsonl.provenance, "malformed");
  assert.equal(malformedJsonl.entries[0].contentOmitted, true);
  assert.equal(Object.hasOwn(malformedJsonl.entries[0], "raw"), false);
  assert.equal(JSON.stringify(malformedJsonl).includes("JSONL_SECRET"), false);
});

test("bounds oversized normalization and raw-source responses", async (t) => {
  const root = await createProject(t);
  await writeText(root, ".sdlc/project.json", JSON.stringify({
    schema_version: "v1",
    project_id: "bounded",
    project_name: "Bounded",
  }));
  await writeJson(root, ".sdlc/requirements/REQ-BIG.json", {
    schema_version: "requirement:v1",
    id: "REQ-BIG",
    title: "Oversized requirement",
    summary: "x".repeat(1_000),
  });

  const model = await buildObservatoryViewModel(root, {
    clock: () => FIXED_TIME,
    limits: { maxFileBytes: 256, maxSourceBytes: 64 },
  });
  assert.equal(
    model.records.some((record) => record.path.endsWith("REQ-BIG.json") && record.provenance === "malformed"),
    true,
  );
  assert.equal(model.diagnostics.some((diagnostic) => diagnostic.code === "file_too_large"), true);
  const oversizedRecord = model.records.find((record) => record.path.endsWith("REQ-BIG.json"));
  assert.equal(oversizedRecord.rawAvailable, false);
  assert.equal(oversizedRecord.rawHref, null);

  await assert.rejects(
    () => readSourceRecord(root, ".sdlc/project.json", { limits: { maxSourceBytes: 32 } }),
    (error) => error?.code === "source_too_large" && error?.statusCode === 413,
  );
});

async function createProject(t, { knowledgeBase = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "change-observatory-normalizer-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  if (knowledgeBase) await fs.mkdir(path.join(root, ".sdlc"), { recursive: true });
  return root;
}

async function writeJson(root, relativePath, value) {
  await writeText(root, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeJsonLines(root, relativePath, values) {
  await writeText(root, relativePath, `${values.map((value) => JSON.stringify(value)).join("\n")}\n`);
}

async function writeText(root, relativePath, value) {
  const target = path.join(root, ...relativePath.split("/"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, value, "utf8");
}

test("cited log files are not reported as missing evidence", async (t) => {
  const root = await createProject(t);
  await writeJson(root, ".sdlc/project.json", { schema_version: "0.1.0", project_id: "logs", project_name: "Logs" });
  await writeJson(root, ".sdlc/stories/ST-L/story.json", { schema_version: "0.1.0", id: "ST-L", title: "Logs", status: "draft" });
  await writeText(root, ".sdlc/tests/ST-L-run.log", "ok\n");
  await writeJsonLines(root, ".sdlc/traces/ST-L.jsonl", [{
    id: "TR-L",
    story_id: "ST-L",
    type: "test",
    summary: "Tests passed.",
    evidence: [".sdlc/tests/ST-L-run.log", ".sdlc/tests/ST-L-gone.json"],
    created_at: "2026-07-16T08:40:00Z",
  }]);
  const model = await buildObservatoryViewModel(root);
  const codes = model.diagnostics.map((diagnostic) => diagnostic.code);
  assert.equal(codes.includes("dossier_evidence_target_unparsed_format"), true);
  assert.equal(
    model.diagnostics.filter((diagnostic) => diagnostic.code === "dossier_evidence_target_missing")
      .flatMap((diagnostic) => diagnostic.sourceRefs).length,
    1,
    "only the absent JSON file is missing",
  );
});
