import "../helpers/test-isolation.mjs";

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { createFixtureDir } from "../helpers/test-isolation.mjs";
import {
  activateVerifyCache,
  cachedFileHash,
  cachedTraceVerification,
  deactivateVerifyCache,
  verifyCacheStats,
} from "../../lib/engine/verify-cache.mjs";

const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function repository() {
  const dir = createFixtureDir("sdlc-verify-cache-");
  spawnSync("git", ["init", "--quiet", dir]);
  return dir;
}

function aged(file) {
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(file, past, past);
}

test("a record hash is reused while unchanged and verified again when the record changes", () => {
  const dir = repository();
  const record = path.join(dir, "record.json");
  fs.writeFileSync(record, "{\"a\":1}\n");
  aged(record);
  const cacheFile = activateVerifyCache(dir, { env: {}, version: "1.0.0" });
  assert.match(cacheFile, /\.git[\\/]agentic-sdlc[\\/]verify-cache\.json$/u);
  let computed = 0;
  const hash = () => cachedFileHash(record, () => { computed += 1; return sha(record); });
  assert.equal(hash(), sha(record));
  assert.equal(hash(), sha(record));
  assert.equal(computed, 1, "second read is a cache hit");
  fs.writeFileSync(record, "{\"a\":2}\n");
  aged(record);
  assert.equal(hash(), sha(record), "a changed record is hashed again");
  assert.equal(computed, 2);
  deactivateVerifyCache();

  // Persisted: a new process (simulated by re-activating) reuses it.
  activateVerifyCache(dir, { env: {}, version: "1.0.0" });
  hash();
  assert.equal(computed, 2);
  assert.ok(verifyCacheStats().hits >= 1);
  deactivateVerifyCache();

  // A plugin version change invalidates everything.
  activateVerifyCache(dir, { env: {}, version: "1.0.1" });
  hash();
  assert.equal(computed, 3);
  deactivateVerifyCache();
});

test("a file written moments ago is never trusted from the cache", () => {
  const dir = repository();
  const record = path.join(dir, "fresh.json");
  fs.writeFileSync(record, "fresh\n");
  activateVerifyCache(dir, { env: {}, version: "1.0.0" });
  let computed = 0;
  cachedFileHash(record, () => { computed += 1; return sha(record); });
  cachedFileHash(record, () => { computed += 1; return sha(record); });
  assert.equal(computed, 2);
  deactivateVerifyCache();
});

test("only valid trace verifications are kept, and the cache can be turned off", () => {
  const dir = repository();
  activateVerifyCache(dir, { env: {}, version: "1.0.0" });
  let computed = 0;
  const invalid = () => cachedTraceVerification(["t", "bad"], () => { computed += 1; return { valid: false }; });
  invalid();
  invalid();
  assert.equal(computed, 2);
  const valid = () => cachedTraceVerification(["t", "good"], () => { computed += 1; return { valid: true, errors: [] }; });
  valid();
  valid();
  assert.equal(computed, 3);
  deactivateVerifyCache();
  assert.equal(activateVerifyCache(dir, { env: { AGENTIC_SDLC_VERIFY_CACHE: "off" } }), null);
});
