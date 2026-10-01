import assert from "node:assert/strict";
import test from "node:test";

import {
  CI_GATE_POLICY,
  CiGateError,
  checkCiGateOnce,
  createGithubJsonFetcher,
  evaluateCiGate,
  requiredCiJobNames,
  unmetCells,
  waitForCiGate,
} from "../../lib/release/ci-gate.mjs";


const SHA = "a".repeat(40);
const REPOSITORY = "aantenore/agentic-sdlc";
const FAST = Object.freeze({
  ...CI_GATE_POLICY,
  pollIntervalMs: 10,
  pendingTimeoutMs: 100,
  missingRunTimeoutMs: 30,
});


function run(overrides = {}) {
  return {
    id: 1,
    head_sha: SHA,
    head_branch: "main",
    event: "push",
    status: "completed",
    conclusion: "success",
    ...overrides,
  };
}


function jobs(overrides = {}, attempt = 1) {
  return requiredCiJobNames().map((name, index) => ({
    id: 100 + index,
    name,
    run_attempt: attempt,
    status: "completed",
    conclusion: "success",
    ...(overrides[name] ?? {}),
  }));
}


function evaluate(runs, jobsByRun = new Map([[1, jobs()]])) {
  return evaluateCiGate({ runs, jobsByRunId: jobsByRun, sha: SHA });
}


test("the gate requires the twelve full-matrix cells", () => {
  assert.equal(requiredCiJobNames().length, 12);
  assert.deepEqual(unmetCells(jobs()), []);
  assert.ok(requiredCiJobNames().includes("test (macos-latest, 18.20.3)"));
  assert.ok(requiredCiJobNames().includes("test (windows-latest, 24)"));
});


test("a successful push run with every cell passes", () => {
  assert.deepEqual(
    { state: evaluate([run()]).state, runId: evaluate([run()]).runId },
    { state: "passed", runId: 1 },
  );
});


test("no run for the commit is missing, not passed", () => {
  assert.equal(evaluate([]).state, "missing");
  for (const stray of [
    run({ head_sha: "b".repeat(40) }),
    run({ event: "pull_request" }),
    run({ event: "workflow_dispatch" }),
    run({ event: "schedule" }),
    run({ head_branch: "feature" }),
  ]) {
    assert.equal(evaluate([stray]).state, "missing", JSON.stringify(stray));
  }
});


test("failed, cancelled, and skipped conclusions fail closed", () => {
  for (const conclusion of ["failure", "cancelled", "skipped", "timed_out", "neutral", null]) {
    const verdict = evaluate([run({ conclusion })]);
    assert.equal(verdict.state, "failed", String(conclusion));
  }
});


test("an unfinished run is pending", () => {
  for (const status of ["queued", "in_progress", "waiting", "requested"]) {
    assert.equal(evaluate([run({ status, conclusion: null })]).state, "pending", status);
  }
});


test("a successful run missing a cell or holding a non-success cell fails", () => {
  const withoutCell = jobs().filter((job) => job.name !== "test (windows-latest, 21.6.0)");
  const missing = evaluate([run()], new Map([[1, withoutCell]]));
  assert.equal(missing.state, "failed");
  assert.match(missing.reason, /windows-latest, 21\.6\.0/u);

  for (const conclusion of ["failure", "cancelled", "skipped", null]) {
    const verdict = evaluate([run()], new Map([[1, jobs({
      "test (ubuntu-latest, 20.12.0)": { conclusion },
    })]]));
    assert.equal(verdict.state, "failed", String(conclusion));
  }
  const unfinished = evaluate([run()], new Map([[1, jobs({
    "test (macos-latest, 24)": { status: "in_progress", conclusion: null },
  })]]));
  assert.equal(unfinished.state, "failed");

  const reducedPullRequestMatrix = jobs().filter((job) => /, 24\)$|ubuntu-latest, 18\.20\.3/u.test(job.name));
  assert.equal(
    evaluate([run()], new Map([[1, reducedPullRequestMatrix]])).state,
    "failed",
    "a run with only the pull-request cells is not enough to release",
  );
});


