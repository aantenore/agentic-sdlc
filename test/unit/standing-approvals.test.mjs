import assert from "node:assert/strict";
import test from "node:test";

import {
  STANDING_APPROVAL_POLICY_DEFAULTS,
  STANDING_COVERABLE_ACTIONS,
  STANDING_NEVER_COVERED,
  buildStandingApprovalDecision,
  buildStandingApprovalProposal,
  buildStandingApprovalUse,
  deriveStandingApprovalState,
  formatStandingBudget,
  normalizeStandingWritePath,
  standingActionReasons,
  standingApprovalIntegrityErrors,
  standingApprovalPolicy,
  standingBudgetReasons,
  standingBranchReasons,
  standingChangeReasons,
  standingContractBoundReasons,
  standingDeliveryBoundReasons,
  standingDeliveryUseResolution,
  standingDerivedApprovalErrors,
  standingPathAllowed,
  standingRecordHash,
  standingWriteRootAllowed,
} from "../../lib/standing-approvals.mjs";

const HASH = "a".repeat(64);
const NOW = "2026-10-06T10:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const HOUR = 60 * 60 * 1000;
const BINDINGS = { config_hash: HASH, policy_hash: "b".repeat(64), project_hash: "c".repeat(64) };

function proposal(overrides = {}) {
  return buildStandingApprovalProposal({
    id: "SA-DEPS",
    recipe_id: "dependency-bump",
    description: "Bump patch versions",
    destination: "pull_request",
    repository: "Acme/Shop",
    requirement_refs: [{ id: "REQ-DEPS", profile_id: "AUT-REQ-DEPS", profile_hash: HASH }],
    allowed_write_paths: ["package.json", "src/**/*.mjs", "docs/"],
    max_changed_files: 3,
    max_changed_lines: 50,
    max_deliveries: 2,
    expires_at: "2026-10-10T10:00:00.000Z",
    scope: { project_id: "demo", project_root: "/work/demo" },
    bindings: BINDINGS,
    ...overrides,
  }, { now: NOW, policy: STANDING_APPROVAL_POLICY_DEFAULTS });
}

function approvalOf(record, createdAt = NOW) {
  return buildStandingApprovalDecision({
    id: `${record.id}-APPROVAL`,
    decision: "approved",
    proposal: record,
    approval: { status: "approved", approval_source: "explicit-user" },
    createdAt,
  });
}

test("a proposal records every bound, the fixed exclusions, and a content hash", () => {
  const record = proposal();
  assert.equal(record.record_hash, standingRecordHash(record));
  assert.deepEqual(record.allowed_write_paths, ["docs", "package.json", "src/**/*.mjs"]);
  assert.deepEqual(record.covered_actions, [...STANDING_COVERABLE_ACTIONS.pull_request]);
  assert.ok(record.never_covered.includes("pull_request.merge"));
  assert.equal(record.destination.merge_allowed, false);
  assert.equal(record.delivery_level, "checkpointed");
  assert.equal(record.budget, null);
});

test("proposals refuse missing, unbounded, or out-of-project inputs", () => {
  assert.throws(() => proposal({ expires_at: "2026-12-30T00:00:00Z" }), /within 30 days/u);
  assert.throws(() => proposal({ expires_at: "2026-10-01T00:00:00Z" }), /in the future/u);
  assert.throws(() => proposal({ max_deliveries: 0 }), /positive integer/u);
  assert.throws(() => proposal({ max_deliveries: 21 }), /must not exceed 20/u);
  assert.throws(() => proposal({ destination: "production" }), /--destination/u);
  assert.throws(() => proposal({ allowed_write_paths: [] }), /--write-path/u);
  assert.throws(() => proposal({ requirement_refs: [] }), /--requirement/u);
  assert.throws(() => proposal({ budget: { per_delivery_amount: "5" } }), /--currency/u);
  assert.throws(() => proposal({ budget: { per_delivery_amount: "50", total_amount: "5", currency: "EUR" } }), /must not exceed/u);
  for (const unsafe of ["/etc", "../outside", "src/../..", ".sdlc/autonomy", ".git/hooks", ".", "C:/x", "**", "**/*", ".s*/**", "*", "src**", "src/a**/b"]) {
    assert.throws(() => normalizeStandingWritePath(unsafe), /Standing approval (write path|glob)|narrower/u, unsafe);
  }
});

