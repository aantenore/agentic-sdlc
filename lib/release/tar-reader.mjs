import path from "node:path";
import { TextDecoder } from "node:util";
import { gunzipSync } from "node:zlib";
import { fs } from "../runtime/host.mjs";

const { constants: fsConstants, closeSync, fstatSync, lstatSync, openSync, readFileSync } = fs;


const TAR_BLOCK_BYTES = 512;
const ZERO_BLOCK = Buffer.alloc(TAR_BLOCK_BYTES);
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const SAFE_PAX_KEYS = new Set(["path", "size"]);
const WINDOWS_RESERVED_BASENAMES = new Set([
  "AUX",
  "CLOCK$",
  "CON",
  "CONIN$",
  "CONOUT$",
  "NUL",
  "PRN",
]);


export class TarArchiveError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TarArchiveError";
    this.code = code;
  }
}


function fail(code, message) {
  throw new TarArchiveError(code, message);
}


function isZeroBlock(block) {
  return block.length === TAR_BLOCK_BYTES && block.equals(ZERO_BLOCK);
}


function readFixedString(field, label) {
  const nul = field.indexOf(0);
  const content = nul === -1 ? field : field.subarray(0, nul);
  if (nul !== -1 && field.subarray(nul).some((byte) => byte !== 0)) {
    fail("INVALID_HEADER_STRING", `${label} contains data after its NUL terminator`);
  }
  try {
    return UTF8_DECODER.decode(content);
  } catch {
    fail("INVALID_HEADER_UTF8", `${label} is not valid UTF-8`);
  }
}


function readOctal(field, label, { allowEmpty = false } = {}) {
  if ((field[0] & 0x80) !== 0) {
    fail("UNSAFE_NUMERIC_ENCODING", `${label} uses unsupported base-256 encoding`);
  }
  const match = /^ *([0-7]+)[\0 ]*$/u.exec(field.toString("ascii"));
  if (!match && allowEmpty && /^[\0 ]*$/u.test(field.toString("ascii"))) return 0;
  if (!match) {
    fail("INVALID_OCTAL_FIELD", `${label} is not a valid non-negative octal value`);
  }
  const parsed = Number.parseInt(match[1], 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    fail("NUMERIC_LIMIT_EXCEEDED", `${label} exceeds the supported integer range`);
  }
  return parsed;
}


