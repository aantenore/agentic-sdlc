import test, { after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  REDACTION_PLACEHOLDER,
} from "../../lib/observability/redaction.mjs";
import { sealTraceEvent, verifyTraceIntegrity } from "../../lib/trace-integrity.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cliPath = path.join(repoRoot, "bin", "agentic-sdlc.mjs");
const tempProjects = new Set();
const CORRELATION_ID_PATTERN = /^corr-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;

after(() => {
  if (process.env.AGENTIC_SDLC_KEEP_TEST_TMP === "1") return;
  for (const project of tempProjects) {
    fs.rmSync(project, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
  tempProjects.clear();
});

function runCli(args, options = {}) {
  const env = { ...process.env };
  for (const key of [
    "CI",
    "GITHUB_ACTIONS",
    "GITHUB_ACTOR",
    "CODEX_AGENT_NAME",
    "CODEX_USER_ID",
    "NODE_OPTIONS",
  ]) {
    delete env[key];
  }
  Object.assign(env, options.env || {});
  return spawnSync(process.execPath, [...(options.nodeArgs || []), cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
    timeout: options.timeout || 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function runCliAsync(args, options = {}) {
  const env = { ...process.env };
  for (const key of [
    "CI",
    "GITHUB_ACTIONS",
    "GITHUB_ACTOR",
    "CODEX_AGENT_NAME",
    "CODEX_USER_ID",
    "NODE_OPTIONS",
  ]) {
    delete env[key];
  }
  Object.assign(env, options.env || {});
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

function mustRun(args, options = {}) {
  const result = runCli(args, options);
  assert.equal(result.error, undefined, `${args.join(" ")} failed to execute: ${result.error?.message}`);
  assert.equal(result.signal, null, `${args.join(" ")} terminated by ${result.signal}`);
  assert.equal(result.status, 0, `${args.join(" ")}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result;
}

function mustFail(args, options = {}) {
  const result = runCli(args, options);
  assert.equal(result.error, undefined, `${args.join(" ")} failed to execute: ${result.error?.message}`);
  assert.equal(result.signal, null, `${args.join(" ")} terminated by ${result.signal}`);
  assert.notEqual(result.status, 0, `${args.join(" ")} unexpectedly passed\n${result.stdout}`);
  return result;
}

function initializedProject(name) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), `agentic-sdlc-observability-${name}-`));
  tempProjects.add(project);
  mustRun(["init", "--root", project, "--project-name", "Observability fixture", "--force", "--json"]);
  return project;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readOnlyJsonLine(filePath) {
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/u).filter(Boolean);
  assert.equal(lines.length, 1, `expected one JSONL event in ${filePath}`);
  return JSON.parse(lines[0]);
}

function resealOnlyProjectTrace(project, event) {
  const tracesRoot = path.join(project, ".sdlc", "traces");
  const tracePath = path.join(tracesRoot, "project.jsonl");
  const checkpointPath = path.join(tracesRoot, ".integrity", "project.jsonl.checkpoint.json");
  const unsealed = JSON.parse(JSON.stringify(event));
  delete unsealed._trace_integrity;
  fs.rmSync(tracePath, { force: true });
  fs.rmSync(path.dirname(checkpointPath), { recursive: true, force: true });
  sealTraceEvent({
    boundaryRoot: tracesRoot,
    tracePath,
    checkpointPath,
    event: unsealed,
  });
}

test("unexpected CLI failures return safe correlated JSON and human errors", () => {
  const project = initializedProject("safe-errors");
  const configPath = path.join(project, ".sdlc", "config.json");
  const hookPath = path.join(project, "inject-unexpected-error.mjs");
  const privateCanaryPath = "/private/internal/canary/should-never-leak";
  fs.writeFileSync(hookPath, [
    'import fs from "node:fs";',
    "const originalExistsSync = fs.existsSync;",
    "fs.existsSync = function injectedExistsSync(filePath) {",
    "  if (String(filePath) === process.env.OBS_THROW_PATH) {",
    "    throw new Error(`INTERNAL_CANARY ${process.env.OBS_CANARY_PATH}`);",
    "  }",
    "  return originalExistsSync.call(this, filePath);",
    "};",
    "",
  ].join("\n"));
  const injectedOptions = {
    nodeArgs: ["--import", pathToFileURL(hookPath).href],
    env: {
      OBS_THROW_PATH: configPath,
      OBS_CANARY_PATH: privateCanaryPath,
    },
  };

  const jsonFailure = mustFail(["status", "--root", project, "--json"], injectedOptions);
  assert.equal(jsonFailure.stdout, "");
  const payload = JSON.parse(jsonFailure.stderr);
  assert.equal(payload.schema_version, "agentic-sdlc-cli-error:v1");
  assert.equal(payload.status, "error");
  assert.match(payload.correlation_id, CORRELATION_ID_PATTERN);
  assert.deepEqual(payload.error, {
    code: "OBSERVABILITY_CONFIGURATION_INVALID",
    message: "Project privacy configuration is invalid or unsafe; command details were withheld.",
    retryable: false,
  });
  assert.doesNotMatch(jsonFailure.stderr, /INTERNAL_CANARY/u);
  assert.doesNotMatch(jsonFailure.stderr, new RegExp(escapeRegExp(privateCanaryPath), "u"));
  assert.doesNotMatch(jsonFailure.stderr, new RegExp(escapeRegExp(project), "u"));
  assert.doesNotMatch(jsonFailure.stderr, new RegExp(escapeRegExp(repoRoot), "u"));
  assert.doesNotMatch(jsonFailure.stderr, /\n\s*at\s/u);

  const humanFailure = mustFail(["status", "--root", project], injectedOptions);
  assert.equal(humanFailure.stdout, "");
  assert.match(humanFailure.stderr, /Correlation ID: corr-[a-f0-9-]{36}/u);
  assert.match(humanFailure.stderr, /Error: Project privacy configuration is invalid or unsafe; command details were withheld\./u);
  assert.doesNotMatch(humanFailure.stderr, /INTERNAL_CANARY/u);
  assert.doesNotMatch(humanFailure.stderr, new RegExp(escapeRegExp(privateCanaryPath), "u"));
  assert.doesNotMatch(humanFailure.stderr, new RegExp(escapeRegExp(project), "u"));
  assert.doesNotMatch(humanFailure.stderr, new RegExp(escapeRegExp(repoRoot), "u"));
  assert.doesNotMatch(humanFailure.stderr, /\n\s*at\s/u);
});

test("unexpected CLI failures expose only the original error code and syscall", () => {
  const project = initializedProject("internal-error-cause");
  const hookPath = path.join(project, "inject-filesystem-error.mjs");
  const privateCanaryPath = "/private/internal/canary/should-never-leak";
  fs.writeFileSync(hookPath, [
    'import fs from "node:fs";',
    'import path from "node:path";',
    'import { syncBuiltinESMExports } from "node:module";',
    "const originalExistsSync = fs.existsSync;",
    "const sdlcRoot = path.join(process.env.OBS_PROJECT, '.sdlc') + path.sep;",
    "const configPath = path.join(process.env.OBS_PROJECT, '.sdlc', 'config.json');",
    "fs.existsSync = function injectedExistsSync(filePath) {",
    "  const resolved = path.resolve(String(filePath));",
    "  if (resolved.startsWith(sdlcRoot) && resolved !== configPath) {",
    "    const error = new Error(`INTERNAL_CANARY ${process.env.OBS_CANARY_PATH}`);",
    "    error.code = 'EPERM';",
    "    error.syscall = 'rename';",
    "    error.path = process.env.OBS_CANARY_PATH;",
    "    throw error;",
    "  }",
    "  return originalExistsSync.call(this, filePath);",
    "};",
    "syncBuiltinESMExports();",
    "",
  ].join("\n"));
  const injectedOptions = {
    nodeArgs: ["--import", pathToFileURL(hookPath).href],
    env: { OBS_PROJECT: project, OBS_CANARY_PATH: privateCanaryPath },
  };

  const jsonFailure = mustFail(["status", "--root", project, "--json"], injectedOptions);
  assert.equal(jsonFailure.status, 70, jsonFailure.stderr);
  const payload = JSON.parse(jsonFailure.stderr);
  assert.deepEqual(payload.error, {
    code: "INTERNAL_ERROR",
    message: "The command could not be completed.",
    retryable: false,
    details: { cause: { code: "EPERM", syscall: "rename" } },
  });
  assert.deepEqual(payload.human_guidance.details.cause, { code: "EPERM", syscall: "rename" });
  assert.doesNotMatch(jsonFailure.stderr, /INTERNAL_CANARY/u);
  assert.doesNotMatch(jsonFailure.stderr, new RegExp(escapeRegExp(privateCanaryPath), "u"));
  assert.doesNotMatch(jsonFailure.stderr, new RegExp(escapeRegExp(project), "u"));

  const humanFailure = mustFail(["status", "--root", project], injectedOptions);
  assert.equal(humanFailure.status, 70, humanFailure.stderr);
  assert.match(humanFailure.stderr, /- Cause: code=EPERM syscall=rename/u);
  assert.doesNotMatch(humanFailure.stderr, /INTERNAL_CANARY/u);
  assert.doesNotMatch(humanFailure.stderr, new RegExp(escapeRegExp(privateCanaryPath), "u"));
});

test("unknown JSON help paths redact GitHub tokens from every error branch", () => {
  const fakeSecret = `github_pat_${"A".repeat(32)}`;
  const result = mustFail(["help", fakeSecret, "--json"]);

  assert.equal(result.stdout, "");
  assert.doesNotMatch(result.stderr, new RegExp(escapeRegExp(fakeSecret), "u"));
  assert.doesNotMatch(result.stderr, /github_pat_/u);

  const payload = JSON.parse(result.stderr);
  assert.equal(payload.schema_version, "agentic-sdlc-cli-error:v1");
  assert.equal(payload.error.code, "UNKNOWN_COMMAND");
  assert.equal(payload.error.path, REDACTION_PLACEHOLDER);
  assert.equal(payload.human_guidance.details.path, REDACTION_PLACEHOLDER);
  assert.equal(JSON.stringify(payload.error).includes(fakeSecret), false);
  assert.equal(JSON.stringify(payload.human_guidance).includes(fakeSecret), false);
  assert.equal(JSON.stringify(payload.human_guidance.details).includes(fakeSecret), false);
});

test("CLI errors honor configured project PII patterns in JSON and human output", () => {
  const project = initializedProject("configured-error-pii");
  const configPath = path.join(project, ".sdlc", "config.json");
  const config = readJson(configPath);
  config.observability = config.observability || {};
  config.observability.redaction = config.observability.redaction || {};
  config.observability.redaction.pii_patterns = [{
    name: "employee_id",
    pattern: "EMP-[0-9]{6}",
  }];
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const jsonFailure = mustFail(["help", "EMP-123456", "--root", project, "--json"]);
  assert.doesNotMatch(jsonFailure.stderr, /EMP-123456/u);
  assert.match(jsonFailure.stderr, /\[REDACTED\]/u);
  const humanFailure = mustFail(["help", "EMP-123456", "--root", project]);
  assert.doesNotMatch(humanFailure.stderr, /EMP-123456/u);
  assert.match(humanFailure.stderr, /\[REDACTED\]/u);
});

test("configured PII cannot turn fixed CLI operation metadata into an uncaught stack", () => {
  const project = initializedProject("operation-metadata-pii");
  const configPath = path.join(project, ".sdlc", "config.json");
  const config = readJson(configPath);
  config.observability.redaction.pii_patterns = [{
    name: "operation_name",
    pattern: "cli[.]run",
  }];
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const failure = mustFail(["help", "unknown-operation", "--root", project, "--json"]);
  const payload = JSON.parse(failure.stderr);
  assert.equal(payload.schema_version, "agentic-sdlc-cli-error:v1");
  assert.equal(payload.correlation_id.startsWith("corr-"), true);
  assert.doesNotMatch(failure.stderr, /OperationContextError|\n\s*at\s|file:\/\//u);
});

test("CLI errors withhold user input when privacy configuration is invalid", () => {
  const project = initializedProject("invalid-error-privacy");
  const configPath = path.join(project, ".sdlc", "config.json");
  fs.writeFileSync(configPath, `${JSON.stringify({
    observability: {
      redaction: {
        pii_pattern: [{ name: "employee_id", pattern: "EMP-[0-9]{6}" }],
      },
    },
  }, null, 2)}\n`);

  for (const args of [
    ["help", "EMP-123456", "--root", project, "--json"],
    ["help", "EMP-123456", "--root", project],
  ]) {
    const failure = mustFail(args);
    assert.doesNotMatch(failure.stderr, /EMP-123456|pii_pattern/u);
    assert.match(failure.stderr, /details were withheld/u);
  }
});

test("CLI error handling never buffers an oversized privacy configuration", () => {
  const project = initializedProject("oversized-error-privacy");
  const configPath = path.join(project, ".sdlc", "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    observability: {},
    padding: "x".repeat(2 * 1024 * 1024),
  }));

  const failure = mustFail(["help", "EMP-123456", "--root", project, "--json"]);
  const payload = JSON.parse(failure.stderr);
  assert.equal(payload.error.code, "OBSERVABILITY_CONFIGURATION_INVALID");
  assert.match(payload.error.message, /details were withheld/u);
  assert.doesNotMatch(failure.stderr, /EMP-123456|x{64}/u);
});

test("CLI errors withhold user input when project configuration is a symlink", (t) => {
  const project = initializedProject("symlink-error-privacy");
  const configPath = path.join(project, ".sdlc", "config.json");
  const targetPath = path.join(project, "linked-config.json");
  fs.writeFileSync(targetPath, `${JSON.stringify({
    observability: {
      redaction: {
        pii_patterns: [{ name: "employee_id", pattern: "EMP-[0-9]{6}" }],
      },
    },
  }, null, 2)}\n`);
  fs.unlinkSync(configPath);
  try {
    fs.symlinkSync(targetPath, configPath, "file");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
      t.skip(`file symlinks unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  const failure = mustFail(["help", "EMP-123456", "--root", project, "--json"]);
  assert.doesNotMatch(failure.stderr, /EMP-123456/u);
  assert.match(failure.stderr, /details were withheld/u);
});

test("trace append seals a redacted event without treating identifiers or opaque business values as secrets", () => {
  const project = initializedProject("trace-redaction");
  const fakeSecret = `github_pat_${"A".repeat(32)}`;
  const fakeAliasSecret = "correct-horse-battery-staple";
  const opaqueBusinessValue = "aB3dE5gH7jK9mN2pQ4sT6vW8xY0zC1fG";
  const authorizationActionId = "AUT-ACT-20260718123456789-abcdef";
  const sha256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const uuid = "550e8400-e29b-41d4-a716-446655440000";
  const suppliedCorrelationId = `corr-${uuid}`;
  const summary = [
    `credential="${fakeSecret}"`,
    `passwd="${fakeAliasSecret}"`,
    `opaque=${opaqueBusinessValue}`,
    `receipt=${authorizationActionId}`,
    `digest=${sha256}`,
    `uuid=${uuid}`,
    `correlation=${suppliedCorrelationId}`,
  ].join(" ");

  const result = mustRun([
    "trace", "append",
    "--root", project,
    "--type", "decision",
    "--summary", summary,
    "--json",
  ]);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "appended");
  assert.match(payload.correlation_id, CORRELATION_ID_PATTERN);
  assert.equal(payload.event.correlation_id, payload.correlation_id);
  assert.equal(payload.event.summary.includes(fakeSecret), false);
  assert.equal(payload.event.summary.includes(fakeAliasSecret), false);
  assert.equal(payload.event.summary.includes(opaqueBusinessValue), true);
  assert.match(payload.event.summary, /^\[REDACTED\] \[REDACTED\] opaque=/u);
  for (const identifier of [
    opaqueBusinessValue,
    authorizationActionId,
    sha256,
    uuid,
    suppliedCorrelationId,
  ]) {
    assert.match(payload.event.summary, new RegExp(escapeRegExp(identifier), "u"));
  }
  assert.equal(payload.event._trace_integrity.schema_version, "trace-integrity-event:v1");
  assert.equal(payload.event._trace_integrity.authenticity_claimed, false);
  assert.equal(payload.event._trace_integrity.sequence, 1);

  const tracePath = path.join(project, ".sdlc", "traces", "project.jsonl");
  const checkpointPath = path.join(project, ".sdlc", "traces", ".integrity", "project.jsonl.checkpoint.json");
  assert.equal(fs.existsSync(tracePath), true);
  assert.equal(fs.existsSync(checkpointPath), true);
  const rawTrace = fs.readFileSync(tracePath, "utf8");
  assert.equal(rawTrace.includes(fakeSecret), false);
  assert.equal(rawTrace.includes(fakeAliasSecret), false);
  for (const identifier of [
    opaqueBusinessValue,
    authorizationActionId,
    sha256,
    uuid,
    suppliedCorrelationId,
  ]) {
    assert.equal(rawTrace.includes(identifier), true, `${identifier} was incorrectly redacted`);
  }
  assert.deepEqual(readOnlyJsonLine(tracePath), payload.event);
  const checkpoint = readJson(checkpointPath);
  assert.equal(checkpoint.schema_version, "trace-integrity-checkpoint:v1");
  assert.equal(checkpoint.authenticity_claimed, false);
  assert.equal(checkpoint.new_writes.count, 1);
  assert.equal(checkpoint.new_writes.last_event_hash, payload.event._trace_integrity.event_hash);
});

test("manual test traces bind an immutable redacted evidence snapshot", () => {
  const project = initializedProject("trace-evidence-snapshot");
  const evidencePath = path.join(project, "test-result.json");
  fs.writeFileSync(
    evidencePath,
    `${JSON.stringify({ status: "passed", token: `github_pat_${"B".repeat(32)}` })}\n`,
  );

  const payload = JSON.parse(mustRun([
    "trace", "append",
    "--root", project,
    "--type", "test",
    "--outcome", "passed",
    "--summary", "The local test suite passed",
    "--evidence", "test-result.json",
    "--json",
  ]).stdout);

  assert.equal(payload.status, "appended");
  assert.equal(payload.event.evidence.length, 1);
  assert.match(
    payload.event.evidence[0],
    /^\.sdlc\/traces\/evidence\/TR-[A-Za-z0-9._-]+\/01-test-result\.json$/u,
  );
  assert.deepEqual(payload.event.evidence_sources, [{
    source_path: "test-result.json",
    snapshot_path: payload.event.evidence[0],
  }]);
  const snapshotPath = path.join(project, ...payload.event.evidence[0].split("/"));
  const originalSnapshot = fs.readFileSync(snapshotPath, "utf8");
  assert.match(originalSnapshot, /"status":"passed"/u);
  assert.doesNotMatch(originalSnapshot, /github_pat_/u);

  fs.writeFileSync(evidencePath, `${JSON.stringify({ status: "failed" })}\n`);
  assert.equal(fs.readFileSync(snapshotPath, "utf8"), originalSnapshot);
  assert.equal(readOnlyJsonLine(
    path.join(project, ".sdlc", "traces", "project.jsonl"),
  ).evidence[0], payload.event.evidence[0]);
});

test("manual trace append cannot impersonate protected delivery or workflow actions", () => {
  const project = initializedProject("trace-protected-action");
  mustRun([
    "trace", "append",
    "--root", project,
    "--type", "decision",
    "--summary", "Establish an immutable trace prefix",
    "--json",
  ]);
  const tracePath = path.join(project, ".sdlc", "traces", "project.jsonl");
  const checkpointPath = path.join(
    project,
    ".sdlc",
    "traces",
    ".integrity",
    "project.jsonl.checkpoint.json",
  );
  const traceBefore = fs.readFileSync(tracePath);
  const checkpointBefore = fs.readFileSync(checkpointPath);

  for (const action of [
    "release.local",
    "workflow.instance.start",
    "workflow.instance.transition",
  ]) {
    const result = mustFail([
      "trace", "append",
      "--root", project,
      "--type", action === "release.local" ? "release" : "implementation",
      "--outcome", "passed",
      "--action", action,
      "--summary", `Claim that protected action ${action} completed`,
      "--json",
    ]);
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.status, "error");
    assert.match(payload.error.message, /cannot be appended manually/u);
    assert.deepEqual(fs.readFileSync(tracePath), traceBefore);
    assert.deepEqual(fs.readFileSync(checkpointPath), checkpointBefore);
  }
});

test("explicit CI attribution does not inherit the local Git user identity", () => {
  const project = initializedProject("ci-attribution");
  const payload = JSON.parse(mustRun([
    "trace", "append",
    "--root", project,
    "--type", "decision",
    "--summary", "CI recorded a governed decision",
    "--actor-type", "ci",
    "--actor-name", "Novice Evaluation Harness",
    "--actor-email", "ci@example.invalid",
    "--json",
  ]).stdout);

  assert.deepEqual(payload.event.actor, {
    id: "Novice Evaluation Harness",
    type: "ci",
    name: "Novice Evaluation Harness",
    email: REDACTION_PLACEHOLDER,
    source: "cli",
  });
});

test("strict gate reports a sealed trace that was edited after append", () => {
  const project = initializedProject("trace-tamper");
  mustRun([
    "trace", "append",
    "--root", project,
    "--type", "decision",
    "--summary", "sealed-value",
    "--json",
  ]);
  const tracePath = path.join(project, ".sdlc", "traces", "project.jsonl");
  const event = readOnlyJsonLine(tracePath);
  event.summary = "tamper-value";
  fs.writeFileSync(tracePath, `${JSON.stringify(event)}\n`);

  const result = mustFail(["gate", "check", "--root", project, "--strict", "--json"]);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "failed");
  assert.equal(
    report.errors.some((error) => /trace traces\/project\.jsonl integrity (?:event_hash|rolling_hash)_mismatch at /u.test(error)),
    true,
    report.errors.join("\n"),
  );
});

test("gate fails if its trace or checkpoint snapshot changes before semantic validation completes", () => {
  for (const target of ["project.jsonl", "project.jsonl.checkpoint"]) {
    const project = initializedProject(`mixed-snapshot-${target.replaceAll(".", "-")}`);
    mustRun([
      "trace", "append",
      "--root", project,
      "--type", "decision",
      "--summary", "verified snapshot",
      "--json",
    ]);

    const result = mustFail([
      "gate", "check",
      "--root", project,
      "--json",
    ], {
      env: {
        NODE_ENV: "test",
        AGENTIC_SDLC_TEST_TRACE_GATE_SWAP: target,
      },
    });
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, "failed");
    assert.equal(
      report.errors.some((error) => /trace traces\/project\.jsonl local integrity verification failed \((?:file_replaced|trace_changed_during_read|trace_snapshot_changed|checkpoint_changed_during_read|checkpoint_snapshot_changed)\)/u.test(error)),
      true,
      `${target}: ${report.errors.join("\n")}`,
    );
  }
});

test("strict story gate detects trace deletion, checkpoint deletion, and deletion of both", () => {
  for (const deletion of ["trace", "checkpoint", "both"]) {
    const project = initializedProject(`trace-deletion-${deletion}`);
    const storyId = `ST-TRACE-${deletion.toUpperCase()}`;
    mustRun([
      "story", "create",
      "--root", project,
      "--id", storyId,
      "--title", "Trace deletion fixture",
      "--acceptance", "The trace remains verifiable",
      "--json",
    ]);
    fs.writeFileSync(
      path.join(project, ".sdlc", "stories", storyId, "task-start.json"),
      "{}\n",
    );
    mustRun([
      "trace", "append",
      "--root", project,
      "--story", storyId,
      "--type", "decision",
      "--summary", "sealed story trace",
      "--json",
    ]);
    const tracePath = path.join(project, ".sdlc", "traces", `${storyId}.jsonl`);
    const checkpointPath = path.join(
      project,
      ".sdlc",
      "traces",
      ".integrity",
      `${storyId}.jsonl.checkpoint.json`,
    );
    if (deletion === "trace" || deletion === "both") fs.unlinkSync(tracePath);
    if (deletion === "checkpoint" || deletion === "both") fs.unlinkSync(checkpointPath);

    const result = mustFail([
      "gate", "check",
      "--root", project,
      "--scope", "story",
      "--story", storyId,
      "--strict",
      "--json",
    ]);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, "failed");
    assert.equal(
      report.errors.some((error) => error.includes(`trace traces/${storyId}.jsonl`)
        && /(?:missing|checkpoint|truncated|integrity)/u.test(error)),
      true,
      `${deletion}: ${report.errors.join("\n")}`,
    );
  }
});

test("strict gate reports current-content snapshot drift without storing original evidence", () => {
  const project = initializedProject("evidence-drift");
  const evidenceRelativePath = "evidence/current.txt";
  const evidencePath = path.join(project, evidenceRelativePath);
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, "verified evidence before change\n");

  const appendResult = mustRun([
    "trace", "append",
    "--root", project,
    "--type", "test",
    "--summary", "Hermetic validation passed",
    "--outcome", "passed",
    "--evidence", evidenceRelativePath,
    "--json",
  ]);
  const appendPayload = JSON.parse(appendResult.stdout);
  const snapshotRelativePath = appendPayload.event.evidence[0];
  assert.match(
    snapshotRelativePath,
    /^\.sdlc\/traces\/evidence\/TR-[A-Za-z0-9._-]+\/01-current\.txt$/u,
  );
  assert.deepEqual(appendPayload.event.evidence, [snapshotRelativePath]);
  assert.deepEqual(appendPayload.event.evidence_sources, [{
    source_path: evidenceRelativePath,
    snapshot_path: snapshotRelativePath,
  }]);
  assert.equal(appendPayload.event.evidence_refs.length, 1);
  assert.equal(appendPayload.event.evidence_refs[0].path, snapshotRelativePath);
  assert.equal(appendPayload.event.evidence_refs[0].verification, "current_content");
  assert.equal(appendPayload.event.evidence_refs[0].representation, "redacted_utf8_v2");
  assert.match(appendPayload.event.evidence_refs[0].sha256, /^[a-f0-9]{64}$/u);
  const policyRef = appendPayload.event.evidence_refs[0].policy_source_ref;
  assert.equal(policyRef.schema_version, "trace-evidence-redaction-policy-ref:v1");
  assert.match(policyRef.sha256, /^[a-f0-9]{64}$/u);
  const policyPath = path.join(project, ...policyRef.path.split("/"));
  const policyBytes = fs.readFileSync(policyPath);
  assert.equal(crypto.createHash("sha256").update(policyBytes).digest("hex"), policyRef.sha256);
  assert.equal(JSON.stringify(appendPayload.event).includes("verified evidence before change"), false);

  const snapshotPath = path.join(project, ...snapshotRelativePath.split("/"));
  fs.writeFileSync(snapshotPath, "different evidence after change\n");
  const result = mustFail(["gate", "check", "--root", project, "--strict", "--json"]);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "failed");
  assert.equal(
    report.errors.some((error) => error.includes(`evidence content drift detected for ${snapshotRelativePath}`)),
    true,
    report.errors.join("\n"),
  );
});

