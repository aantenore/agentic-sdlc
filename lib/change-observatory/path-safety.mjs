import path from "node:path";
import { fsPromises as fs } from "../runtime/host.mjs";

export class ObservatoryPathError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "ObservatoryPathError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function isContainedPath(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function normalizePortableRelativePath(value, { requiredPrefix = null } = {}) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ObservatoryPathError("invalid_path", "A non-empty relative path is required");
  }

  const candidate = value.trim();
  if (
    candidate.includes("\0")
    || candidate.includes("\\")
    || path.posix.isAbsolute(candidate)
    || path.win32.isAbsolute(candidate)
    || /^[A-Za-z]:/.test(candidate)
  ) {
    throw new ObservatoryPathError("invalid_path", "Only portable relative paths are allowed");
  }

  const segments = candidate.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new ObservatoryPathError("path_traversal", "Path traversal is not allowed", 403);
  }

  const normalized = path.posix.normalize(candidate);
  if (requiredPrefix && normalized !== requiredPrefix && !normalized.startsWith(`${requiredPrefix}/`)) {
    throw new ObservatoryPathError("path_outside_scope", "The requested path is outside the allowed scope", 403);
  }
  return normalized;
}

export async function resolveProjectBoundary(projectRoot) {
  if (typeof projectRoot !== "string" || projectRoot.trim() === "") {
    throw new ObservatoryPathError("invalid_project_root", "A project root is required");
  }

  let root;
  try {
    root = await fs.realpath(path.resolve(projectRoot));
    const stats = await fs.stat(root);
    if (!stats.isDirectory()) {
      throw new ObservatoryPathError("invalid_project_root", "The project root must be a directory");
    }
  } catch (error) {
    if (error instanceof ObservatoryPathError) {
      throw error;
    }
    throw new ObservatoryPathError("project_root_not_found", "The project root is not accessible", 404);
  }

  return root;
}

export async function assertNoSymlinkPathComponents(absolutePath, {
  code = "symlink_forbidden",
  message = "Canonical paths may not contain symlinks",
  statusCode = 403,
} = {}) {
  const candidate = path.resolve(absolutePath);
  const parsed = path.parse(candidate);
  let current = parsed.root;
  const components = candidate
    .slice(parsed.root.length)
    .split(path.sep)
    .filter((component) => component !== "");

  for (const component of components) {
    current = path.join(current, component);
    const stats = await fs.lstat(current);
    if (stats.isSymbolicLink()) {
      throw new ObservatoryPathError(code, message, statusCode);
    }
  }
}

export async function captureDirectoryIdentity(directory, {
  code = "directory_boundary_changed",
  label = "directory boundary",
} = {}) {
  const root = await fs.realpath(path.resolve(directory));
  const stats = await fs.stat(root, { bigint: true });
  if (!stats.isDirectory()) {
    throw new ObservatoryPathError("invalid_directory_boundary", `The ${label} must be a directory`);
  }
  return Object.freeze({
    root,
    device: String(stats.dev),
    inode: String(stats.ino),
    code,
    label,
  });
}

export async function assertDirectoryIdentity(identity) {
  try {
    const currentRoot = await fs.realpath(identity.root);
    const stats = await fs.stat(currentRoot, { bigint: true });
    if (
      currentRoot !== identity.root
      || !stats.isDirectory()
      || String(stats.dev) !== identity.device
      || String(stats.ino) !== identity.inode
    ) {
      throw new ObservatoryPathError(
        identity.code,
        `The ${identity.label} changed after the observatory started`,
        409,
      );
    }
  } catch (error) {
    if (error instanceof ObservatoryPathError) throw error;
    throw new ObservatoryPathError(
      identity.code,
      `The ${identity.label} changed after the observatory started`,
      409,
    );
  }
}

