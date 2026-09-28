import test from "node:test";
import assert from "node:assert/strict";
import realFs from "node:fs";
import os from "node:os";
import path from "node:path";

import { currentHost, Date as HostDate, fs, fsPromises, process as hostProcess, setHost } from "../../lib/runtime/host.mjs";
import { PLUGIN_ROOT } from "../../lib/runtime/paths.mjs";
import { now, uniqueRecordSuffix } from "../../lib/engine/common.mjs";
import { hashFile, readProjectJson } from "../../lib/engine/storage.mjs";

const FIXED_MS = Date.UTC(2026, 0, 2, 3, 4, 5, 678);

function withHost(overrides, run) {
  const restore = setHost(overrides);
  try {
    return run();
  } finally {
    restore();
  }
}

test("by default the host forwards to the real implementations", () => {
  const packageJson = path.join(PLUGIN_ROOT, "package.json");
  assert.equal(fs.readFileSync(packageJson, "utf8"), realFs.readFileSync(packageJson, "utf8"));
  assert.equal(hostProcess.platform, process.platform);
  assert.equal(hostProcess.cwd(), process.cwd());
  assert.ok(Math.abs(HostDate.now() - Date.now()) < 1_000);
});

test("forwarded methods keep their own properties and a stable identity", () => {
  assert.equal(typeof fs.realpathSync.native, "function");
  assert.equal(typeof hostProcess.hrtime.bigint(), "bigint");
  assert.equal(fs.readFileSync, fs.readFileSync);
});

test("PLUGIN_ROOT is the directory that holds package.json", () => {
  assert.equal(JSON.parse(realFs.readFileSync(path.join(PLUGIN_ROOT, "package.json"), "utf8")).name, "agentic-sdlc");
});

test("a fixed clock makes engine timestamps deterministic", () => {
  withHost({ now: () => FIXED_MS }, () => {
    assert.equal(now(), "2026-01-02T03:04:05.678Z");
    assert.equal(new HostDate().getTime(), FIXED_MS);
    assert.equal(HostDate.now(), FIXED_MS);
  });
  assert.notEqual(now(), "2026-01-02T03:04:05.678Z");
});

test("a fixed clock and random source make record ids deterministic", () => {
  const fakeCrypto = { ...currentHost().crypto, randomBytes: (size) => Buffer.alloc(size, 0xab) };
  withHost({ now: () => FIXED_MS, crypto: fakeCrypto }, () => {
    assert.equal(uniqueRecordSuffix(), "20260102030405678-ababab");
  });
});

test("dates from either class pass instanceof against the other", () => {
  assert.ok(new Date() instanceof HostDate);
  assert.ok(new HostDate() instanceof Date);
  assert.equal(new HostDate(0).toISOString(), "1970-01-01T00:00:00.000Z");
  assert.equal(HostDate.parse("2020-01-01T00:00:00Z"), Date.parse("2020-01-01T00:00:00Z"));
});

test("engine file access goes through the host file system", () => {
  const directory = realFs.mkdtempSync(path.join(os.tmpdir(), "host-seam-"));
  try {
    const file = path.join(directory, "record.json");
    realFs.writeFileSync(file, "{\"real\":true}\n");
    const reads = [];
    const recordingFs = new Proxy(currentHost().fs, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        // A Proxy keeps the function's own properties (realpathSync.native).
        return new Proxy(value, {
          apply(original, _thisArg, args) {
            reads.push(String(property));
            return Reflect.apply(original, target, args);
          },
        });
      },
    });
    const digest = withHost({ fs: recordingFs }, () => hashFile(file));
    assert.equal(digest, withHost({}, () => hashFile(file)));
    assert.ok(reads.includes("readFileSync"), `reads: ${reads.join(", ")}`);

    const parsed = withHost({ fs: recordingFs }, () => readProjectJson({ root: directory }, file));
    assert.deepEqual(parsed, { real: true });
  } finally {
    realFs.rmSync(directory, { force: true, recursive: true });
  }
});

