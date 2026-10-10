import http from "node:http";
import path from "node:path";
import zlib from "node:zlib";

import { silenceProgress } from "../runtime/bounded-child-process.mjs";
import { crypto, fsPromises as fs } from "../runtime/host.mjs";
import {
  OBSERVATORY_HEALTH_SCHEMA_VERSION,
  OBSERVATORY_VIEW_SCHEMA_VERSION,
  SECURITY_HEADERS,
  normalizeObservatoryLimits,
} from "./constants.mjs";
import { readResolvedFileBounded } from "./bounded-file-reader.mjs";
import {
  ObservatoryCorrelationError,
  classifyObservatoryRoute,
  createObservatoryOperations,
} from "./operations.mjs";
import {
  ObservatoryPathError,
  assertDirectoryIdentity,
  captureDirectoryIdentity,
  normalizePortableRelativePath,
  resolveExistingFileWithin,
} from "./path-safety.mjs";
import {
  ProjectDataRuntimeError,
  createProjectDataRuntime,
} from "./project-runtime.mjs";
import { PORTFOLIO_VIEW_SCHEMA_VERSION } from "./portfolio-collector.mjs";
import {
  PortfolioRuntimeError,
  createPortfolioRuntime,
} from "./portfolio-runtime.mjs";
import {
  createOperationContext,
  normalizeOperationalError,
} from "../observability/context.mjs";
import { DEFAULT_OPERATIONAL_REDACTION_POLICY } from "../observability/redaction.mjs";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_SERVER_SHUTDOWN_GRACE_MS = 2_000;
const DEFAULT_SERVER_COLLECTION_ITEMS = 1_000;
// Dossiers have their own budget, so every story keeps its evidence instead of
// the first stories in ID order using up the shared collection limit.
const DEFAULT_SERVER_DOSSIER_ITEMS = 20_000;
const DEFAULT_SERVER_DOSSIER_LANE_ITEMS = 25;

