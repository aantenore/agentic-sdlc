import test from "node:test";
import assert from "node:assert/strict";

import { UserError } from "../../lib/cli/user-error.mjs";
import {
  assertStoryCommandOptions,
  buildBudgetMeterBaseline,
  buildStoryDependencyGraph,
  buildStoryRequirementGraph,
  buildTraceRequestMetadata,
  businessImpactForTrace,
  configuredPhaseOrder,
  configuredStorySteps,
  contractArtifactTypes,
  contractExecutionContext,
  contractNegotiationCommands,
  defaultClaimExpiration,
  defaultNextStoryStep,
  defaultStoryBranch,
  dependencyEdgeKey,
  effectiveClaimExpiration,
  effectiveClaimPolicy,
  effectiveStoryLifecyclePolicy,
  findBlockingDependencyCycles,
  hasTraceActor,
  isHardDependencyEdge,
  isIntactBootstrapPhaseContract,
  latestTraceEvent,
  newestContract,
  normalizeStoryRecord,
  normalizeStoryStep,
  normalizeTraceDetectorPatterns,
  normalizeTraceOutcome,
  parseBreakdownItemRef,
  parseDependencyEdge,
  phaseRank,
  rejectLegacyRequirementWriteScope,
  requirementMaterialScope,
  storyActionCheckpointSubjectId,
  storyAcceptanceCriteria,
  storyBranchPatterns,
  storyRecordLifecycleProjection,
  storyStepPhase,
  traceActorKey,
  traceActorMatches,
  validateBudgetMeterBaseline,
  validateClaimPolicy,
  validateStoryLifecyclePolicy,
  validateWorkBreakdownPolicy,
} from "../../lib/lifecycle/story.mjs";

// -- validateStoryLifecyclePolicy -------------------------------------------------

test("validateStoryLifecyclePolicy accepts a missing terminal_statuses field", () => {
  assert.doesNotThrow(() => validateStoryLifecyclePolicy({}));
  assert.doesNotThrow(() => validateStoryLifecyclePolicy());
});

test("validateStoryLifecyclePolicy rejects an empty or non-array terminal_statuses", () => {
  assert.throws(() => validateStoryLifecyclePolicy({ terminal_statuses: [] }), UserError);
  assert.throws(() => validateStoryLifecyclePolicy({ terminal_statuses: "done" }), UserError);
});

test("validateStoryLifecyclePolicy rejects an unknown story status", () => {
  assert.throws(
    () => validateStoryLifecyclePolicy({ terminal_statuses: ["done", "archived"] }),
    /unknown story status 'archived'/,
  );
});

test("validateStoryLifecyclePolicy accepts a valid terminal_statuses list", () => {
  assert.doesNotThrow(() => validateStoryLifecyclePolicy({ terminal_statuses: ["done", "blocked"] }));
});

// -- validateClaimPolicy -----------------------------------------------------------

test("validateClaimPolicy accepts a missing, null, or positive integer ttl", () => {
  assert.doesNotThrow(() => validateClaimPolicy({}));
  assert.doesNotThrow(() => validateClaimPolicy({ default_ttl_seconds: null }));
  assert.doesNotThrow(() => validateClaimPolicy({ default_ttl_seconds: 3600 }));
});

test("validateClaimPolicy rejects a zero, negative, or non-integer ttl", () => {
  assert.throws(() => validateClaimPolicy({ default_ttl_seconds: 0 }), UserError);
  assert.throws(() => validateClaimPolicy({ default_ttl_seconds: -1 }), UserError);
  assert.throws(() => validateClaimPolicy({ default_ttl_seconds: 1.5 }), UserError);
});

// -- validateWorkBreakdownPolicy ----------------------------------------------------

test("validateWorkBreakdownPolicy accepts an undefined policy and rejects a non-object one", () => {
  assert.doesNotThrow(() => validateWorkBreakdownPolicy(undefined));
  assert.throws(() => validateWorkBreakdownPolicy("nope"), UserError);
  assert.throws(() => validateWorkBreakdownPolicy(["nope"]), UserError);
});

