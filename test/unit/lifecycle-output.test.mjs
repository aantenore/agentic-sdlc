import test from "node:test";
import assert from "node:assert/strict";

import {
  canonicalOutputFormatOptions,
  createOutputRegistryQueryIndex,
  findOutputTemplate,
  formatActivityEventForView,
  formatBaselineCurrentStateSummary,
  formatBaselineDetectedStack,
  formatBaselineImportedDocuments,
  formatBaselineKeyFiles,
  formatConfigMigrationChange,
  formatDetectedStackForUser,
  formatExplainedOpenQuestion,
  formatLimitedList,
  formatReportQueryRecord,
  formatRouteDecision,
  formatTaskStartDecision,
  mutationGovernanceEvidencePaths,
  outputRegistryPairKey,
  outputRenderEvidenceOptions,
  outputResolutionFingerprint,
  outputResolutionGuidance,
  relatedOutputLinksFromIndex,
  renderActivityReportMarkdown,
  renderReportQueryMarkdown,
  traceEvidencePolicyBindingKey,
  traceEvidenceRefHash,
  verificationArtifactFormat,
  verificationArtifactSha256,
  verificationDimensionStatus,
  withEvidenceFormatFailure,
} from "../../lib/lifecycle/output.mjs";
import { EvidenceFormatError } from "../../lib/evidence-formats.mjs";

// -- mutationGovernanceEvidencePaths -------------------------------------------------

test("mutationGovernanceEvidencePaths merges the evidence and approval-evidence options", () => {
  assert.deepEqual(
    mutationGovernanceEvidencePaths({ evidence: ["a.json", "b.json"], "approval-evidence": "c.json" }),
    ["a.json", "b.json", "c.json"],
  );
  assert.deepEqual(mutationGovernanceEvidencePaths({}), []);
});

// -- formatConfigMigrationChange -----------------------------------------------------

test("formatConfigMigrationChange renders a replace of two scalar values", () => {
  assert.equal(
    formatConfigMigrationChange({ operation: "replace", path: "/name", before: "old", after: "new" }),
    "- replace /name: \"old\" -> \"new\"",
  );
});

test("formatConfigMigrationChange renders an add and a remove of a scalar value", () => {
  assert.equal(formatConfigMigrationChange({ operation: "add", path: "/flag", after: true }), "- add /flag: true");
  assert.equal(formatConfigMigrationChange({ operation: "remove", path: "/flag", before: 3 }), "- remove /flag: 3");
});

test("formatConfigMigrationChange falls back to a bare operation line for non-scalar values", () => {
  assert.equal(
    formatConfigMigrationChange({ operation: "replace", path: "/nested", before: { a: 1 }, after: { a: 2 } }),
    "- replace /nested",
  );
});

// -- formatTaskStartDecision ----------------------------------------------------------

function baseTaskStartDecision(overrides = {}) {
  return {
    status: "blocked",
    execution_allowed: false,
    contract_action: null,
    route: "claim_and_implement",
    phase: "implementation",
    story_id: "story-1",
    contract_id: "contract-1",
    blocking_reasons: [],
    questions: [],
    approval_requests: [],
    next_commands: [],
    ...overrides,
  };
}

test("formatTaskStartDecision reports the work as ready when status and execution_allowed agree", () => {
  const lines = formatTaskStartDecision(baseTaskStartDecision({ status: "ready_to_execute", execution_allowed: true }));
  assert.match(lines[0], /The agreed work is ready to start\./);
});

test("formatTaskStartDecision reports a revised agreement is required over a plain not-ready state", () => {
  const revised = formatTaskStartDecision(baseTaskStartDecision({ contract_action: "replace_contract_after_story_revision" }));
  assert.match(revised[0], /success criteria changed/);
  const notReady = formatTaskStartDecision(baseTaskStartDecision());
  assert.match(notReady[0], /work has not started yet/);
});

