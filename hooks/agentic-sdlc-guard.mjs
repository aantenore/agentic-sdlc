#!/usr/bin/env node
// Host hook entry point shared by both supported agent hosts. It reads the
// hook payload from stdin and blocks a tool call only by exiting with status
// 2 and a reason on stderr, the one blocking signal both hosts honour. Any
// internal failure exits 0 so the host's normal permission flow applies; the
// CLI enforces every rule on its own.
// First import: with AGENTIC_SDLC_AUTO_UPDATE=1 a newer installed version takes over this call.
import "../lib/runtime/self-forward.mjs";

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  evaluatePreToolUse,
  mainThreadMode,
  orchestratorEditWarning,
  orchestratorSessionContext,
  PROCESS_HYGIENE_INSTRUCTION,
  STORY_LABEL_INSTRUCTION,
  sessionStartContext,
  strictMainThreadVerdict,
} from "../lib/host-hooks/guard.mjs";
import { isUngovernedRepo, mergeAuthorized, storyPushAuthorized } from "../lib/host-hooks/merge-authorization.mjs";

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

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** The project's main-thread mode from `.sdlc/config.json` ("free" when unset). */
function projectMainThreadMode(root) {
  return mainThreadMode(readJson(path.join(root, ".sdlc", "config.json")), process.env);
}

/** The governed project root plus every git worktree of it: the paths strict mode keeps closed to the main thread. */
function governedTreeRoots(root) {
  const roots = [root];
  const listed = spawnSync("git", ["-C", root, "worktree", "list", "--porcelain"], { encoding: "utf8", timeout: 5000, windowsHide: true });
  if (listed.status === 0) {
    for (const line of listed.stdout.split("\n")) if (line.startsWith("worktree ")) roots.push(line.slice("worktree ".length).trim());
  }
  return roots;
}

function insideGovernedProject(start) {
  return governedRoot(start) !== null;
}

/**
 * Puts unanswered coordination questions and a digest of new messages in
 * front of the agent (after a tool call or on a prompt). Never blocks.
 */
async function coordinationMessages(payload, hookEventName, extraContext = async () => "") {
  const root = governedRoot(payload.cwd);
  if (!root) return;
  // Loaded here so a problem with it never disables the edit guard.
  const { checkAttention } = await import("../lib/messaging/attention.mjs");
  const context = [await checkAttention(root), await extraContext(root)].filter(Boolean).join("\n");
  try {
    const { checkPresence } = await import("../lib/messaging/presence.mjs");
    await checkPresence(root);
  } catch {
    // best effort
  }
  if (context) process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: context } })}\n`);
}

/** The process warning left at Stop and not yet shown, once, with the next prompt. */
async function pendingProcessWarning(root) {
  try {
    const { takePendingReapWarning } = await import("../lib/host-hooks/process-hygiene.mjs");
    const { findGitCommonDir } = await import("../lib/runtime/run-registry.mjs");
    return takePendingReapWarning(root, { commonDir: findGitCommonDir(root) });
  } catch {
    return "";
  }
}

function preToolUse(payload) {
  // Every rule protects agentic-sdlc records, so other projects are never touched.
  if (!insideGovernedProject(payload.cwd)) return;
  const root = governedRoot(payload.cwd);
  const verdict = evaluatePreToolUse(payload, {
    env: process.env,
    isUngovernedRepo: (attempt) => isUngovernedRepo(payload.cwd, attempt.dirs, process.env),
    isMergeAuthorized: (attempt) => mergeAuthorized(root, payload.cwd, attempt),
    isStoryPushAuthorized: (attempt) => storyPushAuthorized(root, payload.cwd, attempt),
  });
  if (verdict?.decision === "deny") {
    process.stderr.write(`${verdict.reason}\n`);
    process.exitCode = 2;
    return;
  }
  const mode = projectMainThreadMode(root);
  const strict = strictMainThreadVerdict(payload, mode, process.env, { roots: governedTreeRoots(root) });
  if (strict) {
    process.stderr.write(`${strict.reason}\n`);
    process.exitCode = 2;
    return;
  }
  const warning = orchestratorEditWarning(payload, mode);
  if (warning) process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: warning } })}\n`);
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

/** Opt-in plugin update (AGENTIC_SDLC_AUTO_UPDATE=1): detached and throttled; never blocks or fails the hook. */
async function autoUpdate(reason) {
  try {
    const { maybeAutoUpdate } = await import("../lib/runtime/auto-update.mjs");
    maybeAutoUpdate({ reason, pluginRoot: PLUGIN_ROOT });
  } catch {
    // an update problem never disables the guard
  }
}

async function sessionStart(payload) {
  await autoUpdate("session-start");
  const root = path.resolve(String(payload.cwd || process.cwd()));
  try {
    await pluginUpdateNotice(root);
  } catch {
    // The notice is advice; the CLI enforces the check on its own.
  }
  const orchestrator = orchestratorSessionContext(projectMainThreadMode(governedRoot(root) ?? root));
  if (orchestrator) process.stdout.write(`${orchestrator}\n`);
  else if (governedRoot(root)) process.stdout.write(`${STORY_LABEL_INSTRUCTION}\n`);
  if (orchestrator || governedRoot(root)) process.stdout.write(`${PROCESS_HYGIENE_INSTRUCTION}\n`);
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

/** Keeps the agent working while this computer has work in the project (see lib/host-hooks/keep-going.mjs). */
async function keepGoing(payload) {
  const root = governedRoot(payload.cwd);
  if (!root) return;
  const { keepGoingStop } = await import("../lib/host-hooks/keep-going.mjs");
  const { findGitCommonDir } = await import("../lib/runtime/run-registry.mjs");
  const commonDir = findGitCommonDir(root);
  const output = await keepGoingStop(root, payload, { commonDir });
  const { processHygieneAtStop } = await import("../lib/host-hooks/process-hygiene.mjs");
  const { message } = await processHygieneAtStop(root, { commonDir, pluginRoot: PLUGIN_ROOT });
  const merged = message ? { ...output, systemMessage: [output?.systemMessage, message].filter(Boolean).join("\n") } : output;
  if (merged) process.stdout.write(`${JSON.stringify(merged)}\n`);
}

try {
  const event = process.argv[2];
  const payload = readPayload();
  if (event === "pre-tool-use") preToolUse(payload);
  else if (event === "session-start") await sessionStart(payload);
  else if (event === "post-tool-use") await coordinationMessages(payload, "PostToolUse");
  else if (event === "stop") {
    await autoUpdate("stop");
    try {
      await reapRuns(payload);
    } finally {
      await keepGoing(payload);
    }
  } else if (event === "session-end") await reapRuns(payload);
  else if (event === "user-prompt-submit") await coordinationMessages(payload, "UserPromptSubmit", pendingProcessWarning);
} catch {
  process.exitCode = 0;
}
