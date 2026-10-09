import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  AUTONOMY_LEVELS,
  buildDeliveryExecutionProfile,
  buildRequirementExecutionProfile,
  compareAutonomyLevels,
  detectMaterialDrift,
  evaluateAutonomyPolicy,
  evaluateHostAuthorityCap,
  isAutonomyNarrowing,
  mostRestrictiveAutonomyLevel,
  validateAutonomyDecisionIntegrity,
  validateDeliveryExecutionProfileIntegrity,
  validateRequirementExecutionProfileIntegrity,
} from "../../lib/autonomy-policy.mjs";
import { assertAgainstSchema } from "../../lib/json-schema-validator.mjs";

const NOW = "2026-07-17T10:00:00.000Z";
const ROOT = "/workspace/travelops";
const HASH = Object.freeze({
  approval: "a".repeat(64),
  contract: "b".repeat(64),
  deliveryApproval: "c".repeat(64),
  requirement: "d".repeat(64),
  requirementTwo: "e".repeat(64),
  story: "f".repeat(64),
});

function hashedRef(id, hash = HASH.approval, refPath = null) {
  return { id, path: refPath, hash };
}

function hostAuthority(receipt = hashedRef("HOST-APPROVAL-001")) {
  return {
    mode: "host_verified",
    source: "host_approval_receipt",
    verified: true,
    receipt_ref: receipt,
  };
}

function requirementMaterial(overrides = {}) {
  return {
    objective: "Deliver the negotiated requirement",
    scope: ["agentic autonomy policy"],
    non_goals: ["production deployment"],
    acceptance_criteria: ["policy is deterministic", "tests pass"],
    nfrs: ["fail closed"],
    environment: "repository-local",
    ...overrides,
  };
}

function requirementProfile(overrides = {}) {
  const id = overrides.id || "AUT-REQ-001";
  const requirementId = overrides.requirement_id || "REQ-001";
  const requirementHash = overrides.requirement_hash || HASH.requirement;
  return buildRequirementExecutionProfile({
    id,
    status: "active",
    requirement_ref: {
      id: requirementId,
      version: overrides.requirement_version || 1,
      path: `.sdlc/requirements/${requirementId}.json`,
      hash: requirementHash,
    },
    autonomy_ceiling: "bounded-autonomous",
    material_scope: requirementMaterial(),
    constraints: {
      allowed_tools: ["apply_patch", "exec_command"],
      allowed_capabilities: ["repository.write", "test.run"],
      allowed_environments: ["workspace"],
      allowed_write_paths: ["lib/", "schemas/", "test/"],
      forbidden_actions: ["production.deploy", "destructive.action"],
      budget_ref: hashedRef("BUDGET-001", "1".repeat(64)),
    },
    exception_actions: ["scope.change", "production.access"],
    authority_assurance: hostAuthority(),
    approval_ref: hashedRef(`APPROVAL-${id}`),
    created_at: "2026-07-17T09:00:00.000Z",
    valid_from: "2026-07-17T09:00:00.000Z",
    expires_at: "2026-07-18T09:00:00.000Z",
    ...overrides,
  });
}

function deliveryMaterial(overrides = {}) {
  return {
    objective: "Deliver one exact change unit",
    scope: ["ST-001", "CONTRACT-001"],
    acceptance_criteria: ["the exact delivery passes its gate"],
    release_target: "pull request",
    ...overrides,
  };
}

function deliveryProfile(requirements, overrides = {}) {
  const requirementList = Array.isArray(requirements) ? requirements : [requirements];
  return buildDeliveryExecutionProfile({
    id: "AUT-DELIVERY-001",
    status: "active",
    delivery_id: "PR-101",
    delivery_kind: "pull_request",
    requirement_profile_refs: requirementList.map((profile) => hashedRef(profile.id, profile.profile_hash)),
    story_refs: [hashedRef("ST-001", HASH.story, ".sdlc/stories/ST-001.json")],
    contract_refs: [hashedRef("CONTRACT-001", HASH.contract, ".sdlc/contracts/CONTRACT-001.json")],
    material_scope: deliveryMaterial(),
    requested_level: "bounded-autonomous",
    constraints: {
      allowed_tools: ["apply_patch", "exec_command"],
      allowed_capabilities: ["repository.write", "test.run"],
      allowed_environments: ["workspace"],
      allowed_write_paths: ["lib/", "schemas/", "test/"],
      forbidden_actions: ["production.deploy"],
      budget_ref: hashedRef("BUDGET-DELIVERY-001", "2".repeat(64)),
    },
    pull_request_target: {
      repository: "aantenore/agentic-sdlc",
      base_branch: "main",
      head_branch: "codex/req-autonomy",
      allowed_actions: ["git.commit", "git.push", "pull_request.update"],
      merge_allowed: false,
    },
    authority_assurance: hostAuthority(hashedRef("HOST-APPROVAL-DELIVERY", HASH.deliveryApproval)),
    approval_ref: hashedRef("APPROVAL-AUT-DELIVERY-001", HASH.deliveryApproval),
    created_at: "2026-07-17T09:10:00.000Z",
    valid_from: "2026-07-17T09:10:00.000Z",
    expires_at: "2026-07-18T09:10:00.000Z",
    ...overrides,
  });
}

