import "../helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import { fork as nodeFork, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_WINDOWS_OBSERVATORY_THREADPOOL_SIZE,
  OBSERVATORY_WORKER_MARKER,
  launchDedicatedObservatory,
  observatoryExecArgv,
  observatoryWorkerEnvironment,
  shouldLaunchDedicatedObservatory,
} from "../../lib/change-observatory/runtime.mjs";

test("Windows Observatory workers receive one bounded pre-launch filesystem pool", () => {
  const inherited = Object.assign(Object.create({ INHERITED_SECRET: "must-not-leak" }), {
    PATH: "/bin",
    UV_THREADPOOL_SIZE: "invalid",
  });
  const environment = observatoryWorkerEnvironment(inherited, { platform: "win32" });

  assert.notStrictEqual(environment, inherited);
  assert.equal(inherited.PATH, "/bin");
  assert.equal(inherited.UV_THREADPOOL_SIZE, "invalid");
  assert.equal(environment.UV_THREADPOOL_SIZE, String(DEFAULT_WINDOWS_OBSERVATORY_THREADPOOL_SIZE));
  assert.equal(environment[OBSERVATORY_WORKER_MARKER], "1");
  assert.equal(Object.hasOwn(environment, "INHERITED_SECRET"), false);
  assert.equal(Object.getPrototypeOf(environment), null);
  assert.equal(Object.isExtensible(environment), true);

  assert.equal(
    observatoryWorkerEnvironment({ UV_THREADPOOL_SIZE: "24" }, { platform: "win32" })
      .UV_THREADPOOL_SIZE,
    "24",
  );
  assert.equal(
    observatoryWorkerEnvironment({}, { platform: "win32", poolSize: 32 }).UV_THREADPOOL_SIZE,
    "32",
  );
  assert.throws(
    () => observatoryWorkerEnvironment({}, { platform: "win32", poolSize: 33 }),
    /between 4 and 32/u,
  );
  assert.equal(
    observatoryWorkerEnvironment({ NODE_OPTIONS: "--disable-proto=throw --no-warnings" }, {
      platform: "win32",
    }).NODE_OPTIONS,
    "--disable-proto=throw --no-warnings",
  );
  for (const nodeOptions of [
    "--inspect-brk=0",
    "--inspect_port=9330",
    "--inspect_wait",
    "--watch_path=lib",
    "--input_type module",
  ]) {
    assert.throws(
      () => observatoryWorkerEnvironment({ NODE_OPTIONS: nodeOptions }, { platform: "win32" }),
      /cannot inherit NODE_OPTIONS/u,
    );
  }

  const inheritedPool = Object.create({ UV_THREADPOOL_SIZE: "32" });
  assert.equal(
    observatoryWorkerEnvironment(inheritedPool, { platform: "win32" }).UV_THREADPOOL_SIZE,
    String(DEFAULT_WINDOWS_OBSERVATORY_THREADPOOL_SIZE),
  );
});

test("dedicated runtime arguments preserve hardening but remove recursive entrypoints", () => {
  assert.deepEqual(observatoryExecArgv([
    "--disable-proto=throw",
    "--permission",
    "--allow-fs-read=*",
    "--input-type", "module",
    "-e", "spawnAgain()",
    "--print=spawnAgain()",
    "--test",
    "--test-name-pattern", "worker",
    "--watch-path=lib",
    "--watch_path=lib",
    "--inspect=9229",
    "--inspect_port=9330",
    "--inspect_wait",
    "--test_name_pattern=worker",
    "--check",
    "--no-warnings",
  ]), [
    "--disable-proto=throw",
    "--permission",
    "--allow-fs-read=*",
    "--no-warnings",
  ]);
});

test("dedicated launch is Windows-only and cannot recurse", () => {
  assert.equal(shouldLaunchDedicatedObservatory({ platform: "darwin", environment: {} }), false);
  assert.equal(shouldLaunchDedicatedObservatory({ platform: "win32", environment: {} }), true);
  assert.equal(shouldLaunchDedicatedObservatory({
    platform: "win32",
    environment: { [OBSERVATORY_WORKER_MARKER]: "1" },
  }), false);
  assert.equal(shouldLaunchDedicatedObservatory({
    platform: "win32",
    environment: Object.create({ [OBSERVATORY_WORKER_MARKER]: "1" }),
  }), true);
});