test("only the latest attempt of a cell decides", () => {
  const name = "test (macos-latest, 18.20.3)";
  const recovered = [
    ...jobs({ [name]: { conclusion: "failure" } }, 1),
    { ...jobs()[0], name, id: 999, run_attempt: 2 },
  ];
  assert.equal(evaluate([run()], new Map([[1, recovered]])).state, "passed");
  const regressed = [
    ...jobs({}, 1),
    { ...jobs()[0], name, id: 999, run_attempt: 2, conclusion: "failure" },
  ];
  assert.equal(evaluate([run()], new Map([[1, regressed]])).state, "failed");
});


test("one fully green run is enough even if another run for the commit failed", () => {
  const verdict = evaluate(
    [run({ id: 2, conclusion: "failure" }), run({ id: 1 })],
    new Map([[1, jobs()]]),
  );
  assert.equal(verdict.state, "passed");
  assert.equal(verdict.runId, 1);
});


test("a malformed commit SHA is rejected", () => {
  assert.throws(
    () => evaluateCiGate({ runs: [], jobsByRunId: new Map(), sha: "v1.2.3" }),
    (error) => error instanceof CiGateError && error.code === "INVALID_SHA",
  );
});


function fakeApi({ runs, jobsByRun = {}, failures = [] }) {
  const calls = [];
  const queue = [...failures];
  const fetchJson = async (route) => {
    calls.push(route);
    if (queue.length > 0) {
      const next = queue.shift();
      if (next) throw new CiGateError("API_ERROR", "boom");
    }
    const query = new URL(route, "https://api.invalid").searchParams;
    if (route.includes("/actions/workflows/ci.yml/runs")) {
      return { workflow_runs: query.get("page") === "1" ? runs() : [] };
    }
    const runId = /\/actions\/runs\/(\d+)\/jobs/u.exec(route)?.[1];
    return { jobs: query.get("page") === "1" ? (jobsByRun[runId] ?? []) : [] };
  };
  return { calls, fetchJson };
}


test("the exact-SHA query filters by commit and push event and reads all attempts", async () => {
  const api = fakeApi({ runs: () => [run()], jobsByRun: { 1: jobs() } });
  const verdict = await checkCiGateOnce({ fetchJson: api.fetchJson, repository: REPOSITORY, sha: SHA });
  assert.equal(verdict.state, "passed");
  assert.match(api.calls[0], new RegExp(`^/repos/${REPOSITORY}/actions/workflows/ci\\.yml/runs\\?head_sha=${SHA}&event=push&per_page=100&page=1$`, "u"));
  assert.match(api.calls[1], /\/actions\/runs\/1\/jobs\?filter=all&per_page=100&page=1$/u);
});


test("listings of exactly one full page are followed to the next page", async () => {
  const pages = new Map();
  const filler = Array.from({ length: 100 }, (_, index) => run({ id: 1000 + index, head_sha: "c".repeat(40) }));
  const fetchJson = async (route) => {
    const page = Number(new URL(route, "https://api.invalid").searchParams.get("page"));
    pages.set(route, page);
    if (route.includes("/workflows/")) {
      return { workflow_runs: page === 1 ? filler : [run()] };
    }
    return { jobs: page === 1 ? jobs() : [] };
  };
  const verdict = await checkCiGateOnce({ fetchJson, repository: REPOSITORY, sha: SHA });
  assert.equal(verdict.state, "passed");
});


