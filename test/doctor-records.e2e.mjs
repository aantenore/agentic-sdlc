import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(repoRoot, "bin", "agentic-sdlc.mjs");
const tempPaths = new Set();

after(() => {
  if (process.env.AGENTIC_SDLC_KEEP_TEST_TMP === "1") return;
  for (const entry of tempPaths) fs.rmSync(entry, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function run(args, cwd, extraEnv = {}) {
  const env = { ...process.env };
  for (const key of ["CI", "GITHUB_ACTIONS", "GITHUB_ACTOR", "CODEX_AGENT_NAME", "CODEX_THREAD_ID", "CODEX_USER_ID", "CLAUDECODE", "AGENTIC_SDLC_AGENT_HOST", "AGENTIC_SDLC_HOST_LABEL"]) delete env[key];
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, [bin, ...args], { cwd, encoding: "utf8", env, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
}

function git(project, args) {
  const result = spawnSync("git", ["-C", project, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}\n${result.stderr}`);
  return result.stdout;
}

function initializedProject(label) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), `sdlc-line-endings-${label}-`));
  tempPaths.add(project);
  git(project, ["init", "-q"]);
  git(project, ["config", "core.autocrlf", "false"]);
  git(project, ["config", "user.name", "Line endings"]);
  git(project, ["config", "user.email", "line-endings@example.invalid"]);
  const init = run(["init", "--root", project, "--project-name", "Line endings"], project);
  assert.equal(init.status, 0, init.stdout + init.stderr);
  git(project, ["add", "."]);
  git(project, ["commit", "-q", "-m", "records"]);
  return project;
}

function lineEndingsCheck(project) {
  const result = run(["doctor", "--root", project, "--json"], project);
  return JSON.parse(result.stdout).checks.find((check) => check.id === "record-line-endings");
}

test("doctor reports records whose line endings git converts or checked out differently", () => {
  const project = initializedProject("converted");
  const clean = lineEndingsCheck(project);
  assert.equal(clean.status, "passed");
  assert.equal(clean.warning, undefined);
  assert.match(clean.details, /keep their exact line endings/u);

  // Evidence written with CRLF under the generated `*.md text eol=lf` rule is
  // stored with LF on commit, so its committed bytes differ from the written ones.
  const evidence = ".sdlc/tests/ST-EOL-001-evidence.md";
  fs.mkdirSync(path.join(project, ".sdlc/tests"), { recursive: true });
  fs.writeFileSync(path.join(project, evidence), "# Evidence\r\n\r\npassed\r\n", "utf8");
  git(project, ["add", evidence]);
  const converted = lineEndingsCheck(project);
  assert.equal(converted.status, "passed");
  assert.equal(converted.warning, true);
  assert.match(converted.details, /checked out with different line endings than committed/u);
  assert.match(converted.details, /CRLF line endings that git will convert on commit/u);
  assert.ok(converted.details.includes(evidence));
});

test("doctor skips the line-ending check outside a git checkout", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-line-endings-plain-"));
  tempPaths.add(project);
  const init = run(["init", "--root", project, "--project-name", "Line endings"], project);
  assert.equal(init.status, 0, init.stdout + init.stderr);
  assert.equal(lineEndingsCheck(project).status, "not_applicable");
});

test("doctor suggests a readable identity for shared claims and confirms it once set", () => {
  const project = initializedProject("claim-identity");
  const doctor = (env = {}) => JSON.parse(run(["doctor", "--root", project, "--json"], project, env).stdout)
    .checks.find((check) => check.id === "claim-identity");
  const anonymous = doctor();
  assert.equal(anonymous.warning, true);
  assert.match(anonymous.details, /claim_identity\.git_user/u);
  assert.match(anonymous.details, /AGENTIC_SDLC_HOST_LABEL/u);
  const labelled = doctor({ AGENTIC_SDLC_HOST_LABEL: "laptop-antonio" });
  assert.equal(labelled.warning, undefined);
  assert.match(labelled.details, /laptop-antonio/u);
});
