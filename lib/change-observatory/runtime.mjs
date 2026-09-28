import path from "node:path";
import { childProcess, process } from "../runtime/host.mjs";

export const OBSERVATORY_WORKER_MARKER = "AGENTIC_SDLC_OBSERVATORY_WORKER";
export const DEFAULT_WINDOWS_OBSERVATORY_THREADPOOL_SIZE = 32;

const MIN_WINDOWS_OBSERVATORY_THREADPOOL_SIZE = 4;
const MAX_WINDOWS_OBSERVATORY_THREADPOOL_SIZE = 32;
const DEFAULT_OBSERVATORY_PARENT_DISCONNECT_TIMEOUT_MS = 5_000;
const UNSAFE_NODE_OPTIONS_PATTERN = /--(?:input[-_]type|inspect(?:[-_](?:brk|port|publish[-_]uid|wait))?|watch(?:[-_](?:kill[-_]signal|path|preserve[-_]output))?)(?:[=\s"']|$)/iu;
const ENTRYPOINT_RUNTIME_FLAGS = new Set([
  "-c",
  "--check",
  "--completion-bash",
  "-e",
  "--entry-url",
  "--eval",
  "--experimental-repl-await",
  "--experimental-sea-config",
  "-h",
  "--help",
  "-i",
  "--input-type",
  "--interactive",
  "-p",
  "--print",
  "--prof-process",
  "--run",
  "-v",
  "--v8-options",
  "--version",
]);
const ENTRYPOINT_RUNTIME_FLAGS_WITH_VALUE = new Set([
  "-e",
  "--entry-url",
  "--eval",
  "--experimental-sea-config",
  "--input-type",
  "-p",
  "--print",
  "--run",
]);

export function shouldLaunchDedicatedObservatory({
  platform = process.platform,
  environment = process.env,
} = {}) {
  assertEnvironment(environment);
  return platform === "win32" && !(
    Object.hasOwn(environment, OBSERVATORY_WORKER_MARKER)
    && environment[OBSERVATORY_WORKER_MARKER] === "1"
  );
}

export function observatoryWorkerEnvironment(environment = process.env, {
  platform = process.platform,
  poolSize = null,
} = {}) {
  assertEnvironment(environment);
  assertSafeNodeOptions(environment);
  const result = Object.assign(Object.create(null), environment);
  result[OBSERVATORY_WORKER_MARKER] = "1";
  if (platform === "win32") {
    result.UV_THREADPOOL_SIZE = String(resolveWindowsThreadpoolSize(
      poolSize,
      Object.hasOwn(environment, "UV_THREADPOOL_SIZE")
        ? environment.UV_THREADPOOL_SIZE
        : undefined,
    ));
  }
  return result;
}

export function observatoryExecArgv(execArgv = process.execArgv) {
  if (!Array.isArray(execArgv) || execArgv.some((value) => typeof value !== "string")) {
    throw new TypeError("Dedicated Observatory runtime arguments must be an array of strings");
  }
  const safe = [];
  for (let index = 0; index < execArgv.length; index += 1) {
    const argument = execArgv[index];
    const [flag] = argument.split("=", 1);
    const normalizedFlag = flag.replaceAll("_", "-");
    const changesEntrypoint = ENTRYPOINT_RUNTIME_FLAGS.has(normalizedFlag)
      || normalizedFlag === "--test"
      || normalizedFlag.startsWith("--test-")
      || normalizedFlag === "--watch"
      || normalizedFlag.startsWith("--watch-")
      || normalizedFlag === "--inspect"
      || normalizedFlag.startsWith("--inspect-");
    if (!changesEntrypoint) {
      safe.push(argument);
      continue;
    }
    if (!argument.includes("=")) {
      const next = execArgv[index + 1];
      if (
        ENTRYPOINT_RUNTIME_FLAGS_WITH_VALUE.has(normalizedFlag)
        || (typeof next === "string" && !next.startsWith("-"))
      ) {
        index += 1;
      }
    }
  }
  return safe;
}

export function launchDedicatedObservatory({
  argv,
  scriptPath,
  executable = process.execPath,
  execArgv = process.execArgv,
  cwd = process.cwd(),
  environment = process.env,
  platform = process.platform,
  fork = childProcess.fork,
  processRef = process,
  parentDisconnectTimeoutMs = DEFAULT_OBSERVATORY_PARENT_DISCONNECT_TIMEOUT_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== "string")) {
    throw new TypeError("Dedicated Observatory arguments must be an array of strings");
  }
  if (typeof scriptPath !== "string" || scriptPath.trim() === "") {
    throw new TypeError("Dedicated Observatory requires its CLI entry path");
  }
  if (typeof executable !== "string" || executable.trim() === "") {
    throw new TypeError("Dedicated Observatory requires a Node.js executable");
  }
  if (typeof fork !== "function") {
    throw new TypeError("Dedicated Observatory fork must be a function");
  }
  if (!Number.isSafeInteger(parentDisconnectTimeoutMs) || parentDisconnectTimeoutMs < 1) {
    throw new TypeError("Dedicated Observatory parent disconnect timeout must be a positive safe integer");
  }
  if (typeof setTimeoutFn !== "function" || typeof clearTimeoutFn !== "function") {
    throw new TypeError("Dedicated Observatory timeout functions are invalid");
  }

  const parentIpcExpected = typeof processRef?.send === "function";
  if (
    parentIpcExpected
    && (typeof processRef.once !== "function" || typeof processRef.removeListener !== "function")
  ) {
    throw new TypeError("Dedicated Observatory parent IPC boundary is invalid");
  }
  let child = null;
  let parentDisconnected = parentIpcExpected && processRef.connected !== true;
  let forceTimer = null;
  let settled = false;
  const forceChildExit = () => {
    if (settled || !child) return;
    child.kill?.("SIGKILL");
  };
  const disconnectChild = () => {
    parentDisconnected = true;
    if (!child || settled) return;
    try {
      if (child.connected === true) child.disconnect();
    } catch {
      forceChildExit();
    }
    if (!forceTimer) {
      forceTimer = setTimeoutFn(forceChildExit, parentDisconnectTimeoutMs);
    }
  };
  if (parentIpcExpected) processRef.once("disconnect", disconnectChild);

  try {
    child = fork(
      path.resolve(scriptPath),
      argv,
      {
        execPath: path.resolve(executable),
        execArgv: observatoryExecArgv(execArgv),
        cwd: path.resolve(cwd),
        env: observatoryWorkerEnvironment(environment, { platform }),
        stdio: ["inherit", "inherit", "inherit", "ipc"],
        windowsHide: true,
      },
    );
  } catch (error) {
    if (parentIpcExpected) processRef.removeListener("disconnect", disconnectChild);
    throw error;
  }
  if (parentDisconnected || (parentIpcExpected && processRef.connected !== true)) {
    disconnectChild();
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      if (forceTimer) clearTimeoutFn(forceTimer);
      if (parentIpcExpected) processRef.removeListener("disconnect", disconnectChild);
    };
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Unable to start the dedicated Observatory process: ${error.message}`, {
        cause: error,
      }));
    });
    const settleTermination = (exitCode, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Object.freeze({
        exitCode: Number.isInteger(exitCode) ? exitCode : 1,
        signal: typeof signal === "string" ? signal : null,
      }));
    };
    child.once("exit", settleTermination);
    child.once("close", settleTermination);
  });
}

function resolveWindowsThreadpoolSize(explicit, inherited) {
  if (explicit !== null && explicit !== undefined) {
    if (
      !Number.isSafeInteger(explicit)
      || explicit < MIN_WINDOWS_OBSERVATORY_THREADPOOL_SIZE
      || explicit > MAX_WINDOWS_OBSERVATORY_THREADPOOL_SIZE
    ) {
      throw new TypeError(
        `Windows Observatory threadpool size must be between ${MIN_WINDOWS_OBSERVATORY_THREADPOOL_SIZE} and ${MAX_WINDOWS_OBSERVATORY_THREADPOOL_SIZE}`,
      );
    }
    return explicit;
  }
  if (typeof inherited === "string" && /^(?:[4-9]|[12][0-9]|3[0-2])$/u.test(inherited)) {
    return Number(inherited);
  }
  return DEFAULT_WINDOWS_OBSERVATORY_THREADPOOL_SIZE;
}

function assertEnvironment(environment) {
  if (environment === null || typeof environment !== "object" || Array.isArray(environment)) {
    throw new TypeError("Observatory process environment must be an object");
  }
}

function assertSafeNodeOptions(environment) {
  if (!Object.hasOwn(environment, "NODE_OPTIONS")) return;
  const nodeOptions = String(environment.NODE_OPTIONS ?? "");
  if (UNSAFE_NODE_OPTIONS_PATTERN.test(nodeOptions)) {
    throw new TypeError(
      "Dedicated Observatory cannot inherit NODE_OPTIONS test, watch, input-type, or inspector entrypoint flags",
    );
  }
}
