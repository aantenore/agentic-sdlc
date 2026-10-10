import { normalizeViewModel, safeRawHref } from "./model.js";
import {
  normalizePortfolioSummary,
  portfolioProjectHref,
} from "./portfolio.js";

const DEFAULT_ENDPOINT = "/api/v1/observatory";
const MAX_RAW_CHARACTERS = 2_000_000;
const MAX_RAW_BODY_BYTES = 2_000_000;
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_ERROR_MESSAGE_CHARACTERS = 1_024;
const ERROR_ENVELOPE_SCHEMA = "change-observatory:error:v1";
const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/u;
const CORRELATION_ID_PATTERN = /^corr-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const UNSAFE_ERROR_MESSAGE_PATTERNS = Object.freeze([
  /[\u0000-\u001f\u007f]/u,
  /[\u202a-\u202e\u2066-\u2069]/u,
  /\b[^\s@]{1,64}@[^\s@]{1,189}\.[^\s@]{1,63}\b/u,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/iu,
  /\b(?:AKIA[A-Z0-9]{16}|(?:github_pat_|gh[opsur]_|glpat-|sk-(?:proj-)?|sk_(?:live|test)_|xox[baprs]-)[A-Za-z0-9_-]{8,})/iu,
  /\beyJ[A-Za-z0-9_-]{5,512}\.[A-Za-z0-9_-]{5,768}\.[A-Za-z0-9_-]{10,512}\b/u,
  /\b(?:Set-Cookie|Cookie)\s*:/iu,
  /-----BEGIN [A-Z ]{0,32}PRIVATE KEY-----/u,
  /(?:["'](?=[A-Za-z0-9_])|\b)[A-Za-z0-9_]{0,128}(?:access[_-]?token|account[_-]?key|api[_-]?key|authorization|client[_-]?secret|credentials?|cookie|passphrase|passwd|password|private[_-]?key|pwd|refresh[_-]?token|secret[_-]?access[_-]?key|secret[_-]?key|secret|set[_-]?cookie|storage[_-]?account[_-]?key|token)["']?\s*[:=]/iu,
  /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^/\s:@]{1,512}:[^/\s@]{1,512}@/iu,
]);

export class ObservatoryApiError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "ObservatoryApiError";
    this.status = options.status ?? null;
    this.code = options.code ?? "OBSERVATORY_API_ERROR";
    this.correlationId = normalizeCorrelationId(options.correlationId);
  }
}

export class ObservatoryApi {
  #viewModelCache = null;
  #committedViewModel = null;
  #loadGeneration = 0;
  #committedLoadGeneration = 0;

  constructor({ endpoint = DEFAULT_ENDPOINT, fetchImpl = globalThis.fetch, accessToken = null } = {}) {
    if (typeof fetchImpl !== "function") {
      throw new TypeError("A fetch implementation is required.");
    }
    this.endpoint = endpoint;
    this.accessToken = normalizeAccessToken(accessToken);
    this.fetchImpl = (...args) => Reflect.apply(fetchImpl, globalThis, args);
  }

