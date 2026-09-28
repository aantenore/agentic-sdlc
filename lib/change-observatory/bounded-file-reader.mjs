import { fs as nodeFs, fsPromises as fs } from "../runtime/host.mjs";
import { ObservatoryPathError } from "./path-safety.mjs";

const { constants: fsConstants } = nodeFs;

const NO_FOLLOW_FLAG = fsConstants.O_NOFOLLOW ?? 0;
const DEFAULT_CHUNK_BYTES = 64 * 1024;

/**
 * Read a previously resolved regular file through one handle, with a hard byte
 * bound and identity checks before and after the read. The returned bytes are
 * never taken from a pathname that changed after resolution.
 */
export async function readResolvedFileBounded(resolvedFile, options = {}) {
  if (!resolvedFile || typeof resolvedFile.resolved !== "string" || !resolvedFile.stats?.isFile?.()) {
    throw new TypeError("A resolved regular file is required");
  }
  const maxBytes = normalizeMaxBytes(options.maxBytes);
  const chunkBytes = Math.min(normalizeChunkBytes(options.chunkBytes), maxBytes + 1);
  const boundaryCode = options.boundaryCode || "file_boundary_changed";
  const tooLargeCode = options.tooLargeCode || "file_too_large";
  const tooLargeMessage = options.tooLargeMessage || "The requested file exceeds the configured size limit";
  const onHandleOpened = typeof options.onHandleOpened === "function" ? options.onHandleOpened : null;

  if (resolvedFile.stats.size > maxBytes) {
    throw new ObservatoryPathError(tooLargeCode, tooLargeMessage, 413);
  }

  let handle;
  try {
    handle = await fs.open(resolvedFile.resolved, fsConstants.O_RDONLY | NO_FOLLOW_FLAG);
    const before = await handle.stat({ bigint: true });
    assertRegularStableIdentity(resolvedFile, before, boundaryCode);
    await onHandleOpened?.({ handle, resolvedFile });

    const chunks = [];
    let total = 0;
    let position = 0;
    while (total <= maxBytes) {
      const remaining = maxBytes + 1 - total;
      if (remaining <= 0) break;
      const target = Buffer.allocUnsafe(Math.min(chunkBytes, remaining));
      const { bytesRead } = await handle.read(target, 0, target.byteLength, position);
      if (bytesRead === 0) break;
      chunks.push(target.subarray(0, bytesRead));
      total += bytesRead;
      position += bytesRead;
    }
    if (total > maxBytes) {
      throw new ObservatoryPathError(tooLargeCode, tooLargeMessage, 413);
    }

    const after = await handle.stat({ bigint: true });
    assertSameOpenFile(before, after, boundaryCode);
    await assertPathStillNamesOpenFile(resolvedFile, after, boundaryCode);
    return Buffer.concat(chunks, total);
  } catch (error) {
    if (error instanceof ObservatoryPathError) throw error;
    if (error?.code === "ELOOP") {
      throw boundaryChanged(boundaryCode);
    }
    throw new ObservatoryPathError("source_unavailable", "The requested file is not safely readable", 403);
  } finally {
    await handle?.close().catch(() => {});
  }
}

function normalizeMaxBytes(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("maxBytes must be a positive safe integer");
  }
  return value;
}

function normalizeChunkBytes(value) {
  if (value === undefined) return DEFAULT_CHUNK_BYTES;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("chunkBytes must be a positive safe integer");
  }
  return value;
}

function assertRegularStableIdentity(resolvedFile, opened, code) {
  if (!opened.isFile()) throw boundaryChanged(code);
  // resolveExistingFileWithin supplies an exact bigint identity. Fall back to
  // the legacy Stats object for callers that assembled an older descriptor.
  const expected = resolvedFile.identity ?? resolvedFile.stats;
  if (
    String(opened.dev) !== String(expected.dev)
    || String(opened.ino) !== String(expected.ino)
    || opened.size !== BigInt(expected.size)
  ) {
    throw boundaryChanged(code);
  }
}

function assertSameOpenFile(before, after, code) {
  if (
    !after.isFile()
    || after.dev !== before.dev
    || after.ino !== before.ino
    || after.size !== before.size
    || after.mtimeNs !== before.mtimeNs
    || after.ctimeNs !== before.ctimeNs
  ) {
    throw boundaryChanged(code);
  }
}

async function assertPathStillNamesOpenFile(resolvedFile, opened, code) {
  try {
    const [realPath, current] = await Promise.all([
      fs.realpath(resolvedFile.resolved),
      fs.stat(resolvedFile.resolved, { bigint: true }),
    ]);
    if (
      realPath !== resolvedFile.resolved
      || !current.isFile()
      || current.dev !== opened.dev
      || current.ino !== opened.ino
      || current.size !== opened.size
      || current.mtimeNs !== opened.mtimeNs
      || current.ctimeNs !== opened.ctimeNs
    ) {
      throw boundaryChanged(code);
    }
  } catch (error) {
    if (error instanceof ObservatoryPathError) throw error;
    throw boundaryChanged(code);
  }
}

function boundaryChanged(code) {
  return new ObservatoryPathError(
    code,
    "The requested file changed while it was being read",
    409,
  );
}
