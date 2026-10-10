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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `sdlc-delivery-amend-${name}-`));
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

function preparePullRequestDelivery({ codeReview = "not-required", merge = null, mergeAllowed = false, extraWritePath = null } = {}) {
  const project = tmpDirectory("project");
  mustRun(["init", "--root", project, "--project-name", "Delivery Amend E2E", "--force"]);
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
    "--write-path", "docs",
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
  const proposed = mustRunJson(proposeArgs(project, {
    mergeAllowed,
    extra: [...codeReviewAnswer(codeReview), ...(merge ? mergeAnswer(merge) : [])],
  }));
  mustRunJson(["autonomy", "delivery", "approve", "--root", project, "--id", PROFILE_ID, ...humanApproval("Approve the merge delivery")]);

  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.writeFileSync(path.join(project, "src", "implementation-summary.md"), "# Implementation summary\n", "utf8");

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


function mergeArgs(project, extra = []) {
  return ["autonomy", "delivery", "action", "--root", project, "--id", PROFILE_ID, "--action", "pull_request.merge", "--pr-url", PR_URL, ...extra];
}

function amendArgs(project, extra = [], summary = "The user now wants this pull request merged by the plugin") {
  return ["autonomy", "delivery", "amend", "--root", project, "--id", PROFILE_ID, ...extra, ...humanApproval(summary)];
}

function readProfile(project) {
  return JSON.parse(fs.readFileSync(path.join(project, ".sdlc", "autonomy", "deliveries", `${PROFILE_ID}.json`), "utf8"));
}

/** One governed commit of src/change.txt and the summary: a receipt bound to the first revision. */
function governedCommit(project) {
  fs.writeFileSync(path.join(project, "src", "change.txt"), "the change\n", "utf8");
  git(project, ["add", "--", "src/change.txt", "src/implementation-summary.md"]);
  const scope = ["--scope-path", "src/change.txt", "--scope-path", "src/implementation-summary.md"];
  const base = ["autonomy", "delivery", "action", "--root", project, "--id", PROFILE_ID, "--action", "git.commit"];
  const authorized = mustRunJson([...base, ...scope]);
  assert.equal(authorized.status, "authorized");
  git(project, ["commit", "-m", "feat: the change"]);
  const completed = mustRunJson([...base, "--outcome", "passed", "--evidence", "src/change.txt"]);
  assert.equal(completed.status, "completed");
  return completed.action_receipt;
}

function gateErrors(project) {
  const result = run(["gate", "check", "--root", project, "--scope", "story", "--story", STORY_ID, "--strict", "--json"]);
  assert.ok([0, 1].includes(result.status), result.stderr || result.stdout);
  return JSON.parse(result.stdout).errors;
}

test("a profile approved without merge is widened in place and the merge becomes authorizable", () => {
  const { project } = preparePullRequestDelivery();
  const first = readProfile(project);
  assert.equal(first.pull_request_target.merge_allowed, false);
  const commit = governedCommit(project);
  const headSha = git(project, ["rev-parse", "HEAD"]);
  const env = fakeGitHubEnv(project, { headSha });
  mustRefuse(mergeArgs(project), /merge/iu, { env });
  const errorsBefore = gateErrors(project);

  const scope = JSON.parse(run(["story", "scope", "check", "--root", project, "--id", STORY_ID, "--json"]).stdout);
  assert.match(JSON.stringify(scope.blocked_actions), /autonomy delivery amend --id AUT-MERGE --merge-allowed/u);
  assert.doesNotMatch(JSON.stringify(scope.blocked_actions), /propose a new delivery profile/u);

  const amended = mustRunJson(amendArgs(project, ["--merge-allowed"]));
  assert.equal(amended.status, "amended");
  assert.equal(amended.revision, 2);
  assert.equal(amended.previous_profile_hash, first.profile_hash);
  const second = readProfile(project);
  assert.equal(second.id, first.id);
  assert.notEqual(second.profile_hash, first.profile_hash);
  assert.equal(second.status, "active");
  assert.equal(second.pull_request_target.merge_allowed, true);
  assert.ok(second.pull_request_target.allowed_actions.includes("pull_request.merge"));
  assert.equal(second.extensions.revision.number, 2);
  assert.deepEqual(second.extensions.revision.history, [{ revision: 1, profile_hash: first.profile_hash }]);
  assert.equal(second.extensions.revision.summary, "The user now wants this pull request merged by the plugin");
  assert.deepEqual(second.contract_refs, first.contract_refs, "the contract is not renegotiated");
  const kept = JSON.parse(fs.readFileSync(path.join(project, ".sdlc", "autonomy", "delivery-revisions", PROFILE_ID, "r1.json"), "utf8"));
  assert.equal(kept.profile_hash, first.profile_hash);

  // The receipt of the earlier commit stays valid and the gate finds nothing new.
  assert.equal(commit.profile_ref.hash, first.profile_hash);
  assert.deepEqual(gateErrors(project).filter((error) => !errorsBefore.includes(error)), []);

  // New actions use the current revision.
  const checkpoint = mustRunJson(mergeArgs(project), { env });
  assert.equal(checkpoint.status, "checkpoint_required");
  const authorized = mustRunJson(mergeArgs(project, ["--confirm-action", ...humanApproval("Merge this exact pull request")]), { env });
  assert.equal(authorized.status, "authorized");
  assert.equal(authorized.action_receipt.profile_ref.hash, second.profile_hash);
  assert.deepEqual(gateErrors(project).filter((error) => !errorsBefore.includes(error)), []);

  // Once the merge was requested, the merge limits are not amended any more.
  mustRefuse(amendArgs(project, ["--merge", "manual", "--merge-actor-type", "human", "--merge-approval-source", "explicit-user", "--merge-summary", "I will do it"]), /merge of .* was already requested/u);
});

test("a delivery that is closed, or a boundary beyond the requirement, is not amended", () => {
  const { project } = preparePullRequestDelivery();
  governedCommit(project);
  mustRefuse(amendArgs(project), /Nothing to amend/u);
  mustRefuse(amendArgs(project, ["--add-write-path", "other"]), /beyond the approved requirement write scope: other/u);
  mustRefuse(amendArgs(project, ["--add-write-path", "."]), /narrower than the repository root/u);
  mustRefuse(["autonomy", "delivery", "amend", "--root", project, "--id", PROFILE_ID, "--merge-allowed", "--actor-type", "agent", "--summary", "x"], /requires --actor-type human/u);
  const widened = mustRunJson(amendArgs(project, ["--add-write-path", "docs"], "The change also needs the docs folder"));
  assert.deepEqual(widened.changes.added_write_paths, ["docs"]);
  assert.deepEqual(readProfile(project).constraints.allowed_write_paths, ["docs", "src"]);
  assert.equal(readProfile(project).pull_request_target.merge_allowed, false);
  mustRefuse(amendArgs(project, ["--add-write-path", "docs"]), /already allows the write paths/u);
  const second = mustRunJson(amendArgs(project, ["--merge-allowed"]));
  assert.equal(second.revision, 3);
  assert.equal(readProfile(project).extensions.revision.history.length, 2);
  mustRefuse(amendArgs(project, ["--merge-allowed"]), /already allows pull_request\.merge/u);
  mustRunJson(["autonomy", "delivery", "revoke", "--root", project, "--id", PROFILE_ID, "--reason", "stop", ...humanApproval("Stop this delivery")]);
  mustRefuse(amendArgs(project, ["--add-write-path", "docs"]), /revoked|closed/u);
});

test("a delivery with a code review choice is amended by the user, not by automation", () => {
  const { project } = preparePullRequestDelivery({ codeReview: "required" });
  mustRefuse(
    ["autonomy", "delivery", "amend", "--root", project, "--id", PROFILE_ID, "--merge-allowed", "--actor-type", "agent", "--approval-source", "automation", "--summary", "go"],
    /automation cannot amend it/u,
  );
  assert.equal(readProfile(project).pull_request_target.merge_allowed, false);
  const amended = mustRunJson(amendArgs(project, ["--merge-allowed"]));
  assert.equal(amended.revision, 2);
  assert.equal(readProfile(project).pull_request_target.code_review.decision, "required");
});
