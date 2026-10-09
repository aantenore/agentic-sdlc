import path from "node:path";

import { crypto, fs as nodeFs, fsPromises as fs, process } from "../runtime/host.mjs";
import {
  CANONICAL_SOURCE_EXTENSIONS,
  normalizeObservatoryLimits,
  orderKnowledgeBaseEntries,
} from "./constants.mjs";
import {
  ObservatoryPathError,
  assertDirectoryIdentity,
  captureDirectoryIdentity,
  isContainedPath,
  resolveKnowledgeBaseBoundary,
} from "./path-safety.mjs";
import { OBSERVATORY_WORKER_MARKER } from "./runtime.mjs";

const { constants: fsConstants, lstatSync, opendirSync } = nodeFs;

const DERIVED_DIRECTORIES = new Set(["cache", "indexes"]);
const SUPPORTED_EXTENSIONS = new Set(CANONICAL_SOURCE_EXTENSIONS);
const NO_FOLLOW_FLAG = fsConstants.O_NOFOLLOW ?? 0;
const REVISION_FORMAT = "change-observatory:canonical-revision:v1";
const DIRECTORY_SNAPSHOT_FORMAT = "change-observatory:directory-snapshot:v1";
const DIRECT_DIRECTORY_SNAPSHOT_SLOTS_PER_FILE = 4;
const DIRECT_DIRECTORY_SNAPSHOT_NAME_BYTES_PER_FILE = 256;
const MAX_DIRECT_DIRECTORY_SNAPSHOT_SLOTS = 65_536;
const MAX_DIRECT_DIRECTORY_SNAPSHOT_NAME_BYTES = 4 * 1_024 * 1_024;
const DEFAULT_STABILITY_ATTEMPTS = 2;
// Records written continuously can outrun one build. The whole read is retried
// a few times with a short pause before the caller is asked to try again.
const DEFAULT_REVISION_RETRIES = 3;
const DEFAULT_REVISION_RETRY_BACKOFF_MS = 25;
const MAX_REVISION_RETRIES = 10;
// Windows directory operations need a wider pool to overlap NTFS latency;
// every worker still uses the same streaming entry and aggregate limits.
// POSIX retains the lower-memory default used by enterprise-sized trees.
const DEFAULT_VALIDATION_CONCURRENCY = process.platform === "win32" ? 64 : 8;
const MAX_VALIDATION_CONCURRENCY = 128;
const MAX_DIRECTORY_ENTRIES = 16_384;
// NTFS directory calls benefit materially from overlapping the bounded worker
// pool. POSIX keeps synchronous streaming because it retains less V8 heap on
// enterprise trees. Both paths read the same bounded entries and validate the
// same before/after identities.
const USE_ASYNC_DIRECTORY_HANDLES = process.platform === "win32";

export function shouldUseSynchronousMetadataValidation(runtime = {}) {
  const { platform, environment } = normalizeValidationRuntime(runtime);
  return platform === "win32"
    && Object.hasOwn(environment, OBSERVATORY_WORKER_MARKER)
    && environment[OBSERVATORY_WORKER_MARKER] === "1";
}

function normalizeValidationRuntime(runtime = {}) {
  if (runtime === null || typeof runtime !== "object" || Array.isArray(runtime)) {
    throw new TypeError("Observatory validation runtime override must be an object");
  }
  const platform = runtime.platform ?? process.platform;
  const environment = runtime.environment ?? process.env;
  if (typeof platform !== "string" || platform.trim() === "") {
    throw new TypeError("Observatory validation runtime platform must be a non-empty string");
  }
  if (environment === null || typeof environment !== "object" || Array.isArray(environment)) {
    throw new TypeError("Observatory validation runtime environment must be an object");
  }
  return { platform, environment };
}