test("path bounds use prefixes and globs, and write roots need a containing prefix", () => {
  const patterns = ["docs", "package.json", "src/**/*.mjs"];
  assert.ok(standingPathAllowed("docs/a/b.md", patterns));
  assert.ok(standingPathAllowed("package.json", patterns));
  assert.ok(standingPathAllowed("src/a/b/c.mjs", patterns));
  assert.ok(standingPathAllowed("src/c.mjs", patterns));
  assert.ok(!standingPathAllowed("src/c.js", patterns));
  assert.ok(!standingPathAllowed("docsx/a.md", patterns));
  assert.ok(!standingPathAllowed("package.json.bak", patterns));
  assert.ok(standingWriteRootAllowed("docs/release", patterns));
  assert.ok(!standingWriteRootAllowed("src", patterns));
  assert.ok(!standingWriteRootAllowed("src/**", patterns));
});

test("state precedence: invalid, revoked, proposed, expired, stale, exhausted, active", () => {
  const record = proposal();
  const approval = approvalOf(record);
  const base = { proposal: record, approval, nowMs: NOW_MS + HOUR, currentBindings: BINDINGS };
  assert.equal(deriveStandingApprovalState({ ...base }).status, "active");
  assert.equal(deriveStandingApprovalState({ ...base, approval: null }).status, "proposed");
  assert.equal(deriveStandingApprovalState({ ...base, nowMs: Date.parse(record.expires_at) }).status, "expired");
  assert.equal(deriveStandingApprovalState({ ...base, currentBindings: { ...BINDINGS, config_hash: "d".repeat(64) } }).status, "stale");
  assert.equal(deriveStandingApprovalState({ ...base, uses: [{}, {}] }).status, "exhausted");
  assert.equal(deriveStandingApprovalState({ ...base, revocation: { reason: "stop" } }).status, "revoked");
  assert.equal(deriveStandingApprovalState({ ...base, integrityErrors: ["tampered"], revocation: { reason: "stop" } }).status, "invalid");
  assert.equal(deriveStandingApprovalState({ ...base, policy: { ...STANDING_APPROVAL_POLICY_DEFAULTS, enabled: false } }).status, "disabled");
  const soon = deriveStandingApprovalState({ ...base, nowMs: Date.parse(record.expires_at) - HOUR, uses: [{}] });
  assert.equal(soon.status, "active");
  assert.ok(soon.warnings.some((warning) => /expires soon/u.test(warning)));
  assert.ok(soon.warnings.some((warning) => /one delivery left/u.test(warning)));
});

test("integrity detects edits, widening, lineage breaks, and slot reuse", () => {
  const record = proposal();
  const approval = approvalOf(record, "2026-10-06T11:00:00.000Z");
  const use = (slot, createdAt = "2026-10-06T12:00:00.000Z") => buildStandingApprovalUse({
    proposal: record,
    approvalDecision: approval,
    slot,
    delivery: { id: `PR-${slot}`, kind: "pull_request" },
    profileRef: { id: `AUT-${slot}`, hash: HASH },
    storyId: "ST-1",
    contractId: "C-1",
    createdAt,
  });
  assert.deepEqual(standingApprovalIntegrityErrors({ proposal: record, approval, uses: [use(1), use(2)] }), []);
  assert.match(standingApprovalIntegrityErrors({ proposal: { ...record, max_deliveries: 9 } }).join(), /changed after it was proposed/u);
  const widened = { ...record, covered_actions: [...record.covered_actions, "pull_request.merge"] };
  assert.match(
    standingApprovalIntegrityErrors({ proposal: { ...widened, record_hash: standingRecordHash(widened) } }).join(),
    /widens what the CLI allows/u,
  );
  assert.match(standingApprovalIntegrityErrors({ proposal: record, approval, uses: [use(1), use(1)] }).join(), /invalid delivery slot/u);
  assert.match(standingApprovalIntegrityErrors({ proposal: record, approval, uses: [use(3)] }).join(), /invalid delivery slot/u);
  assert.match(standingApprovalIntegrityErrors({ proposal: record, approval, uses: [use(1, "2026-10-06T10:30:00.000Z")] }).join(), /predates the approval/u);
  const foreign = approvalOf(proposal({ id: "SA-OTHER" }));
  assert.match(standingApprovalIntegrityErrors({ proposal: record, approval: foreign }).join(), /bound to different content/u);
  assert.match(standingApprovalIntegrityErrors({ proposal: record, approval: { ...approval, reason: "x" } }).join(), /changed after it was written/u);
});

