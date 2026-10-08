import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  bundledObservatoryAssetRoot,
  openBrowserBestEffort,
  parseObserveOptions,
  readConfiguredProjectLocale,
  registerShutdownHandlers,
  resolveObserveOptions,
  runObserveCommand,
  writeObserveEvent,
} from "../../lib/change-observatory/cli.mjs";
import { requireSymlinkSupport } from "../helpers/symlink-support.mjs";

const TECHNICAL_ONLY = /\b(?:bounded-autonomous|checkpoint(?:ed|_required)|audit_only|host_verified|profile|receipt|ceiling|schema|hash|reason[ _-]?code|AUT-[A-Z0-9-]+)\b/iu;

test("normalizes loopback launch options and validates ports", () => {
  assert.deepEqual(
    parseObserveOptions({ projectRoot: ".", host: "127.0.0.1", port: "0", openBrowser: false }),
    {
      projectRoot: path.resolve("."),
      host: "127.0.0.1",
      port: 0,
      openBrowser: false,
      json: false,
      locale: "en",
    },
  );
  assert.throws(() => parseObserveOptions({ host: "0.0.0.0" }), /only to 127\.0\.0\.1/);
  for (const port of ["", "1.5", "abc", -1, 65_536]) {
    assert.throws(() => parseObserveOptions({ port }), /integer between 0 and 65535/);
  }
  assert.equal(parseObserveOptions({ locale: "it-IT" }).locale, "it");
  assert.throws(() => parseObserveOptions({ locale: "fr" }), /must be en or it/);
  assert.equal(
    parseObserveOptions({ portfolioManifest: "config/portfolio.json" }).portfolioManifest,
    "config/portfolio.json",
  );
  for (const portfolioManifest of ["", " portfolio.json", "portfolio.json ", 42]) {
    assert.throws(
      () => parseObserveOptions({ portfolioManifest }),
      /needs --portfolio-manifest with one explicit relative JSON path/u,
    );
  }
});

test("run command enables portfolio mode only for an explicit manifest", async () => {
  let receivedOptions;
  const output = createMemoryStream();
  const running = await runObserveCommand({
    projectRoot: ".",
    portfolioManifest: "config/portfolio.json",
    openBrowser: false,
    json: true,
  }, {
    registerSignals: false,
    stdout: output,
    async serverFactory(options) {
      receivedOptions = options;
      return {
        ...(await successfulServer()),
        modelUrl: "http://127.0.0.1:43127/api/v1/portfolio",
      };
    },
  });

  assert.equal(receivedOptions.portfolioManifest, "config/portfolio.json");
  const event = JSON.parse(output.value.trim());
  assert.equal(event.mode, "portfolio");
  assert.equal(event.portfolio_manifest, "config/portfolio.json");
  assert.equal(event.model_url, "http://127.0.0.1:43127/api/v1/portfolio");
  await running.close();
});

test("resolves the bundled UI relative to the installed launcher module", async () => {
  const assetRoot = bundledObservatoryAssetRoot();
  assert.equal(path.isAbsolute(assetRoot), true);
  assert.equal((await fs.stat(path.join(assetRoot, "index.html"))).isFile(), true);
  assert.equal((await fs.stat(path.join(assetRoot, "app.js"))).isFile(), true);
});

