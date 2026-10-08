import {
  DomainValidationError,
  STABLE_JSON_HASH_ALGORITHM,
  cloneJson,
  computeStableHash,
  immutableJson,
  isPlainRecord,
  normalizeIsoInstant,
  normalizeOptionalString,
  omitKeys,
  requireNonEmptyString,
  requirePlainRecord,
} from "./canonical.mjs";

export const DEFAULT_WARNING_THRESHOLDS_PERCENT = Object.freeze([70, 90]);
export const DEFAULT_COMPLETION_RESERVE_PERCENT = 15;
export const BUDGET_METERING_LEVELS = Object.freeze(["exact", "estimated", "unavailable"]);

const MONEY_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/;

export function normalizeExecutionBudget(input, policy = {}) {
  requirePlainRecord(input, "budget");
  requirePlainRecord(policy, "budget_policy");
  const id = requireNonEmptyString(input.id ?? input.budget_id, "budget.id");
  const limitsInput = requirePlainRecord(input.limits, "budget.limits");
  const limitEntries = Object.entries(limitsInput);
  if (limitEntries.length === 0 && policy.allow_empty_limits !== true) {
    throw new DomainValidationError("budget.limits must contain at least one metric");
  }
  const limits = {};
  for (const [metric, rawSpec] of limitEntries.sort(([left], [right]) => left.localeCompare(right))) {
    if (!/^[a-z][a-z0-9_.-]*$/i.test(metric)) {
      throw new DomainValidationError(`Invalid budget metric '${metric}'`);
    }
    limits[metric] = normalizeLimit(metric, rawSpec, policy);
  }
  const warningThresholds = normalizeWarningThresholds(
    input.warning_thresholds_percent ?? policy.warning_thresholds_percent ?? DEFAULT_WARNING_THRESHOLDS_PERCENT,
  );
  const budget = {
    kind: "execution_budget",
    schema_version: "execution-budget:v1",
    version: Number.isSafeInteger(input.version) && input.version > 0 ? input.version : 1,
    id,
    scope: normalizeBudgetScope(input.scope),
    warning_thresholds_percent: warningThresholds,
    completion_reserve_percent: normalizeCompletionReservePercent(
      input.completion_reserve_percent
        ?? input.extensions?.completion_reserve_percent
        ?? policy.completion_reserve_percent
        ?? DEFAULT_COMPLETION_RESERVE_PERCENT,
    ),
    limits,
    limit_policy: {
      on_warning: normalizeOptionalString(input.limit_policy?.on_warning, "budget.limit_policy.on_warning") || "notify",
      on_soft_limit: normalizeOptionalString(input.limit_policy?.on_soft_limit, "budget.limit_policy.on_soft_limit") || "checkpoint",
      on_hard_limit: normalizeOptionalString(input.limit_policy?.on_hard_limit, "budget.limit_policy.on_hard_limit") || "stop",
      on_metering_violation:
        normalizeOptionalString(input.limit_policy?.on_metering_violation, "budget.limit_policy.on_metering_violation") || "stop",
    },
    extensions: normalizeRecord(input.extensions, "budget.extensions"),
  };
  if (budget.limit_policy.on_hard_limit !== "stop") {
    throw new DomainValidationError("budget.limit_policy.on_hard_limit must be 'stop'");
  }
  const budgetHash = computeExecutionBudgetHash(budget);
  return immutableJson({
    ...budget,
    budget_hash: budgetHash,
    hash_algorithm: STABLE_JSON_HASH_ALGORITHM,
  });
}

export function computeExecutionBudgetHash(budget) {
  requirePlainRecord(budget, "budget");
  return computeStableHash(omitKeys(budget, ["budget_hash", "hash_algorithm"]));
}

export function validateExecutionBudgetIntegrity(budget) {
  const errors = [];
  let expectedHash = null;
  try {
    expectedHash = computeExecutionBudgetHash(budget);
  } catch (error) {
    errors.push(error.message);
  }
  if (budget?.kind !== "execution_budget") {
    errors.push("budget.kind must be 'execution_budget'");
  }
  if (budget?.schema_version !== "execution-budget:v1") {
    errors.push("budget.schema_version must be 'execution-budget:v1'");
  }
  if (budget?.hash_algorithm !== STABLE_JSON_HASH_ALGORITHM) {
    errors.push(`budget.hash_algorithm must be '${STABLE_JSON_HASH_ALGORITHM}'`);
  }
  if (!budget?.budget_hash) {
    errors.push("budget.budget_hash is required");
  } else if (expectedHash && budget.budget_hash !== expectedHash) {
    errors.push("budget.budget_hash does not match canonical budget content");
  }
  try {
    const normalized = normalizeExecutionBudget(budget);
    if (normalized.budget_hash !== budget.budget_hash) {
      errors.push("budget is not in canonical normalized form");
    }
  } catch (error) {
    errors.push(...(error.issues?.length ? error.issues.map((issue) => issue.message || String(issue)) : [error.message]));
  }
  return Object.freeze({
    valid: errors.length === 0,
    actual_hash: budget?.budget_hash || null,
    expected_hash: expectedHash,
    errors: Object.freeze(Array.from(new Set(errors))),
  });
}

export function aggregateBudgetUsage(budget, current = {}, delta = {}) {
  const normalizedBudget = ensureBudget(budget);
  const left = normalizeUsageValues(normalizedBudget, current, "usage.current");
  const right = normalizeUsageValues(normalizedBudget, delta, "usage.delta");
  const result = {};
  for (const [metric, spec] of Object.entries(normalizedBudget.limits)) {
    result[metric] = addQuantity(spec, left[metric], right[metric]);
  }
  return immutableJson(result);
}

