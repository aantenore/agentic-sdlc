import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_TEST_CONCURRENCY,
  MAX_TEST_CONCURRENCY,
  SHARD_WEIGHTS_FILE,
  SHARD_WEIGHTS_SCHEMA,
  TEST_CONCURRENCY_ENV,
  TEST_SHARD_ENV,
  discoverTestFiles,
  loadShardWeights,
  main,
  medianWeight,
  parseShardWeights,
  parseTestConcurrency,
  parseTestShard,
  partitionTestFiles,
  projectRelativePath,
  selectShardFiles,
} from "../../scripts/run-test-suite.mjs";
import { NODE_ENGINE_RANGE } from "../../lib/runtime-support.mjs";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

test("test concurrency defaults to two, accepts positive integers, and caps large requests", () => {
  assert.equal(DEFAULT_TEST_CONCURRENCY, 2);
  assert.equal(MAX_TEST_CONCURRENCY, 8);
  assert.equal(TEST_CONCURRENCY_ENV, "AGENTIC_SDLC_TEST_CONCURRENCY");
  assert.equal(parseTestConcurrency(undefined), 2);
  assert.equal(parseTestConcurrency("1"), 1);
  assert.equal(parseTestConcurrency("4"), 4);
  assert.equal(parseTestConcurrency("8"), 8);
  assert.equal(parseTestConcurrency("9"), 8);
  assert.equal(parseTestConcurrency("999999999999999999999999"), 8);
});

test("test concurrency rejects malformed or non-positive values", () => {
  for (const value of ["", "0", "-1", "+2", "1.5", " 2", "2 ", "two"]) {
    assert.throws(
      () => parseTestConcurrency(value),
      new RegExp(`${TEST_CONCURRENCY_ENV} must be a positive integer`, "u"),
    );
  }
  assert.throws(
    () => parseTestConcurrency(2),
    new RegExp(`${TEST_CONCURRENCY_ENV} must be a positive integer`, "u"),
  );
});

test("npm test uses the supported bounded programmatic runner", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"),
  );

  assert.equal(packageJson.engines.node, NODE_ENGINE_RANGE);
  assert.equal(packageJson.scripts.test, "node scripts/run-test-suite.mjs");
  assert.doesNotMatch(JSON.stringify(packageJson.scripts), /--test-concurrency(?:=|\s)/u);
});

test("runner discovers an explicit, non-empty, stable test-file list", () => {
  const files = discoverTestFiles();

  assert.ok(files.length > 0);
  assert.deepEqual(files, [...files].sort());
  assert.ok(files.every((file) => path.isAbsolute(file)));
  assert.ok(files.every((file) => file.startsWith(path.join(PROJECT_ROOT, "test"))));
  assert.ok(files.includes(fileURLToPath(import.meta.url)));
});

