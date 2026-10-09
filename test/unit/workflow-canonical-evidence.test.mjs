import assert from "node:assert/strict";
import test from "node:test";

import { STABLE_JSON_HASH_ALGORITHM, computeStableHash } from "../../lib/canonical.mjs";
import {
  WORKFLOW_CANONICAL_EVIDENCE_SCHEMA,
  WORKFLOW_FINAL_GATE_RECEIPT_SCHEMA,
  WORKFLOW_LEGACY_CANONICAL_EVIDENCE_SCHEMA,
  WORKFLOW_LEGACY_STRICT_GATE_RECEIPT_SCHEMA,
  WORKFLOW_STRICT_GATE_RECEIPT_SCHEMA,
  buildLegacyWorkflowCanonicalEvidence,
  buildWorkflowCanonicalEvidence,
  buildWorkflowFinalGateReceipt,
  buildWorkflowStrictGateReceipt,
  canonicalWorkflowGuardResult,
  computeGovernedApprovalSubjectHash,
  hasValidWorkflowReceiptHash,
  selectRequiredOutputRefsForPhase,
  validateWorkflowCanonicalEvidence,
} from "../../lib/workflow-canonical-evidence.mjs";

const OBSERVED_AT = "2026-07-28T10:10:00.000Z";

function finalFreshnessProof(storyId, instanceId = "delivery-42") {
  const subject = {
    schema_version: "workflow-final-freshness-proof:v2",
    story_id: storyId,
    workflow_instance_id: instanceId,
    governed_files: [],
    output_registry_projection: {
      path: `.sdlc/output-contracts/registry.json#story=${storyId}`,
      sha256: "a".repeat(64),
    },
    local_release_root: null,
    local_release_scope: [],
    git_scope: {
      schema_version: "workflow-final-git-scope:v2",
      available: false,
      baseline_head_sha: null,
      certification_head_sha: null,
      scoped_state_hash: null,
      scoped_head_tree_hash: null,
      scoped_changes: [],
    },
    hash_algorithm: STABLE_JSON_HASH_ALGORITHM,
  };
  return {
    ...subject,
    proof_hash: computeStableHash(subject),
  };
}

test("canonical evidence binds one workflow instance to fresh lifecycle records", () => {
  const bundle = canonicalBundle();
  const evidence = buildWorkflowCanonicalEvidence(bundle);

  assert.equal(evidence.schema_version, WORKFLOW_CANONICAL_EVIDENCE_SCHEMA);
  assert.equal(evidence.schema_version, "workflow-canonical-evidence:v2");
  assert.equal(validateWorkflowCanonicalEvidence(evidence, {
    instance_id: "delivery-42",
    story_id: "ST-42",
  }).valid, true);
  assert.equal(Object.isFrozen(evidence), true);
  assert.deepEqual(evidence.output_scope, {
    current_phase: "validation",
    phase_order: SOFTWARE_PHASES,
    require_all: false,
  });
  assert.equal(evidence.workflow_scope.current_phase, "validation");
  assert.deepEqual(
    Object.fromEntries(Object.entries(evidence.checks).map(([id, check]) => [id, check.satisfied])),
    {
      requirement_approved: true,
      contract_approved: true,
      required_output_linked: true,
      strict_gate_passed: true,
      delivery_terminal: true,
    },
  );
  for (const guardId of [
    "requirement-approved",
    "contract-approved",
    "required-output-linked",
    "strict-gate-passed",
    "delivery-terminal",
  ]) {
    assert.equal(canonicalWorkflowGuardResult(guardId, evidence).allowed, true, guardId);
  }
  assert.equal(
    evidence.checks.strict_gate_passed.receipt_schema,
    WORKFLOW_STRICT_GATE_RECEIPT_SCHEMA,
  );
  assert.equal(
    evidence.checks.strict_gate_passed.receipt_path,
    ".sdlc/gates/ST-42-strict.json",
  );
});

