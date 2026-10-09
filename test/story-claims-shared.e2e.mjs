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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `agentic-sdlc-claims-${label}-`));
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
      "story", "create", "--root", project, "--id", storyId, "--title", `Story ${storyId}`,
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

test("two computers claiming the same story at the same moment: exactly one wins", async () => {
  const { first, second, remote } = sharedProject("race", ["ST-1", "ST-2"]);
  for (const storyId of ["ST-1", "ST-2"]) {
    const results = await Promise.all([
      runAsync([...claim(first, storyId, "alice"), "--json"], first),
      runAsync([...claim(second, storyId, "bob"), "--json"], second),
    ]);
    const winners = results.filter((result) => result.status === 0);
    const losers = results.filter((result) => result.status !== 0);
    assert.equal(winners.length, 1, results.map((result) => `${result.stdout}${result.stderr}`).join("\n"));
    assert.equal(losers.length, 1);
    const refusal = JSON.parse(losers[0].stdout || losers[0].stderr);
    assert.equal(refusal.error.code, "STORY_CLAIM_HELD_ELSEWHERE", JSON.stringify(refusal));
    const winner = JSON.parse(winners[0].stdout);
    assert.equal(winner.shared_claim.epoch, 1);
    const loserCopy = results[0].status === 0 ? second : first;
    assert.equal(claimFile(loserCopy, storyId), null, "the losing computer wrote no claim");
  }
  assert.deepEqual(remoteClaimRefs(remote), [
    "refs/agentic-sdlc/claims/ST-1/000001/claim",
    "refs/agentic-sdlc/claims/ST-2/000001/claim",
  ]);
});

test("a released story can be claimed again, and a release made offline is shared later", () => {
  const { first, second, remote } = sharedProject("release");
  const claimed = mustRunJson(claim(first, "ST-1", "alice"), first);
  assert.equal(claimed.claim.shared_claim.epoch, 1);
  assert.match(claimed.claim.shared_claim.claimant_id, /^CLM-/u);
  const record = remoteRecord(remote, "refs/agentic-sdlc/claims/ST-1/000001/claim");
  assert.equal(record.story_id, "ST-1");
  assert.equal(record.agent, "alice");
  assert.equal(record.branch, "feature/ST-1");
  assert.equal(record.claimant_id, claimed.claim.shared_claim.claimant_id);
  assert.equal(record.contract.id, "contract-ST-1-design");
  assert.match(record.task_start.hash, /^[a-f0-9]{64}$/u);

  const held = mustRefuseJson(claim(second, "ST-1", "bob"), second);
  assert.equal(held.error.code, "STORY_CLAIM_HELD_ELSEWHERE");
  assert.match(held.error.message, /alice on branch feature\/ST-1, since /u);

  const released = mustRunJson(["story", "release", "--root", first, "--id", "ST-1", "--reason", "Design finished"], first);
  assert.equal(released.shared_release.status, "shared");
  const reclaimed = mustRunJson(claim(second, "ST-1", "bob"), second);
  assert.equal(reclaimed.claim.shared_claim.epoch, 2);

  // The second computer releases while the remote is away: the story stays reserved for everyone else.
  fs.renameSync(remote, `${remote}-away`);
  const offline = mustRunJson(["story", "release", "--root", second, "--id", "ST-1", "--reason", "Pausing"], second);
  assert.equal(offline.claim.status, "released");
  assert.equal(offline.shared_release.status, "not_shared");
  assert.doesNotMatch(JSON.stringify(offline.shared_release), new RegExp(path.basename(remote), "u"));
  fs.renameSync(`${remote}-away`, remote);
  assert.equal(mustRefuseJson(claim(first, "ST-1", "alice"), first).error.code, "STORY_CLAIM_HELD_ELSEWHERE");
  const synced = mustRunJson(["story", "release", "--root", second, "--id", "ST-1"], second);
  assert.equal(synced.already_released, true);
  assert.equal(synced.shared_release.status, "shared");
  assert.equal(mustRunJson(claim(first, "ST-1", "alice"), first).claim.shared_claim.epoch, 3);
  assert.deepEqual(remoteClaimRefs(remote), [
    "refs/agentic-sdlc/claims/ST-1/000001/claim",
    "refs/agentic-sdlc/claims/ST-1/000001/release",
    "refs/agentic-sdlc/claims/ST-1/000002/claim",
    "refs/agentic-sdlc/claims/ST-1/000002/release",
    "refs/agentic-sdlc/claims/ST-1/000003/claim",
  ]);
});

