import test from "node:test";
import assert from "node:assert/strict";

import { UserError } from "../../lib/cli/user-error.mjs";
import {
  buildCapabilityPolicy,
  buildDefaultCapabilityPolicyPatch,
  buildDefaultCapabilityRecommendations,
  collectCapabilityPolicyReadinessGaps,
  mergeCapabilityPolicies,
  normalizeAvailableCapabilityEntries,
  normalizeAvailableCapabilityNames,
  normalizeCapabilityAvailability,
  normalizeCapabilityBinding,
  normalizeCapabilityBindings,
  normalizeCapabilityEvidence,
  normalizeCapabilityItemType,
  normalizeCapabilityRecommendationRefs,
  normalizeCapabilityRecommendations,
  normalizeCapabilitySet,
  normalizeCapabilitySubject,
  validateCapabilityPolicy,
} from "../../lib/lifecycle/capability.mjs";

// ---------------------------------------------------------------------------
// validateCapabilityPolicy
// ---------------------------------------------------------------------------

function validPolicy() {
  return {
    skills: { required: ["agentic-sdlc"], allowed: [], forbidden: [] },
    mcp: { required: [], allowed: ["context7"], forbidden: [] },
    tools: { required: [], allowed: [], forbidden: ["rm"] },
    approval_required_for: [],
  };
}

test("validateCapabilityPolicy accepts a well-formed policy and returns true", () => {
  assert.equal(validateCapabilityPolicy(validPolicy(), "capability_policy"), true);
});

test("validateCapabilityPolicy throws a UserError joining every violation when no report is given", () => {
  assert.throws(() => validateCapabilityPolicy("not an object", "capability_policy"), UserError);
  assert.throws(() => validateCapabilityPolicy(null, "capability_policy"), UserError);
});

test("validateCapabilityPolicy requires each of skills/mcp/tools to be an object", () => {
  const policy = { ...validPolicy(), tools: null };
  assert.throws(() => validateCapabilityPolicy(policy, "capability_policy"), /capability_policy\.tools must be an object/u);
});

test("validateCapabilityPolicy requires required/allowed/forbidden to be arrays of non-empty strings", () => {
  const policy = { ...validPolicy(), skills: { required: "agentic-sdlc", allowed: [], forbidden: [] } };
  assert.throws(() => validateCapabilityPolicy(policy, "capability_policy"), /capability_policy\.skills\.required must be an array/u);

  const policy2 = { ...validPolicy(), skills: { required: [""], allowed: [], forbidden: [] } };
  assert.throws(() => validateCapabilityPolicy(policy2, "capability_policy"), /capability_policy\.skills\.required\[0\] must be a non-empty string/u);
});

test("validateCapabilityPolicy rejects a capability that is both required and forbidden", () => {
  const policy = { ...validPolicy(), skills: { required: ["x"], allowed: [], forbidden: ["x"] } };
  assert.throws(() => validateCapabilityPolicy(policy, "capability_policy"), /'x' cannot be both required and forbidden/u);
});

test("validateCapabilityPolicy rejects a capability that is both allowed and forbidden", () => {
  const policy = { ...validPolicy(), skills: { required: [], allowed: ["x"], forbidden: ["x"] } };
  assert.throws(() => validateCapabilityPolicy(policy, "capability_policy"), /'x' cannot be both allowed and forbidden/u);
});

test("validateCapabilityPolicy allows the same name to be both required and allowed (no conflict rule for that pair)", () => {
  // Current behaviour: only required/forbidden and allowed/forbidden are checked for conflicts;
  // required+allowed together is accepted even though "required" already implies availability.
  const policy = { ...validPolicy(), skills: { required: ["x"], allowed: ["x"], forbidden: [] } };
  assert.equal(validateCapabilityPolicy(policy, "capability_policy"), true);
});

test("validateCapabilityPolicy requires approval_required_for to be an array", () => {
  const policy = { ...validPolicy(), approval_required_for: "x" };
  assert.throws(() => validateCapabilityPolicy(policy, "capability_policy"), /capability_policy\.approval_required_for must be an array/u);
});

