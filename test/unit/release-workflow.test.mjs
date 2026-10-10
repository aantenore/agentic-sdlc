import "../helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CI_GATE_POLICY, requiredCiJobNames } from "../../lib/release/ci-gate.mjs";
import {
  CHECKS_STEPS,
  CI_SHARD_TOTAL,
  SHARDED_PLATFORMS,
  SHARD_TEST_STEP,
  checksJobName,
  shardJobName,
} from "../../lib/release/ci-jobs.mjs";
import { TEST_SHARD_ENV } from "../../scripts/run-test-suite.mjs";


const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ciWorkflowPath = path.join(repoRoot, ".github", "workflows", "ci.yml");
const workflowPath = path.join(repoRoot, ".github", "workflows", "release.yml");


function normalizeLineEndings(source) {
  return source.replace(/\r\n?/gu, "\n");
}


const ciWorkflow = normalizeLineEndings(readFileSync(ciWorkflowPath, "utf8"));
const workflow = normalizeLineEndings(readFileSync(workflowPath, "utf8"));

const ACTION_PINS = new Map([
  ["actions/checkout", "df4cb1c069e1874edd31b4311f1884172cec0e10"],
  ["actions/setup-node", "249970729cb0ef3589644e2896645e5dc5ba9c38"],
  ["actions/setup-python", "ece7cb06caefa5fff74198d8649806c4678c61a1"],
  ["actions/upload-artifact", "330a01c490aca151604b8cf639adc76d48f6c5d4"],
  ["actions/download-artifact", "018cc2cf5baa6db3ef3c5f8a56943fffe632ef53"],
  ["actions/attest-build-provenance", "96278af6caaf10aea03fd8d33a09a777ca52d62f"],
]);

const SYFT_PINS = Object.freeze({
  version: "1.42.3",
  amd64: "0d6be741479eddd2c8644a288990c04f3df0d609bbc1599a005532a9dff63509",
  arm64: "dc630590c953347789d08f8ebf57c7d8094db89100785fcd94b1cddeac791804",
});


function jobBlocks(source) {
  const jobsOffset = source.indexOf("\njobs:\n");
  assert.notEqual(jobsOffset, -1, "workflow must contain a top-level jobs mapping");
  const body = source.slice(jobsOffset + "\njobs:\n".length);
  const matches = [...body.matchAll(/^  ([a-z][a-z0-9_-]*):\n/gmu)];
  const result = new Map();
  for (let index = 0; index < matches.length; index += 1) {
    const start = matches[index].index;
    const end = matches[index + 1]?.index ?? body.length;
    result.set(matches[index][1], body.slice(start, end));
  }
  return result;
}


function actionReferences(source) {
  return [...source.matchAll(/^\s+-?\s*uses:\s*([^\s]+)$/gmu)].map((match) => match[1]);
}


const SHARDS = ["1/3", "2/3", "3/3"];
const SHARD_TOTAL = SHARDS.length;
// The steps that do not depend on the shard; they run in the checks job only.
const SHARD_INDEPENDENT_COMMANDS = [
  "npm run check",
  "node --test test/unit/test-suite-runner.test.mjs",
  "npm run doctor",
  "npm pack --dry-run",
];
const FULL_NODES = ["18.20.3", "20.12.0", "21.6.0", "24"];
const checkNames = (osName, nodes) => nodes.map((node) => `test (${osName}, ${node})`);
// The status checks every event must produce, by event.
const EXPECTED_CHECKS = {
  pullRequest: [
    ...checkNames("ubuntu-latest", ["24", "18.20.3"]),
    ...checkNames("macos-latest", ["24"]),
    ...checkNames("windows-latest", ["24"]),
  ].sort(),
  push: [
    ...checkNames("ubuntu-latest", FULL_NODES),
    ...checkNames("macos-latest", ["24"]),
    ...checkNames("windows-latest", ["24"]),
  ].sort(),
  full: [
    ...checkNames("ubuntu-latest", FULL_NODES),
    ...checkNames("macos-latest", FULL_NODES),
    ...checkNames("windows-latest", FULL_NODES),
  ].sort(),
};
const EVENT_LABELS = { pullRequest: "pull request", push: "push", full: "full" };
const REQUIRED_PULL_REQUEST_CHECKS = [
  "test (ubuntu-latest, 24)",
  "test (macos-latest, 24)",
  "test (windows-latest, 24)",
];
const CONCURRENCY_EXPRESSION = /AGENTIC_SDLC_TEST_CONCURRENCY: \$\{\{ matrix\.os == '([^']+)' && matrix\.node == '([^']+)' && '([^']+)' \|\| '([^']+)' \}\}/gu;
const MATRIX_EXPRESSION = /^      matrix: \$\{\{ fromJSON\(github\.event_name == 'pull_request' && '(\{[^']*\})' \|\| github\.event_name == 'push' && '(\{[^']*\})' \|\| '(\{[^']*\})'\) \}\}$/mu;
// Steps after the scope detection run only when the change set is not
// documentation-only; "!= 'true'" makes a missing or failed output run them.
const NOT_DOCS_ONLY = "steps.scope.outputs.docs_only != 'true'";
const SCOPE_STEP = /^id: scope\n\s+name: Detect Markdown-only changes\n\s+run: node scripts\/ci-change-scope\.mjs\n\s+env:\n\s+CI_EVENT_NAME: \$\{\{ github\.event_name \}\}\n\s+CI_BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}\n\s+CI_BEFORE_SHA: \$\{\{ github\.event\.before \}\}\n(?:\s+# [^\n]+\n\s+CI_ALWAYS_RUN: [^\n]+\n)?/u;
// The unsharded job's scope step also opts the reference cell (ubuntu, Node 24) out of skipping.
const ALWAYS_RUN_ENV = "CI_ALWAYS_RUN: ${{ matrix.os == 'ubuntu-latest' && matrix.node == 24 }}";
const AGGREGATOR_ARGS = `--platform "$MATRIX_OS" --node "$MATRIX_NODE" --shards ${SHARD_TOTAL}`;


// Mirrors GitHub's matrix expansion for the subset used here: the cross product
// of the listed axes plus `include` entries that extend it with new combinations.
function expandMatrix(definition) {
  let cells = [{}];
  for (const [axis, values] of Object.entries(definition)) {
    if (axis === "include") continue;
    cells = cells.flatMap((cell) => values.map((value) => ({ ...cell, [axis]: String(value) })));
  }
  for (const extra of definition.include ?? []) {
    const cell = Object.fromEntries(Object.entries(extra).map(([key, value]) => [key, String(value)]));
    if (!cells.some((known) => Object.entries(cell).every(([key, value]) => known[key] === value))) {
      cells.push(cell);
    }
  }
  return cells;
}


function ciMatrices(block) {
  const match = MATRIX_EXPRESSION.exec(block);
  assert.notEqual(match, null, "CI matrix must be selected with fromJSON on github.event_name");
  return {
    pullRequest: expandMatrix(JSON.parse(match[1])),
    push: expandMatrix(JSON.parse(match[2])),
    full: expandMatrix(JSON.parse(match[3])),
  };
}


function cellNames(cells) {
  return cells.map(({ os: osName, node }) => `test (${osName}, ${node})`).sort();
}


// Every status check one event produces: the Linux cells plus the per-OS,
// per-Node aggregators of the sharded platforms (the shard and checks jobs are
// not required checks of their own).
function eventChecks(source, event) {
  const jobs = jobBlocks(source);
  return [
    ...cellNames(ciMatrices(jobs.get("test") ?? "")[event]),
    ...cellNames(ciMatrices(jobs.get("test-sharded") ?? "")[event]),
  ].sort();
}


function ciConcurrencyPolicy(source) {
  const policies = [...source.matchAll(CONCURRENCY_EXPRESSION)].map((match) => match.slice(1));
  if (policies.length !== 1) return null;
  const [serializedOs, serializedNode, serializedValue, defaultValue] = policies[0];
  return {
    serializedOs,
    serializedNode,
    serializedValue,
    defaultValue,
    forCell: ({ os: osName, node }) => (
      osName === serializedOs && node === serializedNode ? serializedValue : defaultValue
    ),
  };
}


function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}


// Removes one top-level job (its comments are those above the next job).
function withoutJob(source, id) {
  const start = source.indexOf(`\n  ${id}:\n`);
  assert.notEqual(start, -1, `${id} must exist`);
  const next = /\n  [a-z][a-z0-9_-]*:\n/u.exec(source.slice(start + 1));
  return source.slice(0, start + 1) + (next ? source.slice(start + 1 + next.index + 1) : "");
}


// The steps of a job, each without its leading "- ".
function jobSteps(block) {
  const marker = "    steps:\n";
  const offset = block.indexOf(marker);
  return offset === -1 ? [] : block.slice(offset + marker.length).split(/^      - /mu).slice(1);
}


function stepName(step) {
  return /^(?:id: [^\n]+\n\s+)?name: ([^\n]+)$/mu.exec(step)?.[1] ?? null;
}


function stepIsGated(step) {
  return new RegExp(`^\\s+if: ${escapeRegExp(NOT_DOCS_ONLY)}(?: && [^\\n]+)?$`, "mu").test(step);
}


// checkout + setup-node, then the scope detection, then everything else.
function stepLayout(block) {
  const steps = jobSteps(block);
  return {
    leading: steps.slice(0, 2),
    scope: steps[2] ?? "",
    after: steps.slice(3),
  };
}


