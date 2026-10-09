import path from "node:path";
import {
  storyBranchPatterns,
} from "../lifecycle/story.mjs";
import {
  findMergedStories,
  mergedBranchFromSubject,
} from "../merge-drift.mjs";
import {
  fs,
} from "../runtime/host.mjs";
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
  const skip = new Set(skipStoryIds.filter(Boolean));
  // The orchestration snapshot already ran the check: reuse it instead of reading git again.
  const known = orchestration?.merge_drift;
  if (known) return { ...known, items: known.items.filter((item) => !skip.has(item.story_id)) };
  return scanMergedOpenStories(context, orchestration, skip);
}

/**
 * True when this checkout has none of the records a story's work leaves (a
 * claim, a completed step): the work was merged from another computer whose
 * records never reached this branch.
 */
function storyWorkRecordsAbsent(context, storyId) {
  const storyDir = path.join(context.sdlcRoot, "stories", storyId);
  if (fs.existsSync(path.join(storyDir, "claim.json"))) return false;
  try {
    return fs.readdirSync(path.join(storyDir, "steps")).length === 0;
  } catch {
    return true;
  }
}

/** Who made a merged change and on which branch, read from the merge commit (its merged-in parent's author). */
function mergeOrigin(context, item, timeoutSeconds) {
  const parents = String(firstLine(runGit(context.root, ["rev-list", "--parents", "-n", "1", item.commit], { timeoutSeconds }).stdout) || "")
    .split(" ").filter(Boolean).slice(1);
  const authored = parents[1] || item.commit;
  const author = firstLine(runGit(context.root, ["log", "-1", "--format=%an", authored], { timeoutSeconds }).stdout) || null;
  return { author, branch: item.branch || mergedBranchFromSubject(item.subject) };
}

function scanMergedOpenStories(context, orchestration, skip) {
  let policy;
  try {
    policy = orchestrationPolicy(context.config);
  } catch {
    return { checked: false, base_branch: null, items: [] };
  }
  const drift = policy.merge_drift;
  if (drift.mode === "off") return { checked: false, base_branch: null, items: [] };
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
    phase: byId.get(item.story_id).progress_phase || byId.get(item.story_id).phase,
    ...(lifecycleBlocker(byId.get(item.story_id))),
    ...(storyWorkRecordsAbsent(context, item.story_id)
      ? { records_absent: true, merged_by: mergeOrigin(context, item, timeoutSeconds) }
      : {}),
  }));
  return { checked: true, base_branch: base.branch, items };
}

// A merged story whose records are blocked needs the cause of that block,
// not more lifecycle steps.
function lifecycleBlocker(story) {
  if (!story?.lifecycle_remedy) return {};
  const reasonBlocker = (story.blockers || [])[0] || null;
  return { lifecycle_blocker: reasonBlocker, lifecycle_remedy: story.lifecycle_remedy };
}

/** Status lines for stories already merged while their records show them open. */
export function mergedOpenStoryLines(items, { italian = false } = {}) {
  return items.map((item) => {
    const commit = `${item.commit.slice(0, 12)} "${item.subject}"`;
    if (item.records_absent) {
      const author = item.merged_by?.author;
      const branch = item.merged_by?.branch;
      const from = italian
        ? [author ? `dal computer di ${author}` : "dal computer che ha fatto il lavoro", branch ? `(branch ${branch})` : null].filter(Boolean).join(" ")
        : [author ? `from ${author}'s computer` : "from the computer that did the work", branch ? `(branch ${branch})` : null].filter(Boolean).join(" ");
      return italian
        ? `${item.story_id}: risulta già unita in ${item.base_branch} (${commit}) ma i record del suo lavoro non sono su questo branch: la pull request ha portato solo il codice. Non avviarla: recupera i record ${from} con story publish-records --id ${item.story_id}, eseguito lì.`
        : `${item.story_id}: appears merged into ${item.base_branch} (${commit}) but its work records are not on this branch: the pull request carried only the code. Do not start it: recover the records ${from} with story publish-records --id ${item.story_id}, run there.`;
    }
    if (item.lifecycle_remedy) {
      const remedy = italian ? item.lifecycle_remedy.it : item.lifecycle_remedy.en;
      return italian
        ? `${item.story_id}: risulta già unita in ${item.base_branch} (${commit}) ma i suoi record sono bloccati: ${item.lifecycle_blocker}. ${remedy}`
        : `${item.story_id}: appears merged into ${item.base_branch} (${commit}) but its records are blocked: ${item.lifecycle_blocker}. ${remedy}`;
    }
    return italian
      ? `${item.story_id}: risulta già unita in ${item.base_branch} (${commit}) ma il suo record è ancora "${item.state}" (${item.phase}). Registra i passi rimanenti con story complete-step fino alla chiusura; se esiste una consegna avviata, una persona la riconcilia con autonomy delivery reconcile.`
      : `${item.story_id}: appears merged into ${item.base_branch} (${commit}) but its record is still "${item.state}" (${item.phase}). Record its remaining steps with story complete-step until it closes; when a started delivery exists, a person acknowledges it with autonomy delivery reconcile.`;
  });
}
