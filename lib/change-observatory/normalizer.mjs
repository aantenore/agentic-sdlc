import path from "node:path";

import { Date, fsPromises as fs } from "../runtime/host.mjs";
import {
  DEFAULT_OPERATIONAL_REDACTION_POLICY,
  REDACTION_LIMIT_PLACEHOLDER,
  createRedactionPolicy,
  redactText,
} from "../observability/redaction.mjs";
import { standingDecisionAssuranceErrors } from "../standing-approvals.mjs";
import { readResolvedFileBounded } from "./bounded-file-reader.mjs";
import { readObservatoryTrustedHostKeys } from "./configuration.mjs";

import {
  CANONICAL_SOURCE_EXTENSIONS,
  OBSERVATORY_VIEW_SCHEMA_VERSION,
  SDLC_PHASES,
  normalizeObservatoryLimits,
  orderKnowledgeBaseEntries,
} from "./constants.mjs";
import {
  ObservatoryPathError,
  isContainedPath,
  resolveExistingFileWithin,
  resolveKnowledgeBaseBoundary,
  resolveProjectBoundary,
} from "./path-safety.mjs";
import {
  INTENTABI_REDACTED_OBSERVATION_PATH,
  isCanonicalIntentAbiObservationPath,
  isIntentAbiCodexEnvelopeCandidate,
  isIntentAbiObservationPath,
  projectIntentAbiCodexEnvelope,
} from "./intentabi-adapter.mjs";
import { createRecordIndex, recordIndexEntry } from "./record-index.mjs";
import { lifecycleEventsAfterCertification } from "../engine/certification-freshness.mjs";
import {
  deriveDeliveryLeadTime,
  summarizeDeliveryUsage,
  sumAmounts,
} from "../delivery-metrics.mjs";
import { rankSummaryItems } from "./summary-ranking.mjs";

const SUPPORTED_EXTENSIONS = new Set(CANONICAL_SOURCE_EXTENSIONS);
const DERIVED_DIRECTORIES = new Set(["cache", "indexes"]);
// Plugin settings at the top of .sdlc that are not project evidence. The
// messaging settings are per-computer configuration, not project evidence.
const SETTINGS_FILES = new Set(["messaging.json"]);
const PRIVATE_REASONING_KEYS = new Set([
  "chainofthought",
  "internalreasoning",
  "privatereasoning",
  "reasoningtrace",
]);
const PRIVATE_REASONING_FLAG_KEYS = new Set(["chainofthoughtincluded"]);
const PRIVATE_REASONING_SCAN_MAX_DEPTH = 512;
const PRIVATE_REASONING_SCAN_MAX_NODES = 25_000;
const DOSSIER_SCHEMA_VERSION = "change-observatory:iteration-dossier:v1";
const DOSSIER_LANES = Object.freeze(["asked", "decided", "contract", "done", "verified"]);
const NO_INDEX_ENTRIES = Object.freeze([]);
const DIRECT_INDEX_PRIORITY = 1;
const PRIVATE_REASONING_ABSENT = Object.freeze({ present: false, traversalLimited: false });
const PRIVATE_REASONING_PRESENT = Object.freeze({ present: true, traversalLimited: false });
const PRIVATE_REASONING_LIMITED = Object.freeze({ present: true, traversalLimited: true });
const privateReasoningInspectionCache = new WeakMap();
const ITERATION_CANONICAL_STORY_ID = Symbol("iterationCanonicalStoryId");

class DiagnosticCollector {
  constructor(limit) {
    this.limit = limit;
    this.items = [];
    this.overflow = 0;
    this.byFingerprint = new Map();
  }

  add({ code, severity = "warning", message, provenance = "inferred", sourceRefs = [] }) {
    const normalizedRefs = sourceRefs.slice(0, 12).map(normalizeSourceRef);
    const fingerprint = JSON.stringify([code, severity, message, provenance]);
    const existing = this.byFingerprint.get(fingerprint);
    if (existing) {
      existing.occurrences += 1;
      const seen = new Set(existing.sourceRefs.map(sourceRefFingerprint));
      for (const ref of normalizedRefs) {
        const key = sourceRefFingerprint(ref);
        if (!seen.has(key) && existing.sourceRefs.length < 12) {
          existing.sourceRefs.push(ref);
          seen.add(key);
        }
      }
      return;
    }
    const diagnostic = {
      code,
      severity,
      message,
      provenance,
      occurrences: 1,
      sourceRefs: normalizedRefs,
    };
    if (this.items.length < this.limit) {
      this.items.push(diagnostic);
      this.byFingerprint.set(fingerprint, diagnostic);
    } else {
      this.overflow += 1;
    }
  }

  finish() {
    if (this.overflow > 0 && this.limit > 0) {
      const sentinel = {
        code: "diagnostics_truncated",
        severity: "warning",
        message: `${this.overflow} additional diagnostics were omitted by the configured limit.`,
        provenance: "inferred",
        occurrences: this.overflow,
        sourceRefs: [],
      };
      if (this.items.length < this.limit) {
        this.items.push(sentinel);
      } else {
        this.items[this.items.length - 1] = sentinel;
      }
    }
    return this.items;
  }
}

function sourceRefFingerprint(ref) {
  return `${ref.path}\u0000${ref.line ?? ""}\u0000${ref.pointer ?? ""}`;
}

export async function buildObservatoryViewModel(projectRoot, options = {}) {
  const limits = normalizeObservatoryLimits(options.limits);
  const redactionPolicy = resolveRedactionPolicy(options);
  const clock = typeof options.clock === "function" ? options.clock : () => new Date();
  const generatedAt = normalizeGeneratedAt(clock());
  const diagnostics = new DiagnosticCollector(limits.maxDiagnostics);
  let scan = await scanKnowledgeBase(projectRoot, { limits, diagnostics });
  let records = scan.records;
  let recordIndex = createObservatoryRecordIndex(records, limits, diagnostics);
  reportPrivateReasoningDiagnostics(records, diagnostics);

  let projectRecord = records.find((record) => record.path === ".sdlc/project.json");
  const project = normalizeProject(projectRecord, scan.projectRoot, diagnostics, limits);

  const askedSummary = createFirstUniqueItemCollector(limits.maxCollectionItems);
  for (const record of records) {
    if (record.kind !== "requirement" || !isRecordObject(record)) continue;
    askedSummary.add(itemFromRecord(record, { limits, diagnostics }));
  }
  for (const record of records) {
    if (record.kind !== "trace" || !isRecordObject(record)) continue;
    for (const item of requestItemsFromTrace(record, limits)) askedSummary.add(item);
  }

  const contractItems = createBoundedSortedItemCollector(limits.maxCollectionItems);
  for (const record of records) {
    if (record.kind !== "contract" || !isRecordObject(record)) continue;
    contractItems.add(itemFromRecord(record, { limits, diagnostics }));
  }

  const decisionItems = createBoundedSortedItemCollector(limits.maxCollectionItems);
  const decidedSummary = createBoundedRankedItemCollector(
    limits.maxCollectionItems,
    "decided",
    options.summaryRanking?.decided,
  );
  const addDecisionItem = (item) => {
    decisionItems.add(item);
    decidedSummary.add(item);
  };
  for (const record of records) {
    if (!["decision", "assumption", "risk"].includes(record.kind) || !isRecordObject(record)) {
      continue;
    }
    addDecisionItem(itemFromRecord(record, { limits, diagnostics }));
  }
  for (const record of records) {
    if (record.kind !== "trace" || !isDecisionTrace(record.data)) continue;
    addDecisionItem(itemFromRecord(record, { limits, diagnostics }));
  }
  const deliveryProjections = deliveryMetricProjections(records);
  for (const record of records) {
    if (![
      "requirement-execution-profile",
      "delivery-execution-profile",
      "autonomy-decision",
    ].includes(record.kind) || !isRecordObject(record)) continue;
    const item = itemFromRecord(record, { limits, diagnostics });
    const metrics = record.kind === "delivery-execution-profile"
      ? deliveryProjections.get(String(record.data.id ?? ""))
      : null;
    if (metrics) item.deliveryMetrics = metrics;
    addDecisionItem(item);
  }
  const standingRecords = records.filter((record) => isRecordObject(record)
    && ["standing-approval", "standing-approval-decision", "standing-approval-use"].includes(record.kind));
  const trustedHostKeys = standingRecords.length > 0 ? await readObservatoryTrustedHostKeys(projectRoot) : [];
  const standingProjections = standingApprovalProjections(records, trustedHostKeys, Date.parse(generatedAt));
  for (const record of standingRecords) {
    const overrides = standingApprovalItemOverrides(record, standingProjections, Date.parse(generatedAt), deliveryProjections);
    const { standingBudget, ...itemOverrides } = overrides;
    const item = itemFromRecord(record, { limits, diagnostics, overrides: itemOverrides });
    if (standingBudget) item.standingBudget = standingBudget;
    addDecisionItem(item);
  }
  for (const record of records) {
    if (!isRecordObject(record) || !APPROVAL_DELEGATION_KINDS.has(record.kind)) continue;
    addDecisionItem(itemFromRecord(record, { limits, diagnostics, overrides: approvalDelegationItemOverrides(record, Date.parse(generatedAt)) }));
  }
  for (const record of records) {
    for (const item of approvalItemsFromRecord(record, limits, diagnostics)) addDecisionItem(item);
  }

  const changeItems = createBoundedSortedItemCollector(limits.maxCollectionItems);
  const changedSummary = createBoundedRankedItemCollector(
    limits.maxCollectionItems,
    "changed",
    options.summaryRanking?.changed,
  );
  for (const record of records) {
    if (record.kind !== "trace" || !["implementation", "sync"].includes(record.data?.type)) continue;
    const item = itemFromRecord(record, { limits, diagnostics });
    changeItems.add(item);
    changedSummary.add(item);
  }

  const verificationItems = createBoundedSortedItemCollector(limits.maxCollectionItems);
  for (const record of records) {
    if (!isVerificationRecord(record) || isTestTraceWithRunRecord(record, recordIndex)) continue;
    verificationItems.add(itemFromRecord(record, { limits, diagnostics }));
  }

  const semanticObservations = normalizeSemanticObservations(records, limits, diagnostics);
  const semanticObservationCount = semanticObservations.length;
  const summaryViews = {
    asked: askedSummary.finish(),
    changed: changedSummary.finish(),
    decided: decidedSummary.finish(),
  };
  const collectionViews = {
    contracts: contractItems.finish(),
    decisions: decisionItems.finish(),
    changes: changeItems.finish(),
    verification: verificationItems.finish(),
    semanticObservations: boundCollectionInPlace(
      sortItemsInPlace(semanticObservations),
      limits.maxCollectionItems,
    ),
  };
  const collectionCounts = {
    contracts: collectionViews.contracts.total,
    decisions: collectionViews.decisions.total,
    changes: collectionViews.changes.total,
    verification: collectionViews.verification.total,
    semanticObservations: semanticObservationCount,
  };
  const baseIterations = normalizeIterations(recordIndex, limits, diagnostics, Date.parse(generatedAt));
  const dossierView = normalizeIterationDossiers(
    records,
    recordIndex,
    baseIterations,
    limits,
    diagnostics,
  );
  const iterations = baseIterations.map((iteration) => {
    const normalizedIteration = { ...iteration };
    // The top-level collection is the single wire representation. Keep the
    // direct reference for in-process consumers without serializing every
    // dossier a second time inside its iteration.
    Object.defineProperty(normalizedIteration, "dossier", {
      configurable: true,
      enumerable: false,
      value: dossierView.byIteration.get(iteration) ?? null,
      writable: true,
    });
    return normalizedIteration;
  });
  const publicRecordsView = collectBoundedPublicRecords(records, limits);
  const snapshots = buildSnapshots({
    iterations,
    contracts: collectionViews.contracts.items,
    decisions: collectionViews.decisions.items,
    changes: collectionViews.changes.items,
    verification: collectionViews.verification.items,
    semanticObservations: collectionViews.semanticObservations.items,
    dossiers: dossierView.dossiers,
    unlinked: dossierView.unlinked.items,
    records: publicRecordsView.items,
  }, {
    ...collectionCounts,
    iterations: iterations.length,
    dossiers: dossierView.dossiers.length,
    unlinked: dossierView.unlinked.total,
    records: publicRecordsView.total,
  });
  const iterationsView = boundCollectionInPlace(iterations, limits.maxCollectionItems);
  const dossiersView = boundCollectionInPlace(dossierView.dossiers, limits.maxCollectionItems);
  const unlinkedView = dossierView.unlinked;

  for (const [label, view] of [
    ["summary.asked", summaryViews.asked],
    ["summary.changed", summaryViews.changed],
    ["summary.decided", summaryViews.decided],
    ["iterations", iterationsView],
    ["contracts", collectionViews.contracts],
    ["decisions", collectionViews.decisions],
    ["changes", collectionViews.changes],
    ["verification", collectionViews.verification],
    ["semanticObservations", collectionViews.semanticObservations],
    ["dossiers", dossiersView],
    ["unlinked", unlinkedView],
    ["records", publicRecordsView],
  ]) {
    if (view.truncated) reportCollectionTruncated(diagnostics, label);
  }

  const normalized = {
    schemaVersion: OBSERVATORY_VIEW_SCHEMA_VERSION,
    generatedAt,
    project,
    snapshots,
    summary: {
      asked: summaryViews.asked.items,
      changed: summaryViews.changed.items,
      decided: summaryViews.decided.items,
    },
    iterations: iterationsView.items,
    contracts: collectionViews.contracts.items,
    decisions: collectionViews.decisions.items,
    changes: collectionViews.changes.items,
    verification: collectionViews.verification.items,
    semanticObservations: collectionViews.semanticObservations.items,
    dossiers: dossiersView.items,
    unlinked: unlinkedView.items,
    records: publicRecordsView.items,
    diagnostics: diagnostics.finish(),
  };

  const presentationRedaction = redactAndFinalizePresentationFields(normalized, redactionPolicy);
  if (presentationRedaction.redactions > 0) {
    diagnostics.add({
      code: "presentation_fields_redacted",
      severity: "info",
      message: "Sensitive values were removed from Observatory presentation text before it was returned.",
      provenance: "inferred",
      sourceRefs: [],
    });
  }
  if (presentationRedaction.limited) {
    diagnostics.add({
      code: "presentation_redaction_limited",
      severity: "error",
      message: "A presentation field exceeded the configured redaction limits and was replaced fail-closed.",
      provenance: "malformed",
      sourceRefs: [],
    });
  }
  normalized.diagnostics = diagnostics.finish();
  projectRecord = null;
  recordIndex = null;
  records = null;
  scan = null;
  return normalized;
}

async function scanKnowledgeBase(projectRoot, { limits, diagnostics }) {
  const resolvedProjectRoot = await resolveProjectBoundary(projectRoot);
  let boundary;
  try {
    boundary = await resolveKnowledgeBaseBoundary(resolvedProjectRoot, { allowMissing: true });
  } catch (error) {
    if (!(error instanceof ObservatoryPathError)) {
      throw error;
    }
    diagnostics.add({
      code: error.code,
      severity: "error",
      message: "The .sdlc knowledge base could not be read within the selected project boundary.",
      provenance: "malformed",
      sourceRefs: [{ path: ".sdlc" }],
    });
    return { projectRoot: resolvedProjectRoot, records: [] };
  }

  if (!boundary.knowledgeBaseRoot) {
    diagnostics.add({
      code: "knowledge_base_missing",
      severity: "warning",
      message: "No .sdlc knowledge base is recorded for this project.",
      provenance: "missing",
      sourceRefs: [{ path: ".sdlc" }],
    });
    return { projectRoot: boundary.projectRoot, records: [] };
  }

  const state = {
    entryCount: 0,
    fileCount: 0,
    totalBytes: 0,
    stopped: false,
    records: [],
  };
  await walkKnowledgeBase(boundary.knowledgeBaseRoot, "", 0, state, limits, diagnostics);

  if (!state.records.some((record) => record.path === ".sdlc/project.json")) {
    diagnostics.add({
      code: "project_record_missing",
      severity: "warning",
      message: "The canonical .sdlc/project.json record is missing.",
      provenance: "missing",
      sourceRefs: [{ path: ".sdlc/project.json" }],
    });
  }

  state.records.sort(compareRecords);
  return { projectRoot: boundary.projectRoot, records: state.records };
}

