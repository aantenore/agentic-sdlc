import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  NODE_ENGINE_RANGE,
  NODE_RUNTIME_REQUIREMENT,
  assertSupportedNodeRuntime,
  isSupportedNodeRuntime,
  unsupportedNodeRuntimeMessage,
} from "../../lib/runtime-support.mjs";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const CLI_PATH = path.join(PROJECT_ROOT, "bin", "agentic-sdlc.mjs");
const FOUNDATION_BENCHMARK_PATH = path.join(
  PROJECT_ROOT,
  "scripts",
  "benchmark-foundation.mjs",
);
const ENTERPRISE_BENCHMARK_PATH = path.join(
  PROJECT_ROOT,
  "scripts",
  "benchmark-enterprise-performance.mjs",
);
const UNSUPPORTED_NODE_VERSION = "18.18.0";
const UNSUPPORTED_RUNTIME_IMPORT = `data:text/javascript,${
  encodeURIComponent(
    `Object.defineProperty(process.versions, "node", { configurable: true, value: "${UNSUPPORTED_NODE_VERSION}" });`,
  )
}`;

test("runtime support excludes Node releases without the shutdown fix", () => {
  for (const version of ["18.18.0", "18.20.2", "19.9.0", "20.11.1", "21.5.0"]) {
    assert.equal(isSupportedNodeRuntime(version), false, version);
  }
  for (const version of ["18.20.3", "18.20.8", "20.12.0", "20.20.2", "21.6.0", "21.7.3", "22.0.0", "24.15.0"]) {
    assert.equal(isSupportedNodeRuntime(version), true, version);
  }
  for (const version of [undefined, null, 18, "", "18.20", "18.20.3-rc.1"]) {
    assert.equal(isSupportedNodeRuntime(version), false, String(version));
  }
});

test("runtime assertion reports the actionable supported ranges", () => {
  assert.doesNotThrow(() => assertSupportedNodeRuntime("18.20.3"));
  assert.throws(
    () => assertSupportedNodeRuntime("18.20.2"),
    new RegExp(`${escapeRegExp(NODE_RUNTIME_REQUIREMENT)} is required; found 18\\.20\\.2`, "u"),
  );
  assert.equal(
    unsupportedNodeRuntimeMessage("18.18.0", "it-IT"),
    `Serve ${NODE_RUNTIME_REQUIREMENT}; rilevato Node.js 18.18.0. Aggiorna Node.js prima di usare Agentic SDLC.`,
  );
});

test("package, documentation, and CI/release matrices use the safe runtime floors", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"),
  );
  assert.equal(packageJson.engines.node, NODE_ENGINE_RANGE);

  for (const relativePath of ["README.md", "docs/portable-install.md"]) {
    const source = fs.readFileSync(path.join(PROJECT_ROOT, relativePath), "utf8");
    assert.match(
      source,
      new RegExp(escapeRegExp(NODE_RUNTIME_REQUIREMENT), "u"),
      relativePath,
    );
  }

  for (const relativePath of [
    ".github/workflows/ci.yml",
    ".github/workflows/release.yml",
  ]) {
    const source = fs.readFileSync(path.join(PROJECT_ROOT, relativePath), "utf8");
    assert.match(
      source,
      /node: \["18\.20\.3", "20\.12\.0", "21\.6\.0", 24\]/u,
      relativePath,
    );
    assert.doesNotMatch(source, /18\.18(?:\.0)?/u, relativePath);
  }
});

