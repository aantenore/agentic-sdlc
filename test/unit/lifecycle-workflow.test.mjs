import test from "node:test";
import assert from "node:assert/strict";

import { UserError } from "../../lib/cli/user-error.mjs";
import {
  assertStoryBoundWorkflowPhaseOrder,
  buildWorkflowStartRequest,
  buildWorkflowStartTransaction,
  buildWorkflowTransitionJournal,
  extendWorkflowTraceChain,
  humanizeWorkflowIdentifier,
  normalizeWorkflowVersion,
  workflowDefinitionRef,
  workflowHumanDisplayIdentifier,
  workflowHumanFriendlyString,
  workflowHumanHashLikeKey,
  workflowHumanKeyParts,
  workflowHumanMainSequence,
  workflowHumanMetadataChanges,
  workflowHumanMetadataDifference,
  workflowHumanSafeValue,
  workflowHumanSecretLikeKey,
  workflowHumanStateName,
  workflowHumanValuesEqual,
  workflowIntegrityBlockedGuidance,
  workflowItalianPresentation,
  workflowOverlayChanges,
  workflowPhaseOrderDifference,
  workflowStartRequestHash,
  workflowStartTransactionErrors,
  workflowStartTransactionHash,
  workflowTraceAnchorErrors,
  workflowTraceIntent,
  workflowTraceIntentMatches,
  workflowTransitionJournalErrors,
  workflowTransitionJournalHash,
} from "../../lib/lifecycle/workflow.mjs";

// -- normalizeWorkflowVersion --------------------------------------------------------

test("normalizeWorkflowVersion accepts a positive whole number string and trims it", () => {
  assert.equal(normalizeWorkflowVersion(" 2 ", "definition-version"), "2");
  assert.equal(normalizeWorkflowVersion(1, "definition-version"), "1");
});

test("normalizeWorkflowVersion rejects zero, negative, decimal, and leading-zero values", () => {
  assert.throws(() => normalizeWorkflowVersion("0", "definition-version"), /Invalid --definition-version '0'/);
  assert.throws(() => normalizeWorkflowVersion("-1", "definition-version"), UserError);
  assert.throws(() => normalizeWorkflowVersion("1.5", "overlay-version"), /Invalid --overlay-version '1.5'/);
  assert.throws(() => normalizeWorkflowVersion("01", "definition-version"), UserError);
});

// -- humanizeWorkflowIdentifier / workflowHumanKeyParts / workflowItalianPresentation --

test("humanizeWorkflowIdentifier title-cases each dash/underscore/space separated part", () => {
  assert.equal(humanizeWorkflowIdentifier("technical-assessment"), "Technical Assessment");
  assert.equal(humanizeWorkflowIdentifier("already_snake case"), "Already Snake Case");
  assert.equal(humanizeWorkflowIdentifier(""), "");
  assert.equal(humanizeWorkflowIdentifier(null), "");
});

test("workflowHumanKeyParts splits camelCase, acronyms, and non-letter separators into words", () => {
  assert.deepEqual(workflowHumanKeyParts("workflowDefinitionID"), ["workflow", "Definition", "ID"]);
  assert.deepEqual(workflowHumanKeyParts("phase_order-count"), ["phase", "order", "count"]);
});

test("workflowItalianPresentation returns the mapped Italian label for a known token and null otherwise", () => {
  assert.equal(workflowItalianPresentation("technical-assessment"), "Valutazione tecnica");
  assert.equal(workflowItalianPresentation("Technical Assessment"), "Valutazione tecnica");
  assert.equal(workflowItalianPresentation("unmapped-token"), null);
});

test("workflowHumanDisplayIdentifier is blank for an empty value and otherwise localizes or humanizes it", () => {
  assert.equal(workflowHumanDisplayIdentifier(undefined, "state_id", false), "");
  assert.equal(workflowHumanDisplayIdentifier("technical-assessment", "state_id", true), "Valutazione tecnica");
  assert.equal(workflowHumanDisplayIdentifier("custom-state", "state_id", true), "Custom State");
});

test("workflowHumanDisplayIdentifier rejects a value carrying unsafe control characters", () => {
  assert.throws(() => workflowHumanDisplayIdentifier("bad\u0007value", "state_id", false), UserError);
});

