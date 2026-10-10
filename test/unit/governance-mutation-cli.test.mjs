import "../helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createGovernancePolicy } from "../../lib/governance/policy-engine.mjs";
import { planIdentityMigration } from "../../lib/identity-migration.mjs";
import { DEFAULT_GOVERNANCE_AUDIT_EVENTS_ROOT } from "../../lib/governance/mutation-guard.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = path.join(ROOT, "bin", "agentic-sdlc.mjs");
const DETERMINISTIC_USER_INFO = path.join(ROOT, "test", "fixtures", "deterministic-user-info.cjs");
const DETERMINISTIC_USERNAME = "agentic-sdlc-test";
const CLI_TIMEOUT_MS = process.platform === "win32" ? 60_000 : 30_000;

function verifiedCliActor() {
  const credential = typeof process.getuid === "function"
    ? `uid:${process.getuid()}`
    : `user:${DETERMINISTIC_USERNAME}`;
  const identityHash = crypto.createHash("sha256")
    .update(`${process.platform}\0${credential}`)
    .digest("hex")
    .slice(0, 32);
  return { type: "system", id: `host-user-${identityHash}`, issuer: `os-${process.platform}` };
}

function projectFixture(t, label) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), `agentic-sdlc-governance-cli-${label}-`));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  return project;
}

function run(project, args) {
  const env = { ...process.env };
  for (const key of ["CI", "GITHUB_ACTIONS", "GITHUB_ACTOR", "CODEX_AGENT_NAME", "CODEX_USER_ID", "CLAUDECODE", "AGENTIC_SDLC_AGENT_HOST"]) delete env[key];
  const deterministicIdentityArgs = process.platform === "win32"
    ? ["--require", DETERMINISTIC_USER_INFO]
    : [];
  return spawnSync(process.execPath, [
    ...deterministicIdentityArgs,
    CLI,
    ...args,
    "--root",
    project,
    "--json",
  ], {
    cwd: project,
    env,
    encoding: "utf8",
    timeout: CLI_TIMEOUT_MS,
  });
}

function initialize(project) {
  const result = run(project, ["init", "--project-name", "Governed fixture", "--force"]);
  assert.equal(result.status, 0, result.stderr);
}

function denyAllPolicy() {
  return createGovernancePolicy({
    id: "POLICY-DENY-ALL",
    valid_from: "2026-01-01T00:00:00.000Z",
    expires_at: "2030-01-01T00:00:00.000Z",
    decision_ttl_seconds: 60,
    role_bindings: [],
    rules: [],
  });
}

function identityExecutionPolicy(descriptor, omittedKey = null) {
  const action = "migration.identity";
  const exact = descriptor.exact_mutations.filter(({ operation, path: projectPath }) =>
    `${operation}\0${projectPath}` !== omittedKey);
  return createGovernancePolicy({
    id: "POLICY-IDENTITY-EXACT",
    valid_from: "2026-01-01T00:00:00.000Z",
    expires_at: "2030-01-01T00:00:00.000Z",
    decision_ttl_seconds: 60,
    role_bindings: [{ id: "BIND-HOST-IDENTITY", role: "runner", actor: verifiedCliActor() }],
    rules: exact.map(({ operation, path: projectPath }, index) => ({
      id: `ALLOW-IDENTITY-${index + 1}`,
      effect: "allow",
      action,
      scope_refs: [
        { kind: "mutation_operation", id: operation },
        { kind: "project_path", id: projectPath },
      ],
      evidence_refs: [],
      actor_roles: ["runner"],
    })),
  });
}

