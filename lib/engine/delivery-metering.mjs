import path from "node:path";
import {
  UserError,
  fail,
} from "../cli/user-error.mjs";
import {
  DELIVERY_METER_METRICS,
  canonicalAmount,
  deriveDeliveryLeadTime,
  describeDeliveryLeadTime,
  describeDeliveryUsage,
  summarizeDeliveryUsage,
} from "../delivery-metrics.mjs";
import {
  DELIVERY_METER_PLAN_SCOPE_KIND,
  buildExecutionUsageReceipt,
  evaluateBudgetUsage,
  normalizeExecutionBudget,
  validateExecutionBudgetIntegrity,
  validateExecutionUsageReceipt,
} from "../execution-budget.mjs";
import {
  getOptionString,
  normalizeId,
  normalizeRawListOption,
  shortHashFull,
  stableJson,
} from "../lifecycle/common.mjs";
import {
  humanGuidanceLocale,
} from "../lifecycle/guidance.mjs";
import {
  autonomyRoot,
  collectBudgetMeterSnapshot,
  exactMeteringMetrics,
  isInsidePath,
  resolveBudgetMeterMapping,
  toProjectPath,
} from "../lifecycle/project.mjs";
import {
  fs,
} from "../runtime/host.mjs";
import {
  budgetMeterAdapter,
  budgetMetricFlagHint,
  buildUsageLedger,
  describeValidationError,
  inspectExactMeteringSource,
  recordBudgetMeter,
  recordBudgetUsage,
  showBudgetStatus,
  sortUsageReceipts,
  startBudgetMeter,
  usageFromMetricFlags,
  writeImmutableMeterRecord,
} from "./assessment.mjs";
import {
  assertRecordSchema,
  buildAttribution,
  loadOptionalJsonInput,
  now,
  uniqueRecordSuffix,
  validateRecordSchema,
} from "./common.mjs";
import {
  BUILT_IN_BUDGET_METER_ADAPTERS,
} from "./definitions.mjs";
import {
  allDeliveryActionReceipts,
  currentDeliveryExecutionState,
  effectiveDeliveryProfileStatus,
  readDeliveryAutonomyProfile,
} from "./delivery.mjs";
import {
  ensureInitialized,
} from "./migration.mjs";
import {
  output,
} from "./output.mjs";
import {
  resolveProjectFilePath,
} from "./project.mjs";
import {
  acquireFileLock,
  readProjectJson,
  safeReadDir,
  writeJsonFile,
} from "./storage.mjs";

/**
 * Usage metering for deliveries. A delivery's usage receipts are bound to a
 * delivery meter plan: an execution budget whose metrics are measured, never
 * limited. Receipts, the hash-chained ledger, the meter baselines, snapshots,
 * and deltas follow the same rules as an assessment's budget history: every
 * new receipt is validated against the recorded history before it is written,
 * the ledger detects a removed or edited receipt, and exact values need a
 * trusted signed source.
 */

const LEDGER_FILE = "ledger.json";
const LEDGER_SCHEMA = "delivery-usage-ledger.schema.json";
const BASELINE_KIND = "delivery_meter_baseline";
const BASELINE_SCHEMA_VERSION = "delivery-meter-baseline:v1";
const HASH_ALGORITHM = "sha256:stable-json:v1";

function builtInMeterAdapter(adapterId) {
  const id = String(adapterId || "");
  return Object.hasOwn(BUILT_IN_BUDGET_METER_ADAPTERS, id) ? BUILT_IN_BUDGET_METER_ADAPTERS[id] : null;
}

export function deliveryMeteringRoot(context, profileId) {
  return path.join(autonomyRoot(context), "metering", normalizeId(profileId));
}

function plansRoot(context, profileId) {
  return path.join(deliveryMeteringRoot(context, profileId), "plans");
}

function usageRoot(context, profileId) {
  return path.join(deliveryMeteringRoot(context, profileId), "usage");
}

function ledgerPath(context, profileId) {
  return path.join(deliveryMeteringRoot(context, profileId), LEDGER_FILE);
}

function meteringLockPath(context, profileId) {
  return path.join(deliveryMeteringRoot(context, profileId), "mutation.lock");
}

function meterRoot(context, profileId, adapterId) {
  return path.join(deliveryMeteringRoot(context, profileId), "meters", normalizeId(adapterId));
}

function baselinePath(context, profileId, adapterId, baselineId) {
  return path.join(meterRoot(context, profileId, adapterId), "baselines", `${normalizeId(baselineId)}.json`);
}

/**
 * The meter plan of one delivery: every standard metric is measured, and cost
 * is measured in one currency once that currency is known. Ids and scope bind
 * the plan to this exact delivery.
 */
export function buildDeliveryMeterPlan(profile, currency = null) {
  const limits = Object.fromEntries(Object.entries(DELIVERY_METER_METRICS)
    .map(([metric, unit]) => [metric, { unit, metering: "estimated", measure_only: true }]));
  const normalizedCurrency = currency ? String(currency).trim().toUpperCase() : null;
  if (normalizedCurrency) {
    limits.cost = { unit: "money", currency: normalizedCurrency, metering: "estimated", measure_only: true };
  }
  try {
    return normalizeExecutionBudget({
      id: normalizedCurrency ? `DELIVERY-METER-${profile.id}-${normalizedCurrency}` : `DELIVERY-METER-${profile.id}`,
      scope: {
        kind: DELIVERY_METER_PLAN_SCOPE_KIND,
        profile_id: profile.id,
        delivery_id: profile.delivery_id,
        delivery_kind: profile.delivery_kind,
      },
      warning_thresholds_percent: [70, 90],
      completion_reserve_percent: 0,
      limits,
      extensions: { purpose: "measure_only" },
    });
  } catch (error) {
    fail(`Cannot prepare the meter plan of delivery ${profile.id}: ${error.message}`);
  }
  return null;
}

