import { crypto, Date } from "../runtime/host.mjs";
import {
  collectPortfolioSummary,
  normalizePortfolioConcurrency,
} from "./portfolio-collector.mjs";
import {
  assertPortfolioEnvelopeBoundaries,
  assertPortfolioProjectBoundary,
  loadPortfolioManifest,
} from "./portfolio-manifest.mjs";
import {
  createProjectDataRuntime,
} from "./project-runtime.mjs";
import { normalizePortableRelativePath } from "./path-safety.mjs";

const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
export const DEFAULT_MAX_CACHED_PORTFOLIO_PROJECTS = 8;
export const MAX_CACHED_PORTFOLIO_PROJECTS = 64;

export class PortfolioRuntimeError extends Error {
  constructor(code, message, statusCode, retryable = undefined) {
    super(message);
    this.name = "PortfolioRuntimeError";
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = retryable;
  }
}

export async function createPortfolioRuntime(options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Portfolio runtime options must be an object");
  }
  const manifest = options.manifest ?? await loadPortfolioManifest(
    options.portfolioRoot,
    options.manifestPath,
  );
  await assertPortfolioEnvelopeBoundaries(manifest);
  const projectsById = new Map(manifest.projects.map((project) => [project.id, project]));
  const concurrency = normalizePortfolioConcurrency(options.concurrency);
  const maxCachedProjects = normalizeCacheLimit(options.maxCachedProjects, concurrency);
  const runtimeCache = new Map();
  const pendingDisposals = new Set();
  const pinnedConfigurationRevisions = new Map();
  const createProjectRuntime = options.createProjectRuntime ?? createProjectDataRuntime;
  if (typeof createProjectRuntime !== "function") {
    throw new TypeError("Portfolio runtime project factory must be a function");
  }
  if (options.onCacheEvent !== undefined && typeof options.onCacheEvent !== "function") {
    throw new TypeError("Portfolio runtime onCacheEvent must be a function");
  }
  const onCacheEvent = options.onCacheEvent ?? null;
  const generatedAt = normalizeInstant(options.clock);
  let summaryInFlight = null;
  let disposed = false;
  let evictions = 0;
  let disposals = 0;

  function projectDescriptor(projectId) {
    if (
      typeof projectId !== "string"
      || projectId !== projectId.trim()
      || !PROJECT_ID_PATTERN.test(projectId)
    ) {
      throw new PortfolioRuntimeError(
        "invalid_portfolio_project",
        "A valid portfolio project identifier is required",
        400,
        false,
      );
    }
    const project = projectsById.get(projectId);
    if (!project) {
      throw new PortfolioRuntimeError(
        "portfolio_project_not_found",
        "The requested portfolio project does not exist",
        404,
        false,
      );
    }
    return project;
  }

  function cacheEntryFor(project) {
    if (disposed) {
      throw new PortfolioRuntimeError(
        "portfolio_runtime_disposed",
        "The portfolio runtime has already been closed",
        503,
        false,
      );
    }
    emitCacheEvent("portfolio_request");
    const cached = runtimeCache.get(project.id);
    if (cached) {
      runtimeCache.delete(project.id);
      runtimeCache.set(project.id, cached);
      emitCacheEvent("portfolio_hit");
      return cached;
    }
    emitCacheEvent("portfolio_miss");
    const entry = {
      disposePromise: null,
      evicted: false,
      idleResolve: null,
      leases: 0,
      promise: null,
    };
    entry.promise = Promise.resolve()
      .then(() => createProjectRuntime({
        projectRoot: project.root,
        projectId: project.id,
        limits: options.limits,
        clock: options.clock,
        summaryRanking: options.summaryRanking,
        redactionPolicy: options.redactionPolicy,
        operationalPolicy: options.operationalPolicy,
        buildViewModel: options.buildViewModel,
        buildPortfolioSummary: options.buildPortfolioSummary,
        onCacheEvent(event) {
          emitCacheEvent(event?.type);
        },
      }))
      .then(async (runtime) => {
        validateProjectRuntime(runtime);
        if (runtime.configurationRevision !== undefined) {
          if (
            pinnedConfigurationRevisions.has(project.id)
            && pinnedConfigurationRevisions.get(project.id) !== runtime.configurationRevision
          ) {
            await runtime.dispose?.();
            emitCacheEvent("portfolio_dispose");
            throw new PortfolioRuntimeError(
              "observability_configuration_changed",
              "Project observability configuration changed while Change Observatory was running. Restart it to apply the reviewed privacy settings safely.",
              503,
              false,
            );
          }
          pinnedConfigurationRevisions.set(project.id, runtime.configurationRevision);
        }
        return runtime;
      })
      .catch((error) => {
        if (runtimeCache.get(project.id) === entry) runtimeCache.delete(project.id);
        entry.evicted = true;
        throw error;
      });
    runtimeCache.set(project.id, entry);
    evictLeastRecentlyUsed();
    return entry;
  }

  async function withRuntime(project, operation) {
    if (project.unavailableCode) {
      throw new PortfolioRuntimeError(
        project.unavailableCode,
        "This project's folder was not found. Check its path in the portfolio file.",
        404,
        false,
      );
    }
    await assertPortfolioProjectBoundary(manifest, project.id);
    const entry = cacheEntryFor(project);
    entry.leases += 1;
    try {
      const runtime = await entry.promise;
      await assertPortfolioProjectBoundary(manifest, project.id);
      return await operation(runtime);
    } finally {
      entry.leases -= 1;
      if (entry.leases === 0 && entry.idleResolve) {
        entry.idleResolve();
        entry.idleResolve = null;
      }
    }
  }

  async function loadProjectModel(project) {
    return withRuntime(project, async (runtime) => {
      const representation = await runtime.getRepresentation();
      await assertPortfolioProjectBoundary(manifest, project.id);
      return parseProjectModel(representation);
    });
  }

  async function loadProjectSummary(project) {
    return withRuntime(project, async (runtime) => {
      const summary = await runtime.getPortfolioSummary();
      await assertPortfolioProjectBoundary(manifest, project.id);
      return summary;
    });
  }

  async function buildSummaryRepresentation() {
    await assertPortfolioEnvelopeBoundaries(manifest);
    const summary = await collectPortfolioSummary(manifest.projects, {
      concurrency: options.concurrency,
      clock: () => generatedAt,
      loadProject: loadProjectSummary,
    });
    await assertPortfolioEnvelopeBoundaries(manifest);
    return createJsonRepresentation(summary);
  }

  async function getSummaryRepresentation() {
    if (summaryInFlight) return summaryInFlight;
    const pending = buildSummaryRepresentation();
    summaryInFlight = pending;
    try {
      return await pending;
    } finally {
      if (summaryInFlight === pending) summaryInFlight = null;
    }
  }

  async function getProjectDetailRepresentation(projectId) {
    await assertPortfolioEnvelopeBoundaries(manifest);
    const project = projectDescriptor(projectId);
    const model = await loadProjectModel(project);
    const portfolioModel = rewritePortfolioRawHrefs(model, project.id);
    await assertPortfolioProjectBoundary(manifest, project.id);
    await assertPortfolioEnvelopeBoundaries(manifest);
    return createJsonRepresentation(portfolioModel);
  }

  async function getSourceRepresentation(projectId, relativePath) {
    await assertPortfolioEnvelopeBoundaries(manifest);
    const project = projectDescriptor(projectId);
    await assertPortfolioProjectBoundary(manifest, project.id);
    return withRuntime(project, async (runtime) => {
      const source = await runtime.readSource(relativePath);
      await assertPortfolioProjectBoundary(manifest, project.id);
      await assertPortfolioEnvelopeBoundaries(manifest);
      return createJsonRepresentation(source);
    });
  }

  async function getClaimsRepresentation(projectId) {
    await assertPortfolioEnvelopeBoundaries(manifest);
    const project = projectDescriptor(projectId);
    await assertPortfolioProjectBoundary(manifest, project.id);
    return withRuntime(project, async (runtime) => {
      const claims = typeof runtime.readSharedClaims === "function"
        ? await runtime.readSharedClaims()
        : { schemaVersion: "change-observatory:claims:v1", checked: false, error: null, claims: [] };
      await assertPortfolioProjectBoundary(manifest, project.id);
      return createJsonRepresentation(claims);
    });
  }

  async function getDependenciesRepresentation(projectId) {
    await assertPortfolioEnvelopeBoundaries(manifest);
    const project = projectDescriptor(projectId);
    await assertPortfolioProjectBoundary(manifest, project.id);
    return withRuntime(project, async (runtime) => {
      const dependencies = typeof runtime.readDependencies === "function"
        ? await runtime.readDependencies()
        : { schemaVersion: "change-observatory:dependencies:v1", found: false, error: null, edges: [] };
      await assertPortfolioProjectBoundary(manifest, project.id);
      return createJsonRepresentation(dependencies);
    });
  }

  function evictLeastRecentlyUsed() {
    while (runtimeCache.size > maxCachedProjects) {
      const [projectId, entry] = runtimeCache.entries().next().value;
      runtimeCache.delete(projectId);
      entry.evicted = true;
      evictions += 1;
      emitCacheEvent("portfolio_evict");
      void disposeEntry(entry).catch(() => {});
    }
  }

  function disposeEntry(entry) {
    if (entry.disposePromise) return entry.disposePromise;
    entry.disposePromise = (async () => {
      if (entry.leases > 0) {
        await new Promise((resolve) => {
          entry.idleResolve = resolve;
        });
      }
      let runtime;
      try {
        runtime = await entry.promise;
      } catch {
        return;
      }
      if (typeof runtime.dispose === "function") await runtime.dispose();
      else runtime.clear?.();
      disposals += 1;
      emitCacheEvent("portfolio_dispose");
    })();
    pendingDisposals.add(entry.disposePromise);
    entry.disposePromise.finally(() => pendingDisposals.delete(entry.disposePromise)).catch(() => {});
    return entry.disposePromise;
  }

  async function clearRuntimeCache({ final = false, graceMs = null } = {}) {
    const entries = [...runtimeCache.values()];
    runtimeCache.clear();
    for (const entry of entries) entry.evicted = true;
    emitCacheEvent(final ? "portfolio_dispose_all" : "portfolio_clear");
    const disposals = [...new Set([
      ...entries.map(disposeEntry),
      ...pendingDisposals,
    ])];
    const pending = Promise.all(disposals);
    if (final && graceMs !== null && !await settlesWithin(pending, graceMs)) {
      emitCacheEvent("portfolio_dispose_deferred");
      return;
    }
    await pending;
  }

  function emitCacheEvent(type) {
    if (!onCacheEvent || typeof type !== "string" || type === "") return;
    try {
      onCacheEvent(Object.freeze({ type }));
    } catch {
      // Operational telemetry must not alter a read result.
    }
  }

  return Object.freeze({
    manifest,
    async assertReady() {
      await assertPortfolioEnvelopeBoundaries(manifest);
      normalizePortfolioConcurrency(concurrency);
      return getSummaryRepresentation();
    },
    assertBoundaries() {
      return assertPortfolioEnvelopeBoundaries(manifest);
    },
    getSummaryRepresentation,
    getProjectDetailRepresentation,
    getSourceRepresentation,
    getClaimsRepresentation,
    getDependenciesRepresentation,
    async getProjectRedactionPolicy(projectId) {
      const project = projectDescriptor(projectId);
      return withRuntime(project, (runtime) => runtime.redactionPolicy);
    },
    cacheSnapshot() {
      return Object.freeze({
        size: runtimeCache.size,
        limit: maxCachedProjects,
        evictions,
        disposals,
        pinnedConfigurations: pinnedConfigurationRevisions.size,
      });
    },
    async clear() {
      await clearRuntimeCache();
    },
    async dispose({ graceMs = null } = {}) {
      if (graceMs !== null && (!Number.isSafeInteger(graceMs) || graceMs < 1)) {
        throw new TypeError("Portfolio disposal grace must be a positive safe integer");
      }
      if (disposed) return;
      disposed = true;
      await clearRuntimeCache({ final: true, graceMs });
      pinnedConfigurationRevisions.clear();
    },
  });
}

