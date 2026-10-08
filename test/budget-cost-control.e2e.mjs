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
function runningAssessment(name, budget, { trustedMetrics = [], locale = null } = {}) {
  const project = tmpProject(name);
  mustRun(["init", "--root", project, "--project-name", "E2E", "--force"]);
  fs.writeFileSync(path.join(project, "README.md"), "# Fixture\n\nLocal repository evidence.\n");
  mustRun(["baseline", "propose", "--root", project, "--id", "BASELINE-1", "--source", "README.md", "--summary", "Current state"]);
  mustRun(["baseline", "approve", "--root", project, "--id", "BASELINE-1", ...humanApproval("Baseline is accurate")]);
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
  mustRun(["assessment", "proposal", "apply", "--root", project, "--id", "ASSESS-1", "--actor-type", "agent"]);
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