export async function createObservatoryRequestHandler(options = {}) {
  const portfolioMode = options.portfolioManifest !== undefined
    || options.portfolioRuntime !== undefined;
  const assetRoot = options.assetRoot ? await resolveAssetRoot(options.assetRoot) : null;
  const assetIdentity = assetRoot
    ? await captureDirectoryIdentity(assetRoot, {
      code: "asset_boundary_changed",
      label: "bundled UI root",
    })
    : null;
  const limits = normalizeServerLimits(options.limits);
  let operations = null;
  const projectRuntime = portfolioMode
    ? null
    : await createProjectDataRuntime({
      projectRoot: options.projectRoot,
      limits,
      redactionPolicy: options.redactionPolicy,
      operationalPolicy: options.operationalPolicy,
      buildViewModel: options.buildViewModel,
      summaryRanking: options.summaryRanking,
      clock: options.clock,
      onCacheEvent(event) {
        operations?.recordCacheEvent(event);
      },
    });
  const portfolioRuntime = portfolioMode
    ? options.portfolioRuntime ?? await createPortfolioRuntime({
      portfolioRoot: options.projectRoot,
      manifestPath: options.portfolioManifest,
      limits,
      summaryRanking: options.summaryRanking,
      redactionPolicy: options.redactionPolicy,
      operationalPolicy: options.operationalPolicy,
      clock: options.clock,
      concurrency: options.portfolioConcurrency,
      maxCachedProjects: options.maxCachedPortfolioProjects,
      createProjectRuntime: options.createProjectRuntime,
      buildPortfolioSummary: options.buildPortfolioSummary,
      buildViewModel: options.buildViewModel,
      onCacheEvent(event) {
        operations?.recordCacheEvent(event);
      },
    })
    : null;
  operations = createObservatoryOperations({
    clock: options.clock,
    randomUUID: options.randomUUID,
    ...(projectRuntime?.operationalPolicy ?? options.operationalPolicy ?? {}),
    modelSchemaVersion: portfolioMode
      ? PORTFOLIO_VIEW_SCHEMA_VERSION
      : OBSERVATORY_VIEW_SCHEMA_VERSION,
  });
  const accessToken = normalizeAccessToken(options.accessToken);
  const host = options.host ?? LOOPBACK_HOST;
  if (host !== LOOPBACK_HOST) {
    throw new TypeError(`Change Observatory may bind only to ${LOOPBACK_HOST}`);
  }
  const expectedPort = typeof options.expectedPort === "function"
    ? options.expectedPort
    : () => options.expectedPort ?? null;

  async function checkReadiness(context) {
    try {
      if (portfolioMode) await portfolioRuntime.assertReady();
      else await projectRuntime.assertReady();
      if (assetIdentity) await assertDirectoryIdentity(assetIdentity);
      return operations.recordReadiness({ context, ready: true });
    } catch (error) {
      return operations.recordReadiness({
        context,
        ready: false,
        code: operationalErrorCode(error),
      });
    }
  }

  const handler = async function observatoryRequestHandler(request, response) {
    applySecurityHeaders(response);
    const requestState = operations.beginRequest(request.headers["x-correlation-id"]);
    response.setHeader("X-Correlation-ID", requestState.context.correlation_id);
    let route = "unknown";
    let resultCode = "ok";
    let responseRedactionPolicy = projectRuntime?.redactionPolicy
      ?? DEFAULT_OPERATIONAL_REDACTION_POLICY;
    response.once("finish", () => {
      operations.recordRequest({
        requestState,
        route,
        statusCode: response.statusCode,
        code: resultCode,
      });
    });
    try {
      validateRequestMethod(request.method);
      validateHostHeader(request.headers.host, host, expectedPort());
      validateRawRequestPath(request.url);

      const url = new URL(request.url ?? "/", `http://${host}`);
      route = classifyObservatoryRoute(url.pathname);
      if (requestState.invalidCorrelation) throw requestState.invalidCorrelation;

      if (url.pathname === "/api/v1/health" || url.pathname === "/api/v1/live") {
        return sendJson(request, response, 200, {
          schemaVersion: OBSERVATORY_HEALTH_SCHEMA_VERSION,
          status: "ok",
          component: "change-observatory",
          modelSchemaVersion: portfolioMode
            ? PORTFOLIO_VIEW_SCHEMA_VERSION
            : OBSERVATORY_VIEW_SCHEMA_VERSION,
          correlationId: requestState.context.correlation_id,
        });
      }
      if (url.pathname === "/api/v1/ready") {
        validateAccessToken(request.headers.authorization, accessToken);
        const readiness = await checkReadiness(requestState.context);
        resultCode = readiness.code;
        return sendJson(request, response, readiness.status === "ready" ? 200 : 503, readiness);
      }
      if (url.pathname === "/api/v1/metrics") {
        validateAccessToken(request.headers.authorization, accessToken);
        return sendJson(request, response, 200, operations.metricsSnapshot());
      }
      if (url.pathname === "/api/v1/slo") {
        validateAccessToken(request.headers.authorization, accessToken);
        return sendJson(request, response, 200, operations.sloSnapshot());
      }
      if (url.pathname === "/api/v1/support-bundle") {
        validateAccessToken(request.headers.authorization, accessToken);
        return sendJson(request, response, 200, operations.supportBundle({
          context: requestState.context,
          limits,
        }));
      }

      if (portfolioMode) await portfolioRuntime.assertBoundaries();
      else await projectRuntime.assertBoundary();
      if (assetIdentity) await assertDirectoryIdentity(assetIdentity);
      if (portfolioMode && url.pathname === "/api/v1/portfolio") {
        validateAccessToken(request.headers.authorization, accessToken);
        validateExactQuery(url, []);
        const representation = await portfolioRuntime.getSummaryRepresentation();
        const status = sendModelRepresentation(request, response, representation);
        if (status === 304) resultCode = "not_modified";
        return status;
      }
      if (portfolioMode && url.pathname === "/api/v1/portfolio/project") {
        validateAccessToken(request.headers.authorization, accessToken);
        const { project } = validateExactQuery(url, ["project"]);
        responseRedactionPolicy = await portfolioRuntime.getProjectRedactionPolicy(project);
        const representation = await portfolioRuntime.getProjectDetailRepresentation(project);
        const status = sendModelRepresentation(request, response, representation);
        if (status === 304) resultCode = "not_modified";
        return status;
      }
      if (portfolioMode && url.pathname === "/api/v1/portfolio/source") {
        validateAccessToken(request.headers.authorization, accessToken);
        const { project, path: sourcePath } = validateExactQuery(url, ["project", "path"]);
        responseRedactionPolicy = await portfolioRuntime.getProjectRedactionPolicy(project);
        const representation = await portfolioRuntime.getSourceRepresentation(project, sourcePath);
        const status = sendModelRepresentation(request, response, representation);
        if (status === 304) resultCode = "not_modified";
        return status;
      }
      if (portfolioMode && url.pathname === "/api/v1/portfolio/claims") {
        validateAccessToken(request.headers.authorization, accessToken);
        const { project } = validateExactQuery(url, ["project"]);
        if (typeof portfolioRuntime.getClaimsRepresentation !== "function") {
          return sendJson(request, response, 200, { schemaVersion: "change-observatory:claims:v1", checked: false, error: null, claims: [] });
        }
        const representation = await portfolioRuntime.getClaimsRepresentation(project);
        return sendModelRepresentation(request, response, representation);
      }
      if (!portfolioMode && url.pathname === "/api/v1/claims") {
        validateAccessToken(request.headers.authorization, accessToken);
        validateExactQuery(url, []);
        const claims = typeof projectRuntime.readSharedClaims === "function"
          ? await projectRuntime.readSharedClaims()
          : { schemaVersion: "change-observatory:claims:v1", checked: false, error: null, claims: [] };
        return sendJson(request, response, 200, claims);
      }
      if (portfolioMode && url.pathname === "/api/v1/portfolio/dependencies") {
        validateAccessToken(request.headers.authorization, accessToken);
        const { project } = validateExactQuery(url, ["project"]);
        if (typeof portfolioRuntime.getDependenciesRepresentation !== "function") {
          return sendJson(request, response, 200, { schemaVersion: "change-observatory:dependencies:v1", found: false, error: null, edges: [] });
        }
        const representation = await portfolioRuntime.getDependenciesRepresentation(project);
        return sendModelRepresentation(request, response, representation);
      }
      if (!portfolioMode && url.pathname === "/api/v1/dependencies") {
        validateAccessToken(request.headers.authorization, accessToken);
        validateExactQuery(url, []);
        const dependencies = typeof projectRuntime.readDependencies === "function"
          ? await projectRuntime.readDependencies()
          : { schemaVersion: "change-observatory:dependencies:v1", found: false, error: null, edges: [] };
        return sendJson(request, response, 200, dependencies);
      }
      if (portfolioMode && url.pathname === "/api/v1/portfolio/remote-stories") {
        validateAccessToken(request.headers.authorization, accessToken);
        const { project } = validateExactQuery(url, ["project"]);
        if (typeof portfolioRuntime.getRemoteStoriesRepresentation !== "function") {
          return sendJson(request, response, 200, { schemaVersion: "change-observatory:remote-stories:v1", checked: false, branch: null, stories: [] });
        }
        const representation = await portfolioRuntime.getRemoteStoriesRepresentation(project);
        return sendModelRepresentation(request, response, representation);
      }
      if (!portfolioMode && url.pathname === "/api/v1/remote-stories") {
        validateAccessToken(request.headers.authorization, accessToken);
        validateExactQuery(url, []);
        const remote = typeof projectRuntime.readRemoteStories === "function"
          ? await projectRuntime.readRemoteStories()
          : { schemaVersion: "change-observatory:remote-stories:v1", checked: false, branch: null, stories: [] };
        return sendJson(request, response, 200, remote);
      }
      if (!portfolioMode && url.pathname === "/api/v1/source-ref") {
        validateAccessToken(request.headers.authorization, accessToken);
        validateExactQuery(url, []);
        const source = typeof options.sourceRef === "function" ? options.sourceRef() : { mode: "worktree" };
        return sendJson(request, response, 200, {
          ...source,
          ...(Number.isFinite(options.liveRefreshSeconds) ? { liveSeconds: options.liveRefreshSeconds } : {}),
        });
      }
      if (!portfolioMode && url.pathname === "/api/v1/refresh") {
        // Forces the record source (remote fetch + snapshot sync) to catch up
        // now; the model cache then revalidates the evidence on the next read.
        validateAccessToken(request.headers.authorization, accessToken);
        // `?fetch=0` re-syncs from refs already present locally (cheap, used by
        // live polling); without it the remote is fetched too.
        const localOnly = url.searchParams.get("fetch") === "0";
        if (url.searchParams.size > (localOnly ? 1 : 0) || (url.searchParams.size === 1 && !localOnly)) {
          throw new ObservatoryHttpError("invalid_refresh_request", "Only fetch=0 is accepted", 400, false);
        }
        if (typeof options.refreshSource === "function") await options.refreshSource({ fetch: !localOnly });
        const source = typeof options.sourceRef === "function" ? options.sourceRef() : { mode: "worktree" };
        return sendJson(request, response, 200, {
          schemaVersion: "change-observatory:refresh:v1",
          refreshedAt: new Date().toISOString(),
          source,
        });
      }
      if (!portfolioMode && url.pathname === "/api/v1/now") {
        validateAccessToken(request.headers.authorization, accessToken);
        validateExactQuery(url, []);
        const now = typeof projectRuntime.readNow === "function"
          ? await projectRuntime.readNow()
          : { schemaVersion: "change-observatory:now:v1", messaging: "off", work: [], senders: [], open: [], free: [] };
        return sendJson(request, response, 200, now);
      }
      if (!portfolioMode && url.pathname === "/api/v1/observatory") {
        validateAccessToken(request.headers.authorization, accessToken);
        const representation = await projectRuntime.getRepresentation();
        const status = sendModelRepresentation(request, response, representation);
        if (status === 304) resultCode = "not_modified";
        return status;
      }
      if (!portfolioMode && url.pathname === "/api/v1/source") {
        validateAccessToken(request.headers.authorization, accessToken);
        const sourcePaths = url.searchParams.getAll("path");
        if (sourcePaths.length !== 1) {
          throw new ObservatoryHttpError("invalid_source_request", "Exactly one source path is required", 400);
        }
        const source = await projectRuntime.readSource(sourcePaths[0]);
        return sendJson(request, response, 200, source);
      }
      if (url.pathname.startsWith("/api/")) {
        throw new ObservatoryHttpError("api_not_found", "The requested API endpoint does not exist", 404);
      }
      if (!assetRoot) {
        throw new ObservatoryHttpError("asset_not_found", "No bundled user interface is configured", 404);
      }
      return serveStaticAsset(request, response, assetRoot, url.pathname, limits);
    } catch (error) {
      resultCode = operationalErrorCode(error);
      return sendError(
        request,
        response,
        error,
        requestState.context,
        responseRedactionPolicy,
      );
    }
  };

  handler.warmReadiness = async () => {
    const context = createOperationContext({ operation: "observatory.readiness" }, {
      now: options.clock,
      randomUUID: options.randomUUID,
    });
    return checkReadiness(context);
  };
  handler.operations = operations;
  handler.redactionPolicy = projectRuntime?.redactionPolicy
    ?? DEFAULT_OPERATIONAL_REDACTION_POLICY;
  handler.mode = portfolioMode ? "portfolio" : "project";
  handler.dispose = async ({ graceMs = null } = {}) => {
    if (portfolioRuntime) await portfolioRuntime.dispose({ graceMs });
    else projectRuntime?.dispose?.();
  };
  return handler;
}