test("strict gate rejects trace policy sources that weaken privacy or exceed fixed limits", () => {
  const cases = [
    {
      name: "generic algorithm",
      mutate(source) {
        source.algorithm = "generic_v1";
        source.credential_assignment_detector = null;
        source.semantics.credential_assignments = false;
      },
    },
    {
      name: "missing mandatory detector",
      mutate(source) {
        source.detectors = source.detectors.filter((detector) => detector.name !== "common_access_token");
      },
    },
    {
      name: "oversized limits",
      mutate(source) {
        source.limits.maxPatterns = 1_000_000;
        source.limits.maxMatches = 1_000_000;
      },
    },
  ];

  for (const fixture of cases) {
    const project = initializedProject(`unsafe-policy-${fixture.name.replaceAll(" ", "-")}`);
    const evidenceRelativePath = "evidence/result.txt";
    const evidencePath = path.join(project, evidenceRelativePath);
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(evidencePath, "safe validation result\n");
    const append = JSON.parse(mustRun([
      "trace", "append", "--root", project, "--type", "test",
      "--summary", "Policy source safety", "--outcome", "passed",
      "--evidence", evidenceRelativePath, "--json",
    ]).stdout);
    const ref = append.event.evidence_refs[0].policy_source_ref;
    const sourcePath = path.join(project, ...ref.path.split("/"));
    const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
    fixture.mutate(source);
    const bytes = `${JSON.stringify(source, null, 2)}\n`;
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    const maliciousPath = path.join(path.dirname(sourcePath), `${sha256}.json`);
    fs.writeFileSync(maliciousPath, bytes);
    ref.path = path.relative(project, maliciousPath).split(path.sep).join("/");
    ref.sha256 = sha256;
    resealOnlyProjectTrace(project, append.event);

    const report = JSON.parse(mustFail([
      "gate", "check", "--root", project, "--strict", "--json",
    ]).stdout);
    assert.equal(
      report.errors.some((error) => error.includes("evidence policy source cannot be verified")),
      true,
      `${fixture.name}: ${report.errors.join("\n")}`,
    );
  }
});