test("formatTaskStartDecision renders the Italian locale when __human_locale is it", () => {
  const lines = formatTaskStartDecision(baseTaskStartDecision({ __human_locale: "it", status: "ready_to_execute", execution_allowed: true }));
  assert.match(lines[0], /Il lavoro concordato è pronto per iniziare\./);
});

test("formatTaskStartDecision lists blocking reasons, questions, approval requests, and next commands when present", () => {
  const lines = formatTaskStartDecision(baseTaskStartDecision({
    blocking_reasons: ["missing_contract"],
    questions: ["What should ship first?"],
    approval_requests: [{ title: "Approve scope", summary: "scope", user_prompt: "Approve?" }],
    next_commands: ["agentic-sdlc contract create"],
  }));
  assert.ok(lines.some((line) => line.includes("Blocking reason codes: missing_contract")));
  assert.ok(lines.some((line) => line.includes("  - What should ship first?")));
  assert.ok(lines.some((line) => line.includes("Approve scope: Approve?")));
  assert.ok(lines.some((line) => line.includes("  - agentic-sdlc contract create")));
});

test("formatTaskStartDecision reports no blocking reasons and omits the lifecycle warning when absent", () => {
  const lines = formatTaskStartDecision(baseTaskStartDecision());
  assert.ok(lines.some((line) => line.includes("Blocking reason codes: none")));
  assert.ok(!lines.some((line) => line.includes("Lifecycle certification warning")));
});

// -- formatRouteDecision ---------------------------------------------------------------

function baseRouteDecision(overrides = {}) {
  return {
    route: "classify_artifact",
    status: "ready",
    confidence: 0.9,
    requires_confirmation: false,
    blocking_reasons: [],
    questions: [],
    deterministic_checks: [],
    next_commands: [],
    intent: {},
    ...overrides,
  };
}

test("formatRouteDecision reports the request is understood when the route is ready", () => {
  const lines = formatRouteDecision(baseRouteDecision());
  assert.match(lines[0], /request is understood and can be directed correctly/);
});

test("formatRouteDecision reports a missing acceptance criterion distinctly for a create_contract request", () => {
  const lines = formatRouteDecision(baseRouteDecision({
    blocking_reasons: ["missing_acceptance_criteria"],
    intent: { requested_action: "create_contract" },
  }));
  assert.match(lines[0], /work agreement cannot be prepared/);
});

test("formatRouteDecision reports a missing acceptance criterion generically outside contract creation", () => {
  const lines = formatRouteDecision(baseRouteDecision({ blocking_reasons: ["missing_acceptance_criteria"] }));
  assert.match(lines[0], /cannot be started/);
});

test("formatRouteDecision needs clarification when the route is not ready", () => {
  const lines = formatRouteDecision(baseRouteDecision({ status: "needs_clarification", route: "ask_clarification" }));
  assert.match(lines[0], /needs clarification before work can continue/);
});

test("formatRouteDecision includes the technical details block with route, status, and confidence", () => {
  const lines = formatRouteDecision(baseRouteDecision({ deterministic_checks: [{ check: "gate", status: "passed", details: "ok" }] }));
  assert.ok(lines.some((line) => line === "- Route: classify_artifact"));
  assert.ok(lines.some((line) => line === "- Confidence: 0.90"));
  assert.ok(
    lines.some((line) => line === "- - gate: passed (ok)"),
    "Current behaviour: deterministic-check lines are pre-dashed and then wrapped in another leading dash",
  );
});

test("formatRouteDecision renders the Italian locale via the options locale", () => {
  const lines = formatRouteDecision(baseRouteDecision(), { locale: "it" });
  assert.match(lines[0], /La richiesta è stata compresa/);
});

// -- formatBaseline* helpers ------------------------------------------------------------

test("formatBaselineCurrentStateSummary joins the available parts and returns the fallback when there is nothing to show", () => {
  const baseline = { summary: "A new project.", inferred_context: { product_signal: "b2b saas" } };
  assert.equal(formatBaselineCurrentStateSummary(baseline), "summary: A new project. | product signal: b2b saas");
  assert.equal(formatBaselineCurrentStateSummary({}, "no facts yet"), "no facts yet");
});

