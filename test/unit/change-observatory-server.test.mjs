import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";

import {
  buildObservatoryViewModel,
  createObservatoryRequestHandler,
  startObservatoryServer,
} from "../../lib/change-observatory/index.mjs";
import { ObservatoryPathError } from "../../lib/change-observatory/path-safety.mjs";
import { verifySupportBundleDigest } from "../../lib/observability/support-bundle.mjs";
import { requireSymlinkSupport } from "../helpers/symlink-support.mjs";

const CORRELATION_PATTERN = /^corr-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;

test("public request-handler factory requires an access token", async (t) => {
  const fixture = await createServerFixture(t);
  await assert.rejects(
    () => createObservatoryRequestHandler({ projectRoot: fixture.projectRoot }),
    /access token must be/u,
  );
});

test("serves health, view model, raw records, static assets, and HEAD over loopback", async (t) => {
  const fixture = await createServerFixture(t);
  const running = await startObservatoryServer({
    projectRoot: fixture.projectRoot,
    assetRoot: fixture.assetRoot,
    port: 0,
    clock: () => new Date("2026-07-16T09:00:00Z"),
  });
  t.after(() => running.close());

  assert.equal(running.address.host, "127.0.0.1");
  assert.match(running.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);

  const health = await request(running, "/api/v1/health");
  assert.equal(health.statusCode, 200);
  assert.equal(health.json.status, "ok");
  assert.match(health.headers["content-security-policy"], /frame-ancestors 'none'/);
  assert.equal(health.headers["access-control-allow-origin"], undefined);

  const model = await request(running, "/api/v1/observatory");
  assert.equal(model.statusCode, 200);
  assert.equal(model.json.project.id, "server-fixture");
  assert.equal(model.json.generatedAt, "2026-07-16T09:00:00.000Z");
  assert.match(model.headers.etag, /^"sha256-[A-Za-z0-9_-]+"$/);
  assert.equal(model.headers["cache-control"], "no-store");

  const source = await request(
    running,
    `/api/v1/source?path=${encodeURIComponent(".sdlc/project.json")}`,
  );
  assert.equal(source.statusCode, 200);
  assert.equal(source.json.data.project_id, "server-fixture");
  assert.match(source.json.sha256, /^[a-f0-9]{64}$/);

  const index = await request(running, "/");
  assert.equal(index.statusCode, 200);
  assert.equal(index.headers["content-type"], "text/html; charset=utf-8");
  assert.match(index.body, /Change Observatory/);

  const head = await request(running, "/app.js", { method: "HEAD" });
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, "");
  assert.ok(Number(head.headers["content-length"]) > 0);

  const denied = await request(running, "/api/v1/observatory", { authenticated: false });
  assert.equal(denied.statusCode, 401);
  assert.equal(denied.json.error.code, "access_denied");
  assert.match(denied.headers["www-authenticate"], /^Bearer /);
});

test("the Bearer scheme is matched case-insensitively and a wrong token is still refused", async (t) => {
  const fixture = await createServerFixture(t);
  const running = await startObservatoryServer({
    projectRoot: fixture.projectRoot,
    assetRoot: fixture.assetRoot,
  });
  t.after(() => running.close());

  for (const scheme of ["bearer", "BEARER", "BeArEr"]) {
    const accepted = await request(running, "/api/v1/observatory", {
      authenticated: false,
      headers: { Authorization: `${scheme} ${running.accessToken}` },
    });
    assert.equal(accepted.statusCode, 200, scheme);
  }
  const wrong = await request(running, "/api/v1/observatory", {
    authenticated: false,
    headers: { Authorization: `bearer ${"A".repeat(running.accessToken.length)}` },
  });
  assert.equal(wrong.statusCode, 401);
  assert.equal(wrong.json.error.code, "access_denied");
});

test("liveness is shallow while readiness reports model failure and later recovery", async (t) => {
  const fixture = await createServerFixture(t);
  const canary = "CANARY-READY-FAILURE-MUST-NOT-LEAK";
  let available = false;
  let builds = 0;
  const running = await startObservatoryServer({
    projectRoot: fixture.projectRoot,
    assetRoot: fixture.assetRoot,
    async buildViewModel(...args) {
      builds += 1;
      if (!available) throw new Error(`${canary} at ${fixture.projectRoot}`);
      return buildObservatoryViewModel(...args);
    },
  });
  t.after(() => running.close());

  const notReady = await request(running, "/api/v1/ready");
  assert.equal(notReady.statusCode, 503);
  assert.equal(notReady.json.status, "not_ready");
  assert.match(notReady.json.correlationId, CORRELATION_PATTERN);
  assert.doesNotMatch(notReady.body, new RegExp(`${canary}|${escapeRegExp(fixture.projectRoot)}`, "u"));
  assert.equal(builds, 1);

  const live = await request(running, "/api/v1/live", { authenticated: false });
  assert.equal(live.statusCode, 200);
  assert.equal(live.json.status, "ok");
  assert.match(live.headers["x-correlation-id"], CORRELATION_PATTERN);
  assert.equal(builds, 1);

  available = true;
  const recovered = await request(running, "/api/v1/ready");
  assert.equal(recovered.statusCode, 200);
  assert.equal(recovered.json.status, "ready");
  assert.equal(builds, 2);
});

