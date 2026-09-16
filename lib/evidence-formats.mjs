import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

/**
 * Structural readers for the binary evidence formats the lifecycle accepts as
 * verifiable artifacts: PNG, JPEG, WebP, PDF, and the ZIP container that backs
 * every OOXML document.
 *
 * These are verifiers, not decoders. They parse only as deep as it takes to
 * prove that a delivered file is the format it claims to be and that its
 * declared structure is internally consistent. Nothing here renders, converts,
 * or repairs a file, and no branch is permissive: an unreadable or ambiguous
 * structure is a rejection, never a best-effort result.
 *
 * The image and document readers raise a plain `Error` describing the exact
 * structural violation. The archive readers raise {@link EvidenceFormatError}
 * because their messages are shown to a person as-is.
 */

export class EvidenceFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = "EvidenceFormatError";
  }
}

function throwEvidenceFormatError(message) {
  throw new EvidenceFormatError(message);
}

export function inspectPngEvidence(bytes) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!bytes.subarray(0, 8).equals(signature)) {
    throw new Error("invalid PNG signature");
  }
  let offset = 8;
  let sawHeader = false;
  let sawEnd = false;
  const imageData = [];
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) {
      throw new Error("truncated PNG chunk");
    }
    const length = bytes.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = typeStart + 4;
    const dataEnd = dataStart + length;
    const crcOffset = dataEnd;
    if (crcOffset + 4 > bytes.length) {
      throw new Error("PNG chunk exceeds file length");
    }
    const type = bytes.subarray(typeStart, dataStart).toString("ascii");
    const expectedCrc = bytes.readUInt32BE(crcOffset);
    const actualCrc = crc32(bytes.subarray(typeStart, dataEnd));
    if (expectedCrc !== actualCrc) {
      throw new Error(`invalid CRC for ${type || "unknown"} chunk`);
    }
    const data = bytes.subarray(dataStart, dataEnd);
    if (!sawHeader) {
      if (type !== "IHDR" || length !== 13) {
        throw new Error("IHDR must be the first PNG chunk");
      }
      const width = data.readUInt32BE(0);
      const height = data.readUInt32BE(4);
      if (width < 1 || height < 1 || data[10] !== 0 || data[11] !== 0 || ![0, 1].includes(data[12])) {
        throw new Error("invalid PNG dimensions or compression/filter/interlace method");
      }
      sawHeader = true;
    } else if (type === "IDAT") {
      imageData.push(data);
    } else if (type === "IEND") {
      if (length !== 0) {
        throw new Error("IEND chunk must be empty");
      }
      sawEnd = true;
      offset = crcOffset + 4;
      break;
    }
    offset = crcOffset + 4;
  }
  if (!sawHeader || imageData.length === 0 || !sawEnd || offset !== bytes.length) {
    throw new Error("PNG must contain IHDR, image data, and a terminal IEND chunk");
  }
  const decoded = zlib.inflateSync(Buffer.concat(imageData));
  if (decoded.length === 0) {
    throw new Error("PNG image data decompresses to an empty payload");
  }
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function inspectJpegEvidence(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error("invalid JPEG SOI marker");
  }
  let offset = 2;
  let sawFrame = false;
  let sawScan = false;
  let sawEnd = false;
  const frameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      if (sawScan) {
        offset += 1;
        continue;
      }
      throw new Error("JPEG marker prefix is missing");
    }
    while (bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) throw new Error("truncated JPEG marker");
    const marker = bytes[offset++];
    if (marker === 0x00 && sawScan) continue;
    if (marker === 0xd9) {
      sawEnd = true;
      break;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (offset + 2 > bytes.length) throw new Error("truncated JPEG segment length");
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) throw new Error("invalid JPEG segment length");
    if (frameMarkers.has(marker)) {
      if (length < 8) throw new Error("truncated JPEG frame header");
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      if (width < 1 || height < 1) throw new Error("invalid JPEG dimensions");
      sawFrame = true;
    }
    if (marker === 0xda) sawScan = true;
    offset += length;
  }
  if (!sawFrame || !sawScan || !sawEnd) {
    throw new Error("JPEG must contain a frame, scan data, and EOI marker");
  }
  if (bytes.subarray(offset).some((byte) => ![0x00, 0x0a, 0x0d, 0x20, 0xff].includes(byte))) {
    throw new Error("unexpected payload after JPEG EOI marker");
  }
}

