import path from "node:path";
import { childProcess, crypto, fs } from "./runtime/host.mjs";

const { spawnSync } = childProcess;

const FINGERPRINT_FORMAT = "agentic-sdlc-distribution:v1";
export const BUILD_PROVENANCE_RELATIVE_PATH = ".codex-plugin/build-provenance.json";
const BUILD_PROVENANCE_SCHEMA = "agentic-sdlc-build-provenance:v1";

export const DEFAULT_BUILD_EXCLUDED_DIRECTORIES = Object.freeze([
  ".git",
  ".sdlc",
  ".agentic-sdlc",
  ".cache",
  ".nyc_output",
  "coverage",
  "node_modules",
]);

const ALWAYS_DISTRIBUTED_FILE_PATTERNS = Object.freeze([
  /^readme(?:\..+)?$/iu,
  /^licen[cs]e(?:\..+)?$/iu,
]);
const ALWAYS_EXCLUDED_DISTRIBUTION_NAMES = Object.freeze([
  ".npmignore",
]);
const ALWAYS_EXCLUDED_DISTRIBUTION_SUFFIXES = Object.freeze([
  ".pyc",
  ".pyo",
]);

/**
 * Return the regular files that form the npm distribution, ordered by their
 * POSIX-style relative path. Repository metadata, dependencies, and local
 * runtime state are deliberately excluded even if a broad `files` selector is
 * configured.
 */
export function discoverDistributedFiles(projectRoot, options = {}) {
  const root = path.resolve(projectRoot);
  const packageMetadata = options.packageMetadata ?? readPackageMetadata(root);
  const excludedDirectories = new Set(
    options.excludedDirectories ?? DEFAULT_BUILD_EXCLUDED_DIRECTORIES,
  );
  const selectors = buildDistributionSelectors(root, packageMetadata);

  return walkRegularFiles(root, root, excludedDirectories)
    .filter(({ relativePath }) => relativePath !== BUILD_PROVENANCE_RELATIVE_PATH)
    .filter(({ relativePath }) => !isTransientDistributionArtifact(relativePath))
    .filter(({ relativePath }) => selectors.some((selector) => selector(relativePath)))
    .sort((left, right) =>
      left.relativePath < right.relativePath
        ? -1
        : left.relativePath > right.relativePath
          ? 1
          : 0)
    .map(({ absolutePath, relativePath }) => Object.freeze({
      absolute_path: absolutePath,
      relative_path: relativePath,
    }));
}

function isTransientDistributionArtifact(relativePath) {
  const parts = relativePath.split("/");
  const basename = parts.at(-1);
  return parts.includes("__pycache__")
    || ALWAYS_EXCLUDED_DISTRIBUTION_NAMES.includes(basename)
    || ALWAYS_EXCLUDED_DISTRIBUTION_SUFFIXES.some((suffix) =>
      basename.endsWith(suffix));
}

/**
 * Hash only stable distribution content: relative paths and file bytes.
 * Absolute checkout paths, mtimes, permissions, Git state, and runtime files
 * never contribute to the result.
 */
export function computeBuildFingerprint(projectRoot, options = {}) {
  const files = discoverDistributedFiles(projectRoot, options);
  const hash = crypto.createHash("sha256");
  hash.update(`${FINGERPRINT_FORMAT}\0`, "utf8");

  for (const file of files) {
    const content = fs.readFileSync(file.absolute_path);
    hash.update(`file\0${Buffer.byteLength(file.relative_path, "utf8")}\0`, "utf8");
    hash.update(file.relative_path, "utf8");
    hash.update(`\0${content.length}\0`, "utf8");
    hash.update(content);
    hash.update("\0", "utf8");
  }

  return hash.digest("hex");
}

/**
 * Build the machine-readable identity used by `--version --json`.
 * A checkout reports live Git identity. An officially installed copy reports
 * the exact clean source identity embedded by the reversible v2 installer.
 */