test("legacy evidence remains an explicit all-due compatibility contract", () => {
  const bundle = canonicalBundle();
  bundle.gate_report.schema_version = WORKFLOW_LEGACY_STRICT_GATE_RECEIPT_SCHEMA;
  delete bundle.gate_report.workflow_scope;
  resealReceipt(bundle.gate_report);
  const evidence = buildLegacyWorkflowCanonicalEvidence(bundle);

  assert.equal(
    evidence.schema_version,
    WORKFLOW_LEGACY_CANONICAL_EVIDENCE_SCHEMA,
  );
  assert.equal(Object.hasOwn(evidence, "output_scope"), false);
  assert.equal(Object.hasOwn(evidence, "workflow_scope"), false);
  assert.equal(validateWorkflowCanonicalEvidence(evidence, {
    instance_id: "delivery-42",
    story_id: "ST-42",
    expected_schema_version: WORKFLOW_LEGACY_CANONICAL_EVIDENCE_SCHEMA,
  }).valid, true);
  assert.equal(validateWorkflowCanonicalEvidence(evidence).valid, false);
  assert.equal(evidence.checks.required_output_linked.required_count, 1);
  assert.equal(evidence.checks.strict_gate_passed.satisfied, true);
});

test("canonical checks fail closed for stale, missing, or unsuccessful records", () => {
  const cases = [
    ["requirement_approved", (bundle) => { bundle.requirements[0].status = "draft"; }],
    ["contract_approved", (bundle) => { bundle.contract.status = "draft"; }],
    ["required_output_linked", (bundle) => { bundle.output_registry.links = []; }],
    ["strict_gate_passed", (bundle) => {
      bundle.gate_report.status = "failed";
      resealReceipt(bundle.gate_report);
    }],
    ["delivery_terminal", (bundle) => {
      bundle.delivery_close_receipt.terminal_status = "cancelled";
      resealReceipt(bundle.delivery_close_receipt);
    }],
  ];

  for (const [checkId, mutate] of cases) {
    const bundle = canonicalBundle();
    mutate(bundle);
    const evidence = buildWorkflowCanonicalEvidence(bundle);
    assert.equal(evidence.checks[checkId].satisfied, false, checkId);
    assert.ok(evidence.checks[checkId].issues.length > 0, checkId);
  }
});

test("phase-scoped output evidence requires only outputs due through the current workflow phase", () => {
  const bundle = canonicalBundle();
  bundle.contract.output_contract_refs[0].phase = "implementation";
  bundle.contract.output_contract_refs.push(
    {
      artifact_type: "validation-report",
      template_id: "validation-report-v1",
      mode: "new",
      phase: "validation",
    },
    {
      artifact_type: "release-notes",
      template_id: "release-notes-v1",
      mode: "new",
      phase: "release",
    },
  );
  bundle.contract.approvals.at(-1).approved_content_hash =
    computeGovernedApprovalSubjectHash(bundle.contract);
  bundle.delivery_profile.contract_refs[0].hash =
    computeGovernedApprovalSubjectHash(bundle.contract);
  bundle.output_scope = {
    current_phase: "implementation",
    phase_order: ["discovery", "analysis", "design", "implementation", "validation", "release"],
    require_all: false,
  };

  const evidence = buildWorkflowCanonicalEvidence(bundle);

  assert.equal(evidence.checks.required_output_linked.satisfied, true);
  assert.equal(evidence.checks.required_output_linked.total_required_count, 3);
  assert.equal(evidence.checks.required_output_linked.required_count, 1);
  assert.equal(evidence.checks.required_output_linked.deferred_count, 2);
  assert.deepEqual(
    evidence.checks.required_output_linked.deferred_refs.map((ref) => ref.phase),
    ["validation", "release"],
  );

  bundle.output_scope.current_phase = "validation";
  const validationEvidence = buildWorkflowCanonicalEvidence(bundle);
  assert.equal(validationEvidence.checks.required_output_linked.satisfied, false);
  assert.equal(validationEvidence.checks.strict_gate_passed.satisfied, false);
  assert.match(
    validationEvidence.checks.required_output_linked.issues.join("\n"),
    /required output validation-report is not linked/u,
  );
  assert.match(
    validationEvidence.checks.strict_gate_passed.issues.join("\n"),
    /required output validation-report is not linked/u,
  );
});

