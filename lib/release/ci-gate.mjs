import { Date } from "../runtime/host.mjs";
import {
  CI_SHARD_TOTAL,
  SHARDED_PLATFORMS,
  isShardedPlatform,
  latestJobsByName,
  ranStep,
  unmetShardedJobs,
} from "./ci-jobs.mjs";

const SOURCE_SHA = /^[0-9a-f]{40}$/u;
const REPOSITORY = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u;
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

// The release proves that the tagged commit already passed the CI run that
// every push to main gets instead of re-running it. The cells below must stay
// aligned with the push matrix declared in .github/workflows/ci.yml (a unit
// test enforces that): every supported Node line on Linux, plus the current
// Node on macOS and Windows. The macOS and Windows cells are aggregator jobs
// that only pass when every test shard and the checks job of that Node line
// passed; the gate also looks at those shard and checks jobs itself.
export const CI_GATE_POLICY = Object.freeze({
  workflowFile: "ci.yml",
  event: "push",
  branch: "main",
  cells: Object.freeze([
    Object.freeze({ platform: "ubuntu-latest", node: "18.20.3" }),
    Object.freeze({ platform: "ubuntu-latest", node: "20.12.0" }),
    Object.freeze({ platform: "ubuntu-latest", node: "21.6.0" }),
    Object.freeze({ platform: "ubuntu-latest", node: "24" }),
    Object.freeze({ platform: "macos-latest", node: "24" }),
    Object.freeze({ platform: "windows-latest", node: "24" }),
  ]),
  jobName: (platform, node) => `test (${platform}, ${node})`,
  // A job that succeeded only counts when its step proving the suite ran also
  // succeeded. Documentation-only changes skip that step (and the job still
  // reports success), so such a run can never release a tag on its own.
  executedStep: (platform) => (
    isShardedPlatform(platform) ? "Confirm every shard ran the test suite" : "Run the test suite"
  ),
  // Platforms whose cell is an aggregator over this many test shards plus a
  // checks job. Each of those jobs must have succeeded and run its steps too.
  shardedPlatforms: SHARDED_PLATFORMS,
  shards: CI_SHARD_TOTAL,
  // A CI run that exists but has not finished is awaited up to this long.
  pendingTimeoutMs: 60 * 60 * 1000,
  // A tagged commit with no CI run at all gets only a short grace period for
  // the run to be registered; after that it was never pushed to main.
  missingRunTimeoutMs: 3 * 60 * 1000,
  pollIntervalMs: 30 * 1000,
  maxConsecutiveApiErrors: 3,
});


export class CiGateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CiGateError";
    this.code = code;
  }
}


export function requiredCiJobNames(policy = CI_GATE_POLICY) {
  return policy.cells.map(({ platform, node }) => policy.jobName(platform, node));
}


function isCandidateRun(run, sha, policy) {
  return run !== null
    && typeof run === "object"
    && run.head_sha === sha
    && run.event === policy.event
    && run.head_branch === policy.branch;
}


export function unmetCells(jobs, policy = CI_GATE_POLICY) {
  const latest = latestJobsByName(jobs);
  const unmet = [];
  for (const { platform, node } of policy.cells) {
    const name = policy.jobName(platform, node);
    const job = latest.get(name);
    if (!job || job.status !== "completed" || job.conclusion !== "success") {
      unmet.push(name);
    } else if (!ranStep(job, policy.executedStep(platform))) {
      unmet.push(`${name} (the test suite did not run, e.g. a documentation-only change)`);
    }
    // An aggregator is only as good as the jobs behind it: a missing or red
    // shard, or a checks job that did not run, fails the cell even if the
    // aggregator itself reported success.
    if (policy.shardedPlatforms.includes(platform)) {
      for (const member of unmetShardedJobs(jobs, { platform, node, total: policy.shards, requireExecuted: true })) {
        unmet.push(`${member} (part of ${name})`);
      }
    }
  }
  return unmet;
}


// Pure decision over already-fetched data: "passed" only when one push run of
// the CI workflow for exactly this commit succeeded and holds every required
// matrix cell as a successful job. "pending" means the answer may still change.
export function evaluateCiGate({ runs, jobsByRunId, sha, policy = CI_GATE_POLICY }) {
  if (!SOURCE_SHA.test(sha ?? "")) {
    throw new CiGateError("INVALID_SHA", "the tagged commit is not a full 40-character SHA");
  }
  const candidates = (Array.isArray(runs) ? runs : []).filter((run) => isCandidateRun(run, sha, policy));
  if (candidates.length === 0) {
    return { state: "missing", reason: `no ${policy.event} CI run on ${policy.branch} exists for ${sha}` };
  }
  const reasons = [];
  let pending = false;
  for (const run of candidates) {
    if (run.status !== "completed") {
      pending = true;
      continue;
    }
    if (run.conclusion !== "success") {
      reasons.push(`run ${run.id} concluded ${run.conclusion}`);
      continue;
    }
    const unmet = unmetCells(jobsByRunId?.get(run.id) ?? [], policy);
    if (unmet.length === 0) {
      return { state: "passed", runId: run.id, reason: `run ${run.id} passed every required cell` };
    }
    reasons.push(`run ${run.id} lacks successful cells: ${unmet.join("; ")}`);
  }
  if (pending) return { state: "pending", reason: "a CI run for this commit has not finished" };
  return { state: "failed", reason: reasons.join(" | ") };
}


