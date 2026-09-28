import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { acquireFileLock, reclaimStaleInternalLock } from "../../lib/engine/storage.mjs";
import { runWithMutationGovernance } from "../../lib/governance/mutation-guard.mjs";
import { currentHost, setHost } from "../../lib/runtime/host.mjs";

const WORKER = fileURLToPath(new URL("../helpers/internal-lock-race-worker.mjs", import.meta.url));

function lockFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "internal-lock-reclaim-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, lockPath: path.join(root, "resource.lock") };
}

function deadPid() {
  return spawnSync(process.execPath, ["-e", ""]).pid;
}

function writeDeadLock(lockPath, pid) {
  fs.writeFileSync(lockPath, JSON.stringify({
    pid,
    host: os.hostname(),
    nonce: "dead",
    created_at: new Date().toISOString(),
  }));
}

function governed(root, callback) {
  return runWithMutationGovernance({ mode: "disabled", root }, callback);
}

test("a lock left by a dead process is reclaimed without leaving a claim behind", (t) => {
  const { root, lockPath } = lockFixture(t);
  writeDeadLock(lockPath, deadPid());

  governed(root, () => acquireFileLock(lockPath)());

  assert.deepEqual(fs.readdirSync(root), []);
});

test("a claim left by a waiter that died while reclaiming does not block the lock", (t) => {
  const { root, lockPath } = lockFixture(t);
  const pid = deadPid();
  writeDeadLock(lockPath, pid);
  writeDeadLock(`${lockPath}.reclaim.lock`, pid);

  governed(root, () => acquireFileLock(lockPath)());

  assert.deepEqual(fs.readdirSync(root), []);
});

test("a waiter acting on an old verdict leaves the live lock that replaced the dead one", (t) => {
  const { root, lockPath } = lockFixture(t);
  const pid = deadPid();
  writeDeadLock(lockPath, pid);
  const live = JSON.stringify({ pid: process.pid, host: os.hostname(), nonce: "live" });
  const realProcess = currentHost().process;
  let replaced = false;
  // Right after this waiter judges the lock dead, another waiter moves the
  // dead lock aside and a live owner installs its own at the same path.
  const restore = setHost({
    process: new Proxy(realProcess, {
      get(target, key) {
        if (key !== "kill") return Reflect.get(target, key, target);
        return (target_pid, signal) => {
          if (target_pid === pid && !replaced) {
            replaced = true;
            fs.renameSync(lockPath, `${lockPath}.moved`);
            fs.rmSync(`${lockPath}.moved`);
            fs.writeFileSync(lockPath, live, { flag: "wx" });
          }
          return target.kill(target_pid, signal);
        };
      },
    }),
  });
  try {
    governed(root, () => reclaimStaleInternalLock(lockPath));
  } finally {
    restore();
  }

  assert.equal(replaced, true);
  assert.equal(fs.readFileSync(lockPath, "utf8"), live);
  assert.deepEqual(fs.readdirSync(root), ["resource.lock"]);
});

async function runLockRace(root, lockPath, workers) {
  const logPath = path.join(root, "critical-section.log");
  const startAt = Date.now() + 500;
  const exits = await Promise.all(Array.from({ length: workers }, () => new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [WORKER, root, lockPath, logPath, String(startAt), "100"],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stderr }));
  })));
  for (const exit of exits) assert.equal(exit.code, 0, exit.stderr);
  let holders = 0;
  let maxHolders = 0;
  let entries = 0;
  for (const line of fs.readFileSync(logPath, "utf8").trim().split("\n")) {
    if (line.startsWith("enter ")) {
      holders += 1;
      entries += 1;
    } else {
      holders -= 1;
    }
    maxHolders = Math.max(maxHolders, holders);
  }
  return { entries, maxHolders };
}

test("concurrent waiters on a dead lock never hold it at the same time", async (t) => {
  const workers = 6;
  for (let trial = 0; trial < 3; trial += 1) {
    const { root, lockPath } = lockFixture(t);
    writeDeadLock(lockPath, deadPid());
    const { entries, maxHolders } = await runLockRace(root, lockPath, workers);
    assert.equal(entries, workers);
    assert.equal(maxHolders, 1, `trial ${trial + 1}: ${maxHolders} processes held the lock at once`);
  }
});