function planErrors(plan, profile, fileName) {
  const errors = [];
  const integrity = validateExecutionBudgetIntegrity(plan);
  errors.push(...integrity.errors);
  const schema = validateRecordSchema(plan, "execution-budget.schema.json");
  errors.push(...schema.errors.map((error) => `${error.instance_path || "/"}: ${error.message}`));
  if (fileName !== `${normalizeId(String(plan?.id || "missing"))}.json`) errors.push("it is stored under another name");
  const scope = plan?.scope || {};
  if (scope.kind !== DELIVERY_METER_PLAN_SCOPE_KIND
    || scope.profile_id !== profile.id
    || scope.delivery_id !== profile.delivery_id
    || scope.delivery_kind !== profile.delivery_kind) {
    errors.push(`it is not bound to delivery ${profile.id}`);
  }
  for (const [metric, spec] of Object.entries(plan?.limits || {})) {
    if (spec?.measure_only !== true) errors.push(`metric ${metric} is limited, but a delivery meter plan only measures`);
  }
  return errors;
}

function readLedger(context, profile) {
  const filePath = ledgerPath(context, profile.id);
  if (!fs.existsSync(filePath)) return null;
  const ledger = readProjectJson(context, filePath);
  assertRecordSchema(ledger, LEDGER_SCHEMA, `Usage ledger of delivery ${profile.id}`);
  const { ledger_hash: ledgerHash, hash_algorithm: algorithm, ...body } = ledger;
  if (algorithm !== HASH_ALGORITHM || ledgerHash !== shortHashFull(stableJson(body))) {
    fail(`The usage ledger of delivery ${profile.id} changed after it was written; its usage history cannot be trusted.`);
  }
  if (ledger.profile_id !== profile.id || ledger.delivery_id !== profile.delivery_id) {
    fail(`The usage ledger stored for delivery ${profile.id} belongs to another delivery.`);
  }
  return ledger;
}

function buildLedger(profile, entries) {
  const chain = buildUsageLedger(entries);
  const body = {
    kind: "delivery_usage_ledger",
    schema_version: "delivery-usage-ledger:v1",
    profile_id: profile.id,
    delivery_id: profile.delivery_id,
    receipt_count: chain.receipt_count,
    head_hash: chain.head_hash,
    receipts: chain.receipts,
    updated_at: now(),
  };
  return { ...body, ledger_hash: shortHashFull(stableJson(body)), hash_algorithm: HASH_ALGORITHM };
}

/**
 * Compares the receipts on disk with the delivery's ledger. A receipt the
 * ledger lists that is missing or changed means history was removed or
 * rewritten, so this fails closed. Receipts not listed yet (an interrupted
 * record) only add usage and are registered by the next record.
 */
function verifyLedger(context, profile, receipts, ledger) {
  if (!ledger) return { status: "untracked", unregistered: receipts };
  const recomputed = buildUsageLedger(ledger.receipts || []);
  if (recomputed.receipt_count !== ledger.receipt_count || recomputed.head_hash !== ledger.head_hash) {
    fail(`The usage ledger of delivery ${profile.id} is inconsistent (count or head hash does not match its entries); its usage history cannot be trusted.`);
  }
  const byId = new Map(receipts.map((receipt) => [receipt.id, receipt]));
  const missing = [];
  const changed = [];
  for (const entry of ledger.receipts) {
    const receipt = byId.get(entry.id);
    if (!receipt) missing.push(entry.id);
    else if (receipt.receipt_hash !== entry.receipt_hash) changed.push(entry.id);
  }
  if (missing.length > 0 || changed.length > 0) {
    const directory = toProjectPath(context, usageRoot(context, profile.id));
    fail([
      `Usage history of delivery ${profile.id} does not match its ledger: the ledger records ${ledger.receipt_count} receipt(s), but ${missing.length} ${missing.length === 1 ? "is" : "are"} missing and ${changed.length} changed in ${directory}.`,
      ...(missing.length > 0 ? [`Missing: ${missing.join(", ")}.`] : []),
      ...(changed.length > 0 ? [`Changed: ${changed.join(", ")}.`] : []),
      "Usage receipts are append-only; deleting or editing one would hide spent cost, so this delivery's cost cannot be shown or checked.",
      `Restore the original files (for example from version control) in ${directory}, then run the command again.`,
    ].join("\n"));
  }
  const registered = new Set(ledger.receipts.map((entry) => entry.id));
  return { status: "verified", unregistered: receipts.filter((receipt) => !registered.has(receipt.id)) };
}

function readMeterRecord(context, profile, adapterId, reference, directory, hashField, label) {
  if (!reference?.path || !reference?.hash) fail(`its ${label} reference is missing`);
  const filePath = resolveProjectFilePath(context, reference.path, { mustExist: true, fileOnly: true });
  if (!isInsidePath(path.join(meterRoot(context, profile.id, adapterId), directory), filePath)) {
    fail(`its ${label} is outside the delivery's metering records`);
  }
  const record = readProjectJson(context, filePath);
  if (record?.[hashField] !== reference.hash) fail(`its ${label} changed after it was recorded`);
  return record;
}

/**
 * Evidence behind a receipt that claims a meter measured it. An adapter
 * observation must rest on the delivery's own baseline, snapshot, and delta,
 * and its usage must be exactly what the adapter derives from that delta. A
 * trusted signed reading must still verify against the configured key. A
 * receipt that fails either check makes the whole history untrusted.
 */
