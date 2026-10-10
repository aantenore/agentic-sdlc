import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  canonicalJson,
  computeStableHash,
  immutableJson,
} from "../../lib/canonical.mjs";

test("canonical JSON and hashes are independent of object insertion order", () => {
  const left = { z: 1, nested: { beta: true, alpha: "x" }, a: [3, 2, 1] };
  const right = { a: [3, 2, 1], nested: { alpha: "x", beta: true }, z: 1 };

  assert.equal(canonicalJson(left), canonicalJson(right));
  assert.equal(computeStableHash(left), computeStableHash(right));
  assert.notEqual(computeStableHash(left), computeStableHash({ ...right, a: [1, 2, 3] }));
});

test("canonical object ordering is locale-independent code-unit ordering", () => {
  assert.equal(canonicalJson({ ä: 3, a: 2, Z: 1 }), '{"Z":1,"a":2,"ä":3}');
});

test("canonical JSON rejects ambiguous or unsupported values", () => {
  assert.throws(() => canonicalJson([undefined]), /undefined array item/);
  assert.throws(() => canonicalJson({ value: Number.POSITIVE_INFINITY }), /non-finite number/);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalJson(cyclic), /cycles/);
});

test("immutableJson clones and recursively freezes the result", () => {
  const source = { nested: { value: 1 }, list: [{ id: "a" }] };
  const result = immutableJson(source);
  source.nested.value = 2;

  assert.equal(result.nested.value, 1);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.nested), true);
  assert.equal(Object.isFrozen(result.list[0]), true);
  assert.throws(() => {
    result.nested.value = 3;
  }, TypeError);
});

test("memoizes canonical form and hash only for deeply frozen values", async () => {
  const { computeStableHash, canonicalJson, deepFreeze, isDeepFrozen } = await import("../../lib/canonical.mjs");
  const mutable = { a: { b: 1 } };
  const first = computeStableHash(mutable);
  mutable.a.b = 2;
  assert.notEqual(computeStableHash(mutable), first);
  assert.equal(isDeepFrozen(mutable), false);
  const frozen = deepFreeze({ a: { b: 1 } });
  assert.equal(isDeepFrozen(frozen), true);
  assert.equal(computeStableHash(frozen), first);
  assert.equal(computeStableHash(frozen), first);
  assert.equal(canonicalJson(frozen), canonicalJson({ a: { b: 1 } }));
});

test("readProjectJsonFrozen parses once per file version and invalidates on rewrite", async (t) => {
  const { readProjectJsonFrozen, clearFrozenJsonMemo } = await import("../../lib/engine/storage.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "frozen-json-memo-"));
  t.after(() => { clearFrozenJsonMemo(); fs.rmSync(root, { recursive: true, force: true }); });
  const file = path.join(root, "r.json");
  fs.writeFileSync(file, JSON.stringify({ n: 1 }));
  const context = { root };
  const one = readProjectJsonFrozen(context, file);
  assert.equal(readProjectJsonFrozen(context, file), one);
  assert.equal(Object.isFrozen(one), true);
  fs.writeFileSync(file, JSON.stringify({ n: 22 }));
  assert.equal(readProjectJsonFrozen(context, file).n, 22);
});
