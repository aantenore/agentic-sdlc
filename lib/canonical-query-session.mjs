import path from "node:path";

import { process } from "./runtime/host.mjs";
import { immutableJson, isPlainRecord } from "./canonical.mjs";
import { CanonicalStoreError, openCanonicalStore } from "./canonical-store.mjs";

export const DEFAULT_DERIVED_CANONICAL_DIRECTORIES = Object.freeze(["cache", "indexes"]);

export const DEFAULT_JSON_LINES_SCAN_LIMITS = Object.freeze({
  maxFiles: 2_048,
  maxTotalBytes: 64 * 1024 * 1024,
  maxFileBytes: 8 * 1024 * 1024,
  maxLines: 250_000,
  maxLineBytes: 256 * 1024,
  maxJsonDepth: 64,
  maxRetainedBytes: 2 * 1024 * 1024,
});

const JSON_LINES_AGGREGATE_SCHEMA = "canonical-json-lines-aggregate:v1";
const JSON_LINES_AGGREGATE_OPERATIONS = new Set(["count", "first", "last"]);
const JSON_LINES_INVALID_POLICIES = new Set(["skip", "throw"]);
const MAX_JSON_LINES_AGGREGATE_OPERATIONS = 32;
const MAX_JSON_LINES_PROJECTION_FIELDS = 16;
const MAX_JSON_LINES_FIELD_LENGTH = 128;

/**
 * Open one linear, command-scoped view of the canonical project tree.
 *
 * The file catalog is built lazily and at most once until invalidate() is
 * called. File bytes and hashes remain guarded by canonical-store. Direct JSON
 * and readJsonLines calls are memoized by content hash; aggregate and trace
 * scans are intentionally bounded, streaming, and uncached. Writers must call
 * invalidate(path) after adding or removing files.
 */
