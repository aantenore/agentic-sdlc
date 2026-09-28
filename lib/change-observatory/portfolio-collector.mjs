export const PORTFOLIO_VIEW_SCHEMA_VERSION = "change-observatory:portfolio:v1";
export const MAX_PORTFOLIO_COLLECTION_CONCURRENCY = 4;
export const MAX_PORTFOLIO_PROJECT_PREVIEWS = 8;

import { Date } from "../runtime/host.mjs";
import {
  PORTFOLIO_AGGREGATES_SCHEMA_VERSION,
  PROJECT_PORTFOLIO_SUMMARY_SCHEMA_VERSION,
} from "./portfolio-project-summary.mjs";

const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const SAFE_ERROR_CODE_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/u;

export async function collectPortfolioSummary(projects, options = {}) {
  if (!Array.isArray(projects) || projects.length < 1) {
    throw new TypeError("Portfolio collection requires at least one project");
  }
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Portfolio collection options must be an object");
  }
  if (typeof options.loadProject !== "function") {
    throw new TypeError("Portfolio collection requires a project loader");
  }
  const concurrency = normalizePortfolioConcurrency(options.concurrency);
  const results = new Array(projects.length);
  let cursor = 0;

  async function worker() {
    while (cursor < projects.length) {
      const index = cursor;
      cursor += 1;
      const project = projects[index];
      validateProjectDescriptor(project);
      try {
        const model = await options.loadProject(project, index);
        results[index] = summarizeAvailableProject(project.id, model);
      } catch (error) {
        results[index] = summarizeUnavailableProject(project.id, error);
      }
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(concurrency, projects.length) },
    () => worker(),
  ));

  const unavailableProjectCount = results.filter((project) => project.status === "unavailable").length;
  const needsAttentionProjectCount = results.filter(
    (project) => project.status === "available" && project.health === "needs_attention",
  ).length;
  const reviewProjectCount = results.filter(
    (project) => project.status === "available" && project.health === "review",
  ).length;
  return Object.freeze({
    schemaVersion: PORTFOLIO_VIEW_SCHEMA_VERSION,
    generatedAt: normalizeInstant(options.clock),
    status: unavailableProjectCount === 0 && needsAttentionProjectCount === 0
      ? "ready"
      : "degraded",
    health: unavailableProjectCount > 0 || needsAttentionProjectCount > 0
      ? "needs_attention"
      : reviewProjectCount > 0
        ? "review"
        : "ready",
    projectCount: results.length,
    availableProjectCount: results.length - unavailableProjectCount,
    unavailableProjectCount,
    needsAttentionProjectCount,
    reviewProjectCount,
    aggregates: aggregatePortfolioResults(results),
    projects: Object.freeze(results),
  });
}

function summarizeAvailableProject(id, summary) {
  if (
    !isPlainObject(summary)
    || summary.schemaVersion !== PROJECT_PORTFOLIO_SUMMARY_SCHEMA_VERSION
    || !isPlainObject(summary.project)
    || !isPlainObject(summary.counts)
    || !isPlainObject(summary.aggregates)
    || summary.aggregates.schemaVersion !== PORTFOLIO_AGGREGATES_SCHEMA_VERSION
  ) {
    throw new TypeError("The project summary is not a supported Change Observatory model");
  }
  const previews = Array.isArray(summary.previews)
    ? summary.previews.slice(0, MAX_PORTFOLIO_PROJECT_PREVIEWS).map((item) => summarizePreview(item?.kind, item))
    : [];
  const health = ["ready", "review", "needs_attention"].includes(summary.health)
    ? summary.health
    : "needs_attention";
  return Object.freeze({
    id,
    status: "available",
    health,
    name: safeOptionalText(summary.project.name) ?? safeOptionalText(summary.project.id) ?? id,
    branch: safeOptionalText(summary.project.branch),
    detailHref: portfolioDetailHref(id),
    counts: Object.freeze({
      asked: safeCount(summary.counts.asked),
      changed: safeCount(summary.counts.changed),
      decided: safeCount(summary.counts.decided),
      iterations: safeCount(summary.counts.iterations),
      contracts: safeCount(summary.counts.contracts),
      decisions: safeCount(summary.counts.decisions),
      changes: safeCount(summary.counts.changes),
      verification: safeCount(summary.counts.verification),
      diagnostics: safeCount(summary.counts.diagnostics),
    }),
    aggregates: normalizeProjectAggregates(summary.aggregates),
    previews: Object.freeze(previews),
  });
}

function summarizePreview(kind, item) {
  const candidate = isPlainObject(item) ? item : {};
  return Object.freeze({
    kind,
    id: safeOptionalText(candidate.id),
    type: safeOptionalText(candidate.type),
    title: safeOptionalText(candidate.humanTitle ?? candidate.title),
    summary: safeOptionalText(candidate.humanSummary ?? candidate.summary),
    status: safeOptionalText(candidate.humanStatus ?? candidate.status),
    phase: safeOptionalText(candidate.phase),
    timestamp: safeOptionalText(candidate.timestamp),
    provenance: safeOptionalText(candidate.provenance),
  });
}

