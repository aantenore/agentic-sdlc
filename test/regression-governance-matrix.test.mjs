import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildDeliveryExecutionProfileV2,
  buildRequirementExecutionProfile,
  evaluateAutonomyPolicy,
  evaluateHostAuthorityCap,
  validateDeliveryExecutionProfileIntegrity,
} from "../lib/autonomy-policy.mjs";
import { STABLE_JSON_HASH_ALGORITHM } from "../lib/canonical.mjs";
import {
  applyWorkflowOverlay,
  approveWorkflowOverlay,
  buildWorkflowOverlay,
  evaluateWorkflowGuards,
  validateWorkflowDefinition,
  validateWorkflowOverlay,
} from "../lib/workflow-engine.mjs";
import {
  WORKFLOW_CANONICAL_EVIDENCE_SCHEMA,
  computeWorkflowCanonicalEvidenceHash,
} from "../lib/workflow-canonical-evidence.mjs";
import {
  SOFTWARE_PROJECT_PHASES,
  buildWorkflowPreset,
  listWorkflowPresets,
} from "../lib/workflow-presets.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPOSITORY_ROOT, "bin", "agentic-sdlc.mjs");
const FIXED_TIME = "2026-07-28T10:00:00.000Z";
const HASH = Object.freeze({
  approval: "a".repeat(64),
  requirement: "b".repeat(64),
  story: "c".repeat(64),
  contract: "d".repeat(64),
});
const TEMP_PROJECTS = new Set();

