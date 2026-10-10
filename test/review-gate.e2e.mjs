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

const PROFILE_ID = "AUT-REVIEW";
const STORY_ID = "ST-REVIEW";
const PR_URL = "https://github.com/aantenore/agentic-sdlc/pull/999998";
const AUTHOR = Object.freeze({ name: "Review Author", email: "author@example.invalid" });
const REVIEWER = Object.freeze({ actor: "luca", name: "Luca Reviewer", email: "luca@example.invalid" });

after(() => {
  if (process.env.AGENTIC_SDLC_KEEP_TEST_TMP === "1") return;
  for (const entry of tempPaths) fs.rmSync(entry, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function tmpDirectory(name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `sdlc-review-gate-${name}-`));
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

/** Git identity override for one CLI invocation, without touching the fixture's config. */
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
    AUTONOMY_FAKE_GH_HEAD: "codex/pr-review",
    AUTONOMY_FAKE_GH_BASE: "main",
    AUTONOMY_FAKE_GH_BASE_SHA: git(project, ["rev-parse", "refs/remotes/origin/main"]),
    AUTONOMY_FAKE_GH_MERGED_AT: "",
    AUTONOMY_FAKE_GH_MERGE_SHA: "",
  };
}

/** A pull-request delivery that is started and allowed to merge, as in the autonomy E2E suite. */
/**
 * The test remote is a public repository the test cannot write to, so story
 * claims stay on this computer instead of being shared through it.
 */
function setProjectReviewPolicy(project, value) {
  const configPath = path.join(project, ".sdlc", "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.gate_policy.merge_requires_code_review = value;
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  const preview = mustRunJson(["config", "migrate", "--root", project]);
  mustRunJson(["config", "migrate", "--root", project, "--apply", "--plan-hash", preview.plan.plan_hash, "--actor-type", "system"]);
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
    "--code-review-summary", decision === "required" ? "Sì, revisione prima del merge" : "No, completa in automatico",
  ];
}

