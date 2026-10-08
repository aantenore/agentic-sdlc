import path from "node:path";

import { fsPromises as fs } from "../runtime/host.mjs";
import { readResolvedFileBounded } from "./bounded-file-reader.mjs";
import {
  ObservatoryPathError,
  assertDirectoryIdentity,
  assertNoSymlinkPathComponents,
  captureDirectoryIdentity,
  normalizePortableRelativePath,
  resolveExistingDirectoryWithin,
  resolveExistingFileWithin,
  resolveProjectBoundary,
} from "./path-safety.mjs";

export const PORTFOLIO_MANIFEST_SCHEMA_VERSION = "portfolio-manifest:v1";
export const MAX_PORTFOLIO_MANIFEST_BYTES = 256 * 1024;
export const MAX_PORTFOLIO_PROJECTS = 64;

const MANIFEST_BOUNDARIES = new WeakMap();
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const URI_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const WINDOWS_ENV_PATTERN = /%[^%]+%/u;
const GLOB_PATTERN = /[*?[\]{}]/u;

export async function loadPortfolioManifest(portfolioRoot, manifestRelativePath) {
  const root = await resolvePortfolioRoot(portfolioRoot);
  const portfolioIdentity = await captureDirectoryIdentity(root, {
    code: "portfolio_root_changed",
    label: "portfolio root",
  });

  const manifestPath = normalizePortfolioPath(manifestRelativePath, { label: "manifest" });
  if (path.posix.extname(manifestPath) !== ".json") {
    throw new ObservatoryPathError("invalid_portfolio_manifest_path", "The portfolio manifest must be a relative JSON file");
  }
  let manifestFile;
  try {
    manifestFile = await resolveExistingFileWithin(root, manifestPath);
  } catch (error) {
    if (error instanceof ObservatoryPathError && error.code === "source_not_found") {
      throw new ObservatoryPathError(
        "portfolio_manifest_not_found",
        `The portfolio manifest ${quoteValue(manifestPath)} was not found under the portfolio root. `
        + "Check the file name and use --root for the folder that contains it.",
        404,
      );
    }
    throw error;
  }
  const lexicalManifestPath = path.resolve(root, ...manifestPath.split("/"));
  if (manifestFile.resolved !== lexicalManifestPath) {
    throw new ObservatoryPathError("symlink_forbidden", "The portfolio manifest path may not contain symlinks", 403);
  }
  const bytes = await readResolvedFileBounded(manifestFile, {
    maxBytes: MAX_PORTFOLIO_MANIFEST_BYTES,
    boundaryCode: "portfolio_manifest_changed",
    tooLargeCode: "portfolio_manifest_too_large",
    tooLargeMessage: "The portfolio manifest exceeds the 256 KiB limit",
  });
  const document = parseManifest(bytes);
  validateManifestShape(document);

  const ids = new Map();
  const paths = new Map();
  const physicalDirectories = new Set();
  const projectBoundaries = [];
  const projects = [];

  const boundaryByProjectId = new Map();
  for (const [index, project] of document.projects.entries()) {
    validateProject(project, index);
    const subject = describeProject(project, index);
    if (ids.has(project.id)) {
      throw manifestError(
        "duplicate_project_id",
        `${subject} repeats an id already used by project #${ids.get(project.id) + 1}; project ids must be unique`,
      );
    }
    ids.set(project.id, index);

    const projectPath = normalizePortfolioPath(project.path, { label: "project", subject });
    if (paths.has(projectPath)) {
      throw manifestError(
        "duplicate_project_path",
        `${subject} uses the path ${quoteValue(projectPath)}, which project #${paths.get(projectPath) + 1} already uses; project paths must be unique`,
      );
    }
    paths.set(projectPath, index);

    let directory;
    try {
      directory = await resolveExistingDirectoryWithin(root, projectPath);
    } catch (error) {
      if (error instanceof ObservatoryPathError && ["directory_not_found", "source_not_found"].includes(error.code)) {
        // One missing folder must not hide the other projects: it becomes an
        // "unavailable" card, like a folder that has no .sdlc records yet.
        projects.push(Object.freeze({
          id: project.id,
          path: projectPath,
          root: null,
          unavailableCode: "project_folder_missing",
        }));
        continue;
      }
      throw error;
    }
    const identity = await captureDirectoryIdentity(directory.resolved, {
      code: "portfolio_project_root_changed",
      label: `project ${project.id} root`,
    });
    if (
      identity.root !== directory.resolved
      || identity.device !== String(directory.identity.dev)
      || identity.inode !== String(directory.identity.ino)
    ) {
      throw new ObservatoryPathError(
        "portfolio_project_root_changed",
        "A portfolio project root changed while the manifest was being loaded",
        409,
      );
    }
    const physicalKey = `${identity.device}:${identity.inode}`;
    if (physicalDirectories.has(physicalKey)) {
      throw manifestError(
        "duplicate_project_directory",
        `${subject} resolves to the same folder as another project; each project needs its own folder`,
      );
    }
    physicalDirectories.add(physicalKey);
    projectBoundaries.push(identity);
    boundaryByProjectId.set(project.id, identity);
    projects.push(Object.freeze({ id: project.id, path: projectPath, root: directory.resolved }));
  }

  await assertDirectoryIdentity(portfolioIdentity);
  const result = Object.freeze({
    schemaVersion: PORTFOLIO_MANIFEST_SCHEMA_VERSION,
    portfolioRoot: root,
    manifestPath,
    projects: Object.freeze(projects),
  });
  MANIFEST_BOUNDARIES.set(result, Object.freeze({
    portfolioIdentity,
    manifestIdentity: freezeFileIdentity(manifestFile),
    projectBoundaries: Object.freeze(projectBoundaries),
    projectBoundaryById: boundaryByProjectId,
  }));
  await assertPortfolioManifestBoundaries(result);
  return result;
}