function verifyHeaderChecksum(header) {
  const expected = readOctal(header.subarray(148, 156), "header checksum");
  let unsigned = 0;
  for (let index = 0; index < header.length; index += 1) {
    unsigned += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (unsigned !== expected) {
    fail("HEADER_CHECKSUM_MISMATCH", "tar header checksum does not match its bytes");
  }
}


function parseHeader(header) {
  verifyHeaderChecksum(header);
  const magic = header.subarray(257, 263).toString("ascii");
  const version = header.subarray(263, 265).toString("ascii");
  if (magic !== "ustar\0" || version !== "00") {
    fail("UNSUPPORTED_TAR_FORMAT", "only canonical USTAR headers are accepted");
  }

  const name = readFixedString(header.subarray(0, 100), "USTAR name");
  const prefix = readFixedString(header.subarray(345, 500), "USTAR prefix");
  if (!name) fail("EMPTY_ARCHIVE_PATH", "USTAR name must not be empty");
  const rawPath = prefix ? `${prefix}/${name}` : name;
  const mode = readOctal(header.subarray(100, 108), "file mode", { allowEmpty: true });
  if (mode > 0o7777) fail("UNSAFE_FILE_MODE", "USTAR mode exceeds permission and special bits");
  const deviceMajor = readOctal(header.subarray(329, 337), "device major", { allowEmpty: true });
  const deviceMinor = readOctal(header.subarray(337, 345), "device minor", { allowEmpty: true });
  readOctal(header.subarray(108, 116), "owner id", { allowEmpty: true });
  readOctal(header.subarray(116, 124), "group id", { allowEmpty: true });
  readOctal(header.subarray(136, 148), "modification time", { allowEmpty: true });
  readFixedString(header.subarray(265, 297), "USTAR owner name");
  readFixedString(header.subarray(297, 329), "USTAR group name");
  const typeByte = header[156];
  const type = typeByte === 0 ? "0" : String.fromCharCode(typeByte);
  return {
    deviceMajor,
    deviceMinor,
    mode,
    rawPath,
    size: readOctal(header.subarray(124, 136), "entry size"),
    type,
    linkName: readFixedString(header.subarray(157, 257), "USTAR link name"),
  };
}


function validateSafePath(rawPath, {
  directory = false,
  label = "archive path",
  maxComponentBytes,
  maxPathBytes,
} = {}) {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    fail("EMPTY_ARCHIVE_PATH", `${label} must not be empty`);
  }
  if (rawPath.includes("\\")) {
    fail("BACKSLASH_PATH", `${label} must use POSIX separators only`);
  }
  if (rawPath.startsWith("/") || /^[A-Za-z]:/u.test(rawPath)) {
    fail("ABSOLUTE_ARCHIVE_PATH", `${label} must be relative`);
  }
  if (rawPath.includes("\0")) {
    fail("NUL_ARCHIVE_PATH", `${label} must not contain NUL bytes`);
  }

  let candidate = rawPath;
  if (directory && candidate.endsWith("/")) candidate = candidate.slice(0, -1);
  if (!candidate || (!directory && candidate.endsWith("/"))) {
    fail("INVALID_ARCHIVE_PATH", `${label} has an invalid trailing separator`);
  }
  if (candidate !== candidate.normalize("NFC")) {
    fail("NON_CANONICAL_UNICODE_PATH", `${label} must use NFC Unicode normalization`);
  }
  if (Buffer.byteLength(candidate, "utf8") > maxPathBytes) {
    fail("ARCHIVE_PATH_LIMIT_EXCEEDED", `${label} exceeds ${maxPathBytes} UTF-8 bytes`);
  }
  const components = candidate.split("/");
  if (components.some((part) => part === "" || part === "." || part === "..")) {
    fail("PATH_TRAVERSAL", `${label} contains an empty, dot, or parent component`);
  }
  if (components.some((part) => /[\u0000-\u001f\u007f]/u.test(part))) {
    fail("CONTROL_CHARACTER_PATH", `${label} contains a control character`);
  }
  for (const component of components) {
    if (Buffer.byteLength(component, "utf8") > maxComponentBytes) {
      fail("ARCHIVE_COMPONENT_LIMIT_EXCEEDED", `${label} component exceeds ${maxComponentBytes} UTF-8 bytes`);
    }
    if (/[<>:"|?*]/u.test(component)) {
      fail("WINDOWS_ILLEGAL_PATH", `${label} contains a character forbidden by Windows`);
    }
    if (/[. ]$/u.test(component)) {
      fail("WINDOWS_TRAILING_DOT_OR_SPACE", `${label} contains a component ending in a dot or space`);
    }
    const basename = component.split(".", 1)[0].replace(/[. ]+$/u, "").toUpperCase();
    if (WINDOWS_RESERVED_BASENAMES.has(basename) || /^(?:COM|LPT)(?:[1-9]|[¹²³])$/u.test(basename)) {
      fail("WINDOWS_RESERVED_PATH", `${label} contains a reserved Windows device name`);
    }
  }
  return components.join("/");
}


function parsePaxRecords(data, maxPaxBytes) {
  if (data.length > maxPaxBytes) {
    fail("PAX_LIMIT_EXCEEDED", `PAX metadata exceeds ${maxPaxBytes} bytes`);
  }
  const records = new Map();
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space <= offset) fail("INVALID_PAX_RECORD", "PAX record has no length separator");
    const lengthText = data.subarray(offset, space).toString("ascii");
    if (!/^[1-9][0-9]*$/u.test(lengthText)) {
      fail("INVALID_PAX_RECORD", "PAX record length is not canonical decimal");
    }
    const length = Number.parseInt(lengthText, 10);
    if (!Number.isSafeInteger(length) || length <= space - offset + 3) {
      fail("INVALID_PAX_RECORD", "PAX record length is invalid");
    }
    const end = offset + length;
    if (end > data.length || data[end - 1] !== 0x0a) {
      fail("INVALID_PAX_RECORD", "PAX record length or newline is invalid");
    }
    let body;
    try {
      body = UTF8_DECODER.decode(data.subarray(space + 1, end - 1));
    } catch {
      fail("INVALID_PAX_UTF8", "PAX record is not valid UTF-8");
    }
    const equals = body.indexOf("=");
    if (equals <= 0) fail("INVALID_PAX_RECORD", "PAX record has no key/value separator");
    const key = body.slice(0, equals);
    const value = body.slice(equals + 1);
    if (!SAFE_PAX_KEYS.has(key)) {
      fail("UNSAFE_PAX_KEY", `PAX key is not allowed: ${key}`);
    }
    if (records.has(key)) fail("DUPLICATE_PAX_KEY", `PAX key is duplicated: ${key}`);
    if (value.length === 0) fail("INVALID_PAX_RECORD", `PAX value must not be empty: ${key}`);
    records.set(key, value);
    offset = end;
  }
  return records;
}