export function openCanonicalQuerySession({
  root = process.cwd(),
  canonicalRoot = ".sdlc",
  derivedDirectories = DEFAULT_DERIVED_CANONICAL_DIRECTORIES,
  jsonLinesLimits = DEFAULT_JSON_LINES_SCAN_LIMITS,
  store = null,
  onMetric = null,
} = {}) {
  if (onMetric !== null && typeof onMetric !== "function") {
    throw new TypeError("Canonical query session onMetric must be a function");
  }

  const rootPath = path.resolve(String(root));
  const emit = (type, details = {}) => {
    onMetric?.(Object.freeze({ scope: "canonical-query-session", type, ...details }));
  };
  const canonicalStore = store || openCanonicalStore({
    root: rootPath,
    onMetric: onMetric
      ? (event) => onMetric(Object.freeze({ scope: "canonical-store", ...event }))
      : null,
  });
  assertCanonicalStore(canonicalStore, rootPath);

  const canonicalBoundary = normalizeProjectPath(rootPath, null, canonicalRoot, {
    label: "canonicalRoot",
    allowCanonicalRelative: false,
  });
  const normalizePath = (input, label = "path") => normalizeProjectPath(
    rootPath,
    canonicalBoundary,
    input,
    { label, allowCanonicalRelative: true },
  );
  const derivedPrefixes = normalizeStringList(derivedDirectories, "derivedDirectories")
    .map((directory) => normalizePath(directory, "derived directory").projectPath.toLowerCase())
    .sort(comparePortableStrings);
  const sessionJsonLinesLimits = normalizeJsonLinesLimits(
    jsonLinesLimits,
    DEFAULT_JSON_LINES_SCAN_LIMITS,
    "Canonical JSONL session limits",
  );

  let catalogCache = null;
  let catalogGeneration = 0;
  const textCache = new Map();
  const jsonCache = new Map();
  const jsonLinesCache = new Map();
  const counters = {
    catalog_builds: 0,
    catalog_reuses: 0,
    files_indexed: 0,
    list_calls: 0,
    read_text_calls: 0,
    read_json_calls: 0,
    read_json_lines_calls: 0,
    aggregate_json_lines_calls: 0,
    aggregate_files_scanned: 0,
    aggregate_json_line_parses: 0,
    aggregate_valid_records: 0,
    aggregate_invalid_records: 0,
    aggregate_records_retained: 0,
    parsed_cache_hits: 0,
    parsed_cache_misses: 0,
    json_parses: 0,
    json_line_parses: 0,
    source_snapshots: 0,
    invalidations: 0,
    parsed_entries_evicted: 0,
  };

  const isDerivedPath = (projectPath) => {
    const normalized = projectPath.toLowerCase();
    return derivedPrefixes.some(
      (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
    );
  };

  const assertDigestUnchanged = (resolved, expectedSha256) => {
    const currentSha256 = canonicalStore.hash(resolved.projectPath);
    if (currentSha256 !== expectedSha256) {
      throw new CanonicalStoreError(
        "source_changed",
        `Canonical source changed during the query session: ${resolved.projectPath}`,
      );
    }
    return currentSha256;
  };

  const assertSnapshotUnchanged = (resolved, snapshot, expectedSha256) => {
    let currentSha256;
    try {
      currentSha256 = typeof snapshot.assertUnchanged === "function"
        ? snapshot.assertUnchanged()
        : canonicalStore.hash(resolved.projectPath);
    } catch (error) {
      if (error instanceof CanonicalStoreError && error.code === "file_changed") {
        throw new CanonicalStoreError(
          "source_changed",
          `Canonical source changed during the query session: ${resolved.projectPath}`,
          { cause: error },
        );
      }
      throw error;
    }
    if (currentSha256 !== expectedSha256) {
      throw new CanonicalStoreError(
        "source_changed",
        `Canonical source changed during the query session: ${resolved.projectPath}`,
      );
    }
    return currentSha256;
  };

  const captureSnapshot = (resolved, { maxBytes = null } = {}) => {
    if (typeof canonicalStore.snapshot === "function") {
      return canonicalStore.snapshot(resolved.projectPath, { maxBytes });
    }
    const sha256 = canonicalStore.hash(resolved.projectPath);
    return Object.freeze({
      sha256,
      readText: (options = {}) => canonicalStore.readText(resolved.projectPath, options),
      readJson: () => canonicalStore.readJson(resolved.projectPath),
    });
  };

  const buildCatalog = () => {
    if (catalogCache) {
      counters.catalog_reuses += 1;
      emit("catalog_reuse", { generation: catalogGeneration });
      return catalogCache;
    }

    const descriptors = canonicalStore.walk(canonicalBoundary.projectPath)
      .map((absolutePath) => fileDescriptor(
        normalizePath(absolutePath, "indexed file"),
        isDerivedPath,
      ))
      .sort((left, right) => comparePortableStrings(left.path, right.path));
    const canonicalFiles = Object.freeze(descriptors.filter((file) => !file.derived));
    const derivedFiles = Object.freeze(descriptors.filter((file) => file.derived));
    catalogGeneration += 1;
    counters.catalog_builds += 1;
    counters.files_indexed += descriptors.length;
    catalogCache = Object.freeze({
      canonical_root: canonicalBoundary.projectPath,
      generation: catalogGeneration,
      files: canonicalFiles,
      derived_files: derivedFiles,
    });
    emit("catalog_build", {
      generation: catalogGeneration,
      files: canonicalFiles.length,
      derived_files: derivedFiles.length,
    });
    return catalogCache;
  };

  const listFiles = (input = {}) => {
    counters.list_calls += 1;
    const options = typeof input === "string" ? { under: input } : input || {};
    if (!isPlainRecord(options)) {
      throw new TypeError("Canonical file query must be an object or path string");
    }
    const under = normalizePath(options.under ?? ".", "under");
    const extensions = normalizeExtensions(options.extensions);
    const names = normalizeOptionalStringSet(options.names, "names");
    const recursive = options.recursive !== false;
    const includeDerived = options.includeDerived === true;
    const catalog = buildCatalog();
    const candidates = includeDerived
      ? [...catalog.files, ...catalog.derived_files].sort((left, right) => comparePortableStrings(left.path, right.path))
      : catalog.files;
    const prefix = `${under.projectPath}/`;
    const selected = candidates.filter((file) => {
      const inside = file.path === under.projectPath || file.path.startsWith(prefix);
      if (!inside) return false;
      if (!recursive && path.posix.dirname(file.path) !== under.projectPath) return false;
      if (extensions && !extensions.has(file.extension)) return false;
      if (names && !names.has(file.basename)) return false;
      return true;
    });
    return Object.freeze(selected);
  };

  const readText = (input, { encoding = "utf8" } = {}) => {
    counters.read_text_calls += 1;
    const resolved = normalizePath(input);
    const snapshot = captureSnapshot(resolved);
    const digest = snapshot.sha256;
    const cacheKey = `${resolved.projectPath}\u0000${encoding}`;
    const cached = textCache.get(cacheKey);
    if (cached?.sha256 === digest) {
      counters.parsed_cache_hits += 1;
      return cached.value;
    }
    counters.parsed_cache_misses += 1;
    const value = snapshot.readText({ encoding });
    assertSnapshotUnchanged(resolved, snapshot, digest);
    textCache.set(cacheKey, { path: resolved.projectPath, sha256: digest, value });
    return value;
  };

  const readTextAtHash = (input, expectedSha256, options = {}) => {
    if (typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/iu.test(expectedSha256)) {
      throw new TypeError("Canonical query expectedSha256 must be a SHA-256 hex digest");
    }
    const resolved = normalizePath(input);
    const expected = expectedSha256.toLowerCase();
    assertDigestUnchanged(resolved, expected);
    const value = readText(resolved.projectPath, options);
    assertDigestUnchanged(resolved, expected);
    return value;
  };

  const readJson = (input) => {
    counters.read_json_calls += 1;
    const resolved = normalizePath(input);
    const snapshot = captureSnapshot(resolved);
    const digest = snapshot.sha256;
    const cached = jsonCache.get(resolved.projectPath);
    if (cached?.sha256 === digest) {
      counters.parsed_cache_hits += 1;
      return cached.value;
    }
    counters.parsed_cache_misses += 1;
    counters.json_parses += 1;
    const value = immutableParsedJson(snapshot.readJson());
    assertSnapshotUnchanged(resolved, snapshot, digest);
    jsonCache.set(resolved.projectPath, { path: resolved.projectPath, sha256: digest, value });
    return value;
  };

  const readJsonLines = (input) => {
    counters.read_json_lines_calls += 1;
    const resolved = normalizePath(input);
    const snapshot = captureSnapshot(resolved);
    const digest = snapshot.sha256;
    const cached = jsonLinesCache.get(resolved.projectPath);
    if (cached?.sha256 === digest) {
      counters.parsed_cache_hits += 1;
      return cached.value;
    }
    counters.parsed_cache_misses += 1;
    const raw = snapshot.readText();
    const records = [];
    for (const [index, line] of raw.split(/\r?\n/u).entries()) {
      if (!line.trim()) continue;
      counters.json_line_parses += 1;
      try {
        records.push(Object.freeze({
          path: resolved.projectPath,
          line: index + 1,
          valid: true,
          value: immutableParsedJson(JSON.parse(line)),
          error: null,
        }));
      } catch {
        records.push(Object.freeze({
          path: resolved.projectPath,
          line: index + 1,
          valid: false,
          value: null,
          error: Object.freeze({
            code: "invalid_json",
            message: `Invalid JSON at ${resolved.projectPath}:${index + 1}`,
          }),
        }));
      }
    }
    assertSnapshotUnchanged(resolved, snapshot, digest);
    const value = Object.freeze(records);
    jsonLinesCache.set(resolved.projectPath, {
      path: resolved.projectPath,
      sha256: digest,
      value,
    });
    return value;
  };

  const scanJsonLineFiles = ({ files, onInvalid, limits, onRecord, progress = null, topology }) => {
    if (files.length > limits.maxFiles) {
      throwJsonLinesLimit("maxFiles", files.length, limits.maxFiles);
    }
    const snapshots = [];
    let totalBytes = 0;
    let lines = 0;
    let validRecords = 0;
    let invalidRecords = 0;
    let pendingError = null;

    try {
      outer: for (const file of files) {
        const resolved = normalizePath(file.path || file);
        const remainingTotalBytes = limits.maxTotalBytes - totalBytes;
        const boundedReadBytes = Math.max(
          1,
          Math.min(limits.maxFileBytes, remainingTotalBytes),
        );
        let snapshot;
        try {
          snapshot = captureSnapshot(resolved, { maxBytes: boundedReadBytes });
        } catch (error) {
          if (!(error instanceof CanonicalStoreError) || error.code !== "file_too_large") throw error;
          const limit = remainingTotalBytes < limits.maxFileBytes
            ? "maxTotalBytes"
            : "maxFileBytes";
          const maximum = limit === "maxTotalBytes" ? limits.maxTotalBytes : limits.maxFileBytes;
          pendingError = jsonLinesLimitError(limit, maximum + 1, maximum, resolved.projectPath);
          break;
        }
        const digest = snapshot.sha256;
        const raw = snapshot.readText();
        snapshots.push({ resolved, snapshot, digest });
        const fileBytes = snapshot.byteLength ?? Buffer.byteLength(raw, "utf8");
        if (fileBytes > limits.maxFileBytes) {
          pendingError = jsonLinesLimitError("maxFileBytes", fileBytes, limits.maxFileBytes, resolved.projectPath);
          break;
        }
        totalBytes += fileBytes;
        if (totalBytes > limits.maxTotalBytes) {
          pendingError = jsonLinesLimitError("maxTotalBytes", totalBytes, limits.maxTotalBytes);
          break;
        }

        forEachNonEmptyJsonLine(raw, (line, lineNumber) => {
          lines += 1;
          counters.json_line_parses += 1;
          if (lines > limits.maxLines) {
            pendingError = jsonLinesLimitError("maxLines", lines, limits.maxLines);
            return false;
          }
          const lineBytes = line.length * 3 <= limits.maxLineBytes
            ? line.length
            : Buffer.byteLength(line, "utf8");
          if (lineBytes > limits.maxLineBytes) {
            pendingError = jsonLinesLimitError("maxLineBytes", lineBytes, limits.maxLineBytes);
            return false;
          }

          let value;
          try {
            value = JSON.parse(line);
            assertCanonicalJsonWithinDepth(value, limits.maxJsonDepth);
          } catch (error) {
            if (error instanceof CanonicalStoreError) {
              pendingError = error;
              return false;
            }
            invalidRecords += 1;
            if (onInvalid === "throw") {
              pendingError = new CanonicalStoreError(
                "invalid_json",
                `Invalid JSON at ${resolved.projectPath}:${lineNumber}`,
                { cause: error },
              );
              return false;
            }
            if (onInvalid === "include") {
              try {
                onRecord(
                  null,
                  resolved.projectPath,
                  lineNumber,
                  Object.freeze({
                    code: "invalid_json",
                    message: `Invalid JSON at ${resolved.projectPath}:${lineNumber}`,
                  }),
                );
              } catch (callbackError) {
                pendingError = callbackError;
                return false;
              }
            }
            return true;
          }

          validRecords += 1;
          try {
            onRecord(value, resolved.projectPath, lineNumber, null);
          } catch (error) {
            pendingError = error;
            return false;
          }
          return true;
        });
        if (pendingError) break outer;
      }

      // Validate the whole selected set after parsing. This catches an earlier
      // shard changing while a later shard is being scanned.
      let verificationError = null;
      for (const { resolved, snapshot, digest } of snapshots) {
        try {
          assertSnapshotUnchanged(resolved, snapshot, digest);
        } catch (error) {
          verificationError ||= error;
        }
      }
      try {
        assertJsonLineTopologyUnchanged(
          topology,
          discoverJsonLineFiles(topology, limits).map((file) => file.path),
        );
      } catch (error) {
        verificationError ||= error;
      }
      if (verificationError) throw verificationError;
      if (pendingError) throw pendingError;

      return Object.freeze({
        filesScanned: snapshots.length,
        totalBytes,
        lines,
        validRecords,
        invalidRecords,
      });
    } finally {
      if (progress) {
        progress.filesScanned = snapshots.length;
        progress.lines = lines;
        progress.validRecords = validRecords;
        progress.invalidRecords = invalidRecords;
      }
    }
  };

  const discoverJsonLineFiles = ({ under, includeDerived, basename = null }, limits) => {
    const resolved = normalizePath(under, "JSONL topology root");
    const inspected = typeof canonicalStore.inspect === "function"
      ? canonicalStore.inspect(resolved.projectPath)
      : null;
    if (inspected && inspected.isFile) {
      const descriptor = fileDescriptor(resolved, isDerivedPath);
      return Object.freeze(
        descriptor.extension === ".jsonl"
          && (includeDerived || !descriptor.derived)
          && (basename === null || descriptor.basename === basename)
          ? [descriptor]
          : [],
      );
    }
    if (inspected && !inspected.isDirectory) return Object.freeze([]);
    if (typeof canonicalStore.inspect === "function" && inspected === null) return Object.freeze([]);

    let absoluteFiles;
    let exactPath = null;
    const walkOptions = {
      maxFiles: limits.maxFiles,
      maxEntries: limits.maxFiles * 4,
    };
    try {
      absoluteFiles = canonicalStore.walk(resolved.projectPath, walkOptions);
    } catch (error) {
      if (error instanceof CanonicalStoreError && error.code === "path_missing") {
        return Object.freeze([]);
      }
      if (error instanceof CanonicalStoreError && error.code === "walk_limit_exceeded") {
        throw jsonLinesLimitError("maxFiles", limits.maxFiles + 1, limits.maxFiles);
      }
      if (!(error instanceof CanonicalStoreError) || error.code !== "not_a_directory") throw error;
      exactPath = resolved.projectPath;
      try {
        absoluteFiles = canonicalStore.walk(path.posix.dirname(exactPath), walkOptions);
      } catch (parentError) {
        if (parentError instanceof CanonicalStoreError && parentError.code === "walk_limit_exceeded") {
          throw jsonLinesLimitError("maxFiles", limits.maxFiles + 1, limits.maxFiles);
        }
        throw parentError;
      }
    }
    return Object.freeze(absoluteFiles
      .map((filePath) => fileDescriptor(
        normalizePath(filePath, "JSONL topology file"),
        isDerivedPath,
      ))
      .filter((file) => file.extension === ".jsonl")
      .filter((file) => exactPath === null || file.path === exactPath)
      .filter((file) => includeDerived || !file.derived)
      .filter((file) => basename === null || file.basename === basename)
      .sort((left, right) => comparePortableStrings(left.path, right.path)));
  };

  const selectJsonLineFiles = (query, limits) => {
    if (catalogCache === null) return discoverJsonLineFiles(query, limits);
    const files = listFiles({
      under: query.under,
      extensions: [".jsonl"],
      includeDerived: query.includeDerived,
    }).filter((file) => query.basename === null || file.basename === query.basename);
    if (files.length > limits.maxFiles) {
      throwJsonLinesLimit("maxFiles", files.length, limits.maxFiles);
    }
    return files;
  };

  const aggregateJsonLines = (input) => {
    const plan = normalizeJsonLinesAggregatePlan(input, sessionJsonLinesLimits);
    counters.aggregate_json_lines_calls += 1;
    const states = new Map(plan.operations.map((operation) => [operation.id, {
      count: 0,
      matches: 0,
      selection: null,
    }]));
    const retained = { bytes: 0 };

    const files = selectJsonLineFiles({
      under: plan.under,
      includeDerived: plan.includeDerived,
      basename: null,
    }, plan.limits);
    const topology = Object.freeze({
      under: plan.under,
      includeDerived: plan.includeDerived,
      basename: null,
      paths: Object.freeze(files.map((file) => file.path)),
    });
    const progress = { filesScanned: 0, lines: 0, validRecords: 0, invalidRecords: 0 };
    let scan;
    try {
      scan = scanJsonLineFiles({
        files,
        onInvalid: plan.onInvalid,
        limits: plan.limits,
        topology,
        progress,
        onRecord(value, sourcePath, line) {
          applyJsonLinesAggregateOperations(
            plan.operations,
            states,
            value,
            sourcePath,
            line,
            retained,
            plan.limits,
          );
        },
      });
    } finally {
      counters.aggregate_files_scanned += progress.filesScanned;
      counters.aggregate_json_line_parses += progress.lines;
      counters.aggregate_valid_records += progress.validRecords;
      counters.aggregate_invalid_records += progress.invalidRecords;
    }

    const results = {};
    let retainedRecords = 0;
    for (const operation of plan.operations) {
      const state = states.get(operation.id);
      if (operation.operation === "count") {
        defineOwnDataProperty(results, operation.id, state.count);
        continue;
      }
      if (state.selection) retainedRecords += 1;
      defineOwnDataProperty(results, operation.id, Object.freeze({
        matches: state.matches,
        value: state.selection?.value ?? null,
        source: state.selection?.source ?? null,
      }));
    }
    counters.aggregate_records_retained += retainedRecords;
    const aggregate = Object.freeze({
      schema_version: JSON_LINES_AGGREGATE_SCHEMA,
      files_scanned: scan.filesScanned,
      valid_records: scan.validRecords,
      invalid_records: scan.invalidRecords,
      results: Object.freeze(results),
    });
    emit("json_lines_aggregate", {
      files: scan.filesScanned,
      valid_records: scan.validRecords,
      invalid_records: scan.invalidRecords,
      retained_records: retainedRecords,
      operations: plan.operations.length,
    });
    return aggregate;
  };

  const jsonRecords = ({ under = ".", onInvalid = "throw", includeDerived = false } = {}) => {
    if (!["throw", "skip", "include"].includes(onInvalid)) {
      throw new TypeError("jsonRecords onInvalid must be throw, skip, or include");
    }
    const records = [];
    for (const file of listFiles({ under, extensions: [".json"], includeDerived })) {
      try {
        records.push(Object.freeze({ path: file.path, valid: true, value: readJson(file.path), error: null }));
      } catch (error) {
        if (!(error instanceof CanonicalStoreError) || error.code !== "invalid_json" || onInvalid === "throw") {
          throw error;
        }
        if (onInvalid === "include") {
          records.push(Object.freeze({
            path: file.path,
            valid: false,
            value: null,
            error: Object.freeze({ code: error.code, message: error.message }),
          }));
        }
      }
    }
    return Object.freeze(records);
  };

  const stories = () => {
    const storiesRoot = normalizePath("stories", "stories root").projectPath;
    const prefix = `${storiesRoot}/`;
    const records = listFiles({ under: "stories", extensions: [".json"], names: ["story.json"] })
      .filter((file) => {
        const relative = file.path.slice(prefix.length);
        return relative.split("/").length === 2;
      })
      .map((file) => readJson(file.path))
      .sort((left, right) => comparePortableStrings(String(left.id || ""), String(right.id || "")));
    return Object.freeze(records);
  };

  const traceEvents = ({ storyId = null, includeInvalid = true } = {}) => {
    if (storyId !== null) assertSafeRecordId(storyId, "storyId");
    const basename = storyId === null ? null : `${storyId}.jsonl`;
    const files = selectJsonLineFiles({
      under: "traces",
      includeDerived: false,
      basename,
    }, sessionJsonLinesLimits);
    const events = [];
    const topology = Object.freeze({
      under: "traces",
      includeDerived: false,
      basename,
      paths: Object.freeze(files.map((file) => file.path)),
    });
    scanJsonLineFiles({
      files,
      onInvalid: "include",
      limits: sessionJsonLinesLimits,
      topology,
      onRecord(value, sourcePath, line, error) {
        const source = Object.freeze({ path: sourcePath, line });
        if (error || !isPlainRecord(value)) {
          if (includeInvalid) {
            events.push(immutableJson({
              type: "invalid",
              source,
              error: error || {
                code: "invalid_record",
                message: `JSONL value at ${sourcePath}:${line} is not an object`,
              },
            }));
          }
          return;
        }
        events.push(immutableJson({ ...value, source }));
      },
    });
    return Object.freeze(events);
  };

  const sourceSnapshot = ({
    under = ["."],
    extensions = null,
    exclude = [],
    includeDerived = false,
  } = {}) => {
    counters.source_snapshots += 1;
    const roots = normalizeStringList(under, "under");
    const excluded = normalizeStringList(exclude, "exclude").map(
      (item) => normalizePath(item, "excluded path").projectPath,
    );
    const filesByPath = new Map();
    for (const sourceRoot of roots) {
      for (const file of listFiles({ under: sourceRoot, extensions, includeDerived })) {
        if (excluded.some((prefix) => file.path === prefix || file.path.startsWith(`${prefix}/`))) continue;
        filesByPath.set(file.path, file);
      }
    }
    const files = [...filesByPath.values()].sort((left, right) => comparePortableStrings(left.path, right.path));
    const sourceHashes = {};
    for (const file of files) sourceHashes[file.path] = canonicalStore.hash(file.path);
    const snapshot = immutableJson({
      canonical_root: canonicalBoundary.projectPath,
      source_paths: files.map((file) => file.path),
      source_hashes: sourceHashes,
    });
    emit("source_snapshot", { files: files.length });
    return snapshot;
  };

  const hash = (input) => canonicalStore.hash(normalizePath(input).projectPath);

  const invalidate = (input = null) => {
    counters.invalidations += 1;
    const resolved = input === null || input === undefined ? null : normalizePath(input);
    const target = resolved?.projectPath || null;
    const storeEntriesEvicted = canonicalStore.invalidate(target);
    let parsedEntriesEvicted = 0;
    for (const cache of [textCache, jsonCache, jsonLinesCache]) {
      for (const [key, entry] of [...cache.entries()]) {
        if (target === null || pathMatchesPrefix(entry.path, target)) {
          cache.delete(key);
          parsedEntriesEvicted += 1;
        }
      }
    }
    counters.parsed_entries_evicted += parsedEntriesEvicted;
    const indexInvalidated = catalogCache !== null;
    catalogCache = null;
    emit("invalidate", {
      path: target,
      store_entries_evicted: storeEntriesEvicted,
      parsed_entries_evicted: parsedEntriesEvicted,
      index_invalidated: indexInvalidated,
    });
    return Object.freeze({
      path: target,
      store_entries_evicted: storeEntriesEvicted,
      parsed_entries_evicted: parsedEntriesEvicted,
      index_invalidated: indexInvalidated,
    });
  };

  const metrics = () => Object.freeze({
    ...counters,
    catalog_generation: catalogGeneration,
    catalog_cached: catalogCache !== null,
    parsed_cache_entries: textCache.size + jsonCache.size + jsonLinesCache.size,
    store: canonicalStore.metrics(),
  });

  return Object.freeze({
    root: rootPath,
    canonicalRoot: canonicalBoundary.projectPath,
    catalog: buildCatalog,
    listFiles,
    readText,
    readTextAtHash,
    readJson,
    readJsonLines,
    aggregateJsonLines,
    jsonRecords,
    stories,
    traceEvents,
    sourceSnapshot,
    hash,
    invalidate,
    metrics,
  });
}

function assertCanonicalStore(store, rootPath) {
  const methods = ["readText", "readJson", "hash", "walk", "invalidate", "metrics"];
  if (!store || methods.some((method) => typeof store[method] !== "function")) {
    throw new TypeError("Canonical query session store must implement the canonical-store API");
  }
  if (path.resolve(String(store.root)) !== rootPath) {
    throw new TypeError("Canonical query session store root must match the session root");
  }
}

function normalizeJsonLinesAggregatePlan(input, sessionLimits) {
  if (!isPlainRecord(input)) {
    throw new TypeError("Canonical JSONL aggregate plan must be a plain object");
  }
  assertExactKeys(
    input,
    ["under", "includeDerived", "onInvalid", "operations", "limits"],
    "Canonical JSONL aggregate plan",
  );
  const under = ownValue(input, "under") ?? ".";
  if (typeof under !== "string" || under.trim() === "") {
    throw new TypeError("Canonical JSONL aggregate under must be a non-empty string");
  }
  const requestedIncludeDerived = ownValue(input, "includeDerived");
  if (requestedIncludeDerived !== undefined && typeof requestedIncludeDerived !== "boolean") {
    throw new TypeError("Canonical JSONL aggregate includeDerived must be boolean");
  }
  const onInvalid = ownValue(input, "onInvalid") ?? "throw";
  if (!JSON_LINES_INVALID_POLICIES.has(onInvalid)) {
    throw new TypeError("Canonical JSONL aggregate onInvalid must be skip or throw");
  }
  const requestedOperations = ownValue(input, "operations");
  if (
    !Array.isArray(requestedOperations)
    || requestedOperations.length < 1
    || requestedOperations.length > MAX_JSON_LINES_AGGREGATE_OPERATIONS
  ) {
    throw new TypeError(
      `Canonical JSONL aggregate operations must contain between 1 and ${MAX_JSON_LINES_AGGREGATE_OPERATIONS} items`,
    );
  }
  const limits = normalizeJsonLinesLimits(
    ownValue(input, "limits") ?? {},
    sessionLimits,
    "Canonical JSONL aggregate limits",
  );
  const ids = new Set();
  const operations = requestedOperations.map((operation, index) => {
    const normalized = normalizeJsonLinesAggregateOperation(operation, index, limits);
    if (ids.has(normalized.id)) {
      throw new TypeError(`Canonical JSONL aggregate operation id '${normalized.id}' is duplicated`);
    }
    ids.add(normalized.id);
    return normalized;
  });
  return Object.freeze({
    under: under.trim(),
    includeDerived: requestedIncludeDerived === true,
    onInvalid,
    limits,
    operations: Object.freeze(operations),
  });
}

function normalizeJsonLinesAggregateOperation(input, index, limits) {
  if (!isPlainRecord(input)) {
    throw new TypeError(`Canonical JSONL aggregate operations[${index}] must be a plain object`);
  }
  assertExactKeys(
    input,
    ["id", "operation", "where", "project", "includeSource"],
    `Canonical JSONL aggregate operations[${index}]`,
  );
  const id = ownValue(input, "id");
  if (typeof id !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(id)) {
    throw new TypeError(`Canonical JSONL aggregate operations[${index}].id is invalid`);
  }
  const operation = ownValue(input, "operation");
  if (!JSON_LINES_AGGREGATE_OPERATIONS.has(operation)) {
    throw new TypeError(
      `Canonical JSONL aggregate operation '${id}' must use count, first, or last`,
    );
  }
  const requestedIncludeSource = ownValue(input, "includeSource");
  if (requestedIncludeSource !== undefined && typeof requestedIncludeSource !== "boolean") {
    throw new TypeError(`Canonical JSONL aggregate operation '${id}' includeSource must be boolean`);
  }
  const includeSource = requestedIncludeSource === true;
  const where = normalizeJsonLinesPredicate(ownValue(input, "where"), id, limits);
  const project = normalizeJsonLinesProjection(ownValue(input, "project"), id);
  if (operation === "count" && (project.length > 0 || includeSource)) {
    throw new TypeError(`Canonical JSONL aggregate count operation '${id}' cannot project records`);
  }
  if (operation !== "count" && project.length === 0 && !includeSource) {
    throw new TypeError(
      `Canonical JSONL aggregate ${operation} operation '${id}' must project fields or source`,
    );
  }
  return Object.freeze({
    id,
    operation,
    where,
    project,
    includeSource,
  });
}

function normalizeJsonLinesPredicate(input, operationId, limits) {
  if (input === undefined || input === null) return null;
  if (!isPlainRecord(input)) {
    throw new TypeError(`Canonical JSONL aggregate operation '${operationId}' where must be an object`);
  }
  assertExactKeys(
    input,
    ["field", "equals"],
    `Canonical JSONL aggregate operation '${operationId}' where`,
  );
  if (!Object.hasOwn(input, "equals")) {
    throw new TypeError(`Canonical JSONL aggregate operation '${operationId}' where.equals is required`);
  }
  return Object.freeze({
    field: normalizeJsonLinesField(ownValue(input, "field"), `${operationId}.where.field`),
    equals: normalizeJsonScalar(
      ownValue(input, "equals"),
      `${operationId}.where.equals`,
      limits.maxLineBytes,
    ),
  });
}

function normalizeJsonLinesProjection(input, operationId) {
  if (input === undefined || input === null) return Object.freeze([]);
  if (!Array.isArray(input) || input.length > MAX_JSON_LINES_PROJECTION_FIELDS) {
    throw new TypeError(
      `Canonical JSONL aggregate operation '${operationId}' project must contain at most ${MAX_JSON_LINES_PROJECTION_FIELDS} fields`,
    );
  }
  const fields = input.map((field, index) => normalizeJsonLinesField(
    field,
    `${operationId}.project[${index}]`,
  ));
  if (new Set(fields).size !== fields.length) {
    throw new TypeError(`Canonical JSONL aggregate operation '${operationId}' project fields must be unique`);
  }
  return Object.freeze(fields);
}

function normalizeJsonLinesField(input, label) {
  if (
    typeof input !== "string"
    || input.length < 1
    || input.length > MAX_JSON_LINES_FIELD_LENGTH
    || input.includes("\u0000")
  ) {
    throw new TypeError(`Canonical JSONL aggregate field ${label} is invalid`);
  }
  return input;
}

function normalizeJsonScalar(value, label, maxStringBytes = Number.MAX_SAFE_INTEGER) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (maxStringBytes < Number.MAX_SAFE_INTEGER) {
      const bytes = Buffer.byteLength(value, "utf8");
      if (bytes > maxStringBytes) throwJsonLinesLimit("maxLineBytes", bytes, maxStringBytes);
    }
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
  throw new TypeError(`Canonical JSONL aggregate scalar ${label} must be finite JSON scalar`);
}