test("an early-phase strict receipt cannot be reused at a later guarded phase", () => {
  const bundle = canonicalBundle();
  bundle.gate_report = structuredClone(buildWorkflowStrictGateReceipt({
    status: "passed",
    strict: true,
    scope: "story",
    lifecycle_complete: false,
    certification_level: "strict_intermediate",
    story_id: "ST-42",
    checked_at: "2026-07-28T10:09:00.000Z",
    errors: [],
    workflow_scope: workflowScope({
      current_phase: "implementation",
      checkpoint_ref: {
        checkpoint_hash: "6".repeat(64),
        sequence: 3,
        last_event_hash: "7".repeat(64),
        trace_chain_hash: "8".repeat(64),
        updated_at: "2026-07-28T10:06:30.000Z",
      },
    }),
  }, {
    strict_receipt_path: ".sdlc/gates/ST-42-strict.json",
  }));

  const evidence = buildWorkflowCanonicalEvidence(bundle);

  assert.equal(evidence.output_scope.current_phase, "validation");
  assert.equal(evidence.checks.strict_gate_passed.satisfied, false);
  assert.match(
    evidence.checks.strict_gate_passed.issues.join("\n"),
    /different workflow stream position|does not match the canonical output phase scope/u,
  );
});

test("a legacy unscoped strict receipt remains readable but cannot satisfy the guard", () => {
  const bundle = canonicalBundle();
  bundle.gate_report.schema_version = WORKFLOW_LEGACY_STRICT_GATE_RECEIPT_SCHEMA;
  delete bundle.gate_report.workflow_scope;
  resealReceipt(bundle.gate_report);

  const evidence = buildWorkflowCanonicalEvidence(bundle);

  assert.equal(evidence.checks.strict_gate_passed.satisfied, false);
  assert.match(
    evidence.checks.strict_gate_passed.issues.join("\n"),
    /legacy intermediate strict gate receipt is not bound/u,
  );
});

test("canonical guard denial exposes every missing output issue", () => {
  const bundle = canonicalBundle();
  bundle.contract.output_contract_refs.push({
    artifact_type: "validation-report",
    template_id: "validation-report-v1",
    mode: "new",
  });
  bundle.contract.approvals.at(-1).approved_content_hash =
    computeGovernedApprovalSubjectHash(bundle.contract);
  bundle.delivery_profile.contract_refs[0].hash =
    computeGovernedApprovalSubjectHash(bundle.contract);
  bundle.output_registry.links = [];

  const evidence = buildWorkflowCanonicalEvidence(bundle);
  const result = canonicalWorkflowGuardResult("required-output-linked", evidence);

  assert.equal(result.allowed, false);
  assert.deepEqual(result.issues, [
    "required output implementation-summary is not linked",
    "required output validation-report is not linked",
  ]);
  assert.equal(result.reason, result.issues[0]);
  assert.equal(evidence.checks.strict_gate_passed.satisfied, false);
  assert.deepEqual(
    evidence.checks.strict_gate_passed.issues.filter((issue) =>
      issue.startsWith("required output")),
    result.issues,
  );
});

test("legacy unphased and unknown-phase output refs remain fail-closed", () => {
  const phaseOrder = ["discovery", "analysis", "design", "implementation", "validation", "release"];
  const legacy = selectRequiredOutputRefsForPhase([
    {
      artifact_type: "legacy-output",
      template_id: "legacy-output-v1",
      mode: "new",
    },
    {
      artifact_type: "release-notes",
      template_id: "release-notes-v1",
      mode: "new",
      phase: "release",
    },
  ], {
    current_phase: "implementation",
    phase_order: phaseOrder,
    require_all: false,
  });
  assert.deepEqual(legacy.required_refs.map((item) => item.index), [0]);
  assert.deepEqual(legacy.deferred_refs.map((item) => item.index), [1]);

  const invalid = selectRequiredOutputRefsForPhase([
    {
      artifact_type: "mystery",
      template_id: "mystery-v1",
      mode: "new",
      phase: "not-configured",
    },
  ], {
    current_phase: "implementation",
    phase_order: phaseOrder,
    require_all: false,
  });
  assert.equal(invalid.valid, false);
  assert.deepEqual(invalid.required_refs.map((item) => item.index), [0]);
  assert.match(invalid.issues.join("\n"), /unknown phase 'not-configured'/u);
});