test("setHost restores the previous host even when overrides are nested", () => {
  const outer = setHost({ now: () => 1 });
  const inner = setHost({ now: () => 2 });
  assert.equal(HostDate.now(), 2);
  inner();
  assert.equal(HostDate.now(), 1);
  outer();
  assert.ok(HostDate.now() > 1_000_000_000_000);
});

test("a method kept aside before setHost still follows the host in effect", async () => {
  const { readFileSync } = fs;
  const { readFile } = fsPromises;
  const fakeFs = { ...realFs, readFileSync: () => "fake sync" };
  const fakePromises = { ...realFs.promises, readFile: async () => "fake async" };
  await withHost({ fs: fakeFs, fsPromises: fakePromises }, async () => {
    assert.equal(readFileSync("anything"), "fake sync");
    assert.equal(await readFile("anything"), "fake async");
  });
  const packageJson = path.join(PLUGIN_ROOT, "package.json");
  assert.equal(readFileSync(packageJson, "utf8"), realFs.readFileSync(packageJson, "utf8"));
});

// Blank comments and string/template text, keeping ${} expressions, so a word
// that only appears in prose or a literal does not count as a use.
function codeOnly(source) {
  let out = "";
  const stack = [];
  for (let i = 0; i < source.length;) {
    const c = source[i];
    if (stack.at(-1) === "`") {
      if (c === "\\") { i += 2; continue; }
      if (c === "`") { stack.pop(); i += 1; continue; }
      if (source.startsWith("${", i)) { stack.push("{"); i += 2; continue; }
      i += 1;
      continue;
    }
    if (source.startsWith("//", i)) { const end = source.indexOf("\n", i); i = end < 0 ? source.length : end; continue; }
    if (source.startsWith("/*", i)) { const end = source.indexOf("*/", i + 2); i = end < 0 ? source.length : end + 2; continue; }
    if (c === "'" || c === "\"") {
      let j = i + 1;
      while (j < source.length && source[j] !== c) j += source[j] === "\\" ? 2 : 1;
      out += " ";
      i = j + 1;
      continue;
    }
    if (c === "`") { stack.push("`"); i += 1; continue; }
    if (c === "{" && stack.length > 0) stack.push("{");
    if (c === "}" && stack.at(-1) === "{") stack.pop();
    out += c;
    i += 1;
  }
  return out;
}

function sourceModules() {
  const files = [path.join(PLUGIN_ROOT, "bin", "agentic-sdlc.mjs")];
  const visit = (dir) => {
    for (const entry of realFs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.name.endsWith(".mjs")) files.push(full);
    }
  };
  visit(path.join(PLUGIN_ROOT, "lib"));
  const host = path.join(PLUGIN_ROOT, "lib", "runtime", "host.mjs");
  return files.filter((file) => file !== host).sort();
}

test("every module reaches files, processes, the OS, randomness, and the clock through the host", () => {
  const offenders = [];
  for (const file of sourceModules()) {
    const source = realFs.readFileSync(file, "utf8");
    const relative = path.relative(PLUGIN_ROOT, file);
    const direct = source.match(/from\s+"node:(?:fs|fs\/promises|child_process|os|crypto)"/gu);
    if (direct) offenders.push(`${relative}: imports ${direct.join(", ")} directly`);
    const hostImport = source.match(/import\s*\{([^}]*)\}\s*from\s*"[^"]*runtime\/host\.mjs"/u);
    const imported = new Set((hostImport?.[1] ?? "").split(",").map((name) => name.trim().split(/\s+as\s+/u)[0]).filter(Boolean));
    const code = codeOnly(source);
    for (const name of ["Date", "console", "process"]) {
      if (new RegExp(`(?<![.\\w$])${name}(?![\\w$])`, "u").test(code) && !imported.has(name)) {
        offenders.push(`${relative}: uses the global ${name} instead of the host`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
