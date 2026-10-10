import "./helpers/test-isolation.mjs";

import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createFixtureDir } from "./helpers/test-isolation.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(repoRoot, "bin", "agentic-sdlc.mjs");
const STORY = "ST-CLOSE-001";
const FAKE_KEY = ["AKIA", "Q3EXAMPLE7KEY0XY"].join("");
const OLD_FAKE_KEY = ["AKIA", "OLDEXAMPLE7KEY0Z"].join("");
const tempPaths = new Set();

after(() => {
  if (process.env.AGENTIC_SDLC_KEEP_TEST_TMP === "1") return;
  for (const entry of tempPaths) fs.rmSync(entry, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function run(args, env = {}) {
  const base = { ...process.env, AGENTIC_SDLC_MESSAGING_AUTO: "off", ...env };
  for (const key of ["CI", "GITHUB_ACTIONS", "GITHUB_ACTOR", "CODEX_AGENT_NAME", "CODEX_THREAD_ID", "CODEX_USER_ID", "CLAUDECODE", "AGENTIC_SDLC_AGENT_HOST", "AGENTIC_SDLC_MAIN_THREAD"]) delete base[key];
  return spawnSync(process.execPath, [bin, ...args], { cwd: repoRoot, encoding: "utf8", env: base, timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
}

function mustRun(args, env) {
  const result = run(args, env);
  assert.equal(result.status, 0, `${args.join(" ")}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result;
}

function git(project, args) {
  const result = spawnSync("git", ["-C", project, ...args], { encoding: "utf8", timeout: 60_000 });
  assert.equal(result.status, 0, `git ${args.join(" ")}\n${result.stderr}`);
  return result.stdout.trim();
}

function write(project, file, text) {
  fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
  fs.writeFileSync(path.join(project, file), text);
}

/**
 * A project whose main already holds an old file with a credential-looking
 * value, and a story branch merged into main with a true merge commit.
 */
function mergedProject({ secretInStory = false } = {}) {
  const root = createFixtureDir("sdlc-story-close-");
  tempPaths.add(root);
  const remote = path.join(root, "remote.git");
  git(root, ["init", "--quiet", "--bare", "-b", "main", remote]);
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  mustRun(["init", "--root", project, "--project-name", "Story close"]);
  git(project, ["init", "--quiet", "-b", "main"]);
  git(project, ["config", "user.email", "close@example.invalid"]);
  git(project, ["config", "user.name", "Close"]);
  git(project, ["config", "core.autocrlf", "false"]);
  mustRun(["story", "create", "--no-derived-verification", "--root", project, "--id", STORY, "--title", "Close the story", "--phase", "implementation", "--status", "ready", "--acceptance", "The story closes in one step."]);
  write(project, "src/legacy.txt", `aws_key = "${OLD_FAKE_KEY}"\n`);
  git(project, ["add", "-A"]);
  git(project, ["commit", "--quiet", "-m", "Start the project"]);
  git(project, ["remote", "add", "origin", remote]);
  git(project, ["push", "--quiet", "-u", "origin", "main"]);
  git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  git(project, ["remote", "set-head", "origin", "main"]);
  git(project, ["checkout", "--quiet", "-b", `feature/${STORY}`]);
  write(project, "src/story.txt", secretInStory ? `key = "${FAKE_KEY}"\n` : "story work\n");
  git(project, ["add", "src/story.txt"]);
  git(project, ["commit", "--quiet", "-m", "Story work"]);
  return { root, project, remote };
}

function closeJson(project, extra = [], env = {}) {
  const result = run(["story", "close", "--root", project, "--id", STORY, "--json", ...extra], env);
  return { result, json: JSON.parse(result.stdout) };
}

test("incremental secret scan finds a credential in the story's diff and ignores old files outside it", () => {
  const { project } = mergedProject({ secretInStory: true });
  const incremental = run(["secret", "scan", "--root", project, "--story", STORY, "--incremental", "--json"]);
  const scan = JSON.parse(incremental.stdout);
  assert.equal(scan.outcome, "findings", incremental.stdout);
  const paths = scan.secret_scan.findings.map((finding) => finding.path);
  assert.deepEqual([...new Set(paths)], ["src/story.txt"]);
  assert.ok(!scan.secret_scan.scanned_paths.includes("src/legacy.txt"), "old file outside the diff is not read");
  assert.ok(scan.secret_scan.scanned_paths.some((item) => item.startsWith(`.sdlc/stories/${STORY}/`)), "the story's records are read");
  assert.doesNotMatch(incremental.stdout, new RegExp(FAKE_KEY), "the match stays redacted");

  // Full mode (the project gate) still reads every file of the workspace range.
  const full = JSON.parse(run(["secret", "scan", "--root", project, "--story", STORY, "--json"]).stdout);
  assert.ok(full.secret_scan.scanned_paths.length >= 1);
});

test("story close stops at the first block with a clear message and resumes where it left off", () => {
  const { project } = mergedProject({ secretInStory: true });
  const first = closeJson(project);
  assert.notEqual(first.result.status, 0);
  assert.equal(first.json.status, "blocked");
  assert.equal(first.json.blocked_phase, "secret_scan", first.result.stdout);
  assert.match(first.json.message, /credential|AKIA|aws/iu);
  const byName = Object.fromEntries(first.json.phases.map((phase) => [phase.name, phase]));
  assert.equal(byName.sync.status, "done");
  assert.equal(typeof byName.sync.duration_ms, "number");
  assert.equal(byName.gate.status, "not_run");
  assert.equal(typeof first.json.total_ms, "number");

  // Remove the credential: the next run skips sync and resumes at the scan.
  write(project, "src/story.txt", "clean story work\n");
  git(project, ["commit", "--quiet", "-am", "Remove the credential"]);
  const second = closeJson(project);
  const again = Object.fromEntries(second.json.phases.map((phase) => [phase.name, phase]));
  assert.equal(again.sync.status, "resumed_done", second.result.stdout);
  assert.equal(again.secret_scan.status, "done", second.result.stdout);
  assert.notEqual(second.json.blocked_phase, "secret_scan");
  assert.notEqual(second.json.blocked_phase, "sync");

  // The base branch moves: the phases tied to it run again.
  const other = path.join(path.dirname(project), "other");
  git(path.dirname(project), ["clone", "--quiet", path.join(path.dirname(project), "remote.git"), other]);
  git(other, ["config", "user.email", "other@example.invalid"]);
  git(other, ["config", "user.name", "Other"]);
  write(other, "docs/other.md", "other work\n");
  git(other, ["add", "-A"]);
  git(other, ["commit", "--quiet", "-m", "Other work"]);
  git(other, ["push", "--quiet", "origin", "main"]);
  const third = closeJson(project);
  assert.equal(third.json.base_moved, true, third.result.stdout);
  const moved = Object.fromEntries(third.json.phases.map((phase) => [phase.name, phase]));
  assert.notEqual(moved.sync.status, "resumed_done");
  assert.equal(moved.secret_scan.status, "resumed_done");
});

test("story close on a merged story runs sync, scan and release trace with one shared fetch", () => {
  const { project } = mergedProject();
  git(project, ["checkout", "--quiet", "main"]);
  git(project, ["merge", "--quiet", "--no-ff", "-m", `Merge ${STORY}`, `feature/${STORY}`]);
  git(project, ["push", "--quiet", "origin", "main"]);
  write(project, `.sdlc/tests/${STORY}-merge.json`, "{\"merged\":true}\n");
  const closed = closeJson(project, ["--no-fetch", "--evidence", `.sdlc/tests/${STORY}-merge.json`]);
  const byName = Object.fromEntries(closed.json.phases.map((phase) => [phase.name, phase]));
  assert.equal(byName.sync.status, "done", closed.result.stdout);
  assert.equal(byName.secret_scan.status, "done", closed.result.stdout);
  assert.ok(["done", "already_done"].includes(byName.release_trace.status), closed.result.stdout);
  const trace = fs.readFileSync(path.join(project, ".sdlc", "traces", `${STORY}.jsonl`), "utf8");
  assert.match(trace, /"type":"release"/u);
  // A governed chain without delivery records stops before certification, with the command to run.
  if (closed.json.status === "blocked") {
    assert.ok(["release_steps", "phase_backfill", "claim_release", "gate", "publish_records"].includes(closed.json.blocked_phase), closed.result.stdout);
    assert.ok(closed.json.message.length > 0);
  }
  // Idempotent: the release trace is not appended twice.
  closeJson(project, ["--no-fetch", "--evidence", `.sdlc/tests/${STORY}-merge.json`]);
  const releases = fs.readFileSync(path.join(project, ".sdlc", "traces", `${STORY}.jsonl`), "utf8")
    .split("\n").filter((line) => line.includes("\"type\":\"release\""));
  assert.equal(releases.length, 1);
});

function mergedWithTraces(types) {
  const { project } = mergedProject();
  git(project, ["checkout", "--quiet", "main"]);
  git(project, ["merge", "--quiet", "--no-ff", "-m", `Merge ${STORY}`, `feature/${STORY}`]);
  git(project, ["push", "--quiet", "origin", "main"]);
  write(project, `.sdlc/tests/${STORY}-merge.json`, "{\"merged\":true}\n");
  for (const type of types) {
    mustRun(["trace", "append", "--root", project, "--story", STORY, "--type", type, "--outcome", "passed", "--summary", `${type} evidence`]);
  }
  // Release recorded while the earlier phases were never completed (the real case).
  const merge = `.sdlc/tests/${STORY}-merge.json`;
  mustRun(["trace", "append", "--root", project, "--story", STORY, "--type", "release", "--outcome", "passed", "--summary", "merged", "--evidence", merge]);
  for (const step of ["release", "operations"]) {
    mustRun(["story", "complete-step", "--root", project, "--id", STORY, "--step", step, "--summary", `${step} after merge`, "--evidence", merge, "--allow-unapproved-contract-output"]);
  }
  return project;
}

test("story close stops at skipped phases without evidence and names what is missing", () => {
  const project = mergedWithTraces(["decision"]);
  const closed = closeJson(project, ["--no-fetch", "--allow-unapproved-contract-output", "--evidence", `.sdlc/tests/${STORY}-merge.json`]);
  assert.equal(closed.json.blocked_phase, "phase_backfill", closed.result.stdout);
  assert.match(closed.json.message, /implementation \(needed: a passed git\.commit/u);
  assert.match(closed.json.message, /validation \(needed: a passed test record/u);
  assert.equal(fs.existsSync(path.join(project, ".sdlc", "stories", STORY, "steps", "design.json")), false);
});

test("story close completes skipped phases retroactively from evidence that predates release", () => {
  const project = mergedWithTraces(["decision", "implementation", "test"]);
  const closed = closeJson(project, ["--no-fetch", "--allow-unapproved-contract-output", "--evidence", `.sdlc/tests/${STORY}-merge.json`]);
  const byName = Object.fromEntries(closed.json.phases.map((phase) => [phase.name, phase]));
  assert.equal(byName.phase_backfill.status, "done", closed.result.stdout);
  assert.deepEqual(closed.json.backfilled_phases.map((entry) => entry.phase), ["discovery", "analysis", "design", "implementation", "validation"]);
  const steps = path.join(project, ".sdlc", "stories", STORY, "steps");
  const release = JSON.parse(fs.readFileSync(path.join(steps, "release.json"), "utf8"));
  let previous = 0;
  for (const phase of ["discovery", "analysis", "design", "implementation", "validation"]) {
    const record = JSON.parse(fs.readFileSync(path.join(steps, `${phase}.json`), "utf8"));
    assert.equal(record.completion_mode, "backfill");
    assert.ok(record.backfill.reason.length > 0);
    assert.ok(record.backfill.evidence_refs.length > 0);
    assert.ok(Date.parse(record.effective_at) >= previous, phase);
    assert.ok(Date.parse(record.effective_at) <= Date.parse(release.completed_at), phase);
    previous = Date.parse(record.effective_at);
  }
  assert.match(closed.result.stdout, /"backfilled_phases"/u);
});

test("story complete-step --backfill needs a reason and evidence of the phase", () => {
  const project = mergedWithTraces(["decision"]);
  const base = ["story", "complete-step", "--root", project, "--id", STORY, "--backfill", "--allow-unapproved-contract-output"];
  const noReason = run([...base, "--step", "design"]);
  assert.notEqual(noReason.status, 0);
  assert.match(noReason.stderr + noReason.stdout, /requires --reason/u);
  const noEvidence = run([...base, "--step", "implementation", "--reason", "not recorded when done"]);
  assert.notEqual(noEvidence.status, 0);
  assert.match(noEvidence.stderr + noEvidence.stdout, /no evidence of it exists.*git\.commit/su);
  mustRun([...base, "--step", "design", "--reason", "not recorded when done"]);
  const record = JSON.parse(fs.readFileSync(path.join(project, ".sdlc", "stories", STORY, "steps", "design.json"), "utf8"));
  assert.equal(record.completion_mode, "backfill");
  assert.equal(record.backfill.label, "completata a posteriori");
  assert.ok(Date.parse(record.effective_at) < Date.parse(record.completed_at));
});

test("automatic close is opt-in", async () => {
  const { autoCloseEnabled } = await import("../lib/engine/story-close.mjs");
  assert.equal(autoCloseEnabled({}, {}), false);
  assert.equal(autoCloseEnabled({}, { AGENTIC_SDLC_AUTO_CLOSE: "1" }), true);
  assert.equal(autoCloseEnabled({ orchestration_policy: { auto_close: true } }, {}), true);
  assert.equal(autoCloseEnabled({ orchestration_policy: { auto_close: true } }, { AGENTIC_SDLC_AUTO_CLOSE: "0" }), false);
});
