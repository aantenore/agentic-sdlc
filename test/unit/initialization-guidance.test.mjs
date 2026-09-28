import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

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

test("a freshly git-initialized folder with no files is still guided to init", (context) => {
  const root = temporaryRoot(context, "git-only");
  fs.mkdirSync(path.join(root, ".git"));
  fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");

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
