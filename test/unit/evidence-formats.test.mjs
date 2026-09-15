import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import {
  EvidenceFormatError,
  inspectJpegEvidence,
  inspectPdfEvidence,
  inspectPngEvidence,
  inspectWebpEvidence,
  inspectZipContainer,
  readZipEntry,
} from "../../lib/evidence-formats.mjs";

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

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type, data, { corruptCrc = false } = {}) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(corruptCrc ? (crc32(body) ^ 0xffffffff) >>> 0 : crc32(body));
  return Buffer.concat([length, body, crc]);
}

function pngHeader({ width = 1, height = 1, interlace = 0 } = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 0;
  header[10] = 0;
  header[11] = 0;
  header[12] = interlace;
  return header;
}

function buildPng(overrides = {}) {
  const {
    header = pngHeader(),
    imageData = zlib.deflateSync(Buffer.from([0, 0, 0, 0])),
    includeEnd = true,
    trailing = Buffer.alloc(0),
    corruptHeaderCrc = false,
  } = overrides;
  const chunks = [
    PNG_SIGNATURE,
    pngChunk("IHDR", header, { corruptCrc: corruptHeaderCrc }),
    pngChunk("IDAT", imageData),
  ];
  if (includeEnd) chunks.push(pngChunk("IEND", Buffer.alloc(0)));
  chunks.push(trailing);
  return Buffer.concat(chunks);
}

test("PNG evidence is accepted only when the chunk stream is complete and self-consistent", () => {
  inspectPngEvidence(buildPng());

  assert.throws(
    () => inspectPngEvidence(Buffer.concat([Buffer.from("NOTAPNG!"), buildPng().subarray(8)])),
    /invalid PNG signature/u,
  );
  assert.throws(() => inspectPngEvidence(buildPng({ corruptHeaderCrc: true })), /invalid CRC for IHDR chunk/u);
  assert.throws(() => inspectPngEvidence(buildPng({ includeEnd: false })), /terminal IEND chunk/u);
  assert.throws(
    () => inspectPngEvidence(buildPng({ trailing: Buffer.from([0x00, 0x01]) })),
    /terminal IEND chunk/u,
  );
  assert.throws(
    () => inspectPngEvidence(buildPng({ header: pngHeader({ width: 0 }) })),
    /invalid PNG dimensions/u,
  );
  assert.throws(
    () => inspectPngEvidence(buildPng({ header: pngHeader({ interlace: 2 }) })),
    /invalid PNG dimensions or compression\/filter\/interlace method/u,
  );
  assert.throws(() => inspectPngEvidence(PNG_SIGNATURE), /terminal IEND chunk/u);
});

test("PNG image data that decompresses to nothing is rejected", () => {
  assert.throws(
    () => inspectPngEvidence(buildPng({ imageData: zlib.deflateSync(Buffer.alloc(0)) })),
    /decompresses to an empty payload/u,
  );
});

function jpegSegment(marker, payload = Buffer.alloc(0)) {
  const length = Buffer.alloc(2);
  length.writeUInt16BE(payload.length + 2);
  return Buffer.concat([Buffer.from([0xff, marker]), length, payload]);
}

function buildJpeg({ includeFrame = true, includeScan = true, includeEnd = true, trailing = Buffer.alloc(0) } = {}) {
  const frame = Buffer.alloc(6);
  frame[0] = 8;
  frame.writeUInt16BE(1, 1);
  frame.writeUInt16BE(1, 3);
  frame[5] = 1;
  const parts = [Buffer.from([0xff, 0xd8])];
  if (includeFrame) parts.push(jpegSegment(0xc0, frame));
  if (includeScan) {
    parts.push(jpegSegment(0xda, Buffer.from([0x01, 0x00, 0x00, 0x00, 0x3f, 0x00])));
    parts.push(Buffer.from([0x12, 0x34]));
  }
  if (includeEnd) parts.push(Buffer.from([0xff, 0xd9]));
  parts.push(trailing);
  return Buffer.concat(parts);
}

test("JPEG evidence requires a frame, scan data, and a terminating EOI", () => {
  inspectJpegEvidence(buildJpeg());

  assert.throws(() => inspectJpegEvidence(Buffer.from([0x00, 0x00])), /invalid JPEG SOI marker/u);
  assert.throws(() => inspectJpegEvidence(buildJpeg({ includeFrame: false })), /frame, scan data, and EOI/u);
  assert.throws(() => inspectJpegEvidence(buildJpeg({ includeScan: false })), /frame, scan data, and EOI/u);
  assert.throws(() => inspectJpegEvidence(buildJpeg({ includeEnd: false })), /frame, scan data, and EOI/u);
  assert.throws(
    () => inspectJpegEvidence(buildJpeg({ trailing: Buffer.from([0x41]) })),
    /unexpected payload after JPEG EOI marker/u,
  );
});

test("JPEG whitespace padding after EOI stays acceptable", () => {
  inspectJpegEvidence(buildJpeg({ trailing: Buffer.from([0x0a, 0x0d, 0x20, 0x00]) }));
});

function riffChunk(type, payload) {
  const length = Buffer.alloc(4);
  length.writeUInt32LE(payload.length);
  const padding = payload.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0);
  return Buffer.concat([Buffer.from(type, "ascii"), length, payload, padding]);
}

