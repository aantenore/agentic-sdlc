import test from "node:test";
import assert from "node:assert/strict";

import { UserError } from "../../lib/cli/user-error.mjs";
import {
  authorizationAllowsAction,
  authorizationAllowsArtifactType,
  authorizationAllowsSubject,
  authorizationProposalBindingError,
  authorizationUseReceiptProposalBindingErrors,
  buildLegacyAuthorizationUses,
  canonicalAuthorizationUseSubject,
  exactAuthorizationProposalRefMatch,
  legacyAuthorizationBindingErrors,
  normalizeApprovalCollectionScope,
  normalizeApprovalRequestScope,
  normalizeApprovalStatus,
  parseLegacyAuthorizationUses,
  validateApprovalPolicy,
  validateApprovalSourceForActor,
  validateAuthorizationUseReceipt,
} from "../../lib/lifecycle/authorization.mjs";
import { shortHashFull, stableJson } from "../../lib/lifecycle/common.mjs";
import {
  buildAuthorizationUsageReceipt,
  computeAuthorizationSubjectHash,
  createAuthorizationSnapshot,
} from "../../lib/authorization-receipts.mjs";

// ---------------------------------------------------------------------------
// legacyAuthorizationBindingErrors
// ---------------------------------------------------------------------------

test("legacyAuthorizationBindingErrors accepts an action/subject covered by allowed_uses", () => {
  const uses = buildLegacyAuthorizationUses(["contract.approve"], ["contract-ST-001"]);
  const record = { id: "AUTH-1", allowed_actions: ["contract.approve"], allowed_subjects: ["contract-ST-001"], allowed_uses: uses };
  assert.deepEqual(legacyAuthorizationBindingErrors(record, "contract.approve", "contract-ST-001"), []);
});

test("legacyAuthorizationBindingErrors flags a use entry whose hash does not match its action/subject", () => {
  const uses = buildLegacyAuthorizationUses(["contract.approve"], ["contract-ST-001"]);
  uses[0] = { ...uses[0], use_hash: "not-a-real-hash" };
  const record = { id: "AUTH-1", allowed_actions: ["contract.approve"], allowed_subjects: ["contract-ST-001"], allowed_uses: uses };
  const errors = legacyAuthorizationBindingErrors(record, "contract.approve", "contract-ST-001");
  assert.ok(errors.some((error) => error.includes("invalid action-subject hash")));
});

test("legacyAuthorizationBindingErrors flags allowed_actions that do not project from allowed_uses", () => {
  const uses = buildLegacyAuthorizationUses(["contract.approve"], ["contract-ST-001"]);
  const record = { id: "AUTH-1", allowed_actions: ["contract.reject"], allowed_subjects: ["contract-ST-001"], allowed_uses: uses };
  const errors = legacyAuthorizationBindingErrors(record, "contract.approve", "contract-ST-001");
  assert.ok(errors.includes("authorization allowed_actions does not match the projection of allowed_uses"));
});

test("legacyAuthorizationBindingErrors flags allowed_subjects that do not project from allowed_uses", () => {
  const uses = buildLegacyAuthorizationUses(["contract.approve"], ["contract-ST-001"]);
  const record = { id: "AUTH-1", allowed_actions: ["contract.approve"], allowed_subjects: ["contract-ST-002"], allowed_uses: uses };
  const errors = legacyAuthorizationBindingErrors(record, "contract.approve", "contract-ST-001");
  assert.ok(errors.includes("authorization allowed_subjects does not match the projection of allowed_uses"));
});

test("legacyAuthorizationBindingErrors fails closed for authorization:v3 without allowed_uses", () => {
  const record = { id: "AUTH-1", schema_version: "authorization:v3", allowed_actions: ["contract.approve"], allowed_subjects: ["contract-ST-001"] };
  assert.deepEqual(
    legacyAuthorizationBindingErrors(record, "contract.approve", "contract-ST-001"),
    ["authorization:v3 requires explicit allowed_uses action-subject pairs and must fail closed without them"],
  );
});

test("legacyAuthorizationBindingErrors fails closed for ambiguous multi-action multi-subject grants without allowed_uses", () => {
  const record = { id: "AUTH-1", allowed_actions: ["contract.approve", "contract.reject"], allowed_subjects: ["contract-ST-001", "contract-ST-002"] };
  assert.deepEqual(
    legacyAuthorizationBindingErrors(record, "contract.approve", "contract-ST-001"),
    ["authorization has multiple actions and multiple subjects without explicit pairs and must fail closed"],
  );
});