function applyJsonLinesAggregateOperations(
  operations,
  states,
  value,
  sourcePath,
  line,
  retained,
  limits,
) {
  for (const operation of operations) {
    if (!jsonLinesPredicateMatches(value, operation.where)) continue;
    const state = states.get(operation.id);
    if (operation.operation === "count") {
      state.count = incrementSafeCount(state.count, operation.id);
      continue;
    }
    state.matches = incrementSafeCount(state.matches, operation.id);
    if (operation.operation === "first" && state.selection !== null) continue;
    const selection = projectJsonLinesRecord(value, operation, sourcePath, line);
    const retainedBytes = retained.bytes - (state.selection?.bytes ?? 0) + selection.bytes;
    if (retainedBytes > limits.maxRetainedBytes) {
      throwJsonLinesLimit("maxRetainedBytes", retainedBytes, limits.maxRetainedBytes);
    }
    state.selection = selection;
    retained.bytes = retainedBytes;
  }
}

function jsonLinesPredicateMatches(value, predicate) {
  if (!predicate) return true;
  if (!isPlainRecord(value) || !Object.hasOwn(value, predicate.field)) return false;
  const candidate = value[predicate.field];
  if (!isJsonScalar(candidate)) return false;
  return Object.is(normalizeJsonScalar(candidate, predicate.field), predicate.equals);
}

