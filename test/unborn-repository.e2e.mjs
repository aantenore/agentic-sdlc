import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

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
  const project = fs.mkdtempSync(path.join(os.tmpdir(), `agentic-sdlc-unborn-${label}-`));
  TEMPORARY_PROJECTS.add(project);
  return project;
}

function hostSupportsLocalSmokeSandbox() {
  if (process.platform === "darwin") return fs.existsSync("/usr/bin/sandbox-exec");
  if (process.platform === "linux") return fs.existsSync("/usr/bin/bwrap");
  return false;
}

function run(args, project, options = {}) {
  const env = { ...process.env };
  for (const key of ["CI", "GITHUB_ACTIONS", "GITHUB_ACTOR", "CODEX_AGENT_NAME", "CODEX_USER_ID", "CLAUDECODE", "AGENTIC_SDLC_AGENT_HOST"]) {
    delete env[key];
  }
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: project,
    encoding: "utf8",
    env,
    timeout: options.timeout || 60_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function mustRun(args, project) {
  const result = run(args, project);
  assert.equal(result.error, undefined, `${args.join(" ")} failed to execute: ${result.error?.message}`);
  assert.equal(
    result.status,
    0,
    `${args.join(" ")}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
  );
  return result;
}

function mustRunJson(args, project) {
  return JSON.parse(mustRun([...args, "--json"], project).stdout);
}

function git(project, args, { allowFailure = false } = {}) {
  const result = spawnSync("git", ["-C", project, ...args], {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.error, undefined, `git ${args.join(" ")} failed: ${result.error?.message}`);
  if (!allowFailure) {
    assert.equal(
      result.status,
      0,
      `git ${args.join(" ")}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
    );
  }
  return { status: result.status, stdout: result.stdout.trim() };
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

// A project whose Git repository exists but has no commit yet: the state of a
// brand-new local project before its owner makes the first commit.
function initializeUnbornProject(project) {
  mustRun(["init", "--root", project, "--project-name", "Unborn repository"], project);
  git(project, ["init"]);
  git(project, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  git(project, ["config", "user.name", "Unborn E2E"]);
  git(project, ["config", "user.email", "unborn-e2e@example.invalid"]);
  writeProjectFile(project, "src/index.mjs", "export const ready = true;\n");
  assert.equal(git(project, ["rev-parse", "--verify", "--quiet", "HEAD"], { allowFailure: true }).status, 1);
}

// One governed local-release story from the first record to its sealed final
// lifecycle receipt, with no commit made at any point.
function certifyLocalStoryWithoutCommit(project, suffix = "UNBORN") {
  const requirementId = `REQ-${suffix}`;
  const storyId = `ST-${suffix}`;
  const contractId = `CONTRACT-${suffix}`;
  const profileId = `AUT-${suffix}`;
  const workflowInstanceId = `delivery-${suffix.toLowerCase()}`;
  const localReleaseRoot = path.join(project, "docs", "local-release");
  const localReleaseOutput = path.join(localReleaseRoot, "app");

  mustRun([
    "requirement", "propose",
    "--root", project,
    "--id", requirementId,
    "--title", `Govern ${suffix}`,
    "--summary", `Implement ${suffix} only inside its exact approved write scope.`,
    "--acceptance", `The ${suffix} story has verified implementation and delivery evidence.`,
    "--autonomy-ceiling", "supervised",
    "--write-path", "docs",
    "--write-path", "src",
  ], project);
  mustRun([
    "requirement", "approve",
    "--root", project,
    "--id", requirementId,
    ...humanApproval(`Approve ${requirementId}`),
  ], project);
  mustRun([
    "output", "template", "propose",
    "--root", project,
    "--type", "implementation-summary",
    "--summary", "Canonical implementation-summary format",
  ], project);
  mustRun([
    "output", "template", "approve",
    "--root", project,
    "--id", "implementation-summary-v1",
    ...humanApproval("Approve implementation-summary output format"),
  ], project);
  mustRun([
    "story", "create",
    "--root", project,
    "--id", storyId,
    "--title", `Implement ${suffix}`,
    "--phase", "implementation",
    "--status", "ready",
    "--requirement", requirementId,
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
    "--output-ref", "implementation-summary:implementation-summary-v1:new",
  ], project);
  mustRun([
    "contract", "approve",
    "--root", project,
    "--id", contractId,
    ...humanApproval(`Approve ${contractId}`),
  ], project);
  mustRun([
    "autonomy", "delivery", "propose",
    "--root", project,
    "--id", profileId,
    "--delivery", `LOCAL-${suffix}`,
    "--kind", "local_release",
    "--story", storyId,
    "--contract", contractId,
    "--requirement", requirementId,
    "--level", "supervised",
    "--target-root", localReleaseRoot,
    "--write-path", localReleaseOutput,
    "--smoke-test", '["node","--version"]',
    "--rollback", "Restore the previous governed local release snapshot.",
  ], project);
  mustRun([
    "autonomy", "delivery", "approve",
    "--root", project,
    "--id", profileId,
    "--phase", "implementation",
    ...humanApproval(`Approve ${profileId}`),
  ], project);
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
  const authorizationId = `AUTH-${suffix}-STORY-ACTIONS`;
  mustRun([
    "authorization", "grant",
    "--root", project,
    "--id", authorizationId,
    "--scope", `Approve the exact governed story actions for ${storyId}.`,
    "--allow-use", `story.claim=${storyId}`,
    "--allow-use", `output.link=${storyId}`,
    "--allow-use", `story.complete-step=${storyId}`,
    "--allow-artifact-type", "implementation-summary",
    "--max-uses", "12",
    ...humanApproval(`Approve the exact governed story actions for ${storyId}`),
  ], project);
  mustRun([
    "story", "claim",
    "--root", project,
    "--id", storyId,
    "--agent", "codex",
    "--authorization", authorizationId,
  ], project);

  const transition = (to) => mustRun([
    "workflow", "instance", "transition",
    "--root", project,
    "--id", workflowInstanceId,
    "--to", to,
    "--request-id", `${workflowInstanceId}-${to}`,
    "--actor", "workflow-e2e-ci",
    "--actor-type", "ci",
  ], project);
  const completeStep = (step, extra = []) => mustRun([
    "story", "complete-step",
    "--root", project,
    "--id", storyId,
    "--step", step,
    "--summary", `${step} completed against the approved boundary`,
    ...extra,
    "--authorization", authorizationId,
  ], project);

  writeProjectFile(project, "src/feature.mjs", "export const feature = 1;\n");
  const artifact = writeProjectFile(
    project,
    `docs/implementation-summary-${suffix.toLowerCase()}.md`,
    `# Implementation summary\n\n${suffix} is complete.\n`,
  );
  mustRun([
    "output", "link",
    "--root", project,
    "--story", storyId,
    "--type", "implementation-summary",
    "--artifact", artifact,
    "--template", "implementation-summary-v1",
    "--mode", "new",
    "--requirement", requirementId,
    "--authorization", authorizationId,
  ], project);
  for (const [step, next] of [
    ["discovery", "analysis"],
    ["analysis", "design"],
    ["design", "implementation"],
    ["implementation", "validation"],
  ]) {
    completeStep(step, step === "implementation" ? ["--type", "implementation-summary"] : []);
    transition(next);
  }
  const testEvidence = writeProjectFile(project, `.sdlc/tests/${storyId}-test.json`, "{\"passed\":true}\n");
  appendTrace(project, storyId, "test", "passed", testEvidence);
  completeStep("validation", ["--evidence", testEvidence]);
  mustRun(["secret", "scan", "--root", project, "--story", storyId], project);
  mustRunJson(["gate", "check", "--root", project, "--strict", "--story", storyId], project);
  transition("release");
  const build = mustRunJson([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", profileId,
    "--action", "build.local",
    "--confirm-action",
    ...humanApproval(`Approve the ${suffix} local build`),
  ], project);
  const buildEvidence = writeProjectFile(project, `docs/local-build-${suffix.toLowerCase()}.json`, "{\"built\":true}\n");
  writeProjectFile(project, "docs/local-release/app/release-proof.txt", `${suffix} release\n`);
  const releaseProofEvidence = writeProjectFile(
    project,
    `docs/release-proof-${suffix.toLowerCase()}.json`,
    `${JSON.stringify({ released: suffix })}\n`,
  );
  mustRun([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", profileId,
    "--action", "build.local",
    "--outcome", "passed",
    "--authorization-receipt", build.action_receipt.id,
    "--evidence", buildEvidence,
  ], project);
  const rollbackEvidence = writeProjectFile(
    project,
    `docs/rollback-rehearsal-${suffix.toLowerCase()}.json`,
    "{\"restored\":true}\n",
  );
  for (const extra of [
    ["--confirm-action", ...humanApproval(`Approve the ${suffix} rollback rehearsal`)],
    ["--outcome", "passed"],
  ]) {
    mustRun([
      "autonomy", "delivery", "action",
      "--root", project,
      "--id", profileId,
      "--action", "rollback.verify",
      "--evidence", rollbackEvidence,
      ...extra,
    ], project);
  }
  mustRun([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", profileId,
    "--action", "release.local",
    "--confirm-action",
    ...humanApproval(`Approve the ${suffix} local release`),
  ], project);
  mustRunJson([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", profileId,
    "--action", "release.local",
    "--outcome", "passed",
    "--evidence", releaseProofEvidence,
    "--smoke-test", '["node","--version"]',
    "--rollback", "Restore the previous governed local release snapshot.",
  ], project);
  const releaseEvidence = writeProjectFile(project, `.sdlc/tests/${storyId}-release.json`, "{\"ready\":true}\n");
  appendTrace(project, storyId, "release", "passed", releaseEvidence);
  completeStep("release", ["--evidence", releaseEvidence]);
  transition("operations");
  completeStep("operations");
  mustRun(["secret", "scan", "--root", project, "--story", storyId], project);
  mustRun([
    "story", "release",
    "--root", project,
    "--id", storyId,
    "--agent", "codex",
    "--reason", "Release the completed lane before final certification.",
  ], project);
  const certified = mustRunJson([
    "gate", "check",
    "--root", project,
    "--strict",
    "--story", storyId,
    "--lifecycle-complete",
  ], project);
  assert.equal(certified.status, "passed");
  return { storyId, profileId };
}

function assertStillCertified(project) {
  const status = mustRunJson(["status", "--root", project], project);
  assert.equal(status.summary.completed_work, 1, JSON.stringify(status.summary));
  assert.equal(status.summary.blocked_work, 0, JSON.stringify(status.summary));
  return status;
}

const SKIP_REASON = "requires a supported local smoke sandbox for terminal local release evidence";

test("a governed local delivery starts and certifies in a repository without commits", {
  skip: hostSupportsLocalSmokeSandbox() ? false : SKIP_REASON,
}, () => {
  const project = temporaryProject("journey");
  initializeUnbornProject(project);
  const { storyId } = certifyLocalStoryWithoutCommit(project);

  // The agent never created a commit: HEAD is still unborn and no ref exists.
  assert.equal(git(project, ["rev-parse", "--verify", "--quiet", "HEAD"], { allowFailure: true }).status, 1);
  assert.equal(git(project, ["for-each-ref"]).stdout, "");

  // The receipt states the empty-tree base explicitly instead of a commit.
  const receipt = readJson(project, `.sdlc/stories/${storyId}/task-start.json`);
  assert.equal(receipt.audit.git.head_sha, null);
  const emptyTree = git(project, ["hash-object", "-t", "tree", "--stdin"]).stdout;
  assert.deepEqual(receipt.git_base, { base_sha: null, base_tree: emptyTree });
  const preflight = readJson(project, receipt.execution_context_preflight_ref.path);
  assert.equal(preflight.git_head_sha, null);
  assert.equal(preflight.git_base_tree, emptyTree);

  assertStillCertified(project);
});

test("the certification of an unborn-repository delivery stays valid after the first commit", {
  skip: hostSupportsLocalSmokeSandbox() ? false : SKIP_REASON,
}, () => {
  const project = temporaryProject("first-commit");
  initializeUnbornProject(project);
  const { storyId } = certifyLocalStoryWithoutCommit(project);
  assertStillCertified(project);

  // Staging alone does not change what was certified.
  git(project, ["add", "--", "src", "docs", ".sdlc"]);
  assertStillCertified(project);

  // The user's first commit becomes a root commit on a previously unborn HEAD.
  git(project, ["commit", "-m", "Add the verified local result"]);
  assert.equal(git(project, ["rev-list", "--count", "HEAD"]).stdout, "1");
  assertStillCertified(project);

  // The delivery base is still the empty tree, so the next scan covers the
  // whole root commit and the strict lifecycle gate accepts the new head.
  const scan = mustRunJson(["secret", "scan", "--root", project, "--story", storyId], project);
  assert.equal(scan.covers_delivery_base, true);
  assert.equal(scan.secret_scan.source, "git_range");
  const recertified = mustRunJson([
    "gate", "check",
    "--root", project,
    "--strict",
    "--story", storyId,
    "--lifecycle-complete",
  ], project);
  assert.equal(recertified.status, "passed");
  assertStillCertified(project);
});

test("a transient root commit with uncertified content is not accepted as the certified result", {
  skip: hostSupportsLocalSmokeSandbox() ? false : SKIP_REASON,
}, () => {
  const project = temporaryProject("transient-commit");
  initializeUnbornProject(project);
  certifyLocalStoryWithoutCommit(project);

  // The root commit holds different bytes; the certified bytes are restored
  // only in a later commit, so the history is not the certified transition.
  writeProjectFile(project, "src/feature.mjs", "export const feature = 2;\n");
  git(project, ["add", "--", "src", "docs", ".sdlc"]);
  git(project, ["commit", "-m", "Add a different result"]);
  writeProjectFile(project, "src/feature.mjs", "export const feature = 1;\n");
  git(project, ["add", "--", "src"]);
  git(project, ["commit", "-m", "Restore the certified result"]);
  const status = mustRunJson(["status", "--root", project], project);
  assert.equal(status.summary.completed_work, 0, JSON.stringify(status.summary));
});

test("a file outside the approved scope committed after an unborn start fails the strict gate", {
  skip: hostSupportsLocalSmokeSandbox() ? false : SKIP_REASON,
}, () => {
  const project = temporaryProject("scope-after-first-commit");
  initializeUnbornProject(project);
  const { storyId } = certifyLocalStoryWithoutCommit(project);
  writeProjectFile(project, "outside/notes.txt", "outside the approved write paths\n");
  git(project, ["add", "--", "src", "docs", "outside", ".sdlc"]);
  git(project, ["commit", "-m", "Add the result and an unrelated file"]);
  mustRun(["secret", "scan", "--root", project, "--story", storyId], project);
  const gate = run([
    "gate", "check",
    "--root", project,
    "--strict",
    "--story", storyId,
    "--lifecycle-complete",
  ], project);
  assert.notEqual(gate.status, 0, gate.stdout);
  assert.match(`${gate.stdout}\n${gate.stderr}`, /outside the approved requirement write paths: outside\/notes\.txt/u);
});