test("invalid privacy configuration keeps liveness shallow and blocks project-data routes", async (t) => {
  const fixture = await createServerFixture(t);
  const canary = `github_pat_${"A".repeat(32)}`;
  await fs.writeFile(path.join(fixture.projectRoot, ".sdlc", "config.json"), JSON.stringify({
    observability: { redaction: { secret_pattern: [canary] } },
  }));
  const running = await startObservatoryServer({
    projectRoot: fixture.projectRoot,
    assetRoot: fixture.assetRoot,
  });
  t.after(() => running.close());

  assert.equal((await request(running, "/api/v1/live", { authenticated: false })).statusCode, 200);
  const ready = await request(running, "/api/v1/ready");
  assert.equal(ready.statusCode, 503);
  assert.equal(ready.json.status, "not_ready");
  assert.equal(ready.json.code, "observability_configuration_invalid");
  for (const endpoint of [
    "/api/v1/observatory",
    `/api/v1/source?path=${encodeURIComponent(".sdlc/project.json")}`,
  ]) {
    const blocked = await request(running, endpoint);
    assert.equal(blocked.statusCode, 503);
    assert.equal(blocked.json.error.code, "observability_configuration_invalid");
    assert.equal(
      blocked.json.error.message,
      "Project observability configuration is invalid. Correct .sdlc/config.json and retry.",
    );
    assert.equal(blocked.json.error.retryable, false);
    assert.doesNotMatch(blocked.body, /github_pat_|server-fixture/u);
  }
});

test("a configuration change after startup blocks project data until restart", async (t) => {
  const fixture = await createServerFixture(t);
  const employeeId = "EMP-654321";
  const projectPath = path.join(fixture.projectRoot, ".sdlc", "project.json");
  const project = JSON.parse(await fs.readFile(projectPath, "utf8"));
  await fs.writeFile(projectPath, `${JSON.stringify({ ...project, owner: employeeId })}\n`, "utf8");
  const running = await startObservatoryServer({
    projectRoot: fixture.projectRoot,
    assetRoot: fixture.assetRoot,
  });
  t.after(() => running.close());

  const before = await request(
    running,
    `/api/v1/source?path=${encodeURIComponent(".sdlc/project.json")}`,
  );
  assert.equal(before.statusCode, 200);
  assert.equal(before.json.data.owner, employeeId);

  await fs.writeFile(path.join(fixture.projectRoot, ".sdlc", "config.json"), JSON.stringify({
    observability: {
      redaction: { pii_patterns: [{ name: "employee", pattern: "EMP-[0-9]{6}" }] },
    },
  }));

  for (const endpoint of [
    "/api/v1/observatory",
    `/api/v1/source?path=${encodeURIComponent(".sdlc/project.json")}`,
  ]) {
    const blocked = await request(running, endpoint);
    assert.equal(blocked.statusCode, 503, endpoint);
    assert.equal(blocked.json.error.code, "observability_configuration_changed", endpoint);
    assert.match(blocked.json.error.message, /Restart it/u, endpoint);
    assert.doesNotMatch(blocked.body, /EMP-654321|server-fixture/u, endpoint);
  }
  const ready = await request(running, "/api/v1/ready");
  assert.equal(ready.statusCode, 503);
  assert.equal(ready.json.code, "observability_configuration_changed");
  assert.equal((await request(running, "/api/v1/live", { authenticated: false })).statusCode, 200);

  await fs.rm(path.join(fixture.projectRoot, ".sdlc", "config.json"));
  const stillBlocked = await request(running, "/api/v1/observatory");
  assert.equal(stillBlocked.statusCode, 503);
  assert.equal(stillBlocked.json.error.code, "observability_configuration_changed");
});

test("a privacy change during a model build prevents the mixed-policy response", async (t) => {
  const fixture = await createServerFixture(t);
  const canary = "EMP-777777";
  const projectPath = path.join(fixture.projectRoot, ".sdlc", "project.json");
  const project = JSON.parse(await fs.readFile(projectPath, "utf8"));
  await fs.writeFile(projectPath, `${JSON.stringify({ ...project, owner: canary })}\n`, "utf8");
  let changed = false;
  const running = await startObservatoryServer({
    projectRoot: fixture.projectRoot,
    assetRoot: fixture.assetRoot,
    async buildViewModel(...args) {
      const model = await buildObservatoryViewModel(...args);
      if (!changed) {
        changed = true;
        await fs.writeFile(path.join(fixture.projectRoot, ".sdlc", "config.json"), JSON.stringify({
          observability: {
            redaction: { pii_patterns: [{ name: "employee", pattern: "EMP-[0-9]{6}" }] },
          },
        }));
      }
      return model;
    },
  });
  t.after(() => running.close());

  const blocked = await request(running, "/api/v1/observatory");
  assert.equal(blocked.statusCode, 503);
  assert.equal(blocked.json.error.code, "observability_configuration_changed");
  assert.doesNotMatch(blocked.body, /EMP-777777|server-fixture/u);
});

