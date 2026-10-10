import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "bin", "agentic-sdlc.mjs");
const HUMAN = ["--actor-type", "human", "--approval-source", "explicit-user", "--summary", "Approved"];

function run(cwd, args) {
  return spawnSync(process.execPath, [CLI, ...args, "--root", cwd], { cwd, encoding: "utf8" });
}

function mustRun(cwd, args) {
  const result = run(cwd, args);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

test("a revision that rewrites the same source supersedes its parent and its unstarted stories move to it", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-sdlc-req-supersede-"));
  mustRun(cwd, ["init", "--project-name", "Same source supersession"]);
  fs.mkdirSync(path.join(cwd, "docs"));
  const source = path.join(cwd, "docs", "req.md");
  fs.writeFileSync(source, "first wording\n");
  mustRun(cwd, [
    "requirement", "propose", "--id", "REQ-ORCH", "--title", "Orchestrator",
    "--summary", "First", "--acceptance", "Works", "--autonomy-ceiling", "supervised",
    "--source", "docs/req.md",
  ]);
  mustRun(cwd, ["requirement", "approve", "--id", "REQ-ORCH", ...HUMAN]);
  mustRun(cwd, [
    "story", "create", "--no-derived-verification", "--id", "ST-OLD", "--title", "Old story",
    "--requirement", "REQ-ORCH", "--acceptance", "Old behavior works",
  ]);

  fs.writeFileSync(source, "revised wording\n");
  mustRun(cwd, [
    "requirement", "revise", "--id", "REQ-ORCH", "--new-id", "REQ-ORCH-R2",
    "--source", "docs/req.md", "--summary", "Second",
  ]);
  mustRun(cwd, ["requirement", "approve", "--id", "REQ-ORCH-R2", ...HUMAN]);
  const superseded = JSON.parse(mustRun(cwd, [
    "requirement", "supersede", "--id", "REQ-ORCH", "--new-id", "REQ-ORCH-R2",
    "--reason", "Revised in place", ...HUMAN, "--json",
  ]).stdout);
  assert.equal(superseded.status, "superseded");
  assert.deepEqual(superseded.stories_bound_to_superseded, ["ST-OLD"]);

  mustRun(cwd, [
    "story", "create", "--no-derived-verification", "--id", "ST-NEW", "--title", "New story",
    "--requirement", "REQ-ORCH-R2", "--acceptance", "New behavior works",
  ]);
  mustRun(cwd, ["story", "supersede", "--id", "ST-OLD", "--by", "ST-NEW", "--reason", "Moved to R2", ...HUMAN]);
});

test("the replacement revision must still be source-fresh", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-sdlc-req-supersede-stale-"));
  mustRun(cwd, ["init", "--project-name", "Stale replacement"]);
  fs.mkdirSync(path.join(cwd, "docs"));
  const source = path.join(cwd, "docs", "req.md");
  fs.writeFileSync(source, "first wording\n");
  mustRun(cwd, [
    "requirement", "propose", "--id", "REQ-S", "--title", "S", "--summary", "First",
    "--acceptance", "Works", "--autonomy-ceiling", "supervised", "--source", "docs/req.md",
  ]);
  mustRun(cwd, ["requirement", "approve", "--id", "REQ-S", ...HUMAN]);
  fs.writeFileSync(source, "revised wording\n");
  mustRun(cwd, ["requirement", "revise", "--id", "REQ-S", "--new-id", "REQ-S-R2", "--source", "docs/req.md", "--summary", "Second"]);
  mustRun(cwd, ["requirement", "approve", "--id", "REQ-S-R2", ...HUMAN]);
  fs.writeFileSync(source, "unreviewed wording\n");
  const rejected = run(cwd, [
    "requirement", "supersede", "--id", "REQ-S", "--new-id", "REQ-S-R2", "--reason", "r", ...HUMAN,
  ]);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr + rejected.stdout, /Replacement requirement REQ-S-R2 has stale source evidence/u);
});
