import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { findCommand, listCommandPaths, listOptions } from "../../lib/cli/command-catalog.mjs";
import { completionCandidates } from "../../lib/cli/completion.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = path.join(ROOT, "bin", "agentic-sdlc.mjs");
const INTEGRATION_REVIEW_TEMPLATE_DIRECTORY = path.join(
  ROOT,
  "templates",
  "workflow-software-project-v3-integration-review",
);
const INTEGRATION_REVIEW_DEFINITION = path.join(
  INTEGRATION_REVIEW_TEMPLATE_DIRECTORY,
  "workflow-definition.json",
);
const INTEGRATION_REVIEW_CONFIG = path.join(
  INTEGRATION_REVIEW_TEMPLATE_DIRECTORY,
  "sdlc-config.json",
);
const TEMPORARY_DIRECTORIES = new Set();

after(() => {
  for (const directory of TEMPORARY_DIRECTORIES) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryProject(label) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `agentic-sdlc-workflow-${label}-`));
  TEMPORARY_DIRECTORIES.add(directory);
  return directory;
}

function run(args, cwd) {
  const env = { ...process.env };
  for (const key of ["CI", "GITHUB_ACTIONS", "GITHUB_ACTOR", "CODEX_AGENT_NAME", "CODEX_USER_ID"]) delete env[key];
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env,
    timeout: 30_000,
  });
}