test("run command suppresses the opener with --no-open and emits one ready event", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "observatory-cli-"));
  const output = createMemoryStream();
  let opened = false;
  let receivedOptions = null;
  let closeCount = 0;
  const running = await runObserveCommand({
    projectRoot: root,
    openBrowser: false,
    json: true,
  }, {
    registerSignals: false,
    stdout: output,
    opener() {
      opened = true;
    },
    async serverFactory(options) {
      receivedOptions = options;
      return {
        url: "http://127.0.0.1:43127/",
        accessUrl: `http://127.0.0.1:43127/#access_token=${"a".repeat(43)}`,
        healthUrl: "http://127.0.0.1:43127/api/v1/health",
        modelUrl: "http://127.0.0.1:43127/api/v1/observatory",
        address: { host: "127.0.0.1", port: 43127 },
        async close() {
          closeCount += 1;
        },
      };
    },
  });

  assert.equal(opened, false);
  assert.equal(receivedOptions.assetRoot, bundledObservatoryAssetRoot());
  assert.equal(Object.hasOwn(receivedOptions, "portfolioManifest"), false);
  assert.equal(receivedOptions.locale, "en");
  const event = JSON.parse(output.value.trim());
  assert.equal(event.event, "observatory.ready");
  assert.equal(event.browser_open_requested, false);
  assert.equal(event.authentication, "per-run-bearer-fragment");
  assert.equal(event.locale, "en");
  await running.close();
  await running.close();
  assert.equal(closeCount, 1);
  await fs.rm(root, { recursive: true, force: true });
});