export async function startObservatoryServer(options = {}) {
  options.signal?.throwIfAborted?.();
  const host = options.host ?? LOOPBACK_HOST;
  if (host !== LOOPBACK_HOST) {
    throw new TypeError(`Change Observatory may bind only to ${LOOPBACK_HOST}`);
  }
  const port = options.port ?? 0;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError("Observatory port must be an integer between 0 and 65535");
  }
  const shutdownGraceMs = options.shutdownGraceMs
    ?? DEFAULT_SERVER_SHUTDOWN_GRACE_MS;
  if (!Number.isSafeInteger(shutdownGraceMs) || shutdownGraceMs < 1) {
    throw new TypeError("Observatory shutdown grace must be a positive safe integer");
  }

  const accessToken = normalizeAccessToken(
    options.accessToken ?? crypto.randomBytes(32).toString("base64url"),
  );
  let listeningPort = port;
  const handler = await createObservatoryRequestHandler({
    ...options,
    host,
    accessToken,
    expectedPort: () => listeningPort,
  });
  options.signal?.throwIfAborted?.();
  const server = http.createServer((request, response) => {
    handler(request, response).catch((error) => {
      const context = createOperationContext({ operation: "observatory.request" }, {
        now: options.clock,
        randomUUID: options.randomUUID,
      });
      response.setHeader("X-Correlation-ID", context.correlation_id);
      return sendError(request, response, error, context, handler.redactionPolicy);
    });
  });
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  try {
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      // A server runs until stopped: its git calls are not a command still working.
      silenceProgress();
      server.listen({ host, port, exclusive: true });
    });
  } catch (error) {
    await handler.dispose();
    throw error;
  }
  if (options.signal?.aborted) {
    await closeServer(server, { sockets, shutdownGraceMs });
    await handler.dispose();
    options.signal.throwIfAborted?.();
  }

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server, { sockets, shutdownGraceMs });
    await handler.dispose();
    throw new Error("Observatory server did not expose a TCP address");
  }
  listeningPort = address.port;
  const url = `http://${host}:${listeningPort}/`;
  const accessUrl = new URL(url);
  if (portfolioModeEnabled(options)) accessUrl.searchParams.set("mode", "portfolio");
  const locale = String(options.locale || "en").trim().toLowerCase().split(/[-_]/u)[0];
  if (!["en", "it"].includes(locale)) {
    await closeServer(server, { sockets, shutdownGraceMs });
    await handler.dispose();
    throw new TypeError("Change Observatory locale must be en or it");
  }
  if (options.locale !== undefined) accessUrl.searchParams.set("locale", locale);
  accessUrl.hash = new URLSearchParams({ access_token: accessToken }).toString();
  let closed = false;

  return {
    server,
    url,
    accessUrl: accessUrl.href,
    accessToken,
    address: { host, port: listeningPort },
    healthUrl: new URL("api/v1/health", url).href,
    liveUrl: new URL("api/v1/live", url).href,
    readyUrl: new URL("api/v1/ready", url).href,
    modelUrl: new URL(
      portfolioModeEnabled(options) ? "api/v1/portfolio" : "api/v1/observatory",
      url,
    ).href,
    portfolioUrl: portfolioModeEnabled(options)
      ? new URL("api/v1/portfolio", url).href
      : null,
    metricsUrl: new URL("api/v1/metrics", url).href,
    sloUrl: new URL("api/v1/slo", url).href,
    supportBundleUrl: new URL("api/v1/support-bundle", url).href,
    warmReadiness: handler.warmReadiness,
    async close() {
      if (closed) return;
      closed = true;
      try {
        await closeServer(server, { sockets, shutdownGraceMs });
      } finally {
        await handler.dispose({ graceMs: shutdownGraceMs });
      }
    },
  };
}

