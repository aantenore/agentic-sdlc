import "./helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const python = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");

test("token-efficiency autoconfiguration verifies bundled components and never configures CodeBurn", () => {
  const result = spawnSync(
    python,
    [path.join(repoRoot, "scripts", "autoconfigure-token-efficiency.py"), "check", "--json"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      shell: false,
      timeout: 30_000,
    },
  );
  assert.equal(
    result.status,
    0,
    `autoconfiguration check failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
  );
  const payload = JSON.parse(result.stdout);
  assert.match(payload.status, /^(?:ready|ready_with_native_fallback)$/u);
  for (const component of ["caveman_skill", "caveman_agent_card", "codex_session_meter"]) {
    assert.equal(
      payload.components.find((entry) => entry.id === component)?.verified,
      true,
    );
  }
  assert.equal(payload.codeburn.configured, false);
  assert.equal(payload.codeburn.required, false);
  assert.equal(payload.usage_accounting, "measured_net_usage_only");
});

test("token-efficiency autoconfiguration verifies canonical Caveman text on CRLF checkouts", (t) => {
  const copyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-sdlc-autoconfig-crlf-"));
  t.after(() => fs.rmSync(copyRoot, { recursive: true, force: true }));
  const required = [
    "scripts/autoconfigure-token-efficiency.py",
    "scripts/install-personal-marketplace.py",
    "skills/caveman/SKILL.md",
    "skills/caveman/agents/openai.yaml",
    "lib/codex-session-metering-adapter.mjs",
  ];
  for (const relative of required) {
    const destination = path.join(copyRoot, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, relative), destination);
  }
  for (const relative of [
    "skills/caveman/SKILL.md",
    "skills/caveman/agents/openai.yaml",
  ]) {
    const target = path.join(copyRoot, relative);
    const crlf = fs.readFileSync(target, "utf8").replace(/\r?\n/gu, "\r\n");
    fs.writeFileSync(target, crlf, "utf8");
  }

  const result = spawnSync(
    python,
    [path.join(copyRoot, "scripts", "autoconfigure-token-efficiency.py"), "check", "--json"],
    {
      cwd: copyRoot,
      encoding: "utf8",
      shell: false,
      timeout: 30_000,
    },
  );
  assert.equal(
    result.status,
    0,
    `CRLF autoconfiguration check failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
  );
  const payload = JSON.parse(result.stdout);
  for (const component of ["caveman_skill", "caveman_agent_card"]) {
    const current = payload.components.find((entry) => entry.id === component);
    assert.equal(current?.verified, true);
    assert.equal(current?.hash_normalization, "crlf_to_lf");
  }
});
