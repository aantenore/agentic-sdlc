import path from "node:path";
import { crypto, fs, process } from "./runtime/host.mjs";

const NO_FOLLOW_FLAG = fs.constants.O_NOFOLLOW || 0;

export class CanonicalStoreError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "CanonicalStoreError";
    this.code = code;
  }
}

/**
 * Open a synchronous, command-scoped read session rooted at one project.
 *
 * The store deliberately has no cross-command persistence. Cached bytes are
 * reused only while the path still resolves to the same regular file identity;
 * callers that write through another component can invalidate one path (or the
 * entire session) explicitly.
 */
export function openCanonicalStore({ root = process.cwd(), onMetric = null } = {}) {
  if (onMetric !== null && typeof onMetric !== "function") {
    throw new TypeError("Canonical store onMetric must be a function");
  }

  const rootPath = path.resolve(String(root));
  const rootIdentity = captureDirectoryIdentity(rootPath, {
    code: "invalid_root",
    label: "project root",
  });
  const cache = new Map();
  const counters = {
    read_text_calls: 0,
    read_json_calls: 0,
    hash_calls: 0,
    walk_calls: 0,
    cache_hits: 0,
    cache_misses: 0,
    cache_stale: 0,
    physical_reads: 0,
    bytes_read: 0,
    hash_computations: 0,
    json_parses: 0,
    files_walked: 0,
    invalidations: 0,
    entries_evicted: 0,
  };

  const emit = (type, details = {}) => {
    onMetric?.(Object.freeze({ type, ...details }));
  };

  const assertRootIdentity = () => {
    const current = captureDirectoryIdentity(rootPath, {
      code: "root_changed",
      label: "project root",
    });
    if (!sameDirectoryIdentity(current, rootIdentity)) {
      throw new CanonicalStoreError(
        "root_changed",
        `Project root changed during the canonical read session: ${rootPath}`,
      );
    }
  };

  // A verified snapshot is already bound to the original root, parent
  // directory, and regular-file identity. Re-check those identities after a
  // caller parses the captured bytes without walking and resolving every path
  // component a second time. The initial load still performs the complete
  // symlink and realpath validation below.
  const assertRootIdentityFast = () => {
    if (rootIdentity.ino === 0n) {
      assertRootIdentity();
      return;
    }
    let entry;
    try {
      entry = fs.lstatSync(rootPath, { bigint: true });
    } catch (error) {
      throw new CanonicalStoreError(
        "root_changed",
        `Unable to inspect project root during the canonical read session: ${rootPath}`,
        { cause: error },
      );
    }
    if (
      entry.isSymbolicLink()
      || !entry.isDirectory()
      || entry.dev !== rootIdentity.dev
      || entry.ino !== rootIdentity.ino
    ) {
      throw new CanonicalStoreError(
        "root_changed",
        `Project root changed during the canonical read session: ${rootPath}`,
      );
    }
  };

  const markCachedValueStale = (value) => {
    if (cache.get(value.key) !== value) return;
    cache.delete(value.key);
    counters.cache_stale += 1;
    emit("cache_stale", { path: value.key });
  };

  const assertLoadedValueUnchanged = (value) => {
    try {
      if (
        rootIdentity.ino === 0n
        || value.parentIdentity.ino === 0n
        || value.identity.ino === 0n
      ) {
        const currentSha256 = verifyLoadedValueByBytes(value);
        counters.cache_hits += 1;
        emit("cache_hit", { path: value.key });
        return currentSha256;
      }
      assertRootIdentityFast();
      assertDirectoryIdentity(value.parentPath, value.parentIdentity, "parent_changed");
      const current = fs.lstatSync(value.absolute, { bigint: true });
      if (current.isSymbolicLink()) {
        throw new CanonicalStoreError("symlink_forbidden", `Refusing symbolic link: ${value.key}`);
      }
      if (!current.isFile() || !sameFileIdentity(value.identity, fileIdentity(current))) {
        throw new CanonicalStoreError(
          "file_changed",
          `Canonical file changed after its verified snapshot was captured: ${value.key}`,
        );
      }
    } catch (error) {
      markCachedValueStale(value);
      if (
        error?.code === "ENOENT"
        || (error?.code === "parent_changed" && error?.cause?.code === "ENOENT")
      ) {
        throw new CanonicalStoreError(
          "path_missing",
          `Canonical path does not exist: ${value.key}`,
          { cause: error },
        );
      }
      throw error;
    }
    counters.cache_hits += 1;
    emit("cache_hit", { path: value.key });
    return hashLoadedBuffer(value);
  };

  const resolveCandidate = (input, { mustExist = false, fileOnly = false, directoryOnly = false } = {}) => {
    if (typeof input !== "string" || input.trim() === "") {
      throw new TypeError("Canonical store paths must be non-empty strings");
    }
    // Existing regular-file reads receive a second canonical containment check
    // below and a complete root check after the verified read. Other lookups,
    // especially missing-path inspection, retain the full root realpath proof.
    if (mustExist && fileOnly) assertRootIdentityFast();
    else assertRootIdentity();
    const absolute = path.resolve(rootPath, input);
    if (!isInsidePath(rootPath, absolute)) {
      throw new CanonicalStoreError(
        "path_outside_root",
        `Canonical path resolves outside the project root: ${input}`,
      );
    }
    assertNoSymlinkComponents(rootPath, absolute);

    let entry = null;
    try {
      entry = fs.lstatSync(absolute, { bigint: true });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (!entry) {
      if (mustExist) {
        // A fast pre-check cannot distinguish a missing leaf from an ancestor
        // swap that still resolves to the original root identity.
        assertRootIdentity();
        throw new CanonicalStoreError("path_missing", `Canonical path does not exist: ${input}`);
      }
      return { absolute, key: cacheKey(rootPath, absolute), entry: null };
    }
    if (entry.isSymbolicLink()) {
      throw new CanonicalStoreError("symlink_forbidden", `Refusing symbolic link: ${input}`);
    }

    const real = fs.realpathSync.native(absolute);
    if (!isInsidePath(rootIdentity.realpath, real)) {
      throw new CanonicalStoreError(
        "path_outside_root",
        `Canonical path resolves outside the project root: ${input}`,
      );
    }
    if (fileOnly && !entry.isFile()) {
      throw new CanonicalStoreError("not_a_file", `Canonical path is not a regular file: ${input}`);
    }
    if (directoryOnly && !entry.isDirectory()) {
      throw new CanonicalStoreError("not_a_directory", `Canonical path is not a directory: ${input}`);
    }
    return { absolute, key: cacheKey(rootPath, absolute), entry };
  };

  const loadBuffer = (input, { maxBytes = null } = {}) => {
    const boundedBytes = normalizeOptionalPositiveLimit(maxBytes, "Canonical store maxBytes");
    const resolved = resolveCandidate(input, { mustExist: true, fileOnly: true });
    if (boundedBytes !== null && resolved.entry.size > BigInt(boundedBytes)) {
      throw new CanonicalStoreError(
        "file_too_large",
        `Canonical file exceeds the ${boundedBytes} byte read limit: ${resolved.key}`,
      );
    }
    const currentIdentity = fileIdentity(resolved.entry);
    const cached = cache.get(resolved.key);
    if (cached && sameFileIdentity(cached.identity, currentIdentity)) {
      counters.cache_hits += 1;
      emit("cache_hit", { path: resolved.key });
      return cached;
    }
    if (cached) {
      cache.delete(resolved.key);
      counters.cache_stale += 1;
      emit("cache_stale", { path: resolved.key });
    }
    counters.cache_misses += 1;

    const parentIdentity = captureDirectoryIdentity(path.dirname(resolved.absolute), {
      code: "parent_changed",
      label: "canonical file parent",
    });
    if (!isInsidePath(rootIdentity.realpath, parentIdentity.realpath)) {
      throw new CanonicalStoreError(
        "path_outside_root",
        `Canonical file parent resolves outside the project root: ${resolved.key}`,
      );
    }

    let descriptor;
    try {
      descriptor = fs.openSync(resolved.absolute, fs.constants.O_RDONLY | NO_FOLLOW_FLAG);
      const opened = verifyOpenFile(descriptor, resolved.absolute, parentIdentity);
      if (boundedBytes !== null && opened.size > BigInt(boundedBytes)) {
        throw new CanonicalStoreError(
          "file_too_large",
          `Canonical file exceeds the ${boundedBytes} byte read limit: ${resolved.key}`,
        );
      }
      const buffer = boundedBytes === null
        ? fs.readFileSync(descriptor)
        : readFileDescriptorBounded(
            descriptor,
            boundedBytes,
            Number(opened.size),
            resolved.key,
          );
      const completed = fileIdentity(fs.fstatSync(descriptor, { bigint: true }));
      if (!sameFileIdentity(opened, completed) || completed.size !== BigInt(buffer.length)) {
        throw new CanonicalStoreError(
          "file_changed",
          `Canonical file changed while it was being read: ${resolved.key}`,
        );
      }
      assertDirectoryIdentity(path.dirname(resolved.absolute), parentIdentity, "parent_changed");
      assertRootIdentity();
      const value = {
        absolute: resolved.absolute,
        buffer,
        identity: completed,
        key: resolved.key,
        parentIdentity,
        parentPath: path.dirname(resolved.absolute),
        sha256: null,
      };
      cache.set(resolved.key, value);
      counters.physical_reads += 1;
      counters.bytes_read += buffer.length;
      emit("physical_read", { path: resolved.key, bytes: buffer.length });
      return value;
    } catch (error) {
      if (error?.code === "ELOOP") {
        throw new CanonicalStoreError("symlink_forbidden", `Refusing symbolic link: ${resolved.key}`, {
          cause: error,
        });
      }
      throw error;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  };

  // Some filesystems do not expose a stable file index. On those systems the
  // optimized identity proof is unavailable, so verify the exact path and
  // bytes again instead of treating a zero index as a valid identity.
  const verifyLoadedValueByBytes = (value) => {
    const resolved = resolveCandidate(value.key, { mustExist: true, fileOnly: true });
    const parentIdentity = captureDirectoryIdentity(path.dirname(resolved.absolute), {
      code: "parent_changed",
      label: "canonical file parent",
    });
    let descriptor;
    try {
      descriptor = fs.openSync(resolved.absolute, fs.constants.O_RDONLY | NO_FOLLOW_FLAG);
      const opened = verifyOpenFile(descriptor, resolved.absolute, parentIdentity);
      const buffer = fs.readFileSync(descriptor);
      const completed = fileIdentity(fs.fstatSync(descriptor, { bigint: true }));
      if (!sameFileIdentity(opened, completed) || completed.size !== BigInt(buffer.length)) {
        throw new CanonicalStoreError(
          "file_changed",
          `Canonical file changed while it was being verified: ${value.key}`,
        );
      }
      assertDirectoryIdentity(path.dirname(resolved.absolute), parentIdentity, "parent_changed");
      assertRootIdentity();
      const currentSha256 = crypto.createHash("sha256").update(buffer).digest("hex");
      if (currentSha256 !== hashLoadedBuffer(value)) {
        throw new CanonicalStoreError(
          "file_changed",
          `Canonical file changed after its verified snapshot was captured: ${value.key}`,
        );
      }
      counters.physical_reads += 1;
      counters.bytes_read += buffer.length;
      emit("physical_read", { path: value.key, bytes: buffer.length, reason: "identity_fallback" });
      return currentSha256;
    } catch (error) {
      if (error?.code === "ELOOP") {
        throw new CanonicalStoreError("symlink_forbidden", `Refusing symbolic link: ${value.key}`, {
          cause: error,
        });
      }
      throw error;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  };

  const readText = (input, { encoding = "utf8" } = {}) => {
    counters.read_text_calls += 1;
    return loadBuffer(input).buffer.toString(encoding);
  };

  // Capture verified bytes and their digest in one filesystem pass. Decoding
  // and parsing stay lazy so query-session cache hits do not repeat that work;
  // callers that parse a cache miss still perform their existing post-read
  // hash check to detect a path change after this snapshot was captured.
  const snapshot = (input, { maxBytes = null } = {}) => {
    counters.hash_calls += 1;
    const value = loadBuffer(input, { maxBytes });
    return Object.freeze({
      sha256: hashLoadedBuffer(value),
      byteLength: value.buffer.length,
      readText({ encoding = "utf8" } = {}) {
        counters.read_text_calls += 1;
        return value.buffer.toString(encoding);
      },
      readJson() {
        counters.read_json_calls += 1;
        try {
          counters.json_parses += 1;
          return JSON.parse(value.buffer.toString("utf8"));
        } catch (error) {
          throw new CanonicalStoreError(
            "invalid_json",
            `Unable to parse canonical JSON ${value.key}: ${error.message}`,
            { cause: error },
          );
        }
      },
      assertUnchanged() {
        counters.hash_calls += 1;
        return assertLoadedValueUnchanged(value);
      },
    });
  };

  const readJson = (input) => {
    counters.read_json_calls += 1;
    const value = loadBuffer(input);
    try {
      counters.json_parses += 1;
      return JSON.parse(value.buffer.toString("utf8"));
    } catch (error) {
      throw new CanonicalStoreError(
        "invalid_json",
        `Unable to parse canonical JSON ${value.key}: ${error.message}`,
        { cause: error },
      );
    }
  };

  const hash = (input) => {
    counters.hash_calls += 1;
    const value = loadBuffer(input);
    return hashLoadedBuffer(value);
  };

  const hashLoadedBuffer = (value) => {
    if (!value.sha256) {
      value.sha256 = crypto.createHash("sha256").update(value.buffer).digest("hex");
      counters.hash_computations += 1;
    }
    return value.sha256;
  };

  const inspect = (input) => {
    const resolved = resolveCandidate(input, { mustExist: false });
    if (!resolved.entry) return null;
    return Object.freeze({
      path: resolved.key,
      isFile: resolved.entry.isFile(),
      isDirectory: resolved.entry.isDirectory(),
    });
  };

  const walk = (input = ".", options = {}) => {
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("Canonical store walk options must be an object");
    }
    const maxFiles = normalizeOptionalPositiveLimit(
      Object.hasOwn(options, "maxFiles") ? options.maxFiles : null,
      "Canonical store walk maxFiles",
    ) ?? Number.MAX_SAFE_INTEGER;
    const maxEntries = normalizeOptionalPositiveLimit(
      Object.hasOwn(options, "maxEntries") ? options.maxEntries : null,
      "Canonical store walk maxEntries",
    ) ?? Number.MAX_SAFE_INTEGER;
    counters.walk_calls += 1;
    const start = resolveCandidate(input, { mustExist: true, directoryOnly: true });
    const files = [];
    let entriesVisited = 0;

    const visit = (directory) => {
      const identity = captureDirectoryIdentity(directory, {
        code: "directory_changed",
        label: "canonical directory",
      });
      if (!isInsidePath(rootIdentity.realpath, identity.realpath)) {
        throw new CanonicalStoreError(
          "path_outside_root",
          `Canonical directory resolves outside the project root: ${cacheKey(rootPath, directory)}`,
        );
      }
      const entries = [];
      const directoryHandle = fs.opendirSync(directory);
      try {
        let entry;
        while ((entry = directoryHandle.readSync()) !== null) {
          entriesVisited += 1;
          if (entriesVisited > maxEntries) {
            throw new CanonicalStoreError(
              "walk_limit_exceeded",
              `Canonical walk exceeded the ${maxEntries} entry limit: ${start.key}`,
            );
          }
          entries.push(entry);
        }
      } finally {
        directoryHandle.closeSync();
      }
      entries.sort((left, right) => comparePortableNames(left.name, right.name));
      for (const entry of entries) {
        const candidate = path.join(directory, entry.name);
        const stat = fs.lstatSync(candidate, { bigint: true });
        if (stat.isSymbolicLink()) {
          throw new CanonicalStoreError(
            "symlink_forbidden",
            `Refusing symbolic link while walking canonical files: ${cacheKey(rootPath, candidate)}`,
          );
        }
        if (stat.isDirectory()) {
          visit(candidate);
        } else if (stat.isFile()) {
          if (files.length >= maxFiles) {
            throw new CanonicalStoreError(
              "walk_limit_exceeded",
              `Canonical walk exceeded the ${maxFiles} file limit: ${start.key}`,
            );
          }
          files.push(candidate);
        }
      }
      assertDirectoryIdentity(directory, identity, "directory_changed");
    };

    visit(start.absolute);
    assertRootIdentity();
    files.sort((left, right) => comparePortableNames(cacheKey(rootPath, left), cacheKey(rootPath, right)));
    counters.files_walked += files.length;
    emit("walk", { path: start.key, files: files.length });
    return files;
  };

  const invalidate = (input = null) => {
    counters.invalidations += 1;
    if (input === null || input === undefined) {
      const evicted = cache.size;
      cache.clear();
      counters.entries_evicted += evicted;
      emit("invalidate", { path: null, evicted });
      return evicted;
    }

    const { key } = resolveCandidate(input, { mustExist: false });
    const prefix = key === "." ? "" : `${key}/`;
    let evicted = 0;
    for (const cachedKey of [...cache.keys()]) {
      if (cachedKey === key || (prefix && cachedKey.startsWith(prefix)) || key === ".") {
        cache.delete(cachedKey);
        evicted += 1;
      }
    }
    counters.entries_evicted += evicted;
    emit("invalidate", { path: key, evicted });
    return evicted;
  };

  const metrics = () => Object.freeze({
    ...counters,
    cache_entries: cache.size,
  });

  return Object.freeze({
    root: rootPath,
    readText,
    readJson,
    snapshot,
    hash,
    inspect,
    walk,
    invalidate,
    metrics,
  });
}

function normalizeOptionalPositiveLimit(value, label) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function readFileDescriptorBounded(descriptor, maxBytes, expectedBytes, key) {
  const buffer = Buffer.allocUnsafe(expectedBytes + 1);
  let total = 0;
  while (total < buffer.length) {
    const bytesRead = fs.readSync(descriptor, buffer, total, buffer.length - total, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maxBytes) {
      throw new CanonicalStoreError(
        "file_too_large",
        `Canonical file exceeds the ${maxBytes} byte read limit: ${key}`,
      );
    }
    if (total > expectedBytes) {
      throw new CanonicalStoreError(
        "file_changed",
        `Canonical file changed while it was being read: ${key}`,
      );
    }
  }
  return buffer.subarray(0, total);
}

function captureDirectoryIdentity(directory, { code, label }) {
  let entry;
  try {
    entry = fs.lstatSync(directory, { bigint: true });
  } catch (error) {
    throw new CanonicalStoreError(code, `Unable to inspect ${label}: ${directory}`, { cause: error });
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new CanonicalStoreError(code, `${label} is not a stable regular directory: ${directory}`);
  }
  return {
    dev: entry.dev,
    ino: entry.ino,
    realpath: fs.realpathSync.native(directory),
  };
}

function sameDirectoryIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.realpath === right.realpath;
}

function assertDirectoryIdentity(directory, expected, code) {
  const current = captureDirectoryIdentity(directory, { code, label: "canonical directory" });
  if (!sameDirectoryIdentity(current, expected)) {
    throw new CanonicalStoreError(code, `Canonical directory changed during the read: ${directory}`);
  }
}

function verifyOpenFile(descriptor, filePath, parentIdentity) {
  const opened = fs.fstatSync(descriptor, { bigint: true });
  if (!opened.isFile()) {
    throw new CanonicalStoreError("not_a_file", `Canonical path is not a regular file: ${filePath}`);
  }
  assertDirectoryIdentity(path.dirname(filePath), parentIdentity, "parent_changed");
  const pathEntry = fs.lstatSync(filePath, { bigint: true });
  if (
    pathEntry.isSymbolicLink()
    || pathEntry.dev !== opened.dev
    || pathEntry.ino !== opened.ino
  ) {
    throw new CanonicalStoreError("file_changed", `Canonical file changed while opening: ${filePath}`);
  }
  return fileIdentity(opened);
}

function fileIdentity(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function assertNoSymlinkComponents(root, candidate) {
  const relative = path.relative(root, candidate);
  if (relative === "") return;
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let entry;
    try {
      entry = fs.lstatSync(current, { bigint: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (entry.isSymbolicLink()) {
      throw new CanonicalStoreError(
        "symlink_forbidden",
        `Refusing symbolic link in canonical path: ${current}`,
      );
    }
  }
}

function isInsidePath(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function cacheKey(root, absolute) {
  const relative = path.relative(root, absolute);
  return relative === "" ? "." : relative.split(path.sep).join("/");
}

function comparePortableNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
