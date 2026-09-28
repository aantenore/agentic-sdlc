import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { requireSymlinkSupport } from "./helpers/symlink-support.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(repoRoot, "bin", "agentic-sdlc.mjs");
const racePreload = path.join(repoRoot, "test", "helpers", "template-fs-race-preload.cjs");
const tempRoots = new Set();

function tempRoot(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `sdlc-template-security-${name}-`));
  tempRoots.add(root);
  return root;
}

after(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
  tempRoots.clear();
});

function copyConfig(templateDir) {
  fs.mkdirSync(templateDir, { recursive: true });
  fs.copyFileSync(
    path.join(repoRoot, "templates", "sdlc-config.json"),
    path.join(templateDir, "sdlc-config.json"),
  );
}

function run(args) {
  const env = { ...process.env };
  for (const key of ["CI", "GITHUB_ACTIONS", "GITHUB_ACTOR", "CODEX_AGENT_NAME", "CODEX_USER_ID", "CLAUDECODE", "AGENTIC_SDLC_AGENT_HOST"]) {
    delete env[key];
  }
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
    timeout: 15_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function runWithTemplateFsHarness(args, harnessEnv) {
  const env = { ...process.env, ...harnessEnv };
  for (const key of ["CI", "GITHUB_ACTIONS", "GITHUB_ACTOR", "CODEX_AGENT_NAME", "CODEX_USER_ID", "CLAUDECODE", "AGENTIC_SDLC_AGENT_HOST"]) {
    delete env[key];
  }
  return spawnSync(process.execPath, ["--require", racePreload, bin, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
    timeout: 15_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

test("custom template asset symlinks are rejected before initialization", (t) => {
  if (!requireSymlinkSupport(t, "file")) return;
  const root = tempRoot("asset-symlink");
  const project = path.join(root, "project");
  const templateDir = path.join(root, "templates");
  fs.mkdirSync(project);
  copyConfig(templateDir);
  fs.writeFileSync(path.join(project, "README.md"), "# Existing project\n");
  fs.symlinkSync(
    path.join(repoRoot, "templates", "kb-readme.md"),
    path.join(templateDir, "kb-readme.md"),
  );

  const result = run([
    "onboard", "existing-project",
    "--root", project,
    "--template-dir", templateDir,
  ]);

  assert.notEqual(result.status, 0, result.stdout);
  assert.match(`${result.stdout}\n${result.stderr}`, /must be a readable regular file, not a directory or symlink/u);
  assert.equal(fs.existsSync(path.join(project, ".sdlc")), false);
});

test("technical assessment presets are validated before the registry lock is acquired", () => {
  const root = tempRoot("preset-preflight");
  const project = path.join(root, "project");
  const templateDir = path.join(root, "templates");
  fs.mkdirSync(project);
  copyConfig(templateDir);
  const initialized = run([
    "init",
    "--root", project,
    "--project-name", "Preset preflight",
    "--template-dir", templateDir,
  ]);
  assert.equal(initialized.status, 0, `${initialized.stdout}\n${initialized.stderr}`);

  fs.mkdirSync(path.join(templateDir, "technical-assessment.md"));
  const registryPath = path.join(project, ".sdlc", "output-contracts", "registry.json");
  const registryBefore = fs.readFileSync(registryPath, "utf8");
  const registryLockPath = path.join(project, ".sdlc", "output-contracts", "registry.lock");
  const lockOpenedMarker = path.join(root, "registry-lock-opened.txt");
  const result = runWithTemplateFsHarness([
    "output", "template", "propose",
    "--root", project,
    "--type", "technical-analysis",
    "--id", "technical-assessment-preflight",
    "--preset", "technical-assessment",
    "--template-dir", templateDir,
  ], {
    AGENTIC_SDLC_TEST_TEMPLATE_FS_ACTION: "mark-open",
    AGENTIC_SDLC_TEST_TEMPLATE_FS_TRIGGER: registryLockPath,
    AGENTIC_SDLC_TEST_TEMPLATE_FS_MARKER: lockOpenedMarker,
  });

  assert.notEqual(result.status, 0, result.stdout);
  assert.match(`${result.stdout}\n${result.stderr}`, /Custom template overlay asset must be a readable regular file/u);
  assert.equal(fs.existsSync(lockOpenedMarker), false);
  assert.equal(fs.existsSync(registryLockPath), false);
  assert.equal(fs.readFileSync(registryPath, "utf8"), registryBefore);
  assert.equal(
    fs.existsSync(path.join(project, ".sdlc", "output-contracts", "templates", "technical-assessment-preflight.md")),
    false,
  );
});

test("an exact template directory symlink is rejected", (t) => {
  if (!requireSymlinkSupport(t, "dir")) return;
  const root = tempRoot("directory-symlink");
  const project = path.join(root, "project");
  const realTemplateDir = path.join(root, "real-templates");
  const templateDir = path.join(root, "templates-link");
  fs.mkdirSync(project);
  copyConfig(realTemplateDir);
  fs.symlinkSync(realTemplateDir, templateDir, "dir");

  const result = run([
    "init",
    "--root", project,
    "--project-name", "Symlinked templates",
    "--template-dir", templateDir,
  ]);

  assert.notEqual(result.status, 0, result.stdout);
  assert.match(`${result.stdout}\n${result.stderr}`, /Template directory itself must not be a symlink/u);
  assert.equal(fs.existsSync(path.join(project, ".sdlc")), false);
});

test("an ancestor symlink is canonicalized and cannot retarget a selected asset", (t) => {
  if (!requireSymlinkSupport(t, "dir")) return;
  const root = tempRoot("ancestor-symlink");
  const project = path.join(root, "project");
  const sourceA = path.join(root, "source-a");
  const sourceB = path.join(root, "source-b");
  const templateDirA = path.join(sourceA, "templates");
  const templateDirB = path.join(sourceB, "templates");
  const activeSource = path.join(root, "active-source");
  fs.mkdirSync(project);
  copyConfig(templateDirA);
  copyConfig(templateDirB);
  fs.writeFileSync(path.join(templateDirA, "kb-readme.md"), "# Stable source A for {{PROJECT_NAME}}\n");
  fs.writeFileSync(path.join(templateDirB, "kb-readme.md"), "# Retargeted source B for {{PROJECT_NAME}}\n");
  fs.writeFileSync(path.join(project, "README.md"), "# Existing project\n");
  fs.symlinkSync(sourceA, activeSource, "dir");

  const result = runWithTemplateFsHarness([
    "onboard", "existing-project",
    "--root", project,
    "--project-name", "Canonical overlay",
    "--template-dir", path.join(activeSource, "templates"),
    "--json",
  ], {
    AGENTIC_SDLC_TEST_TEMPLATE_FS_ACTION: "retarget-symlink",
    AGENTIC_SDLC_TEST_TEMPLATE_FS_TRIGGER: fs.realpathSync.native(
      path.join(templateDirA, "kb-readme.md"),
    ),
    AGENTIC_SDLC_TEST_TEMPLATE_FS_LINK: activeSource,
    AGENTIC_SDLC_TEST_TEMPLATE_FS_LINK_TARGET: sourceB,
    AGENTIC_SDLC_TEST_TEMPLATE_FS_REQUIRE_TRIGGER: "1",
  });

  assert.equal(result.signal, null);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const kbReadme = fs.readFileSync(path.join(project, ".sdlc", "README.md"), "utf8");
  assert.match(kbReadme, /Stable source A for Canonical overlay/u);
  assert.doesNotMatch(kbReadme, /Retargeted source B/u);
});

test("a regular asset identity swap after selection fails closed", () => {
  const root = tempRoot("asset-swap");
  const project = path.join(root, "project");
  const templateDir = path.join(root, "templates");
  const selectedAsset = path.join(templateDir, "kb-readme.md");
  const replacementAsset = path.join(templateDir, "kb-readme.replacement.md");
  fs.mkdirSync(project);
  copyConfig(templateDir);
  fs.writeFileSync(path.join(project, "README.md"), "# Existing project\n");
  fs.writeFileSync(selectedAsset, "# Selected template for {{PROJECT_NAME}}\n");
  fs.writeFileSync(replacementAsset, "# Swapped template for {{PROJECT_NAME}}\n");

  const result = runWithTemplateFsHarness([
    "onboard", "existing-project",
    "--root", project,
    "--project-name", "Swap resistant overlay",
    "--template-dir", templateDir,
    "--json",
  ], {
    AGENTIC_SDLC_TEST_TEMPLATE_FS_ACTION: "swap-file",
    AGENTIC_SDLC_TEST_TEMPLATE_FS_TRIGGER: fs.realpathSync.native(selectedAsset),
    AGENTIC_SDLC_TEST_TEMPLATE_FS_MOVED: path.join(templateDir, "kb-readme.selected.md"),
    AGENTIC_SDLC_TEST_TEMPLATE_FS_REPLACEMENT: replacementAsset,
    AGENTIC_SDLC_TEST_TEMPLATE_FS_REQUIRE_TRIGGER: "1",
  });

  assert.equal(result.signal, null);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(`${result.stdout}\n${result.stderr}`, /Template asset changed after selection/u);
  assert.equal(fs.existsSync(path.join(project, ".sdlc")), false);
});
