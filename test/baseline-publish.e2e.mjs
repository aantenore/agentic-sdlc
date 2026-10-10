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

after(() => {
  if (process.env.AGENTIC_SDLC_KEEP_TEST_TMP === "1") return;
  for (const directory of TEMPORARY) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function temporaryDirectory(label) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `agentic-sdlc-baseline-publish-${label}-`));
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
  git(directory, ["config", "user.name", "Baseline E2E"]);
  git(directory, ["config", "user.email", "baseline-e2e@example.invalid"]);
  git(directory, ["config", "commit.gpgSign", "false"]);
}

/** A project on main, pushed to a bare remote, with a second clone standing in for another checkout. */
function sharedProject() {
  const first = temporaryDirectory("first");
  mustRun(["init", "--root", first, "--project-name", "Baseline publish"], first);
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

const RECORD = ".sdlc/baseline/BASELINE-PUB.json";

function proposeBaseline(root) {
  fs.writeFileSync(path.join(root, "README.md"), "# Baseline publish\n");
  mustRun(["baseline", "propose", "--root", root, "--id", "BASELINE-PUB", "--source", "README.md", "--summary", "Current state"], root);
}

test("an approved baseline reaches the base branch as a records-only commit with only its files", () => {
  const { first, second, remote } = sharedProject();
  git(first, ["checkout", "--quiet", "-b", "feature/other-work"]);
  proposeBaseline(first);
  const tip = git(remote, ["rev-parse", "main"]);
  const proposed = run(["baseline", "publish", "--root", first, "--id", "BASELINE-PUB", "--json"], first);
  assert.notEqual(proposed.status, 0);
  assert.match(proposed.stdout + proposed.stderr, /BASELINE_NOT_APPROVED/u);
  assert.equal(git(remote, ["rev-parse", "main"]), tip);

  mustRun([
    "baseline", "approve", "--root", first, "--id", "BASELINE-PUB",
    "--actor-type", "human", "--approval-source", "explicit-user", "--actor-name", "Antonio", "--summary", "Approved",
  ], first);
  const headBefore = git(first, ["rev-parse", "HEAD"]);
  const statusBefore = git(first, ["status", "--porcelain"]);
  const published = JSON.parse(mustRun(["baseline", "publish", "--root", first, "--id", "BASELINE-PUB", "--json"], first).stdout);
  assert.equal(published.status, "published");
  assert.ok(published.published.includes(RECORD));
  assert.ok(published.published.every((file) => file.startsWith(".sdlc/baseline/BASELINE-PUB")));
  assert.deepEqual(git(remote, ["diff-tree", "--no-commit-id", "--name-only", "-r", "main"]).split("\n").sort(), [...published.published].sort());
  assert.equal(git(remote, ["rev-parse", "main^"]), tip);
  assert.equal(git(first, ["rev-parse", "HEAD"]), headBefore);
  assert.equal(git(first, ["status", "--porcelain"]), statusBefore);

  const again = JSON.parse(mustRun(["baseline", "publish", "--root", first, "--id", "BASELINE-PUB", "--json"], first).stdout);
  assert.equal(again.status, "nothing_to_publish");

  git(second, ["pull", "--quiet", "--ff-only", "origin", "main"]);
  assert.ok(fs.existsSync(path.join(second, RECORD)));
});