test("runner returns a nonzero status for test failures and stream errors", async () => {
  const failure = await runMainWithEvent("test:fail", { name: "failed test" });
  assert.equal(failure.code, 1);
  assert.equal(failure.stderr, "");
  assert.match(failure.stdout, /# Failing tests \(1\):\n# - failed test\n/u);

  // The summary names the file and repeats the cause, so a log cut at the top still shows it.
  const detailed = await runMainWithEvent("test:fail", {
    name: "detailed test",
    file: path.join(PROJECT_ROOT, "test", "example.e2e.mjs"),
    line: 12,
    details: { error: Object.assign(new Error("wrapper"), { cause: new Error("ENOENT: no such file") }) },
  });
  assert.match(detailed.stdout, /# - test\/example\.e2e\.mjs:12 detailed test\n#   Error: ENOENT: no such file/u);
  const parent = await runMainWithEvent("test:fail", { name: "parent", details: { error: { failureType: "subtestsFailed" } } });
  assert.doesNotMatch(parent.stdout, /Failing tests/u);

  const error = await runMainWithEvent("error", new Error("runner exploded"));
  assert.equal(error.code, 1);
  assert.match(error.stderr, /Test runner error: Error: runner exploded/u);
});

test("runner fails closed when the stream reports fewer tests than explicit files", async () => {
  const testStream = new EventEmitter();
  let stderr = "";
  const code = await main({
    env: {},
    stdout: {
      write() {
        return true;
      },
    },
    stderr: {
      write(chunk) {
        stderr += chunk;
        return true;
      },
    },
    runTests(options) {
      assert.deepEqual(options, {
        concurrency: DEFAULT_TEST_CONCURRENCY,
        files: ["/deterministic/one.test.mjs", "/deterministic/two.test.mjs"],
      });
      return testStream;
    },
    findTestFiles() {
      return ["/deterministic/one.test.mjs", "/deterministic/two.test.mjs"];
    },
    async *reporter() {
      yield "TAP version 13\n";
    },
  });

  assert.equal(code, 1);
  assert.match(stderr, /completed only 0 test events for 2 explicit test files/u);
});

test("test shard parsing accepts only 1-based <index>/<total> values", () => {
  assert.equal(TEST_SHARD_ENV, "AGENTIC_SDLC_TEST_SHARD");
  assert.equal(parseTestShard(undefined), null);
  assert.deepEqual(parseTestShard("1/3"), { index: 1, total: 3 });
  assert.deepEqual(parseTestShard("3/3"), { index: 3, total: 3 });
  assert.deepEqual(parseTestShard("1/1"), { index: 1, total: 1 });
  for (const value of [
    "", "0/3", "4/3", "1/0", "1", "/3", "1/", "a/b", "1/3/5", "-1/3", "+1/3",
    "1.5/3", " 1/3", "1/3 ", "01/3", "1/03", "12345/99999", "1-3", 1, null, {},
  ]) {
    assert.throws(
      () => parseTestShard(value),
      new RegExp(`${TEST_SHARD_ENV} must be "<index>/<total>"`, "u"),
      JSON.stringify(value),
    );
  }
});

const FIXTURE_SIZES = new Map(Object.entries({
  "/t/a.mjs": 900, "/t/b.mjs": 800, "/t/c.mjs": 500, "/t/d.mjs": 500,
  "/t/e.mjs": 300, "/t/f.mjs": 200, "/t/g.mjs": 100, "/t/h.mjs": 100, "/t/i.mjs": 10,
}));
const fixtureFiles = () => [...FIXTURE_SIZES.keys()];
const fixtureSize = (file) => FIXTURE_SIZES.get(file);

test("sharding is deterministic and independent of the input order", () => {
  const baseline = partitionTestFiles(fixtureFiles(), 3, fixtureSize);
  assert.deepEqual(partitionTestFiles(fixtureFiles(), 3, fixtureSize), baseline);
  assert.deepEqual(partitionTestFiles(fixtureFiles().reverse(), 3, fixtureSize), baseline);
  assert.deepEqual(baseline, [
    ["/t/a.mjs", "/t/f.mjs", "/t/h.mjs"],
    ["/t/b.mjs", "/t/e.mjs", "/t/i.mjs"],
    ["/t/c.mjs", "/t/d.mjs", "/t/g.mjs"],
  ]);
});

test("every file lands in exactly one shard and the shards are balanced", () => {
  for (const total of [1, 2, 3, 5, 9]) {
    const shards = partitionTestFiles(fixtureFiles(), total, fixtureSize);
    assert.equal(shards.length, total);
    assert.deepEqual(shards.flat().sort(), fixtureFiles().sort(), `total ${total}`);
    for (const shard of shards) assert.deepEqual(shard, [...shard].sort());
    const loads = shards.map((shard) => shard.reduce((sum, file) => sum + fixtureSize(file), 0));
    assert.ok(Math.max(...loads) - Math.min(...loads) <= 900, `total ${total}: ${loads}`);
  }
  const loads = partitionTestFiles(fixtureFiles(), 3, fixtureSize)
    .map((shard) => shard.reduce((sum, file) => sum + fixtureSize(file), 0));
  assert.deepEqual(loads, [1200, 1110, 1100]);
});

test("equal sizes are tied by path so the split never depends on the filesystem", () => {
  const files = ["/t/z.mjs", "/t/y.mjs", "/t/x.mjs", "/t/w.mjs"];
  assert.deepEqual(
    partitionTestFiles(files, 2, () => 10),
    [["/t/w.mjs", "/t/y.mjs"], ["/t/x.mjs", "/t/z.mjs"]],
  );
});

test("the real test tree is covered exactly once by three shards", () => {
  const files = discoverTestFiles();
  const shards = partitionTestFiles(files, 3);
  assert.deepEqual(shards.flat().sort(), files);
  assert.ok(shards.every((shard) => shard.length > 0));
});

// Expected durations are what balances the shards, so a file that is small but
// slow must weigh more than a large file that finishes quickly.
const FIXTURE_WEIGHTS = new Map(Object.entries({
  "/t/a.mjs": 10, "/t/b.mjs": 700, "/t/c.mjs": 20, "/t/d.mjs": 650,
  "/t/e.mjs": 30, "/t/f.mjs": 600, "/t/g.mjs": 40, "/t/h.mjs": 50, "/t/i.mjs": 60,
}));
const fixtureWeight = (file) => FIXTURE_WEIGHTS.get(file);

test("shards are balanced by the weight function, not by file count or size", () => {
  const bySize = partitionTestFiles(fixtureFiles(), 3, fixtureSize);
  const byWeight = partitionTestFiles(fixtureFiles(), 3, fixtureWeight);
  assert.notDeepEqual(byWeight, bySize);
  const loads = (shards, weight) => shards.map((shard) => shard.reduce((sum, file) => sum + weight(file), 0));
  // Each of the three heavy files is alone with light ones, so the shards finish together.
  assert.deepEqual(byWeight, [
    ["/t/b.mjs", "/t/e.mjs"],
    ["/t/c.mjs", "/t/d.mjs", "/t/h.mjs"],
    ["/t/a.mjs", "/t/f.mjs", "/t/g.mjs", "/t/i.mjs"],
  ]);
  const weighted = loads(byWeight, fixtureWeight);
  assert.deepEqual(weighted, [730, 720, 710]);
  // The same split judged by the weights is far worse when it was made from sizes.
  const sized = loads(bySize, fixtureWeight);
  assert.ok(Math.max(...sized) - Math.min(...sized) > Math.max(...weighted) - Math.min(...weighted));
});

test("shard weights are parsed strictly", () => {
  const valid = { schema: SHARD_WEIGHTS_SCHEMA, defaultWeight: 40, files: { "test/a.mjs": 10, "test/b.mjs": 90 } };
  const parsed = parseShardWeights(JSON.stringify(valid));
  assert.equal(parsed.defaultWeight, 40);
  assert.deepEqual([...parsed.files], [["test/a.mjs", 10], ["test/b.mjs", 90]]);
  for (const broken of [
    "not json",
    "null",
    "[]",
    JSON.stringify({ ...valid, schema: "other" }),
    JSON.stringify({ ...valid, defaultWeight: 0 }),
    JSON.stringify({ ...valid, defaultWeight: 1.5 }),
    JSON.stringify({ ...valid, files: [] }),
    JSON.stringify({ ...valid, files: null }),
    JSON.stringify({ ...valid, files: { "test/a.mjs": 0 } }),
    JSON.stringify({ ...valid, files: { "test/a.mjs": -3 } }),
    JSON.stringify({ ...valid, files: { "test/a.mjs": "10" } }),
    JSON.stringify({ ...valid, files: { "test/a.mjs": Number.MAX_SAFE_INTEGER + 2 } }),
  ]) {
    assert.throws(() => parseShardWeights(broken), TypeError, broken);
  }
});

test("a missing weights table falls back to sizes and a corrupt one is an error", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "shard-weights-"));
  try {
    assert.equal(loadShardWeights(path.join(scratch, "absent.json")), null);
    const corrupt = path.join(scratch, "corrupt.json");
    fs.writeFileSync(corrupt, "{");
    assert.throws(() => loadShardWeights(corrupt), TypeError);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("median weight is the lower middle value and never below one", () => {
  assert.equal(medianWeight([]), 1);
  assert.equal(medianWeight([5]), 5);
  assert.equal(medianWeight([30, 10, 20]), 20);
  assert.equal(medianWeight([40, 10, 30, 20]), 20);
  assert.equal(medianWeight([0, 0, 0]), 1);
});

test("project-relative paths use forward slashes", () => {
  assert.equal(projectRelativePath(path.join(PROJECT_ROOT, "test", "unit", "x.mjs")), "test/unit/x.mjs");
});

test("a shard that would be empty is rejected instead of silently passing", () => {
  assert.throws(
    () => selectShardFiles(["/t/only.mjs"], { index: 2, total: 3 }, () => 1),
    /shard 2\/3 has no files/u,
  );
});

test("runner runs only its shard and reports it", async () => {
  const seen = [];
  let stdout = "";
  for (const index of [1, 2, 3]) {
    const testStream = new EventEmitter();
    const code = await main({
      env: { [TEST_SHARD_ENV]: `${index}/3` },
      stdout: { write(chunk) { stdout += chunk; return true; } },
      stderr: { write() { return true; } },
      findTestFiles: fixtureFiles,
      fileWeight: fixtureSize,
      runTests(options) {
        seen.push(...options.files);
        queueMicrotask(() => {
          for (const _ of options.files) testStream.emit("test:pass");
        });
        return testStream;
      },
      async *reporter(stream) {
        await new Promise((resolve) => setImmediate(resolve));
        yield "ok\n";
      },
    });
    assert.equal(code, 0, `shard ${index}`);
  }
  assert.deepEqual(seen.sort(), fixtureFiles().sort());
  assert.match(stdout, /# test shard 1\/3: 3 of 9 test files/u);
});

test("runner fails with a clear error for an invalid shard and runs nothing", async () => {
  for (const value of ["0/3", "4/3", "x", ""]) {
    let stderr = "";
    const code = await main({
      env: { [TEST_SHARD_ENV]: value },
      stdout: { write() { return true; } },
      stderr: { write(chunk) { stderr += chunk; return true; } },
      findTestFiles: fixtureFiles,
      runTests() { throw new Error("must not run tests"); },
    });
    assert.equal(code, 1, value);
    assert.match(stderr, /AGENTIC_SDLC_TEST_SHARD must be "<index>\/<total>"/u, value);
  }
});

async function runMainWithEvent(eventName, payload) {
  const testStream = new EventEmitter();
  let stdout = "";
  let stderr = "";
  const code = await main({
    env: {},
    stdout: {
      write(chunk) {
        stdout += chunk;
        return true;
      },
    },
    stderr: {
      write(chunk) {
        stderr += chunk;
        return true;
      },
    },
    runTests(options) {
      assert.deepEqual(options, {
        concurrency: DEFAULT_TEST_CONCURRENCY,
        files: ["/deterministic/test.mjs"],
      });
      return testStream;
    },
    findTestFiles() {
      return ["/deterministic/test.mjs"];
    },
    async *reporter(stream) {
      stream.emit(eventName, payload);
      yield "TAP version 13\n";
    },
  });
  return { code, stdout, stderr };
}
