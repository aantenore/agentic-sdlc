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
  for (const directory of TEMPORARY) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
  TEMPORARY.clear();
});

function temporaryDirectory(label) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `agentic-sdlc-baseline-guard-${label}-`));
  TEMPORARY.add(directory);
  return directory;
}

function cliEnvironment() {
  const env = { ...process.env };
  for (const key of ISOLATED_ENVIRONMENT_KEYS) delete env[key];
  return env;
}

function run(args, project) {
  return spawnSync(process.execPath, [CLI, ...args, "--root", project], {
    cwd: project,
    encoding: "utf8",
    env: cliEnvironment(),
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function mustRun(args, project) {
  const result = run(args, project);
  assert.equal(result.error, undefined, `${args.join(" ")} failed to execute: ${result.error?.message}`);
  assert.equal(result.status, 0, `${args.join(" ")}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result;
}

function mustRunJson(args, project) {
  return JSON.parse(mustRun([...args, "--json"], project).stdout);
}

function mustFail(args, project, pattern) {
  const result = run(args, project);
  assert.notEqual(result.status, 0, `${args.join(" ")} unexpectedly succeeded\n${result.stdout}`);
  assert.match(result.stdout + result.stderr, pattern);
  return result;
}

function git(directory, args) {
  const result = spawnSync("git", ["-C", directory, ...args], { encoding: "utf8", timeout: 60_000 });
  assert.equal(result.status, 0, `git ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function configureGit(directory) {
  git(directory, ["config", "user.name", "Baseline E2E"]);
  git(directory, ["config", "user.email", "baseline-e2e@example.invalid"]);
  git(directory, ["config", "commit.gpgSign", "false"]);
  // Branch switches and clones check out the committed bytes on every platform.
  git(directory, ["config", "core.autocrlf", "false"]);
}

function remoteRefreshRefs(remote) {
  const result = spawnSync("git", ["ls-remote", remote, "refs/agentic-sdlc/baseline-refresh/*"], { encoding: "utf8" });
  return result.stdout.split("\n").filter(Boolean).map((line) => line.split("\t")[1]).sort();
}

function humanApproval(summary) {
  return ["--actor-type", "human", "--approval-source", "explicit-user", "--summary", summary];
}

function baselineFile(project, id) {
  return path.join(project, ".sdlc", "baseline", `${id}.json`);
}

function readBaseline(project, id) {
  return JSON.parse(fs.readFileSync(baselineFile(project, id), "utf8"));
}

function writeAndCommit(project, relativePath, content, message) {
  fs.mkdirSync(path.dirname(path.join(project, relativePath)), { recursive: true });
  fs.writeFileSync(path.join(project, relativePath), content, "utf8");
  git(project, ["add", "--", relativePath]);
  git(project, ["commit", "--quiet", "-m", message]);
}

/** A project on main with an approved baseline; with `remote`, shared through a bare remote and cloned once. */
function approvedProject(label, { remote = false } = {}) {
  const first = temporaryDirectory(`${label}-first`);
  mustRun(["init", "--project-name", "Baseline guard"], first);
  git(first, ["init", "--quiet"]);
  git(first, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  configureGit(first);
  fs.mkdirSync(path.join(first, "src"), { recursive: true });
  fs.writeFileSync(path.join(first, "src", "app.mjs"), "export const status = \"legacy\";\n", "utf8");
  fs.writeFileSync(path.join(first, "README.md"), "# Baseline guard\n", "utf8");
  mustRun(["baseline", "propose", "--id", "BASELINE-INITIAL", "--document", "README.md", "--source", "src"], first);
  mustRun(["baseline", "approve", "--id", "BASELINE-INITIAL", ...humanApproval("The snapshot is accurate")], first);
  git(first, ["add", "-A"]);
  git(first, ["commit", "--quiet", "-m", "test: approved baseline"]);
  if (!remote) return { first };
  const bare = temporaryDirectory(`${label}-remote`);
  git(bare, ["init", "--quiet", "--bare"]);
  git(bare, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  git(first, ["remote", "add", "origin", bare]);
  git(first, ["push", "--quiet", "origin", "main"]);
  const second = temporaryDirectory(`${label}-second`);
  fs.rmSync(second, { recursive: true, force: true });
  const cloned = spawnSync("git", ["clone", "--quiet", "--config", "core.autocrlf=false", "--branch", "main", bare, second], { encoding: "utf8" });
  assert.equal(cloned.status, 0, cloned.stderr);
  configureGit(second);
  return { first, second, remote: bare };
}

test("a refresh on an unmerged story branch is refused and writes nothing", () => {
  const { first, second, remote } = approvedProject("story-branch", { remote: true });
  // The clone knows the remote default branch; the story branch is not it.
  git(second, ["switch", "--quiet", "-c", "story/booking"]);
  writeAndCommit(second, "src/booking.mjs", "export const booking = true;\n", "test: story work");
  const refused = mustFail(["baseline", "refresh", "--from", "BASELINE-INITIAL"], second, /the current branch is story\/booking, not the base branch main/u);
  assert.match(refused.stdout + refused.stderr, /git switch main/u);
  assert.match(refused.stdout + refused.stderr, /--allow-non-base-branch/u);
  assert.equal(fs.existsSync(baselineFile(second, "BASELINE-INITIAL-R2")), false);
  assert.deepEqual(remoteRefreshRefs(remote), []);

  // Italian guidance names the same way forward.
  const italian = run(["baseline", "refresh", "--from", "BASELINE-INITIAL", "--locale", "it"], second);
  assert.notEqual(italian.status, 0);
  assert.match(italian.stdout + italian.stderr, /non il branch base main/u);

  // A detached HEAD on a story commit is refused too; at the tip of main it is the base.
  git(second, ["switch", "--quiet", "--detach", "story/booking"]);
  mustFail(["baseline", "refresh", "--from", "BASELINE-INITIAL"], second, /HEAD is detached at [0-9a-f]{12}, not the base branch main/u);

  // On the computer whose remote has no default branch recorded, a local main is the base.
  git(first, ["switch", "--quiet", "-c", "story/other"]);
  writeAndCommit(first, "src/other.mjs", "export const other = true;\n", "test: other story");
  mustFail(["baseline", "refresh", "--from", "BASELINE-INITIAL"], first, /the current branch is story\/other, not the base branch main/u);

  // The explicit override records where the snapshot came from.
  const overridden = mustRunJson(["baseline", "refresh", "--from", "BASELINE-INITIAL", "--allow-non-base-branch"], first);
  assert.equal(overridden.status, "proposed");
  const record = readBaseline(first, "BASELINE-INITIAL-R2");
  assert.equal(record.refresh.checkout.branch, "story/other");
  assert.equal(record.refresh.checkout.base_branch_check, "overridden");
  assert.deepEqual(record.refresh.checkout.base_branches, ["main"]);
});

test("uncommitted changes in the baseline scope refuse the refresh; other files do not", () => {
  const { first } = approvedProject("uncommitted");
  fs.writeFileSync(path.join(first, "src", "draft.mjs"), "export const draft = true;\n", "utf8");
  fs.writeFileSync(path.join(first, "notes.txt"), "outside the baseline scope\n", "utf8");
  const refused = mustFail(["baseline", "refresh", "--from", "BASELINE-INITIAL"], first, /1 file\(s\) in its scope have changes that are not committed: src\/draft\.mjs/u);
  assert.match(refused.stdout + refused.stderr, /--allow-uncommitted-changes/u);
  assert.equal(fs.existsSync(baselineFile(first, "BASELINE-INITIAL-R2")), false);

  git(first, ["add", "--", "src/draft.mjs"]);
  git(first, ["commit", "--quiet", "-m", "test: commit the draft"]);
  const refreshed = mustRunJson(["baseline", "refresh", "--from", "BASELINE-INITIAL"], first);
  assert.equal(refreshed.status, "proposed");
  assert.deepEqual(refreshed.unexplained, [{ path: "src/draft.mjs", change: "added" }]);
  const checkout = readBaseline(first, "BASELINE-INITIAL-R2").refresh.checkout;
  assert.equal(checkout.branch, "main");
  assert.equal(checkout.base_branch_check, "base_branch");
  assert.equal(checkout.working_tree, "clean");
  mustRun(["baseline", "approve", "--id", "BASELINE-INITIAL-R2", ...humanApproval("Draft recorded")], first);

  // An edit of a file the snapshot describes counts; the override records it.
  fs.writeFileSync(path.join(first, "README.md"), "# Baseline guard\n\nEdited by hand.\n", "utf8");
  mustFail(["baseline", "refresh", "--from", "BASELINE-INITIAL-R2"], first, /README\.md/u);
  mustRunJson(["baseline", "refresh", "--from", "BASELINE-INITIAL-R2", "--allow-uncommitted-changes"], first);
  const overridden = readBaseline(first, "BASELINE-INITIAL-R3").refresh.checkout;
  assert.equal(overridden.working_tree, "overridden");
  assert.deepEqual(overridden.uncommitted_paths, ["README.md"]);
});

test("projects outside git and repositories without a commit refresh as before", () => {
  const plain = temporaryDirectory("no-git");
  mustRun(["init", "--project-name", "No git"], plain);
  fs.mkdirSync(path.join(plain, "src"), { recursive: true });
  fs.writeFileSync(path.join(plain, "src", "app.mjs"), "export const a = 1;\n", "utf8");
  mustRun(["baseline", "propose", "--id", "BASELINE-INITIAL", "--source", "src"], plain);
  mustRun(["baseline", "approve", "--id", "BASELINE-INITIAL", ...humanApproval("ok")], plain);
  fs.writeFileSync(path.join(plain, "src", "new.mjs"), "export const b = 2;\n", "utf8");
  const refreshed = mustRunJson(["baseline", "refresh", "--from", "BASELINE-INITIAL"], plain);
  assert.equal(refreshed.status, "proposed");
  assert.equal(readBaseline(plain, "BASELINE-INITIAL-R2").refresh.checkout, undefined);

  const unborn = temporaryDirectory("unborn");
  mustRun(["init", "--project-name", "Unborn"], unborn);
  git(unborn, ["init", "--quiet"]);
  git(unborn, ["symbolic-ref", "HEAD", "refs/heads/feature"]);
  configureGit(unborn);
  fs.mkdirSync(path.join(unborn, "src"), { recursive: true });
  fs.writeFileSync(path.join(unborn, "src", "app.mjs"), "export const a = 1;\n", "utf8");
  mustRun(["baseline", "propose", "--id", "BASELINE-INITIAL", "--source", "src"], unborn);
  mustRun(["baseline", "approve", "--id", "BASELINE-INITIAL", ...humanApproval("ok")], unborn);
  fs.writeFileSync(path.join(unborn, "src", "new.mjs"), "export const b = 2;\n", "utf8");
  assert.equal(mustRunJson(["baseline", "refresh", "--from", "BASELINE-INITIAL"], unborn).status, "proposed");
});

test("a proposed refresh is withdrawn with a person's approval and stops blocking every computer", () => {
  const { first, second, remote } = approvedProject("withdraw", { remote: true });
  // The reported mistake: a refresh taken from a story branch claims the successor everywhere.
  git(first, ["switch", "--quiet", "-c", "story/booking"]);
  writeAndCommit(first, "src/booking.mjs", "export const booking = true;\n", "test: story work");
  mustRunJson(["baseline", "refresh", "--from", "BASELINE-INITIAL", "--allow-non-base-branch"], first);
  assert.deepEqual(remoteRefreshRefs(remote), ["refs/agentic-sdlc/baseline-refresh/BASELINE-INITIAL/successor"]);
  const blockedGate = run(["gate", "check", "--strict", "--json"], first);
  assert.notEqual(blockedGate.status, 0);
  assert.match(blockedGate.stdout, /baseline BASELINE-INITIAL-R2 is 'proposed'/u);

  // The other computer cannot refresh while the successor is claimed.
  writeAndCommit(second, "src/main-work.mjs", "export const mainWork = true;\n", "test: work on main");
  mustFail(["baseline", "refresh", "--from", "BASELINE-INITIAL"], second, /already refreshed as BASELINE-INITIAL-R2 on another computer/u);
  // Asking for a refresh from the line points at the withdrawal too.
  mustFail(["baseline", "refresh", "--from", "BASELINE-INITIAL"], first, /baseline refresh withdraw --id BASELINE-INITIAL-R2/u);

  // Withdrawing needs a reason and a person's (or CI's) approval.
  mustFail(["baseline", "refresh", "withdraw", "--id", "BASELINE-INITIAL-R2", ...humanApproval("Withdraw")], first, /--reason/u);
  mustFail([
    "baseline", "refresh", "withdraw", "--id", "BASELINE-INITIAL-R2", "--reason", "Taken from a story branch",
    "--actor-type", "agent", "--approval-source", "explicit-user", "--summary", "Withdraw",
  ], first, /requires --actor-type human or an approved CI actor/u);
  assert.equal(readBaseline(first, "BASELINE-INITIAL-R2").status, "proposed");

  const withdrawn = mustRunJson([
    "baseline", "refresh", "withdraw", "--id", "BASELINE-INITIAL-R2", "--reason", "Taken from a story branch",
    ...humanApproval("Withdraw the refresh taken from story/booking"),
  ], first);
  assert.equal(withdrawn.status, "withdrawn");
  assert.equal(withdrawn.previous_baseline_id, "BASELINE-INITIAL");
  assert.equal(withdrawn.shared.recorded, true);
  assert.deepEqual(withdrawn.next_commands, ["agentic-sdlc baseline refresh --from BASELINE-INITIAL"]);
  assert.deepEqual(remoteRefreshRefs(remote), [
    "refs/agentic-sdlc/baseline-refresh/BASELINE-INITIAL/successor",
    "refs/agentic-sdlc/baseline-refresh/BASELINE-INITIAL/withdrawn",
  ]);

  // The record is kept, marked, and attributed.
  const record = readBaseline(first, "BASELINE-INITIAL-R2");
  assert.equal(record.status, "withdrawn");
  assert.equal(record.withdrawal.reason, "Taken from a story branch");
  assert.equal(record.withdrawal.previous_status, "proposed");
  assert.equal(record.withdrawal.withdrawn_by.type, "human");
  assert.equal(record.withdrawal.approval.approval_source, "explicit-user");
  assert.match(fs.readFileSync(path.join(first, ".sdlc", "baseline", "BASELINE-INITIAL-R2-current-state.md"), "utf8"), /Withdrawn: Taken from a story branch/u);
  const trace = fs.readdirSync(path.join(first, ".sdlc", "traces"), { recursive: true })
    .filter((name) => String(name).endsWith(".jsonl"))
    .map((name) => fs.readFileSync(path.join(first, ".sdlc", "traces", String(name)), "utf8"))
    .join("\n");
  assert.match(trace, /baseline\.refresh\.withdraw/u);

  // Running it again changes nothing; a withdrawn baseline is never approved.
  assert.equal(mustRunJson([
    "baseline", "refresh", "withdraw", "--id", "BASELINE-INITIAL-R2", "--reason", "Taken from a story branch",
    ...humanApproval("Again"),
  ], first).idempotent, true);
  mustFail(["baseline", "approve", "--id", "BASELINE-INITIAL-R2", ...humanApproval("Approve anyway")], first, /was withdrawn .* and is never approved/u);

  // The predecessor is the current project state again; the strict gate no longer names the withdrawn record.
  git(first, ["switch", "--quiet", "main"]);
  const status = mustRunJson(["baseline", "status"], first);
  const entry = (id) => status.baselines.find((item) => item.id === id);
  assert.equal(entry("BASELINE-INITIAL").effective_status, "approved");
  assert.equal(entry("BASELINE-INITIAL-R2").effective_status, "withdrawn");
  assert.equal(entry("BASELINE-INITIAL-R2").withdrawal_reason, "Taken from a story branch");
  const gate = run(["gate", "check", "--strict", "--json"], first);
  assert.doesNotMatch(gate.stdout, /BASELINE-INITIAL-R2 is 'proposed'/u);

  // The other computer refreshes from main: it skips the withdrawn id and claims the next generation.
  const refreshed = mustRunJson(["baseline", "refresh", "--from", "BASELINE-INITIAL"], second);
  assert.equal(refreshed.previous_baseline_id, "BASELINE-INITIAL");
  assert.equal(refreshed.baseline_id, "BASELINE-INITIAL-R3");
  assert.deepEqual(refreshed.unexplained, [{ path: "src/main-work.mjs", change: "added" }]);
  assert.deepEqual(remoteRefreshRefs(remote), [
    "refs/agentic-sdlc/baseline-refresh/BASELINE-INITIAL/successor",
    "refs/agentic-sdlc/baseline-refresh/BASELINE-INITIAL/successor-1",
    "refs/agentic-sdlc/baseline-refresh/BASELINE-INITIAL/withdrawn",
  ]);
  mustRun(["baseline", "approve", "--id", "BASELINE-INITIAL-R3", ...humanApproval("Main work recorded")], second);
});

test("a successor recorded only on the remote is withdrawn by naming its predecessor", () => {
  const { first, second, remote } = approvedProject("withdraw-remote", { remote: true });
  git(first, ["switch", "--quiet", "-c", "story/booking"]);
  writeAndCommit(first, "src/booking.mjs", "export const booking = true;\n", "test: story work");
  mustRunJson(["baseline", "refresh", "--from", "BASELINE-INITIAL", "--allow-non-base-branch"], first);

  // The computer on main has no copy of the proposed record.
  mustFail([
    "baseline", "refresh", "withdraw", "--id", "BASELINE-INITIAL-R2", "--reason", "Taken from a story branch",
    ...humanApproval("Withdraw"),
  ], second, /name the baseline it refreshes with --from/u);
  mustFail([
    "baseline", "refresh", "withdraw", "--id", "BASELINE-INITIAL-R9", "--from", "BASELINE-INITIAL", "--reason", "Wrong id",
    ...humanApproval("Withdraw"),
  ], second, /records no open successor BASELINE-INITIAL-R9/u);
  const withdrawn = mustRunJson([
    "baseline", "refresh", "withdraw", "--id", "BASELINE-INITIAL-R2", "--from", "BASELINE-INITIAL",
    "--reason", "Taken from a story branch", ...humanApproval("Withdraw"),
  ], second);
  assert.equal(withdrawn.shared.recorded, true);
  assert.equal(withdrawn.baseline_path, null);
  assert.equal(remoteRefreshRefs(remote).includes("refs/agentic-sdlc/baseline-refresh/BASELINE-INITIAL/withdrawn"), true);

  // The orphaned proposal on the story branch can no longer be approved.
  mustFail(["baseline", "approve", "--id", "BASELINE-INITIAL-R2", ...humanApproval("Approve")], first, /BASELINE-INITIAL-R2 was withdrawn as the successor of BASELINE-INITIAL/u);
});
