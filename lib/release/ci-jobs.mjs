// Pure description of the CI jobs that make up one sharded cell (an operating
// system and a Node line whose suite runs as several parallel shards). The CI
// workflow builds the same names from its matrices, and unit tests keep the two
// in sync. Both the per-cell aggregator (scripts/verify-ci-shards.mjs) and the
// release gate (lib/release/ci-gate.mjs) judge a cell with these helpers.

// Platforms whose suite is split into shards. Linux runs the whole suite in
// one job per Node line and is not listed here.
export const SHARDED_PLATFORMS = Object.freeze(["macos-latest", "windows-latest"]);

// Number of shards per sharded cell; the workflow matrices and the aggregator
// arguments must agree with it.
export const CI_SHARD_TOTAL = 3;

// The shard step that actually runs the tests; it is skipped for
// documentation-only changes, which is how "the suite ran" is told apart.
export const SHARD_TEST_STEP = "Run this shard of the test suite";

// The shard-independent steps of the per-cell checks job. Each is skipped for
// documentation-only changes, like the test step of a shard.
export const CHECKS_STEPS = Object.freeze([
  "Check source syntax",
  "Verify bounded test-runner bootstrap",
  "Run the installation doctor",
  "Verify the package contents",
]);


export function isShardedPlatform(platform) {
  return SHARDED_PLATFORMS.includes(platform);
}


// Job name of one test shard.
export function shardJobName(platform, node, index, total) {
  return `test shard (${platform}, ${node}, ${index}/${total})`;
}


// Job name of the light job that runs the shard-independent checks once per
// operating system and Node line.
export function checksJobName(platform, node) {
  return `checks (${platform}, ${node})`;
}


// The latest attempt of every job name decides, so a re-run that fixed a flaky
// job counts while a stale green attempt never masks a newer failure.
export function latestJobsByName(jobs) {
  const latest = new Map();
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (job === null || typeof job !== "object" || typeof job.name !== "string") continue;
    const previous = latest.get(job.name);
    const rank = [Number(job.run_attempt ?? 0), Number(job.id ?? 0)];
    const previousRank = previous
      ? [Number(previous.run_attempt ?? 0), Number(previous.id ?? 0)]
      : [-1, -1];
    if (rank[0] > previousRank[0] || (rank[0] === previousRank[0] && rank[1] >= previousRank[1])) {
      latest.set(job.name, job);
    }
  }
  return latest;
}


export function ranStep(job, step) {
  return Array.isArray(job?.steps)
    && job.steps.some((candidate) => candidate?.name === step && candidate.conclusion === "success");
}


// Pure decision: every expected shard and the checks job of this
// platform/node must exist and have completed successfully in their latest
// attempt. With requireExecuted, each shard must also have run the test step
// and the checks job each of its steps to success. Anything else is unmet.
export function unmetShardedJobs(jobs, { platform, node, total, requireExecuted = false }) {
  const latest = latestJobsByName(jobs);
  const unmet = [];
  const expected = [
    ...Array.from({ length: total }, (_, offset) => [shardJobName(platform, node, offset + 1, total), [SHARD_TEST_STEP]]),
    [checksJobName(platform, node), CHECKS_STEPS],
  ];
  for (const [name, steps] of expected) {
    const job = latest.get(name);
    const ran = !requireExecuted || steps.every((step) => ranStep(job, step));
    if (!job || job.status !== "completed" || job.conclusion !== "success" || !ran) unmet.push(name);
  }
  return unmet;
}
