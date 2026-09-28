import fs from "node:fs";
import path from "node:path";

const mode = process.env.AGENTIC_SDLC_BOOTSTRAP_PRELOAD_MODE;
const markerPath = process.env.AGENTIC_SDLC_BOOTSTRAP_PRELOAD_MARKER;

function markTriggered(value) {
  if (markerPath) {
    fs.writeFileSync(markerPath, `${value}\n`, "utf8");
  }
}

function mutatingOpen(flags) {
  if (typeof flags === "string") return /[+awx]/u.test(flags);
  return typeof flags === "number" && (flags & (
    fs.constants.O_WRONLY
    | fs.constants.O_RDWR
    | fs.constants.O_APPEND
    | fs.constants.O_CREAT
    | fs.constants.O_EXCL
    | fs.constants.O_TRUNC
  )) !== 0;
}

function canonicalPotentialPath(filePath) {
  let current = path.resolve(filePath);
  const missingSegments = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    missingSegments.unshift(path.basename(current));
    current = parent;
  }
  const canonicalParent = fs.realpathSync.native(current);
  return path.join(canonicalParent, ...missingSegments);
}

if (mode === "fail-baseline-report-write" || mode === "fail-baseline-trace-write") {
  const targetEnvironmentName = mode === "fail-baseline-report-write"
    ? "AGENTIC_SDLC_BOOTSTRAP_PRELOAD_BASELINE_REPORT_PATH"
    : "AGENTIC_SDLC_BOOTSTRAP_PRELOAD_TRACE_PATH";
  const targetPath = canonicalPotentialPath(process.env[targetEnvironmentName] || "");
  const marker = mode === "fail-baseline-report-write"
    ? "baseline-report-write"
    : "baseline-trace-write";
  const originalOpenSync = fs.openSync.bind(fs);
  const originalLinkSync = fs.linkSync.bind(fs);
  let triggered = false;
  const injectFailure = () => {
    triggered = true;
    markTriggered(marker);
    const error = new Error(`Injected test-only failure before ${marker}.`);
    error.code = "EIO";
    throw error;
  };
  fs.openSync = (filePath, flags, ...rest) => {
    if (
      !triggered
      && typeof filePath === "string"
      && canonicalPotentialPath(filePath) === targetPath
      && mutatingOpen(flags)
    ) {
      injectFailure();
    }
    return originalOpenSync(filePath, flags, ...rest);
  };
  // New records are published by linking a complete temporary file into place.
  fs.linkSync = (sourcePath, destinationPath, ...rest) => {
    if (
      !triggered
      && typeof destinationPath === "string"
      && canonicalPotentialPath(destinationPath) === targetPath
    ) {
      injectFailure();
    }
    return originalLinkSync(sourcePath, destinationPath, ...rest);
  };
}

if (mode === "fail-manifest-write") {
  const manifestPath = path.resolve(process.env.AGENTIC_SDLC_BOOTSTRAP_PRELOAD_MANIFEST_PATH || "");
  const originalLinkSync = fs.linkSync.bind(fs);
  fs.linkSync = (sourcePath, destinationPath, ...rest) => {
    if (path.resolve(String(destinationPath)) === manifestPath) {
      markTriggered("manifest-write");
      const error = new Error("Injected test-only failure before publishing the bootstrap manifest.");
      error.code = "EIO";
      throw error;
    }
    return originalLinkSync(sourcePath, destinationPath, ...rest);
  };
}

