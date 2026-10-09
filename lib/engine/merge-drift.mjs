import path from "node:path";
import {
  storyBranchPatterns,
} from "../lifecycle/story.mjs";
import {
  findMergedStories,
} from "../merge-drift.mjs";
import {
  orchestrationPolicy,
} from "../story-claim-shared-state.mjs";
import {
  firstLine,
  runGit,
} from "./shared-refs.mjs";

const OPEN_STATES = new Set(["available", "claimed", "stale", "blocked"]);

/**
 * The remote base branch status compares stories with: the configured one,
 * otherwise the remote's default branch as the last fetch recorded it.
 * Null when this clone has no such remote-tracking branch.
 */
export function remoteBaseRef(context, remote, configured, timeoutSeconds) {
  const git = (args) => runGit(context.root, args, { timeoutSeconds });
  let branch = configured;
  if (!branch) {
    const head = firstLine(git(["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`]).stdout);
    branch = head.startsWith(`${remote}/`) ? head.slice(remote.length + 1) : null;
  }
  if (!branch) return null;
  const ref = `refs/remotes/${remote}/${branch}`;
  return git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).ok ? { ref, branch } : null;
}

/**
 * Open stories whose work is already on the remote base branch, read from
 * git only (orchestration_policy.merge_drift). Read-only: nothing is
 * fetched here (status_sync already did) and no record changes. Stories a
 * delivery-level check already reports (skipStoryIds) are left out.
 * Returns { checked, base_branch, items }.
 */
export function detectMergedOpenStories(context, orchestration, { skipStoryIds = [] } = {}) {
  let policy;
  try {
    policy = orchestrationPolicy(context.config);
  } catch {
    return { checked: false, base_branch: null, items: [] };
  }
  const drift = policy.merge_drift;
  if (drift.mode === "off") return { checked: false, base_branch: null, items: [] };
  const skip = new Set(skipStoryIds.filter(Boolean));
  const open = (orchestration?.stories || [])
    .filter((story) => OPEN_STATES.has(story.orchestration_state) && !skip.has(story.id));
  if (open.length === 0) return { checked: false, base_branch: null, items: [] };
  const remote = policy.coordination.remote;
  const timeoutSeconds = policy.coordination.timeout_seconds;
  const base = remoteBaseRef(context, remote, drift.base_branch, timeoutSeconds);
  if (!base) return { checked: false, base_branch: drift.base_branch, reason: "no_base_branch", items: [] };
  const sdlcFolder = (context.sdlcRoot ? path.relative(context.root, context.sdlcRoot).replace(/\\/gu, "/") : "") || ".sdlc";
  // Commits that changed only project records (a story created on main, say) never count as delivery.
  const listed = runGit(context.root, [
    "log", "--first-parent", `--max-count=${drift.max_commits_scanned}`, "--format=%H%x09%P%x09%s",
    base.ref, "--", ".", `:(exclude)${sdlcFolder}`,
  ], { timeoutSeconds });
  if (!listed.ok) return { checked: false, base_branch: base.branch, items: [] };
  const commits = listed.stdout.split(/\r?\n/u).filter(Boolean).map((line) => {
    const [sha, parents, ...subject] = line.split("\t");
    return { sha, parents: String(parents || "").split(" ").filter(Boolean), subject: subject.join("\t") };
  });
  const branchTips = new Map();
  for (const story of open) {
    const branches = new Set([
      ...storyBranchPatterns(context, story.id),
      ...[story.claim?.branch, story.shared_claim?.holder?.branch].filter(Boolean),
    ]);
    const tips = [];
    for (const branch of branches) {
      for (const ref of [`refs/remotes/${remote}/${branch}`, `refs/heads/${branch}`]) {
        const sha = firstLine(runGit(context.root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { timeoutSeconds }).stdout);
        if (sha) tips.push({ branch, sha });
      }
    }
    branchTips.set(story.id, tips);
  }
  const byId = new Map(open.map((story) => [story.id, story]));
  const items = findMergedStories(open.map((story) => story.id), commits, branchTips, {
    matchCommitSubject: drift.match_commit_subject,
  }).map((item) => ({
    ...item,
    base_branch: base.branch,
    state: byId.get(item.story_id).orchestration_state,
    phase: byId.get(item.story_id).phase,
  }));
  return { checked: true, base_branch: base.branch, items };
}

/** Status lines for stories already merged while their records show them open. */
export function mergedOpenStoryLines(items, { italian = false } = {}) {
  return items.map((item) => {
    const commit = `${item.commit.slice(0, 12)} "${item.subject}"`;
    return italian
      ? `${item.story_id}: risulta già unita in ${item.base_branch} (${commit}) ma il suo record è ancora "${item.state}" (${item.phase}). Registra i passi rimanenti con story complete-step fino alla chiusura; se esiste una consegna avviata, una persona la riconcilia con autonomy delivery reconcile.`
      : `${item.story_id}: appears merged into ${item.base_branch} (${commit}) but its record is still "${item.state}" (${item.phase}). Record its remaining steps with story complete-step until it closes; when a started delivery exists, a person acknowledges it with autonomy delivery reconcile.`;
  });
}
