import "./helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { sealDelegationRecord } from "../lib/approval-delegation.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repoRoot, "bin", "agentic-sdlc.mjs");
const projects = new Set();

after(() => {
  for (const project of projects) fs.rmSync(project, { recursive: true, force: true });
});

function run(args) {
  const env = { ...process.env };
  for (const key of ["CI", "GITHUB_ACTIONS", "GITHUB_ACTOR", "CODEX_AGENT_NAME", "CODEX_THREAD_ID", "CODEX_USER_ID", "CLAUDECODE", "AGENTIC_SDLC_AGENT_HOST"]) delete env[key];
  delete env.AGENTIC_SDLC_MAIN_THREAD;
  return spawnSync(process.execPath, [cli, ...args], { cwd: repoRoot, encoding: "utf8", env, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
}

function mustRun(args) {
  const result = run(args);
  assert.equal(result.status, 0, `${args.join(" ")}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result;
}

function mustFail(args, pattern) {
  const result = run(args);
  assert.notEqual(result.status, 0, `${args.join(" ")} unexpectedly succeeded:\n${result.stdout}`);
  assert.match(`${result.stdout}\n${result.stderr}`, pattern);
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const delegated = (id) => ["--actor-type", "agent", "--approval-source", "delegated", "--delegation", id];

function project(name) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `sdlc-delegated-${name}-`)));
  projects.add(root);
  mustRun(["init", "--root", root, "--project-name", "Delegated approvals fixture"]);
  return root;
}

function grant(root, id, actions) {
  mustRun([
    "autonomy", "delegation", "grant", "--root", root, "--id", id, "--scope", "project", "--actions", actions, "--until", "30d",
    "--summary", "Agent may apply these approvals", "--actor-type", "human", "--approval-source", "explicit-user", "--actor-name", "Antonio",
  ]);
}

/** Re-seals a granted delegation as already expired (a valid hash, an end in the past). */
function expire(root, id) {
  const file = path.join(root, ".sdlc", "autonomy", "delegations", id, "delegation.json");
  const record = readJson(file);
  fs.writeFileSync(file, `${JSON.stringify(sealDelegationRecord({ ...record, expires_at: "2020-01-01T00:00:00.000Z" }), null, 2)}\n`);
}

test("baseline.approve: a delegation lets the agent approve a baseline; none or an expired one is refused", () => {
  const root = project("baseline");
  fs.writeFileSync(path.join(root, "README.md"), "# Fixture\n");
  const propose = (id) => mustRun(["baseline", "propose", "--root", root, "--id", id, "--document", "README.md", "--summary", "Current state"]);
  const approve = (id, extra) => ["baseline", "approve", "--root", root, "--id", id, ...extra, "--summary", "Snapshot is accurate"];
  propose("BASELINE-A");
  mustFail(approve("BASELINE-A", ["--actor-type", "agent", "--approval-source", "explicit-user"]), /human/u);
  mustFail(approve("BASELINE-A", ["--actor-type", "agent", "--approval-source", "delegated"]), /needs --delegation/u);
  grant(root, "DLG-OTHER", "breakdown.approve");
  mustFail(approve("BASELINE-A", delegated("DLG-OTHER")), /does not cover the action baseline\.approve/u);

  grant(root, "DLG-BASE", "baseline.approve");
  mustRun(approve("BASELINE-A", delegated("DLG-BASE")));
  const baseline = readJson(path.join(root, ".sdlc", "baseline", "BASELINE-A.json"));
  assert.equal(baseline.approvals.at(-1).approval_source, "delegated");
  assert.equal(baseline.approvals.at(-1).approved_by.type, "agent");

  propose("BASELINE-B");
  expire(root, "DLG-BASE");
  mustFail(approve("BASELINE-B", delegated("DLG-BASE")), /expired/u);
});

test("story.supersede: a delegation lets the agent supersede one story; none or an expired one is refused", () => {
  const root = project("supersede");
  const createdAt = new Date().toISOString();
  fs.writeFileSync(path.join(root, ".sdlc", "requirements", "REQ-001.json"), `${JSON.stringify({
    id: "REQ-001", kind: "requirement", schema_version: "requirement:v1", title: "Weekend", summary: "Plan a weekend",
    status: "active", acceptance_criteria: ["An itinerary exists"], source_paths: [], proposal_ref: null,
    created_at: createdAt, updated_at: createdAt, audit: { fixture: true },
  }, null, 2)}\n`);
  for (const id of ["ST-OLD", "ST-OLD2", "ST-NEW"]) {
    mustRun(["story", "create", "--no-derived-verification", "--root", root, "--id", id, "--title", `Story ${id}`, "--acceptance", `Result ${id}`, "--requirement", "REQ-001"]);
  }
  const supersede = (id, extra) => ["story", "supersede", "--root", root, "--id", id, "--by", "ST-NEW", "--reason", "ST-NEW delivers it", ...extra, "--summary", "Replace the story"];
  mustFail(supersede("ST-OLD", ["--actor-type", "agent", "--approval-source", "explicit-user"]), /human/u);
  grant(root, "DLG-ABANDON", "story.abandon");
  mustFail(supersede("ST-OLD", delegated("DLG-ABANDON")), /does not cover the action story\.supersede/u);

  grant(root, "DLG-SUP", "story.supersede");
  mustRun(supersede("ST-OLD", delegated("DLG-SUP")));
  const closure = readJson(path.join(root, ".sdlc", "stories", "ST-OLD", "closure.json"));
  assert.equal(closure.status, "superseded");
  assert.equal(closure.approval.approval_source, "delegated");
  assert.equal(closure.approval.approved_by.type, "agent");
  assert.equal(fs.readdirSync(path.join(root, ".sdlc", "autonomy", "delegations", "DLG-SUP", "uses")).length, 1);

  expire(root, "DLG-SUP");
  mustFail(supersede("ST-OLD2", delegated("DLG-SUP")), /expired/u);
  assert.equal(fs.existsSync(path.join(root, ".sdlc", "stories", "ST-OLD2", "closure.json")), false);
});
