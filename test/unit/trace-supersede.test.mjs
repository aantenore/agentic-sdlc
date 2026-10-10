import "../helpers/test-isolation.mjs";

import test, { after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { evidenceSupersedeHash } from "../../lib/engine/evidence-supersede-records.mjs";
import {
  findReleaseSupersedingLine,
  resolveReleaseSupersedeTarget,
} from "../../lib/engine/trace-supersede.mjs";
import { sealTraceEvent } from "../../lib/trace-integrity.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cliPath = path.join(repoRoot, "bin", "agentic-sdlc.mjs");
const tempDirs = new Set();

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function runCli(args) {
  const env = { ...process.env };
  for (const key of ["CI", "GITHUB_ACTIONS", "CODEX_AGENT_NAME", "CLAUDECODE", "AGENTIC_SDLC_AGENT_HOST", "NODE_OPTIONS"]) {
    delete env[key];
  }
  return spawnSync(process.execPath, [cliPath, ...args], { cwd: repoRoot, encoding: "utf8", env, timeout: 60_000 });
}

function mustRun(args) {
  const result = runCli(args);
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result;
}

function mustFail(args) {
  const result = runCli(args);
  assert.notEqual(result.status, 0, `${args.join(" ")} unexpectedly passed\n${result.stdout}`);
  return result;
}

function project(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `agentic-sdlc-trace-supersede-${name}-`));
  tempDirs.add(dir);
  mustRun(["init", "--root", dir, "--project-name", "Trace supersede fixture", "--force", "--json"]);
  return dir;
}

function createStory(dir, storyId) {
  mustRun(["story", "create", "--root", dir, "--id", storyId, "--title", "Fixture", "--acceptance", "Works", "--json"]);
}

function sealDefectiveRelease(dir, storyId) {
  const tracesRoot = path.join(dir, ".sdlc", "traces");
  sealTraceEvent({
    boundaryRoot: tracesRoot,
    tracePath: path.join(tracesRoot, `${storyId}.jsonl`),
    checkpointPath: path.join(tracesRoot, ".integrity", `${storyId}.jsonl.checkpoint.json`),
    event: {
      id: "TR-DEFECT-1",
      story_id: storyId,
      type: "release",
      summary: "Release without evidence",
      outcome: "passed",
      actor: { id: "tester", type: "agent", name: "Tester", email: null, source: "test" },
      action: "release",
      evidence: [],
      related: [],
      git: { is_git_repo: false },
      run: { tool: "test" },
      created_at: "2026-10-10T00:00:00.000Z",
    },
  });
}

function gate(dir) {
  return JSON.parse(runCli(["gate", "check", "--root", dir, "--strict", "--json"]).stdout);
}

test("release trace without evidence is refused at append time", () => {
  const dir = project("refuse");
  createStory(dir, "ST-REL-1");
  const result = mustFail(["trace", "append", "--root", dir, "--type", "release", "--story", "ST-REL-1", "--summary", "No proof"]);
  assert.match(result.stderr + result.stdout, /requires at least one --evidence path/u);
});

test("a corrective release supersedes only an evidence-less release line", () => {
  const dir = project("correct");
  const storyId = "ST-REL-2";
  createStory(dir, storyId);
  sealDefectiveRelease(dir, storyId);
  const before = gate(dir);
  assert.equal(before.errors.some((e) => e.includes(`${storyId}.jsonl:1 release trace requires at least one evidence path`)), true);

  fs.writeFileSync(path.join(dir, "merge.txt"), "merged\n");
  const base = ["trace", "append", "--root", dir, "--story", storyId, "--summary", "Merge proof", "--outcome", "passed", "--evidence", "merge.txt", "--json"];
  mustFail([...base, "--type", "test", "--supersedes-line", "1"]);
  mustFail([...base, "--type", "release", "--supersedes-line", "9"]);
  mustFail([...base, "--type", "release", "--supersedes-line", "abc"]);
  const appended = JSON.parse(mustRun([...base, "--type", "release", "--supersedes-line", "1"]).stdout);
  assert.deepEqual(
    { line: appended.event.supersedes.line, id: appended.event.supersedes.event_id },
    { line: 1, id: "TR-DEFECT-1" },
  );
  mustFail([...base, "--type", "release", "--supersedes-line", "1"]);
  mustFail([...base, "--type", "release", "--supersedes-line", "2"]);

  const after = gate(dir);
  assert.equal(after.errors.some((e) => e.includes("requires at least one evidence path")), false, after.errors.join("\n"));
  assert.equal(after.warnings.some((w) => w.includes(`${storyId}.jsonl:1 release trace without evidence is superseded by line 2`)), true);
});

test("supersede references must match story, line and event id", () => {
  const records = [
    { line: 1, valid: true, event: { id: "A", story_id: "S", type: "release", evidence: [] } },
    { line: 2, valid: true, event: { id: "B", story_id: "S", type: "release", evidence: ["x"], supersedes: { schema_version: "trace-supersedes:v1", line: 1, event_id: "A" } } },
    { line: 3, valid: true, event: { id: "C", story_id: "S", type: "release", evidence: [], supersedes: { schema_version: "trace-supersedes:v1", line: 1, event_id: "A" } } },
    { line: 4, valid: true, event: { id: "D", story_id: "S", type: "test", evidence: [] } },
    { line: 5, valid: true, event: { id: "E", story_id: "S", type: "release", evidence: ["x"], supersedes: { schema_version: "trace-supersedes:v1", line: 4, event_id: "D" } } },
  ];
  assert.equal(findReleaseSupersedingLine(records, records[0])?.line, 2);
  assert.equal(findReleaseSupersedingLine(records, records[3]), null);
  const wrongId = [records[0], { ...records[1], event: { ...records[1].event, supersedes: { ...records[1].event.supersedes, event_id: "Z" } } }];
  assert.equal(findReleaseSupersedingLine(wrongId, records[0]), null);
  assert.match(resolveReleaseSupersedeTarget(path.join(os.tmpdir(), "missing-trace.jsonl"), "S", "1").error, /does not exist/u);
});