export function evaluateBudgetUsage(budget, receipts = [], options = {}) {
  const normalizedBudget = ensureBudget(budget);
  requirePlainRecord(options, "budget_evaluation.options");
  const acceptedReceiptBudgets = [
    normalizedBudget,
    ...normalizeArray(options.accepted_receipt_budgets, "budget_evaluation.options.accepted_receipt_budgets")
      .map((candidate) => ensureBudget(candidate)),
  ];
  const receiptBudgetByHash = new Map(acceptedReceiptBudgets.map((candidate) => [candidate.budget_hash, candidate]));
  const receiptList = receipts === undefined || receipts === null ? [] : Array.isArray(receipts) ? receipts : [receipts];
  let usage = zeroUsage(normalizedBudget);
  const meteringViolations = [];
  for (let index = 0; index < receiptList.length; index += 1) {
    const receipt = requirePlainRecord(receiptList[index], `receipts[${index}]`);
    if (receipt.kind === "execution_usage_receipt") {
      const receiptBudget = receiptBudgetByHash.get(receipt.budget_hash);
      if (!receiptBudget) {
        throw new DomainValidationError(
          `receipts[${index}] references budget hash ${receipt.budget_hash || "missing"} outside the approved budget lineage`,
        );
      }
      const receiptIntegrity = validateExecutionUsageReceipt(receipt, receiptBudget);
      if (!receiptIntegrity.valid) {
        throw new DomainValidationError(
          `receipts[${index}] failed execution usage receipt validation`,
          receiptIntegrity.errors,
        );
      }
    }
    const values = receipt.usage ?? receipt.values ?? receipt;
    if (receipt.source?.aggregation === "cumulative") {
      const cumulativeValues = normalizeReceiptUsageValues(normalizedBudget, values, `receipts[${index}].usage`);
      const nextUsage = { ...usage };
      for (const [metric, value] of Object.entries(cumulativeValues)) {
        const spec = normalizedBudget.limits[metric];
        if (compareQuantity(spec, value, usage[metric]) < 0) {
          throw new DomainValidationError(
            `receipts[${index}] cumulative metric '${metric}' regressed below previously recorded usage`,
          );
        }
        nextUsage[metric] = value;
      }
      usage = immutableJson(nextUsage);
    } else {
      usage = aggregateBudgetUsage(normalizedBudget, usage, values);
    }
    for (const [metric, spec] of Object.entries(normalizedBudget.limits)) {
      if (!Object.hasOwn(values, metric)) {
        continue;
      }
      const declaredMetering = meteringForReceipt(receipt, metric, spec);
      if (spec.hard !== null && declaredMetering !== "exact") {
        meteringViolations.push({
          metric,
          required: "exact",
          actual: declaredMetering || "missing",
          receipt_id: receipt.id || receipt.receipt_id || null,
        });
      }
    }
  }
  return decideBudgetLimits(normalizedBudget, usage, {
    metering_violations: meteringViolations,
    receipt_count: receiptList.length,
  });
}

export function reserveBudget(budget, state = {}, request = {}, metadata = {}) {
  const normalizedBudget = ensureBudget(budget);
  requirePlainRecord(state, "budget_state");
  requirePlainRecord(metadata, "reservation.metadata");
  const reservationId = requireNonEmptyString(metadata.id ?? metadata.reservation_id, "reservation.id");
  const usage = normalizeUsageValues(normalizedBudget, state.usage || {}, "budget_state.usage");
  const reservations = normalizeReservations(normalizedBudget, state.reservations || {});
  const values = normalizeUsageValues(normalizedBudget, request, "reservation.values");
  const requestHash = computeStableHash({
    id: reservationId,
    budget_hash: normalizedBudget.budget_hash,
    values,
  });
  if (reservations[reservationId]) {
    if (reservations[reservationId].request_hash !== requestHash) {
      return immutableJson({
        accepted: false,
        status: "conflict",
        reason: "reservation id is already bound to different values",
        state: { usage, reservations },
        reservation: null,
        decision: decideBudgetLimits(normalizedBudget, aggregateReservedUsage(normalizedBudget, usage, reservations)),
      });
    }
    return immutableJson({
      accepted: true,
      status: "idempotent_replay",
      reason: null,
      state: { usage, reservations },
      reservation: reservations[reservationId],
      decision: decideBudgetLimits(normalizedBudget, aggregateReservedUsage(normalizedBudget, usage, reservations)),
    });
  }
  const reservationBase = {
    id: reservationId,
    budget_hash: normalizedBudget.budget_hash,
    values,
    created_at: metadata.created_at ? normalizeIsoInstant(metadata.created_at, "reservation.created_at") : null,
    source: normalizeRecord(metadata.source, "reservation.source"),
    request_hash: requestHash,
  };
  const reservation = {
    ...reservationBase,
    reservation_hash: computeStableHash(reservationBase),
    hash_algorithm: STABLE_JSON_HASH_ALGORITHM,
  };
  const candidateReservations = { ...reservations, [reservationId]: reservation };
  const projectedUsage = aggregateReservedUsage(normalizedBudget, usage, candidateReservations);
  const decision = decideBudgetLimits(normalizedBudget, projectedUsage);
  if (!decision.allowed_to_start_next) {
    return immutableJson({
      accepted: false,
      status: decision.status,
      reason: ["soft_limit", "completion_reserve"].includes(decision.status)
        ? "reservation requires a budget checkpoint before work can start"
        : "reservation would exceed an enforceable execution boundary",
      state: { usage, reservations },
      reservation: null,
      decision,
    });
  }
  return immutableJson({
    accepted: true,
    status: decision.status === "within_budget" ? "reserved" : decision.status,
    reason: null,
    state: { usage, reservations: candidateReservations },
    reservation,
    decision,
  });
}