test("taking over a story held elsewhere needs a person and a reason, and the previous holder sees it", () => {
  const { first, second, remote } = sharedProject("takeover");
  mustRunJson(claim(first, "ST-1", "alice"), first);
  for (const marker of SESSION_MARKERS) {
    const inside = mustRefuseJson(
      claim(second, "ST-1", "bob", ["--force", "--reason", "Alice is away", "--actor-type", "human"]),
      second,
      { [marker]: "1" },
    );
    assert.equal(inside.error.code, "STORY_CLAIM_TAKEOVER_NEEDS_PERSON", marker);
    assert.match(inside.error.message, /in their own terminal/u);
  }
  assert.match(
    mustRefuseJson(claim(second, "ST-1", "bob", ["--force", "--reason", "Alice is away"]), second).error.message,
    /requires --actor-type human/u,
  );
  assert.match(
    mustRefuseJson(claim(second, "ST-1", "bob", ["--force", "--actor-type", "human"]), second).error.message,
    /requires --reason/u,
  );
  assert.equal(claimFile(second, "ST-1"), null);

  const taken = mustRunJson(claim(second, "ST-1", "bob", ["--force", "--reason", "Alice is away", "--actor-type", "human"]), second);
  assert.equal(taken.shared_claim.epoch, 2);
  assert.equal(taken.shared_claim.took_over.agent, "alice");
  assert.equal(taken.claim.shared_claim.takeover_of.reason, "Alice is away");
  assert.equal(taken.trace_event.action, "story.claim");
  assert.match(taken.trace_event.summary, /taking over the claim of alice/u);
  const release = remoteRecord(remote, "refs/agentic-sdlc/claims/ST-1/000001/release");
  assert.equal(release.status, "taken_over");
  assert.equal(release.reason, "Alice is away");
  assert.equal(release.taken_over_by.agent, "bob");
  assert.equal(release.released_by.actor.type, "human");

  // The previous holder sees the takeover and cannot release the story again.
  const status = mustRunJson(["orchestrate", "status", "--root", first], first);
  const story = status.stories.find((item) => item.id === "ST-1");
  assert.equal(story.orchestration_state, "claimed");
  assert.equal(story.shared_claim.here, false);
  assert.equal(story.shared_claim.holder.agent, "bob");
  assert.equal(story.shared_claim.ended_here.status, "taken_over");
  assert.equal(story.shared_claim.ended_here.reason, "Alice is away");
  assert.match(mustRun(["orchestrate", "status", "--root", first], first).stdout, /ST-1: your claim was taken over by bob on branch feature\/ST-1 at .*\(Alice is away\)/u);
  assert.match(
    mustRun(["orchestrate", "status", "--root", first, "--locale", "it"], first).stdout,
    /ST-1: la tua assegnazione è stata rilevata da bob sul branch feature\/ST-1/u,
  );
  const releasedByHolder = mustRunJson(["story", "release", "--root", first, "--id", "ST-1"], first);
  assert.equal(releasedByHolder.shared_release.status, "taken_over");
  assert.equal(releasedByHolder.shared_release.taken_over_by.agent, "bob");
  assert.equal(remoteClaimRefs(remote).length, 3);
});

test("orchestrate status and status show the claims of every computer with one remote listing", () => {
  const { first, second } = sharedProject("status", ["ST-1", "ST-2", "ST-3"]);
  mustRunJson(claim(first, "ST-1", "alice"), first);
  mustRunJson(claim(first, "ST-2", "alice", ["--expires-at", "2020-01-01T00:00:00.000Z"]), first);

  const traceFile = path.join(temporaryDirectory("status-trace"), "git-trace.txt");
  const status = mustRunJson(["orchestrate", "status", "--root", second], second, { GIT_TRACE: traceFile });
  const listings = fs.readFileSync(traceFile, "utf8").split("\n").filter((line) => /built-in: git .*\bls-remote\b/u.test(line));
  assert.equal(listings.length, 1, listings.join("\n"));
  assert.equal(status.shared_claims.scope, "shared");
  assert.equal(status.shared_claims.checked, true);
  const byId = Object.fromEntries(status.stories.map((story) => [story.id, story]));
  assert.equal(byId["ST-1"].orchestration_state, "claimed");
  assert.equal(byId["ST-1"].shared_claim.holder.agent, "alice");
  assert.equal(byId["ST-2"].orchestration_state, "stale");
  assert.equal(byId["ST-3"].orchestration_state, "available");
  assert.deepEqual(status.summary.available, 1);

  const plan = mustRunJson(["orchestrate", "plan", "--root", second], second);
  assert.deepEqual(plan.candidates.map((candidate) => candidate.story_id), ["ST-3"]);

  const projectStatus = mustRunJson(["status", "--root", second], second);
  assert.equal(projectStatus.summary.active_work, 1);
  assert.equal(projectStatus.summary.stale_claims, 1);
  assert.deepEqual(projectStatus.shared_claims.claims.map((item) => [item.story_id, item.state, item.here]), [
    ["ST-1", "claimed", false],
    ["ST-2", "stale", false],
  ]);
  assert.equal(projectStatus.next_action.reason, "stale_shared_claim");
  assert.match(projectStatus.next_action.command, /story claim --id ST-2 --agent "<agent>" --force --reason "<why>" --actor-type human/u);
  const human = mustRun(["status", "--root", second], second).stdout;
  assert.match(human, /Shared claims through 'origin': 2 on other computers/u);
  assert.match(human, /ST-1: alice on branch feature\/ST-1 since /u);

  // The holder sees its own claims as held here.
  const holder = mustRunJson(["orchestrate", "status", "--root", first], first);
  assert.equal(holder.stories.find((story) => story.id === "ST-1").shared_claim.here, true);
});

