import "../helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ENTERPRISE_CANONICAL_QUERY_WORKER_SCHEMA,
  ENTERPRISE_FOUNDATION_DEFAULT_SCALE,
  ENTERPRISE_OBSERVATORY_WORKER_SCHEMA,
  collectCanonicalQuerySamples,
  evaluateEnterprisePerformanceBudgets,
  normalizeResourceMaxRssBytes,
  parseCanonicalQueryWorkerEnvelope,
  parseObservatoryServerCompletionEnvelope,
  parseObservatoryServerReadyMessage,
  parseObservatoryWorkerEnvelope,
  platformThresholds,
  runEnterprisePerformanceBenchmark,
  sequentialWorkerSamplesAreIsolated,
  sequentialWorkersAreIsolated,
  summarizeCanonicalQuerySamples,
  validateObservatoryColdResponse,
  validateObservatoryModelArtifact,
} from "../../scripts/benchmark-enterprise-performance.mjs";
import { createEnterpriseFoundationFixture } from "../../scripts/benchmark-foundation.mjs";
import { buildObservatoryViewModel } from "../../lib/change-observatory/normalizer.mjs";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(TEST_DIRECTORY, "../..");
const BENCHMARK_PATH = path.resolve(TEST_DIRECTORY, "../../scripts/benchmark-enterprise-performance.mjs");
const PACKAGE_PATH = path.join(REPOSITORY_ROOT, "package.json");
const SMALL_SCALE = Object.freeze({
  source_files: 20,
  stories: 20,
  records: 100,
  dependency_edges: 50,
  trace_events: 500,
});

test("enterprise performance defaults preserve the approved production scale", () => {
  assert.deepEqual(ENTERPRISE_FOUNDATION_DEFAULT_SCALE, {
    source_files: 1_000,
    stories: 1_000,
    records: 10_000,
    dependency_edges: 5_000,
    trace_events: 100_000,
  });
});

test("Windows performance policy separates the service target from a bounded regression budget", () => {
  const thresholds = platformThresholds("win32");
  assert.deepEqual(thresholds, {
    query_ms: 4_000,
    query_sample_ceiling_ms: 4_800,
    observatory_warm_target_p95_ms: 250,
    observatory_warm_p95_ms: 275,
    rss_bytes: 320 * 1024 * 1024,
  });

  assert.deepEqual(evaluateEnterprisePerformanceBudgets({
    query_ms: 3_000,
    query_samples_ms: [4_100, 900, 3_000],
    observatory_warm_p95_ms: 258.387,
    rss_bytes: 200 * 1024 * 1024,
  }, thresholds), {
    query_within_budget: true,
    query_samples_within_ceiling: true,
    observatory_warm_target_met: false,
    observatory_warm_within_budget: true,
    rss_within_budget: true,
  });

  assert.equal(evaluateEnterprisePerformanceBudgets({
    query_ms: 3_000,
    observatory_warm_p95_ms: 275.001,
    rss_bytes: 200 * 1024 * 1024,
  }, thresholds).observatory_warm_within_budget, false);
});

test("performance policy rejects an incoherent or unbounded threshold profile", () => {
  assert.throws(
    () => evaluateEnterprisePerformanceBudgets({
      query_ms: 1,
      observatory_warm_p95_ms: 1,
      rss_bytes: 1,
    }, {
      query_ms: 2,
      query_sample_ceiling_ms: 2.4,
      observatory_warm_target_p95_ms: 10,
      observatory_warm_p95_ms: 9,
      rss_bytes: 2,
    }),
    /hard budget cannot be lower than its target/u,
  );
  assert.throws(
    () => evaluateEnterprisePerformanceBudgets({
      query_ms: 1,
      observatory_warm_p95_ms: 1,
      rss_bytes: 1,
    }, {
      ...platformThresholds("win32"),
      query_sample_ceiling_ms: 4_800.001,
    }),
    /cannot exceed 1\.20x/u,
  );
  assert.throws(
    () => evaluateEnterprisePerformanceBudgets({
      query_ms: Number.POSITIVE_INFINITY,
      observatory_warm_p95_ms: 1,
      rss_bytes: 1,
    }, platformThresholds("linux")),
    /query_ms must be a finite non-negative number/u,
  );
});

test("Windows canonical query sampling keeps the fast path and retries exactly twice after a miss", async () => {
  for (const [firstDurationMs, expectedCalls] of [[4_000, 1], [4_000.001, 3]]) {
    const invocations = [];
    const samples = await collectCanonicalQuerySamples({
      platform: "win32",
      queryBudgetMs: 4_000,
      runSample: async (sampleIndex) => {
        invocations.push(sampleIndex);
        return { result: { duration_ms: sampleIndex === 1 ? firstDurationMs : 1 } };
      },
    });
    assert.equal(samples.length, expectedCalls);
    assert.deepEqual(invocations, Array.from({ length: expectedCalls }, (_, index) => index + 1));
  }

  let nonWindowsCalls = 0;
  const nonWindowsSamples = await collectCanonicalQuerySamples({
    platform: "linux",
    queryBudgetMs: 2_000,
    runSample: async () => {
      nonWindowsCalls += 1;
      return { result: { duration_ms: 2_000.001 } };
    },
  });
  assert.equal(nonWindowsCalls, 1);
  assert.equal(nonWindowsSamples.length, 1);
});

test("benchmark platform simulation is restricted to an injected canonical worker", async () => {
  const simulatedPlatform = process.platform === "win32" ? "linux" : "win32";
  await assert.rejects(
    runEnterprisePerformanceBenchmark({
      platform: simulatedPlatform,
      scale: SMALL_SCALE,
      warmIterations: 2,
    }),
    /requires an injected canonicalWorkerScriptPath/u,
  );
});

test("canonical query sampling uses a numeric median and an inclusive 1.20x sample ceiling", () => {
  const thresholds = platformThresholds("win32");
  const workers = (durations) => durations.map((duration_ms) => ({ result: { duration_ms } }));

  const numericMedian = summarizeCanonicalQuerySamples(workers([4_100, 900, 4_000]), thresholds);
  assert.equal(numericMedian.median_ms, 4_000);
  assert.equal(numericMedian.median_sample_index, 3);
  assert.equal(numericMedian.all_samples_within_ceiling, true);

  assert.equal(
    summarizeCanonicalQuerySamples(workers([4_800, 3_999, 4_000]), thresholds)
      .all_samples_within_ceiling,
    true,
  );
  const overCeiling = summarizeCanonicalQuerySamples(
    workers([4_800.001, 3_999, 4_000]),
    thresholds,
  );
  assert.equal(overCeiling.median_ms, 4_000);
  assert.equal(overCeiling.all_samples_within_ceiling, false);
  assert.equal(evaluateEnterprisePerformanceBudgets({
    query_ms: overCeiling.median_ms,
    query_samples_ms: overCeiling.durations_ms,
    observatory_warm_p95_ms: 250,
    rss_bytes: 1,
  }, thresholds).query_samples_within_ceiling, false);

  assert.equal(
    summarizeCanonicalQuerySamples(workers([4_000.001, 3_999.999, 4_000]), thresholds).median_ms,
    4_000,
  );
  assert.equal(
    summarizeCanonicalQuerySamples(
      workers([4_000.001, 3_999.999, 4_000.001]),
      thresholds,
    ).median_ms,
    4_000.001,
  );
});

test("package configuration separates correctness from the enforcing enterprise benchmark", () => {
  const packageDefinition = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));
  assert.equal(
    packageDefinition.scripts?.["benchmark:enterprise"],
    "node scripts/benchmark-enterprise-performance.mjs --enforce",
  );
  assert.equal(
    packageDefinition.scripts?.test,
    "node scripts/run-test-suite.mjs",
  );
  assert.doesNotMatch(
    JSON.stringify(packageDefinition.scripts),
    /--test-concurrency(?:=|\s)/u,
  );
  assert.equal(
    packageDefinition.scripts?.["test:enterprise"],
    "npm test && npm run benchmark:enterprise",
  );
});

test("worker protocols reject incoherent RSS snapshots", () => {
  assert.throws(
    () => parseCanonicalQueryWorkerEnvelope(canonicalWorkerEnvelope({
      rss_bytes: 64 * 1024 * 1024,
      heap_used_bytes: 16 * 1024 * 1024,
      max_rss_bytes: 63 * 1024 * 1024,
    })),
    /max_rss_bytes must be greater than or equal to rss_bytes/u,
  );
  assert.throws(
    () => parseObservatoryWorkerEnvelope(observatoryWorkerEnvelope({
      rss_bytes: 32 * 1024 * 1024,
      heap_used_bytes: 8 * 1024 * 1024,
      max_rss_bytes: 31 * 1024 * 1024,
    })),
    /max_rss_bytes must be greater than or equal to rss_bytes/u,
  );
  assert.throws(
    () => parseCanonicalQueryWorkerEnvelope(canonicalWorkerEnvelope({
      rss_bytes: 16 * 1024 * 1024,
      heap_used_bytes: 17 * 1024 * 1024,
      max_rss_bytes: 18 * 1024 * 1024,
    })),
    /rss_bytes must be greater than or equal to heap_used_bytes/u,
  );
});

test("max RSS normalization follows libuv's platform and version unit contract", () => {
  const bytes = 64 * 1024 * 1024;
  const kibibytes = 64 * 1024;
  assert.equal(
    normalizeResourceMaxRssBytes(bytes, { platform: "darwin", uvVersion: "1.44.2" }),
    bytes,
  );
  assert.equal(
    normalizeResourceMaxRssBytes(kibibytes, { platform: "darwin", uvVersion: "1.45.0" }),
    bytes,
  );
  assert.equal(
    normalizeResourceMaxRssBytes(kibibytes, { platform: "darwin", uvVersion: "1.51.0" }),
    bytes,
  );
  assert.equal(
    normalizeResourceMaxRssBytes(kibibytes, { platform: "linux", uvVersion: "1.44.2" }),
    bytes,
  );
  assert.equal(
    normalizeResourceMaxRssBytes(kibibytes, { platform: "win32", uvVersion: "1.44.2" }),
    bytes,
  );
  assert.equal(normalizeResourceMaxRssBytes(0), 0);
  assert.throws(
    () => normalizeResourceMaxRssBytes(kibibytes, {
      platform: "darwin",
      uvVersion: "unknown",
    }),
    /libuv version must be a numeric semantic version/u,
  );
  assert.throws(
    () => normalizeResourceMaxRssBytes(Number.MAX_SAFE_INTEGER, {
      platform: "linux",
      uvVersion: "1.51.0",
    }),
    /exceeds the safe integer range/u,
  );
});