test("validateWorkBreakdownPolicy rejects a non-array levels/claimable_units field", () => {
  assert.throws(() => validateWorkBreakdownPolicy({ levels: "story" }), /levels must be an array/);
});

test("validateWorkBreakdownPolicy rejects an unknown work item type in levels or claimable_units", () => {
  assert.throws(
    () => validateWorkBreakdownPolicy({ claimable_units: ["task", "widget"] }),
    /Unknown work item type 'widget'/,
  );
});

test("validateWorkBreakdownPolicy rejects an unknown delivery_unit/strict_gate_unit and an invalid task_gate", () => {
  assert.throws(() => validateWorkBreakdownPolicy({ delivery_unit: "widget" }), UserError);
  assert.throws(
    () => validateWorkBreakdownPolicy({ task_gate: "extreme" }),
    /task_gate must be light, strict, or none/,
  );
});

test("validateWorkBreakdownPolicy accepts a fully valid policy", () => {
  assert.doesNotThrow(() => validateWorkBreakdownPolicy({
    levels: ["epic", "story", "task"],
    claimable_units: ["task"],
    delivery_unit: "story",
    strict_gate_unit: "task",
    task_gate: "strict",
  }));
});

// -- storyAcceptanceCriteria / normalizeStoryRecord ---------------------------------

test("storyAcceptanceCriteria prefers the canonical acceptance_criteria field", () => {
  assert.deepEqual(
    storyAcceptanceCriteria({ acceptance_criteria: ["a", "b"], acceptance: ["legacy"] }),
    ["a", "b"],
  );
});

test("storyAcceptanceCriteria falls back to the legacy acceptance field when acceptance_criteria is empty", () => {
  assert.deepEqual(storyAcceptanceCriteria({ acceptance: ["legacy"] }), ["legacy"]);
  assert.deepEqual(storyAcceptanceCriteria({}), []);
});

test("normalizeStoryRecord derives acceptance_criteria and preserves an explicit acceptance array", () => {
  const story = { id: "s-1", acceptance: ["given/when/then"] };
  const normalized = normalizeStoryRecord(story);
  assert.deepEqual(normalized.acceptance, ["given/when/then"]);
  assert.deepEqual(normalized.acceptance_criteria, ["given/when/then"]);
});

test("normalizeStoryRecord synthesizes an acceptance array from acceptance_criteria when acceptance is missing", () => {
  const normalized = normalizeStoryRecord({ id: "s-1", acceptance_criteria: ["ac-1"] });
  assert.deepEqual(normalized.acceptance, ["ac-1"]);
});

test("normalizeStoryRecord passes non-object input through unchanged", () => {
  assert.equal(normalizeStoryRecord(null), null);
  assert.equal(normalizeStoryRecord("story"), "story");
});

// -- normalizeStoryStep / configuredPhaseOrder / configuredStorySteps ---------------

test("normalizeStoryStep normalizes case and whitespace and rejects a step outside the configured set", () => {
  const context = { config: { phase_order: ["discovery", "analysis", "design"], phases: {} } };
  assert.equal(normalizeStoryStep(context, "  Discovery "), "discovery");
  assert.throws(() => normalizeStoryStep(context, "release"), /Unknown story step 'release'/);
});

test("normalizeStoryStep accepts a legacy alias whose configured phase is present", () => {
  const context = { config: { phase_order: ["discovery", "analysis"], phases: {} } };
  assert.equal(normalizeStoryStep(context, "functional-analysis"), "functional-analysis");
});

test("configuredPhaseOrder prefers context.config.phase_order and falls back to the phases map keys", () => {
  assert.deepEqual(configuredPhaseOrder({ config: { phase_order: ["discovery", "design"], phases: {} } }), ["discovery", "design"]);
  assert.deepEqual(configuredPhaseOrder({ config: { phases: { discovery: {}, design: {} } } }), ["discovery", "design"]);
});