test("waiting resolves once an in-progress run completes", async () => {
  let reads = 0;
  const api = fakeApi({
    runs: () => {
      reads += 1;
      return [reads < 3 ? run({ status: "in_progress", conclusion: null }) : run()];
    },
    jobsByRun: { 1: jobs() },
  });
  let clock = 0;
  const verdict = await waitForCiGate({
    fetchJson: api.fetchJson,
    repository: REPOSITORY,
    sha: SHA,
    policy: FAST,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  assert.equal(verdict.state, "passed");
  assert.equal(reads, 3);
});


test("a run that never finishes times out instead of passing", async () => {
  const api = fakeApi({ runs: () => [run({ status: "in_progress", conclusion: null })] });
  let clock = 0;
  await assert.rejects(
    waitForCiGate({
      fetchJson: api.fetchJson,
      repository: REPOSITORY,
      sha: SHA,
      policy: FAST,
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
    }),
    (error) => error.code === "CI_TIMEOUT",
  );
});


test("a commit that has no CI run fails after the short grace period", async () => {
  const api = fakeApi({ runs: () => [] });
  let clock = 0;
  await assert.rejects(
    waitForCiGate({
      fetchJson: api.fetchJson,
      repository: REPOSITORY,
      sha: SHA,
      policy: FAST,
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
    }),
    (error) => error.code === "CI_RUN_MISSING" && clock <= FAST.missingRunTimeoutMs + FAST.pollIntervalMs,
  );
});


test("a failed run fails immediately without polling", async () => {
  const api = fakeApi({ runs: () => [run({ conclusion: "failure" })] });
  await assert.rejects(
    waitForCiGate({
      fetchJson: api.fetchJson,
      repository: REPOSITORY,
      sha: SHA,
      policy: FAST,
      sleep: async () => { throw new Error("must not wait"); },
    }),
    (error) => error.code === "CI_NOT_PASSED",
  );
});


test("API errors fail closed once they persist and a single blip is tolerated", async () => {
  const tolerated = fakeApi({ runs: () => [run()], jobsByRun: { 1: jobs() }, failures: [true] });
  const verdict = await waitForCiGate({
    fetchJson: tolerated.fetchJson,
    repository: REPOSITORY,
    sha: SHA,
    policy: FAST,
    sleep: async () => {},
  });
  assert.equal(verdict.state, "passed");

  const broken = fakeApi({ runs: () => [run()], failures: [true, true, true, true] });
  await assert.rejects(
    waitForCiGate({
      fetchJson: broken.fetchJson,
      repository: REPOSITORY,
      sha: SHA,
      policy: FAST,
      sleep: async () => {},
    }),
    (error) => error.code === "API_ERROR",
  );
});


test("malformed API payloads and invalid inputs fail closed", async () => {
  await assert.rejects(
    checkCiGateOnce({ fetchJson: async () => ({}), repository: REPOSITORY, sha: SHA }),
    (error) => error.code === "API_SHAPE",
  );
  await assert.rejects(
    checkCiGateOnce({ fetchJson: async () => ({ workflow_runs: [] }), repository: "not a repo", sha: SHA }),
    (error) => error.code === "INVALID_REPOSITORY",
  );
});


test("the GitHub fetcher authenticates and maps transport and HTTP failures to API errors", async () => {
  assert.throws(() => createGithubJsonFetcher({ token: "" }), (error) => error.code === "TOKEN_REQUIRED");
  let seen;
  const ok = createGithubJsonFetcher({
    token: "secret",
    apiUrl: "https://api.example.test",
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return { ok: true, json: async () => ({ ok: 1 }) };
    },
  });
  assert.deepEqual(await ok("/repos/x/y?z=1"), { ok: 1 });
  assert.equal(seen.url, "https://api.example.test/repos/x/y?z=1");
  assert.equal(seen.init.headers.Authorization, "Bearer secret");

  for (const fetchImpl of [
    async () => ({ ok: false, status: 403, json: async () => ({}) }),
    async () => { throw new TypeError("fetch failed"); },
    async () => ({ ok: true, json: async () => { throw new SyntaxError("bad"); } }),
  ]) {
    const failing = createGithubJsonFetcher({ token: "secret", fetchImpl });
    await assert.rejects(failing("/repos/x/y"), (error) => error.code === "API_ERROR" && !error.message.includes("secret"));
  }
});
