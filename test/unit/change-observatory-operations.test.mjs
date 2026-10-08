import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import os from "node:os";
import test from "node:test";

import {
  classifyObservatoryRoute,
  createObservatoryOperations,
} from "../../lib/change-observatory/operations.mjs";
import { verifySupportBundleDigest } from "../../lib/observability/support-bundle.mjs";

const UUIDS = Object.freeze([
  "123e4567-e89b-12d3-a456-426614174000",
  "123e4567-e89b-12d3-a456-426614174001",
  "123e4567-e89b-12d3-a456-426614174002",
  "123e4567-e89b-12d3-a456-426614174003",
  "123e4567-e89b-12d3-a456-426614174004",
]);

test("request operations accept only validated correlation IDs and generate a safe fallback", () => {
  const operations = createOperations();
  const provided = operations.beginRequest("CORR-123E4567-E89B-12D3-A456-426614174099");
  assert.equal(
    provided.context.correlation_id,
    "corr-123e4567-e89b-12d3-a456-426614174099",
  );
  assert.equal(provided.invalidCorrelation, null);

  const invalid = operations.beginRequest("customer@example.com");
  assert.match(invalid.context.correlation_id, /^corr-[a-f0-9-]{36}$/u);
  assert.equal(invalid.invalidCorrelation.code, "invalid_correlation_id");
  assert.equal(invalid.invalidCorrelation.statusCode, 400);
  assert.equal(invalid.invalidCorrelation.correlationId, invalid.context.correlation_id);
  assert.doesNotMatch(invalid.invalidCorrelation.message, /customer@example\.com/u);
});

test("route classification has a closed, non-user-controlled vocabulary", () => {
  assert.deepEqual(
    [
      "/api/v1/health",
      "/api/v1/live",
      "/api/v1/ready",
      "/api/v1/observatory",
      "/api/v1/source",
      "/api/v1/portfolio",
      "/api/v1/portfolio/project",
      "/api/v1/portfolio/source",
      "/api/v1/metrics",
      "/api/v1/slo",
      "/api/v1/support-bundle",
      "/app.js",
      "/api/v1/customer-provided-value",
    ].map(classifyObservatoryRoute),
    [
      "live",
      "live",
      "ready",
      "model",
      "source",
      "portfolio",
      "portfolio_project",
      "portfolio_source",
      "metrics",
      "slo",
      "support_bundle",
      "static",
      "unknown",
    ],
  );
});

test("operations expose closed-cardinality request, cache, and readiness metrics", () => {
  const operations = createOperations({ minimumSamples: 2 });
  const model = operations.beginRequest();
  operations.recordCacheEvent({ type: "request" });
  operations.recordCacheEvent({ type: "build_start" });
  operations.recordCacheEvent({ type: "build_success" });
  operations.recordCacheEvent({ type: "portfolio_dispose_deferred" });
  operations.recordCacheEvent({ type: "customer-controlled-event" });
  operations.recordRequest({ requestState: model, route: "model", statusCode: 304 });

  const invalid = operations.beginRequest("not-a-correlation-id");
  operations.recordRequest({
    requestState: invalid,
    route: "customer-controlled-route",
    statusCode: 503,
    code: "contains spaces and an email owner@example.com",
  });
  operations.recordReadiness({ context: model.context, ready: true });
  operations.recordReadiness({ context: invalid.context, ready: false, code: "model_unavailable" });

  const metrics = operations.metricsSnapshot();
  assert.equal(metrics.externalSinks, "disabled");
  assert.equal(metrics.cardinality, "closed");
  assert.equal(metricValue(metrics, "observatory_http_requests_total", {
    route: "model",
    status_class: "3xx",
  }), 1);
  assert.equal(metricValue(metrics, "observatory_http_requests_total", {
    route: "unknown",
    status_class: "5xx",
  }), 1);
  assert.equal(metricValue(metrics, "observatory_model_cache_events_total", {
    event: "build_start",
  }), 1);
  assert.equal(metricValue(metrics, "observatory_model_cache_events_total", {
    event: "build_success",
  }), 1);
  assert.equal(metricValue(metrics, "observatory_model_cache_events_total", {
    event: "portfolio_dispose_deferred",
  }), 1);
  assert.equal(metricValue(metrics, "observatory_readiness_checks_total", {
    outcome: "ready",
  }), 1);
  assert.equal(metricValue(metrics, "observatory_readiness_checks_total", {
    outcome: "not_ready",
  }), 1);
  assert.doesNotMatch(JSON.stringify(metrics), /customer-controlled|owner@example\.com/u);

  const slo = operations.sloSnapshot();
  assert.equal(slo.mode, "advisory");
  assert.equal(slo.evaluations.length, 2);
  assert.deepEqual(
    slo.evaluations.map(({ name, status }) => [name, status]),
    [
      ["observatory_availability", "breached"],
      ["observatory_readiness", "breached"],
    ],
  );
});