export function createObservatoryModelCache(options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Observatory model cache options must be an object");
  }
  if (typeof options.projectRoot !== "string" || options.projectRoot.trim() === "") {
    throw new TypeError("Observatory model cache requires a project root");
  }
  if (typeof options.buildModel !== "function") {
    throw new TypeError("Observatory model cache requires a model builder");
  }
  if (options.serialize !== undefined && typeof options.serialize !== "function") {
    throw new TypeError("Observatory model cache serializer must be a function");
  }
  if (options.onFastPathCheck !== undefined && typeof options.onFastPathCheck !== "function") {
    throw new TypeError("Observatory model cache onFastPathCheck must be a function");
  }
  if (options.onEvent !== undefined && typeof options.onEvent !== "function") {
    throw new TypeError("Observatory model cache onEvent must be a function");
  }

  const projectRoot = options.projectRoot;
  const buildModel = options.buildModel;
  const serialize = options.serialize ?? serializeJson;
  const limits = normalizeObservatoryLimits(options.limits);
  const stabilityAttempts = options.stabilityAttempts ?? DEFAULT_STABILITY_ATTEMPTS;
  if (!Number.isSafeInteger(stabilityAttempts) || stabilityAttempts < 1) {
    throw new TypeError("Observatory model cache stabilityAttempts must be a positive safe integer");
  }
  const revisionRetries = options.revisionRetries ?? DEFAULT_REVISION_RETRIES;
  if (!Number.isSafeInteger(revisionRetries) || revisionRetries < 0 || revisionRetries > MAX_REVISION_RETRIES) {
    throw new TypeError(
      `Observatory model cache revisionRetries must be an integer between 0 and ${MAX_REVISION_RETRIES}`,
    );
  }
  const revisionRetryBackoffMs = options.revisionRetryBackoffMs ?? DEFAULT_REVISION_RETRY_BACKOFF_MS;
  if (!Number.isSafeInteger(revisionRetryBackoffMs) || revisionRetryBackoffMs < 0) {
    throw new TypeError("Observatory model cache revisionRetryBackoffMs must be a non-negative safe integer");
  }
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  }));
  if (typeof sleep !== "function") {
    throw new TypeError("Observatory model cache sleep must be a function");
  }
  const validationConcurrency = options.validationConcurrency ?? DEFAULT_VALIDATION_CONCURRENCY;
  if (
    !Number.isSafeInteger(validationConcurrency)
    || validationConcurrency < 1
    || validationConcurrency > MAX_VALIDATION_CONCURRENCY
  ) {
    throw new TypeError(
      `Observatory model cache validationConcurrency must be an integer between 1 and ${MAX_VALIDATION_CONCURRENCY}`,
    );
  }
  const validationRuntime = normalizeValidationRuntime(options.validationRuntime);
  const synchronousMetadataValidation = validationRuntime.platform === "win32"
    && Object.hasOwn(validationRuntime.environment, OBSERVATORY_WORKER_MARKER)
    && validationRuntime.environment[OBSERVATORY_WORKER_MARKER] === "1";
  const onFastPathCheck = options.onFastPathCheck ?? null;
  const onEvent = options.onEvent ?? null;

  let cached = null;
  let inFlight = null;
  let projectIdentity = null;
  let digestIndex = new Map();
  let validationSnapshot = null;

  async function get() {
    if (inFlight) {
      emit("join");
      return inFlight;
    }

    emit("request");
    const operation = refreshWithRetries();
    inFlight = operation;
    try {
      const representation = await operation;
      emit("success");
      return representation;
    } catch (error) {
      emit("failure", { code: safeErrorCode(error) });
      throw error;
    } finally {
      if (inFlight === operation) inFlight = null;
    }
  }

  async function refreshWithRetries() {
    for (let retry = 0; ; retry += 1) {
      try {
        return await refresh();
      } catch (error) {
        if (error?.code !== "canonical_revision_changed") throw error;
        if (retry >= revisionRetries) {
          throw new ObservatoryPathError(
            "canonical_revision_changed",
            "The project records kept changing while the view was being prepared. Wait a moment and reload; it will work once the writing pauses.",
            409,
            { retryable: true, cause: error },
          );
        }
        emit("retry_changed_revision", { attempt: retry + 1 });
        // Linear backoff keeps the total wait short while giving a writer time to finish.
        await sleep(revisionRetryBackoffMs * (retry + 1));
      }
    }
  }

  async function refresh() {
    const hasValidationSnapshot = Boolean(cached && validationSnapshot);
    if (!projectIdentity) {
      projectIdentity = await captureDirectoryIdentity(projectRoot, {
        code: "project_boundary_changed",
        label: "project root",
      });
    } else if (!hasValidationSnapshot) {
      await assertDirectoryIdentity(projectIdentity);
    }

    if (hasValidationSnapshot) {
      let valid;
      try {
        valid = await validateCanonicalSnapshot(projectIdentity, validationSnapshot, {
          concurrency: validationConcurrency,
          onCheck: onFastPathCheck,
          synchronousMetadataValidation,
          trustDirectoryChangeStamp: validationRuntime.platform !== "win32",
        });
      } catch (error) {
        validationSnapshot = null;
        throw error;
      }
      if (!valid) {
        validationSnapshot = null;
        // A failed snapshot check may have observed a project-root change.
        // Preserve the boundary error before the slower rescan can translate
        // a missing or replaced root into a less precise availability error.
        await assertDirectoryIdentity(projectIdentity);
      }
      if (valid) {
        emit("fast_hit");
        return cached;
      }
    }

    let beforeScan = await scanCanonicalRevision(projectIdentity.root, {
      limits,
      previousDigestIndex: digestIndex,
    });
    digestIndex = beforeScan.digestIndex;
    await assertDirectoryIdentity(projectIdentity);

    if (cached && cached.revision === beforeScan.revision) {
      validationSnapshot = beforeScan.validationSnapshot;
      emit("revision_hit");
      return cached;
    }

    let beforeRevision = beforeScan.revision;
    let beforeDigestIndex = beforeScan.digestIndex;
    beforeScan = null;

    for (let attempt = 0; attempt < stabilityAttempts; attempt += 1) {
      emit("build_start", { attempt: attempt + 1 });
      let model = await buildModel();
      const body = normalizeSerializedBody(await serialize(model));
      model = null;
      let after = await scanCanonicalRevision(projectIdentity.root, {
        limits,
        previousDigestIndex: beforeDigestIndex,
      });
      digestIndex = after.digestIndex;
      await assertDirectoryIdentity(projectIdentity);

      if (beforeRevision === after.revision) {
        const entry = Object.freeze({
          revision: after.revision,
          etag: strongEtag(body),
          body,
        });
        cached = entry;
        validationSnapshot = after.validationSnapshot;
        emit("build_success", { attempt: attempt + 1 });
        return entry;
      }
      emit("retry", { attempt: attempt + 1 });
      beforeRevision = after.revision;
      beforeDigestIndex = after.digestIndex;
      after = null;
    }

    throw new ObservatoryPathError(
      "canonical_revision_changed",
      "Canonical evidence changed while the Observatory model was being built",
      409,
      { retryable: true },
    );
  }

  return Object.freeze({
    get,
    clear() {
      cached = null;
      validationSnapshot = null;
      emit("clear");
    },
  });

  function emit(type, details = {}) {
    if (!onEvent) return;
    try {
      onEvent(Object.freeze({ type, ...details }));
    } catch {
      // Observability must never change the governed read result.
    }
  }
}

function safeErrorCode(error) {
  const code = String(error?.code || "internal_error");
  return /^[a-z0-9_.-]{1,64}$/iu.test(code) ? code.toLowerCase() : "internal_error";
}

export async function computeCanonicalRevision(projectRoot, options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Canonical revision options must be an object");
  }
  if (options.onDirectorySnapshot !== undefined && typeof options.onDirectorySnapshot !== "function") {
    throw new TypeError("Canonical revision onDirectorySnapshot must be a function");
  }
  if (options.onFileReadChunk !== undefined && typeof options.onFileReadChunk !== "function") {
    throw new TypeError("Canonical revision onFileReadChunk must be a function");
  }
  const scan = await scanCanonicalRevision(projectRoot, {
    limits: normalizeObservatoryLimits(options.limits),
    onDirectorySnapshot: options.onDirectorySnapshot ?? null,
    onFileReadChunk: options.onFileReadChunk ?? null,
    previousDigestIndex: new Map(),
  });
  return scan.revision;
}

