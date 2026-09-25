import { gzipSync } from "node:zlib";


const BLOCK_BYTES = 512;


function writeString(header, offset, length, value) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) throw new Error(`USTAR field is too long: ${value}`);
  bytes.copy(header, offset);
}


function writeOctal(header, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, "0");
  if (encoded.length > length - 1) throw new Error(`USTAR number is too large: ${value}`);
  writeString(header, offset, length - 1, encoded);
  header[offset + length - 1] = 0;
}


function splitUstarPath(archivePath) {
  const bytes = Buffer.byteLength(archivePath);
  if (bytes <= 100) return { name: archivePath, prefix: "" };
  for (let index = archivePath.lastIndexOf("/"); index > 0; index = archivePath.lastIndexOf("/", index - 1)) {
    const prefix = archivePath.slice(0, index);
    const name = archivePath.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw new Error(`Path cannot be encoded as USTAR: ${archivePath}`);
}


function buildHeader(entry, data) {
  const header = Buffer.alloc(BLOCK_BYTES);
  const { name, prefix } = splitUstarPath(entry.path);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, entry.mode ?? (entry.type === "5" ? 0o755 : 0o644));
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, data.length);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = Buffer.from(entry.type ?? "0", "ascii")[0];
  writeString(header, 157, 100, entry.linkName ?? "");
  writeString(header, 257, 6, entry.magic ?? "ustar\0");
  writeString(header, 263, 2, entry.version ?? "00");
  writeString(header, 265, 32, "fixture");
  writeString(header, 297, 32, "fixture");
  writeString(header, 345, 155, entry.prefix ?? prefix);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  const encodedChecksum = checksum.toString(8).padStart(6, "0");
  writeString(header, 148, 6, encodedChecksum);
  header[154] = 0;
  header[155] = 0x20;
  if (entry.corruptChecksum) header[0] ^= 1;
  return header;
}


function paxRecord(key, value) {
  const body = `${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 2;
  while (true) {
    const next = Buffer.byteLength(body) + String(length).length + 1;
    if (next === length) return Buffer.from(`${length} ${body}`, "utf8");
    length = next;
  }
}


function appendPhysicalEntry(blocks, entry) {
  const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? "", "utf8");
  blocks.push(buildHeader(entry, data), data);
  const padding = (BLOCK_BYTES - (data.length % BLOCK_BYTES)) % BLOCK_BYTES;
  if (padding) blocks.push(Buffer.alloc(padding, entry.paddingByte ?? 0));
}


export function buildTarGzip(entries, { trailingData, zeroBlocks = 2 } = {}) {
  const blocks = [];
  let paxIndex = 0;
  for (const entry of entries) {
    if (entry.pax) {
      const records = Object.entries(entry.pax).map(([key, value]) => paxRecord(key, String(value)));
      appendPhysicalEntry(blocks, {
        path: `PaxHeaders/${paxIndex}`,
        type: "x",
        data: Buffer.concat(records),
      });
      paxIndex += 1;
    }
    const physical = { ...entry };
    delete physical.pax;
    appendPhysicalEntry(blocks, physical);
  }
  blocks.push(Buffer.alloc(BLOCK_BYTES * zeroBlocks));
  if (trailingData) blocks.push(Buffer.from(trailingData));
  return gzipSync(Buffer.concat(blocks), { level: 9, mtime: 0 });
}


export function validReleaseFixtureEntries({ version = "0.13.3", extra = [] } = {}) {
  const packageJson = {
    name: "agentic-sdlc",
    version,
    type: "module",
    bin: { "agentic-sdlc": "./bin/agentic-sdlc.mjs" },
  };
  const pluginJson = {
    name: "agentic-sdlc",
    version,
  };
  const claudePluginJson = {
    name: "agentic-sdlc",
    version,
  };
  const claudeMarketplaceJson = {
    name: "aantenore",
    plugins: [{ name: "agentic-sdlc", source: "./", version }],
  };
  return [
    { path: "package/package.json", data: `${JSON.stringify(packageJson)}\n` },
    { path: "package/.claude-plugin/plugin.json", data: `${JSON.stringify(claudePluginJson)}\n` },
    { path: "package/.claude-plugin/marketplace.json", data: `${JSON.stringify(claudeMarketplaceJson)}\n` },
    { path: "package/.codex-plugin/plugin.json", data: `${JSON.stringify(pluginJson)}\n` },
    { path: "package/LICENSE", data: "fixture license\n" },
    { path: "package/README.md", data: "fixture readme\n" },
    { path: "package/bin/agentic-sdlc.mjs", data: "#!/usr/bin/env node\n", mode: 0o755 },
    { path: "package/config/release-artifact-policy.json", data: "{}\n" },
    { path: "package/lib/build-identity.mjs", data: "// fixture\n" },
    { path: "package/schemas/project-bootstrap-journal.schema.json", data: "{}\n" },
    { path: "package/schemas/project-bootstrap-manifest.schema.json", data: "{}\n" },
    { path: "package/schemas/release-artifact-policy.schema.json", data: "{}\n" },
    { path: "package/schemas/profile-task-start-receipt-v1.schema.json", data: "{}\n" },
    { path: "package/schemas/workflow-final-gate-receipt-v1.schema.json", data: "{}\n" },
    { path: "package/schemas/workflow-final-gate-receipt.schema.json", data: "{}\n" },
    { path: "package/schemas/workflow-strict-gate-receipt.schema.json", data: "{}\n" },
    { path: "package/scripts/install-personal-marketplace.py", data: "# fixture\n" },
    { path: "package/scripts/install-personal-marketplace-v2.py", data: "# fixture\n" },
    { path: "package/scripts/verify-release-package.mjs", data: "// fixture\n" },
    { path: "package/skills/agentic-sdlc/SKILL.md", data: "# Fixture\n" },
    ...extra,
  ];
}