class ObservatoryHttpError extends Error {
  constructor(code, message, statusCode, retryable = undefined) {
    super(message);
    this.name = "ObservatoryHttpError";
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = retryable;
  }
}

function validateRequestMethod(method) {
  if (!["GET", "HEAD"].includes(method)) {
    throw new ObservatoryHttpError("method_not_allowed", "Only GET and HEAD are allowed", 405);
  }
}

function validateHostHeader(header, expectedHost, expectedPort) {
  if (
    typeof header !== "string"
    || header.trim() === ""
    || header !== header.trim()
    || header.length > 64
    || /[\\/@\s?#]/.test(header)
  ) {
    throw new ObservatoryHttpError("invalid_host", "The Host header is invalid", 400);
  }
  const expected = expectedPort === null || expectedPort === undefined
    ? null
    : `${expectedHost}:${expectedPort}`;
  if (expected ? header !== expected : !new RegExp(`^${expectedHost.replaceAll(".", "\\.")}(?::[0-9]{1,5})?$`).test(header)) {
    throw new ObservatoryHttpError("invalid_host", "The Host header is not allowed", 400);
  }
}

function validateRawRequestPath(requestUrl) {
  const rawPath = String(requestUrl ?? "/").split("?", 1)[0];
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    throw new ObservatoryHttpError("invalid_path_encoding", "The request path is not valid UTF-8", 400);
  }
  if (decoded.includes("\0") || decoded.includes("\\")) {
    throw new ObservatoryHttpError("invalid_path", "The request path is invalid", 400);
  }
  if (decoded.split("/").some((segment) => segment === "..")) {
    throw new ObservatoryHttpError("path_traversal", "Path traversal is not allowed", 403);
  }
}

