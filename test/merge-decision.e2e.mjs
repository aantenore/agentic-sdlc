import "./helpers/test-isolation.mjs";

import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(repoRoot, "bin", "agentic-sdlc.mjs");
const providerCommandShim = path.join(repoRoot, "test", "helpers", "provider-command-shim.cjs");
const tempPaths = new Set();

const PROFILE_ID = "AUT-MERGE";
const STORY_ID = "ST-MERGE";
const PR_URL = "https://github.com/aantenore/agentic-sdlc/pull/999997";
const AUTHOR = Object.freeze({ name: "Merge Author", email: "author@example.invalid" });
const REVIEWER = Object.freeze({ actor: "luca", name: "Luca Reviewer", email: "luca@example.invalid" });

after(() => {
  if (process.env.AGENTIC_SDLC_KEEP_TEST_TMP === "1") return;
  for (const entry of tempPaths) fs.rmSync(entry, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function tmpDirectory(name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `sdlc-merge-decision-${name}-`));
  tempPaths.add(directory);
  return directory;
}

function run(args, options = {}) {
  const env = { ...process.env };
  for (const key of ["CI", "GITHUB_ACTIONS", "GITHUB_ACTOR", "CODEX_AGENT_NAME", "CODEX_USER_ID", "CLAUDECODE", "AGENTIC_SDLC_AGENT_HOST"]) delete env[key];
  Object.assign(env, options.env || {});
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
    timeout: 60_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function mustRun(args, options = {}) {
  const result = run(args, options);
  assert.equal(result.status, 0, `${args.join(" ")}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result;
}

function mustRunJson(args, options = {}) {
  return JSON.parse(mustRun([...args, "--json"], options).stdout);
}

function mustRefuse(args, pattern, options = {}) {
  const result = run(args, options);
  const combined = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 1, `${args.join(" ")} must exit 1 (refused)\n${combined}`);
  assert.match(combined, pattern, combined);
  return result;
}

function git(project, args) {
  const result = spawnSync("git", ["-C", project, ...args], { encoding: "utf8", timeout: 60_000 });
  assert.equal(result.status, 0, `git ${args.join(" ")}\n${result.stderr}`);
  return result.stdout.trim();
}

function humanApproval(summary) {
  return ["--actor-type", "human", "--approval-source", "explicit-user", "--summary", summary];
}

function gitIdentityEnv(identity) {
  return {
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "user.name",
    GIT_CONFIG_VALUE_0: identity.name,
    GIT_CONFIG_KEY_1: "user.email",
    GIT_CONFIG_VALUE_1: identity.email,
  };
}

function fakeGitHubEnv(project, values) {
  const fakeBin = tmpDirectory("gh");
  const executable = path.join(fakeBin, process.platform === "win32" ? "gh.exe" : "gh");
  fs.copyFileSync(fs.realpathSync.native(process.execPath), executable, fs.constants.COPYFILE_FICLONE);
  if (process.platform !== "win32") fs.chmodSync(executable, 0o755);
  const requireOption = /\s/u.test(providerCommandShim)
    ? `--require=${JSON.stringify(providerCommandShim)}`
    : `--require=${providerCommandShim}`;
  return {
    AUTONOMY_FAKE_PROVIDER: "gh",
    NODE_OPTIONS: [process.env.NODE_OPTIONS, requireOption].filter(Boolean).join(" "),
    PATH: [fakeBin, process.env.PATH].filter(Boolean).join(path.delimiter),
    AUTONOMY_FAKE_GH_STATE: "OPEN",
    AUTONOMY_FAKE_GH_URL: PR_URL,
    AUTONOMY_FAKE_GH_DRAFT: "false",
    AUTONOMY_FAKE_GH_HEAD_SHA: values.headSha,
    AUTONOMY_FAKE_GH_HEAD: "codex/pr-merge",
    AUTONOMY_FAKE_GH_BASE: "main",
    AUTONOMY_FAKE_GH_BASE_SHA: git(project, ["rev-parse", "refs/remotes/origin/main"]),
    AUTONOMY_FAKE_GH_MERGED_AT: "",
    AUTONOMY_FAKE_GH_MERGE_SHA: "",
  };
}

function keepClaimsOnThisComputer(project) {
  const configPath = path.join(project, ".sdlc", "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.orchestration_policy = {
    ...config.orchestration_policy,
    coordination: { ...config.orchestration_policy?.coordination, mode: "local_only" },
  };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  const preview = mustRunJson(["config", "migrate", "--root", project]);
  mustRunJson(["config", "migrate", "--root", project, "--apply", "--plan-hash", preview.plan.plan_hash, "--actor-type", "system"]);
}

function codeReviewAnswer(decision) {
  return [
    "--code-review", decision,
    "--code-review-actor-type", "human",
    "--code-review-approval-source", "explicit-user",
    "--code-review-summary", decision === "required" ? "Yes, review before merge" : "No review needed",
  ];
}

function mergeAnswer(mode, summary = `Merge ${mode}`) {
  return [
    "--merge", mode,
    "--merge-actor-type", "human",
    "--merge-approval-source", "explicit-user",
    "--merge-summary", summary,
  ];
}

function proposeArgs(project, { level = "checkpointed", mergeAllowed = true, extra = [] } = {}) {
  return [
    "autonomy", "delivery", "propose", "--root", project,
    "--id", PROFILE_ID,
    "--delivery", "PR-MERGE",
    "--kind", "pull_request",
    "--story", STORY_ID,
    "--contract", "CONTRACT-MERGE",
    "--requirement", "REQ-MERGE",
    "--level", level,
    "--repository", "aantenore/agentic-sdlc",
    "--base", "main",
    "--head", "codex/pr-merge",
    "--write-path", "src",
    ...(mergeAllowed ? ["--allow-action", "pull_request.merge", "--merge-allowed"] : []),
    ...extra,
  ];
}

function preparePullRequestDelivery({ codeReview = "not-required", merge = null, untilPropose = false } = {}) {
  const project = tmpDirectory("project");
  mustRun(["init", "--root", project, "--project-name", "Merge Decision E2E", "--force"]);
  keepClaimsOnThisComputer(project);
  git(project, ["init"]);
  git(project, ["config", "user.name", AUTHOR.name]);
  git(project, ["config", "user.email", AUTHOR.email]);
  git(project, ["commit", "--allow-empty", "-m", "test: establish PR base"]);
  git(project, ["branch", "-M", "main"]);
  git(project, ["remote", "add", "origin", "https://github.com/aantenore/agentic-sdlc.git"]);
  git(project, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  git(project, ["checkout", "-b", "codex/pr-merge"]);

  mustRunJson([
    "requirement", "propose", "--root", project,
    "--id", "REQ-MERGE",
    "--title", "Merge as the user chose",
    "--summary", "Each pull request is merged the way the user chose for it.",
    "--acceptance", "A manual merge is never run by the plugin.",
    "--autonomy-ceiling", "bounded-autonomous",
    "--write-path", "src",
  ]);
  mustRunJson(["requirement", "approve", "--root", project, "--id", "REQ-MERGE", ...humanApproval("Approve the requirement")]);
  mustRun(["output", "template", "propose", "--root", project, "--type", "implementation-summary", "--summary", "Implementation evidence"]);
  mustRun(["output", "template", "approve", "--root", project, "--id", "implementation-summary-v1", ...humanApproval("Approve the format")]);
  mustRunJson([
    "story", "create", "--no-derived-verification", "--root", project,
    "--id", STORY_ID,
    "--title", "Implement the change",
    "--phase", "implementation",
    "--status", "ready",
    "--requirement", "REQ-MERGE",
    "--acceptance", "The change is merged the way the user chose.",
  ]);
  mustRunJson([
    "contract", "create", "--root", project,
    "--phase", "implementation",
    "--story", STORY_ID,
    "--id", "CONTRACT-MERGE",
    "--delivery-profile", PROFILE_ID,
    "--level", "bounded-autonomous",
    "--context-summary", "Implement the change inside the delivery boundary.",
    "--qa", "Who merges?|The user decides",
    "--output-ref", "implementation-summary:implementation-summary-v1:new",
    "--tool", "node",
  ]);
  mustRunJson(["contract", "approve", "--root", project, "--id", "CONTRACT-MERGE", ...humanApproval("Approve the contract")]);
  if (untilPropose) return { project, proposed: null };
  const proposed = mustRunJson(proposeArgs(project, {
    extra: [...codeReviewAnswer(codeReview), ...(merge ? mergeAnswer(merge) : [])],
  }));
  mustRunJson(["autonomy", "delivery", "approve", "--root", project, "--id", PROFILE_ID, ...humanApproval("Approve the merge delivery")]);

  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.writeFileSync(path.join(project, "src", "change.txt"), "the change\n", "utf8");
  fs.writeFileSync(path.join(project, "src", "implementation-summary.md"), "# Implementation summary\n", "utf8");
  git(project, ["add", "--", "src"]);
  git(project, ["commit", "-m", "feat: the change"]);

  const intent = JSON.stringify({
    requested_action: "implement_story",
    confidence: 0.99,
    referenced_entities: [{ type: "story", id: STORY_ID }],
    provided_artifacts: [],
    missing_context: [],
    proposed_phase: "implementation",
    artifact_type: null,
    skip_phases: [],
  });
  const started = mustRunJson(["task", "start", "--root", project, "--intent-json", intent, "--delivery-profile", PROFILE_ID]);
  assert.equal(started.execution_allowed, true);
  mustRun(["story", "claim", "--root", project, "--id", STORY_ID, "--agent", "codex", "--branch", "codex/pr-merge"]);
  mustRun([
    "output", "link", "--root", project,
    "--story", STORY_ID,
    "--type", "implementation-summary",
    "--artifact", "src/implementation-summary.md",
    "--template", "implementation-summary-v1",
    "--mode", "new",
    "--requirement", "REQ-MERGE",
  ]);
  return { project, proposed };
}

function mergeArgs(project) {
  return ["autonomy", "delivery", "action", "--root", project, "--id", PROFILE_ID, "--action", "pull_request.merge", "--pr-url", PR_URL];
}

test("without --merge the profile records no merge choice and the merge waits for confirmation", () => {
  const { project, proposed } = preparePullRequestDelivery();
  assert.equal(Object.hasOwn(proposed.delivery_profile.pull_request_target, "merge_decision"), false);
  assert.equal(Object.hasOwn(proposed.review, "merge_decision"), false);
  assert.ok(proposed.review.checkpoints.includes("pull_request.merge"));
  const headSha = git(project, ["rev-parse", "HEAD"]);
  const checkpoint = mustRunJson(mergeArgs(project), { env: fakeGitHubEnv(project, { headSha }) });
  assert.equal(checkpoint.status, "checkpoint_required");
  const english = mustRun(["autonomy", "delivery", "explain", "--root", project, "--id", PROFILE_ID]);
  assert.doesNotMatch(english.stdout, /^Merge: /mu);
});

test("an automatic merge needs no merge confirmation but still waits for the required review", () => {
  const { project, proposed } = preparePullRequestDelivery({ codeReview: "required", merge: "automatic" });
  const choice = proposed.delivery_profile.pull_request_target.merge_decision;
  assert.equal(choice.mode, "automatic");
  assert.equal(choice.source, "explicit-user");
  assert.equal(choice.actor_id, "user");
  assert.equal(choice.user_words, "Merge automatic");
  assert.equal(proposed.review.merge_decision.mode, "automatic");
  assert.equal(proposed.review.checkpoints.includes("pull_request.merge"), false);
  const headSha = git(project, ["rev-parse", "HEAD"]);
  // Every other gate still applies: the review is required before merge.
  mustRefuse(mergeArgs(project), /no approved code review exists for head/u, { env: fakeGitHubEnv(project, { headSha }) });
  mustRunJson([
    "review", "record", "--root", project,
    "--delivery", PROFILE_ID,
    "--verdict", "approved",
    "--actor", REVIEWER.actor,
    "--actor-type", "human",
  ], { env: gitIdentityEnv(REVIEWER) });
  const authorized = mustRunJson(mergeArgs(project), { env: fakeGitHubEnv(project, { headSha }) });
  assert.notEqual(authorized.status, "checkpoint_required");
  assert.equal(authorized.status, "authorized");
  assert.equal(authorized.checkpoint_required, false);
  assert.equal(authorized.action_receipt.checkpoint_required, false);
  assert.equal(authorized.action_receipt.action_details.checkpoint_policy.required, false);
  const english = mustRun(["autonomy", "delivery", "explain", "--root", project, "--id", PROFILE_ID]);
  assert.match(english.stdout, /Merge: automatic .*chosen by the user for this delivery/u);
  const italian = mustRun(["autonomy", "delivery", "explain", "--root", project, "--id", PROFILE_ID, "--locale", "it"]);
  assert.match(italian.stdout, /Merge: automatico/u);
  // The authorization's checkpoint snapshot reproduces the same decision on validation.
  const validation = run(["gate", "check", "--root", project, "--json"]);
  assert.match(validation.stdout, /delivery autonomy profile AUT-MERGE/u);
  assert.doesNotMatch(`${validation.stdout}\n${validation.stderr}`, /checkpoint policy snapshot|checkpoint_required/u);
});

test("a manual merge is never run by the plugin and points to reconcile", () => {
  const { project, proposed } = preparePullRequestDelivery({ merge: "manual" });
  assert.equal(proposed.delivery_profile.pull_request_target.merge_decision.mode, "manual");
  const headSha = git(project, ["rev-parse", "HEAD"]);
  const refused = mustRefuse(mergeArgs(project), /merge the pull request on GitHub/iu, { env: fakeGitHubEnv(project, { headSha }) });
  assert.match(refused.stderr, /autonomy delivery reconcile/u);
  const italian = mustRefuse([...mergeArgs(project), "--locale", "it"], /Fai il merge della pull request su GitHub/u, {
    env: fakeGitHubEnv(project, { headSha }),
  });
  assert.match(italian.stderr, /autonomy delivery reconcile/u);
  const english = mustRun(["autonomy", "delivery", "explain", "--root", project, "--id", PROFILE_ID]);
  assert.match(english.stdout, /Merge: manual \(the user merges on GitHub/u);
});

test("the merge choice is the user's explicit answer and automatic needs merge authority above supervised", () => {
  const { project } = preparePullRequestDelivery({ untilPropose: true });
  const base = codeReviewAnswer("not-required");
  mustRefuse(proposeArgs(project, { extra: [...base, "--merge", "sometimes", "--merge-actor-type", "human", "--merge-approval-source", "explicit-user", "--merge-summary", "x"] }), /--merge must be one of: manual, after-confirmation, automatic/u);
  mustRefuse(proposeArgs(project, { extra: [...base, "--merge", "automatic", "--merge-approval-source", "explicit-user", "--merge-summary", "decided by the agent"] }), /--merge-actor-type human/u);
  mustRefuse(proposeArgs(project, { extra: [...base, "--merge", "automatic", "--merge-actor-type", "agent", "--merge-approval-source", "explicit-user", "--merge-summary", "x"] }), /--merge-actor-type human/u);
  mustRefuse(proposeArgs(project, { extra: [...base, "--merge", "manual", "--merge-actor-type", "human", "--merge-approval-source", "explicit-user"] }), /--merge-summary must quote the user's answer/u);
  mustRefuse(proposeArgs(project, { extra: [...base, "--merge-summary", "merge it"] }), /needs --merge/u);
  mustRefuse(proposeArgs(project, { level: "supervised", extra: [...base, ...mergeAnswer("automatic")] }), /not available at --level supervised/u);
  mustRefuse(proposeArgs(project, { mergeAllowed: false, extra: [...base, ...mergeAnswer("automatic")] }), /--merge automatic needs --merge-allowed/u);
  mustRefuse(proposeArgs(project, { mergeAllowed: false, extra: [...base, "--merge-allowed", ...mergeAnswer("automatic")] }), /--merge automatic needs --merge-allowed and pull_request\.merge/u);
  const profilePath = path.join(project, ".sdlc", "autonomy", "deliveries", `${PROFILE_ID}.json`);
  assert.equal(fs.existsSync(profilePath), false, "a refused proposal writes no profile");
  // A supervised delivery may still record a manual or confirmed merge.
  const supervised = mustRunJson(proposeArgs(project, { level: "supervised", extra: [...base, ...mergeAnswer("after-confirmation", "Ask me first")] }));
  assert.equal(supervised.delivery_profile.pull_request_target.merge_decision.mode, "after-confirmation");
  assert.equal(supervised.delivery_profile.pull_request_target.merge_decision.user_words, "Ask me first");
});
