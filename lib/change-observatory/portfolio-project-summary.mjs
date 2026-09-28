import path from "node:path";

import { Date, fsPromises as fs } from "../runtime/host.mjs";
import { readResolvedFileBounded } from "./bounded-file-reader.mjs";
import { normalizeObservatoryLimits } from "./constants.mjs";
import {
  ObservatoryPathError,
  assertDirectoryIdentity,
  captureDirectoryIdentity,
  resolveExistingFileWithin,
  resolveKnowledgeBaseBoundary,
} from "./path-safety.mjs";
import {
  DEFAULT_OPERATIONAL_REDACTION_POLICY,
  redactText,
} from "../observability/redaction.mjs";

export const PROJECT_PORTFOLIO_SUMMARY_SCHEMA_VERSION =
  "change-observatory:portfolio-project-summary:v1";
export const PORTFOLIO_AGGREGATES_SCHEMA_VERSION =
  "change-observatory:portfolio-aggregates:v1";
export const MAX_PROJECT_SUMMARY_FILES = 256;
export const MAX_PROJECT_SUMMARY_BYTES = 2 * 1024 * 1024;
export const MAX_PROJECT_SUMMARY_FILE_BYTES = 64 * 1024;
export const MAX_PROJECT_SUMMARY_ITEMS = 8;
export const MAX_PROJECT_SUMMARY_DOCUMENTS = 1_024;

const SUMMARY_TARGETS = Object.freeze([
  Object.freeze({ relative: "requirements", category: "requirements" }),
  Object.freeze({ relative: "stories", category: "stories" }),
  Object.freeze({ relative: "workflows", category: "workflows" }),
  Object.freeze({ relative: "risks", category: "risks" }),
  Object.freeze({ relative: "decisions", category: "decisions" }),
  Object.freeze({ relative: "assumptions", category: "assumptions" }),
  Object.freeze({ relative: "budgets", category: "budgets" }),
  Object.freeze({ relative: "autonomy/deliveries", category: "deliveries" }),
  Object.freeze({ relative: "dependencies", category: "dependencies" }),
  Object.freeze({ relative: "releases", category: "releases" }),
  Object.freeze({ relative: "release-manifests", category: "releases" }),
  Object.freeze({ relative: "reports", category: "reports" }),
]);
const SUPPORTED_SUMMARY_EXTENSIONS = new Set([".json", ".jsonl"]);
const TERMINAL_WORKFLOW_STATES = new Set([
  "cancelled", "closed", "completed", "consumed", "done", "released", "superseded",
]);
const BLOCKING_STATES = new Set([
  "blocked", "error", "failed", "needs_attention", "needs_user_input", "rejected",
]);
const RESOLVED_RISK_STATES = new Set([
  "accepted", "closed", "mitigated", "resolved",
]);
const FAILED_RELEASE_STATES = new Set([
  "blocked", "failed", "rejected", "rolled_back",
]);
const EXCEEDED_BUDGET_STATES = new Set([
  "exceeded", "exhausted", "over_budget",
]);

export async function buildProjectPortfolioSummary(projectRoot, options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Project portfolio summary options must be an object");
  }
  const limits = normalizeObservatoryLimits(options.limits);
  const redactionPolicy = options.redactionPolicy ?? DEFAULT_OPERATIONAL_REDACTION_POLICY;
  const boundary = await resolveKnowledgeBaseBoundary(projectRoot);
  const projectIdentity = await captureDirectoryIdentity(boundary.projectRoot, {
    code: "project_boundary_changed",
    label: "project root",
  });
  const knowledgeBaseIdentity = await captureDirectoryIdentity(boundary.knowledgeBaseRoot, {
    code: "knowledge_base_boundary_changed",
    label: "project knowledge base",
  });
  const state = {
    bytes: 0,
    diagnostics: [],
    documents: [],
    entries: 0,
    files: 0,
    limits,
    redactionPolicy,
    stopped: false,
    truncated: false,
  };

  await readProjectRecord(boundary.projectRoot, state);
  for (const target of SUMMARY_TARGETS) {
    if (state.stopped) break;
    await scanTarget(boundary.projectRoot, boundary.knowledgeBaseRoot, target, state);
  }
  await assertDirectoryIdentity(knowledgeBaseIdentity);
  await assertDirectoryIdentity(projectIdentity);

  const built = buildSummary(state, options.clock);
  // Drop parsed canonical documents before returning the compact immutable
  // projection. The caller never retains source-shaped objects in its LRU.
  state.documents.length = 0;
  state.diagnostics.length = 0;
  return built;
}

