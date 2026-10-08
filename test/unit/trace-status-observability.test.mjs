import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cliPath = path.join(repoRoot, "bin", "agentic-sdlc.mjs");
const tempProjects = new Set();

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
    "CLAUDECODE",
    "AGENTIC_SDLC_AGENT_HOST",
    "NODE_OPTIONS",
  ]) {
    delete env[key];
  }
  Object.assign(env, options.env || {});
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: options.cwd || repoRoot,
    encoding: "utf8",
    env,
    timeout: options.timeout || 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function mustRun(args, options = {}) {
  const result = runCli(args, options);
  assert.equal(result.error, undefined, `${args.join(" ")} failed to execute: ${result.error?.message}`);
  assert.equal(result.status, 0, `${args.join(" ")}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result;
}

function mustFail(args, options = {}) {
  const result = runCli(args, options);
  assert.equal(result.error, undefined, `${args.join(" ")} failed to execute: ${result.error?.message}`);
  assert.notEqual(result.status, 0, `${args.join(" ")} unexpectedly passed\n${result.stdout}`);
  return result;
}

function json(result) {
  return JSON.parse(result.stdout || result.stderr);
}

function initializedProject(name) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), `agentic-sdlc-trace-status-${name}-`));
  tempProjects.add(project);
  mustRun(["init", "--root", project, "--project-name", "Trace status fixture", "--force", "--json"]);
  return project;
}

function appendDecision(project, summary, extra = []) {
  return mustRun([
    "trace", "append", "--root", project, "--type", "decision", "--summary", summary, ...extra, "--json",
  ]);
}

const projectTrace = (project) => path.join(project, ".sdlc", "traces", "project.jsonl");

test("a missing project configuration fails closed instead of dropping custom redaction", () => {
  const project = initializedProject("missing-config");
  appendDecision(project, "before the configuration disappeared");
  const configPath = path.join(project, ".sdlc", "config.json");
  fs.rmSync(configPath);
  const traceBefore = fs.readFileSync(projectTrace(project), "utf8");

  const append = mustFail([
    "trace", "append", "--root", project, "--type", "decision", "--summary", "must not be written", "--json",
  ]);
  const payload = json(append);
  assert.equal(payload.error.code, "CONFIG_MISSING");
  assert.match(payload.error.message, /\.sdlc\/config\.json is missing/u);
  assert.match(payload.error.message, /Restore \.sdlc\/config\.json from version control/u);
  assert.equal(fs.readFileSync(projectTrace(project), "utf8"), traceBefore);

  const status = mustFail(["status", "--root", project]);
  assert.match(status.stderr, /saved rules are missing/u);
  assert.match(status.stderr, /Next step: Restore \.sdlc\/config\.json/u);

  const statusIt = mustFail(["status", "--root", project, "--locale", "it"]);
  assert.match(statusIt.stderr, /Prossimo passo: Ripristina \.sdlc\/config\.json/u);

  const doctor = mustFail(["doctor", "--root", project, "--json"]);
  const effective = json(doctor).checks.find((check) => check.id === "effective-config");
  assert.equal(effective.status, "failed");
  assert.match(effective.details, /config\.json is missing/u);

  const migrate = mustFail(["config", "migrate", "--root", project, "--json"]);
  assert.equal(json(migrate).error.code, "CONFIG_MISSING");
});