async function scanCanonicalRevision(projectRoot, {
  limits,
  onDirectorySnapshot = null,
  onFileReadChunk = null,
  previousDigestIndex,
}) {
  const boundary = await resolveKnowledgeBaseBoundary(projectRoot, { allowMissing: true });
  const projectIdentity = await captureDirectoryIdentity(boundary.projectRoot, {
    code: "project_boundary_changed",
    label: "project root",
  });
  const revision = crypto.createHash("sha256");
  appendHashField(revision, REVISION_FORMAT);

  if (!boundary.knowledgeBaseRoot) {
    appendRevisionRecord(revision, "knowledge-base", ".sdlc", "missing");
    await assertDirectoryIdentity(projectIdentity);
    return {
      revision: revision.digest("hex"),
      digestIndex: new Map(),
      validationSnapshot: emptyValidationSnapshot(boundary.projectRoot, limits.maxEntries),
    };
  }

  const knowledgeBaseIdentity = await captureDirectoryIdentity(boundary.knowledgeBaseRoot, {
    code: "knowledge_base_boundary_changed",
    label: "project knowledge base",
  });
  const state = {
    digestIndex: new Map(),
    directorySnapshotBudget: createDirectorySnapshotBudget(limits),
    entryBudget: createEntryBudget(limits.maxEntries),
    directoryObservations: [],
    fileCount: 0,
    fileObservations: [],
    limitRecorded: false,
    symlinkObservations: [],
    totalBytes: 0n,
    unreadableEntryObservations: [],
    stopped: false,
    limits,
    onDirectorySnapshot,
    onFileReadChunk,
    previousDigestIndex,
    revision,
    root: boundary.knowledgeBaseRoot,
  };

  appendRevisionRecord(revision, "knowledge-base", ".sdlc", "present");
  await walkCanonicalDirectory(state, boundary.knowledgeBaseRoot, "", 0);
  await verifyObservations(state);
  await assertDirectoryIdentity(knowledgeBaseIdentity);
  await assertDirectoryIdentity(projectIdentity);

  return {
    revision: revision.digest("hex"),
    digestIndex: state.digestIndex,
    validationSnapshot: createValidationSnapshot(knowledgeBaseIdentity, state),
  };
}

function emptyValidationSnapshot(projectRoot, maxEntries) {
  return Object.freeze({
    directoryObservations: Object.freeze([]),
    fileObservations: Object.freeze([]),
    knowledgeBaseIdentity: null,
    knowledgeBasePath: path.join(projectRoot, ".sdlc"),
    maxEntries,
    root: null,
    symlinkObservations: Object.freeze([]),
    unreadableEntryObservations: Object.freeze([]),
  });
}

function createValidationSnapshot(knowledgeBaseIdentity, state) {
  return Object.freeze({
    directoryObservations: Object.freeze(state.directoryObservations.slice()),
    fileObservations: Object.freeze(state.fileObservations.slice()),
    knowledgeBaseIdentity,
    knowledgeBasePath: knowledgeBaseIdentity.root,
    maxEntries: state.limits.maxEntries,
    root: state.root,
    symlinkObservations: Object.freeze(state.symlinkObservations.slice()),
    unreadableEntryObservations: Object.freeze(state.unreadableEntryObservations.slice()),
  });
}

async function validateCanonicalSnapshot(projectIdentity, snapshot, {
  concurrency,
  onCheck,
  synchronousMetadataValidation,
  trustDirectoryChangeStamp,
}) {
  try {
    await assertDirectoryIdentity(projectIdentity);
    if (!snapshot.knowledgeBaseIdentity) {
      const missing = await knowledgeBaseStillMissing(snapshot.knowledgeBasePath);
      await assertDirectoryIdentity(projectIdentity);
      return missing;
    }
    if (!await directoryIdentityMatches(snapshot.knowledgeBaseIdentity)) return false;

    const inspectMetadata = synchronousMetadataValidation ? inspectLstatSync : inspectLstat;
    const groups = [
      ["file", snapshot.fileObservations, (observation) => (
        validateFileObservation(observation, inspectMetadata)
      )],
      ["symlink", snapshot.symlinkObservations, (observation) => (
        validateSymlinkObservation(snapshot.root, observation, inspectMetadata)
      )],
      ["unreadable", snapshot.unreadableEntryObservations, (observation) => (
        validateUnreadableEntryObservation(observation, inspectMetadata)
      )],
    ];
    for (const [kind, observations, validate] of groups) {
      const valid = await runBoundedChecks(observations, {
        concurrency,
        kind,
        onCheck,
        validate,
      });
      if (!valid) return false;
    }

    const directoryEntryBudget = createEntryBudget(snapshot.maxEntries);
    const directoriesValid = await runBoundedChecks(snapshot.directoryObservations, {
      concurrency,
      kind: "directory",
      onCheck,
      validate: synchronousMetadataValidation
        ? (observation) => validateDirectoryObservationSync(observation, directoryEntryBudget)
        : (observation) => validateDirectoryObservation(
          observation,
          directoryEntryBudget,
          trustDirectoryChangeStamp,
        ),
    });
    if (!directoriesValid) return false;
    if (!await directoryIdentityMatches(snapshot.knowledgeBaseIdentity)) return false;
    await assertDirectoryIdentity(projectIdentity);
    return true;
  } catch (error) {
    if (error instanceof ObservatoryPathError) {
      if (error.code === "project_boundary_changed") throw error;
      return false;
    }
    throw error;
  }
}