  async load({ signal } = {}) {
    const generation = ++this.#loadGeneration;
    const cached = this.#viewModelCache;
    const response = await this.#request(this.endpoint, {
      signal,
      headers: {
        Accept: "application/json",
        ...(cached ? { "If-None-Match": cached.etag } : {}),
      },
    }, { allowNotModified: true });

    if (response.status === 304) {
      if (!cached) {
        throw new ObservatoryApiError(
          "The observatory API returned HTTP 304 before a view model was cached.",
          {
            status: response.status,
            code: "NOT_MODIFIED_WITHOUT_CACHE",
          },
        );
      }

      if (generation > this.#committedLoadGeneration) {
        this.#viewModelCache = cached;
        this.#committedViewModel = cached.model;
        this.#committedLoadGeneration = generation;
      }
      return this.#committedViewModel ?? cached.model;
    }

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new ObservatoryApiError("The observatory API returned malformed JSON.", {
        status: response.status,
        code: "MALFORMED_VIEW_MODEL",
        cause: error,
      });
    }

    try {
      const model = normalizeViewModel(payload);
      const etag = normalizeEtag(response.headers.get("etag"));
      if (generation > this.#committedLoadGeneration) {
        this.#viewModelCache = etag ? { etag, model } : null;
        this.#committedViewModel = model;
        this.#committedLoadGeneration = generation;
        return model;
      }
      return this.#committedViewModel ?? model;
    } catch (error) {
      throw new ObservatoryApiError(error.message, {
        status: response.status,
        code: "UNSUPPORTED_VIEW_MODEL",
        cause: error,
      });
    }
  }

  async loadPortfolio({ signal } = {}) {
    const response = await this.#request("/api/v1/portfolio", {
      signal,
      headers: { Accept: "application/json" },
    });
    const payload = await parseJsonResponse(response, "portfolio summary");
    try {
      return normalizePortfolioSummary(payload);
    } catch (error) {
      throw new ObservatoryApiError(error.message, {
        status: response.status,
        code: "UNSUPPORTED_PORTFOLIO_MODEL",
        cause: error,
      });
    }
  }

  async loadProject(projectId, { signal } = {}) {
    const response = await this.#request(portfolioProjectHref(projectId), {
      signal,
      headers: { Accept: "application/json" },
    });
    const payload = await parseJsonResponse(response, "project view");
    try {
      return normalizeViewModel(payload);
    } catch (error) {
      throw new ObservatoryApiError(error.message, {
        status: response.status,
        code: "UNSUPPORTED_VIEW_MODEL",
        cause: error,
      });
    }
  }

  async loadRaw(href, { signal } = {}) {
    const safeHref = safeRawHref(href);
    if (!safeHref) {
      throw new ObservatoryApiError("The selected raw source is outside canonical .sdlc evidence.", {
        code: "UNSAFE_RAW_SOURCE",
      });
    }

    const response = await this.#request(safeHref, {
      signal,
      headers: { Accept: "application/json, text/plain;q=0.9" },
    });
    const rawBody = await readBoundedRawBody(response);
    const text = rawBody.text;
    const bounded =
      rawBody.truncated || text.length > MAX_RAW_CHARACTERS
        ? `${text.slice(0, MAX_RAW_CHARACTERS)}\n\n[Raw preview truncated at the ${MAX_RAW_BODY_BYTES.toLocaleString("en-US")}-byte safety limit]`
        : text;

    if (response.headers.get("content-type")?.includes("application/json")) {
      try {
        return JSON.stringify(JSON.parse(bounded), null, 2);
      } catch {
        return bounded;
      }
    }
    return bounded;
  }

  // Shared story claims this computer last saw on the remote. Optional:
  // an older server answers 404 and the views keep their recorded states.
  async loadClaims(portfolioProjectId = null, { signal } = {}) {
    const href = portfolioProjectId === null
      ? "/api/v1/claims"
      : `/api/v1/portfolio/claims?project=${encodeURIComponent(portfolioProjectId)}`;
    const response = await this.#request(href, { signal, headers: { Accept: "application/json" } });
    const payload = await parseJsonResponse(response, "shared claims");
    return Array.isArray(payload?.claims) ? payload.claims : [];
  }

  // Which branch the records come from and when they were last updated.
  // Optional: an older server answers 404 and nothing is shown.
  async loadSourceRef({ signal } = {}) {
    const response = await this.#request("/api/v1/source-ref", { signal, headers: { Accept: "application/json" } });
    return parseJsonResponse(response, "record source");
  }

  // Stories on the remote base branch that this computer has not pulled.
  // Optional: an older server answers 404 and nothing is added.
  async loadRemoteStories(portfolioProjectId = null, { signal } = {}) {
    const href = portfolioProjectId === null
      ? "/api/v1/remote-stories"
      : `/api/v1/portfolio/remote-stories?project=${encodeURIComponent(portfolioProjectId)}`;
    const response = await this.#request(href, { signal, headers: { Accept: "application/json" } });
    const payload = await parseJsonResponse(response, "remote stories");
    return Array.isArray(payload?.stories) ? payload.stories : [];
  }

  // Compact dependency edges of the project plan. Returns null when the
  // server predates this endpoint, so callers can read the graph record.
  async loadDependencyEdges(portfolioProjectId = null, { signal } = {}) {
    const href = portfolioProjectId === null
      ? "/api/v1/dependencies"
      : `/api/v1/portfolio/dependencies?project=${encodeURIComponent(portfolioProjectId)}`;
    let response;
    try {
      response = await this.#request(href, { signal, headers: { Accept: "application/json" } });
    } catch (error) {
      if (error?.status === 404) return null;
      throw error;
    }
    const payload = await parseJsonResponse(response, "dependency");
    return payload?.found ? (Array.isArray(payload.edges) ? payload.edges : []) : [];
  }

  // Parsed JSON content of one canonical record, for read-only projections
  // such as the dependency plan. Returns null when it is not structured data.
  async loadSourceData(href, { signal } = {}) {
    const raw = await this.loadRaw(href, { signal });
    try {
      const envelope = JSON.parse(raw);
      return envelope?.truncated ? null : (envelope?.data ?? null);
    } catch {
      return null;
    }
  }

  async #request(url, options, { allowNotModified = false } = {}) {
    let response;
    try {
      response = await this.fetchImpl(url, {
        ...options,
        headers: {
          ...options.headers,
          ...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
        },
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
      });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      throw new ObservatoryApiError("The local Change Observatory API is unavailable.", {
        code: "API_UNAVAILABLE",
        cause: error,
      });
    }

    if (!response.ok && !(allowNotModified && response.status === 304)) {
      throw await responseError(response);
    }
    return response;
  }
}