test("formatBaselineDetectedStack lists up to eight detected technologies with their source", () => {
  const baseline = { repository_snapshot: { detected_stack: [{ name: "Node.js", source_path: "package.json" }] } };
  assert.equal(formatBaselineDetectedStack(baseline), "Technology signals I found: Node.js from package.json");
});

test("formatBaselineDetectedStack returns null when nothing was detected", () => {
  assert.equal(formatBaselineDetectedStack({}), null);
});

test("formatBaselineImportedDocuments summarizes each document with its excerpt when present", () => {
  const baseline = { imported_documents: [{ path: "README.md", excerpt: "Project overview" }, { path: "docs/notes.md" }] };
  assert.equal(
    formatBaselineImportedDocuments(baseline),
    "Documents I read: README.md: Project overview, docs/notes.md",
  );
});

test("formatBaselineImportedDocuments returns null when there are no imported documents", () => {
  assert.equal(formatBaselineImportedDocuments({}), null);
});

test("formatBaselineKeyFiles lists up to ten key file paths or returns null", () => {
  const baseline = { repository_snapshot: { key_files: [{ path: "src/index.js" }] } };
  assert.equal(formatBaselineKeyFiles(baseline), "Important project files or folders detected: src/index.js");
  assert.equal(formatBaselineKeyFiles({}), null);
});

// -- formatLimitedList / formatDetectedStackForUser --------------------------------------

test("formatLimitedList joins values up to maxItems and reports how many more were hidden", () => {
  assert.equal(formatLimitedList(["a", "b", "c"], 2), "a, b, plus 1 more");
  assert.equal(formatLimitedList(["a", "b"], 5), "a, b");
});

test("formatDetectedStackForUser reports 'none detected' for an empty stack", () => {
  assert.equal(formatDetectedStackForUser([]), "none detected");
  assert.equal(formatDetectedStackForUser([{ name: "Node.js" }]), "Node.js");
});

// -- canonicalOutputFormatOptions / formatExplainedOpenQuestion ---------------------------

test("canonicalOutputFormatOptions excludes the custom format and describes generator-backed formats distinctly", () => {
  const options = canonicalOutputFormatOptions();
  assert.ok(!options.some((option) => option.id === "custom"));
  const docx = options.find((option) => option.id === "docx");
  assert.match(docx.description, /documents artifact capability/);
  const markdown = options.find((option) => option.id === "markdown");
  assert.match(markdown.description, /verified by the SDLC gate/);
});

test("formatExplainedOpenQuestion numbers the question only when an index is given", () => {
  const explanation = {
    question: "What is the delivery target?",
    what_is_requested: "the deployment destination",
    why_needed: "to route the change",
    example_answers: ["staging"],
    effect_of_answer: "unblocks routing",
  };
  assert.match(formatExplainedOpenQuestion(explanation), /^Open question: /);
  assert.match(formatExplainedOpenQuestion(explanation, 2), /^Open question 2: /);
});

// -- traceEvidenceRefHash / traceEvidencePolicyBindingKey ---------------------------------

test("traceEvidenceRefHash is deterministic for the same reference and differs for a different one", () => {
  const ref = { event_id: "e-1", evidence_path: "a.json" };
  assert.equal(traceEvidenceRefHash(ref), traceEvidenceRefHash({ ...ref }));
  assert.notEqual(traceEvidenceRefHash(ref), traceEvidenceRefHash({ ...ref, evidence_path: "b.json" }));
});

test("traceEvidencePolicyBindingKey requires every identifying field to be a non-empty string", () => {
  const target = {
    event_id: "e-1",
    event_hash: "h-1",
    evidence_path: "a.json",
    evidence_sha256: "sha-1",
    evidence_ref_sha256: "ref-1",
  };
  assert.equal(traceEvidencePolicyBindingKey(target), "e-1\u0000h-1\u0000a.json\u0000sha-1\u0000ref-1");
  assert.equal(traceEvidencePolicyBindingKey({ ...target, evidence_ref_sha256: "" }), null);
  assert.equal(traceEvidencePolicyBindingKey(null), null);
});

