import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startObservatoryServer } from "../../lib/change-observatory/server.mjs";

const CORRELATION_PATTERN = /^corr-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;

test("serves authenticated portfolio summary, detail, and isolated source representations", async (t) => {
  const fixture = await createPortfolioFixture(t);
  const running = await startObservatoryServer({
    projectRoot: fixture.root,
    portfolioManifest: "portfolio.json",
    clock: () => new Date("2026-07-19T11:00:00Z"),
  });
  t.after(() => running.close());

  assert.equal(running.modelUrl, running.portfolioUrl);
  assert.equal(new URL(running.accessUrl).searchParams.get("mode"), "portfolio");
  const health = await request(running, "/api/v1/health", { authenticated: false });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json.modelSchemaVersion, "change-observatory:portfolio:v1");

  const summary = await request(running, "/api/v1/portfolio");
  assert.equal(summary.statusCode, 200);
  assert.equal(summary.json.schemaVersion, "change-observatory:portfolio:v1");
  assert.equal(summary.json.status, "degraded");
  assert.deepEqual(summary.json.projects.map((project) => project.id), ["alpha", "beta", "broken"]);
  assert.deepEqual(summary.json.projects.map((project) => project.status), [
    "available",
    "available",
    "unavailable",
  ]);
  assert.match(summary.json.projects[2].message, /privacy settings/u);
  assert.doesNotMatch(summary.body, new RegExp(`${escapeRegExp(fixture.root)}|BROKEN-CANARY`, "u"));
  assert.match(summary.headers.etag, /^"sha256-[A-Za-z0-9_-]+"$/u);
  assert.match(summary.headers["x-correlation-id"], CORRELATION_PATTERN);
  assert.match(summary.headers["content-security-policy"], /frame-ancestors 'none'/u);

  const summaryHead = await request(running, "/api/v1/portfolio", { method: "HEAD" });
  assert.equal(summaryHead.statusCode, 200);
  assert.equal(summaryHead.body, "");
  assert.equal(summaryHead.headers.etag, summary.headers.etag);
  const summaryCached = await request(running, "/api/v1/portfolio", {
    headers: { "If-None-Match": summary.headers.etag },
  });
  assert.equal(summaryCached.statusCode, 304);
  assert.equal(summaryCached.body, "");

  const ready = await request(running, "/api/v1/ready");
  assert.equal(ready.statusCode, 200);
  assert.equal(ready.json.status, "ready");

  const detail = await request(running, "/api/v1/portfolio/project?project=alpha");
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json.schemaVersion, "change-observatory:view:v1");
  const rawHrefs = collectStringFields(detail.json, "rawHref").filter(Boolean);
  assert.ok(rawHrefs.length > 0);
  assert.ok(rawHrefs.every((href) => href.startsWith(
    "/api/v1/portfolio/source?project=alpha&path=",
  )));
  assert.match(detail.headers.etag, /^"sha256-[A-Za-z0-9_-]+"$/u);

  const sourcePath = encodeURIComponent(".sdlc/project.json");
  const source = await request(
    running,
    `/api/v1/portfolio/source?project=alpha&path=${sourcePath}`,
  );
  assert.equal(source.statusCode, 200);
  assert.equal(source.json.data.project_id, "alpha-project");
  assert.match(source.headers.etag, /^"sha256-[A-Za-z0-9_-]+"$/u);
  const sourceCached = await request(
    running,
    `/api/v1/portfolio/source?project=alpha&path=${sourcePath}`,
    { headers: { "If-None-Match": source.headers.etag } },
  );
  assert.equal(sourceCached.statusCode, 304);
  const sourceHead = await request(
    running,
    `/api/v1/portfolio/source?project=alpha&path=${sourcePath}`,
    { method: "HEAD" },
  );
  assert.equal(sourceHead.statusCode, 200);
  assert.equal(sourceHead.body, "");
  assert.equal(sourceHead.headers.etag, source.headers.etag);

  const isolated = await request(
    running,
    `/api/v1/portfolio/source?project=alpha&path=${encodeURIComponent(".sdlc/beta-only.json")}`,
  );
  assert.equal(isolated.statusCode, 404);
  assert.equal(isolated.json.error.code, "source_not_found");
  const betaSource = await request(
    running,
    `/api/v1/portfolio/source?project=beta&path=${encodeURIComponent(".sdlc/beta-only.json")}`,
  );
  assert.equal(betaSource.statusCode, 200);
  assert.equal(betaSource.json.data.owner, "beta");

  const metrics = await request(running, "/api/v1/metrics");
  const requestMetric = metrics.json.snapshot.metrics.find(
    (metric) => metric.name === "observatory_http_requests_total",
  );
  assert.ok(requestMetric.series.some(
    (series) => series.labels.route === "portfolio" && series.value >= 1,
  ));
  const cacheMetric = metrics.json.snapshot.metrics.find(
    (metric) => metric.name === "observatory_model_cache_events_total",
  );
  assert.ok(cacheMetric.series.some(
    (series) => series.labels.event === "portfolio_miss" && series.value >= 1,
  ));
  const support = await request(running, "/api/v1/support-bundle");
  assert.equal(
    support.json.sections.versions.modelSchema,
    "change-observatory:portfolio:v1",
  );
});