async function runBoundedChecks(observations, {
  concurrency,
  kind,
  onCheck,
  validate,
}) {
  if (observations.length === 0) return true;
  let cursor = 0;
  let valid = true;

  async function worker() {
    while (valid) {
      const index = cursor;
      cursor += 1;
      if (index >= observations.length) return;
      const observation = observations[index];
      const event = onCheck ? Object.freeze({ kind, path: observation.path }) : null;
      if (event) await onCheck(Object.freeze({ ...event, event: "start" }));
      try {
        const outcome = validate(observation);
        if (!(isPromiseLike(outcome) ? await outcome : outcome)) valid = false;
      } finally {
        if (event) await onCheck(Object.freeze({ ...event, event: "end" }));
      }
    }
  }

  const workerCount = Math.min(concurrency, observations.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return valid;
}

function validateFileObservation(observation, inspectMetadata = inspectLstat) {
  const inspection = inspectMetadata(observation.path);
  if (isPromiseLike(inspection)) {
    return inspection.then((current) => validateInspectedFileObservation(current, observation));
  }
  return validateInspectedFileObservation(inspection, observation);
}

function validateInspectedFileObservation(current, observation) {
  if (
    !current.readable
    || !current.stats.isFile()
    || !statMatchesSignature(current.stats, observation.signature)
  ) {
    return false;
  }
  if (observation.readable !== false) return true;
  return probeStableFile(observation.path, observation.signature).then((probe) => !probe.readable);
}

async function validateSymlinkObservation(root, observation, inspectMetadata = inspectLstat) {
  const current = await inspectMetadata(observation.path);
  if (
    !current.readable
    || !current.stats.isSymbolicLink()
    || !statMatchesSignature(current.stats, observation.signature)
  ) {
    return false;
  }
  let target;
  try {
    target = await fs.readlink(observation.path);
  } catch (error) {
    if (isRaceError(error) || error?.code === "ELOOP") {
      throw boundaryChanged("A symbolic link changed while canonical evidence was inspected", error);
    }
    return observation.unreadable;
  }
  if (observation.unreadable || target !== observation.target) return false;
  return await resolveSymlinkState(root, observation.path) === observation.resolution;
}

function validateUnreadableEntryObservation(observation, inspectMetadata = inspectLstat) {
  const inspection = inspectMetadata(observation.path);
  return isPromiseLike(inspection)
    ? inspection.then((current) => !current.readable)
    : !inspection.readable;
}

async function validateDirectoryObservation(
  observation,
  entryBudget,
  trustDirectoryChangeStamp = process.platform !== "win32",
) {
  const current = await inspectLstat(observation.path);
  if (
    !current.readable
    || !current.stats.isDirectory()
    || !statMatchesSignature(current.stats, observation.signature)
  ) {
    return false;
  }
  if (
    trustDirectoryChangeStamp
    && directoryChangeStampMatches(current.stats, observation.changeStamp)
  ) return true;
  if (observation.readable === null) return true;
  const directoryRead = Array.isArray(observation.snapshot)
    ? await readAndMatchDirectDirectorySnapshot(observation.path, observation.snapshot, {
      aggregateBudget: entryBudget,
      maxEntries: observation.entryLimit,
    })
    : await readDirectoryEntries(observation.path, {
      aggregateBudget: entryBudget,
      maxEntries: observation.entryLimit,
    });
  const valid = directoryRead.readable === observation.readable
    && (observation.maxEntriesExceeded
      ? directoryRead.maxEntriesExceeded
      : !directoryRead.maxEntriesExceeded && (
        !directoryRead.readable || (directoryRead.matchesSnapshot
          ?? directoryEntriesMatchSnapshot(directoryRead.entries, observation.snapshot))
      ));
  if (!valid) return false;
  const after = await inspectLstat(observation.path);
  if (
    !after.readable
    || !after.stats.isDirectory()
    || !statMatchesSignature(after.stats, observation.signature)
  ) {
    return false;
  }
  observation.changeStamp = createDirectoryChangeStamp(after.stats);
  return true;
}

function validateDirectoryObservationSync(observation, entryBudget) {
  const current = inspectLstatSync(observation.path);
  if (
    !current.readable
    || !current.stats.isDirectory()
    || !statMatchesSignature(current.stats, observation.signature)
  ) {
    return false;
  }
  // This path is selected only for the dedicated Windows worker. Windows
  // timestamps are caller-restorable, so the ordered snapshot remains the
  // authoritative topology proof on every warm request.
  if (observation.readable === null) return true;
  const directoryRead = Array.isArray(observation.snapshot)
    ? readAndMatchDirectDirectorySnapshotSync(observation.path, observation.snapshot, {
      aggregateBudget: entryBudget,
      maxEntries: observation.entryLimit,
    })
    : readDirectoryEntriesSync(observation.path, {
      aggregateBudget: entryBudget,
      maxEntries: observation.entryLimit,
    });
  const valid = directoryRead.readable === observation.readable
    && (observation.maxEntriesExceeded
      ? directoryRead.maxEntriesExceeded
      : !directoryRead.maxEntriesExceeded && (
        !directoryRead.readable || (directoryRead.matchesSnapshot
          ?? directoryEntriesMatchSnapshot(directoryRead.entries, observation.snapshot))
      ));
  if (!valid) return false;
  const after = inspectLstatSync(observation.path);
  if (
    !after.readable
    || !after.stats.isDirectory()
    || !statMatchesSignature(after.stats, observation.signature)
  ) {
    return false;
  }
  observation.changeStamp = createDirectoryChangeStamp(after.stats);
  return true;
}

async function directoryIdentityMatches(identity) {
  try {
    await assertDirectoryIdentity(identity);
    return true;
  } catch (error) {
    if (error instanceof ObservatoryPathError) return false;
    throw error;
  }
}

async function knowledgeBaseStillMissing(knowledgeBasePath) {
  try {
    await fs.lstat(knowledgeBasePath);
    return false;
  } catch (error) {
    return error?.code === "ENOENT";
  }
}

async function walkCanonicalDirectory(state, directory, relativeDirectory, depth) {
  const inspected = await inspectLstat(directory);
  if (!inspected.readable) {
    throw unavailablePath("Canonical evidence could not be inspected", inspected.error);
  }
  const before = inspected.stats;
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw boundaryChanged("A canonical evidence directory changed while its revision was read");
  }
  const directorySignature = createDirectoryStatSignature(before);
  const observation = {
    changeStamp: createDirectoryChangeStamp(before),
    entryLimit: state.entryBudget.remaining,
    maxEntriesExceeded: false,
    path: directory,
    readable: null,
    signature: directorySignature,
    snapshot: null,
  };
  state.directoryObservations.push(observation);

  if (depth > state.limits.maxDepth) {
    appendRevisionRecord(
      state.revision,
      "depth-limit",
      toCanonicalPath(relativeDirectory),
      String(state.limits.maxDepth),
    );
    return;
  }

  const directoryRead = await readDirectoryEntries(directory, {
    aggregateBudget: state.entryBudget,
    maxEntries: observation.entryLimit,
  });
  observation.readable = directoryRead.readable;
  observation.maxEntriesExceeded = directoryRead.maxEntriesExceeded;
  if (directoryRead.maxEntriesExceeded) {
    stopAtLimit(
      state,
      "max-entries",
      toCanonicalPath(relativeDirectory),
      state.limits.maxEntries,
    );
    return;
  }
  if (!directoryRead.readable) {
    appendRevisionRecord(
      state.revision,
      "directory-unreadable",
      toCanonicalPath(relativeDirectory),
      "unreadable",
    );
    return;
  }
  observation.snapshot = createBoundedDirectorySnapshot(
    directoryRead.entries,
    state.directorySnapshotBudget,
  );
  if (state.onDirectorySnapshot) {
    await state.onDirectorySnapshot(Object.freeze({
      path: toCanonicalPath(relativeDirectory),
      snapshot: directorySnapshotDigest(observation.snapshot),
    }));
  }

  for (const entry of relativeDirectory ? directoryRead.entries : orderKnowledgeBaseEntries(directoryRead.entries)) {
    if (state.stopped) break;
    const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (!isContainedPath(state.root, absolute)) {
      throw new ObservatoryPathError(
        "knowledge_base_escape",
        "Canonical evidence resolved outside the project knowledge base",
        403,
      );
    }
    if (
      entry.isFile()
      && SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
      && state.fileCount >= state.limits.maxFiles
    ) {
      stopAtLimit(state, "max-files", ".sdlc", state.limits.maxFiles);
      break;
    }

    const entryInspection = await inspectLstat(absolute);
    if (!entryInspection.readable) {
      recordUnreadableEntry(state, entry, absolute, relative);
      continue;
    }
    const stats = entryInspection.stats;
    if (stats.isSymbolicLink()) {
      await recordSymlink(state, absolute, relative, stats);
      continue;
    }
    if (stats.isDirectory()) {
      if (relativeDirectory === "" && DERIVED_DIRECTORIES.has(entry.name.toLowerCase())) {
        continue;
      }
      await walkCanonicalDirectory(state, absolute, relative, depth + 1);
      continue;
    }
    if (!stats.isFile() || !SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      continue;
    }
    await recordCanonicalFile(state, absolute, relative, stats);
  }
}

