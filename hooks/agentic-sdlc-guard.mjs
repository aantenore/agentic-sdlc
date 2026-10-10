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
// Below the 30-second hook timeout, so a slow remote still yields the local summary.
const STATUS_TIMEOUT_MS = 25_000;

function readPayload() {
  try {
    return JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  } catch {
    return {};
  }
}

/** The nearest folder up the tree that holds a `.sdlc` folder (a project that uses agentic-sdlc), or null. */
function governedRoot(start) {
  let current = path.resolve(String(start || process.cwd()));
  for (;;) {
    try {
      if (fs.statSync(path.join(current, ".sdlc")).isDirectory()) return current;
    } catch {
      // keep walking up
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function insideGovernedProject(start) {
  return governedRoot(start) !== null;
}

/**
 * Puts unanswered coordination questions and a digest of new messages in
 * front of the agent (after a tool call or on a prompt). Never blocks.
 */
async function coordinationMessages(payload, hookEventName) {
  const root = governedRoot(payload.cwd);
  if (!root) return;
  // Loaded here so a problem with it never disables the edit guard.
  const { checkAttention } = await import("../lib/messaging/attention.mjs");
  const context = await checkAttention(root);
  try {
    const { checkPresence } = await import("../lib/messaging/presence.mjs");
    await checkPresence(root);
  } catch {
    // best effort
  }
  if (context) process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: context } })}\n`);
}

function preToolUse(payload) {
  // Every rule protects agentic-sdlc records, so other projects are never touched.
  if (!insideGovernedProject(payload.cwd)) return;
  const verdict = evaluatePreToolUse(payload);
  if (verdict?.decision === "deny") {
    process.stderr.write(`${verdict.reason}\n`);
    process.exitCode = 2;
  }
}

/** Tells the session to ask for a plugin update when the project's records need a newer version. */
async function pluginUpdateNotice(root) {
  // Loaded here so a problem with it never disables the edit guard.
  const { COMPATIBILITY_DIRECTORY, evaluateRequirements, pluginUpdateLine } = await import("../lib/plugin-compatibility.mjs");
  const directory = path.join(root, ".sdlc", COMPATIBILITY_DIRECTORY);
  let names = [];
  try {
    names = fs.readdirSync(directory).filter((name) => name.endsWith(".json"));
  } catch {
    return;
  }
  const entries = names.map((name) => {
    try {
      return { path: name, record: JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")) };
    } catch {
      return { path: name, record: null };
    }
  });
  const verdict = evaluateRequirements(entries);
  if (verdict.satisfied) return;
  process.stdout.write(`Agentic SDLC: ${pluginUpdateLine(verdict.required_plugin_version)}\n`
    + "Tell the user before any other agentic-sdlc work: commands that change the project are refused until the plugin is updated.\n");
}

async function sessionStart(payload) {
  const root = path.resolve(String(payload.cwd || process.cwd()));
  try {
    await pluginUpdateNotice(root);
  } catch {
    // The notice is advice; the CLI enforces the check on its own.
  }
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

/** Stops this repository's plugin commands that outlived their time limit. Silent, never blocks. */
async function reapRuns(payload) {
  const { findGitCommonDir, reapStaleRuns, reapUnregisteredProcesses } = await import("../lib/runtime/run-registry.mjs");
  const commonDir = findGitCommonDir(payload.cwd || process.cwd());
  if (commonDir) reapStaleRuns(commonDir);
  reapUnregisteredProcesses(commonDir);
}

try {
  const event = process.argv[2];
  const payload = readPayload();
  if (event === "pre-tool-use") preToolUse(payload);
  else if (event === "session-start") await sessionStart(payload);
  else if (event === "post-tool-use") await coordinationMessages(payload, "PostToolUse");
  else if (event === "stop" || event === "session-end") await reapRuns(payload);
  else if (event === "user-prompt-submit") await coordinationMessages(payload, "UserPromptSubmit");
} catch {
  process.exitCode = 0;
}