function summarizeUnavailableProject(id, error) {
  const errorCode = safeErrorCode(error);
  return Object.freeze({
    id,
    status: "unavailable",
    health: "unavailable",
    name: id,
    detailHref: portfolioDetailHref(id),
    errorCode,
    message: humanProjectError(errorCode),
    counts: Object.freeze({
      asked: 0,
      changed: 0,
      decided: 0,
      iterations: 0,
      contracts: 0,
      decisions: 0,
      changes: 0,
      verification: 0,
      diagnostics: 0,
    }),
    aggregates: emptyProjectAggregates(),
    previews: Object.freeze([]),
  });
}

function normalizeProjectAggregates(aggregates) {
  return Object.freeze({
    schemaVersion: PORTFOLIO_AGGREGATES_SCHEMA_VERSION,
    activeWorkflows: normalizeAggregateBucket(aggregates.activeWorkflows),
    blockers: normalizeAggregateBucket(aggregates.blockers),
    risks: normalizeAggregateBucket(aggregates.risks),
    budgets: normalizeAggregateBucket(aggregates.budgets),
    dependencies: normalizeAggregateBucket(aggregates.dependencies),
    releases: normalizeAggregateBucket(aggregates.releases),
  });
}

function normalizeAggregateBucket(bucket) {
  const source = isPlainObject(bucket) ? bucket : {};
  const items = Array.isArray(source.items)
    ? source.items.slice(0, MAX_PORTFOLIO_PROJECT_PREVIEWS).map(compactAggregateItem)
    : [];
  return Object.freeze({
    count: safeCount(source.count),
    items: Object.freeze(items),
    truncated: source.truncated === true || safeCount(source.count) > items.length,
  });
}

function compactAggregateItem(item) {
  const source = isPlainObject(item) ? item : {};
  return Object.freeze({
    id: safeOptionalText(source.id),
    status: safeOptionalText(source.status),
    phase: safeOptionalText(source.phase),
    severity: safeOptionalText(source.severity),
    health: safeOptionalText(source.health),
  });
}

function emptyProjectAggregates() {
  const empty = () => Object.freeze({ count: 0, items: Object.freeze([]), truncated: false });
  return Object.freeze({
    schemaVersion: PORTFOLIO_AGGREGATES_SCHEMA_VERSION,
    activeWorkflows: empty(),
    blockers: empty(),
    risks: empty(),
    budgets: empty(),
    dependencies: empty(),
    releases: empty(),
  });
}

function aggregatePortfolioResults(projects) {
  const categories = ["activeWorkflows", "blockers", "risks", "budgets", "dependencies", "releases"];
  const result = { schemaVersion: PORTFOLIO_AGGREGATES_SCHEMA_VERSION };
  for (const category of categories) {
    let count = 0;
    let affectedProjects = 0;
    let truncated = false;
    for (const project of projects) {
      const bucket = project.aggregates?.[category];
      if (!bucket) continue;
      count += safeCount(bucket.count);
      if (safeCount(bucket.count) > 0) affectedProjects += 1;
      if (bucket.truncated === true) truncated = true;
    }
    result[category] = Object.freeze({ count, affectedProjects, truncated });
  }
  return Object.freeze(result);
}

function humanProjectError(code) {
  if (code === "knowledge_base_not_found") {
    return "This project has no Agentic SDLC records to show yet.";
  }
  if (code.startsWith("observability_configuration_")) {
    return "This project cannot be shown until its Observatory privacy settings are corrected and the view is restarted.";
  }
  if (
    code === "project_boundary_changed"
    || code === "portfolio_project_root_changed"
    || code === "canonical_revision_changed"
  ) {
    return "This project's records changed while they were being read. Reload the portfolio to try again.";
  }
  if (code === "knowledge_base_symlink" || code === "symlink_forbidden") {
    return "This project's records are linked through an unsupported filesystem alias and cannot be read safely.";
  }
  if (code.endsWith("_too_large") || code === "collection_limit_exceeded") {
    return "This project contains more recorded data than the configured safe viewing limit.";
  }
  return "This project could not be read safely. Its other portfolio projects are still available.";
}

function portfolioDetailHref(id) {
  return `/api/v1/portfolio/project?project=${encodeURIComponent(id)}`;
}

export function normalizePortfolioConcurrency(value = MAX_PORTFOLIO_COLLECTION_CONCURRENCY) {
  if (
    !Number.isSafeInteger(value)
    || value < 1
    || value > MAX_PORTFOLIO_COLLECTION_CONCURRENCY
  ) {
    throw new TypeError(
      `Portfolio collection concurrency must be between 1 and ${MAX_PORTFOLIO_COLLECTION_CONCURRENCY}`,
    );
  }
  return value;
}

function validateProjectDescriptor(project) {
  if (
    !isPlainObject(project)
    || typeof project.id !== "string"
    || !PROJECT_ID_PATTERN.test(project.id)
  ) {
    throw new TypeError("Portfolio projects must have canonical identifiers");
  }
}

function safeErrorCode(error) {
  const code = String(error?.code || "project_unavailable").toLowerCase();
  return SAFE_ERROR_CODE_PATTERN.test(code) ? code : "project_unavailable";
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function safeOptionalText(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized === "" ? null : normalized;
}

function normalizeInstant(clock) {
  const value = typeof clock === "function" ? clock() : clock ?? new Date();
  const instant = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(instant.getTime())) {
    throw new TypeError("Portfolio clock returned an invalid date");
  }
  return instant.toISOString();
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
