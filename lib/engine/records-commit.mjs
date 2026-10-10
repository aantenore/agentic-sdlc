// Building and pushing a records-only commit on top of the remote base branch.
//
// A records publication must never carry anything but the records it names:
// the commit is built from the exact base tip it is pushed onto (a commit id
// resolved once, never a ref name read twice), its tree is that tip's tree plus
// the named records, and right before the push the diff against that tip is
// checked path by path. Anything else (a deletion, a path outside the allowed
// set) refuses the publication and nothing is pushed.

import { UserError } from "../cli/user-error.mjs";
import { classifyStoryRecordPath } from "../story-records.mjs";
import { firstLine } from "./shared-refs.mjs";

export const RECORDS_SCOPE_ERROR = "RECORDS_PUBLISH_SCOPE_VIOLATION";

/** Default project folders where a story's evidence may travel with its records (host_policy.records.evidence_paths). */
export const DEFAULT_EVIDENCE_PATHS = Object.freeze(["evidence"]);

function normalize(value) {
  return String(value || "").replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
}

export function evidencePaths(config = null) {
  const configured = config?.host_policy?.records?.evidence_paths;
  const list = Array.isArray(configured) ? configured.filter((item) => typeof item === "string" && item.trim()) : DEFAULT_EVIDENCE_PATHS;
  return [...new Set(list.map((item) => normalize(item.trim())).filter((item) => item && !item.split("/").includes("..")))];
}

function namesStory(text, storyId) {
  const id = String(storyId).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9])${id}($|[^A-Za-z0-9])`, "u").test(text);
}

/**
 * What a story publication may do to `filePath` on the base branch:
 * "add-or-modify" for the story's own records and the merged shared files,
 * "add" for shared records (never overwritten) and the story's own evidence,
 * null when the path is never published by this story (code, configuration,
 * caches, another story's records or evidence).
 */
export function storyPublishPermission(filePath, { sdlcFolder, storyId, storyIds = [], mergedPaths = [], evidenceRoots = DEFAULT_EVIDENCE_PATHS }) {
  const normalized = normalize(filePath);
  if (mergedPaths.includes(normalized)) return "add-or-modify";
  const kind = classifyStoryRecordPath(normalized, { sdlcFolder, storyId, storyIds });
  if (kind === "own") return "add-or-modify";
  if (kind === "shared") return "add";
  if (kind !== null) return null;
  // Outside the records folder only the story's own evidence, in an evidence folder, and never another story's.
  const inEvidence = evidenceRoots.some((root) => normalized.startsWith(`${root}/`));
  if (!inEvidence || !namesStory(normalized, storyId)) return null;
  const masked = normalized.split(storyId).join("\u0000");
  if (storyIds.some((id) => id !== storyId && namesStory(masked, id))) return null;
  return "add";
}

/** The commit id `ref` points at now; every later step uses this id, never the ref name again. */
export function resolveBaseTip(git, ref) {
  const sha = firstLine(git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).stdout);
  if (!/^[0-9a-f]{40,64}$/u.test(sha)) throw new UserError(`${ref} cannot be resolved to a commit`);
  return sha;
}

/**
 * Builds a commit whose tree is exactly `baseSha`'s tree plus `files` (their
 * bytes in this checkout), with `baseSha` as first parent. A private index is
 * used: the checkout and its index stay untouched. Returns { commit, tree,
 * baseTree }; commit is null when the tree equals the base tree.
 */
export function buildRecordsCommit(git, { baseSha, files, message, extraParents = [], indexFile }) {
  const env = { GIT_INDEX_FILE: indexFile };
  const step = (args, what) => {
    const result = git(args, { env });
    if (!result.ok) throw new UserError(`${what} failed (${firstLine(result.stderr)})`);
    return firstLine(result.stdout);
  };
  step(["read-tree", baseSha], "reading the base branch");
  for (const filePath of files) {
    const blob = step(["hash-object", "-w", "--", filePath], `storing ${filePath}`);
    step(["update-index", "--add", "--cacheinfo", `100644,${blob},${filePath}`], `adding ${filePath}`);
  }
  const tree = step(["write-tree"], "writing the tree");
  const baseTree = step(["rev-parse", `${baseSha}^{tree}`], "reading the base tree");
  if (tree === baseTree) return { commit: null, tree, baseTree };
  const parents = [baseSha, ...extraParents.filter((parent) => parent && parent !== baseSha)];
  const commit = step(["commit-tree", tree, ...parents.flatMap((parent) => ["-p", parent]), "-m", message], "creating the commit");
  return { commit, tree, baseTree };
}

/**
 * The last check before a push: `commit` must have `baseSha` as first parent
 * and, compared with `baseSha`, only add or modify paths `permission(path)`
 * allows ("add" or "add-or-modify"). Any deletion, rename, type change or
 * other path refuses the publication. Throws UserError with
 * RECORDS_PUBLISH_SCOPE_VIOLATION; returns the checked changes otherwise.
 */
export function assertRecordsCommitScope(git, { baseSha, commit, permission, label = "records publication" }) {
  const parent = firstLine(git(["rev-parse", "--verify", "--quiet", `${commit}^1`]).stdout);
  if (parent !== baseSha) {
    throw new UserError(`${label}: refused, the commit is not built on the base tip ${baseSha.slice(0, 12)} (parent ${parent ? parent.slice(0, 12) : "none"}); nothing was pushed`, null, RECORDS_SCOPE_ERROR);
  }
  const diff = git(["diff-tree", "-r", "-z", "--no-renames", "--no-commit-id", "--name-status", baseSha, commit]);
  if (!diff.ok) throw new UserError(`${label}: refused, the commit cannot be compared with the base tip (${firstLine(diff.stderr)}); nothing was pushed`, null, RECORDS_SCOPE_ERROR);
  const fields = diff.stdout.split("\0").filter((item) => item !== "");
  const changes = [];
  const violations = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const status = fields[index].trim().charAt(0);
    const filePath = fields[index + 1];
    changes.push({ status, path: filePath });
    const allowed = permission(filePath);
    if (status === "A" && (allowed === "add" || allowed === "add-or-modify")) continue;
    if (status === "M" && allowed === "add-or-modify") continue;
    violations.push(`${status === "D" ? "deletes" : status === "M" ? "modifies" : status === "A" ? "adds" : `changes (${status})`} ${filePath}`);
  }
  if (violations.length > 0) {
    const shown = violations.slice(0, 20).join("; ");
    const more = violations.length > 20 ? `; and ${violations.length - 20} more` : "";
    throw new UserError(
      `${label}: refused, the records commit ${commit.slice(0, 12)} would change what it may not touch on the base branch: ${shown}${more}. Nothing was pushed.`,
      null,
      RECORDS_SCOPE_ERROR,
    );
  }
  return changes;
}

/**
 * Pushes `commit` to `branch` only while the remote branch is still exactly
 * `expectedSha` (a lease on that tip). Returns the git result.
 */
export function pushRecordsCommit(git, { remote, branch, commit, expectedSha, timeoutSeconds }) {
  return git([
    "push", "--quiet",
    `--force-with-lease=refs/heads/${branch}:${expectedSha}`,
    remote, `${commit}:refs/heads/${branch}`,
  ], { timeoutSeconds });
}