test("cold Observatory responses require HTTP 200 and a valid SHA-256 ETag", () => {
  const valid = coldResponseForBody(Buffer.from('{"schemaVersion":"change-observatory:view:v1"}', "utf8"));
    assert.equal(validateObservatoryColdResponse(valid), valid.headers.etag);
  assert.throws(
    () => validateObservatoryColdResponse({
      ...valid,
      statusCode: 500,
    }),
    /cold request failed with HTTP 500/u,
  );
  assert.throws(
    () => validateObservatoryColdResponse({
      ...valid,
      headers: {},
    }),
    /did not return a valid SHA-256 ETag/u,
  );
  assert.throws(
    () => validateObservatoryColdResponse({
      ...valid,
      headers: { etag: '"sha256-a"' },
    }),
    /did not return a valid SHA-256 ETag/u,
  );
  assert.throws(
    () => validateObservatoryColdResponse({
      ...valid,
      body_bytes: 0,
    }),
    /returned an empty model/u,
  );
  assert.throws(
    () => validateObservatoryColdResponse({
      ...valid,
      content_length: valid.body_bytes + 1,
    }),
    /does not match Content-Length/u,
  );
  assert.throws(
    () => validateObservatoryColdResponse({
      ...valid,
      sha256_base64url: "a".repeat(43),
    }),
    /does not match the streamed model SHA-256/u,
  );
  assert.throws(
    () => validateObservatoryColdResponse({
      ...valid,
      complete: false,
    }),
    /truncated model/u,
  );
  const emptyModelEnvelope = observatoryWorkerEnvelope({
    rss_bytes: 32 * 1024 * 1024,
    heap_used_bytes: 8 * 1024 * 1024,
    max_rss_bytes: 32 * 1024 * 1024,
  });
  emptyModelEnvelope.result.model_bytes = 0;
  assert.throws(
    () => parseObservatoryWorkerEnvelope(emptyModelEnvelope),
    /returned an empty cold model/u,
  );
  const shortEtagEnvelope = observatoryWorkerEnvelope({
    rss_bytes: 32 * 1024 * 1024,
    heap_used_bytes: 8 * 1024 * 1024,
    max_rss_bytes: 32 * 1024 * 1024,
  });
  shortEtagEnvelope.result.etag = '"sha256-a"';
  assert.throws(
    () => parseObservatoryWorkerEnvelope(shortEtagEnvelope),
    /returned an invalid ETag/u,
  );
});

test("cold Observatory semantic validation rejects a transport-valid non-model body", () => {
  const fixture = createEnterpriseFoundationFixture({
    scale: { source_files: 4, stories: 4, records: 8, dependency_edges: 6, trace_events: 12 },
  });
  const artifactPath = path.join(fixture.root, "transport-valid-but-semantic-invalid.json");
  try {
    fs.writeFileSync(artifactPath, JSON.stringify("x"), "utf8");
    assert.throws(
      () => validateObservatoryModelArtifact(artifactPath, fixture.manifest, {
        expectedSizeBytes: fs.statSync(artifactPath).size + 1,
      }),
      /artifact size does not match/u,
    );
    assert.throws(
      () => validateObservatoryModelArtifact(artifactPath, fixture.manifest, {
        expectedSha256Base64url: "a".repeat(43),
      }),
      /artifact SHA-256 does not match/u,
    );
    assert.throws(
      () => validateObservatoryModelArtifact(artifactPath, fixture.manifest),
      /cold model must be a JSON object/u,
    );
  } finally {
    fixture.cleanup();
  }
});

test("cold model oracle rejects hollow retained evidence and dossier lane items", async () => {
  const fixture = createEnterpriseFoundationFixture({
    scale: { source_files: 4, stories: 4, records: 8, dependency_edges: 6, trace_events: 12 },
  });
  const artifactPath = path.join(fixture.root, "hollow-observatory-model.json");
  try {
    const model = await buildObservatoryViewModel(fixture.root, {
      clock: () => new Date(fixture.manifest.generated_at),
      limits: { maxFiles: 2_048, maxCollectionItems: 1_000 },
    });
    const change = model.changes[0];
    model.changes[0] = {};
    fs.writeFileSync(artifactPath, JSON.stringify(model), "utf8");
    assert.throws(
      () => validateObservatoryModelArtifact(artifactPath, fixture.manifest),
      /changes\[0\].*canonical evidence/u,
    );

    model.changes[0] = change;
    const doneItem = model.dossiers[0].lanes.done.items[0];
    model.dossiers[0].lanes.done.items[0] = { id: "hollow" };
    fs.writeFileSync(artifactPath, JSON.stringify(model), "utf8");
    assert.throws(
      () => validateObservatoryModelArtifact(artifactPath, fixture.manifest),
      /dossier ST-ENT-000000 done\[0\].*canonical evidence/u,
    );

    model.dossiers[0].lanes.done.items[0] = doneItem;
    const legacyInline = JSON.parse(JSON.stringify(model));
    legacyInline.iterations[1].dossier = JSON.parse(JSON.stringify(legacyInline.dossiers[1]));
    legacyInline.iterations[1].dossier.status = "complete";
    fs.writeFileSync(artifactPath, JSON.stringify(legacyInline), "utf8");
    assert.throws(
      () => validateObservatoryModelArtifact(artifactPath, fixture.manifest),
      /different legacy inline dossier/u,
    );

    const nonTargetDossier = model.dossiers[1];
    for (const laneName of ["asked", "decided", "contract", "done", "verified"]) {
      nonTargetDossier.lanes[laneName].items = [];
      nonTargetDossier.lanes[laneName].status = "missing";
      nonTargetDossier.lanes[laneName].provenance = "missing";
    }
    model.iterations[1].dossier = nonTargetDossier;
    fs.writeFileSync(artifactPath, JSON.stringify(model), "utf8");
    assert.throws(
      () => validateObservatoryModelArtifact(artifactPath, fixture.manifest),
      /dossier ST-ENT-000001 lane asked does not match its bounded evidence count/u,
    );
  } finally {
    fixture.cleanup();
  }
});

test("cold model oracle rejects unexpected well-formed diagnostics", async () => {
  const fixture = createEnterpriseFoundationFixture({
    scale: { source_files: 4, stories: 4, records: 8, dependency_edges: 6, trace_events: 12 },
  });
  const artifactPath = path.join(fixture.root, "unexpected-diagnostic-observatory-model.json");
  try {
    const model = await buildObservatoryViewModel(fixture.root, {
      clock: () => new Date(fixture.manifest.generated_at),
      limits: { maxFiles: 2_048, maxCollectionItems: 1_000 },
    });
    model.diagnostics.push({
      code: "unexpected_but_well_formed",
      severity: "warning",
      message: "Unexpected warning",
      provenance: "inferred",
      occurrences: 1,
      sourceRefs: [],
    });
    fs.writeFileSync(artifactPath, JSON.stringify(model), "utf8");
    assert.throws(
      () => validateObservatoryModelArtifact(artifactPath, fixture.manifest),
      /reported unexpected diagnostic unexpected_but_well_formed/u,
    );
  } finally {
    fixture.cleanup();
  }
});

test("cold model oracle requires every truncation diagnostic implied by its bounds", async () => {
  const fixture = createEnterpriseFoundationFixture({
    scale: { source_files: 4, stories: 4, records: 8, dependency_edges: 6, trace_events: 12 },
  });
  const limits = { maxFiles: 2_048, maxRecords: 20, maxCollectionItems: 5 };
  const artifactPath = path.join(fixture.root, "bounded-observatory-model.json");
  try {
    const model = await buildObservatoryViewModel(fixture.root, {
      clock: () => new Date(fixture.manifest.generated_at),
      limits,
    });
    fs.writeFileSync(artifactPath, JSON.stringify(model), "utf8");
    assert.deepEqual(
      validateObservatoryModelArtifact(artifactPath, fixture.manifest, { limits })
        .truncation_diagnostics,
      ["collection_truncated", "dossier_nested_items_truncated", "max_records_exceeded"],
    );

    for (const code of [
      "collection_truncated",
      "dossier_nested_items_truncated",
      "max_records_exceeded",
    ]) {
      const missing = JSON.parse(JSON.stringify(model));
      missing.diagnostics = missing.diagnostics.filter((diagnostic) => diagnostic.code !== code);
      fs.writeFileSync(artifactPath, JSON.stringify(missing), "utf8");
      assert.throws(
        () => validateObservatoryModelArtifact(artifactPath, fixture.manifest, { limits }),
        /truncation diagnostic/u,
      );
    }
  } finally {
    fixture.cleanup();
  }
});

test("Observatory protocol enforces the requested sample count and ordered warm timings", () => {
  const memory = {
    rss_bytes: 32 * 1024 * 1024,
    heap_used_bytes: 8 * 1024 * 1024,
    max_rss_bytes: 32 * 1024 * 1024,
  };
  const wrongCount = observatoryWorkerEnvelope(memory);
  assert.throws(
    () => parseObservatoryWorkerEnvelope(wrongCount, { expectedWarmIterations: 2 }),
    /expected exactly 2/u,
  );

  for (const [field, value] of [
    ["warm_min_ms", 2],
    ["warm_median_ms", 2],
    ["warm_p95_ms", 2],
  ]) {
    const unordered = observatoryWorkerEnvelope(memory);
    unordered.result[field] = value;
    assert.throws(
      () => parseObservatoryWorkerEnvelope(unordered),
      /min <= median <= p95 <= max/u,
    );
  }
});

test("sequential worker isolation permits safe operating-system PID reuse", () => {
  const parentPid = 100;
  const canonical = { pid: 101, parent_pid: parentPid, terminated: true };
  const observatory = { pid: 101, parent_pid: parentPid, terminated: true };
  assert.equal(sequentialWorkersAreIsolated(canonical, observatory, parentPid), true);
  assert.equal(
    sequentialWorkersAreIsolated(canonical, { ...observatory, terminated: false }, parentPid),
    false,
  );
  assert.equal(
    sequentialWorkersAreIsolated(canonical, { ...observatory, pid: parentPid }, parentPid),
    false,
  );
  assert.equal(
    sequentialWorkerSamplesAreIsolated([canonical, canonical, canonical], observatory, parentPid),
    true,
  );
  for (const invalidRetry of [
    { ...canonical, terminated: false },
    { ...canonical, parent_pid: parentPid + 1 },
    { ...canonical, pid: parentPid },
  ]) {
    assert.equal(
      sequentialWorkerSamplesAreIsolated([canonical, invalidRetry, canonical], observatory, parentPid),
      false,
    );
  }
});