function currentRequirements(profiles) {
  return profiles.map((profile) => ({
    id: profile.requirement_ref.id,
    version: profile.requirement_ref.version,
    hash: profile.requirement_ref.hash,
    material_scope: profile.material_scope,
  }));
}

function evaluationInput(requirements, delivery, overrides = {}) {
  const profiles = Array.isArray(requirements) ? requirements : [requirements];
  return {
    id: "AUT-DECISION-001",
    phase: "implementation",
    now: NOW,
    host_policy: {
      max_level: "bounded-autonomous",
      authority_assurance: hostAuthority(),
    },
    project_policy: { max_level: "bounded-autonomous" },
    requirement_profiles: profiles,
    current_requirements: currentRequirements(profiles),
    delivery_profile: delivery,
    current_story_refs: delivery?.story_refs,
    current_contract_refs: delivery?.contract_refs,
    current_delivery_scope: delivery?.material_scope,
    delivery_state: {
      delivery_id: delivery?.delivery_id,
      status: "open",
      active_run_count: 0,
    },
    contract_policy: {
      max_level: "bounded-autonomous",
      delivery_profile_ref: delivery
        ? hashedRef(delivery.id, delivery.profile_hash)
        : null,
    },
    capability_policy: { max_level: "bounded-autonomous", allowed: true },
    environment_policy: { max_level: "bounded-autonomous", allowed: true },
    budget_policy: {
      max_level: "bounded-autonomous",
      status: "within_budget",
      allowed_to_start_next: true,
    },
    ...overrides,
  };
}

test("autonomy levels are ordered and downstream policies may only narrow", () => {
  assert.deepEqual(AUTONOMY_LEVELS, [
    "supervised",
    "checkpointed",
    "bounded-autonomous",
  ]);
  assert.ok(compareAutonomyLevels("bounded-autonomous", "checkpointed") > 0);
  assert.equal(mostRestrictiveAutonomyLevel("bounded-autonomous", "supervised"), "supervised");
  assert.equal(isAutonomyNarrowing("bounded-autonomous", "checkpointed"), true);
  assert.equal(isAutonomyNarrowing("checkpointed", "bounded-autonomous"), false);

  assert.throws(
    () => requirementProfile({
      autonomy_ceiling: "checkpointed",
      phase_levels: { implementation: "bounded-autonomous" },
    }),
    /cannot expand/,
  );
});

test("custom configured phase identifiers remain governable without a built-in name", () => {
  const customPhase = "dependency-audit";
  const requirement = requirementProfile({
    phase_levels: { [customPhase]: "checkpointed" },
  });
  const delivery = deliveryProfile(requirement, {
    phase_levels: { [customPhase]: "supervised" },
  });
  const decision = evaluateAutonomyPolicy(evaluationInput(requirement, delivery, {
    phase: customPhase,
  }));

  assert.equal(requirement.phase_levels[customPhase], "checkpointed");
  assert.equal(delivery.phase_levels[customPhase], "supervised");
  assert.equal(decision.phase, customPhase);
  assert.equal(decision.effective_level, "supervised");
  assert.equal(validateAutonomyDecisionIntegrity(decision).valid, true);

  assert.throws(
    () => requirementProfile({
      phase_levels: { "invalid phase": "supervised" },
    }),
    /phase identifier|phase_levels/u,
  );
  assert.throws(
    () => evaluateAutonomyPolicy(evaluationInput(requirement, delivery, {
      phase: "../escape",
    })),
    /phase identifier|phase/u,
  );
});