function transitionAppendPolicy(instanceId, extraSources = []) {
  const action = "workflow.instance.transition";
  const instanceRoot = `.sdlc/workflows/instances/${instanceId}`;
  const allowed = [
    ["lock.acquire", `.sdlc/workflows/instances/.locks/${instanceId}.lock`],
    ["lock.release", `.sdlc/workflows/instances/.locks/${instanceId}.lock`],
    ["lock.acquire", `${instanceRoot}/events.jsonl.lock`],
    ["lock.release", `${instanceRoot}/events.jsonl.lock`],
    ["lock.acquire", ".sdlc/traces/project.jsonl.lock"],
    ["lock.release", ".sdlc/traces/project.jsonl.lock"],
    ["file.write", `${instanceRoot}/pending-transition.json`],
    ...extraSources.flatMap((sourcePath) => [
      ["file.write", sourcePath],
      ["lock.acquire", `${sourcePath}.lock`],
      ["lock.release", `${sourcePath}.lock`],
    ]),
  ];
  const rule = (id, effect, operation, projectPath) => ({
    id,
    effect,
    action,
    scope_refs: [
      { kind: "mutation_operation", id: operation },
      { kind: "project_path", id: projectPath },
    ],
    evidence_refs: [],
    actor_roles: effect === "allow" ? ["runner"] : [],
  });
  return createGovernancePolicy({
    id: "POLICY-TRANSITION-APPEND",
    valid_from: "2026-01-01T00:00:00.000Z",
    expires_at: "2030-01-01T00:00:00.000Z",
    decision_ttl_seconds: 60,
    role_bindings: [{ id: "BIND-HOST-CLI", role: "runner", actor: verifiedCliActor() }],
    rules: [
      ...allowed.map(([operation, projectPath], index) =>
        rule(`ALLOW-${index + 1}`, "allow", operation, projectPath)),
      rule("DENY-EVENT-APPEND", "deny", "file.append", `${instanceRoot}/events.jsonl`),
    ],
  });
}

function traceAppendPolicy(sourcePaths) {
  const action = "trace.append";
  const exact = [
    ["lock.acquire", ".sdlc/traces/project.jsonl.lock"],
    ["lock.release", ".sdlc/traces/project.jsonl.lock"],
    ["lock.acquire", ".sdlc/traces/.integrity/project.jsonl.checkpoint.json.lock"],
    ["lock.remove", ".sdlc/traces/.integrity/project.jsonl.checkpoint.json.lock"],
    ...sourcePaths.flatMap((sourcePath) => [
      ["file.write", sourcePath],
      ["lock.acquire", `${sourcePath}.lock`],
      ["lock.release", `${sourcePath}.lock`],
    ]),
  ];
  const makeRule = (id, effect, operation, projectPath) => ({
    id,
    effect,
    action,
    scope_refs: [
      { kind: "mutation_operation", id: operation },
      { kind: "project_path", id: projectPath },
    ],
    evidence_refs: [],
    actor_roles: effect === "allow" ? ["runner"] : [],
  });
  return createGovernancePolicy({
    id: "POLICY-TRACE-APPEND",
    valid_from: "2026-01-01T00:00:00.000Z",
    expires_at: "2030-01-01T00:00:00.000Z",
    decision_ttl_seconds: 60,
    role_bindings: [{ id: "BIND-HOST-TRACE", role: "runner", actor: verifiedCliActor() }],
    rules: [
      ...exact.map(([operation, projectPath], index) =>
        makeRule(`ALLOW-TRACE-${index + 1}`, "allow", operation, projectPath)),
      makeRule("DENY-TRACE-APPEND", "deny", "file.append", ".sdlc/traces/project.jsonl"),
    ],
  });
}

function unpinWithGovernance(project, governancePolicy) {
  const configPath = path.join(project, ".sdlc", "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.governance_policy = governancePolicy;
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  fs.rmSync(path.join(project, ".sdlc", "config.lock.json"), { force: true });
}

function createStory(project, id) {
  return run(project, [
    "story", "create", "--no-derived-verification",
    "--id", id,
    "--title", "Governed story",
    "--acceptance", "The exact mutation behavior is observable",
  ]);
}

test("CLI init completes through its exact bootstrap mutation profile", (t) => {
  const project = projectFixture(t, "init-bootstrap");
  initialize(project);
  for (const relativePath of [
    ".sdlc/config.json",
    ".sdlc/config.lock.json",
    ".sdlc/project.json",
    ".sdlc/output-contracts/registry.json",
    ".sdlc/dependencies/graph.json",
  ]) {
    assert.equal(fs.existsSync(path.join(project, relativePath)), true, `missing initialized path ${relativePath}`);
  }
});

test("CLI dispatch enforces an inline policy before creating the first story entry", (t) => {
  const project = projectFixture(t, "enforce");
  initialize(project);
  unpinWithGovernance(project, denyAllPolicy());
  const storyRoot = path.join(project, ".sdlc", "stories", "ST-GOV-DENIED");
  assert.equal(fs.existsSync(storyRoot), false);

  const result = createStory(project, "ST-GOV-DENIED");
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /no approval for this exact action and file/u);
  assert.equal(fs.existsSync(storyRoot), false, "the denied callback wrote a directory before its decision");
});

