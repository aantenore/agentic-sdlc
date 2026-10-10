/**
 * Stop-hook side of `agentic-sdlc processes reap`.
 *
 * With the opt-in (AGENTIC_SDLC_REAP_ON_STOP=1 or host_policy.process_reaper.
 * reap_on_stop) the processes over the limit are stopped when a turn ends.
 * Without it the reaper only looks (dry run) and, when something is over the
 * limit, leaves one short warning: shown at once and added to the context of
 * the next prompt. Warnings are throttled to one every few minutes.
 * Best effort: nothing here ever fails the hook.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  readProjectConfig,
  reapOnStopEnabled,
  reapProcesses,
  reapWarning,
  resolveReaperPolicy,
} from "../runtime/process-reaper.mjs";

export const WARNING_STATE_FILE = "reap-warning.json";

function statePath(root, commonDir) {
  if (commonDir) return path.join(commonDir, "agentic-sdlc", WARNING_STATE_FILE);
  return path.join(os.tmpdir(), `agentic-sdlc-reap-${crypto.createHash("sha1").update(path.resolve(root)).digest("hex").slice(0, 12)}.json`);
}

function readState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) ?? {};
  } catch {
    return {};
  }
}

function writeState(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  } catch {
    // the warning still shows once; only the throttle is lost
  }
}

/**
 * Runs at Stop. Returns `{ message }` (one line for the user, "" when none).
 * `reap` is replaceable for tests.
 */
export async function processHygieneAtStop(startDir, { env = process.env, commonDir = null, now = Date.now(), pluginRoot = null, reap = reapProcesses, rows } = {}) {
  try {
    const { root, config } = readProjectConfig(startDir);
    const policy = resolveReaperPolicy(config, env);
    const common = { root, config, env, pluginRoot, ...(rows === undefined ? {} : { rows }) };
    if (reapOnStopEnabled(policy, env)) {
      const result = await reap({ ...common, dryRun: false });
      const stopped = result.processes.filter((item) => item.outcome !== "failed");
      return { message: stopped.length === 0 ? "" : `Fermati ${stopped.length} processi oltre ${result.older_than_minutes} min: ${stopped.map((item) => item.pid).join(", ")}.` };
    }
    const file = statePath(root, commonDir);
    const previous = readState(file);
    if (Number.isFinite(previous.at) && now - previous.at < policy.warning_throttle_seconds * 1000) return { message: "" };
    const warning = reapWarning(await reap({ ...common, dryRun: true }));
    if (!warning) return { message: "" };
    writeState(file, { at: now, text: warning, delivered: false });
    return { message: warning };
  } catch {
    return { message: "" };
  }
}

/** The warning left at Stop and not yet shown to the agent, once; "" when none. */
export function takePendingReapWarning(startDir, { commonDir = null } = {}) {
  try {
    const { root } = readProjectConfig(startDir);
    const file = statePath(root, commonDir);
    const state = readState(file);
    if (typeof state.text !== "string" || state.text === "" || state.delivered === true) return "";
    writeState(file, { ...state, delivered: true });
    return state.text;
  } catch {
    return "";
  }
}
