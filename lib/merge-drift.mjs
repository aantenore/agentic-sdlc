// Stories whose work is already on the base branch while their records still
// show them open. Story records move only through recorded lifecycle steps,
// so a pull request merged by hand, or by an agent that stopped before
// recording completion, leaves the story "available" on every computer.
// status reports such drift from git alone (a provider is never asked) and
// never changes a record: completing a story stays a recorded decision.

export const MERGE_DRIFT_MODES = Object.freeze(["git", "off"]);

const MAX_COMMITS_MIN = 1;
const MAX_COMMITS_MAX = 100_000;

const DEFAULT_POLICY = Object.freeze({
  mode: "git",
  base_branch: null,
  match_commit_subject: true,
  max_commits_scanned: 500,
});

/**
 * The validated merge drift policy, with defaults for every key a project
 * leaves out. `base_branch` null means the remote's default branch.
 * invalid(message) reports a wrong value.
 */
export function mergeDriftPolicy(configured, invalid) {
  if (configured === undefined || configured === null) return DEFAULT_POLICY;
  if (typeof configured !== "object" || Array.isArray(configured)) {
    invalid("orchestration_policy.merge_drift must be an object.");
  }
  const mode = configured.mode ?? DEFAULT_POLICY.mode;
  if (!MERGE_DRIFT_MODES.includes(mode)) {
    invalid(`orchestration_policy.merge_drift.mode must be one of ${MERGE_DRIFT_MODES.join(", ")}.`);
  }
  const baseBranch = configured.base_branch ?? DEFAULT_POLICY.base_branch;
  if (baseBranch !== null && (typeof baseBranch !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u.test(baseBranch) || baseBranch.includes(".."))) {
    invalid("orchestration_policy.merge_drift.base_branch must be null or a branch name.");
  }
  const matchSubject = configured.match_commit_subject ?? DEFAULT_POLICY.match_commit_subject;
  if (typeof matchSubject !== "boolean") {
    invalid("orchestration_policy.merge_drift.match_commit_subject must be true or false.");
  }
  const maxCommits = configured.max_commits_scanned ?? DEFAULT_POLICY.max_commits_scanned;
  if (!Number.isSafeInteger(maxCommits) || maxCommits < MAX_COMMITS_MIN || maxCommits > MAX_COMMITS_MAX) {
    invalid(`orchestration_policy.merge_drift.max_commits_scanned must be an integer from ${MAX_COMMITS_MIN} to ${MAX_COMMITS_MAX}.`);
  }
  return Object.freeze({
    mode,
    base_branch: baseBranch,
    match_commit_subject: matchSubject,
    max_commits_scanned: maxCommits,
  });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * True when a commit subject names the story: the id stands alone (so
 * ST-1 does not match ST-10), and a revert never counts as delivery.
 */
export function subjectNamesStory(subject, storyId) {
  const text = String(subject || "");
  if (/^revert\b/iu.test(text.trim())) return false;
  const pattern = new RegExp(`(^|[^A-Za-z0-9_-])${escapeRegExp(storyId)}($|[^A-Za-z0-9_-])`, "iu");
  return pattern.test(text);
}

/**
 * Finds, for each open story, the first-parent commit of the base branch
 * that delivered it: a merge whose merged-in parent is the tip of one of the
 * story's branches, or (when match_commit_subject) a commit whose subject
 * names the story. commits: [{ sha, parents: [sha], subject }], newest
 * first; branchTips: Map(storyId -> [{ branch, sha }]).
 * Returns [{ story_id, commit, subject, evidence, branch }].
 */
export function findMergedStories(storyIds, commits, branchTips, { matchCommitSubject = true } = {}) {
  const found = [];
  for (const storyId of storyIds) {
    const tips = branchTips.get(storyId) || [];
    let hit = null;
    for (const commit of commits) {
      const merged = tips.find((tip) => commit.parents.slice(1).includes(tip.sha));
      if (merged) {
        hit = { commit, evidence: "merged_branch", branch: merged.branch };
        break;
      }
      if (matchCommitSubject && subjectNamesStory(commit.subject, storyId)) {
        hit = { commit, evidence: "commit_subject", branch: null };
        break;
      }
    }
    if (hit) {
      found.push({
        story_id: storyId,
        commit: hit.commit.sha,
        subject: hit.commit.subject,
        evidence: hit.evidence,
        branch: hit.branch,
      });
    }
  }
  return found;
}
