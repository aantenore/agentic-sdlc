#!/usr/bin/env node
// Host hook entry point shared by both supported agent hosts. It reads the
// hook payload from stdin and blocks a tool call only by exiting with status
// 2 and a reason on stderr, the one blocking signal both hosts honour. Any
// internal failure exits 0 so the host's normal permission flow applies; the
// CLI enforces every rule on its own.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { evaluatePreToolUse, sessionStartContext } from "../lib/host-hooks/guard.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(PLUGIN_ROOT, "bin", "agentic-sdlc.mjs");
const STATUS_TIMEOUT_MS = 20_000;

function readPayload() {
  try {
    return JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  } catch {
    return {};
  }
}

function preToolUse(payload) {
  const verdict = evaluatePreToolUse(payload);
  if (verdict?.decision === "deny") {
    process.stderr.write(`${verdict.reason}\n`);
    process.exitCode = 2;
  }
}

function sessionStart(payload) {
  const root = path.resolve(String(payload.cwd || process.cwd()));
  const standingRoot = path.join(root, ".sdlc", "autonomy", "standing");
  let entries = [];
  try {
    entries = fs.readdirSync(standingRoot).filter((name) => !name.startsWith("."));
  } catch {
    return;
  }
  if (entries.length === 0) return;
  const result = spawnSync(process.execPath, [CLI, "autonomy", "standing", "status", "--root", root, "--json"], {
    encoding: "utf8",
    timeout: STATUS_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.status !== 0) return;
  let status = null;
  try {
    status = JSON.parse(result.stdout);
  } catch {
    return;
  }
  const context = sessionStartContext(status);
  if (context) process.stdout.write(`${context}\n`);
}

try {
  const event = process.argv[2];
  const payload = readPayload();
  if (event === "pre-tool-use") preToolUse(payload);
  else if (event === "session-start") sessionStart(payload);
} catch {
  process.exitCode = 0;
}
