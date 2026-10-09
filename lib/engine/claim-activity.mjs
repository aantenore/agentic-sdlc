import {
  orchestrationPolicy,
} from "../story-claim-shared-state.mjs";
import {
  Date,
} from "../runtime/host.mjs";
import {
  remoteBaseRef,
} from "./merge-drift.mjs";
import {
  firstLine,
  runGit,
} from "./shared-refs.mjs";

/**
 * The last sign of life of claims held on other computers, read from git
 * (orchestration_policy.claim_activity): the last commit on each claim's
 * branch as this clone last fetched it from the remote, and how many
 * commits it is ahead of the remote base branch. There is no heartbeat, so
 * a branch never pushed shows no activity. Read-only. Returns a Map from
 * story id to { branch_on_remote, last_commit_at, ahead_of_base, base_branch, idle }.
 */
export function claimActivityByStory(context, orchestration, { nowMs = Date.now() } = {}) {
  const found = new Map();
  let policy;
  try {
    policy = orchestrationPolicy(context.config);
  } catch {
    return found;
  }
  if (policy.claim_activity.mode === "off") return found;
  const held = (orchestration?.stories || [])
    .filter((story) => story.shared_claim?.holder && !story.shared_claim.here && story.shared_claim.holder.branch);
  if (held.length === 0) return found;
  const remote = policy.coordination.remote;
  const timeoutSeconds = policy.coordination.timeout_seconds;
  const git = (args) => runGit(context.root, args, { timeoutSeconds });
  const base = remoteBaseRef(context, remote, policy.merge_drift.base_branch, timeoutSeconds);
  const idleAfter = policy.claim_activity.idle_after_seconds;
  for (const story of held) {
    const branch = story.shared_claim.holder.branch;
    const ref = `refs/remotes/${remote}/${branch}`;
    const sha = firstLine(git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).stdout);
    if (!sha) {
      found.set(story.id, { branch_on_remote: false, last_commit_at: null, ahead_of_base: null, base_branch: base?.branch || null, idle: false });
      continue;
    }
    const lastCommitAt = firstLine(git(["log", "-1", "--format=%cI", sha]).stdout) || null;
    const ahead = base ? Number(firstLine(git(["rev-list", "--count", `${base.ref}..${sha}`]).stdout)) : NaN;
    const lastMs = Date.parse(String(lastCommitAt || ""));
    found.set(story.id, {
      branch_on_remote: true,
      last_commit_at: lastCommitAt,
      ahead_of_base: Number.isSafeInteger(ahead) ? ahead : null,
      base_branch: base?.branch || null,
      idle: idleAfter !== null && Number.isFinite(lastMs) && lastMs + idleAfter * 1000 < nowMs,
    });
  }
  return found;
}

/** " — last push 2026-10-09T12:00:00Z, 3 commit(s) ahead of main" style text, or "". */
export function claimActivityText(activity, { italian = false } = {}) {
  if (!activity) return "";
  if (!activity.branch_on_remote) {
    return italian ? "; branch non ancora sul remote" : "; branch not on the remote yet";
  }
  const ahead = activity.ahead_of_base !== null && activity.base_branch
    ? (italian ? `, ${activity.ahead_of_base} commit avanti a ${activity.base_branch}` : `, ${activity.ahead_of_base} commit(s) ahead of ${activity.base_branch}`)
    : "";
  const idle = activity.idle ? (italian ? " (inattiva)" : " (idle)") : "";
  return italian
    ? `; ultimo commit sul remote ${activity.last_commit_at}${ahead}${idle}`
    : `; last commit on the remote ${activity.last_commit_at}${ahead}${idle}`;
}