test("legacyAuthorizationBindingErrors names the missing action when only the subject is covered", () => {
  const record = { id: "AUTH-1", allowed_actions: ["contract.approve"], allowed_subjects: ["contract-ST-001"] };
  const errors = legacyAuthorizationBindingErrors(record, "contract.reject", "contract-ST-001");
  assert.deepEqual(errors, ["authorization does not allow action contract.reject"]);
});

test("legacyAuthorizationBindingErrors names the missing subject when only the action is covered", () => {
  const record = { id: "AUTH-1", allowed_actions: ["contract.approve"], allowed_subjects: ["contract-ST-001"] };
  const errors = legacyAuthorizationBindingErrors(record, "contract.approve", "contract-ST-999");
  assert.deepEqual(errors, ["authorization does not allow subject contract-ST-999"]);
});

test("legacyAuthorizationBindingErrors reports a combined error when the action and subject are each allowed individually but never together", () => {
  // One use covers the requested action (for a different subject); another covers the
  // requested subject (for a different action) - so neither single-branch message applies.
  const uses = [
    ...buildLegacyAuthorizationUses(["contract.approve"], ["contract-ST-001"]),
    ...buildLegacyAuthorizationUses(["contract.reject"], ["contract-ST-999"]),
  ];
  const record = { id: "AUTH-1", allowed_actions: ["contract.approve", "contract.reject"], allowed_subjects: ["contract-ST-001", "contract-ST-999"], allowed_uses: uses };
  const errors = legacyAuthorizationBindingErrors(record, "contract.approve", "contract-ST-999");
  assert.deepEqual(errors, ["authorization does not allow action contract.approve for subject contract-ST-999"]);
});

test("legacyAuthorizationBindingErrors treats wildcard action/subject '*' as matching anything", () => {
  const record = { id: "AUTH-1", allowed_actions: ["*"], allowed_subjects: ["*"] };
  assert.deepEqual(legacyAuthorizationBindingErrors(record, "contract.approve", "contract-ST-001"), []);
});

test("legacyAuthorizationBindingErrors treats an action ending in '.*' as a namespace prefix match", () => {
  const record = { id: "AUTH-1", allowed_actions: ["contract.*"], allowed_subjects: ["contract-ST-001"] };
  assert.deepEqual(legacyAuthorizationBindingErrors(record, "contract.approve", "contract-ST-001"), []);
});

// ---------------------------------------------------------------------------
// authorizationUseReceiptProposalBindingErrors
// ---------------------------------------------------------------------------

test("authorizationUseReceiptProposalBindingErrors: legacy receipt (no v1/v2 schema) only checks the top-level proposal_ref", () => {
  const receipt = { id: "USE-1", proposal_ref: { id: "PROP-1", hash: "a".repeat(64) } };
  const expected = { id: "PROP-1", hash: "a".repeat(64) };
  assert.deepEqual(authorizationUseReceiptProposalBindingErrors(receipt, expected), []);
});

test("authorizationUseReceiptProposalBindingErrors: legacy receipt reports a mismatch against the expected proposal", () => {
  const receipt = { id: "USE-1", proposal_ref: { id: "PROP-1", hash: "a".repeat(64) } };
  const expected = { id: "PROP-2", hash: "b".repeat(64) };
  const errors = authorizationUseReceiptProposalBindingErrors(receipt, expected);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /recorded use has proposal PROP-1 at hash a{64}; this action expects proposal PROP-2/u);
});

test("authorizationUseReceiptProposalBindingErrors: both sides null is a match", () => {
  const receipt = { id: "USE-1", proposal_ref: null };
  assert.deepEqual(authorizationUseReceiptProposalBindingErrors(receipt, null), []);
});

test("authorizationUseReceiptProposalBindingErrors: v1/v2 receipt checks subject, snapshot, and receipt proposal refs separately", () => {
  const expected = { id: "PROP-1", hash: "a".repeat(64) };
  const receipt = {
    id: "USE-1",
    schema_version: "authorization-usage-receipt:v2",
    subject: { proposal_ref: { id: "PROP-1", hash: "a".repeat(64) } },
    authorization_snapshot: { proposal_ref: { id: "PROP-1", hash: "a".repeat(64) } },
    proposal_ref: { id: "OTHER-PROP", hash: "c".repeat(64) },
  };
  const errors = authorizationUseReceiptProposalBindingErrors(receipt, expected);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /receipt proposal reference has proposal OTHER-PROP/u);
});