function verifyReceiptEvidence(context, profile, receipt, plan) {
  const assurance = receipt.source?.assurance;
  try {
    if (assurance === "advisory_observed") {
      const adapter = builtInMeterAdapter(receipt.source?.adapter);
      if (!adapter) fail(`'${receipt.source?.adapter}' is not a built-in meter adapter`);
      const baseline = readMeterRecord(context, profile, adapter.id, receipt.source.baseline_ref, "baselines", "baseline_hash", "baseline");
      const snapshot = readMeterRecord(context, profile, adapter.id, receipt.source.current_snapshot_ref, "snapshots", "snapshot_hash", "snapshot");
      const delta = readMeterRecord(context, profile, adapter.id, receipt.source.delta_ref, "deltas", "delta_hash", "delta");
      const { baseline_hash: baselineHash, hash_algorithm: algorithm, ...body } = baseline;
      if (algorithm !== HASH_ALGORITHM || baselineHash !== shortHashFull(stableJson(body)) || baseline.delivery_ref?.profile_id !== profile.id) {
        fail("its baseline is not an intact baseline of this delivery");
      }
      if (!adapter.validateSnapshot(snapshot).valid || !adapter.validateDelta(delta).valid) {
        fail("its snapshot or delta failed integrity validation");
      }
      const measured = Object.fromEntries(Object.entries(adapter.mapUsage(delta, plan, baseline.metric_mapping))
        .map(([metric, value]) => [metric, value && typeof value === "object" ? canonicalAmount(String(value.amount)) : value]));
      if (stableJson(measured) !== stableJson(receipt.usage)) {
        fail("its usage is not what the meter measured");
      }
    } else if (assurance === "trusted_attested") {
      const errors = inspectExactMeteringSource(context, receipt, plan, exactMeteringMetrics(receipt)).errors;
      if (errors.length > 0) fail(errors.join("; "));
    }
  } catch (error) {
    fail(`Usage receipt ${receipt.id} of delivery ${profile.id} cannot be trusted: ${String(error.message).split("\n")[0]}.`);
  }
}

function effectivePlan(plans) {
  return plans.find((plan) => plan.limits?.cost) || plans.find((plan) => !plan.limits?.cost) || null;
}

function evaluateHistory(profile, plans, receipts) {
  if (receipts.length === 0) return null;
  const plan = effectivePlan(plans);
  if (!plan) fail(`Usage of delivery ${profile.id} is recorded without its meter plan.`);
  return evaluateBudgetUsage(plan, sortUsageReceipts(receipts), { accepted_receipt_budgets: plans });
}

/**
 * Every metering record of one delivery, verified: plans bound to this
 * delivery, at most one cost currency, receipts bound to those plans, the
 * ledger, and a history that evaluates. Fails closed on any inconsistency.
 */
export function readDeliveryMeteringState(context, profile) {
  const plans = safeReadDir(plansRoot(context, profile.id))
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const plan = readProjectJson(context, path.join(plansRoot(context, profile.id), name));
      const errors = planErrors(plan, profile, name);
      if (errors.length > 0) {
        fail(`The meter plan ${name} of delivery ${profile.id} cannot be trusted: ${[...new Set(errors)].join("; ")}.`);
      }
      return plan;
    });
  const currencies = [...new Set(plans.map((plan) => plan.limits?.cost?.currency).filter(Boolean))];
  if (currencies.length > 1) {
    fail(`Delivery ${profile.id} records cost in more than one currency (${currencies.join(", ")}); amounts are never converted, so its cost cannot be shown or checked.`);
  }
  const planHashes = new Set(plans.map((plan) => plan.budget_hash));
  const receipts = sortUsageReceipts(safeReadDir(usageRoot(context, profile.id))
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const receipt = readProjectJson(context, path.join(usageRoot(context, profile.id), name));
      if (name !== `${normalizeId(String(receipt?.id || "missing"))}.json`) {
        fail(`Usage receipt ${name} of delivery ${profile.id} is stored under another name.`);
      }
      if (receipt?.execution_id !== profile.id) {
        fail(`Usage receipt ${receipt?.id || name} is stored for delivery ${profile.id} but belongs to '${receipt?.execution_id || "nothing"}'.`);
      }
      if (!planHashes.has(receipt.budget_hash)) {
        fail(`Usage receipt ${receipt.id} of delivery ${profile.id} is not bound to any of its meter plans.`);
      }
      verifyReceiptEvidence(context, profile, receipt, plans.find((plan) => plan.budget_hash === receipt.budget_hash));
      return receipt;
    }));
  const ledger = readLedger(context, profile);
  const ledgerState = verifyLedger(context, profile, receipts, ledger);
  try {
    evaluateHistory(profile, plans, receipts);
  } catch (error) {
    if (error instanceof UserError) throw error;
    fail(`Usage history of delivery ${profile.id} is invalid: ${describeValidationError(error)}`);
  }
  return {
    profile_id: profile.id,
    plans,
    receipts,
    ledger,
    ledger_status: ledgerState.status,
    unregistered: ledgerState.unregistered,
    currency: currencies[0] || null,
  };
}

/** The verified usage summary of one delivery; a delivery with no records reports nothing measured. */
export function deliveryUsageSummary(context, profile) {
  const state = readDeliveryMeteringState(context, profile);
  return { ...summarizeDeliveryUsage(state.receipts, state.plans), currency: state.currency, ledger_status: state.ledger_status };
}

/** Currency of the standing approval budget a delivery relies on, when its record is intact. */
function standingBudgetCurrency(context, profile) {
  const ref = profile?.extensions?.standing_approval_ref;
  if (!ref?.id || !ref?.record_hash) return null;
  const filePath = path.join(autonomyRoot(context), "standing", normalizeId(ref.id), "proposal.json");
  if (!fs.existsSync(filePath)) return null;
  try {
    const proposal = readProjectJson(context, filePath);
    return proposal?.record_hash === ref.record_hash ? proposal.budget?.currency || null : null;
  } catch {
    return null;
  }
}

/**
 * The plan a new receipt is bound to. The cost currency is fixed by the first
 * of: a currency already recorded for this delivery, the standing approval's
 * budget currency, the requested currency. A different currency is refused,
 * because amounts are never converted.
 */
function resolvePlan(context, profile, state, requestedCurrency = null, requestedLabel = "--currency") {
  const standing = standingBudgetCurrency(context, profile);
  let currency = state.currency || standing || null;
  if (requestedCurrency) {
    const requested = String(requestedCurrency).trim().toUpperCase();
    if (currency && requested !== currency) {
      fail(state.currency
        ? `${requestedLabel} ${requested} does not match ${currency}, the currency this delivery's cost is already recorded in; amounts are never converted.`
        : `${requestedLabel} ${requested} does not match ${currency}, the currency of the standing approval budget this delivery relies on; amounts are never converted.`);
    }
    currency = requested;
  }
  const candidate = buildDeliveryMeterPlan(profile, currency);
  return state.plans.find((plan) => plan.id === candidate.id) || candidate;
}