function preparePullRequestDelivery({ codeReview = "required", projectRequires = null, untilPropose = false, commitIdentity = null } = {}) {
  const project = tmpDirectory("project");
  mustRun(["init", "--root", project, "--project-name", "Review Gate E2E", "--force"]);
  keepClaimsOnThisComputer(project);
  if (projectRequires !== null) setProjectReviewPolicy(project, projectRequires);
  git(project, ["init"]);
  git(project, ["config", "user.name", AUTHOR.name]);
  git(project, ["config", "user.email", AUTHOR.email]);
  git(project, ["commit", "--allow-empty", "-m", "test: establish PR base"]);
  git(project, ["branch", "-M", "main"]);
  git(project, ["remote", "add", "origin", "https://github.com/aantenore/agentic-sdlc.git"]);
  git(project, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  git(project, ["checkout", "-b", "codex/pr-review"]);

  mustRunJson([
    "requirement", "propose", "--root", project,
    "--id", "REQ-REVIEW",
    "--title", "Merge only reviewed diffs",
    "--summary", "Every pull request is reviewed by someone other than its author before it merges.",
    "--acceptance", "A merge without an independent review is refused.",
    "--autonomy-ceiling", "bounded-autonomous",
    "--write-path", "src",
  ]);
  mustRunJson(["requirement", "approve", "--root", project, "--id", "REQ-REVIEW", ...humanApproval("Approve the requirement")]);
  mustRun(["output", "template", "propose", "--root", project, "--type", "implementation-summary", "--summary", "Implementation evidence"]);
  mustRun(["output", "template", "approve", "--root", project, "--id", "implementation-summary-v1", ...humanApproval("Approve the format")]);
  mustRunJson([
    "story", "create", "--no-derived-verification", "--root", project,
    "--id", STORY_ID,
    "--title", "Implement the reviewed change",
    "--phase", "implementation",
    "--status", "ready",
    "--requirement", "REQ-REVIEW",
    "--acceptance", "The change is merged only after an independent review.",
  ]);
  mustRunJson([
    "contract", "create", "--root", project,
    "--phase", "implementation",
    "--story", STORY_ID,
    "--id", "CONTRACT-REVIEW",
    "--delivery-profile", PROFILE_ID,
    "--level", "bounded-autonomous",
    "--context-summary", "Implement the change inside the reviewed delivery boundary.",
    "--qa", "Who reviews the diff?|A reviewer who is not an author",
    "--output-ref", "implementation-summary:implementation-summary-v1:new",
    "--tool", "node",
  ]);
  mustRunJson(["contract", "approve", "--root", project, "--id", "CONTRACT-REVIEW", ...humanApproval("Approve the contract")]);
  if (untilPropose) return project;
  mustRunJson([
    "autonomy", "delivery", "propose", "--root", project,
    "--id", PROFILE_ID,
    "--delivery", "PR-REVIEW",
    "--kind", "pull_request",
    "--story", STORY_ID,
    "--contract", "CONTRACT-REVIEW",
    "--requirement", "REQ-REVIEW",
    "--level", "checkpointed",
    "--repository", "aantenore/agentic-sdlc",
    "--base", "main",
    "--head", "codex/pr-review",
    "--write-path", "src",
    "--allow-action", "pull_request.merge",
    "--merge-allowed",
    ...(codeReview ? codeReviewAnswer(codeReview) : []),
  ]);
  mustRunJson(["autonomy", "delivery", "approve", "--root", project, "--id", PROFILE_ID, ...humanApproval("Approve the merge delivery")]);

  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.writeFileSync(path.join(project, "src", "change.txt"), "reviewed change\n", "utf8");
  fs.writeFileSync(path.join(project, "src", "implementation-summary.md"), "# Implementation summary\n", "utf8");
  git(project, ["add", "--", "src"]);
  if (commitIdentity) {
    // The agent commits under its own identity, set only for its commits.
    const result = spawnSync("git", ["-C", project, "commit", "-m", "feat: the change under review"], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: commitIdentity.name,
        GIT_AUTHOR_EMAIL: commitIdentity.email,
        GIT_COMMITTER_NAME: commitIdentity.name,
        GIT_COMMITTER_EMAIL: commitIdentity.email,
      },
    });
    assert.equal(result.status, 0, result.stderr);
  } else {
    git(project, ["commit", "-m", "feat: the change under review"]);
  }

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
  mustRun(["story", "claim", "--root", project, "--id", STORY_ID, "--agent", "codex", "--branch", "codex/pr-review"]);
  mustRun([
    "output", "link", "--root", project,
    "--story", STORY_ID,
    "--type", "implementation-summary",
    "--artifact", "src/implementation-summary.md",
    "--template", "implementation-summary-v1",
    "--mode", "new",
    "--requirement", "REQ-REVIEW",
  ]);
  return project;
}

function mergeArgs(project) {
  return ["autonomy", "delivery", "action", "--root", project, "--id", PROFILE_ID, "--action", "pull_request.merge", "--pr-url", PR_URL];
}

