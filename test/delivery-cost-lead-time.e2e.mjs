import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { AGENT_HOSTS, AGENT_HOST_OVERRIDE_ENV } from "../lib/agent-host.mjs";
import { buildObservatoryViewModel } from "../lib/change-observatory/index.mjs";
import { buildExecutionUsageReceipt } from "../lib/execution-budget.mjs";
import { buildMeteringAttestation } from "../lib/metering-attestations.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPOSITORY_ROOT, "bin", "agentic-sdlc.mjs");
const CODEBURN_FIXTURE = path.join(REPOSITORY_ROOT, "test", "fixtures", "codeburn", "report-v0.9.15.json");
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
const DAY = 24 * 60 * 60 * 1000;

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

function isoAfter(milliseconds) {
  return new Date(Date.now() + milliseconds).toISOString();
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
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
  writeProjectFile(project, ".gitignore", "docs/local-release-*/\nfake-codeburn/\n");
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

/** Re-pins an edited configuration the way a person would. */
function migrateConfig(project, edit) {
  const configPath = path.join(project, ".sdlc", "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  edit(config);
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  const preview = mustRunJson(["config", "migrate", "--root", project], project);
  mustRunJson([
    "config", "migrate", "--root", project, "--apply", "--plan-hash", preview.plan.plan_hash, "--actor-type", "human",
  ], project);
}

/**
 * A stand-in CodeBurn 0.9 executable whose report the test controls: each
 * reading is a new report generated now, with a cumulative cost in USD.
 */
function configureFakeCodeBurn(project) {
  const toolRoot = path.join(project, "fake-codeburn");
  fs.mkdirSync(toolRoot, { recursive: true });
  const reportPath = path.join(toolRoot, "report.json");
  const runnerPath = path.join(toolRoot, "runner.mjs");
  fs.writeFileSync(runnerPath, [
    "import fs from 'node:fs';",
    `const reportPath = ${JSON.stringify(reportPath)};`,
    "const arg = (name) => process.argv[process.argv.indexOf(name) + 1];",
    "if (process.argv.includes('--version')) process.stdout.write('codeburn 0.9.15\\n');",
    "else {",
    "  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));",
    "  report.period = `${arg('--from')} to ${arg('--to')}`;",
    "  process.stdout.write(JSON.stringify(report));",
    "}",
  ].join("\n"));
  const fixture = JSON.parse(fs.readFileSync(CODEBURN_FIXTURE, "utf8"));
  let calls = fixture.overview.calls;
  const setReading = (cost) => {
    calls += 1;
    const report = structuredClone(fixture);
    report.generated = new Date().toISOString();
    report.overview.cost = cost;
    report.overview.netCost = cost;
    report.overview.calls = calls;
    report.overview.tokens.input += calls * 10;
    report.overview.tokens.output += calls * 5;
    report.projects[0].cost = cost;
    report.projects[0].calls = calls;
    report.models[0].cost = cost;
    report.models[0].calls = calls;
    report.models[0].inputTokens = report.overview.tokens.input;
    report.models[0].outputTokens = report.overview.tokens.output;
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    // Readings must be strictly later than the step before them.
    sleep(20);
  };
  setReading(1);
  migrateConfig(project, (config) => {
    config.budget_policy.metering_adapters.codeburn.enabled = true;
    config.budget_policy.metering_adapters.codeburn.command = { executable: process.execPath, arguments: [runnerPath] };
  });
  return { setReading };
}

function standingArgs(project, extra = []) {
  return [
    "autonomy", "standing", "propose", "--root", project, "--id", "SA-COST",
    "--recipe", "flag-cleanup", "--description", "Remove one retired feature flag and release it locally",
    ...REQUIREMENTS.flatMap((item) => ["--requirement", item]),
    "--write-path", "src", "--write-path", "docs", "--max-changed-files", "10", "--max-changed-lines", "200",
    "--destination", "local_release", "--max-deliveries", "2", "--expires-at", isoAfter(7 * DAY),
    ...extra,
  ];
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

function proposeArgs(project, suffix, { requirementId = "REQ-TOIL", standingId = null } = {}) {
  const releaseRoot = path.join(project, "docs", `local-release-${suffix.toLowerCase()}`);
  return [
    "autonomy", "delivery", "propose", "--root", project, "--id", `AUT-${suffix}`, "--delivery", `LOCAL-${suffix}`,
    "--kind", "local_release", "--story", `ST-${suffix}`, "--contract", `CONTRACT-${suffix}`,
    "--requirement", requirementId, "--level", "checkpointed", "--target-root", releaseRoot,
    "--write-path", path.join(releaseRoot, "app"), "--smoke-test", SMOKE, "--rollback", ROLLBACK,
    ...(standingId ? ["--standing-approval", standingId] : []),
  ];
}

function approveBrief(project, suffix, { requirementId = "REQ-TOIL", standingId = null } = {}) {
  createBrief(project, suffix, requirementId);
  mustRun([
    "contract", "approve", "--root", project, "--id", `CONTRACT-${suffix}`,
    ...(standingId ? ["--standing-approval", standingId] : humanApproval(`Approve CONTRACT-${suffix}`)),
  ], project);
  return { profileId: `AUT-${suffix}`, storyId: `ST-${suffix}`, contractId: `CONTRACT-${suffix}` };
}

/** A local-release delivery; under a standing approval when standingId is given, else approved by a person. */
function prepareDelivery(project, suffix, options = {}) {
  const delivery = approveBrief(project, suffix, options);
  mustRunJson(proposeArgs(project, suffix, options), project);
  return delivery;
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

function deliveryAction(project, profileId, action, extra = []) {
  const result = run(["autonomy", "delivery", "action", "--root", project, "--id", profileId, "--action", action, ...extra, "--json"], project);
  assert.equal(result.status, 0, `${action}\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

function expectFallback(project, profileId, action, pattern) {
  const payload = deliveryAction(project, profileId, action);
  assert.equal(payload.status, "checkpoint_required", JSON.stringify(payload));
  assert.equal(payload.standing_approval?.covered, false, JSON.stringify(payload));
  assert.match(payload.standing_approval.reasons.join("\n"), pattern);
  return payload;
}

function meterStart(project, profileId, extra = []) {
  return mustRunJson(["budget", "meter", "start", "--root", project, "--delivery", profileId, "--adapter", "codeburn", ...extra], project);
}

function meterRecord(project, profileId) {
  return mustRunJson(["budget", "meter", "record", "--root", project, "--delivery", profileId, "--adapter", "codeburn"], project);
}

test("a delivery records usage, shows its lead time and cost, and keeps its history append-only", async () => {
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
  const deliveryStatus = mustRunJson(["autonomy", "delivery", "status", "--root", project, "--id", delivery.profileId], project);
  const profile = deliveryStatus.delivery_profiles[0];
  assert.equal(profile.lead_time.status, "in_progress");
  assert.equal(profile.lead_time.stages.map((stage) => `${stage.from}>${stage.to}`).join(","), "proposed>approved,approved>task_started");
  assert.equal(profile.usage.cost.amount, "0.3");
  assert.equal(profile.metric_lines, undefined, "human lines stay out of JSON");
  const english = mustRun(["autonomy", "delivery", "status", "--root", project, "--id", delivery.profileId], project).stdout;
  assert.match(english, /Lead time: proposed → approved [^;]+; approved → work started [^;]+; still in progress\./u);
  assert.match(english, /Waiting for a person: \S+ over 1 confirmation\./u);
  assert.match(english, /Cost: USD 0\.30 \(declared by hand, not measured by a meter\); 1500 tokens; 3 receipts\./u);
  const italian = mustRun(["autonomy", "delivery", "status", "--root", project, "--id", delivery.profileId, "--locale", "it"], project).stdout;
  assert.match(italian, /Tempo di consegna: proposta → approvata [^;]+; approvata → lavoro avviato [^;]+; ancora in corso\./u);
  assert.match(italian, /Costo: USD 0\.30 \(dichiarato a mano, non misurato da un contatore\); token 1500; 3 ricevute\./u);

  const projectStatus = mustRunJson(["status", "--root", project], project);
  assert.equal(projectStatus.delivery_metrics.deliveries, 1);
  assert.equal(projectStatus.delivery_metrics.in_progress, 1);
  assert.deepEqual(projectStatus.delivery_metrics.cost_by_currency, { USD: "0.3" });
  assert.equal(projectStatus.delivery_metrics.items, undefined, "per-delivery items only with --full");
  assert.match(mustRun(["status", "--root", project], project).stdout, /Deliveries: 1 \(0 finished, 1 in progress\); none finished yet; waiting for a person \S+ in total; cost USD 0\.30 over 1 delivery/u);
  assert.match(mustRun(["status", "--root", project, "--locale", "it"], project).stdout, /Consegne: 1 \(0 concluse, 1 in corso\)/u);

  const model = await buildObservatoryViewModel(project);
  const item = model.decisions.find((entry) => entry.type === "delivery-execution-profile" && entry.id === delivery.profileId);
  assert.ok(item?.deliveryMetrics, "the observatory shows the delivery's metrics");
  assert.equal(item.deliveryMetrics.cost.amount, "0.3");
  assert.equal(item.deliveryMetrics.cost.status, "declared");
  assert.equal(item.deliveryMetrics.leadTime.status, "in_progress");

  // Deleting the ledger itself is detected too: several receipts cannot exist without one.
  const ledgerPath = path.join(project, ".sdlc", "autonomy", "metering", "AUT-ONE", "ledger.json");
  const savedLedger = fs.readFileSync(ledgerPath);
  fs.rmSync(ledgerPath);
  mustFail(["budget", "status", "--root", project, "--delivery", delivery.profileId], project, /usage ledger of delivery AUT-ONE is missing although 3 receipts are recorded/u);
  fs.writeFileSync(ledgerPath, savedLedger);

  // Deleting a recorded receipt is detected: the history no longer matches its ledger.
  const receiptPath = path.join(project, ".sdlc", "autonomy", "metering", "AUT-ONE", "usage", "USAGE-ONE-COST.json");
  const saved = fs.readFileSync(receiptPath);
  fs.rmSync(receiptPath);
  mustFail(["budget", "status", "--root", project, "--delivery", delivery.profileId], project, /does not match its ledger[\s\S]*Missing: USAGE-ONE-COST/u);
  const broken = mustRunJson(["autonomy", "delivery", "status", "--root", project, "--id", delivery.profileId], project);
  assert.match(broken.delivery_profiles[0].usage_error, /does not match its ledger/u);
  fs.writeFileSync(receiptPath, saved);
  assert.equal(mustRunJson(["budget", "status", "--root", project, "--delivery", delivery.profileId], project).receipts.length, 3);
});

test("a standing approval budget is refused until delivery cost can be measured", () => {
  const project = initializeProject("refused");
  mustFail(
    standingArgs(project, ["--budget-per-delivery", "1.50", "--budget-total", "2", "--currency", "USD"]),
    project,
    /only when this project has a meter that reports delivery cost, and none is configured[\s\S]*metering_adapters\.codeburn\.enabled[\s\S]*Nothing was recorded/u,
  );
  mustFail(standingArgs(project, ["--currency", "USD"]), project, /--currency names the currency of a cost budget/u);
  assert.equal(fs.existsSync(path.join(project, ".sdlc", "autonomy", "standing", "SA-COST")), false);
  configureFakeCodeBurn(project);
  const proposed = mustRunJson(standingArgs(project, ["--budget-per-delivery", "1.50", "--budget-total", "2", "--currency", "USD"]), project);
  // Amounts are kept as exact decimal strings.
  assert.deepEqual(proposed.standing_approval.budget, { currency: "USD", per_delivery_amount: "1.5", total_amount: "2" });
  assert.match(proposed.plain_language, /The cost measured by a meter stays within USD 1\.50 per delivery and USD 2\.00 in total/u);
});

test("a standing approval budget covers a step only with a fresh metered cost inside the budget", () => {
  const project = initializeProject("budget");
  const meter = configureFakeCodeBurn(project);
  mustRunJson(standingArgs(project, ["--budget-per-delivery", "1.50", "--budget-total", "2", "--currency", "USD"]), project);
  mustRunJson(["autonomy", "standing", "approve", "--root", project, "--id", "SA-COST", ...humanApproval("Approve SA-COST")], project);

  const one = prepareDelivery(project, "ONE", { standingId: "SA-COST" });
  approveDelivery(project, one, "SA-COST");
  // The meter starts before the work, and its window is the delivery's own.
  const started = meterStart(project, one.profileId);
  assert.equal(started.status, "created");
  assert.ok(started.measured_metrics.includes("cost"));
  assert.equal(started.baseline.snapshot.scope.from, new Date().toISOString().slice(0, 10));
  startTask(project, one);
  writeProjectFile(project, "src/flag-one.mjs", "export const one = false;\n");
  expectFallback(project, one.profileId, "build.local", /no meter has reported this delivery's cost yet; record it with budget meter record --delivery AUT-ONE/u);
  meter.setReading(2);
  const recorded = meterRecord(project, one.profileId);
  assert.deepEqual(recorded.usage.cost, { amount: "1", currency: "USD" });
  assert.equal(recorded.usage.cost_status, "metered");
  const covered = deliveryAction(project, one.profileId, "build.local");
  assert.equal(covered.status, "authorized", JSON.stringify(covered));
  assert.equal(covered.action_receipt.approval.approval_source, "standing-approval");

  // Only the meter itself records an adapter observation: an imported one is refused.
  const plan = mustRunJson(["budget", "status", "--root", project, "--delivery", one.profileId], project).next_receipt_plan.plan;
  const forged = buildExecutionUsageReceipt({
    id: "USAGE-FORGED",
    execution_id: one.profileId,
    budget: plan,
    usage: { cost: "0.01" },
    metering: { cost: "estimated" },
    ended_at: new Date().toISOString(),
    source: { adapter: "codeburn", assurance: "advisory_observed", aggregation: "delta", attestation_ref: null },
  });
  mustFail(
    ["budget", "usage", "record", "--root", project, "--delivery", one.profileId, "--receipt-json", JSON.stringify(forged)],
    project,
    /claims a meter observation, which only budget meter record --delivery AUT-ONE records/u,
  );
  // An edited meter reading makes the delivery's cost untrusted until it is restored.
  const deltaRoot = path.join(project, ".sdlc", "autonomy", "metering", "AUT-ONE", "meters", "codeburn", "deltas");
  const deltaFile = path.join(deltaRoot, fs.readdirSync(deltaRoot)[0]);
  const originalDelta = fs.readFileSync(deltaFile, "utf8");
  const editedDelta = JSON.parse(originalDelta);
  editedDelta.usage.cost.amount = "0.01";
  fs.writeFileSync(deltaFile, JSON.stringify(editedDelta));
  mustFail(["budget", "status", "--root", project, "--delivery", one.profileId], project, /USAGE-AUT-ONE-codeburn-[a-f0-9]+ of delivery AUT-ONE cannot be trusted: its snapshot or delta failed integrity validation/u);
  fs.writeFileSync(deltaFile, originalDelta);

  // Another delivery's cost counts toward the total only with a reading newer
  // than its own last step: AUT-ONE's step came after its reading.
  const two = approveBrief(project, "TWO", { requirementId: "REQ-TOIL-2", standingId: "SA-COST" });
  mustFail(
    proposeArgs(project, "TWO", { requirementId: "REQ-TOIL-2", standingId: "SA-COST" }),
    project,
    /delivery AUT-ONE used this standing approval, but its cost is not freshly measured: the latest meter reading \([^)]+\) is older than the delivery's last recorded step/u,
  );
  meter.setReading(2);
  assert.deepEqual(meterRecord(project, one.profileId).usage.cost, { amount: "1", currency: "USD" });
  mustRunJson(proposeArgs(project, "TWO", { requirementId: "REQ-TOIL-2", standingId: "SA-COST" }), project);

  // The second delivery: its own reading is older than its start, then the total is above budget.
  approveDelivery(project, two, "SA-COST");
  meterStart(project, two.profileId);
  meter.setReading(2.1);
  meterRecord(project, two.profileId);
  startTask(project, two);
  writeProjectFile(project, "src/flag-two.mjs", "export const two = false;\n");
  expectFallback(project, two.profileId, "build.local", /latest meter reading \([^)]+\) is older than the delivery's last recorded step/u);
  meter.setReading(3.2);
  meterRecord(project, two.profileId);
  const total = expectFallback(project, two.profileId, "build.local", /deliveries under this standing approval cost USD 2\.20, above the total budget of USD 2\.00/u);
  assert.doesNotMatch(total.standing_approval.reasons.join("\n"), /per-delivery budget/u);
  meter.setReading(3.6);
  meterRecord(project, two.profileId);
  expectFallback(project, two.profileId, "build.local", /this delivery cost USD 1\.60, above the per-delivery budget of USD 1\.50/u);

  const standing = mustRunJson(["autonomy", "standing", "status", "--root", project, "--id", "SA-COST"], project);
  const usage = standing.standing_approvals[0].budget_usage;
  assert.equal(usage.spent, "2.6");
  assert.equal(usage.measured, 2);
  assert.match(mustRun(["autonomy", "standing", "status", "--root", project, "--id", "SA-COST"], project).stdout, /budget USD 1\.50 per delivery, USD 2\.00 total; spent USD 2\.60 over 2 deliveries/u);
  assert.match(mustRun(["status", "--root", project], project).stdout, /Standing approval SA-COST: exhausted; 2 of 2 deliveries used, expires \S+, cost USD 2\.60 of USD 2\.00/u);
});

test("a delivery meter keeps one series over the delivery's own window, and forged or late readings never count", () => {
  const project = initializeProject("discipline");
  const meter = configureFakeCodeBurn(project);
  mustRunJson(standingArgs(project, ["--budget-per-delivery", "5", "--currency", "USD"]), project);
  mustRunJson(["autonomy", "standing", "approve", "--root", project, "--id", "SA-COST", ...humanApproval("Approve SA-COST")], project);
  const one = prepareDelivery(project, "ONE", { standingId: "SA-COST" });
  approveDelivery(project, one, "SA-COST");
  startTask(project, one);
  // The report window is the delivery's own, never chosen by the caller.
  mustFail(
    ["budget", "meter", "start", "--root", project, "--delivery", one.profileId, "--adapter", "codeburn", "--from", "2026-07-14", "--to", "2026-07-14"],
    project,
    /meter window is derived from the delivery itself[\s\S]*--from, --to cannot be used with --delivery/u,
  );
  // A meter started after the work began cannot cover a step: earlier spend is not counted.
  meter.setReading(1);
  meterStart(project, one.profileId);
  mustFail(
    ["budget", "meter", "start", "--root", project, "--delivery", one.profileId, "--adapter", "codeburn", "--id", "METER-RESTART"],
    project,
    /already has the CodeBurn baseline METER-AUT-ONE-codeburn[\s\S]*would restart the count/u,
  );
  meter.setReading(1.5);
  meterRecord(project, one.profileId);
  writeProjectFile(project, "src/flag-one.mjs", "export const one = false;\n");
  expectFallback(project, one.profileId, "build.local", /its meter started at [^,]+, after the work began at [^,]+, so earlier spend is not counted/u);

  // Without its ledger, even a single receipt is not trusted for a budget.
  const ledgerPath = path.join(project, ".sdlc", "autonomy", "metering", "AUT-ONE", "ledger.json");
  const savedLedger = fs.readFileSync(ledgerPath);
  fs.rmSync(ledgerPath);
  assert.equal(mustRunJson(["budget", "status", "--root", project, "--delivery", one.profileId], project).ledger_status, "untracked");
  expectFallback(project, one.profileId, "build.local", /its usage ledger is missing/u);
  fs.writeFileSync(ledgerPath, savedLedger);

  // A receipt claiming a trusted signed source counts only through a verified signature.
  const plan = mustRunJson(["budget", "status", "--root", project, "--delivery", one.profileId], project).next_receipt_plan.plan;
  const forged = buildExecutionUsageReceipt({
    id: "USAGE-FORGED-SIGNED",
    execution_id: one.profileId,
    budget: plan,
    usage: { cost: "0.01" },
    metering: { cost: "estimated" },
    started_at: new Date(Date.now() - 60_000).toISOString(),
    ended_at: new Date().toISOString(),
    source: {
      adapter: "codeburn",
      assurance: "trusted_attested",
      aggregation: "cumulative",
      attestation_ref: { id: "FAKE", path: ".sdlc/receipts/fake.json", hash: "a".repeat(64) },
    },
  });
  mustFail(
    ["budget", "usage", "record", "--root", project, "--delivery", one.profileId, "--receipt-json", JSON.stringify(forged)],
    project,
    /declares a trusted signed source, but signed or exact values cannot be declared manually or supplied inline/u,
  );
  writeProjectFile(project, ".sdlc/receipts/forged.json", JSON.stringify(forged));
  mustFail(
    ["budget", "usage", "record", "--root", project, "--delivery", one.profileId, "--receipt-file", ".sdlc/receipts/forged.json"],
    project,
    /Signed metering receipt USAGE-FORGED-SIGNED is not trusted by this project \(fail-closed\)/u,
  );
  const planted = path.join(project, ".sdlc", "autonomy", "metering", "AUT-ONE", "usage", "USAGE-FORGED-SIGNED.json");
  fs.writeFileSync(planted, JSON.stringify(forged));
  mustFail(["budget", "status", "--root", project, "--delivery", one.profileId], project, /Usage receipt USAGE-FORGED-SIGNED of delivery AUT-ONE cannot be trusted/u);
  fs.rmSync(planted);

  // A reading dated in the future is refused.
  const future = buildExecutionUsageReceipt({
    id: "USAGE-FUTURE",
    execution_id: one.profileId,
    budget: plan,
    usage: { tokens: 10 },
    metering: { tokens: "estimated" },
    ended_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    source: { adapter: "manual-runtime-adapter", assurance: "manual_declared", aggregation: "delta", attestation_ref: null },
  });
  mustFail(
    ["budget", "usage", "record", "--root", project, "--delivery", one.profileId, "--receipt-json", JSON.stringify(future)],
    project,
    /USAGE-FUTURE was not recorded: it is dated [^,]+, in the future/u,
  );
});

const SIGNED_METER = "signed-cost-meter";

function trustSignedCostMeter(project) {
  const keyPair = generateKeyPairSync("ed25519");
  migrateConfig(project, (config) => {
    config.budget_policy.exact_metering = {
      default_trust: "deny",
      completion_freshness_seconds: 60,
      trusted_sources: [{
        adapter: SIGNED_METER,
        metrics: ["cost"],
        trusted_keys: [{
          key_id: `${SIGNED_METER}-key-1`,
          algorithm: "Ed25519",
          public_key: keyPair.publicKey.export({ type: "spki", format: "pem" }).toString(),
        }],
      }],
    };
  });
  return keyPair;
}

/** A signed cumulative cost reading for one delivery, as a trusted meter would write it. */
function writeSignedCostReceipt(project, keyPair, { id, profileId, plan, amount, startedAt }) {
  const endedAt = new Date().toISOString();
  const usage = { cost: amount };
  const metering = { cost: "exact" };
  const attestation = buildMeteringAttestation({
    id: `${id}-ATTESTATION`,
    measurement: {
      execution_id: profileId,
      budget_id: plan.id,
      budget_hash: plan.budget_hash,
      adapter: SIGNED_METER,
      usage,
      metering,
      cumulative: true,
      started_at: startedAt,
      ended_at: endedAt,
      coverage_started_at: startedAt,
      coverage_ended_at: endedAt,
      final_observation_at: endedAt,
      enforcement_hook_receipt_ref: null,
      pricing_ref: null,
      evidence: [],
    },
    issued_at: new Date(Date.parse(endedAt) + 1).toISOString(),
    valid_from: startedAt,
    expires_at: null,
    signing: { key_id: `${SIGNED_METER}-key-1`, private_key: keyPair.privateKey },
  });
  const attestationPath = `.sdlc/receipts/metering/${id}.attestation.json`;
  writeProjectFile(project, attestationPath, `${JSON.stringify(attestation, null, 2)}\n`);
  const receipt = buildExecutionUsageReceipt({
    id,
    execution_id: profileId,
    budget: plan,
    usage,
    metering,
    started_at: startedAt,
    ended_at: endedAt,
    source: {
      adapter: SIGNED_METER,
      assurance: "trusted_attested",
      aggregation: "cumulative",
      attestation_ref: {
        id: attestation.id,
        path: attestationPath,
        hash: createHash("sha256").update(fs.readFileSync(path.join(project, attestationPath))).digest("hex"),
      },
    },
  });
  const receiptPath = `.sdlc/receipts/metering/${id}.receipt.json`;
  writeProjectFile(project, receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return { receiptPath, receipt };
}

test("a trusted signed cost source measures a delivery exactly, and an untrusted reading is refused", () => {
  const project = initializeProject("signed");
  const keyPair = trustSignedCostMeter(project);
  mustRunJson(standingArgs(project, ["--budget-per-delivery", "1", "--currency", "USD"]), project);
  mustRunJson(["autonomy", "standing", "approve", "--root", project, "--id", "SA-COST", ...humanApproval("Approve SA-COST")], project);
  const one = prepareDelivery(project, "ONE", { standingId: "SA-COST" });
  approveDelivery(project, one, "SA-COST");
  const startedAt = new Date().toISOString();
  sleep(20);
  startTask(project, one);
  writeProjectFile(project, "src/flag-one.mjs", "export const one = false;\n");
  const status = mustRunJson(["budget", "status", "--root", project, "--delivery", one.profileId], project);
  // The plan new receipts bind to follows the standing approval's currency.
  assert.equal(status.next_receipt_plan.currency, "USD");
  const plan = status.next_receipt_plan.plan;
  sleep(20);
  const signed = writeSignedCostReceipt(project, keyPair, { id: "USAGE-SIGNED-1", profileId: one.profileId, plan, amount: "0.5", startedAt });
  mustFail(
    ["budget", "usage", "record", "--root", project, "--delivery", one.profileId, "--receipt-json", JSON.stringify(signed.receipt)],
    project,
    /exact values cannot be declared manually or supplied inline/u,
  );
  const otherKey = generateKeyPairSync("ed25519");
  const forged = writeSignedCostReceipt(project, otherKey, { id: "USAGE-FORGED-1", profileId: one.profileId, plan, amount: "0.01", startedAt });
  mustFail(
    ["budget", "usage", "record", "--root", project, "--delivery", one.profileId, "--receipt-file", forged.receiptPath],
    project,
    /is not trusted by this project \(fail-closed\)/u,
  );
  const recorded = mustRunJson(["budget", "usage", "record", "--root", project, "--delivery", one.profileId, "--receipt-file", signed.receiptPath], project);
  assert.equal(recorded.usage.cost_status, "metered");
  assert.deepEqual(recorded.usage.cost, { amount: "0.5", currency: "USD" });
  assert.deepEqual(recorded.usage.metered_sources, [SIGNED_METER]);
  const covered = deliveryAction(project, one.profileId, "build.local");
  assert.equal(covered.status, "authorized", JSON.stringify(covered));
  assert.equal(covered.action_receipt.approval.approval_source, "standing-approval");
});
