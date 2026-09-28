import { Date } from "./runtime/host.mjs";
import {
  DomainValidationError,
  STABLE_JSON_HASH_ALGORITHM,
  computeStableHash,
  immutableJson,
  requireNonEmptyString,
  requirePlainRecord,
} from "./canonical.mjs";

export const CONTEXT_OPTIMIZATION_OBSERVATION_SCHEMA_VERSION = "context-optimization-observation:v1";

const PHASES = new Set(["apply", "checkpoint", "complete", "manual"]);

export function buildContextOptimizationObservation(input) {
  requirePlainRecord(input, "context_optimization_observation_input");
  const telemetry = requirePlainRecord(input.telemetry, "context_optimization_observation_input.telemetry");
  if (telemetry.status !== "operational" || !telemetry.savings) {
    throw new DomainValidationError("Operational RTK telemetry is required to build an optimization observation");
  }
  const phase = requireNonEmptyString(input.phase, "context_optimization_observation_input.phase");
  if (!PHASES.has(phase)) {
    throw new DomainValidationError(`Unsupported context optimization phase '${phase}'`);
  }
  const previous = input.previous ?? null;
  if (previous !== null) {
    const validation = validateContextOptimizationObservation(previous);
    if (!validation.valid) {
      throw new DomainValidationError("Previous context optimization observation is invalid", validation.errors);
    }
  }
  const counters = normalizeCounters(telemetry.savings);
  const observedAt = normalizeIsoInstant(input.observed_at, "context_optimization_observation_input.observed_at");
  const executionId = requireNonEmptyString(input.execution_id, "context_optimization_observation_input.execution_id");
  const proposalHash = requireHash(input.proposal_hash, "context_optimization_observation_input.proposal_hash");
  const projectScopeHash = requireHash(input.project_scope_hash, "context_optimization_observation_input.project_scope_hash");
  const providerId = requireNonEmptyString(telemetry.provider, "context_optimization_observation_input.telemetry.provider");
  const providerVersion = requireNonEmptyString(telemetry.detection?.version, "context_optimization_observation_input.telemetry.detection.version");
  if (previous && (
    previous.execution_id !== executionId ||
    previous.proposal_hash !== proposalHash ||
    previous.provider?.id !== providerId
  )) {
    throw new DomainValidationError("Previous context optimization observation belongs to a different execution, proposal, or provider");
  }
  const delta = buildDelta(previous, counters, providerVersion, projectScopeHash);
  const observation = {
    kind: "context_optimization_observation",
    schema_version: CONTEXT_OPTIMIZATION_OBSERVATION_SCHEMA_VERSION,
    id: requireNonEmptyString(input.id, "context_optimization_observation_input.id"),
    execution_id: executionId,
    proposal_hash: proposalHash,
    phase,
    observed_at: observedAt,
    provider: {
      id: providerId,
      version: providerVersion,
      contract: telemetry.detection.gain_contract,
    },
    scope: {
      type: "project_root",
      project_scope_hash: projectScopeHash,
    },
    counters,
    delta,
    assurance: {
      classification: "advisory_estimated",
      trusted_exact: false,
    },
    budget_effect: {
      usage_adjustment_applied: 0,
      gate_override: false,
    },
    source: normalizeTelemetrySource(telemetry.source),
    previous_observation_ref: previous ? {
      id: previous.id,
      hash: previous.observation_hash,
    } : null,
  };
  observation.observation_hash = computeStableHash(observation);
  observation.hash_algorithm = STABLE_JSON_HASH_ALGORITHM;
  return immutableJson(observation);
}

export function validateContextOptimizationObservation(value) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, errors: ["observation must be an object"] };
  }
  if (value.kind !== "context_optimization_observation") errors.push("kind must be context_optimization_observation");
  if (value.schema_version !== CONTEXT_OPTIMIZATION_OBSERVATION_SCHEMA_VERSION) errors.push(`schema_version must be ${CONTEXT_OPTIMIZATION_OBSERVATION_SCHEMA_VERSION}`);
  if (!PHASES.has(value.phase)) errors.push("phase is unsupported");
  if (value.assurance?.classification !== "advisory_estimated" || value.assurance?.trusted_exact !== false) errors.push("assurance must remain advisory_estimated and not trusted_exact");
  if (value.budget_effect?.usage_adjustment_applied !== 0 || value.budget_effect?.gate_override !== false) errors.push("budget effect must not adjust usage or override the gate");
  if (!/^[a-f0-9]{64}$/u.test(value.source?.report_hash || "")) errors.push("source.report_hash must be a lowercase SHA-256 hash");
  if (value.hash_algorithm !== STABLE_JSON_HASH_ALGORITHM) errors.push(`hash_algorithm must be ${STABLE_JSON_HASH_ALGORITHM}`);
  const { observation_hash: storedHash, hash_algorithm: _algorithm, ...hashSubject } = value;
  const expectedHash = computeStableHash(hashSubject);
  if (!storedHash || storedHash !== expectedHash) errors.push("observation_hash does not match canonical content");
  return { valid: errors.length === 0, expected_hash: expectedHash, errors };
}