export async function assertPortfolioManifestBoundaries(manifest) {
  const boundaries = MANIFEST_BOUNDARIES.get(manifest);
  if (!boundaries) {
    throw new TypeError("A loaded portfolio manifest is required");
  }
  await assertDirectoryIdentity(boundaries.portfolioIdentity);
  await assertPinnedManifest(boundaries.manifestIdentity);
  for (const identity of boundaries.projectBoundaries) {
    await assertDirectoryIdentity(identity);
  }
}

export async function assertPortfolioEnvelopeBoundaries(manifest) {
  const boundaries = requireManifestBoundaries(manifest);
  await assertDirectoryIdentity(boundaries.portfolioIdentity);
  await assertPinnedManifest(boundaries.manifestIdentity);
}

export async function assertPortfolioProjectBoundary(manifest, projectId) {
  const boundaries = requireManifestBoundaries(manifest);
  const identity = boundaries.projectBoundaryById.get(projectId);
  if (!identity && manifest.projects.some((project) => project.id === projectId && project.root === null)) {
    return;
  }
  if (!identity) {
    throw new TypeError("A project from the loaded portfolio manifest is required");
  }
  await assertDirectoryIdentity(identity);
}

function requireManifestBoundaries(manifest) {
  const boundaries = MANIFEST_BOUNDARIES.get(manifest);
  if (!boundaries) {
    throw new TypeError("A loaded portfolio manifest is required");
  }
  return boundaries;
}

