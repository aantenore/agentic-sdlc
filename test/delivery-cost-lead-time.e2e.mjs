import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { AGENT_HOSTS, AGENT_HOST_OVERRIDE_ENV } from "../lib/agent-host.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPOSITORY_ROOT, "bin", "agentic-sdlc.mjs");
const TEMPORARY_PROJECTS = new Set();
// Every host marker is removed, so the CLI never treats the test as running inside an agent session.
const ISOLATED_ENVIRONMENT_KEYS = [
  "CI",
  "GITHUB_ACTIONS",
  "GITHUB_ACTOR",
  AGENT_HOST_OVERRIDE_ENV,
  ...AGENT_HOSTS.flatMap((host) => [...host.markers, ...Object.values(host.env).filter(Boolean)]),
];
const SMOKE = '["node","--version"]';
const ROLLBACK = "Restore the previous governed local release snapshot.";
const REQUIREMENTS = ["REQ-TOIL", "REQ-TOIL-2"];

after(() => {
  if (process.env.AGENTIC_SDLC_KEEP_TEST_TMP === "1") return;
  for (const project of TEMPORARY_PROJECTS) {
    fs.rmSync(project, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
  TEMPORARY_PROJECTS.clear();
});

function temporaryProject(label) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), `agentic-sdlc-delivery-metrics-${label}-`));
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

