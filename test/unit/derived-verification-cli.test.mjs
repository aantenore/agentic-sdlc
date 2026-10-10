import "../helpers/test-isolation.mjs";

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
  for (const directory of TEMPORARY_DIRECTORIES) fs.rmSync(directory, { recursive: true, force: true });
});

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: "utf8", env: process.env, timeout: 60_000 });
}

function mustRun(args) {
  const result = run(args);
  assert.equal(result.status, 0, `${args.join(" ")}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result;
}

const mustRunJson = (args) => JSON.parse(mustRun([...args, "--json"]).stdout);

function project(label) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `agentic-sdlc-derived-${label}-`));
  TEMPORARY_DIRECTORIES.add(directory);
  mustRun(["init", "--root", directory, "--project-name", `Derived ${label}`]);
  return directory;
}

function proposeRequirement(root, id, extra = []) {
  return mustRunJson([
    "requirement", "propose", "--root", root, "--id", id, "--title", "Checkout",
    "--summary", "Customers can pay for a cart.", "--acceptance", "A paid order shows a confirmation.",
    "--autonomy-ceiling", "checkpointed", "--write-path", "apps/web", "--write-path", "src", ...extra,
  ]);
}

const ruleIds = (record) => record.derived_acceptance.map((item) => item.rule_id);
const storyFile = (root, id) => path.join(root, ".sdlc", "stories", id, "story.json");
const readStory = (root, id) => JSON.parse(fs.readFileSync(storyFile(root, id), "utf8"));

test("requirement propose derives secondary criteria and keeps explicit acceptance unchanged", () => {
  const root = project("propose");
  const proposed = proposeRequirement(root, "REQ-DV-001");
  assert.deepEqual(proposed.requirement.acceptance_criteria, ["A paid order shows a confirmation."]);
  assert.deepEqual(ruleIds(proposed.requirement), ["unit-tests", "ui-e2e", "ui-accessibility"]);
  assert.deepEqual(proposed.derived_acceptance, proposed.requirement.derived_acceptance);
  assert.equal(proposed.requirement.derived_acceptance[0].priority, "secondary");
  assert.equal(proposed.requirement.derived_verification.enforce, "block");
  assert.match(proposed.assistant_message, /DV-ui-e2e/u);
});

test("--no-derived-verification is recorded and skips derivation", () => {
  const root = project("optout");
  const proposed = proposeRequirement(root, "REQ-DV-002", ["--no-derived-verification"]);
  assert.deepEqual(proposed.requirement.derived_acceptance, []);
  assert.equal(proposed.requirement.derived_verification.disabled, true);
  assert.equal(proposed.requirement.derived_verification.reason, "--no-derived-verification");
});

test("requirement revise recomputes from its new scope and inherits the opt-out", () => {
  const root = project("revise");
  proposeRequirement(root, "REQ-DV-003");
  const revised = mustRunJson([
    "requirement", "revise", "--root", root, "--id", "REQ-DV-003", "--new-id", "REQ-DV-004",
    "--write-path", "src",
  ]);
  assert.deepEqual(ruleIds(revised.requirement), ["unit-tests"]);
  proposeRequirement(root, "REQ-DV-005", ["--no-derived-verification"]);
  const inherited = mustRunJson(["requirement", "revise", "--root", root, "--id", "REQ-DV-005", "--new-id", "REQ-DV-006"]);
  assert.equal(inherited.requirement.derived_verification.disabled, true);
});

test("story create derives from its requirement scope and deduplicates explicit criteria", () => {
  const root = project("story");
  proposeRequirement(root, "REQ-DV-007");
  mustRun([
    "requirement", "approve", "--root", root, "--id", "REQ-DV-007", "--actor-type", "human",
    "--actor-name", "Reviewer", "--actor-email", "reviewer@example.invalid",
    "--approval-source", "explicit-user", "--summary", "Approved as displayed.",
  ]);
  const created = mustRunJson([
    "story", "create", "--root", root, "--id", "ST-DV-001", "--title", "Pay for a cart", "--status", "ready",
    "--requirement", "REQ-DV-007", "--acceptance", "An accessibility audit with axe passes on checkout",
  ]);
  assert.deepEqual(created.story.acceptance_criteria, ["An accessibility audit with axe passes on checkout"]);
  assert.deepEqual(ruleIds(created.story), ["unit-tests", "ui-e2e"]);
  assert.equal(created.story.derived_verification.covered_by_explicit[0].rule_id, "ui-accessibility");
  assert.match(created.assistant_message, /DV-ui-e2e/u);

  const plain = mustRunJson(["story", "create", "--root", root, "--id", "ST-DV-002", "--title", "Plain", "--no-derived-verification"]);
  assert.equal(plain.story.derived_verification.disabled, true);
});

test("backfill adds criteria once, leaves explicit acceptance alone, and only reports bound stories", () => {
  const root = project("backfill");
  mustRun(["story", "create", "--root", root, "--id", "ST-DV-010", "--title", "Open", "--acceptance", "It works."]);
  mustRun(["story", "create", "--root", root, "--id", "ST-DV-011", "--title", "Bound", "--acceptance", "It works too."]);
  for (const id of ["ST-DV-010", "ST-DV-011"]) {
    const story = readStory(root, id);
    delete story.derived_acceptance;
    delete story.derived_verification;
    if (id === "ST-DV-011") story.contract_id = "CONTRACT-X";
    fs.writeFileSync(storyFile(root, id), `${JSON.stringify(story, null, 2)}\n`);
  }
  const first = mustRunJson(["story", "derive-verification", "--root", root, "--all-open"]);
  assert.equal(first.results.find((r) => r.id === "ST-DV-010").status, "updated");
  const bound = first.results.find((r) => r.id === "ST-DV-011");
  assert.equal(bound.status, "report_only");
  assert.deepEqual(bound.reasons, ["contract_bound"]);
  const updated = readStory(root, "ST-DV-010");
  assert.deepEqual(updated.acceptance_criteria, ["It works."]);
  assert.equal(updated.derived_verification.enforce, "warn");
  assert.equal(updated.derived_verification.mode, "backfill");
  assert.equal(readStory(root, "ST-DV-011").derived_verification, undefined);
  const second = mustRunJson(["story", "derive-verification", "--root", root, "--id", "ST-DV-010"]);
  assert.equal(second.results[0].status, "unchanged");
  assert.equal(run(["story", "derive-verification", "--root", root]).status !== 0, true);
});

function validationStory(root, id, extra = []) {
  mustRun(["story", "create", "--root", root, "--id", id, "--title", "Gate", "--phase", "validation", "--acceptance", "It works.", ...extra]);
  mustRun(["trace", "append", "--root", root, "--type", "test", "--summary", "Suite passed", "--story", id, "--outcome", "passed", "--actor-type", "human"]);
  mustRun(["secret", "scan", "--root", root, "--story", id]);
}

function gate(root, id) {
  return JSON.parse(run(["gate", "check", "--root", root, "--story", id, "--json"]).stdout);
}

test("the gate blocks new stories lacking derived test evidence and only warns for backfilled ones", () => {
  const root = project("gate");
  validationStory(root, "ST-DV-020");
  const blocked = gate(root, "ST-DV-020");
  assert.equal(blocked.errors.some((e) => /derived verification criteria without passing test evidence.*DV-unit-tests/u.test(e)), true);
  const blockedMessage = blocked.errors.find((e) => /derived verification criteria/u.test(e));
  assert.match(blockedMessage, /- DV-unit-tests: test record --story ST-DV-020 --acceptance DV-unit-tests --command '<json-argv>' --exit-code 0 --evidence <log> --copy-evidence/u);
  assert.match(blockedMessage, /what to run: run the project's unit test suite/u);

  const evidence = path.join(root, ".sdlc", "tests", "run.log");
  fs.mkdirSync(path.dirname(evidence), { recursive: true });
  fs.writeFileSync(evidence, "ok 1\n");
  mustRun([
    "test", "record", "--root", root, "--story", "ST-DV-020", "--command", '["npm","test"]', "--exit-code", "0",
    "--passed", "1", "--evidence", ".sdlc/tests/run.log", "--actor-type", "human",
  ]);
  const passing = gate(root, "ST-DV-020");
  assert.equal(passing.errors.some((e) => /derived verification/u.test(e)), false);

  validationStory(root, "ST-DV-021");
  const story = readStory(root, "ST-DV-021");
  story.derived_verification.enforce = "warn";
  fs.writeFileSync(storyFile(root, "ST-DV-021"), `${JSON.stringify(story, null, 2)}\n`);
  const warned = gate(root, "ST-DV-021");
  assert.equal(warned.errors.some((e) => /derived verification/u.test(e)), false);
  assert.equal(warned.warnings.some((w) => /derived verification criteria without passing test evidence/u.test(w)), true);
});
