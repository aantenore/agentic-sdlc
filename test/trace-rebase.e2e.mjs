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
const TRACE = ".sdlc/traces/project.jsonl";

after(() => {
  if (process.env.AGENTIC_SDLC_KEEP_TEST_TMP === "1") return;
  for (const entry of tempPaths) fs.rmSync(entry, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function tmpDirectory(name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `sdlc-trace-rebase-${name}-`));
  tempPaths.add(directory);
  return directory;
}

function run(args) {
  const env = { ...process.env };
  for (const key of ["CI", "GITHUB_ACTIONS", "GITHUB_ACTOR", "CODEX_AGENT_NAME", "CODEX_THREAD_ID", "CODEX_USER_ID", "CLAUDECODE", "AGENTIC_SDLC_AGENT_HOST"]) delete env[key];
  return spawnSync(process.execPath, [bin, ...args], { cwd: repoRoot, encoding: "utf8", env, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
}

function mustRun(args) {
  const result = run(args);
  assert.equal(result.status, 0, `${args.join(" ")}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result;
}

function mustRunJson(args) {
  return JSON.parse(mustRun([...args, "--json"]).stdout);
}

function git(project, args, { allowFailure = false } = {}) {
  const result = spawnSync("git", ["-C", project, ...args], { encoding: "utf8", timeout: 60_000 });
  if (!allowFailure) assert.equal(result.status, 0, `git ${args.join(" ")}\n${result.stderr}`);
  return result;
}

function configureClone(project, name) {
  git(project, ["config", "user.email", `${name}@example.invalid`]);
  git(project, ["config", "user.name", name]);
  git(project, ["config", "core.autocrlf", "false"]);
}

function record(project, summary) {
  mustRun(["trace", "append", "--root", project, "--type", "decision", "--summary", summary, "--actor-type", "human"]);
}

function verified(project) {
  return run(["trace", "verify", "--root", project, "--json"]).status === 0;
}

// Two computers share one remote and a common history, then each records
// its own events: the project history forks.
function twoComputers(name) {
  const root = tmpDirectory(name);
  const remote = path.join(root, "remote.git");
  git(root, ["init", "--quiet", "--bare", "-b", "main", remote]);
  const first = path.join(root, "first");
  fs.mkdirSync(first);
  mustRun(["init", "--root", first, "--project-name", "Shared history"]);
  git(first, ["init", "--quiet", "-b", "main"]);
  configureClone(first, "first");
  record(first, "Common decision");
  git(first, ["add", "-A"]);
  git(first, ["commit", "--quiet", "-m", "Start the project"]);
  git(first, ["remote", "add", "origin", remote]);
  git(first, ["push", "--quiet", "-u", "origin", "main"]);
  const second = path.join(root, "second");
  git(root, ["clone", "--quiet", remote, second]);
  configureClone(second, "second");
  record(first, "First computer decision");
  record(second, "Second computer decision A");
  record(second, "Second computer decision B");
  git(first, ["commit", "--quiet", "-am", "First computer work"]);
  git(first, ["push", "--quiet"]);
  git(second, ["commit", "--quiet", "-am", "Second computer work"]);
  git(second, ["fetch", "--quiet"]);
  return { first, second };
}

test("status and doctor warn before publishing when the project history forked, with the events on each side", () => {
  const { second } = twoComputers("warn");
  const status = mustRunJson(["status", "--root", second, "--sync", "off"]);
  assert.deepEqual(status.project_history_divergence, {
    base: "origin/main",
    file: TRACE,
    state: "diverged",
    local_only: 2,
    remote_only: 1,
    command: "trace rebase --onto origin/main --apply",
  });
  const text = mustRun(["status", "--root", second, "--sync", "off"]).stdout;
  assert.match(text, /Project history forked from origin\/main: 2 event\(s\) only here, 1 only on origin\/main\. Before publishing run agentic-sdlc trace rebase --onto origin\/main --apply/u);
  const doctor = mustRunJson(["doctor", "--root", second]);
  const check = doctor.checks.find((entry) => entry.id === "project-history-divergence");
  assert.equal(check.warning, true);
  assert.match(check.details, /2 event\(s\) only here, 1 only on origin\/main/u);
});

test("two computers merge their forked project history with one command and both verify it", () => {
  const { first, second } = twoComputers("merge");
  // The usual flow: merge the base branch, which conflicts on the history,
  // then rebase this computer's events onto it and finish the merge.
  git(second, ["merge", "--no-edit", "origin/main"], { allowFailure: true });
  const planned = mustRunJson(["trace", "rebase", "--root", second, "--onto", "origin/main"]);
  assert.equal(planned.applied, false);
  assert.equal(planned.moved_events, 2);
  const applied = mustRunJson(["trace", "rebase", "--root", second, "--onto", "origin/main", "--apply"]);
  assert.equal(applied.applied, true);
  assert.equal(applied.base_events, 2);
  assert.equal(applied.moved_events, 2);
  assert.equal(applied.already_present, 1);
  assert.equal(verified(second), true);
  git(second, ["add", ".sdlc/traces"]);
  git(second, ["commit", "--quiet", "--no-edit", "-m", "Merge origin/main"], { allowFailure: true });
  assert.equal(git(second, ["status", "--porcelain"]).stdout.trim(), "");
  const moved = fs.readFileSync(path.join(second, TRACE), "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(moved.slice(-2).map((event) => event.summary), ["Second computer decision A", "Second computer decision B"]);
  assert.ok(moved.slice(-2).every((event) => /^[a-f0-9]{64}$/u.test(event._trace_integrity.rebased_from.event_hash)));
  git(second, ["push", "--quiet"]);
  assert.equal(mustRunJson(["status", "--root", second, "--sync", "fetch"]).project_history_divergence.state, "in_sync");

  git(first, ["pull", "--quiet", "--no-rebase"]);
  assert.equal(verified(first), true);
  assert.equal(mustRunJson(["status", "--root", first, "--sync", "off"]).project_history_divergence.state, "in_sync");
  // Recording continues on the merged chain.
  record(first, "After the merge");
  assert.equal(verified(first), true);
  // Rebasing again finds nothing to move.
  const again = mustRunJson(["trace", "rebase", "--root", second, "--onto", "origin/main", "--apply"]);
  assert.equal(again.changed, false);
  assert.equal(again.moved_events, 0);
});

test("trace rebase without a reachable base names the fetch to run and changes nothing", () => {
  const { second } = twoComputers("missing-base");
  const before = fs.readFileSync(path.join(second, TRACE));
  const result = run(["trace", "rebase", "--root", second, "--onto", "origin/absent", "--apply"]);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /origin\/absent is not a commit in this clone; fetch it first/u);
  assert.ok(fs.readFileSync(path.join(second, TRACE)).equals(before));
});

test("trace rebase also merges the output registry by entry id", () => {
  const { first, second } = twoComputers("registry");
  const REGISTRY = ".sdlc/output-contracts/registry.json";
  const addDecision = (project, id) => {
    const file = path.join(project, REGISTRY);
    const registry = JSON.parse(fs.readFileSync(file, "utf8"));
    registry.decisions = [...(registry.decisions || []), { id, type: "fixture", status: "recorded" }];
    registry.updated_at = new Date().toISOString();
    fs.writeFileSync(file, `${JSON.stringify(registry, null, 2)}\n`);
    git(project, ["commit", "--quiet", "-am", `Record ${id}`]);
  };
  git(first, ["pull", "--quiet", "--no-rebase"], { allowFailure: true });
  addDecision(first, "DEC-FIRST");
  git(first, ["push", "--quiet"]);
  addDecision(second, "DEC-SECOND");
  git(second, ["fetch", "--quiet"]);
  git(second, ["merge", "--no-edit", "origin/main"], { allowFailure: true });
  const applied = mustRunJson(["trace", "rebase", "--root", second, "--onto", "origin/main", "--apply"]);
  assert.equal(applied.output_registry.file, REGISTRY);
  assert.equal(applied.output_registry.applied, true);
  const merged = JSON.parse(fs.readFileSync(path.join(second, REGISTRY), "utf8"));
  assert.deepEqual(merged.decisions.map((entry) => entry.id).filter((id) => id.startsWith("DEC-")).slice(-2), ["DEC-FIRST", "DEC-SECOND"]);
  assert.equal(verified(second), true);
});
