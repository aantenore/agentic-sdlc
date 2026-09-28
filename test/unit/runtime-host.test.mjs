import test from "node:test";
import assert from "node:assert/strict";
import realFs from "node:fs";
import os from "node:os";
import path from "node:path";

import { currentHost, Date as HostDate, fs, process as hostProcess, setHost } from "../../lib/runtime/host.mjs";
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
