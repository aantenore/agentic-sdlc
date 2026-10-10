import path from "node:path";
import { fileURLToPath } from "node:url";

import { childProcess, fs, process } from "../runtime/host.mjs";
import { fail } from "../cli/user-error.mjs";
import { startObservatoryServer } from "./server.mjs";
import { createSharedRefSource } from "./shared-ref-source.mjs";
import {
  createOperationContext,
  normalizeOperationalError,
} from "../observability/context.mjs";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_PARENT_DISCONNECT_FORCE_EXIT_MS = 4_000;
const SUPPORTED_LOCALES = new Set(["en", "it"]);
const PROJECT_RECORD_PATH = ".sdlc/project.json";
const MAX_PROJECT_RECORD_BYTES = 256 * 1024;
const DEFAULT_ASSET_ROOT = fileURLToPath(
  new URL("../../ui/change-observatory/", import.meta.url),
);

export const OBSERVE_LIVE_SECONDS_ENV = "AGENTIC_SDLC_OBSERVE_LIVE_SECONDS";
const DEFAULT_LIVE_SECONDS = 8;
const MIN_LIVE_SECONDS = 2;

// How often the page polls while live updates are on (seconds).
export function liveRefreshSeconds(environment = {}) {
  const value = Number(environment[OBSERVE_LIVE_SECONDS_ENV]);
  return Number.isFinite(value) && value >= MIN_LIVE_SECONDS ? value : DEFAULT_LIVE_SECONDS;
}

export function bundledObservatoryAssetRoot() {
  return DEFAULT_ASSET_ROOT;
}

export function parseObserveOptions(options = {}) {
  const host = options.host === undefined ? LOOPBACK_HOST : String(options.host).trim();
  if (host !== LOOPBACK_HOST) {
    throw new TypeError(`Change Observatory may bind only to ${LOOPBACK_HOST}`);
  }

  const rawPort = options.port === undefined ? 0 : options.port;
  if (typeof rawPort === "string" && rawPort.trim() === "") {
    throw new TypeError("Observatory port must be an integer between 0 and 65535");
  }
  const port = typeof rawPort === "number" ? rawPort : Number(String(rawPort).trim());
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError("Observatory port must be an integer between 0 and 65535");
  }

  const projectRoot = path.resolve(String(options.projectRoot || process.cwd()));
  let portfolioManifest;
  if (options.portfolioManifest !== undefined) {
    if (
      typeof options.portfolioManifest !== "string"
      || options.portfolioManifest.trim() === ""
      || options.portfolioManifest !== options.portfolioManifest.trim()
    ) {
      throw new TypeError(
        "Portfolio mode needs --portfolio-manifest with one explicit relative JSON path",
      );
    }
    portfolioManifest = options.portfolioManifest;
  }
  const locale = normalizeObserveLocale(options.locale || "en");
  if (!locale) {
    throw new TypeError("Change Observatory locale must be en or it");
  }
  if (options.ref !== undefined && (typeof options.ref !== "string" || options.ref.trim() === "" || options.ref.startsWith("-"))) {
    throw new TypeError("--ref needs the name of a branch or ref, for example origin/main");
  }
  if (options.ref !== undefined && options.worktree === true) {
    throw new TypeError("Use either --ref or --worktree, not both");
  }
  return Object.freeze({
    projectRoot,
    ...(portfolioManifest === undefined ? {} : { portfolioManifest }),
    ...(options.ref === undefined ? {} : { ref: options.ref.trim() }),
    ...(options.worktree === true ? { worktree: true } : {}),
    host,
    port,
    openBrowser: options.openBrowser !== false,
    json: options.json === true,
    locale,
  });
}

function normalizeObserveLocale(value) {
  const locale = String(value ?? "").trim().toLowerCase().split(/[-_]/u)[0];
  return SUPPORTED_LOCALES.has(locale) ? locale : null;
}

