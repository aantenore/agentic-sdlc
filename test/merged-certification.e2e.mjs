import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPOSITORY_ROOT, "bin", "agentic-sdlc.mjs");
const PROVIDER_COMMAND_SHIM = path.join(REPOSITORY_ROOT, "test", "helpers", "provider-command-shim.cjs");
const REPOSITORY = "aantenore/agentic-sdlc";
const REMOTE_URL = `https://github.com/${REPOSITORY}.git`;
const DEFAULT_WRITE_PATHS = Object.freeze(["docs", "src"]);
const CI_ACTOR = ["--actor", "workflow-e2e-ci", "--actor-type", "ci"];
const TEMPORARY_PATHS = new Set();

after(() => {
  if (process.env.AGENTIC_SDLC_KEEP_TEST_TMP === "1") return;
  for (const entry of TEMPORARY_PATHS) {
    fs.rmSync(entry, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
  TEMPORARY_PATHS.clear();
});

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

function temporaryDirectory(label) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `agentic-sdlc-merged-${label}-`));
  TEMPORARY_PATHS.add(directory);
  return directory;
}

function run(args, project, options = {}) {
  const env = { ...process.env };
  for (const key of ["CI", "GITHUB_ACTIONS", "GITHUB_ACTOR", "CODEX_AGENT_NAME", "CODEX_THREAD_ID", "CODEX_USER_ID", "CLAUDECODE", "AGENTIC_SDLC_AGENT_HOST"]) {
    delete env[key];
  }
  // These scenarios check the full re-verification that fast status skips.
  env.AGENTIC_SDLC_STATUS_CHECKS = "full";
  Object.assign(env, options.env || {});
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: project,
    encoding: "utf8",
    env,
    timeout: options.timeout || 60_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function mustRun(args, project, options = {}) {
  const result = run(args, project, options);
  assert.equal(result.error, undefined, `${args.join(" ")} failed to execute: ${result.error?.message}`);
  assert.equal(
    result.status,
    0,
    `${args.join(" ")}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
  );
  return result;
}

function mustRunJson(args, project, options = {}) {
  return JSON.parse(mustRun([...args, "--json"], project, options).stdout);
}

function mustGit(project, args) {
  const result = spawnSync("git", ["-C", project, ...args], { encoding: "utf8", timeout: 60_000 });
  assert.equal(result.error, undefined, `git ${args.join(" ")} failed: ${result.error?.message}`);
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
  );
  return result.stdout.trim();
}

function writeProjectFile(project, relativePath, contents) {
  const filePath = path.join(project, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
  return relativePath;
}

function readJson(project, relativePath) {
  return JSON.parse(fs.readFileSync(path.join(project, relativePath), "utf8"));
}

function humanApproval(summary) {
  return ["--actor-type", "human", "--approval-source", "explicit-user", "--summary", summary];
}

function implementationIntent(storyId) {
  return JSON.stringify({
    requested_action: "implement_story",
    confidence: 0.99,
    referenced_entities: [{ type: "story", id: storyId }],
    provided_artifacts: [],
    missing_context: [],
    proposed_phase: "implementation",
    artifact_type: null,
    skip_phases: [],
  });
}

function applyProjectConfig(project, change) {
  const configPath = path.join(project, ".sdlc", "config.json");
  const config = readJson(project, ".sdlc/config.json");
  change(config);
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  const preview = mustRunJson(["config", "migrate", "--root", project], project);
  mustRunJson([
    "config", "migrate", "--root", project,
    "--apply", "--plan-hash", preview.plan.plan_hash, "--actor-type", "system",
  ], project);
}

function appendTrace(project, storyId, type, outcome, evidence) {
  mustRun([
    "trace", "append", "--root", project,
    "--story", storyId,
    "--type", type,
    "--outcome", outcome,
    "--summary", `${type} attempt ${outcome}`,
    "--evidence", evidence,
    "--actor", "codex",
    "--actor-type", "agent",
  ], project);
}

// ---------------------------------------------------------------------------
// Git fixtures
// ---------------------------------------------------------------------------

function initializeGitProject(project, { projectName = "Merged certification", claimsRemote = null, storyRecords = null } = {}) {
  mustRun(["init", "--root", project, "--project-name", projectName], project);
  // The test remote is a public repository the test cannot write to, so claims
  // stay on this computer (or go to a local bare repository standing in for
  // the team's remote) and status is never synced through it.
  applyProjectConfig(project, (config) => {
    config.orchestration_policy = {
      ...config.orchestration_policy,
      coordination: claimsRemote
        ? { ...config.orchestration_policy?.coordination, mode: "required", remote: "claims" }
        : { ...config.orchestration_policy?.coordination, mode: "local_only" },
      status_sync: { ...config.orchestration_policy?.status_sync, mode: "off" },
      ...(storyRecords ? { story_records: storyRecords } : {}),
    };
  });
  mustGit(project, ["init"]);
  mustGit(project, ["config", "core.autocrlf", "false"]);
  mustGit(project, ["config", "user.name", "Merged Certification E2E"]);
  mustGit(project, ["config", "user.email", "merged-certification-e2e@example.invalid"]);
  writeProjectFile(project, "src/index.mjs", "export const ready = true;\n");
  writeProjectFile(project, "docs/baseline.md", "# Baseline\n");
  mustGit(project, ["add", "."]);
  mustGit(project, ["commit", "-m", "test: establish governed baseline"]);
  mustGit(project, ["branch", "-M", "main"]);
  mustGit(project, ["remote", "add", "origin", REMOTE_URL]);
  mustGit(project, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  if (claimsRemote) {
    mustGit(project, ["remote", "add", "claims", claimsRemote]);
    mustGit(project, ["push", "--quiet", "claims", "main"]);
    mustGit(project, ["fetch", "--quiet", "claims"]);
    mustGit(project, ["remote", "set-head", "claims", "main"]);
  }
}

/** Deterministic pull request number per suffix, so two stories never collide. */
function pullRequestNumber(suffix) {
  let hash = 0;
  for (const character of suffix) hash = (hash * 31 + character.charCodeAt(0)) % 90_000;
  return String(100_000 + hash);
}

/** Commits exactly `paths`; governed `.sdlc` records stay out of the commit. */
function commitPaths(project, paths, message) {
  mustGit(project, ["add", "--", ...paths]);
  mustGit(project, ["commit", "-m", message]);
  return mustGit(project, ["rev-parse", "HEAD"]);
}

// ---------------------------------------------------------------------------
// Fake GitHub
// ---------------------------------------------------------------------------

/**
 * Environment that makes `gh` answer from AUTONOMY_FAKE_GH_* values.
 * `story` supplies the PR url and head branch; `values` the remote state.
 */
function fakeGitHubEnv(project, story, values) {
  const fakeBin = temporaryDirectory("gh");
  const executable = path.join(fakeBin, process.platform === "win32" ? "gh.exe" : "gh");
  fs.copyFileSync(fs.realpathSync.native(process.execPath), executable, fs.constants.COPYFILE_FICLONE);
  if (process.platform !== "win32") fs.chmodSync(executable, 0o755);
  const requireOption = /\s/u.test(PROVIDER_COMMAND_SHIM)
    ? `--require=${JSON.stringify(PROVIDER_COMMAND_SHIM)}`
    : `--require=${PROVIDER_COMMAND_SHIM}`;
  const merged = values.state === "MERGED";
  return {
    AUTONOMY_FAKE_PROVIDER: "gh",
    NODE_OPTIONS: [process.env.NODE_OPTIONS, requireOption].filter(Boolean).join(" "),
    PATH: [fakeBin, process.env.PATH].filter(Boolean).join(path.delimiter),
    AUTONOMY_FAKE_GH_STATE: values.state,
    AUTONOMY_FAKE_GH_URL: story.prUrl,
    AUTONOMY_FAKE_GH_DRAFT: String(values.isDraft ?? false),
    AUTONOMY_FAKE_GH_UPDATED_AT: values.updatedAt || "",
    AUTONOMY_FAKE_GH_HEAD_SHA: values.headSha,
    AUTONOMY_FAKE_GH_HEAD: story.branch,
    AUTONOMY_FAKE_GH_BASE: "main",
    AUTONOMY_FAKE_GH_BASE_SHA: values.baseSha
      ?? mustGit(project, ["rev-parse", "refs/remotes/origin/main"]),
    AUTONOMY_FAKE_GH_MERGED_AT: merged ? values.mergedAt : "",
    AUTONOMY_FAKE_GH_MERGE_SHA: merged ? values.mergeSha : "",
    AUTONOMY_FAKE_GH_MERGED_BY: merged ? (values.mergedBy || "maria") : "",
  };
}

// ---------------------------------------------------------------------------
// Story sealing
// ---------------------------------------------------------------------------

/**
 * Walks one pull_request story through the whole governed workflow until
 * `gate check --strict --story <id> --lifecycle-complete` passes and the
 * delivery is closed as ready_for_review. Branches from the current HEAD
 * (`main` for the first story; call `mergeIntoMain` first for later ones,
 * passing `existingProject: true`).
 *
 * Returns the identifiers later helpers need: storyId, requirementId,
 * contractId, profileId, workflowInstanceId, branch, prUrl, prNumber,
 * baseSha (task-start base), headSha (the head the plugin covered),
 * actionReceipt (the pull_request.update completion), closeReceipt and
 * certification (the passing gate report).
 */
function sealPullRequestStory(project, {
  suffix,
  files = { "src/feature.mjs": "export const feature = 1;\n" },
  writePaths = DEFAULT_WRITE_PATHS,
  existingProject = false,
  claimsRemote = null,
  includeRecords = false,
  storyRecords = null,
} = {}) {
  assert.ok(suffix, "suffix is required");
  const requirementId = `REQ-${suffix}`;
  const storyId = `ST-${suffix}`;
  const contractId = `CONTRACT-${suffix}`;
  const profileId = `AUT-${suffix}`;
  const workflowInstanceId = `delivery-${suffix.toLowerCase()}`;
  const branch = `codex/${storyId}`;
  const prNumber = pullRequestNumber(suffix);
  const prUrl = `https://github.com/${REPOSITORY}/pull/${prNumber}`;
  const evidenceDir = writePaths[0];
  const authorizationId = `AUTH-${suffix}-STORY-ACTIONS`;

  if (!existingProject) initializeGitProject(project, { claimsRemote, storyRecords });
  mustGit(project, ["checkout", "-b", branch]);

  mustRun([
    "requirement", "propose", "--root", project,
    "--id", requirementId,
    "--title", `Govern ${suffix}`,
    "--summary", `Implement ${suffix} only inside its exact approved write scope.`,
    "--acceptance", `The ${suffix} story has verified implementation and delivery evidence.`,
    "--autonomy-ceiling", "supervised",
    ...writePaths.flatMap((writePath) => ["--write-path", writePath]),
  ], project);
  mustRun([
    "requirement", "approve", "--root", project, "--id", requirementId,
    ...humanApproval(`Approve ${requirementId}`),
  ], project);

  // The output format is project-wide: propose it once.
  if (!existingProject) {
    mustRun([
      "output", "template", "propose", "--root", project,
      "--type", "implementation-summary",
      "--summary", "Canonical implementation-summary output format",
    ], project);
    mustRun([
      "output", "template", "approve", "--root", project,
      "--id", "implementation-summary-v1",
      ...humanApproval("Approve implementation-summary output format"),
    ], project);
  }

  mustRun([
    "story", "create", "--root", project,
    "--id", storyId,
    "--title", `Implement ${suffix}`,
    "--phase", "implementation",
    "--status", "ready",
    "--requirement", requirementId,
    "--acceptance", `Observable evidence exists for ${suffix}.`,
  ], project);
  mustRun([
    "contract", "create", "--root", project,
    "--id", contractId,
    "--story", storyId,
    "--phase", "implementation",
    "--delivery-profile", profileId,
    "--level", "supervised",
    "--context-summary", `Implement ${storyId} inside the approved requirement boundary.`,
    "--qa", "Who confirms the exact delivery?|The human reviewer",
    "--tool", "node",
    "--output-ref", "implementation-summary:implementation-summary-v1:new",
  ], project);
  mustRun(["contract", "approve", "--root", project, "--id", contractId, ...humanApproval(`Approve ${contractId}`)], project);

  mustRun([
    "autonomy", "delivery", "propose", "--root", project,
    "--id", profileId,
    "--delivery", `PR-${prNumber}`,
    "--kind", "pull_request",
    "--pr-mode", "existing",
    "--pr-number", prNumber,
    "--pr-url", prUrl,
    "--story", storyId,
    "--contract", contractId,
    "--requirement", requirementId,
    "--level", "supervised",
    "--repository", REPOSITORY,
    "--base", "main",
    "--head", branch,
    ...writePaths.flatMap((writePath) => ["--write-path", writePath]),
    "--code-review", "not-required",
    "--code-review-actor-type", "human",
    "--code-review-approval-source", "explicit-user",
    "--code-review-summary", "No review needed for this story",
    "--allow-action", "repository.read",
    "--allow-action", "repository.write",
    "--allow-action", "test.run",
    "--allow-action", "pull_request.update",
  ], project);
  mustRun([
    "autonomy", "delivery", "approve", "--root", project,
    "--id", profileId, "--phase", "implementation",
    ...humanApproval(`Approve ${profileId}`),
  ], project);

  mustRun([
    "workflow", "instance", "start", "--root", project,
    "--id", workflowInstanceId,
    "--definition", "software-project",
    "--definition-version", "3",
    "--story", storyId,
    ...CI_ACTOR,
  ], project);
  const taskStart = mustRunJson([
    "task", "start", "--root", project,
    "--intent-json", implementationIntent(storyId),
    "--story", storyId,
    "--phase", "implementation",
    "--contract-id", contractId,
    "--delivery-profile", profileId,
    "--confirm-start",
    "--actor-type", "human",
  ], project);
  assert.equal(taskStart.execution_allowed, true, JSON.stringify(taskStart, null, 2));
  const baseSha = mustGit(project, ["rev-parse", "HEAD"]);

  mustRun([
    "authorization", "grant", "--root", project,
    "--id", authorizationId,
    "--scope", `Approve the exact governed story actions for ${storyId}.`,
    "--allow-use", `story.claim=${storyId}`,
    "--allow-use", `output.link=${storyId}`,
    "--allow-use", `story.complete-step=${storyId}`,
    "--allow-artifact-type", "implementation-summary",
    "--max-uses", "12",
    ...humanApproval(`Approve the exact governed story actions for ${storyId}`),
  ], project);
  mustRun([
    "story", "claim", "--root", project,
    "--id", storyId, "--agent", "codex", "--branch", branch,
    "--authorization", authorizationId,
  ], project);

  const transition = (to) => mustRun([
    "workflow", "instance", "transition", "--root", project,
    "--id", workflowInstanceId, "--to", to,
    "--request-id", `${workflowInstanceId}-${to}`,
    ...CI_ACTOR,
  ], project);
  const completeStep = (step, extra = []) => mustRun([
    "story", "complete-step", "--root", project,
    "--id", storyId,
    "--step", step,
    "--summary", `${step} completed against the approved boundary`,
    ...extra,
    "--authorization", authorizationId,
  ], project);

  // Implementation: the story's files and its implementation summary.
  for (const [relativePath, contents] of Object.entries(files)) {
    writeProjectFile(project, relativePath, contents);
  }
  const summaryArtifact = writeProjectFile(
    project,
    `${evidenceDir}/implementation-summary-${suffix.toLowerCase()}.md`,
    `# Implementation summary\n\n${suffix} is complete.\n`,
  );
  mustRun([
    "output", "link", "--root", project,
    "--story", storyId,
    "--type", "implementation-summary",
    "--artifact", summaryArtifact,
    "--template", "implementation-summary-v1",
    "--mode", "new",
    "--requirement", requirementId,
    "--authorization", authorizationId,
  ], project);
  for (const [step, next] of [
    ["discovery", "analysis"],
    ["analysis", "design"],
    ["design", "implementation"],
    ["implementation", "validation"],
  ]) {
    completeStep(step, step === "implementation" ? ["--type", "implementation-summary"] : []);
    transition(next);
  }

  // Validation.
  const testEvidence = writeProjectFile(project, `.sdlc/tests/${storyId}-test.json`, "{\"passed\":true}\n");
  appendTrace(project, storyId, "test", "passed", testEvidence);
  completeStep("validation", ["--evidence", testEvidence]);
  mustRun(["secret", "scan", "--root", project, "--story", storyId], project);
  mustRunJson(["gate", "check", "--root", project, "--strict", "--story", storyId], project);
  transition("release");

  // Release: commit the reviewed head, mark the existing PR ready, close the
  // delivery as ready for review.
  const proof = writeProjectFile(
    project,
    `${evidenceDir}/pr-update-proof-${suffix.toLowerCase()}.txt`,
    "exact reviewed head marked ready\n",
  );
  const headSha = commitPaths(
    project,
    [...Object.keys(files), summaryArtifact, proof, ...(includeRecords ? [".sdlc"] : [])],
    `feat: ${suffix.toLowerCase()}`,
  );
  const story = { storyId, profileId, branch, prUrl, headSha };
  const update = [
    "autonomy", "delivery", "action", "--root", project,
    "--id", profileId,
    "--action", "pull_request.update",
    "--pr-url", prUrl,
    "--expected-pr-state", "ready",
  ];
  const draftState = { state: "OPEN", headSha, isDraft: true };
  const authorization = mustRunJson([
    ...update, "--confirm-action",
    ...humanApproval(`Approve marking ${prUrl} ready for review`),
  ], project, { env: fakeGitHubEnv(project, story, draftState) });
  assert.equal(authorization.status, "authorized");
  const updatedAt = new Date(Date.parse(authorization.action_receipt.authorized_at) + 1_000).toISOString();
  const completion = mustRunJson([...update, "--outcome", "passed", "--evidence", proof], project, {
    env: fakeGitHubEnv(project, story, { ...draftState, isDraft: false, updatedAt }),
  });
  assert.equal(completion.status, "completed");
  const closed = mustRunJson([
    "autonomy", "delivery", "close", "--root", project,
    "--id", profileId,
    "--terminal-status", "ready_for_review",
    "--reason", "The pull request is open for review at its verified head.",
  ], project);
  assert.equal(closed.terminal_status, "ready_for_review");

  const releaseEvidence = writeProjectFile(project, `.sdlc/tests/${storyId}-release.json`, "{\"ready\":true}\n");
  appendTrace(project, storyId, "release", "passed", releaseEvidence);
  completeStep("release", ["--evidence", releaseEvidence]);
  transition("operations");
  completeStep("operations");
  mustRun(["secret", "scan", "--root", project, "--story", storyId], project);
  mustRun([
    "story", "release", "--root", project,
    "--id", storyId, "--agent", "codex",
    "--reason", "Release the completed lane before final certification.",
  ], project);
  const certified = mustRunJson([
    "gate", "check", "--root", project,
    "--strict", "--story", storyId, "--lifecycle-complete",
  ], project);
  assert.equal(certified.status, "passed", JSON.stringify(certified, null, 2));

  return {
    ...story,
    requirementId,
    contractId,
    workflowInstanceId,
    prNumber,
    baseSha,
    taskStart,
    actionReceipt: completion.action_receipt,
    closeReceipt: closed.close_receipt,
    certification: certified,
  };
}

// ---------------------------------------------------------------------------
// Merge and reconcile
// ---------------------------------------------------------------------------

/**
 * Merges the story branch into main with a real `--no-ff` merge commit and
 * moves refs/remotes/origin/main to it. Returns the merge commit sha. Main
 * stays checked out so a following story can branch from the merged state.
 */
function mergeIntoMain(project, story, { message = `Merge pull request ${story.prUrl}` } = {}) {
  mustGit(project, ["config", "core.autocrlf", "false"]);
  mustGit(project, ["checkout", "main"]);
  mustGit(project, ["merge", "--no-ff", "-m", message, story.branch]);
  const mergeSha = mustGit(project, ["rev-parse", "HEAD"]);
  assert.equal(
    mustGit(project, ["rev-list", "--parents", "-n", "1", mergeSha]).split(" ").length,
    3,
    "the merge must be a real two-parent merge commit",
  );
  mustGit(project, ["update-ref", "refs/remotes/origin/main", mergeSha]);
  return mergeSha;
}

/**
 * Records the merge made on GitHub. `mergedAt` defaults to just after now,
 * i.e. after the plugin's last action. Returns the reconcile JSON payload.
 */
function reconcileMerged(project, story, mergeSha, {
  headSha = story.headSha,
  mergedAt = new Date(Date.now() + 2_000).toISOString(),
  summary = "Maria merged it on GitHub after the demo",
} = {}) {
  return mustRunJson([
    "autonomy", "delivery", "reconcile", "--root", project,
    "--id", story.profileId,
    "--pr-url", story.prUrl,
    ...humanApproval(summary),
  ], project, {
    env: fakeGitHubEnv(project, story, { state: "MERGED", headSha, mergeSha, mergedAt }),
  });
}

/** The story's orchestrate entry (lifecycle_source, status, reason, ...) and the status payload. */
function lifecycleOf(project, storyId) {
  const status = mustRunJson(["status", "--root", project], project);
  const orchestration = mustRunJson(["orchestrate", "status", "--root", project], project);
  const story = orchestration.stories.find((entry) => entry.id === storyId);
  assert.ok(story, `story ${storyId} must appear in orchestrate status`);
  return { story, status };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Sealing a story walks the whole workflow, so each scenario is built once and
// every test works on its own copy.
const FIXTURES = new Map();

function cloneProject(source, label) {
  const project = temporaryDirectory(label);
  fs.cpSync(source, project, { recursive: true, force: true, preserveTimestamps: true, verbatimSymlinks: true });
  return project;
}

function fixture(name, build) {
  if (!FIXTURES.has(name)) {
    const project = temporaryDirectory(`fixture-${name}`);
    FIXTURES.set(name, { project, ...build(project) });
  }
  const { project: source, ...details } = FIXTURES.get(name);
  return { project: cloneProject(source, name), ...details };
}

/** A story sealed on its branch with its delivery ready for review, never merged. */
function sealedFixture() {
  return fixture("sealed", (project) => ({ story: sealPullRequestStory(project, { suffix: "SEAL-A" }) }));
}

/** A story sealed, merged into main with a real merge commit, and reconciled. */
function mergedFixture() {
  return fixture("merged", (project) => {
    const story = sealPullRequestStory(project, { suffix: "MERGE-A" });
    const mergeSha = mergeIntoMain(project, story);
    const reconciled = reconcileMerged(project, story, mergeSha);
    assert.equal(reconciled.status, "reconciled", JSON.stringify(reconciled, null, 2));
    return { story, mergeSha };
  });
}

/** Merged fixture plus a second story with its own write paths merged after it. */
function laterStoryFixture(name, { writePaths, files }) {
  return fixture(name, (project) => {
    const source = mergedFixture();
    fs.cpSync(source.project, project, { recursive: true, force: true, preserveTimestamps: true, verbatimSymlinks: true });
    const later = sealPullRequestStory(project, {
      suffix: `${name.toUpperCase()}-B`,
      writePaths,
      files,
      existingProject: true,
    });
    const laterMergeSha = mergeIntoMain(project, later);
    assert.equal(reconcileMerged(project, later, laterMergeSha).status, "reconciled");
    return { story: source.story, mergeSha: source.mergeSha, later, laterMergeSha };
  });
}

function assertTerminal(project, storyId, sources) {
  const { story, status } = lifecycleOf(project, storyId);
  assert.ok(sources.includes(story.lifecycle_source), JSON.stringify(story, null, 2));
  assert.equal(story.orchestration_state, "terminal", JSON.stringify(story, null, 2));
  assert.equal(
    (status.merged_but_open || []).some((item) => item.story_id === storyId),
    false,
    JSON.stringify(status.merged_but_open, null, 2),
  );
  return { story, status };
}

function assertInvalid(project, storyId, reason) {
  const { story } = lifecycleOf(project, storyId);
  assert.equal(story.lifecycle_source, "invalid_workflow_final_receipt", JSON.stringify(story, null, 2));
  assert.equal(story.lifecycle_reason, reason, JSON.stringify(story, null, 2));
  return story;
}

// The blocker a person reads when the story is refused.
function claimRefusal(project, storyId) {
  const result = run([
    "story", "claim", "--root", project,
    "--id", storyId, "--agent", "codex",
  ], project);
  assert.notEqual(result.status, 0, result.stdout);
  return `${result.stdout}\n${result.stderr}`;
}

function appendBytes(project, relativePath, text) {
  const filePath = path.join(project, relativePath);
  const original = fs.readFileSync(filePath);
  fs.appendFileSync(filePath, text);
  return () => fs.writeFileSync(filePath, original);
}

function findFile(root, predicate) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(entryPath, predicate);
      if (found) return found;
    } else if (predicate(entryPath)) {
      return entryPath;
    }
  }
  return null;
}