// -- outputResolutionGuidance -----------------------------------------------------------

test("outputResolutionGuidance explains that a governed format is still required", () => {
  const guidance = outputResolutionGuidance({ recommendation: "template_required" });
  assert.match(guidance.result, /governed format for this result is still missing/);
  assert.deepEqual(guidance.details, {});
});

test("outputResolutionGuidance explains a reuse_delta recommendation", () => {
  const guidance = outputResolutionGuidance({ recommendation: "reuse_delta" });
  assert.match(guidance.result, /approved result already exists and can be reused/);
});

test("outputResolutionGuidance distinguishes an already-linked result from an approved-format result", () => {
  const linked = outputResolutionGuidance({ recommendation: "linked" });
  assert.match(linked.result, /official result is already linked/);
  const approved = outputResolutionGuidance({ recommendation: "approved_format" });
  assert.match(approved.result, /approved format is available for creating the result/);
});

test("outputResolutionGuidance renders the Italian locale via the options locale", () => {
  const guidance = outputResolutionGuidance({ recommendation: "template_required" }, { locale: "it" });
  assert.match(guidance.result, /Manca ancora un formato governato/);
});

// -- outputResolutionFingerprint / outputRenderEvidenceOptions ---------------------------

test("outputResolutionFingerprint excludes cache_used but is stable across other field order", () => {
  const resolution = { recommendation: "linked", cache_used: true, artifact: { id: "a-1" } };
  assert.equal(
    outputResolutionFingerprint(resolution),
    outputResolutionFingerprint({ ...resolution, cache_used: false }),
  );
});

test("outputRenderEvidenceOptions merges render-evidence and evidence options without duplicates", () => {
  assert.deepEqual(
    outputRenderEvidenceOptions({ "render-evidence": "a.json|b.json", evidence: "b.json|c.json" }),
    ["a.json", "b.json", "c.json"],
  );
});

// -- formatReportQueryRecord / renderReportQueryMarkdown ---------------------------------

test("formatReportQueryRecord selects the query-facing fields and defaults array fields to empty", () => {
  const record = formatReportQueryRecord({ kind: "story", id: "story-1", summary: "s", created_at: "t1", updated_at: "t2" });
  assert.deepEqual(record.artifact_types, []);
  assert.deepEqual(record.requirements, []);
  assert.equal(record.requested_by, null);
  assert.deepEqual(record.sources, []);
});

test("renderReportQueryMarkdown reports 'no matches' when the result list is empty", () => {
  const markdown = renderReportQueryMarkdown({
    query: { intent: "find stories", subjects: ["story"] },
    summary: { result_count: 0 },
    results: [],
    source_paths: [],
  });
  assert.match(markdown, /No canonical KB records matched this query/);
  assert.match(markdown, /- None/);
});

test("renderReportQueryMarkdown lists each result with its source location when available", () => {
  const markdown = renderReportQueryMarkdown({
    query: { intent: "find stories", subjects: ["story"] },
    summary: { result_count: 1 },
    results: [{ created_at: "t1", kind: "story", id: "story-1", summary: "s", sources: [{ path: "a.json", line: 3 }] }],
    source_paths: ["a.json"],
  });
  assert.match(markdown, /- t1 story story-1: s \(a.json:3\)/);
});

// -- formatActivityEventForView / renderActivityReportMarkdown ---------------------------

test("formatActivityEventForView adds business-impact fields only for the business view", () => {
  const event = { type: "decision", action: "story.approve", evidence: ["e1"], related: ["story-1"] };
  const view = formatActivityEventForView(event, "business");
  assert.equal(view.impact, "decision");
  assert.equal(view.evidence_count, 1);
});