test("delivery bounds: destination, merge, level, requirements, actions, paths, and signed authority", () => {
  const record = proposal({ allowed_write_paths: ["src"] });
  const delivery = {
    kind: "pull_request",
    merge_allowed: false,
    level: "checkpointed",
    requirement_ids: ["REQ-DEPS"],
    allowed_actions: ["git.commit", "git.push", "pull_request.create"],
    write_roots: ["src/deps"],
    outside_project_paths: [],
    authority_mode: "audit_only",
    repository: "acme/shop",
    head_branch: "standing/sa-deps/bump",
    base_branch: "main",
  };
  assert.deepEqual(standingDeliveryBoundReasons(record, delivery), []);
  const reasons = (change) => standingDeliveryBoundReasons(record, { ...delivery, ...change }).join("\n");
  assert.match(reasons({ kind: "local_release" }), /covers only pull request/u);
  assert.match(reasons({ merge_allowed: true }), /never covered/u);
  assert.match(reasons({ level: "supervised" }), /covers only checkpointed/u);
  assert.match(reasons({ requirement_ids: ["REQ-OTHER"] }), /REQ-OTHER is outside/u);
  assert.match(reasons({ allowed_actions: ["pull_request.merge"] }), /never covers/u);
  assert.match(reasons({ write_roots: ["lib"] }), /outside the allowed paths: lib/u);
  assert.match(reasons({ outside_project_paths: ["/tmp/x"] }), /outside the project/u);
  assert.match(reasons({ authority_mode: "host_verified" }), /trusted signed approval/u);
});

test("merge, deploy, data changes, and production are never coverable", () => {
  const record = proposal();
  for (const action of STANDING_NEVER_COVERED) {
    assert.match(standingActionReasons(record, action).join(), /never covered/u, action);
  }
  assert.deepEqual(standingActionReasons(record, "pull_request.update"), []);
  assert.match(standingActionReasons(record, "release.local").join(), /outside what this standing approval covers/u);
});

test("observed changes are bounded by paths, deletions, counts, lines, and measurability", () => {
  const record = proposal();
  const file = (path, added = 1, extra = {}) => ({ path, added, deleted: 0, binary: false, deleted_file: false, ...extra });
  assert.deepEqual(standingChangeReasons(record, { measurable: true, files: [file("package.json", 10)] }), []);
  assert.match(standingChangeReasons(record, { measurable: false, error: "no git" }).join(), /cannot be measured: no git/u);
  assert.match(standingChangeReasons(record, { measurable: true, files: [file("lib/x.mjs")] }).join(), /outside the allowed paths changed: lib\/x\.mjs/u);
  assert.match(
    standingChangeReasons(record, { measurable: true, files: [file("README.md", 0, { deleted: 3, deleted_file: true })] }).join(),
    /tracked files outside the allowed paths were deleted: README\.md/u,
  );
  assert.match(standingChangeReasons(record, { measurable: true, files: [file("docs/a.png", 0, { binary: true })] }).join(), /binary changes/u);
  assert.match(
    standingChangeReasons(record, { measurable: true, files: ["docs/a", "docs/b", "docs/c", "docs/d"].map((item) => file(item)) }).join(),
    /4 files changed, above the limit of 3/u,
  );
  assert.match(standingChangeReasons(record, { measurable: true, files: [file("docs/a", 51)] }).join(), /51 lines changed/u);
});

test("a configured budget fails closed without a measurement", () => {
  const record = proposal({ budget: { per_delivery_amount: "5", total_amount: "20", currency: "eur" } });
  assert.equal(record.budget.currency, "EUR");
  assert.deepEqual(standingBudgetReasons(proposal(), null), []);
  assert.match(standingBudgetReasons(record, { measurable: false, reason: "no meter" }).join(), /cannot be measured \(no meter\)/u);
  assert.match(
    standingBudgetReasons(record, { measurable: true, currency: "EUR", delivery_amount: 6, total_amount: 6 }).join(),
    /above the per-delivery budget/u,
  );
  assert.match(
    standingBudgetReasons(record, { measurable: true, currency: "EUR", delivery_amount: 4, total_amount: 21 }).join(),
    /above the total budget/u,
  );
  assert.match(standingBudgetReasons(record, { measurable: true, currency: "USD", delivery_amount: 1, total_amount: 1 }).join(), /not EUR/u);
});