test("a policy-source fsync failure prevents the trace event from being appended", () => {
  const project = initializedProject("policy-fsync-failure");
  const evidenceRelativePath = "evidence/fsync.txt";
  const evidencePath = path.join(project, evidenceRelativePath);
  const hookPath = path.join(project, "inject-policy-fsync-failure.mjs");
  const policyRoot = path.join(project, ".sdlc", "evidence-redaction-policies");
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, "validation result before durable policy write\n");
  fs.writeFileSync(hookPath, [
    'import fs from "node:fs";',
    "const originalOpenSync = fs.openSync.bind(fs);",
    "const originalFsyncSync = fs.fsyncSync.bind(fs);",
    "const policyDescriptors = new Set();",
    "fs.openSync = function injectedOpenSync(filePath, ...args) {",
    "  const descriptor = originalOpenSync(filePath, ...args);",
    "  if (String(filePath).startsWith(process.env.OBS_POLICY_ROOT) && String(filePath).endsWith('.tmp')) policyDescriptors.add(descriptor);",
    "  return descriptor;",
    "};",
    "fs.fsyncSync = function injectedFsyncSync(descriptor) {",
    "  if (policyDescriptors.has(descriptor)) {",
    "    const error = new Error('simulated policy fsync failure');",
    "    error.code = 'EIO';",
    "    throw error;",
    "  }",
    "  return originalFsyncSync(descriptor);",
    "};",
    "",
  ].join("\n"));

  mustFail([
    "trace", "append", "--root", project, "--type", "test",
    "--summary", "Must remain unappended", "--outcome", "passed",
    "--evidence", evidenceRelativePath, "--json",
  ], {
    nodeArgs: ["--import", pathToFileURL(hookPath).href],
    env: { OBS_POLICY_ROOT: policyRoot },
  });
  assert.equal(fs.existsSync(path.join(project, ".sdlc", "traces", "project.jsonl")), false);
  assert.deepEqual(
    fs.existsSync(policyRoot) ? fs.readdirSync(policyRoot).filter((name) => name.endsWith(".json")) : [],
    [],
  );
});