function mustRun(args, cwd) {
  const result = run(args, cwd);
  assert.equal(result.status, 0, `${args.join(" ")}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result.stdout;
}

function mustRunJson(args, cwd) {
  return JSON.parse(mustRun([...args, "--json"], cwd));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function pinProjectConfig(project) {
  const preview = mustRunJson(["config", "migrate", "--root", project], project);
  return mustRunJson([
    "config", "migrate",
    "--root", project,
    "--apply",
    "--plan-hash", preview.plan.plan_hash,
    "--actor-type", "system",
  ], project);
}

function primaryHumanText(output, locale = "en") {
  const divider = locale === "it" ? "Dettagli tecnici (facoltativi):" : "Technical details (optional):";
  assert.match(output, new RegExp(divider.replace(/[()]/gu, "\\$&"), "u"));
  return output.split(divider)[0];
}

test("workflow catalog and completion expose the complete bounded command family", () => {
  const paths = new Set(listCommandPaths());
  for (const command of [
    "workflow definition list",
    "workflow definition show",
    "workflow definition propose",
    "workflow definition approve",
    "workflow overlay propose",
    "workflow overlay approve",
    "workflow overlay explain",
    "workflow instance start",
    "workflow instance transition",
    "workflow instance status",
    "workflow instance explain",
  ]) {
    assert.equal(paths.has(command), true, command);
    assert.ok(findCommand(command), command);
  }

  const workflow = completionCandidates(["workflow"]);
  for (const child of ["definition", "instance", "overlay"]) assert.equal(workflow.includes(child), true, child);
  assert.equal(workflow.includes("approve"), false);
  const definition = completionCandidates(["workflow", "definition"]);
  for (const child of ["approve", "list", "propose", "show"]) assert.equal(definition.includes(child), true, child);
  const transition = completionCandidates(["workflow", "instance", "transition"]);
  for (const flag of [
    "--id",
    "--to",
    "--request-id",
    "--guard-input-json",
    "--actor-type",
    "--actor-name",
    "--actor-email",
    "--locale",
    "--json",
  ]) {
    assert.equal(transition.includes(flag), true, flag);
  }

  const approvalFlags = new Set(listOptions("workflow definition approve").map((entry) => entry.flag));
  for (const flag of ["--id", "--definition-version", "--actor-type", "--approval-source", "--authorization", "--summary"]) {
    assert.equal(approvalFlags.has(flag), true, flag);
  }
  const startStory = listOptions("workflow instance start").find((entry) => entry.flag === "--story");
  assert.ok(startStory);
  assert.match(startStory.required_when?.en || "", /canonical lifecycle checks/u);
});

test("the distributed integration-review overlay supports init, migration, propose, approve, show, and start", () => {
  const project = temporaryProject("distributed-integration-review-template");
  const projectTemplate = path.join(
    project,
    "workflow-software-project-v3-integration-review.json",
  );
  const input = readJson(INTEGRATION_REVIEW_DEFINITION);
  const defaultConfig = readJson(path.join(ROOT, "templates", "sdlc-config.json"));
  const companionConfig = readJson(INTEGRATION_REVIEW_CONFIG);
  const normalizedCompanionConfig = structuredClone(companionConfig);
  normalizedCompanionConfig.phase_order = defaultConfig.phase_order;
  delete normalizedCompanionConfig.phases["integration-review"];
  normalizedCompanionConfig.autonomy_policy.presets.checkpointed.automatic_phases =
    defaultConfig.autonomy_policy.presets.checkpointed.automatic_phases;
  normalizedCompanionConfig.autonomy_policy.presets["bounded-autonomous"].automatic_phases =
    defaultConfig.autonomy_policy.presets["bounded-autonomous"].automatic_phases;
  assert.deepEqual(
    normalizedCompanionConfig,
    defaultConfig,
    "the full companion config may differ from the stock config only at the declared custom phase surfaces",
  );
  const derivedFields = [
    "id",
    "version",
    "kind",
    "schema_version",
    "status",
    "created_at",
    "approval",
    "definition_hash",
    "hash_algorithm",
  ];
  for (const field of derivedFields) {
    assert.equal(
      Object.hasOwn(input, field),
      false,
      `${field} must remain CLI-derived rather than author-edited template input`,
    );
  }
  assert.deepEqual(input.phase_order, [
    "discovery",
    "analysis",
    "design",
    "implementation",
    "integration-review",
    "validation",
    "release",
    "operations",
  ]);
  assert.equal(
    findCommand("workflow definition propose").examples.some((example) =>
      example.includes("templates/workflow-software-project-v3-integration-review/workflow-definition.json")),
    true,
  );
  assert.equal(
    findCommand("init").examples.some((example) =>
      example.includes("--template-dir <plugin-root>/templates/workflow-software-project-v3-integration-review")),
    true,
  );

  const initialized = mustRunJson([
    "init",
    "--root", project,
    "--project-name", "Distributed workflow template",
    "--template-dir", INTEGRATION_REVIEW_TEMPLATE_DIRECTORY,
  ], project);
  assert.deepEqual(initialized.project.phase_order, input.phase_order);
  const configPath = path.join(project, ".sdlc", "config.json");
  const configStatus = mustRunJson(["config", "status", "--root", project], project);
  assert.equal(configStatus.status, "locked");
  assert.deepEqual(readJson(configPath).phase_order, input.phase_order);
  assert.equal(
    fs.existsSync(path.join(
      project,
      ".sdlc",
      "contracts",
      "contract-integration-review-v1.json",
    )),
    true,
  );
  fs.copyFileSync(INTEGRATION_REVIEW_DEFINITION, projectTemplate);
  mustRunJson([
    "story", "create",
    "--root", project,
    "--id", "ST-DISTRIBUTED-TEMPLATE",
    "--title", "Use the distributed integration-review workflow",
    "--acceptance", "The exact seven-phase workflow starts for this story.",
  ], project);

  const proposed = mustRunJson([
    "workflow", "definition", "propose",
    "--root", project,
    "--id", "software-project-integration-review",
    "--definition-version", "1",
    "--definition-file", path.basename(projectTemplate),
  ], project);
  assert.equal(proposed.status, "proposed");
  assert.equal(proposed.definition.id, "software-project-integration-review");
  assert.equal(proposed.definition.version, "1");
  assert.equal(proposed.definition.status, "proposed");
  assert.equal(proposed.definition.kind, "workflow_definition");
  assert.equal(proposed.definition.schema_version, "workflow-definition:v1");
  assert.equal(proposed.definition.approval, null);
  assert.match(proposed.definition.created_at, /^\d{4}-\d{2}-\d{2}T/u);
  assert.match(proposed.definition.definition_hash, /^[a-f0-9]{64}$/u);
  assert.equal(proposed.definition.hash_algorithm, "sha256:stable-json:v1");
  assert.deepEqual(proposed.definition.phase_order, input.phase_order);
  assert.equal(
    proposed.definition.states.some((state) => state.id === "integration-review"),
    true,
  );
  assert.deepEqual(
    proposed.definition.transitions
      .find((transition) => transition.id === "implementation-to-integration-review")
      ?.guards,
    [],
  );
  assert.deepEqual(
    proposed.definition.transitions
      .find((transition) => transition.id === "integration-review-to-validation")
      ?.guards
      .map((guard) => guard.id),
    ["required-output-linked"],
  );
  assert.deepEqual(
    proposed.definition.transitions
      .find((transition) => transition.id === "validation-to-release")
      ?.guards
      .map((guard) => guard.id),
    ["strict-gate-passed"],
  );

  const approved = mustRunJson([
    "workflow", "definition", "approve",
    "--root", project,
    "--id", "software-project-integration-review",
    "--definition-version", "1",
    "--actor-type", "ci",
    "--approval-source", "ci",
    "--summary", "Approve the distributed seven-phase workflow.",
  ], project);
  assert.equal(approved.status, "approved");
  assert.equal(approved.definition.status, "approved");
  assert.equal(
    approved.definition.definition_hash,
    proposed.definition.definition_hash,
  );

  const shown = mustRunJson([
    "workflow", "definition", "show",
    "--root", project,
    "--id", "software-project-integration-review",
    "--definition-version", "1",
  ], project);
  assert.equal(shown.status, "approved");
  assert.equal(shown.source, "project");
  assert.equal(shown.definition.approval.approval_source, "ci");
  assert.equal(
    shown.definition.definition_hash,
    proposed.definition.definition_hash,
  );
  assert.deepEqual(shown.definition.phase_order, input.phase_order);

  const started = mustRunJson([
    "workflow", "instance", "start",
    "--root", project,
    "--id", "WF-DISTRIBUTED-TEMPLATE",
    "--definition", "software-project-integration-review",
    "--definition-version", "1",
    "--story", "ST-DISTRIBUTED-TEMPLATE",
  ], project);
  assert.equal(started.instance.initial_state, "discovery");
  assert.equal(
    started.instance.metadata.governance_binding.story_id,
    "ST-DISTRIBUTED-TEMPLATE",
  );
  const claimAuthorization = mustRunJson([
    "authorization", "grant",
    "--root", project,
    "--id", "AUTH-ST-DISTRIBUTED-TEMPLATE-CLAIM",
    "--scope", "Allow one claim for ST-DISTRIBUTED-TEMPLATE only.",
    "--allow-use", "story.claim=ST-DISTRIBUTED-TEMPLATE",
    "--max-uses", "1",
    "--actor-type", "ci",
    "--approval-source", "ci",
    "--summary", "Approve one exact story claim.",
  ], project);
  assert.deepEqual(
    claimAuthorization.authorization.allowed_uses.map((use) => use.subject_id),
    ["ST-DISTRIBUTED-TEMPLATE"],
  );
  const completionAuthorization = mustRunJson([
    "authorization", "grant",
    "--root", project,
    "--id", "AUTH-ST-DISTRIBUTED-TEMPLATE-INTEGRATION-REVIEW",
    "--scope", "Complete integration-review for ST-DISTRIBUTED-TEMPLATE only.",
    "--allow-use",
    "story.complete-step=ST-DISTRIBUTED-TEMPLATE.step.integration-review",
    "--max-uses", "1",
    "--actor-type", "ci",
    "--approval-source", "ci",
    "--summary", "Approve the exact integration-review completion.",
  ], project);
  assert.deepEqual(
    completionAuthorization.authorization.allowed_uses.map((use) => use.subject_id),
    ["ST-DISTRIBUTED-TEMPLATE.step.integration-review"],
  );

  const migratedProject = temporaryProject("distributed-integration-review-migrate");
  mustRun([
    "init",
    "--root", migratedProject,
    "--project-name", "Migrated custom workflow init",
  ], migratedProject);
  const migratedConfigPath = path.join(migratedProject, ".sdlc", "config.json");
  fs.copyFileSync(INTEGRATION_REVIEW_CONFIG, migratedConfigPath);
  const migrationPreview = mustRunJson([
    "config", "migrate",
    "--root", migratedProject,
  ], migratedProject);
  assert.equal(migrationPreview.status, "planned");
  assert.match(migrationPreview.plan.plan_hash, /^[a-f0-9]{64}$/u);
  const migration = mustRunJson([
    "config", "migrate",
    "--root", migratedProject,
    "--apply",
    "--plan-hash", migrationPreview.plan.plan_hash,
  ], migratedProject);
  assert.equal(migration.status, "applied");
  assert.equal(
    mustRunJson(["config", "status", "--root", migratedProject], migratedProject).status,
    "locked",
  );
  assert.deepEqual(readJson(migratedConfigPath).phase_order, input.phase_order);
});

test("preset definition approval and an event-sourced run are stable and retry-safe", () => {
  const project = temporaryProject("journey");
  mustRun(["init", "--root", project, "--project-name", "Workflow journey"], project);

  const listed = mustRunJson(["workflow", "definition", "list", "--root", project], project);
  assert.equal(listed.schema_version, "workflow-definition-list:v1");
  assert.deepEqual(listed.included.map((entry) => entry.id), [
    "software-project",
    "change-request",
    "technical-assessment",
    "generic-governed-process",
  ]);
  const softwareProject = listed.included.find((entry) => entry.id === "software-project");
  assert.equal(softwareProject.version, "3");
  assert.deepEqual(softwareProject.available_versions, ["1", "2", "3"]);
  assert.match(softwareProject.description, /governed workflow preset/u);
  assert.deepEqual(softwareProject.journey, [
    "discovery", "analysis", "design", "implementation", "validation", "release", "operations",
  ]);
  assert.deepEqual(softwareProject.governance_controls, [
    "requirement-approved",
    "contract-approved",
    "required-output-linked",
    "strict-gate-passed",
  ]);

  const italianProposal = mustRun([
    "workflow", "definition", "propose",
    "--root", project,
    "--id", "team-delivery",
    "--definition-version", "2",
    "--workflow-preset", "software-project",
    "--summary", "Sei passaggi di consegna con revisioni concordate",
    "--locale", "it",
  ], project);
  const primary = primaryHumanText(italianProposal, "it");
  assert.match(primary, /^Risultato:/u);
  assert.match(primary, /Resta inattiva finché non viene confermata/u);
  assert.doesNotMatch(primary, /\b(?:schema|hash|profile|receipt|bounded-autonomous|checkpointed|audit_only)\b/iu);
  assert.doesNotMatch(primary, /\.sdlc\/|--[a-z]/u);

  const approved = mustRunJson([
    "workflow", "definition", "approve",
    "--root", project,
    "--id", "team-delivery",
    "--definition-version", "2",
    "--actor-type", "human",
    "--approval-source", "explicit-user",
    "--summary", "Approved the displayed steps, checks, and limits",
  ], project);
  assert.equal(approved.status, "approved");
  assert.equal(approved.definition.status, "approved");
  assert.equal(approved.definition.approval.approval_source, "explicit-user");

  const firstShow = mustRun([
    "workflow", "definition", "show", "--root", project,
    "--id", "team-delivery", "--definition-version", "2", "--json",
  ], project);
  const secondShow = mustRun([
    "workflow", "definition", "show", "--root", project,
    "--id", "team-delivery", "--definition-version", "2", "--json",
  ], project);
  const { correlation_id: firstCorrelationId, ...firstStableShow } = JSON.parse(firstShow);
  const { correlation_id: secondCorrelationId, ...secondStableShow } = JSON.parse(secondShow);
  assert.match(firstCorrelationId, /^corr-/u);
  assert.match(secondCorrelationId, /^corr-/u);
  assert.notEqual(firstCorrelationId, secondCorrelationId);
  assert.deepEqual(firstStableShow, secondStableShow);

  const overlayProposal = mustRunJson([
    "workflow", "overlay", "propose",
    "--root", project,
    "--id", "team-labels",
    "--overlay-version", "1",
    "--definition", "team-delivery",
    "--definition-version", "2",
    "--overlay-json", JSON.stringify({
      label: "Team delivery",
      state_overrides: [{ state_id: "analysis", label: "Impact review", metadata: {} }],
      transition_overrides: [],
      metadata: { locale: "en" },
    }),
  ], project);
  assert.equal(overlayProposal.status, "proposed");
  assert.equal(overlayProposal.overlay.status, "proposed");

  const approvedOverlay = mustRunJson([
    "workflow", "overlay", "approve",
    "--root", project,
    "--id", "team-labels",
    "--overlay-version", "1",
    "--actor-type", "human",
    "--approval-source", "explicit-user",
    "--summary", "Approved the displayed labels without changing the process steps",
  ], project);
  assert.equal(approvedOverlay.overlay.status, "approved");

  const explainedOverlay = mustRunJson([
    "workflow", "overlay", "explain",
    "--root", project,
    "--id", "team-labels",
    "--overlay-version", "1",
  ], project);
  assert.equal(explainedOverlay.status, "ready");
  assert.equal(explainedOverlay.effective_definition.states.find((state) => state.id === "analysis").label, "Impact review");

  mustRunJson([
    "requirement", "propose",
    "--root", project,
    "--id", "REQ-WORKFLOW-42",
    "--title", "Govern the workflow test delivery",
    "--summary", "Keep the test delivery bound to one approved requirement.",
    "--acceptance", "The first workflow phase can advance from canonical requirement evidence.",
    "--non-goal", "Do not perform a remote delivery.",
    "--autonomy-ceiling", "supervised",
  ], project);
  mustRunJson([
    "requirement", "approve",
    "--root", project,
    "--id", "REQ-WORKFLOW-42",
    "--actor-type", "ci",
    "--actor-name", "Workflow test",
    "--approval-source", "ci",
    "--summary", "Approved the exact workflow test requirement.",
  ], project);
  mustRunJson([
    "story", "create",
    "--root", project,
    "--id", "ST-WORKFLOW-42",
    "--title", "Exercise canonical workflow transitions",
    "--requirement", "REQ-WORKFLOW-42",
    "--acceptance", "Canonical requirement evidence unlocks analysis.",
  ], project);

  const unboundStart = run([
    "workflow", "instance", "start",
    "--root", project,
    "--id", "unbound-delivery-42",
    "--definition", "team-delivery",
    "--definition-version", "2",
    "--overlay", "team-labels",
    "--overlay-version", "1",
    "--json",
  ], project);
  assert.notEqual(unboundStart.status, 0);
  assert.match(unboundStart.stderr, /--story/u);

  const started = mustRunJson([
    "workflow", "instance", "start",
    "--root", project,
    "--id", "delivery-42",
    "--definition", "team-delivery",
    "--definition-version", "2",
    "--overlay", "team-labels",
    "--overlay-version", "1",
    "--story", "ST-WORKFLOW-42",
    "--actor", "workflow-test-ci",
    "--actor-type", "ci",
    "--actor-name", "Workflow test CI",
  ], project);
  assert.equal(started.status, "started");
  assert.equal(started.instance.overlay_ref.id, "team-labels");
  assert.deepEqual(started.instance.actor, {
    id: "workflow-test-ci",
    type: "ci",
    name: "Workflow test CI",
  });
  assert.equal(started.instance.metadata.governance_binding.story_id, "ST-WORKFLOW-42");
  assert.equal(
    started.instance.metadata.governance_binding.strict_gate_receipt_path,
    ".sdlc/gates/ST-WORKFLOW-42-strict.json",
  );
  assert.equal(
    started.instance.metadata.governance_binding.final_gate_receipt_path,
    ".sdlc/gates/ST-WORKFLOW-42-final.json",
  );
  assert.equal(fs.existsSync(path.join(project, ".sdlc", "workflows", "instances", "delivery-42", "instance.json")), true);
  assert.equal(fs.existsSync(path.join(project, ".sdlc", "workflows", "instances", "delivery-42", "events.jsonl")), true);

  const transitioned = mustRunJson([
    "workflow", "instance", "transition",
    "--root", project,
    "--id", "delivery-42",
    "--to", "analysis",
    "--request-id", "delivery-42-analysis",
    "--actor", "workflow-test-ci",
    "--actor-type", "ci",
    "--actor-name", "Workflow test CI",
    "--guard-input-json", JSON.stringify({
      requirement_approved: false,
      canonical_evidence: { requirement_approved: false },
    }),
  ], project);
  assert.equal(transitioned.status, "transitioned");
  assert.equal(transitioned.replay.current_state, "analysis");
  assert.equal(transitioned.event.guard_results[0].guard_id, "requirement-approved");
  assert.equal(transitioned.event.guard_results[0].allowed, true);
  assert.deepEqual(transitioned.event.actor, {
    id: "workflow-test-ci",
    type: "ci",
    name: "Workflow test CI",
  });
  assert.equal(
    transitioned.event.canonical_evidence.checks.requirement_approved.satisfied,
    true,
  );
  assert.equal(
    transitioned.event.canonical_evidence.schema_version,
    "workflow-canonical-evidence:v1",
  );
  assert.equal(
    Object.hasOwn(transitioned.event.canonical_evidence, "workflow_scope"),
    false,
  );

  const retried = mustRunJson([
    "workflow", "instance", "transition",
    "--root", project,
    "--id", "delivery-42",
    "--to", "analysis",
    "--request-id", "delivery-42-analysis",
  ], project);
  assert.equal(retried.event.event_hash, transitioned.event.event_hash);

  const status = mustRunJson([
    "workflow", "instance", "status", "--root", project, "--id", "delivery-42",
  ], project);
  assert.equal(status.current_state, "analysis");
  assert.equal(status.event_count, 1);
  assert.deepEqual(status.next_states, ["design"]);
  assert.deepEqual(status.ready_next_states, ["design"]);
  assert.deepEqual(status.next_transition_checks, [{
    transition_id: "analysis-to-design",
    to: "design",
    canonical: false,
    allowed: true,
    guard_results: [],
  }]);

  const humanStatus = mustRun([
    "workflow", "instance", "status", "--root", project, "--id", "delivery-42", "--locale", "en",
  ], project);
  const englishPrimary = primaryHumanText(humanStatus, "en");
  assert.match(englishPrimary, /^Outcome:/u);
  assert.match(englishPrimary, /reconstructed from its recorded history/u);
  assert.doesNotMatch(englishPrimary, /\b(?:schema|hash|profile|receipt|bounded-autonomous|checkpointed|audit_only)\b/iu);
  assert.doesNotMatch(englishPrimary, /\.sdlc\/|--[a-z]/u);

  mustRunJson([
    "workflow", "instance", "transition",
    "--root", project,
    "--id", "delivery-42",
    "--to", "design",
    "--request-id", "delivery-42-design",
  ], project);
  const callerBypass = run([
    "workflow", "instance", "transition",
    "--root", project,
    "--id", "delivery-42",
    "--to", "implementation",
    "--request-id", "delivery-42-implementation-bypass",
    "--guard-input-json", JSON.stringify({
      contract_approved: true,
      canonical_evidence: { contract_approved: true },
    }),
    "--json",
  ], project);
  assert.notEqual(callerBypass.status, 0);
  assert.match(callerBypass.stderr, /canonical project records|guards denied/u);
  assert.match(callerBypass.stderr, /contract-approved:/u);
  const afterBypass = mustRunJson([
    "workflow", "instance", "status", "--root", project, "--id", "delivery-42",
  ], project);
  assert.equal(afterBypass.current_state, "design");
  assert.equal(afterBypass.event_count, 2);
  assert.deepEqual(afterBypass.ready_next_states, []);
  assert.equal(afterBypass.next_transition_checks.length, 1);
  assert.equal(afterBypass.next_transition_checks[0].to, "implementation");
  assert.equal(afterBypass.next_transition_checks[0].canonical, true);
  assert.equal(afterBypass.next_transition_checks[0].allowed, false);
  assert.equal(afterBypass.next_transition_checks[0].guard_results[0].guard_id, "contract-approved");
  assert.equal(afterBypass.next_transition_checks[0].guard_results[0].allowed, false);

  const failedFinalGate = run([
    "gate", "check",
    "--root", project,
    "--strict",
    "--story", "ST-WORKFLOW-42",
    "--lifecycle-complete",
    "--json",
  ], project);
  assert.notEqual(failedFinalGate.status, 0);
  assert.equal(
    fs.existsSync(path.join(project, ".sdlc", "gates", "ST-WORKFLOW-42-final.json")),
    false,
  );
});

test("an included preset can start a run without being copied into project storage", () => {
  const project = temporaryProject("included");
  mustRun(["init", "--root", project, "--project-name", "Included workflow"], project);

  const started = mustRunJson([
    "workflow", "instance", "start",
    "--root", project,
    "--id", "change-184",
    "--definition", "change-request",
    "--definition-version", "1",
  ], project);
  assert.equal(started.instance.definition_ref.id, "change-request");
  assert.equal(started.instance.initial_state, "intake");
  assert.equal(
    fs.existsSync(path.join(project, ".sdlc", "workflows", "definitions", "change-request", "v1.json")),
    false,
  );

  const transitioned = mustRunJson([
    "workflow", "instance", "transition",
    "--root", project,
    "--id", "change-184",
    "--to", "impact-review",
    "--request-id", "impact-review-1",
  ], project);
  assert.equal(transitioned.replay.current_state, "impact-review");

  const status = mustRunJson([
    "workflow", "instance", "status", "--root", project, "--id", "change-184",
  ], project);
  assert.equal(status.current_state, "impact-review");
});

test("a story-bound workflow must pin the exact configured custom phase order", () => {
  const project = temporaryProject("custom-phases");
  mustRun(["init", "--root", project, "--project-name", "Custom phases"], project);
  const configPath = path.join(project, ".sdlc", "config.json");
  const config = readJson(configPath);
  const customPhase = "dependency-audit";
  config.phases[customPhase] = {
    ...config.phases.design,
    purpose: "Review cross-package dependencies before implementation.",
  };
  config.phase_order = [
    "discovery",
    "analysis",
    "design",
    customPhase,
    "implementation",
    "validation",
    "release",
    "operations",
  ];
  config.autonomy_policy.presets.checkpointed.automatic_phases = [
    ...config.autonomy_policy.presets.checkpointed.automatic_phases,
    customPhase,
  ];
  writeJson(configPath, config);
  pinProjectConfig(project);

  mustRunJson([
    "story", "create",
    "--root", project,
    "--id", "ST-CUSTOM-PHASE",
    "--title", "Exercise a custom workflow phase",
    "--acceptance", "The configured workflow order is enforced.",
  ], project);

  const base = mustRunJson([
    "workflow", "definition", "show",
    "--root", project,
    "--id", "software-project",
    "--definition-version", "3",
  ], project).definition;
  const transitions = base.transitions.flatMap((transition) => {
    if (transition.from !== "design" || transition.to !== "implementation") return [transition];
    return [
      {
        ...transition,
        id: "design-to-custom-phase",
        to: customPhase,
        label: "Design to custom phase",
        guards: [],
      },
      {
        ...transition,
        id: "custom-phase-to-implementation",
        from: customPhase,
        label: "Custom phase to implementation",
      },
    ];
  });
  const customDefinition = {
    label: "Software project with dependency audit",
    description: "The configured project lifecycle with one custom phase.",
    initial_state: base.initial_state,
    states: [
      ...base.states.filter((state) => state.id !== "implementation"),
      {
        id: customPhase,
        label: "Dependency audit",
        terminal: false,
        metadata: { order: 4 },
      },
      ...base.states
        .filter((state) => state.id === "implementation")
        .map((state) => ({ ...state, metadata: { ...state.metadata, order: 5 } })),
    ].sort((left, right) => config.phase_order.indexOf(left.id) - config.phase_order.indexOf(right.id)),
    transitions,
    phase_order: config.phase_order,
    normal_checkpoints: base.normal_checkpoints,
    metadata: {
      governance_binding: "story",
      canonical_evidence_schema: "workflow-canonical-evidence:v2",
    },
  };
  mustRunJson([
    "workflow", "definition", "propose",
    "--root", project,
    "--id", "custom-software-project",
    "--definition-version", "1",
    "--definition-json", JSON.stringify(customDefinition),
  ], project);
  mustRunJson([
    "workflow", "definition", "approve",
    "--root", project,
    "--id", "custom-software-project",
    "--definition-version", "1",
    "--actor-type", "ci",
    "--approval-source", "ci",
    "--summary", "Approve the exact configured custom lifecycle.",
  ], project);

  const started = mustRunJson([
    "workflow", "instance", "start",
    "--root", project,
    "--id", "WF-CUSTOM-PHASE",
    "--definition", "custom-software-project",
    "--definition-version", "1",
    "--story", "ST-CUSTOM-PHASE",
  ], project);
  assert.deepEqual(started.instance.phase_order, undefined);
  const definition = readJson(path.join(
    project,
    ".sdlc",
    "workflows",
    "definitions",
    "custom-software-project",
    "v1.json",
  ));
  assert.deepEqual(definition.phase_order, config.phase_order);

  const mismatched = run([
    "workflow", "instance", "start",
    "--root", project,
    "--id", "WF-MISSING-CUSTOM-PHASE",
    "--definition", "software-project",
    "--definition-version", "3",
    "--story", "ST-CUSTOM-PHASE",
    "--json",
  ], project);
  assert.notEqual(mismatched.status, 0);
  assert.match(mismatched.stderr, /configured phase order|dependency-audit/u);
  assert.equal(
    fs.existsSync(path.join(project, ".sdlc", "workflows", "instances", "WF-MISSING-CUSTOM-PHASE")),
    false,
  );
});