export function inspectBuildIdentity(projectRoot, options = {}) {
  const root = path.resolve(projectRoot);
  const packageMetadata = options.packageMetadata ?? readPackageMetadata(root);
  const git = detectGitIdentity(root, options);
  const buildFingerprint = computeBuildFingerprint(root, {
    ...options,
    packageMetadata,
  });
  const provenance = git.commit
    ? null
    : readEmbeddedBuildProvenance(root, {
        packageVersion: packageMetadata.version,
        buildFingerprint,
      });
  return Object.freeze({
    package_version: packageMetadata.version,
    build_fingerprint: buildFingerprint,
    ...(git.commit
      ? { git_commit: git.commit }
      : provenance?.source_git_commit
        ? { git_commit: provenance.source_git_commit }
        : {}),
    ...(typeof git.dirty === "boolean"
      ? { git_dirty: git.dirty }
      : typeof provenance?.source_git_dirty === "boolean"
        ? { git_dirty: provenance.source_git_dirty }
        : {}),
    ...(provenance ? { provenance: "official-installer-v2" } : {}),
  });
}

export function readEmbeddedBuildProvenance(projectRoot, settings = {}) {
  const provenancePath = path.join(
    path.resolve(projectRoot),
    ...BUILD_PROVENANCE_RELATIVE_PATH.split("/"),
  );
  if (!fs.existsSync(provenancePath)) {
    return null;
  }
  let provenance;
  try {
    provenance = JSON.parse(fs.readFileSync(provenancePath, "utf8"));
  } catch (error) {
    throw new BuildIdentityError(
      `Cannot read embedded build provenance at ${provenancePath}: ${error.message}`,
      "BUILD_PROVENANCE_UNREADABLE",
    );
  }
  const allowedFields = new Set([
    "schema_version",
    "package_version",
    "build_fingerprint",
    "source_git_commit",
    "source_git_dirty",
    "generated_by",
  ]);
  if (
    !provenance
    || typeof provenance !== "object"
    || Array.isArray(provenance)
    || Object.keys(provenance).some((field) => !allowedFields.has(field))
    || provenance.schema_version !== BUILD_PROVENANCE_SCHEMA
    || provenance.generated_by !== "official-installer-v2"
  ) {
    throw new BuildIdentityError(
      `Embedded build provenance at ${provenancePath} has an unsupported structure`,
      "BUILD_PROVENANCE_INVALID",
    );
  }
  if (provenance.package_version !== settings.packageVersion) {
    throw new BuildIdentityError(
      `Embedded build provenance version ${provenance.package_version || "missing"} does not match package ${settings.packageVersion}`,
      "BUILD_PROVENANCE_VERSION_MISMATCH",
    );
  }
  if (
    !/^[a-f0-9]{64}$/u.test(String(provenance.build_fingerprint || ""))
    || provenance.build_fingerprint !== settings.buildFingerprint
  ) {
    throw new BuildIdentityError(
      "Embedded build provenance does not match the installed distribution fingerprint",
      "BUILD_PROVENANCE_FINGERPRINT_MISMATCH",
    );
  }
  if (
    provenance.source_git_commit !== null
    && !/^[a-f0-9]{40,64}$/u.test(String(provenance.source_git_commit || ""))
  ) {
    throw new BuildIdentityError(
      "Embedded build provenance contains an invalid source Git commit",
      "BUILD_PROVENANCE_COMMIT_INVALID",
    );
  }
  if (
    provenance.source_git_dirty !== null
    && typeof provenance.source_git_dirty !== "boolean"
  ) {
    throw new BuildIdentityError(
      "Embedded build provenance contains an invalid source dirty state",
      "BUILD_PROVENANCE_DIRTY_INVALID",
    );
  }
  return Object.freeze(provenance);
}

export function detectGitIdentity(projectRoot, options = {}) {
  const root = path.resolve(projectRoot);
  const commandRunner = options.commandRunner ?? spawnSync;
  const checkout = runGit(commandRunner, root, ["rev-parse", "--show-toplevel"]);
  if (!checkout.ok || !sameFilesystemPath(checkout.stdout, root)) {
    return Object.freeze({});
  }

  const head = runGit(commandRunner, root, ["rev-parse", "--verify", "HEAD"]);
  const status = runGit(commandRunner, root, [
    "status",
    "--porcelain=v1",
    "--untracked-files=normal",
  ]);
  return Object.freeze({
    ...(head.ok && /^[0-9a-f]{40,64}$/iu.test(head.stdout)
      ? { commit: head.stdout.toLowerCase() }
      : {}),
    ...(status.ok ? { dirty: status.stdout.length > 0 } : {}),
  });
}