test("invalid configuration introduced after startup fails closed", async (t) => {
  const fixture = await createServerFixture(t);
  const running = await startObservatoryServer({
    projectRoot: fixture.projectRoot,
    assetRoot: fixture.assetRoot,
  });
  t.after(() => running.close());
  assert.equal((await request(running, "/api/v1/observatory")).statusCode, 200);

  const configPath = path.join(fixture.projectRoot, ".sdlc", "config.json");
  const invalidCanary = `github_pat_${"Z".repeat(32)}`;
  await fs.writeFile(configPath, JSON.stringify({
    observability: { redaction: { secret_pattern: [invalidCanary] } },
  }));
  const invalid = await request(running, "/api/v1/observatory");
  assert.equal(invalid.statusCode, 503);
  assert.equal(invalid.json.error.code, "observability_configuration_invalid");
  assert.doesNotMatch(invalid.body, /github_pat_/u);
});

test("symlinked configuration introduced after startup fails closed", async (t) => {
  if (!requireSymlinkSupport(t, "file")) return;
  const secondFixture = await createServerFixture(t);
  const second = await startObservatoryServer({
    projectRoot: secondFixture.projectRoot,
    assetRoot: secondFixture.assetRoot,
  });
  t.after(() => second.close());
  const outside = path.join(path.dirname(secondFixture.projectRoot), "outside-config.json");
  await fs.writeFile(outside, JSON.stringify({ observability: {} }));
  await fs.symlink(outside, path.join(secondFixture.projectRoot, ".sdlc", "config.json"), "file");
  const symlinked = await request(second, "/api/v1/observatory");
  assert.equal(symlinked.statusCode, 403);
  assert.equal(symlinked.json.error.code, "symlink_forbidden");
  assert.doesNotMatch(symlinked.body, new RegExp(escapeRegExp(outside), "u"));
});

test("known server errors use the configured project redaction policy", async (t) => {
  const fixture = await createServerFixture(t);
  const employeeId = "EMP-123456";
  await fs.writeFile(path.join(fixture.projectRoot, ".sdlc", "config.json"), JSON.stringify({
    observability: {
      redaction: {
        pii_patterns: [{ name: "employee", pattern: "EMP-[0-9]{6}" }],
      },
    },
  }));
  const running = await startObservatoryServer({
    projectRoot: fixture.projectRoot,
    assetRoot: fixture.assetRoot,
    async buildViewModel() {
      throw new ObservatoryPathError(
        "model_unavailable",
        `Employee ${employeeId} failed`,
        503,
      );
    },
  });
  t.after(() => running.close());

  const response = await request(running, "/api/v1/observatory");
  assert.equal(response.statusCode, 503);
  assert.equal(response.json.error.code, "model_unavailable");
  assert.equal(response.json.error.message, "Employee [REDACTED] failed");
  assert.doesNotMatch(response.body, /EMP-123456/u);
});

test("operational endpoints require bearer authentication for GET and HEAD", async (t) => {
  const fixture = await createServerFixture(t);
  const running = await startObservatoryServer({
    projectRoot: fixture.projectRoot,
    assetRoot: fixture.assetRoot,
  });
  t.after(() => running.close());

  for (const endpoint of [
    "/api/v1/ready",
    "/api/v1/metrics",
    "/api/v1/slo",
    "/api/v1/support-bundle",
  ]) {
    const denied = await request(running, endpoint, { authenticated: false });
    assert.equal(denied.statusCode, 401, endpoint);
    assert.equal(denied.json.error.code, "access_denied", endpoint);
    assert.match(denied.headers["x-correlation-id"], CORRELATION_PATTERN, endpoint);

    const head = await request(running, endpoint, { method: "HEAD" });
    assert.equal(head.statusCode, 200, endpoint);
    assert.equal(head.body, "", endpoint);
    assert.ok(Number(head.headers["content-length"]) > 0, endpoint);
    assert.match(head.headers["x-correlation-id"], CORRELATION_PATTERN, endpoint);
  }
});

test("returns or generates a safe correlation ID and uses the stable error envelope", async (t) => {
  const fixture = await createServerFixture(t);
  const running = await startObservatoryServer({
    projectRoot: fixture.projectRoot,
    assetRoot: fixture.assetRoot,
  });
  t.after(() => running.close());

  const supplied = "corr-123e4567-e89b-12d3-a456-426614174099";
  const valid = await request(running, "/api/v1/live", {
    authenticated: false,
    headers: { "X-Correlation-ID": supplied.toUpperCase() },
  });
  assert.equal(valid.statusCode, 200);
  assert.equal(valid.headers["x-correlation-id"], supplied);
  assert.equal(valid.json.correlationId, supplied);

  const invalid = await request(running, "/api/v1/live", {
    authenticated: false,
    headers: { "X-Correlation-ID": "owner@example.com CANARY-CORRELATION" },
  });
  assert.equal(invalid.statusCode, 400);
  assert.match(invalid.headers["x-correlation-id"], CORRELATION_PATTERN);
  assert.equal(invalid.json.schemaVersion, "change-observatory:error:v1");
  assert.equal(invalid.json.status, "error");
  assert.equal(invalid.json.error.code, "invalid_correlation_id");
  assert.equal(invalid.json.error.retryable, false);
  assert.equal(invalid.json.correlationId, invalid.headers["x-correlation-id"]);
  assert.doesNotMatch(invalid.body, /owner@example\.com|CANARY-CORRELATION/u);
});

