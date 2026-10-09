// Which commits on a story's branch are the story's own work. Two stories may
// start from the same main; once the first one merges, the second branch can
// be fast-forwarded or rebased onto main to pick it up. The commits that came
// with that move belong to the merged delivery, not to the second story, so
// they are left out of its changed-path perimeter. A change the second story
// makes to a file the first one also touched is still its own commit and
// still counts.
import path from "node:path";
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
  safeReadDir,
} from "./storage.mjs";

const COMMIT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

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
      const state = currentDeliveryExecutionState(context, profile);
      if (state.lifecycle_status !== "terminal") continue;
      const sha = state.status === "merged"
        ? mergedCommitSha(context, state.close_receipt)
        : externalMergeEvidence(context, profile, state)?.merge_commit_sha;
      const commitSha = String(sha || "").toLowerCase();
      if (!COMMIT_ID.test(commitSha)) continue;
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
  return {
    commits: listed.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean),
    excluded_deliveries: excluded,
    exclusions,
  };
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
    for (const sha of range.commits) {
      if (own.has(sha)) continue;
      if (otherDelivery.has(sha)) {
        foreign.push(sha);
        reasons.push(`${sha.slice(0, 12)} was committed by delivery ${otherDelivery.get(sha)}, which is not merged`);
      } else if (onBase.has(sha)) {
        foreign.push(sha);
        reasons.push(`${sha.slice(0, 12)} is on ${profile.pull_request_target?.base_branch} but no merged delivery accounts for it`);
      }
    }
    if (foreign.length === 0) continue;
    findings.push({
      story_id: storyId,
      commits: foreign,
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
    return `${action} refused: the branch of story ${finding.story_id} holds commits after its task start that are `
      + `neither its own nor part of a merged delivery: ${finding.reasons.join("; ")}. `
      + "Their files would be charged to this story's perimeter. "
      + `If the story has no own commits on top of them yet, move the branch back with 'git reset --keep ${target}'. `
      + "Fast-forward or rebase the branch only onto the commits of deliveries that are merged; "
      + "when another story was merged on GitHub outside the plugin, record it first with "
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