async function resolvePortfolioRoot(value) {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) {
    throw new ObservatoryPathError("invalid_portfolio_root", "A canonical portfolio root is required");
  }
  const lexical = path.resolve(value);
  try {
    await assertNoSymlinkPathComponents(lexical, {
      code: "portfolio_root_symlink",
      message: "The portfolio root path may not contain symlinks",
    });
  } catch (error) {
    if (error instanceof ObservatoryPathError) throw error;
    throw new ObservatoryPathError("portfolio_root_not_found", "The portfolio root is not accessible", 404);
  }
  const root = await resolveProjectBoundary(lexical);
  try {
    await assertNoSymlinkPathComponents(lexical, {
      code: "portfolio_root_symlink",
      message: "The portfolio root path may not contain symlinks",
    });
    const [lexicalIdentity, resolvedIdentity] = await Promise.all([
      fs.stat(lexical, { bigint: true }),
      fs.stat(root, { bigint: true }),
    ]);
    // Windows may spell one physical directory with either an 8.3 alias or
    // its long name. Identity, not string equality, distinguishes that safe
    // alias from a directory that changed during boundary resolution.
    if (
      !lexicalIdentity.isDirectory()
      || !resolvedIdentity.isDirectory()
      || lexicalIdentity.dev !== resolvedIdentity.dev
      || lexicalIdentity.ino !== resolvedIdentity.ino
    ) {
      throw new ObservatoryPathError(
        "portfolio_root_changed",
        "The portfolio root changed while it was being resolved",
        409,
      );
    }
  } catch (error) {
    if (error instanceof ObservatoryPathError) throw error;
    throw new ObservatoryPathError(
      "portfolio_root_changed",
      "The portfolio root changed while it was being resolved",
      409,
    );
  }
  return root;
}

const PORTABLE_PATH_RULE =
  "it must be a relative path written with forward slashes (/), without ~, $, %VAR%, wildcards, a URL scheme, a leading slash, or . and .. parts";

function normalizePortfolioPath(value, { label, subject = null }) {
  const where = subject ? `${subject}: the path` : `The ${label} path`;
  if (typeof value !== "string" || value !== value.trim()) {
    throw manifestError(
      `invalid_${label}_path`,
      `${where} ${quoteValue(value)} must not have spaces before or after it`,
    );
  }
  if (
    value.startsWith("~")
    || value.includes("$")
    || WINDOWS_ENV_PATTERN.test(value)
    || URI_SCHEME_PATTERN.test(value)
    || GLOB_PATTERN.test(value)
  ) {
    throw manifestError(`invalid_${label}_path`, `${where} ${quoteValue(value)} is not allowed: ${PORTABLE_PATH_RULE}`);
  }
  try {
    return normalizePortableRelativePath(value);
  } catch {
    throw manifestError(`invalid_${label}_path`, `${where} ${quoteValue(value)} is not allowed: ${PORTABLE_PATH_RULE}`);
  }
}

// A rejected manifest value is echoed back only when it is safe to show. Values
// that reveal where something lives on this computer (absolute paths, home
// folders, drive letters, variables, URLs) are described instead of repeated,
// so an error pasted into a ticket or a JSON log cannot expose a private path.
function sensitiveValueKind(value) {
  const text = value.trim();
  if (/^[\\/]/u.test(text) || /^[A-Za-z]:/u.test(text)) return "an absolute path";
  if (text.startsWith("~")) return "a path in a home folder";
  if (text.includes("$") || WINDOWS_ENV_PATTERN.test(text)) return "a path with a variable";
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(text) || /^file:/iu.test(text)) return "a URL";
  return null;
}

function quoteValue(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  const sensitive = sensitiveValueKind(text);
  if (sensitive) return `(${sensitive}; value not shown)`;
  const printable = text.replace(/[\u0000-\u001f\u007f]/gu, "?");
  return JSON.stringify(printable.length > 80 ? `${printable.slice(0, 77)}...` : printable);
}

function describeProject(project, index) {
  const id = isPlainObject(project) && typeof project.id === "string" ? project.id : null;
  // An id that itself looks like a private path is not repeated either.
  return id === null || sensitiveValueKind(id) !== null
    ? `Project #${index + 1}`
    : `Project #${index + 1} (id ${quoteValue(id)})`;
}

function parseManifest(bytes) {
  let text;
  try {
    text = UTF8_DECODER.decode(bytes);
  } catch {
    throw manifestError("invalid_portfolio_manifest_encoding", "The portfolio manifest must be valid UTF-8");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw manifestError("invalid_portfolio_manifest_json", "The portfolio manifest must contain valid JSON");
  }
}