test("configuredStorySteps appends legacy step aliases whose target phase is configured", () => {
  const context = { config: { phase_order: ["discovery", "analysis"], phases: {} } };
  const steps = configuredStorySteps(context);
  assert.deepEqual(steps, ["discovery", "analysis", "functional-analysis", "technical-analysis"]);
});

test("storyStepPhase maps a legacy alias to its configured phase and passes an unknown step through", () => {
  const context = { config: { phase_order: ["discovery", "analysis"], phases: {} } };
  assert.equal(storyStepPhase(context, "technical-analysis"), "analysis");
  assert.equal(storyStepPhase(context, "discovery"), "discovery");
});

test("defaultNextStoryStep returns the following configured phase, or null after the last one", () => {
  const context = { config: { phase_order: ["discovery", "analysis", "design"], phases: {} } };
  assert.equal(defaultNextStoryStep(context, "discovery"), "analysis");
  assert.equal(defaultNextStoryStep(context, "design"), null);
});

test("defaultNextStoryStep routes the functional-analysis alias to technical-analysis when analysis is configured", () => {
  const context = { config: { phase_order: ["discovery", "analysis"], phases: {} } };
  assert.equal(defaultNextStoryStep(context, "functional-analysis"), "technical-analysis");
});

test("defaultNextStoryStep returns null for a step with no configured or aliased successor", () => {
  const context = { config: { phase_order: ["discovery"], phases: {} } };
  assert.equal(defaultNextStoryStep(context, "unknown-step"), null);
});

// -- normalizeTraceDetectorPatterns / normalizeTraceOutcome -------------------------

test("normalizeTraceDetectorPatterns returns an empty array for undefined and rejects a non-array value", () => {
  assert.deepEqual(normalizeTraceDetectorPatterns(undefined, "secret_patterns", "configured_secret"), []);
  assert.throws(() => normalizeTraceDetectorPatterns("nope", "secret_patterns", "configured_secret"), UserError);
});

test("normalizeTraceDetectorPatterns wraps a bare string pattern with a generated name and keeps object entries as-is", () => {
  const result = normalizeTraceDetectorPatterns(["abc", { name: "custom", pattern: "xyz" }], "pii_patterns", "configured_pii");
  assert.deepEqual(result, [
    { name: "configured_pii_1", pattern: "abc" },
    { name: "custom", pattern: "xyz" },
  ]);
});

test("normalizeTraceDetectorPatterns rejects a pattern entry that is neither a string nor an object", () => {
  assert.throws(() => normalizeTraceDetectorPatterns([42], "pii_patterns", "configured_pii"), /must be a string or object/);
});

test("normalizeTraceOutcome normalizes case and rejects an outcome outside the fixed set", () => {
  assert.equal(normalizeTraceOutcome("  Passed "), "passed");
  assert.throws(() => normalizeTraceOutcome("done"), /Unknown trace outcome 'done'/);
});

// -- validateBudgetMeterBaseline / buildBudgetMeterBaseline --------------------------

function budgetFixtures() {
  const proposal = { id: "prop-1", proposal_hash: "hash-prop" };
  const budget = { id: "budget-1", budget_hash: "hash-budget" };
  const mapping = { tokens: "usage.tokens" };
  const snapshot = { captured_at: "2026-01-01T00:00:00.000Z", value: 10 };
  const adapter = {
    id: "adapter-1",
    label: "Adapter One",
    validateSnapshot: (candidate) => (candidate.value >= 0 ? { valid: true } : { valid: false, errors: ["negative value"] }),
  };
  const baseline = buildBudgetMeterBaseline({}, proposal, budget, adapter.id, "baseline-1", mapping, snapshot);
  return { proposal, budget, mapping, snapshot, adapter, baseline };
}

