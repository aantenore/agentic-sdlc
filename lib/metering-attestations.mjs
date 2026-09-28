import { crypto } from "./runtime/host.mjs";
import {
  DomainValidationError,
  STABLE_JSON_HASH_ALGORITHM,
  cloneJson,
  computeStableHash,
  immutableJson,
  isPlainRecord,
  normalizeIsoInstant,
  omitKeys,
  requireNonEmptyString,
  requirePlainRecord,
} from "./canonical.mjs";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const SCHEMA_VERSION = "metering-attestation:v1";

export function computeExactMeteringPolicyHash(policy) {
  requirePlainRecord(policy, "exact_metering_policy");
  return computeStableHash(policy);
}

export function computeMeteringMeasurementHash(measurement) {
  requirePlainRecord(measurement, "metering_measurement");
  return computeStableHash(measurement);
}

export function computeMeteringAttestationPayloadHash(attestation) {
  requirePlainRecord(attestation, "metering_attestation");
  return computeStableHash(omitKeys(attestation, ["attestation", "attestation_hash", "hash_algorithm"]));
}

export function computeMeteringAttestationHash(attestation) {
  requirePlainRecord(attestation, "metering_attestation");
  return computeStableHash(omitKeys(attestation, ["attestation_hash", "hash_algorithm"]));
}

export function buildMeteringAttestation(input) {
  requirePlainRecord(input, "metering_attestation");
  const measurement = normalizeMeasurement(input.measurement ?? input);
  const issuedAt = normalizeIsoInstant(input.issued_at, "metering_attestation.issued_at");
  const validFrom = normalizeIsoInstant(input.valid_from ?? issuedAt, "metering_attestation.valid_from");
  const expiresAt = input.expires_at === undefined || input.expires_at === null
    ? null
    : normalizeIsoInstant(input.expires_at, "metering_attestation.expires_at");
  if (issuedAt < measurement.coverage_ended_at) {
    throw new DomainValidationError("metering_attestation.issued_at must not be earlier than measurement.coverage_ended_at");
  }
  if (issuedAt < validFrom) {
    throw new DomainValidationError("metering_attestation was issued before valid_from");
  }
  if (expiresAt && expiresAt <= issuedAt) {
    throw new DomainValidationError("metering_attestation.expires_at must be later than issued_at");
  }
  const unsigned = {
    kind: "metering_attestation",
    schema_version: SCHEMA_VERSION,
    version: 1,
    id: requireNonEmptyString(input.id ?? input.attestation_id, "metering_attestation.id"),
    measurement,
    measurement_hash: computeMeteringMeasurementHash(measurement),
    issued_at: issuedAt,
    valid_from: validFrom,
    expires_at: expiresAt,
  };
  return signMeteringAttestation(unsigned, input.signing);
}

export function signMeteringAttestation(attestation, signing) {
  requirePlainRecord(attestation, "metering_attestation");
  requirePlainRecord(signing, "metering_attestation.signing");
  const keyId = requireNonEmptyString(signing.key_id, "metering_attestation.signing.key_id");
  if (!signing.private_key) {
    throw new DomainValidationError("metering_attestation.signing.private_key is required");
  }
  let privateKey;
  try {
    privateKey = signing.private_key instanceof crypto.KeyObject
      ? signing.private_key
      : crypto.createPrivateKey(signing.private_key);
  } catch (error) {
    throw new DomainValidationError(`metering_attestation.signing.private_key is invalid: ${error.message}`);
  }
  if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") {
    throw new DomainValidationError("metering_attestation.signing.private_key must be an Ed25519 private key");
  }
  const base = omitKeys(attestation, ["attestation", "attestation_hash", "hash_algorithm"]);
  const payloadHash = computeMeteringAttestationPayloadHash(base);
  const signature = crypto.sign(null, Buffer.from(payloadHash, "hex"), privateKey).toString("base64");
  const signed = {
    ...base,
    attestation: {
      algorithm: "Ed25519",
      key_id: keyId,
      payload_hash: payloadHash,
      signature,
    },
  };
  return immutableJson({
    ...signed,
    attestation_hash: computeMeteringAttestationHash(signed),
    hash_algorithm: STABLE_JSON_HASH_ALGORITHM,
  });
}

