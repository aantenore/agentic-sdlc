import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { configStatusCommand } from "../../lib/engine/guidance.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(repoRoot, "bin", "agentic-sdlc.mjs");

test("an uninitialized repository is guided to onboarding, not destructive-looking init", (context) => {
  const root = temporaryRoot(context, "existing");
  fs.writeFileSync(path.join(root, "README.md"), "# Existing project\n");

  const result = runStatus(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /already contains project files/u);
  assert.match(result.stderr, /onboard existing-project/u);
  assert.match(result.stderr, /reviewable baseline/u);
});

test("an empty project is guided to init", (context) => {
  const root = temporaryRoot(context, "empty");

  const result = runStatus(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /new empty project/u);
  assert.match(result.stderr, /agentic-sdlc init/u);
  assert.doesNotMatch(result.stderr, /onboard existing-project/u);
});

test("an initialized repository with evidence and no completed work is still guided to onboarding", (context) => {
  const root = temporaryRoot(context, "initialized-existing");
  const initialized = runCli(root, [
    "init",
    "--root", root,
    "--project-name", "First local project",
  ]);
  assert.equal(initialized.status, 0, initialized.stderr);
  fs.writeFileSync(path.join(root, "README.md"), "# First local project\n");

  const result = runStatus(root);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.summary.completed_work, 0);
  assert.equal(payload.next_action.kind, "onboard_project");
  assert.equal(payload.next_action.reason, "project_context_not_onboarded");
});

test("doctor prints the recovery command its config guidance refers to", (context) => {
  const root = temporaryRoot(context, "doctor-uninitialized");

  const human = runCli(root, ["doctor"]);
  assert.match(human.stdout, /N\/A effective-config: .*optional details\. Initialization command: agentic-sdlc init/u);

  const payload = JSON.parse(runCli(root, ["doctor", "--json"]).stdout);
  const check = payload.checks.find((entry) => entry.id === "effective-config");
  assert.equal(check.status, "not_applicable");
  assert.match(check.details, /Initialization command: agentic-sdlc init/u);

  assert.deepEqual(configStatusCommand("drifted"), { label: "Preview command", command: "agentic-sdlc config migrate" });
  assert.deepEqual(configStatusCommand("legacy_compat"), { label: "Preview command", command: "agentic-sdlc config migrate" });
  assert.equal(configStatusCommand("locked"), null);
});

test("doctor prints the config diagnosis its invalid-config guidance refers to", (context) => {
  const root = temporaryRoot(context, "doctor-invalid");
  const initialized = runCli(root, ["init", "--root", root, "--project-name", "Doctor invalid project"]);
  assert.equal(initialized.status, 0, initialized.stderr);
  const configPath = path.join(root, ".sdlc", "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.phase_order = 42;
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const result = runCli(root, ["doctor", "--json"]);
  assert.equal(result.status, 1, result.stderr);
  const check = JSON.parse(result.stdout).checks.find((entry) => entry.id === "effective-config");
  assert.equal(check.status, "failed");
  assert.match(check.details, /optional diagnosis.*Config validation: .*\$\.phase_order: must be array/u);
});

test("doctor without --root checks the project in the current directory", (context) => {
  const root = temporaryRoot(context, "doctor-cwd");
  const initialized = runCli(root, ["init", "--root", root, "--project-name", "Doctor cwd project"]);
  assert.equal(initialized.status, 0, initialized.stderr);

  const payload = JSON.parse(runCli(root, ["doctor", "--json"]).stdout);
  assert.equal(fs.realpathSync(payload.project_root), fs.realpathSync(root));
  assert.equal(payload.checks.find((entry) => entry.id === "effective-config").status, "passed");
  assert.equal(payload.checks.find((entry) => entry.id === "project-kb").status, "passed");
  assert.equal(payload.checks.find((entry) => entry.id === "output-registry").status, "passed");
});

function temporaryRoot(context, suffix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `sdlc-initial-guidance-${suffix}-`));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function runStatus(root) {
  return runCli(root, [
    "status",
    "--root", root,
    "--json",
  ]);
}

function runCli(root, args) {
  return spawnSync(process.execPath, [
    cli,
    ...args,
  ], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
  });
}
