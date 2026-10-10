import "./helpers/test-isolation.mjs";

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repoRoot, "bin/agentic-sdlc.mjs");

function run(project, args) {
  return spawnSync(process.execPath, [cli, ...args, "--root", project], { encoding: "utf8", timeout: 60_000 });
}

test("validate reports an output id repeated in the registry", () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-registry-dup-")));
  const init = run(project, ["init", "--project-name", "Duplicates fixture"]);
  assert.equal(init.status, 0, init.stderr);
  const registryPath = path.join(project, ".sdlc/output-contracts/registry.json");
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  const template = { id: "TPL-DUP", type: "report", status: "draft", path: "missing.md" };
  registry.templates.push(template, { ...template, updated_at: "2099-01-01T00:00:00Z" });
  fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  const result = run(project, ["gate", "check", "--strict"]);
  assert.match(`${result.stdout}${result.stderr}`, /entries with id .*keep the most recent/u);
});
