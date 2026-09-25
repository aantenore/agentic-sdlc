import test from "node:test";
import assert from "node:assert/strict";

import {
  addRouteCheck,
  applyRouteConfidenceGate,
  canonicalIntentCommand,
  canonicalIntentQuestion,
  dedupeRouteDecision,
  defaultRouteActions,
  finalizeAskRoute,
  finalizeConcreteRoute,
  inferTaskPhase,
  isAssessmentRouteIntent,
  normalizeIntentArray,
  normalizeIntentArtifactType,
  normalizeRouteActionMap,
  normalizeRouteArtifactTypeValue,
  normalizeRouteId,
  normalizeRoutePhase,
  normalizeRouteToken,
  nullableRoutePhase,
  routeEntityId,
  routeQuestionFromContext,
  routeScalar,
  routeStoryId,
  taskRouteRequiresContract,
  taskStartAutonomyChoiceLines,
  taskStartAutonomyCopy,
} from "../../lib/lifecycle/route.mjs";
import { ROUTE_REQUIRED_INTENT_FIELDS } from "../../lib/lifecycle/constants.mjs";

test("normalizeRouteToken lowercases, collapses separators, and trims edges", () => {
  assert.equal(normalizeRouteToken("  Create Story  "), "create_story");
  assert.equal(normalizeRouteToken("create-story"), "create_story");
  assert.equal(normalizeRouteToken("create___story"), "create_story");
  assert.equal(normalizeRouteToken("--edge--"), "edge");
  assert.equal(normalizeRouteToken(undefined), "");
  assert.equal(normalizeRouteToken(null), "");
});

test("normalizeRoutePhase only trims and lowercases, no separator collapsing", () => {
  assert.equal(normalizeRoutePhase("  Design  "), "design");
  assert.equal(normalizeRoutePhase(undefined), "");
});

test("nullableRoutePhase returns null for a scalar-less value and a normalized phase otherwise", () => {
  assert.equal(nullableRoutePhase(undefined), null);
  assert.equal(nullableRoutePhase(true), null);
  assert.equal(nullableRoutePhase("  Analysis "), "analysis");
});

test("routeScalar collapses single-element arrays and rejects ambiguous or empty values", () => {
  assert.equal(routeScalar(undefined), null);
  assert.equal(routeScalar(null), null);
  assert.equal(routeScalar(true), null, "Current behaviour: boolean true is treated as absent, not as a literal value");
  assert.equal(routeScalar(false), "false", "Current behaviour: boolean false stringifies instead of being treated as absent");
  assert.equal(routeScalar(""), null);
  assert.equal(routeScalar("  value "), "value");
  assert.equal(routeScalar(["only"]), "only");
  assert.equal(routeScalar(["a", "b"]), null);
  assert.equal(routeScalar([]), null);
  assert.equal(routeScalar(42), "42");
});

test("normalizeRouteArtifactTypeValue slugifies free text into a dash-separated token", () => {
  assert.equal(normalizeRouteArtifactTypeValue("Technical  Analysis"), "technical-analysis");
  assert.equal(normalizeRouteArtifactTypeValue(undefined), "");
});

test("normalizeRouteId returns the normalized id, or null when the id is invalid", () => {
  assert.equal(normalizeRouteId("Story-42"), "Story-42");
  assert.equal(normalizeRouteId(".leading-dot"), null);
  assert.equal(normalizeRouteId("con"), null, "reserved Windows device name is refused");
});

test("normalizeRouteActionMap ignores non-object input and ignores blank action keys", () => {
  assert.deepEqual(normalizeRouteActionMap(null), {});
  assert.deepEqual(normalizeRouteActionMap("nope"), {});
  assert.deepEqual(normalizeRouteActionMap([]), {});
  assert.deepEqual(normalizeRouteActionMap({ "   ": "classify_artifact" }), {});
});

test("normalizeRouteActionMap turns a string config into a bare route", () => {
  const result = normalizeRouteActionMap({ "Create Story": "decompose_stories" });
  assert.deepEqual(result, { create_story: { route: "decompose_stories" } });
});

test("normalizeRouteActionMap normalizes route, confirmation_key, and artifact type on an object config", () => {
  const result = normalizeRouteActionMap({
    my_action: {
      route: "Classify Artifact",
      confirmation_key: "Create Canonical Artifact",
      default_artifact_type: "Technical Analysis",
      requires_artifact_type: true,
    },
  });
  assert.equal(result.my_action.route, "classify_artifact");
  assert.equal(result.my_action.confirmation_key, "create_canonical_artifact");
  assert.equal(result.my_action.default_artifact_type, "technical-analysis");
  assert.equal(result.my_action.requires_artifact_type, true);
});