test("a formally closed pull request is terminal but not a successful delivery", () => {
  const bundle = canonicalBundle();
  bundle.delivery_profile.delivery_kind = "pull_request";
  bundle.delivery_close_receipt.delivery.kind = "pull_request";
  bundle.delivery_close_receipt.terminal_status = "closed";
  resealReceipt(bundle.delivery_close_receipt);

  const evidence = buildWorkflowCanonicalEvidence(bundle);

  assert.equal(evidence.checks.delivery_terminal.satisfied, false);
  assert.match(
    evidence.checks.delivery_terminal.issues.join("\n"),
    /delivery terminal outcome 'closed' is not successful/u,
  );
});

test("a pull request merged outside the plugin certifies with a reduced label", () => {
  const bundle = canonicalBundle();
  bundle.delivery_profile.delivery_kind = "pull_request";
  bundle.delivery_close_receipt.delivery.kind = "pull_request";
  bundle.delivery_close_receipt.terminal_status = "merged_externally";
  resealReceipt(bundle.delivery_close_receipt);

  const evidence = buildWorkflowCanonicalEvidence(bundle);

  assert.equal(evidence.checks.delivery_terminal.satisfied, true);
  assert.equal(evidence.checks.delivery_terminal.certification, "externally_reconciled");
  assert.deepEqual(validateWorkflowCanonicalEvidence(evidence).errors, []);
  const governed = buildWorkflowCanonicalEvidence(canonicalBundle());
  assert.equal(governed.checks.delivery_terminal.certification, undefined);
});

test("strict gate must be newer than output links and the terminal delivery receipt", () => {
  const bundle = canonicalBundle();
  bundle.gate_report.checked_at = "2026-07-28T10:06:00.000Z";
  resealReceipt(bundle.gate_report);
  const evidence = buildWorkflowCanonicalEvidence(bundle);

  assert.equal(evidence.checks.delivery_terminal.satisfied, true);
  assert.equal(evidence.checks.strict_gate_passed.satisfied, false);
  assert.match(evidence.checks.strict_gate_passed.issues.join("\n"), /predates required output or delivery evidence/u);
});

test("evidence integrity and instance/story pins reject substitution", () => {
  const evidence = structuredClone(buildWorkflowCanonicalEvidence(canonicalBundle()));
  evidence.checks.requirement_approved.satisfied = false;

  assert.equal(validateWorkflowCanonicalEvidence(evidence).valid, false);
  assert.match(validateWorkflowCanonicalEvidence(evidence).errors.join("\n"), /evidence_hash does not match/u);

  const valid = buildWorkflowCanonicalEvidence(canonicalBundle());
  assert.equal(validateWorkflowCanonicalEvidence(valid, { instance_id: "other" }).valid, false);
  assert.equal(validateWorkflowCanonicalEvidence(valid, { story_id: "ST-other" }).valid, false);
  assert.equal(validateWorkflowCanonicalEvidence(valid, {
    current_phase: "implementation",
    phase_order: SOFTWARE_PHASES,
  }).valid, false);
  assert.equal(validateWorkflowCanonicalEvidence(valid, {
    current_phase: "validation",
    phase_order: [...SOFTWARE_PHASES].reverse(),
  }).valid, false);

  const scopeTamper = structuredClone(valid);
  scopeTamper.output_scope.current_phase = "implementation";
  assert.match(
    validateWorkflowCanonicalEvidence(scopeTamper).errors.join("\n"),
    /evidence_hash does not match|does not match its output_scope/u,
  );
});

