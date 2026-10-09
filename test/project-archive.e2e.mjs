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

function tmpDirectory(name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `sdlc-archive-${name}-`));
  tempPaths.add(directory);
  return directory;
}

function run(args, options = {}) {
  const env = { ...process.env };
  for (const key of ["CI", "GITHUB_ACTIONS", "GITHUB_ACTOR", "CODEX_AGENT_NAME", "CODEX_THREAD_ID", "CODEX_USER_ID", "CLAUDECODE", "AGENTIC_SDLC_AGENT_HOST"]) delete env[key];
  Object.assign(env, options.env || {});
  return spawnSync(process.execPath, [bin, ...args], { cwd: repoRoot, encoding: "utf8", env, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
}

function mustRun(args, options = {}) {
  const result = run(args, options);
  assert.equal(result.status, 0, `${args.join(" ")}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result;
}

function mustRunJson(args, options = {}) {
  return JSON.parse(mustRun([...args, "--json"], options).stdout);
}

function mustRefuse(args, pattern, options = {}) {
  const result = run(args, options);
  const combined = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 1, `${args.join(" ")} must exit 1\n${combined}`);
  assert.match(combined, pattern, combined);
  return combined;
}

function git(project, args) {
  const result = spawnSync("git", ["-C", project, ...args], { encoding: "utf8", timeout: 60_000 });
  assert.equal(result.status, 0, `git ${args.join(" ")}\n${result.stderr}`);
  return result.stdout.trim();
}

function newProject(name, { withGit = true } = {}) {
  const project = tmpDirectory(name);
  mustRun(["init", "--root", project, "--project-name", "Archive demo"]);
  if (withGit) {
    git(project, ["init", "--quiet"]);
    git(project, ["config", "user.email", "person@example.invalid"]);
    git(project, ["config", "user.name", "Person"]);
  }
  return project;
}

const APPROVAL = ["--actor-type", "human", "--approval-source", "explicit-user", "--summary", "Archive this project and start again"];

function plan(project) {
  return mustRunJson(["project", "archive", "--root", project]);
}

function applyArgs(project, planHash, extra = []) {
  return ["project", "archive", "--root", project, "--apply", "--plan-hash", planHash, "--reason", "Restart before first publication", ...APPROVAL, ...extra];
}

test("project archive plans without changing anything and moves .sdlc on apply", () => {
  const project = newProject("move");
  const before = fs.readdirSync(path.join(project, ".sdlc")).sort();
  const planned = plan(project);
  assert.equal(planned.status, "plan");
  assert.equal(planned.publication.published, false);
  assert.deepEqual(fs.readdirSync(path.join(project, ".sdlc")).sort(), before);
  assert.equal(fs.existsSync(path.join(project, ".sdlc-archive")), false);

  const result = mustRunJson(applyArgs(project, planned.plan_hash));
  assert.equal(result.status, "archived");
  assert.equal(result.reinitialized, false);
  assert.equal(fs.existsSync(path.join(project, ".sdlc")), false);
  const moved = path.join(project, result.archive_path);
  assert.deepEqual(fs.readdirSync(moved).sort(), before);
  const manifest = JSON.parse(fs.readFileSync(path.join(project, result.manifest_path), "utf8"));
  assert.equal(manifest.tree_hash, planned.tree_hash);
  assert.equal(manifest.reason, "Restart before first publication");
  assert.equal(manifest.archived_by.type, "human");
  assert.equal(manifest.approval.source, "explicit-user");
  assert.match(manifest.archived_at, /^\d{4}-\d{2}-\d{2}T/u);
  assert.equal(fs.readFileSync(path.join(project, ".sdlc-archive", ".gitignore"), "utf8").includes("*"), true);
  // The archive never shows up as untracked noise that could be committed by accident.
  assert.equal(git(project, ["status", "--porcelain", "--", ".sdlc-archive"]), "");
});

test("project archive --reinit starts a fresh project that keeps the trace of the archive", () => {
  const project = newProject("reinit");
  const planned = plan(project);
  const result = mustRunJson(applyArgs(project, planned.plan_hash, ["--reinit", "--project-name", "Fresh start"]));
  assert.equal(result.status, "archived");
  assert.equal(result.reinitialized, true);
  assert.equal(fs.existsSync(path.join(project, ".sdlc", "project.json")), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(project, ".sdlc", "project.json"), "utf8")).project_name, "Fresh start");
  const record = JSON.parse(fs.readFileSync(path.join(project, result.record_path), "utf8"));
  assert.equal(record.archive_id, result.archive_id);
  assert.equal(record.tree_hash, planned.tree_hash);
  const trace = fs.readFileSync(path.join(project, ".sdlc", "traces", "project.jsonl"), "utf8");
  assert.match(trace, /project\.archive/u);
  assert.match(trace, new RegExp(result.archive_id, "u"));
  mustRun(["trace", "verify", "--root", project]);
  assert.equal(fs.existsSync(path.join(project, result.archive_path, "project.json")), true);
});

test("project archive needs a person, the exact plan hash, a reason, and refuses inside an agent session", () => {
  const project = newProject("approval");
  const planned = plan(project);
  mustRefuse(applyArgs(project, planned.plan_hash), /person's decision|cannot run inside an agent session/u, { env: { CLAUDECODE: "1" } });
  mustRefuse(applyArgs(project, "0".repeat(64)), /plan hash mismatch/u);
  mustRefuse(["project", "archive", "--root", project, "--apply", "--plan-hash", planned.plan_hash, ...APPROVAL], /--reason/u);
  mustRefuse(["project", "archive", "--root", project, "--apply", "--plan-hash", planned.plan_hash, "--reason", "x", "--actor-type", "agent", "--approval-source", "explicit-user", "--summary", "go"], /human|CI/u);
  mustRefuse(["project", "archive", "--root", project, "--apply", "--reason", "x", ...APPROVAL], /--plan-hash/u);
  assert.equal(fs.existsSync(path.join(project, ".sdlc", "project.json")), true);
  assert.equal(fs.existsSync(path.join(project, ".sdlc-archive")), false);
});

test("project archive refuses once the project was published or shared", () => {
  const project = newProject("published");
  // 1. A shared ref exists.
  git(project, ["commit", "--allow-empty", "-m", "base", "--quiet"]);
  git(project, ["update-ref", "refs/agentic-sdlc/standing/x", "HEAD"]);
  let output = mustRefuse(["project", "archive", "--root", project], /published or shared/u);
  assert.match(output, /Shared project state exists in git references/u);
  git(project, ["update-ref", "-d", "refs/agentic-sdlc/standing/x"]);
  assert.equal(plan(project).publication.published, false);

  // 2. Delivery execution records.
  const executions = path.join(project, ".sdlc", "autonomy", "executions", "AUT-1");
  fs.mkdirSync(executions, { recursive: true });
  fs.writeFileSync(path.join(executions, "start.json"), "{}\n");
  output = mustRefuse(applyArgs(project, "0".repeat(64)), /Delivery execution records exist/u);
  assert.equal(fs.existsSync(path.join(project, ".sdlc-archive")), false);
  fs.rmSync(path.dirname(executions), { recursive: true, force: true });

  // 3. .sdlc committed in history that a remote-tracking branch contains.
  git(project, ["add", ".sdlc"]);
  git(project, ["commit", "-m", "records", "--quiet"]);
  assert.equal(plan(project).publication.published, false);
  const remote = tmpDirectory("remote");
  git(remote, ["init", "--bare", "--quiet"]);
  git(project, ["remote", "add", "origin", remote]);
  git(project, ["push", "--quiet", "origin", "HEAD:refs/heads/main"]);
  git(project, ["fetch", "--quiet", "origin"]);
  output = mustRefuse(["project", "archive", "--root", project], /committed in history that a remote-tracking branch/u);
  assert.equal(fs.existsSync(path.join(project, ".sdlc", "project.json")), true);
});

test("project archive refuses when a remote cannot be checked and when shared refs sit on a remote", () => {
  const project = newProject("remote");
  git(project, ["commit", "--allow-empty", "-m", "base", "--quiet"]);
  git(project, ["remote", "add", "origin", path.join(tmpDirectory("missing"), "does-not-exist")]);
  mustRefuse(["project", "archive", "--root", project], /could not be reached to confirm/u);
  git(project, ["remote", "remove", "origin"]);

  const remote = tmpDirectory("shared-remote");
  git(remote, ["init", "--bare", "--quiet"]);
  git(project, ["remote", "add", "origin", remote]);
  assert.equal(plan(project).publication.published, false);
  git(project, ["update-ref", "refs/tmp/x", "HEAD"]);
  git(project, ["push", "--quiet", "origin", "refs/tmp/x:refs/agentic-sdlc/claims/x"]);
  git(project, ["update-ref", "-d", "refs/tmp/x"]);
  mustRefuse(["project", "archive", "--root", project], /already holds shared project state/u);
});

test("project archive is listed in help in both languages", () => {
  const english = mustRun(["help", "project", "archive"]).stdout;
  assert.match(english, /never deleted/u);
  const italian = mustRun(["help", "project", "archive", "--locale", "it"]).stdout;
  assert.match(italian, /mai eliminato/u);
});