function readPackageMetadata(root) {
  const packagePath = path.join(root, "package.json");
  let packageMetadata;
  try {
    packageMetadata = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  } catch (error) {
    throw new BuildIdentityError(
      `Cannot read package metadata at ${packagePath}: ${error.message}`,
      "BUILD_IDENTITY_PACKAGE_UNREADABLE",
    );
  }
  if (typeof packageMetadata.version !== "string" || packageMetadata.version.trim() === "") {
    throw new BuildIdentityError(
      `Package metadata at ${packagePath} does not define a version`,
      "BUILD_IDENTITY_VERSION_MISSING",
    );
  }
  return packageMetadata;
}

function buildDistributionSelectors(root, packageMetadata) {
  const selectors = [
    (relativePath) => relativePath === "package.json",
    (relativePath) => {
      const basename = path.posix.basename(relativePath);
      return !relativePath.includes("/")
        && ALWAYS_DISTRIBUTED_FILE_PATTERNS.some((pattern) => pattern.test(basename));
    },
  ];
  const configuredFiles = Array.isArray(packageMetadata.files)
    ? packageMetadata.files
    : ["."];
  for (const configuredPath of configuredFiles) {
    if (typeof configuredPath !== "string" || configuredPath.trim() === "") continue;
    selectors.push(selectorForPackagePath(root, configuredPath));
  }

  for (const mandatoryPath of mandatoryPackagePaths(packageMetadata)) {
    selectors.push(selectorForPackagePath(root, mandatoryPath));
  }
  return selectors;
}

function mandatoryPackagePaths(packageMetadata) {
  const paths = [];
  if (typeof packageMetadata.main === "string") paths.push(packageMetadata.main);
  if (typeof packageMetadata.bin === "string") {
    paths.push(packageMetadata.bin);
  } else if (packageMetadata.bin && typeof packageMetadata.bin === "object") {
    paths.push(...Object.values(packageMetadata.bin).filter((value) => typeof value === "string"));
  }
  return paths;
}

function selectorForPackagePath(root, rawPath) {
  const normalized = normalizePackagePath(rawPath);
  if (containsGlobMagic(normalized)) {
    const pattern = globToRegExp(normalized);
    return (relativePath) => pattern.test(relativePath);
  }

  const absolutePath = path.resolve(root, normalized || ".");
  let directory = normalized === "";
  try {
    directory = fs.statSync(absolutePath).isDirectory();
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return directory
    ? (relativePath) => normalized === "" || relativePath.startsWith(`${normalized}/`)
    : (relativePath) => relativePath === normalized;
}

function walkRegularFiles(root, directory, excludedDirectories) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkRegularFiles(root, absolutePath, excludedDirectories));
    } else if (entry.isFile()) {
      files.push({
        absolutePath,
        relativePath: toPosixPath(path.relative(root, absolutePath)),
      });
    }
  }
  return files;
}

function normalizePackagePath(rawPath) {
  const normalized = rawPath
    .trim()
    .replaceAll("\\", "/")
    .replace(/^(?:\.\/)+/u, "")
    .replace(/\/+$/u, "");
  if (normalized === ".") return "";
  if (
    normalized === ".."
    || normalized.startsWith("../")
    || path.posix.isAbsolute(normalized)
  ) {
    throw new BuildIdentityError(
      `Distribution path escapes the package root: ${rawPath}`,
      "BUILD_IDENTITY_PATH_OUTSIDE_ROOT",
    );
  }
  return normalized;
}

function containsGlobMagic(value) {
  return /[*?[\]]/u.test(value);
}

function globToRegExp(glob) {
  let expression = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === "*") {
      if (glob[index + 1] === "*") {
        index += 1;
        expression += ".*";
      } else {
        expression += "[^/]*";
      }
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += escapeRegExp(character);
    }
  }
  return new RegExp(`${expression}(?:/.*)?$`, "u");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

function runGit(commandRunner, root, argumentsList) {
  let result;
  try {
    result = commandRunner("git", ["-C", root, ...argumentsList], {
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
  } catch {
    return { ok: false, stdout: "" };
  }
  return {
    ok: result?.status === 0,
    stdout: typeof result?.stdout === "string" ? result.stdout.trim() : "",
  };
}

function sameFilesystemPath(candidate, expected) {
  try {
    return fs.realpathSync(candidate) === fs.realpathSync(expected);
  } catch {
    return path.resolve(candidate) === path.resolve(expected);
  }
}

export class BuildIdentityError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "BuildIdentityError";
    this.code = code;
  }
}
