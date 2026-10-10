import path from "node:path";
import { childProcess, fs } from "../runtime/host.mjs";
import { fail } from "../cli/user-error.mjs";
import { getOptionString, normalizeId, requireOption } from "../lifecycle/common.mjs";
import { humanGuidanceLocale } from "../lifecycle/guidance.mjs";
import { defaultStoryBranch } from "../lifecycle/story.mjs";
import { orchestrationPolicy } from "../story-claim-shared-state.mjs";
import { now } from "./common.mjs";
import { ensureInitialized } from "./migration.mjs";
import { output } from "./output.mjs";
import { runGit } from "./shared-refs.mjs";
import { readProjectJson, safeReadDir, writeJsonFile } from "./storage.mjs";
import { readDependencyGraph, readStory } from "./story.mjs";

// story prepare: while the dependency of a story is still open, prepare what
// does not need it (implementation contract, delivery profile, a worktree and
// branch cut from the current base) and record the preparation. Once the
// dependency merges, `story prepare --resolve` (run by watch and keep-going)
// realigns the worktree to the base, starts the task, claims the story and
// announces it. A dependency closed without a merge is announced and never
// starts anything.

export const PREPARED_START_SCHEMA = "prepared-start:v1";
export const PREPARED_START_DIRECTORY = "prepared-starts";
const GIT_TIMEOUT_SECONDS = 60;
const PR_URL = /^https?:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/pull\/\d+\/?$/u;
const CLOSED_WITHOUT_MERGE_STATUSES = new Set(["superseded", "cancelled", "canceled", "abandoned", "rejected"]);

export function preparedStartsRoot(context) {
  return path.join(context.sdlcRoot, PREPARED_START_DIRECTORY);
}

function preparedStartPath(context, storyId) {
  return path.join(preparedStartsRoot(context), `${storyId}.json`);
}

export function readPreparedStarts(context) {
  const records = [];
  for (const name of safeReadDir(preparedStartsRoot(context)).sort()) {
    if (!name.endsWith(".json")) continue;
    try {
      const record = readProjectJson(context, path.join(preparedStartsRoot(context), name));
      if (record?.schema === PREPARED_START_SCHEMA && record.story_id) records.push(record);
    } catch {
      // An unreadable record prepares nothing.
    }
  }
  return records;
}

