import path from "node:path";

import { childProcess, console, Date, fs, process } from "../runtime/host.mjs";
import { parseDurationSeconds } from "../engine/story-reservation.mjs";

/**
 * Local "delegated work in progress" markers: the agent that hands a story's
 * step to a background helper says so, and the end-of-turn keep-going check
 * stops asking for that step until the marker expires or is cleared.
 * Stored only in this clone (<git-common-dir>/agentic-sdlc/working.json),
 * never shared and never written in the project.
 */
export const WORKING_FILE = "working.json";
export const WORKING_MAX_SECONDS = 24 * 3600;

function readMarkers(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function gitCommonDir(root) {
  try {
    const result = childProcess.spawnSync("git", ["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", timeout: 5000, windowsHide: true });
    return result.status === 0 ? String(result.stdout).trim() || null : null;
  } catch {
    return null;
  }
}

/** Valid (not expired) markers: { storyId: { until, reason } }. */
export function activeWorking(root, now = Date.now()) {
  const dir = gitCommonDir(root);
  if (!dir) return {};
  const markers = readMarkers(path.join(dir, "agentic-sdlc", WORKING_FILE));
  return Object.fromEntries(Object.entries(markers).filter(([, marker]) => Date.parse(marker?.until ?? "") > now));
}

/** `story working`: set (--until) or clear (--clear) the marker of a story. */
export function storyWorking(options, { now = Date.now() } = {}) {
  const root = path.resolve(String(options.root || process.cwd()));
  const id = String(options.id || "").trim();
  if (!id) throw new Error("Missing --id <story-id>.");
  const dir = gitCommonDir(root);
  if (!dir) throw new Error("Not inside a git repository: the marker lives in the git common dir.");
  const file = path.join(dir, "agentic-sdlc", WORKING_FILE);
  const markers = readMarkers(file);
  if (options.clear === true) delete markers[id];
  else {
    const seconds = parseDurationSeconds(options.until);
    if (!seconds) throw new Error("Use --until <duration> such as 30m, 2h (max 24h), or --clear.");
    const until = new Date(now + Math.min(seconds, WORKING_MAX_SECONDS) * 1000).toISOString();
    markers[id] = { until, ...(options.reason ? { reason: String(options.reason) } : {}) };
  }
  for (const [key, marker] of Object.entries(markers)) if (!(Date.parse(marker?.until ?? "") > now)) delete markers[key];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(markers, null, 2)}\n`, { mode: 0o600 });
  const result = { story_id: id, working: options.clear === true ? null : markers[id] };
  console.log(options.clear === true ? `Marcatore di lavoro delegato rimosso per ${id}.` : `Lavoro delegato su ${id} fino a ${markers[id].until}: keep-going non blocca per il suo passo.`);
  return result;
}
