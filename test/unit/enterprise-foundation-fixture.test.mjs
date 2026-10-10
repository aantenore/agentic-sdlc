import "../helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ENTERPRISE_FOUNDATION_DEFAULT_SCALE,
  ENTERPRISE_FOUNDATION_FIXED_SEED,
  ENTERPRISE_FOUNDATION_FIXED_TIMESTAMP,
  ENTERPRISE_FOUNDATION_FIXTURE_SCHEMA,
  createEnterpriseFoundationFixture,
} from "../helpers/enterprise-foundation-fixture.mjs";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const BENCHMARK_PATH = path.resolve(TEST_DIRECTORY, "../../scripts/benchmark-foundation.mjs");

const SMALL_SCALE = Object.freeze({
  source_files: 8,
  stories: 4,
  records: 9,
  dependency_edges: 7,
  trace_events: 12,
});

test("enterprise defaults cover the approved deterministic scale", () => {
  assert.ok(ENTERPRISE_FOUNDATION_DEFAULT_SCALE.source_files >= 1_000);
  assert.ok(ENTERPRISE_FOUNDATION_DEFAULT_SCALE.stories >= 1_000);
  assert.ok(ENTERPRISE_FOUNDATION_DEFAULT_SCALE.records >= 10_000);
  assert.ok(ENTERPRISE_FOUNDATION_DEFAULT_SCALE.dependency_edges >= 5_000);
  assert.ok(ENTERPRISE_FOUNDATION_DEFAULT_SCALE.trace_events >= 100_000);
});

test("fixture bytes, IDs, counts, and timestamps are deterministic", (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "enterprise-fixture-test-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true, maxRetries: 3 }));
  const first = createEnterpriseFoundationFixture({ parentDirectory: parent, scale: SMALL_SCALE });
  const second = createEnterpriseFoundationFixture({ parentDirectory: parent, scale: SMALL_SCALE });
  t.after(first.cleanup);
  t.after(second.cleanup);

  assert.equal(first.manifest.schema_version, ENTERPRISE_FOUNDATION_FIXTURE_SCHEMA);
  assert.equal(first.manifest.seed, ENTERPRISE_FOUNDATION_FIXED_SEED);
  assert.equal(first.manifest.generated_at, ENTERPRISE_FOUNDATION_FIXED_TIMESTAMP);
  assert.deepEqual(first.manifest.scale, SMALL_SCALE);
  assert.equal(digestTree(first.root), digestTree(second.root));

  const story = readJson(path.join(first.root, first.manifest.query_targets.story_path));
  assert.equal(story.id, "ST-ENT-000000");
  assert.equal(story.created_at, ENTERPRISE_FOUNDATION_FIXED_TIMESTAMP);
  assert.equal(story.updated_at, ENTERPRISE_FOUNDATION_FIXED_TIMESTAMP);

  const records = readJsonLinesUnder(path.join(first.root, first.manifest.layout.records_root));
  const traces = readJsonLinesUnder(path.join(first.root, first.manifest.layout.traces_root));
  const graph = readJson(path.join(first.root, first.manifest.layout.dependencies_path));
  assert.equal(records.length, SMALL_SCALE.records);
  assert.equal(traces.length, SMALL_SCALE.trace_events);
  assert.equal(graph.edges.length, SMALL_SCALE.dependency_edges);
  assert.ok(records.every((record) => /^ST-ENT-00000[0-3]$/u.test(record.story_id)));
  assert.equal(records.find((record) => record.id === first.manifest.query_targets.record_id)?.sequence, 4);

  const sources = listFiles(path.join(first.root, first.manifest.layout.source_root));
  assert.equal(sources.length, SMALL_SCALE.source_files);
  assert.deepEqual(
    [...new Set(sources.map((filePath) => path.extname(filePath)))].sort(),
    [".js", ".mjs", ".py", ".ts"],
  );
});

test("fixture cleanup is idempotent and failed construction leaves no temp tree", (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "enterprise-fixture-cleanup-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true, maxRetries: 3 }));
  const fixture = createEnterpriseFoundationFixture({ parentDirectory: parent, scale: SMALL_SCALE });

  fixture.cleanup();
  fixture.cleanup();
  assert.equal(fs.existsSync(fixture.root), false);

  assert.throws(
    () => createEnterpriseFoundationFixture({
      parentDirectory: parent,
      scale: { ...SMALL_SCALE, records: 0 },
    }),
    /scale\.records must be a positive integer/u,
  );
  assert.deepEqual(fs.readdirSync(parent), []);
});

test("standalone benchmark emits one JSON result and cleans its fixture", () => {
  const result = childProcess.spawnSync(process.execPath, [
    BENCHMARK_PATH,
    "--source-files", "12",
    "--stories", "6",
    "--records", "17",
    "--dependency-edges", "11",
    "--trace-events", "24",
    "--warm-iterations", "3",
  ], {
    cwd: path.resolve(TEST_DIRECTORY, "../.."),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  const report = JSON.parse(result.stdout);
  assert.equal(report.schema_version, "enterprise-foundation-benchmark:v1");
  assert.equal(report.ok, true);
  assert.equal(report.deterministic_workload, true);
  assert.equal(report.fixture.cleanup, "completed");
  assert.equal(report.workloads.source_discovery.discovered_files, 12);
  assert.equal(report.workloads.canonical_query.stories, 6);
  assert.equal(report.workloads.canonical_query.records, 17);
  assert.equal(report.workloads.canonical_query.dependency_edges, 11);
  assert.equal(report.workloads.canonical_query.trace_events, 24);
  assert.equal(report.workloads.canonical_query.target_record_found, true);
  assert.equal(report.workloads.warm_canonical_read.iterations, 3);
  assert.equal(report.evaluation.counts_complete, true);
  assert.ok(report.store_metrics.physical_reads > 0);
  assert.ok(report.store_metrics.cache_hits > 0);
  assert.equal(Object.hasOwn(report.fixture, "root"), false);
});

test("standalone benchmark failures remain machine-readable", () => {
  const result = childProcess.spawnSync(process.execPath, [BENCHMARK_PATH, "--stories", "0"], {
    cwd: path.resolve(TEST_DIRECTORY, "../.."),
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.error.code, "benchmark_failed");
  assert.match(report.error.message, /scale\.stories must be a positive integer/u);
});

function digestTree(root) {
  const hash = crypto.createHash("sha256");
  for (const filePath of listFiles(root)) {
    const relativePath = path.relative(root, filePath).split(path.sep).join("/");
    hash.update(relativePath);
    hash.update("\0");
    hash.update(fs.readFileSync(filePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function listFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort(compareEntries)) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(filePath));
    else if (entry.isFile()) files.push(filePath);
  }
  return files;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readJsonLinesUnder(root) {
  const records = [];
  for (const filePath of listFiles(root)) {
    for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
      if (line) records.push(JSON.parse(line));
    }
  }
  return records;
}

function compareEntries(left, right) {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}