test("validateCapabilityPolicy with a report collects every error instead of throwing and returns false", () => {
  const report = { errors: [] };
  const policy = { skills: null, mcp: {}, tools: {}, approval_required_for: "x" };
  const result = validateCapabilityPolicy(policy, "capability_policy", report);
  assert.equal(result, false);
  assert.ok(report.errors.includes("capability_policy.skills must be an object"));
  assert.ok(report.errors.includes("capability_policy.approval_required_for must be an array"));
  assert.ok(report.errors.length >= 2);
});

test("validateCapabilityPolicy with a report returns true and adds no errors for a valid policy", () => {
  const report = { errors: [] };
  assert.equal(validateCapabilityPolicy(validPolicy(), "capability_policy", report), true);
  assert.deepEqual(report.errors, []);
});

// ---------------------------------------------------------------------------
// buildCapabilityPolicy / normalizeCapabilitySet
// ---------------------------------------------------------------------------

test("buildCapabilityPolicy returns the empty policy shape for null or undefined", () => {
  const empty = { required: [], allowed: [], forbidden: [] };
  assert.deepEqual(buildCapabilityPolicy(null), { skills: empty, mcp: empty, tools: empty, approval_required_for: [] });
  assert.deepEqual(buildCapabilityPolicy(undefined), { skills: empty, mcp: empty, tools: empty, approval_required_for: [] });
});

test("buildCapabilityPolicy rejects a non-object policy", () => {
  assert.throws(() => buildCapabilityPolicy("nope"), UserError);
  assert.throws(() => buildCapabilityPolicy(["a"]), UserError);
});

test("buildCapabilityPolicy normalizes each group and re-validates the result", () => {
  const policy = buildCapabilityPolicy({ skills: { required: [" agentic-sdlc ", ""] }, approval_required_for: [" tool:rm "] });
  assert.deepEqual(policy.skills, { required: ["agentic-sdlc"], allowed: [], forbidden: [] });
  assert.deepEqual(policy.approval_required_for, ["tool:rm"]);
});

test("buildCapabilityPolicy rejects a normalized policy that is internally inconsistent", () => {
  assert.throws(() => buildCapabilityPolicy({ skills: { required: ["x"], forbidden: ["x"] } }), UserError);
});

test("normalizeCapabilitySet trims strings, drops blanks, and does not deduplicate", () => {
  // Current behaviour: normalizeListValue (used under the hood) does not dedupe, so a caller-supplied
  // duplicate survives normalization even though buildCapabilityPolicy's own recommendation builders
  // use pushAllUnique elsewhere.
  assert.deepEqual(normalizeCapabilitySet({ required: [" a ", "a", "", null] }), { required: ["a", "a"], allowed: [], forbidden: [] });
});

test("normalizeCapabilitySet treats a non-object input as an empty set", () => {
  assert.deepEqual(normalizeCapabilitySet(null), { required: [], allowed: [], forbidden: [] });
  assert.deepEqual(normalizeCapabilitySet("x"), { required: [], allowed: [], forbidden: [] });
});

// ---------------------------------------------------------------------------
// collectCapabilityPolicyReadinessGaps
// ---------------------------------------------------------------------------

test("collectCapabilityPolicyReadinessGaps returns no gaps for a contract with a valid (or absent) capability_policy", () => {
  assert.deepEqual(collectCapabilityPolicyReadinessGaps({ id: "CT-1" }), []);
  assert.deepEqual(collectCapabilityPolicyReadinessGaps({ id: "CT-1", capability_policy: validPolicy() }), []);
});

test("collectCapabilityPolicyReadinessGaps turns each policy validation error into a structured gap", () => {
  const contract = { id: "CT-1", capability_policy: { ...validPolicy(), skills: { required: ["x"], allowed: [], forbidden: ["x"] } } };
  const gaps = collectCapabilityPolicyReadinessGaps(contract);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].code, "invalid_capability_policy");
  assert.match(gaps[0].summary, /contract CT-1 capability_policy.*cannot be both required and forbidden/u);
  assert.match(gaps[0].question, /Replace capability_policy with valid/u);
});

test("collectCapabilityPolicyReadinessGaps labels the contract by phase when it has no id, and reports one gap per violation", () => {
  const contract = { phase: "implementation", capability_policy: { ...validPolicy(), skills: null } };
  const gaps = collectCapabilityPolicyReadinessGaps(contract);
  assert.equal(gaps.length, 1);
  assert.match(gaps[0].summary, /^contract implementation capability_policy\.skills must be an object$/u);
});