test("historical v1 requires one explicit policy binding and rejects cross-policy collisions", () => {
  const project = initializedProject("evidence-representation-binding");
  const evidenceRelativePath = "evidence/versioned.txt";
  const evidencePath = path.join(project, evidenceRelativePath);
  const bearer = `Bearer ${"a".repeat(40)}`;
  const entropyOnly = "Z9_".repeat(16);
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, bearer);

  const append = JSON.parse(mustRun([
    "trace", "append",
    "--root", project,
    "--type", "test",
    "--summary", "Versioned evidence compatibility",
    "--outcome", "passed",
    "--evidence", evidenceRelativePath,
    "--json",
  ]).stdout);
  const ref = append.event.evidence_refs[0];
  assert.equal(ref.representation, "redacted_utf8_v2");
  assert.deepEqual(append.event.evidence_sources, [{
    source_path: evidenceRelativePath,
    snapshot_path: ref.path,
  }]);

  ref.representation = "redacted_utf8_v1";
  delete ref.policy_source_ref;
  resealOnlyProjectTrace(project, append.event);
  const unboundReport = JSON.parse(mustFail([
    "gate", "check", "--root", project, "--strict", "--json",
  ]).stdout);
  assert.equal(
    unboundReport.errors.some((error) => error.includes("requires one exact append-only policy binding")),
    true,
    unboundReport.errors.join("\n"),
  );

  const target = readOnlyJsonLine(path.join(project, ".sdlc", "traces", "project.jsonl"));
  const binding = JSON.parse(mustRun([
    "trace", "evidence", "bind",
    "--root", project,
    "--target-event", target.id,
    "--redaction-policy", "operational_v2",
    "--json",
  ]).stdout);
  assert.equal(binding.status, "bound");
  assert.equal(binding.binding_count, 1);
  assert.equal(binding.event.evidence_policy_bindings[0].target.event_hash, target._trace_integrity.event_hash);
  assert.equal(binding.event.evidence_policy_bindings[0].target.evidence_sha256, ref.sha256);

  const evidenceSnapshotPath = path.join(project, ...ref.path.split("/"));
  fs.writeFileSync(evidenceSnapshotPath, entropyOnly);
  const collisionReport = JSON.parse(mustFail([
    "gate", "check", "--root", project, "--strict", "--json",
  ]).stdout);
  assert.equal(
    collisionReport.errors.some((error) => error.includes("evidence content drift detected")),
    true,
    collisionReport.errors.join("\n"),
  );
  const duplicate = mustFail([
    "trace", "evidence", "bind",
    "--root", project,
    "--target-event", target.id,
    "--redaction-policy", "legacy_evidence_v1",
    "--json",
  ]);
  assert.match(duplicate.stderr, /already bound/u);
});