/** `ST-ID` or a pull request URL -> { kind: "story"|"pr", target }. */
export function parseDependency(value) {
  const raw = String(value ?? "").trim();
  if (!raw) fail("story prepare needs --depends-on <story-id|pull-request-url>.");
  if (PR_URL.test(raw)) return { kind: "pr", target: raw.replace(/\/+$/u, "") };
  if (/^[a-z]+:\/\//iu.test(raw)) fail(`--depends-on ${raw} is not a pull request URL (https://host/owner/repo/pull/<n>).`);
  return { kind: "story", target: normalizeId(raw) };
}

function defaultGit(context) {
  return (args, cwd = context.root) => runGit(cwd, args, { timeoutSeconds: GIT_TIMEOUT_SECONDS });
}

function coordination(context) {
  try {
    const policy = orchestrationPolicy(context.config);
    return { remote: policy.coordination.remote || "origin", branch: policy.merge_drift.base_branch || null };
  } catch {
    return { remote: "origin", branch: null };
  }
}

/** The fetched base branch tip: { ref, sha } or null. */
export function resolveBase(context, git, { fetch = false } = {}) {
  const { remote, branch } = coordination(context);
  if (fetch) git(["fetch", "--quiet", remote]);
  let name = branch;
  if (!name) {
    const head = git(["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`]).stdout.trim();
    name = head.startsWith(`${remote}/`) ? head.slice(remote.length + 1) : "main";
  }
  const ref = `refs/remotes/${remote}/${name}`;
  const sha = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return sha.ok && sha.stdout.trim() ? { ref, sha: sha.stdout.trim(), remote, branch: name } : null;
}

/** Pull request state through gh: merged | closed | open | unknown. */
export function ghPullRequestState(url, { spawn = childProcess.spawnSync } = {}) {
  const result = spawn("gh", ["pr", "view", url, "--json", "state,mergedAt"], { encoding: "utf8", timeout: 30_000 });
  if (result.error || result.status !== 0) return "unknown";
  try {
    const data = JSON.parse(result.stdout);
    if (data.mergedAt || String(data.state).toUpperCase() === "MERGED") return "merged";
    if (String(data.state).toUpperCase() === "CLOSED") return "closed";
    if (String(data.state).toUpperCase() === "OPEN") return "open";
  } catch {
    // Unreadable answer: unknown.
  }
  return "unknown";
}

/** Where a dependency stands: merged | closed | open | unknown. */
export function dependencyState(context, dependency, { pullRequestState = ghPullRequestState } = {}) {
  if (dependency.kind === "pr") return pullRequestState(dependency.target);
  const story = readStory(context, dependency.target);
  if (!story) return "unknown";
  const status = String(story.status || "").toLowerCase();
  if (CLOSED_WITHOUT_MERGE_STATUSES.has(status)) return "closed";
  if (fs.existsSync(path.join(context.sdlcRoot, "stories", dependency.target, "closure.json"))) return "merged";
  return "open";
}

function defaultWorktreePath(context, storyId) {
  return path.join(path.dirname(context.root), `${path.basename(context.root)}-${storyId}`);
}

function stepResult(run) {
  try {
    const value = run();
    return { status: value?.skipped ? "skipped" : "done", ...(value?.detail ? { detail: value.detail } : {}) };
  } catch (error) {
    return { status: "pending", error: String(error?.message || error).split(/\r?\n/u)[0].slice(0, 300) };
  }
}

function contractExists(context, contractId) {
  return fs.existsSync(path.join(context.sdlcRoot, "contracts", `${contractId}.json`));
}

/**
 * story prepare --id <ST> --depends-on <ST|PR url>: prepares what does not
 * need the dependency and records it. Steps that cannot run (missing inputs,
 * refusals) stay `pending` in the record instead of failing the preparation.
 */
export function storyPrepare(context, options, deps = {}) {
  ensureInitialized(context);
  const git = deps.git || defaultGit(context);
  const id = normalizeId(requireOption(options, "id"));
  const dependency = parseDependency(requireOption(options, "depends-on"));
  if (dependency.kind === "story" && dependency.target === id) fail(`Story ${id} cannot depend on itself.`);
  if (!readStory(context, id)) fail(`Story ${id} does not exist. Create it with 'story create' first.`);
  if (dependency.kind === "story" && !readStory(context, dependency.target)) fail(`Dependency story ${dependency.target} does not exist.`);
  const existing = fs.existsSync(preparedStartPath(context, id)) ? readProjectJson(context, preparedStartPath(context, id)) : null;
  if (existing && existing.state === "started") fail(`Story ${id} was already started from its preparation.`);

  const branch = getOptionString(options, "branch") || defaultStoryBranch(context, id);
  const worktree = path.resolve(getOptionString(options, "worktree-path") || defaultWorktreePath(context, id));
  const steps = {};

  const contractId = `contract-${id}-implementation`;
  steps.contract = stepResult(() => {
    if (contractExists(context, contractId)) return { skipped: true, detail: contractId };
    (deps.createContract || (() => fail("contract creation is not available")))(context, { ...options, story: id, phase: "implementation", id: contractId });
    return { detail: contractId };
  });
  steps.delivery_profile = stepResult(() => {
    if (!options.level) return { skipped: true, detail: "no --level given: propose the delivery with 'autonomy delivery propose'" };
    (deps.proposeDelivery || (() => fail("delivery profile proposal is not available")))(context, {
      ...options, story: id, contract: contractId, id: options["profile-id"] || `AUT-PR-${id}`, delivery: options.delivery || `PR-${id}`, kind: "pull_request", head: branch,
    });
    return { detail: options["profile-id"] || `AUT-PR-${id}` };
  });

  let base = null;
  steps.worktree = stepResult(() => {
    base = resolveBase(context, git, { fetch: true });
    if (!base) fail("the remote base branch is unknown: fetch it, then prepare again");
    if (fs.existsSync(worktree)) return { skipped: true, detail: worktree };
    const hasBranch = git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).ok;
    const added = hasBranch ? git(["worktree", "add", worktree, branch]) : git(["worktree", "add", "-b", branch, worktree, base.ref]);
    if (!added.ok) fail(`git worktree add failed: ${String(added.stderr).trim().split(/\r?\n/u)[0]}`);
    return { detail: worktree };
  });

  const record = {
    schema: PREPARED_START_SCHEMA,
    story_id: id,
    depends_on: dependency,
    in_dependency_graph: dependency.kind === "story"
      && (readDependencyGraph(context, { missingOk: true })?.edges || []).some((edge) => edge.from === id && edge.to === dependency.target),
    branch,
    worktree,
    base_ref: base?.ref ?? null,
    base_sha: base?.sha ?? null,
    agent: getOptionString(options, "agent") || null,
    steps,
    state: "waiting",
    created_at: existing?.created_at || now(),
    updated_at: now(),
  };
  fs.mkdirSync(preparedStartsRoot(context), { recursive: true });
  writeJsonFile(preparedStartPath(context, id), record, { force: true });
  return record;
}

function realignWorktree(record, git) {
  const base = record.base_ref;
  if (!base || !fs.existsSync(record.worktree)) return { ok: false, reason: "worktree missing" };
  const rebased = git(["rebase", base], record.worktree);
  if (rebased.ok) return { ok: true };
  git(["rebase", "--abort"], record.worktree);
  return { ok: false, reason: `the worktree could not be realigned to ${base}: ${String(rebased.stderr).trim().split(/\r?\n/u)[0]}` };
}

function announceText(record, italian, kind) {
  const dep = record.depends_on.target;
  if (kind === "started") {
    return italian
      ? `${record.story_id} partita: ${dep} e' stata integrata, worktree riallineato a ${record.base_branch || "main"}, task start e claim eseguiti.`
      : `${record.story_id} started: ${dep} merged, worktree realigned to ${record.base_branch || "main"}, task start and claim done.`;
  }
  if (kind === "blocked") {
    return italian
      ? `${record.story_id} NON partita: ${record.blocked_reason}. Serve una decisione.`
      : `${record.story_id} did NOT start: ${record.blocked_reason}. A decision is needed.`;
  }
  return italian
    ? `${record.story_id} NON parte: ${dep} e' stata chiusa senza merge. Decidere se ripianificare o rilasciare la preparazione.`
    : `${record.story_id} will NOT start: ${dep} was closed without a merge. Decide whether to replan or drop the preparation.`;
}

/**
 * Looks at every waiting preparation: a merged dependency starts the story
 * (worktree realigned, task start, claim, announcement); one closed without a
 * merge is announced and never starts. Idempotent: a handled record is final.
 */
export function resolvePreparedStarts(context, options = {}, deps = {}) {
  ensureInitialized(context);
  const git = deps.git || defaultGit(context);
  const italian = humanGuidanceLocale(options) === "it";
  const only = options.id ? normalizeId(String(options.id)) : null;
  const results = [];
  for (const record of readPreparedStarts(context)) {
    if (record.state !== "waiting" || (only && record.story_id !== only)) continue;
    const state = dependencyState(context, record.depends_on, { pullRequestState: deps.pullRequestState || ghPullRequestState });
    const save = (patch) => {
      Object.assign(record, patch, { updated_at: now() });
      writeJsonFile(preparedStartPath(context, record.story_id), record, { force: true });
    };
    const announce = (kind) => {
      try {
        (deps.announce || (() => {}))({ story: record.story_id, kind: kind === "started" ? "info" : "question", text: announceText(record, italian, kind) });
      } catch {
        // The channel is optional; the record keeps the outcome.
      }
    };
    if (state === "closed") {
      save({ state: "dependency_closed", blocked_reason: `${record.depends_on.target} closed without a merge` });
      announce("closed");
      results.push({ story_id: record.story_id, outcome: "dependency_closed" });
      continue;
    }
    if (state !== "merged") {
      results.push({ story_id: record.story_id, outcome: state === "open" ? "waiting" : "unknown" });
      continue;
    }
    const base = resolveBase(context, git, { fetch: true });
    if (base) record.base_branch = base.branch;
    const block = (reason) => {
      save({ state: "start_blocked", blocked_reason: reason });
      announce("blocked");
      results.push({ story_id: record.story_id, outcome: "start_blocked", reason });
    };
    if (!base) { block("the remote base branch is unknown"); continue; }
    const aligned = realignWorktree({ ...record, base_ref: base.ref }, git);
    if (!aligned.ok) { block(aligned.reason); continue; }
    try {
      const agent = record.agent || options.agent || "agent";
      (deps.startTask || (() => fail("task start is not available")))(context, {
        "intent-json": JSON.stringify({
          requested_action: "implement_story", confidence: 0.95, referenced_entities: [{ type: "story", id: record.story_id }],
          provided_artifacts: [], missing_context: [], proposed_phase: "implementation", artifact_type: null, skip_phases: [],
        }),
        story: record.story_id, phase: "implementation", "contract-id": `contract-${record.story_id}-implementation`,
        ...(record.steps?.delivery_profile?.status === "done" ? { "delivery-profile": record.steps.delivery_profile.detail } : {}),
        "confirm-start": true, ...(options.actor ? { actor: options.actor } : {}), ...(options["actor-type"] ? { "actor-type": options["actor-type"] } : {}),
      });
      (deps.claimStory || (() => fail("story claim is not available")))(context, { id: record.story_id, agent, branch: record.branch });
    } catch (error) {
      block(String(error?.message || error).split(/\r?\n/u)[0].slice(0, 300));
      continue;
    }
    save({ state: "started", started_at: now(), base_sha: base.sha });
    announce("started");
    results.push({ story_id: record.story_id, outcome: "started" });
  }
  return results;
}

/** CLI entry for `story prepare` (with --resolve: only look at the waiting preparations). */
export function storyPrepareCommand(context, options, deps = {}) {
  if (options.resolve === true) {
    const results = resolvePreparedStarts(context, options, deps);
    output(options, { status: "resolved", results }, results.length === 0
      ? ["No waiting preparation changed."]
      : results.map((item) => `${item.story_id}: ${item.outcome}${item.reason ? ` (${item.reason})` : ""}`));
    return results;
  }
  const record = storyPrepare(context, options, deps);
  const pending = Object.entries(record.steps).filter(([, step]) => step.status === "pending").map(([name, step]) => `${name}: ${step.error}`);
  output(options, { status: "prepared", prepared_start: record }, [
    `Prepared ${record.story_id}, waiting for ${record.depends_on.kind === "pr" ? "pull request" : "story"} ${record.depends_on.target}.`,
    `Branch ${record.branch} in ${record.worktree}.`,
    ...pending.map((line) => `Still to do - ${line}`),
  ]);
  return record;
}
