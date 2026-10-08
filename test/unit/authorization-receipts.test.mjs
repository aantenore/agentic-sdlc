import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  buildAuthorizationUsageReceipt,
  buildHostApprovalReceipt,
  computeAuthorizationHash,
  computeAuthorizationSubjectHash,
  createAuthorizationRevocation,
  createAuthorizationSnapshot,
  signHostApprovalReceipt,
  validateAuthorizationRevocationIntegrity,
  validateAuthorizationSnapshotAtUse,
  validateAuthorizationSnapshotIntegrity,
  validateAuthorizationUsageReceipt,
  validateHostApprovalReceiptAtUse,
} from "../../lib/authorization-receipts.mjs";
import { computeStableHash } from "../../lib/canonical.mjs";

const PROPOSAL_HASH = "a".repeat(64);
const HOST_RECEIPT_HASH = "b".repeat(64);
const subject = {
  kind: "assessment_proposal",
  id: "proposal-001",
  hash: PROPOSAL_HASH,
};
const secondSubject = {
  kind: "assessment_proposal",
  id: "proposal-002",
  hash: "c".repeat(64),
};
const hostKeyPair = crypto.generateKeyPairSync("ed25519");
const trustedHostKeys = [{
  key_id: "codex-host-test",
  algorithm: "Ed25519",
  public_key: hostKeyPair.publicKey.export({ type: "spki", format: "pem" }),
}];

function authorizationInput(overrides = {}) {
  return {
    id: "authorization-001",
    proposal_ref: { id: "proposal-001", path: "kb/proposals/proposal-001.json", hash: PROPOSAL_HASH },
    allowed_uses: [
      { action: "assessment.verify", subject },
      { action: "assessment.execute", subject },
    ],
    scope: { project: "TravelOps", workflow: "assessment-001" },
    use_policy: {
      mode: "single-use",
      max_uses: 1,
      close_on_workflow_terminal: true,
      require_usage_receipt: true,
    },
    authority_assurance: {
      source: "host-approval-receipt",
      receipt_ref: { id: "host-001", path: "kb/receipts/host-001.json", hash: HOST_RECEIPT_HASH },
      verified: true,
      verified_at: "2026-07-14T08:00:00.000Z",
    },
    valid_from: "2026-07-14T08:00:00.000Z",
    expires_at: "2026-07-14T10:00:00.000Z",
    granted_by: { type: "human", id: "antonio" },
    approval_source: "explicit-user",
    ...overrides,
  };
}

test("authorization snapshot is immutable, canonical, and bound to exact content", () => {
  const snapshot = createAuthorizationSnapshot(authorizationInput());
  const reordered = createAuthorizationSnapshot(authorizationInput({
    allowed_uses: [
      { action: "assessment.execute", subject },
      { action: "assessment.verify", subject },
    ],
    scope: { workflow: "assessment-001", project: "TravelOps" },
  }));

  assert.equal(snapshot.authorization_hash, reordered.authorization_hash);
  assert.equal(snapshot.proposal_ref.hash, PROPOSAL_HASH);
  assert.equal(snapshot.use_policy.mode, "single-use");
  assert.equal(snapshot.authority_assurance.receipt_ref.hash, HOST_RECEIPT_HASH);
  assert.equal(validateAuthorizationSnapshotIntegrity(snapshot).valid, true);
  assert.equal(Object.isFrozen(snapshot.allowed_actions), true);
  assert.equal(Object.isFrozen(snapshot.allowed_uses), true);

  const tampered = structuredClone(snapshot);
  tampered.scope.project = "OtherProject";
  const integrity = validateAuthorizationSnapshotIntegrity(tampered);
  assert.equal(integrity.valid, false);
  assert.match(integrity.errors.join("\n"), /scope_hash|authorization_hash/);
});

test("authorization binds each action to its exact subject instead of granting a Cartesian product", () => {
  const snapshot = createAuthorizationSnapshot(authorizationInput({
    allowed_uses: [
      { action: "assessment.execute", subject },
      { action: "assessment.verify", subject: secondSubject },
    ],
  }));
  const at = "2026-07-14T09:00:00.000Z";

  assert.equal(validateAuthorizationSnapshotAtUse(snapshot, {
    action: "assessment.execute",
    subject,
    used_at: at,
  }).decision, "allow");
  assert.equal(validateAuthorizationSnapshotAtUse(snapshot, {
    action: "assessment.verify",
    subject: secondSubject,
    used_at: at,
  }).decision, "allow");
  assert.equal(validateAuthorizationSnapshotAtUse(snapshot, {
    action: "assessment.execute",
    subject: secondSubject,
    used_at: at,
  }).decision, "deny");
  assert.equal(validateAuthorizationSnapshotAtUse(snapshot, {
    action: "assessment.verify",
    subject,
    used_at: at,
  }).decision, "deny");
});

