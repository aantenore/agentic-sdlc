import path from "node:path";
import { fileURLToPath } from "node:url";

import { console, process } from "../runtime/host.mjs";
import { parseOlderThanSeconds, readProjectConfig, reapProcesses } from "../runtime/process-reaper.mjs";
import { parseDeadlineSeconds, RUN_TIMEOUT_ENV, runWithDeadline } from "../runtime/timed-run.mjs";
import { failUsage } from "./user-error.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** `run --timeout <duration> [--log <file>] -- <command...>`: the command's exit code, or 124 at the deadline. */
export async function runCommand(options, command) {
  if (!Array.isArray(command) || command.length === 0) failUsage("run needs the command after --, for example: run --timeout 10m -- npm test.");
  const given = options.timeout ?? process.env[RUN_TIMEOUT_ENV];
  if (given === undefined || given === "") failUsage(`run needs a deadline: --timeout <duration> (90s, 10m, 2h) or ${RUN_TIMEOUT_ENV}.`);
  const timeoutSeconds = parseDeadlineSeconds(given);
  if (timeoutSeconds === null) failUsage("--timeout must be a duration such as 90s, 10m or 2h, greater than zero.");
  process.exitCode = await runWithDeadline({
    argv: command,
    timeoutSeconds,
    logFile: options.log ? path.resolve(String(options.root || process.cwd()), String(options.log)) : null,
  });
}

/** `processes reap [--older-than <duration>] [--dry-run] [--json]`. */
export async function processesReap(options) {
  let olderThanSeconds;
  if (options["older-than"] !== undefined) {
    olderThanSeconds = parseOlderThanSeconds(options["older-than"]);
    if (olderThanSeconds === null || olderThanSeconds <= 0) failUsage("--older-than must be a duration such as 10, 90s, 10m or 2h, greater than zero.");
  }
  const { root, config } = readProjectConfig(options.root || process.cwd());
  const result = await reapProcesses({ root, config, olderThanSeconds, dryRun: options["dry-run"] === true, pluginRoot: PLUGIN_ROOT });
  if (options.json === true) console.log(JSON.stringify(result, null, 2));
  else {
    for (const pattern of result.invalid_patterns) console.error(`Ignored invalid pattern: ${pattern}`);
    if (result.processes.length === 0) console.log(`No process over ${result.older_than_minutes} min.`);
    for (const item of result.processes) console.log(`${item.outcome} pid ${item.pid} (${item.age_minutes} min): ${item.command.slice(0, 120)}`);
  }
  return result;
}