// The locale recorded at initialization is a presentation preference only.
// It is read synchronously so launch ordering is unchanged, and any symlinked,
// oversized, unreadable, or unexpected record falls back to the default
// instead of blocking the read-only viewer.
export function readConfiguredProjectLocale(projectRoot) {
  try {
    let current = fs.realpathSync(path.resolve(String(projectRoot)));
    for (const segment of PROJECT_RECORD_PATH.split("/")) {
      current = path.join(current, segment);
      if (fs.lstatSync(current).isSymbolicLink()) return null;
    }
    const stats = fs.statSync(current);
    if (!stats.isFile() || stats.size > MAX_PROJECT_RECORD_BYTES) return null;
    const project = JSON.parse(fs.readFileSync(current, "utf8"));
    return typeof project?.locale === "string" ? normalizeObserveLocale(project.locale) : null;
  } catch {
    return null;
  }
}

export function resolveObserveOptions(options = {}) {
  const parsed = parseObserveOptions(options);
  if (options.locale !== undefined && options.locale !== null && options.locale !== "") {
    return parsed;
  }
  const configured = readConfiguredProjectLocale(parsed.projectRoot);
  return configured ? Object.freeze({ ...parsed, locale: configured }) : parsed;
}

export async function runObserveCommand(options = {}, dependencies = {}) {
  const parsed = resolveObserveOptions(options);
  const serverFactory = dependencies.serverFactory ?? startObservatoryServer;
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const processRef = dependencies.processRef ?? process;
  const opener = dependencies.opener ?? openBrowserBestEffort;
  const startupController = new AbortController();
  const operationContext = createOperationContext({ operation: "observatory.launch" });
  let running = null;
  let closed = false;
  let readyAnnounced = false;
  let signals = null;
  let runningClosePromise = null;
  let outputClosed = false;
  let startupCompleted = false;
  let resolveStartupCompletion;
  const startupCompletion = new Promise((resolve) => {
    resolveStartupCompletion = resolve;
  });
  const finishStartup = () => {
    if (startupCompleted) return;
    startupCompleted = true;
    resolveStartupCompletion();
  };
  // A reader that goes away (for example `| head -1`) must not crash the
  // viewer with an unhandled EPIPE error event. The failure only surfaces on
  // the next write, so the viewer stops cleanly at that point rather than at
  // the moment the reader exits.
  guardOutputStreams([stdout, stderr], () => {
    outputClosed = true;
    if (!closed) void announceStopped(null).catch(() => {});
  });
  // Records come from the shared base branch unless --worktree asks for the
  // local files; without that ref (no Git, no remote) the local files are shown.
  // An injected server (tests, embedding hosts) gets the root it was given.
  const sharedSource = dependencies.sharedSource !== undefined
    ? dependencies.sharedSource
    : dependencies.serverFactory ? null : openSharedSource(parsed);
  sharedSource?.start();
  const closeRunning = () => {
    sharedSource?.stop();
    if (!running) return Promise.resolve();
    runningClosePromise ??= Promise.resolve(running.close());
    return runningClosePromise;
  };
  const announceStopped = async (signal = null) => {
    if (closed) return;
    closed = true;
    startupController.abort(new Error(`Observatory shutdown requested: ${signal ?? "local-close"}`));
    signals?.dispose();
    await closeRunning();
    if (!startupCompleted) await startupCompletion;
    if (!readyAnnounced) return;
    if (outputClosed) return;
    writeObserveEvent(stdout, {
      event: "observatory.stopped",
      status: "stopped",
      signal,
      locale: parsed.locale,
      correlation_id: operationContext.correlation_id,
    }, { json: parsed.json });
  };
  const stoppedResult = () => ({
    ...(running ?? {}),
    readyEvent: null,
    async close() {
      await announceStopped(null);
    },
    shutdown: announceStopped,
  });

  if (dependencies.registerSignals !== false) {
    signals = registerShutdownHandlers({
      processRef,
      parentIpcExpected: dependencies.parentIpcExpected === true,
      parentDisconnectTimeoutMs: dependencies.parentDisconnectTimeoutMs,
      forceExit: dependencies.forceExit,
      shutdown: announceStopped,
      onError(error) {
        processRef.exitCode = 1;
        writeObserveEvent(stderr, {
          event: "observatory.shutdown_failed",
          status: "error",
          error: safeOperationalMessage(error, operationContext),
          platform: processRef.platform ?? process.platform,
          locale: parsed.locale,
          correlation_id: operationContext.correlation_id,
        }, { json: parsed.json });
      },
    });
  }

  try {
    running = await serverFactory({
      projectRoot: sharedSource ? sharedSource.root : parsed.projectRoot,
      sourceRef: () => (sharedSource ? sharedSource.info() : { mode: "worktree" }),
      refreshSource: async (mode) => { await sharedSource?.refresh(mode); },
      liveRefreshSeconds: liveRefreshSeconds(processRef.env ?? process.env),
      ...(parsed.portfolioManifest === undefined
        ? {}
        : { portfolioManifest: parsed.portfolioManifest }),
      assetRoot: DEFAULT_ASSET_ROOT,
      host: parsed.host,
      port: parsed.port,
      locale: parsed.locale,
      signal: startupController.signal,
    });
  } catch (error) {
    signals?.dispose();
    sharedSource?.stop();
    finishStartup();
    if (closed) return stoppedResult();
    if (error?.code === "EADDRINUSE") {
      fail(
        `Port ${parsed.port} on ${parsed.host} is already in use. `
        + "Pick a different one with --port <number>, or use --port 0 to let the system choose a free port.",
      );
    }
    throw error;
  }

  if (closed) {
    await closeRunning();
    finishStartup();
    return stoppedResult();
  }

  let readiness = null;
  try {
    readiness = typeof running.warmReadiness === "function"
      ? await running.warmReadiness({ signal: startupController.signal })
      : null;
    if (closed) {
      await closeRunning();
      finishStartup();
      return stoppedResult();
    }
    if (readiness && readiness.status !== "ready") {
      const error = new Error("The local observatory started but its project data is not ready");
      error.code = "observatory_not_ready";
      error.statusCode = 503;
      error.retryable = true;
      throw error;
    }
  } catch (error) {
    if (closed) {
      await closeRunning().catch(() => {});
      finishStartup();
      return stoppedResult();
    }
    signals?.dispose();
    closed = true;
    await closeRunning().catch(() => {});
    finishStartup();
    throw error;
  }

  finishStartup();

  const readyEvent = {
    event: "observatory.ready",
    status: "ready",
    url: running.accessUrl ?? running.url,
    base_url: running.url,
    health_url: running.healthUrl,
    live_url: running.liveUrl ?? running.healthUrl,
    ready_url: running.readyUrl ?? null,
    model_url: running.modelUrl,
    metrics_url: running.metricsUrl ?? null,
    slo_url: running.sloUrl ?? null,
    support_bundle_url: running.supportBundleUrl ?? null,
    host: running.address.host,
    port: running.address.port,
    project_root: parsed.projectRoot,
    source_ref: sharedSource ? sharedSource.ref : null,
    ...(parsed.portfolioManifest === undefined
      ? {}
      : { mode: "portfolio", portfolio_manifest: parsed.portfolioManifest }),
    browser_open_requested: parsed.openBrowser,
    authentication: running.accessUrl ? "per-run-bearer-fragment" : "none",
    locale: parsed.locale,
    readiness: readiness?.status ?? "not_checked",
    correlation_id: readiness?.correlationId ?? operationContext.correlation_id,
  };
  writeObserveEvent(stdout, readyEvent, { json: parsed.json });
  readyAnnounced = true;

  if (parsed.openBrowser) {
    opener(readyEvent.url, {
      onError(error) {
        writeObserveEvent(stderr, {
          event: "observatory.browser_open_failed",
          status: "warning",
          // The access address already went to stdout; in machine mode the
          // error stream does not carry it a second time.
          ...(parsed.json ? {} : { url: readyEvent.url }),
          error: describeBrowserOpenError(error, operationContext, parsed.locale),
          platform: processRef.platform ?? process.platform,
          locale: parsed.locale,
          correlation_id: operationContext.correlation_id,
        }, { json: parsed.json });
      },
    });
  }

  return {
    ...running,
    readyEvent,
    async close() {
      await announceStopped(null);
    },
    shutdown: announceStopped,
  };
}