test("a recorded standing budget reads as currency amounts", () => {
  assert.equal(formatStandingBudget(null), "none");
  assert.equal(
    formatStandingBudget({ currency: "USD", per_delivery_amount: 5, total_amount: null }),
    "USD 5.00 per delivery, no total",
  );
  assert.equal(
    formatStandingBudget({ currency: "EUR", per_delivery_amount: null, total_amount: 20.125 }),
    "no per-delivery limit, EUR 20.125 total",
  );
});

test("a derived approval is historically valid only inside the approval window", () => {
  const record = proposal();
  const approval = approvalOf(record, "2026-10-06T11:00:00.000Z");
  const ref = { id: record.id, record_hash: record.record_hash, approval_hash: approval.record_hash };
  const derived = (createdAt) => ({ standing_approval_ref: ref, created_at: createdAt });
  assert.deepEqual(standingDerivedApprovalErrors({ derived: derived("2026-10-06T12:00:00.000Z"), proposal: record, approval }), []);
  assert.match(standingDerivedApprovalErrors({ derived: derived("2026-10-06T10:30:00.000Z"), proposal: record, approval }).join(), /predates/u);
  assert.match(standingDerivedApprovalErrors({ derived: derived("2026-10-11T00:00:00.000Z"), proposal: record, approval }).join(), /expired/u);
  const revocation = { created_at: "2026-10-07T00:00:00.000Z" };
  assert.match(
    standingDerivedApprovalErrors({ derived: derived("2026-10-08T00:00:00.000Z"), proposal: record, approval, revocation }).join(),
    /after the standing approval was revoked/u,
  );
  assert.deepEqual(
    standingDerivedApprovalErrors({ derived: derived("2026-10-06T12:00:00.000Z"), proposal: record, approval, revocation }),
    [],
  );
  assert.match(
    standingDerivedApprovalErrors({ derived: { standing_approval_ref: { ...ref, record_hash: HASH } }, proposal: record, approval }).join(),
    /exact approved standing approval/u,
  );
});

test("policy values come from configuration and are validated", () => {
  assert.deepEqual(standingApprovalPolicy({}), STANDING_APPROVAL_POLICY_DEFAULTS);
  assert.equal(standingApprovalPolicy({ standing_approval_policy: { max_deliveries: 3 } }).max_deliveries, 3);
  assert.throws(() => standingApprovalPolicy({ standing_approval_policy: { max_deliveries: 0 } }), /positive integer/u);
  assert.throws(() => standingApprovalPolicy({ standing_approval_policy: { enabled: "yes" } }), /boolean/u);
});

test("a recorded slot is reused only for an exact retry of the same delivery profile", () => {
  const record = proposal();
  const approval = approvalOf(record, "2026-10-06T11:00:00.000Z");
  const use = (slot, delivery, profileRef) => buildStandingApprovalUse({
    proposal: record,
    approvalDecision: approval,
    slot,
    delivery,
    profileRef,
    storyId: "ST-1",
    contractId: "C-1",
    createdAt: "2026-10-06T12:00:00.000Z",
  });
  const held = use(1, { id: "PR-1", kind: "pull_request" }, { id: "AUT-1", hash: HASH });
  const resolve = (profile, uses = [held]) => standingDeliveryUseResolution({ proposal: record, approval, uses }, profile);
  const exact = { profile_id: "AUT-1", profile_hash: HASH, delivery_id: "PR-1", delivery_kind: "pull_request" };

  assert.deepEqual(resolve(exact), { existing: held, reasons: [] });
  assert.deepEqual(resolve({ ...exact, profile_id: "AUT-9", delivery_id: "PR-9" }), { existing: null, reasons: [] });
  // A different profile for the same delivery never reuses or adds a slot.
  assert.match(resolve({ ...exact, profile_id: "AUT-2" }).reasons.join(), /already used the standing approval through profile AUT-1/u);
  // The same profile id with different content is refused.
  const changed = resolve({ ...exact, profile_hash: "d".repeat(64) });
  assert.equal(changed.existing, null);
  assert.match(changed.reasons.join(), /different content/u);
  // The same profile id aimed at another delivery or kind is refused.
  assert.match(resolve({ ...exact, delivery_id: "PR-2" }).reasons.join(), /already used the standing approval for delivery/u);
  assert.match(resolve({ ...exact, delivery_kind: "local_release" }).reasons.join(), /already used the standing approval for delivery/u);
  // A slot bound to another standing approval or approval is refused.
  const foreign = standingDeliveryUseResolution({ proposal: record, approval: approvalOf(record, "2026-10-06T11:30:00.000Z"), uses: [held] }, exact);
  assert.match(foreign.reasons.join(), /different standing approval/u);
  // Duplicated records are an integrity violation, not a silent pick.
  const duplicate = use(2, { id: "PR-1", kind: "pull_request" }, { id: "AUT-2", hash: HASH });
  assert.match(resolve(exact, [held, duplicate]).reasons.join(), /more than one slot/u);
  assert.match(
    standingApprovalIntegrityErrors({ proposal: record, approval, uses: [held, duplicate] }).join(),
    /repeats a delivery or profile/u,
  );
  const sameProfile = use(2, { id: "PR-2", kind: "pull_request" }, { id: "AUT-1", hash: HASH });
  assert.match(
    standingApprovalIntegrityErrors({ proposal: record, approval, uses: [held, sameProfile] }).join(),
    /repeats a delivery or profile/u,
  );
});