test("benchmark validates one canonical catalog and conditional Observatory cache", async () => {
  const report = await runEnterprisePerformanceBenchmark({
    scale: SMALL_SCALE,
    warmIterations: 5,
  });

  assert.equal(report.schema_version, "enterprise-performance-benchmark:v1");
  assert.equal(report.ok, true);
  assert.equal(report.fixture.cleanup, "completed");
  assert.deepEqual(report.fixture.scale, SMALL_SCALE);
  assert.equal(report.workloads.canonical_query.stories, SMALL_SCALE.stories);
  assert.equal(report.workloads.canonical_query.source_files, SMALL_SCALE.source_files);
  assert.equal(report.workloads.canonical_query.records, SMALL_SCALE.records);
  assert.equal(report.workloads.canonical_query.dependency_edges, SMALL_SCALE.dependency_edges);
  assert.equal(report.workloads.canonical_query.trace_events, SMALL_SCALE.trace_events);
  assert.equal(report.workloads.canonical_query.session_metrics.catalog_builds, 1);
  assert.equal(report.workloads.canonical_query.session_metrics.aggregate_json_lines_calls, 2);
  assert.equal(report.workloads.canonical_query.session_metrics.aggregate_files_scanned, 21);
  assert.equal(report.workloads.canonical_query.session_metrics.aggregate_records_retained, 1);
  assert.equal(report.workloads.canonical_query.session_metrics.read_json_lines_calls, 0);
  assert.equal(
    report.workloads.canonical_query.manifest_sha256,
    report.fixture.manifest_sha256,
  );
  const targetRecordIndex = Math.floor(SMALL_SCALE.records / 2);
  assert.deepEqual(report.workloads.canonical_query.target_record, {
    id: "REC-000050",
    path: ".sdlc/work-items/records-000000.jsonl",
    line: targetRecordIndex + 1,
    story_id: "ST-ENT-000010",
    sequence: targetRecordIndex,
  });
  assert.notEqual(report.workloads.canonical_query.process.pid, process.pid);
  assert.equal(report.workloads.canonical_query.process.parent_pid, process.pid);
  assert.equal(report.workloads.canonical_query.process.exit_code, 0);
  assert.equal(report.workloads.canonical_query.process.terminated, true);
  assert.equal(report.workloads.canonical_query.process.isolated_from_parent, true);
  assert.equal(report.workloads.canonical_query.sampling.strategy, "single_sample_fast_path");
  assert.equal(report.workloads.canonical_query.sampling.sample_count, 1);
  assert.deepEqual(report.workloads.canonical_query.sampling.durations_ms, [
    report.workloads.canonical_query.duration_ms,
  ]);
  assert.equal(report.workloads.canonical_query.sampling.samples.length, 1);
  assert.equal(
    report.workloads.canonical_query.sampling.samples[0].evaluation.counts_complete,
    true,
  );
  assert.equal(report.workloads.observatory.cold_status, 200);
  assert.equal(report.workloads.observatory.conditional_hits, 5);
  assert.equal(report.workloads.observatory.conditional_body_bytes, 0);
  assert.equal(report.workloads.observatory.warm_iterations, 5);
  assert.equal(report.workloads.observatory.model_validation.passed, true);
  assert.equal(
    report.workloads.observatory.model_validation.manifest_sha256,
    report.fixture.manifest_sha256,
  );
  assert.equal(
    report.workloads.observatory.model_validation.verifier_process.role,
    "observatory_model_semantic_verifier",
  );
  assert.equal(
    report.workloads.observatory.model_validation.verifier_process.memory_included,
    false,
  );
  assert.equal(report.workloads.observatory.model_validation.verifier_process.terminated, true);
  assert.deepEqual(report.workloads.observatory.model_validation.target.dossier_lane_counts, {
    asked: 1,
    decided: 0,
    contract: 0,
    done: 20,
    verified: 5,
  });
  assert.equal(report.workloads.observatory.listen_host, "127.0.0.1");
  assert.equal(report.workloads.observatory.resources_closed, true);
  assert.equal(report.workloads.observatory.role, "observatory_server");
  assert.equal(
    report.workloads.observatory.memory_scope,
    "observatory_server_process_only",
  );
  assert.equal(report.workloads.observatory.load_driver.pid, process.pid);
  assert.equal(report.workloads.observatory.load_driver.memory_included, false);
  assert.notEqual(report.workloads.observatory.process.pid, process.pid);
  assert.equal(report.workloads.observatory.process.parent_pid, process.pid);
  assert.equal(report.workloads.observatory.process.exit_code, 0);
  assert.equal(report.workloads.observatory.process.terminated, true);
  assert.equal(report.workloads.observatory.process.isolated_from_parent, true);
  assert.equal(report.workloads.observatory.process.isolated_from_canonical_query, true);
  assert.equal(
    report.workloads.observatory.memory.source_pid,
    report.workloads.observatory.process.pid,
  );
  assert.equal(report.memory.aggregation, "maximum_of_isolated_workloads");
  assert.deepEqual(report.memory.canonical_query, report.workloads.canonical_query.memory);
  assert.deepEqual(report.memory.observatory, report.workloads.observatory.memory);
  assert.equal(
    report.memory.rss_bytes,
    Math.max(
      report.workloads.canonical_query.memory.rss_bytes,
      report.workloads.observatory.memory.rss_bytes,
    ),
  );
  assert.equal(
    report.memory.heap_used_bytes,
    Math.max(
      report.workloads.canonical_query.memory.heap_used_bytes,
      report.workloads.observatory.memory.heap_used_bytes,
    ),
  );
  assert.equal(
    report.memory.max_rss_bytes,
    Math.max(
      report.workloads.canonical_query.memory.max_rss_bytes,
      report.workloads.observatory.memory.max_rss_bytes,
    ),
  );
  assert.ok(report.memory.max_rss_bytes >= report.memory.rss_bytes);
  assert.equal(report.evaluation.counts_complete, true);
  assert.equal(report.evaluation.one_catalog_build, true);
  assert.equal(report.evaluation.workloads_isolated, true);
  assert.equal(report.evaluation.query_samples_within_ceiling, true);
  assert.equal(report.evaluation.conditional_cache_valid, true);
  assert.equal(
    report.evaluation.observatory_warm_target_met,
    report.workloads.observatory.warm_p95_ms
      <= report.thresholds.observatory_warm_target_p95_ms,
  );
  assert.equal(
    report.performance_warnings.length,
    report.evaluation.observatory_warm_target_met ? 0 : 1,
  );
  assert.equal(report.evaluation.rss_observed_bytes, report.memory.max_rss_bytes);
  assert.equal(report.evaluation.passed, true);
});