test("validateBudgetMeterBaseline accepts a baseline built by buildBudgetMeterBaseline for the same inputs", () => {
  const { proposal, budget, mapping, adapter, baseline } = budgetFixtures();
  assert.equal(validateBudgetMeterBaseline(baseline, proposal, budget, adapter, mapping), baseline);
});

test("validateBudgetMeterBaseline rejects a baseline whose content hash was tampered with", () => {
  const { proposal, budget, mapping, adapter, baseline } = budgetFixtures();
  const tampered = { ...baseline, baseline_hash: "not-the-real-hash" };
  assert.throws(
    () => validateBudgetMeterBaseline(tampered, proposal, budget, adapter, mapping),
    /failed immutable content validation/,
  );
});

test("validateBudgetMeterBaseline rejects a baseline bound to a different proposal", () => {
  const { proposal, budget, mapping, adapter, baseline } = budgetFixtures();
  const otherProposal = { id: "prop-2", proposal_hash: "other-hash" };
  assert.throws(
    () => validateBudgetMeterBaseline(baseline, otherProposal, budget, adapter, mapping),
    /not bound to the current proposal/,
  );
});

test("validateBudgetMeterBaseline rejects a baseline whose metric mapping has since changed", () => {
  const { proposal, budget, adapter, baseline } = budgetFixtures();
  assert.throws(
    () => validateBudgetMeterBaseline(baseline, proposal, budget, adapter, { tokens: "usage.other" }),
    /metric mapping changed/,
  );
});

test("validateBudgetMeterBaseline rejects a baseline whose snapshot fails adapter validation", () => {
  const { proposal, budget, mapping, adapter, baseline } = budgetFixtures();
  const invalidSnapshotBaseline = { ...baseline, snapshot: { ...baseline.snapshot, value: -1 } };
  // Re-sign so it passes the content-hash check and only fails snapshot validation.
  const rebuilt = buildBudgetMeterBaseline({}, proposal, budget, adapter.id, "baseline-1", mapping, invalidSnapshotBaseline.snapshot);
  assert.throws(
    () => validateBudgetMeterBaseline(rebuilt, proposal, budget, adapter, mapping),
    /snapshot is invalid: negative value/,
  );
});

// -- contractArtifactTypes / isIntactBootstrapPhaseContract / contractExecutionContext --

test("contractArtifactTypes lowercases, trims, and deduplicates the referenced artifact types", () => {
  const contract = {
    output_contract_refs: [
      { artifact_type: "Technical-Analysis" },
      { artifact_type: "technical-analysis" },
      { artifact_type: "  " },
    ],
  };
  assert.deepEqual(contractArtifactTypes(contract), ["technical-analysis"]);
});

test("contractArtifactTypes returns an empty array for a contract with no output_contract_refs", () => {
  assert.deepEqual(contractArtifactTypes({}), []);
});

function bootstrapContract(overrides = {}) {
  return {
    phase: "discovery",
    id: "contract-discovery-v1",
    status: "draft",
    approvals: [],
    output_contract_refs: [],
    capability_bindings: [],
    capability_recommendation_refs: [],
    requirement_refs: [],
    requirement_execution_profile_refs: [],
    delivery_execution_profile_id: null,
    contextualization: { summary: "", context_sources: [], questions: [], constraints: [], assumptions: [], open_questions: 0 },
    ...overrides,
  };
}

test("isIntactBootstrapPhaseContract is true for an untouched bootstrap contract in a configured phase", () => {
  const context = { config: { phase_order: ["discovery", "analysis"] } };
  assert.equal(isIntactBootstrapPhaseContract(context, bootstrapContract()), true);
});

test("isIntactBootstrapPhaseContract is false once the contract has been bound to a story or approved", () => {
  const context = { config: { phase_order: ["discovery", "analysis"] } };
  assert.equal(isIntactBootstrapPhaseContract(context, bootstrapContract({ story_id: "story-1" })), false);
  assert.equal(isIntactBootstrapPhaseContract(context, bootstrapContract({ status: "approved" })), false);
  assert.equal(isIntactBootstrapPhaseContract(context, bootstrapContract({ approvals: [{}] })), false);
});

