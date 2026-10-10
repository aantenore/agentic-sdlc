// Detached worker of lib/runtime/auto-update.mjs: runs the two plugin commands within one time limit,
// logs each step, then syncs the folders sessions use. Started with the job as a JSON argument.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { syncRememberedRoots } from "./auto-update.mjs";

const job = JSON.parse(process.argv[2] || "{}");
const deadline = Date.now() + job.timeoutMs;

function log(message) {
  try {
    fs.mkdirSync(path.dirname(job.log), { recursive: true });
    fs.appendFileSync(job.log, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // logging is best effort
  }
}

function run(args) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return { ok: false, detail: "time limit reached" };
  const result = spawnSync(job.claudeBin, args, { encoding: "utf8", timeout: remaining, windowsHide: true, shell: process.platform === "win32" });
  const detail = result.error ? result.error.message : `exit ${result.status}${result.signal ? ` signal ${result.signal}` : ""}`;
  return { ok: result.status === 0, detail: `${detail} ${String(result.stderr || result.stdout || "").trim().split("\n").slice(-2).join(" | ")}`.trim() };
}

log(`start (${job.reason}) marketplace=${job.marketplace} plugin=${job.plugin}`);
const steps = [["plugin", "marketplace", "update", job.marketplace], ["plugin", "update", `${job.plugin}@${job.marketplace}`]];
for (const args of steps) {
  const outcome = run(args);
  log(`claude ${args.join(" ")}: ${outcome.ok ? "ok" : "failed"} (${outcome.detail})`);
  if (!outcome.ok) break;
}
for (const item of syncRememberedRoots()) log(`sync ${item.root}: ${item.synced ? `${item.files} files to ${item.version}` : item.reason}`);
log("done");