async function walkKnowledgeBase(root, relativeDirectory, depth, state, limits, diagnostics) {
  if (state.stopped) {
    return;
  }
  if (depth > limits.maxDepth) {
    diagnostics.add({
      code: "max_depth_exceeded",
      message: "A knowledge-base directory was skipped because it exceeds the configured depth limit.",
      sourceRefs: [{ path: toKnowledgeBasePath(relativeDirectory) }],
    });
    return;
  }

  const absoluteDirectory = path.join(root, ...portableSegments(relativeDirectory));
  const remainingEntries = Math.max(0, limits.maxEntries - state.entryCount);
  const directoryRead = await readKnowledgeBaseDirectory(absoluteDirectory, remainingEntries);
  state.entryCount += Math.min(directoryRead.inspectedEntries, remainingEntries);
  if (directoryRead.maxEntriesExceeded) {
    state.stopped = true;
    diagnostics.add({
      code: "max_entries_exceeded",
      message: "Additional knowledge-base entries were skipped by the configured traversal limit.",
      sourceRefs: [{ path: toKnowledgeBasePath(relativeDirectory) }],
    });
    return;
  }
  if (!directoryRead.readable) {
    diagnostics.add({
      code: "directory_unreadable",
      severity: "error",
      message: "A knowledge-base directory could not be read.",
      provenance: "malformed",
      sourceRefs: [{ path: toKnowledgeBasePath(relativeDirectory) }],
    });
    return;
  }

  for (const entry of relativeDirectory ? directoryRead.entries : orderKnowledgeBaseEntries(directoryRead.entries)) {
    if (state.stopped) {
      return;
    }
    const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    const publicPath = toKnowledgeBasePath(relative);
    const absolute = path.join(root, ...portableSegments(relative));

    if (entry.isSymbolicLink()) {
      let code = "symlink_ignored";
      let severity = "info";
      let message = "A symbolic link was ignored while scanning canonical evidence.";
      try {
        const target = await fs.realpath(absolute);
        if (!isContainedPath(root, target)) {
          code = "symlink_escape";
          severity = "error";
          message = "A symbolic link resolving outside .sdlc was blocked.";
        }
      } catch {
        code = "symlink_unresolved";
        severity = "warning";
        message = "An unresolved symbolic link was ignored.";
      }
      diagnostics.add({ code, severity, message, sourceRefs: [{ path: publicPath }] });
      continue;
    }

    if (entry.isDirectory()) {
      if (relativeDirectory === "" && DERIVED_DIRECTORIES.has(entry.name.toLowerCase())) {
        continue;
      }
      await walkKnowledgeBase(root, relative, depth + 1, state, limits, diagnostics);
      continue;
    }

    if (!entry.isFile() || !SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      continue;
    }
    if (relativeDirectory === "" && SETTINGS_FILES.has(entry.name.toLowerCase())) {
      continue;
    }
    await readCanonicalFile(root, relative, publicPath, state, limits, diagnostics);
  }
}

async function readKnowledgeBaseDirectory(directory, maxEntries) {
  const entries = [];
  let handle;
  let inspectedEntries = 0;
  try {
    handle = await fs.opendir(directory);
    for await (const entry of handle) {
      inspectedEntries += 1;
      if (inspectedEntries > maxEntries) {
        return {
          entries: [],
          inspectedEntries,
          maxEntriesExceeded: true,
          readable: true,
        };
      }
      entries.push(entry);
    }
  } catch {
    return {
      entries: [],
      inspectedEntries,
      maxEntriesExceeded: false,
      readable: false,
    };
  } finally {
    await closeDirectoryQuietly(handle);
  }
  entries.sort((left, right) => compareStrings(left.name, right.name));
  return {
    entries,
    inspectedEntries,
    maxEntriesExceeded: false,
    readable: true,
  };
}

async function closeDirectoryQuietly(handle) {
  if (!handle) return;
  try {
    await handle.close();
  } catch {
    // The bounded read result remains authoritative if the iterator already closed the handle.
  }
}

async function readCanonicalFile(root, relativePath, publicPath, state, limits, diagnostics) {
  if (state.fileCount >= limits.maxFiles) {
    state.stopped = true;
    diagnostics.add({
      code: "max_files_exceeded",
      message: "Additional knowledge-base files were skipped by the configured file limit.",
      sourceRefs: [{ path: ".sdlc" }],
    });
    return;
  }

  let resolved;
  try {
    resolved = await resolveExistingFileWithin(root, relativePath);
  } catch (error) {
    diagnostics.add({
      code: error instanceof ObservatoryPathError ? error.code : "file_unreadable",
      severity: "error",
      message: "A canonical evidence file changed or could not be inspected safely.",
      provenance: "malformed",
      sourceRefs: [{ path: publicPath }],
    });
    return;
  }
  state.fileCount += 1;
  const { stats } = resolved;

  if (stats.size > limits.maxFileBytes) {
    addRecord(state, limits, makeRecord({
      publicPath,
      format: formatForPath(publicPath),
      data: null,
      provenance: "malformed",
      sizeBytes: stats.size,
    }), diagnostics);
    diagnostics.add({
      code: "file_too_large",
      message: "A canonical evidence file was not parsed because it exceeds the configured size limit.",
      provenance: "malformed",
      sourceRefs: [{ path: publicPath }],
    });
    return;
  }
  if (state.totalBytes + stats.size > limits.maxTotalBytes) {
    state.stopped = true;
    diagnostics.add({
      code: "max_total_bytes_exceeded",
      message: "Additional evidence was skipped by the configured aggregate size limit.",
      sourceRefs: [{ path: publicPath }],
    });
    return;
  }

  let bytes;
  try {
    bytes = await readResolvedFileBounded(resolved, {
      maxBytes: limits.maxFileBytes,
      boundaryCode: "canonical_file_boundary_changed",
      tooLargeCode: "file_too_large",
      tooLargeMessage: "The canonical evidence file exceeds the configured size limit",
    });
  } catch (error) {
    diagnostics.add({
      code: error instanceof ObservatoryPathError ? error.code : "file_unreadable",
      severity: "error",
      message: "A canonical evidence file changed or could not be read safely.",
      provenance: "malformed",
      sourceRefs: [{ path: publicPath }],
    });
    return;
  }
  state.totalBytes += bytes.byteLength;
  const content = bytes.toString("utf8");
  const format = formatForPath(publicPath);

  if (format === "json") {
    try {
      const data = JSON.parse(content);
      const validShape = isPlainObject(data);
      addRecord(state, limits, makeRecord({
        publicPath,
        format,
        data: validShape ? data : null,
        provenance: validShape ? "recorded" : "malformed",
        sizeBytes: stats.size,
      }), diagnostics);
      if (!validShape) {
        diagnostics.add({
          code: "invalid_record_shape",
          message: "A JSON evidence file does not contain an object record.",
          provenance: "malformed",
          sourceRefs: [{ path: publicPath }],
        });
      } else if (
        typeof data.schema_version !== "string"
        && !isIntentAbiCodexEnvelopeCandidate(data, publicPath)
      ) {
        diagnostics.add({
          code: "schema_version_missing",
          severity: "info",
          message: "A legacy JSON record has no schema_version and was read tolerantly.",
          provenance: "inferred",
          sourceRefs: [{ path: publicPath }],
        });
      }
    } catch {
      addRecord(state, limits, makeRecord({
        publicPath,
        format,
        data: null,
        provenance: "malformed",
        sizeBytes: stats.size,
      }), diagnostics);
      diagnostics.add({
        code: "invalid_json",
        severity: "error",
        message: "A JSON evidence file is malformed and was not normalized.",
        provenance: "malformed",
        sourceRefs: [{ path: publicPath }],
      });
    }
    return;
  }

  if (format === "jsonl") {
    parseJsonLines(content, publicPath, stats.size, state, limits, diagnostics);
    return;
  }

  addRecord(state, limits, makeRecord({
    publicPath,
    format,
    data: null,
    provenance: "recorded",
    sizeBytes: stats.size,
  }), diagnostics);
}

function parseJsonLines(content, publicPath, sizeBytes, state, limits, diagnostics) {
  const splitLimit = Math.min(limits.maxJsonLines, 0xffff_fffe) + 1;
  const terminalNewlineLength = content.endsWith("\r\n") ? 2 : content.endsWith("\n") ? 1 : 0;
  const jsonLinesContent = terminalNewlineLength > 0
    ? content.slice(0, -terminalNewlineLength)
    : content;
  const lines = jsonLinesContent.split(/\r?\n/, splitLimit);
  if (lines.length > limits.maxJsonLines) {
    diagnostics.add({
      code: "max_json_lines_exceeded",
      message: "A JSONL evidence file was normalized only up to the configured line limit.",
      sourceRefs: [{ path: publicPath }],
    });
  }

  const lineLimit = Math.min(lines.length, limits.maxJsonLines);
  for (let index = 0; index < lineLimit; index += 1) {
    if (state.stopped) break;
    const raw = lines[index].trim();
    if (raw === "") {
      continue;
    }
    try {
      const data = JSON.parse(raw);
      const validShape = isPlainObject(data);
      addRecord(state, limits, makeRecord({
        publicPath,
        format: "jsonl",
        data: validShape ? data : null,
        provenance: validShape ? "recorded" : "malformed",
        sizeBytes,
        line: index + 1,
      }), diagnostics);
      if (!validShape) {
        diagnostics.add({
          code: "invalid_jsonl_record_shape",
          message: "A JSONL evidence line does not contain an object record.",
          provenance: "malformed",
          sourceRefs: [{ path: publicPath, line: index + 1 }],
        });
      }
    } catch {
      addRecord(state, limits, makeRecord({
        publicPath,
        format: "jsonl",
        data: null,
        provenance: "malformed",
        sizeBytes,
        line: index + 1,
      }), diagnostics);
      diagnostics.add({
        code: "invalid_jsonl",
        severity: "error",
        message: "A malformed JSONL evidence line was skipped.",
        provenance: "malformed",
        sourceRefs: [{ path: publicPath, line: index + 1 }],
      });
    }
  }
}

function makeRecord({ publicPath, format, data, provenance, sizeBytes, line = null }) {
  return {
    path: publicPath,
    format,
    kind: classifyRecord(publicPath, data),
    data,
    provenance,
    sizeBytes,
    line,
  };
}

function addRecord(state, limits, record, diagnostics) {
  if (state.records.length >= limits.maxRecords) {
    state.stopped = true;
    diagnostics.add({
      code: "max_records_exceeded",
      message: "Additional evidence records were skipped by the configured record limit.",
      sourceRefs: [{ path: record.path }],
    });
    return;
  }
  state.records.push(record);
}