test("CLI audit pointer records policy misses without blocking legacy-compatible mutation", (t) => {
  const project = projectFixture(t, "audit");
  initialize(project);
  const governanceRoot = path.join(project, ".sdlc", "governance");
  fs.mkdirSync(governanceRoot, { recursive: true });
  fs.writeFileSync(path.join(governanceRoot, "policy.json"), `${JSON.stringify(denyAllPolicy(), null, 2)}\n`);
  unpinWithGovernance(project, {
    mode: "audit",
    policy_file: ".sdlc/governance/policy.json",
    decision_receipts_root: ".sdlc/governance/decisions",
    use_receipts_root: ".sdlc/governance/uses",
    revocations_root: ".sdlc/governance/revocations",
    fail_closed: false,
  });

  const result = createStory(project, "ST-GOV-AUDIT");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(project, ".sdlc", "stories", "ST-GOV-AUDIT", "story.json")), true);
  const auditRoot = path.join(project, ...DEFAULT_GOVERNANCE_AUDIT_EVENTS_ROOT.split("/"));
  const auditEvents = fs.readdirSync(auditRoot);
  assert.ok(auditEvents.length > 0, "audit misses must survive the CLI process that observed them");
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(auditRoot, auditEvents[0]), "utf8")).kind,
    "governance_mutation_audit_event",
  );
});

test("CLI warns clearly when audited work continues without a durable audit record", (t) => {
  const project = projectFixture(t, "audit-warning");
  initialize(project);
  const governanceRoot = path.join(project, ".sdlc", "governance");
  const operationalRoot = path.join(project, ".sdlc-governance");
  const blockedAuditPath = path.join(operationalRoot, "blocked-audit-events");
  fs.mkdirSync(governanceRoot, { recursive: true });
  fs.mkdirSync(operationalRoot, { recursive: true });
  fs.writeFileSync(path.join(governanceRoot, "policy.json"), `${JSON.stringify(denyAllPolicy(), null, 2)}\n`);
  fs.writeFileSync(blockedAuditPath, "this path is intentionally not a directory\n");
  unpinWithGovernance(project, {
    mode: "audit",
    policy_file: ".sdlc/governance/policy.json",
    decision_receipts_root: ".sdlc/governance/decisions",
    use_receipts_root: ".sdlc/governance/uses",
    revocations_root: ".sdlc/governance/revocations",
    audit_events_root: ".sdlc-governance/blocked-audit-events",
    fail_closed: false,
  });

  const result = createStory(project, "ST-GOV-AUDIT-WARNING");
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotThrow(() => JSON.parse(result.stdout));
  const warning = JSON.parse(result.stderr);
  assert.equal(warning.code, "MUTATION_AUDIT_RECORD_NOT_SAVED");
  assert.match(warning.message, /command finished/u);
  assert.match(warning.message, /audit history is incomplete/u);
  assert.equal(fs.readFileSync(blockedAuditPath, "utf8"), "this path is intentionally not a directory\n");

  const failed = createStory(project, "ST-GOV-AUDIT-WARNING");
  assert.notEqual(failed.status, 0, failed.stdout);
  assert.match(failed.stderr, /MUTATION_AUDIT_RECORD_NOT_SAVED/u);
  assert.match(failed.stderr, /command finished/u);
  assert.match(failed.stderr, /already exists|File already exists/u);
});