async function recordCanonicalFile(state, absolute, relative, initialStats) {
  if (state.fileCount >= state.limits.maxFiles) {
    stopAtLimit(state, "max-files", ".sdlc", state.limits.maxFiles);
    return;
  }
  state.fileCount += 1;

  const signature = createStatSignature(initialStats);
  const observation = { path: absolute, readable: null, signature };
  state.fileObservations.push(observation);
  const size = initialStats.size;
  if (size > BigInt(state.limits.maxFileBytes)) {
    appendRevisionRecord(
      state.revision,
      "file-too-large",
      toCanonicalPath(relative),
      String(size),
    );
    return;
  }
  if (state.totalBytes + size > BigInt(state.limits.maxTotalBytes)) {
    stopAtLimit(
      state,
      "max-total-bytes",
      toCanonicalPath(relative),
      state.limits.maxTotalBytes,
    );
    return;
  }

  const previous = state.previousDigestIndex.get(relative);
  let read;

  if (previous && statMatchesSignature(initialStats, previous.signature)) {
    read = await probeStableFile(absolute, signature);
    if (read.readable) read.digest = previous.digest;
  } else {
    read = await hashStableFile(absolute, signature, state.onFileReadChunk);
  }
  if (!read.readable) {
    observation.readable = false;
    appendRevisionRecord(
      state.revision,
      "file-unreadable",
      toCanonicalPath(relative),
      "unreadable",
    );
    return;
  }

  observation.readable = true;
  state.totalBytes += size;
  state.digestIndex.set(relative, { digest: read.digest, signature });
  appendRevisionRecord(state.revision, "file", toCanonicalPath(relative), read.digest);
}

async function recordSymlink(state, absolute, relative, initialStats) {
  const signature = createStatSignature(initialStats);
  let target;
  try {
    target = await fs.readlink(absolute);
  } catch (error) {
    if (isRaceError(error) || error?.code === "ELOOP") {
      throw boundaryChanged("A symbolic link changed while canonical evidence was inspected", error);
    }
    state.symlinkObservations.push({
      path: absolute,
      resolution: null,
      signature,
      target: null,
      unreadable: true,
    });
    appendRevisionRecord(
      state.revision,
      "symlink-unreadable",
      toCanonicalPath(relative),
      "unreadable",
    );
    return;
  }

  const resolution = await resolveSymlinkState(state.root, absolute);

  state.symlinkObservations.push({
    path: absolute,
    resolution,
    signature,
    target,
    unreadable: false,
  });
  appendRevisionRecord(
    state.revision,
    "symlink",
    toCanonicalPath(relative),
    `${target}\0${resolution}`,
  );
}

async function hashStableFile(absolute, expectedSignature, onFileReadChunk = null) {
  let handle;
  try {
    handle = await fs.open(absolute, fsConstants.O_RDONLY | NO_FOLLOW_FLAG);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !statMatchesSignature(before, expectedSignature)) {
      throw boundaryChanged("Canonical evidence changed while its revision was read");
    }
    const digest = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1_024);
    let totalBytes = 0n;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
      totalBytes += BigInt(bytesRead);
      if (totalBytes > expectedSignature.size) {
        throw boundaryChanged("Canonical evidence grew while its revision was read");
      }
      if (onFileReadChunk) {
        await onFileReadChunk(Object.freeze({
          path: absolute,
          bytesRead,
          totalBytes: Number(totalBytes),
          expectedBytes: Number(expectedSignature.size),
        }));
      }
    }
    const after = await handle.stat({ bigint: true });
    if (!statMatchesSignature(after, expectedSignature) || totalBytes !== after.size) {
      throw boundaryChanged("Canonical evidence changed while its revision was read");
    }
    return { readable: true, digest: digest.digest("hex") };
  } catch (error) {
    if (error instanceof ObservatoryPathError) throw error;
    if (isRaceError(error) || ["EISDIR", "ELOOP"].includes(error?.code)) {
      throw boundaryChanged("Canonical evidence changed while its revision was read", error);
    }
    return { readable: false };
  } finally {
    await closeQuietly(handle);
  }
}

async function probeStableFile(absolute, expectedSignature) {
  let handle;
  try {
    handle = await fs.open(absolute, fsConstants.O_RDONLY | NO_FOLLOW_FLAG);
    const stats = await handle.stat({ bigint: true });
    if (!stats.isFile() || !statMatchesSignature(stats, expectedSignature)) {
      throw boundaryChanged("Canonical evidence changed while its revision was read");
    }
    return { readable: true, digest: null };
  } catch (error) {
    if (error instanceof ObservatoryPathError) throw error;
    if (isRaceError(error) || ["EISDIR", "ELOOP"].includes(error?.code)) {
      throw boundaryChanged("Canonical evidence changed while its revision was read", error);
    }
    return { readable: false };
  } finally {
    await closeQuietly(handle);
  }
}