test("pull_request.merge requires an approved review of the exact head by a non-author", () => {
  const project = preparePullRequestDelivery();
  const configPath = path.join(project, ".sdlc", "config.json");
  assert.equal(
    JSON.parse(fs.readFileSync(configPath, "utf8")).gate_policy.merge_requires_code_review,
    false,
    "a new project is initialized in full automation; the review is a per-story choice",
  );
  const headSha = () => git(project, ["rev-parse", "HEAD"]);

  // 1. No review at all.
  const refused = mustRefuse(mergeArgs(project), /no approved code review exists for head/u, {
    env: fakeGitHubEnv(project, { headSha: headSha() }),
  });
  assert.match(refused.stderr, /review record --delivery AUT-REVIEW/u);
  mustRefuse([...mergeArgs(project), "--locale", "it"], /La pull request non può ancora essere unita/u, {
    env: fakeGitHubEnv(project, { headSha: headSha() }),
  });

  // 2. The author approves their own diff: recorded, but it does not count.
  const selfReview = mustRunJson([
    "review", "record", "--root", project,
    "--delivery", PROFILE_ID,
    "--verdict", "approved",
    "--actor-type", "human",
  ]);
  assert.equal(selfReview.independent, false);
  assert.equal(selfReview.code_review.reviewed_head_sha, headSha());
  assert.deepEqual(selfReview.code_review.commit_authors, [AUTHOR]);
  assert.ok(fs.existsSync(path.join(project, selfReview.code_review_path)));
  mustRefuse(mergeArgs(project), /recorded by an author of the reviewed range/u, {
    env: fakeGitHubEnv(project, { headSha: headSha() }),
  });

  // A reviewer with a different actor but the author's Git email is still the author.
  mustRunJson([
    "review", "record", "--root", project,
    "--delivery", PROFILE_ID,
    "--verdict", "approved",
    "--actor", REVIEWER.actor,
    "--actor-type", "human",
  ]);
  mustRefuse(mergeArgs(project), /recorded by an author of the reviewed range/u, {
    env: fakeGitHubEnv(project, { headSha: headSha() }),
  });

  // 3. An independent reviewer approves the exact head: the merge proceeds to its checkpoint.
  const independent = mustRunJson([
    "review", "record", "--root", project,
    "--delivery", PROFILE_ID,
    "--verdict", "approved",
    "--actor", REVIEWER.actor,
    "--actor-type", "human",
    "--finding", JSON.stringify({ severity: "minor", summary: "Name the constant", path: "src/change.txt", line: 1 }),
  ], { env: gitIdentityEnv(REVIEWER) });
  assert.equal(independent.independent, true);
  assert.equal(independent.code_review.reviewer.git_email, REVIEWER.email);
  const checkpoint = mustRunJson(mergeArgs(project), { env: fakeGitHubEnv(project, { headSha: headSha() }) });
  assert.equal(checkpoint.status, "checkpoint_required");

  // 4. The head moves: the earlier approval no longer covers what would be merged.
  fs.writeFileSync(path.join(project, "src", "later.txt"), "unreviewed follow-up\n", "utf8");
  git(project, ["add", "--", "src/later.txt"]);
  git(project, ["commit", "-m", "feat: an unreviewed follow-up"]);
  mustRefuse(mergeArgs(project), /no approved code review exists for head/u, {
    env: fakeGitHubEnv(project, { headSha: headSha() }),
  });

  // A tampered record is not evidence.
  const recordPath = path.join(project, independent.code_review_path);
  const tampered = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  tampered.reviewed_head_sha = headSha();
  fs.writeFileSync(recordPath, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");
  mustRefuse(mergeArgs(project), /no approved code review exists for head/u, {
    env: fakeGitHubEnv(project, { headSha: headSha() }),
  });

  // A later changes_requested from an independent reviewer withdraws an approval of the same head.
  mustRunJson(["review", "record", "--root", project, "--delivery", PROFILE_ID, "--verdict", "approved", "--actor", REVIEWER.actor, "--actor-type", "human"], { env: gitIdentityEnv(REVIEWER) });
  mustRunJson(mergeArgs(project), { env: fakeGitHubEnv(project, { headSha: headSha() }) });
  mustRunJson([
    "review", "record", "--root", project,
    "--delivery", PROFILE_ID,
    "--verdict", "changes_requested",
    "--actor", REVIEWER.actor,
    "--actor-type", "human",
    "--finding", JSON.stringify({ severity: "blocking", summary: "The follow-up drops validation" }),
  ], { env: gitIdentityEnv(REVIEWER) });
  mustRefuse(mergeArgs(project), /requested changes/u, { env: fakeGitHubEnv(project, { headSha: headSha() }) });
});

test("review record refuses an approval with a blocking finding and a non pull-request delivery", () => {
  const project = preparePullRequestDelivery();
  mustRefuse([
    "review", "record", "--root", project,
    "--delivery", PROFILE_ID,
    "--verdict", "approved",
    "--finding", JSON.stringify({ severity: "blocking", summary: "Breaks the contract" }),
  ], /cannot carry a blocking finding/u);
  mustRefuse(["review", "record", "--root", project, "--delivery", PROFILE_ID, "--verdict", "lgtm"], /--verdict must be one of/u);
  mustRefuse(["review", "record", "--root", project, "--delivery", "AUT-MISSING", "--verdict", "approved"], /does not exist/u);
  const reviews = path.join(project, ".sdlc", "reviews");
  assert.equal(fs.existsSync(reviews) ? fs.readdirSync(reviews).length : 0, 0, "a refused review writes no record");
});

test("a project whose configuration never declared the merge review gate keeps merging as before", () => {
  const project = preparePullRequestDelivery({ codeReview: "not-required" });
  const configPath = path.join(project, ".sdlc", "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  delete config.gate_policy.merge_requires_code_review;
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  // The edit is accepted through the reviewed migration path, as an existing project would be.
  const plan = mustRunJson(["config", "migrate", "--root", project]);
  assert.deepEqual(plan.plan.inherited_paths, [], "no default re-introduces the gate");
  mustRunJson(["config", "migrate", "--root", project, "--apply", "--plan-hash", plan.plan.plan_hash]);
  assert.equal(
    JSON.parse(fs.readFileSync(configPath, "utf8")).gate_policy.merge_requires_code_review,
    undefined,
  );
  const checkpoint = mustRunJson(mergeArgs(project), {
    env: fakeGitHubEnv(project, { headSha: git(project, ["rev-parse", "HEAD"]) }),
  });
  assert.equal(checkpoint.status, "checkpoint_required");
});

function proposeArgs(project, extra = []) {
  return [
    "autonomy", "delivery", "propose", "--root", project,
    "--id", PROFILE_ID,
    "--delivery", "PR-REVIEW",
    "--kind", "pull_request",
    "--story", STORY_ID,
    "--contract", "CONTRACT-REVIEW",
    "--requirement", "REQ-REVIEW",
    "--level", "checkpointed",
    "--repository", "aantenore/agentic-sdlc",
    "--base", "main",
    "--head", "codex/pr-review",
    "--write-path", "src",
    "--allow-action", "pull_request.merge",
    "--merge-allowed",
    ...extra,
  ];
}

test("a new pull-request delivery needs the user's own answer on code review", () => {
  const project = preparePullRequestDelivery({ untilPropose: true });
  mustRefuse(proposeArgs(project), /needs the user's answer on code review before merge/u);
  mustRefuse(proposeArgs(project, [
    "--code-review", "not-required",
    "--code-review-approval-source", "explicit-user",
    "--code-review-summary", "decided by the agent",
  ]), /--code-review-actor-type human/u);
  mustRefuse(proposeArgs(project, [
    "--code-review", "required",
    "--code-review-actor-type", "human",
    "--code-review-approval-source", "explicit-user",
  ]), /--code-review-summary must quote the user's answer/u);
  const proposed = mustRunJson(proposeArgs(project, codeReviewAnswer("not-required")));
  const choice = proposed.delivery_profile.pull_request_target.code_review;
  assert.equal(choice.decision, "not-required");
  assert.equal(choice.source, "explicit-user");
  assert.equal(choice.user_words, "No, completa in automatico");
  assert.equal(proposed.review.code_review_before_merge.decision, "not-required");
  // A choice made by a person is never approved by automation.
  mustRefuse(
    ["autonomy", "delivery", "approve", "--root", project, "--id", PROFILE_ID, "--actor-type", "agent", "--approval-source", "automation", "--summary", "auto"],
    /automation cannot approve it|requires/u,
  );
});

test("without a required review the merge proceeds in full automation and explain says why", () => {
  const project = preparePullRequestDelivery({ codeReview: "not-required" });
  const headSha = git(project, ["rev-parse", "HEAD"]);
  const checkpoint = mustRunJson(mergeArgs(project), { env: fakeGitHubEnv(project, { headSha }) });
  assert.equal(checkpoint.status, "checkpoint_required");
  const explained = mustRunJson(["autonomy", "delivery", "explain", "--root", project, "--id", PROFILE_ID]);
  assert.equal(explained.code_review.requirement.required, false);
  assert.equal(explained.code_review.requirement.source, "delivery_profile");
  const italian = mustRun(["autonomy", "delivery", "explain", "--root", project, "--id", PROFILE_ID, "--locale", "it"]);
  assert.match(italian.stdout, /Revisione del codice prima del merge: non richiesta \(scelta dall’utente per questa storia\)/u);
  const english = mustRun(["autonomy", "delivery", "explain", "--root", project, "--id", PROFILE_ID]);
  assert.match(english.stdout, /Code review before merge: not required \(chosen by the user for this story\)/u);
  const status = mustRunJson(["status", "--root", project]);
  assert.equal(status.code_review_before_merge[0].required, false);
});

test("a required review blocks only the merge and is counted in explain and status", () => {
  const project = preparePullRequestDelivery({ codeReview: "required" });
  const headSha = git(project, ["rev-parse", "HEAD"]);
  // The strict lifecycle gate does not ask for the review.
  const gate = run(["gate", "check", "--root", project, "--story", STORY_ID, "--strict", "--json"]);
  assert.doesNotMatch(`${gate.stdout}${gate.stderr}`, /code review|code_review_required|revisione del codice/iu);
  mustRefuse(mergeArgs(project), /no approved code review exists for head/u, { env: fakeGitHubEnv(project, { headSha }) });
  const english = mustRun(["autonomy", "delivery", "explain", "--root", project, "--id", PROFILE_ID]);
  assert.match(english.stdout, /Code review before merge: required \(chosen by the user for this story\)/u);
  assert.match(english.stdout, /Valid reviews of the current head \([0-9a-f]{12}\): 0 of 0/u);
  mustRunJson(["review", "record", "--root", project, "--delivery", PROFILE_ID, "--verdict", "approved", "--actor", REVIEWER.actor, "--actor-type", "human"], { env: gitIdentityEnv(REVIEWER) });
  const status = mustRunJson(["status", "--root", project]);
  assert.equal(status.code_review_before_merge[0].required, true);
  assert.equal(status.code_review_before_merge[0].valid_reviews, 1);
  const italian = mustRun(["status", "--root", project, "--locale", "it"]);
  assert.match(italian.stdout, /Revisione prima del merge per PR-REVIEW \(storia ST-REVIEW\): richiesta/u);
  assert.equal(mustRunJson(mergeArgs(project), { env: fakeGitHubEnv(project, { headSha }) }).status, "checkpoint_required");
});

test("a review can be added after approval; only the user, outside the agent session, can drop it", () => {
  const project = preparePullRequestDelivery({ codeReview: "not-required" });
  const headSha = git(project, ["rev-parse", "HEAD"]);
  const added = mustRunJson(["review", "require", "--root", project, "--delivery", PROFILE_ID, "--summary", "The user wants a review after all"]);
  assert.equal(added.code_review_requirement.required, true);
  assert.equal(added.code_review_requirement.source, "change");
  mustRefuse(mergeArgs(project), /no approved code review exists for head/u, { env: fakeGitHubEnv(project, { headSha }) });
  const waive = ["review", "waive", "--root", project, "--delivery", PROFILE_ID, "--actor-type", "human", "--approval-source", "explicit-user", "--summary", "Niente revisione per questa storia"];
  mustRefuse(waive, /cannot run inside an agent session/u, { env: { CLAUDECODE: "1" } });
  mustRefuse(waive, /cannot run inside an agent session/u, { env: { CODEX_THREAD_ID: "thread-1" } });
  mustRefuse(["review", "waive", "--root", project, "--delivery", PROFILE_ID, "--actor-type", "agent", "--approval-source", "automation", "--summary", "agent"], /human|explicit-user/u);
  mustRefuse(mergeArgs(project), /no approved code review exists for head/u, { env: fakeGitHubEnv(project, { headSha }) });
  const dropped = mustRunJson(waive);
  assert.equal(dropped.code_review_requirement.required, false);
  assert.equal(dropped.change.approval_source, "explicit-user");
  assert.equal(mustRunJson(mergeArgs(project), { env: fakeGitHubEnv(project, { headSha }) }).status, "checkpoint_required");
  // A drop record forged without a person's decision does not count.
  const forgedPath = path.join(project, dropped.change_path);
  const forged = JSON.parse(fs.readFileSync(forgedPath, "utf8"));
  forged.actor.type = "agent";
  fs.writeFileSync(forgedPath, `${JSON.stringify(forged, null, 2)}\n`, "utf8");
  mustRefuse(mergeArgs(project), /no approved code review exists for head/u, { env: fakeGitHubEnv(project, { headSha }) });
});

test("a project that requires reviews for every pull request is a floor no story choice lowers", () => {
  const project = preparePullRequestDelivery({ codeReview: "not-required", projectRequires: true });
  const headSha = git(project, ["rev-parse", "HEAD"]);
  mustRefuse(mergeArgs(project), /no approved code review exists for head/u, { env: fakeGitHubEnv(project, { headSha }) });
  mustRefuse(
    ["review", "waive", "--root", project, "--delivery", PROFILE_ID, "--actor-type", "human", "--approval-source", "explicit-user", "--summary", "no"],
    /requires a code review before every pull request merge/u,
  );
  const explained = mustRunJson(["autonomy", "delivery", "explain", "--root", project, "--id", PROFILE_ID]);
  assert.equal(explained.code_review.requirement.source, "project_policy");
});

test("editing the approved choice in the delivery profile is never silent", () => {
  const project = preparePullRequestDelivery({ codeReview: "required" });
  const headSha = git(project, ["rev-parse", "HEAD"]);
  const profilePath = path.join(project, ".sdlc", "autonomy", "deliveries", `${PROFILE_ID}.json`);
  const located = fs.existsSync(profilePath)
    ? profilePath
    : spawnSync("git", ["-C", project, "ls-files", "--others", "--cached", "--", `*${PROFILE_ID}.json`], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).map((item) => path.join(project, item))[0];
  const profile = JSON.parse(fs.readFileSync(located, "utf8"));
  profile.pull_request_target.code_review.decision = "not-required";
  fs.writeFileSync(located, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
  const refused = run(mergeArgs(project), { env: fakeGitHubEnv(project, { headSha }) });
  assert.equal(refused.status, 1, `${refused.stdout}\n${refused.stderr}`);
  assert.doesNotMatch(refused.stdout, /checkpoint_required/u);
});

test("an agent committing under its own identity lets the guiding person review on the same machine", () => {
  const agent = { name: "agent-dev-1", email: "agent-dev-1@users.noreply.invalid" };
  const project = preparePullRequestDelivery({ codeReview: "required", commitIdentity: agent });
  const headSha = git(project, ["rev-parse", "HEAD"]);
  assert.equal(git(project, ["log", "-1", "--format=%ae"]), agent.email);
  // The repository identity stays the person's, so their review is independent.
  const review = mustRunJson(["review", "record", "--root", project, "--delivery", PROFILE_ID, "--verdict", "approved", "--actor", "antonio", "--actor-type", "human"]);
  assert.equal(review.independent, true);
  assert.equal(review.code_review.reviewer.git_email, AUTHOR.email);
  assert.equal(mustRunJson(mergeArgs(project), { env: fakeGitHubEnv(project, { headSha }) }).status, "checkpoint_required");
});