/** A project with approved routine requirements and an output format, before any delivery. */
function initializeProject(label) {
  const project = temporaryProject(label);
  mustRun(["init", "--root", project, "--project-name", "Delivery metrics"], project);
  git(project, ["init"]);
  git(project, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  git(project, ["config", "user.name", "Delivery Metrics E2E"]);
  git(project, ["config", "user.email", "delivery-metrics-e2e@example.invalid"]);
  writeProjectFile(project, "src/index.mjs", "export const ready = true;\n");
  writeProjectFile(project, ".gitignore", "docs/local-release-*/\n");
  git(project, ["add", "-A"]);
  git(project, ["commit", "-m", "test: establish base"]);
  for (const requirementId of REQUIREMENTS) {
    mustRun([
      "requirement", "propose", "--root", project, "--id", requirementId,
      "--title", `Routine flag cleanup ${requirementId}`,
      "--summary", "Remove retired feature flags inside the approved write scope.",
      "--acceptance", "Each cleanup is verified and released locally.",
      "--autonomy-ceiling", "checkpointed", "--write-path", "docs", "--write-path", "src",
    ], project);
    mustRun(["requirement", "approve", "--root", project, "--id", requirementId, ...humanApproval(`Approve ${requirementId}`)], project);
  }
  mustRun([
    "output", "template", "propose", "--root", project,
    "--type", "implementation-summary", "--summary", "Canonical implementation-summary format",
  ], project);
  mustRun([
    "output", "template", "approve", "--root", project, "--id", "implementation-summary-v1",
    ...humanApproval("Approve implementation-summary output format"),
  ], project);
  return project;
}

function createBrief(project, suffix, requirementId) {
  mustRun([
    "story", "create", "--root", project, "--id", `ST-${suffix}`, "--title", `Clean up flag ${suffix}`,
    "--phase", "implementation", "--status", "ready", "--requirement", requirementId,
    "--acceptance", `Flag ${suffix} is removed and verified.`,
  ], project);
  mustRun([
    "contract", "create", "--root", project, "--id", `CONTRACT-${suffix}`, "--story", `ST-${suffix}`,
    "--phase", "implementation", "--delivery-profile", `AUT-${suffix}`, "--level", "checkpointed",
    "--context-summary", `Remove flag ${suffix} inside the approved boundary.`,
    "--qa", "Who confirms the delivery?|The person or the standing approval", "--tool", "node",
    "--output-ref", "implementation-summary:implementation-summary-v1:new",
  ], project);
}

/** A local-release delivery; under a standing approval when standingId is given, else approved by a person. */
function prepareDelivery(project, suffix, { requirementId = "REQ-TOIL", standingId = null } = {}) {
  createBrief(project, suffix, requirementId);
  mustRun([
    "contract", "approve", "--root", project, "--id", `CONTRACT-${suffix}`,
    ...(standingId ? ["--standing-approval", standingId] : humanApproval(`Approve CONTRACT-${suffix}`)),
  ], project);
  const releaseRoot = path.join(project, "docs", `local-release-${suffix.toLowerCase()}`);
  mustRunJson([
    "autonomy", "delivery", "propose", "--root", project, "--id", `AUT-${suffix}`, "--delivery", `LOCAL-${suffix}`,
    "--kind", "local_release", "--story", `ST-${suffix}`, "--contract", `CONTRACT-${suffix}`,
    "--requirement", requirementId, "--level", "checkpointed", "--target-root", releaseRoot,
    "--write-path", path.join(releaseRoot, "app"), "--smoke-test", SMOKE, "--rollback", ROLLBACK,
    ...(standingId ? ["--standing-approval", standingId] : []),
  ], project);
  return { profileId: `AUT-${suffix}`, storyId: `ST-${suffix}`, contractId: `CONTRACT-${suffix}` };
}

function approveDelivery(project, delivery, standingId = null) {
  return mustRunJson([
    "autonomy", "delivery", "approve", "--root", project, "--id", delivery.profileId, "--phase", "implementation",
    ...(standingId ? ["--standing-approval", standingId] : humanApproval(`Approve ${delivery.profileId}`)),
  ], project);
}

function startTask(project, delivery) {
  const taskStart = mustRunJson([
    "task", "start", "--root", project, "--intent-json", implementationIntent(delivery.storyId),
    "--story", delivery.storyId, "--phase", "implementation", "--contract-id", delivery.contractId,
    "--delivery-profile", delivery.profileId,
  ], project);
  assert.equal(taskStart.execution_allowed, true, JSON.stringify(taskStart, null, 2));
}

test("a delivery records usage, shows its lead time and cost, and keeps its history append-only", () => {
  const project = initializeProject("direct");
  const delivery = prepareDelivery(project, "ONE");
  mustFail(
    ["budget", "usage", "record", "--root", project, "--delivery", delivery.profileId, "--input-tokens", "10"],
    project,
    /only after it is approved; it is proposed/u,
  );
  approveDelivery(project, delivery);
  mustFail(
    ["budget", "usage", "record", "--root", project, "--proposal", "ASSESS-1", "--delivery", delivery.profileId, "--steps", "1"],
    project,
    /either --proposal for an assessment or --delivery for a delivery, not both/u,
  );
  const tokens = mustRunJson([
    "budget", "usage", "record", "--root", project, "--delivery", delivery.profileId,
    "--id", "USAGE-ONE-TOKENS", "--input-tokens", "1200", "--output-tokens", "300",
  ], project);
  assert.equal(tokens.registration_status, "created");
  assert.equal(tokens.usage.tokens, 1500);
  assert.equal(tokens.usage.cost_status, "not_measured");
  mustFail(
    ["budget", "usage", "record", "--root", project, "--delivery", delivery.profileId, "--cost-amount", "0.5"],
    project,
    /needs a currency the first time one is recorded for delivery AUT-ONE/u,
  );
  const cost = mustRunJson([
    "budget", "usage", "record", "--root", project, "--delivery", delivery.profileId,
    "--id", "USAGE-ONE-COST", "--cost-amount", "0.10", "--currency", "usd",
  ], project);
  assert.deepEqual(cost.usage.cost, { amount: "0.1", currency: "USD" });
  const more = mustRunJson([
    "budget", "usage", "record", "--root", project, "--delivery", delivery.profileId,
    "--id", "USAGE-ONE-COST-2", "--cost-amount", "0.20",
  ], project);
  // Exact decimal arithmetic: 0.1 + 0.2 is exactly 0.3.
  assert.deepEqual(more.usage.cost, { amount: "0.3", currency: "USD" });
  assert.equal(more.usage.cost_status, "declared");
  mustFail(
    ["budget", "usage", "record", "--root", project, "--delivery", delivery.profileId, "--cost-amount", "1", "--currency", "EUR"],
    project,
    /--currency EUR does not match USD[\s\S]*never converted/u,
  );
  // An identical replay changes nothing; the same id with other content is refused.
  const replay = mustRunJson([
    "budget", "usage", "record", "--root", project, "--delivery", delivery.profileId,
    "--receipt-file", ".sdlc/autonomy/metering/AUT-ONE/usage/USAGE-ONE-COST.json",
  ], project);
  assert.equal(replay.registration_status, "idempotent_replay");

  const status = mustRunJson(["budget", "status", "--root", project, "--delivery", delivery.profileId], project);
  assert.equal(status.receipts.length, 3);
  assert.equal(status.ledger_status, "verified");
  assert.equal(status.usage.cost.amount, "0.3");
  assert.equal(status.lead_time.status, "approved");
  assert.ok(status.lead_time.milestones.proposed && status.lead_time.milestones.approved);
  assert.equal(status.lead_time.waiting_for_person.intervals[0].kind, "delivery_approval");
  assert.equal(status.next_receipt_plan.currency, "USD");

  startTask(project, delivery);
  const started = mustRunJson(["budget", "status", "--root", project, "--delivery", delivery.profileId], project);
  assert.equal(started.lead_time.status, "in_progress");
  assert.equal(started.lead_time.stages.map((stage) => `${stage.from}>${stage.to}`).join(","), "proposed>approved,approved>task_started");

  // Deleting a recorded receipt is detected: the history no longer matches its ledger.
  const receiptPath = path.join(project, ".sdlc", "autonomy", "metering", "AUT-ONE", "usage", "USAGE-ONE-COST.json");
  const saved = fs.readFileSync(receiptPath);
  fs.rmSync(receiptPath);
  mustFail(["budget", "status", "--root", project, "--delivery", delivery.profileId], project, /does not match its ledger[\s\S]*Missing: USAGE-ONE-COST/u);
  fs.writeFileSync(receiptPath, saved);
  assert.equal(mustRunJson(["budget", "status", "--root", project, "--delivery", delivery.profileId], project).receipts.length, 3);
});
