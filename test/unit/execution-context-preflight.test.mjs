import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExecutionContextPreflightReceipt,
  computeExecutionContextPreflightHash,
  executionContextSnapshotRevalidationDecision,
  executionContextSourceEvolutionDecision,
  validateExecutionContextPreflightReceipt,
  workspaceChangeMatchesPreflight,
} from "../../lib/execution-context-preflight.mjs";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

function ref(id, hash = HASH_A) {
  return { id, path: `.sdlc/${id}.json`, hash };
}

function receiptInput() {
  return {
    id: "PREFLIGHT-AUT-LOCAL-001",
    story_ref: ref("ST-001"),
    contract_ref: ref("CONTRACT-001", HASH_B),
    delivery_profile_ref: ref("AUT-LOCAL-001", HASH_C),
    requirement_scopes: [
      {
        profile_ref: ref("AUT-REQ-001", HASH_D),
        allowed_write_paths: ["docs", "src/app.mjs"],
      },
      {
        profile_ref: ref("AUT-REQ-002", HASH_C),
        allowed_write_paths: ["src"],
      },
    ],
    sources: [
      {
        path: "src/app.mjs",
        sha256: HASH_A,
        file_type: "regular",
        mode: 0o644,
        binding: {
          kind: "requirement",
          id: "REQ-001",
          record_path: ".sdlc/requirements/REQ-001.json",
          expected_sha256: HASH_A,
        },
      },
      {
        path: "src/app.mjs",
        sha256: HASH_A,
        file_type: "regular",
        mode: 0o644,
        binding: {
          kind: "contract_context",
          id: "CONTRACT-001",
          record_path: ".sdlc/contracts/CONTRACT-001.json",
          expected_sha256: HASH_A,
        },
      },
      {
        path: "README.md",
        sha256: HASH_B,
        file_type: "regular",
        mode: 0o644,
        binding: {
          kind: "baseline",
          id: "BASELINE-INITIAL",
          record_path: ".sdlc/baseline/BASELINE-INITIAL.json",
          expected_sha256: HASH_B,
        },
      },
    ],
    workspace_changes: [
      {
        path: "src/config.mjs",
        status: " M",
        file_type: "regular",
        mode: 0o644,
        content_sha256: HASH_D,
      },
    ],
    git_head_sha: "1".repeat(40),
    created_by: { id: "ci", type: "ci" },
    created_at: "2026-07-28T12:00:00.000Z",
    audit: { git: {}, run: {} },
  };
}

test("preflight authorizes evolution only inside every approved requirement scope", () => {
  const receipt = buildExecutionContextPreflightReceipt(receiptInput());
  assert.equal(validateExecutionContextPreflightReceipt(receipt).valid, true);
  assert.equal(
    receipt.source_snapshots.find((source) => source.path === "src/app.mjs").disposition,
    "authorized_evolution",
  );
  assert.equal(
    receipt.source_snapshots.find((source) => source.path === "README.md").disposition,
    "immutable_context",
  );

  const allowed = executionContextSourceEvolutionDecision(receipt, {
    story_ref: receipt.story_ref,
    contract_ref: receipt.contract_ref,
    delivery_profile_ref: receipt.delivery_profile_ref,
    path: "src/app.mjs",
    expected_sha256: HASH_A,
    binding_kind: "requirement",
    binding_id: "REQ-001",
  });
  assert.equal(allowed.allowed, true);

  const wrongBinding = executionContextSourceEvolutionDecision(receipt, {
    story_ref: receipt.story_ref,
    contract_ref: receipt.contract_ref,
    delivery_profile_ref: receipt.delivery_profile_ref,
    path: "src/app.mjs",
    expected_sha256: HASH_A,
    binding_kind: "baseline",
    binding_id: "BASELINE-INITIAL",
  });
  assert.equal(wrongBinding.allowed, false);
  assert.equal(wrongBinding.reason, "source_binding_mismatch");
});

test("preflight rejects pre-start source drift and detects receipt tampering", () => {
  const input = receiptInput();
  input.sources[0].sha256 = HASH_C;
  assert.throws(
    () => buildExecutionContextPreflightReceipt(input),
    /changed before task start/u,
  );

  const receipt = buildExecutionContextPreflightReceipt(receiptInput());
  const tampered = structuredClone(receipt);
  tampered.source_snapshots[0].disposition = "authorized_evolution";
  const validation = validateExecutionContextPreflightReceipt(tampered);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.includes("receipt_hash")));
});

test("pre-existing dirty state is exempt only while its exact status and bytes remain unchanged", () => {
  const receipt = buildExecutionContextPreflightReceipt(receiptInput());
  assert.equal(workspaceChangeMatchesPreflight(receipt, {
    path: "src/config.mjs",
    status: " M",
    file_type: "regular",
    mode: 0o644,
    content_sha256: HASH_D,
  }), true);
  assert.equal(workspaceChangeMatchesPreflight(receipt, {
    path: "src/config.mjs",
    status: " M",
    file_type: "regular",
    mode: 0o644,
    content_sha256: HASH_A,
  }), false);
  assert.equal(workspaceChangeMatchesPreflight(receipt, {
    path: "src/config.mjs",
    status: " M",
    file_type: "regular",
    mode: 0o755,
    content_sha256: HASH_D,
  }), false);
  assert.equal(workspaceChangeMatchesPreflight(receipt, {
    path: "src/other.mjs",
    status: "??",
    file_type: "regular",
    mode: 0o644,
    content_sha256: HASH_D,
  }), false);
});

