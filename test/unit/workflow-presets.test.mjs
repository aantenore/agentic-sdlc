import test from "node:test";
import assert from "node:assert/strict";

import { applyWorkflowOverlay, validateWorkflowDefinition } from "../../lib/workflow-engine.mjs";
import {
  SOFTWARE_PROJECT_PHASES,
  buildWorkflowPreset,
  getWorkflowPreset,
  listWorkflowPresets,
} from "../../lib/workflow-presets.mjs";

const EXPECTED_PRESETS = [
  "software-project",
  "change-request",
  "technical-assessment",
  "generic-governed-process",
];

test("catalog exposes exactly the four governed presets", () => {
  const listed = listWorkflowPresets();
  assert.deepEqual(listed.map(({ id }) => id), EXPECTED_PRESETS);
  assert.deepEqual(
    listed.find(({ id }) => id === "software-project"),
    {
      id: "software-project",
      version: "3",
      available_versions: ["1", "2", "3"],
      status: "included",
      label: "Software project",
      description: "Software project governed workflow preset.",
      state_count: 7,
      journey: SOFTWARE_PROJECT_PHASES,
      review_moments: [],
      governance_controls: [
        "requirement-approved",
        "contract-approved",
        "required-output-linked",
        "strict-gate-passed",
      ],
      metadata: {
        compatibility: { phase_order: SOFTWARE_PROJECT_PHASES },
        governance_binding: "story",
        canonical_evidence_schema: "workflow-canonical-evidence:v2",
      },
    },
  );
  assert.throws(() => getWorkflowPreset("unknown"), /Unknown workflow preset/u);
});

test("software-project preserves the exact seven existing SDLC phases and order", () => {
  const preset = getWorkflowPreset("software-project");
  assert.deepEqual(SOFTWARE_PROJECT_PHASES, [
    "discovery", "analysis", "design", "implementation", "validation", "release", "operations",
  ]);
  assert.deepEqual(preset.states.map(({ id }) => id), SOFTWARE_PROJECT_PHASES);
  assert.equal(preset.initial_state, "discovery");
  assert.equal(preset.states.at(-1).terminal, true);
});

test("software-project phase changes are bound to canonical lifecycle evidence", () => {
  const preset = getWorkflowPreset("software-project", 3);
  const guardsByRoute = Object.fromEntries(preset.transitions.map((transition) => [
    `${transition.from}->${transition.to}`,
    transition.guards.map((guard) => guard.id),
  ]));

  assert.deepEqual(guardsByRoute, {
    "discovery->analysis": ["requirement-approved"],
    "analysis->design": [],
    "design->implementation": ["contract-approved"],
    "implementation->validation": ["required-output-linked"],
    "validation->release": ["strict-gate-passed"],
    "release->operations": [],
  });
  assert.equal(preset.metadata.governance_binding, "story");
  assert.equal(preset.metadata.canonical_evidence_schema, "workflow-canonical-evidence:v2");
});

test("software-project preserves legacy v1/v2 hashes while v3 pins phase-bound evidence", () => {
  const legacy = buildWorkflowPreset("software-project", { version: 1 });
  const legacyGoverned = buildWorkflowPreset("software-project", { version: 2 });
  const governed = buildWorkflowPreset("software-project", { version: 3 });

  assert.equal(legacy.version, "1");
  assert.equal(
    legacy.definition_hash,
    "b47f93c2d7657b0c5802103317e388b338ea78761bc0ee978f13aa83eb68ab0b",
  );
  assert.equal(legacyGoverned.version, "2");
  assert.equal(
    legacyGoverned.definition_hash,
    "0141bde059ab92d4e54662cb6b88b63aeeaa78b85362c294601d789203067592",
  );
  assert.equal(
    legacyGoverned.metadata.canonical_evidence_schema,
    "workflow-canonical-evidence:v1",
  );
  assert.equal(governed.version, "3");
  assert.equal(
    governed.metadata.canonical_evidence_schema,
    "workflow-canonical-evidence:v2",
  );
  assert.equal(legacy.transitions.every((transition) => transition.guards.length === 0), true);
  assert.equal(legacy.metadata.governance_binding, undefined);
  assert.equal(governed.metadata.governance_binding, "story");
  assert.notEqual(legacyGoverned.definition_hash, governed.definition_hash);
  assert.throws(
    () => buildWorkflowPreset("software-project", { version: 4 }),
    /available versions: 1, 2, 3/u,
  );
});

test("technical-assessment has exactly two normal approval checkpoints", () => {
  const preset = getWorkflowPreset("technical-assessment");
  const checkpointTransitions = preset.transitions.filter((transition) =>
    transition.guards.some((guard) => guard.id === "checkpoint-approved"));

  assert.equal(preset.metadata.workflow_kind, "technical_assessment");
  assert.equal(preset.metadata.normal_checkpoint_count, 2);
  assert.equal(checkpointTransitions.length, 2);
  assert.deepEqual(checkpointTransitions.map(({ guards }) => guards[0].parameters.checkpoint), ["context", "combined-proposal"]);
  assert.deepEqual(preset.normal_checkpoints, ["context", "combined-proposal"]);
  assert.deepEqual(preset.states.map(({ id }) => id), [
    "context_pending", "proposal_pending", "authorized", "running", "verifying", "completed",
    "exception_pending", "failed", "cancelled",
  ]);
});

test("every preset materializes as a deterministic approved immutable definition", () => {
  for (const id of EXPECTED_PRESETS) {
    const first = buildWorkflowPreset(id);
    const second = buildWorkflowPreset(id);
    assert.equal(first.status, "approved", id);
    assert.equal(first.definition_hash, second.definition_hash, id);
    assert.equal(validateWorkflowDefinition(first).valid, true, id);
    assert.equal(Object.isFrozen(first), true, id);
    const effective = applyWorkflowOverlay(first);
    assert.equal(effective.overlay_ref, null, id);
    assert.equal(effective.states.at(-1).terminal, true, id);
  }
});

test("preset templates are immutable and custom ids create a distinct definition identity", () => {
  const template = getWorkflowPreset("change-request");
  assert.equal(Object.isFrozen(template), true);
  assert.throws(() => template.states.push({}), TypeError);

  const builtIn = buildWorkflowPreset("change-request");
  const customized = buildWorkflowPreset("change-request", { id: "travel-change-request" });
  assert.notEqual(customized.definition_hash, builtIn.definition_hash);
  assert.equal(customized.id, "travel-change-request");
  assert.deepEqual(customized.states.map(({ id }) => id), builtIn.states.map(({ id }) => id));
});