function classifyRecord(publicPath, data) {
  if (isIntentAbiCodexEnvelopeCandidate(data, publicPath)) return "semantic-observation";
  if (publicPath === ".sdlc/project.json") return "project";
  if (publicPath.startsWith(".sdlc/baseline/")) return "baseline";
  if (publicPath.startsWith(".sdlc/autonomy/requirements/")) return "requirement-execution-profile";
  if (publicPath.startsWith(".sdlc/autonomy/deliveries/")) return "delivery-execution-profile";
  if (publicPath.startsWith(".sdlc/autonomy/decisions/")) return "autonomy-decision";
  if (/^\.sdlc\/autonomy\/standing\/[^/]+\/proposal\.json$/u.test(publicPath)) return "standing-approval";
  if (/^\.sdlc\/autonomy\/standing\/[^/]+\/(?:approval|revocation)\.json$/u.test(publicPath)) {
    return "standing-approval-decision";
  }
  if (/^\.sdlc\/autonomy\/standing\/[^/]+\/uses\/[^/]+\.json$/u.test(publicPath)) return "standing-approval-use";
  if (/^\.sdlc\/autonomy\/delegations\/[^/]+\/delegation\.json$/u.test(publicPath)) return "approval-delegation";
  if (/^\.sdlc\/autonomy\/delegations\/[^/]+\/revocation\.json$/u.test(publicPath)) return "approval-delegation-revocation";
  if (/^\.sdlc\/autonomy\/delegations\/[^/]+\/uses\/[^/]+\.json$/u.test(publicPath)) return "approval-delegation-use";
  if (publicPath.startsWith(".sdlc/requirements/")) return "requirement";
  if (publicPath.startsWith(".sdlc/contracts/")) return "contract";
  if (publicPath.startsWith(".sdlc/traces/")) return "trace";
  if (/^\.sdlc\/stories\/[^/]+\/story\.json$/.test(publicPath)) return "story";
  if (/^\.sdlc\/stories\/[^/]+\/claim\.json$/.test(publicPath)) return "claim";
  if (/^\.sdlc\/stories\/[^/]+\/task-start\.json$/.test(publicPath)) return "task-start";
  if (/^\.sdlc\/stories\/[^/]+\/steps\//.test(publicPath)) return "story-step";
  if (publicPath.startsWith(".sdlc/stories/")) return "story-artifact";
  if (publicPath.startsWith(".sdlc/decisions/")) return "decision";
  if (publicPath.startsWith(".sdlc/assumptions/")) return "assumption";
  if (publicPath.startsWith(".sdlc/risks/")) return "risk";
  if (publicPath.startsWith(".sdlc/tests/")) return "test";
  if (publicPath.startsWith(".sdlc/handoffs/")) return "handoff";
  if (publicPath.startsWith(".sdlc/releases/")) return "release";
  if (publicPath.startsWith(".sdlc/reports/")) return "report";
  if (publicPath.startsWith(".sdlc/authorizations/")) return "authorization";
  if (publicPath.startsWith(".sdlc/authorization-uses/")) return "authorization-use";
  if (publicPath.startsWith(".sdlc/output-contracts/")) return "output-contract";
  if (publicPath.startsWith(".sdlc/capability-discovery/")) return "capability";
  if (publicPath.startsWith(".sdlc/dependencies/")) return "dependency";
  if (publicPath.startsWith(".sdlc/work-breakdown/")) return "work-breakdown";
  if (
    data?.kind === "requirement_execution_profile"
    && data?.schema_version === "requirement-execution-profile:v1"
  ) return "requirement-execution-profile";
  if (
    data?.kind === "delivery_execution_profile"
    && ["delivery-execution-profile:v1", "delivery-execution-profile:v2"].includes(data?.schema_version)
  ) return "delivery-execution-profile";
  if (data?.kind === "autonomy_decision" && data?.schema_version === "autonomy-decision:v1") {
    return "autonomy-decision";
  }
  return "record";
}

function normalizeProject(record, projectRoot, diagnostics, limits) {
  if (!record) {
    return {
      id: null,
      name: null,
      sdlcVersion: null,
      provenance: "missing",
      sourceRefs: [{ path: ".sdlc/project.json" }],
    };
  }
  if (!isRecordObject(record)) {
    return {
      id: null,
      name: null,
      sdlcVersion: null,
      provenance: "malformed",
      sourceRefs: [sourceRef(record)],
    };
  }

  const id = boundedText(record.data.project_id ?? record.data.id, limits.maxTextChars);
  const name = boundedText(record.data.project_name ?? record.data.name, limits.maxTextChars);
  const sdlcVersion = boundedText(record.data.sdlc_version, limits.maxTextChars);
  let provenance = "recorded";
  let normalizedName = name.value;
  if (!normalizedName) {
    normalizedName = path.basename(projectRoot);
    provenance = "inferred";
    diagnostics.add({
      code: "project_name_inferred",
      severity: "info",
      message: "The project display name was inferred from the selected directory because no name is recorded.",
      provenance: "inferred",
      sourceRefs: [sourceRef(record)],
    });
  }
  return {
    id: id.value,
    name: normalizedName,
    sdlcVersion: sdlcVersion.value,
    provenance,
    sourceRefs: [sourceRef(record)],
    textTruncated: id.truncated || name.truncated || sdlcVersion.truncated,
  };
}

function itemFromRecord(record, { limits, diagnostics, dataOverride = undefined, sourceRefs = undefined, overrides = {} }) {
  const data = dataOverride === undefined ? record.data : dataOverride;
  const refs = (sourceRefs ?? [sourceRef(record)]).map(normalizeSourceRef);
  if (!isPlainObject(data)) {
    return {
      id: fallbackRecordId(record),
      type: overrides.type ?? record.kind,
      title: null,
      summary: null,
      status: null,
      phase: null,
      action: null,
      intent: null,
      timestamp: null,
      provenance: "malformed",
      sourceRefs: refs,
      rawHref: rawHref(record.path),
      explanation: null,
      rationale: null,
      narrative: null,
      inputs: [],
      outputs: [],
      alternatives: [],
      evidence: [],
      storyId: null,
      requirementId: null,
      requirementIds: [],
      contractId: null,
      related: [],
      linkage: overrides.linkage ?? null,
    };
  }

  const displayDefaults = autonomyDisplayDefaults(record, data);
  const recordedId = boundedText(overrides.id ?? data.id ?? data.story_id ?? data.contract_id, limits.maxTextChars);
  const title = boundedText(
    overrides.title ?? data.title ?? data.name ?? displayDefaults.title,
    limits.maxTextChars,
  );
  const summary = boundedText(
    overrides.summary ?? data.summary ?? data.purpose ?? data.description ?? displayDefaults.summary,
    limits.maxTextChars,
  );
  const status = boundedText(
    overrides.status ?? data.status ?? data.outcome ?? displayDefaults.status,
    limits.maxTextChars,
  );
  const phase = boundedText(overrides.phase ?? data.phase, limits.maxTextChars);
  const action = boundedText(data.action, limits.maxTextChars);
  const intent = boundedText(data.intent ?? data.change_intent, limits.maxTextChars);
  const timestamp = normalizeOptionalTimestamp(
    overrides.timestamp
      ?? data.created_at
      ?? data.updated_at
      ?? data.confirmed_at
      ?? data.evaluated_at
      ?? data.timestamp,
  );
  const id = recordedId.value ?? fallbackRecordId(record);
  const displayTitle = title.value ?? recordedId.value;
  const inferredLabel = !title.value && !recordedId.value;
  const provenance = overrides.provenance
    ?? (record.provenance === "recorded" && inferredLabel ? "inferred" : record.provenance);
  const privateReasoningPresent = containsPrivateReasoningSignal(data);
  const narrative = !privateReasoningPresent && isPlainObject(data.narrative) ? data.narrative : null;
  const explanation = buildExplanation(
    data,
    narrative,
    privateReasoningPresent,
    summary.value,
    refs,
    limits,
  );
  const rationale = buildRationale(narrative, privateReasoningPresent, refs, limits);
  const normalizedNarrative = buildNarrative(narrative, privateReasoningPresent, refs, limits);
  const storyId = boundedText(data.story_id, limits.maxTextChars);
  const contractId = boundedText(
    data.contract_id ?? (record.kind === "contract" ? data.id : null),
    limits.maxTextChars,
  );
  const requirementIds = normalizedStringList([
    ...(record.kind === "requirement" ? [data.id] : []),
    ...(record.kind === "requirement-execution-profile" ? [data.requirement_ref?.id] : []),
    data.requirement_id,
    ...boundedRecordArray(
      record,
      data.requirement_ids,
      limits,
      diagnostics,
      "/requirement_ids",
      "requirement IDs",
    ),
    ...boundedRecordArray(
      record,
      data.requirements,
      limits,
      diagnostics,
      "/requirements",
      "requirement references",
    ),
  ], limits);
  const related = normalizedStringList(data.related, limits);

  return {
    id,
    type: overrides.type ?? data.type ?? record.kind,
    title: displayTitle,
    summary: summary.value,
    ...(displayDefaults.humanTitle ? {
      humanTitle: displayDefaults.humanTitle,
      humanSummary: displayDefaults.humanSummary,
      humanStatus: displayDefaults.humanStatus,
    } : {}),
    status: status.value,
    phase: phase.value,
    action: action.value,
    intent: intent.value,
    timestamp,
    provenance,
    sourceRefs: refs,
    rawHref: rawHref(record.path),
    explanation,
    rationale,
    narrative: normalizedNarrative,
    inputs: buildTextRefs(
      privateReasoningPresent
        ? []
        : narrative?.input_summaries ?? narrative?.input_summary ?? data.inputs,
      `${id}:input`,
      refs,
      limits,
    ),
    outputs: buildTextRefs(
      privateReasoningPresent
        ? []
        : narrative?.output_summaries ?? narrative?.output_summary ?? data.outputs,
      `${id}:output`,
      refs,
      limits,
    ),
    alternatives: buildTextRefs(
      privateReasoningPresent ? [] : narrative?.alternatives,
      `${id}:alternative`,
      refs,
      limits,
    ),
    evidence: buildTextRefs(
      privateReasoningPresent
        ? []
        : [
            ...boundedRecordArray(
              record,
              data.evidence,
              limits,
              diagnostics,
              "/evidence",
              "evidence references",
            ),
            ...boundedRecordArray(
              record,
              narrative?.evidence,
              limits,
              diagnostics,
              "/narrative/evidence",
              "narrative evidence references",
            ),
          ],
      `${id}:evidence`,
      refs,
      limits,
    ),
    storyId: storyId.value,
    requirementId: requirementIds[0] ?? null,
    requirementIds,
    contractId: contractId.value,
    related,
    linkage: overrides.linkage ?? null,
    ...testRunFields(record, data),
    textTruncated: [recordedId, title, summary, status, phase, action, intent]
      .some((field) => field.truncated) || storyId.truncated || contractId.truncated,
  };
}

/**
 * Display-only grouping of standing approval records by id: status, delivery
 * count, and expiry. The CLI re-verifies hashes and bindings before any use;
 * this projection never grants anything.
 */
function standingApprovalProjections(records, trustedHostKeys = [], nowMs = null) {
  const projections = new Map();
  const projectionFor = (id) => {
    if (!projections.has(id)) {
      projections.set(id, { proposal: null, approved: false, revoked: false, signed: "none", decisions: new Map(), uses: 0, profileIds: [] });
    }
    return projections.get(id);
  };
  const decisions = [];
  for (const record of records) {
    if (!isRecordObject(record)) continue;
    const id = String(record.path || "").split("/")[3];
    if (!id) continue;
    if (record.kind === "standing-approval") projectionFor(id).proposal = record.data;
    if (record.kind === "standing-approval-decision") {
      decisions.push([id, record]);
      if (record.data.decision === "approved") projectionFor(id).approved = true;
      if (record.data.decision === "revoked") projectionFor(id).revoked = true;
    }
    if (record.kind === "standing-approval-use") {
      projectionFor(id).uses += 1;
      if (typeof record.data.profile_ref?.id === "string") projectionFor(id).profileIds.push(record.data.profile_ref.id);
    }
  }
  // Signatures are verified against the project's trusted keys once every
  // proposal is known; this never grants anything, it only words the view.
  for (const [id, record] of decisions) {
    const projection = projectionFor(id);
    const signed = standingDecisionSignature(record.data, projection.proposal, trustedHostKeys, nowMs);
    projection.decisions.set(record.path, signed);
    if (record.data.decision === "approved") projection.signed = signed;
  }
  return projections;
}

/**
 * "verified" when a decision embeds a host receipt that verifies against the
 * project's trusted keys, "unverified" when it embeds one that does not (or
 * cannot be checked here), and "none" without one.
 */
function standingDecisionSignature(data, proposal, trustedHostKeys, nowMs) {
  if (!isPlainObject(data) || (data.host_receipt === undefined && data.assurance === undefined)) return "none";
  if (!isPlainObject(proposal)) return "unverified";
  try {
    return standingDecisionAssuranceErrors({ proposal, record: data, trustedHostKeys, nowMs }).length === 0
      ? "verified"
      : "unverified";
  } catch {
    return "unverified";
  }
}

const DELIVERY_PROFILE_PATH = /^\.sdlc\/autonomy\/deliveries\/[^/]+\.json$/u;
const AUTONOMY_APPROVAL_PATH = /^\.sdlc\/autonomy\/approvals\/[^/]+\.json$/u;
const DELIVERY_EXECUTION_PATH = /^\.sdlc\/autonomy\/executions\/([^/]+)\/(start|close)\.json$/u;
const DELIVERY_ACTION_PATH = /^\.sdlc\/autonomy\/actions\/[^/]+\.json$/u;
const DELIVERY_METERING_PATH = /^\.sdlc\/autonomy\/metering\/([^/]+)\/(plans|usage)\/[^/]+\.json$/u;

/**
 * Display-only lead time and recorded usage of each delivery, derived from
 * the same records and rules the CLI uses. This projection verifies no meter
 * evidence or signature, so a cost a meter claims is labelled unverified; the
 * CLI verifies it before any decision relies on a cost, and this projection
 * never grants anything.
 */
function deliveryMetricProjections(records) {
  const deliveries = new Map();
  const approvals = new Map();
  const fallbackEvents = [];
  const entryFor = (id) => {
    if (!deliveries.has(id)) {
      deliveries.set(id, { profile: null, start: null, close: null, actions: [], plans: [], receipts: [] });
    }
    return deliveries.get(id);
  };
  for (const record of records) {
    if (!isRecordObject(record)) continue;
    const recordPath = String(record.path || "");
    const data = record.data;
    if (record.kind === "delivery-execution-profile" && DELIVERY_PROFILE_PATH.test(recordPath) && typeof data.id === "string") {
      entryFor(data.id).profile = data;
      continue;
    }
    if (AUTONOMY_APPROVAL_PATH.test(recordPath)) {
      approvals.set(recordPath, data);
      continue;
    }
    let match = DELIVERY_EXECUTION_PATH.exec(recordPath);
    if (match) {
      entryFor(match[1])[match[2]] = data;
      continue;
    }
    if (DELIVERY_ACTION_PATH.test(recordPath) && typeof data.profile_ref?.id === "string") {
      entryFor(data.profile_ref.id).actions.push(data);
      continue;
    }
    match = DELIVERY_METERING_PATH.exec(recordPath);
    if (match) {
      entryFor(match[1])[match[2] === "plans" ? "plans" : "receipts"].push(data);
      continue;
    }
    if (record.kind === "trace" && data.action === "autonomy.standing.fallback") fallbackEvents.push(data);
  }
  const projections = new Map();
  for (const [profileId, entry] of deliveries) {
    if (!entry.profile) continue;
    try {
      const leadTime = deriveDeliveryLeadTime({
        profile: entry.profile,
        approval: approvals.get(String(entry.profile.approval_ref?.path || "")) || null,
        start: entry.start,
        close: entry.close,
        actions: entry.actions,
        events: fallbackEvents,
      });
      const usage = summarizeDeliveryUsage(entry.receipts, entry.plans);
      projections.set(profileId, {
        leadTime: {
          status: leadTime.status,
          finish: leadTime.finish?.milestone ?? null,
          stages: leadTime.stages.map((stage) => ({ from: stage.from, to: stage.to, seconds: stage.seconds })),
          totalSeconds: leadTime.total_seconds,
          waitingSeconds: leadTime.waiting_for_person.seconds,
          waitingConfirmations: leadTime.waiting_for_person.intervals.length,
          unrecordedRequests: leadTime.waiting_for_person.unrecorded_requests,
        },
        cost: {
          status: usage.cost_status,
          amount: usage.cost?.amount ?? null,
          currency: usage.cost?.currency ?? null,
          tokens: usage.tokens,
          receipts: usage.receipt_count,
          sources: usage.metered_sources,
        },
      });
    } catch {
      // A record this projection cannot read shows no metrics instead of wrong ones.
    }
  }
  return projections;
}

/** Recorded spend of a standing approval budget, from the deliveries that used it. */
function standingBudgetProjection(proposal, profileIds, deliveryProjections) {
  const budget = proposal?.budget;
  if (!budget || typeof budget.currency !== "string") return null;
  const amounts = [];
  let notMeasured = 0;
  for (const profileId of profileIds) {
    const cost = deliveryProjections.get(profileId)?.cost;
    if (cost?.amount && cost.currency === budget.currency) amounts.push(cost.amount);
    // Nothing here is verified: a delivery without even a meter's claim is not measured.
    if (!["metered", "unverified"].includes(cost?.status) || cost.currency !== budget.currency) notMeasured += 1;
  }
  const normalize = (value) => (value === null || value === undefined ? null : String(value));
  return {
    currency: budget.currency,
    perDelivery: normalize(budget.per_delivery_amount),
    total: normalize(budget.total_amount),
    spent: sumAmounts(amounts),
    deliveries: profileIds.length,
    notMeasured,
    verified: false,
  };
}

function formatBudgetAmount(currency, value) {
  if (value === null || value === undefined) return null;
  const [whole, fraction = ""] = String(value).split(".");
  return `${currency} ${whole}.${fraction.padEnd(2, "0")}`;
}

function standingApprovalItemOverrides(record, projections, nowMs, deliveryProjections = new Map()) {
  const id = String(record.path || "").split("/")[3];
  const projection = projections.get(id) || { proposal: null, approved: false, revoked: false, signed: "none", decisions: new Map(), uses: 0, profileIds: [] };
  const proposal = projection.proposal || {};
  const maxDeliveries = Number(proposal.max_deliveries) || 0;
  const expiresAt = typeof proposal.expires_at === "string" ? proposal.expires_at : null;
  const expired = expiresAt ? Date.parse(expiresAt) <= nowMs : false;
  const status = projection.revoked
    ? "revoked"
    : !projection.approved
      ? "proposed"
      : expired
        ? "expired"
        : projection.uses >= maxDeliveries
          ? "exhausted"
          : "active";
  const description = proposal.work_kind?.description || "repeated low-risk work";
  if (record.kind === "standing-approval") {
    const standingBudget = standingBudgetProjection(proposal, projection.profileIds, deliveryProjections);
    const spent = standingBudget
      ? ` Cost recorded so far, not verified here: ${formatBudgetAmount(standingBudget.currency, standingBudget.spent ?? "0")}`
        + `${standingBudget.total ? ` of ${formatBudgetAmount(standingBudget.currency, standingBudget.total)}` : ""}`
        + `${standingBudget.notMeasured > 0 ? `; ${standingBudget.notMeasured} without a meter reading` : ""}.`
      : "";
    return {
      title: `Standing approval for repeated work: ${description}`,
      summary: `${projection.uses} of ${maxDeliveries} deliveries used, ${Math.max(0, maxDeliveries - projection.uses)} left; `
        + `expires ${expiresAt || "at an unknown time"}. Merges, production, and deploys are never covered.`
        + (!projection.approved ? ""
          : projection.signed === "verified" ? " The approval is signed by the trusted host."
            : projection.signed === "unverified" ? " The approval carries a host signature that could not be verified here." : "")
        + spent,
      status,
      ...(standingBudget ? { standingBudget } : {}),
    };
  }
  if (record.kind === "standing-approval-decision") {
    const signed = projection.decisions.get(record.path) || "none";
    const unverified = " It carries a host signature that could not be verified here.";
    return record.data.decision === "revoked"
      ? {
          title: `Standing approval revoked: ${description}`,
          summary: `Revoked: ${record.data.reason || "no reason recorded"}. Deliveries in progress ask for normal confirmations at their next step.`
            + (signed === "verified" ? " The trusted host signed the revocation." : signed === "unverified" ? unverified : ""),
          status: "revoked",
        }
      : {
          title: `Standing approval granted: ${description}`,
          summary: signed === "verified"
            ? "A person approved these limits in advance for similar deliveries, and the trusted host signed that approval."
            : `A person approved these limits in advance for similar deliveries.${signed === "unverified" ? unverified : ""}`,
          status: "approved",
        };
  }
  return {
    title: `Delivery ran under a standing approval: ${description}`,
    summary: `Delivery ${record.data.delivery?.id || "unknown"} used slot ${record.data.slot} of ${record.data.max_deliveries}.`,
    status: "recorded",
  };
}

function autonomyDisplayDefaults(record, data) {
  if (!isPlainObject(data)) return {};
  if (record.kind === "requirement-execution-profile") {
    const presentation = requirementAutonomyPresentation(data.status);
    return {
      title: presentation.title,
      summary: presentation.summary,
      humanTitle: presentation.title,
      humanSummary: presentation.summary,
      humanStatus: presentation.status,
      status: data.status ?? null,
    };
  }
  if (record.kind === "delivery-execution-profile") {
    const presentation = deliveryAutonomyPresentation(data.status, data.delivery_kind);
    return {
      title: presentation.title,
      summary: presentation.summary,
      humanTitle: presentation.title,
      humanSummary: presentation.summary,
      humanStatus: presentation.status,
      status: data.status ?? null,
    };
  }
  if (record.kind === "autonomy-decision") {
    const presentation = autonomyDecisionPresentation(data.execution_status);
    return {
      title: presentation.title,
      summary: presentation.summary,
      humanTitle: presentation.title,
      humanSummary: presentation.summary,
      humanStatus: presentation.status,
      status: data.execution_status ?? null,
    };
  }
  return {};
}

function requirementAutonomyPresentation(statusValue) {
  const status = String(statusValue ?? "").trim().toLowerCase();
  if (status === "proposed") {
    return {
      title: "Working limit awaiting approval",
      summary: "A limit has been proposed for this request, but no delivery may rely on it until it is approved.",
      status: "Awaiting approval",
    };
  }
  if (status === "active") {
    return {
      title: "Approved working limit for this request",
      summary: "This sets how independently a delivery may be configured; every code change or local installation still needs its own agreement.",
      status: "In effect",
    };
  }
  if (status === "revoked") {
    return {
      title: "Revoked working limit for this request",
      summary: "This limit can no longer be used; unfinished work needs a new approved limit before it continues.",
      status: "No longer usable",
    };
  }
  return {
    title: "Working limit needs attention",
    summary: "The recorded state does not confirm that this request can be used to configure a delivery.",
    status: "Needs attention",
  };
}

function deliveryAutonomyPresentation(statusValue, deliveryKindValue) {
  const status = String(statusValue ?? "").trim().toLowerCase();
  const subject = deliveryKindValue === "pull_request"
    ? "code change"
    : deliveryKindValue === "local_release"
      ? "local installation"
      : "delivery";
  if (status === "proposed") {
    return {
      title: `Working agreement awaiting approval for this ${subject}`,
      summary: `A separate way of working has been proposed for this ${subject}; work must wait for approval.`,
      status: "Awaiting approval",
    };
  }
  if (status === "active") {
    return {
      title: `Approved working agreement for this ${subject}`,
      summary: `The approved way of working applies only to this ${subject} and cannot be reused for another change or installation.`,
      status: "In effect",
    };
  }
  if (status === "revoked") {
    return {
      title: `Revoked working agreement for this ${subject}`,
      summary: `The previous agreement no longer permits work on this ${subject}; a new approval is required to continue.`,
      status: "No longer usable",
    };
  }
  return {
    title: `Working agreement needs attention for this ${subject}`,
    summary: `The recorded state does not confirm that work may proceed on this ${subject}.`,
    status: "Needs attention",
  };
}

function autonomyDecisionPresentation(statusValue) {
  const status = String(statusValue ?? "").trim().toLowerCase();
  if (status === "ready") {
    return {
      title: "This work may continue",
      summary: "Routine work may proceed within the agreed limits; protected steps still keep their separate safeguards.",
      status: "Ready to continue",
    };
  }
  if (status === "checkpoint_required") {
    return {
      title: "Review needed before the next protected step",
      summary: "Routine work has reached a boundary where the recorded evidence must be reviewed before continuing.",
      status: "Review needed",
    };
  }
  if (status === "approval_required") {
    return {
      title: "Approval needed before work continues",
      summary: "The next step will wait until a person reviews the evidence and approves or changes the plan.",
      status: "Approval needed",
    };
  }
  if (status === "blocked") {
    return {
      title: "This work is blocked",
      summary: "Work cannot continue until the recorded conflict or missing protection is resolved.",
      status: "Blocked",
    };
  }
  return {
    title: "Current permission needs attention",
    summary: "The recorded state does not make clear whether this work may continue.",
    status: "Needs attention",
  };
}

function buildExplanation(data, narrative, privateReasoningPresent, fallbackSummary, refs, limits) {
  if (narrative) {
    const generated = boundedText(
      narrative.explanation?.text ?? narrative.generated_explanation,
      limits.maxTextChars,
    );
    if (generated.value) {
      return {
        text: generated.value,
        authoring: normalizeExplanationAuthoring(
          narrative.explanation?.kind ?? narrative.explanation_source,
          Boolean(generated.value),
        ),
        provenance: "recorded",
        sourceRefs: refs.map((ref) => ({ ...ref, pointer: "/narrative" })),
        truncated: generated.truncated,
      };
    }
  }

  const legacyExplanation = privateReasoningPresent
    ? { value: null, truncated: false }
    : boundedText(data.generated_explanation ?? data.explanation, limits.maxTextChars);
  if (legacyExplanation.value) {
    return {
      text: legacyExplanation.value,
      authoring: "deterministic",
      provenance: "recorded",
      sourceRefs: refs,
      truncated: legacyExplanation.truncated,
    };
  }
  if (!fallbackSummary) {
    return null;
  }
  return {
    text: fallbackSummary,
    authoring: "deterministic",
    provenance: "recorded",
    sourceRefs: refs,
    truncated: false,
  };
}

function buildRationale(narrative, privateReasoningPresent, refs, limits) {
  if (!narrative || privateReasoningPresent) return null;
  const hasSummary = Object.hasOwn(narrative, "rationale_summary");
  const hasCamelSummary = Object.hasOwn(narrative, "rationaleSummary");
  const field = hasSummary ? "rationale_summary" : hasCamelSummary ? "rationaleSummary" : "rationale";
  const rationale = boundedText(narrative[field], limits.maxTextChars);
  if (!rationale.value) return null;
  return {
    text: rationale.value,
    provenance: "recorded",
    sourceRefs: refs.map((ref) => ({ ...ref, pointer: `/narrative/${field}` })),
    truncated: rationale.truncated,
  };
}

function buildNarrative(narrative, privateReasoningPresent, refs, limits) {
  if (!narrative || privateReasoningPresent) return null;
  const rationale = buildRationale(narrative, false, refs, limits);
  const generated = boundedText(
    narrative.explanation?.text ?? narrative.generated_explanation,
    limits.maxTextChars,
  );
  const inputSummaries = normalizedStringList(
    narrative.input_summaries ?? narrative.input_summary,
    limits,
  );
  const outputSummaries = normalizedStringList(
    narrative.output_summaries ?? narrative.output_summary,
    limits,
  );
  const alternatives = normalizedStringList(narrative.alternatives, limits);
  const evidence = normalizedStringList(narrative.evidence, limits);
  if (
    !rationale
    && !generated.value
    && inputSummaries.length === 0
    && outputSummaries.length === 0
    && alternatives.length === 0
    && evidence.length === 0
  ) {
    return null;
  }
  return {
    rationaleSummary: rationale?.text ?? null,
    generatedExplanation: generated.value,
    explanationSource: generated.value
      ? normalizeExplanationAuthoring(
        narrative.explanation?.kind ?? narrative.explanation_source,
        true,
      )
      : null,
    inputSummaries,
    outputSummaries,
    alternatives,
    evidence,
    provenance: "recorded",
    sourceRefs: refs.map((ref) => ({ ...ref, pointer: "/narrative" })),
    truncated: Boolean(rationale?.truncated || generated.truncated),
  };
}

function normalizeExplanationAuthoring(value, generated) {
  if (["human", "human-authored"].includes(value)) return "human";
  if (["codex", "codex-generated", "agent"].includes(value)) return "codex-generated";
  return generated ? "codex-generated" : "deterministic";
}

function containsPrivateReasoningSignal(value) {
  return inspectPrivateReasoningSignal(value).present;
}

function inspectPrivateReasoningSignal(value) {
  const cacheable = Array.isArray(value) || isPlainObject(value);
  if (cacheable) {
    const cached = privateReasoningInspectionCache.get(value);
    if (cached) return cached;
  }
  const inspection = inspectPrivateReasoningSignalUncached(value);
  if (cacheable) privateReasoningInspectionCache.set(value, inspection);
  return inspection;
}

function inspectPrivateReasoningSignalUncached(value) {
  const stack = [{ value, depth: 0 }];
  const seen = new WeakSet();
  let inspectedNodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    const candidate = current.value;
    if (!Array.isArray(candidate) && !isPlainObject(candidate)) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    inspectedNodes += 1;
    if (
      inspectedNodes > PRIVATE_REASONING_SCAN_MAX_NODES
      || current.depth > PRIVATE_REASONING_SCAN_MAX_DEPTH
    ) {
      return PRIVATE_REASONING_LIMITED;
    }
    if (Array.isArray(candidate)) {
      const remaining = PRIVATE_REASONING_SCAN_MAX_NODES - inspectedNodes - stack.length;
      if (candidate.length > remaining) {
        return PRIVATE_REASONING_LIMITED;
      }
      for (let index = candidate.length - 1; index >= 0; index -= 1) {
        stack.push({ value: candidate[index], depth: current.depth + 1 });
      }
      continue;
    }
    const keys = Object.keys(candidate);
    const remaining = PRIVATE_REASONING_SCAN_MAX_NODES - inspectedNodes - stack.length;
    if (keys.length > remaining) {
      return PRIVATE_REASONING_LIMITED;
    }
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      const item = candidate[key];
      const normalized = normalizeSensitiveKey(key);
      if (PRIVATE_REASONING_KEYS.has(normalized)) {
        return PRIVATE_REASONING_PRESENT;
      }
      if (PRIVATE_REASONING_FLAG_KEYS.has(normalized) && item === true) {
        return PRIVATE_REASONING_PRESENT;
      }
      stack.push({ value: item, depth: current.depth + 1 });
    }
  }
  return PRIVATE_REASONING_ABSENT;
}