test("dedicated launch uses argv without a shell and keeps an IPC parent boundary", async () => {
  const calls = [];
  const child = new EventEmitter();
  const launched = launchDedicatedObservatory({
    argv: [
      "observe",
      "--root", "portfolio with spaces",
      "--portfolio-manifest", "config/project list.json",
      "--json",
    ],
    scriptPath: "bin/agentic-sdlc.mjs",
    executable: process.execPath,
    execArgv: ["--disable-proto=throw", "--no-warnings"],
    cwd: ".",
    environment: { SENTINEL: "kept" },
    platform: "win32",
    fork(modulePath, args, options) {
      calls.push({ modulePath, args, options });
      return child;
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].modulePath, path.resolve("bin/agentic-sdlc.mjs"));
  assert.deepEqual(calls[0].args, [
    "observe",
    "--root",
    "portfolio with spaces",
    "--portfolio-manifest",
    "config/project list.json",
    "--json",
  ]);
  assert.equal(calls[0].options.execPath, path.resolve(process.execPath));
  assert.deepEqual(calls[0].options.execArgv, ["--disable-proto=throw", "--no-warnings"]);
  assert.equal(Object.hasOwn(calls[0].options, "shell"), false);
  assert.deepEqual(calls[0].options.stdio, ["inherit", "inherit", "inherit", "ipc"]);
  assert.equal(calls[0].options.env.SENTINEL, "kept");
  assert.equal(
    calls[0].options.env.UV_THREADPOOL_SIZE,
    String(DEFAULT_WINDOWS_OBSERVATORY_THREADPOOL_SIZE),
  );
  assert.equal(calls[0].options.env[OBSERVATORY_WORKER_MARKER], "1");

  child.emit("close", 0, null);
  assert.deepEqual(await launched, { exitCode: 0, signal: null });
});

test("dedicated launch rejects malformed inherited runtime arguments", () => {
  assert.throws(
    () => launchDedicatedObservatory({
      argv: ["observe"],
      scriptPath: "bin/agentic-sdlc.mjs",
      execArgv: ["--no-warnings", 1],
    }),
    /runtime arguments must be an array of strings/u,
  );
});

test("dedicated launch settles on process exit without waiting for inherited output handles", async () => {
  const child = new EventEmitter();
  const launched = launchDedicatedObservatory({
    argv: ["observe", "--no-open"],
    scriptPath: "bin/agentic-sdlc.mjs",
    fork() {
      return child;
    },
  });

  child.emit("exit", 0, null);
  assert.deepEqual(await launched, { exitCode: 0, signal: null });
});

test("an upstream supervisor disconnect is bridged to the dedicated worker", async () => {
  const parent = new EventEmitter();
  parent.connected = true;
  parent.send = () => {};
  const child = new EventEmitter();
  child.connected = true;
  let disconnectCalls = 0;
  child.disconnect = () => {
    disconnectCalls += 1;
    child.connected = false;
  };
  child.kill = () => {
    throw new Error("graceful worker shutdown should not require a forced kill");
  };

  const launched = launchDedicatedObservatory({
    argv: ["observe", "--no-open"],
    scriptPath: "bin/agentic-sdlc.mjs",
    processRef: parent,
    fork() {
      return child;
    },
  });
  parent.connected = false;
  parent.emit("disconnect");
  assert.equal(disconnectCalls, 1);
  child.emit("close", 0, null);

  assert.deepEqual(await launched, { exitCode: 0, signal: null });
  assert.equal(parent.listenerCount("disconnect"), 0);
});

test("an already-disconnected supervisor is bridged without losing the startup race", async () => {
  const parent = new EventEmitter();
  parent.connected = false;
  parent.send = () => {};
  const child = new EventEmitter();
  child.connected = true;
  let disconnectCalls = 0;
  child.disconnect = () => {
    disconnectCalls += 1;
    child.connected = false;
  };

  const launched = launchDedicatedObservatory({
    argv: ["observe", "--no-open"],
    scriptPath: "bin/agentic-sdlc.mjs",
    processRef: parent,
    fork() {
      return child;
    },
  });
  assert.equal(disconnectCalls, 1);
  child.emit("close", 0, null);

  assert.deepEqual(await launched, { exitCode: 0, signal: null });
  assert.equal(parent.listenerCount("disconnect"), 0);
});

test("the supervisor deadline terminates a worker that cannot process graceful shutdown", async (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "observatory-blocked-worker-"));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  const fixturePath = path.join(fixtureRoot, "blocked-worker.mjs");
  fs.writeFileSync(fixturePath, [
    "if (typeof process.send !== 'function') process.exit(2);",
    "process.send({ event: 'blocked-worker.ready' }, () => {",
    "  while (true) {}",
    "});",
    "",
  ].join("\n"));

  const parent = new EventEmitter();
  parent.connected = true;
  parent.send = () => {};
  let child = null;
  let resolveWorkerReady;
  const workerReady = new Promise((resolve) => {
    resolveWorkerReady = resolve;
  });
  const launched = launchDedicatedObservatory({
    argv: [],
    scriptPath: fixturePath,
    processRef: parent,
    parentDisconnectTimeoutMs: 100,
    fork(modulePath, args, options) {
      child = nodeFork(modulePath, args, options);
      child.once("message", resolveWorkerReady);
      return child;
    },
  });
  t.after(() => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });

  assert.deepEqual(
    await completesWithin(workerReady, 3_000, "blocked Observatory worker startup"),
    { event: "blocked-worker.ready" },
  );
  parent.connected = false;
  parent.emit("disconnect");

  const termination = await completesWithin(
    launched,
    3_000,
    "blocked Observatory worker termination",
  );
  assert.equal(termination.exitCode, 1);
  assert.equal(parent.listenerCount("disconnect"), 0);
});