function assertNextActionLeaves(status, storyId) {
  const action = status.next_action || {};
  if (action.story_id !== storyId) return;
  assert.doesNotMatch(String(action.command || ""), /story complete-step|autonomy delivery reconcile/u, JSON.stringify(action, null, 2));
}

test("a sealed story reconciled as merged stays completed", () => {
  const { project, story } = mergedFixture();
  assertTerminal(project, story.storyId, ["workflow_final_receipt_stale", "workflow_final_receipt"]);
});

test("documentation committed after the merge and an untracked note leave the merged story completed", () => {
  const { project, story } = mergedFixture();
  writeProjectFile(project, "docs/baseline.md", "# Baseline\n\nLater documentation.\n");
  commitPaths(project, ["docs/baseline.md"], "docs: later documentation");
  writeProjectFile(project, "docs/archivio/nota.md", "# Nota\n");
  const { status } = assertTerminal(project, story.storyId, ["workflow_final_receipt_stale"]);
  assertNextActionLeaves(status, story.storyId);
});

test("a later story that changes the same documentation leaves the merged story completed", () => {
  const { project, story } = laterStoryFixture("docs", {
    writePaths: ["docs"],
    files: { "docs/baseline.md": "# Baseline\n\nChanged by the later story.\n" },
  });
  const { status } = assertTerminal(project, story.storyId, ["workflow_final_receipt_stale", "workflow_final_receipt"]);
  assertNextActionLeaves(status, story.storyId);
});