test("only one passing strict lifecycle gate can become the governed final receipt", () => {
  const report = {
    status: "passed",
    strict: true,
    scope: "story",
    lifecycle_complete: true,
    certification_level: "lifecycle_complete",
    lifecycle_workflow: lifecycleWorkflowEvidence("ST-42"),
    freshness_proof: finalFreshnessProof("ST-42"),
    story_id: "ST-42",
    checked_at: "2026-07-28T10:09:00.000Z",
    errors: [],
  };
  const receipt = buildWorkflowFinalGateReceipt(report, {
    final_receipt_path: ".sdlc/gates/ST-42-final.json",
  });

  assert.equal(receipt.kind, "workflow_final_gate_receipt");
  assert.equal(receipt.schema_version, WORKFLOW_FINAL_GATE_RECEIPT_SCHEMA);
  assert.match(receipt.receipt_hash, /^[a-f0-9]{64}$/u);
  assert.equal(hasValidWorkflowReceiptHash(receipt), true);
  assert.equal(
    hasValidWorkflowReceiptHash({ ...receipt, checked_at: "2026-07-28T10:09:01.000Z" }),
    false,
  );
  assert.throws(
    () => buildWorkflowFinalGateReceipt(
      { ...report, status: "failed", errors: ["blocked"] },
      { final_receipt_path: ".sdlc/gates/ST-42-final.json" },
    ),
    /requires one passing lifecycle-complete strict story gate/u,
  );
  const incompleteWorkflow = structuredClone(report.lifecycle_workflow);
  delete incompleteWorkflow.checkpoint_ref.trace_chain_hash;
  assert.throws(
    () => buildWorkflowFinalGateReceipt(
      { ...report, lifecycle_workflow: incompleteWorkflow },
      { final_receipt_path: ".sdlc/gates/ST-42-final.json" },
    ),
    /requires one passing lifecycle-complete strict story gate/u,
  );
  assert.throws(
    () => buildWorkflowFinalGateReceipt(
      report,
      { final_receipt_path: ".sdlc/gates/ST-OTHER-final.json" },
    ),
    /path must bind the exact governed story/u,
  );
  const outOfOrderWorkflow = structuredClone(report.lifecycle_workflow);
  outOfOrderWorkflow.phase_timeline[1].entered_at = "2026-07-28T10:00:30.000Z";
  assert.throws(
    () => buildWorkflowFinalGateReceipt(
      { ...report, lifecycle_workflow: outOfOrderWorkflow },
      { final_receipt_path: ".sdlc/gates/ST-42-final.json" },
    ),
    /requires one passing lifecycle-complete strict story gate/u,
  );
  const postHocWorkflow = structuredClone(report.lifecycle_workflow);
  postHocWorkflow.task_start_ref.confirmed_at = "2026-07-28T09:59:59.000Z";
  assert.throws(
    () => buildWorkflowFinalGateReceipt(
      { ...report, lifecycle_workflow: postHocWorkflow },
      { final_receipt_path: ".sdlc/gates/ST-42-final.json" },
    ),
    /requires one passing lifecycle-complete strict story gate/u,
  );
  const postCompletionTaskStart = structuredClone(report.lifecycle_workflow);
  postCompletionTaskStart.task_start_ref.confirmed_at = "2026-07-28T10:01:30.000Z";
  assert.throws(
    () => buildWorkflowFinalGateReceipt(
      { ...report, lifecycle_workflow: postCompletionTaskStart },
      { final_receipt_path: ".sdlc/gates/ST-42-final.json" },
    ),
    /requires one passing lifecycle-complete strict story gate/u,
  );
  const replayedPostTransitionTaskStart = structuredClone(report.lifecycle_workflow);
  replayedPostTransitionTaskStart.task_start_ref.confirmed_at = "2026-07-28T10:02:30.000Z";
  assert.throws(
    () => buildWorkflowFinalGateReceipt(
      { ...report, lifecycle_workflow: replayedPostTransitionTaskStart },
      { final_receipt_path: ".sdlc/gates/ST-42-final.json" },
    ),
    /requires one passing lifecycle-complete strict story gate/u,
  );
});