export function commitBudgetReservation(budget, state, reservationId, actualUsage) {
  const normalizedBudget = ensureBudget(budget);
  requirePlainRecord(state, "budget_state");
  const id = requireNonEmptyString(reservationId, "reservation.id");
  const reservations = normalizeReservations(normalizedBudget, state.reservations || {});
  if (!reservations[id]) {
    throw new DomainValidationError(`Unknown reservation '${id}'`);
  }
  const usage = aggregateBudgetUsage(normalizedBudget, state.usage || {}, actualUsage);
  const remainingReservations = { ...reservations };
  delete remainingReservations[id];
  const projected = aggregateReservedUsage(normalizedBudget, usage, remainingReservations);
  return immutableJson({
    state: { usage, reservations: remainingReservations },
    committed_reservation: reservations[id],
    decision: decideBudgetLimits(normalizedBudget, projected),
  });
}

export function releaseBudgetReservation(budget, state, reservationId) {
  const normalizedBudget = ensureBudget(budget);
  requirePlainRecord(state, "budget_state");
  const id = requireNonEmptyString(reservationId, "reservation.id");
  const reservations = normalizeReservations(normalizedBudget, state.reservations || {});
  const released = reservations[id] || null;
  const remaining = { ...reservations };
  delete remaining[id];
  const usage = normalizeUsageValues(normalizedBudget, state.usage || {}, "budget_state.usage");
  return immutableJson({
    state: { usage, reservations: remaining },
    released_reservation: released,
    decision: decideBudgetLimits(normalizedBudget, aggregateReservedUsage(normalizedBudget, usage, remaining)),
  });
}

export function buildExecutionUsageReceipt(input) {
  requirePlainRecord(input, "usage_receipt");
  const budget = ensureBudget(input.budget);
  const usage = normalizeReceiptUsageValues(budget, input.usage || {}, "usage_receipt.usage");
  if (Object.keys(usage).length === 0) {
    throw new DomainValidationError("usage_receipt.usage must contain at least one budget metric");
  }
  const metering = {};
  for (const [metric, spec] of Object.entries(budget.limits)) {
    if (!Object.hasOwn(usage, metric)) {
      continue;
    }
    const level = String(input.metering?.[metric] || spec.metering);
    if (!BUDGET_METERING_LEVELS.includes(level)) {
      throw new DomainValidationError(`usage_receipt.metering.${metric} is invalid`);
    }
    metering[metric] = level;
  }
  const startedAt = input.started_at ? normalizeIsoInstant(input.started_at, "usage_receipt.started_at") : null;
  const endedAt = normalizeIsoInstant(input.ended_at ?? input.recorded_at, "usage_receipt.ended_at");
  if (Object.values(metering).includes("exact") && !startedAt) {
    throw new DomainValidationError("usage_receipt.started_at is required for exact cumulative metering");
  }
  if (startedAt && endedAt < startedAt) {
    throw new DomainValidationError("usage_receipt.ended_at must not be earlier than started_at");
  }
  const receipt = {
    kind: "execution_usage_receipt",
    schema_version: "execution-usage-receipt:v1",
    version: 1,
    id: requireNonEmptyString(input.id ?? input.receipt_id, "usage_receipt.id"),
    execution_id: requireNonEmptyString(input.execution_id, "usage_receipt.execution_id"),
    budget_id: budget.id,
    budget_hash: budget.budget_hash,
    usage,
    metering,
    started_at: startedAt,
    ended_at: endedAt,
    source: normalizeUsageReceiptSource(input.source, metering, "usage_receipt.source"),
    pricing_ref: normalizeNullableRecord(input.pricing_ref, "usage_receipt.pricing_ref"),
    evidence: normalizeArray(input.evidence, "usage_receipt.evidence"),
  };
  const receiptHash = computeStableHash(receipt);
  return immutableJson({
    ...receipt,
    receipt_hash: receiptHash,
    hash_algorithm: STABLE_JSON_HASH_ALGORITHM,
  });
}

export function validateExecutionUsageReceipt(receipt, budget) {
  const errors = [];
  let expectedHash = null;
  try {
    expectedHash = computeStableHash(omitKeys(receipt, ["receipt_hash", "hash_algorithm"]));
  } catch (error) {
    errors.push(error.message);
  }
  const normalizedBudget = ensureBudget(budget);
  if (receipt?.kind !== "execution_usage_receipt") {
    errors.push("receipt.kind must be 'execution_usage_receipt'");
  }
  if (receipt?.schema_version !== "execution-usage-receipt:v1") {
    errors.push("receipt.schema_version must be 'execution-usage-receipt:v1'");
  }
  if (receipt?.budget_hash !== normalizedBudget.budget_hash) {
    errors.push("receipt.budget_hash does not match the execution budget");
  }
  if (receipt?.receipt_hash !== expectedHash) {
    errors.push("receipt.receipt_hash does not match canonical receipt content");
  }
  if (receipt?.hash_algorithm !== STABLE_JSON_HASH_ALGORITHM) {
    errors.push(`receipt.hash_algorithm must be '${STABLE_JSON_HASH_ALGORITHM}'`);
  }
  try {
    const normalizedUsage = normalizeReceiptUsageValues(normalizedBudget, receipt?.usage || {}, "receipt.usage");
    if (Object.keys(normalizedUsage).length === 0) {
      errors.push("receipt.usage must contain at least one budget metric");
    }
  } catch (error) {
    errors.push(error.message);
  }
  for (const [metric, spec] of Object.entries(normalizedBudget.limits)) {
    if (!Object.hasOwn(receipt?.usage || {}, metric)) {
      continue;
    }
    const level = receipt?.metering?.[metric];
    if (!BUDGET_METERING_LEVELS.includes(level)) {
      errors.push(`receipt.metering.${metric} must be one of ${BUDGET_METERING_LEVELS.join(", ")}`);
    }
  }
  try {
    normalizeUsageReceiptSource(receipt?.source, receipt?.metering || {}, "receipt.source");
  } catch (error) {
    errors.push(error.message);
  }
  let startedAt = null;
  let endedAt = null;
  if (receipt?.started_at !== null && receipt?.started_at !== undefined) {
    try {
      startedAt = normalizeIsoInstant(receipt.started_at, "receipt.started_at");
      if (startedAt !== receipt.started_at) {
        errors.push("receipt.started_at must be in canonical ISO-8601 UTC form");
      }
    } catch (error) {
      errors.push(error.message);
    }
  }
  try {
    endedAt = normalizeIsoInstant(receipt?.ended_at, "receipt.ended_at");
    if (endedAt !== receipt.ended_at) {
      errors.push("receipt.ended_at must be in canonical ISO-8601 UTC form");
    }
  } catch (error) {
    errors.push(error.message);
  }
  if (startedAt && endedAt && endedAt < startedAt) {
    errors.push("receipt.ended_at must not be earlier than receipt.started_at");
  }
  if (Object.values(receipt?.metering || {}).includes("exact") && !startedAt) {
    errors.push("receipt.started_at is required for exact cumulative metering");
  }
  return Object.freeze({ valid: errors.length === 0, expected_hash: expectedHash, errors: Object.freeze(errors) });
}

