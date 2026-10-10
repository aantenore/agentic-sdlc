import "./helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BUILD_PROVENANCE_RELATIVE_PATH,
  computeBuildFingerprint,
  discoverDistributedFiles,
} from "../lib/build-identity.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_PROBE_OUTPUT_BYTES = 1024 * 1024;

const pythonProbe = String.raw`
import importlib.util
import json
import sys
from pathlib import Path

root = Path(sys.argv[1]).resolve()

def load_module(name, relative_path):
    module_path = root / relative_path
    specification = importlib.util.spec_from_file_location(name, module_path)
    if specification is None or specification.loader is None:
        raise RuntimeError(f"Could not load {module_path}")
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module

v1 = load_module(
    "distribution_contract_installer_v1",
    "scripts/install-personal-marketplace.py",
)
v2 = load_module(
    "distribution_contract_installer_v2",
    "scripts/install-personal-marketplace-v2.py",
)
allowlist = v1._read_package_allowlist(root)
destination = root.parent / ".agentic-sdlc-distribution-contract-destination"
entries = v1._collect_allowlisted_source_files(root, destination, allowlist)
augmented, _provenance_payload, identity = v2._source_entries_with_provenance(
    root,
    entries,
)
print(json.dumps({
    "paths": [str(entry["path"]) for entry in entries],
    "augmented_paths": [str(entry["path"]) for entry in augmented],
    "fingerprint": v2._distribution_fingerprint(root, entries),
    "identity_fingerprint": identity["build_fingerprint"],
    "provenance_path": identity["provenance_file"],
}, separators=(",", ":"), sort_keys=True))
`;

test("npm pack, build identity, and the reversible installer share one distribution surface", {
  timeout: 60_000,
}, (context) => {
  const transientFixtureRoot = path.join(
    repoRoot,
    "scripts",
    `.distribution-contract-${process.pid}`,
  );
  const transientDirectory = path.join(transientFixtureRoot, "__pycache__");
  const transientArtifacts = [
    path.join(transientDirectory, "fixture.pyc"),
    path.join(transientDirectory, "fixture.pyo"),
  ];
  fs.mkdirSync(transientDirectory, { recursive: true });
  for (const artifactPath of transientArtifacts) {
    fs.writeFileSync(artifactPath, "transient Python bytecode fixture\n");
  }
  context.after(() => {
    fs.rmSync(transientFixtureRoot, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50,
    });
  });

  const javascriptPaths = discoverDistributedFiles(repoRoot)
    .map((entry) => entry.relative_path);
  const javascriptFingerprint = computeBuildFingerprint(repoRoot);

  const pythonExecutable = process.env.PYTHON
    || (process.platform === "win32" ? "python" : "python3");
  const python = spawnSync(
    pythonExecutable,
    ["-c", pythonProbe, repoRoot],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      maxBuffer: MAX_PROBE_OUTPUT_BYTES,
      shell: false,
    },
  );
  assert.equal(
    python.status,
    0,
    `Python distribution probe failed\nSTDOUT:\n${python.stdout}\nSTDERR:\n${python.stderr}`,
  );
  assert.equal(python.signal, null);
  const pythonResult = JSON.parse(python.stdout);

  const npmCommand = process.env.npm_execpath
    ? process.execPath
    : process.platform === "win32" ? "npm.cmd" : "npm";
  const npmArguments = process.env.npm_execpath
    ? [process.env.npm_execpath, "pack", "--dry-run", "--ignore-scripts", "--json"]
    : ["pack", "--dry-run", "--ignore-scripts", "--json"];
  const packed = spawnSync(npmCommand, npmArguments, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: MAX_PROBE_OUTPUT_BYTES,
    shell: false,
  });
  assert.equal(
    packed.status,
    0,
    `npm pack distribution probe failed\nSTDOUT:\n${packed.stdout}\nSTDERR:\n${packed.stderr}`,
  );
  assert.equal(packed.signal, null);
  const packResult = JSON.parse(packed.stdout);
  assert.equal(packResult.length, 1);
  const npmPaths = packResult[0].files
    .map((entry) => entry.path)
    .sort();
  assert.equal(
    npmPaths.some((filePath) =>
      filePath.includes("__pycache__")
      || filePath.endsWith(".pyc")
      || filePath.endsWith(".pyo")),
    false,
  );

  assert.deepEqual(pythonResult.paths, javascriptPaths);
  assert.deepEqual(npmPaths, javascriptPaths);
  assert.equal(pythonResult.fingerprint, javascriptFingerprint);
  assert.equal(pythonResult.identity_fingerprint, javascriptFingerprint);
  assert.equal(
    pythonResult.provenance_path,
    BUILD_PROVENANCE_RELATIVE_PATH,
  );
  assert.deepEqual(
    pythonResult.augmented_paths,
    [...javascriptPaths, BUILD_PROVENANCE_RELATIVE_PATH].sort(),
  );
});
