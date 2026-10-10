/**
 * Reads the delivery action receipts to tell whether a merge has a governed
 * 'pull_request.merge' authorization behind it: approved ("authorized") and
 * not yet completed. Receipts are looked up in the project's worktree and in
 * its sibling worktrees. Any read problem counts as "no authorization".
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const UNGOVERNED_REPOS_ENV = "AGENTIC_SDLC_UNGOVERNED_REPOS";
const RECEIPTS = path.join(".sdlc", "autonomy", "actions");
const PROTECTED_BASE_BRANCHES = new Set(["main", "master"]);
const PR_URL_NUMBER = /\/pull\/(\d+)(?:[/?#]|$)/u;

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 3000 });
  return result.status === 0 ? result.stdout : "";
}

function worktreeRoots(root, cwd) {
  const roots = new Set([root]);
  for (const line of git(cwd || root, ["worktree", "list", "--porcelain"]).split("\n")) {
    if (line.startsWith("worktree ")) roots.add(line.slice("worktree ".length).trim());
  }
  return [...roots];
}

function readReceipts(root) {
  const directory = path.join(root, RECEIPTS);
  let names = [];
  try {
    names = fs.readdirSync(directory).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const receipts = [];
  for (const name of names) {
    try {
      const receipt = JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
      if (receipt?.kind === "delivery_action_receipt") receipts.push(receipt);
    } catch {
      // an unreadable receipt authorizes nothing
    }
  }
  return receipts;
}

function openReceipts(roots, action) {
  const receipts = roots.flatMap(readReceipts);
  const completed = new Set(receipts
    .filter((receipt) => receipt.status === "completed")
    .map((receipt) => receipt.authorization_receipt_ref?.id)
    .filter(Boolean));
  return receipts.filter((receipt) => receipt.action === action && receipt.status === "authorized" && !completed.has(receipt.id));
}

/** Merge authorizations that are approved and whose completion is not recorded yet. */
export function openMergeAuthorizations(roots) {
  return openReceipts(roots, "pull_request.merge")
    .map((receipt) => {
      const details = receipt.action_details || {};
      const url = details.merge?.pr_url || details.merge_precondition?.pr_url || details.pull_request?.pr_url || "";
      const number = PR_URL_NUMBER.exec(url)?.[1];
      return {
        number: number ? Number(number) : null,
        branch: details.head_branch || details.merge_precondition?.head_branch || receipt.runtime_target?.branch || null,
      };
    });
}

