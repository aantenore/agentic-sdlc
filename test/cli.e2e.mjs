import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { computeStableHash } from "../lib/canonical.mjs";
import { computeGovernedApprovalSubjectHash } from "../lib/workflow-canonical-evidence.mjs";
import { buildEffectiveConfigLock } from "../lib/effective-config.mjs";
import { buildBudgetAmendment, buildExecutionUsageReceipt } from "../lib/execution-budget.mjs";
import { buildHostApprovalReceipt } from "../lib/authorization-receipts.mjs";
import { buildMeteringAttestation } from "../lib/metering-attestations.mjs";
import { computeProposalHash, createAssessmentWorkflow } from "../lib/assessment-workflow.mjs";
import { validateAgainstSchema } from "../lib/json-schema-validator.mjs";
import { requireSymlinkSupport } from "./helpers/symlink-support.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(repoRoot, "bin", "agentic-sdlc.mjs");
const projectBootstrapPreload = path.join(repoRoot, "test", "helpers", "project-bootstrap-preload.mjs");
const portableRtkTestCommand = Object.freeze(["node", "--test"]);
const tempProjects = new Set();
const meteringFixtureKeys = new Map();

function tmpProject(name) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), `sdlc-${name}-`));
  tempProjects.add(project);
  return project;
}

after(() => {
  if (process.env.AGENTIC_SDLC_KEEP_TEST_TMP === "1") {
    return;
  }
  for (const project of tempProjects) {
    fs.rmSync(project, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
  tempProjects.clear();
  meteringFixtureKeys.clear();
});

function run(args, options = {}) {
  const env = { ...process.env };
  for (const key of ["CI", "GITHUB_ACTIONS", "GITHUB_ACTOR", "CODEX_AGENT_NAME", "CODEX_USER_ID"]) {
    delete env[key];
  }
  Object.assign(env, options.env || {});
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: options.cwd || repoRoot,
    encoding: "utf8",
    env,
    timeout: options.timeout || 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function runAsync(args, options = {}) {
  const env = { ...process.env };
  for (const key of ["CI", "GITHUB_ACTIONS", "GITHUB_ACTOR", "CODEX_AGENT_NAME", "CODEX_USER_ID"]) {
    delete env[key];
  }
  Object.assign(env, options.env || {});
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: options.cwd || repoRoot,
      env,
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), options.timeout || 30_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status, signal) => {
      clearTimeout(timeout);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

function projectBootstrapPreloadEnv(mode, values = {}) {
  const importOption = `--import=${pathToFileURL(projectBootstrapPreload).href}`;
  return {
    NODE_OPTIONS: [process.env.NODE_OPTIONS, importOption].filter(Boolean).join(" "),
    AGENTIC_SDLC_BOOTSTRAP_PRELOAD_MODE: mode,
    ...values,
  };
}

function mustRun(args, options = {}) {
  const result = run(args, options);
  assert.equal(result.error, undefined, `${args.join(" ")} failed to execute: ${result.error?.message}`);
  assert.equal(result.signal, null, `${args.join(" ")} terminated by ${result.signal}`);
  assert.equal(result.status, 0, `${args.join(" ")}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result;
}

function mustFail(args, pattern, options = {}) {
  const result = run(args, options);
  assert.equal(result.error, undefined, `${args.join(" ")} failed to execute: ${result.error?.message}`);
  assert.equal(result.signal, null, `${args.join(" ")} terminated by ${result.signal}`);
  assert.notEqual(result.status, 0, `${args.join(" ")} unexpectedly passed\n${result.stdout}`);
  const combined = `${result.stdout}\n${result.stderr}`;
  assert.match(combined, pattern, `${args.join(" ")}\n${combined}`);
  return result;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readJsonLines(filePath) {
  return fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

const INTERNAL_HUMAN_GUIDANCE_PATTERN = /\b(?:bounded[-_ ]autonomous|checkpoint(?:ed|s)?|audit[-_ ]only|host[-_ ]verified|profiles?|profil[oi]|receipts?|ricevut[ae]|ceiling|schema|hash(?:es)?|reason[_ -]?codes?|codic[ei] (?:motivo|ragione)|(?:REQ|AUT|AUTH|CAP|ST|ACT|PR)-[A-Z0-9][A-Z0-9._-]*)\b/iu;

function splitHumanGuidance(output, locale = "en") {
  const divider = locale === "it"
    ? "Dettagli tecnici (facoltativi):"
    : "Technical details (optional):";
  const labels = locale === "it"
    ? ["Risultato", "Cosa cambia in pratica", "Cosa devi decidere", "Cosa resta protetto", "Prossimo passo"]
    : ["Outcome", "What this changes in practice", "What you need to decide", "What remains protected", "Next step"];
  const dividerIndex = output.indexOf(divider);
  assert.notEqual(dividerIndex, -1, `missing ${divider}\n${output}`);
  const primary = output.slice(0, dividerIndex).trim();
  const technical = output.slice(dividerIndex + divider.length).trim();
  const lines = primary.split(/\r?\n/u);
  for (const label of labels) {
    assert.ok(lines.some((line) => line.startsWith(`${label}:`)), `missing ${label}\n${output}`);
  }
  assert.doesNotMatch(primary, INTERNAL_HUMAN_GUIDANCE_PATTERN);
  return { primary, technical, firstLine: lines.find(Boolean) || "" };
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createFakeCodeBurn(project, report) {
  const toolRoot = path.join(project, "fake-codeburn");
  fs.mkdirSync(toolRoot, { recursive: true });
  const reportPath = path.join(toolRoot, "report.json");
  const runnerPath = path.join(toolRoot, "runner.mjs");
  writeJson(reportPath, report);
  fs.writeFileSync(runnerPath, [
    "import fs from 'node:fs';",
    `const reportPath = ${JSON.stringify(reportPath)};`,
    "if (process.argv.includes('--version')) process.stdout.write('codeburn 0.9.15\\n');",
    "else process.stdout.write(fs.readFileSync(reportPath, 'utf8'));",
  ].join("\n"));
  const configPath = path.join(project, ".sdlc", "config.json");
  const config = readJson(configPath);
  config.budget_policy.metering_adapters.codeburn.enabled = true;
  config.budget_policy.metering_adapters.codeburn.command = {
    executable: process.execPath,
    arguments: [runnerPath],
  };
  writeJson(configPath, config);
  pinProjectConfig(project);
  return {
    reportPath,
  };
}

function createFakeRtk(project, summary = {}) {
  const toolRoot = path.join(project, "fake-rtk");
  fs.mkdirSync(toolRoot, { recursive: true });
  const reportPath = path.join(toolRoot, "gain.json");
  const invocationPath = path.join(toolRoot, "invocations.jsonl");
  const runnerPath = path.join(toolRoot, "runner.mjs");
  writeJson(reportPath, {
    summary: {
      total_commands: 8,
      total_input: 4_000,
      total_output: 1_000,
      total_saved: 2_900,
      avg_savings_pct: 72.5,
      total_time_ms: 80,
      avg_time_ms: 10,
      ...summary,
    },
  });
  fs.writeFileSync(runnerPath, [
    "import fs from 'node:fs';",
    `const reportPath = ${JSON.stringify(reportPath)};`,
    `const invocationPath = ${JSON.stringify(invocationPath)};`,
    "const args = process.argv.slice(2);",
    "if (args.length === 1 && args[0] === '--version') process.stdout.write('rtk 0.43.0\\n');",
    "else if (args.join(' ') === 'gain --project --format json') process.stdout.write(fs.readFileSync(reportPath, 'utf8'));",
    "else { fs.appendFileSync(invocationPath, `${JSON.stringify(args)}\\n`); process.stdout.write(`fake-rtk:${JSON.stringify(args)}\\n`); }",
  ].join("\n"));
  const configPath = path.join(project, ".sdlc", "config.json");
  const config = readJson(configPath);
  config.context_optimization_policy.provider.command = {
    executable: process.execPath,
    arguments: [runnerPath],
  };
  writeJson(configPath, config);
  pinProjectConfig(project);
  return { invocationPath, reportPath, runnerPath };
}

function createPathRtk(toolRoot, invocationPath) {
  fs.mkdirSync(toolRoot, { recursive: true });
  const runnerPath = path.join(toolRoot, "rtk-runtime.mjs");
  const gainReport = JSON.stringify({
    summary: {
      total_commands: 2,
      total_input: 1_000,
      total_output: 300,
      total_saved: 700,
      avg_savings_pct: 70,
      total_time_ms: 20,
      avg_time_ms: 10,
    },
  });
  fs.writeFileSync(runnerPath, [
    "#!/usr/bin/env node",
    "import fs from 'node:fs';",
    `const invocationPath = ${JSON.stringify(invocationPath)};`,
    "const args = process.argv.slice(2);",
    "fs.appendFileSync(invocationPath, `${JSON.stringify({ entry: process.argv[1], args })}\\n`);",
    "if (args.length === 1 && args[0] === '--version') process.stdout.write('rtk 0.43.0\\n');",
    `else if (args.join(' ') === 'gain --project --format json') process.stdout.write(${JSON.stringify(gainReport)});`,
    "else process.stdout.write(`path-rtk:${JSON.stringify(args)}\\n`);",
  ].join("\n"));
  fs.chmodSync(runnerPath, 0o755);
  return runnerPath;
}

function initProject(project, extra = []) {
  mustRun(["init", "--root", project, "--project-name", "E2E", "--force", ...extra]);
}

function pinProjectConfig(project) {
  const preview = JSON.parse(mustRun([
    "config",
    "migrate",
    "--root",
    project,
    "--json",
  ]).stdout);
  const applied = JSON.parse(mustRun([
    "config",
    "migrate",
    "--root",
    project,
    "--apply",
    "--plan-hash",
    preview.plan.plan_hash,
    "--actor-type",
    "system",
    "--json",
  ]).stdout);
  assert.ok(["applied", "already_applied"].includes(applied.status));
  return applied;
}

function humanApproval(summary = "Approved in test") {
  return ["--actor-type", "human", "--approval-source", "explicit-user", "--summary", summary];
}

const delegatedApprovalScope = "technical assessment workbook, read-only repo analysis";

function delegatedAutomationApproval(
  summary = "Antonio delegated approval for this assessment within read-only repo analysis and local output generation",
  scope = delegatedApprovalScope,
  authorization = null,
) {
  return [
    "--actor-type",
    "agent",
    "--approval-source",
    "automation",
    "--scope",
    scope,
    "--summary",
    summary,
    ...(authorization ? ["--authorization", authorization] : []),
  ];
}

function grantAutomationAuthorization(project, id, actions, options = {}) {
  const scope = options.scope || delegatedApprovalScope;
  const artifactTypes = options.artifactTypes || [];
  const boundaries = options.boundaries || [];
  const subjects = options.subjects || [];
  const uses = options.uses || [];
  const granted = JSON.parse(mustRun([
    "authorization",
    "grant",
    "--root",
    project,
    "--id",
    id,
    "--scope",
    scope,
    "--summary",
    options.summary || `Delegate ${actions.join(", ")} within ${scope}`,
    ...actions.flatMap((action) => ["--allow-action", action]),
    ...artifactTypes.flatMap((type) => ["--allow-artifact-type", type]),
    ...boundaries.flatMap((boundary) => ["--allow-boundary", boundary]),
    ...subjects.flatMap((subject) => ["--allow-subject", subject]),
    ...uses.flatMap((use) => ["--allow-use", use]),
    "--actor-type",
    "human",
    "--approval-source",
    "explicit-user",
    "--json",
  ]).stdout);
  return granted.authorization;
}

function ensureRequirement(project, requirementId) {
  const requirementPath = path.join(project, ".sdlc", "requirements", `${requirementId}.json`);
  if (!fs.existsSync(requirementPath)) {
    const createdAt = new Date().toISOString();
    writeJson(requirementPath, {
      id: requirementId,
      kind: "requirement",
      schema_version: "requirement:v1",
      title: `Requirement ${requirementId}`,
      summary: `Canonical outcome and boundary for ${requirementId}`,
      status: "active",
      acceptance_criteria: [`The linked story output provides observable evidence for ${requirementId}`],
      source_paths: [],
      proposal_ref: null,
      created_at: createdAt,
      updated_at: createdAt,
      audit: { fixture: true },
    });
  }
}

function story(project, id, extra = []) {
  const requirements = new Set([
    "REQ-001",
    ...extra.flatMap((value, index) => value === "--requirement" ? [extra[index + 1]] : []).filter(Boolean),
  ]);
  for (const requirementId of requirements) {
    ensureRequirement(project, requirementId);
  }
  mustRun([
    "story",
    "create",
    "--root",
    project,
    "--id",
    id,
    "--title",
    `Story ${id}`,
    "--acceptance",
    "Observable acceptance",
    ...extra,
  ]);
}

function createApprovedTemplate(project, type = "functional-analysis") {
  mustRun(["output", "template", "propose", "--root", project, "--type", type, "--summary", "Standard template"]);
  mustRun(["output", "template", "approve", "--root", project, "--id", `${type}-v1`, ...humanApproval("Approved template")]);
}

function writeArtifact(
  project,
  relativePath,
  body = "# Canonical artifact\n\nThis artifact contains substantive, reviewable evidence for the approved story output.\n",
) {
  const filePath = path.join(project, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body);
  return relativePath;
}

function sha256File(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function snapshotFilesystemTree(root) {
  const entries = [];
  const visit = (entryPath, relativePath) => {
    const stat = fs.lstatSync(entryPath);
    if (stat.isSymbolicLink()) {
      entries.push({ path: relativePath, type: "symlink", target: fs.readlinkSync(entryPath) });
      return;
    }
    if (stat.isDirectory()) {
      entries.push({ path: relativePath, type: "directory" });
      for (const name of fs.readdirSync(entryPath).sort()) {
        visit(path.join(entryPath, name), relativePath ? `${relativePath}/${name}` : name);
      }
      return;
    }
    if (stat.isFile()) {
      entries.push({ path: relativePath, type: "file", sha256: sha256File(entryPath) });
      return;
    }
    entries.push({ path: relativePath, type: "other" });
  };
  visit(root, "");
  return entries;
}

function ensureTrustedMeteringFixture(project, {
  adapter = "e2e-runtime-meter-v1",
  metrics = ["active_time_seconds", "steps"],
} = {}) {
  const fixtureId = `${project}\u0000${adapter}`;
  let keyPair = meteringFixtureKeys.get(fixtureId);
  if (!keyPair) {
    keyPair = generateKeyPairSync("ed25519");
    meteringFixtureKeys.set(fixtureId, keyPair);
  }
  const configPath = path.join(project, ".sdlc", "config.json");
  const config = readJson(configPath);
  const policy = config.budget_policy.exact_metering;
  const trustedSources = policy.trusted_sources || [];
  const publicKey = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const trustedKey = {
    key_id: `${adapter}-key-1`,
    algorithm: "Ed25519",
    public_key: publicKey,
  };
  const existing = trustedSources.find((source) => source.adapter === adapter);
  if (existing) {
    existing.metrics = Array.from(new Set([...existing.metrics, ...metrics])).sort();
    existing.trusted_keys = [trustedKey];
  } else {
    trustedSources.push({ adapter, metrics: [...metrics].sort(), trusted_keys: [trustedKey] });
  }
  config.budget_policy.exact_metering = {
    default_trust: "deny",
    completion_freshness_seconds: policy.completion_freshness_seconds ?? 60,
    trusted_sources: trustedSources,
  };
  writeJson(configPath, config);
  pinProjectConfig(project);
  return { ...keyPair, keyId: trustedKey.key_id };
}

function prepareAssessmentApplyFixture(project, id) {
  fs.writeFileSync(
    path.join(project, "README.md"),
    "# Assessment fixture\n\nLocal repository evidence for capability-readiness regression tests.\n",
  );
  const baselineId = `BASELINE-${id}`;
  mustRun([
    "baseline",
    "propose",
    "--root",
    project,
    "--id",
    baselineId,
    "--source",
    "README.md",
    "--summary",
    "Approved local repository boundary",
  ]);
  mustRun([
    "baseline",
    "approve",
    "--root",
    project,
    "--id",
    baselineId,
    ...humanApproval("Approve the local assessment baseline"),
  ]);
  const proposal = JSON.parse(mustRun([
    "assessment",
    "proposal",
    "prepare",
    "--root",
    project,
    "--id",
    id,
    "--baseline",
    baselineId,
    "--story",
    `ST-${id}`,
    "--requirement",
    `REQ-${id}`,
    "--scope-title",
    "Capability readiness regression",
    "--scope-summary",
    "Verify fail-safe local assessment materialization.",
    "--format",
    "Markdown",
    "--delivery",
    "artifact",
    "--artifact",
    `.sdlc/stories/ST-${id}/outputs/technical-assessment.md`,
    "--budget-json",
    JSON.stringify({
      limits: {
        tokens: { unit: "tokens", metering: "estimated", soft: 10_000 },
      },
    }),
    "--json",
  ]).stdout).proposal;
  return proposal;
}

function writeTrustedUsageReceipt(project, {
  proposalId,
  id,
  usage,
  metering,
  adapter = "e2e-runtime-meter-v1",
  endedAt = null,
  fixtureKey = id,
  configureTrust = true,
}) {
  const exactMetrics = Object.entries(metering)
    .filter(([, level]) => level === "exact")
    .map(([metric]) => metric);
  const application = readJson(path.join(project, ".sdlc", "assessments", "applications", `${proposalId}.json`));
  const workflow = readJson(path.join(project, ".sdlc", "assessments", "workflows", `${proposalId}.json`));
  const executionStartedAt = workflow.history.find((entry) => entry.to === "running")?.at;
  assert.ok(executionStartedAt, `Fixture workflow ${proposalId} has no running transition`);
  const observationAt = endedAt || new Date().toISOString();
  const configuredKey = meteringFixtureKeys.get(`${project}\u0000${adapter}`);
  const keyPair = configureTrust
    ? configuredKey
    : generateKeyPairSync("ed25519");
  if (exactMetrics.length > 0 && configureTrust) {
    assert.ok(keyPair, `Trusted metering fixture ${adapter} must be configured before proposal approval`);
  }
  const attestationRelativePath = `.sdlc/receipts/metering/${fixtureKey}.attestation.json`;
  const attestationPath = path.join(project, attestationRelativePath);
  let attestation = null;
  if (exactMetrics.length > 0) {
    const measurement = {
      execution_id: proposalId,
      budget_id: application.effective_budget.id,
      budget_hash: application.effective_budget.budget_hash,
      adapter,
      usage,
      metering,
      cumulative: true,
      started_at: executionStartedAt,
      ended_at: observationAt,
      coverage_started_at: executionStartedAt,
      coverage_ended_at: observationAt,
      final_observation_at: observationAt,
      enforcement_hook_receipt_ref: null,
      pricing_ref: null,
      evidence: [],
    };
    attestation = buildMeteringAttestation({
      id: `${id}-ATTESTATION`,
      measurement,
      issued_at: new Date(Date.parse(observationAt) + 1).toISOString(),
      valid_from: executionStartedAt,
      expires_at: null,
      signing: {
        key_id: configureTrust ? `${adapter}-key-1` : `${adapter}-untrusted-key`,
        private_key: keyPair.privateKey,
      },
    });
    fs.mkdirSync(path.dirname(attestationPath), { recursive: true });
    writeJson(attestationPath, attestation);
  }
  const receipt = buildExecutionUsageReceipt({
    id,
    execution_id: proposalId,
    budget: application.effective_budget,
    usage,
    metering,
    started_at: exactMetrics.length > 0 ? executionStartedAt : null,
    ended_at: observationAt,
    source: {
      adapter,
      assurance: exactMetrics.length > 0 ? "trusted_attested" : "manual_declared",
      aggregation: exactMetrics.length > 0 ? "cumulative" : "delta",
      attestation_ref: exactMetrics.length > 0
        ? { id: attestation.id, path: attestationRelativePath, hash: sha256File(attestationPath) }
        : null,
    },
  });
  const receiptRelativePath = `.sdlc/receipts/metering/${fixtureKey}.receipt.json`;
  writeJson(path.join(project, receiptRelativePath), receipt);
  return { receipt, receiptRelativePath, attestationRelativePath: exactMetrics.length > 0 ? attestationRelativePath : null };
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeStoredZip(project, relativePath, entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const [name, value] of Object.entries(entries)) {
    const nameBuffer = Buffer.from(name, "utf8");
    const body = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
    const checksum = crc32(body);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(body.length, 18);
    localHeader.writeUInt32LE(body.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localParts.push(localHeader, nameBuffer, body);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(body.length, 20);
    centralHeader.writeUInt32LE(body.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, nameBuffer);

    localOffset += localHeader.length + nameBuffer.length + body.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);

  const filePath = path.join(project, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.concat([...localParts, centralDirectory, end]));
  return relativePath;
}

function createApprovedStoryContract(project, id, phase = "design", artifactType = "functional-analysis") {
  mustRun([
    "contract",
    "create",
    "--root",
    project,
    "--phase",
    phase,
    "--story",
    id,
    "--id",
    `contract-${id}-${phase}`,
    "--context-summary",
    `Ready ${phase} contract`,
    "--qa",
    "Who approves?|Owner",
    "--output-ref",
    `${artifactType}:${artifactType}-v1:new`,
    "--force",
  ]);
  mustRun(["contract", "approve", "--root", project, "--id", `contract-${id}-${phase}`, ...humanApproval("Approved contract")]);
}

function routeIntent(overrides = {}) {
  return JSON.stringify({
    requested_action: "intake_requirement",
    confidence: 0.95,
    referenced_entities: [],
    provided_artifacts: [],
    missing_context: [],
    proposed_phase: null,
    artifact_type: null,
    skip_phases: [],
    ...overrides,
  });
}

function routeDecision(project, overrides = {}, command = ["route", "decide"]) {
  const result = mustRun([
    ...command,
    "--root",
    project,
    "--json",
    "--intent-json",
    routeIntent(overrides),
  ]);
  return JSON.parse(result.stdout);
}

function startStoryTask(project, id, phase = "design", extra = []) {
  return JSON.parse(mustRun([
    "task", "start", "--root", project,
    "--story", id,
    "--intent-json", routeIntent({
      requested_action: "implement_story",
      referenced_entities: [{ type: "story", id }],
      proposed_phase: phase,
    }),
    "--confirm-start",
    "--actor-type", "human",
    "--json",
    ...extra,
  ]).stdout);
}

function createStrictReadyStory(project, id, artifactType = "functional-analysis") {
  story(project, id, [
    "--requirement", "REQ-001",
    "--phase", "design",
    "--status", "ready",
  ]);
  createApprovedTemplate(project, artifactType);
  createApprovedStoryContract(project, id, "design", artifactType);
  startStoryTask(project, id, "design");
  const artifact = writeArtifact(project, `.sdlc/requirements/${id}-${artifactType}.md`);
  mustRun([
    "output",
    "link",
    "--root",
    project,
    "--story",
    id,
    "--type",
    artifactType,
    "--artifact",
    artifact,
    "--template",
    `${artifactType}-v1`,
    "--mode",
    "new",
    "--requirement",
    "REQ-001",
  ]);
}

function completeAssessmentReleaseFixture(project, suffix, baselineId) {
  const proposalId = `ASSESS-${suffix}`;
  const storyId = `ST-${suffix}`;
  const requirementId = `REQ-${suffix}`;
  const templateId = `technical-analysis-${suffix.toLowerCase()}-v1`;
  const artifact = `.sdlc/stories/${storyId}/outputs/technical-assessment.md`;
  const budget = {
    scope: { level: "proposal", proposal_id: proposalId, includes_subagents: true },
    limits: {
      active_time_seconds: { unit: "seconds", metering: "exact", soft: 300, hard: 900 },
      tokens: { unit: "tokens", metering: "estimated", soft: 20000 },
    },
  };
  ensureTrustedMeteringFixture(project, { metrics: ["active_time_seconds"] });
  const prepared = JSON.parse(mustRun([
    "assessment",
    "proposal",
    "prepare",
    "--root",
    project,
    "--id",
    proposalId,
    "--baseline",
    baselineId,
    "--story",
    storyId,
    "--requirement",
    requirementId,
    "--template",
    templateId,
    "--scope-title",
    `Assessment release ${suffix}`,
    "--scope-summary",
    `Produce the evidence-backed, active release scope for ${suffix} without external access.`,
    "--format",
    "Markdown",
    "--delivery",
    "artifact",
    "--artifact",
    artifact,
    "--budget-json",
    JSON.stringify(budget),
    "--json",
  ]).stdout);
  const approved = JSON.parse(mustRun([
    "assessment",
    "proposal",
    "approve",
    "--root",
    project,
    "--id",
    proposalId,
    "--json",
    ...humanApproval(`Approve exact fixture release ${suffix}`),
  ]).stdout);
  mustRun([
    "assessment",
    "proposal",
    "apply",
    "--root",
    project,
    "--id",
    proposalId,
    "--actor-type",
    "agent",
  ]);
  const usageFixture = writeTrustedUsageReceipt(project, {
    proposalId,
    id: `USAGE-${suffix}`,
    usage: { active_time_seconds: 30, tokens: 500 },
    metering: { active_time_seconds: "exact", tokens: "estimated" },
  });
  mustRun([
    "budget",
    "usage",
    "record",
    "--root",
    project,
    "--proposal",
    proposalId,
    "--receipt-file",
    usageFixture.receiptRelativePath,
  ]);
  writeArtifact(
    project,
    artifact,
    `# Assessment ${suffix}\n\nThis immutable release records evidence, findings, risks, and configurable improvements for ${suffix}.\n`,
  );
  mustRun([
    "output",
    "link",
    "--root",
    project,
    "--story",
    storyId,
    "--type",
    "technical-analysis",
    "--artifact",
    artifact,
    "--template",
    templateId,
    "--mode",
    "new",
    "--requirement",
    requirementId,
    "--authorization",
    approved.authorization.id,
  ]);
  const completed = JSON.parse(mustRun([
    "assessment",
    "proposal",
    "complete",
    "--root",
    project,
    "--id",
    proposalId,
    "--actor-type",
    "agent",
    "--json",
  ]).stdout);
  assert.equal(completed.status, "completed");
  assert.equal(completed.release_manifest.proposals[0].hash, prepared.proposal.proposal_hash);
  return completed;
}

test("--version is not shadowed by help and boolean --json does not consume query", () => {
  const version = mustRun(["--version"]);
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);
  assert.equal(version.stdout.trim(), readJson(path.join(repoRoot, "package.json")).version);
  assert.equal(version.stdout.trim(), readJson(path.join(repoRoot, ".codex-plugin", "plugin.json")).version);
  const buildIdentity = JSON.parse(mustRun(["--version", "--json"]).stdout);
  assert.equal(buildIdentity.package_version, version.stdout.trim());
  assert.match(buildIdentity.build_fingerprint, /^[a-f0-9]{64}$/u);
  assert.match(buildIdentity.git_commit, /^[a-f0-9]{40,64}$/u);
  assert.equal(typeof buildIdentity.git_dirty, "boolean");

  const project = tmpProject("parser");
  initProject(project);
  fs.writeFileSync(path.join(project, ".sdlc", "requirements", "REQ-001.md"), "# Workflow\nbusiness workflow\n");
  mustRun(["index", "rebuild", "--root", project]);
  const result = mustRun(["kb", "search", "--root", project, "--json", "workflow"]);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.query, "workflow");
  assert.ok(payload.results.length > 0);
});

test("unsupported human guidance locales fail before command execution", () => {
  mustFail(["--version", "--locale", "fr"], /Unsupported human guidance locale 'fr'.*en or it/u);
});

test("effective configuration is human-readable, reviewable, hash-bound, and fail-closed", () => {
  const project = tmpProject("effective-config-cli");

  const uninitializedHuman = mustRun(["config", "status", "--root", project]).stdout;
  const uninitializedGuidance = splitHumanGuidance(uninitializedHuman);
  assert.match(uninitializedGuidance.firstLine, /^Outcome: This project has not been initialized/u);
  assert.match(uninitializedGuidance.technical, /Status: uninitialized/u);
  assert.match(uninitializedGuidance.technical, /Defaults profile:/u);

  initProject(project);
  const configPath = path.join(project, ".sdlc", "config.json");
  const lockPath = path.join(project, ".sdlc", "config.lock.json");
  assert.equal(fs.existsSync(lockPath), true);
  const locked = JSON.parse(mustRun(["config", "status", "--root", project, "--json"]).stdout);
  assert.equal(locked.status, "locked");
  assert.equal(locked.mutation_allowed, true);
  assert.equal(locked.migration_required, false);

  fs.rmSync(lockPath);
  const legacyConfig = readJson(configPath);
  delete legacyConfig.baseline_policy;
  writeJson(configPath, legacyConfig);
  const configBeforePreview = fs.readFileSync(configPath, "utf8");
  const legacyHuman = mustRun(["config", "status", "--root", project]).stdout;
  const legacyGuidance = splitHumanGuidance(legacyHuman);
  assert.match(legacyGuidance.firstLine, /^Outcome: The project is safely using its previous compatible behavior/u);
  assert.match(legacyGuidance.primary, /preview.*changes no files/i);

  const firstPreviewResult = mustRun([
    "config", "migrate", "--root", project, "--json",
  ]);
  const firstPreview = JSON.parse(firstPreviewResult.stdout);
  assert.equal(firstPreview.status, "planned");
  assert.equal(firstPreview.files_changed, 0);
  assert.equal(firstPreview.detail_level, "compact");
  assert.deepEqual(firstPreview.omitted_fields, ["plan.target_config"]);
  assert.equal(firstPreview.plan_complete, false);
  assert.equal(firstPreview.plan_hash_verification, "requires_full_preview");
  assert.equal(Object.hasOwn(firstPreview.plan, "target_config"), false);
  assert.match(firstPreview.full_details, /--json --full/u);
  assert.equal(
    validateAgainstSchema(firstPreview.plan, "config-migration-plan.schema.json", {
      schemaDir: path.join(repoRoot, "schemas"),
    }).valid,
    false,
    "the compact plan summary must not be presented as a complete config-migration-plan:v1",
  );
  assert.ok(
    Buffer.byteLength(firstPreviewResult.stdout, "utf8") < 16 * 1024,
    `compact config preview is unexpectedly large: ${Buffer.byteLength(firstPreviewResult.stdout, "utf8")} bytes`,
  );
  assert.equal(firstPreview.plan.mode, "materialize_legacy_defaults");
  assert.ok(firstPreview.plan.changes.some((change) => change.path === "/baseline_policy"));
  const fullPreview = JSON.parse(mustRun([
    "config", "migrate", "--root", project, "--json", "--full",
  ]).stdout);
  assert.equal(fullPreview.detail_level, "full");
  assert.deepEqual(fullPreview.omitted_fields, []);
  assert.equal(fullPreview.plan_complete, true);
  assert.equal(fullPreview.plan_hash_verification, "self-contained");
  assert.equal(fullPreview.full_details, null);
  assert.equal(typeof fullPreview.plan.target_config.baseline_policy, "object");
  assert.equal(
    validateAgainstSchema(fullPreview.plan, "config-migration-plan.schema.json", {
      schemaDir: path.join(repoRoot, "schemas"),
    }).valid,
    true,
  );
  assert.equal(
    fullPreview.plan.target_config_hash,
    computeStableHash(fullPreview.plan.target_config),
  );
  assert.equal(fullPreview.plan.plan_hash, firstPreview.plan.plan_hash);
  const { plan_hash: fullPlanHash, ...fullPlanSubject } = fullPreview.plan;
  assert.equal(fullPlanHash, computeStableHash(fullPlanSubject));
  assert.equal(fs.readFileSync(configPath, "utf8"), configBeforePreview);
  assert.equal(fs.existsSync(lockPath), false);

  legacyConfig.schema_version = "0.1.0-reviewed";
  writeJson(configPath, legacyConfig);
  const staleApply = mustFail([
    "config", "migrate", "--root", project, "--apply", "--plan-hash", firstPreview.plan.plan_hash,
  ], /reviewed plan no longer matches/i);
  assert.match(`${staleApply.stdout}\n${staleApply.stderr}`, /existing config and lock remain untouched/i);
  assert.equal(readJson(configPath).schema_version, "0.1.0-reviewed");
  assert.equal(fs.existsSync(lockPath), false);

  const reviewedPreview = JSON.parse(mustRun([
    "config", "migrate", "--root", project, "--json",
  ]).stdout);
  const applied = JSON.parse(mustRun([
    "config", "migrate", "--root", project,
    "--apply", "--plan-hash", reviewedPreview.plan.plan_hash,
    "--actor-type", "human", "--json",
  ]).stdout);
  assert.equal(applied.status, "applied");
  assert.equal(fs.existsSync(lockPath), true);
  assert.equal(readJson(configPath).baseline_policy.max_discovered_files, 5000);
  assert.equal(fs.existsSync(path.join(project, applied.receipt.path)), true);
  assert.equal(JSON.parse(mustRun(["config", "status", "--root", project, "--json"]).stdout).status, "locked");

  const driftedConfig = readJson(configPath);
  driftedConfig.claim_policy.default_ttl_seconds = 120;
  writeJson(configPath, driftedConfig);
  const driftedHuman = mustRun(["config", "status", "--root", project]).stdout;
  const driftedGuidance = splitHumanGuidance(driftedHuman);
  assert.match(driftedGuidance.firstLine, /^Outcome: The rules changed after their last confirmation, so governed changes are paused/u);
  assert.match(driftedGuidance.technical, /Status: drifted/u);
  mustFail([
    "story", "create", "--root", project, "--id", "ST-BLOCKED",
    "--title", "Blocked by config drift", "--acceptance", "No write occurs",
  ], /no governed project files were changed/i);
  assert.equal(fs.existsSync(path.join(project, ".sdlc", "stories", "ST-BLOCKED")), false);

  const driftPreview = JSON.parse(mustRun(["config", "migrate", "--root", project, "--json"]).stdout);
  assert.equal(driftPreview.plan.mode, "reconcile_drift");
  mustFail([
    "config", "migrate", "--root", project, "--apply", "--plan-hash", "0".repeat(64),
  ], /reviewed plan no longer matches/i);
  pinProjectConfig(project);

  const validLock = readJson(lockPath);
  writeJson(lockPath, { ...validLock, kind: "untrusted_lock" });
  const invalid = JSON.parse(mustRun(["config", "status", "--root", project, "--json"]).stdout);
  assert.equal(invalid.status, "invalid");
  assert.equal(invalid.mutation_allowed, false);
  mustFail(["cache", "rebuild", "--root", project], /configuration is invalid/i);
  mustFail(["config", "migrate", "--root", project], /no files were changed.*structurally invalid/is);
  writeJson(lockPath, validLock);
});

test("autonomy rollout mode changes are previewed semantically and applied only by exact hash", () => {
  const project = tmpProject("config-autonomy-mode");
  initProject(project);
  const configPath = path.join(project, ".sdlc", "config.json");
  const lockPath = path.join(project, ".sdlc", "config.lock.json");
  const configBefore = fs.readFileSync(configPath, "utf8");
  const lockBefore = fs.readFileSync(lockPath, "utf8");

  const preview = JSON.parse(mustRun([
    "config", "migrate",
    "--root", project,
    "--autonomy-mode", "observe",
    "--json",
  ]).stdout);
  assert.equal(preview.status, "planned");
  assert.equal(preview.files_changed, 0);
  assert.equal(preview.requested_autonomy_mode, "observe");
  assert.equal(preview.plan.mode, "update_config");
  assert.deepEqual(preview.semantic_diff, [{
    operation: "replace",
    path: "/autonomy_policy/mode",
    before: "enforce_new_only",
    after: "observe",
  }]);
  assert.equal(fs.readFileSync(configPath, "utf8"), configBefore);
  assert.equal(fs.readFileSync(lockPath, "utf8"), lockBefore);

  const humanPreview = mustRun([
    "config", "migrate",
    "--root", project,
    "--autonomy-mode", "observe",
  ]).stdout;
  assert.match(humanPreview, /replace \/autonomy_policy\/mode: "enforce_new_only" -> "observe"/u);
  assert.match(humanPreview, /config migrate --autonomy-mode observe --apply --plan-hash/u);

  mustFail([
    "config", "migrate",
    "--root", project,
    "--apply",
    "--plan-hash", preview.plan.plan_hash,
  ], /reviewed plan no longer matches/u);
  assert.equal(fs.readFileSync(configPath, "utf8"), configBefore);
  assert.equal(fs.readFileSync(lockPath, "utf8"), lockBefore);

  const applied = JSON.parse(mustRun([
    "config", "migrate",
    "--root", project,
    "--autonomy-mode", "observe",
    "--apply",
    "--plan-hash", preview.plan.plan_hash,
    "--actor-type", "human",
    "--json",
  ]).stdout);
  assert.equal(applied.status, "applied");
  assert.equal(applied.autonomy_mode, "observe");
  assert.equal(readJson(configPath).autonomy_policy.mode, "observe");
  assert.equal(JSON.parse(mustRun([
    "config", "status", "--root", project, "--json",
  ]).stdout).status, "locked");

  mustFail([
    "config", "migrate",
    "--root", project,
    "--autonomy-mode", "unsafe",
  ], /autonomy-mode.*Valid values|Expected one of/u);
});

test("RTK optimization gateway validates telemetry, routes safe commands, and bypasses exact output", () => {
  const project = tmpProject("rtk-gateway");
  initProject(project);
  const fakeRtk = createFakeRtk(project);
  const gitInit = spawnSync("git", ["init", "--quiet"], { cwd: project, encoding: "utf8" });
  assert.equal(gitInit.status, 0, gitInit.stderr);

  const untrustedStatus = JSON.parse(mustRun([
    "optimization", "status", "--root", project, "--json",
  ]).stdout);
  assert.equal(untrustedStatus.status, "custom_provider_untrusted");
  assert.equal(untrustedStatus.rtk_project_cumulative.detection.reason, "custom_provider_command_requires_explicit_trust");
  assert.equal(fs.existsSync(fakeRtk.invocationPath), false);

  const status = JSON.parse(mustRun([
    "optimization", "status", "--root", project, "--trust-custom-rtk-command", "--json",
  ]).stdout);
  assert.equal(status.status, "operational");
  assert.equal(status.rtk_project_cumulative.detection.version, "0.43.0");
  assert.equal(status.rtk_project_cumulative.scope, "project_cumulative");
  assert.equal(status.rtk_project_cumulative.usage_credit_tokens, 0);
  assert.equal(status.rtk_project_cumulative.savings.estimated_tokens_avoided, 2_900);
  assert.match(status.rtk_project_cumulative.source.report_hash, /^[a-f0-9]{64}$/u);
  const optimizationGuidance = splitHumanGuidance(mustRun([
    "optimization", "status", "--root", project, "--trust-custom-rtk-command",
  ]).stdout);
  assert.match(optimizationGuidance.firstLine, /^Outcome: Command-output reduction is working/u);
  assert.match(optimizationGuidance.technical, /Context optimization: operational/u);
  assert.match(optimizationGuidance.technical, /Provider: rtk 0\.43\.0/u);

  const optimized = mustRun([
    "optimization", "run", "--root", project,
    "--command-json", JSON.stringify(portableRtkTestCommand),
    "--trust-custom-rtk-command",
  ]);
  assert.match(optimized.stdout, /fake-rtk:/u);
  const optimizedInvocations = readJsonLines(fakeRtk.invocationPath);
  assert.equal(optimizedInvocations.length, 1);
  assert.equal(optimizedInvocations[0][0], "test");
  assert.match(path.win32.basename(optimizedInvocations[0][1]), /^node(?:\.exe)?$/iu);
  assert.equal(optimizedInvocations[0].at(-1), "--test");

  const native = mustRun([
    "optimization", "run", "--root", project,
    "--command-json", JSON.stringify(["git", "status", "--short"]),
    "--exact",
  ]);
  assert.match(native.stdout, /\.sdlc|fake-rtk/u);
  assert.equal(readJsonLines(fakeRtk.invocationPath).length, 1);

  mustFail([
    "optimization", "run", "--root", project,
    "--command-json", JSON.stringify([process.execPath, "-e", "process.stdout.write('unsafe')"]),
    "--exact",
  ], /bare command name|unsupported optimization command/u);
  mustFail([
    "optimization", "run", "--root", project,
    "--command-json", JSON.stringify(["git", "diff", "--output=unsafe.patch"]),
  ], /gateway accepts only/u);

  mustFail([
    "optimization", "capture", "--root", project,
    "--proposal", "ASSESS-NOT-USED", "--phase", "complete",
  ], /reserved for lifecycle hooks/u);

  const untrustedDoctor = JSON.parse(mustRun(["doctor", "--root", project, "--json"]).stdout);
  assert.equal(untrustedDoctor.status, "passed");
  assert.equal(untrustedDoctor.checks.find((check) => check.id === "rtk-optimization-provider").status, "not_applicable");
  const doctor = JSON.parse(mustRun([
    "doctor", "--root", project, "--trust-custom-rtk-command", "--json",
  ]).stdout);
  assert.equal(doctor.status, "passed");
  const buildIdentityCheck = doctor.checks.find((check) => check.id === "build-identity");
  assert.equal(buildIdentityCheck.status, "passed");
  assert.match(buildIdentityCheck.details, /fingerprint [a-f0-9]{64}, source (?:clean|dirty)/u);
  assert.equal(
    doctor.checks.find((check) => check.id === "project-bootstrap-manifest-schema").status,
    "passed",
  );
  assert.equal(
    doctor.checks.find((check) => check.id === "project-bootstrap-journal-schema").status,
    "passed",
  );
  assert.equal(doctor.checks.find((check) => check.id === "rtk-optimization-provider").status, "passed");
  const doctorGuidance = splitHumanGuidance(mustRun([
    "doctor", "--root", project, "--trust-custom-rtk-command",
  ]).stdout);
  assert.match(doctorGuidance.firstLine, /^Outcome: All available health checks passed/u);
  assert.match(doctorGuidance.technical, /Agentic SDLC doctor: passed/u);
  assert.match(doctorGuidance.technical, /PASS rtk-optimization-provider:/u);
});

test("Windows shell-free test routing resolves launchers from the requested project root", {
  skip: process.platform === "win32" ? false : "Windows command-shim regression",
}, () => {
  const project = tmpProject("rtk-windows-project-root");
  initProject(project);
  const shimRoot = tmpProject("rtk-windows-shim");
  const launcher = path.join(shimRoot, "jest-runner.js");
  const shim = path.join(shimRoot, "jest.cmd");
  const marker = path.join(project, "jest-cwd.txt");
  fs.writeFileSync(launcher, [
    "\"use strict\";",
    "const fs = require(\"node:fs\");",
    "fs.appendFileSync(process.env.JEST_CWD_MARKER, `${process.cwd()}\\n`, \"utf8\");",
    "",
  ].join("\n"));
  fs.writeFileSync(shim, [
    "@ECHO off",
    '"%~dp0\\node.exe" "%~dp0\\jest-runner.js" %*',
    "",
  ].join("\r\n"));
  const pathKey = Object.keys(process.env)
    .find((key) => key.toLowerCase() === "path") || "PATH";

  mustRun([
    "optimization", "run", "--root", project,
    "--command-json", JSON.stringify(["jest"]),
    "--exact",
  ], {
    env: {
      [pathKey]: shimRoot,
      JEST_CWD_MARKER: marker,
    },
  });
  mustRun([
    "optimization", "run", "--root", project,
    "--command-json", JSON.stringify(["jest"]),
  ], {
    env: {
      [pathKey]: shimRoot,
      JEST_CWD_MARKER: marker,
    },
  });
  assert.deepEqual(
    fs.readFileSync(marker, "utf8").trim().split("\n"),
    [project, project],
  );
});

test("Windows native optimization ignores project-local executable shadows", {
  skip: process.platform === "win32" ? false : "Windows PATH executable regression",
}, () => {
  const project = tmpProject("rtk-windows-native-path");
  initProject(project);
  const gitInit = spawnSync("git", ["init", "--quiet"], { cwd: project, encoding: "utf8" });
  assert.equal(gitInit.status, 0, gitInit.stderr);

  const marker = path.join(project, "project-git-shadow-invoked");
  fs.copyFileSync(process.execPath, path.join(project, "git.exe"));
  fs.writeFileSync(path.join(project, "status"), [
    "\"use strict\";",
    "const fs = require(\"node:fs\");",
    "fs.writeFileSync(process.env.GIT_SHADOW_MARKER, \"invoked\\n\", \"utf8\");",
    "",
  ].join("\n"));
  const pathKey = Object.keys(process.env)
    .find((key) => key.toLowerCase() === "path") || "PATH";

  mustRun([
    "optimization", "run", "--root", project,
    "--command-json", JSON.stringify(["git", "status", "--short"]),
    "--exact",
  ], {
    env: {
      GIT_SHADOW_MARKER: marker,
      [pathKey]: [".", project, process.env[pathKey]].filter(Boolean).join(path.delimiter),
    },
  });
  assert.equal(fs.existsSync(marker), false);
});

test("standard RTK PATH lookup rejects project-local shadows and spawns the canonical host path", {
  skip: process.platform === "win32" ? "POSIX executable symlink regression" : false,
}, () => {
  const project = tmpProject("rtk-path-trust");
  initProject(project);
  const gitInit = spawnSync("git", ["init", "--quiet"], { cwd: project, encoding: "utf8" });
  assert.equal(gitInit.status, 0, gitInit.stderr);

  const projectMarker = path.join(project, "project-rtk-invocations.jsonl");
  const projectRtk = createPathRtk(path.join(project, ".project-tools"), projectMarker);
  const shadowBin = tmpProject("rtk-shadow-bin");
  fs.symlinkSync(projectRtk, path.join(shadowBin, "rtk"), "file");
  const shadowEnv = { PATH: [shadowBin, process.env.PATH].filter(Boolean).join(path.delimiter) };

  const shadowed = JSON.parse(mustRun([
    "optimization", "status", "--root", project, "--json",
  ], { env: shadowEnv }).stdout);
  assert.equal(shadowed.status, "custom_provider_untrusted");
  assert.equal(
    shadowed.rtk_project_cumulative.detection.reason,
    "project_local_standard_provider_requires_explicit_trust",
  );
  assert.equal(shadowed.rtk_project_cumulative.detection.executable, fs.realpathSync(projectRtk));
  assert.equal(fs.existsSync(projectMarker), false);

  const hostTools = tmpProject("rtk-host-tools");
  const hostMarker = path.join(hostTools, "host-rtk-invocations.jsonl");
  const hostRtk = createPathRtk(hostTools, hostMarker);
  const hostBin = tmpProject("rtk-host-bin");
  fs.symlinkSync(hostRtk, path.join(hostBin, "rtk"), "file");
  const hostEnv = { PATH: [hostBin, process.env.PATH].filter(Boolean).join(path.delimiter) };
  const canonicalHostRtk = fs.realpathSync(hostRtk);

  const hostStatus = JSON.parse(mustRun([
    "optimization", "status", "--root", project, "--json",
  ], { env: hostEnv }).stdout);
  assert.equal(hostStatus.status, "operational");
  assert.equal(hostStatus.rtk_project_cumulative.detection.executable, canonicalHostRtk);

  const optimized = mustRun([
    "optimization", "run", "--root", project,
    "--command-json", JSON.stringify(["git", "status", "--short"]),
  ], { env: hostEnv });
  assert.match(optimized.stdout, /path-rtk:\["git","status","--short"\]/u);
  const invocations = readJsonLines(hostMarker);
  assert.ok(invocations.length >= 3);
  assert.ok(invocations.every((entry) => entry.entry === canonicalHostRtk));
  assert.deepEqual(invocations.at(-1).args, ["git", "status", "--short"]);
});

test("native and exact optimization routes keep external rg and Git helpers disabled", {
  skip: process.platform === "win32" ? "POSIX executable helper regression" : false,
}, () => {
  const project = tmpProject("rtk-native-helper-boundary");
  initProject(project);

  const rgMarker = path.join(project, "rg-pre-invoked");
  const rgPreprocessor = path.join(project, "rg-pre.mjs");
  fs.writeFileSync(rgPreprocessor, [
    "#!/usr/bin/env node",
    "import fs from 'node:fs';",
    `fs.appendFileSync(${JSON.stringify(rgMarker)}, 'invoked\\n');`,
    "const source = process.argv[2];",
    "if (source) process.stdout.write(fs.readFileSync(source, 'utf8'));",
  ].join("\n"));
  fs.chmodSync(rgPreprocessor, 0o755);
  const rgConfig = path.join(project, "ripgrep.conf");
  fs.writeFileSync(rgConfig, `--pre=${rgPreprocessor}\n`);
  fs.writeFileSync(path.join(project, "rg-input.txt"), "needle\n");
  const rgBin = path.join(project, "fake-rg-bin");
  fs.mkdirSync(rgBin);
  const fakeRg = path.join(rgBin, "rg");
  fs.writeFileSync(fakeRg, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const { spawnSync } = require('node:child_process');",
    "const args = process.argv.slice(2);",
    "if (!args.includes('--no-config') && process.env.RIPGREP_CONFIG_PATH) {",
    "  const configured = fs.readFileSync(process.env.RIPGREP_CONFIG_PATH, 'utf8')",
    "    .split(/\\r?\\n/u).find((line) => line.startsWith('--pre='));",
    "  if (configured) {",
    "    const result = spawnSync(configured.slice('--pre='.length), [args.at(-1)], { encoding: 'utf8' });",
    "    process.stdout.write(result.stdout || '');",
    "    process.stderr.write(result.stderr || '');",
    "    process.exit(result.status ?? 1);",
    "  }",
    "}",
    "process.stdout.write(JSON.stringify({ type: 'match' }));",
  ].join("\n"));
  fs.chmodSync(fakeRg, 0o755);
  const rgEnv = {
    ...process.env,
    RIPGREP_CONFIG_PATH: rgConfig,
    PATH: [rgBin, process.env.PATH].filter(Boolean).join(path.delimiter),
  };
  const directRg = spawnSync("rg", ["needle", "--json", "rg-input.txt"], {
    cwd: project,
    encoding: "utf8",
    env: rgEnv,
  });
  assert.equal(directRg.status, 0, directRg.stderr);
  assert.equal(fs.existsSync(rgMarker), true, "fixture must prove RIPGREP_CONFIG_PATH can invoke --pre");
  fs.rmSync(rgMarker);

  mustRun([
    "optimization", "run", "--root", project,
    "--command-json", JSON.stringify(["rg", "needle", "--json", "rg-input.txt"]),
  ], { env: { RIPGREP_CONFIG_PATH: rgConfig, PATH: rgEnv.PATH } });
  assert.equal(fs.existsSync(rgMarker), false);

  const gitInit = spawnSync("git", ["init", "--quiet"], { cwd: project, encoding: "utf8" });
  assert.equal(gitInit.status, 0, gitInit.stderr);
  for (const [key, value] of [["user.name", "E2E"], ["user.email", "e2e@example.test"]]) {
    const configured = spawnSync("git", ["config", key, value], { cwd: project, encoding: "utf8" });
    assert.equal(configured.status, 0, configured.stderr);
  }
  const gitMarker = path.join(project, "git-textconv-invoked");
  const textconv = path.join(project, "git-textconv.mjs");
  fs.writeFileSync(textconv, [
    "#!/usr/bin/env node",
    "import fs from 'node:fs';",
    `fs.appendFileSync(${JSON.stringify(gitMarker)}, 'invoked\\n');`,
    "process.stdout.write(fs.readFileSync(process.argv[2], 'utf8'));",
  ].join("\n"));
  fs.chmodSync(textconv, 0o755);
  fs.writeFileSync(path.join(project, ".gitattributes"), "*.probe diff=probe\n");
  fs.writeFileSync(path.join(project, "sample.probe"), "before\n");
  for (const args of [
    ["config", "diff.probe.textconv", textconv],
    ["add", ".gitattributes", "sample.probe"],
    ["commit", "--quiet", "-m", "fixture"],
  ]) {
    const result = spawnSync("git", args, { cwd: project, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  fs.writeFileSync(path.join(project, "sample.probe"), "after\n");
  const directGit = spawnSync("git", ["diff", "--", "sample.probe"], {
    cwd: project,
    encoding: "utf8",
  });
  assert.equal(directGit.status, 0, directGit.stderr);
  assert.equal(fs.existsSync(gitMarker), true, "fixture must prove the configured textconv is active");
  fs.rmSync(gitMarker);

  mustRun([
    "optimization", "run", "--root", project,
    "--command-json", JSON.stringify(["git", "diff", "--", "sample.probe"]),
    "--exact",
  ]);
  assert.equal(fs.existsSync(gitMarker), false);
});

test("optimization run locks and evaluates every active governed assessment", async () => {
  const project = tmpProject("rtk-budget-gate");
  initProject(project);
  const fakeRtk = createFakeRtk(project);
  const gitInit = spawnSync("git", ["init", "--quiet"], { cwd: project, encoding: "utf8" });
  assert.equal(gitInit.status, 0, gitInit.stderr);
  fs.writeFileSync(path.join(project, "README.md"), "# Governed optimization gate\n");
  mustRun([
    "baseline", "propose", "--root", project, "--id", "BASELINE-RTK-GATE",
    "--source", "README.md", "--summary", "Two active assessments share one project-level command gateway",
  ]);
  mustRun([
    "baseline", "approve", "--root", project, "--id", "BASELINE-RTK-GATE",
    ...humanApproval("The gateway test baseline is accurate"),
  ]);

  for (const suffix of ["A", "B"]) {
    const proposalId = `ASSESS-RTK-GATE-${suffix}`;
    const storyId = `ST-RTK-GATE-${suffix}`;
    const requirementId = `REQ-RTK-GATE-${suffix}`;
    const templateId = `technical-analysis-rtk-gate-${suffix.toLowerCase()}-v1`;
    const artifact = `.sdlc/stories/${storyId}/outputs/technical-assessment.md`;
    const budget = {
      scope: { level: "proposal", proposal_id: proposalId, includes_subagents: true },
      limits: {
        tokens: { unit: "tokens", metering: "estimated", soft: 10 },
      },
    };
    mustRun([
      "assessment", "proposal", "prepare", "--root", project,
      "--id", proposalId, "--baseline", "BASELINE-RTK-GATE",
      "--story", storyId, "--requirement", requirementId,
      "--template", templateId,
      "--scope-title", `Assess optimization gate ${suffix}`,
      "--scope-summary", `Verify that governed assessment ${suffix} cannot be used to bypass another active cost gate.`,
      "--format", "Markdown", "--delivery", "artifact", "--artifact", artifact,
      "--budget-json", JSON.stringify(budget),
    ]);
    mustRun([
      "assessment", "proposal", "approve", "--root", project, "--id", proposalId,
      ...humanApproval(`Approve governed optimization fixture ${suffix}`),
    ]);
    mustRun([
      "assessment", "proposal", "apply", "--root", project, "--id", proposalId,
      "--actor-type", "agent", "--trust-custom-rtk-command",
    ]);
  }

  const mutationLock = path.join(project, ".sdlc", "budgets", "ASSESS-RTK-GATE-A", "mutation.lock");
  writeJson(mutationLock, {
    pid: process.pid,
    host: os.hostname(),
    nonce: "test-held-budget-lock",
    created_at: new Date().toISOString(),
  });
  let lockContendedRun;
  try {
    lockContendedRun = runAsync([
      "optimization", "run", "--root", project, "--proposal", "ASSESS-RTK-GATE-B",
      "--command-json", JSON.stringify(portableRtkTestCommand),
      "--trust-custom-rtk-command",
    ]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(fs.existsSync(fakeRtk.invocationPath), false, "the child command started before all budget mutation locks were acquired");
  } finally {
    fs.rmSync(mutationLock, { force: true });
  }
  const lockContendedResult = await lockContendedRun;
  assert.equal(lockContendedResult.status, 0, `${lockContendedResult.stdout}\n${lockContendedResult.stderr}`);
  assert.equal(readJsonLines(fakeRtk.invocationPath).length, 1);

  const stopped = JSON.parse(mustRun([
    "budget", "usage", "record", "--root", project,
    "--proposal", "ASSESS-RTK-GATE-A", "--input-tokens", "10", "--json",
  ]).stdout);
  assert.equal(stopped.aggregate.status, "soft_limit");
  assert.equal(stopped.workflow.state, "exception_pending");
  mustFail([
    "optimization", "run", "--root", project, "--proposal", "ASSESS-RTK-GATE-B",
    "--command-json", JSON.stringify(portableRtkTestCommand),
    "--trust-custom-rtk-command",
  ], /Cost gate for ASSESS-RTK-GATE-A blocks optimization run: soft_limit/u);
  assert.equal(readJsonLines(fakeRtk.invocationPath).length, 1, "a different proposal bypassed the active soft-limit gate");
});

test("story create persists acceptance criteria with human-readable alias", () => {
  const project = tmpProject("story-acceptance-alias");
  initProject(project);
  const created = JSON.parse(mustRun([
    "story",
    "create",
    "--root",
    project,
    "--id",
    "ST-ACCEPTANCE",
    "--title",
    "Story acceptance alias",
    "--acceptance",
    "The current architecture assessment is observable and actionable",
    "--json",
  ]).stdout);
  assert.deepEqual(created.story.acceptance_criteria, ["The current architecture assessment is observable and actionable"]);
  assert.deepEqual(created.story.acceptance, ["The current architecture assessment is observable and actionable"]);

  const stored = readJson(path.join(project, ".sdlc", "stories", "ST-ACCEPTANCE", "story.json"));
  assert.deepEqual(stored.acceptance_criteria, ["The current architecture assessment is observable and actionable"]);
  assert.deepEqual(stored.acceptance, ["The current architecture assessment is observable and actionable"]);
  const plan = fs.readFileSync(path.join(project, ".sdlc", "stories", "ST-ACCEPTANCE", "plan.md"), "utf8");
  assert.doesNotMatch(plan, /[ \t]+$/m);
});

test("story acceptance add preserves governed story state and workspace files", () => {
  const project = tmpProject("story-acceptance-add");
  initProject(project);
  mustRun([
    "requirement",
    "propose",
    "--root",
    project,
    "--id",
    "REQ-SAFE-FORCE",
    "--title",
    "Preserve governed story recovery",
    "--summary",
    "Keep all approved story bindings when adding a missing acceptance criterion",
    "--acceptance",
    "Recovery changes only the supplied story values",
    "--autonomy-ceiling",
    "checkpointed",
  ]);
  mustRun([
    "requirement",
    "approve",
    "--root",
    project,
    "--id",
    "REQ-SAFE-FORCE",
    ...humanApproval("Approve the governed story recovery fixture"),
  ]);
  mustRun([
    "story",
    "create",
    "--root",
    project,
    "--id",
    "ST-SAFE-FORCE",
    "--title",
    "Preserve governed story state",
    "--requirement",
    "REQ-SAFE-FORCE",
  ]);

  const storyPath = path.join(project, ".sdlc", "stories", "ST-SAFE-FORCE", "story.json");
  const planPath = path.join(project, ".sdlc", "stories", "ST-SAFE-FORCE", "plan.md");
  const implementationLogPath = path.join(
    project,
    ".sdlc",
    "stories",
    "ST-SAFE-FORCE",
    "implementation-log.md",
  );
  const original = readJson(storyPath);
  const governed = {
    ...original,
    status: "implementation",
    phase: "implementation",
    contract_id: "CONTRACT-SAFE-FORCE",
    work_breakdown_id: "BREAKDOWN-SAFE-FORCE",
    links: {
      ...original.links,
      decisions: ["DEC-SAFE-FORCE"],
      tests: ["TEST-SAFE-FORCE"],
    },
  };
  writeJson(storyPath, governed);
  fs.writeFileSync(planPath, "# Preserved plan\n");
  fs.writeFileSync(implementationLogPath, "# Preserved implementation log\n");
  const deliveriesPath = path.join(project, ".sdlc", "autonomy", "deliveries");
  fs.mkdirSync(deliveriesPath, { recursive: true });
  writeJson(path.join(deliveriesPath, "AUT-SAFE-FORCE.json"), {
    id: "AUT-SAFE-FORCE",
    story_refs: [{ id: "ST-SAFE-FORCE", hash: "stale-story-hash" }],
  });

  const updated = JSON.parse(mustRun([
    "story",
    "acceptance",
    "add",
    "--root",
    project,
    "--id",
    "ST-SAFE-FORCE",
    "--acceptance",
    "The recovery update keeps every existing governance binding",
    "--summary",
    "Recover the missing story-level criterion",
    "--json",
  ]).stdout);
  assert.equal(updated.status, "updated");
  assert.equal(updated.story.contract_id, "CONTRACT-SAFE-FORCE");
  assert.equal(updated.story.work_breakdown_id, "BREAKDOWN-SAFE-FORCE");
  assert.equal(updated.story.phase, "implementation");
  assert.equal(updated.story.status, "implementation");
  assert.equal(updated.story.autonomy_ceiling, governed.autonomy_ceiling);
  assert.deepEqual(updated.story.links.requirements, ["REQ-SAFE-FORCE"]);
  assert.deepEqual(updated.story.links.decisions, ["DEC-SAFE-FORCE"]);
  assert.deepEqual(updated.story.links.tests, ["TEST-SAFE-FORCE"]);
  assert.equal(updated.story.requirement_refs[0].id, "REQ-SAFE-FORCE");
  assert.deepEqual(updated.story.acceptance_criteria, [
    "The recovery update keeps every existing governance binding",
  ]);
  assert.equal(updated.story.created_at, governed.created_at);
  assert.deepEqual(updated.story.audit.created_by, governed.audit.created_by);
  assert.equal(updated.downstream_review_required, true);
  assert.deepEqual(updated.delivery_profile_ids, ["AUT-SAFE-FORCE"]);
  assert.equal(updated.trace_event.request.previous_story_hash, updated.previous_story_hash);
  assert.equal(updated.trace_event.request.current_story_hash, updated.current_story_hash);
  assert.deepEqual(
    updated.trace_event.request.downstream_delivery_profiles_requiring_review,
    ["AUT-SAFE-FORCE"],
  );
  const unchanged = JSON.parse(mustRun([
    "story",
    "acceptance",
    "add",
    "--root",
    project,
    "--id",
    "ST-SAFE-FORCE",
    "--acceptance",
    "The recovery update keeps every existing governance binding",
    "--json",
  ]).stdout);
  assert.equal(unchanged.status, "unchanged");
  assert.equal(unchanged.downstream_review_required, true);
  assert.equal(unchanged.contract_review_required, true);
  assert.deepEqual(unchanged.delivery_profile_ids, ["AUT-SAFE-FORCE"]);
  assert.equal(fs.readFileSync(planPath, "utf8"), "# Preserved plan\n");
  assert.equal(fs.readFileSync(implementationLogPath, "utf8"), "# Preserved implementation log\n");
});

test("story creation and acceptance recovery reject lifecycle and binding bypass options", () => {
  const project = tmpProject("story-command-options");
  initProject(project);
  mustRun([
    "story", "create", "--root", project,
    "--id", "ST-OPTIONS", "--title", "Safe story options",
    "--acceptance", "One observable result",
  ]);
  const storyPath = path.join(project, ".sdlc", "stories", "ST-OPTIONS", "story.json");
  const before = fs.readFileSync(storyPath);

  mustFail([
    "story", "create", "--root", project,
    "--id", "ST-OPTIONS", "--title", "Unsafe rewrite",
    "--acceptance", "Another result", "--force",
  ], /story create does not accept --force/i);
  mustFail([
    "story", "acceptance", "add", "--root", project,
    "--id", "ST-OPTIONS", "--acceptance", "Another result", "--status", "done",
  ], /story acceptance add does not accept --status/i);
  mustFail([
    "story", "acceptance", "add", "--root", project,
    "--id", "ST-OPTIONS", "--acceptance", "Another result", "--contract", "CONTRACT-UNAPPROVED",
  ], /story acceptance add does not accept --contract/i);
  mustFail([
    "story", "create", "--root", project,
    "--id", "ST-DONE", "--title", "Skip the lifecycle",
    "--acceptance", "Pretend complete", "--status", "done",
  ], /may start only as draft or ready/i);
  mustFail([
    "story", "create", "--root", project,
    "--id", "ST-READY-INCOMPLETE", "--title", "Ready without success criteria",
    "--status", "ready",
  ], /ready story requires at least one observable --acceptance/i);
  const draftCreated = mustRun([
    "story", "create", "--root", project,
    "--id", "ST-DRAFT-INCOMPLETE", "--title", "Draft awaiting success criteria",
  ]);
  const draftGuidance = splitHumanGuidance(draftCreated.stdout);
  assert.match(draftGuidance.primary, /does not yet have an observable success criterion/is);
  assert.match(draftGuidance.primary, /State at least one verifiable result/is);
  assert.match(
    draftGuidance.technical,
    /story acceptance add --id ST-DRAFT-INCOMPLETE --acceptance <criterion>/u,
  );
  const draftItalian = mustRun([
    "story", "create", "--root", project,
    "--id", "ST-DRAFT-INCOMPLETE-IT",
    "--title", "Bozza in attesa del risultato",
    "--locale", "it",
  ]);
  const draftItalianGuidance = splitHumanGuidance(draftItalian.stdout, "it");
  assert.match(draftItalianGuidance.primary, /senza un criterio di successo osservabile/is);
  assert.match(draftItalianGuidance.primary, /Indica almeno un risultato verificabile/is);
  assert.match(
    draftItalianGuidance.technical,
    /story acceptance add --id ST-DRAFT-INCOMPLETE-IT --acceptance <criterion>/u,
  );
  const definedEnglish = mustRun([
    "story", "create", "--root", project,
    "--id", "ST-DEFINED-EN",
    "--title", "Story with a visible result",
    "--acceptance", "The saved result can be reopened",
  ]);
  const definedEnglishGuidance = splitHumanGuidance(definedEnglish.stdout, "en");
  assert.match(definedEnglishGuidance.primary, /observable success criteria is ready/is);
  assert.match(definedEnglishGuidance.primary, /expected result is recorded/is);
  assert.doesNotMatch(definedEnglish.stdout, /story acceptance add --id ST-DEFINED-EN/u);
  const definedItalian = mustRun([
    "story", "create", "--root", project,
    "--id", "ST-DEFINED-IT",
    "--title", "Story con risultato visibile",
    "--acceptance", "Il risultato salvato può essere riaperto",
    "--locale", "it",
  ]);
  const definedItalianGuidance = splitHumanGuidance(definedItalian.stdout, "it");
  assert.match(definedItalianGuidance.primary, /criteri di successo osservabili/is);
  assert.match(definedItalianGuidance.primary, /risultato atteso è registrato/is);
  assert.doesNotMatch(definedItalian.stdout, /story acceptance add --id ST-DEFINED-IT/u);
  mustFail([
    "contract", "create", "--root", project,
    "--phase", "design", "--story", "ST-DRAFT-INCOMPLETE",
    "--id", "contract-ST-DRAFT-INCOMPLETE-design",
    "--context-summary", "This must wait for story success criteria",
    "--qa", "Is the story ready?|No",
  ], /has no observable acceptance criteria.*story acceptance add/is);
  assert.deepEqual(fs.readFileSync(storyPath), before);
  assert.equal(fs.existsSync(path.join(project, ".sdlc", "stories", "ST-DONE")), false);
});

test("story claim requires observable acceptance and gives the additive recovery command", () => {
  const project = tmpProject("claim-missing-acceptance");
  initProject(project);
  mustRun([
    "story", "create", "--root", project,
    "--id", "ST-CLAIM-NO-ACCEPTANCE",
    "--title", "Do not claim an undefined story",
  ]);
  const claimPath = path.join(
    project,
    ".sdlc",
    "stories",
    "ST-CLAIM-NO-ACCEPTANCE",
    "claim.json",
  );
  const englishFailure = mustFail([
    "story", "claim", "--root", project,
    "--id", "ST-CLAIM-NO-ACCEPTANCE",
    "--agent", "codex",
  ], /no observable acceptance criteria.*story acceptance add --id ST-CLAIM-NO-ACCEPTANCE/is);
  const englishGuidance = splitHumanGuidance(englishFailure.stderr, "en");
  assert.match(englishGuidance.primary, /cannot be assigned.*no observable success criterion/is);
  assert.match(englishGuidance.primary, /State at least one verifiable result/is);
  assert.equal(
    (englishFailure.stderr.match(
      /story acceptance add --id ST-CLAIM-NO-ACCEPTANCE --acceptance <criterion>/gu,
    ) || []).length,
    1,
  );
  const italianFailure = mustFail([
    "story", "claim", "--root", project,
    "--id", "ST-CLAIM-NO-ACCEPTANCE",
    "--agent", "codex",
    "--locale", "it",
  ], /no observable acceptance criteria.*story acceptance add --id ST-CLAIM-NO-ACCEPTANCE/is);
  const italianGuidance = splitHumanGuidance(italianFailure.stderr, "it");
  assert.match(italianGuidance.primary, /non può ancora essere assegnata.*criterio di successo osservabile/is);
  assert.match(italianGuidance.primary, /Indica almeno un risultato verificabile/is);
  assert.equal(
    (italianFailure.stderr.match(
      /story acceptance add --id ST-CLAIM-NO-ACCEPTANCE --acceptance <criterion>/gu,
    ) || []).length,
    1,
  );
  assert.equal(fs.existsSync(claimPath), false);
  mustRun([
    "story", "acceptance", "add", "--root", project,
    "--id", "ST-CLAIM-NO-ACCEPTANCE",
    "--acceptance", "The assigned work has one verifiable outcome",
  ]);
  const missingStart = mustFail([
    "story", "claim", "--root", project,
    "--id", "ST-CLAIM-NO-ACCEPTANCE",
    "--agent", "codex",
  ], /cannot be claimed before its current approved contract and immutable task start are valid/is);
  const missingStartGuidance = splitHumanGuidance(missingStart.stderr, "en");
  assert.match(missingStartGuidance.primary, /cannot be assigned.*has not been validly started/is);
  assert.match(missingStartGuidance.primary, /Complete the governed task start/is);
  assert.equal(fs.existsSync(claimPath), false);

  createApprovedTemplate(project, "functional-analysis");
  createApprovedStoryContract(
    project,
    "ST-CLAIM-NO-ACCEPTANCE",
    "design",
    "functional-analysis",
  );
  mustFail([
    "story", "claim", "--root", project,
    "--id", "ST-CLAIM-NO-ACCEPTANCE",
    "--agent", "codex",
  ], /no task-start receipt/is);
  assert.equal(fs.existsSync(claimPath), false);
  startStoryTask(project, "ST-CLAIM-NO-ACCEPTANCE", "design");
  const claimed = JSON.parse(mustRun([
    "story", "claim", "--root", project,
    "--id", "ST-CLAIM-NO-ACCEPTANCE",
    "--agent", "codex",
    "--json",
  ]).stdout);
  assert.equal(claimed.status, "claimed");
  assert.equal(readJson(claimPath).status, "active");
});

test("story claim and release roll back exactly when their audit trace is unsafe", (t) => {
  if (!requireSymlinkSupport(t, "file")) return;
  const project = tmpProject("story-claim-release-trace-transaction");
  initProject(project);
  story(project, "ST-CLAIM-TRACE", [
    "--phase", "design",
    "--status", "ready",
  ]);
  createApprovedTemplate(project, "functional-analysis");
  createApprovedStoryContract(
    project,
    "ST-CLAIM-TRACE",
    "design",
    "functional-analysis",
  );
  startStoryTask(project, "ST-CLAIM-TRACE", "design");

  const storyDir = path.join(project, ".sdlc", "stories", "ST-CLAIM-TRACE");
  const claimPath = path.join(storyDir, "claim.json");
  const claimProjectPath = ".sdlc/stories/ST-CLAIM-TRACE/claim.json";
  const tracePath = path.join(project, ".sdlc", "traces", "ST-CLAIM-TRACE.jsonl");
  const originalTrace = fs.existsSync(tracePath) ? fs.readFileSync(tracePath) : null;
  const externalTrace = path.join(project, "external-claim-trace.jsonl");
  const externalBefore = Buffer.from("outside claim trace\n");
  fs.writeFileSync(externalTrace, externalBefore);
  fs.rmSync(tracePath, { force: true });
  fs.symlinkSync(externalTrace, tracePath);

  mustFail([
    "story", "claim", "--root", project,
    "--id", "ST-CLAIM-TRACE",
    "--agent", "codex",
  ], /symbolic link|symlink|trace integrity/i);
  assert.equal(fs.existsSync(claimPath), false);
  assert.deepEqual(fs.readFileSync(externalTrace), externalBefore);

  fs.rmSync(tracePath);
  if (originalTrace) {
    fs.writeFileSync(tracePath, originalTrace);
  }
  const claimed = JSON.parse(mustRun([
    "story", "claim", "--root", project,
    "--id", "ST-CLAIM-TRACE",
    "--agent", "codex",
    "--json",
  ]).stdout);
  assert.equal(claimed.status, "claimed");
  assert.equal(claimed.trace_event.action, "story.claim");
  const claimedEvidenceRef = claimed.trace_event.evidence_refs.find(
    (reference) => reference.path === claimProjectPath,
  );
  assert.ok(claimedEvidenceRef);
  const activeSnapshotTrace = JSON.parse(mustRun([
    "trace", "append", "--root", project,
    "--story", "ST-CLAIM-TRACE",
    "--type", "sync",
    "--summary", "Verify the active claim evidence snapshot",
    "--evidence", claimProjectPath,
    "--json",
  ]).stdout).event;
  assert.equal(
    activeSnapshotTrace.evidence_refs.find(
      (reference) => reference.path === claimProjectPath,
    ).sha256,
    claimedEvidenceRef.sha256,
  );
  const activeClaim = fs.readFileSync(claimPath);
  const validClaimTrace = fs.readFileSync(tracePath);

  const externalReleaseTrace = path.join(project, "external-release-trace.jsonl");
  const externalReleaseBefore = Buffer.from("outside release trace\n");
  fs.writeFileSync(externalReleaseTrace, externalReleaseBefore);
  fs.rmSync(tracePath);
  fs.symlinkSync(externalReleaseTrace, tracePath);
  mustFail([
    "story", "release", "--root", project,
    "--id", "ST-CLAIM-TRACE",
    "--agent", "codex",
  ], /symbolic link|symlink|trace integrity/i);
  assert.deepEqual(fs.readFileSync(claimPath), activeClaim);
  assert.equal(readJson(claimPath).status, "active");
  assert.deepEqual(fs.readFileSync(externalReleaseTrace), externalReleaseBefore);

  fs.rmSync(tracePath);
  fs.writeFileSync(tracePath, validClaimTrace);
  const released = JSON.parse(mustRun([
    "story", "release", "--root", project,
    "--id", "ST-CLAIM-TRACE",
    "--agent", "codex",
    "--json",
  ]).stdout);
  assert.equal(released.status, "released");
  assert.equal(released.trace_event.action, "story.release");
  assert.equal(readJson(claimPath).status, "released");
  const releasedEvidenceRef = released.trace_event.evidence_refs.find(
    (reference) => reference.path === claimProjectPath,
  );
  assert.ok(releasedEvidenceRef);
  assert.notEqual(releasedEvidenceRef.sha256, claimedEvidenceRef.sha256);
  const releasedSnapshotTrace = JSON.parse(mustRun([
    "trace", "append", "--root", project,
    "--story", "ST-CLAIM-TRACE",
    "--type", "sync",
    "--summary", "Verify the released claim evidence snapshot",
    "--evidence", claimProjectPath,
    "--json",
  ]).stdout).event;
  assert.equal(
    releasedSnapshotTrace.evidence_refs.find(
      (reference) => reference.path === claimProjectPath,
    ).sha256,
    releasedEvidenceRef.sha256,
  );
});

test("story acceptance add preserves stale requirement refs, is idempotent, and refuses in-flight or terminal stories", () => {
  const project = tmpProject("story-acceptance-boundaries");
  initProject(project);
  mustRun([
    "requirement", "propose", "--root", project,
    "--id", "REQ-BOUNDARY", "--title", "Acceptance recovery boundary",
    "--summary", "Preserve the exact reviewed requirement binding",
    "--acceptance", "The story keeps its reviewed requirement revision",
    "--autonomy-ceiling", "checkpointed",
  ]);
  mustRun([
    "requirement", "approve", "--root", project, "--id", "REQ-BOUNDARY",
    ...humanApproval("Approve exact requirement binding"),
  ]);
  mustRun([
    "story", "create", "--root", project,
    "--id", "ST-BOUNDARY", "--title", "Acceptance recovery boundaries",
    "--requirement", "REQ-BOUNDARY",
  ]);
  const storyDir = path.join(project, ".sdlc", "stories", "ST-BOUNDARY");
  const storyPath = path.join(storyDir, "story.json");
  const requirementPath = path.join(project, ".sdlc", "requirements", "REQ-BOUNDARY.json");
  const initialStory = readJson(storyPath);
  const exactRequirementRefs = structuredClone(initialStory.requirement_refs);
  const changedRequirement = readJson(requirementPath);
  changedRequirement.summary = "Unapproved changed requirement content";
  changedRequirement.updated_at = new Date().toISOString();
  writeJson(requirementPath, changedRequirement);

  const updated = JSON.parse(mustRun([
    "story", "acceptance", "add", "--root", project,
    "--id", "ST-BOUNDARY",
    "--acceptance", "A recovered criterion is observable",
    "--json",
  ]).stdout);
  assert.deepEqual(updated.story.requirement_refs, exactRequirementRefs);
  assert.equal(updated.downstream_review_required, false);

  const afterUpdate = fs.readFileSync(storyPath);
  const unchanged = JSON.parse(mustRun([
    "story", "acceptance", "add", "--root", project,
    "--id", "ST-BOUNDARY",
    "--acceptance", "A recovered criterion is observable",
    "--json",
  ]).stdout);
  assert.equal(unchanged.status, "unchanged");
  assert.deepEqual(fs.readFileSync(storyPath), afterUpdate);

  writeJson(path.join(storyDir, "task-start.json"), { status: "confirmed" });
  mustFail([
    "story", "acceptance", "add", "--root", project,
    "--id", "ST-BOUNDARY",
    "--acceptance", "Must not change in flight",
  ], /already has a task-start receipt/i);
  assert.deepEqual(fs.readFileSync(storyPath), afterUpdate);

  const terminalStory = readJson(storyPath);
  terminalStory.status = "done";
  writeJson(storyPath, terminalStory);
  fs.rmSync(path.join(storyDir, "task-start.json"));
  const terminalBytes = fs.readFileSync(storyPath);
  mustFail([
    "story", "acceptance", "add", "--root", project,
    "--id", "ST-BOUNDARY",
    "--acceptance", "Must not change after completion",
  ], /terminal.*immutable/i);
  assert.deepEqual(fs.readFileSync(storyPath), terminalBytes);
});

test("story creation refuses an orphaned workspace without overwriting its files", () => {
  const project = tmpProject("story-orphan-workspace");
  initProject(project);
  const storyDir = path.join(project, ".sdlc", "stories", "ST-ORPHAN");
  fs.mkdirSync(storyDir, { recursive: true });
  const planPath = path.join(storyDir, "plan.md");
  const logPath = path.join(storyDir, "implementation-log.md");
  fs.writeFileSync(planPath, "# Existing plan\n");
  fs.writeFileSync(logPath, "# Existing log\n");
  mustFail([
    "story", "create", "--root", project,
    "--id", "ST-ORPHAN", "--title", "Do not overwrite orphan",
    "--acceptance", "Existing work remains intact",
  ], /exists without story\.json.*refusing to overwrite/i);
  assert.equal(fs.readFileSync(planPath, "utf8"), "# Existing plan\n");
  assert.equal(fs.readFileSync(logPath, "utf8"), "# Existing log\n");
  assert.equal(fs.existsSync(path.join(storyDir, "story.json")), false);
});

test("story acceptance add rejects symlinked workspace files before rewriting story state", (t) => {
  if (!requireSymlinkSupport(t, "file")) return;
  const project = tmpProject("story-acceptance-symlink");
  initProject(project);
  mustRun([
    "story", "create", "--root", project,
    "--id", "ST-SYMLINK", "--title", "Reject unsafe workspace",
    "--acceptance", "The workspace remains canonical",
  ]);
  const storyDir = path.join(project, ".sdlc", "stories", "ST-SYMLINK");
  const storyPath = path.join(storyDir, "story.json");
  const planPath = path.join(storyDir, "plan.md");
  const externalPlan = path.join(project, "external-plan.md");
  fs.writeFileSync(externalPlan, "# External plan\n");
  fs.rmSync(planPath);
  fs.symlinkSync(externalPlan, planPath);
  const before = fs.readFileSync(storyPath);
  mustFail([
    "story", "acceptance", "add", "--root", project,
    "--id", "ST-SYMLINK", "--acceptance", "Must fail before mutation",
  ], /symbolic link|symlink|regular file/i);
  assert.deepEqual(fs.readFileSync(storyPath), before);
  assert.equal(fs.lstatSync(planPath).isSymbolicLink(), true);
});

test("story acceptance add leaves story bytes unchanged when its audit trace is unsafe", (t) => {
  if (!requireSymlinkSupport(t, "file")) return;
  const project = tmpProject("story-acceptance-trace-rollback");
  initProject(project);
  mustRun([
    "story", "create", "--root", project,
    "--id", "ST-TRACE", "--title", "Trace-bound acceptance recovery",
  ]);
  const storyPath = path.join(project, ".sdlc", "stories", "ST-TRACE", "story.json");
  const tracePath = path.join(project, ".sdlc", "traces", "ST-TRACE.jsonl");
  const externalTrace = path.join(project, "external-trace.jsonl");
  fs.writeFileSync(externalTrace, "");
  fs.symlinkSync(externalTrace, tracePath);
  const before = fs.readFileSync(storyPath);
  mustFail([
    "story", "acceptance", "add", "--root", project,
    "--id", "ST-TRACE", "--acceptance", "The update and its audit event commit together",
  ], /symbolic link|symlink|trace integrity/i);
  assert.deepEqual(fs.readFileSync(storyPath), before);
  assert.equal(readJson(storyPath).acceptance_criteria.length, 0);
});

test("story acceptance add refuses legacy stories with completed work but no task-start receipt", () => {
  const project = tmpProject("story-acceptance-legacy-in-flight");
  initProject(project);
  mustRun([
    "story", "create", "--root", project,
    "--id", "ST-LEGACY", "--title", "Legacy in-flight story",
  ]);
  const storyDir = path.join(project, ".sdlc", "stories", "ST-LEGACY");
  const stepsDir = path.join(storyDir, "steps");
  fs.mkdirSync(stepsDir, { recursive: true });
  writeJson(path.join(stepsDir, "design.json"), {
    id: "STEP-ST-LEGACY-DESIGN",
    story_id: "ST-LEGACY",
    step: "design",
    phase: "design",
    status: "completed",
    completed_at: new Date().toISOString(),
  });
  const before = fs.readFileSync(path.join(storyDir, "story.json"));
  mustFail([
    "story", "acceptance", "add", "--root", project,
    "--id", "ST-LEGACY", "--acceptance", "Late scope must be rejected",
  ], /completed lifecycle work.*cannot change in-flight/i);
  assert.deepEqual(fs.readFileSync(path.join(storyDir, "story.json")), before);
});

test("concurrent story acceptance additions are serialized without lost updates", async () => {
  const project = tmpProject("story-acceptance-concurrency");
  initProject(project);
  mustRun([
    "story", "create", "--root", project,
    "--id", "ST-CONCURRENT", "--title", "Serialize acceptance recovery",
    "--acceptance", "Base criterion",
  ]);
  const criteria = Array.from({ length: 12 }, (_, index) => `Concurrent criterion ${index + 1}`);
  const results = await Promise.all(criteria.map((criterion) => runAsync([
    "story", "acceptance", "add", "--root", project,
    "--id", "ST-CONCURRENT", "--acceptance", criterion, "--json",
  ], { timeout: 60_000 })));
  // The property under test is that no update is lost, not that every writer
  // wins. `acquireFileLock` is bounded: a writer that cannot take the story
  // lock within its wait is refused by design, and a slow runner makes that
  // outcome reachable. A refusal is accepted only when it carries exactly the
  // bounded-contention message, so a semantic failure still fails the test.
  const accepted = [];
  for (const [index, result] of results.entries()) {
    assert.equal(result.signal, null, `${result.stdout}\n${result.stderr}`);
    if (result.status === 0) {
      accepted.push(criteria[index]);
      continue;
    }
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const failure = JSON.parse(result.stderr.trim() || result.stdout.trim());
    assert.equal(failure.schema_version, "agentic-sdlc-cli-error:v1");
    const message = failure.error?.message || "";
    assert.match(
      message,
      /^(?:Resource is locked by another SDLC operation|Cannot acquire internal lock after transient Windows file-system contention): /u,
      `Unexpected concurrent acceptance failure: ${message}`,
    );
  }
  assert.ok(accepted.length > 0, "every concurrent writer was refused");

  const storyRecord = readJson(path.join(
    project,
    ".sdlc",
    "stories",
    "ST-CONCURRENT",
    "story.json",
  ));
  // Exactly the writers that reported success are recorded: none lost, none
  // duplicated, and none written by a writer that was refused.
  assert.deepEqual(
    new Set(storyRecord.acceptance_criteria),
    new Set(["Base criterion", ...accepted]),
  );
  assert.equal(storyRecord.acceptance_criteria.length, accepted.length + 1);
});

test("acceptance changes block task start until a new exact contract is created and approved", () => {
  const project = tmpProject("story-acceptance-contract-review");
  initProject(project);
  story(project, "ST-CONTRACT-REVIEW");
  createApprovedTemplate(project, "functional-analysis");
  createApprovedStoryContract(project, "ST-CONTRACT-REVIEW", "design", "functional-analysis");

  const recovery = JSON.parse(mustRun([
    "story", "acceptance", "add", "--root", project,
    "--id", "ST-CONTRACT-REVIEW",
    "--acceptance", "The additional success condition is covered by a new work brief",
    "--json",
  ]).stdout);
  assert.equal(recovery.contract_review_required, true);
  assert.equal(recovery.previous_contract_id, "contract-ST-CONTRACT-REVIEW-design");
  const markedStory = readJson(path.join(
    project,
    ".sdlc",
    "stories",
    "ST-CONTRACT-REVIEW",
    "story.json",
  ));
  assert.equal(
    markedStory.contract_review_required.contract_id,
    "contract-ST-CONTRACT-REVIEW-design",
  );
  const claimPath = path.join(
    project,
    ".sdlc",
    "stories",
    "ST-CONTRACT-REVIEW",
    "claim.json",
  );
  const blockedClaim = mustFail([
    "story", "claim", "--root", project,
    "--id", "ST-CONTRACT-REVIEW",
    "--agent", "codex",
  ], /acceptance criteria changed after its previous contract.*cannot be claimed/is);
  const blockedClaimGuidance = splitHumanGuidance(blockedClaim.stderr, "en");
  assert.match(blockedClaimGuidance.primary, /cannot be assigned.*success criteria changed/is);
  assert.match(blockedClaimGuidance.primary, /Prepare and approve the new agreement/is);
  assert.equal(fs.existsSync(claimPath), false);
  const staleArtifact = writeArtifact(
    project,
    ".sdlc/requirements/ST-CONTRACT-REVIEW-functional-analysis.md",
  );
  mustFail([
    "output", "link", "--root", project,
    "--story", "ST-CONTRACT-REVIEW",
    "--type", "functional-analysis",
    "--artifact", staleArtifact,
    "--template", "functional-analysis-v1",
    "--mode", "new",
    "--requirement", "REQ-001",
  ], /acceptance criteria changed.*new exact contract ID/is);
  mustFail([
    "story", "complete-step", "--root", project,
    "--id", "ST-CONTRACT-REVIEW",
    "--step", "functional-analysis",
    "--type", "functional-analysis",
    "--summary", "Must not use the stale contract",
  ], /acceptance criteria changed.*new exact contract ID/is);
  const staleGate = JSON.parse(run([
    "gate", "check", "--root", project,
    "--story", "ST-CONTRACT-REVIEW",
    "--strict", "--json",
  ]).stdout);
  assert.ok(staleGate.errors.some((error) =>
    /acceptance criteria changed.*new exact contract ID/is.test(error)));
  mustFail([
    "contract", "create", "--root", project,
    "--phase", "design",
    "--story", "ST-CONTRACT-REVIEW",
    "--id", "contract-ST-CONTRACT-REVIEW-design",
    "--force",
    "--context-summary", "Do not overwrite the historical agreement",
    "--qa", "Can the old ID be reused?|No",
    "--output-ref", "functional-analysis:functional-analysis-v1:new",
  ], /historical and cannot be overwritten.*new exact contract ID/is);

  const blocked = JSON.parse(mustRun([
    "task", "start", "--root", project, "--json",
    "--story", "ST-CONTRACT-REVIEW",
    "--contract-id", "contract-ST-CONTRACT-REVIEW-design",
    "--intent-json", routeIntent({
      requested_action: "implement_story",
      referenced_entities: [{ type: "story", id: "ST-CONTRACT-REVIEW" }],
      proposed_phase: "design",
    }),
    "--confirm-start",
  ]).stdout);
  assert.equal(blocked.execution_allowed, false);
  assert.equal(blocked.contract_action, "replace_contract_after_story_revision");
  assert.ok(blocked.blocking_reasons.includes("story_definition_changed_after_contract"));
  assert.equal(fs.existsSync(path.join(
    project,
    ".sdlc",
    "stories",
    "ST-CONTRACT-REVIEW",
    "task-start.json",
  )), false);
  const blockedHumanArgs = [
    "task", "start", "--root", project,
    "--story", "ST-CONTRACT-REVIEW",
    "--contract-id", "contract-ST-CONTRACT-REVIEW-design",
    "--intent-json", routeIntent({
      requested_action: "implement_story",
      referenced_entities: [{ type: "story", id: "ST-CONTRACT-REVIEW" }],
      proposed_phase: "design",
    }),
    "--confirm-start",
  ];
  const blockedEnglish = mustRun(blockedHumanArgs).stdout;
  const blockedEnglishGuidance = splitHumanGuidance(blockedEnglish, "en");
  assert.match(blockedEnglishGuidance.primary, /success criteria changed.*work remains paused/is);
  assert.match(blockedEnglishGuidance.primary, /prepare a new agreement.*approval before starting/is);
  assert.equal(
    (blockedEnglish.match(/Question 1:/gu) || []).length,
    1,
  );
  assert.equal(
    (blockedEnglish.match(
      /agentic-sdlc contract create --story ST-CONTRACT-REVIEW --phase design/gu,
    ) || []).length,
    1,
  );
  const blockedItalian = mustRun([...blockedHumanArgs, "--locale", "it"]).stdout;
  const blockedItalianGuidance = splitHumanGuidance(blockedItalian, "it");
  assert.match(blockedItalianGuidance.primary, /criteri di riuscita sono cambiati.*lavoro resta fermo/is);
  assert.match(blockedItalianGuidance.primary, /nuovo accordo.*approvazione prima di iniziare/is);
  assert.equal(
    (blockedItalian.match(/Domanda 1:/gu) || []).length,
    1,
  );
  assert.equal(
    (blockedItalian.match(
      /agentic-sdlc contract create --story ST-CONTRACT-REVIEW --phase design/gu,
    ) || []).length,
    1,
  );

  mustRun([
    "contract", "create", "--root", project,
    "--phase", "design",
    "--story", "ST-CONTRACT-REVIEW",
    "--id", "contract-ST-CONTRACT-REVIEW-design-v2",
    "--replace-story-contract",
    "--context-summary", "Cover the revised acceptance criteria",
    "--qa", "Do the new success conditions belong to this work?|Yes",
    "--output-ref", "functional-analysis:functional-analysis-v1:new",
  ]);
  mustRun([
    "contract", "approve", "--root", project,
    "--id", "contract-ST-CONTRACT-REVIEW-design-v2",
    ...humanApproval("Approve the revised exact work brief"),
  ]);
  const refreshedStory = readJson(path.join(
    project,
    ".sdlc",
    "stories",
    "ST-CONTRACT-REVIEW",
    "story.json",
  ));
  assert.equal(refreshedStory.contract_id, "contract-ST-CONTRACT-REVIEW-design-v2");
  assert.equal(Object.hasOwn(refreshedStory, "contract_review_required"), false);

  const startArgs = [
    "task", "start", "--root", project, "--json",
    "--story", "ST-CONTRACT-REVIEW",
    "--intent-json", routeIntent({
      requested_action: "implement_story",
      referenced_entities: [{ type: "story", id: "ST-CONTRACT-REVIEW" }],
      proposed_phase: "design",
    }),
    "--confirm-start",
    "--actor-type", "human",
  ];
  const historical = JSON.parse(mustRun([
    ...startArgs,
    "--contract-id", "contract-ST-CONTRACT-REVIEW-design",
  ]).stdout);
  assert.equal(historical.execution_allowed, false);
  assert.ok(historical.blocking_reasons.includes("contract_not_current_story_binding"));
  assert.equal(fs.existsSync(path.join(
    project,
    ".sdlc",
    "stories",
    "ST-CONTRACT-REVIEW",
    "task-start.json",
  )), false);

  const started = JSON.parse(mustRun(startArgs).stdout);
  assert.equal(started.execution_allowed, true);
  assert.equal(started.contract_id, "contract-ST-CONTRACT-REVIEW-design-v2");
  const taskStartPath = path.join(
    project,
    ".sdlc",
    "stories",
    "ST-CONTRACT-REVIEW",
    "task-start.json",
  );
  const taskStartBytes = fs.readFileSync(taskStartPath);
  const tracePath = path.join(project, ".sdlc", "traces", "ST-CONTRACT-REVIEW.jsonl");
  const startTraceCount = readJsonLines(tracePath)
    .filter((event) => event.action === "task.start.confirm").length;
  mustFail(startArgs, /already immutably recorded.*continue the existing governed run/is);
  assert.deepEqual(fs.readFileSync(taskStartPath), taskStartBytes);
  assert.equal(
    readJsonLines(tracePath).filter((event) => event.action === "task.start.confirm").length,
    startTraceCount,
  );

  const currentContractPath = path.join(
    project,
    ".sdlc",
    "contracts",
    "contract-ST-CONTRACT-REVIEW-design-v2.json",
  );
  const currentContractBytes = fs.readFileSync(currentContractPath);
  mustFail([
    "contract", "approve", "--root", project,
    "--id", "contract-ST-CONTRACT-REVIEW-design-v2",
    "--status", "rejected",
    ...humanApproval("Do not mutate an in-flight contract"),
  ], /cannot receive another approval or status change after story.*has started/is);
  assert.deepEqual(fs.readFileSync(currentContractPath), currentContractBytes);
});

test("story acceptance recovery human guidance stays plain, direct, and localized", () => {
  const project = tmpProject("story-acceptance-human-guidance");
  initProject(project);
  story(project, "ST-RECOVERY-UX");
  createApprovedTemplate(project, "functional-analysis");
  createApprovedStoryContract(project, "ST-RECOVERY-UX", "design", "functional-analysis");

  const english = mustRun([
    "story", "acceptance", "add", "--root", project,
    "--id", "ST-RECOVERY-UX",
    "--acceptance", "A second observable result is reviewed",
  ]).stdout;
  const englishGuidance = splitHumanGuidance(english, "en");
  assert.match(englishGuidance.primary, /previous work agreement.*no longer authorize work/is);
  assert.equal((english.match(/^Outcome:/gmu) || []).length, 1);
  assert.match(englishGuidance.technical, /ST-RECOVERY-UX/u);

  const italian = mustRun([
    "story", "acceptance", "add", "--root", project,
    "--id", "ST-RECOVERY-UX",
    "--acceptance", "Un terzo risultato osservabile viene verificato",
    "--locale", "it",
  ]).stdout;
  const italianGuidance = splitHumanGuidance(italian, "it");
  assert.match(italianGuidance.primary, /precedente accordo di lavoro.*non autorizzano più l’avvio/is);
  assert.equal((italian.match(/^Risultato:/gmu) || []).length, 1);

  const unchanged = mustRun([
    "story", "acceptance", "add", "--root", project,
    "--id", "ST-RECOVERY-UX",
    "--acceptance", "Un terzo risultato osservabile viene verificato",
    "--locale", "it",
  ]).stdout;
  const unchangedGuidance = splitHumanGuidance(unchanged, "it");
  assert.match(unchangedGuidance.primary, /conteneva già tutti i criteri/is);
  assert.match(unchangedGuidance.primary, /nuovo accordo di lavoro/is);
  assert.equal((unchanged.match(/^Risultato:/gmu) || []).length, 1);
});

test("contract replacement restores the exact story and contract state when its audit trace is unsafe", (t) => {
  if (!requireSymlinkSupport(t, "file")) return;
  const project = tmpProject("contract-replacement-trace-transaction");
  initProject(project);
  story(project, "ST-CONTRACT-TRACE");
  createApprovedTemplate(project, "functional-analysis");
  createApprovedStoryContract(project, "ST-CONTRACT-TRACE", "design", "functional-analysis");
  mustRun([
    "story", "acceptance", "add", "--root", project,
    "--id", "ST-CONTRACT-TRACE",
    "--acceptance", "The replacement agreement and its audit event commit together",
  ]);

  const storyPath = path.join(project, ".sdlc", "stories", "ST-CONTRACT-TRACE", "story.json");
  const beforeStory = fs.readFileSync(storyPath);
  const newContractPath = path.join(
    project,
    ".sdlc",
    "contracts",
    "contract-ST-CONTRACT-TRACE-design-v2.json",
  );
  const tracePath = path.join(project, ".sdlc", "traces", "ST-CONTRACT-TRACE.jsonl");
  const externalTrace = path.join(project, "external-contract-trace.jsonl");
  fs.rmSync(tracePath);
  fs.writeFileSync(externalTrace, "");
  fs.symlinkSync(externalTrace, tracePath);

  mustFail([
    "contract", "create", "--root", project,
    "--phase", "design",
    "--story", "ST-CONTRACT-TRACE",
    "--id", "contract-ST-CONTRACT-TRACE-design-v2",
    "--replace-story-contract",
    "--context-summary", "This replacement must be atomically audited",
    "--qa", "Does the revised agreement cover the story?|Yes",
    "--output-ref", "functional-analysis:functional-analysis-v1:new",
  ], /symbolic link|symlink|trace integrity/i);
  assert.deepEqual(fs.readFileSync(storyPath), beforeStory);
  assert.equal(fs.existsSync(newContractPath), false);
  const preserved = readJson(storyPath);
  assert.equal(preserved.contract_id, "contract-ST-CONTRACT-TRACE-design");
  assert.equal(preserved.contract_review_required.contract_id, "contract-ST-CONTRACT-TRACE-design");
});

test("contract approval restores exact draft bytes when its audit trace is unsafe", (t) => {
  if (!requireSymlinkSupport(t, "file")) return;
  const project = tmpProject("contract-approval-trace-transaction");
  initProject(project);
  story(project, "ST-APPROVAL-TRACE");
  createApprovedTemplate(project, "functional-analysis");
  mustRun([
    "contract", "create", "--root", project,
    "--phase", "design",
    "--story", "ST-APPROVAL-TRACE",
    "--id", "contract-ST-APPROVAL-TRACE-design",
    "--context-summary", "Approval and audit must commit together",
    "--qa", "Who approves this exact draft?|The owner",
    "--output-ref", "functional-analysis:functional-analysis-v1:new",
  ]);
  const contractPath = path.join(
    project,
    ".sdlc",
    "contracts",
    "contract-ST-APPROVAL-TRACE-design.json",
  );
  const beforeContract = fs.readFileSync(contractPath);
  const tracePath = path.join(project, ".sdlc", "traces", "ST-APPROVAL-TRACE.jsonl");
  const externalTrace = path.join(project, "external-approval-trace.jsonl");
  fs.rmSync(tracePath);
  fs.writeFileSync(externalTrace, "");
  fs.symlinkSync(externalTrace, tracePath);

  mustFail([
    "contract", "approve", "--root", project,
    "--id", "contract-ST-APPROVAL-TRACE-design",
    ...humanApproval("Approve only with a durable audit event"),
  ], /symbolic link|symlink|trace integrity/i);
  assert.deepEqual(fs.readFileSync(contractPath), beforeContract);
  assert.equal(readJson(contractPath).status, "draft");
  assert.equal((readJson(contractPath).approvals || []).length, 0);
});

test("contract IDs cannot be reassigned across stories or overwrite reviewed history", () => {
  const project = tmpProject("contract-id-ownership");
  initProject(project);
  story(project, "ST-CONTRACT-OWNER-A");
  story(project, "ST-CONTRACT-OWNER-B");
  createApprovedTemplate(project, "functional-analysis");
  mustRun([
    "contract", "create", "--root", project,
    "--phase", "design",
    "--story", "ST-CONTRACT-OWNER-A",
    "--id", "CONTRACT-SHARED",
    "--context-summary", "The agreement belongs only to story A",
    "--qa", "Which story owns this agreement?|Story A",
    "--output-ref", "functional-analysis:functional-analysis-v1:new",
  ]);
  const contractPath = path.join(project, ".sdlc", "contracts", "CONTRACT-SHARED.json");
  const storyAPath = path.join(project, ".sdlc", "stories", "ST-CONTRACT-OWNER-A", "story.json");
  const storyBPath = path.join(project, ".sdlc", "stories", "ST-CONTRACT-OWNER-B", "story.json");
  const draftBytes = fs.readFileSync(contractPath);
  const storyABytes = fs.readFileSync(storyAPath);
  const storyBBytes = fs.readFileSync(storyBPath);

  mustFail([
    "contract", "create", "--root", project,
    "--phase", "design",
    "--story", "ST-CONTRACT-OWNER-B",
    "--id", "CONTRACT-SHARED",
    "--force",
    "--context-summary", "This must not steal the existing contract ID",
    "--qa", "May story B reuse story A's ID?|No",
    "--output-ref", "functional-analysis:functional-analysis-v1:new",
  ], /already bound to ST-CONTRACT-OWNER-A.*cannot be reassigned.*new contract ID/is);
  assert.deepEqual(fs.readFileSync(contractPath), draftBytes);
  assert.deepEqual(fs.readFileSync(storyAPath), storyABytes);
  assert.deepEqual(fs.readFileSync(storyBPath), storyBBytes);

  mustRun([
    "contract", "approve", "--root", project,
    "--id", "CONTRACT-SHARED",
    ...humanApproval("Approve story A's exact agreement"),
  ]);
  const approvedBytes = fs.readFileSync(contractPath);
  mustFail([
    "contract", "create", "--root", project,
    "--phase", "design",
    "--story", "ST-CONTRACT-OWNER-A",
    "--id", "CONTRACT-SHARED",
    "--force",
    "--context-summary", "This must not erase reviewed history",
    "--qa", "May reviewed content be overwritten?|No",
    "--output-ref", "functional-analysis:functional-analysis-v1:new",
  ], /already reviewed or no longer a draft.*new exact contract ID/is);
  assert.deepEqual(fs.readFileSync(contractPath), approvedBytes);
});

test("phase output and step completion require task start and roll back when trace sealing fails", (t) => {
  if (!requireSymlinkSupport(t, "file")) return;
  const outputProject = tmpProject("phase-output-start-trace");
  initProject(outputProject);
  story(outputProject, "ST-OUTPUT-TX", ["--phase", "design", "--status", "ready"]);
  createApprovedTemplate(outputProject, "functional-analysis");
  createApprovedStoryContract(outputProject, "ST-OUTPUT-TX", "design", "functional-analysis");
  const outputArtifact = writeArtifact(
    outputProject,
    ".sdlc/requirements/ST-OUTPUT-TX-functional-analysis.md",
  );
  const outputArgs = [
    "output", "link", "--root", outputProject,
    "--story", "ST-OUTPUT-TX",
    "--type", "functional-analysis",
    "--artifact", outputArtifact,
    "--template", "functional-analysis-v1",
    "--mode", "new",
    "--requirement", "REQ-001",
  ];
  const registryPath = path.join(outputProject, ".sdlc", "output-contracts", "registry.json");
  const registryBeforeStart = fs.readFileSync(registryPath);
  mustFail(outputArgs, /no task-start receipt.*task start --confirm-start/is);
  mustFail([
    "story", "complete-step", "--root", outputProject,
    "--id", "ST-OUTPUT-TX",
    "--step", "functional-analysis",
    "--type", "functional-analysis",
    "--summary", "Must not complete before task start",
  ], /no task-start receipt.*task start --confirm-start/is);
  assert.deepEqual(fs.readFileSync(registryPath), registryBeforeStart);
  assert.equal(fs.existsSync(path.join(
    outputProject,
    ".sdlc",
    "stories",
    "ST-OUTPUT-TX",
    "steps",
  )), false);

  mustRun([
    "task", "start", "--root", outputProject,
    "--story", "ST-OUTPUT-TX",
    "--intent-json", routeIntent({
      requested_action: "implement_story",
      referenced_entities: [{ type: "story", id: "ST-OUTPUT-TX" }],
      proposed_phase: "design",
    }),
    "--confirm-start",
    "--actor-type", "human",
  ]);
  const registryBeforeUnsafeTrace = fs.readFileSync(registryPath);
  const verificationRoot = path.join(outputProject, ".sdlc", "receipts", "verification");
  const verificationBefore = fs.existsSync(verificationRoot)
    ? snapshotFilesystemTree(verificationRoot)
    : [];
  const outputTracePath = path.join(outputProject, ".sdlc", "traces", "ST-OUTPUT-TX.jsonl");
  const externalOutputTrace = path.join(outputProject, "external-output-trace.jsonl");
  fs.rmSync(outputTracePath);
  fs.writeFileSync(externalOutputTrace, "");
  fs.symlinkSync(externalOutputTrace, outputTracePath);
  mustFail(outputArgs, /symbolic link|symlink|trace integrity/i);
  assert.deepEqual(fs.readFileSync(registryPath), registryBeforeUnsafeTrace);
  assert.deepEqual(
    fs.existsSync(verificationRoot) ? snapshotFilesystemTree(verificationRoot) : [],
    verificationBefore,
  );

  const stepProject = tmpProject("phase-step-start-trace");
  initProject(stepProject);
  story(stepProject, "ST-STEP-TX", ["--phase", "design", "--status", "ready"]);
  createApprovedTemplate(stepProject, "functional-analysis");
  createApprovedStoryContract(stepProject, "ST-STEP-TX", "design", "functional-analysis");
  const stepArtifact = writeArtifact(
    stepProject,
    ".sdlc/requirements/ST-STEP-TX-functional-analysis.md",
  );
  mustRun([
    "task", "start", "--root", stepProject,
    "--story", "ST-STEP-TX",
    "--intent-json", routeIntent({
      requested_action: "implement_story",
      referenced_entities: [{ type: "story", id: "ST-STEP-TX" }],
      proposed_phase: "design",
    }),
    "--confirm-start",
    "--actor-type", "human",
  ]);
  mustRun([
    "output", "link", "--root", stepProject,
    "--story", "ST-STEP-TX",
    "--type", "functional-analysis",
    "--artifact", stepArtifact,
    "--template", "functional-analysis-v1",
    "--mode", "new",
    "--requirement", "REQ-001",
  ]);
  mustRun([
    "story", "claim", "--root", stepProject,
    "--id", "ST-STEP-TX",
    "--agent", "analysis-agent",
    "--branch", "feature/ST-STEP-TX",
  ]);
  const stepDir = path.join(stepProject, ".sdlc", "stories", "ST-STEP-TX", "steps");
  const stepPath = path.join(stepDir, "functional-analysis.json");
  const historyPath = path.join(stepDir, "history.jsonl");
  const stepTracePath = path.join(stepProject, ".sdlc", "traces", "ST-STEP-TX.jsonl");
  const externalStepTrace = path.join(stepProject, "external-step-trace.jsonl");
  fs.rmSync(stepTracePath);
  fs.writeFileSync(externalStepTrace, "");
  fs.symlinkSync(externalStepTrace, stepTracePath);
  mustFail([
    "story", "complete-step", "--root", stepProject,
    "--id", "ST-STEP-TX",
    "--step", "functional-analysis",
    "--type", "functional-analysis",
    "--summary", "The step and trace must commit together",
    "--artifact", stepArtifact,
  ], /symbolic link|symlink|trace integrity/i);
  assert.equal(fs.existsSync(stepPath), false);
  assert.equal(fs.existsSync(historyPath), false);
});

test("story acceptance recovery refuses legacy stories that already have work traces", () => {
  const project = tmpProject("story-acceptance-legacy-trace");
  initProject(project);
  story(project, "ST-LEGACY-TRACE", ["--phase", "implementation", "--status", "ready"]);
  mustRun([
    "trace", "append", "--root", project,
    "--story", "ST-LEGACY-TRACE",
    "--type", "implementation",
    "--summary", "Implementation work already happened",
    "--outcome", "passed",
  ]);
  const storyPath = path.join(project, ".sdlc", "stories", "ST-LEGACY-TRACE", "story.json");
  const before = fs.readFileSync(storyPath);
  mustFail([
    "story", "acceptance", "add", "--root", project,
    "--id", "ST-LEGACY-TRACE",
    "--acceptance", "Late success criteria must not redefine completed work",
  ], /already has governed work trace.*cannot change in-flight/is);
  assert.deepEqual(fs.readFileSync(storyPath), before);
});

test("task start does not persist a receipt when its confirmation trace is unsafe", (t) => {
  if (!requireSymlinkSupport(t, "file")) return;
  const project = tmpProject("task-start-trace-transaction");
  initProject(project);
  story(project, "ST-START-TRACE");
  createApprovedTemplate(project, "implementation-summary");
  mustRun([
    "contract", "create", "--root", project,
    "--phase", "implementation",
    "--story", "ST-START-TRACE",
    "--id", "contract-ST-START-TRACE-implementation",
    "--context-summary", "Start only with an auditable receipt",
    "--qa", "Who confirms start?|Human user",
    "--output-ref", "implementation-summary:implementation-summary-v1:new",
  ]);
  mustRun([
    "contract", "approve", "--root", project,
    "--id", "contract-ST-START-TRACE-implementation",
    ...humanApproval("Approve trace-bound task start"),
  ]);
  const storyPath = path.join(project, ".sdlc", "stories", "ST-START-TRACE", "story.json");
  writeJson(storyPath, {
    ...readJson(storyPath),
    status: "ready",
    phase: "implementation",
  });
  const tracePath = path.join(project, ".sdlc", "traces", "ST-START-TRACE.jsonl");
  const externalTrace = path.join(project, "external-start-trace.jsonl");
  fs.rmSync(tracePath);
  fs.writeFileSync(externalTrace, "");
  fs.symlinkSync(externalTrace, tracePath);
  mustFail([
    "task", "start", "--root", project,
    "--story", "ST-START-TRACE",
    "--contract-id", "contract-ST-START-TRACE-implementation",
    "--intent-json", routeIntent({
      requested_action: "implement_story",
      referenced_entities: [{ type: "story", id: "ST-START-TRACE" }],
      proposed_phase: "implementation",
    }),
    "--confirm-start",
    "--actor-type", "human",
  ], /symbolic link|symlink|trace integrity/i);
  assert.equal(fs.existsSync(path.join(
    project,
    ".sdlc",
    "stories",
    "ST-START-TRACE",
    "task-start.json",
  )), false);
});

test("task start serializes contract replacement and keeps one exact story-contract receipt", async () => {
  const project = tmpProject("task-start-contract-race");
  initProject(project);
  story(project, "ST-START-RACE");
  createApprovedTemplate(project, "implementation-summary");
  mustRun([
    "contract", "create", "--root", project,
    "--phase", "implementation",
    "--story", "ST-START-RACE",
    "--id", "contract-ST-START-RACE-v1",
    "--context-summary", "Use the first exact approved work brief",
    "--qa", "Who confirms start?|Human user",
    "--output-ref", "implementation-summary:implementation-summary-v1:new",
  ]);
  mustRun([
    "contract", "approve", "--root", project,
    "--id", "contract-ST-START-RACE-v1",
    ...humanApproval("Approve the first exact work brief"),
  ]);
  const storyPath = path.join(project, ".sdlc", "stories", "ST-START-RACE", "story.json");
  writeJson(storyPath, {
    ...readJson(storyPath),
    status: "ready",
    phase: "implementation",
  });
  const heldTraceLock = path.join(project, ".sdlc", "traces", "ST-START-RACE.jsonl.lock");
  writeJson(heldTraceLock, {
    pid: process.pid,
    host: os.hostname(),
    nonce: "held-task-start-race-trace",
    created_at: new Date().toISOString(),
  });
  const startPromise = runAsync([
    "task", "start", "--root", project,
    "--story", "ST-START-RACE",
    "--contract-id", "contract-ST-START-RACE-v1",
    "--intent-json", routeIntent({
      requested_action: "implement_story",
      referenced_entities: [{ type: "story", id: "ST-START-RACE" }],
      proposed_phase: "implementation",
    }),
    "--confirm-start",
    "--actor-type", "human",
    "--json",
  ], { timeout: 60_000 });
  let earlyStartResult = null;
  void startPromise.then((result) => {
    earlyStartResult = result;
  });
  const boundaryLock = path.join(
    project,
    ".sdlc",
    "stories",
    "ST-START-RACE",
    "task-start-boundary.lock",
  );
  for (
    let attempt = 0;
    attempt < 1_500
      && !fs.existsSync(boundaryLock)
      && earlyStartResult === null;
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(
    fs.existsSync(boundaryLock),
    true,
    earlyStartResult
      ? `task start exited before acquiring its boundary lock:\n${earlyStartResult.stdout}\n${earlyStartResult.stderr}`
      : "task start never acquired its boundary lock within 30 seconds",
  );
  const replacementPromise = runAsync([
    "contract", "create", "--root", project,
    "--phase", "implementation",
    "--story", "ST-START-RACE",
    "--id", "contract-ST-START-RACE-v2",
    "--replace-story-contract",
    "--context-summary", "A concurrent replacement must wait",
    "--qa", "May this replace an already-starting task?|No",
    "--output-ref", "implementation-summary:implementation-summary-v1:new",
  ], { timeout: 60_000 });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(
    fs.existsSync(path.join(project, ".sdlc", "contracts", "contract-ST-START-RACE-v2.json")),
    false,
  );
  fs.rmSync(heldTraceLock);
  const [started, replacement] = await Promise.all([startPromise, replacementPromise]);
  assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
  assert.notEqual(replacement.status, 0, "contract replacement unexpectedly raced past task start");
  assert.match(
    `${replacement.stdout}\n${replacement.stderr}`,
    /already has an immutable task-start boundary/i,
  );
  const receipt = readJson(path.join(
    project,
    ".sdlc",
    "stories",
    "ST-START-RACE",
    "task-start.json",
  ));
  assert.equal(receipt.contract_id, "contract-ST-START-RACE-v1");
  assert.equal(readJson(storyPath).contract_id, "contract-ST-START-RACE-v1");
});

test("strict gate fails when a story has no contract", () => {
  const project = tmpProject("missing-contract");
  initProject(project);
  story(project, "ST-001");
  const failedGate = mustFail(
    ["gate", "check", "--root", project, "--story", "ST-001", "--strict"],
    /has no contract_id/,
  );
  const failedGuidance = splitHumanGuidance(failedGate.stdout);
  assert.match(failedGuidance.firstLine, /^Outcome: The checks found .*blocking issue/i);
  assert.match(failedGuidance.primary, /What this changes in practice: .*No protected action was performed/u);
  assert.match(failedGuidance.primary, /What needs fixing:\n- This work item does not have a valid approved work brief/u);
  assert.match(failedGuidance.technical, /Scope checked:/u);
  assert.match(failedGuidance.technical, /has no contract_id/u);
  assert.match(failedGuidance.technical, /ST-001/u);

  const failedGateItalian = mustFail(
    ["gate", "check", "--root", project, "--story", "ST-001", "--strict", "--locale", "it"],
    /has no contract_id/,
  );
  const failedGuidanceItalian = splitHumanGuidance(failedGateItalian.stdout, "it");
  assert.match(failedGuidanceItalian.firstLine, /^Risultato: I controlli hanno trovato .*blocco/i);
  assert.match(failedGuidanceItalian.primary, /Cosa bisogna sistemare:\n- Questa attività non ha un incarico di lavoro valido e approvato/u);
  assert.match(failedGuidanceItalian.technical, /has no contract_id/u);
  assert.match(failedGuidanceItalian.technical, /ST-001/u);
});

test("story id mismatch and invalid branch pattern fail strict gate", () => {
  const project = tmpProject("story-claim");
  initProject(project);
  createStrictReadyStory(project, "ST-001");

  const storyPath = path.join(project, ".sdlc", "stories", "ST-001", "story.json");
  const originalStory = readJson(storyPath);
  writeJson(storyPath, { ...originalStory, id: "ST-999" });
  mustFail(["gate", "check", "--root", project, "--story", "ST-001", "--strict"], /must match its folder id/);
  writeJson(storyPath, originalStory);

  writeJson(storyPath, { ...originalStory, phase: "implementation", status: "implementation" });
  mustRun(["story", "claim", "--root", project, "--id", "ST-001", "--agent", "codex", "--branch", "nope"]);
  mustFail(["gate", "check", "--root", project, "--story", "ST-001", "--strict"], /does not match expected/);
  mustRun(["story", "release", "--root", project, "--id", "ST-001", "--agent", "codex"]);
  const defaultClaim = JSON.parse(mustRun([
    "story",
    "claim",
    "--root",
    project,
    "--id",
    "ST-001",
    "--agent",
    "codex",
    "--json",
  ]).stdout);
  assert.equal(defaultClaim.claim.branch, "codex/ST-001");
  const validBranchGate = run(["gate", "check", "--root", project, "--story", "ST-001", "--strict", "--json"]);
  const validBranchReport = JSON.parse(validBranchGate.stdout);
  assert.equal(validBranchReport.errors.some((error) => error.includes("claim branch")), false);
});

test("invalid statuses and invalid expiry values are rejected or gated", () => {
  const project = tmpProject("status-expiry");
  initProject(project);
  mustFail(["story", "create", "--root", project, "--id", "ST-001", "--title", "Bad", "--status", "banana"], /Unknown story status/);

  createStrictReadyStory(project, "ST-001");
  const storyPath = path.join(project, ".sdlc", "stories", "ST-001", "story.json");
  const validStory = readJson(storyPath);
  writeJson(storyPath, { ...validStory, phase: "implementation", status: "implementation" });
  writeJson(path.join(project, ".sdlc", "stories", "ST-001", "claim.json"), {
    story_id: "ST-001",
    agent: "codex",
    branch: "feature/ST-001",
    status: "active",
    claimed_at: new Date().toISOString(),
    expires_at: "not-a-date",
    audit: {},
  });
  mustFail(["gate", "check", "--root", project, "--story", "ST-001", "--strict"], /invalid expires_at/);
});

test("terminal stories cannot be claimed or scheduled and status counts story records", () => {
  const project = tmpProject("terminal-story-lifecycle");
  initProject(project);
  story(project, "ST-DONE");
  story(project, "ST-READY");

  const donePath = path.join(project, ".sdlc", "stories", "ST-DONE", "story.json");
  const doneStory = readJson(donePath);
  writeJson(donePath, { ...doneStory, status: "done", phase: "release" });
  const legacyReceiptSubject = {
    kind: "workflow_final_gate_receipt",
    schema_version: "workflow-final-gate-receipt:v1",
    status: "passed",
    strict: true,
    scope: "story",
    story_id: "ST-DONE",
    checked_at: new Date().toISOString(),
    errors: [],
    final_receipt_path: ".sdlc/gates/ST-DONE-final.json",
  };
  fs.mkdirSync(path.join(project, ".sdlc", "gates"), { recursive: true });
  writeJson(path.join(project, legacyReceiptSubject.final_receipt_path), {
    ...legacyReceiptSubject,
    hash_algorithm: "sha256:stable-json:v1",
    receipt_hash: computeStableHash(legacyReceiptSubject),
  });

  mustFail(
    ["story", "claim", "--root", project, "--id", "ST-DONE", "--agent", "codex"],
    /terminal status 'done'/,
  );
  mustFail(
    ["story", "claim", "--root", project, "--id", "ST-DONE", "--agent", "codex", "--force", "--actor-type", "human"],
    /terminal status 'done'/,
  );
  const orchestration = JSON.parse(mustRun(["orchestrate", "status", "--root", project, "--json"]).stdout);
  const terminal = orchestration.stories.find((item) => item.id === "ST-DONE");
  assert.equal(terminal.orchestration_state, "terminal");
  assert.equal(orchestration.summary.terminal, 1);

  const plan = JSON.parse(mustRun(["orchestrate", "plan", "--root", project, "--json"]).stdout);
  assert.equal(plan.candidates.some((candidate) => candidate.story_id === "ST-DONE"), false);
  assert.equal(plan.candidates.some((candidate) => candidate.story_id === "ST-READY"), true);

  const status = JSON.parse(mustRun(["status", "--root", project, "--json"]).stdout);
  assert.equal(status.counts.stories, 2);
  const statusGuidance = splitHumanGuidance(mustRun(["status", "--root", project]).stdout);
  assert.match(statusGuidance.primary, /What remains protected:/u);
  assert.match(statusGuidance.technical, /available_work: 1/u);
  assert.match(statusGuidance.technical, /completed_work: 1/u);
});

test("status starts the stock story workflow and routes custom phases to an exact definition", () => {
  const stockProject = tmpProject("status-stock-workflow");
  initProject(stockProject);
  story(stockProject, "ST-STOCK");
  const stockStatus = JSON.parse(mustRun([
    "status", "--root", stockProject, "--json",
  ]).stdout);
  assert.equal(stockStatus.next_action.kind, "start_story_workflow");
  assert.equal(stockStatus.next_action.definition_id, "software-project");
  assert.equal(stockStatus.next_action.definition_version, "3");
  assert.match(stockStatus.next_action.command, /^node /u);
  assert.match(stockStatus.next_action.command, /workflow instance start/u);
  assert.match(
    stockStatus.next_action.command,
    /--definition software-project --definition-version 3/u,
  );
  assert.match(stockStatus.next_action.command, /--story ST-STOCK/u);
  assert.doesNotMatch(stockStatus.next_action.command, /^agentic-sdlc /u);

  const customProject = tmpProject("status-custom-workflow");
  initProject(customProject);
  const configPath = path.join(customProject, ".sdlc", "config.json");
  const config = readJson(configPath);
  config.phase_order.splice(
    config.phase_order.indexOf("validation"),
    0,
    "integration-review",
  );
  config.phases["integration-review"] = structuredClone(config.phases.implementation);
  writeJson(configPath, config);
  pinProjectConfig(customProject);
  story(customProject, "ST-CUSTOM");
  const customStatus = JSON.parse(mustRun([
    "status", "--root", customProject, "--json",
  ]).stdout);
  assert.equal(customStatus.next_action.kind, "define_custom_workflow");
  assert.deepEqual(customStatus.next_action.configured_phase_order, config.phase_order);
  assert.match(customStatus.next_action.command, /^node /u);
  assert.match(customStatus.next_action.command, /workflow definition propose --help/u);
});

test("status continues an applied assessment instead of proposing an uncertifiable lifecycle", () => {
  const project = tmpProject("status-applied-assessment");
  initProject(project);
  const assessmentId = "ASSESS-STATUS-CONTINUE";
  prepareAssessmentApplyFixture(project, assessmentId);
  mustRun([
    "assessment",
    "proposal",
    "approve",
    "--root",
    project,
    "--id",
    assessmentId,
    ...humanApproval("Approve the exact status continuation fixture"),
  ]);
  mustRun([
    "assessment",
    "proposal",
    "apply",
    "--root",
    project,
    "--id",
    assessmentId,
    "--actor-type",
    "agent",
  ]);

  const status = JSON.parse(mustRun([
    "status", "--root", project, "--full", "--json",
  ]).stdout);
  assert.equal(status.next_action.kind, "continue_assessment");
  assert.equal(status.next_action.assessment_id, assessmentId);
  assert.equal(status.next_action.assessment_state, "running");
  assert.equal(status.next_action.story_id, `ST-${assessmentId}`);
  assert.match(
    status.next_action.command,
    new RegExp(`assessment proposal status --id ${assessmentId}`, "u"),
  );
  assert.notEqual(status.next_action.kind, "lifecycle_not_certifiable");
});

test("claim TTL is config-driven and legacy unbounded claims become stale", () => {
  const project = tmpProject("claim-ttl-policy");
  initProject(project);
  story(project, "ST-TTL");

  const configPath = path.join(project, ".sdlc", "config.json");
  const config = readJson(configPath);
  config.claim_policy.default_ttl_seconds = 0;
  writeJson(configPath, config);
  mustFail(
    ["story", "claim", "--root", project, "--id", "ST-TTL", "--agent", "codex"],
    /configuration is invalid|governed writes are blocked/i,
  );
  config.claim_policy.default_ttl_seconds = 90;
  writeJson(configPath, config);
  pinProjectConfig(project);
  createApprovedTemplate(project, "functional-analysis");
  createApprovedStoryContract(project, "ST-TTL", "design", "functional-analysis");
  startStoryTask(project, "ST-TTL", "design");

  const claimed = JSON.parse(mustRun([
    "story",
    "claim",
    "--root",
    project,
    "--id",
    "ST-TTL",
    "--agent",
    "codex",
    "--json",
  ]).stdout).claim;
  assert.equal(Date.parse(claimed.expires_at) - Date.parse(claimed.claimed_at), 90_000);

  const claimPath = path.join(project, ".sdlc", "stories", "ST-TTL", "claim.json");
  writeJson(claimPath, {
    ...claimed,
    claimed_at: new Date(Date.now() - 120_000).toISOString(),
    expires_at: null,
  });
  const orchestration = JSON.parse(mustRun(["orchestrate", "status", "--root", project, "--json"]).stdout);
  const stale = orchestration.stories.find((item) => item.id === "ST-TTL");
  assert.equal(stale.orchestration_state, "stale");
  assert.match(stale.blockers.join("\n"), /active claim (?:is )?expired/);
});

test("contract approval becomes stale after contract mutation", () => {
  const project = tmpProject("stale-approval");
  initProject(project);
  createStrictReadyStory(project, "ST-001");
  const contractPath = path.join(project, ".sdlc", "contracts", "contract-ST-001-design.json");
  const contract = readJson(contractPath);
  contract.outputs.push("unapproved extra output");
  writeJson(contractPath, contract);
  mustFail(["gate", "check", "--root", project, "--story", "ST-001", "--strict"], /approved human gate is stale/);
});

test("formal approvals require explicit source and summary or evidence", () => {
  const project = tmpProject("approval-policy");
  initProject(project);
  mustRun([
    "contract",
    "create",
    "--root",
    project,
    "--phase",
    "analysis",
    "--id",
    "contract-approval-policy",
    "--context-summary",
    "Approval policy test",
    "--qa",
    "Who approves?|Owner",
    "--force",
  ]);
  mustFail(
    ["contract", "approve", "--root", project, "--id", "contract-approval-policy", "--actor-type", "human"],
    /requires --approval-source/,
  );
  mustFail(
    [
      "contract",
      "approve",
      "--root",
      project,
      "--id",
      "contract-approval-policy",
      "--actor-type",
      "human",
      "--approval-source",
      "explicit-user",
    ],
    /requires --summary or --approval-evidence/,
  );
  mustRun(["contract", "approve", "--root", project, "--id", "contract-approval-policy", ...humanApproval("Explicitly approved")]);
  const approvalTrace = readJsonLines(path.join(project, ".sdlc", "traces", "project.jsonl"))
    .find((event) => event.action === "contract.approve");
  assert.deepEqual(approvalTrace.evidence, []);
  assert.equal(approvalTrace.request.source, "contract.approve");
  assert.equal(approvalTrace.request.contract_id, "contract-approval-policy");
  assert.equal(approvalTrace.request.approval_status, "approved");
  assert.match(approvalTrace.request.resulting_contract_hash, /^[a-f0-9]{64}$/u);
});

test("delegated automation approvals require persistent action and scope authorization", () => {
  const project = tmpProject("delegated-approval");
  initProject(project);
  mustFail([
    "authorization",
    "grant",
    "--root",
    project,
    "--id",
    "AUTH-BAD-CI-PROVENANCE",
    "--scope",
    "test",
    "--summary",
    "Mismatched provenance",
    "--allow-action",
    "contract.approve",
    "--actor-type",
    "human",
    "--approval-source",
    "ci",
  ], /approval_source ci require --actor-type ci/);
  mustFail([
    "authorization",
    "grant",
    "--root",
    project,
    "--id",
    "AUTH-BAD-USER-PROVENANCE",
    "--scope",
    "test",
    "--summary",
    "Mismatched provenance",
    "--allow-action",
    "contract.approve",
    "--actor-type",
    "ci",
    "--approval-source",
    "explicit-user",
  ], /approval_source explicit-user require --actor-type human/);
  mustFail([
    "authorization",
    "grant",
    "--root",
    project,
    "--id",
    "AUTH-AMBIGUOUS-PAIRS",
    "--scope",
    "test",
    "--summary",
    "Ambiguous independent action and subject lists",
    "--allow-action",
    "contract.approve",
    "--allow-action",
    "output.template.approve",
    "--allow-subject",
    "contract-ST-001-implementation",
    "--allow-subject",
    "implementation-summary-v1",
    "--actor-type",
    "human",
    "--approval-source",
    "explicit-user",
  ], /cannot combine multiple --allow-action and multiple --allow-subject/);
  story(project, "ST-001");
  const authorization = grantAutomationAuthorization(
    project,
    "AUTH-DELEGATED-ASSESSMENT",
    ["output.template.approve", "contract.approve", "task.start.confirm"],
    {
      artifactTypes: ["implementation-summary"],
      subjects: ["implementation-summary-v1", "contract-ST-001-implementation", "ST-001"],
      uses: [
        "output.template.approve=implementation-summary-v1",
        "contract.approve=contract-ST-001-implementation",
        "task.start.confirm=ST-001",
      ],
    },
  );
  const crossPairAuthorization = grantAutomationAuthorization(
    project,
    "AUTH-CROSS-PAIR",
    ["output.template.approve", "contract.approve"],
    {
      artifactTypes: ["implementation-summary"],
      subjects: ["another-template", "implementation-summary-v1"],
      uses: [
        "output.template.approve=another-template",
        "contract.approve=implementation-summary-v1",
      ],
    },
  );
  const wrongActionAuthorization = grantAutomationAuthorization(
    project,
    "AUTH-CONTRACT-ONLY",
    ["contract.approve"],
    { artifactTypes: ["implementation-summary"] },
  );
  const wrongSubjectAuthorization = grantAutomationAuthorization(
    project,
    "AUTH-WRONG-SUBJECT",
    ["output.template.approve"],
    { artifactTypes: ["implementation-summary"], subjects: ["another-template"] },
  );
  const wrongContractArtifactAuthorization = grantAutomationAuthorization(
    project,
    "AUTH-WRONG-CONTRACT-ARTIFACT",
    ["contract.approve"],
    {
      artifactTypes: ["technical-analysis"],
      subjects: ["contract-ST-001-implementation"],
    },
  );
  const wrongStartArtifactAuthorization = grantAutomationAuthorization(
    project,
    "AUTH-WRONG-START-ARTIFACT",
    ["task.start.confirm"],
    { artifactTypes: ["technical-analysis"], subjects: ["ST-001"] },
  );
  const riskyContractAuthorization = grantAutomationAuthorization(
    project,
    "AUTH-RISKY-CONTRACT",
    ["contract.approve"],
    { subjects: ["contract-risky-implementation"] },
  );
  const boundedRiskyContractAuthorization = grantAutomationAuthorization(
    project,
    "AUTH-BOUNDED-RISKY-CONTRACT",
    ["contract.approve"],
    {
      subjects: ["contract-risky-implementation"],
      boundaries: ["production:write"],
    },
  );
  const authorizationPath = path.join(project, ".sdlc", "authorizations", "AUTH-DELEGATED-ASSESSMENT.json");
  assert.equal(fs.existsSync(authorizationPath), true);
  assert.deepEqual(readJson(authorizationPath), authorization);
  assert.match(authorization.approved_content_hash, /^[a-f0-9]{64}$/);
  const authorizationStatus = JSON.parse(mustRun([
    "authorization",
    "status",
    "--root",
    project,
    "--id",
    authorization.id,
    "--json",
  ]).stdout);
  assert.deepEqual(authorizationStatus.authorizations, [authorization]);

  mustRun([
    "output",
    "template",
    "propose",
    "--root",
    project,
    "--type",
    "implementation-summary",
    "--id",
    "implementation-summary-v1",
    "--summary",
    "Implementation summary template",
  ]);
  mustFail(
    [
      "output",
      "template",
      "approve",
      "--root",
      project,
      "--id",
      "implementation-summary-v1",
      ...delegatedAutomationApproval(),
    ],
    /requires --authorization <id>/,
  );
  mustFail(
    [
      "output",
      "template",
      "approve",
      "--root",
      project,
      "--id",
      "implementation-summary-v1",
      "--actor-type",
      "agent",
      "--approval-source",
      "automation",
      "--authorization",
      authorization.id,
    ],
    /requires --summary or --approval-evidence/,
  );
  mustFail(
    [
      "output",
      "template",
      "approve",
      "--root",
      project,
      "--id",
      "implementation-summary-v1",
      ...delegatedAutomationApproval(
        "Attempt with an action not covered by the grant",
        delegatedApprovalScope,
        wrongActionAuthorization.id,
      ),
    ],
    /does not allow action output\.template\.approve/,
  );
  mustFail(
    [
      "output",
      "template",
      "approve",
      "--root",
      project,
      "--id",
      "implementation-summary-v1",
      ...delegatedAutomationApproval(
        "Attempt to approve a subject outside the grant",
        delegatedApprovalScope,
        wrongSubjectAuthorization.id,
      ),
    ],
    /does not allow subject implementation-summary-v1/,
  );
  mustFail(
    [
      "output",
      "template",
      "approve",
      "--root",
      project,
      "--id",
      "implementation-summary-v1",
      ...delegatedAutomationApproval(
        "Attempt to combine an action and subject that are allowed only in different pairs",
        delegatedApprovalScope,
        crossPairAuthorization.id,
      ),
    ],
    /does not allow action output\.template\.approve for subject implementation-summary-v1/,
  );
  mustFail(
    [
      "output",
      "template",
      "approve",
      "--root",
      project,
      "--id",
      "implementation-summary-v1",
      ...delegatedAutomationApproval(
        "Attempt outside the delegated scope",
        "unrelated deployment scope",
        authorization.id,
      ),
    ],
    /does not match authorization AUTH-DELEGATED-ASSESSMENT scope/,
  );
  mustRun([
    "output",
    "template",
    "approve",
    "--root",
    project,
    "--id",
    "implementation-summary-v1",
    ...delegatedAutomationApproval(undefined, undefined, authorization.id),
  ]);
  const registry = readJson(path.join(project, ".sdlc", "output-contracts", "registry.json"));
  const template = registry.templates.find((item) => item.id === "implementation-summary-v1");
  assert.equal(template.approval_source, "automation");
  assert.equal(template.explicit_user_confirmation, false);
  assert.equal(template.approved_by.type, "agent");
  assert.equal(template.authorization_ref, authorization.id);
  assert.equal(template.authorization_action, "output.template.approve");
  assert.equal(template.approval_scope.delegated_approval, true);
  assert.equal(template.approval_scope.approval_level, "technical assessment workbook, read-only repo analysis");
  assert.deepEqual(template.approval_scope.artifact_types, ["implementation-summary"]);

  template.authorization_ref = wrongSubjectAuthorization.id;
  writeJson(path.join(project, ".sdlc", "output-contracts", "registry.json"), registry);
  const tamperedTemplateGate = JSON.parse(run([
    "gate",
    "check",
    "--root",
    project,
    "--strict",
    "--json",
  ]).stdout);
  assert.ok(tamperedTemplateGate.errors.some(
    (error) => error.includes("does not allow subject implementation-summary-v1"),
  ));
  template.authorization_ref = authorization.id;
  writeJson(path.join(project, ".sdlc", "output-contracts", "registry.json"), registry);

  mustRun([
    "contract",
    "create",
    "--root",
    project,
    "--phase",
    "implementation",
    "--id",
    "contract-risky-implementation",
    "--context-summary",
    "This contract crosses a boundary that requires a direct decision.",
    "--qa",
    "Who approves production access?|A human or direct CI decision",
    "--capability-policy-json",
    JSON.stringify({ approval_required_for: ["production:write"] }),
  ]);
  mustFail([
    "contract",
    "approve",
    "--root",
    project,
    "--id",
    "contract-risky-implementation",
    ...delegatedAutomationApproval(undefined, undefined, riskyContractAuthorization.id),
  ], /does not allow approval boundary production:write/);
  mustRun([
    "contract",
    "approve",
    "--root",
    project,
    "--id",
    "contract-risky-implementation",
    ...delegatedAutomationApproval(undefined, undefined, boundedRiskyContractAuthorization.id),
  ]);

  mustRun([
    "contract",
    "create",
    "--root",
    project,
    "--phase",
    "implementation",
    "--story",
    "ST-001",
    "--id",
    "contract-ST-001-implementation",
    "--context-summary",
    "Implement under delegated approval scope.",
    "--qa",
    "Who delegated approvals?|Antonio",
    "--output-ref",
    "implementation-summary:implementation-summary-v1:new",
  ]);
  mustFail(
    [
      "contract",
      "approve",
      "--root",
      project,
      "--id",
      "contract-ST-001-implementation",
      "--actor-type",
      "agent",
      "--approval-source",
      "automation",
      "--authorization",
      authorization.id,
    ],
    /requires --summary or --approval-evidence/,
  );
  mustFail(
    [
      "contract",
      "approve",
      "--root",
      project,
      "--id",
      "contract-ST-001-implementation",
      ...delegatedAutomationApproval(undefined, undefined, wrongContractArtifactAuthorization.id),
    ],
    /does not allow artifact type implementation-summary/,
  );
  mustRun([
    "contract",
    "approve",
    "--root",
    project,
    "--id",
    "contract-ST-001-implementation",
    ...delegatedAutomationApproval(undefined, undefined, authorization.id),
  ]);
  const contract = readJson(path.join(project, ".sdlc", "contracts", "contract-ST-001-implementation.json"));
  const approval = contract.approvals.at(-1);
  assert.equal(contract.status, "approved");
  assert.equal(approval.approval_source, "automation");
  assert.equal(approval.explicit_user_confirmation, false);
  assert.equal(approval.approved_by.type, "agent");
  assert.equal(approval.authorization_ref, authorization.id);
  assert.equal(approval.authorization_action, "contract.approve");
  assert.equal(approval.scope.delegated_approval, true);
  assert.equal(approval.scope.approval_level, "technical assessment workbook, read-only repo analysis");

  const storyPath = path.join(project, ".sdlc", "stories", "ST-001", "story.json");
  const storyData = readJson(storyPath);
  writeJson(storyPath, { ...storyData, status: "ready", phase: "implementation" });
  const startArguments = [
    "task",
    "start",
    "--root",
    project,
    "--json",
    "--intent-json",
    routeIntent({
      requested_action: "implement_story",
      referenced_entities: [{ type: "story", id: "ST-001" }],
      proposed_phase: "implementation",
    }),
    "--confirm-start",
  ];
  mustFail(
    [...startArguments, "--authorization", wrongStartArtifactAuthorization.id],
    /does not allow artifact type implementation-summary/,
  );
  const started = JSON.parse(mustRun([
    ...startArguments,
    "--authorization",
    authorization.id,
  ]).stdout);
  assert.equal(started.status, "ready_to_execute");
  assert.equal(started.execution_allowed, true);
  assert.equal(started.contract_id, "contract-ST-001-implementation");

  const taskStartPath = path.join(project, ".sdlc", "stories", "ST-001", "task-start.json");
  const taskStartReceipt = readJson(taskStartPath);
  const taskStartUsePath = path.join(project, taskStartReceipt.authorization_use_ref);
  const taskStartUseReceipt = readJson(taskStartUsePath);
  const historicalProposalUse = {
    ...taskStartUseReceipt,
    proposal_ref: {
      id: "ASSESSMENT-UNRELATED",
      hash: "f".repeat(64),
    },
  };
  const {
    receipt_hash: _historicalReceiptHash,
    hash_algorithm: historicalHashAlgorithm,
    ...historicalUseSubject
  } = historicalProposalUse;
  writeJson(taskStartUsePath, {
    ...historicalUseSubject,
    receipt_hash: computeStableHash(historicalUseSubject),
    hash_algorithm: historicalHashAlgorithm,
  });
  const historicalTaskStartGate = JSON.parse(run([
    "gate",
    "check",
    "--root",
    project,
    "--story",
    "ST-001",
    "--strict",
    "--json",
  ]).stdout);
  assert.ok(historicalTaskStartGate.errors.some(
    (error) =>
      /task-start receipt: authorization usage receipt .* proposal binding mismatch.*ASSESSMENT-UNRELATED.*expects no proposal binding/isu
        .test(error),
  ));
  writeJson(taskStartUsePath, taskStartUseReceipt);

  writeJson(taskStartPath, { ...taskStartReceipt, authorization_ref: wrongStartArtifactAuthorization.id });
  const tamperedStartGate = JSON.parse(run([
    "gate",
    "check",
    "--root",
    project,
    "--story",
    "ST-001",
    "--strict",
    "--json",
  ]).stdout);
  assert.ok(tamperedStartGate.errors.some(
    (error) => error.includes("does not allow artifact type implementation-summary"),
  ));
  writeJson(taskStartPath, taskStartReceipt);

  const strictGateResult = run(["gate", "check", "--root", project, "--story", "ST-001", "--strict", "--json"]);
  assert.notEqual(strictGateResult.status, 0, "The output is not linked yet, so the strict gate should still fail.");
  const strictGate = JSON.parse(strictGateResult.stdout);
  assert.equal(
    strictGate.errors.some((error) => error.includes("persistent authorization_ref")),
    false,
    `Delegated template approval lost its authorization during gate validation: ${strictGate.errors.join("; ")}`,
  );
  mustRun([
    "authorization",
    "revoke",
    "--root",
    project,
    "--id",
    authorization.id,
    "--actor-type",
    "human",
    "--reason",
    "Delegation withdrawn",
  ]);
  const afterRevocation = JSON.parse(run([
    "gate",
    "check",
    "--root",
    project,
    "--story",
    "ST-001",
    "--strict",
    "--json",
  ]).stdout);
  assert.equal(
    afterRevocation.errors.some((error) => /AUTH-DELEGATED-ASSESSMENT.*(?:revoked|closed|inactive)/i.test(error)),
    false,
    `A later revocation must not invalidate usage receipts that were valid at use time: ${afterRevocation.errors.join("; ")}`,
  );
  mustFail(
    [...startArguments, "--authorization", wrongStartArtifactAuthorization.id],
    /already immutably recorded.*continue the existing governed run/is,
  );
});

test("output delivery canonicalizes Excel and verifies OOXML evidence before linking", () => {
  const project = tmpProject("xlsx-delivery");
  initProject(project);
  story(project, "ST-XLSX", ["--requirement", "REQ-XLSX"]);

  const proposed = JSON.parse(mustRun([
    "output",
    "template",
    "propose",
    "--root",
    project,
    "--type",
    "technical-analysis",
    "--id",
    "technical-analysis-v1",
    "--preset",
    "technical-assessment",
    "--format",
    "Excel",
    "--delivery",
    "artifact",
    "--summary",
    "Canonical technical assessment workbook",
    "--json",
  ]).stdout);
  const expectedDelivery = {
    format: "xlsx",
    label: "Excel workbook",
    extension: ".xlsx",
    media_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    generator: "spreadsheets",
    mode: "artifact",
  };
  assert.equal(proposed.template.preset, "technical-assessment");
  assert.deepEqual(proposed.template.delivery, expectedDelivery);
  assert.equal(
    fs.readFileSync(path.join(project, proposed.template.path), "utf8"),
    fs.readFileSync(path.join(repoRoot, "templates", "technical-assessment.md"), "utf8"),
  );

  const approved = JSON.parse(mustRun([
    "output",
    "template",
    "approve",
    "--root",
    project,
    "--id",
    "technical-analysis-v1",
    ...humanApproval("Approved canonical workbook delivery"),
    "--json",
  ]).stdout);
  assert.deepEqual(approved.template.delivery, expectedDelivery);
  assert.match(approved.template.approved_delivery_hash, /^[a-f0-9]{64}$/);
  assert.equal(approved.decision.approved_delivery_hash, approved.template.approved_delivery_hash);
  assert.deepEqual(approved.decision.delivery, expectedDelivery);

  createApprovedStoryContract(project, "ST-XLSX", "analysis", "technical-analysis");
  mustRun([
    "capability",
    "profile",
    "propose",
    "--root",
    project,
    "--id",
    "CAP-PROFILE-ST-XLSX",
    "--story",
    "ST-XLSX",
    "--phase",
    "analysis",
  ]);
  mustRun([
    "capability",
    "profile",
    "approve",
    "--root",
    project,
    "--id",
    "CAP-PROFILE-ST-XLSX",
    ...humanApproval("Approved workbook assessment capability profile"),
  ]);
  const started = JSON.parse(mustRun([
    "task",
    "start",
    "--root",
    project,
    "--intent-json",
    routeIntent({
      requested_action: "technical_analysis",
      referenced_entities: [{ type: "story", id: "ST-XLSX" }],
      proposed_phase: "analysis",
      artifact_type: "technical-analysis",
    }),
    "--confirm-start",
    "--actor-type",
    "human",
    "--json",
  ]).stdout);
  assert.equal(started.status, "needs_user_input");
  assert.equal(started.execution_allowed, false);
  assert.ok(started.blocking_reasons.includes("baseline_missing"));
  assert.ok(started.questions.some((question) => (
    question.includes("Checkpoint 1 of 2")
    && question.includes("What I need:")
    && question.includes("Why:")
    && question.includes("Example answer:")
    && question.includes("Effect:")
  )));
  const wrongExtension = writeArtifact(
    project,
    ".sdlc/stories/ST-XLSX/outputs/technical-assessment.md",
    "# Technical assessment\n",
  );
  mustFail([
    "output",
    "link",
    "--root",
    project,
    "--story",
    "ST-XLSX",
    "--type",
    "technical-analysis",
    "--artifact",
    wrongExtension,
    "--template",
    "technical-analysis-v1",
    "--mode",
    "new",
    "--allow-unapproved-contract-output",
  ], /requires a \.xlsx canonical artifact/);

  const rejectedTextEvidence = writeArtifact(
    project,
    ".sdlc/evidence/ST-XLSX-workbook-render.txt",
    "Workbook rendered and inspected. This untyped text assertion is intentionally insufficient.\n",
  );
  const fakeWorkbook = writeArtifact(
    project,
    ".sdlc/stories/ST-XLSX/outputs/not-a-workbook.xlsx",
    "This is not an OOXML ZIP container.\n",
  );
  mustFail([
    "output",
    "link",
    "--root",
    project,
    "--story",
    "ST-XLSX",
    "--type",
    "technical-analysis",
    "--artifact",
    fakeWorkbook,
    "--template",
    "technical-analysis-v1",
    "--mode",
    "new",
    "--allow-unapproved-contract-output",
    "--evidence",
    rejectedTextEvidence,
  ], /not a valid ZIP container/);

  const emptyWorkbook = writeStoredZip(
    project,
    ".sdlc/stories/ST-XLSX/outputs/empty-technical-assessment.xlsx",
    {
      "[Content_Types].xml": [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
        '<Default Extension="xml" ContentType="application/xml"/>',
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
        "</Types>",
      ].join(""),
      "_rels/.rels": [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>',
        "</Relationships>",
      ].join(""),
      "xl/workbook.xml": [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ',
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets/></workbook>',
      ].join(""),
      "xl/_rels/workbook.xml.rels": [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
      ].join(""),
    },
  );
  mustFail([
    "output",
    "link",
    "--root",
    project,
    "--story",
    "ST-XLSX",
    "--type",
    "technical-analysis",
    "--artifact",
    emptyWorkbook,
    "--template",
    "technical-analysis-v1",
    "--mode",
    "new",
    "--allow-unapproved-contract-output",
    "--evidence",
    emptyWorkbook,
  ], /workbook container but no declared worksheet/);

  const workbook = writeStoredZip(
    project,
    ".sdlc/stories/ST-XLSX/outputs/technical-assessment.xlsx",
    {
      "[Content_Types].xml": [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
        '<Default Extension="xml" ContentType="application/xml"/>',
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>',
        "</Types>",
      ].join(""),
      "_rels/.rels": [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>',
        "</Relationships>",
      ].join(""),
      "xl/workbook.xml": [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ',
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
        '<sheets><sheet name="Assessment" sheetId="1" r:id="rId1"/></sheets></workbook>',
      ].join(""),
      "xl/_rels/workbook.xml.rels": [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>',
        "</Relationships>",
      ].join(""),
      "xl/worksheets/sheet1.xml": [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">',
        '<c r="A1" t="inlineStr"><is><t>Finding</t></is></c>',
        '<c r="B1" t="inlineStr"><is><t>Replace manual handoffs with typed receipts</t></is></c>',
        "</row></sheetData></worksheet>",
      ].join(""),
    },
  );
  mustFail([
    "output",
    "link",
    "--root",
    project,
    "--story",
    "ST-XLSX",
    "--type",
    "technical-analysis",
    "--artifact",
    workbook,
    "--template",
    "technical-analysis-v1",
    "--mode",
    "new",
    "--allow-unapproved-contract-output",
    "--evidence",
    workbook,
  ], /Render verification evidence must be a separate render or visual-inspection record/);

  mustFail([
    "output",
    "link",
    "--root",
    project,
    "--story",
    "ST-XLSX",
    "--type",
    "technical-analysis",
    "--artifact",
    workbook,
    "--template",
    "technical-analysis-v1",
    "--mode",
    "new",
    "--allow-unapproved-contract-output",
  ], /requires --render-evidence[\s\S]*only for render or visual verification[\s\S]*legacy --evidence name remains accepted/);

  const workbookPath = path.join(project, workbook);
  const artifactSha256 = sha256File(workbookPath);
  const evidence = ".sdlc/evidence/ST-XLSX-workbook-render.json";
  const renderReceiptContent = {
    id: "RENDER-ST-XLSX",
    kind: "render_verification_receipt",
    schema_version: "render-verification-receipt:v1",
    status: "passed",
    artifact_path: workbook,
    artifact_sha256: artifactSha256,
    renderer: "spreadsheets",
    rendered_at: new Date().toISOString(),
    checks: ["Workbook opened and Assessment sheet rendered with populated cells"],
  };
  writeJson(path.join(project, evidence), {
    ...renderReceiptContent,
    receipt_hash: computeStableHash(renderReceiptContent),
    hash_algorithm: "sha256:stable-json:v1",
  });
  const generatorReceipt = ".sdlc/evidence/ST-XLSX-generator.json";
  const generatorReceiptContent = {
    kind: "artifact_generator_receipt",
    schema_version: "artifact-generator-receipt:v1",
    id: "GEN-ST-XLSX",
    artifact_path: workbook,
    artifact_sha256: artifactSha256,
    generator: "spreadsheets",
    status: "succeeded",
    generated_at: new Date().toISOString(),
  };
  writeJson(path.join(project, generatorReceipt), {
    ...generatorReceiptContent,
    receipt_hash: computeStableHash(generatorReceiptContent),
    hash_algorithm: "sha256:stable-json:v1",
  });
  const linked = JSON.parse(mustRun([
    "output",
    "link",
    "--root",
    project,
    "--story",
    "ST-XLSX",
    "--type",
    "technical-analysis",
    "--artifact",
    workbook,
    "--template",
    "technical-analysis-v1",
    "--mode",
    "new",
    "--allow-unapproved-contract-output",
    "--requirement",
    "REQ-XLSX",
    "--render-evidence",
    evidence,
    "--receipt-file",
    generatorReceipt,
    "--json",
  ]).stdout);
  assert.deepEqual(
    {
      delivery_format: linked.link.delivery_format,
      delivery_extension: linked.link.delivery_extension,
      media_type: linked.link.media_type,
      generator: linked.link.generator,
      delivery_mode: linked.link.delivery_mode,
    },
    {
      delivery_format: "xlsx",
      delivery_extension: ".xlsx",
      media_type: expectedDelivery.media_type,
      generator: "spreadsheets",
      delivery_mode: "artifact",
    },
  );
  assert.equal(linked.link.verification_receipt.status, "passed");
  assert.equal(linked.link.verification_receipt.verifier, "ooxml-content-v2");
  assert.equal(linked.link.verification_receipt.container_verified.status, "verified");
  assert.equal(linked.link.verification_receipt.content_verified.status, "verified");
  assert.equal(linked.link.verification_receipt.render_verified.status, "verified");
  assert.equal(linked.link.verification_receipt.artifact.format, "xlsx");
  assert.equal(linked.link.verification_receipt.artifact.sha256, linked.link.fingerprints.artifact_sha256);
  assert.deepEqual(linked.link.verification_receipt.evidence.map((item) => item.path), [evidence]);
  assert.ok(linked.link.verification_receipt.container_verified.checks.some(
    (check) => check.includes("valid OOXML ZIP container"),
  ));

  const registry = readJson(path.join(project, ".sdlc", "output-contracts", "registry.json"));
  const storedLink = registry.links.find((item) => item.id === linked.link.id);
  assert.deepEqual(storedLink.verification_receipt, linked.link.verification_receipt);
  const originalEvidence = storedLink.verification_receipt.evidence;
  storedLink.verification_receipt.evidence = [{
    path: workbook,
    sha256: storedLink.verification_receipt.artifact.sha256,
  }];
  writeJson(path.join(project, ".sdlc", "output-contracts", "registry.json"), registry);
  const selfEvidenceGate = JSON.parse(run([
    "gate",
    "check",
    "--root",
    project,
    "--story",
    "ST-XLSX",
    "--strict",
    "--json",
  ]).stdout);
  assert.ok(selfEvidenceGate.errors.some(
    (error) => error.includes("verification evidence must be separate from the output artifact"),
  ));
  storedLink.verification_receipt.evidence = originalEvidence;
  writeJson(path.join(project, ".sdlc", "output-contracts", "registry.json"), registry);
  const status = JSON.parse(mustRun([
    "output",
    "status",
    "--root",
    project,
    "--story",
    "ST-XLSX",
    "--type",
    "technical-analysis",
    "--json",
  ]).stdout);
  assert.deepEqual(status.links[0].verification_receipt, linked.link.verification_receipt);
});

test("assessment apply preflights an incomplete contract before any canonical mutation or authorization use", () => {
  const project = tmpProject("assessment-contract-preflight");
  initProject(project);
  const id = "ASSESS-CONTRACT-PREFLIGHT";
  const proposal = prepareAssessmentApplyFixture(project, id);
  proposal.contract_draft.capability_policy = {
    ...proposal.contract_draft.capability_policy,
    tools: { required: ["node"], allowed: [], forbidden: [] },
  };
  proposal.contract_draft.capability_bindings = [];
  proposal.proposal_hash = computeProposalHash(proposal);
  writeJson(
    path.join(project, ".sdlc", "assessments", "proposals", `${id}.json`),
    proposal,
  );
  writeJson(
    path.join(project, ".sdlc", "assessments", "workflows", `${id}.json`),
    createAssessmentWorkflow({
      proposal,
      created_at: proposal.created_at,
      metadata: { workflow_kind: "project-assessment" },
    }),
  );
  const approved = JSON.parse(mustRun([
    "assessment",
    "proposal",
    "approve",
    "--root",
    project,
    "--id",
    id,
    ...humanApproval("Approve the exact incomplete-contract regression fixture"),
    "--json",
  ]).stdout);
  const beforeApply = snapshotFilesystemTree(project);
  mustFail([
    "assessment",
    "proposal",
    "apply",
    "--root",
    project,
    "--id",
    id,
    "--actor-type",
    "agent",
  ], /required tools capability 'node' has no concrete binding/);
  assert.deepEqual(
    snapshotFilesystemTree(project),
    beforeApply,
    "contract preflight must run before canonical writes, traces, locks, or authorization-use receipts",
  );
  assert.equal(
    fs.existsSync(path.join(project, ".sdlc", "authorization-uses", approved.authorization.id)),
    false,
  );
});

test("assessment apply rejects a reused incomplete contract before task start", () => {
  const project = tmpProject("assessment-reused-contract");
  initProject(project);
  const id = "ASSESS-REUSED-CONTRACT";
  const proposal = prepareAssessmentApplyFixture(project, id);
  const approved = JSON.parse(mustRun([
    "assessment",
    "proposal",
    "approve",
    "--root",
    project,
    "--id",
    id,
    ...humanApproval("Approve the exact reused-contract regression fixture"),
    "--json",
  ]).stdout);
  const existingContract = structuredClone(proposal.contract_draft);
  existingContract.proposal_ref = { id, hash: proposal.proposal_hash };
  existingContract.capability_policy = {
    ...existingContract.capability_policy,
    tools: { required: ["node"], allowed: [], forbidden: [] },
  };
  existingContract.capability_bindings = [];
  const contractPath = path.join(
    project,
    ".sdlc",
    "contracts",
    `${proposal.contract_draft.id}.json`,
  );
  writeJson(contractPath, existingContract);
  const beforeApply = snapshotFilesystemTree(project);
  mustFail([
    "assessment",
    "proposal",
    "apply",
    "--root",
    project,
    "--id",
    id,
    "--actor-type",
    "agent",
    "--trust-custom-rtk-command",
  ], /required tools capability 'node' has no concrete binding/);
  assert.equal(
    fs.existsSync(path.join(project, ".sdlc", "stories", `ST-${id}`, "task-start.json")),
    false,
    "an incomplete reused contract must never reach task-start materialization",
  );
  const useRoot = path.join(project, ".sdlc", "authorization-uses", approved.authorization.id);
  assert.equal(
    fs.existsSync(useRoot),
    false,
    "reused-contract preflight must run before any authorization use",
  );
  assert.deepEqual(
    snapshotFilesystemTree(project),
    beforeApply,
    "reused-contract preflight must not create requirement, story, template, trace, lock, or authorization records",
  );
});

test("assessment apply rejects a ready reused contract whose current content is not the approved proposal draft", () => {
  const project = tmpProject("assessment-reused-contract-content");
  initProject(project);
  const id = "ASSESS-REUSED-CONTENT";
  const proposal = prepareAssessmentApplyFixture(project, id);
  const approved = JSON.parse(mustRun([
    "assessment",
    "proposal",
    "approve",
    "--root",
    project,
    "--id",
    id,
    ...humanApproval("Approve the exact reused-content regression fixture"),
    "--json",
  ]).stdout);
  const existingContract = structuredClone(proposal.contract_draft);
  existingContract.proposal_ref = { id, hash: proposal.proposal_hash };
  existingContract.status = "draft";
  existingContract.approvals = [];
  const approvedContentHash = computeGovernedApprovalSubjectHash(existingContract);
  existingContract.approvals.push({
    id: `APR-${existingContract.id}-fixture`,
    contract_id: existingContract.id,
    status: "approved",
    summary: "Fixture approval for exact proposal draft",
    scope: {
      subject_id: existingContract.id,
      delegated_approval: true,
      proposal_ref: { id, hash: proposal.proposal_hash },
      artifact_types: [proposal.deliverable.artifact_type],
      authorization_ref: approved.authorization.id,
    },
    evidence: [],
    approval_source: "automation",
    authorization_ref: approved.authorization.id,
    authorization_use_ref: ".sdlc/authorization-uses/missing-fixture.json",
    authorization_action: "contract.approve",
    explicit_user_confirmation: false,
    provisional: false,
    approved_content_hash: approvedContentHash,
    hash_algorithm: "sha256:stable-json:v1",
    approved_by: { type: "agent", id: "fixture-agent" },
    created_at: new Date().toISOString(),
  });
  existingContract.status = "approved";
  existingContract.contextualization.summary =
    `${existingContract.contextualization.summary} Unapproved current mutation.`;
  const contractPath = path.join(
    project,
    ".sdlc",
    "contracts",
    `${proposal.contract_draft.id}.json`,
  );
  writeJson(contractPath, existingContract);
  const beforeApply = snapshotFilesystemTree(project);
  mustFail([
    "assessment",
    "proposal",
    "apply",
    "--root",
    project,
    "--id",
    id,
    "--actor-type",
    "agent",
    "--trust-custom-rtk-command",
  ], /current governed content differs from the approved proposal draft|approval is stale/);
  assert.deepEqual(
    snapshotFilesystemTree(project),
    beforeApply,
    "stale reused contract content must fail before every canonical or authorization mutation",
  );
});

test("assessment tranche runs from precise checkpoints through budgeted release-manifest gate", async () => {
  const project = tmpProject("assessment-tranche");
  initProject(project);
  const codeBurnReport = readJson(path.join(repoRoot, "test", "fixtures", "codeburn", "report-v0.9.15.json"));
  const fakeCodeBurn = createFakeCodeBurn(project, codeBurnReport);
  const fakeRtk = createFakeRtk(project);
  const fakeCodexHome = path.join(project, "fake-codex-home");
  const fakeCodexThread = "019fa7f0-d150-7fb1-aad8-d10a2243521a";
  const fakeCodexSessionRoot = path.join(fakeCodexHome, "sessions", "2026", "07", "28");
  const fakeCodexSession = path.join(
    fakeCodexSessionRoot,
    `rollout-2026-07-28-${fakeCodexThread}.jsonl`,
  );
  fs.mkdirSync(fakeCodexSessionRoot, { recursive: true });
  const codexSessionMeta = {
    timestamp: "2026-07-28T08:00:00.000Z",
    type: "session_meta",
    payload: { id: fakeCodexThread, cwd: project, source: "codex_desktop" },
  };
  const codexTokenCount = (timestamp, input, output, cacheRead) => ({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: input,
          cached_input_tokens: cacheRead,
          cache_write_input_tokens: 0,
          output_tokens: output,
          reasoning_output_tokens: 0,
          total_tokens: input + output,
        },
      },
      rate_limits: null,
    },
  });
  const initialCodexCount = codexTokenCount(
    "2026-07-28T08:01:00.000Z",
    100,
    20,
    60,
  );
  fs.writeFileSync(
    fakeCodexSession,
    `${JSON.stringify(codexSessionMeta)}\n${JSON.stringify(initialCodexCount)}\n`,
  );
  fs.writeFileSync(
    path.join(project, "README.md"),
    "# Travel Operations\n\nA modular travel workflow with replaceable providers and contract-driven delivery.\n",
  );

  const checkpointOne = mustFail([
    "assessment",
    "proposal",
    "prepare",
    "--root",
    project,
    "--id",
    "ASSESS-E2E",
  ], /Checkpoint 1 is required/);
  const checkpointOneMessage = `${checkpointOne.stdout}\n${checkpointOne.stderr}`;
  for (const requiredExplanation of ["What I need:", "Why:", "Example commands:", "Example answer in chat:"]) {
    assert.match(
      checkpointOneMessage,
      new RegExp(requiredExplanation.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `Checkpoint 1 did not explain ${requiredExplanation}`,
    );
  }

  mustRun([
    "baseline",
    "propose",
    "--root",
    project,
    "--id",
    "BASELINE-ASSESS-E2E",
    "--source",
    "README.md",
    "--summary",
    "Current modular travel workflow and repository boundary",
  ]);
  mustRun([
    "baseline",
    "approve",
    "--root",
    project,
    "--id",
    "BASELINE-ASSESS-E2E",
    ...humanApproval("The baseline sources and current-state summary are accurate"),
  ]);
  ensureTrustedMeteringFixture(project, {
    metrics: ["active_time_seconds", "api_calls", "steps"],
  });

  const budgetInput = {
    scope: { level: "proposal", proposal_id: "ASSESS-E2E", includes_subagents: true },
    completion_reserve_percent: 15,
    limits: {
      active_time_seconds: { unit: "seconds", metering: "exact", soft: 600, hard: 1200 },
      api_calls: { unit: "calls", metering: "exact", hard: 100 },
      steps: { unit: "steps", metering: "exact", soft: 10, hard: 20 },
      tokens: { unit: "tokens", metering: "estimated", soft: 50000 },
    },
  };
  const artifact = ".sdlc/stories/ST-ASSESS-E2E/outputs/technical-assessment.md";
  const prepared = JSON.parse(mustRun([
    "assessment",
    "proposal",
    "prepare",
    "--root",
    project,
    "--id",
    "ASSESS-E2E",
    "--baseline",
    "BASELINE-ASSESS-E2E",
    "--story",
    "ST-ASSESS-E2E",
    "--requirement",
    "REQ-ASSESS-E2E",
    "--scope-title",
    "Assess the contract-driven workflow",
    "--scope-summary",
    "Find evidence-backed failures and propose configurable improvements without external or production access.",
    "--format",
    "Markdown",
    "--delivery",
    "artifact",
    "--artifact",
    artifact,
    "--budget-json",
    JSON.stringify(budgetInput),
    "--json",
  ]).stdout);
  assert.equal(prepared.status, "proposal_pending");
  assert.equal(prepared.checkpoint, 2);
  assert.equal(prepared.proposal.execution_budget.limits.active_time_seconds.hard, 1200);
  assert.equal(prepared.proposal.execution_budget.limits.active_time_seconds.metering, "exact");
  assert.equal(prepared.proposal.execution_budget.limits.tokens.hard, null);
  assert.equal(prepared.proposal.execution_budget.limits.tokens.metering, "estimated");
  assert.match(prepared.assistant_message, /Cosa ti sto chiedendo/);
  assert.match(prepared.assistant_message, /Perché serve/);
  assert.match(prepared.assistant_message, /Cosa autorizza il tuo sì/);
  assert.match(prepared.assistant_message, /Cosa non autorizza/);
  assert.match(prepared.assistant_message, /Esempi di risposta completi/);
  assert.match(prepared.assistant_message, /Tempo attivo:[^\n]*hard stop/);
  assert.match(prepared.assistant_message, /Token:[^\n]*(?:stima|advisory)/i);
  assert.match(prepared.assistant_message, /non configurato[^\n]*pricing\/metering/i);
  const optimizationWrite = prepared.proposal.write_set.find((entry) => entry.action === "context.optimization.observe");
  assert.match(optimizationWrite.path, /^\.sdlc\/context-optimization\/ASSESS-E2E\/observations\/\*\.json$/u);
  assert.equal(optimizationWrite.budget_effect, "advisory-only; usage adjustment 0");
  const pendingWorkflow = readJson(path.join(project, ".sdlc", "assessments", "workflows", "ASSESS-E2E.json"));

  const approved = JSON.parse(mustRun([
    "assessment",
    "proposal",
    "approve",
    "--root",
    project,
    "--id",
    "ASSESS-E2E",
    ...humanApproval("Approvo esattamente scope, write set, strumenti e budget mostrati"),
    "--json",
  ]).stdout);
  assert.equal(approved.status, "authorized");
  assert.equal(approved.approval.proposal_hash, prepared.proposal.proposal_hash);
  assert.equal(approved.approval.authority_assurance_label, "audit_only");
  assert.match(approved.authority_note, /cannot independently prove/i);
  assert.ok(approved.authorization.allowed_actions.includes("assessment.proposal.apply"));
  assert.ok(approved.authorization.allowed_actions.includes("assessment.proposal.complete"));
  assert.ok(approved.authorization.allowed_actions.includes("context.optimization.observe"));
  assert.equal(approved.approval.authorization_snapshot.authorization_hash, approved.authorization.authorization_hash);

  // Simulate a process interruption after the approval seed was persisted but
  // before the authorization and workflow writes completed. Replaying the same
  // command must restore the exact embedded authorization, never mint a broader one.
  fs.rmSync(path.join(project, ".sdlc", "authorizations", `${approved.authorization.id}.json`));
  writeJson(path.join(project, ".sdlc", "assessments", "workflows", "ASSESS-E2E.json"), pendingWorkflow);
  const recoveredApproval = JSON.parse(mustRun([
    "assessment",
    "proposal",
    "approve",
    "--root",
    project,
    "--id",
    "ASSESS-E2E",
    "--json",
  ]).stdout);
  assert.equal(recoveredApproval.idempotent, true);
  assert.equal(recoveredApproval.recovery_status, "repaired");
  assert.deepEqual(recoveredApproval.repaired.sort(), ["authorization", "workflow"]);
  assert.equal(recoveredApproval.authorization.authorization_hash, approved.authorization.authorization_hash);
  assert.equal(recoveredApproval.workflow.state, "authorized");

  const meterStart = JSON.parse(mustRun([
    "budget", "meter", "start", "--root", project,
    "--proposal", "ASSESS-E2E", "--adapter", "codeburn",
    "--project", "TravelOps", "--from", "2026-07-14", "--to", "2026-07-14", "--json",
  ]).stdout);
  assert.equal(meterStart.status, "created");
  assert.equal(meterStart.baseline.snapshot.assurance.classification, "advisory_observed");
  const nativeMeterStart = JSON.parse(mustRun([
    "budget", "meter", "start", "--root", project,
    "--proposal", "ASSESS-E2E", "--id", "METER-ASSESS-E2E-CODEX-SESSION",
    "--thread-id", fakeCodexThread, "--session-file", fakeCodexSession, "--json",
  ], {
    env: { CODEX_HOME: fakeCodexHome, CODEX_THREAD_ID: fakeCodexThread },
  }).stdout);
  assert.equal(nativeMeterStart.status, "created");
  assert.equal(nativeMeterStart.baseline.adapter, "codex-session");
  assert.equal(nativeMeterStart.baseline.snapshot.source.authentication_required, false);

  const applied = JSON.parse(mustRun([
    "assessment",
    "proposal",
    "apply",
    "--root",
    project,
    "--id",
    "ASSESS-E2E",
    "--actor-type",
    "agent",
    "--trust-custom-rtk-command",
    "--json",
  ]).stdout);
  assert.equal(applied.status, "running");
  assert.equal(applied.application.proposal_hash, prepared.proposal.proposal_hash);
  assert.equal(fs.existsSync(path.join(project, ".sdlc", "requirements", "REQ-ASSESS-E2E.json")), true);
  assert.equal(fs.existsSync(path.join(project, ".sdlc", "stories", "ST-ASSESS-E2E", "task-start.json")), true);
  const assessmentTaskStart = readJson(
    path.join(project, ".sdlc", "stories", "ST-ASSESS-E2E", "task-start.json"),
  );
  assert.equal(assessmentTaskStart.kind, "task_start_receipt");
  assert.equal(assessmentTaskStart.schema_version, "task-start-receipt:v2");
  const projectStatusAfterApply = JSON.parse(mustRun([
    "status", "--root", project, "--full", "--json",
  ]).stdout);
  const statusStoryAfterApply = projectStatusAfterApply.orchestration.stories
    .find((item) => item.id === "ST-ASSESS-E2E");
  assert.ok(statusStoryAfterApply);
  assert.notEqual(statusStoryAfterApply.lifecycle_source, "invalid_story_workflow");
  const orchestrationAfterApply = JSON.parse(mustRun([
    "orchestrate", "status", "--root", project, "--json",
  ]).stdout);
  const orchestratedStoryAfterApply = orchestrationAfterApply.stories
    .find((item) => item.id === "ST-ASSESS-E2E");
  assert.ok(orchestratedStoryAfterApply);
  assert.notEqual(orchestratedStoryAfterApply.lifecycle_source, "invalid_story_workflow");
  assert.equal(applied.context_optimization.observation.phase, "apply");
  assert.equal(applied.context_optimization.observation.budget_effect.usage_adjustment_applied, 0);

  mustFail([
    "optimization", "run", "--root", project,
    "--command-json", JSON.stringify(portableRtkTestCommand),
  ], /requires --proposal.*ASSESS-E2E/u);
  const governedOptimized = mustRun([
    "optimization", "run", "--root", project, "--proposal", "ASSESS-E2E",
    "--command-json", JSON.stringify(portableRtkTestCommand),
    "--trust-custom-rtk-command",
  ]);
  assert.match(governedOptimized.stdout, /fake-rtk/u);

  const checkpointGain = readJson(fakeRtk.reportPath);
  Object.assign(checkpointGain.summary, {
    total_commands: 10,
    total_input: 4_900,
    total_output: 1_250,
    total_saved: 3_500,
    avg_savings_pct: 71.4,
  });
  writeJson(fakeRtk.reportPath, checkpointGain);

  codeBurnReport.generated = "2026-07-14T10:00:00.000Z";
  codeBurnReport.overview.tokens.input += 100;
  codeBurnReport.overview.tokens.output += 50;
  codeBurnReport.overview.calls += 2;
  codeBurnReport.overview.cost += 0.01;
  codeBurnReport.projects[0].calls += 2;
  codeBurnReport.projects[0].cost += 0.01;
  writeJson(fakeCodeBurn.reportPath, codeBurnReport);
  fs.appendFileSync(
    fakeCodexSession,
    `${JSON.stringify(codexTokenCount(
      "2026-07-28T08:02:00.000Z",
      160,
      30,
      80,
    ))}\n`,
  );
  const nativeMetered = JSON.parse(mustRun([
    "budget", "meter", "record", "--root", project,
    "--proposal", "ASSESS-E2E", "--baseline", "METER-ASSESS-E2E-CODEX-SESSION",
    "--thread-id", fakeCodexThread, "--session-file", fakeCodexSession,
    "--trust-custom-rtk-command", "--json",
  ], {
    env: { CODEX_HOME: fakeCodexHome, CODEX_THREAD_ID: fakeCodexThread },
  }).stdout);
  assert.equal(nativeMetered.registration_status, "created");
  assert.equal(nativeMetered.receipt.source.adapter, "codex-session");
  assert.equal(nativeMetered.receipt.usage.tokens, 70);
  const metered = JSON.parse(mustRun([
    "budget", "meter", "record", "--root", project,
    "--proposal", "ASSESS-E2E", "--adapter", "codeburn", "--trust-custom-rtk-command", "--json",
  ]).stdout);
  assert.equal(metered.registration_status, "created");
  assert.equal(metered.receipt.source.assurance, "advisory_observed");
  assert.equal(metered.receipt.metering.tokens, "estimated");
  assert.equal(metered.receipt.usage.tokens, 150);
  const meteredReplay = JSON.parse(mustRun([
    "budget", "meter", "record", "--root", project,
    "--proposal", "ASSESS-E2E", "--adapter", "codeburn", "--trust-custom-rtk-command", "--json",
  ]).stdout);
  assert.equal(meteredReplay.idempotent, true);

  mustFail([
    "assessment",
    "proposal",
    "complete",
    "--root",
    project,
    "--id",
    "ASSESS-E2E",
    "--actor-type",
    "agent",
  ], /needs exact metering but received missing/);

  mustFail([
    "budget",
    "usage",
    "record",
    "--root",
    project,
    "--proposal",
    "ASSESS-E2E",
    "--id",
    "USAGE-MANUAL-EXACT",
    "--receipt-json",
    JSON.stringify({ usage: { tokens: 1 }, metering: { tokens: "exact" } }),
  ], /Manual usage input cannot declare exact metering/);

  const untrustedFixture = writeTrustedUsageReceipt(project, {
    proposalId: "ASSESS-E2E",
    id: "USAGE-UNTRUSTED-EXACT",
    usage: { steps: 1 },
    metering: { steps: "exact" },
    adapter: "untrusted-e2e-meter",
    fixtureKey: "USAGE-UNTRUSTED-EXACT",
    configureTrust: false,
  });
  mustFail([
    "budget",
    "usage",
    "record",
    "--root",
    project,
    "--proposal",
    "ASSESS-E2E",
    "--receipt-file",
    untrustedFixture.receiptRelativePath,
  ], /is not trusted by this project/);

  mustFail([
    "budget",
    "amend",
    "--root",
    project,
    "--proposal",
    "ASSESS-E2E",
    "--id",
    "BAMEND-ASSESS-E2E-EARLY",
    "--budget-json",
    JSON.stringify({ limits: { steps: { soft: 20, hard: 30 } } }),
    "--reason",
    "An amendment must not be accepted before the budget exception checkpoint",
    ...humanApproval("Do not bypass the exception checkpoint"),
  ], /allowed only while .*exception_pending/);

  const initialUsageFixture = writeTrustedUsageReceipt(project, {
    proposalId: "ASSESS-E2E",
    id: "USAGE-ASSESS-E2E",
    usage: { active_time_seconds: 120, steps: 3, tokens: 1500 },
    metering: { active_time_seconds: "exact", steps: "exact", tokens: "estimated" },
  });
  const usage = JSON.parse(mustRun([
    "budget",
    "usage",
    "record",
    "--root",
    project,
    "--proposal",
    "ASSESS-E2E",
    "--receipt-file",
    initialUsageFixture.receiptRelativePath,
    "--json",
  ]).stdout);
  assert.equal(usage.aggregate.usage.active_time_seconds, 120);
  assert.equal(usage.aggregate.usage.tokens, 1500);
  assert.equal(usage.receipt.metering.active_time_seconds, "exact");
  assert.equal(usage.receipt.metering.tokens, "estimated");
  assert.equal(usage.aggregate.metering_violations.length, 0);

  const usageFile = path.join(project, ".sdlc", "budgets", "ASSESS-E2E", "usage", "USAGE-ASSESS-E2E.json");
  const originalUsageBytes = fs.readFileSync(usageFile);
  const replayedUsage = JSON.parse(mustRun([
    "budget",
    "usage",
    "record",
    "--root",
    project,
    "--proposal",
    "ASSESS-E2E",
    "--receipt-file",
    initialUsageFixture.receiptRelativePath,
    "--json",
  ]).stdout);
  assert.equal(replayedUsage.idempotent, true);
  assert.equal(replayedUsage.registration_status, "idempotent_replay");
  assert.equal(replayedUsage.aggregate.usage.active_time_seconds, 120);
  const usageReceiptNames = fs.readdirSync(path.dirname(usageFile)).filter((name) => name.endsWith(".json"));
  assert.equal(usageReceiptNames.length, 3);
  assert.equal(usageReceiptNames.filter((name) => name === "USAGE-ASSESS-E2E.json").length, 1);

  const conflictingUsageFixture = writeTrustedUsageReceipt(project, {
    proposalId: "ASSESS-E2E",
    id: "USAGE-ASSESS-E2E",
    usage: { active_time_seconds: 1, steps: 1, tokens: 1 },
    metering: { active_time_seconds: "exact", steps: "exact", tokens: "estimated" },
    fixtureKey: "USAGE-ASSESS-E2E-CONFLICT",
  });
  mustFail([
    "budget",
    "usage",
    "record",
    "--root",
    project,
    "--proposal",
    "ASSESS-E2E",
    "--receipt-file",
    conflictingUsageFixture.receiptRelativePath,
    "--force",
  ], /append-only|different canonical content/);
  assert.deepEqual(fs.readFileSync(usageFile), originalUsageBytes);

  const concurrentUsageFixture = writeTrustedUsageReceipt(project, {
    proposalId: "ASSESS-E2E",
    id: "USAGE-ASSESS-E2E-CONCURRENT",
    usage: { tokens: 100 },
    metering: { tokens: "estimated" },
    fixtureKey: "USAGE-ASSESS-E2E-CONCURRENT",
  });
  const concurrentUsageArgs = [
    "budget",
    "usage",
    "record",
    "--root",
    project,
    "--proposal",
    "ASSESS-E2E",
    "--receipt-file",
    concurrentUsageFixture.receiptRelativePath,
    "--json",
  ];
  const concurrentUsageRuns = await Promise.all([
    runAsync(concurrentUsageArgs),
    runAsync(concurrentUsageArgs),
  ]);
  for (const result of concurrentUsageRuns) {
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  }
  const concurrentUsageOutputs = concurrentUsageRuns.map((result) => JSON.parse(result.stdout));
  assert.deepEqual(
    concurrentUsageOutputs.map((result) => result.registration_status).sort(),
    ["created", "idempotent_replay"],
  );
  assert.equal(concurrentUsageOutputs[1].aggregate.usage.tokens, 1600);

  const softLimitFixture = writeTrustedUsageReceipt(project, {
    proposalId: "ASSESS-E2E",
    id: "USAGE-ASSESS-E2E-SOFT-LIMIT",
    usage: { steps: 10 },
    metering: { steps: "exact" },
  });
  const exception = JSON.parse(mustRun([
    "budget",
    "usage",
    "record",
    "--root",
    project,
    "--proposal",
    "ASSESS-E2E",
    "--receipt-file",
    softLimitFixture.receiptRelativePath,
    "--json",
  ]).stdout);
  assert.equal(exception.status, "exception_pending");
  assert.equal(exception.aggregate.status, "soft_limit");
  assert.match(exception.assistant_message, /What happened/);
  assert.match(exception.assistant_message, /What I need from you/);
  assert.match(exception.assistant_message, /What an extension authorizes/);
  assert.match(exception.assistant_message, /- Extend:/);
  assert.match(exception.assistant_message, /- Partial:/);
  assert.match(exception.assistant_message, /- Stop:/);
  assert.match(exception.assistant_message, /will not silently raise/i);

  const budgetStatusAtSoftLimit = JSON.parse(mustRun([
    "budget", "status", "--root", project, "--proposal", "ASSESS-E2E", "--trust-custom-rtk-command", "--json",
  ]).stdout);
  assert.equal(budgetStatusAtSoftLimit.aggregate.status, "soft_limit");
  assert.equal(budgetStatusAtSoftLimit.optimization_advisory.action, "checkpoint_required_stop");
  assert.equal(budgetStatusAtSoftLimit.optimization_advisory.usage_adjustment_applied, 0);
  assert.equal(budgetStatusAtSoftLimit.optimization_advisory.gate_override, false);
  assert.equal(budgetStatusAtSoftLimit.rtk_project_cumulative.usage_credit_tokens, 0);
  assert.equal(budgetStatusAtSoftLimit.proposal_optimization_delta.usage_adjustment_applied, 0);
  assert.equal(budgetStatusAtSoftLimit.proposal_optimization_delta.status, "measured");
  assert.equal(budgetStatusAtSoftLimit.proposal_optimization_delta.delta.estimated_tokens_avoided, 600);

  mustFail([
    "optimization", "run", "--root", project, "--proposal", "ASSESS-E2E",
    "--command-json", JSON.stringify(portableRtkTestCommand),
    "--trust-custom-rtk-command",
  ], /Cost gate.*blocks optimization run: soft_limit/u);

  mustFail([
    "budget",
    "amend",
    "--root",
    project,
    "--proposal",
    "ASSESS-E2E",
    "--id",
    "BAMEND-ASSESS-E2E-LOWER-RESERVE",
    "--budget-json",
    JSON.stringify({ completion_reserve_percent: 10 }),
    "--reason",
    "A completion reserve decrease must fail closed",
    ...humanApproval("Do not consume the reserved completion tranche"),
  ], /cannot lower completion_reserve_percent/);

  const hostVerifiedConfigPath = path.join(project, ".sdlc", "config.json");
  const hostVerifiedConfig = readJson(hostVerifiedConfigPath);
  const { publicKey: hostPublicKey, privateKey: hostPrivateKey } = generateKeyPairSync("ed25519");
  hostVerifiedConfig.authority_policy.mode = "host_verified";
  hostVerifiedConfig.authority_policy.trusted_host_keys = [{
    key_id: "host-test-key",
    algorithm: "Ed25519",
    public_key: hostPublicKey.export({ type: "spki", format: "pem" }).toString(),
  }];
  writeJson(hostVerifiedConfigPath, hostVerifiedConfig);
  pinProjectConfig(project);
  mustFail([
    "budget",
    "amend",
    "--root",
    project,
    "--proposal",
    "ASSESS-E2E",
    "--id",
    "BAMEND-ASSESS-E2E-HOST-REQUIRED",
    "--budget-json",
    JSON.stringify({ limits: { steps: { hard: 25 } } }),
    "--reason",
    "Host-verified mode must bind approval to base, changes, and result",
    ...humanApproval("A CLI actor declaration is not a host receipt"),
  ], /signed approval is required|--host-receipt-file/i);

  const insufficientId = "BAMEND-ASSESS-E2E-INSUFFICIENT";
  const insufficientChanges = { limits: { steps: { hard: 25 } } };
  const insufficientReason = "Raising only the hard stop leaves the reached soft checkpoint unchanged";
  const hostApprovedActor = {
    id: "antonio",
    type: "human",
    name: "Antonio",
    email: "antonio@example.test",
    source: "cli",
  };
  const currentApplication = readJson(path.join(project, ".sdlc", "assessments", "applications", "ASSESS-E2E.json"));
  const proposalForHost = readJson(path.join(project, ".sdlc", "assessments", "proposals", "ASSESS-E2E.json"));
  const provisionalHostAmendment = buildBudgetAmendment(
    currentApplication.effective_budget,
    insufficientChanges,
    {
      id: insufficientId,
      reason: insufficientReason,
      created_at: new Date().toISOString(),
      requested_by: hostApprovedActor,
      approved_by: hostApprovedActor,
      proposal_ref: { id: proposalForHost.id, hash: proposalForHost.proposal_hash },
      approval_source: "explicit-user",
    },
  );
  const hostAmendmentSubject = {
    kind: "budget_amendment",
    id: insufficientId,
    proposal_ref: { id: proposalForHost.id, hash: proposalForHost.proposal_hash },
    base_budget_ref: {
      id: provisionalHostAmendment.base_budget_id,
      hash: provisionalHostAmendment.base_budget_hash,
    },
    result_budget_ref: {
      id: provisionalHostAmendment.result_budget.id,
      hash: provisionalHostAmendment.result_budget_hash,
    },
    changes: insufficientChanges,
    changes_hash: computeStableHash(insufficientChanges),
    reason: insufficientReason,
    reason_hash: createHash("sha256").update(insufficientReason).digest("hex"),
    approved_by: hostApprovedActor,
  };
  const signedHostReceipt = buildHostApprovalReceipt({
    id: `HOST-${insufficientId}`,
    action: "budget.amend",
    subject: hostAmendmentSubject,
    subject_ref: {
      kind: "assessment_proposal",
      id: proposalForHost.id,
      path: ".sdlc/assessments/proposals/ASSESS-E2E.json",
      hash: proposalForHost.proposal_hash,
    },
    checkpoint: { type: "budget-amendment", normal_checkpoint: 2 },
    question_contract: {
      asked: `Approve only budget amendment ${insufficientId}?`,
      why: "The recorded steps reached the approved soft checkpoint.",
      authorizes: ["Only the exact hard-limit increase represented by the resulting budget hash."],
      does_not_authorize: ["Scope, tool, production, external-access, or later budget changes."],
      examples: {
        it: [`Approvo solo ${insufficientId} e nessun'altra estensione.`],
        en: [`I approve only ${insufficientId} and no other extension.`],
      },
    },
    decision: "approved",
    response: {
      raw: `I approve ${insufficientId}`,
      normalized_summary: `Approved exact budget amendment ${insufficientId}.`,
      message_hash: createHash("sha256").update(`I approve ${insufficientId}`).digest("hex"),
    },
    decided_at: new Date(Date.now() - 1000).toISOString(),
    decided_by: hostApprovedActor,
    issued_by: { id: "codex-host", type: "system" },
    host: {
      provider: "codex-test-host",
      thread_id: "thread-budget-test",
      message_id: "message-budget-test",
      trust: "host-attested",
    },
    constraints: {
      subject_hash: computeStableHash(hostAmendmentSubject),
      no_scope_expansion: true,
      no_production_access: true,
      no_external_access: true,
    },
    signing: { key_id: "host-test-key", private_key: hostPrivateKey },
  });
  const signedHostReceiptRelativePath = `.sdlc/receipts/host/${insufficientId}.json`;
  fs.mkdirSync(path.dirname(path.join(project, signedHostReceiptRelativePath)), { recursive: true });
  writeJson(path.join(project, signedHostReceiptRelativePath), signedHostReceipt);

  const insufficientAmendment = JSON.parse(mustRun([
    "budget",
    "amend",
    "--root",
    project,
    "--proposal",
    "ASSESS-E2E",
    "--id",
    insufficientId,
    "--budget-json",
    JSON.stringify(insufficientChanges),
    "--reason",
    insufficientReason,
    "--actor-type",
    "human",
    "--actor",
    "antonio",
    "--actor-name",
    "Antonio",
    "--actor-email",
    "antonio@example.test",
    "--approval-source",
    "explicit-user",
    "--summary",
    "Approve only the hard-stop increase and keep the soft checkpoint",
    "--host-receipt-file",
    signedHostReceiptRelativePath,
    "--json",
  ]).stdout);
  assert.equal(insufficientAmendment.status, "exception_pending");
  assert.equal(insufficientAmendment.aggregate.status, "soft_limit");
  assert.equal(insufficientAmendment.workflow.state, "exception_pending");
  assert.equal(insufficientAmendment.amendment.host_approval_receipt_ref.id, signedHostReceipt.id);
  const replayedHostAmendment = JSON.parse(mustRun([
    "budget",
    "amend",
    "--root",
    project,
    "--proposal",
    "ASSESS-E2E",
    "--id",
    insufficientId,
    "--budget-json",
    JSON.stringify(insufficientChanges),
    "--reason",
    insufficientReason,
    "--actor-type",
    "human",
    "--actor",
    "antonio",
    "--actor-name",
    "Antonio",
    "--actor-email",
    "antonio@example.test",
    "--approval-source",
    "explicit-user",
    "--summary",
    "Approve only the hard-stop increase and keep the soft checkpoint",
    "--json",
  ]).stdout);
  assert.equal(replayedHostAmendment.idempotent, true);
  assert.equal(replayedHostAmendment.recovered, false);
  assert.equal(replayedHostAmendment.amendment.host_approval_receipt_ref.id, signedHostReceipt.id);
  hostVerifiedConfig.authority_policy.mode = "audit_only";
  writeJson(hostVerifiedConfigPath, hostVerifiedConfig);
  pinProjectConfig(project);

  const amendmentRecoveryPaths = {
    application: path.join(project, ".sdlc", "assessments", "applications", "ASSESS-E2E.json"),
    snapshot: path.join(project, ".sdlc", "budgets", "ASSESS-E2E", "effective-budget.json"),
    workflow: path.join(project, ".sdlc", "assessments", "workflows", "ASSESS-E2E.json"),
    amendment: path.join(project, ".sdlc", "budgets", "ASSESS-E2E", "amendments", "BAMEND-ASSESS-E2E.json"),
  };
  const beforeSufficientAmendment = {
    application: readJson(amendmentRecoveryPaths.application),
    snapshot: readJson(amendmentRecoveryPaths.snapshot),
    workflow: readJson(amendmentRecoveryPaths.workflow),
  };
  const sufficientAmendmentArgs = [
    "budget",
    "amend",
    "--root",
    project,
    "--proposal",
    "ASSESS-E2E",
    "--id",
    "BAMEND-ASSESS-E2E",
    "--budget-json",
    JSON.stringify({ limits: { steps: { soft: 20, hard: 30 } } }),
    "--reason",
    "Ten exact steps were used; twenty soft and thirty hard preserve room for verification and delivery",
    ...humanApproval("Approve only the stated step limit amendment"),
    "--json",
  ];
  const concurrentAmendmentRuns = await Promise.all([
    runAsync(sufficientAmendmentArgs),
    runAsync(sufficientAmendmentArgs),
  ]);
  for (const result of concurrentAmendmentRuns) {
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  }
  const concurrentAmendmentOutputs = concurrentAmendmentRuns.map((result) => JSON.parse(result.stdout));
  assert.deepEqual(
    concurrentAmendmentOutputs.map((result) => result.registration_status).sort(),
    ["created", "idempotent_replay"],
  );
  const amended = concurrentAmendmentOutputs.find((result) => result.registration_status === "created");
  assert.equal(amended.status, "amended");
  assert.equal(amended.workflow.state, "running");
  assert.equal(amended.effective_budget.limits.steps.soft, 20);
  assert.equal(amended.effective_budget.limits.steps.hard, 30);
  assert.equal(amended.effective_budget.limits.tokens.metering, "estimated");

  const afterSufficientAmendment = {
    application: readJson(amendmentRecoveryPaths.application),
    snapshot: readJson(amendmentRecoveryPaths.snapshot),
    workflow: readJson(amendmentRecoveryPaths.workflow),
    amendment: readJson(amendmentRecoveryPaths.amendment),
  };
  const amendmentRecoveryCutPoints = [
    {
      name: "amendment_seed",
      application: beforeSufficientAmendment.application,
      snapshot: beforeSufficientAmendment.snapshot,
      workflow: beforeSufficientAmendment.workflow,
      expectedActions: ["effective_budget_snapshot", "assessment_application", "assessment_workflow"],
    },
    {
      name: "budget_snapshot",
      application: beforeSufficientAmendment.application,
      snapshot: afterSufficientAmendment.snapshot,
      workflow: beforeSufficientAmendment.workflow,
      expectedActions: ["assessment_application", "assessment_workflow"],
    },
    {
      name: "assessment_application",
      application: afterSufficientAmendment.application,
      snapshot: afterSufficientAmendment.snapshot,
      workflow: beforeSufficientAmendment.workflow,
      expectedActions: ["assessment_workflow"],
    },
    {
      name: "assessment_workflow",
      application: afterSufficientAmendment.application,
      snapshot: afterSufficientAmendment.snapshot,
      workflow: afterSufficientAmendment.workflow,
      expectedActions: [],
    },
  ];
  for (const cutPoint of amendmentRecoveryCutPoints) {
    writeJson(amendmentRecoveryPaths.application, cutPoint.application);
    writeJson(amendmentRecoveryPaths.snapshot, cutPoint.snapshot);
    writeJson(amendmentRecoveryPaths.workflow, cutPoint.workflow);
    writeJson(amendmentRecoveryPaths.amendment, afterSufficientAmendment.amendment);
    const recovered = JSON.parse(mustRun(sufficientAmendmentArgs).stdout);
    assert.equal(recovered.idempotent, true, cutPoint.name);
    assert.equal(recovered.recovered, cutPoint.expectedActions.length > 0, cutPoint.name);
    assert.deepEqual(recovered.recovery_actions, cutPoint.expectedActions, cutPoint.name);
    assert.deepEqual(readJson(amendmentRecoveryPaths.application), afterSufficientAmendment.application, cutPoint.name);
    assert.deepEqual(readJson(amendmentRecoveryPaths.snapshot), afterSufficientAmendment.snapshot, cutPoint.name);
    assert.deepEqual(readJson(amendmentRecoveryPaths.workflow), afterSufficientAmendment.workflow, cutPoint.name);
  }

  const replayedAmendment = JSON.parse(mustRun([
    "budget",
    "amend",
    "--root",
    project,
    "--proposal",
    "ASSESS-E2E",
    "--id",
    "BAMEND-ASSESS-E2E",
    "--budget-json",
    JSON.stringify({ limits: { steps: { soft: 20, hard: 30 } } }),
    "--reason",
    "Ten exact steps were used; twenty soft and thirty hard preserve room for verification and delivery",
    ...humanApproval("Approve only the stated step limit amendment"),
    "--json",
  ]).stdout);
  assert.equal(replayedAmendment.idempotent, true);
  assert.equal(replayedAmendment.registration_status, "idempotent_replay");
  const applicationAfterReplay = readJson(path.join(project, ".sdlc", "assessments", "applications", "ASSESS-E2E.json"));
  assert.equal(applicationAfterReplay.budget_amendments.length, 2);

  mustFail([
    "budget",
    "amend",
    "--root",
    project,
    "--proposal",
    "ASSESS-E2E",
    "--id",
    "BAMEND-ASSESS-E2E",
    "--budget-json",
    JSON.stringify({ limits: { steps: { soft: 21, hard: 31 } } }),
    "--reason",
    "Ten exact steps were used; twenty soft and thirty hard preserve room for verification and delivery",
    ...humanApproval("Approve only the stated step limit amendment"),
    "--force",
  ], /already bound to different canonical content/);

  const finalMeteringFixture = writeTrustedUsageReceipt(project, {
    proposalId: "ASSESS-E2E",
    id: "USAGE-ASSESS-E2E-FINAL",
    usage: { active_time_seconds: 120, api_calls: 90, steps: 10 },
    metering: { active_time_seconds: "exact", api_calls: "exact", steps: "exact" },
  });
  const finalMetering = JSON.parse(mustRun([
    "budget",
    "usage",
    "record",
    "--root",
    project,
    "--proposal",
    "ASSESS-E2E",
    "--receipt-file",
    finalMeteringFixture.receiptRelativePath,
    "--json",
  ]).stdout);
  assert.equal(finalMetering.aggregate.usage.active_time_seconds, 120);
  assert.equal(finalMetering.aggregate.usage.api_calls, 90);
  assert.equal(finalMetering.aggregate.usage.steps, 10);
  assert.equal(finalMetering.aggregate.status, "completion_reserve");

  const budgetStatusAtCompletionReserve = JSON.parse(mustRun([
    "budget", "status", "--root", project, "--proposal", "ASSESS-E2E", "--trust-custom-rtk-command", "--json",
  ]).stdout);
  assert.equal(budgetStatusAtCompletionReserve.aggregate.status, "completion_reserve");
  assert.equal(budgetStatusAtCompletionReserve.aggregate.allowed_for_completion_only, true);
  assert.equal(budgetStatusAtCompletionReserve.optimization_advisory.action, "completion_only");
  assert.equal(budgetStatusAtCompletionReserve.optimization_advisory.usage_adjustment_applied, 0);
  assert.equal(budgetStatusAtCompletionReserve.optimization_advisory.gate_override, false);
  mustFail([
    "optimization", "run", "--root", project, "--proposal", "ASSESS-E2E",
    "--command-json", JSON.stringify(portableRtkTestCommand),
    "--trust-custom-rtk-command",
  ], /completion_reserve.*cannot start new work/u);

  writeArtifact(
    project,
    artifact,
    [
      "# Technical assessment",
      "",
      "## Evidence",
      "The approved baseline shows a modular provider boundary and contract-driven workflow.",
      "",
      "## Findings and improvements",
      "Persist content-bound authorization usage and aggregate exact time and steps while treating estimated tokens as advisory.",
      "",
    ].join("\n"),
  );
  const outputLinkArgs = [
    "output",
    "link",
    "--root",
    project,
    "--story",
    "ST-ASSESS-E2E",
    "--type",
    "technical-analysis",
    "--artifact",
    artifact,
    "--template",
    prepared.proposal.deliverable.template_id,
    "--mode",
    "new",
    "--requirement",
    "REQ-ASSESS-E2E",
    "--authorization",
    approved.authorization.id,
    "--json",
  ];
  const linked = JSON.parse(mustRun(outputLinkArgs).stdout);
  assert.equal(linked.link.verification_receipt.container_verified.status, "verified");
  assert.equal(linked.link.verification_receipt.content_verified.status, "verified");
  assert.equal(linked.link.verification_receipt.render_verified.status, "not-required");
  const authorizationUsesDirectory = path.join(
    project,
    ".sdlc",
    "authorization-uses",
    approved.authorization.id,
  );
  const useReceiptNamesAfterFirstLink = fs.readdirSync(authorizationUsesDirectory)
    .filter((name) => name.endsWith(".json"))
    .sort();
  const linkedAgain = JSON.parse(mustRun(outputLinkArgs).stdout);
  const useReceiptNamesAfterRetry = fs.readdirSync(authorizationUsesDirectory)
    .filter((name) => name.endsWith(".json"))
    .sort();
  assert.equal(
    linkedAgain.link.authorization_use_ref,
    linked.link.authorization_use_ref,
    "an exact output-link retry must reuse its canonical action-subject receipt",
  );
  assert.deepEqual(
    useReceiptNamesAfterRetry,
    useReceiptNamesAfterFirstLink,
    "an exact output-link retry must not consume another proposal authorization use",
  );

  const completionGain = readJson(fakeRtk.reportPath);
  Object.assign(completionGain.summary, {
    total_commands: 13,
    total_input: 6_000,
    total_output: 1_500,
    total_saved: 4_300,
    avg_savings_pct: 71.7,
  });
  writeJson(fakeRtk.reportPath, completionGain);
  const completionReserveWorkflowBeforeRelease = readJson(
    path.join(project, ".sdlc", "assessments", "workflows", "ASSESS-E2E.json"),
  );
  assert.equal(completionReserveWorkflowBeforeRelease.state, "exception_pending");

  const completed = JSON.parse(mustRun([
    "assessment",
    "proposal",
    "complete",
    "--root",
    project,
    "--id",
    "ASSESS-E2E",
    "--actor-type",
    "agent",
    "--trust-custom-rtk-command",
    "--json",
  ]).stdout);
  assert.equal(completed.status, "completed");
  assert.equal(completed.workflow.state, "completed");
  assert.equal(completed.release_manifest.status, "released");
  assert.equal(completed.release_manifest.budget_decision.status, "completion_reserve");
  assert.equal(completed.release_manifest.budget_decision.usage.tokens, 1600);
  assert.equal(completed.release_manifest.budget_decision.usage.api_calls, 90);
  assert.ok(completed.release_manifest.budget_decision.completion_reserve_risks.some(
    (risk) => risk.metric === "api_calls",
  ));
  assert.equal(completed.release_manifest.legacy_history_policy, "logically_archived_out_of_release_scope");
  assert.deepEqual(
    completed.release_manifest.context_optimization_observations.map((reference) => readJson(path.join(project, reference.path)).phase),
    ["apply", "checkpoint", "complete"],
  );
  for (const reference of completed.release_manifest.context_optimization_observations || []) {
    const observation = readJson(path.join(project, reference.path));
    assert.equal(observation.assurance.classification, "advisory_estimated");
    assert.equal(observation.budget_effect.usage_adjustment_applied, 0);
    assert.equal(observation.budget_effect.gate_override, false);
  }

  const completionWorkflowPath = path.join(project, ".sdlc", "assessments", "workflows", "ASSESS-E2E.json");
  writeJson(completionWorkflowPath, completionReserveWorkflowBeforeRelease);
  const recoveredCompletion = JSON.parse(mustRun([
    "assessment", "proposal", "complete", "--root", project, "--id", "ASSESS-E2E",
    "--actor-type", "agent", "--trust-custom-rtk-command", "--json",
  ]).stdout);
  assert.equal(recoveredCompletion.idempotent, true);
  assert.equal(recoveredCompletion.recovered, true);
  assert.equal(recoveredCompletion.workflow.state, "completed");
  assert.equal(recoveredCompletion.release_manifest.manifest_hash, completed.release_manifest.manifest_hash);

  mustFail([
    "budget",
    "amend",
    "--root",
    project,
    "--proposal",
    "ASSESS-E2E",
    "--id",
    "BAMEND-ASSESS-E2E-AFTER-COMPLETION",
    "--budget-json",
    JSON.stringify({ limits: { steps: { soft: 25, hard: 35 } } }),
    "--reason",
    "A completed release must not be retroactively re-budgeted",
    ...humanApproval("Do not mutate a terminal workflow"),
  ], /current state is completed/);

  const gated = JSON.parse(mustRun([
    "gate",
    "check",
    "--root",
    project,
    "--scope",
    "release-manifest",
    "--release-manifest",
    completed.release_manifest.id,
    "--strict",
    "--json",
  ]).stdout);
  assert.equal(gated.status, "passed");
  assert.equal(gated.scope, "release-manifest");
  assert.equal(gated.release_manifest_id, completed.release_manifest.id);

  const manifestPath = path.join(project, completed.application.release_manifest_ref.path);
  const originalManifest = readJson(manifestPath);
  const tamperedManifest = structuredClone(originalManifest);
  tamperedManifest.budget_decision.completion_reserve_risks = [];
  delete tamperedManifest.manifest_hash;
  delete tamperedManifest.hash_algorithm;
  tamperedManifest.manifest_hash = computeStableHash(tamperedManifest);
  tamperedManifest.hash_algorithm = "sha256:stable-json:v1";
  writeJson(manifestPath, tamperedManifest);
  mustFail([
    "gate", "check", "--root", project, "--scope", "release-manifest",
    "--release-manifest", completed.release_manifest.id, "--strict", "--json",
  ], /budget decision does not match independently aggregated usage receipts/);
  writeJson(manifestPath, originalManifest);

  assert.ok(originalManifest.execution_usage_receipts.length > 1);
  const omittedReceiptManifest = structuredClone(originalManifest);
  omittedReceiptManifest.execution_usage_receipts = omittedReceiptManifest.execution_usage_receipts.slice(1);
  delete omittedReceiptManifest.manifest_hash;
  delete omittedReceiptManifest.hash_algorithm;
  omittedReceiptManifest.manifest_hash = computeStableHash(omittedReceiptManifest);
  omittedReceiptManifest.hash_algorithm = "sha256:stable-json:v1";
  writeJson(manifestPath, omittedReceiptManifest);
  mustFail([
    "gate", "check", "--root", project, "--scope", "release-manifest",
    "--release-manifest", completed.release_manifest.id, "--strict", "--json",
  ], /execution usage receipt set does not exactly match the canonical proposal receipt set/u);
  writeJson(manifestPath, originalManifest);
});

test("config migration is reviewed separately before active release history is archived", () => {
  const project = tmpProject("active-migration");
  initProject(project);

  const missingManifest = mustFail([
    "migration",
    "active",
    "--root",
    project,
  ], /Active-only migration needs --release-manifest/);
  const missingManifestMessage = `${missingManifest.stdout}\n${missingManifest.stderr}`;
  for (const explanation of ["What I need:", "Why:", "Example:", "Effect:"]) {
    assert.match(missingManifestMessage, new RegExp(explanation.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  fs.writeFileSync(
    path.join(project, "README.md"),
    "# Migration fixture\n\nTwo immutable releases exercise active-only migration and in-place historical retention.\n",
  );
  mustRun([
    "baseline",
    "propose",
    "--root",
    project,
    "--id",
    "BASELINE-MIGRATION",
    "--source",
    "README.md",
    "--summary",
    "Stable evidence shared by two migration fixture releases",
  ]);
  mustRun([
    "baseline",
    "approve",
    "--root",
    project,
    "--id",
    "BASELINE-MIGRATION",
    ...humanApproval("The migration fixture baseline is accurate"),
  ]);

  const olderRelease = completeAssessmentReleaseFixture(project, "LEGACY", "BASELINE-MIGRATION");
  const activeRelease = completeAssessmentReleaseFixture(project, "ACTIVE", "BASELINE-MIGRATION");
  assert.notEqual(olderRelease.release_manifest.id, activeRelease.release_manifest.id);

  const configPath = path.join(project, ".sdlc", "config.json");
  const legacyConfig = readJson(configPath);
  delete legacyConfig.claim_policy.default_ttl_seconds;
  writeJson(configPath, legacyConfig);
  const configBeforeDryRun = fs.readFileSync(configPath, "utf8");

  const planned = JSON.parse(mustRun([
    "migration",
    "active",
    "--root",
    project,
    "--release-manifest",
    activeRelease.release_manifest.id,
    "--json",
  ]).stdout);
  assert.equal(planned.status, "planned");
  assert.equal(planned.mode, "active-only");
  assert.equal(planned.config_update_required, true);
  assert.equal(planned.config_updated, false);
  assert.equal(planned.historical_releases, 1);
  assert.ok(planned.historical_artifacts > 0);
  assert.equal(planned.logical_archive.written, false);
  assert.equal(planned.physical_files_moved, 0);
  assert.equal(fs.readFileSync(configPath, "utf8"), configBeforeDryRun, "dry-run changed project config");
  assert.equal(fs.existsSync(path.join(project, planned.logical_archive.path)), false, "dry-run wrote an archive record");

  mustFail([
    "migration",
    "active",
    "--root",
    project,
    "--release-manifest",
    activeRelease.release_manifest.id,
    "--apply",
  ], /config migrate.*exact plan/i);
  const configPreview = JSON.parse(mustRun([
    "config",
    "migrate",
    "--root",
    project,
    "--json",
  ]).stdout);
  assert.equal(configPreview.status, "planned");
  assert.equal(configPreview.files_changed, 0);
  assert.equal(configPreview.plan.mode, "reconcile_drift");
  const configApplied = JSON.parse(mustRun([
    "config",
    "migrate",
    "--root",
    project,
    "--apply",
    "--plan-hash",
    configPreview.plan.plan_hash,
    "--actor-type",
    "human",
    "--json",
  ]).stdout);
  assert.equal(configApplied.status, "applied");
  assert.equal(configApplied.trace_warning, null, "exact bootstrap omitted a trace/checkpoint mutation");
  assert.equal(fs.existsSync(path.join(project, configApplied.receipt.path)), true);
  assert.equal(fs.existsSync(path.join(project, ".sdlc", "locks", "config-migration.lock")), false);
  assert.equal(fs.existsSync(path.join(project, ".sdlc", "traces", "project.jsonl.lock")), false);

  const applied = JSON.parse(mustRun([
    "migration",
    "active",
    "--root",
    project,
    "--release-manifest",
    activeRelease.release_manifest.id,
    "--reason",
    "Keep the older released evidence readable while excluding it from the exact active release gate",
    "--apply",
    "--actor-type",
    "human",
    "--json",
  ]).stdout);
  assert.equal(applied.status, "applied");
  assert.equal(applied.config_updated, false);
  assert.equal(applied.logical_archive.written, true);
  assert.equal(applied.logical_archive.idempotent, false);
  assert.equal(applied.physical_files_moved, 0);
  assert.equal(readJson(configPath).claim_policy.default_ttl_seconds, undefined);

  const archivePath = path.join(project, applied.logical_archive.path);
  const archiveRecord = readJson(archivePath);
  assert.equal(archiveRecord.kind, "archive_record");
  assert.equal(archiveRecord.schema_version, "archive-record:v1");
  assert.equal(archiveRecord.release_manifest_ref.id, activeRelease.release_manifest.id);
  assert.equal(archiveRecord.legacy_history_policy, "logically_archived_out_of_release_scope");
  assert.ok(archiveRecord.source_paths.includes(olderRelease.application.release_manifest_ref.path));
  for (const historicalArtifact of archiveRecord.artifacts) {
    const originalPath = path.join(project, historicalArtifact.path);
    assert.equal(fs.existsSync(originalPath), true, `${historicalArtifact.path} was moved or deleted`);
    assert.equal(sha256File(originalPath), historicalArtifact.sha256, `${historicalArtifact.path} changed during migration`);
    assert.equal(historicalArtifact.retention, "retain-in-place");
    assert.equal(historicalArtifact.excluded_from_release, true);
  }

  const archiveFilesBeforeReplay = fs.readdirSync(path.dirname(archivePath)).filter((name) => name.startsWith("ARCH-") && name.endsWith(".json"));
  const replay = JSON.parse(mustRun([
    "migration",
    "active",
    "--root",
    project,
    "--release-manifest",
    activeRelease.release_manifest.id,
    "--apply",
    "--actor-type",
    "human",
    "--json",
  ]).stdout);
  assert.equal(replay.status, "applied");
  assert.equal(replay.config_update_required, false);
  assert.equal(replay.config_updated, false);
  assert.equal(replay.logical_archive.id, applied.logical_archive.id);
  assert.equal(replay.logical_archive.idempotent, true);
  assert.equal(replay.logical_archive.written, false);
  assert.equal(replay.physical_files_moved, 0);
  const archiveFilesAfterReplay = fs.readdirSync(path.dirname(archivePath)).filter((name) => name.startsWith("ARCH-") && name.endsWith(".json"));
  assert.deepEqual(archiveFilesAfterReplay, archiveFilesBeforeReplay);
});

test("onboard existing project initializes KB and proposes approvable baseline", () => {
  const project = tmpProject("onboard-existing");
  fs.mkdirSync(path.join(project, "lib"), { recursive: true });
  fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }, null, 2));
  fs.writeFileSync(path.join(project, "README.md"), "# Legacy App\nCurrent project description.\n");
  fs.writeFileSync(path.join(project, "lib", "implementation.mjs"), "export const ready = true;\n");

  const onboard = JSON.parse(mustRun([
    "onboard",
    "existing-project",
    "--root",
    project,
    "--project-name",
    "Legacy App",
    "--document",
    "README.md",
    "--question",
    "Which inferred facts are canonical?",
    "--json",
  ]).stdout);
  assert.equal(onboard.initialized, true);
  assert.equal(onboard.baseline.status, "proposed");
  assert.match(onboard.assistant_message, /Project context \(BASELINE-INITIAL\)/);
  assert.match(onboard.assistant_message, /Documents I read: README\.md/);
  assert.match(onboard.assistant_message, /Current-state summary to approve/);
  assert.match(onboard.assistant_message, /not homework for you/);
  assert.match(onboard.assistant_message, /approval applies only to the item or items shown/);
  assert.ok(onboard.approval_request.review_items.some((item) => /Project summary I inferred:/.test(item)));
  assert.ok(onboard.approval_request.review_items.some((item) => /Current-state summary to approve:/.test(item)));
  assert.equal(onboard.approval_request.approval_scope.applies_only_to_presented_item, true);
  assert.equal(onboard.approval_request.approval_scope.cannot_approve_future_artifacts, true);
  assert.equal(fs.existsSync(path.join(project, ".sdlc", "project.json")), true);
  assert.equal(fs.existsSync(path.join(project, ".sdlc", "baseline", "BASELINE-INITIAL.json")), true);
  assert.ok(onboard.baseline.imported_documents.some((document) => document.path === "README.md"));
  assert.ok(onboard.baseline.repository_snapshot.detected_stack.some((item) => item.name === "package-json"));
  assert.ok(onboard.baseline.source_paths.includes("lib/implementation.mjs"));

  mustRun([
    "output",
    "template",
    "propose",
    "--root",
    project,
    "--type",
    "technical-analysis",
    "--id",
    "technical-analysis-v1",
    "--summary",
    "This later decision must not leak into the context checkpoint.",
  ]);
  const pendingApprovals = JSON.parse(mustRun(["approval", "requests", "--root", project, "--json"]).stdout);
  assert.deepEqual(Array.from(new Set(pendingApprovals.requests.map((request) => request.type))), ["baseline_approval"]);
  const baselineRequest = pendingApprovals.requests.find((request) => request.type === "baseline_approval");
  assert.ok(baselineRequest);
  assert.ok(baselineRequest.review_items.some((item) => /Documents I read: README\.md/.test(item)));
  assert.ok(baselineRequest.review_items.some((item) => /Current-state report covers:/.test(item)));
  assert.equal(baselineRequest.approval_scope.requires_fresh_confirmation_for_new_artifacts, true);
  assert.match(pendingApprovals.assistant_message, /I will summarize the relevant file contents here/);
  assert.match(pendingApprovals.assistant_message, /Current-state summary to approve/);
  assert.match(pendingApprovals.assistant_message, /Scope of your answer: it applies only to Project context/);

  mustFail(["baseline", "approve", "--root", project, "--id", "BASELINE-INITIAL", "--actor-type", "human"], /requires --approval-source/);
  mustRun(["baseline", "approve", "--root", project, "--id", "BASELINE-INITIAL", ...humanApproval("Confirmed baseline for existing project")]);
  const approved = readJson(path.join(project, ".sdlc", "baseline", "BASELINE-INITIAL.json"));
  assert.equal(approved.status, "approved");
  assert.equal(approved.approvals.at(-1).approval_source, "explicit-user");
  assert.equal(approved.approvals.at(-1).scope.applies_only_to_presented_subject, true);
  assert.equal(approved.approvals.at(-1).scope.does_not_approve_future_artifacts, true);
  const approvedReport = fs.readFileSync(
    path.join(project, ".sdlc", "baseline", "BASELINE-INITIAL-current-state.md"),
    "utf8",
  );
  assert.match(approvedReport, /^Status: approved$/m);
  assert.doesNotMatch(approvedReport, /^Status: proposed$/m);

  fs.appendFileSync(path.join(project, "README.md"), "\nChanged after baseline.\n");
  const status = JSON.parse(mustRun(["baseline", "status", "--root", project, "--id", "BASELINE-INITIAL", "--json"]).stdout);
  assert.equal(status.baselines[0].stale, true);
  assert.equal(status.baselines[0].approved, false);
  assert.equal(status.baselines[0].effective_status, "needs_refresh");
  assert.match(status.baselines[0].next_action, /Refresh the project snapshot/u);

  mustRun(["cache", "rebuild", "--root", project]);
  const cache = readJson(path.join(project, ".sdlc", "cache", "kb-cache.json"));
  assert.ok(cache.source_paths.includes(".sdlc/baseline/BASELINE-INITIAL.json"));
});

test("onboard rejects an incomplete existing bootstrap without adding more partial state", () => {
  const project = tmpProject("onboard-incomplete-bootstrap");
  initProject(project);
  fs.writeFileSync(path.join(project, "README.md"), "# Existing project after interrupted onboarding\n");
  const sdlcRoot = path.join(project, ".sdlc");
  const sdlcReadme = path.join(sdlcRoot, "README.md");
  const outputRegistry = path.join(sdlcRoot, "output-contracts", "registry.json");
  fs.rmSync(sdlcReadme);
  fs.rmSync(outputRegistry);
  const projectHashBefore = sha256File(path.join(sdlcRoot, "project.json"));
  const configHashBefore = sha256File(path.join(sdlcRoot, "config.json"));
  const topLevelEntriesBefore = fs.readdirSync(sdlcRoot).sort();

  mustFail([
    "onboard",
    "existing-project",
    "--root",
    project,
    "--project-name",
    "Interrupted Project",
  ], /bootstrap is incomplete.*No files were changed.*Restore the canonical files/s);

  assert.equal(sha256File(path.join(sdlcRoot, "project.json")), projectHashBefore);
  assert.equal(sha256File(path.join(sdlcRoot, "config.json")), configHashBefore);
  assert.deepEqual(fs.readdirSync(sdlcRoot).sort(), topLevelEntriesBefore);
  assert.equal(fs.existsSync(sdlcReadme), false);
  assert.equal(fs.existsSync(outputRegistry), false);
  assert.equal(fs.existsSync(path.join(sdlcRoot, "baseline", "BASELINE-INITIAL.json")), false);
});

test("onboard accepts a complete existing bootstrap after validating every declared artifact", () => {
  const project = tmpProject("onboard-complete-bootstrap");
  initProject(project);
  fs.writeFileSync(path.join(project, "README.md"), "# Existing project with complete bootstrap\n");

  const payload = JSON.parse(mustRun([
    "onboard",
    "existing-project",
    "--root",
    project,
    "--project-name",
    "Complete Existing Bootstrap",
    "--json",
  ]).stdout);

  assert.equal(payload.status, "onboarded");
  assert.equal(payload.initialized, false);
  assert.equal(payload.init, null);
  const manifestPath = path.join(project, ".sdlc", "bootstrap-manifest.json");
  const manifest = readJson(manifestPath);
  const { manifest_hash: manifestHash, ...hashSubject } = manifest;
  assert.equal(
    validateAgainstSchema(manifest, "project-bootstrap-manifest.schema.json", {
      schemaDir: path.join(repoRoot, "schemas"),
    }).valid,
    true,
  );
  assert.equal(manifestHash, computeStableHash(hashSubject));
  assert.equal(manifest.status, "completed");
  assert.equal(
    fs.existsSync(path.join(project, ".sdlc", "baseline", "BASELINE-INITIAL.json")),
    true,
  );
});

test("onboard resumes exactly once after baseline JSON is committed before its report", () => {
  const project = tmpProject("onboard-resume-after-baseline-json");
  fs.writeFileSync(path.join(project, "README.md"), "# Resumable local project\n");
  const id = "BASELINE-RESUME-REPORT";
  const sdlcRoot = path.join(project, ".sdlc");
  const baselinePath = path.join(sdlcRoot, "baseline", `${id}.json`);
  const reportPath = path.join(sdlcRoot, "baseline", `${id}-current-state.md`);
  const tracePath = path.join(sdlcRoot, "traces", "project.jsonl");
  const preloadMarker = path.join(project, "baseline-report-preload-triggered.txt");
  const args = [
    "onboard",
    "existing-project",
    "--root",
    project,
    "--project-name",
    "Resumable Report Project",
    "--id",
    id,
    "--summary",
    "Exact resumable onboarding request",
    "--json",
  ];

  const interrupted = run(args, {
    env: projectBootstrapPreloadEnv("fail-baseline-report-write", {
      AGENTIC_SDLC_BOOTSTRAP_PRELOAD_BASELINE_REPORT_PATH: reportPath,
      AGENTIC_SDLC_BOOTSTRAP_PRELOAD_MARKER: preloadMarker,
    }),
  });
  assert.notEqual(interrupted.status, 0, `${interrupted.stdout}\n${interrupted.stderr}`);
  assert.equal(fs.readFileSync(preloadMarker, "utf8").trim(), "baseline-report-write");
  assert.equal(fs.existsSync(baselinePath), true);
  assert.equal(fs.existsSync(reportPath), false);
  assert.equal(fs.existsSync(tracePath), false);
  const baselineHash = sha256File(baselinePath);

  const recovered = JSON.parse(mustRun(args).stdout);
  assert.equal(recovered.status, "onboarded");
  assert.equal(recovered.baseline.proposal_intent_hash_algorithm, "sha256:stable-json:v1");
  assert.match(recovered.baseline.proposal_intent_hash, /^[a-f0-9]{64}$/u);
  assert.equal(sha256File(baselinePath), baselineHash);
  assert.equal(fs.existsSync(reportPath), true);
  const reportHash = sha256File(reportPath);
  const proposalTraces = () => readJsonLines(tracePath)
    .filter((event) => event.action === "baseline.propose" && event.related?.includes(id));
  assert.equal(proposalTraces().length, 1);

  mustRun(args);
  assert.equal(sha256File(baselinePath), baselineHash);
  assert.equal(sha256File(reportPath), reportHash);
  assert.equal(proposalTraces().length, 1);
});

test("onboard resumes exactly once after baseline report is committed before its trace", () => {
  const project = tmpProject("onboard-resume-after-baseline-report");
  fs.writeFileSync(path.join(project, "README.md"), "# Resumable trace project\n");
  const id = "BASELINE-RESUME-TRACE";
  const sdlcRoot = path.join(project, ".sdlc");
  const baselinePath = path.join(sdlcRoot, "baseline", `${id}.json`);
  const reportPath = path.join(sdlcRoot, "baseline", `${id}-current-state.md`);
  const tracePath = path.join(sdlcRoot, "traces", "project.jsonl");
  const preloadMarker = path.join(project, "baseline-trace-preload-triggered.txt");
  const args = [
    "onboard",
    "existing-project",
    "--root",
    project,
    "--project-name",
    "Resumable Trace Project",
    "--id",
    id,
    "--summary",
    "Exact trace recovery request",
    "--json",
  ];

  const interrupted = run(args, {
    env: projectBootstrapPreloadEnv("fail-baseline-trace-write", {
      AGENTIC_SDLC_BOOTSTRAP_PRELOAD_TRACE_PATH: tracePath,
      AGENTIC_SDLC_BOOTSTRAP_PRELOAD_MARKER: preloadMarker,
    }),
  });
  assert.notEqual(interrupted.status, 0, `${interrupted.stdout}\n${interrupted.stderr}`);
  assert.equal(fs.readFileSync(preloadMarker, "utf8").trim(), "baseline-trace-write");
  assert.equal(fs.existsSync(baselinePath), true);
  assert.equal(fs.existsSync(reportPath), true);
  assert.equal(fs.existsSync(tracePath), false);
  const baselineHash = sha256File(baselinePath);
  const reportHash = sha256File(reportPath);

  const recovered = JSON.parse(mustRun(args).stdout);
  assert.equal(recovered.status, "onboarded");
  assert.equal(sha256File(baselinePath), baselineHash);
  assert.equal(sha256File(reportPath), reportHash);
  const proposalTraces = () => readJsonLines(tracePath)
    .filter((event) => event.action === "baseline.propose" && event.related?.includes(id));
  assert.equal(proposalTraces().length, 1);

  mustRun(args);
  assert.equal(sha256File(baselinePath), baselineHash);
  assert.equal(sha256File(reportPath), reportHash);
  assert.equal(proposalTraces().length, 1);
});

test("onboard refuses to resume a partial baseline after its source evidence changes", () => {
  const project = tmpProject("onboard-refuse-changed-resume");
  const readmePath = path.join(project, "README.md");
  fs.writeFileSync(readmePath, "# Original onboarding evidence\n");
  const id = "BASELINE-CHANGED-RETRY";
  const sdlcRoot = path.join(project, ".sdlc");
  const baselinePath = path.join(sdlcRoot, "baseline", `${id}.json`);
  const reportPath = path.join(sdlcRoot, "baseline", `${id}-current-state.md`);
  const tracePath = path.join(sdlcRoot, "traces", "project.jsonl");
  const args = [
    "onboard",
    "existing-project",
    "--root",
    project,
    "--project-name",
    "Changed Retry Project",
    "--id",
    id,
    "--summary",
    "Request whose evidence must stay exact",
  ];

  const interrupted = run(args, {
    env: projectBootstrapPreloadEnv("fail-baseline-report-write", {
      AGENTIC_SDLC_BOOTSTRAP_PRELOAD_BASELINE_REPORT_PATH: reportPath,
    }),
  });
  assert.notEqual(interrupted.status, 0);
  assert.equal(fs.existsSync(baselinePath), true);
  assert.equal(fs.existsSync(reportPath), false);
  const baselineHash = sha256File(baselinePath);
  fs.appendFileSync(readmePath, "\nEvidence changed before retry.\n");

  mustFail(
    args,
    /cannot be resumed safely.*different onboarding request or its source evidence changed.*No files were changed.*new --id.*explicitly decide/s,
  );
  assert.equal(sha256File(baselinePath), baselineHash);
  assert.equal(fs.existsSync(reportPath), false);
  assert.equal(fs.existsSync(tracePath), false);
});

test("init cannot overwrite an existing immutable bootstrap manifest", () => {
  const project = tmpProject("init-immutable-bootstrap-manifest");
  initProject(project);
  const sdlcRoot = path.join(project, ".sdlc");
  const manifestPath = path.join(sdlcRoot, "bootstrap-manifest.json");
  const treeBefore = snapshotFilesystemTree(sdlcRoot);

  mustFail([
    "init",
    "--root",
    project,
    "--project-name",
    "Attempted Reinitialization",
    "--force",
  ], /bootstrap is already sealed.*Use the governed configuration and migration commands/s);

  assert.deepEqual(snapshotFilesystemTree(sdlcRoot), treeBefore);
  assert.equal(readJson(manifestPath).status, "completed");
});

test("init --force cannot reseal a completed project after its manifest is deleted", () => {
  const project = tmpProject("init-force-cannot-reseal-deleted-manifest");
  initProject(project, ["--project-id", "sealed-original"]);
  const sdlcRoot = path.join(project, ".sdlc");
  const manifestPath = path.join(sdlcRoot, "bootstrap-manifest.json");
  const journalPath = path.join(sdlcRoot, "bootstrap-journal.json");
  fs.rmSync(manifestPath);
  const treeBefore = snapshotFilesystemTree(sdlcRoot);

  mustFail([
    "init",
    "--root",
    project,
    "--project-name",
    "Attempted Reseal",
    "--project-id",
    "changed-project-identity",
    "--force",
  ], /bootstrap belongs to a different exact initialization request.*No files were changed.*--force cannot change the project identity/isu);

  assert.deepEqual(snapshotFilesystemTree(sdlcRoot), treeBefore);
  assert.equal(readJson(path.join(sdlcRoot, "project.json")).project_id, "sealed-original");
  assert.equal(readJson(journalPath).status, "completed");
  assert.equal(fs.existsSync(manifestPath), false);
});

test("init retries only the exact byte-bound bootstrap interrupted before manifest publication", () => {
  const project = tmpProject("init-recover-exact-bootstrap-journal");
  const sdlcRoot = path.join(project, ".sdlc");
  const manifestPath = path.join(sdlcRoot, "bootstrap-manifest.json");
  const journalPath = path.join(sdlcRoot, "bootstrap-journal.json");
  const markerPath = path.join(project, "bootstrap-recovery-preload-triggered.txt");
  const args = [
    "init",
    "--root",
    project,
    "--project-name",
    "Exact Bootstrap Recovery",
    "--project-id",
    "exact-bootstrap-recovery",
    "--json",
  ];

  const interrupted = run(args, {
    env: projectBootstrapPreloadEnv("fail-manifest-write", {
      AGENTIC_SDLC_BOOTSTRAP_PRELOAD_MANIFEST_PATH: manifestPath,
      AGENTIC_SDLC_BOOTSTRAP_PRELOAD_MARKER: markerPath,
    }),
  });
  assert.notEqual(interrupted.status, 0, `${interrupted.stdout}\n${interrupted.stderr}`);
  assert.equal(fs.readFileSync(markerPath, "utf8").trim(), "manifest-write");
  assert.equal(fs.existsSync(manifestPath), false);
  const readyJournal = readJson(journalPath);
  assert.equal(readyJournal.status, "manifest_ready");
  assert.equal(readyJournal.prepared_manifest.status, "completed");
  assert.equal(Object.hasOwn(readyJournal.request, "project_id"), false);
  assert.equal(Object.hasOwn(readyJournal.request, "project_name"), false);
  assert.equal(
    readyJournal.request.initial_project_identity_sha256,
    computeStableHash({
      project_id: "exact-bootstrap-recovery",
      project_name: "Exact Bootstrap Recovery",
    }),
  );
  assert.equal(
    fs.readFileSync(journalPath, "utf8").includes("Exact Bootstrap Recovery"),
    false,
  );
  const coreTreeBeforeRecovery = snapshotFilesystemTree(sdlcRoot);

  const recovered = JSON.parse(mustRun(args).stdout);
  assert.equal(recovered.status, "initialized");
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.project.project_id, "exact-bootstrap-recovery");
  assert.equal(fs.existsSync(manifestPath), true);
  const completedJournal = readJson(journalPath);
  const recoveredManifest = readJson(manifestPath);
  assert.equal(completedJournal.status, "completed");
  assert.deepEqual(completedJournal.prepared_manifest, recoveredManifest);
  assert.equal(
    completedJournal.completed_manifest_ref.manifest_hash,
    recoveredManifest.manifest_hash,
  );
  assert.equal(
    completedJournal.completed_manifest_ref.hash_algorithm,
    "sha256:stable-json:v1",
  );
  assert.equal(
    completedJournal.completed_manifest_ref.schema_version,
    "project-bootstrap-manifest:v1",
  );
  const coreTreeAfterRecovery = snapshotFilesystemTree(sdlcRoot);
  const coreTreeAfterByPath = new Map(
    coreTreeAfterRecovery.map((entry) => [entry.path, entry]),
  );
  for (const entry of coreTreeBeforeRecovery) {
    if (entry.path === "bootstrap-journal.json") continue;
    assert.deepEqual(
      coreTreeAfterByPath.get(entry.path),
      entry,
      `recovery regenerated ${entry.path}`,
    );
  }
});

test("init with a config-only nested directory overlay fsyncs every bootstrap ancestor before publishing its manifest", (t) => {
  if (process.platform === "win32") {
    t.skip("Windows does not expose portable directory fsync semantics");
    return;
  }
  const project = tmpProject("init-bootstrap-durability-order");
  const templateDir = tmpProject("init-bootstrap-durability-template");
  const sdlcRoot = path.join(project, ".sdlc");
  const manifestPath = path.join(sdlcRoot, "bootstrap-manifest.json");
  const markerPath = path.join(project, "bootstrap-durability-order.txt");
  const config = readJson(path.join(repoRoot, "templates", "sdlc-config.json"));
  config.kb_directories = config.kb_directories
    .filter((directory) => !["contracts", "dependencies"].includes(directory));
  config.kb_directories.push("custom/nested");
  writeJson(path.join(templateDir, "sdlc-config.json"), config);
  const expectedFiles = [
    "config.json",
    "config.lock.json",
    "project.json",
    "README.md",
    ".gitattributes",
    ".gitignore",
    "output-contracts/registry.json",
    "dependencies/graph.json",
    ...config.phase_order.map((phase) => `contracts/contract-${phase}-v1.json`),
  ].map((relativePath) => path.join(sdlcRoot, ...relativePath.split("/")));
  const directoryCandidates = [
    sdlcRoot,
    ...config.kb_directories.map((directory) => path.join(sdlcRoot, directory)),
    path.join(sdlcRoot, "output-contracts", "templates"),
    path.join(sdlcRoot, "output-contracts", "decisions"),
    path.join(sdlcRoot, "work-items", "epics"),
    path.join(sdlcRoot, "work-items", "tasks"),
    ...expectedFiles.map((filePath) => path.dirname(filePath)),
  ];
  const expectedDirectoryClosure = new Set([project]);
  for (const candidate of directoryCandidates) {
    let current = path.resolve(candidate);
    while (true) {
      expectedDirectoryClosure.add(current);
      if (current === sdlcRoot) break;
      current = path.dirname(current);
    }
  }
  const expectedDirectories = [...expectedDirectoryClosure];

  mustRun([
    "init",
    "--root",
    project,
    "--project-name",
    "Durable Bootstrap",
    "--template-dir",
    templateDir,
  ], {
    env: projectBootstrapPreloadEnv("assert-bootstrap-durable-before-manifest", {
      AGENTIC_SDLC_BOOTSTRAP_PRELOAD_MANIFEST_PATH: manifestPath,
      AGENTIC_SDLC_BOOTSTRAP_PRELOAD_EXPECTED_FILES_JSON: JSON.stringify(expectedFiles),
      AGENTIC_SDLC_BOOTSTRAP_PRELOAD_EXPECTED_DIRECTORIES_JSON: JSON.stringify(expectedDirectories),
      AGENTIC_SDLC_BOOTSTRAP_PRELOAD_MARKER: markerPath,
    }),
  });

  assert.equal(fs.readFileSync(markerPath, "utf8").trim(), "durable-before-manifest");
  const manifest = readJson(manifestPath);
  assert.equal(manifest.status, "completed");
  assert.ok(manifest.directories.includes(".sdlc/custom"));
  assert.ok(manifest.directories.includes(".sdlc/custom/nested"));
  assert.ok(manifest.directories.includes(".sdlc/contracts"));
  assert.ok(manifest.directories.includes(".sdlc/dependencies"));

  const onboard = JSON.parse(mustRun([
    "onboard",
    "existing-project",
    "--root",
    project,
    "--project-name",
    "Durable Bootstrap",
    "--template-dir",
    templateDir,
    "--json",
  ]).stdout);
  assert.equal(onboard.initialized, false);
});

test("onboard rejects a bootstrap manifest changed after initialization", () => {
  const project = tmpProject("onboard-tampered-bootstrap-manifest");
  initProject(project);
  fs.writeFileSync(path.join(project, "README.md"), "# Project with tampered bootstrap proof\n");
  const sdlcRoot = path.join(project, ".sdlc");
  const manifestPath = path.join(sdlcRoot, "bootstrap-manifest.json");
  const manifest = readJson(manifestPath);
  manifest.completed_at = new Date(Date.parse(manifest.completed_at) + 1).toISOString();
  writeJson(manifestPath, manifest);
  const treeBefore = snapshotFilesystemTree(sdlcRoot);

  mustFail([
    "onboard",
    "existing-project",
    "--root",
    project,
    "--project-name",
    "Tampered Bootstrap Manifest",
  ], /bootstrap-manifest\.json manifest_hash does not match its content.*No files were changed/s);

  assert.deepEqual(snapshotFilesystemTree(sdlcRoot), treeBefore);
  assert.equal(fs.existsSync(path.join(sdlcRoot, "baseline", "BASELINE-INITIAL.json")), false);
});

test("onboard rejects a self-hashed journal that no longer binds the exact manifest", () => {
  const project = tmpProject("onboard-bootstrap-journal-binding");
  initProject(project);
  fs.writeFileSync(path.join(project, "README.md"), "# Project with changed bootstrap journal\n");
  const sdlcRoot = path.join(project, ".sdlc");
  const journalPath = path.join(sdlcRoot, "bootstrap-journal.json");
  const journal = readJson(journalPath);
  journal.completed_manifest_ref.manifest_hash = "0".repeat(64);
  delete journal.journal_hash;
  journal.journal_hash = computeStableHash(journal);
  writeJson(journalPath, journal);
  const treeBefore = snapshotFilesystemTree(sdlcRoot);

  mustFail([
    "onboard",
    "existing-project",
    "--root",
    project,
    "--project-name",
    "Changed Bootstrap Journal",
  ], /bootstrap-journal\.json does not prove completion of this exact bootstrap manifest.*No files were changed/isu);

  assert.deepEqual(snapshotFilesystemTree(sdlcRoot), treeBefore);
  assert.equal(fs.existsSync(path.join(sdlcRoot, "baseline", "BASELINE-INITIAL.json")), false);
});

test("onboard rejects a bootstrap manifest copied from another project", () => {
  const sourceProject = tmpProject("onboard-bootstrap-cross-project-source");
  const targetProject = tmpProject("onboard-bootstrap-cross-project-target");
  initProject(sourceProject, ["--project-id", "bootstrap-source"]);
  initProject(targetProject, ["--project-id", "bootstrap-target"]);
  fs.writeFileSync(path.join(targetProject, "README.md"), "# Cross-project bootstrap target\n");
  const targetSdlcRoot = path.join(targetProject, ".sdlc");
  fs.rmSync(path.join(targetSdlcRoot, ".gitattributes"));
  fs.rmSync(path.join(targetSdlcRoot, ".gitignore"));
  fs.rmSync(path.join(targetSdlcRoot, "contracts", "contract-design-v1.json"));
  fs.copyFileSync(
    path.join(sourceProject, ".sdlc", "bootstrap-manifest.json"),
    path.join(targetSdlcRoot, "bootstrap-manifest.json"),
  );
  const treeBefore = snapshotFilesystemTree(targetSdlcRoot);

  mustFail([
    "onboard",
    "existing-project",
    "--root",
    targetProject,
    "--project-name",
    "Cross-project bootstrap target",
  ], /bootstrap-manifest\.json belongs to a different project.*No files were changed/s);

  assert.deepEqual(snapshotFilesystemTree(targetSdlcRoot), treeBefore);
  assert.equal(
    fs.existsSync(path.join(targetSdlcRoot, "contracts", "contract-design-v1.json")),
    false,
  );
  assert.equal(
    fs.existsSync(path.join(targetSdlcRoot, "baseline", "BASELINE-INITIAL.json")),
    false,
  );
});

test("onboard rejects a self-consistent bootstrap manifest with a different phase order", () => {
  const project = tmpProject("onboard-bootstrap-phase-order-mismatch");
  initProject(project, ["--project-id", "bootstrap-phase-order"]);
  fs.writeFileSync(path.join(project, "README.md"), "# Bootstrap phase order mismatch\n");
  const sdlcRoot = path.join(project, ".sdlc");
  const manifestPath = path.join(sdlcRoot, "bootstrap-manifest.json");
  const manifest = readJson(manifestPath);
  manifest.phase_order.reverse();
  delete manifest.manifest_hash;
  manifest.manifest_hash = computeStableHash(manifest);
  writeJson(manifestPath, manifest);
  const treeBefore = snapshotFilesystemTree(sdlcRoot);

  mustFail([
    "onboard",
    "existing-project",
    "--root",
    project,
    "--project-name",
    "Bootstrap phase order mismatch",
  ], /bootstrap-manifest\.json phase_order does not match \.sdlc\/project\.json.*No files were changed/s);

  assert.deepEqual(snapshotFilesystemTree(sdlcRoot), treeBefore);
  assert.equal(fs.existsSync(path.join(sdlcRoot, "baseline", "BASELINE-INITIAL.json")), false);
});

test("onboard rejects removing both the manifest and its marker from a new project", () => {
  const project = tmpProject("onboard-bootstrap-downgrade");
  const escapedPluginVersion = readJson(path.join(repoRoot, "package.json"))
    .version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  initProject(project);
  fs.writeFileSync(path.join(project, "README.md"), "# Project with removed bootstrap marker\n");
  const sdlcRoot = path.join(project, ".sdlc");
  fs.rmSync(path.join(sdlcRoot, "bootstrap-manifest.json"));
  const projectPath = path.join(sdlcRoot, "project.json");
  const projectRecord = readJson(projectPath);
  delete projectRecord.bootstrap_manifest;
  writeJson(projectPath, projectRecord);
  const treeBefore = snapshotFilesystemTree(sdlcRoot);

  mustFail([
    "onboard",
    "existing-project",
    "--root",
    project,
    "--project-name",
    "Bootstrap Downgrade",
  ], new RegExp(
    String.raw`bootstrap-manifest\.json is missing for a project created by Agentic SDLC ${escapedPluginVersion}.*require the completed bootstrap record.*No files were changed`,
    "s",
  ));

  assert.deepEqual(snapshotFilesystemTree(sdlcRoot), treeBefore);
  assert.equal(fs.existsSync(path.join(sdlcRoot, "baseline", "BASELINE-INITIAL.json")), false);
});

test("onboard rejects downgrading the project version to disguise a missing new bootstrap manifest", () => {
  const project = tmpProject("onboard-bootstrap-version-downgrade");
  initProject(project);
  fs.writeFileSync(path.join(project, "README.md"), "# Project with downgraded bootstrap version\n");
  const sdlcRoot = path.join(project, ".sdlc");
  fs.rmSync(path.join(sdlcRoot, "bootstrap-manifest.json"));
  const projectPath = path.join(sdlcRoot, "project.json");
  const projectRecord = readJson(projectPath);
  delete projectRecord.bootstrap_manifest;
  projectRecord.sdlc_version = "0.13.0";
  writeJson(projectPath, projectRecord);
  const treeBefore = snapshotFilesystemTree(sdlcRoot);

  mustFail([
    "onboard",
    "existing-project",
    "--root",
    project,
    "--project-name",
    "Bootstrap Version Downgrade",
  ], /bootstrap-manifest\.json is missing.*no matching first-lock migration receipt proves a legacy bootstrap.*changing the project version cannot bypass.*No files were changed/s);

  assert.deepEqual(snapshotFilesystemTree(sdlcRoot), treeBefore);
  assert.equal(fs.existsSync(path.join(sdlcRoot, "baseline", "BASELINE-INITIAL.json")), false);
});

test("config migration cannot manufacture legacy proof for an incomplete newer bootstrap", () => {
  const project = tmpProject("config-migrate-bootstrap-downgrade");
  initProject(project);
  const sdlcRoot = path.join(project, ".sdlc");
  fs.rmSync(path.join(sdlcRoot, "bootstrap-manifest.json"));
  fs.rmSync(path.join(sdlcRoot, "bootstrap-journal.json"));
  fs.rmSync(path.join(sdlcRoot, "config.lock.json"));
  const projectPath = path.join(sdlcRoot, "project.json");
  const projectRecord = readJson(projectPath);
  delete projectRecord.bootstrap_manifest;
  projectRecord.sdlc_version = "0.13.0";
  writeJson(projectPath, projectRecord);
  const treeBefore = snapshotFilesystemTree(sdlcRoot);

  mustFail([
    "config",
    "migrate",
    "--root",
    project,
    "--json",
  ], /missing bootstrap manifest does not match the exact supported v0\.11 bootstrap evidence.*cannot recreate legacy provenance/isu);

  assert.deepEqual(snapshotFilesystemTree(sdlcRoot), treeBefore);
  assert.equal(fs.existsSync(path.join(sdlcRoot, "config.lock.json")), false);
  assert.equal(fs.existsSync(path.join(sdlcRoot, "migrations", "config")), false);
});

test("a legacy-shaped bootstrap still needs a separate direct adoption before migration", () => {
  const project = tmpProject("config-migrate-explicit-legacy-adoption");
  initProject(project);
  const sdlcRoot = path.join(project, ".sdlc");
  fs.rmSync(path.join(sdlcRoot, "bootstrap-manifest.json"));
  fs.rmSync(path.join(sdlcRoot, "bootstrap-journal.json"));
  fs.rmSync(path.join(sdlcRoot, "config.lock.json"));
  fs.rmSync(path.join(sdlcRoot, ".gitattributes"));
  const projectPath = path.join(sdlcRoot, "project.json");
  const projectRecord = readJson(projectPath);
  delete projectRecord.bootstrap_manifest;
  delete projectRecord.bootstrap_journal;
  projectRecord.sdlc_version = "0.11.0";
  writeJson(projectPath, projectRecord);
  fs.copyFileSync(
    path.join(repoRoot, "templates", "config-compat", "sdlc-config-v1-0.11.0.json"),
    path.join(sdlcRoot, "config.json"),
  );

  const preview = JSON.parse(mustRun([
    "config",
    "migrate",
    "--root",
    project,
    "--json",
  ]).stdout);
  assert.equal(preview.legacy_bootstrap_adoption.required, true);
  assert.equal(preview.legacy_bootstrap_adoption.subject.project_ref.sdlc_version, "0.11.0");
  mustFail([
    "config",
    "migrate",
    "--root",
    project,
    "--apply",
    "--plan-hash",
    preview.plan.plan_hash,
    "--actor-type",
    "human",
    "--approval-source",
    "explicit-user",
    "--summary",
    "Attempt migration without the separate adoption confirmation",
  ], /needs a separate explicit adoption.*no migration receipt was written/isu);

  assert.equal(fs.existsSync(path.join(sdlcRoot, "config.lock.json")), false);
  assert.equal(fs.existsSync(path.join(sdlcRoot, "migrations", "config")), false);
});

test("legacy bootstrap CI adoption requires review evidence before writes and remains usable after correction", () => {
  const project = tmpProject("config-migrate-ci-legacy-adoption-evidence");
  initProject(project);
  fs.writeFileSync(path.join(project, "README.md"), "# Complete legacy project knowledge base\n");
  const sdlcRoot = path.join(project, ".sdlc");
  fs.rmSync(path.join(sdlcRoot, "bootstrap-manifest.json"));
  fs.rmSync(path.join(sdlcRoot, "bootstrap-journal.json"));
  fs.rmSync(path.join(sdlcRoot, "config.lock.json"));
  fs.rmSync(path.join(sdlcRoot, ".gitattributes"));
  const projectPath = path.join(sdlcRoot, "project.json");
  const projectRecord = readJson(projectPath);
  delete projectRecord.bootstrap_manifest;
  delete projectRecord.bootstrap_journal;
  projectRecord.sdlc_version = "0.11.0";
  writeJson(projectPath, projectRecord);
  fs.copyFileSync(
    path.join(repoRoot, "templates", "config-compat", "sdlc-config-v1-0.11.0.json"),
    path.join(sdlcRoot, "config.json"),
  );

  const preview = JSON.parse(mustRun([
    "config",
    "migrate",
    "--root",
    project,
    "--json",
  ]).stdout);
  assert.equal(preview.legacy_bootstrap_adoption.required, true);
  const treeBeforeRejectedApply = snapshotFilesystemTree(sdlcRoot);

  mustFail([
    "config",
    "migrate",
    "--root",
    project,
    "--apply",
    "--plan-hash",
    preview.plan.plan_hash,
    "--confirm-legacy-bootstrap",
    "--actor-type",
    "ci",
    "--approval-source",
    "ci",
  ], /requires --summary or --approval-evidence, including for CI approval.*legacy files remain unchanged.*no migration receipt was written/isu);
  assert.deepEqual(snapshotFilesystemTree(sdlcRoot), treeBeforeRejectedApply);

  mustRun([
    "config",
    "migrate",
    "--root",
    project,
    "--apply",
    "--plan-hash",
    preview.plan.plan_hash,
    "--confirm-legacy-bootstrap",
    "--actor-type",
    "ci",
    "--approval-source",
    "ci",
    "--summary",
    "CI reviewed and adopted the exact displayed v0.11 bootstrap",
  ]);

  const migrationReceiptDirectory = path.join(sdlcRoot, "migrations", "config");
  const [migrationReceiptName] = fs.readdirSync(migrationReceiptDirectory)
    .filter((name) => name.endsWith(".json"));
  const migrationReceipt = readJson(
    path.join(migrationReceiptDirectory, migrationReceiptName),
  );
  assert.equal(
    migrationReceipt.legacy_bootstrap_adoption.approval.approval_source,
    "ci",
  );
  assert.equal(
    migrationReceipt.legacy_bootstrap_adoption.approval.summary,
    "CI reviewed and adopted the exact displayed v0.11 bootstrap",
  );

  const onboard = JSON.parse(mustRun([
    "onboard",
    "existing-project",
    "--root",
    project,
    "--project-name",
    "Complete Legacy CI Bootstrap",
    "--json",
  ]).stdout);
  assert.equal(onboard.status, "onboarded");
  assert.equal(onboard.initialized, false);
});

test("onboard rejects a new bootstrap interrupted after graph creation but before its final manifest", () => {
  const project = tmpProject("onboard-interrupted-before-manifest");
  fs.writeFileSync(path.join(project, "README.md"), "# Project interrupted before bootstrap manifest\n");
  const sdlcRoot = path.join(project, ".sdlc");
  const manifestPath = path.join(sdlcRoot, "bootstrap-manifest.json");
  const preloadMarker = path.join(project, "bootstrap-preload-triggered.txt");
  const initResult = run([
    "init",
    "--root",
    project,
    "--project-name",
    "Interrupted Before Manifest",
    "--force",
  ], {
    env: projectBootstrapPreloadEnv("fail-manifest-write", {
      AGENTIC_SDLC_BOOTSTRAP_PRELOAD_MANIFEST_PATH: manifestPath,
      AGENTIC_SDLC_BOOTSTRAP_PRELOAD_MARKER: preloadMarker,
    }),
  });
  assert.notEqual(initResult.status, 0);
  assert.equal(fs.readFileSync(preloadMarker, "utf8").trim(), "manifest-write");
  assert.equal(fs.existsSync(path.join(sdlcRoot, "output-contracts", "registry.json")), true);
  assert.equal(fs.existsSync(path.join(sdlcRoot, "dependencies", "graph.json")), true);
  assert.equal(fs.existsSync(manifestPath), false);
  assert.equal(
    readJson(path.join(sdlcRoot, "project.json")).bootstrap_manifest.path,
    ".sdlc/bootstrap-manifest.json",
  );
  const treeBefore = snapshotFilesystemTree(sdlcRoot);

  mustFail([
    "onboard",
    "existing-project",
    "--root",
    project,
    "--project-name",
    "Interrupted Before Manifest",
  ], /bootstrap-manifest\.json is missing.*project expects the completed bootstrap record.*No files were changed/s);

  assert.deepEqual(snapshotFilesystemTree(sdlcRoot), treeBefore);
  assert.equal(fs.existsSync(path.join(sdlcRoot, "baseline", "BASELINE-INITIAL.json")), false);
});

test("init refuses a project record replaced by a symlink before the bootstrap snapshot", (t) => {
  if (!requireSymlinkSupport(t, "file")) return;
  const project = tmpProject("init-bootstrap-snapshot-symlink-race");
  const sdlcRoot = path.join(project, ".sdlc");
  const projectPath = path.join(sdlcRoot, "project.json");
  const replacementPath = path.join(project, "replacement-project.json");
  const preloadMarker = path.join(project, "bootstrap-snapshot-swap-triggered.txt");
  writeJson(replacementPath, { untrusted_replacement: true });

  const result = run([
    "init",
    "--root",
    project,
    "--project-name",
    "Bootstrap Snapshot Race",
  ], {
    env: projectBootstrapPreloadEnv("replace-project-before-bootstrap-snapshot", {
      AGENTIC_SDLC_BOOTSTRAP_PRELOAD_PROJECT_PATH: projectPath,
      AGENTIC_SDLC_BOOTSTRAP_PRELOAD_REPLACEMENT_PROJECT: replacementPath,
      AGENTIC_SDLC_BOOTSTRAP_PRELOAD_MARKER: preloadMarker,
    }),
  });

  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(fs.readFileSync(preloadMarker, "utf8").trim(), "project-symlink-swap");
  assert.equal(fs.lstatSync(projectPath).isSymbolicLink(), true);
  assert.equal(fs.existsSync(path.join(sdlcRoot, "bootstrap-manifest.json")), false);
  mustFail([
    "onboard",
    "existing-project",
    "--root",
    project,
    "--project-name",
    "Bootstrap Snapshot Race",
  ], /project\.json is not a regular file.*No files were changed/s);
});

test("onboard rejects an interrupted bootstrap that reached the registry but lost project.json", () => {
  const project = tmpProject("onboard-interrupted-after-registry");
  initProject(project);
  fs.writeFileSync(path.join(project, "README.md"), "# Existing project after interrupted onboarding\n");
  const sdlcRoot = path.join(project, ".sdlc");
  const projectPath = path.join(sdlcRoot, "project.json");
  const registryPath = path.join(sdlcRoot, "output-contracts", "registry.json");
  const registryHash = sha256File(registryPath);
  fs.rmSync(projectPath);
  const treeBefore = snapshotFilesystemTree(sdlcRoot);

  mustFail([
    "onboard",
    "existing-project",
    "--root",
    project,
    "--project-name",
    "Interrupted After Registry",
  ], /\.sdlc\/project\.json is missing.*No files were changed.*archive the incomplete \.sdlc/s);

  assert.deepEqual(snapshotFilesystemTree(sdlcRoot), treeBefore);
  assert.equal(sha256File(registryPath), registryHash);
  assert.equal(fs.existsSync(projectPath), false);
  assert.equal(fs.existsSync(path.join(sdlcRoot, "baseline", "BASELINE-INITIAL.json")), false);
});

test("onboard validates current canonical bootstrap records before creating a baseline", () => {
  const project = tmpProject("onboard-bootstrap-record-health");
  initProject(project);
  fs.writeFileSync(path.join(project, "README.md"), "# Existing project with damaged bootstrap records\n");
  const sdlcRoot = path.join(project, ".sdlc");
  const cases = [
    {
      relativePath: "config.lock.json",
      damage(filePath) {
        const record = readJson(filePath);
        record.lock_hash = "0".repeat(64);
        writeJson(filePath, record);
      },
      pattern: /config\.lock\.json does not lock the current configuration/,
    },
    {
      relativePath: "output-contracts/registry.json",
      damage(filePath) {
        const record = readJson(filePath);
        delete record.policy;
        writeJson(filePath, record);
      },
      pattern: /registry\.json does not match the output contract registry schema/,
    },
    {
      relativePath: "dependencies/graph.json",
      damage(filePath) {
        writeJson(filePath, { schema_version: "0.1.0", status: "draft", edges: [] });
      },
      pattern: /graph\.json does not match the dependency graph schema/,
    },
  ];

  for (const fixture of cases) {
    const filePath = path.join(sdlcRoot, ...fixture.relativePath.split("/"));
    const original = fs.readFileSync(filePath);
    fixture.damage(filePath);
    const treeBefore = snapshotFilesystemTree(sdlcRoot);
    mustFail([
      "onboard",
      "existing-project",
      "--root",
      project,
      "--project-name",
      "Damaged Bootstrap",
    ], fixture.pattern);
    assert.deepEqual(
      snapshotFilesystemTree(sdlcRoot),
      treeBefore,
      `onboard mutated the damaged bootstrap for ${fixture.relativePath}`,
    );
    assert.equal(fs.existsSync(path.join(sdlcRoot, "baseline", "BASELINE-INITIAL.json")), false);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, original);
  }
});

test("onboard accepts legitimate scaffold evolution when the immutable bootstrap manifest remains valid", () => {
  const project = tmpProject("onboard-evolved-bootstrap");
  initProject(project);
  fs.writeFileSync(path.join(project, "README.md"), "# Evolved project knowledge base\n");
  const sdlcRoot = path.join(project, ".sdlc");
  const manifestPath = path.join(sdlcRoot, "bootstrap-manifest.json");
  const manifestHash = sha256File(manifestPath);
  const configPath = path.join(sdlcRoot, "config.json");
  const configLockPath = path.join(sdlcRoot, "config.lock.json");
  const evolvedConfig = {
    ...readJson(configPath),
    evolved_bootstrap_policy_marker: true,
  };
  const priorLock = readJson(configLockPath);
  const evolvedLock = buildEffectiveConfigLock({
    effective_config: evolvedConfig,
    config_path: ".sdlc/config.json",
    defaults_profile: priorLock.defaults_profile,
    inherited_paths: priorLock.inherited_paths,
    created_at: new Date(Date.parse(priorLock.created_at) + 1).toISOString(),
  });
  writeJson(configPath, evolvedConfig);
  writeJson(configLockPath, evolvedLock);
  fs.rmSync(path.join(sdlcRoot, ".gitattributes"));
  fs.rmSync(path.join(sdlcRoot, ".gitignore"));
  fs.rmSync(path.join(sdlcRoot, "contracts", "contract-design-v1.json"));
  const dependencyGraphPath = path.join(sdlcRoot, "dependencies", "graph.json");
  const dependencyGraph = readJson(dependencyGraphPath);
  dependencyGraph.edges.push({
    from: "ST-LEGACY",
    to: "ST-NEXT",
    type: "related",
    blocks: "none",
    required_state: "draft",
  });
  writeJson(dependencyGraphPath, dependencyGraph);

  const payload = JSON.parse(mustRun([
    "onboard",
    "existing-project",
    "--root",
    project,
    "--project-name",
    "Evolved Bootstrap",
    "--json",
  ]).stdout);

  assert.equal(payload.status, "onboarded");
  assert.equal(payload.initialized, false);
  assert.equal(sha256File(manifestPath), manifestHash);
  assert.equal(fs.existsSync(path.join(sdlcRoot, ".gitattributes")), false);
  assert.equal(fs.existsSync(path.join(sdlcRoot, ".gitignore")), false);
  assert.equal(fs.existsSync(path.join(sdlcRoot, "contracts", "contract-design-v1.json")), false);
  assert.equal(readJson(dependencyGraphPath).edges.length, 1);
  assert.equal(readJson(configPath).evolved_bootstrap_policy_marker, true);
});

test("onboard accepts a migrated v0.11 bootstrap without inventing later scaffold or a manifest", () => {
  const project = tmpProject("onboard-legacy-bootstrap");
  initProject(project);
  fs.writeFileSync(path.join(project, "README.md"), "# Complete legacy project knowledge base\n");
  const sdlcRoot = path.join(project, ".sdlc");
  const manifestPath = path.join(sdlcRoot, "bootstrap-manifest.json");
  fs.rmSync(manifestPath);
  fs.rmSync(path.join(sdlcRoot, "bootstrap-journal.json"));
  const projectPath = path.join(sdlcRoot, "project.json");
  const projectRecord = readJson(projectPath);
  delete projectRecord.bootstrap_manifest;
  delete projectRecord.bootstrap_journal;
  projectRecord.sdlc_version = "0.11.0";
  writeJson(projectPath, projectRecord);
  const gitAttributesPath = path.join(sdlcRoot, ".gitattributes");
  fs.rmSync(gitAttributesPath);
  const configPath = path.join(sdlcRoot, "config.json");
  const configLockPath = path.join(sdlcRoot, "config.lock.json");
  fs.rmSync(configLockPath);
  fs.copyFileSync(
    path.join(repoRoot, "templates", "config-compat", "sdlc-config-v1-0.11.0.json"),
    configPath,
  );
  const phaseContractPath = path.join(sdlcRoot, "contracts", "contract-design-v1.json");
  const phaseContractHashBefore = sha256File(phaseContractPath);

  const migrationPreview = JSON.parse(mustRun([
    "config",
    "migrate",
    "--root",
    project,
    "--json",
  ]).stdout);
  assert.equal(migrationPreview.plan.mode, "materialize_legacy_defaults");
  assert.equal(migrationPreview.legacy_bootstrap_adoption.required, true);
  mustRun([
    "config",
    "migrate",
    "--root",
    project,
    "--apply",
    "--plan-hash",
    migrationPreview.plan.plan_hash,
    "--confirm-legacy-bootstrap",
    "--actor-type",
    "human",
    "--approval-source",
    "explicit-user",
    "--summary",
    "Adopt the exact displayed v0.11 bootstrap before creating its first lock",
  ]);
  assert.equal(fs.existsSync(configLockPath), true);
  const migrationReceiptDirectory = path.join(sdlcRoot, "migrations", "config");
  const [migrationReceiptName] = fs.readdirSync(migrationReceiptDirectory)
    .filter((name) => name.endsWith(".json"));
  const migrationReceipt = readJson(
    path.join(migrationReceiptDirectory, migrationReceiptName),
  );
  assert.equal(migrationReceipt.legacy_bootstrap_adoption.status, "approved");
  assert.equal(
    migrationReceipt.legacy_bootstrap_adoption.approval.approval_source,
    "explicit-user",
  );

  const payload = JSON.parse(mustRun([
    "onboard",
    "existing-project",
    "--root",
    project,
    "--project-name",
    "Complete Legacy Bootstrap",
    "--json",
  ]).stdout);

  assert.equal(payload.status, "onboarded");
  assert.equal(payload.initialized, false);
  assert.equal(fs.existsSync(manifestPath), false);
  assert.equal(fs.existsSync(gitAttributesPath), false);
  assert.equal(sha256File(phaseContractPath), phaseContractHashBefore);
  assert.equal(fs.existsSync(path.join(sdlcRoot, "baseline", "BASELINE-INITIAL.json")), true);
});

test("onboard rejects valid config and lock content swapped after the command context was loaded", () => {
  const project = tmpProject("onboard-context-drift");
  initProject(project);
  fs.writeFileSync(path.join(project, "README.md"), "# Project with concurrent config evolution\n");
  const sdlcRoot = path.join(project, ".sdlc");
  const configPath = path.join(sdlcRoot, "config.json");
  const lockPath = path.join(sdlcRoot, "config.lock.json");
  const replacementConfigPath = path.join(project, "replacement-config.json");
  const replacementLockPath = path.join(project, "replacement-config.lock.json");
  const preloadMarker = path.join(project, "bootstrap-swap-triggered.txt");
  const currentConfig = readJson(configPath);
  const currentLock = readJson(lockPath);
  const replacementConfig = {
    ...currentConfig,
    concurrent_bootstrap_health_test: true,
  };
  const replacementLock = buildEffectiveConfigLock({
    effective_config: replacementConfig,
    config_path: ".sdlc/config.json",
    defaults_profile: currentLock.defaults_profile,
    inherited_paths: currentLock.inherited_paths,
    created_at: new Date(Date.parse(currentLock.created_at) + 1).toISOString(),
  });
  writeJson(replacementConfigPath, replacementConfig);
  writeJson(replacementLockPath, replacementLock);

  const result = run([
    "onboard",
    "existing-project",
    "--root",
    project,
    "--project-name",
    "Concurrent Context Drift",
  ], {
    env: projectBootstrapPreloadEnv("swap-config-after-context", {
      AGENTIC_SDLC_BOOTSTRAP_PRELOAD_CONFIG_PATH: configPath,
      AGENTIC_SDLC_BOOTSTRAP_PRELOAD_LOCK_PATH: lockPath,
      AGENTIC_SDLC_BOOTSTRAP_PRELOAD_REPLACEMENT_CONFIG: replacementConfigPath,
      AGENTIC_SDLC_BOOTSTRAP_PRELOAD_REPLACEMENT_LOCK: replacementLockPath,
      AGENTIC_SDLC_BOOTSTRAP_PRELOAD_MARKER: preloadMarker,
    }),
  });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(fs.readFileSync(preloadMarker, "utf8").trim(), "config-lock-swap");
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /config\.json changed after the command context was loaded.*config\.lock\.json changed after the command context was loaded/s,
  );
  assert.equal(fs.existsSync(path.join(sdlcRoot, "baseline", "BASELINE-INITIAL.json")), false);
  assert.deepEqual(readJson(configPath), replacementConfig);
  assert.deepEqual(readJson(lockPath), replacementLock);
});

test("onboard rejects a dangling project.json without following or replacing it", (t) => {
  if (!requireSymlinkSupport(t, "file")) return;
  const project = tmpProject("onboard-dangling-project-record");
  initProject(project);
  fs.writeFileSync(path.join(project, "README.md"), "# Existing project with interrupted project record\n");
  const sdlcRoot = path.join(project, ".sdlc");
  const projectPath = path.join(sdlcRoot, "project.json");
  fs.rmSync(projectPath);
  fs.symlinkSync("missing-project-record.json", projectPath);
  const treeBefore = snapshotFilesystemTree(sdlcRoot);

  mustFail([
    "onboard",
    "existing-project",
    "--root",
    project,
    "--project-name",
    "Dangling Project Record",
  ], /\.sdlc\/project\.json is not a regular file.*No files were changed/s);

  assert.deepEqual(snapshotFilesystemTree(sdlcRoot), treeBefore);
  assert.equal(fs.lstatSync(projectPath).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(projectPath), "missing-project-record.json");
  assert.equal(fs.existsSync(path.join(sdlcRoot, "baseline", "BASELINE-INITIAL.json")), false);
});

test("onboard auto-discovers product and architecture evidence for a decision-ready baseline", () => {
  const project = tmpProject("onboard-semantic-context");
  fs.mkdirSync(path.join(project, "docs"), { recursive: true });
  fs.writeFileSync(
    path.join(project, "README.md"),
    "# Route Planner\nA configurable travel operations product for dispatch teams.\n\n## Users\nDispatch operators.\n",
  );
  const lowercaseReadme = path.join(project, "readme.md");
  if (!fs.existsSync(lowercaseReadme)) {
    fs.linkSync(path.join(project, "README.md"), lowercaseReadme);
  }
  fs.writeFileSync(
    path.join(project, "docs", "architecture.md"),
    "# Architecture\n\n## API Gateway\nRoutes requests to modular providers.\n\n## Provider Boundary\nAdapters are replaceable.\n",
  );
  fs.writeFileSync(
    path.join(project, "package.json"),
    JSON.stringify({ name: "route-planner", description: "Travel operations planning", scripts: { test: "node --test" } }, null, 2),
  );

  const payload = JSON.parse(mustRun([
    "onboard",
    "existing-project",
    "--root",
    project,
    "--project-name",
    "Route Planner",
    "--json",
  ]).stdout);

  assert.deepEqual(
    payload.baseline.imported_documents.map((item) => item.path),
    ["README.md", "docs/architecture.md"],
  );
  assert.equal(payload.baseline.inferred_context.product_signal, "Travel operations planning");
  assert.ok(payload.baseline.inferred_context.architecture_signals.some((item) => item.path === "docs/architecture.md"));
  assert.match(payload.assistant_message, /product signal: Travel operations planning/i);
  const report = fs.readFileSync(payload.report_path, "utf8");
  assert.match(report, /## Product Signal/);
  assert.match(report, /## Architecture And Component Signals/);
  assert.match(report, /API Gateway > Provider Boundary/);
});

test("story approvals and strict gates ignore superseded unreferenced baselines", () => {
  const project = tmpProject("active-baseline");
  initProject(project);
  fs.writeFileSync(path.join(project, "README.md"), "# First snapshot\n");
  mustRun([
    "baseline",
    "propose",
    "--root",
    project,
    "--id",
    "BASELINE-OLD",
    "--source",
    "README.md",
    "--summary",
    "Historical context",
  ]);
  fs.writeFileSync(path.join(project, "README.md"), "# Current snapshot\n");
  mustRun([
    "baseline",
    "propose",
    "--root",
    project,
    "--id",
    "BASELINE-CURRENT",
    "--source",
    "README.md",
    "--summary",
    "Current context",
  ]);
  mustRun(["baseline", "approve", "--root", project, "--id", "BASELINE-CURRENT", ...humanApproval("Current context approved")]);

  createStrictReadyStory(project, "ST-001");
  const requests = JSON.parse(mustRun(["approval", "requests", "--root", project, "--story", "ST-001", "--json"]).stdout);
  assert.equal(requests.requests.some((request) => request.subject_id === "BASELINE-OLD"), false);
  assert.doesNotMatch(requests.assistant_message, /BASELINE-OLD/);

  const gate = JSON.parse(mustRun(["gate", "check", "--root", project, "--story", "ST-001", "--strict", "--json"]).stdout);
  assert.equal(gate.status, "passed");
  assert.equal(gate.errors.some((error) => error.includes("BASELINE-OLD")), false);
});

test("stale active baselines request a refresh instead of an impossible approval", () => {
  const project = tmpProject("stale-baseline-refresh");
  initProject(project);
  fs.writeFileSync(path.join(project, "README.md"), "# Proposed context\n");
  mustRun([
    "baseline",
    "propose",
    "--root",
    project,
    "--id",
    "BASELINE-CURRENT",
    "--source",
    "README.md",
    "--summary",
    "Context to refresh",
  ]);
  fs.writeFileSync(path.join(project, "README.md"), "# Changed context\n");

  const requests = JSON.parse(mustRun(["approval", "requests", "--root", project, "--json"]).stdout);
  const refresh = requests.requests.find((request) => request.subject_id === "BASELINE-CURRENT");
  assert.equal(refresh.type, "baseline_refresh_required");
  assert.equal(refresh.status, "needs_refresh");
  assert.match(refresh.why_needed, /changed after it was prepared/);
  assert.match(refresh.suggested_command, /baseline propose[\s\S]*--force/);
  assert.match(requests.assistant_message, /Refresh project context/);
  assert.doesNotMatch(requests.assistant_message, /Can I use the inferred project context/);
});

test("strict gates reject missing historical baselines still referenced by contracts", () => {
  const project = tmpProject("missing-referenced-baseline");
  initProject(project);
  fs.writeFileSync(path.join(project, "README.md"), "# Canonical context\n");
  mustRun([
    "baseline",
    "propose",
    "--root",
    project,
    "--id",
    "BASELINE-USED",
    "--source",
    "README.md",
    "--summary",
    "Context used by the story contract",
  ]);
  mustRun(["baseline", "approve", "--root", project, "--id", "BASELINE-USED", ...humanApproval("Approved used baseline")]);
  story(project, "ST-001", ["--requirement", "REQ-001"]);
  createApprovedTemplate(project);
  mustRun([
    "contract",
    "create",
    "--root",
    project,
    "--phase",
    "design",
    "--story",
    "ST-001",
    "--id",
    "contract-ST-001-design",
    "--context-summary",
    "Design from the approved historical baseline",
    "--context-file",
    ".sdlc/baseline/BASELINE-USED.json",
    "--qa",
    "Which baseline applies?|BASELINE-USED",
    "--output-ref",
    "functional-analysis:functional-analysis-v1:new",
  ]);
  mustRun(["contract", "approve", "--root", project, "--id", "contract-ST-001-design", ...humanApproval("Approved baseline-bound contract")]);
  startStoryTask(project, "ST-001", "design");
  const artifact = writeArtifact(project, ".sdlc/requirements/ST-001-functional-analysis.md");
  mustRun([
    "output",
    "link",
    "--root",
    project,
    "--story",
    "ST-001",
    "--type",
    "functional-analysis",
    "--artifact",
    artifact,
    "--template",
    "functional-analysis-v1",
    "--mode",
    "new",
  ]);
  mustRun([
    "baseline",
    "propose",
    "--root",
    project,
    "--id",
    "BASELINE-NEWER",
    "--source",
    "README.md",
    "--summary",
    "Newer unrelated context",
  ]);
  mustRun(["baseline", "approve", "--root", project, "--id", "BASELINE-NEWER", ...humanApproval("Approved newer baseline")]);
  const passedGate = mustRun(["gate", "check", "--root", project, "--story", "ST-001", "--strict"]);
  const passedGuidance = splitHumanGuidance(passedGate.stdout);
  assert.match(
    passedGuidance.firstLine,
    /^Outcome: The current story check passed, but this is not a final lifecycle certification\.$/i,
  );
  assert.match(
    passedGuidance.primary,
    /did not approve or perform a change, merge, release, deployment, production access, secret access, or work outside the approved files/u,
  );
  assert.match(passedGuidance.technical, /ST-001/u);
  fs.rmSync(path.join(project, ".sdlc", "baseline", "BASELINE-USED.json"));
  mustFail(
    ["gate", "check", "--root", project, "--story", "ST-001", "--strict"],
    /Referenced baseline BASELINE-USED is missing|context source .*BASELINE-USED\.json is missing/,
  );
  const globalGate = run(["gate", "check", "--root", project, "--strict", "--json"]);
  const globalReport = JSON.parse(globalGate.stdout);
  assert.ok(globalReport.errors.some((error) => error.includes("Referenced baseline BASELINE-USED is missing")));
});

test("output duplicate new is blocked before registry write without matching decision", () => {
  const project = tmpProject("duplicate-output");
  initProject(project);
  story(project, "ST-001", ["--requirement", "REQ-001"]);
  story(project, "ST-002", ["--requirement", "REQ-001"]);
  createApprovedTemplate(project);
  createApprovedStoryContract(project, "ST-001");
  createApprovedStoryContract(project, "ST-002");
  startStoryTask(project, "ST-001", "design");
  startStoryTask(project, "ST-002", "design");
  const first = writeArtifact(project, ".sdlc/requirements/ST-001-functional.md");
  const second = writeArtifact(project, ".sdlc/requirements/ST-002-functional.md");
  mustRun([
    "output",
    "link",
    "--root",
    project,
    "--story",
    "ST-001",
    "--type",
    "functional-analysis",
    "--artifact",
    first,
    "--template",
    "functional-analysis-v1",
    "--mode",
    "new",
    "--requirement",
    "REQ-001",
  ]);
  mustFail(
    [
      "output",
      "link",
      "--root",
      project,
      "--story",
      "ST-002",
      "--type",
      "functional-analysis",
      "--artifact",
      second,
      "--template",
      "functional-analysis-v1",
      "--mode",
      "new",
      "--requirement",
      "REQ-001",
    ],
    /duplicates requirements already covered/,
  );
  mustFail(
    [
      "output",
      "link",
      "--root",
      project,
      "--story",
      "ST-002",
      "--type",
      "functional-analysis",
      "--artifact",
      second,
      "--template",
      "functional-analysis-v1",
      "--mode",
      "new",
      "--requirement",
      "REQ-001",
      "--decision-id",
      "DEC-without-rationale",
      ...humanApproval("Approved output override"),
    ],
    /requires --rationale or --approval-evidence/,
  );
  const registry = readJson(path.join(project, ".sdlc", "output-contracts", "registry.json"));
  assert.equal(registry.links.length, 1);
});

test("output override decision cannot be reused for a different link", () => {
  const project = tmpProject("decision-subject");
  initProject(project);
  story(project, "ST-001", ["--requirement", "REQ-001"]);
  story(project, "ST-002", ["--requirement", "REQ-001"]);
  createApprovedTemplate(project);
  createApprovedStoryContract(project, "ST-001");
  createApprovedStoryContract(project, "ST-002");
  startStoryTask(project, "ST-001", "design");
  startStoryTask(project, "ST-002", "design");
  const first = writeArtifact(project, ".sdlc/requirements/ST-001.md");
  const second = writeArtifact(project, ".sdlc/requirements/ST-002.md");
  mustRun([
    "output",
    "link",
    "--root",
    project,
    "--story",
    "ST-001",
    "--type",
    "functional-analysis",
    "--artifact",
    first,
    "--template",
    "functional-analysis-v1",
    "--mode",
    "new",
    "--requirement",
    "REQ-001",
  ]);
  mustRun([
    "output",
    "link",
    "--root",
    project,
    "--story",
    "ST-002",
    "--type",
    "functional-analysis",
    "--artifact",
    second,
    "--template",
    "functional-analysis-v1",
    "--mode",
    "new",
    "--requirement",
    "REQ-001",
    "--decision-id",
    "DEC-override-001",
    "--rationale",
    "Separate artifact approved",
    ...humanApproval("Approved output override"),
  ]);
  const third = writeArtifact(project, ".sdlc/requirements/ST-003.md");
  story(project, "ST-003", ["--requirement", "REQ-001"]);
  const registryPath = path.join(project, ".sdlc", "output-contracts", "registry.json");
  const registry = readJson(registryPath);
  registry.links.push({
    ...registry.links.find((link) => link.story_id === "ST-002"),
    id: "OUT-ST-003-functional-analysis-manual",
    story_id: "ST-003",
    artifact_path: third,
  });
  writeJson(registryPath, registry);
  mustFail(["gate", "check", "--root", project, "--strict"], /approved for a different output link subject/);
});

test("cache tampering is not used as source of truth for output resolve", () => {
  const project = tmpProject("cache-tamper");
  initProject(project);
  story(project, "ST-001", ["--requirement", "REQ-001"]);
  createApprovedTemplate(project);
  mustRun(["cache", "rebuild", "--root", project]);
  const cachePath = path.join(project, ".sdlc", "cache", "kb-cache.json");
  const cache = readJson(cachePath);
  cache.output_resolutions["ST-001::functional-analysis"].recommendation = "linked";
  writeJson(cachePath, cache);
  mustFail(["output", "resolve", "--root", project, "--story", "ST-001", "--type", "functional-analysis"], /cache output resolution differs/i);
});

test("output resolve explains a missing governed format as a decision, not a ready result", () => {
  const project = tmpProject("output-resolve-guidance");
  initProject(project);
  story(project, "ST-001");

  const machine = JSON.parse(mustRun([
    "output", "resolve",
    "--root", project,
    "--story", "ST-001",
    "--type", "implementation-summary",
    "--json",
  ]).stdout);
  assert.equal(machine.recommendation, "template_required");
  assert.equal(machine.status, "needs_user_input");
  assert.equal(machine.decision_required, true);
  assert.match(machine.human_guidance.result, /format .* still missing/u);
  assert.match(machine.human_guidance.required_decision, /Review and approve/u);

  const human = splitHumanGuidance(mustRun([
    "output", "resolve",
    "--root", project,
    "--story", "ST-001",
    "--type", "implementation-summary",
  ]).stdout);
  assert.match(human.firstLine, /^Outcome: A governed format for this result is still missing/u);
  assert.match(human.primary, /Review and approve the proposed structure/u);
  assert.match(human.technical, /template_required/u);
});

test("unsafe config directories are blocked", () => {
  const project = tmpProject("safe-paths");
  const templateDir = tmpProject("bad-template");
  fs.cpSync(path.join(repoRoot, "templates"), templateDir, { recursive: true });
  const configPath = path.join(templateDir, "sdlc-config.json");
  const config = readJson(configPath);
  config.kb_directories = ["../../escape"];
  writeJson(configPath, config);
  mustFail(["init", "--root", project, "--template-dir", templateDir], /unsafe|must match pattern/);
  assert.equal(fs.existsSync(path.resolve(project, "..", "escape")), false);
});

test("config-only template overlays fall back to bundled assets and onboard cleanly", () => {
  const project = tmpProject("config-only-template-overlay");
  const templateDir = tmpProject("config-only-template");
  const config = readJson(path.join(repoRoot, "templates", "sdlc-config.json"));
  config.phase_order.splice(-1, 0, "integration-review");
  config.phases["integration-review"] = {
    ...config.phases.validation,
    purpose: "Review integration boundaries before release.",
    owner_agent: "integration-review-agent",
  };
  writeJson(path.join(templateDir, "sdlc-config.json"), config);
  fs.writeFileSync(path.join(project, "README.md"), "# Existing local monorepo\n");

  const onboard = JSON.parse(mustRun([
    "onboard",
    "existing-project",
    "--root",
    project,
    "--project-name",
    "Existing Local Monorepo",
    "--template-dir",
    templateDir,
    "--json",
  ]).stdout);

  assert.equal(onboard.initialized, true);
  assert.ok(onboard.init.project.phase_order.includes("integration-review"));
  assert.equal(readJson(path.join(project, ".sdlc", "config.json")).phases["integration-review"].owner_agent, "integration-review-agent");
  assert.equal(fs.existsSync(path.join(project, ".sdlc", "contracts", "contract-integration-review-v1.json")), true);
  assert.match(fs.readFileSync(path.join(project, ".sdlc", "README.md"), "utf8"), /Existing Local Monorepo SDLC Knowledge Base/);
  assert.equal(fs.existsSync(path.join(project, ".sdlc", "output-contracts", "registry.json")), true);

  fs.writeFileSync(
    path.join(templateDir, "story-plan.md"),
    "# Custom integration plan for {{STORY_ID}}\n",
    "utf8",
  );
  mustRun([
    "story",
    "create",
    "--root",
    project,
    "--id",
    "ST-INTEGRATION-REVIEW",
    "--title",
    "Review integration boundaries",
    "--phase",
    "integration-review",
    "--template-dir",
    templateDir,
  ]);
  assert.match(
    fs.readFileSync(path.join(project, ".sdlc", "stories", "ST-INTEGRATION-REVIEW", "plan.md"), "utf8"),
    /Custom integration plan for ST-INTEGRATION-REVIEW/,
  );
  assert.match(fs.readFileSync(path.join(project, ".sdlc", "stories", "ST-INTEGRATION-REVIEW", "implementation-log.md"), "utf8"), /ST-INTEGRATION-REVIEW/);

  mustRun([
    "output",
    "template",
    "propose",
    "--root",
    project,
    "--type",
    "technical-analysis",
    "--id",
    "technical-assessment-overlay",
    "--preset",
    "technical-assessment",
    "--template-dir",
    templateDir,
  ]);
  assert.equal(fs.existsSync(path.join(project, ".sdlc", "output-contracts", "templates", "technical-assessment-overlay.md")), true);

  const doctor = JSON.parse(mustRun(["doctor", "--root", project, "--json"]).stdout);
  assert.equal(doctor.status, "passed");
  assert.equal(doctor.checks.find((check) => check.id === "effective-config").status, "passed");
  assert.equal(doctor.checks.find((check) => check.id === "output-registry").status, "passed");
});

test("invalid custom template assets fail before project initialization writes", () => {
  const project = tmpProject("invalid-template-overlay");
  const templateDir = tmpProject("invalid-template");
  fs.copyFileSync(
    path.join(repoRoot, "templates", "sdlc-config.json"),
    path.join(templateDir, "sdlc-config.json"),
  );
  fs.mkdirSync(path.join(templateDir, "kb-readme.md"));
  fs.writeFileSync(path.join(project, "README.md"), "# Existing local project\n");

  mustFail([
    "onboard",
    "existing-project",
    "--root",
    project,
    "--template-dir",
    templateDir,
  ], /Custom template overlay asset must be a readable regular file/);
  assert.equal(fs.existsSync(path.join(project, ".sdlc")), false);
});

test("template overlays require configuration before project initialization writes", () => {
  const project = tmpProject("missing-template-overlay-config");
  const templateDir = tmpProject("missing-template-config");
  fs.writeFileSync(path.join(templateDir, "kb-readme.md"), "# Custom readme\n");
  fs.writeFileSync(path.join(project, "README.md"), "# Existing local project\n");

  mustFail([
    "onboard",
    "existing-project",
    "--root",
    project,
    "--template-dir",
    templateDir,
  ], /Unable to read required template configuration.*sdlc-config\.json/);
  assert.equal(fs.existsSync(path.join(project, ".sdlc")), false);
});

test("custom template symlinks fail before project initialization writes", (t) => {
  if (!requireSymlinkSupport(t, "file")) return;
  const project = tmpProject("symlink-template-overlay");
  const templateDir = tmpProject("symlink-template");
  fs.copyFileSync(
    path.join(repoRoot, "templates", "sdlc-config.json"),
    path.join(templateDir, "sdlc-config.json"),
  );
  fs.symlinkSync(
    path.join(repoRoot, "templates", "kb-readme.md"),
    path.join(templateDir, "kb-readme.md"),
  );
  fs.writeFileSync(path.join(project, "README.md"), "# Existing local project\n");

  mustFail([
    "onboard",
    "existing-project",
    "--root",
    project,
    "--template-dir",
    templateDir,
  ], /Custom template overlay asset must be a readable regular file/);
  assert.equal(fs.existsSync(path.join(project, ".sdlc")), false);
});

test("symlink context escapes are blocked", (t) => {
  if (!requireSymlinkSupport(t, "file")) return;
  const project = tmpProject("safe-paths-symlink");
  initProject(project);
  const outside = path.join(os.tmpdir(), `outside-${Date.now()}.md`);
  fs.writeFileSync(outside, "outside");
  fs.symlinkSync(outside, path.join(project, "outside-link.md"));
  mustFail(
    ["contract", "create", "--root", project, "--phase", "design", "--context-file", "outside-link.md"],
    /outside the target project root/,
  );
});

test("portable IDs reject Windows device names while valid dotted paths stay inside the project", () => {
  const project = tmpProject("portable-identifiers");
  initProject(project);
  for (const id of ["CON", "lpt1.audit", "story."]) {
    mustFail(
      ["story", "create", "--root", project, "--id", id, "--title", "Portable story", "--acceptance", "Portable"],
      /Invalid id/,
    );
  }

  const contextFile = writeArtifact(project, "..context/portable.md", "# Portable context\n");
  mustRun([
    "contract",
    "create",
    "--root",
    project,
    "--phase",
    "analysis",
    "--id",
    "contract-portable-context",
    "--context-summary",
    "Use a valid project directory whose name starts with two periods.",
    "--context-file",
    contextFile,
    "--qa",
    "Is the context inside the project?|Yes",
  ]);
});

test("test and release traces require real canonical evidence in strict mode", () => {
  const project = tmpProject("trace-evidence");
  initProject(project);
  createStrictReadyStory(project, "ST-001");
  const storyPath = path.join(project, ".sdlc", "stories", "ST-001", "story.json");
  const storyData = readJson(storyPath);
  writeJson(storyPath, { ...storyData, phase: "validation", status: "validation" });
  mustRun(["trace", "append", "--root", project, "--story", "ST-001", "--type", "test", "--summary", "Tests passed"]);
  mustFail(["gate", "check", "--root", project, "--story", "ST-001", "--strict"], /test trace requires at least one evidence path/);

  const evidence = writeArtifact(project, ".sdlc/tests/ST-001-test-run.json", "{}\n");
  mustRun([
    "trace",
    "append",
    "--root",
    project,
    "--story",
    "ST-001",
    "--type",
    "test",
    "--outcome",
    "passed",
    "--summary",
    "Tests passed",
    "--evidence",
    evidence.replaceAll("/", "\\"),
  ]);
  const testTrace = readJsonLines(path.join(project, ".sdlc", "traces", "ST-001.jsonl")).at(-1);
  assert.equal(testTrace.evidence.length, 1);
  assert.match(
    testTrace.evidence[0],
    /^\.sdlc\/traces\/evidence\/TR-[A-Za-z0-9._-]+\/01-ST-001-test-run\.json$/,
  );
  assert.deepEqual(testTrace.evidence_sources, [{
    source_path: evidence,
    snapshot_path: testTrace.evidence[0],
  }]);
  const evidenceSnapshot = path.join(project, ...testTrace.evidence[0].split("/"));
  assert.deepEqual(readJson(evidenceSnapshot), {});
  fs.writeFileSync(path.join(project, ...evidence.split("/")), "{\"mutated\":true}\n");
  assert.deepEqual(readJson(evidenceSnapshot), {});
  writeJson(storyPath, { ...storyData, phase: "release", status: "release" });
  mustRun([
    "trace",
    "append",
    "--root",
    project,
    "--story",
    "ST-001",
    "--type",
    "release",
    "--outcome",
    "ready",
    "--summary",
    "Release ready",
  ]);
  mustFail(["gate", "check", "--root", project, "--story", "ST-001", "--strict"], /release.*requires at least one evidence path/);
});

test("strict gates use the latest test outcome while retaining failed attempts", () => {
  const project = tmpProject("trace-latest-outcome");
  initProject(project);
  createStrictReadyStory(project, "ST-001");
  mustRun(["story", "claim", "--root", project, "--id", "ST-001", "--agent", "codex"]);
  const storyPath = path.join(project, ".sdlc", "stories", "ST-001", "story.json");
  const storyData = readJson(storyPath);
  writeJson(storyPath, { ...storyData, phase: "validation", status: "validation" });
  const evidence = writeArtifact(project, ".sdlc/tests/ST-001-test-run.json", "{\"passed\":true}\n");
  const appendOutcome = (outcome) => mustRun([
    "trace",
    "append",
    "--root",
    project,
    "--story",
    "ST-001",
    "--type",
    "test",
    "--outcome",
    outcome,
    "--summary",
    `Tests ${outcome}`,
    "--evidence",
    evidence,
  ]);
  appendOutcome("failed");
  mustFail(["gate", "check", "--root", project, "--story", "ST-001", "--strict"], /latest test trace outcome must be passed/);
  appendOutcome("passed");
  // A story in validation also owes the credential scan its configuration
  // declares; this case is about the test outcome, so satisfy that gate too.
  mustRun(["secret", "scan", "--root", project, "--story", "ST-001"]);
  const legacyStrictReceipt = JSON.parse(mustRun([
    "gate", "check", "--root", project, "--story", "ST-001", "--strict", "--json",
  ]).stdout);
  assert.equal(
    legacyStrictReceipt.schema_version,
    "workflow-strict-gate-receipt:v1",
  );
  assert.equal(Object.hasOwn(legacyStrictReceipt, "workflow_scope"), false);
  appendOutcome("failed");
  mustFail(["gate", "check", "--root", project, "--story", "ST-001", "--strict"], /latest test trace outcome must be passed/);
});

test("handoff open items block strict gate and handoff close clears them", () => {
  const project = tmpProject("handoff");
  initProject(project);
  createStrictReadyStory(project, "ST-001");
  const handoffArtifact = writeArtifact(project, "docs/handoff-artifact.md", "# Handoff artifact\n");
  mustRun([
    "story",
    "handoff",
    "--root",
    project,
    "--id",
    "ST-001",
    "--to-agent",
    "validation-agent",
    "--artifact",
    handoffArtifact.replaceAll("/", "\\"),
    "--open-item",
    "Need reviewer",
  ]);
  mustFail(["gate", "check", "--root", project, "--story", "ST-001", "--strict"], /has open items/);
  const handoffRecord = readJson(path.join(project, ".sdlc", "handoffs", fs.readdirSync(path.join(project, ".sdlc", "handoffs"))[0]));
  const handoffId = handoffRecord.id;
  assert.deepEqual(handoffRecord.required_artifacts, [handoffArtifact]);
  mustRun(["story", "handoff", "close", "--root", project, "--id", handoffId, "--status", "closed"]);
  mustRun(["gate", "check", "--root", project, "--story", "ST-001", "--strict"]);
});

test("gate reports can be persisted", () => {
  const project = tmpProject("gate-report");
  initProject(project);
  createStrictReadyStory(project, "ST-001");
  mustRun(["gate", "check", "--root", project, "--story", "ST-001", "--strict", "--out", ".sdlc/reports/ST-001-gate-report.json"]);
  const report = readJson(path.join(project, ".sdlc", "reports", "ST-001-gate-report.json"));
  assert.equal(report.status, "passed");
  assert.equal(report.story_id, "ST-001");
  assert.equal(report.root, ".");
  assert.equal(report.root_name, path.basename(project));
  mustRun(["gate", "check", "--root", project, "--story", "ST-001", "--strict", "--out", ".sdlc/reports/ST-001-gate-report.md"]);
  assert.match(fs.readFileSync(path.join(project, ".sdlc", "reports", "ST-001-gate-report.md"), "utf8"), /SDLC Gate Report/);
});

test("output artifact and template changes after approval/link are gated", () => {
  const project = tmpProject("fingerprints");
  initProject(project);
  createStrictReadyStory(project, "ST-001");
  fs.appendFileSync(path.join(project, ".sdlc", "requirements", "ST-001-functional-analysis.md"), "\nchanged\n");
  mustFail(["gate", "check", "--root", project, "--story", "ST-001", "--strict"], /changed after it was linked/);
});

test("phase locks reject concurrent active locks on the same scope", () => {
  const project = tmpProject("locks");
  initProject(project);
  mustRun(["phase", "lock", "--root", project, "--phase", "analysis", "--scope", "shared"]);
  mustFail(["phase", "lock", "--root", project, "--phase", "analysis", "--scope", "shared"], /already has active lock/);
});

test("work items and approved breakdown are persisted and indexed as canonical KB", () => {
  const project = tmpProject("work-breakdown");
  initProject(project);
  story(project, "ST-001", ["--requirement", "REQ-001"]);
  mustRun(["work", "item", "create", "--root", project, "--type", "epic", "--id", "EP-001", "--title", "Epic 001", "--requirement", "REQ-001"]);
  mustRun(["work", "item", "create", "--root", project, "--type", "task", "--id", "TASK-001", "--title", "Task 001", "--parent", "EP-001", "--story", "ST-001"]);
  mustRun([
    "breakdown",
    "propose",
    "--root",
    project,
    "--id",
    "BD-REQ-001",
    "--requirement",
    "REQ-001",
    "--item",
    "epic:EP-001",
    "--item",
    "story:ST-001",
    "--item",
    "task:TASK-001",
    "--rationale",
    "Split requirement into epic, story, and task",
  ]);
  mustRun(["breakdown", "approve", "--root", project, "--id", "BD-REQ-001", ...humanApproval("Approved breakdown")]);
  const breakdown = readJson(path.join(project, ".sdlc", "work-breakdown", "BD-REQ-001.json"));
  assert.equal(breakdown.status, "approved");
  assert.equal(readJson(path.join(project, ".sdlc", "work-items", "epics", "EP-001.json")).type, "epic");
  mustRun(["cache", "rebuild", "--root", project]);
  const cache = readJson(path.join(project, ".sdlc", "cache", "kb-cache.json"));
  assert.ok(cache.source_paths.includes(".sdlc/work-breakdown/BD-REQ-001.json"));
  assert.ok(cache.source_paths.includes(".sdlc/dependencies/graph.json"));
});

test("breakdown policy accepts repeatable hierarchy levels", () => {
  const project = tmpProject("breakdown-levels");
  initProject(project);
  const updated = JSON.parse(mustRun([
    "breakdown",
    "policy",
    "set",
    "--root",
    project,
    "--levels",
    "requirement",
    "--levels",
    "epic",
    "--levels",
    "story",
    "--json",
  ]).stdout);
  assert.deepEqual(updated.policy.levels, ["requirement", "epic", "story"]);
  const shown = JSON.parse(mustRun(["breakdown", "policy", "show", "--root", project, "--json"]).stdout);
  assert.deepEqual(shown.levels, ["requirement", "epic", "story"]);
});

test("strict gate blocks story delivery when referenced breakdown is not approved", () => {
  const project = tmpProject("breakdown-gate");
  initProject(project);
  createStrictReadyStory(project, "ST-001");
  const storyPath = path.join(project, ".sdlc", "stories", "ST-001", "story.json");
  const storyData = readJson(storyPath);
  writeJson(storyPath, { ...storyData, status: "implementation", phase: "implementation", work_breakdown_id: "BD-REQ-001" });
  mustRun(["story", "claim", "--root", project, "--id", "ST-001", "--agent", "codex", "--branch", "feature/ST-001"]);
  mustRun([
    "breakdown",
    "propose",
    "--root",
    project,
    "--id",
    "BD-REQ-001",
    "--requirement",
    "REQ-001",
    "--item",
    "story:ST-001",
  ]);
  mustFail(["gate", "check", "--root", project, "--story", "ST-001", "--strict"], /not approved/);
});

test("contract capability policy requires bindings and rejects overlaps", () => {
  const project = tmpProject("capability-contract");
  initProject(project);
  story(project, "ST-001", [
    "--requirement", "REQ-001",
    "--phase", "implementation",
    "--status", "ready",
  ]);
  createApprovedTemplate(project, "functional-analysis");
  const policy = JSON.stringify({
    skills: { required: ["agentic-sdlc"], allowed: [], forbidden: [] },
    mcp: { required: ["repo"], allowed: [], forbidden: [] },
    tools: { required: [], allowed: ["test-runner"], forbidden: [] },
    approval_required_for: ["production_write"],
  });
  const binding = JSON.stringify({
    type: "mcp",
    name: "repo",
    binding_id: "repo-main",
    target: { root_path: path.join(path.dirname(project), "approved-external-repo") },
    permissions: ["read"],
  });
  const unboundContractArgs = [
    "contract",
    "create",
    "--root",
    project,
    "--phase",
    "implementation",
    "--story",
    "ST-001",
    "--id",
    "contract-ST-001-implementation",
    "--context-summary",
    "Implementation capability contract",
    "--qa",
    "Who approves?|Owner",
    "--output-ref",
    "functional-analysis:functional-analysis-v1:new",
    "--capability-policy-json",
    policy,
    "--force",
  ];
  mustFail(unboundContractArgs, /required mcp capability 'repo' has no concrete binding/);
  assert.equal(
    fs.existsSync(path.join(project, ".sdlc", "contracts", "contract-ST-001-implementation.json")),
    false,
  );
  mustRun([...unboundContractArgs, "--allow-incomplete-contract"]);
  const incompleteContractPath = path.join(
    project,
    ".sdlc",
    "contracts",
    "contract-ST-001-implementation.json",
  );
  mustRun([
    "contract",
    "approve",
    "--root",
    project,
    "--id",
    "contract-ST-001-implementation",
    "--status",
    "changes_requested",
    ...humanApproval("Add the missing concrete capability binding"),
  ]);
  const approvalCountBeforeRejectedApproval = readJson(incompleteContractPath).approvals.length;
  mustFail(
    ["contract", "approve", "--root", project, "--id", "contract-ST-001-implementation", ...humanApproval("Approved implementation contract")],
    /cannot be approved because its work brief is incomplete/,
  );
  assert.equal(
    readJson(incompleteContractPath).approvals.length,
    approvalCountBeforeRejectedApproval,
    "a rejected approval attempt must not append a partial approval record",
  );
  const incompleteStart = JSON.parse(mustRun([
    "task",
    "start",
    "--root",
    project,
    "--json",
    "--contract-id",
    "contract-ST-001-implementation",
    "--intent-json",
    routeIntent({
      requested_action: "implement_story",
      referenced_entities: [{ type: "story", id: "ST-001" }],
      proposed_phase: "implementation",
    }),
    "--confirm-start",
    "--actor-type",
    "human",
  ]).stdout);
  assert.equal(incompleteStart.execution_allowed, false);
  assert.ok(incompleteStart.blocking_reasons.includes("contract_incomplete"));
  assert.ok(incompleteStart.questions.some((question) => question.includes("'repo'")));
  assert.equal(
    fs.existsSync(path.join(project, ".sdlc", "stories", "ST-001", "task-start.json")),
    false,
  );
  const emptyTargetBinding = JSON.stringify({
    type: "mcp",
    name: "repo",
    binding_id: "repo-empty",
    target: {},
  });
  mustFail(
    [...unboundContractArgs, "--capability-binding-json", emptyTargetBinding],
    /missing a concrete target object/,
  );
  mustRun([
    "contract",
    "create",
    "--root",
    project,
    "--phase",
    "implementation",
    "--story",
    "ST-001",
    "--id",
    "contract-ST-001-implementation-v2",
    "--replace-story-contract",
    "--context-summary",
    "Implementation capability contract",
    "--qa",
    "Who approves?|Owner",
    "--output-ref",
    "functional-analysis:functional-analysis-v1:new",
    "--capability-policy-json",
    policy,
    "--capability-binding-json",
    binding,
  ]);
  mustRun(["contract", "approve", "--root", project, "--id", "contract-ST-001-implementation-v2", ...humanApproval("Approved implementation contract")]);
  const validContractPath = path.join(
    project,
    ".sdlc",
    "contracts",
    "contract-ST-001-implementation-v2.json",
  );
  const readyStart = JSON.parse(mustRun([
    "task", "start",
    "--root", project,
    "--json",
    "--contract-id", "contract-ST-001-implementation-v2",
    "--intent-json", routeIntent({
      requested_action: "implement_story",
      referenced_entities: [{ type: "story", id: "ST-001" }],
      proposed_phase: "implementation",
    }),
  ]).stdout);
  assert.equal(readyStart.contract_action, "confirm_start");
  assert.equal(readyStart.blocking_reasons.includes("contract_incomplete"), false);
  const historicalApprovedContract = readJson(validContractPath);
  historicalApprovedContract.capability_bindings = [];
  historicalApprovedContract.approvals.at(-1).approved_content_hash =
    computeGovernedApprovalSubjectHash(historicalApprovedContract);
  writeJson(validContractPath, historicalApprovedContract);
  const historicalStart = JSON.parse(mustRun([
    "task",
    "start",
    "--root",
    project,
    "--json",
    "--contract-id",
    "contract-ST-001-implementation-v2",
    "--intent-json",
    routeIntent({
      requested_action: "implement_story",
      referenced_entities: [{ type: "story", id: "ST-001" }],
      proposed_phase: "implementation",
    }),
    "--confirm-start",
    "--actor-type",
    "human",
  ]).stdout);
  assert.equal(historicalStart.execution_allowed, false);
  assert.ok(historicalStart.blocking_reasons.includes("contract_incomplete"));
  assert.ok(historicalStart.questions.some((question) => question.includes("'repo'")));
  assert.equal(
    fs.existsSync(path.join(project, ".sdlc", "stories", "ST-001", "task-start.json")),
    false,
  );

  const skillsOnlyPolicy = JSON.stringify({
    skills: { required: ["agentic-sdlc"], allowed: [], forbidden: [] },
    mcp: { required: [], allowed: [], forbidden: [] },
    tools: { required: [], allowed: ["node"], forbidden: [] },
    approval_required_for: [],
  });
  mustRun([
    "contract",
    "create",
    "--root",
    project,
    "--phase",
    "analysis",
    "--id",
    "contract-skills-only",
    "--context-summary",
    "Skills and optional tools do not require concrete bindings.",
    "--qa",
    "Which capability scope applies?|Skills required and tools optional",
    "--capability-policy-json",
    skillsOnlyPolicy,
  ]);

  const openQuestionPolicy = JSON.stringify({
    skills: { required: [], allowed: [], forbidden: [] },
    mcp: { required: [], allowed: [], forbidden: [] },
    tools: { required: ["node"], allowed: [], forbidden: [] },
    approval_required_for: [],
  });
  mustRun([
    "contract",
    "create",
    "--root",
    project,
    "--phase",
    "analysis",
    "--id",
    "contract-open-capability-question",
    "--context-summary",
    "Persist an explicit capability clarification draft.",
    "--question",
    "Which concrete tools target and permissions should node use?",
    "--capability-policy-json",
    openQuestionPolicy,
    "--allow-incomplete-contract",
  ]);
  mustFail([
    "contract",
    "approve",
    "--root",
    project,
    "--id",
    "contract-open-capability-question",
    ...humanApproval("Premature approval"),
  ], /open question.*must be answered|work brief is incomplete/su);
  const overlap = JSON.stringify({
    skills: { required: [], allowed: ["agentic-sdlc"], forbidden: ["agentic-sdlc"] },
    mcp: { required: [], allowed: [], forbidden: [] },
    tools: { required: [], allowed: [], forbidden: [] },
    approval_required_for: [],
  });
  mustFail(["contract", "create", "--root", project, "--phase", "analysis", "--capability-policy-json", overlap], /cannot be both allowed and forbidden/);
});

test("contract readiness rejects malformed optional bindings and derived required targets before mutation", () => {
  const project = tmpProject("capability-readiness-targets");
  initProject(project);
  const optionalBindingPolicy = JSON.stringify({
    skills: { required: [], allowed: [], forbidden: [] },
    mcp: { required: [], allowed: [], forbidden: [] },
    tools: { required: [], allowed: ["node"], forbidden: [] },
    approval_required_for: [],
  });
  mustRun([
    "contract",
    "create",
    "--root",
    project,
    "--phase",
    "analysis",
    "--id",
    "contract-optional-malformed-binding",
    "--context-summary",
    "Optional bindings remain structurally governed.",
    "--qa",
    "Which optional runtime applies?|Node when available",
    "--capability-policy-json",
    optionalBindingPolicy,
    "--capability-binding-json",
    JSON.stringify({
      type: "tool",
      name: "node",
      binding_id: "node-optional",
      target: { command: "node" },
    }),
  ]);
  const optionalBindingPath = path.join(
    project,
    ".sdlc",
    "contracts",
    "contract-optional-malformed-binding.json",
  );
  const optionalBindingContract = readJson(optionalBindingPath);
  optionalBindingContract.capability_bindings[0].target = {};
  writeJson(optionalBindingPath, optionalBindingContract);
  mustFail([
    "contract",
    "approve",
    "--root",
    project,
    "--id",
    "contract-optional-malformed-binding",
    ...humanApproval("Reject malformed optional binding"),
  ], /capability binding 1 is missing a concrete target object/);
  assert.equal(
    readJson(optionalBindingPath).approvals.length,
    0,
    "a malformed optional binding must fail before approval mutation",
  );

  const requiredPolicy = JSON.stringify({
    skills: { required: [], allowed: [], forbidden: [] },
    mcp: { required: ["repo"], allowed: [], forbidden: [] },
    tools: { required: [], allowed: [], forbidden: [] },
    approval_required_for: [],
  });
  const unsafeTargetContractPath = path.join(
    project,
    ".sdlc",
    "contracts",
    "contract-unsafe-required-target.json",
  );
  mustFail([
    "contract",
    "create",
    "--root",
    project,
    "--phase",
    "analysis",
    "--id",
    "contract-unsafe-required-target",
    "--context-summary",
    "Required repository capability must use canonical evidence.",
    "--qa",
    "Which repository target applies?|The canonical local source tree",
    "--capability-policy-json",
    requiredPolicy,
    "--capability-binding-json",
    JSON.stringify({
      type: "mcp",
      name: "repo",
      binding_id: "repo-derived-cache",
      target: { root_path: ".sdlc/cache/repository-index" },
      permissions: ["read"],
    }),
  ], /target\.root_path points to derived cache\/index path/);
  assert.equal(
    fs.existsSync(unsafeTargetContractPath),
    false,
    "an unsafe required target must fail before contract creation",
  );
});

test("contract readiness validates malformed capability policies deterministically before approval", () => {
  const project = tmpProject("capability-readiness-policy");
  initProject(project);
  const contractId = "contract-invalid-policy";
  const contractPath = path.join(
    project,
    ".sdlc",
    "contracts",
    `${contractId}.json`,
  );
  mustRun([
    "contract",
    "create",
    "--root",
    project,
    "--phase",
    "analysis",
    "--id",
    contractId,
    "--context-summary",
    "Capability policy must remain structurally valid after creation.",
    "--qa",
    "Which runtime is governed?|The local Node runtime",
    "--capability-policy-json",
    JSON.stringify({
      skills: { required: [], allowed: [], forbidden: [] },
      mcp: { required: [], allowed: [], forbidden: [] },
      tools: { required: ["node"], allowed: [], forbidden: [] },
      approval_required_for: [],
    }),
    "--capability-binding-json",
    JSON.stringify({
      type: "tool",
      name: "node",
      binding_id: "node-local",
      target: { command: "node" },
    }),
  ]);

  const malformed = readJson(contractPath);
  malformed.capability_policy.tools.required = { capability: "node" };
  writeJson(contractPath, malformed);
  mustFail([
    "contract",
    "approve",
    "--root",
    project,
    "--id",
    contractId,
    ...humanApproval("Malformed policies are not approvable"),
  ], /capability_policy\.tools\.required must be an array/);
  assert.equal(readJson(contractPath).approvals.length, 0);

  const contradictory = readJson(contractPath);
  contradictory.capability_policy.tools.required = ["node"];
  contradictory.capability_policy.tools.forbidden = ["node"];
  writeJson(contractPath, contradictory);
  mustFail([
    "contract",
    "approve",
    "--root",
    project,
    "--id",
    contractId,
    ...humanApproval("Contradictory policies are not approvable"),
  ], /capability 'node' cannot be both required and forbidden/);
  assert.equal(
    readJson(contractPath).approvals.length,
    0,
    "invalid policy readiness must fail without appending an approval",
  );
});

test("required capability targets need concrete recursive values and reject derived paths through semantic keys", () => {
  const project = tmpProject("capability-readiness-recursive-target");
  initProject(project);
  const requiredPolicy = JSON.stringify({
    skills: { required: [], allowed: [], forbidden: [] },
    mcp: { required: ["repo"], allowed: [], forbidden: [] },
    tools: { required: [], allowed: [], forbidden: [] },
    approval_required_for: [],
  });
  const contractArgs = (id, target) => [
    "contract",
    "create",
    "--root",
    project,
    "--phase",
    "analysis",
    "--id",
    id,
    "--context-summary",
    "Required repository targets must use canonical project evidence.",
    "--qa",
    "Which repository target applies?|The canonical local source tree",
    "--capability-policy-json",
    requiredPolicy,
    "--capability-binding-json",
    JSON.stringify({
      type: "mcp",
      name: "repo",
      binding_id: `repo-${id}`,
      target,
      permissions: ["read"],
    }),
  ];

  mustFail(
    contractArgs("contract-empty-recursive-target", {
      workspace: null,
      command: "",
      metadata: { values: [] },
    }),
    /target has no concrete recursive value/,
  );
  mustFail(
    contractArgs("contract-derived-workspace-target", {
      workspace: ".sdlc/cache/repository-index",
    }),
    /target\.workspace points to derived cache\/index path/,
  );
  mustFail(
    contractArgs("contract-derived-nested-target", {
      connection: {
        workspace: {
          root: ".sdlc/cache/repository-index",
        },
      },
    }),
    /target\.connection\.workspace\.root points to derived cache\/index path/,
  );
  for (const id of [
    "contract-empty-recursive-target",
    "contract-derived-workspace-target",
    "contract-derived-nested-target",
  ]) {
    assert.equal(
      fs.existsSync(path.join(project, ".sdlc", "contracts", `${id}.json`)),
      false,
      `${id} must fail before contract mutation`,
    );
  }

  mustRun(contractArgs("contract-canonical-workspace-target", {
    workspace: "src",
    adapter: { command: "repo-reader" },
  }));
});

test("phase-scoped output refs parse compatibly and bind completion to the exact phase", () => {
  const project = tmpProject("phase-scoped-output-ref");
  initProject(project);
  story(project, "ST-PHASED");
  createApprovedTemplate(project, "implementation-summary");
  createApprovedTemplate(project, "validation-report");

  mustFail([
    "contract",
    "create",
    "--root",
    project,
    "--phase",
    "implementation",
    "--context-summary",
    "Reject output phases outside the configured lifecycle.",
    "--output-ref",
    "implementation-summary:implementation-summary-v1:new:not-configured",
  ], /Output ref phase 'not-configured' is not configured/);

  mustRun([
    "contract",
    "create",
    "--root",
    project,
    "--phase",
    "implementation",
    "--story",
    "ST-PHASED",
    "--id",
    "contract-ST-PHASED-lifecycle",
    "--context-summary",
    "Each durable output belongs to its exact governed lifecycle phase.",
    "--qa",
    "Which lifecycle applies?|The configured software lifecycle",
    "--output-ref",
    "implementation-summary:implementation-summary-v1:new:implementation",
    "--output-ref",
    "validation-report:validation-report-v1:new:validation",
  ]);
  const contractPath = path.join(
    project,
    ".sdlc",
    "contracts",
    "contract-ST-PHASED-lifecycle.json",
  );
  const contract = readJson(contractPath);
  assert.deepEqual(
    contract.output_contract_refs.map((ref) => ref.phase),
    ["implementation", "validation"],
  );
  const approvalRequests = JSON.parse(mustRun([
    "approval",
    "requests",
    "--root",
    project,
    "--story",
    "ST-PHASED",
    "--json",
  ]).stdout);
  const contractApproval = approvalRequests.requests.find(
    (request) =>
      request.type === "contract_approval"
      && request.subject_id === "contract-ST-PHASED-lifecycle",
  );
  assert.ok(contractApproval, "phase-scoped contract approval request missing");
  assert.match(
    contractApproval.review_items.join("\n"),
    /implementation-summary:implementation-summary-v1:new \(phase: implementation\)/u,
  );
  assert.match(
    contractApproval.review_items.join("\n"),
    /validation-report:validation-report-v1:new \(phase: validation\)/u,
  );
  mustRun([
    "contract",
    "approve",
    "--root",
    project,
    "--id",
    "contract-ST-PHASED-lifecycle",
    ...humanApproval("Approve phase-scoped lifecycle outputs"),
  ]);
  startStoryTask(project, "ST-PHASED", "implementation");

  mustFail([
    "story",
    "complete-step",
    "--root",
    project,
    "--id",
    "ST-PHASED",
    "--step",
    "implementation",
    "--type",
    "validation-report",
    "--summary",
    "Do not attach validation output to implementation",
  ], /output validation-report.*is not covered by approved contract output refs/);

  const implementationArtifact = writeArtifact(
    project,
    "docs/ST-PHASED-implementation-summary.md",
  );
  mustRun([
    "output",
    "link",
    "--root",
    project,
    "--story",
    "ST-PHASED",
    "--type",
    "implementation-summary",
    "--artifact",
    implementationArtifact,
    "--template",
    "implementation-summary-v1",
    "--mode",
    "new",
  ]);
  mustRun([
    "story",
    "complete-step",
    "--root",
    project,
    "--id",
    "ST-PHASED",
    "--step",
    "implementation",
    "--type",
    "implementation-summary",
    "--summary",
    "Implementation output completed in its assigned phase",
  ]);
  mustFail([
    "story",
    "complete-step",
    "--root",
    project,
    "--id",
    "ST-PHASED",
    "--step",
    "validation",
    "--summary",
    "Validation summary cannot omit its assigned output",
  ], /validation step requires --type validation-report/);

  const legacyProjectContract = JSON.parse(mustRun([
    "contract",
    "create",
    "--root",
    project,
    "--phase",
    "analysis",
    "--id",
    "contract-analysis-legacy-output-ref",
    "--context-summary",
    "Three-part output refs remain backward compatible and all-due.",
    "--qa",
    "Which compatibility applies?|Legacy strict all-due semantics",
    "--output-ref",
    "implementation-summary:implementation-summary-v1:new",
    "--json",
  ]).stdout).contract;
  assert.equal(Object.hasOwn(legacyProjectContract.output_contract_refs[0], "phase"), false);
});

test("story contract readiness rejects future-only and restored invalid output phases before approval", () => {
  const project = tmpProject("phase-output-readiness");
  initProject(project);
  story(project, "ST-FUTURE-OUTPUT");
  createApprovedTemplate(project, "implementation-summary");
  createApprovedTemplate(project, "validation-report");

  const contractPath = path.join(
    project,
    ".sdlc",
    "contracts",
    "contract-ST-FUTURE-OUTPUT-implementation.json",
  );
  mustFail([
    "contract",
    "create",
    "--root",
    project,
    "--phase",
    "implementation",
    "--story",
    "ST-FUTURE-OUTPUT",
    "--id",
    "contract-ST-FUTURE-OUTPUT-implementation",
    "--context-summary",
    "Implementation must declare an output due now.",
    "--qa",
    "When is the validation report due?|During validation",
    "--output-ref",
    "validation-report:validation-report-v1:new:validation",
  ], /phase 'implementation' has no output due in that phase|future-only/iu);
  assert.equal(fs.existsSync(contractPath), false);

  mustRun([
    "contract",
    "create",
    "--root",
    project,
    "--phase",
    "implementation",
    "--story",
    "ST-FUTURE-OUTPUT",
    "--id",
    "contract-ST-FUTURE-OUTPUT-implementation",
    "--context-summary",
    "Persist an explicit future-only clarification draft.",
    "--qa",
    "When is the validation report due?|During validation",
    "--output-ref",
    "validation-report:validation-report-v1:new:validation",
    "--allow-incomplete-contract",
  ]);
  mustFail([
    "contract",
    "approve",
    "--root",
    project,
    "--id",
    "contract-ST-FUTURE-OUTPUT-implementation",
    ...humanApproval("Do not approve a future-only brief"),
  ], /phase 'implementation' has no output due in that phase/iu);
  assert.equal(readJson(contractPath).approvals.length, 0);

  const unknownPhase = readJson(contractPath);
  unknownPhase.output_contract_refs[0].phase = "not-configured";
  writeJson(contractPath, unknownPhase);
  mustFail([
    "contract",
    "approve",
    "--root",
    project,
    "--id",
    "contract-ST-FUTURE-OUTPUT-implementation",
    ...humanApproval("Reject an unknown phase"),
  ], /unknown phase 'not-configured'/iu);

  const duplicated = readJson(contractPath);
  duplicated.output_contract_refs[0].phase = "implementation";
  duplicated.output_contract_refs.push({
    ...duplicated.output_contract_refs[0],
    phase: "validation",
  });
  writeJson(contractPath, duplicated);
  mustFail([
    "contract",
    "approve",
    "--root",
    project,
    "--id",
    "contract-ST-FUTURE-OUTPUT-implementation",
    ...humanApproval("Reject duplicate output identity"),
  ], /duplicated.*one canonical link/iu);

  const invalidContractPhase = readJson(contractPath);
  invalidContractPhase.output_contract_refs = [
    invalidContractPhase.output_contract_refs[0],
  ];
  invalidContractPhase.phase = "not-configured";
  writeJson(contractPath, invalidContractPhase);
  mustFail([
    "contract",
    "approve",
    "--root",
    project,
    "--id",
    "contract-ST-FUTURE-OUTPUT-implementation",
    ...humanApproval("Reject an unknown contract phase"),
  ], /contract phase 'not-configured' is not configured/iu);
  assert.equal(readJson(contractPath).approvals.length, 0);
});

test("output-link requests defer future refs and carry a collision-safe phase identity", () => {
  const project = tmpProject("phase-output-link-requests");
  initProject(project);
  story(project, "ST-DUE-OUTPUT");
  createApprovedTemplate(project, "discovery-note");
  createApprovedTemplate(project, "release-note");

  mustRun([
    "contract",
    "create",
    "--root",
    project,
    "--phase",
    "discovery",
    "--story",
    "ST-DUE-OUTPUT",
    "--id",
    "contract-ST-DUE-OUTPUT-discovery",
    "--context-summary",
    "Request only outputs due at the trusted workflow phase.",
    "--qa",
    "Which workflow applies?|The current story-bound software workflow",
    "--output-ref",
    "discovery-note:discovery-note-v1:new:discovery",
    "--output-ref",
    "release-note:release-note-v1:new:release",
  ]);
  mustRun([
    "contract",
    "approve",
    "--root",
    project,
    "--id",
    "contract-ST-DUE-OUTPUT-discovery",
    ...humanApproval("Approve phased discovery and release outputs"),
  ]);
  mustRun([
    "workflow",
    "instance",
    "start",
    "--root",
    project,
    "--id",
    "DELIVERY-ST-DUE-OUTPUT",
    "--definition",
    "software-project",
    "--definition-version",
    "3",
    "--story",
    "ST-DUE-OUTPUT",
  ]);
  writeArtifact(
    project,
    ".sdlc/stories/ST-DUE-OUTPUT/outputs/proposed-discovery-note.md",
  );

  const requests = JSON.parse(mustRun([
    "approval",
    "requests",
    "--root",
    project,
    "--story",
    "ST-DUE-OUTPUT",
    "--json",
  ]).stdout).requests.filter((request) => request.type === "output_link_required");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].artifact_type, "discovery-note");
  assert.equal(requests[0].phase, "discovery");
  assert.match(
    requests[0].id,
    /ST-DUE-OUTPUT-discovery-note-discovery-note-v1-new-discovery$/u,
  );
  assert.equal(
    requests.some((request) => request.artifact_type === "release-note"),
    false,
  );
});

test("strict output validation does not read workflow phase scope when coverage is disabled", () => {
  const project = tmpProject("phase-output-coverage-disabled");
  initProject(project);
  const configPath = path.join(project, ".sdlc", "config.json");
  const config = readJson(configPath);
  config.gate_policy.strict_mode.requires_output_contract_coverage = false;
  writeJson(configPath, config);
  pinProjectConfig(project);
  story(project, "ST-NO-OUTPUT-COVERAGE");

  mustRun([
    "contract",
    "create",
    "--root",
    project,
    "--phase",
    "analysis",
    "--story",
    "ST-NO-OUTPUT-COVERAGE",
    "--id",
    "contract-ST-NO-OUTPUT-COVERAGE-analysis",
    "--context-summary",
    "This project explicitly disables strict output coverage.",
    "--qa",
    "Is an output contract required?|No, the strict policy disables it",
  ]);
  mustRun([
    "contract",
    "approve",
    "--root",
    project,
    "--id",
    "contract-ST-NO-OUTPUT-COVERAGE-analysis",
    ...humanApproval("Approve the no-output-coverage brief"),
  ]);
  const workflowInstanceId = "DELIVERY-ST-NO-OUTPUT-COVERAGE";
  mustRun([
    "workflow",
    "instance",
    "start",
    "--root",
    project,
    "--id",
    workflowInstanceId,
    "--definition",
    "software-project",
    "--definition-version",
    "3",
    "--story",
    "ST-NO-OUTPUT-COVERAGE",
  ]);
  const brokenInstancePath = path.join(
    project,
    ".sdlc",
    "workflows",
    "instances",
    workflowInstanceId,
    "instance.json",
  );
  const intactInstance = fs.readFileSync(brokenInstancePath);
  fs.writeFileSync(brokenInstancePath, "{not-json\n");
  const storyPath = path.join(
    project,
    ".sdlc",
    "stories",
    "ST-NO-OUTPUT-COVERAGE",
    "story.json",
  );
  const validationStory = readJson(storyPath);
  validationStory.phase = "validation";
  validationStory.status = "validation";
  writeJson(storyPath, validationStory);

  const gate = mustFail([
    "gate",
    "check",
    "--root",
    project,
    "--strict",
    "--story",
    "ST-NO-OUTPUT-COVERAGE",
    "--json",
  ], /failed|blocking|requires/iu);
  assert.doesNotMatch(
    `${gate.stdout}\n${gate.stderr}`,
    new RegExp(`cannot select its current workflow while instance ${workflowInstanceId}`, "iu"),
  );

  fs.writeFileSync(brokenInstancePath, intactInstance);
  const readyStory = readJson(storyPath);
  readyStory.phase = "discovery";
  readyStory.status = "ready";
  writeJson(storyPath, readyStory);
  const strictReceiptPath = path.join(
    project,
    ".sdlc",
    "gates",
    "ST-NO-OUTPUT-COVERAGE-strict.json",
  );
  const passedGate = JSON.parse(mustRun([
    "gate",
    "check",
    "--root",
    project,
    "--strict",
    "--story",
    "ST-NO-OUTPUT-COVERAGE",
    "--json",
  ]).stdout);
  assert.equal(passedGate.schema_version, "workflow-strict-gate-receipt:v2");
  assert.equal(passedGate.workflow_scope.instance_id, workflowInstanceId);
  assert.equal(passedGate.workflow_scope.current_phase, "discovery");
  assert.equal(fs.existsSync(strictReceiptPath), true);

  fs.unlinkSync(strictReceiptPath);
  fs.writeFileSync(brokenInstancePath, "{not-json\n");
  const corruptWorkflowGate = mustFail([
    "gate",
    "check",
    "--root",
    project,
    "--strict",
    "--story",
    "ST-NO-OUTPUT-COVERAGE",
    "--json",
  ], new RegExp(`cannot select its current workflow while instance ${workflowInstanceId}`, "iu"));
  assert.match(
    `${corruptWorkflowGate.stdout}\n${corruptWorkflowGate.stderr}`,
    new RegExp(`cannot select its current workflow while instance ${workflowInstanceId}`, "iu"),
  );
  assert.equal(fs.existsSync(strictReceiptPath), false);
});

test("capability binding files cannot come from derived cache directories", () => {
  const project = tmpProject("capability-cache");
  initProject(project);
  const bindingPath = path.join(project, ".sdlc", "cache", "binding.json");
  fs.mkdirSync(path.dirname(bindingPath), { recursive: true });
  fs.writeFileSync(bindingPath, JSON.stringify({ type: "mcp", name: "repo", binding_id: "repo-main", target: { repo: "local" } }));
  mustFail(
    ["contract", "create", "--root", project, "--phase", "analysis", "--capability-binding-file", ".sdlc/cache/binding.json"],
    /derived artifacts/,
  );
});

test("capability profiles and recommendations can be approved and applied to contracts", () => {
  const project = tmpProject("capability-discovery");
  initProject(project);
  fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  story(project, "ST-001");
  createApprovedTemplate(project, "technical-analysis");
  const proposedProfile = JSON.parse(mustRun([
    "capability",
    "profile",
    "propose",
    "--root",
    project,
    "--id",
    "CAP-PROFILE-ST-001",
    "--story",
    "ST-001",
    "--phase",
    "analysis",
    "--context-file",
    "package.json",
    "--json",
  ]).stdout);
  assert.match(proposedProfile.assistant_message, /Project evidence and boundaries/);
  assert.doesNotMatch(proposedProfile.assistant_message, /Tools and permissions profile/);
  assert.equal(proposedProfile.approval_request.type, "capability_profile_approval");
  assert.ok(proposedProfile.approval_request.review_items.some((item) => /What this is: the list of project evidence/.test(item)));
  const profileRequests = JSON.parse(mustRun(["approval", "requests", "--root", project, "--story", "ST-001", "--json"]).stdout);
  const profileRequest = profileRequests.requests.find((request) => request.type === "capability_profile_approval");
  assert.ok(profileRequest, "capability profile approval request missing");
  assert.equal(profileRequest.subject_id, "CAP-PROFILE-ST-001");
  assert.match(profileRequests.assistant_message, /Project evidence and boundaries/);
  assert.doesNotMatch(profileRequests.assistant_message, /capability profile/i);
  assert.ok(profileRequest.review_items.some((item) => /What this is: the list of project evidence/.test(item)));
  assert.ok(profileRequest.review_items.some((item) => /Project signals found:/.test(item)));
  assert.match(profileRequest.approval_meaning, /choose the concrete tools/);
  mustRun(["capability", "profile", "approve", "--root", project, "--id", "CAP-PROFILE-ST-001", ...humanApproval("Approved capability profile")]);
  const recommendation = JSON.stringify({
    recommendations: [
      { type: "skill", name: "agentic-sdlc", availability: "available", install_required: false },
      { type: "mcp", name: "repo", availability: "available", install_required: false }
    ],
    policy_patch: {
      skills: { required: ["agentic-sdlc"], allowed: [], forbidden: [] },
      mcp: { required: ["repo"], allowed: [], forbidden: [] },
      tools: { required: [], allowed: [], forbidden: [] },
      approval_required_for: []
    },
    bindings: [
      { type: "mcp", name: "repo", binding_id: "repo-main", target: { repo: "local" }, permissions: ["read"] }
    ],
    execution_policy_suggestions: { reasoning: "high", notes: ["Use high reasoning for architecture tradeoffs"] },
    decision_matrix: [{ option: "local repo", recommendation: "use" }]
  });
  const proposedRecommendation = JSON.parse(mustRun([
    "capability",
    "recommend",
    "--root",
    project,
    "--id",
    "CAP-REC-ST-001",
    "--profile",
    "CAP-PROFILE-ST-001",
    "--recommendation-json",
    recommendation,
    "--json",
  ]).stdout);
  assert.match(proposedRecommendation.assistant_message, /Allowed tools for this work/);
  assert.doesNotMatch(proposedRecommendation.assistant_message, /capability recommendation/i);
  assert.equal(proposedRecommendation.approval_request.type, "capability_recommendation_approval");
  assert.ok(proposedRecommendation.approval_request.review_items.some((item) => /Recommended capabilities:/.test(item)));
  const recommendationRequests = JSON.parse(mustRun(["approval", "requests", "--root", project, "--story", "ST-001", "--json"]).stdout);
  const recommendationRequest = recommendationRequests.requests.find((request) => request.type === "capability_recommendation_approval");
  assert.ok(recommendationRequest, "capability recommendation approval request missing");
  assert.equal(recommendationRequest.subject_id, "CAP-REC-ST-001");
  assert.match(recommendationRequests.assistant_message, /Allowed tools for this work/);
  assert.doesNotMatch(recommendationRequests.assistant_message, /capability recommendation/i);
  assert.ok(recommendationRequest.review_items.some((item) => /What this is: the concrete list of tools/.test(item)));
  assert.ok(recommendationRequest.review_items.some((item) => /Recommended capabilities:/.test(item)));
  assert.match(recommendationRequest.approval_meaning, /use these tools and permissions/);
  mustRun(["capability", "approve", "--root", project, "--id", "CAP-REC-ST-001", ...humanApproval("Approved capability recommendation")]);
  const contract = JSON.parse(mustRun([
    "contract",
    "create",
    "--root",
    project,
    "--phase",
    "analysis",
    "--story",
    "ST-001",
    "--id",
    "contract-ST-001-analysis",
    "--context-summary",
    "Analyze with approved capability discovery.",
    "--output-ref",
    "technical-analysis:technical-analysis-v1:new",
    "--capability-recommendation",
    "CAP-REC-ST-001",
    "--json",
  ]).stdout).contract;
  assert.equal(contract.capability_policy.mcp.required.includes("repo"), true);
  assert.equal(contract.capability_bindings.some((binding) => binding.name === "repo"), true);
  assert.equal(contract.execution_policy.reasoning.level, "high");
  assert.equal(contract.capability_recommendation_refs[0].id, "CAP-REC-ST-001");
});

test("default capability recommendations use the reviewed available inventory", () => {
  const project = tmpProject("capability-reviewed-inventory");
  initProject(project);
  fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  story(project, "ST-001");
  mustRun([
    "capability",
    "profile",
    "propose",
    "--root",
    project,
    "--id",
    "CAP-PROFILE-ST-001",
    "--story",
    "ST-001",
    "--phase",
    "implementation",
    "--context-file",
    "package.json",
  ]);

  const available = {
    skills: [
      { name: "agentic-sdlc", purpose: "Govern the complete project lifecycle." },
      { name: "frontend-testing", purpose: "Exercise the user-facing flow." },
    ],
    tools: [
      { name: "node", purpose: "Run the dependency-free implementation." },
      { name: "unused-tool", recommended: false },
    ],
  };
  const proposed = JSON.parse(mustRun([
    "capability",
    "recommend",
    "--root",
    project,
    "--id",
    "CAP-REC-ST-001",
    "--profile",
    "CAP-PROFILE-ST-001",
    "--available-capabilities-json",
    JSON.stringify(available),
    "--json",
  ]).stdout).recommendation;

  const byKey = new Map(proposed.recommendations.map((item) => [`${item.type}:${item.name}`, item]));
  assert.equal(byKey.get("skill:agentic-sdlc").availability, "available");
  assert.equal(byKey.get("skill:frontend-testing").purpose, "Exercise the user-facing flow.");
  assert.equal(byKey.get("tool:node").purpose, "Run the dependency-free implementation.");
  assert.equal(byKey.has("tool:test-runner"), true);
  assert.equal(byKey.has("tool:unused-tool"), false);
});

test("default capability recommendations remain usable without an optional inventory", () => {
  const project = tmpProject("capability-no-inventory");
  initProject(project);
  fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  story(project, "ST-001");
  mustRun([
    "capability",
    "profile",
    "propose",
    "--root",
    project,
    "--id",
    "CAP-PROFILE-ST-001",
    "--story",
    "ST-001",
    "--phase",
    "implementation",
    "--context-file",
    "package.json",
  ]);
  mustRun([
    "capability",
    "profile",
    "approve",
    "--root",
    project,
    "--id",
    "CAP-PROFILE-ST-001",
    ...humanApproval("Approved local evidence and boundaries"),
  ]);

  const proposed = JSON.parse(mustRun([
    "capability",
    "recommend",
    "--root",
    project,
    "--id",
    "CAP-REC-ST-001",
    "--profile",
    "CAP-PROFILE-ST-001",
    "--json",
  ]).stdout);
  const intrinsic = proposed.recommendation.recommendations.find((item) =>
    item.type === "skill" && item.name === "agentic-sdlc");

  assert.equal(intrinsic?.availability, "available");
  assert.equal(intrinsic?.install_required, false);
  assert.doesNotMatch(proposed.assistant_message, /agentic-sdlc \(unknown/);
  assert.ok(proposed.approval_request.review_items.some((item) =>
    /skill:agentic-sdlc \(available; no install\)/.test(item)));

  mustRun([
    "capability",
    "approve",
    "--root",
    project,
    "--id",
    "CAP-REC-ST-001",
    ...humanApproval("Approved intrinsic governance and detected local test runner"),
  ]);
  const approved = readJson(
    path.join(project, ".sdlc", "capability-discovery", "recommendations", "CAP-REC-ST-001.json"),
  );
  assert.equal(approved.status, "approved");
  assert.equal(
    approved.recommendations.every((item) => item.availability === "available"),
    true,
  );
});

test("story approval requests do not leak capability records from another story", () => {
  const project = tmpProject("capability-approval-scope");
  initProject(project);
  story(project, "ST-001");
  story(project, "ST-002");
  mustRun([
    "capability",
    "profile",
    "propose",
    "--root",
    project,
    "--id",
    "CAP-PROFILE-ST-001",
    "--story",
    "ST-001",
  ]);
  mustRun([
    "capability",
    "profile",
    "propose",
    "--root",
    project,
    "--id",
    "CAP-PROFILE-PROJECT",
  ]);

  const requests = JSON.parse(
    mustRun(["approval", "requests", "--root", project, "--story", "ST-002", "--json"]).stdout,
  ).requests.filter((request) => request.type === "capability_profile_approval");
  assert.deepEqual(requests.map((request) => request.subject_id), ["CAP-PROFILE-PROJECT"]);
});

test("capability recommendation stays usable when its profile is approved after recommendation", () => {
  const project = tmpProject("capability-profile-approval-order");
  initProject(project);
  fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  story(project, "ST-001");
  createApprovedTemplate(project, "technical-analysis");
  mustRun([
    "capability",
    "profile",
    "propose",
    "--root",
    project,
    "--id",
    "CAP-PROFILE-ST-001",
    "--story",
    "ST-001",
    "--phase",
    "analysis",
    "--context-file",
    "package.json",
  ]);
  mustRun([
    "capability",
    "recommend",
    "--root",
    project,
    "--id",
    "CAP-REC-ST-001",
    "--profile",
    "CAP-PROFILE-ST-001",
  ]);
  mustRun(["capability", "profile", "approve", "--root", project, "--id", "CAP-PROFILE-ST-001", ...humanApproval("Approved evidence and boundaries")]);
  mustRun(["capability", "approve", "--root", project, "--id", "CAP-REC-ST-001", ...humanApproval("Approved allowed tools")]);
  const recommendation = readJson(path.join(project, ".sdlc", "capability-discovery", "recommendations", "CAP-REC-ST-001.json"));
  assert.equal(recommendation.status, "approved");
  assert.equal(recommendation.profile_ref.path, ".sdlc/capability-discovery/profiles/CAP-PROFILE-ST-001.json");
  assert.ok(recommendation.profile_ref.approved_content_hash);
  assert.equal(recommendation.source_paths.includes(".sdlc/capability-discovery/profiles/CAP-PROFILE-ST-001.json"), false);
  mustRun([
    "contract",
    "create",
    "--root",
    project,
    "--phase",
    "analysis",
    "--story",
    "ST-001",
    "--id",
    "contract-ST-001-analysis",
    "--context-summary",
    "Analyze with tools approved after profile approval.",
    "--qa",
    "Who approved tool boundaries?|Owner",
    "--output-ref",
    "technical-analysis:technical-analysis-v1:new",
    "--capability-recommendation",
    "CAP-REC-ST-001",
  ]);
});

test("install-required capability recommendation blocks strict gate without install approval", () => {
  const project = tmpProject("capability-install");
  initProject(project);
  story(project, "ST-001");
  createApprovedTemplate(project, "technical-analysis");
  mustRun(["capability", "profile", "propose", "--root", project, "--id", "CAP-PROFILE-ST-001", "--story", "ST-001"]);
  mustRun(["capability", "profile", "approve", "--root", project, "--id", "CAP-PROFILE-ST-001", ...humanApproval("Approved capability profile")]);
  mustRun([
    "capability",
    "recommend",
    "--root",
    project,
    "--id",
    "CAP-REC-INSTALL",
    "--profile",
    "CAP-PROFILE-ST-001",
    "--recommendation-json",
    JSON.stringify({
      recommendations: [{ type: "skill", name: "missing-skill", availability: "install_required", install_required: true }],
      policy_patch: {
        skills: { required: ["missing-skill"], allowed: [], forbidden: [] },
        mcp: { required: [], allowed: [], forbidden: [] },
        tools: { required: [], allowed: [], forbidden: [] },
        approval_required_for: ["skill:missing-skill"]
      }
    }),
  ]);
  mustRun(["capability", "approve", "--root", project, "--id", "CAP-REC-INSTALL", ...humanApproval("Approved install recommendation without install")]);
  mustFail([
    "contract",
    "create",
    "--root",
    project,
    "--phase",
    "analysis",
    "--story",
    "ST-001",
    "--id",
    "contract-ST-001-analysis",
    "--context-summary",
    "Analyze with missing install approval.",
    "--output-ref",
    "technical-analysis:technical-analysis-v1:new",
    "--capability-recommendation",
    "CAP-REC-INSTALL",
  ], /without install approval/);
  const installAutomationAuthorization = grantAutomationAuthorization(
    project,
    "AUTH-CI-INSTALL-AUTOMATION",
    ["capability.approve"],
    { subjects: ["CAP-REC-INSTALL"] },
  );
  mustFail([
    "capability",
    "approve",
    "--root",
    project,
    "--id",
    "CAP-REC-INSTALL",
    "--approve-install",
    ...delegatedAutomationApproval("Delegated analysis approval does not include installing capabilities"),
  ], /delegated automation cannot expand into installs/);
  mustFail([
    "capability",
    "approve",
    "--root",
    project,
    "--id",
    "CAP-REC-INSTALL",
    "--approve-install",
    "--actor-type",
    "ci",
    "--approval-source",
    "automation",
    "--authorization",
    installAutomationAuthorization.id,
    "--scope",
    delegatedApprovalScope,
    "--summary",
    "CI automation may not expand into an installation",
  ], /delegated automation cannot expand into installs/);
  const notInstalled = readJson(path.join(project, ".sdlc", "capability-discovery", "recommendations", "CAP-REC-INSTALL.json"));
  assert.equal(notInstalled.recommendations[0].install_approved, false);
  mustRun(["capability", "approve", "--root", project, "--id", "CAP-REC-INSTALL", "--approve-install", ...humanApproval("Approved install-required capability")]);
  mustRun([
    "contract",
    "create",
    "--root",
    project,
    "--phase",
    "analysis",
    "--story",
    "ST-001",
    "--id",
    "contract-ST-001-analysis",
    "--context-summary",
    "Analyze with install-approved capability.",
    "--output-ref",
    "technical-analysis:technical-analysis-v1:new",
    "--capability-recommendation",
    "CAP-REC-INSTALL",
    "--force",
  ]);
});

test("stale capability recommendation source fails strict gate", () => {
  const project = tmpProject("capability-stale");
  initProject(project);
  story(project, "ST-001");
  const source = writeArtifact(project, ".sdlc/requirements/REQ-001.md", "# Requirement\n");
  createApprovedTemplate(project, "technical-analysis");
  const analysisArtifact = writeArtifact(project, ".sdlc/requirements/ST-001-technical-analysis.md", "# Technical Analysis\n");
  mustRun([
    "capability",
    "profile",
    "propose",
    "--root",
    project,
    "--id",
    "CAP-PROFILE-ST-001",
    "--story",
    "ST-001",
    "--context-file",
    source,
  ]);
  mustRun(["capability", "profile", "approve", "--root", project, "--id", "CAP-PROFILE-ST-001", ...humanApproval("Approved capability profile")]);
  mustRun(["capability", "recommend", "--root", project, "--id", "CAP-REC-ST-001", "--profile", "CAP-PROFILE-ST-001"]);
  mustRun(["capability", "approve", "--root", project, "--id", "CAP-REC-ST-001", ...humanApproval("Approved capability recommendation")]);
  mustRun([
    "contract",
    "create",
    "--root",
    project,
    "--phase",
    "analysis",
    "--story",
    "ST-001",
    "--id",
    "contract-ST-001-analysis",
    "--context-summary",
    "Analyze with approved recommendation.",
    "--output-ref",
    "technical-analysis:technical-analysis-v1:new",
    "--capability-recommendation",
    "CAP-REC-ST-001",
    "--force",
  ]);
  mustRun(["contract", "approve", "--root", project, "--id", "contract-ST-001-analysis", ...humanApproval("Approved analysis contract")]);
  startStoryTask(project, "ST-001", "analysis");
  mustRun([
    "output",
    "link",
    "--root",
    project,
    "--story",
    "ST-001",
    "--type",
    "technical-analysis",
    "--artifact",
    analysisArtifact,
    "--template",
    "technical-analysis-v1",
    "--mode",
    "new",
    "--requirement",
    "REQ-001",
  ]);
  fs.appendFileSync(path.join(project, source), "\nchanged\n");
  mustFail(["gate", "check", "--root", project, "--story", "ST-001", "--strict"], /changed after record creation/);
});

test("technical analysis route suggests capability discovery when no profile exists", () => {
  const project = tmpProject("capability-route");
  initProject(project);
  story(project, "ST-001");
  const decision = routeDecision(project, {
    requested_action: "technical_analysis",
    proposed_phase: "analysis",
    artifact_type: "technical-analysis",
    referenced_entities: [{ type: "story", id: "ST-001" }],
  });
  assert.ok(decision.blocking_reasons.includes("capability_profile_missing"));
  assert.ok(decision.next_commands.some((command) => command.includes("capability profile propose")));
});

test("route accepts artifact types declared only by the approved output registry", () => {
  const project = tmpProject("route-custom-output-type");
  initProject(project);
  createApprovedTemplate(project, "novel-evidence");

  const decision = routeDecision(project, {
    requested_action: "functional_analysis",
    proposed_phase: "analysis",
    artifact_type: "novel-evidence",
  });
  assert.equal(decision.intent.artifact_type, "novel-evidence");
  assert.equal(
    decision.blocking_reasons.some((reason) => reason.includes("artifact_type")),
    false,
  );
});

test("technical analysis routing ignores approved profiles whose sources became stale", () => {
  const project = tmpProject("capability-route-stale-profile");
  initProject(project);
  story(project, "ST-001");
  const source = writeArtifact(project, "package.json", "{\"name\":\"route-test\"}\n");
  mustRun([
    "capability",
    "profile",
    "propose",
    "--root",
    project,
    "--id",
    "CAP-PROFILE-ST-001",
    "--story",
    "ST-001",
    "--phase",
    "analysis",
    "--context-file",
    source,
  ]);
  mustRun([
    "capability",
    "profile",
    "approve",
    "--root",
    project,
    "--id",
    "CAP-PROFILE-ST-001",
    ...humanApproval("Approved routing profile"),
  ]);
  const intent = {
    requested_action: "technical_analysis",
    proposed_phase: "analysis",
    artifact_type: "technical-analysis",
    referenced_entities: [{ type: "story", id: "ST-001" }],
  };
  const fresh = routeDecision(project, intent);
  assert.equal(fresh.blocking_reasons.includes("capability_profile_missing"), false);
  fs.appendFileSync(path.join(project, source), "\n");
  const stale = routeDecision(project, intent);
  assert.ok(stale.blocking_reasons.includes("capability_profile_missing"));

  const refreshPayload = JSON.parse(mustRun([
    "approval",
    "requests",
    "--root",
    project,
    "--story",
    "ST-001",
    "--json",
  ]).stdout);
  assert.equal(refreshPayload.status, "needs_internal_refresh");
  assert.equal(refreshPayload.internal_refresh_only, true);
  assert.ok(refreshPayload.requests.every((request) => request.status === "needs_internal_refresh"));
  assert.match(refreshPayload.human_guidance.required_decision, /do not need to approve anything/u);

  const refreshGuidance = splitHumanGuidance(mustRun([
    "approval",
    "requests",
    "--root",
    project,
    "--story",
    "ST-001",
  ]).stdout);
  assert.match(refreshGuidance.primary, /agreed goal and limits do not change/u);
  assert.match(refreshGuidance.primary, /do not need to approve anything/u);
  assert.doesNotMatch(refreshGuidance.primary, /CAP-PROFILE-ST-001|needs_internal_refresh|--[a-z]|\.sdlc/u);
  assert.match(refreshGuidance.technical, /CAP-PROFILE-ST-001/u);
});

test("technical assessment aliases route through the contract front door", () => {
  const project = tmpProject("technical-assessment-alias");
  initProject(project);
  const decision = routeDecision(project, {
    requested_action: "technical_assessment",
    proposed_phase: "analysis",
    artifact_type: "technical-analysis",
  });
  assert.equal(decision.route, "classify_artifact");
  assert.equal(decision.status, "needs_confirmation");
  assert.equal(decision.requires_confirmation, true);
  assert.ok(decision.blocking_reasons.includes("capability_profile_missing"));

  const start = routeDecision(project, {
    requested_action: "initial_technical_assessment",
    proposed_phase: "analysis",
    artifact_type: "technical-analysis",
  }, ["task", "start"]);
  assert.equal(start.status, "needs_user_input");
  assert.equal(start.execution_allowed, false);
  assert.notEqual(start.contract_action, "normalize_request");
  assert.ok(start.blocking_reasons.includes("baseline_missing"));
  assert.equal(start.contract_action, "approve_or_refresh_project_context");
  assert.equal(start.contract_id, null);
  assert.ok(start.questions.some((question) => (
    question.includes("Checkpoint 1 of 2")
    && question.includes("What I need:")
    && question.includes("Why:")
    && question.includes("Example answer:")
    && question.includes("Effect:")
  )));
});

test("cache rebuild includes capability discovery sources", () => {
  const project = tmpProject("capability-cache-source");
  initProject(project);
  mustRun(["capability", "profile", "propose", "--root", project, "--id", "CAP-PROJECT"]);
  const cache = JSON.parse(mustRun(["cache", "rebuild", "--root", project, "--json"]).stdout);
  assert.equal(cache.status, "rebuilt");
  const cacheFile = readJson(path.join(project, ".sdlc", "cache", "kb-cache.json"));
  assert.equal(cacheFile.source_paths.some((sourcePath) => sourcePath.includes("capability-discovery/profiles/CAP-PROJECT.json")), true);
});

test("configured derived directories stay out of cache, index, and manifest sources", () => {
  const project = tmpProject("configured-derived-sources");
  initProject(project);
  const configPath = path.join(project, ".sdlc", "config.json");
  const config = readJson(configPath);
  config.cache_policy.derived_directories.push("generated");
  config.cache_policy.source_of_truth_dirs.push("generated");
  writeJson(configPath, config);
  pinProjectConfig(project);
  fs.mkdirSync(path.join(project, ".sdlc", "generated"), { recursive: true });
  writeJson(path.join(project, ".sdlc", "generated", "trap.json"), {
    id: "DERIVED-TRAP",
    summary: "This derived record must never become canonical evidence",
  });

  mustRun(["cache", "rebuild", "--root", project]);
  mustRun(["index", "rebuild", "--root", project]);
  mustRun(["manifest", "rebuild", "--root", project]);

  const sourceCollections = [
    readJson(path.join(project, ".sdlc", "cache", "kb-cache.json")).source_paths,
    readJson(path.join(project, ".sdlc", "indexes", "kb-index.json")).source_paths,
    readJson(path.join(project, ".sdlc", "manifests", "kb-manifest.json")).source_paths,
  ];
  for (const sourcePaths of sourceCollections) {
    assert.equal(sourcePaths.some((sourcePath) => sourcePath.startsWith(".sdlc/generated/")), false);
  }
});

test("KB search and cache status compact derived JSON without hiding retrievable sources", () => {
  const project = tmpProject("compact-derived-json");
  initProject(project);
  const sourcePath = path.join(project, ".sdlc", "decisions", "DEC-TOKEN-CONTEXT.json");
  writeJson(sourcePath, {
    id: "DEC-TOKEN-CONTEXT",
    title: "Token context reduction",
    summary: "needle-token-context ".repeat(2_000),
  });
  mustRun(["index", "rebuild", "--root", project]);

  const compactSearchRun = mustRun([
    "kb", "search", "needle-token-context", "--root", project, "--limit", "5", "--json",
  ]);
  const compactSearch = JSON.parse(compactSearchRun.stdout);
  assert.equal(compactSearch.results.length, 1);
  assert.equal(compactSearch.results[0].entry.path, ".sdlc/decisions/DEC-TOKEN-CONTEXT.json");
  assert.match(compactSearch.results[0].entry.source_hash, /^[a-f0-9]{64}$/);
  assert.equal(compactSearch.results[0].entry.search_text, undefined);
  assert.equal(compactSearch.context_optimization.lossless_for_reported_fields, true);
  assert.ok(compactSearch.context_optimization.omitted_bytes > 30_000);
  assert.ok(compactSearch.context_optimization.estimated_tokens_avoided > 7_500);
  assert.equal(compactSearch.context_optimization.full_payload_flag, "--full");

  const fullSearchRun = mustRun([
    "kb", "search", "needle-token-context", "--root", project, "--limit", "5", "--json", "--full",
  ]);
  const fullSearch = JSON.parse(fullSearchRun.stdout);
  assert.match(fullSearch.results[0].entry.search_text, /needle-token-context/);
  assert.ok(fullSearchRun.stdout.length > compactSearchRun.stdout.length * 10);

  for (const invalidLimit of ["0", "1.5", "101", "Infinity"]) {
    mustFail(
      ["kb", "search", "needle-token-context", "--root", project, "--limit", invalidLimit, "--json"],
      /--limit must be an integer between 1 and 100/,
    );
  }

  mustRun(["cache", "rebuild", "--root", project]);
  const compactStatusRun = mustRun(["cache", "status", "--root", project, "--json"]);
  const compactStatus = JSON.parse(compactStatusRun.stdout);
  assert.equal(compactStatus.valid, true);
  assert.equal(compactStatus.cache, undefined);
  assert.ok(compactStatus.cache_summary.entries > 0);
  assert.ok(compactStatus.context_optimization.omitted_bytes > 30_000);
  assert.ok(compactStatus.context_optimization.estimated_tokens_avoided > 7_500);

  const fullStatusRun = mustRun(["cache", "status", "--root", project, "--json", "--full"]);
  const fullStatus = JSON.parse(fullStatusRun.stdout);
  assert.ok(Array.isArray(fullStatus.cache.full_text_index));
  assert.ok(fullStatusRun.stdout.length > compactStatusRun.stdout.length * 10);
});

test("dependency graph blocks orchestration and strict gate until upstream is satisfied", () => {
  const project = tmpProject("dependencies-block");
  initProject(project);
  story(project, "ST-001");
  story(project, "ST-002");
  mustRun([
    "dependency",
    "propose",
    "--root",
    project,
    "--id",
    "DEP-001",
    "--edge",
    "ST-002:ST-001:blocks:implementation:done",
  ]);
  mustRun(["dependency", "approve", "--root", project, "--id", "DEP-001", ...humanApproval("Approved dependency")]);
  const plan = JSON.parse(mustRun(["orchestrate", "plan", "--root", project, "--json"]).stdout);
  assert.equal(plan.candidates.some((candidate) => candidate.story_id === "ST-002"), false);
  const storyPath = path.join(project, ".sdlc", "stories", "ST-002", "story.json");
  const storyData = readJson(storyPath);
  writeJson(storyPath, { ...storyData, status: "implementation", phase: "implementation" });
  mustFail(["gate", "check", "--root", project, "--story", "ST-002", "--strict"], /depends on ST-001/);
});

test("invalid lifecycle receipt cannot satisfy a lifecycle dependency from raw story state", () => {
  const project = tmpProject("dependency-invalid-lifecycle");
  initProject(project);
  story(project, "ST-UPSTREAM");
  story(project, "ST-DOWNSTREAM");

  const upstreamPath = path.join(project, ".sdlc", "stories", "ST-UPSTREAM", "story.json");
  writeJson(upstreamPath, {
    ...readJson(upstreamPath),
    status: "validation",
    phase: "validation",
  });
  const gatesRoot = path.join(project, ".sdlc", "gates");
  fs.mkdirSync(gatesRoot, { recursive: true });
  writeJson(path.join(gatesRoot, "ST-UPSTREAM-final.json"), {
    kind: "workflow_final_gate_receipt",
    schema_version: "workflow-final-gate-receipt:v2",
    status: "passed",
    strict: true,
    scope: "story",
    story_id: "ST-UPSTREAM",
  });

  mustRun([
    "dependency",
    "propose",
    "--root",
    project,
    "--id",
    "DEP-INVALID-LIFECYCLE",
    "--edge",
    "ST-DOWNSTREAM:ST-UPSTREAM:blocks:implementation:validated",
  ]);
  mustRun([
    "dependency",
    "approve",
    "--root",
    project,
    "--id",
    "DEP-INVALID-LIFECYCLE",
    ...humanApproval("Approved invalid lifecycle dependency regression"),
  ]);

  const status = JSON.parse(mustRun([
    "orchestrate", "status", "--root", project, "--json",
  ]).stdout);
  const upstream = status.stories.find((item) => item.id === "ST-UPSTREAM");
  const downstream = status.stories.find((item) => item.id === "ST-DOWNSTREAM");
  assert.equal(upstream.orchestration_state, "blocked");
  assert.match(upstream.blockers.join("\n"), /final lifecycle receipt/u);
  assert.equal(downstream.orchestration_state, "blocked");
  assert.ok(downstream.blockers.some((blocker) => blocker.includes("depends on ST-UPSTREAM")));
});

test("blocked upstream lifecycle invalidates hard artifact and contract dependencies", () => {
  const project = tmpProject("dependency-blocked-hard-evidence");
  initProject(project);
  createStrictReadyStory(project, "ST-UPSTREAM");
  const dependencies = [
    {
      id: "DEP-BLOCKED-ARTIFACT",
      storyId: "ST-ARTIFACT-CONSUMER",
      type: "requires_artifact",
      state: "artifact_linked",
    },
    {
      id: "DEP-BLOCKED-CONTRACT",
      storyId: "ST-CONTRACT-CONSUMER",
      type: "requires_contract",
      state: "contract_approved",
    },
  ];
  for (const dependency of dependencies) {
    story(project, dependency.storyId);
    mustRun([
      "dependency",
      "propose",
      "--root",
      project,
      "--id",
      dependency.id,
      "--edge",
      `${dependency.storyId}:ST-UPSTREAM:${dependency.type}:design:${dependency.state}`,
    ]);
    mustRun([
      "dependency",
      "approve",
      "--root",
      project,
      "--id",
      dependency.id,
      ...humanApproval(`Approved ${dependency.type} blocked-upstream regression`),
    ]);
  }

  const ready = JSON.parse(mustRun([
    "orchestrate", "status", "--root", project, "--json",
  ]).stdout);
  for (const dependency of dependencies) {
    assert.equal(
      ready.stories.find((item) => item.id === dependency.storyId)
        .orchestration_state,
      "available",
    );
  }

  const gatesRoot = path.join(project, ".sdlc", "gates");
  fs.mkdirSync(gatesRoot, { recursive: true });
  writeJson(path.join(gatesRoot, "ST-UPSTREAM-final.json"), {
    kind: "workflow_final_gate_receipt",
    schema_version: "workflow-final-gate-receipt:v2",
    status: "passed",
    strict: true,
    scope: "story",
    story_id: "ST-UPSTREAM",
  });

  const blocked = JSON.parse(mustRun([
    "orchestrate", "status", "--root", project, "--json",
  ]).stdout);
  const upstream = blocked.stories.find((item) => item.id === "ST-UPSTREAM");
  assert.equal(upstream.orchestration_state, "blocked");
  assert.match(upstream.blockers.join("\n"), /final lifecycle receipt/u);
  for (const dependency of dependencies) {
    const consumer = blocked.stories.find((item) =>
      item.id === dependency.storyId);
    assert.equal(consumer.orchestration_state, "blocked");
    assert.ok(consumer.blockers.some((blocker) =>
      blocker.includes(
        `(${dependency.type}, design, requires ${dependency.state})`,
      )));
  }
});

test("orchestration never satisfies a dependency from a story whose folder and ID differ", () => {
  const project = tmpProject("dependency-story-folder-mismatch");
  initProject(project);
  story(project, "ST-UPSTREAM");
  story(project, "ST-DOWNSTREAM");
  mustRun([
    "dependency",
    "propose",
    "--root",
    project,
    "--id",
    "DEP-FOLDER-MISMATCH",
    "--edge",
    "ST-DOWNSTREAM:ST-UPSTREAM:blocks:implementation:done",
  ]);
  mustRun([
    "dependency",
    "approve",
    "--root",
    project,
    "--id",
    "DEP-FOLDER-MISMATCH",
    ...humanApproval("Approved folder mismatch regression dependency"),
  ]);

  const upstreamFolder = path.join(project, ".sdlc", "stories", "ST-UPSTREAM");
  const upstreamPath = path.join(upstreamFolder, "story.json");
  writeJson(upstreamPath, {
    ...readJson(upstreamPath),
    status: "done",
    phase: "release",
  });
  fs.renameSync(upstreamFolder, path.join(project, ".sdlc", "stories", "WRONG-FOLDER"));

  const status = JSON.parse(mustRun(["orchestrate", "status", "--root", project, "--json"]).stdout);
  const downstream = status.stories.find((item) => item.id === "ST-DOWNSTREAM");
  const mismatched = status.stories.find((item) => item.id === "ST-UPSTREAM");
  assert.equal(downstream.orchestration_state, "blocked");
  assert.ok(downstream.blockers.some((blocker) => blocker.includes("depends on ST-UPSTREAM")));
  assert.ok(mismatched.blockers.some((blocker) => blocker.includes("does not match folder WRONG-FOLDER")));
});

test("soft dependency is visible but does not block orchestration", () => {
  const project = tmpProject("dependencies-soft");
  initProject(project);
  story(project, "ST-001");
  story(project, "ST-002");
  mustRun([
    "dependency",
    "propose",
    "--root",
    project,
    "--id",
    "DEP-RELATED",
    "--edge",
    "ST-002:ST-001:related:none:exists",
  ]);
  mustRun(["dependency", "approve", "--root", project, "--id", "DEP-RELATED", ...humanApproval("Approved related dependency")]);
  const status = JSON.parse(mustRun(["orchestrate", "status", "--root", project, "--json"]).stdout);
  const storyStatus = status.stories.find((item) => item.id === "ST-002");
  assert.equal(storyStatus.orchestration_state, "available");
  assert.ok(storyStatus.warnings.some((warning) => warning.includes("ST-002 depends on ST-001")));
});

test("blocking dependency cycles fail strict gate", () => {
  const project = tmpProject("dependencies-cycle");
  initProject(project);
  story(project, "ST-001");
  story(project, "ST-002");
  mustRun(["dependency", "propose", "--root", project, "--id", "DEP-A", "--edge", "ST-001:ST-002:blocks:implementation:done"]);
  mustRun(["dependency", "approve", "--root", project, "--id", "DEP-A", ...humanApproval("Approved dependency A")]);
  mustRun(["dependency", "propose", "--root", project, "--id", "DEP-B", "--edge", "ST-002:ST-001:blocks:implementation:done"]);
  mustRun(["dependency", "approve", "--root", project, "--id", "DEP-B", ...humanApproval("Approved dependency B")]);
  const storyPath = path.join(project, ".sdlc", "stories", "ST-001", "story.json");
  const storyData = readJson(storyPath);
  writeJson(storyPath, { ...storyData, status: "implementation", phase: "implementation" });
  mustFail(["gate", "check", "--root", project, "--story", "ST-001", "--strict"], /blocking dependency cycle/);
});

test("downstream dependency becomes stale when upstream artifact changes until revalidated", () => {
  const project = tmpProject("dependencies-stale");
  initProject(project);
  createStrictReadyStory(project, "ST-001");
  story(project, "ST-002");
  mustRun([
    "dependency",
    "propose",
    "--root",
    project,
    "--id",
    "DEP-ARTIFACT",
    "--edge",
    "ST-002:ST-001:requires_artifact:validation:artifact_linked",
  ]);
  mustRun(["dependency", "approve", "--root", project, "--id", "DEP-ARTIFACT", ...humanApproval("Approved artifact dependency")]);
  fs.appendFileSync(path.join(project, ".sdlc", "requirements", "ST-001-functional-analysis.md"), "\nchanged upstream\n");
  const stale = JSON.parse(mustRun(["dependency", "status", "--root", project, "--story", "ST-002", "--json"]).stdout);
  assert.ok(stale.blockers.some((blocker) => blocker.includes("requires revalidation")));
  mustRun([
    "trace",
    "append",
    "--root",
    project,
    "--story",
    "ST-002",
    "--type",
    "test",
    "--summary",
    "Revalidated downstream after upstream artifact change",
    "--action",
    "dependency.revalidate",
    "--related",
    "ST-001",
  ]);
  const revalidated = JSON.parse(mustRun(["dependency", "status", "--root", project, "--story", "ST-002", "--json"]).stdout);
  assert.equal(revalidated.blockers.some((blocker) => blocker.includes("requires revalidation")), false);
});

test("orchestration hashes dependency artifacts outside .sdlc without using a shadow path", () => {
  const project = tmpProject("dependency-artifact-outside-sdlc");
  initProject(project);
  story(project, "ST-UPSTREAM");
  createApprovedTemplate(project);
  createApprovedStoryContract(project, "ST-UPSTREAM");
  startStoryTask(project, "ST-UPSTREAM", "design");
  const artifact = writeArtifact(project, "docs/ST-UPSTREAM-functional-analysis.md");
  writeArtifact(project, ".sdlc/docs/ST-UPSTREAM-functional-analysis.md", "# Stale shadow artifact\n");
  mustRun([
    "output",
    "link",
    "--root",
    project,
    "--story",
    "ST-UPSTREAM",
    "--type",
    "functional-analysis",
    "--artifact",
    artifact,
    "--template",
    "functional-analysis-v1",
    "--mode",
    "new",
    "--requirement",
    "REQ-001",
  ]);
  story(project, "ST-DOWNSTREAM");
  mustRun([
    "dependency",
    "propose",
    "--root",
    project,
    "--id",
    "DEP-EXTERNAL-ARTIFACT",
    "--edge",
    "ST-DOWNSTREAM:ST-UPSTREAM:requires_artifact:validation:artifact_linked",
  ]);
  mustRun([
    "dependency",
    "approve",
    "--root",
    project,
    "--id",
    "DEP-EXTERNAL-ARTIFACT",
    ...humanApproval("Approved external artifact dependency"),
  ]);

  const initial = JSON.parse(mustRun(["orchestrate", "status", "--root", project, "--json"]).stdout);
  const initialDownstream = initial.stories.find((item) => item.id === "ST-DOWNSTREAM");
  assert.equal(initialDownstream.blockers.some((blocker) => blocker.includes("requires revalidation")), false);

  fs.appendFileSync(path.join(project, artifact), "\nchanged upstream\n");
  const changed = JSON.parse(mustRun(["orchestrate", "status", "--root", project, "--json"]).stdout);
  const changedDownstream = changed.stories.find((item) => item.id === "ST-DOWNSTREAM");
  assert.ok(changedDownstream.blockers.some((blocker) => blocker.includes("requires revalidation")));
});

test("route decide returns init_project when canonical intent arrives before KB initialization", () => {
  const project = tmpProject("route-no-kb");
  const decision = routeDecision(project);
  assert.equal(decision.route, "init_project");
  assert.equal(decision.requires_confirmation, false);
  assert.ok(decision.next_commands.some((command) => command.includes("agentic-sdlc init")));
});

test("route decide returns onboarding when canonical intent targets an existing project", () => {
  const project = tmpProject("route-onboard");
  const decision = routeDecision(project, {
    requested_action: "onboard_existing_project",
    provided_artifacts: [{ type: "document", path: "README.md" }],
  });
  assert.equal(decision.route, "onboard_existing_project");
  assert.ok(decision.next_commands.some((command) => command.includes("onboard existing-project")));

  initProject(project);
  const initializedDecision = routeDecision(project, {
    requested_action: "onboard_existing_project",
    provided_artifacts: [{ type: "document", path: "README.md" }],
  });
  assert.equal(initializedDecision.route, "onboard_existing_project");
  assert.ok(initializedDecision.next_commands.some((command) => command.includes("baseline propose")));
});

test("route decide does not inherit risky action confirmation before KB initialization", () => {
  const project = tmpProject("route-no-kb-implement");
  const decision = routeDecision(project, {
    requested_action: "implement_story",
    referenced_entities: [{ type: "story", id: "ST-001" }],
  });
  assert.equal(decision.route, "init_project");
  assert.equal(decision.requires_confirmation, false);
  assert.ok(decision.next_commands.some((command) => command.includes("agentic-sdlc init")));
});

test("route alias with raw text only asks for canonical normalization", () => {
  const project = tmpProject("route-raw-text");
  initProject(project);
  const result = mustRun(["route", "--root", project, "--json", "--text", "Implement ST-001"]);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.route, "ask_clarification");
  assert.equal(decision.status, "needs_normalization");
  assert.ok(decision.blocking_reasons.includes("needs_normalization"));
  assert.equal(decision.deterministic_checks.some((check) => check.check === "raw_text" && check.status === "ignored"), true);
});

test("task start is the SDLC front door before phase work", () => {
  const rawProject = tmpProject("task-start-raw");
  initProject(rawProject);
  const raw = JSON.parse(mustRun(["task", "start", "--root", rawProject, "--json", "--text", "Implement ST-001"]).stdout);
  assert.equal(raw.status, "needs_normalization");
  assert.equal(raw.execution_allowed, false);
  assert.ok(raw.blocking_reasons.includes("needs_normalization"));

  const missingProject = tmpProject("task-start-missing-contract");
  initProject(missingProject);
  story(missingProject, "ST-001");
  const missing = JSON.parse(mustRun([
    "task",
    "start",
    "--root",
    missingProject,
    "--json",
    "--intent-json",
    routeIntent({
      requested_action: "implement_story",
      referenced_entities: [{ type: "story", id: "ST-001" }],
      proposed_phase: "implementation",
    }),
  ]).stdout);
  assert.equal(missing.status, "needs_user_input");
  assert.equal(missing.execution_allowed, false);
  assert.equal(missing.contract_action, "create_or_revise_contract");
  assert.ok(missing.blocking_reasons.includes("contract_negotiation_required"));
  assert.ok(missing.questions.some((question) => question.includes("No approved implementation contract")));
  assert.equal(missing.assistant_message_source_language, "en");
  assert.equal(missing.assistant_message_presentation.translate_to_chat_language, true);
  assert.match(missing.assistant_message_presentation.instruction, /active chat language/);
  const forcedMissing = JSON.parse(mustRun([
    "task",
    "start",
    "--root",
    missingProject,
    "--json",
    "--intent-json",
    routeIntent({
      requested_action: "implement_story",
      referenced_entities: [{ type: "story", id: "ST-001" }],
      proposed_phase: "implementation",
    }),
    "--confirm-start",
  ]).stdout);
  assert.equal(forcedMissing.execution_allowed, false);
  assert.equal(forcedMissing.status, "needs_user_input");
  const missingTracePath = path.join(missingProject, ".sdlc", "traces", "project.jsonl");
  const missingTraces = fs.existsSync(missingTracePath) ? fs.readFileSync(missingTracePath, "utf8") : "";
  assert.doesNotMatch(missingTraces, /task\.start\.confirm/);

  const readyProject = tmpProject("task-start-ready");
  initProject(readyProject);
  story(readyProject, "ST-001");
  createApprovedTemplate(readyProject, "implementation-summary");
  mustRun([
    "contract",
    "create",
    "--root",
    readyProject,
    "--phase",
    "implementation",
    "--story",
    "ST-001",
    "--id",
    "contract-ST-001-implementation",
    "--context-summary",
    "Implement the approved story under the agreed contract.",
    "--qa",
    "Who confirms start?|Human user",
    "--output-ref",
    "implementation-summary:implementation-summary-v1:new",
  ]);
  mustRun(["contract", "approve", "--root", readyProject, "--id", "contract-ST-001-implementation", ...humanApproval("Approved implementation contract")]);
  const storyPath = path.join(readyProject, ".sdlc", "stories", "ST-001", "story.json");
  const storyData = readJson(storyPath);
  writeJson(storyPath, { ...storyData, status: "ready", phase: "implementation" });
  story(readyProject, "ST-002");
  const secondStoryPath = path.join(readyProject, ".sdlc", "stories", "ST-002", "story.json");
  writeJson(secondStoryPath, {
    ...readJson(secondStoryPath),
    status: "ready",
    phase: "implementation",
    contract_id: "contract-ST-001-implementation",
  });

  const intent = routeIntent({
    requested_action: "implement_story",
    referenced_entities: [{ type: "story", id: "ST-001" }],
    proposed_phase: "implementation",
  });
  const conflictingStory = JSON.parse(mustRun([
    "task",
    "start",
    "--root",
    readyProject,
    "--json",
    "--story",
    "ST-002",
    "--intent-json",
    intent,
    "--confirm-start",
  ]).stdout);
  assert.equal(conflictingStory.execution_allowed, false);
  assert.ok(conflictingStory.blocking_reasons.includes("story_reference_mismatch"));

  const wrongStoryContract = JSON.parse(mustRun([
    "task",
    "start",
    "--root",
    readyProject,
    "--json",
    "--story",
    "ST-002",
    "--contract-id",
    "contract-ST-001-implementation",
    "--intent-json",
    routeIntent({
      requested_action: "implement_story",
      referenced_entities: [{ type: "story", id: "ST-002" }],
      proposed_phase: "implementation",
    }),
    "--confirm-start",
  ]).stdout);
  assert.equal(wrongStoryContract.execution_allowed, false);
  assert.equal(wrongStoryContract.contract_action, "revise_contract");
  assert.ok(wrongStoryContract.blocking_reasons.includes("contract_story_mismatch"));

  const unconfirmed = JSON.parse(mustRun([
    "task",
    "start",
    "--root",
    readyProject,
    "--json",
    "--intent-json",
    intent,
  ]).stdout);
  assert.equal(unconfirmed.status, "needs_user_input");
  assert.equal(unconfirmed.execution_allowed, false);
  assert.equal(unconfirmed.contract_action, "confirm_start");
  assert.ok(unconfirmed.blocking_reasons.includes("route_requires_confirmation"));
  assert.equal(unconfirmed.contract.approved, true);

  const confirmed = JSON.parse(mustRun([
    "task",
    "start",
    "--root",
    readyProject,
    "--json",
    "--intent-json",
    intent,
    "--confirm-start",
    "--actor-type",
    "human",
  ]).stdout);
  assert.equal(confirmed.status, "ready_to_execute");
  assert.equal(confirmed.execution_allowed, true);
  assert.equal(confirmed.contract_id, "contract-ST-001-implementation");
  assert.match(confirmed.confirmation_trace_id, /^TR-/);
  const confirmedReceiptPath = path.join(readyProject, confirmed.task_start_receipt);
  const confirmedReceiptBytes = fs.readFileSync(confirmedReceiptPath);

  const resumeAuthorization = grantAutomationAuthorization(
    readyProject,
    "AUTH-RESUME-ST-001",
    ["task.start.confirm"],
    { subjects: ["ST-001"], artifactTypes: ["implementation-summary"] },
  );
  mustRun([
    "story",
    "claim",
    "--root",
    readyProject,
    "--id",
    "ST-001",
    "--agent",
    "codex",
  ]);
  mustFail([
    "task",
    "start",
    "--root",
    readyProject,
    "--json",
    "--intent-json",
    intent,
    "--confirm-start",
    "--authorization",
    resumeAuthorization.id,
  ], /already immutably recorded.*continue the existing governed run/is);
  assert.deepEqual(fs.readFileSync(confirmedReceiptPath), confirmedReceiptBytes);

  const revision = JSON.parse(mustRun([
    "task",
    "start",
    "--root",
    readyProject,
    "--json",
    "--intent-json",
    intent,
    "--confirm-start",
    "--revise-contract",
  ]).stdout);
  assert.equal(revision.status, "contract_revision_required");
  assert.equal(revision.execution_allowed, false);
  assert.equal(revision.contract_action, "revise_contract");
});

test("task start rejects a bootstrap-only contract approval", () => {
  const project = tmpProject("task-start-bootstrap-contract");
  initProject(project);
  story(project, "ST-BOOT");
  createApprovedTemplate(project, "implementation-summary");
  mustRun([
    "contract",
    "create",
    "--root",
    project,
    "--phase",
    "implementation",
    "--story",
    "ST-BOOT",
    "--id",
    "contract-ST-BOOT-implementation",
    "--context-summary",
    "Bootstrap approvals cannot start normal work.",
    "--qa",
    "Who must approve?|The user or CI",
    "--output-ref",
    "implementation-summary:implementation-summary-v1:new",
  ]);
  mustRun([
    "contract",
    "approve",
    "--root",
    project,
    "--id",
    "contract-ST-BOOT-implementation",
    "--actor-type",
    "human",
    "--approval-source",
    "bootstrap",
    "--summary",
    "Migration-only bootstrap approval",
  ]);
  const storyPath = path.join(project, ".sdlc", "stories", "ST-BOOT", "story.json");
  writeJson(storyPath, { ...readJson(storyPath), status: "ready", phase: "implementation" });
  const blocked = JSON.parse(mustRun([
    "task",
    "start",
    "--root",
    project,
    "--json",
    "--intent-json",
    routeIntent({
      requested_action: "implement_story",
      referenced_entities: [{ type: "story", id: "ST-BOOT" }],
      proposed_phase: "implementation",
    }),
    "--confirm-start",
    "--actor-type",
    "human",
  ]).stdout);
  assert.equal(blocked.execution_allowed, false);
  assert.equal(blocked.status, "needs_user_input");
  assert.equal(fs.existsSync(path.join(project, ".sdlc", "stories", "ST-BOOT", "task-start.json")), false);
});

test("task start blocks when an approved contract source changes", () => {
  const project = tmpProject("task-start-stale-contract-source");
  initProject(project);
  const contextFile = writeArtifact(
    project,
    "requirements/implementation-context.md",
    "# Implementation context\nUse the approved API boundary.\n",
  );
  story(project, "ST-STALE");
  createApprovedTemplate(project, "implementation-summary");
  mustRun([
    "contract",
    "create",
    "--root",
    project,
    "--phase",
    "implementation",
    "--story",
    "ST-STALE",
    "--id",
    "contract-ST-STALE-implementation",
    "--context-summary",
    "Implement against the approved source snapshot.",
    "--context-file",
    contextFile,
    "--qa",
    "Which API boundary applies?|The boundary recorded in the context source",
    "--output-ref",
    "implementation-summary:implementation-summary-v1:new",
  ]);
  const sourceBoundContract = readJson(
    path.join(project, ".sdlc", "contracts", "contract-ST-STALE-implementation.json"),
  );
  assert.equal(sourceBoundContract.contextualization.context_sources[0].path, contextFile);
  mustRun([
    "contract",
    "approve",
    "--root",
    project,
    "--id",
    "contract-ST-STALE-implementation",
    ...humanApproval("Approved source-bound implementation contract"),
  ]);
  const storyPath = path.join(project, ".sdlc", "stories", "ST-STALE", "story.json");
  writeJson(storyPath, { ...readJson(storyPath), status: "ready", phase: "implementation" });
  const intent = routeIntent({
    requested_action: "implement_story",
    referenced_entities: [{ type: "story", id: "ST-STALE" }],
    proposed_phase: "implementation",
  });

  const ready = JSON.parse(mustRun([
    "task",
    "start",
    "--root",
    project,
    "--intent-json",
    intent,
    "--confirm-start",
    "--actor-type",
    "human",
    "--json",
  ]).stdout);
  assert.equal(ready.status, "ready_to_execute");
  assert.equal(ready.execution_allowed, true);

  fs.appendFileSync(path.join(project, contextFile), "The source changed after approval.\n");
  const blocked = JSON.parse(mustRun([
    "task",
    "start",
    "--root",
    project,
    "--intent-json",
    intent,
    "--confirm-start",
    "--json",
  ]).stdout);
  assert.equal(blocked.status, "needs_user_input");
  assert.equal(blocked.execution_allowed, false);
  assert.equal(blocked.route, "ask_clarification");
  assert.equal(blocked.contract_action, "normalize_request");
  assert.ok(blocked.blocking_reasons.includes("contract_needs_approval"));
  assert.ok(blocked.route_decision.deterministic_checks.some(
    (check) => check.check === "story_contract_exists" && check.details.includes("stale context"),
  ));
  assert.equal(blocked.confirmation_trace_id, undefined);
  const queue = JSON.parse(mustRun([
    "approval",
    "requests",
    "--root",
    project,
    "--story",
    "ST-STALE",
    "--json",
  ]).stdout);
  const clarification = queue.requests.find(
    (request) => request.type === "contract_clarification" && request.subject_id === "contract-ST-STALE-implementation",
  );
  assert.ok(clarification);
  assert.ok(clarification.gaps.includes("stale_context_source"));
  assert.match(clarification.summary, new RegExp(contextFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(queue.requests.some(
    (request) => request.type === "contract_approval" && request.subject_id === "contract-ST-STALE-implementation",
  ), false);
});

test("route decide rejects canonical intent files from derived cache directories", () => {
  const project = tmpProject("route-cache-intent");
  initProject(project);
  const intentPath = path.join(project, ".sdlc", "cache", "route-intent.json");
  fs.mkdirSync(path.dirname(intentPath), { recursive: true });
  fs.writeFileSync(intentPath, routeIntent());
  const result = mustRun(["route", "decide", "--root", project, "--json", "--intent-file", ".sdlc/cache/route-intent.json"]);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.route, "ask_clarification");
  assert.ok(decision.blocking_reasons.includes("invalid_intent_json"));
  assert.equal(
    decision.deterministic_checks.some(
      (check) => check.check === "canonical_intent" && String(check.details).includes("derived artifacts"),
    ),
    true,
  );
});

test("route decide sends ready implementation story to claim_and_implement with confirmation", () => {
  const project = tmpProject("route-implement");
  initProject(project);
  createStrictReadyStory(project, "ST-001");
  const storyPath = path.join(project, ".sdlc", "stories", "ST-001", "story.json");
  const storyData = readJson(storyPath);
  writeJson(storyPath, { ...storyData, status: "ready", phase: "implementation" });

  const decision = routeDecision(project, {
    requested_action: "implement_story",
    referenced_entities: [{ type: "story", id: "ST-001" }],
  });
  assert.equal(decision.route, "claim_and_implement");
  assert.equal(decision.requires_confirmation, true);
  assert.ok(decision.next_commands.some((command) => command.includes("story claim --id ST-001")));
});

test("route and orchestration do not advertise a claim before governed task start", () => {
  const project = tmpProject("route-claim-before-task-start");
  initProject(project);
  story(project, "ST-CLAIM-START", [
    "--phase", "design",
    "--status", "ready",
  ]);
  createApprovedTemplate(project, "functional-analysis");
  createApprovedStoryContract(
    project,
    "ST-CLAIM-START",
    "design",
    "functional-analysis",
  );

  const beforeStart = routeDecision(project, {
    requested_action: "implement_story",
    referenced_entities: [{ type: "story", id: "ST-CLAIM-START" }],
    proposed_phase: "design",
  });
  assert.equal(beforeStart.route, "claim_and_implement");
  assert.equal(beforeStart.status, "blocked");
  assert.equal(beforeStart.requires_confirmation, false);
  assert.ok(beforeStart.blocking_reasons.includes("task_start_required"));
  assert.ok(beforeStart.next_commands.some((command) =>
    command.includes("task start --story ST-CLAIM-START")));
  assert.equal(beforeStart.next_commands.some((command) =>
    command.includes("story claim --id ST-CLAIM-START")), false);

  const blockedStatus = JSON.parse(mustRun([
    "orchestrate", "status", "--root", project, "--json",
  ]).stdout);
  const preStartStory = blockedStatus.stories.find((item) =>
    item.id === "ST-CLAIM-START");
  assert.equal(preStartStory.orchestration_state, "available");
  const preStartPlan = JSON.parse(mustRun([
    "orchestrate", "plan", "--root", project, "--json",
  ]).stdout);
  const preStartCandidate = preStartPlan.candidates.find((item) =>
    item.story_id === "ST-CLAIM-START");
  assert.equal(preStartCandidate.suggested_action, "task_start");
  assert.match(preStartCandidate.suggested_command, /task start --story ST-CLAIM-START/u);
  assert.equal(preStartCandidate.suggested_claim, null);

  startStoryTask(project, "ST-CLAIM-START", "design");
  const afterStart = routeDecision(project, {
    requested_action: "implement_story",
    referenced_entities: [{ type: "story", id: "ST-CLAIM-START" }],
    proposed_phase: "design",
  });
  assert.equal(afterStart.route, "claim_and_implement");
  assert.equal(afterStart.requires_confirmation, true);
  assert.ok(afterStart.next_commands.some((command) =>
    command.includes("story claim --id ST-CLAIM-START")));
  const availableStatus = JSON.parse(mustRun([
    "orchestrate", "status", "--root", project, "--json",
  ]).stdout);
  assert.equal(
    availableStatus.stories.find((item) =>
      item.id === "ST-CLAIM-START").orchestration_state,
    "available",
  );
  const claimPlan = JSON.parse(mustRun([
    "orchestrate", "plan", "--root", project, "--json",
  ]).stdout);
  const claimCandidate = claimPlan.candidates.find((item) =>
    item.story_id === "ST-CLAIM-START");
  assert.equal(claimCandidate.suggested_action, "claim_story");
  assert.match(claimCandidate.suggested_claim, /story claim --id ST-CLAIM-START/u);
});

test("route decide asks to create a missing story before implementation", () => {
  const project = tmpProject("route-missing-story");
  initProject(project);
  const decision = routeDecision(project, {
    requested_action: "implement_story",
    referenced_entities: [{ type: "story", id: "ST-404" }],
  });
  assert.equal(decision.route, "ask_clarification");
  assert.ok(decision.blocking_reasons.includes("story_not_found"));
  assert.ok(decision.next_commands.some((command) => command.includes("story create --id ST-404")));
});

test("route decide gives the additive recovery command for a legacy story without acceptance", () => {
  const project = tmpProject("route-missing-story-acceptance");
  initProject(project);
  mustRun([
    "story", "create", "--root", project,
    "--id", "ST-LEGACY-ACCEPTANCE",
    "--title", "Legacy story missing success criteria",
  ]);
  const decision = routeDecision(project, {
    requested_action: "implement_story",
    referenced_entities: [{ type: "story", id: "ST-LEGACY-ACCEPTANCE" }],
  });
  assert.equal(decision.route, "ask_clarification");
  assert.ok(decision.blocking_reasons.includes("missing_acceptance_criteria"));
  assert.ok(decision.next_commands.some((command) =>
    command.includes("story acceptance add --id ST-LEGACY-ACCEPTANCE --acceptance")));
  assert.equal(decision.next_commands.some((command) => command.includes("story create")), false);
});

test("route decide does not propose an impossible contract before story acceptance is observable", () => {
  const project = tmpProject("route-contract-missing-story-acceptance");
  initProject(project);
  mustRun([
    "story", "create", "--root", project,
    "--id", "ST-CONTRACT-NO-ACCEPTANCE",
    "--title", "Contract must wait for observable success",
  ]);
  const intent = {
    requested_action: "create_contract",
    referenced_entities: [{ type: "story", id: "ST-CONTRACT-NO-ACCEPTANCE" }],
    proposed_phase: "design",
  };
  const decision = routeDecision(project, intent);
  assert.equal(decision.route, "ask_clarification");
  assert.ok(decision.blocking_reasons.includes("missing_acceptance_criteria"));
  assert.ok(decision.next_commands.some((command) =>
    command.includes("story acceptance add --id ST-CONTRACT-NO-ACCEPTANCE --acceptance")));
  assert.equal(decision.next_commands.some((command) => command.includes("contract create")), false);
  const english = mustRun([
    "route", "decide", "--root", project,
    "--intent-json", routeIntent(intent),
  ]).stdout;
  const englishGuidance = splitHumanGuidance(english, "en");
  assert.match(englishGuidance.primary, /does not yet define a verifiable result.*work agreement cannot be prepared/is);
  assert.match(englishGuidance.primary, /State at least one observable result/is);
  assert.equal(
    (english.match(
      /story acceptance add --id ST-CONTRACT-NO-ACCEPTANCE --acceptance <criterion>/gu,
    ) || []).length,
    1,
  );
  const italian = mustRun([
    "route", "decide", "--root", project,
    "--intent-json", routeIntent(intent),
    "--locale", "it",
  ]).stdout;
  const italianGuidance = splitHumanGuidance(italian, "it");
  assert.match(italianGuidance.primary, /non definisce ancora un risultato verificabile.*accordo di lavoro non può essere preparato/is);
  assert.match(italianGuidance.primary, /Indica almeno un risultato osservabile/is);
  assert.equal(
    (italian.match(
      /story acceptance add --id ST-CONTRACT-NO-ACCEPTANCE --acceptance <criterion>/gu,
    ) || []).length,
    1,
  );
});

test("route decide confirms phase skip for functional analysis", () => {
  const project = tmpProject("route-skip");
  initProject(project);
  const decision = routeDecision(project, {
    requested_action: "functional_analysis",
    proposed_phase: "analysis",
    artifact_type: "functional-analysis",
    skip_phases: ["discovery"],
  });
  assert.equal(decision.route, "confirm_phase_skip");
  assert.equal(decision.requires_confirmation, true);
  assert.ok(decision.next_commands.some((command) => command.includes("Approved phase skip: discovery")));
});

test("route decide asks when canonical confidence is low", () => {
  const project = tmpProject("route-low-confidence");
  initProject(project);
  const decision = routeDecision(project, {
    requested_action: "intake_requirement",
    confidence: 0.2,
  });
  assert.equal(decision.route, "ask_clarification");
  assert.equal(decision.status, "low_confidence");
  assert.ok(decision.blocking_reasons.includes("low_confidence"));
});

test("story step completion requires linked outputs and prepares releasable handoff packages", () => {
  const project = tmpProject("step-handoff");
  initProject(project);
  story(project, "ST-MISSING");
  createApprovedTemplate(project);
  createApprovedStoryContract(project, "ST-MISSING");
  startStoryTask(project, "ST-MISSING", "design");
  mustFail(
    [
      "story",
      "complete-step",
      "--root",
      project,
      "--id",
      "ST-MISSING",
      "--step",
      "functional-analysis",
      "--type",
      "functional-analysis",
      "--summary",
      "Trying to close without output link",
    ],
    /no linked functional-analysis output/,
  );

  story(project, "ST-001", ["--requirement", "REQ-001"]);
  createApprovedStoryContract(project, "ST-001");
  startStoryTask(project, "ST-001", "design");
  const artifact = writeArtifact(project, ".sdlc/requirements/ST-001-functional-analysis.md");
  mustRun([
    "output",
    "link",
    "--root",
    project,
    "--story",
    "ST-001",
    "--type",
    "functional-analysis",
    "--artifact",
    artifact,
    "--template",
    "functional-analysis-v1",
    "--mode",
    "new",
    "--requirement",
    "REQ-001",
  ]);
  mustRun(["story", "claim", "--root", project, "--id", "ST-001", "--agent", "analysis-agent", "--branch", "feature/ST-001"]);
  const completed = JSON.parse(mustRun([
    "story",
    "complete-step",
    "--root",
    project,
    "--id",
    "ST-001",
    "--step",
    "functional-analysis",
    "--type",
    "functional-analysis",
    "--summary",
    "Functional analysis accepted for implementation",
    "--artifact",
    artifact,
    "--json",
  ]).stdout);
  assert.equal(completed.step.status, "completed");
  assert.equal(completed.step.output_links.length, 1);
  assert.equal(fs.existsSync(path.join(project, ".sdlc", "stories", "ST-001", "steps", "functional-analysis.json")), true);
  const completedTrace = readJsonLines(path.join(project, ".sdlc", "traces", "ST-001.jsonl")).at(-1);
  assert.deepEqual(completedTrace.evidence, [
    ".sdlc/stories/ST-001/steps/functional-analysis.json",
    artifact,
  ]);
  assert.deepEqual(completedTrace.evidence_refs.map((item) => item.path), completedTrace.evidence);

  const handoff = JSON.parse(mustRun([
    "story",
    "prepare-handoff",
    "--root",
    project,
    "--id",
    "ST-001",
    "--to-agent",
    "implementation-agent",
    "--summary",
    "Ready for implementation",
    "--release-claim",
    "--json",
  ]).stdout);
  assert.equal(handoff.status, "prepared");
  assert.equal(handoff.release.claim.status, "released");
  assert.equal(fs.existsSync(handoff.package_path), true);
  assert.ok(handoff.handoff.required_artifacts.some((artifact) => artifact.endsWith("-package.json")));
});

test("manifest and report queries ignore nested story step records", () => {
  const project = tmpProject("story-steps-direct-only");
  initProject(project);
  story(project, "ST-STEPS");
  const stepsRoot = path.join(project, ".sdlc", "stories", "ST-STEPS", "steps");
  fs.mkdirSync(path.join(stepsRoot, "archive"), { recursive: true });
  writeJson(path.join(stepsRoot, "design.json"), {
    id: "STEP-DIRECT",
    story_id: "ST-STEPS",
    step: "design",
    status: "completed",
    phase: "design",
    completed_at: "2026-07-17T12:00:00.000Z",
  });
  writeJson(path.join(stepsRoot, "archive", "ghost.json"), {
    id: "STEP-NESTED",
    story_id: "ST-STEPS",
    step: "ghost",
    status: "completed",
    phase: "release",
    completed_at: "2026-07-17T13:00:00.000Z",
  });

  mustRun(["manifest", "rebuild", "--root", project]);
  const manifest = readJson(path.join(project, ".sdlc", "manifests", "kb-manifest.json"));
  const manifestStory = manifest.stories.find((item) => item.id === "ST-STEPS");
  assert.deepEqual(manifestStory.completed_steps.map((step) => step.step), ["design"]);

  const query = JSON.stringify({
    intent: "find_completed_steps",
    confidence: 1,
    subjects: ["story_steps"],
    filters: { story_id: ["ST-STEPS"] },
    sort: "created_at_asc",
  });
  const report = JSON.parse(mustRun([
    "report",
    "query",
    "--root",
    project,
    "--query-json",
    query,
    "--json",
  ]).stdout);
  assert.deepEqual(report.results.map((item) => item.id), ["STEP-DIRECT"]);
});

test("activity reports summarize only canonical trace events inside the selected window", () => {
  const project = tmpProject("activity-report");
  initProject(project);
  story(project, "ST-001");
  mustRun([
    "trace",
    "append",
    "--root",
    project,
    "--story",
    "ST-001",
    "--type",
    "decision",
    "--summary",
    "Recent product decision",
    "--actor",
    "codex",
  ]);
  fs.appendFileSync(path.join(project, ".sdlc", "traces", "ST-001.jsonl"), `${JSON.stringify({
    id: "TR-OLD",
    story_id: "ST-001",
    type: "decision",
    summary: "Old decision outside window",
    actor: { id: "codex", type: "agent" },
    action: "decision",
    evidence: [],
    related: [],
    git: {},
    run: {},
    created_at: "2000-01-01T00:00:00.000Z",
  })}\n`);
  const report = JSON.parse(mustRun([
    "report",
    "activity",
    "--root",
    project,
    "--since",
    "3d",
    "--view",
    "dev",
    "--json",
  ]).stdout);
  assert.equal(report.summary.event_count, 1);
  assert.equal(report.items[0].summary, "Recent product decision");
  assert.equal(report.items[0].sources[0].path, ".sdlc/traces/ST-001.jsonl");

  mustRun([
    "report",
    "activity",
    "--root",
    project,
    "--since",
    "3d",
    "--view",
    "business",
    "--out",
    ".sdlc/reports/activity.md",
  ]);
  assert.match(fs.readFileSync(path.join(project, ".sdlc", "reports", "activity.md"), "utf8"), /Recent product decision/);
});

test("report query requires canonical normalization for raw natural language", () => {
  const project = tmpProject("report-query-normalize");
  initProject(project);
  const guidance = JSON.parse(mustRun([
    "report",
    "query",
    "--root",
    project,
    "--text",
    "show all changes made by me",
    "--json",
  ]).stdout);
  assert.equal(guidance.status, "needs_normalization");
  assert.match(guidance.rule, /never keyword-matches/);
  assert.ok(guidance.examples.some((example) => example.query.subjects.includes("activity")));
});

test("report query filters canonical records by actor and source", () => {
  const project = tmpProject("report-query-actor");
  initProject(project);
  story(project, "ST-001");
  mustRun([
    "trace",
    "append",
    "--root",
    project,
    "--story",
    "ST-001",
    "--type",
    "implementation",
    "--summary",
    "Implemented actor scoped change",
    "--actor",
    "antonio",
  ]);
  mustRun([
    "trace",
    "append",
    "--root",
    project,
    "--story",
    "ST-001",
    "--type",
    "decision",
    "--summary",
    "Other actor change",
    "--actor",
    "codex",
  ]);
  const query = JSON.stringify({
    intent: "find_changes_by_actor",
    confidence: 0.96,
    subjects: ["activity"],
    filters: { actor: ["antonio"] },
    sort: "created_at_desc",
  });
  const report = JSON.parse(mustRun(["report", "query", "--root", project, "--query-json", query, "--json"]).stdout);
  assert.equal(report.summary.result_count, 1);
  assert.equal(report.results[0].summary, "Implemented actor scoped change");
  assert.equal(report.results[0].sources[0].path, ".sdlc/traces/ST-001.jsonl");

  const queryPath = path.join(project, ".sdlc", "cache", "report-query.json");
  fs.mkdirSync(path.dirname(queryPath), { recursive: true });
  fs.writeFileSync(queryPath, query);
  mustFail(["report", "query", "--root", project, "--query-file", ".sdlc/cache/report-query.json"], /derived artifacts/);
});

test("report query does not inherit output types from links owned by another story", () => {
  const project = tmpProject("report-query-story-output-ownership");
  initProject(project);
  createStrictReadyStory(project, "ST-LINKED");
  story(project, "ST-UNLINKED");
  const query = JSON.stringify({
    intent: "find_stories_by_output_type",
    confidence: 1,
    subjects: ["stories"],
    filters: { artifact_type: ["functional-analysis"] },
    sort: "kind_asc",
  });

  const report = JSON.parse(mustRun([
    "report",
    "query",
    "--root",
    project,
    "--query-json",
    query,
    "--json",
  ]).stdout);
  assert.deepEqual(report.results.map((item) => item.id), ["ST-LINKED"]);
});

test("output status stays scoped to the active story instead of every registered template", () => {
  const project = tmpProject("output-status-story-scope");
  initProject(project);
  createStrictReadyStory(project, "ST-LINKED");
  createApprovedTemplate(project, "implementation-summary");

  const status = JSON.parse(mustRun([
    "output",
    "status",
    "--root",
    project,
    "--story",
    "ST-LINKED",
    "--json",
  ]).stdout);
  assert.deepEqual(status.resolutions.map((item) => item.artifact_type), ["functional-analysis"]);
});

test("story, contract, autonomy, and legacy analysis steps honor configured phases", () => {
  const project = tmpProject("custom-story-phase");
  initProject(project);
  story(project, "ST-001");
  const configPath = path.join(project, ".sdlc", "config.json");
  const config = readJson(configPath);
  const customPhase = "security-review";
  config.phases[customPhase] = {
    ...config.phases.design,
    purpose: "Review security boundaries before analysis.",
  };
  config.phase_order = ["discovery", customPhase, "analysis", "design", "implementation", "validation", "release", "operations"];
  config.autonomy_policy.presets.checkpointed.automatic_phases = [
    customPhase,
    ...config.autonomy_policy.presets.checkpointed.automatic_phases,
  ];
  writeJson(configPath, config);
  pinProjectConfig(project);

  const result = JSON.parse(mustRun([
    "story",
    "complete-step",
    "--root",
    project,
    "--id",
    "ST-001",
    "--step",
    customPhase,
    "--summary",
    "Security boundaries reviewed",
    "--allow-unapproved-contract-output",
    "--json",
  ]).stdout);
  assert.equal(result.step.step, customPhase);
  assert.equal(result.step.phase, customPhase);
  assert.equal(result.step.next_step, "analysis");

  const analysis = JSON.parse(mustRun([
    "story",
    "complete-step",
    "--root",
    project,
    "--id",
    "ST-001",
    "--step",
    "analysis",
    "--summary",
    "Canonical analysis completed",
    "--allow-unapproved-contract-output",
    "--json",
  ]).stdout);
  assert.equal(analysis.step.phase, "analysis");
  assert.equal(analysis.step.next_step, "design");

  const storyRecord = readJson(path.join(project, ".sdlc", "stories", "ST-001", "story.json"));
  storyRecord.phase = customPhase;
  assert.equal(validateAgainstSchema(storyRecord, "story").valid, true);

  const customContract = JSON.parse(mustRun([
    "contract",
    "create",
    "--root",
    project,
    "--phase",
    customPhase,
    "--id",
    "contract-custom-phase",
    "--context-summary",
    "Review the configured custom phase boundary.",
    "--allow-incomplete-contract",
    "--json",
  ]).stdout).contract;
  assert.equal(customContract.phase, customPhase);
  assert.equal(validateAgainstSchema(customContract, "contract").valid, true);

  const phaseLock = JSON.parse(mustRun([
    "phase",
    "lock",
    "--root",
    project,
    "--phase",
    customPhase,
    "--reason",
    "Coordinate the configured custom review phase.",
    "--json",
  ]).stdout).lock;
  assert.equal(phaseLock.phase, customPhase);
  assert.equal(validateAgainstSchema(phaseLock, "phase-lock").valid, true);

  story(project, "ST-LEGACY");
  const functional = JSON.parse(mustRun([
    "story",
    "complete-step",
    "--root",
    project,
    "--id",
    "ST-LEGACY",
    "--step",
    "functional-analysis",
    "--summary",
    "Legacy functional analysis completed",
    "--allow-unapproved-contract-output",
    "--json",
  ]).stdout);
  assert.equal(functional.step.phase, "analysis");
  assert.equal(functional.step.next_step, "technical-analysis");
  const technical = JSON.parse(mustRun([
    "story",
    "complete-step",
    "--root",
    project,
    "--id",
    "ST-LEGACY",
    "--step",
    "technical-analysis",
    "--summary",
    "Legacy technical analysis completed",
    "--allow-unapproved-contract-output",
    "--json",
  ]).stdout);
  assert.equal(technical.step.phase, "analysis");
  assert.equal(technical.step.next_step, "design");
});

test("analysis aliases disappear when analysis is not a configured phase", () => {
  const project = tmpProject("custom-story-phase-no-analysis");
  initProject(project);
  story(project, "ST-001");
  const configPath = path.join(project, ".sdlc", "config.json");
  const config = readJson(configPath);
  const customPhase = "requirements-review";
  config.phases[customPhase] = {
    ...config.phases.analysis,
    purpose: "Use a project-specific requirements review instead of the stock analysis phase.",
  };
  delete config.phases.analysis;
  config.phase_order = config.phase_order.map((phase) => phase === "analysis" ? customPhase : phase);
  for (const preset of Object.values(config.autonomy_policy.presets)) {
    preset.automatic_phases = preset.automatic_phases
      .map((phase) => phase === "analysis" ? customPhase : phase);
  }
  writeJson(configPath, config);
  pinProjectConfig(project);

  mustFail([
    "story",
    "complete-step",
    "--root",
    project,
    "--id",
    "ST-001",
    "--step",
    "technical-analysis",
    "--summary",
    "This legacy alias has no configured canonical target",
    "--allow-unapproved-contract-output",
  ], /Unknown story step 'technical-analysis'/);
});

test("config migration refuses to emit an applicable plan for an invalid target", () => {
  const project = tmpProject("invalid-config-migration-target");
  initProject(project);
  const configPath = path.join(project, ".sdlc", "config.json");
  const config = readJson(configPath);
  config.autonomy_policy.presets.checkpointed.automatic_phases.push("unconfigured-review");
  writeJson(configPath, config);

  const failed = mustFail([
    "config",
    "migrate",
    "--root",
    project,
    "--json",
  ], /target configuration|automatic_phases|configured phase/i);
  assert.doesNotMatch(failed.stdout, /"plan_hash"/u);
});

test("contract create asks before missing guidance or story output agreement", () => {
  const project = tmpProject("contract-readiness");
  initProject(project);
  story(project, "ST-001");
  createApprovedTemplate(project, "technical-analysis");

  mustFail([
    "contract",
    "create",
    "--root",
    project,
    "--phase",
    "analysis",
    "--story",
    "ST-001",
    "--id",
    "contract-ST-001-analysis",
  ], /missing project-specific context/i);

  mustFail([
    "contract",
    "create",
    "--root",
    project,
    "--phase",
    "analysis",
    "--story",
    "ST-001",
    "--id",
    "contract-ST-001-analysis",
    "--context-summary",
    "Analysis contract",
  ], /missing agreed output format for this story/i);

  mustFail([
    "contract",
    "create",
    "--root",
    project,
    "--phase",
    "analysis",
    "--story",
    "ST-001",
    "--id",
    "contract-ST-001-analysis",
    "--context-summary",
    "Analysis contract",
    "--question",
    "Which output detail level should be used?",
    "--output-ref",
    "technical-analysis:technical-analysis-v1:new",
  ], /open question/i);

  const completeContractResult = JSON.parse(mustRun([
    "contract",
    "create",
    "--root",
    project,
    "--phase",
    "analysis",
    "--story",
    "ST-001",
    "--id",
    "contract-ST-001-analysis",
    "--context-summary",
    "Analysis contract",
    "--qa",
    "Which output detail level should be used?|Architecture-level detail",
    "--output-ref",
    "technical-analysis:technical-analysis-v1:new",
    "--json",
  ]).stdout);
  assert.equal(completeContractResult.status, "proposed");
  assert.equal(completeContractResult.write_status, "created");
  assert.match(completeContractResult.human_guidance.required_decision, /Review the goal, context, expected result/u);
  const completeContract = completeContractResult.contract;
  assert.equal(completeContract.output_contract_refs[0].template_id, "technical-analysis-v1");
  const linkedStory = readJson(path.join(project, ".sdlc", "stories", "ST-001", "story.json"));
  assert.equal(linkedStory.contract_id, "contract-ST-001-analysis");

  const contractDraftGuidance = splitHumanGuidance(mustRun([
    "contract",
    "create",
    "--root",
    project,
    "--phase",
    "analysis",
    "--story",
    "ST-001",
    "--id",
    "contract-ST-001-analysis",
    "--context-summary",
    "Analysis work covering current architecture and delivery risks",
    "--qa",
    "Which output detail level should be used?|Architecture-level detail",
    "--output-ref",
    "technical-analysis:technical-analysis-v1:new",
    "--force",
  ]).stdout);
  assert.match(contractDraftGuidance.primary, /A draft work brief is ready for review/u);
  assert.match(contractDraftGuidance.primary, /Proposed work: Analysis work covering current architecture and delivery risks/u);
  assert.match(contractDraftGuidance.primary, /approve the draft or say what should change/u);
  assert.doesNotMatch(contractDraftGuidance.primary, /contract-ST-001-analysis|technical-analysis-v1|agentic-sdlc|--[a-z]/u);
  assert.match(contractDraftGuidance.technical, /Contract: contract-ST-001-analysis/u);
  assert.match(contractDraftGuidance.technical, /Lifecycle status: draft/u);

  const technicalContext = "Use /Users/antonio/project, C:\\repo\\src, and \\\\server\\share; run npm test";
  const technicalContextGuidance = splitHumanGuidance(mustRun([
    "contract",
    "create",
    "--root",
    project,
    "--phase",
    "analysis",
    "--story",
    "ST-001",
    "--id",
    "contract-ST-001-analysis",
    "--context-summary",
    technicalContext,
    "--qa",
    "Which output detail level should be used?|Architecture-level detail",
    "--output-ref",
    "technical-analysis:technical-analysis-v1:new",
    "--force",
  ]).stdout);
  for (const literal of ["/Users/antonio/project", "C:\\repo\\src", "\\\\server\\share", "npm test"]) {
    assert.equal(technicalContextGuidance.primary.includes(literal), false, literal);
    assert.equal(technicalContextGuidance.technical.includes(literal), true, literal);
  }
});

test("contract create auto-links story contract and requires explicit replacement", () => {
  const project = tmpProject("contract-story-link");
  initProject(project);
  story(project, "ST-LINK");
  createApprovedTemplate(project, "technical-analysis");

  const created = JSON.parse(mustRun([
    "contract",
    "create",
    "--root",
    project,
    "--phase",
    "analysis",
    "--story",
    "ST-LINK",
    "--id",
    "contract-ST-LINK-analysis",
    "--context-summary",
    "Analysis contract",
    "--question",
    "Who approves?",
    "--output-ref",
    "technical-analysis:technical-analysis-v1:new",
    "--allow-incomplete-contract",
    "--json",
  ]).stdout);
  assert.equal(created.story_link.status, "linked");
  assert.equal(readJson(path.join(project, ".sdlc", "stories", "ST-LINK", "story.json")).contract_id, "contract-ST-LINK-analysis");

  mustFail([
    "contract",
    "create",
    "--root",
    project,
    "--phase",
    "analysis",
    "--story",
    "ST-LINK",
    "--id",
    "contract-ST-LINK-analysis-v2",
    "--context-summary",
    "Replacement analysis contract",
    "--qa",
    "Who approves?|Owner",
    "--output-ref",
    "technical-analysis:technical-analysis-v1:new",
  ], /already references contract contract-ST-LINK-analysis/);

  const replaced = JSON.parse(mustRun([
    "contract",
    "create",
    "--root",
    project,
    "--phase",
    "analysis",
    "--story",
    "ST-LINK",
    "--id",
    "contract-ST-LINK-analysis-v2",
    "--context-summary",
    "Replacement analysis contract",
    "--qa",
    "Who approves?|Owner",
    "--output-ref",
    "technical-analysis:technical-analysis-v1:new",
    "--replace-story-contract",
    "--json",
  ]).stdout);
  assert.equal(replaced.story_link.status, "replaced");
  assert.equal(readJson(path.join(project, ".sdlc", "stories", "ST-LINK", "story.json")).contract_id, "contract-ST-LINK-analysis-v2");

  mustRun([
    "contract",
    "approve",
    "--root",
    project,
    "--id",
    "contract-ST-LINK-analysis-v2",
    ...humanApproval("Approved replacement contract v2"),
  ]);

  const replacedAgain = JSON.parse(mustRun([
    "contract",
    "create",
    "--root",
    project,
    "--phase",
    "analysis",
    "--story",
    "ST-LINK",
    "--id",
    "contract-ST-LINK-analysis-v3",
    "--context-summary",
    "Final replacement analysis contract",
    "--qa",
    "Who approves?|Owner",
    "--output-ref",
    "technical-analysis:technical-analysis-v1:new",
    "--replace-story-contract",
    "--json",
  ]).stdout);
  assert.equal(replacedAgain.story_link.status, "replaced");
  mustRun([
    "contract",
    "approve",
    "--root",
    project,
    "--id",
    "contract-ST-LINK-analysis-v3",
    ...humanApproval("Approved replacement contract v3"),
  ]);
  const outputDir = path.join(project, ".sdlc", "stories", "ST-LINK", "outputs");
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "technical-analysis.md"), "# Technical analysis\n\nCanonical candidate output for the active contract.\n");

  const requests = JSON.parse(
    mustRun(["approval", "requests", "--root", project, "--story", "ST-LINK", "--json"]).stdout,
  ).requests.filter((request) => ["contract_approval", "contract_clarification", "output_link_required"].includes(request.type));
  assert.deepEqual(requests.map((request) => request.subject_id), ["contract-ST-LINK-analysis-v3"]);

  const globalOutputRequests = JSON.parse(
    mustRun(["approval", "requests", "--root", project, "--json"]).stdout,
  ).requests.filter((request) => request.type === "output_link_required");
  assert.deepEqual(globalOutputRequests.map((request) => request.subject_id), ["contract-ST-LINK-analysis-v3"]);

  const globalContractRequests = JSON.parse(
    mustRun(["approval", "requests", "--root", project, "--json"]).stdout,
  ).requests.filter((request) => (
    request.story_id === "ST-LINK"
    && ["contract_approval", "contract_clarification"].includes(request.type)
  ));
  assert.deepEqual(globalContractRequests, []);
});

test("story context is rehashed after contract auto-link so task start stays fresh", () => {
  const project = tmpProject("contract-story-context-fresh");
  initProject(project);
  story(project, "ST-CONTEXT", ["--phase", "implementation", "--status", "ready"]);
  createApprovedTemplate(project, "functional-analysis");
  const storyRelativePath = ".sdlc/stories/ST-CONTEXT/story.json";

  mustRun([
    "contract",
    "create",
    "--root",
    project,
    "--phase",
    "implementation",
    "--story",
    "ST-CONTEXT",
    "--id",
    "contract-ST-CONTEXT-implementation",
    "--context-file",
    storyRelativePath,
    "--context-summary",
    "Use the canonical story as implementation context.",
    "--qa",
    "Who approves?|Owner",
    "--output-ref",
    "functional-analysis:functional-analysis-v1:new",
  ]);

  const contractPath = path.join(project, ".sdlc", "contracts", "contract-ST-CONTEXT-implementation.json");
  const contract = readJson(contractPath);
  const source = contract.contextualization.context_sources.find((item) => item.path === storyRelativePath);
  assert.equal(source.sha256, sha256File(path.join(project, storyRelativePath)));
  mustRun([
    "contract",
    "approve",
    "--root",
    project,
    "--id",
    "contract-ST-CONTEXT-implementation",
    ...humanApproval("Approved fresh story-context contract"),
  ]);

  const started = JSON.parse(mustRun([
    "task",
    "start",
    "--root",
    project,
    "--json",
    "--intent-json",
    routeIntent({
      requested_action: "implement_story",
      referenced_entities: [{ type: "story", id: "ST-CONTEXT" }],
      proposed_phase: "implementation",
      artifact_type: "functional-analysis",
    }),
    "--confirm-start",
    "--actor-type",
    "human",
  ]).stdout);
  assert.equal(started.execution_allowed, true);
  assert.deepEqual(started.contract.freshness_gaps, []);
});

test("phase outputs and story step completion require approved story contracts", () => {
  const project = tmpProject("phase-output-contract-gate");
  initProject(project);
  story(project, "ST-001");
  createApprovedTemplate(project, "technical-analysis");
  mustRun([
    "contract",
    "create",
    "--root",
    project,
    "--phase",
    "analysis",
    "--story",
    "ST-001",
    "--id",
    "contract-ST-001-analysis",
    "--context-summary",
    "Analysis contract",
    "--qa",
    "Who approves?|Owner",
    "--output-ref",
    "technical-analysis:technical-analysis-v1:new",
  ]);
  const artifact = writeArtifact(project, ".sdlc/requirements/ST-001-technical-analysis.md", "# Technical Analysis\n");

  mustFail([
    "output",
    "link",
    "--root",
    project,
    "--story",
    "ST-001",
    "--type",
    "technical-analysis",
    "--artifact",
    artifact,
    "--template",
    "technical-analysis-v1",
    "--mode",
    "new",
    "--requirement",
    "REQ-001",
  ], /output\.link is blocked[\s\S]*contract\.status is 'draft'/);

  mustFail([
    "story",
    "complete-step",
    "--root",
    project,
    "--id",
    "ST-001",
    "--step",
    "technical-analysis",
    "--type",
    "technical-analysis",
    "--summary",
    "Attempted before approval",
  ], /story\.complete-step is blocked[\s\S]*contract\.status is 'draft'/);

  mustRun(["contract", "approve", "--root", project, "--id", "contract-ST-001-analysis", ...humanApproval("Approved analysis contract")]);
  startStoryTask(project, "ST-001", "analysis");
  mustRun([
    "output",
    "link",
    "--root",
    project,
    "--story",
    "ST-001",
    "--type",
    "technical-analysis",
    "--artifact",
    artifact,
    "--template",
    "technical-analysis-v1",
    "--mode",
    "new",
    "--requirement",
    "REQ-001",
  ]);
  const completed = JSON.parse(mustRun([
    "story",
    "complete-step",
    "--root",
    project,
    "--id",
    "ST-001",
    "--step",
    "technical-analysis",
    "--type",
    "technical-analysis",
    "--summary",
    "Technical analysis accepted",
    "--json",
  ]).stdout);
  assert.equal(completed.step.status, "completed");
});

test("contract create requires agreed output templates and approval requests summarize pending user input", () => {
  const project = tmpProject("human-consent-gates");
  initProject(project);
  story(project, "ST-001");
  const proposedTemplate = JSON.parse(mustRun([
    "output",
    "template",
    "propose",
    "--root",
    project,
    "--type",
    "technical-analysis",
    "--id",
    "technical-analysis-v1",
    "--summary",
    "Technical analysis format",
    "--json",
  ]).stdout);
  assert.match(proposedTemplate.assistant_message, /Output format \(technical-analysis-v1\)/);
  assert.equal(proposedTemplate.approval_request.type, "output_template_approval");
  assert.ok(proposedTemplate.approval_request.review_items.some((item) => /What this is: the proposed structure/.test(item)));

  mustFail([
    "contract",
    "create",
    "--root",
    project,
    "--phase",
    "analysis",
    "--story",
    "ST-001",
    "--id",
    "contract-ST-001-analysis",
    "--context-summary",
    "Analysis contract",
    "--output-ref",
    "technical-analysis:technical-analysis-v1:new",
  ], /output refs require approved output templates/i);

  mustRun([
    "contract",
    "create",
    "--root",
    project,
    "--phase",
    "analysis",
    "--story",
    "ST-001",
    "--id",
    "contract-ST-001-analysis",
    "--context-summary",
    "Analysis contract awaiting agreement",
    "--allow-incomplete-contract",
  ]);

  const requests = JSON.parse(mustRun(["approval", "requests", "--root", project, "--story", "ST-001", "--json"]).stdout);
  assert.equal(requests.status, "needs_user_input");
  assert.match(requests.assistant_message, /Plainly:/);
  assert.match(requests.assistant_message, /workflow terms/);
  assert.match(requests.assistant_message, /I will summarize the relevant file contents here/);
  assert.match(requests.assistant_message, /approval applies only to the item or items shown/);
  assert.doesNotMatch(requests.assistant_message, /blocking_reasons/);
  assert.match(requests.assistant_message, /You can answer in natural language/);
  assert.ok(requests.requests.some((request) => request.type === "output_template_approval" && request.subject_id === "technical-analysis-v1"));
  assert.ok(requests.requests.some((request) => request.type === "contract_clarification" && request.subject_id === "contract-ST-001-analysis"));
  assert.equal(requests.requests.some((request) => request.type === "contract_approval" && request.subject_id === "contract-ST-001-analysis"), false);
  assert.equal(requests.requests.some((request) => request.type === "output_link_required"), false);
  assert.ok(requests.requests.every((request) => request.suggested_question));
  assert.ok(requests.requests.every((request) => request.title));
  assert.ok(requests.requests.every((request) => request.why_needed));
  assert.ok(requests.requests.every((request) => request.user_prompt));
  assert.ok(requests.requests.every((request) => request.approval_scope?.cannot_approve_future_artifacts === true));
  assert.ok(requests.requests.every((request) => Array.isArray(request.review_items) && request.review_items.length > 0));
  assert.ok(requests.requests.some((request) => request.type === "contract_clarification" && /Context:/.test(request.review_items.join(" "))));
  const outputTemplateRequest = requests.requests.find((request) => request.type === "output_template_approval");
  assert.ok(outputTemplateRequest.review_items.some((item) => /Decision scope:/.test(item)));
  assert.ok(outputTemplateRequest.review_items.some((item) => /Document sections:/.test(item)));
  assert.ok(outputTemplateRequest.review_items.some((item) => /Template content to review:/.test(item)));
  const outputTemplateDeliveryIds = outputTemplateRequest.delivery_format_options.map((option) => option.id);
  assert.deepEqual(outputTemplateDeliveryIds.slice(0, 8), ["markdown", "docx", "xlsx", "pdf", "pptx", "html", "json", "csv"]);
  assert.equal(outputTemplateDeliveryIds.includes("chat-summary"), true);
  assert.match(outputTemplateRequest.recommended_delivery_format, /Markdown document \(\.md\)/);
  assert.match(outputTemplateRequest.delivery_question, /canonical result remain Markdown document \(\.md\)/);

  assert.equal(requests.assistant_message_source_language, "en");
  assert.equal(requests.assistant_message_presentation.translate_to_chat_language, true);
  assert.equal(requests.assistant_message_presentation.presenter, "codex");
  assert.ok(requests.assistant_message_presentation.preserve_literals.includes("CLI commands"));
  assert.match(requests.assistant_message_presentation.instruction, /plain product/);
  assert.match(requests.assistant_message_presentation.instruction, /summarize (?:the )?relevant contents directly/i);
  assert.match(requests.assistant_message_presentation.instruction, /instead of sending the user to inspect files/i);
  assert.match(requests.assistant_message_presentation.instruction, /broader approval level/);

  const plainRequests = mustRun(["approval", "requests", "--root", project, "--story", "ST-001"]).stdout;
  const approvalGuidance = splitHumanGuidance(plainRequests);
  assert.match(approvalGuidance.primary, /Choices to review:/u);
  assert.match(approvalGuidance.primary, /Result structure and format/u);
  assert.match(approvalGuidance.primary, /Missing work information/u);
  assert.match(approvalGuidance.primary, /say in ordinary language whether it is right or what should change/u);
  assert.doesNotMatch(
    approvalGuidance.primary,
    /technical-analysis-v1|contract-ST-001-analysis|agentic-sdlc|--[a-z]|\.sdlc/u,
  );
  assert.match(approvalGuidance.technical, /technical-analysis-v1/u);
  assert.match(plainRequests, /I need your decision/);
  assert.match(plainRequests, /What is inside this item/);
  assert.match(plainRequests, /Scope of your answer:/);
  assert.match(plainRequests, /How I can present the result/);
  assert.match(plainRequests, /If you say yes/);
  assert.match(plainRequests, /Decision needed:/);
  assert.match(plainRequests, /Proposed document structure:/);
  assert.match(plainRequests, /Tools and access being approved:/);
  assert.doesNotMatch(plainRequests, /Agent command/);

  const gate = JSON.parse(mustRun([
    "gate",
    "check",
    "--root",
    project,
    "--story",
    "ST-001",
    "--json",
  ]).stdout);
  assert.match(gate.assistant_message, /Plainly:/);
  assert.equal(gate.assistant_message_source_language, "en");
  assert.equal(gate.assistant_message_presentation.translate_to_chat_language, true);
  assert.ok(gate.approval_requests.some((request) => request.type === "contract_clarification"));
  assert.equal(gate.approval_requests.some((request) => request.type === "contract_approval"), false);

  mustRun([
    "output",
    "template",
    "approve",
    "--root",
    project,
    "--id",
    "technical-analysis-v1",
    ...humanApproval("Approved canonical technical analysis format"),
  ]);
  mustRun([
    "contract",
    "create",
    "--root",
    project,
    "--phase",
    "analysis",
    "--story",
    "ST-001",
    "--id",
    "contract-ST-001-analysis",
    "--context-summary",
    "Analysis contract ready for approval",
    "--qa",
    "Who reviews the analysis?|Product and engineering owners",
    "--output-ref",
    "technical-analysis:technical-analysis-v1:new",
    "--force",
  ]);
  const approvable = JSON.parse(mustRun([
    "approval",
    "requests",
    "--root",
    project,
    "--story",
    "ST-001",
    "--json",
  ]).stdout);
  const contractApprovalRequest = approvable.requests.find(
    (request) => request.type === "contract_approval" && request.subject_id === "contract-ST-001-analysis",
  );
  assert.ok(contractApprovalRequest);
  assert.equal(approvable.requests.some(
    (request) => request.type === "contract_clarification" && request.subject_id === "contract-ST-001-analysis",
  ), false);
  assert.equal(approvable.requests.some((request) => request.type === "output_link_required"), false);
  assert.ok(contractApprovalRequest.delivery_format_options.some((option) => option.id === "chat-summary"));
  assert.ok(contractApprovalRequest.delivery_format_options.some((option) => option.id === "executive-summary"));

  mustRun([
    "contract",
    "approve",
    "--root",
    project,
    "--id",
    "contract-ST-001-analysis",
    ...humanApproval("Approved complete analysis contract"),
  ]);
  const beforeCandidate = JSON.parse(mustRun([
    "approval",
    "requests",
    "--root",
    project,
    "--story",
    "ST-001",
    "--json",
  ]).stdout);
  assert.equal(beforeCandidate.requests.some((request) => request.type === "output_link_required"), false);

  const candidate = writeArtifact(
    project,
    ".sdlc/stories/ST-001/outputs/technical-analysis.md",
    "# Completed technical analysis\n",
  );
  const afterCandidate = JSON.parse(mustRun([
    "approval",
    "requests",
    "--root",
    project,
    "--story",
    "ST-001",
    "--json",
  ]).stdout);
  const outputLinkRequest = afterCandidate.requests.find((request) => request.type === "output_link_required");
  assert.ok(outputLinkRequest);
  assert.match(outputLinkRequest.suggested_command, new RegExp(candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("implementation contract approvals retain code review delivery choices", () => {
  const project = tmpProject("implementation-output-delivery-options");
  initProject(project);
  story(project, "ST-001");
  mustRun([
    "output",
    "template",
    "propose",
    "--root",
    project,
    "--type",
    "implementation-summary",
    "--summary",
    "Implementation summary format",
  ]);

  const requests = JSON.parse(mustRun(["approval", "requests", "--root", project, "--json"]).stdout);
  const templateRequest = requests.requests.find((item) => item.type === "output_template_approval" && item.subject_id === "implementation-summary-v1");
  assert.ok(templateRequest, "implementation output template approval request missing");
  assert.deepEqual(
    templateRequest.delivery_format_options.slice(0, 8).map((option) => option.id),
    ["markdown", "docx", "xlsx", "pdf", "pptx", "html", "json", "csv"],
  );
  assert.equal(templateRequest.delivery_format_options.some((option) => option.id === "changed-files-summary"), true);

  mustRun([
    "output",
    "template",
    "approve",
    "--root",
    project,
    "--id",
    "implementation-summary-v1",
    ...humanApproval("Approved implementation summary format"),
  ]);
  mustRun([
    "contract",
    "create",
    "--root",
    project,
    "--phase",
    "implementation",
    "--story",
    "ST-001",
    "--id",
    "contract-ST-001-implementation",
    "--context-summary",
    "Implement and report the requested change.",
    "--qa",
    "What should the summary cover?|Changed files, components, and verification",
    "--output-ref",
    "implementation-summary:implementation-summary-v1:new",
  ]);
  const contractRequests = JSON.parse(mustRun([
    "approval",
    "requests",
    "--root",
    project,
    "--story",
    "ST-001",
    "--json",
  ]).stdout);
  const request = contractRequests.requests.find(
    (item) => item.type === "contract_approval" && item.subject_id === "contract-ST-001-implementation",
  );
  assert.ok(request, "implementation contract approval request missing");
  const deliveryIds = request.delivery_format_options.map((option) => option.id);
  assert.ok(deliveryIds.includes("changed-files-summary"));
  assert.ok(deliveryIds.includes("modified-classes-components"));
  assert.ok(deliveryIds.includes("diff-review"));
  assert.ok(deliveryIds.includes("key-code-snippets"));
  assert.ok(deliveryIds.includes("tests-and-verification"));
  assert.ok(deliveryIds.includes("no-code-summary"));
  assert.match(request.recommended_delivery_format, /changed-files-summary/);
  assert.match(request.delivery_question, /Changed files summary/);
  assert.match(request.delivery_question, /Diff or patch review/);
});

test("latest template approval supersedes legacy template decision history", () => {
  const project = tmpProject("template-approval-history");
  initProject(project);
  createStrictReadyStory(project, "ST-001");
  mustRun(["story", "claim", "--root", project, "--id", "ST-001", "--agent", "codex", "--branch", "feature/ST-001"]);

  const registryPath = path.join(project, ".sdlc", "output-contracts", "registry.json");
  const registry = readJson(registryPath);
  const current = registry.decisions.find((decision) => decision.type === "template_approved");
  registry.decisions.unshift({
    ...current,
    id: "DEC-legacy-template-approval",
    created_at: "2000-01-01T00:00:00.000Z",
    approval_source: undefined,
  });
  writeJson(registryPath, registry);

  mustRun(["gate", "check", "--root", project, "--story", "ST-001", "--strict"]);
});

test("trace attribution separates executor requester and authorizer in report queries", () => {
  const project = tmpProject("trace-authority-attribution");
  initProject(project);
  story(project, "ST-001");
  const appended = JSON.parse(mustRun([
    "trace",
    "append",
    "--root",
    project,
    "--story",
    "ST-001",
    "--type",
    "implementation",
    "--summary",
    "Implemented Codex-executed requester attribution",
    "--actor",
    "codex",
    "--actor-type",
    "agent",
    "--requested-by",
    "antonio",
    "--requested-by-type",
    "human",
    "--requested-by-name",
    "Antonio Antenore",
    "--authorized-by",
    "antonio",
    "--authorized-by-type",
    "human",
    "--request-summary",
    "Add requested_by and authorized_by audit fields",
    "--thread-id",
    "THREAD-REQ-001",
    "--json",
  ]).stdout);
  assert.equal(appended.event.actor.id, "codex");
  assert.equal(appended.event.requested_by.id, "antonio");
  assert.equal(appended.event.authorized_by.id, "antonio");
  assert.equal(appended.event.request.summary, "Add requested_by and authorized_by audit fields");
  assert.equal(appended.event.request.thread_id, "THREAD-REQ-001");

  const defaultActorTrace = JSON.parse(mustRun([
    "trace",
    "append",
    "--root",
    project,
    "--story",
    "ST-001",
    "--type",
    "implementation",
    "--summary",
    "Implemented unrequested Codex task",
    "--json",
  ]).stdout);
  assert.equal(defaultActorTrace.event.actor.id, "codex");
  assert.equal(defaultActorTrace.event.actor.type, "agent");

  const requesterQuery = JSON.stringify({
    intent: "find_changes_requested_by_user",
    confidence: 0.96,
    subjects: ["activity"],
    filters: { requester: ["antonio"] },
    sort: "created_at_desc",
  });
  const requesterReport = JSON.parse(mustRun(["report", "query", "--root", project, "--query-json", requesterQuery, "--json"]).stdout);
  assert.equal(requesterReport.summary.result_count, 1);
  assert.equal(requesterReport.results[0].summary, "Implemented Codex-executed requester attribution");
  assert.equal(requesterReport.results[0].actor.id, "codex");
  assert.equal(requesterReport.results[0].requested_by.id, "antonio");
  assert.equal(requesterReport.summary.by_requester.antonio, 1);

  const executorQuery = JSON.stringify({
    intent: "find_changes_executed_by_agent",
    confidence: 0.96,
    subjects: ["activity"],
    filters: { executor: ["codex"] },
    sort: "created_at_desc",
  });
  const executorReport = JSON.parse(mustRun(["report", "query", "--root", project, "--query-json", executorQuery, "--json"]).stdout);
  assert.equal(executorReport.summary.result_count, 2);

  const authorizerQuery = JSON.stringify({
    intent: "find_changes_authorized_by_user",
    confidence: 0.96,
    subjects: ["activity"],
    filters: { authorizer: ["antonio"] },
    sort: "created_at_desc",
  });
  const authorizerReport = JSON.parse(mustRun(["report", "query", "--root", project, "--query-json", authorizerQuery, "--json"]).stdout);
  assert.equal(authorizerReport.summary.result_count, 1);
});

test("report query finds new functional stories from canonical story records", () => {
  const project = tmpProject("report-query-stories");
  initProject(project);
  mustRun([
    "story",
    "create",
    "--root",
    project,
    "--id",
    "ST-FUNC-001",
    "--title",
    "Functional onboarding flow",
    "--acceptance",
    "Functional flow is observable",
    "--requirement",
    "REQ-FUNC",
  ]);
  mustRun([
    "story",
    "create",
    "--root",
    project,
    "--id",
    "ST-TECH-001",
    "--title",
    "Technical runtime setup",
    "--acceptance",
    "Runtime setup is observable",
    "--requirement",
    "REQ-TECH",
  ]);
  const query = JSON.stringify({
    intent: "find_new_functional_stories",
    confidence: 0.94,
    subjects: ["stories"],
    time: { since: "10d", until: "now", field: "created_at" },
    filters: { text: ["functional"] },
    sort: "created_at_desc",
  });
  const report = JSON.parse(mustRun(["report", "query", "--root", project, "--query-json", query, "--json"]).stdout);
  assert.equal(report.summary.result_count, 1);
  assert.equal(report.results[0].id, "ST-FUNC-001");
  assert.equal(report.results[0].kind, "stories");
});

test("CLI rejects unknown, duplicate, and missing option values and honors explicit false", () => {
  const project = tmpProject("strict-options");
  initProject(project);
  mustFail(["status", "--root", project, "--definitely-unknown", "value"], /Unknown option --definitely-unknown/);
  mustFail([
    "story",
    "create",
    "--root",
    project,
    "--id",
    "ST-001",
    "--id",
    "ST-002",
    "--title",
    "Duplicate id",
  ], /Option --id may only be provided once/);
  mustFail(["story", "create", "--root", project, "--id", "ST-001", "--title", "--json"], /Missing value for option --title/);
  const archive = JSON.parse(mustRun([
    "archive",
    "closed",
    "--root",
    project,
    "--before",
    "now",
    "--apply=false",
    "--json",
  ]).stdout);
  assert.equal(archive.status, "planned");
  assert.equal(archive.plan.apply_requested, false);
  assert.equal(archive.plan.applied, false);
});

test("filesystem boundaries reject symlinked cache and canonical directories", { skip: process.platform === "win32" }, () => {
  const project = tmpProject("symlink-boundaries");
  initProject(project);
  const externalCache = tmpProject("external-cache");
  const sentinel = path.join(externalCache, "keep.txt");
  fs.writeFileSync(sentinel, "keep\n");
  const cacheRoot = path.join(project, ".sdlc", "cache");
  fs.rmSync(cacheRoot, { recursive: true, force: true });
  fs.symlinkSync(externalCache, cacheRoot, "dir");
  mustFail(["cache", "clear", "--root", project], /symlink|outside the target project root/i);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "keep\n");

  const externalContracts = tmpProject("external-contracts");
  const contractsRoot = path.join(project, ".sdlc", "contracts");
  fs.rmSync(contractsRoot, { recursive: true, force: true });
  fs.symlinkSync(externalContracts, contractsRoot, "dir");
  mustFail(["gate", "check", "--root", project, "--strict"], /symlink/i);
  assert.deepEqual(fs.readdirSync(externalContracts), []);

  const storyProject = tmpProject("symlinked-story-record");
  initProject(storyProject);
  story(storyProject, "ST-001");
  const storyPath = path.join(storyProject, ".sdlc", "stories", "ST-001", "story.json");
  const externalStory = path.join(tmpProject("external-story"), "story.json");
  fs.copyFileSync(storyPath, externalStory);
  fs.rmSync(storyPath);
  fs.symlinkSync(externalStory, storyPath);
  mustFail(["gate", "check", "--root", storyProject, "--story", "ST-001", "--strict"], /symlink|outside the target project root/i);
});

test("contract ids cannot escape the canonical contract directory", () => {
  const project = tmpProject("contract-id-boundary");
  initProject(project);
  story(project, "ST-001");
  const storyPath = path.join(project, ".sdlc", "stories", "ST-001", "story.json");
  const storyRecord = readJson(storyPath);
  writeJson(storyPath, { ...storyRecord, contract_id: "../../outside" });
  mustFail(["gate", "check", "--root", project, "--story", "ST-001", "--strict"], /Invalid id/);
  assert.equal(fs.existsSync(path.join(project, "outside.json")), false);
});

test("nested decision changes invalidate an existing approval", () => {
  const project = tmpProject("nested-approval-hash");
  initProject(project);
  mustRun([
    "contract",
    "create",
    "--root",
    project,
    "--phase",
    "analysis",
    "--id",
    "contract-analysis",
    "--context-summary",
    "Analyze the project",
    "--qa",
    "Which boundary applies?|Repository only",
  ]);
  mustRun(["contract", "approve", "--root", project, "--id", "contract-analysis", ...humanApproval("Approved nested decision")]);
  const contractPath = path.join(project, ".sdlc", "contracts", "contract-analysis.json");
  const contract = readJson(contractPath);
  contract.contextualization.questions[0].status = "open";
  writeJson(contractPath, contract);
  mustFail(["gate", "check", "--root", project, "--strict"], /stale or missing approved_content_hash/i);
});

test("parallel contract approvals are serialized without losing records", async () => {
  const project = tmpProject("parallel-contract-approval");
  initProject(project);
  mustRun([
    "contract",
    "create",
    "--root",
    project,
    "--phase",
    "analysis",
    "--id",
    "contract-analysis",
    "--context-summary",
    "Concurrent approval test",
  ]);
  const commands = ["Approval A", "Approval B"].map((summary) => [
    "contract",
    "approve",
    "--root",
    project,
    "--id",
    "contract-analysis",
    ...humanApproval(summary),
  ]);
  const results = await Promise.all(commands.map((command) => runAsync(command)));
  for (const result of results) {
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  }
  const contract = readJson(path.join(project, ".sdlc", "contracts", "contract-analysis.json"));
  assert.deepEqual(new Set(contract.approvals.map((approval) => approval.summary)), new Set(["Approval A", "Approval B"]));
  assert.equal(contract.approvals.length, 2);
});

test("parallel story contract creation is serialized per story", async () => {
  const project = tmpProject("parallel-story-contract-create");
  initProject(project);
  story(project, "ST-RACE");
  createApprovedTemplate(project, "technical-analysis");

  const ids = Array.from({ length: 8 }, (_, index) => `contract-ST-RACE-analysis-${index + 1}`);
  const results = await Promise.all(ids.map((id) => runAsync([
    "contract",
    "create",
    "--root",
    project,
    "--phase",
    "analysis",
    "--story",
    "ST-RACE",
    "--id",
    id,
    "--context-summary",
    `Concurrent contract ${id}`,
    "--qa",
    "Who approves?|Owner",
    "--output-ref",
    "technical-analysis:technical-analysis-v1:new",
    "--json",
  ])));

  const successful = results.filter((result) => result.status === 0);
  const rejected = results.filter((result) => result.status !== 0);
  assert.equal(successful.length, 1, results.map((result) => `${result.status}: ${result.stderr}`).join("\n"));
  assert.equal(rejected.length, ids.length - 1);
  assert.ok(
    rejected.every((result) => /already references contract/.test(result.stderr)),
    rejected.map((result) => `${result.status}: ${result.stdout}\n${result.stderr}`).join("\n"),
  );

  const linkedStory = readJson(path.join(project, ".sdlc", "stories", "ST-RACE", "story.json"));
  const contractsRoot = path.join(project, ".sdlc", "contracts");
  const createdContracts = ids.filter((id) => fs.existsSync(path.join(contractsRoot, `${id}.json`)));
  assert.deepEqual(createdContracts, [linkedStory.contract_id]);
  assert.equal(fs.readdirSync(contractsRoot).some((name) => name.startsWith(".story-") && name.endsWith(".lock")), false);
});

test("parallel contract revision and approval preserve one valid serialized outcome", async () => {
  const project = tmpProject("parallel-contract-revision");
  initProject(project);
  mustRun([
    "contract",
    "create",
    "--root",
    project,
    "--phase",
    "analysis",
    "--id",
    "contract-analysis",
    "--context-summary",
    "Original contract content",
  ]);
  const revision = [
    "contract",
    "create",
    "--root",
    project,
    "--phase",
    "analysis",
    "--id",
    "contract-analysis",
    "--context-summary",
    "Revised contract content",
    "--force",
  ];
  const approval = [
    "contract",
    "approve",
    "--root",
    project,
    "--id",
    "contract-analysis",
    ...humanApproval("Concurrent approval"),
  ];
  const [revisionResult, approvalResult] = await Promise.all([
    runAsync(revision),
    runAsync(approval),
  ]);
  assert.equal(revisionResult.signal, null, revisionResult.stderr);
  assert.equal(approvalResult.signal, null, approvalResult.stderr);
  assert.equal(approvalResult.status, 0, approvalResult.stderr);
  const contract = readJson(path.join(project, ".sdlc", "contracts", "contract-analysis.json"));
  assert.equal(contract.status, "approved");
  assert.equal(contract.approvals.length, 1);
  assert.equal(
    contract.approvals[0].approved_content_hash,
    computeGovernedApprovalSubjectHash(contract),
  );
  if (revisionResult.status === 0) {
    assert.equal(contract.contextualization.summary, "Revised contract content");
  } else {
    assert.equal(revisionResult.status, 1, revisionResult.stderr);
    assert.match(
      revisionResult.stderr,
      /already reviewed or no longer a draft.*immutable/is,
    );
    assert.equal(contract.contextualization.summary, "Original contract content");
  }
});

test("parallel claim replacement and release cannot release the replacement claim", async () => {
  const project = tmpProject("parallel-claim-release");
  initProject(project);
  story(project, "ST-001");
  createApprovedTemplate(project, "functional-analysis");
  createApprovedStoryContract(project, "ST-001", "design", "functional-analysis");
  startStoryTask(project, "ST-001", "design");
  mustRun(["story", "claim", "--root", project, "--id", "ST-001", "--agent", "agent-old"]);
  const replacement = runAsync([
    "story",
    "claim",
    "--root",
    project,
    "--id",
    "ST-001",
    "--agent",
    "agent-new",
    "--actor-type",
    "human",
    "--force",
  ]);
  const release = runAsync([
    "story",
    "release",
    "--root",
    project,
    "--id",
    "ST-001",
    "--agent",
    "agent-old",
  ]);
  const [replacementResult, releaseResult] = await Promise.all([replacement, release]);
  assert.equal(replacementResult.status, 0, replacementResult.stderr);
  assert.ok([0, 1].includes(releaseResult.status), releaseResult.stderr);
  const claim = readJson(path.join(project, ".sdlc", "stories", "ST-001", "claim.json"));
  assert.equal(claim.agent, "agent-new");
  assert.equal(claim.status, "active");
});

test("parallel dependency approvals preserve every graph edge", async () => {
  const project = tmpProject("parallel-dependency-approval");
  initProject(project);
  story(project, "ST-001");
  story(project, "ST-002");
  story(project, "ST-003");
  mustRun(["dependency", "propose", "--root", project, "--id", "DEP-A", "--edge", "ST-002:ST-001:blocks:implementation:done"]);
  mustRun(["dependency", "propose", "--root", project, "--id", "DEP-B", "--edge", "ST-003:ST-001:blocks:implementation:done"]);
  const results = await Promise.all([
    runAsync(["dependency", "approve", "--root", project, "--id", "DEP-A", ...humanApproval("Approve A")]),
    runAsync(["dependency", "approve", "--root", project, "--id", "DEP-B", ...humanApproval("Approve B")]),
  ]);
  for (const result of results) {
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  }
  const graph = readJson(path.join(project, ".sdlc", "dependencies", "graph.json"));
  assert.deepEqual(new Set(graph.edges.map((edge) => edge.proposal_id)), new Set(["DEP-A", "DEP-B"]));
});

test("stale internal locks are recovered only after owner death and timeout", () => {
  const project = tmpProject("stale-internal-lock");
  initProject(project);
  mustRun([
    "contract",
    "create",
    "--root",
    project,
    "--phase",
    "analysis",
    "--id",
    "contract-analysis",
    "--context-summary",
    "Stale lock recovery",
  ]);
  const contractPath = path.join(project, ".sdlc", "contracts", "contract-analysis.json");
  const lockPath = `${contractPath}.lock`;
  writeJson(lockPath, {
    pid: 2_147_483_647,
    host: os.hostname(),
    nonce: "stale",
    created_at: new Date(Date.now() - 60_000).toISOString(),
  });
  mustRun(["contract", "approve", "--root", project, "--id", "contract-analysis", ...humanApproval("Recovered stale lock")]);
  assert.equal(fs.existsSync(lockPath), false);
  writeJson(lockPath, {
    pid: 1,
    host: "retired-build-host",
    nonce: "remote-stale",
    created_at: new Date(Date.now() - 10 * 60_000).toISOString(),
  });
  mustRun(["contract", "approve", "--root", project, "--id", "contract-analysis", ...humanApproval("Recovered expired remote lease")]);
  assert.equal(fs.existsSync(lockPath), false);
});

test("archive apply preflights all targets before moving any source", () => {
  const project = tmpProject("archive-atomic");
  initProject(project);
  const reportsRoot = path.join(project, ".sdlc", "reports");
  fs.mkdirSync(reportsRoot, { recursive: true });
  const first = path.join(reportsRoot, "a.json");
  const second = path.join(reportsRoot, "b.json");
  writeJson(first, { status: "closed" });
  writeJson(second, { status: "closed" });
  const old = new Date("2020-01-15T00:00:00.000Z");
  fs.utimesSync(first, old, old);
  fs.utimesSync(second, old, old);
  const conflictingTarget = path.join(project, ".sdlc", "archive", "2020", "01", "reports", "b.json");
  fs.mkdirSync(path.dirname(conflictingTarget), { recursive: true });
  writeJson(conflictingTarget, { existing: true });
  mustFail(["archive", "closed", "--root", project, "--before", "now", "--apply"], /Archive target already exists/);
  assert.equal(fs.existsSync(first), true);
  assert.equal(fs.existsSync(second), true);
  assert.deepEqual(readJson(conflictingTarget), { existing: true });

  const planProject = tmpProject("archive-plan-preflight");
  initProject(planProject);
  const source = writeArtifact(planProject, ".sdlc/reports/closed.json", "{}\n");
  fs.utimesSync(path.join(planProject, source), old, old);
  const existingPlan = writeArtifact(planProject, ".sdlc/archive/existing-plan.json", "{}\n");
  mustFail([
    "archive",
    "closed",
    "--root",
    planProject,
    "--before",
    "now",
    "--apply",
    "--out",
    existingPlan,
  ], /Archive plan already exists/);
  assert.equal(fs.existsSync(path.join(planProject, source)), true);
});

test("trace and sync commands reject nonexistent story ids", () => {
  const project = tmpProject("orphan-traces");
  initProject(project);
  mustFail([
    "trace",
    "append",
    "--root",
    project,
    "--story",
    "ST-MISSING",
    "--type",
    "test",
    "--summary",
    "Should not be recorded",
  ], /does not exist/);
  mustFail(["sync", "record", "--root", project, "--story", "ST-MISSING", "--event", "push"], /does not exist/);
  assert.equal(fs.existsSync(path.join(project, ".sdlc", "traces", "ST-MISSING.jsonl")), false);
});

test("personal marketplace installer stages only allowlisted plugin files", async () => {
  const home = tmpProject("personal-installer-home");
  const python = process.env.PYTHON || "python3";
  const installer = path.join(repoRoot, "scripts", "install-personal-marketplace.py");
  const invoke = (args = []) => spawnSync(python, [installer, ...args, "--home", home], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, HOME: home },
    timeout: 30_000,
  });
  const invokeAsync = (args = []) => new Promise((resolve, reject) => {
    const child = spawn(python, [installer, ...args, "--home", home], {
      cwd: repoRoot,
      env: { ...process.env, HOME: home },
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 35_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (status, signal) => {
      clearTimeout(timeout);
      resolve({ status, signal, stdout, stderr });
    });
  });
  const mustPlan = (args = []) => {
    const result = invoke(["plan", "--json", ...args]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.command, "plan");
    assert.match(envelope.data.plan_hash, /^[a-f0-9]{64}$/u);
    return { result, envelope };
  };
  const applyPlan = (planHash, args = []) => invoke([
    "apply", "--json", "--plan-hash", planHash, ...args,
  ]);

  const destination = path.join(home, "plugins", "agentic-sdlc-codex-plugin");
  const marketplacePath = path.join(home, ".agents", "plugins", "marketplace.json");
  const checked = invoke(["check", "--json"]);
  assert.equal(checked.status, 0, `${checked.stdout}\n${checked.stderr}`);
  assert.equal(JSON.parse(checked.stdout).command, "check");
  assert.equal(fs.existsSync(path.join(home, "plugins")), false);
  assert.equal(fs.existsSync(path.join(home, ".agents")), false);

  const defaultPlan = invoke(["--json"]);
  assert.equal(defaultPlan.status, 0, `${defaultPlan.stdout}\n${defaultPlan.stderr}`);
  const defaultPlanEnvelope = JSON.parse(defaultPlan.stdout);
  assert.equal(defaultPlanEnvelope.command, "plan", "running without a command must only plan");
  assert.equal(fs.existsSync(path.join(home, "plugins")), false);
  assert.equal(fs.existsSync(path.join(home, ".agents")), false);

  const { envelope: firstPlan } = mustPlan();
  assert.equal(firstPlan.data.plan_hash, defaultPlanEnvelope.data.plan_hash);
  assert.equal(fs.existsSync(path.join(home, "plugins")), false);
  assert.equal(fs.existsSync(path.join(home, ".agents")), false);
  const italianPlan = mustPlan(["--locale", "it"]).envelope;
  assert.equal(italianPlan.data.plan_hash, firstPlan.data.plan_hash);
  assert.match(italianPlan.human.outcome, /piano sicuro|già aggiornato/u);
  assert.match(italianPlan.human.protection_boundary, /ripristinat[io] insieme/u);

  const first = applyPlan(firstPlan.data.plan_hash);
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  const firstEnvelope = JSON.parse(first.stdout);
  assert.equal(firstEnvelope.data.plugin_transaction, "committed");
  assert.equal(fs.existsSync(path.join(destination, ".codex-plugin", "plugin.json")), true);
  assert.equal(fs.existsSync(path.join(destination, "lib", "change-observatory", "cli.mjs")), true);
  assert.equal(fs.existsSync(path.join(destination, "ui", "change-observatory", "index.html")), true);
  assert.equal(fs.existsSync(path.join(destination, "skills", "change-observatory", "SKILL.md")), true);
  assert.equal(fs.existsSync(path.join(destination, "skills", "change-observatory", "agents", "openai.yaml")), true);
  for (const excluded of [".git", ".sdlc", "test", ".DS_Store"]) {
    assert.equal(fs.existsSync(path.join(destination, excluded)), false, `${excluded} leaked into staged plugin`);
  }
  const stale = path.join(destination, "docs", "stale.md");
  fs.writeFileSync(stale, "stale\n");
  const secondPlan = mustPlan().envelope;
  const second = applyPlan(secondPlan.data.plan_hash);
  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
  assert.equal(fs.existsSync(stale), false);
  const marketplace = readJson(marketplacePath);
  const entry = marketplace.plugins.find((plugin) => plugin.name === "agentic-sdlc-codex-plugin");
  assert.equal(entry.source.path, "./plugins/agentic-sdlc-codex-plugin");
  const concurrentPlan = mustPlan().envelope;
  const concurrentArgs = [
    "apply", "--json", "--plan-hash", concurrentPlan.data.plan_hash,
  ];
  const concurrent = await Promise.all([invokeAsync(concurrentArgs), invokeAsync(concurrentArgs)]);
  for (const result of concurrent) {
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(JSON.parse(result.stdout).data.state, "current");
  }
  const concurrentMarketplace = readJson(marketplacePath);
  assert.equal(
    concurrentMarketplace.plugins.filter((plugin) => plugin.name === "agentic-sdlc-codex-plugin").length,
    1,
  );
  assert.equal(
    fs.existsSync(path.join(home, ".agents", "plugins", ".agentic-sdlc-codex-plugin.install.lock")),
    false,
  );

  if (process.platform !== "win32" && (typeof process.getuid !== "function" || process.getuid() !== 0)) {
    const rollbackSentinel = path.join(destination, "docs", "rollback-sentinel.md");
    fs.writeFileSync(rollbackSentinel, "restore me\n");
    const marketplaceDirectory = path.join(home, ".agents", "plugins");
    const rollbackPlan = mustPlan().envelope;
    fs.chmodSync(marketplaceDirectory, 0o500);
    let failedMarketplaceUpdate;
    try {
      failedMarketplaceUpdate = applyPlan(rollbackPlan.data.plan_hash);
    } finally {
      fs.chmodSync(marketplaceDirectory, 0o700);
    }
    assert.notEqual(failedMarketplaceUpdate.status, 0);
    assert.equal(fs.readFileSync(rollbackSentinel, "utf8"), "restore me\n");
  }

  if (process.platform === "win32") {
    const junctionHome = tmpProject("personal-installer-junction-home");
    const externalPlugins = tmpProject("personal-installer-junction-target");
    const sentinel = path.join(externalPlugins, "sentinel.txt");
    fs.writeFileSync(sentinel, "do not replace\n");
    fs.symlinkSync(externalPlugins, path.join(junctionHome, "plugins"), "junction");
    const junctionInstall = spawnSync(python, [installer, "plan", "--json", "--home", junctionHome], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, HOME: junctionHome },
      timeout: 30_000,
    });
    assert.notEqual(junctionInstall.status, 0);
    assert.match(`${junctionInstall.stdout}\n${junctionInstall.stderr}`, /symlinked or junction/i);
    assert.equal(fs.readFileSync(sentinel, "utf8"), "do not replace\n");
  }

  fs.writeFileSync(path.join(destination, "unmanaged.txt"), "do not delete\n");
  const refused = invoke(["plan"]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /unexpected unmanaged top-level entries/);
  assert.equal(fs.readFileSync(path.join(destination, "unmanaged.txt"), "utf8"), "do not delete\n");
});

test("personal marketplace installer v2 keeps an exact recovery point until confirmation", () => {
  const home = tmpProject("personal-installer-v2-home");
  const python = process.env.PYTHON || "python3";
  const installer = path.join(repoRoot, "scripts", "install-personal-marketplace-v2.py");
  const codexHome = path.join(home, ".codex");
  const fakeCodexDriver = path.join(home, "plugin");
  fs.writeFileSync(fakeCodexDriver, [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const args = process.argv.slice(2);",
    "const pluginName = 'agentic-sdlc-codex-plugin';",
    "const pluginId = `${pluginName}@personal`;",
    "const home = process.env.HOME;",
    "const codexHome = process.env.CODEX_HOME;",
    "const statePath = path.join(codexHome, 'fixture-installed.json');",
    "const cacheRoot = path.join(codexHome, 'plugins', 'cache', 'personal', pluginName);",
    "const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\\n`);",
    "const readState = () => fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null;",
    "if (args[0] === 'list') {",
    "  const state = readState();",
    "  emit({ installed: state ? [state] : [], available: [] });",
    "  process.exit(0);",
    "}",
    "if (args[0] === 'add' && args[1] === pluginId) {",
    "  const marketplace = JSON.parse(fs.readFileSync(path.join(home, '.agents', 'plugins', 'marketplace.json'), 'utf8'));",
    "  const plugin = marketplace.plugins.find((entry) => entry.name === pluginName);",
    "  const source = path.resolve(home, plugin.source.path);",
    "  const version = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')).version;",
    "  fs.rmSync(cacheRoot, { recursive: true, force: true });",
    "  const cachePath = path.join(cacheRoot, version);",
    "  fs.mkdirSync(path.dirname(cachePath), { recursive: true });",
    "  fs.cpSync(source, cachePath, { recursive: true });",
    "  const state = {",
    "    pluginId,",
    "    name: pluginName,",
    "    marketplaceName: 'personal',",
    "    version,",
    "    installed: true,",
    "    enabled: true,",
    "    source: { source: 'local', path: source },",
    "    installPolicy: 'AVAILABLE',",
    "    authPolicy: 'ON_INSTALL',",
    "  };",
    "  fs.mkdirSync(codexHome, { recursive: true });",
    "  fs.writeFileSync(statePath, JSON.stringify(state));",
    "  emit({ ok: true, plugin: state });",
    "  process.exit(0);",
    "}",
    "process.stderr.write(`unsupported fixture command: ${args.join(' ')}\\n`);",
    "process.exit(2);",
  ].join("\n"));
  const invoke = (args) => {
    const codexBinding = ["apply", "confirm", "restore"].includes(args[0])
      ? [
          "--codex-executable", process.execPath,
          "--codex-home", codexHome,
        ]
      : [];
    return spawnSync(python, [
      installer,
      ...args,
      "--home", home,
      ...codexBinding,
    ], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, HOME: home },
      timeout: 30_000,
    });
  };

  const planned = invoke(["plan", "--json"]);
  assert.equal(planned.status, 0, `${planned.stdout}\n${planned.stderr}`);
  const preview = JSON.parse(planned.stdout);
  assert.equal(preview.schema, "agentic-sdlc.local-installer.v2");
  assert.equal(preview.data.state, "ready_to_apply");
  assert.match(preview.data.plan_hash, /^[a-f0-9]{64}$/u);
  assert.equal(fs.existsSync(path.join(home, "plugins")), false, "v2 plan must not create plugin files");
  assert.equal(fs.existsSync(path.join(home, ".agents")), false, "v2 plan must not create transaction files");

  const applied = invoke(["apply", "--json", "--plan-hash", preview.data.plan_hash]);
  assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`);
  const pending = JSON.parse(applied.stdout);
  assert.equal(pending.data.state, "validation_pending");
  assert.match(pending.data.transaction_id, /^[a-f0-9]{24}$/u);
  assert.match(pending.technical_details.receipt_hash, /^[a-f0-9]{64}$/u);
  assert.equal(
    fs.existsSync(path.join(
      home,
      "plugins",
      "agentic-sdlc-codex-plugin",
      "scripts",
      "install-personal-marketplace-v2.py",
    )),
    true,
  );

  const bound = [
    "--transaction-id", pending.data.transaction_id,
    "--receipt-hash", pending.technical_details.receipt_hash,
  ];
  const registration = pending.technical_details.candidate_registration;
  assert.deepEqual(registration.required_before, ["validate", "confirm"]);
  const registered = spawnSync(
    registration.command.argv[0],
    registration.command.argv.slice(1),
    {
      cwd: home,
      encoding: "utf8",
      env: { ...process.env, ...registration.command.environment },
      timeout: 30_000,
    },
  );
  assert.equal(registered.status, 0, `${registered.stdout}\n${registered.stderr}`);
  const listed = spawnSync(
    registration.verification.argv[0],
    registration.verification.argv.slice(1),
    {
      cwd: home,
      encoding: "utf8",
      env: { ...process.env, ...registration.verification.environment },
      timeout: 30_000,
    },
  );
  assert.equal(listed.status, 0, `${listed.stdout}\n${listed.stderr}`);
  const installed = JSON.parse(listed.stdout).installed.find(
    (plugin) => plugin.pluginId === "agentic-sdlc-codex-plugin@personal",
  );
  assert.equal(installed.enabled, true);
  const validated = invoke(["validate", "--json", ...bound]);
  assert.equal(validated.status, 0, `${validated.stdout}\n${validated.stderr}`);
  assert.equal(JSON.parse(validated.stdout).data.state, "validation_pending");

  const confirmed = invoke(["confirm", "--json", ...bound]);
  assert.equal(confirmed.status, 0, `${confirmed.stdout}\n${confirmed.stderr}`);
  const confirmation = JSON.parse(confirmed.stdout);
  assert.equal(confirmation.data.state, "confirmed");
  assert.notEqual(confirmation.technical_details.receipt_hash, pending.technical_details.receipt_hash);

  const retried = invoke(["confirm", "--json", ...bound]);
  assert.equal(retried.status, 0, `${retried.stdout}\n${retried.stderr}`);
  assert.equal(
    JSON.parse(retried.stdout).technical_details.receipt_hash,
    confirmation.technical_details.receipt_hash,
  );
  const refusedRestore = invoke(["restore", "--json", ...bound]);
  assert.notEqual(refusedRestore.status, 0);
  assert.match(refusedRestore.stdout, /already confirmed/u);
});

test("personal marketplace installer can validate and configure RTK globally", () => {
  const home = tmpProject("personal-installer-rtk-home");
  const codexHome = path.join(home, ".codex-test");
  const fakeRoot = tmpProject("personal-installer-fake-rtk");
  const fakeRtkRunner = path.join(
    fakeRoot,
    process.platform === "win32" ? "rtk-fixture.cjs" : "rtk",
  );
  const fakeRtk = process.platform === "win32"
    ? path.join(fakeRoot, "rtk.cmd")
    : fakeRtkRunner;
  const invocationPath = path.join(fakeRoot, "invocations.jsonl");
  fs.writeFileSync(fakeRtkRunner, [
    `#!${process.execPath}`,
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    `const invocationPath = ${JSON.stringify(invocationPath)};`,
    "const args = process.argv.slice(2);",
    "const entry = process.env.RTK_FAKE_ENTRY || __filename;",
    "fs.appendFileSync(invocationPath, `${JSON.stringify({entry,args})}\\n`);",
    "if (args.join(' ') === '--version') process.stdout.write('rtk 0.43.0\\n');",
    "else if (args.join(' ') === 'gain --project --format json') process.stdout.write(JSON.stringify({summary:{total_commands:2,total_input:100,total_output:20,total_saved:75,avg_savings_pct:75}}));",
    "else if (args.join(' ') === 'init -g --codex') { const root=process.env.CODEX_HOME; fs.mkdirSync(root,{recursive:true}); fs.writeFileSync(path.join(root,'RTK.md'),'rtk\\n'); fs.writeFileSync(path.join(root,'AGENTS.md'),'@RTK.md\\n'); }",
    "else if (args.join(' ') === 'init -g --codex --show') { if (process.env.RTK_FAKE_SHOW_FAIL === '1') { process.stderr.write('show failed\\n'); process.exitCode = 3; } else process.stdout.write('[ok] Global RTK.md: configured\\n[ok] Global AGENTS.md: configured\\n'); }",
    "else process.exitCode = 2;",
  ].join("\n"));
  if (process.platform === "win32") {
    fs.writeFileSync(fakeRtk, [
      "@echo off",
      "set RTK_FAKE_ENTRY=%~f0",
      '"%RTK_FAKE_NODE_EXECUTABLE%" "%RTK_FAKE_RUNNER_PATH%" %*',
      "exit /b %errorlevel%",
    ].join("\r\n"));
  } else {
    fs.chmodSync(fakeRtk, 0o755);
  }
  const python = process.env.PYTHON || "python3";
  const installer = path.join(repoRoot, "scripts", "install-personal-marketplace.py");
  const installerEnv = {
    ...process.env,
    HOME: home,
    CODEX_HOME: codexHome,
    RTK_FAKE_NODE_EXECUTABLE: process.execPath,
    RTK_FAKE_RUNNER_PATH: fakeRtkRunner,
  };
  const planned = spawnSync(python, [
    installer, "plan", "--json", "--home", home,
    "--with-rtk", "--rtk-executable", fakeRtk,
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installerEnv,
    timeout: 30_000,
  });
  assert.equal(planned.status, 0, `${planned.stdout}\n${planned.stderr}`);
  const plannedEnvelope = JSON.parse(planned.stdout);
  assert.equal(plannedEnvelope.command, "plan");
  assert.equal(plannedEnvelope.data.state, "ready_to_apply");
  assert.ok(plannedEnvelope.data.changes.includes("separate_global_rtk_configuration"));
  assert.equal(plannedEnvelope.technical_details.rollback.rtk_scope, "separate_global_side_effect_not_covered");
  assert.match(plannedEnvelope.human.impact, /global personal instructions Codex uses/u);
  assert.match(plannedEnvelope.human.protection_boundary, /separate.*not undone/su);
  assert.equal(fs.existsSync(path.join(home, "plugins", "agentic-sdlc-codex-plugin")), false);
  assert.equal(fs.existsSync(path.join(codexHome, "RTK.md")), false);

  const italianPlan = spawnSync(python, [
    installer, "plan", "--json", "--locale", "it", "--home", home,
    "--with-rtk", "--rtk-executable", fakeRtk,
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installerEnv,
    timeout: 30_000,
  });
  assert.equal(italianPlan.status, 0, `${italianPlan.stdout}\n${italianPlan.stderr}`);
  const italianEnvelope = JSON.parse(italianPlan.stdout);
  assert.match(italianEnvelope.human.impact, /istruzioni personali globali usate da Codex/u);
  assert.match(italianEnvelope.human.protection_boundary, /separata.*non viene annullata/su);

  const installed = spawnSync(python, [
    installer, "apply", "--json", "--plan-hash", plannedEnvelope.data.plan_hash,
    "--home", home, "--with-rtk", "--rtk-executable", fakeRtk,
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    env: installerEnv,
    timeout: 30_000,
  });
  assert.equal(installed.status, 0, `${installed.stdout}\n${installed.stderr}`);
  const installedEnvelope = JSON.parse(installed.stdout);
  assert.equal(installedEnvelope.data.plugin_transaction, "committed");
  assert.equal(installedEnvelope.data.global_rtk_configuration, "configured");
  assert.match(installedEnvelope.human.impact, /changed the global personal instructions Codex uses/u);
  assert.match(installedEnvelope.human.protection_boundary, /separate.*not undone/su);
  assert.equal(fs.readFileSync(path.join(codexHome, "AGENTS.md"), "utf8"), "@RTK.md\n");
  assert.equal(fs.readFileSync(path.join(codexHome, "RTK.md"), "utf8"), "rtk\n");
  const successfulInvocations = readJsonLines(invocationPath);
  assert.ok(
    successfulInvocations.filter(({ args }) => args.length === 1 && args[0] === "--version").length >= 2,
    "plan and apply must each revalidate the RTK executable",
  );
  assert.deepEqual(successfulInvocations.slice(-3).map(({ args }) => args), [
    ["gain", "--project", "--format", "json"],
    ["init", "-g", "--codex"],
    ["init", "-g", "--codex", "--show"],
  ]);
  const configurationInvocations = successfulInvocations.slice(-4);
  assert.equal(new Set(configurationInvocations.map(({ entry }) => path.resolve(entry))).size, 1);
  assert.notEqual(
    path.resolve(configurationInvocations[0].entry),
    fs.realpathSync(fakeRtk),
    "global configuration must execute only the private byte-bound RTK copy",
  );
  assert.equal(
    readJson(path.join(home, "plugins", "agentic-sdlc-codex-plugin", ".codex-plugin", "plugin.json")).version,
    readJson(path.join(repoRoot, "package.json")).version,
  );

  const partialFailureHome = tmpProject("personal-installer-rtk-partial-home");
  const partialCodexHome = path.join(partialFailureHome, ".codex-test");
  const partialFailureEnv = {
    ...process.env,
    HOME: partialFailureHome,
    CODEX_HOME: partialCodexHome,
    RTK_FAKE_SHOW_FAIL: "1",
    RTK_FAKE_NODE_EXECUTABLE: process.execPath,
    RTK_FAKE_RUNNER_PATH: fakeRtkRunner,
  };
  const partialPlan = spawnSync(python, [
    installer, "plan", "--json", "--home", partialFailureHome,
    "--with-rtk", "--rtk-executable", fakeRtk,
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    env: partialFailureEnv,
    timeout: 30_000,
  });
  assert.equal(partialPlan.status, 0, `${partialPlan.stdout}\n${partialPlan.stderr}`);
  const partialPlanEnvelope = JSON.parse(partialPlan.stdout);
  const partialFailure = spawnSync(python, [
    installer, "apply", "--json", "--plan-hash", partialPlanEnvelope.data.plan_hash,
    "--home", partialFailureHome, "--with-rtk", "--rtk-executable", fakeRtk,
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    env: partialFailureEnv,
    timeout: 30_000,
  });
  assert.notEqual(partialFailure.status, 0);
  const partialFailureEnvelope = JSON.parse(partialFailure.stdout);
  assert.equal(partialFailureEnvelope.ok, false);
  assert.equal(partialFailureEnvelope.data.plugin_transaction, "committed");
  assert.equal(partialFailureEnvelope.data.global_rtk_configuration, "failed_or_incomplete");
  assert.match(partialFailureEnvelope.technical_details.error, /RTK global Codex verification failed/u);
  assert.equal(fs.existsSync(path.join(partialCodexHome, "RTK.md")), true);
  assert.equal(fs.existsSync(path.join(partialCodexHome, "AGENTS.md")), true);
  assert.equal(fs.existsSync(path.join(partialFailureHome, "plugins", "agentic-sdlc-codex-plugin")), true);
  const partialMarketplace = readJson(path.join(partialFailureHome, ".agents", "plugins", "marketplace.json"));
  assert.equal(
    partialMarketplace.plugins.some((plugin) => plugin.name === "agentic-sdlc-codex-plugin"),
    true,
  );
});

test("manifests, trace compaction, and archive plans scale the KB without using cache as truth", () => {
  const project = tmpProject("kb-scale");
  initProject(project);
  createStrictReadyStory(project, "ST-001");
  mustRun([
    "trace",
    "append",
    "--root",
    project,
    "--story",
    "ST-001",
    "--type",
    "implementation",
    "--summary",
    "Implemented a small change",
  ]);

  const manifestResult = JSON.parse(mustRun(["manifest", "rebuild", "--root", project, "--json"]).stdout);
  assert.equal(manifestResult.status, "rebuilt");
  const manifest = readJson(path.join(project, ".sdlc", "manifests", "kb-manifest.json"));
  assert.equal(manifest.summary.stories, 1);
  assert.equal(manifest.source_paths.some((sourcePath) => sourcePath.startsWith(".sdlc/cache/")), false);

  mustRun(["cache", "rebuild", "--root", project]);
  const cache = readJson(path.join(project, ".sdlc", "cache", "kb-cache.json"));
  assert.equal(cache.source_paths.includes(".sdlc/manifests/kb-manifest.json"), true);

  const compacted = JSON.parse(mustRun([
    "trace",
    "compact",
    "--root",
    project,
    "--story",
    "ST-001",
    "--json",
  ]).stdout);
  assert.equal(compacted.status, "compacted");
  assert.equal(fs.existsSync(compacted.compaction_path), true);
  assert.equal(fs.existsSync(path.join(project, ".sdlc", "traces", "ST-001.jsonl")), true);

  const archivePlan = JSON.parse(mustRun([
    "archive",
    "closed",
    "--root",
    project,
    "--before",
    "now",
    "--json",
  ]).stdout);
  assert.equal(archivePlan.status, "planned");
  assert.ok(archivePlan.plan.candidates.some((candidate) => candidate.reason === "trace-compaction"));
  assert.equal(fs.existsSync(archivePlan.plan_path), true);
});

test("schemas and JSON templates parse with portable local references", () => {
  for (const directory of ["schemas", "templates"]) {
    for (const entry of fs.readdirSync(path.join(repoRoot, directory))) {
      if (entry.endsWith(".json")) {
        const payload = JSON.parse(fs.readFileSync(path.join(repoRoot, directory, entry), "utf8"));
        if (directory === "schemas") {
          assert.equal(payload.$id, entry, `${entry} must resolve relative references from the local schema bundle`);
          for (const reference of collectJsonSchemaReferences(payload)) {
            if (reference.startsWith("#")) {
              continue;
            }
            const referencedFile = reference.split("#", 1)[0];
            assert.equal(path.isAbsolute(referencedFile), false, `${entry} contains absolute reference ${reference}`);
            assert.equal(fs.existsSync(path.join(repoRoot, directory, referencedFile)), true, `${entry} references missing ${reference}`);
          }
        }
      }
    }
  }

  const traceSchema = readJson(path.join(repoRoot, "schemas", "trace.schema.json"));
  assert.ok(traceSchema.properties.story_id.type.includes("null"));
  assert.ok(traceSchema.properties.request.type.includes("null"));
  assert.ok(traceSchema.$defs.actor.oneOf.some((branch) => branch.type === "null"));
  const contractSchema = readJson(path.join(repoRoot, "schemas", "contract.schema.json"));
  assert.ok(contractSchema.properties.approvals.items.properties.scope.oneOf.some((branch) => branch.type === "object"));
  const outputTemplateSchema = readJson(path.join(repoRoot, "schemas", "output-template.schema.json"));
  assert.equal(outputTemplateSchema.properties.delivery.$ref, "#/$defs/delivery");
  assert.ok(outputTemplateSchema.$defs.delivery.required.includes("mode"));
  assert.equal(outputTemplateSchema.properties.approved_delivery_hash.pattern, "^[a-f0-9]{64}$");
  const outputLinkSchema = readJson(path.join(repoRoot, "schemas", "output-link.schema.json"));
  assert.equal(outputLinkSchema.properties.delivery_format.description.includes("snapshot"), true);
  assert.equal(outputLinkSchema.properties.verification_receipt.$ref, "verification-receipt.schema.json");
  const verificationReceiptSchema = readJson(path.join(repoRoot, "schemas", "verification-receipt.schema.json"));
  assert.ok(verificationReceiptSchema.required.includes("container_verified"));
  assert.ok(verificationReceiptSchema.required.includes("content_verified"));
  assert.ok(verificationReceiptSchema.required.includes("render_verified"));
  const authorizationSchema = readJson(path.join(repoRoot, "schemas", "authorization.schema.json"));
  assert.ok(authorizationSchema.required.includes("allowed_actions"));
  assert.equal(authorizationSchema.properties.allowed_approval_boundaries.type, "array");
  assert.deepEqual(
    authorizationSchema.properties.hash_algorithm.enum,
    ["sha256:stable-json:v1", "sha256:stable-json:v2"],
  );
  const contextOptimizationSchema = readJson(path.join(repoRoot, "schemas", "context-optimization-observation.schema.json"));
  assert.equal(contextOptimizationSchema.$id, "context-optimization-observation.schema.json");
  assert.equal(contextOptimizationSchema.properties.budget_effect.properties.usage_adjustment_applied.const, 0);
  const releaseManifestSchema = readJson(path.join(repoRoot, "schemas", "release-manifest.schema.json"));
  assert.equal(releaseManifestSchema.properties.context_optimization_observations.type, "array");
  const configTemplate = readJson(path.join(repoRoot, "templates", "sdlc-config.json"));
  assert.equal(configTemplate.context_optimization_policy.mode, "automatic");
  assert.equal(configTemplate.context_optimization_policy.fallback, "native");
  const releaseWorkflow = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "release.yml"), "utf8");
  assert.match(releaseWorkflow, /os: \[ubuntu-latest, macos-latest, windows-latest\]/);
  assert.match(releaseWorkflow, /node: \["18\.20\.3", "20\.12\.0", "21\.6\.0", 24\]/);
  assert.match(releaseWorkflow, /package:\r?\n\s+needs: verify/);
});

function collectJsonSchemaReferences(value, references = []) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectJsonSchemaReferences(item, references);
    }
    return references;
  }
  if (!value || typeof value !== "object") {
    return references;
  }
  if (typeof value.$ref === "string") {
    references.push(value.$ref);
  }
  for (const item of Object.values(value)) {
    collectJsonSchemaReferences(item, references);
  }
  return references;
}

test("npm package installs as a complete reusable plugin", async (t) => {
  const invokeNpm = (args, cwd = repoRoot) => {
    const npmCommand = process.env.npm_execpath
      ? process.execPath
      : process.platform === "win32" ? "npm.cmd" : "npm";
    const commandArguments = process.env.npm_execpath
      ? [process.env.npm_execpath, ...args]
      : args;
    return spawnSync(npmCommand, commandArguments, {
      cwd,
      encoding: "utf8",
      shell: process.platform === "win32" && !process.env.npm_execpath,
      timeout: 60_000,
    });
  };
  const packageRoot = tmpProject("npm-package-install");
  const packed = invokeNpm(["pack", "--json", "--ignore-scripts", "--pack-destination", packageRoot]);
  assert.equal(packed.status, 0, `npm pack failed\nSTDOUT:\n${packed.stdout}\nSTDERR:\n${packed.stderr}`);
  const payload = JSON.parse(packed.stdout);
  const files = payload[0].files.map((entry) => entry.path);
  assert.ok(files.includes(".codex-plugin/plugin.json"));
  assert.ok(files.includes("bin/agentic-sdlc.mjs"));
  assert.ok(files.includes("lib/rtk-optimization-adapter.mjs"));
  assert.ok(files.includes("lib/codex-session-metering-adapter.mjs"));
  assert.ok(files.includes("lib/context-optimization.mjs"));
  assert.ok(files.includes("schemas/context-optimization-observation.schema.json"));
  assert.ok(files.includes("schemas/project-bootstrap-manifest.schema.json"));
  assert.ok(files.includes("skills/agentic-sdlc/SKILL.md"));
  assert.ok(files.includes("skills/caveman/SKILL.md"));
  assert.ok(files.includes("skills/caveman/agents/openai.yaml"));
  assert.ok(files.includes("skills/caveman/LICENSE"));
  assert.ok(files.includes("skills/caveman/NOTICE.md"));
  assert.ok(files.includes("scripts/autoconfigure-token-efficiency.py"));
  assert.ok(files.includes("lib/change-observatory/cli.mjs"));
  assert.ok(files.includes("lib/change-observatory/runtime.mjs"));
  assert.ok(files.includes("lib/change-observatory/intentabi-adapter.mjs"));
  assert.ok(files.includes("ui/change-observatory/index.html"));
  assert.ok(files.includes("ui/change-observatory/app.js"));
  assert.ok(files.includes("skills/change-observatory/SKILL.md"));
  assert.ok(files.includes("skills/change-observatory/agents/openai.yaml"));
  assert.equal(files.some((file) => file === ".sdlc" || file.startsWith(".sdlc/")), false);
  assert.equal(files.some((file) => file === "test" || file.startsWith("test/")), false);
  assert.equal(files.some((file) => file.endsWith(".DS_Store")), false);

  const archivePath = path.join(packageRoot, payload[0].filename);
  const installRoot = path.join(packageRoot, "installed");
  const installed = invokeNpm([
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--prefix",
    installRoot,
    archivePath,
  ], packageRoot);
  assert.equal(installed.status, 0, `npm install failed\nSTDOUT:\n${installed.stdout}\nSTDERR:\n${installed.stderr}`);
  const installedPluginRoot = path.join(installRoot, "node_modules", "agentic-sdlc-codex-plugin");
  const installedCli = path.join(installedPluginRoot, "bin", "agentic-sdlc.mjs");
  const installedBinShim = path.join(
    installRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "agentic-sdlc.cmd" : "agentic-sdlc",
  );
  assert.equal(fs.existsSync(path.join(installedPluginRoot, "templates", "sdlc-config.json")), true);
  assert.equal(fs.existsSync(path.join(installedPluginRoot, "lib", "rtk-optimization-adapter.mjs")), true);
  assert.equal(fs.existsSync(path.join(installedPluginRoot, "lib", "codex-session-metering-adapter.mjs")), true);
  assert.equal(fs.existsSync(path.join(installedPluginRoot, "lib", "context-optimization.mjs")), true);
  assert.equal(fs.existsSync(path.join(installedPluginRoot, "schemas", "context-optimization-observation.schema.json")), true);
  assert.equal(fs.existsSync(path.join(installedPluginRoot, "schemas", "project-bootstrap-manifest.schema.json")), true);
  assert.equal(fs.existsSync(path.join(installedPluginRoot, "skills", "agentic-sdlc-assessment", "SKILL.md")), true);
  assert.equal(fs.existsSync(path.join(installedPluginRoot, "skills", "caveman", "SKILL.md")), true);
  assert.equal(fs.existsSync(path.join(installedPluginRoot, "skills", "caveman", "agents", "openai.yaml")), true);
  assert.equal(fs.existsSync(path.join(installedPluginRoot, "scripts", "autoconfigure-token-efficiency.py")), true);
  assert.equal(fs.existsSync(path.join(installedPluginRoot, "lib", "change-observatory", "cli.mjs")), true);
  assert.equal(fs.existsSync(path.join(installedPluginRoot, "lib", "change-observatory", "intentabi-adapter.mjs")), true);
  assert.equal(fs.existsSync(path.join(installedPluginRoot, "ui", "change-observatory", "index.html")), true);
  assert.equal(fs.existsSync(path.join(installedPluginRoot, "skills", "change-observatory", "SKILL.md")), true);
  assert.equal(fs.existsSync(path.join(installedPluginRoot, "skills", "change-observatory", "agents", "openai.yaml")), true);
  assert.equal(fs.existsSync(installedBinShim), true);
  const installedDoctor = spawnSync(
    process.execPath,
    [installedCli, "doctor", "--root", packageRoot, "--json"],
    { cwd: packageRoot, encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(installedDoctor.status, 0, `installed doctor failed\n${installedDoctor.stdout}\n${installedDoctor.stderr}`);
  const installedDoctorPayload = JSON.parse(installedDoctor.stdout);
  assert.equal(installedDoctorPayload.status, "passed");
  assert.equal(
    installedDoctorPayload.checks.find((check) => check.id === "project-bootstrap-manifest-schema").status,
    "passed",
  );
  const installedBuildIdentityCheck = installedDoctorPayload.checks.find(
    (check) => check.id === "build-identity",
  );
  assert.equal(installedBuildIdentityCheck.status, "passed");
  assert.match(
    installedBuildIdentityCheck.details,
    /fingerprint [a-f0-9]{64}, provenance not embedded \(allowed for source checkouts and generic npm installs\)/u,
  );

  const observedProject = path.join(packageRoot, "observed-project");
  fs.mkdirSync(observedProject);
  const initialized = spawnSync(
    process.execPath,
    [installedCli, "init", "--root", observedProject, "--project-name", "Installed Observatory", "--force"],
    { cwd: observedProject, encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(initialized.status, 0, `installed init failed\n${initialized.stdout}\n${initialized.stderr}`);
  const malformedStoryRoot = path.join(observedProject, ".sdlc", "stories", "ST-MALFORMED");
  fs.mkdirSync(malformedStoryRoot, { recursive: true });
  fs.writeFileSync(path.join(malformedStoryRoot, "story.json"), "{ malformed on purpose\n");
  const intentAbiEventId = "123e4567-e89b-42d3-a456-426614174010";
  const intentAbiRelativePath = `.sdlc/observations/intentabi/${intentAbiEventId}.json`;
  const intentAbiDigest = (character) => `hmac-sha256:evidence:${character.repeat(64)}`;
  fs.mkdirSync(path.join(observedProject, ".sdlc", "stories", "ST-INTENTABI"), { recursive: true });
  fs.mkdirSync(path.join(observedProject, ".sdlc", "observations", "intentabi"), { recursive: true });
  writeJson(path.join(observedProject, ".sdlc", "stories", "ST-INTENTABI", "story.json"), {
    schema_version: "0.1.0",
    id: "ST-INTENTABI",
    title: "Observe IntentABI evidence",
    status: "draft",
  });
  writeJson(path.join(observedProject, intentAbiRelativePath), {
    schema: "io.github.aantenore.intentabi/authenticated-codex-shadow-evidence/v1alpha1",
    eventId: intentAbiEventId,
    keyId: "installed-observatory-test",
    evidence: {
      schema: "io.github.aantenore.intentabi/codex-shadow-evidence/v1alpha1",
      mode: "shadow",
      submitted: "original",
      inputKind: "text",
      bindingDigest: intentAbiDigest("a"),
      originalDigest: intentAbiDigest("b"),
      optionsDigest: "unavailable:not-provided",
      execution: { status: "succeeded", outputDigest: "unavailable:opaque-output" },
      preparation: {
        outcome: "candidate-observed",
        reason: "CANDIDATE_ATTESTED",
        candidateDigest: intentAbiDigest("c"),
        selectedCodecDigest: intentAbiDigest("d"),
        reasonSetDigest: intentAbiDigest("e"),
        promotionBindingDigest: intentAbiDigest("f"),
        proof: "present-unverified",
      },
    },
    mac: intentAbiDigest("9"),
  });
  const intentAbiTracePath = path.join(observedProject, ".sdlc", "traces", "ST-INTENTABI.jsonl");
  fs.mkdirSync(path.dirname(intentAbiTracePath), { recursive: true });
  fs.writeFileSync(intentAbiTracePath, `${JSON.stringify({
    id: "TR-INTENTABI-INSTALLED",
    story_id: "ST-INTENTABI",
    type: "handoff",
    summary: "Linked IntentABI evidence.",
    evidence: [intentAbiRelativePath],
  })}\n`);

  const observeExecutable = process.platform === "win32" ? process.execPath : installedBinShim;
  const observatory = spawn(observeExecutable, [
    ...(process.platform === "win32" ? [installedCli] : []),
    "observe",
    "--root",
    observedProject,
    "--host",
    "127.0.0.1",
    "--port",
    "0",
    "--no-open",
    "--json",
  ], {
    cwd: observedProject,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let observatoryStdout = "";
  let observatoryStderr = "";
  observatory.stdout.setEncoding("utf8");
  observatory.stderr.setEncoding("utf8");
  observatory.stdout.on("data", (chunk) => { observatoryStdout += chunk; });
  observatory.stderr.on("data", (chunk) => { observatoryStderr += chunk; });
  const closed = new Promise((resolve, reject) => {
    observatory.once("error", reject);
    observatory.once("close", (status, signal) => resolve({ status, signal }));
  });
  t.after(async () => {
    if (observatory.exitCode === null && observatory.signalCode === null) {
      observatory.kill("SIGKILL");
    }
    await closed.catch(() => {});
  });

  const ready = await new Promise((resolve, reject) => {
    let buffered = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`installed observatory did not become ready\n${observatoryStdout}\n${observatoryStderr}`));
    }, 15_000);
    const onData = (chunk) => {
      buffered += chunk;
      let newline;
      while ((newline = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (!line) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.event === "observatory.ready") {
          cleanup();
          resolve(event);
          return;
        }
      }
    };
    const onClose = (status, signal) => {
      cleanup();
      reject(new Error(`installed observatory exited before ready (${status ?? signal})\n${observatoryStdout}\n${observatoryStderr}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      observatory.stdout.off("data", onData);
      observatory.off("close", onClose);
    };
    observatory.stdout.on("data", onData);
    observatory.once("close", onClose);
  });

  assert.equal(ready.status, "ready");
  assert.equal(ready.host, "127.0.0.1");
  assert.equal(ready.browser_open_requested, false);
  assert.equal(ready.authentication, "per-run-bearer-fragment");
  const accessUrl = new URL(ready.url);
  const accessToken = new URLSearchParams(accessUrl.hash.slice(1)).get("access_token");
  assert.ok(accessToken);
  assert.equal(accessUrl.origin, new URL(ready.base_url).origin);
  const authenticatedFetch = (url) => fetch(url, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });

  const healthResponse = await authenticatedFetch(ready.health_url);
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.equal(health.status, "ok");
  assert.equal(health.modelSchemaVersion, "change-observatory:view:v1");

  const modelResponse = await authenticatedFetch(ready.model_url);
  assert.equal(modelResponse.status, 200);
  const model = await modelResponse.json();
  assert.equal(model.schemaVersion, "change-observatory:view:v1");
  assert.equal(model.project.name, "Installed Observatory");
  assert.ok(model.diagnostics.some((diagnostic) => diagnostic.code === "invalid_json"));
  assert.equal(model.semanticObservations.length, 1);
  assert.equal(model.semanticObservations[0].id, intentAbiEventId);
  assert.equal(model.semanticObservations[0].link.storyId, "ST-INTENTABI");
  assert.equal(model.semanticObservations[0].macStatus, "present-not-verified");
  assert.equal(model.summary.asked.some((item) => item.id === intentAbiEventId), false);
  assert.equal(model.summary.changed.some((item) => item.id === intentAbiEventId), false);
  assert.equal(model.summary.decided.some((item) => item.id === intentAbiEventId), false);
  assert.equal(model.verification.some((item) => item.id === intentAbiEventId), false);

  const intentAbiSourceUrl = new URL("/api/v1/source", ready.base_url);
  intentAbiSourceUrl.searchParams.set("path", intentAbiRelativePath);
  const intentAbiSourceResponse = await authenticatedFetch(intentAbiSourceUrl);
  assert.equal(intentAbiSourceResponse.status, 200);
  const intentAbiSource = await intentAbiSourceResponse.json();
  assert.equal(intentAbiSource.contentProjection, "intentabi-observatory:v1");
  assert.equal(intentAbiSource.data.eventId, intentAbiEventId);
  assert.equal(JSON.stringify(intentAbiSource).includes("hmac-sha256"), false);
  assert.equal(Object.hasOwn(intentAbiSource, "sha256"), false);
  assert.equal(Object.hasOwn(intentAbiSource, "sizeBytes"), false);

  const rootResponse = await authenticatedFetch(new URL("/", ready.base_url));
  assert.equal(rootResponse.status, 200);
  assert.match(rootResponse.headers.get("content-type") || "", /^text\/html\b/);
  assert.match(await rootResponse.text(), /<title>Change Observatory<\/title>/);

  const assetResponse = await authenticatedFetch(new URL("/app.js", ready.base_url));
  assert.equal(assetResponse.status, 200);
  assert.match(assetResponse.headers.get("content-type") || "", /javascript/);
  assert.match(await assetResponse.text(), /new ObservatoryApi/);

  assert.equal(observatory.kill("SIGTERM"), true);
  const stopped = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("installed observatory did not stop")), 10_000);
    closed.then(
      (result) => {
        clearTimeout(timeout);
        resolve(result);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
  if (process.platform === "win32") {
    assert.ok(stopped.status === 0 || stopped.signal === "SIGTERM");
  } else {
    assert.equal(stopped.status, 0, observatoryStderr);
    assert.equal(stopped.signal, null);
    assert.match(observatoryStdout, /"event":"observatory\.stopped"/);
  }
});
