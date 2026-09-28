import path from "node:path";
import { fs } from "./runtime/host.mjs";

/**
 * Reject symlinks between a trusted project boundary and a target path.
 *
 * The boundary is the first inspected segment. Once the caller has established
 * that boundary as the project root, inspecting volume-root parents would add
 * no project protection and can fail inside a sandbox that exposes only the
 * workspace.
 */
export function assertNoSymlinkSegmentsWithinBoundary(
  boundaryRoot,
  targetPath,
  options = {},
) {
  const fsModule = options.fsModule ?? fs;
  const pathModule = options.pathModule ?? path;
  const boundary = pathModule.resolve(boundaryRoot);
  const target = pathModule.resolve(targetPath);
  inspectEntry(boundary, fsModule);
  const canonicalBoundary = realPathIfSupported(boundary, fsModule);
  const inspectionBoundary = isInsideBoundary(boundary, target, pathModule)
    ? boundary
    : isInsideBoundary(canonicalBoundary, target, pathModule)
      ? canonicalBoundary
      : null;
  if (!inspectionBoundary) {
    throw new ProjectPathSafetyError(
      `Path escapes the trusted project boundary ${boundary}: ${target}`,
      "PROJECT_PATH_OUTSIDE_BOUNDARY",
    );
  }

  inspectEntry(inspectionBoundary, fsModule);
  const relative = pathModule.relative(inspectionBoundary, target);
  let current = inspectionBoundary;
  for (const segment of relative.split(pathModule.sep).filter(Boolean)) {
    current = pathModule.join(current, segment);
    inspectEntry(current, fsModule);
  }
  return target;
}

function inspectEntry(entryPath, fsModule) {
  let entry;
  try {
    entry = fsModule.lstatSync(entryPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (entry.isSymbolicLink()) {
    throw new ProjectPathSafetyError(
      `Refusing to follow symlink inside the project boundary: ${entryPath}`,
      "PROJECT_PATH_SYMLINK",
    );
  }
}

function realPathIfSupported(filePath, fsModule) {
  const resolver = fsModule.realpathSync?.native ?? fsModule.realpathSync;
  return typeof resolver === "function"
    ? resolver.call(fsModule.realpathSync, filePath)
    : filePath;
}

function isInsideBoundary(boundary, target, pathModule) {
  const relative = pathModule.relative(boundary, target);
  return relative !== ".."
    && !relative.startsWith(`..${pathModule.sep}`)
    && !pathModule.isAbsolute(relative);
}

export class ProjectPathSafetyError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ProjectPathSafetyError";
    this.code = code;
  }
}
