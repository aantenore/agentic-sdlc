import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createPortfolioRuntime,
} from "../../lib/change-observatory/portfolio-runtime.mjs";

test("serves compact summaries, lazy project detail, and project-scoped sources", async (t) => {
  const fixture = await createPortfolioFixture(t);
  const runtime = await createPortfolioRuntime({
    portfolioRoot: fixture.root,
    manifestPath: "portfolio.json",
    clock: () => new Date("2026-07-19T10:00:00Z"),
  });

  const first = await runtime.getSummaryRepresentation();
  const second = await runtime.getSummaryRepresentation();
  const summary = JSON.parse(first.body);

  assert.equal(first.etag, second.etag);
  assert.equal(summary.schemaVersion, "change-observatory:portfolio:v1");
  assert.equal(summary.status, "degraded");
  assert.deepEqual(summary.projects.map((project) => project.id), ["alpha", "beta", "broken"]);
  assert.deepEqual(summary.projects.map((project) => project.status), [
    "available",
    "available",
    "unavailable",
  ]);
  assert.match(summary.projects[2].message, /privacy settings/u);
  assert.doesNotMatch(first.body.toString("utf8"), new RegExp(escapeRegExp(fixture.root), "u"));
  assert.equal(first.body.includes("DETAIL-ONLY-MARKER"), false);

  const detailRepresentation = await runtime.getProjectDetailRepresentation("alpha");
  const detail = JSON.parse(detailRepresentation.body);
  const rawHrefs = collectStringFields(detail, "rawHref").filter(Boolean);
  assert.equal(detail.schemaVersion, "change-observatory:view:v1");
  assert.ok(rawHrefs.length > 0);
  assert.ok(rawHrefs.every((href) => href.startsWith(
    "/api/v1/portfolio/source?project=alpha&path=",
  )));
  assert.match(detailRepresentation.body.toString("utf8"), /DETAIL-ONLY-MARKER/u);

  const sourceRepresentation = await runtime.getSourceRepresentation("alpha", ".sdlc/project.json");
  const source = JSON.parse(sourceRepresentation.body);
  assert.equal(source.data.project_id, "alpha-project");
  assert.match(sourceRepresentation.etag, /^"sha256-[A-Za-z0-9_-]+"$/u);

  await assert.rejects(
    () => runtime.getSourceRepresentation("alpha", ".sdlc/beta-only.json"),
    (error) => error.code === "source_not_found" && error.statusCode === 404,
  );
  assert.equal(
    JSON.parse((await runtime.getSourceRepresentation("beta", ".sdlc/beta-only.json")).body).data.owner,
    "beta",
  );
});

test("degrades a swapped project independently while direct access fails closed", async (t) => {
  if (process.platform === "win32") return t.skip("Directory swap coverage requires Unix rename semantics");
  const fixture = await createPortfolioFixture(t);
  const runtime = await createPortfolioRuntime({
    portfolioRoot: fixture.root,
    manifestPath: "portfolio.json",
  });
  const original = path.join(fixture.root, "projects", "beta-original");
  await fs.rename(path.join(fixture.root, "projects", "beta"), original);
  await fs.mkdir(path.join(fixture.root, "projects", "beta", ".sdlc"), { recursive: true });
  await fs.writeFile(
    path.join(fixture.root, "projects", "beta", ".sdlc", "project.json"),
    '{"project_id":"ATTACKER-REPLACEMENT"}\n',
    "utf8",
  );

  const summary = JSON.parse((await runtime.getSummaryRepresentation()).body);
  assert.deepEqual(summary.projects.map((project) => project.status), [
    "available",
    "unavailable",
    "unavailable",
  ]);
  assert.doesNotMatch(JSON.stringify(summary), /ATTACKER-REPLACEMENT/u);
  assert.match(summary.projects[1].message, /changed while they were being read/u);
  await assert.rejects(
    () => runtime.getProjectDetailRepresentation("beta"),
    (error) => error.code === "portfolio_project_root_changed" && error.statusCode === 409,
  );
});