test("a changed record of the merged story itself voids its certification", () => {
  const { project, story } = mergedFixture();
  const checkpoint = findFile(path.join(project, ".sdlc"), (filePath) =>
    path.basename(filePath) === "checkpoint.json"
    && path.basename(path.dirname(filePath)) === story.workflowInstanceId);
  assert.ok(checkpoint, "the workflow checkpoint must exist");
  for (const relativePath of [
    `.sdlc/stories/${story.storyId}/story.json`,
    `.sdlc/contracts/${story.contractId}.json`,
    `.sdlc/requirements/${story.requirementId}.json`,
    path.relative(project, checkpoint).split(path.sep).join("/"),
  ]) {
    const restore = appendBytes(project, relativePath, "\n");
    const invalid = assertInvalid(project, story.storyId, "final_receipt_check:story_record_changed");
    assert.match(claimRefusal(project, story.storyId), new RegExp(
      `a record of the story itself changed after certification: ${relativePath.replace(/[.]/gu, "\\.")}`,
      "u",
    ));
    assert.match(invalid.lifecycle_remedy.en, /exactly as it was certified/u);
    restore();
  }
  assertTerminal(project, story.storyId, ["workflow_final_receipt_stale", "workflow_final_receipt"]);
});

test("a foreign line in the merged story's trace voids its certification", () => {
  const { project, story } = mergedFixture();
  appendBytes(project, `.sdlc/traces/${story.storyId}.jsonl`, "{\"action\":\"story.note\",\"summary\":\"added by hand\"}\n");
  assertInvalid(project, story.storyId, "final_receipt_check:story_record_changed");
});

