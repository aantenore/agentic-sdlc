import "./helpers/test-isolation.mjs";

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBareOrigin, createFixtureDir } from "./helpers/test-isolation.mjs";
import { buildContext } from "../lib/engine/common.mjs";
import { resolvePreparedStarts, storyPrepare } from "../lib/engine/story-prepare.mjs";
import { runWithMutationGovernance } from "../lib/governance/mutation-guard.mjs";
import { hasWaitingPreparedStarts, resolvePreparedStartsFor } from "../lib/host-hooks/prepared-starts.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repoRoot, "bin/agentic-sdlc.mjs");
const PR = "https://github.com/owner/repository/pull/184";

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}\n${result.stderr}`);
  return result.stdout.trim();
}

function mustRun(project, args) {
  const result = spawnSync(process.execPath, [cli, ...args, "--root", project], { encoding: "utf8", timeout: 60_000 });
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function fixture() {
  const dir = createFixtureDir("sdlc-prepare-");
  const project = path.join(dir, "project");
  fs.mkdirSync(project);
  git(project, ["init", "--quiet", "--initial-branch=main"]);
  git(project, ["config", "user.email", "t@example.test"]);
  git(project, ["config", "user.name", "Test"]);
  mustRun(project, ["init", "--project-name", "Prepare fixture"]);
  mustRun(project, ["requirement", "propose", "--id", "REQ-A", "--title", "A", "--summary", "Outcome", "--acceptance", "Works", "--autonomy-ceiling", "supervised", "--write-path", "src"]);
  mustRun(project, ["requirement", "approve", "--id", "REQ-A", "--actor-type", "human", "--approval-source", "explicit-user", "--summary", "ok"]);
  mustRun(project, ["story", "create", "--id", "ST-DEP", "--title", "Dep", "--requirement", "REQ-A"]);
  mustRun(project, ["story", "create", "--id", "ST-NEXT", "--title", "Next", "--requirement", "REQ-A"]);
  git(project, ["add", "-A"]);
  git(project, ["commit", "--quiet", "-m", "base"]);
  createBareOrigin(project);
  git(project, ["push", "--quiet", "origin", "main"]);
  git(project, ["fetch", "--quiet", "origin"]);
  return { dir, project, context: buildContext({ root: project }) };
}

// Library calls need the project boundary the CLI establishes per command.
function governed(project, callback) {
  return runWithMutationGovernance({ mode: "disabled", root: project }, callback);
}

const prepare = (project, context, options, d) => governed(project, () => storyPrepare(context, options, d));
const resolve = (project, context, options, d) => governed(project, () => resolvePreparedStarts(context, options, d));

function deps(calls, extra = {}) {
  return {
    createContract: (_context, options) => calls.push(["contract", options.id]),
    startTask: (_context, options) => calls.push(["start", options.story]),
    claimStory: (_context, options) => calls.push(["claim", options.id]),
    announce: (message) => calls.push(["announce", message.kind, message.text]),
    ...extra,
  };
}

test("preparing with an open dependency makes the contract, the worktree from origin/main and the record, and starts nothing", () => {
  const { context, project } = fixture();
  const calls = [];
  const record = prepare(project, context, { id: "ST-NEXT", "depends-on": PR, agent: "alice" }, deps(calls));
  assert.equal(record.state, "waiting");
  assert.deepEqual(record.depends_on, { kind: "pr", target: PR });
  assert.equal(record.steps.contract.status, "done");
  assert.equal(record.steps.worktree.status, "done");
  assert.equal(record.steps.delivery_profile.status, "skipped");
  assert.deepEqual(calls, [["contract", "contract-ST-NEXT-implementation"]]);
  assert.equal(git(record.worktree, ["rev-parse", "HEAD"]), git(project, ["rev-parse", "refs/remotes/origin/main"]));
  assert.equal(git(record.worktree, ["rev-parse", "--abbrev-ref", "HEAD"]), record.branch);
  assert.equal(hasWaitingPreparedStarts(project), true);
  // Still open: resolving changes nothing.
  assert.deepEqual(resolve(project, context, {}, deps(calls, { pullRequestState: () => "open" })), [{ story_id: "ST-NEXT", outcome: "waiting" }]);
  assert.equal(calls.length, 1);
  assert.deepEqual(resolvePreparedStartsFor(project, { run: () => JSON.stringify({ results: [{ story_id: "ST-NEXT", outcome: "waiting" }] }) }), []);
});

test("a merged dependency realigns the worktree to origin/main, runs task start and claim, announces, and is idempotent", () => {
  const { context, project } = fixture();
  const calls = [];
  const record = prepare(project, context, { id: "ST-NEXT", "depends-on": "ST-DEP" }, deps(calls));
  // The dependency lands on the base branch after the preparation.
  const other = path.join(path.dirname(project), "other");
  git(path.dirname(project), ["clone", "--quiet", git(project, ["remote", "get-url", "origin"]), other]);
  git(other, ["config", "user.email", "t@example.test"]);
  git(other, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(other, "dep.txt"), "dependency\n");
  git(other, ["add", "-A"]);
  git(other, ["commit", "--quiet", "-m", "dependency merged"]);
  git(other, ["push", "--quiet", "origin", "main"]);
  fs.writeFileSync(path.join(project, ".sdlc/stories/ST-DEP/closure.json"), "{}\n");

  const results = resolve(project, context, {}, deps(calls));
  assert.deepEqual(results, [{ story_id: "ST-NEXT", outcome: "started" }]);
  assert.deepEqual(calls.slice(1).map((call) => call[0]), ["start", "claim", "announce"]);
  assert.equal(calls.at(-1)[1], "info");
  assert.equal(fs.existsSync(path.join(record.worktree, "dep.txt")), true, "worktree realigned to the new origin/main");
  assert.equal(git(record.worktree, ["rev-parse", "HEAD"]), git(project, ["rev-parse", "refs/remotes/origin/main"]));
  assert.equal(fs.readFileSync(path.join(project, ".sdlc/prepared-starts/ST-NEXT.json"), "utf8").includes('"state": "started"'), true);
  assert.deepEqual(resolve(project, context, {}, deps(calls)), []);
  assert.equal(calls.filter((call) => call[0] === "start").length, 1);
});

test("a dependency closed without a merge notifies and never starts", () => {
  const { context, project } = fixture();
  const calls = [];
  prepare(project, context, { id: "ST-NEXT", "depends-on": PR }, deps(calls));
  const results = resolve(project, context, {}, deps(calls, { pullRequestState: () => "closed" }));
  assert.deepEqual(results, [{ story_id: "ST-NEXT", outcome: "dependency_closed" }]);
  assert.deepEqual(calls.slice(1).map((call) => call[0]), ["announce"]);
  assert.equal(calls.at(-1)[1], "question");
  assert.equal(calls.some((call) => call[0] === "start" || call[0] === "claim"), false);
  assert.deepEqual(resolve(project, context, {}, deps(calls, { pullRequestState: () => "merged" })), []);
});

test("a refused task start leaves the preparation blocked and announced", () => {
  const { context, project } = fixture();
  const calls = [];
  prepare(project, context, { id: "ST-NEXT", "depends-on": PR }, deps(calls));
  const results = resolve(project, context, {}, deps(calls, {
    pullRequestState: () => "merged",
    startTask: () => { throw new Error("start needs a human"); },
  }));
  assert.equal(results[0].outcome, "start_blocked");
  assert.equal(calls.some((call) => call[0] === "claim"), false);
});
