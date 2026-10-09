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

const PROFILE_ID = "AUT-CAP";
const STORY_ID = "ST-CAP";

after(() => {
  if (process.env.AGENTIC_SDLC_KEEP_TEST_TMP === "1") return;
  for (const entry of tempPaths) fs.rmSync(entry, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function tmpDirectory(name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `sdlc-ceiling-cap-${name}-`));
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

function proposeArgs(project, level) {
  return [
    "autonomy", "delivery", "propose", "--root", project,
    "--id", PROFILE_ID,
    "--delivery", "PR-CAP",
    "--kind", "pull_request",
    "--story", STORY_ID,
    "--contract", "CONTRACT-CAP",
    "--requirement", "REQ-CAP",
    "--level", level,
    "--repository", "aantenore/agentic-sdlc",
    "--base", "main",
    "--head", "codex/pr-cap",
    "--write-path", "src",
    "--code-review", "not-required",
    "--code-review-actor-type", "human",
    "--code-review-approval-source", "explicit-user",
    "--code-review-summary", "No review needed",
  ];
}

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
    "story", "create", "--root", project,
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

test("a full-autonomy choice above a checkpointed ceiling is recorded as requested and capped to checkpointed", () => {
  const project = prepareCheckpointedCeilingProject();
  const proposed = mustRunJson(proposeArgs(project, "bounded-autonomous"));
  const profile = proposed.delivery_profile;
  assert.equal(profile.requested_level, "bounded-autonomous");
  assert.equal(profile.effective_level, "checkpointed");
  assert.equal(proposed.review.requested_level, "bounded-autonomous");
  assert.equal(proposed.review.effective_level, "checkpointed");
  assert.equal(proposed.review.level_capped_by, "requirement_ceiling");
  assert.equal(proposed.human_guidance.details.requested_level, "bounded-autonomous");
  assert.equal(proposed.human_guidance.details.effective_level, "checkpointed");
  assert.equal(proposed.human_guidance.details.capped_by_ceiling, true);
  assert.equal(proposed.human_guidance.details.capped_level, "checkpointed");
  assert.deepEqual(proposed.human_guidance.details.reason_codes, ["delivery.requirement_ceiling_caps_autonomy"]);
  assert.equal(proposed.human_guidance.details.digital_approver_verification, null);
  assert.match(proposed.human_guidance.impact, /^You chose Full autonomy within these limits\. The maximum approved for this work .* is Autonomy with checks: your choice stays recorded as you made it, but it is capped at that maximum\. The effective level for this delivery is Autonomy with checks/u);
  assert.match(proposed.human_guidance.required_decision, /The choice currently shown is Full autonomy within these limits/u);

  // The stored review moments follow the capped level, not the request.
  assert.ok(profile.checkpoints.includes("release.local"));

  const englishText = mustRun(["autonomy", "delivery", "status", "--root", project, "--id", PROFILE_ID]).stdout;
  assert.match(englishText, /capped at that maximum/u);
  assert.match(englishText, /Requested technical level: bounded-autonomous/u);
  assert.match(englishText, /Capped by the approved ceiling: checkpointed/u);
  const italianText = mustRun(["autonomy", "delivery", "status", "--root", project, "--id", PROFILE_ID, "--locale", "it"]).stdout;
  assert.match(italianText, /Hai scelto Autonomia completa entro questi limiti\. Il massimo approvato per questo lavoro .* è Autonomia con controlli: la tua scelta resta registrata così come l'hai fatta, ma è limitata a quel massimo\. Il livello effettivo per questa consegna è Autonomia con controlli/u);

  // Enforcement reads the capped level: the approved decision is checkpointed.
  const approved = mustRunJson([
    "autonomy", "delivery", "approve", "--root", project,
    "--id", PROFILE_ID,
    "--phase", "implementation",
    ...humanApproval("Full autonomy within these limits"),
  ]);
  assert.equal(approved.delivery_profile.requested_level, "bounded-autonomous");
  assert.equal(approved.delivery_profile.effective_level, "checkpointed");
  assert.equal(approved.autonomy_decision.requested_level, "bounded-autonomous");
  assert.equal(approved.autonomy_decision.effective_level, "checkpointed");
  assert.equal(approved.autonomy_decision.autonomous, false);
  assert.equal(approved.human_guidance.details.capped_by_ceiling, true);
  assert.match(approved.human_guidance.impact, /capped at that maximum/u);
});

test("an unknown level is still refused and a choice within the ceiling is not capped", () => {
  const project = prepareCheckpointedCeilingProject();
  const refused = run(proposeArgs(project, "full"));
  assert.notEqual(refused.status, 0);
  assert.match(`${refused.stdout}\n${refused.stderr}`, /--level must be one of supervised, checkpointed, bounded-autonomous; received .full./u);
  const profilePath = path.join(project, ".sdlc", "autonomy", "deliveries", `${PROFILE_ID}.json`);
  assert.equal(fs.existsSync(profilePath), false, "a refused proposal writes no profile");

  // A choice within the ceiling is not capped and keeps the usual wording.
  const within = mustRunJson(proposeArgs(project, "checkpointed"));
  assert.equal(within.delivery_profile.requested_level, "checkpointed");
  assert.equal(within.delivery_profile.effective_level, "checkpointed");
  assert.equal(within.review.level_capped_by, null);
  assert.equal(within.human_guidance.details.capped_by_ceiling, false);
  assert.doesNotMatch(within.human_guidance.impact, /capped at that maximum/u);
});