function validateExactQuery(url, requiredNames) {
  const keys = [...url.searchParams.keys()];
  if (
    keys.length !== requiredNames.length
    || requiredNames.some((name) => url.searchParams.getAll(name).length !== 1)
    || keys.some((name) => !requiredNames.includes(name))
  ) {
    throw new ObservatoryHttpError(
      "invalid_portfolio_request",
      requiredNames.length === 0
        ? "This portfolio endpoint does not accept query parameters"
        : `Exactly one ${requiredNames.map((name) => `"${name}"`).join(" and one ")} query parameter must be provided`,
      400,
      false,
    );
  }
  return Object.fromEntries(requiredNames.map((name) => [name, url.searchParams.get(name)]));
}

async function serveStaticAsset(request, response, assetRoot, pathname, limits) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new ObservatoryHttpError("invalid_path_encoding", "The request path is not valid UTF-8", 400);
  }
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const normalized = normalizePortableRelativePath(relative);
  let asset;
  try {
    asset = await resolveExistingFileWithin(assetRoot, normalized);
  } catch (error) {
    if (error instanceof ObservatoryPathError) {
      const statusCode = error.statusCode === 403 ? 403 : 404;
      throw new ObservatoryHttpError(error.code, statusCode === 403 ? "The asset path is not allowed" : "Asset not found", statusCode);
    }
    throw error;
  }
  if (asset.stats.size > limits.maxAssetBytes) {
    throw new ObservatoryHttpError("asset_too_large", "The requested asset exceeds the configured size limit", 413);
  }
  const content = await readResolvedFileBounded(asset, {
    maxBytes: limits.maxAssetBytes,
    boundaryCode: "asset_boundary_changed",
    tooLargeCode: "asset_too_large",
    tooLargeMessage: "The requested asset exceeds the configured size limit",
  });
  response.statusCode = 200;
  response.setHeader("Content-Type", mimeType(normalized));
  response.setHeader("Content-Length", String(content.byteLength));
  if (request.method === "HEAD") {
    response.end();
  } else {
    response.end(content);
  }
}

