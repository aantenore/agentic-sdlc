import "./helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { AGENT_HOSTS, AGENT_HOST_OVERRIDE_ENV } from "../lib/agent-host.mjs";
import { computeStableHash } from "../lib/canonical.mjs";
import { readTrackedSharedClaims } from "../lib/change-observatory/shared-claims.mjs";
import { interpretSharedClaimRecords } from "../lib/story-claim-shared-state.mjs";
import {
  claimLeaseEndMs,
  classifyClaimHealth,
  currentWaitRecord,
  evaluateWait,
  parseWaitCondition,
} from "../lib/story-wait-shared-state.mjs";

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
const PAST = "2020-01-01T00:00:00.000Z";
const PERSON = ["--actor-type", "human"];

after(() => {
  if (process.env.AGENTIC_SDLC_KEEP_TEST_TMP === "1") return;
  for (const directory of TEMPORARY) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
  TEMPORARY.clear();
});

function temporaryDirectory(label) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `agentic-sdlc-waits-${label}-`));
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

function mustRefuse(args, project) {
  const result = run([...args, "--json"], project);
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0, `${args.join(" ")} unexpectedly passed\n${result.stdout}`);
  return `${result.stdout}\n${result.stderr}`;
}

function git(directory, args, env = {}) {
  const result = spawnSync("git", ["-C", directory, ...args], { encoding: "utf8", timeout: 60_000, env: { ...process.env, ...env } });
  assert.equal(result.status, 0, `git ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
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
  git(project, ["config", "user.name", "Waits E2E"]);
  git(project, ["config", "user.email", "waits-e2e@example.invalid"]);
  git(project, ["config", "commit.gpgSign", "false"]);
}

function localProject(storyIds) {
  const project = temporaryDirectory("local");
  mustRun(["init", "--root", project, "--project-name", "Local waits"], project);
  initializeRepository(project);
  prepareStories(project, storyIds);
  git(project, ["add", "-A"]);
  git(project, ["commit", "--quiet", "-m", "test: approved specs"]);
  return project;
}

function sharedProject(label, storyIds) {
  const first = temporaryDirectory(`${label}-first`);
  mustRun(["init", "--root", first, "--project-name", "Shared waits"], first);
  initializeRepository(first);
  prepareStories(first, storyIds);
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
  git(second, ["config", "user.name", "Waits E2E"]);
  git(second, ["config", "user.email", "waits-e2e@example.invalid"]);
  return { first, second, remote };
}

function setOrchestration(project, policy) {
  const configPath = path.join(project, ".sdlc", "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.orchestration_policy = { ...config.orchestration_policy, ...policy };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  const preview = mustRunJson(["config", "migrate", "--root", project], project);
  mustRunJson(["config", "migrate", "--root", project, "--apply", "--plan-hash", preview.plan.plan_hash, "--actor-type", "human"], project);
}

function claim(project, storyId, agent, extra = []) {
  return ["story", "claim", "--root", project, "--id", storyId, "--agent", agent, "--branch", `feature/${storyId}`, ...extra];
}

function storyOf(project, storyId) {
  return mustRunJson(["orchestrate", "status", "--root", project], project).stories.find((story) => story.id === storyId);
}

test("wait conditions, leases, and claim health follow plain rules", () => {
  assert.deepEqual(parseWaitCondition("dep:ST-2"), { kind: "dep", target: "ST-2" });
  assert.deepEqual(parseWaitCondition("person:Which provider?"), { kind: "person", target: "Which provider?" });
  assert.ok(parseWaitCondition("pr:not-a-url").error);
  assert.ok(parseWaitCondition("ticket:1").error);
  const nowMs = Date.parse("2026-10-09T12:00:00.000Z");
  const hour = 3_600_000;
  // A push renews the lease for the claim time to live; stale_claim_after_seconds counts from that push too.
  assert.equal(claimLeaseEndMs({ expiresAt: PAST, lastActivityMs: nowMs - hour, ttlSeconds: 86_400 }), nowMs + 23 * hour);
  assert.equal(claimLeaseEndMs({ expiresAt: PAST, lastActivityMs: null, ttlSeconds: 86_400 }), Date.parse(PAST));
  assert.equal(claimLeaseEndMs({ expiresAt: null, claimedAt: PAST, lastActivityMs: nowMs - hour, ttlSeconds: 86_400, staleAfterSeconds: 7_200 }), nowMs + hour);
  const wait = { kind: "dep", target: "ST-2", until: new Date(nowMs + hour).toISOString() };
  assert.equal(evaluateWait(wait, { nowMs, resolve: () => "open" }).valid, true);
  assert.equal(evaluateWait(wait, { nowMs, resolve: () => "unknown" }).valid, true);
  assert.equal(evaluateWait(wait, { nowMs, resolve: () => "resolved" }).ended, "resolved");
  assert.equal(evaluateWait(wait, { nowMs: nowMs + 2 * hour }).ended, "expired");
  const health = (extra) => classifyClaimHealth({ claimedAt: PAST, leaseEndMs: nowMs + hour, lastActivityMs: nowMs - hour, idleAfterSeconds: 14_400, nowMs, ...extra });
  assert.equal(health({}), "active");
  assert.equal(health({ lastActivityMs: nowMs - 5 * hour }), "idle");
  assert.equal(health({ idleAfterSeconds: null, lastActivityMs: nowMs - 5 * hour }), "active");
  assert.equal(health({ leaseEndMs: nowMs - 1 }), "abandoned");
  assert.equal(health({ leaseEndMs: nowMs - 1, wait: { valid: true } }), "waiting");
  // The latest record of the current claim decides; another epoch's wait does not count.
  const records = [
    { id: "WAIT-a", action: "wait", on: { kind: "person", target: "q" }, until: "x", created_at: "2026-01-01T00:00:00Z", claim: { epoch: 1, claimant_id: "c1" } },
    { wait_id: "WAIT-b", action: "clear", created_at: "2026-01-02T00:00:00Z", epoch: 1, claimant_id: "c1" },
    { wait_id: "WAIT-c", action: "wait", on: { kind: "dep", target: "ST-9" }, until: "y", created_at: "2026-01-03T00:00:00Z", epoch: 2, claimant_id: "c2" },
  ];
  assert.equal(currentWaitRecord({ local: [records[0]], shared: [records[1], records[2]], claim: { epoch: 1, claimant_id: "c1" } }), null);
  assert.equal(currentWaitRecord({ local: [records[0]], shared: [], claim: { epoch: 1, claimant_id: "c1" } }).kind, "person");
  assert.equal(currentWaitRecord({ local: [], shared: records.slice(1), claim: { epoch: 2, claimant_id: "c2" } }).target, "ST-9");
});

test("a lapsed claim renewed by a push stays active; abandoned until a declared wait protects it", () => {
  const project = localProject(["ST-1", "ST-2"]);
  mustRunJson(claim(project, "ST-1", "alice", ["--expires-at", PAST]), project);

  // Lapsed, never pushed, no wait: abandoned, listed for a person's decision with the exact commands.
  let story = storyOf(project, "ST-1");
  assert.equal(story.orchestration_state, "stale");
  assert.equal(story.claim_health.state, "abandoned");
  const orchestration = mustRunJson(["orchestrate", "status", "--root", project], project);
  assert.equal(orchestration.summary.abandoned, 1);
  assert.equal(orchestration.claims_needing_decision[0].story_id, "ST-1");
  assert.match(orchestration.claims_needing_decision[0].commands[0], /story claim --id ST-1 --agent "<agent>" --force --reason "<why>" --actor-type human/u);
  assert.match(orchestration.claims_needing_decision[0].commands[1], /story park --id ST-1 --reason "<why>" --actor-type human/u);
  const status = mustRunJson(["status", "--root", project], project, { AGENTIC_SDLC_STATUS_SYNC: "off" });
  assert.equal(status.summary.abandoned_claims, 1);
  assert.equal(status.claims_needing_decision[0].story_id, "ST-1");
  assert.match(mustRun(["orchestrate", "status", "--root", project], project).stdout, /Needs a person's decision/u);
  assert.match(mustRun(["status", "--root", project, "--locale", "it"], project, { AGENTIC_SDLC_STATUS_SYNC: "off" }).stdout, /Serve la decisione di una persona/u);
  // Nothing was released by itself.
  assert.equal(JSON.parse(fs.readFileSync(path.join(project, ".sdlc", "stories", "ST-1", "claim.json"), "utf8")).status, "active");

  // A commit on the claim's branch renews the lease: the work is not abandoned.
  git(project, ["branch", "feature/ST-1"]);
  story = storyOf(project, "ST-1");
  assert.equal(story.orchestration_state, "claimed");
  assert.equal(story.claim_health.state, "active");
  assert.ok(story.claim_health.last_activity_at);
  assert.ok(Date.parse(story.claim_health.lease_expires_at) > Date.now());
  git(project, ["branch", "-D", "feature/ST-1"]);
  assert.equal(storyOf(project, "ST-1").claim_health.state, "abandoned");

  // Only the holder of an active claim declares a wait, with a readable condition and a future end.
  assert.match(mustRefuse(["story", "wait", "--root", project, "--id", "ST-2", "--on", "dep:ST-1", "--until", "1d"], project), /no active claim/u);
  assert.match(mustRefuse(["story", "wait", "--root", project, "--id", "ST-1", "--on", "ticket:9", "--until", "1d"], project), /--on must be/u);
  assert.match(mustRefuse(["story", "wait", "--root", project, "--id", "ST-1", "--on", "dep:ST-1", "--until", "1d"], project), /cannot wait on itself/u);
  assert.match(mustRefuse(["story", "wait", "--root", project, "--id", "ST-1", "--on", "dep:ST-2", "--until", PAST], project), /end in the future/u);

  const waited = mustRunJson(["story", "wait", "--root", project, "--id", "ST-1", "--on", "dep:ST-2", "--until", "3d", "--reason", "Needs the API of ST-2"], project);
  assert.equal(waited.status, "waiting");
  assert.equal(waited.shared_wait.status, "local");
  assert.ok(fs.existsSync(waited.wait_path));
  story = storyOf(project, "ST-1");
  assert.equal(story.orchestration_state, "claimed");
  assert.equal(story.claim_health.state, "waiting");
  assert.equal(story.claim_health.wait.kind, "dep");
  assert.equal(story.claim_health.wait.target, "ST-2");
  assert.equal(mustRunJson(["orchestrate", "status", "--root", project], project).summary.waiting, 1);
  assert.match(mustRun(["orchestrate", "status", "--root", project], project).stdout, /ST-1: claimed by alice on feature\/ST-1 .*waiting on story ST-2 since .* until /u);
  const trace = fs.readFileSync(path.join(project, ".sdlc", "traces", "ST-1.jsonl"), "utf8");
  assert.match(trace, /"action":"story.wait"/u);

  // Clearing the wait leaves the lapsed claim to a person again.
  assert.equal(mustRunJson(["story", "wait", "--root", project, "--id", "ST-1", "--clear"], project).status, "cleared");
  assert.equal(storyOf(project, "ST-1").claim_health.state, "abandoned");
  assert.equal(mustRunJson(["story", "wait", "--root", project, "--id", "ST-1", "--clear"], project).status, "no_wait");
  mustRun(["trace", "verify", "--root", project], project);
});

test("a claim with no push for idle_after_seconds is idle; explicit null turns the notice off", () => {
  const project = localProject(["ST-1"]);
  mustRunJson(claim(project, "ST-1", "alice"), project);
  const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
  git(project, ["checkout", "--quiet", "-b", "feature/ST-1"]);
  fs.writeFileSync(path.join(project, "work.txt"), "wip\n", "utf8");
  git(project, ["add", "work.txt"]);
  git(project, ["commit", "--quiet", "-m", "wip"], { GIT_COMMITTER_DATE: twoHoursAgo, GIT_AUTHOR_DATE: twoHoursAgo });
  git(project, ["checkout", "--quiet", "main"]);
  setOrchestration(project, { claim_activity: { mode: "git", idle_after_seconds: 3600 } });
  const story = storyOf(project, "ST-1");
  assert.equal(story.orchestration_state, "claimed");
  assert.equal(story.claim_health.state, "idle");
  assert.match(mustRun(["orchestrate", "status", "--root", project], project).stdout, /idle: no push since /u);
  setOrchestration(project, { claim_activity: { mode: "git", idle_after_seconds: null } });
  assert.equal(storyOf(project, "ST-1").claim_health.state, "active");
});

test("a wait shared through the remote protects the claim on every computer, read with the same single listing", () => {
  const { first, second, remote } = sharedProject("shared", ["ST-1", "ST-2"]);
  mustRunJson(claim(first, "ST-1", "alice", ["--expires-at", PAST]), first);
  let story = storyOf(second, "ST-1");
  assert.equal(story.orchestration_state, "stale");
  assert.equal(story.claim_health.state, "abandoned");
  assert.equal(story.claim_health.here, false);

  // Another computer cannot declare a wait on a claim it does not hold.
  assert.match(mustRefuse(["story", "wait", "--root", second, "--id", "ST-1", "--on", "person:Which provider?", "--until", "2d"], second), /no active claim/u);

  const waited = mustRunJson(["story", "wait", "--root", first, "--id", "ST-1", "--on", "person:Which payment provider?", "--until", "2d"], first);
  assert.equal(waited.shared_wait.status, "shared");
  assert.match(waited.shared_wait.ref, /^refs\/agentic-sdlc\/waits\/ST-1\/000001\/WAIT-/u);
  const waitRefs = git(remote, ["for-each-ref", "--format=%(refname)", "refs/agentic-sdlc/waits/"]).split("\n").filter(Boolean);
  assert.equal(waitRefs.length, 1);
  // Plugins that predate waits list only the claims: the wait is invisible to them and leaves the claims trustworthy.
  const claimRefs = git(remote, ["for-each-ref", "--format=%(refname)", "refs/agentic-sdlc/claims/"]).split("\n").filter(Boolean);
  assert.ok(claimRefs.every((ref) => !ref.includes("WAIT-")));
  const records = claimRefs.map((ref) => ({ ref, message: git(remote, ["log", "-1", "--format=%B", ref]) }));
  assert.deepEqual(interpretSharedClaimRecords(records).stories.get("ST-1").problems, []);

  const traceFile = path.join(temporaryDirectory("trace"), "git-trace.txt");
  const orchestration = mustRunJson(["orchestrate", "status", "--root", second], second, { GIT_TRACE: traceFile });
  const listings = fs.readFileSync(traceFile, "utf8").split("\n").filter((line) => /built-in: git .*\bls-remote\b/u.test(line));
  assert.equal(listings.length, 1, listings.join("\n"));
  story = orchestration.stories.find((item) => item.id === "ST-1");
  assert.equal(story.orchestration_state, "claimed");
  assert.equal(story.shared_claim.state, "claimed");
  assert.deepEqual(story.shared_claim.problems, []);
  assert.equal(story.claim_health.state, "waiting");
  assert.equal(story.claim_health.wait.kind, "person");
  assert.equal(story.claim_health.wait.source, "remote");
  const status = mustRunJson(["status", "--root", second], second, { AGENTIC_SDLC_STATUS_SYNC: "off" });
  assert.equal(status.shared_claims.claims.find((item) => item.story_id === "ST-1").health.state, "waiting");
  assert.equal(status.claims_needing_decision, undefined);
  // The Observatory reads the same health from what this clone last saw, without the network.
  const observed = readTrackedSharedClaims(second).claims.find((item) => item.storyId === "ST-1");
  assert.equal(observed.health, "waiting");
  assert.equal(observed.wait.kind, "person");
  const plan = mustRunJson(["orchestrate", "plan", "--root", second], second);
  assert.deepEqual(plan.candidates.map((item) => item.story_id), ["ST-2"]);

  // Cleared, then renewed by pushing the claim's branch: active on the other computer once it fetched it.
  assert.equal(mustRunJson(["story", "wait", "--root", first, "--id", "ST-1", "--clear"], first).shared_wait.status, "shared");
  assert.equal(storyOf(second, "ST-1").claim_health.state, "abandoned");
  git(first, ["checkout", "--quiet", "-b", "feature/ST-1"]);
  fs.writeFileSync(path.join(first, "work.txt"), "wip\n", "utf8");
  git(first, ["add", "work.txt"]);
  git(first, ["commit", "--quiet", "-m", "wip: first slice"]);
  git(first, ["push", "--quiet", "origin", "feature/ST-1"]);
  git(second, ["fetch", "--quiet", "origin"]);
  story = storyOf(second, "ST-1");
  assert.equal(story.orchestration_state, "claimed");
  assert.equal(story.claim_health.state, "active");
  assert.ok(story.claim_health.last_activity_at);
});

test("story park --review-at lists the parked story to review once that time passes", () => {
  const project = localProject(["ST-1"]);
  mustRunJson(claim(project, "ST-1", "alice"), project);
  assert.match(mustRefuse(["story", "park", "--root", project, "--id", "ST-1", "--reason", "x", "--review-at", PAST, ...PERSON], project), /review-at must be in the future/u);
  const parked = mustRunJson(["story", "park", "--root", project, "--id", "ST-1", "--reason", "Waiting for the legal review", "--review-at", "3d", ...PERSON], project);
  assert.ok(parked.parking.review_at);
  let story = storyOf(project, "ST-1");
  assert.equal(story.orchestration_state, "parked");
  assert.equal(story.parked.to_review, false);
  assert.equal(mustRunJson(["status", "--root", project], project, { AGENTIC_SDLC_STATUS_SYNC: "off" }).parked_to_review, undefined);

  // The review time passed (rewritten and resealed here to stand in for three days).
  const record = JSON.parse(fs.readFileSync(parked.parking_path, "utf8"));
  const { record_hash: _hash, ...content } = record;
  const rewritten = { ...content, review_at: PAST };
  fs.writeFileSync(parked.parking_path, `${JSON.stringify({ ...rewritten, record_hash: computeStableHash(rewritten) }, null, 2)}\n`, "utf8");
  story = storyOf(project, "ST-1");
  assert.equal(story.parked.to_review, true);
  const status = mustRunJson(["status", "--root", project], project, { AGENTIC_SDLC_STATUS_SYNC: "off" });
  assert.equal(status.parked_to_review[0].story_id, "ST-1");
  assert.match(status.parked_to_review[0].command, /story resume --id ST-1/u);
  assert.match(mustRun(["orchestrate", "status", "--root", project], project).stdout, /To review: ST-1, parked since /u);
});