test("an unreachable remote refuses the claim; local_only and a project without git claim on this computer", () => {
  const { first, remote } = sharedProject("offline");
  fs.renameSync(remote, `${remote}-away`);
  const refused = mustRefuseJson(claim(first, "ST-1", "alice"), first);
  assert.equal(refused.error.code, "STORY_CLAIM_REMOTE_UNAVAILABLE");
  assert.match(refused.error.message, /claims are shared through the git remote 'origin'/u);
  assert.match(refused.error.message, /local_only/u);
  assert.doesNotMatch(refused.error.message, new RegExp(path.basename(remote), "u"), "no local path or address is echoed");
  assert.equal(refused.human_guidance.details.remote, "origin");
  assert.equal(claimFile(first, "ST-1"), null);
  const status = mustRunJson(["orchestrate", "status", "--root", first], first);
  assert.equal(status.shared_claims.checked, false);
  assert.equal(status.stories[0].orchestration_state, "available");

  setOrchestration(first, { coordination: { mode: "local_only" } });
  const local = mustRunJson(claim(first, "ST-1", "alice"), first);
  assert.equal(local.claim.shared_claim, undefined);
  assert.equal(local.shared_claim, undefined);
  fs.renameSync(`${remote}-away`, remote);
  assert.deepEqual(remoteClaimRefs(remote), []);

  const required = temporaryDirectory("required");
  mustRun(["init", "--root", required, "--project-name", "Required sharing"], required);
  initializeRepository(required);
  prepareStories(required, ["ST-1"]);
  setOrchestration(required, { coordination: { mode: "required" } });
  assert.match(mustRefuseJson(claim(required, "ST-1", "alice"), required).error.message, /the git remote 'origin' is not configured/u);

  const noGit = temporaryDirectory("no-git");
  mustRun(["init", "--root", noGit, "--project-name", "No git"], noGit);
  prepareStories(noGit, ["ST-1"]);
  const claimedWithoutGit = mustRunJson(claim(noGit, "ST-1", "alice"), noGit);
  assert.equal(claimedWithoutGit.claim.shared_claim, undefined);
  assert.equal(mustRunJson(["story", "release", "--root", noGit, "--id", "ST-1"], noGit).shared_release, undefined);
});

test("a claim file that arrives with git never makes another computer's claim one's own", () => {
  const { first, second, remote } = sharedProject("copied-claim");
  mustRunJson(claim(first, "ST-1", "alice"), first);
  // The holder commits its claim file on the story branch; the other computer checks that branch out.
  git(first, ["checkout", "--quiet", "-b", "feature/ST-1"]);
  git(first, ["add", "-A"]);
  git(first, ["commit", "--quiet", "-m", "feat: claim ST-1"]);
  git(first, ["push", "--quiet", "origin", "feature/ST-1"]);
  git(second, ["fetch", "--quiet", "origin", "feature/ST-1"]);
  git(second, ["checkout", "--quiet", "-b", "feature/ST-1", "FETCH_HEAD"]);
  assert.equal(claimFile(second, "ST-1").status, "active");
  const before = fs.readFileSync(path.join(second, ".sdlc", "stories", "ST-1", "claim.json"));

  for (const marker of SESSION_MARKERS) {
    const inside = mustRefuseJson(["story", "release", "--root", second, "--id", "ST-1", "--reason", "Done", "--actor-type", "human"], second, { [marker]: "1" });
    assert.equal(inside.error.code, "STORY_CLAIM_TAKEOVER_NEEDS_PERSON", marker);
  }
  assert.match(mustRefuseJson(["story", "release", "--root", second, "--id", "ST-1", "--reason", "Done"], second).error.message, /requires --actor-type human/u);
  assert.match(mustRefuseJson(["story", "release", "--root", second, "--id", "ST-1", "--actor-type", "human"], second).error.message, /requires --reason/u);
  assert.match(
    mustRefuseJson(claim(second, "ST-1", "bob", ["--force", "--actor-type", "human"]), second).error.message,
    /requires --reason/u,
  );
  assert.deepEqual(fs.readFileSync(path.join(second, ".sdlc", "stories", "ST-1", "claim.json")), before, "nothing was written here");
  assert.deepEqual(remoteClaimRefs(remote), ["refs/agentic-sdlc/claims/ST-1/000001/claim"], "nothing was released on the remote");
  const view = mustRunJson(["orchestrate", "status", "--root", second], second).stories[0];
  assert.equal(view.shared_claim.here, false, "the copied claim file is not this computer's claim");

  // A person may release it from here, with a reason; the record names who released it.
  const released = mustRunJson(["story", "release", "--root", second, "--id", "ST-1", "--reason", "Alice's laptop is gone", "--actor-type", "human", "--actor", "carol"], second);
  assert.equal(released.shared_release.status, "shared");
  const release = remoteRecord(remote, "refs/agentic-sdlc/claims/ST-1/000001/release");
  assert.equal(release.reason, "Alice's laptop is gone");
  assert.deepEqual(release.released_by.actor, { id: "carol", type: "human" });
  assert.equal(release.released_by.agent, null);
});