test("requirement and delivery profiles are canonical, schema-valid, and tamper-evident", () => {
  const requirement = requirementProfile();
  const delivery = deliveryProfile(requirement);

  assertAgainstSchema(requirement, "requirement-execution-profile");
  assertAgainstSchema(delivery, "delivery-execution-profile");
  assert.equal(validateRequirementExecutionProfileIntegrity(requirement).valid, true);
  assert.equal(validateDeliveryExecutionProfileIntegrity(delivery).valid, true);
  assert.equal(Object.isFrozen(delivery.pull_request_target), true);
  assert.equal(delivery.use_policy.reusable_across_deliveries, false);

  const tampered = structuredClone(delivery);
  tampered.requested_level = "supervised";
  assert.equal(validateDeliveryExecutionProfileIntegrity(tampered).valid, false);
});

test("a fully bounded exact pull request resolves to bounded autonomous", () => {
  const requirement = requirementProfile();
  const delivery = deliveryProfile(requirement);
  const decision = evaluateAutonomyPolicy(evaluationInput(requirement, delivery));

  assert.equal(decision.requested_level, "bounded-autonomous");
  assert.equal(decision.effective_level, "bounded-autonomous");
  assert.equal(decision.execution_status, "ready");
  assert.equal(decision.autonomous, true);
  assert.equal(decision.blocked, false);
  assert.deepEqual(decision.reason_codes, []);
  assert.equal(validateAutonomyDecisionIntegrity(decision).valid, true);
  assertAgainstSchema(decision, "autonomy-decision");
});

test("multiple requirements use the most restrictive ceiling", () => {
  const first = requirementProfile();
  const second = requirementProfile({
    id: "AUT-REQ-002",
    requirement_id: "REQ-002",
    requirement_hash: HASH.requirementTwo,
    autonomy_ceiling: "checkpointed",
  });
  const delivery = deliveryProfile([first, second]);
  const decision = evaluateAutonomyPolicy(evaluationInput([first, second], delivery));

  assert.equal(decision.effective_level, "checkpointed");
  assert.equal(decision.execution_status, "checkpoint_required");
  assert.ok(decision.reason_codes.includes("autonomy.delivery_exceeds_requirement"));
});

test("a contract cannot expand its delivery and can narrow it", () => {
  const requirement = requirementProfile({ autonomy_ceiling: "checkpointed" });
  const delivery = deliveryProfile(requirement, { requested_level: "checkpointed" });
  const expanding = evaluateAutonomyPolicy(evaluationInput(requirement, delivery, {
    contract_policy: {
      max_level: "bounded-autonomous",
      delivery_profile_ref: hashedRef(delivery.id, delivery.profile_hash),
    },
  }));
  assert.equal(expanding.effective_level, "checkpointed");
  assert.ok(expanding.reason_codes.includes("autonomy.contract_exceeds_delivery"));

  const narrowing = evaluateAutonomyPolicy(evaluationInput(requirement, delivery, {
    contract_policy: {
      max_level: "supervised",
      delivery_profile_ref: hashedRef(delivery.id, delivery.profile_hash),
    },
  }));
  assert.equal(narrowing.effective_level, "supervised");
});

test("missing, stale, revoked, and expired profiles fail closed to supervised", async (t) => {
  const active = requirementProfile();
  const delivery = deliveryProfile(active);

  await t.test("missing delivery profile", () => {
    const decision = evaluateAutonomyPolicy(evaluationInput(active, null, {
      delivery_profile: null,
      current_story_refs: [],
      current_contract_refs: [],
      current_delivery_scope: null,
      delivery_state: null,
    }));
    assert.equal(decision.effective_level, "supervised");
    assert.ok(decision.reason_codes.includes("delivery.profile_missing"));
  });

  await t.test("stale requirement hash", () => {
    const decision = evaluateAutonomyPolicy(evaluationInput(active, delivery, {
      current_requirements: [{
        id: "REQ-001",
        version: 1,
        hash: "9".repeat(64),
        material_scope: active.material_scope,
      }],
    }));
    assert.equal(decision.effective_level, "supervised");
    assert.ok(decision.reason_codes.includes("requirement.profile_stale"));
  });

  await t.test("revoked requirement profile", () => {
    const revoked = requirementProfile({ status: "revoked" });
    const revokedDelivery = deliveryProfile(revoked);
    const decision = evaluateAutonomyPolicy(evaluationInput(revoked, revokedDelivery));
    assert.equal(decision.effective_level, "supervised");
    assert.ok(decision.reason_codes.includes("requirement.profile_revoked"));
  });

  await t.test("expired delivery profile", () => {
    const expired = deliveryProfile(active, {
      valid_from: "2026-07-16T09:10:00.000Z",
      expires_at: "2026-07-17T09:10:00.000Z",
    });
    const decision = evaluateAutonomyPolicy(evaluationInput(active, expired));
    assert.equal(decision.effective_level, "supervised");
    assert.ok(decision.reason_codes.includes("delivery.profile_expired"));
  });
});

