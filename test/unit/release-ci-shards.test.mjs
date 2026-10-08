import assert from "node:assert/strict";
import test from "node:test";

import { CHECKS_STEPS, SHARDED_PLATFORMS } from "../../lib/release/ci-jobs.mjs";
import {
  CiShardError,
  SHARD_TEST_STEP,
  checksJobName,
  shardJobName,
  unmetShards,
  verifyShards,
} from "../../lib/release/ci-shards.mjs";


const CELL = { platform: "windows-latest", node: "24", total: 3 };


// The three shards of the cell plus its checks job, as the Actions API lists them.
function shardJobs(overrides = {}, node = "24", platform = "windows-latest") {
  const named = [
    ...[1, 2, 3].map((index) => [shardJobName(platform, node, index, 3), index, [SHARD_TEST_STEP]]),
    [checksJobName(platform, node), 4, CHECKS_STEPS],
  ];
  return named.map(([name, id, steps]) => ({
    id,
    name,
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    steps: steps.map((step) => ({ name: step, conclusion: "success" })),
    ...(overrides[name] ?? {}),
  }));
}


const CHECKS = checksJobName("windows-latest", "24");


test("shard and checks job names follow the workflow naming", () => {
  assert.equal(shardJobName("windows-latest", "24", 1, 3), "test shard (windows-latest, 24, 1/3)");
  assert.equal(shardJobName("macos-latest", "18.20.3", 3, 3), "test shard (macos-latest, 18.20.3, 3/3)");
  assert.equal(checksJobName("windows-latest", "24"), "checks (windows-latest, 24)");
  assert.equal(checksJobName("macos-latest", "24"), "checks (macos-latest, 24)");
});


test("all shards and the checks job green is accepted on every sharded platform", () => {
  assert.deepEqual(unmetShards(shardJobs(), CELL), []);
  for (const platform of SHARDED_PLATFORMS) {
    assert.deepEqual(unmetShards(shardJobs({}, "24", platform), { ...CELL, platform }), [], platform);
    assert.equal(unmetShards(shardJobs({}, "24", platform), { ...CELL, platform: "ubuntu-latest" }).length, 4);
  }
});


test("a failed, cancelled, skipped, unfinished, or missing shard is unmet", () => {
  const name = shardJobName("windows-latest", "24", 2, 3);
  for (const conclusion of ["failure", "cancelled", "skipped", null]) {
    assert.deepEqual(unmetShards(shardJobs({ [name]: { conclusion } }), CELL), [name], String(conclusion));
  }
  assert.deepEqual(unmetShards(shardJobs({ [name]: { status: "in_progress", conclusion: null } }), CELL), [name]);
  assert.deepEqual(unmetShards(shardJobs().filter((job) => job.name !== name), CELL), [name]);
  assert.equal(unmetShards([], CELL).length, 4);
  assert.equal(unmetShards(undefined, CELL).length, 4);
});


test("a failed, cancelled, skipped, unfinished, or missing checks job is unmet", () => {
  for (const conclusion of ["failure", "cancelled", "skipped", null]) {
    assert.deepEqual(unmetShards(shardJobs({ [CHECKS]: { conclusion } }), CELL), [CHECKS], String(conclusion));
  }
  assert.deepEqual(unmetShards(shardJobs({ [CHECKS]: { status: "in_progress", conclusion: null } }), CELL), [CHECKS]);
  assert.deepEqual(unmetShards(shardJobs().filter((job) => job.name !== CHECKS), CELL), [CHECKS]);
  // The checks job of another operating system or Node line does not stand in for this one.
  const elsewhere = shardJobs().map((job) => (job.name === CHECKS ? { ...job, name: checksJobName("macos-latest", "24") } : job));
  assert.deepEqual(unmetShards(elsewhere, CELL), [CHECKS]);
  const otherNode = shardJobs().map((job) => (job.name === CHECKS ? { ...job, name: checksJobName("windows-latest", "20.12.0") } : job));
  assert.deepEqual(unmetShards(otherNode, CELL), [CHECKS]);
});


test("with requireExecuted a shard that skipped its test step is unmet", () => {
  const name = shardJobName("windows-latest", "24", 2, 3);
  const skipped = shardJobs({ [name]: { steps: [{ name: SHARD_TEST_STEP, conclusion: "skipped" }] } });
  assert.deepEqual(unmetShards(skipped, CELL), [], "a documentation-only run still has green shards");
  assert.deepEqual(unmetShards(skipped, { ...CELL, requireExecuted: true }), [name]);
  assert.deepEqual(unmetShards(shardJobs({ [name]: { steps: undefined } }), { ...CELL, requireExecuted: true }), [name]);
  assert.deepEqual(unmetShards(shardJobs(), { ...CELL, requireExecuted: true }), []);
});