test("validates portfolio concurrency before binding and disposes cached runtimes on close", async (t) => {
  const fixture = await createPortfolioFixture(t);
  await assert.rejects(
    () => startObservatoryServer({
      projectRoot: fixture.root,
      portfolioManifest: "portfolio.json",
      portfolioConcurrency: 5,
    }),
    /between 1 and 4/u,
  );

  let disposed = 0;
  const running = await startObservatoryServer({
    projectRoot: fixture.root,
    portfolioManifest: "portfolio.json",
    createProjectRuntime({ projectId }) {
      return disposableProjectRuntime(projectId, () => {
        disposed += 1;
      });
    },
  });
  const ready = await request(running, "/api/v1/ready");
  assert.equal(ready.statusCode, 200);
  await running.close();
  assert.equal(disposed, 3);
});

test("shutdown bounds portfolio disposal while a summary lease is still active", async (t) => {
  const fixture = await createPortfolioFixture(t);
  let releaseSummary;
  const summaryGate = new Promise((resolve) => {
    releaseSummary = resolve;
  });
  let summaryStarted = false;
  let disposed = 0;
  const running = await startObservatoryServer({
    projectRoot: fixture.root,
    portfolioManifest: "portfolio.json",
    shutdownGraceMs: 25,
    createProjectRuntime({ projectId }) {
      const runtime = disposableProjectRuntime(projectId, () => {
        disposed += 1;
      });
      if (projectId !== "alpha") return runtime;
      return {
        ...runtime,
        async getPortfolioSummary() {
          summaryStarted = true;
          await summaryGate;
          return runtime.getPortfolioSummary();
        },
      };
    },
  });

  const pendingRequest = request(running, "/api/v1/portfolio")
    .then((response) => ({ response, error: null }), (error) => ({ response: null, error }));
  await waitFor(() => summaryStarted);
  await assertCompletesWithin(running.close(), 500, "active portfolio shutdown");
  const outcome = await assertCompletesWithin(pendingRequest, 500, "active portfolio client teardown");
  assert.equal(outcome.response, null);
  assert.ok(outcome.error instanceof Error);
  assert.equal(running.server.listening, false);

  releaseSummary();
  await waitFor(() => disposed === 3);
});

test("enforces auth, Host, read-only methods, and exact portfolio queries", async (t) => {
  const fixture = await createPortfolioFixture(t);
  const running = await startObservatoryServer({
    projectRoot: fixture.root,
    portfolioManifest: "portfolio.json",
  });
  t.after(() => running.close());

  const denied = await request(running, "/api/v1/portfolio", { authenticated: false });
  assert.equal(denied.statusCode, 401);
  assert.equal(denied.json.error.code, "access_denied");
  assert.match(denied.headers["www-authenticate"], /^Bearer /u);

  const invalidHost = await request(running, "/api/v1/portfolio", {
    headers: { Host: "attacker.example" },
  });
  assert.equal(invalidHost.statusCode, 400);
  assert.equal(invalidHost.json.error.code, "invalid_host");

  const write = await request(running, "/api/v1/portfolio", { method: "POST" });
  assert.equal(write.statusCode, 405);
  assert.equal(write.headers.allow, "GET, HEAD");

  const invalidRequests = [
    "/api/v1/portfolio?extra=1",
    "/api/v1/portfolio/project",
    "/api/v1/portfolio/project?project=alpha&project=beta",
    "/api/v1/portfolio/project?project=alpha&extra=1",
    "/api/v1/portfolio/source?project=alpha",
    `/api/v1/portfolio/source?project=alpha&path=${encodeURIComponent(".sdlc/project.json")}&path=${encodeURIComponent(".sdlc/other.json")}`,
    `/api/v1/portfolio/source?project=alpha&path=${encodeURIComponent(".sdlc/project.json")}&extra=1`,
  ];
  for (const endpoint of invalidRequests) {
    const response = await request(running, endpoint);
    assert.equal(response.statusCode, 400, endpoint);
    assert.equal(response.json.error.code, "invalid_portfolio_request", endpoint);
  }
  const missingProject = await request(running, "/api/v1/portfolio/project");
  assert.equal(
    missingProject.json.error.message,
    'Exactly one "project" query parameter must be provided',
  );
  const missingPath = await request(running, "/api/v1/portfolio/source?project=alpha");
  assert.equal(
    missingPath.json.error.message,
    'Exactly one "project" and one "path" query parameter must be provided',
  );

  const unknown = await request(running, "/api/v1/portfolio/project?project=missing");
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.json.schemaVersion, "change-observatory:error:v1");
  assert.equal(unknown.json.error.code, "portfolio_project_not_found");
  assert.equal(unknown.json.correlationId, unknown.headers["x-correlation-id"]);

  const broken = await request(running, "/api/v1/portfolio/project?project=broken");
  assert.equal(broken.statusCode, 503);
  assert.equal(broken.json.error.code, "observability_configuration_invalid");
  assert.doesNotMatch(broken.body, /BROKEN-CANARY|projects\/broken/u);

  const oldSingleProjectRoute = await request(running, "/api/v1/observatory");
  assert.equal(oldSingleProjectRoute.statusCode, 404);
  assert.equal(oldSingleProjectRoute.json.error.code, "api_not_found");
});

