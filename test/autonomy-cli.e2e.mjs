import test, { after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { fileURLToPath } from "node:url";

import {
  buildDeliveryExecutionProfile,
  computeDeliveryExecutionProfileHash,
} from "../lib/autonomy-policy.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(repoRoot, "bin", "agentic-sdlc.mjs");
const providerCommandShim = path.join(repoRoot, "test", "helpers", "provider-command-shim.cjs");
const tempProjects = new Set();
const providerBins = new Map();

function tmpProject(name) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), `sdlc-autonomy-${name}-`));
  tempProjects.add(project);
  return project;
}

after(() => {
  if (process.env.AGENTIC_SDLC_KEEP_TEST_TMP === "1") return;
  for (const project of tempProjects) {
    fs.rmSync(project, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
  tempProjects.clear();
  providerBins.clear();
});

function run(args, options = {}) {
  const env = { ...process.env };
  for (const key of ["CI", "GITHUB_ACTIONS", "GITHUB_ACTOR", "CODEX_AGENT_NAME", "CODEX_USER_ID"]) {
    delete env[key];
  }
  Object.assign(env, options.env || {});
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: options.cwd || repoRoot,
    encoding: "utf8",
    env,
    timeout: options.timeout || 60_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function runAsync(args, options = {}) {
  const env = { ...process.env };
  for (const key of ["CI", "GITHUB_ACTIONS", "GITHUB_ACTOR", "CODEX_AGENT_NAME", "CODEX_USER_ID"]) {
    delete env[key];
  }
  Object.assign(env, options.env || {});
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: options.cwd || repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${args.join(" ")} exceeded its test timeout`));
    }, options.timeout || 60_000);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (status, signal) => {
      clearTimeout(timeout);
      resolve({
        status,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function mustRun(args, options = {}) {
  const result = run(args, options);
  assert.equal(result.error, undefined, `${args.join(" ")} failed to execute: ${result.error?.message}`);
  assert.equal(result.signal, null, `${args.join(" ")} terminated by ${result.signal}`);
  assert.equal(result.status, 0, `${args.join(" ")}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result;
}

function mustFail(args, pattern, options = {}) {
  const result = run(args, options);
  assert.equal(result.error, undefined, `${args.join(" ")} failed to execute: ${result.error?.message}`);
  assert.equal(result.signal, null, `${args.join(" ")} terminated by ${result.signal}`);
  assert.notEqual(result.status, 0, `${args.join(" ")} unexpectedly passed\n${result.stdout}`);
  const combined = `${result.stdout}\n${result.stderr}`;
  assert.match(combined, pattern, `${args.join(" ")}\n${combined}`);
  return result;
}

function mustRunJson(args, options = {}) {
  return JSON.parse(mustRun([...args, "--json"], options).stdout);
}

const INTERNAL_HUMAN_GUIDANCE_PATTERN = /\b(?:bounded[-_ ]autonomous|checkpoint(?:ed|s)?|audit[-_ ]only|host[-_ ]verified|profiles?|profil[oi]|receipts?|ricevut[ae]|ceiling|schema|hash(?:es)?|reason[_ -]?codes?|codic[ei] (?:motivo|ragione)|(?:REQ|AUT|AUTH|CAP|ST|ACT|PR)-[A-Z0-9][A-Z0-9._-]*)\b/iu;

function splitHumanGuidance(output, locale = "en") {
  const divider = locale === "it"
    ? "Dettagli tecnici (facoltativi):"
    : "Technical details (optional):";
  const labels = locale === "it"
    ? ["Risultato", "Cosa cambia in pratica", "Cosa devi decidere", "Cosa resta protetto", "Prossimo passo"]
    : ["Outcome", "What this changes in practice", "What you need to decide", "What remains protected", "Next step"];
  const dividerIndex = output.indexOf(divider);
  assert.notEqual(dividerIndex, -1, `missing ${divider}\n${output}`);
  const primary = output.slice(0, dividerIndex).trim();
  const technical = output.slice(dividerIndex + divider.length).trim();
  const lines = primary.split(/\r?\n/u);
  for (const label of labels) {
    assert.ok(lines.some((line) => line.startsWith(`${label}:`)), `missing ${label}\n${output}`);
  }
  assert.doesNotMatch(primary, INTERNAL_HUMAN_GUIDANCE_PATTERN);
  return { primary, technical, firstLine: lines.find(Boolean) || "" };
}

function mustGit(project, args) {
  const result = spawnSync("git", ["-C", project, ...args], {
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.error, undefined, `git ${args.join(" ")} failed: ${result.error?.message}`);
  assert.equal(result.status, 0, `git ${args.join(" ")}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result.stdout.trim();
}

function resolveHostCommand(command) {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(locator, [command], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.error, undefined, `${locator} ${command} failed: ${result.error?.message}`);
  assert.equal(result.status, 0, `${locator} ${command}\n${result.stdout}\n${result.stderr}`);
  const resolved = result.stdout.split(/\r?\n/u).map((item) => item.trim()).find(Boolean);
  assert.ok(resolved && fs.existsSync(resolved), `${command} must resolve to a host executable`);
  return fs.realpathSync.native(resolved);
}

function createNativeProviderShim(fakeBin, command) {
  const executable = path.join(fakeBin, process.platform === "win32" ? `${command}.exe` : command);
  if (!fs.existsSync(executable)) {
    const nodeExecutable = fs.realpathSync.native(process.execPath);
    // Never hard-link the host runtime into a fixture. Creating the link
    // changes its link count/ctime, and chmod on that link mutates the original
    // executable. A clone-capable copy stays fast without changing host state.
    fs.copyFileSync(
      nodeExecutable,
      executable,
      fs.constants.COPYFILE_FICLONE,
    );
    if (process.platform !== "win32") {
      fs.chmodSync(executable, 0o755);
    }
  }
  return executable;
}

function externalProviderBin(project, command) {
  const key = `${project}\0${command}`;
  const existing = providerBins.get(key);
  if (existing) return existing;
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), `sdlc-autonomy-provider-${command}-`));
  tempProjects.add(fakeBin);
  providerBins.set(key, fakeBin);
  return fakeBin;
}

function providerShimEnv(provider) {
  const requireOption = /\s/u.test(providerCommandShim)
    ? `--require=${JSON.stringify(providerCommandShim)}`
    : `--require=${providerCommandShim}`;
  return {
    AUTONOMY_FAKE_PROVIDER: provider,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, requireOption].filter(Boolean).join(" "),
  };
}

function fakeGitRemoteEnv(project, remoteSha) {
  const fakeBin = externalProviderBin(project, "git");
  const realGit = resolveHostCommand("git");
  createNativeProviderShim(fakeBin, "git");
  return {
    ...providerShimEnv("git"),
    PATH: [fakeBin, process.env.PATH].filter(Boolean).join(path.delimiter),
    AUTONOMY_REAL_GIT: realGit,
    AUTONOMY_FAKE_REMOTE_SHA: remoteSha,
  };
}

function fakeGitHubEnv(project, values) {
  const fakeBin = externalProviderBin(project, "gh");
  createNativeProviderShim(fakeBin, "gh");
  const baseSha = values.baseSha ?? mustGit(project, ["rev-parse", "refs/remotes/origin/main"]);
  return {
    ...providerShimEnv("gh"),
    PATH: [fakeBin, process.env.PATH].filter(Boolean).join(path.delimiter),
    AUTONOMY_FAKE_GH_STATE: values.state,
    AUTONOMY_FAKE_GH_URL: values.url,
    AUTONOMY_FAKE_GH_DRAFT: String(values.isDraft ?? false),
    AUTONOMY_FAKE_GH_HEAD_SHA: values.headSha,
    AUTONOMY_FAKE_GH_HEAD: values.headBranch,
    AUTONOMY_FAKE_GH_BASE: values.baseBranch,
    AUTONOMY_FAKE_GH_BASE_SHA: baseSha,
    AUTONOMY_FAKE_GH_MERGED_AT: values.mergedAt || "",
    AUTONOMY_FAKE_GH_MERGE_SHA: values.mergeSha || "",
  };
}

function humanApproval(summary) {
  return [
    "--actor-type", "human",
    "--approval-source", "explicit-user",
    "--summary", summary,
  ];
}

function hostSupportsLocalSmokeSandbox() {
  if (process.platform === "darwin") return fs.existsSync("/usr/bin/sandbox-exec");
  if (process.platform === "linux") return fs.existsSync("/usr/bin/bwrap");
  return false;
}

function prepareMacOsLocalSmokeRelease({
  suffix,
  smokeSource,
  smokeCommandArgv = null,
  commandOptions = {},
  authorizeRelease = true,
  deferSmokeMaterialization = false,
}) {
  const storyId = `ST-MACOS-SMOKE-${suffix}`;
  const contractId = `CONTRACT-MACOS-SMOKE-${suffix}`;
  const profileId = `AUT-MACOS-SMOKE-${suffix}`;
  const project = tmpProject(`macos-local-smoke-${suffix.toLowerCase()}`);
  initializeAutonomyProject(project);
  createApprovedImplementationContract(project, {
    storyId,
    contractId,
    profileId,
  });

  const releaseRoot = path.join(project, "local-release");
  const releaseOutput = path.join(releaseRoot, "app");
  const smokeFileName = `smoke-${suffix.toLowerCase()}.mjs`;
  const smokeFile = path.join(releaseOutput, smokeFileName);
  const releaseEvidence = path.join(releaseOutput, "release-proof.txt");
  const rollbackEvidenceName = `rollback-${suffix.toLowerCase()}.json`;
  const rollbackEvidence = path.join(project, rollbackEvidenceName);
  const smokeCommand = JSON.stringify(smokeCommandArgv || ["node", smokeFileName]);
  const rollback = `Remove the ${suffix.toLowerCase()} local smoke fixture.`;

  fs.mkdirSync(releaseOutput, { recursive: true });
  if (!deferSmokeMaterialization) {
    fs.writeFileSync(smokeFile, smokeSource, "utf8");
    if (smokeCommandArgv) fs.chmodSync(smokeFile, 0o755);
  }
  fs.writeFileSync(releaseEvidence, "local smoke release evidence\n", "utf8");
  fs.writeFileSync(
    rollbackEvidence,
    `${JSON.stringify({ target: "local-release/app", restored: true })}\n`,
    "utf8",
  );

  const proposal = mustRunJson([
    "autonomy", "delivery", "propose",
    "--root", project,
    "--id", profileId,
    "--delivery", `LOCAL-MACOS-SMOKE-${suffix}`,
    "--kind", "local_release",
    "--story", storyId,
    "--contract", contractId,
    "--requirement", "REQ-AUTONOMY",
    "--level", "checkpointed",
    "--target-root", releaseRoot,
    "--write-path", releaseOutput,
    "--smoke-cwd", releaseOutput,
    "--smoke-test", smokeCommand,
    "--rollback", rollback,
  ], commandOptions);
  mustRunJson([
    "autonomy", "delivery", "approve",
    "--root", project,
    "--id", profileId,
    "--phase", "implementation",
    ...humanApproval(`Approve ${suffix.toLowerCase()} local smoke delivery`),
  ], commandOptions);
  mustRunJson([
    "task", "start",
    "--root", project,
    "--intent-json", taskIntent(storyId),
    "--delivery-profile", profileId,
  ], commandOptions);
  const rollbackAuthorization = mustRunJson([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", profileId,
    "--action", "rollback.verify",
    "--evidence", rollbackEvidenceName,
    "--confirm-action",
    ...humanApproval(`Approve ${suffix.toLowerCase()} rollback evidence`),
  ], commandOptions);
  mustRunJson([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", profileId,
    "--action", "rollback.verify",
    "--outcome", "passed",
    "--authorization-receipt", rollbackAuthorization.action_receipt.id,
    "--evidence", rollbackEvidenceName,
  ], commandOptions);
  const releaseAuthorization = authorizeRelease
    ? mustRunJson([
        "autonomy", "delivery", "action",
        "--root", project,
        "--id", profileId,
        "--action", "release.local",
        "--confirm-action",
        ...humanApproval(`Approve ${suffix.toLowerCase()} local release`),
      ], commandOptions)
    : null;
  const completionArgsFor = (authorizationReceiptId) => [
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", profileId,
    "--action", "release.local",
    "--outcome", "passed",
    "--authorization-receipt", authorizationReceiptId,
    "--evidence", "local-release/app/release-proof.txt",
    "--smoke-cwd", releaseOutput,
    "--smoke-test", smokeCommand,
    "--rollback", rollback,
  ];

  return {
    project,
    profileId,
    proposal,
    releaseOutput,
    smokeFile,
    smokeSource,
    releaseEvidence,
    smokeCommand,
    rollback,
    releaseAuthorization,
    completionArgsFor,
    completionArgs: releaseAuthorization
      ? completionArgsFor(releaseAuthorization.action_receipt.id)
      : null,
  };
}

function localReleaseAttemptReceipts(project, profileId) {
  const attemptsRoot = path.join(
    project,
    ".sdlc",
    "autonomy",
    "executions",
    profileId,
    "attempts",
  );
  if (!fs.existsSync(attemptsRoot)) return [];
  return fs.readdirSync(attemptsRoot)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(fs.readFileSync(path.join(attemptsRoot, name), "utf8")));
}

function localReleaseActionReceipts(project, profileId) {
  const actionsRoot = path.join(project, ".sdlc", "autonomy", "actions");
  if (!fs.existsSync(actionsRoot)) return [];
  return fs.readdirSync(actionsRoot)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(fs.readFileSync(path.join(actionsRoot, name), "utf8")))
    .filter((receipt) =>
      receipt.profile_ref?.id === profileId
      && receipt.action === "release.local");
}

/**
 * Record an approved code review of the current head by a reviewer who is not
 * an author of the pull request, as gate_policy.merge_requires_code_review
 * requires before pull_request.merge.
 */
function recordIndependentReview(project, profileId) {
  return mustRunJson([
    "review", "record",
    "--root", project,
    "--delivery", profileId,
    "--verdict", "approved",
    "--actor", "independent-reviewer",
    "--actor-type", "human",
  ], {
    env: {
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: "Independent Reviewer",
      GIT_CONFIG_KEY_1: "user.email",
      GIT_CONFIG_VALUE_1: "independent-reviewer@example.invalid",
    },
  });
}

function taskIntent(storyId) {
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

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}

function lifecycleReceiptHash(record) {
  const canonical = structuredClone(record);
  delete canonical.receipt_hash;
  delete canonical.hash_algorithm;
  return crypto.createHash("sha256").update(stableJson(canonical)).digest("hex");
}

function mutateDeliveryStartReceipt(project, profileId, storyId, mutate) {
  const startPath = path.join(
    project,
    ".sdlc",
    "autonomy",
    "executions",
    profileId,
    "start.json",
  );
  const start = JSON.parse(fs.readFileSync(startPath, "utf8"));
  mutate(start);
  start.receipt_hash = lifecycleReceiptHash(start);
  fs.writeFileSync(startPath, `${JSON.stringify(start, null, 2)}\n`, "utf8");

  const taskStartPath = path.join(
    project,
    ".sdlc",
    "stories",
    storyId,
    "task-start.json",
  );
  const taskStart = JSON.parse(fs.readFileSync(taskStartPath, "utf8"));
  taskStart.delivery_start_receipt_ref.hash = start.receipt_hash;
  fs.writeFileSync(
    taskStartPath,
    `${JSON.stringify(taskStart, null, 2)}\n`,
    "utf8",
  );
  return start;
}

function legacyAuthorizationContentHash(record) {
  const canonical = structuredClone(record);
  for (const field of [
    "approved_content_hash",
    "hash_algorithm",
    "status",
    "updated_at",
    "revoked_at",
    "revocation_reason",
    "consumed_at",
    "closed_at",
    "closed_reason",
    "use_count",
    "__path",
    "__relative_path",
    "approvals",
    "audit",
    "created_at",
    "approved_at",
    "approved_by",
  ]) {
    delete canonical[field];
  }
  return crypto.createHash("sha256").update(stableJson(canonical)).digest("hex");
}

function checkpointPolicySourceHash(record) {
  const canonical = structuredClone(record);
  delete canonical.source_hash;
  delete canonical.hash_algorithm;
  return crypto.createHash("sha256").update(stableJson(canonical)).digest("hex");
}

function commitCoverageHash(record) {
  const canonical = structuredClone(record);
  delete canonical.coverage_hash;
  return crypto.createHash("sha256").update(stableJson(canonical)).digest("hex");
}

function initializeAutonomyProject(project, options = {}) {
  mustRun(["init", "--root", project, "--project-name", "Autonomy E2E", "--force"]);
  mustGit(project, ["init"]);
  mustGit(project, ["config", "user.name", "Autonomy E2E"]);
  mustGit(project, ["config", "user.email", "autonomy-e2e@example.invalid"]);
  mustGit(project, ["commit", "--allow-empty", "-m", "test: establish PR base"]);
  mustGit(project, ["branch", "-M", "main"]);
  mustGit(project, ["remote", "add", "origin", "https://github.com/aantenore/agentic-sdlc-codex-plugin.git"]);
  mustGit(project, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  mustGit(project, ["checkout", "-b", "codex/pr-1"]);

  const proposed = mustRunJson([
    "requirement", "propose",
    "--root", project,
    "--id", "REQ-AUTONOMY",
    "--title", "Govern one delivery at a time",
    "--summary", "Implement the agreed behavior while selecting autonomy independently for every PR or local release.",
    "--acceptance", "Each delivery has an exact non-reusable autonomy decision.",
    "--constraint", "Never infer autonomy from an earlier delivery.",
    "--autonomy-ceiling", "bounded-autonomous",
    ...(options.requirementWritePaths === undefined
      ? ["--write-path", "src"]
      : options.requirementWritePaths.flatMap((writePath) => ["--write-path", writePath])),
  ]);
  assert.equal(proposed.requirement.schema_version, "requirement:v2");
  assert.equal(proposed.requirement.status, "proposed");
  assert.equal(proposed.autonomy_profile.status, "proposed");
  assert.equal(proposed.autonomy_profile.autonomy_ceiling, "bounded-autonomous");

  const approved = mustRunJson([
    "requirement", "approve",
    "--root", project,
    "--id", "REQ-AUTONOMY",
    ...humanApproval("Approve the requirement and its bounded-autonomous ceiling"),
  ]);
  assert.equal(approved.requirement.status, "approved");
  assert.equal(approved.autonomy_profile.status, "active");
  assert.equal(approved.autonomy_profile.autonomy_ceiling, "bounded-autonomous");
  assert.equal(approved.autonomy_profile.authority_assurance.mode, "audit_only");

  const immutableRequirementPath = path.join(project, ".sdlc", "requirements", "REQ-AUTONOMY.json");
  const immutableRequirement = fs.readFileSync(immutableRequirementPath, "utf8");
  mustFail([
    "requirement", "propose",
    "--root", project,
    "--id", "REQ-AUTONOMY",
    "--title", "Attempted overwrite",
    "--summary", "An approved requirement must never be overwritten in place.",
    "--acceptance", "The overwrite is rejected.",
    "--autonomy-ceiling", "supervised",
    "--force",
  ], /File already exists/u);
  assert.equal(fs.readFileSync(immutableRequirementPath, "utf8"), immutableRequirement);

  mustRun([
    "output", "template", "propose",
    "--root", project,
    "--type", "implementation-summary",
    "--summary", "Implementation evidence used by autonomy E2E tests",
  ]);
  mustRun([
    "output", "template", "approve",
    "--root", project,
    "--id", "implementation-summary-v1",
    ...humanApproval("Approve the implementation evidence format"),
  ]);
}

function createApprovedImplementationContract(project, { storyId, contractId, profileId }) {
  const story = mustRunJson([
    "story", "create",
    "--root", project,
    "--id", storyId,
    "--title", `Implement ${storyId}`,
    "--phase", "implementation",
    "--status", "ready",
    "--requirement", "REQ-AUTONOMY",
    "--acceptance", `Observable implementation evidence exists for ${storyId}.`,
  ]).story;
  assert.equal(story.requirement_refs.length, 1);
  assert.equal(story.autonomy_ceiling, "bounded-autonomous");

  const contract = mustRunJson([
    "contract", "create",
    "--root", project,
    "--phase", "implementation",
    "--story", storyId,
    "--id", contractId,
    "--delivery-profile", profileId,
    "--level", "bounded-autonomous",
    "--context-summary", `Implement ${storyId} inside the exact reviewed delivery boundary.`,
    "--qa", "Who confirms the delivery boundary?|The human reviewer",
    "--output-ref", "implementation-summary:implementation-summary-v1:new",
    "--tool", "node",
  ]).contract;
  assert.equal(contract.delivery_execution_profile_id, profileId);
  assert.equal(contract.autonomy_level, "bounded-autonomous");
  assert.equal(contract.requirement_execution_profile_refs.length, 1);

  const approved = mustRunJson([
    "contract", "approve",
    "--root", project,
    "--id", contractId,
    ...humanApproval(`Approve ${contractId}`),
  ]).contract;
  assert.equal(approved.status, "approved");
}

test("native provider shims do not mutate the host Node executable", () => {
  const nodeExecutable = fs.realpathSync.native(process.execPath);
  const before = fs.statSync(nodeExecutable, { bigint: true });
  const fakeBin = externalProviderBin(tmpProject("provider-shim-metadata"), "git");

  const shim = createNativeProviderShim(fakeBin, "git");

  const after = fs.statSync(nodeExecutable, { bigint: true });
  assert.equal(fs.statSync(shim, { bigint: true }).size, before.size);
  for (const field of ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"]) {
    assert.equal(after[field], before[field], field);
  }
});

test("task start blocks product work before preflight when approved requirement write scope is empty", () => {
  const project = tmpProject("empty-requirement-write-scope");
  initializeAutonomyProject(project, { requirementWritePaths: [] });
  createApprovedImplementationContract(project, {
    storyId: "ST-EMPTY-REQ-SCOPE",
    contractId: "CONTRACT-EMPTY-REQ-SCOPE",
    profileId: "AUT-EMPTY-REQ-SCOPE",
  });
  mustRunJson([
    "autonomy", "delivery", "propose",
    "--root", project,
    "--id", "AUT-EMPTY-REQ-SCOPE",
    "--delivery", "PR-EMPTY-REQ-SCOPE",
    "--kind", "pull_request",
    "--story", "ST-EMPTY-REQ-SCOPE",
    "--contract", "CONTRACT-EMPTY-REQ-SCOPE",
    "--requirement", "REQ-AUTONOMY",
    "--level", "checkpointed",
    "--repository", "aantenore/agentic-sdlc-codex-plugin",
    "--base", "main",
    "--head", "codex/pr-1",
    "--write-path", "src",
  ]);
  mustRunJson([
    "autonomy", "delivery", "approve",
    "--root", project,
    "--id", "AUT-EMPTY-REQ-SCOPE",
    ...humanApproval("Approve the exact empty-scope regression delivery"),
  ]);

  const blocked = mustRunJson([
    "task", "start",
    "--root", project,
    "--intent-json", taskIntent("ST-EMPTY-REQ-SCOPE"),
    "--delivery-profile", "AUT-EMPTY-REQ-SCOPE",
  ]);
  assert.equal(blocked.execution_allowed, false);
  assert.equal(blocked.contract_action, "revise_requirement_write_scope");
  assert.equal(blocked.blocking_reasons.includes("requirement_write_scope_required"), true);
  assert.equal(
    blocked.deterministic_checks.some((check) =>
      check.check === "requirement_write_scope" && check.status === "failed"),
    true,
  );
  assert.equal(
    blocked.next_commands.some((command) =>
      /requirement revise .*--new-id .*--write-path/u.test(command)),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(
      project,
      ".sdlc",
      "autonomy",
      "executions",
      "AUT-EMPTY-REQ-SCOPE",
      "context-preflight.json",
    )),
    false,
  );
  assert.equal(
    fs.existsSync(path.join(project, ".sdlc", "stories", "ST-EMPTY-REQ-SCOPE", "task-start.json")),
    false,
  );

  const italian = mustRunJson([
    "task", "start",
    "--root", project,
    "--intent-json", taskIntent("ST-EMPTY-REQ-SCOPE"),
    "--delivery-profile", "AUT-EMPTY-REQ-SCOPE",
    "--locale", "it",
  ]);
  assert.match(italian.assistant_message, /non indica ancora alcuna area di file del progetto/iu);
  assert.equal(italian.blocking_reasons.includes("requirement_write_scope_required"), true);
  assert.equal(
    italian.next_commands.some((command) =>
      /requirement revise .*--new-id .*--write-path/u.test(command)),
    true,
  );

  const customPhase = mustRunJson([
    "task", "start",
    "--root", project,
    "--intent-json", taskIntent("ST-EMPTY-REQ-SCOPE"),
    "--delivery-profile", "AUT-EMPTY-REQ-SCOPE",
    "--phase", "integration-review",
  ]);
  assert.equal(customPhase.route, "claim_and_implement");
  assert.equal(customPhase.phase, "integration-review");
  assert.equal(customPhase.execution_allowed, false);
  assert.equal(
    customPhase.blocking_reasons.includes("requirement_write_scope_required"),
    true,
  );
});

function prepareAuthorizedPullRequestMerge(suffix) {
  const project = tmpProject(`pull-request-merge-${suffix}`);
  initializeAutonomyProject(project);
  createApprovedImplementationContract(project, {
    storyId: "ST-PR-MERGE",
    contractId: "CONTRACT-PR-MERGE",
    profileId: "AUT-PR-MERGE",
  });
  mustRunJson([
    "autonomy", "delivery", "propose",
    "--root", project,
    "--id", "AUT-PR-MERGE",
    "--delivery", "PR-MERGE",
    "--kind", "pull_request",
    "--story", "ST-PR-MERGE",
    "--contract", "CONTRACT-PR-MERGE",
    "--requirement", "REQ-AUTONOMY",
    "--level", "checkpointed",
    "--repository", "aantenore/agentic-sdlc-codex-plugin",
    "--base", "main",
    "--head", "codex/pr-1",
    "--write-path", "src",
    "--allow-action", "pull_request.merge",
    "--merge-allowed",
  ]);
  mustRunJson([
    "autonomy", "delivery", "approve",
    "--root", project,
    "--id", "AUT-PR-MERGE",
    ...humanApproval("Approve checkpointed autonomy for this exact merge delivery"),
  ]);

  const proofPath = path.join(project, "src", "merge-proof.txt");
  const approvalProofPath = path.join(project, "src", "merge-approval.txt");
  const summaryPath = path.join(project, "src", "implementation-summary.md");
  fs.mkdirSync(path.dirname(proofPath), { recursive: true });
  fs.writeFileSync(proofPath, "exact merge head\n", "utf8");
  fs.writeFileSync(approvalProofPath, "exact human merge approval evidence\n", "utf8");
  fs.writeFileSync(summaryPath, "# Implementation summary\n\nThe exact merge transition is verified.\n", "utf8");
  mustGit(project, [
    "add", "--",
    "src/merge-proof.txt",
    "src/merge-approval.txt",
    "src/implementation-summary.md",
  ]);
  mustGit(project, ["commit", "-m", "test: establish exact merge head"]);
  const headSha = mustGit(project, ["rev-parse", "HEAD"]);
  const baseSha = mustGit(project, ["rev-parse", "refs/remotes/origin/main"]);

  const started = mustRunJson([
    "task", "start",
    "--root", project,
    "--intent-json", taskIntent("ST-PR-MERGE"),
    "--delivery-profile", "AUT-PR-MERGE",
  ]);
  assert.equal(started.execution_allowed, true);
  mustRun([
    "story", "claim",
    "--root", project,
    "--id", "ST-PR-MERGE",
    "--agent", "codex",
    "--branch", "codex/ST-PR-MERGE",
  ]);
  mustRun([
    "output", "link",
    "--root", project,
    "--story", "ST-PR-MERGE",
    "--type", "implementation-summary",
    "--artifact", "src/implementation-summary.md",
    "--template", "implementation-summary-v1",
    "--mode", "new",
    "--requirement", "REQ-AUTONOMY",
  ]);

  const prUrl = "https://github.com/aantenore/agentic-sdlc-codex-plugin/pull/999999";
  const openState = {
    state: "OPEN",
    url: prUrl,
    headSha,
    headBranch: "codex/pr-1",
    baseBranch: "main",
    baseSha,
  };
  recordIndependentReview(project, "AUT-PR-MERGE");
  const authorization = mustRunJson([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-PR-MERGE",
    "--action", "pull_request.merge",
    "--pr-url", prUrl,
    "--confirm-action",
    "--approval-evidence", "src/merge-approval.txt",
    ...humanApproval("Approve this exact open PR merge checkpoint"),
  ], { env: fakeGitHubEnv(project, openState) });
  const authorizedReceipt = authorization.action_receipt;
  assert.equal(authorizedReceipt.runtime_target.base_sha, baseSha);
  assert.equal(authorizedReceipt.action_details.merge.base_sha, baseSha);
  assert.equal(authorizedReceipt.action_details.provider_operation.precondition_receipt.subject.base_sha, baseSha);
  assert.equal(authorizedReceipt.action_details.provider_operation.precondition_receipt.proof.base_sha, baseSha);

  return {
    project,
    proofPath,
    approvalProofPath,
    authorization,
    openState,
    baseSha,
    headSha,
  };
}

function completeAuthorizedPullRequestMerge(fixture, mergeSha, overrides = {}) {
  const mergedAt = new Date(Date.parse(fixture.authorization.action_receipt.authorized_at) + 1_000).toISOString();
  return mustRunJson([
    "autonomy", "delivery", "action",
    "--root", fixture.project,
    "--id", "AUT-PR-MERGE",
    "--action", "pull_request.merge",
    "--outcome", "passed",
    "--evidence", "src/merge-proof.txt",
  ], {
    env: fakeGitHubEnv(fixture.project, {
      ...fixture.openState,
      state: "MERGED",
      mergedAt,
      mergeSha,
      ...overrides,
    }),
  });
}

function syntheticCommit(project, treeish, parents, message) {
  return mustGit(project, [
    "commit-tree",
    `${treeish}^{tree}`,
    ...parents.flatMap((parent) => ["-p", parent]),
    "-m", message,
  ]);
}

function assertMergeReceiptGateIntegrity(project) {
  const gate = run([
    "gate", "check",
    "--root", project,
    "--scope", "story",
    "--story", "ST-PR-MERGE",
    "--strict",
    "--json",
  ]);
  assert.equal(gate.error, undefined, gate.error?.message);
  assert.equal(gate.signal, null, `merge receipt gate terminated by ${gate.signal}`);
  assert.equal(gate.status, 0, gate.stderr || gate.stdout);
  const report = JSON.parse(gate.stdout);
  assert.deepEqual(report.errors, [], gate.stdout);
}

test("an existing pull request is pinned before approval and cannot be retargeted by later callers", () => {
  const project = tmpProject("existing-pull-request");
  initializeAutonomyProject(project);
  createApprovedImplementationContract(project, {
    storyId: "ST-EXISTING-PR",
    contractId: "CONTRACT-EXISTING-PR",
    profileId: "AUT-EXISTING-PR",
  });
  const existingHeadPath = path.join(project, "src", "existing-pr-head.txt");
  fs.mkdirSync(path.dirname(existingHeadPath), { recursive: true });
  fs.writeFileSync(existingHeadPath, "existing PR reviewed head\n", "utf8");
  mustGit(project, ["add", "--", "src/existing-pr-head.txt"]);
  mustGit(project, ["commit", "-m", "test: establish existing PR head"]);
  const commonProposal = [
    "autonomy", "delivery", "propose",
    "--root", project,
    "--id", "AUT-EXISTING-PR",
    "--delivery", "PR-184",
    "--kind", "pull_request",
    "--pr-mode", "existing",
    "--story", "ST-EXISTING-PR",
    "--contract", "CONTRACT-EXISTING-PR",
    "--requirement", "REQ-AUTONOMY",
    "--level", "checkpointed",
    "--repository", "aantenore/agentic-sdlc-codex-plugin",
    "--base", "main",
    "--head", "codex/pr-1",
    "--write-path", "src",
  ];
  mustFail(commonProposal, /requires --pr-number/u);
  mustFail([
    ...commonProposal,
    "--pr-number", "184",
  ], /requires the exact --pr-url/u);
  mustFail([
    ...commonProposal,
    "--pr-number", "184",
    "--pr-url", "https://github.com/aantenore/agentic-sdlc-codex-plugin/pull/185",
  ], /does not match --pr-url number 185/u);
  mustFail([
    ...commonProposal,
    "--pr-number", "184",
    "--pr-url", "https://github.com/other/repository/pull/184",
  ], /must identify one exact pull request in the approved repository/u);
  mustFail([
    ...commonProposal,
    "--pr-number", "184",
    "--pr-url", "https://github.com/aantenore/agentic-sdlc-codex-plugin/pull/184",
    "--allow-action", "pull_request.create",
  ], /cannot allow pull_request\.create/u);

  const reviewedHeadSha = mustGit(project, ["rev-parse", "HEAD"]);
  const proposal = mustRunJson([
    ...commonProposal,
    "--pr-number", "184",
    "--pr-url", "https://github.com/aantenore/agentic-sdlc-codex-plugin/pull/184",
  ]);
  const target = proposal.delivery_profile.pull_request_target;
  assert.equal(target.mode, "existing");
  assert.equal(target.pr_number, 184);
  assert.equal(
    target.pr_url,
    "https://github.com/aantenore/agentic-sdlc-codex-plugin/pull/184",
  );
  assert.equal(target.reviewed_head_sha, reviewedHeadSha);
  assert.equal(target.allowed_actions.includes("pull_request.create"), false);
  assert.equal(
    proposal.delivery_profile.provider_bindings.some((binding) =>
      binding.action === "pull_request.create"),
    false,
  );
  assert.equal(proposal.review.target.pr_number, 184);

  mustRunJson([
    "autonomy", "delivery", "approve",
    "--root", project,
    "--id", "AUT-EXISTING-PR",
    ...humanApproval("Approve work on existing PR 184 only"),
  ]);
  const started = mustRunJson([
    "task", "start",
    "--root", project,
    "--intent-json", taskIntent("ST-EXISTING-PR"),
    "--delivery-profile", "AUT-EXISTING-PR",
  ]);
  assert.equal(started.execution_allowed, true);

  mustFail([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-EXISTING-PR",
    "--action", "pull_request.update",
    "--pr-url", "https://github.com/aantenore/agentic-sdlc-codex-plugin/pull/185",
    "--expected-pr-state", "ready",
  ], /must use the exact existing PR #184/u);
  mustFail([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-EXISTING-PR",
    "--action", "pull_request.create",
  ], /outside the approved action set/u);

  mustGit(project, ["reset", "--hard", "refs/remotes/origin/main"]);
  mustFail([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-EXISTING-PR",
    "--action", "pull_request.update",
    "--pr-url", "https://github.com/aantenore/agentic-sdlc-codex-plugin/pull/184",
    "--expected-pr-state", "ready",
  ], /no longer descended from the reviewed commit/u);
});

test("requirement ceiling and an exact PR profile govern task start without leaking autonomy to another PR", () => {
  const project = tmpProject("pull-request");
  initializeAutonomyProject(project);
  fs.rmSync(path.join(project, ".sdlc", "config.lock.json"));
  const requirementStatus = mustRun([
    "autonomy", "requirement", "status",
    "--root", project,
    "--id", "REQ-AUTONOMY",
  ]);
  const requirementGuidance = splitHumanGuidance(requirementStatus.stdout);
  assert.match(requirementGuidance.firstLine, /^Outcome: For this requirement, the most independent option available/u);
  assert.match(requirementGuidance.primary, /Every pull request or local release needs its own choice/u);
  assert.match(requirementGuidance.technical, /Requirement: REQ-AUTONOMY/u);
  assert.match(requirementGuidance.technical, /bounded-autonomous/u);
  const requirementList = mustRun([
    "requirement", "status",
    "--root", project,
    "--id", "REQ-AUTONOMY",
  ]);
  const requirementListGuidance = splitHumanGuidance(requirementList.stdout);
  assert.match(requirementListGuidance.primary, /For every pull request or local release, you will choose separately/u);
  assert.doesNotMatch(requirementListGuidance.primary, /bounded-autonomous|checkpointed|audit_only|ceiling|profile|receipt/u);
  assert.match(requirementListGuidance.technical, /Maximum technical level: bounded-autonomous/u);
  createApprovedImplementationContract(project, {
    storyId: "ST-PR-1",
    contractId: "CONTRACT-PR-1",
    profileId: "AUT-PR-1",
  });
  const destinationUnknownIntent = taskIntent("ST-PR-1");
  const destinationUnknown = mustRunJson([
    "task", "start",
    "--root", project,
    "--intent-json", destinationUnknownIntent,
  ]);
  assert.equal(destinationUnknown.contract_action, "select_delivery_autonomy");
  assert.equal(destinationUnknown.delivery_kind, null);
  const destinationUnknownEnglish = splitHumanGuidance(mustRun([
    "task", "start",
    "--root", project,
    "--intent-json", destinationUnknownIntent,
  ]).stdout);
  assert.match(destinationUnknownEnglish.primary, /First identify this delivery's exact destination/u);
  assert.doesNotMatch(destinationUnknownEnglish.primary, /For this pull request, how independently should I work/u);
  assert.doesNotMatch(destinationUnknownEnglish.primary, /For this local release, how independently should I work/u);
  assert.doesNotMatch(destinationUnknownEnglish.primary, /(?:1\. Guided|2\. Autonomy with checks|3\. Full autonomy)/u);
  const destinationUnknownHuman = splitHumanGuidance(mustRun([
    "task", "start",
    "--root", project,
    "--intent-json", destinationUnknownIntent,
    "--locale", "it",
  ]).stdout, "it");
  assert.match(destinationUnknownHuman.primary, /Prima indica la destinazione esatta di questa consegna/u);
  assert.match(destinationUnknownHuman.primary, /ti mostrerò una sola domanda con le tre scelte applicabili/u);
  assert.doesNotMatch(destinationUnknownHuman.primary, /Per questa PR, quanto vuoi che lavori in autonomia/u);
  assert.doesNotMatch(destinationUnknownHuman.primary, /Per questo rilascio locale, quanto vuoi che lavori in autonomia/u);
  assert.doesNotMatch(destinationUnknownHuman.primary, /(?:1\. Guidato|2\. Autonomia con controlli|3\. Autonomia completa)/u);
  mustRun([
    "story", "create",
    "--root", project,
    "--id", "ST-PR-CONFLICT",
    "--title", "Reject a shared delivery profile reservation",
    "--phase", "implementation",
    "--status", "ready",
    "--requirement", "REQ-AUTONOMY",
    "--acceptance", "A second contract cannot reserve AUT-PR-1.",
  ]);
  mustFail([
    "contract", "create",
    "--root", project,
    "--phase", "implementation",
    "--story", "ST-PR-CONFLICT",
    "--id", "CONTRACT-PR-CONFLICT",
    "--delivery-profile", "AUT-PR-1",
    "--context-summary", "Attempt to reserve a profile ID already owned by another contract.",
    "--qa", "May contracts share a delivery profile?|No",
    "--output-ref", "implementation-summary:implementation-summary-v1:new",
  ], /already reserved by contract CONTRACT-PR-1/u);

  const proposalArgs = [
    "autonomy", "delivery", "propose",
    "--root", project,
    "--id", "AUT-PR-1",
    "--delivery", "PR-1",
    "--kind", "pull_request",
    "--story", "ST-PR-1",
    "--contract", "CONTRACT-PR-1",
    "--requirement", "REQ-AUTONOMY",
    "--level", "bounded-autonomous",
    "--repository", "aantenore/agentic-sdlc-codex-plugin",
    "--base", "main",
    "--head", "codex/pr-1",
    "--write-path", "src",
  ];
  const expectedRemoteUrl = "https://github.com/aantenore/agentic-sdlc-codex-plugin.git";
  mustGit(project, ["remote", "set-url", "origin", "https://github.com/example/unapproved-repository.git"]);
  mustGit(project, ["remote", "set-url", "--add", "origin", expectedRemoteUrl]);
  mustGit(project, ["remote", "set-url", "--push", "--add", "origin", expectedRemoteUrl]);
  const levelOptionIndex = proposalArgs.indexOf("--level");
  mustFail([
    ...proposalArgs.slice(0, levelOptionIndex),
    ...proposalArgs.slice(levelOptionIndex + 2),
  ], /Missing required option --level/u);
  mustFail([...proposalArgs, "--git-provider", "github-cli"], /cannot verify git\.push/u);
  const proposalResponse = mustRunJson([
    ...proposalArgs,
    "--git-provider", "git-remote",
    "--pull-request-provider", "github-cli",
  ]);
  const proposed = proposalResponse.delivery_profile;
  assert.equal(proposed.status, "proposed");
  assert.equal(proposed.delivery_kind, "pull_request");
  assert.equal(proposed.delivery_id, "PR-1");
  assert.equal(proposed.schema_version, "delivery-execution-profile:v2");
  assert.deepEqual(proposed.pull_request_target.allowed_actions, [
    "git.commit",
    "git.push",
    "pull_request.create",
    "pull_request.update",
    "repository.read",
    "repository.write",
    "test.run",
  ]);
  assert.deepEqual(proposed.provider_bindings, [
    { action: "git.push", provider_id: "git-remote" },
    { action: "pull_request.create", provider_id: "github-cli" },
    { action: "pull_request.merge", provider_id: "github-cli" },
    { action: "pull_request.update", provider_id: "github-cli" },
  ]);
  assert.equal(proposed.requested_level, "bounded-autonomous");
  assert.equal(proposed.use_policy.reusable_across_deliveries, false);
  assert.equal(proposed.pull_request_target.merge_allowed, false);
  assert.match(proposalResponse.human_guidance.impact, /project “Autonomy E2E”/u);
  assert.match(proposalResponse.human_guidance.impact, /^You chose full autonomy within the agreed limits/u);
  assert.match(proposalResponse.human_guidance.impact, /cannot digitally verify who gave it/u);
  assert.match(proposalResponse.human_guidance.impact, /destination is the selected pull-request branch/u);
  assert.match(proposalResponse.human_guidance.impact, /change only “src”/u);
  assert.match(proposalResponse.human_guidance.required_decision, /For this pull request, how independently should I work\?/u);
  assert.match(proposalResponse.human_guidance.required_decision, /1\. Guided: I ask for confirmation before important steps/u);
  assert.match(proposalResponse.human_guidance.required_decision, /2\. Autonomy with checks: I proceed independently/u);
  assert.match(proposalResponse.human_guidance.required_decision, /3\. Full autonomy within these limits: I complete this pull request/u);
  assert.match(proposalResponse.human_guidance.required_decision, /applies only to this pull request and will not be reused/u);
  assert.doesNotMatch(proposalResponse.human_guidance.required_decision, /deployed outside the local machine/u);
  assert.match(proposalResponse.human_guidance.required_decision, /before the pull request is merged/u);
  assert.match(proposalResponse.human_guidance.required_decision, /no separate calendar deadline.*ends when the pull request is merged, closed, or cancelled/u);
  assert.equal(proposalResponse.human_guidance.details.project_name, "Autonomy E2E");
  assert.equal(
    proposalResponse.human_guidance.details.repository,
    "github.com/aantenore/agentic-sdlc-codex-plugin",
  );
  assert.equal(proposalResponse.human_guidance.details.base_branch, "main");
  assert.equal(proposalResponse.human_guidance.details.head_branch, "codex/pr-1");
  assert.deepEqual(proposalResponse.human_guidance.details.allowed_write_paths, ["src"]);
  assert.deepEqual(proposalResponse.human_guidance.details.review_moments, ["pull_request.merge"]);
  assert.equal(proposalResponse.human_guidance.details.expires_at, null);

  const activated = mustRunJson([
    "autonomy", "delivery", "approve",
    "--root", project,
    "--id", "AUT-PR-1",
    "--phase", "implementation",
    ...humanApproval("Approve bounded autonomy for PR-1 only"),
  ]);
  assert.equal(activated.delivery_profile.status, "active");
  assert.equal(activated.autonomy_decision.requested_level, "bounded-autonomous");
  assert.equal(activated.autonomy_decision.effective_level, "checkpointed");
  assert.equal(activated.autonomy_decision.execution_status, "checkpoint_required");
  assert.equal(activated.autonomy_decision.requires_checkpoint, true);
  assert.equal(activated.autonomy_decision.autonomous, false);
  assert.ok(activated.autonomy_decision.reason_codes.includes("delivery.authority.audit_only_caps_autonomy"));

  const humanStatus = mustRun([
    "autonomy", "delivery", "status",
    "--root", project,
    "--id", "AUT-PR-1",
  ]);
  const deliveryGuidance = splitHumanGuidance(humanStatus.stdout);
  assert.match(deliveryGuidance.firstLine, /^Outcome: The working choice is active for one pull request/u);
  assert.match(deliveryGuidance.primary, /What this changes in practice: You chose full autonomy within the agreed limits/u);
  assert.match(deliveryGuidance.primary, /cannot digitally verify who gave it/u);
  assert.match(deliveryGuidance.primary, /Next step: .*approved limits.*review moment/u);
  assert.match(deliveryGuidance.technical, /Profile: AUT-PR-1/u);
  assert.match(deliveryGuidance.technical, /Requested technical level: bounded-autonomous/u);
  assert.match(deliveryGuidance.technical, /Effective technical level: checkpointed/u);
  assert.match(deliveryGuidance.technical, /Technical reason codes: .*delivery\.authority\.audit_only_caps_autonomy/u);

  const humanExplainItalian = mustRun([
    "autonomy", "delivery", "explain",
    "--root", project,
    "--id", "AUT-PR-1",
    "--locale", "it",
  ]);
  const deliveryGuidanceItalian = splitHumanGuidance(humanExplainItalian.stdout, "it");
  assert.match(deliveryGuidanceItalian.firstLine, /^Risultato: La scelta del modo di lavorare è attiva per una sola pull request/u);
  assert.match(deliveryGuidanceItalian.primary, /Cosa cambia in pratica: Hai scelto autonomia completa entro i limiti concordati/u);
  assert.match(deliveryGuidanceItalian.primary, /non può verificare digitalmente chi l'ha data/u);
  assert.match(deliveryGuidanceItalian.primary, /Prossimo passo: .*limiti approvati.*momento di revisione/u);
  assert.match(deliveryGuidanceItalian.technical, /Profile: AUT-PR-1/u);
  assert.match(deliveryGuidanceItalian.technical, /bounded-autonomous/u);
  assert.match(deliveryGuidanceItalian.technical, /audit_only/u);

  const intent = taskIntent("ST-PR-1");
  const mixedFetchRemoteStart = mustRunJson([
    "task", "start",
    "--root", project,
    "--intent-json", intent,
    "--delivery-profile", "AUT-PR-1",
  ]);
  assert.equal(mixedFetchRemoteStart.execution_allowed, false);
  assert.equal(mixedFetchRemoteStart.contract_action, "repair_delivery_autonomy");
  assert.ok(mixedFetchRemoteStart.blocking_reasons.includes("autonomy_profile_invalid"));
  assert.ok(mixedFetchRemoteStart.questions.some((question) => /no Git remote matching repository/u.test(question)));
  mustGit(project, ["remote", "remove", "origin"]);
  mustGit(project, ["remote", "add", "origin", expectedRemoteUrl]);
  mustGit(project, ["update-ref", "refs/remotes/origin/main", "main"]);

  const profileMissing = mustRunJson([
    "task", "start",
    "--root", project,
    "--intent-json", intent,
  ]);
  assert.equal(profileMissing.execution_allowed, false);
  assert.equal(profileMissing.contract_action, "select_delivery_autonomy");
  assert.equal(profileMissing.delivery_kind, "pull_request");
  assert.ok(profileMissing.blocking_reasons.includes("autonomy_selection_required"));
  const profileMissingHuman = mustRun([
    "task", "start",
    "--root", project,
    "--intent-json", intent,
  ]);
  const profileMissingGuidance = splitHumanGuidance(profileMissingHuman.stdout);
  assert.match(profileMissingGuidance.primary, /For this pull request, how independently should I work\?/u);
  assert.match(profileMissingGuidance.primary, /1\. Guided: I ask for confirmation before important steps/u);
  assert.match(profileMissingGuidance.primary, /2\. Autonomy with checks: I proceed independently, but stop before the sensitive actions we agree/u);
  assert.match(profileMissingGuidance.primary, /3\. Full autonomy within these limits: I complete this pull request without routine pauses/u);
  assert.match(profileMissingGuidance.primary, /This choice applies only to this pull request and will not be reused/u);
  assert.doesNotMatch(profileMissingGuidance.primary, /pull request or local release/u);
  assert.doesNotMatch(profileMissingGuidance.primary, /bounded-autonomous|checkpointed|audit_only|ceiling|profile|receipt/u);
  assert.match(profileMissingGuidance.technical, /this pull request still needs its own choice/u);
  assert.match(profileMissingGuidance.technical, /choice is never inferred from a previous delivery/u);
  const profileMissingItalian = mustRun([
    "task", "start",
    "--root", project,
    "--intent-json", intent,
    "--locale", "it",
  ]);
  const missingGuidanceItalian = splitHumanGuidance(profileMissingItalian.stdout, "it");
  assert.match(missingGuidanceItalian.firstLine, /^Risultato: Il lavoro non è ancora iniziato/u);
  assert.match(missingGuidanceItalian.primary, /Nessuna modifica verrà avviata finché non viene chiarito il punto in attesa/u);
  assert.match(missingGuidanceItalian.primary, /Rispondi alla scelta descritta sotto oppure indica cosa deve cambiare/u);
  assert.match(missingGuidanceItalian.primary, /Per questa PR, quanto vuoi che lavori in autonomia\?/u);
  assert.match(missingGuidanceItalian.primary, /1\. Guidato: ti chiedo conferma prima dei passaggi importanti/u);
  assert.match(missingGuidanceItalian.primary, /2\. Autonomia con controlli: procedo da solo, ma mi fermo prima delle azioni delicate concordate/u);
  assert.match(missingGuidanceItalian.primary, /3\. Autonomia completa entro questi limiti: completo questa PR senza pause ordinarie/u);
  assert.match(missingGuidanceItalian.primary, /Questa scelta vale solo per questa PR e non sarà riutilizzata/u);
  assert.doesNotMatch(missingGuidanceItalian.primary, /PR o rilascio locale/u);
  assert.doesNotMatch(missingGuidanceItalian.primary, /bounded-autonomous|checkpointed|audit_only|ceiling|profile|receipt/u);
  assert.match(missingGuidanceItalian.technical, /questa PR deve ancora avere una scelta propria/u);
  assert.match(missingGuidanceItalian.technical, /Per questa PR, quanto vuoi che lavori in autonomia/u);
  assert.match(missingGuidanceItalian.technical, /autonomy_selection_required/u);

  const automatic = mustRunJson([
    "task", "start",
    "--root", project,
    "--intent-json", intent,
    "--delivery-profile", "AUT-PR-1",
  ]);
  assert.equal(automatic.status, "ready_to_execute");
  assert.equal(automatic.execution_allowed, true);
  assert.equal(automatic.delivery_profile_id, "AUT-PR-1");
  assert.equal(automatic.autonomy.effective_level, "checkpointed");
  assert.equal(automatic.autonomy.task_start_automatic, true);
  assert.equal(automatic.autonomy_decision.effective_level, "checkpointed");
  assert.match(automatic.autonomy_decision_path, /autonomy\/decisions\/AUT-DEC-.*\.json$/u);
  assert.match(automatic.task_start_receipt, /task-start\.json$/u);
  const receipt = JSON.parse(fs.readFileSync(path.join(project, automatic.task_start_receipt), "utf8"));
  assert.equal(receipt.schema_version, "profile-task-start-receipt:v1");
  assert.equal(Object.hasOwn(receipt, "workflow_instance_ref"), false);
  assert.equal(receipt.delivery_profile_ref.id, "AUT-PR-1");
  assert.equal(receipt.autonomy_decision_ref.id, automatic.autonomy_decision.id);
  assert.equal(receipt.start_basis, "checkpointed-profile");
  mustFail([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-PR-1",
    "--action", "pull_request.update",
    "--pr-url", "https://github.com/aantenore/agentic-sdlc-codex-plugin/pull/1",
    "--expected-pr-state", "almost-ready",
  ], /expected-pr-state.*draft.*ready/iu);
  mustFail([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-PR-1",
    "--action", "pull_request.update",
    "--pr-url", "https://github.com/aantenore/agentic-sdlc-codex-plugin/pull/1",
    "--expected-pr-base", "production",
  ], /cannot retarget the pull request outside the approved base branch/u);
  const startTrace = fs.readFileSync(path.join(project, ".sdlc", "traces", "ST-PR-1.jsonl"), "utf8")
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line))
    .find((event) => event.id === automatic.confirmation_trace_id);
  assert.ok(startTrace);
  assert.ok(startTrace.evidence.includes(automatic.autonomy_decision_path));

  const concurrentStart = mustRunJson([
    "task", "start",
    "--root", project,
    "--intent-json", intent,
    "--delivery-profile", "AUT-PR-1",
  ]);
  assert.equal(concurrentStart.execution_allowed, false);
  assert.equal(concurrentStart.contract_action, "repair_delivery_autonomy");
  assert.ok(concurrentStart.blocking_reasons.includes("delivery.concurrent_run_limit_exceeded"));

  mustFail([
    "autonomy", "delivery", "propose",
    "--root", project,
    "--id", "AUT-PR-1",
    "--delivery", "PR-2",
    "--kind", "pull_request",
    "--story", "ST-PR-1",
    "--contract", "CONTRACT-PR-1",
    "--requirement", "REQ-AUTONOMY",
    "--level", "bounded-autonomous",
    "--repository", "aantenore/agentic-sdlc-codex-plugin",
    "--base", "main",
    "--head", "codex/pr-2",
    "--write-path", "src",
    "--force",
  ], /File already exists|cannot be reused/u);

  mustFail([
    "autonomy", "delivery", "propose",
    "--root", project,
    "--id", "AUT-PR-2",
    "--delivery", "PR-2",
    "--kind", "pull_request",
    "--story", "ST-PR-1",
    "--contract", "CONTRACT-PR-1",
    "--requirement", "REQ-AUTONOMY",
    "--level", "bounded-autonomous",
    "--repository", "aantenore/agentic-sdlc-codex-plugin",
    "--base", "main",
    "--head", "codex/pr-2",
    "--write-path", "src",
  ], /must name --delivery-profile AUT-PR-2/u);

  const storyPath = path.join(project, ".sdlc", "stories", "ST-PR-1", "story.json");
  const originalStory = fs.readFileSync(storyPath, "utf8");
  const driftedStory = JSON.parse(originalStory);
  driftedStory.acceptance_criteria.push("Unapproved material scope expansion");
  fs.writeFileSync(storyPath, `${JSON.stringify(driftedStory, null, 2)}\n`, "utf8");
  const staleDecision = mustRunJson([
    "task", "start",
    "--root", project,
    "--intent-json", intent,
    "--delivery-profile", "AUT-PR-1",
    "--confirm-start",
    "--actor-type", "human",
  ]);
  assert.equal(staleDecision.execution_allowed, false);
  assert.equal(staleDecision.contract_action, "repair_delivery_autonomy");
  assert.equal(
    staleDecision.deterministic_checks.find((check) => check.check === "per_delivery_autonomy").status,
    "failed",
  );
  assert.ok(staleDecision.blocking_reasons.some((reason) =>
    reason === "delivery.story_refs_stale" || reason.startsWith("material_drift.")));
  fs.writeFileSync(storyPath, originalStory, "utf8");

  const profilePath = path.join(project, ".sdlc", "autonomy", "deliveries", "AUT-PR-1.json");
  const originalProfile = fs.readFileSync(profilePath, "utf8");
  const tamperedProfile = JSON.parse(originalProfile);
  tamperedProfile.pull_request_target.allowed_actions.push("pull_request.merge");
  tamperedProfile.pull_request_target.allowed_actions.sort();
  tamperedProfile.profile_hash = computeDeliveryExecutionProfileHash(tamperedProfile);
  fs.writeFileSync(profilePath, `${JSON.stringify(tamperedProfile, null, 2)}\n`, "utf8");
  const invalidHumanStatus = run([
    "autonomy", "delivery", "status",
    "--root", project,
    "--id", "AUT-PR-1",
  ]);
  assert.notEqual(invalidHumanStatus.status, 0);
  const invalidGuidance = splitHumanGuidance(invalidHumanStatus.stdout);
  assert.match(invalidGuidance.firstLine, /^Outcome: This working choice needs repair and cannot be used now/u);
  assert.match(invalidGuidance.primary, /What remains protected:/u);
  assert.match(invalidGuidance.technical, /Profile: AUT-PR-1/u);
  assert.match(invalidGuidance.technical, /Effective technical level: supervised/u);
  assert.match(invalidGuidance.technical, /Technical reason codes: autonomy_profile_evaluation_failed/u);
  const tamperedDecision = mustRunJson([
    "task", "start",
    "--root", project,
    "--intent-json", intent,
    "--delivery-profile", "AUT-PR-1",
    "--confirm-start",
    "--actor-type", "human",
  ]);
  assert.equal(tamperedDecision.execution_allowed, false);
  assert.equal(tamperedDecision.contract_action, "repair_delivery_autonomy");
  assert.ok(tamperedDecision.blocking_reasons.includes("autonomy_profile_invalid"));
  fs.writeFileSync(profilePath, originalProfile, "utf8");

  const sourcePath = path.join(project, "src", "change.txt");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, "exact authorized change\n", "utf8");
  mustFail([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-PR-1",
    "--action", "git.commit",
  ], /requires at least one exact --scope-path/u);

  mustGit(project, ["add", "--", "src/change.txt"]);
  const commitAuthorization = mustRunJson([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-PR-1",
    "--action", "git.commit",
    "--scope-path", "src/change.txt",
  ]);
  assert.equal(commitAuthorization.status, "authorized");
  assert.equal(commitAuthorization.execution_allowed, true);
  assert.equal(commitAuthorization.action, "git.commit");
  assert.equal(commitAuthorization.checkpoint_required, false);
  assert.deepEqual(commitAuthorization.action_receipt.action_details.changed_paths, ["src/change.txt"]);
  const checkpointPolicy = commitAuthorization.action_receipt.action_details.checkpoint_policy;
  assert.equal(checkpointPolicy.schema_version, "delivery-action-checkpoint-policy:v1");
  assert.equal(checkpointPolicy.action, "git.commit");
  assert.equal(checkpointPolicy.effective_level, "checkpointed");
  assert.deepEqual(checkpointPolicy.profile_ref, {
    id: "AUT-PR-1",
    hash: commitAuthorization.action_receipt.profile_ref.hash,
  });
  assert.deepEqual(checkpointPolicy.profile_checkpoints, activated.delivery_profile.checkpoints);
  assert.match(checkpointPolicy.policy_source_ref.hash, /^[a-f0-9]{64}$/u);
  assert.match(checkpointPolicy.policy_source_ref.effective_config_hash, /^[a-f0-9]{64}$/u);
  const checkpointPolicySourcePath = path.join(project, checkpointPolicy.policy_source_ref.path);
  const checkpointPolicySource = JSON.parse(fs.readFileSync(checkpointPolicySourcePath, "utf8"));
  assert.equal(checkpointPolicySource.source_hash, checkpointPolicy.policy_source_ref.hash);
  assert.equal(
    crypto.createHash("sha256").update(stableJson(checkpointPolicySource.effective_config)).digest("hex"),
    checkpointPolicy.policy_source_ref.effective_config_hash,
  );
  assert.deepEqual(
    [...checkpointPolicySource.effective_config.autonomy_policy.presets.checkpointed.checkpoints].sort(),
    checkpointPolicy.preset_checkpoints,
  );
  assert.equal(checkpointPolicy.required, false);
  assert.equal(
    commitAuthorization.action_receipt.action_details.commit_snapshot.index_tree_oid,
    mustGit(project, ["write-tree"]),
  );
  assert.equal(
    commitAuthorization.action_receipt.action_details.commit_snapshot.object_format,
    mustGit(project, ["rev-parse", "--show-object-format"]),
  );
  assert.deepEqual(
    commitAuthorization.action_receipt.action_details.commit_snapshot.staged_paths,
    ["src/change.txt"],
  );
  const { policy_hash: checkpointPolicyHash, ...checkpointPolicySubject } = checkpointPolicy;
  assert.equal(
    checkpointPolicyHash,
    crypto.createHash("sha256").update(stableJson(checkpointPolicySubject)).digest("hex"),
  );
  const beforeCommit = mustGit(project, ["rev-parse", "HEAD"]);
  assert.equal(commitAuthorization.action_receipt.runtime_target.head_sha, beforeCommit);

  mustGit(project, ["commit", "-m", "test: exact authorized delivery change"]);
  const afterCommit = mustGit(project, ["rev-parse", "HEAD"]);
  assert.notEqual(afterCommit, beforeCommit);

  const configPreview = mustRunJson([
    "config", "migrate",
    "--root", project,
  ]);
  assert.equal(configPreview.status, "planned");
  assert.equal(configPreview.plan.effective_config_hash, checkpointPolicy.policy_source_ref.effective_config_hash);
  const configApplied = mustRunJson([
    "config", "migrate",
    "--root", project,
    "--apply",
    "--plan-hash", configPreview.plan.plan_hash,
    "--actor-type", "human",
  ]);
  assert.equal(configApplied.status, "applied");
  assert.equal(fs.existsSync(checkpointPolicySourcePath), true);

  const migratedConfigPath = path.join(project, ".sdlc", "config.json");
  const changedConfig = JSON.parse(fs.readFileSync(migratedConfigPath, "utf8"));
  changedConfig.autonomy_policy.presets.checkpointed.checkpoints = [
    ...new Set([
      ...changedConfig.autonomy_policy.presets.checkpointed.checkpoints,
      "git.commit",
      "git.push",
    ]),
  ].sort();
  fs.writeFileSync(migratedConfigPath, `${JSON.stringify(changedConfig, null, 2)}\n`, "utf8");
  const changedConfigPreview = mustRunJson([
    "config", "migrate",
    "--root", project,
  ]);
  assert.equal(changedConfigPreview.status, "planned");
  assert.notEqual(changedConfigPreview.plan.effective_config_hash, checkpointPolicy.policy_source_ref.effective_config_hash);
  const changedConfigApplied = mustRunJson([
    "config", "migrate",
    "--root", project,
    "--apply",
    "--plan-hash", changedConfigPreview.plan.plan_hash,
    "--actor-type", "human",
  ]);
  assert.equal(changedConfigApplied.status, "applied");
  assert.equal(changedConfigApplied.config_hash, changedConfigPreview.plan.effective_config_hash);

  const commitCompletion = mustRunJson([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-PR-1",
    "--action", "git.commit",
    "--outcome", "passed",
    "--evidence", "src/change.txt",
  ]);
  assert.equal(commitCompletion.status, "completed");
  assert.equal(commitCompletion.lifecycle_status, "started");
  assert.equal(commitCompletion.checkpoint_required, false);
  assert.equal(commitCompletion.action_receipt.checkpoint_required, checkpointPolicy.required);
  assert.equal(commitCompletion.action_receipt.authorization_receipt_ref.id, commitAuthorization.action_receipt.id);
  assert.deepEqual(commitCompletion.action_receipt.action_details.commit, {
    before_sha: beforeCommit,
    after_sha: afterCommit,
    committed_paths: ["src/change.txt"],
  });
  assert.deepEqual(commitCompletion.action_receipt.evidence.map((item) => item.path), ["src/change.txt"]);
  assert.ok(
    commitCompletion.audit_warnings.some((warning) =>
      /remains valid for this exact action; updated approval rules apply to later actions/iu.test(warning)),
  );

  const statusAfterPolicyChange = mustRunJson([
    "autonomy", "delivery", "status",
    "--root", project,
    "--id", "AUT-PR-1",
  ]);
  assert.equal(statusAfterPolicyChange.delivery_profiles[0].effective_status, "active");
  assert.equal(statusAfterPolicyChange.delivery_profiles[0].lifecycle_status, "started");

  const validationAfterPolicyChange = run([
    "gate", "check",
    "--root", project,
    "--scope", "story",
    "--story", "ST-PR-1",
    "--strict",
    "--json",
  ]);
  assert.equal(validationAfterPolicyChange.error, undefined, validationAfterPolicyChange.error?.message);
  assert.equal(validationAfterPolicyChange.signal, null, `gate check terminated by ${validationAfterPolicyChange.signal}`);
  assert.ok([0, 1].includes(validationAfterPolicyChange.status), validationAfterPolicyChange.stderr || validationAfterPolicyChange.stdout);
  const validationAfterPolicyChangeReport = JSON.parse(validationAfterPolicyChange.stdout);
  assert.deepEqual(
    validationAfterPolicyChangeReport.errors.filter((error) =>
      /checkpoint policy snapshot .*stale|checkpoint flag does not match its exact action policy/iu.test(error)),
    [],
    validationAfterPolicyChange.stdout,
  );
  assert.ok(
    validationAfterPolicyChangeReport.warnings.some((warning) =>
      /remains valid for this exact action; updated approval rules apply to later actions/iu.test(warning)),
    validationAfterPolicyChange.stdout,
  );

  fs.writeFileSync(sourcePath, "a later working-tree revision\n", "utf8");
  const validationAfterEvidenceChange = run([
    "gate", "check",
    "--root", project,
    "--scope", "story",
    "--story", "ST-PR-1",
    "--strict",
    "--json",
  ]);
  assert.ok([0, 1].includes(validationAfterEvidenceChange.status), validationAfterEvidenceChange.stderr);
  const validationAfterEvidenceChangeReport = JSON.parse(validationAfterEvidenceChange.stdout);
  assert.equal(
    validationAfterEvidenceChangeReport.errors.some((error) =>
      error.includes(`${commitCompletion.action_receipt.id} evidence changed after recording`)),
    false,
    validationAfterEvidenceChange.stdout,
  );
  assert.ok(
    validationAfterEvidenceChangeReport.warnings.some((warning) =>
      warning.includes(commitCompletion.action_receipt.id)
      && warning.includes("verified from its exact Git revision")),
    validationAfterEvidenceChange.stdout,
  );
  fs.writeFileSync(sourcePath, "exact authorized change\n", "utf8");

  const repeatedCommitCompletion = mustRunJson([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-PR-1",
    "--action", "git.commit",
    "--outcome", "passed",
    "--evidence", "src/change.txt",
  ]);
  assert.equal(repeatedCommitCompletion.idempotent, true);
  assert.equal(
    repeatedCommitCompletion.action_receipt.id,
    commitCompletion.action_receipt.id,
  );
  assert.equal(
    repeatedCommitCompletion.action_receipt.authorization_receipt_ref.id,
    commitAuthorization.action_receipt.id,
  );

  const pushBeforeEnv = fakeGitRemoteEnv(project, beforeCommit);
  const pushAuthorization = mustRunJson([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-PR-1",
    "--action", "git.push",
    "--remote", "origin",
    "--confirm-action",
    ...humanApproval("Approve this exact push under the current checkpoint policy"),
  ], { env: pushBeforeEnv });
  assert.equal(pushAuthorization.status, "authorized");
  assert.equal(pushAuthorization.checkpoint_required, true);
  assert.equal(pushAuthorization.action_receipt.action_details.checkpoint_policy.required, true);
  assert.equal(pushAuthorization.action_receipt.action_details.push.source_sha, afterCommit);
  assert.equal(pushAuthorization.action_receipt.action_details.base_precondition.observed_sha, beforeCommit);
  assert.equal(pushAuthorization.action_receipt.action_details.base_precondition.base_ref, "refs/heads/main");
  assert.equal(pushAuthorization.action_receipt.action_details.push_precondition.observed_sha, beforeCommit);
  assert.equal(
    pushAuthorization.action_receipt.action_details.provider_operation.precondition_receipt.provider.id,
    "git-remote",
  );
  assert.equal(
    pushAuthorization.action_receipt.action_details.provider_operation.precondition_receipt.operation.phase,
    "precondition",
  );
  assert.equal(pushAuthorization.action_receipt.action_details.commit_coverage.schema_version, "git-commit-coverage:v1");
  assert.equal(pushAuthorization.action_receipt.action_details.commit_coverage.base_sha, beforeCommit);
  assert.equal(pushAuthorization.action_receipt.action_details.commit_coverage.head_sha, afterCommit);
  assert.deepEqual(
    pushAuthorization.action_receipt.action_details.commit_coverage.entries.map((entry) => ({
      commit_sha: entry.commit_sha,
      profile_id: entry.profile_ref.id,
      authorization_id: entry.authorization_receipt_ref.id,
      completion_id: entry.completion_receipt_ref.id,
    })),
    [{
      commit_sha: afterCommit,
      profile_id: "AUT-PR-1",
      authorization_id: commitAuthorization.action_receipt.id,
      completion_id: commitCompletion.action_receipt.id,
    }],
  );
  const lockedPolicySourceRef = pushAuthorization.action_receipt.action_details.checkpoint_policy.policy_source_ref;
  assert.equal(
    lockedPolicySourceRef.effective_config_hash,
    changedConfigApplied.config_hash,
  );
  assert.notEqual(lockedPolicySourceRef.effective_config_hash, checkpointPolicy.policy_source_ref.effective_config_hash);
  assert.notEqual(lockedPolicySourceRef.hash, checkpointPolicy.policy_source_ref.hash);
  assert.notEqual(lockedPolicySourceRef.path, checkpointPolicy.policy_source_ref.path);
  assert.equal(fs.existsSync(path.join(project, lockedPolicySourceRef.path)), true);

  mustFail([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-PR-1",
    "--action", "git.push",
    "--outcome", "passed",
    "--evidence", "src/change.txt",
  ], /does not resolve to/u, { env: pushBeforeEnv });

  const pushCompletionResult = mustRun([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-PR-1",
    "--action", "git.push",
    "--outcome", "passed",
    "--evidence", "src/change.txt",
  ], { env: fakeGitRemoteEnv(project, afterCommit) });
  const pushCompletionGuidance = splitHumanGuidance(pushCompletionResult.stdout);
  assert.match(pushCompletionGuidance.firstLine, /^Outcome: The protected operation was completed and recorded successfully/u);
  assert.match(pushCompletionGuidance.primary, /What remains protected: Only this exact operation was recorded/u);
  assert.match(pushCompletionGuidance.technical, /Profile: AUT-PR-1/u);
  assert.match(pushCompletionGuidance.technical, /Canonical action: git\.push/u);
  const pushCompletionReceipt = fs.readdirSync(path.join(project, ".sdlc", "autonomy", "actions"))
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(fs.readFileSync(path.join(project, ".sdlc", "autonomy", "actions", name), "utf8")))
    .find((receipt) =>
      receipt.status === "completed"
      && receipt.action === "git.push"
      && receipt.authorization_receipt_ref?.id === pushAuthorization.action_receipt.id);
  assert.ok(pushCompletionReceipt);
  const pushCompletion = { status: "completed", action_receipt: pushCompletionReceipt };
  assert.equal(pushCompletion.status, "completed");
  assert.equal(pushCompletion.action_receipt.action_details.remote_verification.observed_sha, afterCommit);
  assert.equal(pushCompletion.action_receipt.action_details.remote_verification.destination_ref, "refs/heads/codex/pr-1");
  assert.equal(
    pushCompletion.action_receipt.action_details.provider_operation.completion_receipt.operation.phase,
    "completion",
  );
  assert.equal(
    pushCompletion.action_receipt.action_details.provider_operation.completion_receipt.precondition_receipt_ref.hash,
    pushAuthorization.action_receipt.action_details.provider_operation.precondition_receipt.receipt_hash,
  );
  assert.equal(
    Object.hasOwn(
      pushCompletion.action_receipt.action_details.provider_operation.precondition_receipt.subject,
      "cwd",
    ),
    false,
  );

  const relocatedParent = tmpProject("relocated-provider-receipts");
  const relocatedProject = path.join(relocatedParent, "copy");
  fs.cpSync(project, relocatedProject, { recursive: true });
  const relocatedGate = run([
    "gate", "check",
    "--root", relocatedProject,
    "--scope", "story",
    "--story", "ST-PR-1",
    "--strict",
    "--json",
  ]);
  assert.equal(relocatedGate.error, undefined, relocatedGate.error?.message);
  assert.equal(relocatedGate.signal, null, `relocated gate check terminated by ${relocatedGate.signal}`);
  assert.ok([0, 1].includes(relocatedGate.status), relocatedGate.stderr || relocatedGate.stdout);
  const relocatedGateReport = JSON.parse(relocatedGate.stdout);
  assert.deepEqual(
    relocatedGateReport.errors.filter((error) =>
      /provider proof subject differs from the authorized operation/iu.test(error)),
    [],
    relocatedGate.stdout,
  );

  const closeResult = mustRun([
    "autonomy", "delivery", "close",
    "--root", project,
    "--id", "AUT-PR-1",
    "--terminal-status", "cancelled",
    "--reason", "The test delivery is complete without publishing the temporary PR.",
    ...humanApproval("Approve cancellation of this exact test delivery"),
  ]);
  const closeGuidance = splitHumanGuidance(closeResult.stdout);
  assert.match(closeGuidance.firstLine, /^Outcome: This delivery was closed as requested/u);
  assert.match(closeGuidance.primary, /What remains protected: The closure did not merge, release, deploy, access production/u);
  assert.match(closeGuidance.technical, /Profile: AUT-PR-1/u);
  assert.match(closeGuidance.technical, /Terminal status: cancelled/u);
  const closeReceiptRelativePath = ".sdlc/autonomy/executions/AUT-PR-1/close.json";
  const closeReceipt = JSON.parse(fs.readFileSync(
    path.join(project, closeReceiptRelativePath),
    "utf8",
  ));
  const closed = {
    status: "terminal",
    terminal_status: closeReceipt.terminal_status,
    close_receipt: closeReceipt,
    close_receipt_path: closeReceiptRelativePath,
  };
  assert.equal(closed.status, "terminal");
  assert.equal(closed.terminal_status, "cancelled");
  assert.equal(closed.close_receipt.terminal_action_receipt_ref, null);
  assert.equal(closed.close_receipt.approval.status, "approved");

  const terminalStatus = mustRunJson([
    "autonomy", "delivery", "status",
    "--root", project,
    "--id", "AUT-PR-1",
  ]);
  assert.equal(terminalStatus.delivery_profiles.length, 1);
  assert.equal(terminalStatus.delivery_profiles[0].lifecycle_status, "terminal");
  assert.equal(terminalStatus.delivery_profiles[0].delivery_status, "cancelled");
  const terminalDecisionIds = fs.readdirSync(path.join(project, ".sdlc", "autonomy", "decisions"))
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(fs.readFileSync(path.join(project, ".sdlc", "autonomy", "decisions", name), "utf8")))
    .filter((decision) => decision.delivery?.profile_id === "AUT-PR-1")
    .map((decision) => decision.id);
  assert.ok(terminalDecisionIds.length > 0);

  const terminalReuse = mustRunJson([
    "task", "start",
    "--root", project,
    "--intent-json", intent,
    "--delivery-profile", "AUT-PR-1",
  ]);
  assert.equal(terminalReuse.execution_allowed, false);
  assert.equal(terminalReuse.contract_action, "repair_delivery_autonomy");
  assert.ok(terminalReuse.blocking_reasons.includes("delivery.profile_terminal"));

  const successorContract = mustRunJson([
    "contract", "create",
    "--root", project,
    "--phase", "implementation",
    "--story", "ST-PR-1",
    "--id", "CONTRACT-PR-2",
    "--delivery-profile", "AUT-PR-2",
    "--level", "bounded-autonomous",
    "--context-summary", "Continue ST-PR-1 under a new exact delivery boundary without rewriting the completed PR-1 history.",
    "--qa", "May the successor reuse AUT-PR-1?|No, it must use AUT-PR-2",
    "--output-ref", "implementation-summary:implementation-summary-v1:new",
    "--tool", "node",
    "--replace-story-contract",
  ]).contract;
  assert.equal(successorContract.id, "CONTRACT-PR-2");
  assert.equal(successorContract.delivery_execution_profile_id, "AUT-PR-2");
  assert.equal(successorContract.status, "draft");

  const approvedSuccessorContract = mustRunJson([
    "contract", "approve",
    "--root", project,
    "--id", "CONTRACT-PR-2",
    ...humanApproval("Approve the successor contract without invalidating terminal PR-1 evidence"),
  ]).contract;
  assert.equal(approvedSuccessorContract.status, "approved");

  const proposedSuccessorProfile = mustRunJson([
    "autonomy", "delivery", "propose",
    "--root", project,
    "--id", "AUT-PR-2",
    "--delivery", "PR-2",
    "--kind", "pull_request",
    "--story", "ST-PR-1",
    "--contract", "CONTRACT-PR-2",
    "--requirement", "REQ-AUTONOMY",
    "--level", "bounded-autonomous",
    "--repository", "aantenore/agentic-sdlc-codex-plugin",
    "--base", "main",
    "--head", "codex/pr-1",
    "--write-path", "src",
    "--allow-action", "git.push",
  ]).delivery_profile;
  assert.equal(proposedSuccessorProfile.status, "proposed");
  assert.equal(proposedSuccessorProfile.delivery_id, "PR-2");

  const approvedSuccessorProfile = mustRunJson([
    "autonomy", "delivery", "approve",
    "--root", project,
    "--id", "AUT-PR-2",
    ...humanApproval("Approve bounded autonomy for the successor PR-2 only"),
  ]).delivery_profile;
  assert.equal(approvedSuccessorProfile.status, "active");

  const successorStart = mustRunJson([
    "task", "start",
    "--root", project,
    "--intent-json", intent,
    "--delivery-profile", "AUT-PR-2",
  ]);
  assert.equal(successorStart.execution_allowed, true);
  assert.equal(successorStart.delivery_profile_id, "AUT-PR-2");
  const successorTaskStart = JSON.parse(fs.readFileSync(
    path.join(project, successorStart.task_start_receipt),
    "utf8",
  ));
  assert.equal(successorTaskStart.previous_task_start_receipt_ref.id, receipt.id);
  const archivedTaskStartPath = path.join(
    project,
    successorTaskStart.previous_task_start_receipt_ref.path,
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(archivedTaskStartPath, "utf8")), receipt);
  assert.equal(
    crypto.createHash("sha256").update(fs.readFileSync(archivedTaskStartPath)).digest("hex"),
    successorTaskStart.previous_task_start_receipt_ref.hash,
  );
  const successorStartTrace = fs.readFileSync(
    path.join(project, ".sdlc", "traces", "ST-PR-1.jsonl"),
    "utf8",
  )
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line))
    .find((event) => event.id === successorStart.confirmation_trace_id);
  assert.ok(
    successorStartTrace.evidence.includes(
      successorTaskStart.previous_task_start_receipt_ref.path,
    ),
  );
  const multiDeliveryGuidance = splitHumanGuidance(mustRun([
    "autonomy", "delivery", "status",
    "--root", project,
  ]).stdout);
  assert.match(multiDeliveryGuidance.firstLine, /^Outcome: I found 2 separate working choices for concrete deliveries/u);
  assert.match(multiDeliveryGuidance.primary, /No choice applies to another delivery/u);
  assert.match(multiDeliveryGuidance.technical, /Profile: AUT-PR-1/u);
  assert.match(multiDeliveryGuidance.technical, /Profile: AUT-PR-2/u);

  const successorPushAuthorization = mustRunJson([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-PR-2",
    "--action", "git.push",
    "--remote", "origin",
    "--confirm-action",
    ...humanApproval("Approve the successor push under the current checkpoint policy"),
  ], { env: pushBeforeEnv });
  assert.equal(successorPushAuthorization.status, "authorized");
  assert.deepEqual(
    successorPushAuthorization.action_receipt.action_details.commit_coverage.entries.map((entry) => ({
      commit_sha: entry.commit_sha,
      profile_id: entry.profile_ref.id,
    })),
    [{ commit_sha: afterCommit, profile_id: "AUT-PR-1" }],
  );

  const successorGate = run([
    "gate", "check",
    "--root", project,
    "--scope", "story",
    "--story", "ST-PR-1",
    "--strict",
    "--json",
  ]);
  assert.equal(successorGate.error, undefined, successorGate.error?.message);
  assert.equal(successorGate.signal, null, `gate check terminated by ${successorGate.signal}`);
  assert.ok([0, 1].includes(successorGate.status), successorGate.stderr || successorGate.stdout);
  const successorGateReport = JSON.parse(successorGate.stdout);
  const historicalFalsePositives = successorGateReport.errors.filter((error) =>
    /AUT-PR-1 immutable start|AUT-PR-1 action receipt|protected action git\.commit requires/u.test(error)
      || (terminalDecisionIds.some((id) => error.includes(`autonomy decision ${id}`))
        && /does not match a fresh deterministic evaluation|cannot be reproduced/u.test(error)));
  assert.deepEqual(
    historicalFalsePositives,
    [],
    `A successor contract/profile must not invalidate terminal AUT-PR-1 evidence:\n${historicalFalsePositives.join("\n")}`,
  );
  assert.deepEqual(
    successorGateReport.errors.filter((error) =>
      /AUT-PR-2 git\.push authorization .*incomplete commit mediation|git-commit coverage proof/iu.test(error)),
    [],
    successorGate.stdout,
  );
  const archivedTaskStartBytes = fs.readFileSync(archivedTaskStartPath);
  fs.writeFileSync(
    archivedTaskStartPath,
    `${archivedTaskStartBytes.toString("utf8").trimEnd()}\n `,
  );
  const tamperedHistoryGate = run([
    "gate", "check",
    "--root", project,
    "--scope", "story",
    "--story", "ST-PR-1",
    "--strict",
    "--json",
  ]);
  assert.equal(tamperedHistoryGate.error, undefined, tamperedHistoryGate.error?.message);
  assert.equal(tamperedHistoryGate.signal, null, `gate check terminated by ${tamperedHistoryGate.signal}`);
  assert.equal(tamperedHistoryGate.status, 1, tamperedHistoryGate.stdout);
  assert.ok(
    JSON.parse(tamperedHistoryGate.stdout).errors.some((error) =>
      /task-start receipt history .* does not match its recorded hash/u.test(error)),
    tamperedHistoryGate.stdout,
  );
  fs.writeFileSync(archivedTaskStartPath, archivedTaskStartBytes);

  const successorPushReceiptPath = path.join(project, successorPushAuthorization.action_receipt_path);
  const originalSuccessorPushReceipt = fs.readFileSync(successorPushReceiptPath, "utf8");
  const pushWithoutCoverage = JSON.parse(originalSuccessorPushReceipt);
  delete pushWithoutCoverage.action_details.commit_coverage;
  pushWithoutCoverage.receipt_hash = lifecycleReceiptHash(pushWithoutCoverage);
  fs.writeFileSync(successorPushReceiptPath, `${JSON.stringify(pushWithoutCoverage, null, 2)}\n`, "utf8");
  mustFail([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-PR-2",
    "--action", "git.push",
    "--outcome", "passed",
    "--evidence", "src/change.txt",
  ], /missing its required git-commit coverage proof/u, { env: fakeGitRemoteEnv(project, afterCommit) });
  const missingCoverageGate = run([
    "gate", "check",
    "--root", project,
    "--scope", "story",
    "--story", "ST-PR-1",
    "--strict",
    "--json",
  ]);
  assert.equal(missingCoverageGate.error, undefined, missingCoverageGate.error?.message);
  assert.equal(missingCoverageGate.signal, null, `gate check terminated by ${missingCoverageGate.signal}`);
  assert.equal(missingCoverageGate.status, 1, missingCoverageGate.stdout);
  assert.ok(
    JSON.parse(missingCoverageGate.stdout).errors.some((error) =>
      /missing its required immutable git-commit coverage proof/u.test(error)),
    missingCoverageGate.stdout,
  );
  fs.writeFileSync(successorPushReceiptPath, originalSuccessorPushReceipt, "utf8");

  const pushWithForgedStart = JSON.parse(originalSuccessorPushReceipt);
  pushWithForgedStart.action_details.commit_coverage.entries[0].start_receipt_ref.hash = "0".repeat(64);
  pushWithForgedStart.action_details.commit_coverage.coverage_hash = commitCoverageHash(
    pushWithForgedStart.action_details.commit_coverage,
  );
  pushWithForgedStart.receipt_hash = lifecycleReceiptHash(pushWithForgedStart);
  fs.writeFileSync(successorPushReceiptPath, `${JSON.stringify(pushWithForgedStart, null, 2)}\n`, "utf8");
  const forgedStartGate = run([
    "gate", "check",
    "--root", project,
    "--scope", "story",
    "--story", "ST-PR-1",
    "--strict",
    "--json",
  ]);
  assert.equal(forgedStartGate.error, undefined, forgedStartGate.error?.message);
  assert.equal(forgedStartGate.signal, null, `gate check terminated by ${forgedStartGate.signal}`);
  assert.equal(forgedStartGate.status, 1, forgedStartGate.stdout);
  assert.ok(
    JSON.parse(forgedStartGate.stdout).errors.some((error) =>
      /coverage start receipt is missing or stale/u.test(error)),
    forgedStartGate.stdout,
  );
  fs.writeFileSync(successorPushReceiptPath, originalSuccessorPushReceipt, "utf8");

  const originalCheckpointPolicySource = fs.readFileSync(checkpointPolicySourcePath, "utf8");
  const forgedCheckpointPolicySource = JSON.parse(originalCheckpointPolicySource);
  forgedCheckpointPolicySource.effective_config.autonomy_policy.presets.checkpointed.checkpoints = [
    ...forgedCheckpointPolicySource.effective_config.autonomy_policy.presets.checkpointed.checkpoints,
    "repository.write",
  ].sort();
  forgedCheckpointPolicySource.config.effective_hash = crypto.createHash("sha256")
    .update(stableJson(forgedCheckpointPolicySource.effective_config))
    .digest("hex");
  forgedCheckpointPolicySource.source_hash = checkpointPolicySourceHash(forgedCheckpointPolicySource);
  fs.writeFileSync(
    checkpointPolicySourcePath,
    `${JSON.stringify(forgedCheckpointPolicySource, null, 2)}\n`,
    "utf8",
  );
  const forgedPolicySourceGate = run([
    "gate", "check",
    "--root", project,
    "--scope", "story",
    "--story", "ST-PR-1",
    "--strict",
    "--json",
  ]);
  assert.equal(forgedPolicySourceGate.status, 1, forgedPolicySourceGate.stderr || forgedPolicySourceGate.stdout);
  assert.match(
    `${forgedPolicySourceGate.stdout}\n${forgedPolicySourceGate.stderr}`,
    /checkpoint policy snapshot source is invalid: checkpoint policy source reference is stale/u,
  );
  fs.writeFileSync(checkpointPolicySourcePath, originalCheckpointPolicySource, "utf8");

  const closePath = path.join(project, closed.close_receipt_path);
  const forgedClose = JSON.parse(fs.readFileSync(closePath, "utf8"));
  forgedClose.approval.status = "rejected";
  forgedClose.receipt_hash = lifecycleReceiptHash(forgedClose);
  fs.writeFileSync(closePath, `${JSON.stringify(forgedClose, null, 2)}\n`, "utf8");
  const forgedGate = run([
    "gate", "check",
    "--root", project,
    "--scope", "story",
    "--story", "ST-PR-1",
    "--strict",
    "--json",
  ]);
  assert.equal(forgedGate.status, 1, forgedGate.stderr || forgedGate.stdout);
  const forgedGateError = JSON.parse(forgedGate.stderr || forgedGate.stdout);
  assert.match(
    forgedGateError.error.message,
    /Delivery lifecycle receipt .*close\.json validation failed: .*approval\.status: must equal "approved"/u,
  );
});

test("an in-flight v1 push authorization completes through its legacy verifier", () => {
  const project = tmpProject("legacy-v1-push-completion");
  initializeAutonomyProject(project);
  createApprovedImplementationContract(project, {
    storyId: "ST-LEGACY-PUSH",
    contractId: "CONTRACT-LEGACY-PUSH",
    profileId: "AUT-LEGACY-PUSH",
  });
  const proposed = mustRunJson([
    "autonomy", "delivery", "propose",
    "--root", project,
    "--id", "AUT-LEGACY-PUSH",
    "--delivery", "PR-LEGACY-PUSH",
    "--kind", "pull_request",
    "--story", "ST-LEGACY-PUSH",
    "--contract", "CONTRACT-LEGACY-PUSH",
    "--requirement", "REQ-AUTONOMY",
    "--level", "bounded-autonomous",
    "--repository", "aantenore/agentic-sdlc-codex-plugin",
    "--base", "main",
    "--head", "codex/pr-1",
    "--write-path", "src",
  ]).delivery_profile;
  const profilePath = path.join(
    project,
    ".sdlc",
    "autonomy",
    "deliveries",
    "AUT-LEGACY-PUSH.json",
  );
  const legacyPullRequestTarget = {
    repository: proposed.pull_request_target.repository,
    base_branch: proposed.pull_request_target.base_branch,
    head_branch: proposed.pull_request_target.head_branch,
    allowed_actions: proposed.pull_request_target.allowed_actions,
    merge_allowed: proposed.pull_request_target.merge_allowed,
  };
  const legacyProposed = buildDeliveryExecutionProfile({
    ...proposed,
    pull_request_target: legacyPullRequestTarget,
    material_scope: {
      ...proposed.material_scope,
      release_target: legacyPullRequestTarget,
    },
  });
  assert.equal(legacyProposed.schema_version, "delivery-execution-profile:v1");
  fs.writeFileSync(profilePath, `${JSON.stringify(legacyProposed, null, 2)}\n`, "utf8");

  const activated = mustRunJson([
    "autonomy", "delivery", "approve",
    "--root", project,
    "--id", "AUT-LEGACY-PUSH",
    "--phase", "implementation",
    ...humanApproval("Approve the historical v1 delivery fixture"),
  ]).delivery_profile;
  assert.equal(activated.schema_version, "delivery-execution-profile:v1");
  const started = mustRunJson([
    "task", "start",
    "--root", project,
    "--intent-json", taskIntent("ST-LEGACY-PUSH"),
    "--delivery-profile", "AUT-LEGACY-PUSH",
  ]);
  assert.equal(started.execution_allowed, true);

  const sourcePath = path.join(project, "src", "legacy-change.txt");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, "legacy in-flight push\n", "utf8");
  mustGit(project, ["add", "--", "src/legacy-change.txt"]);
  mustRunJson([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-LEGACY-PUSH",
    "--action", "git.commit",
    "--scope-path", "src/legacy-change.txt",
  ]);
  const beforeCommit = mustGit(project, ["rev-parse", "HEAD"]);
  mustGit(project, ["commit", "-m", "test: legacy v1 in-flight push"]);
  const afterCommit = mustGit(project, ["rev-parse", "HEAD"]);
  mustRunJson([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-LEGACY-PUSH",
    "--action", "git.commit",
    "--outcome", "passed",
    "--evidence", "src/legacy-change.txt",
  ]);

  const authorization = mustRunJson([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-LEGACY-PUSH",
    "--action", "git.push",
    "--remote", "origin",
    "--confirm-action",
    ...humanApproval("Approve the historical v1 push checkpoint"),
  ], { env: fakeGitRemoteEnv(project, beforeCommit) });
  assert.equal(authorization.action_receipt.profile_ref.hash, activated.profile_hash);
  assert.equal(
    authorization.action_receipt.action_details.provider_operation.binding.source,
    "legacy-v1",
  );

  const legacyAuthorization = structuredClone(authorization.action_receipt);
  delete legacyAuthorization.action_details.provider_operation;
  const approvalSubject = {
    profile_id: legacyAuthorization.profile_ref.id,
    profile_hash: legacyAuthorization.profile_ref.hash,
    delivery_id: legacyAuthorization.delivery.id,
    action: legacyAuthorization.action,
    runtime_target: legacyAuthorization.runtime_target,
    action_details: legacyAuthorization.action_details,
  };
  if (legacyAuthorization.approval) {
    legacyAuthorization.approval.approved_content_hash = crypto.createHash("sha256")
      .update(stableJson(approvalSubject))
      .digest("hex");
  }
  legacyAuthorization.receipt_hash = lifecycleReceiptHash(legacyAuthorization);
  fs.writeFileSync(
    path.join(project, authorization.action_receipt_path),
    `${JSON.stringify(legacyAuthorization, null, 2)}\n`,
    "utf8",
  );

  const completion = mustRunJson([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-LEGACY-PUSH",
    "--action", "git.push",
    "--outcome", "passed",
    "--evidence", "src/legacy-change.txt",
  ], { env: fakeGitRemoteEnv(project, afterCommit) });
  assert.equal(completion.status, "completed");
  assert.equal(completion.action_receipt.authorization_receipt_ref.hash, legacyAuthorization.receipt_hash);
  assert.equal(completion.action_receipt.action_details.provider_operation, undefined);
  assert.equal(completion.action_receipt.action_details.remote_verification.provider, "git-remote");
  assert.equal(completion.action_receipt.action_details.remote_verification.observed_sha, afterCommit);
});

test("git.push rejects commits created outside the exact delivery action chain", () => {
  const contentProject = tmpProject("commit-content-substitution");
  initializeAutonomyProject(contentProject);
  createApprovedImplementationContract(contentProject, {
    storyId: "ST-CONTENT-SUBSTITUTION",
    contractId: "CONTRACT-CONTENT-SUBSTITUTION",
    profileId: "AUT-CONTENT-SUBSTITUTION",
  });
  mustRunJson([
    "autonomy", "delivery", "propose",
    "--root", contentProject,
    "--id", "AUT-CONTENT-SUBSTITUTION",
    "--delivery", "PR-CONTENT-SUBSTITUTION",
    "--kind", "pull_request",
    "--story", "ST-CONTENT-SUBSTITUTION",
    "--contract", "CONTRACT-CONTENT-SUBSTITUTION",
    "--requirement", "REQ-AUTONOMY",
    "--level", "bounded-autonomous",
    "--repository", "aantenore/agentic-sdlc-codex-plugin",
    "--base", "main",
    "--head", "codex/pr-1",
    "--write-path", "src",
  ]);
  mustRunJson([
    "autonomy", "delivery", "approve",
    "--root", contentProject,
    "--id", "AUT-CONTENT-SUBSTITUTION",
    "--phase", "implementation",
    ...humanApproval("Approve the exact content-substitution regression delivery"),
  ]);
  const contentStart = mustRunJson([
    "task", "start",
    "--root", contentProject,
    "--intent-json", taskIntent("ST-CONTENT-SUBSTITUTION"),
    "--delivery-profile", "AUT-CONTENT-SUBSTITUTION",
  ]);
  assert.equal(contentStart.execution_allowed, true);
  const contentPath = path.join(contentProject, "src", "content.txt");
  fs.mkdirSync(path.dirname(contentPath), { recursive: true });
  fs.writeFileSync(contentPath, "authorized content\n", "utf8");
  mustGit(contentProject, ["add", "--", "src/content.txt"]);
  const contentAuthorization = mustRunJson([
    "autonomy", "delivery", "action",
    "--root", contentProject,
    "--id", "AUT-CONTENT-SUBSTITUTION",
    "--action", "git.commit",
    "--scope-path", "src/content.txt",
  ]);
  assert.match(
    contentAuthorization.action_receipt.action_details.commit_snapshot.index_tree_oid,
    /^[a-f0-9]{40,64}$/u,
  );
  fs.writeFileSync(contentPath, "substituted after authorization\n", "utf8");
  mustGit(contentProject, ["add", "--", "src/content.txt"]);
  mustGit(contentProject, ["commit", "-m", "test: substitute authorized content"]);
  mustFail([
    "autonomy", "delivery", "action",
    "--root", contentProject,
    "--id", "AUT-CONTENT-SUBSTITUTION",
    "--action", "git.commit",
    "--outcome", "passed",
    "--evidence", "src/content.txt",
  ], /commit tree differs from the exact staged index authorized/u);

  const project = tmpProject("unmediated-push");
  initializeAutonomyProject(project);
  createApprovedImplementationContract(project, {
    storyId: "ST-UNMEDIATED-PUSH",
    contractId: "CONTRACT-UNMEDIATED-PUSH",
    profileId: "AUT-UNMEDIATED-PUSH",
  });
  mustRunJson([
    "autonomy", "delivery", "propose",
    "--root", project,
    "--id", "AUT-UNMEDIATED-PUSH",
    "--delivery", "PR-UNMEDIATED-PUSH",
    "--kind", "pull_request",
    "--story", "ST-UNMEDIATED-PUSH",
    "--contract", "CONTRACT-UNMEDIATED-PUSH",
    "--requirement", "REQ-AUTONOMY",
    "--level", "supervised",
    "--repository", "aantenore/agentic-sdlc-codex-plugin",
    "--base", "main",
    "--head", "codex/pr-1",
    "--write-path", "src",
  ]);
  mustRunJson([
    "autonomy", "delivery", "approve",
    "--root", project,
    "--id", "AUT-UNMEDIATED-PUSH",
    ...humanApproval("Approve supervised autonomy for the unmediated push regression"),
  ]);
  const started = mustRunJson([
    "task", "start",
    "--root", project,
    "--intent-json", taskIntent("ST-UNMEDIATED-PUSH"),
    "--delivery-profile", "AUT-UNMEDIATED-PUSH",
    "--confirm-start",
    "--actor-type", "human",
  ]);
  assert.equal(started.execution_allowed, true);

  const beforeCommit = mustGit(project, ["rev-parse", "HEAD"]);
  const changePath = path.join(project, "src", "unmediated.txt");
  fs.mkdirSync(path.dirname(changePath), { recursive: true });
  fs.writeFileSync(changePath, "commit created outside autonomy delivery action\n", "utf8");
  mustGit(project, ["add", "--", "src/unmediated.txt"]);
  mustGit(project, ["commit", "-m", "test: create unmediated delivery commit"]);
  mustGit(project, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

  mustFail([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-UNMEDIATED-PUSH",
    "--action", "git.push",
    "--remote", "origin",
    "--confirm-action",
    ...humanApproval("Attempt to approve a push whose commit skipped the action chain"),
  ], /git\.push cannot authorize unmediated commits: .*exactly one passing completed git\.commit receipt/u, {
    env: fakeGitRemoteEnv(project, beforeCommit),
  });
});

test("pull-request merge requires an exact open pre-state and later GitHub merged post-state", () => {
  const project = tmpProject("pull-request-merge");
  initializeAutonomyProject(project);
  createApprovedImplementationContract(project, {
    storyId: "ST-PR-MERGE",
    contractId: "CONTRACT-PR-MERGE",
    profileId: "AUT-PR-MERGE",
  });
  mustRunJson([
    "autonomy", "delivery", "propose",
    "--root", project,
    "--id", "AUT-PR-MERGE",
    "--delivery", "PR-MERGE",
    "--kind", "pull_request",
    "--story", "ST-PR-MERGE",
    "--contract", "CONTRACT-PR-MERGE",
    "--requirement", "REQ-AUTONOMY",
    "--level", "checkpointed",
    "--repository", "aantenore/agentic-sdlc-codex-plugin",
    "--base", "main",
    "--head", "codex/pr-1",
    "--write-path", "src",
    "--allow-action", "pull_request.merge",
    "--merge-allowed",
  ]);
  mustRunJson([
    "autonomy", "delivery", "approve",
    "--root", project,
    "--id", "AUT-PR-MERGE",
    ...humanApproval("Approve checkpointed autonomy for this exact merge delivery"),
  ]);

  const proofPath = path.join(project, "src", "merge-proof.txt");
  const approvalProofPath = path.join(project, "src", "merge-approval.txt");
  const summaryPath = path.join(project, "src", "implementation-summary.md");
  fs.mkdirSync(path.dirname(proofPath), { recursive: true });
  fs.writeFileSync(proofPath, "exact merge head\n", "utf8");
  fs.writeFileSync(approvalProofPath, "exact human merge approval evidence\n", "utf8");
  fs.writeFileSync(summaryPath, "# Implementation summary\n\nThe exact merge transition is verified.\n", "utf8");
  mustGit(project, [
    "add", "--",
    "src/merge-proof.txt",
    "src/merge-approval.txt",
    "src/implementation-summary.md",
  ]);
  mustGit(project, ["commit", "-m", "test: establish exact merge head"]);
  const headSha = mustGit(project, ["rev-parse", "HEAD"]);
  const baseSha = mustGit(project, ["rev-parse", "refs/remotes/origin/main"]);

  const intent = taskIntent("ST-PR-MERGE");
  const started = mustRunJson([
    "task", "start",
    "--root", project,
    "--intent-json", intent,
    "--delivery-profile", "AUT-PR-MERGE",
  ]);
  assert.equal(started.execution_allowed, true);
  mustRun([
    "story", "claim",
    "--root", project,
    "--id", "ST-PR-MERGE",
    "--agent", "codex",
    "--branch", "codex/ST-PR-MERGE",
  ]);
  mustRun([
    "output", "link",
    "--root", project,
    "--story", "ST-PR-MERGE",
    "--type", "implementation-summary",
    "--artifact", "src/implementation-summary.md",
    "--template", "implementation-summary-v1",
    "--mode", "new",
    "--requirement", "REQ-AUTONOMY",
  ]);

  const prUrl = "https://github.com/aantenore/agentic-sdlc-codex-plugin/pull/999999";
  const openState = {
    state: "OPEN",
    url: prUrl,
    headSha,
    headBranch: "codex/pr-1",
    baseBranch: "main",
    baseSha,
  };
  recordIndependentReview(project, "AUT-PR-MERGE");
  mustFail([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-PR-MERGE",
    "--action", "pull_request.merge",
    "--pr-url", prUrl,
  ], /exact open GitHub PR/u, { env: fakeGitHubEnv(project, { ...openState, isDraft: true }) });

  const checkpoint = mustRunJson([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-PR-MERGE",
    "--action", "pull_request.merge",
    "--pr-url", prUrl,
  ], { env: fakeGitHubEnv(project, openState) });
  assert.equal(checkpoint.status, "checkpoint_required");
  assert.equal(checkpoint.action_details.merge_precondition.state, "OPEN");

  const authorization = mustRunJson([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-PR-MERGE",
    "--action", "pull_request.merge",
    "--pr-url", prUrl,
    "--confirm-action",
    "--approval-evidence", "src/merge-approval.txt",
    ...humanApproval("Approve this exact open PR merge checkpoint"),
  ], { env: fakeGitHubEnv(project, openState) });
  assert.equal(authorization.status, "authorized");
  assert.equal(authorization.action_receipt.action_details.merge.base_sha, baseSha);
  assert.equal(
    authorization.action_receipt.action_details.provider_operation.precondition_receipt.subject.base_sha,
    baseSha,
  );
  assert.equal(
    authorization.action_receipt.action_details.provider_operation.precondition_receipt.provider.id,
    "github-cli",
  );
  const mergedAt = new Date(Date.parse(authorization.action_receipt.authorized_at) + 1_000).toISOString();
  const mergeSha = "f".repeat(40);

  const completion = mustRunJson([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-PR-MERGE",
    "--action", "pull_request.merge",
    "--outcome", "passed",
    "--evidence", "src/merge-proof.txt",
  ], {
    env: fakeGitHubEnv(project, { ...openState, state: "MERGED", mergedAt, mergeSha }),
  });
  assert.equal(completion.status, "completed");
  assert.equal(completion.lifecycle_status, "terminal");
  assert.equal(completion.action_receipt.action_details.provider_verification.state, "MERGED");
  assert.equal(completion.action_receipt.action_details.provider_verification.merge_commit_sha, mergeSha);
  assert.equal(
    completion.action_receipt.action_details.provider_operation.completion_receipt.precondition_receipt_ref.hash,
    authorization.action_receipt.action_details.provider_operation.precondition_receipt.receipt_hash,
  );
  const close = JSON.parse(fs.readFileSync(path.join(project, completion.close_receipt_path), "utf8"));
  assert.equal(close.terminal_status, "merged");
  assert.equal(close.terminal_action_receipt_ref.id, completion.action_receipt.id);
  assertMergeReceiptGateIntegrity(project);

  fs.writeFileSync(approvalProofPath, "tampered approval evidence\n", "utf8");
  const tamperedApprovalGate = run([
    "gate", "check",
    "--root", project,
    "--scope", "story",
    "--story", "ST-PR-MERGE",
    "--strict",
    "--json",
  ]);
  assert.equal(tamperedApprovalGate.status, 1, tamperedApprovalGate.stderr || tamperedApprovalGate.stdout);
  assert.match(
    `${tamperedApprovalGate.stdout}\n${tamperedApprovalGate.stderr}`,
    /approval evidence is invalid: .*evidence changed after approval/u,
  );
});

for (const topology of [
  {
    name: "fast-forward",
    result(fixture) {
      return fixture.headSha;
    },
  },
  {
    name: "two-parent merge commit",
    result(fixture) {
      return syntheticCommit(
        fixture.project,
        fixture.headSha,
        [fixture.baseSha, fixture.headSha],
        "test: exact merge result",
      );
    },
  },
  {
    name: "single-parent squash",
    result(fixture) {
      return syntheticCommit(
        fixture.project,
        fixture.headSha,
        [fixture.baseSha],
        "test: exact squash result",
      );
    },
  },
]) {
  test(`pull-request merge completion accepts an exact ${topology.name} base transition`, () => {
    const fixture = prepareAuthorizedPullRequestMerge(topology.name.replaceAll(/[^a-z]+/gu, "-"));
    const mergeSha = topology.result(fixture);
    mustGit(fixture.project, ["update-ref", "refs/remotes/origin/main", mergeSha]);

    const completion = completeAuthorizedPullRequestMerge(fixture, mergeSha);
    assert.equal(completion.status, "completed");
    assert.equal(completion.lifecycle_status, "terminal");
    assert.equal(completion.action_receipt.runtime_target.base_sha, mergeSha);
    assert.equal(completion.action_receipt.runtime_target.head_sha, fixture.headSha);
    assert.equal(completion.action_receipt.action_details.provider_verification.base_sha, fixture.baseSha);
    assert.equal(completion.action_receipt.action_details.provider_verification.merge_commit_sha, mergeSha);
    assertMergeReceiptGateIntegrity(fixture.project);
  });
}

test("pull-request merge completion rejects provider base drift and unproven local base transitions", () => {
  const fixture = prepareAuthorizedPullRequestMerge("transition-rejections");
  const mergedAt = new Date(Date.parse(fixture.authorization.action_receipt.authorized_at) + 1_000).toISOString();
  const completionArgs = [
    "autonomy", "delivery", "action",
    "--root", fixture.project,
    "--id", "AUT-PR-MERGE",
    "--action", "pull_request.merge",
    "--outcome", "passed",
    "--evidence", "src/merge-proof.txt",
  ];
  const mergedState = {
    ...fixture.openState,
    state: "MERGED",
    mergedAt,
    mergeSha: fixture.headSha,
  };

  mustFail(completionArgs, /exact PR, source SHA, branches, and merged state/u, {
    env: fakeGitHubEnv(fixture.project, { ...mergedState, baseSha: "e".repeat(40) }),
  });

  const afterMerge = syntheticCommit(
    fixture.project,
    fixture.headSha,
    [fixture.headSha],
    "test: advance main after exact merge",
  );
  mustGit(fixture.project, ["update-ref", "refs/remotes/origin/main", afterMerge]);
  mustFail(completionArgs, /does not point to the exact merge result proven by GitHub/u, {
    env: fakeGitHubEnv(fixture.project, mergedState),
  });

  const concurrentBase = syntheticCommit(
    fixture.project,
    fixture.baseSha,
    [fixture.baseSha],
    "test: concurrent base change",
  );
  const wrongMerge = syntheticCommit(
    fixture.project,
    fixture.headSha,
    [concurrentBase, fixture.headSha],
    "test: merge from a changed base",
  );
  mustGit(fixture.project, ["update-ref", "refs/remotes/origin/main", wrongMerge]);
  mustFail(completionArgs, /neither a bounded fast-forward, merge commit, nor squash/u, {
    env: fakeGitHubEnv(fixture.project, { ...mergedState, mergeSha: wrongMerge }),
  });

  const wrongSquash = syntheticCommit(
    fixture.project,
    fixture.headSha,
    [concurrentBase],
    "test: squash from a changed base",
  );
  mustGit(fixture.project, ["update-ref", "refs/remotes/origin/main", wrongSquash]);
  mustFail(completionArgs, /neither a bounded fast-forward, merge commit, nor squash/u, {
    env: fakeGitHubEnv(fixture.project, { ...mergedState, mergeSha: wrongSquash }),
  });

  const rebasedFirst = syntheticCommit(
    fixture.project,
    fixture.headSha,
    [fixture.baseSha],
    "test: first rewritten commit",
  );
  const rebasedTip = syntheticCommit(
    fixture.project,
    fixture.headSha,
    [rebasedFirst],
    "test: second rewritten commit",
  );
  mustGit(fixture.project, ["update-ref", "refs/remotes/origin/main", rebasedTip]);
  mustFail(completionArgs, /neither a bounded fast-forward, merge commit, nor squash/u, {
    env: fakeGitHubEnv(fixture.project, { ...mergedState, mergeSha: rebasedTip }),
  });
});

test("local release governs a failed data migration, verified rollback, and final retry without executing commands", () => {
  const project = tmpProject("local-data-migration");
  initializeAutonomyProject(project);
  createApprovedImplementationContract(project, {
    storyId: "ST-LOCAL-DATA",
    contractId: "CONTRACT-LOCAL-DATA",
    profileId: "AUT-LOCAL-DATA",
  });

  const releaseRoot = path.join(project, "local-data-release");
  const appPath = path.join(releaseRoot, "app");
  const dataDirectory = path.join(releaseRoot, "data");
  const dataPath = path.join(dataDirectory, "store.json");
  const backupPath = path.join(dataDirectory, "store.before.json");
  const previewEvidence = "evidence/st-local-data-migration-preview.json";
  const rollbackEvidence = "evidence/St-Local-Data-rollback-passed.json";
  const previewPath = path.join(project, previewEvidence);
  const actionReceiptsDirectory = path.join(project, ".sdlc", "autonomy", "actions");
  const actionReceiptNames = () => fs.existsSync(actionReceiptsDirectory)
    ? fs.readdirSync(actionReceiptsDirectory).sort()
    : [];
  const authorizationUseNames = (authorizationId) => {
    const directory = path.join(project, ".sdlc", "authorization-uses", authorizationId);
    return fs.existsSync(directory) ? fs.readdirSync(directory).sort() : [];
  };
  const actionIntentNames = () => {
    const directory = path.join(project, ".sdlc", "autonomy", "action-intents");
    return fs.existsSync(directory) ? fs.readdirSync(directory).sort() : [];
  };
  const storyTraceEvents = () => {
    const tracePath = path.join(project, ".sdlc", "traces", "ST-LOCAL-DATA.jsonl");
    return fs.existsSync(tracePath)
      ? fs.readFileSync(tracePath, "utf8")
          .split(/\r?\n/u)
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  };
  fs.mkdirSync(appPath, { recursive: true });
  fs.mkdirSync(dataDirectory, { recursive: true });
  fs.mkdirSync(path.dirname(previewPath), { recursive: true });
  fs.writeFileSync(dataPath, '{"schemaVersion":1,"records":[{"id":"A"}]}\n', "utf8");
  fs.writeFileSync(
    previewPath,
    '{"dryRun":true,"from":1,"to":2,"scope":"records[*].schemaVersion"}\n',
    "utf8",
  );

  const proposalArgs = [
    "autonomy", "delivery", "propose",
    "--root", project,
    "--id", "AUT-LOCAL-DATA",
    "--delivery", "LOCAL-DATA",
    "--kind", "local_release",
    "--story", "ST-LOCAL-DATA",
    "--contract", "CONTRACT-LOCAL-DATA",
    "--requirement", "REQ-AUTONOMY",
    "--level", "checkpointed",
    "--target-root", releaseRoot,
    "--write-path", appPath,
    "--write-path", dataDirectory,
    "--smoke-cwd", appPath,
    "--smoke-test", '["node","--version"]',
    "--rollback", "Restore store.json byte-for-byte from store.before.json.",
    "--allow-action", "build.local",
    "--allow-action", "test.run",
    "--allow-action", "data.migrate",
    "--allow-action", "release.local",
    "--data-target", dataPath,
    "--data-scope", "records[*].schemaVersion",
    "--migration-preview", previewEvidence,
    "--backup-path", backupPath,
  ];
  mustFail(
    proposalArgs,
    /require both --allow-action data\.migrate and --allow-action data\.rollback/u,
  );
  const proposal = mustRunJson([
    ...proposalArgs,
    "--allow-action", "data.rollback",
  ]);
  assert.deepEqual(
    proposal.delivery_profile.provider_bindings.map((binding) => binding.action),
    ["data.migrate", "data.rollback", "release.local", "rollback.verify"],
  );
  assert.equal(proposal.delivery_profile.local_release_target.data_migration.target_path, dataPath);
  assert.equal(
    proposal.delivery_profile.local_release_target.data_migration.backup.path,
    backupPath,
  );
  assert.deepEqual(
    proposal.delivery_profile.local_release_target.data_migration.scopes,
    ["records[*].schemaVersion"],
  );
  assert.equal(
    proposal.delivery_profile.local_release_target.data_migration.preview_evidence.length,
    1,
  );

  mustRunJson([
    "autonomy", "delivery", "approve",
    "--root", project,
    "--id", "AUT-LOCAL-DATA",
    "--phase", "implementation",
    ...humanApproval("Approve the exact reversible local data migration boundary"),
  ]);
  mustRunJson([
    "task", "start",
    "--root", project,
    "--intent-json", taskIntent("ST-LOCAL-DATA"),
    "--delivery-profile", "AUT-LOCAL-DATA",
  ]);

  fs.writeFileSync(
    path.join(project, "evidence", "premature-rollback.json"),
    '{"rollback":"not-run"}\n',
  );
  mustFail([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-LOCAL-DATA",
    "--action", "rollback.verify",
    "--evidence", "evidence/premature-rollback.json",
    "--confirm-action",
    ...humanApproval("Attempt rollback verification before a governed rollback"),
  ], /requires a verified data\.rollback receipt first/u);
  mustFail([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-LOCAL-DATA",
    "--action", "release.local",
    "--confirm-action",
    ...humanApproval("Attempt release before the reversible data sequence"),
  ], /requires rollback rehearsal, a final migration retry, and bound rollback verification/isu);

  const originalPreview = fs.readFileSync(previewPath, "utf8");
  fs.writeFileSync(previewPath, `${originalPreview.trim()}\nchanged\n`, "utf8");
  mustFail([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-LOCAL-DATA",
    "--action", "data.migrate",
    "--confirm-action",
    ...humanApproval("Attempt a migration after preview drift"),
  ], /preview evidence changed after approval/u);
  fs.writeFileSync(previewPath, originalPreview, "utf8");

  fs.writeFileSync(backupPath, '{"stale":true}\n', "utf8");
  mustFail([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-LOCAL-DATA",
    "--action", "data.migrate",
    "--confirm-action",
    ...humanApproval("Attempt a migration with a stale backup"),
  ], /existing backup does not match the current target/u);
  fs.rmSync(backupPath);

  const actionReceiptsBeforeMigrationCheckpoint = actionReceiptNames();
  const migrationCheckpointResult = run([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-LOCAL-DATA",
    "--action", "data.migrate",
    "--phase", "implementation",
    "--json",
  ]);
  assert.equal(migrationCheckpointResult.error, undefined);
  assert.equal(
    migrationCheckpointResult.status,
    0,
    `${migrationCheckpointResult.stdout}\n${migrationCheckpointResult.stderr}`,
  );
  const migrationCheckpoint = JSON.parse(migrationCheckpointResult.stdout);
  assert.equal(migrationCheckpoint.status, "checkpoint_required");
  assert.equal(migrationCheckpoint.action_receipt, undefined);
  assert.deepEqual(actionReceiptNames(), actionReceiptsBeforeMigrationCheckpoint);
  assert.match(migrationCheckpoint.human_guidance.required_decision, /store\.json/u);
  assert.match(migrationCheckpoint.human_guidance.required_decision, /records\[\*\]\.schemaVersion/u);
  assert.match(migrationCheckpoint.human_guidance.required_decision, /store\.before\.json/u);
  assert.doesNotMatch(migrationCheckpoint.human_guidance.required_decision, /st-local-data/iu);
  assert.match(
    migrationCheckpoint.human_guidance.required_decision,
    /preview evidence file listed in the optional technical details/u,
  );
  assert.deepEqual(
    migrationCheckpoint.human_guidance.details.preview_evidence,
    [previewEvidence],
  );

  const policyValidationAuthorization = mustRunJson([
    "authorization", "grant",
    "--root", project,
    "--id", "AUTH-LOCAL-DATA-POLICY",
    "--scope", "Approve one migration only after its policy source validates.",
    "--allow-use", "autonomy.delivery.action.data.migrate=AUT-LOCAL-DATA",
    "--max-uses", "1",
    ...humanApproval("Delegate one policy-validated data migration checkpoint"),
  ]).authorization;
  const policySourcePath = path.join(
    project,
    migrationCheckpoint.action_details.checkpoint_policy.policy_source_ref.path,
  );
  fs.mkdirSync(path.dirname(policySourcePath), { recursive: true });
  fs.writeFileSync(policySourcePath, '{"tampered":true}\n', "utf8");
  const receiptsBeforePolicyFailure = actionReceiptNames();
  mustFail([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-LOCAL-DATA",
    "--action", "data.migrate",
    "--phase", "implementation",
    "--confirm-action",
    "--authorization", policyValidationAuthorization.id,
    "--actor-type", "agent",
    "--actor-name", "Migration Test Automation",
    "--approval-source", "automation",
    "--summary", "Use the delegation only if the policy source is valid.",
  ], /checkpoint policy source .*stale or tampered/iu);
  assert.deepEqual(
    authorizationUseNames(policyValidationAuthorization.id),
    [],
    "logical policy-source failure must not consume the delegated authorization",
  );
  assert.deepEqual(actionReceiptNames(), receiptsBeforePolicyFailure);
  const policyAuthorizationAfterFailure = JSON.parse(fs.readFileSync(
    path.join(
      project,
      ".sdlc",
      "authorizations",
      `${policyValidationAuthorization.id}.json`,
    ),
    "utf8",
  ));
  assert.equal(policyAuthorizationAfterFailure.status, "active");
  assert.equal(policyAuthorizationAfterFailure.use_count ?? 0, 0);
  fs.rmSync(policySourcePath);

  const migrationApprovalAuthorization = mustRunJson([
    "authorization", "grant",
    "--root", project,
    "--id", "AUTH-LOCAL-DATA-MIGRATE",
    "--scope", "Approve one exact previewed local data migration.",
    "--allow-use", "autonomy.delivery.action.data.migrate=AUT-LOCAL-DATA",
    "--max-uses", "1",
    ...humanApproval("Delegate one exact data migration checkpoint"),
  ]).authorization;
  const firstMigrationAuthorizationArgs = [
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-LOCAL-DATA",
    "--action", "data.migrate",
    "--phase", "implementation",
    "--confirm-action",
    "--authorization", migrationApprovalAuthorization.id,
    "--actor-type", "agent",
    "--actor-name", "Migration Test Automation",
    "--approval-source", "automation",
    "--summary", "Use the delegated approval for this exact previewed migration only.",
  ];
  const receiptsBeforeInjectedFailure = actionReceiptNames();
  mustFail(
    firstMigrationAuthorizationArgs,
    /after authorization use and before action receipt persistence/iu,
    {
      env: {
        NODE_ENV: "test",
        AGENTIC_SDLC_TEST_DELIVERY_ACTION_FAILURE:
          "after-authorization-use-before-action-receipt",
      },
    },
  );
  assert.deepEqual(actionReceiptNames(), receiptsBeforeInjectedFailure);
  assert.equal(authorizationUseNames(migrationApprovalAuthorization.id).length, 1);
  assert.equal(actionIntentNames().length, 1);
  const migrationActionIntent = JSON.parse(fs.readFileSync(
    path.join(
      project,
      ".sdlc",
      "autonomy",
      "action-intents",
      actionIntentNames()[0],
    ),
    "utf8",
  ));
  const migrationAuthorizationTraceId = migrationActionIntent.trace_event.id;
  mustFail(
    firstMigrationAuthorizationArgs,
    /after action receipt persistence and before trace persistence/iu,
    {
      env: {
        NODE_ENV: "test",
        AGENTIC_SDLC_TEST_DELIVERY_ACTION_FAILURE:
          "after-action-receipt-before-trace",
      },
    },
  );
  assert.equal(
    actionReceiptNames().length,
    receiptsBeforeInjectedFailure.length + 1,
  );
  assert.equal(
    storyTraceEvents().filter((event) => event.id === migrationAuthorizationTraceId).length,
    0,
  );

  const firstMigrationAuthorization = mustRunJson(firstMigrationAuthorizationArgs);
  assert.equal(firstMigrationAuthorization.status, "authorized");
  assert.equal(firstMigrationAuthorization.action_receipt.checkpoint_required, true);
  assert.equal(
    firstMigrationAuthorization.action_receipt.approval.authorization_ref,
    migrationApprovalAuthorization.id,
  );
  assert.match(
    firstMigrationAuthorization.action_receipt.approval.authorization_use_ref,
    /authorization-uses\/AUTH-LOCAL-DATA-MIGRATE\/.+\.json$/u,
  );
  assert.doesNotMatch(
    firstMigrationAuthorization.human_guidance.required_decision,
    /st-local-data/iu,
  );
  assert.deepEqual(
    firstMigrationAuthorization.human_guidance.details.preview_evidence,
    [previewEvidence],
  );
  assert.equal(
    fs.existsSync(path.join(project, firstMigrationAuthorization.action_receipt_path)),
    true,
  );
  assert.equal(authorizationUseNames(migrationApprovalAuthorization.id).length, 1);
  assert.equal(
    actionReceiptNames().length,
    receiptsBeforeInjectedFailure.length + 1,
  );
  assert.equal(
    storyTraceEvents().filter((event) => event.id === migrationAuthorizationTraceId).length,
    1,
  );
  const idempotentMigrationAuthorization = mustRunJson(firstMigrationAuthorizationArgs);
  assert.equal(idempotentMigrationAuthorization.idempotent, true);
  assert.equal(
    idempotentMigrationAuthorization.action_receipt.id,
    firstMigrationAuthorization.action_receipt.id,
  );
  assert.equal(authorizationUseNames(migrationApprovalAuthorization.id).length, 1);
  assert.equal(
    actionReceiptNames().length,
    receiptsBeforeInjectedFailure.length + 1,
  );
  assert.equal(
    storyTraceEvents().filter((event) => event.id === migrationAuthorizationTraceId).length,
    1,
  );
  assert.equal(
    firstMigrationAuthorization.action_receipt.action_details
      .provider_operation.precondition_receipt.proof.backup.status,
    "absent",
  );

  fs.copyFileSync(dataPath, backupPath);
  fs.writeFileSync(dataPath, '{"schemaVersion":2,"partial":true}\n', "utf8");
  fs.writeFileSync(path.join(project, "evidence", "migration-failed.json"), '{"outcome":"failed"}\n');
  const failedMigration = mustRunJson([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-LOCAL-DATA",
    "--action", "data.migrate",
    "--outcome", "failed",
    "--evidence", "evidence/migration-failed.json",
  ]);
  assert.equal(failedMigration.action_receipt.outcome, "failed");
  assert.equal(
    failedMigration.action_receipt.authorization_receipt_ref.id,
    firstMigrationAuthorization.action_receipt.id,
  );
  const usesAfterFailedMigration = authorizationUseNames(
    migrationApprovalAuthorization.id,
  );
  const receiptsAfterFailedMigration = actionReceiptNames();
  mustFail(
    firstMigrationAuthorizationArgs,
    /already consumed by completion .*Create a new delegated authorization/iu,
  );
  assert.deepEqual(
    authorizationUseNames(migrationApprovalAuthorization.id),
    usesAfterFailedMigration,
  );
  assert.deepEqual(actionReceiptNames(), receiptsAfterFailedMigration);
  assert.equal(
    storyTraceEvents().filter((event) => event.id === migrationAuthorizationTraceId).length,
    1,
  );

  const beforeRollbackGate = run([
    "gate", "check",
    "--root", project,
    "--scope", "story",
    "--story", "ST-LOCAL-DATA",
    "--strict",
    "--lifecycle-complete",
    "--json",
  ]);
  assert.notEqual(beforeRollbackGate.status, 0);
  const beforeRollbackReport = JSON.parse(beforeRollbackGate.stdout);
  assert.ok(beforeRollbackReport.errors.some((error) =>
    /requires a passing verified data\.rollback/u.test(error)));

  const rollbackAuthorization = mustRunJson([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-LOCAL-DATA",
    "--action", "data.rollback",
    "--confirm-action",
    ...humanApproval("Approve restoration from the exact migration backup"),
  ]);
  fs.copyFileSync(backupPath, dataPath);
  fs.writeFileSync(path.join(project, rollbackEvidence), '{"restored":true}\n');
  const rollbackCompletion = mustRunJson([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-LOCAL-DATA",
    "--action", "data.rollback",
    "--outcome", "passed",
    "--evidence", rollbackEvidence,
  ]);
  assert.equal(
    rollbackCompletion.action_receipt.authorization_receipt_ref.id,
    rollbackAuthorization.action_receipt.id,
  );
  assert.equal(
    rollbackCompletion.action_receipt.data_operation_verification.rollback_verified,
    true,
  );
  assert.equal(
    rollbackCompletion.action_receipt.data_operation_verification.after_target_sha256,
    rollbackCompletion.action_receipt.data_operation_verification.backup_sha256,
  );

  const finalMigrationAuthorization = mustRunJson([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-LOCAL-DATA",
    "--action", "data.migrate",
    "--confirm-action",
    ...humanApproval("Approve the corrected exact data migration"),
  ]);
  fs.writeFileSync(dataPath, '{"schemaVersion":2,"records":[{"id":"A"}]}\n', "utf8");
  fs.writeFileSync(path.join(project, "evidence", "migration-passed.json"), '{"outcome":"passed"}\n');
  const finalMigration = mustRunJson([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-LOCAL-DATA",
    "--action", "data.migrate",
    "--outcome", "passed",
    "--evidence", "evidence/migration-passed.json",
  ]);
  assert.equal(
    finalMigration.action_receipt.authorization_receipt_ref.id,
    finalMigrationAuthorization.action_receipt.id,
  );
  assert.equal(finalMigration.action_receipt.data_operation_verification.transition, "migrated");

  const afterRetryGate = run([
    "gate", "check",
    "--root", project,
    "--scope", "story",
    "--story", "ST-LOCAL-DATA",
    "--strict",
    "--lifecycle-complete",
    "--json",
  ]);
  assert.notEqual(afterRetryGate.status, 0);
  const afterRetryReport = JSON.parse(afterRetryGate.stdout);
  assert.equal(
    afterRetryReport.errors.some((error) =>
      /requires a passing verified data\.rollback|requires a passing data\.migrate after/u.test(error)),
    false,
  );
  assert.ok(afterRetryReport.errors.some((error) =>
    /requires release\.local after the final verified data\.migrate/u.test(error)));
  assert.ok(afterRetryReport.errors.some((error) =>
    /requires verified rollback evidence/u.test(error)));

  const rollbackEvidencePath = path.join(project, rollbackEvidence);
  const actionReceiptsBeforeRollbackCheckpoint = actionReceiptNames();
  const rollbackVerificationCheckpoint = mustRunJson([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-LOCAL-DATA",
    "--action", "rollback.verify",
    "--evidence", rollbackEvidence,
  ]);
  assert.equal(rollbackVerificationCheckpoint.status, "checkpoint_required");
  assert.equal(rollbackVerificationCheckpoint.action_receipt, undefined);
  assert.deepEqual(actionReceiptNames(), actionReceiptsBeforeRollbackCheckpoint);
  assert.doesNotMatch(
    rollbackVerificationCheckpoint.human_guidance.required_decision,
    /st-local-data/iu,
  );
  assert.match(
    rollbackVerificationCheckpoint.human_guidance.required_decision,
    /rollback evidence file listed in the optional technical details/u,
  );
  assert.deepEqual(
    rollbackVerificationCheckpoint.human_guidance.details.rollback_evidence,
    [rollbackEvidence],
  );
  const rollbackVerificationAuthorization = mustRunJson([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-LOCAL-DATA",
    "--action", "rollback.verify",
    "--evidence", rollbackEvidence,
    "--confirm-action",
    ...humanApproval("Approve the exact rollback rehearsal evidence"),
  ]);
  assert.equal(rollbackVerificationAuthorization.status, "authorized");
  assert.doesNotMatch(
    rollbackVerificationAuthorization.human_guidance.required_decision,
    /st-local-data/iu,
  );
  assert.deepEqual(
    rollbackVerificationAuthorization.human_guidance.details.rollback_evidence,
    [rollbackEvidence],
  );
  fs.writeFileSync(rollbackEvidencePath, '{"restored":"tampered"}\n');
  mustFail([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-LOCAL-DATA",
    "--action", "rollback.verify",
    "--outcome", "passed",
    "--evidence", rollbackEvidence,
  ], /must use the exact evidence set bound at authorization/u);
  fs.writeFileSync(rollbackEvidencePath, '{"restored":true}\n');
  const rollbackVerification = mustRunJson([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-LOCAL-DATA",
    "--action", "rollback.verify",
    "--outcome", "passed",
    "--evidence", rollbackEvidence,
  ]);
  assert.equal(
    rollbackVerification.action_receipt.authorization_receipt_ref.id,
    rollbackVerificationAuthorization.action_receipt.id,
  );
  assert.equal(rollbackVerification.action_receipt.rollback_verification.verified, true);
  assert.deepEqual(
    rollbackVerification.action_receipt.rollback_verification.data_rollback_receipt_ref,
    {
      id: rollbackCompletion.action_receipt.id,
      path: rollbackCompletion.action_receipt_path,
      hash: rollbackCompletion.action_receipt.receipt_hash,
    },
  );
  fs.writeFileSync(rollbackEvidencePath, '{"restored":"tampered-after-receipt"}\n');
  const tamperedRollbackGate = run([
    "gate", "check",
    "--root", project,
    "--scope", "story",
    "--story", "ST-LOCAL-DATA",
    "--strict",
    "--json",
  ]);
  assert.notEqual(tamperedRollbackGate.status, 0);
  assert.match(
    tamperedRollbackGate.stdout,
    /rollback verification evidence changed|evidence changed after recording/u,
  );
  fs.writeFileSync(rollbackEvidencePath, '{"restored":true}\n');

  if (!hostSupportsLocalSmokeSandbox()) return;
  const releaseAuthorization = mustRunJson([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-LOCAL-DATA",
    "--action", "release.local",
    "--confirm-action",
    ...humanApproval("Approve the final local release after rollback verification"),
  ]);
  assert.deepEqual(
    releaseAuthorization.action_receipt.action_details.data_migration_sequence
      .data_rollback_receipt_ref,
    rollbackVerification.action_receipt.rollback_verification.data_rollback_receipt_ref,
  );
  assert.equal(
    releaseAuthorization.action_receipt.action_details.data_migration_sequence
      .final_data_migration_receipt_ref.id,
    finalMigration.action_receipt.id,
  );
  assert.equal(
    releaseAuthorization.action_receipt.action_details.data_migration_sequence
      .rollback_verification_receipt_ref.id,
    rollbackVerification.action_receipt.id,
  );
  fs.writeFileSync(path.join(project, "evidence", "release-passed.json"), '{"released":true}\n');
  const released = mustRunJson([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-LOCAL-DATA",
    "--action", "release.local",
    "--outcome", "passed",
    "--evidence", "evidence/release-passed.json",
    "--smoke-cwd", appPath,
    "--smoke-test", '["node","--version"]',
    "--rollback", "Restore store.json byte-for-byte from store.before.json.",
  ], { timeout: 90_000 });
  assert.equal(released.lifecycle_status, "terminal");
  assert.equal(
    released.action_receipt.authorization_receipt_ref.id,
    releaseAuthorization.action_receipt.id,
  );
  assert.deepEqual(
    released.action_receipt.local_release_verification.data_migration_sequence,
    releaseAuthorization.action_receipt.action_details.data_migration_sequence,
  );

  const afterReleaseGate = run([
    "gate", "check",
    "--root", project,
    "--scope", "story",
    "--story", "ST-LOCAL-DATA",
    "--strict",
    "--lifecycle-complete",
    "--json",
  ]);
  const afterReleaseReport = JSON.parse(afterReleaseGate.stdout);
  assert.equal(
    afterReleaseReport.errors.some((error) =>
      /data\.rollback|data\.migrate|release\.local after the final verified/u.test(error)),
    false,
    afterReleaseGate.stdout,
  );
});

test("delivery action intents keep distinct replay-allowed requests and traces", () => {
  const project = tmpProject("delivery-action-intent-replay");
  initializeAutonomyProject(project);
  createApprovedImplementationContract(project, {
    storyId: "ST-ACTION-INTENT",
    contractId: "CONTRACT-ACTION-INTENT",
    profileId: "AUT-ACTION-INTENT",
  });
  mustRunJson([
    "autonomy", "delivery", "propose",
    "--root", project,
    "--id", "AUT-ACTION-INTENT",
    "--delivery", "PR-ACTION-INTENT",
    "--kind", "pull_request",
    "--story", "ST-ACTION-INTENT",
    "--contract", "CONTRACT-ACTION-INTENT",
    "--requirement", "REQ-AUTONOMY",
    "--level", "supervised",
    "--repository", "aantenore/agentic-sdlc-codex-plugin",
    "--base", "main",
    "--head", "codex/pr-1",
    "--write-path", "src",
    "--allow-action", "test.run",
  ]);
  mustRunJson([
    "autonomy", "delivery", "approve",
    "--root", project,
    "--id", "AUT-ACTION-INTENT",
    ...humanApproval("Approve the supervised replay-policy test delivery"),
  ]);
  const started = mustRunJson([
    "task", "start",
    "--root", project,
    "--intent-json", taskIntent("ST-ACTION-INTENT"),
    "--delivery-profile", "AUT-ACTION-INTENT",
    "--confirm-start",
    "--actor-type", "human",
  ]);
  assert.equal(started.execution_allowed, true);

  const authorization = mustRunJson([
    "authorization", "grant",
    "--root", project,
    "--id", "AUTH-ACTION-INTENT",
    "--scope", "Approve two exact supervised test checkpoints.",
    "--allow-use", "autonomy.delivery.action.test.run=AUT-ACTION-INTENT",
    "--max-uses", "2",
    ...humanApproval("Delegate two exact test checkpoints for this delivery"),
  ]).authorization;
  const authorizationPath = path.join(
    project,
    ".sdlc",
    "authorizations",
    `${authorization.id}.json`,
  );
  const replayAllowedAuthorization = JSON.parse(
    fs.readFileSync(authorizationPath, "utf8"),
  );
  replayAllowedAuthorization.use_policy.replay = "allow";
  replayAllowedAuthorization.approved_content_hash = legacyAuthorizationContentHash(
    replayAllowedAuthorization,
  );
  fs.writeFileSync(
    authorizationPath,
    `${JSON.stringify(replayAllowedAuthorization, null, 2)}\n`,
    "utf8",
  );

  const authorizationArgs = (summary) => [
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-ACTION-INTENT",
    "--action", "test.run",
    "--phase", "implementation",
    "--confirm-action",
    "--authorization", authorization.id,
    "--actor-type", "agent",
    "--actor-name", "Replay Test Automation",
    "--approval-source", "automation",
    "--summary", summary,
  ];
  const first = mustRunJson(authorizationArgs(
    "Approve the first exact supervised test checkpoint.",
  ));
  const second = mustRunJson(authorizationArgs(
    "Approve the second distinct supervised test checkpoint.",
  ));
  assert.equal(first.action_receipt.schema_version, "delivery-action-receipt:v2");
  assert.equal(second.action_receipt.schema_version, "delivery-action-receipt:v2");
  assert.notEqual(first.action_receipt.id, second.action_receipt.id);
  assert.notEqual(
    first.action_receipt.approval.authorization_use_ref,
    second.action_receipt.approval.authorization_use_ref,
  );
  const intents = fs.readdirSync(
    path.join(project, ".sdlc", "autonomy", "action-intents"),
  ).filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(fs.readFileSync(
      path.join(project, ".sdlc", "autonomy", "action-intents", name),
      "utf8",
    )));
  assert.equal(intents.length, 2);
  assert.notEqual(intents[0].request_hash, intents[1].request_hash);
  assert.notEqual(intents[0].transaction_key, intents[1].transaction_key);
  const traces = fs.readFileSync(
    path.join(project, ".sdlc", "traces", "ST-ACTION-INTENT.jsonl"),
    "utf8",
  ).split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  for (const receipt of [first.action_receipt, second.action_receipt]) {
    assert.equal(
      traces.filter((event) => event.id === `TR-AUTH-${receipt.id}`).length,
      1,
    );
  }

  const completionEvidence = ".sdlc/requirements/REQ-AUTONOMY.json";
  const ambiguousCompletionArgs = [
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-ACTION-INTENT",
    "--action", "test.run",
    "--outcome", "passed",
    "--evidence", completionEvidence,
  ];
  mustFail(
    ambiguousCompletionArgs,
    /More than one unconsumed authorization receipt matches test\.run.*--authorization-receipt/isu,
  );

  const selectedCompletionArgs = [
    ...ambiguousCompletionArgs,
    "--authorization-receipt", second.action_receipt.id,
  ];
  mustFail(
    selectedCompletionArgs,
    /after action receipt persistence and before trace persistence/iu,
    {
      env: {
        NODE_ENV: "test",
        AGENTIC_SDLC_TEST_DELIVERY_ACTION_FAILURE:
          "after-action-receipt-before-trace",
      },
    },
  );
  const actionReceiptsRoot = path.join(project, ".sdlc", "autonomy", "actions");
  const readActionReceipts = () => fs.readdirSync(actionReceiptsRoot)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(fs.readFileSync(
      path.join(actionReceiptsRoot, name),
      "utf8",
    )));
  const afterInterruptedCompletion = readActionReceipts();
  const interruptedCompletion = afterInterruptedCompletion.find((receipt) =>
    receipt.status === "completed"
    && receipt.authorization_receipt_ref?.id === second.action_receipt.id);
  assert.ok(interruptedCompletion);
  assert.equal(
    interruptedCompletion.schema_version,
    "delivery-action-receipt:v2",
  );
  assert.ok(interruptedCompletion.completion_request);
  assert.equal(
    afterInterruptedCompletion.filter((receipt) => receipt.status === "completed").length,
    1,
  );
  const interruptedCompletionPath = path.join(
    actionReceiptsRoot,
    `${interruptedCompletion.id}.json`,
  );
  const interruptedCompletionText = fs.readFileSync(
    interruptedCompletionPath,
    "utf8",
  );
  const currentCompletionWithoutRequest = JSON.parse(interruptedCompletionText);
  delete currentCompletionWithoutRequest.completion_request;
  currentCompletionWithoutRequest.receipt_hash = lifecycleReceiptHash(
    currentCompletionWithoutRequest,
  );
  fs.writeFileSync(
    interruptedCompletionPath,
    `${JSON.stringify(currentCompletionWithoutRequest, null, 2)}\n`,
    "utf8",
  );
  mustFail(
    ["gate", "check", "--root", project, "--story", "ST-ACTION-INTENT", "--strict"],
    /Delivery lifecycle receipt .* validation failed: .*completion_request/isu,
  );

  const legacyCompletionWithoutRequest = structuredClone(
    currentCompletionWithoutRequest,
  );
  legacyCompletionWithoutRequest.schema_version = "delivery-action-receipt:v1";
  legacyCompletionWithoutRequest.receipt_hash = lifecycleReceiptHash(
    legacyCompletionWithoutRequest,
  );
  fs.writeFileSync(
    interruptedCompletionPath,
    `${JSON.stringify(legacyCompletionWithoutRequest, null, 2)}\n`,
    "utf8",
  );
  const legacyGate = run([
    "gate", "check",
    "--root", project,
    "--story", "ST-ACTION-INTENT",
    "--strict",
    "--json",
  ]);
  assert.equal(legacyGate.error, undefined);
  assert.ok([0, 1].includes(legacyGate.status), legacyGate.stderr);
  const legacyGateReport = JSON.parse(legacyGate.stdout);
  assert.ok(
    legacyGateReport.warnings.some((warning) =>
      warning.includes(interruptedCompletion.id)
      && warning.includes("legacy completion without an immutable completion request")),
    legacyGate.stdout,
  );
  assert.equal(
    legacyGateReport.errors.some((error) =>
      error.includes(interruptedCompletion.id)
      && error.includes("completion request")),
    false,
    legacyGate.stdout,
  );
  fs.writeFileSync(interruptedCompletionPath, interruptedCompletionText, "utf8");
  const traceAfterInterruptedCompletion = fs.readFileSync(
    path.join(project, ".sdlc", "traces", "ST-ACTION-INTENT.jsonl"),
    "utf8",
  ).split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(
    traceAfterInterruptedCompletion.filter(
      (event) => event.id === `TR-COMP-${interruptedCompletion.id}`,
    ).length,
    0,
  );

  const recoveredCompletion = mustRunJson(selectedCompletionArgs);
  assert.equal(recoveredCompletion.idempotent, true);
  assert.equal(recoveredCompletion.recovery_status, "repaired");
  assert.equal(recoveredCompletion.action_receipt.id, interruptedCompletion.id);
  assert.equal(
    recoveredCompletion.action_receipt.authorization_receipt_ref.id,
    second.action_receipt.id,
  );
  assert.equal(
    readActionReceipts().filter((receipt) => receipt.status === "completed").length,
    1,
    "an identical completion retry must not consume the other pending authorization",
  );
  const traceAfterRecovery = fs.readFileSync(
    path.join(project, ".sdlc", "traces", "ST-ACTION-INTENT.jsonl"),
    "utf8",
  ).split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(
    traceAfterRecovery.filter(
      (event) => event.id === `TR-COMP-${interruptedCompletion.id}`,
    ).length,
    1,
  );
  const repeatedCompletion = mustRunJson(selectedCompletionArgs);
  assert.equal(repeatedCompletion.idempotent, true);
  assert.equal(repeatedCompletion.recovery_status, "already_consistent");
  assert.equal(repeatedCompletion.action_receipt.id, interruptedCompletion.id);
  assert.equal(
    readActionReceipts().filter((receipt) => receipt.status === "completed").length,
    1,
  );

  const distinctCompletion = mustRunJson([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-ACTION-INTENT",
    "--action", "test.run",
    "--outcome", "passed",
    "--authorization-receipt", first.action_receipt.id,
    "--evidence", ".sdlc/project.json",
  ]);
  assert.equal(distinctCompletion.idempotent, undefined);
  assert.equal(
    distinctCompletion.action_receipt.authorization_receipt_ref.id,
    first.action_receipt.id,
  );
  assert.equal(
    readActionReceipts().filter((receipt) => receipt.status === "completed").length,
    2,
  );

  const originalCompletionPath = interruptedCompletionPath;
  const originalCompletionText = interruptedCompletionText;
  const tamperedCompletion = JSON.parse(originalCompletionText);
  tamperedCompletion.completion_request.request_hash = "0".repeat(64);
  tamperedCompletion.receipt_hash = lifecycleReceiptHash(tamperedCompletion);
  fs.writeFileSync(
    originalCompletionPath,
    `${JSON.stringify(tamperedCompletion, null, 2)}\n`,
    "utf8",
  );
  mustFail(
    ["gate", "check", "--root", project, "--story", "ST-ACTION-INTENT", "--strict"],
    /invalid completion identity.*completion request hash is invalid/isu,
  );
  mustFail(
    selectedCompletionArgs,
    /invalid completion identity.*completion request hash is invalid/isu,
  );
  fs.writeFileSync(originalCompletionPath, originalCompletionText, "utf8");

  const collision = JSON.parse(originalCompletionText);
  collision.id = "AUT-ACT-COMPLETION-COLLISION";
  collision.receipt_hash = lifecycleReceiptHash(collision);
  const collisionPath = path.join(actionReceiptsRoot, `${collision.id}.json`);
  fs.writeFileSync(collisionPath, `${JSON.stringify(collision, null, 2)}\n`, "utf8");
  mustFail(
    selectedCompletionArgs,
    /Completion retry identity collision/iu,
  );
  fs.rmSync(collisionPath);
});

test("authorization revoke and delivery use serialize without lost revocation or partial consumption", async () => {
  const project = tmpProject("authorization-revoke-use-race");
  initializeAutonomyProject(project);
  createApprovedImplementationContract(project, {
    storyId: "ST-AUTH-RACE",
    contractId: "CONTRACT-AUTH-RACE",
    profileId: "AUT-AUTH-RACE",
  });
  mustRunJson([
    "autonomy", "delivery", "propose",
    "--root", project,
    "--id", "AUT-AUTH-RACE",
    "--delivery", "PR-AUTH-RACE",
    "--kind", "pull_request",
    "--story", "ST-AUTH-RACE",
    "--contract", "CONTRACT-AUTH-RACE",
    "--requirement", "REQ-AUTONOMY",
    "--level", "supervised",
    "--repository", "aantenore/agentic-sdlc-codex-plugin",
    "--base", "main",
    "--head", "codex/pr-1",
    "--write-path", "src",
    "--allow-action", "test.run",
  ]);
  mustRunJson([
    "autonomy", "delivery", "approve",
    "--root", project,
    "--id", "AUT-AUTH-RACE",
    ...humanApproval("Approve the supervised authorization race test delivery"),
  ]);
  mustRunJson([
    "task", "start",
    "--root", project,
    "--intent-json", taskIntent("ST-AUTH-RACE"),
    "--delivery-profile", "AUT-AUTH-RACE",
    "--confirm-start",
    "--actor-type", "human",
  ]);
  const authorization = mustRunJson([
    "authorization", "grant",
    "--root", project,
    "--id", "AUTH-RACE",
    "--scope", "Approve one exact supervised test checkpoint.",
    "--allow-use", "autonomy.delivery.action.test.run=AUT-AUTH-RACE",
    "--max-uses", "1",
    ...humanApproval("Delegate one exact test checkpoint for the race"),
  ]).authorization;
  const authorizationPath = path.join(
    project,
    ".sdlc",
    "authorizations",
    `${authorization.id}.json`,
  );
  const lockPath = `${authorizationPath}.lock`;
  const lockNonce = crypto.randomBytes(12).toString("hex");
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: process.pid,
    host: os.hostname(),
    nonce: lockNonce,
    created_at: new Date().toISOString(),
  }));

  const usePromise = runAsync([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-AUTH-RACE",
    "--action", "test.run",
    "--phase", "implementation",
    "--confirm-action",
    "--authorization", authorization.id,
    "--actor-type", "agent",
    "--actor-name", "Race Test Automation",
    "--approval-source", "automation",
    "--summary", "Consume the exact test checkpoint if it wins the authorization lock.",
    "--json",
  ]);
  const revokePromise = runAsync([
    "authorization", "revoke",
    "--root", project,
    "--id", authorization.id,
    "--reason", "Race-test revocation",
    "--actor-type", "human",
    "--json",
  ]);
  await new Promise((resolve) => setTimeout(resolve, 750));
  const heldLock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  assert.equal(heldLock.nonce, lockNonce);
  fs.rmSync(lockPath);

  const [useResult, revokeResult] = await Promise.all([usePromise, revokePromise]);
  assert.equal(useResult.signal, null);
  assert.equal(revokeResult.signal, null);
  assert.equal(
    revokeResult.status,
    0,
    `STDOUT:\n${revokeResult.stdout}\nSTDERR:\n${revokeResult.stderr}`,
  );
  const finalAuthorization = JSON.parse(fs.readFileSync(authorizationPath, "utf8"));
  assert.equal(finalAuthorization.status, "revoked");
  assert.equal(
    finalAuthorization.approved_content_hash,
    legacyAuthorizationContentHash(finalAuthorization),
  );

  const usesDirectory = path.join(
    project,
    ".sdlc",
    "authorization-uses",
    authorization.id,
  );
  const useNames = fs.existsSync(usesDirectory)
    ? fs.readdirSync(usesDirectory).filter((name) => name.endsWith(".json"))
    : [];
  if (useResult.status === 0) {
    assert.equal(useNames.length, 1);
    const useReceipt = JSON.parse(fs.readFileSync(
      path.join(usesDirectory, useNames[0]),
      "utf8",
    ));
    assert.ok(
      Date.parse(useReceipt.used_at) <= Date.parse(finalAuthorization.revoked_at),
      "a successful use must be serialized before the later revocation",
    );
    const actionResult = JSON.parse(useResult.stdout);
    assert.equal(actionResult.status, "authorized");
    assert.equal(actionResult.action_receipt.approval.authorization_ref, authorization.id);
  } else {
    assert.equal(useNames.length, 0);
    assert.match(
      `${useResult.stdout}\n${useResult.stderr}`,
      /Authorization AUTH-RACE is revoked/u,
    );
    const actionReceiptsRoot = path.join(project, ".sdlc", "autonomy", "actions");
    const actionReceipts = fs.existsSync(actionReceiptsRoot)
      ? fs.readdirSync(actionReceiptsRoot).filter((name) => name.endsWith(".json"))
      : [];
    assert.equal(actionReceipts.length, 0);
  }
});

test("local release planning accepts a not-yet-created target while protected release execution requires it", () => {
  const project = tmpProject("local-release-planned-target");
  initializeAutonomyProject(project);
  createApprovedImplementationContract(project, {
    storyId: "ST-LOCAL-PLANNED",
    contractId: "CONTRACT-LOCAL-PLANNED",
    profileId: "AUT-LOCAL-PLANNED",
  });

  const releaseRoot = path.join(project, "planned-release");
  const releaseOutput = path.join(releaseRoot, "app");
  assert.equal(fs.existsSync(releaseRoot), false);

  const proposal = mustRunJson([
    "autonomy", "delivery", "propose",
    "--root", project,
    "--id", "AUT-LOCAL-PLANNED",
    "--delivery", "LOCAL-RELEASE-PLANNED",
    "--kind", "local_release",
    "--story", "ST-LOCAL-PLANNED",
    "--contract", "CONTRACT-LOCAL-PLANNED",
    "--requirement", "REQ-AUTONOMY",
    "--level", "checkpointed",
    "--target-root", releaseRoot,
    "--write-path", releaseOutput,
    "--smoke-test", '["node","--version"]',
    "--rollback", "Remove the planned release and restore the previous snapshot.",
  ]);
  assert.equal(proposal.status, "proposed");
  assert.equal(proposal.delivery_profile.local_release_target.root_path, releaseRoot);
  assert.deepEqual(
    proposal.delivery_profile.local_release_target.allowed_write_paths,
    [releaseOutput],
  );
  assert.equal(proposal.delivery_profile.local_release_target.smoke_cwd, releaseOutput);
  assert.match(
    proposal.human_guidance.impact,
    /may be absent while this delivery is only being planned.*rollback\.verify, data\.migrate, data\.rollback, or release\.local.*first request the exact local build authorization.*external builder create that root.*CLI never creates the directory itself/isu,
  );
  assert.equal(fs.existsSync(releaseRoot), false);

  mustRunJson([
    "autonomy", "delivery", "approve",
    "--root", project,
    "--id", "AUT-LOCAL-PLANNED",
    "--phase", "implementation",
    ...humanApproval("Approve planning against this exact future local target"),
  ]);
  const started = mustRunJson([
    "task", "start",
    "--root", project,
    "--intent-json", taskIntent("ST-LOCAL-PLANNED"),
    "--delivery-profile", "AUT-LOCAL-PLANNED",
    "--confirm-start",
    "--actor-type", "human",
  ]);
  assert.equal(started.execution_allowed, true);
  assert.equal(started.task_start_receipt, ".sdlc/stories/ST-LOCAL-PLANNED/task-start.json");
  assert.equal(
    fs.existsSync(path.join(project, ...started.task_start_receipt.split("/"))),
    true,
  );
  const deliveryStart = JSON.parse(fs.readFileSync(
    path.join(
      project,
      ".sdlc",
      "autonomy",
      "executions",
      "AUT-LOCAL-PLANNED",
      "start.json",
    ),
    "utf8",
  ));
  assert.equal(deliveryStart.schema_version, "delivery-start-receipt:v2");
  assert.equal(
    deliveryStart.local_release_target_baseline.entries[0].status,
    "absent",
  );
  const missingReleaseRoot = mustFail([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-LOCAL-PLANNED",
    "--action", "release.local",
  ], /must exist before this protected action/u);
  assert.match(
    `${missingReleaseRoot.stdout}\n${missingReleaseRoot.stderr}`,
    /first request build\.local without --confirm-action.*checkpoint_required.*repeat with direct approval.*external builder create the exact target root.*Complete build\.local with immutable evidence.*rollback\.verify, data\.migrate, data\.rollback, or release\.local.*CLI does not create directories.*ungoverned mkdir is not a repair/isu,
  );
  assert.equal(fs.existsSync(releaseRoot), false);

  fs.writeFileSync(
    path.join(project, "planned-rollback-rehearsal.json"),
    '{"target":"local-release-planned","restored":true}\n',
    "utf8",
  );
  const missingRollbackRoot = mustFail([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-LOCAL-PLANNED",
    "--action", "rollback.verify",
    "--evidence", "planned-rollback-rehearsal.json",
  ], /must exist before this protected action/u);
  assert.match(
    `${missingRollbackRoot.stdout}\n${missingRollbackRoot.stderr}`,
    /first request build\.local without --confirm-action.*checkpoint_required.*Complete build\.local with immutable evidence/isu,
  );
  assert.equal(fs.existsSync(releaseRoot), false);

  fs.mkdirSync(releaseOutput, { recursive: true });
  mustFail([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-LOCAL-PLANNED",
    "--action", "rollback.verify",
    "--evidence", "planned-rollback-rehearsal.json",
  ], /requires a completed passing build\.local receipt.*root was absent at task start.*mkdir is not a repair/isu);
  mustFail([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-LOCAL-PLANNED",
    "--action", "build.local",
  ], /changed outside governed build\.local.*manual mkdir is not a repair/isu);

  const downgradedProject = `${project}-downgraded-start`;
  fs.cpSync(project, downgradedProject, { recursive: true });
  tempProjects.add(downgradedProject);
  mutateDeliveryStartReceipt(
    downgradedProject,
    "AUT-LOCAL-PLANNED",
    "ST-LOCAL-PLANNED",
    (start) => {
      start.schema_version = "delivery-start-receipt:v1";
      delete start.local_release_target_baseline;
    },
  );
  mustFail([
    "autonomy", "delivery", "action",
    "--root", downgradedProject,
    "--id", "AUT-LOCAL-PLANNED",
    "--action", "rollback.verify",
    "--evidence", "planned-rollback-rehearsal.json",
    "--confirm-action",
    ...humanApproval("A downgraded start must not authorize the manual root"),
  ], /legacy start receipt without an immutable local-target baseline.*cannot authorize or complete another action/isu);
  const downgradedGate = run([
    "gate", "check",
    "--root", downgradedProject,
    "--story", "ST-LOCAL-PLANNED",
    "--strict",
    "--json",
  ]);
  assert.equal(downgradedGate.status, 1, downgradedGate.stderr || downgradedGate.stdout);
  assert.match(
    downgradedGate.stdout,
    /legacy start receipt without an immutable local-target baseline/isu,
  );

  const tamperedBaselineProject = `${project}-tampered-baseline`;
  fs.cpSync(project, tamperedBaselineProject, { recursive: true });
  tempProjects.add(tamperedBaselineProject);
  mutateDeliveryStartReceipt(
    tamperedBaselineProject,
    "AUT-LOCAL-PLANNED",
    "ST-LOCAL-PLANNED",
    (start) => {
      start.local_release_target_baseline.workspace_real_path =
        fs.realpathSync.native(tamperedBaselineProject);
      start.local_release_target_baseline.snapshot_hash = "0".repeat(64);
    },
  );
  const tamperedBaselineGate = run([
    "gate", "check",
    "--root", tamperedBaselineProject,
    "--story", "ST-LOCAL-PLANNED",
    "--strict",
    "--json",
  ]);
  assert.equal(
    tamperedBaselineGate.status,
    1,
    tamperedBaselineGate.stderr || tamperedBaselineGate.stdout,
  );
  assert.match(
    tamperedBaselineGate.stdout,
    /immutable local-target baseline is invalid: local target snapshot integrity is invalid/isu,
  );

  fs.rmSync(releaseRoot, { recursive: true, force: true });
  const buildCheckpoint = mustRunJson([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-LOCAL-PLANNED",
    "--action", "build.local",
  ]);
  const buildAuthorization = buildCheckpoint.status === "checkpoint_required"
    ? mustRunJson([
        "autonomy", "delivery", "action",
        "--root", project,
        "--id", "AUT-LOCAL-PLANNED",
        "--action", "build.local",
        "--confirm-action",
        ...humanApproval("Approve creation of this exact absent-at-start local target"),
      ])
    : buildCheckpoint;
  assert.equal(buildAuthorization.status, "authorized");
  assert.equal(
    buildAuthorization.action_receipt.action_details
      .local_target_build_precondition.snapshot.entries[0].status,
    "absent",
  );

  fs.mkdirSync(releaseOutput, { recursive: true });
  fs.writeFileSync(
    path.join(project, "planned-build-proof.json"),
    '{"root":"planned-release","built":true}\n',
    "utf8",
  );
  const failedBuild = mustRunJson([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-LOCAL-PLANNED",
    "--action", "build.local",
    "--outcome", "failed",
    "--authorization-receipt", buildAuthorization.action_receipt.id,
    "--evidence", "planned-build-proof.json",
  ]);
  assert.equal(failedBuild.action_receipt.outcome, "failed");
  assert.equal(
    failedBuild.action_receipt.action_details
      .local_target_build_completion.snapshot.entries[0].status,
    "directory",
  );

  const retryBuildCheckpoint = mustRunJson([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-LOCAL-PLANNED",
    "--action", "build.local",
  ]);
  const retryBuildAuthorization = retryBuildCheckpoint.status === "checkpoint_required"
    ? mustRunJson([
        "autonomy", "delivery", "action",
        "--root", project,
        "--id", "AUT-LOCAL-PLANNED",
        "--action", "build.local",
        "--confirm-action",
        ...humanApproval("Approve retry after the governed partial build failed"),
      ])
    : retryBuildCheckpoint;
  assert.equal(retryBuildAuthorization.status, "authorized");
  assert.equal(
    retryBuildAuthorization.action_receipt.action_details
      .local_target_build_precondition.predecessor_ref.receipt_ref.id,
    failedBuild.action_receipt.id,
  );
  assert.equal(
    retryBuildAuthorization.action_receipt.action_details
      .local_target_build_precondition.predecessor_ref.outcome,
    "failed",
  );

  const buildCompletionArgs = [
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-LOCAL-PLANNED",
    "--action", "build.local",
    "--outcome", "passed",
    "--authorization-receipt", retryBuildAuthorization.action_receipt.id,
    "--evidence", "planned-build-proof.json",
  ];
  mustFail(
    buildCompletionArgs,
    /Simulated interruption after action receipt persistence and before trace persistence/u,
    {
      env: {
        NODE_ENV: "test",
        AGENTIC_SDLC_TEST_DELIVERY_ACTION_FAILURE:
          "after-action-receipt-before-trace",
      },
    },
  );
  const recoveredBuild = mustRunJson(buildCompletionArgs);
  assert.equal(recoveredBuild.status, "completed");
  assert.equal(recoveredBuild.idempotent, true);
  assert.equal(
    recoveredBuild.action_receipt.action_details
      .local_target_build_completion.snapshot.entries[0].status,
    "directory",
  );

  const governedRollback = mustRunJson([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-LOCAL-PLANNED",
    "--action", "rollback.verify",
    "--evidence", "planned-rollback-rehearsal.json",
    "--confirm-action",
    ...humanApproval("Approve rollback rehearsal after governed target creation"),
  ]);
  assert.equal(
    governedRollback.action_receipt.action_details
      .local_target_materialization_ref.receipt_ref.id,
    recoveredBuild.action_receipt.id,
  );

  const relocatedProject = `${project}-relocated`;
  fs.cpSync(project, relocatedProject, { recursive: true });
  tempProjects.add(relocatedProject);
  mustFail([
    "autonomy", "delivery", "action",
    "--root", relocatedProject,
    "--id", "AUT-LOCAL-PLANNED",
    "--action", "rollback.verify",
    "--evidence", "planned-rollback-rehearsal.json",
    "--confirm-action",
    ...humanApproval("This relocated copy must not reuse target creation"),
  ], /local target snapshot belongs to a different workspace location/iu);

  const profileDriftProject = `${project}-profile-drift`;
  fs.cpSync(project, profileDriftProject, { recursive: true });
  tempProjects.add(profileDriftProject);
  const driftStartPath = path.join(
    profileDriftProject,
    ".sdlc",
    "autonomy",
    "executions",
    "AUT-LOCAL-PLANNED",
    "start.json",
  );
  const driftStart = JSON.parse(fs.readFileSync(driftStartPath, "utf8"));
  const driftBaseline = driftStart.local_release_target_baseline;
  driftBaseline.profile_ref.hash = "0".repeat(64);
  driftBaseline.workspace_real_path = fs.realpathSync.native(profileDriftProject);
  const {
    snapshot_hash: _driftSnapshotHash,
    hash_algorithm: _driftSnapshotAlgorithm,
    ...driftSnapshotBase
  } = driftBaseline;
  driftBaseline.snapshot_hash = crypto.createHash("sha256")
    .update(stableJson(driftSnapshotBase))
    .digest("hex");
  driftStart.receipt_hash = lifecycleReceiptHash(driftStart);
  fs.writeFileSync(driftStartPath, `${JSON.stringify(driftStart, null, 2)}\n`, "utf8");
  const driftTaskStartPath = path.join(
    profileDriftProject,
    ".sdlc",
    "stories",
    "ST-LOCAL-PLANNED",
    "task-start.json",
  );
  const driftTaskStart = JSON.parse(fs.readFileSync(driftTaskStartPath, "utf8"));
  driftTaskStart.delivery_start_receipt_ref.hash = driftStart.receipt_hash;
  fs.writeFileSync(
    driftTaskStartPath,
    `${JSON.stringify(driftTaskStart, null, 2)}\n`,
    "utf8",
  );
  mustFail([
    "autonomy", "delivery", "action",
    "--root", profileDriftProject,
    "--id", "AUT-LOCAL-PLANNED",
    "--action", "rollback.verify",
    "--evidence", "planned-rollback-rehearsal.json",
    "--confirm-action",
    ...humanApproval("Profile drift must not reuse target creation"),
  ], /local target snapshot is bound to another delivery profile/iu);
});

test("existing-root starts require governed build for absent child paths while active legacy starts fail closed", () => {
  for (const legacy of [false, true]) {
    const suffix = legacy ? "LEGACY" : "BASELINE";
    const project = tmpProject(`local-release-existing-root-${suffix.toLowerCase()}`);
    initializeAutonomyProject(project);
    createApprovedImplementationContract(project, {
      storyId: `ST-LOCAL-${suffix}`,
      contractId: `CONTRACT-LOCAL-${suffix}`,
      profileId: `AUT-LOCAL-${suffix}`,
    });
    const releaseRoot = path.join(project, "existing-release");
    const releaseOutput = path.join(releaseRoot, "app");
    fs.mkdirSync(releaseRoot, { recursive: true });
    assert.equal(fs.existsSync(releaseOutput), false);

    mustRunJson([
      "autonomy", "delivery", "propose",
      "--root", project,
      "--id", `AUT-LOCAL-${suffix}`,
      "--delivery", `LOCAL-RELEASE-${suffix}`,
      "--kind", "local_release",
      "--story", `ST-LOCAL-${suffix}`,
      "--contract", `CONTRACT-LOCAL-${suffix}`,
      "--requirement", "REQ-AUTONOMY",
      "--level", "checkpointed",
      "--target-root", releaseRoot,
      "--write-path", releaseOutput,
      "--smoke-test", '["node","--version"]',
      "--rollback", "Restore the previous brownfield release snapshot.",
    ]);
    mustRunJson([
      "autonomy", "delivery", "approve",
      "--root", project,
      "--id", `AUT-LOCAL-${suffix}`,
      "--phase", "implementation",
      ...humanApproval(`Approve exact ${suffix} brownfield local target`),
    ]);
    mustRunJson([
      "task", "start",
      "--root", project,
      "--intent-json", taskIntent(`ST-LOCAL-${suffix}`),
      "--delivery-profile", `AUT-LOCAL-${suffix}`,
      "--confirm-start",
      "--actor-type", "human",
    ]);
    const startPath = path.join(
      project,
      ".sdlc",
      "autonomy",
      "executions",
      `AUT-LOCAL-${suffix}`,
      "start.json",
    );
    const start = JSON.parse(fs.readFileSync(startPath, "utf8"));
    assert.equal(start.local_release_target_baseline.entries[0].status, "directory");
    assert.equal(start.local_release_target_baseline.entries[1].status, "absent");

    if (legacy) {
      start.schema_version = "delivery-start-receipt:v1";
      delete start.local_release_target_baseline;
      start.receipt_hash = lifecycleReceiptHash(start);
      fs.writeFileSync(startPath, `${JSON.stringify(start, null, 2)}\n`, "utf8");
      const taskStartPath = path.join(
        project,
        ".sdlc",
        "stories",
        `ST-LOCAL-${suffix}`,
        "task-start.json",
      );
      const taskStart = JSON.parse(fs.readFileSync(taskStartPath, "utf8"));
      taskStart.delivery_start_receipt_ref.hash = start.receipt_hash;
      fs.writeFileSync(taskStartPath, `${JSON.stringify(taskStart, null, 2)}\n`, "utf8");
    }

    fs.mkdirSync(releaseOutput, { recursive: true });
    fs.writeFileSync(
      path.join(project, "brownfield-rollback.json"),
      '{"root":"existing-release","restored":true}\n',
      "utf8",
    );
    const rollbackArgs = [
      "autonomy", "delivery", "action",
      "--root", project,
      "--id", `AUT-LOCAL-${suffix}`,
      "--action", "rollback.verify",
      "--evidence", "brownfield-rollback.json",
      "--confirm-action",
      ...humanApproval(`Approve exact ${suffix} rollback evidence`),
    ];
    if (legacy) {
      mustFail(
        rollbackArgs,
        /legacy start receipt without an immutable local-target baseline.*cannot authorize or complete another action/isu,
      );
      continue;
    }

    mustFail(
      rollbackArgs,
      /requires a completed passing build\.local receipt.*approved write path was absent at task start.*ungoverned mkdir is not a repair/isu,
    );
    mustFail([
      "autonomy", "delivery", "action",
      "--root", project,
      "--id", `AUT-LOCAL-${suffix}`,
      "--action", "build.local",
    ], /changed outside governed build\.local.*manual mkdir is not a repair/isu);

    fs.rmSync(releaseOutput, { recursive: true, force: true });
    const buildCheckpoint = mustRunJson([
      "autonomy", "delivery", "action",
      "--root", project,
      "--id", `AUT-LOCAL-${suffix}`,
      "--action", "build.local",
    ]);
    const buildAuthorization = buildCheckpoint.status === "checkpoint_required"
      ? mustRunJson([
          "autonomy", "delivery", "action",
          "--root", project,
          "--id", `AUT-LOCAL-${suffix}`,
          "--action", "build.local",
          "--confirm-action",
          ...humanApproval(`Approve exact ${suffix} child materialization`),
        ])
      : buildCheckpoint;
    assert.equal(
      buildAuthorization.action_receipt.action_details
        .local_target_build_precondition.snapshot.entries[0].status,
      "directory",
    );
    assert.equal(
      buildAuthorization.action_receipt.action_details
        .local_target_build_precondition.snapshot.entries[1].status,
      "absent",
    );

    fs.mkdirSync(releaseOutput, { recursive: true });
    fs.writeFileSync(
      path.join(project, "brownfield-build.json"),
      '{"root":"existing-release","child_built":true}\n',
      "utf8",
    );
    const buildCompletion = mustRunJson([
      "autonomy", "delivery", "action",
      "--root", project,
      "--id", `AUT-LOCAL-${suffix}`,
      "--action", "build.local",
      "--outcome", "passed",
      "--authorization-receipt", buildAuthorization.action_receipt.id,
      "--evidence", "brownfield-build.json",
    ]);

    const rollback = mustRunJson(rollbackArgs);
    assert.equal(rollback.status, "authorized");
    assert.equal(
      rollback.action_receipt.action_details
        .local_target_materialization_ref.receipt_ref.id,
      buildCompletion.action_receipt.id,
    );

    const releaseCheckpointArgs = [
      "autonomy", "delivery", "action",
      "--root", project,
      "--id", `AUT-LOCAL-${suffix}`,
      "--action", "release.local",
    ];
    if (!hostSupportsLocalSmokeSandbox()) {
      mustFail(
        releaseCheckpointArgs,
        /Local smoke-test execution requires a configured read-only, no-network sandbox on this host/u,
      );
      continue;
    }
    const releaseCheckpoint = mustRunJson(releaseCheckpointArgs);
    assert.equal(releaseCheckpoint.status, "checkpoint_required");
    const releaseAuthorization = mustRunJson([
      ...releaseCheckpointArgs,
      "--confirm-action",
      ...humanApproval(`Approve exact ${suffix} governed local release`),
    ]);
    assert.equal(
      releaseAuthorization.action_receipt.action_details
        .local_target_materialization_ref.receipt_ref.id,
      buildCompletion.action_receipt.id,
    );
  }
});

test("package-manager local smoke cannot fall back to the parent source package", {
  skip: hostSupportsLocalSmokeSandbox()
    ? false
    : "requires a supported local smoke sandbox",
}, () => {
  const project = tmpProject("local-release-package-boundary");
  initializeAutonomyProject(project);
  createApprovedImplementationContract(project, {
    storyId: "ST-LOCAL-PACKAGE",
    contractId: "CONTRACT-LOCAL-PACKAGE",
    profileId: "AUT-LOCAL-PACKAGE",
  });

  const releaseRoot = path.join(project, "local-package-release");
  const releaseOutput = path.join(releaseRoot, "app");
  fs.mkdirSync(releaseOutput, { recursive: true });
  fs.writeFileSync(path.join(project, "package.json"), `${JSON.stringify({
    name: "source-project-only",
    private: true,
    scripts: { "smoke:local": "node --version" },
  }, null, 2)}\n`);

  mustRunJson([
    "autonomy", "delivery", "propose",
    "--root", project,
    "--id", "AUT-LOCAL-PACKAGE",
    "--delivery", "LOCAL-RELEASE-PACKAGE",
    "--kind", "local_release",
    "--story", "ST-LOCAL-PACKAGE",
    "--contract", "CONTRACT-LOCAL-PACKAGE",
    "--requirement", "REQ-AUTONOMY",
    "--level", "checkpointed",
    "--target-root", releaseRoot,
    "--write-path", releaseOutput,
    "--smoke-test", '["npm","run","smoke:local"]',
    "--rollback", "Remove the local package release and restore its previous snapshot.",
  ]);
  mustRunJson([
    "autonomy", "delivery", "approve",
    "--root", project,
    "--id", "AUT-LOCAL-PACKAGE",
    "--phase", "implementation",
    ...humanApproval("Approve the exact package-manager smoke boundary"),
  ]);
  mustRunJson([
    "task", "start",
    "--root", project,
    "--intent-json", taskIntent("ST-LOCAL-PACKAGE"),
    "--delivery-profile", "AUT-LOCAL-PACKAGE",
  ]);
  mustRunJson([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-LOCAL-PACKAGE",
    "--action", "release.local",
    "--confirm-action",
    ...humanApproval("Approve this exact local package release"),
  ]);
  fs.writeFileSync(path.join(releaseOutput, "release-proof.txt"), "release output exists\n");

  mustFail([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-LOCAL-PACKAGE",
    "--action", "release.local",
    "--outcome", "passed",
    "--evidence", "local-package-release/app/release-proof.txt",
    "--smoke-test", '["npm","run","smoke:local"]',
    "--rollback", "Remove the local package release and restore its previous snapshot.",
  ], /requires a real package\.json in the governed smoke working directory.*parent project packages are never used/isu);
});

test("local smoke proposals reject shells, dispatchers, package execution, and inline code", () => {
  const project = tmpProject("local-smoke-proposal-boundary");
  initializeAutonomyProject(project);
  createApprovedImplementationContract(project, {
    storyId: "ST-LOCAL-SMOKE-PROPOSAL",
    contractId: "CONTRACT-LOCAL-SMOKE-PROPOSAL",
    profileId: "AUT-LOCAL-SMOKE-PROPOSAL",
  });
  const releaseRoot = path.join(project, "local-release");
  const releaseOutput = path.join(releaseRoot, "app");
  const base = [
    "autonomy", "delivery", "propose",
    "--root", project,
    "--id", "AUT-LOCAL-SMOKE-PROPOSAL",
    "--delivery", "LOCAL-SMOKE-PROPOSAL",
    "--kind", "local_release",
    "--story", "ST-LOCAL-SMOKE-PROPOSAL",
    "--contract", "CONTRACT-LOCAL-SMOKE-PROPOSAL",
    "--requirement", "REQ-AUTONOMY",
    "--level", "checkpointed",
    "--target-root", releaseRoot,
    "--write-path", releaseOutput,
    "--rollback", "Remove the exact local smoke fixture.",
  ];
  const rejected = [
    { command: ["/bin/dash", "-c", "exit 0"], pattern: /shell executable/iu },
    { command: ["/usr/bin/env", "node", "--version"], pattern: /dispatcher/iu },
    { command: ["node", "--eval=process.exit(0)"], pattern: /inline code/iu },
    { command: ["python3", "-cprint('unsafe')"], pattern: /inline code/iu },
    { command: ["npx", "unreviewed-package"], pattern: /package dispatcher/iu },
    { command: ["npm", "exec", "unreviewed-package"], pattern: /must use 'test' or 'run/iu },
  ];
  for (const scenario of rejected) {
    mustFail(
      [...base, "--smoke-test", JSON.stringify(scenario.command)],
      scenario.pattern,
    );
  }
  assert.equal(
    fs.existsSync(path.join(project, ".sdlc", "autonomy", "proposals", "AUT-LOCAL-SMOKE-PROPOSAL.json")),
    false,
  );
});

test("release.local rejects resolved shells, indirect loaders, and payloads outside the artifact before authorization", {
  skip: hostSupportsLocalSmokeSandbox() && process.platform !== "win32"
    ? false
    : "requires a POSIX host with a supported local smoke sandbox",
  timeout: 240_000,
}, () => {
  const externalRoot = tmpProject("local-smoke-external-payload");
  const externalNodePayload = path.join(externalRoot, "external-smoke.mjs");
  const externalRequirePayload = path.join(externalRoot, "external-require.cjs");
  const disguisedShell = path.join(externalRoot, "reviewed-runner");
  fs.writeFileSync(externalNodePayload, "process.stdout.write('external\\n');\n", "utf8");
  fs.writeFileSync(externalRequirePayload, "module.exports = {};\n", "utf8");
  fs.symlinkSync("/bin/sh", disguisedShell);

  const scenarios = [
    {
      suffix: "EXTERNAL-NODE-PAYLOAD",
      command: [process.execPath, externalNodePayload],
      smokeSource: "process.stdout.write('unused\\n');\n",
      pattern: /payload .* resolves outside the released artifact/isu,
    },
    {
      suffix: "EXTERNAL-NODE-REQUIRE",
      command: [process.execPath, `--require=${externalRequirePayload}`, "--version"],
      smokeSource: "process.stdout.write('unused\\n');\n",
      pattern: /loader option .* is not allowed/isu,
    },
    {
      suffix: "RESOLVED-SHELL",
      command: [disguisedShell, "-c", "exit 0"],
      smokeSource: "process.stdout.write('unused\\n');\n",
      pattern: /resolves to shell/isu,
    },
    {
      suffix: "SHEBANG-DASH",
      command: ["./smoke-shebang-dash.mjs"],
      smokeSource: "#!/bin/dash\nexit 0\n",
      pattern: /resolves to shell/isu,
    },
  ];
  if (spawnSync("python3", ["--version"], {
    encoding: "utf8",
    timeout: 30_000,
  }).status === 0) {
    const externalPythonPayload = path.join(externalRoot, "external-smoke.py");
    fs.writeFileSync(externalPythonPayload, "print('external')\n", "utf8");
    scenarios.push({
      suffix: "EXTERNAL-PYTHON-PAYLOAD",
      command: ["python3", externalPythonPayload],
      smokeSource: "process.stdout.write('unused\\n');\n",
      pattern: /payload .* resolves outside the released artifact/isu,
    });
    scenarios.push({
      suffix: "PYTHON-MODULE-CONCATENATED",
      command: ["python3", "-mjson.tool"],
      smokeSource: "process.stdout.write('unused\\n');\n",
      pattern: /loader option .* is not allowed/isu,
    });
    scenarios.push({
      suffix: "PYTHON-MODULE-SEPARATE",
      command: ["python3", "-m", "json.tool"],
      smokeSource: "process.stdout.write('unused\\n');\n",
      pattern: /loader option .* is not allowed/isu,
    });
  }

  for (const scenario of scenarios) {
    const fixture = prepareMacOsLocalSmokeRelease({
      suffix: scenario.suffix,
      smokeSource: scenario.smokeSource,
      smokeCommandArgv: scenario.command,
      authorizeRelease: false,
    });
    mustFail([
      "autonomy", "delivery", "action",
      "--root", fixture.project,
      "--id", fixture.profileId,
      "--action", "release.local",
      "--confirm-action",
      ...humanApproval(`Reject ${scenario.suffix.toLowerCase()} release boundary`),
    ], scenario.pattern);
    assert.equal(localReleaseActionReceipts(fixture.project, fixture.profileId).length, 0);
    assert.equal(localReleaseAttemptReceipts(fixture.project, fixture.profileId).length, 0);
    assert.equal(
      fs.existsSync(path.join(
        fixture.project,
        ".sdlc",
        "autonomy",
        "executions",
        fixture.profileId,
        "close.json",
      )),
      false,
    );
  }
});

test("release.local binds a deferred artifact entrypoint before its write-ahead attempt", {
  skip: hostSupportsLocalSmokeSandbox()
    ? false
    : "requires a supported local smoke sandbox",
  timeout: 180_000,
}, () => {
  const suffix = "DEFERRED-ENTRYPOINT";
  const smokeFileName = `smoke-${suffix.toLowerCase()}.mjs`;
  const fixture = prepareMacOsLocalSmokeRelease({
    suffix,
    smokeSource: "process.stdout.write('deferred-entrypoint-ok\\n');\n",
    smokeCommandArgv: ["node", smokeFileName],
    deferSmokeMaterialization: true,
  });
  assert.equal(fs.existsSync(fixture.smokeFile), false);
  const authorization = fixture.releaseAuthorization.action_receipt;
  assert.equal(authorization.schema_version, "delivery-action-receipt:v3");
  const integrity = authorization.action_details.local_release_integrity;
  assert.equal(integrity.schema_version, "local-release-integrity:v2");
  assert.equal(
    integrity.smoke_execution_policy.schema_version,
    "local-smoke-sandbox-policy:v2",
  );
  const [launcher] = integrity.smoke_execution_policy.launchers;
  assert.equal(launcher.launcher_kind, "direct-interpreter");
  assert.deepEqual(launcher.payload_bindings, [{
    argument_index: 1,
    argument: smokeFileName,
    origin: "interpreter-entrypoint",
    source: "interpreter-entrypoint",
    resolved_path: fixture.smokeFile,
    governed_write_path: fixture.releaseOutput,
    binding: "artifact-manifest-bound",
  }]);

  fs.writeFileSync(fixture.smokeFile, fixture.smokeSource, "utf8");
  const completed = mustRunJson(fixture.completionArgs, { timeout: 90_000 });
  assert.equal(completed.action_receipt.schema_version, "delivery-action-receipt:v3");
  assert.equal(
    completed.action_receipt.local_release_verification.integrity.schema_version,
    "local-release-completion-integrity:v2",
  );
  assert.equal(completed.action_receipt.attempt_receipt_ref.id.length > 0, true);
  assert.equal(localReleaseAttemptReceipts(fixture.project, fixture.profileId).length, 1);
  assert.equal(completed.lifecycle_status, "terminal");

  const authorizationPath = path.join(
    fixture.project,
    ".sdlc",
    "autonomy",
    "actions",
    `${authorization.id}.json`,
  );
  const downgradedAuthorization = JSON.parse(
    fs.readFileSync(authorizationPath, "utf8"),
  );
  delete downgradedAuthorization.action_details.local_release_integrity;
  downgradedAuthorization.receipt_hash = lifecycleReceiptHash(downgradedAuthorization);
  fs.writeFileSync(
    authorizationPath,
    `${JSON.stringify(downgradedAuthorization, null, 2)}\n`,
    "utf8",
  );
  mustFail([
    "gate", "check",
    "--root", fixture.project,
    "--scope", "story",
    "--story", `ST-MACOS-SMOKE-${suffix}`,
    "--strict",
    "--json",
  ], /validation failed.*local_release_integrity/isu);
});

test("native executable flags are not misclassified as interpreter loaders", {
  skip: hostSupportsLocalSmokeSandbox() && process.platform !== "win32"
    ? false
    : "requires a POSIX host with a supported local smoke sandbox",
  timeout: 120_000,
}, () => {
  const fixture = prepareMacOsLocalSmokeRelease({
    suffix: "NATIVE-FLAG",
    smokeSource: "process.stdout.write('unused\\n');\n",
    smokeCommandArgv: [resolveHostCommand("true"), "--import", "-r"],
  });
  const [launcher] = fixture.releaseAuthorization.action_receipt.action_details
    .local_release_integrity.smoke_execution_policy.launchers;
  assert.equal(launcher.launcher_kind, "attested-native-executable");
  assert.deepEqual(launcher.payload_bindings, []);
  const completed = mustRunJson(fixture.completionArgs, { timeout: 90_000 });
  assert.equal(completed.action_receipt.outcome, "passed");
  assert.equal(completed.lifecycle_status, "terminal");
});

test("interpreter options with separate values preserve the governed entrypoint", {
  skip: hostSupportsLocalSmokeSandbox()
    ? false
    : "requires a supported local smoke sandbox",
  timeout: 180_000,
}, () => {
  const scenarios = [{
    suffix: "NODE-OPTION-VALUE",
    command: (smokeFileName) => [
      process.execPath,
      "--conditions",
      "development",
      "--title",
      "unit/foo",
      smokeFileName,
    ],
    smokeSource: "process.stdout.write('node-option-value-ok\\n');\n",
  }];
  if (spawnSync("python3", ["--version"], {
    encoding: "utf8",
    timeout: 30_000,
  }).status === 0) {
    scenarios.push({
      suffix: "PYTHON-OPTION-VALUE",
      command: (smokeFileName) => ["python3", "-W", "ignore", smokeFileName],
      smokeSource: "print('python-option-value-ok')\n",
    });
  }
  for (const scenario of scenarios) {
    const smokeFileName = `smoke-${scenario.suffix.toLowerCase()}.mjs`;
    const fixture = prepareMacOsLocalSmokeRelease({
      suffix: scenario.suffix,
      smokeSource: scenario.smokeSource,
      smokeCommandArgv: scenario.command(smokeFileName),
    });
    const [launcher] = fixture.releaseAuthorization.action_receipt.action_details
      .local_release_integrity.smoke_execution_policy.launchers;
    assert.equal(launcher.launcher_kind, "direct-interpreter");
    assert.equal(launcher.payload_bindings.length, 1);
    assert.equal(launcher.payload_bindings[0].argument, smokeFileName);
    assert.equal(launcher.payload_bindings[0].origin, "interpreter-entrypoint");
    const completed = mustRunJson(fixture.completionArgs, { timeout: 90_000 });
    assert.equal(completed.action_receipt.outcome, "passed");
    assert.equal(completed.lifecycle_status, "terminal");
  }
});

test("a manually failed v3 local release consumes authorization without inventing a smoke attempt", {
  skip: hostSupportsLocalSmokeSandbox()
    ? false
    : "requires a supported local smoke sandbox",
  timeout: 180_000,
}, () => {
  const fixture = prepareMacOsLocalSmokeRelease({
    suffix: "MANUAL-FAILED-V3",
    smokeSource: "process.stdout.write('must-not-run\\n');\n",
  });
  const failedArgs = [...fixture.completionArgs];
  failedArgs[failedArgs.indexOf("passed")] = "failed";
  const failed = mustRunJson(failedArgs);
  assert.equal(failed.action_receipt.schema_version, "delivery-action-receipt:v3");
  assert.equal(failed.action_receipt.outcome, "failed");
  assert.equal(failed.action_receipt.local_release_verification, null);
  assert.equal(Object.hasOwn(failed.action_receipt, "attempt_receipt_ref"), false);
  assert.equal(localReleaseAttemptReceipts(fixture.project, fixture.profileId).length, 0);
  mustFail(
    fixture.completionArgs,
    /already consumed|already recorded as failed/iu,
    { timeout: 90_000 },
  );
  assert.equal(
    localReleaseActionReceipts(fixture.project, fixture.profileId)
      .filter((receipt) => receipt.status === "completed").length,
    1,
  );
});

test("macOS release.local smoke denies loopback, wildcard, LAN bind, and external outbound", {
  skip: process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec")
    ? false
    : "requires macOS sandbox-exec",
  timeout: 120_000,
}, async () => {
  const hostServer = createNetServer((socket) => socket.end("HOST_SECRET"));
  await new Promise((resolve, reject) => {
    hostServer.once("error", reject);
    hostServer.listen(0, "127.0.0.1", resolve);
  });
  const hostPort = hostServer.address().port;
  try {
    const fixture = prepareMacOsLocalSmokeRelease({
      suffix: "BOUNDARY",
      smokeSource: `import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer, createConnection } from "node:net";
import os from "node:os";

async function bindResult(host) {
  const server = createServer();
  const result = await new Promise((resolve) => {
    server.once("error", (error) => resolve(error.code || "UNKNOWN_ERROR"));
    server.listen(0, host, () => resolve("BOUND"));
  });
  if (result === "BOUND") {
    await new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
  return result;
}

const lanAddress = Object.values(os.networkInterfaces())
  .flat()
  .find((entry) => entry && entry.family === "IPv4" && !entry.internal)
  ?.address;
const bindHosts = ["127.0.0.1", "::1", "0.0.0.0", "::", lanAddress].filter(Boolean);
for (const host of bindHosts) {
  assert.equal(await bindResult(host), "EPERM", "unexpected bind capability for " + host);
}

async function connectionResult(host, port) {
  return new Promise((resolve) => {
    const chunks = [];
    const socket = createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve("TIMEOUT");
    }, 2_000);
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.once("end", () => {
      clearTimeout(timer);
      resolve("CONNECTED:" + Buffer.concat(chunks).toString("utf8"));
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      resolve(error.code || "UNKNOWN_ERROR");
    });
  });
}

assert.equal(await connectionResult("127.0.0.1", ${hostPort}), "EPERM");
assert.equal(await connectionResult("1.1.1.1", 443), "EPERM");

let writeResult = "WROTE";
try {
  fs.writeFileSync(new URL("./forbidden-write.txt", import.meta.url), "forbidden");
} catch (error) {
  writeResult = error.code || "UNKNOWN_ERROR";
}
assert.match(writeResult, /^(?:EACCES|EPERM)$/u);
`,
    });

    assert.equal(fixture.proposal.review.smoke_execution_boundary.filesystem_writes, "denied");
    assert.equal(fixture.proposal.review.smoke_execution_boundary.external_network, "denied");
    assert.equal(fixture.proposal.review.smoke_execution_boundary.loopback_network, "denied");
    assert.equal(fixture.proposal.review.smoke_execution_boundary.listener_based_smoke, "unsupported");
    assert.equal(fixture.proposal.review.smoke_execution_boundary.confidentiality_isolation, "not_provided");
    assert.equal(
      fixture.proposal.review.smoke_execution_boundary.transitive_code_attestation,
      "not_provided",
    );
    assert.equal(
      fixture.proposal.review.smoke_execution_boundary.explicit_entrypoint_binding,
      "artifact_manifest_bound",
    );
    assert.match(
      fixture.proposal.human_guidance.impact,
      /portable check must not depend on listeners or connections/iu,
    );
    const completedResult = await runAsync([...fixture.completionArgs, "--json"], { timeout: 90_000 });
    assert.equal(completedResult.status, 0, completedResult.stdout + completedResult.stderr);
    const completed = JSON.parse(completedResult.stdout);
    assert.equal(completed.status, "completed");
    assert.equal(completed.lifecycle_status, "terminal");
    const [smokeReceipt] = completed.action_receipt.local_release_verification.smoke_test_receipts;
    assert.equal(smokeReceipt.outcome, "passed");
    assert.equal(smokeReceipt.exit_code, 0);
    assert.equal(smokeReceipt.signal, null);
    assert.equal(smokeReceipt.error_code, null);
    assert.equal(smokeReceipt.sandbox, "macos-sandbox-exec-readonly-no-network");
    assert.match(smokeReceipt.stdout_sha256, /^[a-f0-9]{64}$/u);
    assert.match(smokeReceipt.stderr_sha256, /^[a-f0-9]{64}$/u);
    assert.equal(
      completed.action_receipt.authorization_receipt_ref.id,
      fixture.releaseAuthorization.action_receipt.id,
    );
    assert.equal(
      fs.existsSync(path.join(
        fixture.project,
        ".sdlc",
        "autonomy",
        "executions",
        fixture.profileId,
        "close.json",
      )),
      true,
    );
  } finally {
    await new Promise((resolve, reject) =>
      hostServer.close((error) => error ? reject(error) : resolve()));
  }
});

test("macOS listener-based local smoke fails closed with safe actionable guidance", {
  skip: process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec")
    ? false
    : "requires macOS sandbox-exec",
  timeout: 120_000,
}, () => {
  const fixture = prepareMacOsLocalSmokeRelease({
    suffix: "LISTENER",
    smokeSource: `import { createServer } from "node:http";

const server = createServer((_request, response) => response.end("ok"));
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
`,
  });

  const failed = run([...fixture.completionArgs, "--json"], { timeout: 90_000 });
  assert.equal(failed.error, undefined, failed.error?.message);
  assert.equal(failed.signal, null, failed.stderr);
  assert.notEqual(failed.status, 0, failed.stdout);
  const failure = JSON.parse(failed.stdout.trim() || failed.stderr.trim());
  assert.equal(failure.error.code, "USER_ERROR");
  assert.match(
    failure.error.message,
    /current runner denies writes and external network.*loopback policy is denied.*exercise its exported handler in-process/isu,
  );
  const marker = "Safe smoke diagnostics: ";
  const markerIndex = failure.error.message.indexOf(marker);
  assert.notEqual(markerIndex, -1, failure.error.message);
  const diagnostics = JSON.parse(failure.error.message.slice(markerIndex + marker.length));
  assert.equal(diagnostics.length, 1);
  assert.deepEqual(diagnostics[0].command, ["node", "smoke-listener.mjs"]);
  assert.equal(diagnostics[0].sandbox, "macos-sandbox-exec-readonly-no-network");
  assert.equal(diagnostics[0].exit_code, 1);
  assert.equal(diagnostics[0].signal, null);
  assert.equal(diagnostics[0].error_code, null);
  assert.equal(
    diagnostics[0].stdout_sha256,
    crypto.createHash("sha256").update("").digest("hex"),
  );
  assert.match(diagnostics[0].stderr_sha256, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(failure.error.message, /\bEPERM\b|listen E(?:PERM|ACCES)|node:net/iu);

  const status = mustRunJson([
    "autonomy", "delivery", "status",
    "--root", fixture.project,
    "--id", fixture.profileId,
  ]);
  assert.equal(status.delivery_profiles[0].lifecycle_status, "started");
  assert.equal(status.delivery_profiles[0].delivery_status, "started");
  assert.equal(
    fs.existsSync(path.join(
      fixture.project,
      ".sdlc",
      "autonomy",
      "executions",
      fixture.profileId,
      "close.json",
    )),
    false,
  );
});

test("release.local write-ahead attempts consume failed smoke authorization and bind the released artifact", {
  skip: hostSupportsLocalSmokeSandbox()
    ? false
    : "requires a supported local smoke sandbox",
  timeout: 180_000,
}, () => {
  const fixture = prepareMacOsLocalSmokeRelease({
    suffix: "ATTEMPT-FAILED",
    smokeSource: `import assert from "node:assert/strict";
import fs from "node:fs";

assert.equal(
  fs.readFileSync(new URL("./release-state.txt", import.meta.url), "utf8"),
  "ready\\n",
  "LOCAL_RELEASE_NOT_READY",
);
`,
  });
  const statePath = path.join(fixture.releaseOutput, "release-state.txt");

  // Artifact bytes are intentionally not frozen at authorization: the governed
  // build may materialize or update them before completion starts.
  fs.writeFileSync(statePath, "broken\n", "utf8");
  mustFail(
    fixture.completionArgs,
    /Failed completion receipt: .*Safe smoke diagnostics:/su,
    { timeout: 90_000 },
  );

  const failedAttempts = localReleaseAttemptReceipts(fixture.project, fixture.profileId);
  assert.equal(failedAttempts.length, 1);
  const [failedAttempt] = failedAttempts;
  assert.equal(failedAttempt.schema_version, "delivery-action-attempt-receipt:v1");
  assert.equal(
    failedAttempt.authorization_receipt_ref.id,
    fixture.releaseAuthorization.action_receipt.id,
  );
  assert.match(failedAttempt.receipt_hash, /^[a-f0-9]{64}$/u);

  const failedCompletions = localReleaseActionReceipts(fixture.project, fixture.profileId)
    .filter((receipt) =>
      receipt.status === "completed"
      && receipt.authorization_receipt_ref?.id
        === fixture.releaseAuthorization.action_receipt.id);
  assert.equal(failedCompletions.length, 1);
  const [failedCompletion] = failedCompletions;
  assert.equal(failedCompletion.outcome, "failed");
  assert.equal(failedCompletion.local_release_verification.outcome, "failed");
  assert.equal(failedCompletion.attempt_receipt_ref.id, failedAttempt.id);
  assert.equal(failedCompletion.attempt_receipt_ref.hash, failedAttempt.receipt_hash);
  assert.equal(
    failedCompletion.local_release_verification.integrity.artifact_stable_during_smoke,
    true,
  );
  assert.ok(
    failedCompletion.local_release_verification.smoke_test_receipts
      .some((receipt) => receipt.outcome === "failed" && receipt.exit_code !== 0),
  );

  const consumedRetry = run([...fixture.completionArgs, "--json"], { timeout: 90_000 });
  assert.equal(consumedRetry.error, undefined, consumedRetry.error?.message);
  assert.equal(consumedRetry.signal, null, consumedRetry.stderr);
  assert.notEqual(consumedRetry.status, 0, consumedRetry.stdout);
  assert.equal(localReleaseAttemptReceipts(fixture.project, fixture.profileId).length, 1);
  assert.equal(
    localReleaseActionReceipts(fixture.project, fixture.profileId)
      .filter((receipt) =>
        receipt.status === "completed"
        && receipt.authorization_receipt_ref?.id
          === fixture.releaseAuthorization.action_receipt.id)
      .length,
    1,
  );

  const freshAuthorization = mustRunJson([
    "autonomy", "delivery", "action",
    "--root", fixture.project,
    "--id", fixture.profileId,
    "--action", "release.local",
    "--confirm-action",
    ...humanApproval("Approve a fresh local release attempt after correcting the failed smoke"),
  ]);
  assert.notEqual(
    freshAuthorization.action_receipt.id,
    fixture.releaseAuthorization.action_receipt.id,
  );
  assert.equal(
    freshAuthorization.action_receipt.action_details.local_release_integrity.integrity_hash,
    fixture.releaseAuthorization.action_receipt.action_details.local_release_integrity.integrity_hash,
  );

  // This change occurs after the fresh authorization and must be accepted:
  // only the exact pre/post-smoke manifest belongs to the completion.
  fs.writeFileSync(statePath, "ready\n", "utf8");
  const completed = mustRunJson(
    fixture.completionArgsFor(freshAuthorization.action_receipt.id),
    { timeout: 90_000 },
  );
  assert.equal(completed.status, "completed");
  assert.equal(completed.lifecycle_status, "terminal");
  assert.equal(completed.action_receipt.outcome, "passed");
  assert.equal(
    completed.action_receipt.authorization_receipt_ref.id,
    freshAuthorization.action_receipt.id,
  );
  assert.equal(
    completed.action_receipt.local_release_verification.integrity.artifact_stable_during_smoke,
    true,
  );
  assert.equal(
    completed.action_receipt.local_release_verification.integrity
      .pre_smoke_artifact_manifest.manifest_hash,
    completed.action_receipt.local_release_verification.integrity
      .post_smoke_artifact_manifest.manifest_hash,
  );
  const successfulAttempt = localReleaseAttemptReceipts(fixture.project, fixture.profileId)
    .find((attempt) =>
      attempt.authorization_receipt_ref.id === freshAuthorization.action_receipt.id);
  assert.ok(successfulAttempt);
  assert.equal(completed.action_receipt.attempt_receipt_ref.id, successfulAttempt.id);
  assert.equal(
    completed.action_receipt.attempt_receipt_ref.hash,
    successfulAttempt.receipt_hash,
  );

  const beforeDriftGate = run([
    "gate", "check",
    "--root", fixture.project,
    "--scope", "story",
    "--story", "ST-MACOS-SMOKE-ATTEMPT-FAILED",
    "--strict",
    "--json",
  ]);
  assert.ok([0, 1].includes(beforeDriftGate.status), beforeDriftGate.stderr);
  const beforeDriftReport = JSON.parse(beforeDriftGate.stdout);
  assert.equal(
    beforeDriftReport.errors.some((error) =>
      /failed release integrity|released artifact changed after its smoke-tested completion/iu
        .test(error)),
    false,
    beforeDriftGate.stdout,
  );

  fs.writeFileSync(statePath, "changed-after-release\n", "utf8");
  mustFail([
    "gate", "check",
    "--root", fixture.project,
    "--scope", "story",
    "--story", "ST-MACOS-SMOKE-ATTEMPT-FAILED",
    "--strict",
    "--json",
  ], /released artifact changed after its smoke-tested completion/iu);
});

test("release.local shebang runtime drift is blocked before spawn and requires fresh authorization", {
  skip: hostSupportsLocalSmokeSandbox() && process.platform !== "win32"
    ? false
    : "requires a POSIX host with a supported local smoke sandbox",
  timeout: 180_000,
}, () => {
  const runtimeBin = tmpProject("local-smoke-runtime-bin");
  const hostNode = fs.realpathSync.native(process.execPath);
  const replacementNode = path.join(runtimeBin, "node-v2");
  try {
    fs.linkSync(hostNode, replacementNode);
  } catch {
    fs.copyFileSync(hostNode, replacementNode);
  }
  fs.chmodSync(replacementNode, 0o755);
  const replacementNodeRealPath = fs.realpathSync.native(replacementNode);
  const governedNode = path.join(runtimeBin, "node");
  fs.symlinkSync(hostNode, governedNode);
  const controlledPath = [runtimeBin, process.env.PATH].filter(Boolean).join(path.delimiter);
  const commandOptions = { env: { PATH: controlledPath } };

  const fixture = prepareMacOsLocalSmokeRelease({
    suffix: "SHEBANG-RUNTIME",
    smokeSource: `#!/usr/bin/env node
process.stdout.write("shebang-runtime-ok\\n");
`,
    smokeCommandArgv: ["./smoke-shebang-runtime.mjs"],
    commandOptions,
  });
  const authorizedPolicy = fixture.releaseAuthorization.action_receipt
    .action_details.local_release_integrity.smoke_execution_policy;
  assert.equal(authorizedPolicy.launchers.length, 1);
  const [authorizedLauncher] = authorizedPolicy.launchers;
  assert.deepEqual(authorizedLauncher.command, ["./smoke-shebang-runtime.mjs"]);
  assert.equal(
    authorizedLauncher.command_executable,
    fs.realpathSync.native(fixture.smokeFile),
  );
  assert.equal(authorizedLauncher.runtime_executable, hostNode);
  assert.match(authorizedLauncher.runtime_executable_sha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(authorizedLauncher.interpreter, {
    source: "env-path",
    requested: "node",
    resolved: hostNode,
    shebang_sha256: crypto.createHash("sha256")
      .update("/usr/bin/env node")
      .digest("hex"),
  });
  const runtimeArgIndex = authorizedLauncher.wrapper_args.indexOf(hostNode);
  assert.notEqual(runtimeArgIndex, -1);
  assert.equal(
    authorizedLauncher.wrapper_args[runtimeArgIndex + 1],
    fs.realpathSync.native(fixture.smokeFile),
  );
  assert.equal(authorizedLauncher.wrapper_args.includes("/usr/bin/env"), false);

  fs.unlinkSync(governedNode);
  fs.symlinkSync(replacementNode, governedNode);
  assert.equal(
    [runtimeBin, process.env.PATH].filter(Boolean).join(path.delimiter),
    controlledPath,
  );
  const governedNodeStat = fs.statSync(governedNode);
  const replacementNodeStat = fs.statSync(replacementNodeRealPath);
  assert.equal(String(governedNodeStat.dev), String(replacementNodeStat.dev));
  assert.equal(String(governedNodeStat.ino), String(replacementNodeStat.ino));

  const blocked = run([...fixture.completionArgs, "--json"], {
    ...commandOptions,
    timeout: 90_000,
  });
  assert.equal(blocked.error, undefined, blocked.error?.message);
  assert.equal(blocked.signal, null, blocked.stderr);
  assert.notEqual(blocked.status, 0, blocked.stdout);
  assert.equal(localReleaseAttemptReceipts(fixture.project, fixture.profileId).length, 0);
  assert.equal(
    localReleaseActionReceipts(fixture.project, fixture.profileId)
      .some((receipt) =>
        receipt.status === "completed"
        && receipt.authorization_receipt_ref?.id
          === fixture.releaseAuthorization.action_receipt.id),
    false,
  );

  const freshAuthorization = mustRunJson([
    "autonomy", "delivery", "action",
    "--root", fixture.project,
    "--id", fixture.profileId,
    "--action", "release.local",
    "--confirm-action",
    ...humanApproval("Approve the changed exact shebang runtime"),
  ], commandOptions);
  const freshLauncher = freshAuthorization.action_receipt.action_details
    .local_release_integrity.smoke_execution_policy.launchers[0];
  assert.equal(freshLauncher.runtime_executable, replacementNodeRealPath);
  assert.equal(
    freshLauncher.runtime_executable_sha256,
    authorizedLauncher.runtime_executable_sha256,
  );
  assert.notEqual(freshLauncher.launcher_hash, authorizedLauncher.launcher_hash);

  const completed = mustRunJson(
    fixture.completionArgsFor(freshAuthorization.action_receipt.id),
    { ...commandOptions, timeout: 90_000 },
  );
  assert.equal(completed.lifecycle_status, "terminal");
  assert.equal(completed.action_receipt.outcome, "passed");
  assert.equal(localReleaseAttemptReceipts(fixture.project, fixture.profileId).length, 1);
});

test("release.local rejects a nested shebang runtime before authorization", {
  skip: hostSupportsLocalSmokeSandbox() && process.platform !== "win32"
    ? false
    : "requires a POSIX host with a supported local smoke sandbox",
  timeout: 120_000,
}, () => {
  const runtimeBin = tmpProject("local-smoke-nested-runtime-bin");
  const nestedNode = path.join(runtimeBin, "node");
  fs.writeFileSync(
    nestedNode,
    `#!/bin/sh
exec ${JSON.stringify(fs.realpathSync.native(process.execPath))} "$@"
`,
    "utf8",
  );
  fs.chmodSync(nestedNode, 0o755);
  const commandOptions = {
    env: {
      PATH: [runtimeBin, process.env.PATH].filter(Boolean).join(path.delimiter),
    },
  };
  const fixture = prepareMacOsLocalSmokeRelease({
    suffix: "NESTED-SHEBANG-RUNTIME",
    smokeSource: `#!/usr/bin/env node
process.stdout.write("must-not-run\\n");
`,
    smokeCommandArgv: ["./smoke-nested-shebang-runtime.mjs"],
    commandOptions,
    authorizeRelease: false,
  });

  mustFail([
    "autonomy", "delivery", "action",
    "--root", fixture.project,
    "--id", fixture.profileId,
    "--action", "release.local",
    "--confirm-action",
    ...humanApproval("Attempt to authorize a nested shebang runtime"),
  ], /resolves to nested script interpreter.*native runtime executable/isu, commandOptions);
  assert.equal(
    localReleaseActionReceipts(fixture.project, fixture.profileId).length,
    0,
  );
  assert.equal(
    localReleaseAttemptReceipts(fixture.project, fixture.profileId).length,
    0,
  );
});

test("release.local failed completion retry repairs its trace without rerunning smoke", {
  skip: hostSupportsLocalSmokeSandbox()
    ? false
    : "requires a supported local smoke sandbox",
  timeout: 180_000,
}, () => {
  const suffix = "ATTEMPT-FAILED-TRACE";
  const storyId = `ST-MACOS-SMOKE-${suffix}`;
  const fixture = prepareMacOsLocalSmokeRelease({
    suffix,
    smokeSource: `process.stderr.write("EXPECTED_SMOKE_FAILURE\\n");
process.exit(23);
`,
  });
  mustFail(
    fixture.completionArgs,
    /after action receipt persistence and before trace persistence/iu,
    {
      timeout: 90_000,
      env: {
        NODE_ENV: "test",
        AGENTIC_SDLC_TEST_DELIVERY_ACTION_FAILURE:
          "after-action-receipt-before-trace",
      },
    },
  );

  const attemptsAfterFault = localReleaseAttemptReceipts(
    fixture.project,
    fixture.profileId,
  );
  assert.equal(attemptsAfterFault.length, 1);
  const failedCompletions = localReleaseActionReceipts(
    fixture.project,
    fixture.profileId,
  ).filter((receipt) =>
    receipt.status === "completed"
    && receipt.authorization_receipt_ref?.id
      === fixture.releaseAuthorization.action_receipt.id);
  assert.equal(failedCompletions.length, 1);
  const [failedCompletion] = failedCompletions;
  assert.equal(failedCompletion.outcome, "failed");
  assert.equal(failedCompletion.attempt_receipt_ref.id, attemptsAfterFault[0].id);
  assert.equal(failedCompletion.local_release_verification.outcome, "failed");
  const failedSmokeReceipts = structuredClone(
    failedCompletion.local_release_verification.smoke_test_receipts,
  );

  const tracePath = path.join(
    fixture.project,
    ".sdlc",
    "traces",
    `${storyId}.jsonl`,
  );
  const completionTraceEvents = () => fs.readFileSync(tracePath, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((event) => event.id === `TR-COMP-${failedCompletion.id}`);
  assert.equal(completionTraceEvents().length, 0);

  const retry = run([...fixture.completionArgs, "--json"], { timeout: 90_000 });
  assert.equal(retry.error, undefined, retry.error?.message);
  assert.equal(retry.signal, null, retry.stderr);
  assert.notEqual(retry.status, 0, retry.stdout);
  assert.match(
    `${retry.stdout}\n${retry.stderr}`,
    /already recorded as failed.*missing lifecycle trace was repaired.*No smoke command was executed again.*fresh authorization/isu,
  );

  const attemptsAfterRecovery = localReleaseAttemptReceipts(
    fixture.project,
    fixture.profileId,
  );
  assert.equal(attemptsAfterRecovery.length, 1);
  assert.equal(
    attemptsAfterRecovery[0].receipt_hash,
    attemptsAfterFault[0].receipt_hash,
  );
  const completionsAfterRecovery = localReleaseActionReceipts(
    fixture.project,
    fixture.profileId,
  ).filter((receipt) =>
    receipt.status === "completed"
    && receipt.authorization_receipt_ref?.id
      === fixture.releaseAuthorization.action_receipt.id);
  assert.equal(completionsAfterRecovery.length, 1);
  assert.equal(completionsAfterRecovery[0].id, failedCompletion.id);
  assert.equal(completionsAfterRecovery[0].receipt_hash, failedCompletion.receipt_hash);
  assert.deepEqual(
    completionsAfterRecovery[0].local_release_verification.smoke_test_receipts,
    failedSmokeReceipts,
  );
  const repairedTraceEvents = completionTraceEvents();
  assert.equal(repairedTraceEvents.length, 1);
  assert.equal(repairedTraceEvents[0].outcome, "failed");
  assert.equal(repairedTraceEvents[0].action, "release.local");
  assert.ok(
    repairedTraceEvents[0].evidence.includes(
      `.sdlc/autonomy/actions/${failedCompletion.id}.json`,
    ),
  );
});

test("release.local write-ahead orphan attempts block authorization reuse across smoke crash windows", {
  skip: hostSupportsLocalSmokeSandbox()
    ? false
    : "requires a supported local smoke sandbox",
  timeout: 240_000,
}, () => {
  const cases = [
    {
      suffix: "ATTEMPT-ORPHAN-BEFORE-SMOKE",
      failure: "after-local-release-attempt-before-smoke",
      pattern: /Simulated interruption.*attempt.*before.*smoke/isu,
    },
    {
      suffix: "ATTEMPT-ORPHAN-AFTER-SMOKE",
      failure: "after-local-release-smoke-before-completion-receipt",
      pattern: /Simulated interruption.*smoke.*before.*completion/isu,
    },
  ];

  for (const scenario of cases) {
    const fixture = prepareMacOsLocalSmokeRelease({
      suffix: scenario.suffix,
      smokeSource: "process.stdout.write('SMOKE_REACHED\\n');\n",
    });
    mustFail(
      fixture.completionArgs,
      scenario.pattern,
      {
        timeout: 90_000,
        env: {
          NODE_ENV: "test",
          AGENTIC_SDLC_TEST_DELIVERY_ACTION_FAILURE: scenario.failure,
        },
      },
    );

    const attempts = localReleaseAttemptReceipts(fixture.project, fixture.profileId);
    assert.equal(attempts.length, 1);
    assert.equal(
      attempts[0].authorization_receipt_ref.id,
      fixture.releaseAuthorization.action_receipt.id,
    );
    assert.equal(
      localReleaseActionReceipts(fixture.project, fixture.profileId)
        .some((receipt) =>
          receipt.status === "completed"
          && receipt.authorization_receipt_ref?.id
            === fixture.releaseAuthorization.action_receipt.id),
      false,
    );

    const orphanRetry = run([...fixture.completionArgs, "--json"], { timeout: 90_000 });
    assert.equal(orphanRetry.error, undefined, orphanRetry.error?.message);
    assert.equal(orphanRetry.signal, null, orphanRetry.stderr);
    assert.notEqual(orphanRetry.status, 0, orphanRetry.stdout);
    assert.equal(
      localReleaseAttemptReceipts(fixture.project, fixture.profileId).length,
      1,
    );
    assert.equal(
      localReleaseActionReceipts(fixture.project, fixture.profileId)
        .some((receipt) =>
          receipt.status === "completed"
          && receipt.authorization_receipt_ref?.id
            === fixture.releaseAuthorization.action_receipt.id),
      false,
    );
  }
});

test("release.local artifact snapshot rejects symlinks, special files, and over-limit trees before an attempt", {
  skip: hostSupportsLocalSmokeSandbox() && process.platform !== "win32"
    ? false
    : "requires a POSIX host with a supported local smoke sandbox",
  timeout: 180_000,
}, () => {
  const fixture = prepareMacOsLocalSmokeRelease({
    suffix: "ATTEMPT-ARTIFACT-LIMITS",
    smokeSource: "process.stdout.write('artifact-safe\\n');\n",
  });
  const unsafePath = path.join(fixture.releaseOutput, "unsafe-entry");
  fs.symlinkSync(path.join(fixture.releaseOutput, "missing-target"), unsafePath);
  mustFail(
    fixture.completionArgs,
    /freshness target contains a symlink/iu,
    { timeout: 90_000 },
  );
  assert.equal(localReleaseAttemptReceipts(fixture.project, fixture.profileId).length, 0);
  fs.unlinkSync(unsafePath);

  const fifo = spawnSync("mkfifo", [unsafePath], { encoding: "utf8", timeout: 30_000 });
  assert.equal(fifo.error, undefined, fifo.error?.message);
  assert.equal(fifo.status, 0, fifo.stderr);
  mustFail(
    fixture.completionArgs,
    /freshness target contains a non-regular entry/iu,
    { timeout: 90_000 },
  );
  assert.equal(localReleaseAttemptReceipts(fixture.project, fixture.profileId).length, 0);
  fs.unlinkSync(unsafePath);

  const oversizedPath = path.join(fixture.releaseOutput, "oversized-sparse.bin");
  const oversizedDescriptor = fs.openSync(oversizedPath, "w");
  try {
    fs.ftruncateSync(oversizedDescriptor, (512 * 1024 * 1024) + 1);
  } finally {
    fs.closeSync(oversizedDescriptor);
  }
  mustFail(
    fixture.completionArgs,
    /freshness target exceeds 512 MiB/iu,
    { timeout: 90_000 },
  );
  assert.equal(localReleaseAttemptReceipts(fixture.project, fixture.profileId).length, 0);
  fs.unlinkSync(oversizedPath);

  const completed = mustRunJson(fixture.completionArgs, { timeout: 90_000 });
  assert.equal(completed.lifecycle_status, "terminal");
  assert.equal(localReleaseAttemptReceipts(fixture.project, fixture.profileId).length, 1);
});

test("local release autonomy requires a strict child target, smoke test, rollback, and supported sandbox", () => {
  const project = tmpProject("local-release");
  initializeAutonomyProject(project);
  createApprovedImplementationContract(project, {
    storyId: "ST-LOCAL-1",
    contractId: "CONTRACT-LOCAL-1",
    profileId: "AUT-LOCAL-1",
  });

  const releaseRoot = path.join(project, "local-release");
  const releaseOutput = path.join(releaseRoot, "app");
  const secondReleaseOutput = path.join(releaseRoot, "config");
  const outsideRoot = path.join(project, "outside-release");
  fs.mkdirSync(releaseOutput, { recursive: true });
  fs.mkdirSync(secondReleaseOutput, { recursive: true });
  fs.mkdirSync(outsideRoot, { recursive: true });

  const baseArgs = [
    "autonomy", "delivery", "propose",
    "--root", project,
    "--id", "AUT-LOCAL-1",
    "--delivery", "LOCAL-RELEASE-1",
    "--kind", "local_release",
    "--story", "ST-LOCAL-1",
    "--contract", "CONTRACT-LOCAL-1",
    "--requirement", "REQ-AUTONOMY",
    "--level", "bounded-autonomous",
    "--target-root", releaseRoot,
    "--smoke-test", '["node","--version"]',
    "--rollback", "Restore the previous local build directory snapshot.",
  ];
  mustFail([
    ...baseArgs,
    "--write-path", outsideRoot,
  ], /must be a strict child of root_path/u);
  mustFail([
    ...baseArgs,
    "--write-path", releaseOutput,
    "--write-path", secondReleaseOutput,
  ], /requires one explicit --smoke-cwd/u);
  mustFail([
    ...baseArgs,
    "--write-path", releaseOutput,
    "--smoke-cwd", outsideRoot,
  ], /must be equal to or inside one approved --write-path/u);

  const proposalResponse = mustRunJson([
    ...baseArgs,
    "--write-path", releaseOutput,
  ]);
  const proposed = proposalResponse.delivery_profile;
  assert.equal(proposed.delivery_kind, "local_release");
  assert.equal(proposed.local_release_target.environment, "local");
  assert.equal(proposed.local_release_target.root_path, releaseRoot);
  assert.deepEqual(proposed.local_release_target.allowed_write_paths, [releaseOutput]);
  assert.deepEqual(proposed.local_release_target.smoke_tests, ['["node","--version"]']);
  assert.equal(proposed.local_release_target.smoke_cwd, releaseOutput);
  assert.deepEqual(proposed.provider_bindings, [
    { action: "release.local", provider_id: "local-filesystem" },
    { action: "rollback.verify", provider_id: "local-filesystem" },
  ]);
  assert.equal(proposed.local_release_target.rollback.required, true);
  assert.equal(proposed.local_release_target.rollback.verification_required, true);
  assert.match(proposed.local_release_target.rollback.procedure, /previous local build/u);
  assert.equal(proposed.local_release_target.external_access_allowed, false);
  assert.equal(proposed.local_release_target.production_access_allowed, false);
  assert.equal(proposed.local_release_target.destructive_actions_allowed, false);
  assert.match(proposalResponse.human_guidance.required_decision, /Per questo rilascio locale|For this local release/u);
  assert.match(proposalResponse.human_guidance.required_decision, /Full autonomy within these limits: I complete this local release/u);
  assert.match(proposalResponse.human_guidance.required_decision, /applies only to this local release and will not be reused/u);
  assert.doesNotMatch(proposalResponse.human_guidance.required_decision, /pull request or local release/u);
  assert.equal(proposalResponse.human_guidance.details.review_moments.includes("data.migrate"), false);
  assert.equal(proposalResponse.human_guidance.details.review_moments.includes("data.rollback"), false);
  assert.equal(proposalResponse.human_guidance.details.review_moments.includes("pull_request.merge"), false);
  assert.equal(proposalResponse.human_guidance.details.review_moments.includes("deploy.remote"), false);

  const missingLocalSelection = mustRun([
    "task", "start",
    "--root", project,
    "--intent-json", taskIntent("ST-LOCAL-1"),
    "--locale", "it",
  ]);
  const missingLocalGuidance = splitHumanGuidance(missingLocalSelection.stdout, "it");
  assert.match(missingLocalGuidance.primary, /Per questo rilascio locale, quanto vuoi che lavori in autonomia\?/u);
  assert.match(missingLocalGuidance.primary, /1\. Guidato: ti chiedo conferma prima dei passaggi importanti/u);
  assert.match(missingLocalGuidance.primary, /2\. Autonomia con controlli: procedo da solo/u);
  assert.match(missingLocalGuidance.primary, /3\. Autonomia completa entro questi limiti: completo questo rilascio locale senza pause ordinarie/u);
  assert.match(missingLocalGuidance.primary, /Questa scelta vale solo per questo rilascio locale e non sarà riutilizzata/u);
  assert.doesNotMatch(missingLocalGuidance.primary, /Per questa PR|PR o rilascio locale/u);

  const activated = mustRunJson([
    "autonomy", "delivery", "approve",
    "--root", project,
    "--id", "AUT-LOCAL-1",
    "--phase", "implementation",
    ...humanApproval("Approve this exact local release boundary"),
  ]);
  assert.equal(activated.delivery_profile.status, "active");
  assert.equal(activated.autonomy_decision.effective_level, "checkpointed");
  assert.equal(activated.autonomy_decision.requires_checkpoint, true);

  const originalReleaseOutput = `${releaseOutput}-original`;
  fs.renameSync(releaseOutput, originalReleaseOutput);
  fs.symlinkSync(outsideRoot, releaseOutput, process.platform === "win32" ? "junction" : "dir");
  const escapedBoundary = mustRunJson([
    "task", "start",
    "--root", project,
    "--intent-json", taskIntent("ST-LOCAL-1"),
    "--delivery-profile", "AUT-LOCAL-1",
    "--confirm-start",
    "--actor-type", "human",
  ]);
  assert.equal(escapedBoundary.execution_allowed, false);
  assert.equal(escapedBoundary.contract_action, "repair_delivery_autonomy");
  assert.ok(escapedBoundary.blocking_reasons.includes("autonomy_profile_invalid"));

  fs.unlinkSync(releaseOutput);
  fs.renameSync(originalReleaseOutput, releaseOutput);

  const started = mustRunJson([
    "task", "start",
    "--root", project,
    "--intent-json", taskIntent("ST-LOCAL-1"),
    "--delivery-profile", "AUT-LOCAL-1",
  ]);
  assert.equal(started.status, "ready_to_execute");
  assert.equal(started.execution_allowed, true);
  assert.equal(started.autonomy.effective_level, "checkpointed");
  assert.equal(started.autonomy.task_start_automatic, true);

  const checkpointArgs = [
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-LOCAL-1",
    "--action", "release.local",
  ];
  if (hostSupportsLocalSmokeSandbox()) {
    const checkpoint = mustRunJson(checkpointArgs);
    assert.equal(checkpoint.status, "checkpoint_required");
    assert.equal(checkpoint.execution_allowed, false);
    assert.equal(checkpoint.checkpoints.includes("release.local"), true);
  } else {
    mustFail(
      checkpointArgs,
      /Local smoke-test execution requires a configured read-only, no-network sandbox on this host/u,
    );
  }

  const missingRollbackGate = run([
    "gate", "check",
    "--root", project,
    "--scope", "story",
    "--story", "ST-LOCAL-1",
    "--strict",
    "--lifecycle-complete",
    "--json",
  ]);
  assert.notEqual(missingRollbackGate.status, 0);
  assert.match(
    missingRollbackGate.stdout,
    /requires verified rollback evidence/u,
  );
  fs.writeFileSync(
    path.join(project, "rollback-rehearsal.json"),
    '{"target":"local-release/app","restored":true}\n',
    "utf8",
  );
  const rollbackVerificationAuthorization = mustRunJson([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-LOCAL-1",
    "--action", "rollback.verify",
    "--evidence", "rollback-rehearsal.json",
    "--confirm-action",
    ...humanApproval("Approve the exact local rollback rehearsal evidence"),
  ]);
  const rollbackVerificationCompletion = mustRunJson([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-LOCAL-1",
    "--action", "rollback.verify",
    "--outcome", "passed",
    "--evidence", "rollback-rehearsal.json",
  ]);
  assert.equal(
    rollbackVerificationCompletion.action_receipt.authorization_receipt_ref.id,
    rollbackVerificationAuthorization.action_receipt.id,
  );
  assert.equal(
    rollbackVerificationCompletion.action_receipt.rollback_verification.target_root,
    releaseRoot,
  );
  assert.deepEqual(
    rollbackVerificationCompletion.action_receipt.rollback_verification.allowed_write_paths,
    [releaseOutput],
  );
  assert.equal(
    rollbackVerificationCompletion.action_receipt.rollback_verification
      .data_rollback_receipt_ref,
    undefined,
  );

  const assertHistoricalGateDoesNotReopenLocalTarget = () => {
    const unavailableReleaseRoot = `${releaseRoot}-after-completion`;
    fs.renameSync(releaseRoot, unavailableReleaseRoot);
    try {
      const historicalGate = run([
        "gate", "check",
        "--root", project,
        "--scope", "story",
        "--story", "ST-LOCAL-1",
        "--strict",
        "--json",
      ]);
      assert.equal(historicalGate.error, undefined, historicalGate.error?.message);
      assert.doesNotMatch(
        `${historicalGate.stdout}\n${historicalGate.stderr}`,
        /Local release target root must be an existing directory/u,
      );
    } finally {
      fs.renameSync(unavailableReleaseRoot, releaseRoot);
    }
  };
  const releaseAuthorizationArgs = [
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-LOCAL-1",
    "--action", "release.local",
    "--confirm-action",
    ...humanApproval("Approve this exact local release checkpoint"),
  ];
  if (!hostSupportsLocalSmokeSandbox()) {
    mustFail(
      releaseAuthorizationArgs,
      /Local smoke-test execution requires a configured read-only, no-network sandbox on this host/u,
    );
    const unavailableStatus = mustRunJson([
      "autonomy", "delivery", "status",
      "--root", project,
      "--id", "AUT-LOCAL-1",
    ]);
    assert.equal(unavailableStatus.delivery_profiles[0].lifecycle_status, "started");
    assert.equal(unavailableStatus.delivery_profiles[0].delivery_status, "started");
    const cancelled = mustRunJson([
      "autonomy", "delivery", "close",
      "--root", project,
      "--id", "AUT-LOCAL-1",
      "--terminal-status", "cancelled",
      "--reason", "The host has no supported smoke-test sandbox for this local fixture.",
      ...humanApproval("Approve cancellation of the sandbox-unavailable local fixture"),
    ]);
    assert.equal(cancelled.status, "terminal");
    assertHistoricalGateDoesNotReopenLocalTarget();
    return;
  }
  const releaseAuthorization = mustRunJson(releaseAuthorizationArgs);
  assert.equal(releaseAuthorization.status, "authorized");
  assert.equal(releaseAuthorization.execution_allowed, true);
  assert.equal(releaseAuthorization.checkpoint_required, true);
  assert.equal(releaseAuthorization.action_receipt.approval.status, "approved");
  assert.equal(releaseAuthorization.action_receipt.action_details.target_root, releaseRoot);
  assert.equal(
    releaseAuthorization.action_receipt.action_details.provider_operation.precondition_receipt.provider.id,
    "local-filesystem",
  );
  assert.deepEqual(releaseAuthorization.action_receipt.action_details.allowed_write_paths, [releaseOutput]);
  assert.equal(releaseAuthorization.action_receipt.action_details.smoke_cwd, releaseOutput);
  assert.equal(
    releaseAuthorization.action_receipt.action_details.data_migration_sequence,
    undefined,
  );
  const localCheckpointPolicy = releaseAuthorization.action_receipt.action_details.checkpoint_policy;
  assert.equal(localCheckpointPolicy.local_boundary_source.schema_version, "delivery-local-boundary-source:v1");
  assert.equal(localCheckpointPolicy.local_boundary_source.target_outside_workspace, false);
  assert.equal(localCheckpointPolicy.local_boundary_source.target_machine_global, false);
  assert.equal(localCheckpointPolicy.local_boundary_checkpoint, false);
  assert.equal(
    localCheckpointPolicy.local_boundary_source_hash,
    crypto.createHash("sha256")
      .update(stableJson(localCheckpointPolicy.local_boundary_source))
      .digest("hex"),
  );

  fs.writeFileSync(path.join(project, "build-runtime-proof.txt"), "local build evidence\n", "utf8");
  const historicalBuildAuthorization = mustRunJson([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-LOCAL-1",
    "--action", "build.local",
    "--confirm-action",
    ...humanApproval("Approve this exact local build checkpoint"),
  ]);
  const historicalBuildCompletion = mustRunJson([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-LOCAL-1",
    "--action", "build.local",
    "--outcome", "passed",
    "--evidence", "build-runtime-proof.txt",
  ]);
  assert.equal(
    historicalBuildCompletion.action_receipt.authorization_receipt_ref.id,
    historicalBuildAuthorization.action_receipt.id,
  );
  const liveBuildAuthorization = mustRunJson([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-LOCAL-1",
    "--action", "build.local",
    "--confirm-action",
    ...humanApproval("Approve the next exact local build checkpoint"),
  ]);

  const releaseAuthorizationPath = path.join(project, releaseAuthorization.action_receipt_path);
  const originalReleaseAuthorization = fs.readFileSync(releaseAuthorizationPath, "utf8");
  const forgedReleaseAuthorization = JSON.parse(originalReleaseAuthorization);
  const forgedLocalPolicy = forgedReleaseAuthorization.action_details.checkpoint_policy;
  forgedLocalPolicy.local_boundary_source.workspace_real_path = path.join(
    path.dirname(project),
    "unrelated-workspace",
  );
  forgedLocalPolicy.local_boundary_source_hash = crypto.createHash("sha256")
    .update(stableJson(forgedLocalPolicy.local_boundary_source))
    .digest("hex");
  const { policy_hash: _forgedPolicyHash, ...forgedPolicySubject } = forgedLocalPolicy;
  forgedLocalPolicy.policy_hash = crypto.createHash("sha256")
    .update(stableJson(forgedPolicySubject))
    .digest("hex");
  forgedReleaseAuthorization.receipt_hash = lifecycleReceiptHash(forgedReleaseAuthorization);
  fs.writeFileSync(
    releaseAuthorizationPath,
    `${JSON.stringify(forgedReleaseAuthorization, null, 2)}\n`,
    "utf8",
  );
  const forgedLocalBoundaryGate = run([
    "gate", "check",
    "--root", project,
    "--scope", "story",
    "--story", "ST-LOCAL-1",
    "--strict",
    "--json",
  ]);
  assert.equal(forgedLocalBoundaryGate.status, 1, forgedLocalBoundaryGate.stderr || forgedLocalBoundaryGate.stdout);
  assert.match(
    `${forgedLocalBoundaryGate.stdout}\n${forgedLocalBoundaryGate.stderr}`,
    /checkpoint policy snapshot has an invalid local-boundary source binding/u,
  );
  fs.writeFileSync(releaseAuthorizationPath, originalReleaseAuthorization, "utf8");

  const localConfigPreview = mustRunJson([
    "config", "migrate",
    "--root", project,
  ]);
  assert.equal(localConfigPreview.status, "planned");
  mustRunJson([
    "config", "migrate",
    "--root", project,
    "--apply",
    "--plan-hash", localConfigPreview.plan.plan_hash,
    "--actor-type", "human",
  ]);
  const localConfigPath = path.join(project, ".sdlc", "config.json");
  const changedLocalConfig = JSON.parse(fs.readFileSync(localConfigPath, "utf8"));
  changedLocalConfig.autonomy_policy.presets.checkpointed.checkpoints = [
    ...new Set([
      ...changedLocalConfig.autonomy_policy.presets.checkpointed.checkpoints,
      "git.commit",
    ]),
  ].sort();
  fs.writeFileSync(localConfigPath, `${JSON.stringify(changedLocalConfig, null, 2)}\n`, "utf8");
  const changedLocalConfigPreview = mustRunJson([
    "config", "migrate",
    "--root", project,
  ]);
  assert.equal(changedLocalConfigPreview.status, "planned");
  mustRunJson([
    "config", "migrate",
    "--root", project,
    "--apply",
    "--plan-hash", changedLocalConfigPreview.plan.plan_hash,
    "--actor-type", "human",
  ]);
  const configOnlyDriftGate = run([
    "gate", "check",
    "--root", project,
    "--scope", "story",
    "--story", "ST-LOCAL-1",
    "--strict",
    "--json",
  ]);
  assert.equal(configOnlyDriftGate.error, undefined, configOnlyDriftGate.error?.message);
  assert.equal(configOnlyDriftGate.signal, null, `gate check terminated by ${configOnlyDriftGate.signal}`);
  assert.ok([0, 1].includes(configOnlyDriftGate.status), configOnlyDriftGate.stderr || configOnlyDriftGate.stdout);
  const configOnlyDriftReport = JSON.parse(configOnlyDriftGate.stdout);
  assert.equal(
    configOnlyDriftReport.errors.some((error) =>
      /different local target or machine scope/iu.test(error)),
    false,
    configOnlyDriftGate.stdout,
  );
  assert.ok(
    configOnlyDriftReport.warnings.some((warning) =>
      /remains valid for this exact action; updated approval rules apply to later actions/iu.test(warning)),
    configOnlyDriftGate.stdout,
  );

  const relocatedProject = `${project}-relocated`;
  fs.cpSync(project, relocatedProject, { recursive: true });
  tempProjects.add(relocatedProject);
  fs.writeFileSync(
    path.join(relocatedProject, "release-runtime-proof.txt"),
    "local release runtime-boundary evidence\n",
    "utf8",
  );
  const relocatedBoundaryGate = run([
    "gate", "check",
    "--root", relocatedProject,
    "--scope", "story",
    "--story", "ST-LOCAL-1",
    "--strict",
    "--json",
  ]);
  assert.equal(
    relocatedBoundaryGate.status,
    1,
    relocatedBoundaryGate.stderr || relocatedBoundaryGate.stdout,
  );
  assert.match(
    `${relocatedBoundaryGate.stdout}\n${relocatedBoundaryGate.stderr}`,
    /different local target or machine scope/u,
  );
  const relocatedBoundaryReport = JSON.parse(relocatedBoundaryGate.stdout);
  const localTargetErrors = relocatedBoundaryReport.errors.filter((error) =>
    /different local target or machine scope/u.test(error));
  const localTargetReceiptIds = new Set(localTargetErrors.flatMap((error) =>
    error.match(/AUT-ACT-[0-9]+-[a-f0-9]+/gu) || []));
  assert.equal(localTargetReceiptIds.size, 2, relocatedBoundaryGate.stdout);
  assert.equal(
    localTargetErrors.some((error) => error.includes(historicalBuildAuthorization.action_receipt.id)),
    false,
    relocatedBoundaryGate.stdout,
  );
  assert.equal(
    localTargetErrors.some((error) => error.includes(liveBuildAuthorization.action_receipt.id)),
    true,
    relocatedBoundaryGate.stdout,
  );
  mustFail([
    "autonomy", "delivery", "action",
    "--root", relocatedProject,
    "--id", "AUT-LOCAL-1",
    "--action", "build.local",
    "--outcome", "failed",
    "--evidence", "build-runtime-proof.txt",
  ], /different local target or machine scope/u);
  mustFail([
    "autonomy", "delivery", "action",
    "--root", relocatedProject,
    "--id", "AUT-LOCAL-1",
    "--action", "release.local",
    "--outcome", "passed",
    "--evidence", "release-runtime-proof.txt",
    "--smoke-test", '["node","--version"]',
    "--rollback", "Restore the previous local build directory snapshot.",
  ], /different local target or machine scope/u);

  mustRunJson([
    "autonomy", "delivery", "action",
    "--root", relocatedProject,
    "--id", "AUT-LOCAL-1",
    "--action", "build.local",
    "--confirm-action",
    ...humanApproval("Approve the relocated local build target"),
  ]);
  mustRunJson([
    "autonomy", "delivery", "action",
    "--root", relocatedProject,
    "--id", "AUT-LOCAL-1",
    "--action", "release.local",
    "--confirm-action",
    ...humanApproval("Approve the relocated local release target"),
  ]);
  const refreshedBoundaryGate = run([
    "gate", "check",
    "--root", relocatedProject,
    "--scope", "story",
    "--story", "ST-LOCAL-1",
    "--strict",
    "--json",
  ]);
  assert.ok([0, 1].includes(refreshedBoundaryGate.status), refreshedBoundaryGate.stderr);
  const refreshedBoundaryReport = JSON.parse(refreshedBoundaryGate.stdout);
  assert.equal(
    refreshedBoundaryReport.errors.some((error) => /different local target or machine scope/u.test(error)),
    false,
    refreshedBoundaryGate.stdout,
  );
  assert.equal(
    refreshedBoundaryReport.warnings.some((warning) => /superseded by a later unconsumed authorization/u.test(warning)),
    true,
    refreshedBoundaryGate.stdout,
  );

  const releaseEvidence = path.join(releaseOutput, "release-proof.txt");
  fs.writeFileSync(releaseEvidence, "local release evidence\n", "utf8");
  const completionArgsFor = (root) => [
    "autonomy", "delivery", "action",
    "--root", root,
    "--id", "AUT-LOCAL-1",
    "--action", "release.local",
    "--outcome", "passed",
    "--evidence", "local-release/app/release-proof.txt",
    "--smoke-test", '["node","--version"]',
    "--rollback", "Restore the previous local build directory snapshot.",
  ];
  const completionArgs = completionArgsFor(project);
  mustFail(
    [...completionArgs, "--smoke-cwd", secondReleaseOutput],
    /must match the exact approved smoke working directory/u,
  );
  const interruptedProject = `${project}-interrupted`;
  fs.cpSync(project, interruptedProject, { recursive: true });
  tempProjects.add(interruptedProject);
  const interruptedAuthorization = mustRunJson([
    "autonomy", "delivery", "action",
    "--root", interruptedProject,
    "--id", "AUT-LOCAL-1",
    "--action", "release.local",
    "--confirm-action",
    ...humanApproval("Approve the exact interrupted-release fixture target"),
  ]);
  mustFail(
    [
      ...completionArgsFor(interruptedProject),
      "--authorization-receipt", interruptedAuthorization.action_receipt.id,
    ],
    /Simulated interruption after the terminal completion receipt was persisted/u,
    {
      timeout: 90_000,
      env: {
        NODE_ENV: "test",
        AGENTIC_SDLC_TEST_DELIVERY_ACTION_FAILURE: "after-terminal-completion-receipt",
      },
    },
  );
  const interruptedActionsRoot = path.join(
    interruptedProject,
    ".sdlc",
    "autonomy",
    "actions",
  );
  for (const name of fs.readdirSync(interruptedActionsRoot)) {
    if (!name.endsWith(".json")) continue;
    const actionPath = path.join(interruptedActionsRoot, name);
    if (JSON.parse(fs.readFileSync(actionPath, "utf8")).action === "build.local") {
      fs.rmSync(actionPath);
    }
  }
  mutateDeliveryStartReceipt(
    interruptedProject,
    "AUT-LOCAL-1",
    "ST-LOCAL-1",
    (start) => {
      start.schema_version = "delivery-start-receipt:v1";
      delete start.local_release_target_baseline;
    },
  );
  const repairedLegacyTerminal = mustRunJson([
    "autonomy", "delivery", "action",
    "--root", interruptedProject,
    "--id", "AUT-LOCAL-1",
    "--action", "release.local",
  ]);
  assert.equal(repairedLegacyTerminal.status, "terminal");
  assert.equal(repairedLegacyTerminal.idempotent_repair, true);
  assert.equal(repairedLegacyTerminal.lifecycle_status, "terminal");
  assert.equal(repairedLegacyTerminal.terminal_status, "released");
  assert.equal(
    repairedLegacyTerminal.action_receipt.authorization_receipt_ref.id,
    interruptedAuthorization.action_receipt.id,
  );
  assert.equal(
    fs.existsSync(path.join(interruptedProject, repairedLegacyTerminal.close_receipt_path)),
    true,
  );
  const repairedLegacyGate = run([
    "gate", "check",
    "--root", interruptedProject,
    "--scope", "story",
    "--story", "ST-LOCAL-1",
    "--strict",
    "--json",
  ]);
  assert.ok([0, 1].includes(repairedLegacyGate.status), repairedLegacyGate.stderr);
  assert.doesNotMatch(
    `${repairedLegacyGate.stdout}\n${repairedLegacyGate.stderr}`,
    /legacy start receipt without an immutable local-target baseline.*cannot authorize or complete another action/isu,
  );
  const interruptedRelocatedProject = `${interruptedProject}-relocated`;
  fs.cpSync(interruptedProject, interruptedRelocatedProject, { recursive: true });
  tempProjects.add(interruptedRelocatedProject);
  const repairedAfterRelocation = mustRunJson(
    [
      ...completionArgsFor(interruptedRelocatedProject),
      "--authorization-receipt", interruptedAuthorization.action_receipt.id,
    ],
    { timeout: 90_000 },
  );
  assert.equal(repairedAfterRelocation.status, "completed");
  assert.equal(repairedAfterRelocation.idempotent, true);
  assert.equal(repairedAfterRelocation.recovery_status, "repaired");
  assert.equal(repairedAfterRelocation.lifecycle_status, "terminal");
  assert.equal(
    repairedAfterRelocation.action_receipt.authorization_receipt_ref.id,
    interruptedAuthorization.action_receipt.id,
  );
  const recoveredGate = run([
    "gate", "check",
    "--root", interruptedRelocatedProject,
    "--scope", "story",
    "--story", "ST-LOCAL-1",
    "--strict",
    "--json",
  ]);
  assert.ok([0, 1].includes(recoveredGate.status), recoveredGate.stderr);
  assert.doesNotMatch(
    `${recoveredGate.stdout}\n${recoveredGate.stderr}`,
    /different local target or machine scope/u,
  );

  const completed = mustRunJson(completionArgs, { timeout: 90_000 });
  assert.equal(completed.status, "completed");
  assert.equal(completed.lifecycle_status, "terminal");
  assert.ok(completed.audit_warnings.some((warning) =>
    /remains valid for this exact action; updated approval rules apply to later actions/iu.test(warning)));
  assert.match(completed.close_receipt_path, /autonomy\/executions\/AUT-LOCAL-1\/close\.json$/u);
  assert.equal(completed.action_receipt.authorization_receipt_ref.id, releaseAuthorization.action_receipt.id);
  assert.equal(
    completed.action_receipt.action_details.provider_operation.completion_receipt.precondition_receipt_ref.hash,
    releaseAuthorization.action_receipt.action_details.provider_operation.precondition_receipt.receipt_hash,
  );
  assert.equal(completed.action_receipt.local_release_verification.outcome, "passed");
  assert.deepEqual(completed.action_receipt.local_release_verification.smoke_tests, ['["node","--version"]']);
  assert.equal(completed.action_receipt.local_release_verification.smoke_cwd, releaseOutput);
  assert.equal(completed.action_receipt.local_release_verification.smoke_test_receipts.length, 1);
  assert.deepEqual(
    completed.action_receipt.local_release_verification.smoke_test_receipts[0].command,
    ["node", "--version"],
  );
  assert.equal(completed.action_receipt.local_release_verification.smoke_test_receipts[0].outcome, "passed");
  assert.equal(completed.action_receipt.local_release_verification.smoke_test_receipts[0].exit_code, 0);
  assert.equal(completed.action_receipt.local_release_verification.smoke_test_receipts[0].cwd, releaseOutput);

  const closeReceipt = JSON.parse(fs.readFileSync(path.join(project, completed.close_receipt_path), "utf8"));
  assert.equal(closeReceipt.terminal_status, "released");
  assert.equal(closeReceipt.terminal_action_receipt_ref.id, completed.action_receipt.id);

  const idempotentCompletion = mustRunJson([
    "autonomy", "delivery", "action",
    "--root", project,
    "--id", "AUT-LOCAL-1",
    "--action", "release.local",
    "--outcome", "passed",
    "--evidence", "local-release/app/release-proof.txt",
    "--smoke-test", '["node","--version"]',
    "--rollback", "Restore the previous local build directory snapshot.",
  ], { timeout: 90_000 });
  assert.equal(idempotentCompletion.idempotent, true);
  assert.equal(idempotentCompletion.action_receipt.id, completed.action_receipt.id);
  assert.equal(idempotentCompletion.close_receipt.receipt_hash, closeReceipt.receipt_hash);

  const status = mustRunJson([
    "autonomy", "delivery", "status",
    "--root", project,
    "--id", "AUT-LOCAL-1",
  ]);
  assert.equal(status.delivery_profiles.length, 1);
  assert.equal(status.delivery_profiles[0].lifecycle_status, "terminal");
  assert.equal(status.delivery_profiles[0].delivery_status, "released");
  assertHistoricalGateDoesNotReopenLocalTarget();
});

test("delivery revocation is hash-bound, single-record, and repairs a missing terminal receipt", () => {
  const project = tmpProject("revocation");
  initializeAutonomyProject(project);
  createApprovedImplementationContract(project, {
    storyId: "ST-REVOKE-1",
    contractId: "CONTRACT-REVOKE-1",
    profileId: "AUT-REVOKE-1",
  });
  mustRun([
    "autonomy", "delivery", "propose",
    "--root", project,
    "--id", "AUT-REVOKE-1",
    "--delivery", "PR-REVOKE-1",
    "--kind", "pull_request",
    "--story", "ST-REVOKE-1",
    "--contract", "CONTRACT-REVOKE-1",
    "--requirement", "REQ-AUTONOMY",
    "--level", "checkpointed",
    "--repository", "aantenore/agentic-sdlc-codex-plugin",
    "--base", "main",
    "--head", "codex/pr-1",
    "--write-path", "src",
  ]);
  mustRun([
    "autonomy", "delivery", "approve",
    "--root", project,
    "--id", "AUT-REVOKE-1",
    "--phase", "implementation",
    ...humanApproval("Approve the revocation lifecycle test profile"),
  ]);
  const started = mustRunJson([
    "task", "start",
    "--root", project,
    "--intent-json", taskIntent("ST-REVOKE-1"),
    "--delivery-profile", "AUT-REVOKE-1",
  ]);
  assert.equal(started.execution_allowed, true);

  const reason = "The exact delivery is no longer authorized to continue.";
  const revocationApprovalPath = path.join(project, "src", "revocation-approval.txt");
  fs.mkdirSync(path.dirname(revocationApprovalPath), { recursive: true });
  fs.writeFileSync(revocationApprovalPath, "exact revocation approval evidence\n", "utf8");
  const revoked = mustRunJson([
    "autonomy", "delivery", "revoke",
    "--root", project,
    "--id", "AUT-REVOKE-1",
    "--reason", reason,
    "--approval-evidence", "src/revocation-approval.txt",
    ...humanApproval("Approve revocation of this exact delivery profile"),
  ]);
  assert.equal(revoked.status, "revoked");
  assert.equal(revoked.revocation.kind, "autonomy_profile_revocation");
  assert.equal(revoked.revocation.reason, reason);
  assert.match(revoked.revocation.receipt_hash, /^[a-f0-9]{64}$/u);
  assert.equal(revoked.revocation.receipt_hash, lifecycleReceiptHash(revoked.revocation));
  assert.match(revoked.close_receipt_path, /autonomy\/executions\/AUT-REVOKE-1\/close\.json$/u);

  const closePath = path.join(project, revoked.close_receipt_path);
  fs.unlinkSync(closePath);
  const repaired = mustRunJson([
    "autonomy", "delivery", "revoke",
    "--root", project,
    "--id", "AUT-REVOKE-1",
    "--reason", reason,
  ]);
  assert.equal(repaired.status, "revoked");
  assert.equal(repaired.idempotent, true);
  assert.equal(repaired.revocation.id, revoked.revocation.id);
  assert.equal(repaired.revocation.receipt_hash, revoked.revocation.receipt_hash);
  assert.equal(fs.existsSync(path.join(project, repaired.close_receipt_path)), true);

  fs.writeFileSync(revocationApprovalPath, "tampered revocation approval evidence\n", "utf8");
  mustFail([
    "autonomy", "delivery", "status",
    "--root", project,
    "--id", "AUT-REVOKE-1",
  ], /revocation .* approval evidence changed after approval/u);
  fs.writeFileSync(revocationApprovalPath, "exact revocation approval evidence\n", "utf8");

  const revocationPath = path.join(
    project,
    ".sdlc",
    "autonomy",
    "revocations",
    `${revoked.revocation.id}.json`,
  );
  const forgedRevocation = JSON.parse(fs.readFileSync(revocationPath, "utf8"));
  forgedRevocation.reason = "forged reason";
  fs.writeFileSync(revocationPath, `${JSON.stringify(forgedRevocation, null, 2)}\n`, "utf8");
  mustFail([
    "autonomy", "delivery", "status",
    "--root", project,
    "--id", "AUT-REVOKE-1",
  ], /revocation hash is stale/u);
});

test("configured story lifecycle checkpoints require exact historical authorization receipts", () => {
  const project = tmpProject("story-action-checkpoints");
  initializeAutonomyProject(project);

  const configPath = path.join(project, ".sdlc", "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.autonomy_policy.presets.checkpointed.checkpoints = [
    ...new Set([
      ...config.autonomy_policy.presets.checkpointed.checkpoints,
      "story.claim",
      "output.link",
      "story.complete-step",
    ]),
  ].sort();
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  const migration = mustRunJson(["config", "migrate", "--root", project]);
  mustRunJson([
    "config", "migrate",
    "--root", project,
    "--apply",
    "--plan-hash", migration.plan.plan_hash,
    "--actor-type", "human",
  ]);

  createApprovedImplementationContract(project, {
    storyId: "ST-CHECKPOINTS",
    contractId: "CONTRACT-CHECKPOINTS",
    profileId: "AUT-CHECKPOINTS",
  });
  const releaseRoot = path.join(project, "local-release");
  const releaseOutput = path.join(releaseRoot, "app");
  mustRunJson([
    "autonomy", "delivery", "propose",
    "--root", project,
    "--id", "AUT-CHECKPOINTS",
    "--delivery", "LOCAL-CHECKPOINTS",
    "--kind", "local_release",
    "--story", "ST-CHECKPOINTS",
    "--contract", "CONTRACT-CHECKPOINTS",
    "--requirement", "REQ-AUTONOMY",
    "--level", "checkpointed",
    "--target-root", releaseRoot,
    "--write-path", releaseOutput,
    "--smoke-test", '["node","--version"]',
    "--rollback", "Restore the previous local release snapshot.",
  ]);
  mustRunJson([
    "autonomy", "delivery", "approve",
    "--root", project,
    "--id", "AUT-CHECKPOINTS",
    "--phase", "implementation",
    ...humanApproval("Approve the exact lifecycle checkpoint profile"),
  ]);
  mustRunJson([
    "task", "start",
    "--root", project,
    "--intent-json", taskIntent("ST-CHECKPOINTS"),
    "--delivery-profile", "AUT-CHECKPOINTS",
  ]);

  mustFail([
    "story", "claim",
    "--root", project,
    "--id", "ST-CHECKPOINTS",
    "--agent", "codex",
  ], /story\.claim is a required checkpoint.*--authorization/isu);

  const authorization = mustRunJson([
    "authorization", "grant",
    "--root", project,
    "--id", "AUTH-ST-CHECKPOINTS",
    "--scope", "Approve the three exact lifecycle checkpoints for ST-CHECKPOINTS.",
    "--allow-use", "story.claim=ST-CHECKPOINTS",
    "--allow-use", "output.link=ST-CHECKPOINTS",
    "--allow-use", "story.complete-step=ST-CHECKPOINTS.step.implementation",
    "--allow-artifact-type", "implementation-summary",
    "--max-uses", "3",
    ...humanApproval("Approve the exact story lifecycle checkpoints"),
  ]).authorization;
  assert.equal(authorization.id, "AUTH-ST-CHECKPOINTS");

  mustRunJson([
    "story", "claim",
    "--root", project,
    "--id", "ST-CHECKPOINTS",
    "--agent", "codex",
    "--authorization", authorization.id,
  ]);

  const artifactPath = path.join(project, "src", "checkpoint-summary.md");
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(
    artifactPath,
    "# Checkpoint summary\n\nThe exact implementation checkpoint has reviewable evidence.\n",
    "utf8",
  );
  const outputArgs = [
    "output", "link",
    "--root", project,
    "--story", "ST-CHECKPOINTS",
    "--type", "implementation-summary",
    "--artifact", "src/checkpoint-summary.md",
    "--template", "implementation-summary-v1",
    "--mode", "new",
    "--requirement", "REQ-AUTONOMY",
  ];
  mustFail(outputArgs, /output\.link is a required checkpoint.*--authorization/isu);
  mustRunJson([...outputArgs, "--authorization", authorization.id]);

  const completionArgs = [
    "story", "complete-step",
    "--root", project,
    "--id", "ST-CHECKPOINTS",
    "--step", "implementation",
    "--type", "implementation-summary",
    "--summary", "Implemented and linked the exact reviewed artifact.",
  ];
  mustFail(completionArgs, /story\.complete-step is a required checkpoint.*--authorization/isu);
  const wrongStepAuthorization = mustRunJson([
    "authorization", "grant",
    "--root", project,
    "--id", "AUTH-ST-CHECKPOINTS-WRONG-STEP",
    "--scope", "Approve only the discovery completion for ST-CHECKPOINTS.",
    "--allow-use", "story.complete-step=ST-CHECKPOINTS.step.discovery",
    "--allow-artifact-type", "implementation-summary",
    "--max-uses", "1",
    ...humanApproval("Approve only the discovery completion"),
  ]).authorization;
  mustFail(
    [...completionArgs, "--authorization", wrongStepAuthorization.id],
    /does not allow subject ST-CHECKPOINTS\.step\.implementation/isu,
  );
  mustRunJson([...completionArgs, "--authorization", authorization.id]);

  const claim = JSON.parse(fs.readFileSync(
    path.join(project, ".sdlc", "stories", "ST-CHECKPOINTS", "claim.json"),
    "utf8",
  ));
  const stepPath = path.join(
    project,
    ".sdlc",
    "stories",
    "ST-CHECKPOINTS",
    "steps",
    "implementation.json",
  );
  const step = JSON.parse(fs.readFileSync(stepPath, "utf8"));
  const registry = JSON.parse(fs.readFileSync(
    path.join(project, ".sdlc", "output-contracts", "registry.json"),
    "utf8",
  ));
  const link = registry.links.find((item) => item.story_id === "ST-CHECKPOINTS");
  for (const [record, action] of [
    [claim, "story.claim"],
    [link, "output.link"],
    [step, "story.complete-step"],
  ]) {
    assert.equal(record.authorization_ref, authorization.id);
    assert.equal(record.authorization_action, action);
    assert.match(record.authorization_use_ref, /^\.sdlc\/authorization-uses\//u);
    assert.equal(record.checkpoint_profile_ref.id, "AUT-CHECKPOINTS");
  }
  const stepUseReceipt = JSON.parse(fs.readFileSync(
    path.join(project, step.authorization_use_ref),
    "utf8",
  ));
  assert.equal(
    stepUseReceipt.subject_id || stepUseReceipt.subject?.subject_id,
    "ST-CHECKPOINTS.step.implementation",
  );

  delete step.authorization_use_ref;
  fs.writeFileSync(stepPath, `${JSON.stringify(step, null, 2)}\n`, "utf8");
  mustFail([
    "gate", "check",
    "--root", project,
    "--scope", "story",
    "--story", "ST-CHECKPOINTS",
    "--strict",
  ], /story step ST-CHECKPOINTS\/implementation has no exact story\.complete-step authorization receipt/u);
});

test("explicit story authorizations are consumed and an identical claim retry reuses its persisted use", () => {
  const project = tmpProject("optional-step-authorization");
  initializeAutonomyProject(project);

  const configPath = path.join(project, ".sdlc", "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.autonomy_policy.mode = "enforce_all";
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  const migration = mustRunJson(["config", "migrate", "--root", project]);
  mustRunJson([
    "config", "migrate",
    "--root", project,
    "--apply",
    "--plan-hash", migration.plan.plan_hash,
    "--actor-type", "human",
  ]);

  createApprovedImplementationContract(project, {
    storyId: "ST-OPTIONAL-AUTH",
    contractId: "CONTRACT-OPTIONAL-AUTH",
    profileId: "AUT-OPTIONAL-AUTH",
  });
  const releaseRoot = path.join(project, "local-release");
  const releaseOutput = path.join(releaseRoot, "app");
  mustRunJson([
    "autonomy", "delivery", "propose",
    "--root", project,
    "--id", "AUT-OPTIONAL-AUTH",
    "--delivery", "LOCAL-OPTIONAL-AUTH",
    "--kind", "local_release",
    "--story", "ST-OPTIONAL-AUTH",
    "--contract", "CONTRACT-OPTIONAL-AUTH",
    "--requirement", "REQ-AUTONOMY",
    "--level", "checkpointed",
    "--target-root", releaseRoot,
    "--write-path", releaseOutput,
    "--smoke-test", '["node","--version"]',
    "--rollback", "Restore the previous local release snapshot.",
  ]);
  mustRunJson([
    "autonomy", "delivery", "approve",
    "--root", project,
    "--id", "AUT-OPTIONAL-AUTH",
    "--phase", "implementation",
    ...humanApproval("Approve checkpointed autonomy for this exact local delivery"),
  ]);
  const deliveryProfile = JSON.parse(fs.readFileSync(
    path.join(project, ".sdlc", "autonomy", "deliveries", "AUT-OPTIONAL-AUTH.json"),
    "utf8",
  ));
  assert.equal(deliveryProfile.requested_level, "checkpointed");
  assert.equal(deliveryProfile.checkpoints.includes("story.complete-step"), false);

  mustRunJson([
    "task", "start",
    "--root", project,
    "--intent-json", taskIntent("ST-OPTIONAL-AUTH"),
    "--delivery-profile", "AUT-OPTIONAL-AUTH",
  ]);
  const unrelatedProposalHash = "f".repeat(64);
  const assertProposalBoundGrantRejectedWithoutUse = (authorization, command) => {
    mustFail(
      [...command, "--authorization", authorization.id],
      /proposal binding mismatch.*grant has proposal ASSESSMENT-UNRELATED.*this action expects no proposal binding/isu,
    );
    const status = mustRunJson([
      "authorization", "status",
      "--root", project,
      "--id", authorization.id,
    ]).authorizations[0];
    assert.equal(status.status, "active");
    assert.equal(status.use_count || 0, 0);
    assert.equal(
      fs.existsSync(path.join(project, ".sdlc", "authorization-uses", authorization.id)),
      false,
    );
  };
  const proposalBoundClaimAuthorization = mustRunJson([
    "authorization", "grant",
    "--root", project,
    "--id", "AUTH-ST-OPTIONAL-AUTH-CLAIM-BOUND",
    "--scope", "Claim ST-OPTIONAL-AUTH only for an unrelated assessment proposal.",
    "--allow-use", "story.claim=ST-OPTIONAL-AUTH",
    "--proposal", "ASSESSMENT-UNRELATED",
    "--proposal-hash", unrelatedProposalHash,
    "--max-uses", "1",
    ...humanApproval("Approve only the proposal-bound story claim"),
  ]).authorization;
  assertProposalBoundGrantRejectedWithoutUse(proposalBoundClaimAuthorization, [
    "story", "claim",
    "--root", project,
    "--id", "ST-OPTIONAL-AUTH",
    "--agent", "codex",
  ]);
  const claimAuthorization = mustRunJson([
    "authorization", "grant",
    "--root", project,
    "--id", "AUTH-ST-OPTIONAL-AUTH-CLAIM",
    "--scope", "Claim ST-OPTIONAL-AUTH once.",
    "--allow-use", "story.claim=ST-OPTIONAL-AUTH",
    "--max-uses", "1",
    ...humanApproval("Approve only the story claim"),
  ]).authorization;
  const claimArgs = [
    "story", "claim",
    "--root", project,
    "--id", "ST-OPTIONAL-AUTH",
    "--agent", "codex",
    "--authorization", claimAuthorization.id,
  ];
  const claimPath = path.join(
    project,
    ".sdlc",
    "stories",
    "ST-OPTIONAL-AUTH",
    "claim.json",
  );
  const tracePath = path.join(
    project,
    ".sdlc",
    "traces",
    "ST-OPTIONAL-AUTH.jsonl",
  );
  const traceBeforeInterruptedClaim = fs.readFileSync(tracePath);
  fs.rmSync(tracePath);
  fs.mkdirSync(tracePath);
  mustFail(
    claimArgs,
    /trace integrity|regular file|EISDIR|directory/iu,
  );
  assert.equal(fs.existsSync(claimPath), false);
  const useRoot = path.join(
    project,
    ".sdlc",
    "authorization-uses",
    claimAuthorization.id,
  );
  const usesAfterInterruptedClaim = fs.readdirSync(useRoot)
    .filter((name) => name.endsWith(".json"))
    .sort();
  assert.equal(usesAfterInterruptedClaim.length, 1);
  const statusAfterInterruptedClaim = mustRunJson([
    "authorization", "status",
    "--root", project,
    "--id", claimAuthorization.id,
  ]).authorizations[0];
  assert.equal(statusAfterInterruptedClaim.status, "consumed");
  assert.equal(statusAfterInterruptedClaim.use_count, 1);

  fs.rmSync(tracePath, { recursive: true });
  fs.writeFileSync(tracePath, traceBeforeInterruptedClaim);
  const claim = mustRunJson(claimArgs);
  assert.equal(claim.claim.authorization_ref, claimAuthorization.id);
  assert.equal(claim.claim.checkpoint_profile_ref.id, "AUT-OPTIONAL-AUTH");
  assert.equal(
    claim.claim.authorization_use_ref,
    path.relative(
      project,
      path.join(useRoot, usesAfterInterruptedClaim[0]),
    ).split(path.sep).join("/"),
  );
  assert.deepEqual(
    fs.readdirSync(useRoot).filter((name) => name.endsWith(".json")).sort(),
    usesAfterInterruptedClaim,
  );
  const statusAfterClaimRetry = mustRunJson([
    "authorization", "status",
    "--root", project,
    "--id", claimAuthorization.id,
  ]).authorizations[0];
  assert.equal(statusAfterClaimRetry.status, "consumed");
  assert.equal(statusAfterClaimRetry.use_count, 1);

  const artifactPath = path.join(project, "src", "optional-authorization-summary.md");
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(
    artifactPath,
    "# Optional authorization\n\nThe explicit grant must be consumed rather than ignored.\n",
    "utf8",
  );
  const outputArgs = [
    "output", "link",
    "--root", project,
    "--story", "ST-OPTIONAL-AUTH",
    "--type", "implementation-summary",
    "--artifact", "src/optional-authorization-summary.md",
    "--template", "implementation-summary-v1",
    "--mode", "new",
    "--requirement", "REQ-AUTONOMY",
  ];
  const proposalBoundOutputAuthorization = mustRunJson([
    "authorization", "grant",
    "--root", project,
    "--id", "AUTH-ST-OPTIONAL-AUTH-OUTPUT-BOUND",
    "--scope", "Link the output only for an unrelated assessment proposal.",
    "--allow-use", "output.link=ST-OPTIONAL-AUTH",
    "--allow-artifact-type", "implementation-summary",
    "--proposal", "ASSESSMENT-UNRELATED",
    "--proposal-hash", unrelatedProposalHash,
    "--max-uses", "1",
    ...humanApproval("Approve only the proposal-bound implementation output link"),
  ]).authorization;
  assertProposalBoundGrantRejectedWithoutUse(
    proposalBoundOutputAuthorization,
    outputArgs,
  );
  const outputAuthorization = mustRunJson([
    "authorization", "grant",
    "--root", project,
    "--id", "AUTH-ST-OPTIONAL-AUTH-OUTPUT",
    "--scope", "Link the implementation output for ST-OPTIONAL-AUTH once.",
    "--allow-use", "output.link=ST-OPTIONAL-AUTH",
    "--allow-artifact-type", "implementation-summary",
    "--max-uses", "1",
    ...humanApproval("Approve only the implementation output link"),
  ]).authorization;
  const outputLink = mustRunJson([
    ...outputArgs,
    "--authorization", outputAuthorization.id,
  ]);
  assert.equal(outputLink.link.authorization_ref, outputAuthorization.id);
  assert.equal(outputLink.link.checkpoint_profile_ref.id, "AUT-OPTIONAL-AUTH");
  assert.equal(
    mustRunJson([
      "authorization", "status",
      "--root", project,
      "--id", outputAuthorization.id,
    ]).authorizations[0].status,
    "consumed",
  );

  const wrongAuthorization = mustRunJson([
    "authorization", "grant",
    "--root", project,
    "--id", "AUTH-ST-OPTIONAL-AUTH-WRONG",
    "--scope", "Complete discovery for ST-OPTIONAL-AUTH only.",
    "--allow-use", "story.complete-step=ST-OPTIONAL-AUTH.step.discovery",
    "--allow-artifact-type", "implementation-summary",
    "--max-uses", "1",
    ...humanApproval("Approve only the discovery completion"),
  ]).authorization;
  const completionArgs = [
    "story", "complete-step",
    "--root", project,
    "--id", "ST-OPTIONAL-AUTH",
    "--step", "implementation",
    "--type", "implementation-summary",
    "--summary", "Implementation is complete with the exact linked output.",
  ];
  const proposalBoundCompletionAuthorization = mustRunJson([
    "authorization", "grant",
    "--root", project,
    "--id", "AUTH-ST-OPTIONAL-AUTH-COMPLETE-BOUND",
    "--scope", "Complete implementation only for an unrelated assessment proposal.",
    "--allow-use", "story.complete-step=ST-OPTIONAL-AUTH.step.implementation",
    "--allow-artifact-type", "implementation-summary",
    "--proposal", "ASSESSMENT-UNRELATED",
    "--proposal-hash", unrelatedProposalHash,
    "--max-uses", "1",
    ...humanApproval("Approve only the proposal-bound implementation completion"),
  ]).authorization;
  assertProposalBoundGrantRejectedWithoutUse(
    proposalBoundCompletionAuthorization,
    completionArgs,
  );
  mustFail(
    [...completionArgs, "--authorization", wrongAuthorization.id],
    /does not allow subject ST-OPTIONAL-AUTH\.step\.implementation/isu,
  );
  const wrongStatus = mustRunJson([
    "authorization", "status",
    "--root", project,
    "--id", wrongAuthorization.id,
  ]);
  assert.equal(wrongStatus.authorizations[0].status, "active");

  const authorization = mustRunJson([
    "authorization", "grant",
    "--root", project,
    "--id", "AUTH-ST-OPTIONAL-AUTH-IMPLEMENTATION",
    "--scope", "Complete implementation for ST-OPTIONAL-AUTH only.",
    "--allow-use", "story.complete-step=ST-OPTIONAL-AUTH.step.implementation",
    "--allow-artifact-type", "implementation-summary",
    "--max-uses", "1",
    ...humanApproval("Approve only the implementation completion"),
  ]).authorization;
  const completion = mustRunJson([
    ...completionArgs,
    "--authorization", authorization.id,
  ]);
  assert.equal(completion.step.authorization_ref, authorization.id);
  assert.equal(completion.step.authorization_action, "story.complete-step");
  assert.equal(completion.step.checkpoint_profile_ref.id, "AUT-OPTIONAL-AUTH");
  assert.match(
    completion.step.authorization_use_ref,
    /^\.sdlc\/authorization-uses\/AUTH-ST-OPTIONAL-AUTH-IMPLEMENTATION\//u,
  );

  const consumedStatus = mustRunJson([
    "authorization", "status",
    "--root", project,
    "--id", authorization.id,
  ]);
  assert.equal(consumedStatus.authorizations[0].status, "consumed");
  assert.equal(consumedStatus.authorizations[0].use_count, 1);

  const historicalParent = tmpProject("optional-step-authorization-historical");
  const historicalProject = path.join(historicalParent, "copy");
  fs.cpSync(project, historicalProject, { recursive: true });
  const historicalProposalRef = {
    id: "ASSESSMENT-UNRELATED",
    hash: unrelatedProposalHash,
  };
  const historicalAuthorizationPath = path.join(
    historicalProject,
    ".sdlc",
    "authorizations",
    `${authorization.id}.json`,
  );
  const historicalAuthorization = JSON.parse(
    fs.readFileSync(historicalAuthorizationPath, "utf8"),
  );
  historicalAuthorization.proposal_ref = historicalProposalRef;
  historicalAuthorization.approved_content_hash = legacyAuthorizationContentHash(
    historicalAuthorization,
  );
  fs.writeFileSync(
    historicalAuthorizationPath,
    `${JSON.stringify(historicalAuthorization, null, 2)}\n`,
    "utf8",
  );
  const historicalUsePath = path.join(
    historicalProject,
    completion.step.authorization_use_ref,
  );
  const historicalUse = JSON.parse(fs.readFileSync(historicalUsePath, "utf8"));
  historicalUse.proposal_ref = historicalProposalRef;
  historicalUse.authorization_hash = historicalAuthorization.approved_content_hash;
  historicalUse.receipt_hash = lifecycleReceiptHash(historicalUse);
  fs.writeFileSync(
    historicalUsePath,
    `${JSON.stringify(historicalUse, null, 2)}\n`,
    "utf8",
  );
  const historicalGate = mustFail([
    "gate", "check",
    "--root", historicalProject,
    "--scope", "story",
    "--story", "ST-OPTIONAL-AUTH",
    "--strict",
    "--json",
  ], /proposal binding mismatch.*ASSESSMENT-UNRELATED.*expects no proposal binding/isu);
  const historicalReport = JSON.parse(historicalGate.stdout);
  assert.ok(historicalReport.errors.some((error) =>
    /Authorization AUTH-ST-OPTIONAL-AUTH-IMPLEMENTATION proposal binding mismatch/iu.test(error)));
  assert.ok(historicalReport.errors.some((error) =>
    /authorization usage receipt .* proposal binding mismatch.*recorded use has proposal ASSESSMENT-UNRELATED/iu
      .test(error)));

  fs.rmSync(path.join(project, completion.step.authorization_use_ref));
  mustFail([
    "gate", "check",
    "--root", project,
    "--scope", "story",
    "--story", "ST-OPTIONAL-AUTH",
    "--strict",
  ], /story step ST-OPTIONAL-AUTH\/implementation references missing authorization use receipt/u);
});