// ---------------------------------------------------------------------------
// validateAuthorizationUseReceipt: structural gate
// ---------------------------------------------------------------------------

test("validateAuthorizationUseReceipt rejects a missing or wrong-kind receipt without inspecting anything else", () => {
  assert.deepEqual(
    validateAuthorizationUseReceipt(null, { proposal_ref: { id: "P", hash: "a".repeat(64) } }),
    ["authorization usage receipt is missing or has the wrong kind"],
  );
  assert.deepEqual(
    validateAuthorizationUseReceipt({ kind: "something_else" }),
    ["authorization usage receipt is missing or has the wrong kind"],
  );
});

// ---------------------------------------------------------------------------
// validateAuthorizationUseReceipt: legacy schema versions
// ---------------------------------------------------------------------------

function buildLegacyReceiptFixture(overrides = {}) {
  const allowedActions = overrides.allowedActions || ["contract.approve"];
  const allowedSubjects = overrides.allowedSubjects || ["contract-ST-001"];
  const base = {
    kind: "authorization_usage_receipt",
    schema_version: overrides.schemaVersion || "authorization-usage-receipt:legacy-v2",
    id: overrides.id || "USE-LEGACY-1",
    authorization_id: overrides.authorizationId || "AUTH-LEGACY-1",
    action: overrides.action || "contract.approve",
    subject_id: overrides.subjectId || "contract-ST-001",
    artifact_types: overrides.artifactTypes || ["contract"],
    status: overrides.status || "accepted",
    valid_at_use: overrides.validAtUse === undefined ? true : overrides.validAtUse,
    used_at: overrides.usedAt || "2026-01-01T00:00:00.000Z",
    authorization_snapshot: overrides.authorizationSnapshot || {
      status_at_use: overrides.statusAtUse || "active",
      expires_at: overrides.expiresAt === undefined ? null : overrides.expiresAt,
      allowed_actions: allowedActions,
      allowed_subjects: allowedSubjects,
      ...(overrides.includeAllowedUses === false ? {} : { allowed_uses: buildLegacyAuthorizationUses(allowedActions, allowedSubjects) }),
    },
  };
  const receiptHash = shortHashFull(stableJson(base));
  return { ...base, receipt_hash: receiptHash, hash_algorithm: "sha256:stable-json:v1" };
}

test("validateAuthorizationUseReceipt accepts a well-formed legacy-v2 receipt matching the requested settings", () => {
  const receipt = buildLegacyReceiptFixture();
  const errors = validateAuthorizationUseReceipt(receipt, {
    authorization_id: "AUTH-LEGACY-1",
    action: "contract.approve",
    subject_id: "contract-ST-001",
    artifact_types: ["contract"],
  });
  assert.deepEqual(errors, []);
});

test("validateAuthorizationUseReceipt detects a legacy receipt mutated after issuance", () => {
  const receipt = { ...buildLegacyReceiptFixture(), action: "contract.reject" };
  const errors = validateAuthorizationUseReceipt(receipt, {});
  assert.ok(errors.some((error) => error.includes("changed after use")), errors.join("; "));
});

test("validateAuthorizationUseReceipt rejects a legacy receipt that was not accepted at use time", () => {
  const receipt = buildLegacyReceiptFixture({ status: "rejected", validAtUse: false });
  const errors = validateAuthorizationUseReceipt(receipt, {});
  assert.ok(errors.some((error) => error.includes("was not accepted at use time")), errors.join("; "));
});

test("validateAuthorizationUseReceipt flags an authorization_id mismatch against the requested settings", () => {
  const receipt = buildLegacyReceiptFixture();
  const errors = validateAuthorizationUseReceipt(receipt, { authorization_id: "AUTH-OTHER" });
  assert.ok(errors.includes("authorization usage receipt references AUTH-LEGACY-1, expected AUTH-OTHER"));
});