test("a project configuration change leaves the merged story completed", () => {
  const { project, story } = mergedFixture();
  applyProjectConfig(project, (config) => {
    config.gate_policy.secret_scan.exclude_paths = ["tmp"];
  });
  assertTerminal(project, story.storyId, ["workflow_final_receipt_stale"]);
});

test("a certified file changed before the delivery finished blocks the story", () => {
  const { project, story } = sealedFixture();
  writeProjectFile(project, "src/feature.mjs", "export const feature = 2;\n");
  assertInvalid(project, story.storyId, "final_receipt_check:workflowFinalFreshnessProofMatches");
});

test("a history rewritten after the merge is named as such", () => {
  const { project, story } = mergedFixture();
  const rewritten = mustGit(project, ["commit-tree", "HEAD^{tree}", "-p", story.baseSha, "-m", "rewrite"]);
  mustGit(project, ["update-ref", "refs/heads/main", rewritten]);
  const invalid = assertInvalid(project, story.storyId, "final_receipt_check:certified_history_rewritten");
  assert.equal(invalid.lifecycle_remedy.command, "trace verify");
});

test("a certified commit missing from the clone is named as such", () => {
  const { project, story } = mergedFixture();
  const receiptPath = `.sdlc/gates/${story.storyId}-final.json`;
  const receipt = readJson(project, receiptPath);
  receipt.freshness_proof.git_scope.certification_head_sha = "d".repeat(40);
  writeProjectFile(project, receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const invalid = assertInvalid(project, story.storyId, "final_receipt_check:certified_commit_missing");
  assert.match(invalid.lifecycle_remedy.en, /git fetch/u);
});

test("a merged story is certified again on its merge commit, not on later work", () => {
  const { project, story, mergeSha } = laterStoryFixture("lib", {
    writePaths: ["lib"],
    files: { "lib/altro.mjs": "export const altro = true;\n" },
  });
  fs.rmSync(path.join(project, ".sdlc", "gates", `${story.storyId}-final.json`));
  mustRun(["secret", "scan", "--root", project, "--story", story.storyId], project);
  const result = run([
    "gate", "check", "--root", project,
    "--strict", "--story", story.storyId, "--lifecycle-complete", "--json",
  ], project);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "passed", JSON.stringify(report, null, 2));
  assert.doesNotMatch(result.stdout, /lib\/altro\.mjs/u);
  assert.doesNotMatch(result.stdout, /does not describe/u);
  const receipt = readJson(project, `.sdlc/gates/${story.storyId}-final.json`);
  assert.deepEqual(receipt.freshness_proof.git_scope.anchor, { kind: "merge_commit", sha: mergeSha });
  assert.equal(receipt.freshness_proof.git_scope.certification_head_sha, mergeSha);
  assertTerminal(project, story.storyId, ["workflow_final_receipt"]);
});