test("metrics capture cache builds, hits, and conditional 304 responses", async (t) => {
  const fixture = await createServerFixture(t);
  const running = await startObservatoryServer({
    projectRoot: fixture.projectRoot,
    assetRoot: fixture.assetRoot,
  });
  t.after(() => running.close());

  const first = await request(running, "/api/v1/observatory");
  assert.equal(first.statusCode, 200);
  const cached = await request(running, "/api/v1/observatory", {
    headers: { "If-None-Match": first.headers.etag },
  });
  assert.equal(cached.statusCode, 304);

  const metrics = await request(running, "/api/v1/metrics");
  assert.equal(metrics.statusCode, 200);
  assert.equal(metrics.json.externalSinks, "disabled");
  assert.equal(metrics.json.cardinality, "closed");
  assert.equal(metricSeriesValue(metrics.json, "observatory_http_requests_total", {
    route: "model",
    status_class: "2xx",
  }), 1);
  assert.equal(metricSeriesValue(metrics.json, "observatory_http_requests_total", {
    route: "model",
    status_class: "3xx",
  }), 1);
  assert.equal(metricSeriesValue(metrics.json, "observatory_model_cache_events_total", {
    event: "build_start",
  }), 1);
  assert.equal(metricSeriesValue(metrics.json, "observatory_model_cache_events_total", {
    event: "build_success",
  }), 1);
  assert.equal(metricSeriesValue(metrics.json, "observatory_model_cache_events_total", {
    event: "fast_hit",
  }), 1);
});

test("support bundle excludes project, token, and evidence canaries and has a verifiable digest", async (t) => {
  const fixture = await createServerFixture(t);
  const evidenceCanary = "CANARY-EVIDENCE-MUST-NOT-LEAK";
  await fs.writeFile(
    path.join(fixture.projectRoot, ".sdlc", "canary.json"),
    `${JSON.stringify({ token: evidenceCanary })}\n`,
    "utf8",
  );
  const accessToken = "CANARY_ACCESS_TOKEN_1234567890abcd";
  const running = await startObservatoryServer({
    projectRoot: fixture.projectRoot,
    assetRoot: fixture.assetRoot,
    accessToken,
  });
  t.after(() => running.close());

  await request(running, "/api/v1/ready");
  const response = await request(running, "/api/v1/support-bundle");
  assert.equal(response.statusCode, 200);
  assert.equal(verifySupportBundleDigest(response.json), true);
  assert.equal(response.json.integrity.assurance, "content_integrity_only_not_authenticity");
  assert.deepEqual(response.json.included_sections, [
    "limits",
    "metrics",
    "readiness",
    "recent_requests",
    "slo",
    "versions",
  ]);
  assert.doesNotMatch(
    response.body,
    new RegExp([
      evidenceCanary,
      accessToken,
      escapeRegExp(fixture.projectRoot),
    ].join("|"), "u"),
  );
});

