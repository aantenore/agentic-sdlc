import { Date, process } from "../runtime/host.mjs";
import {
  createCorrelationId,
  createMetricRegistry,
  createOperationContext,
  createSupportBundle,
  evaluateSlo,
  isValidCorrelationId,
} from "../observability/index.mjs";
import {
  OBSERVATORY_HEALTH_SCHEMA_VERSION,
  OBSERVATORY_VIEW_SCHEMA_VERSION,
} from "./constants.mjs";

const ROUTES = Object.freeze([
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
]);
const STATUS_CLASSES = Object.freeze(["2xx", "3xx", "4xx", "5xx"]);
const CACHE_EVENTS = Object.freeze([
  "request",
  "join",
  "success",
  "failure",
  "fast_hit",
  "revision_hit",
  "build_start",
  "build_success",
  "retry",
  "clear",
  "portfolio_request",
  "portfolio_hit",
  "portfolio_miss",
  "portfolio_evict",
  "portfolio_dispose",
  "portfolio_clear",
  "portfolio_dispose_all",
  "portfolio_dispose_deferred",
]);
const READINESS_OUTCOMES = Object.freeze(["ready", "not_ready"]);
const DEFAULT_MAX_RECENT_REQUESTS = 50;
const MAX_RECENT_REQUESTS = 1_000;
const DEFAULT_AVAILABILITY_TARGET = 0.99;
const DEFAULT_READINESS_TARGET = 0.99;
const DEFAULT_MINIMUM_SAMPLES = 20;

export class ObservatoryCorrelationError extends TypeError {
  constructor(correlationId) {
    super("X-Correlation-ID must use the form corr-<uuid>");
    this.name = "ObservatoryCorrelationError";
    this.code = "invalid_correlation_id";
    this.statusCode = 400;
    this.correlationId = correlationId;
    this.retryable = false;
  }
}