test("support bundle is allowlisted, redacted, bounded, and content-verifiable", () => {
  const operations = createOperations({ maxRecentRequests: 2 });
  for (const [index, route] of ["source", "model", "ready"].entries()) {
    const requestState = operations.beginRequest();
    operations.recordRequest({
      requestState,
      route,
      statusCode: 200 + index,
      code: index === 2 ? "ready" : "ok",
    });
  }
  const context = operations.beginRequest().context;
  const bundle = operations.supportBundle({
    context,
    limits: {
      maxSourceBytes: 1_000,
      token: "CANARY-TOKEN-MUST-NOT-LEAK",
      projectRoot: "/private/CANARY-ROOT-MUST-NOT-LEAK",
    },
  });

  assert.equal(bundle.schema_version, "agentic-sdlc-support-bundle:v1");
  assert.equal(bundle.integrity.assurance, "content_integrity_only_not_authenticity");
  assert.equal(verifySupportBundleDigest(bundle), true);
  assert.deepEqual(bundle.included_sections, [
    "limits",
    "metrics",
    "readiness",
    "recent_requests",
    "slo",
    "versions",
  ]);
  assert.equal(bundle.sections.recent_requests.length, 2);
  assert.equal(Object.hasOwn(bundle.sections.limits, "token"), false);
  assert.equal(Object.hasOwn(bundle.sections.limits, "projectRoot"), false);
  assert.doesNotMatch(
    JSON.stringify(bundle),
    /CANARY-TOKEN-MUST-NOT-LEAK|CANARY-ROOT-MUST-NOT-LEAK|\/private\//u,
  );

  const tampered = JSON.parse(JSON.stringify(bundle));
  tampered.sections.readiness.status = "ready";
  assert.equal(verifySupportBundleDigest(tampered), false);
});

test("support bundle versions name the package, platform, and architecture without host details", async () => {
  const packageMetadata = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );
  const bundle = createOperations().supportBundle({
    context: createOperations().beginRequest().context,
    limits: {},
  });
  const versions = bundle.sections.versions;
  assert.equal(versions.package, packageMetadata.version);
  assert.equal(versions.platform, process.platform);
  assert.equal(versions.arch, process.arch);
  assert.equal(versions.node, process.versions.node);
  assert.deepEqual(Object.keys(versions).sort(), [
    "arch", "healthSchema", "modelSchema", "node", "package", "platform",
  ]);
  const serialized = JSON.stringify(bundle);
  for (const hostDetail of [os.hostname(), process.cwd(), os.homedir()]) {
    if (hostDetail.length >= 6) assert.equal(serialized.includes(hostDetail), false, hostDetail);
  }
  assert.equal(verifySupportBundleDigest(bundle), true);

  const injected = createOperations({ packageVersion: "9.8.7" }).supportBundle({
    context: createOperations().beginRequest().context,
    limits: {},
  });
  assert.equal(injected.sections.versions.package, "9.8.7");
  const unsafe = createOperations({ packageVersion: "/home/alice/pkg" }).supportBundle({
    context: createOperations().beginRequest().context,
    limits: {},
  });
  assert.equal(unsafe.sections.versions.package, "unknown");
});

test("recent request retention rejects values above the configured hard bound", () => {
  assert.throws(
    () => createOperations({ maxRecentRequests: 1_001 }),
    /no greater than 1000/u,
  );
});

function createOperations(overrides = {}) {
  let index = 0;
  return createObservatoryOperations({
    clock: () => new Date("2026-07-18T12:00:00.000Z"),
    randomUUID: () => UUIDS[index++ % UUIDS.length],
    ...overrides,
  });
}

function metricValue(payload, name, labels) {
  const metric = payload.snapshot.metrics.find((candidate) => candidate.name === name);
  assert.ok(metric, `missing metric ${name}`);
  const expected = JSON.stringify(labels);
  const series = metric.series.find((candidate) => JSON.stringify(candidate.labels) === expected);
  assert.ok(series, `missing series ${name} ${JSON.stringify(labels)}`);
  return series.value;
}