test("carries a validated locale to the browser without exposing the access token in the query", async (t) => {
  const fixture = await createServerFixture(t);
  const running = await startObservatoryServer({
    projectRoot: fixture.projectRoot,
    assetRoot: fixture.assetRoot,
    locale: "it",
  });
  t.after(() => running.close());

  const access = new URL(running.accessUrl);
  assert.equal(access.hostname, "127.0.0.1");
  assert.equal(access.searchParams.get("locale"), "it");
  assert.equal(access.searchParams.has("mode"), false);
  assert.equal(access.searchParams.has("access_token"), false);
  assert.match(access.hash, /^#access_token=[A-Za-z0-9_-]+$/u);
});

test("rejects invalid Host, write methods, traversal, derived evidence, and unsafe source formats", async (t) => {
  const fixture = await createServerFixture(t);
  await fs.mkdir(path.join(fixture.projectRoot, ".sdlc", "cache"), { recursive: true });
  await fs.writeFile(path.join(fixture.projectRoot, ".sdlc", "cache", "derived.json"), "{}\n", "utf8");

  const running = await startObservatoryServer({
    projectRoot: fixture.projectRoot,
    assetRoot: fixture.assetRoot,
  });
  t.after(() => running.close());

  const invalidHost = await request(running, "/api/v1/health", {
    headers: { Host: "attacker.example" },
  });
  assert.equal(invalidHost.statusCode, 400);
  assert.equal(invalidHost.json.error.code, "invalid_host");

  const wrongPort = await request(running, "/api/v1/health", {
    headers: { Host: "127.0.0.1:1" },
  });
  assert.equal(wrongPort.statusCode, 400);

  for (const invalid of [
    `127.0.0.1:${running.address.port}?x`,
    `127.0.0.1:${running.address.port}#x`,
    `2130706433:${running.address.port}`,
    `127.0.0.1:0${running.address.port}`,
  ]) {
    const response = await request(running, "/api/v1/health", { headers: { Host: invalid } });
    assert.equal(response.statusCode, 400, invalid);
  }

  const post = await request(running, "/api/v1/observatory", { method: "POST" });
  assert.equal(post.statusCode, 405);
  assert.equal(post.headers.allow, "GET, HEAD");
  assert.equal(post.headers["access-control-allow-origin"], undefined);

  const traversal = await request(
    running,
    `/api/v1/source?path=${encodeURIComponent("../secret.json")}`,
  );
  assert.equal(traversal.statusCode, 403);
  assert.equal(traversal.json.error.code, "path_traversal");

  const encodedStaticTraversal = await request(running, "/%2e%2e%2fsecret.json");
  assert.equal(encodedStaticTraversal.statusCode, 403);

  const derived = await request(
    running,
    `/api/v1/source?path=${encodeURIComponent(".sdlc/cache/derived.json")}`,
  );
  assert.equal(derived.statusCode, 403);
  assert.equal(derived.json.error.code, "derived_source_forbidden");

  const upperDerived = await request(
    running,
    `/api/v1/source?path=${encodeURIComponent(".sdlc/CACHE/derived.json")}`,
  );
  assert.equal(upperDerived.statusCode, 403);
  assert.equal(upperDerived.json.error.code, "derived_source_forbidden");

  for (const relative of [".sdlc/.env", ".sdlc/private.pem", ".sdlc/blob.bin"]) {
    await fs.writeFile(path.join(fixture.projectRoot, ...relative.split("/")), "secret\0bytes");
    const blocked = await request(
      running,
      `/api/v1/source?path=${encodeURIComponent(relative)}`,
    );
    assert.equal(blocked.statusCode, 403, relative);
    assert.equal(blocked.json.error.code, "source_format_forbidden");
  }
});

test("rejects symlink source escapes", async (t) => {
  const linkType = process.platform === "win32" ? "junction" : "dir";
  if (!requireSymlinkSupport(t, linkType)) return;
  const fixture = await createServerFixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "change-observatory-outside-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, "secret.json"), "{\"secret\":true}\n", "utf8");
  await fs.mkdir(path.join(fixture.projectRoot, "project-hidden"), { recursive: true });
  await fs.writeFile(path.join(fixture.projectRoot, "project-hidden", "secret.json"), "{\"secret\":true}\n", "utf8");
  await fs.mkdir(path.join(fixture.projectRoot, ".sdlc", "cache"), { recursive: true });
  await fs.writeFile(path.join(fixture.projectRoot, ".sdlc", "cache", "derived.json"), "{}\n", "utf8");
  await fs.symlink(outside, path.join(fixture.projectRoot, ".sdlc", "external"), linkType);
  await fs.symlink(
    path.join(fixture.projectRoot, "project-hidden"),
    path.join(fixture.projectRoot, ".sdlc", "project-hidden"),
    linkType,
  );
  await fs.symlink(
    path.join(fixture.projectRoot, ".sdlc", "cache"),
    path.join(fixture.projectRoot, ".sdlc", "alias"),
    linkType,
  );

  const running = await startObservatoryServer({
    projectRoot: fixture.projectRoot,
    assetRoot: fixture.assetRoot,
  });
  t.after(() => running.close());

  for (const relative of [
    ".sdlc/external/secret.json",
    ".sdlc/project-hidden/secret.json",
    ".sdlc/alias/derived.json",
  ]) {
    const response = await request(
      running,
      `/api/v1/source?path=${encodeURIComponent(relative)}`,
    );
    assert.equal(response.statusCode, 403, relative);
    assert.equal(response.json.error.code, "symlink_forbidden", relative);
  }
});

test("rejects a symlinked knowledge base and a swapped project root", async (t) => {
  if (process.platform === "win32") return t.skip("Directory swap coverage requires Unix symlink semantics");

  const symlinkFixture = await createServerFixture(t);
  const hiddenKnowledgeBase = path.join(symlinkFixture.projectRoot, "hidden-sdlc");
  await fs.rename(path.join(symlinkFixture.projectRoot, ".sdlc"), hiddenKnowledgeBase);
  await fs.symlink(".", path.join(symlinkFixture.projectRoot, ".sdlc"), "dir");
  await fs.writeFile(path.join(symlinkFixture.projectRoot, ".env"), "TOP_SECRET=true\n", "utf8");
  const symlinked = await startObservatoryServer({
    projectRoot: symlinkFixture.projectRoot,
    assetRoot: symlinkFixture.assetRoot,
  });
  t.after(() => symlinked.close());
  const escaped = await request(
    symlinked,
    `/api/v1/source?path=${encodeURIComponent(".sdlc/.env")}`,
  );
  assert.equal(escaped.statusCode, 403);
  assert.equal(escaped.json.error.code, "knowledge_base_symlink");

  const swapFixture = await createServerFixture(t);
  const running = await startObservatoryServer({
    projectRoot: swapFixture.projectRoot,
    assetRoot: swapFixture.assetRoot,
  });
  t.after(() => running.close());
  assert.equal((await request(running, "/api/v1/observatory")).statusCode, 200);
  const original = `${swapFixture.projectRoot}-original`;
  const replacement = `${swapFixture.projectRoot}-replacement`;
  await fs.rename(swapFixture.projectRoot, original);
  await fs.mkdir(path.join(replacement, ".sdlc"), { recursive: true });
  await fs.writeFile(path.join(replacement, ".sdlc", "project.json"), '{"project_id":"attacker"}\n');
  await fs.symlink(replacement, swapFixture.projectRoot, "dir");
  const swapped = await request(running, "/api/v1/observatory");
  assert.equal(swapped.statusCode, 409);
  assert.equal(swapped.json.error.code, "project_boundary_changed");
  assert.doesNotMatch(swapped.body, /attacker/);
});

test("serves revision-aware ETags and honors conditional GET and HEAD requests", async (t) => {
  const fixture = await createServerFixture(t);
  const running = await startObservatoryServer({
    projectRoot: fixture.projectRoot,
    assetRoot: fixture.assetRoot,
  });
  t.after(() => running.close());

  const first = await request(running, "/api/v1/observatory");
  assert.equal(first.statusCode, 200);
  assert.match(first.headers.etag, /^"sha256-[A-Za-z0-9_-]+"$/);

  const unchanged = await request(running, "/api/v1/observatory", {
    headers: { "If-None-Match": first.headers.etag },
  });
  assert.equal(unchanged.statusCode, 304);
  assert.equal(unchanged.body, "");
  assert.equal(unchanged.headers.etag, first.headers.etag);
  assert.equal(unchanged.headers["content-type"], undefined);

  const weakListMatch = await request(running, "/api/v1/observatory", {
    method: "HEAD",
    headers: { "If-None-Match": `"stale", W/${first.headers.etag}` },
  });
  assert.equal(weakListMatch.statusCode, 304);
  assert.equal(weakListMatch.body, "");

  const stale = await request(running, "/api/v1/observatory", {
    headers: { "If-None-Match": '"sha256-stale"' },
  });
  assert.equal(stale.statusCode, 200);
  assert.equal(stale.headers.etag, first.headers.etag);

  const denied = await request(running, "/api/v1/observatory", {
    authenticated: false,
    headers: { "If-None-Match": first.headers.etag },
  });
  assert.equal(denied.statusCode, 401);
  assert.equal(denied.headers.etag, undefined);
});

test("compresses the view model for clients that accept gzip and keeps the same ETag", async (t) => {
  const fixture = await createServerFixture(t);
  const running = await startObservatoryServer({
    projectRoot: fixture.projectRoot,
    assetRoot: fixture.assetRoot,
  });
  t.after(() => running.close());

  const plain = await request(running, "/api/v1/observatory");
  assert.equal(plain.statusCode, 200);
  assert.equal(plain.headers["content-encoding"], undefined);
  assert.equal(plain.headers.vary, "Accept-Encoding");
  assert.equal(Number(plain.headers["content-length"]), plain.receivedBytes);

  const compressed = await request(running, "/api/v1/observatory", {
    headers: { "Accept-Encoding": "br;q=1, gzip;q=0.8" },
  });
  assert.equal(compressed.statusCode, 200);
  assert.equal(compressed.headers["content-encoding"], "gzip");
  assert.equal(compressed.headers.etag, plain.headers.etag);
  assert.equal(Number(compressed.headers["content-length"]), compressed.receivedBytes);
  assert.ok(compressed.receivedBytes < plain.receivedBytes);
  assert.equal(compressed.body, plain.body);

  const refused = await request(running, "/api/v1/observatory", {
    headers: { "Accept-Encoding": "gzip;q=0" },
  });
  assert.equal(refused.headers["content-encoding"], undefined);
  assert.equal(refused.body, plain.body);

  const unchanged = await request(running, "/api/v1/observatory", {
    headers: { "Accept-Encoding": "gzip", "If-None-Match": plain.headers.etag },
  });
  assert.equal(unchanged.statusCode, 304);
});

test("shares concurrent model builds and invalidates only for canonical evidence", async (t) => {
  const fixture = await createServerFixture(t);
  let releaseBuild;
  const buildGate = new Promise((resolve) => {
    releaseBuild = resolve;
  });
  let builds = 0;
  let observedCollectionLimit = null;
  const running = await startObservatoryServer({
    projectRoot: fixture.projectRoot,
    assetRoot: fixture.assetRoot,
    async buildViewModel(...args) {
      builds += 1;
      observedCollectionLimit = args[1].limits.maxCollectionItems;
      if (builds === 1) await buildGate;
      return buildObservatoryViewModel(...args);
    },
  });
  t.after(() => running.close());

  const pending = Array.from({ length: 16 }, () => request(running, "/api/v1/observatory"));
  await waitFor(() => builds === 1);
  releaseBuild();
  const concurrent = await Promise.all(pending);
  assert.ok(concurrent.every((response) => response.statusCode === 200));
  assert.ok(concurrent.every((response) => response.headers.etag === concurrent[0].headers.etag));
  assert.equal(builds, 1);
  assert.equal(observedCollectionLimit, 1_000);

  await fs.mkdir(path.join(fixture.projectRoot, ".sdlc", "cache"), { recursive: true });
  await fs.writeFile(path.join(fixture.projectRoot, ".sdlc", "cache", "derived.json"), "{}\n");
  const derivedOnly = await request(running, "/api/v1/observatory");
  assert.equal(derivedOnly.headers.etag, concurrent[0].headers.etag);
  assert.equal(builds, 1);

  await fs.writeFile(path.join(fixture.projectRoot, ".sdlc", "project.json"), `${JSON.stringify({
    schema_version: "0.1.0",
    project_id: "server-fixture",
    project_name: "Server Fixture Updated",
  })}\n`, "utf8");
  const canonicalChange = await request(running, "/api/v1/observatory", {
    headers: { "If-None-Match": concurrent[0].headers.etag },
  });
  assert.equal(canonicalChange.statusCode, 200);
  assert.equal(canonicalChange.json.project.name, "Server Fixture Updated");
  assert.notEqual(canonicalChange.headers.etag, concurrent[0].headers.etag);
  assert.equal(builds, 2);
});

test("allows an explicit server collection limit to override the safe default", async (t) => {
  const fixture = await createServerFixture(t);
  let observedCollectionLimit = null;
  const running = await startObservatoryServer({
    projectRoot: fixture.projectRoot,
    assetRoot: fixture.assetRoot,
    limits: { maxCollectionItems: 1_500 },
    async buildViewModel(...args) {
      observedCollectionLimit = args[1].limits.maxCollectionItems;
      return buildObservatoryViewModel(...args);
    },
  });
  t.after(() => running.close());

  assert.equal((await request(running, "/api/v1/observatory")).statusCode, 200);
  assert.equal(observedCollectionLimit, 1_500);
});

test("does not serve a warm model after the knowledge-base boundary becomes a symlink", async (t) => {
  if (process.platform === "win32") return t.skip("Knowledge-base swap coverage requires Unix symlink semantics");

  const fixture = await createServerFixture(t);
  const running = await startObservatoryServer({
    projectRoot: fixture.projectRoot,
    assetRoot: fixture.assetRoot,
  });
  t.after(() => running.close());
  assert.equal((await request(running, "/api/v1/observatory")).statusCode, 200);

  const canonical = path.join(fixture.projectRoot, ".sdlc");
  const hidden = path.join(fixture.projectRoot, "hidden-sdlc");
  await fs.rename(canonical, hidden);
  await fs.symlink("hidden-sdlc", canonical, "dir");

  const blocked = await request(running, "/api/v1/observatory");
  assert.equal(blocked.statusCode, 403);
  assert.equal(blocked.json.error.code, "knowledge_base_symlink");
});

test("GET, HEAD, and rejected writes do not mutate canonical project evidence", async (t) => {
  const fixture = await createServerFixture(t);
  const running = await startObservatoryServer({
    projectRoot: fixture.projectRoot,
    assetRoot: fixture.assetRoot,
  });
  t.after(() => running.close());
  const before = await snapshotTree(fixture.projectRoot);

  await request(running, "/api/v1/observatory");
  await request(running, `/api/v1/source?path=${encodeURIComponent(".sdlc/project.json")}`);
  for (const endpoint of [
    "/api/v1/live",
    "/api/v1/ready",
    "/api/v1/metrics",
    "/api/v1/slo",
    "/api/v1/support-bundle",
  ]) {
    await request(running, endpoint);
    await request(running, endpoint, { method: "HEAD" });
  }
  await request(running, "/", { method: "HEAD" });
  await request(running, "/api/v1/observatory", { method: "POST" });

  assert.deepEqual(await snapshotTree(fixture.projectRoot), before);
});

test("omits deeply nested raw JSON when bounded private-reasoning redaction cannot finish", async (t) => {
  const fixture = await createServerFixture(t);
  const depth = 12_000;
  const nested = `${'{"next":'.repeat(depth)}{"private_reasoning":"DEEP_PRIVATE_MUST_NOT_LEAK"}${"}".repeat(depth)}`;
  await fs.writeFile(
    path.join(fixture.projectRoot, ".sdlc", "deep-private.json"),
    `{"id":"DEEP-PRIVATE","payload":${nested}}\n`,
    "utf8",
  );
  const running = await startObservatoryServer({
    projectRoot: fixture.projectRoot,
    assetRoot: fixture.assetRoot,
  });
  t.after(() => running.close());

  const source = await request(
    running,
    `/api/v1/source?path=${encodeURIComponent(".sdlc/deep-private.json")}`,
  );
  assert.equal(source.statusCode, 200);
  assert.equal(source.json.provenance, "malformed");
  assert.equal(source.json.parseError, "private_reasoning_scan_limited");
  assert.equal(source.json.contentOmitted, true);
  assert.equal(Object.hasOwn(source.json, "data"), false);
  assert.deepEqual(source.json.redactions, [""]);
  assert.doesNotMatch(source.body, /DEEP_PRIVATE_MUST_NOT_LEAK/);
});

test("shutdown closes idle keep-alive sockets on every supported Node runtime", async (t) => {
  const fixture = await createServerFixture(t);
  const running = await startObservatoryServer({
    projectRoot: fixture.projectRoot,
    assetRoot: fixture.assetRoot,
  });
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());

  assert.equal((await request(running, "/api/v1/health", { agent })).statusCode, 200);
  await assertCompletesWithin(running.close(), 500, "idle keep-alive shutdown");
  assert.equal(running.server.listening, false);
});