function sendJson(request, response, statusCode, payload) {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", String(body.byteLength));
  if (request.method === "HEAD") {
    response.end();
  } else {
    response.end(body);
  }
}

function sendModelRepresentation(request, response, representation) {
  response.setHeader("ETag", representation.etag);
  if (matchesIfNoneMatch(request.headers["if-none-match"], representation.etag)) {
    response.statusCode = 304;
    response.end();
    return 304;
  }

  response.statusCode = 200;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Vary", "Accept-Encoding");
  const body = acceptsGzip(request.headers["accept-encoding"])
    ? gzippedRepresentationBody(representation)
    : representation.body;
  if (body !== representation.body) response.setHeader("Content-Encoding", "gzip");
  response.setHeader("Content-Length", String(body.byteLength));
  if (request.method === "HEAD") {
    response.end();
  } else {
    response.end(body);
  }
  return 200;
}

// The model is mostly repeated JSON keys and identifiers: compressed once per
// representation, it travels at a small fraction of its size.
const GZIPPED_BODIES = new WeakMap();
const GZIP_MIN_BYTES = 1024;

function gzippedRepresentationBody(representation) {
  if (representation.body.byteLength < GZIP_MIN_BYTES) return representation.body;
  if (!GZIPPED_BODIES.has(representation)) {
    GZIPPED_BODIES.set(representation, zlib.gzipSync(representation.body, { level: 6 }));
  }
  return GZIPPED_BODIES.get(representation);
}

function acceptsGzip(header) {
  if (typeof header !== "string") return false;
  return header.split(",").some((part) => {
    const [coding, ...parameters] = part.trim().toLowerCase().split(";").map((value) => value.trim());
    if (coding !== "gzip" && coding !== "*") return false;
    const quality = parameters.find((parameter) => parameter.startsWith("q="));
    return !quality || Number(quality.slice(2)) > 0;
  });
}

function matchesIfNoneMatch(header, currentEtag) {
  if (typeof header !== "string") return false;
  return header.split(",").some((candidate) => {
    const trimmed = candidate.trim();
    if (trimmed === "*") return true;
    const weakCandidate = trimmed.startsWith("W/") ? trimmed.slice(2) : trimmed;
    return weakCandidate === currentEtag;
  });
}