after(() => {
  if (process.env.AGENTIC_SDLC_KEEP_TEST_TMP === "1") return;
  for (const project of TEMP_PROJECTS) {
    fs.rmSync(project, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test("rollout matrix keeps legacy behavior deliberate and enforces new governed work fail-closed", async (t) => {
  await t.test("off permits a reviewed legacy task at supervised level", () => {
    const project = rolloutProject("off");
    createLegacyWork(project, "OFF");
    const started = startTask(project, "ST-OFF");

    assert.equal(started.execution_allowed, true);
    assert.equal(started.autonomy.mode, "off");
    assert.equal(started.autonomy.effective_level, "supervised");
    assert.equal(started.autonomy.task_start_automatic, false);
  });

  await t.test("observe records a missing delivery selection without blocking a new v2 task", () => {
    const project = rolloutProject("observe");
    createApprovedRequirement(project, "REQ-OBSERVE");
    createWorkContract(project, {
      suffix: "OBSERVE",
      requirement: "REQ-OBSERVE",
    });
    const started = startTask(project, "ST-OBSERVE");

    assert.equal(started.execution_allowed, true);
    assert.equal(started.autonomy.mode, "observe");
    assert.equal(started.autonomy.effective_level, "supervised");
    assert.ok(started.autonomy.reason_codes.includes("autonomy.selection_missing_observed"));
  });

  await t.test("enforce_new_only preserves legacy fallback but rejects a new v2 contract without delivery choice", () => {
    const project = rolloutProject("enforce_new_only");
    createLegacyWork(project, "NEW-ONLY-LEGACY");
    const legacy = startTask(project, "ST-NEW-ONLY-LEGACY");

    assert.equal(legacy.execution_allowed, true);
    assert.equal(legacy.autonomy.mode, "legacy_fallback");
    assert.equal(legacy.autonomy.effective_level, "supervised");

    createApprovedRequirement(project, "REQ-NEW-ONLY");
    createStory(project, "NEW-ONLY", "REQ-NEW-ONLY");
    const rejected = runCli([
      "contract", "create",
      "--root", project,
      "--phase", "implementation",
      "--story", "ST-NEW-ONLY",
      "--id", "CONTRACT-NEW-ONLY",
      "--context-summary", "Implement only the approved governed story.",
      "--qa", "Who confirms the boundary?|Human reviewer",
      "--output-ref", "implementation-summary:implementation-summary-v1:new",
    ]);

    assert.notEqual(rejected.status, 0);
    assert.match(`${rejected.stdout}\n${rejected.stderr}`, /needs --delivery-profile/u);
  });

  await t.test("enforce_all blocks legacy work and permits one fully selected v2 local release", () => {
    const project = rolloutProject("enforce_all");
    createLegacyWork(project, "ALL-LEGACY");
    const legacy = startTask(project, "ST-ALL-LEGACY");

    assert.equal(legacy.execution_allowed, false);
    assert.equal(legacy.contract_action, "migrate_requirement_autonomy");
    assert.ok(legacy.blocking_reasons.includes("legacy_autonomy_migration_required"));

    createApprovedRequirement(project, "REQ-ALL");
    createWorkContract(project, {
      suffix: "ALL",
      requirement: "REQ-ALL",
      profile: "AUT-ALL",
      level: "supervised",
      approve: false,
    });
    approveContract(project, "CONTRACT-ALL");

    const releaseRoot = path.join(project, "release");
    const releaseOutput = path.join(releaseRoot, "app");
    const proposed = cliJson([
      "autonomy", "delivery", "propose",
      "--root", project,
      "--id", "AUT-ALL",
      "--delivery", "LOCAL-ALL",
      "--kind", "local_release",
      "--story", "ST-ALL",
      "--contract", "CONTRACT-ALL",
      "--requirement", "REQ-ALL",
      "--level", "supervised",
      "--target-root", releaseRoot,
      "--write-path", releaseOutput,
      "--smoke-test", '["node","--version"]',
      "--rollback", "Restore the previous local release snapshot.",
    ]);
    assert.equal(proposed.delivery_profile.delivery_kind, "local_release");

    cliJson([
      "autonomy", "delivery", "approve",
      "--root", project,
      "--id", "AUT-ALL",
      ...humanApproval("Approve this supervised local release only"),
    ]);
    const governed = startTask(project, "ST-ALL", "AUT-ALL");

    assert.equal(governed.execution_allowed, true);
    assert.equal(governed.delivery_kind, "local_release");
    assert.equal(governed.autonomy.effective_level, "supervised");
  });
});

test("autonomy and authority matrix resolves all levels and fails closed on unverifiable authority", async (t) => {
  const matrix = [
    {
      name: "supervised",
      requested: "supervised",
      authority: hostVerifiedAuthority(),
      expectedLevel: "supervised",
      expectedStatus: "approval_required",
    },
    {
      name: "checkpointed",
      requested: "checkpointed",
      authority: hostVerifiedAuthority(),
      expectedLevel: "checkpointed",
      expectedStatus: "checkpoint_required",
    },
    {
      name: "bounded autonomous with attested host",
      requested: "bounded-autonomous",
      authority: hostVerifiedAuthority(),
      expectedLevel: "bounded-autonomous",
      expectedStatus: "ready",
    },
    {
      name: "bounded request capped by audit-only authority",
      requested: "bounded-autonomous",
      authority: { mode: "audit_only" },
      expectedLevel: "checkpointed",
      expectedStatus: "checkpoint_required",
      reason: "authority.audit_only_caps_autonomy",
    },
  ];

  for (const row of matrix) {
    await t.test(row.name, () => {
      const requirement = requirementProfile(row.requested, row.authority);
      const delivery = deliveryProfile({
        requirement,
        requestedLevel: row.requested,
        authority: row.authority,
      });
      const decision = autonomyDecision(requirement, delivery, row.authority);

      assert.equal(decision.requested_level, row.requested);
      assert.equal(decision.effective_level, row.expectedLevel);
      assert.equal(decision.execution_status, row.expectedStatus);
      if (row.reason) assert.ok(decision.reason_codes.includes(row.reason));
    });
  }

  await t.test("host_verified without a valid attestation fails closed", () => {
    const invalidAuthority = {
      mode: "host_verified",
      source: "host_approval_receipt",
      verified: false,
      receipt_ref: null,
    };
    assert.deepEqual(evaluateHostAuthorityCap(invalidAuthority), {
      max_level: "supervised",
      valid: false,
      reason_codes: ["authority.host_verification_invalid"],
    });

    const requirement = requirementProfile("bounded-autonomous", hostVerifiedAuthority());
    const delivery = deliveryProfile({
      requirement,
      requestedLevel: "bounded-autonomous",
      authority: hostVerifiedAuthority(),
    });
    const decision = autonomyDecision(requirement, delivery, invalidAuthority);
    assert.equal(decision.effective_level, "supervised");
    assert.equal(decision.execution_status, "approval_required");
    assert.ok(decision.reason_codes.includes("authority.host_verification_invalid"));
  });
});

test("delivery matrix binds local, new PR, and existing PR targets without widening actions", async (t) => {
  const requirement = requirementProfile("checkpointed", hostVerifiedAuthority());

  await t.test("new pull request includes create but excludes merge from the allowed target", () => {
    const profile = deliveryProfile({
      requirement,
      requestedLevel: "checkpointed",
      authority: hostVerifiedAuthority(),
      mode: "new",
    });
    assert.equal(profile.pull_request_target.mode, "new");
    assert.ok(profile.pull_request_target.allowed_actions.includes("pull_request.create"));
    assert.equal(profile.pull_request_target.merge_allowed, false);
    assert.equal(validateDeliveryExecutionProfileIntegrity(profile).valid, true);
  });

  await t.test("existing pull request pins identity and cannot acquire create", () => {
    const profile = deliveryProfile({
      requirement,
      requestedLevel: "checkpointed",
      authority: hostVerifiedAuthority(),
      mode: "existing",
    });
    assert.equal(profile.pull_request_target.mode, "existing");
    assert.equal(profile.pull_request_target.pr_number, 184);
    assert.equal(profile.pull_request_target.reviewed_head_sha, "1".repeat(40));
    assert.equal(profile.pull_request_target.allowed_actions.includes("pull_request.create"), false);
    assert.equal(profile.provider_bindings.some(({ action }) => action === "pull_request.create"), false);

    assert.throws(
      () => deliveryProfile({
        requirement,
        requestedLevel: "checkpointed",
        authority: hostVerifiedAuthority(),
        mode: "existing",
        prUrl: "https://github.com/aantenore/agentic-sdlc/pull/185",
      }),
      /must identify the exact approved PR number/u,
    );
  });

  await t.test("local release requires a strict child, smoke test, rollback, and local provider", () => {
    const profile = deliveryProfile({
      requirement,
      requestedLevel: "checkpointed",
      authority: hostVerifiedAuthority(),
      kind: "local_release",
    });
    assert.equal(profile.local_release_target.environment, "local");
    assert.deepEqual(profile.local_release_target.smoke_tests, ['["node","--version"]']);
    assert.equal(profile.local_release_target.rollback.required, true);
    assert.deepEqual(profile.provider_bindings, [
      { action: "release.local", provider_id: "local-filesystem" },
    ]);
    assert.equal(validateDeliveryExecutionProfileIntegrity(profile).valid, true);

    assert.throws(
      () => deliveryProfile({
        requirement,
        requestedLevel: "checkpointed",
        authority: hostVerifiedAuthority(),
        kind: "local_release",
        localWritePath: "/workspace/travelops",
      }),
      /strict child of root_path/u,
    );
  });
});

test("workflow matrix preserves v1/v2 and governs v3 with phase-bound evidence", async (t) => {
  const listed = listWorkflowPresets();
  assert.deepEqual(listed.map(({ id }) => id), [
    "software-project",
    "change-request",
    "technical-assessment",
    "generic-governed-process",
  ]);
  assert.deepEqual(
    listed.find(({ id }) => id === "software-project").available_versions,
    ["1", "2", "3"],
  );

  await t.test("software-project v1 remains guardless, v2 stays legacy, and v3 uses v2 evidence", () => {
    const legacy = buildWorkflowPreset("software-project", { version: 1 });
    const legacyGoverned = buildWorkflowPreset("software-project", { version: 2 });
    const governed = buildWorkflowPreset("software-project", { version: 3 });

    assert.deepEqual(legacy.states.map(({ id }) => id), SOFTWARE_PROJECT_PHASES);
    assert.equal(legacy.transitions.every(({ guards }) => guards.length === 0), true);
    assert.equal(
      legacyGoverned.metadata.canonical_evidence_schema,
      "workflow-canonical-evidence:v1",
    );
    assert.deepEqual(governed.states.map(({ id }) => id), SOFTWARE_PROJECT_PHASES);
    assert.equal(governed.metadata.governance_binding, "story");
    assert.equal(
      governed.metadata.canonical_evidence_schema,
      "workflow-canonical-evidence:v2",
    );
    assert.deepEqual(
      governed.transitions.flatMap(({ guards }) => guards.map(({ id }) => id)),
      [
        "requirement-approved",
        "contract-approved",
        "required-output-linked",
        "strict-gate-passed",
      ],
    );

    const guard = [{ id: "requirement-approved", parameters: {} }];
    assert.equal(
      evaluateWorkflowGuards(guard, { requirement_approved: true }).allowed,
      false,
    );
    assert.equal(
      evaluateWorkflowGuards(
        guard,
        { requirement_approved: false },
        undefined,
        canonicalEvidence("DELIVERY-42", "ST-42"),
      ).allowed,
      true,
    );
  });

  await t.test("all remaining presets materialize valid approved definitions", () => {
    for (const id of ["change-request", "technical-assessment", "generic-governed-process"]) {
      const definition = buildWorkflowPreset(id);
      assert.equal(definition.status, "approved", id);
      assert.equal(validateWorkflowDefinition(definition).valid, true, id);
      assert.equal(definition.states.at(-1).terminal, true, id);
    }
  });

  await t.test("a custom overlay changes presentation but cannot rewrite topology", () => {
    const definition = buildWorkflowPreset("change-request");
    const proposed = buildWorkflowOverlay({
      id: "change-request-it",
      version: 1,
      definition_ref: {
        id: definition.id,
        version: definition.version,
        definition_hash: definition.definition_hash,
      },
      label: "Richiesta di modifica",
      state_overrides: [{
        state_id: "impact-review",
        label: "Valutazione impatto",
        metadata: { locale: "it" },
      }],
      transition_overrides: [],
      metadata: { locale: "it" },
      created_at: FIXED_TIME,
    }, { definition });
    const overlay = approveWorkflowOverlay(proposed, {
      definition,
      approved_at: "2026-07-28T10:01:00.000Z",
      actor: { id: "reviewer", type: "human", name: "Reviewer" },
      approval_source: "explicit-user",
      summary: "Approve Italian presentation labels only.",
    });
    const effective = applyWorkflowOverlay(definition, overlay);

    assert.equal(validateWorkflowOverlay(overlay, { definition }).valid, true);
    assert.equal(effective.label, "Richiesta di modifica");
    assert.deepEqual(
      effective.transitions.map(({ id, from, to }) => ({ id, from, to })),
      definition.transitions.map(({ id, from, to }) => ({ id, from, to })),
    );
    assert.throws(
      () => buildWorkflowOverlay({
        ...structuredClone(proposed),
        initial_state: "closed",
      }, { definition }),
      /unsupported fields/u,
    );
  });
});

function rolloutProject(mode) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), `sdlc-rollout-${mode}-`));
  TEMP_PROJECTS.add(project);
  cliJson(["init", "--root", project, "--project-name", `Rollout ${mode}`, "--force"]);

  const configPath = path.join(project, ".sdlc", "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.autonomy_policy.mode = mode;
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  fs.unlinkSync(path.join(project, ".sdlc", "config.lock.json"));

  cliJson([
    "output", "template", "propose",
    "--root", project,
    "--type", "implementation-summary",
    "--summary", "Regression implementation evidence",
  ]);
  cliJson([
    "output", "template", "approve",
    "--root", project,
    "--id", "implementation-summary-v1",
    ...humanApproval("Approve the regression output format"),
  ]);
  initializeGitHead(project);
  return project;
}

function initializeGitHead(project) {
  for (const args of [
    ["init"],
    ["config", "user.name", "Governance Matrix"],
    ["config", "user.email", "governance-matrix@example.invalid"],
    ["add", "."],
    ["commit", "-m", "test: establish rollout matrix baseline"],
  ]) {
    const result = spawnSync("git", ["-C", project, ...args], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    assert.equal(
      result.status,
      0,
      `git ${args.join(" ")}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
    );
  }
}

function createLegacyWork(project, suffix) {
  createWorkContract(project, { suffix });
}

function createApprovedRequirement(project, id) {
  cliJson([
    "requirement", "propose",
    "--root", project,
    "--id", id,
    "--title", `Governed ${id}`,
    "--summary", "Deliver one exact governed result.",
    "--acceptance", "The selected delivery remains inside its reviewed boundary.",
    "--autonomy-ceiling", "bounded-autonomous",
    "--write-path", "src",
  ]);
  cliJson([
    "requirement", "approve",
    "--root", project,
    "--id", id,
    ...humanApproval(`Approve ${id}`),
  ]);
}

function createStory(project, suffix, requirement = null) {
  cliJson([
    "story", "create",
    "--root", project,
    "--id", `ST-${suffix}`,
    "--title", `Implement ${suffix}`,
    "--phase", "implementation",
    "--status", "ready",
    "--acceptance", `Observable evidence exists for ${suffix}.`,
    ...(requirement ? ["--requirement", requirement] : []),
  ]);
}

function createWorkContract(project, options) {
  const {
    suffix,
    requirement = null,
    profile = null,
    level = "supervised",
    approve = true,
  } = options;
  createStory(project, suffix, requirement);
  cliJson([
    "contract", "create",
    "--root", project,
    "--phase", "implementation",
    "--story", `ST-${suffix}`,
    "--id", `CONTRACT-${suffix}`,
    "--level", level,
    "--context-summary", `Implement ST-${suffix} inside the agreed boundary.`,
    "--qa", "Who confirms the boundary?|Human reviewer",
    "--output-ref", "implementation-summary:implementation-summary-v1:new",
    ...(profile ? ["--delivery-profile", profile] : []),
  ]);
  if (approve) approveContract(project, `CONTRACT-${suffix}`);
}

function approveContract(project, id) {
  cliJson([
    "contract", "approve",
    "--root", project,
    "--id", id,
    ...humanApproval(`Approve ${id}`),
  ]);
}

function startTask(project, storyId, profile = null) {
  return cliJson([
    "task", "start",
    "--root", project,
    "--intent-json", JSON.stringify({
      requested_action: "implement_story",
      confidence: 0.99,
      referenced_entities: [{ type: "story", id: storyId }],
      provided_artifacts: [],
      missing_context: [],
      proposed_phase: "implementation",
      artifact_type: null,
      skip_phases: [],
    }),
    ...(profile ? ["--delivery-profile", profile] : []),
    "--confirm-start",
    "--actor-type", "human",
  ]);
}

function humanApproval(summary) {
  return [
    "--actor-type", "human",
    "--approval-source", "explicit-user",
    "--summary", summary,
  ];
}

function runCli(args) {
  const environment = { ...process.env };
  for (const key of ["CI", "GITHUB_ACTIONS", "GITHUB_ACTOR", "CODEX_AGENT_NAME", "CODEX_USER_ID"]) {
    delete environment[key];
  }
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    env: environment,
    timeout: 60_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function cliJson(args) {
  const result = runCli([...args, "--json"]);
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(
    result.status,
    0,
    `${args.join(" ")}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
  );
  return JSON.parse(result.stdout);
}

function ref(id, hash) {
  return { id, path: `.sdlc/${id}.json`, hash };
}

function hostVerifiedAuthority() {
  return {
    mode: "host_verified",
    source: "host_approval_receipt",
    verified: true,
    receipt_ref: ref("HOST-RECEIPT", HASH.approval),
  };
}

function requirementProfile(level, authority) {
  return buildRequirementExecutionProfile({
    id: `AUT-REQ-${level.toUpperCase()}`,
    status: "active",
    requirement_ref: {
      id: "REQ-MATRIX",
      version: 1,
      path: ".sdlc/requirements/REQ-MATRIX.json",
      hash: HASH.requirement,
    },
    autonomy_ceiling: level,
    material_scope: {
      objective: "Exercise the governance matrix.",
      acceptance_criteria: ["The exact matrix case is enforced."],
      release_target: "pull_request",
    },
    constraints: {
      allowed_tools: ["node"],
      allowed_capabilities: ["test.run"],
      allowed_environments: ["workspace"],
      allowed_write_paths: ["test/"],
      forbidden_actions: ["production.deploy"],
      budget_ref: null,
    },
    authority_assurance: authority,
    approval_ref: ref("APPROVAL-REQUIREMENT", HASH.approval),
    created_at: "2026-07-28T09:00:00.000Z",
    valid_from: "2026-07-28T09:00:00.000Z",
  });
}

function deliveryProfile(options) {
  const {
    requirement,
    requestedLevel,
    authority,
    kind = "pull_request",
    mode = "new",
    prUrl = "https://github.com/aantenore/agentic-sdlc/pull/184",
    localWritePath = "/workspace/travelops/dist",
  } = options;
  const isLocal = kind === "local_release";
  const isExisting = !isLocal && mode === "existing";
  return buildDeliveryExecutionProfileV2({
    id: `AUT-DELIVERY-${kind}-${mode}-${requestedLevel}`,
    status: "active",
    delivery_id: isLocal ? "LOCAL-MATRIX" : isExisting ? "PR-184" : "PR-NEW",
    delivery_kind: kind,
    requirement_profile_refs: [ref(requirement.id, requirement.profile_hash)],
    story_refs: [ref("ST-MATRIX", HASH.story)],
    contract_refs: [ref("CONTRACT-MATRIX", HASH.contract)],
    material_scope: {
      objective: "Exercise one exact delivery.",
      acceptance_criteria: ["The exact delivery passes."],
      release_target: isLocal ? "/workspace/travelops/dist" : "pull_request",
    },
    requested_level: requestedLevel,
    constraints: {
      allowed_tools: ["node"],
      allowed_capabilities: ["test.run"],
      allowed_environments: [isLocal ? "local" : "pull_request"],
      allowed_write_paths: [isLocal ? "/workspace/travelops/dist" : "test/"],
      forbidden_actions: ["production.deploy"],
      budget_ref: null,
    },
    pull_request_target: isLocal ? null : {
      repository: "aantenore/agentic-sdlc",
      base_branch: "main",
      head_branch: "codex/governance-matrix",
      mode,
      ...(isExisting
        ? {
            pr_number: 184,
            pr_url: prUrl,
            reviewed_head_sha: "1".repeat(40),
          }
        : {}),
      allowed_actions: isExisting
        ? ["git.push", "pull_request.update"]
        : ["git.push", "pull_request.create", "pull_request.update"],
      merge_allowed: false,
    },
    local_release_target: isLocal ? {
      environment: "local",
      root_path: "/workspace/travelops",
      allowed_write_paths: [localWritePath],
      allowed_actions: ["build.local", "release.local", "test.run"],
      smoke_tests: ['["node","--version"]'],
      rollback: {
        required: true,
        procedure: "Restore the previous local package.",
      },
      external_access_allowed: false,
      production_access_allowed: false,
      destructive_actions_allowed: false,
    } : null,
    provider_bindings: isLocal
      ? [{ action: "release.local", provider_id: "local-filesystem" }]
      : [
          { action: "git.push", provider_id: "git-remote" },
          ...(!isExisting
            ? [{ action: "pull_request.create", provider_id: "github-cli" }]
            : []),
          { action: "pull_request.merge", provider_id: "github-cli" },
          { action: "pull_request.update", provider_id: "github-cli" },
        ],
    authority_assurance: authority,
    approval_ref: ref("APPROVAL-DELIVERY", HASH.approval),
    created_at: "2026-07-28T09:10:00.000Z",
    valid_from: "2026-07-28T09:10:00.000Z",
  });
}

function autonomyDecision(requirement, delivery, hostAuthority) {
  return evaluateAutonomyPolicy({
    id: `DECISION-${delivery.requested_level}`,
    phase: "implementation",
    now: FIXED_TIME,
    host_policy: {
      max_level: "bounded-autonomous",
      authority_assurance: hostAuthority,
    },
    project_policy: { max_level: "bounded-autonomous" },
    requirement_profiles: [requirement],
    current_requirements: [{
      id: requirement.requirement_ref.id,
      version: requirement.requirement_ref.version,
      hash: requirement.requirement_ref.hash,
      material_scope: requirement.material_scope,
    }],
    delivery_profile: delivery,
    current_story_refs: delivery.story_refs,
    current_contract_refs: delivery.contract_refs,
    current_delivery_scope: delivery.material_scope,
    delivery_state: {
      delivery_id: delivery.delivery_id,
      status: "open",
      active_run_count: 0,
    },
    contract_policy: {
      max_level: "bounded-autonomous",
      delivery_profile_ref: ref(delivery.id, delivery.profile_hash),
    },
    capability_policy: { max_level: "bounded-autonomous", allowed: true },
    environment_policy: { max_level: "bounded-autonomous", allowed: true },
    budget_policy: {
      max_level: "bounded-autonomous",
      status: "within_budget",
      allowed_to_start_next: true,
    },
  });
}

function canonicalEvidence(instanceId, storyId) {
  const phaseOrder = ["discovery"];
  const evidence = {
    kind: "workflow_canonical_evidence",
    schema_version: WORKFLOW_CANONICAL_EVIDENCE_SCHEMA,
    instance_id: instanceId,
    story_id: storyId,
    observed_at: FIXED_TIME,
    output_scope: {
      current_phase: "discovery",
      phase_order: phaseOrder,
      require_all: false,
    },
    workflow_scope: {
      instance_id: instanceId,
      instance_hash: "1".repeat(64),
      effective_hash: "2".repeat(64),
      story_id: storyId,
      current_phase: "discovery",
      phase_order: phaseOrder,
      checkpoint_ref: {
        checkpoint_hash: null,
        sequence: 0,
        last_event_hash: null,
        trace_chain_hash: null,
        updated_at: FIXED_TIME,
      },
    },
    checks: Object.fromEntries([
      "requirement_approved",
      "contract_approved",
      "required_output_linked",
      "strict_gate_passed",
      "delivery_terminal",
    ].map((id) => [id, { satisfied: true, issues: [] }])),
    hash_algorithm: STABLE_JSON_HASH_ALGORITHM,
  };
  return {
    ...evidence,
    evidence_hash: computeWorkflowCanonicalEvidenceHash(evidence),
  };
}