test("shutdown force-closes an active request after the bounded grace period", async (t) => {
  const fixture = await createServerFixture(t);
  let releaseBuild;
  const buildGate = new Promise((resolve) => {
    releaseBuild = resolve;
  });
  let settleBuild;
  const buildSettled = new Promise((resolve) => {
    settleBuild = resolve;
  });
  let builds = 0;
  const running = await startObservatoryServer({
    projectRoot: fixture.projectRoot,
    assetRoot: fixture.assetRoot,
    shutdownGraceMs: 25,
    async buildViewModel() {
      builds += 1;
      await buildGate;
      settleBuild();
      throw new Error("test build released after forced shutdown");
    },
  });

  const pendingRequest = request(running, "/api/v1/observatory")
    .then((response) => ({ response, error: null }), (error) => ({ response: null, error }));
  await waitFor(() => builds === 1);
  await assertCompletesWithin(running.close(), 500, "active-request shutdown");
  const outcome = await assertCompletesWithin(pendingRequest, 500, "active client teardown");
  assert.equal(outcome.response, null);
  assert.ok(outcome.error instanceof Error);
  assert.equal(running.server.listening, false);

  releaseBuild();
  await assertCompletesWithin(buildSettled, 500, "background build settlement");
});

test("refuses non-loopback bind configuration", async (t) => {
  const fixture = await createServerFixture(t);
  await assert.rejects(
    () => startObservatoryServer({ projectRoot: fixture.projectRoot, host: "0.0.0.0" }),
    /may bind only to 127\.0\.0\.1/,
  );
});