function projectJsonLinesRecord(value, operation, sourcePath, line) {
  const projected = {};
  for (const field of operation.project) {
    if (!isPlainRecord(value) || !Object.hasOwn(value, field)) {
      throw new CanonicalStoreError(
        "json_lines_projection_missing",
        `Canonical JSONL aggregate operation '${operation.id}' cannot project missing field '${field}'`,
      );
    }
    const candidate = value[field];
    if (!isJsonScalar(candidate)) {
      throw new TypeError(
        `Canonical JSONL aggregate operation '${operation.id}' can project only scalar field '${field}'`,
      );
    }
    defineOwnDataProperty(projected, field, normalizeJsonScalar(candidate, field));
  }
  const source = operation.includeSource ? Object.freeze({ path: sourcePath, line }) : null;
  const frozenValue = Object.freeze(projected);
  return Object.freeze({
    value: frozenValue,
    source,
    bytes: Buffer.byteLength(JSON.stringify({ value: frozenValue, source }), "utf8"),
  });
}

function incrementSafeCount(value, operationId) {
  if (value >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`Canonical JSONL aggregate operation '${operationId}' count overflowed`);
  }
  return value + 1;
}

function isJsonScalar(value) {
  return value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value));
}

function assertCanonicalJsonWithinDepth(value, maxDepth) {
  if (isJsonScalar(value)) return;
  if (!Array.isArray(value) && !isPlainRecord(value)) {
    throw new TypeError("Parsed value is not canonical JSON");
  }
  const pending = [];
  enqueueNestedJsonValues(value, 1, maxDepth, pending);
  while (pending.length > 0) {
    const current = pending.pop();
    enqueueNestedJsonValues(current.value, current.depth, maxDepth, pending);
  }
}