async function readProjectRecord(projectRoot, state) {
  try {
    const document = await readSummaryFile(projectRoot, ".sdlc/project.json", state);
    if (document !== null) {
      appendDocument(state, Object.freeze({
        category: "project",
        relativePath: ".sdlc/project.json",
        data: document,
      }));
    }
  } catch (error) {
    if (error?.code === "source_not_found") return;
    throw error;
  }
}

async function scanTarget(projectRoot, knowledgeBaseRoot, target, state) {
  const absolute = path.join(knowledgeBaseRoot, ...target.relative.split("/"));
  let stats;
  try {
    stats = await fs.lstat(absolute);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return;
    throw new ObservatoryPathError(
      "project_summary_unavailable",
      "A project summary directory is not safely readable",
      403,
    );
  }
  if (stats.isSymbolicLink()) {
    addDiagnostic(state, "summary_symlink_ignored", "error");
    return;
  }
  if (!stats.isDirectory()) {
    addDiagnostic(state, "summary_target_not_directory", "warning");
    return;
  }
  await walkTargetDirectory(projectRoot, absolute, `.sdlc/${target.relative}`, target.category, 0, state);
}

async function walkTargetDirectory(projectRoot, absolute, relative, category, depth, state) {
  if (state.stopped) return;
  if (depth > Math.min(state.limits.maxDepth, 6)) {
    markTruncated(state, "summary_depth_limit");
    return;
  }
  const entries = [];
  let directory;
  try {
    directory = await fs.opendir(absolute);
    for await (const entry of directory) {
      state.entries += 1;
      if (state.entries > MAX_PROJECT_SUMMARY_FILES * 8) {
        markTruncated(state, "summary_entry_limit");
        return;
      }
      entries.push(entry);
    }
  } catch (error) {
    if (error instanceof ObservatoryPathError) throw error;
    throw new ObservatoryPathError(
      "project_summary_unavailable",
      "A project summary directory is not safely readable",
      403,
    );
  } finally {
    await directory?.close().catch(() => {});
  }

  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    if (state.stopped) return;
    const childAbsolute = path.join(absolute, entry.name);
    const childRelative = `${relative}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      addDiagnostic(state, "summary_symlink_ignored", "error");
      continue;
    }
    if (entry.isDirectory()) {
      await walkTargetDirectory(
        projectRoot,
        childAbsolute,
        childRelative,
        category,
        depth + 1,
        state,
      );
      continue;
    }
    if (!entry.isFile() || !SUPPORTED_SUMMARY_EXTENSIONS.has(path.extname(entry.name))) continue;
    if (state.files >= Math.min(state.limits.maxFiles, MAX_PROJECT_SUMMARY_FILES)) {
      markTruncated(state, "summary_file_limit");
      return;
    }
    const parsed = await readSummaryFile(projectRoot, childRelative, state);
    if (parsed === null) continue;
    for (const data of parsedDocuments(parsed, childRelative, state)) {
      if (!appendDocument(state, Object.freeze({ category, relativePath: childRelative, data }))) {
        return;
      }
    }
  }
}

async function readSummaryFile(projectRoot, relativePath, state) {
  const resolved = await resolveExistingFileWithin(projectRoot, relativePath);
  const size = Number(resolved.identity.size);
  if (!Number.isSafeInteger(size) || size > MAX_PROJECT_SUMMARY_FILE_BYTES) {
    markTruncated(state, "summary_file_too_large", false);
    return null;
  }
  if (state.bytes + size > MAX_PROJECT_SUMMARY_BYTES) {
    markTruncated(state, "summary_byte_limit");
    return null;
  }
  const bytes = await readResolvedFileBounded(resolved, {
    maxBytes: Math.min(state.limits.maxFileBytes, MAX_PROJECT_SUMMARY_FILE_BYTES),
    boundaryCode: "project_summary_file_changed",
    tooLargeCode: "project_summary_file_too_large",
    tooLargeMessage: "A project summary record exceeds the compact read limit",
  });
  state.files += 1;
  state.bytes += bytes.byteLength;
  const text = decodeUtf8(bytes, state);
  if (text === null) return null;
  if (path.extname(relativePath) === ".jsonl") return parseJsonLines(text, state);
  try {
    return JSON.parse(text);
  } catch {
    addDiagnostic(state, "summary_json_malformed", "error");
    return null;
  }
}

function decodeUtf8(bytes, state) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    addDiagnostic(state, "summary_encoding_invalid", "error");
    return null;
  }
}

function parseJsonLines(text, state) {
  const documents = [];
  const lines = text.split(/\r?\n/u);
  const lineLimit = Math.min(state.limits.maxJsonLines, 256);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === "") continue;
    if (documents.length >= lineLimit) {
      markTruncated(state, "summary_jsonl_limit", false);
      break;
    }
    try {
      documents.push(JSON.parse(line));
    } catch {
      addDiagnostic(state, "summary_jsonl_malformed", "error");
    }
  }
  return documents;
}

function parsedDocuments(value, relativePath, state) {
  const values = path.extname(relativePath) === ".jsonl" ? value : [value];
  const results = [];
  for (const document of values) {
    if (!isPlainObject(document)) {
      addDiagnostic(state, "summary_record_malformed", "warning");
      continue;
    }
    results.push(document);
    for (const key of ["items", "edges", "risks", "budgets", "dependencies", "releases", "instances"]) {
      if (!Array.isArray(document[key])) continue;
      for (const child of document[key].slice(0, MAX_PROJECT_SUMMARY_ITEMS * 4)) {
        if (isPlainObject(child)) results.push(child);
      }
      if (document[key].length > MAX_PROJECT_SUMMARY_ITEMS * 4) {
        markTruncated(state, "summary_embedded_collection_limit", false);
      }
    }
  }
  return results;
}

function buildSummary(state, clock) {
  const projectRecord = state.documents.find((record) => record.category === "project")?.data ?? {};
  const workflows = new Map();
  const terminalWorkflows = new Set();
  const blockers = new Map();
  const risks = new Map();
  const budgets = new Map();
  const dependencies = new Map();
  const releases = new Map();
  const previews = [];
  let requirementCount = 0;
  let decisionCount = 0;

  for (const [recordIndex, record] of state.documents.entries()) {
    const data = record.data;
    if (record.category === "project") continue;
    const id = safeEntityId(data, recordIndex, state.redactionPolicy);
    const status = normalizedState(data.status ?? data.outcome ?? data.state, state.redactionPolicy);
    const type = normalizedState(data.type ?? data.kind, state.redactionPolicy);
    const phase = normalizedState(data.phase ?? data.step, state.redactionPolicy);

    if (record.category === "requirements") {
      requirementCount += 1;
      addPreview(previews, "asked", data, state.redactionPolicy);
    }
    if (record.category === "decisions" || record.category === "assumptions") {
      decisionCount += 1;
      addPreview(previews, "decided", data, state.redactionPolicy);
    }
    const workflowCandidate = (
      record.category === "stories"
      && (
        data.story_id !== undefined
        || /\/(?:claim|story|task-start)\.json$/u.test(record.relativePath)
        || record.relativePath.includes("/steps/")
      )
    ) || (
      record.category === "workflows"
      && (
        data.instance_id !== undefined
        || data.workflow_id !== undefined
        || record.relativePath.includes("/instances/")
      )
    );
    if (workflowCandidate) {
      const workflowId = safeText(data.story_id ?? data.workflow_id ?? data.instance_id ?? data.id, state.redactionPolicy)
        ?? id;
      if (TERMINAL_WORKFLOW_STATES.has(status)) {
        terminalWorkflows.add(workflowId);
        workflows.delete(workflowId);
      } else if (!terminalWorkflows.has(workflowId)) {
        workflows.set(workflowId, compactItem(workflowId, status || "active", { phase }));
      }
      if (/story\.json$/u.test(record.relativePath)) {
        addPreview(previews, "changed", data, state.redactionPolicy);
      }
    }

    if (BLOCKING_STATES.has(status) || data.blocked === true) {
      blockers.set(`${id}:${status || "blocked"}`, compactItem(id, status || "blocked", { phase }));
    }

    if (
      record.category === "risks"
      || type === "risk"
      || String(data.schema_version ?? "").includes("risk")
    ) {
      if (!RESOLVED_RISK_STATES.has(status)) {
        risks.set(id, compactItem(id, status || "open", {
          severity: normalizedState(data.severity ?? data.impact, state.redactionPolicy),
        }));
      }
    }

    if (record.category === "budgets" || isPlainObject(data.budget)) {
      const budgetData = isPlainObject(data.budget) ? data.budget : data;
      const budgetState = budgetHealth(budgetData, status);
      budgets.set(id, compactItem(id, status || "recorded", { health: budgetState }));
      if (budgetState === "exceeded") {
        blockers.set(`${id}:budget`, compactItem(id, "budget_exceeded"));
      }
    }

    if (
      record.category === "dependencies"
      && (!Array.isArray(data.edges) || data.from !== undefined || data.to !== undefined)
    ) {
      const dependencyState = data.blocks === false
        ? "non_blocking"
        : status || normalizedState(data.required_state, state.redactionPolicy) || "recorded";
      dependencies.set(id, compactItem(id, dependencyState, {
        health: BLOCKING_STATES.has(dependencyState) ? "blocked" : "ready",
      }));
    }

    if (record.category === "releases" || phase === "release" || type === "release") {
      const releaseHealth = FAILED_RELEASE_STATES.has(status) ? "failed" : "ready";
      releases.set(id, compactItem(id, status || "recorded", { health: releaseHealth }));
      if (releaseHealth === "failed") {
        blockers.set(`${id}:release`, compactItem(id, "release_failed"));
      }
    }
  }

  const errorCount = state.diagnostics.filter((item) => item.severity === "error").length;
  const warningCount = state.diagnostics.length - errorCount;
  const hasExceededBudget = [...budgets.values()].some((item) => item.health === "exceeded");
  const hasFailedRelease = [...releases.values()].some((item) => item.health === "failed");
  const health = blockers.size > 0 || errorCount > 0 || hasExceededBudget || hasFailedRelease
    ? "needs_attention"
    : risks.size > 0 || warningCount > 0 || state.truncated
      ? "review"
      : "ready";
  const aggregateValues = {
    activeWorkflows: aggregateBucket(workflows, state.truncated),
    blockers: aggregateBucket(blockers, state.truncated),
    risks: aggregateBucket(risks, state.truncated),
    budgets: aggregateBucket(budgets, state.truncated),
    dependencies: aggregateBucket(dependencies, state.truncated),
    releases: aggregateBucket(releases, state.truncated),
  };

  return deepFreeze({
    schemaVersion: PROJECT_PORTFOLIO_SUMMARY_SCHEMA_VERSION,
    generatedAt: normalizeInstant(clock),
    project: {
      id: safeText(projectRecord.project_id ?? projectRecord.id, state.redactionPolicy),
      name: safeText(projectRecord.project_name ?? projectRecord.name, state.redactionPolicy),
      branch: safeText(projectRecord.branch ?? projectRecord.default_branch, state.redactionPolicy),
    },
    health,
    counts: {
      asked: requirementCount,
      changed: 0,
      decided: decisionCount + risks.size,
      iterations: workflows.size,
      contracts: 0,
      decisions: decisionCount,
      changes: 0,
      verification: 0,
      diagnostics: state.diagnostics.length,
    },
    previews: previews.slice(0, MAX_PROJECT_SUMMARY_ITEMS),
    aggregates: {
      schemaVersion: PORTFOLIO_AGGREGATES_SCHEMA_VERSION,
      ...aggregateValues,
    },
    scan: {
      filesRead: state.files,
      bytesRead: state.bytes,
      truncated: state.truncated,
      errorCount,
      warningCount,
    },
  });
}

function aggregateBucket(values, truncated) {
  const items = [...values.values()];
  return {
    count: items.length,
    items: items.slice(0, MAX_PROJECT_SUMMARY_ITEMS),
    truncated: truncated || items.length > MAX_PROJECT_SUMMARY_ITEMS,
  };
}

function compactItem(id, status, optional = {}) {
  return Object.fromEntries(Object.entries({ id, status, ...optional }).filter(([, value]) => value));
}

function budgetHealth(data, status) {
  if (EXCEEDED_BUDGET_STATES.has(status)) return "exceeded";
  for (const [usedKey, limitKey] of [
    ["used", "limit"],
    ["consumed", "maximum"],
    ["spent", "budget"],
  ]) {
    const used = Number(data?.[usedKey]);
    const limit = Number(data?.[limitKey]);
    if (Number.isFinite(used) && Number.isFinite(limit) && used > limit) return "exceeded";
  }
  return "within_limit";
}

function addPreview(previews, kind, data, redactionPolicy) {
  if (previews.length >= MAX_PROJECT_SUMMARY_ITEMS) return;
  previews.push({
    kind,
    id: safeText(data.id ?? data.story_id ?? data.requirement_id, redactionPolicy),
    type: safeText(data.type ?? data.kind, redactionPolicy),
    title: safeText(data.title ?? data.name, redactionPolicy),
    summary: safeText(data.summary, redactionPolicy),
    status: safeText(data.status ?? data.state, redactionPolicy),
    phase: safeText(data.phase ?? data.step, redactionPolicy),
    timestamp: safeText(data.updated_at ?? data.created_at ?? data.timestamp, redactionPolicy),
    provenance: "recorded",
  });
}

function safeEntityId(data, recordIndex, redactionPolicy) {
  return safeText(
    data.id ?? data.story_id ?? data.requirement_id ?? data.workflow_id ?? data.release_id,
    redactionPolicy,
  ) ?? opaqueRecordId(recordIndex);
}

function opaqueRecordId(recordIndex) {
  return `record-${String(recordIndex).padStart(4, "0")}`;
}

function safeText(value, redactionPolicy) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (normalized === "") return null;
  return redactText(normalized.slice(0, 512), redactionPolicy).slice(0, 512);
}

function normalizedState(value, redactionPolicy) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (trimmed === "" || redactText(trimmed, redactionPolicy) !== trimmed) return "";
  const normalized = trimmed.toLowerCase().replace(/[ -]+/gu, "_");
  return /^[a-z][a-z0-9_]{0,63}$/u.test(normalized) ? normalized : "";
}

function addDiagnostic(state, code, severity) {
  if (state.diagnostics.length >= 32) {
    state.truncated = true;
    return;
  }
  state.diagnostics.push(Object.freeze({ code, severity }));
}

function appendDocument(state, record) {
  const limit = Math.min(state.limits.maxRecords, MAX_PROJECT_SUMMARY_DOCUMENTS);
  if (state.documents.length >= limit) {
    markTruncated(state, "summary_record_limit");
    return false;
  }
  state.documents.push(record);
  return true;
}

function markTruncated(state, code, stop = true) {
  state.truncated = true;
  if (stop) state.stopped = true;
  addDiagnostic(state, code, "warning");
}

function normalizeInstant(clock) {
  const value = typeof clock === "function" ? clock() : clock ?? new Date();
  const instant = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(instant.getTime())) throw new TypeError("Portfolio clock returned an invalid date");
  return instant.toISOString();
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