test("pins the manifest envelope and rejects unknown project identifiers", async (t) => {
  const fixture = await createPortfolioFixture(t);
  const runtime = await createPortfolioRuntime({
    portfolioRoot: fixture.root,
    manifestPath: "portfolio.json",
  });
  await assert.rejects(
    () => runtime.getProjectDetailRepresentation("missing"),
    (error) => error.code === "portfolio_project_not_found" && error.statusCode === 404,
  );
  await assert.rejects(
    () => runtime.getProjectDetailRepresentation("../alpha"),
    (error) => error.code === "invalid_portfolio_project" && error.statusCode === 400,
  );

  await fs.writeFile(path.join(fixture.root, "portfolio.json"), `${JSON.stringify({
    schema_version: "portfolio-manifest:v1",
    projects: [{ id: "alpha", path: "projects/alpha" }],
  })}\n`, "utf8");
  await assert.rejects(
    () => runtime.getSummaryRepresentation(),
    (error) => error.code === "portfolio_manifest_changed" && error.statusCode === 409,
  );
});

test("revalidates a project root after runtime creation and isolates a construction race", async (t) => {
  if (process.platform === "win32") return t.skip("Directory swap coverage requires Unix rename semantics");
  const fixture = await createPortfolioFixture(t);
  let swapped = false;
  const runtime = await createPortfolioRuntime({
    portfolioRoot: fixture.root,
    manifestPath: "portfolio.json",
    async createProjectRuntime({ projectRoot, projectId }) {
      if (projectId === "alpha" && !swapped) {
        swapped = true;
        await fs.rename(projectRoot, `${projectRoot}-original`);
        await fs.mkdir(path.join(projectRoot, ".sdlc"), { recursive: true });
        await fs.writeFile(
          path.join(projectRoot, ".sdlc", "project.json"),
          '{"project_id":"RACE-ATTACKER"}\n',
          "utf8",
        );
      }
      return fakeProjectRuntime(projectId);
    },
  });

  const summary = JSON.parse((await runtime.getSummaryRepresentation()).body);
  assert.equal(swapped, true);
  assert.equal(summary.projects[0].status, "unavailable");
  assert.equal(summary.projects[1].status, "available");
  assert.doesNotMatch(JSON.stringify(summary), /RACE-ATTACKER/u);
});

test("retries rejected runtime initialization and never reads sources for summary or detail", async (t) => {
  const fixture = await createPortfolioFixture(t);
  let alphaAttempts = 0;
  let sourceReads = 0;
  const runtime = await createPortfolioRuntime({
    portfolioRoot: fixture.root,
    manifestPath: "portfolio.json",
    createProjectRuntime({ projectId }) {
      if (projectId === "alpha") {
        alphaAttempts += 1;
        if (alphaAttempts === 1) {
          const error = new Error("temporary failure must not become sticky");
          error.code = "project_temporarily_unavailable";
          throw error;
        }
      }
      return fakeProjectRuntime(projectId, {
        readSource() {
          sourceReads += 1;
          return { schemaVersion: "change-observatory:source:v1", data: { projectId } };
        },
      });
    },
  });

  const first = JSON.parse((await runtime.getSummaryRepresentation()).body);
  assert.equal(first.projects[0].status, "unavailable");
  assert.equal(sourceReads, 0);
  const second = JSON.parse((await runtime.getSummaryRepresentation()).body);
  assert.equal(second.projects[0].status, "available");
  assert.equal(alphaAttempts, 2);
  assert.equal(sourceReads, 0);

  await runtime.getProjectDetailRepresentation("alpha");
  assert.equal(sourceReads, 0);
  await runtime.getSourceRepresentation("alpha", ".sdlc/project.json");
  assert.equal(sourceReads, 1);
});

test("forwards reviewed global privacy and operational policy to every project runtime", async (t) => {
  const fixture = await createPortfolioFixture(t);
  const redactionPolicy = Object.freeze({ source: "reviewed-global-policy" });
  const operationalPolicy = Object.freeze({ availabilityTarget: 0.995 });
  const received = [];
  const runtime = await createPortfolioRuntime({
    portfolioRoot: fixture.root,
    manifestPath: "portfolio.json",
    redactionPolicy,
    operationalPolicy,
    createProjectRuntime(options) {
      received.push(options);
      return fakeProjectRuntime(options.projectId);
    },
  });

  await runtime.getSummaryRepresentation();

  assert.equal(received.length, 3);
  assert.ok(received.every((options) => options.redactionPolicy === redactionPolicy));
  assert.ok(received.every((options) => options.operationalPolicy === operationalPolicy));
});

