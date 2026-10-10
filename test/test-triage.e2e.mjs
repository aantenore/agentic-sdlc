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
const env = { ...process.env, AGENTIC_SDLC_AUTO_PUBLISH: "off", AGENTIC_SDLC_MESSAGING: "off" };
delete env.AGENTIC_SDLC_MAIN_THREAD;

function run(project, args) {
  return spawnSync(process.execPath, [cli, ...args, "--root", project], { encoding: "utf8", timeout: 120_000, env });
}

function mustRun(project, args) {
  const result = run(project, args);
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function setup() {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-test-triage-")));
  mustRun(project, ["init", "--project-name", "Triage fixture"]);
  mustRun(project, ["requirement", "propose", "--id", "REQ-A", "--title", "A", "--summary", "Outcome", "--acceptance", "Works", "--autonomy-ceiling", "supervised", "--write-path", "src"]);
  mustRun(project, ["requirement", "approve", "--id", "REQ-A", "--actor-type", "human", "--approval-source", "explicit-user", "--summary", "ok"]);
  mustRun(project, ["story", "create", "--id", "ST-A", "--title", "Feature A", "--requirement", "REQ-A"]);
  mustRun(project, ["story", "create", "--id", "ST-QA", "--title", "Testbook", "--requirement", "REQ-A"]);
  fs.writeFileSync(path.join(project, "run.log"), "log\n");
  return project;
}

function record(project, caseId, { fail = false, minor = false, story = "ST-QA" } = {}) {
  const args = ["test", "record", "--story", story, "--command", '["npm","test"]', "--evidence", "run.log", "--case", caseId, "--json"];
  args.push("--exit-code", fail ? "1" : "0", fail ? "--failed" : "--passed", "1");
  if (minor) args.push("--outcome", "failed-minor");
  return JSON.parse(mustRun(project, args));
}

function strictErrors(project, story) {
  const result = run(project, ["gate", "check", "--story", story, "--scope", "story", "--strict", "--json"]);
  const report = JSON.parse(result.stdout);
  return report.errors ?? report.report?.errors ?? [];
}

test("test record keeps the case and the failed-minor outcome in the record and in the trace", () => {
  const project = setup();
  const minor = record(project, "TB-PREF-012", { fail: true, minor: true });
  assert.equal(minor.test_run.case_id, "TB-PREF-012");
  assert.equal(minor.test_run.outcome, "failed-minor");
  assert.equal(minor.event.outcome, "failed-minor");
  assert.ok(minor.event.related.includes("case:TB-PREF-012"));
  const bad = run(project, ["test", "record", "--story", "ST-QA", "--command", '["npm","test"]', "--evidence", "run.log", "--exit-code", "0", "--passed", "1", "--outcome", "failed-minor"]);
  assert.notEqual(bad.status, 0);
});

test("failed cases without a triage decision block the strict gate and the message names the command", () => {
  const project = setup();
  record(project, "TB-1", { fail: true });
  const listed = JSON.parse(mustRun(project, ["test", "triage", "--story", "ST-QA", "--json"]));
  assert.deepEqual(listed.pending.map((item) => item.case_id), ["TB-1"]);
  assert.ok(strictErrors(project, "ST-QA").some((message) => /TB-1/u.test(message) && /test triage --story ST-QA/u.test(message)));
  mustRun(project, ["test", "triage", "--story", "ST-QA", "--case", "TB-1", "--decision", "by-design", "--reason", "read-only field"]);
  assert.ok(!strictErrors(project, "ST-QA").some((message) => /without a triage decision/u.test(message)));
});

test("create-fix opens a free fix story on the delivered story, and it closes only after the case passed again", () => {
  const project = setup();
  record(project, "TB-2", { fail: true });
  const refused = run(project, ["test", "triage", "--story", "ST-QA", "--case", "TB-2", "--decision", "fixable", "--reason", "bug", "--create-fix"]);
  assert.notEqual(refused.status, 0);
  const created = JSON.parse(mustRun(project, ["test", "triage", "--story", "ST-QA", "--case", "TB-2", "--decision", "fixable", "--reason", "bug", "--create-fix", "--fixes", "ST-A", "--priority", "P1", "--json"]));
  const fixId = created.fix_story_id;
  const story = JSON.parse(fs.readFileSync(path.join(project, ".sdlc/stories", fixId, "story.json"), "utf8"));
  assert.deepEqual(story.fixes, { story_id: "ST-A", incident_id: null });
  assert.deepEqual(story.acceptance, ["Il caso TB-2 passa di nuovo"]);
  assert.equal(story.free, true);
  assert.equal(story.priority, "P1");
  assert.deepEqual(story.origin.test_story, "ST-QA");
  assert.equal(story.origin.case, "TB-2");
  assert.equal(story.claim, undefined);
  assert.ok(!fs.existsSync(path.join(project, ".sdlc/stories", fixId, "claim.json")));
  assert.ok(strictErrors(project, fixId).some((message) => /TB-2/u.test(message) && /cannot close/u.test(message)));
  record(project, "TB-2");
  assert.ok(!strictErrors(project, fixId).some((message) => /cannot close/u.test(message)));
});

test("a fix story is available to every computer: free stories are not kept for their creator", async () => {
  const { isFreshForeignStory } = await import("../lib/host-hooks/keep-going.mjs");
  const base = { audit: { run: { host: "pc-a" } } };
  const view = { selfHost: "pc-b", windowMs: 3600_000 };
  assert.equal(isFreshForeignStory(base, view), true);
  assert.equal(isFreshForeignStory({ ...base, free: true }, view), false);
});
