import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repoRoot, "bin/agentic-sdlc.mjs");

/** A token shaped exactly like a real one, planted so the scan has something to find. */
// Assembled at runtime so the repository itself never holds a token-shaped literal.
const PLANTED_TOKEN = ["gh", "p_", "A1b2C3d4E5f6G7h8I9j0KlMnOpQrStUvWxYz".slice(0, 36)].join("");
const STORY_ID = "ST-SECRET-001";

function run(args, options = {}) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 120_000, ...options });
}

function git(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createProject() {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-secret-scan-")));
  git(directory, ["init", "--initial-branch", "main"]);
  git(directory, ["config", "user.email", "scan@example.test"]);
  git(directory, ["config", "user.name", "Scan Fixture"]);
  fs.writeFileSync(path.join(directory, "README.md"), "# Scan fixture\n", "utf8");
  git(directory, ["add", "."]);
  git(directory, ["commit", "-m", "initial"]);

  const initialized = run(["init", "--root", directory, "--project-name", "Secret scan fixture"]);
  assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
  const created = run([
    "story", "create", "--root", directory,
    "--id", STORY_ID, "--title", "Deliver the booking endpoint",
    "--acceptance", "The endpoint answers with the stored booking",
  ]);
  assert.equal(created.status, 0, created.stderr || created.stdout);
  return directory;
}

function storyPath(project) {
  return path.join(project, ".sdlc", "stories", STORY_ID, "story.json");
}

function gateErrors(project) {
  const checked = run(["gate", "check", "--root", project, "--story", STORY_ID, "--json"]);
  const report = JSON.parse(checked.stdout);
  return report.errors || [];
}

test("a planted credential blocks the delivery and is never shown or stored in the clear", () => {
  const project = createProject();
  try {
    const sourcePath = path.join(project, "src", "client.js");
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, `export const auth = "${PLANTED_TOKEN}";\n`, "utf8");

    const found = run(["secret", "scan", "--root", project, "--story", STORY_ID]);
    assert.equal(found.status, 1, `expected a refused request, got ${found.status}: ${found.stderr || found.stdout}`);
    assert.match(found.stdout, /src\/client\.js:1 github_token ghp_…/u);
    assert.ok(!found.stdout.includes(PLANTED_TOKEN), "the command printed the credential it found");
    assert.ok(!found.stderr.includes(PLANTED_TOKEN), "the command printed the credential it found");

    const securityRoot = path.join(project, ".sdlc", "security");
    const recordNames = fs.readdirSync(securityRoot);
    assert.equal(recordNames.length, 1, "one scan produced one record");
    const recordText = fs.readFileSync(path.join(securityRoot, recordNames[0]), "utf8");
    assert.ok(!recordText.includes(PLANTED_TOKEN), "the stored record contains the credential");
    const record = JSON.parse(recordText);
    assert.equal(record.schema_version, "secret-scan:v1");
    assert.equal(record.kind, "secret_scan");
    assert.equal(record.outcome, "findings");
    assert.equal(record.head_sha, git(project, ["rev-parse", "HEAD"]));
    assert.deepEqual(
      record.findings.map((finding) => [finding.path, finding.line, finding.rule, finding.redacted_match]),
      [["src/client.js", 1, "github_token", "ghp_…"]],
    );

    // The validation gate refuses the story while the finding stands.
    const story = readJson(storyPath(project));
    writeJson(storyPath(project), { ...story, phase: "validation", status: "validation" });
    assert.ok(
      gateErrors(project).some((error) => error.includes("secret scan") && error.includes("credential match")),
      "the validation gate did not report the credential the scan found",
    );

    // Removing the credential and scanning again clears the gate.
    fs.writeFileSync(sourcePath, "export const auth = process.env.API_TOKEN;\n", "utf8");
    const clean = run(["secret", "scan", "--root", project, "--story", STORY_ID]);
    assert.equal(clean.status, 0, clean.stderr || clean.stdout);
    assert.match(clean.stdout, /No credential pattern matched/u);
    assert.equal(fs.readdirSync(securityRoot).length, 2, "the second scan is a second immutable record");
    assert.equal(
      gateErrors(project).filter((error) => error.toLowerCase().includes("secret scan")).length,
      0,
      "the validation gate still complains after a clean scan",
    );
  } finally {
    fs.rmSync(project, { force: true, recursive: true });
  }
});

test("the gate stays silent for a project that never declared the policy", () => {
  const project = createProject();
  try {
    const configPath = path.join(project, ".sdlc", "config.json");
    const config = readJson(configPath);
    assert.equal(config.gate_policy.secret_scan.enabled, true, "a new project is initialized with the gate on");
    delete config.gate_policy.secret_scan;
    writeJson(configPath, config);

    const story = readJson(storyPath(project));
    writeJson(storyPath(project), { ...story, phase: "validation", status: "validation" });
    assert.equal(
      gateErrors(project).filter((error) => error.toLowerCase().includes("secret scan")).length,
      0,
      "a project without the declared policy was blocked by a gate it never adopted",
    );
  } finally {
    fs.rmSync(project, { force: true, recursive: true });
  }
});

test("an explicit commit range scans only what that range changed", () => {
  const project = createProject();
  try {
    const base = git(project, ["rev-parse", "HEAD"]);
    const sourcePath = path.join(project, "src", "safe.js");
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, "export const safe = true;\n", "utf8");
    git(project, ["add", "src/safe.js"]);
    git(project, ["commit", "-m", "add safe module"]);

    const scanned = run(["secret", "scan", "--root", project, "--story", STORY_ID, "--base", base, "--json"]);
    assert.equal(scanned.status, 0, scanned.stderr || scanned.stdout);
    const payload = JSON.parse(scanned.stdout);
    assert.equal(payload.secret_scan.source, "git_range");
    assert.equal(payload.secret_scan.base_sha, base);
    assert.deepEqual(payload.secret_scan.scanned_paths, ["src/safe.js"]);
    assert.equal(payload.secret_scan.file_count, 1);
    assert.ok(payload.secret_scan.rule_ids.includes("github_token"));
    assert.match(payload.secret_scan.rule_set_hash, /^[a-f0-9]{64}$/u);
  } finally {
    fs.rmSync(project, { force: true, recursive: true });
  }
});
