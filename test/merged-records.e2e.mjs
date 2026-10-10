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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `agentic-sdlc-merged-records-${label}-`));
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

function mustRun(args, project, env = {}) {
  const result = run(args, project, env);
  assert.equal(result.error, undefined, `${args.join(" ")} failed to execute: ${result.error?.message}`);
  assert.equal(result.status, 0, `${args.join(" ")}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result;
}

function mustRunJson(args, project, env = {}) {
  return JSON.parse(mustRun([...args, "--json"], project, env).stdout);
}

/** Runs a command that must be refused and returns its JSON error. */
function mustRefuseJson(args, project, env = {}) {
  const result = run([...args, "--json"], project, env);
  assert.equal(result.error, undefined, `${args.join(" ")} failed to execute: ${result.error?.message}`);
  assert.notEqual(result.status, 0, `${args.join(" ")} unexpectedly passed\n${result.stdout}`);
  return JSON.parse(result.stdout || result.stderr);
}

function git(directory, args) {
  const result = spawnSync("git", ["-C", directory, ...args], { encoding: "utf8", timeout: 60_000 });
  assert.equal(result.status, 0, `git ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function remoteClaimRefs(remote) {
  const result = spawnSync("git", ["ls-remote", remote, "refs/agentic-sdlc/claims/*"], { encoding: "utf8" });
  return result.stdout.split("\n").filter(Boolean).map((line) => line.split("\t")[1]).sort();
}

function remoteRecord(remote, ref) {
  return JSON.parse(git(remote, ["log", "-1", "--format=%B", ref]));
}

function claimFile(project, storyId) {
  const file = path.join(project, ".sdlc", "stories", storyId, "claim.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

function humanApproval(summary) {
  return ["--actor-type", "human", "--approval-source", "explicit-user", "--summary", summary];
}

function startIntent(storyId) {
  return JSON.stringify({
    requested_action: "implement_story",
    confidence: 0.95,
    referenced_entities: [{ type: "story", id: storyId }],
    provided_artifacts: [],
    missing_context: [],
    proposed_phase: "design",
    artifact_type: null,
    skip_phases: [],
  });
}

/** Stories ready to claim: acceptance criteria, an approved contract, and a confirmed task start. */
function prepareStories(project, storyIds) {
  mustRun(["output", "template", "propose", "--root", project, "--type", "functional-analysis", "--summary", "Standard template"], project);
  mustRun(["output", "template", "approve", "--root", project, "--id", "functional-analysis-v1", ...humanApproval("Approve the template")], project);
  for (const storyId of storyIds) {
    mustRun([
      "story", "create", "--no-derived-verification", "--root", project, "--id", storyId, "--title", `Story ${storyId}`,
      "--acceptance", "The result is observable", "--phase", "design", "--status", "ready",
    ], project);
    mustRun([
      "contract", "create", "--root", project, "--phase", "design", "--story", storyId, "--id", `contract-${storyId}-design`,
      "--context-summary", "Design the story", "--qa", "Who approves?|Owner",
      "--output-ref", "functional-analysis:functional-analysis-v1:new", "--force",
    ], project);
    mustRun(["contract", "approve", "--root", project, "--id", `contract-${storyId}-design`, ...humanApproval("Approve the contract")], project);
    mustRun([
      "task", "start", "--root", project, "--story", storyId, "--intent-json", startIntent(storyId), "--confirm-start", "--actor-type", "human",
    ], project);
  }
}

function initializeRepository(project) {
  git(project, ["init", "--quiet"]);
  git(project, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  git(project, ["config", "user.name", "Claims E2E"]);
  git(project, ["config", "user.email", "claims-e2e@example.invalid"]);
  git(project, ["config", "commit.gpgSign", "false"]);
}

/**
 * One project shared by two computers: published to a bare repository that
 * stands in for the team's remote, and cloned into a second working copy.
 */
function sharedProject(label, storyIds = ["ST-1"], { before = null } = {}) {
  const first = temporaryDirectory(`${label}-first`);
  mustRun(["init", "--root", first, "--project-name", "Shared claims"], first);
  initializeRepository(first);
  prepareStories(first, storyIds);
  if (before) before(first);
  git(first, ["add", "-A"]);
  git(first, ["commit", "--quiet", "-m", "test: approved specs and breakdown"]);
  const remote = temporaryDirectory(`${label}-remote`);
  git(remote, ["init", "--quiet", "--bare"]);
  git(first, ["remote", "add", "origin", remote]);
  git(first, ["push", "--quiet", "origin", "main"]);
  const second = temporaryDirectory(`${label}-second`);
  fs.rmSync(second, { recursive: true, force: true });
  const cloned = spawnSync("git", ["clone", "--quiet", "--branch", "main", remote, second], { encoding: "utf8" });
  assert.equal(cloned.status, 0, cloned.stderr);
  git(second, ["config", "user.name", "Claims E2E"]);
  git(second, ["config", "user.email", "claims-e2e@example.invalid"]);
  return { first, second, remote };
}

function claim(project, storyId, agent, extra = []) {
  return ["story", "claim", "--root", project, "--id", storyId, "--agent", agent, "--branch", `feature/${storyId}`, ...extra];
}

/**
 * The ST-CAT-001 case: the story is planned on main, an agent on another
 * computer delivers it on its own branch with a commit that carries only
 * code, and a person merges the pull request on the hosting service. The
 * story's work records never reach main.
 */
function mergedWithoutRecords(label) {
  const { first, second, remote } = sharedProject(label, ["ST-CAT-001", "ST-CAT-002"]);
  git(first, ["remote", "set-head", "origin", "main"]);
  git(first, ["checkout", "--quiet", "-b", "feature/ST-CAT-001"]);
  fs.mkdirSync(path.join(first, "src"), { recursive: true });
  fs.writeFileSync(path.join(first, "src", "catalog.mjs"), "export const catalog = [];\n", "utf8");
  git(first, ["add", "src/catalog.mjs"]);
  git(first, ["-c", "user.name=agente-cat-001", "commit", "--quiet", "-m", "feat: catalog"]);
  git(first, ["checkout", "--quiet", "main"]);
  git(first, ["merge", "--quiet", "--no-ff", "-m", "Merge pull request #12 from travelops/feature/ST-CAT-001", "feature/ST-CAT-001"]);
  git(first, ["push", "--quiet", "origin", "main"]);
  git(second, ["pull", "--quiet", "--ff-only"]);
  git(second, ["remote", "set-head", "origin", "main"]);
  return { first, second, remote };
}

test("a story merged without its records is never ready, its claim is refused, and status says where its records are", () => {
  const { second } = mergedWithoutRecords("st-cat-001");
  assert.equal(fs.existsSync(path.join(second, ".sdlc", "stories", "ST-CAT-001", "claim.json")), false);

  const status = mustRunJson(["status", "--root", second], second);
  assert.deepEqual(status.work.ready_story_ids, ["ST-CAT-002"]);
  assert.equal(status.summary.merged_open_work, 1);
  assert.equal(status.merged_but_open[0].story_id, "ST-CAT-001");
  assert.equal(status.merged_but_open[0].records_absent, true);
  assert.deepEqual(status.merged_but_open[0].merged_by, { author: "agente-cat-001", branch: "feature/ST-CAT-001" });
  assert.doesNotMatch(JSON.stringify(status.capability_suggestion || {}), /ST-CAT-001/u);
  const lines = mustRun(["status", "--root", second], second).stdout;
  assert.match(lines, /ST-CAT-001: appears merged into main .* its work records are not on this branch.*from agente-cat-001's computer \(branch feature\/ST-CAT-001\)/u);
  assert.doesNotMatch(lines, /ST-CAT-001.*story complete-step/u);

  const orchestration = mustRunJson(["orchestrate", "status", "--root", second], second);
  assert.equal(orchestration.stories.find((story) => story.id === "ST-CAT-001").orchestration_state, "merged_open");
  assert.equal(orchestration.summary.merged_open, 1);
  assert.equal(orchestration.summary.available, 1);
  const plan = mustRunJson(["orchestrate", "plan", "--root", second], second);
  assert.deepEqual(plan.candidates.map((item) => item.story_id), ["ST-CAT-002"]);

  const refused = mustRefuseJson(claim(second, "ST-CAT-001", "bob"), second);
  assert.equal(refused.error.code, "STORY_ALREADY_MERGED");
  assert.match(refused.error.message, /already merged into main .* by agente-cat-001, branch feature\/ST-CAT-001/u);
  assert.equal(mustRunJson(claim(second, "ST-CAT-002", "bob"), second).claim.story_id, "ST-CAT-002");
});

test("the computer that did the work publishes the story's records as their own branch, and once merged every computer has them", () => {
  const { first, second } = sharedProject("publish-records", ["ST-CAT-001", "ST-CAT-002"]);
  git(first, ["remote", "set-head", "origin", "main"]);
  git(second, ["remote", "set-head", "origin", "main"]);
  mustRun(claim(first, "ST-CAT-001", "agente-cat-001"), first);
  git(first, ["checkout", "--quiet", "-b", "feature/ST-CAT-001"]);
  fs.mkdirSync(path.join(first, "src"), { recursive: true });
  fs.writeFileSync(path.join(first, "src", "catalog.mjs"), "export const catalog = [];\n", "utf8");
  git(first, ["add", "src/catalog.mjs"]);
  git(first, ["commit", "--quiet", "-m", "feat: catalog"]);
  git(first, ["push", "--quiet", "origin", "feature/ST-CAT-001"]);
  git(second, ["fetch", "--quiet", "origin"]);
  git(second, ["merge", "--quiet", "--no-ff", "-m", "Merge pull request #12 from travelops/feature/ST-CAT-001", "origin/feature/ST-CAT-001"]);
  git(second, ["push", "--quiet", "origin", "main"]);
  mustRun(["story", "release", "--root", first, "--id", "ST-CAT-001", "--reason", "Merged"], first);

  const before = git(first, ["status", "--porcelain"]);
  const published = mustRunJson(["story", "publish-records", "--root", first, "--id", "ST-CAT-001"], first);
  assert.equal(published.status, "published");
  assert.equal(published.branch, "sdlc-records/ST-CAT-001");
  assert.ok(published.published.includes(".sdlc/stories/ST-CAT-001/claim.json"), JSON.stringify(published.published));
  assert.equal(published.published.some((item) => item.includes("ST-CAT-002")), false);
  assert.equal(git(first, ["status", "--porcelain"]), before, "the checkout is not changed");
  assert.equal(git(first, ["rev-parse", "--abbrev-ref", "HEAD"]), "feature/ST-CAT-001");
  // Nothing new: publishing again leaves the branch where it is.
  assert.equal(mustRunJson(["story", "publish-records", "--root", first, "--id", "ST-CAT-001"], first).commit, published.commit);

  git(second, ["fetch", "--quiet", "origin"]);
  git(second, ["merge", "--quiet", "--no-ff", "-m", "Merge pull request #13 from travelops/sdlc-records/ST-CAT-001", "origin/sdlc-records/ST-CAT-001"]);
  git(second, ["push", "--quiet", "origin", "main"]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(second, ".sdlc", "stories", "ST-CAT-001", "claim.json"), "utf8")).status, "released");
  // The records now on main with the same bytes are not reported as missing, and nothing is created.
  const settled = mustRunJson(["story", "publish-records", "--root", first, "--id", "ST-CAT-001"], first);
  assert.equal(settled.status, "nothing_to_publish");
  assert.deepEqual(settled.skipped, []);
  assert.ok(settled.already_on_base.includes(".sdlc/stories/ST-CAT-001/claim.json"), JSON.stringify(settled));
  const status = mustRunJson(["status", "--root", second], second);
  assert.deepEqual(status.work.ready_story_ids, ["ST-CAT-002"]);
  assert.equal(status.merged_but_open[0].records_absent, undefined);
});