function reportPrivateReasoningDiagnostics(records, diagnostics) {
  for (const record of records) {
    if (!isRecordObject(record)) continue;
    const inspection = inspectPrivateReasoningSignal(record.data);
    if (!inspection.present) continue;
    if (inspection.traversalLimited) {
      diagnostics.add({
        code: "private_reasoning_scan_limited",
        severity: "error",
        message: "A record exceeded the bounded private-reasoning scan and was excluded from normalized narrative surfaces.",
        provenance: "malformed",
        sourceRefs: [sourceRef(record)],
      });
    }
    diagnostics.add({
      code: "private_reasoning_redacted",
      severity: "error",
      message: "A record marked as containing private reasoning was excluded from the normalized explanation view.",
      provenance: "malformed",
      sourceRefs: [sourceRef(record)],
    });
  }
}

function normalizeSensitiveKey(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function buildTextRefs(value, idPrefix, sourceRefs, limits) {
  return asArray(value)
    .slice(0, limits.maxCollectionItems)
    .map((item, index) => {
      const raw = typeof item === "string"
        ? item
        : isPlainObject(item)
          ? item.title ?? item.summary ?? item.id ?? item.path
          : null;
      const text = boundedText(raw, limits.maxTextChars);
      if (!text.value) {
        return null;
      }
      return {
        id: `${idPrefix}:${index + 1}`,
        title: text.value,
        label: text.value,
        provenance: "recorded",
        sourceRefs,
        truncated: text.truncated,
      };
    })
    .filter(Boolean);
}

function requestItemsFromTrace(record, limits) {
  if (!hasRequestItem(record)) {
    return [];
  }
  const request = record.data.request;
  const summary = boundedText(request.summary, limits.maxTextChars);
  const ref = { ...sourceRef(record), pointer: "/request/summary" };
  return [{
    id: `${record.data.id ?? fallbackRecordId(record)}:request`,
    type: "request",
    title: summary.value,
    summary: summary.value,
    status: null,
    phase: record.data.phase ?? null,
    timestamp: normalizeOptionalTimestamp(record.data.created_at),
    provenance: "recorded",
    sourceRefs: [ref],
    rawHref: rawHref(record.path),
    explanation: {
      text: summary.value,
      authoring: "human",
      provenance: "recorded",
      sourceRefs: [ref],
      truncated: summary.truncated,
    },
    inputs: [],
    outputs: [],
    alternatives: [],
    evidence: [],
    textTruncated: summary.truncated,
  }];
}

function hasRequestItem(record) {
  const request = record.data?.request;
  return isPlainObject(request)
    && typeof request.summary === "string"
    && request.summary.trim() !== "";
}

const APPROVAL_DELEGATION_KINDS = new Set(["approval-delegation", "approval-delegation-revocation", "approval-delegation-use"]);

function approvalDelegationItemOverrides(record, nowMs) {
  const data = record.data;
  if (record.kind === "approval-delegation-use") {
    return {
      title: `Agent applied delegation ${data.delegation_ref?.id || "unknown"}: ${data.action || "unknown action"}`,
      summary: `${data.statement || "approved by the agent under a delegation"}. Valid at use (${data.valid_at_use?.checked_at || "unknown time"}); not a direct approval by a person.`,
      status: "recorded",
    };
  }
  if (record.kind === "approval-delegation-revocation") {
    return {
      title: `Delegation ${data.delegation_ref?.id || "unknown"} revoked`,
      summary: `Revoked: ${data.reason || "no reason recorded"}. Later agent commands under it are refused.`,
      status: "revoked",
    };
  }
  const grantor = data.grantor?.name || data.grantor?.id || "a person";
  const expiresAt = typeof data.expires_at === "string" ? data.expires_at : null;
  const expired = expiresAt ? Date.parse(expiresAt) <= nowMs : true;
  return {
    title: `${grantor} delegated approvals to the agent (${data.id})`,
    summary: `Actions: ${(data.actions || []).join(", ")}; scope ${data.scope?.kind === "project" ? "project" : `${data.scope?.kind}:${data.scope?.id}`}; `
      + `expires ${expiresAt || "at an unknown time"}. Never covers protected-branch push/merge, ungoverned escapes, deploy/production, secrets or installs.`,
    status: expired ? "expired" : "active",
  };
}

function approvalItemsFromRecord(record, limits, diagnostics) {
  return approvalDataFromRecord(record, limits, diagnostics)
    .map((approval, index) => approvalItemFromRecord(record, approval, index, limits, diagnostics));
}

function approvalDataFromRecord(record, limits, diagnostics) {
  if (!isRecordObject(record) || !Array.isArray(record.data.approvals)) {
    return [];
  }
  return boundedPlainObjectItems(
    record,
    record.data.approvals,
    limits,
    diagnostics,
    "/approvals",
    "approval entries",
  );
}

function approvalItemFromRecord(record, approval, index, limits, diagnostics) {
  return itemFromRecord(record, {
    limits,
    diagnostics,
    dataOverride: approval,
    sourceRefs: [{ ...sourceRef(record), pointer: `/approvals/${index}` }],
    overrides: {
      id: approval.id ?? `${fallbackRecordId(record)}:approval:${index + 1}`,
      type: "approval",
      phase: record.data.phase ?? null,
      ...(approval.approval_source === "delegated" && isPlainObject(approval.delegation)
        ? {
            title: `Approved by the agent under delegation ${approval.delegation.id}, not directly by a person`,
            summary: String(approval.delegation.statement || approval.summary || ""),
          }
        : {}),
    },
  });
}

function createObservatoryRecordIndex(records, limits, diagnostics) {
  const singleRaw = (key, value) => key === undefined || key === null || key === ""
    ? NO_INDEX_ENTRIES
    : [recordIndexEntry(key, value)];
  const normalizeIndexId = normalizeCanonicalId;
  const singleId = (key, value) => {
    const normalizedKey = normalizeIndexId(key);
    return normalizedKey === null
      ? NO_INDEX_ENTRIES
      : [recordIndexEntry(normalizedKey, value)];
  };
  const objectByKind = (record, kind) => isRecordObject(record) && record.kind === kind;

  const index = createRecordIndex(records, {
    byPath(record) {
      return singleRaw(record.path, record);
    },
    byId(record) {
      if (!isRecordObject(record)) return NO_INDEX_ENTRIES;
      return singleId(record.data.id, record);
    },
    storyById(record) {
      if (!objectByKind(record, "story")) return NO_INDEX_ENTRIES;
      return singleId(record.data.id, record);
    },
    byStoryId(record) {
      return isRecordObject(record)
        ? singleId(record.data.story_id, record)
        : NO_INDEX_ENTRIES;
    },
    stepByPathStoryId(record) {
      if (!objectByKind(record, "story-step")) return NO_INDEX_ENTRIES;
      const explicitStoryId = normalizeIndexId(record.data.story_id);
      const pathStoryId = normalizeIndexId(storyIdFromPath(record.path));
      return pathStoryId && pathStoryId !== explicitStoryId
        ? [recordIndexEntry(pathStoryId, record)]
        : NO_INDEX_ENTRIES;
    },
    relatedToStoryId(record) {
      if (!isRecordObject(record)) return NO_INDEX_ENTRIES;
      const entries = [];
      let primaryAssigned = false;
      const related = boundedRecordArray(
        record,
        record.data.related,
        limits,
        diagnostics,
        "/related",
        "related-story references",
      );
      for (let index = 0; index < related.length; index += 1) {
        const relatedId = normalizeIndexId(related[index]);
        if (!relatedId) continue;
        entries.push(recordIndexEntry(relatedId, {
          record,
          pointer: `/related/${index}`,
        }, { priority: primaryAssigned ? 0 : DIRECT_INDEX_PRIORITY }));
        primaryAssigned = true;
      }
      return entries;
    },
    byContractId(record) {
      return isRecordObject(record)
        ? singleId(record.data.contract_id, record)
        : NO_INDEX_ENTRIES;
    },
    workBreakdownByStoryId(record) {
      if (!objectByKind(record, "work-breakdown")) return NO_INDEX_ENTRIES;
      const entries = [];
      const seen = new Set();
      let primaryAssigned = false;
      const items = boundedRecordArray(
        record,
        record.data.items,
        limits,
        diagnostics,
        "/items",
        "work-breakdown items",
      );
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        if (!isPlainObject(item) || item.type !== "story") continue;
        const storyId = normalizeIndexId(item.id);
        if (!storyId || seen.has(storyId)) continue;
        seen.add(storyId);
        entries.push(recordIndexEntry(
          storyId,
          { record, itemIndex: index },
          { priority: primaryAssigned ? 0 : DIRECT_INDEX_PRIORITY },
        ));
        primaryAssigned = true;
      }
      return entries;
    },
    deliveryProfileByStoryId(record) {
      if (!objectByKind(record, "delivery-execution-profile")) return NO_INDEX_ENTRIES;
      const entries = [];
      let primaryAssigned = false;
      const storyRefs = boundedRecordArray(
        record,
        record.data.story_refs,
        limits,
        diagnostics,
        "/story_refs",
        "delivery story references",
      );
      for (let index = 0; index < storyRefs.length; index += 1) {
        const storyRef = storyRefs[index];
        if (!isPlainObject(storyRef)) continue;
        const storyId = normalizeIndexId(storyRef.id);
        if (!storyId) continue;
        entries.push(recordIndexEntry(
          storyId,
          { record, storyRefIndex: index },
          { priority: primaryAssigned ? 0 : DIRECT_INDEX_PRIORITY },
        ));
        primaryAssigned = true;
      }
      return entries;
    },
    autonomyDecisionByDeliveryProfileId(record) {
      if (!objectByKind(record, "autonomy-decision")) return NO_INDEX_ENTRIES;
      return singleId(record.data.delivery?.profile_id, record);
    },
  }, {
    directIndexes: [
      "byPath",
      "byId",
      "storyById",
      "byStoryId",
      "stepByPathStoryId",
      "byContractId",
      "autonomyDecisionByDeliveryProfileId",
    ],
    maxEntriesByIndex: {
      byPath: limits.maxRecords,
      byId: limits.maxRecords,
      storyById: limits.maxRecords,
      byStoryId: limits.maxRecords,
      stepByPathStoryId: limits.maxRecords,
      relatedToStoryId: limits.maxRecords,
      byContractId: limits.maxRecords,
      workBreakdownByStoryId: limits.maxRecords,
      deliveryProfileByStoryId: limits.maxRecords,
      autonomyDecisionByDeliveryProfileId: limits.maxRecords,
    },
  });

  for (const name of [
    "relatedToStoryId",
    "workBreakdownByStoryId",
    "deliveryProfileByStoryId",
  ]) {
    if (!index.truncated(name)) continue;
    diagnostics.add({
      code: "record_index_truncated",
      message: `The ${name} relationship index reached the configured global record budget; primary per-record lineage was retained and omitted additional fan-out remains unlinked.`,
      provenance: "inferred",
      sourceRefs: [],
    });
  }
  return index;
}