export function validateContextOptimizationLineage(observations) {
  if (!Array.isArray(observations)) {
    return { valid: false, errors: ["context optimization lineage must be an array"], ordered: [] };
  }
  const errors = [];
  const seenIds = new Set();
  const seenHashes = new Set();
  const successors = new Map();
  const roots = [];
  for (let index = 0; index < observations.length; index += 1) {
    const observation = observations[index];
    const validation = validateContextOptimizationObservation(observation);
    errors.push(...validation.errors.map((error) => `observation ${observation?.id || index}: ${error}`));
    if (seenIds.has(observation?.id)) errors.push(`observation id ${observation.id} appears more than once`);
    if (seenHashes.has(observation?.observation_hash)) errors.push(`observation hash ${observation.observation_hash} appears more than once`);
    seenIds.add(observation?.id);
    seenHashes.add(observation?.observation_hash);
    const previousHash = observation?.previous_observation_ref?.hash || null;
    if (previousHash === null) {
      roots.push(observation);
    } else {
      const candidates = successors.get(previousHash) || [];
      candidates.push(observation);
      successors.set(previousHash, candidates);
    }
  }
  if (observations.length > 0 && roots.length !== 1) {
    errors.push(`context optimization lineage must have exactly one baseline root; found ${roots.length}`);
  }
  const ordered = [];
  const visited = new Set();
  let current = roots[0] || null;
  while (current && !visited.has(current.observation_hash)) {
    ordered.push(current);
    visited.add(current.observation_hash);
    const candidates = successors.get(current.observation_hash) || [];
    if (candidates.length > 1) {
      errors.push(`observation ${current.id} has ${candidates.length} successors; lineage must not fork`);
    }
    current = candidates[0] || null;
  }
  if (current) errors.push(`context optimization lineage contains a cycle at ${current.id}`);
  if (ordered.length !== observations.length) {
    errors.push(`context optimization lineage connects ${ordered.length} of ${observations.length} observations`);
  }
  const applyIndexes = ordered.flatMap((observation, index) => observation.phase === "apply" ? [index] : []);
  const completeIndexes = ordered.flatMap((observation, index) => observation.phase === "complete" ? [index] : []);
  if (applyIndexes.length > 1 || (applyIndexes.length === 1 && applyIndexes[0] !== 0)) {
    errors.push("apply optimization observation must appear at most once and at the lineage root");
  }
  if (completeIndexes.length > 1 || (completeIndexes.length === 1 && completeIndexes[0] !== ordered.length - 1)) {
    errors.push("complete optimization observation must appear at most once and at the lineage tail");
  }
  for (let index = 0; index < ordered.length; index += 1) {
    const observation = ordered[index];
    const previous = index === 0 ? null : ordered[index - 1];
    if (!previous) {
      if (observation?.previous_observation_ref !== null) errors.push(`first observation ${observation?.id || index} must not reference a predecessor`);
      if (observation?.delta?.status !== "baseline") errors.push(`first observation ${observation?.id || index} must establish a baseline`);
      try {
        const expectedBaseline = buildDelta(
          null,
          observation?.counters || {},
          observation?.provider?.version,
          observation?.scope?.project_scope_hash,
        );
        if (computeStableHash(expectedBaseline) !== computeStableHash(observation?.delta || {})) {
          errors.push(`first observation ${observation?.id || index} baseline delta must contain only zero counters`);
        }
      } catch (error) {
        errors.push(`first observation ${observation?.id || index} baseline delta cannot be recomputed: ${error.message}`);
      }
      continue;
    }
    if (
      observation?.previous_observation_ref?.id !== previous.id ||
      observation?.previous_observation_ref?.hash !== previous.observation_hash
    ) {
      errors.push(`observation ${observation?.id || index} does not reference its immediate predecessor`);
    }
    if (observation?.execution_id !== ordered[0]?.execution_id || observation?.proposal_hash !== ordered[0]?.proposal_hash) {
      errors.push(`observation ${observation?.id || index} changes execution or proposal lineage`);
    }
    if (observation?.provider?.id !== ordered[0]?.provider?.id) {
      errors.push(`observation ${observation?.id || index} changes optimization provider id`);
    }
    if (Date.parse(observation.observed_at) < Date.parse(previous.observed_at)) {
      errors.push(`observation ${observation?.id || index} predates its predecessor`);
    }
    try {
      const expectedDelta = buildDelta(
        previous,
        observation?.counters || {},
        observation?.provider?.version,
        observation?.scope?.project_scope_hash,
      );
      if (computeStableHash(expectedDelta) !== computeStableHash(observation?.delta || {})) {
        errors.push(`observation ${observation?.id || index} delta does not match its predecessor counters`);
      }
    } catch (error) {
      errors.push(`observation ${observation?.id || index} delta cannot be recomputed: ${error.message}`);
    }
  }
  return { valid: errors.length === 0, errors: Array.from(new Set(errors)), ordered };
}

