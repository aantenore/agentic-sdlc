import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPOSITORY_ROOT, "bin", "agentic-sdlc.mjs");
const TEMPORARY_PROJECTS = new Set();
const ISOLATED_ENVIRONMENT_KEYS = [
  "CI",
  "GITHUB_ACTIONS",
  "GITHUB_ACTOR",
  "CODEX_AGENT_NAME",
  "CODEX_USER_ID",
  "CLAUDECODE",
  "AGENTIC_SDLC_AGENT_HOST",
];
const SKIP_REASON = "requires a supported local smoke sandbox for terminal local release evidence";
const SMOKE = '["node","--version"]';
const ROLLBACK = "Restore the previous governed local release snapshot.";

after(() => {
  if (process.env.AGENTIC_SDLC_KEEP_TEST_TMP === "1") return;
  for (const project of TEMPORARY_PROJECTS) {
    fs.rmSync(project, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
  TEMPORARY_PROJECTS.clear();
});

function hostSupportsLocalSmokeSandbox() {
  if (process.platform === "darwin") return fs.existsSync("/usr/bin/sandbox-exec");
  if (process.platform === "linux") return fs.existsSync("/usr/bin/bwrap");
  return false;
}

function temporaryProject(label) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), `agentic-sdlc-standing-${label}-`));
  TEMPORARY_PROJECTS.add(project);
  return project;
}

function cliEnvironment() {
  const env = { ...process.env };
  for (const key of ISOLATED_ENVIRONMENT_KEYS) delete env[key];
  return env;
}