async function parseJsonResponse(response, label) {
  try {
    return await response.json();
  } catch (error) {
    throw new ObservatoryApiError(`The observatory API returned malformed ${label} JSON.`, {
      status: response.status,
      code: "MALFORMED_VIEW_MODEL",
      cause: error,
    });
  }
}

export function accessTokenFromHash(hash) {
  if (typeof hash !== "string" || !hash.startsWith("#")) return null;
  const token = new URLSearchParams(hash.slice(1)).get("access_token");
  return normalizeAccessToken(token);
}

function normalizeAccessToken(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(value)) return null;
  return value;
}

function normalizeEtag(value) {
  if (typeof value !== "string") return null;
  return value.trim() || null;
}

async function responseError(response) {
  const headerCorrelation = readCorrelationHeader(response);
  const body = await readBoundedErrorBody(response);
  const envelope = body.ok ? parseErrorEnvelope(body.text) : null;
  const correlationsAgree = envelope
    && headerCorrelation.state !== "invalid"
    && (headerCorrelation.state === "missing"
      || headerCorrelation.value === envelope.correlationId);

  if (envelope && correlationsAgree) {
    return new ObservatoryApiError(envelope.message, {
      status: response.status,
      code: envelope.code,
      correlationId: envelope.correlationId,
    });
  }

  return new ObservatoryApiError(`The observatory API returned HTTP ${response.status}.`, {
    status: response.status,
    code: "API_RESPONSE_ERROR",
    correlationId: envelope ? null : headerCorrelation.value,
  });
}