test("a pull request standing approval is bound to one repository and its own branch prefix", () => {
  const record = proposal();
  assert.equal(record.destination.repository, "github.com/acme/shop");
  assert.equal(record.destination.head_branch_prefix, "standing/sa-deps/");
  assert.equal(proposal({ head_branch_prefix: "deps/" }).destination.head_branch_prefix, "deps/");
  assert.throws(() => proposal({ repository: "" }), /--repository is required/u);
  assert.throws(() => proposal({ repository: "not a repo" }), /--repository/u);
  for (const unsafe of ["main/", "release/", "prod-", "deps", "/deps/", "a/../b/", "Production/x/"]) {
    assert.throws(() => proposal({ head_branch_prefix: unsafe }), /--head-branch-prefix/u, unsafe);
  }
  const local = proposal({ destination: "local_release" });
  assert.equal(local.destination.repository, undefined);
  const widened = { ...record, destination: { ...record.destination, head_branch_prefix: "" } };
  widened.record_hash = standingRecordHash(widened);
  assert.ok(standingApprovalIntegrityErrors({ proposal: widened }).some((error) => /widens/u.test(error)));

  const destination = record.destination;
  const delivery = { repository: "https://github.com/acme/shop.git", head_branch: "standing/sa-deps/bump-1", base_branch: "main" };
  assert.deepEqual(standingBranchReasons(destination, delivery), []);
  assert.match(standingBranchReasons(destination, { ...delivery, repository: "acme/other" }).join(), /covers only github.com\/acme\/shop/u);
  for (const head of ["main", "master", "release/1.2", "standing/sa-deps/", "feature/x", "standing/sa-deps-x/y"]) {
    assert.ok(standingBranchReasons(destination, { ...delivery, head_branch: head }).length > 0, head);
  }
  assert.ok(standingBranchReasons(destination, { ...delivery, head_branch: "standing/sa-deps/x", base_branch: "standing/sa-deps/x" }).length > 0);
  const bound = standingDeliveryBoundReasons(record, {
    kind: "pull_request", level: "checkpointed", requirement_ids: ["REQ-DEPS"], allowed_actions: ["git.push"],
    write_roots: ["docs"], ...delivery, head_branch: "main",
  });
  assert.match(bound.join(), /pushing to branch main is never covered/u);
});

test("a standing approval never approves release-phase or infrastructure work briefs", () => {
  assert.deepEqual(standingContractBoundReasons({ phase: "implementation", allowed_tools: ["node", "npm test"] }), []);
  for (const phase of ["release", "deploy", "production", "data-migration", "ops", "", "pre-release"]) {
    assert.match(standingContractBoundReasons({ phase, allowed_tools: [] }).join(), /never approves/u, phase);
  }
  assert.match(
    standingContractBoundReasons({ phase: "implementation", allowed_tools: ["node", "kubectl apply -f x", "Terraform"] }).join(),
    /kubectl, terraform/u,
  );
  assert.match(
    standingContractBoundReasons({ phase: "implementation", allowed_tools: ["/usr/bin/kubectl", "npx terraform plan", "bash -c 'ssh host'", "C:\\tools\\helm.exe"] }).join(),
    /kubectl, terraform, ssh, helm/u,
  );
});