export function buildBudgetAmendment(budget, changes, metadata = {}, policy = {}) {
  const baseBudget = ensureBudget(budget);
  requirePlainRecord(changes, "amendment.changes");
  requirePlainRecord(metadata, "amendment.metadata");
  requirePlainRecord(policy, "amendment.policy");
  const changePolicy = { allow_decrease: policy.allow_decrease === true };
  const resultBudget = deriveBudgetAmendmentResult(baseBudget, changes, changePolicy);
  const amendment = {
    kind: "budget_amendment",
    schema_version: "budget-amendment:v1",
    version: 1,
    id: requireNonEmptyString(metadata.id ?? metadata.amendment_id, "amendment.id"),
    base_budget_id: baseBudget.id,
    base_budget_hash: baseBudget.budget_hash,
    changes: cloneJson(changes),
    change_policy: changePolicy,
    result_budget: resultBudget,
    result_budget_hash: resultBudget.budget_hash,
    proposal_ref: normalizeNullableRecord(metadata.proposal_ref, "amendment.proposal_ref"),
    reason: requireNonEmptyString(metadata.reason, "amendment.reason"),
    created_at: normalizeIsoInstant(metadata.created_at, "amendment.created_at"),
    requested_by: normalizeNullableRecord(metadata.requested_by, "amendment.requested_by"),
    approved_by: normalizeNullableRecord(metadata.approved_by, "amendment.approved_by"),
    approval_source: normalizeOptionalString(metadata.approval_source, "amendment.approval_source"),
    approval_evidence: normalizeArray(metadata.approval_evidence, "amendment.approval_evidence"),
    host_approval_receipt_ref: normalizeNullableRecord(
      metadata.host_approval_receipt_ref,
      "amendment.host_approval_receipt_ref",
    ),
    extensions: normalizeRecord(metadata.extensions, "amendment.extensions"),
  };
  const amendmentHash = computeStableHash(amendment);
  return immutableJson({
    ...amendment,
    amendment_hash: amendmentHash,
    hash_algorithm: STABLE_JSON_HASH_ALGORITHM,
  });
}

export function applyBudgetAmendment(budget, amendment) {
  const baseBudget = ensureBudget(budget);
  requirePlainRecord(amendment, "amendment");
  const integrity = validateBudgetAmendmentIntegrity(amendment);
  if (!integrity.valid) {
    throw new DomainValidationError(
      `Budget amendment failed integrity validation: ${integrity.errors.join("; ")}`,
      integrity.errors,
    );
  }
  if (amendment.base_budget_id !== baseBudget.id) {
    throw new DomainValidationError("amendment.base_budget_id does not match the supplied budget");
  }
  if (amendment.base_budget_hash !== baseBudget.budget_hash) {
    throw new DomainValidationError("amendment.base_budget_hash does not match the supplied budget");
  }
  const resultBudget = ensureBudget(amendment.result_budget);
  if (resultBudget.budget_hash !== amendment.result_budget_hash) {
    throw new DomainValidationError("amendment result_budget_hash is invalid");
  }
  const expectedResult = deriveBudgetAmendmentResult(
    baseBudget,
    amendment.changes,
    amendment.change_policy || {},
  );
  if (expectedResult.budget_hash !== resultBudget.budget_hash) {
    throw new DomainValidationError("amendment.result_budget does not match amendment.changes");
  }
  return immutableJson(resultBudget);
}