export function validateMeteringAttestationIntegrity(attestation, options = {}) {
  const errors = [];
  if (!isPlainRecord(attestation)) {
    return Object.freeze({ valid: false, errors: Object.freeze(["metering attestation must be a plain object"]) });
  }
  if (attestation.kind !== "metering_attestation") errors.push("attestation.kind must be 'metering_attestation'");
  if (attestation.schema_version !== SCHEMA_VERSION || attestation.version !== 1) {
    errors.push(`attestation must use ${SCHEMA_VERSION}`);
  }
  if (attestation.hash_algorithm !== STABLE_JSON_HASH_ALGORITHM) {
    errors.push(`attestation.hash_algorithm must be '${STABLE_JSON_HASH_ALGORITHM}'`);
  }
  let measurement = null;
  try {
    measurement = normalizeMeasurement(attestation.measurement);
    if (computeStableHash(measurement) !== computeStableHash(attestation.measurement)) {
      errors.push("attestation.measurement is not in canonical normalized form");
    }
    if (attestation.measurement_hash !== computeMeteringMeasurementHash(measurement)) {
      errors.push("attestation.measurement_hash does not match the complete measurement");
    }
  } catch (error) {
    errors.push(error.message);
  }
  let expectedPayloadHash = null;
  let expectedAttestationHash = null;
  try {
    expectedPayloadHash = computeMeteringAttestationPayloadHash(attestation);
    expectedAttestationHash = computeMeteringAttestationHash(attestation);
    if (attestation.attestation_hash !== expectedAttestationHash) {
      errors.push("attestation.attestation_hash does not match canonical signed content");
    }
  } catch (error) {
    errors.push(error.message);
  }
  let issuedAt = null;
  let validFrom = null;
  let expiresAt = null;
  try {
    issuedAt = normalizeIsoInstant(attestation.issued_at, "attestation.issued_at");
    if (issuedAt !== attestation.issued_at) errors.push("attestation.issued_at must be canonical ISO-8601 UTC");
  } catch (error) {
    errors.push(error.message);
  }
  try {
    validFrom = normalizeIsoInstant(attestation.valid_from, "attestation.valid_from");
    if (validFrom !== attestation.valid_from) errors.push("attestation.valid_from must be canonical ISO-8601 UTC");
  } catch (error) {
    errors.push(error.message);
  }
  if (attestation.expires_at !== null && attestation.expires_at !== undefined) {
    try {
      expiresAt = normalizeIsoInstant(attestation.expires_at, "attestation.expires_at");
      if (expiresAt !== attestation.expires_at) errors.push("attestation.expires_at must be canonical ISO-8601 UTC");
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (measurement && issuedAt && issuedAt < measurement.ended_at) {
    errors.push("attestation was issued before the measurement ended");
  }
  if (measurement && issuedAt && issuedAt < measurement.coverage_ended_at) {
    errors.push("attestation was issued before its declared coverage ended");
  }
  if (issuedAt && validFrom && issuedAt < validFrom) errors.push("attestation was issued before valid_from");
  if (issuedAt && expiresAt && issuedAt >= expiresAt) errors.push("attestation was issued at or after expires_at");

  const signature = normalizeSignature(attestation.attestation, errors);
  if (signature && expectedPayloadHash && signature.payload_hash !== expectedPayloadHash) {
    errors.push("attestation signature payload_hash does not match canonical unsigned content");
  }
  if (signature) {
    const trustedKeys = Array.isArray(options.trusted_keys) ? options.trusted_keys : [];
    const matches = trustedKeys.filter((candidate) => candidate?.key_id === signature.key_id);
    if (matches.length !== 1) {
      errors.push(`attestation key_id '${signature.key_id}' does not resolve to exactly one trusted adapter key`);
    } else {
      verifySignature(signature, matches[0], errors);
    }
  }
  return Object.freeze({
    valid: errors.length === 0,
    measurement,
    expected_payload_hash: expectedPayloadHash,
    expected_attestation_hash: expectedAttestationHash,
    errors: Object.freeze(Array.from(new Set(errors))),
  });
}

export function validateMeteringAttestationForReceipt(attestation, receipt, options = {}) {
  requirePlainRecord(receipt, "execution_usage_receipt");
  const integrity = validateMeteringAttestationIntegrity(attestation, options);
  const errors = [...integrity.errors];
  const measurement = integrity.measurement;
  if (measurement) {
    const expected = {
      execution_id: receipt.execution_id,
      budget_id: receipt.budget_id,
      budget_hash: receipt.budget_hash,
      adapter: receipt.source?.adapter,
      usage: receipt.usage,
      metering: receipt.metering,
      cumulative: receipt.source?.aggregation === "cumulative",
      started_at: receipt.started_at,
      ended_at: receipt.ended_at,
      coverage_started_at: measurement.coverage_started_at,
      coverage_ended_at: measurement.coverage_ended_at,
      final_observation_at: measurement.final_observation_at,
      enforcement_hook_receipt_ref: measurement.enforcement_hook_receipt_ref,
      pricing_ref: receipt.pricing_ref,
      evidence: receipt.evidence,
    };
    for (const field of [
      "execution_id", "budget_id", "budget_hash", "adapter", "usage", "metering", "cumulative",
      "started_at", "ended_at", "pricing_ref", "evidence",
    ]) {
      if (computeStableHash(measurement[field]) !== computeStableHash(expected[field])) {
        errors.push(`attested measurement.${field} does not exactly match the execution usage receipt`);
      }
    }
    if (measurement.cumulative !== true) {
      errors.push("exact hard-limit metering requires a cumulative measurement");
    }
  }
  return Object.freeze({
    valid: errors.length === 0,
    measurement,
    errors: Object.freeze(Array.from(new Set(errors))),
  });
}

function normalizeMeasurement(value) {
  requirePlainRecord(value, "metering_attestation.measurement");
  const usage = cloneRecord(value.usage, "metering_attestation.measurement.usage");
  const metering = cloneRecord(value.metering, "metering_attestation.measurement.metering");
  const usageKeys = Object.keys(usage).sort();
  const meteringKeys = Object.keys(metering).sort();
  if (usageKeys.length === 0 || JSON.stringify(usageKeys) !== JSON.stringify(meteringKeys)) {
    throw new DomainValidationError("metering measurement usage and metering must contain the same non-empty metric set");
  }
  for (const [metric, level] of Object.entries(metering)) {
    if (!["exact", "estimated", "unavailable"].includes(level)) {
      throw new DomainValidationError(`metering measurement level for '${metric}' is invalid`);
    }
  }
  const startedAt = normalizeIsoInstant(value.started_at, "metering_attestation.measurement.started_at");
  const endedAt = normalizeIsoInstant(value.ended_at, "metering_attestation.measurement.ended_at");
  const coverageStartedAt = normalizeIsoInstant(
    value.coverage_started_at,
    "metering_attestation.measurement.coverage_started_at",
  );
  const coverageEndedAt = normalizeIsoInstant(
    value.coverage_ended_at,
    "metering_attestation.measurement.coverage_ended_at",
  );
  const finalObservationAt = normalizeIsoInstant(
    value.final_observation_at,
    "metering_attestation.measurement.final_observation_at",
  );
  if (endedAt < startedAt) throw new DomainValidationError("measurement.ended_at must not precede started_at");
  if (coverageStartedAt > startedAt) {
    throw new DomainValidationError("measurement.coverage_started_at must not be later than started_at");
  }
  if (coverageEndedAt < endedAt) {
    throw new DomainValidationError("measurement.coverage_ended_at must not be earlier than ended_at");
  }
  if (finalObservationAt !== endedAt || finalObservationAt > coverageEndedAt) {
    throw new DomainValidationError("measurement.final_observation_at must equal ended_at and fall inside coverage");
  }
  return {
    execution_id: requireNonEmptyString(value.execution_id, "metering_attestation.measurement.execution_id"),
    budget_id: requireNonEmptyString(value.budget_id, "metering_attestation.measurement.budget_id"),
    budget_hash: normalizeSha256(value.budget_hash, "metering_attestation.measurement.budget_hash"),
    adapter: requireNonEmptyString(value.adapter, "metering_attestation.measurement.adapter"),
    usage,
    metering,
    cumulative: value.cumulative === true,
    started_at: startedAt,
    ended_at: endedAt,
    coverage_started_at: coverageStartedAt,
    coverage_ended_at: coverageEndedAt,
    final_observation_at: finalObservationAt,
    enforcement_hook_receipt_ref: normalizeNullableHashedRef(
      value.enforcement_hook_receipt_ref,
      "metering_attestation.measurement.enforcement_hook_receipt_ref",
    ),
    pricing_ref: normalizeNullableRecord(value.pricing_ref, "metering_attestation.measurement.pricing_ref"),
    evidence: normalizeArray(value.evidence, "metering_attestation.measurement.evidence"),
  };
}

function normalizeSignature(value, errors) {
  if (!isPlainRecord(value)) {
    errors.push("attestation.attestation must contain an Ed25519 signature");
    return null;
  }
  const algorithm = value.algorithm;
  const keyId = value.key_id;
  const payloadHash = value.payload_hash;
  const signature = value.signature;
  let valid = true;
  if (algorithm !== "Ed25519") {
    errors.push("attestation signature algorithm must be Ed25519");
    valid = false;
  }
  if (typeof keyId !== "string" || keyId.trim() === "") {
    errors.push("attestation signature key_id is required");
    valid = false;
  }
  if (typeof payloadHash !== "string" || !SHA256_PATTERN.test(payloadHash)) {
    errors.push("attestation signature payload_hash must be a lowercase SHA-256 digest");
    valid = false;
  }
  if (typeof signature !== "string" || !BASE64_PATTERN.test(signature)) {
    errors.push("attestation signature must be canonical base64");
    valid = false;
  }
  if (!valid) return null;
  return { algorithm, key_id: keyId, payload_hash: payloadHash, signature };
}

function verifySignature(signature, trustedKey, errors) {
  if (trustedKey.algorithm !== "Ed25519") {
    errors.push(`trusted adapter key '${signature.key_id}' must use Ed25519`);
    return;
  }
  let publicKey;
  try {
    publicKey = crypto.createPublicKey(trustedKey.public_key);
  } catch (error) {
    errors.push(`trusted adapter key '${signature.key_id}' is invalid: ${error.message}`);
    return;
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    errors.push(`trusted adapter key '${signature.key_id}' is not Ed25519`);
    return;
  }
  const signatureBytes = Buffer.from(signature.signature, "base64");
  if (signatureBytes.length !== 64 || signatureBytes.toString("base64") !== signature.signature) {
    errors.push("attestation signature is not a canonical Ed25519 signature");
    return;
  }
  if (!crypto.verify(null, Buffer.from(signature.payload_hash, "hex"), publicKey, signatureBytes)) {
    errors.push("attestation signature is invalid for the configured trusted adapter key");
  }
}

function normalizeSha256(value, label) {
  const hash = requireNonEmptyString(value, label).toLowerCase();
  if (!SHA256_PATTERN.test(hash)) throw new DomainValidationError(`${label} must be a lowercase SHA-256 digest`);
  return hash;
}

function cloneRecord(value, label) {
  requirePlainRecord(value, label);
  return cloneJson(value);
}

function normalizeNullableRecord(value, label) {
  if (value === undefined || value === null) return null;
  return cloneRecord(value, label);
}

function normalizeArray(value, label) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new DomainValidationError(`${label} must be an array`);
  return cloneJson(value);
}

function normalizeNullableHashedRef(value, label) {
  if (value === undefined || value === null) return null;
  requirePlainRecord(value, label);
  return {
    id: requireNonEmptyString(value.id, `${label}.id`),
    path: requireNonEmptyString(value.path, `${label}.path`),
    hash: normalizeSha256(value.hash, `${label}.hash`),
  };
}