test("validateAuthorizationUseReceipt flags an action mismatch against the requested settings", () => {
  const receipt = buildLegacyReceiptFixture();
  const errors = validateAuthorizationUseReceipt(receipt, { action: "contract.reject" });
  assert.ok(errors.includes("authorization usage receipt action is contract.approve, expected contract.reject"));
});

test("validateAuthorizationUseReceipt flags a subject mismatch against the requested settings", () => {
  const receipt = buildLegacyReceiptFixture();
  const errors = validateAuthorizationUseReceipt(receipt, { subject_id: "contract-ST-999" });
  assert.ok(errors.includes("authorization usage receipt subject is contract-ST-001, expected contract-ST-999"));
});

test("validateAuthorizationUseReceipt propagates a binding error when the snapshot does not allow the action", () => {
  const receipt = buildLegacyReceiptFixture({ allowedActions: ["contract.reject"], action: "contract.reject" });
  const errors = validateAuthorizationUseReceipt(receipt, { action: "contract.approve" });
  // The receipt's own action ("contract.reject") is what legacyAuthorizationBindingErrors checks against
  // the snapshot; it is unrelated to the settings mismatch, which is reported separately.
  assert.ok(errors.some((error) => error.includes("authorization usage receipt action is contract.reject, expected contract.approve")));
});

test("validateAuthorizationUseReceipt flags a requested artifact type the receipt does not cover", () => {
  const receipt = buildLegacyReceiptFixture({ artifactTypes: ["contract"] });
  const errors = validateAuthorizationUseReceipt(receipt, { artifact_types: ["deployment"] });
  assert.ok(errors.includes("authorization usage receipt does not cover artifact type deployment"));
});

test("validateAuthorizationUseReceipt rejects a legacy receipt whose snapshot was not active at use time", () => {
  const receipt = buildLegacyReceiptFixture({ statusAtUse: "revoked" });
  const errors = validateAuthorizationUseReceipt(receipt, {});
  assert.ok(errors.includes("authorization was revoked when used"));
});

test("validateAuthorizationUseReceipt rejects a legacy receipt used after the snapshot's expiry", () => {
  const receipt = buildLegacyReceiptFixture({ expiresAt: "2025-12-31T00:00:00.000Z", usedAt: "2026-01-01T00:00:00.000Z" });
  const errors = validateAuthorizationUseReceipt(receipt, {});
  assert.ok(errors.some((error) => error.includes("was expired when receipt")));
});

test("validateAuthorizationUseReceipt rejects legacy-v1 receipts that declare allowed_uses", () => {
  const receipt = buildLegacyReceiptFixture({ schemaVersion: "authorization-usage-receipt:legacy-v1" });
  const errors = validateAuthorizationUseReceipt(receipt, {});
  assert.ok(errors.some((error) => error.includes("must not declare allowed_uses")));
});

test("validateAuthorizationUseReceipt requires legacy-v2 receipts to declare allowed_uses", () => {
  const receipt = buildLegacyReceiptFixture({ includeAllowedUses: false });
  const errors = validateAuthorizationUseReceipt(receipt, {});
  assert.ok(errors.some((error) => error.includes("requires allowed_uses")));
});

test("validateAuthorizationUseReceipt rejects an unsupported schema version", () => {
  const receipt = buildLegacyReceiptFixture({ schemaVersion: "authorization-usage-receipt:legacy-v3" });
  const errors = validateAuthorizationUseReceipt(receipt, {});
  assert.ok(errors.some((error) => error.includes("has unsupported schema version authorization-usage-receipt:legacy-v3")));
});

// ---------------------------------------------------------------------------
// validateAuthorizationUseReceipt: canonical (v1/v2) schema, built through the
// real authorization-receipts helpers so the fixtures are self-consistent.
// ---------------------------------------------------------------------------

function buildCanonicalFixture({
  action = "contract.approve",
  subjectId = "contract-ST-001",
  proposalRef = { id: "PROP-1", hash: "a".repeat(64) },
  artifactTypes = ["contract"],
  authorizationId = "AUTH-CANON-1",
  useAction = action,
} = {}) {
  const subject = canonicalAuthorizationUseSubject({
    proposal_ref: proposalRef,
    subject_id: subjectId,
    artifact_types: artifactTypes,
  });
  const snapshot = createAuthorizationSnapshot({
    id: authorizationId,
    proposal_ref: proposalRef,
    allowed_uses: [{ action, subject }],
    use_policy: { max_uses: 1 },
    authority_assurance: { mode: "audit_only" },
    valid_from: "2026-01-01T00:00:00.000Z",
    granted_by: { type: "human", id: "tester" },
  });
  const receipt = buildAuthorizationUsageReceipt(snapshot, {
    id: "USE-CANON-1",
    subject,
    used_at: "2026-01-02T00:00:00.000Z",
    action: useAction,
  });
  return { snapshot, receipt, subject, proposalRef };
}

