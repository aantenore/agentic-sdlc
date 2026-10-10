import "./helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";


const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));


function npmCliPath() {
  const candidates = [
    process.env.TEST_NPM_CLI,
    process.env.npm_execpath,
    process.platform === "win32"
      ? path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
      : path.resolve(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return realpathSync(candidate);
  }
  throw new Error("npm-cli.js was not found; set TEST_NPM_CLI for this test");
}


function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    env: options.env ?? process.env,
    maxBuffer: 8 * 1024 * 1024,
    shell: false,
    timeout: 120_000,
  });
  assert.equal(
    result.status,
    0,
    `${path.basename(executable)} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}


test("verifies a real npm pack through offline install and installed-package smoke tests", { timeout: 360_000 }, () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "release-package-e2e-"));
  try {
    const packDestination = path.join(temporary, "artifacts");
    const packCache = path.join(temporary, "pack-cache");
    mkdirSync(packDestination, { recursive: true });
    const npmCli = npmCliPath();
    const pack = run(process.execPath, [
      npmCli,
      "pack",
      "--json",
      "--ignore-scripts",
      "--offline",
      "--cache",
      packCache,
      "--pack-destination",
      packDestination,
    ], {
      env: {
        ...process.env,
        CI: "1",
        NO_UPDATE_NOTIFIER: "1",
        npm_config_audit: "false",
        npm_config_fund: "false",
        npm_config_offline: "true",
        npm_config_update_notifier: "false",
      },
    });
    const packReport = JSON.parse(pack.stdout)[0];
    assert.equal(packReport.name, packageJson.name);
    assert.equal(packReport.version, packageJson.version);
    assert.ok(packReport.files.some((file) => file.path === "config/release-artifact-policy.json"));

    const artifact = path.join(packDestination, packReport.filename);
    const verifierArgs = [
      path.join(repoRoot, "scripts", "verify-release-package.mjs"),
      "--artifact",
      artifact,
      "--tag",
      `v${packageJson.version}`,
      "--policy",
      path.join(repoRoot, "config", "release-artifact-policy.json"),
      "--npm-cli",
      npmCli,
      "--json",
    ];
    if (process.env.PYTHON) verifierArgs.push("--python", process.env.PYTHON);
    const verified = run(process.execPath, verifierArgs);
    const report = JSON.parse(verified.stdout);
    assert.equal(report.status, "passed");
    assert.equal(report.package.name, packageJson.name);
    assert.equal(report.package.version, packageJson.version);
    assert.equal(report.package.tag, `v${packageJson.version}`);
    assert.equal(report.archive.file_count, packReport.files.length);
    assert.match(report.artifact.sha256, /^[0-9a-f]{64}$/u);
    assert.match(report.artifact.snapshot_sha256, /^[0-9a-f]{64}$/u);
    assert.equal(report.smoke.npm_install, "passed");
    assert.equal(report.smoke.cli_help, "passed");
    assert.equal(report.smoke.doctor, "passed");
    assert.equal(report.smoke.installer_plan, "passed");
    assert.equal(report.smoke.installer_zero_write, true);
    assert.equal(report.smoke.installer_v2_plan, "passed");
    assert.equal(report.smoke.installer_v2_zero_write, true);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