test("a claim push whose answer is lost is recognised, and an interrupted claim is cleaned up on retry", () => {
  const { first, remote } = sharedProject("lost-answer", ["ST-1", "ST-2"]);
  setOrchestration(first, { coordination: { timeout_seconds: 6 } });
  const hook = path.join(remote, "hooks", "post-receive");

  // The ref is created, then the remote stops answering: the claim is still recognised as made.
  fs.writeFileSync(hook, "#!/bin/sh\ncase \"$(cat)\" in *refs/agentic-sdlc/claims/*) sleep 20;; esac\n", { mode: 0o755 });
  const kept = mustRunJson(claim(first, "ST-1", "alice"), first);
  assert.equal(kept.claim.shared_claim.epoch, 1);
  assert.equal(remoteRecord(remote, "refs/agentic-sdlc/claims/ST-1/000001/claim").claimant_id, kept.claim.shared_claim.claimant_id);

  // The ref is created, then the remote stops being a repository: the outcome is unknown and the
  // message says so. Moving HEAD aside (rather than the whole directory, which Windows keeps
  // locked while the hook runs in it) is enough for every later read to fail.
  fs.writeFileSync(hook, "#!/bin/sh\ncase \"$(cat)\" in *refs/agentic-sdlc/claims/ST-2/*) mv HEAD HEAD-away; sleep 20;; esac\n", { mode: 0o755 });
  const unclear = mustRefuseJson(claim(first, "ST-2", "alice"), first);
  assert.equal(unclear.error.code, "STORY_CLAIM_REMOTE_UNAVAILABLE");
  assert.match(unclear.error.message, /may have reached the remote/u);
  assert.match(unclear.human_guidance.protection_boundary, /may have reached the remote/u);
  assert.equal(claimFile(first, "ST-2"), null);
  fs.renameSync(path.join(remote, "HEAD-away"), path.join(remote, "HEAD"));
  fs.rmSync(hook);
  assert.deepEqual(remoteClaimRefs(remote).filter((ref) => ref.includes("/ST-2/")), ["refs/agentic-sdlc/claims/ST-2/000001/claim"]);

  // The retry recognises its own orphan, releases it as cancelled, and claims again.
  const retried = mustRunJson(claim(first, "ST-2", "alice"), first);
  assert.equal(retried.claim.shared_claim.epoch, 2);
  assert.equal(remoteRecord(remote, "refs/agentic-sdlc/claims/ST-2/000001/release").status, "cancelled");
});

test("pointing the remote elsewhere starts a fresh view instead of reporting every record as gone", () => {
  const { first } = sharedProject("repointed");
  mustRunJson(claim(first, "ST-1", "alice"), first);
  mustRunJson(["story", "release", "--root", first, "--id", "ST-1", "--reason", "Moving remotes"], first);
  const replacement = temporaryDirectory("repointed-replacement");
  git(replacement, ["init", "--quiet", "--bare"]);
  git(first, ["remote", "set-url", "origin", replacement]);
  git(first, ["push", "--quiet", "origin", "main"]);
  const status = mustRunJson(["orchestrate", "status", "--root", first], first);
  assert.deepEqual(status.stories[0].shared_claim.problems, []);
  assert.equal(status.stories[0].orchestration_state, "available");
  const claimed = mustRunJson(claim(first, "ST-1", "alice"), first);
  assert.equal(claimed.claim.shared_claim.epoch, 1);
  assert.deepEqual(remoteClaimRefs(replacement), ["refs/agentic-sdlc/claims/ST-1/000001/claim"]);
});