test("a real two-hop supervisor disconnect closes the wrapper and Observatory worker", async (t) => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "observatory-two-hop-"));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(projectRoot, ".sdlc"));
  fs.writeFileSync(path.join(projectRoot, ".sdlc", "project.json"), `${JSON.stringify({
    schema_version: "0.1.0",
    project_id: "two-hop-fixture",
    project_name: "Two Hop Fixture",
  })}\n`);

  const wrapper = nodeFork(path.resolve("test/fixtures/change-observatory-wrapper.mjs"), [
    "observe",
    "--root", projectRoot,
    "--no-open",
    "--json",
  ], {
    cwd: path.resolve("."),
    env: { ...process.env, NODE_OPTIONS: "" },
    execArgv: [],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  t.after(() => {
    if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill("SIGTERM");
  });
  let stdout = "";
  let stderr = "";
  wrapper.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  wrapper.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve, reject) => {
    let settled = false;
    const settle = (code, signal) => {
      if (settled) return;
      settled = true;
      resolve({ code, signal });
    };
    wrapper.once("error", reject);
    wrapper.once("exit", settle);
    wrapper.once("close", settle);
  });

  await waitForOutput(() => stdout.includes('"event":"observatory.ready"'), 10_000);
  wrapper.disconnect();
  let termination;
  try {
    termination = await completesWithin(exited, 8_000, "two-hop Observatory shutdown");
  } catch (error) {
    throw new Error([
      error.message,
      `wrapper connected: ${wrapper.connected}`,
      `wrapper exit: ${wrapper.exitCode ?? "none"}`,
      `wrapper signal: ${wrapper.signalCode ?? "none"}`,
      `stdout: ${stdout}`,
      `stderr: ${stderr}`,
    ].join("\n"), { cause: error });
  }

  assert.deepEqual(termination, { code: 0, signal: null }, stderr);
  assert.match(stdout, /"event":"observatory\.stopped"/u);
  assert.match(stdout, /"signal":"parent-disconnect"/u);
});

test("permission-mode eval parents launch one non-recursive compatible worker", {
  skip: !process.allowedNodeEnvironmentFlags.has("--permission"),
}, () => {
  const runtimeUrl = pathToFileURL(path.resolve("lib/change-observatory/runtime.mjs")).href;
  const cliPath = path.resolve("bin/agentic-sdlc.mjs");
  const source = [
    `import { launchDedicatedObservatory } from ${JSON.stringify(runtimeUrl)};`,
    `const result = await launchDedicatedObservatory({ argv: ["--version"], scriptPath: ${JSON.stringify(cliPath)}, platform: "win32" });`,
    "console.log(JSON.stringify(result));",
  ].join("\n");
  const launched = spawnSync(process.execPath, [
    "--permission",
    "--allow-child-process",
    "--allow-fs-read=*",
    "--input-type=module",
    "-e",
    source,
  ], {
    cwd: path.resolve("."),
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });

  assert.equal(launched.error, undefined);
  assert.equal(launched.signal, null);
  assert.equal(launched.status, 0, launched.stderr);
  assert.match(launched.stdout, /\b\d+\.\d+\.\d+\b/u);
  assert.match(launched.stdout, /"exitCode":0/u);
});

async function waitForOutput(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for child output`);
}

function completesWithin(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs} ms`)), timeoutMs);
    }),
  ]);
}