export async function resolveKnowledgeBaseBoundary(projectRoot, { allowMissing = false } = {}) {
  const root = await resolveProjectBoundary(projectRoot);
  const lexicalKnowledgeBase = path.join(root, ".sdlc");
  let knowledgeBase;

  try {
    const lexicalStats = await fs.lstat(lexicalKnowledgeBase);
    if (lexicalStats.isSymbolicLink()) {
      throw new ObservatoryPathError(
        "knowledge_base_symlink",
        "The project knowledge base must be a canonical directory, not a symlink",
        403,
      );
    }
    knowledgeBase = await fs.realpath(lexicalKnowledgeBase);
  } catch (error) {
    if (error instanceof ObservatoryPathError) {
      throw error;
    }
    if (allowMissing && error?.code === "ENOENT") {
      return { projectRoot: root, knowledgeBaseRoot: null };
    }
    if (error?.code === "ENOENT") {
      throw new ObservatoryPathError("knowledge_base_not_found", "The project knowledge base is missing", 404);
    }
    throw new ObservatoryPathError("knowledge_base_unavailable", "The project knowledge base is not accessible", 403);
  }

  if (!isContainedPath(root, knowledgeBase)) {
    throw new ObservatoryPathError("knowledge_base_escape", "The project knowledge base resolves outside the project root", 403);
  }

  const stats = await fs.stat(knowledgeBase);
  if (!stats.isDirectory()) {
    throw new ObservatoryPathError("invalid_knowledge_base", "The project knowledge base must be a directory", 400);
  }
  return { projectRoot: root, knowledgeBaseRoot: knowledgeBase };
}

export async function resolveExistingFileWithin(root, relativePath) {
  const normalized = normalizePortableRelativePath(relativePath);
  const lexical = path.resolve(root, ...normalized.split("/"));
  if (!isContainedPath(root, lexical)) {
    throw new ObservatoryPathError("path_traversal", "Path traversal is not allowed", 403);
  }

  await assertNoSymlinkComponents(root, normalized);

  let resolved;
  try {
    resolved = await fs.realpath(lexical);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      throw new ObservatoryPathError("source_not_found", "The requested source record does not exist", 404);
    }
    throw new ObservatoryPathError("source_unavailable", "The requested source record is not accessible", 403);
  }
  if (!isContainedPath(root, resolved)) {
    throw new ObservatoryPathError("symlink_escape", "The requested path resolves outside the allowed root", 403);
  }

  // Keep the ordinary Stats object for presentation-sized numeric fields, but
  // also retain the exact 64-bit identity used at the open-file boundary.
  // Windows file IDs can exceed Number.MAX_SAFE_INTEGER, so comparing a
  // numeric stat().ino with a bigint fstat().ino can reject an unchanged file.
  const stats = await fs.stat(resolved);
  const identity = await fs.stat(resolved, { bigint: true });
  if (!stats.isFile() || !identity.isFile()) {
    throw new ObservatoryPathError("source_not_file", "The requested source record is not a file", 404);
  }
  return { normalized, resolved, stats, identity };
}

export async function resolveExistingDirectoryWithin(root, relativePath) {
  const normalized = normalizePortableRelativePath(relativePath);
  const lexical = path.resolve(root, ...normalized.split("/"));
  if (!isContainedPath(root, lexical)) {
    throw new ObservatoryPathError("path_traversal", "Path traversal is not allowed", 403);
  }

  await assertNoSymlinkComponents(root, normalized);

  let resolved;
  try {
    resolved = await fs.realpath(lexical);
    await assertNoSymlinkComponents(root, normalized);
  } catch (error) {
    if (error instanceof ObservatoryPathError) throw error;
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      throw new ObservatoryPathError("directory_not_found", "The requested directory does not exist", 404);
    }
    throw new ObservatoryPathError("directory_unavailable", "The requested directory is not accessible", 403);
  }
  if (!isContainedPath(root, resolved)) {
    throw new ObservatoryPathError("symlink_escape", "The requested directory resolves outside the allowed root", 403);
  }

  const stats = await fs.stat(resolved, { bigint: true });
  if (!stats.isDirectory()) {
    throw new ObservatoryPathError("directory_not_found", "The requested directory does not exist", 404);
  }
  return { normalized, resolved, identity: stats };
}

async function assertNoSymlinkComponents(root, normalized) {
  let current = root;
  for (const segment of normalized.split("/")) {
    current = path.join(current, segment);
    let stats;
    try {
      stats = await fs.lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
        throw new ObservatoryPathError("source_not_found", "The requested source record does not exist", 404);
      }
      throw new ObservatoryPathError("source_unavailable", "The requested source record is not accessible", 403);
    }
    if (stats.isSymbolicLink()) {
      throw new ObservatoryPathError(
        "symlink_forbidden",
        "Canonical observatory paths may not contain symlinks",
        403,
      );
    }
  }
}
