import assert from "node:assert/strict";
import test from "node:test";

import {
  CiShardError,
  SHARD_TEST_STEP,
  shardJobName,
  unmetShards,
  verifyShards,
} from "../../lib/release/ci-shards.mjs";


const CELL = { platform: "windows-latest", node: "24", total: 3 };


function shardJobs(overrides = {}, node = "24") {
  return [1, 2, 3].map((index) => {
    const name = shardJobName("windows-latest", node, index, 3);
    return {
      id: index,
      name,
      run_attempt: 1,
      status: "completed",
      conclusion: "success",
      steps: [{ name: SHARD_TEST_STEP, conclusion: "success" }],
      ...(overrides[name] ?? {}),
    };
  });
}


test("shard job names follow the workflow naming", () => {
  assert.equal(shardJobName("windows-latest", "24", 1, 3), "test shard (windows-latest, 24, 1/3)");
});


test("all shards green is accepted", () => {
  assert.deepEqual(unmetShards(shardJobs(), CELL), []);
});


test("a failed, cancelled, skipped, unfinished, or missing shard is unmet", () => {
  const name = shardJobName("windows-latest", "24", 2, 3);
  for (const conclusion of ["failure", "cancelled", "skipped", null]) {
    assert.deepEqual(unmetShards(shardJobs({ [name]: { conclusion } }), CELL), [name], String(conclusion));
  }
  assert.deepEqual(unmetShards(shardJobs({ [name]: { status: "in_progress", conclusion: null } }), CELL), [name]);
  assert.deepEqual(unmetShards(shardJobs().filter((job) => job.name !== name), CELL), [name]);
  assert.equal(unmetShards([], CELL).length, 3);
  assert.equal(unmetShards(undefined, CELL).length, 3);
});


test("with requireExecuted a shard that skipped its test step is unmet", () => {
  const name = shardJobName("windows-latest", "24", 2, 3);
  const skipped = shardJobs({ [name]: { steps: [{ name: SHARD_TEST_STEP, conclusion: "skipped" }] } });
  assert.deepEqual(unmetShards(skipped, CELL), [], "a documentation-only run still has green shards");
  assert.deepEqual(unmetShards(skipped, { ...CELL, requireExecuted: true }), [name]);
  assert.deepEqual(unmetShards(shardJobs({ [name]: { steps: undefined } }), { ...CELL, requireExecuted: true }), [name]);
  assert.deepEqual(unmetShards(shardJobs(), { ...CELL, requireExecuted: true }), []);
});


test("shards of another Node line do not satisfy this one", () => {
  assert.equal(unmetShards(shardJobs({}, "18.20.3"), CELL).length, 3);
  const mixed = [
    ...shardJobs({}, "18.20.3").map((job) => ({ ...job, conclusion: "failure" })),
    ...shardJobs({}, "24"),
  ];
  assert.deepEqual(unmetShards(mixed, CELL), [], "a red 18.20.3 shard must not fail Node 24");
  assert.equal(unmetShards(mixed, { ...CELL, node: "18.20.3" }).length, 3);
});


test("a missing shard is detected through the expected total, not the discovered jobs", () => {
  assert.equal(unmetShards(shardJobs(), { ...CELL, total: 4 }).length, 4);
});


test("the latest attempt of a shard decides", () => {
  const name = shardJobName("windows-latest", "24", 1, 3);
  const rerun = [...shardJobs({ [name]: { conclusion: "failure" } }), { ...shardJobs()[0], id: 50, run_attempt: 2 }];
  assert.deepEqual(unmetShards(rerun, CELL), []);
  const regressed = [...shardJobs(), { ...shardJobs()[0], id: 50, run_attempt: 2, conclusion: "failure" }];
  assert.deepEqual(unmetShards(regressed, CELL), [name]);
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