test("ambiguous legacy snapshots and self-consistent legacy receipts fail closed", () => {
  const modern = createAuthorizationSnapshot(authorizationInput({
    allowed_uses: [
      { action: "assessment.execute", subject },
      { action: "assessment.verify", subject: secondSubject },
    ],
  }));
  const legacy = structuredClone(modern);
  legacy.schema_version = "content-authorization:v1";
  legacy.version = 1;
  delete legacy.allowed_uses;
  delete legacy.authorization_hash;
  delete legacy.hash_algorithm;
  legacy.authorization_hash = computeAuthorizationHash(legacy);
  legacy.hash_algorithm = "sha256:stable-json:v1";

  const integrity = validateAuthorizationSnapshotIntegrity(legacy);
  assert.equal(integrity.valid, false);
  assert.match(integrity.errors.join("\n"), /ambiguous|fail closed/);
  assert.equal(validateAuthorizationSnapshotAtUse(legacy, {
    action: "assessment.execute",
    subject: secondSubject,
    used_at: "2026-07-14T09:00:00.000Z",
  }).decision, "deny");

  const receiptBody = {
    kind: "authorization_usage_receipt",
    schema_version: "authorization-usage-receipt:v1",
    version: 1,
    id: "legacy-cross-pair",
    authorization_snapshot: legacy,
    authorization_id: legacy.id,
    authorization_hash: legacy.authorization_hash,
    action: "assessment.execute",
    subject: secondSubject,
    subject_hash: computeAuthorizationSubjectHash(secondSubject),
    used_at: "2026-07-14T09:00:00.000Z",
    decision: "allow",
    valid_at_use: true,
    errors: [],
    effective_revocation: null,
    proposal_ref: legacy.proposal_ref,
    historical_at_use_time: true,
    evidence: [],
  };
  const legacyReceipt = {
    ...receiptBody,
    receipt_hash: computeStableHash(receiptBody),
    hash_algorithm: "sha256:stable-json:v1",
  };
  assert.equal(validateAuthorizationUsageReceipt(legacyReceipt).valid, false);
});

test("unambiguous legacy snapshots retain only their safely deducible pairs", () => {
  const modern = createAuthorizationSnapshot(authorizationInput());
  const legacy = structuredClone(modern);
  legacy.schema_version = "content-authorization:v1";
  legacy.version = 1;
  delete legacy.allowed_uses;
  delete legacy.authorization_hash;
  delete legacy.hash_algorithm;
  legacy.authorization_hash = computeAuthorizationHash(legacy);
  legacy.hash_algorithm = "sha256:stable-json:v1";

  assert.equal(validateAuthorizationSnapshotIntegrity(legacy).valid, true);
  assert.equal(validateAuthorizationSnapshotAtUse(legacy, {
    action: "assessment.execute",
    subject,
    used_at: "2026-07-14T09:00:00.000Z",
  }).decision, "allow");
});

test("authorization use requires exact action, exact subject, and active time window", () => {
  const snapshot = createAuthorizationSnapshot(authorizationInput());
  const validUse = {
    action: "assessment.execute",
    subject,
    used_at: "2026-07-14T09:00:00.000Z",
  };

  assert.equal(validateAuthorizationSnapshotAtUse(snapshot, validUse).decision, "allow");
  assert.equal(validateAuthorizationSnapshotAtUse(snapshot, {
    ...validUse,
    action: "assessment.publish",
  }).decision, "deny");
  assert.equal(validateAuthorizationSnapshotAtUse(snapshot, {
    ...validUse,
    subject: { ...subject, hash: "c".repeat(64) },
  }).decision, "deny");
  assert.equal(validateAuthorizationSnapshotAtUse(snapshot, {
    ...validUse,
    used_at: "2026-07-14T07:59:59.000Z",
  }).decision, "deny");
  assert.equal(validateAuthorizationSnapshotAtUse(snapshot, {
    ...validUse,
    used_at: "2026-07-14T10:00:00.000Z",
  }).decision, "deny");
});

