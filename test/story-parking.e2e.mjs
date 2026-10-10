import "./helpers/test-isolation.mjs";

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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `agentic-sdlc-parking-${label}-`));
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

/** Changes the orchestration setting the way a person would: edit, then confirm the configuration. */
function setOrchestration(project, policy) {
  const configPath = path.join(project, ".sdlc", "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.orchestration_policy = {
    ...config.orchestration_policy,
    ...policy,
    coordination: { ...config.orchestration_policy?.coordination, ...policy.coordination },
  };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  const preview = mustRunJson(["config", "migrate", "--root", project], project);
  mustRunJson(["config", "migrate", "--root", project, "--apply", "--plan-hash", preview.plan.plan_hash, "--actor-type", "human"], project);
}

function claim(project, storyId, agent, extra = []) {
  return ["story", "claim", "--root", project, "--id", storyId, "--agent", agent, "--branch", `feature/${storyId}`, ...extra];
}

function localProject(storyIds) {
  const project = temporaryDirectory("local");
  mustRun(["init", "--root", project, "--project-name", "Local parking"], project);
  initializeRepository(project);
  prepareStories(project, storyIds);
  return project;
}

const PERSON = ["--actor-type", "human"];

test("a person parks a stuck story: its claim is released, every computer skips it, and story resume brings it back", () => {
  const { first, second, remote } = sharedProject("park", ["ST-1", "ST-2"]);
  mustRunJson(claim(first, "ST-1", "alice"), first);

  // An agent alone cannot park; inside an agent's session it needs the user's explicit request.
  assert.notEqual(run(["story", "park", "--root", first, "--id", "ST-1", "--reason", "x", "--json"], first).status, 0);
  const agentSession = { [SESSION_MARKERS[0]]: "1" };
  assert.match(
    mustRefuseJson(["story", "park", "--root", first, "--id", "ST-1", "--reason", "x", ...PERSON], first, agentSession).error.message,
    /only when the user asked/u,
  );

  const parked = mustRunJson(["story", "park", "--root", first, "--id", "ST-1", "--reason", "Merge conflict on the shared module", ...PERSON], first);
  assert.equal(parked.status, "parked");
  assert.equal(parked.released_claim.agent, "alice");
  assert.equal(parked.shared_parking.status, "shared");
  assert.equal(parked.shared_parking.epoch, 2);
  assert.equal(parked.next_story.story_id, "ST-2");
  assert.equal(claimFile(first, "ST-1").status, "released");
  const record = remoteRecord(remote, "refs/agentic-sdlc/claims/ST-1/000002/claim");
  assert.equal(record.reservation, true);
  assert.equal(record.expires_at, null);
  assert.equal(record.parked.reason, "Merge conflict on the shared module");
  assert.equal(remoteRecord(remote, "refs/agentic-sdlc/claims/ST-1/000001/release").status, "released");
  assert.equal(mustRunJson(["story", "park", "--root", first, "--id", "ST-1", "--reason", "again", ...PERSON], first).status, "already_parked");

  for (const project of [first, second]) {
    const orchestration = mustRunJson(["orchestrate", "status", "--root", project], project);
    const story = orchestration.stories.find((item) => item.id === "ST-1");
    assert.equal(story.orchestration_state, "parked");
    assert.equal(story.parked.reason, "Merge conflict on the shared module");
    assert.equal(orchestration.summary.parked, 1);
    const plan = mustRunJson(["orchestrate", "plan", "--root", project], project);
    assert.deepEqual(plan.candidates.map((item) => item.story_id), ["ST-2"]);
    assert.equal(mustRefuseJson(claim(project, "ST-1", "bob"), project).error.code, "STORY_PARKED");
  }
  assert.match(mustRun(["orchestrate", "status", "--root", second, "--locale", "it"], second).stdout, /ST-1: parcheggiata da una persona/u);
  assert.equal(mustRunJson(["status", "--root", second], second, { AGENTIC_SDLC_STATUS_SYNC: "off" }).summary.parked_work, 1);
  assert.equal(mustRefuseJson(["story", "release", "--root", first, "--id", "ST-1"], first).error.code, "STORY_PARKED");
  assert.equal(mustRefuseJson(["story", "reserve", "--root", second, "--id", "ST-1", "--agent", "bob"], second).error.code, "STORY_PARKED");

  // Resumed from the other computer: the first one sees it free before the resume record arrives.
  const resumed = mustRunJson(["story", "resume", "--root", second, "--id", "ST-1", "--reason", "Conflict solved", ...PERSON], second);
  assert.equal(resumed.status, "resumed");
  assert.equal(resumed.shared_resume.status, "released");
  assert.equal(mustRunJson(["orchestrate", "status", "--root", first], first).stories.find((item) => item.id === "ST-1").orchestration_state, "available");
  const reclaimed = mustRunJson(claim(first, "ST-1", "alice"), first);
  assert.equal(reclaimed.shared_claim.epoch, 3);
  assert.equal(mustRunJson(["story", "resume", "--root", first, "--id", "ST-1", "--reason", "Records catch up", ...PERSON], first).status, "resumed");
});

test("on a project without a shared remote the park is kept in the project records", () => {
  const project = localProject(["ST-1", "ST-2"]);
  mustRunJson(claim(project, "ST-1", "alice"), project);
  const parked = mustRunJson(["story", "park", "--root", project, "--id", "ST-1", "--reason", "Blocked by an outage", ...PERSON], project);
  assert.equal(parked.shared_parking.status, "local");
  assert.equal(claimFile(project, "ST-1").status, "released");
  assert.equal(mustRefuseJson(claim(project, "ST-1", "alice"), project).error.code, "STORY_PARKED");
  assert.equal(mustRunJson(["orchestrate", "status", "--root", project], project).stories.find((item) => item.id === "ST-1").orchestration_state, "parked");
  assert.ok(fs.existsSync(path.join(project, ".sdlc", "compatibility")), "older plugins are asked to update");
  const trace = fs.readFileSync(path.join(project, ".sdlc", "traces", "ST-1.jsonl"), "utf8");
  assert.match(trace, /"action":"story.park"/u);
  mustRunJson(["story", "resume", "--root", project, "--id", "ST-1", "--reason", "Outage over", ...PERSON], project);
  assert.equal(mustRunJson(["orchestrate", "status", "--root", project], project).stories.find((item) => item.id === "ST-1").orchestration_state, "available");
  mustRunJson(claim(project, "ST-1", "alice"), project);
  mustRun(["trace", "verify", "--root", project], project);
});
