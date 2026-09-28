import path from "node:path";
import { fs } from "./runtime/host.mjs";

export const DEFAULT_BASELINE_SOURCE_EXTENSIONS = Object.freeze([
  ".cjs",
  ".css",
  ".go",
  ".html",
  ".java",
  ".js",
  ".jsx",
  ".json",
  ".jsonl",
  ".kt",
  ".md",
  ".mjs",
  ".py",
  ".rs",
  ".scss",
  ".sh",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

export const DEFAULT_BASELINE_EXCLUDED_DIRECTORIES = Object.freeze([
  ".git",
  ".sdlc",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "vendor",
]);

const DEFAULT_MAX_DISCOVERED_FILES = 5_000;
const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;

export function normalizeBaselineSourcePolicy(policy = {}) {
  return Object.freeze({
    source_extensions: normalizeExtensions(
      policy.source_extensions,
      DEFAULT_BASELINE_SOURCE_EXTENSIONS,
    ),
    excluded_directories: normalizeNames(
      policy.excluded_directories,
      DEFAULT_BASELINE_EXCLUDED_DIRECTORIES,
    ),
    max_discovered_files: normalizePositiveInteger(
      policy.max_discovered_files,
      DEFAULT_MAX_DISCOVERED_FILES,
      "baseline_policy.max_discovered_files",
    ),
    max_file_bytes: normalizePositiveInteger(
      policy.max_file_bytes,
      DEFAULT_MAX_FILE_BYTES,
      "baseline_policy.max_file_bytes",
    ),
  });
}

export function discoverBaselineSourcePaths({ projectRoot, requestedPaths, policy = {} }) {
  const root = canonicalDirectory(projectRoot, "projectRoot");
  const normalizedPolicy = normalizeBaselineSourcePolicy(policy);
  const extensions = new Set(normalizedPolicy.source_extensions);
  const excludedNames = new Set(normalizedPolicy.excluded_directories);
  const paths = [];
  const excluded = [];
  const identities = new Set();
  let truncated = false;

  const includeFile = (filePath, { explicit = false } = {}) => {
    const relativePath = portableRelativePath(root, filePath);
    // Windows file IDs can exceed Number.MAX_SAFE_INTEGER. Keep the native
    // bigint identity so two distinct files cannot collapse to the same
    // rounded dev/inode pair during deterministic discovery.
    const stat = fs.lstatSync(filePath, { bigint: true });
    if (!stat.isFile()) {
      excluded.push({ path: relativePath, reason: "not_regular_file" });
      return;
    }
    if (!explicit && !extensions.has(path.extname(filePath).toLowerCase())) {
      excluded.push({ path: relativePath, reason: "extension_not_allowed" });
      return;
    }
    if (!explicit && stat.size > BigInt(normalizedPolicy.max_file_bytes)) {
      excluded.push({ path: relativePath, reason: "file_too_large", size_bytes: Number(stat.size) });
      return;
    }
    const identity = stat.ino !== 0n
      ? `inode:${stat.dev}:${stat.ino}`
      : `realpath:${fs.realpathSync.native(filePath)}`;
    if (identities.has(identity)) return;
    if (paths.length >= normalizedPolicy.max_discovered_files) {
      truncated = true;
      return;
    }
    identities.add(identity);
    paths.push(relativePath);
  };

  const visitDirectory = (directoryPath) => {
    const entries = fs.readdirSync(directoryPath, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (truncated) return;
      const entryPath = path.join(directoryPath, entry.name);
      const relativePath = portableRelativePath(root, entryPath);
      if (entry.isSymbolicLink()) {
        excluded.push({ path: relativePath, reason: "symlink" });
        continue;
      }
      if (entry.isDirectory()) {
        if (excludedNames.has(entry.name)) {
          excluded.push({ path: `${relativePath}/`, reason: "excluded_directory" });
          continue;
        }
        visitDirectory(entryPath);
        continue;
      }
      includeFile(entryPath);
    }
  };

  for (const requestedPath of requestedPaths || []) {
    const resolved = resolveRequestedPath(root, requestedPath);
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink()) {
      throw new Error(`Baseline source cannot be a symlink: ${requestedPath}`);
    }
    if (stat.isDirectory()) {
      if (resolved === root) {
        visitDirectory(resolved);
      } else if (excludedNames.has(path.basename(resolved))) {
        excluded.push({ path: `${portableRelativePath(root, resolved)}/`, reason: "excluded_directory" });
      } else {
        visitDirectory(resolved);
      }
    } else {
      includeFile(resolved, { explicit: true });
    }
  }

  return Object.freeze({
    paths: Object.freeze([...new Set(paths)].sort()),
    excluded: Object.freeze(excluded.sort(compareExclusions)),
    truncated,
    discovered_count: paths.length,
    policy: normalizedPolicy,
  });
}

function canonicalDirectory(value, label) {
  const resolved = path.resolve(String(value || ""));
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) throw new Error(`${label} must be an existing directory`);
  return fs.realpathSync.native(resolved);
}

function resolveRequestedPath(root, requestedPath) {
  const resolved = path.resolve(root, String(requestedPath || ""));
  if (!isInside(root, resolved)) {
    throw new Error(`Baseline source escapes the project root: ${requestedPath}`);
  }
  const canonical = fs.realpathSync.native(resolved);
  if (!isInside(root, canonical)) {
    throw new Error(`Baseline source resolves outside the project root: ${requestedPath}`);
  }
  return canonical;
}

function portableRelativePath(root, filePath) {
  const relative = path.relative(root, filePath);
  if (!relative || relative === ".") return ".";
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Discovered baseline source escapes the project root: ${filePath}`);
  }
  return relative.split(path.sep).join("/");
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function normalizeExtensions(value, fallback) {
  const source = Array.isArray(value) && value.length > 0 ? value : fallback;
  return Object.freeze([...new Set(source.map((item) => {
    const normalized = String(item || "").trim().toLowerCase();
    if (!/^\.[a-z0-9][a-z0-9.+-]*$/u.test(normalized)) {
      throw new Error(`Invalid baseline source extension '${item}'`);
    }
    return normalized;
  }))].sort());
}

function normalizeNames(value, fallback) {
  const source = Array.isArray(value) && value.length > 0 ? value : fallback;
  return Object.freeze([...new Set(source.map((item) => {
    const normalized = String(item || "").trim();
    if (!normalized || normalized === "." || normalized === ".." || /[\\/]/u.test(normalized)) {
      throw new Error(`Invalid excluded baseline directory '${item}'`);
    }
    return normalized;
  }))].sort());
}

function normalizePositiveInteger(value, fallback, label) {
  const normalized = value === undefined || value === null ? fallback : Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return normalized;
}

function compareExclusions(left, right) {
  return left.path.localeCompare(right.path) || left.reason.localeCompare(right.reason);
}