async function readBoundedRawBody(response) {
  const stream = response?.body;
  if (!stream || typeof stream.getReader !== "function") {
    throw new ObservatoryApiError("The selected raw source could not be read safely.", {
      status: response?.status ?? null,
      code: "MALFORMED_RAW_RESPONSE",
    });
  }
  let reader;
  try {
    reader = stream.getReader();
  } catch (error) {
    throw new ObservatoryApiError("The selected raw source could not be read safely.", {
      status: response?.status ?? null,
      code: "MALFORMED_RAW_RESPONSE",
      cause: error,
    });
  }

  const decoder = new TextDecoder("utf-8");
  let bytesRead = 0;
  let text = "";
  let truncated = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) {
        throw new TypeError("Raw response stream returned an unsupported chunk");
      }
      const remaining = MAX_RAW_BODY_BYTES - bytesRead;
      if (chunk.value.byteLength > remaining) {
        if (remaining > 0) {
          text += decoder.decode(chunk.value.subarray(0, remaining), { stream: true });
          bytesRead += remaining;
        }
        truncated = true;
        await cancelReader(reader);
        break;
      }
      text += decoder.decode(chunk.value, { stream: true });
      bytesRead += chunk.value.byteLength;
    }
    text += decoder.decode();
    return Object.freeze({ text, truncated });
  } catch (error) {
    await cancelReader(reader);
    throw new ObservatoryApiError("The selected raw source could not be read safely.", {
      status: response?.status ?? null,
      code: "MALFORMED_RAW_RESPONSE",
      cause: error,
    });
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A failed or cancelled stream can already have released its lock.
    }
  }
}

async function readBoundedErrorBody(response) {
  const stream = response?.body;
  if (!stream || typeof stream.getReader !== "function") {
    return { ok: false, text: "" };
  }

  let reader;
  try {
    reader = stream.getReader();
  } catch {
    return { ok: false, text: "" };
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytesRead = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) {
        await cancelReader(reader);
        return { ok: false, text: "" };
      }
      if (bytesRead + chunk.value.byteLength > MAX_ERROR_BODY_BYTES) {
        await cancelReader(reader);
        return { ok: false, text: "" };
      }
      bytesRead += chunk.value.byteLength;
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return { ok: true, text };
  } catch {
    await cancelReader(reader);
    return { ok: false, text: "" };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A failed or cancelled stream can already have released its lock.
    }
  }
}

async function cancelReader(reader) {
  try {
    await reader.cancel();
  } catch {
    // The response is already being rejected; cancellation is best effort.
  }
}

function parseErrorEnvelope(text) {
  let candidate;
  try {
    candidate = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    !hasOnlyKeys(candidate, ["schemaVersion", "status", "correlationId", "error"])
    || candidate.schemaVersion !== ERROR_ENVELOPE_SCHEMA
    || candidate.status !== "error"
    || !hasOnlyKeys(candidate.error, ["code", "message", "retryable"])
    || typeof candidate.error.retryable !== "boolean"
  ) {
    return null;
  }

  const correlationId = normalizeCorrelationId(candidate.correlationId);
  const code = normalizeErrorCode(candidate.error.code);
  const message = normalizeErrorMessage(candidate.error.message);
  if (!correlationId || !code || !message) return null;
  return Object.freeze({ correlationId, code, message });
}

function hasOnlyKeys(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expectedKeys.length
    && expectedKeys.every((key) => Object.hasOwn(value, key));
}

function normalizeErrorCode(value) {
  return typeof value === "string" && ERROR_CODE_PATTERN.test(value) ? value : null;
}

function normalizeErrorMessage(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (
    normalized.length === 0
    || normalized.length > MAX_ERROR_MESSAGE_CHARACTERS
    || UNSAFE_ERROR_MESSAGE_PATTERNS.some((pattern) => pattern.test(normalized))
  ) {
    return null;
  }
  return normalized;
}

function normalizeCorrelationId(value) {
  return typeof value === "string" && CORRELATION_ID_PATTERN.test(value)
    ? value.toLowerCase()
    : null;
}

function readCorrelationHeader(response) {
  let value;
  try {
    value = response?.headers?.get("x-correlation-id");
  } catch {
    return { state: "invalid", value: null };
  }
  if (value === null || value === undefined) return { state: "missing", value: null };
  const normalized = normalizeCorrelationId(value);
  return normalized
    ? { state: "valid", value: normalized }
    : { state: "invalid", value: null };
}