export function validateBudgetAmendmentIntegrity(amendment) {
  const errors = [];
  if (!isPlainRecord(amendment)) {
    return Object.freeze({
      valid: false,
      expected_hash: null,
      errors: Object.freeze(["amendment must be a plain object"]),
    });
  }
  let expectedHash = null;
  try {
    expectedHash = computeStableHash(omitKeys(amendment, ["amendment_hash", "hash_algorithm"]));
  } catch (error) {
    errors.push(error.message);
  }
  if (amendment.kind !== "budget_amendment") {
    errors.push("amendment.kind must be 'budget_amendment'");
  }
  if (amendment.schema_version !== "budget-amendment:v1") {
    errors.push("amendment.schema_version must be 'budget-amendment:v1'");
  }
  if (amendment.amendment_hash !== expectedHash) {
    errors.push("amendment.amendment_hash does not match canonical amendment content");
  }
  if (amendment.hash_algorithm !== STABLE_JSON_HASH_ALGORITHM) {
    errors.push(`amendment.hash_algorithm must be '${STABLE_JSON_HASH_ALGORITHM}'`);
  }
  if (!isPlainRecord(amendment.change_policy) || typeof amendment.change_policy.allow_decrease !== "boolean") {
    errors.push("amendment.change_policy.allow_decrease must be boolean");
  }
  try {
    const resultBudget = ensureBudget(amendment.result_budget);
    if (resultBudget.budget_hash !== amendment.result_budget_hash) {
      errors.push("amendment.result_budget_hash does not match amendment.result_budget");
    }
  } catch (error) {
    errors.push(error.message);
  }
  try {
    const createdAt = normalizeIsoInstant(amendment.created_at, "amendment.created_at");
    if (createdAt !== amendment.created_at) {
      errors.push("amendment.created_at must be in canonical ISO-8601 UTC form");
    }
  } catch (error) {
    errors.push(error.message);
  }
  return Object.freeze({
    valid: errors.length === 0,
    expected_hash: expectedHash,
    errors: Object.freeze(Array.from(new Set(errors))),
  });
}

export function normalizeMoneyDecimal(value, label = "money") {
  if (typeof value !== "string" || !MONEY_PATTERN.test(value)) {
    throw new DomainValidationError(`${label} must be a non-negative decimal string without exponent notation`);
  }
  const [whole, fraction = ""] = value.split(".");
  const normalizedFraction = fraction.replace(/0+$/, "");
  return normalizedFraction ? `${whole}.${normalizedFraction}` : whole;
}

function deriveBudgetAmendmentResult(baseBudget, changes, policy) {
  requirePlainRecord(changes, "amendment.changes");
  requirePlainRecord(policy, "amendment.change_policy");
  const allowedFields = new Set([
    "limits",
    "warning_thresholds_percent",
    "completion_reserve_percent",
    "limit_policy",
    "extensions",
  ]);
  const changeFields = Object.keys(changes);
  if (changeFields.length === 0) {
    throw new DomainValidationError("amendment.changes must contain at least one change");
  }
  const unknownFields = changeFields.filter((field) => !allowedFields.has(field));
  if (unknownFields.length > 0) {
    throw new DomainValidationError(`amendment.changes contains unsupported field(s): ${unknownFields.join(", ")}`);
  }
  const mergedInput = cloneJson(omitKeys(baseBudget, ["budget_hash", "hash_algorithm"]));
  mergedInput.version = baseBudget.version + 1;
  if (changes.warning_thresholds_percent !== undefined) {
    mergedInput.warning_thresholds_percent = cloneJson(changes.warning_thresholds_percent);
  }
  if (changes.completion_reserve_percent !== undefined) {
    mergedInput.completion_reserve_percent = changes.completion_reserve_percent;
  }
  if (changes.limit_policy !== undefined) {
    requirePlainRecord(changes.limit_policy, "amendment.changes.limit_policy");
    mergedInput.limit_policy = { ...mergedInput.limit_policy, ...cloneJson(changes.limit_policy) };
  }
  if (changes.extensions !== undefined) {
    requirePlainRecord(changes.extensions, "amendment.changes.extensions");
    mergedInput.extensions = { ...mergedInput.extensions, ...cloneJson(changes.extensions) };
  }
  if (changes.limits !== undefined) {
    requirePlainRecord(changes.limits, "amendment.changes.limits");
    if (Object.keys(changes.limits).length === 0) {
      throw new DomainValidationError("amendment.changes.limits must not be empty");
    }
    for (const [metric, patch] of Object.entries(changes.limits)) {
      requirePlainRecord(patch, `amendment.changes.limits.${metric}`);
      if (Object.keys(patch).length === 0) {
        throw new DomainValidationError(`amendment.changes.limits.${metric} must not be empty`);
      }
      mergedInput.limits[metric] = { ...(mergedInput.limits[metric] || {}), ...cloneJson(patch) };
    }
  }
  const resultBudget = normalizeExecutionBudget(mergedInput);
  if (policy.allow_decrease !== true) {
    validateExtensionOnly(baseBudget, resultBudget);
  }
  return resultBudget;
}

function normalizeLimit(metric, rawSpec, policy) {
  requirePlainRecord(rawSpec, `budget.limits.${metric}`);
  const unit = requireNonEmptyString(rawSpec.unit, `budget.limits.${metric}.unit`).toLowerCase();
  const metering = requireNonEmptyString(rawSpec.metering, `budget.limits.${metric}.metering`).toLowerCase();
  if (!BUDGET_METERING_LEVELS.includes(metering)) {
    throw new DomainValidationError(
      `budget.limits.${metric}.metering must be one of ${BUDGET_METERING_LEVELS.join(", ")}`,
    );
  }
  const isMoney = unit === "money" || (rawSpec.currency !== undefined && rawSpec.currency !== null);
  const currency = isMoney ? normalizeCurrency(rawSpec.currency, `budget.limits.${metric}.currency`) : null;
  const soft = rawSpec.soft === undefined || rawSpec.soft === null
    ? null
    : normalizeQuantity({ unit, currency }, rawSpec.soft, `budget.limits.${metric}.soft`);
  const hard = rawSpec.hard === undefined || rawSpec.hard === null
    ? null
    : normalizeQuantity({ unit, currency }, rawSpec.hard, `budget.limits.${metric}.hard`);
  if (soft === null && hard === null) {
    throw new DomainValidationError(`budget.limits.${metric} requires soft or hard`);
  }
  if (soft !== null && hard !== null && compareQuantity({ unit, currency }, soft, hard) >= 0) {
    throw new DomainValidationError(`budget.limits.${metric}.soft must be lower than hard`);
  }
  if (hard !== null && metering !== "exact") {
    throw new DomainValidationError(`budget.limits.${metric}.hard requires exact metering`);
  }
  return {
    unit,
    metering,
    soft,
    hard,
    currency,
  };
}