test("material requirement and delivery drift produce deterministic reason codes", () => {
  const drift = detectMaterialDrift(
    requirementMaterial(),
    requirementMaterial({
      acceptance_criteria: ["a different outcome"],
      environment: "production",
      integrations: ["external-api"],
    }),
  );
  assert.deepEqual(drift.map((item) => item.reason_code), [
    "material_drift.acceptance_criteria",
    "material_drift.environment",
    "material_drift.integrations",
  ]);

  const requirement = requirementProfile();
  const delivery = deliveryProfile(requirement);
  const decision = evaluateAutonomyPolicy(evaluationInput(requirement, delivery, {
    current_delivery_scope: deliveryMaterial({ release_target: "production" }),
  }));
  assert.equal(decision.effective_level, "supervised");
  assert.ok(decision.reason_codes.includes("material_drift.release_target"));
});

test("local releases can be bounded autonomous only inside an exact reversible target", () => {
  const requirement = requirementProfile();
  const delivery = deliveryProfile(requirement, {
    id: "AUT-LOCAL-001",
    delivery_id: "LOCAL-RELEASE-001",
    delivery_kind: "local_release",
    material_scope: deliveryMaterial({ release_target: `${ROOT}/dist` }),
    pull_request_target: null,
    local_release_target: {
      environment: "local",
      root_path: ROOT,
      allowed_write_paths: [`${ROOT}/dist`, `${ROOT}/.local-release`],
      allowed_actions: ["build.local", "release.local", "test.run"],
      smoke_tests: ['["node","--help"]', '["node","--version"]'],
      rollback: { required: true, procedure: "Restore the previous local package artifact" },
      external_access_allowed: false,
      production_access_allowed: false,
      destructive_actions_allowed: false,
    },
  });
  const decision = evaluateAutonomyPolicy(evaluationInput(requirement, delivery, {
    environment_policy: { max_level: "bounded-autonomous", environment: "local", allowed: true },
  }));

  assert.equal(decision.effective_level, "bounded-autonomous");
  assert.equal(decision.delivery.kind, "local_release");
  assertAgainstSchema(delivery, "delivery-execution-profile");

  const windowsShortNameRoot = path.join(ROOT, "RUNNER~1", "travelops");
  assert.doesNotThrow(() => deliveryProfile(requirement, {
    id: "AUT-LOCAL-SHORT-NAME",
    delivery_id: "LOCAL-RELEASE-SHORT-NAME",
    delivery_kind: "local_release",
    material_scope: deliveryMaterial({ release_target: path.join(windowsShortNameRoot, "dist") }),
    pull_request_target: null,
    local_release_target: {
      environment: "local",
      root_path: windowsShortNameRoot,
      allowed_write_paths: [path.join(windowsShortNameRoot, "dist")],
      allowed_actions: ["build.local", "release.local", "test.run"],
      smoke_tests: ['["node","--version"]'],
      rollback: { required: true, procedure: "Restore the previous local package artifact" },
      external_access_allowed: false,
      production_access_allowed: false,
      destructive_actions_allowed: false,
    },
  }));

  assert.throws(
    () => deliveryProfile(requirement, {
      delivery_kind: "local_release",
      pull_request_target: null,
      local_release_target: {
        environment: "local",
        root_path: ROOT,
        allowed_write_paths: ["/outside/workspace"],
        allowed_actions: ["build.local"],
        smoke_tests: ['["node","--version"]'],
        rollback: { required: true, procedure: "restore" },
        external_access_allowed: false,
        production_access_allowed: false,
        destructive_actions_allowed: false,
      },
    }),
    /strict child of root_path/,
  );
});

test("local release profiles reject ambiguous smoke launchers before approval", () => {
  const requirement = requirementProfile();
  const buildLocalProfile = (smokeTests) => deliveryProfile(requirement, {
    id: "AUT-LOCAL-SMOKE-BOUNDARY",
    delivery_id: "LOCAL-SMOKE-BOUNDARY",
    delivery_kind: "local_release",
    material_scope: deliveryMaterial({ release_target: `${ROOT}/dist` }),
    pull_request_target: null,
    local_release_target: {
      environment: "local",
      root_path: ROOT,
      allowed_write_paths: [`${ROOT}/dist`],
      allowed_actions: ["release.local"],
      smoke_tests: smokeTests,
      rollback: { required: true, procedure: "Restore the previous local package artifact" },
      external_access_allowed: false,
      production_access_allowed: false,
      destructive_actions_allowed: false,
    },
  });
  for (const command of [
    ["/bin/dash", "-c", "exit 0"],
    ["/usr/bin/env", "node", "--version"],
    ["node", "--eval=process.exit(0)"],
    ["python3", "-cprint('unsafe')"],
    ["npx", "unreviewed-package"],
    ["npm", "exec", "unreviewed-package"],
  ]) {
    assert.throws(
      () => buildLocalProfile([JSON.stringify(command)]),
      /shell executable|indirect command dispatcher|inline interpreter code|package dispatcher|package manager must use/iu,
    );
  }
  assert.doesNotThrow(() =>
    buildLocalProfile(['["npm","run","smoke:local"]']));
});