// -- workflowHumanStateName / workflowHumanMainSequence -------------------------------

test("workflowHumanStateName prefers the state's label, then name, then title, then id", () => {
  const definition = { states: [{ id: "impl", label: "Implementation Step" }] };
  assert.equal(workflowHumanStateName(definition, "impl", false), "Implementation Step");
});

test("workflowHumanStateName falls back to humanizing the raw state id when the state is unknown", () => {
  const definition = { states: [] };
  assert.equal(workflowHumanStateName(definition, "some-state", false), "Some State");
});

test("workflowHumanMainSequence uses phase_order when present", () => {
  const definition = { phase_order: ["discovery", "design"], states: [] };
  assert.deepEqual(workflowHumanMainSequence(definition, false), ["Discovery", "Design"]);
});

test("workflowHumanMainSequence walks the transition chain from the initial state when phase_order is absent", () => {
  const definition = {
    states: [{ id: "a" }, { id: "b" }, { id: "c" }],
    initial_state: "a",
    transitions: [{ from: "a", to: "b" }, { from: "b", to: "c" }],
  };
  assert.deepEqual(workflowHumanMainSequence(definition, false), ["A", "B", "C"]);
});

// -- workflowHumanSecretLikeKey / workflowHumanHashLikeKey ----------------------------

test("workflowHumanSecretLikeKey flags metadata keys that look like credentials", () => {
  assert.equal(workflowHumanSecretLikeKey("api_secret_token"), true);
  assert.equal(workflowHumanSecretLikeKey("access_key"), true);
  assert.equal(workflowHumanSecretLikeKey("workflow_name"), false);
});

test("workflowHumanHashLikeKey flags metadata keys that look like an integrity digest", () => {
  assert.equal(workflowHumanHashLikeKey("content_hash"), true);
  assert.equal(workflowHumanHashLikeKey("checksum"), true);
  assert.equal(workflowHumanHashLikeKey("display_name"), false);
});

// -- workflowHumanFriendlyString -------------------------------------------------------

test("workflowHumanFriendlyString quotes a plain descriptive value unchanged", () => {
  assert.equal(workflowHumanFriendlyString("A short description.", "description", false), "“A short description.”");
});

test("workflowHumanFriendlyString humanizes a dash/underscore separated identifier value", () => {
  assert.equal(workflowHumanFriendlyString("needs-more-detail", "value", false), "“Needs More Detail”");
});

test("workflowHumanFriendlyString translates known vocabulary terms into the requested locale", () => {
  assert.match(workflowHumanFriendlyString("bounded-autonomous", "value", false), /completion within the approved limits/u);
  assert.match(workflowHumanFriendlyString("bounded-autonomous", "value", true), /completamento entro i limiti approvati/u);
});

test("workflowHumanFriendlyString rejects a value that exceeds the text character limit", () => {
  assert.throws(() => workflowHumanFriendlyString("x".repeat(241), "value", false), /exceeds 240 characters/u);
});

test("workflowHumanFriendlyString rejects a hash-like or UUID-like value as not human-readable", () => {
  assert.throws(() => workflowHumanFriendlyString("a".repeat(40), "value", false), /has no human-readable name/u);
  assert.throws(() => workflowHumanFriendlyString("550e8400-e29b-41d4-a716-446655440000", "value", false), UserError);
});

test("workflowHumanFriendlyString rejects a value containing a CLI flag or filesystem path", () => {
  assert.throws(() => workflowHumanFriendlyString("run --force now", "value", false), /command or technical location/u);
  assert.throws(() => workflowHumanFriendlyString("see ./local/path for detail", "value", false), UserError);
});

// -- workflowHumanSafeValue ------------------------------------------------------------

test("workflowHumanSafeValue renders each primitive JSON type in the requested locale", () => {
  assert.equal(workflowHumanSafeValue(null, false), "empty");
  assert.equal(workflowHumanSafeValue(null, true), "vuoto");
  assert.equal(workflowHumanSafeValue(true, false), "yes");
  assert.equal(workflowHumanSafeValue(false, false), "no");
  assert.equal(workflowHumanSafeValue(3, false), "3");
  assert.equal(workflowHumanSafeValue(Number.NaN, false), "invalid number");
});

