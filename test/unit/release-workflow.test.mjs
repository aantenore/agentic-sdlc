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


const FULL_PLATFORMS = ["ubuntu-latest", "macos-latest", "windows-latest"];
const FULL_NODES = ["18.20.3", "20.12.0", "21.6.0", "24"];
const REQUIRED_PULL_REQUEST_CHECKS = [
  "test (ubuntu-latest, 24)",
  "test (macos-latest, 24)",
  "test (windows-latest, 24)",
];
const CONCURRENCY_EXPRESSION = /AGENTIC_SDLC_TEST_CONCURRENCY: \$\{\{ matrix\.os == '([^']+)' && matrix\.node == '([^']+)' && '([^']+)' \|\| matrix\.os == '([^']+)' && '([^']+)' \|\| '([^']+)' \}\}/gu;
const MATRIX_EXPRESSION = /^      matrix: \$\{\{ fromJSON\(github\.event_name == 'pull_request' && '(\{[^']*\})' \|\| '(\{[^']*\})'\) \}\}$/mu;


// Mirrors GitHub's matrix expansion for the subset used here: the cross product
// of the listed axes plus `include` entries that extend it with new combinations.
function expandMatrix(definition) {
  const cells = definition.os.flatMap((osName) => (
    definition.node.map((nodeVersion) => ({ os: osName, node: String(nodeVersion) }))
  ));
  for (const extra of definition.include ?? []) {
    const cell = { os: extra.os, node: String(extra.node) };
    if (!cells.some((known) => known.os === cell.os && known.node === cell.node)) cells.push(cell);
  }
  return cells;
}


function ciMatrices(source) {
  const match = MATRIX_EXPRESSION.exec(source);
  assert.notEqual(match, null, "CI matrix must be selected with fromJSON on github.event_name");
  return {
    pullRequest: expandMatrix(JSON.parse(match[1])),
    full: expandMatrix(JSON.parse(match[2])),
  };
}


function cellNames(cells) {
  return cells.map(({ os: osName, node }) => `test (${osName}, ${node})`).sort();
}


function ciConcurrencyPolicy(source) {
  const policies = [...source.matchAll(CONCURRENCY_EXPRESSION)].map((match) => match.slice(1));
  if (policies.length !== 1) return null;
  const [serializedOs, serializedNode, serializedValue, widerOs, widerValue, defaultValue] = policies[0];
  return {
    serializedOs,
    serializedNode,
    serializedValue,
    widerOs,
    widerValue,
    defaultValue,
    forCell: ({ os: osName, node }) => (
      osName === serializedOs && node === serializedNode
        ? serializedValue
        : osName === widerOs ? widerValue : defaultValue
    ),
  };
}