test("sealing revalidation detects source, workspace identity, and Git races", () => {
  const receipt = buildExecutionContextPreflightReceipt(receiptInput());
  const current = {
    git_head_sha: receipt.git_head_sha,
    source_snapshots: receipt.source_snapshots.map((source) => ({
      path: source.path,
      sha256: source.sha256,
      file_type: source.file_type,
      mode: source.mode,
    })),
    workspace_changes: receipt.workspace_changes,
  };
  assert.equal(executionContextSnapshotRevalidationDecision(receipt, current).valid, true);

  const sourceRace = structuredClone(current);
  sourceRace.source_snapshots[0].sha256 = HASH_C;
  assert.deepEqual(
    executionContextSnapshotRevalidationDecision(receipt, sourceRace).errors,
    ["execution context source changed while sealing: README.md"],
  );

  const workspaceRace = structuredClone(current);
  workspaceRace.workspace_changes[0].mode = 0o755;
  assert.deepEqual(
    executionContextSnapshotRevalidationDecision(receipt, workspaceRace).errors,
    ["workspace status or file identity changed while sealing execution context"],
  );

  const headRace = structuredClone(current);
  headRace.git_head_sha = "2".repeat(40);
  assert.deepEqual(
    executionContextSnapshotRevalidationDecision(receipt, headRace).errors,
    ["Git HEAD changed while sealing execution context"],
  );
});

test("legacy receipts remain readable but cannot authorize mutable-context exemptions", () => {
  const currentReceipt = buildExecutionContextPreflightReceipt(receiptInput());
  const legacyReceipt = structuredClone(currentReceipt);
  for (const source of legacyReceipt.source_snapshots) {
    delete source.file_type;
    delete source.mode;
  }
  for (const change of legacyReceipt.workspace_changes) {
    delete change.file_type;
    delete change.mode;
  }
  legacyReceipt.receipt_hash = computeExecutionContextPreflightHash(legacyReceipt);

  assert.equal(validateExecutionContextPreflightReceipt(legacyReceipt).valid, true);
  assert.equal(workspaceChangeMatchesPreflight(legacyReceipt, {
    path: "src/config.mjs",
    status: " M",
    file_type: "regular",
    mode: 0o644,
    content_sha256: HASH_D,
  }), false);
  const decision = executionContextSourceEvolutionDecision(legacyReceipt, {
    story_ref: legacyReceipt.story_ref,
    contract_ref: legacyReceipt.contract_ref,
    delivery_profile_ref: legacyReceipt.delivery_profile_ref,
    path: "src/app.mjs",
    expected_sha256: HASH_A,
    binding_kind: "requirement",
    binding_id: "REQ-001",
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "source_snapshot_lacks_stable_identity");
});

test("preflight on an unborn HEAD names the empty tree instead of a commit", () => {
  const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  const unbornInput = { ...receiptInput(), git_head_sha: null, git_base_tree: emptyTree };
  const receipt = buildExecutionContextPreflightReceipt(unbornInput);
  assert.equal(receipt.git_head_sha, null);
  assert.equal(receipt.git_base_tree, emptyTree);
  assert.equal(validateExecutionContextPreflightReceipt(receipt).valid, true);

  // A missing base, or a commit together with a tree, is never sealed.
  assert.throws(
    () => buildExecutionContextPreflightReceipt({ ...receiptInput(), git_head_sha: null }),
    /empty tree of an unborn HEAD/u,
  );
  assert.throws(
    () => buildExecutionContextPreflightReceipt({ ...receiptInput(), git_base_tree: emptyTree }),
    /only valid without a Git commit SHA/u,
  );

  // Moving from an unborn HEAD to a commit while sealing is a Git change.
  const snapshot = {
    git_head_sha: null,
    git_base_tree: emptyTree,
    source_snapshots: receipt.source_snapshots.map((source) => ({
      path: source.path,
      sha256: source.sha256,
      file_type: source.file_type,
      mode: source.mode,
    })),
    workspace_changes: receipt.workspace_changes,
  };
  assert.equal(executionContextSnapshotRevalidationDecision(receipt, snapshot).valid, true);
  const committed = executionContextSnapshotRevalidationDecision(receipt, {
    ...snapshot,
    git_head_sha: "1".repeat(40),
    git_base_tree: undefined,
  });
  assert.equal(committed.valid, false);
  assert.match(committed.errors.join("\n"), /Git HEAD changed/u);

  // A tampered base no longer matches the sealed hash.
  const tampered = structuredClone(receipt);
  tampered.git_base_tree = "0".repeat(40);
  assert.equal(validateExecutionContextPreflightReceipt(tampered).valid, false);
});