function normalizeIterations(recordIndex, limits, diagnostics, now = Date.now()) {
  const stories = [];
  for (const [canonicalStoryId, matches] of recordIndex.entries("storyById")) {
    for (const storyRecord of matches) stories.push({ canonicalStoryId, storyRecord });
  }

  return stories
    .map(({ canonicalStoryId, storyRecord }) => {
      const story = storyRecord.data;
      const base = itemFromRecord(storyRecord, { limits, diagnostics });
      const currentPhase = SDLC_PHASES.includes(story.phase) ? story.phase : null;
      const storyTaskStarts = [];
      const storyClaims = [];
      const storySteps = [];
      const storyTraces = [];
      const storyClosures = [];
      const storyParkings = [];
      const storyFinalReceipts = [];
      const storyTests = [];
      for (const record of recordIndex.get("byStoryId", canonicalStoryId)) {
        if (record.kind === "test" && isRecordObject(record)) storyTests.push(record);
        if (record.kind === "task-start") storyTaskStarts.push(record);
        if (record.kind === "claim") storyClaims.push(record);
        if (record.kind === "story-step") storySteps.push(record);
        if (record.kind === "trace") storyTraces.push(record);
        if (record.kind === "story-artifact" && /\/closure\.json$/u.test(record.path)) storyClosures.push(record);
        if (record.kind === "story-artifact" && /\/parking\/[^/]+\.json$/u.test(record.path)) storyParkings.push(record);
        if (record.data?.kind === "workflow_final_gate_receipt") storyFinalReceipts.push(record);
      }
      storySteps.push(...recordIndex.get("stepByPathStoryId", canonicalStoryId));
      storySteps.sort(compareRecords);

      // story.json keeps the phase it was planned in; once that phase has a
      // completed step, the active claim is working on the next open phase.
      const completedPhases = new Set(storySteps
        .filter((record) => !["blocked", "failed"].includes(record.data.status))
        .map(phaseFromStep)
        .filter(Boolean));
      const workingPhase = currentPhase && completedPhases.has(currentPhase)
        ? SDLC_PHASES.find((phase) => !completedPhases.has(phase)) ?? currentPhase
        : currentPhase;
      const closure = storyClosure(storyClosures);
      const claimed = !closure && storyClaims.some((record) => isActiveClaim(record, now));
      const parked = closure ? null : storyParking(storyParkings);
      const claimExpired = closure || claimed ? null : expiredClaim(storyClaims, now);
      const certification = storyCertification(storyFinalReceipts, storyTraces);

      const iteration = {
        ...base,
        currentPhase,
        claimed,
        closure,
        // Present only when they apply, so the wire model of other stories is unchanged.
        ...(parked ? { parked } : {}),
        ...(claimExpired ? { claimExpired } : {}),
        ...(certification ? { certification } : {}),
        ...storyFixLink(story),
        brief: storyBrief({ story, storyClaims, storyTraces, storyTests, recordIndex, limits }),
        phases: SDLC_PHASES.map((phase) => normalizePhaseState({
          phase,
          currentPhase: workingPhase,
          story,
          storyRecord,
          taskStarts: storyTaskStarts,
          claims: closure ? [] : storyClaims,
          steps: storySteps,
          traces: storyTraces,
        })),
      };
      Object.defineProperty(iteration, ITERATION_CANONICAL_STORY_ID, {
        value: canonicalStoryId,
      });
      return iteration;
    })
    .map(withFixedBy)
    .sort((left, right) =>
      compareStrings(String(left.id), String(right.id))
      || compareStrings(
        String(left[ITERATION_CANONICAL_STORY_ID]),
        String(right[ITERATION_CANONICAL_STORY_ID]),
      ));
}

const FIX_LINK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;

// A fix story (story create --fixes / --incident) names the story it corrects.
// Present only when it applies, so the wire model of other stories is unchanged.
function storyFixLink(story) {
  const storyId = typeof story?.fixes?.story_id === "string" ? story.fixes.story_id : "";
  if (!FIX_LINK_ID_PATTERN.test(storyId)) return {};
  const incidentId = typeof story.fixes.incident_id === "string" && FIX_LINK_ID_PATTERN.test(story.fixes.incident_id)
    ? story.fixes.incident_id
    : null;
  return { fixes: { storyId, incidentId } };
}

// The reverse link: on the corrected story, the fix stories that name it.
function withFixedBy(iteration, _index, iterations) {
  const fixedBy = iterations
    .filter((candidate) => candidate.fixes?.storyId === iteration.id)
    .map((candidate) => candidate.id)
    .sort(compareStrings);
  // Mutated in place: the canonical story ID is a non-enumerable property a copy would lose.
  if (fixedBy.length) iteration.fixedBy = fixedBy;
  return iteration;
}