test("intermediate and final workflow gate receipts have distinct identities and cannot be exchanged", () => {
  const strictReport = {
    status: "passed",
    strict: true,
    scope: "story",
    lifecycle_complete: false,
    certification_level: "strict_intermediate",
    story_id: "ST-42",
    checked_at: "2026-07-28T10:09:00.000Z",
    errors: [],
    workflow_scope: workflowScope(),
  };
  const strictReceipt = buildWorkflowStrictGateReceipt(strictReport, {
    strict_receipt_path: ".sdlc/gates/ST-42-strict.json",
  });
  assert.equal(strictReceipt.kind, "workflow_strict_gate_receipt");
  assert.equal(strictReceipt.schema_version, WORKFLOW_STRICT_GATE_RECEIPT_SCHEMA);
  assert.equal(Object.hasOwn(strictReceipt, "final_receipt_path"), false);
  assert.throws(
    () => buildWorkflowFinalGateReceipt(strictReceipt, {
      final_receipt_path: ".sdlc/gates/ST-42-final.json",
    }),
    /lifecycle-complete strict story gate/u,
  );
  assert.throws(
    () => buildWorkflowStrictGateReceipt({
      ...strictReceipt,
      lifecycle_complete: true,
      certification_level: "lifecycle_complete",
    }, {
      strict_receipt_path: ".sdlc/gates/ST-42-strict.json",
    }),
    /non-final strict story gate/u,
  );
  assert.throws(
    () => buildWorkflowStrictGateReceipt(
      { ...strictReport, lifecycle_complete: undefined },
      { strict_receipt_path: ".sdlc/gates/ST-42-strict.json" },
    ),
    /non-final strict story gate/u,
  );
  assert.throws(
    () => buildWorkflowStrictGateReceipt(
      {
        ...strictReport,
        workflow_scope: workflowScope({ phase_order: [] }),
      },
      { strict_receipt_path: ".sdlc/gates/ST-42-strict.json" },
    ),
    /phase_order must contain at least one phase/u,
  );
  assert.throws(
    () => buildWorkflowStrictGateReceipt(
      { ...strictReport, checked_at: "2026-07-28T10:08:00.000Z" },
      { strict_receipt_path: ".sdlc/gates/ST-42-strict.json" },
    ),
    /cannot predate its bound workflow checkpoint/u,
  );
});

test("strict gate chronology is bounded by its workflow checkpoint and evidence observation", () => {
  const futureGate = canonicalBundle();
  futureGate.gate_report.checked_at = "2026-07-28T10:11:00.000Z";
  resealReceipt(futureGate.gate_report);

  const futureEvidence = buildWorkflowCanonicalEvidence(futureGate);
  assert.equal(futureEvidence.checks.strict_gate_passed.satisfied, false);
  assert.match(
    futureEvidence.checks.strict_gate_passed.issues.join("\n"),
    /postdates the canonical evidence observation/u,
  );

  const staleObservation = canonicalBundle();
  staleObservation.observed_at = "2026-07-28T10:08:00.000Z";
  assert.throws(
    () => buildWorkflowCanonicalEvidence(staleObservation),
    /cannot predate its bound workflow checkpoint/u,
  );
});

test("an integrity-sealed but incomplete final v3 receipt cannot satisfy the strict workflow guard", () => {
  const bundle = canonicalBundle();
  const validFinal = buildWorkflowFinalGateReceipt({
    status: "passed",
    strict: true,
    scope: "story",
    lifecycle_complete: true,
    certification_level: "lifecycle_complete",
    lifecycle_workflow: lifecycleWorkflowEvidence("ST-42"),
    freshness_proof: finalFreshnessProof("ST-42"),
    story_id: "ST-42",
    checked_at: "2026-07-28T10:09:00.000Z",
    errors: [],
  }, {
    final_receipt_path: ".sdlc/gates/ST-42-final.json",
  });
  bundle.gate_report = structuredClone(validFinal);
  delete bundle.gate_report.lifecycle_workflow.checkpoint_ref.trace_chain_hash;
  resealReceipt(bundle.gate_report);

  const evidence = buildWorkflowCanonicalEvidence(bundle);

  assert.equal(evidence.checks.strict_gate_passed.satisfied, false);
  assert.match(
    evidence.checks.strict_gate_passed.issues.join("\n"),
    /lacks a complete terminal workflow proof/u,
  );
});

