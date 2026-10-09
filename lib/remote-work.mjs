import { Date } from "./runtime/host.mjs";

// Work on the remote that names a story nobody claimed. A claim is shared
// from its task start on, so work begun earlier (an agent in a worktree, a
// branch pushed before the story was started) is invisible to the other
// computers: status shows the story ready and free. status and story
// availability look for such work in git (a branch that names the story,
// with commits not yet on the base branch) and, when the project opts in,
// in open pull requests read through a provider adapter. They only warn: the
// decision stays with the person.

export const REMOTE_WORK_MODES = Object.freeze(["git", "off"]);
export const REMOTE_WORK_PULL_REQUEST_SOURCES = Object.freeze(["off", "github-cli"]);

const RECENT_MIN_SECONDS = 60;
const RECENT_MAX_SECONDS = 31_536_000;

const DEFAULT_POLICY = Object.freeze({
  mode: "git",
  pull_requests: "off",
  recent_within_seconds: null,
});

/**
 * The validated policy, with defaults for every key a project leaves out.
 * `recent_within_seconds` null counts a branch whatever the age of its last
 * commit. invalid(message) reports a wrong value.
 */
export function remoteWorkPolicy(configured, invalid) {
  if (configured === undefined || configured === null) return DEFAULT_POLICY;
  if (typeof configured !== "object" || Array.isArray(configured)) {
    invalid("orchestration_policy.unclaimed_remote_work must be an object.");
  }
  const mode = configured.mode ?? DEFAULT_POLICY.mode;
  if (!REMOTE_WORK_MODES.includes(mode)) {
    invalid(`orchestration_policy.unclaimed_remote_work.mode must be one of ${REMOTE_WORK_MODES.join(", ")}.`);
  }
  const pullRequests = configured.pull_requests ?? DEFAULT_POLICY.pull_requests;
  if (!REMOTE_WORK_PULL_REQUEST_SOURCES.includes(pullRequests)) {
    invalid(`orchestration_policy.unclaimed_remote_work.pull_requests must be one of ${REMOTE_WORK_PULL_REQUEST_SOURCES.join(", ")}.`);
  }
  const recent = configured.recent_within_seconds ?? DEFAULT_POLICY.recent_within_seconds;
  if (recent !== null && (!Number.isSafeInteger(recent) || recent < RECENT_MIN_SECONDS || recent > RECENT_MAX_SECONDS)) {
    invalid(`orchestration_policy.unclaimed_remote_work.recent_within_seconds must be null or an integer from ${RECENT_MIN_SECONDS} to ${RECENT_MAX_SECONDS}.`);
  }
  return Object.freeze({ mode, pull_requests: pullRequests, recent_within_seconds: recent });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function namesId(text, storyId) {
  // Branch names and titles join words with "-", "_", or "/": only letters and digits continue an id.
  return new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(storyId)}($|[^A-Za-z0-9])`, "iu").test(String(text || ""));
}

/**
 * The stories a branch name or a title names, among storyIds. When one id
 * matched is part of another one matched (ST-1 inside ST-1-2), only the
 * longer one counts.
 */
export function storiesNamedBy(text, storyIds) {
  const matched = storyIds.filter((storyId) => namesId(text, storyId));
  return matched.filter((storyId) => !matched.some((other) => other !== storyId
    && other.length > storyId.length
    && namesId(other, storyId)));
}

/**
 * Groups remote branches and open pull requests by the candidate story they
 * name. branches: [{ branch, sha, last_commit_at, ahead_of_base }]; pull
 * requests: [{ number, url, title, head_branch, updated_at }]. A branch with
 * nothing beyond the base branch (ahead_of_base 0) or older than
 * recentWithinSeconds is left out. knownStoryIds lets a longer id win over
 * a shorter one it contains. Returns [{ story_id, branches, pull_requests }].
 */
export function groupRemoteWork(candidateIds, knownStoryIds, { branches = [], pullRequests = [], nowMs, recentWithinSeconds = null }) {
  const candidates = new Set(candidateIds);
  const known = [...new Set([...knownStoryIds, ...candidateIds])];
  const found = new Map();
  const entry = (storyId) => {
    if (!found.has(storyId)) found.set(storyId, { story_id: storyId, branches: [], pull_requests: [] });
    return found.get(storyId);
  };
  for (const branch of branches) {
    if (branch.ahead_of_base === 0) continue;
    const last = Date.parse(String(branch.last_commit_at || ""));
    if (recentWithinSeconds !== null && (!Number.isFinite(last) || last + recentWithinSeconds * 1000 < nowMs)) continue;
    for (const storyId of storiesNamedBy(branch.branch, known)) {
      if (candidates.has(storyId)) entry(storyId).branches.push(branch);
    }
  }
  for (const pullRequest of pullRequests) {
    const named = new Set([
      ...storiesNamedBy(pullRequest.title, known),
      ...storiesNamedBy(pullRequest.head_branch, known),
    ]);
    for (const storyId of named) {
      if (candidates.has(storyId)) entry(storyId).pull_requests.push(pullRequest);
    }
  }
  for (const item of found.values()) {
    item.branches.sort((left, right) => String(right.last_commit_at || "").localeCompare(String(left.last_commit_at || "")));
  }
  return [...found.values()].sort((left, right) => left.story_id.localeCompare(right.story_id));
}

/** "20 minutes ago" / "20 minuti fa" from an ISO time, or the time itself when it cannot be read. */
export function relativeAgeText(iso, nowMs, { italian = false } = {}) {
  const at = Date.parse(String(iso || ""));
  if (!Number.isFinite(at)) return italian ? "in un momento non noto" : "at an unknown time";
  const minutes = Math.max(0, Math.round((nowMs - at) / 60_000));
  if (minutes < 1) return italian ? "poco fa" : "just now";
  if (minutes < 60) return italian ? `${minutes} minut${minutes === 1 ? "o" : "i"} fa` : `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return italian ? `${hours} or${hours === 1 ? "a" : "e"} fa` : `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return italian ? `${days} giorni fa` : `${days} days ago`;
}

/** One plain line per story with work on the remote and no claim. */
export function unclaimedRemoteWorkLines(items, { nowMs, italian = false } = {}) {
  return items.map((item) => {
    const branch = item.branches[0];
    const pullRequest = item.pull_requests[0];
    const signs = [];
    if (branch) {
      signs.push(italian
        ? `il branch ${branch.branch} aggiornato ${relativeAgeText(branch.last_commit_at, nowMs, { italian })}`
        : `the branch ${branch.branch} updated ${relativeAgeText(branch.last_commit_at, nowMs, { italian })}`);
    }
    if (pullRequest) {
      signs.push(italian
        ? `la pull request aperta #${pullRequest.number} (${pullRequest.title})`
        : `the open pull request #${pullRequest.number} (${pullRequest.title})`);
    }
    const more = item.branches.length + item.pull_requests.length - signs.length;
    const extra = more > 0 ? (italian ? ` e altri ${more} segni` : ` and ${more} more sign${more === 1 ? "" : "s"}`) : "";
    return italian
      ? `${item.story_id} non è prenotata ma sul remote c'è ${signs.join(" e ")}${extra}: forse qualcuno ci sta già lavorando. Prima di iniziarla chiedi a chi l'ha creato; la decisione resta tua.`
      : `${item.story_id} is not reserved, but the remote has ${signs.join(" and ")}${extra}: someone may already be working on it. Ask whoever created it before starting; the decision stays yours.`;
  });
}