function validateManifestShape(value) {
  if (!isPlainObject(value)) {
    throw manifestError("invalid_portfolio_manifest", "The portfolio manifest must be an object");
  }
  assertOnlyKeys(value, ["schema_version", "projects"], "The portfolio manifest");
  if (value.schema_version !== PORTFOLIO_MANIFEST_SCHEMA_VERSION) {
    throw manifestError(
      "unsupported_portfolio_manifest_version",
      `The portfolio manifest must set schema_version to ${quoteValue(PORTFOLIO_MANIFEST_SCHEMA_VERSION)} (found ${quoteValue(value.schema_version)})`,
    );
  }
  if (!Array.isArray(value.projects) || value.projects.length < 1 || value.projects.length > MAX_PORTFOLIO_PROJECTS) {
    throw manifestError(
      "invalid_portfolio_projects",
      `The portfolio manifest must list between 1 and ${MAX_PORTFOLIO_PROJECTS} projects${Array.isArray(value.projects) ? ` (found ${value.projects.length})` : ""}`,
    );
  }
}

function validateProject(project, index) {
  if (!isPlainObject(project)) {
    throw manifestError("invalid_portfolio_project", `Project #${index + 1} must be an object with "id" and "path"`);
  }
  assertOnlyKeys(project, ["id", "path"], describeProject(project, index));
  if (
    typeof project.id !== "string"
    || project.id.length < 1
    || project.id.length > 128
    || project.id !== project.id.trim()
    || !PROJECT_ID_PATTERN.test(project.id)
  ) {
    throw manifestError(
      "invalid_project_id",
      `Project #${index + 1} has the id ${quoteValue(project.id)}; an id must start with a letter or number and use only letters, numbers, dots, underscores, or hyphens (up to 128 characters)`,
    );
  }
  if (typeof project.path !== "string" || project.path.length < 1 || project.path.length > 4096) {
    throw manifestError(
      "invalid_project_path",
      `${describeProject(project, index)}: the path ${quoteValue(project.path)} must be a non-empty relative path written with forward slashes (/)`,
    );
  }
}

function assertOnlyKeys(value, allowed, label) {
  const allowedSet = new Set(allowed);
  const unsupported = Object.keys(value).filter((key) => !allowedSet.has(key));
  const missing = allowed.filter((key) => !Object.hasOwn(value, key));
  if (unsupported.length > 0 || missing.length > 0) {
    const parts = [
      ...(missing.length > 0 ? [`missing ${missing.map(quoteValue).join(", ")}`] : []),
      ...(unsupported.length > 0 ? [`unsupported ${unsupported.map(quoteValue).join(", ")}`] : []),
    ];
    throw manifestError(
      "invalid_portfolio_manifest_properties",
      `${label} has ${parts.join(" and ")} (allowed properties: ${allowed.map(quoteValue).join(", ")})`,
    );
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function freezeFileIdentity(file) {
  return Object.freeze({
    resolved: file.resolved,
    device: String(file.identity.dev),
    inode: String(file.identity.ino),
    size: String(file.identity.size),
    mtimeNs: String(file.identity.mtimeNs),
    ctimeNs: String(file.identity.ctimeNs),
  });
}

async function assertPinnedManifest(expected) {
  try {
    const [resolved, lexical, current] = await Promise.all([
      fs.realpath(expected.resolved),
      fs.lstat(expected.resolved),
      fs.stat(expected.resolved, { bigint: true }),
    ]);
    if (
      resolved !== expected.resolved
      || lexical.isSymbolicLink()
      || !current.isFile()
      || String(current.dev) !== expected.device
      || String(current.ino) !== expected.inode
      || String(current.size) !== expected.size
      || String(current.mtimeNs) !== expected.mtimeNs
      || String(current.ctimeNs) !== expected.ctimeNs
    ) {
      throw manifestBoundaryChanged();
    }
  } catch (error) {
    if (error instanceof ObservatoryPathError) throw error;
    throw manifestBoundaryChanged();
  }
}

function manifestBoundaryChanged() {
  return new ObservatoryPathError(
    "portfolio_manifest_changed",
    "The portfolio manifest changed after it was loaded",
    409,
  );
}

function manifestError(code, message) {
  return new ObservatoryPathError(code, message, 400);
}
