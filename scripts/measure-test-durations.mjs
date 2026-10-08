#!/usr/bin/env node

// Regenerates test/shard-weights.json, the table that scripts/run-test-suite.mjs
// uses to balance CI shards by expected cost instead of by file size.
//
//   node scripts/measure-test-durations.mjs [--concurrency <n>] [--out <file>]
//
// Every discovered test file is executed on its own and the processor time it
// used (user plus system, including every process it spawned) is recorded in
// milliseconds. Processor time, unlike elapsed time, does not grow when the
// machine is busy, so the table can be refreshed on a shared developer machine;
// where bash is not available the elapsed time is recorded instead. Only the
// ratios between files matter. Refresh the table when a test file is added,
// removed, or changes cost substantially. Nothing is written when a file fails,
// because a failing file stops early and would be under-weighted.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SHARD_WEIGHTS_FILE,
  SHARD_WEIGHTS_SCHEMA,
  discoverTestFiles,
  medianWeight,
  projectRelativePath,
} from "./run-test-suite.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CONCURRENCY = 2;
// A file that fails is run again, so a timing-sensitive test that trips on a busy machine does not abort a refresh.
const ATTEMPTS = 3;
// The test runner marks the files it starts; helpers that serve a port when run by hand stay quiet under it.
const CHILD_ENV = Object.freeze({ ...process.env, NODE_TEST_CONTEXT: "child-v8" });
// bash's `time` reports the processor time of everything the command waited for.
const TIMED_RUN = 'TIMEFORMAT="%U %S"; { time "$0" "$1" >/dev/null 2>&1; } 2>&1';


function parseArgs(argv) {
  const options = { concurrency: DEFAULT_CONCURRENCY, out: SHARD_WEIGHTS_FILE };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--concurrency" && /^[1-9][0-9]?$/u.test(value ?? "")) {
      options.concurrency = Number(value);
    } else if (key === "--out" && typeof value === "string" && value !== "") {
      options.out = path.resolve(value);
    } else {
      throw new Error(`unexpected argument ${JSON.stringify(key)}`);
    }
  }
  return options;
}


function hasBash() {
  return spawnSync("bash", ["-c", "true"], { stdio: "ignore", windowsHide: true }).status === 0;
}


function timeFile(file, cpuTime) {
  return new Promise((resolve) => {
    const startedAt = process.hrtime.bigint();
    const child = cpuTime
      ? spawn("bash", ["-c", TIMED_RUN, process.execPath, file], { cwd: PROJECT_ROOT, env: CHILD_ENV, stdio: ["ignore", "pipe", "ignore"], windowsHide: true })
      : spawn(process.execPath, [file], { cwd: PROJECT_ROOT, env: CHILD_ENV, stdio: "ignore", windowsHide: true });
    let report = "";
    child.stdout?.on("data", (chunk) => { report += chunk; });
    child.on("error", () => resolve({ file, ms: 0, ok: false }));
    child.on("close", (code) => {
      const elapsed = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
      const [user, system] = report.trim().split(/\s+/u).map(Number);
      const measured = cpuTime ? Math.round((user + system) * 1000) : elapsed;
      resolve({ file, ms: Number.isFinite(measured) ? measured : 0, ok: code === 0 && Number.isFinite(measured) });
    });
  });
}


async function measureAll(files, concurrency, cpuTime) {
  const results = [];
  let next = 0;
  async function worker() {
    while (next < files.length) {
      const file = files[next];
      next += 1;
      let result = await timeFile(file, cpuTime);
      for (let attempt = 1; !result.ok && attempt < ATTEMPTS; attempt += 1) {
        result = await timeFile(file, cpuTime);
      }
      results.push(result);
      process.stderr.write(`${String(result.ms).padStart(8)} ms  ${result.ok ? "ok  " : "FAIL"}  ${projectRelativePath(file)}\n`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
  return results;
}


async function main(argv) {
  const { concurrency, out } = parseArgs(argv);
  const cpuTime = hasBash();
  process.stderr.write(`Measuring ${cpuTime ? "processor time" : "elapsed time (bash is not available)"}, ${concurrency} at a time.\n`);
  const files = discoverTestFiles();
  const results = await measureAll(files, concurrency, cpuTime);
  const failed = results.filter((result) => !result.ok).map((result) => projectRelativePath(result.file));
  if (failed.length > 0) {
    throw new Error(`not writing weights because these files failed when run alone: ${failed.join(", ")}`);
  }
  const weights = Object.fromEntries(
    results
      .map((result) => [projectRelativePath(result.file), Math.max(1, result.ms)])
      .sort(([left], [right]) => (left < right ? -1 : 1)),
  );
  const table = {
    schema: SHARD_WEIGHTS_SCHEMA,
    unit: "milliseconds of processor time per test file (user + system, children included), measured alone; only ratios matter",
    defaultWeight: medianWeight(Object.values(weights)),
    files: weights,
  };
  fs.writeFileSync(out, `${JSON.stringify(table, null, 2)}\n`, "utf8");
  process.stdout.write(`Wrote ${Object.keys(weights).length} test weights to ${out}\n`);
}


main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`Measuring test durations failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
