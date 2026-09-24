import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ASSESSMENT_WORKFLOW_STATES,
  allowedAssessmentTransitions,
  buildAssessmentProposal,
  createAssessmentWorkflow,
  transitionAssessmentWorkflow,
  validateAssessmentWorkflowIntegrity,
} from "../../lib/assessment-workflow.mjs";
import { computeStableHash } from "../../lib/canonical.mjs";
import {
  SOFTWARE_PROJECT_PHASES,
  getWorkflowPreset,
} from "../../lib/workflow-presets.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const COMPAT_SNAPSHOT_PATH = path.join(
  REPO_ROOT,
  "templates",
  "config-compat",
  "sdlc-config-v1-0.11.0.json",
);
const EXPECTED_PHASES = Object.freeze([
  "discovery",
  "analysis",
  "design",
  "implementation",
  "validation",
  "release",
  "operations",
]);
/** The frozen v0.11.0 baseline predates the operations phase and must stay exactly as shipped. */
const EXPECTED_LEGACY_COMPAT_PHASES = Object.freeze([
  "discovery",
  "analysis",
  "design",
  "implementation",
  "validation",
  "release",
]);
const EXPECTED_ASSESSMENT_CHECKPOINTS = Object.freeze(["context", "combined-proposal"]);
const EXPECTED_COMPAT_HASH = "f460c67be74ec2e2385befa438b47740e2cb3400baf6327a03be9210634a419f";
const CREATED_AT = "2026-07-18T08:00:00.000Z";

const compatSnapshot = JSON.parse(fs.readFileSync(COMPAT_SNAPSHOT_PATH, "utf8"));

test("software-project keeps the existing seven phases from discovery through operations", () => {
  const preset = getWorkflowPreset("software-project");

  assert.deepEqual(SOFTWARE_PROJECT_PHASES, EXPECTED_PHASES);
  assert.deepEqual(preset.phase_order, EXPECTED_PHASES);
  assert.deepEqual(preset.states.map(({ id }) => id), EXPECTED_PHASES);
  assert.deepEqual(compatSnapshot.phase_order, EXPECTED_LEGACY_COMPAT_PHASES);
  assert.equal(preset.initial_state, "discovery");
  assert.equal(preset.states.at(-1).id, "operations");
  assert.equal(preset.states.at(-1).terminal, true);
});

test("technical-assessment keeps exactly the two normal user checkpoints", () => {
  const preset = getWorkflowPreset("technical-assessment");
  const guardedCheckpoints = preset.transitions.flatMap(({ guards }) =>
    guards
      .filter(({ id }) => id === "checkpoint-approved")
      .map(({ parameters }) => parameters.checkpoint));

  assert.equal(preset.metadata.normal_checkpoint_count, 2);
  assert.deepEqual(preset.normal_checkpoints, EXPECTED_ASSESSMENT_CHECKPOINTS);
  assert.deepEqual(guardedCheckpoints, EXPECTED_ASSESSMENT_CHECKPOINTS);
  assert.equal(compatSnapshot.assessment_workflow.normal_checkpoint_count, 2);
  assert.deepEqual(
    compatSnapshot.assessment_workflow.normal_checkpoints,
    EXPECTED_ASSESSMENT_CHECKPOINTS,
  );
});

test("technical-assessment mirrors the legacy v1 state graph and authorization boundary", () => {
  const preset = getWorkflowPreset("technical-assessment");
  const presetTransitions = new Map(ASSESSMENT_WORKFLOW_STATES.map((state) => [state, []]));
  for (const transition of preset.transitions) {
    presetTransitions.get(transition.from).push(transition.to);
  }

  assert.deepEqual(preset.states.map(({ id }) => id), ASSESSMENT_WORKFLOW_STATES);
  for (const state of ASSESSMENT_WORKFLOW_STATES) {
    assert.deepEqual(
      presetTransitions.get(state),
      allowedAssessmentTransitions(state),
      `transition compatibility for ${state}`,
    );
  }

  const proposal = buildAssessmentProposal({
    id: "compat-assessment",
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    objective: "Verify workflow compatibility",
    baseline_ref: null,
    scope: {},
    story_reservation: null,
    deliverable: {},
    capabilities: {},
    contract_draft: null,
    route_intent: null,
    write_set: [],
    execution_budget: null,
    security: {},
    approvals: [],
    authorization_ref: null,
    application: {},
  });
  const contextPending = createAssessmentWorkflow({
    proposal,
    state: "context_pending",
    created_at: CREATED_AT,
  });
  const proposalPending = transitionAssessmentWorkflow(contextPending, "proposal_pending", {
    at: "2026-07-18T08:01:00.000Z",
    idempotency_key: "approve-context",
  });

  assert.equal(contextPending.schema_version, "assessment-workflow:v1");
  assert.equal(proposalPending.state, "proposal_pending");
  assert.throws(
    () => transitionAssessmentWorkflow(proposalPending, "authorized", {
      at: "2026-07-18T08:02:00.000Z",
    }),
    /authorization_ref/u,
  );

  const authorized = transitionAssessmentWorkflow(proposalPending, "authorized", {
    at: "2026-07-18T08:02:00.000Z",
    authorization_ref: "compat-authorization",
    idempotency_key: "approve-combined-proposal",
  });
  assert.equal(authorized.schema_version, "assessment-workflow:v1");
  assert.equal(authorized.state, "authorized");
  assert.equal(validateAssessmentWorkflowIntegrity(authorized).valid, true);
});

test("the frozen 0.11.0 config snapshot remains byte-semantically compatible", () => {
  assert.equal(compatSnapshot.config_schema_version, "sdlc-config:v1");
  assert.equal(compatSnapshot.schema_version, "0.1.0");
  assert.equal(compatSnapshot.assessment_workflow.workflow_schema, "schemas/assessment-workflow.schema.json");
  assert.equal(computeStableHash(compatSnapshot), EXPECTED_COMPAT_HASH);
});