// ---------------------------------------------------------------------------
// normalizeCapabilityBinding / normalizeCapabilityBindings
// ---------------------------------------------------------------------------

test("normalizeCapabilityBinding accepts a well-formed binding and derives a default binding_id", () => {
  const binding = normalizeCapabilityBinding({ type: "Tool", name: "test-runner", target: { command: "npm test" } });
  assert.deepEqual(binding, {
    type: "tool",
    name: "test-runner",
    binding_id: "tool-test-runner",
    target: { command: "npm test" },
    permissions: [],
    requires_approval_for: [],
    environment: null,
    notes: [],
  });
});

test("normalizeCapabilityBinding rejects a binding with an unknown type", () => {
  assert.throws(() => normalizeCapabilityBinding({ type: "widget", name: "x", target: { a: 1 } }, 0), /capability binding 1 type must be skill, mcp, or tool/u);
});

test("normalizeCapabilityBinding rejects a binding without a name", () => {
  assert.throws(() => normalizeCapabilityBinding({ type: "tool", target: { a: 1 } }, 2), /capability binding 3 is missing name/u);
});

test("normalizeCapabilityBinding rejects a binding without a concrete (non-empty) target object", () => {
  assert.throws(() => normalizeCapabilityBinding({ type: "tool", name: "x" }), /missing a concrete target object/u);
  assert.throws(() => normalizeCapabilityBinding({ type: "tool", name: "x", target: {} }), /missing a concrete target object/u);
  assert.throws(() => normalizeCapabilityBinding({ type: "tool", name: "x", target: [1] }), /missing a concrete target object/u);
});

test("normalizeCapabilityBindings requires an array", () => {
  assert.throws(() => normalizeCapabilityBindings("nope"), /capability_bindings must be an array/u);
});

test("normalizeCapabilityBindings normalizes every valid entry and reports the correct 1-based index on failure", () => {
  const bindings = normalizeCapabilityBindings([{ type: "tool", name: "a", target: { x: 1 } }]);
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].binding_id, "tool-a");
  assert.throws(
    () => normalizeCapabilityBindings([{ type: "tool", name: "a", target: { x: 1 } }, { type: "bad" }]),
    /capability binding 2 type must be/u,
  );
});

// ---------------------------------------------------------------------------
// normalizeCapabilityRecommendationRefs
// ---------------------------------------------------------------------------

test("normalizeCapabilityRecommendationRefs normalizes ids and stringifies path/hash fields", () => {
  const refs = normalizeCapabilityRecommendationRefs([{ id: "rec 1", profile_id: "prof 1", path: " a/b.json ", approved_content_hash: " abc " }]);
  assert.deepEqual(refs, [{ id: "rec-1", profile_id: "prof-1", path: "a/b.json", approved_content_hash: "abc" }]);
});

test("normalizeCapabilityRecommendationRefs requires an array and JSON-object entries", () => {
  assert.throws(() => normalizeCapabilityRecommendationRefs("nope"), /capability_recommendation_refs must be an array/u);
  assert.throws(() => normalizeCapabilityRecommendationRefs(["nope"]), /capability recommendation ref 1 must be a JSON object/u);
});

// ---------------------------------------------------------------------------
// normalizeCapabilitySubject
// ---------------------------------------------------------------------------

test("normalizeCapabilitySubject prefers explicit options over the existing subject and defaults scope to 'project'", () => {
  const subject = normalizeCapabilitySubject(
    { story: "ST 1", phase: "Implementation", requirement: "REQ 1" },
    { story_id: "ST-OLD", phase: "design", requirement_ids: ["REQ-2"], scope: "story" },
  );
  assert.deepEqual(subject, {
    story_id: "ST-1",
    requirement_ids: ["REQ-2", "REQ-1"],
    phase: "implementation",
    scope: "story",
  });
});

test("normalizeCapabilitySubject falls back to the existing subject and defaults scope when options are empty", () => {
  const subject = normalizeCapabilitySubject({}, {});
  assert.deepEqual(subject, { story_id: null, requirement_ids: [], phase: null, scope: "project" });
});

// ---------------------------------------------------------------------------
// normalizeCapabilityEvidence
// ---------------------------------------------------------------------------