test("workflowHumanSafeValue renders an array as a comma-joined list and an object as key/value details", () => {
  assert.equal(
    workflowHumanSafeValue(["draft", "approved"], false, { key: "status_history" }),
    "list (“draft”, “approved”)",
    "Current behaviour: a single-word string is quoted as-is, not title-cased like a dashed identifier",
  );
  assert.match(workflowHumanSafeValue({ owner: "team-a" }, false), /^details \(.*Owner.*=.*Team A.*\)$/u);
});

test("workflowHumanSafeValue rejects a list with more items than the configured collection limit", () => {
  const longList = Array.from({ length: 11 }, (_, index) => `item-${index}`);
  assert.throws(() => workflowHumanSafeValue(longList, false), /more than 10 values/u);
});

test("workflowHumanSafeValue rejects a value nested deeper than the configured limit", () => {
  const deeplyNested = [[[[["too-deep"]]]]];
  assert.throws(() => workflowHumanSafeValue(deeplyNested, false), /exceeds 3 levels of detail/u);
});

// -- workflowHumanValuesEqual / workflowHumanMetadataChanges / workflowHumanMetadataDifference --

test("workflowHumanValuesEqual compares by JSON structure, not by reference", () => {
  assert.equal(workflowHumanValuesEqual({ a: 1 }, { a: 1 }), true);
  assert.equal(workflowHumanValuesEqual({ a: 1 }, { a: 2 }), false);
});

test("workflowHumanMetadataChanges reports only the fields that actually changed value", () => {
  const changes = workflowHumanMetadataChanges({ owner: "team-a", count: 1 }, { owner: "team-a", count: 2 }, { count: 2 }, false);
  assert.deepEqual(changes, ["Count changes from 1 to 2"], "numbers render unquoted, unlike strings");
});

test("workflowHumanMetadataChanges reports a newly introduced field as being set", () => {
  const changes = workflowHumanMetadataChanges({}, { owner: "team-a" }, { owner: "team-a" }, false);
  assert.deepEqual(changes, ["Owner is set to “Team A”"]);
});

test("workflowHumanMetadataDifference returns null when there is nothing to report and a scoped line otherwise", () => {
  assert.equal(workflowHumanMetadataDifference("general information", {}, {}, {}, false), null);
  assert.equal(
    workflowHumanMetadataDifference("general information", {}, { owner: "team-a" }, { owner: "team-a" }, false),
    "general information: Owner is set to “Team A”",
  );
});

// -- workflowPhaseOrderDifference / assertStoryBoundWorkflowPhaseOrder ----------------

test("workflowPhaseOrderDifference reports an exact match when the workflow mirrors the configured phase order", () => {
  const context = { config: { phase_order: ["discovery", "design"], phases: {} } };
  const difference = workflowPhaseOrderDifference(context, { phase_order: ["discovery", "design"] });
  assert.equal(difference.exact, true);
  assert.deepEqual(difference.missing, []);
  assert.deepEqual(difference.extra, []);
});

test("workflowPhaseOrderDifference reports missing and extra phases when they diverge", () => {
  const context = { config: { phase_order: ["discovery", "design"], phases: {} } };
  const difference = workflowPhaseOrderDifference(context, { phase_order: ["discovery", "release"] });
  assert.equal(difference.exact, false);
  assert.deepEqual(difference.missing, ["design"]);
  assert.deepEqual(difference.extra, ["release"]);
});

test("assertStoryBoundWorkflowPhaseOrder passes silently for an exact phase order match", () => {
  const context = { config: { phase_order: ["discovery"], phases: {} } };
  assert.doesNotThrow(() => assertStoryBoundWorkflowPhaseOrder(context, { phase_order: ["discovery"] }));
});

test("assertStoryBoundWorkflowPhaseOrder fails with the configured and workflow phase orders when they diverge", () => {
  const context = { config: { phase_order: ["discovery", "design"], phases: {} } };
  assert.throws(
    () => assertStoryBoundWorkflowPhaseOrder(context, { phase_order: ["discovery"] }),
    /missing configured phases: design/,
  );
});

// -- workflowOverlayChanges -------------------------------------------------------------