function parsePaxSize(value) {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) {
    fail("INVALID_PAX_SIZE", "PAX size must be canonical non-negative decimal");
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) fail("NUMERIC_LIMIT_EXCEEDED", "PAX size is too large");
  return parsed;
}


function registerPath(registry, archivePath, entryType) {
  const folded = archivePath.toLowerCase();
  const existing = registry.get(folded);
  if (existing) {
    if (existing.path === archivePath) {
      fail("DUPLICATE_ARCHIVE_PATH", `archive path is duplicated: ${archivePath}`);
    }
    fail("CASE_INSENSITIVE_PATH_COLLISION", `archive paths collide when case is ignored: ${existing.path} and ${archivePath}`);
  }

  const components = archivePath.split("/");
  for (let length = 1; length < components.length; length += 1) {
    const ancestor = components.slice(0, length).join("/").toLowerCase();
    const ancestorEntry = registry.get(ancestor);
    if (ancestorEntry?.type === "file") {
      fail("FILE_DIRECTORY_COLLISION", `file is also used as a directory: ${ancestorEntry.path}`);
    }
  }
  if (entryType === "file") {
    const prefix = `${folded}/`;
    for (const [knownPath, knownEntry] of registry) {
      if (knownPath.startsWith(prefix)) {
        fail("FILE_DIRECTORY_COLLISION", `file is also used as a directory: ${archivePath} and ${knownEntry.path}`);
      }
    }
  }
  registry.set(folded, { path: archivePath, type: entryType });
}


function normalizeLimits(limits = {}) {
  const normalized = {
    maxCompressedBytes: limits.maxCompressedBytes,
    maxComponentBytes: limits.maxComponentBytes,
    maxEntries: limits.maxEntries,
    maxFileBytes: limits.maxFileBytes,
    maxPathBytes: limits.maxPathBytes,
    maxPaxBytes: limits.maxPaxBytes,
    maxTotalFileBytes: limits.maxTotalFileBytes,
    maxUncompressedBytes: limits.maxUncompressedBytes,
  };
  for (const [key, value] of Object.entries(normalized)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      fail("INVALID_ARCHIVE_LIMIT", `${key} must be a positive safe integer`);
    }
  }
  return normalized;
}