async function settlesWithin(promise, timeoutMs) {
  let timer;
  const outcome = await Promise.race([
    Promise.resolve(promise).then(
      () => ({ settled: true, error: null }),
      (error) => ({ settled: true, error }),
    ),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ settled: false, error: null }), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  if (outcome.error) throw outcome.error;
  return outcome.settled;
}

function parseProjectModel(representation) {
  const body = representation?.body;
  if (!Buffer.isBuffer(body) && !(body instanceof Uint8Array)) {
    throw new TypeError("Project runtime returned an invalid model representation");
  }
  let model;
  try {
    model = JSON.parse(Buffer.from(body).toString("utf8"));
  } catch {
    throw new TypeError("Project runtime returned malformed model JSON");
  }
  if (model?.schemaVersion !== "change-observatory:view:v1") {
    throw new TypeError("Project runtime returned an unsupported model schema");
  }
  return model;
}

function rewritePortfolioRawHrefs(model, projectId) {
  return JSON.parse(JSON.stringify(model, (key, value) => {
    if (key !== "rawHref") return value;
    return rewriteRawHref(value, projectId);
  }));
}

function rewriteRawHref(value, projectId) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return null;
  let url;
  try {
    url = new URL(value, "http://change-observatory.local");
  } catch {
    return null;
  }
  if (
    url.origin !== "http://change-observatory.local"
    || url.pathname !== "/api/v1/source"
    || url.hash !== ""
    || [...url.searchParams.keys()].some((key) => key !== "path")
    || url.searchParams.getAll("path").length !== 1
  ) {
    return null;
  }
  let sourcePath;
  try {
    sourcePath = normalizePortableRelativePath(
      url.searchParams.get("path"),
      { requiredPrefix: ".sdlc" },
    );
  } catch {
    return null;
  }
  return `/api/v1/portfolio/source?project=${encodeURIComponent(projectId)}&path=${encodeURIComponent(sourcePath)}`;
}