function normalizeWarningThresholds(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new DomainValidationError("budget.warning_thresholds_percent must be a non-empty array");
  }
  const normalized = Array.from(new Set(value.map((item, index) => {
    const number = Number(item);
    if (!Number.isSafeInteger(number) || number <= 0 || number >= 100) {
      throw new DomainValidationError(`budget.warning_thresholds_percent[${index}] must be an integer from 1 to 99`);
    }
    return number;
  }))).sort((left, right) => left - right);
  return normalized;
}

function normalizeCompletionReservePercent(value) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0 || normalized > 50) {
    throw new DomainValidationError("budget.completion_reserve_percent must be an integer from 0 to 50");
  }
  return normalized;
}

function ensureBudget(budget) {
  if (budget?.kind === "execution_budget" && budget?.budget_hash) {
    const integrity = validateExecutionBudgetIntegrity(budget);
    if (!integrity.valid) {
      throw new DomainValidationError("Execution budget failed integrity validation", integrity.errors);
    }
    return budget;
  }
  return normalizeExecutionBudget(budget);
}

function normalizeUsageValues(budget, input, label) {
  const valuesInput = input?.usage ?? input?.values ?? input;
  requirePlainRecord(valuesInput, label);
  const unknown = Object.keys(valuesInput).filter((metric) => !Object.hasOwn(budget.limits, metric));
  if (unknown.length > 0) {
    throw new DomainValidationError(`${label} contains unknown metric(s): ${unknown.join(", ")}`);
  }
  const result = {};
  for (const [metric, spec] of Object.entries(budget.limits)) {
    result[metric] = Object.hasOwn(valuesInput, metric)
      ? normalizeUsageQuantity(spec, valuesInput[metric], `${label}.${metric}`)
      : zeroQuantity(spec);
  }
  return result;
}

function normalizeReceiptUsageValues(budget, input, label) {
  const valuesInput = input?.usage ?? input?.values ?? input;
  requirePlainRecord(valuesInput, label);
  const normalized = normalizeUsageValues(budget, valuesInput, label);
  return Object.fromEntries(Object.keys(valuesInput).map((metric) => [metric, normalized[metric]]));
}

function normalizeUsageQuantity(spec, rawValue, label) {
  if (spec.currency && isPlainRecord(rawValue)) {
    const currency = normalizeCurrency(rawValue.currency, `${label}.currency`);
    if (currency !== spec.currency) {
      throw new DomainValidationError(`${label}.currency must be ${spec.currency}`);
    }
    return normalizeQuantity(spec, rawValue.amount, `${label}.amount`);
  }
  return normalizeQuantity(spec, rawValue, label);
}

