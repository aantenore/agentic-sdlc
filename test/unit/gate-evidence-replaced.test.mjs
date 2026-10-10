import "../helpers/test-isolation.mjs";

import test, { after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { validateDeliveryActionEvidence } from "../../lib/engine/delivery.mjs";
import { preserveReplacedGateEvidence as preserve } from "../../lib/engine/story.mjs";
import { runWithMutationGovernance } from "../../lib/governance/mutation-guard.mjs";

const tempDirs = new Set();
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

const preserveReplacedGateEvidence = (context, gate) =>
  runWithMutationGovernance({ mode: "disabled", root: context.root }, () => preserve(context, gate));
const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-evidence-"));
  tempDirs.add(root);
  fs.mkdirSync(path.join(root, ".sdlc", "gates"), { recursive: true });
  const git = (...args) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  return { root, git, gate: path.join(root, ".sdlc", "gates", "ST-X-strict.json") };
}

function check(root, evidencePath, recorded) {
  const report = { errors: [], warnings: [] };
  validateDeliveryActionEvidence(
    { root, sdlcRoot: path.join(root, ".sdlc") },
    report,
    { id: "AUT-ACT-1" },
    "pull_request.create receipt AUT-ACT-1",
    { path: evidencePath, sha256: recorded },
    "evidence changed after recording",
  );
  return report;
}

test("a gate rerun keeps the cited gate file verifiable through its content-addressed copy", () => {
  const { root, gate } = project();
  const first = '{"checked_at":"1"}\n';
  fs.writeFileSync(gate, first);
  const recorded = sha(first);
  preserveReplacedGateEvidence({ root }, gate);
  fs.writeFileSync(gate, '{"checked_at":"2"}\n');
  preserveReplacedGateEvidence({ root }, gate);
  preserveReplacedGateEvidence({ root }, gate);
  const report = check(root, ".sdlc/gates/ST-X-strict.json", recorded);
  assert.deepEqual(report.errors, []);
  assert.equal(report.warnings.length, 1);
  assert.equal(fs.readdirSync(path.join(root, ".sdlc", "gates", "history")).length, 2);
});

test("a gate file rewritten before the copy existed is verified from Git history", () => {
  const { root, git, gate } = project();
  const first = '{"checked_at":"1"}\n';
  fs.writeFileSync(gate, first);
  git("add", "-A");
  git("commit", "-q", "-m", "records");
  const recorded = sha(first);
  fs.writeFileSync(gate, '{"checked_at":"2"}\n');
  assert.deepEqual(check(root, ".sdlc/gates/ST-X-strict.json", recorded).errors, []);
});

test("a gate file with unrecoverable content is still reported as changed", () => {
  const { root, gate } = project();
  fs.writeFileSync(gate, '{"checked_at":"2"}\n');
  const report = check(root, ".sdlc/gates/ST-X-strict.json", sha("never stored"));
  assert.equal(report.errors.length, 1);
  assert.match(report.errors[0], /evidence changed after recording/u);
});