function normalizeIterationDossiers(records, recordIndex, iterations, limits, diagnostics) {
  const storyRecords = new Map();
  for (const [storyId, matches] of recordIndex.entries("storyById")) {
    if (matches.length === 1) {
      storyRecords.set(storyId, matches[0]);
      continue;
    }
    diagnostics.add({
      code: "dossier_story_id_ambiguous",
      severity: "error",
      message: "Multiple canonical story records use the same ID; no dossier was built or attached for that ID.",
      provenance: "malformed",
      sourceRefs: matches.slice(0, 12).map(sourceRef),
    });
  }
  const contexts = iterations
    .map((iteration) => {
      const canonicalStoryId = iteration[ITERATION_CANONICAL_STORY_ID];
      const storyRecord = storyRecords.get(canonicalStoryId);
      if (!storyRecord) return null;
      const story = storyRecord.data;
      const requirementLinks = boundedRecordArray(
        storyRecord,
        story.links?.requirements,
        limits,
        diagnostics,
        "/links/requirements",
        "story requirement links",
      );
      const explicitRequirementIds = boundedRecordArray(
        storyRecord,
        story.requirement_ids,
        limits,
        diagnostics,
        "/requirement_ids",
        "story requirement IDs",
      );
      const requirementIds = new Set(normalizedCanonicalIdList([
        story.requirement_id,
        ...explicitRequirementIds,
        ...requirementLinks,
      ], limits));
      const requirementRefs = new Map();
      for (let index = 0; index < requirementLinks.length; index += 1) {
        const requirementId = normalizeCanonicalId(requirementLinks[index]);
        if (requirementId) {
          requirementRefs.set(requirementId, {
            ...sourceRef(storyRecord),
            pointer: `/links/requirements/${index}`,
          });
        }
      }
      for (const { record: breakdown } of recordIndex.get(
        "workBreakdownByStoryId",
        canonicalStoryId,
      )) {
        const requirementId = normalizeCanonicalId(breakdown.data.requirement_id);
        if (!requirementId) continue;
        requirementIds.add(requirementId);
        if (!requirementRefs.has(requirementId)) {
          requirementRefs.set(requirementId, {
            ...sourceRef(breakdown),
            pointer: "/requirement_id",
          });
        }
      }
      const contractIds = new Set(normalizedCanonicalIdList(story.contract_id, limits));
      for (const record of recordIndex.get("byStoryId", canonicalStoryId)) {
        if (record.kind !== "contract") continue;
        const contractId = normalizeCanonicalId(record.data.id);
        if (contractId) contractIds.add(contractId);
      }
      return {
        iteration,
        canonicalStoryId,
        storyRecord,
        requirementIds,
        requirementRefs,
        contractIds,
        placements: new Map(),
        anchors: [],
        diagnostics: [],
      };
    })
    .filter(Boolean)
    .sort((left, right) =>
      compareStrings(String(left.iteration.id), String(right.iteration.id))
      || compareStrings(left.canonicalStoryId, right.canonicalStoryId));

  const contractOwners = new Map();
  for (const context of contexts) {
    for (const contractId of context.contractIds) {
      const owners = contractOwners.get(contractId) ?? new Set();
      owners.add(context.canonicalStoryId);
      contractOwners.set(contractId, owners);
    }
  }
  const placedRecords = new WeakSet();

  const addDiagnostic = (context, payload) => {
    const normalized = {
      severity: "warning",
      provenance: "malformed",
      sourceRefs: [],
      ...payload,
    };
    diagnostics.add(normalized);
    if (context.diagnostics.length < limits.maxDiagnostics) {
      context.diagnostics.push({
        ...normalized,
        occurrences: 1,
        sourceRefs: normalized.sourceRefs.slice(0, 12).map(normalizeSourceRef),
      });
    }
  };

  const place = (context, record, via, refs, { anchor = false } = {}) => {
    const storyId = context.canonicalStoryId;
    const recordedStoryId = isRecordObject(record)
      ? normalizeCanonicalId(record.data.story_id)
      : null;
    const recordedAutonomyStoryIds = record.kind === "delivery-execution-profile"
      && isRecordObject(record)
      ? normalizedCanonicalIdList(
          boundedRecordArray(
            record,
            record.data.story_refs,
            limits,
            diagnostics,
            "/story_refs",
            "delivery story references",
          ).map((ref) => isPlainObject(ref) ? ref.id : null),
          limits,
        )
      : [];
    const conflictingStory = recordedStoryId && recordedStoryId !== storyId;
    const conflictingStoryRecord = record.kind === "story"
      && isRecordObject(record)
      && normalizeCanonicalId(record.data.id) !== storyId;
    const conflictingAutonomyStory = recordedAutonomyStoryIds.length > 0
      && !recordedAutonomyStoryIds.includes(storyId);
    if (conflictingStory || conflictingStoryRecord || conflictingAutonomyStory) {
      addDiagnostic(context, {
        code: "dossier_cross_story_link_blocked",
        message: "An explicit link targeted evidence owned by another story and was excluded.",
        sourceRefs: boundedSourceRefs(12, refs, [sourceRef(record)]),
      });
      return false;
    }
    const existing = context.placements.get(record) ?? {
      record,
      via: [],
      sourceRefs: [],
      anchor: false,
    };
    if (!existing.via.includes(via)) existing.via.push(via);
    existing.sourceRefs = uniqueSourceRefsFromGroups([
      existing.sourceRefs,
      refs,
      [sourceRef(record)],
    ], 12);
    context.placements.set(record, existing);
    placedRecords.add(record);
    if (anchor && !existing.anchor) {
      existing.anchor = true;
      context.anchors.push(existing);
    }
    return true;
  };

  const resolveUniqueId = (context, id, ref, via) => {
    const matches = recordIndex.get("byId", id);
    if (matches.length !== 1) {
      addDiagnostic(context, {
        code: matches.length === 0 ? "dossier_link_target_missing" : "dossier_link_target_ambiguous",
        message: matches.length === 0
          ? "An explicit dossier ID has no canonical target and remains unlinked."
          : "An explicit dossier ID resolves to multiple canonical records and remains unlinked.",
        sourceRefs: boundedSourceRefs(12, [ref], matches.slice(0, 11).map(sourceRef)),
      });
      return null;
    }
    return { record: matches[0], via };
  };

  for (const context of contexts) {
    const storyId = context.canonicalStoryId;
    place(
      context,
      context.storyRecord,
      "story_link",
      [{ ...sourceRef(context.storyRecord), pointer: "/id" }],
      { anchor: true },
    );

    const directAnchors = recordIndex.get("byStoryId", storyId).map((record) => ({
      record,
      via: "story_id",
      pointer: "/story_id",
    }));
    const relatedAnchors = recordIndex.get("relatedToStoryId", storyId).map((anchor) => ({
      ...anchor,
      via: "related",
    }));
    const indexedAnchors = [...directAnchors, ...relatedAnchors].sort(compareDossierAnchors);
    for (const anchor of indexedAnchors) {
      if (anchor.record === context.storyRecord) continue;
      place(
        context,
        anchor.record,
        anchor.via,
        [{ ...sourceRef(anchor.record), pointer: anchor.pointer }],
        { anchor: true },
      );
    }

    for (const contractId of [...context.contractIds].sort(compareStrings)) {
      const owners = contractOwners.get(contractId) ?? new Set();
      const contractRef = { ...sourceRef(context.storyRecord), pointer: "/contract_id" };
      if (owners.size !== 1 || !owners.has(storyId)) {
        addDiagnostic(context, {
          code: "dossier_contract_link_ambiguous",
          message: "A contract ID is owned by multiple stories and remains outside this dossier.",
          sourceRefs: [contractRef],
        });
        continue;
      }
      const resolved = resolveUniqueId(context, contractId, contractRef, "contract_id");
      if (resolved && resolved.record.kind === "contract") {
        place(context, resolved.record, resolved.via, [contractRef], { anchor: true });
      } else if (resolved) {
        addDiagnostic(context, {
          code: "dossier_contract_target_malformed",
          message: "A contract ID resolved to a non-contract record and was excluded.",
          sourceRefs: [contractRef, sourceRef(resolved.record)],
        });
      }
      for (const record of recordIndex.get("byContractId", contractId)) {
        place(
          context,
          record,
          "contract_id",
          [{ ...sourceRef(record), pointer: "/contract_id" }],
          { anchor: true },
        );
      }
    }

    for (const requirementId of [...context.requirementIds].sort(compareStrings)) {
      const ref = context.requirementRefs.get(requirementId)
        ?? { ...sourceRef(context.storyRecord), pointer: "/requirement_id" };
      const resolved = resolveUniqueId(context, requirementId, ref, "requirement_id");
      if (resolved && resolved.record.kind === "requirement") {
        place(context, resolved.record, resolved.via, [ref]);
      } else if (resolved) {
        addDiagnostic(context, {
          code: "dossier_requirement_target_malformed",
          message: "A requirement ID resolved to a non-requirement record and was excluded.",
          sourceRefs: [ref, sourceRef(resolved.record)],
        });
      }
    }

    for (const [linkName, linkValues] of Object.entries({
      decisions: boundedRecordArray(
        context.storyRecord,
        context.storyRecord.data.links?.decisions,
        limits,
        diagnostics,
        "/links/decisions",
        "story decision links",
      ),
      tests: boundedRecordArray(
        context.storyRecord,
        context.storyRecord.data.links?.tests,
        limits,
        diagnostics,
        "/links/tests",
        "story test links",
      ),
    })) {
      for (let linkIndex = 0; linkIndex < linkValues.length; linkIndex += 1) {
        const id = normalizeCanonicalId(linkValues[linkIndex]);
        if (!id) continue;
        const ref = {
          ...sourceRef(context.storyRecord),
          pointer: `/links/${linkName}/${linkIndex}`,
        };
        const resolved = resolveUniqueId(context, id, ref, "story_link");
        if (resolved) place(context, resolved.record, resolved.via, [ref]);
      }
    }

    // Autonomy records enter a dossier only through their canonical, explicit
    // reference graph. The joins below never use filenames, timestamps, text,
    // or a requirement-to-story reverse lookup.
    for (const { record, storyRefIndex } of recordIndex.get("deliveryProfileByStoryId", storyId)) {
      place(
        context,
        record,
        "story_ref",
        [{ ...sourceRef(record), pointer: `/story_refs/${storyRefIndex}` }],
        { anchor: true },
      );
    }

    const autonomyAnchors = [...context.placements.values()];
    for (const placement of autonomyAnchors) {
      const record = placement.record;
      if (!isRecordObject(record)) continue;

      if (record.kind === "requirement") {
        const profileId = normalizeCanonicalId(record.data.autonomy_profile_id);
        if (profileId) {
          const ref = { ...sourceRef(record), pointer: "/autonomy_profile_id" };
          const resolved = resolveUniqueId(context, profileId, ref, "requirement_profile_ref");
          if (resolved?.record.kind === "requirement-execution-profile") {
            place(context, resolved.record, resolved.via, [ref], { anchor: true });
          } else if (resolved) {
            addDiagnostic(context, {
              code: "dossier_autonomy_requirement_profile_malformed",
              message: "An explicit requirement autonomy profile reference resolved to the wrong record kind.",
              sourceRefs: [ref, sourceRef(resolved.record)],
            });
          }
        }
      }

      if (record.kind === "contract") {
        const requirementProfileRefs = boundedRecordArray(
          record,
          record.data.requirement_execution_profile_refs,
          limits,
          diagnostics,
          "/requirement_execution_profile_refs",
          "requirement execution profile references",
        );
        for (let index = 0; index < requirementProfileRefs.length; index += 1) {
          const profileRef = requirementProfileRefs[index];
          const profileId = isPlainObject(profileRef)
            ? normalizeCanonicalId(profileRef.id)
            : null;
          if (!profileId) continue;
          const ref = {
            ...sourceRef(record),
            pointer: `/requirement_execution_profile_refs/${index}`,
          };
          const resolved = resolveUniqueId(context, profileId, ref, "requirement_profile_ref");
          if (resolved?.record.kind === "requirement-execution-profile") {
            place(context, resolved.record, resolved.via, [ref], { anchor: true });
          } else if (resolved) {
            addDiagnostic(context, {
              code: "dossier_autonomy_requirement_profile_malformed",
              message: "A contract requirement autonomy reference resolved to the wrong record kind.",
              sourceRefs: [ref, sourceRef(resolved.record)],
            });
          }
        }

        const deliveryProfileId = normalizeCanonicalId(
          record.data.delivery_execution_profile_id,
        );
        if (deliveryProfileId) {
          const ref = { ...sourceRef(record), pointer: "/delivery_execution_profile_id" };
          const resolved = resolveUniqueId(context, deliveryProfileId, ref, "delivery_profile_ref");
          if (resolved?.record.kind === "delivery-execution-profile") {
            place(context, resolved.record, resolved.via, [ref], { anchor: true });
          } else if (resolved) {
            addDiagnostic(context, {
              code: "dossier_autonomy_delivery_profile_malformed",
              message: "A contract delivery autonomy reference resolved to the wrong record kind.",
              sourceRefs: [ref, sourceRef(resolved.record)],
            });
          }
        }
      }

      const deliveryProfileRef = record.data.delivery_profile_ref;
      if (isPlainObject(deliveryProfileRef)) {
        const profileId = normalizeCanonicalId(deliveryProfileRef.id);
        if (profileId) {
          const ref = { ...sourceRef(record), pointer: "/delivery_profile_ref" };
          const resolved = resolveUniqueId(context, profileId, ref, "delivery_profile_ref");
          if (resolved?.record.kind === "delivery-execution-profile") {
            place(context, resolved.record, resolved.via, [ref], { anchor: true });
          } else if (resolved) {
            addDiagnostic(context, {
              code: "dossier_autonomy_delivery_profile_malformed",
              message: "An explicit delivery autonomy reference resolved to the wrong record kind.",
              sourceRefs: [ref, sourceRef(resolved.record)],
            });
          }
        }
      }

      const decisionRef = record.data.autonomy_decision_ref;
      if (isPlainObject(decisionRef)) {
        const decisionId = normalizeCanonicalId(decisionRef.id);
        if (decisionId) {
          const ref = { ...sourceRef(record), pointer: "/autonomy_decision_ref" };
          const resolved = resolveUniqueId(context, decisionId, ref, "autonomy_decision_ref");
          if (resolved?.record.kind === "autonomy-decision") {
            place(context, resolved.record, resolved.via, [ref], { anchor: true });
          } else if (resolved) {
            addDiagnostic(context, {
              code: "dossier_autonomy_decision_malformed",
              message: "An explicit autonomy decision reference resolved to the wrong record kind.",
              sourceRefs: [ref, sourceRef(resolved.record)],
            });
          }
        }
      }
    }

    const linkedDeliveryProfileIds = new Set(
      [...context.placements.values()]
        .filter((placement) => placement.record.kind === "delivery-execution-profile")
        .map((placement) => normalizeCanonicalId(placement.record.data?.id))
        .filter(Boolean),
    );
    const linkedAutonomyDecisions = [...linkedDeliveryProfileIds]
      .flatMap((profileId) => recordIndex.get("autonomyDecisionByDeliveryProfileId", profileId))
      .sort(compareRecords);
    for (const record of linkedAutonomyDecisions) {
      place(
        context,
        record,
        "delivery_profile_ref",
        [{ ...sourceRef(record), pointer: "/delivery/profile_id" }],
        { anchor: true },
      );
    }
  }

  // Resolve exact related IDs from directly linked anchors only. Newly placed
  // related records are deliberately not traversed again.
  for (const context of contexts) {
    const anchorSnapshot = [...context.anchors];
    for (const placement of anchorSnapshot) {
      if (!isRecordObject(placement.record)) continue;
      const related = boundedRecordArray(
        placement.record,
        placement.record.data.related,
        limits,
        diagnostics,
        "/related",
        "related record references",
      );
      for (let relatedIndex = 0; relatedIndex < related.length; relatedIndex += 1) {
        const id = normalizeCanonicalId(related[relatedIndex]);
        if (!id || id === context.canonicalStoryId) continue;
        const ref = {
          ...sourceRef(placement.record),
          pointer: `/related/${relatedIndex}`,
        };
        const resolved = resolveUniqueId(context, id, ref, "related");
        if (resolved) place(context, resolved.record, resolved.via, [ref]);
      }
    }
  }

  // Evidence-path joins are one hop from the direct anchor set. Shared,
  // multi-record, non-canonical, or cross-story targets remain unlinked.
  const evidenceCitations = new Map();
  let evidenceCitationCount = 0;
  let evidenceCitationsTruncated = false;
  for (const context of contexts) {
    for (const placement of context.anchors) {
      for (const citation of dossierEvidenceCitations(placement.record, limits)) {
        if (!citation.valid) {
          addDiagnostic(context, {
            code: "dossier_evidence_path_noncanonical",
            message: "A non-canonical .sdlc evidence path was rejected and remains unlinked.",
            sourceRefs: [citation.sourceRef],
          });
          continue;
        }
        if (evidenceCitationCount >= limits.maxRecords) {
          evidenceCitationsTruncated = true;
          continue;
        }
        const citations = evidenceCitations.get(citation.path) ?? [];
        citations.push({ context, sourceRef: citation.sourceRef });
        evidenceCitations.set(citation.path, citations);
        evidenceCitationCount += 1;
      }
    }
  }
  if (evidenceCitationsTruncated) {
    diagnostics.add({
      code: "dossier_evidence_index_truncated",
      message: "Dossier evidence citations reached the configured global record budget; omitted citations remain unlinked.",
      provenance: "inferred",
      sourceRefs: [],
    });
  }
  for (const [evidencePath, citations] of [...evidenceCitations.entries()].sort(([left], [right]) =>
    compareStrings(left, right))) {
    const citedStoryIds = new Set(
      citations.map((citation) => citation.context.canonicalStoryId),
    );
    if (citedStoryIds.size !== 1) {
      for (const context of new Set(citations.map((citation) => citation.context))) {
        addDiagnostic(context, {
          code: "dossier_evidence_link_shared",
          message: "An evidence path is cited by multiple stories and remains outside every dossier.",
          sourceRefs: citations.slice(0, 12).map((citation) => citation.sourceRef),
        });
      }
      continue;
    }
    const context = citations[0].context;
    const targets = recordIndex.get("byPath", evidencePath);
    if (targets.some((target) => target.format === "jsonl")) {
      addDiagnostic(context, {
        code: "dossier_evidence_target_jsonl_unsupported",
        message: "A JSONL evidence path is record-ambiguous by format and remains outside the dossier.",
        sourceRefs: boundedSourceRefs(
          12,
          citations.slice(0, 12).map((citation) => citation.sourceRef),
          targets.slice(0, 12).map(sourceRef),
        ),
      });
      continue;
    }
    if (targets.length === 0 && !SUPPORTED_EXTENSIONS.has(path.extname(evidencePath).toLowerCase())) {
      // Logs and other plain files are cited as evidence but never parsed, so
      // they are not reported as missing.
      addDiagnostic(context, {
        code: "dossier_evidence_target_unparsed_format",
        message: "An evidence file in a format the Observatory does not read remains outside the dossier.",
        sourceRefs: citations.slice(0, 12).map((citation) => citation.sourceRef),
      });
      continue;
    }
    if (targets.length !== 1) {
      addDiagnostic(context, {
        code: targets.length === 0
          ? "dossier_evidence_target_missing"
          : "dossier_evidence_target_ambiguous",
        message: targets.length === 0
          ? "A canonical evidence path has no readable target and remains unlinked."
          : "A canonical evidence path resolves to multiple records and remains unlinked.",
        sourceRefs: boundedSourceRefs(
          12,
          citations.slice(0, 12).map((citation) => citation.sourceRef),
          targets.slice(0, 12).map(sourceRef),
        ),
      });
      continue;
    }
    if (!isRecordObject(targets[0])) {
      addDiagnostic(context, {
        code: "dossier_evidence_target_malformed",
        message: "An evidence path target is not a well-formed canonical object record and remains unlinked.",
        sourceRefs: boundedSourceRefs(
          12,
          citations.slice(0, 12).map((citation) => citation.sourceRef),
          [sourceRef(targets[0])],
        ),
      });
      continue;
    }
    place(
      context,
      targets[0],
      "evidence_path",
      citations.slice(0, 12).map((citation) => citation.sourceRef),
    );
  }
  for (const context of contexts) context.anchors.length = 0;

  let nestedItemCount = 0;
  let nestedTruncated = false;
  const dossiers = [];
  const byIteration = new WeakMap();
  const dossierBudget = limits.maxDossierItems ?? limits.maxCollectionItems;
  const laneLimit = limits.maxDossierLaneItems ?? Number.MAX_SAFE_INTEGER;
  for (const context of contexts) {
    const contextCapacity = Math.max(0, dossierBudget - nestedItemCount);
    const candidates = Object.fromEntries(DOSSIER_LANES.map((lane) => [
      lane,
      createBoundedDossierLane(Math.min(contextCapacity, laneLimit)),
    ]));
    const placements = [...context.placements.values()].sort((left, right) =>
      compareRecords(left.record, right.record));
    for (const placement of placements) {
      // A test trace that cites its own test-run record would list the same check twice.
      if (isTestTraceWithRunRecord(placement.record, recordIndex)) continue;
      const recordLanes = dossierLanesForRecord(placement.record);
      if (recordLanes.length > 0) {
        if (contextCapacity > 0) {
          const item = decorateDossierItem(
            itemFromRecord(placement.record, { limits, diagnostics }),
            context.iteration.id,
            placement,
          );
          for (const lane of recordLanes) candidates[lane].add(item);
        } else {
          for (const lane of recordLanes) candidates[lane].markPresent();
        }
      }
      if (placement.record.kind === "trace") {
        if (contextCapacity > 0) {
          for (const requestItem of requestItemsFromTrace(placement.record, limits)) {
            candidates.asked.add(decorateDossierItem(requestItem, context.iteration.id, placement));
          }
        } else if (hasRequestItem(placement.record)) {
          candidates.asked.markPresent();
        }
      }
      const approvalData = approvalDataFromRecord(placement.record, limits, diagnostics);
      if (contextCapacity > 0) {
        for (let approvalIndex = 0; approvalIndex < approvalData.length; approvalIndex += 1) {
          const approval = approvalItemFromRecord(
            placement.record,
            approvalData[approvalIndex],
            approvalIndex,
            limits,
            diagnostics,
          );
          candidates.decided.add(decorateDossierItem(approval, context.iteration.id, placement));
        }
      } else if (approvalData.length > 0) {
        candidates.decided.markPresent();
      }
    }

    const lanes = {};
    for (const lane of DOSSIER_LANES) {
      const remaining = Math.max(0, dossierBudget - nestedItemCount);
      const retained = candidates[lane].items();
      const items = retained.slice(0, remaining);
      nestedItemCount += items.length;
      const laneTotal = candidates[lane].total;
      if (candidates[lane].truncated || items.length < retained.length) {
        nestedTruncated = true;
        addDiagnostic(context, {
          code: "dossier_nested_items_truncated",
          message: "Dossier items were omitted by the global nested-item limit.",
          provenance: "inferred",
          sourceRefs: [sourceRef(context.storyRecord)],
        });
      }
      const status = items.length > 0
        ? "recorded"
        : candidates[lane].hasCandidates ? "malformed" : "missing";
      if (status === "missing") {
        addDiagnostic(context, {
          code: "dossier_lane_missing",
          severity: "info",
          provenance: "missing",
          message: `No explicitly linked ${lane} evidence is recorded for this dossier.`,
          sourceRefs: [sourceRef(context.storyRecord)],
        });
      }
      lanes[lane] = {
        status,
        provenance: status,
        sourceRefs: items.length > 0
          ? uniqueSourceRefsFromGroups(items.map((item) => item.sourceRefs), 12)
          : [sourceRef(context.storyRecord)],
        items,
        ...(laneTotal > items.length ? { total: laneTotal } : {}),
      };
    }
    const dossier = {
      schemaVersion: DOSSIER_SCHEMA_VERSION,
      iterationId: context.iteration.id,
      storyId: context.iteration.id,
      title: context.iteration.title,
      summary: context.iteration.summary,
      status: DOSSIER_LANES.every((lane) => lanes[lane].status === "recorded")
        ? "complete"
        : "partial",
      provenance: "recorded",
      sourceRefs: [sourceRef(context.storyRecord)],
      links: {
        requirementIds: normalizedStringList(
          [...context.requirementIds].sort(compareStrings),
          limits,
        ),
        contractIds: normalizedStringList(
          [...context.contractIds].sort(compareStrings),
          limits,
        ),
      },
      lanes,
      diagnostics: context.diagnostics.slice(0, limits.maxDiagnostics),
    };
    dossiers.push(dossier);
    byIteration.set(context.iteration, dossier);
    context.placements.clear();
    context.requirementIds.clear();
    context.requirementRefs.clear();
    context.contractIds.clear();
  }

  if (nestedTruncated) {
    diagnostics.add({
      code: "dossier_nested_items_truncated",
      message: "The global dossier nested-item limit was reached.",
      provenance: "inferred",
      sourceRefs: [],
    });
  }

  const unlinkedItems = createBoundedSortedItemCollector(
    limits.maxCollectionItems,
    compareDossierItems,
  );
  for (const record of records) {
    if (!hasDossierSurface(record) || placedRecords.has(record)) continue;
    diagnostics.add({
      code: "dossier_record_unlinked",
      severity: "info",
      message: "A dossier-relevant canonical record has no explicit story linkage and remains project-level.",
      provenance: "missing",
      sourceRefs: [sourceRef(record)],
    });
    unlinkedItems.add({
      ...itemFromRecord(record, { limits, diagnostics }),
      linkage: {
        status: "unlinked",
        storyId: null,
        via: [],
        sourceRefs: [],
      },
    });
  }
  const unlinked = unlinkedItems.finish();

  return { dossiers, byIteration, unlinked };
}

function dossierEvidenceCitations(record, limits) {
  if (!isRecordObject(record)) return [];
  const citations = [];
  const append = (values, pointerPrefix) => {
    const bounded = asArray(values).slice(0, limits.maxCollectionItems);
    for (let index = 0; index < bounded.length; index += 1) {
      const value = bounded[index];
      const candidate = typeof value === "string"
        ? value
        : isPlainObject(value) ? value.path : null;
      if (typeof candidate !== "string" || !candidate.startsWith(".sdlc")) continue;
      citations.push({
        path: candidate,
        sourceRef: { ...sourceRef(record), pointer: `${pointerPrefix}/${index}` },
        valid: isCanonicalDossierEvidencePath(candidate),
      });
    }
  };
  append(record.data.evidence, "/evidence");
  if (isPlainObject(record.data.narrative)) append(record.data.narrative.evidence, "/narrative/evidence");
  return citations;
}

function isCanonicalDossierEvidencePath(value) {
  if (typeof value !== "string" || !value.startsWith(".sdlc/") || value.includes("\\")) {
    return false;
  }
  const segments = value.split("/");
  return segments.length > 2 && segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function dossierLanesForRecord(record) {
  if (!record) return [];
  const lanes = [];
  if (["story", "requirement"].includes(record.kind)) lanes.push("asked");
  if (
    [
      "decision",
      "assumption",
      "risk",
      "requirement-execution-profile",
      "delivery-execution-profile",
      "autonomy-decision",
    ].includes(record.kind)
    || (record.kind === "trace" && isDecisionTrace(record.data))
  ) {
    lanes.push("decided");
  }
  if (record.kind === "contract") lanes.push("contract");
  if (
    ["story-step", "story-artifact", "handoff", "output-contract"].includes(record.kind)
    || (record.kind === "trace" && ["implementation", "handoff", "sync"].includes(record.data?.type))
  ) {
    lanes.push("done");
  }
  if (isVerificationRecord(record)) lanes.push("verified");
  if (
    record.kind === "story-step"
    && ["completed", "complete", "done", "passed"].includes(record.data?.status)
  ) {
    lanes.push("verified");
  }
  return [...new Set(lanes)];
}

function hasDossierSurface(record) {
  return dossierLanesForRecord(record).length > 0
    || (record.kind === "trace"
      && isPlainObject(record.data?.request)
      && typeof record.data.request.summary === "string"
      && record.data.request.summary.trim() !== "");
}

function decorateDossierItem(item, storyId, placement) {
  return {
    ...item,
    storyId,
    requirementId: item.requirementId ?? null,
    requirementIds: item.requirementIds ?? [],
    contractId: item.contractId ?? null,
    related: item.related ?? [],
    linkage: {
      status: "linked",
      storyId,
      via: [...placement.via].sort(compareStrings),
      sourceRefs: uniqueSourceRefs(placement.sourceRefs, 12),
    },
  };
}

function compareDossierItems(left, right) {
  const fields = [
    [String(left.timestamp ?? ""), String(right.timestamp ?? ""), true],
    [String(left.id ?? ""), String(right.id ?? "")],
    [String(left.type ?? ""), String(right.type ?? "")],
    [String(left.sourceRefs?.[0]?.path ?? ""), String(right.sourceRefs?.[0]?.path ?? "")],
    [String(left.sourceRefs?.[0]?.line ?? ""), String(right.sourceRefs?.[0]?.line ?? "")],
    [String(left.sourceRefs?.[0]?.pointer ?? ""), String(right.sourceRefs?.[0]?.pointer ?? "")],
  ];
  for (const [leftValue, rightValue, descending = false] of fields) {
    const compared = compareStrings(leftValue, rightValue);
    if (compared !== 0) return descending ? -compared : compared;
  }
  return 0;
}

function createBoundedDossierLane(capacity) {
  const retained = [];
  const byKey = new Map();
  let sequence = 0;
  let hasCandidates = false;
  let truncated = false;
  const seenKeys = new Set();

  const insert = (candidate) => {
    let low = 0;
    let high = retained.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (compareDossierCandidates(retained[middle], candidate) <= 0) low = middle + 1;
      else high = middle;
    }
    retained.splice(low, 0, candidate);
  };

  return {
    add(item) {
      hasCandidates = true;
      const key = dossierItemKey(item);
      seenKeys.add(key);
      if (capacity === 0) {
        truncated = true;
        return;
      }
      const candidate = {
        item,
        key,
        sequence: sequence++,
      };
      const existing = byKey.get(candidate.key);
      if (existing) {
        if (compareDossierCandidates(candidate, existing) >= 0) return;
        retained.splice(retained.indexOf(existing), 1);
      }
      insert(candidate);
      byKey.set(candidate.key, candidate);
      if (retained.length <= capacity) return;
      truncated = true;
      const removed = retained.pop();
      if (byKey.get(removed.key) === removed) byKey.delete(removed.key);
    },
    markPresent() {
      hasCandidates = true;
      if (capacity === 0) truncated = true;
    },
    items() {
      return retained.map((candidate) => candidate.item);
    },
    get hasCandidates() {
      return hasCandidates;
    },
    get truncated() {
      return truncated;
    },
    get total() {
      return seenKeys.size;
    },
  };
}