test("summary and readiness never build full detail and the 64-project LRU stays bounded", async (t) => {
  const fixture = await createLargePortfolioFixture(t, 64);
  const events = [];
  let fullBuilds = 0;
  let liveRuntimes = 0;
  let maximumLiveRuntimes = 0;
  let disposedRuntimes = 0;
  const runtime = await createPortfolioRuntime({
    portfolioRoot: fixture.root,
    manifestPath: "portfolio.json",
    maxCachedProjects: 8,
    onCacheEvent(event) {
      events.push(event.type);
    },
    createProjectRuntime({ projectId }) {
      liveRuntimes += 1;
      maximumLiveRuntimes = Math.max(maximumLiveRuntimes, liveRuntimes);
      // This retained allocation makes an unbounded runtime cache visible to
      // the behavioral live-runtime counter without relying on RSS/GC timing.
      let retained = Buffer.alloc(256 * 1024, 0x61);
      let disposed = false;
      return fakeProjectRuntime(projectId, {
        async getRepresentation() {
          fullBuilds += 1;
          return {
            body: Buffer.from('{"schemaVersion":"change-observatory:view:v1"}\n'),
            etag: '"sha256-unexpected"',
          };
        },
        async dispose() {
          if (disposed) return;
          disposed = true;
          retained = null;
          liveRuntimes -= 1;
          disposedRuntimes += 1;
        },
      });
    },
  });

  const readyRepresentation = await runtime.assertReady();
  const summary = JSON.parse(readyRepresentation.body);
  const cache = runtime.cacheSnapshot();

  assert.equal(summary.projectCount, 64);
  assert.equal(fullBuilds, 0);
  assert.equal(cache.limit, 8);
  assert.equal(cache.size, 8);
  assert.equal(cache.evictions, 56);
  assert.ok(maximumLiveRuntimes <= 12, `maximum live runtimes was ${maximumLiveRuntimes}`);
  assert.ok(events.includes("portfolio_miss"));
  assert.ok(events.includes("portfolio_evict"));
  assert.ok(events.includes("portfolio_dispose"));

  await runtime.dispose();
  assert.equal(liveRuntimes, 0);
  assert.equal(disposedRuntimes, 64);
  assert.equal(runtime.cacheSnapshot().size, 0);
});

test("the real project runtime keeps the full normalizer lazy", async (t) => {
  const fixture = await createPortfolioFixture(t);
  let fullBuilds = 0;
  const runtime = await createPortfolioRuntime({
    portfolioRoot: fixture.root,
    manifestPath: "portfolio.json",
    buildViewModel() {
      fullBuilds += 1;
      throw new Error("FULL-DETAIL-BUILDER-CANARY");
    },
  });
  t.after(() => runtime.dispose());

  const summary = JSON.parse((await runtime.getSummaryRepresentation()).body);
  assert.equal(summary.projectCount, 3);
  assert.equal(fullBuilds, 0);
  await assert.rejects(
    () => runtime.getProjectDetailRepresentation("alpha"),
    /FULL-DETAIL-BUILDER-CANARY/u,
  );
  assert.equal(fullBuilds, 1);
});

test("LRU recreation never accepts a changed project privacy configuration", async (t) => {
  const fixture = await createLargePortfolioFixture(t, 2);
  const runtime = await createPortfolioRuntime({
    portfolioRoot: fixture.root,
    manifestPath: "portfolio.json",
    concurrency: 1,
    maxCachedProjects: 1,
  });
  t.after(() => runtime.dispose());

  await runtime.getSummaryRepresentation();
  assert.equal(runtime.cacheSnapshot().pinnedConfigurations, 2);
  const alphaRoot = path.join(fixture.root, "projects", "project-00", ".sdlc");
  await fs.mkdir(alphaRoot, { recursive: true });
  await fs.writeFile(
    path.join(alphaRoot, "config.json"),
    '{"observability":{"enabled":true}}\n',
    "utf8",
  );

  await assert.rejects(
    () => runtime.getProjectDetailRepresentation("project-00"),
    (error) => error.code === "observability_configuration_changed" && error.statusCode === 503,
  );
});

