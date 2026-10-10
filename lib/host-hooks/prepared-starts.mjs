import path from "node:path";
import { fileURLToPath } from "node:url";

import { childProcess, fs, process } from "../runtime/host.mjs";

// Hooks (watch, keep-going) start the stories prepared with `story prepare`
// once their dependency merged. The work itself is `story prepare --resolve`;
// this module only decides whether to run it and reads its answer.

export const PREPARED_STARTS_ENV = "AGENTIC_SDLC_PREPARED_STARTS";
const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../bin/agentic-sdlc.mjs");
const OFF_VALUES = new Set(["0", "false", "no", "off", "disabled"]);
const RESOLVE_TIMEOUT_MS = 5 * 60 * 1000;

/** True when some preparation under <root>/.sdlc/prepared-starts still waits for its dependency. */
export function hasWaitingPreparedStarts(root) {
  const directory = path.join(root, ".sdlc", "prepared-starts");
  try {
    return fs.readdirSync(directory).some((name) => {
      if (!name.endsWith(".json")) return false;
      try {
        return JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"))?.state === "waiting";
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/**
 * Runs `story prepare --resolve` when something waits (never when switched
 * off) and returns the preparations that changed: [{ story_id, outcome }].
 * Never throws; `run` is injectable for tests.
 */
export function resolvePreparedStartsFor(root, { env = process.env, run = null } = {}) {
  if (OFF_VALUES.has(String(env[PREPARED_STARTS_ENV] ?? "").trim().toLowerCase())) return [];
  if (!hasWaitingPreparedStarts(root)) return [];
  try {
    const result = run
      ? run(root)
      : childProcess.spawnSync(process.execPath, [BIN, "story", "prepare", "--resolve", "--json", "--root", root], { encoding: "utf8", timeout: RESOLVE_TIMEOUT_MS, env });
    const parsed = typeof result === "string" ? JSON.parse(result) : JSON.parse(result.stdout);
    return (Array.isArray(parsed.results) ? parsed.results : []).filter((item) => item.outcome && !["waiting", "unknown"].includes(item.outcome));
  } catch {
    return [];
  }
}

export function describePreparedStart(item) {
  if (item.outcome === "started") return `${item.story_id}: dipendenza integrata, story avviata (worktree riallineato, task start e claim fatti)`;
  if (item.outcome === "dependency_closed") return `${item.story_id}: dipendenza chiusa senza merge, la story non parte`;
  return `${item.story_id}: avvio automatico bloccato${item.reason ? ` (${item.reason})` : ""}`;
}