test("normalizeRouteActionMap leaves confirmation_key and default_artifact_type undefined when absent", () => {
  const result = normalizeRouteActionMap({ my_action: { route: "init_project" } });
  assert.equal(result.my_action.confirmation_key, undefined);
  assert.equal(result.my_action.default_artifact_type, undefined);
});

test("defaultRouteActions maps every technical-assessment alias to the same classify_artifact shape", () => {
  const actions = defaultRouteActions();
  assert.deepEqual(actions.initialize_project, { route: "init_project" });
  assert.deepEqual(actions.validate_story, { route: "validate_story", requires_story: true });
  const expected = {
    route: "classify_artifact",
    confirmation_key: "create_canonical_artifact",
    default_artifact_type: "technical-analysis",
    requires_artifact_type: true,
  };
  for (const alias of ["technical_analysis", "technical_assessment", "initial_technical_assessment", "architecture_assessment"]) {
    assert.deepEqual(actions[alias], expected);
  }
});

test("taskRouteRequiresContract is true only for the routes that require a bound contract", () => {
  assert.equal(taskRouteRequiresContract("claim_and_implement"), true);
  assert.equal(taskRouteRequiresContract("validate_story"), true);
  assert.equal(taskRouteRequiresContract("intake_requirement"), false);
  assert.equal(taskRouteRequiresContract("init_project"), false);
});

test("inferTaskPhase prefers an explicit phase over the intent's proposed phase and the route default", () => {
  const decision = { route: "claim_and_implement", intent: { proposed_phase: "design" } };
  assert.equal(inferTaskPhase(decision, { phase: "Release" }), "release");
});

test("inferTaskPhase falls back to the intent's proposed phase, then the route default, then null", () => {
  assert.equal(inferTaskPhase({ route: "claim_and_implement", intent: { proposed_phase: "design" } }, {}), "design");
  assert.equal(inferTaskPhase({ route: "claim_and_implement", intent: {} }, {}), "implementation");
  assert.equal(inferTaskPhase({ route: "decompose_stories", intent: {} }, {}), "design");
  assert.equal(inferTaskPhase({ route: "unknown_route", intent: {} }, {}), null);
});

test("isAssessmentRouteIntent matches the default assessment action list", () => {
  const context = { config: {} };
  assert.equal(isAssessmentRouteIntent(context, { intent: { requested_action: "Technical Assessment" } }), true);
  assert.equal(isAssessmentRouteIntent(context, { intent: { requested_action: "implement_story" } }), false);
});

test("isAssessmentRouteIntent honors a project-configured requested_actions override", () => {
  const context = { config: { assessment_workflow: { requested_actions: ["custom_review"] } } };
  assert.equal(isAssessmentRouteIntent(context, { intent: { requested_action: "custom_review" } }), true);
  assert.equal(isAssessmentRouteIntent(context, { intent: { requested_action: "technical_assessment" } }), false, "the override replaces rather than extends the default list");
});

test("taskStartAutonomyCopy returns the local-release wording in English and Italian", () => {
  const en = taskStartAutonomyCopy("local_release", "en");
  assert.match(en.question, /local release/);
  assert.equal(en.choices.length, 3);
  const it = taskStartAutonomyCopy("local_release", "it");
  assert.match(it.question, /rilascio locale/);
});

test("taskStartAutonomyCopy uses pull-request wording for any other delivery kind", () => {
  const copy = taskStartAutonomyCopy("pull_request", "en");
  assert.match(copy.question, /pull request/);
});

test("taskStartAutonomyChoiceLines is empty when the decision is not selecting delivery autonomy", () => {
  assert.deepEqual(taskStartAutonomyChoiceLines({ contract_action: "other" }, false), []);
});