test("revocations are integrity-checked and applied historically at use time", () => {
  const snapshot = createAuthorizationSnapshot(authorizationInput());
  const revocation = createAuthorizationRevocation({
    id: "revocation-001",
    authorization_id: snapshot.id,
    authorization_hash: snapshot.authorization_hash,
    effective_at: "2026-07-14T09:30:00.000Z",
    reason: "Scope withdrawn",
    revoked_by: { type: "human", id: "antonio" },
  });

  assert.equal(validateAuthorizationRevocationIntegrity(revocation).valid, true);
  const before = validateAuthorizationSnapshotAtUse(snapshot, {
    action: "assessment.execute",
    subject,
    used_at: "2026-07-14T09:00:00.000Z",
  }, [revocation]);
  const after = validateAuthorizationSnapshotAtUse(snapshot, {
    action: "assessment.execute",
    subject,
    used_at: "2026-07-14T09:31:00.000Z",
  }, [revocation]);
  assert.equal(before.decision, "allow");
  assert.equal(after.decision, "deny");
  assert.equal(after.effective_revocation.id, revocation.id);

  const tamperedRevocation = structuredClone(revocation);
  tamperedRevocation.reason = "Changed without re-hashing";
  const failClosed = validateAuthorizationSnapshotAtUse(snapshot, {
    action: "assessment.execute",
    subject,
    used_at: "2026-07-14T09:31:00.000Z",
  }, [tamperedRevocation]);
  assert.equal(failClosed.decision, "deny");
  assert.match(failClosed.errors.join("\n"), /failed integrity validation/);
});

test("authorization usage receipt preserves validity at the historical use time", () => {
  const snapshot = createAuthorizationSnapshot(authorizationInput());
  const futureRevocation = createAuthorizationRevocation({
    id: "revocation-future",
    authorization_id: snapshot.id,
    authorization_hash: snapshot.authorization_hash,
    effective_at: "2026-07-14T09:30:00.000Z",
    reason: "Withdraw after the recorded use",
    revoked_by: { type: "human", id: "antonio" },
  });
  const receipt = buildAuthorizationUsageReceipt(snapshot, {
    id: "authorization-use-001",
    action: "assessment.execute",
    subject,
    used_at: "2026-07-14T09:00:00.000Z",
    evidence: [{ kind: "workflow-transition", id: "start-001" }],
  }, [futureRevocation]);

  assert.equal(receipt.valid_at_use, true);
  assert.equal(receipt.decision, "allow");
  assert.equal(receipt.proposal_ref.hash, PROPOSAL_HASH);
  assert.equal(validateAuthorizationUsageReceipt(receipt, [futureRevocation]).valid, true);

  const tampered = structuredClone(receipt);
  tampered.action = "assessment.publish";
  assert.equal(validateAuthorizationUsageReceipt(tampered, [futureRevocation]).valid, false);
});