test("identity dual-path revalidation remains non-blocking in audit and fail-closed in enforce", (t) => {
  const sourceEmail = "legacy-governance@example.invalid";
  const targetEmail = "current-governance@example.test";

  const auditProject = projectFixture(t, "identity-audit");
  initialize(auditProject);
  const auditProjectPath = path.join(auditProject, ".sdlc", "project.json");
  const auditProjectRecord = JSON.parse(fs.readFileSync(auditProjectPath, "utf8"));
  auditProjectRecord.owner_email = sourceEmail;
  fs.writeFileSync(auditProjectPath, `${JSON.stringify(auditProjectRecord, null, 2)}\n`);
  const auditGovernanceRoot = path.join(auditProject, ".sdlc", "governance");
  fs.mkdirSync(auditGovernanceRoot, { recursive: true });
  fs.writeFileSync(
    path.join(auditGovernanceRoot, "policy.json"),
    `${JSON.stringify(denyAllPolicy(), null, 2)}\n`,
  );
  unpinWithGovernance(auditProject, {
    mode: "audit",
    policy_file: ".sdlc/governance/policy.json",
    decision_receipts_root: ".sdlc/governance/decisions",
    use_receipts_root: ".sdlc/governance/uses",
    revocations_root: ".sdlc/governance/revocations",
    fail_closed: false,
  });
  const auditPreview = run(auditProject, [
    "migration", "identity",
    "--from-email", sourceEmail,
    "--to-email", targetEmail,
  ]);
  assert.equal(auditPreview.status, 0, auditPreview.stderr);
  const auditPlan = JSON.parse(auditPreview.stdout);
  const auditApplied = run(auditProject, [
    "migration", "identity",
    "--from-email", sourceEmail,
    "--to-email", targetEmail,
    "--apply",
    "--plan-hash", auditPlan.plan_hash,
  ]);
  assert.equal(auditApplied.status, 0, auditApplied.stderr);
  assert.equal(JSON.parse(auditApplied.stdout).status, "applied");
  assert.equal(JSON.parse(fs.readFileSync(auditProjectPath, "utf8")).owner_email, targetEmail);
  assert.ok(
    fs.readdirSync(path.join(auditProject, ...DEFAULT_GOVERNANCE_AUDIT_EVENTS_ROOT.split("/"))).length > 0,
    "identity audit events must remain outside and survive the replaced .sdlc tree",
  );

  const enforceProject = projectFixture(t, "identity-enforce");
  initialize(enforceProject);
  const enforceProjectPath = path.join(enforceProject, ".sdlc", "project.json");
  const enforceProjectRecord = JSON.parse(fs.readFileSync(enforceProjectPath, "utf8"));
  enforceProjectRecord.owner_email = sourceEmail;
  fs.writeFileSync(enforceProjectPath, `${JSON.stringify(enforceProjectRecord, null, 2)}\n`);
  unpinWithGovernance(enforceProject, denyAllPolicy());
  const enforcePreview = run(enforceProject, [
    "migration", "identity",
    "--from-email", sourceEmail,
    "--to-email", targetEmail,
  ]);
  assert.equal(enforcePreview.status, 0, enforcePreview.stderr);
  const enforcePlan = JSON.parse(enforcePreview.stdout);
  const enforceBefore = fs.readFileSync(enforceProjectPath);
  const enforceDenied = run(enforceProject, [
    "migration", "identity",
    "--from-email", sourceEmail,
    "--to-email", targetEmail,
    "--apply",
    "--plan-hash", enforcePlan.plan_hash,
  ]);
  assert.notEqual(enforceDenied.status, 0, enforceDenied.stdout);
  assert.match(enforceDenied.stderr, /no approval for this exact action and file/u);
  assert.deepEqual(fs.readFileSync(enforceProjectPath), enforceBefore);
  assert.deepEqual(
    fs.readdirSync(enforceProject).filter((name) => name.startsWith(".sdlc-identity-migration")),
    [],
  );
});