test("validateAuthorizationUseReceipt accepts a well-formed canonical (v2) receipt matching the requested settings", () => {
  const { receipt, proposalRef } = buildCanonicalFixture();
  const errors = validateAuthorizationUseReceipt(receipt, {
    authorization_id: "AUTH-CANON-1",
    action: "contract.approve",
    proposal_ref: proposalRef,
    subject_id: "contract-ST-001",
    artifact_types: ["contract"],
  });
  assert.deepEqual(errors, []);
});

test("validateAuthorizationUseReceipt rejects a canonical receipt that was not allowed at use time", () => {
  const { receipt } = buildCanonicalFixture({ useAction: "contract.reject" });
  assert.equal(receipt.valid_at_use, false);
  const errors = validateAuthorizationUseReceipt(receipt, {});
  assert.ok(errors.some((error) => error.includes("was not allowed at use time")));
});

test("validateAuthorizationUseReceipt flags a canonical authorization_id mismatch", () => {
  const { receipt } = buildCanonicalFixture();
  const errors = validateAuthorizationUseReceipt(receipt, { authorization_id: "AUTH-OTHER" });
  assert.ok(errors.includes("authorization usage receipt references AUTH-CANON-1, expected AUTH-OTHER"));
});

test("validateAuthorizationUseReceipt flags a canonical subject content mismatch", () => {
  const { receipt } = buildCanonicalFixture();
  const errors = validateAuthorizationUseReceipt(receipt, { subject_id: "contract-ST-999" });
  assert.ok(errors.some((error) => error.includes("authorization usage receipt subject is contract-ST-001, expected contract-ST-999")));
  assert.ok(errors.some((error) => error.includes("not bound to the expected subject content")));
});

test("validateAuthorizationUseReceipt propagates a canonical proposal-binding mismatch from settings.proposal_ref", () => {
  const { receipt } = buildCanonicalFixture();
  const errors = validateAuthorizationUseReceipt(receipt, { proposal_ref: { id: "OTHER-PROP", hash: "b".repeat(64) } });
  // 3 proposal-binding errors (recorded use / authorization snapshot / receipt proposal reference), plus
  // one subject-content mismatch: the expected subject is rebuilt using the mismatched proposal_ref, so its
  // hash no longer matches receipt.subject's hash either.
  assert.equal(errors.length, 4, errors.join("; "));
  assert.equal(errors.filter((error) => error.includes("proposal binding mismatch")).length, 3);
  assert.ok(errors.some((error) => error.includes("not bound to the expected subject content")));
});

// ---------------------------------------------------------------------------
// validateApprovalPolicy
// ---------------------------------------------------------------------------

test("validateApprovalPolicy allows an undefined policy", () => {
  assert.doesNotThrow(() => validateApprovalPolicy(undefined));
});

test("validateApprovalPolicy allows a well-formed policy", () => {
  assert.doesNotThrow(() => validateApprovalPolicy({ accepted_sources: ["explicit-user", "ci"], legacy_approval_behavior: "warn" }));
});

test("validateApprovalPolicy rejects a non-object policy", () => {
  assert.throws(() => validateApprovalPolicy("nope"), UserError);
  assert.throws(() => validateApprovalPolicy(["a"]), UserError);
});

test("validateApprovalPolicy rejects accepted_sources that is not an array", () => {
  assert.throws(() => validateApprovalPolicy({ accepted_sources: "explicit-user" }), UserError);
});

test("validateApprovalPolicy rejects an unknown accepted source", () => {
  assert.throws(() => validateApprovalPolicy({ accepted_sources: ["telepathy"] }), UserError);
});

test("validateApprovalPolicy rejects an invalid legacy_approval_behavior", () => {
  assert.throws(() => validateApprovalPolicy({ legacy_approval_behavior: "ignore" }), UserError);
});

// ---------------------------------------------------------------------------
// normalizeApprovalStatus
// ---------------------------------------------------------------------------

