import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { computeStableHash } from "../lib/canonical.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPOSITORY_ROOT, "bin", "agentic-sdlc.mjs");
const TEMPORARY_PROJECTS = new Set();

after(() => {
  if (process.env.AGENTIC_SDLC_KEEP_TEST_TMP === "1") return;
  for (const project of TEMPORARY_PROJECTS) {
    fs.rmSync(project, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
  TEMPORARY_PROJECTS.clear();
});

function temporaryProject(label) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), `agentic-sdlc-finalization-${label}-`));
  TEMPORARY_PROJECTS.add(project);
  return project;
}

function hostSupportsLocalSmokeSandbox() {
  if (process.platform === "darwin") return fs.existsSync("/usr/bin/sandbox-exec");
  if (process.platform === "linux") return fs.existsSync("/usr/bin/bwrap");
  return false;
}

function cloneTemporaryProject(source, label) {
  const project = temporaryProject(label);
  fs.cpSync(source, project, {
    recursive: true,
    force: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
  return project;
}

function run(args, project, options = {}) {
  const env = { ...process.env };
  for (const key of ["CI", "GITHUB_ACTIONS", "GITHUB_ACTOR", "CODEX_AGENT_NAME", "CODEX_USER_ID"]) {
    delete env[key];
  }
  Object.assign(env, options.env || {});
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: project,
    encoding: "utf8",
    env,
    timeout: options.timeout || 60_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function runConcurrently(args, project, envOverrides = {}) {
  const env = { ...process.env, ...envOverrides };
  for (const key of ["CI", "GITHUB_ACTIONS", "GITHUB_ACTOR", "CODEX_AGENT_NAME", "CODEX_USER_ID"]) {
    delete env[key];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: project,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status, signal) => {
      clearTimeout(timeout);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

async function waitForTextFile(
  filePath,
  expectedContents,
  { timeoutMs = 20_000, intervalMs = 25 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let observedContents = null;
  while (Date.now() < deadline) {
    try {
      observedContents = fs.readFileSync(filePath, "utf8");
      if (observedContents === expectedContents) return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  assert.fail(
    `Timed out waiting for ${filePath}; expected `
    + `${JSON.stringify(expectedContents)}, observed ${JSON.stringify(observedContents)}`,
  );
}

function mustRun(args, project, options = {}) {
  const result = run(args, project, options);
  assert.equal(result.error, undefined, `${args.join(" ")} failed to execute: ${result.error?.message}`);
  assert.equal(result.signal, null, `${args.join(" ")} terminated by ${result.signal}`);
  assert.equal(
    result.status,
    0,
    `${args.join(" ")}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
  );
  return result;
}

function mustRunJson(args, project, options = {}) {
  return JSON.parse(mustRun([...args, "--json"], project, options).stdout);
}

function mustFail(args, project, pattern, options = {}) {
  const result = run(args, project, options);
  assert.equal(result.error, undefined, `${args.join(" ")} failed to execute: ${result.error?.message}`);
  assert.equal(result.signal, null, `${args.join(" ")} terminated by ${result.signal}`);
  assert.notEqual(result.status, 0, `${args.join(" ")} unexpectedly passed\n${result.stdout}`);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    pattern,
    `${args.join(" ")}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
  );
  return result;
}

function mustGit(project, args) {
  const result = spawnSync("git", ["-C", project, ...args], {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.error, undefined, `git ${args.join(" ")} failed: ${result.error?.message}`);
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
  );
  return result.stdout.trim();
}

function writeProjectFile(project, relativePath, contents) {
  const filePath = path.join(project, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
  return relativePath;
}

function readJson(project, relativePath) {
  return JSON.parse(fs.readFileSync(path.join(project, relativePath), "utf8"));
}

function humanApproval(summary) {
  return [
    "--actor-type", "human",
    "--approval-source", "explicit-user",
    "--summary", summary,
  ];
}

function assertReleaseStrictGateBlocked({
  project,
  workflowInstanceId,
  requestId,
  issuePattern,
  transitionPattern = issuePattern,
}) {
  const projectStatus = mustRunJson([
    "status", "--root", project,
  ], project);
  assert.equal(
    projectStatus.next_action.kind,
    "repair_strict_gate_evidence",
  );
  assert.equal(projectStatus.next_action.diagnostic, true);
  assert.match(
    projectStatus.next_action.strict_gate_issues.join("\n"),
    issuePattern,
  );

  const workflowStatus = mustRunJson([
    "workflow", "instance", "status",
    "--root", project,
    "--id", workflowInstanceId,
  ], project);
  assert.equal(workflowStatus.status, "blocked");
  assert.deepEqual(workflowStatus.ready_next_states, []);
  const releaseCheck = workflowStatus.next_transition_checks.find((check) =>
    check.to === "release");
  assert.equal(releaseCheck.allowed, false);
  const strictGuard = releaseCheck.guard_results.find((result) =>
    result.guard_id === "strict-gate-passed");
  assert.equal(strictGuard.allowed, false);
  assert.match(strictGuard.issues.join("\n"), issuePattern);

  mustFail([
    "workflow", "instance", "transition",
    "--root", project,
    "--id", workflowInstanceId,
    "--to", "release",
    "--request-id", requestId,
    "--actor", "workflow-e2e-ci",
    "--actor-type", "ci",
    "--actor-name", "Workflow E2E CI",
  ], project, transitionPattern);
}

function implementationIntent(storyId) {
  return JSON.stringify({
    requested_action: "implement_story",
    confidence: 0.99,
    referenced_entities: [{ type: "story", id: storyId }],
    provided_artifacts: [],
    missing_context: [],
    proposed_phase: "implementation",
    artifact_type: null,
    skip_phases: [],
  });
}

function customGovernedWorkflowDefinition(customPhase) {
  const phases = [
    "discovery",
    "analysis",
    "design",
    customPhase,
    "implementation",
    "validation",
    "release",
    "operations",
  ];
  const transition = (from, to, guards = []) => ({
    id: `${from}-to-${to}`,
    from,
    to,
    guards: guards.map((id) => ({ id, parameters: {} })),
  });
  return {
    label: "Custom governed software project",
    description: "Exercise every configured project phase with canonical delivery checks.",
    initial_state: phases[0],
    phase_order: phases,
    states: phases.map((id, index) => ({
      id,
      label: id,
      terminal: index === phases.length - 1,
    })),
    transitions: [
      transition("discovery", "analysis", ["requirement-approved"]),
      transition("analysis", "design"),
      transition("design", customPhase, ["contract-approved"]),
      transition(customPhase, "implementation"),
      transition("implementation", "validation", ["required-output-linked"]),
      transition("validation", "release", ["strict-gate-passed"]),
      transition("release", "operations"),
    ],
    normal_checkpoints: [],
    metadata: {
      governance_binding: "story",
      canonical_evidence_schema: "workflow-canonical-evidence:v2",
    },
  };
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

function configureCustomPhase(project, customPhase) {
  const configPath = path.join(project, ".sdlc", "config.json");
  const config = readJson(project, ".sdlc/config.json");
  config.phases[customPhase] = {
    ...config.phases.design,
    purpose: "Review package boundaries before implementation.",
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
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  pinProjectConfig(project);
}

function initializeGitProject(project, branch, configureProject = null) {
  mustRun(["init", "--root", project, "--project-name", "Finalization regression"], project);
  configureProject?.(project);
  mustGit(project, ["init"]);
  mustGit(project, ["config", "user.name", "Finalization E2E"]);
  mustGit(project, ["config", "user.email", "finalization-e2e@example.invalid"]);
  writeProjectFile(project, "src/index.mjs", "export const ready = true;\n");
  writeProjectFile(
    project,
    "docs/untouched-runtime.md",
    "# Untouched runtime input\n",
  );
  writeProjectFile(
    project,
    "docs/tracked-runtime.md",
    "# Tracked runtime input\n",
  );
  writeProjectFile(
    project,
    "docs/deleted-runtime.md",
    "# Runtime input deleted by the governed implementation\n",
  );
  writeProjectFile(
    project,
    ".gitignore",
    "docs/local-release/sibling-*\n",
  );
  mustGit(project, ["add", "."]);
  mustGit(project, ["commit", "-m", "test: establish governed baseline"]);
  mustGit(project, ["branch", "-M", "main"]);
  mustGit(project, ["remote", "add", "origin", "https://github.com/aantenore/agentic-sdlc.git"]);
  mustGit(project, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  mustGit(project, ["checkout", "-b", branch]);
}

function createGovernedDeliveryStory(project, {
  suffix,
  allowedWritePaths,
  outputType = "implementation-summary",
  outputPhase = null,
  additionalOutputRefs = [],
  additionalRequirementWritePaths = [],
  configureProject = null,
  deliveryKind = "pull_request",
  storyActionUses = 1,
  beforeTaskStart = null,
}) {
  const requirementId = `REQ-${suffix}`;
  const storyId = `ST-${suffix}`;
  const contractId = `CONTRACT-${suffix}`;
  const profileId = `AUT-${suffix}`;
  const branch = `codex/${storyId}`;
  initializeGitProject(project, branch, configureProject);

  const requirementScopes = [
    { id: requirementId, writePaths: allowedWritePaths },
    ...additionalRequirementWritePaths.map((writePaths, index) => ({
      id: `${requirementId}-${index + 2}`,
      writePaths,
    })),
  ];
  for (const requirementScope of requirementScopes) {
    mustRun([
      "requirement", "propose",
      "--root", project,
      "--id", requirementScope.id,
      "--title", `Govern ${suffix} ${requirementScope.id}`,
      "--summary", `Implement ${suffix} only inside its exact approved write scope.`,
      "--acceptance", `The ${suffix} story has verified implementation and delivery evidence.`,
      "--autonomy-ceiling", "supervised",
      ...requirementScope.writePaths.flatMap((writePath) => ["--write-path", writePath]),
    ], project);
    mustRun([
      "requirement", "approve",
      "--root", project,
      "--id", requirementScope.id,
      ...humanApproval(`Approve ${requirementScope.id}`),
    ], project);
  }

  const outputRefs = [
    ...(outputType ? [{ type: outputType, phase: outputPhase }] : []),
    ...additionalOutputRefs,
  ];
  for (const outputRef of outputRefs) {
    mustRun([
      "output", "template", "propose",
      "--root", project,
      "--type", outputRef.type,
      "--summary", `Canonical ${outputRef.type} format`,
    ], project);
    mustRun([
      "output", "template", "approve",
      "--root", project,
      "--id", `${outputRef.type}-v1`,
      ...humanApproval(`Approve ${outputRef.type} output format`),
    ], project);
  }

  mustRun([
    "story", "create",
    "--root", project,
    "--id", storyId,
    "--title", `Implement ${suffix}`,
    "--phase", "implementation",
    "--status", "ready",
    ...requirementScopes.flatMap((scope) => ["--requirement", scope.id]),
    "--acceptance", `Observable evidence exists for ${suffix}.`,
  ], project);

  mustRun([
    "contract", "create",
    "--root", project,
    "--id", contractId,
    "--story", storyId,
    "--phase", "implementation",
    "--delivery-profile", profileId,
    "--level", "supervised",
    "--context-summary", `Implement ${storyId} inside the approved requirement boundary.`,
    "--qa", "Who confirms the exact delivery?|The human reviewer",
    "--tool", "node",
    ...outputRefs.flatMap((outputRef) => [
      "--output-ref",
      `${outputRef.type}:${outputRef.type}-v1:new${outputRef.phase ? `:${outputRef.phase}` : ""}`,
    ]),
  ], project);
  mustRun([
    "contract", "approve",
    "--root", project,
    "--id", contractId,
    ...humanApproval(`Approve ${contractId}`),
  ], project);

  const localReleaseRoot = path.join(project, "docs", "local-release");
  const localReleaseOutput = path.join(localReleaseRoot, "app");
  const deliveryTargetArgs = deliveryKind === "local_release"
    ? [
        "--target-root", localReleaseRoot,
        "--write-path", localReleaseOutput,
        "--smoke-test", '["node","--version"]',
        "--rollback", "Restore the previous governed local release snapshot.",
      ]
    : [
        "--repository", "aantenore/agentic-sdlc",
        "--base", "main",
        "--head", branch,
      ];
  const deliveryActionArgs = deliveryKind === "local_release"
    ? []
    : [
        "--allow-action", "repository.read",
        "--allow-action", "repository.write",
        "--allow-action", "test.run",
      ];
  mustRun([
    "autonomy", "delivery", "propose",
    "--root", project,
    "--id", profileId,
    "--delivery", deliveryKind === "local_release" ? `LOCAL-${suffix}` : `PR-${suffix}`,
    "--kind", deliveryKind,
    "--story", storyId,
    "--contract", contractId,
    ...requirementScopes.flatMap((scope) => ["--requirement", scope.id]),
    "--level", "supervised",
    ...deliveryTargetArgs,
    ...(deliveryKind === "pull_request"
      ? allowedWritePaths.flatMap((writePath) => ["--write-path", writePath])
      : []),
    ...deliveryActionArgs,
  ], project);
  mustRun([
    "autonomy", "delivery", "approve",
    "--root", project,
    "--id", profileId,
    "--phase", "implementation",
    ...humanApproval(`Approve ${profileId}`),
  ], project);
  beforeTaskStart?.({
    project,
    requirementId,
    requirementIds: requirementScopes.map((scope) => scope.id),
    storyId,
    contractId,
    profileId,
  });
  const taskStart = mustRunJson([
    "task", "start",
    "--root", project,
    "--intent-json", implementationIntent(storyId),
    "--story", storyId,
    "--phase", "implementation",
    "--contract-id", contractId,
    "--delivery-profile", profileId,
    "--confirm-start",
    "--actor-type", "human",
  ], project);
  assert.equal(
    taskStart.execution_allowed,
    true,
    `task start should be executable: ${JSON.stringify(taskStart, null, 2)}`,
  );
  const storyActionAuthorizationId = `AUTH-${suffix}-STORY-ACTIONS`;
  mustRun([
    "authorization", "grant",
    "--root", project,
    "--id", storyActionAuthorizationId,
    "--scope", `Approve the exact governed story actions for ${storyId}.`,
    "--allow-use", `story.claim=${storyId}`,
    "--allow-use", `output.link=${storyId}`,
    "--allow-use", `story.complete-step=${storyId}`,
    ...outputRefs.flatMap((outputRef) => ["--allow-artifact-type", outputRef.type]),
    "--max-uses", String(storyActionUses),
    ...humanApproval(`Approve the exact governed story actions for ${storyId}`),
  ], project);
  mustRun([
    "story", "claim",
    "--root", project,
    "--id", storyId,
    "--agent", "codex",
    "--branch", branch,
    "--authorization", storyActionAuthorizationId,
  ], project);

  return {
    requirementId,
    storyId,
    contractId,
    profileId,
    branch,
    taskStart,
    storyActionAuthorizationId,
    deliveryKind,
    localReleaseRoot,
    localReleaseOutput,
  };
}

function prepareGovernedDeliveryStoryBeforeTaskStart(project, {
  suffix,
  allowedWritePaths = ["docs"],
}) {
  let context;
  assert.throws(
    () => createGovernedDeliveryStory(project, {
      suffix,
      allowedWritePaths,
      beforeTaskStart: (prepared) => {
        context = prepared;
        throw new Error(`prepared-before-task-start:${suffix}`);
      },
    }),
    new RegExp(`prepared-before-task-start:${suffix}`, "u"),
  );
  assert.ok(context);
  return context;
}

function createLegacyStrictStory(project, suffix) {
  const requirementId = `REQ-${suffix}`;
  const storyId = `ST-${suffix}`;
  const contractId = `CONTRACT-${suffix}`;
  mustRun(["init", "--root", project, "--project-name", "Latest trace regression"], project);
  writeProjectFile(
    project,
    `.sdlc/requirements/${requirementId}.json`,
    `${JSON.stringify({
      id: requirementId,
      kind: "requirement",
      schema_version: "requirement:v1",
      title: `Requirement ${suffix}`,
      summary: `Canonical trace precedence requirement for ${suffix}`,
      status: "active",
      acceptance_criteria: ["The latest test and release outcomes govern completion."],
      source_paths: [],
      proposal_ref: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      audit: { fixture: true },
    }, null, 2)}\n`,
  );
  mustRun([
    "story", "create",
    "--root", project,
    "--id", storyId,
    "--title", `Trace precedence ${suffix}`,
    "--requirement", requirementId,
    "--acceptance", "Only the latest test and release attempts govern readiness.",
  ], project);
  mustRun([
    "output", "template", "propose",
    "--root", project,
    "--type", "validation-report",
    "--summary", "Canonical validation evidence format",
  ], project);
  mustRun([
    "output", "template", "approve",
    "--root", project,
    "--id", "validation-report-v1",
    ...humanApproval("Approve validation evidence format"),
  ], project);
  mustRun([
    "contract", "create",
    "--root", project,
    "--id", contractId,
    "--story", storyId,
    "--phase", "design",
    "--context-summary", "Verify latest-attempt precedence without changing the agreed scope.",
    "--qa", "Which attempt governs?|The latest recorded attempt",
    "--output-ref", "validation-report:validation-report-v1:new",
  ], project);
  mustRun([
    "contract", "approve",
    "--root", project,
    "--id", contractId,
    ...humanApproval(`Approve ${contractId}`),
  ], project);
  const taskStart = mustRunJson([
    "task", "start",
    "--root", project,
    "--story", storyId,
    "--phase", "design",
    "--contract-id", contractId,
    "--intent-json", implementationIntent(storyId),
    "--confirm-start",
    "--actor-type", "human",
  ], project);
  assert.equal(taskStart.execution_allowed, true);
  mustRun([
    "story", "claim",
    "--root", project,
    "--id", storyId,
    "--agent", "codex",
  ], project);
  return { storyId };
}

function appendTrace(project, storyId, type, outcome, evidence) {
  mustRun([
    "trace", "append",
    "--root", project,
    "--story", storyId,
    "--type", type,
    "--outcome", outcome,
    "--summary", `${type} attempt ${outcome}`,
    "--evidence", evidence,
    "--actor", "codex",
    "--actor-type", "agent",
  ], project);
}

test("task start rejects workflows already transitioned or stories already completed", () => {
  const startGovernedWorkflow = (project, storyId, definitionId, instanceId) => {
    const boundaryDefinition =
      customGovernedWorkflowDefinition("package-boundary-check");
    boundaryDefinition.transitions = boundaryDefinition.transitions
      .map((transition) => ({ ...transition, guards: [] }));
    boundaryDefinition.metadata = { governance_binding: "story" };
    mustRun([
      "workflow", "definition", "propose",
      "--root", project,
      "--id", definitionId,
      "--definition-version", "1",
      "--definition-json", JSON.stringify(boundaryDefinition),
    ], project);
    mustRun([
      "workflow", "definition", "approve",
      "--root", project,
      "--id", definitionId,
      "--definition-version", "1",
      ...humanApproval(`Approve ${definitionId}`),
    ], project);
    mustRun([
      "workflow", "instance", "start",
      "--root", project,
      "--id", instanceId,
      "--definition", definitionId,
      "--definition-version", "1",
      "--story", storyId,
      "--actor", "workflow-e2e-ci",
      "--actor-type", "ci",
    ], project);
  };

  const transitionedProject = temporaryProject("task-start-after-transition");
  assert.throws(
    () => createGovernedDeliveryStory(transitionedProject, {
      suffix: "START-AFTER-TRANSITION",
      allowedWritePaths: ["docs"],
      configureProject: (target) => configureCustomPhase(target, "package-boundary-check"),
      beforeTaskStart: ({ storyId }) => {
        startGovernedWorkflow(
          transitionedProject,
          storyId,
          "workflow-before-transition-boundary",
          "delivery-before-transition-boundary",
        );
        mustRun([
          "workflow", "instance", "transition",
          "--root", transitionedProject,
          "--id", "delivery-before-transition-boundary",
          "--to", "analysis",
          "--request-id", "transition-before-task-start",
          "--actor", "workflow-e2e-ci",
          "--actor-type", "ci",
        ], transitionedProject);
      },
    }),
    /already has 1 transition event|before the first workflow transition/u,
  );
  assert.equal(
    fs.existsSync(path.join(
      transitionedProject,
      ".sdlc/stories/ST-START-AFTER-TRANSITION/task-start.json",
    )),
    false,
  );

  const completedProject = temporaryProject("task-start-after-completion");
  assert.throws(
    () => createGovernedDeliveryStory(completedProject, {
      suffix: "START-AFTER-COMPLETION",
      allowedWritePaths: ["docs"],
      configureProject: (target) => configureCustomPhase(target, "package-boundary-check"),
      beforeTaskStart: ({ storyId }) => {
        startGovernedWorkflow(
          completedProject,
          storyId,
          "workflow-before-completion-boundary",
          "delivery-before-completion-boundary",
        );
        writeProjectFile(
          completedProject,
          `.sdlc/stories/${storyId}/steps/discovery.json`,
          `${JSON.stringify({
            id: `STEP-${storyId}-discovery`,
            story_id: storyId,
            step: "discovery",
            status: "completed",
            phase: "discovery",
            completed_at: new Date().toISOString(),
          }, null, 2)}\n`,
        );
      },
    }),
    /already has completed lifecycle steps|before the first completed story step/u,
  );
  assert.equal(
    fs.existsSync(path.join(
      completedProject,
      ".sdlc/stories/ST-START-AFTER-COMPLETION/task-start.json",
    )),
    false,
  );
});

test("a canonical story workflow cannot leave the current phase before its story step is completed", () => {
  const project = temporaryProject("workflow-phase-completion");
  const workflowInstanceId = "delivery-phase-completion";
  const fixture = createGovernedDeliveryStory(project, {
    suffix: "WORKFLOW-PHASE-COMPLETION",
    allowedWritePaths: ["docs"],
    storyActionUses: 3,
    beforeTaskStart: ({ storyId }) => {
      mustRun([
        "workflow", "instance", "start",
        "--root", project,
        "--id", workflowInstanceId,
        "--definition", "software-project",
        "--definition-version", "3",
        "--story", storyId,
        "--actor", "workflow-e2e-ci",
        "--actor-type", "ci",
      ], project);
    },
  });

  const blocked = mustFail([
    "workflow", "instance", "transition",
    "--root", project,
    "--id", workflowInstanceId,
    "--to", "analysis",
    "--request-id", "phase-completion-analysis-blocked",
    "--actor", "workflow-e2e-ci",
    "--actor-type", "ci",
    "--json",
  ], project, /cannot leave phase 'discovery'.*canonical story step/u);
  assert.equal(blocked.stdout, "");

  const beforeCompletion = mustRunJson([
    "workflow", "instance", "status",
    "--root", project,
    "--id", workflowInstanceId,
  ], project);
  assert.equal(beforeCompletion.current_state, "discovery");
  assert.equal(beforeCompletion.event_count, 0);
  assert.deepEqual(beforeCompletion.ready_next_states, []);
  assert.equal(beforeCompletion.current_phase_completion.ready, false);
  assert.match(
    beforeCompletion.current_phase_completion.issues.join("\n"),
    /no completed canonical story step/u,
  );

  mustRun([
    "story", "complete-step",
    "--root", project,
    "--id", fixture.storyId,
    "--step", "discovery",
    "--summary", "Discovery completed before the workflow leaves the phase.",
    "--authorization", fixture.storyActionAuthorizationId,
  ], project);

  const discoveryStepPath =
    `.sdlc/stories/${fixture.storyId}/steps/discovery.json`;
  const discoveryStep = readJson(project, discoveryStepPath);
  const completionEvents = fs.readFileSync(
    path.join(project, `.sdlc/traces/${fixture.storyId}.jsonl`),
    "utf8",
  )
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line))
    .filter((event) =>
      event.action === "story.complete-step"
      && event.related?.includes("discovery"));
  assert.equal(completionEvents.length, 1);
  assert.equal(
    completionEvents[0].story_step_ref?.schema_version,
    "story-step-completion-ref:v1",
  );

  writeProjectFile(
    project,
    discoveryStepPath,
    `${JSON.stringify({
      ...discoveryStep,
      summary: "A well-formed but manually forged completion record.",
    }, null, 2)}\n`,
  );
  const forgedStatus = mustRunJson([
    "workflow", "instance", "status",
    "--root", project,
    "--id", workflowInstanceId,
  ], project);
  assert.equal(forgedStatus.current_phase_completion.ready, false);
  assert.match(
    forgedStatus.current_phase_completion.issues.join("\n"),
    /does not match its sealed completion attestation/u,
  );
  mustFail([
    "workflow", "instance", "transition",
    "--root", project,
    "--id", workflowInstanceId,
    "--to", "analysis",
    "--request-id", "phase-completion-analysis-forged",
    "--actor", "workflow-e2e-ci",
    "--actor-type", "ci",
  ], project, /does not match its sealed completion attestation/u);
  writeProjectFile(
    project,
    discoveryStepPath,
    `${JSON.stringify(discoveryStep, null, 2)}\n`,
  );

  writeProjectFile(
    project,
    discoveryStepPath,
    `${JSON.stringify({
      ...discoveryStep,
      completed_at: new Date(
        Date.parse(beforeCompletion.current_phase_completion.entered_at) - 1,
      ).toISOString(),
    }, null, 2)}\n`,
  );
  mustFail([
    "workflow", "instance", "transition",
    "--root", project,
    "--id", workflowInstanceId,
    "--to", "analysis",
    "--request-id", "phase-completion-analysis-stale",
    "--actor", "workflow-e2e-ci",
    "--actor-type", "ci",
  ], project, /completed before the workflow entered that phase/u);
  writeProjectFile(
    project,
    discoveryStepPath,
    `${JSON.stringify(discoveryStep, null, 2)}\n`,
  );

  const transitioned = mustRunJson([
    "workflow", "instance", "transition",
    "--root", project,
    "--id", workflowInstanceId,
    "--to", "analysis",
    "--request-id", "phase-completion-analysis",
    "--actor", "workflow-e2e-ci",
    "--actor-type", "ci",
  ], project);
  assert.equal(transitioned.current_state, "analysis");
  assert.equal(transitioned.event.sequence, 1);

  const retried = mustRunJson([
    "workflow", "instance", "transition",
    "--root", project,
    "--id", workflowInstanceId,
    "--to", "analysis",
    "--request-id", "phase-completion-analysis",
  ], project);
  assert.equal(retried.status, "unchanged");
  assert.equal(retried.event.event_hash, transitioned.event.event_hash);

  const analysisStatus = mustRunJson([
    "workflow", "instance", "status",
    "--root", project,
    "--id", workflowInstanceId,
  ], project);
  assert.equal(analysisStatus.current_state, "analysis");
  assert.deepEqual(analysisStatus.ready_next_states, []);
  assert.equal(analysisStatus.next_transition_checks[0].canonical, false);
  assert.equal(analysisStatus.next_transition_checks[0].allowed, false);
  assert.equal(analysisStatus.current_phase_completion.ready, false);

  mustRun([
    "story", "complete-step",
    "--root", project,
    "--id", fixture.storyId,
    "--step", "functional-analysis",
    "--summary", "The supported legacy alias completes the canonical analysis phase.",
    "--authorization", fixture.storyActionAuthorizationId,
  ], project);
  const aliasTransition = mustRunJson([
    "workflow", "instance", "transition",
    "--root", project,
    "--id", workflowInstanceId,
    "--to", "design",
    "--request-id", "phase-completion-design-from-alias",
    "--actor", "workflow-e2e-ci",
    "--actor-type", "ci",
  ], project);
  assert.equal(aliasTransition.current_state, "design");
  assert.equal(aliasTransition.event.sequence, 2);
});

test("pre-task workflow binding tamper remains fail-closed across status, scheduling, claims, and task start", () => {
  const project = temporaryProject("pre-task-binding-tamper");
  const workflowInstanceId = "delivery-pre-task-binding-tamper";
  const storyId = "ST-PRE-TASK-BINDING-TAMPER";
  const taskStartPath = `.sdlc/stories/${storyId}/task-start.json`;
  const claimPath = `.sdlc/stories/${storyId}/claim.json`;
  const tracePath = path.join(project, `.sdlc/traces/${storyId}.jsonl`);
  let storyContext;
  let currentInstancePath;
  let currentInstance;
  let traceBeforeTamperChecks;

  assert.throws(
    () => createGovernedDeliveryStory(project, {
      suffix: "PRE-TASK-BINDING-TAMPER",
      allowedWritePaths: ["docs"],
      beforeTaskStart: ({ contractId, profileId }) => {
        storyContext = { contractId, profileId };
        mustRun([
          "workflow", "instance", "start",
          "--root", project,
          "--id", workflowInstanceId,
          "--definition", "software-project",
          "--definition-version", "3",
          "--story", storyId,
          "--actor", "workflow-e2e-ci",
          "--actor-type", "ci",
        ], project);
        assert.equal(fs.existsSync(path.join(project, taskStartPath)), false);
        assert.equal(fs.existsSync(path.join(project, claimPath)), false);

        currentInstancePath =
          `.sdlc/workflows/instances/${workflowInstanceId}/instance.json`;
        currentInstance = readJson(project, currentInstancePath);
        const mismatchedStoryBinding = structuredClone(currentInstance);
        mismatchedStoryBinding.metadata.governance_binding.story_id = "ST-OTHER";
        writeProjectFile(
          project,
          currentInstancePath,
          `${JSON.stringify(mismatchedStoryBinding, null, 2)}\n`,
        );
        traceBeforeTamperChecks = fs.existsSync(tracePath)
          ? fs.readFileSync(tracePath, "utf8")
          : null;

        const status = mustRunJson([
          "status", "--root", project, "--full",
        ], project);
        assert.equal(status.summary.available_work, 0);
        assert.ok(status.summary.blocked_work >= 1);
        const statusStory = status.orchestration.stories
          .find((story) => story.id === storyId);
        assert.equal(statusStory.orchestration_state, "blocked");
        assert.equal(statusStory.lifecycle_source, "invalid_story_workflow");

        const orchestration = mustRunJson([
          "orchestrate", "status", "--root", project,
        ], project);
        const orchestratedStory = orchestration.stories
          .find((story) => story.id === storyId);
        assert.equal(orchestratedStory.orchestration_state, "blocked");
        assert.equal(orchestratedStory.lifecycle_source, "invalid_story_workflow");

        const plan = mustRunJson([
          "orchestrate", "plan", "--root", project,
        ], project);
        assert.equal(
          plan.candidates.some((candidate) => candidate.story_id === storyId),
          false,
        );
        mustFail([
          "story", "claim",
          "--root", project,
          "--id", storyId,
          "--agent", "pre-task-tamper-agent",
        ], project, /invalid or unreadable final lifecycle receipt/u);
        mustFail([
          "story", "claim",
          "--root", project,
          "--id", storyId,
          "--agent", "pre-task-tamper-agent",
          "--force",
          "--actor-type", "human",
        ], project, /invalid or unreadable final lifecycle receipt/u);
        assert.equal(fs.existsSync(path.join(project, claimPath)), false);
        assert.equal(fs.existsSync(path.join(project, taskStartPath)), false);
        assert.equal(
          fs.existsSync(tracePath) ? fs.readFileSync(tracePath, "utf8") : null,
          traceBeforeTamperChecks,
        );
      },
    }),
    /Cannot bind task start to the current story workflow:.*(?:workflow start trace no longer matches its immutable story binding|has a mismatched explicit story binding)/su,
  );

  assert.equal(fs.existsSync(path.join(project, taskStartPath)), false);
  assert.equal(fs.existsSync(path.join(project, claimPath)), false);
  assert.equal(
    fs.existsSync(tracePath) ? fs.readFileSync(tracePath, "utf8") : null,
    traceBeforeTamperChecks,
  );
  writeProjectFile(
    project,
    currentInstancePath,
    `${JSON.stringify(currentInstance, null, 2)}\n`,
  );
  const restoredStatus = mustRunJson([
    "status", "--root", project, "--full",
  ], project);
  assert.equal(restoredStatus.next_action.kind, "start_available_work");
  assert.equal(
    restoredStatus.orchestration.stories
      .find((story) => story.id === storyId)
      .orchestration_state,
    "available",
  );

  const healthyTaskStart = mustRunJson([
    "task", "start",
    "--root", project,
    "--intent-json", implementationIntent(storyId),
    "--story", storyId,
    "--phase", "implementation",
    "--contract-id", storyContext.contractId,
    "--delivery-profile", storyContext.profileId,
    "--confirm-start",
    "--actor-type", "human",
  ], project);
  assert.equal(healthyTaskStart.execution_allowed, true);
  assert.equal(fs.existsSync(path.join(project, taskStartPath)), true);
});

test("pre-task multi-run binding tamper cannot fall back to an older workflow", () => {
  const project = temporaryProject("pre-task-multi-run-binding-tamper");
  const storyId = "ST-PRE-TASK-MULTI-RUN-TAMPER";
  const olderWorkflowId = "delivery-pre-task-multi-run-older";
  const latestWorkflowId = "delivery-pre-task-multi-run-latest";
  const taskStartPath = `.sdlc/stories/${storyId}/task-start.json`;
  const claimPath = `.sdlc/stories/${storyId}/claim.json`;
  const tracePath = path.join(project, `.sdlc/traces/${storyId}.jsonl`);
  let storyContext;
  let latestInstancePath;
  let latestInstance;
  let traceBeforeTamperChecks;

  assert.throws(
    () => createGovernedDeliveryStory(project, {
      suffix: "PRE-TASK-MULTI-RUN-TAMPER",
      allowedWritePaths: ["docs"],
      beforeTaskStart: ({ contractId, profileId }) => {
        storyContext = { contractId, profileId };
        for (const workflowId of [olderWorkflowId, latestWorkflowId]) {
          mustRun([
            "workflow", "instance", "start",
            "--root", project,
            "--id", workflowId,
            "--definition", "software-project",
            "--definition-version", "3",
            "--story", storyId,
            "--actor", "workflow-e2e-ci",
            "--actor-type", "ci",
          ], project);
        }
        const olderInstancePath =
          `.sdlc/workflows/instances/${olderWorkflowId}/instance.json`;
        latestInstancePath =
          `.sdlc/workflows/instances/${latestWorkflowId}/instance.json`;
        const olderInstance = readJson(project, olderInstancePath);
        latestInstance = readJson(project, latestInstancePath);
        assert.ok(
          Date.parse(olderInstance.created_at) < Date.parse(latestInstance.created_at),
        );
        assert.equal(fs.existsSync(path.join(project, taskStartPath)), false);
        assert.equal(fs.existsSync(path.join(project, claimPath)), false);

        const mismatchedLatestBinding = structuredClone(latestInstance);
        mismatchedLatestBinding.metadata.governance_binding.story_id = "ST-OTHER";
        writeProjectFile(
          project,
          latestInstancePath,
          `${JSON.stringify(mismatchedLatestBinding, null, 2)}\n`,
        );
        traceBeforeTamperChecks = fs.existsSync(tracePath)
          ? fs.readFileSync(tracePath, "utf8")
          : null;

        const status = mustRunJson([
          "status", "--root", project, "--full",
        ], project);
        assert.equal(status.summary.available_work, 0);
        assert.ok(status.summary.blocked_work >= 1);
        const statusStory = status.orchestration.stories
          .find((story) => story.id === storyId);
        assert.equal(statusStory.orchestration_state, "blocked");
        assert.equal(statusStory.lifecycle_source, "invalid_story_workflow");

        const orchestration = mustRunJson([
          "orchestrate", "status", "--root", project,
        ], project);
        const orchestratedStory = orchestration.stories
          .find((story) => story.id === storyId);
        assert.equal(orchestratedStory.orchestration_state, "blocked");
        assert.equal(orchestratedStory.lifecycle_source, "invalid_story_workflow");

        const plan = mustRunJson([
          "orchestrate", "plan", "--root", project,
        ], project);
        assert.equal(
          plan.candidates.some((candidate) => candidate.story_id === storyId),
          false,
        );
        mustFail([
          "story", "claim",
          "--root", project,
          "--id", storyId,
          "--agent", "pre-task-multi-run-tamper-agent",
        ], project, /invalid or unreadable final lifecycle receipt/u);
        mustFail([
          "story", "claim",
          "--root", project,
          "--id", storyId,
          "--agent", "pre-task-multi-run-tamper-agent",
          "--force",
          "--actor-type", "human",
        ], project, /invalid or unreadable final lifecycle receipt/u);
        assert.equal(fs.existsSync(path.join(project, claimPath)), false);
        assert.equal(fs.existsSync(path.join(project, taskStartPath)), false);
        assert.equal(
          fs.existsSync(tracePath) ? fs.readFileSync(tracePath, "utf8") : null,
          traceBeforeTamperChecks,
        );
      },
    }),
    /Cannot bind task start to the current story workflow:/su,
  );

  assert.equal(fs.existsSync(path.join(project, taskStartPath)), false);
  assert.equal(fs.existsSync(path.join(project, claimPath)), false);
  assert.equal(
    fs.existsSync(tracePath) ? fs.readFileSync(tracePath, "utf8") : null,
    traceBeforeTamperChecks,
  );
  writeProjectFile(
    project,
    latestInstancePath,
    `${JSON.stringify(latestInstance, null, 2)}\n`,
  );
  const restoredStatus = mustRunJson([
    "status", "--root", project, "--full",
  ], project);
  assert.equal(restoredStatus.next_action.kind, "start_available_work");
  const restoredStory = restoredStatus.orchestration.stories
    .find((story) => story.id === storyId);
  assert.equal(restoredStory.orchestration_state, "available");
  assert.equal(restoredStory.workflow_instance_id, latestWorkflowId);

  const healthyTaskStart = mustRunJson([
    "task", "start",
    "--root", project,
    "--intent-json", implementationIntent(storyId),
    "--story", storyId,
    "--phase", "implementation",
    "--contract-id", storyContext.contractId,
    "--delivery-profile", storyContext.profileId,
    "--confirm-start",
    "--actor-type", "human",
  ], project);
  assert.equal(healthyTaskStart.execution_allowed, true);
  const taskStartReceipt = readJson(project, taskStartPath);
  assert.equal(taskStartReceipt.workflow_instance_ref.id, latestWorkflowId);
});

test("workflow story ownership ignores a story id colliding with the software-project definition", () => {
  const project = temporaryProject("workflow-story-definition-collision");
  const targetStoryId = "ST-WORKFLOW-TRACE-TARGET";
  const collisionStoryId = "software-project";
  const workflowInstanceId = "delivery-workflow-trace-target";
  const projectTracePath = path.join(project, ".sdlc/traces/project.jsonl");
  const projectTraceCheckpointPath = path.join(
    project,
    ".sdlc/traces/.integrity/project.jsonl.checkpoint.json",
  );

  const fixture = createGovernedDeliveryStory(project, {
    suffix: "WORKFLOW-TRACE-TARGET",
    allowedWritePaths: ["docs"],
    beforeTaskStart: ({ requirementId, storyId }) => {
      assert.equal(storyId, targetStoryId);
      mustRun([
        "story", "create",
        "--root", project,
        "--id", collisionStoryId,
        "--title", "Story whose id matches the built-in workflow definition",
        "--phase", "implementation",
        "--status", "ready",
        "--requirement", requirementId,
        "--acceptance", "Definition identifiers never imply workflow ownership.",
      ], project);
      mustRun([
        "workflow", "instance", "start",
        "--root", project,
        "--id", workflowInstanceId,
        "--definition", "software-project",
        "--definition-version", "3",
        "--story", targetStoryId,
        "--actor", "workflow-e2e-ci",
        "--actor-type", "ci",
      ], project);

      const orchestration = mustRunJson([
        "orchestrate", "status", "--root", project,
      ], project);
      const collisionStory = orchestration.stories
        .find((story) => story.id === collisionStoryId);
      const targetStory = orchestration.stories
        .find((story) => story.id === targetStoryId);
      assert.equal(collisionStory.orchestration_state, "available");
      assert.equal(collisionStory.workflow_instance_id, null);
      assert.equal(collisionStory.lifecycle_source, "story_record");
      assert.equal(targetStory.orchestration_state, "available");
      assert.equal(targetStory.workflow_instance_id, workflowInstanceId);

      const plan = mustRunJson([
        "orchestrate", "plan", "--root", project,
      ], project);
      assert.equal(
        plan.candidates.some((candidate) => candidate.story_id === collisionStoryId),
        true,
      );

      const projectTraceEvents = fs.readFileSync(projectTracePath, "utf8")
        .trim()
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const workflowStartTraces = projectTraceEvents.filter((event) =>
        event.action === "workflow.instance.start"
        && event.related?.[0] === workflowInstanceId);
      assert.equal(workflowStartTraces.length, 1);
      const [workflowStartTrace] = workflowStartTraces;
      assert.equal(workflowStartTrace.story_id, null);
      assert.equal(workflowStartTrace.workflow_story_id, targetStoryId);
      assert.equal(
        workflowStartTrace._trace_integrity.schema_version,
        "trace-integrity-event:v1",
      );
      assert.equal(workflowStartTrace._trace_integrity.authenticity_claimed, false);
      assert.match(workflowStartTrace._trace_integrity.event_hash, /^[a-f0-9]{64}$/u);

      const checkpoint = readJson(
        project,
        ".sdlc/traces/.integrity/project.jsonl.checkpoint.json",
      );
      assert.equal(checkpoint.schema_version, "trace-integrity-checkpoint:v1");
      assert.equal(checkpoint.authenticity_claimed, false);
      assert.equal(
        checkpoint.new_writes.last_event_hash,
        workflowStartTrace._trace_integrity.event_hash,
      );
      assert.equal(fs.existsSync(projectTraceCheckpointPath), true);
    },
  });

  assert.equal(fixture.storyId, targetStoryId);
  const targetTaskStart = readJson(
    project,
    `.sdlc/stories/${targetStoryId}/task-start.json`,
  );
  assert.equal(targetTaskStart.workflow_instance_ref.id, workflowInstanceId);
  assert.equal(
    fs.existsSync(path.join(project, `.sdlc/stories/${collisionStoryId}/task-start.json`)),
    false,
  );
  assert.equal(
    fs.existsSync(path.join(project, `.sdlc/stories/${collisionStoryId}/claim.json`)),
    false,
  );
  const finalOrchestration = mustRunJson([
    "orchestrate", "status", "--root", project,
  ], project);
  const finalCollisionStory = finalOrchestration.stories
    .find((story) => story.id === collisionStoryId);
  assert.equal(finalCollisionStory.orchestration_state, "available");
  assert.equal(finalCollisionStory.workflow_instance_id, null);
});

test("pre-task missing workflow instances root remains fail-closed and recovers after restoration", () => {
  const project = temporaryProject("pre-task-instances-root-missing");
  const storyId = "ST-PRE-TASK-INSTANCES-ROOT-MISSING";
  const workflowInstanceId = "delivery-pre-task-instances-root-missing";
  const instancesRoot = path.join(project, ".sdlc/workflows/instances");
  const movedInstancesRoot = path.join(
    project,
    ".sdlc/workflows/instances-temporarily-missing",
  );
  const taskStartPath = `.sdlc/stories/${storyId}/task-start.json`;
  const claimPath = `.sdlc/stories/${storyId}/claim.json`;
  const tracePath = path.join(project, `.sdlc/traces/${storyId}.jsonl`);
  let storyContext;
  let traceBeforeMissingRootChecks;

  assert.throws(
    () => createGovernedDeliveryStory(project, {
      suffix: "PRE-TASK-INSTANCES-ROOT-MISSING",
      allowedWritePaths: ["docs"],
      beforeTaskStart: ({ contractId, profileId }) => {
        storyContext = { contractId, profileId };
        mustRun([
          "workflow", "instance", "start",
          "--root", project,
          "--id", workflowInstanceId,
          "--definition", "software-project",
          "--definition-version", "3",
          "--story", storyId,
          "--actor", "workflow-e2e-ci",
          "--actor-type", "ci",
        ], project);
        assert.equal(fs.existsSync(path.join(project, taskStartPath)), false);
        assert.equal(fs.existsSync(path.join(project, claimPath)), false);

        fs.renameSync(instancesRoot, movedInstancesRoot);
        traceBeforeMissingRootChecks = fs.existsSync(tracePath)
          ? fs.readFileSync(tracePath, "utf8")
          : null;

        const status = mustRunJson([
          "status", "--root", project, "--full",
        ], project);
        assert.equal(status.summary.available_work, 0);
        assert.ok(status.summary.blocked_work >= 1);
        const statusStory = status.orchestration.stories
          .find((story) => story.id === storyId);
        assert.equal(statusStory.orchestration_state, "blocked");
        assert.equal(statusStory.lifecycle_source, "invalid_story_workflow");

        const orchestration = mustRunJson([
          "orchestrate", "status", "--root", project,
        ], project);
        const orchestratedStory = orchestration.stories
          .find((story) => story.id === storyId);
        assert.equal(orchestratedStory.orchestration_state, "blocked");
        assert.equal(orchestratedStory.lifecycle_source, "invalid_story_workflow");

        const plan = mustRunJson([
          "orchestrate", "plan", "--root", project,
        ], project);
        assert.equal(
          plan.candidates.some((candidate) => candidate.story_id === storyId),
          false,
        );
        mustFail([
          "story", "claim",
          "--root", project,
          "--id", storyId,
          "--agent", "pre-task-missing-root-agent",
        ], project, /invalid or unreadable final lifecycle receipt/u);
        mustFail([
          "story", "claim",
          "--root", project,
          "--id", storyId,
          "--agent", "pre-task-missing-root-agent",
          "--force",
          "--actor-type", "human",
        ], project, /invalid or unreadable final lifecycle receipt/u);
        assert.equal(fs.existsSync(path.join(project, claimPath)), false);
        assert.equal(fs.existsSync(path.join(project, taskStartPath)), false);
        assert.equal(
          fs.existsSync(tracePath) ? fs.readFileSync(tracePath, "utf8") : null,
          traceBeforeMissingRootChecks,
        );
      },
    }),
    /Cannot bind task start to the current story workflow:.*workflow start trace points to missing instance/su,
  );

  assert.equal(fs.existsSync(path.join(project, taskStartPath)), false);
  assert.equal(fs.existsSync(path.join(project, claimPath)), false);
  assert.equal(
    fs.existsSync(tracePath) ? fs.readFileSync(tracePath, "utf8") : null,
    traceBeforeMissingRootChecks,
  );
  fs.renameSync(movedInstancesRoot, instancesRoot);

  const restoredStatus = mustRunJson([
    "status", "--root", project, "--full",
  ], project);
  assert.equal(restoredStatus.next_action.kind, "start_available_work");
  const restoredStory = restoredStatus.orchestration.stories
    .find((story) => story.id === storyId);
  assert.equal(restoredStory.orchestration_state, "available");
  assert.equal(restoredStory.workflow_instance_id, workflowInstanceId);

  const healthyTaskStart = mustRunJson([
    "task", "start",
    "--root", project,
    "--intent-json", implementationIntent(storyId),
    "--story", storyId,
    "--phase", "implementation",
    "--contract-id", storyContext.contractId,
    "--delivery-profile", storyContext.profileId,
    "--confirm-start",
    "--actor-type", "human",
  ], project);
  assert.equal(healthyTaskStart.execution_allowed, true);
  const taskStartReceipt = readJson(project, taskStartPath);
  assert.equal(taskStartReceipt.workflow_instance_ref.id, workflowInstanceId);
});

test("an interrupted story-bound workflow start blocks status and task start until exact recovery", () => {
  const project = temporaryProject("story-bound-start-journal-recovery");
  const suffix = "STORY-BOUND-START-JOURNAL-RECOVERY";
  const storyId = `ST-${suffix}`;
  const workflowInstanceId = "delivery-story-bound-start-journal-recovery";
  const storyContext = prepareGovernedDeliveryStoryBeforeTaskStart(project, {
    suffix,
  });
  const workflowArgs = [
    "workflow", "instance", "start",
    "--root", project,
    "--id", workflowInstanceId,
    "--definition", "software-project",
    "--definition-version", "3",
    "--story", storyId,
    "--actor", "workflow-e2e-ci",
    "--actor-type", "ci",
    "--json",
  ];
  const interrupted = run(workflowArgs, project, {
    env: {
      NODE_ENV: "test",
      AGENTIC_SDLC_TEST_WORKFLOW_START_CRASH_PHASE: "after-publish-before-trace",
    },
  });
  assert.notEqual(interrupted.status, 0);

  const journalPath = path.join(
    project,
    ".sdlc/workflows/instances/.starts",
    `${workflowInstanceId}.json`,
  );
  const instancePath = path.join(
    project,
    ".sdlc/workflows/instances",
    workflowInstanceId,
    "instance.json",
  );
  const taskStartPath = path.join(
    project,
    ".sdlc/stories",
    storyId,
    "task-start.json",
  );
  assert.equal(fs.existsSync(journalPath), true);
  assert.equal(fs.existsSync(instancePath), true);
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  assert.equal(journal.kind, "workflow_instance_start_transaction");
  assert.equal(journal.schema_version, "workflow-instance-start-transaction:v1");
  assert.match(journal.transaction_hash, /^[a-f0-9]{64}$/u);

  const instanceStatus = run([
    "workflow", "instance", "status",
    "--root", project,
    "--id", workflowInstanceId,
    "--json",
  ], project);
  assert.notEqual(instanceStatus.status, 0);
  assert.match(
    `${instanceStatus.stdout}\n${instanceStatus.stderr}`,
    /interrupted start.*repeat the exact start command/su,
  );

  const projectStatus = mustRunJson([
    "status", "--root", project, "--full",
  ], project);
  const blockedStory = projectStatus.orchestration.stories
    .find((story) => story.id === storyId);
  assert.equal(blockedStory.orchestration_state, "blocked");
  assert.equal(blockedStory.lifecycle_source, "invalid_story_workflow");
  assert.equal(projectStatus.summary.available_work, 0);
  assert.ok(projectStatus.summary.blocked_work >= 1);

  const blockedTaskStart = run([
    "task", "start",
    "--root", project,
    "--intent-json", implementationIntent(storyId),
    "--story", storyId,
    "--phase", "implementation",
    "--contract-id", storyContext.contractId,
    "--delivery-profile", storyContext.profileId,
    "--confirm-start",
    "--actor-type", "human",
    "--json",
  ], project);
  assert.notEqual(blockedTaskStart.status, 0);
  assert.match(
    `${blockedTaskStart.stdout}\n${blockedTaskStart.stderr}`,
    /Cannot bind task start to the current story workflow:.*interrupted workflow start/su,
  );
  assert.equal(fs.existsSync(taskStartPath), false);
  assert.equal(fs.existsSync(journalPath), true);

  const recovered = JSON.parse(mustRun(workflowArgs, project).stdout);
  assert.equal(recovered.status, "started");
  assert.equal(recovered.recovered, true);
  assert.equal(fs.existsSync(journalPath), false);
  const restoredStatus = mustRunJson([
    "status", "--root", project, "--full",
  ], project);
  assert.equal(restoredStatus.next_action.kind, "start_available_work");
  const restoredStory = restoredStatus.orchestration.stories
    .find((story) => story.id === storyId);
  assert.equal(restoredStory.orchestration_state, "available");
  assert.equal(restoredStory.workflow_instance_id, workflowInstanceId);

  const healthyTaskStart = mustRunJson([
    "task", "start",
    "--root", project,
    "--intent-json", implementationIntent(storyId),
    "--story", storyId,
    "--phase", "implementation",
    "--contract-id", storyContext.contractId,
    "--delivery-profile", storyContext.profileId,
    "--confirm-start",
    "--actor-type", "human",
  ], project);
  assert.equal(healthyTaskStart.execution_allowed, true);
  const taskStartReceipt = JSON.parse(fs.readFileSync(taskStartPath, "utf8"));
  assert.equal(taskStartReceipt.workflow_instance_ref.id, workflowInstanceId);
});

test("concurrent workflow and task starts serialize on the story task-start boundary", async () => {
  const project = temporaryProject("workflow-task-start-boundary-race");
  const hookRoot = temporaryProject("workflow-task-start-boundary-hook");
  const suffix = "WORKFLOW-TASK-START-BOUNDARY-RACE";
  const storyId = `ST-${suffix}`;
  const workflowInstanceId = "delivery-workflow-task-start-boundary-race";
  const storyContext = prepareGovernedDeliveryStoryBeforeTaskStart(project, {
    suffix,
  });
  const boundaryLockPath = path.join(
    project,
    ".sdlc/stories",
    storyId,
    "task-start-boundary.lock",
  );
  const hookMarkerPath = path.join(hookRoot, "workflow-boundary-delay.marker");
  const hookPath = path.join(hookRoot, "delay-workflow-boundary.mjs");
  fs.writeFileSync(hookPath, [
    'import fs from "node:fs";',
    "const originalOpenSync = fs.openSync;",
    "let delayed = false;",
    "fs.openSync = function delayedWorkflowBoundaryOpen(filePath, flags, ...rest) {",
    "  if (!delayed",
    "      && String(filePath) === process.env.AGENTIC_SDLC_TEST_BOUNDARY_LOCK_PATH",
    '      && flags === "wx") {',
    "    delayed = true;",
    "    fs.writeFileSync(process.env.AGENTIC_SDLC_TEST_BOUNDARY_MARKER, String(filePath));",
    "    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 750);",
    "  }",
    "  return originalOpenSync.call(this, filePath, flags, ...rest);",
    "};",
    "",
  ].join("\n"));

  const taskArgs = [
    "task", "start",
    "--root", project,
    "--intent-json", implementationIntent(storyId),
    "--story", storyId,
    "--phase", "implementation",
    "--contract-id", storyContext.contractId,
    "--delivery-profile", storyContext.profileId,
    "--confirm-start",
    "--actor-type", "human",
    "--json",
  ];
  const workflowArgs = [
    "workflow", "instance", "start",
    "--root", project,
    "--id", workflowInstanceId,
    "--definition", "software-project",
    "--definition-version", "3",
    "--story", storyId,
    "--actor", "workflow-e2e-ci",
    "--actor-type", "ci",
    "--json",
  ];
  const [taskResult, workflowResult] = await Promise.all([
    runConcurrently(taskArgs, project),
    runConcurrently(workflowArgs, project, {
      NODE_OPTIONS: `--import=${pathToFileURL(hookPath).href}`,
      AGENTIC_SDLC_TEST_BOUNDARY_LOCK_PATH: boundaryLockPath,
      AGENTIC_SDLC_TEST_BOUNDARY_MARKER: hookMarkerPath,
    }),
  ]);

  assert.equal(fs.readFileSync(hookMarkerPath, "utf8"), boundaryLockPath);
  assert.equal(taskResult.signal, null, `${taskResult.stdout}\n${taskResult.stderr}`);
  assert.equal(workflowResult.signal, null, `${workflowResult.stdout}\n${workflowResult.stderr}`);
  assert.equal(taskResult.status, 0, `${taskResult.stdout}\n${taskResult.stderr}`);
  assert.notEqual(
    workflowResult.status,
    0,
    "workflow start and task start both crossed the same pre-task boundary",
  );
  const workflowFailure = JSON.parse(
    workflowResult.stderr.trim() || workflowResult.stdout.trim(),
  );
  assert.equal(workflowFailure.schema_version, "agentic-sdlc-cli-error:v1");
  assert.equal(workflowFailure.status, "error");
  assert.equal(typeof workflowFailure.error?.message, "string");
  const workflowFailureMessage = workflowFailure.error?.message || "";
  const semanticBoundaryRejection =
    /already has a task-start receipt.*must start before task start/su
      .test(workflowFailureMessage);
  const boundedLockContention = new Set([
    `Resource is locked by another SDLC operation: ${boundaryLockPath}`,
    `Cannot acquire internal lock after transient Windows file-system contention: ${boundaryLockPath}`,
  ]).has(workflowFailureMessage);
  assert.equal(
    semanticBoundaryRejection || boundedLockContention,
    true,
    `Unexpected workflow boundary rejection: ${workflowFailureMessage}`,
  );
  assert.equal(
    [taskResult, workflowResult].filter((result) => result.status === 0).length,
    1,
  );
  const taskStartReceipt = readJson(
    project,
    `.sdlc/stories/${storyId}/task-start.json`,
  );
  assert.equal(taskStartReceipt.workflow_instance_ref ?? null, null);
  const workflowArtifactPaths = [
    path.join(
      project,
      ".sdlc/workflows/instances",
      workflowInstanceId,
    ),
    path.join(
      project,
      ".sdlc/workflows/instances/.starts",
      `${workflowInstanceId}.json`,
    ),
    path.join(
      project,
      ".sdlc/workflows/instances/.staging",
      workflowInstanceId,
    ),
  ];
  const projectTracePath = path.join(project, ".sdlc/traces/project.jsonl");
  const assertNoPartialWorkflowState = () => {
    for (const artifactPath of workflowArtifactPaths) {
      assert.equal(fs.existsSync(artifactPath), false, artifactPath);
    }
    assert.equal(fs.existsSync(boundaryLockPath), false, boundaryLockPath);
    if (fs.existsSync(projectTracePath)) {
      assert.doesNotMatch(
        fs.readFileSync(projectTracePath, "utf8"),
        new RegExp(workflowInstanceId, "u"),
      );
    }
  };
  assertNoPartialWorkflowState();
  if (boundedLockContention) {
    const stableRetry = run(workflowArgs, project);
    assert.equal(stableRetry.signal, null, `${stableRetry.stdout}\n${stableRetry.stderr}`);
    assert.notEqual(stableRetry.status, 0, "workflow retry crossed the completed task-start boundary");
    const stableRetryFailure = JSON.parse(
      stableRetry.stderr.trim() || stableRetry.stdout.trim(),
    );
    assert.equal(stableRetryFailure.schema_version, "agentic-sdlc-cli-error:v1");
    assert.equal(stableRetryFailure.status, "error");
    assert.equal(typeof stableRetryFailure.error?.message, "string");
    assert.match(
      stableRetryFailure.error.message,
      /already has a task-start receipt.*must start before task start/su,
    );
    assertNoPartialWorkflowState();
  }
});

test("lifecycle-complete strict gate requires the pre-task workflow and an alternating phase timeline", {
  skip: hostSupportsLocalSmokeSandbox()
    ? false
    : "requires a supported local smoke sandbox for terminal local release evidence",
}, async () => {
  const project = temporaryProject("lifecycle");
  const customPhase = "package-boundary-check";
  const finalReceiptPath = ".sdlc/gates/ST-FINAL-final.json";
  const strictReceiptPath = ".sdlc/gates/ST-FINAL-strict.json";
  const workflowDefinitionId = "software-project-custom-final";
  const historicalWorkflowInstanceId = "delivery-archive-final";
  const workflowInstanceId = "delivery-final";
  const fixture = createGovernedDeliveryStory(project, {
    suffix: "FINAL",
    allowedWritePaths: ["docs"],
    outputType: "implementation-summary",
    outputPhase: "implementation",
    additionalOutputRefs: [{ type: "release-notes", phase: "release" }],
    configureProject: (target) => configureCustomPhase(target, customPhase),
    deliveryKind: "local_release",
    storyActionUses: 12,
    beforeTaskStart: ({ storyId }) => {
      mustRun([
        "workflow", "definition", "propose",
        "--root", project,
        "--id", workflowDefinitionId,
        "--definition-version", "1",
        "--definition-json", JSON.stringify(customGovernedWorkflowDefinition(customPhase)),
      ], project);
      mustRun([
        "workflow", "definition", "approve",
        "--root", project,
        "--id", workflowDefinitionId,
        "--definition-version", "1",
        ...humanApproval("Approve the exact custom governed project process"),
      ], project);
      for (const instanceId of [historicalWorkflowInstanceId, workflowInstanceId]) {
        mustRun([
          "workflow", "instance", "start",
          "--root", project,
          "--id", instanceId,
          "--definition", workflowDefinitionId,
          "--definition-version", "1",
          "--story", storyId,
          "--actor", "workflow-e2e-ci",
          "--actor-type", "ci",
          "--actor-name", "Workflow E2E CI",
        ], project);
      }
    },
  });
  const taskStartReceipt = readJson(
    project,
    `.sdlc/stories/${fixture.storyId}/task-start.json`,
  );
  assert.equal(taskStartReceipt.schema_version, "profile-task-start-receipt:v2");
  assert.equal(taskStartReceipt.workflow_instance_ref.id, workflowInstanceId);
  fs.appendFileSync(
    path.join(project, "docs", "tracked-runtime.md"),
    "\nGoverned tracked-file implementation change.\n",
    "utf8",
  );
  fs.rmSync(path.join(project, "docs", "deleted-runtime.md"));
  mustFail([
    "workflow", "instance", "start",
    "--root", project,
    "--id", "delivery-post-hoc-final",
    "--definition", workflowDefinitionId,
    "--definition-version", "1",
    "--story", fixture.storyId,
    "--actor", "workflow-e2e-ci",
    "--actor-type", "ci",
  ], project, /already has a task-start receipt|must start before task start|post-hoc workflow replay/u);

  const artifact = writeProjectFile(
    project,
    "docs/implementation-summary.md",
    "# Implementation summary\n\nThe approved implementation is complete and verified.\n",
  );
  mustRun([
    "output", "link",
    "--root", project,
    "--story", fixture.storyId,
    "--type", "implementation-summary",
    "--artifact", artifact,
    "--template", "implementation-summary-v1",
    "--mode", "new",
    "--requirement", fixture.requirementId,
    "--authorization", fixture.storyActionAuthorizationId,
  ], project);

  for (const [index, step] of [
    "discovery",
    "analysis",
    "design",
    customPhase,
    "implementation",
  ].entries()) {
    mustRun([
      "story", "complete-step",
      "--root", project,
      "--id", fixture.storyId,
      "--step", step,
      "--summary", `${step} completed against the approved boundary`,
      ...(step === "implementation" ? ["--type", "implementation-summary"] : []),
      "--authorization", fixture.storyActionAuthorizationId,
    ], project);
    const nextPhase = ["analysis", "design", customPhase, "implementation", "validation"][index];
    mustRun([
      "workflow", "instance", "transition",
      "--root", project,
      "--id", workflowInstanceId,
      "--to", nextPhase,
      "--request-id", `final-workflow-${index + 1}`,
      "--actor", "workflow-e2e-ci",
      "--actor-type", "ci",
      "--actor-name", "Workflow E2E CI",
    ], project);
  }

  const incomplete = mustFail([
    "gate", "check",
    "--root", project,
    "--strict",
    "--story", fixture.storyId,
    "--lifecycle-complete",
    "--json",
  ], project, /lifecycle completion requires completed phases: validation, release|latest test trace to pass|latest release trace to pass/u);
  const incompleteReport = JSON.parse(incomplete.stdout);
  assert.equal(incompleteReport.lifecycle_complete, true);
  assert.equal(fs.existsSync(path.join(project, finalReceiptPath)), false);

  const testEvidence = writeProjectFile(project, ".sdlc/tests/ST-FINAL-test.json", "{\"passed\":true}\n");
  appendTrace(project, fixture.storyId, "test", "passed", testEvidence);
  mustRun([
    "story", "complete-step",
    "--root", project,
    "--id", fixture.storyId,
    "--step", "validation",
    "--summary", "Validation completed with the latest passing test",
    "--evidence", testEvidence,
    "--authorization", fixture.storyActionAuthorizationId,
  ], project);

  const strictReport = mustRunJson([
    "gate", "check",
    "--root", project,
    "--strict",
    "--story", fixture.storyId,
  ], project);
  assert.equal(strictReport.kind, "workflow_strict_gate_receipt");
  assert.equal(strictReport.schema_version, "workflow-strict-gate-receipt:v2");
  assert.equal(strictReport.lifecycle_complete, false);
  assert.equal(strictReport.strict_receipt_path, strictReceiptPath);
  assert.equal(strictReport.workflow_scope.instance_id, workflowInstanceId);
  assert.equal(strictReport.workflow_scope.story_id, fixture.storyId);
  assert.equal(strictReport.workflow_scope.current_phase, "validation");
  assert.deepEqual(strictReport.workflow_scope.phase_order, [
    "discovery",
    "analysis",
    "design",
    customPhase,
    "implementation",
    "validation",
    "release",
    "operations",
  ]);
  assert.match(strictReport.workflow_scope.checkpoint_ref.checkpoint_hash, /^[a-f0-9]{64}$/u);
  assert.equal(fs.existsSync(path.join(project, strictReceiptPath)), true);
  assert.equal(fs.existsSync(path.join(project, finalReceiptPath)), false);

  await new Promise((resolve) => setTimeout(resolve, 10));
  appendTrace(project, fixture.storyId, "test", "passed", testEvidence);
  const staleStrictGateStatus = mustRunJson([
    "status", "--root", project,
  ], project);
  assert.equal(staleStrictGateStatus.next_action.kind, "seal_strict_gate");
  assert.equal(
    staleStrictGateStatus.next_action.reason,
    "release_transition_strict_gate_stale",
  );
  assert.ok(staleStrictGateStatus.next_action.strict_gate_issues.some((issue) =>
    issue.includes("predates current test evidence")));
  assert.match(
    staleStrictGateStatus.next_action.command,
    /gate check --strict --story ST-FINAL$/u,
  );
  mustFail([
    "workflow", "instance", "transition",
    "--root", project,
    "--id", workflowInstanceId,
    "--to", "release",
    "--request-id", "final-workflow-6-stale-strict-gate",
    "--actor", "workflow-e2e-ci",
    "--actor-type", "ci",
    "--actor-name", "Workflow E2E CI",
  ], project, /cannot use the intermediate strict gate.*predates current test evidence.*Run .*gate check --strict --story ST-FINAL/su);
  const refreshedStrictReport = mustRunJson([
    "gate", "check",
    "--root", project,
    "--strict",
    "--story", fixture.storyId,
  ], project);
  assert.equal(refreshedStrictReport.kind, "workflow_strict_gate_receipt");
  assert.ok(
    Date.parse(refreshedStrictReport.checked_at)
      > Date.parse(strictReport.checked_at),
  );
  const refreshedWorkflowStatus = mustRunJson([
    "workflow", "instance", "status",
    "--root", project,
    "--id", workflowInstanceId,
  ], project);
  assert.equal(refreshedWorkflowStatus.status, "ready");
  assert.deepEqual(refreshedWorkflowStatus.ready_next_states, ["release"]);

  const requirementTamperProject = cloneTemporaryProject(
    project,
    "strict-requirement-tamper",
  );
  const tamperedRequirementPath = path.join(
    requirementTamperProject,
    `.sdlc/requirements/${fixture.requirementId}.json`,
  );
  const tamperedRequirement = readJson(
    requirementTamperProject,
    `.sdlc/requirements/${fixture.requirementId}.json`,
  );
  tamperedRequirement.summary =
    `${tamperedRequirement.summary} Unapproved mutation after the strict gate.`;
  fs.writeFileSync(
    tamperedRequirementPath,
    `${JSON.stringify(tamperedRequirement, null, 2)}\n`,
    "utf8",
  );
  assertReleaseStrictGateBlocked({
    project: requirementTamperProject,
    workflowInstanceId,
    requestId: "final-workflow-6-requirement-tampered",
    issuePattern: /requirement REQ-FINAL.*fresh formal approval/iu,
  });

  const supersededRequirementProject = cloneTemporaryProject(
    project,
    "strict-requirement-superseded",
  );
  mustRun([
    "requirement", "revise",
    "--root", supersededRequirementProject,
    "--id", fixture.requirementId,
    "--new-id", `${fixture.requirementId}-R2`,
    "--title", "Revised governed lifecycle requirement",
  ], supersededRequirementProject);
  mustRun([
    "requirement", "approve",
    "--root", supersededRequirementProject,
    "--id", `${fixture.requirementId}-R2`,
    ...humanApproval("Approve the revised governed lifecycle requirement"),
  ], supersededRequirementProject);
  mustRun([
    "requirement", "supersede",
    "--root", supersededRequirementProject,
    "--id", fixture.requirementId,
    "--new-id", `${fixture.requirementId}-R2`,
    "--reason", "Replace the original requirement with its approved revision",
    ...humanApproval("Approve the exact requirement supersession"),
  ], supersededRequirementProject);
  assertReleaseStrictGateBlocked({
    project: supersededRequirementProject,
    workflowInstanceId,
    requestId: "final-workflow-6-requirement-superseded",
    issuePattern:
      /requirement REQ-FINAL is superseded and cannot remain an active story input/iu,
  });

  const validationStepTamperProject = cloneTemporaryProject(
    project,
    "strict-validation-step-tamper",
  );
  const validationStepRelativePath =
    `.sdlc/stories/${fixture.storyId}/steps/validation.json`;
  const validationStep = readJson(
    validationStepTamperProject,
    validationStepRelativePath,
  );
  validationStep.evidence[0].sha256 = "0".repeat(64);
  fs.writeFileSync(
    path.join(validationStepTamperProject, validationStepRelativePath),
    `${JSON.stringify(validationStep, null, 2)}\n`,
    "utf8",
  );
  assertReleaseStrictGateBlocked({
    project: validationStepTamperProject,
    workflowInstanceId,
    requestId: "final-workflow-6-validation-step-tampered",
    issuePattern:
      /story step ST-FINAL\/validation evidence changed after step completion/iu,
    transitionPattern:
      /canonical story step for phase 'validation' does not match its sealed completion attestation/iu,
  });

  const changedPathScopeProject = cloneTemporaryProject(
    project,
    "strict-changed-path-scope",
  );
  const outsideScopePath = writeProjectFile(
    changedPathScopeProject,
    "src/out-of-scope-after-strict.mjs",
    "export const outsideApprovedScope = true;\n",
  );
  mustGit(changedPathScopeProject, ["add", outsideScopePath]);
  mustGit(changedPathScopeProject, [
    "commit", "-m", "test: mutate outside approved strict scope",
  ]);
  assertReleaseStrictGateBlocked({
    project: changedPathScopeProject,
    workflowInstanceId,
    requestId: "final-workflow-6-changed-path-scope",
    issuePattern: /changed files outside the approved requirement write paths/iu,
  });

  const implementationArtifactPath = path.join(project, artifact);
  fs.writeFileSync(
    implementationArtifactPath,
    "# Implementation summary\n\nThe deliverable changed after the strict receipt.\n",
    "utf8",
  );
  const changedArtifactStatus = mustRunJson([
    "status", "--root", project,
  ], project);
  assert.equal(changedArtifactStatus.next_action.kind, "repair_output_link");
  assert.equal(
    changedArtifactStatus.next_action.reason,
    "output_link_evidence_changed",
  );
  assert.ok(changedArtifactStatus.next_action.strict_gate_issues.some((issue) =>
    issue.includes(`artifact ${artifact} changed after it was linked`)));
  const implementationLink = readJson(
    project,
    ".sdlc/output-contracts/registry.json",
  ).links.find((link) =>
    link.story_id === fixture.storyId
    && link.artifact_type === "implementation-summary");
  assert.equal(
    changedArtifactStatus.next_action.output_link_id,
    implementationLink.id,
  );
  assert.deepEqual(
    changedArtifactStatus.next_action.repair_steps.map((step) => step.kind),
    ["repair_output_link", "seal_strict_gate"],
  );
  assert.match(
    changedArtifactStatus.next_action.command,
    new RegExp(
      `output link .*--story ${fixture.storyId} .*--id ${implementationLink.id} .*--authorization ${fixture.storyActionAuthorizationId}$`,
      "u",
    ),
  );
  const changedArtifactWorkflowStatus = mustRunJson([
    "workflow", "instance", "status",
    "--root", project,
    "--id", workflowInstanceId,
  ], project);
  assert.equal(changedArtifactWorkflowStatus.status, "blocked");
  assert.deepEqual(changedArtifactWorkflowStatus.ready_next_states, []);
  const changedArtifactReleaseCheck =
    changedArtifactWorkflowStatus.next_transition_checks.find((check) =>
      check.to === "release");
  assert.equal(changedArtifactReleaseCheck.allowed, false);
  const changedArtifactStrictGuard =
    changedArtifactReleaseCheck.guard_results.find((result) =>
      result.guard_id === "strict-gate-passed");
  assert.equal(changedArtifactStrictGuard.allowed, false);
  assert.deepEqual(
    changedArtifactStrictGuard.issues,
    changedArtifactStatus.next_action.strict_gate_issues,
  );
  assert.equal(
    changedArtifactStrictGuard.repair_action.kind,
    "repair_output_link",
  );
  mustFail([
    "workflow", "instance", "transition",
    "--root", project,
    "--id", workflowInstanceId,
    "--to", "release",
    "--request-id", "final-workflow-6-artifact-mutated",
    "--actor", "workflow-e2e-ci",
    "--actor-type", "ci",
    "--actor-name", "Workflow E2E CI",
  ], project, /cannot use the intermediate strict gate.*artifact docs\/implementation-summary\.md changed after it was linked/su);
  mustRun([
    "output", "link",
    "--root", project,
    "--story", fixture.storyId,
    "--type", implementationLink.artifact_type,
    "--artifact", implementationLink.artifact_path,
    "--template", implementationLink.template_id,
    "--mode", implementationLink.mode,
    "--id", implementationLink.id,
    "--requirement", fixture.requirementId,
    "--authorization", fixture.storyActionAuthorizationId,
  ], project);
  const artifactRelinkedStatus = mustRunJson([
    "status", "--root", project,
  ], project);
  assert.equal(artifactRelinkedStatus.next_action.kind, "seal_strict_gate");
  const artifactRelinkedStrictReport = mustRunJson([
    "gate", "check",
    "--root", project,
    "--strict",
    "--story", fixture.storyId,
  ], project);
  assert.equal(artifactRelinkedStrictReport.status, "passed");
  assert.equal(
    artifactRelinkedStrictReport.kind,
    "workflow_strict_gate_receipt",
  );

  const implementationTemplatePath = path.join(
    project,
    ".sdlc/output-contracts/templates/implementation-summary-v1.md",
  );
  fs.appendFileSync(
    implementationTemplatePath,
    "\nUnapproved template mutation after the strict receipt.\n",
    "utf8",
  );
  const changedTemplateStatus = mustRunJson([
    "status", "--root", project,
  ], project);
  assert.equal(
    changedTemplateStatus.next_action.kind,
    "reapprove_output_template",
  );
  assert.equal(
    changedTemplateStatus.next_action.reason,
    "output_template_changed_after_approval",
  );
  assert.ok(changedTemplateStatus.next_action.strict_gate_issues.some((issue) =>
    issue.includes("output template implementation-summary-v1 changed after approval")));
  assert.deepEqual(
    changedTemplateStatus.next_action.repair_steps.map((step) => step.kind),
    [
      "reapprove_output_template",
      "repair_output_link",
      "seal_strict_gate",
    ],
  );
  assert.match(
    changedTemplateStatus.next_action.command,
    /output template approve --id implementation-summary-v1 .*--approval-source explicit-user/u,
  );
  const changedTemplateWorkflowStatus = mustRunJson([
    "workflow", "instance", "status",
    "--root", project,
    "--id", workflowInstanceId,
  ], project);
  assert.equal(changedTemplateWorkflowStatus.status, "blocked");
  assert.deepEqual(changedTemplateWorkflowStatus.ready_next_states, []);
  const changedTemplateReleaseCheck =
    changedTemplateWorkflowStatus.next_transition_checks.find((check) =>
      check.to === "release");
  assert.equal(changedTemplateReleaseCheck.allowed, false);
  const changedTemplateStrictGuard =
    changedTemplateReleaseCheck.guard_results.find((result) =>
      result.guard_id === "strict-gate-passed");
  assert.equal(changedTemplateStrictGuard.allowed, false);
  assert.deepEqual(
    changedTemplateStrictGuard.issues,
    changedTemplateStatus.next_action.strict_gate_issues,
  );
  assert.equal(
    changedTemplateStrictGuard.repair_action.kind,
    "reapprove_output_template",
  );
  mustFail([
    "workflow", "instance", "transition",
    "--root", project,
    "--id", workflowInstanceId,
    "--to", "release",
    "--request-id", "final-workflow-6-template-mutated",
    "--actor", "workflow-e2e-ci",
    "--actor-type", "ci",
    "--actor-name", "Workflow E2E CI",
  ], project, /cannot use the intermediate strict gate.*output template implementation-summary-v1 changed after approval/su);
  mustRun([
    "output", "template", "approve",
    "--root", project,
    "--id", "implementation-summary-v1",
    ...humanApproval("Approve the current implementation summary format"),
  ], project);
  const templateReapprovedStatus = mustRunJson([
    "status", "--root", project,
  ], project);
  assert.equal(
    templateReapprovedStatus.next_action.kind,
    "repair_output_link",
  );
  assert.equal(
    templateReapprovedStatus.next_action.output_link_id,
    implementationLink.id,
  );
  mustRun([
    "output", "link",
    "--root", project,
    "--story", fixture.storyId,
    "--type", implementationLink.artifact_type,
    "--artifact", implementationLink.artifact_path,
    "--template", implementationLink.template_id,
    "--mode", implementationLink.mode,
    "--id", implementationLink.id,
    "--requirement", fixture.requirementId,
    "--authorization", fixture.storyActionAuthorizationId,
  ], project);
  const templateRelinkedStatus = mustRunJson([
    "status", "--root", project,
  ], project);
  assert.equal(templateRelinkedStatus.next_action.kind, "seal_strict_gate");
  const templateRelinkedStrictReport = mustRunJson([
    "gate", "check",
    "--root", project,
    "--strict",
    "--story", fixture.storyId,
  ], project);
  assert.equal(templateRelinkedStrictReport.status, "passed");
  assert.equal(
    templateRelinkedStrictReport.kind,
    "workflow_strict_gate_receipt",
  );

  mustRun([
    "workflow", "instance", "transition",
    "--root", project,
    "--id", workflowInstanceId,
    "--to", "release",
    "--request-id", "final-workflow-6",
    "--actor", "workflow-e2e-ci",
    "--actor-type", "ci",
    "--actor-name", "Workflow E2E CI",
  ], project);
  const awaitingReleaseStatus = mustRunJson([
    "status", "--root", project,
  ], project);
  assert.equal(awaitingReleaseStatus.next_action.kind, "complete_release_evidence");
  assert.deepEqual(
    awaitingReleaseStatus.next_action.missing_release_evidence,
    ["terminal successful delivery", "passing release trace", "completed release step"],
  );

  const missingReleaseOutputGate = mustFail([
    "gate", "check",
    "--root", project,
    "--strict",
    "--story", fixture.storyId,
    "--lifecycle-complete",
    "--json",
  ], project, /requires completed phases: release|latest release trace to pass|requires terminal local_release delivery; found started|release-notes/u);
  const missingReleaseOutputReport = JSON.parse(missingReleaseOutputGate.stdout);
  assert.ok(
    missingReleaseOutputReport.errors.some((error) =>
      error.includes("output ref release-notes is not satisfied")),
    `final lifecycle gate did not require the deferred release output: ${
      missingReleaseOutputReport.errors.join("; ")
    }`,
  );
  assert.equal(fs.existsSync(path.join(project, finalReceiptPath)), false);

  const releaseEvidence = writeProjectFile(project, ".sdlc/tests/ST-FINAL-release.json", "{\"ready\":true}\n");
  appendTrace(project, fixture.storyId, "release", "passed", releaseEvidence);
  const releaseNotes = writeProjectFile(
    project,
    "docs/release-notes.md",
    "# Release notes\n\nThe governed local release is ready.\n",
  );
  mustRun([
    "output", "link",
    "--root", project,
    "--story", fixture.storyId,
    "--type", "release-notes",
    "--artifact", releaseNotes,
    "--template", "release-notes-v1",
    "--mode", "new",
    "--requirement", fixture.requirementId,
    "--authorization", fixture.storyActionAuthorizationId,
  ], project);
  mustRun([
    "story", "complete-step",
    "--root", project,
    "--id", fixture.storyId,
    "--step", "release",
    "--type", "release-notes",
    "--summary", "Release evidence completed",
    "--evidence", releaseEvidence,
    "--authorization", fixture.storyActionAuthorizationId,
  ], project);

  const localBuildAuthorization = mustRunJson([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", fixture.profileId,
    "--action", "build.local",
    "--confirm-action",
    ...humanApproval("Approve creation of the exact absent-at-start local target"),
  ], project);
  fs.mkdirSync(path.join(project, "docs", "local-release", "app"), {
    recursive: true,
  });
  const localBuildEvidence = writeProjectFile(
    project,
    "docs/local-build-proof.json",
    '{"target":"docs/local-release","built":true}\n',
  );
  mustRun([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", fixture.profileId,
    "--action", "build.local",
    "--outcome", "passed",
    "--authorization-receipt", localBuildAuthorization.action_receipt.id,
    "--evidence", localBuildEvidence,
  ], project);

  const rollbackEvidence = writeProjectFile(
    project,
    "docs/local-release/rollback-rehearsal.json",
    '{"target":"docs/local-release/app","restored":true}\n',
  );
  mustRun([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", fixture.profileId,
    "--action", "rollback.verify",
    "--evidence", rollbackEvidence,
    "--confirm-action",
    ...humanApproval("Approve the exact local rollback rehearsal evidence"),
  ], project);
  mustRun([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", fixture.profileId,
    "--action", "rollback.verify",
    "--outcome", "passed",
    "--evidence", rollbackEvidence,
  ], project);

  const localReleaseEvidence = writeProjectFile(
    project,
    "docs/local-release/app/release-proof.txt",
    "governed local release completed\n",
  );
  mustRun([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", fixture.profileId,
    "--action", "release.local",
    "--confirm-action",
    ...humanApproval("Approve this exact governed local release"),
  ], project);
  const localRelease = mustRunJson([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", fixture.profileId,
    "--action", "release.local",
    "--outcome", "passed",
    "--evidence", localReleaseEvidence,
    "--smoke-test", '["node","--version"]',
    "--rollback", "Restore the previous governed local release snapshot.",
  ], project);
  assert.equal(localRelease.lifecycle_status, "terminal");
  assert.equal(
    readJson(project, localRelease.close_receipt_path).terminal_status,
    "released",
  );
  const readyToCertifyStatus = mustRunJson([
    "status", "--root", project,
  ], project);
  assert.equal(readyToCertifyStatus.next_action.kind, "release_story_claim");
  assert.equal(
    readyToCertifyStatus.next_action.reason,
    "final_certification_requires_released_claim",
  );
  assert.match(readyToCertifyStatus.next_action.command, /^node /u);
  assert.doesNotMatch(readyToCertifyStatus.next_action.command, /^agentic-sdlc /u);

  // Release evidence is complete, but the configured lifecycle now ends at
  // operations, not release: advance the workflow and complete its step
  // (a plain marker, never gated on an incident or feedback record) before
  // the claim/certification checks below.
  mustRun([
    "workflow", "instance", "transition",
    "--root", project,
    "--id", workflowInstanceId,
    "--to", "operations",
    "--request-id", "final-workflow-7-operations",
    "--actor", "workflow-e2e-ci",
    "--actor-type", "ci",
    "--actor-name", "Workflow E2E CI",
  ], project);
  mustRun([
    "story", "complete-step",
    "--root", project,
    "--id", fixture.storyId,
    "--step", "operations",
    "--summary", "Operations tracking acknowledged; no incidents or feedback yet",
    "--authorization", fixture.storyActionAuthorizationId,
  ], project);

  mustFail([
    "gate", "check",
    "--root", project,
    "--strict",
    "--story", fixture.storyId,
    "--lifecycle-complete",
  ], project, /active claim by codex.*Release the claim before final lifecycle certification/su);
  assert.equal(fs.existsSync(path.join(project, finalReceiptPath)), false);
  mustRun([
    "story", "release",
    "--root", project,
    "--id", fixture.storyId,
    "--agent", "codex",
    "--reason", "Release the completed lane before final lifecycle certification.",
  ], project);
  const claimReleasedStatus = mustRunJson([
    "status", "--root", project,
  ], project);
  assert.equal(claimReleasedStatus.next_action.kind, "certify_lifecycle");
  assert.equal(claimReleasedStatus.next_action.reason, "workflow_terminal");

  const currentInstancePath =
    `.sdlc/workflows/instances/${workflowInstanceId}/instance.json`;
  const currentInstance = readJson(project, currentInstancePath);
  const releasedClaimPath = `.sdlc/stories/${fixture.storyId}/claim.json`;
  const releasedClaim = readJson(project, releasedClaimPath);
  assert.equal(releasedClaim.status, "released");
  const assertLifecycleBindingTamperBlocked = (label) => {
    assert.equal(fs.existsSync(path.join(project, finalReceiptPath)), false);
    const status = mustRunJson([
      "status", "--root", project,
    ], project);
    assert.equal(status.summary.available_work, 0);
    assert.ok(status.summary.blocked_work >= 1);

    const orchestration = mustRunJson([
      "orchestrate", "status", "--root", project,
    ], project);
    const storyState = orchestration.stories
      .find((story) => story.id === fixture.storyId);
    assert.equal(storyState.orchestration_state, "blocked");
    assert.equal(storyState.lifecycle_source, "invalid_story_workflow");

    const plan = mustRunJson([
      "orchestrate", "plan", "--root", project,
    ], project);
    assert.equal(
      plan.candidates.some((candidate) => candidate.story_id === fixture.storyId),
      false,
    );
    mustFail([
      "story", "claim",
      "--root", project,
      "--id", fixture.storyId,
      "--agent", `${label}-agent`,
    ], project, /invalid or unreadable final lifecycle receipt/u);
    mustFail([
      "story", "claim",
      "--root", project,
      "--id", fixture.storyId,
      "--agent", `${label}-agent`,
      "--force",
      "--actor-type", "human",
    ], project, /invalid or unreadable final lifecycle receipt/u);
    assert.deepEqual(readJson(project, releasedClaimPath), releasedClaim);
  };

  const missingStrictGateBinding = structuredClone(currentInstance);
  delete missingStrictGateBinding.metadata.governance_binding.strict_gate_receipt_path;
  writeProjectFile(
    project,
    currentInstancePath,
    `${JSON.stringify(missingStrictGateBinding, null, 2)}\n`,
  );
  assertLifecycleBindingTamperBlocked("missing-strict-gate-binding");
  writeProjectFile(
    project,
    currentInstancePath,
    `${JSON.stringify(currentInstance, null, 2)}\n`,
  );
  const restoredStrictGateBindingStatus = mustRunJson([
    "status", "--root", project,
  ], project);
  assert.equal(restoredStrictGateBindingStatus.next_action.kind, "certify_lifecycle");

  const mismatchedStoryBinding = structuredClone(currentInstance);
  mismatchedStoryBinding.metadata.governance_binding.story_id = "ST-OTHER";
  writeProjectFile(
    project,
    currentInstancePath,
    `${JSON.stringify(mismatchedStoryBinding, null, 2)}\n`,
  );
  assertLifecycleBindingTamperBlocked("mismatched-story-binding");
  writeProjectFile(
    project,
    currentInstancePath,
    `${JSON.stringify(currentInstance, null, 2)}\n`,
  );
  const restoredStoryBindingStatus = mustRunJson([
    "status", "--root", project,
  ], project);
  assert.equal(restoredStoryBindingStatus.next_action.kind, "certify_lifecycle");

  const taskStartPath = `.sdlc/stories/${fixture.storyId}/task-start.json`;
  const taskStartWithoutWorkflowRef = structuredClone(taskStartReceipt);
  delete taskStartWithoutWorkflowRef.workflow_instance_ref;
  const mismatchedStoryBindingWithoutTaskStartRef = structuredClone(currentInstance);
  mismatchedStoryBindingWithoutTaskStartRef.metadata.governance_binding.story_id = "ST-OTHER";
  writeProjectFile(
    project,
    taskStartPath,
    `${JSON.stringify(taskStartWithoutWorkflowRef, null, 2)}\n`,
  );
  writeProjectFile(
    project,
    currentInstancePath,
    `${JSON.stringify(mismatchedStoryBindingWithoutTaskStartRef, null, 2)}\n`,
  );
  assertLifecycleBindingTamperBlocked("missing-task-start-workflow-ref");
  writeProjectFile(
    project,
    taskStartPath,
    `${JSON.stringify(taskStartReceipt, null, 2)}\n`,
  );
  writeProjectFile(
    project,
    currentInstancePath,
    `${JSON.stringify(currentInstance, null, 2)}\n`,
  );
  const restoredTaskStartBindingStatus = mustRunJson([
    "status", "--root", project,
  ], project);
  assert.equal(restoredTaskStartBindingStatus.next_action.kind, "certify_lifecycle");

  const legacyTaskStartWithoutWorkflowRef = structuredClone(taskStartReceipt);
  legacyTaskStartWithoutWorkflowRef.schema_version = "profile-task-start-receipt:v1";
  delete legacyTaskStartWithoutWorkflowRef.workflow_instance_ref;
  const mismatchedStoryBindingWithLegacyTaskStart = structuredClone(currentInstance);
  mismatchedStoryBindingWithLegacyTaskStart.metadata.governance_binding.story_id = "ST-OTHER";
  writeProjectFile(
    project,
    taskStartPath,
    `${JSON.stringify(legacyTaskStartWithoutWorkflowRef, null, 2)}\n`,
  );
  writeProjectFile(
    project,
    currentInstancePath,
    `${JSON.stringify(mismatchedStoryBindingWithLegacyTaskStart, null, 2)}\n`,
  );
  assertLifecycleBindingTamperBlocked("legacy-task-start-without-workflow-ref");
  writeProjectFile(
    project,
    taskStartPath,
    `${JSON.stringify(taskStartReceipt, null, 2)}\n`,
  );
  writeProjectFile(
    project,
    currentInstancePath,
    `${JSON.stringify(currentInstance, null, 2)}\n`,
  );
  const restoredLegacyTaskStartStatus = mustRunJson([
    "status", "--root", project,
  ], project);
  assert.equal(restoredLegacyTaskStartStatus.next_action.kind, "certify_lifecycle");

  const finalReport = mustRunJson([
    "gate", "check",
    "--root", project,
    "--strict",
    "--story", fixture.storyId,
    "--lifecycle-complete",
  ], project);
  assert.equal(finalReport.status, "passed");
  assert.equal(finalReport.lifecycle_complete, true);
  assert.equal(finalReport.certification_level, "lifecycle_complete");
  assert.equal(finalReport.kind, "workflow_final_gate_receipt");
  assert.equal(finalReport.schema_version, "workflow-final-gate-receipt:v3");
  assert.equal(finalReport.final_receipt_path, finalReceiptPath);
  assert.equal(
    finalReport.lifecycle_workflow.selection_policy,
    "latest-created-at-then-instance-id:v1",
  );
  assert.equal(finalReport.lifecycle_workflow.story_id, fixture.storyId);
  assert.equal(finalReport.lifecycle_workflow.instance_id, workflowInstanceId);
  assert.match(finalReport.lifecycle_workflow.instance_hash, /^[a-f0-9]{64}$/u);
  assert.match(finalReport.lifecycle_workflow.effective_hash, /^[a-f0-9]{64}$/u);
  assert.equal(finalReport.lifecycle_workflow.terminal_state, "operations");
  assert.equal(
    finalReport.lifecycle_workflow.checkpoint_ref.path,
    `.sdlc/workflows/instances/${workflowInstanceId}/checkpoint.json`,
  );
  assert.match(
    finalReport.lifecycle_workflow.checkpoint_ref.checkpoint_hash,
    /^[a-f0-9]{64}$/u,
  );
  assert.equal(
    finalReport.lifecycle_workflow.checkpoint_ref.last_event_hash,
    finalReport.lifecycle_workflow.terminal_event_ref.event_hash,
  );
  assert.equal(
    finalReport.lifecycle_workflow.checkpoint_ref.sequence,
    finalReport.lifecycle_workflow.terminal_event_ref.sequence,
  );
  assert.equal(
    finalReport.lifecycle_workflow.event_count,
    finalReport.lifecycle_workflow.checkpoint_ref.sequence,
  );
  assert.ok(
    Date.parse(finalReport.checked_at)
      >= Date.parse(finalReport.lifecycle_workflow.terminal_event_ref.timestamp),
  );

  const receiptBytes = fs.readFileSync(path.join(project, finalReceiptPath));
  const receipt = readJson(project, finalReceiptPath);
  const {
    correlation_id: correlationId,
    ...canonicalFinalReport
  } = finalReport;
  assert.match(correlationId, /^corr-/u);
  assert.equal(Object.hasOwn(receipt, "correlation_id"), false);
  assert.deepEqual(receipt, canonicalFinalReport);
  const {
    receipt_hash: receiptHash,
    hash_algorithm: hashAlgorithm,
    ...receiptSubject
  } = receipt;
  assert.equal(hashAlgorithm, "sha256:stable-json:v1");
  assert.equal(receiptHash, computeStableHash(receiptSubject));

  const finalStepTamperProject = cloneTemporaryProject(
    project,
    "final-step-attestation-tamper",
  );
  const releaseStepRelativePath =
    `.sdlc/stories/${fixture.storyId}/steps/release.json`;
  const tamperedReleaseStep = readJson(
    finalStepTamperProject,
    releaseStepRelativePath,
  );
  tamperedReleaseStep.summary =
    `${tamperedReleaseStep.summary} Manual post-certification mutation.`;
  writeProjectFile(
    finalStepTamperProject,
    releaseStepRelativePath,
    `${JSON.stringify(tamperedReleaseStep, null, 2)}\n`,
  );
  fs.rmSync(path.join(finalStepTamperProject, finalReceiptPath));
  mustFail([
    "gate", "check",
    "--root", finalStepTamperProject,
    "--strict",
    "--story", fixture.storyId,
    "--lifecycle-complete",
  ], finalStepTamperProject, /phase 'release' completion is not currently attested.*sealed completion attestation/isu);
  const tamperedTerminalStatus = mustRunJson([
    "workflow", "instance", "status",
    "--root", finalStepTamperProject,
    "--id", workflowInstanceId,
  ], finalStepTamperProject);
  assert.equal(tamperedTerminalStatus.status, "blocked");
  assert.equal(tamperedTerminalStatus.state_terminal, true);
  assert.equal(tamperedTerminalStatus.terminal, false);
  assert.equal(tamperedTerminalStatus.current_phase_completion.ready, false);

  const certifiedStatus = mustRunJson([
    "status", "--root", project,
  ], project);
  assert.equal(certifiedStatus.next_action.kind, "none");
  assert.equal(certifiedStatus.next_action.reason, "completed_work_terminal");
  assert.match(certifiedStatus.next_action.label, /1 governed work item is terminal/u);
  assert.equal(certifiedStatus.next_action.terminal_work, 1);
  assert.notEqual(certifiedStatus.next_action.kind, "inspect_story_workflow");
  assert.equal(certifiedStatus.summary.available_work, 0);
  assert.equal(certifiedStatus.summary.active_work, 0);
  assert.equal(certifiedStatus.summary.completed_work, 1);
  const certifiedHumanStatus = mustRun([
    "status", "--root", project,
  ], project).stdout;
  assert.match(certifiedHumanStatus, /Outcome: Governed work is complete\./u);
  assert.match(
    certifiedHumanStatus,
    /no unfinished operational work or new onboarding step is waiting/iu,
  );
  assert.doesNotMatch(certifiedHumanStatus, /Prepare the initial context|Agree the first requirement/u);
  const certifiedItalianStatus = mustRun([
    "status", "--root", project, "--locale", "it",
  ], project).stdout;
  assert.match(certifiedItalianStatus, /Risultato: Il lavoro governato è completo\./u);
  assert.match(
    certifiedItalianStatus,
    /non sono in attesa attività operative incomplete né un nuovo onboarding/u,
  );
  assert.doesNotMatch(certifiedItalianStatus, /Prepara il contesto iniziale|Concorda il primo requisito/u);

  const terminalOrchestration = mustRunJson([
    "orchestrate", "status", "--root", project,
  ], project);
  const terminalStory = terminalOrchestration.stories
    .find((story) => story.id === fixture.storyId);
  assert.equal(terminalOrchestration.summary.available, 0);
  assert.equal(terminalOrchestration.summary.claimed, 0);
  assert.equal(terminalOrchestration.summary.terminal, 1);
  assert.equal(terminalStory.status, "done");
  assert.equal(terminalStory.phase, "operations");
  assert.equal(
    terminalStory.record_status,
    readJson(project, `.sdlc/stories/${fixture.storyId}/story.json`).status,
  );
  assert.equal(terminalStory.lifecycle_source, "workflow_final_receipt");
  assert.equal(terminalStory.orchestration_state, "terminal");

  const manifestProjectionProject = cloneTemporaryProject(
    project,
    "terminal-manifest-projection",
  );
  mustRun([
    "manifest", "rebuild", "--root", manifestProjectionProject,
  ], manifestProjectionProject);
  const manifest = readJson(
    manifestProjectionProject,
    ".sdlc/manifests/kb-manifest.json",
  );
  assert.equal(
    manifest.story_projection_schema_version,
    "effective-story-lifecycle:v1",
  );
  const manifestProjection = manifest.stories
    .find((story) => story.id === fixture.storyId);
  assert.equal(manifestProjection.status, "ready");
  assert.equal(manifestProjection.phase, "implementation");
  assert.equal(manifestProjection.record_status, "ready");
  assert.equal(manifestProjection.record_phase, "implementation");
  assert.equal(manifestProjection.effective_status, "done");
  assert.equal(manifestProjection.effective_phase, "operations");
  assert.equal(manifestProjection.lifecycle_terminal, true);
  assert.equal(manifestProjection.lifecycle_blocked, false);
  assert.equal(
    manifestProjection.lifecycle_source,
    "workflow_final_receipt",
  );
  assert.equal(manifestProjection.workflow_instance_id, workflowInstanceId);
  assert.deepEqual(
    readJson(
      manifestProjectionProject,
      `.sdlc/stories/${fixture.storyId}/story.json`,
    ),
    readJson(project, `.sdlc/stories/${fixture.storyId}/story.json`),
    "the derived manifest must not mutate the canonical story record",
  );

  const certifiedWorkflowStatus = mustRunJson([
    "workflow", "instance", "status",
    "--root", project,
    "--id", workflowInstanceId,
  ], project);
  assert.equal(certifiedWorkflowStatus.status, "terminal");
  assert.equal(certifiedWorkflowStatus.state_terminal, true);
  assert.equal(certifiedWorkflowStatus.terminal, true);
  assert.equal(certifiedWorkflowStatus.final_receipt_exists, true);
  assert.equal(certifiedWorkflowStatus.final_receipt_valid, true);

  const finalReceiptIsValid = (target, options = {}) => mustRunJson([
    "workflow", "instance", "status",
    "--root", target,
    "--id", workflowInstanceId,
  ], target, options).final_receipt_valid;

  const certificationGitEntries = readJson(project, finalReceiptPath)
    .freshness_proof.git_scope.scoped_changes;
  const trackedCertificationEntry = certificationGitEntries
    .find((entry) => entry.path === "docs/tracked-runtime.md");
  assert.equal(trackedCertificationEntry.index_matches_head, true);
  assert.equal(trackedCertificationEntry.index_matches_worktree, false);
  const trackedCommitProject = cloneTemporaryProject(
    project,
    "final-receipt-tracked-commit",
  );
  mustGit(trackedCommitProject, ["add", "docs/tracked-runtime.md"]);
  assert.equal(finalReceiptIsValid(trackedCommitProject), true);
  mustGit(
    trackedCommitProject,
    ["commit", "-m", "test: persist exact tracked-file change"],
  );
  assert.equal(finalReceiptIsValid(trackedCommitProject), true);

  const deletedCertificationEntry = certificationGitEntries
    .find((entry) => entry.path === "docs/deleted-runtime.md");
  assert.equal(deletedCertificationEntry.index_matches_head, true);
  assert.equal(deletedCertificationEntry.index_matches_worktree, false);
  assert.equal(deletedCertificationEntry.working_tree.present, false);
  const deletionCommitProject = cloneTemporaryProject(
    project,
    "final-receipt-deletion-commit",
  );
  mustGit(deletionCommitProject, ["add", "-u", "docs/deleted-runtime.md"]);
  assert.equal(finalReceiptIsValid(deletionCommitProject), true);
  mustGit(
    deletionCommitProject,
    ["commit", "-m", "test: persist exact certified deletion"],
  );
  assert.equal(finalReceiptIsValid(deletionCommitProject), true);

  const divergentIndexProject = cloneTemporaryProject(
    project,
    "final-receipt-divergent-index",
  );
  const divergentBlob = mustGit(
    divergentIndexProject,
    ["hash-object", "src/index.mjs"],
  );
  mustGit(divergentIndexProject, [
    "update-index",
    "--add",
    "--cacheinfo",
    `100644,${divergentBlob},docs/implementation-summary.md`,
  ]);
  assert.equal(finalReceiptIsValid(divergentIndexProject), false);
  mustGit(
    divergentIndexProject,
    ["commit", "-m", "test: persist a divergent staged blob"],
  );
  assert.equal(finalReceiptIsValid(divergentIndexProject), false);

  const changedBrokenSymlinkProject = cloneTemporaryProject(
    project,
    "final-receipt-broken-symlink",
  );
  const changedBrokenSymlinkPath = path.join(
    changedBrokenSymlinkProject,
    "docs",
    "deleted-runtime.md",
  );
  fs.symlinkSync("missing-runtime-target-b", changedBrokenSymlinkPath);
  assert.equal(finalReceiptIsValid(changedBrokenSymlinkProject), false);

  const certifiedSymlinkProject = cloneTemporaryProject(
    project,
    "final-receipt-certified-symlink",
  );
  fs.rmSync(path.join(certifiedSymlinkProject, finalReceiptPath));
  const certifiedSymlinkPath = path.join(
    certifiedSymlinkProject,
    "docs",
    "certified-runtime-link",
  );
  fs.symlinkSync("tracked-runtime.md", certifiedSymlinkPath);
  const certifiedSymlinkReport = mustRunJson([
    "gate", "check",
    "--root", certifiedSymlinkProject,
    "--strict",
    "--story", fixture.storyId,
    "--lifecycle-complete",
  ], certifiedSymlinkProject);
  assert.equal(certifiedSymlinkReport.status, "passed");
  assert.equal(finalReceiptIsValid(certifiedSymlinkProject), true);
  const changedCertifiedSymlinkProject = cloneTemporaryProject(
    certifiedSymlinkProject,
    "final-receipt-certified-symlink-target",
  );
  const changedCertifiedSymlinkPath = path.join(
    changedCertifiedSymlinkProject,
    "docs",
    "certified-runtime-link",
  );
  assert.equal(
    fs.readlinkSync(changedCertifiedSymlinkPath),
    "tracked-runtime.md",
  );
  assert.equal(finalReceiptIsValid(changedCertifiedSymlinkProject), true);
  fs.unlinkSync(changedCertifiedSymlinkPath);
  fs.symlinkSync("untouched-runtime.md", changedCertifiedSymlinkPath);
  assert.equal(finalReceiptIsValid(changedCertifiedSymlinkProject), false);

  const infoExcludeProject = cloneTemporaryProject(
    project,
    "final-receipt-info-exclude",
  );
  writeProjectFile(
    infoExcludeProject,
    "docs/hidden-after-certification.md",
    "Governed content must remain visible even when info/exclude changes.\n",
  );
  fs.appendFileSync(
    path.join(infoExcludeProject, ".git", "info", "exclude"),
    "\ndocs/hidden-after-certification.md\n",
    "utf8",
  );
  assert.equal(finalReceiptIsValid(infoExcludeProject), false);

  const worktreeIgnoreProject = cloneTemporaryProject(
    project,
    "final-receipt-worktree-ignore",
  );
  writeProjectFile(
    worktreeIgnoreProject,
    "docs/hidden-after-certification.md",
    "Governed content must remain visible through a worktree ignore.\n",
  );
  writeProjectFile(
    worktreeIgnoreProject,
    ".gitignore",
    "docs/hidden-after-certification.md\n",
  );
  assert.equal(finalReceiptIsValid(worktreeIgnoreProject), false);

  const globalIgnoreProject = cloneTemporaryProject(
    project,
    "final-receipt-global-ignore",
  );
  writeProjectFile(
    globalIgnoreProject,
    "docs/hidden-after-certification.md",
    "Governed content must remain visible through a global ignore.\n",
  );
  const fakeHome = path.join(globalIgnoreProject, "test-global-home");
  const globalExcludesPath = path.join(fakeHome, "global-excludes");
  fs.mkdirSync(fakeHome, { recursive: true });
  fs.writeFileSync(
    globalExcludesPath,
    "docs/hidden-after-certification.md\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(fakeHome, ".gitconfig"),
    `[core]\n\texcludesFile = ${globalExcludesPath}\n`,
    "utf8",
  );
  assert.equal(
    finalReceiptIsValid(globalIgnoreProject, { env: { HOME: fakeHome } }),
    false,
  );

  const outsideScopeGitlinkProject = cloneTemporaryProject(
    project,
    "final-receipt-outside-scope-gitlink",
  );
  const gitlinkCommit = mustGit(outsideScopeGitlinkProject, ["rev-parse", "HEAD"]);
  mustGit(outsideScopeGitlinkProject, [
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${gitlinkCommit},vendor/outside-scope-submodule`,
  ]);
  assert.equal(finalReceiptIsValid(outsideScopeGitlinkProject), true);

  const inScopeGitlinkProject = cloneTemporaryProject(
    project,
    "final-receipt-in-scope-gitlink",
  );
  mustGit(inScopeGitlinkProject, [
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${gitlinkCommit},docs/in-scope-submodule`,
  ]);
  assert.equal(finalReceiptIsValid(inScopeGitlinkProject), false);

  const committedCertificationProject = cloneTemporaryProject(
    project,
    "final-receipt-clean-commit",
  );
  mustGit(committedCertificationProject, ["add", "-A"]);
  assert.equal(finalReceiptIsValid(committedCertificationProject), true);
  mustGit(
    committedCertificationProject,
    ["commit", "-m", "test: persist certified local project"],
  );
  assert.equal(
    mustGit(committedCertificationProject, ["status", "--porcelain=v1"]),
    "",
  );
  const committedCertificationStatus = mustRunJson([
    "workflow", "instance", "status",
    "--root", committedCertificationProject,
    "--id", workflowInstanceId,
  ], committedCertificationProject);
  assert.equal(committedCertificationStatus.status, "terminal");
  assert.equal(committedCertificationStatus.final_receipt_valid, true);

  const divergentModeProject = cloneTemporaryProject(
    committedCertificationProject,
    "final-receipt-divergent-mode",
  );
  mustGit(divergentModeProject, ["config", "core.filemode", "false"]);
  mustGit(
    divergentModeProject,
    ["update-index", "--chmod=+x", "docs/implementation-summary.md"],
  );
  assert.equal(finalReceiptIsValid(divergentModeProject), false);
  mustGit(
    divergentModeProject,
    ["commit", "-m", "test: persist divergent executable mode"],
  );
  assert.equal(finalReceiptIsValid(divergentModeProject), false);

  const alternateIndexProject = cloneTemporaryProject(
    committedCertificationProject,
    "final-receipt-alternate-index",
  );
  const alternateIndexPath = path.join(
    alternateIndexProject,
    ".git",
    "certified-index-copy",
  );
  fs.copyFileSync(
    path.join(alternateIndexProject, ".git", "index"),
    alternateIndexPath,
  );
  mustGit(
    alternateIndexProject,
    ["update-index", "--chmod=+x", "docs/implementation-summary.md"],
  );
  assert.equal(finalReceiptIsValid(alternateIndexProject), false);
  assert.equal(
    finalReceiptIsValid(alternateIndexProject, {
      env: { GIT_INDEX_FILE: alternateIndexPath },
    }),
    false,
  );

  const graftsProject = cloneTemporaryProject(
    committedCertificationProject,
    "final-receipt-grafts",
  );
  const graftHead = mustGit(graftsProject, ["rev-parse", "HEAD"]);
  const graftParent = mustGit(graftsProject, ["rev-parse", "HEAD^"]);
  fs.writeFileSync(
    path.join(graftsProject, ".git", "info", "grafts"),
    `${graftHead} ${graftParent}\n`,
    "utf8",
  );
  assert.equal(finalReceiptIsValid(graftsProject), false);

  const shallowProject = cloneTemporaryProject(
    committedCertificationProject,
    "final-receipt-shallow-history",
  );
  fs.writeFileSync(
    path.join(shallowProject, ".git", "shallow"),
    `${mustGit(shallowProject, ["rev-parse", "HEAD"])}\n`,
    "utf8",
  );
  assert.equal(
    mustGit(shallowProject, ["rev-parse", "--is-shallow-repository"]),
    "true",
  );
  assert.equal(finalReceiptIsValid(shallowProject), false);

  const rewrittenHistoryProject = cloneTemporaryProject(
    committedCertificationProject,
    "final-receipt-rewritten-history",
  );
  const rewrittenTree = mustGit(
    rewrittenHistoryProject,
    ["rev-parse", "HEAD^{tree}"],
  );
  const nonDescendantCommit = mustGit(
    rewrittenHistoryProject,
    ["commit-tree", rewrittenTree, "-m", "test: same tree outside certified ancestry"],
  );
  mustGit(
    rewrittenHistoryProject,
    ["reset", "--hard", nonDescendantCommit],
  );
  assert.equal(
    mustGit(rewrittenHistoryProject, ["status", "--porcelain=v1"]),
    "",
  );
  assert.equal(finalReceiptIsValid(rewrittenHistoryProject), false);

  const untrackedAfterCommitProject = cloneTemporaryProject(
    committedCertificationProject,
    "final-receipt-rm-cached",
  );
  mustGit(
    untrackedAfterCommitProject,
    ["rm", "--cached", "--", "docs/implementation-summary.md"],
  );
  assert.equal(finalReceiptIsValid(untrackedAfterCommitProject), false);
  mustGit(
    untrackedAfterCommitProject,
    ["commit", "-m", "test: remove certified artifact from Git"],
  );
  assert.equal(finalReceiptIsValid(untrackedAfterCommitProject), false);

  const transientHistoryProject = cloneTemporaryProject(
    committedCertificationProject,
    "final-receipt-transient-history",
  );
  writeProjectFile(
    transientHistoryProject,
    "docs/transient-after-certification.md",
    "This path must remain visible in the post-certification history union.\n",
  );
  mustGit(
    transientHistoryProject,
    ["add", "docs/transient-after-certification.md"],
  );
  mustGit(
    transientHistoryProject,
    ["commit", "-m", "test: add transient governed path"],
  );
  mustGit(
    transientHistoryProject,
    ["rm", "docs/transient-after-certification.md"],
  );
  mustGit(
    transientHistoryProject,
    ["commit", "-m", "test: remove transient governed path"],
  );
  assert.equal(finalReceiptIsValid(transientHistoryProject), false);

  const transientRevertProject = cloneTemporaryProject(
    committedCertificationProject,
    "final-receipt-transient-revert",
  );
  const transientRevertPath = path.join(
    transientRevertProject,
    "docs",
    "implementation-summary.md",
  );
  const certifiedTransientBytes = fs.readFileSync(transientRevertPath);
  fs.appendFileSync(
    transientRevertPath,
    "\nDivergent transient governed content.\n",
    "utf8",
  );
  mustGit(transientRevertProject, ["add", "docs/implementation-summary.md"]);
  mustGit(
    transientRevertProject,
    ["commit", "-m", "test: commit divergent transient content"],
  );
  fs.writeFileSync(transientRevertPath, certifiedTransientBytes);
  mustGit(transientRevertProject, ["add", "docs/implementation-summary.md"]);
  mustGit(
    transientRevertProject,
    ["commit", "-m", "test: restore certified content"],
  );
  assert.equal(finalReceiptIsValid(transientRevertProject), false);

  const replaceRefProject = cloneTemporaryProject(
    committedCertificationProject,
    "final-receipt-replace-ref",
  );
  const replaceRefPath = path.join(
    replaceRefProject,
    "docs",
    "implementation-summary.md",
  );
  const replacementBaseBytes = fs.readFileSync(replaceRefPath);
  const replacementBaseCommit = mustGit(replaceRefProject, ["rev-parse", "HEAD"]);
  const replacementBaseTree = mustGit(replaceRefProject, ["rev-parse", "HEAD^{tree}"]);
  fs.appendFileSync(
    replaceRefPath,
    "\nDivergent commit hidden by a local Git replace ref.\n",
    "utf8",
  );
  mustGit(replaceRefProject, ["add", "docs/implementation-summary.md"]);
  mustGit(
    replaceRefProject,
    ["commit", "-m", "test: create replace-ref attack commit"],
  );
  const replacedCommit = mustGit(replaceRefProject, ["rev-parse", "HEAD"]);
  const replacementCommit = mustGit(replaceRefProject, [
    "commit-tree",
    replacementBaseTree,
    "-p",
    replacementBaseCommit,
    "-m",
    "test: replacement object with certified tree",
  ]);
  mustGit(replaceRefProject, ["replace", replacedCommit, replacementCommit]);
  fs.writeFileSync(replaceRefPath, replacementBaseBytes);
  mustGit(replaceRefProject, ["add", "docs/implementation-summary.md"]);
  assert.equal(finalReceiptIsValid(replaceRefProject), false);

  const assumeUnchangedProject = cloneTemporaryProject(
    committedCertificationProject,
    "final-receipt-assume-unchanged",
  );
  mustGit(
    assumeUnchangedProject,
    ["update-index", "--assume-unchanged", "docs/untouched-runtime.md"],
  );
  fs.appendFileSync(
    path.join(assumeUnchangedProject, "docs", "untouched-runtime.md"),
    "\nHidden assume-unchanged mutation.\n",
    "utf8",
  );
  assert.equal(finalReceiptIsValid(assumeUnchangedProject), false);

  const skipWorktreeProject = cloneTemporaryProject(
    committedCertificationProject,
    "final-receipt-skip-worktree",
  );
  mustGit(
    skipWorktreeProject,
    ["update-index", "--skip-worktree", "docs/untouched-runtime.md"],
  );
  fs.appendFileSync(
    path.join(skipWorktreeProject, "docs", "untouched-runtime.md"),
    "\nHidden skip-worktree mutation.\n",
    "utf8",
  );
  assert.equal(finalReceiptIsValid(skipWorktreeProject), false);

  const legacyFreshnessProject = cloneTemporaryProject(
    committedCertificationProject,
    "final-receipt-v1-freshness",
  );
  const legacyFreshnessReceipt = readJson(
    legacyFreshnessProject,
    finalReceiptPath,
  );
  legacyFreshnessReceipt.freshness_proof.schema_version =
    "workflow-final-freshness-proof:v1";
  const {
    proof_hash: ignoredLegacyFreshnessHash,
    ...legacyFreshnessSubject
  } = legacyFreshnessReceipt.freshness_proof;
  legacyFreshnessReceipt.freshness_proof.proof_hash =
    computeStableHash(legacyFreshnessSubject);
  const {
    receipt_hash: ignoredLegacyReceiptHash,
    hash_algorithm: ignoredLegacyReceiptAlgorithm,
    ...legacyReceiptSubject
  } = legacyFreshnessReceipt;
  legacyFreshnessReceipt.receipt_hash = computeStableHash(legacyReceiptSubject);
  fs.writeFileSync(
    path.join(legacyFreshnessProject, finalReceiptPath),
    `${JSON.stringify(legacyFreshnessReceipt, null, 2)}\n`,
    "utf8",
  );
  assert.equal(finalReceiptIsValid(legacyFreshnessProject), false);
  const resealedFreshness = mustRunJson([
    "gate", "check",
    "--root", legacyFreshnessProject,
    "--strict",
    "--story", fixture.storyId,
    "--lifecycle-complete",
  ], legacyFreshnessProject);
  assert.equal(
    resealedFreshness.freshness_proof.schema_version,
    "workflow-final-freshness-proof:v2",
  );
  assert.equal(finalReceiptIsValid(legacyFreshnessProject), true);

  fs.appendFileSync(
    path.join(committedCertificationProject, "docs", "implementation-summary.md"),
    "\nChanged after the clean certification commit.\n",
    "utf8",
  );
  const changedAfterCommitStatus = mustRunJson([
    "workflow", "instance", "status",
    "--root", committedCertificationProject,
    "--id", workflowInstanceId,
  ], committedCertificationProject);
  assert.equal(changedAfterCommitStatus.status, "blocked");
  assert.equal(changedAfterCommitStatus.final_receipt_valid, false);

  const trackedInScopePath = path.join(
    project,
    "docs",
    "untouched-runtime.md",
  );
  const trackedInScopeBytes = fs.readFileSync(trackedInScopePath);
  fs.appendFileSync(trackedInScopePath, "changed after certification\n", "utf8");
  assert.equal(mustRunJson([
    "workflow", "instance", "status",
    "--root", project,
    "--id", workflowInstanceId,
  ], project).final_receipt_valid, false);
  fs.writeFileSync(trackedInScopePath, trackedInScopeBytes);

  const newInScopePath = path.join(project, "docs", "new-runtime-file.md");
  fs.writeFileSync(newInScopePath, "# New in-scope runtime file\n", "utf8");
  assert.equal(mustRunJson([
    "workflow", "instance", "status",
    "--root", project,
    "--id", workflowInstanceId,
  ], project).final_receipt_valid, false);
  fs.rmSync(newInScopePath);

  const postFinalOutsideScopePath = path.join(project, "src", "index.mjs");
  const outsideScopeBytes = fs.readFileSync(postFinalOutsideScopePath);
  fs.appendFileSync(
    postFinalOutsideScopePath,
    "// unrelated outside story scope\n",
    "utf8",
  );
  const outsideScopeStatus = mustRunJson([
    "workflow", "instance", "status",
    "--root", project,
    "--id", workflowInstanceId,
  ], project);
  assert.equal(outsideScopeStatus.status, "terminal");
  assert.equal(outsideScopeStatus.final_receipt_valid, true);
  fs.writeFileSync(postFinalOutsideScopePath, outsideScopeBytes);

  const requirementScopedReleaseSibling = path.join(
    fixture.localReleaseRoot,
    "sibling-unrelated.txt",
  );
  fs.writeFileSync(
    requirementScopedReleaseSibling,
    "This sibling is outside the release write path but remains inside the requirement scope.\n",
    "utf8",
  );
  const requirementScopedReleaseStatus = mustRunJson([
    "workflow", "instance", "status",
    "--root", project,
    "--id", workflowInstanceId,
  ], project);
  assert.equal(requirementScopedReleaseStatus.status, "blocked");
  assert.equal(requirementScopedReleaseStatus.final_receipt_valid, false);
  fs.rmSync(requirementScopedReleaseSibling);

  const certifiedLocalReleaseArtifactPath = path.join(
    fixture.localReleaseOutput,
    "release-proof.txt",
  );
  const certifiedLocalReleaseArtifactBytes = fs.readFileSync(
    certifiedLocalReleaseArtifactPath,
  );
  fs.appendFileSync(
    certifiedLocalReleaseArtifactPath,
    "tampered after lifecycle certification\n",
    "utf8",
  );
  const changedLocalReleaseStatus = mustRunJson([
    "workflow", "instance", "status",
    "--root", project,
    "--id", workflowInstanceId,
  ], project);
  assert.equal(changedLocalReleaseStatus.status, "blocked");
  assert.equal(changedLocalReleaseStatus.final_receipt_valid, false);
  fs.writeFileSync(
    certifiedLocalReleaseArtifactPath,
    certifiedLocalReleaseArtifactBytes,
  );
  const restoredLocalReleaseStatus = mustRunJson([
    "workflow", "instance", "status",
    "--root", project,
    "--id", workflowInstanceId,
  ], project);
  assert.equal(restoredLocalReleaseStatus.status, "terminal");
  assert.equal(restoredLocalReleaseStatus.final_receipt_valid, true);

  const originalLocalReleaseRoot = fixture.localReleaseRoot;
  const localReleaseRootBackup = temporaryProject("local-release-root-backup");
  const movedLocalReleaseRoot = path.join(
    localReleaseRootBackup,
    "original-root",
  );
  fs.renameSync(originalLocalReleaseRoot, movedLocalReleaseRoot);
  fs.cpSync(movedLocalReleaseRoot, originalLocalReleaseRoot, {
    recursive: true,
    force: true,
    preserveTimestamps: true,
  });
  const replacedLocalReleaseRootStatus = mustRunJson([
    "workflow", "instance", "status",
    "--root", project,
    "--id", workflowInstanceId,
  ], project);
  assert.equal(replacedLocalReleaseRootStatus.status, "blocked");
  assert.equal(replacedLocalReleaseRootStatus.final_receipt_valid, false);
  fs.rmSync(originalLocalReleaseRoot, { recursive: true, force: true });
  fs.renameSync(movedLocalReleaseRoot, originalLocalReleaseRoot);
  const restoredLocalReleaseRootStatus = mustRunJson([
    "workflow", "instance", "status",
    "--root", project,
    "--id", workflowInstanceId,
  ], project);
  assert.equal(restoredLocalReleaseRootStatus.status, "terminal");
  assert.equal(restoredLocalReleaseRootStatus.final_receipt_valid, true);

  const resurrectionProject = cloneTemporaryProject(
    project,
    "final-receipt-output-resurrection",
  );
  const resurrectionReceiptPath = path.join(
    resurrectionProject,
    finalReceiptPath,
  );
  const resurrectionReceiptBefore = fs.readFileSync(resurrectionReceiptPath);
  const resurrectionReceiptRecordBefore = JSON.parse(
    resurrectionReceiptBefore,
  );
  assert.equal(
    resurrectionReceiptRecordBefore.freshness_proof.schema_version,
    "workflow-final-freshness-proof:v2",
  );
  const independentProject = cloneTemporaryProject(
    project,
    "final-receipt-independent-commit",
  );
  writeProjectFile(
    independentProject,
    "src/independent-story-change.mjs",
    "export const independentStoryChange = true;\n",
  );
  mustGit(independentProject, ["add", "src/independent-story-change.mjs"]);
  mustGit(
    independentProject,
    ["commit", "-m", "test: independent story outside certified scope"],
  );
  const independentCommitStatus = mustRunJson([
    "workflow", "instance", "status",
    "--root", independentProject,
    "--id", workflowInstanceId,
  ], independentProject);
  assert.equal(independentCommitStatus.status, "terminal");
  assert.equal(independentCommitStatus.final_receipt_valid, true);
  const resurrectionRegistry = readJson(
    resurrectionProject,
    ".sdlc/output-contracts/registry.json",
  );
  const resurrectionLink = resurrectionRegistry.links.find((link) =>
    link.story_id === fixture.storyId
    && link.artifact_type === "implementation-summary");
  assert.ok(resurrectionLink);
  const resurrectionArtifactPath = path.join(
    resurrectionProject,
    resurrectionLink.artifact_path,
  );
  fs.appendFileSync(
    resurrectionArtifactPath,
    "\nThis governed output was refreshed after final certification.\n",
    "utf8",
  );
  const artifactChangedStatus = mustRunJson([
    "workflow", "instance", "status",
    "--root", resurrectionProject,
    "--id", workflowInstanceId,
  ], resurrectionProject);
  assert.equal(artifactChangedStatus.status, "blocked");
  assert.equal(artifactChangedStatus.final_receipt_exists, true);
  assert.equal(artifactChangedStatus.final_receipt_valid, false);

  mustRun([
    "output", "link",
    "--root", resurrectionProject,
    "--story", fixture.storyId,
    "--type", resurrectionLink.artifact_type,
    "--artifact", resurrectionLink.artifact_path,
    "--template", resurrectionLink.template_id,
    "--mode", resurrectionLink.mode,
    "--requirement", fixture.requirementId,
    "--id", resurrectionLink.id,
    "--authorization", fixture.storyActionAuthorizationId,
  ], resurrectionProject);
  assert.deepEqual(
    fs.readFileSync(resurrectionReceiptPath),
    resurrectionReceiptBefore,
  );
  const relinkedWithoutResealStatus = mustRunJson([
    "workflow", "instance", "status",
    "--root", resurrectionProject,
    "--id", workflowInstanceId,
  ], resurrectionProject);
  assert.equal(relinkedWithoutResealStatus.status, "blocked");
  assert.equal(relinkedWithoutResealStatus.final_receipt_exists, true);
  assert.equal(relinkedWithoutResealStatus.final_receipt_valid, false);

  const resealedResurrectionReport = mustRunJson([
    "gate", "check",
    "--root", resurrectionProject,
    "--strict",
    "--story", fixture.storyId,
    "--lifecycle-complete",
  ], resurrectionProject);
  assert.equal(resealedResurrectionReport.status, "passed");
  assert.notEqual(
    resealedResurrectionReport.freshness_proof.proof_hash,
    resurrectionReceiptRecordBefore.freshness_proof.proof_hash,
  );
  const resealedResurrectionStatus = mustRunJson([
    "workflow", "instance", "status",
    "--root", resurrectionProject,
    "--id", workflowInstanceId,
  ], resurrectionProject);
  assert.equal(resealedResurrectionStatus.status, "terminal");
  assert.equal(resealedResurrectionStatus.final_receipt_valid, true);

  const statusReceiptAbsolutePath = path.join(project, finalReceiptPath);
  const statusReceiptBackupPath = `${statusReceiptAbsolutePath}.status-missing`;
  fs.renameSync(statusReceiptAbsolutePath, statusReceiptBackupPath);
  try {
    const awaitingCertificationWorkflowStatus = mustRunJson([
      "workflow", "instance", "status",
      "--root", project,
      "--id", workflowInstanceId,
    ], project);
    assert.equal(
      awaitingCertificationWorkflowStatus.status,
      "awaiting_certification",
    );
    assert.equal(awaitingCertificationWorkflowStatus.state_terminal, true);
    assert.equal(awaitingCertificationWorkflowStatus.terminal, false);
    assert.equal(awaitingCertificationWorkflowStatus.final_receipt_exists, false);
    assert.equal(awaitingCertificationWorkflowStatus.final_receipt_valid, false);
  } finally {
    fs.renameSync(statusReceiptBackupPath, statusReceiptAbsolutePath);
  }

  const terminalPlan = mustRunJson([
    "orchestrate", "plan", "--root", project,
  ], project);
  assert.equal(
    terminalPlan.candidates.some((candidate) => candidate.story_id === fixture.storyId),
    false,
  );

  const certifiedContractPath = path.join(
    project,
    `.sdlc/contracts/${fixture.contractId}.json`,
  );
  const certifiedContractBytes = fs.readFileSync(certifiedContractPath);
  const changedCertifiedContract = JSON.parse(certifiedContractBytes);
  changedCertifiedContract.purpose =
    `${changedCertifiedContract.purpose} Changed after final certification.`;
  fs.writeFileSync(
    certifiedContractPath,
    `${JSON.stringify(changedCertifiedContract, null, 2)}\n`,
    "utf8",
  );
  const changedContractGate = mustFail([
    "gate", "check",
    "--root", project,
    "--strict",
    "--story", fixture.storyId,
    "--lifecycle-complete",
    "--json",
  ], project, /contract CONTRACT-FINAL\.json approved human gate is stale|Delivery autonomy profile AUT-FINAL is stale for contract CONTRACT-FINAL/su);
  const changedContractGateReport = JSON.parse(changedContractGate.stdout);
  assert.equal(changedContractGateReport.status, "failed");
  assert.deepEqual(fs.readFileSync(path.join(project, finalReceiptPath)), receiptBytes);

  const changedContractStatus = mustRunJson([
    "status", "--root", project,
  ], project);
  assert.equal(changedContractStatus.summary.completed_work, 0);
  assert.ok(changedContractStatus.summary.blocked_work >= 1);

  const changedContractOrchestration = mustRunJson([
    "orchestrate", "status", "--root", project,
  ], project);
  const changedContractStory = changedContractOrchestration.stories
    .find((story) => story.id === fixture.storyId);
  assert.equal(changedContractOrchestration.summary.terminal, 0);
  assert.ok(changedContractOrchestration.summary.blocked >= 1);
  assert.equal(changedContractStory.orchestration_state, "blocked");
  assert.equal(
    changedContractStory.lifecycle_source,
    "invalid_workflow_final_receipt",
  );
  const changedContractWorkflowStatus = mustRunJson([
    "workflow", "instance", "status",
    "--root", project,
    "--id", workflowInstanceId,
  ], project);
  assert.equal(changedContractWorkflowStatus.status, "blocked");
  assert.equal(changedContractWorkflowStatus.state_terminal, true);
  assert.equal(changedContractWorkflowStatus.terminal, false);
  assert.equal(changedContractWorkflowStatus.final_receipt_exists, true);
  assert.equal(changedContractWorkflowStatus.final_receipt_valid, false);

  const changedContractPlan = mustRunJson([
    "orchestrate", "plan", "--root", project,
  ], project);
  assert.equal(changedContractPlan.summary.terminal, 0);
  assert.ok(changedContractPlan.summary.blocked >= 1);
  assert.equal(
    changedContractPlan.candidates.some((candidate) =>
      candidate.story_id === fixture.storyId),
    false,
  );

  fs.writeFileSync(certifiedContractPath, certifiedContractBytes);
  const restoredContractStatus = mustRunJson([
    "status", "--root", project,
  ], project);
  assert.equal(restoredContractStatus.summary.completed_work, 1);
  assert.equal(restoredContractStatus.summary.blocked_work, 0);
  const restoredContractOrchestration = mustRunJson([
    "orchestrate", "status", "--root", project,
  ], project);
  const restoredContractStory = restoredContractOrchestration.stories
    .find((story) => story.id === fixture.storyId);
  assert.equal(restoredContractOrchestration.summary.terminal, 1);
  assert.equal(restoredContractOrchestration.summary.blocked, 0);
  assert.equal(restoredContractStory.orchestration_state, "terminal");
  assert.equal(
    restoredContractStory.lifecycle_source,
    "workflow_final_receipt",
  );
  const restoredContractWorkflowStatus = mustRunJson([
    "workflow", "instance", "status",
    "--root", project,
    "--id", workflowInstanceId,
  ], project);
  assert.equal(restoredContractWorkflowStatus.status, "terminal");
  assert.equal(restoredContractWorkflowStatus.state_terminal, true);
  assert.equal(restoredContractWorkflowStatus.terminal, true);
  assert.equal(restoredContractWorkflowStatus.final_receipt_exists, true);
  assert.equal(restoredContractWorkflowStatus.final_receipt_valid, true);

  const claimPath = `.sdlc/stories/${fixture.storyId}/claim.json`;
  const claimBeforeRejectedReplay = readJson(project, claimPath);
  mustFail([
    "story", "claim",
    "--root", project,
    "--id", fixture.storyId,
    "--agent", "replay-agent",
  ], project, /terminal status 'done'/u);
  mustFail([
    "story", "claim",
    "--root", project,
    "--id", fixture.storyId,
    "--agent", "replay-agent",
    "--force",
    "--actor-type", "human",
  ], project, /terminal status 'done'/u);
  assert.deepEqual(readJson(project, claimPath), claimBeforeRejectedReplay);

  const taskStartWithChangedSession = structuredClone(taskStartReceipt);
  taskStartWithChangedSession.audit = {
    ...(taskStartReceipt.audit || {}),
    run: {
      ...(taskStartReceipt.audit?.run || {}),
      session_id: "tampered-post-final-session",
    },
  };
  writeProjectFile(
    project,
    taskStartPath,
    `${JSON.stringify(taskStartWithChangedSession, null, 2)}\n`,
  );
  const tamperedTaskStartStatus = mustRunJson([
    "status", "--root", project,
  ], project);
  assert.equal(tamperedTaskStartStatus.summary.available_work, 0);
  assert.ok(tamperedTaskStartStatus.summary.blocked_work >= 1);
  assert.equal(
    tamperedTaskStartStatus.next_action.reason,
    "final_lifecycle_receipt_invalid",
  );
  const tamperedTaskStartOrchestration = mustRunJson([
    "orchestrate", "status", "--root", project,
  ], project);
  const tamperedTaskStartStory = tamperedTaskStartOrchestration.stories
    .find((story) => story.id === fixture.storyId);
  assert.equal(tamperedTaskStartStory.orchestration_state, "blocked");
  assert.equal(
    tamperedTaskStartStory.lifecycle_source,
    "invalid_workflow_final_receipt",
  );
  const tamperedTaskStartPlan = mustRunJson([
    "orchestrate", "plan", "--root", project,
  ], project);
  assert.equal(
    tamperedTaskStartPlan.candidates
      .some((candidate) => candidate.story_id === fixture.storyId),
    false,
  );
  mustFail([
    "story", "claim",
    "--root", project,
    "--id", fixture.storyId,
    "--agent", "task-start-tamper-agent",
  ], project, /invalid or unreadable final lifecycle receipt/u);
  mustFail([
    "story", "claim",
    "--root", project,
    "--id", fixture.storyId,
    "--agent", "task-start-tamper-agent",
    "--force",
    "--actor-type", "human",
  ], project, /invalid or unreadable final lifecycle receipt/u);
  assert.deepEqual(readJson(project, claimPath), claimBeforeRejectedReplay);
  writeProjectFile(
    project,
    taskStartPath,
    `${JSON.stringify(taskStartReceipt, null, 2)}\n`,
  );
  const restoredTaskStartOrchestration = mustRunJson([
    "orchestrate", "status", "--root", project,
  ], project);
  assert.equal(
    restoredTaskStartOrchestration.stories
      .find((story) => story.id === fixture.storyId)
      .orchestration_state,
    "terminal",
  );

  mustRun([
    "story", "create",
    "--root", project,
    "--id", "ST-FINAL-DOWNSTREAM",
    "--title", "Consume the certified upstream lifecycle",
    "--acceptance", "The upstream lifecycle is certified as done.",
  ], project);
  mustRun([
    "dependency", "propose",
    "--root", project,
    "--id", "DEP-FINAL-CERTIFICATION",
    "--edge", `ST-FINAL-DOWNSTREAM:${fixture.storyId}:blocks:implementation:done`,
  ], project);
  mustRun([
    "dependency", "approve",
    "--root", project,
    "--id", "DEP-FINAL-CERTIFICATION",
    ...humanApproval("Approve the exact certified-lifecycle dependency"),
  ], project);
  const certifiedDependencyStatus = mustRunJson([
    "orchestrate", "status", "--root", project,
  ], project);
  assert.equal(
    certifiedDependencyStatus.stories
      .find((story) => story.id === "ST-FINAL-DOWNSTREAM")
      .orchestration_state,
    "available",
  );

  fs.rmSync(path.join(project, finalReceiptPath));
  const missingReceiptStatus = mustRunJson([
    "status", "--root", project,
  ], project);
  assert.equal(missingReceiptStatus.next_action.kind, "certify_lifecycle");
  assert.equal(missingReceiptStatus.next_action.reason, "workflow_terminal");
  const missingReceiptOrchestration = mustRunJson([
    "orchestrate", "status", "--root", project,
  ], project);
  assert.equal(
    missingReceiptOrchestration.stories
      .find((story) => story.id === fixture.storyId)
      .orchestration_state,
    "blocked",
  );
  assert.equal(
    missingReceiptOrchestration.stories
      .find((story) => story.id === "ST-FINAL-DOWNSTREAM")
      .orchestration_state,
    "blocked",
  );
  const missingReceiptPlan = mustRunJson([
    "orchestrate", "plan", "--root", project,
  ], project);
  assert.equal(
    missingReceiptPlan.candidates.some((candidate) => candidate.story_id === fixture.storyId),
    false,
  );
  mustFail([
    "story", "claim",
    "--root", project,
    "--id", fixture.storyId,
    "--agent", "replay-agent",
  ], project, /invalid or unreadable final lifecycle receipt/u);
  mustFail([
    "story", "claim",
    "--root", project,
    "--id", fixture.storyId,
    "--agent", "replay-agent",
    "--force",
    "--actor-type", "human",
  ], project, /invalid or unreadable final lifecycle receipt/u);
  assert.deepEqual(readJson(project, claimPath), claimBeforeRejectedReplay);
  writeProjectFile(
    project,
    finalReceiptPath,
    `${JSON.stringify(receipt, null, 2)}\n`,
  );

  fs.writeFileSync(
    path.join(project, finalReceiptPath),
    `${JSON.stringify({
      ...receipt,
      checked_at: "2026-07-28T10:09:01.000Z",
    }, null, 2)}\n`,
    "utf8",
  );
  const tamperedReceiptStatus = mustRunJson([
    "status", "--root", project,
  ], project);
  assert.equal(tamperedReceiptStatus.next_action.kind, "recertify_lifecycle");
  assert.equal(
    tamperedReceiptStatus.next_action.reason,
    "final_lifecycle_receipt_invalid",
  );
  assert.match(
    tamperedReceiptStatus.next_action.command,
    /gate check --strict --story ST-FINAL --lifecycle-complete$/u,
  );
  const tamperedOrchestration = mustRunJson([
    "orchestrate", "status", "--root", project,
  ], project);
  const tamperedStory = tamperedOrchestration.stories
    .find((story) => story.id === fixture.storyId);
  assert.equal(tamperedStory.orchestration_state, "blocked");
  assert.match(tamperedStory.blockers.join("\n"), /final lifecycle receipt/u);
  assert.equal(
    tamperedOrchestration.stories
      .find((story) => story.id === "ST-FINAL-DOWNSTREAM")
      .orchestration_state,
    "blocked",
  );
  const tamperedPlan = mustRunJson([
    "orchestrate", "plan", "--root", project,
  ], project);
  assert.equal(
    tamperedPlan.candidates.some((candidate) => candidate.story_id === fixture.storyId),
    false,
  );
  mustFail([
    "story", "claim",
    "--root", project,
    "--id", fixture.storyId,
    "--agent", "replay-agent",
  ], project, /invalid or unreadable final lifecycle receipt/u);

  const {
    freshness_proof: ignoredFreshnessProof,
    receipt_hash: ignoredProofBoundReceiptHash,
    ...prooflessReceiptSubject
  } = receipt;
  assert.ok(ignoredFreshnessProof);
  assert.match(ignoredProofBoundReceiptHash, /^[a-f0-9]{64}$/u);
  const prooflessV2ReceiptSubject = {
    ...prooflessReceiptSubject,
    schema_version: "workflow-final-gate-receipt:v2",
  };
  const integritySealedProoflessReceipt = {
    ...prooflessV2ReceiptSubject,
    receipt_hash: computeStableHash(prooflessV2ReceiptSubject),
  };
  fs.writeFileSync(
    path.join(project, finalReceiptPath),
    `${JSON.stringify(integritySealedProoflessReceipt, null, 2)}\n`,
    "utf8",
  );
  const prooflessReceiptStatus = mustRunJson([
    "workflow", "instance", "status",
    "--root", project,
    "--id", workflowInstanceId,
  ], project);
  assert.equal(prooflessReceiptStatus.status, "blocked");
  assert.equal(prooflessReceiptStatus.final_receipt_exists, true);
  assert.equal(prooflessReceiptStatus.final_receipt_valid, false);
  const prooflessProjectStatus = mustRunJson([
    "status", "--root", project,
  ], project);
  assert.equal(prooflessProjectStatus.next_action.kind, "recertify_lifecycle");
  assert.equal(
    prooflessProjectStatus.next_action.reason,
    "final_lifecycle_receipt_invalid",
  );
  assert.match(
    prooflessProjectStatus.next_action.command,
    /gate check --strict --story ST-FINAL --lifecycle-complete$/u,
  );

  const claimBeforeDowngradeReplay = readJson(project, claimPath);
  assert.equal(claimBeforeDowngradeReplay.status, "released");
  fs.writeFileSync(
    path.join(project, finalReceiptPath),
    `${JSON.stringify({
      ...receipt,
      schema_version: "workflow-final-gate-receipt:v1",
    }, null, 2)}\n`,
    "utf8",
  );
  const downgradedReceiptStatus = mustRunJson([
    "status", "--root", project,
  ], project);
  assert.equal(downgradedReceiptStatus.summary.available_work, 0);
  const downgradedReceiptOrchestration = mustRunJson([
    "orchestrate", "status", "--root", project,
  ], project);
  const downgradedReceiptStory = downgradedReceiptOrchestration.stories
    .find((story) => story.id === fixture.storyId);
  assert.equal(downgradedReceiptStory.orchestration_state, "blocked");
  assert.equal(
    downgradedReceiptStory.lifecycle_source,
    "invalid_workflow_final_receipt",
  );
  const downgradedReceiptPlan = mustRunJson([
    "orchestrate", "plan", "--root", project,
  ], project);
  assert.equal(
    downgradedReceiptPlan.candidates
      .some((candidate) => candidate.story_id === fixture.storyId),
    false,
  );
  mustFail([
    "story", "claim",
    "--root", project,
    "--id", fixture.storyId,
    "--agent", "downgrade-replay-agent",
  ], project, /invalid or unreadable final lifecycle receipt/u);
  mustFail([
    "story", "claim",
    "--root", project,
    "--id", fixture.storyId,
    "--agent", "downgrade-replay-agent",
    "--force",
    "--actor-type", "human",
  ], project, /invalid or unreadable final lifecycle receipt/u);
  assert.deepEqual(readJson(project, claimPath), claimBeforeDowngradeReplay);

  const finalReceiptAbsolutePath = path.join(project, finalReceiptPath);
  fs.writeFileSync(finalReceiptAbsolutePath, receiptBytes);
  const certifiedStoryTracePath = path.join(
    project,
    `.sdlc/traces/${fixture.storyId}.jsonl`,
  );
  const certifiedStoryTraceCheckpointPath = path.join(
    project,
    `.sdlc/traces/.integrity/${fixture.storyId}.jsonl.checkpoint.json`,
  );
  const certifiedTraceBytes = fs.readFileSync(certifiedStoryTracePath);
  const certifiedTraceCheckpointBytes = fs.readFileSync(
    certifiedStoryTraceCheckpointPath,
  );
  const certifiedOutputRegistryPath = path.join(
    project,
    ".sdlc/output-contracts/registry.json",
  );
  const certifiedOutputRegistry = readJson(
    project,
    ".sdlc/output-contracts/registry.json",
  );
  const certifiedImplementationOutput = certifiedOutputRegistry.links.find(
    (link) =>
      link.story_id === fixture.storyId
      && link.artifact_type === "implementation-summary",
  );
  assert.ok(certifiedImplementationOutput);
  const certifiedOutputRegistryBytes = fs.readFileSync(
    certifiedOutputRegistryPath,
  );
  const replacementImplementationOutput = writeProjectFile(
    project,
    "docs/implementation-summary-v2.md",
    "# Replacement implementation summary\n\nThis output belongs to a later governed story.\n",
  );
  mustFail([
    "output", "link",
    "--root", project,
    "--story", fixture.storyId,
    "--type", "implementation-summary",
    "--artifact", replacementImplementationOutput,
    "--template", "implementation-summary-v1",
    "--mode", "new",
    "--requirement", fixture.requirementId,
    "--id", certifiedImplementationOutput.id,
    "--authorization", fixture.storyActionAuthorizationId,
  ], project, /already has (?:a valid terminal lifecycle certification|a terminal lifecycle receipt)/u);
  assert.deepEqual(
    fs.readFileSync(certifiedOutputRegistryPath),
    certifiedOutputRegistryBytes,
  );
  assert.deepEqual(fs.readFileSync(finalReceiptAbsolutePath), receiptBytes);
  assert.deepEqual(fs.readFileSync(certifiedStoryTracePath), certifiedTraceBytes);
  assert.deepEqual(
    fs.readFileSync(certifiedStoryTraceCheckpointPath),
    certifiedTraceCheckpointBytes,
  );
  for (const [type, evidence] of [
    ["test", testEvidence],
    ["release", releaseEvidence],
  ]) {
    mustFail([
      "trace", "append",
      "--root", project,
      "--story", fixture.storyId,
      "--type", type,
      "--outcome", "failed",
      "--summary", `Reject post-certification ${type} evidence`,
      "--evidence", evidence,
      "--actor", "codex",
      "--actor-type", "agent",
    ], project, /already has (?:a valid terminal lifecycle certification|a terminal lifecycle receipt)/u);
    assert.deepEqual(fs.readFileSync(finalReceiptAbsolutePath), receiptBytes);
    assert.deepEqual(fs.readFileSync(certifiedStoryTracePath), certifiedTraceBytes);
    assert.deepEqual(
      fs.readFileSync(certifiedStoryTraceCheckpointPath),
      certifiedTraceCheckpointBytes,
    );
  }

  const freshnessRoot = temporaryProject("final-receipt-freshness");
  const temporarilyMovedReceiptPath = path.join(
    freshnessRoot,
    "temporarily-moved-final-receipt.json",
  );
  fs.renameSync(finalReceiptAbsolutePath, temporarilyMovedReceiptPath);
  await new Promise((resolve) => setTimeout(resolve, 10));
  appendTrace(project, fixture.storyId, "test", "failed", testEvidence);
  assert.equal(fs.existsSync(finalReceiptAbsolutePath), false);
  const failedFreshnessTrace = fs.readFileSync(certifiedStoryTracePath, "utf8")
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .at(-1);
  const failedFreshnessCheckpoint = readJson(
    project,
    `.sdlc/traces/.integrity/${fixture.storyId}.jsonl.checkpoint.json`,
  );
  assert.equal(failedFreshnessTrace.type, "test");
  assert.equal(failedFreshnessTrace.outcome, "failed");
  assert.equal(
    failedFreshnessTrace._trace_integrity.schema_version,
    "trace-integrity-event:v1",
  );
  assert.equal(
    failedFreshnessCheckpoint.new_writes.last_event_hash,
    failedFreshnessTrace._trace_integrity.event_hash,
  );
  fs.renameSync(temporarilyMovedReceiptPath, finalReceiptAbsolutePath);
  assert.deepEqual(fs.readFileSync(finalReceiptAbsolutePath), receiptBytes);

  const staleReceiptStatus = mustRunJson([
    "status", "--root", project, "--full",
  ], project);
  assert.equal(staleReceiptStatus.summary.available_work, 0);
  assert.ok(staleReceiptStatus.summary.blocked_work >= 1);
  assert.equal(
    staleReceiptStatus.next_action.reason,
    "final_lifecycle_receipt_invalid",
  );
  const staleReceiptOrchestration = mustRunJson([
    "orchestrate", "status", "--root", project,
  ], project);
  const staleReceiptStory = staleReceiptOrchestration.stories
    .find((story) => story.id === fixture.storyId);
  const staleReceiptDownstream = staleReceiptOrchestration.stories
    .find((story) => story.id === "ST-FINAL-DOWNSTREAM");
  assert.equal(staleReceiptStory.orchestration_state, "blocked");
  assert.equal(
    staleReceiptStory.lifecycle_source,
    "invalid_workflow_final_receipt",
  );
  assert.equal(staleReceiptDownstream.orchestration_state, "blocked");
  const staleDependencyStatus = mustRunJson([
    "dependency", "status",
    "--root", project,
    "--story", "ST-FINAL-DOWNSTREAM",
  ], project);
  assert.ok(staleDependencyStatus.blockers.some((blocker) =>
    blocker.includes(fixture.storyId)));
  const staleReceiptPlan = mustRunJson([
    "orchestrate", "plan", "--root", project,
  ], project);
  assert.equal(
    staleReceiptPlan.candidates.some((candidate) =>
      [fixture.storyId, "ST-FINAL-DOWNSTREAM"].includes(candidate.story_id)),
    false,
  );
  for (const forceArgs of [
    [],
    ["--force", "--actor-type", "human"],
  ]) {
    mustFail([
      "story", "claim",
      "--root", project,
      "--id", fixture.storyId,
      "--agent", "post-certification-freshness-agent",
      ...forceArgs,
    ], project, /invalid or unreadable final lifecycle receipt/u);
  }
  assert.deepEqual(readJson(project, claimPath), claimBeforeDowngradeReplay);

  appendTrace(project, fixture.storyId, "test", "passed", testEvidence);
  const recoveredFreshnessReport = mustRunJson([
    "gate", "check",
    "--root", project,
    "--strict",
    "--story", fixture.storyId,
    "--lifecycle-complete",
  ], project);
  assert.equal(recoveredFreshnessReport.status, "passed");
  assert.equal(recoveredFreshnessReport.kind, "workflow_final_gate_receipt");
  const recoveredFreshnessReceiptBytes = fs.readFileSync(finalReceiptAbsolutePath);
  assert.notDeepEqual(recoveredFreshnessReceiptBytes, receiptBytes);
  const recoveredFreshnessReceipt = JSON.parse(recoveredFreshnessReceiptBytes);
  assert.ok(
    Date.parse(recoveredFreshnessReceipt.checked_at)
      > Date.parse(receipt.checked_at),
  );
  const recoveredFreshnessOrchestration = mustRunJson([
    "orchestrate", "status", "--root", project,
  ], project);
  assert.equal(
    recoveredFreshnessOrchestration.stories
      .find((story) => story.id === fixture.storyId)
      .orchestration_state,
    "terminal",
  );
  assert.equal(
    recoveredFreshnessOrchestration.stories
      .find((story) => story.id === "ST-FINAL-DOWNSTREAM")
      .orchestration_state,
    "available",
  );
  const recoveredDependencyStatus = mustRunJson([
    "dependency", "status",
    "--root", project,
    "--story", "ST-FINAL-DOWNSTREAM",
  ], project);
  assert.equal(recoveredDependencyStatus.blockers.length, 0);

  const raceHookRoot = temporaryProject("final-gate-trace-race-hook");
  const raceReceiptBackupPath = path.join(
    raceHookRoot,
    "pre-race-final-receipt.json",
  );
  const lifecycleLockPath = path.join(
    project,
    `.sdlc/stories/${fixture.storyId}/lifecycle-certification.lock`,
  );
  const raceMarkerPath = path.join(raceHookRoot, "gate-lock-delay.marker");
  const raceHookPath = path.join(raceHookRoot, "delay-final-gate-lock.mjs");
  fs.writeFileSync(raceHookPath, [
    'import fs from "node:fs";',
    "const originalOpenSync = fs.openSync;",
    "let delayed = false;",
    "fs.openSync = function delayedFinalGateLock(filePath, flags, ...rest) {",
    "  if (!delayed",
    "      && String(filePath) === process.env.AGENTIC_SDLC_TEST_LIFECYCLE_LOCK_PATH",
    '      && flags === "wx") {',
    "    delayed = true;",
    "    fs.writeFileSync(process.env.AGENTIC_SDLC_TEST_LIFECYCLE_LOCK_MARKER, String(filePath));",
    "    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);",
    "  }",
    "  return originalOpenSync.call(this, filePath, flags, ...rest);",
    "};",
    "",
  ].join("\n"));
  fs.renameSync(finalReceiptAbsolutePath, raceReceiptBackupPath);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const finalGateArgs = [
    "gate", "check",
    "--root", project,
    "--strict",
    "--story", fixture.storyId,
    "--lifecycle-complete",
    "--json",
  ];
  const failedTraceArgs = [
    "trace", "append",
    "--root", project,
    "--story", fixture.storyId,
    "--type", "test",
    "--outcome", "failed",
    "--summary", "Concurrent failed validation after certification",
    "--evidence", testEvidence,
    "--actor", "codex",
    "--actor-type", "agent",
    "--json",
  ];
  const racedGatePromise = runConcurrently(finalGateArgs, project, {
    NODE_OPTIONS: `--import=${pathToFileURL(raceHookPath).href}`,
    AGENTIC_SDLC_TEST_LIFECYCLE_LOCK_PATH: lifecycleLockPath,
    AGENTIC_SDLC_TEST_LIFECYCLE_LOCK_MARKER: raceMarkerPath,
  });
  await waitForTextFile(raceMarkerPath, lifecycleLockPath);
  const racedFailedTracePromise = runConcurrently(failedTraceArgs, project);
  const [racedGate, racedFailedTrace] = await Promise.all([
    racedGatePromise,
    racedFailedTracePromise,
  ]);
  assert.equal(
    [racedGate, racedFailedTrace].filter((result) => result.status === 0).length,
    1,
  );
  assert.equal(
    racedFailedTrace.status,
    0,
    `${racedFailedTrace.stdout}\n${racedFailedTrace.stderr}`,
  );
  assert.notEqual(
    racedGate.status,
    0,
    "final certification and a later failed trace both crossed the lifecycle lock",
  );
  assert.match(
    `${racedGate.stdout}\n${racedGate.stderr}`,
    /changed while final lifecycle certification was being prepared|latest test trace to have outcome passed/su,
  );
  assert.equal(fs.existsSync(finalReceiptAbsolutePath), false);
  assert.equal(fs.existsSync(lifecycleLockPath), false);
  const racedFailedEvent = fs.readFileSync(certifiedStoryTracePath, "utf8")
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .at(-1);
  const racedFailedCheckpoint = readJson(
    project,
    `.sdlc/traces/.integrity/${fixture.storyId}.jsonl.checkpoint.json`,
  );
  assert.equal(racedFailedEvent.type, "test");
  assert.equal(racedFailedEvent.outcome, "failed");
  assert.equal(
    racedFailedCheckpoint.new_writes.last_event_hash,
    racedFailedEvent._trace_integrity.event_hash,
  );
  fs.renameSync(raceReceiptBackupPath, finalReceiptAbsolutePath);

  const racedStaleReceiptStatus = mustRunJson([
    "status", "--root", project, "--full",
  ], project);
  assert.ok(racedStaleReceiptStatus.summary.blocked_work >= 1);
  assert.equal(
    racedStaleReceiptStatus.next_action.reason,
    "final_lifecycle_receipt_invalid",
  );
  appendTrace(project, fixture.storyId, "test", "passed", testEvidence);
  const postRaceRecovery = mustRunJson(finalGateArgs.slice(0, -1), project);
  assert.equal(postRaceRecovery.status, "passed");
  assert.equal(postRaceRecovery.kind, "workflow_final_gate_receipt");

  const outputRaceHookRoot = temporaryProject("final-gate-output-link-race-hook");
  const outputRaceReceiptBackupPath = path.join(
    outputRaceHookRoot,
    "pre-output-race-final-receipt.json",
  );
  const outputRaceMarkerPath = path.join(
    outputRaceHookRoot,
    "gate-lock-held.marker",
  );
  const outputRaceHookPath = path.join(
    outputRaceHookRoot,
    "hold-final-gate-lock.mjs",
  );
  fs.writeFileSync(outputRaceHookPath, [
    'import fs from "node:fs";',
    "const originalOpenSync = fs.openSync;",
    "let delayed = false;",
    "fs.openSync = function holdFinalGateLifecycleLock(filePath, flags, ...rest) {",
    "  const descriptor = originalOpenSync.call(this, filePath, flags, ...rest);",
    "  if (!delayed",
    "      && String(filePath) === process.env.AGENTIC_SDLC_TEST_LIFECYCLE_LOCK_PATH",
    '      && flags === "wx") {',
    "    delayed = true;",
    "    fs.writeFileSync(process.env.AGENTIC_SDLC_TEST_LIFECYCLE_LOCK_MARKER, String(filePath));",
    "    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);",
    "  }",
    "  return descriptor;",
    "};",
    "",
  ].join("\n"));
  fs.renameSync(finalReceiptAbsolutePath, outputRaceReceiptBackupPath);
  const outputRaceRegistryBytes = fs.readFileSync(certifiedOutputRegistryPath);
  const outputRaceGatePromise = runConcurrently(finalGateArgs, project, {
    NODE_OPTIONS: `--import=${pathToFileURL(outputRaceHookPath).href}`,
    AGENTIC_SDLC_TEST_LIFECYCLE_LOCK_PATH: lifecycleLockPath,
    AGENTIC_SDLC_TEST_LIFECYCLE_LOCK_MARKER: outputRaceMarkerPath,
  });
  await waitForTextFile(outputRaceMarkerPath, lifecycleLockPath);
  const outputRaceLinkPromise = runConcurrently([
    "output", "link",
    "--root", project,
    "--story", fixture.storyId,
    "--type", "implementation-summary",
    "--artifact", replacementImplementationOutput,
    "--template", "implementation-summary-v1",
    "--mode", "new",
    "--requirement", fixture.requirementId,
    "--id", certifiedImplementationOutput.id,
    "--authorization", fixture.storyActionAuthorizationId,
    "--json",
  ], project);
  const [outputRaceGate, outputRaceLink] = await Promise.all([
    outputRaceGatePromise,
    outputRaceLinkPromise,
  ]);
  assert.equal(
    outputRaceGate.status,
    0,
    `${outputRaceGate.stdout}\n${outputRaceGate.stderr}`,
  );
  assert.notEqual(
    outputRaceLink.status,
    0,
    "output link crossed a terminal final certification while it held the lifecycle lock",
  );
  assert.match(
    `${outputRaceLink.stdout}\n${outputRaceLink.stderr}`,
    /already has (?:a valid terminal lifecycle certification|a terminal lifecycle receipt)/u,
  );
  assert.deepEqual(
    fs.readFileSync(certifiedOutputRegistryPath),
    outputRaceRegistryBytes,
  );
  assert.equal(fs.existsSync(finalReceiptAbsolutePath), true);
  assert.equal(fs.existsSync(lifecycleLockPath), false);
  const postRaceStatus = mustRunJson([
    "status", "--root", project, "--full",
  ], project);
  assert.equal(postRaceStatus.summary.completed_work, 1);
  assert.equal(postRaceStatus.summary.blocked_work, 0);

  const contractRaceHookRoot = temporaryProject("final-gate-contract-race-hook");
  const contractRaceReceiptBackupPath = path.join(
    contractRaceHookRoot,
    "pre-contract-race-final-receipt.json",
  );
  const contractRaceMarkerPath = path.join(
    contractRaceHookRoot,
    "gate-before-lock.marker",
  );
  const contractRaceHookPath = path.join(
    contractRaceHookRoot,
    "delay-final-gate-before-lock.mjs",
  );
  fs.writeFileSync(contractRaceHookPath, [
    'import fs from "node:fs";',
    "const originalOpenSync = fs.openSync;",
    "let delayed = false;",
    "fs.openSync = function delayFinalGateBeforeLifecycleLock(filePath, flags, ...rest) {",
    "  if (!delayed",
    "      && String(filePath) === process.env.AGENTIC_SDLC_TEST_LIFECYCLE_LOCK_PATH",
    '      && flags === "wx") {',
    "    delayed = true;",
    "    fs.writeFileSync(process.env.AGENTIC_SDLC_TEST_LIFECYCLE_LOCK_MARKER, String(filePath));",
    "    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);",
    "  }",
    "  return originalOpenSync.call(this, filePath, flags, ...rest);",
    "};",
    "",
  ].join("\n"));
  fs.renameSync(finalReceiptAbsolutePath, contractRaceReceiptBackupPath);
  const contractRaceGatePromise = runConcurrently(finalGateArgs, project, {
    NODE_OPTIONS: `--import=${pathToFileURL(contractRaceHookPath).href}`,
    AGENTIC_SDLC_TEST_LIFECYCLE_LOCK_PATH: lifecycleLockPath,
    AGENTIC_SDLC_TEST_LIFECYCLE_LOCK_MARKER: contractRaceMarkerPath,
  });
  await waitForTextFile(contractRaceMarkerPath, lifecycleLockPath);
  fs.writeFileSync(
    certifiedContractPath,
    `${JSON.stringify(changedCertifiedContract, null, 2)}\n`,
    "utf8",
  );
  const contractRaceGate = await contractRaceGatePromise;
  assert.notEqual(
    contractRaceGate.status,
    0,
    "final certification accepted a contract changed after its initial validation",
  );
  assert.match(
    `${contractRaceGate.stdout}\n${contractRaceGate.stderr}`,
    /changed while final lifecycle certification was being prepared.*contract CONTRACT-FINAL\.json approved human gate is stale|Delivery autonomy profile AUT-FINAL is stale for contract CONTRACT-FINAL/su,
  );
  assert.equal(fs.existsSync(finalReceiptAbsolutePath), false);
  assert.equal(fs.existsSync(lifecycleLockPath), false);
  fs.writeFileSync(certifiedContractPath, certifiedContractBytes);
  fs.renameSync(contractRaceReceiptBackupPath, finalReceiptAbsolutePath);
  const restoredContractRaceStatus = mustRunJson([
    "status", "--root", project, "--full",
  ], project);
  assert.equal(restoredContractRaceStatus.summary.completed_work, 1);
  assert.equal(restoredContractRaceStatus.summary.blocked_work, 0);
});

test("a formally closed pull request remains terminal but cannot certify lifecycle success", () => {
  const project = temporaryProject("closed-pull-request");
  const fixture = createGovernedDeliveryStory(project, {
    suffix: "CLOSED",
    allowedWritePaths: ["src"],
  });

  mustRun([
    "autonomy", "delivery", "close",
    "--root", project,
    "--id", fixture.profileId,
    "--terminal-status", "closed",
    "--reason", "The pull request was closed without being merged.",
    ...humanApproval("Approve closing this unmerged pull request"),
  ], project);

  mustFail([
    "gate", "check",
    "--root", project,
    "--strict",
    "--story", fixture.storyId,
    "--lifecycle-complete",
    "--json",
  ], project, /requires terminal pull_request delivery; found closed/u);
  assert.equal(
    fs.existsSync(path.join(project, `.sdlc/gates/${fixture.storyId}-final.json`)),
    false,
  );
});

test("strict story gate detects an out-of-scope file committed after task start", () => {
  const project = temporaryProject("write-scope");
  const fixture = createGovernedDeliveryStory(project, {
    suffix: "SCOPE",
    allowedWritePaths: ["src"],
  });
  const taskStart = readJson(project, `.sdlc/stories/${fixture.storyId}/task-start.json`);
  const baselineSha = taskStart.audit.git.head_sha;
  assert.match(baselineSha, /^[a-f0-9]{40,64}$/u);

  writeProjectFile(project, "outside-approved-scope.md", "# Outside approved scope\n");
  mustGit(project, ["add", "outside-approved-scope.md"]);
  mustGit(project, ["commit", "-m", "test: commit out-of-scope path after task start"]);
  assert.notEqual(mustGit(project, ["rev-parse", "HEAD"]), baselineSha);

  const failedGate = mustFail([
    "gate", "check",
    "--root", project,
    "--strict",
    "--story", fixture.storyId,
    "--json",
  ], project, /changed files outside the approved requirement write paths: outside-approved-scope\.md/u);
  const report = JSON.parse(failedGate.stdout);
  assert.ok(report.errors.some((error) =>
    error.includes("outside the approved requirement write paths: outside-approved-scope.md")));
});

test("multiple requirement write scopes form the story-scoped union", () => {
  const project = temporaryProject("write-scope-union");
  const fixture = createGovernedDeliveryStory(project, {
    suffix: "SCOPE-UNION",
    allowedWritePaths: ["src/one"],
    additionalRequirementWritePaths: [["src/two"]],
    storyActionUses: 2,
  });
  writeProjectFile(
    project,
    "src/two/implementation.mjs",
    "export const governedBySecondRequirement = true;\n",
  );
  mustGit(project, ["add", "src/two/implementation.mjs"]);
  mustGit(project, ["commit", "-m", "test: change second requirement scope"]);
  writeProjectFile(
    project,
    "src/two/implementation-summary.md",
    "# Implementation summary\n\nThe second requirement scope is governed.\n",
  );
  mustRun([
    "output", "link",
    "--root", project,
    "--story", fixture.storyId,
    "--type", "implementation-summary",
    "--artifact", "src/two/implementation-summary.md",
    "--template", "implementation-summary-v1",
    "--mode", "new",
    "--requirement", fixture.requirementId,
    "--authorization", fixture.storyActionAuthorizationId,
  ], project);
  const report = mustRunJson([
    "gate", "check",
    "--root", project,
    "--strict",
    "--story", fixture.storyId,
  ], project);
  assert.equal(report.status, "passed");
  assert.equal(
    report.errors.some((error) =>
      error.includes("outside the approved requirement write paths")),
    false,
  );
});

test("the latest failed test or release trace overrides an older passing attempt for steps and final gate", () => {
  const project = temporaryProject("latest-trace");
  const { storyId } = createLegacyStrictStory(project, "LATEST");
  const testEvidence = writeProjectFile(project, ".sdlc/tests/ST-LATEST-test.json", "{\"passed\":true}\n");
  const releaseEvidence = writeProjectFile(project, ".sdlc/tests/ST-LATEST-release.json", "{\"released\":true}\n");

  appendTrace(project, storyId, "test", "passed", testEvidence);
  appendTrace(project, storyId, "test", "failed", testEvidence);
  mustFail([
    "story", "complete-step",
    "--root", project,
    "--id", storyId,
    "--step", "validation",
    "--summary", "Validation should not accept a stale passing attempt",
    "--evidence", testEvidence,
  ], project, /latest test trace to have outcome passed/u);
  mustFail([
    "gate", "check",
    "--root", project,
    "--strict",
    "--story", storyId,
    "--lifecycle-complete",
    "--json",
  ], project, /latest test trace outcome must be passed|latest test trace to pass/u);

  appendTrace(project, storyId, "test", "passed", testEvidence);
  mustRun([
    "story", "complete-step",
    "--root", project,
    "--id", storyId,
    "--step", "validation",
    "--summary", "Validation uses the newest passing attempt",
    "--evidence", testEvidence,
  ], project);

  appendTrace(project, storyId, "release", "passed", releaseEvidence);
  appendTrace(project, storyId, "release", "failed", releaseEvidence);
  mustFail([
    "story", "complete-step",
    "--root", project,
    "--id", storyId,
    "--step", "release",
    "--summary", "Release should not accept a stale passing attempt",
    "--evidence", releaseEvidence,
  ], project, /latest release trace to have outcome ready or passed/u);
  mustFail([
    "gate", "check",
    "--root", project,
    "--strict",
    "--story", storyId,
    "--lifecycle-complete",
    "--json",
  ], project, /latest release trace outcome must be ready or passed|latest release trace to pass/u);

  appendTrace(project, storyId, "release", "passed", releaseEvidence);
  mustRun([
    "story", "complete-step",
    "--root", project,
    "--id", storyId,
    "--step", "release",
    "--summary", "Release uses the newest passing attempt",
    "--evidence", releaseEvidence,
  ], project);
});