export function calculateContextOptimizationDelta(baseline, current) {
  const baselineValidation = validateContextOptimizationObservation(baseline);
  const currentValidation = validateContextOptimizationObservation(current);
  if (!baselineValidation.valid || !currentValidation.valid) {
    throw new DomainValidationError("Context optimization delta requires two valid observations", [
      ...baselineValidation.errors,
      ...currentValidation.errors,
    ]);
  }
  if (
    baseline.execution_id !== current.execution_id ||
    baseline.proposal_hash !== current.proposal_hash ||
    baseline.provider.id !== current.provider.id
  ) {
    throw new DomainValidationError("Context optimization delta observations must share execution, proposal, and provider");
  }
  return immutableJson(buildDelta(
    baseline,
    current.counters,
    current.provider.version,
    current.scope.project_scope_hash,
  ));
}

export function buildContextOptimizationLineageDelta(observations) {
  const lineage = validateContextOptimizationLineage(observations);
  if (!lineage.valid) {
    throw new DomainValidationError("Context optimization lineage delta requires a valid lineage", lineage.errors);
  }
  const baseline = lineage.ordered.find((observation) => observation.phase === "apply") || null;
  const latest = lineage.ordered.at(-1) || null;
  if (!baseline || !latest) {
    return immutableJson({
      status: "apply_baseline_unavailable",
      assurance: "advisory_estimated",
      usage_adjustment_applied: 0,
      baseline_ref: null,
      latest_ref: latest ? { id: latest.id, hash: latest.observation_hash } : null,
      delta: null,
      discontinuities: [],
    });
  }
  const baselineIndex = lineage.ordered.indexOf(baseline);
  const discontinuities = lineage.ordered
    .slice(baselineIndex + 1)
    .filter((observation) => observation.delta?.status !== "measured")
    .map((observation) => ({
      id: observation.id,
      hash: observation.observation_hash,
      status: observation.delta?.status || "unknown",
    }));
  if (discontinuities.length > 0) {
    return immutableJson({
      status: "discontinuous",
      assurance: "advisory_estimated",
      usage_adjustment_applied: 0,
      baseline_ref: { id: baseline.id, hash: baseline.observation_hash },
      latest_ref: { id: latest.id, hash: latest.observation_hash },
      delta: null,
      discontinuities,
    });
  }
  const delta = calculateContextOptimizationDelta(baseline, latest);
  return immutableJson({
    status: delta.status === "measured" ? "measured" : delta.status,
    assurance: "advisory_estimated",
    usage_adjustment_applied: 0,
    baseline_ref: { id: baseline.id, hash: baseline.observation_hash },
    latest_ref: { id: latest.id, hash: latest.observation_hash },
    delta,
    discontinuities: [],
  });
}

