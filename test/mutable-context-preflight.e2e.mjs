import "./helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPOSITORY_ROOT, "bin", "agentic-sdlc.mjs");
const TEMPORARY_PROJECTS = new Set();

after(() => {
  if (process.env.AGENTIC_SDLC_KEEP_TEST_TMP === "1") return;
  for (const project of TEMPORARY_PROJECTS) {
    fs.rmSync(project, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
  TEMPORARY_PROJECTS.clear();
});

function temporaryProject(label) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), `agentic-sdlc-mutable-context-${label}-`));
  TEMPORARY_PROJECTS.add(project);
  return project;
}

function run(args, project, options = {}) {
  const env = { ...process.env };
  for (const key of ["CI", "GITHUB_ACTIONS", "GITHUB_ACTOR", "CODEX_AGENT_NAME", "CODEX_USER_ID", "CLAUDECODE", "AGENTIC_SDLC_AGENT_HOST"]) {
    delete env[key];
  }
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
  assert.equal(result.signal, null, `${args.join(" ")} terminated by ${result.signal}`);
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

function mustFail(args, project, pattern, options = {}) {
  const result = run(args, project, options);
  assert.equal(result.error, undefined, `${args.join(" ")} failed to execute: ${result.error?.message}`);
  assert.equal(result.signal, null, `${args.join(" ")} terminated by ${result.signal}`);
  assert.notEqual(result.status, 0, `${args.join(" ")} unexpectedly passed\n${result.stdout}`);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    pattern,
    `${args.join(" ")}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
  );
  return result;
}

function mustGit(project, args) {
  const result = spawnSync("git", ["-C", project, ...args], {
    encoding: "utf8",
    timeout: 30_000,
  });
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
  return [
    "--actor-type", "human",
    "--approval-source", "explicit-user",
    "--summary", summary,
  ];
}

function implementationIntent() {
  return JSON.stringify({
    requested_action: "implement_story",
    confidence: 0.99,
    referenced_entities: [{ type: "story", id: "ST-BROWNFIELD" }],
    provided_artifacts: [],
    missing_context: [],
    proposed_phase: "implementation",
    artifact_type: "implementation-summary",
    skip_phases: [],
  });
}

function establishBrownfieldGovernance(project) {
  writeProjectFile(
    project,
    "README.md",
    "# Brownfield local service\n\nThe service exposes a deterministic local status response.\n",
  );
  writeProjectFile(
    project,
    "src/app.mjs",
    "export function status() {\n  return { status: \"legacy\" };\n}\n",
  );
  writeProjectFile(
    project,
    "src/config.mjs",
    "export const timeoutMs = 1500;\n",
  );
  writeProjectFile(
    project,
    "package.json",
    `${JSON.stringify({ name: "brownfield-local-service", type: "module" }, null, 2)}\n`,
  );
  mustGit(project, ["init"]);
  mustGit(project, ["config", "user.name", "Mutable Context E2E"]);
  mustGit(project, ["config", "user.email", "mutable-context-e2e@example.invalid"]);
  mustGit(project, ["add", "."]);
  mustGit(project, ["commit", "-m", "test: establish brownfield project"]);
  mustGit(project, ["branch", "-M", "main"]);

  // A user's unrelated local edit exists before governance starts. It must not
  // be silently authorized, but it must also not make every later gate unusable
  // while its exact status and bytes remain unchanged.
  writeProjectFile(project, "src/config.mjs", "export const timeoutMs = 1750;\n");

  mustRun([
    "onboard", "existing-project",
    "--root", project,
    "--project-name", "Brownfield local service",
    "--document", "README.md",
    "--source", "src/app.mjs",
    "--source", "src/config.mjs",
  ], project);
  mustRun([
    "baseline", "approve",
    "--root", project,
    "--id", "BASELINE-INITIAL",
    ...humanApproval("The current brownfield project snapshot is accurate"),
  ], project);

  mustRun([
    "requirement", "propose",
    "--root", project,
    "--id", "REQ-BROWNFIELD",
    "--title", "Improve the local status response",
    "--summary", "Update the existing local status response and its concise project documentation.",
    "--acceptance", "The status response reports ready and the implementation summary records the change.",
    "--non-goal", "Do not modify the unrelated timeout configuration.",
    "--autonomy-ceiling", "checkpointed",
    "--source", "README.md",
    "--source", "src/app.mjs",
    "--write-path", "README.md",
    "--write-path", "src/app.mjs",
    "--write-path", "docs",
    "--write-path", ".local-release/app",
  ], project);
  mustRun([
    "requirement", "approve",
    "--root", project,
    "--id", "REQ-BROWNFIELD",
    ...humanApproval("Approve the exact brownfield outcome and write boundary"),
  ], project);

  mustRun([
    "output", "template", "propose",
    "--root", project,
    "--type", "implementation-summary",
    "--summary", "Concise evidence for the local brownfield implementation",
  ], project);
  mustRun([
    "output", "template", "approve",
    "--root", project,
    "--id", "implementation-summary-v1",
    ...humanApproval("Approve the implementation summary format"),
  ], project);

  mustRun([
    "story", "create", "--no-derived-verification",
    "--root", project,
    "--id", "ST-BROWNFIELD",
    "--title", "Implement the ready status",
    "--requirement", "REQ-BROWNFIELD",
    "--acceptance", "The local status response and implementation summary are updated.",
  ], project);

  mustRun([
    "capability", "profile", "propose",
    "--root", project,
    "--id", "CAP-PROFILE-ST-BROWNFIELD",
    "--story", "ST-BROWNFIELD",
    "--phase", "implementation",
    "--context-file", "README.md",
    "--context-file", "src/app.mjs",
  ], project);
  mustRun([
    "capability", "profile", "approve",
    "--root", project,
    "--id", "CAP-PROFILE-ST-BROWNFIELD",
    ...humanApproval("Approve the exact brownfield evidence used to select tools"),
  ], project);
  const recommendation = JSON.stringify({
    recommendations: [
      { type: "skill", name: "agentic-sdlc", availability: "available", install_required: false },
      { type: "mcp", name: "repo", availability: "available", install_required: false },
    ],
    policy_patch: {
      skills: { required: ["agentic-sdlc"], allowed: [], forbidden: [] },
      mcp: { required: ["repo"], allowed: [], forbidden: [] },
      tools: { required: [], allowed: [], forbidden: [] },
      approval_required_for: [],
    },
    bindings: [
      {
        type: "mcp",
        name: "repo",
        binding_id: "repo-main",
        target: { repo: "local" },
        permissions: ["read"],
      },
    ],
    execution_policy_suggestions: {
      reasoning: "medium",
      notes: ["Use the existing local repository evidence."],
    },
    decision_matrix: [{ option: "local repo", recommendation: "use" }],
  });
  mustRun([
    "capability", "recommend",
    "--root", project,
    "--id", "CAP-REC-ST-BROWNFIELD",
    "--profile", "CAP-PROFILE-ST-BROWNFIELD",
    "--recommendation-json", recommendation,
  ], project);
  mustRun([
    "capability", "approve",
    "--root", project,
    "--id", "CAP-REC-ST-BROWNFIELD",
    ...humanApproval("Approve the local repository capability boundary"),
  ], project);

  mustRun([
    "contract", "create",
    "--root", project,
    "--id", "CONTRACT-ST-BROWNFIELD-IMPLEMENTATION",
    "--story", "ST-BROWNFIELD",
    "--phase", "implementation",
    "--delivery-profile", "AUT-LOCAL-BROWNFIELD",
    "--level", "checkpointed",
    "--context-file", "README.md",
    "--context-file", "src/app.mjs",
    "--context-summary", "Update only the reviewed local service response and its evidence.",
    "--capability-recommendation", "CAP-REC-ST-BROWNFIELD",
    "--output-ref", "implementation-summary:implementation-summary-v1:new",
    "--validation", "The strict local governance gate accepts the implementation.",
  ], project);
  mustRun([
    "contract", "approve",
    "--root", project,
    "--id", "CONTRACT-ST-BROWNFIELD-IMPLEMENTATION",
    ...humanApproval("Approve the exact brownfield implementation agreement"),
  ], project);

  const releaseRoot = path.join(project, ".local-release");
  mustRun([
    "autonomy", "delivery", "propose",
    "--root", project,
    "--id", "AUT-LOCAL-BROWNFIELD",
    "--delivery", "LOCAL-BROWNFIELD",
    "--kind", "local_release",
    "--story", "ST-BROWNFIELD",
    "--contract", "CONTRACT-ST-BROWNFIELD-IMPLEMENTATION",
    "--requirement", "REQ-BROWNFIELD",
    "--level", "checkpointed",
    "--target-root", releaseRoot,
    "--write-path", "app",
    "--smoke-test", '["node","--version"]',
    "--rollback", "Remove the local build and restore the previous local snapshot.",
  ], project);
  mustRun([
    "autonomy", "delivery", "approve",
    "--root", project,
    "--id", "AUT-LOCAL-BROWNFIELD",
    "--phase", "implementation",
    ...humanApproval("Approve this exact local delivery boundary"),
  ], project);

  return {
    preflightPath: ".sdlc/autonomy/executions/AUT-LOCAL-BROWNFIELD/context-preflight.json",
    taskStartPath: ".sdlc/stories/ST-BROWNFIELD/task-start.json",
  };
}

function taskContextArgs(project) {
  return [
    "--root", project,
    "--intent-json", implementationIntent(),
    "--story", "ST-BROWNFIELD",
    "--phase", "implementation",
    "--contract-id", "CONTRACT-ST-BROWNFIELD-IMPLEMENTATION",
    "--delivery-profile", "AUT-LOCAL-BROWNFIELD",
  ];
}

test("approved brownfield context may evolve after an exact preflight while unrelated local edits remain immutable", () => {
  const project = temporaryProject("authorized-evolution");
  const fixture = establishBrownfieldGovernance(project);

  const preflight = mustRunJson([
    "task", "preflight",
    ...taskContextArgs(project),
  ], project);
  assert.equal(preflight.status, "passed");
  assert.equal(preflight.execution_allowed, true);
  assert.equal(fs.existsSync(path.join(project, fixture.preflightPath)), false);
  assert.ok(preflight.authorized_evolution_paths.includes("README.md"));
  assert.ok(preflight.authorized_evolution_paths.includes("src/app.mjs"));
  assert.ok(preflight.immutable_context_paths.includes("src/config.mjs"));
  assert.deepEqual(
    preflight.preexisting_workspace_changes.find((entry) => entry.path === "src/config.mjs"),
    {
      path: "src/config.mjs",
      status: " M",
      file_type: "regular",
      mode: fs.statSync(path.join(project, "src", "config.mjs")).mode & 0o7777,
      content_sha256: preflight.preexisting_workspace_changes.find(
        (entry) => entry.path === "src/config.mjs",
      ).content_sha256,
    },
  );

  const started = mustRunJson([
    "task", "start",
    ...taskContextArgs(project),
    "--confirm-start",
    "--actor-type", "human",
  ], project);
  assert.equal(started.execution_allowed, true);
  assert.equal(started.task_start_receipt, fixture.taskStartPath);
  assert.equal(fs.existsSync(path.join(project, fixture.preflightPath)), true);

  const taskStart = readJson(project, fixture.taskStartPath);
  const sealedPreflight = readJson(project, fixture.preflightPath);
  assert.equal(taskStart.execution_context_preflight_ref.path, fixture.preflightPath);
  assert.equal(taskStart.execution_context_preflight_ref.hash, sealedPreflight.receipt_hash);
  const appSnapshot = sealedPreflight.source_snapshots.find((source) => source.path === "src/app.mjs");
  assert.equal(appSnapshot.disposition, "authorized_evolution");
  assert.deepEqual(
    [...new Set(appSnapshot.bindings.map((binding) => binding.kind))].sort(),
    [
      "baseline",
      "capability_profile",
      "contract_context",
      "requirement",
    ],
  );

  mustRun([
    "story", "claim",
    "--root", project,
    "--id", "ST-BROWNFIELD",
    "--agent", "codex",
  ], project);
  writeProjectFile(
    project,
    "README.md",
    "# Brownfield local service\n\nThe service now exposes a deterministic ready status response.\n",
  );
  writeProjectFile(
    project,
    "src/app.mjs",
    "export function status() {\n  return { status: \"ready\" };\n}\n",
  );
  writeProjectFile(
    project,
    "docs/implementation-summary.md",
    "# Implementation summary\n\nThe local status response now reports ready.\n",
  );

  // Output linking re-validates the work brief and all capability sources.
  mustRun([
    "output", "link",
    "--root", project,
    "--story", "ST-BROWNFIELD",
    "--type", "implementation-summary",
    "--artifact", "docs/implementation-summary.md",
    "--template", "implementation-summary-v1",
    "--mode", "new",
    "--requirement", "REQ-BROWNFIELD",
  ], project);

  const capabilityStatus = mustRunJson([
    "capability", "status",
    "--root", project,
    "--story", "ST-BROWNFIELD",
  ], project);
  assert.equal(capabilityStatus.profiles.every((profile) => profile.fresh), true);
  assert.equal(capabilityStatus.recommendations.every((recommendation) => recommendation.fresh), true);

  const acceptedGate = mustRunJson([
    "gate", "check",
    "--root", project,
    "--scope", "story",
    "--story", "ST-BROWNFIELD",
    "--strict",
  ], project);
  assert.equal(acceptedGate.status, "passed");
  assert.equal(
    acceptedGate.errors.some((error) => /stale source|outside the approved requirement write paths/iu.test(error)),
    false,
  );
  assert.equal(
    acceptedGate.approval_requests.some((request) =>
      /capability_(?:profile|recommendation)_refresh_required/u.test(request.type)),
    false,
  );

  if (process.platform !== "win32") {
    const configPath = path.join(project, "src", "config.mjs");
    const originalConfigMode = fs.statSync(configPath).mode & 0o7777;
    fs.chmodSync(configPath, originalConfigMode ^ 0o100);
    mustFail([
      "gate", "check",
      "--root", project,
      "--scope", "story",
      "--story", "ST-BROWNFIELD",
      "--strict",
      "--json",
    ], project, /outside the approved requirement write paths: src\/config\.mjs/u);
    fs.chmodSync(configPath, originalConfigMode);
    assert.equal(mustRunJson([
      "gate", "check",
      "--root", project,
      "--scope", "story",
      "--story", "ST-BROWNFIELD",
      "--strict",
    ], project).status, "passed");
  }

  writeProjectFile(project, "src/config.mjs", "export const timeoutMs = 2000;\n");
  const rejectedGate = mustFail([
    "gate", "check",
    "--root", project,
    "--scope", "story",
    "--story", "ST-BROWNFIELD",
    "--strict",
    "--json",
  ], project, /outside the approved requirement write paths: src\/config\.mjs/u);
  const rejectedReport = JSON.parse(rejectedGate.stdout);
  assert.ok(rejectedReport.errors.some((error) =>
    error.includes("outside the approved requirement write paths: src/config.mjs")));
});

test("context drift before task start remains fail-closed and writes no preflight receipt", () => {
  const project = temporaryProject("pre-start-drift");
  const fixture = establishBrownfieldGovernance(project);
  fs.appendFileSync(path.join(project, "src", "app.mjs"), "\n// changed before start\n", "utf8");

  const failed = mustFail([
    "task", "preflight",
    ...taskContextArgs(project),
    "--json",
  ], project, /preflight failed|restore|approve a new/iu);
  const payload = JSON.parse(failed.stdout);
  assert.equal(payload.status, "failed");
  assert.equal(payload.execution_allowed, false);
  assert.equal(fs.existsSync(path.join(project, fixture.preflightPath)), false);
  assert.equal(fs.existsSync(path.join(project, fixture.taskStartPath)), false);
  assert.match(payload.recovery.join(" "), /restore|approve a new/iu);
});

test("a context symlink into derived state cannot reuse approved bytes", () => {
  const project = temporaryProject("derived-context-symlink");
  const fixture = establishBrownfieldGovernance(project);
  const appPath = path.join(project, "src", "app.mjs");
  const derivedPath = path.join(project, ".sdlc", "cache", "approved-app.mjs");
  fs.mkdirSync(path.dirname(derivedPath), { recursive: true });
  fs.copyFileSync(appPath, derivedPath);
  fs.rmSync(appPath);
  fs.symlinkSync("../.sdlc/cache/approved-app.mjs", appPath);

  mustFail([
    "task", "preflight",
    ...taskContextArgs(project),
    "--json",
  ], project, /symbolic link|symlink|derived/iu);
  assert.equal(fs.existsSync(path.join(project, fixture.preflightPath)), false);
  assert.equal(fs.existsSync(path.join(project, fixture.taskStartPath)), false);
});

test("a dirty submodule cannot be exempted as unchanged pre-existing workspace state", () => {
  const project = temporaryProject("dirty-submodule");
  const fixture = establishBrownfieldGovernance(project);
  const submoduleSource = temporaryProject("submodule-source");
  writeProjectFile(submoduleSource, "dependency.txt", "stable dependency\n");
  mustGit(submoduleSource, ["init"]);
  mustGit(submoduleSource, ["config", "user.name", "Mutable Context E2E"]);
  mustGit(submoduleSource, ["config", "user.email", "mutable-context-e2e@example.invalid"]);
  mustGit(submoduleSource, ["add", "."]);
  mustGit(submoduleSource, ["commit", "-m", "test: establish dependency"]);

  mustGit(project, [
    "-c", "protocol.file.allow=always",
    "submodule", "add", submoduleSource, "vendor/local-dependency",
  ]);
  mustGit(project, ["add", ".gitmodules", "vendor/local-dependency"]);
  mustGit(project, ["commit", "-m", "test: add local dependency"]);
  writeProjectFile(
    path.join(project, "vendor", "local-dependency"),
    "dependency.txt",
    "dirty dependency\n",
  );

  mustFail([
    "task", "preflight",
    ...taskContextArgs(project),
    "--json",
  ], project, /dirty directory or submodule/iu);
  assert.equal(fs.existsSync(path.join(project, fixture.preflightPath)), false);
  assert.equal(fs.existsSync(path.join(project, fixture.taskStartPath)), false);
});

test("files created after baseline approval make the baseline stale until it is refreshed", () => {
  const project = temporaryProject("uncovered-new-file");
  const fixture = establishBrownfieldGovernance(project);
  const baseline = readJson(project, ".sdlc/baseline/BASELINE-INITIAL.json");
  assert.deepEqual(baseline.source_discovery.requested_paths, ["src"]);
  assert.ok(baseline.source_discovery.policy.source_extensions.includes(".mjs"));

  // A file the earlier work added under a discovered root is invisible to the
  // hashed source list, so the next task must not start from the old snapshot.
  writeProjectFile(project, "src/feature.mjs", "export const feature = true;\n");
  const failed = mustFail([
    "task", "preflight",
    ...taskContextArgs(project),
    "--json",
  ], project, /baseline_not_ready/u);
  const blocked = JSON.parse(failed.stdout);
  assert.equal(blocked.execution_allowed, false);
  const refreshRequest = blocked.task_start.approval_requests
    .find((request) => request.type === "baseline_refresh_required");
  assert.match(JSON.stringify(refreshRequest), /src\/feature\.mjs/u);
  assert.equal(fs.existsSync(path.join(project, fixture.preflightPath)), false);

  const status = mustRunJson([
    "baseline", "status",
    "--root", project,
    "--id", "BASELINE-INITIAL",
  ], project);
  assert.match(JSON.stringify(status), /src\/feature\.mjs/u);

  // An approved baseline is never replaced in place; the refresh records the
  // current state as its successor and asks for review of the manual change.
  mustFail([
    "baseline", "propose",
    "--root", project,
    "--id", "BASELINE-INITIAL",
    "--source", "src",
    "--force",
  ], project, /never replaced in place/u);
  const refreshed = mustRunJson([
    "baseline", "refresh",
    "--root", project,
    "--from", "BASELINE-INITIAL",
    "--summary", "The project now includes the feature module.",
    // The fixture keeps local edits that were never committed; recording them
    // as they are is an explicit choice for the person's review.
    "--allow-uncommitted-changes",
  ], project);
  assert.equal(refreshed.status, "proposed");
  assert.deepEqual(refreshed.unexplained, [{ path: "src/feature.mjs", change: "added" }]);
  const successor = readJson(project, ".sdlc/baseline/BASELINE-INITIAL-R2.json");
  assert.ok(successor.source_paths.includes("src/feature.mjs"));
  mustRun([
    "baseline", "approve",
    "--root", project,
    "--id", "BASELINE-INITIAL-R2",
    ...humanApproval("The refreshed snapshot includes the feature module"),
  ], project);
});

test("a file created by the started task inside its write scope keeps the baseline usable", () => {
  const project = temporaryProject("authorized-new-file");
  establishBrownfieldGovernance(project);
  mustRun([
    "task", "start",
    ...taskContextArgs(project),
    "--confirm-start",
    "--actor-type", "human",
  ], project);
  mustRun([
    "story", "claim",
    "--root", project,
    "--id", "ST-BROWNFIELD",
    "--agent", "codex",
  ], project);
  writeProjectFile(project, "src/app.mjs", "export function status() {\n  return { status: \"ready\" };\n}\n");
  writeProjectFile(project, "docs/implementation-summary.md", "# Implementation summary\n\nReady.\n");
  mustRun([
    "output", "link",
    "--root", project,
    "--story", "ST-BROWNFIELD",
    "--type", "implementation-summary",
    "--artifact", "docs/implementation-summary.md",
    "--template", "implementation-summary-v1",
    "--mode", "new",
    "--requirement", "REQ-BROWNFIELD",
  ], project);
  const gateArgs = ["gate", "check", "--root", project, "--scope", "story", "--story", "ST-BROWNFIELD", "--strict"];
  assert.equal(mustRunJson(gateArgs, project).status, "passed");

  // src/config.mjs is outside the requirement write scope, so a sibling file
  // created there by the task is still reported against the baseline.
  writeProjectFile(project, "src/extra.mjs", "export const extra = 1;\n");
  mustFail([...gateArgs, "--json"], project, /does not describe src\/extra\.mjs/u);
});
