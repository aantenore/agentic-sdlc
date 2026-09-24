import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = path.join(ROOT, "bin", "agentic-sdlc.mjs");
const TEMPORARY_DIRECTORIES = new Set();

after(() => {
  for (const directory of TEMPORARY_DIRECTORIES) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryProject(label) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `agentic-sdlc-test-evidence-${label}-`));
  TEMPORARY_DIRECTORIES.add(directory);
  return directory;
}

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: process.env,
    timeout: 60_000,
  });
}

function mustRun(args) {
  const result = run(args);
  assert.equal(result.status, 0, `${args.join(" ")}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result;
}

function mustRunJson(args) {
  return JSON.parse(mustRun([...args, "--json"]).stdout);
}

function gate(project, storyId) {
  const result = run(["gate", "check", "--root", project, "--story", storyId, "--json"]);
  return JSON.parse(result.stdout);
}

/** A project in validation whose only test evidence is the legacy trace event. */
function validationProject(label, { storyId = "ST-001" } = {}) {
  const project = temporaryProject(label);
  mustRun(["init", "--root", project, "--project-name", `Evidence ${label}`]);
  mustRun([
    "story", "create",
    "--root", project,
    "--id", storyId,
    "--title", "Booking confirmation",
    "--phase", "validation",
    "--acceptance", "The booking suite passes",
  ]);
  mustRun([
    "trace", "append",
    "--root", project,
    "--type", "test",
    "--summary", "Suite passed",
    "--story", storyId,
    "--outcome", "passed",
    "--actor-type", "human",
  ]);
  // A story in validation also owes the credential scan its configuration
  // declares, so these cases exercise the test-evidence gate and not that one.
  mustRun(["secret", "scan", "--root", project, "--story", storyId]);
  return { project, storyId };
}

function writeEvidence(project, name, content) {
  const filePath = path.join(project, ".sdlc", "tests", name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return `.sdlc/tests/${name}`;
}

test("test record writes a schema-valid run record and a matching trace event", () => {
  const { project, storyId } = validationProject("record");
  const evidencePath = writeEvidence(project, "ST-001-run.log", "ok 1 booking\nok 2 payment\n");

  const recorded = mustRunJson([
    "test", "record",
    "--root", project,
    "--story", storyId,
    "--command", '["npm","test"]',
    "--exit-code", "0",
    "--passed", "2",
    "--skipped", "1",
    "--evidence", evidencePath,
    "--framework", "node:test",
    "--summary", "Full suite on the reviewed branch",
    "--actor-type", "human",
  ]);

  assert.equal(recorded.status, "recorded");
  const record = recorded.test_run;
  assert.equal(record.kind, "test_run");
  assert.equal(record.schema_version, "test-run:v1");
  assert.equal(record.story_id, storyId);
  assert.deepEqual(record.command.argv, ["npm", "test"]);
  assert.equal(record.exit_code, 0);
  assert.equal(record.outcome, "passed");
  assert.deepEqual(record.totals, { passed: 2, failed: 0, skipped: 1 });
  assert.equal(record.evidence.length, 1);
  assert.equal(record.evidence[0].path, evidencePath);
  assert.match(record.evidence[0].sha256, /^[a-f0-9]{64}$/u);
  assert.equal(record.hash_algorithm, "sha256:stable-json:v1");

  const onDisk = JSON.parse(fs.readFileSync(path.join(project, recorded.test_run_path), "utf8"));
  assert.deepEqual(onDisk, record);
  assert.equal(recorded.event.type, "test");
  assert.equal(recorded.event.outcome, "passed");
  assert.equal(recorded.event.evidence.includes(recorded.test_run_path), true);
});

test("the recorded outcome is derived from the exit status and counts, never asserted", () => {
  const { project, storyId } = validationProject("derived");
  const failureEvidence = writeEvidence(project, "ST-001-failure.log", "not ok 1 booking\n");

  const failed = mustRunJson([
    "test", "record",
    "--root", project,
    "--story", storyId,
    "--command", '["npm","test"]',
    "--exit-code", "1",
    "--passed", "8",
    "--failed", "2",
    "--evidence", failureEvidence,
    "--actor-type", "human",
  ]);
  assert.equal(failed.test_run.outcome, "failed");
  assert.equal(failed.event.outcome, "failed");

  const emptyEvidence = writeEvidence(project, "ST-001-empty.log", "no tests matched\n");
  const skipped = mustRunJson([
    "test", "record",
    "--root", project,
    "--story", storyId,
    "--command", '["npm","test","--","--grep","nothing"]',
    "--exit-code", "0",
    "--evidence", emptyEvidence,
    "--actor-type", "human",
  ]);
  assert.equal(skipped.test_run.outcome, "skipped");

  assert.equal(run(["test", "record", "--root", project, "--story", storyId, "--outcome", "passed"]).status, 1);
});

test("test record refuses a run without output, an unknown story, and a shell string command", () => {
  const { project, storyId } = validationProject("refusals");
  const evidencePath = writeEvidence(project, "ST-001-run.log", "ok 1 booking\n");
  const base = ["test", "record", "--root", project, "--story", storyId];

  const withoutEvidence = run([...base, "--command", '["npm","test"]', "--exit-code", "0", "--passed", "1"]);
  assert.equal(withoutEvidence.status, 1);
  assert.match(withoutEvidence.stderr, /at least one --evidence file/u);

  const unknownStory = run([
    "test", "record", "--root", project, "--story", "ST-404",
    "--command", '["npm","test"]', "--exit-code", "0", "--evidence", evidencePath,
  ]);
  assert.equal(unknownStory.status, 1);
  assert.match(unknownStory.stderr, /ST-404 does not exist/u);

  const shellString = run([...base, "--command", "npm test", "--exit-code", "0", "--evidence", evidencePath]);
  assert.equal(shellString.status, 1);
  assert.match(shellString.stderr, /JSON argument vector/u);

  const outOfRange = run([...base, "--command", '["npm","test"]', "--exit-code", "300", "--evidence", evidencePath]);
  assert.equal(outOfRange.status, 1);
  assert.match(outOfRange.stderr, /--exit-code must be an integer between 0 and 255/u);
});

test("a project with no test run record passes its validation gate exactly as before", () => {
  const { project, storyId } = validationProject("backward-compatible");
  const report = gate(project, storyId);

  assert.equal(report.status, "passed");
  assert.deepEqual(report.errors, []);
  assert.equal(report.checked.includes(`validation test evidence for story ${storyId}`), true);
  assert.equal(
    report.warnings.some((warning) => warning.includes("satisfies validation_requires_test_trace")),
    true,
    "the missing record is reported as guidance, not as a failure",
  );
});

test("the validation gate reports a recorded run and fails when its evidence no longer matches", () => {
  const { project, storyId } = validationProject("gate-evidence");
  const evidencePath = writeEvidence(project, "ST-001-run.log", "ok 1 booking\n");
  const recorded = mustRunJson([
    "test", "record",
    "--root", project,
    "--story", storyId,
    "--command", '["npm","test"]',
    "--exit-code", "0",
    "--passed", "1",
    "--evidence", evidencePath,
    "--actor-type", "human",
  ]);

  const passed = gate(project, storyId);
  assert.equal(passed.status, "passed");
  assert.equal(passed.checked.includes(`test run ${recorded.test_run.id}`), true);
  assert.equal(
    passed.warnings.some((warning) => warning.includes("satisfies validation_requires_test_trace")),
    false,
  );

  fs.appendFileSync(path.join(project, evidencePath), "ok 2 injected later\n");
  const tampered = gate(project, storyId);
  assert.equal(tampered.status, "failed");
  assert.equal(
    tampered.errors.some((error) => error.includes("changed after it was recorded")),
    true,
  );
});

test("a story still missing a passing test trace keeps failing, and disabling the policy stops the check", () => {
  const project = temporaryProject("policy");
  const storyId = "ST-002";
  mustRun(["init", "--root", project, "--project-name", "Evidence policy"]);
  mustRun([
    "story", "create",
    "--root", project,
    "--id", storyId,
    "--title", "Payment capture",
    "--phase", "validation",
    "--acceptance", "The payment suite passes",
  ]);

  const failing = gate(project, storyId);
  assert.equal(failing.status, "failed");
  assert.equal(
    failing.errors.includes(`Story ${storyId} is in validation but has no passing test trace`),
    true,
  );

  const configPath = path.join(project, ".sdlc", "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.gate_policy.validation_requires_test_trace = false;
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const relaxed = gate(project, storyId);
  assert.equal(
    relaxed.errors.includes(`Story ${storyId} is in validation but has no passing test trace`),
    false,
    "the gate must read the flag from the project configuration rather than assume it",
  );
  assert.equal(relaxed.checked.includes(`validation test evidence for story ${storyId}`), false);
});
