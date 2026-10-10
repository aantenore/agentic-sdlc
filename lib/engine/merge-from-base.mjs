// A story branch that picks up its approved base branch (git merge origin/<base>)
// brings in files that are not the story's work. The write-scope checks charge
// the story only with what differs from that base: a path whose content is
// identical to the base tip is excluded, and the exclusion is recorded.
import fs from "node:fs";
import path from "node:path";
import { execGit, execGitOutput, gitCommandSucceeds } from "./git.mjs";

export const MERGE_FROM_BASE_SCHEMA = "merge-from-base:v1";
const PATHSPEC_CHUNK = 200;

function listOf(output) {
  return String(output || "").split(/\r?\n/u).map((item) => item.trim()).filter(Boolean);
}

/** Commits an unfinished `git merge` is bringing in, or [] when no merge is in progress. */
function mergeInProgressHeads(root) {
  const markerPath = execGit(root, ["rev-parse", "--git-path", "MERGE_HEAD"]);
  if (!markerPath) return [];
  const absolute = path.resolve(root, markerPath);
  if (!fs.existsSync(absolute)) return [];
  try {
    return listOf(fs.readFileSync(absolute, "utf8"));
  } catch {
    return [];
  }
}

/** The first remote-tracking ref of the approved base branch that exists locally. */
export function resolveBaseTracking(context, baseBranch, remotes = null) {
  if (!baseBranch) return null;
  const names = remotes || listOf(execGit(context.root, ["remote"]));
  for (const remote of names) {
    const ref = `refs/remotes/${remote}/${baseBranch}`;
    const sha = execGit(context.root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
    if (sha) return { base_ref: ref, base_sha: sha };
  }
  return null;
}

const isAncestorOfBase = (root, sha, baseSha) => gitCommandSucceeds(root, ["merge-base", "--is-ancestor", sha, baseSha]);

function zeroSeparated(output) {
  return String(output || "").split("\0").filter(Boolean);
}

/** Which of `paths` exist in the given tree-ish (`ls-tree`) or in the index (`index`). */
function existingPaths(root, paths, where) {
  const found = new Set();
  for (let index = 0; index < paths.length; index += PATHSPEC_CHUNK) {
    const chunk = paths.slice(index, index + PATHSPEC_CHUNK).map((item) => `:(literal)${item}`);
    const output = where === "index"
      ? execGitOutput(root, ["ls-files", "-z", "--cached", "--", ...chunk])
      : execGitOutput(root, ["ls-tree", "-r", "--name-only", "-z", where, "--", ...chunk]);
    if (output === null) return null;
    for (const item of zeroSeparated(output)) found.add(item);
  }
  return found;
}

/**
 * Paths (of `paths`) that differ from the base tip, or null when git cannot tell.
 * A path counts as equal only when both sides hold it with the same content or
 * both lack it; an untracked or new file is never equal to a base that lacks it.
 */
function differingFromBase(root, baseSha, paths, compare, headSha) {
  const different = new Set();
  const against = compare === "index" ? ["--cached", baseSha] : compare === "worktree" ? [baseSha] : [baseSha, headSha || "HEAD"];
  for (let index = 0; index < paths.length; index += PATHSPEC_CHUNK) {
    const chunk = paths.slice(index, index + PATHSPEC_CHUNK).map((item) => `:(literal)${item}`);
    const output = execGitOutput(root, ["diff", "--name-only", "--no-renames", ...against, "--", ...chunk]);
    if (output === null) return null;
    for (const item of listOf(output)) different.add(item);
  }
  const inBase = existingPaths(root, paths, baseSha);
  const local = compare === "head" ? existingPaths(root, paths, headSha || "HEAD") : existingPaths(root, paths, "index");
  if (!inBase || !local) return null;
  for (const item of paths) {
    const tracked = local.has(item);
    const here = tracked || (compare === "worktree" && fs.existsSync(path.join(root, item)));
    if (here !== inBase.has(item)) different.add(item);
    // An untracked file is invisible to git diff: it is new content, never the base's.
    if (here && !tracked) different.add(item);
  }
  return different;
}

/**
 * Merge-from-base evidence for `paths`, or null when the change set is not one.
 * `compare` says what the paths are measured in: "index" (staged, git.commit),
 * "head" (committed, at `head_sha`) or "worktree". The merge must bring in only
 * commits already on the base branch: MERGE_HEAD (in progress) or the extra
 * parents of the merge commits in base..head must be the base tip or its ancestors.
 */
export function mergeFromBaseEvidence(context, { base_ref: baseRef, base_sha: baseSha, head_sha: headSha = null }, paths, compare) {
  const root = context.root;
  if (!baseSha || !baseRef || paths.length === 0) return null;
  let source;
  if (compare === "index") {
    const heads = mergeInProgressHeads(root);
    if (heads.length !== 1 || !isAncestorOfBase(root, heads[0], baseSha)) return null;
    source = { merge_head_sha: heads[0] };
  } else {
    const range = headSha ? `${baseSha}..${headSha}` : `${baseSha}..HEAD`;
    const merges = listOf(execGit(root, ["rev-list", "--merges", "--parents", range]))
      .map((line) => line.split(/\s+/u))
      .filter(([, , ...others]) => others.length > 0 && others.every((sha) => isAncestorOfBase(root, sha, baseSha)))
      .map(([sha]) => sha);
    const inProgress = compare === "worktree" ? mergeInProgressHeads(root) : [];
    const progressOk = inProgress.length === 1 && isAncestorOfBase(root, inProgress[0], baseSha);
    if (merges.length === 0 && !progressOk) return null;
    source = {
      ...(merges.length > 0 ? { merge_commits: merges.sort() } : {}),
      ...(progressOk ? { merge_head_sha: inProgress[0] } : {}),
    };
  }
  const differing = differingFromBase(root, baseSha, paths, compare, headSha);
  // An unreadable comparison excludes nothing: every path stays subject to the scope.
  const excluded = differing ? paths.filter((item) => !differing.has(item)).sort() : [];
  return {
    schema_version: MERGE_FROM_BASE_SCHEMA,
    base_ref: baseRef,
    base_sha: baseSha,
    ...source,
    excluded_paths: excluded,
  };
}