function enqueueNestedJsonValues(value, depth, maxDepth, pending) {
  const keys = Array.isArray(value) ? null : Object.keys(value);
  const childCount = keys === null ? value.length : keys.length;
  if (childCount === 0) return;
  const childDepth = depth + 1;
  if (childDepth > maxDepth) {
    throwJsonLinesLimit("maxJsonDepth", childDepth, maxDepth);
  }
  for (let index = 0; index < childCount; index += 1) {
    const child = keys === null ? value[index] : value[keys[index]];
    if (isJsonScalar(child)) continue;
    if (!Array.isArray(child) && !isPlainRecord(child)) {
      throw new TypeError("Parsed value is not canonical JSON");
    }
    pending.push({ value: child, depth: childDepth });
  }
}

function forEachNonEmptyJsonLine(raw, callback) {
  let start = 0;
  let lineNumber = 1;
  while (start <= raw.length) {
    const newline = raw.indexOf("\n", start);
    const end = newline === -1 ? raw.length : newline;
    let line = raw.slice(start, end);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (hasNonWhitespace(line) && callback(line, lineNumber) === false) return;
    if (newline === -1) return;
    start = newline + 1;
    lineNumber += 1;
  }
}

function hasNonWhitespace(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code !== 0x20 && code !== 0x09 && code !== 0x0d) return true;
  }
  return false;
}