test("another worktree of the same clone, or a claim file gone after a branch switch, never cancels a recorded claim", () => {
  const { first, remote } = sharedProject("worktrees");
  const claimed = mustRunJson(claim(first, "ST-1", "alice"), first);
  const worktree = temporaryDirectory("worktrees-second");
  fs.rmSync(worktree, { recursive: true, force: true });
  git(first, ["worktree", "add", "--quiet", "-b", "other-work", worktree, "main"]);
  assert.equal(claimFile(worktree, "ST-1"), null, "the claim file is not committed, so the other worktree has none");
  assert.equal(mustRefuseJson(claim(worktree, "ST-1", "bob"), worktree).error.code, "STORY_CLAIM_HELD_ELSEWHERE");
  assert.match(mustRefuseJson(claim(worktree, "ST-1", "bob", ["--force", "--actor-type", "human"]), worktree).error.message, /requires --reason/u);
  assert.equal(mustRunJson(["orchestrate", "status", "--root", worktree], worktree).stories[0].shared_claim.here, false);

  // The claim file disappears in the claiming worktree itself (for example after switching branches).
  const claimPath = path.join(first, ".sdlc", "stories", "ST-1", "claim.json");
  const saved = fs.readFileSync(claimPath);
  fs.rmSync(claimPath);
  assert.equal(mustRefuseJson(claim(first, "ST-1", "alice"), first).error.code, "STORY_CLAIM_HELD_ELSEWHERE");
  fs.writeFileSync(claimPath, saved);
  assert.deepEqual(remoteClaimRefs(remote), ["refs/agentic-sdlc/claims/ST-1/000001/claim"], "the recorded claim was never cancelled");
  assert.equal(mustRunJson(["orchestrate", "status", "--root", first], first).stories[0].shared_claim.here, true);
  assert.equal(claimed.claim.shared_claim.epoch, 1);
});

test("ownership cannot be rebuilt from the public claim record", () => {
  const { first, second, remote } = sharedProject("forged");
  const claimed = mustRunJson(claim(first, "ST-1", "alice"), first);
  const record = remoteRecord(remote, "refs/agentic-sdlc/claims/ST-1/000001/claim");
  assert.match(record.owner_proof, /^[a-f0-9]{64}$/u);
  assert.equal(claimed.claim.shared_claim.owner_proof, record.owner_proof);
  assert.doesNotMatch(JSON.stringify(record), /secret/u);
  assert.equal(spawnSync("git", ["ls-remote", remote, "refs/worktree/*", "refs/agentic-sdlc-local/*"], { encoding: "utf8" }).stdout, "");

  // Another computer copies the claim file and plants the public record where ownership is kept.
  mustRunJson(["orchestrate", "status", "--root", second], second);
  const tracking = git(second, ["for-each-ref", "--format=%(refname)", "refs/agentic-sdlc-shared/claims/"]).split("\n")[0];
  const fingerprint = tracking.split("/")[3];
  for (const root of ["refs/worktree/agentic-sdlc/claims", "refs/agentic-sdlc-local/claims"]) {
    git(second, ["fetch", "--quiet", "origin", `refs/agentic-sdlc/claims/ST-1/000001/claim:${root}/${fingerprint}/ST-1/000001`]);
  }
  const claimDirectory = path.join(second, ".sdlc", "stories", "ST-1");
  fs.copyFileSync(path.join(first, ".sdlc", "stories", "ST-1", "claim.json"), path.join(claimDirectory, "claim.json"));
  assert.equal(mustRunJson(["orchestrate", "status", "--root", second], second).stories[0].shared_claim.here, false);
  for (const marker of SESSION_MARKERS) {
    const refused = mustRefuseJson(["story", "release", "--root", second, "--id", "ST-1", "--reason", "Done", "--actor-type", "human"], second, { [marker]: "1" });
    assert.equal(refused.error.code, "STORY_CLAIM_TAKEOVER_NEEDS_PERSON", marker);
  }
  assert.equal(mustRefuseJson(claim(second, "ST-1", "bob", ["--force", "--actor-type", "human"]), second).error.message.includes("requires --reason"), true);
  assert.deepEqual(remoteClaimRefs(remote), ["refs/agentic-sdlc/claims/ST-1/000001/claim"]);
});