function openSharedSource(parsed) {
  if (parsed.portfolioManifest !== undefined || parsed.worktree) return null;
  let source = null;
  try {
    source = createSharedRefSource(parsed.projectRoot, { ref: parsed.ref ?? null });
  } catch (error) {
    if (parsed.ref !== undefined) throw new TypeError(`The ref ${parsed.ref} could not be read: ${error.message}`);
    return null;
  }
  if (!source && parsed.ref !== undefined) {
    throw new TypeError(`The ref ${parsed.ref} does not exist in this repository`);
  }
  return source;
}

const GUARDED_OUTPUT_STREAMS = new WeakSet();
const BROKEN_OUTPUT_CODES = new Set(["EPIPE", "ERR_STREAM_DESTROYED", "ERR_STREAM_WRITE_AFTER_END"]);

// Output pipes can close while the viewer keeps running. The error listener
// turns that into a clean stop; any other stream failure keeps its default
// behavior by being rethrown.
function guardOutputStreams(streams, onBroken) {
  for (const stream of streams) {
    if (!stream || typeof stream.on !== "function" || GUARDED_OUTPUT_STREAMS.has(stream)) continue;
    GUARDED_OUTPUT_STREAMS.add(stream);
    stream.on("error", (error) => {
      if (!BROKEN_OUTPUT_CODES.has(error?.code)) throw error;
      onBroken(error);
    });
  }
}

