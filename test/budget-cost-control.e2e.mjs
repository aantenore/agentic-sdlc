import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { fileURLToPath } from "node:url";
import { buildExecutionUsageReceipt } from "../lib/execution-budget.mjs";
import { buildMeteringAttestation } from "../lib/metering-attestations.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(repoRoot, "bin", "agentic-sdlc.mjs");
const tempProjects = new Set();
const ADAPTER = "e2e-runtime-meter-v1";

after(() => {
  if (process.env.AGENTIC_SDLC_KEEP_TEST_TMP === "1") return;
  for (const project of tempProjects) {
    fs.rmSync(project, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
  tempProjects.clear();
});

function tmpProject(name) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), `sdlc-${name}-`));
  tempProjects.add(project);
  return project;
}

function run(args, options = {}) {
  const env = { ...process.env };
  for (const key of ["CI", "GITHUB_ACTIONS", "GITHUB_ACTOR", "CODEX_AGENT_NAME", "CODEX_USER_ID", "CODEX_THREAD_ID", "CLAUDECODE", "AGENTIC_SDLC_AGENT_HOST"]) {
    delete env[key];
  }
  Object.assign(env, options.env || {});
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function mustRun(args, options = {}) {
  const result = run(args, options);
  assert.equal(result.status, 0, `${args.join(" ")}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result;
}

function mustFail(args, pattern, options = {}) {
  const result = run(args, options);
  assert.notEqual(result.status, 0, `${args.join(" ")} unexpectedly passed\n${result.stdout}`);
  const combined = `${result.stdout}\n${result.stderr}`;
  assert.match(combined, pattern, `${args.join(" ")}\n${combined}`);
  return result;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function humanApproval(summary = "Approved in test") {
  return ["--actor-type", "human", "--approval-source", "explicit-user", "--summary", summary];
}

function pinProjectConfig(project) {
  const preview = JSON.parse(mustRun(["config", "migrate", "--root", project, "--json"]).stdout);
  mustRun([
    "config", "migrate", "--root", project, "--apply",
    "--plan-hash", preview.plan.plan_hash, "--actor-type", "system", "--json",
  ]);
}

function trustMeteringAdapter(project, metrics) {
  const keyPair = generateKeyPairSync("ed25519");
  const configPath = path.join(project, ".sdlc", "config.json");
  const config = readJson(configPath);
  config.budget_policy.exact_metering = {
    default_trust: "deny",
    completion_freshness_seconds: 60,
    trusted_sources: [{
      adapter: ADAPTER,
      metrics: [...metrics].sort(),
      trusted_keys: [{
        key_id: `${ADAPTER}-key-1`,
        algorithm: "Ed25519",
        public_key: keyPair.publicKey.export({ type: "spki", format: "pem" }).toString(),
      }],
    }],
  };
  writeJson(configPath, config);
  pinProjectConfig(project);
  return keyPair;
}

/** Initializes a project and runs one assessment proposal up to `running`. */
function runningAssessment(name, budget, {
  trustedMetrics = [],
  locale = null,
  configure = null,
  apply = true,
} = {}) {
  const project = tmpProject(name);
  mustRun(["init", "--root", project, "--project-name", "E2E", "--force"]);
  fs.writeFileSync(path.join(project, "README.md"), "# Fixture\n\nLocal repository evidence.\n");
  mustRun(["baseline", "propose", "--root", project, "--id", "BASELINE-1", "--source", "README.md", "--summary", "Current state"]);
  mustRun(["baseline", "approve", "--root", project, "--id", "BASELINE-1", ...humanApproval("Baseline is accurate")]);
  if (configure) {
    const configPath = path.join(project, ".sdlc", "config.json");
    const config = readJson(configPath);
    configure(config);
    writeJson(configPath, config);
    pinProjectConfig(project);
  }
  const keyPair = trustedMetrics.length > 0 ? trustMeteringAdapter(project, trustedMetrics) : null;
  const prepared = JSON.parse(mustRun([
    "assessment", "proposal", "prepare", "--root", project, "--id", "ASSESS-1",
    "--baseline", "BASELINE-1", "--story", "ST-ASSESS-1", "--requirement", "REQ-ASSESS-1",
    "--scope-title", "Cost control", "--scope-summary", "Assess the project within a bounded budget.",
    "--format", "Markdown", "--delivery", "artifact",
    "--artifact", ".sdlc/stories/ST-ASSESS-1/outputs/technical-assessment.md",
    ...(budget ? ["--budget-json", JSON.stringify(budget)] : []),
    ...(locale ? ["--locale", locale] : []),
    "--json",
  ]).stdout);
  mustRun(["assessment", "proposal", "approve", "--root", project, "--id", "ASSESS-1", ...humanApproval("Approve the exact proposal")]);
  if (apply) {
    mustRun(["assessment", "proposal", "apply", "--root", project, "--id", "ASSESS-1", "--actor-type", "agent"]);
  }
  return { project, keyPair, prepared };
}

function sha256File(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

/** Writes a signed cumulative exact receipt, as a trusted runtime meter would. */
function writeTrustedReceipt(project, keyPair, { id, usage, endedAt = new Date().toISOString() }) {
  const application = readJson(path.join(project, ".sdlc", "assessments", "applications", "ASSESS-1.json"));
  const workflow = readJson(path.join(project, ".sdlc", "assessments", "workflows", "ASSESS-1.json"));
  const startedAt = workflow.history.find((entry) => entry.to === "running").at;
  const metering = Object.fromEntries(Object.keys(usage).map((metric) => [metric, "exact"]));
  const attestation = buildMeteringAttestation({
    id: `${id}-ATTESTATION`,
    measurement: {
      execution_id: "ASSESS-1",
      budget_id: application.effective_budget.id,
      budget_hash: application.effective_budget.budget_hash,
      adapter: ADAPTER,
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
    signing: { key_id: `${ADAPTER}-key-1`, private_key: keyPair.privateKey },
  });
  const attestationRelativePath = `.sdlc/receipts/metering/${id}.attestation.json`;
  writeJson(path.join(project, attestationRelativePath), attestation);
  const receipt = buildExecutionUsageReceipt({
    id,
    execution_id: "ASSESS-1",
    budget: application.effective_budget,
    usage,
    metering,
    started_at: startedAt,
    ended_at: endedAt,
    source: {
      adapter: ADAPTER,
      assurance: "trusted_attested",
      aggregation: "cumulative",
      attestation_ref: {
        id: attestation.id,
        path: attestationRelativePath,
        hash: sha256File(path.join(project, attestationRelativePath)),
      },
    },
  });
  const receiptRelativePath = `.sdlc/receipts/metering/${id}.receipt.json`;
  writeJson(path.join(project, receiptRelativePath), receipt);
  return receiptRelativePath;
}

function usageFiles(project) {
  const directory = path.join(project, ".sdlc", "budgets", "ASSESS-1", "usage");
  return fs.existsSync(directory) ? fs.readdirSync(directory).filter((name) => name.endsWith(".json")).sort() : [];
}

test("a regressing cumulative receipt is refused without wedging the budget history", () => {
  const { project, keyPair } = runningAssessment("budget-regression", {
    limits: {
      steps: { unit: "steps", metering: "exact", soft: 10, hard: 20 },
      tokens: { unit: "tokens", metering: "estimated", soft: 50_000 },
    },
  }, { trustedMetrics: ["steps"] });
  const first = writeTrustedReceipt(project, keyPair, {
    id: "USAGE-CUMULATIVE-1",
    usage: { steps: 6 },
  });
  mustRun(["budget", "usage", "record", "--root", project, "--proposal", "ASSESS-1", "--receipt-file", first]);
  const regressed = writeTrustedReceipt(project, keyPair, { id: "USAGE-CUMULATIVE-2", usage: { steps: 4 } });
  mustFail(
    ["budget", "usage", "record", "--root", project, "--proposal", "ASSESS-1", "--receipt-file", regressed],
    /USAGE-CUMULATIVE-2 was not recorded[\s\S]*regressed below previously recorded usage[\s\S]*Nothing was written/u,
  );
  assert.deepEqual(usageFiles(project), ["USAGE-CUMULATIVE-1.json"]);

  const status = JSON.parse(mustRun(["budget", "status", "--root", project, "--proposal", "ASSESS-1", "--json"]).stdout);
  assert.equal(status.aggregate.usage.steps, 6);
  const next = JSON.parse(mustRun([
    "budget", "usage", "record", "--root", project, "--proposal", "ASSESS-1",
    "--input-tokens", "100", "--output-tokens", "20", "--json",
  ]).stdout);
  assert.equal(next.aggregate.usage.tokens, 120);
});

test("manual metric flags are strict whole numbers or decimals and must belong to the budget", () => {
  const { project } = runningAssessment("budget-flags", {
    limits: {
      tokens: { unit: "tokens", metering: "estimated", soft: 10_000 },
      cost: { unit: "money", currency: "USD", metering: "estimated", soft: "5" },
    },
  });
  const record = (...flags) => ["budget", "usage", "record", "--root", project, "--proposal", "ASSESS-1", ...flags];
  for (const [flag, value] of [["--input-tokens", "1e3"], ["--output-tokens", "0x10"], ["--input-tokens", "1.5"]]) {
    mustFail(record(flag, value), new RegExp(`${flag} must be a whole number such as 120 \\(got '${value.replace(".", "\\.")}'\\)`, "u"));
  }
  mustFail(record("--cost-amount", "1e-3"), /--cost-amount must be a plain decimal amount/u);
  mustFail(record("--input-tokens", "-5"), /--input-tokens cannot be negative \(got -5\)/u);
  mustFail(record("--input-tokens", ""), /--input-tokens needs a value, for example --input-tokens 120/u);
  mustFail(
    record("--input-tokens", "10", "--steps", "3"),
    /--steps: metric steps is not in this budget \(accepts: cost \(--cost-amount\), tokens \(--input-tokens \/ --output-tokens\)\)/u,
  );
  mustFail(record("--cost-amount", "1", "--currency", "EUR"), /--currency EUR does not match the budget currency USD/u);
  assert.deepEqual(usageFiles(project), []);

  const recorded = JSON.parse(mustRun(record("--input-tokens", "100", "--output-tokens", "16", "--cost-amount", "1.50", "--json")).stdout);
  assert.equal(recorded.receipt.usage.tokens, 116);
  assert.equal(recorded.receipt.usage.cost, "1.5");
});

function codexSession(project, threadId) {
  const codexHome = path.join(project, "fake-codex-home");
  const directory = path.join(codexHome, "sessions", "2026", "07", "28");
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `rollout-2026-07-28-${threadId}.jsonl`);
  const tokenCount = (timestamp, input, output) => JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: input,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: output,
          reasoning_output_tokens: 0,
          total_tokens: input + output,
        },
      },
      rate_limits: null,
    },
  });
  fs.writeFileSync(file, [
    JSON.stringify({ timestamp: "2026-07-28T08:00:00.000Z", type: "session_meta", payload: { id: threadId, cwd: project, source: "codex_desktop" } }),
    tokenCount("2026-07-28T08:01:00.000Z", 100, 20),
    "",
  ].join("\n"));
  return {
    env: { CODEX_HOME: codexHome, CODEX_THREAD_ID: threadId },
    append: (timestamp, input, output) => fs.appendFileSync(file, `${tokenCount(timestamp, input, output)}\n`),
  };
}

test("budget status shows limits, percentages, currency, and metrics the meter cannot measure", () => {
  const { project } = runningAssessment("budget-status-display", {
    limits: {
      tokens: { unit: "tokens", metering: "estimated", soft: 1000 },
      cost: { unit: "money", currency: "USD", metering: "estimated", soft: "5" },
    },
  }, { apply: false });
  const session = codexSession(project, "019fa7f0-d150-7fb1-aad8-d10a2243521b");
  const started = run(["budget", "meter", "start", "--root", project, "--proposal", "ASSESS-1"], { env: session.env });
  assert.equal(started.status, 0, started.stderr);
  assert.match(started.stdout, /This meter measures: tokens\./u);
  assert.match(started.stdout, /Warning: the Codex session adapter cannot measure cost\. Budget status shows it as not measured/u);
  const startedJson = JSON.parse(mustRun([
    "budget", "meter", "start", "--root", project, "--proposal", "ASSESS-1", "--id", "METER-SECOND", "--json",
  ], { env: session.env }).stdout);
  assert.deepEqual(startedJson.unmeasured_metrics, ["cost"]);
  mustRun(["assessment", "proposal", "apply", "--root", project, "--id", "ASSESS-1", "--actor-type", "agent"]);

  session.append("2026-07-28T08:02:00.000Z", 700, 120);
  mustRun(["budget", "meter", "record", "--root", project, "--proposal", "ASSESS-1"], { env: session.env });
  const human = mustRun(["budget", "status", "--root", project, "--proposal", "ASSESS-1"]).stdout;
  assert.match(human, /tokens: used 700 \/ soft 1000 tokens \(70\.0%\); no hard limit\./u);
  assert.match(human, /cost: not measured \(soft USD 5\.00\); no usage receipt has reported this metric/u);
  assert.match(human, /Warning: tokens reached 70% of its soft limit 1000 tokens/u);
  assert.doesNotMatch(human, /cost: used/u);
  const status = JSON.parse(mustRun(["budget", "status", "--root", project, "--proposal", "ASSESS-1", "--json"]).stdout);
  assert.equal(status.aggregate.status, "within_budget");
  assert.deepEqual(status.aggregate.unmeasured_metrics, ["cost"]);

  mustRun(["budget", "usage", "record", "--root", project, "--proposal", "ASSESS-1", "--cost-amount", "1.5"]);
  const afterCost = mustRun(["budget", "status", "--root", project, "--proposal", "ASSESS-1"]).stdout;
  assert.match(afterCost, /cost: used USD 1\.50 \/ soft USD 5\.00 \(30\.0%\); no hard limit\./u);
});

test("budget amend applies the formal approval checks and the audit-only warning of proposal approve", () => {
  const { project } = runningAssessment("budget-amend-authority", {
    limits: { tokens: { unit: "tokens", metering: "estimated", soft: 1000 } },
  }, {
    configure: (config) => {
      config.budget_policy.maxima = { tokens: 5000 };
    },
  });
  const paused = JSON.parse(mustRun([
    "budget", "usage", "record", "--root", project, "--proposal", "ASSESS-1",
    "--input-tokens", "900", "--output-tokens", "100", "--json",
  ]).stdout);
  assert.equal(paused.status, "exception_pending");
  const amend = (...flags) => [
    "budget", "amend", "--root", project, "--proposal", "ASSESS-1", "--id", "BAMEND-1",
    "--budget-json", JSON.stringify({ limits: { tokens: { soft: 2000 } } }),
    "--reason", "Verification needs about 800 more estimated tokens",
    ...flags,
  ];
  mustFail(amend("--actor-type", "agent", "--approval-source", "explicit-user", "--summary", "ok"), /requires --actor-type human or an approved CI actor/u);
  mustFail(
    amend("--actor-type", "agent", "--approval-source", "automation", "--summary", "I extend my own budget"),
    /requires direct explicit-user or CI approval; automation cannot extend its own budget/u,
  );
  mustFail(
    amend("--actor-type", "human", "--approval-source", "explicit-user"),
    /requires --summary or --approval-evidence when --approval-source explicit-user is used/u,
  );
  mustFail([
    "budget", "amend", "--root", project, "--proposal", "ASSESS-1", "--id", "BAMEND-TOO-LARGE",
    "--budget-json", JSON.stringify({ limits: { tokens: { soft: 9000 } } }),
    "--reason", "Far more tokens", ...humanApproval("I approve 9000 tokens"),
  ], /Invalid budget amendment BAMEND-TOO-LARGE:[\s\S]*limits\.tokens\.soft 9000 exceeds the project maximum 5000/u);
  assert.equal(fs.existsSync(path.join(project, ".sdlc", "budgets", "ASSESS-1", "amendments", "BAMEND-1.json")), false);
  assert.equal(fs.existsSync(path.join(project, ".sdlc", "budgets", "ASSESS-1", "amendments", "BAMEND-TOO-LARGE.json")), false);

  const approved = mustRun(amend(...humanApproval("I approve raising only the token soft limit to 2000")));
  assert.match(approved.stdout, /Authority assurance: audit_only/u);
  assert.match(approved.stdout, /cannot independently prove who invoked it/u);
  const replay = JSON.parse(mustRun(amend(...humanApproval("I approve raising only the token soft limit to 2000"), "--json")).stdout);
  assert.equal(replay.idempotent, true);
  assert.equal(replay.authority_assurance_label, "audit_only");
  assert.match(replay.authority_note, /must not be represented as host-verified security/u);
});

test("the shipped default budget is soft-only, so a normal project can complete without signing keys", () => {
  const { project, prepared } = runningAssessment("budget-default-complete", null);
  const limits = prepared.proposal.execution_budget.limits;
  assert.deepEqual(Object.keys(limits).sort(), ["active_time_seconds", "steps", "tokens"]);
  for (const spec of Object.values(limits)) {
    assert.equal(spec.hard, null);
    assert.notEqual(spec.metering, "exact");
  }
  mustRun(["budget", "usage", "record", "--root", project, "--proposal", "ASSESS-1", "--steps", "3", "--input-tokens", "900", "--output-tokens", "100"]);
  const artifact = ".sdlc/stories/ST-ASSESS-1/outputs/technical-assessment.md";
  fs.mkdirSync(path.dirname(path.join(project, artifact)), { recursive: true });
  fs.writeFileSync(path.join(project, artifact), "# Technical assessment\n\n## Evidence\nThe baseline describes the project.\n");
  const authorization = readJson(path.join(project, ".sdlc", "assessments", "workflows", "ASSESS-1.json")).authorization_ref;
  mustRun([
    "output", "link", "--root", project, "--story", "ST-ASSESS-1", "--type", "technical-analysis",
    "--artifact", artifact, "--template", prepared.proposal.deliverable.template_id, "--mode", "new",
    "--requirement", "REQ-ASSESS-1", "--authorization", authorization,
  ]);
  const completed = JSON.parse(mustRun([
    "assessment", "proposal", "complete", "--root", project, "--id", "ASSESS-1", "--actor-type", "agent", "--json",
  ]).stdout);
  assert.equal(completed.status, "completed");
});

test("project budget settings take precedence over the defaults template and are validated", () => {
  const { prepared } = runningAssessment("budget-precedence", null, {
    apply: false,
    configure: (config) => {
      config.budget_policy.warning_thresholds_percent = [50, 80];
      config.budget_policy.completion_reserve_percent = 20;
    },
  });
  assert.deepEqual(prepared.proposal.execution_budget.warning_thresholds_percent, [50, 80]);
  assert.equal(prepared.proposal.execution_budget.completion_reserve_percent, 20);

  const project = tmpProject("budget-invalid-config");
  mustRun(["init", "--root", project, "--project-name", "E2E", "--force"]);
  const configPath = path.join(project, ".sdlc", "config.json");
  const config = readJson(configPath);
  config.budget_policy.warning_thresholds_percent = [150];
  writeJson(configPath, config);
  mustFail(["config", "migrate", "--root", project, "--json"], /warning_thresholds_percent/u);

  // Without a lock, missing keys are inherited from the legacy defaults; the
  // explicit "hard": null keeps the old hard limits from coming back.
  const unlocked = tmpProject("budget-unlocked-config");
  mustRun(["init", "--root", unlocked, "--project-name", "E2E", "--force"]);
  fs.rmSync(path.join(unlocked, ".sdlc", "config.lock.json"));
  const status = JSON.parse(mustRun(["config", "status", "--root", unlocked, "--json"]).stdout);
  assert.notEqual(status.status, "invalid", status.validation_error);
  assert.deepEqual(status.inherited_paths.filter((pointer) => pointer.includes("/budget_policy/")), []);
});

test("a new budget is refused when its metrics, units, limits, actions, or maxima are unusable", () => {
  const { project } = runningAssessment("budget-strict-input", {
    limits: { tokens: { unit: "tokens", metering: "estimated", soft: 1000 } },
  }, {
    apply: false,
    configure: (config) => {
      config.budget_policy.maxima = { tokens: 500_000, cost: "20" };
    },
  });
  const prepare = (budget, id) => [
    "assessment", "proposal", "prepare", "--root", project, "--id", id,
    "--baseline", "BASELINE-1", "--story", `ST-${id}`, "--requirement", `REQ-${id}`,
    "--scope-title", "Invalid budget", "--scope-summary", "Must not be prepared.",
    "--format", "Markdown", "--delivery", "artifact",
    "--artifact", `.sdlc/stories/ST-${id}/outputs/technical-assessment.md`,
    "--budget-json", JSON.stringify(budget),
  ];
  const cases = [
    [{ limits: { constructor: { unit: "tokens", metering: "estimated", soft: 10 } } }, /metric 'constructor' must be a simple lowercase identifier/u],
    [{ limits: { Tokens: { unit: "tokens", metering: "estimated", soft: 10 } } }, /metric 'Tokens' must be a simple lowercase identifier/u],
    [{ limits: { tokens: { unit: "tokens", metering: "estimated", soft: 0 } } }, /limits\.tokens\.soft must be greater than 0/u],
    [{ limits: { quality_checks: { unit: "chekcs", metering: "estimated", soft: 5 } } }, /unit 'chekcs' is not a known unit/u],
    [{ limits: { tokens: { unit: "calls", metering: "estimated", soft: 5 } } }, /limits\.tokens\.unit must be 'tokens'/u],
    [{ limits: { cost: { unit: "tokens", currency: "USD", metering: "estimated", soft: "5" } } }, /declares currency USD, so its unit must be 'money'/u],
    [{ limits: { tokens: { unit: "tokens", metering: "estimated", soft: 10 } }, limit_policy: { on_soft_limit: "partial_delivery" } }, /limit_policy\.on_soft_limit must be 'checkpoint'/u],
    [{ limits: { tokens: { unit: "tokens", metering: "estimated", soft: 10 } }, extensions: { automatic_extension: true } }, /extensions\.automatic_extension must be false/u],
    [{ limits: { tokens: { unit: "tokens", metering: "estimated", soft: 600_000 } } }, /limits\.tokens\.soft 600000 exceeds the project maximum 500000/u],
    [{ limits: { cost: { unit: "money", currency: "USD", metering: "estimated", soft: "25.00" } } }, /limits\.cost\.soft 25 exceeds the project maximum 20/u],
  ];
  cases.forEach(([budget, pattern], index) => {
    mustFail(prepare(budget, `ASSESS-BAD-${index}`), pattern);
    assert.equal(fs.existsSync(path.join(project, ".sdlc", "assessments", "proposals", `ASSESS-BAD-${index}.json`)), false);
  });
});

test("the budget checkpoint follows --locale, shows currency, and never offers an unsatisfiable hard limit", () => {
  const budget = {
    limits: {
      cost: { unit: "money", currency: "USD", metering: "estimated", soft: "5" },
      steps: { unit: "steps", metering: "exact", soft: 10, hard: 20 },
    },
  };
  const english = runningAssessment("budget-checkpoint-en", budget, { apply: false, locale: "en" }).prepared.assistant_message;
  for (const heading of ["What I am asking you", "Why it is needed", "Approved budget", "What your yes authorizes", "What it does not authorize", "Complete answer examples"]) {
    assert.match(english, new RegExp(heading, "u"));
  }
  assert.match(english, /Monetary cost: soft limit USD 5\.00; no hard stop; metering estimated\./u);
  assert.match(english, /Warning: the hard limit on steps cannot be satisfied in this project[\s\S]*Exact metering setup/u);
  assert.doesNotMatch(english, /Cosa ti sto chiedendo|soglia soft|Budget approvato|Esempio configurazione/u);
  assert.doesNotMatch(english, /5 money|trusted_sources =/u);
  assert.doesNotMatch(english, /hard limit to 45 minutes/u);

  const italian = runningAssessment("budget-checkpoint-it", budget, { apply: false, locale: "it" }).prepared.assistant_message;
  assert.match(italian, /Cosa ti sto chiedendo/u);
  assert.match(italian, /Costo monetario: soglia soft USD 5\.00; nessun hard stop; misura estimated\./u);
  assert.match(italian, /Attenzione: l'hard limit su steps non può essere soddisfatto/u);
  assert.doesNotMatch(italian, /What I am asking you|Esempio configurazione|trusted_sources =/u);
});

test("a deleted usage receipt is detected through the ledger and blocks budget decisions", () => {
  const { project } = runningAssessment("budget-ledger", {
    limits: { tokens: { unit: "tokens", metering: "estimated", soft: 10_000 } },
  });
  const record = (id, tokens) => JSON.parse(mustRun([
    "budget", "usage", "record", "--root", project, "--proposal", "ASSESS-1", "--id", id,
    "--input-tokens", String(tokens), "--output-tokens", "0", "--json",
  ]).stdout);
  record("USAGE-A", 4000);
  record("USAGE-B", 3000);
  const applicationPath = path.join(project, ".sdlc", "assessments", "applications", "ASSESS-1.json");
  const ledger = readJson(applicationPath).usage_ledger;
  assert.equal(ledger.receipt_count, 2);
  assert.deepEqual(ledger.receipts.map((entry) => entry.id), ["USAGE-A", "USAGE-B"]);
  assert.match(ledger.head_hash, /^[a-f0-9]{64}$/u);

  const usageDirectory = path.join(project, ".sdlc", "budgets", "ASSESS-1", "usage");
  const deletedPath = path.join(usageDirectory, "USAGE-A.json");
  const deletedBytes = fs.readFileSync(deletedPath);
  fs.rmSync(deletedPath);
  const blocked = /does not match its usage ledger: the ledger records 2 receipt\(s\), but 1 is missing[\s\S]*Missing: USAGE-A\.[\s\S]*Restore the original files/u;
  mustFail(["budget", "status", "--root", project, "--proposal", "ASSESS-1"], blocked);
  mustFail(["budget", "usage", "record", "--root", project, "--proposal", "ASSESS-1", "--input-tokens", "1", "--output-tokens", "0"], blocked);
  fs.writeFileSync(deletedPath, deletedBytes);
  const restored = JSON.parse(mustRun(["budget", "status", "--root", project, "--proposal", "ASSESS-1", "--json"]).stdout);
  assert.equal(restored.aggregate.usage.tokens, 7000);

  // A receipt written by an interrupted record (file present, ledger not yet
  // updated) only adds usage: it is counted and registered by the next record.
  const application = readJson(applicationPath);
  const orphan = buildExecutionUsageReceipt({
    id: "USAGE-ORPHAN",
    execution_id: "ASSESS-1",
    budget: application.effective_budget,
    usage: { tokens: 500 },
    metering: { tokens: "estimated" },
    ended_at: new Date().toISOString(),
    source: { adapter: "manual-runtime-adapter", assurance: "manual_declared", aggregation: "delta", attestation_ref: null },
  });
  writeJson(path.join(usageDirectory, "USAGE-ORPHAN.json"), orphan);
  const withOrphan = JSON.parse(mustRun(["budget", "status", "--root", project, "--proposal", "ASSESS-1", "--json"]).stdout);
  assert.equal(withOrphan.aggregate.usage.tokens, 7500);
  record("USAGE-C", 100);
  assert.deepEqual(readJson(applicationPath).usage_ledger.receipts.map((entry) => entry.id), ["USAGE-A", "USAGE-B", "USAGE-ORPHAN", "USAGE-C"]);
});

test("an assessment paused at a budget checkpoint can be stopped with a partial result", () => {
  const { project, prepared } = runningAssessment("budget-cancel", {
    limits: { tokens: { unit: "tokens", metering: "estimated", soft: 1000 } },
  });
  const artifact = ".sdlc/stories/ST-ASSESS-1/outputs/technical-assessment.md";
  fs.mkdirSync(path.dirname(path.join(project, artifact)), { recursive: true });
  fs.writeFileSync(path.join(project, artifact), "# Technical assessment\n\n## Evidence\nVerified findings so far.\n");
  const authorization = readJson(path.join(project, ".sdlc", "assessments", "workflows", "ASSESS-1.json")).authorization_ref;
  mustRun([
    "output", "link", "--root", project, "--story", "ST-ASSESS-1", "--type", "technical-analysis",
    "--artifact", artifact, "--template", prepared.proposal.deliverable.template_id, "--mode", "new",
    "--requirement", "REQ-ASSESS-1", "--authorization", authorization,
  ]);
  const paused = JSON.parse(mustRun([
    "budget", "usage", "record", "--root", project, "--proposal", "ASSESS-1",
    "--input-tokens", "1000", "--output-tokens", "0", "--json",
  ]).stdout);
  assert.equal(paused.status, "exception_pending");
  assert.match(paused.assistant_message, /assessment proposal cancel --id ASSESS-1/u);
  const status = JSON.parse(mustRun(["assessment", "proposal", "status", "--root", project, "--id", "ASSESS-1", "--json"]).stdout);
  assert.match(JSON.stringify(status), /assessment proposal cancel --id ASSESS-1/u);

  const cancel = (...flags) => ["assessment", "proposal", "cancel", "--root", project, "--id", "ASSESS-1", ...flags];
  const reason = ["--reason", "Stop at the budget checkpoint and keep the verified findings"];
  mustFail(cancel(...humanApproval("Stop here")), /needs --reason/u);
  mustFail(cancel(...reason, "--actor-type", "agent", "--approval-source", "explicit-user", "--summary", "Stop"), /requires --actor-type human or an approved CI actor/u);
  mustFail(
    cancel(...reason, "--actor-type", "agent", "--approval-source", "automation", "--summary", "I stop myself"),
    /requires direct explicit-user or CI approval/u,
  );
  mustFail(cancel(...reason, "--actor-type", "human", "--approval-source", "explicit-user"), /requires --summary or --approval-evidence/u);
  assert.equal(readJson(path.join(project, ".sdlc", "assessments", "workflows", "ASSESS-1.json")).state, "exception_pending");

  const cancelled = JSON.parse(mustRun(cancel(...reason, ...humanApproval("Stop here; do not extend the budget"), "--json")).stdout);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.previous_state, "exception_pending");
  assert.equal(cancelled.released, false);
  assert.deepEqual(cancelled.partial_outputs, [artifact]);
  assert.equal(cancelled.authorization_ref, authorization);
  assert.equal(cancelled.authorization_status, "closed");
  assert.match(cancelled.authority_note, /cannot independently prove/u);
  assert.equal(cancelled.workflow.state, "cancelled");
  assert.match(cancelled.workflow.history.at(-1).reason, /explicit-user decision \(Stop here; do not extend the budget\)/u);
  assert.equal(JSON.parse(mustRun(cancel(...reason, ...humanApproval("Stop here; do not extend the budget"), "--json")).stdout).idempotent, true);

  mustFail(
    ["budget", "usage", "record", "--root", project, "--proposal", "ASSESS-1", "--input-tokens", "1", "--output-tokens", "0"],
    /ASSESS-1 is cancelled/u,
  );
  mustFail([
    "budget", "amend", "--root", project, "--proposal", "ASSESS-1", "--id", "BAMEND-AFTER-CANCEL",
    "--budget-json", JSON.stringify({ limits: { tokens: { soft: 2000 } } }),
    "--reason", "Too late", ...humanApproval("Extend"),
  ], /current state is cancelled/u);
  mustFail(
    ["assessment", "proposal", "complete", "--root", project, "--id", "ASSESS-1", "--actor-type", "agent"],
    /cancelled/u,
  );
});

test("meter setup errors say how to continue", () => {
  const { project } = runningAssessment("budget-meter-errors", {
    limits: { tokens: { unit: "tokens", metering: "estimated", soft: 10_000 } },
  }, { apply: false });
  mustFail(
    ["budget", "meter", "start", "--root", project, "--proposal", "ASSESS-1"],
    /requires CODEX_THREAD_ID[\s\S]*--thread-id <id>[\s\S]*does not run Codex tasks[\s\S]*--adapter codeburn[\s\S]*budget usage record --proposal <proposal-id> --input-tokens <n> --output-tokens <n>/u,
  );
  mustFail(
    ["budget", "meter", "start", "--root", project, "--proposal", "ASSESS-1", "--adapter", "codeburn"],
    /'codeburn' is disabled[\s\S]*metering_adapters\.codeburn\.enabled to true[\s\S]*config migrate[\s\S]*pinned again/u,
  );

  const configPath = path.join(project, ".sdlc", "config.json");
  const config = readJson(configPath);
  config.budget_policy.metering_adapters.codeburn.enabled = true;
  config.budget_policy.metering_adapters.codeburn.command = {
    executable: path.join(project, "missing-tools", "codeburn"),
    arguments: [],
  };
  writeJson(configPath, config);
  pinProjectConfig(project);
  mustFail(
    ["budget", "meter", "start", "--root", project, "--proposal", "ASSESS-1", "--adapter", "codeburn"],
    /CodeBurn is not installed or not on PATH[\s\S]*Install CodeBurn 0\.9\.x separately[\s\S]*command\.executable[\s\S]*config migrate/u,
  );
});