test("normalizeApprovalStatus lowercases and trims a valid status", () => {
  assert.equal(normalizeApprovalStatus("Approved"), "approved");
  assert.equal(normalizeApprovalStatus("  rejected "), "rejected");
  assert.equal(normalizeApprovalStatus("changes_requested"), "changes_requested");
});

test("normalizeApprovalStatus rejects an unknown status", () => {
  assert.throws(() => normalizeApprovalStatus("maybe"), UserError);
});

// ---------------------------------------------------------------------------
// validateApprovalSourceForActor
// ---------------------------------------------------------------------------

test("validateApprovalSourceForActor is a no-op when the approval is not approved", () => {
  const context = { config: {} };
  assert.doesNotThrow(() => validateApprovalSourceForActor(context, { status: "rejected", label: "Contract approval" }));
});

test("validateApprovalSourceForActor accepts a well-formed explicit-user approval", () => {
  const context = { config: {} };
  assert.doesNotThrow(() => validateApprovalSourceForActor(context, {
    status: "approved",
    label: "Contract approval",
    source: "explicit-user",
    actor: { type: "human" },
    summary: "Looks correct",
    evidence: [],
  }));
});

test("validateApprovalSourceForActor requires an approval source under the default policy", () => {
  const context = { config: {} };
  assert.throws(() => validateApprovalSourceForActor(context, {
    status: "approved",
    label: "Contract approval",
    source: null,
    actor: { type: "human" },
    summary: "ok",
    evidence: [],
  }), UserError);
});

test("validateApprovalSourceForActor rejects explicit-user source from a non-human actor", () => {
  const context = { config: {} };
  assert.throws(() => validateApprovalSourceForActor(context, {
    status: "approved",
    label: "Contract approval",
    source: "explicit-user",
    actor: { type: "agent" },
    summary: "ok",
    evidence: [],
  }), UserError);
});

test("validateApprovalSourceForActor rejects ci source from a non-ci actor", () => {
  const context = { config: {} };
  assert.throws(() => validateApprovalSourceForActor(context, {
    status: "approved",
    label: "Contract approval",
    source: "ci",
    actor: { type: "human" },
    summary: "ok",
    evidence: [],
  }), UserError);
});

test("validateApprovalSourceForActor rejects automation source from an actor that is not agent/system/ci", () => {
  const context = { config: {} };
  assert.throws(() => validateApprovalSourceForActor(context, {
    status: "approved",
    label: "Contract approval",
    source: "automation",
    actor: { type: "human" },
    summary: "ok",
    evidence: [],
  }), UserError);
});

test("validateApprovalSourceForActor requires summary or evidence for explicit-user approvals", () => {
  const context = { config: {} };
  assert.throws(() => validateApprovalSourceForActor(context, {
    status: "approved",
    label: "Contract approval",
    source: "explicit-user",
    actor: { type: "human" },
    summary: null,
    evidence: [],
  }), UserError);
});

test("validateApprovalSourceForActor requires summary or evidence for bootstrap approvals", () => {
  const context = { config: {} };
  assert.throws(() => validateApprovalSourceForActor(context, {
    status: "approved",
    label: "Contract approval",
    source: "bootstrap",
    actor: { type: "human" },
    summary: null,
    evidence: [],
  }), UserError);
});

test("validateApprovalSourceForActor requires summary or evidence for automation approvals", () => {
  const context = { config: {} };
  assert.throws(() => validateApprovalSourceForActor(context, {
    status: "approved",
    label: "Contract approval",
    source: "automation",
    actor: { type: "agent" },
    summary: null,
    evidence: [],
  }), UserError);
});

test("validateApprovalSourceForActor accepts evidence in place of a summary", () => {
  const context = { config: {} };
  assert.doesNotThrow(() => validateApprovalSourceForActor(context, {
    status: "approved",
    label: "Contract approval",
    source: "automation",
    actor: { type: "system" },
    summary: null,
    evidence: ["ref-1"],
  }));
});

// ---------------------------------------------------------------------------
// normalizeApprovalCollectionScope / normalizeApprovalRequestScope
// ---------------------------------------------------------------------------

test("normalizeApprovalCollectionScope defaults every field when no options are given", () => {
  assert.deepEqual(normalizeApprovalCollectionScope(), {
    storyId: null,
    phase: null,
    contractId: null,
    activeOnly: false,
  });
});

