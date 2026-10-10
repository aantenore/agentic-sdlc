import "../helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(repoRoot, "bin/agentic-sdlc.mjs");

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 60_000 });
}

function project() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-existing-file-")));
  const initialized = run(["init", "--root", root, "--project-name", "Existing file"]);
  assert.equal(initialized.status, 0, initialized.stderr);
  return root;
}

test("a refused report overwrite names the project-relative path and suggests --force", () => {
  const root = project();
  const args = ["report", "activity", "--root", root, "--out", ".sdlc/reports/a.json"];
  assert.equal(run(args).status, 0);
  const refused = run([...args, "--json"]);
  assert.equal(refused.status, 1);
  const { error } = JSON.parse(refused.stderr);
  assert.equal(error.message, "File already exists: .sdlc/reports/a.json. Use --force to overwrite it.");
  assert.equal(refused.stderr.includes(root), false);
  assert.equal(run([...args, "--force"]).status, 0);
});

test("a refused immutable record overwrite does not suggest --force", () => {
  const root = project();
  const propose = (title) => run([
    "requirement", "propose", "--root", root, "--id", "REQ-X-001", "--title", title,
    "--summary", "Outcome", "--acceptance", "Observable", "--autonomy-ceiling", "supervised", "--force",
  ]);
  assert.equal(propose("First").status, 0);
  const refused = propose("Second");
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /File already exists: \.sdlc\/requirements\/REQ-X-001\.json\. Use a new immutable record id\./u);
  assert.doesNotMatch(refused.stderr, /--force/u);
  assert.equal(refused.stderr.includes(root), false);
});
