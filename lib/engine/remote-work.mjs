import {
  listOpenPullRequests,
} from "../delivery/providers/github-cli.mjs";
import {
  groupRemoteWork,
} from "../remote-work.mjs";
import {
  Date,
  process,
} from "../runtime/host.mjs";
import {
  STATUS_SYNC_ENV,
} from "../status-sync.mjs";
import {
  orchestrationPolicy,
} from "../story-claim-shared-state.mjs";
import {
  remoteBaseRef,
} from "./merge-drift.mjs";
import {
  firstLine,
  gitFailure,
  isGitRepository,
  markRemoteUnreachable,
  runGit,
} from "./shared-refs.mjs";

const CANDIDATE_STATES = new Set(["available", "blocked"]);

function policyOf(context) {
  try {
    return orchestrationPolicy(context.config);
  } catch {
    return null;
  }
}

/**
 * Stories nobody holds: open (available or blocked), with no shared claim or
 * reservation and no active claim file that still counts.
 */
function unheldStories(orchestration) {
  return (orchestration?.stories || []).filter((story) => {
    if (!CANDIDATE_STATES.has(story.orchestration_state)) return false;
    if (story.shared_claim?.holder) return false;
    const localActive = String(story.claim?.status || "").toLowerCase() === "active";
    return !localActive || Boolean(story.shared_claim?.local_claim_outdated);
  });
}

/**
 * Remote branches and open pull requests that name a story nobody holds
 * (orchestration_policy.unclaimed_remote_work), read from the
 * remote-tracking branches as the last fetch left them, plus the provider
 * adapter when the project opted in. Read-only, never refuses: a provider
 * that cannot answer is reported as a note. Returns { checked, items, notes }.
 */
export function detectUnclaimedRemoteWork(context, orchestration, { nowMs = Date.now(), knownStoryIds = [] } = {}) {
  const policy = policyOf(context);
  if (!policy || policy.unclaimed_remote_work.mode === "off") return { checked: false, items: [], notes: [] };
  const candidates = unheldStories(orchestration);
  if (candidates.length === 0) return { checked: false, items: [], notes: [] };
  const remote = policy.coordination.remote;
  const timeoutSeconds = policy.coordination.timeout_seconds;
  if (isGitRepository(context, timeoutSeconds) !== true) return { checked: false, items: [], notes: [] };
  const git = (args) => runGit(context.root, args, { timeoutSeconds });
  const base = remoteBaseRef(context, remote, policy.merge_drift.base_branch, timeoutSeconds);
  const listed = git([
    "for-each-ref", "--format=%(refname)%09%(objectname)%09%(committerdate:iso-strict)", `refs/remotes/${remote}/`,
  ]);
  const prefix = `refs/remotes/${remote}/`;
  const candidateIds = candidates.map((story) => story.id);
  const knownIds = [...knownStoryIds, ...(orchestration?.stories || []).map((story) => story.id)];
  const branches = [];
  for (const line of listed.ok ? listed.stdout.split(/\r?\n/u).filter(Boolean) : []) {
    const [ref, sha, lastCommitAt] = line.split("\t");
    const branch = ref.slice(prefix.length);
    if (!branch || branch === "HEAD" || ref === base?.ref) continue;
    // Only branches that name some story cost a second git call.
    if (!candidateIds.some((id) => branch.toLowerCase().includes(id.toLowerCase()))) continue;
    const ahead = base ? Number(firstLine(git(["rev-list", "--count", `${base.ref}..${sha}`]).stdout)) : NaN;
    branches.push({
      branch,
      sha,
      last_commit_at: lastCommitAt || null,
      ahead_of_base: Number.isSafeInteger(ahead) ? ahead : null,
      base_branch: base?.branch || null,
    });
  }
  const notes = [];
  let pullRequests = [];
  if (policy.unclaimed_remote_work.pull_requests === "github-cli") {
    const read = listOpenPullRequests({ cwd: context.root });
    if (read.error) notes.push(`open pull requests could not be read through the GitHub CLI (${read.error})`);
    else pullRequests = read.pull_requests;
  }
  return {
    checked: true,
    items: groupRemoteWork(candidateIds, knownIds, {
      branches,
      pullRequests,
      nowMs,
      recentWithinSeconds: policy.unclaimed_remote_work.recent_within_seconds,
    }),
    notes,
  };
}

/**
 * Updates the remote-tracking branches (never the checkout) so story
 * availability sees what other computers pushed, unless status_sync is off
 * in the configuration or the environment. Returns { outcome, reason } or
 * null when nothing was attempted.
 */
export function fetchForRemoteWork(context, env = process.env) {
  const policy = policyOf(context);
  if (!policy) return null;
  const mode = String(env[STATUS_SYNC_ENV] || "").trim() || policy.status_sync.mode;
  if (mode === "off") return { outcome: "skipped", reason: "turned_off" };
  const timeoutSeconds = policy.coordination.timeout_seconds;
  if (isGitRepository(context, timeoutSeconds) !== true) return { outcome: "skipped", reason: "not_a_git_repository" };
  const remote = policy.coordination.remote;
  if (!runGit(context.root, ["remote", "get-url", remote], { timeoutSeconds }).ok) return { outcome: "skipped", reason: "no_remote" };
  const fetched = runGit(context.root, ["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", remote], { timeoutSeconds });
  if (fetched.ok) return { outcome: "fetched", reason: null };
  const reason = gitFailure(fetched);
  if (fetched.timedOut) markRemoteUnreachable(context, remote, reason);
  return { outcome: "failed", reason };
}