test("taskStartAutonomyChoiceLines asks for the delivery destination first when delivery_kind is unset", () => {
  const lines = taskStartAutonomyChoiceLines({ contract_action: "select_delivery_autonomy" }, false);
  assert.equal(lines[0], "");
  assert.match(lines[1], /identify this delivery's exact destination/);
});

test("taskStartAutonomyChoiceLines renders the three numbered choices once delivery_kind is known", () => {
  const lines = taskStartAutonomyChoiceLines(
    { contract_action: "select_delivery_autonomy", delivery_kind: "local_release" },
    false,
  );
  assert.equal(lines[0], "");
  assert.equal(lines[2], "1. Guided: I ask for confirmation before important steps.");
  assert.equal(lines[5], lines.at(-1));
  assert.match(lines.at(-1), /This choice applies only to this local release/);
});

test("routeEntityId finds an id by matching entity type aliases and falls back through id fields", () => {
  const policy = { entity_types: { story: ["story", "user_story"] } };
  const intent = {
    referenced_entities: [
      { kind: "task", id: "wrong-type" },
      { type: "user_story", identifier: "story-42" },
    ],
  };
  assert.equal(routeEntityId(intent, policy, "story"), "story-42");
});

test("routeEntityId returns null when no referenced entity matches the requested type", () => {
  const policy = { entity_types: { story: ["story"] } };
  assert.equal(routeEntityId({ referenced_entities: [{ type: "task", id: "t-1" }] }, policy, "story"), null);
  assert.equal(routeEntityId({ referenced_entities: [] }, policy, "story"), null);
  assert.equal(routeEntityId({ referenced_entities: ["not-an-object"] }, policy, "story"), null);
});

test("routeStoryId prefers an explicit story_id over a referenced entity", () => {
  const policy = { entity_types: { story: ["story"] } };
  assert.equal(routeStoryId({ story_id: "story-1" }, policy), "story-1");
  assert.equal(
    routeStoryId({ referenced_entities: [{ type: "story", id: "story-2" }] }, policy),
    "story-2",
  );
});

test("addRouteCheck appends a deterministic check record", () => {
  const decision = { deterministic_checks: [] };
  addRouteCheck(decision, "some_check", "passed", "detail");
  assert.deepEqual(decision.deterministic_checks, [{ check: "some_check", status: "passed", details: "detail" }]);
});

test("applyRouteConfidenceGate returns ask when confidence is below confirm_min", () => {
  const policy = { confidence: { ask_below: 0.3, confirm_min: 0.5, auto_route_min: 0.8 } };
  const decision = { confidence: 0.4, deterministic_checks: [] };
  assert.equal(applyRouteConfidenceGate(decision, policy), "ask");
  assert.equal(decision.deterministic_checks[0].status, "failed");
});

test("applyRouteConfidenceGate returns confirm between confirm_min and auto_route_min", () => {
  const policy = { confidence: { ask_below: 0.3, confirm_min: 0.5, auto_route_min: 0.8 } };
  const decision = { confidence: 0.6, deterministic_checks: [] };
  assert.equal(applyRouteConfidenceGate(decision, policy), "confirm");
  assert.equal(decision.deterministic_checks[0].status, "passed");
});

test("applyRouteConfidenceGate returns auto at or above auto_route_min", () => {
  const policy = { confidence: { ask_below: 0.3, confirm_min: 0.5, auto_route_min: 0.8 } };
  const decision = { confidence: 0.9, deterministic_checks: [] };
  assert.equal(applyRouteConfidenceGate(decision, policy), "auto");
});

test("finalizeConcreteRoute marks needs_confirmation when the confidence outcome is confirm", () => {
  const policy = { confidence: { always_confirm: [] } };
  const decision = { route: "classify_artifact", blocking_reasons: [], questions: [], next_commands: [], requires_confirmation: false };
  finalizeConcreteRoute(decision, policy, {}, "confirm");
  assert.equal(decision.requires_confirmation, true);
  assert.equal(decision.status, "needs_confirmation");
});

test("finalizeConcreteRoute forces confirmation for an always_confirm action even on auto confidence", () => {
  const policy = { confidence: { always_confirm: ["start_implementation"] } };
  const decision = { route: "claim_and_implement", intent: { requested_action: "start_implementation" }, blocking_reasons: [], questions: [], next_commands: [], requires_confirmation: false };
  finalizeConcreteRoute(decision, policy, {}, "auto");
  assert.equal(decision.requires_confirmation, true);
});

test("finalizeConcreteRoute forces confirmation for confirm_phase_skip regardless of confidence", () => {
  const policy = { confidence: { always_confirm: [] } };
  const decision = { route: "confirm_phase_skip", blocking_reasons: [], questions: [], next_commands: [], requires_confirmation: false };
  finalizeConcreteRoute(decision, policy, {}, "auto");
  assert.equal(decision.requires_confirmation, true);
});

test("finalizeConcreteRoute reports blocked when blocking reasons exist and confirmation is not required", () => {
  const policy = { confidence: { always_confirm: [] } };
  const decision = { route: "classify_artifact", blocking_reasons: ["missing_artifact_type", "missing_artifact_type"], questions: [], next_commands: [], requires_confirmation: false };
  finalizeConcreteRoute(decision, policy, {}, "auto");
  assert.equal(decision.status, "blocked");
  assert.deepEqual(decision.blocking_reasons, ["missing_artifact_type"], "duplicates are deduped");
});

test("finalizeConcreteRoute reports ready when there is nothing to confirm or block", () => {
  const policy = { confidence: { always_confirm: [] } };
  const decision = { route: "classify_artifact", blocking_reasons: [], questions: [], next_commands: [], requires_confirmation: false };
  finalizeConcreteRoute(decision, policy, {}, "auto");
  assert.equal(decision.status, "ready");
});

test("finalizeAskRoute routes to ask_clarification, merges unique reasons, and clears confirmation", () => {
  const decision = {
    route: "classify_artifact",
    status: "ready",
    requires_confirmation: true,
    blocking_reasons: ["existing_reason"],
    questions: [],
    next_commands: [],
  };
  finalizeAskRoute(decision, { blocking_reasons: ["existing_reason", "new_reason"], questions: ["q1"] });
  assert.equal(decision.route, "ask_clarification");
  assert.equal(decision.status, "ready", "Current behaviour: an existing decision.status is kept over the needs_clarification default");
  assert.equal(decision.requires_confirmation, false);
  assert.deepEqual(decision.blocking_reasons, ["existing_reason", "new_reason"]);
  assert.deepEqual(decision.questions, ["q1"]);
});

test("finalizeAskRoute defaults the status to needs_clarification when none is set", () => {
  const decision = { route: null, blocking_reasons: [], questions: [], next_commands: [] };
  finalizeAskRoute(decision, {});
  assert.equal(decision.status, "needs_clarification");
});

test("dedupeRouteDecision removes duplicate entries from all three decision lists", () => {
  const decision = {
    blocking_reasons: ["a", "a", "b"],
    questions: ["q", "q"],
    next_commands: ["c1", "c2", "c1"],
  };
  dedupeRouteDecision(decision);
  assert.deepEqual(decision.blocking_reasons, ["a", "b"]);
  assert.deepEqual(decision.questions, ["q"]);
  assert.deepEqual(decision.next_commands, ["c1", "c2"]);
});

test("canonicalIntentQuestion lists every required canonical intent field", () => {
  const question = canonicalIntentQuestion();
  for (const field of ROUTE_REQUIRED_INTENT_FIELDS) {
    assert.ok(question.includes(field), `missing field ${field}`);
  }
});

test("canonicalIntentCommand returns the fixed route decide invocation", () => {
  assert.equal(canonicalIntentCommand(), "agentic-sdlc route decide --intent-json '<canonical-intent-json>'");
});

test("normalizeIntentArray records an error and returns an empty array for a non-array value", () => {
  const errors = [];
  assert.deepEqual(normalizeIntentArray("not-an-array", "referenced_entities", errors), []);
  assert.deepEqual(errors, ["referenced_entities must be an array"]);
});

test("normalizeIntentArray passes an array value through unchanged", () => {
  const errors = [];
  const value = [1, 2, 3];
  assert.equal(normalizeIntentArray(value, "field", errors), value);
  assert.deepEqual(errors, []);
});

test("normalizeIntentArtifactType returns null for an empty value without recording an error", () => {
  const errors = [];
  assert.equal(normalizeIntentArtifactType(undefined, errors), null);
  assert.deepEqual(errors, []);
});

test("normalizeIntentArtifactType normalizes a valid artifact type", () => {
  const errors = [];
  assert.equal(normalizeIntentArtifactType("Technical Analysis", errors), "technical-analysis");
  assert.deepEqual(errors, []);
});

test("normalizeIntentArtifactType records the validation error and returns null for an invalid type", () => {
  const errors = [];
  assert.equal(normalizeIntentArtifactType("bad/type", errors), null);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Invalid artifact type/);
});

test("routeQuestionFromContext formats a plain string as missing context", () => {
  assert.equal(routeQuestionFromContext("acceptance criteria"), "Provide missing context: acceptance criteria.");
});

test("routeQuestionFromContext reads the first available field on an object", () => {
  assert.equal(routeQuestionFromContext({ prompt: "Pick a target branch" }), "Pick a target branch");
  assert.equal(routeQuestionFromContext({ id: "ctx-1" }), "ctx-1");
});

test("routeQuestionFromContext falls back to a generic prompt for an object with no usable field or a non-object value", () => {
  assert.equal(routeQuestionFromContext({}), "Provide the missing canonical context.");
  assert.equal(routeQuestionFromContext(42), "Provide the missing canonical context.");
});
