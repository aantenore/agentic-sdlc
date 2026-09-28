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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `agentic-sdlc-dispatch-${label}-`));
  TEMPORARY_DIRECTORIES.add(directory);
  return directory;
}

function run(args, { cwd = ROOT, env = {} } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 30_000,
  });
}

function mustRun(args, settings = {}) {
  const result = run(args, settings);
  assert.equal(result.status, 0, `${args.join(" ")}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result;
}

test("runtime registry dispatches help, presets, completion, and Observatory bootstrap paths", () => {
  const help = JSON.parse(mustRun(["help", "trace", "evidence", "bind", "--json"]).stdout);
  assert.equal(help.command.path, "trace evidence bind");
  const flags = new Set(help.options.map((descriptor) => descriptor.flag));
  assert.equal(flags.has("--target-event"), true);
  assert.equal(flags.has("--redaction-policy"), true);
  const observeHelp = JSON.parse(mustRun(["help", "observe", "--json"]).stdout);
  const observeFlags = new Set(observeHelp.options.map((descriptor) => descriptor.flag));
  assert.equal(observeFlags.has("--portfolio-manifest"), true);
  const portfolioHelp = JSON.parse(mustRun(["help", "portfolio", "status", "--json"]).stdout);
  assert.equal(portfolioHelp.options.some((descriptor) => descriptor.flag === "--manifest"), true);

  const presets = JSON.parse(mustRun(["preset", "list", "--json"]).stdout);
  assert.equal(presets.schema_version, "agentic-sdlc-cli-preset-list-v1");
  const completion = JSON.parse(mustRun(["completion", "zsh", "--json"]).stdout);
  assert.equal(completion.schema_version, "agentic-sdlc-completion-v1");

  const project = temporaryProject("observe");
  const observed = mustRun([
    "observe", "--root", project, "--no-open", "--json",
  ], {
    env: { AGENTIC_SDLC_OBSERVATORY_WORKER: "1" },
  });
  assert.equal(observed.stdout, "");
  assert.equal(observed.stderr, "");

  const missingManifest = run([
    "observe",
    "--root", project,
    "--portfolio-manifest", "missing.json",
    "--no-open",
    "--json",
  ]);
  assert.equal(missingManifest.status, 1);
  const missingError = JSON.parse(missingManifest.stderr);
  assert.match(missingError.error.message, /portfolio could not be opened/u);
  assert.match(missingError.error.message, /--portfolio-manifest/u);
});

test("portfolio status accepts physical Windows path aliases and emits compact path-free JSON", () => {
  const root = fs.realpathSync(temporaryProject("portfolio-status"));
  for (const id of ["alpha", "beta"]) {
    const projectRoot = path.join(root, "projects", id, ".sdlc");
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "project.json"), `${JSON.stringify({
      project_id: id,
      project_name: id.toUpperCase(),
    })}\n`);
  }
  fs.writeFileSync(path.join(root, "portfolio.json"), `${JSON.stringify({
    schema_version: "portfolio-manifest:v1",
    projects: [
      { id: "alpha", path: "projects/alpha" },
      { id: "beta", path: "projects/beta" },
    ],
  })}\n`);

  const result = mustRun([
    "portfolio", "status",
    "--root", root,
    "--manifest", "portfolio.json",
    "--json",
  ]);
  const status = JSON.parse(result.stdout);

  assert.equal(status.schema_version, "agentic-sdlc:portfolio-status:v1");
  assert.equal(status.project_count, 2);
  assert.deepEqual(status.projects.map((project) => project.id), ["alpha", "beta"]);
  assert.doesNotMatch(result.stdout, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.doesNotMatch(result.stdout, /access_token|bearer|127\.0\.0\.1/u);
  assert.equal(result.stderr, "");
});

test("catalog options and explicit compatibility options remain accepted by the parser", () => {
  const catalog = mustRun(["help", "trace", "evidence", "bind", "--target-event", "TR-1", "--target-event", "TR-2", "--json"]);
  assert.equal(JSON.parse(catalog.stdout).command.path, "trace evidence bind");

  const compatibility = mustRun(["help", "--strict", "--allow-unapproved-contract-output", "--json"]);
  assert.equal(JSON.parse(compatibility.stdout).schema_version, "agentic-sdlc-help-v1");
  const unknown = run(["help", "--definitely-unknown"]);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /Unknown option --definitely-unknown/u);
});

test("config recovery uses catalog mutation intent for conditional report writers", () => {
  const project = temporaryProject("config-recovery");
  mustRun(["init", "--root", project, "--project-name", "Dispatch recovery"]);
  assert.match(
    fs.readFileSync(path.join(project, ".sdlc", ".gitattributes"), "utf8"),
    /\*\.jsonl text eol=lf/u,
  );
  const configPath = path.join(project, ".sdlc", "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.claim_policy.default_ttl_seconds += 1;
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const readOnly = mustRun(["report", "activity", "--root", project, "--json"]);
  assert.equal(JSON.parse(readOnly.stdout).kind, "activity_report");

  const outputPath = path.join(project, ".sdlc", "reports", "blocked.json");
  const blocked = run(["report", "activity", "--root", project, "--out", outputPath, "--json"]);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /configuration is drifted/u);
  assert.equal(fs.existsSync(outputPath), false);

  const preview = mustRun(["config", "migrate", "--root", project, "--json"]);
  assert.equal(JSON.parse(preview.stdout).status, "planned");
});