test("workflowOverlayChanges prefers an explicit operations or changes array", () => {
  const operations = [{ op: "replace", path: "/name" }];
  assert.equal(workflowOverlayChanges({ operations }), operations);
  const changes = [{ op: "add" }];
  assert.equal(workflowOverlayChanges({ changes }), changes);
});

test("workflowOverlayChanges converts a patch object into sorted field/value pairs", () => {
  assert.deepEqual(
    workflowOverlayChanges({ patch: { zeta: 1, alpha: 2 } }),
    [{ field: "alpha", value: 2 }, { field: "zeta", value: 1 }],
  );
});

test("workflowOverlayChanges falls back to the overlay's own fields, excluding bookkeeping keys", () => {
  const overlay = { id: "ov-1", version: "1", status: "draft", summary: "s", custom_field: "value", another: "b" };
  assert.deepEqual(workflowOverlayChanges(overlay), [
    { field: "another", value: "b" },
    { field: "custom_field", value: "value" },
  ]);
});

// -- hash / trace-chain builders ---------------------------------------------------------

test("workflowStartRequestHash changes when any field other than intent_hash changes", () => {
  const request = { instance_id: "wf-1", summary: "s" };
  const hash = workflowStartRequestHash(request);
  assert.notEqual(hash, workflowStartRequestHash({ ...request, summary: "different" }));
  assert.equal(hash, workflowStartRequestHash({ ...request, intent_hash: "ignored-field" }));
});

test("buildWorkflowStartRequest signs the request with a matching intent_hash", () => {
  const definition = { id: "wf-def", version: "1", definition_hash: "def-hash" };
  const effectiveDefinition = { effective_hash: "eff-hash" };
  const request = buildWorkflowStartRequest("wf-1", definition, null, effectiveDefinition, { id: "actor-1" }, "kickoff");
  assert.equal(request.intent_hash, workflowStartRequestHash(request));
  assert.equal(request.overlay_ref, null);
  assert.equal(request.definition_ref.id, "wf-def");
});

test("workflowDefinitionRef extracts only id, version, and definition_hash", () => {
  assert.deepEqual(
    workflowDefinitionRef({ id: "wf-1", version: "2", definition_hash: "h", extra: "ignored" }),
    { id: "wf-1", version: "2", definition_hash: "h" },
  );
});

test("buildWorkflowStartTransaction and workflowStartTransactionHash agree on the signed transaction hash", () => {
  const journal = buildWorkflowStartTransaction({
    request: { instance_id: "wf-1" },
    instance: { id: "wf-1" },
    checkpoint: { sequence: 0 },
    trace_event: { id: "TR-1" },
    trace_anchor: { size_bytes: 0, prefix_hash: "a".repeat(64) },
  });
  assert.equal(journal.transaction_hash, workflowStartTransactionHash(journal));
});

test("buildWorkflowTransitionJournal and workflowTransitionJournalHash agree on the signed transaction hash", () => {
  const journal = buildWorkflowTransitionJournal(
    { id: "wf-1", instance_hash: "inst-hash" },
    { sequence: 0, checkpoint_hash: "a".repeat(64), trace_chain_hash: "b".repeat(64), hash_algorithm: "sha256:stable-json:v1" },
    { effective_hash: "eff-hash", sequence: 1 },
    { sequence: 1 },
    { id: "TR-2" },
    { size_bytes: 0, prefix_hash: "c".repeat(64) },
    { size_bytes: 0, prefix_hash: "d".repeat(64) },
  );
  assert.equal(journal.transaction_hash, workflowTransitionJournalHash(journal));
});

test("extendWorkflowTraceChain rejects a previous digest that is not a valid 64-hex-character hash", () => {
  assert.throws(() => extendWorkflowTraceChain("not-a-hash", { id: "TR-1" }), UserError);
});

test("extendWorkflowTraceChain is deterministic and changes with either input", () => {
  const first = extendWorkflowTraceChain(null, { id: "TR-1" });
  assert.equal(first, extendWorkflowTraceChain(null, { id: "TR-1" }));
  assert.notEqual(first, extendWorkflowTraceChain(null, { id: "TR-2" }));
  assert.notEqual(first, extendWorkflowTraceChain("a".repeat(64), { id: "TR-1" }));
});