test("a merged story is certified on its merge commit with the scan made before the merge", () => {
  const { project, story } = laterStoryFixture("lib", {
    writePaths: ["lib"],
    files: { "lib/altro.mjs": "export const altro = true;\n" },
  });
  fs.rmSync(path.join(project, ".sdlc", "gates", `${story.storyId}-final.json`));
  const result = run([
    "gate", "check", "--root", project,
    "--strict", "--story", story.storyId, "--lifecycle-complete", "--json",
  ], project);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "passed", JSON.stringify(report, null, 2));
  assert.doesNotMatch(result.stdout, /has no secret scan/u);
});

test("a merged story cannot be certified again when its merge commit is not in the history of HEAD", () => {
  const { project, story, mergeSha } = mergedFixture();
  mustGit(project, ["checkout", "-f", "-b", "elsewhere", story.baseSha]);
  fs.rmSync(path.join(project, ".sdlc", "gates", `${story.storyId}-final.json`));
  const result = run([
    "gate", "check", "--root", project,
    "--strict", "--story", story.storyId, "--lifecycle-complete", "--json",
  ], project);
  assert.notEqual(result.status, 0);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    new RegExp(`Story ${story.storyId} was merged as ${mergeSha.slice(0, 12)} but that commit is not in this clone or is not an ancestor of HEAD; fetch the base branch and run the gate again\\.`, "u"),
  );
});