function defineOwnDataProperty(target, key, value) {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function normalizeJsonLinesLimits(input, ceiling, label) {
  if (!isPlainRecord(input)) throw new TypeError(`${label} must be a plain object`);
  const keys = Object.keys(DEFAULT_JSON_LINES_SCAN_LIMITS);
  assertExactKeys(input, keys, label);
  const normalized = {};
  for (const key of keys) {
    const requested = ownValue(input, key) ?? ceiling[key];
    if (!Number.isSafeInteger(requested) || requested < 1) {
      throw new TypeError(`${label}.${key} must be a positive safe integer`);
    }
    if (requested > ceiling[key]) {
      throw new TypeError(`${label}.${key} cannot exceed the session limit ${ceiling[key]}`);
    }
    normalized[key] = requested;
  }
  return Object.freeze(normalized);
}

function ownValue(value, key) {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

function jsonLinesLimitError(limit, observed, maximum, projectPath = null) {
  const error = new CanonicalStoreError(
    "json_lines_limit_exceeded",
    `Canonical JSONL scan exceeded ${limit}${projectPath ? ` for ${projectPath}` : ""}: observed ${observed}, maximum ${maximum}`,
  );
  // Structured fields let the CLI name the limit, the file, and the remedy
  // without parsing the message.
  error.limit = limit;
  error.observed = observed;
  error.maximum = maximum;
  error.path = projectPath;
  return error;
}

function throwJsonLinesLimit(limit, observed, maximum) {
  throw jsonLinesLimitError(limit, observed, maximum);
}

function assertJsonLineTopologyUnchanged(topology, currentPaths) {
  if (
    topology.paths.length !== currentPaths.length
    || topology.paths.some((filePath, index) => filePath !== currentPaths[index])
  ) {
    throw new CanonicalStoreError(
      "source_changed",
      `Canonical JSONL file set changed during the query session: ${topology.under}`,
    );
  }
}

function assertExactKeys(value, allowed, label) {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unexpected.length > 0) {
    throw new TypeError(`${label} contains unsupported field '${unexpected[0]}'`);
  }
}

// Values returned by JSON.parse are already detached from their source bytes.
// Canonicalizing them directly avoids the stringify/parse round trip performed
// by immutableJson while preserving its sorted-key, -0, prototype, and deep
// immutability semantics. Keep this helper private: it intentionally accepts
// only values that can be produced by a conforming JSON parser.
function immutableParsedJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON does not support non-finite numbers");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => immutableParsedJson(item)));
  }
  if (!isPlainRecord(value)) {
    throw new TypeError("Canonical parsed JSON requires plain objects");
  }
  const result = {};
  for (const key of Object.keys(value).sort(comparePortableStrings)) {
    const item = immutableParsedJson(value[key]);
    // Ordinary assignment keeps normal parsed objects compact. A key already
    // present on Object.prototype needs an explicit own data property so an
    // inherited setter, getter, or non-writable value cannot intercept it.
    if (Object.hasOwn(Object.prototype, key)) {
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: item,
        writable: true,
      });
    } else {
      result[key] = item;
    }
  }
  return Object.freeze(result);
}