export function createObservatoryOperations(options = {}) {
  if (!isPlainRecord(options)) {
    throw new TypeError("Observatory operations options must be a plain object");
  }
  const clock = options.clock ?? (() => new Date());
  const randomUUID = options.randomUUID;
  if (typeof clock !== "function") throw new TypeError("Observatory operations clock must be a function");
  if (randomUUID !== undefined && typeof randomUUID !== "function") {
    throw new TypeError("Observatory operations randomUUID must be a function");
  }
  const maxRecentRequests = positiveInteger(
    options.maxRecentRequests ?? DEFAULT_MAX_RECENT_REQUESTS,
    "maxRecentRequests",
    MAX_RECENT_REQUESTS,
  );
  const availabilityTarget = ratio(options.availabilityTarget ?? DEFAULT_AVAILABILITY_TARGET, "availabilityTarget");
  const readinessTarget = ratio(options.readinessTarget ?? DEFAULT_READINESS_TARGET, "readinessTarget");
  const minimumSamples = positiveInteger(options.minimumSamples ?? DEFAULT_MINIMUM_SAMPLES, "minimumSamples");
  const modelSchemaVersion = options.modelSchemaVersion ?? OBSERVATORY_VIEW_SCHEMA_VERSION;
  if (typeof modelSchemaVersion !== "string" || modelSchemaVersion.trim() === "") {
    throw new TypeError("Observatory modelSchemaVersion must be a non-empty string");
  }
  const registry = createMetricRegistry({
    definitions: [
      {
        name: "observatory_http_requests_total",
        type: "counter",
        labels: { route: ROUTES, status_class: STATUS_CLASSES },
      },
      {
        name: "observatory_http_duration_ms",
        type: "distribution",
        labels: { route: ROUTES },
      },
      {
        name: "observatory_model_cache_events_total",
        type: "counter",
        labels: { event: CACHE_EVENTS },
      },
      {
        name: "observatory_readiness_checks_total",
        type: "counter",
        labels: { outcome: READINESS_OUTCOMES },
      },
    ],
  });
  const recentRequests = [];
  let availabilityGood = 0;
  let availabilityTotal = 0;
  let readinessGood = 0;
  let readinessTotal = 0;
  let readiness = Object.freeze({
    schemaVersion: "change-observatory:readiness:v1",
    status: "unknown",
    checkedAt: null,
    correlationId: null,
    code: "not_checked",
  });

  function beginRequest(headerValue) {
    const fallback = createCorrelationId(randomUUID);
    const provided = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    const valid = provided === undefined || (typeof provided === "string" && isValidCorrelationId(provided));
    const correlationId = valid && provided !== undefined ? provided.toLowerCase() : fallback;
    const context = createOperationContext(
      { operation: "observatory.request", correlationId },
      { now: clock, randomUUID },
    );
    return Object.freeze({
      context,
      startedAt: monotonicMilliseconds(),
      invalidCorrelation: valid ? null : new ObservatoryCorrelationError(correlationId),
    });
  }

  function recordRequest({ requestState, route, statusCode, code = "ok" }) {
    try {
      const normalizedRoute = ROUTES.includes(route) ? route : "unknown";
      const statusClass = normalizeStatusClass(statusCode);
      const durationMs = Math.max(0, monotonicMilliseconds() - requestState.startedAt);
      registry.increment("observatory_http_requests_total", {
        route: normalizedRoute,
        status_class: statusClass,
      });
      registry.observe("observatory_http_duration_ms", { route: normalizedRoute }, durationMs);
      availabilityTotal += 1;
      if (Number(statusCode) < 500) availabilityGood += 1;
      recentRequests.push(Object.freeze({
        time: instant(clock()),
        correlationId: requestState.context.correlation_id,
        route: normalizedRoute,
        code: safeCode(code),
        status: Number.isInteger(statusCode) ? statusCode : 500,
      }));
      if (recentRequests.length > maxRecentRequests) {
        recentRequests.splice(0, recentRequests.length - maxRecentRequests);
      }
    } catch {
      // Observability must never change the governed response path.
    }
  }

  function recordCacheEvent(event) {
    try {
      if (event && CACHE_EVENTS.includes(event.type)) {
        registry.increment("observatory_model_cache_events_total", { event: event.type });
      }
    } catch {
      // Cache reads must remain independent from operational telemetry.
    }
  }

  function recordReadiness({ context, ready, code = ready ? "ready" : "not_ready" }) {
    const outcome = ready ? "ready" : "not_ready";
    try {
      registry.increment("observatory_readiness_checks_total", { outcome });
      readinessTotal += 1;
      if (ready) readinessGood += 1;
    } catch {
      // Readiness remains authoritative even if telemetry cannot be recorded.
    }
    readiness = Object.freeze({
      schemaVersion: "change-observatory:readiness:v1",
      status: outcome,
      checkedAt: instant(clock()),
      correlationId: context.correlation_id,
      code: safeCode(code),
    });
    return readiness;
  }

  function metricsSnapshot() {
    return Object.freeze({
      schemaVersion: "change-observatory:metrics:v1",
      generatedAt: instant(clock()),
      externalSinks: "disabled",
      cardinality: "closed",
      snapshot: registry.snapshot(),
    });
  }

  function sloSnapshot() {
    return Object.freeze({
      schemaVersion: "change-observatory:slo:v1",
      generatedAt: instant(clock()),
      mode: "advisory",
      evaluations: Object.freeze([
        evaluateSlo({
          name: "observatory_availability",
          good: availabilityGood,
          total: availabilityTotal,
          target: availabilityTarget,
          minimumSamples,
        }),
        evaluateSlo({
          name: "observatory_readiness",
          good: readinessGood,
          total: readinessTotal,
          target: readinessTarget,
          minimumSamples,
        }),
      ]),
    });
  }

  function supportBundle({ context, limits }) {
    const numericLimits = Object.fromEntries(
      Object.entries(isPlainRecord(limits) ? limits : {})
        .filter(([, value]) => Number.isSafeInteger(value) && value > 0)
        .sort(([left], [right]) => left.localeCompare(right)),
    );
    return createSupportBundle({
      context,
      generatedAt: clock(),
      allowedSections: [
        "limits",
        "metrics",
        "readiness",
        "recent_requests",
        "slo",
        "versions",
      ],
      sections: {
        limits: {
          ...numericLimits,
          maxRecentRequests,
        },
        metrics: metricsSnapshot(),
        readiness,
        recent_requests: [...recentRequests],
        slo: sloSnapshot(),
        versions: {
          healthSchema: OBSERVATORY_HEALTH_SCHEMA_VERSION,
          modelSchema: modelSchemaVersion,
          node: process.versions.node,
        },
      },
    }, { now: clock, randomUUID });
  }

  return Object.freeze({
    beginRequest,
    metricsSnapshot,
    recordCacheEvent,
    recordReadiness,
    recordRequest,
    readinessSnapshot: () => readiness,
    sloSnapshot,
    supportBundle,
  });
}

export function classifyObservatoryRoute(pathname) {
  if (pathname === "/api/v1/health" || pathname === "/api/v1/live") return "live";
  if (pathname === "/api/v1/ready") return "ready";
  if (pathname === "/api/v1/observatory") return "model";
  if (pathname === "/api/v1/source") return "source";
  if (pathname === "/api/v1/portfolio") return "portfolio";
  if (pathname === "/api/v1/portfolio/project") return "portfolio_project";
  if (pathname === "/api/v1/portfolio/source") return "portfolio_source";
  if (pathname === "/api/v1/metrics") return "metrics";
  if (pathname === "/api/v1/slo") return "slo";
  if (pathname === "/api/v1/support-bundle") return "support_bundle";
  if (!pathname.startsWith("/api/")) return "static";
  return "unknown";
}

function normalizeStatusClass(value) {
  const status = Number(value);
  if (status >= 200 && status < 300) return "2xx";
  if (status >= 300 && status < 400) return "3xx";
  if (status >= 400 && status < 500) return "4xx";
  return "5xx";
}

function safeCode(value) {
  const normalized = String(value || "unknown").toLowerCase();
  return /^[a-z][a-z0-9_.-]{0,63}$/u.test(normalized) ? normalized : "unknown";
}

function monotonicMilliseconds() {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

function instant(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("Observatory clock returned an invalid date");
  return date.toISOString();
}

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${label} must be a positive safe integer no greater than ${maximum}`);
  }
  return value;
}

function ratio(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${label} must be between 0 and 1`);
  }
  return value;
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