test("legacy v1 binding reproduces the frozen historical writer only", () => {
  const project = initializedProject("legacy-v1-binding");
  const evidenceRelativePath = "evidence/legacy.json";
  const evidencePath = path.join(project, evidenceRelativePath);
  const value = JSON.parse(`{"entropy":"${"Z9_".repeat(16)}","__proto__":{"hidden":true}}`);
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, `${JSON.stringify(value)}\n`);
  const append = JSON.parse(mustRun([
    "trace", "append", "--root", project, "--type", "test",
    "--summary", "Legacy evidence", "--outcome", "passed",
    "--evidence", evidenceRelativePath, "--json",
  ]).stdout);
  const ref = append.event.evidence_refs[0];
  const legacyValue = `${JSON.stringify({ entropy: REDACTION_PLACEHOLDER })}\n`;
  const legacyBytes = Buffer.from(legacyValue, "utf8");
  ref.representation = "redacted_utf8_v1";
  ref.size_bytes = legacyBytes.length;
  ref.sha256 = crypto.createHash("sha256").update(legacyBytes).digest("hex");
  delete ref.policy_source_ref;
  resealOnlyProjectTrace(project, append.event);
  const target = readOnlyJsonLine(path.join(project, ".sdlc", "traces", "project.jsonl"));
  mustRun([
    "trace", "evidence", "bind", "--root", project,
    "--target-event", target.id,
    "--redaction-policy", "legacy_evidence_v1",
    "--json",
  ]);
  const report = JSON.parse(mustFail([
    "gate", "check", "--root", project, "--strict", "--json",
  ]).stdout);
  assert.equal(
    report.errors.some((error) => /historical v1 evidence|evidence content drift/u.test(error)),
    false,
    report.errors.join("\n"),
  );
});