export function inspectWebpEvidence(bytes) {
  if (bytes.subarray(0, 4).toString("ascii") !== "RIFF" || bytes.subarray(8, 12).toString("ascii") !== "WEBP") {
    throw new Error("invalid WebP RIFF signature");
  }
  if (bytes.readUInt32LE(4) + 8 !== bytes.length) {
    throw new Error("WebP RIFF size does not match file length");
  }
  let offset = 12;
  let sawImage = false;
  while (offset + 8 <= bytes.length) {
    const type = bytes.subarray(offset, offset + 4).toString("ascii");
    const length = bytes.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd > bytes.length) throw new Error("WebP chunk exceeds file length");
    if (["VP8 ", "VP8L", "VP8X"].includes(type)) {
      if (length < (type === "VP8X" ? 10 : 5)) throw new Error(`truncated ${type.trim()} image chunk`);
      sawImage = true;
    }
    offset = dataEnd + (length % 2);
  }
  if (!sawImage || offset !== bytes.length) {
    throw new Error("WebP has no valid image chunk or has trailing data");
  }
}

export function inspectPdfEvidence(bytes) {
  const text = bytes.toString("latin1");
  if (!text.startsWith("%PDF-")) throw new Error("invalid PDF header");
  if (!/\/Type\s*\/Pages?\b/.test(text)) throw new Error("PDF contains no page tree or page object");
  if (!/startxref\s+\d+\s+%%EOF\s*$/s.test(text.slice(-4096))) {
    throw new Error("PDF has no valid startxref/EOF trailer");
  }
}

export function inspectZipContainer(filePath, requiredEntries = []) {
  const buffer = fs.readFileSync(filePath);
  const minimumEocdSize = 22;
  let eocdOffset = -1;
  for (let offset = buffer.length - minimumEocdSize; offset >= Math.max(0, buffer.length - 65_557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) {
    throwEvidenceFormatError(`${path.basename(filePath)} is not a valid ZIP container.`);
  }
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralSize = buffer.readUInt32LE(eocdOffset + 12);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (centralOffset + centralSize > buffer.length) {
    throwEvidenceFormatError(`${path.basename(filePath)} has an invalid ZIP central directory.`);
  }
  const entries = new Map();
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throwEvidenceFormatError(`${path.basename(filePath)} has a malformed ZIP directory entry.`);
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > buffer.length) {
      throwEvidenceFormatError(`${path.basename(filePath)} has a truncated ZIP directory entry.`);
    }
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    entries.set(name, { name, flags, method, compressedSize, uncompressedSize, localOffset });
    offset = end;
  }
  for (const required of requiredEntries) {
    const entry = entries.get(required);
    if (!entry) {
      throwEvidenceFormatError(`${path.basename(filePath)} is missing required OOXML entry ${required}.`);
    }
    if ((entry.flags & 0x1) !== 0) {
      throwEvidenceFormatError(`${path.basename(filePath)} encrypts required OOXML entry ${required}; it cannot be verified.`);
    }
    readZipEntry(filePath, entry);
  }
  return entries;
}

export function readZipEntry(filePath, entry) {
  const buffer = fs.readFileSync(filePath);
  const offset = entry.localOffset;
  if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== 0x04034b50) {
    throwEvidenceFormatError(`${path.basename(filePath)} has an invalid local ZIP header for ${entry.name}.`);
  }
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buffer.length) {
    throwEvidenceFormatError(`${path.basename(filePath)} has truncated ZIP data for ${entry.name}.`);
  }
  const compressed = buffer.subarray(dataStart, dataEnd);
  let value;
  if (entry.method === 0) {
    value = Buffer.from(compressed);
  } else if (entry.method === 8) {
    try {
      value = zlib.inflateRawSync(compressed);
    } catch (error) {
      throwEvidenceFormatError(`${path.basename(filePath)} cannot decompress ${entry.name}: ${error.message}`);
    }
  } else {
    throwEvidenceFormatError(`${path.basename(filePath)} uses unsupported ZIP compression ${entry.method} for ${entry.name}.`);
  }
  if (value.length !== entry.uncompressedSize) {
    throwEvidenceFormatError(`${path.basename(filePath)} has an invalid uncompressed size for ${entry.name}.`);
  }
  return value;
}