test("status names other computers' claims with their identity and last push, and reports work merged but still open", () => {
  const { first, second, remote } = sharedProject("status-detail", ["ST-1", "ST-2", "ST-3"]);
  // As a hosted remote does, the remote names its default branch; the second clone learns it.
  git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  git(second, ["remote", "set-head", "origin", "--auto"]);
  setOrchestration(first, { claim_identity: { git_user: true } });
  git(first, ["add", "-A"]);
  git(first, ["commit", "--quiet", "-m", "test: record claim identity"]);
  git(first, ["push", "--quiet", "origin", "main"]);
  git(second, ["pull", "--quiet", "--ff-only"]);

  // The second computer works on ST-1 and pushes its branch.
  git(second, ["checkout", "--quiet", "-b", "feature/ST-1"]);
  fs.writeFileSync(path.join(second, "feature-1.txt"), "work\n", "utf8");
  git(second, ["add", "feature-1.txt"]);
  git(second, ["commit", "--quiet", "-m", "wip: first slice"]);
  git(second, ["push", "--quiet", "origin", "feature/ST-1"]);
  mustRun(claim(second, "ST-1", "claude-code"), second, { AGENTIC_SDLC_HOST_LABEL: "pc-bob" });
  const record = remoteRecord(remote, "refs/agentic-sdlc/claims/ST-1/000001/claim");
  assert.deepEqual(record.identity, { user: "Claims E2E", host: "pc-bob" });

  git(first, ["fetch", "--quiet", "origin"]);
  const orchestration = mustRunJson(["orchestrate", "status", "--root", first], first);
  const held = orchestration.stories.find((story) => story.id === "ST-1");
  assert.equal(held.orchestration_state, "claimed");
  assert.deepEqual(held.shared_claim.holder.identity, { user: "Claims E2E", host: "pc-bob" });
  assert.equal(held.shared_claim.activity.branch_on_remote, true);
  const human = mustRun(["orchestrate", "status", "--root", first], first).stdout;
  assert.match(human, /ST-1: claimed by claude-code \(Claims E2E, pc-bob\) on feature\/ST-1 \(on another computer since [^;]+; last commit on the remote /u);

  const status = mustRunJson(["status", "--root", first], first);
  assert.deepEqual(status.work.ready_story_ids, ["ST-2", "ST-3"]);
  const shared = status.shared_claims.claims.find((item) => item.story_id === "ST-1");
  assert.deepEqual(shared.identity, { user: "Claims E2E", host: "pc-bob" });
  assert.equal(shared.activity.branch_on_remote, true);
  const statusText = mustRun(["status", "--root", first], first).stdout;
  assert.doesNotMatch(statusText.split("Technical details (optional):")[0], /\bST-\d/u, "story ids stay out of the primary lines");
  assert.match(statusText, /- Ready to start: ST-2, ST-3/u);

  // ST-3 is merged into main by hand, without any recorded lifecycle step.
  fs.writeFileSync(path.join(first, "feature-3.txt"), "done\n", "utf8");
  git(first, ["add", "feature-3.txt"]);
  git(first, ["commit", "--quiet", "-m", "feat(st-3): ST-3 delivered"]);
  git(first, ["push", "--quiet", "origin", "main"]);
  git(second, ["checkout", "--quiet", "main"]);
  const behind = mustRunJson(["status", "--root", second, "--sync", "fetch"], second);
  assert.equal(behind.workspace_sync.behind, 1);
  assert.equal(behind.workspace_sync.records_behind, 0);
  const drift = behind.merged_but_open.find((item) => item.story_id === "ST-3");
  assert.ok(drift, JSON.stringify(behind.merged_but_open));
  assert.equal(drift.evidence, "commit_subject");
  assert.equal(drift.base_branch, "main");
  const behindHuman = mustRun(["status", "--root", second, "--sync", "fetch"], second).stdout;
  const [primary, details] = behindHuman.split("Technical details (optional):");
  assert.match(primary, /^Outcome: /u, "status keeps its own plain-language outcome");
  assert.match(primary, /Attention: this copy is 1 commit\(s\) behind origin\/main/u);
  assert.match(primary, /Attention: 1 story appears already merged into the main branch but still open/u);
  assert.match(details, /ST-3: appears merged into main/u);
  assert.equal(JSON.parse(fs.readFileSync(path.join(second, ".sdlc", "stories", "ST-3", "story.json"), "utf8")).status, "ready",
    "status never changes a story record");
});

test("a claim deleted from the remote, or ended there, no longer counts as held", () => {
  const { first, second, remote } = sharedProject("status-ghost", ["ST-1", "ST-2"]);
  mustRun(claim(second, "ST-1", "bob"), second);
  assert.equal(mustRunJson(["orchestrate", "status", "--root", first], first).summary.claimed, 1);
  git(remote, ["update-ref", "-d", "refs/agentic-sdlc/claims/ST-1/000001/claim"]);
  const after = mustRunJson(["orchestrate", "status", "--root", first], first);
  assert.equal(after.summary.claimed, 0);
  const ghost = after.stories.find((story) => story.id === "ST-1");
  assert.equal(ghost.shared_claim.state, "untrustworthy");
  assert.match(ghost.shared_claim.problems.join("\n"), /gone from the remote/u);

  // The claim file travels with git: a copy whose claim the remote ended is not a claim.
  mustRun(claim(first, "ST-2", "alice"), first);
  git(first, ["add", "-A"]);
  git(first, ["commit", "--quiet", "-m", "test: claim ST-2"]);
  git(first, ["push", "--quiet", "origin", "main"]);
  mustRun(["story", "release", "--root", first, "--id", "ST-2", "--reason", "Done"], first);
  git(second, ["pull", "--quiet", "--ff-only"]);
  assert.equal(claimFile(second, "ST-2").status, "active");
  const copied = mustRunJson(["orchestrate", "status", "--root", second], second);
  const outdated = copied.stories.find((story) => story.id === "ST-2");
  assert.equal(outdated.orchestration_state, "available");
  assert.equal(outdated.shared_claim.local_claim_outdated, true);
  assert.match(mustRun(["orchestrate", "status", "--root", second], second).stdout, /ST-2: the claim file that came with git names a claim the remote has ended/u);
});

/** A story that is not started and waits on ST-1 (a hard dependency), so it can be reserved but not started. */
function blockedStory(project) {
  mustRun([
    "story", "create", "--root", project, "--id", "ST-B", "--title", "Story ST-B",
    "--acceptance", "The result is observable", "--phase", "design", "--status", "ready",
  ], project);
  mustRun(["dependency", "propose", "--root", project, "--id", "DEP-B", "--edge", "ST-B:ST-1:blocks:implementation:done"], project);
  mustRun(["dependency", "approve", "--root", project, "--id", "DEP-B", ...humanApproval("Approve the dependency")], project);
}

test("a blocked story reserved on one computer: the other sees who and until when, and its claim needs a person", () => {
  const { first, second, remote } = sharedProject("reserve", ["ST-1", "ST-2"], { before: blockedStory });
  const reserved = mustRunJson(["story", "reserve", "--root", first, "--id", "ST-B", "--agent", "alice", "--expires-in", "2d"], first);
  assert.equal(reserved.status, "reserved");
  assert.equal(reserved.shared_reservation.epoch, 1);
  const record = remoteRecord(remote, "refs/agentic-sdlc/claims/ST-B/000001/claim");
  assert.equal(record.reservation, true);
  assert.equal(record.task_start, null);
  assert.equal(claimFile(first, "ST-B"), null, "a reservation writes nothing in the project");
  assert.equal(git(first, ["status", "--porcelain"]), "");

  const orchestration = mustRunJson(["orchestrate", "status", "--root", second], second);
  const storyB = orchestration.stories.find((story) => story.id === "ST-B");
  assert.equal(storyB.orchestration_state, "blocked", "a reservation keeps a blocked story blocked");
  assert.equal(storyB.shared_claim.holder.reservation, true);
  assert.equal(storyB.shared_claim.holder.agent, "alice");
  assert.equal(storyB.shared_claim.holder.expires_at, reserved.expires_at);
  const orchestrationText = mustRun(["orchestrate", "status", "--root", second, "--locale", "it"], second).stdout;
  assert.match(orchestrationText, new RegExp(`ST-B: blocked, riservata da alice fino a ${reserved.expires_at}`, "u"));
  const statusText = mustRun(["status", "--root", second, "--locale", "it"], second, { AGENTIC_SDLC_STATUS_SYNC: "off" }).stdout;
  assert.match(statusText, /riservata da alice fino a/u);
  const status = mustRunJson(["status", "--root", second], second, { AGENTIC_SDLC_STATUS_SYNC: "off" });
  assert.equal(status.shared_claims.claims.find((claim) => claim.story_id === "ST-B").reservation, true);

  // A started story reserved elsewhere is not offered as available, and its claim is refused.
  mustRunJson(["story", "reserve", "--root", first, "--id", "ST-2", "--agent", "alice"], first);
  const seen = mustRunJson(["orchestrate", "status", "--root", second], second).stories.find((story) => story.id === "ST-2");
  assert.equal(seen.orchestration_state, "claimed");
  const refused = mustRefuseJson(claim(second, "ST-2", "bob"), second);
  assert.equal(refused.error.code, "STORY_CLAIM_HELD_ELSEWHERE");
  assert.match(refused.error.message, /already reserved/u);
  const again = mustRefuseJson(["story", "reserve", "--root", second, "--id", "ST-2", "--agent", "bob"], second);
  assert.equal(again.error.code, "STORY_CLAIM_HELD_ELSEWHERE");
  const availability = mustRunJson(["story", "availability", "--root", second, "--id", "ST-2"], second, { AGENTIC_SDLC_STATUS_SYNC: "off" });
  assert.equal(availability.verdict, "reserved_elsewhere");
  assert.equal(availability.safe_to_start, false);
  // A person can take it over, with a reason, as for any claim.
  const takenOver = mustRunJson([...claim(second, "ST-2", "bob"), "--force", "--reason", "Alice is away", "--actor-type", "human"], second);
  assert.equal(takenOver.shared_claim.took_over.agent, "alice");

  // The reserving computer's claim turns its reservation into the claim.
  mustRunJson(["story", "reserve", "--root", first, "--id", "ST-1", "--agent", "alice"], first);
  assert.equal(mustRunJson(["story", "availability", "--root", first, "--id", "ST-1"], first, { AGENTIC_SDLC_STATUS_SYNC: "off" }).verdict, "reserved_here");
  const converted = mustRunJson(claim(first, "ST-1", "alice"), first);
  assert.equal(converted.shared_claim.epoch, 2);
  assert.equal(remoteRecord(remote, "refs/agentic-sdlc/claims/ST-1/000001/release").status, "transferred");
});

test("a reservation ends by itself when it expires and earlier with story release", () => {
  const { first, second, remote } = sharedProject("reserve-expiry", ["ST-1"]);
  mustRunJson(["story", "reserve", "--root", first, "--id", "ST-1", "--agent", "alice", "--expires-at", new Date(Date.now() + 2_000).toISOString()], first);
  assert.equal(mustRefuseJson(claim(second, "ST-1", "bob"), second).error.code, "STORY_CLAIM_HELD_ELSEWHERE");
  spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 2500)"]);
  const expired = mustRunJson(["orchestrate", "status", "--root", second], second).stories.find((story) => story.id === "ST-1");
  assert.equal(expired.orchestration_state, "available");
  assert.equal(expired.shared_claim.expired_reservation.agent, "alice");
  const claimed = mustRunJson(claim(second, "ST-1", "bob"), second);
  assert.equal(claimed.shared_claim.epoch, 2);
  assert.equal(remoteRecord(remote, "refs/agentic-sdlc/claims/ST-1/000001/release").reason, "the reservation expired");
  mustRun(["story", "release", "--root", second, "--id", "ST-1"], second);

  // Released early by its own computer; one made elsewhere needs a person and a reason.
  mustRunJson(["story", "reserve", "--root", first, "--id", "ST-1", "--agent", "alice"], first);
  const otherRelease = run(["story", "release", "--root", second, "--id", "ST-1", "--json"], second);
  assert.notEqual(otherRelease.status, 0);
  const released = mustRunJson(["story", "release", "--root", first, "--id", "ST-1"], first);
  assert.equal(released.shared_reservation.status, "released");
  assert.equal(mustRunJson(["story", "availability", "--root", second, "--id", "ST-1"], second, { AGENTIC_SDLC_STATUS_SYNC: "off" }).verdict, "free");
});