function normalizeQuantity(spec, value, label) {
  if (spec.currency || spec.unit === "money") {
    return normalizeMoneyDecimal(value, label);
  }
  if (typeof value === "string") {
    if (!INTEGER_PATTERN.test(value)) {
      throw new DomainValidationError(`${label} must be a non-negative safe integer`);
    }
    value = Number(value);
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DomainValidationError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function zeroUsage(budget) {
  return Object.fromEntries(Object.entries(budget.limits).map(([metric, spec]) => [metric, zeroQuantity(spec)]));
}

function zeroQuantity(spec) {
  return spec.currency || spec.unit === "money" ? "0" : 0;
}

function addQuantity(spec, left, right) {
  if (spec.currency || spec.unit === "money") {
    return addDecimals(left, right);
  }
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) {
    throw new DomainValidationError(`Usage for unit ${spec.unit} exceeds JavaScript safe integer range`);
  }
  return sum;
}

function compareQuantity(spec, left, right) {
  if (spec.currency || spec.unit === "money") {
    return compareDecimals(left, right);
  }
  return left === right ? 0 : left < right ? -1 : 1;
}

function subtractQuantity(spec, left, right) {
  if (compareQuantity(spec, left, right) <= 0) {
    return zeroQuantity(spec);
  }
  if (spec.currency || spec.unit === "money") {
    return subtractDecimals(left, right);
  }
  return left - right;
}

function decideBudgetLimits(budget, usage, options = {}) {
  const normalizedUsage = normalizeUsageValues(budget, usage, "usage");
  const warnings = [];
  const softLimits = [];
  const hardLimits = [];
  const completionReserveMetrics = [];
  const utilization = {};
  const remaining = {};
  for (const [metric, spec] of Object.entries(budget.limits)) {
    const used = normalizedUsage[metric];
    utilization[metric] = spec.hard === null ? null : utilizationPercent(spec, used, spec.hard);
    remaining[metric] = spec.hard === null ? null : subtractQuantity(spec, spec.hard, used);
    if (spec.hard !== null && compareQuantity(spec, used, spec.hard) >= 0) {
      hardLimits.push({ metric, used, limit: spec.hard, unit: spec.unit, currency: spec.currency });
      continue;
    }
    if (spec.soft !== null && compareQuantity(spec, used, spec.soft) >= 0) {
      softLimits.push({ metric, used, limit: spec.soft, unit: spec.unit, currency: spec.currency });
    }
    if (spec.hard !== null) {
      const reached = budget.warning_thresholds_percent.filter((threshold) => ratioAtLeast(spec, used, spec.hard, threshold));
      if (reached.length > 0) {
        warnings.push({ metric, thresholds_reached_percent: reached, used, hard: spec.hard });
      }
      const reserveStartsAt = 100 - budget.completion_reserve_percent;
      if (budget.completion_reserve_percent > 0 && ratioAtLeast(spec, used, spec.hard, reserveStartsAt)) {
        completionReserveMetrics.push({
          metric,
          used,
          hard: spec.hard,
          remaining: remaining[metric],
          reserve_starts_at_percent: reserveStartsAt,
        });
      }
    }
  }
  const meteringViolations = options.metering_violations || [];
  const status = hardLimits.length > 0
    ? "hard_limit"
    : meteringViolations.length > 0
      ? "metering_violation"
      : softLimits.length > 0
        ? "soft_limit"
        : completionReserveMetrics.length > 0
          ? "completion_reserve"
          : warnings.length > 0
            ? "warning"
            : "within_budget";
  return immutableJson({
    status,
    allowed_to_start_next: !["hard_limit", "metering_violation", "soft_limit", "completion_reserve"].includes(status),
    allowed_for_completion_only: status === "completion_reserve",
    requires_checkpoint: ["soft_limit", "completion_reserve"].includes(status),
    usage: normalizedUsage,
    utilization_percent: utilization,
    remaining,
    warnings,
    completion_reserve: {
      percent: budget.completion_reserve_percent,
      active: completionReserveMetrics.length > 0,
      metrics: completionReserveMetrics,
    },
    soft_limits: softLimits,
    hard_limits: hardLimits,
    metering_violations: meteringViolations,
    receipt_count: options.receipt_count ?? null,
  });
}

function normalizeBudgetScope(value) {
  if (value === undefined || value === null) {
    return "execution_tree";
  }
  if (typeof value === "string") {
    return requireNonEmptyString(value, "budget.scope");
  }
  requirePlainRecord(value, "budget.scope");
  return cloneJson(value);
}

function normalizeReservations(budget, reservations) {
  requirePlainRecord(reservations, "budget_state.reservations");
  const result = {};
  for (const [id, reservation] of Object.entries(reservations)) {
    requirePlainRecord(reservation, `budget_state.reservations.${id}`);
    const normalized = {
      ...cloneJson(reservation),
      values: normalizeUsageValues(budget, reservation.values || {}, `budget_state.reservations.${id}.values`),
    };
    if (normalized.id !== id) {
      throw new DomainValidationError(`budget_state.reservations.${id}.id must match its map key`);
    }
    if (normalized.budget_hash !== budget.budget_hash) {
      throw new DomainValidationError(`budget_state.reservations.${id}.budget_hash does not match the budget`);
    }
    const expectedRequestHash = computeStableHash({ id, budget_hash: budget.budget_hash, values: normalized.values });
    if (normalized.request_hash !== expectedRequestHash) {
      throw new DomainValidationError(`budget_state.reservations.${id}.request_hash is invalid`);
    }
    const expectedReservationHash = computeStableHash(
      omitKeys(normalized, ["reservation_hash", "hash_algorithm"]),
    );
    if (normalized.reservation_hash !== expectedReservationHash) {
      throw new DomainValidationError(`budget_state.reservations.${id}.reservation_hash is invalid`);
    }
    if (normalized.hash_algorithm !== STABLE_JSON_HASH_ALGORITHM) {
      throw new DomainValidationError(`budget_state.reservations.${id}.hash_algorithm is invalid`);
    }
    result[id] = normalized;
  }
  return result;
}

function aggregateReservedUsage(budget, usage, reservations) {
  let result = normalizeUsageValues(budget, usage, "budget_state.usage");
  for (const reservation of Object.values(reservations)) {
    result = aggregateBudgetUsage(budget, result, reservation.values);
  }
  return result;
}

function meteringForReceipt(receipt, metric, spec) {
  if (typeof receipt.metering === "string") {
    return receipt.metering;
  }
  if (isPlainRecord(receipt.metering) && receipt.metering[metric]) {
    return String(receipt.metering[metric]);
  }
  return null;
}

function validateExtensionOnly(baseBudget, resultBudget) {
  if (resultBudget.extensions?.exact_metering_policy_hash !== baseBudget.extensions?.exact_metering_policy_hash) {
    throw new DomainValidationError(
      "Budget amendment cannot change the approved exact_metering policy hash; prepare and approve a new proposal instead",
    );
  }
  if (resultBudget.completion_reserve_percent < baseBudget.completion_reserve_percent) {
    throw new DomainValidationError("Budget amendment cannot lower completion_reserve_percent");
  }
  for (const [metric, baseSpec] of Object.entries(baseBudget.limits)) {
    const nextSpec = resultBudget.limits[metric];
    if (!nextSpec) {
      throw new DomainValidationError(`Budget amendment cannot remove metric '${metric}'`);
    }
    if (baseSpec.unit !== nextSpec.unit || baseSpec.currency !== nextSpec.currency) {
      throw new DomainValidationError(`Budget amendment cannot change unit or currency for '${metric}'`);
    }
    if (baseSpec.hard !== null && (nextSpec.hard === null || compareQuantity(baseSpec, nextSpec.hard, baseSpec.hard) < 0)) {
      throw new DomainValidationError(`Budget amendment cannot lower hard limit '${metric}'`);
    }
    if (baseSpec.soft !== null && (nextSpec.soft === null || compareQuantity(baseSpec, nextSpec.soft, baseSpec.soft) < 0)) {
      throw new DomainValidationError(`Budget amendment cannot lower soft limit '${metric}'`);
    }
  }
}

function normalizeUsageReceiptSource(value, metering, label) {
  const source = normalizeRecord(value, label);
  const adapter = requireNonEmptyString(source.adapter, `${label}.adapter`);
  const assurance = requireNonEmptyString(source.assurance, `${label}.assurance`);
  if (!["manual_declared", "advisory_observed", "trusted_attested"].includes(assurance)) {
    throw new DomainValidationError(`${label}.assurance must be 'manual_declared', 'advisory_observed', or 'trusted_attested'`);
  }
  const attestationRef = normalizeNullableRecord(source.attestation_ref, `${label}.attestation_ref`);
  const aggregation = requireNonEmptyString(source.aggregation ?? "delta", `${label}.aggregation`).toLowerCase();
  if (!['delta', 'cumulative'].includes(aggregation)) {
    throw new DomainValidationError(`${label}.aggregation must be 'delta' or 'cumulative'`);
  }
  const exactMetrics = Object.entries(metering || {})
    .filter(([, level]) => level === "exact")
    .map(([metric]) => metric);
  if (exactMetrics.length > 0 && assurance !== "trusted_attested") {
    throw new DomainValidationError(
      `${label}.assurance must be 'trusted_attested' when exact metering is declared (${exactMetrics.join(", ")})`,
    );
  }
  if (aggregation === "cumulative" && assurance !== "trusted_attested") {
    throw new DomainValidationError(
      `${label}.aggregation 'cumulative' requires trusted_attested assurance; manual or advisory observations must be recorded as 'delta'`,
    );
  }
  if (exactMetrics.length > 0 && aggregation !== "cumulative") {
    throw new DomainValidationError(
      `${label}.aggregation must be 'cumulative' when exact hard-limit metering is declared (${exactMetrics.join(", ")})`,
    );
  }
  if (assurance === "trusted_attested") {
    if (!attestationRef) {
      throw new DomainValidationError(`${label}.attestation_ref is required for trusted-attested metering`);
    }
    requireNonEmptyString(attestationRef.id, `${label}.attestation_ref.id`);
    requireNonEmptyString(attestationRef.path, `${label}.attestation_ref.path`);
    const hash = requireNonEmptyString(attestationRef.hash, `${label}.attestation_ref.hash`);
    if (!/^[a-f0-9]{64}$/.test(hash)) {
      throw new DomainValidationError(`${label}.attestation_ref.hash must be a lowercase SHA-256 digest`);
    }
  }
  return {
    ...source,
    adapter,
    assurance,
    aggregation,
    attestation_ref: attestationRef,
  };
}

function normalizeCurrency(value, label) {
  const currency = requireNonEmptyString(value, label).toUpperCase();
  if (!/^[A-Z][A-Z0-9]{2,7}$/.test(currency)) {
    throw new DomainValidationError(`${label} must be a 3-8 character currency or billing-unit code`);
  }
  return currency;
}

function normalizeRecord(value, label) {
  if (value === undefined || value === null) {
    return {};
  }
  requirePlainRecord(value, label);
  return cloneJson(value);
}

function normalizeNullableRecord(value, label) {
  if (value === undefined || value === null) {
    return null;
  }
  return normalizeRecord(value, label);
}

function normalizeArray(value, label) {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new DomainValidationError(`${label} must be an array`);
  }
  return cloneJson(value);
}