test("CLI doctor and both benchmarks consume the shared runtime policy", () => {
  const cli = fs.readFileSync(CLI_PATH, "utf8");
  assert.match(cli, /isSupportedNodeRuntime\(process\.versions\.node\)/u);
  assert.match(cli, /isSupportedNodeRuntime\(nodeVersion\)/u);
  assert.match(cli, /rawStringOptionValue\(rawArgs, "locale"\)/u);
  assert.match(
    cli,
    /new UnsupportedNodeRuntimeError\(process\.versions\.node, rawLocale\)/u,
  );
  // The error class is a pure declaration and lives with the other lifecycle
  // classes; the CLI imports it.
  const lifecycleClasses = fs.readFileSync(path.join(PROJECT_ROOT, "lib/lifecycle/classes.mjs"), "utf8");
  assert.match(lifecycleClasses, /super\(unsupportedNodeRuntimeMessage\(version, locale\)\)/u);
  assert.match(cli, /UnsupportedNodeRuntimeError,\n\} from "\.\.\/lib\/lifecycle\/classes\.mjs";/u);
  assert.match(cli, /pkg\.engines\?\.node === NODE_ENGINE_RANGE/u);
  assert.match(cli, /NODE_ENGINE_RANGE/u);
  assert.match(cli, /NODE_RUNTIME_REQUIREMENT/u);

  for (const relativePath of [
    "scripts/benchmark-foundation.mjs",
    "scripts/benchmark-enterprise-performance.mjs",
  ]) {
    const source = fs.readFileSync(path.join(PROJECT_ROOT, relativePath), "utf8");
    assert.match(
      source,
      /import \{ assertSupportedNodeRuntime \} from "\.\.\/lib\/runtime-support\.mjs";/u,
      relativePath,
    );
    assert.match(source, /assertSupportedNodeRuntime\(\);/u, relativePath);
    assert.doesNotMatch(source, /function assertSupportedNodeRuntime/u, relativePath);
  }
});

test("unsupported runtime fails before CLI dispatch and benchmark argument parsing", () => {
  const invalidProject = fs.mkdtempSync(
    path.join(os.tmpdir(), "agentic-sdlc-unsupported-runtime-"),
  );
  fs.mkdirSync(path.join(invalidProject, ".sdlc"));
  fs.writeFileSync(path.join(invalidProject, ".sdlc", "config.json"), "{ invalid");
  try {
    const cli = spawnWithUnsupportedRuntime(CLI_PATH, [
      "doctor",
      "--root",
      invalidProject,
      "--locale",
      "it",
      "--json",
    ]);
    assertSpawnCompleted(cli, "CLI doctor");
    // An unsupported host runtime is an environment error: exit 4.
    assert.equal(cli.status, 4);
    assert.equal(cli.stdout, "");
    const cliError = JSON.parse(cli.stderr);
    assert.equal(cliError.error.code, "USER_ERROR");
    assert.equal(
      cliError.error.message,
      `Serve ${NODE_RUNTIME_REQUIREMENT}; rilevato Node.js ${UNSUPPORTED_NODE_VERSION}. Aggiorna Node.js prima di usare Agentic SDLC.`,
    );
    assert.match(cliError.human_guidance.result, /comando non è stato completato/iu);
  } finally {
    fs.rmSync(invalidProject, { recursive: true, force: true });
  }

  const foundation = spawnWithUnsupportedRuntime(FOUNDATION_BENCHMARK_PATH, [
    "--bogus",
  ]);
  assertSpawnCompleted(foundation, "foundation benchmark");
  assert.equal(foundation.status, 1);
  assert.equal(foundation.stderr, "");
  const foundationError = JSON.parse(foundation.stdout);
  assert.match(
    foundationError.error.message,
    new RegExp(`^${escapeRegExp(NODE_RUNTIME_REQUIREMENT)} is required`, "u"),
  );
  assert.doesNotMatch(foundationError.error.message, /unknown benchmark option/iu);

  const enterprise = spawnWithUnsupportedRuntime(ENTERPRISE_BENCHMARK_PATH, [
    "--internal-canonical-query-worker",
  ]);
  assertSpawnCompleted(enterprise, "enterprise benchmark worker");
  assert.equal(enterprise.status, 1);
  assert.equal(enterprise.stderr, "");
  const enterpriseError = JSON.parse(enterprise.stdout);
  assert.match(
    enterpriseError.error.message,
    new RegExp(`^${escapeRegExp(NODE_RUNTIME_REQUIREMENT)} is required`, "u"),
  );
  assert.doesNotMatch(
    enterpriseError.error.message,
    /canonical query|unknown option|--(?:root|project|fixture)/iu,
  );
});

function spawnWithUnsupportedRuntime(entryPath, args) {
  return spawnSync(
    process.execPath,
    ["--import", UNSUPPORTED_RUNTIME_IMPORT, entryPath, ...args],
    {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      },
      maxBuffer: 2 * 1024 * 1024,
      timeout: 30_000,
      windowsHide: true,
    },
  );
}

function assertSpawnCompleted(result, label) {
  assert.equal(
    result.error,
    undefined,
    `${label} failed to launch or timed out: ${result.error?.message || "unknown error"}`,
  );
  assert.equal(result.signal, null, `${label} ended from signal ${result.signal}`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
