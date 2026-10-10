import path from "node:path";

import { console, Date, process } from "../runtime/host.mjs";
import { UserError } from "./user-error.mjs";
import {
  ageMinutes,
  findGitCommonDir,
  isAlive,
  readRuns,
  reapStaleRuns,
} from "../runtime/run-registry.mjs";

function commonDirFor(options) {
  const root = path.resolve(String(options.root || process.cwd()));
  const commonDir = findGitCommonDir(root);
  if (!commonDir) throw new UserError(`No Git repository at ${root}; runs are recorded per repository.`);
  return commonDir;
}

function positiveNumber(value, flag) {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new UserError(`${flag} needs a non-negative number.`);
  return number;
}

/** Registered plugin runs of this repository, with their age. */
export function runsList(options) {
  const now = Date.now();
  const runs = readRuns(commonDirFor(options))
    .filter((entry) => entry.record)
    .map(({ record }) => ({
      ...record,
      age_minutes: Math.round(ageMinutes(record, now) * 10) / 10,
      alive: isAlive(Number(record.pid)),
    }))
    .filter((run) => run.pid !== process.pid);
  if (options.json === true) console.log(JSON.stringify({ runs }, null, 2));
  else if (runs.length === 0) console.log("No agentic-sdlc runs are registered.");
  else {
    for (const run of runs) {
      const limit = Number(run.max_minutes) > 0 ? `limit ${run.max_minutes}m` : "no limit";
      console.log(`${run.pid}  ${run.age_minutes}m  ${limit}  ${run.alive ? "running" : "gone"}  ${run.command}  ${run.host}`);
    }
  }
  return { runs };
}

/** Stop registered runs: the stale ones by default, or by age or pid. */
export function runsStop(options) {
  const olderThanMinutes = positiveNumber(options["older-than"], "--older-than");
  const pid = positiveNumber(options.pid, "--pid");
  const results = reapStaleRuns(commonDirFor(options), { olderThanMinutes, pid, force: true });
  if (options.json === true) console.log(JSON.stringify({ results }, null, 2));
  else if (results.length === 0) console.log("Nothing to stop.");
  else for (const result of results) console.log(`${result.pid ?? "?"}: ${result.outcome}${result.command ? ` (${result.command})` : ""}`);
  return { results };
}