test("isIntactBootstrapPhaseContract is false for a phase outside the configured phase order", () => {
  const context = { config: { phase_order: ["analysis"] } };
  assert.equal(isIntactBootstrapPhaseContract(context, bootstrapContract()), false);
});

test("contractExecutionContext requires story_id, id, and delivery_execution_profile_id together", () => {
  assert.deepEqual(
    contractExecutionContext({ story_id: "s-1", id: "c-1", delivery_execution_profile_id: "profile-1" }),
    { storyId: "s-1", contractId: "c-1", profileId: "profile-1" },
  );
  assert.equal(contractExecutionContext({ story_id: "s-1", id: "c-1" }), null);
  assert.equal(contractExecutionContext(null), null);
});

// -- storyActionCheckpointSubjectId / buildTraceRequestMetadata / assertStoryCommandOptions --

test("storyActionCheckpointSubjectId scopes a complete-step action to the step and returns the story id otherwise", () => {
  assert.equal(
    storyActionCheckpointSubjectId("story-1", "story.complete-step", { step: "Design Review" }),
    "story-1.step.Design-Review",
    "Current behaviour: normalizeId only replaces whitespace and preserves the original casing",
  );
  assert.equal(storyActionCheckpointSubjectId("story-1", "story.claim", {}), "story-1");
  assert.equal(storyActionCheckpointSubjectId("story-1", "story.complete-step", {}), "story-1", "no step provided falls back to the story id");
});

test("buildTraceRequestMetadata returns null when no request field and no attribution fallback is present", () => {
  assert.equal(buildTraceRequestMetadata({}, null), null);
});

test("buildTraceRequestMetadata collects the request-* options and falls back to attribution.run", () => {
  const metadata = buildTraceRequestMetadata({ "request-id": "req-1" }, { run: { thread_id: "thread-1", run_id: "run-1", session_id: "session-1" } });
  assert.deepEqual(metadata, {
    id: "req-1",
    summary: null,
    source: null,
    thread_id: "thread-1",
    run_id: "run-1",
    session_id: "session-1",
  });
});

test("assertStoryCommandOptions rejects an option outside the common and command-specific allow list", () => {
  assert.throws(
    () => assertStoryCommandOptions({ root: ".", "bogus-flag": "1" }, "story claim", ["step"]),
    /story claim does not accept --bogus-flag/,
  );
});

test("assertStoryCommandOptions accepts common and explicitly allowed options", () => {
  assert.doesNotThrow(() => assertStoryCommandOptions({ root: ".", step: "design" }, "story complete-step", ["step"]));
});

// -- parseBreakdownItemRef / parseDependencyEdge / dependencyEdgeKey / isHardDependencyEdge --

test("parseBreakdownItemRef parses a valid type:id reference", () => {
  assert.deepEqual(parseBreakdownItemRef("task:task-1"), { type: "task", id: "task-1" });
});

test("parseBreakdownItemRef rejects a reference missing the type:id shape or with an unknown type", () => {
  assert.throws(() => parseBreakdownItemRef("task-1"), /Breakdown items must use --item type:id/);
  assert.throws(() => parseBreakdownItemRef("widget:x"), /Unknown work item type 'widget'/);
});

test("parseDependencyEdge parses a valid five-field edge", () => {
  assert.deepEqual(
    parseDependencyEdge("story-1:story-2:blocks:implementation:done"),
    { from: "story-1", to: "story-2", type: "blocks", blocks: "implementation", required_state: "done" },
  );
});

test("parseDependencyEdge rejects a malformed edge, an unknown type, and an unknown blocking scope", () => {
  assert.throws(() => parseDependencyEdge("a:b:c"), /Dependency edges must use --edge/);
  assert.throws(() => parseDependencyEdge("a:b:unknown_type:none:done"), /Unknown dependency type 'unknown_type'/);
  assert.throws(() => parseDependencyEdge("a:b:blocks:unknown_scope:done"), /Unknown dependency blocking scope 'unknown_scope'/);
});