test("identity migration applies under an exact inline enforce descriptor", (t) => {
  const project = projectFixture(t, "identity-inline-enforce");
  const sourceEmail = "legacy-inline-governance@example.invalid";
  const targetEmail = "current-inline-governance@example.test";
  initialize(project);
  const projectPath = path.join(project, ".sdlc", "project.json");
  const projectRecord = JSON.parse(fs.readFileSync(projectPath, "utf8"));
  projectRecord.owner_email = sourceEmail;
  fs.writeFileSync(projectPath, `${JSON.stringify(projectRecord, null, 2)}\n`);
  unpinWithGovernance(project, denyAllPolicy());

  const firstPlan = planIdentityMigration({
    projectRoot: project,
    mapping: { source: { email: sourceEmail }, target: { email: targetEmail } },
  });
  const firstDescriptor = firstPlan.execution_descriptor;
  const omitted = firstDescriptor.exact_mutations.find(({ operation, path: mutationPath }) =>
    operation === "file.write" && mutationPath === firstDescriptor.lock_temporary_path);
  assert.ok(omitted, "descriptor must bind the physical lock temp write");

  unpinWithGovernance(project, identityExecutionPolicy(
    firstDescriptor,
    `${omitted.operation}\0${omitted.path}`,
  ));
  const deniedPreview = run(project, [
    "migration", "identity",
    "--from-email", sourceEmail,
    "--to-email", targetEmail,
  ]);
  assert.equal(deniedPreview.status, 0, deniedPreview.stderr);
  const deniedPlan = JSON.parse(deniedPreview.stdout);
  assert.deepEqual(
    deniedPlan.execution_descriptor.exact_mutations,
    firstDescriptor.exact_mutations,
    "policy review must not randomize physical execution paths",
  );
  const beforeDenied = fs.readFileSync(projectPath);
  const denied = run(project, [
    "migration", "identity",
    "--from-email", sourceEmail,
    "--to-email", targetEmail,
    "--apply",
    "--plan-hash", deniedPlan.plan_hash,
  ]);
  assert.notEqual(denied.status, 0, denied.stdout);
  assert.match(denied.stderr, /no approval for this exact action and file/u);
  assert.deepEqual(fs.readFileSync(projectPath), beforeDenied);
  assert.deepEqual(
    fs.readdirSync(project).filter((name) => name.startsWith(".sdlc-identity-migration")),
    [],
    "a missing batch tuple must deny before the lock temp is created",
  );

  unpinWithGovernance(project, identityExecutionPolicy(firstDescriptor));
  const preview = run(project, [
    "migration", "identity",
    "--from-email", sourceEmail,
    "--to-email", targetEmail,
  ]);
  assert.equal(preview.status, 0, preview.stderr);
  const reviewed = JSON.parse(preview.stdout);
  assert.deepEqual(reviewed.execution_descriptor.exact_mutations, firstDescriptor.exact_mutations);
  const applied = run(project, [
    "migration", "identity",
    "--from-email", sourceEmail,
    "--to-email", targetEmail,
    "--apply",
    "--plan-hash", reviewed.plan_hash,
  ]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).status, "applied");
  assert.equal(JSON.parse(fs.readFileSync(projectPath, "utf8")).owner_email, targetEmail);
  assert.deepEqual(
    fs.readdirSync(project).filter((name) => name.startsWith(".sdlc-identity-migration")),
    [],
  );
});

test("identity migration rejects enforce pointer receipts before any write", (t) => {
  const project = projectFixture(t, "identity-pointer-enforce");
  const sourceEmail = "legacy-pointer-governance@example.invalid";
  const targetEmail = "current-pointer-governance@example.test";
  initialize(project);
  const projectPath = path.join(project, ".sdlc", "project.json");
  const projectRecord = JSON.parse(fs.readFileSync(projectPath, "utf8"));
  projectRecord.owner_email = sourceEmail;
  fs.writeFileSync(projectPath, `${JSON.stringify(projectRecord, null, 2)}\n`);
  const governanceRoot = path.join(project, ".sdlc", "governance");
  fs.mkdirSync(governanceRoot, { recursive: true });
  fs.writeFileSync(path.join(governanceRoot, "policy.json"), `${JSON.stringify(denyAllPolicy(), null, 2)}\n`);
  unpinWithGovernance(project, {
    mode: "enforce",
    policy_file: ".sdlc/governance/policy.json",
    decision_receipts_root: ".sdlc/governance/decisions",
    use_receipts_root: ".sdlc/governance/uses",
    revocations_root: ".sdlc/governance/revocations",
    fail_closed: true,
  });
  const preview = run(project, [
    "migration", "identity",
    "--from-email", sourceEmail,
    "--to-email", targetEmail,
  ]);
  assert.equal(preview.status, 0, preview.stderr);
  const before = fs.readFileSync(projectPath);
  const rejected = run(project, [
    "migration", "identity",
    "--from-email", sourceEmail,
    "--to-email", targetEmail,
    "--apply",
    "--plan-hash", JSON.parse(preview.stdout).plan_hash,
  ]);
  assert.notEqual(rejected.status, 0, rejected.stdout);
  assert.match(rejected.stderr, /approval records could not be kept safely/u);
  assert.deepEqual(fs.readFileSync(projectPath), before);
  assert.equal(fs.existsSync(path.join(governanceRoot, "decisions")), false);
  assert.equal(fs.existsSync(path.join(governanceRoot, "uses")), false);
  assert.deepEqual(
    fs.readdirSync(project).filter((name) => name.startsWith(".sdlc-identity-migration")),
    [],
  );
});

