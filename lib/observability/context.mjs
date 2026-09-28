import { crypto, Date } from "../runtime/host.mjs";
import {
  DEFAULT_OPERATIONAL_REDACTION_POLICY,
  REDACTION_LIMIT_PLACEHOLDER,
  redactText,
  redactValueWithMetadata,
} from "./redaction.mjs";

const CORRELATION_ID_PATTERN = /^corr-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const OPERATION_PATTERN = /^[a-z][a-z0-9_.:-]{0,127}$/u;
const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/u;

export class OperationContextError extends TypeError {
  constructor(message, code = "operation_context_invalid") {
    super(message);
    this.name = "OperationContextError";
    this.code = code;
  }
}

export function isValidCorrelationId(value) {
  return typeof value === "string" && CORRELATION_ID_PATTERN.test(value);
}

export function createCorrelationId(randomUUID = crypto.randomUUID) {
  if (typeof randomUUID !== "function") {
    throw new OperationContextError("randomUUID must be a function");
  }
  const correlationId = `corr-${randomUUID()}`;
  if (!isValidCorrelationId(correlationId)) {
    throw new OperationContextError("randomUUID returned an invalid UUID", "correlation_id_invalid");
  }
  return correlationId.toLowerCase();
}

export function createOperationContext(input, dependencies = {}) {
  if (!isPlainRecord(input)) {
    throw new OperationContextError("operation context input must be a plain object");
  }
  if (!isPlainRecord(dependencies)) {
    throw new OperationContextError("operation context dependencies must be a plain object");
  }
  const operation = normalizeOperation(input.operation, DEFAULT_OPERATIONAL_REDACTION_POLICY);
  const correlationId = input.correlationId === undefined
    ? createCorrelationId(dependencies.randomUUID)
    : normalizeCorrelationId(input.correlationId);
  const now = dependencies.now ?? (() => new Date());
  if (typeof now !== "function") {
    throw new OperationContextError("now must be a function");
  }
  const startedAt = normalizeInstant(input.startedAt ?? now(), "startedAt");
  return Object.freeze({
    schema_version: "agentic-sdlc-operation-context:v1",
    operation,
    correlation_id: correlationId,
    started_at: startedAt,
  });
}

export function normalizeOperationalError(error, options = {}) {
  if (!isPlainRecord(options)) {
    throw new OperationContextError("error normalization options must be a plain object");
  }
  const context = options.context;
  if (!isPlainRecord(context)) {
    throw new OperationContextError("error normalization requires an operation context");
  }
  const policy = options.redactionPolicy ?? DEFAULT_OPERATIONAL_REDACTION_POLICY;
  // Operation names are closed runtime metadata validated when the context is
  // created. Project privacy patterns apply to user/project content, not to
  // this fixed field; otherwise a pattern matching `cli.run` could make the
  // error handler itself throw and expose a process stack.
  const operation = normalizeOperation(context.operation, DEFAULT_OPERATIONAL_REDACTION_POLICY);
  const correlationId = normalizeCorrelationId(context.correlation_id);
  const candidate = isObjectLike(error) ? error : {};
  const status = normalizeStatus(safeRead(candidate, "statusCode") ?? safeRead(candidate, "status"));
  const code = normalizeErrorCode(safeRead(candidate, "code"), policy);
  const message = normalizeMessage(safeRead(candidate, "message"), policy);
  const detailsCandidate = options.details
    ?? safeRead(candidate, "details")
    ?? safeRead(candidate, "issues")
    ?? null;
  const detailsResult = redactValueWithMetadata(detailsCandidate, policy);
  const limited = detailsResult.limited || message.limited;

  return deepFreeze({
    schema_version: "agentic-sdlc-operation-error:v1",
    ok: false,
    operation,
    correlation_id: correlationId,
    error: {
      code,
      message: limited
        ? "Operation failed; sensitive details were withheld because safety limits were reached."
        : message.value,
      status,
      retryable: normalizeRetryable(safeRead(candidate, "retryable"), status),
      details: limited ? REDACTION_LIMIT_PLACEHOLDER : detailsResult.value,
      redaction_limited: limited,
    },
  });
}

function normalizeOperation(value, policy) {
  if (typeof value !== "string" || !OPERATION_PATTERN.test(value)) {
    throw new OperationContextError(
      "operation must start with a lowercase letter and contain only lowercase letters, numbers, '.', ':', '_' or '-'",
      "operation_name_invalid",
    );
  }
  if (redactText(value, policy) !== value) {
    throw new OperationContextError(
      "operation must not contain credential or private metadata",
      "operation_name_invalid",
    );
  }
  return value;
}

function normalizeCorrelationId(value) {
  if (!isValidCorrelationId(value)) {
    throw new OperationContextError(
      "correlationId must use the form corr-<uuid>",
      "correlation_id_invalid",
    );
  }
  return value.toLowerCase();
}

function normalizeInstant(value, label) {
  if (value === null || value === "" || typeof value === "boolean") {
    throw new OperationContextError(`${label} must be a valid date-time`, "operation_time_invalid");
  }
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new OperationContextError(`${label} must be a valid date-time`, "operation_time_invalid");
  }
  return date.toISOString();
}

function normalizeStatus(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 400 && number <= 599 ? number : 500;
}

function normalizeErrorCode(value, policy) {
  if (typeof value !== "string") return "internal_error";
  const normalized = value.trim().toLowerCase();
  if (!ERROR_CODE_PATTERN.test(normalized)) return "internal_error";
  const redacted = redactText(normalized, policy);
  return redacted === normalized ? normalized : "internal_error";
}

function normalizeMessage(value, policy) {
  const fallback = "The operation could not be completed.";
  const source = typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
  const redacted = redactText(source, policy);
  return {
    value: redacted === REDACTION_LIMIT_PLACEHOLDER ? fallback : redacted,
    limited: redacted === REDACTION_LIMIT_PLACEHOLDER,
  };
}

function normalizeRetryable(value, status) {
  if (typeof value === "boolean") return value;
  return status === 429 || status === 503 || status === 504;
}

function isObjectLike(value) {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

function safeRead(value, key) {
  try {
    return value[key];
  } catch {
    return undefined;
  }
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const item of Object.values(value)) deepFreeze(item, seen);
  return Object.freeze(value);
}