async function verifyObservations(state) {
  const directoryEntryBudget = createEntryBudget(state.limits.maxEntries);
  for (const observation of state.fileObservations) {
    const current = await inspectLstat(observation.path);
    if (
      !current.readable
      || !current.stats.isFile()
      || !statMatchesSignature(current.stats, observation.signature)
    ) {
      throw boundaryChanged("Canonical evidence changed while its revision was read");
    }
  }
  for (const observation of state.symlinkObservations) {
    const current = await inspectLstat(observation.path);
    if (
      !current.readable
      || !current.stats.isSymbolicLink()
      || !statMatchesSignature(current.stats, observation.signature)
    ) {
      throw boundaryChanged("A symbolic link changed while canonical evidence was inspected");
    }
    let target;
    try {
      target = await fs.readlink(observation.path);
    } catch (error) {
      if (isRaceError(error) || error?.code === "ELOOP" || !observation.unreadable) {
        throw boundaryChanged("A symbolic link changed while canonical evidence was inspected", error);
      }
      continue;
    }
    if (observation.unreadable || target !== observation.target) {
      throw boundaryChanged("A symbolic link changed while canonical evidence was inspected");
    }
    const resolution = await resolveSymlinkState(state.root, observation.path);
    if (resolution !== observation.resolution) {
      throw boundaryChanged("A symbolic link changed while canonical evidence was inspected");
    }
  }
  for (const observation of state.unreadableEntryObservations) {
    const current = await inspectLstat(observation.path);
    if (current.readable) {
      throw boundaryChanged("Canonical evidence readability changed while its revision was read");
    }
  }
  for (let index = state.directoryObservations.length - 1; index >= 0; index -= 1) {
    const observation = state.directoryObservations[index];
    const current = await inspectLstat(observation.path);
    if (
      !current.readable
      || !current.stats.isDirectory()
      || !statMatchesSignature(current.stats, observation.signature)
    ) {
      throw boundaryChanged("A canonical evidence directory changed while its revision was read");
    }
    if (observation.readable === null) continue;
    const directoryRead = Array.isArray(observation.snapshot)
      ? await readAndMatchDirectDirectorySnapshot(observation.path, observation.snapshot, {
        aggregateBudget: directoryEntryBudget,
        maxEntries: observation.entryLimit,
      })
      : await readDirectoryEntries(observation.path, {
        aggregateBudget: directoryEntryBudget,
        maxEntries: observation.entryLimit,
      });
    if (
      directoryRead.readable !== observation.readable
      || (observation.maxEntriesExceeded
        ? !directoryRead.maxEntriesExceeded
        : directoryRead.maxEntriesExceeded || (
          directoryRead.readable && !(directoryRead.matchesSnapshot
            ?? directoryEntriesMatchSnapshot(directoryRead.entries, observation.snapshot))
        ))
    ) {
      throw boundaryChanged("A canonical evidence directory changed while its revision was read");
    }
    observation.changeStamp = createDirectoryChangeStamp(current.stats);
  }
}

async function resolveSymlinkState(root, symbolicLink) {
  try {
    const resolved = await fs.realpath(symbolicLink);
    return `${isContainedPath(root, resolved) ? "contained" : "escaped"}:${resolved}`;
  } catch (error) {
    return `unresolved:${error?.code ?? "unknown"}`;
  }
}

async function inspectLstat(target) {
  try {
    return { readable: true, stats: await fs.lstat(target, { bigint: true }) };
  } catch (error) {
    if (isRaceError(error)) {
      throw boundaryChanged("Canonical evidence changed while its revision was read", error);
    }
    return { readable: false, error };
  }
}

function inspectLstatSync(target) {
  try {
    return { readable: true, stats: lstatSync(target, { bigint: true }) };
  } catch (error) {
    if (isRaceError(error)) {
      throw boundaryChanged("Canonical evidence changed while its revision was read", error);
    }
    return { readable: false, error };
  }
}

function isPromiseLike(value) {
  return value !== null
    && (typeof value === "object" || typeof value === "function")
    && typeof value.then === "function";
}

async function readDirectoryEntries(directory, {
  aggregateBudget = null,
  maxEntries = MAX_DIRECTORY_ENTRIES,
} = {}) {
  const entries = [];
  let handle;
  let inspectedEntries = 0;
  try {
    // Read one bounded entry at a time without the async iterator's retained
    // iterator state. Windows overlaps filesystem latency across the bounded
    // worker pool; POSIX keeps the lower-memory synchronous stream.
    handle = USE_ASYNC_DIRECTORY_HANDLES
      ? await fs.opendir(directory)
      : opendirSync(directory);
    while (true) {
      const entry = USE_ASYNC_DIRECTORY_HANDLES
        ? await handle.read()
        : handle.readSync();
      if (entry === null) break;
      inspectedEntries += 1;
      if (entries.length >= MAX_DIRECTORY_ENTRIES) {
        throw new ObservatoryPathError(
          "directory_entry_limit_exceeded",
          "A canonical evidence directory exceeds the safe entry limit",
          413,
        );
      }
      if (entries.length >= maxEntries || (aggregateBudget && aggregateBudget.remaining <= 0)) {
        return {
          entries: [],
          inspectedEntries,
          maxEntriesExceeded: true,
          readable: true,
        };
      }
      entries.push(entry);
      if (aggregateBudget) aggregateBudget.remaining -= 1;
    }
  } catch (error) {
    if (error instanceof ObservatoryPathError) throw error;
    if (isRaceError(error)) {
      throw boundaryChanged("A canonical evidence directory changed while its revision was read", error);
    }
    return {
      entries: [],
      inspectedEntries,
      maxEntriesExceeded: false,
      readable: false,
    };
  } finally {
    if (USE_ASYNC_DIRECTORY_HANDLES) await closeQuietly(handle);
    else closeDirectoryQuietly(handle);
  }
  entries.sort((left, right) => compareStrings(left.name, right.name));
  return {
    entries,
    inspectedEntries,
    maxEntriesExceeded: false,
    readable: true,
  };
}