if (mode === "assert-bootstrap-durable-before-manifest") {
  const manifestPath = canonicalPotentialPath(
    process.env.AGENTIC_SDLC_BOOTSTRAP_PRELOAD_MANIFEST_PATH || "",
  );
  const expectedFiles = new Set(JSON.parse(
    process.env.AGENTIC_SDLC_BOOTSTRAP_PRELOAD_EXPECTED_FILES_JSON || "[]",
  ).map(canonicalPotentialPath));
  const expectedDirectories = new Set(JSON.parse(
    process.env.AGENTIC_SDLC_BOOTSTRAP_PRELOAD_EXPECTED_DIRECTORIES_JSON || "[]",
  ).map(canonicalPotentialPath));
  const openedPaths = new Map();
  const syncedPaths = new Set();
  const originalOpenSync = fs.openSync.bind(fs);
  const originalCloseSync = fs.closeSync.bind(fs);
  const originalFsyncSync = fs.fsyncSync.bind(fs);
  const originalLinkSync = fs.linkSync.bind(fs);

  fs.openSync = (filePath, ...args) => {
    const descriptor = originalOpenSync(filePath, ...args);
    if (typeof filePath === "string") {
      openedPaths.set(descriptor, canonicalPotentialPath(filePath));
    }
    return descriptor;
  };
  fs.fsyncSync = (descriptor) => {
    const result = originalFsyncSync(descriptor);
    const openedPath = openedPaths.get(descriptor);
    if (openedPath) syncedPaths.add(openedPath);
    return result;
  };
  fs.closeSync = (descriptor) => {
    try {
      return originalCloseSync(descriptor);
    } finally {
      openedPaths.delete(descriptor);
    }
  };
  fs.linkSync = (sourcePath, destinationPath, ...rest) => {
    if (canonicalPotentialPath(destinationPath) === manifestPath) {
      const missingFiles = [...expectedFiles].filter((filePath) => !syncedPaths.has(filePath));
      const missingDirectories = [...expectedDirectories]
        .filter((directoryPath) => !syncedPaths.has(directoryPath));
      if (missingFiles.length > 0 || missingDirectories.length > 0) {
        const error = new Error(
          `Bootstrap manifest was published before durable state: `
          + `files=${missingFiles.join(",")}; directories=${missingDirectories.join(",")}`,
        );
        error.code = "EIO";
        throw error;
      }
      markTriggered("durable-before-manifest");
    }
    return originalLinkSync(sourcePath, destinationPath, ...rest);
  };
}

if (mode === "swap-config-after-context") {
  const configPath = path.resolve(process.env.AGENTIC_SDLC_BOOTSTRAP_PRELOAD_CONFIG_PATH || "");
  const lockPath = path.resolve(process.env.AGENTIC_SDLC_BOOTSTRAP_PRELOAD_LOCK_PATH || "");
  const replacementConfigPath = path.resolve(
    process.env.AGENTIC_SDLC_BOOTSTRAP_PRELOAD_REPLACEMENT_CONFIG || "",
  );
  const replacementLockPath = path.resolve(
    process.env.AGENTIC_SDLC_BOOTSTRAP_PRELOAD_REPLACEMENT_LOCK || "",
  );
  const originalOpenSync = fs.openSync.bind(fs);
  let configOpenCount = 0;
  let swapped = false;
  fs.openSync = (filePath, ...args) => {
    if (typeof filePath === "string" && path.resolve(filePath) === configPath) {
      configOpenCount += 1;
      if (!swapped && configOpenCount === 2) {
        swapped = true;
        fs.writeFileSync(configPath, fs.readFileSync(replacementConfigPath));
        fs.writeFileSync(lockPath, fs.readFileSync(replacementLockPath));
        markTriggered("config-lock-swap");
      }
    }
    return originalOpenSync(filePath, ...args);
  };
}

if (mode === "replace-project-before-bootstrap-snapshot") {
  const projectPath = path.resolve(process.env.AGENTIC_SDLC_BOOTSTRAP_PRELOAD_PROJECT_PATH || "");
  const replacementPath = path.resolve(
    process.env.AGENTIC_SDLC_BOOTSTRAP_PRELOAD_REPLACEMENT_PROJECT || "",
  );
  const originalOpenSync = fs.openSync.bind(fs);
  const originalReadFileSync = fs.readFileSync.bind(fs);
  let projectOpenCount = 0;
  let swapped = false;

  const replaceProjectWithSymlink = () => {
    if (swapped) return;
    swapped = true;
    fs.rmSync(projectPath);
    fs.symlinkSync(replacementPath, projectPath);
    markTriggered("project-symlink-swap");
  };

  fs.openSync = (filePath, ...args) => {
    if (typeof filePath === "string" && path.resolve(filePath) === projectPath) {
      projectOpenCount += 1;
      if (projectOpenCount >= 2) replaceProjectWithSymlink();
    }
    return originalOpenSync(filePath, ...args);
  };
  fs.readFileSync = (filePath, ...args) => {
    if (
      typeof filePath === "string"
      && path.resolve(filePath) === projectPath
      && projectOpenCount >= 1
    ) {
      replaceProjectWithSymlink();
    }
    return originalReadFileSync(filePath, ...args);
  };
}
