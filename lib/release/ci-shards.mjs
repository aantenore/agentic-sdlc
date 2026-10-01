import { collectPages } from "./ci-gate.mjs";

const RUN_ID = /^[0-9]+$/u;

// The shard step that actually runs the tests; it is skipped for
// documentation-only changes, which is how "the suite ran" is told apart.
export const SHARD_TEST_STEP = "Run this shard of the test suite";


export class CiShardError extends Error {
  constructor(message) {
    super(message);
    this.name = "CiShardError";
  }
}


// Job name of one test shard; the CI workflow builds the same name from its
// matrix, and a unit test keeps the two in sync.
export function shardJobName(platform, node, index, total) {
  return `test shard (${platform}, ${node}, ${index}/${total})`;
}


// Pure decision: every expected shard of this platform/node must exist and have
// completed successfully in its latest attempt. With requireExecuted, each shard
// must also have run the test step to success. Anything else is unmet.
export function unmetShards(jobs, { platform, node, total, requireExecuted = false }) {
  const latest = new Map();
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (job === null || typeof job !== "object" || typeof job.name !== "string") continue;
    const previous = latest.get(job.name);
    if (!previous || Number(job.run_attempt ?? 0) >= Number(previous.run_attempt ?? 0)) {
      latest.set(job.name, job);
    }
  }
  const unmet = [];
  for (let index = 1; index <= total; index += 1) {
    const name = shardJobName(platform, node, index, total);
    const job = latest.get(name);
    const ran = !requireExecuted || (Array.isArray(job?.steps) && job.steps.some((step) => (
      step?.name === SHARD_TEST_STEP && step.conclusion === "success"
    )));
    if (!job || job.status !== "completed" || job.conclusion !== "success" || !ran) unmet.push(name);
  }
  return unmet;
}


export async function verifyShards({ fetchJson, repository, runId, platform, node, total, requireExecuted = false }) {
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u.test(repository ?? "")) {
    throw new CiShardError("repository must be owner/name");
  }
  if (!RUN_ID.test(String(runId ?? ""))) throw new CiShardError("run id must be numeric");
  if (!Number.isInteger(total) || total < 1) throw new CiShardError("shard total must be a positive integer");
  if (typeof platform !== "string" || platform === "" || typeof node !== "string" || node === "") {
    throw new CiShardError("platform and node are required");
  }
  const jobs = await collectPages(
    fetchJson,
    `/repos/${repository}/actions/runs/${runId}/jobs?filter=latest`,
    "jobs",
  );
  const unmet = unmetShards(jobs, { platform, node, total, requireExecuted });
  if (unmet.length > 0) {
    throw new CiShardError(`unsuccessful or missing test shards: ${unmet.join("; ")}`);
  }
  return { checked: total };
}