/** Plans an imported receipt may be bound to: the stored ones and the ones this delivery would use. */
function candidatePlans(context, profile, state, receipt) {
  const plans = [...state.plans, buildDeliveryMeterPlan(profile, null)];
  const prefix = `DELIVERY-METER-${profile.id}-`;
  const currency = state.currency
    || standingBudgetCurrency(context, profile)
    || (String(receipt?.budget_id || "").startsWith(prefix) ? String(receipt.budget_id).slice(prefix.length) : null);
  if (currency && /^[A-Z][A-Z0-9]{2,7}$/u.test(currency)) plans.push(buildDeliveryMeterPlan(profile, currency));
  return plans;
}

function assertAcceptsNewUsage(context, profile) {
  if (profile.status !== "active") {
    fail(`New usage can be recorded for delivery ${profile.id} only after it is approved; it is ${profile.status}. An identical existing receipt may still be replayed safely.`);
  }
  if (effectiveDeliveryProfileStatus(context, profile).status === "revoked") {
    fail(`Delivery ${profile.id} was revoked, so no new usage is recorded for it. An identical existing receipt may still be replayed safely.`);
  }
  const execution = currentDeliveryExecutionState(context, profile);
  if (execution.lifecycle_status === "terminal") {
    fail(`Delivery ${profile.id} is closed (${execution.status}), so its usage history is final. An identical existing receipt may still be replayed safely.`);
  }
}

function acceptsNewUsage(context, profile) {
  try {
    assertAcceptsNewUsage(context, profile);
    return true;
  } catch {
    return false;
  }
}

function deliveryUsageFromOptions(context, options, profile, state) {
  const provided = loadOptionalJsonInput(context, options, "receipt-json", "receipt-file", "execution usage receipt");
  if (provided.kind === "execution_usage_receipt") {
    const plan = candidatePlans(context, profile, state, provided)
      .find((candidate) => candidate.budget_hash === provided.budget_hash);
    if (!plan) {
      fail(`Usage receipt ${provided.id || "unknown"} is bound to budget ${provided.budget_id || "unknown"}, not to a meter plan of delivery ${profile.id}. Build it against the plan shown by budget status --delivery ${profile.id} --json.`);
    }
    const validation = validateExecutionUsageReceipt(provided, plan);
    if (!validation.valid) {
      fail(`Imported usage receipt failed integrity validation: ${validation.errors.join("; ")}`);
    }
    if (provided.execution_id !== profile.id) {
      fail(`Usage receipt ${provided.id || "unknown"} is bound to execution '${provided.execution_id}', not delivery '${profile.id}'.`);
    }
    // An adapter observation is recorded only by budget meter record, which
    // runs the meter itself; an imported one could claim any figure.
    const stored = state.receipts.find((candidate) => candidate.id === provided.id);
    if (provided.source?.assurance === "advisory_observed" && stored?.receipt_hash !== provided.receipt_hash) {
      fail([
        `Usage receipt ${provided.id || "unknown"} claims a meter observation, which only budget meter record --delivery ${profile.id} records, because it reads the meter itself.`,
        "Record manual usage with the metric flags, or import a signed exact receipt with --receipt-file.",
      ].join("\n"));
    }
    const exactMetrics = exactMeteringMetrics(provided);
    if (exactMetrics.length > 0) {
      if (!getOptionString(options, "receipt-file")) {
        fail([
          `Receipt ${provided.id || "unknown"} declares exact metering for ${exactMetrics.join(", ")}, but exact values cannot be declared manually or supplied inline.`,
          "Import a canonical receipt generated by an attested runtime adapter with --receipt-file <receipt.json>.",
        ].join("\n"));
      }
      const trustErrors = inspectExactMeteringSource(context, provided, plan, exactMetrics).errors;
      if (trustErrors.length > 0) {
        fail([
          `Exact metering receipt ${provided.id || "unknown"} is not trusted by this project (fail-closed): ${trustErrors.join("; ")}.`,
          "Configure the reviewed adapter and its Ed25519 public key in budget_policy.exact_metering.trusted_sources first: every entry requires adapter, metrics, and trusted_keys.",
        ].join("\n"));
      }
    }
    return { receipt: provided, plan };
  }
  const usage = provided.usage && typeof provided.usage === "object" ? { ...provided.usage } : {};
  const costGiven = options["cost-amount"] !== undefined || Object.hasOwn(usage, "cost");
  const inlineCurrency = usage.cost && typeof usage.cost === "object" ? usage.cost.currency : null;
  const plan = resolvePlan(context, profile, state, getOptionString(options, "currency") || inlineCurrency || null);
  if (costGiven && !plan.limits.cost) {
    fail(`A cost needs a currency the first time one is recorded for delivery ${profile.id}: add --currency, for example --currency USD. After that every cost of this delivery uses the same currency.`);
  }
  Object.assign(usage, usageFromMetricFlags(options, plan));
  if (Object.keys(usage).length === 0) {
    fail(`No usage metrics were provided. A delivery accepts: ${budgetMetricFlagHint(plan)}.`);
  }
  const requestedAccuracy = getOptionString(options, "metering-accuracy");
  if (requestedAccuracy === "exact" || Object.values(provided.metering || {}).includes("exact")) {
    fail([
      "Manual usage input cannot declare exact metering. Manual observations are estimated or unavailable.",
      "For exact values, import a canonical receipt from a configured trusted adapter with --receipt-file <receipt.json>.",
    ].join("\n"));
  }
  const metering = {};
  for (const metric of Object.keys(usage)) {
    metering[metric] = requestedAccuracy || provided.metering?.[metric] || "estimated";
  }
  try {
    return {
      plan,
      receipt: buildExecutionUsageReceipt({
        id: options.id || `USAGE-${profile.id}-${uniqueRecordSuffix()}`,
        execution_id: profile.id,
        budget: plan,
        usage,
        metering,
        ended_at: now(),
        source: {
          adapter: getOptionString(options, "metering-source") || "manual-runtime-adapter",
          assurance: "manual_declared",
          aggregation: "delta",
          attestation_ref: null,
          subagent: getOptionString(options, "subagent") || null,
          actor: buildAttribution(context, options, "budget.usage.record").actor,
        },
        pricing_ref: getOptionString(options, "pricing-ref") ? { id: getOptionString(options, "pricing-ref") } : null,
        evidence: normalizeRawListOption(options.evidence),
      }),
    };
  } catch (error) {
    fail(`Invalid execution usage receipt: ${error.message}`);
  }
  return null;
}