function readArchiveBytes(archivePath, maxCompressedBytes) {
  const before = lstatSync(archivePath);
  if (!before.isFile() || before.isSymbolicLink()) {
    fail("UNSAFE_ARCHIVE_FILE", "release archive must be an unlinked regular file");
  }
  if (before.size > maxCompressedBytes) {
    fail("COMPRESSED_LIMIT_EXCEEDED", `compressed archive exceeds ${maxCompressedBytes} bytes`);
  }

  const noFollow = process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
  let descriptor;
  try {
    descriptor = openSync(archivePath, fsConstants.O_RDONLY | noFollow);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      fail("ARCHIVE_CHANGED", "release archive changed while it was being opened");
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || bytes.length !== opened.size) {
      fail("ARCHIVE_CHANGED", "release archive changed while it was being read");
    }
    return bytes;
  } catch (error) {
    if (error instanceof TarArchiveError) throw error;
    fail("ARCHIVE_READ_FAILED", `could not read release archive: ${error.message}`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}


export function readTarGzipArchive(archivePath, limits) {
  const safeLimits = normalizeLimits(limits);
  const resolvedPath = path.resolve(archivePath);
  const archiveBytes = readArchiveBytes(resolvedPath, safeLimits.maxCompressedBytes);
  let tarBytes;
  try {
    tarBytes = gunzipSync(archiveBytes, { maxOutputLength: safeLimits.maxUncompressedBytes });
  } catch (error) {
    fail("INVALID_GZIP_ARCHIVE", `archive could not be safely decompressed: ${error.message}`);
  }
  if (tarBytes.length === 0 || tarBytes.length % TAR_BLOCK_BYTES !== 0) {
    fail("INVALID_TAR_LENGTH", "decompressed tar length must be a non-zero multiple of 512 bytes");
  }

  const entries = [];
  const registry = new Map();
  let headerCount = 0;
  let logicalCount = 0;
  let offset = 0;
  let pendingPax = null;
  let totalFileBytes = 0;
  let endBlocks = 0;

  while (offset < tarBytes.length) {
    const header = tarBytes.subarray(offset, offset + TAR_BLOCK_BYTES);
    if (isZeroBlock(header)) {
      endBlocks += 1;
      offset += TAR_BLOCK_BYTES;
      if (endBlocks >= 2) break;
      continue;
    }
    if (endBlocks !== 0) fail("INVALID_TAR_TERMINATOR", "non-zero data follows a tar terminator block");

    headerCount += 1;
    if (headerCount > safeLimits.maxEntries) {
      fail("ENTRY_LIMIT_EXCEEDED", `archive exceeds ${safeLimits.maxEntries} headers`);
    }
    const parsed = parseHeader(header);
    offset += TAR_BLOCK_BYTES;

    if (parsed.type === "g") fail("UNSAFE_PAX_GLOBAL_HEADER", "global PAX headers are not accepted");
    const provisionalSize = parsed.size;
    if (provisionalSize > safeLimits.maxUncompressedBytes) {
      fail("ENTRY_DATA_LIMIT_EXCEEDED", "entry data exceeds the decompression boundary");
    }
    const provisionalBlocks = Math.ceil(provisionalSize / TAR_BLOCK_BYTES);
    const provisionalEnd = offset + provisionalBlocks * TAR_BLOCK_BYTES;
    if (provisionalEnd > tarBytes.length) fail("TRUNCATED_TAR_ENTRY", "tar entry data is truncated");

    if (parsed.type === "x") {
      if (pendingPax) fail("ORPHANED_PAX_HEADER", "PAX header is not followed by a file entry");
      if (parsed.linkName || parsed.deviceMajor !== 0 || parsed.deviceMinor !== 0) {
        fail("UNSAFE_PAX_HEADER", "PAX header contains link or device metadata");
      }
      validateSafePath(parsed.rawPath, {
        label: "PAX header path",
        maxComponentBytes: safeLimits.maxComponentBytes,
        maxPathBytes: safeLimits.maxPathBytes,
      });
      pendingPax = parsePaxRecords(tarBytes.subarray(offset, offset + provisionalSize), safeLimits.maxPaxBytes);
      if (tarBytes.subarray(offset + provisionalSize, provisionalEnd).some((byte) => byte !== 0)) {
        fail("NON_ZERO_TAR_PADDING", "PAX data padding must contain only zero bytes");
      }
      offset = provisionalEnd;
      continue;
    }

    const isFile = parsed.type === "0";
    const isDirectory = parsed.type === "5";
    if (!isFile && !isDirectory) {
      const known = {
        "1": "hard link",
        "2": "symbolic link",
        "3": "character device",
        "4": "block device",
        "6": "FIFO",
        "7": "contiguous file",
      }[parsed.type] ?? `unknown type ${JSON.stringify(parsed.type)}`;
      fail("UNSAFE_ENTRY_TYPE", `archive contains an unsupported ${known}`);
    }
    if (parsed.linkName) fail("UNSAFE_LINK_NAME", "regular files and directories must not declare a link target");
    if (parsed.deviceMajor !== 0 || parsed.deviceMinor !== 0) {
      fail("UNSAFE_DEVICE_METADATA", "regular files and directories must not declare device numbers");
    }

    const effectivePath = pendingPax?.get("path") ?? parsed.rawPath;
    const effectiveSize = pendingPax?.has("size") ? parsePaxSize(pendingPax.get("size")) : parsed.size;
    pendingPax = null;
    if (effectiveSize !== parsed.size) {
      fail("AMBIGUOUS_PAX_SIZE", "PAX size must match the USTAR size field exactly");
    }
    if (isDirectory && effectiveSize !== 0) fail("DIRECTORY_WITH_DATA", "directory entry must have zero size");
    if (isFile && effectiveSize > safeLimits.maxFileBytes) {
      fail("FILE_LIMIT_EXCEEDED", `archive file exceeds ${safeLimits.maxFileBytes} bytes`);
    }
    totalFileBytes += isFile ? effectiveSize : 0;
    if (totalFileBytes > safeLimits.maxTotalFileBytes) {
      fail("TOTAL_FILE_LIMIT_EXCEEDED", `archive files exceed ${safeLimits.maxTotalFileBytes} bytes in total`);
    }

    validateSafePath(parsed.rawPath, {
      directory: isDirectory,
      label: "USTAR path",
      maxComponentBytes: safeLimits.maxComponentBytes,
      maxPathBytes: safeLimits.maxPathBytes,
    });
    const safePath = validateSafePath(effectivePath, {
      directory: isDirectory,
      maxComponentBytes: safeLimits.maxComponentBytes,
      maxPathBytes: safeLimits.maxPathBytes,
    });
    registerPath(registry, safePath, isFile ? "file" : "directory");
    const data = Buffer.from(tarBytes.subarray(offset, offset + effectiveSize));
    if (tarBytes.subarray(offset + effectiveSize, provisionalEnd).some((byte) => byte !== 0)) {
      fail("NON_ZERO_TAR_PADDING", "entry data padding must contain only zero bytes");
    }
    entries.push({
      path: safePath,
      type: isFile ? "file" : "directory",
      mode: parsed.mode,
      size: effectiveSize,
      data,
    });
    logicalCount += 1;
    offset = provisionalEnd;
  }

  if (endBlocks < 2) fail("MISSING_TAR_TERMINATOR", "tar archive must end with at least two zero blocks");
  if (pendingPax) fail("ORPHANED_PAX_HEADER", "PAX header is not followed by a file entry");
  if (tarBytes.subarray(offset).some((byte) => byte !== 0)) {
    fail("TRAILING_TAR_DATA", "non-zero data follows the tar terminator");
  }
  if (logicalCount === 0) fail("EMPTY_TAR_ARCHIVE", "tar archive contains no files or directories");

  return {
    archiveBytes,
    entries,
    headerCount,
    totalFileBytes,
    uncompressedBytes: tarBytes.length,
  };
}
