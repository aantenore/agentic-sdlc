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
const tempPaths = new Set();

const PROFILE_ID = "AUT-DPOL";
const STORY_ID = "ST-DPOL";

after(() => {
  if (process.env.AGENTIC_SDLC_KEEP_TEST_TMP === "1") return;
  for (const entry of tempPaths) fs.rmSync(entry, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function tmpDirectory(name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `sdlc-delivery-policy-${name}-`));
  tempPaths.add(directory);
  return directory;
}

function run(args) {
  const env = { ...process.env };
  for (const key of ["CI", "GITHUB_ACTIONS", "GITHUB_ACTOR", "CODEX_AGENT_NAME", "CODEX_USER_ID", "CLAUDECODE", "AGENTIC_SDLC_AGENT_HOST"]) delete env[key];
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
    timeout: 60_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function mustRun(args) {
  const result = run(args);
  assert.equal(result.status, 0, `${args.join(" ")}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result;
}

function mustRunJson(args) {
  return JSON.parse(mustRun([...args, "--json"]).stdout);
}

function git(project, args) {
  const result = spawnSync("git", ["-C", project, ...args], { encoding: "utf8", timeout: 60_000 });
  assert.equal(result.status, 0, `git ${args.join(" ")}\n${result.stderr}`);
  return result.stdout.trim();
}

function humanApproval(summary) {
  return ["--actor-type", "human", "--approval-source", "explicit-user", "--summary", summary];
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

function proposeArgs(project, extra = []) {
  return [
    "autonomy", "delivery", "propose", "--root", project,
    "--id", PROFILE_ID,
    "--delivery", "PR-CAP",
    "--kind", "pull_request",
    "--story", STORY_ID,
    "--contract", "CONTRACT-CAP",
    "--requirement", "REQ-CAP",
    "--level", "checkpointed",
    "--repository", "aantenore/agentic-sdlc",
    "--base", "main",
    "--head", "codex/pr-cap",
    "--write-path", "src",
    "--merge-allowed",
    "--allow-action", "git.push",
    "--allow-action", "pull_request.create",
    "--allow-action", "pull_request.merge",
    ...extra,
  ];
}

function mustFail(args, pattern) {
  const result = run(args);
  assert.notEqual(result.status, 0, `${args.join(" ")} unexpectedly succeeded:\n${result.stdout}`);
  assert.match(`${result.stdout}\n${result.stderr}`, pattern);
}

function grant(project, id, actions, extra = []) {
  return [
    "autonomy", "delegation", "grant", "--root", project, "--id", id, "--scope", "project",
    "--actions", actions, "--until", "30d", ...extra,
    "--summary", "Standing delivery answers", "--actor-type", "human", "--approval-source", "explicit-user", "--actor-name", "Antonio",
  ];
}

const delegated = (id) => ["--actor-type", "agent", "--approval-source", "delegated", "--delegation", id];

// A requirement approved with a checkpointed ceiling, and a contract left at
// that ceiling, as a novice user ends up with when they pick "with checks".
function prepareCheckpointedCeilingProject() {
  const project = tmpDirectory("project");
  mustRun(["init", "--root", project, "--project-name", "Ceiling Cap E2E", "--force"]);
  keepClaimsOnThisComputer(project);
  git(project, ["init"]);
  git(project, ["config", "user.name", "Ceiling Cap"]);
  git(project, ["config", "user.email", "ceiling-cap@example.invalid"]);
  git(project, ["commit", "--allow-empty", "-m", "test: establish PR base"]);
  git(project, ["branch", "-M", "main"]);
  git(project, ["remote", "add", "origin", "https://github.com/aantenore/agentic-sdlc.git"]);
  git(project, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  git(project, ["checkout", "-b", "codex/pr-cap"]);
  mustRunJson([
    "requirement", "propose", "--root", project,
    "--id", "REQ-CAP",
    "--title", "Cap the delivery choice",
    "--summary", "A delivery choice above the approved maximum is recorded and capped.",
    "--acceptance", "The enforced level never exceeds the requirement maximum.",
    "--autonomy-ceiling", "checkpointed",
    "--write-path", "src",
  ]);
  mustRunJson(["requirement", "approve", "--root", project, "--id", "REQ-CAP", ...humanApproval("Approve the requirement")]);
  mustRun(["output", "template", "propose", "--root", project, "--type", "implementation-summary", "--summary", "Implementation evidence"]);
  mustRun(["output", "template", "approve", "--root", project, "--id", "implementation-summary-v1", ...humanApproval("Approve the format")]);
  mustRunJson([
    "story", "create", "--no-derived-verification", "--root", project,
    "--id", STORY_ID,
    "--title", "Implement the change",
    "--phase", "implementation",
    "--status", "ready",
    "--requirement", "REQ-CAP",
    "--acceptance", "The change stays within the approved maximum.",
  ]);
  const contract = mustRunJson([
    "contract", "create", "--root", project,
    "--phase", "implementation",
    "--story", STORY_ID,
    "--id", "CONTRACT-CAP",
    "--delivery-profile", PROFILE_ID,
    "--context-summary", "Implement the change inside the delivery boundary.",
    "--qa", "How independent?|With checks",
    "--output-ref", "implementation-summary:implementation-summary-v1:new",
    "--tool", "node",
  ]).contract;
  assert.equal(contract.autonomy_level, "checkpointed");
  mustRunJson(["contract", "approve", "--root", project, "--id", "CONTRACT-CAP", ...humanApproval("Approve the contract")]);
  return project;
}

test("a delivery.policy delegation answers code review and merge for a new pull request", () => {
  const project = prepareCheckpointedCeilingProject();
  const profilePath = path.join(project, ".sdlc", "autonomy", "deliveries", `${PROFILE_ID}.json`);

  // Without a delegation the usual question stays.
  mustFail(proposeArgs(project), /needs the user's answer on code review before merge/u);

  // The grant records the person's answers only with delivery.policy.
  mustFail(grant(project, "DLG-NOPOL", "delivery.policy"), /needs --delivery-policy/u);
  mustFail(grant(project, "DLG-NOPOL", "breakdown.approve", ["--delivery-policy", "code-review=not-required"]), /only with the action delivery\.policy/u);
  mustFail(grant(project, "DLG-NOPOL", "delivery.policy", ["--delivery-policy", "code-review=maybe"]), /code-review must be one of/u);

  // A delegation without delivery.policy is refused and writes no profile.
  mustRun(grant(project, "DLG-OTHER", "breakdown.approve"));
  mustFail(proposeArgs(project, delegated("DLG-OTHER")), /does not cover the action delivery\.policy/u);
  assert.equal(fs.existsSync(profilePath), false);

  // With delivery.policy the delegation's answers are the person's answers.
  mustRun(grant(project, "DLG-POLICY", "delivery.policy", ["--delivery-policy", "code-review=not-required,merge=automatic"]));
  const record = JSON.parse(fs.readFileSync(path.join(project, ".sdlc/autonomy/delegations/DLG-POLICY/delegation.json"), "utf8"));
  assert.deepEqual(record.delivery_policy, { code_review: "not-required", merge: "automatic" });
  mustFail(proposeArgs(project, [...delegated("DLG-POLICY"), "--code-review", "required"]), /already gives the person.s answer on code-review/u);
  const proposed = mustRunJson(proposeArgs(project, delegated("DLG-POLICY")));
  const target = proposed.delivery_profile.pull_request_target;
  assert.equal(target.code_review.decision, "not-required");
  assert.equal(target.code_review.source, "delegation");
  assert.equal(target.code_review.delegation_id, "DLG-POLICY");
  assert.equal(target.code_review.user_words, "scelta di Antonio per delega DLG-POLICY");
  assert.equal(target.merge_decision.mode, "automatic");
  assert.equal(target.merge_decision.source, "delegation");
  assert.equal(target.merge_decision.user_words, "scelta di Antonio per delega DLG-POLICY");
  const uses = fs.readdirSync(path.join(project, ".sdlc/autonomy/delegations/DLG-POLICY/uses"));
  assert.equal(uses.length, 1);

  // The approved profile keeps the delegated answers.
  const approved = mustRunJson([
    "autonomy", "delivery", "approve", "--root", project, "--id", PROFILE_ID, "--phase", "implementation",
    ...humanApproval("Approve the delivery"),
  ]);
  assert.equal(approved.delivery_profile.pull_request_target.code_review.source, "delegation");
});