test("CLI denies a workflow transition append before the first event byte", (t) => {
  const project = projectFixture(t, "workflow-append");
  initialize(project);
  const warmup = run(project, [
    "workflow", "instance", "start",
    "--id", "change-warmup",
    "--definition", "change-request",
    "--definition-version", "1",
  ]);
  assert.equal(warmup.status, 0, warmup.stderr);
  const warmedTransition = run(project, [
    "workflow", "instance", "transition",
    "--id", "change-warmup",
    "--to", "impact-review",
    "--request-id", "impact-review-warmup",
  ]);
  assert.equal(warmedTransition.status, 0, warmedTransition.stderr);
  const instanceId = "change-guard";
  const started = run(project, [
    "workflow", "instance", "start",
    "--id", instanceId,
    "--definition", "change-request",
    "--definition-version", "1",
  ]);
  assert.equal(started.status, 0, started.stderr);
  const eventsPath = path.join(project, ".sdlc", "workflows", "instances", instanceId, "events.jsonl");
  const before = fs.readFileSync(eventsPath);
  assert.equal(before.length, 0);
  const evidencePolicyRoot = path.join(project, ".sdlc", "evidence-redaction-policies");
  const policySources = fs.readdirSync(evidencePolicyRoot)
    .filter((name) => name.endsWith(".json"))
    .map((name) => `.sdlc/evidence-redaction-policies/${name}`);
  unpinWithGovernance(project, transitionAppendPolicy(instanceId, policySources));

  const result = run(project, [
    "workflow", "instance", "transition",
    "--id", instanceId,
    "--to", "impact-review",
    "--request-id", "impact-review-denied",
  ]);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /no approval for this exact action and file/u);
  assert.deepEqual(fs.readFileSync(eventsPath), before, "the denied append changed the event history");
  assert.equal(
    fs.existsSync(path.join(path.dirname(eventsPath), "pending-transition.json")),
    true,
    `the exact journal should exist before the separately denied append\nSources: ${JSON.stringify(policySources)}\n${result.stderr}`,
  );
});

test("trace-integrity dependency writes consume exact mutation grants", (t) => {
  const project = projectFixture(t, "trace-dependencies");
  initialize(project);
  const warmup = run(project, [
    "trace", "append",
    "--type", "decision",
    "--summary", "Warm the exact trace integrity files",
  ]);
  assert.equal(warmup.status, 0, warmup.stderr);
  const tracePath = path.join(project, ".sdlc", "traces", "project.jsonl");
  const before = fs.readFileSync(tracePath);
  const evidencePolicyRoot = path.join(project, ".sdlc", "evidence-redaction-policies");
  const sourcePaths = (fs.existsSync(evidencePolicyRoot) ? fs.readdirSync(evidencePolicyRoot) : [])
    .filter((name) => name.endsWith(".json"))
    .map((name) => `.sdlc/evidence-redaction-policies/${name}`);
  unpinWithGovernance(project, traceAppendPolicy(sourcePaths));

  const denied = run(project, [
    "trace", "append",
    "--type", "decision",
    "--summary", "This append must be denied before its first byte",
  ]);
  assert.notEqual(denied.status, 0, denied.stdout);
  const payload = JSON.parse(denied.stderr);
  assert.ok(payload.human_guidance.details.mutation, denied.stderr);
  assert.equal(payload.human_guidance.details.mutation.operation, "file.append", denied.stderr);
  assert.equal(payload.human_guidance.details.mutation.project_path, ".sdlc/traces/project.jsonl");
  assert.deepEqual(fs.readFileSync(tracePath), before);
});