function readDirectoryEntriesSync(directory, {
  aggregateBudget = null,
  maxEntries = MAX_DIRECTORY_ENTRIES,
} = {}) {
  const entries = [];
  let handle;
  let inspectedEntries = 0;
  try {
    handle = opendirSync(directory);
    while (true) {
      const entry = handle.readSync();
      if (entry === null) break;
      inspectedEntries += 1;
      if (entries.length >= MAX_DIRECTORY_ENTRIES) {
        throw new ObservatoryPathError(
          "directory_entry_limit_exceeded",
          "A canonical evidence directory exceeds the safe entry limit",
          413,
        );
      }
      if (entries.length >= maxEntries || (aggregateBudget && aggregateBudget.remaining <= 0)) {
        return {
          entries: [],
          inspectedEntries,
          maxEntriesExceeded: true,
          readable: true,
        };
      }
      entries.push(entry);
      if (aggregateBudget) aggregateBudget.remaining -= 1;
    }
  } catch (error) {
    if (error instanceof ObservatoryPathError) throw error;
    if (isRaceError(error)) {
      throw boundaryChanged("A canonical evidence directory changed while its revision was read", error);
    }
    return {
      entries: [],
      inspectedEntries,
      maxEntriesExceeded: false,
      readable: false,
    };
  } finally {
    closeDirectoryQuietly(handle);
  }
  entries.sort((left, right) => compareStrings(left.name, right.name));
  return {
    entries,
    inspectedEntries,
    maxEntriesExceeded: false,
    readable: true,
  };
}

async function readAndMatchDirectDirectorySnapshot(directory, snapshot, {
  aggregateBudget = null,
  maxEntries = MAX_DIRECTORY_ENTRIES,
} = {}) {
  let handle;
  let retainedEntries = 0;
  let inspectedEntries = 0;
  let matchesSnapshot = true;
  try {
    handle = USE_ASYNC_DIRECTORY_HANDLES
      ? await fs.opendir(directory)
      : opendirSync(directory);
    while (true) {
      const entry = USE_ASYNC_DIRECTORY_HANDLES
        ? await handle.read()
        : handle.readSync();
      if (entry === null) break;
      inspectedEntries += 1;
      if (retainedEntries >= MAX_DIRECTORY_ENTRIES) {
        throw new ObservatoryPathError(
          "directory_entry_limit_exceeded",
          "A canonical evidence directory exceeds the safe entry limit",
          413,
        );
      }
      if (retainedEntries >= maxEntries || (aggregateBudget && aggregateBudget.remaining <= 0)) {
        return {
          inspectedEntries,
          matchesSnapshot: false,
          maxEntriesExceeded: true,
          readable: true,
        };
      }
      retainedEntries += 1;
      if (aggregateBudget) aggregateBudget.remaining -= 1;
      if (!directDirectorySnapshotContains(snapshot, entry.name, directoryEntryType(entry))) {
        matchesSnapshot = false;
      }
    }
  } catch (error) {
    if (error instanceof ObservatoryPathError) throw error;
    if (isRaceError(error)) {
      throw boundaryChanged("A canonical evidence directory changed while its revision was read", error);
    }
    return {
      inspectedEntries,
      matchesSnapshot: false,
      maxEntriesExceeded: false,
      readable: false,
    };
  } finally {
    if (USE_ASYNC_DIRECTORY_HANDLES) await closeQuietly(handle);
    else closeDirectoryQuietly(handle);
  }
  return {
    inspectedEntries,
    matchesSnapshot: matchesSnapshot && retainedEntries * 2 === snapshot.length,
    maxEntriesExceeded: false,
    readable: true,
  };
}

function readAndMatchDirectDirectorySnapshotSync(directory, snapshot, {
  aggregateBudget = null,
  maxEntries = MAX_DIRECTORY_ENTRIES,
} = {}) {
  let handle;
  let retainedEntries = 0;
  let inspectedEntries = 0;
  let matchesSnapshot = true;
  try {
    handle = opendirSync(directory);
    while (true) {
      const entry = handle.readSync();
      if (entry === null) break;
      inspectedEntries += 1;
      if (retainedEntries >= MAX_DIRECTORY_ENTRIES) {
        throw new ObservatoryPathError(
          "directory_entry_limit_exceeded",
          "A canonical evidence directory exceeds the safe entry limit",
          413,
        );
      }
      if (retainedEntries >= maxEntries || (aggregateBudget && aggregateBudget.remaining <= 0)) {
        return {
          inspectedEntries,
          matchesSnapshot: false,
          maxEntriesExceeded: true,
          readable: true,
        };
      }
      retainedEntries += 1;
      if (aggregateBudget) aggregateBudget.remaining -= 1;
      if (!directDirectorySnapshotContains(snapshot, entry.name, directoryEntryType(entry))) {
        matchesSnapshot = false;
      }
    }
  } catch (error) {
    if (error instanceof ObservatoryPathError) throw error;
    if (isRaceError(error)) {
      throw boundaryChanged("A canonical evidence directory changed while its revision was read", error);
    }
    return {
      inspectedEntries,
      matchesSnapshot: false,
      maxEntriesExceeded: false,
      readable: false,
    };
  } finally {
    closeDirectoryQuietly(handle);
  }
  return {
    inspectedEntries,
    matchesSnapshot: matchesSnapshot && retainedEntries * 2 === snapshot.length,
    maxEntriesExceeded: false,
    readable: true,
  };
}

function directDirectorySnapshotContains(snapshot, name, type) {
  let low = 0;
  let high = snapshot.length / 2 - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const offset = middle * 2;
    const comparison = compareStrings(name, snapshot[offset]);
    if (comparison === 0) return type === snapshot[offset + 1];
    if (comparison < 0) high = middle - 1;
    else low = middle + 1;
  }
  return false;
}

function closeDirectoryQuietly(handle) {
  if (!handle) return;
  try {
    handle.closeSync();
  } catch {
    // The read outcome is authoritative; a close failure must not replace it.
  }
}

function createEntryBudget(maxEntries) {
  return { remaining: maxEntries };
}

function createDirectorySnapshotBudget(limits) {
  return {
    remainingSlots: Math.min(
      MAX_DIRECT_DIRECTORY_SNAPSHOT_SLOTS,
      saturatingMultiply(limits.maxFiles, DIRECT_DIRECTORY_SNAPSHOT_SLOTS_PER_FILE),
    ),
    remainingNameBytes: Math.min(
      MAX_DIRECT_DIRECTORY_SNAPSHOT_NAME_BYTES,
      limits.maxTotalBytes,
      saturatingMultiply(limits.maxFiles, DIRECT_DIRECTORY_SNAPSHOT_NAME_BYTES_PER_FILE),
    ),
  };
}

