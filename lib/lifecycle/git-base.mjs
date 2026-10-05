// The Git state a governed delivery started from. A repository with commits
// starts from the HEAD commit recorded in the task-start audit. A repository
// whose HEAD is unborn (no commit yet) has no commit to name, so the receipt
// states Git's empty tree as an explicit base instead of guessing one.

const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

export function isGitObjectId(value) {
  return typeof value === "string" && GIT_OBJECT_ID.test(value);
}

// The receipt field that marks an unborn start: no base commit, the empty tree.
export function unbornGitBase(emptyTreeId) {
  return { base_sha: null, base_tree: emptyTreeId };
}

export function isUnbornGitBase(value) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && value.base_sha === null
    && isGitObjectId(value.base_tree)
    && Object.keys(value).length === 2,
  );
}

/**
 * Classify the base a task-start receipt recorded.
 *
 * - `commit`: the HEAD commit recorded in `audit.git.head_sha`; callers still
 *   verify that it exists and is an ancestor of the current head.
 * - `unborn`: an explicit empty-tree base; callers verify the tree against the
 *   repository's object format.
 * - `none`: nothing verifiable was recorded.
 */
export function taskStartGitBase(taskStart) {
  const headSha = taskStart?.audit?.git?.head_sha;
  if (typeof headSha === "string" && headSha !== "") {
    return { kind: "commit", sha: headSha };
  }
  if (isUnbornGitBase(taskStart?.git_base)) {
    return { kind: "unborn", tree: taskStart.git_base.base_tree };
  }
  return { kind: "none" };
}