test("workflowTraceIntent strips the integrity envelope and workflowTraceIntentMatches compares by intent only", () => {
  const stored = { id: "TR-1", action: "workflow.instance.start", _trace_integrity: { checksum: "x" } };
  assert.deepEqual(workflowTraceIntent(stored), { id: "TR-1", action: "workflow.instance.start" });
  assert.equal(workflowTraceIntentMatches(stored, { id: "TR-1", action: "workflow.instance.start" }), true);
  assert.equal(workflowTraceIntentMatches(stored, { id: "TR-1", action: "workflow.instance.transition" }), false);
});

// -- workflowTraceAnchorErrors ------------------------------------------------------------

test("workflowTraceAnchorErrors accepts a well-formed anchor", () => {
  assert.deepEqual(workflowTraceAnchorErrors({ size_bytes: 128, prefix_hash: "a".repeat(64) }), []);
});

test("workflowTraceAnchorErrors rejects a non-object anchor outright", () => {
  assert.deepEqual(workflowTraceAnchorErrors(null), ["trace anchor must be an object"]);
  assert.deepEqual(workflowTraceAnchorErrors([1, 2]), ["trace anchor must be an object"]);
});

test("workflowTraceAnchorErrors flags unsupported fields, a negative size, and a malformed prefix hash", () => {
  const errors = workflowTraceAnchorErrors({ size_bytes: -1, prefix_hash: "not-hex", extra_field: true });
  assert.equal(errors.length, 3);
  assert.match(errors[0], /unsupported fields: extra_field/);
  assert.match(errors[1], /non-negative whole number/);
  assert.match(errors[2], /prefix hash is invalid/);
});

// -- workflowStartTransactionErrors (structural branches; full-validity path needs the -----
// workflow engine's real checkpoint/replay machinery, out of scope for a lifecycle unit test) --

test("workflowStartTransactionErrors returns a single error for a non-object journal", () => {
  assert.deepEqual(workflowStartTransactionErrors(null, {}, {}), ["start transaction must be a JSON object"]);
});

test("workflowStartTransactionErrors flags unsupported fields and an unsupported kind/schema_version", () => {
  const errors = workflowStartTransactionErrors({ kind: "wrong_kind", extra: true }, {}, {});
  assert.ok(errors.includes("start transaction has unsupported fields: extra"));
  assert.ok(errors.includes("start transaction has an unsupported format"));
});

test("workflowStartTransactionErrors flags a request that differs from the interrupted request", () => {
  const expectedRequest = { instance_id: "wf-1", intent_hash: "will-not-match" };
  const journal = {
    kind: "workflow_instance_start_transaction",
    schema_version: "workflow-instance-start-transaction:v1",
    request: { instance_id: "wf-1", intent_hash: "different" },
  };
  const errors = workflowStartTransactionErrors(journal, expectedRequest, { effective_hash: "eff" });
  assert.ok(errors.includes("start intent differs from the interrupted request"));
});

test("workflowStartTransactionErrors flags a transaction hash that does not match its own content", () => {
  const expectedRequest = buildWorkflowStartRequest("wf-1", { id: "d", version: "1", definition_hash: "h" }, null, { effective_hash: "eff" }, { id: "a" }, null);
  const journal = {
    kind: "workflow_instance_start_transaction",
    schema_version: "workflow-instance-start-transaction:v1",
    request: expectedRequest,
    transaction_hash: "tampered",
  };
  const errors = workflowStartTransactionErrors(journal, expectedRequest, { effective_hash: "eff" });
  assert.ok(errors.includes("start transaction hash does not match its content"));
});

test("workflowStartTransactionErrors flags an instance that does not match the requested process", () => {
  const expectedRequest = buildWorkflowStartRequest("wf-1", { id: "d", version: "1", definition_hash: "h" }, null, { effective_hash: "eff" }, { id: "a" }, null);
  const journal = buildWorkflowStartTransaction({
    request: expectedRequest,
    instance: { id: "wf-1", effective_hash: "different-effective-hash" },
    checkpoint: {},
    trace_event: {},
    trace_anchor: { size_bytes: 0, prefix_hash: "a".repeat(64) },
  });
  const errors = workflowStartTransactionErrors(journal, expectedRequest, { effective_hash: "eff" });
  assert.ok(errors.includes("start transaction instance does not match the requested process"));
});