function buildWebp({ chunk = riffChunk("VP8 ", Buffer.alloc(8)), declaredSize = null, trailing = Buffer.alloc(0) } = {}) {
  const body = Buffer.concat([Buffer.from("WEBP", "ascii"), chunk, trailing]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(declaredSize ?? body.length);
  return Buffer.concat([Buffer.from("RIFF", "ascii"), size, body]);
}

test("WebP evidence requires a matching RIFF size and a real image chunk", () => {
  inspectWebpEvidence(buildWebp());

  assert.throws(() => inspectWebpEvidence(Buffer.alloc(16)), /invalid WebP RIFF signature/u);
  assert.throws(
    () => inspectWebpEvidence(buildWebp({ declaredSize: 4 })),
    /RIFF size does not match file length/u,
  );
  assert.throws(
    () => inspectWebpEvidence(buildWebp({ chunk: riffChunk("META", Buffer.alloc(8)) })),
    /no valid image chunk/u,
  );
  assert.throws(
    () => inspectWebpEvidence(buildWebp({ chunk: riffChunk("VP8 ", Buffer.alloc(2)) })),
    /truncated VP8 image chunk/u,
  );
});

test("PDF evidence requires a header, a page object, and a startxref trailer", () => {
  const pdf = "%PDF-1.7\n1 0 obj\n<< /Type /Pages /Count 1 >>\nendobj\nstartxref\n42\n%%EOF\n";
  inspectPdfEvidence(Buffer.from(pdf, "latin1"));

  assert.throws(() => inspectPdfEvidence(Buffer.from("not a pdf", "latin1")), /invalid PDF header/u);
  assert.throws(
    () => inspectPdfEvidence(Buffer.from("%PDF-1.7\nstartxref\n42\n%%EOF\n", "latin1")),
    /no page tree or page object/u,
  );
  assert.throws(
    () => inspectPdfEvidence(Buffer.from("%PDF-1.7\n<< /Type /Page >>\n", "latin1")),
    /no valid startxref\/EOF trailer/u,
  );
});

function withTempDirectory(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-formats-"));
  try {
    return run(directory);
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
}

function buildZip(entries, { encryptFirst = false, method = 8 } = {}) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const raw = Buffer.from(content, "utf8");
    const stored = method === 0 ? raw : zlib.deflateRawSync(raw);
    const flags = encryptFirst && locals.length === 0 ? 0x1 : 0x0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(Buffer.concat([local, nameBytes, stored]));

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(flags, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt32LE(crc32(raw), 16);
    header.writeUInt32LE(stored.length, 20);
    header.writeUInt32LE(raw.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([header, nameBytes]));

    offset += 30 + nameBytes.length + stored.length;
  }

  const localBlock = Buffer.concat(locals);
  const centralBlock = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBlock.length, 12);
  eocd.writeUInt32LE(localBlock.length, 16);
  return Buffer.concat([localBlock, centralBlock, eocd]);
}

test("ZIP containers expose their entries and round-trip deflated payloads", () => {
  withTempDirectory((directory) => {
    const archivePath = path.join(directory, "document.docx");
    fs.writeFileSync(archivePath, buildZip([
      ["[Content_Types].xml", "<Types/>"],
      ["word/document.xml", "<document>evidence</document>"],
    ]));

    const entries = inspectZipContainer(archivePath, ["word/document.xml"]);
    assert.deepEqual([...entries.keys()].sort(), ["[Content_Types].xml", "word/document.xml"]);
    assert.equal(
      readZipEntry(archivePath, entries.get("word/document.xml")).toString("utf8"),
      "<document>evidence</document>",
    );
  });
});

test("ZIP containers read stored entries without decompression", () => {
  withTempDirectory((directory) => {
    const archivePath = path.join(directory, "stored.xlsx");
    fs.writeFileSync(archivePath, buildZip([["sheet.xml", "<sheet/>"]], { method: 0 }));
    const entries = inspectZipContainer(archivePath, ["sheet.xml"]);
    assert.equal(readZipEntry(archivePath, entries.get("sheet.xml")).toString("utf8"), "<sheet/>");
  });
});

test("ZIP failures are reported as EvidenceFormatError with a file-scoped message", () => {
  withTempDirectory((directory) => {
    const notAnArchive = path.join(directory, "broken.docx");
    fs.writeFileSync(notAnArchive, Buffer.alloc(64));
    assert.throws(() => inspectZipContainer(notAnArchive), (error) => {
      assert.ok(error instanceof EvidenceFormatError);
      assert.match(error.message, /broken\.docx is not a valid ZIP container\./u);
      return true;
    });

    const archivePath = path.join(directory, "document.docx");
    fs.writeFileSync(archivePath, buildZip([["word/document.xml", "<document/>"]]));
    assert.throws(
      () => inspectZipContainer(archivePath, ["word/missing.xml"]),
      /document\.docx is missing required OOXML entry word\/missing\.xml\./u,
    );

    const encryptedPath = path.join(directory, "encrypted.docx");
    fs.writeFileSync(encryptedPath, buildZip([["word/document.xml", "<document/>"]], { encryptFirst: true }));
    assert.throws(
      () => inspectZipContainer(encryptedPath, ["word/document.xml"]),
      /encrypts required OOXML entry word\/document\.xml; it cannot be verified\./u,
    );

    const unsupportedPath = path.join(directory, "unsupported.docx");
    fs.writeFileSync(unsupportedPath, buildZip([["word/document.xml", "<document/>"]], { method: 12 }));
    assert.throws(
      () => inspectZipContainer(unsupportedPath, ["word/document.xml"]),
      /uses unsupported ZIP compression 12 for word\/document\.xml\./u,
    );
  });
});