test("run command waits for warm readiness and publishes operational URLs with correlation", async () => {
  const output = createMemoryStream();
  let releaseWarmReadiness;
  const warmGate = new Promise((resolve) => {
    releaseWarmReadiness = resolve;
  });
  let warmCalls = 0;
  let closeCalls = 0;
  const correlationId = "corr-123e4567-e89b-12d3-a456-426614174099";

  const launch = runObserveCommand({
    projectRoot: ".",
    openBrowser: false,
    json: true,
  }, {
    registerSignals: false,
    stdout: output,
    async serverFactory() {
      return {
        url: "http://127.0.0.1:43127/",
        accessUrl: "http://127.0.0.1:43127/#access_token=secret",
        healthUrl: "http://127.0.0.1:43127/api/v1/health",
        liveUrl: "http://127.0.0.1:43127/api/v1/live",
        readyUrl: "http://127.0.0.1:43127/api/v1/ready",
        modelUrl: "http://127.0.0.1:43127/api/v1/observatory",
        metricsUrl: "http://127.0.0.1:43127/api/v1/metrics",
        sloUrl: "http://127.0.0.1:43127/api/v1/slo",
        supportBundleUrl: "http://127.0.0.1:43127/api/v1/support-bundle",
        address: { host: "127.0.0.1", port: 43127 },
        async warmReadiness() {
          warmCalls += 1;
          await warmGate;
          return { status: "ready", correlationId };
        },
        async close() {
          closeCalls += 1;
        },
      };
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(warmCalls, 1);
  assert.equal(output.value, "");
  releaseWarmReadiness();
  const running = await launch;

  const event = JSON.parse(output.value.trim());
  assert.equal(event.event, "observatory.ready");
  assert.equal(event.readiness, "ready");
  assert.equal(event.correlation_id, correlationId);
  assert.equal(event.live_url, "http://127.0.0.1:43127/api/v1/live");
  assert.equal(event.ready_url, "http://127.0.0.1:43127/api/v1/ready");
  assert.equal(event.metrics_url, "http://127.0.0.1:43127/api/v1/metrics");
  assert.equal(event.slo_url, "http://127.0.0.1:43127/api/v1/slo");
  assert.equal(event.support_bundle_url, "http://127.0.0.1:43127/api/v1/support-bundle");
  await running.close();
  assert.equal(closeCalls, 1);
});

test("run command closes the server and emits no ready event when warm readiness fails", async () => {
  const output = createMemoryStream();
  let closeCalls = 0;
  await assert.rejects(
    () => runObserveCommand({ projectRoot: ".", openBrowser: false, json: true }, {
      registerSignals: false,
      stdout: output,
      async serverFactory() {
        return {
          ...(await successfulServer()),
          async warmReadiness() {
            return {
              status: "not_ready",
              correlationId: "corr-123e4567-e89b-12d3-a456-426614174099",
            };
          },
          async close() {
            closeCalls += 1;
          },
        };
      },
    }),
    (error) => error?.code === "observatory_not_ready" && error?.retryable === true,
  );
  assert.equal(closeCalls, 1);
  assert.equal(output.value, "");
});

test("human launch events explain outcome and protections before optional technical details", () => {
  for (const locale of ["en", "it"]) {
    const output = createMemoryStream();
    writeObserveEvent(output, {
      event: "observatory.ready",
      locale,
      url: "http://127.0.0.1:43127/?locale=it#access_token=secret",
      project_root: "/tmp/project",
    });
    const divider = locale === "it"
      ? "Dettagli tecnici (facoltativi):"
      : "Technical details (optional):";
    const [human, technical] = output.value.split(divider);
    for (const label of locale === "it"
      ? ["Risultato:", "Cosa cambia in pratica:", "Cosa devi decidere:", "Cosa resta protetto:", "Prossimo passo:"]
      : ["Outcome:", "What this changes in practice:", "What you need to decide:", "What remains protected:", "Next step:"]) {
      assert.match(human, new RegExp(label));
    }
    assert.doesNotMatch(human, TECHNICAL_ONLY);
    assert.match(technical, /127\.0\.0\.1/u);
  }
});

test("async browser and shutdown failures keep platform and errors after the technical divider", () => {
  for (const locale of ["en", "it"]) {
    for (const event of [
      {
        event: "observatory.browser_open_failed",
        locale,
        url: "http://127.0.0.1:43127/#access_token=secret",
        platform: "test-platform",
        error: "spawn EACCES",
      },
      {
        event: "observatory.shutdown_failed",
        locale,
        platform: "test-platform",
        error: "close EBUSY",
      },
    ]) {
      const output = createMemoryStream();
      writeObserveEvent(output, event);
      const divider = locale === "it"
        ? "Dettagli tecnici (facoltativi):"
        : "Technical details (optional):";
      const [human, technical] = output.value.split(divider);
      const labels = locale === "it"
        ? ["Risultato:", "Cosa cambia in pratica:", "Cosa devi decidere:", "Cosa resta protetto:", "Prossimo passo:"]
        : ["Outcome:", "What this changes in practice:", "What you need to decide:", "What remains protected:", "Next step:"];
      for (const label of labels) assert.match(human, new RegExp(label));
      assert.doesNotMatch(human, /test-platform|EACCES|EBUSY/u);
      assert.match(technical, /test-platform/u);
      assert.match(technical, event.event.endsWith("browser_open_failed") ? /EACCES/u : /EBUSY/u);
    }
  }
});

test("run command routes asynchronous opener and shutdown errors through human guidance", async () => {
  const browserStdout = createMemoryStream();
  const browserStderr = createMemoryStream();
  const browserRun = await runObserveCommand({ projectRoot: ".", locale: "en" }, {
    registerSignals: false,
    stdout: browserStdout,
    stderr: browserStderr,
    processRef: { platform: "test-platform" },
    opener(_url, { onError }) {
      onError(new Error("spawn EACCES"));
    },
    serverFactory: successfulServer,
  });
  assert.match(browserStderr.value, /^Outcome:/u);
  const [browserHuman, browserTechnical] = browserStderr.value.split("Technical details (optional):");
  assert.doesNotMatch(browserHuman, /test-platform|EACCES/u);
  assert.match(browserTechnical, /test-platform[\s\S]*EACCES/u);
  await browserRun.close();

  const shutdownStdout = createMemoryStream();
  const shutdownStderr = createMemoryStream();
  const processRef = new EventEmitter();
  processRef.exitCode = null;
  processRef.platform = "test-platform";
  await runObserveCommand({ projectRoot: ".", openBrowser: false, locale: "it" }, {
    stdout: shutdownStdout,
    stderr: shutdownStderr,
    processRef,
    async serverFactory() {
      return {
        ...(await successfulServer()),
        async close() {
          throw new Error("close EBUSY");
        },
      };
    },
  });
  processRef.emit("SIGTERM");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(processRef.exitCode, 1);
  const [shutdownHuman, shutdownTechnical] = shutdownStderr.value.split("Dettagli tecnici (facoltativi):");
  assert.doesNotMatch(shutdownHuman, /test-platform|EBUSY/u);
  assert.match(shutdownTechnical, /test-platform[\s\S]*EBUSY/u);
});

test("browser-open failure repeats the full access address in the primary next step", async () => {
  const stderr = createMemoryStream();
  const running = await runObserveCommand({ projectRoot: ".", locale: "en" }, {
    registerSignals: false,
    stdout: createMemoryStream(),
    stderr,
    processRef: { platform: "test-platform" },
    opener(_url, { onError }) {
      const error = new Error("spawn xdg-open ENOENT");
      error.code = "ENOENT";
      onError(error);
    },
    serverFactory: successfulServer,
  });
  const [human, technical] = stderr.value.split("Technical details (optional):");
  assert.match(human, /Next step:[\s\S]*http:\/\/127\.0\.0\.1:43127\/#access_token=secret/u);
  assert.doesNotMatch(human, /ENOENT|xdg-open/u);
  assert.match(technical, /could not open a browser automatically/iu);
  assert.doesNotMatch(technical, /xdg-open/u);
  await running.close();
});

test("ready and shutdown guidance keeps the address in the next step and localizes labels", () => {
  const ready = createMemoryStream();
  writeObserveEvent(ready, {
    event: "observatory.ready",
    locale: "en",
    url: "http://127.0.0.1:43127/?mode=portfolio#access_token=secret",
    project_root: "/tmp/project",
  });
  const [readyHuman] = ready.value.split("Technical details (optional):");
  assert.match(readyHuman, /Next step:[\s\S]*#access_token=secret/u);
  assert.match(readyHuman, /keep this terminal open/iu);

  const stopped = createMemoryStream();
  writeObserveEvent(stopped, { event: "observatory.stopped", locale: "it", signal: "SIGTERM" });
  assert.match(stopped.value, /- Segnale: SIGTERM/u);
  assert.doesNotMatch(stopped.value, /Signal:/u);
});

test("a closed output pipe stops the viewer cleanly instead of crashing", async () => {
  const stdout = new EventEmitter();
  stdout.write = () => true;
  let closeCalls = 0;
  const running = await runObserveCommand({ projectRoot: ".", openBrowser: false, json: true }, {
    registerSignals: false,
    stdout,
    stderr: createMemoryStream(),
    async serverFactory() {
      return {
        ...(await successfulServer()),
        async close() {
          closeCalls += 1;
        },
      };
    },
  });
  const pipeError = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
  assert.doesNotThrow(() => stdout.emit("error", pipeError));
  await waitFor(() => closeCalls === 1);
  assert.doesNotThrow(() => stdout.emit("error", pipeError), "later pipe errors stay handled");
  await running.close();
  assert.equal(closeCalls, 1);
  assert.throws(
    () => stdout.emit("error", Object.assign(new Error("disk"), { code: "EIO" })),
    /disk/u,
    "unrelated stream failures are not swallowed",
  );
});

test("a busy port is explained with the next step instead of an internal error", async () => {
  await assert.rejects(
    runObserveCommand({ projectRoot: ".", port: 43127, openBrowser: false }, {
      registerSignals: false,
      stdout: createMemoryStream(),
      async serverFactory() {
        throw Object.assign(new Error("listen EADDRINUSE: address already in use 127.0.0.1:43127"), {
          code: "EADDRINUSE",
        });
      },
    }),
    (error) => {
      assert.match(error.message, /Port 43127 on 127\.0\.0\.1 is already in use/u);
      assert.match(error.message, /--port 0/u);
      assert.doesNotMatch(error.message, /EADDRINUSE/u);
      return true;
    },
  );
});

test("machine-mode browser-open failures do not repeat the access address on stderr", async () => {
  for (const json of [true, false]) {
    const stdout = createMemoryStream();
    const stderr = createMemoryStream();
    const running = await runObserveCommand({ projectRoot: ".", locale: "en", json }, {
      registerSignals: false,
      stdout,
      stderr,
      processRef: { platform: "test-platform" },
      opener(_url, { onError }) {
        onError(new Error("spawn EACCES"));
      },
      serverFactory: successfulServer,
    });
    assert.match(stdout.value, /access_token=secret/u, "the ready event always carries the address");
    if (json) {
      const event = JSON.parse(stderr.value.trim());
      assert.equal(event.event, "observatory.browser_open_failed");
      assert.equal(Object.hasOwn(event, "url"), false);
      assert.doesNotMatch(stderr.value, /access_token|127\.0\.0\.1/u);
    } else {
      assert.match(stderr.value, /access_token=secret/u, "human mode keeps the address for copying");
    }
    await running.close();
  }
});

test("browser opener passes URL as an argument with shell disabled", () => {
  const calls = [];
  const child = new EventEmitter();
  child.unref = () => {
    child.unrefCalled = true;
  };
  openBrowserBestEffort("http://127.0.0.1:43127/#access_token=token", {
    platform: "darwin",
    spawn(executable, args, options) {
      calls.push({ executable, args, options });
      return child;
    },
  });

  assert.deepEqual(calls[0].args, ["http://127.0.0.1:43127/#access_token=token"]);
  assert.equal(calls[0].executable, "open");
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.stdio, "ignore");
  assert.equal(child.unrefCalled, true);
});

test("signal handlers close once and leave process exit to the event loop", async () => {
  const processRef = new EventEmitter();
  processRef.exitCode = null;
  const seen = [];
  const handlers = registerShutdownHandlers({
    processRef,
    async shutdown(signal) {
      seen.push(signal);
    },
  });

  processRef.emit("SIGTERM");
  processRef.emit("SIGINT");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, ["SIGTERM"]);
  assert.equal(processRef.exitCode, 0);
  assert.equal(processRef.listenerCount("SIGTERM"), 0);
  assert.equal(processRef.listenerCount("SIGINT"), 0);
  handlers.dispose();
});

test("an Observatory worker closes when its parent IPC boundary disappears", async () => {
  const processRef = new EventEmitter();
  processRef.connected = true;
  processRef.exitCode = null;
  const seen = [];
  registerShutdownHandlers({
    processRef,
    async shutdown(signal) {
      seen.push(signal);
    },
  });

  processRef.emit("disconnect");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, ["parent-disconnect"]);
  assert.equal(processRef.exitCode, 0);
  assert.equal(processRef.listenerCount("disconnect"), 0);
  assert.equal(processRef.listenerCount("SIGTERM"), 0);
  assert.equal(processRef.listenerCount("SIGINT"), 0);
});

test("disposing shutdown handlers cancels a queued disconnected-parent callback", async () => {
  const processRef = new EventEmitter();
  processRef.connected = false;
  processRef.exitCode = null;
  const seen = [];
  const handlers = registerShutdownHandlers({
    processRef,
    parentIpcExpected: true,
    async shutdown(signal) {
      seen.push(signal);
    },
  });

  handlers.dispose();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, []);
  assert.equal(processRef.exitCode, null);
});

test("a parent disconnect during warm readiness closes the worker before it is announced", async () => {
  const processRef = new EventEmitter();
  processRef.connected = true;
  processRef.exitCode = null;
  const output = createMemoryStream();
  let releaseWarmReadiness;
  const warmGate = new Promise((resolve) => {
    releaseWarmReadiness = resolve;
  });
  let warmCalls = 0;
  let closeCalls = 0;

  const launch = runObserveCommand({ projectRoot: ".", openBrowser: false, json: true }, {
    processRef,
    stdout: output,
    async serverFactory() {
      return {
        ...(await successfulServer()),
        async warmReadiness() {
          warmCalls += 1;
          await warmGate;
          return { status: "ready" };
        },
        async close() {
          closeCalls += 1;
        },
      };
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(warmCalls, 1);
  processRef.connected = false;
  processRef.emit("disconnect");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closeCalls, 1);
  assert.equal(processRef.exitCode, null);
  assert.equal(output.value, "");

  releaseWarmReadiness();
  const stopped = await launch;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped.readyEvent, null);
  assert.equal(closeCalls, 1);
  assert.equal(processRef.exitCode, 0);
  assert.equal(output.value, "");
});

test("a signal-aware server factory treats parent disconnect as a clean stop", async () => {
  const processRef = new EventEmitter();
  processRef.connected = true;
  processRef.exitCode = null;
  const output = createMemoryStream();
  let factoryCalls = 0;

  const launch = runObserveCommand({ projectRoot: ".", openBrowser: false, json: true }, {
    processRef,
    stdout: output,
    serverFactory({ signal }) {
      factoryCalls += 1;
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  });

  await waitFor(() => factoryCalls === 1);
  processRef.connected = false;
  processRef.emit("disconnect");

  const stopped = await assertCompletesWithin(launch, 1_000, "signal-aware factory stop");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped.readyEvent, null);
  assert.equal(processRef.exitCode, 0);
  assert.equal(output.value, "");
});

test("a disconnected parent forces a worker whose startup ignores cancellation to stop", async (t) => {
  for (const blockedPhase of ["server factory", "warm readiness"]) {
    await t.test(blockedPhase, async () => {
      const processRef = new EventEmitter();
      processRef.connected = true;
      processRef.exitCode = null;
      const output = createMemoryStream();
      let releaseBlockedPhase;
      const blocked = new Promise((resolve) => {
        releaseBlockedPhase = resolve;
      });
      let serverFactoryCalls = 0;
      let warmCalls = 0;
      let closeCalls = 0;
      let resolveForcedExit;
      const forcedExit = new Promise((resolve) => {
        resolveForcedExit = resolve;
      });

      const launch = runObserveCommand({ projectRoot: ".", openBrowser: false, json: true }, {
        processRef,
        stdout: output,
        parentDisconnectTimeoutMs: 25,
        forceExit(code) {
          resolveForcedExit(code);
        },
        async serverFactory() {
          serverFactoryCalls += 1;
          if (blockedPhase === "server factory") await blocked;
          return {
            ...(await successfulServer()),
            async warmReadiness() {
              warmCalls += 1;
              if (blockedPhase === "warm readiness") await blocked;
              return { status: "ready" };
            },
            async close() {
              closeCalls += 1;
            },
          };
        },
      });

      await waitFor(() => serverFactoryCalls === 1 && (
        blockedPhase === "server factory" || warmCalls === 1
      ));
      processRef.connected = false;
      processRef.emit("disconnect");

      assert.equal(
        await assertCompletesWithin(forcedExit, 1_000, `${blockedPhase} forced exit`),
        1,
      );
      assert.equal(processRef.exitCode, 1);
      assert.equal(output.value, "");

      releaseBlockedPhase();
      const stopped = await assertCompletesWithin(launch, 1_000, `${blockedPhase} cleanup`);
      assert.equal(stopped.readyEvent, null);
      assert.equal(closeCalls, 1);
      assert.equal(output.value, "");
    });
  }
});

test("an already-disconnected expected parent closes the worker during startup", async () => {
  const processRef = new EventEmitter();
  processRef.connected = false;
  processRef.exitCode = null;
  let closeCalls = 0;
  const stopped = await runObserveCommand({ projectRoot: ".", openBrowser: false, json: true }, {
    processRef,
    parentIpcExpected: true,
    stdout: createMemoryStream(),
    async serverFactory() {
      await new Promise((resolve) => setImmediate(resolve));
      return {
        ...(await successfulServer()),
        async close() {
          closeCalls += 1;
        },
      };
    },
  });

  assert.equal(stopped.readyEvent, null);
  assert.equal(closeCalls, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(processRef.exitCode, 0);
});

function createMemoryStream() {
  return {
    value: "",
    write(chunk) {
      this.value += String(chunk);
      return true;
    },
  };
}

function assertCompletesWithin(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs} ms`)), timeoutMs);
    }),
  ]);
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("Observatory startup phase was not reached");
}

async function successfulServer() {
  return {
    url: "http://127.0.0.1:43127/",
    accessUrl: "http://127.0.0.1:43127/#access_token=secret",
    healthUrl: "http://127.0.0.1:43127/api/v1/health",
    modelUrl: "http://127.0.0.1:43127/api/v1/observatory",
    address: { host: "127.0.0.1", port: 43127 },
    async close() {},
  };
}

const CLI_PATH = fileURLToPath(new URL("../../bin/agentic-sdlc.mjs", import.meta.url));

async function projectWithRecord(t, record) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "observatory-locale-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, ".sdlc"));
  if (record !== undefined) {
    await fs.writeFile(
      path.join(root, ".sdlc", "project.json"),
      typeof record === "string" ? record : JSON.stringify(record),
    );
  }
  return root;
}

test("observe defaults the locale to the one recorded for the project", async (t) => {
  const italian = await projectWithRecord(t, { project_id: "trial", locale: "it" });
  assert.equal(await readConfiguredProjectLocale(italian), "it");
  assert.equal((await resolveObserveOptions({ projectRoot: italian })).locale, "it");
  assert.equal(
    (await resolveObserveOptions({ projectRoot: italian, locale: "en" })).locale,
    "en",
    "an explicit --locale always wins",
  );

  for (const record of [undefined, { project_id: "legacy" }, { locale: "fr" }, { locale: 7 }, "{not json"]) {
    const root = await projectWithRecord(t, record);
    assert.equal(await readConfiguredProjectLocale(root), null, JSON.stringify(record));
    assert.equal((await resolveObserveOptions({ projectRoot: root })).locale, "en");
  }
  assert.equal(await readConfiguredProjectLocale(path.join(italian, "missing")), null);

  const output = createMemoryStream();
  let receivedOptions = null;
  const running = await runObserveCommand({ projectRoot: italian, openBrowser: false, json: true }, {
    registerSignals: false,
    stdout: output,
    async serverFactory(options) {
      receivedOptions = options;
      return {
        url: "http://127.0.0.1:43127/",
        accessUrl: `http://127.0.0.1:43127/?locale=${options.locale}#access_token=${"a".repeat(43)}`,
        healthUrl: "http://127.0.0.1:43127/api/v1/health",
        modelUrl: "http://127.0.0.1:43127/api/v1/observatory",
        address: { host: "127.0.0.1", port: 43127 },
        async close() {},
      };
    },
  });
  assert.equal(receivedOptions.locale, "it");
  const event = JSON.parse(output.value.trim().split("\n")[0]);
  assert.equal(event.locale, "it");
  assert.match(event.url, /[?&]locale=it(?:&|#)/u);
  await running.close();
});

test("observe ignores a symlinked project record when choosing the locale", async (t) => {
  if (!requireSymlinkSupport(t, "file")) return;
  const italian = await projectWithRecord(t, { project_id: "trial", locale: "it" });
  const linked = await projectWithRecord(t);
  await fs.symlink(path.join(italian, ".sdlc", "project.json"), path.join(linked, ".sdlc", "project.json"), "file");
  assert.equal(readConfiguredProjectLocale(linked), null, "a symlinked project record is ignored");
  assert.equal(resolveObserveOptions({ projectRoot: linked }).locale, "en");
});

test("init records an explicit locale for later presentation defaults", async (t) => {
  for (const [args, expected] of [[["--locale", "it"], "it"], [[], undefined]]) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "observatory-init-locale-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const result = spawnSync(process.execPath, [
      CLI_PATH,
      "init",
      "--root",
      root,
      "--project-name",
      "Locale Fixture",
      "--json",
      ...args,
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const project = JSON.parse(await fs.readFile(path.join(root, ".sdlc", "project.json"), "utf8"));
    assert.equal(project.locale, expected, JSON.stringify(args));
    assert.equal(await readConfiguredProjectLocale(root), expected ?? null);
  }
});