test("concurrent historical policy binding appends exactly one immutable binding", async () => {
  const project = initializedProject("concurrent-evidence-binding");
  const evidenceRelativePath = "evidence/concurrent.txt";
  const evidencePath = path.join(project, evidenceRelativePath);
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, `Bearer ${"a".repeat(40)}`);
  const append = JSON.parse(mustRun([
    "trace", "append", "--root", project, "--type", "test",
    "--summary", "Concurrent binding fixture", "--outcome", "passed",
    "--evidence", evidenceRelativePath, "--json",
  ]).stdout);
  append.event.evidence_refs[0].representation = "redacted_utf8_v1";
  delete append.event.evidence_refs[0].policy_source_ref;
  resealOnlyProjectTrace(project, append.event);
  const tracePath = path.join(project, ".sdlc", "traces", "project.jsonl");
  const target = readOnlyJsonLine(tracePath);
  const args = [
    "trace", "evidence", "bind", "--root", project,
    "--target-event", target.id,
    "--redaction-policy", "operational_v2",
    "--json",
  ];
  const results = await Promise.all([
    runCliAsync(args, {
      env: { NODE_ENV: "test", AGENTIC_SDLC_TEST_TRACE_BIND_DELAY_MS: "200" },
    }),
    runCliAsync(args, {
      env: { NODE_ENV: "test", AGENTIC_SDLC_TEST_TRACE_BIND_DELAY_MS: "200" },
    }),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [0, 1]);
  const failure = results.find((result) => result.status !== 0);
  assert.equal(failure.signal, null);
  assert.match(`${failure.stdout}\n${failure.stderr}`, /already bound/u);

  const events = fs.readFileSync(tracePath, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const bindingEvents = events.filter((event) => event.action === "trace.evidence-policy.bind");
  assert.equal(bindingEvents.length, 1);
  assert.equal(bindingEvents[0].evidence_policy_bindings.length, 1);
  assert.equal(verifyTraceIntegrity({
    boundaryRoot: path.join(project, ".sdlc"),
    tracePath,
  }).valid, true);
  const gate = runCli(["gate", "check", "--root", project, "--strict", "--json"]);
  assert.ok([0, 1].includes(gate.status), gate.stderr || gate.stdout);
  const gateReport = JSON.parse(gate.stdout);
  assert.equal(
    gateReport.errors.some((error) =>
      /trace .*integrity|evidence policy|historical evidence|binding conflict/iu.test(error)),
    false,
    gate.stdout,
  );
});

test("trace evidence that exceeds redaction limits is rejected instead of hashed as a constant placeholder", () => {
  const project = initializedProject("evidence-redaction-limit");
  const evidenceRelativePath = "evidence/too-large-for-redaction.txt";
  const evidencePath = path.join(project, evidenceRelativePath);
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, "A".repeat(300_000));

  const result = mustFail([
    "trace", "append",
    "--root", project,
    "--type", "test",
    "--summary", "must fail closed",
    "--outcome", "passed",
    "--evidence", evidenceRelativePath,
    "--json",
  ]);
  assert.doesNotMatch(result.stderr, /A{32}/u);
  assert.match(result.stderr, /redaction reached its safety limit/u);
  const tracePath = path.join(project, ".sdlc", "traces", "project.jsonl");
  assert.equal(fs.existsSync(tracePath), false);
});

