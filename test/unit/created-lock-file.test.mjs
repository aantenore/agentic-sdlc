import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createdLockStillOwned,
  initializeCreatedLock,
  removeCreatedLockIfOwned,
} from "../../lib/created-lock-file.mjs";

function lockFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "created-lock-file-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockPath = path.join(root, "resource.lock");
  return { lockPath, displacedPath: `${lockPath}.displaced` };
}

function simulatedWriteFailure() {
  const failure = new Error("simulated metadata write failure after lock replacement");
  failure.code = "EIO";
  return failure;
}

test("does not delete a replacement installed after creating its lock", (t) => {
  const { lockPath, displacedPath } = lockFixture(t);
  const replacement = JSON.stringify({ pid: process.pid, nonce: "replacement" });
  const failure = simulatedWriteFailure();
  let replaced = false;
  const descriptor = fs.openSync(lockPath, "wx");

  // A concurrent stale-lock reclaim moves the empty lock aside and installs
  // its own before this process manages to write metadata.
  const writeFileSync = () => {
    replaced = true;
    fs.renameSync(lockPath, displacedPath);
    fs.writeFileSync(lockPath, replacement, { flag: "wx" });
    throw failure;
  };

  assert.throws(
    () => initializeCreatedLock(
      { lockPath, descriptor, content: "{}" },
      { ...fs, writeFileSync },
    ),
    (error) => error === failure,
  );
  assert.equal(replaced, true);
  assert.equal(fs.readFileSync(lockPath, "utf8"), replacement);
  assert.equal(fs.existsSync(displacedPath), true);
});

test("removes its own lock when metadata initialization fails", (t) => {
  const { lockPath } = lockFixture(t);
  const failure = simulatedWriteFailure();
  const descriptor = fs.openSync(lockPath, "wx");

  assert.throws(
    () => initializeCreatedLock(
      { lockPath, descriptor, content: "{}" },
      { ...fs, writeFileSync: () => { throw failure; } },
    ),
    (error) => error === failure,
  );
  assert.equal(fs.existsSync(lockPath), false);
});

test("keeps the lock and rethrows the original error when ownership cannot be established", (t) => {
  const { lockPath } = lockFixture(t);
  const failure = simulatedWriteFailure();
  const descriptor = fs.openSync(lockPath, "wx");
  const fstatSync = (fd, options) => ({ ...fs.fstatSync(fd, options), ino: 0n });

  assert.throws(
    () => initializeCreatedLock(
      { lockPath, descriptor, content: "{}" },
      { ...fs, fstatSync, writeFileSync: () => { throw failure; } },
    ),
    (error) => error === failure,
  );
  assert.equal(fs.existsSync(lockPath), true);
});

test("rethrows the original error when cleanup itself is not authorized", (t) => {
  const { lockPath } = lockFixture(t);
  const failure = simulatedWriteFailure();
  const descriptor = fs.openSync(lockPath, "wx");
  let calls = 0;
  const authorize = () => {
    calls += 1;
    if (calls > 1) throw new Error("cleanup not authorized");
  };

  assert.throws(
    () => initializeCreatedLock(
      { lockPath, descriptor, content: "{}", authorize },
      { ...fs, writeFileSync: () => { throw failure; } },
    ),
    (error) => error === failure,
  );
  assert.equal(calls, 2);
  assert.equal(fs.existsSync(lockPath), true);
});

test("writes metadata and closes the descriptor on success", (t) => {
  const { lockPath } = lockFixture(t);
  const descriptor = fs.openSync(lockPath, "wx");
  initializeCreatedLock({ lockPath, descriptor, content: "{\"nonce\":\"own\"}" });
  assert.equal(fs.readFileSync(lockPath, "utf8"), "{\"nonce\":\"own\"}");
  assert.throws(() => fs.fstatSync(descriptor), { code: "EBADF" });
});

test("ownership check rejects symlinks, missing identities and missing paths", (t) => {
  const { lockPath } = lockFixture(t);
  fs.writeFileSync(lockPath, "");
  const current = fs.lstatSync(lockPath, { bigint: true });
  const identity = { dev: current.dev, ino: current.ino };
  assert.equal(createdLockStillOwned(identity, current), true);
  assert.equal(createdLockStillOwned(undefined, current), false);
  assert.equal(createdLockStillOwned({ dev: current.dev, ino: current.ino + 1n }, current), false);
  assert.equal(createdLockStillOwned(identity, { ...current, isFile: () => true, isSymbolicLink: () => true }), false);
  fs.rmSync(lockPath);
  assert.equal(removeCreatedLockIfOwned(lockPath, identity), false);
});