test("a delivery capped below its requested level is enforced at the capped level, never the request", () => {
  const requirement = requirementProfile();
  const capped = deliveryProfile(requirement, { effective_level: "checkpointed" });
  assert.equal(capped.requested_level, "bounded-autonomous");
  assert.equal(capped.effective_level, "checkpointed");
  assertAgainstSchema(capped, "delivery-execution-profile");
  assert.equal(validateDeliveryExecutionProfileIntegrity(capped).valid, true);

  // Every other boundary, including verified authority, allows full autonomy:
  // only the recorded cap narrows the decision.
  const decision = evaluateAutonomyPolicy(evaluationInput(requirement, capped));
  assert.equal(decision.requested_level, "bounded-autonomous");
  assert.equal(decision.effective_level, "checkpointed");
  assert.equal(decision.execution_status, "checkpoint_required");
  assert.equal(decision.autonomous, false);
  assert.equal(decision.reason_codes.includes("autonomy.delivery_exceeds_requirement"), false);

  const tampered = structuredClone(capped);
  tampered.effective_level = "bounded-autonomous";
  assert.equal(validateDeliveryExecutionProfileIntegrity(tampered).valid, false);
  assert.throws(
    () => deliveryProfile(requirement, { requested_level: "checkpointed", effective_level: "bounded-autonomous" }),
    /effective_level cannot expand checkpointed to bounded-autonomous/u,
  );
  assert.throws(
    () => deliveryProfile(requirement, { effective_level: "checkpointed", phase_levels: { implementation: "bounded-autonomous" } }),
    /cannot expand checkpointed/u,
  );
  assert.throws(() => deliveryProfile(requirement, { effective_level: "full" }), /effective_level must be one of/u);
});

test("audit-only authority caps autonomy at checkpointed", () => {
  assert.deepEqual(evaluateHostAuthorityCap({ mode: "audit_only" }), {
    max_level: "checkpointed",
    reason_codes: ["authority.audit_only_caps_autonomy"],
    valid: true,
  });

  const requirement = requirementProfile();
  const delivery = deliveryProfile(requirement);
  const decision = evaluateAutonomyPolicy(evaluationInput(requirement, delivery, {
    host_policy: {
      max_level: "bounded-autonomous",
      authority_assurance: { mode: "audit_only" },
    },
  }));
  assert.equal(decision.effective_level, "checkpointed");
  assert.ok(decision.reason_codes.includes("authority.audit_only_caps_autonomy"));
});

test("budget stops, terminal delivery state, and stale exact refs block or supervise", async (t) => {
  const requirement = requirementProfile();
  const delivery = deliveryProfile(requirement);

  await t.test("hard budget boundary blocks execution", () => {
    const decision = evaluateAutonomyPolicy(evaluationInput(requirement, delivery, {
      budget_policy: {
        max_level: "bounded-autonomous",
        status: "hard_limit",
        allowed_to_start_next: false,
      },
    }));
    assert.equal(decision.execution_status, "blocked");
    assert.equal(decision.blocked, true);
    assert.equal(decision.effective_level, "supervised");
  });

  await t.test("terminal delivery cannot reuse its profile", () => {
    for (const status of ["merged", "revoked", "rolled_back"]) {
      const decision = evaluateAutonomyPolicy(evaluationInput(requirement, delivery, {
        delivery_state: {
          delivery_id: delivery.delivery_id,
          status,
          active_run_count: 0,
        },
      }));
      assert.equal(decision.execution_status, "blocked", status);
      assert.ok(decision.reason_codes.includes("delivery.profile_terminal"), status);
    }
  });

  await t.test("story binding drift fails closed", () => {
    const decision = evaluateAutonomyPolicy(evaluationInput(requirement, delivery, {
      current_story_refs: [hashedRef("ST-001", "0".repeat(64))],
    }));
    assert.equal(decision.effective_level, "supervised");
    assert.ok(decision.reason_codes.includes("delivery.story_refs_stale"));
  });
});