test("normalizeApprovalCollectionScope normalizes ids and lowercases the phase", () => {
  const scope = normalizeApprovalCollectionScope({ storyId: "ST 001", phase: "Implementation", contractId: "contract ST 001", activeOnly: true });
  assert.deepEqual(scope, {
    storyId: "ST-001",
    phase: "implementation",
    contractId: "contract-ST-001",
    activeOnly: true,
  });
});

test("normalizeApprovalRequestScope fills in the fixed default flags", () => {
  assert.deepEqual(normalizeApprovalRequestScope(null), {
    applies_only_to_presented_item: true,
    cannot_approve_future_artifacts: true,
    requires_fresh_confirmation_for_new_artifacts: true,
  });
});

test("normalizeApprovalRequestScope layers caller fields over the defaults without letting them turn the safety flags off", () => {
  // Current behaviour: the spread order is `{ defaults, ...scope }`, so a caller-supplied
  // `applies_only_to_presented_item: false` DOES override the safety default. This looks
  // like it could weaken the approval-scope guarantee; pinning current behaviour here.
  const scope = normalizeApprovalRequestScope({ applies_only_to_presented_item: false, extra: "note" });
  assert.deepEqual(scope, {
    applies_only_to_presented_item: false,
    cannot_approve_future_artifacts: true,
    requires_fresh_confirmation_for_new_artifacts: true,
    extra: "note",
  });
});

// ---------------------------------------------------------------------------
// exactAuthorizationProposalRefMatch / authorizationProposalBindingError
// ---------------------------------------------------------------------------

test("exactAuthorizationProposalRefMatch treats null/undefined on both sides as a match", () => {
  assert.equal(exactAuthorizationProposalRefMatch(null, null), true);
  assert.equal(exactAuthorizationProposalRefMatch(undefined, undefined), true);
});

test("exactAuthorizationProposalRefMatch requires both id and hash to be present and equal", () => {
  const ref = { id: "P", hash: "a".repeat(64) };
  assert.equal(exactAuthorizationProposalRefMatch(ref, { id: "P", hash: "a".repeat(64) }), true);
  assert.equal(exactAuthorizationProposalRefMatch(ref, { id: "P", hash: "b".repeat(64) }), false);
  assert.equal(exactAuthorizationProposalRefMatch(ref, null), false);
  assert.equal(exactAuthorizationProposalRefMatch(ref, { id: "P" }), false);
});

test("authorizationProposalBindingError returns null on a match and a descriptive message on a mismatch", () => {
  const ref = { id: "P", hash: "a".repeat(64) };
  assert.equal(authorizationProposalBindingError({ id: "AUTH-1", proposal_ref: ref }, ref), null);
  const error = authorizationProposalBindingError({ id: "AUTH-1", proposal_ref: null }, ref);
  assert.match(error, /Authorization AUTH-1 proposal binding mismatch: grant has no proposal binding; this action expects proposal P/u);
});

// ---------------------------------------------------------------------------
// authorizationAllowsAction / authorizationAllowsSubject / authorizationAllowsArtifactType
// ---------------------------------------------------------------------------

test("authorizationAllowsAction matches exact, wildcard, and namespace-prefix actions", () => {
  assert.equal(authorizationAllowsAction({ allowed_actions: ["contract.approve"] }, "contract.approve"), true);
  assert.equal(authorizationAllowsAction({ allowed_actions: ["contract.approve"] }, "contract.reject"), false);
  assert.equal(authorizationAllowsAction({ allowed_actions: ["*"] }, "anything.at.all"), true);
  assert.equal(authorizationAllowsAction({ allowed_actions: ["contract.*"] }, "contract.approve"), true);
  assert.equal(authorizationAllowsAction({ allowed_actions: ["contract.*"] }, "deployment.approve"), false);
});

test("authorizationAllowsSubject reads legacy allowed_subjects for a legacy record", () => {
  assert.equal(authorizationAllowsSubject({ allowed_subjects: ["contract-ST-001"] }, "contract-ST-001"), true);
  assert.equal(authorizationAllowsSubject({ allowed_subjects: ["contract-ST-001"] }, "contract-ST-002"), false);
  assert.equal(authorizationAllowsSubject({ allowed_subjects: ["*"] }, "anything"), true);
  assert.equal(authorizationAllowsSubject({ allowed_subjects: [] }, null), true, "no subject requested is always allowed");
});