function canonicalBundle() {
  const requirement = approvedRecord({
    id: "REQ-42",
    kind: "requirement",
    schema_version: "requirement:v2",
    revision: 1,
    title: "Governed delivery",
  });
  const story = {
    id: "ST-42",
    status: "draft",
    contract_id: "contract-ST-42-implementation",
    requirement_refs: [{
      id: requirement.id,
      revision: requirement.revision,
      content_hash: computeGovernedApprovalSubjectHash(requirement),
      path: `.sdlc/requirements/${requirement.id}.json`,
    }],
    created_at: "2026-07-28T10:00:00.000Z",
    updated_at: "2026-07-28T10:00:00.000Z",
  };
  const contract = approvedRecord({
    id: "contract-ST-42-implementation",
    story_id: story.id,
    delivery_execution_profile_id: "AUT-42",
    output_contract_refs: [{
      artifact_type: "implementation-summary",
      template_id: "implementation-summary-v1",
      mode: "new",
    }],
    purpose: "Implement the approved story.",
  });
  const profile = {
    id: "AUT-42",
    status: "active",
    profile_hash: "a".repeat(64),
    delivery_id: "LOCAL-42",
    delivery_kind: "local_release",
    story_refs: [{
      id: story.id,
      hash: computeGovernedApprovalSubjectHash(story),
    }],
    contract_refs: [{
      id: contract.id,
      hash: computeGovernedApprovalSubjectHash(contract),
    }],
  };
  const close = {
    id: "AUT-CLOSE-42",
    profile_ref: { id: profile.id, hash: profile.profile_hash },
    delivery: { id: profile.delivery_id, kind: profile.delivery_kind },
    terminal_status: "released",
    closed_at: "2026-07-28T10:08:00.000Z",
    hash_algorithm: STABLE_JSON_HASH_ALGORITHM,
  };
  resealReceipt(close);
  const verification = {
    id: "VERIFY-42",
    status: "passed",
    passed: true,
    subject_ref: { id: "OUT-42" },
    hash_algorithm: STABLE_JSON_HASH_ALGORITHM,
  };
  resealReceipt(verification);
  const gateReport = buildWorkflowStrictGateReceipt({
    status: "passed",
    strict: true,
    scope: "story",
    lifecycle_complete: false,
    certification_level: "strict_intermediate",
    story_id: story.id,
    checked_at: "2026-07-28T10:09:00.000Z",
    errors: [],
    workflow_scope: workflowScope(),
  }, {
    strict_receipt_path: `.sdlc/gates/${story.id}-strict.json`,
  });
  return {
    instance: {
      id: "delivery-42",
      instance_hash: "1".repeat(64),
      effective_hash: "2".repeat(64),
      metadata: { governance_binding: { story_id: story.id } },
    },
    story,
    requirements: [requirement],
    contract,
    output_registry: {
      links: [{
        id: "OUT-42",
        story_id: story.id,
        artifact_type: "implementation-summary",
        template_id: "implementation-summary-v1",
        mode: "new",
        updated_at: "2026-07-28T10:07:00.000Z",
        fingerprints: { artifact_sha256: "b".repeat(64) },
        verification_receipt: verification,
        verification_receipt_ref: {
          id: verification.id,
          hash: verification.receipt_hash,
        },
      }],
    },
    output_scope: {
      current_phase: "validation",
      phase_order: SOFTWARE_PHASES,
      require_all: false,
    },
    workflow_scope: workflowScope(),
    gate_report: structuredClone(gateReport),
    delivery_profile: profile,
    delivery_close_receipt: close,
    observed_at: OBSERVED_AT,
  };
}

const SOFTWARE_PHASES = Object.freeze([
  "discovery",
  "analysis",
  "design",
  "implementation",
  "validation",
  "release",
]);