test("normalizeCapabilityEvidence keeps only plain-object entries and stringifies their fields", () => {
  const evidence = normalizeCapabilityEvidence([
    { type: "doc", path: "README.md", summary: "notes", sha256: "abc" },
    "not-an-object",
    ["array-entry"],
    { summary: "no type or path" },
  ]);
  assert.deepEqual(evidence, [
    { type: "doc", path: "README.md", summary: "notes", sha256: "abc" },
    { type: "evidence", path: null, summary: "no type or path", sha256: null },
  ]);
});

test("normalizeCapabilityEvidence returns an empty array for non-array input", () => {
  assert.deepEqual(normalizeCapabilityEvidence(null), []);
  assert.deepEqual(normalizeCapabilityEvidence("x"), []);
});

// ---------------------------------------------------------------------------
// normalizeCapabilityRecommendations / normalizeCapabilityItemType / normalizeCapabilityAvailability
// ---------------------------------------------------------------------------

test("normalizeCapabilityRecommendations fills in defaults and forces availability to install_required when install_required is set", () => {
  const [rec] = normalizeCapabilityRecommendations([{ type: "Tool", name: "runner", install_required: true, availability: "available" }]);
  assert.equal(rec.type, "tool");
  assert.equal(rec.availability, "install_required");
  assert.equal(rec.install_required, true);
  assert.equal(rec.approval_required, true, "approval_required defaults to install_required when not explicit");
});

test("normalizeCapabilityRecommendations respects an explicit approval_required even when install is not required", () => {
  const [rec] = normalizeCapabilityRecommendations([{ type: "skill", name: "s", approval_required: true }]);
  assert.equal(rec.install_required, false);
  assert.equal(rec.approval_required, true);
});

test("normalizeCapabilityRecommendations requires an array, JSON objects, and a non-empty name", () => {
  assert.throws(() => normalizeCapabilityRecommendations("nope"), /Capability recommendations must be an array/u);
  assert.throws(() => normalizeCapabilityRecommendations(["nope"]), /Capability recommendation 1 must be a JSON object/u);
  assert.throws(() => normalizeCapabilityRecommendations([{ type: "tool" }]), /Capability recommendation 1 is missing name/u);
});

test("normalizeCapabilityItemType accepts each known type and rejects anything else", () => {
  for (const type of ["skill", "mcp", "tool", "plugin", "connector", "model"]) {
    assert.equal(normalizeCapabilityItemType(type.toUpperCase()), type);
  }
  assert.throws(() => normalizeCapabilityItemType("widget"), /Unknown capability recommendation type 'widget'/u);
});

test("normalizeCapabilityAvailability accepts each known availability and rejects anything else, defaulting to 'unknown'", () => {
  assert.equal(normalizeCapabilityAvailability(undefined), "unknown");
  for (const value of ["available", "missing", "unknown", "install_required"]) {
    assert.equal(normalizeCapabilityAvailability(value.toUpperCase()), value);
  }
  assert.throws(() => normalizeCapabilityAvailability("sort-of"), /Unknown capability availability 'sort-of'/u);
});

// ---------------------------------------------------------------------------
// normalizeAvailableCapabilityEntries / normalizeAvailableCapabilityNames
// ---------------------------------------------------------------------------

test("normalizeAvailableCapabilityEntries reads a plain array of strings or objects", () => {
  const entries = normalizeAvailableCapabilityEntries({ skills: ["a", { name: "b", purpose: "does b" }] }, "skills");
  assert.deepEqual(entries, [{ name: "a" }, { name: "b", purpose: "does b" }]);
});

test("normalizeAvailableCapabilityEntries falls back to the singular key and to an object's installed/available/names field", () => {
  const bySingular = normalizeAvailableCapabilityEntries({ tool: ["x"] }, "tools");
  assert.deepEqual(bySingular, [{ name: "x" }]);
  const byInstalled = normalizeAvailableCapabilityEntries({ tools: { installed: ["y"] } }, "tools");
  assert.deepEqual(byInstalled, [{ name: "y" }]);
});

test("normalizeAvailableCapabilityEntries drops entries without a usable name", () => {
  const entries = normalizeAvailableCapabilityEntries({ skills: ["", { purpose: "no name" }, 42] }, "skills");
  assert.deepEqual(entries, []);
});

test("normalizeAvailableCapabilityNames returns just the names", () => {
  assert.deepEqual(normalizeAvailableCapabilityNames({ skills: ["a", "b"] }, "skills"), ["a", "b"]);
});

