import path from "node:path";

import { fs } from "../runtime/host.mjs";
import { runGit } from "../engine/shared-refs.mjs";

/**
 * Freshest known progress of a claimed story. The base checkout only learns
 * of a story's progress when its records are published, while the claim and
 * the story branch move as the work goes on: every source is read, the most
 * recent one wins, and what disagrees is reported instead of hidden.
 */
const ENDED_STATUSES = new Set(["released", "abandoned", "cancelled", "closed", "completed", "done", "merged", "merged_externally", "superseded"]);
const CLOCK_SKEW_MS = 5 * 60_000;
const BASE_BRANCHES = new Set(["main", "master", "trunk", "develop"]);

function timeMs(value) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

/** Phase named by a claim's bound contract (`contract-<story>-<phase>`), at the claim time. */
export function claimContractPhase(claim) {
  const id = String(claim?.contract?.id ?? claim?.contractId ?? "");
  const prefix = `contract-${String(claim?.storyId ?? "").toLowerCase()}-`;
  if (!id || !id.toLowerCase().startsWith(prefix)) return null;
  const phase = id.slice(prefix.length).trim();
  return phase ? { phase, updatedAt: claim.claimedAt ?? null, source: { kind: "claim", ref: id } } : null;
}

/**
 * Pure choice among progress candidates
 *   { phase, status?, updatedAt, source: { kind: "base" | "branch" | "claim", ref } }.
 * Returns { phase, since, source, status, issues } where issues lists every
 * inconsistency found (codes are stable, `detail` is for display).
 */
export function resolveStoryProgress({ claim = null, candidates = [], branchState = null, nowMs = Date.now() } = {}) {
  const issues = [];
  const usable = [];
  for (const candidate of candidates.filter((item) => item && item.phase)) {
    const at = timeMs(candidate.updatedAt);
    if (at !== null && at > nowMs + CLOCK_SKEW_MS) {
      issues.push({ code: "future-timestamp", detail: `${candidate.source?.ref ?? candidate.source?.kind} is dated in the future (${candidate.updatedAt})` });
      continue;
    }
    usable.push({ ...candidate, at });
  }
  usable.sort((left, right) => (right.at ?? -Infinity) - (left.at ?? -Infinity));
  const chosen = usable[0] ?? null;

  // The record and its workflow instance on the same source must agree.
  const bySource = new Map();
  for (const item of usable) {
    const key = `${item.source?.kind}:${item.source?.ref}`;
    if (!bySource.has(key)) bySource.set(key, new Set());
    bySource.get(key).add(item.phase);
  }
  for (const [key, phases] of bySource) {
    if (phases.size > 1) issues.push({ code: "phase-mismatch", detail: `${key.split(":").slice(1).join(":")}: ${[...phases].join(" vs ")}` });
  }
  if (chosen && usable.some((item) => item !== chosen && item.source?.kind !== chosen.source?.kind && item.phase !== chosen.phase)) {
    const older = usable.find((item) => item.source?.kind !== chosen.source?.kind && item.phase !== chosen.phase);
    issues.push({ code: "source-behind", detail: `${older.source?.ref ?? older.source?.kind} still says ${older.phase}` });
  }

  const status = usable.find((item) => item.status)?.status ?? null;
  if (claim && status && ENDED_STATUSES.has(String(status).toLowerCase())) {
    issues.push({ code: "stale-claim", detail: `the story is ${status} but still claimed` });
  }
  if (claim?.expired) issues.push({ code: "claim-expired", detail: "the claim lease ended with no push or wait" });
  const waitUntil = timeMs(claim?.wait?.until);
  if (waitUntil !== null && waitUntil < nowMs) issues.push({ code: "working-marker-expired", detail: `declared wait ended ${claim.wait.until}` });
  if (branchState === "missing") issues.push({ code: "branch-missing", detail: `${claim?.branch} is not on the remote` });
  if (branchState === "merged") issues.push({ code: "branch-merged", detail: `${claim?.branch} is already merged into the base` });
  const claimedAt = timeMs(claim?.claimedAt);
  if (claimedAt !== null && claimedAt > nowMs + CLOCK_SKEW_MS) issues.push({ code: "future-timestamp", detail: `claim dated in the future (${claim.claimedAt})` });

  return {
    phase: chosen?.phase ?? null,
    since: chosen?.updatedAt ?? null,
    source: chosen?.source ?? null,
    status,
    issues,
  };
}

/**
 * One lifecycle status of a story, from the records that prove it rather than
 * from story.json (which keeps its planning status after close). Precedence:
 * closure (superseded/abandoned) > closed (passed final gate or terminal
 * workflow state) > merged (passed merge receipt) > pull request open >
 * in progress (task start, active claim, or any delivery receipt) > not started.
 * Returns { key, evidence } with key one of STORY_LIFECYCLE_KEYS.
 */
export const STORY_LIFECYCLE_KEYS = Object.freeze(["superseded", "abandoned", "closed", "merged", "prOpen", "inProgress", "notStarted"]);
export const WORKFLOW_TERMINAL_STATES = Object.freeze(new Set(["operations"]));
const ABANDON_EVENTS = new Set(["cancelled", "canceled", "abandoned", "abandon"]);

