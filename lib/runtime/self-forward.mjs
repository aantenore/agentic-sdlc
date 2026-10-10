/**
 * Imported first by the hook entry and the CLI. With AGENTIC_SDLC_AUTO_UPDATE=1 and a newer plugin
 * version in a sibling cache folder, it runs the same entry file of that version with the same
 * arguments, stdin and environment, and exits with its status. A guard variable stops forwarding loops.
 * Any problem leaves the current version running.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AUTO_UPDATE_ENV, autoUpdateEnabled, newerSibling } from "./auto-update.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Returns the exit status when the entry was delegated, else null. */
export function forwardToNewerVersion({ entry = process.argv[1], argv = process.argv.slice(2), env = process.env, root = PLUGIN_ROOT, run = spawnSync } = {}) {
  try {
    if (!autoUpdateEnabled(env) || env[AUTO_UPDATE_ENV.forwarded]) return null;
    const relative = path.relative(root, path.resolve(entry));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
    const target = newerSibling(root, relative);
    if (!target) return null;
    const result = run(process.execPath, [path.join(target.root, relative), ...argv], {
      stdio: "inherit",
      env: { ...env, [AUTO_UPDATE_ENV.forwarded]: "1" },
      windowsHide: true,
    });
    if (result.error) return null;
    return result.status ?? 1;
  } catch {
    return null;
  }
}

const status = forwardToNewerVersion();
if (status !== null) process.exit(status);