/** True when the attempted merge is covered by an open 'pull_request.merge' authorization. */
export function mergeAuthorized(root, cwd, attempt) {
  try {
    if (attempt.currentBranchOnly) return !PROTECTED_BASE_BRANCHES.has(git(cwd || root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim());
    if (!root || attempt.direct) return false;
    const open = openMergeAuthorizations(worktreeRoots(root, cwd));
    const branch = attempt.branch || (attempt.number === null ? git(cwd || root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim() : null);
    return open.some((item) => (attempt.number !== null && item.number === attempt.number) || (branch && item.branch === branch));
  } catch {
    return false;
  }
}

const DEFAULT_STORY_BRANCH_PATTERNS = ["feature/<story-id>", "codex/<story-id>"];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Branches of the stories with an active claim in the project or its worktrees (claim branch plus configured patterns). */
export function activeStoryBranches(roots) {
  const branches = new Set();
  for (const root of roots) {
    const configured = readJson(path.join(root, ".sdlc", "config.json"))?.parallel_work;
    const patterns = [...DEFAULT_STORY_BRANCH_PATTERNS, ...(Array.isArray(configured?.branch_patterns) ? configured.branch_patterns : []), ...(configured?.branch_pattern ? [configured.branch_pattern] : [])]
      .map(String);
    let stories = [];
    try {
      stories = fs.readdirSync(path.join(root, ".sdlc", "stories"));
    } catch {
      continue;
    }
    for (const story of stories) {
      const claim = readJson(path.join(root, ".sdlc", "stories", story, "claim.json"));
      if (claim?.status !== "active") continue;
      if (claim.branch) branches.add(String(claim.branch));
      for (const pattern of patterns) branches.add(pattern.replaceAll("<story-id>", String(claim.story_id || story)));
    }
  }
  return branches;
}

/** Open 'git.push' authorizations as the branches they cover. */
export function openPushAuthorizations(roots) {
  return openReceipts(roots, "git.push").map((receipt) => {
    const details = receipt.action_details || {};
    const ref = details.push?.destination_ref ? String(details.push.destination_ref).replace(/^refs\/heads\//u, "") : null;
    return details.head_branch || ref || receipt.runtime_target?.branch || null;
  }).filter(Boolean);
}

/**
 * True when a push touches no branch of a story with an active claim, or every such branch
 * is covered by an open 'git.push' authorization. An empty or HEAD target is the current branch.
 */
export function storyPushAuthorized(root, cwd, attempt) {
  try {
    const current = () => git(cwd || root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    const targets = (attempt.branches?.length ? attempt.branches : ["HEAD"]).map((branch) => (branch === "HEAD" ? current() : branch));
    const roots = worktreeRoots(root, cwd);
    const story = activeStoryBranches(roots);
    const touched = targets.filter((branch) => branch && story.has(branch));
    if (touched.length === 0) return true;
    const open = new Set(openPushAuthorizations(roots));
    return touched.every((branch) => open.has(branch));
  } catch {
    return true;
  }
}

function canonical(target) {
  let resolved = path.resolve(target);
  try {
    resolved = fs.realpathSync(resolved);
  } catch {
    // a path that does not exist is compared as written
  }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Absolute repository paths the person opted out of the merge and push guard, from the OS path-separated environment variable. */
export function ungovernedRepos(env = process.env) {
  return String(env?.[UNGOVERNED_REPOS_ENV] ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry && path.isAbsolute(entry))
    .map(canonical);
}

/**
 * True when the repository a command acts on is an opted-out one. The repository is the git
 * toplevel of the directory the command targets: the last `git -C` directory (resolved against
 * the working directory) or the working directory itself.
 */
export function isUngovernedRepo(cwd, dirs, env = process.env) {
  try {
    const repos = ungovernedRepos(env);
    if (repos.length === 0 || !cwd) return false;
    const target = targetDirectory(cwd, dirs);
    const top = git(target, ["rev-parse", "--show-toplevel"]).trim();
    return repos.includes(canonical(top || target));
  } catch {
    return false;
  }
}

function targetDirectory(cwd, dirs) {
  let target = path.resolve(cwd);
  for (const dir of Array.isArray(dirs) ? dirs : []) target = path.resolve(target, dir);
  return target;
}

function gitOk(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8", timeout: 3000 }).status === 0;
}

export const GUARD_REMOTE_TIMEOUT_ENV = "AGENTIC_SDLC_GUARD_REMOTE_TIMEOUT_MS";
const DEFAULT_GUARD_REMOTE_TIMEOUT_MS = 5000;
// Private ref the verified base is fetched into; the guard refuses agent writes under refs/agentic-sdlc*.
const VERIFIED_BASE_REF = "refs/agentic-sdlc-guard/base";
const FULL_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

function remoteGit(cwd, args, env = process.env) {
  const timeout = Number(env?.[GUARD_REMOTE_TIMEOUT_ENV]) > 0 ? Number(env[GUARD_REMOTE_TIMEOUT_ENV]) : DEFAULT_GUARD_REMOTE_TIMEOUT_MS;
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
  });
  return result.status === 0 ? result.stdout : null;
}

const verifiedBases = new Map();

/**
 * The base-branch commit as the remote 'origin' reports it, fetched into a private ref and checked
 * against that report, or null when there is no origin, it cannot be reached, or the check fails.
 * Local refs (refs/heads/*, refs/remotes/*) are never trusted: an agent can rewrite them.
 * The base is the attempt's, otherwise the remote's default branch, main, or master.
 */
function verifiedRemoteBase(top, attempt) {
  const key = `${top}\0${attempt?.base || ""}`;
  if (verifiedBases.has(key)) return verifiedBases.get(key);
  let verified = null;
  const listed = remoteGit(top, ["ls-remote", "--symref", "origin", "HEAD", "refs/heads/*"]);
  if (listed !== null) {
    const heads = new Map();
    let remoteDefault = null;
    for (const line of listed.split("\n")) {
      const symref = /^ref: refs\/heads\/(\S+)\tHEAD$/u.exec(line);
      if (symref) remoteDefault = symref[1];
      const head = /^([0-9a-f]+)\trefs\/heads\/(\S+)$/u.exec(line);
      if (head) heads.set(head[2], head[1]);
    }
    const branch = [attempt?.base, remoteDefault, ...PROTECTED_BASE_BRANCHES].find((name) => name && heads.has(name));
    const sha = branch ? heads.get(branch) : null;
    if (sha && FULL_SHA.test(sha)) {
      const fetched = remoteGit(top, ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "origin", `+${sha}:${VERIFIED_BASE_REF}`]) !== null
        || remoteGit(top, ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "origin", `+refs/heads/${branch}:${VERIFIED_BASE_REF}`]) !== null;
      if (fetched && git(top, ["rev-parse", "--verify", "--quiet", `${VERIFIED_BASE_REF}^{commit}`]).trim() === sha) verified = sha;
    }
  }
  verifiedBases.set(key, verified);
  return verified;
}

/**
 * True when the merge and push guard does not apply to the repository a command acts on.
 * The repository is an Agentic SDLC project when .sdlc/project.json is in its working tree, its
 * index, or the base branch as verified on the remote: removing the file locally does not lift the
 * guard. Only that verified base branch can turn the base-branch rule off, with
 * host_policy.guard.protect_base_branch = false; the working tree, the index, and local refs never
 * can. A repository that cannot be resolved, or whose remote base cannot be verified, stays guarded.
 */
export function isGuardExempt(cwd, attempt) {
  try {
    if (!cwd) return false;
    const top = git(targetDirectory(cwd, attempt?.dirs), ["rev-parse", "--show-toplevel"]).trim();
    if (!top) return false;
    const localGoverned = fs.existsSync(path.join(top, ".sdlc", "project.json")) || gitOk(top, ["cat-file", "-e", ":.sdlc/project.json"]);
    // A governed story push stays under the story rule without asking the remote.
    if (localGoverned && attempt?.storyPush) return false;
    const base = verifiedRemoteBase(top, attempt);
    if (base === null) return false;
    if (!localGoverned && !gitOk(top, ["cat-file", "-e", `${base}:.sdlc/project.json`])) return true;
    if (attempt?.storyPush) return false;
    const committed = git(top, ["show", `${base}:.sdlc/config.json`]);
    return JSON.parse(committed || "null")?.host_policy?.guard?.protect_base_branch === false;
  } catch {
    return false;
  }
}
