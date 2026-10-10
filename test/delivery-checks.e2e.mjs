import "./helpers/test-isolation.mjs";

import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildLegacyWorkflowStrictGateReceipt } from "../lib/lifecycle/workflow.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(repoRoot, "bin", "agentic-sdlc.mjs");
const providerCommandShim = path.join(repoRoot, "test", "helpers", "provider-command-shim.cjs");
const tempPaths = new Set();

const PROFILE_ID = "AUT-CHECKS";
const STORY_ID = "ST-CHECKS";
const PR_URL = "https://github.com/aantenore/agentic-sdlc/pull/185";
const AUTHOR = Object.freeze({ name: "Checks Author", email: "author@example.invalid" });
const REVIEWER = Object.freeze({ actor: "luca", name: "Luca Reviewer", email: "luca@example.invalid" });
// Assembled at runtime so the source holds no credential-shaped literal.
const PLANTED_TOKEN = ["gh", "p_", "A1b2C3d4E5f6G7h8I9j0KlMnOpQrStUvWxYz".slice(0, 36)].join("");
const DAY = 24 * 60 * 60 * 1000;

after(() => {
  if (process.env.AGENTIC_SDLC_KEEP_TEST_TMP === "1") return;
  for (const entry of tempPaths) fs.rmSync(entry, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function tmpDirectory(name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `sdlc-delivery-checks-${name}-`));
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
    timeout: 120_000,
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

function mustFail(args, pattern, options = {}) {
  const result = run(args, options);
  const combined = `${result.stdout}\n${result.stderr}`;
  assert.notEqual(result.status, 0, `${args.join(" ")} must fail\n${combined}`);
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
    AUTONOMY_FAKE_GH_DRAFT: values.draft === false ? "false" : "true",
    ...(values.updatedAt ? { AUTONOMY_FAKE_GH_UPDATED_AT: values.updatedAt } : {}),
    AUTONOMY_FAKE_GH_HEAD_SHA: values.headSha,
    AUTONOMY_FAKE_GH_HEAD: "feature/pr-checks",
    AUTONOMY_FAKE_GH_BASE: "main",
    AUTONOMY_FAKE_GH_BASE_SHA: git(project, ["rev-parse", "refs/remotes/origin/main"]),
    AUTONOMY_FAKE_GH_MERGED_AT: "",
    AUTONOMY_FAKE_GH_MERGE_SHA: "",
  };
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

function initializeRepository(project, name, headBranch) {
  mustRun(["init", "--root", project, "--project-name", name, "--force"]);
  // The test remote is a public repository the test cannot write to, so
  // story claims stay on this computer instead of being shared through it.
  const configPath = path.join(project, ".sdlc", "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.orchestration_policy = {
    ...config.orchestration_policy,
    coordination: { ...config.orchestration_policy?.coordination, mode: "local_only" },
  };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  const preview = mustRunJson(["config", "migrate", "--root", project]);
  mustRunJson(["config", "migrate", "--root", project, "--apply", "--plan-hash", preview.plan.plan_hash, "--actor-type", "system"]);
  git(project, ["init"]);
  git(project, ["config", "user.name", AUTHOR.name]);
  git(project, ["config", "user.email", AUTHOR.email]);
  git(project, ["commit", "--allow-empty", "-m", "test: establish PR base"]);
  git(project, ["branch", "-M", "main"]);
  git(project, ["remote", "add", "origin", "https://github.com/aantenore/agentic-sdlc.git"]);
  git(project, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  git(project, ["checkout", "-b", headBranch]);
}

function approveRequirementAndFormat(project, requirementId, ceiling) {
  mustRunJson([
    "requirement", "propose", "--root", project,
    "--id", requirementId,
    "--title", "Report the checks of a delivery",
    "--summary", "A pull request lists the checks that were actually recorded for it.",
    "--acceptance", "The pull request carries a table of recorded checks.",
    "--autonomy-ceiling", ceiling,
    "--write-path", "src",
  ]);
  mustRunJson(["requirement", "approve", "--root", project, "--id", requirementId, ...humanApproval("Approve the requirement")]);
  mustRun(["output", "template", "propose", "--root", project, "--type", "implementation-summary", "--summary", "Implementation evidence"]);
  mustRun(["output", "template", "approve", "--root", project, "--id", "implementation-summary-v1", ...humanApproval("Approve the format")]);
}

function createStoryAndContract(project, { storyId, contractId, profileId, requirementId, approval }) {
  mustRunJson([
    "story", "create", "--no-derived-verification", "--root", project,
    "--id", storyId,
    "--title", "Implement the change",
    "--phase", "implementation",
    "--status", "ready",
    "--requirement", requirementId,
    "--acceptance", "The change is delivered with its recorded checks.",
  ]);
  mustRunJson([
    "contract", "create", "--root", project,
    "--phase", "implementation",
    "--story", storyId,
    "--id", contractId,
    "--delivery-profile", profileId,
    "--level", "checkpointed",
    "--context-summary", "Implement the change inside the delivery boundary.",
    "--qa", "Who confirms?|The person who approves the brief",
    "--output-ref", "implementation-summary:implementation-summary-v1:new",
    "--tool", "node",
  ]);
  mustRunJson(["contract", "approve", "--root", project, "--id", contractId, ...approval]);
}

/** A started pull-request delivery on an exact existing PR, with one committed change. */
function preparePullRequestDelivery() {
  const project = tmpDirectory("project");
  initializeRepository(project, "Delivery Checks E2E", "feature/pr-checks");
  approveRequirementAndFormat(project, "REQ-CHECKS", "checkpointed");
  createStoryAndContract(project, {
    storyId: STORY_ID,
    contractId: "CONTRACT-CHECKS",
    profileId: PROFILE_ID,
    requirementId: "REQ-CHECKS",
    approval: humanApproval("Approve the contract"),
  });
  mustRunJson([
    "autonomy", "delivery", "propose", "--root", project,
    "--id", PROFILE_ID,
    "--delivery", "PR-185",
    "--kind", "pull_request", "--code-review", "required", "--code-review-actor-type", "human", "--code-review-approval-source", "explicit-user", "--code-review-summary", "Yes, review before merge",
    "--pr-mode", "existing",
    "--pr-number", "185",
    "--pr-url", PR_URL,
    "--story", STORY_ID,
    "--contract", "CONTRACT-CHECKS",
    "--requirement", "REQ-CHECKS",
    "--level", "checkpointed",
    "--repository", "aantenore/agentic-sdlc",
    "--base", "main",
    "--head", "feature/pr-checks",
    "--write-path", "src",
  ]);
  mustRunJson(["autonomy", "delivery", "approve", "--root", project, "--id", PROFILE_ID, ...humanApproval("Approve this delivery")]);

  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.writeFileSync(path.join(project, "src", "change.txt"), "the change\n", "utf8");
  git(project, ["add", "--", "src"]);
  git(project, ["commit", "-m", "feat: the change"]);

  const started = mustRunJson(["task", "start", "--root", project, "--intent-json", implementationIntent(STORY_ID), "--delivery-profile", PROFILE_ID]);
  assert.equal(started.execution_allowed, true);
  mustRun(["story", "claim", "--root", project, "--id", STORY_ID, "--agent", "checks-agent", "--branch", "feature/pr-checks"]);
  return project;
}

function checksArgs(project, extra = []) {
  return ["autonomy", "delivery", "checks", "--root", project, "--id", PROFILE_ID, ...extra];
}

function checksModel(project) {
  return JSON.parse(mustRun(checksArgs(project, ["--format", "json"])).stdout);
}

function rows(model, kind) {
  return model.checks.filter((check) => check.kind === kind);
}

function writeEvidence(project, relativePath, contents) {
  const filePath = path.join(project, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
  return relativePath;
}

function recordTest(project, argv, { exitCode, passed = 0, failed = 0, framework, evidence }) {
  return mustRunJson([
    "test", "record", "--root", project,
    "--story", STORY_ID,
    "--command", JSON.stringify(argv),
    "--exit-code", String(exitCode),
    "--passed", String(passed),
    "--failed", String(failed),
    "--evidence", evidence,
    ...(framework ? ["--framework", framework] : []),
  ]);
}

test("the checks table lists what was recorded, redacts it, and follows the project as it changes", () => {
  const project = preparePullRequestDelivery();

  // 1. A started delivery with nothing recorded: every check is "not run", never a pass.
  const empty = mustRun(checksArgs(project));
  assert.equal(empty.stderr, "");
  assert.match(empty.stdout, /^## Delivery checks\n/u);
  assert.match(empty.stdout, /Delivery `PR-185` \(profile `AUT-CHECKS`, story `ST-CHECKS`\): 0 pass, 0 fail, 7 not run\./u);
  assert.equal(empty.stdout.split("\n").filter((line) => line.includes("[NOT RUN]")).length, 7);
  assert.ok(!/Correlation ID|correlation_id/u.test(empty.stdout), "the table is the output, with no envelope");
  assert.equal(mustRun(checksArgs(project)).stdout, empty.stdout, "the same records produce the same bytes");
  const emptyModel = checksModel(project);
  assert.equal(emptyModel.schema_version, "pull-request-checks:v1");
  assert.equal(emptyModel.overall, "not_run");
  assert.equal(emptyModel.delivery.head_sha, git(project, ["rev-parse", "HEAD"]));
  assert.equal(mustRun(checksArgs(project, ["--json"])).stdout, mustRun(checksArgs(project, ["--format", "json"])).stdout);
  assert.match(mustRun(checksArgs(project, ["--locale", "it"])).stdout, /^## Controlli della consegna\n[\s\S]*7 non eseguiti/u);
  mustFail(checksArgs(project, ["--format", "html"]), /--format must be one of: markdown, json/u);
  mustFail(checksArgs(project, ["--json", "--format", "markdown"]), /different output/u);
  mustFail(["autonomy", "delivery", "checks", "--root", project, "--id", "AUT-MISSING"], /does not exist/u);

  // 2. Record the evidence a reviewer would expect.
  writeEvidence(project, "evidence/test.log", "12 passed\n");
  writeEvidence(project, "evidence/smoke.log", "smoke ok\n");
  writeEvidence(project, "evidence/lint.log", "1 problem\n");
  const passing = recordTest(project, ["npm", "test"], { exitCode: 0, passed: 12, framework: "node:test", evidence: "evidence/test.log" });
  recordTest(project, ["npm", "run", "smoke"], { exitCode: 0, passed: 1, framework: "smoke", evidence: "evidence/smoke.log" });
  recordTest(project, ["npm", "run", "lint"], { exitCode: 1, failed: 1, evidence: "evidence/lint.log" });
  mustRunJson(["secret", "scan", "--root", project, "--story", STORY_ID]);
  const approvedReview = mustRunJson([
    "review", "record", "--root", project,
    "--delivery", PROFILE_ID,
    "--verdict", "approved",
    "--actor", REVIEWER.actor,
    "--actor-type", "human",
  ], { env: gitIdentityEnv(REVIEWER) });
  assert.equal(approvedReview.independent, true);
  const strictReceipt = buildLegacyWorkflowStrictGateReceipt({
    status: "passed",
    strict: true,
    scope: "story",
    lifecycle_complete: false,
    certification_level: "strict_intermediate",
    story_id: STORY_ID,
    checked_at: new Date().toISOString(),
    errors: [],
  }, `.sdlc/gates/${STORY_ID}-strict.json`);
  writeEvidence(project, `.sdlc/gates/${STORY_ID}-strict.json`, `${JSON.stringify(strictReceipt, null, 2)}\n`);

  const model = checksModel(project);
  assert.deepEqual(model.summary, { pass: 5, fail: 1, not_run: 2 }, mustRun(checksArgs(project)).stdout);
  assert.equal(model.overall, "fail");
  assert.deepEqual(rows(model, "tests").map((check) => [check.status, check.subject]), [
    ["fail", "npm run lint"],
    ["pass", "npm test"],
  ]);
  assert.equal(rows(model, "smoke_tests")[0].status, "pass");
  assert.equal(rows(model, "secret_scan")[0].status, "pass");
  assert.equal(rows(model, "code_review")[0].status, "pass");
  assert.equal(rows(model, "code_review")[0].facts.reviewer, REVIEWER.actor);
  assert.equal(rows(model, "strict_gate")[0].status, "pass");
  assert.equal(rows(model, "final_gate")[0].status, "not_run");
  assert.equal(rows(model, "budget_decision")[0].status, "not_run", "no execution budget is bound to this delivery");
  assert.equal(rows(model, "standing_approval").length, 0);
  const npmTest = rows(model, "tests").find((check) => check.subject === "npm test");
  assert.ok(npmTest.evidence.includes(passing.test_run_path));
  assert.ok(npmTest.evidence.includes("evidence/test.log"));

  const recorded = mustRun(checksArgs(project));
  assert.match(recorded.stdout, /\| Tests \| \[FAIL\] \|/u);
  assert.match(recorded.stdout, /\| Code review gate \| \[PASS\] \| Approved by `luca` at head `[0-9a-f]{12}`\. Merge gate: required\. \|/u);
  assert.ok(!recorded.stdout.includes(REVIEWER.email), "the table printed a reviewer email");
  // Every evidence link is a plain project-relative path.
  const links = [...recorded.stdout.matchAll(/\]\(([^)]*)\)/gu)].map((match) => match[1]);
  assert.ok(links.length >= 6);
  for (const target of links) {
    assert.match(target, /^[A-Za-z0-9_.@+=,-]+(?:\/[A-Za-z0-9_.@+=,-]+)*$/u, target);
    assert.ok(!target.startsWith("/") && !target.includes(".."), target);
    assert.ok(fs.existsSync(path.join(project, target)), `${target} does not exist in the project`);
  }

  // 3. The privacy rules apply before anything is printed: the stored record keeps the command
  // as it ran, the table does not.
  const audited = recordTest(project, ["node", "scripts/audit.mjs", "--access-token", PLANTED_TOKEN], { exitCode: 0, passed: 3, evidence: "evidence/test.log" });
  assert.ok(fs.readFileSync(path.join(project, audited.test_run_path), "utf8").includes(PLANTED_TOKEN));
  const redacted = mustRun(checksArgs(project));
  for (const text of [redacted.stdout, mustRun(checksArgs(project, ["--format", "json"])).stdout, mustRun(checksArgs(project, ["--locale", "it"])).stdout]) {
    assert.ok(!text.includes(PLANTED_TOKEN), "the table printed a credential");
  }
  assert.match(redacted.stdout, /`node scripts\/audit\.mjs --access-token \[REDACTED\]`: passed/u);

  // The machine's own paths stay out of the table too: under the project they become relative,
  // anywhere else they are hidden.
  const outsideFile = path.join(os.tmpdir(), "checks-out.json");
  recordTest(project, ["node", path.join(project, "scripts", "t.mjs"), `--out=${outsideFile}`], { exitCode: 0, passed: 1, evidence: "evidence/test.log" });
  const portable = mustRun(checksArgs(project));
  for (const text of [portable.stdout, mustRun(checksArgs(project, ["--format", "json"])).stdout]) {
    assert.ok(!text.includes(project), "the table printed the project's absolute path");
    assert.ok(!text.includes(os.tmpdir()), "the table printed a path outside the project");
  }
  assert.match(portable.stdout, /`node scripts\/t\.mjs '--out=<path>'`: passed/u);

  // 4. A new commit leaves the earlier scan and review describing a state that no longer exists.
  fs.writeFileSync(path.join(project, "src", "later.txt"), "unreviewed follow-up\n", "utf8");
  git(project, ["add", "--", "src/later.txt"]);
  git(project, ["commit", "-m", "feat: an unreviewed follow-up"]);
  const moved = checksModel(project);
  assert.equal(rows(moved, "secret_scan")[0].status, "not_run");
  assert.equal(rows(moved, "secret_scan")[0].facts.state, "stale");
  assert.equal(rows(moved, "code_review")[0].status, "not_run");
  assert.equal(rows(moved, "code_review")[0].facts.state, "stale");
  // A test run describes the commit it ran on: after a new commit it is stale until it runs again.
  for (const check of rows(moved, "tests")) {
    assert.equal(check.status, "not_run", check.subject);
    assert.equal(check.facts.state, "stale", check.subject);
  }
  assert.equal(rows(moved, "smoke_tests")[0].status, "not_run");
  assert.match(mustRun(checksArgs(project)).stdout, /describes an earlier state, not the current one; run it again/u);
  assert.match(mustRun(checksArgs(project)).stdout, /The latest scan covers `[0-9a-f]{12}`, not the current state/u);
  // A fresh scan reads the credential the stored record kept, reports it, and never shows it.
  const rescan = run(["secret", "scan", "--root", project, "--story", STORY_ID, "--json"]);
  assert.equal(rescan.status, 1, rescan.stdout);
  const flagged = rows(checksModel(project), "secret_scan")[0];
  assert.equal(flagged.status, "fail");
  assert.equal(flagged.facts.finding_count, 1);
  assert.match(mustRun(checksArgs(project)).stdout, /1 credential match in \d+ scanned files; matches are never shown/u);
  assert.equal(rows(checksModel(project), "code_review")[0].status, "not_run");
  recordTest(project, ["npm", "test"], { exitCode: 0, passed: 13, framework: "node:test", evidence: "evidence/test.log" });
  assert.equal(rows(checksModel(project), "tests").find((check) => check.subject === "npm test").status, "pass");

  // 5. Off the delivery's head branch no head-dependent check can pass.
  git(project, ["checkout", "--quiet", "main"]);
  const offBranch = mustRun(checksArgs(project));
  assert.match(offBranch.stdout, /not checked out here/u);
  const offModel = JSON.parse(mustRun(checksArgs(project, ["--format", "json"])).stdout);
  assert.equal(offModel.delivery.head_sha, null);
  for (const kind of ["tests", "smoke_tests", "secret_scan", "code_review"]) {
    assert.ok(rows(offModel, kind).every((check) => check.status !== "pass"), `${kind} must not pass off the head branch`);
  }
  git(project, ["checkout", "--quiet", "feature/pr-checks"]);

  // 6. A record edited after it was written is not evidence: it is left out and counted.
  const recordPath = path.join(project, passing.test_run_path);
  const tampered = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  tampered.summary = "Edited after the fact";
  fs.writeFileSync(recordPath, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");
  const afterTamper = mustRun(checksArgs(project));
  const tamperedModel = checksModel(project);
  assert.equal(tamperedModel.ignored_records, 1);
  assert.deepEqual(rows(tamperedModel, "tests").map((check) => [check.subject, check.status]), [
    ["node scripts/audit.mjs --access-token [REDACTED]", "not_run"],
    ["node scripts/t.mjs '--out=<path>'", "not_run"],
    ["npm run lint", "not_run"],
    ["npm test", "pass"],
  ]);
  assert.match(afterTamper.stdout, /1 recorded file failed validation and was left out\./u);
});

test("authorizing a pull-request update points at the checks table, which a local release does not have", () => {
  const project = preparePullRequestDelivery();
  const headSha = git(project, ["rev-parse", "HEAD"]);
  const authorization = mustRunJson([
    "autonomy", "delivery", "action", "--root", project,
    "--id", PROFILE_ID,
    "--action", "pull_request.update",
    "--pr-url", PR_URL,
    "--expected-pr-state", "ready",
    "--confirm-action",
    ...humanApproval("Approve marking this exact pull request ready for review"),
  ], { env: fakeGitHubEnv(project, { headSha }) });
  assert.equal(authorization.status, "authorized");
  // The authorization hands over the table itself, the same bytes the command prints.
  assert.equal(
    authorization.pull_request_body_checks.command,
    `agentic-sdlc autonomy delivery checks --id ${PROFILE_ID} --format markdown`,
  );
  assert.match(authorization.pull_request_body_checks.markdown, /^## Delivery checks\n/u);
  assert.equal(authorization.pull_request_body_checks.markdown, mustRun(checksArgs(project)).stdout.trimEnd());
  assert.equal(authorization.pull_request_body_checks.unavailable_reason, undefined);
  const human = mustRun([
    "autonomy", "delivery", "action", "--root", project,
    "--id", PROFILE_ID,
    "--action", "pull_request.update",
    "--pr-url", PR_URL,
    "--expected-pr-state", "ready",
    "--confirm-action",
    ...humanApproval("Approve marking this exact pull request ready for review"),
  ], { env: fakeGitHubEnv(project, { headSha }) });
  assert.match(human.stdout, /Put the recorded checks in the pull-request description: agentic-sdlc autonomy delivery checks --id AUT-CHECKS --format markdown/u);
  // Completing the update records what happened; it carries no pointer.
  const updatedAt = new Date(Date.parse(authorization.action_receipt.authorized_at) + 1_000).toISOString();
  const completion = mustRunJson([
    "autonomy", "delivery", "action", "--root", project,
    "--id", PROFILE_ID,
    "--action", "pull_request.update",
    "--pr-url", PR_URL,
    "--expected-pr-state", "ready",
    "--outcome", "passed",
    "--authorization-receipt", authorization.action_receipt.id,
    "--evidence", "src/change.txt",
  ], { env: fakeGitHubEnv(project, { headSha, draft: false, updatedAt }) });
  assert.equal(completion.status, "completed");
  assert.equal(completion.pull_request_body_checks, undefined);

  // The table is built for pull requests; a local release is refused rather than reported with blanks.
  createStoryAndContract(project, {
    storyId: "ST-LOCAL",
    contractId: "CONTRACT-LOCAL",
    profileId: "AUT-LOCAL",
    requirementId: "REQ-CHECKS",
    approval: humanApproval("Approve the local contract"),
  });
  const releaseRoot = path.join(project, "src", "local-release-checks");
  mustRunJson([
    "autonomy", "delivery", "propose", "--root", project,
    "--id", "AUT-LOCAL",
    "--delivery", "LOCAL-CHECKS",
    "--kind", "local_release",
    "--story", "ST-LOCAL",
    "--contract", "CONTRACT-LOCAL",
    "--requirement", "REQ-CHECKS",
    "--level", "checkpointed",
    "--target-root", releaseRoot,
    "--write-path", path.join(releaseRoot, "app"),
    "--smoke-test", '["node","--version"]',
    "--rollback", "Restore the previous governed local release snapshot.",
  ]);
  mustFail(
    ["autonomy", "delivery", "checks", "--root", project, "--id", "AUT-LOCAL"],
    /local_release delivery; the checks table is built for pull-request deliveries/u,
  );
});

function isoAfter(milliseconds) {
  return new Date(Date.now() + milliseconds).toISOString();
}

test("a delivery covered by a standing approval names the slot it used and notices a revocation", () => {
  const project = tmpDirectory("standing");
  initializeRepository(project, "Delivery Checks Standing", "standing/sa-checks/pr-1");
  approveRequirementAndFormat(project, "REQ-TOIL", "checkpointed");
  // The remote is a public repository the test cannot write to, so nothing is shared.
  const configPath = path.join(project, ".sdlc", "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.standing_approval_policy = { ...config.standing_approval_policy, coordination: { mode: "local_only" } };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  const preview = mustRunJson(["config", "migrate", "--root", project]);
  mustRunJson(["config", "migrate", "--root", project, "--apply", "--plan-hash", preview.plan.plan_hash, "--actor-type", "human"]);

  mustRunJson([
    "autonomy", "standing", "propose", "--root", project,
    "--id", "SA-CHECKS",
    "--recipe", "flag-cleanup",
    "--description", "Remove one retired feature flag and open a pull request",
    "--requirement", "REQ-TOIL",
    "--write-path", "src",
    "--max-changed-files", "10",
    "--max-changed-lines", "200",
    "--destination", "pull_request", "--code-review", "not-required",
    "--repository", "aantenore/agentic-sdlc",
    "--max-deliveries", "2",
    "--expires-at", isoAfter(7 * DAY),
  ]);
  mustRunJson(["autonomy", "standing", "approve", "--root", project, "--id", "SA-CHECKS", ...humanApproval("Approve the standing approval")]);
  createStoryAndContract(project, {
    storyId: STORY_ID,
    contractId: "CONTRACT-CHECKS",
    profileId: PROFILE_ID,
    requirementId: "REQ-TOIL",
    approval: ["--standing-approval", "SA-CHECKS"],
  });
  mustRunJson([
    "autonomy", "delivery", "propose", "--root", project,
    "--id", PROFILE_ID,
    "--delivery", "PR-STANDING",
    "--kind", "pull_request", "--code-review", "not-required", "--code-review-actor-type", "human", "--code-review-approval-source", "explicit-user", "--code-review-summary", "No review needed for this story",
    "--story", STORY_ID,
    "--contract", "CONTRACT-CHECKS",
    "--requirement", "REQ-TOIL",
    "--level", "checkpointed",
    "--repository", "aantenore/agentic-sdlc",
    "--base", "main",
    "--head", "standing/sa-checks/pr-1",
    "--write-path", "src",
    "--standing-approval", "SA-CHECKS",
  ]);
  mustRunJson(["autonomy", "delivery", "approve", "--root", project, "--id", PROFILE_ID, "--phase", "implementation", "--standing-approval", "SA-CHECKS"]);
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.writeFileSync(path.join(project, "src", "flag.mjs"), "export const retired = false;\n", "utf8");
  git(project, ["add", "--", "src"]);
  git(project, ["commit", "-m", "feat: remove the retired flag"]);
  const started = mustRunJson(["task", "start", "--root", project, "--intent-json", implementationIntent(STORY_ID), "--delivery-profile", PROFILE_ID]);
  assert.equal(started.execution_allowed, true);

  const used = rows(checksModel(project), "standing_approval")[0];
  assert.equal(used.status, "pass");
  assert.equal(used.facts.standing_approval_id, "SA-CHECKS");
  assert.equal(used.facts.slot, 1);
  assert.equal(used.facts.max_deliveries, 2);
  assert.ok(used.evidence.includes(".sdlc/autonomy/standing/SA-CHECKS/approval.json"));
  assert.match(
    mustRun(checksArgs(project)).stdout,
    /\| Standing approval \| \[PASS\] \| `SA-CHECKS`: delivery slot 1 of 2; the standing approval is now active \|/u,
  );

  mustRunJson([
    "autonomy", "standing", "revoke", "--root", project,
    "--id", "SA-CHECKS",
    "--reason", "Dependency updates now need a review each time",
    ...humanApproval("Stop the standing approval"),
  ]);
  const revoked = rows(checksModel(project), "standing_approval")[0];
  assert.equal(revoked.status, "fail");
  assert.match(mustRun(checksArgs(project)).stdout, /`SA-CHECKS` is revoked; it no longer covers this delivery/u);
});
