import "./helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";


const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_INSTALLER_TRANSACTION_TIMEOUT_MS = 60_000;
const WINDOWS_INSTALLER_TRANSACTION_TIMEOUT_MS = 90_000;


function installerTransactionTimeoutMs(platform = process.platform) {
  return platform === "win32"
    ? WINDOWS_INSTALLER_TRANSACTION_TIMEOUT_MS
    : DEFAULT_INSTALLER_TRANSACTION_TIMEOUT_MS;
}


function installerSubprocessFailure(result, { command, timeoutMs }) {
  const output = `command: ${command}\nstdout:\n${result.stdout ?? ""}\nstderr:\n${result.stderr ?? ""}`;

  if (result.error?.code === "ETIMEDOUT") {
    return `Installer transaction test subprocess timed out after ${timeoutMs} ms.\n${output}`;
  }

  if (result.error) {
    const code = result.error.code ? ` ${result.error.code}` : "";
    return `Installer transaction test subprocess encountered an execution error${code}: ${result.error.message}\n${output}`;
  }

  const signal = result.signal ? ` (signal ${result.signal})` : "";
  return `Installer transaction tests exited with status ${result.status}${signal}.\n${output}`;
}


test("installer subprocess timeout policy and diagnostics are platform-specific", () => {
  assert.equal(installerTransactionTimeoutMs("win32"), 90_000);
  assert.equal(installerTransactionTimeoutMs("linux"), 60_000);
  assert.equal(installerTransactionTimeoutMs("darwin"), 60_000);

  const timeoutError = Object.assign(new Error("test timeout"), { code: "ETIMEDOUT" });
  const timeoutMessage = installerSubprocessFailure(
    {
      error: timeoutError,
      signal: "SIGTERM",
      status: null,
      stdout: "partial output",
      stderr: "",
    },
    { command: "python installer.py", timeoutMs: 90_000 },
  );
  assert.match(timeoutMessage, /timed out after 90000 ms/);
  assert.match(timeoutMessage, /partial output/);

  const executionError = Object.assign(new Error("interpreter not found"), { code: "ENOENT" });
  const executionErrorMessage = installerSubprocessFailure(
    { error: executionError, signal: null, status: null, stdout: "", stderr: "" },
    { command: "python installer.py", timeoutMs: 60_000 },
  );
  assert.match(executionErrorMessage, /execution error ENOENT: interpreter not found/);

  const statusMessage = installerSubprocessFailure(
    { error: undefined, signal: null, status: 7, stdout: "", stderr: "failure" },
    { command: "python installer.py", timeoutMs: 60_000 },
  );
  assert.match(statusMessage, /exited with status 7/);
  assert.match(statusMessage, /stderr:\nfailure/);
});


test("transactional personal marketplace installer contract", () => {
  const python = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
  const script = path.join(repoRoot, "test", "installer-transaction.test.py");
  const timeoutMs = installerTransactionTimeoutMs();
  const result = spawnSync(
    python,
    [script],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: process.env,
      timeout: timeoutMs,
    },
  );

  assert.equal(
    result.status,
    0,
    installerSubprocessFailure(result, {
      command: `${python} ${script}`,
      timeoutMs,
    }),
  );
});
