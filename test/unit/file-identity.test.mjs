import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  IDENTITY_STAT_OPTIONS,
  hasStableFileIdentity,
  sameStableFileIdentity,
  sameStatTime,
} from "../../lib/file-identity.mjs";

const wide = 2n ** 60n;

test("distinguishes 64-bit inodes that collide as Number", () => {
  assert.equal(Number(wide + 1n), Number(wide + 2n));
  assert.equal(sameStableFileIdentity({ dev: 7n, ino: wide + 1n }, { dev: 7n, ino: wide + 2n }), false);
  assert.equal(sameStableFileIdentity({ dev: 7n, ino: wide + 1n }, { dev: 7n, ino: wide + 1n }), true);
});

test("compares Number and bigint identities of small inodes alike", () => {
  assert.equal(sameStableFileIdentity({ dev: 7, ino: 42 }, { dev: 7n, ino: 42n }), true);
  assert.equal(sameStableFileIdentity({ dev: 7, ino: 42 }, { dev: 8n, ino: 42n }), false);
  const file = fileURLToPath(import.meta.url);
  assert.equal(sameStableFileIdentity(fs.lstatSync(file), fs.lstatSync(file, IDENTITY_STAT_OPTIONS)), true);
});

test("reports missing or zero inodes as unstable", () => {
  assert.equal(hasStableFileIdentity({ dev: 1n, ino: 0n }), false);
  assert.equal(hasStableFileIdentity({ dev: 1, ino: 0 }), false);
  assert.equal(hasStableFileIdentity({ dev: 1n }), false);
  assert.equal(hasStableFileIdentity(undefined), false);
  assert.equal(sameStableFileIdentity({ dev: 1n, ino: 0n }, { dev: 1n, ino: 0n }), false);
});

test("compares timestamps at the precision both stats provide", () => {
  assert.equal(sameStatTime({ mtimeNs: 1_000_000_001n }, { mtimeNs: 1_000_000_002n }, "mtime"), false);
  assert.equal(sameStatTime({ mtimeMs: 1000.5 }, { mtimeMs: 1000.5 }, "mtime"), true);
  assert.equal(sameStatTime({ mtimeMs: 1000n, mtimeNs: 1_000_500_000n }, { mtimeMs: 1000.5 }, "mtime"), true);
  assert.equal(sameStatTime({ mtimeMs: 1001n, mtimeNs: 1_001_000_000n }, { mtimeMs: 1000.5 }, "mtime"), false);
});