function normalizeProjectPath(rootPath, canonicalBoundary, input, options) {
  if (typeof input !== "string" || input.trim() === "") {
    throw new TypeError(`Canonical query ${options.label} must be a non-empty string`);
  }
  const raw = input.trim();
  if (raw.includes("\u0000")) {
    throw new TypeError(`Canonical query ${options.label} cannot contain NUL bytes`);
  }
  if (path.win32.isAbsolute(raw) && !path.isAbsolute(raw)) {
    throw new CanonicalStoreError("path_outside_root", `Canonical query path is outside the project root: ${raw}`);
  }
  const portable = raw.replaceAll("\\", "/");
  let absolute;
  if (path.isAbsolute(raw)) {
    absolute = path.resolve(raw);
  } else if (
    canonicalBoundary
    && options.allowCanonicalRelative
    && !isProjectRelativeToBoundary(portable, canonicalBoundary.projectPath)
  ) {
    absolute = path.resolve(canonicalBoundary.absolute, portable);
  } else {
    absolute = path.resolve(rootPath, portable);
  }
  if (!isInsidePath(rootPath, absolute)) {
    throw new CanonicalStoreError("path_outside_root", `Canonical query path is outside the project root: ${raw}`);
  }
  if (canonicalBoundary && !isInsidePath(canonicalBoundary.absolute, absolute)) {
    throw new CanonicalStoreError(
      "path_outside_canonical_root",
      `Canonical query path is outside ${canonicalBoundary.projectPath}: ${raw}`,
    );
  }
  return Object.freeze({
    absolute,
    projectPath: portableRelative(rootPath, absolute),
    canonicalPath: canonicalBoundary ? portableRelative(canonicalBoundary.absolute, absolute) : ".",
  });
}