function ciContractErrors(source) {
  const errors = [];
  const jobs = jobBlocks(source);
  const unix = jobs.get("test") ?? "";
  const shard = jobs.get("test-shard") ?? "";
  const checks = jobs.get("test-checks") ?? "";
  const aggregator = jobs.get("test-sharded") ?? "";

  if ([...jobs.keys()].join(",") !== "test,test-shard,test-checks,test-sharded") errors.push("CI job boundary");
  if ((source.match(/timeout-minutes: 35/gu) ?? []).length !== 2
    || !/timeout-minutes: 35/u.test(unix)
    || !/timeout-minutes: 35/u.test(shard)
    || !/timeout-minutes: 15\n/u.test(checks)
    || !/timeout-minutes: 5\n/u.test(aggregator)) {
    errors.push("CI job timeout");
  }
  if (/continue-on-error:/u.test(source)) errors.push("CI fail-open policy");
  if (!/^on:\n  push:\n    branches: \[main\]\n  pull_request:\n  schedule:\n    - cron: "[0-9*/, -]+ [0-9*/, -]+ \* \* \*"\n  workflow_dispatch:\n/mu.test(source)) {
    errors.push("CI triggers");
  }
  try {
    const unixMatrices = ciMatrices(unix);
    const shardMatrices = ciMatrices(shard);
    const checksMatrices = ciMatrices(checks);
    const aggregatorMatrices = ciMatrices(aggregator);
    for (const event of Object.keys(EXPECTED_CHECKS)) {
      if (eventChecks(source, event).join("|") !== EXPECTED_CHECKS[event].join("|")) {
        errors.push(`CI ${EVENT_LABELS[event]} matrix`);
      }
      // Only the sharded platforms are sharded, and only Linux is not.
      if (unixMatrices[event].some((cell) => SHARDED_PLATFORMS.includes(cell.os))
        || aggregatorMatrices[event].some((cell) => !SHARDED_PLATFORMS.includes(cell.os))) {
        errors.push("CI sharded platforms");
      }
      const cells = (matrix) => cellNames(matrix).join("|");
      if (cells(checksMatrices[event]) !== cells(aggregatorMatrices[event])) errors.push("CI checks job");
      const expectedShards = aggregatorMatrices[event]
        .flatMap(({ os: osName, node }) => SHARDS.map((index) => `${osName}|${node}|${index}`)).sort();
      const actualShards = shardMatrices[event].map((cell) => `${cell.os}|${cell.node}|${cell.shard}`).sort();
      if (expectedShards.join("#") !== actualShards.join("#")) errors.push("CI shards");
    }
  } catch {
    errors.push("CI matrix selection");
  }
  if (/^\s+(?:os|node):/mu.test(source)) errors.push("CI static matrix axes");

  const concurrency = ciConcurrencyPolicy(shard);
  if (concurrency === null
    || concurrency.serializedOs !== "macos-latest"
    || concurrency.serializedNode !== "18.20.3"
    || concurrency.serializedValue !== "1"
    || concurrency.defaultValue !== "2"
    || (source.match(/AGENTIC_SDLC_TEST_CONCURRENCY:/gu) ?? []).length !== 2
    || (unix.match(/AGENTIC_SDLC_TEST_CONCURRENCY: "4"$/gmu) ?? []).length !== 1) {
    errors.push("CI test concurrency policy");
  }
  if ((source.match(/npm run benchmark:enterprise/gu) ?? []).length !== 1
    || !new RegExp(`- name: Enforce enterprise performance on the required reference runtime\\n\\s+if: ${escapeRegExp(NOT_DOCS_ONLY)} && matrix\\.os == 'ubuntu-latest' && matrix\\.node == 24\\n\\s+run: npm run benchmark:enterprise`, "u").test(unix)) {
    errors.push("CI required reference performance gate");
  }
  // Required and gated jobs must run on every trigger so their check names are
  // always reported; only steps may be skipped, never the job.
  if (/^    if:/mu.test(unix) || /^    if:/mu.test(shard) || /^    if:/mu.test(checks)
    || (aggregator.match(/^    if:/gmu) ?? []).length !== 1) {
    errors.push("CI required job skipped");
  }

  // Shards: one npm test per shard with its own shard selector, on the runner
  // of its own operating system, and none of the shard-independent steps.
  const shardTestStep = /run: npm test\n\s+env:\n((?:\s+[A-Z_]+: .*\n?)+)/u.exec(shard);
  if (!/^    runs-on: \$\{\{ matrix\.os \}\}$/mu.test(shard)
    || !/^    name: test shard \(\$\{\{ matrix\.os \}\}, \$\{\{ matrix\.node \}\}, \$\{\{ matrix\.shard \}\}\)$/mu.test(shard)
    || (shard.match(/npm test$/gmu) ?? []).length !== 1
    || shardTestStep === null
    || !/^\s+AGENTIC_SDLC_TEST_SHARD: \$\{\{ matrix\.shard \}\}$/mu.test(shardTestStep[1])
    || SHARD_INDEPENDENT_COMMANDS.some((command) => shard.includes(command))
    || /startsWith\(matrix\.shard/u.test(shard)) {
    errors.push("CI shards");
  }

  // The checks job: every shard-independent step exactly once per OS and Node
  // line, on the same OS, without the test suite itself.
  if (!/^    name: checks \(\$\{\{ matrix\.os \}\}, \$\{\{ matrix\.node \}\}\)$/mu.test(checks)
    || !/^    runs-on: \$\{\{ matrix\.os \}\}$/mu.test(checks)
    || /npm test|setup-python/u.test(checks)
    || SHARD_INDEPENDENT_COMMANDS.some((command) => (
      (checks.match(new RegExp(`^\\s+run: ${escapeRegExp(command)}$`, "gmu")) ?? []).length !== 1
    ))
    || CHECKS_STEPS.some((name) => !checks.includes(`- name: ${name}\n`))) {
    errors.push("CI checks job");
  }

  // The aggregator carries the required check names, waits for every shard and
  // checks job even when one fails, and itself fails unless this cell's jobs
  // all passed.
  if (!/^    name: test \(\$\{\{ matrix\.os \}\}, \$\{\{ matrix\.node \}\}\)$/mu.test(aggregator)
    || /^    name:/mu.test(unix)) {
    errors.push("CI required check names");
  }
  const verifyRuns = [...aggregator.matchAll(/^        run: node scripts\/verify-ci-shards\.mjs (.*)$/gmu)]
    .map((match) => match[1]);
  if (!/^    needs: \[test-shard, test-checks\]$/mu.test(aggregator)
    || !/^    if: always\(\)$/mu.test(aggregator)
    || !/^    runs-on: ubuntu-latest$/mu.test(aggregator)
    || !/^    permissions:\n      actions: read\n      contents: read\n/mu.test(aggregator)
    || verifyRuns.join("|") !== [AGGREGATOR_ARGS, `${AGGREGATOR_ARGS} --require-executed`].join("|")
    || (aggregator.match(/^          MATRIX_OS: \$\{\{ matrix\.os \}\}$/gmu) ?? []).length !== 2
    || (aggregator.match(/^          MATRIX_NODE: \$\{\{ matrix\.node \}\}$/gmu) ?? []).length !== 2
    || (aggregator.match(/^          GITHUB_TOKEN: \$\{\{ github\.token \}\}$/gmu) ?? []).length !== 2
    || /\|\| true|continue-on-error/u.test(aggregator)) {
    errors.push("CI sharded aggregator");
  }

  // Documentation-only changes skip the suite step by step, never the job.
  const layouts = [
    [unix, 7],
    [shard, 2],
    [checks, CHECKS_STEPS.length],
    [aggregator, 2],
  ];
  for (const [block, afterCount] of layouts) {
    const { leading, scope, after } = stepLayout(block);
    const alwaysRun = scope.includes(ALWAYS_RUN_ENV);
    if (alwaysRun !== (block === unix)
      || (scope.match(/CI_ALWAYS_RUN/gu) ?? []).length !== (block === unix ? 1 : 0)) {
      errors.push("CI reference cell skips");
    }
    if (leading.length !== 2
      || !/^uses: actions\/checkout@/u.test(leading[0])
      || !/^uses: actions\/setup-node@/u.test(leading[1])
      || !SCOPE_STEP.test(scope)
      || after.length !== afterCount) {
      errors.push("CI docs-only skip");
    }
    if (block !== aggregator && !after.every(stepIsGated)) errors.push("CI docs-only skip");
  }
  {
    const [verify, confirm] = stepLayout(aggregator).after;
    if (verify === undefined || confirm === undefined
      || stepName(verify) !== "Require every shard of this Node line"
      || /^\s+if:/mu.test(verify)
      || stepName(confirm) !== "Confirm every shard ran the test suite"
      || !stepIsGated(confirm)
      || !/--require-executed$/mu.test(confirm)) {
      errors.push("CI docs-only skip");
    }
  }
  if ((source.match(/run: node scripts\/ci-change-scope\.mjs$/gmu) ?? []).length !== 4) errors.push("CI docs-only skip");

  const actions = actionReferences(source);
  const counts = new Map();
  for (const action of actions) counts.set(action, (counts.get(action) ?? 0) + 1);
  const checkout = `actions/checkout@${ACTION_PINS.get("actions/checkout")}`;
  const setupNode = `actions/setup-node@${ACTION_PINS.get("actions/setup-node")}`;
  const setupPython = `actions/setup-python@${ACTION_PINS.get("actions/setup-python")}`;
  if (actions.length !== 10
    || counts.get(checkout) !== 4
    || counts.get(setupNode) !== 4
    || counts.get(setupPython) !== 2
    || actions.some((action) => {
      const separator = action.lastIndexOf("@");
      return separator < 1
        || ACTION_PINS.get(action.slice(0, separator)) !== action.slice(separator + 1);
    })) {
    errors.push("CI immutable action pins");
  }
  if ((source.match(/persist-credentials: false/gu) ?? []).length !== 4
    || (source.match(/package-manager-cache: false/gu) ?? []).length !== 4) {
    errors.push("CI checkout and cache policy");
  }
  if ((unix.match(/node --test test\/unit\/test-suite-runner\.test\.mjs/gu) ?? []).length !== 1
    || (checks.match(/node --test test\/unit\/test-suite-runner\.test\.mjs/gu) ?? []).length !== 1) {
    errors.push("CI test-runner bootstrap canary");
  }
  return errors;
}


function releaseContractErrors(source) {
  const errors = [];
  const jobs = jobBlocks(source);
  const verify = jobs.get("verify") ?? "";
  const packageJob = jobs.get("package") ?? "";
  const publish = jobs.get("publish") ?? "";
  const jobNames = [...jobs.keys()];

  if (jobNames.join(",") !== "verify,package,publish") errors.push("job order");
  if (!/^permissions: \{\}$/mu.test(source)) errors.push("default permissions");
  if (!/^  cancel-in-progress: false$/mu.test(source)) errors.push("concurrency cancellation");
  if (/continue-on-error:/u.test(source)) errors.push("release fail-open policy");
  if (/workflow_dispatch|pull_request|schedule:/u.test(source)) errors.push("tag-only trigger");
  if (!/^    tags:\n      - "v\*"$/mu.test(source)) errors.push("release tag trigger");
  if (!/timeout-minutes: 75/u.test(verify)
    || !/timeout-minutes: 15/u.test(packageJob)
    || !/timeout-minutes: 15/u.test(publish)) errors.push("job timeouts");
  if (!/needs: verify/u.test(packageJob) || !/needs: package/u.test(publish)) errors.push("job dependencies");
  if (!/^    permissions:\n      actions: read\n      contents: read\n/mu.test(verify)
    || /contents: write|id-token|attestations/u.test(verify)) errors.push("verify permissions");
  if (!/^    runs-on: ubuntu-latest$/mu.test(verify)
    || /strategy:|matrix[.:]|npm test|npm run benchmark:enterprise|npm pack /u.test(verify)) {
    errors.push("release gate is a single job that does not re-run the matrix");
  }
  if ((verify.match(/^        run: node scripts\/verify-ci-gate\.mjs$/gmu) ?? []).length !== 1
    || !/GITHUB_TOKEN: \$\{\{ github\.token \}\}/u.test(verify)
    || /continue-on-error:|\|\| true|if:/u.test(verify)) errors.push("exact-SHA full-matrix CI gate");
  if (!/attestations: write/u.test(packageJob)
    || !/contents: write/u.test(packageJob)
    || !/id-token: write/u.test(packageJob)) errors.push("package permissions");
  if (!/attestations: read/u.test(publish)
    || !/contents: write/u.test(publish)
    || /id-token: write/u.test(publish)) errors.push("publish permissions");

  const actions = [...source.matchAll(/^\s+-?\s*uses:\s*([^\s]+)$/gmu)].map((match) => match[1]);
  if (actions.length !== 10) errors.push("action count");
  for (const action of actions) {
    const separator = action.lastIndexOf("@");
    const name = action.slice(0, separator);
    const ref = action.slice(separator + 1);
    if (separator < 1 || ACTION_PINS.get(name) !== ref || !/^[0-9a-f]{40}$/u.test(ref)) {
      errors.push(`unpinned action: ${action}`);
    }
  }
  for (const name of ACTION_PINS.keys()) {
    if (!actions.some((action) => action.startsWith(`${name}@`))) errors.push(`missing action: ${name}`);
  }

  const pythonAction = `actions/setup-python@${ACTION_PINS.get("actions/setup-python")}`;
  if (actions.filter((action) => action === pythonAction).length !== 1
    || (source.match(/python-version: "3\.13\.14"/gu) ?? []).length !== 1
    || (source.match(/update-environment: false/gu) ?? []).length !== 1
    || /PYTHON/u.test(verify)
    || (packageJob.match(/PYTHON: \$\{\{ steps\.python\.outputs\.python-path \}\}/gu) ?? []).length !== 1
    || (source.match(/--python "\$PYTHON"/gu) ?? []).length !== 1) {
    errors.push("explicit Python provisioning");
  }
  if (!/scripts\/verify-release-package\.mjs/u.test(packageJob)
    || /scripts\/verify-release-package\.mjs/u.test(verify)
    || (packageJob.match(/^        run: npm run check$/gmu) ?? []).length !== 1
    || packageJob.indexOf("run: npm run check") > packageJob.indexOf("npm pack ")) {
    errors.push("package job source check and policy verifier");
  }
  if (!/npm install[\s\S]*"file:\$ARCHIVE_PATH"/u.test(packageJob)) {
    errors.push("SBOM local archive spec");
  }
  if (!/verification\.value\?\.smoke\?\.installer_v2_plan !== "passed"/u.test(packageJob)
    || !/verification\.value\?\.smoke\?\.installer_v2_zero_write !== true/u.test(packageJob)) {
    errors.push("installer v2 seal gate");
  }
  if ((packageJob.match(/npm pack /gu) ?? []).length !== 1
    || /npm pack /u.test(publish)) errors.push("single-build handoff");
  if (!/pack_report="\$RUNNER_TEMP\/npm-pack\.json"/u.test(packageJob)
    || !/test ! -e "\$pack_report"/u.test(packageJob)
    || !/> "\$pack_report"/u.test(packageJob)
    || !/' "\$pack_report"\)"/u.test(packageJob)
    || /release\/npm-pack\.json/u.test(packageJob)) errors.push("isolated pack report");
  if (!packageJob.includes(`syft/releases/download/v${SYFT_PINS.version}/`)
    || !packageJob.includes(SYFT_PINS.amd64)
    || !packageJob.includes(SYFT_PINS.arm64)
    || !/sha256sum --check --strict/u.test(packageJob)
    || !/--proto '=https'[\s\S]*--proto-redir '=https'/u.test(packageJob)
    || !/npm install[\s\S]*--ignore-scripts[\s\S]*--offline/u.test(packageJob)
    || !/dir:\$SBOM_SOURCE/u.test(packageJob)
    || !/--override-default-catalogers javascript-package-cataloger/u.test(packageJob)
    || !/spdx-json=/u.test(packageJob)
    || !/cyclonedx-json=/u.test(packageJob)
    || /anchore\/sbom-action|raw\.githubusercontent\.com\/anchore\/syft\/main/u.test(packageJob)
    || !/validateReleaseBundleDirectory/u.test(publish)) errors.push("SBOM gates");
  if (!/actions\/attest-build-provenance@/u.test(packageJob)
    || !/gh attestation verify/u.test(packageJob)
    || !/gh attestation verify/u.test(publish)) errors.push("provenance gates");
  if (!/overwrite: false/u.test(packageJob)
    || !/artifact_digest/u.test(packageJob)
    || !/artifact_id/u.test(packageJob)
    || !/EXPECTED_ARTIFACT_DIGEST/u.test(publish)
    || !/actions\/artifacts\/\$EXPECTED_ARTIFACT_ID\/zip/u.test(publish)
    || !/test "\$actual_artifact_digest" = "\$expected_artifact_digest"/u.test(publish)
    || !/actions\/download-artifact@/u.test(publish)) errors.push("immutable artifact handoff");
  if ((source.match(/package-manager-cache: false/gu) ?? []).length !== 3) errors.push("setup-node cache policy");
  const recoveryValidation = packageJob.indexOf("const result = validateMatchingReleaseBundles");
  const recoveryDeletion = packageJob.indexOf('gh release delete "$GITHUB_REF_NAME" --yes');
  if (!/GITHUB_RUN_ID-attempt-\$GITHUB_RUN_ATTEMPT/u.test(packageJob)
    || recoveryValidation < 0
    || recoveryDeletion < recoveryValidation
    || !/already_published=/u.test(packageJob)
    || (packageJob.match(/steps\.remote_state\.outputs\.already_published != 'true'/gu) ?? []).length !== 2
    || !/gh release delete "\$GITHUB_REF_NAME" --yes/u.test(packageJob)
    || /--cleanup-tag/u.test(packageJob)) errors.push("retry recovery");
  if (!source.includes("[A-Za-z0-9._+-]*\\.tgz")
    || !/parseReleaseTag/u.test(packageJob)
    || !/EXPECTED_PRERELEASE/u.test(packageJob)
    || /includes\("-"\)|== \*-\*/u.test(source)) errors.push("strict SemVer identity");
  if (!/gh release create/u.test(packageJob)
    || !/--draft/u.test(packageJob)
    || !/remote draft/u.test(packageJob)
    || /--draft=false/u.test(packageJob)) errors.push("draft-first package gate");
  if (!/gh release download/u.test(packageJob)
    || !/gh release download/u.test(publish)
    || (source.match(/const result = validateMatchingReleaseBundles/gu) ?? []).length < 4) errors.push("remote byte verification");
  const publishValidation = publish.indexOf("const result = validateMatchingReleaseBundles");
  const publishEdit = publish.indexOf('gh release edit "$GITHUB_REF_NAME" --draft=false');
  const finalPublishValidation = publish.lastIndexOf("const result = validateMatchingReleaseBundles");
  if (!/startsWith\(github\.ref, 'refs\/tags\/v'\)/u.test(publish)
    || (source.match(/git rev-parse --verify/gu) ?? []).length !== 4
    || !/gh release edit "\$GITHUB_REF_NAME" --draft=false/u.test(publish)
    || publishValidation < 0
    || publishEdit < publishValidation
    || finalPublishValidation < publishEdit
    || !/ALREADY_PUBLISHED/u.test(publish)
    || !/timeout --signal=TERM --kill-after=15s 60s/u.test(publish)
    || !/publication_deadline=\$\(\(SECONDS \+ 120\)\)/u.test(publish)) errors.push("publish gate");
  return errors;
}


function inlineNodeModule(stepName) {
  const marker = `      - name: ${stepName}\n`;
  const stepStart = workflow.indexOf(marker);
  assert.notEqual(stepStart, -1, `missing workflow step: ${stepName}`);
  const stepEnd = workflow.indexOf("\n      - name: ", stepStart + marker.length);
  const step = workflow.slice(stepStart, stepEnd === -1 ? workflow.length : stepEnd);
  const heredoc = "node --input-type=module <<'NODE'\n";
  const scriptStart = step.indexOf(heredoc);
  assert.notEqual(scriptStart, -1, `missing inline Node module: ${stepName}`);
  const bodyStart = scriptStart + heredoc.length;
  const bodyEnd = step.indexOf("\n          NODE", bodyStart);
  assert.notEqual(bodyEnd, -1, `unterminated inline Node module: ${stepName}`);
  return `${step.slice(bodyStart, bodyEnd).replace(/^ {10}/gmu, "")}\n`;
}


function runInlineModule(script, { cwd, env }) {
  return spawnSync(process.execPath, ["--input-type=module"], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    input: script,
    maxBuffer: 1024 * 1024,
    shell: false,
    timeout: 10_000,
  });
}