// -- workflowTransitionJournalErrors (structural branches only, same rationale as above) --

test("workflowTransitionJournalErrors returns a single error for a non-object journal", () => {
  assert.deepEqual(
    workflowTransitionJournalErrors(null, { id: "wf-1", instance_hash: "h" }, {}),
    ["pending workflow transition must be a JSON object"],
  );
});

test("workflowTransitionJournalErrors flags a journal bound to a different instance", () => {
  const instance = { id: "wf-1", instance_hash: "hash-1" };
  const effectiveDefinition = { effective_hash: "eff" };
  const journal = {
    kind: "workflow_transition_transaction",
    schema_version: "workflow-transition-transaction:v1",
    instance_id: "wf-other",
    instance_hash: "hash-1",
    effective_hash: "eff",
    from_sequence: 0,
    from_checkpoint_hash: "a".repeat(64),
    from_trace_chain_hash: "b".repeat(64),
    hash_algorithm: "sha256:stable-json:v1",
  };
  const errors = workflowTransitionJournalErrors(journal, instance, effectiveDefinition);
  assert.ok(errors.includes("pending workflow transition does not belong to this instance"));
});

test("workflowTransitionJournalErrors flags an invalid starting sequence and malformed checkpoint/trace hashes", () => {
  const instance = { id: "wf-1", instance_hash: "hash-1" };
  const effectiveDefinition = { effective_hash: "eff" };
  const journal = {
    kind: "workflow_transition_transaction",
    schema_version: "workflow-transition-transaction:v1",
    instance_id: "wf-1",
    instance_hash: "hash-1",
    effective_hash: "eff",
    from_sequence: -1,
    from_checkpoint_hash: "not-hex",
    from_trace_chain_hash: "also-not-hex",
    hash_algorithm: "sha256:stable-json:v1",
  };
  const errors = workflowTransitionJournalErrors(journal, instance, effectiveDefinition);
  assert.ok(errors.includes("pending workflow transition has an invalid starting sequence"));
  assert.ok(errors.includes("pending workflow transition has an invalid starting checkpoint hash"));
  assert.ok(errors.includes("pending workflow transition has an invalid starting trace-chain hash"));
});

test("workflowTransitionJournalErrors flags a request/target mismatch against the expected transition", () => {
  const instance = { id: "wf-1", instance_hash: "hash-1" };
  const effectiveDefinition = { effective_hash: "eff" };
  const journal = {
    kind: "workflow_transition_transaction",
    schema_version: "workflow-transition-transaction:v1",
    instance_id: "wf-1",
    instance_hash: "hash-1",
    effective_hash: "eff",
    from_sequence: 0,
    from_checkpoint_hash: "a".repeat(64),
    from_trace_chain_hash: "b".repeat(64),
    hash_algorithm: "sha256:stable-json:v1",
    event: { instance_id: "wf-1", instance_hash: "hash-1", effective_hash: "eff", sequence: 1, idempotency_key: "req-actual", to: "state-actual" },
  };
  const errors = workflowTransitionJournalErrors(journal, instance, effectiveDefinition, { requestId: "req-expected", targetState: "state-expected" });
  assert.ok(errors.includes("pending workflow transition belongs to a different request"));
  assert.ok(errors.includes("pending workflow transition targets a different state"));
});

// -- workflowIntegrityBlockedGuidance ------------------------------------------------

test("workflowIntegrityBlockedGuidance offers a repeat-the-transition recovery when recovery is available", () => {
  const guidance = workflowIntegrityBlockedGuidance({}, { recovery_available: true, recovery_target_state: "design" });
  assert.match(guidance.result, /stopped before all records were completed/);
  assert.match(guidance.next_action, /Design/);
});

test("workflowIntegrityBlockedGuidance falls back to a restore-from-backup message when recovery is unavailable", () => {
  const guidance = workflowIntegrityBlockedGuidance({}, {});
  assert.match(guidance.result, /recorded history cannot be trusted/);
});

test("workflowIntegrityBlockedGuidance renders both locales", () => {
  const en = workflowIntegrityBlockedGuidance({}, {});
  const it = workflowIntegrityBlockedGuidance({ locale: "it" }, {});
  assert.notEqual(en.result, it.result);
  assert.match(it.result, /cronologia registrata/);
});