function createBoundedDirectorySnapshot(entries, budget) {
  // Charge the two retained array cells per entry plus one directory slot.
  // Fallback remains the legacy fixed-size digest string, so the pre-existing
  // directory-observation count is not made more expensive by wide trees.
  const requiredSlots = entries.length * 2 + 1;
  let nameBytes = 0;
  for (const entry of entries) {
    nameBytes += Buffer.byteLength(entry.name, "utf8");
    if (nameBytes > budget.remainingNameBytes) break;
  }
  if (requiredSlots > budget.remainingSlots || nameBytes > budget.remainingNameBytes) {
    return hashDirectoryEntries(entries);
  }

  const snapshot = new Array(entries.length * 2);
  let offset = 0;
  for (const entry of entries) {
    snapshot[offset] = entry.name;
    snapshot[offset + 1] = directoryEntryType(entry);
    offset += 2;
  }
  budget.remainingSlots -= requiredSlots;
  budget.remainingNameBytes -= nameBytes;
  return Object.freeze(snapshot);
}

function directoryEntriesMatchSnapshot(entries, snapshot) {
  if (typeof snapshot === "string") return snapshot === hashDirectoryEntries(entries);
  if (!Array.isArray(snapshot) || entries.length * 2 !== snapshot.length) return false;
  let offset = 0;
  for (const entry of entries) {
    if (
      entry.name !== snapshot[offset]
      || directoryEntryType(entry) !== snapshot[offset + 1]
    ) return false;
    offset += 2;
  }
  return true;
}

function directorySnapshotDigest(snapshot) {
  if (typeof snapshot === "string") return snapshot;
  const hash = crypto.createHash("sha256");
  appendHashField(hash, DIRECTORY_SNAPSHOT_FORMAT);
  for (const field of snapshot) appendHashField(hash, field);
  return hash.digest("hex");
}

function hashDirectoryEntries(entries) {
  const hash = crypto.createHash("sha256");
  appendHashField(hash, DIRECTORY_SNAPSHOT_FORMAT);
  for (const entry of entries) {
    appendHashField(hash, entry.name);
    appendHashField(hash, directoryEntryType(entry));
  }
  return hash.digest("hex");
}

function saturatingMultiply(value, multiplier) {
  return value > Math.floor(Number.MAX_SAFE_INTEGER / multiplier)
    ? Number.MAX_SAFE_INTEGER
    : value * multiplier;
}

function recordUnreadableEntry(state, entry, absolute, relative) {
  let type = null;
  if (entry.isDirectory()) type = "directory-unreadable";
  if (entry.isSymbolicLink()) type = "symlink-unreadable";
  if (entry.isFile() && SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
    if (state.fileCount >= state.limits.maxFiles) {
      stopAtLimit(state, "max-files", ".sdlc", state.limits.maxFiles);
      return;
    }
    type = "file-unreadable";
  }
  if (!type) return;

  state.unreadableEntryObservations.push({ path: absolute });
  appendRevisionRecord(state.revision, type, toCanonicalPath(relative), "unreadable");
}

function stopAtLimit(state, code, markerPath, limit) {
  if (!state.limitRecorded) {
    appendRevisionRecord(state.revision, "limit", markerPath, `${code}:${limit}`);
    state.limitRecorded = true;
  }
  state.stopped = true;
}

function directoryEntryType(entry) {
  if (entry.isSymbolicLink()) return "symlink";
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  return "other";
}

function isRaceError(error) {
  return error?.code === "ENOENT" || error?.code === "ENOTDIR";
}

async function closeQuietly(handle) {
  if (!handle) return;
  try {
    await handle.close();
  } catch {
    // The read outcome is authoritative; a close failure must not replace it.
  }
}

function createStatSignature(stats) {
  // mtime is caller-controlled and can be restored after an in-place rewrite.
  // ctime makes that rewrite invalidate the fast path and digest reuse. A
  // metadata-only ctime change may cause a conservative rehash, but the
  // content revision still prevents an unnecessary model rebuild.
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  };
}

function createDirectoryStatSignature(stats) {
  // Directory timestamps and sizes are not portable content indicators.
  // Windows can publish a delayed mtime update after fixture creation even
  // though the ordered entry snapshot is unchanged. Identity and type remain
  // bound here; add/remove/rename/type changes are detected by the snapshot.
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
  };
}

function createDirectoryChangeStamp(stats) {
  return {
    ctimeNs: stats.ctimeNs,
    mtimeNs: stats.mtimeNs,
  };
}

function directoryChangeStampMatches(stats, stamp) {
  // On POSIX filesystems, directory ctime cannot be restored by a normal user
  // after add/remove/rename or metadata changes. The retained ordered snapshot
  // remains the authoritative fallback whenever the stamp changes. Windows
  // ctime semantics are not portable enough, so Windows always compares the
  // bounded directory entries.
  return process.platform !== "win32"
    && typeof stats.ctimeNs === "bigint"
    && stats.ctimeNs > 0n
    && stats.ctimeNs === stamp?.ctimeNs
    && stats.mtimeNs === stamp?.mtimeNs;
}

function statMatchesSignature(stats, signature) {
  return stats.dev === signature.dev
    && stats.ino === signature.ino
    && stats.mode === signature.mode
    && (signature.size === undefined || stats.size === signature.size)
    && (signature.mtimeNs === undefined || stats.mtimeNs === signature.mtimeNs)
    && (signature.ctimeNs === undefined || stats.ctimeNs === signature.ctimeNs);
}

function toCanonicalPath(relative) {
  return relative ? `.sdlc/${relative}` : ".sdlc";
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function appendRevisionRecord(hash, type, recordPath, value) {
  appendHashField(hash, type);
  appendHashField(hash, recordPath);
  appendHashField(hash, value);
}

function appendHashField(hash, value) {
  const content = String(value);
  hash.update(String(Buffer.byteLength(content, "utf8")));
  hash.update(":");
  hash.update(content, "utf8");
}

function serializeJson(model) {
  const json = JSON.stringify(model);
  if (typeof json !== "string") {
    throw new TypeError("Observatory model must be JSON serializable");
  }
  return `${json}\n`;
}

function normalizeSerializedBody(value) {
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  throw new TypeError("Observatory model serializer must return a string or byte buffer");
}

function strongEtag(body) {
  const digest = crypto.createHash("sha256").update(body).digest("base64url");
  return `"sha256-${digest}"`;
}

function boundaryChanged(message, cause) {
  return new ObservatoryPathError("canonical_revision_changed", message, 409, { retryable: true, cause });
}

function unavailablePath(message, cause) {
  return new ObservatoryPathError("canonical_revision_unavailable", message, 403, { cause });
}
