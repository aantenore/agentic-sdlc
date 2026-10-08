import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { buildHostApprovalReceipt } from "../lib/authorization-receipts.mjs";
import { buildObservatoryViewModel } from "../lib/change-observatory/index.mjs";
import { buildDeliveryExecutionProfileV2 } from "../lib/autonomy-policy.mjs";
import { hashApprovalSubject } from "../lib/lifecycle/authorization.mjs";
import {
  buildStandingApprovalDecision,
  standingHostReceiptRequest,
  standingRecordHash,
} from "../lib/standing-approvals.mjs";
import { claimSharedStandingSlot, publishSharedStandingRevocation } from "../lib/engine/standing-shared.mjs";
import { STANDING_COORDINATION_DEFAULTS } from "../lib/standing-shared-state.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPOSITORY_ROOT, "bin", "agentic-sdlc.mjs");
const TEMPORARY_PROJECTS = new Set();
const ISOLATED_ENVIRONMENT_KEYS = [
  "CI",
  "GITHUB_ACTIONS",
  "GITHUB_ACTOR",
  "CODEX_AGENT_NAME",
  "CODEX_THREAD_ID",
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
    ...((overrides.destination || "local_release") === "pull_request"
      ? ["--repository", overrides.repository || "aantenore/agentic-sdlc"]
      : []),
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
    ...(options.directContract
      ? humanApproval(`Approve ${contractId}`)
      : ["--standing-approval", standingId]),
  ], project);
  assert.equal(contract.approval.approval_source, options.directContract ? "explicit-user" : "standing-approval");
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
}, async () => {
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
  const model = await buildObservatoryViewModel(project);
  const standingItem = model.decisions.find((item) => item.type === "standing-approval");
  assert.ok(standingItem, "the observatory lists the standing approval");
  assert.equal(standingItem.status, "exhausted");
  assert.match(standingItem.summary, /2 of 2 deliveries used, 0 left; expires /u);
  const uses = model.decisions.filter((item) => item.type === "standing-approval-use");
  assert.deepEqual(uses.map((item) => item.summary).sort(), [
    "Delivery LOCAL-ONE used slot 1 of 2.",
    "Delivery LOCAL-TWO used slot 2 of 2.",
  ]);
});

/** Task start only: enough to exercise delivery actions without a workflow instance. */
function startTask(project, delivery) {
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
}

/** A bare repository standing in for the shared remote, plus a second copy of the project. */
function sharedRemote(project, label) {
  const remote = temporaryProject(`${label}-remote`);
  spawnSync("git", ["init", "--bare", "--quiet", remote], { encoding: "utf8" });
  git(project, ["remote", "add", "origin", remote]);
  git(project, ["push", "--quiet", "origin", "main"]);
  const otherCopy = temporaryProject(`${label}-other-copy`);
  fs.rmSync(otherCopy, { recursive: true, force: true });
  const cloned = spawnSync("git", ["clone", "--quiet", remote, otherCopy], { encoding: "utf8" });
  assert.equal(cloned.status, 0, cloned.stderr);
  return { remote, otherCopy };
}

function sharedRefs(remote) {
  const result = spawnSync("git", ["ls-remote", remote, "refs/agentic-sdlc/*"], { encoding: "utf8" });
  return result.stdout.split("\n").filter(Boolean).map((line) => line.split("\t")[1]);
}

function standingProposal(project, standingId) {
  return readJson(project, `.sdlc/autonomy/standing/${standingId}/proposal.json`);
}