async function createPortfolioFixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "change-observatory-portfolio-server-"));
  const root = await fs.realpath(temporary);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [directory, projectId] of [
    ["alpha", "alpha-project"],
    ["beta", "beta-project"],
    ["broken", "broken-project"],
  ]) {
    await fs.mkdir(path.join(root, "projects", directory, ".sdlc"), { recursive: true });
    await fs.writeFile(
      path.join(root, "projects", directory, ".sdlc", "project.json"),
      `${JSON.stringify({
        schema_version: "0.1.0",
        project_id: projectId,
        project_name: `${directory} project`,
      })}\n`,
      "utf8",
    );
  }
  await fs.mkdir(path.join(root, "projects", "alpha", ".sdlc", "requirements"));
  await fs.writeFile(
    path.join(root, "projects", "alpha", ".sdlc", "requirements", "REQ-ALPHA.json"),
    `${JSON.stringify({
      id: "REQ-ALPHA",
      title: "Alpha requirement",
      summary: "Alpha portfolio requirement",
      status: "approved",
    })}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(root, "projects", "beta", ".sdlc", "beta-only.json"),
    '{"owner":"beta"}\n',
    "utf8",
  );
  await fs.writeFile(
    path.join(root, "projects", "broken", ".sdlc", "config.json"),
    '{"observability":{"redaction":{"secret_pattern":["BROKEN-CANARY"]}}}\n',
    "utf8",
  );
  await fs.writeFile(path.join(root, "portfolio.json"), `${JSON.stringify({
    schema_version: "portfolio-manifest:v1",
    projects: [
      { id: "alpha", path: "projects/alpha" },
      { id: "beta", path: "projects/beta" },
      { id: "broken", path: "projects/broken" },
    ],
  })}\n`, "utf8");
  return { root };
}

function request(running, requestPath, {
  method = "GET",
  headers = {},
  authenticated = true,
} = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request({
      host: running.address.host,
      port: running.address.port,
      path: requestPath,
      method,
      headers: {
        Host: `${running.address.host}:${running.address.port}`,
        ...(authenticated ? { Authorization: `Bearer ${running.accessToken}` } : {}),
        ...headers,
      },
    }, (incoming) => {
      const chunks = [];
      incoming.on("data", (chunk) => chunks.push(chunk));
      incoming.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({
          statusCode: incoming.statusCode,
          headers: incoming.headers,
          body,
          json: body && (incoming.headers["content-type"] ?? "").startsWith("application/json")
            ? JSON.parse(body)
            : null,
        });
      });
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

function assertCompletesWithin(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs} ms`)), timeoutMs);
    }),
  ]);
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for the portfolio operation");
}

function collectStringFields(value, field) {
  const results = [];
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== "object") continue;
    for (const [key, child] of Object.entries(current)) {
      if (key === field && typeof child === "string") results.push(child);
      pending.push(child);
    }
  }
  return results;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function disposableProjectRuntime(projectId, onDispose) {
  const emptyBucket = () => ({ count: 0, items: [], truncated: false });
  let disposed = false;
  return {
    redactionPolicy: Object.freeze({}),
    async getPortfolioSummary() {
      return {
        schemaVersion: "change-observatory:portfolio-project-summary:v1",
        project: { id: projectId, name: projectId, branch: "main" },
        health: "ready",
        counts: {
          asked: 0,
          changed: 0,
          decided: 0,
          iterations: 0,
          contracts: 0,
          decisions: 0,
          changes: 0,
          verification: 0,
          diagnostics: 0,
        },
        previews: [],
        aggregates: {
          schemaVersion: "change-observatory:portfolio-aggregates:v1",
          activeWorkflows: emptyBucket(),
          blockers: emptyBucket(),
          risks: emptyBucket(),
          budgets: emptyBucket(),
          dependencies: emptyBucket(),
          releases: emptyBucket(),
        },
      };
    },
    async getRepresentation() {
      return {
        body: Buffer.from('{"schemaVersion":"change-observatory:view:v1"}\n'),
        etag: '"sha256-test"',
      };
    },
    async readSource() {
      return { schemaVersion: "change-observatory:source:v1", data: {} };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      onDispose();
    },
  };
}