test("dependencyEdgeKey joins from, to, type, and blocks but ignores required_state", () => {
  const edge = { from: "a", to: "b", type: "blocks", blocks: "none", required_state: "done" };
  assert.equal(dependencyEdgeKey(edge), "a::b::blocks::none");
});

test("isHardDependencyEdge is false once blocks is none, regardless of type", () => {
  assert.equal(isHardDependencyEdge({ type: "blocks", blocks: "none" }), false);
});

test("isHardDependencyEdge is true only for blocking edge types with a real blocking scope", () => {
  assert.equal(isHardDependencyEdge({ type: "blocks", blocks: "implementation" }), true);
  assert.equal(isHardDependencyEdge({ type: "requires_artifact", blocks: "release" }), true);
  assert.equal(isHardDependencyEdge({ type: "related", blocks: "implementation" }), false);
});

// -- phaseRank / findBlockingDependencyCycles ----------------------------------------

test("phaseRank maps in_progress/review to implementation and done to release", () => {
  assert.equal(phaseRank("in_progress"), phaseRank("implementation"));
  assert.equal(phaseRank("review"), phaseRank("implementation"));
  assert.equal(phaseRank("done"), phaseRank("release"));
});

test("phaseRank falls back to the design rank for an unrecognized phase", () => {
  assert.equal(phaseRank("unknown"), phaseRank("design"));
});

test("findBlockingDependencyCycles reports no cycles for a pure dependency chain", () => {
  const edges = [
    { from: "a", to: "b", type: "blocks", blocks: "implementation" },
    { from: "b", to: "c", type: "blocks", blocks: "implementation" },
  ];
  assert.deepEqual(findBlockingDependencyCycles(edges), []);
});

test("findBlockingDependencyCycles detects a two-node hard-dependency cycle", () => {
  const edges = [
    { from: "a", to: "b", type: "blocks", blocks: "implementation" },
    { from: "b", to: "a", type: "blocks", blocks: "implementation" },
  ];
  const cycles = findBlockingDependencyCycles(edges);
  assert.equal(cycles.length, 1);
  assert.deepEqual(new Set(cycles[0]), new Set(["a", "b"]));
});

test("findBlockingDependencyCycles ignores soft (non-blocking) edges", () => {
  const edges = [
    { from: "a", to: "b", type: "related", blocks: "implementation" },
    { from: "b", to: "a", type: "related", blocks: "implementation" },
  ];
  assert.deepEqual(findBlockingDependencyCycles(edges), []);
});

// -- businessImpactForTrace / traceActorMatches / traceActorKey / hasTraceActor -------

test("businessImpactForTrace classifies each event shape into its business-impact bucket", () => {
  assert.equal(businessImpactForTrace({ type: "decision" }), "decision");
  assert.equal(businessImpactForTrace({ action: "story.approve" }), "decision");
  assert.equal(businessImpactForTrace({ type: "test" }), "validation");
  assert.equal(businessImpactForTrace({ action: "run.validation" }), "validation");
  assert.equal(businessImpactForTrace({ type: "release" }), "release");
  assert.equal(businessImpactForTrace({ type: "risk" }), "risk");
  assert.equal(businessImpactForTrace({ type: "handoff" }), "handoff");
  assert.equal(businessImpactForTrace({ type: "implementation" }), "implementation");
  assert.equal(businessImpactForTrace({ type: "other", action: "noop" }), "activity");
});

test("traceActorMatches is true for a falsy filter and compares against every actor field", () => {
  assert.equal(traceActorMatches({ id: "a" }, ""), true);
  assert.equal(traceActorMatches("alice", "alice"), true);
  assert.equal(traceActorMatches("alice", "bob"), false);
  assert.equal(traceActorMatches({ email: "a@example.com" }, "a@example.com"), true);
  assert.equal(traceActorMatches({ id: "a" }, "b"), false);
});

