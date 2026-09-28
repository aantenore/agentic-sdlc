// Child process for the internal-lock race test. Waits for a shared start
// time, acquires the lock, and appends enter/exit markers around a short
// critical section so the parent can count overlapping holders.
import fs from "node:fs";

import { acquireFileLock } from "../../lib/engine/storage.mjs";
import { runWithMutationGovernance } from "../../lib/governance/mutation-guard.mjs";

const [root, lockPath, logPath, startAtText, holdMsText] = process.argv.slice(2);
const startAt = Number(startAtText);
const holdMs = Number(holdMsText);

while (Date.now() < startAt) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
}

runWithMutationGovernance({ mode: "disabled", root }, () => {
  const release = acquireFileLock(lockPath);
  try {
    fs.appendFileSync(logPath, `enter ${process.pid}\n`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMs);
    fs.appendFileSync(logPath, `exit ${process.pid}\n`);
  } finally {
    release();
  }
});
