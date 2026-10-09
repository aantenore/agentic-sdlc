// Which commits on a story's branch are the story's own work. Two stories may
// start from the same main; once the first one merges, the second branch can
// be fast-forwarded or rebased onto main to pick it up. The commits that came
// with that move belong to the merged delivery, not to the second story, so
// they are left out of its changed-path perimeter. A change the second story
// makes to a file the first one also touched is still its own commit and
// still counts. Three more kinds of commit are set aside: commits that only
// touch project records (.sdlc/), a commit and its exact revert, and base
// commits a person accepted for the story with story base acknowledge.
import path from "node:path";
import {
  SDLC_DIR,
} from "../lifecycle/constants.mjs";
import {
  deliveryAutonomyRoot,
} from "../lifecycle/delivery.mjs";
import {
  taskStartGitBase,
} from "../lifecycle/git-base.mjs";
import {
  orchestrationPolicy,
} from "../story-claim-shared-state.mjs";
import {
  storyOriginalTaskStart,
} from "./authorization.mjs";
import {
  baseAcknowledgeCommand,
  readStoryBaseAcknowledgements,
} from "./base-acknowledgements.mjs";
import {
  mergedCommitSha,
} from "./baseline-refresh.mjs";
import {
  allDeliveryActionReceipts,
  currentDeliveryExecutionState,
  readDeliveryAutonomyProfile,
} from "./delivery.mjs";
import {
  externalMergeEvidence,
} from "./external-merge.mjs";
import {
  execGit,
  execGitOutput,
  gitCommandSucceeds,
} from "./git.mjs";
import {
  crypto,
} from "../runtime/host.mjs";
import {
  safeReadDir,
} from "./storage.mjs";

const COMMIT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
// Pairing a commit with its revert costs two diffs per commit; longer ranges
// are not searched for pairs.
const REVERT_PAIR_SEARCH_LIMIT = 200;

/**
 * The commit a merged pull-request delivery left on its base branch: the
 * plugin's own merge, or a merge made outside the plugin and acknowledged
 * with 'autonomy delivery reconcile'. null when the delivery is not merged.
 */
export function deliveryMergeCommit(context, profile, state) {
  if (profile?.delivery_kind !== "pull_request" || state?.lifecycle_status !== "terminal") return null;
  const sha = state.status === "merged"
    ? mergedCommitSha(context, state.close_receipt)
    : externalMergeEvidence(context, profile, state)?.merge_commit_sha;
  const commitSha = String(sha || "").toLowerCase();
  return COMMIT_ID.test(commitSha) ? commitSha : null;
}

/**
 * Pull-request deliveries of other stories that are merged, through the
 * plugin or outside it and acknowledged with 'autonomy delivery reconcile',
 * with the commit the merge left on the base branch.
 */
export function mergedDeliveryCommits(context, { excludeStoryId = null } = {}) {
  const merged = [];
  for (const name of safeReadDir(deliveryAutonomyRoot(context)).sort()) {
    if (!name.endsWith(".json")) continue;
    try {
      const profile = readDeliveryAutonomyProfile(context, path.basename(name, ".json"), { missingOk: true });
      if (!profile || profile.delivery_kind !== "pull_request") continue;
      const storyIds = (profile.story_refs || []).map((ref) => ref?.id).filter(Boolean);
      if (excludeStoryId && storyIds.includes(excludeStoryId)) continue;
      const commitSha = deliveryMergeCommit(context, profile, currentDeliveryExecutionState(context, profile));
      if (!commitSha) continue;
      merged.push({ story_ids: storyIds, delivery_profile_id: profile.id, merge_commit_sha: commitSha });
    } catch {
      // A delivery whose records cannot be verified is not treated as merged.
    }
  }
  return merged;
}

/**
 * The commits a story's branch added since its task start, without the
 * commits of other stories' merged deliveries it picked up by fast-forward or
 * rebase onto the base branch. baseSha is null for a story that started
 * before the first commit. Returns null when Git cannot list the range.
 */
export function storyOwnCommitRange(context, { storyId, baseSha, headSha }) {
  const excluded = mergedDeliveryCommits(context, { excludeStoryId: storyId }).filter((delivery) =>
    gitCommandSucceeds(context.root, ["cat-file", "-e", `${delivery.merge_commit_sha}^{commit}`])
    && gitCommandSucceeds(context.root, ["merge-base", "--is-ancestor", delivery.merge_commit_sha, headSha])
    && !(baseSha && gitCommandSucceeds(context.root, ["merge-base", "--is-ancestor", delivery.merge_commit_sha, baseSha])));
  const exclusions = [
    ...(baseSha ? [`^${baseSha}`] : []),
    ...excluded.map((delivery) => `^${delivery.merge_commit_sha}`),
  ];
  const listed = execGitOutput(context.root, ["rev-list", "--topo-order", "--reverse", headSha, ...exclusions, "--"]);
  if (listed === null) return null;
  const listedCommits = listed.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean);
  const setAside = setAsideCommits(context, storyId, listedCommits);
  return {
    commits: listedCommits.filter((sha) => !setAside.has(sha)),
    excluded_deliveries: excluded,
    set_aside: [...setAside].map(([sha, item]) => ({ sha, ...item })),
    exclusions,
  };
}

