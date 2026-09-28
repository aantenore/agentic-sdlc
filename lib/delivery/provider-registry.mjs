import { Date } from "../runtime/host.mjs";
import {
  DomainValidationError,
  STABLE_JSON_HASH_ALGORITHM,
  computeStableHash,
  immutableJson,
  isPlainRecord,
  normalizeIsoInstant,
  requireNonEmptyString,
} from "../canonical.mjs";

export const DELIVERY_PROVIDER_SPI_VERSION = "delivery-provider:v1";
export const PROVIDER_OPERATION_RECEIPT_VERSION = "provider-operation-receipt:v1";

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;
const ACTION_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;
const PHASE_METHODS = Object.freeze({
  precondition: "observePrecondition",
  completion: "verifyCompletion",
});
const FORBIDDEN_ADAPTER_MEMBERS = Object.freeze([
  "deploy",
  "execute",
  "merge",
  "mutate",
  "publish",
  "push",
  "release",
  "run",
  "write",
]);
const RECEIPT_KEYS = new Set([
  "hash_algorithm",
  "id",
  "kind",
  "observed_at",
  "operation",
  "precondition_receipt_ref",
  "proof",
  "provider",
  "receipt_hash",
  "schema_version",
  "status",
  "subject",
  "subject_hash",
  "version",
]);
const PROVIDER_DESCRIPTOR_KEYS = new Set(["adapter_version", "id", "spi_version"]);
const OPERATION_DESCRIPTOR_KEYS = new Set(["action", "id", "phase"]);

export class DeliveryProviderError extends Error {
  constructor(message, code = "delivery_provider_failed", details = {}) {
    super(message);
    this.name = "DeliveryProviderError";
    this.code = code;
    this.details = immutableJson(details);
  }
}

/**
 * Registry for delivery observers/verifiers. The SPI deliberately exposes no
 * execution hook: callers perform a separately authorized operation and then
 * ask the provider to prove its exact precondition or completion.
 */
export class DeliveryProviderRegistry {
  #providers = new Map();

  register(adapter) {
    const normalized = normalizeAdapter(adapter);
    if (this.#providers.has(normalized.id)) {
      throw new DeliveryProviderError(
        `Delivery provider '${normalized.id}' is already registered`,
        "provider_duplicate",
        { provider_id: normalized.id },
      );
    }
    this.#providers.set(normalized.id, normalized);
    return this;
  }

  has(providerId) {
    return this.#providers.has(normalizeProviderId(providerId));
  }

  get(providerId) {
    const id = normalizeProviderId(providerId);
    const adapter = this.#providers.get(id);
    if (!adapter) {
      throw new DeliveryProviderError(
        `Unknown delivery provider '${id}'`,
        "provider_unknown",
        { provider_id: id },
      );
    }
    return adapter;
  }

