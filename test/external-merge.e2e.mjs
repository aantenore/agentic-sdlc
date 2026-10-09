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

const PROFILE_ID = "AUT-EXTERNAL";
const STORY_ID = "ST-EXTERNAL";
const DOWNSTREAM_ID = "ST-DOWNSTREAM";
const HEAD_BRANCH = "codex/pr-external";
const PR_NUMBER = "999997";
const PR_URL = `https://github.com/aantenore/agentic-sdlc/pull/${PR_NUMBER}`;
const MERGE_SHA = "c".repeat(40);
const AUTHOR = Object.freeze({ name: "Change Author", email: "author@example.invalid" });
const REVIEWER = Object.freeze({ actor: "luca", name: "Luca Reviewer", email: "luca@example.invalid" });

after(() => {
  if (process.env.AGENTIC_SDLC_KEEP_TEST_TMP === "1") return;
  for (const entry of tempPaths) fs.rmSync(entry, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function tmpDirectory(name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `sdlc-external-merge-${name}-`));
  tempPaths.add(directory);
  return directory;
}

function run(args, options = {}) {
  const env = { ...process.env };
  for (const key of ["CI", "GITHUB_ACTIONS", "GITHUB_ACTOR", "CODEX_AGENT_NAME", "CODEX_THREAD_ID", "CODEX_USER_ID", "CLAUDECODE", "AGENTIC_SDLC_AGENT_HOST"]) delete env[key];
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

function applyConfig(project, change) {
  const configPath = path.join(project, ".sdlc", "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  change(config);
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  const preview = mustRunJson(["config", "migrate", "--root", project]);
  mustRunJson(["config", "migrate", "--root", project, "--apply", "--plan-hash", preview.plan.plan_hash, "--actor-type", "system"]);
}

/** GitHub as the person left it: the pull request merged at `headSha`. */
function mergedOnGitHub(project, { headSha, state = "MERGED", mergedAt = new Date().toISOString(), base = "main", draft = false, updatedAt = "" }) {
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
    AUTONOMY_FAKE_GH_STATE: state,
    AUTONOMY_FAKE_GH_URL: PR_URL,
    AUTONOMY_FAKE_GH_DRAFT: String(draft),
    AUTONOMY_FAKE_GH_UPDATED_AT: updatedAt,
    AUTONOMY_FAKE_GH_HEAD_SHA: headSha,
    AUTONOMY_FAKE_GH_HEAD: HEAD_BRANCH,
    AUTONOMY_FAKE_GH_BASE: base,
    AUTONOMY_FAKE_GH_BASE_SHA: git(project, ["rev-parse", "refs/remotes/origin/main"]),
    AUTONOMY_FAKE_GH_MERGED_AT: state === "MERGED" ? mergedAt : "",
    AUTONOMY_FAKE_GH_MERGE_SHA: state === "MERGED" ? MERGE_SHA : "",
    AUTONOMY_FAKE_GH_MERGED_BY: state === "MERGED" ? "maria" : "",
  };
}

function commitFile(project, relativePath, contents, message) {
  fs.mkdirSync(path.dirname(path.join(project, relativePath)), { recursive: true });
  fs.writeFileSync(path.join(project, relativePath), contents, "utf8");
  git(project, ["add", "--", relativePath]);
  git(project, ["commit", "-m", message]);
}

/**
 * A started delivery on an existing pull request, pinned to the reviewed head
 * the plugin saw, as a person would leave it before merging on GitHub.
 */
function prepareDelivery({ codeReview = "not-required" } = {}) {
  const project = tmpDirectory("project");
  mustRun(["init", "--root", project, "--project-name", "External Merge E2E", "--force"]);
  applyConfig(project, (config) => {
    config.orchestration_policy = {
      ...config.orchestration_policy,
      coordination: { ...config.orchestration_policy?.coordination, mode: "local_only" },
      status_sync: { ...config.orchestration_policy?.status_sync, mode: "off" },
    };
  });
  git(project, ["init"]);
  git(project, ["config", "user.name", AUTHOR.name]);
  git(project, ["config", "user.email", AUTHOR.email]);
  git(project, ["commit", "--allow-empty", "-m", "test: establish PR base"]);
  git(project, ["branch", "-M", "main"]);
  git(project, ["remote", "add", "origin", "https://github.com/aantenore/agentic-sdlc.git"]);
  git(project, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  git(project, ["checkout", "-b", HEAD_BRANCH]);

  mustRunJson([
    "requirement", "propose", "--root", project,
    "--id", "REQ-EXTERNAL",
    "--title", "Recognize merges made on GitHub",
    "--summary", "A pull request merged by a person on GitHub is acknowledged instead of staying half delivered.",
    "--acceptance", "An external merge of the verified head is acknowledged.",
    "--autonomy-ceiling", "bounded-autonomous",
    "--write-path", "src",
  ]);
  mustRunJson(["requirement", "approve", "--root", project, "--id", "REQ-EXTERNAL", ...humanApproval("Approve the requirement")]);
  mustRun(["output", "template", "propose", "--root", project, "--type", "implementation-summary", "--summary", "Implementation evidence"]);
  mustRun(["output", "template", "approve", "--root", project, "--id", "implementation-summary-v1", ...humanApproval("Approve the format")]);
  for (const id of [STORY_ID, DOWNSTREAM_ID]) {
    mustRunJson([
      "story", "create", "--root", project,
      "--id", id,
      "--title", id === STORY_ID ? "Deliver the change" : "Build on the merged change",
      "--phase", "implementation",
      "--status", "ready",
      "--requirement", "REQ-EXTERNAL",
      "--acceptance", "The change reaches main.",
    ]);
  }
  mustRunJson([
    "contract", "create", "--root", project,
    "--phase", "implementation",
    "--story", STORY_ID,
    "--id", "CONTRACT-EXTERNAL",
    "--delivery-profile", PROFILE_ID,
    "--level", "bounded-autonomous",
    "--context-summary", "Implement the change inside the delivery boundary.",
    "--qa", "Who merges?|A person, on GitHub",
    "--output-ref", "implementation-summary:implementation-summary-v1:new",
    "--tool", "node",
  ]);
  mustRunJson(["contract", "approve", "--root", project, "--id", "CONTRACT-EXTERNAL", ...humanApproval("Approve the contract")]);
  mustRun(["dependency", "propose", "--root", project, "--id", "DEP-MERGED", "--edge", `${DOWNSTREAM_ID}:${STORY_ID}:blocks:implementation:merged`]);
  mustRun(["dependency", "approve", "--root", project, "--id", "DEP-MERGED", ...humanApproval("The follow-up waits for the merge")]);

  commitFile(project, "src/change.txt", "the change\n", "feat: the change");
  commitFile(project, "src/implementation-summary.md", "# Implementation summary\n", "docs: implementation summary");
  mustRunJson([
    "autonomy", "delivery", "propose", "--root", project,
    "--id", PROFILE_ID,
    "--delivery", `PR-${PR_NUMBER}`,
    "--kind", "pull_request",
    "--pr-mode", "existing",
    "--pr-number", PR_NUMBER,
    "--pr-url", PR_URL,
    "--story", STORY_ID,
    "--contract", "CONTRACT-EXTERNAL",
    "--requirement", "REQ-EXTERNAL",
    "--level", "checkpointed",
    "--repository", "aantenore/agentic-sdlc",
    "--base", "main",
    "--head", HEAD_BRANCH,
    "--write-path", "src",
    "--code-review", codeReview,
    "--code-review-actor-type", "human",
    "--code-review-approval-source", "explicit-user",
    "--code-review-summary", codeReview === "required" ? "Sì, revisione prima del merge" : "No, nessuna revisione",
  ]);
  mustRunJson(["autonomy", "delivery", "approve", "--root", project, "--id", PROFILE_ID, ...humanApproval("Approve the delivery")]);

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
  mustRun(["story", "claim", "--root", project, "--id", STORY_ID, "--agent", "codex", "--branch", HEAD_BRANCH]);
  return project;
}

function reconcileArgs(project, extra = []) {
  return [
    "autonomy", "delivery", "reconcile", "--root", project,
    "--id", PROFILE_ID,
    "--pr-url", PR_URL,
    ...humanApproval("Maria merged it on GitHub after the demo"),
    ...extra,
  ];
}

function deliveryStatus(project) {
  return mustRunJson(["autonomy", "delivery", "status", "--root", project, "--id", PROFILE_ID]);
}

function dependencyBlockers(project) {
  return mustRunJson(["dependency", "status", "--root", project, "--story", DOWNSTREAM_ID]).blockers;
}

function executionFiles(project) {
  const root = path.join(project, ".sdlc", "autonomy", "executions", PROFILE_ID);
  const recorded = new Set(["start.json", "close.json", "external-merge.json"]);
  return fs.existsSync(root) ? fs.readdirSync(root).filter((name) => recorded.has(name)).sort() : [];
}

test("a person acknowledges a merge made on GitHub and the story counts as merged", () => {
  const project = prepareDelivery();
  const headSha = git(project, ["rev-parse", "HEAD"]);
  assert.match(dependencyBlockers(project).join("\n"), /requires merged/u, "the follow-up waits while the PR is open");

  // Status finds the merge in git and names the command; it records nothing.
  git(project, ["update-ref", "refs/remotes/origin/main", headSha]);
  const status = mustRunJson(["status", "--root", project]);
  assert.equal(status.merged_outside_plugin?.length, 1);
  assert.equal(status.merged_outside_plugin[0].profile_id, PROFILE_ID);
  assert.equal(status.merged_outside_plugin[0].head_sha, headSha);
  assert.match(status.merged_outside_plugin[0].command, /autonomy delivery reconcile --id AUT-EXTERNAL/u);
  assert.deepEqual(executionFiles(project), ["start.json"]);

  const recorded = mustRunJson(reconcileArgs(project), { env: mergedOnGitHub(project, { headSha }) });
  assert.equal(recorded.status, "reconciled");
  assert.equal(recorded.terminal_status, "merged_externally");
  const receipt = recorded.external_merge;
  assert.equal(receipt.pull_request.merge_commit_sha, MERGE_SHA);
  assert.equal(receipt.pull_request.merged_by, "maria");
  assert.equal(receipt.pull_request.head_sha, headSha);
  assert.equal(receipt.reason, "Maria merged it on GitHub after the demo");
  assert.equal(receipt.recorded_by.type, "human");
  assert.equal(receipt.approval.approved_by.type, "human");
  assert.equal(recorded.close_receipt.terminal_status, "merged_externally");
  assert.equal(recorded.close_receipt.terminal_action_receipt_ref.id, receipt.id);
  assert.deepEqual(executionFiles(project), ["close.json", "external-merge.json", "start.json"]);

  const delivery = deliveryStatus(project);
  assert.equal(JSON.stringify(delivery).includes("merged_externally"), true);
  assert.deepEqual(dependencyBlockers(project), [], "the merged dependency is satisfied");
  // A final receipt that no longer verifies (for example because the dependent
  // story edited files it certified) does not undo a verified merge.
  const finalReceiptPath = path.join(project, ".sdlc", "gates", `${STORY_ID}-final.json`);
  fs.mkdirSync(path.dirname(finalReceiptPath), { recursive: true });
  fs.writeFileSync(finalReceiptPath, "{ stale", "utf8");
  assert.deepEqual(dependencyBlockers(project), [], "a stale upstream certification keeps the merge satisfied");
  fs.rmSync(finalReceiptPath);
  const afterStatus = mustRunJson(["status", "--root", project]);
  assert.equal(afterStatus.merged_outside_plugin, undefined, "an acknowledged merge is no longer reported");

  // Repeating it is harmless and rewrites nothing.
  const before = fs.readFileSync(path.join(project, receipt.id ? recorded.external_merge_path : ""), "utf8");
  const again = mustRunJson(reconcileArgs(project), { env: mergedOnGitHub(project, { headSha }) });
  assert.equal(again.status, "already_reconciled");
  assert.equal(fs.readFileSync(path.join(project, recorded.external_merge_path), "utf8"), before);

  // The plugin's own close cannot claim it.
  mustRefuse([
    "autonomy", "delivery", "close", "--root", project, "--id", PROFILE_ID,
    "--status", "merged_externally", ...humanApproval("Close it"),
  ], /./u);
});

test("a merge whose head carries commits the plugin never covered is refused", () => {
  const project = prepareDelivery();
  commitFile(project, "src/late.txt", "pushed straight to the PR\n", "feat: an unverified follow-up");
  const mergedHead = git(project, ["rev-parse", "HEAD"]);
  const refused = mustRefuse(reconcileArgs(project), /is not the head .* covered by the plugin's receipts/u, {
    env: mergedOnGitHub(project, { headSha: mergedHead }),
  });
  assert.match(refused.stderr, /commits no plugin receipt covers/u);
  assert.deepEqual(executionFiles(project), ["start.json"], "nothing is recorded");
  assert.match(dependencyBlockers(project).join("\n"), /requires merged/u);
});

test("a merge into another base branch or before the plugin's last action is refused", () => {
  const project = prepareDelivery();
  const headSha = git(project, ["rev-parse", "HEAD"]);
  mustRefuse(reconcileArgs(project), /merged into release, not the approved main/u, {
    env: mergedOnGitHub(project, { headSha, base: "release" }),
  });
  mustRefuse(reconcileArgs(project), /merged before the last action the plugin recorded/u, {
    env: mergedOnGitHub(project, { headSha, mergedAt: "2000-01-01T00:00:00Z" }),
  });
  mustRefuse(
    ["autonomy", "delivery", "reconcile", "--root", project, "--id", PROFILE_ID, "--pr-url", "https://github.com/aantenore/agentic-sdlc/pull/1", ...humanApproval("Wrong PR")],
    /is not the pull request the plugin verified/u,
    { env: mergedOnGitHub(project, { headSha }) },
  );
  assert.deepEqual(executionFiles(project), ["start.json"]);
});

test("a pull request that is not merged yet cannot be acknowledged", () => {
  const project = prepareDelivery();
  const headSha = git(project, ["rev-parse", "HEAD"]);
  mustRefuse(reconcileArgs(project), /is not merged on GitHub \(state OPEN\)/u, {
    env: mergedOnGitHub(project, { headSha, state: "OPEN" }),
  });
  mustRefuse([...reconcileArgs(project), "--locale", "it"], /Si può prendere in carico solo un merge confermato da GitHub/u, {
    env: mergedOnGitHub(project, { headSha, state: "OPEN" }),
  });
  assert.deepEqual(executionFiles(project), ["start.json"]);
});

test("a required code review applies to the merged head as it would to a governed merge", () => {
  const project = prepareDelivery({ codeReview: "required" });
  const headSha = git(project, ["rev-parse", "HEAD"]);
  mustRefuse(reconcileArgs(project), /no approved code review exists for head/u, {
    env: mergedOnGitHub(project, { headSha }),
  });
  assert.deepEqual(executionFiles(project), ["start.json"]);

  mustRunJson([
    "review", "record", "--root", project,
    "--delivery", PROFILE_ID,
    "--verdict", "approved",
    "--actor", REVIEWER.actor,
    "--actor-type", "human",
  ], {
    env: {
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: REVIEWER.name,
      GIT_CONFIG_KEY_1: "user.email",
      GIT_CONFIG_VALUE_1: REVIEWER.email,
    },
  });
  const recorded = mustRunJson(reconcileArgs(project), { env: mergedOnGitHub(project, { headSha }) });
  assert.equal(recorded.terminal_status, "merged_externally");
  assert.equal(recorded.external_merge.code_review.required, true);
});

test("an agent cannot acknowledge a merge", () => {
  const project = prepareDelivery();
  const headSha = git(project, ["rev-parse", "HEAD"]);
  const refused = mustRefuse(reconcileArgs(project), /cannot run inside an agent session/u, {
    env: { ...mergedOnGitHub(project, { headSha }), CLAUDECODE: "1" },
  });
  assert.match(refused.stderr, /autonomy delivery reconcile --id AUT-EXTERNAL/u);
  mustRefuse(
    ["autonomy", "delivery", "reconcile", "--root", project, "--id", PROFILE_ID, "--pr-url", PR_URL, "--actor-type", "agent", "--summary", "I saw it merged"],
    /needs --actor-type human or ci|formal approval|human/u,
    { env: mergedOnGitHub(project, { headSha }) },
  );
  assert.deepEqual(executionFiles(project), ["start.json"]);

});

test("a delivery closed as ready for review keeps its close and gains the acknowledgement", () => {
  const project = prepareDelivery();
  const headSha = git(project, ["rev-parse", "HEAD"]);
  const update = [
    "autonomy", "delivery", "action", "--root", project,
    "--id", PROFILE_ID,
    "--action", "pull_request.update",
    "--pr-url", PR_URL,
    "--expected-pr-state", "ready",
  ];
  const authorization = mustRunJson([...update, "--confirm-action", ...humanApproval("Mark the pull request ready")], {
    env: mergedOnGitHub(project, { headSha, state: "OPEN", draft: true }),
  });
  const updatedAt = new Date(Date.parse(authorization.action_receipt.authorized_at) + 1_000).toISOString();
  mustRunJson([...update, "--outcome", "passed", "--evidence", "src/change.txt"], {
    env: mergedOnGitHub(project, { headSha, state: "OPEN", updatedAt }),
  });
  mustRunJson([
    "autonomy", "delivery", "close", "--root", project, "--id", PROFILE_ID,
    "--terminal-status", "ready_for_review",
    "--reason", "Handed over for review on GitHub.",
  ]);
  const closePath = path.join(project, ".sdlc", "autonomy", "executions", PROFILE_ID, "close.json");
  const closeBefore = fs.readFileSync(closePath, "utf8");
  assert.match(dependencyBlockers(project).join("\n"), /requires merged/u, "ready for review is not merged");

  const recorded = mustRunJson(reconcileArgs(project), {
    env: mergedOnGitHub(project, { headSha, mergedAt: new Date(Date.now() + 2_000).toISOString() }),
  });
  assert.equal(recorded.terminal_status, "ready_for_review");
  assert.equal(recorded.close_receipt, null);
  assert.equal(recorded.external_merge.delivery_status_at_reconcile, "ready_for_review");
  assert.equal(fs.readFileSync(closePath, "utf8"), closeBefore, "the existing close is never rewritten");
  assert.deepEqual(dependencyBlockers(project), []);
});