async function createServerFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "change-observatory-server-"));
  t.after(() => fs.rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  }));
  const projectRoot = path.join(root, "project");
  const assetRoot = path.join(root, "assets");
  await fs.mkdir(path.join(projectRoot, ".sdlc"), { recursive: true });
  await fs.mkdir(assetRoot, { recursive: true });
  await fs.writeFile(path.join(projectRoot, ".sdlc", "project.json"), `${JSON.stringify({
    schema_version: "0.1.0",
    project_id: "server-fixture",
    project_name: "Server Fixture",
  })}\n`, "utf8");
  await fs.writeFile(
    path.join(assetRoot, "index.html"),
    "<!doctype html><title>Change Observatory</title><script type=\"module\" src=\"/app.js\"></script>\n",
    "utf8",
  );
  await fs.writeFile(path.join(assetRoot, "app.js"), "export const ready = true;\n", "utf8");
  return { projectRoot, assetRoot };
}

function request(running, requestPath, {
  method = "GET",
  headers = {},
  authenticated = true,
  agent = undefined,
} = {}) {
  return new Promise((resolve, reject) => {
    const requestHeaders = {
      Host: `${running.address.host}:${running.address.port}`,
      ...(authenticated && running.accessToken
        ? { Authorization: `Bearer ${running.accessToken}` }
        : {}),
      ...headers,
    };
    const outgoing = http.request({
      host: running.address.host,
      port: running.address.port,
      path: requestPath,
      method,
      headers: requestHeaders,
      agent,
    }, (incoming) => {
      const chunks = [];
      incoming.on("data", (chunk) => chunks.push(chunk));
      incoming.on("end", () => {
        const received = Buffer.concat(chunks);
        const bytes = incoming.headers["content-encoding"] === "gzip" && received.length > 0
          ? zlib.gunzipSync(received)
          : received;
        const body = bytes.toString("utf8");
        let json = null;
        if ((incoming.headers["content-type"] ?? "").startsWith("application/json") && body) {
          json = JSON.parse(body);
        }
        resolve({
          statusCode: incoming.statusCode,
          headers: incoming.headers,
          receivedBytes: received.length,
          body,
          json,
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
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for the model build");
}

async function snapshotTree(root) {
  const files = [];
  async function walk(directory, relative = "") {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(child, childRelative);
      } else if (entry.isFile()) {
        const content = await fs.readFile(child);
        files.push([childRelative, crypto.createHash("sha256").update(content).digest("hex")]);
      } else if (entry.isSymbolicLink()) {
        files.push([childRelative, `symlink:${await fs.readlink(child)}`]);
      }
    }
  }
  await walk(root);
  return files;
}

function metricSeriesValue(payload, name, labels) {
  const metric = payload.snapshot.metrics.find((candidate) => candidate.name === name);
  assert.ok(metric, `missing metric ${name}`);
  const expected = JSON.stringify(labels);
  const series = metric.series.find((candidate) => JSON.stringify(candidate.labels) === expected);
  assert.ok(series, `missing series ${name} ${expected}`);
  return series.value;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