function ciContractErrors(source) {
  const errors = [];
  const jobs = jobBlocks(source);
  const correctness = jobs.get("test") ?? "";

  if ([...jobs.keys()].join(",") !== "test") errors.push("CI job boundary");
  if (!/timeout-minutes: 35/u.test(correctness)) {
    errors.push("CI job timeout");
  }
  if (/continue-on-error:/u.test(correctness)) errors.push("CI fail-open policy");
  if (!/^on:\n  push:\n    branches: \[main\]\n  pull_request:\n  schedule:\n    - cron: "[0-9*/, -]+ [0-9*/, -]+ \* \* \*"\n  workflow_dispatch:\n/mu.test(source)) {
    errors.push("CI triggers");
  }
  try {
    const { pullRequest, full } = ciMatrices(correctness);
    if (cellNames(pullRequest).join("|") !== [...REQUIRED_PULL_REQUEST_CHECKS, "test (ubuntu-latest, 18.20.3)"].sort().join("|")) {
      errors.push("CI pull request matrix");
    }
    if (cellNames(full).join("|") !== cellNames(FULL_PLATFORMS.flatMap((osName) => (
      FULL_NODES.map((node) => ({ os: osName, node }))
    ))).join("|")) {
      errors.push("CI full matrix");
    }
  } catch {
    errors.push("CI matrix selection");
  }
  if (/^\s+(?:os|node):/mu.test(correctness)) errors.push("CI static matrix axes");
  const concurrency = ciConcurrencyPolicy(correctness);
  if (concurrency === null
    || concurrency.serializedOs !== "macos-latest"
    || concurrency.serializedNode !== "18.20.3"
    || concurrency.serializedValue !== "1"
    || concurrency.widerOs !== "ubuntu-latest"
    || concurrency.widerValue !== "4"
    || concurrency.defaultValue !== "2") {
    errors.push("CI test concurrency policy");
  }
  if ((correctness.match(/^\s+if:/gmu) ?? []).length !== 1
    || (correctness.match(/npm run benchmark:enterprise/gu) ?? []).length !== 1
    || !/- name: Enforce enterprise performance on the required reference runtime\n\s+if: matrix\.os == 'ubuntu-latest' && matrix\.node == 24\n\s+run: npm run benchmark:enterprise/u.test(correctness)) {
    errors.push("CI required reference performance gate");
  }

  const actions = actionReferences(source);
  const checkout = `actions/checkout@${ACTION_PINS.get("actions/checkout")}`;
  const setupNode = `actions/setup-node@${ACTION_PINS.get("actions/setup-node")}`;
  const setupPython = `actions/setup-python@${ACTION_PINS.get("actions/setup-python")}`;
  if (actions.length !== 3
    || actions.filter((action) => action === checkout).length !== 1
    || actions.filter((action) => action === setupNode).length !== 1
    || actions.filter((action) => action === setupPython).length !== 1
    || actions.some((action) => {
      const separator = action.lastIndexOf("@");
      return separator < 1
        || ACTION_PINS.get(action.slice(0, separator)) !== action.slice(separator + 1);
    })) {
    errors.push("CI immutable action pins");
  }
  if ((source.match(/persist-credentials: false/gu) ?? []).length !== 1
    || (source.match(/package-manager-cache: false/gu) ?? []).length !== 1) {
    errors.push("CI checkout and cache policy");
  }
  if ((correctness.match(
    /node --test test\/unit\/test-suite-runner\.test\.mjs/gu,
  ) ?? []).length !== 1) {
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
    /- id: python\n\s+uses: actions\/setup-python@ece7cb06caefa5fff74198d8649806c4678c61a1\n\s+with:\n\s+python-version: "3\.13\.14"\n\s+update-environment: false/u,
  );
  assert.match(
    ciWorkflow,
    /- run: npm test\n\s+env:\n\s+PYTHON: \$\{\{ steps\.python\.outputs\.python-path \}\}/u,
  );
  assert.match(
    ciWorkflow,
    /- name: Verify bounded test-runner bootstrap\n\s+run: node --test test\/unit\/test-suite-runner\.test\.mjs/u,
  );
});


