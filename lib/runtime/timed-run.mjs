/**
 * `agentic-sdlc run --timeout <duration> [--log <file>] -- <command...>`
 *
 * Runs one command with a deadline. When the deadline passes the whole
 * process tree is stopped (POSIX: the command's own process group, SIGTERM
 * then SIGKILL; Windows: `taskkill /T /F`) and the exit code is 124, the one
 * of coreutils `timeout`. Standard input and output pass through and the
 * command's own exit code is returned. No shell and no extra dependency.
 */
import path from "node:path";

import { childProcess, fs, process } from "./host.mjs";
import { parseLimitSeconds } from "./bounded-child-process.mjs";

export const TIMEOUT_EXIT_CODE = 124;
export const COMMAND_NOT_FOUND_EXIT_CODE = 127;
export const RUN_TIMEOUT_ENV = "AGENTIC_SDLC_RUN_DEADLINE";
export const KILL_GRACE_MS = 5_000;
const POLL_MS = 100;
const SIGNAL_NUMBERS = Object.freeze({ SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGABRT: 6, SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15 });

/** Seconds of a `--timeout` value (90s, 10m, 2h, 1d); a deadline is required, so 0 and unreadable values are refused with null. */
export function parseDeadlineSeconds(value) {
  const seconds = parseLimitSeconds(value);
  return seconds !== null && seconds > 0 ? seconds : null;
}

/** Quotes one argument for cmd.exe (Windows only). */
export function quoteWindowsArgument(value) {
  const text = String(value);
  if (text !== "" && !/[\s"&|<>^()%!,;=]/u.test(text)) return text;
  return `"${text.replace(/(\\*)"/gu, "$1$1\\\"").replace(/(\\+)$/u, "$1$1")}"`;
}

/**
 * How to start the command. On Windows everything that is not a plain .exe
 * (npm, npx and other .cmd shims) goes through cmd.exe with verbatim
 * arguments, because Node cannot start a .cmd file directly.
 */
export function launchSpec(argv, platform = process.platform) {
  const [command, ...args] = argv;
  if (platform !== "win32" || /\.(?:exe|com)$/iu.test(command)) return { file: command, args, options: {} };
  const line = [command, ...args].map(quoteWindowsArgument).join(" ");
  return { file: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], options: { windowsVerbatimArguments: true } };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True while some process of the group still runs. */
function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** The signal-style exit code a shell reports for a command ended by a signal. */
export function exitCodeFor(code, signal) {
  if (typeof code === "number") return code;
  return 128 + (SIGNAL_NUMBERS[signal] ?? 1);
}

/**
 * Stops the process tree of `pid`. POSIX: SIGTERM to the group, then SIGKILL
 * once `graceMs` passed (or at once when the group is already gone, the
 * SIGKILL then only sweeps stragglers). Windows: taskkill /T /F.
 */
export async function killTree(pid, { platform = process.platform, graceMs = KILL_GRACE_MS, signal = (target, name) => process.kill(target, name), run = (...args) => childProcess.spawnSync(...args), pause = sleep } = {}) {
  if (platform === "win32") {
    try {
      run("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 15_000 });
    } catch {
      // already gone
    }
    return;
  }
  try {
    signal(-pid, "SIGTERM");
  } catch {
    // already gone
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && groupAlive(pid)) await pause(POLL_MS);
  try {
    signal(-pid, "SIGKILL");
  } catch {
    // nothing left
  }
}

/**
 * Runs `argv` with a deadline and resolves with the exit code to use.
 * `stderr` receives messages; `logFile` also receives a copy of the output.
 */
export async function runWithDeadline({
  argv,
  timeoutSeconds,
  logFile = null,
  cwd = process.cwd(),
  env = process.env,
  platform = process.platform,
  graceMs = KILL_GRACE_MS,
  stdout = (chunk) => process.stdout.write(chunk),
  stderr = (text) => process.stderr.write(text),
  spawn = (...args) => childProcess.spawn(...args),
  onSignalTarget = process,
} = {}) {
  if (!Array.isArray(argv) || argv.length === 0) throw new TypeError("run needs a command after --");
  const spec = launchSpec(argv, platform);
  let log = null;
  if (logFile) {
    fs.mkdirSync(path.dirname(path.resolve(logFile)), { recursive: true });
    log = fs.openSync(path.resolve(logFile), "a");
  }
  const posix = platform !== "win32";
  let child;
  try {
    child = spawn(spec.file, spec.args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      // Its own process group, so one signal reaches the whole tree.
      detached: posix,
      stdio: log === null ? "inherit" : ["inherit", "pipe", "pipe"],
      ...spec.options,
    });
  } catch (error) {
    if (log !== null) fs.closeSync(log);
    stderr(`agentic-sdlc run: cannot start ${argv[0]}: ${error.message}\n`);
    return COMMAND_NOT_FOUND_EXIT_CODE;
  }
  if (log !== null) {
    child.stdout?.on("data", (chunk) => {
      stdout(chunk);
      fs.writeSync(log, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr(chunk);
      fs.writeSync(log, chunk);
    });
  }
  let timedOut = false;
  let stopping = null;
  const stop = () => {
    stopping ??= killTree(child.pid, { platform, graceMs });
    return stopping;
  };
  const forward = (name) => () => {
    stop();
    // The command was asked to end by whoever started us: report it as a signal exit.
    forwarded ??= name;
  };
  let forwarded = null;
  const handlers = ["SIGINT", "SIGTERM", "SIGHUP"].map((name) => [name, forward(name)]);
  for (const [name, handler] of handlers) onSignalTarget.on?.(name, handler);

  const timer = setTimeout(() => {
    timedOut = true;
    stderr(`agentic-sdlc run: deadline of ${formatDuration(timeoutSeconds)} reached; stopping the command and every process it started (pid ${child.pid}).\n`);
    stop();
  }, timeoutSeconds * 1000);

  const outcome = await new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  for (const [name, handler] of handlers) onSignalTarget.off?.(name, handler);
  if (stopping) await stopping;
  if (log !== null) fs.closeSync(log);
  if (outcome.error) {
    stderr(`agentic-sdlc run: cannot start ${argv[0]}: ${outcome.error.message}\n`);
    return COMMAND_NOT_FOUND_EXIT_CODE;
  }
  if (timedOut) return TIMEOUT_EXIT_CODE;
  if (forwarded && typeof outcome.code !== "number") return 128 + (SIGNAL_NUMBERS[forwarded] ?? 1);
  return exitCodeFor(outcome.code, outcome.signal);
}

export function formatDuration(seconds) {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}