test("with requireExecuted a checks job that skipped any of its steps is unmet", () => {
  const strict = { ...CELL, requireExecuted: true };
  for (const skippedStep of CHECKS_STEPS) {
    const steps = CHECKS_STEPS.map((step) => ({ name: step, conclusion: step === skippedStep ? "skipped" : "success" }));
    assert.deepEqual(unmetShards(shardJobs({ [CHECKS]: { steps } }), CELL), [], `${skippedStep}: a documentation-only run is still green`);
    assert.deepEqual(unmetShards(shardJobs({ [CHECKS]: { steps } }), strict), [CHECKS], skippedStep);
  }
  assert.deepEqual(unmetShards(shardJobs({ [CHECKS]: { steps: [] } }), strict), [CHECKS]);
  assert.deepEqual(unmetShards(shardJobs({ [CHECKS]: { steps: undefined } }), strict), [CHECKS]);
  // The shard's test step does not stand in for the checks steps, nor the other way round.
  const swapped = shardJobs({ [CHECKS]: { steps: [{ name: SHARD_TEST_STEP, conclusion: "success" }] } });
  assert.deepEqual(unmetShards(swapped, strict), [CHECKS]);
});


test("shards of another Node line or platform do not satisfy this one", () => {
  assert.equal(unmetShards(shardJobs({}, "18.20.3"), CELL).length, 4);
  assert.equal(unmetShards(shardJobs({}, "24", "macos-latest"), CELL).length, 4);
  const mixed = [
    ...shardJobs({}, "18.20.3").map((job) => ({ ...job, conclusion: "failure" })),
    ...shardJobs({}, "24"),
  ];
  assert.deepEqual(unmetShards(mixed, CELL), [], "a red 18.20.3 shard must not fail Node 24");
  assert.equal(unmetShards(mixed, { ...CELL, node: "18.20.3" }).length, 4);
});


test("a missing shard is detected through the expected total, not the discovered jobs", () => {
  // None of the four "<i>/4" shards exist; the checks job of the cell is green.
  assert.equal(unmetShards(shardJobs(), { ...CELL, total: 4 }).length, 4);
});


test("the latest attempt of a shard decides", () => {
  const name = shardJobName("windows-latest", "24", 1, 3);
  const rerun = [...shardJobs({ [name]: { conclusion: "failure" } }), { ...shardJobs()[0], id: 50, run_attempt: 2 }];
  assert.deepEqual(unmetShards(rerun, CELL), []);
  const regressed = [...shardJobs(), { ...shardJobs()[0], id: 50, run_attempt: 2, conclusion: "failure" }];
  assert.deepEqual(unmetShards(regressed, CELL), [name]);
  const checksRerun = [
    ...shardJobs({ [CHECKS]: { conclusion: "failure" } }),
    { ...shardJobs()[3], id: 51, run_attempt: 2 },
  ];
  assert.deepEqual(unmetShards(checksRerun, CELL), []);
  const checksRegressed = [...shardJobs(), { ...shardJobs()[3], id: 51, run_attempt: 2, conclusion: "failure" }];
  assert.deepEqual(unmetShards(checksRegressed, CELL), [CHECKS]);
});


function api(jobs) {
  const calls = [];
  return {
    calls,
    fetchJson: async (route) => {
      calls.push(route);
      return { jobs: new URL(route, "https://api.invalid").searchParams.get("page") === "1" ? jobs : [] };
    },
  };
}


test("verifyShards queries the latest-attempt jobs of the current run and fails closed", async () => {
  const ok = api(shardJobs());
  await verifyShards({ fetchJson: ok.fetchJson, repository: "o/r", runId: "77", ...CELL });
  assert.match(ok.calls[0], /^\/repos\/o\/r\/actions\/runs\/77\/jobs\?filter=latest&per_page=100&page=1$/u);

  const name = shardJobName("windows-latest", "24", 3, 3);
  await assert.rejects(
    verifyShards({ fetchJson: api(shardJobs({ [name]: { conclusion: "failure" } })).fetchJson, repository: "o/r", runId: "77", ...CELL }),
    (error) => error instanceof CiShardError && error.message.includes(name),
  );
  await assert.rejects(
    verifyShards({ fetchJson: async () => { throw new Error("boom"); }, repository: "o/r", runId: "77", ...CELL }),
  );
  for (const bad of [
    { repository: "nope" },
    { runId: "abc" },
    { total: 0 },
    { total: Number.NaN },
    { node: "" },
  ]) {
    await assert.rejects(
      verifyShards({ fetchJson: ok.fetchJson, repository: "o/r", runId: "77", ...CELL, ...bad }),
      CiShardError,
      JSON.stringify(bad),
    );
  }
});