async function createPortfolioFixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "change-observatory-portfolio-runtime-"));
  const root = await fs.realpath(temporary);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [directory, projectId, projectName] of [
    ["alpha", "alpha-project", "Alpha Project"],
    ["beta", "beta-project", "Beta Project"],
    ["broken", "broken-project", "Broken Project"],
  ]) {
    await fs.mkdir(path.join(root, "projects", directory, ".sdlc"), { recursive: true });
    await fs.writeFile(
      path.join(root, "projects", directory, ".sdlc", "project.json"),
      `${JSON.stringify({
        schema_version: "0.1.0",
        project_id: projectId,
        project_name: projectName,
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
    path.join(root, "projects", "alpha", ".sdlc", "detail-only.json"),
    `${JSON.stringify({ id: "DETAIL-ONLY-MARKER", title: "Detail only" })}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(root, "projects", "beta", ".sdlc", "beta-only.json"),
    '{"owner":"beta"}\n',
    "utf8",
  );
  await fs.writeFile(
    path.join(root, "projects", "broken", ".sdlc", "config.json"),
    '{"observability":{"redaction":{"secret_pattern":["not-allowed"]}}}\n',
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

function fakeProjectRuntime(projectId, overrides = {}) {
  const model = {
    schemaVersion: "change-observatory:view:v1",
    project: { id: projectId, name: `${projectId} project`, branch: "main" },
    summary: { asked: [], changed: [], decided: [] },
    iterations: [],
    contracts: [],
    decisions: [],
    changes: [],
    verification: [],
    records: [{
      id: `${projectId}-record`,
      rawHref: `/api/v1/source?path=${encodeURIComponent(".sdlc/project.json")}`,
    }],
    diagnostics: [],
  };
  return {
    redactionPolicy: Object.freeze({}),
    async getRepresentation() {
      if (overrides.getRepresentation) return overrides.getRepresentation();
      return {
        body: Buffer.from(`${JSON.stringify(model)}\n`, "utf8"),
        etag: '"sha256-fake"',
      };
    },
    async getPortfolioSummary() {
      if (overrides.getPortfolioSummary) return overrides.getPortfolioSummary();
      return compactProjectSummary(projectId);
    },
    async readSource(relativePath) {
      if (overrides.readSource) return overrides.readSource(relativePath);
      return { schemaVersion: "change-observatory:source:v1", data: { projectId } };
    },
    async dispose() {
      await overrides.dispose?.();
    },
  };
}

function compactProjectSummary(projectId) {
  const emptyBucket = () => ({ count: 0, items: [], truncated: false });
  return {
    schemaVersion: "change-observatory:portfolio-project-summary:v1",
    project: { id: projectId, name: `${projectId} project`, branch: "main" },
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
}

async function createLargePortfolioFixture(t, count) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "change-observatory-portfolio-large-"));
  const root = await fs.realpath(temporary);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projects = [];
  for (let index = 0; index < count; index += 1) {
    const id = `project-${String(index).padStart(2, "0")}`;
    await fs.mkdir(path.join(root, "projects", id), { recursive: true });
    projects.push({ id, path: `projects/${id}` });
  }
  await fs.writeFile(path.join(root, "portfolio.json"), `${JSON.stringify({
    schema_version: "portfolio-manifest:v1",
    projects,
  })}\n`, "utf8");
  return { root };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

test("a project folder that does not exist becomes an unavailable card without aborting the portfolio", async (t) => {
  const fixture = await createPortfolioFixture(t);
  await fs.writeFile(
    path.join(fixture.root, "portfolio.json"),
    JSON.stringify({
      schema_version: "portfolio-manifest:v1",
      projects: [
        { id: "alpha", path: "projects/alpha" },
        { id: "gone", path: "projects/does-not-exist" },
      ],
    }),
  );
  const runtime = await createPortfolioRuntime({
    portfolioRoot: fixture.root,
    manifestPath: "portfolio.json",
  });
  t.after(() => runtime.dispose());

  const summary = JSON.parse((await runtime.getSummaryRepresentation()).body);
  assert.deepEqual(summary.projects.map((project) => [project.id, project.status]), [
    ["alpha", "available"],
    ["gone", "unavailable"],
  ]);
  assert.equal(summary.projects[1].errorCode, "project_folder_missing");
  assert.match(summary.projects[1].message, /folder was not found/u);
  assert.doesNotMatch(JSON.stringify(summary), new RegExp(escapeRegExp(fixture.root), "u"));
  await assert.rejects(
    () => runtime.getProjectDetailRepresentation("gone"),
    (error) => error.code === "project_folder_missing" && error.statusCode === 404,
  );
});