test("CI runs the reduced matrix on pull requests and the full matrix on push, schedule, and dispatch", () => {
  const { pullRequest, full } = ciMatrices(ciWorkflow);
  assert.deepEqual(
    cellNames(pullRequest),
    [...REQUIRED_PULL_REQUEST_CHECKS, "test (ubuntu-latest, 18.20.3)"].sort(),
  );
  assert.equal(full.length, 12);
  assert.deepEqual(
    cellNames(full),
    cellNames(FULL_PLATFORMS.flatMap((osName) => FULL_NODES.map((node) => ({ os: osName, node })))),
  );
  // Only pull requests take the reduced branch; every other trigger gets the full matrix.
  assert.match(ciWorkflow, /fromJSON\(github\.event_name == 'pull_request' && '/u);
  assert.match(
    ciWorkflow,
    /^on:\n  push:\n    branches: \[main\]\n  pull_request:\n  schedule:\n    - cron: "[^"\n]+"\n  workflow_dispatch:\n/mu,
  );
  // The required status checks keep the default "test (<os>, <node>)" job name.
  assert.doesNotMatch(jobBlocks(ciWorkflow).get("test"), /^    name:/mu);
});


test("the release gate requires exactly the cells that the full CI matrix produces", () => {
  const { full } = ciMatrices(ciWorkflow);
  assert.deepEqual([...requiredCiJobNames()].sort(), cellNames(full));
  assert.equal(requiredCiJobNames().length, 12);
  assert.deepEqual(CI_GATE_POLICY.platforms, FULL_PLATFORMS);
  assert.deepEqual(CI_GATE_POLICY.nodeVersions, FULL_NODES);
  assert.equal(CI_GATE_POLICY.workflowFile, "ci.yml");
  assert.equal(CI_GATE_POLICY.event, "push");
  assert.equal(CI_GATE_POLICY.branch, "main");
  for (const name of REQUIRED_PULL_REQUEST_CHECKS) {
    assert.ok(requiredCiJobNames().includes(name), `${name} must also be required by the release gate`);
  }
  const pushTrigger = /^on:\n  push:\n    branches: \[main\]\n/mu;
  assert.match(ciWorkflow, pushTrigger);
});


test("CI serializes only macOS Node 18.20.3, gives Linux four workers, and keeps two elsewhere", () => {
  const policy = ciConcurrencyPolicy(ciWorkflow);
  assert.notEqual(policy, null);
  assert.deepEqual(
    [
      policy.serializedOs,
      policy.serializedNode,
      policy.serializedValue,
      policy.widerOs,
      policy.widerValue,
      policy.defaultValue,
    ],
    ["macos-latest", "18.20.3", "1", "ubuntu-latest", "4", "2"],
  );
  const { full, pullRequest } = ciMatrices(ciWorkflow);
  const perCell = (cells) => cells.map((cell) => [`${cell.os}/${cell.node}`, policy.forCell(cell)]);
  assert.deepEqual(
    perCell(full).filter(([, value]) => value === "1"),
    [["macos-latest/18.20.3", "1"]],
  );
  assert.deepEqual(
    perCell(full).filter(([, value]) => value === "4").map(([name]) => name).sort(),
    FULL_NODES.map((node) => `ubuntu-latest/${node}`).sort(),
  );
  assert.equal(perCell(full).filter(([, value]) => value === "2").length, 7);
  assert.deepEqual(
    perCell(pullRequest),
    [
      ["ubuntu-latest/24", "4"],
      ["macos-latest/24", "2"],
      ["windows-latest/24", "2"],
      ["ubuntu-latest/18.20.3", "4"],
    ],
  );
  // The release no longer runs tests, so it must not carry its own concurrency policy.
  assert.equal(/AGENTIC_SDLC_TEST_CONCURRENCY/u.test(workflow), false);
});


test("CI guards reject a weakened matrix, trigger, or concurrency policy", () => {
  const reduced = '{"os":["ubuntu-latest","macos-latest","windows-latest"],"node":[24],"include":[{"os":"ubuntu-latest","node":"18.20.3"}]}';
  const fixtures = [
    {
      name: "pull request matrix without the Node 18 cell",
      source: ciWorkflow.replace(',"include":[{"os":"ubuntu-latest","node":"18.20.3"}]', ""),
      expected: "CI pull request matrix",
    },
    {
      name: "pull request matrix missing a required platform",
      source: ciWorkflow.replace(reduced, reduced.replace('"windows-latest"', '"windows-2022"')),
      expected: "CI pull request matrix",
    },
    {
      name: "full matrix dropping a Node line",
      source: ciWorkflow.replace('"node":["18.20.3","20.12.0","21.6.0",24]', '"node":["18.20.3","20.12.0",24]'),
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
      source: ciWorkflow.replace("&& '4' ||", "&& '2' ||"),
      expected: "CI test concurrency policy",
    },
    {
      name: "macOS Node 18 no longer serialized",
      source: ciWorkflow.replace("&& '1' ||", "&& '2' ||"),
      expected: "CI test concurrency policy",
    },
  ];
  for (const fixture of fixtures) {
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
    /if: matrix\.os == 'ubuntu-latest' && matrix\.node == 24\n\s+run: npm run benchmark:enterprise/u,
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
  assert.ok(ciContractErrors(source).includes("CI required reference performance gate"));
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
