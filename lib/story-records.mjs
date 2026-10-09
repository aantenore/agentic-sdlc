// A story's own project records (its claim, steps, receipts, traces) and the
// shared records its work adds (contracts, registries) belong on the story's
// branch next to its code, so the pull request that merges the code brings
// them too. Records of another story, the project configuration, and derived
// caches never do. This module holds the pure rules; git lives in the engine.

export const STORY_RECORDS_IN_BRANCH = Object.freeze(["include", "exclude"]);
export const STORY_RECORDS_CHECKS = Object.freeze(["warn", "refuse", "off"]);

const DEFAULT_POLICY = Object.freeze({
  in_branch: "include",
  before_pull_request: "warn",
  publish_branch_prefix: "sdlc-records/",
});

/**
 * The validated story records policy (orchestration_policy.story_records),
 * with defaults for every key a project leaves out. invalid(message)
 * reports a wrong value.
 */
export function storyRecordsPolicy(configured, invalid) {
  if (configured === undefined || configured === null) return DEFAULT_POLICY;
  if (typeof configured !== "object" || Array.isArray(configured)) {
    invalid("orchestration_policy.story_records must be an object.");
  }
  const inBranch = configured.in_branch ?? DEFAULT_POLICY.in_branch;
  if (!STORY_RECORDS_IN_BRANCH.includes(inBranch)) {
    invalid(`orchestration_policy.story_records.in_branch must be one of ${STORY_RECORDS_IN_BRANCH.join(", ")}.`);
  }
  const check = configured.before_pull_request ?? DEFAULT_POLICY.before_pull_request;
  if (!STORY_RECORDS_CHECKS.includes(check)) {
    invalid(`orchestration_policy.story_records.before_pull_request must be one of ${STORY_RECORDS_CHECKS.join(", ")}.`);
  }
  const prefix = configured.publish_branch_prefix ?? DEFAULT_POLICY.publish_branch_prefix;
  if (typeof prefix !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/u.test(prefix) || prefix.includes("..")) {
    invalid("orchestration_policy.story_records.publish_branch_prefix must be a branch name prefix.");
  }
  return Object.freeze({ in_branch: inBranch, before_pull_request: check, publish_branch_prefix: prefix });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function namesId(text, id) {
  return new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(id)}($|[^A-Za-z0-9])`, "u").test(text);
}

/**
 * What a project path is, as a record of story `storyId`: null when it is
 * not under the project records folder; "excluded" for the configuration
 * and derived caches; "other_story" when it names another known story;
 * "own" when it names this story; "shared" otherwise (contracts,
 * registries, requirements its work added).
 */
export function classifyStoryRecordPath(filePath, { sdlcFolder = ".sdlc", storyId, storyIds = [] }) {
  const normalized = String(filePath || "").replace(/\\/gu, "/").replace(/^\.\//u, "");
  const folder = String(sdlcFolder || ".sdlc").replace(/\/$/u, "");
  if (!normalized.startsWith(`${folder}/`)) return null;
  const inside = normalized.slice(folder.length + 1);
  if (inside === "config.json" || inside.startsWith("cache/") || inside.startsWith("locks/")) return "excluded";
  const own = namesId(inside, storyId);
  // Another story's id inside this story's own id (ST-1 in ST-1-A) is not another story.
  const rest = own ? inside.split(storyId).join("\u0000") : inside;
  if (storyIds.some((id) => id !== storyId && namesId(rest, id))) return "other_story";
  return own ? "own" : "shared";
}

/** True when a path may travel on the story's branch as one of its records. */
export function storyBranchRecordPath(filePath, options) {
  return ["own", "shared"].includes(classifyStoryRecordPath(filePath, options));
}

/**
 * The records a pull request must carry for its story: the claim and at
 * least one completed step, as paths relative to the project. Returns the
 * missing ones given the paths in the pull request's head.
 */
export function missingStoryRecords(headPaths, { sdlcFolder = ".sdlc", storyId }) {
  const folder = `${String(sdlcFolder || ".sdlc").replace(/\/$/u, "")}/stories/${storyId}`;
  const paths = new Set(headPaths);
  const missing = [];
  if (!paths.has(`${folder}/claim.json`)) missing.push(`${folder}/claim.json`);
  if (![...paths].some((item) => item.startsWith(`${folder}/steps/`))) missing.push(`${folder}/steps/`);
  return missing;
}