test("benchmark count gate rejects a wrong target-story trace distribution", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "enterprise-target-trace-gate-"));
  const fakeWorker = path.join(temporary, "wrong-target-trace.mjs");
  fs.writeFileSync(fakeWorker, [
    `import crypto from "node:crypto";`,
    `import fs from "node:fs";`,
    `const manifestPath = process.argv[process.argv.indexOf("--fixture-manifest") + 1];`,
    `const manifestBytes = fs.readFileSync(manifestPath);`,
    `const manifest = JSON.parse(manifestBytes);`,
    `const targetIndex = Math.floor(manifest.scale.records / 2);`,
    `const storyWidth = Math.max(6, String(manifest.scale.stories - 1).length);`,
    `const targetStory = "ST-ENT-" + String(targetIndex % manifest.scale.stories).padStart(storyWidth, "0");`,
    `process.stdout.write(JSON.stringify({`,
    `  schema_version: "enterprise-performance-canonical-query-worker:v1",`,
    `  ok: true, workload: "canonical_query",`,
    `  process: { pid: process.pid, parent_pid: process.ppid },`,
    `  result: {`,
    `    manifest_sha256: crypto.createHash("sha256").update(manifestBytes).digest("hex"),`,
    `    duration_ms: 0, canonical_files: manifest.file_counts.canonical_files,`,
    `    source_files: manifest.scale.source_files, stories: manifest.scale.stories,`,
    `    records: manifest.scale.records, dependency_edges: manifest.scale.dependency_edges,`,
    `    trace_events: manifest.scale.trace_events, target_story_trace_events: 0,`,
    `    target_record_found: true,`,
    `    target_record: {`,
    `      id: manifest.query_targets.record_id, path: manifest.query_targets.record_shard_path,`,
    `      line: (targetIndex % manifest.layout.records_per_shard) + 1,`,
    `      story_id: targetStory, sequence: targetIndex,`,
    `    },`,
    `    session_metrics: { catalog_builds: 1 },`,
    `    memory: { rss_bytes: 16777216, heap_used_bytes: 8388608, max_rss_bytes: 16777216 },`,
    `  },`,
    `}));`,
  ].join("\n"));
  try {
    const report = await runEnterprisePerformanceBenchmark({
      parentDirectory: temporary,
      platform: "win32",
      scale: SMALL_SCALE,
      warmIterations: 2,
      canonicalWorkerScriptPath: fakeWorker,
    });
    assert.equal(report.workloads.canonical_query.sampling.sample_count, 1);
    assert.equal(report.evaluation.counts_complete, false);
    assert.equal(report.evaluation.passed, false);
    assert.deepEqual(enterpriseFixtureEntries(temporary), []);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("Windows retry report gates every canonical sample and uses worst-sample RSS", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "enterprise-windows-query-samples-"));
  const fakeWorker = path.join(temporary, "sequenced-canonical-worker.mjs");
  const counterPath = path.join(temporary, "worker-count.txt");
  const mebibyte = 1024 * 1024;
  writeSequencedCanonicalWorker(fakeWorker, counterPath, [
    {
      duration_ms: 4_100,
      memory: {
        rss_bytes: 300 * mebibyte,
        heap_used_bytes: 40 * mebibyte,
        max_rss_bytes: 330 * mebibyte,
      },
    },
    { duration_ms: 3_900, catalog_builds: 2, wrong_counts: true },
    { duration_ms: 4_000 },
  ]);
  try {
    const report = await runEnterprisePerformanceBenchmark({
      parentDirectory: temporary,
      platform: "win32",
      scale: SMALL_SCALE,
      warmIterations: 2,
      canonicalWorkerScriptPath: fakeWorker,
    });
    const sampling = report.workloads.canonical_query.sampling;
    assert.equal(report.platform.os, process.platform);
    assert.deepEqual(report.platform.threshold_profile, {
      os: "win32",
      simulated: process.platform !== "win32",
    });
    assert.equal(fs.readFileSync(counterPath, "utf8"), "3");
    assert.equal(sampling.strategy, "windows_retry_numeric_median");
    assert.equal(sampling.sample_count, 3);
    assert.deepEqual(sampling.durations_ms, [4_100, 3_900, 4_000]);
    assert.equal(sampling.median_ms, 4_000);
    assert.equal(sampling.median_sample_index, 3);
    assert.equal(report.workloads.canonical_query.duration_ms, 4_000);
    assert.equal(sampling.samples.every((sample) => sample.evaluation.isolated), true);
    assert.equal(sampling.samples[1].evaluation.counts_complete, false);
    assert.equal(sampling.samples[1].evaluation.one_catalog_build, false);
    assert.equal(report.evaluation.counts_complete, false);
    assert.equal(report.evaluation.one_catalog_build, false);
    assert.equal(report.evaluation.workloads_isolated, true);
    assert.equal(report.evaluation.query_within_budget, true);
    assert.equal(report.evaluation.query_samples_within_ceiling, true);
    assert.equal(report.workloads.canonical_query.memory.max_rss_bytes, 330 * mebibyte);
    assert.equal(report.memory.max_rss_bytes, 330 * mebibyte);
    assert.equal(report.evaluation.rss_observed_bytes, 330 * mebibyte);
    assert.equal(report.evaluation.rss_within_budget, false);
    assert.equal(report.evaluation.passed, false);
    assert.deepEqual(enterpriseFixtureEntries(temporary), []);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("Windows retry fails an individual outlier above the 1.20x ceiling", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "enterprise-windows-query-ceiling-"));
  const fakeWorker = path.join(temporary, "sequenced-canonical-worker.mjs");
  const counterPath = path.join(temporary, "worker-count.txt");
  writeSequencedCanonicalWorker(fakeWorker, counterPath, [
    { duration_ms: 4_800.001 },
    { duration_ms: 3_999 },
    { duration_ms: 4_000 },
  ]);
  try {
    const report = await runEnterprisePerformanceBenchmark({
      parentDirectory: temporary,
      platform: "win32",
      scale: SMALL_SCALE,
      warmIterations: 2,
      canonicalWorkerScriptPath: fakeWorker,
    });
    assert.equal(fs.readFileSync(counterPath, "utf8"), "3");
    assert.equal(report.workloads.canonical_query.sampling.median_ms, 4_000);
    assert.equal(report.evaluation.query_within_budget, true);
    assert.equal(report.evaluation.query_samples_within_ceiling, false);
    assert.equal(report.evaluation.passed, false);
    assert.deepEqual(enterpriseFixtureEntries(temporary), []);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("Windows retry rejects a malformed later sample before starting Observatory", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "enterprise-windows-query-malformed-"));
  const fakeWorker = path.join(temporary, "sequenced-canonical-worker.mjs");
  const counterPath = path.join(temporary, "worker-count.txt");
  const observatoryWorker = path.join(temporary, "must-not-start.mjs");
  const observatoryMarker = path.join(temporary, "observatory-started.txt");
  writeSequencedCanonicalWorker(fakeWorker, counterPath, [
    { duration_ms: 4_100 },
    { malformed: true },
    { duration_ms: 3_900 },
  ]);
  fs.writeFileSync(observatoryWorker, [
    `import fs from "node:fs";`,
    `fs.writeFileSync(${JSON.stringify(observatoryMarker)}, "started", "utf8");`,
  ].join("\n"));
  try {
    await assert.rejects(
      runEnterprisePerformanceBenchmark({
        parentDirectory: temporary,
        platform: "win32",
        scale: SMALL_SCALE,
        warmIterations: 2,
        canonicalWorkerScriptPath: fakeWorker,
        observatoryWorkerScriptPath: observatoryWorker,
      }),
      /unsupported schema version/u,
    );
    assert.equal(fs.readFileSync(counterPath, "utf8"), "2");
    assert.equal(fs.existsSync(observatoryMarker), false);
    assert.deepEqual(enterpriseFixtureEntries(temporary), []);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("opt-in Observatory memory diagnostics expose stage breakdown and forced-GC deltas", async () => {
  const report = await runEnterprisePerformanceBenchmark({
    scale: SMALL_SCALE,
    warmIterations: 5,
    diagnosticMemoryTimeline: true,
    diagnosticForceGc: true,
  });

  const diagnostics = report.workloads.observatory.memory_diagnostics;
  assert.equal(diagnostics.force_gc, true);
  assert.equal(diagnostics.measured_at, "warm_after_forced_gc");
  const stages = diagnostics.timeline.map((entry) => entry.stage);
  for (const stage of [
    "worker_start",
    "observatory_module_loaded",
    "server_started",
    "cold_complete",
    "cold_after_forced_gc",
    "warm_1",
    "warm_3",
    "warm_5",
    "warm_complete",
    "warm_after_forced_gc",
    "resources_closed",
  ]) {
    assert.ok(stages.includes(stage), `missing memory diagnostic stage ${stage}`);
  }
  for (const snapshot of diagnostics.timeline) {
    assert.ok(snapshot.rss_bytes >= snapshot.heap_total_bytes);
    assert.ok(snapshot.heap_total_bytes >= snapshot.heap_used_bytes);
    assert.ok(snapshot.max_rss_bytes >= snapshot.rss_bytes);
    assert.ok(snapshot.external_bytes >= snapshot.array_buffers_bytes);
  }
});

test("canonical query worker protocol is machine-readable and complete", () => {
  const fixture = createEnterpriseFoundationFixture({
    scale: {
      source_files: 4,
      stories: 4,
      records: 8,
      dependency_edges: 6,
      trace_events: 12,
    },
  });
  try {
    const result = childProcess.spawnSync(process.execPath, [
      BENCHMARK_PATH,
      "--internal-canonical-query-worker",
      "--fixture-root", fixture.root,
      "--fixture-manifest", path.join(fixture.root, "fixture-manifest.json"),
      "--expected-manifest-sha256", sha256FileHex(path.join(fixture.root, "fixture-manifest.json")),
    ], {
      cwd: path.resolve(TEST_DIRECTORY, "../.."),
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    const envelope = parseCanonicalQueryWorkerEnvelope(result.stdout);
    assert.equal(envelope.schema_version, ENTERPRISE_CANONICAL_QUERY_WORKER_SCHEMA);
    assert.equal(
      envelope.result.manifest_sha256,
      sha256FileHex(path.join(fixture.root, "fixture-manifest.json")),
    );
    assert.notEqual(envelope.process.pid, process.pid);
    assert.equal(envelope.result.canonical_files, fixture.manifest.file_counts.canonical_files);
    assert.equal(envelope.result.source_files, fixture.manifest.scale.source_files);
    assert.equal(envelope.result.stories, fixture.manifest.scale.stories);
    assert.equal(envelope.result.records, fixture.manifest.scale.records);
    assert.equal(envelope.result.dependency_edges, fixture.manifest.scale.dependency_edges);
    assert.equal(envelope.result.trace_events, fixture.manifest.scale.trace_events);
    assert.equal(envelope.result.target_story_trace_events, 3);
    assert.equal(envelope.result.target_record_found, true);
    assert.deepEqual(envelope.result.target_record, {
      id: "REC-000004",
      path: ".sdlc/work-items/records-000000.jsonl",
      line: 5,
      story_id: "ST-ENT-000000",
      sequence: 4,
    });
    assert.equal(envelope.result.session_metrics.catalog_builds, 1);
    assert.equal(envelope.result.session_metrics.aggregate_json_lines_calls, 2);
    assert.equal(envelope.result.session_metrics.aggregate_files_scanned, 5);
    assert.equal(envelope.result.session_metrics.aggregate_records_retained, 1);
    assert.equal(envelope.result.session_metrics.read_json_lines_calls, 0);
    assert.ok(envelope.result.memory.max_rss_bytes > 0);
  } finally {
    fixture.cleanup();
  }
});

test("Observatory server worker uses ready and snapshot-close IPC around its lifetime", async () => {
  const fixture = createEnterpriseFoundationFixture({
    scale: {
      source_files: 4,
      stories: 4,
      records: 8,
      dependency_edges: 6,
      trace_events: 12,
    },
  });
  let child = null;
  try {
    child = childProcess.spawn(process.execPath, [
      BENCHMARK_PATH,
      "--internal-observatory-worker",
      "--fixture-root", fixture.root,
      "--fixture-manifest", path.join(fixture.root, "fixture-manifest.json"),
      "--expected-manifest-sha256", sha256FileHex(path.join(fixture.root, "fixture-manifest.json")),
      "--limits-json", JSON.stringify({ maxFiles: 2_048 }),
    ], {
      cwd: path.resolve(TEST_DIRECTORY, "../.."),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    });
    const terminationPromise = collectChildTermination(child, 10_000);
    const ready = parseObservatoryServerReadyMessage(
      await waitForIpcMessage(child, "ready", 10_000),
    );
    assert.equal(ready.role, "observatory_server");
    assert.equal(ready.memory_scope, "observatory_server_process_only");
    assert.equal(ready.load_driver.memory_included, false);
    assert.equal(ready.pid, ready.process.pid);
    assert.equal(ready.parent_pid, ready.process.parent_pid);
    assert.notEqual(ready.process.pid, process.pid);
    assert.equal(ready.process.parent_pid, process.pid);
    assert.equal(ready.server.host, "127.0.0.1");
    assert.ok(ready.server.port > 0);

    const completionPromise = waitForIpcMessage(child, "complete", 10_000);
    child.send({
      schema_version: ENTERPRISE_OBSERVATORY_WORKER_SCHEMA,
      type: "snapshot-and-close",
      command_id: "unit-snapshot",
      expected_requests: 0,
      expected_cold_responses: 0,
      expected_conditional_responses: 0,
    });
    const completion = parseObservatoryServerCompletionEnvelope(await completionPromise);
    assert.equal(completion.command_id, "unit-snapshot");
    assert.equal(completion.result.resources_closed, true);
    assert.equal(completion.result.memory.source_pid, completion.process.pid);
    assert.equal(
      completion.result.memory.attribution,
      "observatory_server_process_only",
    );
    assert.ok(completion.result.memory.max_rss_bytes > 0);

    const termination = await terminationPromise;
    assert.equal(termination.code, 0, termination.stderr);
    assert.equal(termination.signal, null, termination.stderr);
    assert.equal(termination.stdout, "");
    assert.equal(termination.stderr, "");
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    fixture.cleanup();
  }
});

test("standalone benchmark writes the same machine-readable result to --out", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "enterprise-performance-cli-"));
  const outputPath = path.join(temporary, "nested", "result.json");
  try {
    const result = childProcess.spawnSync(process.execPath, [
      BENCHMARK_PATH,
      "--source-files", "4",
      "--stories", "4",
      "--records", "8",
      "--dependency-edges", "6",
      "--trace-events", "12",
      "--warm-iterations", "2",
      "--diagnostic-memory-timeline",
      "--out", outputPath,
      "--enforce",
    ], {
      cwd: path.resolve(TEST_DIRECTORY, "../.."),
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    const stdoutReport = JSON.parse(result.stdout);
    const fileReport = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    assert.deepEqual(fileReport, stdoutReport);
    assert.equal(fileReport.fixture.cleanup, "completed");
    assert.equal(fileReport.evaluation.passed, true);
    assert.equal(fileReport.workloads.observatory.memory_diagnostics.force_gc, false);
    assert.equal(
      fileReport.workloads.observatory.memory_diagnostics.measured_at,
      "warm_complete",
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("standalone benchmark validation failures remain machine-readable", () => {
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

test("canonical query worker validation failures use the worker error protocol", () => {
  const result = childProcess.spawnSync(process.execPath, [
    BENCHMARK_PATH,
    "--internal-canonical-query-worker",
  ], {
    cwd: path.resolve(TEST_DIRECTORY, "../.."),
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  const report = JSON.parse(result.stdout);
  assert.equal(report.schema_version, ENTERPRISE_CANONICAL_QUERY_WORKER_SCHEMA);
  assert.equal(report.ok, false);
  assert.equal(report.workload, "canonical_query");
  assert.equal(report.error.code, "canonical_query_worker_failed");
  assert.match(report.error.message, /requires --fixture-root, --fixture-manifest and --expected-manifest-sha256/u);
  assert.throws(
    () => parseCanonicalQueryWorkerEnvelope(report),
    /did not return a successful canonical query result/u,
  );
});

test("Observatory worker validation failures use the IPC error protocol", async () => {
  const child = childProcess.spawn(process.execPath, [
    BENCHMARK_PATH,
    "--internal-observatory-worker",
  ], {
    cwd: path.resolve(TEST_DIRECTORY, "../.."),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  const terminationPromise = collectChildTermination(child, 10_000);
  const report = await waitForIpcMessage(child, "error", 10_000);
  assert.equal(report.schema_version, ENTERPRISE_OBSERVATORY_WORKER_SCHEMA);
  assert.equal(report.ok, false);
  assert.equal(report.workload, "observatory");
  assert.equal(report.error.code, "observatory_worker_failed");
  assert.match(report.error.message, /requires --fixture-root, --fixture-manifest/u);
  const termination = await terminationPromise;
  assert.equal(termination.code, 1, termination.stderr);
  assert.equal(termination.signal, null, termination.stderr);
  assert.equal(termination.stdout, "");
  assert.equal(termination.stderr, "");
});

test("parent reports stderr from a failed worker before attempting JSON parsing", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "enterprise-worker-stderr-"));
  const fakeWorker = path.join(temporary, "failed-worker.mjs");
  fs.writeFileSync(fakeWorker, [
    `process.stdout.write("{not-json");`,
    `process.stderr.write("deterministic worker failure\\n");`,
    `process.exitCode = 7;`,
  ].join("\n"));
  try {
    await assert.rejects(
      runEnterprisePerformanceBenchmark({
        parentDirectory: temporary,
        scale: SMALL_SCALE,
        warmIterations: 2,
        workerScriptPath: fakeWorker,
      }),
      /Canonical query worker failed: deterministic worker failure/u,
    );
    assert.deepEqual(enterpriseFixtureEntries(temporary), []);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("Observatory worker fails immediately when the fixture manifest changes between workers", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "enterprise-cold-failure-"));
  const fakeWorker = path.join(temporary, "corrupting-canonical-worker.mjs");
  writeCorruptingCanonicalWorker(fakeWorker);
  try {
    await assert.rejects(
      runEnterprisePerformanceBenchmark({
        parentDirectory: temporary,
        scale: SMALL_SCALE,
        warmIterations: 10_000,
        workerScriptPath: fakeWorker,
        observatoryWorkerTimeoutMs: 5_000,
      }),
      /Observatory server manifest SHA-256 does not match the parent fixture/u,
    );
    assert.deepEqual(enterpriseFixtureEntries(temporary), []);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("parent signals terminate the active worker, clean the fixture, and preserve termination", {
  timeout: 30_000,
}, async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "enterprise signal supervisor "));
  try {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      await assertSignalSupervisorCase({
        caseDirectory: path.join(temporary, signal.toLowerCase()),
        signal,
      });
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("a pre-existing signal listener runs once without blocking benchmark termination", {
  timeout: 15_000,
}, async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "enterprise external signal "));
  try {
    await assertSignalSupervisorCase({
      caseDirectory: temporary,
      signal: "SIGTERM",
      externalListener: true,
    });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("one shared signal coordinator cleans all concurrent benchmark guards before exit", {
  timeout: 20_000,
}, async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "enterprise concurrent signal "));
  try {
    await assertConcurrentSignalSupervisorCase(temporary, "SIGTERM");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("parent rejects malformed worker output and still removes its fixture", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "enterprise-performance-worker-error-"));
  const fakeWorker = path.join(temporary, "fake-worker.mjs");
  fs.writeFileSync(fakeWorker, [
    `process.stdout.write(${JSON.stringify(JSON.stringify({
      schema_version: "unsupported-worker:v1",
      ok: true,
      workload: "canonical_query",
      process: { pid: 1, parent_pid: 1 },
      result: {},
    }))});`,
  ].join("\n"));
  try {
    await assert.rejects(
      runEnterprisePerformanceBenchmark({
        parentDirectory: temporary,
        scale: SMALL_SCALE,
        warmIterations: 2,
        workerScriptPath: fakeWorker,
      }),
      /unsupported schema version/u,
    );
    assert.deepEqual(
      fs.readdirSync(temporary).filter((entry) => entry.startsWith("agentic-sdlc-enterprise-")),
      [],
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("canonical worker output flood triggers one bounded termination and fixture cleanup", {
  timeout: 10_000,
}, async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "enterprise-worker-output-flood-"));
  const fakeWorker = path.join(temporary, "output-flood.mjs");
  fs.writeFileSync(fakeWorker, [
    `const chunk = "x".repeat(256 * 1024);`,
    `for (let index = 0; index < 8; index += 1) process.stdout.write(chunk);`,
    `setInterval(() => {}, 1_000);`,
  ].join("\n"));
  try {
    const startedAt = Date.now();
    await assert.rejects(
      runEnterprisePerformanceBenchmark({
        parentDirectory: temporary,
        scale: SMALL_SCALE,
        warmIterations: 2,
        canonicalWorkerScriptPath: fakeWorker,
        canonicalWorkerTimeoutMs: 10_000,
      }),
      /exceeded the machine-readable output limit/u,
    );
    assert.ok(Date.now() - startedAt < 5_000, "output flood waited for the primary timeout");
    assert.deepEqual(enterpriseFixtureEntries(temporary), []);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("parent rejects malformed Observatory output and still removes its fixture", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "enterprise-observatory-error-"));
  const fakeWorker = path.join(temporary, "fake-observatory-worker.mjs");
  fs.writeFileSync(fakeWorker, [
    `process.stdout.write(JSON.stringify({`,
    `  schema_version: "unsupported-observatory-worker:v1",`,
    `  ok: true,`,
    `  workload: "observatory",`,
    `  process: { pid: process.pid, parent_pid: process.ppid },`,
    `  result: {},`,
    `}));`,
  ].join("\n"));
  try {
    await assert.rejects(
      runEnterprisePerformanceBenchmark({
        parentDirectory: temporary,
        scale: SMALL_SCALE,
        warmIterations: 2,
        observatoryWorkerScriptPath: fakeWorker,
      }),
      /wrote to stdout; IPC is required/u,
    );
    assert.deepEqual(
      fs.readdirSync(temporary).filter((entry) => entry.startsWith("agentic-sdlc-enterprise-")),
      [],
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("parent rejects a snapshot completion with the wrong IPC command ID", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "enterprise-observatory-command-"));
  const fakeWorker = path.join(temporary, "wrong-command-id.mjs");
  writeFakeObservatoryServerWorker(fakeWorker, { mode: "wrong-command" });
  try {
    await assert.rejects(
      runEnterprisePerformanceBenchmark({
        parentDirectory: temporary,
        scale: SMALL_SCALE,
        warmIterations: 2,
        observatoryWorkerScriptPath: fakeWorker,
      }),
      /different command ID/u,
    );
    assert.deepEqual(enterpriseFixtureEntries(temporary), []);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("parent rejects Observatory completion before ready/load/snapshot", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "enterprise-observatory-premature-"));
  const fakeWorker = path.join(temporary, "premature-completion.mjs");
  fs.writeFileSync(fakeWorker, [
    `process.send({ type: "complete" });`,
    `setInterval(() => {}, 1_000);`,
  ].join("\n"));
  try {
    await assert.rejects(
      runEnterprisePerformanceBenchmark({
        parentDirectory: temporary,
        scale: SMALL_SCALE,
        warmIterations: 2,
        observatoryWorkerScriptPath: fakeWorker,
      }),
      /completed while awaiting_ready/u,
    );
    assert.deepEqual(enterpriseFixtureEntries(temporary), []);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("parent applies a secondary exit deadline after valid Observatory completion", {
  timeout: 30_000,
}, async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "enterprise-observatory-complete-stay-"));
  const fakeWorker = path.join(temporary, "complete-and-stay.mjs");
  const eventTimestampPath = path.join(temporary, "completion-sent-at.txt");
  writeFakeObservatoryServerWorker(fakeWorker, {
    mode: "complete-and-stay",
    eventTimestampPath,
  });
  try {
    await assert.rejects(
      runEnterprisePerformanceBenchmark({
        parentDirectory: temporary,
        scale: SMALL_SCALE,
        warmIterations: 2,
        observatoryWorkerScriptPath: fakeWorker,
        observatoryWorkerTimeoutMs: 10_000,
      }),
      /did not exit after snapshot completion/u,
    );
    assertEventRejectedWithin(
      eventTimestampPath,
      5_000,
      "completed worker waited for the primary timeout",
    );
    assert.deepEqual(enterpriseFixtureEntries(temporary), []);
    const lateMessageWorker = path.join(temporary, "complete-then-late-message.mjs");
    writeFakeObservatoryServerWorker(lateMessageWorker, { mode: "complete-then-late-message" });
    const result = await runEnterprisePerformanceBenchmark({
      parentDirectory: temporary,
      scale: SMALL_SCALE,
      warmIterations: 2,
      observatoryWorkerScriptPath: lateMessageWorker,
    });
    assert.equal(result.ok, true);
    assert.equal(result.workloads.observatory.resources_closed, true);
    assert.deepEqual(enterpriseFixtureEntries(temporary), []);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("parent reports an Observatory server crash before the ready message", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "enterprise-observatory-crash-"));
  const fakeWorker = path.join(temporary, "crash-before-ready.mjs");
  fs.writeFileSync(fakeWorker, [
    `process.stderr.write("crash before ready\\n");`,
    `process.exitCode = 7;`,
  ].join("\n"));
  try {
    await assert.rejects(
      runEnterprisePerformanceBenchmark({
        parentDirectory: temporary,
        scale: SMALL_SCALE,
        warmIterations: 2,
        observatoryWorkerScriptPath: fakeWorker,
      }),
      /Observatory server worker failed: crash before ready/u,
    );
    assert.deepEqual(enterpriseFixtureEntries(temporary), []);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("parent times out and kills an Observatory server that never becomes ready", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "enterprise-observatory-timeout-"));
  const fakeWorker = path.join(temporary, "never-ready.mjs");
  fs.writeFileSync(fakeWorker, `setInterval(() => {}, 1_000);\n`);
  try {
    await assert.rejects(
      runEnterprisePerformanceBenchmark({
        parentDirectory: temporary,
        scale: SMALL_SCALE,
        warmIterations: 2,
        observatoryWorkerScriptPath: fakeWorker,
        observatoryWorkerTimeoutMs: 100,
      }),
      /timed out after 100ms/u,
    );
    assert.deepEqual(enterpriseFixtureEntries(temporary), []);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("isolated Observatory model verifier has its own bounded timeout", {
  timeout: 10_000,
}, async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "enterprise-model-verifier-timeout-"));
  const fakeVerifier = path.join(temporary, "hanging-verifier.mjs");
  fs.writeFileSync(fakeVerifier, `setInterval(() => {}, 1_000);\n`);
  try {
    const startedAt = Date.now();
    await assert.rejects(
      runEnterprisePerformanceBenchmark({
        parentDirectory: temporary,
        scale: SMALL_SCALE,
        warmIterations: 2,
        observatoryModelVerifierScriptPath: fakeVerifier,
        observatoryModelVerifierTimeoutMs: 100,
      }),
      /Observatory model verifier worker timed out after 100ms/u,
    );
    assert.ok(Date.now() - startedAt < 5_000, "verifier timeout exceeded its cleanup deadline");
    assert.deepEqual(enterpriseFixtureEntries(temporary), []);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("worker timeout kills descendants that keep inherited output handles open", {
  timeout: 10_000,
}, async () => {
  const workerTimeoutMs = 2_000;
  // This observation includes fixture construction and process scheduling,
  // while the worker timeout starts only after the worker has been spawned.
  const descendantMarkerTimeoutMs = 5_000;
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "enterprise-worker-tree-timeout-"));
  const fakeWorker = path.join(temporary, "worker-with-descendant.mjs");
  const descendantMarker = path.join(temporary, "descendant-pid.txt");
  fs.writeFileSync(fakeWorker, [
    `import { spawn } from "node:child_process";`,
    `import fs from "node:fs";`,
    `const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {`,
    `  detached: false,`,
    `  stdio: ["ignore", "inherit", "inherit"],`,
    `  windowsHide: true,`,
    `});`,
    `fs.writeFileSync(${JSON.stringify(descendantMarker)}, String(descendant.pid), "utf8");`,
    `setInterval(() => {}, 1_000);`,
  ].join("\n"));
  let descendantPid = null;
  try {
    const startedAt = Date.now();
    const [markerOutcome, timeoutOutcome] = await Promise.allSettled([
      waitForProcessIds(
        descendantMarker,
        1,
        descendantMarkerTimeoutMs,
      ),
      assert.rejects(
        runEnterprisePerformanceBenchmark({
          parentDirectory: temporary,
          scale: SMALL_SCALE,
          warmIterations: 2,
          canonicalWorkerScriptPath: fakeWorker,
          canonicalWorkerTimeoutMs: workerTimeoutMs,
        }),
        new RegExp(`timed out after ${workerTimeoutMs}ms`, "u"),
      ),
    ]);
    if (timeoutOutcome.status === "rejected") throw timeoutOutcome.reason;
    if (markerOutcome.status === "rejected") throw markerOutcome.reason;
    [descendantPid] = markerOutcome.value;
    assert.ok(Date.now() - startedAt < 5_000, "tree termination exceeded its secondary deadline");
    await waitForProcessExit(descendantPid, 2_000);
    assert.equal(isProcessAlive(descendantPid), false, "worker descendant survived tree termination");
    assert.deepEqual(enterpriseFixtureEntries(temporary), []);
  } finally {
    if (Number.isSafeInteger(descendantPid) && isProcessAlive(descendantPid)) {
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch {
        // The descendant exited between the liveness check and cleanup.
      }
    }
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("parent treats a live Observatory worker IPC disconnect as immediately terminal", {
  timeout: 30_000,
}, async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "enterprise-observatory-disconnect-"));
  const fakeWorker = path.join(temporary, "disconnect-and-wait.mjs");
  const eventTimestampPath = path.join(temporary, "disconnect-at.txt");
  fs.writeFileSync(fakeWorker, [
    `import { spawn } from "node:child_process";`,
    `import fs from "node:fs";`,
    ...delayedInheritedOutputHolderLines(1_500),
    `fs.writeFileSync(${JSON.stringify(eventTimestampPath)}, String(Date.now()), "utf8");`,
    `process.disconnect();`,
    `setInterval(() => {}, 1_000);`,
  ].join("\n"));
  try {
    await assert.rejects(
      runEnterprisePerformanceBenchmark({
        parentDirectory: temporary,
        scale: SMALL_SCALE,
        warmIterations: 2,
        observatoryWorkerScriptPath: fakeWorker,
        // Keep the primary deadline well outside process startup jitter from
        // the parallel full suite. The assertion below still proves that the
        // disconnect, rather than the deadline, owns the terminal outcome.
        observatoryWorkerTimeoutMs: 10_000,
      }),
      /disconnected before snapshot completion/u,
    );
    assertEventRejectedWithin(
      eventTimestampPath,
      5_000,
      "IPC disconnect waited for the primary timeout",
    );
    assert.deepEqual(enterpriseFixtureEntries(temporary), []);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("parent treats an Observatory IPC error message as immediately terminal", {
  timeout: 30_000,
}, async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "enterprise-observatory-ipc-error-"));
  const fakeWorker = path.join(temporary, "error-and-wait.mjs");
  const eventTimestampPath = path.join(temporary, "ipc-error-sent-at.txt");
  fs.writeFileSync(fakeWorker, [
    `import { spawn } from "node:child_process";`,
    `import fs from "node:fs";`,
    ...delayedInheritedOutputHolderLines(1_500),
    `fs.writeFileSync(${JSON.stringify(eventTimestampPath)}, String(Date.now()), "utf8");`,
    `process.send({`,
    `  schema_version: "enterprise-performance-observatory-worker:v1",`,
    `  type: "error", ok: false, workload: "observatory",`,
    `  error: { code: "fake_failure", message: "deterministic IPC failure" },`,
    `}, () => setInterval(() => {}, 1_000));`,
  ].join("\n"));
  try {
    await assert.rejects(
      runEnterprisePerformanceBenchmark({
        parentDirectory: temporary,
        scale: SMALL_SCALE,
        warmIterations: 2,
        observatoryWorkerScriptPath: fakeWorker,
        // Process startup on a saturated hosted Windows runner can exceed one
        // second. The event timestamp assertion below still proves that the
        // IPC error, rather than this outer deadline, owns the result.
        observatoryWorkerTimeoutMs: 10_000,
      }),
      /Observatory server worker failed: deterministic IPC failure/u,
    );
    assertEventRejectedWithin(
      eventTimestampPath,
      5_000,
      "IPC error waited for the primary timeout",
    );
    assert.deepEqual(enterpriseFixtureEntries(temporary), []);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("streaming load driver rejects a truncated cold model", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "enterprise-observatory-truncated-"));
  const fakeWorker = path.join(temporary, "truncated-server.mjs");
  writeFakeObservatoryServerWorker(fakeWorker, { mode: "truncated" });
  try {
    await assert.rejects(
      runEnterprisePerformanceBenchmark({
        parentDirectory: temporary,
        scale: SMALL_SCALE,
        warmIterations: 2,
        observatoryWorkerScriptPath: fakeWorker,
      }),
      /truncated|closed before completion|aborted/u,
    );
    assert.deepEqual(enterpriseFixtureEntries(temporary), []);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("streaming load driver rejects an oversized cold model before download", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "enterprise-observatory-oversized-"));
  const fakeWorker = path.join(temporary, "oversized-server.mjs");
  writeFakeObservatoryServerWorker(fakeWorker, { mode: "oversized" });
  try {
    await assert.rejects(
      runEnterprisePerformanceBenchmark({
        parentDirectory: temporary,
        scale: SMALL_SCALE,
        warmIterations: 2,
        observatoryWorkerScriptPath: fakeWorker,
      }),
      /exceeds the 67108864-byte cold-model limit/u,
    );
    assert.deepEqual(enterpriseFixtureEntries(temporary), []);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("parent RSS sentinel is explicitly excluded from Observatory server memory", async () => {
  const sentinelBytes = 96 * 1024 * 1024;
  const report = await runEnterprisePerformanceBenchmark({
    scale: SMALL_SCALE,
    warmIterations: 2,
    loadDriverMemorySentinelBytes: sentinelBytes,
  });

  const observatory = report.workloads.observatory;
  assert.equal(observatory.memory_scope, "observatory_server_process_only");
  assert.equal(observatory.load_driver.pid, process.pid);
  assert.equal(observatory.load_driver.memory_included, false);
  assert.equal(observatory.load_driver.sentinel_bytes, sentinelBytes);
  assert.ok(observatory.load_driver.rss_bytes_sample_before_load > report.memory.max_rss_bytes);
  assert.ok(observatory.load_driver.rss_bytes_sample_after_load > report.memory.max_rss_bytes);
  assert.equal(observatory.memory.source_pid, observatory.process.pid);
  assert.notEqual(observatory.memory.source_pid, observatory.load_driver.pid);
  assert.equal(
    report.memory.max_rss_bytes,
    Math.max(
      report.memory.canonical_query.max_rss_bytes,
      report.memory.observatory.max_rss_bytes,
    ),
  );
});

function coldResponseForBody(body) {
  const sha256 = crypto.createHash("sha256").update(body).digest("base64url");
  return {
    statusCode: 200,
    headers: { etag: `"sha256-${sha256}"` },
    body_bytes: body.byteLength,
    artifact_size_bytes: body.byteLength,
    content_length: body.byteLength,
    complete: true,
    sha256_base64url: sha256,
  };
}

function sha256FileHex(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function writeSequencedCanonicalWorker(filePath, counterPath, samples) {
  fs.writeFileSync(filePath, [
    `import crypto from "node:crypto";`,
    `import fs from "node:fs";`,
    `const samples = ${JSON.stringify(samples)};`,
    `const counterPath = ${JSON.stringify(counterPath)};`,
    `const sampleIndex = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, "utf8")) : 0;`,
    `fs.writeFileSync(counterPath, String(sampleIndex + 1), "utf8");`,
    `const sample = samples[sampleIndex];`,
    `if (!sample) throw new Error("unexpected canonical query sample");`,
    `if (sample.malformed) {`,
    `  process.stdout.write(JSON.stringify({ schema_version: "unsupported-worker:v1" }));`,
    `} else {`,
    `  const manifestPath = process.argv[process.argv.indexOf("--fixture-manifest") + 1];`,
    `  const manifestBytes = fs.readFileSync(manifestPath);`,
    `  const manifest = JSON.parse(manifestBytes);`,
    `  const targetIndex = Math.floor(manifest.scale.records / 2);`,
    `  const storyWidth = Math.max(6, String(manifest.scale.stories - 1).length);`,
    `  const targetStory = "ST-ENT-" + String(targetIndex % manifest.scale.stories).padStart(storyWidth, "0");`,
    `  const memory = sample.memory || {`,
    `    rss_bytes: 32 * 1024 * 1024,`,
    `    heap_used_bytes: 8 * 1024 * 1024,`,
    `    max_rss_bytes: 32 * 1024 * 1024,`,
    `  };`,
    `  process.stdout.write(JSON.stringify({`,
    `    schema_version: "enterprise-performance-canonical-query-worker:v1",`,
    `    ok: true, workload: "canonical_query",`,
    `    process: { pid: process.pid, parent_pid: process.ppid },`,
    `    result: {`,
    `      manifest_sha256: crypto.createHash("sha256").update(manifestBytes).digest("hex"),`,
    `      duration_ms: sample.duration_ms,`,
    `      canonical_files: manifest.file_counts.canonical_files,`,
    `      source_files: manifest.scale.source_files, stories: manifest.scale.stories,`,
    `      records: manifest.scale.records, dependency_edges: manifest.scale.dependency_edges,`,
    `      trace_events: manifest.scale.trace_events,`,
    `      target_story_trace_events: sample.wrong_counts`,
    `        ? 0`,
    `        : Math.ceil(manifest.scale.trace_events / manifest.file_counts.trace_files),`,
    `      target_record_found: true,`,
    `      target_record: {`,
    `        id: manifest.query_targets.record_id, path: manifest.query_targets.record_shard_path,`,
    `        line: (targetIndex % manifest.layout.records_per_shard) + 1,`,
    `        story_id: targetStory, sequence: targetIndex,`,
    `      },`,
    `      session_metrics: { catalog_builds: sample.catalog_builds ?? 1 },`,
    `      memory,`,
    `    },`,
    `  }));`,
    `}`,
  ].join("\n"));
}

function writeFakeObservatoryServerWorker(filePath, { mode, eventTimestampPath = null }) {
  const normalizerUrl = JSON.stringify(pathToFileURL(
    path.join(REPOSITORY_ROOT, "lib/change-observatory/normalizer.mjs"),
  ).href);
  fs.writeFileSync(filePath, [
    `import crypto from "node:crypto";`,
    `import fs from "node:fs";`,
    `import http from "node:http";`,
    `import { buildObservatoryViewModel } from ${normalizerUrl};`,
    `const schema = "enterprise-performance-observatory-worker:v1";`,
    `const mode = ${JSON.stringify(mode)};`,
    `const eventTimestampPath = ${JSON.stringify(eventTimestampPath)};`,
    `const fixtureRootIndex = process.argv.indexOf("--fixture-root");`,
    `const manifestIndex = process.argv.indexOf("--fixture-manifest");`,
    `const limitsIndex = process.argv.indexOf("--limits-json");`,
    `const fixtureRoot = process.argv[fixtureRootIndex + 1];`,
    `const manifest = JSON.parse(fs.readFileSync(process.argv[manifestIndex + 1], "utf8"));`,
    `const limits = JSON.parse(process.argv[limitsIndex + 1]);`,
    `const model = await buildObservatoryViewModel(fixtureRoot, {`,
    `  clock: () => new Date(manifest.generated_at),`,
    `  limits: { ...limits, maxCollectionItems: limits.maxCollectionItems ?? 1000 },`,
    `});`,
    `const body = Buffer.from(JSON.stringify(model), "utf8");`,
    `const etag = '"sha256-' + crypto.createHash("sha256").update(body).digest("base64url") + '"';`,
    `let requests = 0;`,
    `let coldResponses = 0;`,
    `let conditionalResponses = 0;`,
    `const server = http.createServer((request, response) => {`,
    `  requests += 1;`,
    `  if (mode === "oversized") {`,
    `    response.writeHead(200, {`,
    `      "Content-Length": String((64 * 1024 * 1024) + 1),`,
    `      "Content-Type": "application/json",`,
    `      ETag: etag,`,
    `    });`,
    `    response.end();`,
    `    return;`,
    `  }`,
    `  if (mode === "truncated") {`,
    `    coldResponses += 1;`,
    `    response.writeHead(200, {`,
    `      "Content-Length": String(body.byteLength + 10),`,
    `      "Content-Type": "application/json",`,
    `      "Connection": "close",`,
    `      ETag: etag,`,
    `    });`,
    `    response.end(body);`,
    `    return;`,
    `  }`,
    `  response.setHeader("ETag", etag);`,
    `  if (request.headers["if-none-match"] === etag) {`,
    `    conditionalResponses += 1;`,
    `    response.statusCode = 304;`,
    `    response.end();`,
    `    return;`,
    `  }`,
    `  coldResponses += 1;`,
    `  response.statusCode = 200;`,
    `  response.setHeader("Content-Length", String(body.byteLength));`,
    `  response.end(body);`,
    `});`,
    `await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));`,
    `const address = server.address();`,
    `const metadata = () => ({`,
    `  schema_version: schema, ok: true, workload: "observatory",`,
    `  role: "observatory_server", memory_scope: "observatory_server_process_only",`,
    `  load_driver: {`,
    `    role: "benchmark_parent_load_driver", pid: process.ppid, memory_included: false,`,
    `  },`,
    `  process: { pid: process.pid, parent_pid: process.ppid },`,
    `});`,
    `process.send({`,
    `  ...metadata(), type: "ready",`,
    `  pid: process.pid, parent_pid: process.ppid,`,
    `  host: "127.0.0.1", port: address.port, start_ms: 0,`,
    `  server: { host: "127.0.0.1", port: address.port, start_ms: 0 },`,
    `});`,
    `process.on("message", async (message) => {`,
    `  if (message?.type !== "snapshot-and-close") return;`,
    `  await new Promise((resolve) => server.close(resolve));`,
    `  const usage = process.memoryUsage();`,
    `  if (mode === "complete-and-stay" && eventTimestampPath) {`,
    `    fs.writeFileSync(eventTimestampPath, String(Date.now()), "utf8");`,
    `  }`,
    `  process.send({`,
    `    ...metadata(), type: "complete",`,
    `    command_id: mode === "wrong-command" ? "wrong-command" : message.command_id,`,
    `    result: {`,
    `      listen_host: "127.0.0.1", server_start_ms: 0,`,
    `      served_requests: requests, cold_responses: coldResponses,`,
    `      conditional_responses: conditionalResponses, resources_closed: true,`,
    `      memory: {`,
    `        rss_bytes: usage.rss, heap_used_bytes: usage.heapUsed, max_rss_bytes: usage.rss,`,
    `        attribution: "observatory_server_process_only", source_pid: process.pid,`,
    `      },`,
    `    },`,
    `  }, () => {`,
    `    if (mode === "complete-then-late-message") {`,
    `      process.send({ type: "late-message-after-completion" }, () => process.disconnect());`,
    `      return;`,
    `    }`,
    `    process.disconnect();`,
    `    if (mode === "complete-and-stay") setInterval(() => {}, 1_000);`,
    `  });`,
    `});`,
  ].join("\n"));
}

function assertEventRejectedWithin(eventTimestampPath, maximumElapsedMs, message) {
  const eventTimestamp = Number(fs.readFileSync(eventTimestampPath, "utf8"));
  assert.ok(Number.isSafeInteger(eventTimestamp), "worker event timestamp must be an integer");
  const elapsedMs = Date.now() - eventTimestamp;
  assert.ok(elapsedMs >= 0, "worker event timestamp cannot be in the future");
  assert.ok(elapsedMs <= maximumElapsedMs, `${message}: ${elapsedMs}ms`);
}

function delayedInheritedOutputHolderLines(delayMs) {
  return [
    `const outputHolder = spawn(process.execPath, [`,
    `  "-e", ${JSON.stringify(`setTimeout(() => {}, ${delayMs});`)},`,
    `], {`,
    `  detached: true,`,
    `  stdio: ["ignore", "inherit", "inherit"],`,
    `  windowsHide: true,`,
    `});`,
    `outputHolder.unref();`,
  ];
}

function canonicalWorkerEnvelope(memory) {
  return {
    schema_version: ENTERPRISE_CANONICAL_QUERY_WORKER_SCHEMA,
    ok: true,
    workload: "canonical_query",
    process: { pid: 101, parent_pid: 100 },
    result: {
      manifest_sha256: "a".repeat(64),
      canonical_files: 1,
      source_files: 1,
      stories: 1,
      records: 1,
      dependency_edges: 1,
      trace_events: 1,
      target_story_trace_events: 1,
      target_record_found: true,
      target_record: {
        id: "REC-000000",
        path: ".sdlc/work-items/records-000000.jsonl",
        line: 1,
        story_id: "ST-ENT-000000",
        sequence: 0,
      },
      duration_ms: 1,
      session_metrics: { catalog_builds: 1 },
      memory,
    },
  };
}

function observatoryWorkerEnvelope(memory) {
  return {
    schema_version: ENTERPRISE_OBSERVATORY_WORKER_SCHEMA,
    type: "complete",
    command_id: "snapshot-1",
    ok: true,
    workload: "observatory",
    role: "observatory_server",
    memory_scope: "observatory_server_process_only",
    load_driver: {
      role: "benchmark_parent_load_driver",
      pid: 100,
      memory_included: false,
      sentinel_bytes: 0,
      rss_bytes_sample_before_load: 32 * 1024 * 1024,
      rss_bytes_sample_after_load: 32 * 1024 * 1024,
    },
    process: { pid: 101, parent_pid: 100 },
    result: {
      listen_host: "127.0.0.1",
      served_requests: 2,
      cold_responses: 1,
      conditional_responses: 1,
      cold_status: 200,
      model_bytes: 1,
      etag: `"sha256-${"a".repeat(43)}"`,
      warm_iterations: 1,
      conditional_hits: 1,
      conditional_body_bytes: 0,
      model_validation: {
        passed: true,
        schema_version: "change-observatory:view:v1",
        generated_at: "2026-01-01T00:00:00.000Z",
        project_id: "enterprise-foundation-fixture",
        manifest_sha256: "a".repeat(64),
        artifact: {
          size_bytes: 1,
          sha256_base64url: "a".repeat(43),
          max_bytes: 64 * 1024 * 1024,
        },
        verifier_process: {
          pid: 102,
          parent_pid: 100,
          exit_code: 0,
          signal: null,
          terminated: true,
          elapsed_ms: 1,
          role: "observatory_model_semantic_verifier",
          memory_included: false,
        },
        snapshots: {
          iterations: 1,
          dossiers: 1,
          records: 1,
          changes: 1,
          verification: 1,
        },
        target: {
          story_id: "ST-ENT-000000",
          story_path: ".sdlc/stories/ST-ENT-000000/story.json",
          dossier_lane_counts: { asked: 1, decided: 0, contract: 0, done: 0, verified: 1 },
        },
      },
      server_start_ms: 1,
      cold_model_ms: 1,
      warm_min_ms: 1,
      warm_median_ms: 1,
      warm_p95_ms: 1,
      warm_max_ms: 1,
      resources_closed: true,
      memory: {
        ...memory,
        attribution: "observatory_server_process_only",
        source_pid: 101,
      },
    },
  };
}

function enterpriseFixtureEntries(parentDirectory) {
  return fs.readdirSync(parentDirectory)
    .filter((entry) => entry.startsWith("agentic-sdlc-enterprise-"));
}

function writeCorruptingCanonicalWorker(filePath) {
  fs.writeFileSync(filePath, [
    `import fs from "node:fs";`,
    `const manifestIndex = process.argv.indexOf("--fixture-manifest");`,
    `const manifestPath = process.argv[manifestIndex + 1];`,
    `const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));`,
    `manifest.generated_at = "not-a-date";`,
    `fs.writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");`,
    `process.stdout.write(JSON.stringify({`,
    `  schema_version: "enterprise-performance-canonical-query-worker:v1",`,
    `  ok: true,`,
    `  workload: "canonical_query",`,
    `  process: { pid: process.pid, parent_pid: process.ppid },`,
    `  result: {`,
    `    manifest_sha256: "${"a".repeat(64)}",`,
    `    duration_ms: 0,`,
    `    canonical_files: manifest.file_counts.canonical_files,`,
    `    source_files: manifest.scale.source_files,`,
    `    stories: manifest.scale.stories,`,
    `    records: manifest.scale.records,`,
    `    dependency_edges: manifest.scale.dependency_edges,`,
    `    trace_events: manifest.scale.trace_events,`,
    `    target_story_trace_events: 1,`,
    `    target_record_found: true,`,
    `    target_record: {`,
    `      id: manifest.query_targets.record_id,`,
    `      path: manifest.query_targets.record_shard_path,`,
    `      line: Math.floor(manifest.scale.records / 2) + 1,`,
    `      story_id: manifest.query_targets.story_id,`,
    `      sequence: Math.floor(manifest.scale.records / 2),`,
    `    },`,
    `    session_metrics: { catalog_builds: 1 },`,
    `    memory: { rss_bytes: 16777216, heap_used_bytes: 8388608, max_rss_bytes: 16777216 },`,
    `  },`,
    `}));`,
  ].join("\n"));
}

async function assertSignalSupervisorCase({
  caseDirectory,
  signal,
  externalListener = false,
}) {
  const fixtureParent = path.join(caseDirectory, "fixture parent");
  const markerPath = path.join(caseDirectory, "worker-pid.txt");
  const externalMarkerPath = path.join(caseDirectory, "external-signal.txt");
  const workerPath = path.join(caseDirectory, "waiting worker.mjs");
  const runnerPath = path.join(caseDirectory, "benchmark parent.mjs");
  fs.mkdirSync(fixtureParent, { recursive: true });
  writeSignalSupervisorScripts({ workerPath, runnerPath });

  const parent = childProcess.spawn(process.execPath, [runnerPath], {
    cwd: REPOSITORY_ROOT,
    env: {
      ...process.env,
      ENTERPRISE_SIGNAL_FIXTURE_PARENT: fixtureParent,
      ENTERPRISE_SIGNAL_MARKER: markerPath,
      ENTERPRISE_SIGNAL_WORKER: workerPath,
      ...(externalListener ? {
        ENTERPRISE_EXTERNAL_SIGNAL: signal,
        ENTERPRISE_EXTERNAL_SIGNAL_MARKER: externalMarkerPath,
      } : {}),
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  let workerPid = null;
  try {
    [workerPid] = await waitForProcessIds(markerPath, 1, 10_000);
    if (process.platform === "win32") {
      parent.send({ type: "emit-signal", signal });
    } else {
      assert.equal(parent.kill(signal), true);
    }

    const termination = await collectChildTermination(parent, 10_000);
    const conventionalExit = process.platform === "win32" || externalListener;
    if (conventionalExit) {
      assert.equal(termination.signal, null, termination.stderr);
      assert.equal(termination.code, signal === "SIGINT" ? 130 : 143, termination.stderr);
    } else {
      assert.equal(termination.signal, signal, termination.stderr);
      assert.equal(termination.code, null, termination.stderr);
    }
    if (externalListener) {
      assert.equal(fs.readFileSync(externalMarkerPath, "utf8"), `${signal}\n`);
    }
    assert.deepEqual(enterpriseFixtureEntries(fixtureParent), []);
    await waitForProcessExit(workerPid, 2_000);
    assert.equal(isProcessAlive(workerPid), false, `worker ${workerPid} survived ${signal}`);
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
    if (workerPid && isProcessAlive(workerPid)) {
      try {
        process.kill(workerPid, "SIGKILL");
      } catch {
        // The process exited between the liveness check and cleanup.
      }
    }
  }
}

async function assertConcurrentSignalSupervisorCase(caseDirectory, signal) {
  const fixtureParent = path.join(caseDirectory, "fixture parent");
  const markerPath = path.join(caseDirectory, "worker-pids.txt");
  const workerPath = path.join(caseDirectory, "waiting worker.mjs");
  const runnerPath = path.join(caseDirectory, "benchmark parent.mjs");
  fs.mkdirSync(fixtureParent, { recursive: true });
  writeConcurrentSignalSupervisorScripts({ workerPath, runnerPath });

  const parent = childProcess.spawn(process.execPath, [runnerPath], {
    cwd: REPOSITORY_ROOT,
    env: {
      ...process.env,
      ENTERPRISE_SIGNAL_FIXTURE_PARENT: fixtureParent,
      ENTERPRISE_SIGNAL_MARKER: markerPath,
      ENTERPRISE_SIGNAL_WORKER: workerPath,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  let workerPids = [];
  try {
    workerPids = await waitForProcessIds(markerPath, 2, 10_000);
    assert.equal(new Set(workerPids).size, 2);
    if (process.platform === "win32") {
      parent.send({ type: "emit-signal", signal });
    } else {
      assert.equal(parent.kill(signal), true);
    }

    const termination = await collectChildTermination(parent, 10_000);
    if (process.platform === "win32") {
      assert.equal(termination.signal, null, termination.stderr);
      assert.equal(termination.code, 143, termination.stderr);
    } else {
      assert.equal(termination.signal, signal, termination.stderr);
      assert.equal(termination.code, null, termination.stderr);
    }
    assert.deepEqual(enterpriseFixtureEntries(fixtureParent), []);
    for (const workerPid of workerPids) {
      await waitForProcessExit(workerPid, 2_000);
      assert.equal(isProcessAlive(workerPid), false, `worker ${workerPid} survived ${signal}`);
    }
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
    for (const workerPid of workerPids) {
      if (!isProcessAlive(workerPid)) continue;
      try {
        process.kill(workerPid, "SIGKILL");
      } catch {
        // The process exited between the liveness check and cleanup.
      }
    }
  }
}

function writeSignalSupervisorScripts({ workerPath, runnerPath }) {
  fs.writeFileSync(workerPath, [
    `import fs from "node:fs";`,
    `fs.writeFileSync(process.env.ENTERPRISE_SIGNAL_MARKER, String(process.pid), "utf8");`,
    `setInterval(() => {}, 1_000);`,
  ].join("\n"));

  const benchmarkUrl = JSON.stringify(pathToFileURL(BENCHMARK_PATH).href);
  fs.writeFileSync(runnerPath, [
    `import fs from "node:fs";`,
    `import { runEnterprisePerformanceBenchmark } from ${benchmarkUrl};`,
    `const externalSignal = process.env.ENTERPRISE_EXTERNAL_SIGNAL;`,
    `if (externalSignal) {`,
    `  process.on(externalSignal, () => {`,
    `    fs.appendFileSync(process.env.ENTERPRISE_EXTERNAL_SIGNAL_MARKER, externalSignal + "\\n");`,
    `  });`,
    `}`,
    `process.on("message", (message) => {`,
    `  if (message?.type === "emit-signal") process.emit(message.signal);`,
    `});`,
    `await runEnterprisePerformanceBenchmark({`,
    `  parentDirectory: process.env.ENTERPRISE_SIGNAL_FIXTURE_PARENT,`,
    `  scale: { source_files: 2, stories: 2, records: 2, dependency_edges: 1, trace_events: 2 },`,
    `  warmIterations: 1,`,
    `  observatoryWorkerScriptPath: process.env.ENTERPRISE_SIGNAL_WORKER,`,
    `});`,
  ].join("\n"));
}

function writeConcurrentSignalSupervisorScripts({ workerPath, runnerPath }) {
  fs.writeFileSync(workerPath, [
    `import fs from "node:fs";`,
    `fs.appendFileSync(process.env.ENTERPRISE_SIGNAL_MARKER, String(process.pid) + "\\n", "utf8");`,
    `setInterval(() => {}, 1_000);`,
  ].join("\n"));

  const benchmarkUrl = JSON.stringify(pathToFileURL(BENCHMARK_PATH).href);
  fs.writeFileSync(runnerPath, [
    `import { runEnterprisePerformanceBenchmark } from ${benchmarkUrl};`,
    `process.on("message", (message) => {`,
    `  if (message?.type === "emit-signal") process.emit(message.signal);`,
    `});`,
    `const common = {`,
    `  parentDirectory: process.env.ENTERPRISE_SIGNAL_FIXTURE_PARENT,`,
    `  warmIterations: 1,`,
    `  observatoryWorkerScriptPath: process.env.ENTERPRISE_SIGNAL_WORKER,`,
    `};`,
    `await Promise.all([`,
    `  runEnterprisePerformanceBenchmark({`,
    `    ...common,`,
    `    scale: { source_files: 2, stories: 2, records: 2, dependency_edges: 1, trace_events: 2 },`,
    `  }),`,
    `  runEnterprisePerformanceBenchmark({`,
    `    ...common,`,
    `    scale: { source_files: 80, stories: 80, records: 160, dependency_edges: 80, trace_events: 800 },`,
    `  }),`,
    `]);`,
  ].join("\n"));
}

function waitForIpcMessage(child, type, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for IPC message ${type}`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("close", onClose);
    };
    const onMessage = (message) => {
      if (message?.type !== type) return;
      cleanup();
      resolve(message);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = (code, signal) => {
      cleanup();
      reject(new Error(
        `child exited before IPC message ${type}: ${signal || `exit ${code}`}`,
      ));
    };
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

function collectChildTermination(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timeout = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      reject(new Error(`benchmark parent did not terminate within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function waitForProcessIds(filePath, expectedCount, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      const pids = fs.readFileSync(filePath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map(Number);
      if (pids.length >= expectedCount && pids.every((pid) => Number.isSafeInteger(pid) && pid > 0)) {
        return pids.slice(0, expectedCount);
      }
    }
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${expectedCount} worker process IDs in ${filePath}`);
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await delay(10);
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