test("a ready story nobody claimed, with a branch naming it on the remote, is reported before anyone starts it", () => {
  const { first, second, remote } = sharedProject("remote-work", ["ST-REPLAN-002", "ST-REPLAN-0021"]);
  git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  git(first, ["remote", "set-head", "origin", "--auto"]);
  git(second, ["checkout", "--quiet", "-b", "feature/ST-REPLAN-002"]);
  fs.writeFileSync(path.join(second, "replan.txt"), "work in progress\n");
  git(second, ["add", "replan.txt"]);
  git(second, ["commit", "--quiet", "-m", "wip: replan"]);
  git(second, ["push", "--quiet", "origin", "feature/ST-REPLAN-002"]);
  // The suite runner turns status sync off: fetch as status would.
  git(first, ["fetch", "--quiet", "origin"]);

  const availability = mustRunJson(["story", "availability", "--root", first, "--id", "ST-REPLAN-002"], first);
  assert.equal(availability.verdict, "remote_work_without_claim");
  assert.equal(availability.safe_to_start, false);
  assert.equal(availability.remote_work.branches[0].branch, "feature/ST-REPLAN-002");
  assert.equal(availability.remote_work.branches[0].ahead_of_base, 1);
  const italian = mustRun(["story", "availability", "--root", first, "--id", "ST-REPLAN-002", "--locale", "it"], first).stdout;
  assert.match(italian, /ST-REPLAN-002 non è prenotata ma sul remote c'è il branch feature\/ST-REPLAN-002 aggiornato (poco fa|\d+ minut[oi] fa): forse qualcuno ci sta già lavorando/u);
  assert.equal(mustRunJson(["story", "availability", "--root", first, "--id", "ST-REPLAN-0021"], first).verdict, "free", "ST-REPLAN-002 does not name ST-REPLAN-0021");

  const status = mustRunJson(["status", "--root", first], first);
  assert.deepEqual(status.unclaimed_remote_work.map((item) => item.story_id), ["ST-REPLAN-002"]);
  const statusText = mustRun(["status", "--root", first, "--locale", "it"], first).stdout;
  const [primary, details] = statusText.split("Dettagli tecnici (facoltativi):");
  assert.match(primary, /story non prenotate hanno già lavoro sul remote/u);
  assert.match(details || statusText, /ST-REPLAN-002 non è prenotata/u);
  const orchestration = mustRunJson(["orchestrate", "status", "--root", first], first);
  assert.equal(orchestration.unclaimed_remote_work[0].story_id, "ST-REPLAN-002");

  // Once claimed, the branch is the claim's work: no warning.
  mustRunJson(claim(first, "ST-REPLAN-002", "alice"), first);
  assert.equal(mustRunJson(["status", "--root", first], first).unclaimed_remote_work, undefined);
});
