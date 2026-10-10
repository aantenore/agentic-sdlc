import "./helpers/test-isolation.mjs";

import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Two stories start from the same main and both change src/index.ts. The
// first merges; the second branch is fast-forwarded onto main to pick it up.
// The second story's perimeter must hold its own commits only.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(repoRoot, "bin", "agentic-sdlc.mjs");
const providerCommandShim = path.join(repoRoot, "test", "helpers", "provider-command-shim.cjs");
const tempPaths = new Set();
const AUTHOR = Object.freeze({ name: "Change Author", email: "author@example.invalid" });
const PR_A = "https://github.com/aantenore/agentic-sdlc/pull/999981";
const BRANCH_A = "codex/story-a";
const BRANCH_B = "codex/story-b";
const SCOPE_ERROR = /outside the approved requirement write paths/u;

after(() => {
  if (process.env.AGENTIC_SDLC_KEEP_TEST_TMP === "1") return;
  for (const entry of tempPaths) fs.rmSync(entry, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function tmpDirectory(name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `sdlc-parallel-stories-${name}-`));
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

function writeFile(project, relativePath, contents) {
  fs.mkdirSync(path.dirname(path.join(project, relativePath)), { recursive: true });
  fs.writeFileSync(path.join(project, relativePath), contents, "utf8");
}

function commitFiles(project, files, message) {
  for (const [relativePath, contents] of Object.entries(files)) writeFile(project, relativePath, contents);
  git(project, ["add", "--", ...Object.keys(files)]);
  git(project, ["commit", "-m", message]);
  return git(project, ["rev-parse", "HEAD"]);
}

/** GitHub as a person left it: pull request A merged as `mergeSha`. */
function mergedOnGitHub(project, headSha, mergeSha) {
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
    AUTONOMY_FAKE_GH_STATE: "MERGED",
    AUTONOMY_FAKE_GH_URL: PR_A,
    AUTONOMY_FAKE_GH_DRAFT: "false",
    AUTONOMY_FAKE_GH_UPDATED_AT: "",
    AUTONOMY_FAKE_GH_HEAD_SHA: headSha,
    AUTONOMY_FAKE_GH_HEAD: BRANCH_A,
    AUTONOMY_FAKE_GH_BASE: "main",
    AUTONOMY_FAKE_GH_BASE_SHA: git(project, ["rev-parse", "refs/remotes/origin/main"]),
    AUTONOMY_FAKE_GH_MERGED_AT: new Date(Date.now() + 1000).toISOString(),
    AUTONOMY_FAKE_GH_MERGE_SHA: mergeSha,
    AUTONOMY_FAKE_GH_MERGED_BY: "maria",
  };
}

function planStory(project, { story, requirement, contract, writePaths }) {
  mustRunJson([
    "requirement", "propose", "--root", project,
    "--id", requirement,
    "--title", `Requirement of ${story}`,
    "--summary", `The change delivered by ${story}.`,
    "--acceptance", "The change reaches main.",
    "--autonomy-ceiling", "bounded-autonomous",
    ...writePaths.flatMap((item) => ["--write-path", item]),
  ]);
  mustRunJson(["requirement", "approve", "--root", project, "--id", requirement, ...humanApproval("Approve the requirement")]);
  mustRunJson([
    "story", "create", "--no-derived-verification", "--root", project,
    "--id", story,
    "--title", `Deliver ${story}`,
    "--phase", "implementation",
    "--status", "ready",
    "--requirement", requirement,
    "--acceptance", "The change reaches main.",
  ]);
  mustRunJson([
    "contract", "create", "--root", project,
    "--phase", "implementation",
    "--story", story,
    "--id", contract,
    "--delivery-profile", `AUT-${story}`,
    "--level", "bounded-autonomous",
    "--context-summary", "Implement the change inside the delivery boundary.",
    "--qa", "Who merges?|A person, on GitHub",
    "--output-ref", "implementation-summary:implementation-summary-v1:new",
    "--tool", "node",
  ]);
  mustRunJson(["contract", "approve", "--root", project, "--id", contract, ...humanApproval("Approve the contract")]);
}

function startDelivery(project, { story, requirement, contract, branch, writePaths, existingPr = null, profileId = `AUT-${story}` }) {
  mustRunJson([
    "autonomy", "delivery", "propose", "--root", project,
    "--id", profileId,
    "--delivery", existingPr ? `PR-${existingPr.split("/").at(-1)}` : `PR-${profileId}`,
    "--kind", "pull_request",
    ...(existingPr
      ? ["--pr-mode", "existing", "--pr-number", existingPr.split("/").at(-1), "--pr-url", existingPr]
      : []),
    "--story", story,
    "--contract", contract,
    "--requirement", requirement,
    "--level", "checkpointed",
    "--repository", "aantenore/agentic-sdlc",
    "--base", "main",
    "--head", branch,
    ...writePaths.flatMap((item) => ["--write-path", item]),
    "--code-review", "not-required",
    "--code-review-actor-type", "human",
    "--code-review-approval-source", "explicit-user",
    "--code-review-summary", "No review needed for this story",
  ]);
  mustRunJson(["autonomy", "delivery", "approve", "--root", project, "--id", profileId, ...humanApproval("Approve the delivery")]);
  const intent = JSON.stringify({
    requested_action: "implement_story",
    confidence: 0.99,
    referenced_entities: [{ type: "story", id: story }],
    provided_artifacts: [],
    missing_context: [],
    proposed_phase: "implementation",
    artifact_type: null,
    skip_phases: [],
  });
  return mustRunJson(["task", "start", "--root", project, "--intent-json", intent, "--delivery-profile", profileId]);
}

function mustStartDelivery(project, story) {
  const started = startDelivery(project, story);
  assert.equal(started.execution_allowed, true, JSON.stringify([started.blocking_reasons, started.questions]));
  return started;
}

const STORY_A = Object.freeze({
  story: "ST-A", requirement: "REQ-A", contract: "CONTRACT-A", branch: BRANCH_A,
  writePaths: ["src/a", "src/index.ts"],
});
const STORY_B = Object.freeze({
  story: "ST-B", requirement: "REQ-B", contract: "CONTRACT-B", branch: BRANCH_B,
  writePaths: ["src/b", "src/index.ts"],
});

/**
 * Story B starts from main; story A starts from the same main, changes
 * src/a and the shared src/index.ts, and is merged on GitHub. Returns with
 * story B's branch checked out, still at the common start.
 */
function storyAMergedWhileBInProgress({ baseline = false } = {}) {
  const project = tmpDirectory("project");
  mustRun(["init", "--root", project, "--project-name", "Parallel Stories E2E", "--force"]);
  applyConfig(project, (config) => {
    config.orchestration_policy = {
      ...config.orchestration_policy,
      coordination: { ...config.orchestration_policy?.coordination, mode: "local_only" },
      status_sync: { ...config.orchestration_policy?.status_sync, mode: "off" },
    };
  });
  git(project, ["init"]);
  git(project, ["config", "core.autocrlf", "false"]);
  git(project, ["config", "user.name", AUTHOR.name]);
  git(project, ["config", "user.email", AUTHOR.email]);
  const start = commitFiles(project, { "src/index.ts": "export {};\n" }, "chore: shared export file");
  git(project, ["branch", "-M", "main"]);
  git(project, ["remote", "add", "origin", "https://github.com/aantenore/agentic-sdlc.git"]);
  git(project, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  if (baseline) {
    mustRunJson(["baseline", "propose", "--root", project, "--id", "BASELINE-MAIN", "--source", "src", "--summary", "The shared export file"]);
    mustRunJson(["baseline", "approve", "--root", project, "--id", "BASELINE-MAIN", ...humanApproval("The snapshot is accurate")]);
  }
  mustRun(["output", "template", "propose", "--root", project, "--type", "implementation-summary", "--summary", "Implementation evidence"]);
  mustRun(["output", "template", "approve", "--root", project, "--id", "implementation-summary-v1", ...humanApproval("Approve the format")]);
  planStory(project, STORY_A);
  planStory(project, STORY_B);

  git(project, ["checkout", "-q", "-b", BRANCH_B, start]);
  mustStartDelivery(project, STORY_B);

  // Story A starts from the same main; its pull request is squash-merged on
  // GitHub, which leaves one new commit on main.
  git(project, ["checkout", "-q", "-b", BRANCH_A, start]);
  mustStartDelivery(project, { ...STORY_A, existingPr: PR_A });
  git(project, ["checkout", "-q", "main"]);
  const aHead = commitFiles(project, {
    "src/a/feature.ts": "export const a = 1;\n",
    "src/index.ts": "export * from \"./a/feature\";\n",
  }, "feat: story A (#999981)");
  git(project, ["update-ref", "refs/remotes/origin/main", aHead]);
  const reconciled = mustRunJson([
    "autonomy", "delivery", "reconcile", "--root", project,
    "--id", "AUT-ST-A",
    "--pr-url", PR_A,
    ...humanApproval("Maria merged story A on GitHub"),
  ], { env: mergedOnGitHub(project, start, aHead) });
  assert.equal(reconciled.terminal_status, "merged_externally");

  git(project, ["checkout", "-q", BRANCH_B]);
  assert.equal(git(project, ["rev-parse", "HEAD"]), start);
  return { project, start, aHead };
}

function scopeErrors(project, storyId) {
  const result = run(["gate", "check", "--root", project, "--scope", "story", "--story", storyId, "--strict", "--json"]);
  assert.ok([0, 1].includes(result.status), result.stderr || result.stdout);
  return JSON.parse(result.stdout).errors.filter((error) => SCOPE_ERROR.test(error));
}

function authorizeCommit(project, scopePaths) {
  git(project, ["add", "--", ...scopePaths]);
  return run([
    "autonomy", "delivery", "action", "--root", project,
    "--id", "AUT-ST-B",
    "--action", "git.commit",
    ...scopePaths.flatMap((item) => ["--scope-path", item]),
    "--json",
  ]);
}

test("a branch fast-forwarded onto a merged story keeps only its own commits in its perimeter", () => {
  const { project, aHead } = storyAMergedWhileBInProgress();
  git(project, ["merge", "--ff-only", "-q", "origin/main"]);
  assert.equal(git(project, ["rev-parse", "HEAD"]), aHead);

  // Story B also changes the shared export file: that change is its own.
  commitFiles(project, {
    "src/b/feature.ts": "export const b = 2;\n",
    "src/index.ts": "export * from \"./a/feature\";\nexport * from \"./b/feature\";\n",
  }, "feat: story B");
  assert.deepEqual(scopeErrors(project, "ST-B"), [], "story A's files are not charged to story B");

  // A change story B itself makes outside its scope still counts, even in a
  // file story A delivered.
  commitFiles(project, { "src/a/feature.ts": "export const a = 3;\n" }, "fix: story B edits story A's file");
  const errors = scopeErrors(project, "ST-B");
  assert.equal(errors.length, 1, errors.join("\n"));
  assert.match(errors[0], /approved requirement write paths: src\/a\/feature\.ts /u);
});

test("a path touched outside the scope and then restored is not charged, one left changed is", () => {
  const { project } = storyAMergedWhileBInProgress();
  git(project, ["merge", "--ff-only", "-q", "origin/main"]);
  commitFiles(project, { "src/b/feature.ts": "export const b = 2;\n" }, "feat: story B");
  const original = fs.readFileSync(path.join(project, "src/index.ts"), "utf8");
  commitFiles(project, { ".gitattributes": "* text=auto\n", "package.json": "{}\n", "src/b/one.ts": "export const one = 1;\n" }, "chore: touch files outside the scope");
  assert.equal(scopeErrors(project, "ST-B").length, 1, "touched and left changed is charged");

  // The restoring commit also carries other work, so it is no mirror image.
  writeFile(project, "src/b/two.ts", "export const two = 2;\n");
  git(project, ["rm", "-q", "--", ".gitattributes", "package.json"]);
  git(project, ["add", "--", "src/b/two.ts"]);
  git(project, ["commit", "-q", "-m", "chore: put them back"]);
  assert.equal(fs.readFileSync(path.join(project, "src/index.ts"), "utf8"), original);
  assert.deepEqual(scopeErrors(project, "ST-B"), [], "touched and restored is not charged");
});

test("git.commit accepts a branch that only picked up merged deliveries", () => {
  const { project } = storyAMergedWhileBInProgress();
  git(project, ["merge", "--ff-only", "-q", "origin/main"]);
  writeFile(project, "src/b/feature.ts", "export const b = 2;\n");
  const authorized = authorizeCommit(project, ["src/b/feature.ts"]);
  assert.equal(authorized.status, 0, `${authorized.stdout}\n${authorized.stderr}`);
  assert.equal(JSON.parse(authorized.stdout).status, "authorized");
});

test("git.commit refuses commits on the branch that no merged delivery accounts for", () => {
  const { project, aHead } = storyAMergedWhileBInProgress();
  // Someone pushes straight to main after story A merged.
  git(project, ["checkout", "-q", "main"]);
  git(project, ["merge", "--ff-only", "-q", "origin/main"]);
  const direct = commitFiles(project, { "src/hotfix.ts": "export const fix = true;\n" }, "fix: straight to main");
  git(project, ["update-ref", "refs/remotes/origin/main", direct]);
  git(project, ["checkout", "-q", BRANCH_B]);
  git(project, ["merge", "--ff-only", "-q", "origin/main"]);

  writeFile(project, "src/b/feature.ts", "export const b = 2;\n");
  const refused = authorizeCommit(project, ["src/b/feature.ts"]);
  const combined = `${refused.stdout}\n${refused.stderr}`;
  assert.equal(refused.status, 1, combined);
  assert.match(combined, /git\.commit refused: the branch of story ST-B holds commits after its task start that are neither its own nor part of a merged delivery/u);
  assert.match(combined, new RegExp(`${direct.slice(0, 12)} is on main but no merged delivery accounts for it`, "u"));
  assert.match(combined, new RegExp(`git reset --keep ${aHead.slice(0, 12)}`, "u"));
  assert.doesNotMatch(combined, new RegExp(aHead.slice(0, 12) + " is on main", "u"), "the merged delivery is not foreign");

  // Following the advice clears the refusal.
  git(project, ["reset", "-q", "--keep", aHead]);
  const authorized = authorizeCommit(project, ["src/b/feature.ts"]);
  assert.equal(authorized.status, 0, `${authorized.stdout}\n${authorized.stderr}`);
});

test("a story started on an earlier main starts a replacement delivery after the context was refreshed with a merged story", () => {
  const { project, start, aHead } = storyAMergedWhileBInProgress({ baseline: true });
  // The project context is refreshed on main with story A's merged work.
  git(project, ["checkout", "-q", "main"]);
  git(project, ["merge", "--ff-only", "-q", "origin/main"]);
  const refreshed = mustRunJson(["baseline", "refresh", "--root", project, "--from", "BASELINE-MAIN"]);
  if (refreshed.status !== "approved") {
    mustRunJson(["baseline", "approve", "--root", project, "--id", refreshed.baseline.id, ...humanApproval("The refreshed snapshot is accurate")]);
  }
  git(project, ["checkout", "-q", BRANCH_B]);
  assert.equal(git(project, ["rev-parse", "HEAD"]), start, "story B is still on the earlier main");

  // Story B's first delivery is replaced; the successor starts on the same branch.
  mustRun([
    "autonomy", "delivery", "close", "--root", project,
    "--id", "AUT-ST-B",
    "--terminal-status", "cancelled",
    "--reason", "Replace the delivery after story A merged.",
    ...humanApproval("Cancel the first delivery of story B"),
  ]);
  mustRunJson([
    "contract", "create", "--root", project,
    "--phase", "implementation",
    "--story", "ST-B",
    "--id", "CONTRACT-B2",
    "--delivery-profile", "AUT-ST-B2",
    "--level", "bounded-autonomous",
    "--context-summary", "Continue story B under a replacement delivery.",
    "--qa", "Who merges?|A person, on GitHub",
    "--output-ref", "implementation-summary:implementation-summary-v1:new",
    "--tool", "node",
    "--replace-story-contract",
  ]);
  mustRunJson(["contract", "approve", "--root", project, "--id", "CONTRACT-B2", ...humanApproval("Approve the successor contract")]);
  const successor = startDelivery(project, { ...STORY_B, contract: "CONTRACT-B2", profileId: "AUT-ST-B2" });
  assert.equal(successor.blocking_reasons.includes("baseline_not_ready"), false, JSON.stringify(successor.blocking_reasons));
  assert.equal(successor.execution_allowed, true, JSON.stringify(successor.blocking_reasons));

  // The story's own change to story A's file is still judged against the context.
  writeFile(project, "src/a/feature.ts", "export const a = 9;\n");
  const gate = run(["gate", "check", "--root", project, "--scope", "story", "--story", "ST-B", "--strict", "--json"]);
  assert.ok(JSON.parse(gate.stdout).errors.some((error) => error.includes("src/a/feature.ts")), gate.stdout);
  fs.rmSync(path.join(project, "src", "a"), { recursive: true, force: true });

  // Picking up the merged work later keeps the perimeter to its own commits.
  git(project, ["merge", "--ff-only", "-q", "origin/main"]);
  assert.equal(git(project, ["rev-parse", "HEAD"]), aHead);
  commitFiles(project, {
    "src/b/feature.ts": "export const b = 2;\n",
    "src/index.ts": "export * from \"./a/feature\";\nexport * from \"./b/feature\";\n",
  }, "feat: story B");
  const report = JSON.parse(run(["gate", "check", "--root", project, "--scope", "story", "--story", "ST-B", "--strict", "--json"]).stdout);
  assert.deepEqual(report.errors.filter((error) => SCOPE_ERROR.test(error) || /src\/(?:a|index)/u.test(error)), []);
});

function directCommitOnMain(project, files, message) {
  git(project, ["checkout", "-q", "main"]);
  git(project, ["merge", "--ff-only", "-q", "origin/main"]);
  const direct = commitFiles(project, files, message);
  git(project, ["update-ref", "refs/remotes/origin/main", direct]);
  git(project, ["checkout", "-q", BRANCH_B]);
  git(project, ["merge", "--ff-only", "-q", "origin/main"]);
  return direct;
}

test("commits on main that only touch .sdlc records, or that a revert undoes, never block a story", () => {
  const { project } = storyAMergedWhileBInProgress();
  directCommitOnMain(project, { ".sdlc/notes/from-another-computer.md": "records only\n" }, "chore: records from another computer");
  git(project, ["checkout", "-q", "main"]);
  const mistake = commitFiles(project, { "docs/guide.md": "draft\n" }, "docs: pushed by mistake");
  git(project, ["revert", "--no-edit", mistake]);
  git(project, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  git(project, ["checkout", "-q", BRANCH_B]);
  git(project, ["merge", "--ff-only", "-q", "origin/main"]);

  writeFile(project, "src/b/feature.ts", "export const b = 2;\n");
  const authorized = authorizeCommit(project, ["src/b/feature.ts"]);
  assert.equal(authorized.status, 0, `${authorized.stdout}\n${authorized.stderr}`);
  git(project, ["commit", "-q", "-m", "feat: story B"]);
  assert.deepEqual(scopeErrors(project, "ST-B"), []);
});

test("a commit on main outside any delivery blocks until a person accepts it for the story", () => {
  const { project } = storyAMergedWhileBInProgress();
  const direct = directCommitOnMain(project, {
    "docs/hotfix.md": "release notes\n",
    "src/b/shared.ts": "export const shared = 1;\n",
  }, "docs: straight to main");

  writeFile(project, "src/b/feature.ts", "export const b = 2;\n");
  const refused = authorizeCommit(project, ["src/b/feature.ts"]);
  const combined = `${refused.stdout}\n${refused.stderr}`;
  assert.equal(refused.status, 1, combined);
  assert.match(combined, new RegExp(`story base acknowledge --id ST-B --commit ${direct.slice(0, 12)}`, "u"));
  assert.match(combined, /git revert/u);

  // An agent cannot accept it.
  const byAgent = run([
    "story", "base", "acknowledge", "--root", project, "--id", "ST-B", "--commit", direct,
    "--reason", "Release notes hotfix", "--actor-type", "agent", "--json",
  ]);
  assert.notEqual(byAgent.status, 0, byAgent.stdout);
  const insideAgent = run([
    "story", "base", "acknowledge", "--root", project, "--id", "ST-B", "--commit", direct,
    "--reason", "Release notes hotfix", "--actor-type", "human", "--json",
  ], { env: { CLAUDECODE: "1" } });
  assert.notEqual(insideAgent.status, 0, insideAgent.stdout);

  const accepted = mustRunJson([
    "story", "base", "acknowledge", "--root", project, "--id", "ST-B", "--commit", direct.slice(0, 12),
    "--reason", "Release notes hotfix", "--actor-type", "human",
  ]);
  assert.equal(accepted.status, "acknowledged");
  assert.deepEqual(accepted.acknowledgement.paths, ["docs/hotfix.md", "src/b/shared.ts"]);

  const authorized = authorizeCommit(project, ["src/b/feature.ts"]);
  assert.equal(authorized.status, 0, `${authorized.stdout}\n${authorized.stderr}`);
  git(project, ["commit", "-q", "-m", "feat: story B"]);
  assert.deepEqual(scopeErrors(project, "ST-B"), [], "the accepted commit's files are not charged to story B");

  // The file inside story B's write scope still needs a review before the merge.
  const overlap = mustRunJson(["story", "overlap", "--root", project, "--id", "ST-B"]);
  const unconfirmed = overlap.unconfirmed.map((item) => item.path);
  assert.deepEqual(unconfirmed, ["src/b/shared.ts"], JSON.stringify(overlap));
  mustRunJson(["story", "overlap", "confirm", "--root", project, "--id", "ST-B", ...humanApproval("Checked the shared file")]);
  assert.deepEqual(mustRunJson(["story", "overlap", "--root", project, "--id", "ST-B"]).unconfirmed, []);
});

const gitFails = (project, args) => spawnSync("git", ["-C", project, ...args], { encoding: "utf8", timeout: 60_000 });

function mergeBaseIntoStoryB() {
  const fixture = storyAMergedWhileBInProgress();
  const { project } = fixture;
  commitFiles(project, { "src/b/feature.ts": "export const b = 2;\n" }, "feat: story B");
  const merged = gitFails(project, ["merge", "--no-ff", "--no-commit", "origin/main"]);
  assert.equal(merged.status, 0, merged.stdout + merged.stderr);
  return fixture;
}

test("git.commit of a merge from the base branch charges only what differs from the base", () => {
  const { project } = mergeBaseIntoStoryB();
  writeFile(project, "src/b/more.ts", "export const more = 1;\n");
  const scope = ["src/a/feature.ts", "src/index.ts", "src/b/more.ts"];
  const authorized = authorizeCommit(project, scope);
  assert.equal(authorized.status, 0, `${authorized.stdout}\n${authorized.stderr}`);
  const receipt = JSON.parse(authorized.stdout).action_receipt.action_details;
  assert.deepEqual(receipt.changed_paths, [...scope].sort());
  assert.equal(receipt.merge_from_base.schema_version, "merge-from-base:v1");
  assert.equal(receipt.merge_from_base.merge_head_sha, git(project, ["rev-parse", "origin/main"]));
  assert.deepEqual(receipt.merge_from_base.excluded_paths, ["src/a/feature.ts", "src/b/feature.ts", "src/index.ts"].filter((item) => scope.includes(item)));

  // The merge commit is made as a normal git commit and the completion proves it.
  git(project, ["commit", "-q", "-m", "merge: pick up main"]);
  const completed = run([
    "autonomy", "delivery", "action", "--root", project, "--id", "AUT-ST-B",
    "--action", "git.commit", "--outcome", "passed", "--evidence", "src/b/more.ts", "--json",
  ]);
  assert.equal(completed.status, 0, `${completed.stdout}\n${completed.stderr}`);
  assert.equal(JSON.parse(completed.stdout).status, "completed");
});

test("git.commit of a merge from the base branch still refuses the story's own files outside the scope", () => {
  const { project } = mergeBaseIntoStoryB();
  writeFile(project, "src/other/leak.ts", "export const leak = 1;\n");
  const refused = authorizeCommit(project, ["src/a/feature.ts", "src/index.ts", "src/other/leak.ts"]);
  const combined = `${refused.stdout}\n${refused.stderr}`;
  assert.equal(refused.status, 1, combined);
  assert.match(combined, /outside the approved write scope: src\/other\/leak\.ts\./u);
  assert.doesNotMatch(combined, /scope: [^.]*src\/a\/feature\.ts/u);
});

test("git.commit of a merge from a branch that is not the base keeps the usual scope check", () => {
  const { project, start } = storyAMergedWhileBInProgress();
  commitFiles(project, { "src/b/feature.ts": "export const b = 2;\n" }, "feat: story B");
  git(project, ["checkout", "-q", "-b", "side", start]);
  // Same bytes as the base's copy, but they arrive from a branch the profile does not name.
  commitFiles(project, { "src/a/feature.ts": "export const a = 1;\n" }, "feat: side copy");
  git(project, ["checkout", "-q", BRANCH_B]);
  const merged = gitFails(project, ["merge", "--no-ff", "--no-commit", "side"]);
  assert.equal(merged.status, 0, merged.stdout + merged.stderr);
  const refused = authorizeCommit(project, ["src/a/feature.ts"]);
  const combined = `${refused.stdout}\n${refused.stderr}`;
  assert.equal(refused.status, 1, combined);
  assert.match(combined, /outside the approved write scope: src\/a\/feature\.ts\./u);
});

test("story scope check does not charge the story with files a merge of the base brought in", () => {
  const { project } = mergeBaseIntoStoryB();
  const clear = JSON.parse(mustRun(["story", "scope", "check", "--root", project, "--id", "ST-B", "--json"]).stdout);
  assert.deepEqual(clear.out_of_scope, []);
  assert.ok(clear.merge_from_base.excluded_paths.includes("src/a/feature.ts"));
  writeFile(project, "src/other/leak.ts", "export const leak = 1;\n");
  const result = run(["story", "scope", "check", "--root", project, "--id", "ST-B", "--json"]);
  const leak = JSON.parse(result.stdout);
  assert.deepEqual(leak.out_of_scope.map((item) => item.path), ["src/other/leak.ts"]);
});
