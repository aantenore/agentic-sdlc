/**
 * Reads the delivery action receipts to tell whether a merge has a governed
 * 'pull_request.merge' authorization behind it: approved ("authorized") and
 * not yet completed. Receipts are looked up in the project's worktree and in
 * its sibling worktrees. Any read problem counts as "no authorization".
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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

/** Merge authorizations that are approved and whose completion is not recorded yet. */
export function openMergeAuthorizations(roots) {
  const receipts = roots.flatMap(readReceipts);
  const completed = new Set(receipts
    .filter((receipt) => receipt.status === "completed")
    .map((receipt) => receipt.authorization_receipt_ref?.id)
    .filter(Boolean));
  return receipts
    .filter((receipt) => receipt.action === "pull_request.merge" && receipt.status === "authorized" && !completed.has(receipt.id))
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
