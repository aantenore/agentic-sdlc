import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "bin", "agentic-sdlc.mjs");
const PROJECTS = new Set();

after(() => {
  if (process.env.AGENTIC_SDLC_KEEP_TEST_TMP === "1") return;
  for (const project of PROJECTS) {
    fs.rmSync(project, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
  PROJECTS.clear();
});

function temporaryProject(label) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), `agentic-sdlc-novice-${label}-`));
  PROJECTS.add(project);
  return project;
}

function run(args, { cwd = ROOT } = {}) {
  const env = { ...process.env };
  for (const key of ["CI", "GITHUB_ACTIONS", "GITHUB_ACTOR", "CODEX_AGENT_NAME", "CODEX_USER_ID", "CLAUDECODE", "AGENTIC_SDLC_AGENT_HOST"]) {
    delete env[key];
  }
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env,
    timeout: 60_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function mustRun(args, options = {}) {
  const result = run(args, options);
  assert.equal(result.error, undefined, `${args.join(" ")}: ${result.error?.message}`);
  assert.equal(result.signal, null, `${args.join(" ")} terminated by ${result.signal}`);
  assert.equal(
    result.status,
    0,
    `${args.join(" ")}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
  );
  return result;
}

function mustRunJson(args, options = {}) {
  return JSON.parse(mustRun([...args, "--json"], options).stdout);
}

function git(project, ...args) {
  const result = spawnSync("git", ["-C", project, ...args], {
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.error, undefined, `git ${args.join(" ")}: ${result.error?.message}`);
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
  );
  return result.stdout.trim();
}

function humanApproval(summary) {
  return [
    "--actor-type", "human",
    "--actor-name", "Novice User",
    "--actor-email", "novice@example.invalid",
    "--approval-source", "explicit-user",
    "--summary", summary,
  ];
}

function intent(requestedAction, overrides = {}) {
  return JSON.stringify({
    requested_action: requestedAction,
    confidence: 0.99,
    referenced_entities: [],
    provided_artifacts: [],
    missing_context: [],
    proposed_phase: null,
    artifact_type: null,
    skip_phases: [],
    ...overrides,
  });
}

function initializeGitProject(project) {
  fs.writeFileSync(
    path.join(project, "README.md"),
    "# Novice fixture\n\nA small Node project used to verify the public requirement journey.\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(project, "package.json"),
    `${JSON.stringify({ name: "novice-fixture", version: "1.0.0", type: "module" }, null, 2)}\n`,
    "utf8",
  );
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.mkdirSync(path.join(project, "test"), { recursive: true });
  fs.writeFileSync(path.join(project, "src", "index.mjs"), "export const value = 1;\n", "utf8");
  git(project, "init", "--quiet");
  git(project, "config", "user.name", "Novice User");
  git(project, "config", "user.email", "novice@example.invalid");
  git(project, "add", "README.md", "package.json", "src/index.mjs");
  git(project, "commit", "-m", "test: establish novice fixture");
  git(project, "branch", "-M", "main");
  git(project, "remote", "add", "origin", "https://github.com/example/novice-fixture.git");
  git(project, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(project, "checkout", "-b", "codex/novice-journey");
}

test("fresh init hides bootstrap records and points to the first meaningful choice", () => {
  const project = temporaryProject("first-status");
  initializeGitProject(project);

  mustRun(["init", "--root", project, "--project-name", "Novice fixture"]);
  const status = mustRunJson(["status", "--root", project]);

  assert.equal(status.counts.requirements, 0);
  assert.equal(status.counts.stories, 0);
  assert.equal(status.counts.contracts, 0);
  assert.equal(status.summary.pending_decisions, 0);
  assert.match(
    `${status.next_action?.label || ""} ${status.next_action?.reason || ""} ${status.next_action?.command || ""}`,
    /(?:onboard|project context|requirement|describe)/iu,
  );

  const approvals = mustRunJson(["approval", "requests", "--root", project]);
  assert.equal(approvals.status, "clear");
  assert.deepEqual(approvals.requests, []);
});

test("requirement intake is useful before a contract exists", () => {
  const project = temporaryProject("intake");
  initializeGitProject(project);
  mustRun(["init", "--root", project, "--project-name", "Novice intake"]);

  const decision = mustRunJson([
    "route", "decide",
    "--root", project,
    "--intent-json", intent("intake_requirement"),
  ]);

  assert.equal(decision.route, "intake_requirement");
  assert.equal(decision.blocking_reasons.includes("missing_contract"), false);
  assert.equal(decision.next_commands.some((command) => command.includes("requirement propose")), true);
  assert.match(decision.questions.join(" "), /outcome|acceptance|non-goal|must not|independ/iu);
});

test("a structured Codex handoff reaches one executable PR task in lifecycle order", () => {
  const project = temporaryProject("full");
  initializeGitProject(project);
  mustRun(["init", "--root", project, "--project-name", "Novice delivery"]);

  const proposedRequirement = mustRunJson([
    "requirement", "propose",
    "--root", project,
    "--id", "REQ-NOVICE-001",
    "--title", "Expose one health response",
    "--summary", "Add a deterministic local health response without changing external services.",
    "--acceptance", "The health function returns status ok.",
    "--acceptance", "A Node test proves the response.",
    "--non-goal", "Do not deploy or contact an external service.",
    "--autonomy-ceiling", "checkpointed",
    "--write-path", "src",
    "--write-path", "test",
    "--write-path", "evidence",
    "--write-path", ".sdlc",
  ]);
  assert.equal(proposedRequirement.requirement.status, "proposed");
  assert.deepEqual(
    proposedRequirement.autonomy_profile.constraints.allowed_write_paths,
    [".sdlc", "evidence", "src", "test"],
  );

  const approvedRequirement = mustRunJson([
    "requirement", "approve",
    "--root", project,
    "--id", "REQ-NOVICE-001",
    ...humanApproval("The displayed outcome, checks, non-goal, and maximum independence are correct."),
  ]);
  assert.equal(approvedRequirement.status, "approved");

  const planningOnly = mustRunJson([
    "task", "start",
    "--root", project,
    "--intent-json", intent("decompose_stories", {
      referenced_entities: [{ type: "requirement", id: "REQ-NOVICE-001" }],
    }),
    "--confirm-start",
    ...humanApproval("Confirm the proposed story breakdown only; do not start execution."),
  ]);
  assert.equal(planningOnly.status, "needs_user_input");
  assert.equal(planningOnly.execution_allowed, false);
  assert.equal(planningOnly.contract_action, "record_decomposition");
  assert.equal(planningOnly.blocking_reasons.includes("decomposition_precedes_task_start"), true);
  assert.equal(Boolean(planningOnly.task_start_receipt), false);

  const story = mustRunJson([
    "story", "create",
    "--root", project,
    "--id", "ST-NOVICE-001",
    "--title", "Implement the health response",
    "--requirement", "REQ-NOVICE-001",
    "--acceptance", "The health response and its Node test pass.",
  ]);
  assert.equal(story.story.links.requirements.includes("REQ-NOVICE-001"), true);

  mustRunJson([
    "output", "template", "propose",
    "--root", project,
    "--id", "implementation-evidence-v1",
    "--type", "implementation-evidence",
    "--body", "# Implementation evidence\n\n## Changes\n\n## Tests\n",
    "--summary", "A short change and verification report.",
    "--format", "markdown",
    "--delivery", "artifact-plus-chat-summary",
    "--extension", ".md",
    "--media-type", "text/markdown",
    "--force",
  ]);
  mustRunJson([
    "output", "template", "approve",
    "--root", project,
    "--id", "implementation-evidence-v1",
    ...humanApproval("Use this short implementation evidence structure for this work."),
  ]);

  const contract = mustRunJson([
    "contract", "create",
    "--root", project,
    "--id", "contract-ST-NOVICE-001-implementation",
    "--phase", "implementation",
    "--story", "ST-NOVICE-001",
    "--delivery-profile", "AUT-PR-NOVICE-001",
    "--level", "checkpointed",
    "--context-file", ".sdlc/requirements/REQ-NOVICE-001.json",
    "--context-summary", "Implement only the approved health response and local test.",
    "--qa", "What must be delivered?|Code, one Node test, and concise implementation evidence.",
    "--constraint", "No deployment or external service access.",
    "--output-ref", "implementation-evidence:implementation-evidence-v1:new",
    "--validation", "The Node test passes.",
  ]);
  assert.equal(contract.contract.status, "draft");

  mustRunJson([
    "contract", "approve",
    "--root", project,
    "--id", "contract-ST-NOVICE-001-implementation",
    ...humanApproval("The displayed implementation scope, limits, output, and checks are correct."),
  ]);

  const profile = mustRunJson([
    "autonomy", "delivery", "propose",
    "--root", project,
    "--id", "AUT-PR-NOVICE-001",
    "--delivery", "PR-NOVICE-001",
    "--kind", "pull_request", "--code-review", "not-required", "--code-review-actor-type", "human", "--code-review-approval-source", "explicit-user", "--code-review-summary", "No review needed for this story",
    "--story", "ST-NOVICE-001",
    "--contract", "contract-ST-NOVICE-001-implementation",
    "--requirement", "REQ-NOVICE-001",
    "--level", "checkpointed",
    "--repository", "github.com/example/novice-fixture",
    "--base", "main",
    "--head", "codex/novice-journey",
    "--write-path", "src",
    "--write-path", "test",
    "--write-path", ".sdlc",
    "--allow-action", "repository.read",
    "--allow-action", "repository.write",
    "--allow-action", "test.run",
    "--allow-action", "git.commit",
    "--allow-action", "git.push",
    "--allow-action", "pull_request.create",
    "--allow-action", "pull_request.update",
  ]);
  assert.equal(profile.delivery_profile.status, "proposed");
  assert.equal(profile.delivery_profile.delivery_kind, "pull_request");

  mustRunJson([
    "autonomy", "delivery", "approve",
    "--root", project,
    "--id", "AUT-PR-NOVICE-001",
    ...humanApproval("Use autonomy with checks for this pull request only."),
  ]);

  const started = mustRunJson([
    "task", "start",
    "--root", project,
    "--story", "ST-NOVICE-001",
    "--phase", "implementation",
    "--contract-id", "contract-ST-NOVICE-001-implementation",
    "--delivery-profile", "AUT-PR-NOVICE-001",
    "--intent-json", intent("implement_story", {
      referenced_entities: [{ type: "story", id: "ST-NOVICE-001" }],
      proposed_phase: "implementation",
      artifact_type: "implementation-evidence",
    }),
  ]);

  assert.equal(started.status, "ready_to_execute");
  assert.equal(started.execution_allowed, true);
  assert.equal(started.contract_id, "contract-ST-NOVICE-001-implementation");
  assert.equal(started.delivery_profile_id, "AUT-PR-NOVICE-001");
  assert.deepEqual(started.blocking_reasons, []);
  assert.equal(
    started.deterministic_checks.some((check) =>
      check.check === "requirement_write_scope" && check.status === "passed"),
    true,
  );
  assert.ok(started.delivery_start_receipt);
  assert.ok(started.task_start_receipt);
});