function compareDossierCandidates(left, right) {
  return compareDossierItems(left.item, right.item) || left.sequence - right.sequence;
}

function dossierItemKey(item) {
  const ref = item.sourceRefs?.[0] ?? {};
  return JSON.stringify([
    item.type,
    item.id,
    ref.path ?? null,
    ref.line ?? null,
    ref.pointer ?? null,
  ]);
}

function uniqueSourceRefs(refs, limit) {
  const seen = new Set();
  const unique = [];
  for (const raw of refs) {
    if (!raw?.path) continue;
    const ref = normalizeSourceRef(raw);
    const fingerprint = sourceRefFingerprint(ref);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    unique.push(ref);
    if (unique.length >= limit) break;
  }
  return unique;
}

function normalizePhaseState({ phase, currentPhase, story, storyRecord, taskStarts, claims, steps, traces }) {
  const step = steps.find((record) => phaseFromStep(record) === phase);
  // A check that could not run is a test result, not a blocked story.
  const blockedTrace = traces.find((record) => record.data.outcome === "blocked"
    && !isTestTrace(record)
    && (!record.data.phase || record.data.phase === phase));
  if (blockedTrace || (currentPhase === phase && story.status === "blocked")) {
    return {
      phase,
      status: "blocked",
      provenance: "recorded",
      sourceRefs: [sourceRef(blockedTrace ?? storyRecord)],
    };
  }
  if (step && !["blocked", "failed"].includes(step.data.status)) {
    return {
      phase,
      status: "complete",
      provenance: "recorded",
      sourceRefs: [sourceRef(step)],
    };
  }
  if (currentPhase === phase && ["completed", "complete", "done"].includes(story.status)) {
    return {
      phase,
      status: "complete",
      provenance: "inferred",
      sourceRefs: [sourceRef(storyRecord)],
    };
  }

  const confirmedStart = taskStarts.find((record) => record.data.phase === phase && record.data.status === "confirmed");
  const activeClaim = claims.find((record) => record.data.status === "active");
  const explicitActive = currentPhase === phase && ["active", "in_progress", "in-progress"].includes(story.status);
  if (currentPhase === phase && (confirmedStart || activeClaim || explicitActive)) {
    return {
      phase,
      status: "inProgress",
      provenance: explicitActive ? "recorded" : "inferred",
      sourceRefs: [sourceRef(confirmedStart ?? activeClaim ?? storyRecord)],
    };
  }
  return {
    phase,
    status: "missing",
    provenance: "missing",
    sourceRefs: currentPhase === phase ? [sourceRef(storyRecord)] : [],
  };
}

const STORY_CLOSURE_EVENTS = Object.freeze(new Set(["superseded", "cancelled"]));

// A recorded closure (story supersede or cancel) ends the story; the
// replacements, when there are any, are linked so readers can follow them. A
// story split into several stories names each of them and no single one.
function storyClosure(records) {
  const record = records.find((candidate) => STORY_CLOSURE_EVENTS.has(candidate.data?.event));
  if (!record) return null;
  const plain = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);
  const replacementId = plain(record.data.replacement_id);
  const replacementIds = Array.isArray(record.data.replacement_ids)
    ? [...new Set(record.data.replacement_ids.map(plain).filter(Boolean))]
    : replacementId ? [replacementId] : [];
  const reason = plain(record.data.subject?.reason);
  return { event: record.data.event, replacementId, replacementIds, reason, sourceRefs: [sourceRef(record)] };
}

// A person set the story aside (story park) while the latest park record is
// not followed by a resume.
function storyParking(records) {
  const latest = records
    .filter((record) => ["park", "resume"].includes(record.data?.action))
    .sort((left, right) => String(left.data.created_at ?? "").localeCompare(String(right.data.created_at ?? "")))
    .at(-1);
  if (latest?.data?.action !== "park") return null;
  const plain = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);
  return { reason: plain(latest.data.reason), parkedAt: plain(latest.data.created_at), sourceRefs: [sourceRef(latest)] };
}

// The latest passed lifecycle-complete final receipt of the story, checked
// with the CLI freshness rule: "current" while no later test or release
// record exists, otherwise "stale" with the newest record that outdates it.
function storyCertification(receipts, traces) {
  const latest = receipts
    .filter((record) => record.data.lifecycle_complete === true && record.data.status === "passed")
    .sort((left, right) => String(left.data.checked_at ?? "").localeCompare(String(right.data.checked_at ?? "")))
    .at(-1);
  if (!latest) return null;
  const newer = lifecycleEventsAfterCertification(traces.map((record) => record.data), latest.data.checked_at);
  if (newer === null) return null;
  const certifiedAt = latest.data.checked_at;
  if (!newer.length) return { state: "current", certifiedAt, sourceRefs: [sourceRef(latest)] };
  const newest = [...newer].sort((left, right) => String(left.created_at ?? "").localeCompare(String(right.created_at ?? ""))).at(-1);
  const newestRecord = traces.find((record) => record.data === newest);
  return {
    state: "stale",
    certifiedAt,
    newerRecord: {
      id: typeof newest.id === "string" ? newest.id : null,
      type: newest.type,
      createdAt: typeof newest.created_at === "string" ? newest.created_at : null,
    },
    newerCount: newer.length,
    sourceRefs: [sourceRef(latest), ...(newestRecord ? [sourceRef(newestRecord)] : [])],
  };
}

// A claim still active but past its expiry: nobody released it, so a person decides.
function expiredClaim(records, now) {
  const record = records.find((candidate) => candidate.data?.status === "active" && !isActiveClaim(candidate, now));
  if (!record) return null;
  return { agent: record.data.agent ?? null, expiresAt: record.data.expires_at ?? null };
}

function isActiveClaim(record, now) {
  if (record.data?.status !== "active") return false;
  const expires = Date.parse(record.data.expires_at ?? "");
  return !Number.isFinite(expires) || !Number.isFinite(now) || expires > now;
}

function phaseFromStep(record) {
  if (SDLC_PHASES.includes(record.data.phase)) return record.data.phase;
  if (SDLC_PHASES.includes(record.data.step)) return record.data.step;
  const name = path.posix.basename(record.path, path.posix.extname(record.path));
  return SDLC_PHASES.includes(name) ? name : null;
}

function storyIdFromPath(publicPath) {
  return publicPath.match(/^\.sdlc\/stories\/([^/]+)\//)?.[1] ?? null;
}

function normalizeSemanticObservations(records, limits, diagnostics) {
  const traces = records.filter((record) => record.kind === "trace" && isRecordObject(record));
  const linkIndex = buildSemanticObservationLinkIndex(traces, limits, diagnostics);
  const projected = records
    .filter((record) => record.kind === "semantic-observation")
    .flatMap((record) => {
      if (!isIntentAbiObservationPath(record.path)) {
        diagnostics.add({
          code: "intentabi_observation_path_noncanonical",
          message: "An IntentABI envelope outside .sdlc/observations/intentabi was not added to the semantic observation view.",
          provenance: "malformed",
          sourceRefs: [{ path: INTENTABI_REDACTED_OBSERVATION_PATH }],
        });
        return [];
      }
      const projection = projectIntentAbiCodexEnvelope(record.data);
      if (!projection) {
        diagnostics.add({
          code: "intentabi_envelope_malformed",
          severity: "error",
          message: "An IntentABI envelope failed strict validation and its content was omitted.",
          provenance: "malformed",
          sourceRefs: [sourceRef(record)],
        });
        return [];
      }

      if (!isCanonicalIntentAbiObservationPath(record.path, projection.eventId)) {
        diagnostics.add({
          code: "intentabi_observation_path_noncanonical",
          severity: "error",
          message: "An IntentABI envelope did not use the canonical event-ID JSON path and was omitted.",
          provenance: "malformed",
          sourceRefs: [sourceRef(record)],
        });
        return [];
      }

      const link = explicitSemanticObservationLink(record, linkIndex, limits, diagnostics);
      return [{
        id: projection.eventId,
        type: "intentabi-codex-shadow",
        title: "IntentABI shadow observation",
        summary: "Content-free IntentABI shadow evidence.",
        status: projection.outcome,
        phase: null,
        action: null,
        intent: null,
        timestamp: null,
        provenance: "recorded",
        sourceRefs: [sourceRef(record), ...link.sourceRefs],
        rawHref: rawHref(record.path),
        mode: projection.mode,
        submitted: projection.submitted,
        outcome: projection.outcome,
        reason: projection.reason,
        proof: projection.proof,
        macStatus: projection.macStatus,
        link,
      }];
    });

  return projected;
}

function buildSemanticObservationLinkIndex(traces, limits, diagnostics) {
  const index = new Map();
  const truncatedSourceRefs = [];
  let inspected = 0;
  let truncated = false;

  for (const trace of traces) {
    const evidence = Array.isArray(trace.data.evidence) ? trace.data.evidence : [];
    const recordLimit = Math.min(evidence.length, limits.maxCollectionItems);
    if (evidence.length > recordLimit) {
      truncated = true;
      if (truncatedSourceRefs.length < 12) truncatedSourceRefs.push(sourceRef(trace));
    }
    for (let evidenceIndex = 0; evidenceIndex < recordLimit; evidenceIndex += 1) {
      if (inspected >= limits.maxRecords) {
        truncated = true;
        if (truncatedSourceRefs.length < 12) truncatedSourceRefs.push(sourceRef(trace));
        break;
      }
      inspected += 1;
      const reference = evidence[evidenceIndex];
      if (typeof reference !== "string" || !isIntentAbiObservationPath(reference)) continue;
      const matches = index.get(reference) ?? [];
      matches.push({
        storyId: normalizeCanonicalId(trace.data.story_id),
        traceId: normalizeCanonicalId(trace.data.id),
        sourceRef: { ...sourceRef(trace), pointer: `/evidence/${evidenceIndex}` },
      });
      index.set(reference, matches);
    }
    if (inspected >= limits.maxRecords && truncated) break;
  }

  if (truncated) {
    diagnostics.add({
      code: "intentabi_link_index_truncated",
      message: "IntentABI trace-link indexing reached its configured evidence-reference limit; omitted links remain unlinked.",
      provenance: "inferred",
      sourceRefs: truncatedSourceRefs,
    });
  }
  return index;
}

function explicitSemanticObservationLink(record, linkIndex, limits, diagnostics) {
  const indexedMatches = linkIndex.get(record.path) ?? [];
  const incomplete = indexedMatches.filter((match) => !match.storyId || !match.traceId);
  if (incomplete.length > 0) {
    diagnostics.add({
      code: "intentabi_link_incomplete",
      message: "A trace cites an IntentABI envelope without both a story ID and trace ID; that link was ignored.",
      provenance: "malformed",
      sourceRefs: boundedSourceRefs(
        12,
        [sourceRef(record)],
        incomplete.slice(0, 11).map((match) => match.sourceRef),
      ),
    });
  }
  const matches = indexedMatches.filter((match) => match.storyId && match.traceId);

  const storyIds = [...new Set(matches.map((match) => match.storyId))];
  if (storyIds.length !== 1) {
    if (storyIds.length > 1) {
      diagnostics.add({
        code: "intentabi_story_link_ambiguous",
        message: "An IntentABI envelope is referenced by traces from multiple stories and remains unlinked.",
        provenance: "malformed",
        sourceRefs: boundedSourceRefs(
          12,
          [sourceRef(record)],
          matches.slice(0, 11).map((match) => match.sourceRef),
        ),
      });
    }
    return {
      status: "unlinked",
      storyId: null,
      traceIds: [],
      sourceRefs: [],
    };
  }

  const linked = matches.filter((match) => match.storyId === storyIds[0]);
  return {
    status: "linked",
    storyId: boundedText(storyIds[0], limits.maxTextChars).value,
    traceIds: normalizedStringList(
      [...new Set(linked.map((match) => match.traceId))],
      limits,
    ),
    sourceRefs: linked.slice(0, limits.maxCollectionItems).map((match) => match.sourceRef),
  };
}

function isDecisionTrace(data) {
  return isPlainObject(data)
    && (data.type === "decision" || (data.type === "gate" && String(data.action ?? "").includes("approve")));
}

// A test run shows its verdict and counters, so a reader sees "Passed 12/12".
function testRunFields(record, data) {
  if (record.kind !== "test" && !isTestTrace(record)) return {};
  const totals = isPlainObject(data.totals) ? data.totals : {};
  const counter = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
  const passed = counter(totals.passed);
  const failed = counter(totals.failed);
  const skipped = counter(totals.skipped);
  return {
    verdict: testVerdict(data.outcome ?? data.status),
    ...(passed !== null || failed !== null || skipped !== null
      ? { testTotals: { passed: passed ?? 0, failed: failed ?? 0, skipped: skipped ?? 0 } }
      : {}),
  };
}

function isTestTrace(record) {
  return record?.kind === "trace"
    && (record.data?.type === "test" || record.data?.action === "test.record");
}

// The trace of a recorded test run cites the test-run record, which carries
// the same check with its totals; only the test-run record is shown.
function isTestTraceWithRunRecord(record, recordIndex) {
  if (!isTestTrace(record) || !isRecordObject(record)) return false;
  return asArray(record.data.evidence).some((entry) => typeof entry === "string"
    && recordIndex.get("byPath", entry).some((candidate) => candidate?.kind === "test" && isRecordObject(candidate)));
}

const TEST_PASSED_OUTCOMES = new Set(["passed", "pass", "success", "succeeded", "green", "ok"]);
const TEST_FAILED_OUTCOME = /fail|error|broken/u;

function testVerdict(outcome) {
  const value = String(outcome ?? "").trim().toLowerCase();
  if (TEST_PASSED_OUTCOMES.has(value)) return "passed";
  if (TEST_FAILED_OUTCOME.test(value)) return "failed";
  return "notRun";
}

function readableName(value, limits) {
  const text = boundedText(value, Math.min(limits.maxTextChars, 120)).value;
  return text && !/@/u.test(text) ? text : null;
}

function pullRequestFacts(data) {
  const facts = {};
  const assign = (key, value) => {
    if (value !== undefined && value !== null && value !== "") facts[key] = value;
  };
  if (isPlainObject(data.action_details)) {
    const details = data.action_details;
    const pr = isPlainObject(details.pull_request) ? details.pull_request : {};
    if (Number.isSafeInteger(pr.pr_number)) assign("number", pr.pr_number);
    assign("url", typeof pr.pr_url === "string" ? pr.pr_url : details.merge?.pr_url);
    assign("branch", typeof details.head_branch === "string" ? details.head_branch : null);
    return facts;
  }
  if (Number.isSafeInteger(data.number)) assign("number", data.number);
  if (typeof data.url === "string") assign("url", data.url);
  if (typeof data.headRefName === "string") assign("branch", data.headRefName);
  if (typeof data.mergeCommit?.oid === "string") assign("mergeSha", data.mergeCommit.oid);
  if (typeof data.mergedAt === "string") assign("mergedAt", normalizeOptionalTimestamp(data.mergedAt));
  return facts;
}

// What the delivery of a story produced, read from the structured
// pull_request.create/merge records and the provider output they cite.
function storyDelivery(storyTraces, recordIndex) {
  const completed = (action) => storyTraces
    .filter((record) => record.data.action === action && record.data.outcome === "passed")
    .sort(compareRecords);
  const creates = completed("pull_request.create");
  const merges = completed("pull_request.merge");
  const last = merges.at(-1) ?? creates.at(-1);
  if (!last) return null;
  const facts = {};
  for (const trace of [...creates, ...merges]) {
    for (const entry of asArray(trace.data.evidence)) {
      if (typeof entry !== "string") continue;
      for (const evidence of recordIndex.get("byPath", entry)) {
        if (isRecordObject(evidence)) Object.assign(facts, pullRequestFacts(evidence.data));
      }
    }
  }
  const number = facts.number
    ?? Number(/\/pull\/(\d+)/u.exec(String(facts.url ?? ""))?.[1] ?? Number.NaN);
  return {
    state: merges.length ? "merged" : "open",
    number: Number.isSafeInteger(number) ? number : null,
    url: typeof facts.url === "string" && /^https:\/\//u.test(facts.url) ? facts.url : null,
    branch: facts.branch ?? (typeof last.data.git?.branch === "string" ? last.data.git.branch : null),
    mergeSha: merges.length && /^[0-9a-f]{7,64}$/u.test(String(facts.mergeSha ?? "")) ? facts.mergeSha : null,
    at: (merges.length ? facts.mergedAt : null) ?? normalizeOptionalTimestamp(last.data.created_at),
    sourceRefs: [sourceRef(last)],
  };
}

function storyTestVerdict(storyTests, storyTraces, recordIndex) {
  const counts = { passed: 0, failed: 0, notRun: 0, total: 0 };
  const count = (outcome) => {
    counts[testVerdict(outcome)] += 1;
    counts.total += 1;
  };
  for (const record of storyTests) count(record.data.outcome ?? record.data.status);
  for (const record of storyTraces) {
    if (isTestTrace(record) && !isTestTraceWithRunRecord(record, recordIndex)) count(record.data.outcome);
  }
  return counts;
}

// The few facts a reader needs first: what was asked, what was delivered,
// how the checks went, and who did it. Every value comes from a record.
function storyBrief({ story, storyClaims, storyTraces, storyTests, recordIndex, limits }) {
  const requirementId = normalizeCanonicalId(story.requirement_id
    ?? asArray(story.requirement_ids)[0]
    ?? asArray(story.links?.requirements)[0]
    ?? asArray(story.requirement_refs)[0]?.id);
  const requirement = requirementId
    ? recordIndex.get("byId", requirementId).find((record) => record.kind === "requirement" && isRecordObject(record))
    : null;
  const text = (value) => boundedText(value, limits.maxTextChars).value;
  const audit = isPlainObject(story.audit) ? story.audit : {};
  const creator = isPlainObject(audit.created_by) ? audit.created_by : {};
  const claim = [...storyClaims].filter(isRecordObject).sort(compareRecords).at(-1);
  const approvers = [...new Set(storyTraces
    .filter((record) => record.data.actor?.type === "human")
    .map((record) => readableName(record.data.actor.name, limits))
    .filter(Boolean))];
  return {
    asked: {
      title: text(story.title),
      summary: text(story.summary ?? story.description ?? requirement?.data.summary ?? requirement?.data.statement),
      requirementId,
      requirementTitle: requirement ? text(requirement.data.title) : null,
    },
    delivery: storyDelivery(storyTraces, recordIndex),
    tests: storyTestVerdict(storyTests, storyTraces, recordIndex),
    who: {
      person: readableName(audit.git?.user?.name, limits)
        ?? (creator.type === "human" ? readableName(creator.name, limits) : null),
      agent: creator.type === "agent" ? readableName(creator.name, limits) : null,
      computer: claim?.data.agent === "agent" ? null : readableName(claim?.data.agent, limits),
      approvers: approvers.slice(0, 5),
    },
  };
}

function isVerificationRecord(record) {
  if (!isRecordObject(record)) return false;
  if (["test", "release"].includes(record.kind)) return true;
  if (record.kind === "report") {
    return /gate|test|validation|release/i.test(record.path);
  }
  return record.kind === "trace" && ["test", "gate", "release"].includes(record.data.type);
}

function buildSnapshots(collections, completeCounts = {}) {
  const phaseCounts = Object.fromEntries(SDLC_PHASES.map((phase) => [
    phase,
    { complete: 0, inProgress: 0, blocked: 0, missing: 0 },
  ]));
  for (const iteration of collections.iterations) {
    for (const phase of iteration.phases) {
      phaseCounts[phase.phase][phase.status] += 1;
    }
  }

  return {
    counts: {
      iterations: completeCounts.iterations ?? collections.iterations.length,
      contracts: completeCounts.contracts ?? collections.contracts.length,
      decisions: completeCounts.decisions ?? collections.decisions.length,
      changes: completeCounts.changes ?? collections.changes.length,
      verification: completeCounts.verification ?? collections.verification.length,
      semanticObservations: completeCounts.semanticObservations
        ?? collections.semanticObservations.length,
      dossiers: completeCounts.dossiers ?? collections.dossiers.length,
      unlinked: completeCounts.unlinked ?? collections.unlinked.length,
      records: completeCounts.records ?? collections.records.length,
    },
    phaseCounts,
    provenance: "inferred",
    sourceRefs: firstItemSourceRefs(collections.iterations, 50),
  };
}

function firstItemSourceRefs(items, limit) {
  const refs = [];
  for (const item of items) {
    for (const ref of item.sourceRefs) {
      refs.push(ref);
      if (refs.length >= limit) return refs;
    }
  }
  return refs;
}

function collectBoundedPublicRecords(records, limits) {
  const items = [];
  let total = 0;
  for (const record of records) {
    if (items.length >= limits.maxCollectionItems) {
      if (isPublicRecordVisible(record)) total += 1;
      continue;
    }
    const item = publicRecordMetadata(record, limits);
    if (!item) continue;
    total += 1;
    items.push(item);
  }
  return {
    items,
    total,
    truncated: total > items.length,
  };
}

function isPublicRecordVisible(record) {
  if (!isIntentAbiCodexEnvelopeCandidate(record.data, record.path)) return true;
  const projection = projectIntentAbiCodexEnvelope(record.data);
  return isCanonicalIntentAbiObservationPath(record.path, projection?.eventId ?? null);
}

function publicRecordMetadata(record, limits) {
  const intentAbiCandidate = isIntentAbiCodexEnvelopeCandidate(record.data, record.path);
  const intentAbiProjection = intentAbiCandidate ? projectIntentAbiCodexEnvelope(record.data) : null;
  if (
    intentAbiCandidate
    && !isCanonicalIntentAbiObservationPath(record.path, intentAbiProjection?.eventId ?? null)
  ) {
    return null;
  }
  const data = intentAbiCandidate
    ? intentAbiProjection
      ? { id: intentAbiProjection.eventId, status: intentAbiProjection.outcome }
      : null
    : isPlainObject(record.data) ? record.data : null;
  const displayDefaults = autonomyDisplayDefaults(record, data);
  const id = boundedText(data?.id ?? data?.story_id ?? data?.contract_id, limits.maxTextChars);
  const title = boundedText(data?.title ?? data?.name ?? displayDefaults.title, limits.maxTextChars);
  const summary = boundedText(
    data?.summary ?? data?.purpose ?? displayDefaults.summary,
    limits.maxTextChars,
  );
  const rawAvailable = record.sizeBytes <= limits.maxSourceBytes
    && (!intentAbiCandidate || intentAbiProjection !== null);
  return {
    id: id.value ?? fallbackRecordId(record),
    type: record.kind,
    kind: record.kind,
    title: title.value ?? id.value,
    summary: summary.value,
    status: boundedText(
      data?.status ?? data?.outcome ?? displayDefaults.status,
      limits.maxTextChars,
    ).value,
    phase: boundedText(data?.phase, limits.maxTextChars).value,
    timestamp: normalizeOptionalTimestamp(
      data?.created_at ?? data?.updated_at ?? data?.evaluated_at,
    ),
    path: publicSourcePath(record.path),
    line: record.line,
    format: record.format,
    schemaVersion: boundedText(data?.schema_version, limits.maxTextChars).value,
    sizeBytes: record.sizeBytes,
    provenance: intentAbiCandidate && !intentAbiProjection ? "malformed" : record.provenance,
    sourceRefs: [sourceRef(record)],
    rawHref: rawAvailable ? rawHref(record.path) : null,
    rawAvailable,
    textTruncated: id.truncated || title.truncated || summary.truncated,
  };
}

function boundCollectionInPlace(items, limit) {
  const total = items.length;
  if (items.length > limit) items.length = limit;
  return { items, total, truncated: total > items.length };
}

function reportCollectionTruncated(diagnostics, label) {
  diagnostics.add({
    code: "collection_truncated",
    message: `The ${label} collection was truncated by the configured item limit.`,
    sourceRefs: [],
  });
}

function createFirstUniqueItemCollector(limit) {
  const seen = new Set();
  const items = [];
  let truncated = false;
  return {
    add(item) {
      const key = summaryItemKey(item);
      if (seen.has(key)) return;
      if (items.length >= limit) {
        truncated = true;
        return;
      }
      seen.add(key);
      items.push(item);
    },
    finish() {
      seen.clear();
      return { items, total: items.length + (truncated ? 1 : 0), truncated };
    },
  };
}

function summaryItemKey(item) {
  return `${item.type}\u0000${item.summary ?? item.title ?? item.id}\u0000${item.sourceRefs[0]?.path ?? ""}`;
}

function createBoundedSortedItemCollector(limit, compareItems = compareSortedItems) {
  const retained = [];
  let sequence = 0;
  let total = 0;
  return {
    add(item) {
      const candidate = { item, sequence: sequence++ };
      total += 1;
      let low = 0;
      let high = retained.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (compareItemCandidates(retained[middle], candidate, compareItems) <= 0) {
          low = middle + 1;
        }
        else high = middle;
      }
      retained.splice(low, 0, candidate);
      if (retained.length > limit) retained.pop();
    },
    finish() {
      const items = retained.map((candidate) => candidate.item);
      retained.length = 0;
      return { items, total, truncated: total > items.length };
    },
  };
}