export function deriveStoryLifecycle({
  closureEvent = null,
  finalGatePassed = false,
  workflowState = null,
  workflowTerminal = false,
  deliveryState = null,
  taskStarted = false,
  claimed = false,
  receipts = 0,
  terminalStates = WORKFLOW_TERMINAL_STATES,
} = {}) {
  const event = String(closureEvent ?? "").toLowerCase();
  if (event === "superseded") return { key: "superseded", evidence: "closure" };
  if (ABANDON_EVENTS.has(event)) return { key: "abandoned", evidence: "closure" };
  if (finalGatePassed) return { key: "closed", evidence: "final-gate" };
  if (workflowTerminal || (workflowState && terminalStates.has(String(workflowState)))) {
    return { key: "closed", evidence: "workflow" };
  }
  if (deliveryState === "merged") return { key: "merged", evidence: "merge-receipt" };
  if (deliveryState === "open") return { key: "prOpen", evidence: "pull-request" };
  if (taskStarted) return { key: "inProgress", evidence: "task-start" };
  if (claimed) return { key: "inProgress", evidence: "claim" };
  if (receipts > 0) return { key: "inProgress", evidence: "receipt" };
  return { key: "notStarted", evidence: null };
}

function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseJson(text) {
  try {
    const parsed = JSON.parse(String(text ?? ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function lastTraceTime(text) {
  const lines = String(text ?? "").trim().split(/\r?\n/u).reverse();
  for (const line of lines) {
    const event = parseJson(line);
    const at = event?.created_at ?? event?.timestamp ?? event?.time ?? null;
    if (timeMs(at) !== null) return at;
  }
  return null;
}

/** Story record and workflow phase as one source (base checkout or a ref) holds them. */
function sourceCandidates(read, storyId, source) {
  const out = [];
  const story = parseJson(read(`.sdlc/stories/${storyId}/story.json`));
  const traced = lastTraceTime(read(`.sdlc/traces/${storyId}.jsonl`));
  if (story?.phase) {
    const updated = [story.updated_at, traced].filter((value) => timeMs(value) !== null)
      .sort((left, right) => timeMs(right) - timeMs(left))[0] ?? null;
    out.push({ phase: String(story.phase), status: story.status ?? null, updatedAt: updated, source });
  }
  const checkpoint = parseJson(read(`.sdlc/workflows/instances/DELIVERY-${storyId}/checkpoint.json`));
  if (checkpoint?.current_state) out.push({ phase: String(checkpoint.current_state), updatedAt: checkpoint.updated_at ?? null, source });
  return out;
}

/**
 * Every progress candidate for one claim: base checkout, the claim's remote
 * branch when it exists, and the claim's bound contract. Read-only git.
 */
export function readStoryProgress(projectRoot, claim, {
  remote = "origin",
  baseBranch = "main",
  nowMs = Date.now(),
  git = (args) => runGit(projectRoot, args, { timeoutSeconds: 5 }),
} = {}) {
  const storyId = String(claim?.storyId ?? "");
  if (!storyId) return resolveStoryProgress({ claim, nowMs });
  const local = (relative) => {
    try {
      return fs.readFileSync(path.join(projectRoot, relative), "utf8");
    } catch {
      return null;
    }
  };
  const candidates = sourceCandidates(local, storyId, { kind: "base", ref: "local base checkout" });
  let branchState = null;
  const branch = claim?.branch && !BASE_BRANCHES.has(claim.branch) ? String(claim.branch) : null;
  if (branch) {
    const ref = `refs/remotes/${remote}/${branch}`;
    if (!git(["rev-parse", "--verify", "--quiet", ref]).ok) {
      branchState = "missing";
    } else {
      const base = `refs/remotes/${remote}/${baseBranch}`;
      branchState = git(["merge-base", "--is-ancestor", ref, base]).ok ? "merged" : "present";
      const show = (relative) => {
        const shown = git(["show", `${ref}:${relative}`]);
        return shown.ok ? shown.stdout : null;
      };
      candidates.push(...sourceCandidates(show, storyId, { kind: "branch", ref: `${remote}/${branch}` }));
    }
  }
  const fromClaim = claimContractPhase(claim);
  if (fromClaim) candidates.push(fromClaim);
  return resolveStoryProgress({ claim, candidates, branchState, nowMs });
}

/** Readable channel identity of a claim holder, when the channel shows one. */
export function channelIdentityFor(claim, messages) {
  if (!Array.isArray(messages) || !claim) return null;
  const names = new Set([claim.agent, claim.who, claim.holder].filter(Boolean).map(String));
  const byName = messages.filter((message) => message?.from && [message.from, message.host, message.gh_login, message.agent].some((value) => value && names.has(String(value))));
  const byStory = messages.filter((message) => message?.from && message.story && String(message.story).toUpperCase() === String(claim.storyId).toUpperCase() && String(message.text ?? "").startsWith("[auto]"));
  const match = [...(byName.length ? byName : byStory)].sort((left, right) => (timeMs(right.time) ?? 0) - (timeMs(left.time) ?? 0))[0];
  if (!match) return null;
  return match.host && match.host !== match.from ? `${match.from} · ${match.host}` : String(match.from);
}