export function optimizationBudgetAdvisory(decision, telemetry, latestObservation = null, options = {}) {
  requirePlainRecord(decision, "budget_decision");
  requirePlainRecord(options, "optimization_advisory_options");
  const configuredTriggers = options.trigger_statuses ?? ["warning", "soft_limit", "completion_reserve"];
  if (!Array.isArray(configuredTriggers) || configuredTriggers.some((status) => typeof status !== "string" || status.trim() === "")) {
    throw new DomainValidationError("optimization_advisory_options.trigger_statuses must be an array of non-empty strings");
  }
  const triggerStatuses = new Set(configuredTriggers);
  const operational = telemetry?.status === "operational";
  const stopStatus = ["hard_limit", "metering_violation"].includes(decision.status);
  const pressureStatus = triggerStatuses.has(decision.status);
  const action = stopStatus
    ? "stop_per_budget_gate"
    : decision.allowed_for_completion_only === true
      ? "completion_only"
      : decision.allowed_to_start_next === false
        ? "checkpoint_required_stop"
        : operational
          ? pressureStatus ? "maximize_rtk_for_supported_commands" : "use_rtk_for_supported_commands"
          : "native_fallback";
  return immutableJson({
    provider: telemetry?.provider || "rtk",
    provider_status: telemetry?.status || "unavailable",
    triggered_by_budget_status: pressureStatus ? decision.status : null,
    action,
    usage_adjustment_applied: 0,
    gate_override: false,
    latest_observation_ref: latestObservation ? {
      id: latestObservation.id,
      hash: latestObservation.observation_hash,
      phase: latestObservation.phase,
    } : null,
  });
}

function normalizeTelemetrySource(value) {
  const source = requirePlainRecord(value, "context_optimization_observation_input.telemetry.source");
  if (!Array.isArray(source.command) || source.command.length === 0) {
    throw new DomainValidationError("context optimization telemetry source.command must be a non-empty array");
  }
  if (source.shell !== false) {
    throw new DomainValidationError("context optimization telemetry must be collected without a shell");
  }
  const reportHash = requireHash(source.report_hash, "context_optimization_observation_input.telemetry.source.report_hash");
  return {
    command: source.command.map((item, index) => requireNonEmptyString(item, `context_optimization_observation_input.telemetry.source.command[${index}]`)),
    shell: false,
    report_hash: reportHash,
  };
}

function normalizeCounters(savings) {
  const mappings = [
    ["total_commands", "total_commands"],
    ["estimated_command_output_tokens_before", "estimated_input_tokens"],
    ["estimated_command_output_tokens_after", "estimated_output_tokens"],
    ["estimated_tokens_avoided", "estimated_tokens_avoided"],
  ];
  const counters = {};
  for (const [targetField, sourceField] of mappings) {
    const value = savings[sourceField];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new DomainValidationError(`context optimization counter '${sourceField}' must be a non-negative safe integer`);
    }
    counters[targetField] = value;
  }
  const percent = savings.estimated_savings_percent;
  if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new DomainValidationError("context optimization savings percent must be between 0 and 100");
  }
  counters.estimated_savings_percent = percent;
  return counters;
}

function buildDelta(previous, counters, providerVersion, projectScopeHash) {
  if (!previous) {
    return { status: "baseline", commands: 0, estimated_command_output_tokens_before: 0, estimated_command_output_tokens_after: 0, estimated_tokens_avoided: 0 };
  }
  if (previous.provider?.version !== providerVersion) {
    return { status: "provider_version_changed", commands: null, estimated_command_output_tokens_before: null, estimated_command_output_tokens_after: null, estimated_tokens_avoided: null };
  }
  if (previous.scope?.project_scope_hash !== projectScopeHash) {
    return { status: "scope_changed", commands: null, estimated_command_output_tokens_before: null, estimated_command_output_tokens_after: null, estimated_tokens_avoided: null };
  }
  const mappings = [
    ["commands", "total_commands"],
    ["estimated_command_output_tokens_before", "estimated_command_output_tokens_before"],
    ["estimated_command_output_tokens_after", "estimated_command_output_tokens_after"],
    ["estimated_tokens_avoided", "estimated_tokens_avoided"],
  ];
  if (mappings.some(([, field]) => counters[field] < previous.counters[field])) {
    return { status: "counter_reset", commands: null, estimated_command_output_tokens_before: null, estimated_command_output_tokens_after: null, estimated_tokens_avoided: null };
  }
  return Object.fromEntries([
    ["status", "measured"],
    ...mappings.map(([outputField, counterField]) => [outputField, counters[counterField] - previous.counters[counterField]]),
  ]);
}


function requireHash(value, label) {
  const hash = requireNonEmptyString(value, label);
  if (!/^[a-f0-9]{64}$/u.test(hash)) throw new DomainValidationError(`${label} must be a lowercase SHA-256 hash`);
  return hash;
}

function normalizeIsoInstant(value, label) {
  const raw = requireNonEmptyString(value, label);
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp) || !/^\d{4}-\d{2}-\d{2}T/u.test(raw)) {
    throw new DomainValidationError(`${label} must be an ISO-8601 instant`);
  }
  return new Date(timestamp).toISOString();
}