function addDecimals(left, right) {
  const [leftInt, rightInt, scale] = alignDecimals(left, right);
  return decimalFromScaledInteger(leftInt + rightInt, scale);
}

function subtractDecimals(left, right) {
  const [leftInt, rightInt, scale] = alignDecimals(left, right);
  if (leftInt < rightInt) {
    throw new DomainValidationError("Decimal subtraction would be negative");
  }
  return decimalFromScaledInteger(leftInt - rightInt, scale);
}

function compareDecimals(left, right) {
  const [leftInt, rightInt] = alignDecimals(left, right);
  return leftInt === rightInt ? 0 : leftInt < rightInt ? -1 : 1;
}

function alignDecimals(left, right) {
  const leftParts = decimalParts(normalizeMoneyDecimal(String(left)));
  const rightParts = decimalParts(normalizeMoneyDecimal(String(right)));
  const scale = Math.max(leftParts.scale, rightParts.scale);
  const leftInt = leftParts.integer * 10n ** BigInt(scale - leftParts.scale);
  const rightInt = rightParts.integer * 10n ** BigInt(scale - rightParts.scale);
  return [leftInt, rightInt, scale];
}

function decimalParts(value) {
  const [whole, fraction = ""] = value.split(".");
  return { integer: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

function decimalFromScaledInteger(value, scale) {
  if (scale === 0) {
    return value.toString();
  }
  const raw = value.toString().padStart(scale + 1, "0");
  const whole = raw.slice(0, -scale);
  const fraction = raw.slice(-scale).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function ratioAtLeast(spec, value, hard, threshold) {
  if (spec.currency || spec.unit === "money") {
    const [valueInt, hardInt] = alignDecimals(value, hard);
    return valueInt * 100n >= hardInt * BigInt(threshold);
  }
  return BigInt(value) * 100n >= BigInt(hard) * BigInt(threshold);
}

function utilizationPercent(spec, value, hard) {
  if (compareQuantity(spec, hard, zeroQuantity(spec)) === 0) {
    return compareQuantity(spec, value, zeroQuantity(spec)) === 0 ? "0" : "unbounded";
  }
  let valueInt;
  let hardInt;
  if (spec.currency || spec.unit === "money") {
    [valueInt, hardInt] = alignDecimals(value, hard);
  } else {
    valueInt = BigInt(value);
    hardInt = BigInt(hard);
  }
  const basisPoints = (valueInt * 10000n) / hardInt;
  return decimalFromScaledInteger(basisPoints, 2);
}