function isProjectRelativeToBoundary(input, boundary) {
  const normalized = input.replace(/^\.\//u, "").replace(/\/$/u, "");
  return normalized === boundary || normalized.startsWith(`${boundary}/`);
}

function fileDescriptor(resolved, isDerivedPath) {
  const extension = path.posix.extname(resolved.projectPath).toLowerCase();
  return Object.freeze({
    path: resolved.projectPath,
    canonical_path: resolved.canonicalPath,
    directory: path.posix.dirname(resolved.projectPath),
    basename: path.posix.basename(resolved.projectPath),
    extension,
    kind: extension === ".json" ? "json" : extension === ".jsonl" ? "jsonl" : "file",
    derived: isDerivedPath(resolved.projectPath),
  });
}

function normalizeStringList(value, label) {
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0) return [];
  return [...new Set(values.map((item, index) => {
    if (typeof item !== "string" || item.trim() === "") {
      throw new TypeError(`${label}[${index}] must be a non-empty string`);
    }
    return item.trim();
  }))];
}

function normalizeExtensions(value) {
  if (value === null || value === undefined) return null;
  const extensions = normalizeStringList(value, "extensions").map((extension) => {
    const normalized = extension.toLowerCase();
    return normalized.startsWith(".") ? normalized : `.${normalized}`;
  });
  return new Set(extensions);
}

function normalizeOptionalStringSet(value, label) {
  if (value === null || value === undefined) return null;
  return new Set(normalizeStringList(value, label));
}

function assertSafeRecordId(value, label) {
  if (
    typeof value !== "string"
    || value.trim() === ""
    || value.includes("/")
    || value.includes("\\")
    || value === "."
    || value === ".."
  ) {
    throw new TypeError(`${label} must be one safe record identifier`);
  }
}

function pathMatchesPrefix(candidate, prefix) {
  return candidate === prefix || candidate.startsWith(`${prefix}/`);
}

function portableRelative(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" ? "." : relative.split(path.sep).join("/");
}

function isInsidePath(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function comparePortableStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