test("traceActorKey prefers id, then name, then type, and falls back to unknown", () => {
  assert.equal(traceActorKey({ id: "a", name: "Alice" }), "a");
  assert.equal(traceActorKey({ name: "Alice" }), "Alice");
  assert.equal(traceActorKey({}), "unknown");
  assert.equal(traceActorKey("bob"), "bob");
  assert.equal(traceActorKey(""), "unknown");
});

test("hasTraceActor requires a non-empty actor id on an object actor or a non-blank string actor", () => {
  assert.equal(hasTraceActor({ actor: { id: "a" } }), true);
  assert.equal(hasTraceActor({ actor: { id: "" } }), false);
  assert.equal(hasTraceActor({ actor: "alice" }), true);
  assert.equal(hasTraceActor({ actor: "" }), false);
});

// -- buildStoryRequirementGraph / buildStoryDependencyGraph ---------------------------

test("buildStoryRequirementGraph maps each story to its id and requirement links", () => {
  assert.deepEqual(
    buildStoryRequirementGraph([{ id: "s-1", links: { requirements: ["r-1"] } }, { id: "s-2" }]),
    [{ story_id: "s-1", requirements: ["r-1"] }, { story_id: "s-2", requirements: [] }],
  );
});

test("buildStoryDependencyGraph links only stories that share a requirement", () => {
  const stories = [
    { id: "s-1", links: { requirements: ["r-1"] } },
    { id: "s-2", links: { requirements: ["r-1"] } },
    { id: "s-3", links: { requirements: ["r-2"] } },
  ];
  const graph = buildStoryDependencyGraph(stories);
  assert.deepEqual(graph.nodes, ["s-1", "s-2", "s-3"]);
  assert.deepEqual(graph.edges, [
    { from: "s-1", to: "s-2", reason: "shared_requirements", requirements: ["r-1"] },
  ]);
});

// -- lifecycle policy merges / claim expiration / branches / newest contract ----------

test("effectiveStoryLifecyclePolicy and effectiveClaimPolicy let the project config override the template default", () => {
  const context = {
    templateConfig: { story_lifecycle: { terminal_statuses: ["done"] }, claim_policy: { default_ttl_seconds: 100 } },
    config: { story_lifecycle: { terminal_statuses: ["done", "blocked"] }, claim_policy: {} },
  };
  assert.deepEqual(effectiveStoryLifecyclePolicy(context), { terminal_statuses: ["done", "blocked"] });
  assert.deepEqual(effectiveClaimPolicy(context), { default_ttl_seconds: 100 });
});

test("storyRecordLifecycleProjection builds a source-tagged, non-blocked projection", () => {
  assert.deepEqual(storyRecordLifecycleProjection("in_progress", "implementation", false, "wf-1"), {
    status: "in_progress",
    phase: "implementation",
    terminal: false,
    blocked: false,
    source: "story_record",
    workflow_instance_id: "wf-1",
  });
});

test("defaultClaimExpiration adds the configured ttl to the claim timestamp", () => {
  const context = { templateConfig: {}, config: { claim_policy: { default_ttl_seconds: 3600 } } };
  assert.equal(defaultClaimExpiration(context, "2026-01-01T00:00:00.000Z"), "2026-01-01T01:00:00.000Z");
});

test("defaultClaimExpiration returns null when ttl is null or the claim timestamp is invalid", () => {
  const context = { templateConfig: {}, config: { claim_policy: { default_ttl_seconds: null } } };
  assert.equal(defaultClaimExpiration(context, "2026-01-01T00:00:00.000Z"), null);
  const ttlContext = { templateConfig: {}, config: { claim_policy: { default_ttl_seconds: 3600 } } };
  assert.equal(defaultClaimExpiration(ttlContext, "not-a-date"), null);
});