function workflowScope(overrides = {}) {
  const scope = {
    instance_id: "delivery-42",
    instance_hash: "1".repeat(64),
    effective_hash: "2".repeat(64),
    story_id: "ST-42",
    current_phase: "validation",
    phase_order: SOFTWARE_PHASES,
    checkpoint_ref: {
      checkpoint_hash: null,
      sequence: 4,
      last_event_hash: "4".repeat(64),
      trace_chain_hash: "5".repeat(64),
      updated_at: "2026-07-28T10:08:30.000Z",
    },
    ...overrides,
  };
  scope.checkpoint_ref.checkpoint_hash = computeStableHash({
    kind: "workflow_checkpoint",
    schema_version: "workflow-checkpoint:v1",
    instance_id: scope.instance_id,
    instance_hash: scope.instance_hash,
    effective_hash: scope.effective_hash,
    sequence: scope.checkpoint_ref.sequence,
    last_event_hash: scope.checkpoint_ref.last_event_hash,
    current_state: scope.current_phase,
    updated_at: scope.checkpoint_ref.updated_at,
    trace_chain_hash: scope.checkpoint_ref.trace_chain_hash,
  });
  return scope;
}

function lifecycleWorkflowEvidence(storyId) {
  return {
    selection_policy: "latest-created-at-then-instance-id:v1",
    story_id: storyId,
    instance_id: "delivery-42",
    instance_hash: "1".repeat(64),
    effective_hash: "2".repeat(64),
    checkpoint_ref: {
      path: ".sdlc/workflows/instances/delivery-42/checkpoint.json",
      checkpoint_hash: "3".repeat(64),
      sequence: 5,
      last_event_hash: "4".repeat(64),
      trace_chain_hash: "5".repeat(64),
    },
    terminal_state: "release",
    terminal_event_ref: {
      event_hash: "4".repeat(64),
      sequence: 5,
      timestamp: "2026-07-28T10:09:00.000Z",
    },
    event_count: 5,
    task_start_ref: {
      id: `START-${storyId}`,
      path: `.sdlc/stories/${storyId}/task-start.json`,
      hash: "6".repeat(64),
      confirmed_at: "2026-07-28T10:00:30.000Z",
    },
    phase_timeline: [
      ["discovery", "2026-07-28T10:00:00.000Z", null, "2026-07-28T10:01:00.000Z"],
      ["analysis", "2026-07-28T10:02:00.000Z", "7".repeat(64), "2026-07-28T10:03:00.000Z"],
      ["design", "2026-07-28T10:04:00.000Z", "8".repeat(64), "2026-07-28T10:05:00.000Z"],
      ["implementation", "2026-07-28T10:06:00.000Z", "9".repeat(64), "2026-07-28T10:07:00.000Z"],
      ["validation", "2026-07-28T10:08:00.000Z", "a".repeat(64), "2026-07-28T10:08:30.000Z"],
      ["release", "2026-07-28T10:09:00.000Z", "4".repeat(64), "2026-07-28T10:09:00.000Z"],
    ].map(([phase, entered_at, entry_event_hash, completed_at]) => ({
      phase,
      entered_at,
      entry_event_hash,
      completed_at,
      completion_record_id: `STEP-${storyId}-${phase}`,
    })),
    release_trace_at: "2026-07-28T10:09:00.000Z",
    delivery_closed_at: "2026-07-28T10:09:00.000Z",
  };
}

function approvedRecord(subject) {
  const record = {
    ...subject,
    status: "approved",
    approvals: [],
    created_at: "2026-07-28T10:00:00.000Z",
    updated_at: "2026-07-28T10:01:00.000Z",
  };
  record.approvals.push({
    id: `APR-${record.id}`,
    status: "approved",
    approved_content_hash: computeGovernedApprovalSubjectHash(record),
    created_at: "2026-07-28T10:01:00.000Z",
  });
  return record;
}

function resealReceipt(receipt) {
  delete receipt.receipt_hash;
  const { hash_algorithm: ignoredHashAlgorithm, ...subject } = receipt;
  receipt.receipt_hash = computeStableHash(subject);
}