function writePlanIfNew(context, profile, plan) {
  const filePath = path.join(plansRoot(context, profile.id), `${normalizeId(plan.id)}.json`);
  if (fs.existsSync(filePath)) return;
  assertRecordSchema(plan, "execution-budget.schema.json", `Meter plan ${plan.id}`);
  writeJsonFile(filePath, plan);
}

/** Registers receipts the ledger does not list yet and returns the ledger in effect. */
function registerReceiptsInLedger(context, profile) {
  const receipts = sortUsageReceipts(safeReadDir(usageRoot(context, profile.id))
    .filter((name) => name.endsWith(".json"))
    .map((name) => readProjectJson(context, path.join(usageRoot(context, profile.id), name))));
  const ledger = readLedger(context, profile);
  const { unregistered } = verifyLedger(context, profile, receipts, ledger);
  if (ledger && unregistered.length === 0) return ledger;
  const next = buildLedger(profile, [
    ...(ledger?.receipts || []),
    ...unregistered.map((receipt) => ({ id: receipt.id, receipt_hash: receipt.receipt_hash })),
  ]);
  assertRecordSchema(next, LEDGER_SCHEMA, `Usage ledger of delivery ${profile.id}`);
  writeJsonFile(ledgerPath(context, profile.id), next, { force: true });
  return next;
}

function recordDeliveryUsageLocked(context, options, profile, supplied = null, extraOutput = {}) {
  const state = readDeliveryMeteringState(context, profile);
  const { receipt, plan } = supplied || deliveryUsageFromOptions(context, options, profile, state);
  const validation = validateExecutionUsageReceipt(receipt, plan);
  if (!validation.valid) {
    fail(`Usage receipt failed integrity validation: ${validation.errors.join("; ")}`);
  }
  const receiptPath = path.join(usageRoot(context, profile.id), `${normalizeId(receipt.id)}.json`);
  let idempotent = false;
  if (fs.existsSync(receiptPath)) {
    const existing = readProjectJson(context, receiptPath);
    if (existing.receipt_hash !== receipt.receipt_hash || stableJson(existing) !== stableJson(receipt)) {
      fail([
        `Usage receipt id '${receipt.id}' is already registered with different canonical content.`,
        "Usage receipts are append-only: choose a new --id for a new observation.",
        "--force never overwrites a usage receipt because that would rewrite usage history.",
      ].join("\n"));
    }
    idempotent = true;
  } else {
    assertAcceptsNewUsage(context, profile);
    const incoming = validateExecutionUsageReceipt(receipt, plan, { incoming: true });
    if (!incoming.valid) {
      fail(`Usage receipt ${receipt.id} was not recorded: ${incoming.errors.join("; ")}`);
    }
    assertRecordSchema(receipt, "execution-usage-receipt.schema.json", `Usage receipt ${receipt.id}`);
    const plans = state.plans.some((candidate) => candidate.budget_hash === plan.budget_hash)
      ? state.plans
      : [...state.plans, plan];
    const currencies = new Set(plans.map((candidate) => candidate.limits?.cost?.currency).filter(Boolean));
    if (currencies.size > 1) {
      fail(`Usage receipt ${receipt.id} was not recorded: delivery ${profile.id} already records cost in ${state.currency}; amounts are never converted.`);
    }
    // Validate the candidate history in memory first, so a receipt that would
    // make the history invalid never reaches disk.
    try {
      evaluateHistory(profile, plans, [...state.receipts, receipt]);
    } catch (error) {
      fail([
        `Usage receipt ${receipt.id} was not recorded: it is inconsistent with the usage already recorded for delivery ${profile.id}.`,
        `Reason: ${describeValidationError(error)}`,
        "Nothing was written; the existing usage history is unchanged.",
      ].join("\n"));
    }
    writePlanIfNew(context, profile, plan);
    writeJsonFile(receiptPath, receipt);
  }
  if (acceptsNewUsage(context, profile)) registerReceiptsInLedger(context, profile);
  const final = readDeliveryMeteringState(context, profile);
  const summary = summarizeDeliveryUsage(final.receipts, final.plans);
  const italian = humanGuidanceLocale(options) === "it";
  output(options, {
    ...extraOutput,
    status: "recorded",
    registration_status: idempotent ? "idempotent_replay" : "created",
    idempotent,
    delivery_profile_id: profile.id,
    delivery_id: profile.delivery_id,
    receipt,
    receipt_path: toProjectPath(context, receiptPath),
    plan: { id: plan.id, budget_hash: plan.budget_hash, currency: plan.limits?.cost?.currency || null },
    usage: summary,
  }, [
    idempotent
      ? (italian
        ? `L’utilizzo ${receipt.id} era già registrato con lo stesso contenuto; la cronologia non cambia.`
        : `Usage ${receipt.id} was already registered with the same content; history is unchanged.`)
      : (italian
        ? `Registrato l’utilizzo ${receipt.id} per la consegna ${profile.delivery_id} (${profile.id}).`
        : `Recorded usage ${receipt.id} for delivery ${profile.delivery_id} (${profile.id}).`),
    ...describeDeliveryUsage(summary, { italian }),
  ]);
}

function withMeteringLock(context, profileId, callback) {
  const release = acquireFileLock(meteringLockPath(context, profileId));
  try {
    return callback();
  } finally {
    release();
  }
}

function assertOneTarget(options) {
  if (getOptionString(options, "proposal") && getOptionString(options, "delivery")) {
    fail("Use either --proposal for an assessment or --delivery for a delivery, not both.");
  }
}

/** budget usage record --delivery <profile-id>. */
export async function recordDeliveryUsage(context, options) {
  ensureInitialized(context);
  const profile = readDeliveryAutonomyProfile(context, normalizeId(getOptionString(options, "delivery")));
  withMeteringLock(context, profile.id, () => recordDeliveryUsageLocked(context, options, profile));
}

