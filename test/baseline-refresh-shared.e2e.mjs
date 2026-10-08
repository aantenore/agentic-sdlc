import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { AGENT_HOSTS, AGENT_HOST_OVERRIDE_ENV } from "../lib/agent-host.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPOSITORY_ROOT, "bin", "agentic-sdlc.mjs");
const TEMPORARY = new Set();
const SESSION_MARKERS = AGENT_HOSTS.flatMap((host) => host.markers);
const ISOLATED_ENVIRONMENT_KEYS = [
  "CI",
  "GITHUB_ACTIONS",
  "GITHUB_ACTOR",
  AGENT_HOST_OVERRIDE_ENV,
  ...AGENT_HOSTS.flatMap((host) => [...host.markers, ...Object.values(host.env).filter(Boolean)]),
];

after(() => {
  if (process.env.AGENTIC_SDLC_KEEP_TEST_TMP === "1") return;
  for (const directory of TEMPORARY) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
  TEMPORARY.clear();
});

function temporaryDirectory(label) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `agentic-sdlc-baseline-refresh-${label}-`));
  TEMPORARY.add(directory);
  return directory;
}

function cliEnvironment(extra = {}) {
  const env = { ...process.env };
  for (const key of ISOLATED_ENVIRONMENT_KEYS) delete env[key];
  return { ...env, ...extra };
}

function run(args, project, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: project,
    encoding: "utf8",
    env: cliEnvironment(env),
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function runAsync(args, project) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: project, env: cliEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({
      status,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

function mustRun(args, project, env = {}) {
  const result = run(args, project, env);
  assert.equal(result.error, undefined, `${args.join(" ")} failed to execute: ${result.error?.message}`);
  assert.equal(result.status, 0, `${args.join(" ")}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result;
}

function git(directory, args) {
  const result = spawnSync("git", ["-C", directory, ...args], { encoding: "utf8", timeout: 60_000 });
  assert.equal(result.status, 0, `git ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function remoteRefreshRefs(remote) {
  const result = spawnSync("git", ["ls-remote", remote, "refs/agentic-sdlc/baseline-refresh/*"], { encoding: "utf8" });
  return result.stdout.split("\n").filter(Boolean).map((line) => line.split("\t")[1]).sort();
}

function humanApproval(summary) {
  return ["--actor-type", "human", "--approval-source", "explicit-user", "--summary", summary];
}

/** One project with an approved baseline, shared by two computers through a bare remote. */
function sharedBaselineProject(label) {
  const first = temporaryDirectory(`${label}-first`);
  mustRun(["init", "--root", first, "--project-name", "Shared baseline"], first);
  git(first, ["init", "--quiet"]);
  git(first, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  git(first, ["config", "user.name", "Baseline E2E"]);
  git(first, ["config", "user.email", "baseline-e2e@example.invalid"]);
  git(first, ["config", "commit.gpgSign", "false"]);
  fs.mkdirSync(path.join(first, "src"), { recursive: true });
  fs.writeFileSync(path.join(first, "src", "app.mjs"), "export const status = \"legacy\";\n", "utf8");
  fs.writeFileSync(path.join(first, "README.md"), "# Shared baseline\n", "utf8");
  mustRun(["baseline", "propose", "--root", first, "--id", "BASELINE-INITIAL", "--document", "README.md", "--source", "src"], first);
  mustRun(["baseline", "approve", "--root", first, "--id", "BASELINE-INITIAL", ...humanApproval("The snapshot is accurate")], first);
  git(first, ["add", "-A"]);
  git(first, ["commit", "--quiet", "-m", "test: approved baseline"]);
  const remote = temporaryDirectory(`${label}-remote`);
  git(remote, ["init", "--quiet", "--bare"]);
  git(first, ["remote", "add", "origin", remote]);
  git(first, ["push", "--quiet", "origin", "main"]);
  const second = temporaryDirectory(`${label}-second`);
  fs.rmSync(second, { recursive: true, force: true });
  const cloned = spawnSync("git", ["clone", "--quiet", "--branch", "main", remote, second], { encoding: "utf8" });
  assert.equal(cloned.status, 0, cloned.stderr);
  git(second, ["config", "user.name", "Baseline E2E"]);
  git(second, ["config", "user.email", "baseline-e2e@example.invalid"]);
  return { first, second, remote };
}

test("two computers refreshing the same baseline at the same moment: exactly one successor exists", async () => {
  const { first, second, remote } = sharedBaselineProject("race");
  fs.writeFileSync(path.join(first, "src", "extra.mjs"), "export const extra = 1;\n", "utf8");
  fs.writeFileSync(path.join(second, "src", "other.mjs"), "export const other = 2;\n", "utf8");

  const results = await Promise.all([first, second].map((project) =>
    runAsync(["baseline", "refresh", "--root", project, "--from", "BASELINE-INITIAL", "--json"], project)));
  const winners = results.filter((result) => result.status === 0);
  const losers = results.filter((result) => result.status !== 0);
  assert.equal(winners.length, 1, results.map((result) => result.stdout + result.stderr).join("\n"));
  assert.equal(losers.length, 1);
  assert.match(losers[0].stdout + losers[0].stderr, /already refreshed as BASELINE-INITIAL-R2 on another computer/u);
  assert.deepEqual(remoteRefreshRefs(remote), ["refs/agentic-sdlc/baseline-refresh/BASELINE-INITIAL/successor"]);

  const winner = winners[0] === results[0] ? first : second;
  const loser = winner === first ? second : first;
  assert.equal(fs.existsSync(path.join(winner, ".sdlc", "baseline", "BASELINE-INITIAL-R2.json")), true);
  // The refused computer wrote nothing and keeps its approved baseline.
  assert.equal(fs.existsSync(path.join(loser, ".sdlc", "baseline", "BASELINE-INITIAL-R2.json")), false);

  // A retry from the same baseline stays refused, whoever asks.
  const retry = run(["baseline", "refresh", "--root", loser, "--from", "BASELINE-INITIAL", "--json"], loser);
  assert.notEqual(retry.status, 0);
  assert.match(retry.stdout + retry.stderr, /Pull the project records, then run baseline refresh --from BASELINE-INITIAL-R2/u);
});

test("a refresh on a computer without a reachable remote writes nothing in a shared project", () => {
  const { first } = sharedBaselineProject("unreachable");
  git(first, ["remote", "set-url", "origin", path.join(first, "missing-remote.git")]);
  fs.writeFileSync(path.join(first, "src", "extra.mjs"), "export const extra = 1;\n", "utf8");
  const refused = run(["baseline", "refresh", "--root", first, "--from", "BASELINE-INITIAL", "--json"], first);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stdout + refused.stderr, /another computer may already have refreshed it/u);
  assert.equal(fs.existsSync(path.join(first, ".sdlc", "baseline", "BASELINE-INITIAL-R2.json")), false);
});
