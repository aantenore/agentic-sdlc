export const PORTFOLIO_VIEW_SCHEMA = "change-observatory:portfolio:v1";

const MAX_PROJECTS = 64;
const MAX_PREVIEWS = 8;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/u;
const VIEW_FRAGMENT_PATTERN = /^[a-z]+(?:-[a-z]+)*$/u;
const LOCALE_QUERY_PATTERN = /^(?:en|it)(?:[-_][A-Za-z0-9]{1,8})?$/iu;
const COUNT_KEYS = Object.freeze([
  "asked",
  "changed",
  "decided",
  "iterations",
  "contracts",
  "decisions",
  "changes",
  "verification",
  "diagnostics",
]);

export function portfolioModeFromLocation(locationLike = {}) {
  const params = new URLSearchParams(String(locationLike.search ?? ""));
  const modes = params.getAll("mode");
  return modes.length === 1 && modes[0] === "portfolio";
}

export function portfolioProjectRouteFromLocation(locationLike = {}) {
  const params = new URLSearchParams(String(locationLike.search ?? ""));
  const projects = params.getAll("project");
  if (projects.length === 0) {
    return Object.freeze({ projectId: null, valid: true });
  }
  if (projects.length !== 1) {
    return Object.freeze({ projectId: null, valid: false });
  }
  try {
    return Object.freeze({
      projectId: normalizePortfolioProjectId(projects[0]),
      valid: true,
    });
  } catch {
    return Object.freeze({ projectId: null, valid: false });
  }
}

export function portfolioRouteHref(locationLike = {}, {
  projectId = null,
  view = "overview",
} = {}) {
  if (typeof view !== "string" || !VIEW_FRAGMENT_PATTERN.test(view)) {
    throw new TypeError("The portfolio view fragment is invalid.");
  }
  const pathname = typeof locationLike.pathname === "string"
    && locationLike.pathname.startsWith("/")
    ? locationLike.pathname
    : "/";
  const current = new URLSearchParams(String(locationLike.search ?? ""));
  const params = new URLSearchParams();
  const modes = current.getAll("mode");
  if (modes.length === 1 && modes[0] === "portfolio") params.set("mode", "portfolio");
  const locales = current.getAll("locale");
  if (locales.length === 1 && LOCALE_QUERY_PATTERN.test(locales[0])) {
    params.set("locale", locales[0]);
  }
  if (projectId !== null && projectId !== "") {
    params.set("project", normalizePortfolioProjectId(projectId));
  }
  const query = params.toString();
  return `${pathname}${query ? `?${query}` : ""}#${view}`;
}

export function normalizePortfolioProjectId(value) {
  if (typeof value !== "string" || !PROJECT_ID_PATTERN.test(value)) {
    throw new TypeError("The portfolio project identifier is invalid.");
  }
  return value;
}

export function portfolioProjectHref(projectId) {
  const normalized = normalizePortfolioProjectId(projectId);
  return `/api/v1/portfolio/project?project=${encodeURIComponent(normalized)}`;
}

export function normalizePortfolioSummary(payload) {
  if (!isPlainObject(payload) || payload.schemaVersion !== PORTFOLIO_VIEW_SCHEMA) {
    throw new TypeError("The portfolio API returned an unsupported summary.");
  }
  if (
    !Array.isArray(payload.projects)
    || payload.projects.length < 1
    || payload.projects.length > MAX_PROJECTS
  ) {
    throw new TypeError("The portfolio summary must contain between 1 and 64 projects.");
  }

  const projects = [];
  const ids = new Set();
  for (const project of payload.projects) {
    const normalized = normalizeProject(project);
    if (ids.has(normalized.id)) {
      throw new TypeError("The portfolio summary contains a duplicate project identifier.");
    }
    ids.add(normalized.id);
    projects.push(normalized);
  }

  const availableProjectCount = projects.filter((project) => project.status === "available").length;
  const unavailableProjectCount = projects.length - availableProjectCount;
  const needsAttentionProjectCount = projects.filter(
    (project) => project.status === "available" && project.health === "needs_attention",
  ).length;
  const reviewProjectCount = projects.filter(
    (project) => project.status === "available" && project.health === "review",
  ).length;
  const expectedStatus = unavailableProjectCount > 0 || needsAttentionProjectCount > 0
    ? "degraded"
    : "ready";
  const expectedHealth = unavailableProjectCount > 0 || needsAttentionProjectCount > 0
    ? "needs_attention"
    : reviewProjectCount > 0
      ? "review"
      : "ready";
  if (
    payload.projectCount !== projects.length
    || payload.availableProjectCount !== availableProjectCount
    || payload.unavailableProjectCount !== unavailableProjectCount
    || payload.needsAttentionProjectCount !== needsAttentionProjectCount
    || payload.reviewProjectCount !== reviewProjectCount
    || payload.status !== expectedStatus
    || payload.health !== expectedHealth
  ) {
    throw new TypeError("The portfolio summary counts do not match its project list.");
  }

  return Object.freeze({
    schemaVersion: PORTFOLIO_VIEW_SCHEMA,
    generatedAt: normalizeTimestamp(payload.generatedAt),
    status: payload.status,
    health: payload.health,
    projectCount: projects.length,
    availableProjectCount,
    unavailableProjectCount,
    needsAttentionProjectCount,
    reviewProjectCount,
    projects: Object.freeze(projects),
  });
}