function snapshotCostCurrency(snapshot) {
  const currency = snapshot?.cumulative?.cost?.currency;
  return typeof currency === "string" && currency ? currency.toUpperCase() : null;
}

function buildBaseline(profile, plan, adapterId, baselineId, mapping, snapshot) {
  const body = {
    kind: BASELINE_KIND,
    schema_version: BASELINE_SCHEMA_VERSION,
    id: baselineId,
    delivery_ref: { profile_id: profile.id, delivery_id: profile.delivery_id, delivery_kind: profile.delivery_kind },
    budget_ref: { id: plan.id, hash: plan.budget_hash },
    adapter: adapterId,
    metric_mapping: mapping,
    snapshot,
    created_at: snapshot.captured_at,
  };
  return { ...body, baseline_hash: shortHashFull(stableJson(body)), hash_algorithm: HASH_ALGORITHM };
}

function validateBaseline(baseline, profile, plans, adapter, config) {
  const { baseline_hash: hash, hash_algorithm: algorithm, ...body } = baseline || {};
  if (algorithm !== HASH_ALGORITHM || hash !== shortHashFull(stableJson(body))
    || baseline.kind !== BASELINE_KIND || baseline.schema_version !== BASELINE_SCHEMA_VERSION) {
    fail("Delivery meter baseline failed immutable content validation.");
  }
  if (baseline.delivery_ref?.profile_id !== profile.id
    || baseline.delivery_ref?.delivery_id !== profile.delivery_id
    || baseline.delivery_ref?.delivery_kind !== profile.delivery_kind
    || baseline.adapter !== adapter.id) {
    fail("Delivery meter baseline is not bound to this delivery and adapter.");
  }
  const plan = plans.find((candidate) => candidate.id === baseline.budget_ref?.id && candidate.budget_hash === baseline.budget_ref?.hash);
  if (!plan) fail("Delivery meter baseline is not bound to a meter plan of this delivery.");
  if (stableJson(baseline.metric_mapping) !== stableJson(resolveBudgetMeterMapping(plan, config, adapter))) {
    fail(`${adapter.label} metric mapping changed after the baseline was captured; start a new named baseline before recording usage.`);
  }
  const integrity = adapter.validateSnapshot(baseline.snapshot);
  if (!integrity.valid) fail(`Delivery meter baseline snapshot is invalid: ${integrity.errors.join("; ")}`);
  return { baseline, plan };
}

function meterLines(adapter, mapping, plan, italian) {
  const measured = Object.keys(mapping);
  const lines = [italian ? `Questo contatore misura: ${measured.join(", ")}.` : `This meter measures: ${measured.join(", ")}.`];
  if (!measured.includes("cost")) {
    lines.push(italian
      ? `Il contatore ${adapter.label} non misura il costo di questa consegna${plan.limits.cost ? "" : " (nessuna valuta nota)"}: il costo resta non misurato finché un contatore che lo riporta non lo registra.`
      : `The ${adapter.label} meter does not measure this delivery's cost${plan.limits.cost ? "" : " (no currency is known yet)"}: cost stays not measured until a meter that reports it records it.`);
  }
  return lines;
}

/** budget meter start --delivery <profile-id>. */
export async function startDeliveryMeter(context, options) {
  ensureInitialized(context);
  const profile = readDeliveryAutonomyProfile(context, normalizeId(getOptionString(options, "delivery")));
  assertAcceptsNewUsage(context, profile);
  const { adapter, config } = budgetMeterAdapter(context, options);
  const baselineId = normalizeId(options.id || `METER-${profile.id}-${adapter.id}`);
  const filePath = baselinePath(context, profile.id, adapter.id, baselineId);
  const italian = humanGuidanceLocale(options) === "it";
  const replay = (state) => {
    const { baseline } = validateBaseline(readProjectJson(context, filePath), profile, state.plans, adapter, config);
    output(options, {
      status: "idempotent_replay",
      idempotent: true,
      delivery_profile_id: profile.id,
      baseline,
      baseline_path: toProjectPath(context, filePath),
    }, [italian
      ? `La misura iniziale ${baselineId} di ${adapter.label} esiste già con lo stesso contenuto.`
      : `${adapter.label} baseline ${baselineId} already exists with the same immutable content.`]);
  };
  if (fs.existsSync(filePath)) {
    replay(readDeliveryMeteringState(context, profile));
    return;
  }
  const snapshot = await collectBudgetMeterSnapshot(
    context,
    profile.id,
    adapter,
    config,
    adapter.buildQuery(context, options, config),
    `${baselineId}-SNAPSHOT`,
    options,
  );
  withMeteringLock(context, profile.id, () => {
    const state = readDeliveryMeteringState(context, profile);
    if (fs.existsSync(filePath)) {
      replay(state);
      return;
    }
    const reported = snapshotCostCurrency(snapshot);
    const plan = resolvePlan(
      context,
      profile,
      state,
      getOptionString(options, "currency") || null,
    );
    const effective = !plan.limits.cost && reported ? resolvePlan(context, profile, state, reported, `${adapter.label} cost`) : plan;
    if (reported && effective.limits.cost && effective.limits.cost.currency !== reported) {
      fail(`${adapter.label} reports cost in ${reported}, but delivery ${profile.id} records cost in ${effective.limits.cost.currency}; amounts are never converted.`);
    }
    const mapping = resolveBudgetMeterMapping(effective, config, adapter);
    const baseline = buildBaseline(profile, effective, adapter.id, baselineId, mapping, snapshot);
    writePlanIfNew(context, profile, effective);
    writeImmutableMeterRecord(context, filePath, baseline, "baseline_hash", `${adapter.label} baseline ${baselineId}`);
    output(options, {
      status: "created",
      idempotent: false,
      delivery_profile_id: profile.id,
      baseline,
      baseline_path: toProjectPath(context, filePath),
      measured_metrics: Object.keys(mapping),
      unmeasured_metrics: Object.keys(effective.limits).filter((metric) => !Object.hasOwn(mapping, metric)),
    }, [
      italian
        ? `Creata la misura iniziale immutabile ${baselineId} di ${adapter.label} per la consegna ${profile.delivery_id}.`
        : `Created immutable ${adapter.label} baseline ${baselineId} for delivery ${profile.delivery_id}.`,
      italian
        ? `Affidabilità: ${adapter.assurance}; questa misura non è una attestazione esatta o firmata.`
        : `Assurance: ${adapter.assurance}; this baseline is not an exact or signed attestation.`,
      ...meterLines(adapter, mapping, effective, italian),
    ]);
  });
}