function firstParentPaths(context, commitSha) {
  const listed = execGitOutput(context.root, [
    "diff-tree", "--root", "-r", "-z", "--name-only", "--no-renames", "--no-commit-id", "-m", "--first-parent", commitSha, "--",
  ]);
  return listed === null ? null : listed.split("\0").filter(Boolean);
}

function isRecordsOnly(paths) {
  return paths.length > 0 && paths.every((item) => item === SDLC_DIR || item.startsWith(`${SDLC_DIR}/`));
}

function diffDigest(context, commitSha, reverse) {
  const diff = execGitOutput(context.root, [
    "diff", "--binary", "--full-index", "--no-renames", "--no-ext-diff", "--no-textconv",
    ...(reverse ? [commitSha, `${commitSha}^`] : [`${commitSha}^`, commitSha]), "--",
  ]);
  return diff ? crypto.createHash("sha256").update(diff).digest("hex") : null;
}

/**
 * Commits among the listed ones that are no one's work to charge: those that
 * only touch project records, a commit together with a later commit that
 * exactly undoes it, and base commits a person accepted for the story (with
 * the commits an accepted merge brought in). Map of sha to { kind, reason }.
 */
function setAsideCommits(context, storyId, commits) {
  const setAside = new Map();
  if (commits.length === 0) return setAside;
  const listed = new Set(commits);
  for (const record of readStoryBaseAcknowledgements(context, storyId)) {
    if (!listed.has(record.commit_sha)) continue;
    setAside.set(record.commit_sha, { kind: "acknowledged", reason: `accepted base commit (${record.id})` });
    const brought = execGitOutput(context.root, ["rev-list", `${record.commit_sha}^@`, `^${record.commit_sha}^1`, "--"]);
    for (const sha of String(brought || "").split(/\r?\n/u).map((item) => item.trim()).filter(Boolean)) {
      if (listed.has(sha) && !setAside.has(sha)) setAside.set(sha, { kind: "acknowledged", reason: `brought in by accepted base commit ${record.commit_sha.slice(0, 12)}` });
    }
  }
  const singleParent = [];
  for (const sha of commits) {
    if (setAside.has(sha)) continue;
    const paths = firstParentPaths(context, sha);
    if (paths && isRecordsOnly(paths)) {
      setAside.set(sha, { kind: "records", reason: "touches only project records" });
      continue;
    }
    if (paths && paths.length > 0 && !execGit(context.root, ["rev-parse", "--verify", "--quiet", `${sha}^2`])) singleParent.push(sha);
  }
  if (singleParent.length < 2 || singleParent.length > REVERT_PAIR_SEARCH_LIMIT) return setAside;
  // commits are oldest first: an undo comes after what it undoes.
  const open = new Map();
  for (const sha of singleParent) {
    const undoes = diffDigest(context, sha, true);
    const pending = undoes ? open.get(undoes) : null;
    if (pending?.length) {
      const original = pending.pop();
      setAside.set(original, { kind: "reverted", reason: `undone by ${sha.slice(0, 12)}` });
      setAside.set(sha, { kind: "reverted", reason: `undoes ${original.slice(0, 12)}` });
      continue;
    }
    const forward = diffDigest(context, sha, false);
    if (!forward) continue;
    if (!open.has(forward)) open.set(forward, []);
    open.get(forward).push(sha);
  }
  return setAside;
}

/** Every path the given commits touched, or null when Git cannot tell. */
export function pathsTouchedByCommits(context, commits) {
  const touched = new Set();
  for (const commitSha of commits) {
    const listed = execGitOutput(context.root, [
      "diff-tree", "--root", "-m", "-r", "-z", "--name-only", "--no-renames", "--no-commit-id", commitSha, "--",
    ]);
    if (listed === null) return null;
    for (const item of listed.split("\0")) if (item) touched.add(item);
  }
  return [...touched].sort();
}

/**
 * Commits on the branch after the story's task start that are neither the
 * story's own nor part of a merged delivery: commits other deliveries
 * recorded with git.commit but have not merged, and commits on the base
 * branch that no merged delivery accounts for. Their files would be charged
 * to this story, so git.commit and git.push stop before more work lands on
 * top of them. Returns { story_id, commits, reasons, reset_target } entries.
 */