test("large evidence uses a validated manifest without reading the referenced artifact", () => {
  const project = initializedProject("large-evidence-manifest");
  const manifestRelativePath = "evidence/large-report.manifest.json";
  const manifestPath = path.join(project, manifestRelativePath);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    kind: "trace_evidence_manifest",
    schema_version: "trace-evidence-manifest:v1",
    version: 1,
    id: "EVIDENCE-MANIFEST-LARGE-REPORT",
    artifact: {
      location: {
        kind: "project_path",
        path: "evidence/raw-report-that-is-not-present.json",
      },
      media_type: "application/json",
      size_bytes: 32 * 1024 * 1024,
      digest: {
        algorithm: "sha256",
        value: "a".repeat(64),
        source: "producer_supplied",
        verified_by_agentic_sdlc: false,
      },
    },
    content_handling: {
      mode: "manifest_only",
      manifest_redaction_required: true,
      raw_content_read_by_agentic_sdlc: false,
      raw_content_hashed_by_agentic_sdlc: false,
    },
    created_at: "2026-07-18T12:00:00.000Z",
  }, null, 2)}\n`);

  const append = JSON.parse(mustRun([
    "trace", "append",
    "--root", project,
    "--type", "test",
    "--summary", "Large report manifest verified",
    "--outcome", "passed",
    "--evidence", manifestRelativePath,
    "--json",
  ]).stdout);
  assert.equal(append.event.evidence_refs.length, 1);
  const snapshotRelativePath = append.event.evidence[0];
  assert.match(
    snapshotRelativePath,
    /^\.sdlc\/traces\/evidence\/TR-[A-Za-z0-9._-]+\/01-large-report\.manifest\.json$/u,
  );
  assert.deepEqual(append.event.evidence_sources, [{
    source_path: manifestRelativePath,
    snapshot_path: snapshotRelativePath,
  }]);
  assert.equal(append.event.evidence_refs[0].path, snapshotRelativePath);
  assert.equal(append.event.evidence_refs[0].verification, "current_content");
  const immutableManifest = JSON.parse(fs.readFileSync(
    path.join(project, ...snapshotRelativePath.split("/")),
    "utf8",
  ));
  assert.equal(immutableManifest.schema_version, "trace-evidence-manifest:v1");
  assert.equal(immutableManifest.content_handling.raw_content_read_by_agentic_sdlc, false);
  assert.equal(
    fs.existsSync(path.join(project, "evidence", "raw-report-that-is-not-present.json")),
    false,
  );

  const invalid = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  invalid.content_handling.raw_content_hashed_by_agentic_sdlc = true;
  fs.writeFileSync(manifestPath, `${JSON.stringify(invalid, null, 2)}\n`);
  const rejected = mustFail([
    "trace", "append",
    "--root", project,
    "--type", "test",
    "--summary", "Invalid large report manifest",
    "--outcome", "passed",
    "--evidence", manifestRelativePath,
    "--json",
  ]);
  assert.match(rejected.stderr, /Trace evidence manifest/u);
  assert.match(rejected.stderr, /raw_content_hashed_by_agentic_sdlc/u);
});

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