function readSnapshotReference(context, profile, adapter, reference) {
  if (!reference?.path || !reference?.hash) {
    fail(`${adapter.label} usage history of delivery ${profile.id} has a missing current snapshot reference.`);
  }
  const filePath = resolveProjectFilePath(context, reference.path, { mustExist: true, fileOnly: true });
  if (!isInsidePath(path.join(meterRoot(context, profile.id, adapter.id), "snapshots"), filePath)) {
    fail(`${adapter.label} snapshot reference of delivery ${profile.id} escapes its metering directory.`);
  }
  const snapshot = readProjectJson(context, filePath);
  const integrity = adapter.validateSnapshot(snapshot);
  if (!integrity.valid || snapshot.snapshot_hash !== reference.hash) {
    fail(`${adapter.label} snapshot ${reference.path} failed integrity validation.`);
  }
  return snapshot;
}

/** budget meter record --delivery <profile-id>. */
export async function recordDeliveryMeter(context, options) {
  ensureInitialized(context);
  const profile = readDeliveryAutonomyProfile(context, normalizeId(getOptionString(options, "delivery")));
  const { adapter, config } = budgetMeterAdapter(context, options);
  const baselineId = normalizeId(options.baseline || `METER-${profile.id}-${adapter.id}`);
  const filePath = baselinePath(context, profile.id, adapter.id, baselineId);
  if (!fs.existsSync(filePath)) {
    fail(`${adapter.label} baseline ${baselineId} of delivery ${profile.id} does not exist. Run budget meter start --delivery ${profile.id} first.`);
  }
  const initial = validateBaseline(readProjectJson(context, filePath), profile, readDeliveryMeteringState(context, profile).plans, adapter, config);
  const current = await collectBudgetMeterSnapshot(
    context,
    profile.id,
    adapter,
    config,
    adapter.buildQuery(context, options, config, initial.baseline.snapshot.scope),
    `METER-${profile.id}-${adapter.id}-CURRENT`,
    options,
  );
  withMeteringLock(context, profile.id, () => {
    const state = readDeliveryMeteringState(context, profile);
    const { baseline, plan } = validateBaseline(readProjectJson(context, filePath), profile, state.plans, adapter, config);
    const prior = state.receipts
      .filter((receipt) => receipt.source?.adapter === adapter.id && receipt.source?.baseline_ref?.hash === baseline.baseline_hash)
      .sort((left, right) => String(left.ended_at).localeCompare(String(right.ended_at)));
    const latest = prior.at(-1) || null;
    const previous = latest
      ? readSnapshotReference(context, profile, adapter, latest.source.current_snapshot_ref)
      : baseline.snapshot;
    if (latest && current.snapshot_hash === previous.snapshot_hash) {
      recordDeliveryUsageLocked(context, options, profile, { receipt: latest, plan: state.plans.find((candidate) => candidate.budget_hash === latest.budget_hash) }, {
        meter: { adapter: adapter.id, baseline: baseline.id, replayed_receipt: latest.id },
      });
      return;
    }
    let delta;
    try {
      delta = adapter.calculateDelta(previous, current, {
        id: normalizeId(`DELTA-${profile.id}-${previous.snapshot_hash.slice(0, 8)}-${current.snapshot_hash.slice(0, 8)}`),
      });
    } catch (error) {
      fail(`${adapter.label} counters are not a monotonic continuation of the recorded reading: ${error.message}`);
    }
    const deltaIntegrity = adapter.validateDelta(delta);
    if (!deltaIntegrity.valid) {
      fail(`${adapter.label} delta failed integrity validation: ${deltaIntegrity.errors.join("; ")}`);
    }
    const root = meterRoot(context, profile.id, adapter.id);
    const currentPath = path.join(root, "snapshots", `${current.snapshot_hash}.json`);
    const deltaPath = path.join(root, "deltas", `${delta.delta_hash}.json`);
    const usage = adapter.mapUsage(delta, plan, baseline.metric_mapping);
    const metering = Object.fromEntries(Object.keys(usage).map((metric) => [metric, "estimated"]));
    let receipt;
    try {
      receipt = buildExecutionUsageReceipt({
        id: options.id
          ? normalizeId(options.id)
          : normalizeId(`USAGE-${profile.id}-${adapter.id}-${delta.delta_hash.slice(0, 12)}`),
        execution_id: profile.id,
        budget: plan,
        usage,
        metering,
        started_at: delta.interval.started_at,
        ended_at: delta.interval.ended_at,
        source: {
          adapter: adapter.id,
          assurance: "advisory_observed",
          aggregation: "delta",
          attestation_ref: null,
          baseline_ref: { id: baseline.id, path: toProjectPath(context, filePath), hash: baseline.baseline_hash },
          previous_snapshot_hash: previous.snapshot_hash,
          current_snapshot_ref: { id: current.id, path: toProjectPath(context, currentPath), hash: current.snapshot_hash },
          delta_ref: { id: delta.id, path: toProjectPath(context, deltaPath), hash: delta.delta_hash },
          metric_mapping: baseline.metric_mapping,
          trusted_exact: false,
        },
        pricing_ref: Object.hasOwn(usage, "cost") ? {
          estimator: adapter.id,
          classification: "estimated",
          authoritative: false,
          adapter_version: current.adapter?.version || null,
          currency: snapshotCostCurrency(current),
          report_hash: current.source?.report_hash || null,
        } : null,
        evidence: [
          { path: toProjectPath(context, filePath), hash: baseline.baseline_hash },
          { path: toProjectPath(context, currentPath), hash: current.snapshot_hash },
          { path: toProjectPath(context, deltaPath), hash: delta.delta_hash },
        ],
      });
    } catch (error) {
      fail(`Invalid execution usage receipt: ${error.message}`);
    }
    assertAcceptsNewUsage(context, profile);
    writeImmutableMeterRecord(context, currentPath, current, "snapshot_hash", `${adapter.label} snapshot ${current.id}`, "metering-snapshot.schema.json");
    writeImmutableMeterRecord(context, deltaPath, delta, "delta_hash", `${adapter.label} delta ${delta.id}`, "metering-delta.schema.json");
    recordDeliveryUsageLocked(context, options, profile, { receipt, plan }, {
      meter: { adapter: adapter.id, baseline: baseline.id, delta: delta.id },
    });
  });
}