// ---------------------------------------------------------------------------
// buildDefaultCapabilityRecommendations
// ---------------------------------------------------------------------------

test("buildDefaultCapabilityRecommendations always recommends the agentic-sdlc skill as available", () => {
  const [first] = buildDefaultCapabilityRecommendations({ detected_stack: [] }, {});
  assert.equal(first.type, "skill");
  assert.equal(first.name, "agentic-sdlc");
  assert.equal(first.availability, "available");
  assert.equal(first.install_required, false);
});

test("buildDefaultCapabilityRecommendations gives a different rationale when the inventory itself confirms the skill", () => {
  const [first] = buildDefaultCapabilityRecommendations({ detected_stack: [] }, { skills: ["agentic-sdlc"] });
  assert.match(first.rationale, /reviewed inventory and the running plugin both confirm/u);
});

test("buildDefaultCapabilityRecommendations adds a test-runner tool recommendation only when Node is detected", () => {
  const withNode = buildDefaultCapabilityRecommendations({ detected_stack: [{ name: "node" }] }, {});
  assert.ok(withNode.some((item) => item.type === "tool" && item.name === "test-runner"));
  const withoutNode = buildDefaultCapabilityRecommendations({ detected_stack: [{ name: "python" }] }, {});
  assert.ok(!withoutNode.some((item) => item.type === "tool" && item.name === "test-runner"));
});

test("buildDefaultCapabilityRecommendations detects node via type === 'node' as well as by name", () => {
  const withNode = buildDefaultCapabilityRecommendations({ detected_stack: [{ type: "node", name: "something-else" }] }, {});
  assert.ok(withNode.some((item) => item.name === "test-runner"));
});

test("buildDefaultCapabilityRecommendations adds available inventory entries once each, skipping ones marked recommended: false", () => {
  const availableCapabilities = {
    tools: [{ name: "linter", purpose: "lint code" }, { name: "test-runner", recommended: false }],
    mcp: [{ name: "context7" }],
  };
  const recommendations = buildDefaultCapabilityRecommendations({ detected_stack: [{ name: "node" }] }, availableCapabilities);
  const names = recommendations.map((item) => `${item.type}:${item.name}`);
  assert.ok(names.includes("tool:linter"));
  assert.ok(names.includes("mcp:context7"));
  // test-runner was already added by the Node heuristic, so the recommended:false inventory entry
  // is skipped by the dedupe key rather than by its own flag - it would have been added anyway.
  assert.equal(names.filter((name) => name === "tool:test-runner").length, 1);
});

// ---------------------------------------------------------------------------
// mergeCapabilityPolicies / buildDefaultCapabilityPolicyPatch
// ---------------------------------------------------------------------------

test("mergeCapabilityPolicies unions groups across policies without duplicating entries", () => {
  const merged = mergeCapabilityPolicies(
    { skills: { required: ["a"] } },
    { skills: { required: ["a", "b"] }, approval_required_for: ["tool:rm"] },
  );
  assert.deepEqual(merged.skills.required, ["a", "b"]);
  assert.deepEqual(merged.approval_required_for, ["tool:rm"]);
});

test("mergeCapabilityPolicies ignores null/undefined policies in the list", () => {
  const merged = mergeCapabilityPolicies(null, { skills: { required: ["a"] } }, undefined);
  assert.deepEqual(merged.skills.required, ["a"]);
});

test("mergeCapabilityPolicies rejects a merge result that is internally inconsistent", () => {
  assert.throws(
    () => mergeCapabilityPolicies({ skills: { required: ["x"] } }, { skills: { forbidden: ["x"] } }),
    UserError,
  );
});

test("buildDefaultCapabilityPolicyPatch places install-required recommendations under 'required' and others under 'allowed'", () => {
  const policy = buildDefaultCapabilityPolicyPatch([
    { type: "skill", name: "agentic-sdlc", install_required: false, approval_required: false },
    { type: "tool", name: "installer", install_required: true, approval_required: true },
  ]);
  assert.deepEqual(policy.skills.allowed, ["agentic-sdlc"]);
  assert.deepEqual(policy.tools.required, ["installer"]);
  assert.deepEqual(policy.approval_required_for, ["tool:installer"]);
});
