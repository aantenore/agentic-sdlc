import "./helpers/test-isolation.mjs";

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
const TEMPORARY = new Set();
const ISOLATED_ENVIRONMENT_KEYS = [
  "CI",
  "GITHUB_ACTIONS",
  "GITHUB_ACTOR",
  AGENT_HOST_OVERRIDE_ENV,
  ...AGENT_HOSTS.flatMap((host) => [...host.markers, ...Object.values(host.env).filter(Boolean)]),
];
const DELEGATION = ".sdlc/autonomy/delegations/DLG-PUB/delegation.json";

after(() => {
  if (process.env.AGENTIC_SDLC_KEEP_TEST_TMP === "1") return;
  for (const directory of TEMPORARY) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function temporaryDirectory(label) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `agentic-sdlc-delegation-publish-${label}-`));
  TEMPORARY.add(directory);
  return directory;
}

function run(args, cwd) {
  const env = { ...process.env };
  for (const key of ISOLATED_ENVIRONMENT_KEYS) delete env[key];
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env, timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
}

function mustRun(args, cwd) {
  const result = run(args, cwd);
  assert.equal(result.status, 0, `${args.join(" ")}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result;
}

function git(directory, args) {
  const result = spawnSync("git", ["-C", directory, ...args], { encoding: "utf8", timeout: 60_000 });
  assert.equal(result.status, 0, `git ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function identity(directory) {
  git(directory, ["config", "user.name", "Delegation E2E"]);
  git(directory, ["config", "user.email", "delegation-e2e@example.invalid"]);
  git(directory, ["config", "commit.gpgSign", "false"]);
}

/** A project on main, pushed to a bare remote, with a second clone standing in for another checkout. */
function sharedProject() {
  const first = temporaryDirectory("first");
  mustRun(["init", "--root", first, "--project-name", "Delegation publish"], first);
  git(first, ["init", "--quiet"]);
  git(first, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  identity(first);
  git(first, ["add", "-A"]);
  git(first, ["commit", "--quiet", "-m", "test: project"]);
  const remote = temporaryDirectory("remote");
  git(remote, ["init", "--quiet", "--bare"]);
  git(first, ["remote", "add", "origin", remote]);
  git(first, ["push", "--quiet", "origin", "main"]);
  git(first, ["remote", "set-head", "origin", "main"]);
  const second = temporaryDirectory("second");
  fs.rmSync(second, { recursive: true, force: true });
  const cloned = spawnSync("git", ["clone", "--quiet", "--branch", "main", remote, second], { encoding: "utf8" });
  assert.equal(cloned.status, 0, cloned.stderr);
  identity(second);
  return { first, second, remote };
}

test("a delegation granted on one checkout reaches the base branch with only its files, and another checkout sees it", () => {
  const { first, second, remote } = sharedProject();
  git(first, ["checkout", "--quiet", "-b", "feature/other-work"]);
  mustRun([
    "autonomy", "delegation", "grant", "--root", first, "--id", "DLG-PUB", "--scope", "project",
    "--actions", "breakdown.approve", "--until", "30d", "--summary", "Shared delegation",
    "--actor-type", "human", "--approval-source", "explicit-user", "--actor-name", "Antonio",
  ], first);
  const unrelated = path.join(first, ".sdlc", "unrelated-note.json");
  fs.writeFileSync(unrelated, "{}\n");
  const headBefore = git(first, ["rev-parse", "HEAD"]);
  const statusBefore = git(first, ["status", "--porcelain"]);

  const published = JSON.parse(mustRun(["autonomy", "delegation", "publish", "--root", first, "--id", "DLG-PUB", "--json"], first).stdout);
  assert.equal(published.status, "published");
  assert.deepEqual(published.published, [DELEGATION]);
  assert.deepEqual(published.conflicts, []);
  // Only the delegation's files travel, on top of main; this checkout is untouched.
  assert.deepEqual(git(remote, ["diff-tree", "--no-commit-id", "--name-only", "-r", "main"]).split("\n"), [DELEGATION]);
  assert.equal(git(remote, ["rev-parse", "main^"]), headBefore);
  assert.equal(git(first, ["rev-parse", "HEAD"]), headBefore);
  assert.equal(git(first, ["status", "--porcelain"]), statusBefore);
  assert.equal(git(first, ["rev-parse", "--abbrev-ref", "HEAD"]), "feature/other-work");

  // Publishing again changes nothing.
  const again = JSON.parse(mustRun(["autonomy", "delegation", "publish", "--root", first, "--id", "DLG-PUB", "--json"], first).stdout);
  assert.equal(again.status, "nothing_to_publish");
  assert.deepEqual(again.already_on_base, [DELEGATION]);

  git(second, ["pull", "--quiet", "--ff-only", "origin", "main"]);
  const listed = JSON.parse(mustRun(["autonomy", "delegation", "list", "--root", second, "--json"], second).stdout);
  assert.deepEqual(listed.delegations.map((item) => [item.id, item.state]), [["DLG-PUB", "active"]]);
});

test("an altered or missing delegation is never published", () => {
  const { first, remote } = sharedProject();
  const tip = git(remote, ["rev-parse", "main"]);
  const missing = run(["autonomy", "delegation", "publish", "--root", first, "--id", "DLG-NONE", "--json"], first);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stdout + missing.stderr, /DELEGATION_NOT_FOUND/u);
  mustRun([
    "autonomy", "delegation", "grant", "--root", first, "--id", "DLG-PUB", "--scope", "project",
    "--actions", "breakdown.approve", "--until", "30d", "--summary", "Shared delegation",
    "--actor-type", "human", "--approval-source", "explicit-user", "--actor-name", "Antonio",
  ], first);
  const file = path.join(first, DELEGATION);
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  record.expires_at = "2999-01-01T00:00:00.000Z";
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  const altered = run(["autonomy", "delegation", "publish", "--root", first, "--id", "DLG-PUB", "--json"], first);
  assert.notEqual(altered.status, 0);
  assert.match(altered.stdout + altered.stderr, /DELEGATION_INVALID/u);
  assert.equal(git(remote, ["rev-parse", "main"]), tip);
});