function createJsonRepresentation(payload) {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
  const digest = crypto.createHash("sha256").update(body).digest("base64url");
  return Object.freeze({
    etag: `"sha256-${digest}"`,
    body,
  });
}

function validateProjectRuntime(runtime) {
  if (
    runtime === null
    || typeof runtime !== "object"
    || typeof runtime.getRepresentation !== "function"
    || typeof runtime.getPortfolioSummary !== "function"
    || typeof runtime.readSource !== "function"
  ) {
    throw new TypeError("Portfolio project factory returned an invalid runtime");
  }
}

function normalizeCacheLimit(value, concurrency) {
  const normalized = value ?? DEFAULT_MAX_CACHED_PORTFOLIO_PROJECTS;
  if (
    !Number.isSafeInteger(normalized)
    || normalized < concurrency
    || normalized > MAX_CACHED_PORTFOLIO_PROJECTS
  ) {
    throw new TypeError(
      `Portfolio project cache limit must be between collection concurrency (${concurrency}) and ${MAX_CACHED_PORTFOLIO_PROJECTS}`,
    );
  }
  return normalized;
}

function normalizeInstant(clock) {
  const value = typeof clock === "function" ? clock() : clock ?? new Date();
  const instant = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(instant.getTime())) {
    throw new TypeError("Portfolio clock returned an invalid date");
  }
  return instant.toISOString();
}