export function foreignStoryBranchCommits(context, profile, headSha) {
  if (profile?.delivery_kind !== "pull_request" || !COMMIT_ID.test(String(headSha || ""))) return [];
  const findings = [];
  const receipts = allDeliveryActionReceipts(context).filter((receipt) =>
    receipt.action === "git.commit"
    && receipt.status === "completed"
    && receipt.outcome === "passed"
    && COMMIT_ID.test(String(receipt.action_details?.commit?.after_sha || "")));
  const profileStories = new Map();
  const storiesOfProfile = (profileId) => {
    if (!profileStories.has(profileId)) {
      let ids = [];
      try {
        ids = (readDeliveryAutonomyProfile(context, profileId, { missingOk: true })?.story_refs || [])
          .map((ref) => ref?.id).filter(Boolean);
      } catch {
        ids = [];
      }
      profileStories.set(profileId, ids);
    }
    return profileStories.get(profileId);
  };
  for (const storyId of [...new Set((profile.story_refs || []).map((ref) => ref?.id).filter(Boolean))]) {
    const original = storyOriginalTaskStart(context, storyId);
    if (original.invalid || !original.receipt) continue;
    const startBase = taskStartGitBase(original.receipt);
    if (startBase.kind === "none") continue;
    const baseSha = startBase.kind === "commit" ? String(startBase.sha).toLowerCase() : null;
    // A start that is not an ancestor of HEAD is reported by the gates.
    if (baseSha && !gitCommandSucceeds(context.root, ["merge-base", "--is-ancestor", baseSha, headSha])) continue;
    const range = storyOwnCommitRange(context, { storyId, baseSha, headSha });
    if (!range) {
      findings.push({ story_id: storyId, commits: [], reasons: ["Git could not list the commits since the task start"], reset_target: baseSha });
      continue;
    }
    if (range.commits.length === 0) continue;
    const own = new Set();
    const otherDelivery = new Map();
    for (const receipt of receipts) {
      const sha = receipt.action_details.commit.after_sha.toLowerCase();
      if (storiesOfProfile(receipt.profile_ref?.id).includes(storyId)) own.add(sha);
      else otherDelivery.set(sha, receipt.profile_ref?.id || "unknown");
    }
    const onBase = new Set();
    for (const ref of baseBranchRefs(context, profile)) {
      const listed = execGitOutput(context.root, ["rev-list", ref, ...range.exclusions, "--"]);
      if (listed === null) continue;
      for (const sha of listed.split(/\r?\n/u)) if (sha.trim()) onBase.add(sha.trim());
    }
    const foreign = [];
    const reasons = [];
    const baseCommits = [];
    for (const sha of range.commits) {
      if (own.has(sha)) continue;
      if (otherDelivery.has(sha)) {
        foreign.push(sha);
        reasons.push(`${sha.slice(0, 12)} was committed by delivery ${otherDelivery.get(sha)}, which is not merged`);
      } else if (onBase.has(sha)) {
        foreign.push(sha);
        baseCommits.push(sha);
        reasons.push(`${sha.slice(0, 12)} is on ${profile.pull_request_target?.base_branch} but no merged delivery accounts for it`);
      }
    }
    if (foreign.length === 0) continue;
    findings.push({
      story_id: storyId,
      commits: foreign,
      base_commits: baseCommits,
      reasons,
      reset_target: latestAllowedPoint(context, baseSha, range.excluded_deliveries.map((item) => item.merge_commit_sha)),
    });
  }
  return findings;
}

/** A refusal message for foreign commits, naming what to do about them. */
export function foreignStoryBranchCommitMessage(action, findings) {
  return findings.map((finding) => {
    const target = finding.reset_target ? finding.reset_target.slice(0, 12) : "the task-start commit";
    const baseCommits = finding.base_commits || [];
    return `${action} refused: the branch of story ${finding.story_id} holds commits after its task start that are `
      + `neither its own nor part of a merged delivery: ${finding.reasons.join("; ")}. `
      + "Their files would be charged to this story's perimeter. Ways out: "
      + (baseCommits.length > 0
        ? `(1) a commit that belongs on the base branch can be accepted for this story by a person, from their own terminal: ${baseCommits.map((sha) => `'${baseAcknowledgeCommand(finding.story_id, sha)}'`).join(", ")}; `
          + "its files then stay out of the perimeter, and those inside the story's scope go through 'story overlap confirm' before the merge; "
        : "")
      + "(2) commits that only touch .sdlc/ records, and a commit followed by its exact revert, never block, so a change can also be undone with 'git revert'; "
      + `(3) if the story has no own commits on top of them yet, move the branch back with 'git reset --keep ${target}'; `
      + "(4) when another story was merged on GitHub outside the plugin, record it first with "
      + "'autonomy delivery reconcile --id <its delivery profile> --pr-url <its pull request>', then repeat.";
  }).join(" ");
}

function baseBranchRefs(context, profile) {
  const baseBranch = profile.pull_request_target?.base_branch;
  if (!baseBranch) return [];
  let remote = "origin";
  try {
    remote = orchestrationPolicy(context.config).coordination.remote || remote;
  } catch {
    // An invalid configuration is reported elsewhere.
  }
  return [`refs/remotes/${remote}/${baseBranch}`, `refs/heads/${baseBranch}`]
    .filter((ref) => execGit(context.root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]));
}

// The newest point the branch may stand on: the merged delivery commit that
// descends from every other candidate, or the task-start commit.
function latestAllowedPoint(context, baseSha, mergedShas) {
  const candidates = [...mergedShas, ...(baseSha ? [baseSha] : [])];
  return candidates.find((candidate) => candidates.every((other) =>
    other === candidate || gitCommandSucceeds(context.root, ["merge-base", "--is-ancestor", other, candidate])))
    || baseSha;
}