function run(args, project) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: project,
    encoding: "utf8",
    env: cliEnvironment(),
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function runAsync(args, project) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: project,
      env: cliEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({
      status,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

function mustRun(args, project) {
  const result = run(args, project);
  assert.equal(result.error, undefined, `${args.join(" ")} failed to execute: ${result.error?.message}`);
  assert.equal(result.status, 0, `${args.join(" ")}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result;
}

function mustRunJson(args, project) {
  return JSON.parse(mustRun([...args, "--json"], project).stdout);
}

function mustFail(args, project, pattern) {
  const result = run(args, project);
  assert.equal(result.error, undefined, `${args.join(" ")} failed to execute: ${result.error?.message}`);
  assert.notEqual(result.status, 0, `${args.join(" ")} unexpectedly passed\n${result.stdout}`);
  assert.match(`${result.stdout}\n${result.stderr}`, pattern);
  return result;
}

function git(project, args) {
  const result = spawnSync("git", ["-C", project, ...args], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, `git ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
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
  return ["--actor-type", "human", "--approval-source", "explicit-user", "--summary", summary];
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

function isoAfter(milliseconds) {
  return new Date(Date.now() + milliseconds).toISOString();
}

const DAY = 24 * 60 * 60 * 1000;
// One routine requirement per delivery keeps each story's output independent.
const REQUIREMENTS = ["REQ-TOIL", "REQ-TOIL-2", "REQ-TOIL-3"];

/** A project with one approved requirement and output format, before any delivery. */
function initializeProject(label) {
  const project = temporaryProject(label);
  mustRun(["init", "--root", project, "--project-name", "Standing approvals"], project);
  git(project, ["init"]);
  git(project, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  git(project, ["config", "user.name", "Standing E2E"]);
  git(project, ["config", "user.email", "standing-e2e@example.invalid"]);
  writeProjectFile(project, "src/index.mjs", "export const ready = true;\n");
  writeProjectFile(project, ".gitignore", "docs/local-release-*/\n");
  git(project, ["add", "-A"]);
  git(project, ["commit", "-m", "test: establish base"]);
  for (const requirementId of REQUIREMENTS) {
    mustRun([
      "requirement", "propose",
      "--root", project,
      "--id", requirementId,
      "--title", `Routine flag cleanup ${requirementId}`,
      "--summary", "Remove retired feature flags inside the approved write scope.",
      "--acceptance", "Each cleanup is verified and released locally.",
      "--autonomy-ceiling", "checkpointed",
      "--write-path", "docs",
      "--write-path", "src",
    ], project);
    mustRun(["requirement", "approve", "--root", project, "--id", requirementId, ...humanApproval(`Approve ${requirementId}`)], project);
  }
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
  return project;
}

function proposeStanding(project, overrides = {}) {
  const id = overrides.id || "SA-FLAGS";
  const args = [
    "autonomy", "standing", "propose",
    "--root", project,
    "--id", id,
    "--recipe", "flag-cleanup",
    "--description", "Remove one retired feature flag and release it locally",
    ...(overrides.requirements || REQUIREMENTS).flatMap((item) => ["--requirement", item]),
    ...(overrides.writePaths || ["src", "docs"]).flatMap((item) => ["--write-path", item]),
    "--max-changed-files", String(overrides.maxFiles ?? 10),
    "--max-changed-lines", String(overrides.maxLines ?? 200),
    "--destination", overrides.destination || "local_release",
    "--max-deliveries", String(overrides.maxDeliveries ?? 2),
    "--expires-at", overrides.expiresAt || isoAfter(7 * DAY),
    ...(overrides.extra || []),
  ];
  return mustRunJson(args, project);
}

function grantStanding(project, overrides = {}) {
  const proposal = proposeStanding(project, overrides);
  const id = proposal.standing_approval.id;
  mustRunJson([
    "autonomy", "standing", "approve",
    "--root", project,
    "--id", id,
    ...humanApproval(`Approve standing approval ${id}`),
  ], project);
  return id;
}

/** Story, contract, and delivery prepared under a standing approval, with zero confirmations. */
function prepareDelivery(project, suffix, standingId, options = {}) {
  const storyId = `ST-${suffix}`;
  const contractId = `CONTRACT-${suffix}`;
  const profileId = `AUT-${suffix}`;
  const releaseRoot = path.join(project, "docs", `local-release-${suffix.toLowerCase()}`);
  const releaseOutput = path.join(releaseRoot, "app");
  const requirementId = options.requirementId || "REQ-TOIL";
  mustRun([
    "story", "create",
    "--root", project,
    "--id", storyId,
    "--title", `Clean up flag ${suffix}`,
    "--phase", "implementation",
    "--status", "ready",
    "--requirement", requirementId,
    "--acceptance", `Flag ${suffix} is removed and verified.`,
  ], project);
  mustRun([
    "contract", "create",
    "--root", project,
    "--id", contractId,
    "--story", storyId,
    "--phase", "implementation",
    "--delivery-profile", profileId,
    "--level", "checkpointed",
    "--context-summary", `Remove flag ${suffix} inside the approved boundary.`,
    "--qa", "Who confirms the delivery?|The standing approval",
    "--tool", "node",
    "--output-ref", "implementation-summary:implementation-summary-v1:new",
  ], project);
  const contract = mustRunJson([
    "contract", "approve",
    "--root", project,
    "--id", contractId,
    "--standing-approval", standingId,
  ], project);
  assert.equal(contract.approval.approval_source, "standing-approval");
  const proposed = mustRunJson([
    "autonomy", "delivery", "propose",
    "--root", project,
    "--id", profileId,
    "--delivery", `LOCAL-${suffix}`,
    "--kind", "local_release",
    "--story", storyId,
    "--contract", contractId,
    "--requirement", requirementId,
    "--level", options.level || "checkpointed",
    "--target-root", releaseRoot,
    "--write-path", releaseOutput,
    "--smoke-test", SMOKE,
    "--rollback", ROLLBACK,
    "--standing-approval", standingId,
  ], project);
  assert.equal(proposed.delivery_profile.extensions.standing_approval_ref.id, standingId);
  return { storyId, contractId, profileId, releaseRoot, releaseOutput, requirementId };
}

function approveDelivery(project, delivery, standingId) {
  return mustRunJson([
    "autonomy", "delivery", "approve",
    "--root", project,
    "--id", delivery.profileId,
    "--phase", "implementation",
    "--standing-approval", standingId,
  ], project);
}

function deliveryAction(project, profileId, action, extra = []) {
  return run([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", profileId,
    "--action", action,
    ...extra,
    "--json",
  ], project);
}

function mustAuthorize(project, profileId, action, extra = []) {
  const result = deliveryAction(project, profileId, action, extra);
  assert.equal(result.status, 0, `${action}\n${result.stdout}\n${result.stderr}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "authorized", `${action} was not authorized: ${result.stdout}`);
  return payload;
}

function startDelivery(project, delivery) {
  const workflowId = `delivery-${delivery.storyId.toLowerCase()}`;
  mustRun([
    "workflow", "instance", "start",
    "--root", project,
    "--id", workflowId,
    "--definition", "software-project",
    "--definition-version", "3",
    "--story", delivery.storyId,
  ], project);
  const taskStart = mustRunJson([
    "task", "start",
    "--root", project,
    "--intent-json", implementationIntent(delivery.storyId),
    "--story", delivery.storyId,
    "--phase", "implementation",
    "--contract-id", delivery.contractId,
    "--delivery-profile", delivery.profileId,
  ], project);
  assert.equal(taskStart.execution_allowed, true, JSON.stringify(taskStart, null, 2));
  mustRun(["story", "claim", "--root", project, "--id", delivery.storyId, "--agent", "codex"], project);
  return workflowId;
}

function transition(project, workflowId, to) {
  mustRun([
    "workflow", "instance", "transition",
    "--root", project,
    "--id", workflowId,
    "--to", to,
    "--request-id", `${workflowId}-${to}`,
  ], project);
}

function completeStep(project, storyId, step, extra = []) {
  mustRun([
    "story", "complete-step",
    "--root", project,
    "--id", storyId,
    "--step", step,
    "--summary", `${step} completed against the approved boundary`,
    ...extra,
  ], project);
}

function appendTrace(project, storyId, type, evidence) {
  mustRun([
    "trace", "append",
    "--root", project,
    "--story", storyId,
    "--type", type,
    "--outcome", "passed",
    "--summary", `${type} attempt passed`,
    "--evidence", evidence,
    "--actor", "codex",
    "--actor-type", "agent",
  ], project);
}

/** Implementation through the strict validation gate, then into release. */
function implementAndValidate(project, delivery, workflowId, sourceChange) {
  const lower = delivery.storyId.toLowerCase();
  writeProjectFile(project, sourceChange.path, sourceChange.content);
  const artifact = writeProjectFile(project, `docs/summary-${lower}.md`, `# Summary\n\n${delivery.storyId} done.\n`);
  mustRun([
    "output", "link",
    "--root", project,
    "--story", delivery.storyId,
    "--type", "implementation-summary",
    "--artifact", artifact,
    "--template", "implementation-summary-v1",
    "--mode", "new",
    "--requirement", delivery.requirementId,
  ], project);
  for (const [step, next] of [
    ["discovery", "analysis"],
    ["analysis", "design"],
    ["design", "implementation"],
    ["implementation", "validation"],
  ]) {
    completeStep(project, delivery.storyId, step, step === "implementation" ? ["--type", "implementation-summary"] : []);
    transition(project, workflowId, next);
  }
  const testEvidence = writeProjectFile(project, `.sdlc/tests/${delivery.storyId}-test.json`, "{\"passed\":true}\n");
  appendTrace(project, delivery.storyId, "test", testEvidence);
  completeStep(project, delivery.storyId, "validation", ["--evidence", testEvidence]);
  mustRun(["secret", "scan", "--root", project, "--story", delivery.storyId], project);
  mustRunJson(["gate", "check", "--root", project, "--strict", "--story", delivery.storyId], project);
  transition(project, workflowId, "release");
}

/** build.local, rollback.verify, and release.local, each confirmed by the standing approval. */
function releaseUnderStanding(project, delivery) {
  const lower = delivery.storyId.toLowerCase();
  const build = mustAuthorize(project, delivery.profileId, "build.local");
  assert.equal(build.action_receipt.approval.approval_source, "standing-approval");
  const buildEvidence = writeProjectFile(project, `docs/build-${lower}.json`, "{\"built\":true}\n");
  fs.mkdirSync(delivery.releaseOutput, { recursive: true });
  fs.writeFileSync(path.join(delivery.releaseOutput, "release-proof.txt"), `${delivery.storyId}\n`);
  mustRun([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", delivery.profileId,
    "--action", "build.local",
    "--outcome", "passed",
    "--authorization-receipt", build.action_receipt.id,
    "--evidence", buildEvidence,
  ], project);
  const rollbackEvidence = writeProjectFile(project, `docs/rollback-${lower}.json`, "{\"restored\":true}\n");
  const rollback = mustAuthorize(project, delivery.profileId, "rollback.verify", ["--evidence", rollbackEvidence]);
  assert.equal(rollback.action_receipt.approval.approval_source, "standing-approval");
  mustRun([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", delivery.profileId,
    "--action", "rollback.verify",
    "--outcome", "passed",
    "--evidence", rollbackEvidence,
  ], project);
  const release = mustAuthorize(project, delivery.profileId, "release.local");
  assert.equal(release.action_receipt.approval.approval_source, "standing-approval");
  const releaseProof = writeProjectFile(project, `docs/release-proof-${lower}.json`, "{\"released\":true}\n");
  mustRunJson([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", delivery.profileId,
    "--action", "release.local",
    "--outcome", "passed",
    "--evidence", releaseProof,
    "--smoke-test", SMOKE,
    "--rollback", ROLLBACK,
  ], project);
}

function finishLifecycle(project, delivery, workflowId) {
  const releaseEvidence = writeProjectFile(project, `.sdlc/tests/${delivery.storyId}-release.json`, "{\"ready\":true}\n");
  appendTrace(project, delivery.storyId, "release", releaseEvidence);
  completeStep(project, delivery.storyId, "release", ["--evidence", releaseEvidence]);
  transition(project, workflowId, "operations");
  completeStep(project, delivery.storyId, "operations");
  mustRun(["secret", "scan", "--root", project, "--story", delivery.storyId], project);
  mustRun([
    "story", "release",
    "--root", project,
    "--id", delivery.storyId,
    "--agent", "codex",
    "--reason", "Release the completed lane before final certification.",
  ], project);
  const certified = mustRunJson([
    "gate", "check",
    "--root", project,
    "--strict",
    "--story", delivery.storyId,
    "--lifecycle-complete",
  ], project);
  assert.equal(certified.status, "passed", JSON.stringify(certified.errors));
  return certified;
}

function confirmationsRequested(project, storyId) {
  const trace = fs.readFileSync(path.join(project, ".sdlc", "traces", `${storyId}.jsonl`), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return trace;
}

test("two local deliveries run under one standing approval with zero confirmations and certify", {
  skip: hostSupportsLocalSmokeSandbox() ? false : SKIP_REASON,
}, () => {
  const project = initializeProject("happy");
  const standingId = grantStanding(project);
  for (const [index, suffix] of ["ONE", "TWO"].entries()) {
    const delivery = prepareDelivery(project, suffix, standingId, { requirementId: REQUIREMENTS[index] });
    const approved = approveDelivery(project, delivery, standingId);
    assert.equal(approved.status, "active");
    assert.equal(approved.approval.approval.approval_source, "standing-approval");
    const workflowId = startDelivery(project, delivery);
    implementAndValidate(project, delivery, workflowId, {
      path: `src/flag-${suffix.toLowerCase()}.mjs`,
      content: `export const flag${suffix} = false;\n`,
    });
    releaseUnderStanding(project, delivery);
    finishLifecycle(project, delivery, workflowId);
    const status = mustRunJson(["autonomy", "standing", "status", "--root", project, "--id", standingId], project);
    const summary = status.standing_approvals[0];
    assert.equal(summary.used, index + 1);
    assert.equal(summary.remaining, 1 - index);
    assert.equal(summary.uses.at(-1).delivery_id, `LOCAL-${suffix}`);
    const trace = confirmationsRequested(project, delivery.storyId);
    for (const kind of ["use", "cover"]) {
      assert.ok(trace.some((event) => event.action === `autonomy.standing.${kind}`), `missing ${kind} trace`);
    }
    assert.ok(!trace.some((event) => event.actor?.type === "human"), "no human confirmation was recorded for the delivery");
  }
  const status = mustRunJson(["autonomy", "standing", "status", "--root", project], project);
  assert.equal(status.standing_approvals[0].status, "exhausted");
  const projectStatus = mustRunJson(["status", "--root", project], project);
  assert.equal(projectStatus.summary.completed_work, 2, JSON.stringify(projectStatus.summary));
  assert.equal(projectStatus.standing_approvals[0].id, standingId);
});
