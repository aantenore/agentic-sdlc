import path from "node:path";
import {
  fail,
} from "../cli/user-error.mjs";
import {
  getOptionString,
} from "../lifecycle/common.mjs";
import {
  STATUS_SYNC_ENV,
  STATUS_SYNC_MODES,
  parseAheadBehind,
} from "../status-sync.mjs";
import {
  orchestrationPolicy,
} from "../story-claim-shared-state.mjs";
import {
  firstLine,
  gitFailure,
  isGitRepository,
  markRemoteUnreachable,
  runGit,
} from "./shared-refs.mjs";
import {
  process,
} from "../runtime/host.mjs";

/**
 * Brings this clone up to date before status reads it, as
 * orchestration_policy.status_sync (or --sync) says: fetch updates only the
 * remote-tracking branches; pull also fast-forwards the current branch when
 * it is strictly behind its upstream and git can do so without touching
 * local changes. Nothing is ever merged, rebased, or forced, and a remote
 * that cannot be reached only turns into a warning: status then reports the
 * clone as it is. Returns null when the configuration cannot be read (status
 * reports that itself). AGENTIC_SDLC_STATUS_SYNC overrides the configured
 * mode for one environment (a CI job, a test run); --sync overrides both.
 */
export function syncProjectForStatus(context, options = {}, env = process.env) {
  let policy;
  try {
    policy = orchestrationPolicy(context.config);
  } catch {
    return null;
  }
  const requested = getOptionString(options, "sync");
  if (requested && !STATUS_SYNC_MODES.includes(requested)) {
    fail(`--sync must be one of ${STATUS_SYNC_MODES.join(", ")}.`);
  }
  const fromEnvironment = String(env[STATUS_SYNC_ENV] || "").trim();
  if (fromEnvironment && !STATUS_SYNC_MODES.includes(fromEnvironment)) {
    fail(`${STATUS_SYNC_ENV} must be one of ${STATUS_SYNC_MODES.join(", ")}.`);
  }
  const mode = requested || fromEnvironment || policy.status_sync.mode;
  const timeoutSeconds = policy.coordination.timeout_seconds;
  const result = {
    mode,
    outcome: "skipped",
    remote: null,
    branch: null,
    upstream: null,
    ahead: null,
    behind: null,
    pulled_commits: 0,
    records_behind: null,
    head_changed: false,
    reason: null,
  };
  if (mode === "off") return { ...result, reason: "turned_off" };
  if (isGitRepository(context, timeoutSeconds) !== true) return { ...result, reason: "not_a_git_repository" };
  const git = (args) => runGit(context.root, args, { timeoutSeconds });
  result.branch = firstLine(git(["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout) || null;
  // The branch's own remote when it tracks one, otherwise the coordination remote.
  const branchRemote = result.branch
    ? firstLine(git(["config", "--get", `branch.${result.branch}.remote`]).stdout)
    : "";
  result.remote = branchRemote && branchRemote !== "." ? branchRemote : policy.coordination.remote;
  if (!git(["remote", "get-url", result.remote]).ok) return { ...result, reason: "no_remote" };
  const fetched = git(["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", result.remote]);
  if (!fetched.ok) {
    const reason = gitFailure(fetched);
    if (fetched.timedOut) markRemoteUnreachable(context, result.remote, reason);
    return { ...result, outcome: "failed", reason };
  }
  result.outcome = "fetched";
  const upstream = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  if (!result.branch || !upstream.ok) return { ...result, reason: "no_upstream" };
  result.upstream = firstLine(upstream.stdout);
  const counts = parseAheadBehind(git(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]).stdout);
  if (!counts) return result;
  Object.assign(result, counts);
  if (counts.behind > 0) result.records_behind = changedProjectRecords(context, git);
  if (mode !== "pull" || counts.behind === 0) return result;
  if (counts.ahead > 0) return { ...result, reason: "diverged" };
  const before = firstLine(git(["rev-parse", "HEAD"]).stdout);
  const merged = git(["merge", "--ff-only", "--quiet", "@{upstream}"]);
  if (!merged.ok) return { ...result, reason: `not_fast_forwarded: ${gitFailure(merged)}` };
  const after = firstLine(git(["rev-parse", "HEAD"]).stdout);
  return {
    ...result,
    outcome: "pulled",
    pulled_commits: counts.behind,
    behind: 0,
    records_behind: 0,
    head_changed: before !== after,
  };
}

/**
 * How many project records (files under the .sdlc folder) the upstream
 * changed since this copy forked from it: the records status cannot see yet.
 * Null when git cannot tell.
 */
function changedProjectRecords(context, git) {
  const folder = (context.sdlcRoot ? path.relative(context.root, context.sdlcRoot).replace(/\\/gu, "/") : "") || ".sdlc";
  const listed = git(["diff", "--name-only", "--no-renames", "HEAD...@{upstream}", "--", folder]);
  if (!listed.ok) return null;
  return listed.stdout.split(/\r?\n/u).filter(Boolean).length;
}

/**
 * The line status puts next to its outcome when the counts it shows may be
 * out of date: the copy is behind its upstream, or the remote could not be
 * reached. Null when the copy is current (or sync is off).
 */
export function statusSyncAttentionLine(sync, { italian = false } = {}) {
  if (!sync || sync.outcome === "skipped") return null;
  if (sync.outcome === "failed") {
    return italian
      ? `Attenzione: il remote ${sync.remote} non è raggiungibile; i conteggi qui sotto riflettono solo questa copia locale.`
      : `Attention: the remote ${sync.remote} cannot be reached; the counts below reflect this local copy only.`;
  }
  if (!(sync.behind > 0)) return null;
  const records = sync.records_behind > 0
    ? (italian ? ` (${sync.records_behind} record del progetto cambiati lì)` : ` (${sync.records_behind} project record(s) changed there)`)
    : "";
  return italian
    ? `Attenzione: questa copia è indietro di ${sync.behind} commit rispetto a ${sync.upstream}${records}; i conteggi qui sotto potrebbero non essere aggiornati. Esegui git pull.`
    : `Attention: this copy is ${sync.behind} commit(s) behind ${sync.upstream}${records}; the counts below may be out of date. Run git pull.`;
}

/** The status line for a sync, or null when there is nothing to say. */
export function statusSyncLine(sync, { italian = false } = {}) {
  if (!sync || sync.outcome === "skipped") return null;
  const remote = sync.remote;
  if (sync.outcome === "failed") {
    return italian
      ? `Avviso: il remote ${remote} non è raggiungibile (${sync.reason}); lo stato mostra questa copia locale.`
      : `Warning: the remote ${remote} cannot be reached (${sync.reason}); status shows this local copy.`;
  }
  if (sync.outcome === "pulled") {
    return italian
      ? `Aggiornamento dal remote ${remote}: ${sync.branch} portato avanti di ${sync.pulled_commits} commit.`
      : `Updated from ${remote}: ${sync.branch} fast-forwarded by ${sync.pulled_commits} commit(s).`;
  }
  if (!sync.upstream) {
    return italian
      ? `Aggiornamento dal remote ${remote}: letto; il branch attuale non segue un branch remoto.`
      : `Updated from ${remote}: fetched; the current branch does not track a remote branch.`;
  }
  if (sync.behind > 0) {
    const why = sync.reason === "diverged"
      ? (italian ? " e ha anche commit locali non pubblicati" : " and also has unpublished local commits")
      : sync.reason?.startsWith("not_fast_forwarded")
        ? (italian ? "; l’avanzamento automatico non è riuscito" : "; it could not be fast-forwarded")
        : "";
    return italian
      ? `Aggiornamento dal remote ${remote}: ${sync.branch} è indietro di ${sync.behind} commit rispetto a ${sync.upstream}${why}. Esegui git pull per vederli.`
      : `Updated from ${remote}: ${sync.branch} is ${sync.behind} commit(s) behind ${sync.upstream}${why}. Run git pull to see them.`;
  }
  return italian
    ? `Aggiornamento dal remote ${remote}: ${sync.branch} è allineato con ${sync.upstream}.`
    : `Updated from ${remote}: ${sync.branch} is up to date with ${sync.upstream}.`;
}