function sha256(file) {
  return crypto.createHash("sha256").update(readFileSync(file)).digest("hex");
}


test("release workflow is tag-only, least-privilege, ordered, and bounded", () => {
  assert.deepEqual(releaseContractErrors(workflow), []);
  assert.equal(workflow.includes("\t"), false, "workflow must not contain tab indentation");
});


test("workflow source normalization accepts Windows checkouts", () => {
  for (const source of [ciWorkflow, workflow]) {
    const crlf = source.replace(/\n/gu, "\r\n");
    assert.equal(normalizeLineEndings(crlf), source);
  }
  assert.deepEqual(
    releaseContractErrors(normalizeLineEndings(workflow.replace(/\n/gu, "\r\n"))),
    [],
  );
});


test("CI pins actions and separates the compatibility matrix from the performance gate", () => {
  assert.deepEqual(ciContractErrors(ciWorkflow), []);
  assert.match(
    ciWorkflow,
    /- id: python\n\s+if: steps\.scope\.outputs\.docs_only != 'true'\n\s+uses: actions\/setup-python@ece7cb06caefa5fff74198d8649806c4678c61a1\n\s+with:\n\s+python-version: "3\.13\.14"\n\s+update-environment: false/u,
  );
  assert.match(
    ciWorkflow,
    /- name: Run the test suite\n\s+if: steps\.scope\.outputs\.docs_only != 'true'\n\s+run: npm test\n\s+env:\n\s+PYTHON: \$\{\{ steps\.python\.outputs\.python-path \}\}/u,
  );
  assert.match(
    ciWorkflow,
    /- name: Verify bounded test-runner bootstrap\n\s+if: steps\.scope\.outputs\.docs_only != 'true'\n\s+run: node --test test\/unit\/test-suite-runner\.test\.mjs/u,
  );
});