/** Changes the coordination setting the way a person would: edit, then re-pin the configuration. */
function setCoordination(project, coordination) {
  const configPath = path.join(project, ".sdlc", "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.standing_approval_policy = { ...config.standing_approval_policy, coordination };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  const preview = mustRunJson(["config", "migrate", "--root", project], project);
  mustRunJson([
    "config", "migrate", "--root", project, "--apply", "--plan-hash", preview.plan.plan_hash, "--actor-type", "human",
  ], project);
}

function createBrief(project, suffix, requirementId) {
  mustRun([
    "story", "create", "--root", project, "--id", `ST-${suffix}`, "--title", suffix, "--phase", "implementation",
    "--status", "ready", "--requirement", requirementId, "--acceptance", "Observable.",
  ], project);
  mustRun([
    "contract", "create", "--root", project, "--id", `CONTRACT-${suffix}`, "--story", `ST-${suffix}`, "--phase", "implementation",
    "--delivery-profile", `AUT-${suffix}`, "--level", "checkpointed", "--context-summary", "Shared state check.",
    "--qa", "Who confirms?|The standing approval", "--tool", "node",
    "--output-ref", "implementation-summary:implementation-summary-v1:new",
  ], project);
}

function startedDelivery(label, standingOverrides = {}) {
  const project = initializeProject(label);
  const standingId = grantStanding(project, standingOverrides);
  const delivery = prepareDelivery(project, "ONE", standingId);
  approveDelivery(project, delivery, standingId);
  startTask(project, delivery);
  return { project, standingId, delivery };
}

function expectFallback(project, profileId, action, pattern, extra = []) {
  const result = deliveryAction(project, profileId, action, extra);
  assert.equal(result.status, 0, `${action}\n${result.stdout}\n${result.stderr}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "checkpoint_required", result.stdout);
  assert.equal(payload.standing_approval?.covered, false, result.stdout);
  assert.match(payload.standing_approval.reasons.join("\n"), pattern);
  assert.ok(payload.reason_codes.includes("autonomy.standing_approval_not_covering"));
  return payload;
}

function confirmDirectly(project, profileId, action, extra = []) {
  const payload = mustAuthorize(project, profileId, action, [
    ...extra,
    "--confirm-action",
    ...humanApproval(`Approve ${action} directly`),
  ]);
  assert.equal(payload.action_receipt.approval.approval_source, "explicit-user");
  return payload;
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

test("a change outside the standing approval paths falls back to a direct confirmation", () => {
  const { project, delivery } = startedDelivery("paths", { writePaths: ["src/flags", "docs"] });
  writeProjectFile(project, "src/other.mjs", "export const other = 1;\n");
  const fallback = expectFallback(project, delivery.profileId, "build.local", /files outside the allowed paths changed: src\/other\.mjs/u);
  assert.match(fallback.standing_approval.explanation, /Fall back to the normal confirmation/u);
  const trace = confirmationsRequested(project, delivery.storyId);
  assert.ok(trace.some((event) => event.action === "autonomy.standing.fallback"));
  confirmDirectly(project, delivery.profileId, "build.local");
});

test("a change larger than the standing approval limits falls back", () => {
  const { project, delivery } = startedDelivery("size", { maxLines: 3, maxFiles: 1 });
  writeProjectFile(project, "src/flag.mjs", Array.from({ length: 10 }, (_, index) => `export const line${index} = ${index};`).join("\n") + "\n");
  writeProjectFile(project, "docs/notes.md", "notes\n");
  expectFallback(project, delivery.profileId, "build.local", /2 files changed, above the limit of 1[\s\S]*11 lines changed, above the limit of 3/u);
});

test("a deleted tracked file outside the standing approval paths falls back", () => {
  const { project, delivery } = startedDelivery("deletion", { writePaths: ["src/flags", "docs"] });
  fs.rmSync(path.join(project, "src", "index.mjs"));
  expectFallback(project, delivery.profileId, "build.local", /tracked files outside the allowed paths were deleted: src\/index\.mjs/u);
});

test("a delivery to a destination the standing approval does not cover is refused", () => {
  const project = initializeProject("destination");
  const standingId = grantStanding(project, { destination: "pull_request" });
  const result = run([
    "story", "create", "--root", project, "--id", "ST-DEST", "--title", "Destination", "--phase", "implementation",
    "--status", "ready", "--requirement", "REQ-TOIL", "--acceptance", "Observable.",
  ], project);
  assert.equal(result.status, 0, result.stderr);
  mustRun([
    "contract", "create", "--root", project, "--id", "CONTRACT-DEST", "--story", "ST-DEST", "--phase", "implementation",
    "--delivery-profile", "AUT-DEST", "--level", "checkpointed", "--context-summary", "Destination check.",
    "--qa", "Who confirms?|The standing approval", "--tool", "node",
    "--output-ref", "implementation-summary:implementation-summary-v1:new",
  ], project);
  mustFail([
    "contract", "approve", "--root", project, "--id", "CONTRACT-DEST", "--standing-approval", standingId, "--status", "rejected",
  ], project, /can only approve/u);
  mustFail([
    "contract", "approve", "--root", project, "--id", "CONTRACT-DEST", "--standing-approval", standingId, "--actor-type", "human",
  ], project, /cannot be combined with --actor-type/u);
  mustRun(["contract", "approve", "--root", project, "--id", "CONTRACT-DEST", "--standing-approval", standingId], project);
  mustFail([
    "autonomy", "delivery", "propose", "--root", project, "--id", "AUT-DEST", "--delivery", "LOCAL-DEST",
    "--kind", "local_release", "--story", "ST-DEST", "--contract", "CONTRACT-DEST", "--requirement", "REQ-TOIL",
    "--level", "checkpointed", "--target-root", path.join(project, "docs", "local-release-dest"),
    "--write-path", path.join(project, "docs", "local-release-dest", "app"), "--smoke-test", SMOKE,
    "--rollback", ROLLBACK, "--standing-approval", standingId,
  ], project, /covers only pull request deliveries[\s\S]*Fall back to the normal confirmation/u);
});

test("an expired standing approval covers nothing", () => {
  const project = initializeProject("expiry");
  const standingId = grantStanding(project, { expiresAt: isoAfter(4_000) });
  sleep(5_000);
  const result = run([
    "story", "create", "--root", project, "--id", "ST-EXP", "--title", "Expiry", "--phase", "implementation",
    "--status", "ready", "--requirement", "REQ-TOIL", "--acceptance", "Observable.",
  ], project);
  assert.equal(result.status, 0, result.stderr);
  mustRun([
    "contract", "create", "--root", project, "--id", "CONTRACT-EXP", "--story", "ST-EXP", "--phase", "implementation",
    "--delivery-profile", "AUT-EXP", "--level", "checkpointed", "--context-summary", "Expiry check.",
    "--qa", "Who confirms?|The standing approval", "--tool", "node",
    "--output-ref", "implementation-summary:implementation-summary-v1:new",
  ], project);
  mustFail(["contract", "approve", "--root", project, "--id", "CONTRACT-EXP", "--standing-approval", standingId], project, /it is expired/u);
  const status = mustRunJson(["autonomy", "standing", "status", "--root", project, "--id", standingId], project);
  assert.equal(status.standing_approvals[0].status, "expired");
});

test("an expiry beyond the configured maximum is refused at proposal", () => {
  const project = initializeProject("max-expiry");
  mustFail([
    "autonomy", "standing", "propose", "--root", project, "--id", "SA-LONG", "--recipe", "dependency-bump",
    "--description", "Too long", "--requirement", "REQ-TOIL", "--write-path", "src", "--max-changed-files", "1",
    "--max-changed-lines", "1", "--destination", "local_release", "--max-deliveries", "1",
    "--expires-at", isoAfter(90 * DAY),
  ], project, /within 30 days/u);
});

test("the delivery count is enforced and exhaustion falls back", () => {
  const project = initializeProject("count");
  const standingId = grantStanding(project, { maxDeliveries: 1 });
  const first = prepareDelivery(project, "ONE", standingId);
  approveDelivery(project, first, standingId);
  const status = mustRunJson(["autonomy", "standing", "status", "--root", project, "--id", standingId], project);
  assert.equal(status.standing_approvals[0].status, "exhausted");
  assert.equal(status.standing_approvals[0].remaining, 0);
  mustRun([
    "story", "create", "--root", project, "--id", "ST-TWO", "--title", "Second", "--phase", "implementation",
    "--status", "ready", "--requirement", "REQ-TOIL-2", "--acceptance", "Observable.",
  ], project);
  mustRun([
    "contract", "create", "--root", project, "--id", "CONTRACT-TWO", "--story", "ST-TWO", "--phase", "implementation",
    "--delivery-profile", "AUT-TWO", "--level", "checkpointed", "--context-summary", "Second delivery.",
    "--qa", "Who confirms?|The standing approval", "--tool", "node",
    "--output-ref", "implementation-summary:implementation-summary-v1:new",
  ], project);
  mustFail(["contract", "approve", "--root", project, "--id", "CONTRACT-TWO", "--standing-approval", standingId], project, /it is exhausted/u);
  // The delivery that holds the only slot keeps its coverage.
  startTask(project, first);
  writeProjectFile(project, "src/flag-one.mjs", "export const one = false;\n");
  const build = mustAuthorize(project, first.profileId, "build.local");
  assert.equal(build.action_receipt.approval.approval_source, "standing-approval");
});

test("a standing approval with a cost budget is refused because delivery cost cannot be measured", () => {
  const project = initializeProject("budget");
  for (const extra of [
    ["--budget-per-delivery", "5", "--budget-total", "20", "--currency", "EUR"],
    ["--budget-total", "20", "--currency", "EUR"],
  ]) {
    const result = run([
      "autonomy", "standing", "propose", "--root", project, "--id", "SA-BUDGET",
      "--recipe", "flag-cleanup", "--description", "Remove one retired feature flag",
      ...REQUIREMENTS.flatMap((item) => ["--requirement", item]),
      "--write-path", "src", "--max-changed-files", "10", "--max-changed-lines", "200",
      "--destination", "local_release", "--max-deliveries", "2", "--expires-at", isoAfter(7 * DAY),
      ...extra,
    ], project);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(`${result.stdout}\n${result.stderr}`, /cannot carry a cost budget yet[\s\S]*would never cover anything[\s\S]*Nothing was recorded/u);
  }
  assert.equal(fs.existsSync(path.join(project, ".sdlc", "autonomy", "standing", "SA-BUDGET")), false);
  // Without the budget options the same bounds are accepted.
  assert.equal(proposeStanding(project, { id: "SA-BUDGET" }).standing_approval.budget, null);
  assert.equal(fs.existsSync(path.join(project, ".sdlc", "autonomy", "standing", "SA-BUDGET")), true);
});

test("a configuration change after approval suspends the standing approval", () => {
  const project = initializeProject("config");
  const standingId = grantStanding(project);
  const preview = mustRunJson(["config", "migrate", "--root", project, "--autonomy-mode", "observe"], project);
  mustRunJson([
    "config", "migrate", "--root", project, "--autonomy-mode", "observe", "--apply",
    "--plan-hash", preview.plan.plan_hash, "--actor-type", "human",
  ], project);
  const status = mustRunJson(["autonomy", "standing", "status", "--root", project, "--id", standingId], project);
  assert.equal(status.standing_approvals[0].status, "stale");
  assert.match(status.standing_approvals[0].reasons.join("\n"), /configuration changed/u);
  mustRun([
    "story", "create", "--root", project, "--id", "ST-CFG", "--title", "Config", "--phase", "implementation",
    "--status", "ready", "--requirement", "REQ-TOIL", "--acceptance", "Observable.",
  ], project);
  mustRun([
    "contract", "create", "--root", project, "--id", "CONTRACT-CFG", "--story", "ST-CFG", "--phase", "implementation",
    "--delivery-profile", "AUT-CFG", "--level", "checkpointed", "--context-summary", "Config check.",
    "--qa", "Who confirms?|The standing approval", "--tool", "node",
    "--output-ref", "implementation-summary:implementation-summary-v1:new",
  ], project);
  mustFail(["contract", "approve", "--root", project, "--id", "CONTRACT-CFG", "--standing-approval", standingId], project, /it is stale/u);
});

test("revoking a standing approval mid-delivery falls back at the next step", {
  skip: hostSupportsLocalSmokeSandbox() ? false : SKIP_REASON,
}, () => {
  const { project, standingId, delivery } = startedDelivery("revoke");
  writeProjectFile(project, "src/flag-one.mjs", "export const one = false;\n");
  const build = mustAuthorize(project, delivery.profileId, "build.local");
  assert.equal(build.action_receipt.approval.approval_source, "standing-approval");
  fs.mkdirSync(delivery.releaseOutput, { recursive: true });
  const buildEvidence = writeProjectFile(project, "docs/build-one.json", "{\"built\":true}\n");
  mustRun([
    "autonomy", "delivery", "action", "--root", project, "--id", delivery.profileId, "--action", "build.local",
    "--outcome", "passed", "--authorization-receipt", build.action_receipt.id, "--evidence", buildEvidence,
  ], project);
  const rollbackEvidence = writeProjectFile(project, "docs/rollback-one.json", "{\"restored\":true}\n");
  const rollback = mustAuthorize(project, delivery.profileId, "rollback.verify", ["--evidence", rollbackEvidence]);
  assert.equal(rollback.action_receipt.approval.approval_source, "standing-approval");
  const revoked = mustRunJson([
    "autonomy", "standing", "revoke", "--root", project, "--id", standingId,
    "--reason", "Flag cleanups need a review again", ...humanApproval("Stop the standing approval"),
  ], project);
  assert.deepEqual(revoked.affected_deliveries, ["LOCAL-ONE"]);
  // The action authorized before the revocation cannot be completed under it.
  mustFail([
    "autonomy", "delivery", "action", "--root", project, "--id", delivery.profileId, "--action", "rollback.verify",
    "--outcome", "passed", "--authorization-receipt", rollback.action_receipt.id, "--evidence", rollbackEvidence,
  ], project, /it is revoked[\s\S]*can no longer be completed under it/u);
  expectFallback(project, delivery.profileId, "rollback.verify", /it is revoked/u, ["--evidence", rollbackEvidence]);
  const direct = confirmDirectly(project, delivery.profileId, "rollback.verify", ["--evidence", rollbackEvidence]);
  mustRun([
    "autonomy", "delivery", "action", "--root", project, "--id", delivery.profileId, "--action", "rollback.verify",
    "--outcome", "passed", "--authorization-receipt", direct.action_receipt.id, "--evidence", rollbackEvidence,
  ], project);
  expectFallback(project, delivery.profileId, "release.local", /it is revoked/u);
  const status = mustRunJson(["autonomy", "standing", "status", "--root", project, "--id", standingId], project);
  assert.equal(status.standing_approvals[0].status, "revoked");
  mustRunJson([
    "autonomy", "standing", "revoke", "--root", project, "--id", standingId,
    "--reason", "Flag cleanups need a review again", ...humanApproval("Stop the standing approval"),
  ], project);
});

test("only a person or CI can approve or revoke a standing approval", () => {
  const project = initializeProject("actor");
  const proposal = proposeStanding(project);
  const id = proposal.standing_approval.id;
  mustFail([
    "autonomy", "standing", "approve", "--root", project, "--id", id,
    "--actor-type", "agent", "--approval-source", "automation", "--summary", "Self-approved",
  ], project, /explicit approval/u);
  mustFail(["contract", "approve", "--root", project, "--id", "CONTRACT-X", "--standing-approval", id], project, /does not exist|not been approved|proposed/u);
  // Inside an agent's own session even a human-attributed approval is refused.
  for (const marker of ["CLAUDECODE", "CODEX_THREAD_ID"]) {
    const inside = spawnSync(process.execPath, [
      CLI, "autonomy", "standing", "approve", "--root", project, "--id", id, ...humanApproval("Approve it"),
    ], { cwd: project, encoding: "utf8", env: { ...cliEnvironment(), [marker]: "1" }, timeout: 120_000 });
    assert.notEqual(inside.status, 0, marker);
    assert.match(`${inside.stdout}${inside.stderr}`, /only be approved by the user, outside the agent's session/u, marker);
  }
  const status = mustRunJson(["autonomy", "standing", "status", "--root", project, "--id", id], project);
  assert.equal(status.standing_approvals[0].status, "proposed");
});

test("merge and production are never coverable by a standing approval", () => {
  const project = initializeProject("merge");
  git(project, ["remote", "add", "origin", "https://github.com/aantenore/agentic-sdlc.git"]);
  git(project, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  git(project, ["checkout", "-b", "standing/sa-flags/pr-1"]);
  // The remote is a public repository the test cannot write to, so nothing is shared.
  setCoordination(project, { mode: "local_only" });
  const standingId = grantStanding(project, { destination: "pull_request", writePaths: ["src"] });
  for (const [suffix, merge] of [["MERGE", true], ["PR", false]]) {
    mustRun([
      "story", "create", "--root", project, "--id", `ST-${suffix}`, "--title", suffix, "--phase", "implementation",
      "--status", "ready", "--requirement", suffix === "PR" ? "REQ-TOIL" : "REQ-TOIL-2", "--acceptance", "Observable.",
    ], project);
    mustRun([
      "contract", "create", "--root", project, "--id", `CONTRACT-${suffix}`, "--story", `ST-${suffix}`, "--phase", "implementation",
      "--delivery-profile", `AUT-${suffix}`, "--level", "checkpointed", "--context-summary", "Pull request check.",
      "--qa", "Who confirms?|The standing approval", "--tool", "node",
      "--output-ref", "implementation-summary:implementation-summary-v1:new",
    ], project);
    mustRun(["contract", "approve", "--root", project, "--id", `CONTRACT-${suffix}`, "--standing-approval", standingId], project);
    const propose = [
      "autonomy", "delivery", "propose", "--root", project, "--id", `AUT-${suffix}`, "--delivery", `PR-${suffix}`,
      "--kind", "pull_request", "--story", `ST-${suffix}`, "--contract", `CONTRACT-${suffix}`,
      "--requirement", suffix === "PR" ? "REQ-TOIL" : "REQ-TOIL-2", "--level", "checkpointed",
      "--repository", "aantenore/agentic-sdlc", "--base", "main", "--head", "standing/sa-flags/pr-1", "--write-path", "src",
      ...(merge ? ["--merge-allowed"] : []), "--standing-approval", standingId,
    ];
    if (merge) {
      mustFail(propose, project, /merging a pull request is never covered/u);
      continue;
    }
    mustRunJson(propose, project);
    approveDelivery(project, { profileId: `AUT-${suffix}` }, standingId);
    startTask(project, { storyId: `ST-${suffix}`, contractId: `CONTRACT-${suffix}`, profileId: `AUT-${suffix}` });
    writeProjectFile(project, "src/flag-pr.mjs", "export const pr = false;\n");
    git(project, ["add", "src/flag-pr.mjs"]);
    const commit = mustAuthorize(project, `AUT-${suffix}`, "git.commit", ["--scope-path", "src/flag-pr.mjs"]);
    assert.equal(commit.action_receipt.approval.approval_source, "standing-approval");
    // A merge is outside the delivery's actions: neither the standing approval nor the profile allow it.
    const merged = deliveryAction(project, `AUT-${suffix}`, "pull_request.merge", ["--pr-url", "https://github.com/aantenore/agentic-sdlc/pull/1"]);
    assert.notEqual(merged.status, 0);
    assert.match(`${merged.stdout}${merged.stderr}`, /outside the approved action set|does not authorize pull_request\.merge/u);
  }
});

test("a delegated pull request never pushes outside its repository and branch prefix", () => {
  const project = initializeProject("branches");
  git(project, ["remote", "add", "origin", "https://github.com/aantenore/agentic-sdlc.git"]);
  git(project, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  setCoordination(project, { mode: "local_only" });
  const standingId = grantStanding(project, { destination: "pull_request", writePaths: ["src"], maxDeliveries: 1 });
  for (const [contractId, phase, profileId, storyId] of [
    ["CONTRACT-BR", "implementation", "AUT-BR", "ST-BR"],
    ["CONTRACT-BR-2", "implementation", "AUT-BR-2", "ST-BR-2"],
    ["CONTRACT-REL", "release", "AUT-REL", "ST-REL"],
  ]) {
    mustRun([
      "story", "create", "--root", project, "--id", storyId, "--title", storyId, "--phase", "implementation",
      "--status", "ready", "--requirement", "REQ-TOIL", "--acceptance", "Observable.",
    ], project);
    mustRun([
      "contract", "create", "--root", project, "--id", contractId, "--story", storyId, "--phase", phase,
      "--delivery-profile", profileId, "--level", "checkpointed", "--context-summary", "Branch check.",
      "--qa", "Who confirms?|The standing approval", "--tool", "node",
      "--output-ref", "implementation-summary:implementation-summary-v1:new",
    ], project);
  }
  mustFail(["contract", "approve", "--root", project, "--id", "CONTRACT-REL", "--standing-approval", standingId], project, /release phase, which a standing approval never approves/u);
  mustRun(["contract", "approve", "--root", project, "--id", "CONTRACT-BR", "--standing-approval", standingId], project);
  // One delivery allowed: a second brief for another delivery needs the person.
  mustFail(["contract", "approve", "--root", project, "--id", "CONTRACT-BR-2", "--standing-approval", standingId], project, /the most it allows is 1/u);
  const propose = (head, repository = "aantenore/agentic-sdlc") => [
    "autonomy", "delivery", "propose", "--root", project, "--id", "AUT-BR", "--delivery", "PR-BR",
    "--kind", "pull_request", "--story", "ST-BR", "--contract", "CONTRACT-BR", "--requirement", "REQ-TOIL",
    "--level", "checkpointed", "--repository", repository, "--base", head === "main" ? "develop" : "main",
    "--head", head, "--write-path", "src", "--standing-approval", standingId,
  ];
  mustFail(propose("main"), project, /pushing to branch main is never covered/u);
  mustFail(propose("feature/x"), project, /covers only branches under standing\/sa-flags\//u);
  mustFail(propose("standing/sa-flags/x", "someone/else"), project, /covers only github\.com\/aantenore\/agentic-sdlc/u);
  mustRunJson(propose("standing/sa-flags/x"), project);
});

test("every copy of the project shares used deliveries and revocations through the git remote", () => {
  const project = initializeProject("shared");
  const { remote, otherCopy } = sharedRemote(project, "shared");
  const standingId = grantStanding(project, { maxDeliveries: 2 });
  const delivery = prepareDelivery(project, "ONE", standingId);
  approveDelivery(project, delivery, standingId);
  const proposal = standingProposal(project, standingId);
  assert.ok(sharedRefs(remote).some((ref) => ref.endsWith("/slots/0001")), "slot 1 is recorded on the remote");
  startTask(project, delivery);

  // Another copy of the project uses the last delivery: this copy cannot use it again.
  const elsewhere = claimSharedStandingSlot({ root: otherCopy }, STANDING_COORDINATION_DEFAULTS, "origin", {
    proposal,
    slot: 2,
    delivery: { id: "LOCAL-ELSEWHERE", kind: "local_release" },
    profileRef: { id: "AUT-ELSEWHERE", hash: "e".repeat(64) },
  });
  assert.equal(elsewhere.published, true, JSON.stringify(elsewhere));
  const duplicate = claimSharedStandingSlot({ root: otherCopy }, STANDING_COORDINATION_DEFAULTS, "origin", {
    proposal,
    slot: 2,
    delivery: { id: "LOCAL-AGAIN", kind: "local_release" },
    profileRef: { id: "AUT-AGAIN", hash: "f".repeat(64) },
  });
  assert.equal(duplicate.conflict, true, "the remote accepts one claim per slot");
  createBrief(project, "TWO", "REQ-TOIL-2");
  mustFail(
    ["contract", "approve", "--root", project, "--id", "CONTRACT-TWO", "--standing-approval", standingId],
    project,
    /all 2 deliveries were used \(counted across everyone using this project\)/u,
  );

  // A revocation made in another copy stops the delivery in progress here at its next step.
  writeProjectFile(project, "src/flag-one.mjs", "export const one = false;\n");
  const revoked = publishSharedStandingRevocation({ root: otherCopy }, STANDING_COORDINATION_DEFAULTS, "origin", {
    proposal,
    revocation: { record_hash: "d".repeat(64), reason: "Stopped from another copy" },
  });
  assert.equal(revoked.published, true, JSON.stringify(revoked));
  expectFallback(project, delivery.profileId, "build.local", /it was revoked \(recorded on the git remote 'origin': Stopped from another copy\)/u);
  const status = mustRunJson(["autonomy", "standing", "status", "--root", project, "--id", standingId], project);
  assert.equal(status.standing_approvals[0].status, "revoked");
  assert.equal(status.standing_approvals[0].shared_state.revoked, true);
  assert.deepEqual(status.standing_approvals[0].shared_state.shared_slots.map((slot) => slot.slot), [1, 2]);
});

test("an unreachable shared remote makes a standing approval cover nothing until it is back", () => {
  const project = initializeProject("offline");
  const { remote } = sharedRemote(project, "offline");
  const standingId = grantStanding(project, { id: "SA-OFFLINE" });
  git(project, ["remote", "set-url", "origin", path.join(remote, "missing")]);
  createBrief(project, "OFF", "REQ-TOIL");
  mustFail(
    ["contract", "approve", "--root", project, "--id", "CONTRACT-OFF", "--standing-approval", standingId],
    project,
    /shared state on the git remote 'origin' cannot be checked/u,
  );
  const status = mustRunJson(["autonomy", "standing", "status", "--root", project, "--id", standingId], project);
  assert.equal(status.standing_approvals[0].shared_state.checked, false);
  assert.doesNotMatch(JSON.stringify(status), new RegExp(remote.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&"), "u"));

  // A revocation made while the remote is unreachable is kept here and shared later.
  const revoked = mustRunJson([
    "autonomy", "standing", "revoke", "--root", project, "--id", standingId,
    "--reason", "Pause delegated work", ...humanApproval("Stop the standing approval"),
  ], project);
  assert.equal(revoked.shared_revocation.status, "failed");
  git(project, ["remote", "set-url", "origin", remote]);
  const synced = mustRunJson(["autonomy", "standing", "sync", "--root", project, "--id", standingId], project);
  assert.deepEqual(synced.actions, ["revocation shared"]);
  assert.equal(synced.shared_state.revoked, true);
  assert.ok(sharedRefs(remote).some((ref) => ref.endsWith("/revoked")));
});

test("a remote that refuses the shared records is reported as not shared, never as shared", () => {
  const project = initializeProject("refused");
  const { remote } = sharedRemote(project, "refused");
  const standingId = grantStanding(project, { id: "SA-REFUSED" });
  const hook = path.join(remote, "hooks", "pre-receive");
  fs.writeFileSync(hook, "#!/bin/sh\nwhile read old new ref; do case \"$ref\" in refs/agentic-sdlc/*) echo refused >&2; exit 1;; esac; done\n", { mode: 0o755 });
  const revoked = mustRunJson([
    "autonomy", "standing", "revoke", "--root", project, "--id", standingId,
    "--reason", "Pause delegated work", ...humanApproval("Stop the standing approval"),
  ], project);
  assert.equal(revoked.shared_revocation.status, "failed", JSON.stringify(revoked.shared_revocation));
  const synced = mustRunJson(["autonomy", "standing", "sync", "--root", project, "--id", standingId], project);
  assert.match(synced.actions.join("\n"), /revocation not shared/u);
  assert.equal(synced.shared_state.revoked, false);
  assert.deepEqual(sharedRefs(remote), []);
});

test("a standing approval covers nothing once its shared remote is renamed, replaced, or loses records", () => {
  const project = initializeProject("moved");
  const { remote, otherCopy } = sharedRemote(project, "moved");
  const standingId = grantStanding(project, { id: "SA-MOVED", maxDeliveries: 3 });
  const delivery = prepareDelivery(project, "ONE", standingId);
  approveDelivery(project, delivery, standingId);
  createBrief(project, "TWO", "REQ-TOIL-2");
  const approveTwo = ["contract", "approve", "--root", project, "--id", "CONTRACT-TWO", "--standing-approval", standingId];

  git(project, ["remote", "rename", "origin", "upstream"]);
  mustFail(approveTwo, project, /the git remote 'origin' is no longer configured/u);
  git(project, ["remote", "rename", "upstream", "origin"]);

  const replacement = temporaryProject("moved-replacement");
  spawnSync("git", ["init", "--bare", "--quiet", replacement], { encoding: "utf8" });
  git(project, ["remote", "set-url", "origin", replacement]);
  mustFail(approveTwo, project, /is not the one this standing approval was approved with/u);
  git(project, ["remote", "set-url", "origin", remote]);

  // Someone deletes the shared records on the remote: what was seen here is not forgotten.
  const slotRef = sharedRefs(remote).find((ref) => ref.endsWith("/slots/0001"));
  git(otherCopy, ["push", "--quiet", "origin", `:${slotRef}`]);
  mustFail(approveTwo, project, /slot 1, recorded before, is gone from the remote/u);
});

test("deliveries used before the remote existed are shared before a new one is claimed", () => {
  const project = initializeProject("late-remote");
  const standingId = grantStanding(project, { id: "SA-LATE", maxDeliveries: 3 });
  const first = prepareDelivery(project, "ONE", standingId);
  approveDelivery(project, first, standingId);
  const { remote } = sharedRemote(project, "late-remote");
  const second = prepareDelivery(project, "TWO", standingId, { requirementId: "REQ-TOIL-2" });
  approveDelivery(project, second, standingId);
  const slots = sharedRefs(remote).filter((ref) => /\/slots\//u.test(ref)).map((ref) => ref.slice(-4)).sort();
  assert.deepEqual(slots, ["0001", "0002"]);
});

test("a separate push address, a cleaned revocation file, or a removed remote never undo a revocation", () => {
  const project = initializeProject("pushurl");
  const { remote, otherCopy } = sharedRemote(project, "pushurl");
  const fork = temporaryProject("pushurl-fork");
  spawnSync("git", ["init", "--bare", "--quiet", fork], { encoding: "utf8" });
  git(project, ["remote", "set-url", "--push", "origin", fork]);
  const standingId = grantStanding(project, { id: "SA-PUSHURL", maxDeliveries: 2 });
  const revoked = mustRunJson([
    "autonomy", "standing", "revoke", "--root", project, "--id", standingId,
    "--reason", "Pause delegated work", ...humanApproval("Stop the standing approval"),
  ], project);
  assert.equal(revoked.shared_revocation.status, "shared");
  assert.ok(sharedRefs(remote).some((ref) => ref.endsWith("/revoked")), "the revocation reaches the fetch address");
  assert.deepEqual(sharedRefs(fork), []);
  void otherCopy;

  // The revocation file is uncommitted: cleaning it away does not bring the standing approval back.
  fs.rmSync(path.join(project, ".sdlc", "autonomy", "standing", standingId, "revocation.json"));
  git(project, ["remote", "remove", "origin"]);
  createBrief(project, "PU", "REQ-TOIL");
  mustFail(
    ["contract", "approve", "--root", project, "--id", "CONTRACT-PU", "--standing-approval", standingId],
    project,
    /revoked on this computer|no longer configured/u,
  );
});

test("sync reports attention when the revocation could not be shared, and git's language does not matter", () => {
  const project = initializeProject("sync-attention");
  const { remote } = sharedRemote(project, "sync-attention");
  const standingId = grantStanding(project, { id: "SA-ATTN" });
  fs.writeFileSync(path.join(remote, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  mustRunJson([
    "autonomy", "standing", "revoke", "--root", project, "--id", standingId,
    "--reason", "Pause delegated work", ...humanApproval("Stop the standing approval"),
  ], project);
  const synced = mustRunJson(["autonomy", "standing", "sync", "--root", project, "--id", standingId], project);
  assert.equal(synced.status, "attention");
  const human = mustRun(["autonomy", "standing", "sync", "--root", project, "--id", standingId], project);
  assert.match(human.stdout, /NOT up to date/u);
  // Without a remote, a non-English git still means "no remote": the state stays local.
  const local = initializeProject("locale");
  const status = spawnSync(process.execPath, [CLI, "autonomy", "standing", "status", "--root", local, "--json"], {
    cwd: local, encoding: "utf8", env: { ...cliEnvironment(), LANG: "it_IT.UTF-8", LC_ALL: "it_IT.UTF-8", LANGUAGE: "it" },
  });
  assert.equal(status.status, 0, status.stderr);
});

test("a project without git still uses its standing approvals on this computer", () => {
  const project = temporaryProject("no-git");
  mustRun(["init", "--root", project, "--project-name", "Standing approvals"], project);
  for (const requirementId of ["REQ-TOIL"]) {
    mustRun([
      "requirement", "propose", "--root", project, "--id", requirementId, "--title", "Routine flag cleanup",
      "--summary", "Remove retired feature flags inside the approved write scope.",
      "--acceptance", "Each cleanup is verified and released locally.", "--autonomy-ceiling", "checkpointed",
      "--write-path", "docs", "--write-path", "src",
    ], project);
    mustRun(["requirement", "approve", "--root", project, "--id", requirementId, ...humanApproval(`Approve ${requirementId}`)], project);
  }
  mustRun(["output", "template", "propose", "--root", project, "--type", "implementation-summary", "--summary", "Canonical implementation-summary format"], project);
  mustRun(["output", "template", "approve", "--root", project, "--id", "implementation-summary-v1", ...humanApproval("Approve implementation-summary output format")], project);
  const standingId = grantStanding(project, { id: "SA-NOGIT", requirements: ["REQ-TOIL"] });
  createBrief(project, "NG", "REQ-TOIL");
  mustRun(["contract", "approve", "--root", project, "--id", "CONTRACT-NG", "--standing-approval", standingId], project);
  const status = mustRunJson(["autonomy", "standing", "status", "--root", project, "--id", standingId], project);
  assert.equal(status.standing_approvals[0].shared_state.scope, "local");
});

test("required sharing refuses a project without the remote, and local_only never contacts it", () => {
  const project = initializeProject("required");
  setCoordination(project, { mode: "required", remote: "shared" });
  const standingId = grantStanding(project, { id: "SA-REQUIRED" });
  createBrief(project, "REQ", "REQ-TOIL");
  mustFail(
    ["contract", "approve", "--root", project, "--id", "CONTRACT-REQ", "--standing-approval", standingId],
    project,
    /the git remote 'shared' is not configured/u,
  );
  const local = initializeProject("local-only");
  git(local, ["remote", "add", "origin", path.join(local, "no-such-remote")]);
  setCoordination(local, { mode: "local_only" });
  const localId = grantStanding(local, { id: "SA-LOCAL" });
  createBrief(local, "LOC", "REQ-TOIL");
  mustRun(["contract", "approve", "--root", local, "--id", "CONTRACT-LOC", "--standing-approval", localId], local);
  const status = mustRunJson(["autonomy", "standing", "status", "--root", local, "--id", localId], local);
  assert.equal(status.standing_approvals[0].shared_state.scope, "local");
});

test("concurrent deliveries cannot both consume the last slot", async () => {
  const project = initializeProject("race");
  const standingId = grantStanding(project, { maxDeliveries: 1 });
  const first = prepareDelivery(project, "ONE", standingId, { requirementId: "REQ-TOIL" });
  // One slot also bounds the briefs it approves, so the second brief is approved directly.
  const second = prepareDelivery(project, "TWO", standingId, { requirementId: "REQ-TOIL-2", directContract: true });
  const results = await Promise.all([first, second].map((delivery) => runAsync([
    "autonomy", "delivery", "approve", "--root", project, "--id", delivery.profileId,
    "--phase", "implementation", "--standing-approval", standingId, "--json",
  ], project)));
  const succeeded = results.filter((result) => result.status === 0);
  const refused = results.filter((result) => result.status !== 0);
  assert.equal(succeeded.length, 1, results.map((result) => result.stderr).join("\n"));
  assert.equal(refused.length, 1);
  assert.match(refused[0].stderr, /it is exhausted|deliveries were used/u);
  const uses = fs.readdirSync(path.join(project, ".sdlc", "autonomy", "standing", standingId, "uses"));
  assert.deepEqual(uses, ["0001.json"]);
});

/** Proposes another profile for an already prepared delivery, optionally with different content. */
function proposeProfileFor(project, delivery, profileId, standingId, extra = []) {
  return run([
    "autonomy", "delivery", "propose",
    "--root", project,
    "--id", profileId,
    "--delivery", `LOCAL-${delivery.storyId.slice(3)}`,
    "--kind", "local_release",
    "--story", delivery.storyId,
    "--contract", delivery.contractId,
    "--requirement", delivery.requirementId,
    "--level", "checkpointed",
    "--target-root", delivery.releaseRoot,
    "--write-path", delivery.releaseOutput,
    "--smoke-test", SMOKE,
    "--rollback", ROLLBACK,
    "--standing-approval", standingId,
    ...extra,
    "--json",
  ], project);
}

function standingUseFiles(project, standingId) {
  return fs.readdirSync(path.join(project, ".sdlc", "autonomy", "standing", standingId, "uses")).sort();
}

test("a second profile for an already used delivery is refused and consumes no slot", () => {
  const project = initializeProject("dup-profile");
  const standingId = grantStanding(project, { maxDeliveries: 2 });
  const first = prepareDelivery(project, "ONE", standingId);
  approveDelivery(project, first, standingId);
  assert.deepEqual(standingUseFiles(project, standingId), ["0001.json"]);
  const evidence = writeProjectFile(project, "docs/revocation-evidence.txt", "revocation approval evidence\n");
  mustRun([
    "autonomy", "delivery", "revoke", "--root", project, "--id", first.profileId,
    "--reason", "Replace the delivery profile", "--approval-evidence", evidence,
    ...humanApproval("Approve revocation of this exact delivery profile"),
  ], project);
  // One slot remains, but the delivery already holds one.
  mustRun([
    "contract", "create", "--root", project, "--id", "CONTRACT-ONE-B", "--story", first.storyId, "--phase", "implementation",
    "--delivery-profile", "AUT-ONE-B", "--level", "checkpointed", "--context-summary", "Second profile for the same delivery.",
    "--replace-story-contract", "--qa", "Who confirms the delivery?|The standing approval", "--tool", "node",
    "--output-ref", "implementation-summary:implementation-summary-v1:new",
  ], project);
  mustRun(["contract", "approve", "--root", project, "--id", "CONTRACT-ONE-B", "--standing-approval", standingId], project);
  const proposed = proposeProfileFor(project, { ...first, contractId: "CONTRACT-ONE-B" }, "AUT-ONE-B", standingId);
  assert.equal(proposed.status, 0, `${proposed.stdout}\n${proposed.stderr}`);
  mustFail([
    "autonomy", "delivery", "approve", "--root", project, "--id", "AUT-ONE-B",
    "--phase", "implementation", "--standing-approval", standingId,
  ], project, /already used the standing approval through profile AUT-ONE/u);
  assert.deepEqual(standingUseFiles(project, standingId), ["0001.json"]);
  const status = mustRunJson(["autonomy", "standing", "status", "--root", project, "--id", standingId], project);
  assert.equal(status.standing_approvals[0].remaining, 1);
});

test("the same profile id with different content cannot reuse the recorded slot", () => {
  const project = initializeProject("changed-profile");
  const standingId = grantStanding(project, { maxDeliveries: 2 });
  const delivery = prepareDelivery(project, "ONE", standingId);
  const profilePath = path.join(project, ".sdlc", "autonomy", "deliveries", `${delivery.profileId}.json`);
  const proposedContent = fs.readFileSync(profilePath, "utf8");
  approveDelivery(project, delivery, standingId);
  // The profile returns to proposed with other content under the same id.
  const changed = buildDeliveryExecutionProfileV2({
    ...JSON.parse(proposedContent),
    extensions: { ...JSON.parse(proposedContent).extensions, note: "changed after the slot was recorded" },
  });
  fs.writeFileSync(profilePath, `${JSON.stringify(changed, null, 2)}\n`);
  assert.notEqual(changed.profile_hash, JSON.parse(proposedContent).profile_hash);
  mustFail([
    "autonomy", "delivery", "approve", "--root", project, "--id", delivery.profileId,
    "--phase", "implementation", "--standing-approval", standingId,
  ], project, /different content/u);
  assert.deepEqual(standingUseFiles(project, standingId), ["0001.json"]);
});

test("an exact retry of the same approval is idempotent and consumes no extra slot", () => {
  const project = initializeProject("retry");
  const standingId = grantStanding(project, { maxDeliveries: 2 });
  const delivery = prepareDelivery(project, "ONE", standingId);
  const profilePath = path.join(project, ".sdlc", "autonomy", "deliveries", `${delivery.profileId}.json`);
  const proposedContent = fs.readFileSync(profilePath, "utf8");
  approveDelivery(project, delivery, standingId);
  const useBefore = fs.readFileSync(path.join(project, ".sdlc", "autonomy", "standing", standingId, "uses", "0001.json"), "utf8");
  // An interrupted approval leaves the slot recorded and the profile still proposed.
  fs.writeFileSync(profilePath, proposedContent);
  const retried = approveDelivery(project, delivery, standingId);
  assert.equal(retried.status, "active");
  assert.deepEqual(standingUseFiles(project, standingId), ["0001.json"]);
  assert.equal(
    fs.readFileSync(path.join(project, ".sdlc", "autonomy", "standing", standingId, "uses", "0001.json"), "utf8"),
    useBefore,
  );
  const status = mustRunJson(["autonomy", "standing", "status", "--root", project, "--id", standingId], project);
  assert.equal(status.standing_approvals[0].remaining, 1);
});

test("a tampered standing approval record covers nothing", () => {
  const project = initializeProject("tamper");
  const standingId = grantStanding(project);
  const proposalPath = path.join(project, ".sdlc", "autonomy", "standing", standingId, "proposal.json");
  const original = fs.readFileSync(proposalPath, "utf8");
  const widened = JSON.parse(original);
  widened.max_deliveries = 20;
  widened.allowed_write_paths = ["docs", "src", "tools"];
  fs.writeFileSync(proposalPath, `${JSON.stringify(widened, null, 2)}\n`);
  const status = mustRunJson(["autonomy", "standing", "status", "--root", project, "--id", standingId], project);
  assert.equal(status.standing_approvals[0].status, "invalid");
  assert.match(status.standing_approvals[0].reasons.join("\n"), /changed after it was proposed/u);
  mustRun([
    "story", "create", "--root", project, "--id", "ST-TAMPER", "--title", "Tamper", "--phase", "implementation",
    "--status", "ready", "--requirement", "REQ-TOIL", "--acceptance", "Observable.",
  ], project);
  mustRun([
    "contract", "create", "--root", project, "--id", "CONTRACT-TAMPER", "--story", "ST-TAMPER", "--phase", "implementation",
    "--delivery-profile", "AUT-TAMPER", "--level", "checkpointed", "--context-summary", "Tamper check.",
    "--qa", "Who confirms?|The standing approval", "--tool", "node",
    "--output-ref", "implementation-summary:implementation-summary-v1:new",
  ], project);
  mustFail(["contract", "approve", "--root", project, "--id", "CONTRACT-TAMPER", "--standing-approval", standingId], project, /it is invalid/u);
  // A record whose hash was recomputed still fails: the approval binds the original content.
  fs.writeFileSync(proposalPath, `${JSON.stringify({ ...widened, record_hash: standingRecordHash(widened) }, null, 2)}\n`);
  mustFail(["contract", "approve", "--root", project, "--id", "CONTRACT-TAMPER", "--standing-approval", standingId], project, /it is invalid/u);
  fs.writeFileSync(proposalPath, original);
  const approved = mustRunJson(["contract", "approve", "--root", project, "--id", "CONTRACT-TAMPER", "--standing-approval", standingId], project);
  assert.equal(approved.approval.approval_source, "standing-approval");
});

/** Edits the configuration the way a person would: change it, then re-pin it. */
function updateConfig(project, change) {
  const configPath = path.join(project, ".sdlc", "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  fs.writeFileSync(configPath, `${JSON.stringify(change(config), null, 2)}\n`, "utf8");
  const preview = mustRunJson(["config", "migrate", "--root", project], project);
  mustRunJson([
    "config", "migrate", "--root", project, "--apply", "--plan-hash", preview.plan.plan_hash, "--actor-type", "human",
  ], project);
}

const TRUSTED_KEY_ID = "trusted-host-e2e";

/** A trusted host signer made for this run: a fresh Ed25519 key pair whose public half the project trusts. */
function trustHostSigner(project, { mode = "host_verified" } = {}) {
  const keys = generateKeyPairSync("ed25519");
  updateConfig(project, (config) => ({
    ...config,
    authority_policy: {
      ...config.authority_policy,
      mode,
      trusted_host_keys: [{
        key_id: TRUSTED_KEY_ID,
        algorithm: "Ed25519",
        public_key: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      }],
    },
  }));
  return { keyId: TRUSTED_KEY_ID, privateKey: keys.privateKey };
}

/** A signer whose key the project does not trust, claiming the trusted key id. */
function impostorSigner() {
  return { keyId: TRUSTED_KEY_ID, privateKey: generateKeyPairSync("ed25519").privateKey };
}

let receiptCounter = 0;

/** Writes the trusted host's receipt for one standing-approval decision; returns its project path. */
function writeStandingReceipt(project, signer, { standingId, decision = "approved", edit = null, overrides = {} }) {
  const proposal = standingProposal(project, standingId);
  const request = standingHostReceiptRequest(proposal, decision);
  const verb = decision === "approved" ? "approve" : "revoke";
  receiptCounter += 1;
  let receipt = buildHostApprovalReceipt({
    id: `HOST-${standingId}-${verb}-${receiptCounter}`,
    action: request.action,
    subject: request.subject,
    subject_ref: {
      kind: "standing_approval",
      id: proposal.id,
      path: `.sdlc/autonomy/standing/${proposal.id}/proposal.json`,
      hash: proposal.record_hash,
    },
    checkpoint: { type: "standing-approval", normal_checkpoint: null },
    question_contract: {
      asked: `Do you ${verb} standing approval ${proposal.id} exactly as shown?`,
      why: "Similar deliveries proceed without asking each time only while it is approved.",
      authorizes: [`Only to ${verb} this exact standing approval.`],
      does_not_authorize: ["Merges, production, deploys, or any wider limit."],
      examples: { en: [`I ${verb} ${proposal.id}.`], it: [`Confermo per ${proposal.id}.`] },
    },
    decision: "approved",
    decided_at: new Date(Date.now() - 2_000).toISOString(),
    decided_by: { id: "standing-e2e-user", type: "human" },
    issued_by: { id: "trusted-host", type: "system" },
    host: {
      provider: "trusted-test-host",
      thread_id: "thread-standing",
      message_id: `message-${receiptCounter}`,
      trust: "host-attested",
    },
    constraints: { subject_hash: request.subject_hash, no_production_access: true },
    signing: { key_id: signer.keyId, private_key: signer.privateKey },
    ...overrides,
  });
  if (edit) receipt = edit(receipt);
  return writeProjectFile(
    project,
    `.sdlc/receipts/host/${standingId}-${verb}-${receiptCounter}.json`,
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
}

function standingDecisionArgs(project, verb, standingId, receiptPath, extra = []) {
  return [
    "autonomy", "standing", verb, "--root", project, "--id", standingId,
    ...extra,
    ...humanApproval(`${verb} ${standingId}`),
    ...(receiptPath ? ["--host-receipt-file", receiptPath] : []),
  ];
}

function standingSummary(project, standingId) {
  return mustRunJson(["autonomy", "standing", "status", "--root", project, "--id", standingId], project).standing_approvals[0];
}

function strictGateErrors(project, storyId) {
  const result = run(["gate", "check", "--root", project, "--strict", "--story", storyId, "--json"], project);
  const report = JSON.parse(result.stdout);
  return (report.errors || []).map((error) => (typeof error === "string" ? error : JSON.stringify(error)));
}

test("signed approvals: only the trusted host's receipt for the exact record approves a standing approval, and its deliveries are covered", async () => {
  const project = initializeProject("signed");
  const signer = trustHostSigner(project);
  const proposed = proposeStanding(project, { id: "SA-SIGNED" });
  assert.equal(proposed.signed_approval_required, true);
  assert.equal(proposed.host_receipt_request.action, "autonomy.standing.approve");
  proposeStanding(project, { id: "SA-OTHER" });
  const approve = (receiptPath) => standingDecisionArgs(project, "approve", "SA-SIGNED", receiptPath);

  mustFail(approve(null), project, /needs a receipt signed by the trusted host; nothing was approved/u);
  mustFail(
    approve(writeStandingReceipt(project, signer, { standingId: "SA-OTHER" })),
    project,
    /does not sign this approval of standing approval SA-SIGNED[\s\S]*not bound to the supplied subject[\s\S]*Nothing was approved/u,
  );
  mustFail(approve(writeStandingReceipt(project, signer, { standingId: "SA-SIGNED", decision: "revoked" })), project, /action does not match/u);
  mustFail(approve(writeStandingReceipt(project, signer, {
    standingId: "SA-SIGNED",
    edit: (receipt) => ({ ...receipt, subject: { ...receipt.subject, expires_at: isoAfter(20 * DAY) } }),
  })), project, /receipt hash is invalid/u);
  mustFail(approve(writeStandingReceipt(project, impostorSigner(), { standingId: "SA-SIGNED" })), project, /not valid for the trusted host key/u);
  mustFail(approve(writeStandingReceipt(project, signer, {
    standingId: "SA-SIGNED",
    overrides: { decided_at: new Date(Date.now() - 60_000).toISOString(), expires_at: new Date(Date.now() - 30_000).toISOString() },
  })), project, /had expired/u);
  mustFail(approve(writeStandingReceipt(project, signer, {
    standingId: "SA-SIGNED",
    overrides: { decided_by: { id: "helper", type: "agent" } },
  })), project, /not decided by a person/u);
  assert.equal(standingSummary(project, "SA-SIGNED").status, "proposed");

  const receiptPath = writeStandingReceipt(project, signer, { standingId: "SA-SIGNED" });
  const receipt = readJson(project, receiptPath);
  const approved = mustRunJson(approve(receiptPath), project);
  assert.equal(approved.assurance, "host_verified");
  assert.equal(approved.approval.host_receipt.receipt_hash, receipt.receipt_hash);
  assert.equal(mustRunJson(approve(receiptPath), project).idempotent, true);
  mustFail(
    approve(writeStandingReceipt(project, signer, { standingId: "SA-SIGNED" })),
    project,
    /already approved with a different signed host receipt/u,
  );
  const summary = standingSummary(project, "SA-SIGNED");
  assert.equal(summary.status, "active");
  assert.equal(summary.assurance, "host_verified");
  assert.deepEqual(summary.host_receipt_ref, { id: receipt.id, hash: receipt.receipt_hash, key_id: TRUSTED_KEY_ID });
  assert.match(
    mustRun(["autonomy", "standing", "explain", "--root", project, "--id", "SA-SIGNED"], project).stdout,
    /signed by the trusted host, and the CLI verifies that signature at every step/u,
  );
  assert.match(
    mustRun(["autonomy", "standing", "explain", "--root", project, "--id", "SA-SIGNED", "--locale", "it"], project).stdout,
    /firmata dall’host fidato/u,
  );
  assert.match(mustRun(["status", "--root", project], project).stdout, /approval signed by the trusted host/u);

  // Every step of a matching delivery is covered, and each derived approval names the receipt.
  const delivery = prepareDelivery(project, "ONE", "SA-SIGNED");
  const contractPath = `.sdlc/contracts/${delivery.contractId}.json`;
  const contractApproval = readJson(project, contractPath).approvals.at(-1);
  assert.deepEqual(contractApproval.standing_approval_ref.host_receipt_ref, summary.host_receipt_ref);
  const approvedDelivery = approveDelivery(project, delivery, "SA-SIGNED");
  assert.deepEqual(approvedDelivery.approval.approval.standing_approval_ref.host_receipt_ref, summary.host_receipt_ref);
  startTask(project, delivery);
  writeProjectFile(project, "src/flag-one.mjs", "export const one = false;\n");
  const build = mustAuthorize(project, delivery.profileId, "build.local");
  assert.equal(build.action_receipt.approval.approval_source, "standing-approval");
  assert.deepEqual(build.action_receipt.approval.standing_approval_ref.host_receipt_ref, summary.host_receipt_ref);

  const model = await buildObservatoryViewModel(project);
  const standingItem = model.decisions.find((item) => item.type === "standing-approval" && /SA-SIGNED/u.test(JSON.stringify(item)));
  assert.ok(standingItem, "the observatory lists the signed standing approval");
  assert.match(standingItem.summary, /The approval is signed by the trusted host\./u);

  // The strict gate re-verifies the receipt behind each derived approval.
  const standingErrors = (errors) => errors.filter((error) => /standing approval/iu.test(error));
  assert.deepEqual(standingErrors(strictGateErrors(project, delivery.storyId)), []);
  const original = fs.readFileSync(path.join(project, contractPath), "utf8");
  const forge = (change) => {
    const contract = JSON.parse(original);
    change(contract.approvals.at(-1));
    fs.writeFileSync(path.join(project, contractPath), `${JSON.stringify(contract, null, 2)}\n`);
  };
  forge((approval) => { approval.standing_approval_ref.host_receipt_ref.hash = "0".repeat(64); });
  assert.match(standingErrors(strictGateErrors(project, delivery.storyId)).join("\n"), /derived from a standing approval is invalid: it does not reference the exact host receipt/u);
  forge((approval) => { delete approval.standing_approval_ref.host_receipt_ref; });
  assert.match(standingErrors(strictGateErrors(project, delivery.storyId)).join("\n"), /does not reference the exact host receipt/u);

  // A standing approval "approved" by writing its record directly, as a script
  // could, has no trusted signature: nothing relies on it and the gate rejects
  // a derived approval that names it.
  const forgedProposal = standingProposal(project, "SA-OTHER");
  const forgedApproval = buildStandingApprovalDecision({
    id: "SA-OTHER-APPROVAL",
    decision: "approved",
    proposal: forgedProposal,
    approval: {
      status: "approved",
      approval_source: "explicit-user",
      approved_content_hash: hashApprovalSubject(forgedProposal),
      approved_by: { id: "someone", type: "human" },
      created_at: new Date().toISOString(),
    },
    createdAt: new Date().toISOString(),
    actor: { id: "someone", type: "human" },
  });
  writeProjectFile(project, ".sdlc/autonomy/standing/SA-OTHER/approval.json", `${JSON.stringify(forgedApproval, null, 2)}\n`);
  const forged = standingSummary(project, "SA-OTHER");
  assert.equal(forged.status, "invalid");
  assert.match(forged.reasons.join("\n"), /no trusted signed host receipt, which this project requires/u);
  forge((approval) => {
    approval.standing_approval_ref = {
      id: "SA-OTHER",
      record_hash: forgedProposal.record_hash,
      approval_hash: forgedApproval.record_hash,
      use_ref: null,
    };
  });
  assert.match(standingErrors(strictGateErrors(project, delivery.storyId)).join("\n"), /its standing approval SA-OTHER is invalid: [^\n]*no trusted signed host receipt/u);
  createBrief(project, "TWO", "REQ-TOIL-2");
  mustFail(
    ["contract", "approve", "--root", project, "--id", "CONTRACT-TWO", "--standing-approval", "SA-OTHER"],
    project,
    /it is invalid[\s\S]*no trusted signed host receipt/u,
  );
  fs.writeFileSync(path.join(project, contractPath), original);
  assert.deepEqual(standingErrors(strictGateErrors(project, delivery.storyId)), []);
});

test("signed approvals: revocation works with a verified receipt or a person's explicit revocation", () => {
  const project = initializeProject("signed-revoke");
  const signer = trustHostSigner(project);
  for (const id of ["SA-REV-SIGNED", "SA-REV-PLAIN"]) {
    proposeStanding(project, { id });
    mustRunJson(standingDecisionArgs(project, "approve", id, writeStandingReceipt(project, signer, { standingId: id })), project);
  }
  const revoke = (id, receiptPath) => standingDecisionArgs(project, "revoke", id, receiptPath, ["--reason", "Stop delegated cleanups"]);
  // A receipt that does not sign this revocation is refused, and nothing changes.
  mustFail(revoke("SA-REV-SIGNED", writeStandingReceipt(project, signer, { standingId: "SA-REV-SIGNED" })), project, /does not sign this revocation[\s\S]*Nothing was revoked/u);
  mustFail(revoke("SA-REV-SIGNED", writeStandingReceipt(project, signer, { standingId: "SA-REV-PLAIN", decision: "revoked" })), project, /not bound to the supplied subject/u);
  assert.equal(standingSummary(project, "SA-REV-SIGNED").status, "active");
  const signedRevocation = mustRunJson(
    revoke("SA-REV-SIGNED", writeStandingReceipt(project, signer, { standingId: "SA-REV-SIGNED", decision: "revoked" })),
    project,
  );
  assert.equal(signedRevocation.assurance, "host_verified");
  const signedSummary = standingSummary(project, "SA-REV-SIGNED");
  assert.equal(signedSummary.status, "revoked");
  assert.equal(signedSummary.revocation_assurance, "host_verified");
  // Revoking only removes authority, so a person's explicit revocation needs no receipt.
  const plain = mustRunJson(revoke("SA-REV-PLAIN"), project);
  assert.equal(plain.assurance, "audit_only");
  const plainSummary = standingSummary(project, "SA-REV-PLAIN");
  assert.equal(plainSummary.status, "revoked");
  assert.equal(plainSummary.revocation_assurance, "audit_only");
  assert.equal(plainSummary.assurance, "host_verified");
});

test("audit-only projects may record a verified host receipt, and nothing else changes", () => {
  const project = initializeProject("audit-signed");
  const signer = trustHostSigner(project, { mode: "audit_only" });
  const proposed = proposeStanding(project, { id: "SA-AUDIT-SIGNED" });
  assert.equal(proposed.signed_approval_required, false);
  proposeStanding(project, { id: "SA-AUDIT-PLAIN" });
  // A supplied receipt is verified: a wrong one refuses the approval instead of being ignored.
  mustFail(
    standingDecisionArgs(project, "approve", "SA-AUDIT-SIGNED", writeStandingReceipt(project, impostorSigner(), { standingId: "SA-AUDIT-SIGNED" })),
    project,
    /not valid for the trusted host key/u,
  );
  const signed = mustRunJson(
    standingDecisionArgs(project, "approve", "SA-AUDIT-SIGNED", writeStandingReceipt(project, signer, { standingId: "SA-AUDIT-SIGNED" })),
    project,
  );
  assert.equal(signed.assurance, "host_verified");
  const plain = mustRunJson(standingDecisionArgs(project, "approve", "SA-AUDIT-PLAIN", null), project);
  assert.equal(plain.assurance, "audit_only");
  assert.equal(plain.approval.host_receipt, undefined);
  assert.equal(plain.approval.assurance, undefined);
  const summaries = mustRunJson(["autonomy", "standing", "status", "--root", project], project).standing_approvals;
  assert.deepEqual(
    summaries.map((item) => [item.id, item.status, item.assurance]),
    [["SA-AUDIT-PLAIN", "active", "audit_only"], ["SA-AUDIT-SIGNED", "active", "host_verified"]],
  );
  // Both cover a matching brief; only the signed one passes its receipt on.
  const signedBrief = prepareBriefApproval(project, "SIG", "REQ-TOIL", "SA-AUDIT-SIGNED");
  assert.equal(signedBrief.standing_approval_ref.host_receipt_ref.id, summaries[1].host_receipt_ref.id);
  const plainBrief = prepareBriefApproval(project, "PLN", "REQ-TOIL-2", "SA-AUDIT-PLAIN");
  assert.equal(plainBrief.standing_approval_ref.host_receipt_ref, undefined);
});

function prepareBriefApproval(project, suffix, requirementId, standingId) {
  createBrief(project, suffix, requirementId);
  return mustRunJson(["contract", "approve", "--root", project, "--id", `CONTRACT-${suffix}`, "--standing-approval", standingId], project).approval;
}