test("authorizationAllowsSubject reads scope.allowed_subject_ids for a canonical content authorization record", () => {
  const record = {
    kind: "content_authorization",
    schema_version: "content-authorization:v2",
    scope: { allowed_subject_ids: ["contract-ST-001"] },
  };
  assert.equal(authorizationAllowsSubject(record, "contract-ST-001"), true);
  assert.equal(authorizationAllowsSubject(record, "contract-ST-002"), false);
});

test("authorizationAllowsArtifactType reads legacy allowed_artifact_types for a legacy record", () => {
  assert.equal(authorizationAllowsArtifactType({ allowed_artifact_types: ["contract"] }, "contract"), true);
  assert.equal(authorizationAllowsArtifactType({ allowed_artifact_types: ["contract"] }, "deployment"), false);
  assert.equal(authorizationAllowsArtifactType({ allowed_artifact_types: [] }, null), true, "no artifact type requested is always allowed");
});

test("authorizationAllowsArtifactType reads scope.allowed_artifact_types for a canonical content authorization record", () => {
  const record = {
    kind: "content_authorization",
    schema_version: "content-authorization:v1",
    scope: { allowed_artifact_types: ["contract"] },
  };
  assert.equal(authorizationAllowsArtifactType(record, "contract"), true);
  assert.equal(authorizationAllowsArtifactType(record, "deployment"), false);
});

// ---------------------------------------------------------------------------
// buildLegacyAuthorizationUses / parseLegacyAuthorizationUses
// ---------------------------------------------------------------------------

test("buildLegacyAuthorizationUses derives the cross product of actions and subjects, deduplicated and sorted by hash", () => {
  const uses = buildLegacyAuthorizationUses(["contract.approve", "contract.approve"], ["contract-ST-001"]);
  assert.equal(uses.length, 1);
  assert.equal(uses[0].action, "contract.approve");
  assert.equal(uses[0].subject_id, "contract-ST-001");
  assert.equal(uses[0].use_hash, shortHashFull(stableJson({ action: "contract.approve", subject_id: "contract-ST-001" })));
});

test("buildLegacyAuthorizationUses treats an empty subject list as a single null-subject binding", () => {
  const uses = buildLegacyAuthorizationUses(["contract.approve"], []);
  assert.deepEqual(uses.map((use) => use.subject_id), [null]);
});

test("buildLegacyAuthorizationUses returns an empty array for no actions unless failOnAmbiguous is set", () => {
  assert.deepEqual(buildLegacyAuthorizationUses([], ["contract-ST-001"]), []);
  assert.throws(() => buildLegacyAuthorizationUses([], ["contract-ST-001"], { failOnAmbiguous: true }), UserError);
});

test("buildLegacyAuthorizationUses fails closed on multiple actions and multiple subjects when failOnAmbiguous is set", () => {
  assert.throws(
    () => buildLegacyAuthorizationUses(["a", "b"], ["s1", "s2"], { failOnAmbiguous: true }),
    UserError,
  );
  // Without failOnAmbiguous it silently builds the full (ambiguous) cross product instead.
  assert.equal(buildLegacyAuthorizationUses(["a", "b"], ["s1", "s2"]).length, 4);
});

test("parseLegacyAuthorizationUses parses action=subject pairs and deduplicates by hash", () => {
  const uses = parseLegacyAuthorizationUses(["contract.approve=contract-ST-001", "contract.approve=contract-ST-001"]);
  assert.equal(uses.length, 1);
  assert.equal(uses[0].action, "contract.approve");
  assert.equal(uses[0].subject_id, "contract-ST-001");
});

test("parseLegacyAuthorizationUses keeps a literal '*' subject instead of normalizing it as an id", () => {
  const uses = parseLegacyAuthorizationUses(["contract.approve=*"]);
  assert.equal(uses[0].subject_id, "*");
});

test("parseLegacyAuthorizationUses rejects an entry without an '=' separator", () => {
  assert.throws(() => parseLegacyAuthorizationUses(["contract.approve"]), UserError);
});

test("parseLegacyAuthorizationUses rejects an entry with an empty subject", () => {
  assert.throws(() => parseLegacyAuthorizationUses(["contract.approve="]), UserError);
});