test("CI selects the matrix by event: reduced for pull requests, six cells for push, full otherwise", () => {
  const events = ["pullRequest", "push", "full"];
  for (const event of events) {
    assert.deepEqual(eventChecks(ciWorkflow, event), EXPECTED_CHECKS[event], event);
  }
  assert.equal(EXPECTED_CHECKS.pullRequest.length, 4);
  assert.equal(EXPECTED_CHECKS.push.length, 6);
  assert.equal(EXPECTED_CHECKS.full.length, 12);
  // Only pull requests and pushes take a reduced matrix; schedule and manual
  // dispatch fall through to the full one.
  assert.match(ciWorkflow, /fromJSON\(github\.event_name == 'pull_request' && '[^']+' \|\| github\.event_name == 'push' && '[^']+' \|\| '/u);
  assert.match(
    ciWorkflow,
    /^on:\n  push:\n    branches: \[main\]\n  pull_request:\n  schedule:\n    - cron: "[^"\n]+"\n  workflow_dispatch:\n/mu,
  );
  // The unsharded job is Linux only; macOS and Windows never run there.
  const unix = jobBlocks(ciWorkflow).get("test");
  for (const event of events) {
    assert.deepEqual([...new Set(ciMatrices(unix)[event].map((cell) => cell.os))], ["ubuntu-latest"], event);
  }
});


test("macOS and Windows run as three shards per Node line, each carrying its own shard selector", () => {
  const shard = jobBlocks(ciWorkflow).get("test-shard");
  const aggregator = jobBlocks(ciWorkflow).get("test-sharded");
  assert.equal(SHARD_TOTAL, CI_SHARD_TOTAL);
  assert.deepEqual([...SHARDED_PLATFORMS].sort(), ["macos-latest", "windows-latest"]);
  for (const event of ["pullRequest", "push", "full"]) {
    const cells = ciMatrices(aggregator)[event];
    assert.deepEqual([...new Set(cells.map((cell) => cell.os))].sort(), [...SHARDED_PLATFORMS].sort(), event);
    const names = ciMatrices(shard)[event]
      .map((cell) => shardJobName(cell.os, cell.node, ...cell.shard.split("/").map(Number)))
      .sort();
    assert.deepEqual(
      names,
      cells.flatMap(({ os: osName, node }) => [1, 2, 3].map((index) => shardJobName(osName, node, index, CI_SHARD_TOTAL))).sort(),
      event,
    );
  }
  // The runner reads the selector from the matrix value, so the total lives in one place.
  assert.match(shard, /AGENTIC_SDLC_TEST_SHARD: \$\{\{ matrix\.shard \}\}/u);
  assert.equal(TEST_SHARD_ENV, "AGENTIC_SDLC_TEST_SHARD");
  assert.match(shard, new RegExp(`name: ${escapeRegExp("test shard (${{ matrix.os }}, ${{ matrix.node }}, ${{ matrix.shard }})")}`, "u"));
  assert.match(shard, /^    runs-on: \$\{\{ matrix\.os \}\}$/mu);
  assert.match(shard, new RegExp(`- name: ${escapeRegExp(SHARD_TEST_STEP)}\\n`, "u"));
  assert.match(aggregator, new RegExp(`--shards ${CI_SHARD_TOTAL}`, "u"));
  // No shard carries shard-independent work, so shard 1 is not longer than the others.
  for (const command of SHARD_INDEPENDENT_COMMANDS) {
    assert.equal(shard.includes(command), false, command);
  }
  assert.doesNotMatch(shard, /startsWith\(matrix\.shard/u);
});


test("the checks job runs the shard-independent steps once per OS and Node line, on that OS", () => {
  const checks = jobBlocks(ciWorkflow).get("test-checks");
  const aggregator = jobBlocks(ciWorkflow).get("test-sharded");
  for (const event of ["pullRequest", "push", "full"]) {
    assert.deepEqual(
      ciMatrices(checks)[event].map(({ os: osName, node }) => checksJobName(osName, node)).sort(),
      ciMatrices(aggregator)[event].map(({ os: osName, node }) => checksJobName(osName, node)).sort(),
      event,
    );
  }
  assert.match(checks, new RegExp(`name: ${escapeRegExp("checks (${{ matrix.os }}, ${{ matrix.node }})")}`, "u"));
  assert.match(checks, /^    runs-on: \$\{\{ matrix\.os \}\}$/mu);
  for (const name of CHECKS_STEPS) {
    assert.match(checks, new RegExp(`- name: ${escapeRegExp(name)}\\n`, "u"), name);
  }
  for (const command of SHARD_INDEPENDENT_COMMANDS) {
    assert.equal((checks.match(new RegExp(`run: ${escapeRegExp(command)}$`, "gmu")) ?? []).length, 1, command);
  }
  assert.doesNotMatch(checks, /npm test|setup-python/u);
  // The same steps still run on Linux, inside the unsharded job.
  const unix = jobBlocks(ciWorkflow).get("test");
  for (const command of SHARD_INDEPENDENT_COMMANDS) {
    assert.equal((unix.match(new RegExp(`run: ${escapeRegExp(command)}$`, "gmu")) ?? []).length, 1, command);
  }
});


test("the sharded aggregator owns the required check names and fails unless every job of its cell passed", () => {
  const aggregator = jobBlocks(ciWorkflow).get("test-sharded");
  assert.match(aggregator, /^    name: test \(\$\{\{ matrix\.os \}\}, \$\{\{ matrix\.node \}\}\)$/mu);
  assert.match(aggregator, /^    needs: \[test-shard, test-checks\]$/mu);
  assert.match(aggregator, /^    if: always\(\)$/mu);
  assert.match(aggregator, /^      actions: read$/mu);
  assert.doesNotMatch(aggregator, /continue-on-error|\|\| true/u);
  assert.match(aggregator, /node scripts\/verify-ci-shards\.mjs --platform "\$MATRIX_OS" --node "\$MATRIX_NODE" --shards 3$/mu);
  // The required names are unchanged and the unsharded job keeps its default "test (<os>, <node>)" name.
  assert.doesNotMatch(jobBlocks(ciWorkflow).get("test"), /^    name:/mu);
  for (const name of REQUIRED_PULL_REQUEST_CHECKS) {
    assert.ok(eventChecks(ciWorkflow, "pullRequest").includes(name), name);
  }
});


test("the release gate requires exactly the cells that the push CI run produces", () => {
  assert.deepEqual([...requiredCiJobNames()].sort(), eventChecks(ciWorkflow, "push"));
  assert.equal(requiredCiJobNames().length, 6);
  assert.deepEqual(
    CI_GATE_POLICY.cells.map(({ platform, node }) => `${platform}|${node}`),
    [
      "ubuntu-latest|18.20.3",
      "ubuntu-latest|20.12.0",
      "ubuntu-latest|21.6.0",
      "ubuntu-latest|24",
      "macos-latest|24",
      "windows-latest|24",
    ],
  );
  assert.equal(CI_GATE_POLICY.workflowFile, "ci.yml");
  assert.equal(CI_GATE_POLICY.event, "push");
  assert.equal(CI_GATE_POLICY.branch, "main");
  for (const name of REQUIRED_PULL_REQUEST_CHECKS) {
    assert.ok(requiredCiJobNames().includes(name), `${name} must also be required by the release gate`);
  }
  assert.match(ciWorkflow, /^on:\n  push:\n    branches: \[main\]\n/mu);
  // The gate's "the suite ran" markers are real step names of the matching jobs.
  const jobs = jobBlocks(ciWorkflow);
  assert.match(jobs.get("test"), new RegExp(`- name: ${escapeRegExp(CI_GATE_POLICY.executedStep("ubuntu-latest"))}\\n`, "u"));
  for (const platform of SHARDED_PLATFORMS) {
    assert.equal(CI_GATE_POLICY.executedStep(platform), "Confirm every shard ran the test suite", platform);
    assert.ok(CI_GATE_POLICY.shardedPlatforms.includes(platform), platform);
    assert.match(jobs.get("test-sharded"), new RegExp(`- name: ${escapeRegExp(CI_GATE_POLICY.executedStep(platform))}\\n`, "u"));
  }
  assert.equal(CI_GATE_POLICY.shards, SHARD_TOTAL);
  assert.equal(CI_GATE_POLICY.executedStep("ubuntu-latest"), "Run the test suite");
});


test("a documentation-only change skips steps, never jobs, and never counts as verification", () => {
  const jobs = jobBlocks(ciWorkflow);
  for (const id of ["test", "test-shard", "test-checks", "test-sharded"]) {
    const { scope, after } = stepLayout(jobs.get(id));
    assert.match(scope, SCOPE_STEP, id);
    assert.ok(after.length > 0);
  }
  // No job is skipped as a whole (the aggregator's only job-level condition is always()).
  for (const id of ["test", "test-shard", "test-checks"]) {
    assert.doesNotMatch(jobs.get(id), /^    if:/mu, id);
  }
  // The gated steps are exactly the ones after the scope detection; the shard
  // verification in the aggregator is never skipped.
  const { after } = stepLayout(jobs.get("test-sharded"));
  assert.equal(stepIsGated(after[0]), false);
  assert.equal(stepIsGated(after[1]), true);
  // Pushes, pull requests only: the script itself refuses every other event.
  assert.match(ciWorkflow, /CI_EVENT_NAME: \$\{\{ github\.event_name \}\}/u);
  // Tests read README.md and docs/, so ubuntu Node 24 never skips; nothing else opts out.
  assert.ok(stepLayout(jobs.get("test")).scope.includes(ALWAYS_RUN_ENV));
  for (const id of ["test-shard", "test-checks", "test-sharded"]) {
    assert.doesNotMatch(jobs.get(id), /CI_ALWAYS_RUN/u, id);
  }
  // Required-by-the-gate jobs must have a marker step that the skip also skips.
  for (const [id, platform] of [["test", "ubuntu-latest"], ["test-sharded", "windows-latest"], ["test-sharded", "macos-latest"]]) {
    const marker = stepLayout(jobs.get(id)).after.find((step) => stepName(step) === CI_GATE_POLICY.executedStep(platform));
    assert.ok(marker !== undefined && stepIsGated(marker), `${id} marker step must be gated`);
  }
  // The shard and checks steps the aggregator confirms are real, gated steps.
  const shardTest = stepLayout(jobs.get("test-shard")).after.find((step) => stepName(step) === SHARD_TEST_STEP);
  assert.ok(shardTest !== undefined && stepIsGated(shardTest), "the shard test step must be gated");
  for (const name of CHECKS_STEPS) {
    const step = stepLayout(jobs.get("test-checks")).after.find((candidate) => stepName(candidate) === name);
    assert.ok(step !== undefined && stepIsGated(step), `${name} must be gated`);
  }
});


test("CI serializes only macOS Node 18.20.3 shards, gives Linux four workers, and keeps two elsewhere", () => {
  const jobs = jobBlocks(ciWorkflow);
  const policy = ciConcurrencyPolicy(jobs.get("test-shard"));
  assert.notEqual(policy, null);
  assert.deepEqual(
    [policy.serializedOs, policy.serializedNode, policy.serializedValue, policy.defaultValue],
    ["macos-latest", "18.20.3", "1", "2"],
  );
  const { full, push, pullRequest } = ciMatrices(jobs.get("test-shard"));
  const perCell = (cells) => cells.map((cell) => [`${cell.os}/${cell.node}`, policy.forCell(cell)]);
  assert.deepEqual(
    [...new Set(perCell(full).filter(([, value]) => value === "1").map(([name]) => name))],
    ["macos-latest/18.20.3"],
  );
  assert.equal(new Set(perCell(full).filter(([, value]) => value === "2").map(([name]) => name)).size, 7);
  assert.deepEqual(
    [...new Set(perCell(push).map(([name, value]) => `${name}=${value}`))].sort(),
    ["macos-latest/24=2", "windows-latest/24=2"],
  );
  assert.deepEqual([...new Set(perCell(pullRequest).map(([name, value]) => `${name}=${value}`))].sort(), [
    "macos-latest/24=2",
    "windows-latest/24=2",
  ]);
  // Linux runs the whole suite per job with four workers.
  assert.match(jobs.get("test"), /AGENTIC_SDLC_TEST_CONCURRENCY: "4"$/mu);
  assert.doesNotMatch(jobs.get("test"), /matrix\.os == 'macos-latest'/u);
  // The release no longer runs tests, so it must not carry its own concurrency policy.
  assert.equal(/AGENTIC_SDLC_TEST_CONCURRENCY/u.test(workflow), false);
});


// Replaces text inside one job of the workflow only, so a fixture cannot
// accidentally change a similar line of another job.
function replaceInJob(source, id, from, to) {
  const start = source.indexOf(`\n  ${id}:\n`);
  assert.notEqual(start, -1, `${id} must exist`);
  const next = /\n  [a-z][a-z0-9_-]*:\n/u.exec(source.slice(start + 1));
  const end = next ? start + 1 + next.index : source.length;
  const block = source.slice(start, end);
  assert.ok(block.includes(from), `${id} must contain: ${from}`);
  return source.slice(0, start) + block.replace(from, () => to) + source.slice(end);
}


const AGGREGATOR_PUSH_MATRIX = `github.event_name == 'push' && '{"os":["macos-latest","windows-latest"],"node":[24]}'`;
const SHARD_STEP_HEAD = "      - name: Run this shard of the test suite\n";


test("CI guards reject a weakened matrix, trigger, or concurrency policy", () => {
  const fixtures = [
    {
      name: "pull request matrix without the Node 18 cell",
      source: replaceInJob(ciWorkflow, "test", '"node":[24,"18.20.3"]', '"node":[24]'),
      expected: "CI pull request matrix",
    },
    {
      name: "pull request matrix missing a required platform",
      source: replaceInJob(
        ciWorkflow,
        "test-sharded",
        `'{"os":["macos-latest","windows-latest"],"node":[24]}' || github.event_name == 'push'`,
        `'{"os":["macos-latest"],"node":[24]}' || github.event_name == 'push'`,
      ),
      expected: "CI pull request matrix",
    },
    {
      name: "push matrix missing a gated Node line",
      source: replaceInJob(
        ciWorkflow,
        "test",
        `github.event_name == 'push' && '{"os":["ubuntu-latest"],"node":["18.20.3","20.12.0","21.6.0",24]}'`,
        `github.event_name == 'push' && '{"os":["ubuntu-latest"],"node":["18.20.3","20.12.0",24]}'`,
      ),
      expected: "CI push matrix",
    },
    {
      name: "push matrix missing the gated macOS cell",
      source: replaceInJob(
        ciWorkflow,
        "test-sharded",
        AGGREGATOR_PUSH_MATRIX,
        `github.event_name == 'push' && '{"os":["windows-latest"],"node":[24]}'`,
      ),
      expected: "CI push matrix",
    },
    {
      name: "push matrix with a cell the gate does not require",
      source: replaceInJob(
        ciWorkflow,
        "test-sharded",
        AGGREGATOR_PUSH_MATRIX,
        `github.event_name == 'push' && '{"os":["macos-latest","windows-latest"],"node":[24,"18.20.3"]}'`,
      ),
      expected: "CI push matrix",
    },
    {
      name: "full matrix dropping a Node line",
      source: replaceInJob(
        ciWorkflow,
        "test",
        '"node":["18.20.3","20.12.0","21.6.0",24]}\') }}\n    runs-on: ${{ matrix.os }}',
        '"node":["18.20.3","20.12.0",24]}\') }}\n    runs-on: ${{ matrix.os }}',
      ),
      expected: "CI full matrix",
    },
    {
      name: "full matrix reduced for every event",
      source: ciWorkflow.replace("github.event_name == 'pull_request'", "github.event_name != 'never'"),
      expected: "CI matrix selection",
    },
    {
      name: "missing schedule trigger",
      source: ciWorkflow.replace(/  schedule:\n    - cron: "[^"]+"\n/u, ""),
      expected: "CI triggers",
    },
    {
      name: "missing manual trigger",
      source: ciWorkflow.replace("  workflow_dispatch:\n", ""),
      expected: "CI triggers",
    },
    {
      name: "Linux worker count not raised",
      source: ciWorkflow.replace('AGENTIC_SDLC_TEST_CONCURRENCY: "4"', 'AGENTIC_SDLC_TEST_CONCURRENCY: "2"'),
      expected: "CI test concurrency policy",
    },
    {
      name: "macOS Node 18 shards no longer serialized",
      source: ciWorkflow.replace("&& '1' ||", "&& '2' ||"),
      expected: "CI test concurrency policy",
    },
    {
      name: "shard concurrency changed",
      source: ciWorkflow.replace("|| '2' }}", "|| '4' }}"),
      expected: "CI test concurrency policy",
    },
  ];
  for (const fixture of fixtures) {
    assert.notEqual(fixture.source, ciWorkflow, `${fixture.name} must change the workflow`);
    assert.ok(
      ciContractErrors(fixture.source).includes(fixture.expected),
      `${fixture.name} must be rejected as ${fixture.expected}`,
    );
  }
  // A gated cell dropped from the push matrix no longer matches what the gate requires.
  const dropped = fixtures[2].source;
  assert.notDeepEqual(eventChecks(dropped, "push"), [...requiredCiJobNames()].sort());
});


test("CI guards reject a missing shard job, a shard that is not run, and a mis-scoped shard", () => {
  const doctorStep = "      - name: Run the installation doctor\n        if: steps.scope.outputs.docs_only != 'true'\n        run: npm run doctor\n";
  const checkStep = "      - name: Check source syntax\n        if: steps.scope.outputs.docs_only != 'true'\n        run: npm run check\n";
  const fixtures = [
    {
      name: "shard job removed",
      source: withoutJob(ciWorkflow, "test-shard"),
      expected: "CI job boundary",
    },
    {
      name: "third shard dropped from the matrix",
      source: ciWorkflow.replaceAll('"shard":["1/3","2/3","3/3"]', '"shard":["1/3","2/3"]'),
      expected: "CI shards",
    },
    {
      name: "shard selector not passed to the runner",
      source: ciWorkflow.replace("          AGENTIC_SDLC_TEST_SHARD: ${{ matrix.shard }}\n", ""),
      expected: "CI shards",
    },
    {
      name: "doctor back in every shard",
      source: replaceInJob(ciWorkflow, "test-shard", SHARD_STEP_HEAD, `${doctorStep}${SHARD_STEP_HEAD}`),
      expected: "CI shards",
    },
    {
      name: "source check back in every shard",
      source: replaceInJob(ciWorkflow, "test-shard", SHARD_STEP_HEAD, `${checkStep}${SHARD_STEP_HEAD}`),
      expected: "CI shards",
    },
    {
      name: "shards on a Linux runner",
      source: replaceInJob(ciWorkflow, "test-shard", "    runs-on: ${{ matrix.os }}\n", "    runs-on: ubuntu-latest\n"),
      expected: "CI shards",
    },
    {
      name: "Windows cell back in the unsharded job",
      source: replaceInJob(ciWorkflow, "test", '"os":["ubuntu-latest"],"node":[24,"18.20.3"]', '"os":["ubuntu-latest","windows-latest"],"node":[24,"18.20.3"]'),
      expected: "CI sharded platforms",
    },
    {
      name: "macOS cell back in the unsharded job",
      source: replaceInJob(ciWorkflow, "test", '"os":["ubuntu-latest"],"node":[24,"18.20.3"]', '"os":["ubuntu-latest","macos-latest"],"node":[24,"18.20.3"]'),
      expected: "CI sharded platforms",
    },
    {
      name: "shard matrix without the macOS shards",
      source: replaceInJob(
        ciWorkflow,
        "test-shard",
        `github.event_name == 'push' && '{"os":["macos-latest","windows-latest"]`,
        `github.event_name == 'push' && '{"os":["windows-latest"]`,
      ),
      expected: "CI shards",
    },
  ];
  for (const fixture of fixtures) {
    assert.notEqual(fixture.source, ciWorkflow, `${fixture.name} must change the workflow`);
    assert.ok(
      ciContractErrors(fixture.source).includes(fixture.expected),
      `${fixture.name} must be rejected as ${fixture.expected}`,
    );
  }
});


test("CI guards reject a checks job that drops, relocates, or duplicates a shard-independent step", () => {
  const fixtures = [
    {
      name: "runner canary removed from the checks job",
      source: replaceInJob(ciWorkflow, "test-checks", "run: node --test test/unit/test-suite-runner.test.mjs", "run: true"),
    },
    {
      name: "source check removed from the checks job",
      source: replaceInJob(ciWorkflow, "test-checks", "run: npm run check", "run: true"),
    },
    {
      name: "doctor removed from the checks job",
      source: replaceInJob(ciWorkflow, "test-checks", "run: npm run doctor", "run: true"),
    },
    {
      name: "pack dry run removed from the checks job",
      source: replaceInJob(ciWorkflow, "test-checks", "run: npm pack --dry-run", "run: true"),
    },
    {
      name: "checks job moved to another operating system",
      source: replaceInJob(ciWorkflow, "test-checks", "    runs-on: ${{ matrix.os }}\n", "    runs-on: ubuntu-latest\n"),
    },
    {
      name: "checks job without the Windows cells",
      source: replaceInJob(
        ciWorkflow,
        "test-checks",
        `github.event_name == 'push' && '{"os":["macos-latest","windows-latest"],"node":[24]}'`,
        `github.event_name == 'push' && '{"os":["macos-latest"],"node":[24]}'`,
      ),
    },
    {
      name: "checks job running the test suite",
      source: replaceInJob(ciWorkflow, "test-checks", "run: npm run doctor", "run: npm test"),
    },
    {
      name: "checks job renamed",
      source: replaceInJob(ciWorkflow, "test-checks", "    name: checks (", "    name: extras ("),
    },
  ];
  for (const fixture of fixtures) {
    assert.notEqual(fixture.source, ciWorkflow, `${fixture.name} must change the workflow`);
    assert.ok(ciContractErrors(fixture.source).includes("CI checks job"), `${fixture.name} must be rejected`);
  }
  assert.ok(
    ciContractErrors(replaceInJob(ciWorkflow, "test-checks", "run: node --test test/unit/test-suite-runner.test.mjs", "run: true"))
      .includes("CI test-runner bootstrap canary"),
  );
});


test("CI guards reject an aggregator that does not fail on a failed shard or changes a required name", () => {
  const verifyCommand = 'node scripts/verify-ci-shards.mjs --platform "$MATRIX_OS" --node "$MATRIX_NODE" --shards 3';
  const fixtures = [
    {
      name: "aggregator skipped when a shard fails (no always())",
      source: ciWorkflow.replace("    if: always()\n", ""),
      expected: "CI sharded aggregator",
    },
    {
      name: "aggregator without its dependency on the shards and checks",
      source: ciWorkflow.replace("    needs: [test-shard, test-checks]\n", ""),
      expected: "CI sharded aggregator",
    },
    {
      name: "aggregator without its dependency on the checks job",
      source: ciWorkflow.replace("    needs: [test-shard, test-checks]\n", "    needs: test-shard\n"),
      expected: "CI sharded aggregator",
    },
    {
      name: "aggregator that tolerates a failed verification",
      source: ciWorkflow.replace('--shards 3\n        env:', '--shards 3 || true\n        env:'),
      expected: "CI sharded aggregator",
    },
    {
      name: "aggregator verification replaced by a no-op",
      source: ciWorkflow.replace(`        run: ${verifyCommand}\n`, "        run: echo ok\n"),
      expected: "CI sharded aggregator",
    },
    {
      name: "aggregator expecting fewer shards than are run",
      source: ciWorkflow.replace('--node "$MATRIX_NODE" --shards 3\n', '--node "$MATRIX_NODE" --shards 2\n'),
      expected: "CI sharded aggregator",
    },
    {
      name: "aggregator verifying another platform",
      source: ciWorkflow.replace('--platform "$MATRIX_OS" --node "$MATRIX_NODE" --shards 3\n', '--platform ubuntu-latest --node "$MATRIX_NODE" --shards 3\n'),
      expected: "CI sharded aggregator",
    },
    {
      name: "aggregator verifying a fixed platform instead of its own",
      source: ciWorkflow.replaceAll('--platform "$MATRIX_OS"', "--platform windows-latest"),
      expected: "CI sharded aggregator",
    },
    {
      name: "aggregator without Actions read permission",
      source: ciWorkflow.replace("      actions: read\n      contents: read\n", "      contents: read\n"),
      expected: "CI sharded aggregator",
    },
    {
      name: "aggregator marked fail-open",
      source: ciWorkflow.replace("    needs: [test-shard, test-checks]\n", "    needs: [test-shard, test-checks]\n    continue-on-error: true\n"),
      expected: "CI fail-open policy",
    },
    {
      name: "required check name changed",
      source: ciWorkflow.replace("    name: test (${{ matrix.os }}, ${{ matrix.node }})\n", "    name: sharded (${{ matrix.os }}, ${{ matrix.node }})\n"),
      expected: "CI required check names",
    },
    {
      name: "required check name dropped",
      source: ciWorkflow.replace("    name: test (${{ matrix.os }}, ${{ matrix.node }})\n", ""),
      expected: "CI required check names",
    },
    {
      name: "unsharded job renamed",
      source: ciWorkflow.replace("  test:\n    timeout-minutes: 35\n", "  test:\n    name: unit (${{ matrix.os }}, ${{ matrix.node }})\n    timeout-minutes: 35\n"),
      expected: "CI required check names",
    },
  ];
  for (const fixture of fixtures) {
    assert.notEqual(fixture.source, ciWorkflow, `${fixture.name} must change the workflow`);
    assert.ok(
      ciContractErrors(fixture.source).includes(fixture.expected),
      `${fixture.name} must be rejected as ${fixture.expected}`,
    );
  }
});


test("CI guards reject a weakened documentation-only skip", () => {
  const gated = "if: steps.scope.outputs.docs_only != 'true'";
  const fixtures = [
    {
      name: "test step not gated by the scope",
      source: ciWorkflow.replace(`      - name: Run the test suite\n        ${gated}\n`, "      - name: Run the test suite\n"),
      expected: "CI docs-only skip",
    },
    {
      name: "skip that fails open when the scope output is missing",
      source: ciWorkflow.replace(`${gated}\n        run: npm test`, "if: steps.scope.outputs.docs_only == 'false'\n        run: npm test"),
      expected: "CI docs-only skip",
    },
    {
      name: "skip keyed on the event instead of the diff",
      source: ciWorkflow.replace(`${gated}\n        run: npm test`, "if: github.event_name != 'schedule'\n        run: npm test"),
      expected: "CI docs-only skip",
    },
    {
      name: "whole job skipped instead of its steps",
      source: ciWorkflow.replace("  test:\n", "  test:\n    if: github.event_name != 'pull_request'\n"),
      expected: "CI required job skipped",
    },
    {
      name: "shard job skipped as a whole",
      source: ciWorkflow.replace("  test-shard:\n", "  test-shard:\n    if: false\n"),
      expected: "CI required job skipped",
    },
    {
      name: "checks job skipped as a whole",
      source: ciWorkflow.replace("  test-checks:\n", "  test-checks:\n    if: false\n"),
      expected: "CI required job skipped",
    },
    {
      name: "checks step not gated by the scope",
      source: replaceInJob(ciWorkflow, "test-checks", `${gated}\n        run: npm run doctor`, "if: always()\n        run: npm run doctor"),
      expected: "CI docs-only skip",
    },
    {
      name: "shard test step not gated by the scope",
      source: replaceInJob(ciWorkflow, "test-shard", `${gated}\n        run: npm test`, "if: always()\n        run: npm test"),
      expected: "CI docs-only skip",
    },
    {
      name: "scope detection missing",
      source: ciWorkflow.replace(/      - id: scope\n        name: Detect Markdown-only changes\n        run: node scripts\/ci-change-scope\.mjs\n        env:\n(?:          [A-Z_]+: .*\n){3}/u, ""),
      expected: "CI docs-only skip",
    },
    {
      name: "scope detection without the base commit",
      source: ciWorkflow.replace("          CI_BASE_SHA: ${{ github.event.pull_request.base.sha }}\n", ""),
      expected: "CI docs-only skip",
    },
    {
      name: "ubuntu Node 24 allowed to skip on docs-only changes",
      source: ciWorkflow.replace("          # Tests read README.md and docs/, so this reference cell never skips.\n          CI_ALWAYS_RUN: ${{ matrix.os == 'ubuntu-latest' && matrix.node == 24 }}\n", ""),
      expected: "CI reference cell skips",
    },
    {
      name: "always-run flag widened to every Unix cell",
      source: ciWorkflow.replace("CI_ALWAYS_RUN: ${{ matrix.os == 'ubuntu-latest' && matrix.node == 24 }}", "CI_ALWAYS_RUN: ${{ matrix.os == 'ubuntu-latest' }}"),
      expected: "CI reference cell skips",
    },
    {
      name: "always-run flag pointing at another Node line",
      source: ciWorkflow.replace("matrix.os == 'ubuntu-latest' && matrix.node == 24 }}\n", "matrix.os == 'ubuntu-latest' && matrix.node == 20 }}\n"),
      expected: "CI reference cell skips",
    },
    {
      name: "aggregator confirmation that the suite ran is always skipped",
      source: ciWorkflow.replace(`      - name: Confirm every shard ran the test suite\n        ${gated}\n`, "      - name: Confirm every shard ran the test suite\n        if: always()\n"),
      expected: "CI docs-only skip",
    },
    {
      name: "aggregator confirmation does not require executed shards",
      source: ciWorkflow.replace(" --require-executed", ""),
      expected: "CI sharded aggregator",
    },
    {
      name: "aggregator shard verification gated by the scope",
      source: ciWorkflow.replace("      - name: Require every shard of this Node line\n", `      - name: Require every shard of this Node line\n        ${gated}\n`),
      expected: "CI docs-only skip",
    },
  ];
  for (const fixture of fixtures) {
    assert.notEqual(fixture.source, ciWorkflow, `${fixture.name} must change the workflow`);
    assert.ok(
      ciContractErrors(fixture.source).includes(fixture.expected),
      `${fixture.name} must be rejected as ${fixture.expected}`,
    );
  }
});


test("CI fails closed without the independent runner canary and the release without its CI gate", () => {
  const command = "node --test test/unit/test-suite-runner.test.mjs";
  assert.ok(
    ciContractErrors(ciWorkflow.replace(command, "true"))
      .includes("CI test-runner bootstrap canary"),
  );
  assert.ok(
    ciContractErrors(replaceInJob(ciWorkflow, "test-checks", command, "true"))
      .includes("CI test-runner bootstrap canary"),
  );
  for (const source of [
    workflow.replace("run: node scripts/verify-ci-gate.mjs", "run: true"),
    workflow.replace("        run: node scripts/verify-ci-gate.mjs", "        continue-on-error: true\n        run: node scripts/verify-ci-gate.mjs"),
    workflow.replace("          GITHUB_TOKEN: ${{ github.token }}\n", ""),
  ]) {
    assert.ok(releaseContractErrors(source).includes("exact-SHA full-matrix CI gate"));
  }
  assert.ok(
    releaseContractErrors(workflow.replace("      actions: read\n", ""))
      .includes("verify permissions"),
  );
});


test("the release gate is one Linux job instead of a re-run of the test matrix", () => {
  const verify = jobBlocks(workflow).get("verify");
  assert.doesNotMatch(verify, /strategy:|matrix[.:]|npm test|benchmark:enterprise|npm pack |setup-python/u);
  assert.match(verify, /runs-on: ubuntu-latest/u);
  assert.match(verify, /actions: read\n\s+contents: read/u);
  assert.match(verify, /run: node scripts\/verify-ci-gate\.mjs/u);
  assert.match(jobBlocks(workflow).get("package"), /needs: verify/u);
  assert.match(workflow, /^concurrency:\n  group: release-.*\n  cancel-in-progress: false$/mu);
  // The packed artifact is still smoke-verified exactly once, in the package job.
  assert.equal((workflow.match(/node scripts\/verify-release-package\.mjs|scripts\/verify-release-package\.mjs/gu) ?? []).length, 1);
  assert.equal((workflow.match(/^\s+run: npm run check$/gmu) ?? []).length, 1);
  // The benchmark that used to run in the release matrix is part of the required CI cell.
  assert.match(
    jobBlocks(ciWorkflow).get("test"),
    /if: steps\.scope\.outputs\.docs_only != 'true' && matrix\.os == 'ubuntu-latest' && matrix\.node == 24\n\s+run: npm run benchmark:enterprise/u,
  );
});


test("CI guards reject fail-open performance configuration", () => {
  const fixtures = [
    ciWorkflow.replace(
      "        run: npm run benchmark:enterprise\n",
      "        run: npm run benchmark:enterprise\n        continue-on-error: true\n",
    ),
    ciWorkflow.replace("  test:\n", "  test:\n    continue-on-error: true\n"),
  ];
  for (const source of fixtures) {
    assert.ok(ciContractErrors(source).includes("CI fail-open policy"));
  }
});


test("CI guards reject a skipped required job", () => {
  const source = ciWorkflow.replace("  test:\n", "  test:\n    if: false\n");
  assert.ok(ciContractErrors(source).includes("CI required job skipped"));
});


test("all third-party actions use the approved immutable commit pins", () => {
  const actionRefs = actionReferences(workflow);
  for (const [name, sha] of ACTION_PINS) {
    assert.ok(actionRefs.includes(`${name}@${sha}`), `${name} must use its approved SHA`);
  }
  for (const source of [ciWorkflow, workflow]) {
    assert.equal(
      actionReferences(source).some((ref) => /@(main|master|v?\d+(?:\.\d+)*)$/u.test(ref)),
      false,
    );
  }
});


test("release workflow guards detect unsafe maintenance regressions", () => {
  const fixtures = [
    {
      name: "mutable action",
      source: workflow.replace(`actions/checkout@${ACTION_PINS.get("actions/checkout")}`, "actions/checkout@v6"),
      expected: "unpinned action",
    },
    {
      name: "manual release trigger",
      source: workflow.replace("  push:\n", "  workflow_dispatch:\n  push:\n"),
      expected: "tag-only trigger",
    },
    {
      name: "cancellable release",
      source: workflow.replace("cancel-in-progress: false", "cancel-in-progress: true"),
      expected: "concurrency cancellation",
    },
    {
      name: "release gate turned back into a matrix",
      source: workflow.replace("    runs-on: ubuntu-latest\n    steps:\n      - name: Check out the tagged source", "    strategy:\n      matrix:\n        os: [ubuntu-latest]\n    runs-on: ubuntu-latest\n    steps:\n      - name: Check out the tagged source"),
      expected: "release gate is a single job",
    },
    {
      name: "fail-open release gate",
      source: workflow.replace(
        "        run: node scripts/verify-ci-gate.mjs\n",
        "        run: node scripts/verify-ci-gate.mjs\n        continue-on-error: true\n",
      ),
      expected: "release fail-open policy",
    },
    {
      name: "release gate without Actions read permission",
      source: workflow.replace("      actions: read\n", ""),
      expected: "verify permissions",
    },
    {
      name: "release gate with write permission",
      source: workflow.replace("      actions: read\n      contents: read\n", "      actions: read\n      contents: write\n"),
      expected: "verify permissions",
    },
    {
      name: "package job without the source check",
      source: workflow.replace("      - name: Check source syntax\n        run: npm run check\n", ""),
      expected: "package job source check",
    },
    {
      name: "package job not waiting for the gate",
      source: workflow.replace("    needs: verify\n", ""),
      expected: "job dependencies",
    },
    {
      name: "package without draft",
      source: workflow.replace("            --draft\n", ""),
      expected: "draft-first package gate",
    },
    {
      name: "rebuild during publish",
      source: workflow.replace("          set -euo pipefail\n          tag_commit=", "          set -euo pipefail\n          npm pack --ignore-scripts\n          tag_commit="),
      expected: "single-build handoff",
    },
    {
      name: "publish without provenance verification",
      source: workflow.replace("          gh attestation verify \"release/$ARCHIVE_NAME\" --repo \"$GITHUB_REPOSITORY\"", "          true"),
      expected: "provenance gates",
    },
    {
      name: "mutable Syft installer",
      source: workflow.replace(
        `https://github.com/anchore/syft/releases/download/v${SYFT_PINS.version}/$syft_asset`,
        "https://raw.githubusercontent.com/anchore/syft/main/install.sh",
      ),
      expected: "SBOM gates",
    },
    {
      name: "archive path parsed as a Git shorthand",
      source: workflow.replace('"file:$ARCHIVE_PATH"', '"$ARCHIVE_PATH"'),
      expected: "SBOM local archive spec",
    },
    {
      name: "npm pack report stored inside the sealed bundle",
      source: workflow.replace(
        'pack_report="$RUNNER_TEMP/npm-pack.json"',
        'pack_report="release/npm-pack.json"',
      ),
      expected: "isolated pack report",
    },
    {
      name: "implicit setup-node cache",
      source: workflow.replace("          package-manager-cache: false\n", ""),
      expected: "setup-node cache policy",
    },
    {
      name: "implicit Python interpreter",
      source: workflow.replace('            --python "$PYTHON" \\\n', ""),
      expected: "explicit Python provisioning",
    },
    {
      name: "digest format without enforcement",
      source: workflow.replace("          test \"$actual_artifact_digest\" = \"$expected_artifact_digest\"\n", ""),
      expected: "immutable artifact handoff",
    },
    {
      name: "draft deletion before complete byte proof",
      source: workflow.replace("const result = validateMatchingReleaseBundles({", "const result = validateReleaseMetadata({"),
      expected: "retry recovery",
    },
    {
      name: "published rerun forced through draft creation",
      source: workflow.replace("        if: ${{ steps.remote_state.outputs.already_published != 'true' }}\n", ""),
      expected: "retry recovery",
    },
    {
      name: "unbounded publication client",
      source: workflow.replace("timeout --signal=TERM --kill-after=15s 60s", "gh-timeout-removed"),
      expected: "publish gate",
    },
    {
      name: "release seal without installer v2 plan proof",
      source: workflow.replace('            || verification.value?.smoke?.installer_v2_plan !== "passed"\n', ""),
      expected: "installer v2 seal gate",
    },
  ];
  for (const fixture of fixtures) {
    assert.ok(
      releaseContractErrors(fixture.source).some((error) => error.includes(fixture.expected)),
      `${fixture.name} must be rejected as ${fixture.expected}`,
    );
  }
});


test("the exact inline seal and publish validators accept a valid fixture and reject tampering", () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "release-workflow-fixture-"));
  try {
    const releaseRoot = path.join(temporary, "release");
    mkdirSync(releaseRoot);
    mkdirSync(path.join(temporary, "config"));
    mkdirSync(path.join(temporary, "lib", "release"), { recursive: true });
    mkdirSync(path.join(temporary, "lib", "runtime"), { recursive: true });
    for (const module of [["release", "workflow-guard.mjs"], ["runtime", "host.mjs"]]) {
      copyFileSync(path.join(repoRoot, "lib", ...module), path.join(temporary, "lib", ...module));
    }
    writeFileSync(
      path.join(temporary, "config", "release-artifact-policy.json"),
      readFileSync(path.join(repoRoot, "config", "release-artifact-policy.json")),
    );
    const archiveName = "agentic-sdlc-1.2.3.tgz";
    const archivePath = path.join(releaseRoot, archiveName);
    const cyclonedxPath = `${archivePath}.cdx.json`;
    const sbomPath = `${archivePath}.spdx.json`;
    const verificationPath = path.join(releaseRoot, "release-verification.json");
    const outputPath = path.join(temporary, "github-output.txt");
    const sourceSha = "a".repeat(40);
    writeFileSync(archivePath, Buffer.from("immutable release archive fixture\n"));
    writeFileSync(sbomPath, `${JSON.stringify({
      spdxVersion: "SPDX-2.3",
      dataLicense: "CC0-1.0",
      documentNamespace: "https://example.invalid/spdx/fixture",
      creationInfo: { creators: ["Tool: syft-fixture"] },
      packages: [{ name: "agentic-sdlc" }],
    })}\n`);
    writeFileSync(cyclonedxPath, `${JSON.stringify({
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      components: [{ name: "agentic-sdlc" }],
    })}\n`);
    const validVerification = {
      status: "passed",
      package: { name: "agentic-sdlc", version: "1.2.3", tag: "v1.2.3" },
      artifact: { sha256: sha256(archivePath) },
      smoke: {
        npm_install: "passed",
        cli_help: "passed",
        doctor: "passed",
        installer_plan: "passed",
        installer_zero_write: true,
        installer_v2_plan: "passed",
        installer_v2_zero_write: true,
      },
    };
    writeFileSync(verificationPath, `${JSON.stringify(validVerification)}\n`);

    const commonEnv = {
      ARCHIVE_NAME: archiveName,
      ARCHIVE_PATH: archivePath,
      CYCLONEDX_PATH: cyclonedxPath,
      EXPECTED_ARCHIVE_NAME: archiveName,
      GITHUB_OUTPUT: outputPath,
      GITHUB_REF_NAME: "v1.2.3",
      GITHUB_REPOSITORY: "aantenore/agentic-sdlc",
      GITHUB_RUN_ID: "123456789",
      GITHUB_SHA: sourceSha,
      POLICY_PATH: "config/release-artifact-policy.json",
      SBOM_PATH: sbomPath,
      VERIFICATION_PATH: verificationPath,
    };
    const sealManifest = () => runInlineModule(
      inlineNodeModule("Verify both SBOMs and seal the release manifest"),
      { cwd: temporary, env: commonEnv },
    );
    for (const [field, value] of [
      ["installer_v2_plan", "not_run"],
      ["installer_v2_zero_write", false],
    ]) {
      const weakened = JSON.parse(JSON.stringify(validVerification));
      weakened.smoke[field] = value;
      writeFileSync(verificationPath, `${JSON.stringify(weakened)}\n`);
      const rejectedSeal = sealManifest();
      assert.notEqual(rejectedSeal.status, 0, field);
      assert.match(rejectedSeal.stderr, /did not pass every smoke gate/u, field);
    }
    writeFileSync(verificationPath, `${JSON.stringify(validVerification)}\n`);
    const seal = sealManifest();
    assert.equal(seal.status, 0, seal.stderr);
    writeFileSync(
      `${archivePath}.sha256`,
      `${sha256(archivePath)}  ${archiveName}\n`,
    );

    const validate = () => runInlineModule(
      inlineNodeModule("Validate the artifact identity and sealed bundle"),
      { cwd: temporary, env: commonEnv },
    );
    const valid = validate();
    assert.equal(valid.status, 0, valid.stderr);
    assert.match(readFileSync(outputPath, "utf8"), new RegExp(`archive_name=${archiveName}\\n`, "u"));

    appendFileSync(archivePath, "tampered\n");
    const changedArchive = validate();
    assert.notEqual(changedArchive.status, 0);
    assert.match(changedArchive.stderr, /asset does not match its sealed record/u);
    writeFileSync(archivePath, Buffer.from("immutable release archive fixture\n"));

    const unexpectedPath = path.join(releaseRoot, "npm-pack.json");
    writeFileSync(unexpectedPath, "unexpected\n");
    const unexpectedEntry = validate();
    assert.notEqual(unexpectedEntry.status, 0);
    assert.match(unexpectedEntry.stderr, /unexpected entry/u);
    unlinkSync(unexpectedPath);

    const manifestPath = path.join(releaseRoot, "release-manifest.json");
    const originalCyclonedx = readFileSync(cyclonedxPath);
    writeFileSync(cyclonedxPath, `${JSON.stringify({
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      components: [{ name: "different-package" }],
    })}\n`);
    let manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.cyclonedx.bytes = readFileSync(cyclonedxPath).length;
    manifest.cyclonedx.sha256 = sha256(cyclonedxPath);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const falseCyclonedxIdentity = validate();
    assert.notEqual(falseCyclonedxIdentity.status, 0);
    assert.match(falseCyclonedxIdentity.stderr, /CycloneDX SBOM does not describe/u);
    writeFileSync(cyclonedxPath, originalCyclonedx);
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.cyclonedx.bytes = readFileSync(cyclonedxPath).length;
    manifest.cyclonedx.sha256 = sha256(cyclonedxPath);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const weakenedVerification = JSON.parse(readFileSync(verificationPath, "utf8"));
    weakenedVerification.smoke.installer_zero_write = false;
    writeFileSync(verificationPath, `${JSON.stringify(weakenedVerification)}\n`);
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.verification.bytes = readFileSync(verificationPath).length;
    manifest.verification.sha256 = sha256(verificationPath);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const weakenedGate = validate();
    assert.notEqual(weakenedGate.status, 0);
    assert.match(weakenedGate.stderr, /verification does not prove every required smoke gate/u);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