test("host approval requires a trusted Ed25519 attestation and subject-bound constraints", () => {
  const unsigned = buildHostApprovalReceipt({
    id: "host-approval-001",
    action: "assessment.authorize",
    subject,
    subject_ref: { kind: "assessment_proposal", id: "proposal-001", hash: PROPOSAL_HASH },
    checkpoint: { type: "proposal", normal_checkpoint: 2 },
    question: "Authorize this exact proposal?",
    why: "Execution needs explicit authority.",
    authorizes: ["Execute the exact proposal hash"],
    excludes: ["Production access", "Additional budget"],
    examples: {
      it: ["Approvo la proposta e il suo hash."],
      en: ["I approve the proposal and its hash."],
    },
    response: {
      raw: "Approved",
      normalized_summary: "Approved exact proposal",
      message_hash: "d".repeat(64),
    },
    host: {
      provider: "codex",
      thread_id: "thread-1",
      message_id: "message-1",
      trust: "host-attested",
    },
    decision: "approved",
    decided_at: "2026-07-14T08:00:00.000Z",
    expires_at: "2026-07-14T10:00:00.000Z",
    decided_by: { type: "human", id: "antonio" },
    constraints: {
      subject_hash: computeAuthorizationSubjectHash(subject),
      no_scope_expansion: true,
      no_budget_extension: true,
    },
  });
  const receipt = signHostApprovalReceipt(unsigned, {
    key_id: trustedHostKeys[0].key_id,
    private_key: hostKeyPair.privateKey,
  });

  assert.equal(receipt.question_contract.asked, "Authorize this exact proposal?");
  assert.equal(receipt.host.message_id, "message-1");
  assert.equal(receipt.subject_hash, computeAuthorizationSubjectHash(subject));
  assert.equal(receipt.attestation.algorithm, "Ed25519");
  assert.equal(validateHostApprovalReceiptAtUse(receipt, {
    action: "assessment.authorize",
    subject,
    used_at: "2026-07-14T09:00:00.000Z",
  }).decision, "deny");
  assert.equal(validateHostApprovalReceiptAtUse(receipt, {
    action: "assessment.authorize",
    subject,
    used_at: "2026-07-14T09:00:00.000Z",
  }, { trusted_host_keys: trustedHostKeys }).decision, "allow");
  assert.equal(validateHostApprovalReceiptAtUse(receipt, {
    action: "assessment.authorize",
    subject: { ...subject, id: "proposal-002" },
    used_at: "2026-07-14T09:00:00.000Z",
  }, { trusted_host_keys: trustedHostKeys }).decision, "deny");
  assert.equal(validateHostApprovalReceiptAtUse(receipt, {
    action: "assessment.authorize",
    subject,
    used_at: "2026-07-14T10:00:00.000Z",
  }, { trusted_host_keys: trustedHostKeys }).decision, "deny");

  // Every host receipt shares one key rule: a key verifies receipts decided
  // inside its window; a retired one keeps verifying them, never new ones.
  const use = { action: "assessment.authorize", subject, used_at: "2026-07-14T09:00:00.000Z" };
  const withKey = (window, options = {}) => validateHostApprovalReceiptAtUse(receipt, use, {
    trusted_host_keys: [{ ...trustedHostKeys[0], ...window }],
    ...options,
  });
  assert.equal(withKey({ retired: true, not_after: "2026-07-15T00:00:00.000Z" }).decision, "allow");
  assert.match(withKey({ retired: true }, { active_at: "2026-07-14T09:00:00.000Z" }).errors.join(), /is retired/u);
  assert.match(withKey({ not_after: "2026-07-14T07:00:00.000Z" }).errors.join(), /not valid when the receipt was decided/u);
  assert.match(withKey({ not_after: "2026-07-14T08:30:00.000Z" }, { active_at: "2026-07-14T09:00:00.000Z" }).errors.join(), /not active for new decisions/u);
  assert.equal(withKey({ not_before: "2026-07-01T00:00:00.000Z" }, { active_at: "2026-07-14T09:00:00.000Z" }).decision, "allow");

  const tampered = structuredClone(receipt);
  tampered.constraints.no_budget_extension = false;
  const tamperedBody = { ...tampered };
  delete tamperedBody.receipt_hash;
  delete tamperedBody.hash_algorithm;
  tampered.receipt_hash = computeStableHash(tamperedBody);
  assert.equal(validateHostApprovalReceiptAtUse(tampered, {
    action: "assessment.authorize",
    subject,
    used_at: "2026-07-14T09:00:00.000Z",
  }, { trusted_host_keys: trustedHostKeys }).decision, "deny");

  assert.throws(() => buildHostApprovalReceipt({
    ...structuredClone(unsigned),
    id: "host-approval-invalid-constraints",
    constraints: { subject_hash: "f".repeat(64) },
  }), /constraints.subject_hash/);
  assert.throws(() => buildHostApprovalReceipt({
    ...structuredClone(unsigned),
    id: "host-approval-unsupported-constraint",
    constraints: {
      subject_hash: computeAuthorizationSubjectHash(subject),
      unimplemented_scope_rule: true,
    },
  }), /unsupported fields that cannot be enforced/);
  assert.throws(() => buildHostApprovalReceipt({
    ...structuredClone(unsigned),
    id: "host-approval-incomplete-question",
    question_contract: {
      asked: "Approve?",
      why: "Required.",
      authorizes: [],
      does_not_authorize: ["Other work"],
      examples: { en: ["Approve"] },
    },
  }), /question_contract.*authorizes/);
  assert.throws(() => buildHostApprovalReceipt({
    ...structuredClone(unsigned),
    id: "host-approval-empty-examples",
    question_contract: {
      asked: "Approve?",
      why: "Required.",
      authorizes: ["Exact proposal"],
      does_not_authorize: ["Other work"],
      examples: { en: [] },
    },
  }), /examples entries/);
});