function createBoundedRankedItemCollector(limit, role, overrides) {
  const compactAt = limit > Math.floor(Number.MAX_SAFE_INTEGER / 2)
    ? Number.MAX_SAFE_INTEGER
    : limit * 2;
  let candidates = [];
  let total = 0;
  return {
    add(item) {
      candidates.push(item);
      total += 1;
      if (candidates.length < compactAt) return;
      candidates = rankSummaryItems(candidates, role, overrides).slice(0, limit);
    },
    finish() {
      const items = rankSummaryItems(candidates, role, overrides).slice(0, limit);
      candidates = [];
      return { items, total, truncated: total > items.length };
    },
  };
}

function compareSortedItems(left, right) {
  const byTimestamp = compareStrings(String(right.timestamp ?? ""), String(left.timestamp ?? ""));
  if (byTimestamp !== 0) return byTimestamp;
  return compareStrings(String(left.id), String(right.id));
}

function compareItemCandidates(left, right, compareItems) {
  return compareItems(left.item, right.item) || left.sequence - right.sequence;
}

function sortItemsInPlace(items) {
  return items.sort(compareSortedItems);
}

function compareRecords(left, right) {
  const byPath = compareStrings(left.path, right.path);
  if (byPath !== 0) return byPath;
  return (left.line ?? 0) - (right.line ?? 0);
}

function compareDossierAnchors(left, right) {
  const byRecord = compareRecords(left.record, right.record);
  if (byRecord !== 0) return byRecord;
  if (left.via !== right.via) return left.via === "story_id" ? -1 : 1;
  const leftIndex = Number(left.pointer.match(/\/(\d+)$/u)?.[1] ?? 0);
  const rightIndex = Number(right.pointer.match(/\/(\d+)$/u)?.[1] ?? 0);
  return leftIndex - rightIndex;
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sourceRef(record) {
  return normalizeSourceRef({ path: record.path, line: record.line ?? undefined });
}

function normalizeSourceRef(value) {
  const normalized = { path: publicSourcePath(value.path) };
  if (Number.isSafeInteger(value.line) && value.line > 0) normalized.line = value.line;
  if (typeof value.pointer === "string" && value.pointer !== "") normalized.pointer = value.pointer;
  return normalized;
}

function rawHref(publicPath) {
  return `/api/v1/source?path=${encodeURIComponent(publicPath)}`;
}

function fallbackRecordId(record) {
  return `${record.kind}:${publicSourcePath(record.path)}${record.line ? `:${record.line}` : ""}`;
}

function normalizeCanonicalId(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized === "" ? null : normalized;
}

function normalizedCanonicalIdList(value, limits) {
  const seen = new Set();
  const normalized = [];
  for (const item of asArray(value).slice(0, limits.maxCollectionItems)) {
    const id = normalizeCanonicalId(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    normalized.push(id);
  }
  return normalized;
}

function publicSourcePath(publicPath) {
  if (isIntentAbiObservationPath(publicPath) && !isCanonicalIntentAbiObservationPath(publicPath)) {
    return INTENTABI_REDACTED_OBSERVATION_PATH;
  }
  return publicPath;
}

function resolveRedactionPolicy(options) {
  if (options.redactionPolicy !== undefined) return options.redactionPolicy;
  if (options.redaction !== undefined) return createRedactionPolicy(options.redaction);
  return DEFAULT_OPERATIONAL_REDACTION_POLICY;
}

function redactAndFinalizePresentationFields(root, policy) {
  const seen = new WeakSet();
  const stack = [root];
  const shortTextCache = new Map();
  let redactions = 0;
  let limited = false;
  const presentText = (value) => {
    if (value.length > 512) return redactText(value, policy);
    const cached = shortTextCache.get(value);
    if (cached !== undefined) return cached;
    const presented = redactText(value, policy);
    if (shortTextCache.size < 4_096) shortTextCache.set(value, presented);
    return presented;
  };

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    for (const key in current) {
      if (!Object.hasOwn(current, key)) continue;
      const value = current[key];
      if (typeof value === "string") {
        const presented = presentText(value);
        if (presented !== value) {
          current[key] = presented;
          if (key === "path") current.rawAvailable = false;
          redactions += 1;
          if (presented === REDACTION_LIMIT_PLACEHOLDER) limited = true;
        }
        continue;
      }
      if (value !== null && typeof value === "object") stack.push(value);
    }
    if (Object.hasOwn(current, "rawHref")) {
      let source = null;
      if (Array.isArray(current.sourceRefs)) {
        for (const candidate of current.sourceRefs) {
          if (typeof candidate?.path !== "string") continue;
          source = candidate;
          break;
        }
      }
      if (source) {
        const originalPath = source.path;
        const presentedPath = presentText(originalPath);
        if (presentedPath !== originalPath) {
          source.path = presentedPath;
          source.rawAvailable = false;
          redactions += 1;
          if (presentedPath === REDACTION_LIMIT_PLACEHOLDER) limited = true;
        }
      }
      const available = current.rawHref !== null
        && current.rawAvailable !== false
        && source?.rawAvailable !== false
        && isCanonicalPresentedSourcePath(source?.path);
      current.rawHref = available ? rawHref(source.path) : null;
      if (!available && (current.rawAvailable === false || source?.rawAvailable === false)) {
        current.rawAvailable = false;
      }
    }

  }

  return { redactions, limited };
}

function isCanonicalPresentedSourcePath(value) {
  if (
    typeof value !== "string"
    || !value.startsWith(".sdlc/")
    || value.includes("\0")
    || value.includes("\\")
  ) {
    return false;
  }
  const segments = value.split("/");
  return segments.length > 1
    && segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function boundedText(value, maxChars) {
  if (typeof value !== "string") return { value: null, truncated: false };
  const normalized = value.trim();
  if (normalized === "") return { value: null, truncated: false };
  if (normalized.length <= maxChars) return { value: normalized, truncated: false };
  return { value: normalized.slice(0, maxChars), truncated: true };
}

function normalizeOptionalTimestamp(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function normalizeGeneratedAt(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError("Observatory clock must return a valid Date or date-time value");
  }
  return date.toISOString();
}

function formatForPath(publicPath) {
  const extension = path.posix.extname(publicPath).toLowerCase();
  if (extension === ".json") return "json";
  if (extension === ".jsonl") return "jsonl";
  if ([".md", ".markdown"].includes(extension)) return "markdown";
  return "text";
}

function toKnowledgeBasePath(relativePath) {
  return relativePath ? `.sdlc/${relativePath}` : ".sdlc";
}

function portableSegments(relativePath) {
  return relativePath ? relativePath.split("/") : [];
}

function isRecordObject(record) {
  return record?.provenance === "recorded" && isPlainObject(record.data);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function boundedRecordArray(record, value, limits, diagnostics, pointer, label) {
  const items = asArray(value);
  if (items.length > limits.maxCollectionItems) {
    diagnostics.add({
      code: "record_fanout_truncated",
      message: `The ${label} were truncated by the configured per-record item limit.`,
      provenance: "inferred",
      sourceRefs: [{ ...sourceRef(record), pointer }],
    });
  }
  return items.slice(0, limits.maxCollectionItems);
}

function boundedPlainObjectItems(record, value, limits, diagnostics, pointer, label) {
  const result = [];
  let truncated = false;
  for (const item of asArray(value)) {
    if (!isPlainObject(item)) continue;
    if (result.length >= limits.maxCollectionItems) {
      truncated = true;
      break;
    }
    result.push(item);
  }
  if (truncated) {
    diagnostics.add({
      code: "record_fanout_truncated",
      message: `The ${label} were truncated by the configured per-record item limit.`,
      provenance: "inferred",
      sourceRefs: [{ ...sourceRef(record), pointer }],
    });
  }
  return result;
}

function boundedSourceRefs(limit, ...groups) {
  const refs = [];
  for (const group of groups) {
    for (const ref of group) {
      if (!ref?.path) continue;
      refs.push(ref);
      if (refs.length >= limit) return refs;
    }
  }
  return refs;
}

function uniqueSourceRefsFromGroups(groups, limit) {
  const seen = new Set();
  const unique = [];
  for (const group of groups) {
    for (const raw of group) {
      if (!raw?.path) continue;
      const ref = normalizeSourceRef(raw);
      const fingerprint = sourceRefFingerprint(ref);
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      unique.push(ref);
      if (unique.length >= limit) return unique;
    }
  }
  return unique;
}

function normalizedStringList(value, limits) {
  const seen = new Set();
  const normalized = [];
  for (const item of asArray(value).slice(0, limits.maxCollectionItems)) {
    const text = boundedText(item, limits.maxTextChars).value;
    if (!text || seen.has(text)) continue;
    seen.add(text);
    normalized.push(text);
  }
  return normalized;
}