/** Approval envelope a delivery profile references, read for its time and source only. */
function readApprovalEnvelope(context, profile) {
  const ref = profile?.approval_ref;
  if (!ref?.path) return null;
  try {
    return readProjectJson(context, resolveProjectFilePath(context, ref.path, { mustExist: true, fileOnly: true }));
  } catch {
    return null;
  }
}

function readStoryTraceEvents(context, storyId) {
  if (!storyId) return [];
  const tracePath = path.join(context.sdlcRoot, "traces", `${normalizeId(storyId)}.jsonl`);
  if (!fs.existsSync(tracePath)) return [];
  return fs.readFileSync(tracePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function personConfirmed(receipt) {
  return receipt.status === "authorized"
    && receipt.checkpoint_required === true
    && receipt.approval?.approval_source === "explicit-user";
}

/** Every delivery action receipt, or none when one cannot be read (status never fails on this). */
export function readableDeliveryActionReceipts(context) {
  try {
    return { receipts: allDeliveryActionReceipts(context), error: null };
  } catch (error) {
    return { receipts: [], error: error.message };
  }
}

/** Lead time and usage of one delivery, derived from its records. */
export function deliveryMetrics(context, profile, { actionReceipts = null } = {}) {
  let execution = null;
  try {
    execution = currentDeliveryExecutionState(context, profile);
  } catch {
    execution = null;
  }
  const actions = (actionReceipts ?? readableDeliveryActionReceipts(context).receipts)
    .filter((receipt) => receipt?.profile_ref?.id === profile.id);
  // The story trace is read only when a person confirmed a step, to find when
  // that confirmation was requested.
  const events = actions.some(personConfirmed) ? readStoryTraceEvents(context, profile.story_refs?.[0]?.id) : [];
  const leadTime = deriveDeliveryLeadTime({
    profile,
    approval: readApprovalEnvelope(context, profile),
    start: execution?.start_receipt || null,
    close: execution?.close_receipt || null,
    actions,
    events,
  });
  let usage = null;
  let usageError = null;
  try {
    usage = deliveryUsageSummary(context, profile);
  } catch (error) {
    usageError = error.message;
  }
  return { lead_time: leadTime, usage, usage_error: usageError };
}

/** Human lines for one delivery's lead time and cost. */
export function describeDeliveryMetrics(metrics, { italian = false } = {}) {
  return [
    ...describeDeliveryLeadTime(metrics.lead_time, { italian }),
    ...(metrics.usage_error
      ? [italian
        ? `Costo: non leggibile (${metrics.usage_error.split("\n")[0]}).`
        : `Cost: cannot be read (${metrics.usage_error.split("\n")[0]}).`]
      : describeDeliveryUsage(metrics.usage, { italian })),
  ];
}

/** budget status --delivery <profile-id>: plans, receipts, cost, tokens, and lead time. */
export function showDeliveryBudgetStatus(context, options) {
  ensureInitialized(context);
  const profile = readDeliveryAutonomyProfile(context, normalizeId(getOptionString(options, "delivery")));
  const state = readDeliveryMeteringState(context, profile);
  const metrics = deliveryMetrics(context, profile);
  const italian = humanGuidanceLocale(options) === "it";
  const nextPlan = resolveNextPlanForDisplay(context, profile, state);
  output(options, {
    status: "ok",
    delivery_profile_id: profile.id,
    delivery_id: profile.delivery_id,
    plans: state.plans,
    next_receipt_plan: nextPlan,
    receipts: state.receipts,
    ledger_status: state.ledger_status,
    usage: metrics.usage,
    lead_time: metrics.lead_time,
  }, [
    italian
      ? `Consegna ${profile.delivery_id} (${profile.id}): ${state.receipts.length} ${state.receipts.length === 1 ? "ricevuta" : "ricevute"} di utilizzo.`
      : `Delivery ${profile.delivery_id} (${profile.id}): ${state.receipts.length} usage ${state.receipts.length === 1 ? "receipt" : "receipts"}.`,
    ...describeDeliveryMetrics(metrics, { italian }),
    italian
      ? `Le nuove ricevute si legano al piano di misura ${nextPlan.id} (${nextPlan.budget_hash}).`
      : `New receipts bind to meter plan ${nextPlan.id} (${nextPlan.budget_hash}).`,
  ]);
}

function resolveNextPlanForDisplay(context, profile, state) {
  const plan = resolvePlan(context, profile, state, null);
  return { id: plan.id, budget_hash: plan.budget_hash, currency: plan.limits?.cost?.currency || null, plan };
}

/** budget usage record: an assessment with --proposal, a delivery with --delivery. */
export async function budgetUsageRecordCommand(context, options) {
  assertOneTarget(options);
  return getOptionString(options, "delivery") ? recordDeliveryUsage(context, options) : recordBudgetUsage(context, options);
}

export async function budgetMeterStartCommand(context, options) {
  assertOneTarget(options);
  return getOptionString(options, "delivery") ? startDeliveryMeter(context, options) : startBudgetMeter(context, options);
}

export async function budgetMeterRecordCommand(context, options) {
  assertOneTarget(options);
  return getOptionString(options, "delivery") ? recordDeliveryMeter(context, options) : recordBudgetMeter(context, options);
}

export async function budgetStatusCommand(context, options) {
  assertOneTarget(options);
  return getOptionString(options, "delivery") ? showDeliveryBudgetStatus(context, options) : showBudgetStatus(context, options);
}