test("a person's evidence supersede is honored by the trace drift check", () => {
  const dir = project("drift");
  fs.mkdirSync(path.join(dir, "evidence"), { recursive: true });
  fs.writeFileSync(path.join(dir, "evidence", "proof.txt"), "original proof\n");
  const appended = JSON.parse(mustRun([
    "trace", "append", "--root", dir, "--type", "test", "--summary", "Proof", "--outcome", "passed",
    "--evidence", "evidence/proof.txt", "--json",
  ]).stdout);
  const refPath = appended.event.evidence_refs[0].path;
  const filePath = path.join(dir, ...refPath.split("/"));
  const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");
  const isDrift = (report) => report.errors.some((e) => e.includes(`evidence content drift detected for ${refPath}`));

  fs.writeFileSync(filePath, "overwritten later\n");
  assert.equal(isDrift(gate(dir)), true);

  const write = (overrides) => {
    const base = {
      id: "AUT-EVSUP-TEST",
      kind: "delivery_evidence_supersede_record",
      schema_version: "delivery-evidence-supersede:v1",
      receipt_ref: { id: "AUT-ACT-1", hash: "0".repeat(64) },
      evidence: { path: refPath, recorded_sha256: appended.event.evidence_refs[0].sha256, current_sha256: sha("overwritten later\n") },
      reason: "overwritten by a script defect",
      recorded_by: { id: "alice", type: "human" },
      recorded_at: "2026-10-10T00:00:00.000Z",
      ...overrides,
    };
    const record = { ...base, record_hash: evidenceSupersedeHash(base), hash_algorithm: "sha256:stable-json:v1" };
    const root = path.join(dir, ".sdlc", "autonomy", "executions", "AUT-PR-1", "evidence-supersede");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "AUT-EVSUP-TEST.json"), `${JSON.stringify(record, null, 2)}\n`);
  };

  write({ recorded_by: { id: "bot", type: "agent" } });
  assert.equal(isDrift(gate(dir)), true, "an agent-recorded supersede must not relax the check");
  write({});
  const honored = gate(dir);
  assert.equal(isDrift(honored), false, honored.errors.join("\n"));
  assert.equal(honored.warnings.some((w) => w.includes(`evidence ${refPath} superseded by a person`)), true);

  fs.writeFileSync(filePath, "changed again\n");
  assert.equal(isDrift(gate(dir)), true, "a further change after the supersede is drift again");
});

test("a person's trace-bound evidence supersede is honored by the trace drift check", () => {
  const dir = project("trace-bound");
  fs.mkdirSync(path.join(dir, "evidence"), { recursive: true });
  fs.writeFileSync(path.join(dir, "evidence", "build.log"), "line one\r\nline two\r\n");
  const appended = JSON.parse(mustRun([
    "trace", "append", "--root", dir, "--type", "test", "--summary", "Build", "--outcome", "passed",
    "--evidence", "evidence/build.log", "--json",
  ]).stdout);
  const refPath = appended.event.evidence_refs[0].path;
  fs.writeFileSync(path.join(dir, ...refPath.split("/")), "line one\nline two\n");
  const isDrift = (report) => report.errors.some((e) => e.includes(`evidence content drift detected for ${refPath}`));
  assert.equal(isDrift(gate(dir)), true);

  const base = {
    id: "AUT-EVSUP-TR",
    kind: "delivery_evidence_supersede_record",
    schema_version: "delivery-evidence-supersede:v1",
    trace_ref: { id: appended.event.id, story_id: appended.event.story_id },
    evidence: {
      path: refPath,
      recorded_sha256: appended.event.evidence_refs[0].sha256,
      current_sha256: crypto.createHash("sha256").update("line one\nline two\n").digest("hex"),
    },
    reason: "line endings converted by a rebase",
    recorded_by: { id: "alice", type: "human" },
    recorded_at: "2026-10-10T00:00:00.000Z",
  };
  const record = { ...base, record_hash: evidenceSupersedeHash(base), hash_algorithm: "sha256:stable-json:v1" };
  const root = path.join(dir, ".sdlc", "autonomy", "trace-evidence-supersede");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "AUT-EVSUP-TR.json"), `${JSON.stringify(record, null, 2)}\n`);
  const honored = gate(dir);
  assert.equal(isDrift(honored), false, honored.errors.join("\n"));
  assert.equal(honored.warnings.some((w) => w.includes(`evidence ${refPath} superseded by a person`)), true);
});

test("evidence files are declared not text-converted, once", async () => {
  const { ensureEvidenceGitattributes, EVIDENCE_GITATTRIBUTES_RULE } = await import("../../lib/engine/evidence-eol.mjs");
  const dir = project("eol");
  const target = path.join(dir, ".gitattributes");
  fs.writeFileSync(target, "* text=auto");
  assert.equal(ensureEvidenceGitattributes({ root: dir }), true);
  assert.equal(ensureEvidenceGitattributes({ root: dir }), false);
  assert.equal(fs.readFileSync(target, "utf8"), `* text=auto\n${EVIDENCE_GITATTRIBUTES_RULE}\n`);
});