  list() {
    return immutableJson([...this.#providers.values()]
      .map((adapter) => ({
        id: adapter.id,
        adapter_version: adapter.adapter_version,
        spi_version: adapter.spi_version,
        capabilities: adapter.capabilities,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)));
  }

  supports(providerId, action, phase) {
    const adapter = this.get(providerId);
    const normalizedAction = normalizeAction(action);
    const normalizedPhase = normalizePhase(phase);
    return adapter.capabilities[normalizedAction]?.includes(normalizedPhase) === true;
  }

  observePrecondition(providerId, operation, runtime = {}) {
    return this.#invoke(providerId, "precondition", operation, null, runtime);
  }

  verifyCompletion(providerId, operation, preconditionReceipt, runtime = {}) {
    return this.#invoke(providerId, "completion", operation, preconditionReceipt, runtime);
  }

  #invoke(providerId, phase, operation, preconditionReceipt, runtime) {
    const adapter = this.get(providerId);
    const normalizedOperation = normalizeOperation(operation);
    const method = PHASE_METHODS[phase];
    const supportedPhases = adapter.capabilities[normalizedOperation.action] || [];
    if (!supportedPhases.includes(phase) || typeof adapter[method] !== "function") {
      throw new DeliveryProviderError(
        `Provider '${adapter.id}' cannot prove ${phase} for '${normalizedOperation.action}'`,
        "provider_operation_unsupported",
        {
          provider_id: adapter.id,
          action: normalizedOperation.action,
          phase,
        },
      );
    }

    const priorReceipt = phase === "completion"
      ? assertMatchingPreconditionReceipt(adapter, normalizedOperation, preconditionReceipt)
      : assertNoPreconditionReceipt(preconditionReceipt);

    let proof;
    try {
      proof = adapter[method](immutableJson(normalizedOperation), {
        precondition_receipt: priorReceipt,
        runtime,
      });
    } catch (error) {
      if (error instanceof DeliveryProviderError || error instanceof DomainValidationError) {
        throw error;
      }
      throw new DeliveryProviderError(
        `Provider '${adapter.id}' could not prove ${phase} for '${normalizedOperation.action}': ${safeErrorMessage(error)}`,
        "provider_verification_failed",
        {
          provider_id: adapter.id,
          action: normalizedOperation.action,
          phase,
        },
      );
    }
    if (!isPlainRecord(proof) || Object.keys(proof).length === 0) {
      throw new DeliveryProviderError(
        `Provider '${adapter.id}' returned no exact proof for '${normalizedOperation.action}'`,
        "provider_invalid_proof",
        { provider_id: adapter.id, action: normalizedOperation.action, phase },
      );
    }

    return buildProviderOperationReceipt({
      adapter,
      operation: normalizedOperation,
      phase,
      proof,
      preconditionReceipt: priorReceipt,
    });
  }
}

export function createProviderRegistry(adapters = []) {
  const registry = new DeliveryProviderRegistry();
  for (const adapter of adapters) registry.register(adapter);
  return registry;
}

export function buildProviderOperationReceipt({
  adapter,
  operation,
  phase,
  proof,
  preconditionReceipt = null,
}) {
  const normalizedAdapter = normalizeAdapter(adapter);
  const normalizedOperation = normalizeOperation(operation);
  const normalizedPhase = normalizePhase(phase);
  const normalizedProof = immutableJson(proof);
  if (!isPlainRecord(normalizedProof) || Object.keys(normalizedProof).length === 0) {
    throw new DeliveryProviderError("Provider operation proof must be a non-empty object", "provider_invalid_proof");
  }
  const priorReceiptRef = normalizedPhase === "completion"
    ? providerReceiptRef(assertMatchingPreconditionReceipt(
      normalizedAdapter,
      normalizedOperation,
      preconditionReceipt,
    ))
    : null;
  if (normalizedPhase === "precondition") assertNoPreconditionReceipt(preconditionReceipt);

  const subject = immutableJson(normalizedOperation.subject);
  const subjectHash = computeStableHash(subject);
  const receiptBase = {
    id: `${normalizedOperation.id}:${normalizedPhase}`,
    kind: "provider_operation_receipt",
    schema_version: PROVIDER_OPERATION_RECEIPT_VERSION,
    version: 1,
    provider: {
      id: normalizedAdapter.id,
      adapter_version: normalizedAdapter.adapter_version,
      spi_version: normalizedAdapter.spi_version,
    },
    operation: {
      id: normalizedOperation.id,
      action: normalizedOperation.action,
      phase: normalizedPhase,
    },
    subject,
    subject_hash: subjectHash,
    precondition_receipt_ref: priorReceiptRef,
    status: "verified",
    proof: normalizedProof,
    observed_at: normalizedOperation.observed_at,
  };
  return immutableJson({
    ...receiptBase,
    receipt_hash: computeStableHash(receiptBase),
    hash_algorithm: STABLE_JSON_HASH_ALGORITHM,
  });
}

export function validateProviderOperationReceiptIntegrity(receipt) {
  const errors = [];
  if (!isPlainRecord(receipt)) {
    return { valid: false, errors: ["provider operation receipt must be an object"] };
  }
  errors.push(...exactKeysErrors(receipt, RECEIPT_KEYS, "receipt"));
  if (receipt.kind !== "provider_operation_receipt") errors.push("receipt kind is invalid");
  if (receipt.schema_version !== PROVIDER_OPERATION_RECEIPT_VERSION) errors.push("receipt schema version is unsupported");
  if (receipt.version !== 1) errors.push("receipt version is unsupported");
  if (receipt.hash_algorithm !== STABLE_JSON_HASH_ALGORITHM) errors.push("receipt hash algorithm is invalid");
  if (receipt.status !== "verified") errors.push("receipt status is not verified");
  try {
    errors.push(...exactKeysErrors(receipt.provider, PROVIDER_DESCRIPTOR_KEYS, "receipt.provider"));
    const expectedProvider = normalizeProviderDescriptor(receipt.provider);
    if (expectedProvider.spi_version !== DELIVERY_PROVIDER_SPI_VERSION) {
      errors.push("provider SPI version is unsupported");
    }
  } catch (error) {
    errors.push(error.message);
  }
  try {
    errors.push(...exactKeysErrors(receipt.operation, OPERATION_DESCRIPTOR_KEYS, "receipt.operation"));
    const action = normalizeAction(receipt.operation?.action);
    const phase = normalizePhase(receipt.operation?.phase);
    const operationId = requireNonEmptyString(receipt.operation?.id, "receipt.operation.id");
    if (receipt.id !== `${operationId}:${phase}`) errors.push("receipt id does not bind its operation and phase");
    if (action !== receipt.operation?.action) errors.push("receipt action is not canonical");
    if (phase === "precondition" && receipt.precondition_receipt_ref !== null) {
      errors.push("precondition receipt unexpectedly references a prior receipt");
    }
    if (phase === "completion" && !isReceiptRef(receipt.precondition_receipt_ref)) {
      errors.push("completion receipt lacks its exact precondition receipt reference");
    }
  } catch (error) {
    errors.push(error.message);
  }
  if (!isPlainRecord(receipt.proof) || Object.keys(receipt.proof).length === 0) {
    errors.push("receipt proof is missing");
  }
  if (!isPlainRecord(receipt.subject) || Object.keys(receipt.subject).length === 0) {
    errors.push("receipt subject is missing");
  }
  if (!/^[a-f0-9]{64}$/u.test(receipt.subject_hash || "")) errors.push("receipt subject hash is malformed");
  if (!/^[a-f0-9]{64}$/u.test(receipt.receipt_hash || "")) errors.push("receipt hash is malformed");
  try {
    if (receipt.subject_hash !== computeStableHash(receipt.subject)) {
      errors.push("receipt subject hash is invalid");
    }
  } catch (error) {
    errors.push(`receipt subject is not canonical JSON: ${error.message}`);
  }
  try {
    normalizeIsoInstant(receipt.observed_at, "receipt.observed_at");
  } catch (error) {
    errors.push(error.message);
  }
  const {
    receipt_hash: storedHash,
    hash_algorithm: _hashAlgorithm,
    ...receiptBase
  } = receipt;
  try {
    if (storedHash !== computeStableHash(receiptBase)) errors.push("receipt hash is invalid");
  } catch (error) {
    errors.push(`receipt is not canonical JSON: ${error.message}`);
  }
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

export function assertProviderOperationReceiptIntegrity(receipt) {
  const result = validateProviderOperationReceiptIntegrity(receipt);
  if (!result.valid) {
    throw new DeliveryProviderError(
      `Provider operation receipt is invalid: ${result.errors.join("; ")}`,
      "provider_receipt_invalid",
      { errors: result.errors },
    );
  }
  return immutableJson(receipt);
}

function normalizeAdapter(adapter) {
  if (!isPlainRecord(adapter)) {
    throw new DeliveryProviderError("Delivery provider adapter must be a plain object", "provider_invalid");
  }
  for (const member of FORBIDDEN_ADAPTER_MEMBERS) {
    if (Object.hasOwn(adapter, member)) {
      throw new DeliveryProviderError(
        `Delivery provider adapters cannot expose execution member '${member}'`,
        "provider_execution_forbidden",
        { member },
      );
    }
  }
  const id = normalizeProviderId(adapter.id);
  const adapterVersion = requireNonEmptyString(adapter.adapter_version, "provider.adapter_version");
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(adapterVersion)) {
    throw new DeliveryProviderError("provider.adapter_version must be semantic version text", "provider_invalid");
  }
  if (adapter.spi_version !== DELIVERY_PROVIDER_SPI_VERSION) {
    throw new DeliveryProviderError(
      `Provider '${id}' uses unsupported SPI '${adapter.spi_version || "missing"}'`,
      "provider_spi_unsupported",
      { provider_id: id, spi_version: adapter.spi_version || null },
    );
  }
  if (!isPlainRecord(adapter.capabilities) || Object.keys(adapter.capabilities).length === 0) {
    throw new DeliveryProviderError(`Provider '${id}' must declare exact capabilities`, "provider_invalid");
  }
  const capabilities = {};
  for (const [rawAction, rawPhases] of Object.entries(adapter.capabilities)) {
    const action = normalizeAction(rawAction);
    if (!Array.isArray(rawPhases) || rawPhases.length === 0) {
      throw new DeliveryProviderError(`Provider '${id}' capability '${action}' has no phases`, "provider_invalid");
    }
    const phases = [...new Set(rawPhases.map(normalizePhase))].sort();
    if (phases.length !== rawPhases.length) {
      throw new DeliveryProviderError(`Provider '${id}' capability '${action}' repeats a phase`, "provider_invalid");
    }
    for (const phase of phases) {
      if (typeof adapter[PHASE_METHODS[phase]] !== "function") {
        throw new DeliveryProviderError(
          `Provider '${id}' declares ${phase} for '${action}' without ${PHASE_METHODS[phase]}()`,
          "provider_invalid",
        );
      }
    }
    capabilities[action] = phases;
  }
  return Object.freeze({
    id,
    adapter_version: adapterVersion,
    spi_version: DELIVERY_PROVIDER_SPI_VERSION,
    capabilities: immutableJson(capabilities),
    observePrecondition: adapter.observePrecondition,
    verifyCompletion: adapter.verifyCompletion,
  });
}

function normalizeProviderDescriptor(provider) {
  if (!isPlainRecord(provider)) throw new DeliveryProviderError("receipt.provider must be an object", "provider_receipt_invalid");
  return {
    id: normalizeProviderId(provider.id),
    adapter_version: requireNonEmptyString(provider.adapter_version, "receipt.provider.adapter_version"),
    spi_version: requireNonEmptyString(provider.spi_version, "receipt.provider.spi_version"),
  };
}

function normalizeOperation(operation) {
  if (!isPlainRecord(operation)) {
    throw new DeliveryProviderError("Provider operation must be a plain object", "provider_operation_invalid");
  }
  const id = requireNonEmptyString(operation.id, "provider_operation.id");
  if (id.includes("\0") || id.includes(":")) {
    throw new DeliveryProviderError("provider_operation.id cannot contain NUL or ':'", "provider_operation_invalid");
  }
  const action = normalizeAction(operation.action);
  if (!isPlainRecord(operation.subject)) {
    throw new DeliveryProviderError("provider_operation.subject must be an exact object", "provider_operation_invalid");
  }
  let subject;
  try {
    subject = immutableJson(operation.subject);
  } catch (error) {
    throw new DeliveryProviderError(
      `provider_operation.subject must be canonical JSON: ${error.message}`,
      "provider_operation_invalid",
    );
  }
  return Object.freeze({
    id,
    action,
    subject,
    observed_at: normalizeIsoInstant(operation.observed_at, "provider_operation.observed_at"),
  });
}

function normalizeProviderId(providerId) {
  const id = requireNonEmptyString(providerId, "provider.id").toLowerCase();
  if (!PROVIDER_ID_PATTERN.test(id)) {
    throw new DeliveryProviderError(`Invalid provider id '${providerId}'`, "provider_invalid");
  }
  return id;
}

function normalizeAction(action) {
  const value = requireNonEmptyString(action, "provider_operation.action").toLowerCase();
  if (!ACTION_PATTERN.test(value)) {
    throw new DeliveryProviderError(`Invalid provider operation action '${action}'`, "provider_operation_invalid");
  }
  return value;
}

function normalizePhase(phase) {
  const value = requireNonEmptyString(phase, "provider_operation.phase").toLowerCase();
  if (!Object.hasOwn(PHASE_METHODS, value)) {
    throw new DeliveryProviderError(`Unsupported provider operation phase '${phase}'`, "provider_operation_invalid");
  }
  return value;
}

function assertMatchingPreconditionReceipt(adapter, operation, receipt) {
  const verified = assertProviderOperationReceiptIntegrity(receipt);
  const preconditionObservedAt = Date.parse(verified.observed_at);
  const completionObservedAt = Date.parse(operation.observed_at);
  if (
    verified.operation.phase !== "precondition"
    || verified.operation.id !== operation.id
    || verified.operation.action !== operation.action
    || verified.provider.id !== adapter.id
    || verified.provider.adapter_version !== adapter.adapter_version
    || verified.provider.spi_version !== adapter.spi_version
    || verified.subject_hash !== computeStableHash(operation.subject)
    || !Number.isFinite(preconditionObservedAt)
    || !Number.isFinite(completionObservedAt)
    || completionObservedAt < preconditionObservedAt
  ) {
    throw new DeliveryProviderError(
      "Completion verification is not bound to the exact provider precondition receipt",
      "provider_precondition_mismatch",
      {
        provider_id: adapter.id,
        operation_id: operation.id,
        action: operation.action,
      },
    );
  }
  return verified;
}

function assertNoPreconditionReceipt(receipt) {
  if (receipt !== null && receipt !== undefined) {
    throw new DeliveryProviderError(
      "Precondition observation cannot consume a prior receipt",
      "provider_operation_invalid",
    );
  }
  return null;
}

function providerReceiptRef(receipt) {
  return {
    id: receipt.id,
    hash: receipt.receipt_hash,
  };
}

function isReceiptRef(value) {
  return isPlainRecord(value)
    && typeof value.id === "string"
    && value.id.length > 0
    && /^[a-f0-9]{64}$/u.test(value.hash || "")
    && Object.keys(value).every((key) => ["hash", "id"].includes(key));
}

function exactKeysErrors(value, expectedKeys, label) {
  if (!isPlainRecord(value)) return [`${label} must be an object`];
  const actualKeys = Object.keys(value);
  const missing = [...expectedKeys].filter((key) => !actualKeys.includes(key));
  const unexpected = actualKeys.filter((key) => !expectedKeys.has(key));
  return [
    ...(missing.length > 0 ? [`${label} is missing fields: ${missing.sort().join(", ")}`] : []),
    ...(unexpected.length > 0 ? [`${label} contains unsupported fields: ${unexpected.sort().join(", ")}`] : []),
  ];
}

function safeErrorMessage(error) {
  const stderr = Buffer.isBuffer(error?.stderr) ? error.stderr.toString("utf8") : error?.stderr;
  return String(stderr || error?.message || error || "unknown provider error").trim().slice(0, 1_000);
}