test("formatActivityEventForView surfaces git fields only for the dev view", () => {
  const event = { type: "implementation", git: { branch: "main", head_sha: "abc" } };
  const view = formatActivityEventForView(event, "dev");
  assert.equal(view.git.branch, "main");
  assert.equal(view.git.remote, null);
});

test("formatActivityEventForView includes the raw event for any other view", () => {
  const event = { type: "implementation", summary: "did work" };
  const view = formatActivityEventForView(event, "full");
  assert.equal(view.raw, event);
  assert.equal(view.run, null);
});

test("renderActivityReportMarkdown reports 'no events' when the window has no activity", () => {
  const markdown = renderActivityReportMarkdown({
    view: "business",
    window: { since: "t0", until: "t1" },
    summary: { event_count: 0, story_count: 0, by_type: {} },
    items: [],
    source_paths: [],
  });
  assert.match(markdown, /No canonical trace events in this window/);
});

// -- output registry index / links ------------------------------------------------------

test("outputRegistryPairKey joins two values with a NUL separator, defaulting nullish parts to empty", () => {
  assert.equal(outputRegistryPairKey("story-1", "technical-analysis"), "story-1\u0000technical-analysis");
  assert.equal(outputRegistryPairKey(null, undefined), "\u0000");
});

test("createOutputRegistryQueryIndex and relatedOutputLinksFromIndex find sibling stories sharing a requirement", () => {
  const registry = {
    templates: [{ id: "t-1", type: "technical-analysis" }],
    links: [
      { story_id: "story-1", artifact_type: "technical-analysis", requirements: ["req-1"] },
      { story_id: "story-2", artifact_type: "technical-analysis", requirements: ["req-1"] },
      { story_id: "story-3", artifact_type: "functional-analysis", requirements: ["req-1"] },
    ],
  };
  const index = createOutputRegistryQueryIndex(registry);
  assert.equal(index.templates_by_type.get("technical-analysis").length, 1);
  const related = relatedOutputLinksFromIndex(index, "story-1", "technical-analysis", ["req-1"]);
  assert.deepEqual(related.map((link) => link.story_id), ["story-2"]);
});

test("findOutputTemplate returns the matching template or null", () => {
  const registry = { templates: [{ id: "t-1" }, { id: "t-2" }] };
  assert.equal(findOutputTemplate(registry, "t-2").id, "t-2");
  assert.equal(findOutputTemplate(registry, "missing"), null);
});

// -- verification receipt helpers --------------------------------------------------------

test("verificationArtifactSha256 and verificationArtifactFormat read the nested artifact fields with a legacy fallback", () => {
  assert.equal(verificationArtifactSha256({ artifact: { sha256: "abc" } }), "abc");
  assert.equal(verificationArtifactSha256({ artifact_sha256: "legacy" }), "legacy");
  assert.equal(verificationArtifactFormat({ artifact: { format: "docx" } }), "docx");
  assert.equal(verificationArtifactFormat({ format: "legacy-docx" }), "legacy-docx");
});

test("verificationDimensionStatus maps passed to verified and not_required to not-required", () => {
  assert.equal(verificationDimensionStatus({ schema: { status: "passed" } }, "schema"), "verified");
  assert.equal(verificationDimensionStatus({ schema: { status: "not_required" } }, "schema"), "not-required");
  assert.equal(verificationDimensionStatus({ schema: { status: "failed" } }, "schema"), "failed");
  assert.equal(verificationDimensionStatus({}, "schema"), null);
});

// -- withEvidenceFormatFailure ------------------------------------------------------------

test("withEvidenceFormatFailure converts an EvidenceFormatError into a UserError-style failure", () => {
  assert.throws(
    () => withEvidenceFormatFailure(() => {
      throw new EvidenceFormatError("bad evidence format");
    }),
    /bad evidence format/,
  );
});

test("withEvidenceFormatFailure passes through the operation's result and rethrows unrelated errors", () => {
  assert.equal(withEvidenceFormatFailure(() => 42), 42);
  assert.throws(() => withEvidenceFormatFailure(() => {
    throw new TypeError("unrelated");
  }), TypeError);
});