export class LatestRequestCoordinator {
  #controller = null;
  #generation = 0;

  begin() {
    this.#controller?.abort();
    const controller = new AbortController();
    const generation = ++this.#generation;
    this.#controller = controller;
    return Object.freeze({
      signal: controller.signal,
      isCurrent: () => (
        !controller.signal.aborted
        && generation === this.#generation
        && this.#controller === controller
      ),
    });
  }

  cancel() {
    this.#controller?.abort();
    this.#controller = null;
    this.#generation += 1;
  }
}

function normalizeProject(value) {
  if (!isPlainObject(value)) {
    throw new TypeError("The portfolio summary contains an invalid project.");
  }
  const id = normalizePortfolioProjectId(value.id);
  const status = value.status;
  if (!["available", "unavailable"].includes(status)) {
    throw new TypeError("The portfolio project status is invalid.");
  }
  const allowedHealth = status === "available"
    ? ["ready", "review", "needs_attention"]
    : ["unavailable"];
  if (!allowedHealth.includes(value.health)) {
    throw new TypeError("The portfolio project health is invalid.");
  }
  if (!isPlainObject(value.counts)) {
    throw new TypeError("The portfolio project counts are invalid.");
  }
  const counts = {};
  for (const key of COUNT_KEYS) counts[key] = normalizeCount(value.counts[key]);
  if (!Array.isArray(value.previews) || value.previews.length > MAX_PREVIEWS) {
    throw new TypeError("The portfolio project previews exceed the supported limit.");
  }
  if (status === "unavailable" && value.previews.length !== 0) {
    throw new TypeError("An unavailable portfolio project cannot include previews.");
  }
  const previews = value.previews.map(normalizePreview);
  return Object.freeze({
    id,
    status,
    health: value.health,
    name: boundedText(value.name, id, 256),
    detailHref: portfolioProjectHref(id),
    errorCode: status === "unavailable" && ERROR_CODE_PATTERN.test(value.errorCode ?? "")
      ? value.errorCode
      : null,
    message: status === "unavailable" ? boundedText(value.message, null, 256) : null,
    counts: Object.freeze(counts),
    previews: Object.freeze(previews),
  });
}

function normalizePreview(value) {
  if (!isPlainObject(value) || !["asked", "changed", "decided"].includes(value.kind)) {
    throw new TypeError("The portfolio summary contains an invalid project preview.");
  }
  return Object.freeze({
    kind: value.kind,
    title: boundedText(value.title, "Recorded evidence", 256),
    summary: boundedText(value.summary, "No summary was recorded.", 512),
    status: boundedText(value.status, "", 128) || null,
  });
}

function normalizeCount(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("The portfolio project counts must be non-negative integers.");
  }
  return value;
}

function normalizeTimestamp(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError("The portfolio summary timestamp is invalid.");
  }
  return value;
}

function boundedText(value, fallback, maximum) {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim();
  if (
    normalized === ""
    || normalized.length > maximum
    || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(normalized)
  ) {
    return fallback;
  }
  return normalized;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