test("effectiveClaimExpiration prefers an explicit expires_at over the derived default", () => {
  const context = { templateConfig: {}, config: { claim_policy: { default_ttl_seconds: 3600 } } };
  assert.equal(effectiveClaimExpiration(context, { expires_at: "2030-01-01T00:00:00.000Z" }), "2030-01-01T00:00:00.000Z");
  assert.equal(
    effectiveClaimExpiration(context, { claimed_at: "2026-01-01T00:00:00.000Z" }),
    "2026-01-01T01:00:00.000Z",
  );
});

test("storyBranchPatterns substitutes the story id and dedupes repeated patterns", () => {
  const context = { config: { parallel_work: { branch_patterns: ["codex/<story-id>", "codex/<story-id>"] } } };
  assert.deepEqual(storyBranchPatterns(context, "story-1"), ["codex/story-1"]);
  assert.equal(defaultStoryBranch(context, "story-1"), "codex/story-1");
});

test("storyBranchPatterns falls back to the single branch_pattern when branch_patterns is absent", () => {
  const context = { config: { parallel_work: { branch_pattern: "work/<story-id>" } } };
  assert.deepEqual(storyBranchPatterns(context, "story-9"), ["work/story-9"]);
});

test("latestTraceEvent returns the most recent event of the requested type, or null", () => {
  const events = [{ type: "decision", id: 1 }, { type: "test", id: 2 }, { type: "test", id: 3 }];
  assert.deepEqual(latestTraceEvent(events, "test"), { type: "test", id: 3 });
  assert.equal(latestTraceEvent(events, "release"), null);
});

test("newestContract returns the contract with the most recent updated_at/created_at, or null for an empty list", () => {
  const contracts = [
    { id: "c-1", updated_at: "2026-01-01T00:00:00.000Z" },
    { id: "c-2", updated_at: "2026-06-01T00:00:00.000Z" },
  ];
  assert.equal(newestContract(contracts).id, "c-2");
  assert.equal(newestContract([]), null);
});

test("contractNegotiationCommands includes the story flag and force flag only when applicable", () => {
  const withStory = contractNegotiationCommands("design", "story-1", "contract-1", { force: true });
  assert.match(withStory[0], /--story story-1/);
  assert.match(withStory[0], /--force$/);
  const withoutStory = contractNegotiationCommands("design", null);
  assert.doesNotMatch(withoutStory[0], /--story/);
  assert.doesNotMatch(withoutStory[0], /--force/);
});

// -- rejectLegacyRequirementWriteScope / requirementMaterialScope ---------------------

test("rejectLegacyRequirementWriteScope always throws a UserError with bilingual human guidance", () => {
  assert.throws(
    () => rejectLegacyRequirementWriteScope("req-1", "profile-1", "absolute path used"),
    (error) => {
      assert.ok(error instanceof UserError);
      assert.match(error.message, /req-1/);
      assert.ok(error.humanGuidance.en.result);
      assert.ok(error.humanGuidance.it.result);
      assert.equal(error.humanGuidance.en.details.reason, "absolute path used");
      return true;
    },
  );
});

test("requirementMaterialScope defaults environment to local and unions capability/tool options", () => {
  const requirement = { summary: "Ship the feature", non_goals: [], acceptance_criteria: ["ac-1"], non_functional_requirements: [], integrations: [], constraints: [] };
  const scope = requirementMaterialScope(requirement, { capability: ["fs"], tool: ["fs", "net"] });
  assert.deepEqual(scope.environment, ["local"]);
  assert.deepEqual(scope.capabilities, ["fs", "net"]);
  assert.equal(scope.objective, requirement.summary);
});

test("requirementMaterialScope prefers canonicalWritePaths over the raw write-path option", () => {
  const requirement = { summary: "x", non_goals: [], acceptance_criteria: [], non_functional_requirements: [], integrations: [], constraints: [] };
  const scope = requirementMaterialScope(requirement, { "write-path": ["ignored/path"] }, ["canonical/path"]);
  assert.deepEqual(scope.write_paths, ["canonical/path"]);
});
