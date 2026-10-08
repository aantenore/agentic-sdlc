import { collectPages } from "./ci-gate.mjs";
import { SHARD_TEST_STEP, checksJobName, shardJobName, unmetShardedJobs } from "./ci-jobs.mjs";

const RUN_ID = /^[0-9]+$/u;

export class CiShardError extends Error {
  constructor(message) {
    super(message);
    this.name = "CiShardError";
  }
}


// The job naming and the pure decision live in ci-jobs.mjs so the release gate
// can apply the very same rules. A sharded cell is its test shards plus its
// light checks job; the cell is unmet unless every one of them succeeded.
export { SHARD_TEST_STEP, checksJobName, shardJobName, unmetShardedJobs as unmetShards };


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
  const unmet = unmetShardedJobs(jobs, { platform, node, total, requireExecuted });
  if (unmet.length > 0) {
    throw new CiShardError(`unsuccessful or missing test jobs: ${unmet.join("; ")}`);
  }
  return { checked: total };
}