function safeOperationalMessage(error, context) {
  return normalizeOperationalError(error, { context }).error.message;
}

function describeBrowserOpenError(error, context, locale) {
  if (error?.code === "ENOENT") {
    return locale === "it"
      ? "Impossibile aprire automaticamente un browser (nessun programma di apertura trovato su questo computer)."
      : "Could not open a browser automatically (no browser launcher was found on this computer).";
  }
  return safeOperationalMessage(error, context);
}

export function openBrowserBestEffort(url, options = {}) {
  const platform = options.platform ?? process.platform;
  const spawn = options.spawn ?? childProcess.spawn;
  const onError = typeof options.onError === "function" ? options.onError : () => {};
  const command = browserCommand(platform, url);
  if (!command) {
    onError(new Error(`Automatic browser opening is unsupported on ${platform}`));
    return null;
  }

  try {
    const child = spawn(command.executable, command.arguments, {
      detached: true,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once?.("error", onError);
    child.unref?.();
    return child;
  } catch (error) {
    onError(error);
    return null;
  }
}

export function registerShutdownHandlers({
  shutdown,
  processRef = process,
  parentIpcExpected = false,
  parentDisconnectTimeoutMs = DEFAULT_PARENT_DISCONNECT_FORCE_EXIT_MS,
  forceExit = null,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  onError = () => {},
}) {
  if (typeof shutdown !== "function") {
    throw new TypeError("A shutdown callback is required");
  }
  if (!Number.isSafeInteger(parentDisconnectTimeoutMs) || parentDisconnectTimeoutMs < 1) {
    throw new TypeError("Parent disconnect timeout must be a positive safe integer");
  }
  if (forceExit !== null && typeof forceExit !== "function") {
    throw new TypeError("Forced Observatory exit must be a function");
  }
  if (typeof setTimeoutFn !== "function" || typeof clearTimeoutFn !== "function") {
    throw new TypeError("Observatory shutdown timeout functions are invalid");
  }
  let active = true;
  let shuttingDown = false;
  let forced = false;
  let forceTimer = null;
  const handlers = new Map();

  const dispose = () => {
    if (!active) return;
    active = false;
    for (const [signal, handler] of handlers) {
      processRef.removeListener(signal, handler);
    }
    handlers.clear();
    if (!shuttingDown && forceTimer) {
      clearTimeoutFn(forceTimer);
      forceTimer = null;
    }
  };

  const register = (event, signal) => {
    const handler = () => {
      if (!active || shuttingDown) return;
      shuttingDown = true;
      if (signal === "parent-disconnect") {
        forceTimer = setTimeoutFn(() => {
          forced = true;
          processRef.exitCode = 1;
          const terminate = forceExit
            ?? (typeof processRef.exit === "function" ? processRef.exit.bind(processRef) : null);
          terminate?.(1);
        }, parentDisconnectTimeoutMs);
      }
      Promise.resolve(shutdown(signal))
        .then(() => {
          if (!forced) processRef.exitCode = 0;
        })
        .catch(onError)
        .finally(() => {
          if (forceTimer) {
            clearTimeoutFn(forceTimer);
            forceTimer = null;
          }
          dispose();
        });
    };
    handlers.set(event, handler);
    processRef.on(event, handler);
  };

  for (const signal of ["SIGINT", "SIGTERM"]) register(signal, signal);
  if (parentIpcExpected || processRef.connected === true) {
    register("disconnect", "parent-disconnect");
    if (processRef.connected !== true) {
      queueMicrotask(handlers.get("disconnect"));
    }
  }

  return { dispose };
}

export function writeObserveEvent(stream, event, { json = false } = {}) {
  if (json) {
    stream.write(`${JSON.stringify(event)}\n`);
    return;
  }
  const italian = event.locale === "it";
  if (event.event === "observatory.ready") {
    const portfolio = event.mode === "portfolio";
    stream.write([
      `${italian ? "Risultato" : "Outcome"}: ${italian ? "L’osservatorio locale è pronto." : "The local observatory is ready."}`,
      `${italian ? "Cosa cambia in pratica" : "What this changes in practice"}: ${italian
        ? portfolio
          ? "Puoi confrontare i progetti elencati e aprirne i dettagli dal browser."
          : "Puoi esplorare richieste, modifiche, decisioni e prove dal browser."
        : portfolio
          ? "You can compare the listed projects and open their details in the browser."
          : "You can explore requests, changes, decisions, and evidence in the browser."}`,
      `${italian ? "Cosa devi decidere" : "What you need to decide"}: ${italian ? "Non devi approvare nulla per aprire questa vista." : "You do not need to approve anything to open this view."}`,
      `${italian ? "Cosa resta protetto" : "What remains protected"}: ${italian ? "La sessione è locale e in sola lettura; non modifica file e non pubblica dati." : "The session is local and read-only; it does not change files or publish data."}`,
      `${italian ? "Prossimo passo" : "Next step"}: ${italian ? "Apri nel browser questo indirizzo completo, compresa la parte dopo il simbolo #. Lascia aperto questo terminale e premi Ctrl+C quando hai finito." : "Open this full address in your browser, including the part after the # sign. Keep this terminal open and press Ctrl+C when finished."}`,
      `  ${event.url}`,
      "",
      `${italian ? "Dettagli tecnici (facoltativi)" : "Technical details (optional)"}:`,
      `- URL: ${event.url}`,
      `- ${portfolio ? (italian ? "Radice portfolio" : "Portfolio root") : (italian ? "Progetto" : "Project")}: ${event.project_root}`,
      ...(portfolio
        ? [`- ${italian ? "Elenco progetti" : "Project list"}: ${event.portfolio_manifest}`]
        : []),
      "",
    ].join("\n"));
    return;
  }
  if (event.event === "observatory.browser_open_failed") {
    stream.write([
      `${italian ? "Risultato" : "Outcome"}: ${italian ? "L’osservatorio locale è pronto, ma il browser non si è aperto automaticamente." : "The local observatory is ready, but the browser did not open automatically."}`,
      `${italian ? "Cosa cambia in pratica" : "What this changes in practice"}: ${italian ? "La pagina in sola lettura resta disponibile all’indirizzo già mostrato." : "The read-only page is still available at the address already shown."}`,
      `${italian ? "Cosa devi decidere" : "What you need to decide"}: ${italian ? "Non devi approvare nulla." : "You do not need to approve anything."}`,
      `${italian ? "Cosa resta protetto" : "What remains protected"}: ${italian ? "Nessun file del progetto è stato modificato e nessun dato è stato pubblicato." : "No project file was changed and no data was published."}`,
      `${italian ? "Prossimo passo" : "Next step"}: ${italian ? "Copia questo indirizzo completo, compresa la parte dopo il simbolo #, e aprilo nel browser:" : "Copy this full address, including the part after the # sign, and open it in your browser:"}`,
      `  ${event.url}`,
      "",
      `${italian ? "Dettagli tecnici (facoltativi)" : "Technical details (optional)"}:`,
      `- URL: ${event.url}`,
      `- ${italian ? "Piattaforma" : "Platform"}: ${event.platform}`,
      `- ${italian ? "Errore" : "Error"}: ${event.error}`,
      "",
    ].join("\n"));
    return;
  }
  if (event.event === "observatory.shutdown_failed") {
    stream.write([
      `${italian ? "Risultato" : "Outcome"}: ${italian ? "L’osservatorio non è riuscito a chiudersi correttamente." : "The observatory could not finish closing cleanly."}`,
      `${italian ? "Cosa cambia in pratica" : "What this changes in practice"}: ${italian ? "La pagina potrebbe restare disponibile finché il processo non viene terminato." : "The page may remain available until the process is stopped."}`,
      `${italian ? "Cosa devi decidere" : "What you need to decide"}: ${italian ? "Non serve alcuna approvazione." : "No approval is needed."}`,
      `${italian ? "Cosa resta protetto" : "What remains protected"}: ${italian ? "La vista resta in sola lettura e l’errore non autorizza modifiche ai file." : "The viewer remains read-only, and the failure does not authorize file changes."}`,
      `${italian ? "Prossimo passo" : "Next step"}: ${italian ? "Termina manualmente il processo; se serve, riapri poi l’osservatorio." : "Stop the process manually; then reopen the observatory if needed."}`,
      "",
      `${italian ? "Dettagli tecnici (facoltativi)" : "Technical details (optional)"}:`,
      `- ${italian ? "Piattaforma" : "Platform"}: ${event.platform}`,
      `- ${italian ? "Errore" : "Error"}: ${event.error}`,
      "",
    ].join("\n"));
    return;
  }
  if (event.event === "observatory.stopped") {
    stream.write([
      `${italian ? "Risultato" : "Outcome"}: ${italian ? "L’osservatorio locale è stato chiuso." : "The local observatory was stopped."}`,
      `${italian ? "Cosa cambia in pratica" : "What this changes in practice"}: ${italian ? "La pagina non riceverà altri aggiornamenti finché non verrà riaperta." : "The page will not receive more updates until it is opened again."}`,
      `${italian ? "Cosa devi decidere" : "What you need to decide"}: ${italian ? "Non devi decidere nulla." : "You do not need to decide anything."}`,
      `${italian ? "Cosa resta protetto" : "What remains protected"}: ${italian ? "Nessun file è stato modificato dalla chiusura." : "Stopping the session did not change any files."}`,
      `${italian ? "Prossimo passo" : "Next step"}: ${italian ? "Riapri l’osservatorio quando vuoi consultare di nuovo le prove." : "Open the observatory again when you want to review the evidence."}`,
      ...(event.signal ? ["", `${italian ? "Dettagli tecnici (facoltativi)" : "Technical details (optional)"}:`, `- ${italian ? "Segnale" : "Signal"}: ${event.signal}`] : []),
      "",
    ].join("\n"));
  }
}

function browserCommand(platform, url) {
  if (platform === "darwin") return { executable: "open", arguments: [url] };
  if (platform === "win32") {
    return {
      executable: "rundll32.exe",
      arguments: ["url.dll,FileProtocolHandler", url],
    };
  }
  if (["linux", "freebsd", "openbsd"].includes(platform)) {
    return { executable: "xdg-open", arguments: [url] };
  }
  return null;
}