function sendError(
  request,
  response,
  error,
  context,
  redactionPolicy = DEFAULT_OPERATIONAL_REDACTION_POLICY,
) {
  if (response.headersSent || response.writableEnded) {
    if (!response.writableEnded) response.end();
    return;
  }
  applySecurityHeaders(response);
  const isKnown = error instanceof ObservatoryHttpError
    || error instanceof ProjectDataRuntimeError
    || error instanceof PortfolioRuntimeError
    || error instanceof ObservatoryPathError
    || error instanceof ObservatoryCorrelationError;
  const statusCode = isKnown ? error.statusCode : 500;
  if (statusCode === 405) {
    response.setHeader("Allow", "GET, HEAD");
  }
  if (statusCode === 401) {
    response.setHeader("WWW-Authenticate", 'Bearer realm="Change Observatory"');
  }
  const safeContext = context ?? createOperationContext({ operation: "observatory.request" });
  const normalized = normalizeOperationalError(
    isKnown
      ? {
          code: error.code,
          message: error.message,
          statusCode,
          retryable: error.retryable,
        }
      : {
          code: "internal_error",
          message: "The request could not be completed",
          statusCode: 500,
          retryable: false,
        },
    { context: safeContext, redactionPolicy },
  );
  response.setHeader("X-Correlation-ID", safeContext.correlation_id);
  return sendJson(request, response, statusCode, {
    schemaVersion: "change-observatory:error:v1",
    status: "error",
    correlationId: safeContext.correlation_id,
    error: {
      code: normalized.error.code,
      message: normalized.error.message,
      retryable: normalized.error.retryable,
    },
  });
}

function operationalErrorCode(error) {
  if (
    error instanceof ObservatoryHttpError
    || error instanceof ProjectDataRuntimeError
    || error instanceof PortfolioRuntimeError
    || error instanceof ObservatoryPathError
    || error instanceof ObservatoryCorrelationError
  ) {
    return error.code;
  }
  return "internal_error";
}

function portfolioModeEnabled(options) {
  return options.portfolioManifest !== undefined || options.portfolioRuntime !== undefined;
}

function normalizeAccessToken(value, { allowMissing = false } = {}) {
  if ((value === undefined || value === null || value === "") && allowMissing) return null;
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(value)) {
    throw new TypeError("Observatory access token must be a 32-256 character base64url value");
  }
  return value;
}

function normalizeServerLimits(value) {
  const normalized = normalizeObservatoryLimits(value);
  if (value && Object.hasOwn(value, "maxCollectionItems")) return normalized;
  return Object.freeze({
    ...normalized,
    maxCollectionItems: DEFAULT_SERVER_COLLECTION_ITEMS,
    maxDossierItems: normalized.maxDossierItems ?? DEFAULT_SERVER_DOSSIER_ITEMS,
    maxDossierLaneItems: normalized.maxDossierLaneItems ?? DEFAULT_SERVER_DOSSIER_LANE_ITEMS,
  });
}

function validateAccessToken(header, expectedToken) {
  if (!expectedToken) return;
  const match = typeof header === "string" ? header.match(/^Bearer ([A-Za-z0-9_-]+)$/i) : null;
  const candidate = match?.[1] ?? "";
  const expected = Buffer.from(expectedToken, "utf8");
  const actual = Buffer.from(candidate, "utf8");
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    throw new ObservatoryHttpError("access_denied", "A valid per-run access token is required", 401);
  }
}

function applySecurityHeaders(response) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    response.setHeader(name, value);
  }
}

async function resolveAssetRoot(assetRoot) {
  const resolved = await fs.realpath(path.resolve(assetRoot));
  const stats = await fs.stat(resolved);
  if (!stats.isDirectory()) {
    throw new TypeError("Observatory assetRoot must be a directory");
  }
  return resolved;
}

function mimeType(relativePath) {
  switch (path.posix.extname(relativePath).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".js":
    case ".mjs": return "text/javascript; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".webp": return "image/webp";
    case ".ico": return "image/x-icon";
    case ".woff2": return "font/woff2";
    default: return "application/octet-stream";
  }
}

function closeServer(server, { sockets = new Set(), shutdownGraceMs } = {}) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      if (error) reject(error);
      else resolve();
    };
    const forceTimer = setTimeout(() => {
      try {
        server.closeAllConnections?.();
        for (const socket of sockets) socket.destroy();
        settle();
      } catch (error) {
        settle(error);
      }
    }, shutdownGraceMs);
    forceTimer.unref?.();
    try {
      server.close((error) => settle(error));
      server.closeIdleConnections?.();
    } catch (error) {
      settle(error);
    }
  });
}
