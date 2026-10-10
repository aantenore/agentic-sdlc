import "../helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { writeJsonFile } from "../../lib/engine/storage.mjs";
import { runWithMutationGovernance } from "../../lib/governance/mutation-guard.mjs";

const WORKER = fileURLToPath(new URL("../helpers/record-create-crash-worker.mjs", import.meta.url));

test("a process killed while creating a record leaves no partial record behind", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "record-create-crash-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const recordPath = path.join(root, "requirements", "REQ-CRASH-001.json");

  const crashed = spawnSync(process.execPath, [WORKER, root, recordPath], { encoding: "utf8" });
  // Windows reports a killed process as a non-zero exit status, not a signal.
  if (process.platform === "win32") assert.notEqual(crashed.status, 0, crashed.stderr);
  else assert.equal(crashed.signal, "SIGKILL", crashed.stderr);
  assert.equal(fs.existsSync(recordPath), false, "the record path must not hold a partial record");

  runWithMutationGovernance({ mode: "disabled", root }, () => {
    writeJsonFile(recordPath, { id: "REQ-CRASH-001" });
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(recordPath, "utf8")), { id: "REQ-CRASH-001" });
});

test("creating an existing record with different content is still refused", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "record-create-crash-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const recordPath = path.join(root, "REQ-EXISTS-001.json");

  runWithMutationGovernance({ mode: "disabled", root }, () => {
    writeJsonFile(recordPath, { id: "REQ-EXISTS-001" });
    writeJsonFile(recordPath, { id: "REQ-EXISTS-001" });
    assert.throws(
      () => writeJsonFile(recordPath, { id: "REQ-EXISTS-001", changed: true }),
      /File already exists: .*Use a new immutable record id\./u,
    );
  });
  assert.deepEqual(fs.readdirSync(root), ["REQ-EXISTS-001.json"]);
});