test("a story released after its delivery finished is shared as completed, so other computers never offer it again", () => {
  const claims = temporaryDirectory("shared-claims-remote");
  mustGit(claims, ["init", "--bare"]);
  const project = temporaryDirectory("shared-completion");
  const story = sealPullRequestStory(project, { suffix: "SHARE-A", claimsRemote: claims });
  const record = JSON.parse(mustGit(claims, ["log", "-1", "--format=%B", `refs/agentic-sdlc/claims/${story.storyId}/000001/release`]));
  assert.equal(record.status, "completed");
  assert.equal(record.completion.terminal_status, "ready_for_review");
  assert.equal(record.completion.delivery_kind, "pull_request");
  assert.equal(record.completion.close_receipt_hash, story.closeReceipt.receipt_hash);
  // The closing records are written by the gate itself: until they are pushed, the gate says so.
  assert.equal(story.certification.closing_records.checked, true);
  assert.equal(story.certification.closing_records.on_remote, false);
  assert.equal(story.certification.closing_records.branch, "main");
  assert.equal(story.certification.closing_records.path, `.sdlc/gates/${story.storyId}-final.json`);
});

test("a pull request carries the story's records with its code, and one without them is refused when the project asks", () => {
  const withRecords = temporaryDirectory("records-in-pr");
  const story = sealPullRequestStory(withRecords, {
    suffix: "REC-A",
    includeRecords: true,
    storyRecords: { before_pull_request: "refuse" },
  });
  const carried = mustGit(withRecords, ["ls-tree", "-r", "--name-only", story.headSha, "--", `.sdlc/stories/${story.storyId}/`]);
  assert.match(carried, new RegExp(`stories/${story.storyId}/claim\\.json`, "u"));
  assert.equal(story.certification.status, "passed");

  const withoutRecords = temporaryDirectory("records-missing");
  assert.throws(
    () => sealPullRequestStory(withoutRecords, { suffix: "REC-B", storyRecords: { before_pull_request: "refuse" } }),
    /does not carry the story's records/u,
  );
});