export function createGithubJsonFetcher({
  apiUrl = "https://api.github.com",
  token,
  fetchImpl = globalThis.fetch,
}) {
  if (typeof token !== "string" || token.length === 0) {
    throw new CiGateError("TOKEN_REQUIRED", "a GitHub token is required to query CI runs");
  }
  if (typeof fetchImpl !== "function") {
    throw new CiGateError("FETCH_UNAVAILABLE", "no fetch implementation is available");
  }
  return async function fetchJson(pathAndQuery) {
    const route = pathAndQuery.split("?")[0];
    let response;
    try {
      response = await fetchImpl(`${apiUrl}${pathAndQuery}`, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
    } catch {
      throw new CiGateError("API_ERROR", `GitHub API ${route} is unreachable`);
    }
    if (!response.ok) {
      throw new CiGateError("API_ERROR", `GitHub API ${route} answered ${response.status}`);
    }
    try {
      return await response.json();
    } catch {
      throw new CiGateError("API_ERROR", `GitHub API ${route} returned invalid JSON`);
    }
  };
}


export async function collectPages(fetchJson, basePath, listKey) {
  const items = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const body = await fetchJson(`${basePath}${basePath.includes("?") ? "&" : "?"}per_page=${PAGE_SIZE}&page=${page}`);
    const batch = body?.[listKey];
    if (!Array.isArray(batch)) {
      throw new CiGateError("API_SHAPE", `GitHub API response lacks ${listKey}`);
    }
    items.push(...batch);
    if (batch.length < PAGE_SIZE) return items;
  }
  throw new CiGateError("API_SHAPE", `GitHub API listing exceeded ${MAX_PAGES} pages`);
}


export async function checkCiGateOnce({ fetchJson, repository, sha, policy = CI_GATE_POLICY }) {
  if (!REPOSITORY.test(repository ?? "")) {
    throw new CiGateError("INVALID_REPOSITORY", "repository must be owner/name");
  }
  const runs = await collectPages(
    fetchJson,
    `/repos/${repository}/actions/workflows/${policy.workflowFile}/runs?head_sha=${sha}&event=${policy.event}`,
    "workflow_runs",
  );
  const jobsByRunId = new Map();
  for (const run of runs) {
    if (isCandidateRun(run, sha, policy) && run.status === "completed" && run.conclusion === "success") {
      jobsByRunId.set(
        run.id,
        await collectPages(fetchJson, `/repos/${repository}/actions/runs/${run.id}/jobs?filter=all`, "jobs"),
      );
    }
  }
  return evaluateCiGate({ runs, jobsByRunId, sha, policy });
}


// Fails closed: anything other than a proven pass (no run, failed run, missing
// cells, repeated API errors, or a run still unfinished after the deadline)
// throws. Only unfinished or not-yet-registered runs are awaited.
export async function waitForCiGate({
  fetchJson,
  repository,
  sha,
  policy = CI_GATE_POLICY,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  log = () => {},
}) {
  const startedAt = now();
  let consecutiveErrors = 0;
  for (;;) {
    let verdict;
    try {
      verdict = await checkCiGateOnce({ fetchJson, repository, sha, policy });
      consecutiveErrors = 0;
    } catch (error) {
      if (!(error instanceof CiGateError) || error.code !== "API_ERROR") throw error;
      consecutiveErrors += 1;
      if (consecutiveErrors >= policy.maxConsecutiveApiErrors) throw error;
      log(`transient API error (${consecutiveErrors}/${policy.maxConsecutiveApiErrors}): ${error.message}`);
      await sleep(policy.pollIntervalMs);
      continue;
    }
    if (verdict.state === "passed") return verdict;
    if (verdict.state === "failed") {
      throw new CiGateError("CI_NOT_PASSED", verdict.reason);
    }
    const waited = now() - startedAt;
    const limit = verdict.state === "missing" ? policy.missingRunTimeoutMs : policy.pendingTimeoutMs;
    if (waited >= limit) {
      throw new CiGateError(
        verdict.state === "missing" ? "CI_RUN_MISSING" : "CI_TIMEOUT",
        `${verdict.reason} (waited ${Math.round(waited / 1000)}s)`,
      );
    }
    log(`${verdict.state}: ${verdict.reason}; retrying`);
    await sleep(policy.pollIntervalMs);
  }
}
