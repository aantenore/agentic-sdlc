import test from "node:test";
import assert from "node:assert/strict";

import {
  DELIVERY_METER_PLAN_SCOPE_KIND,
  addMoneyAmounts,
  aggregateBudgetUsage,
  applyBudgetAmendment,
  compareMoneyAmounts,
  budgetInputPolicyErrors,
  budgetUtilizationPercent,
  buildBudgetAmendment,
  buildExecutionUsageReceipt,
  commitBudgetReservation,
  completionBudgetStatus,
  evaluateBudgetUsage,
  formatBudgetQuantity,
  normalizeExecutionBudget,
  normalizeMoneyDecimal,
  reserveBudget,
  validateExecutionBudgetIntegrity,
  validateExecutionUsageReceipt,
} from "../../lib/execution-budget.mjs";
import { computeStableHash, omitKeys } from "../../lib/canonical.mjs";

function budgetInput(overrides = {}) {
  return {
    id: "budget-001",
    scope: { level: "proposal", proposal_id: "proposal-001", includes_subagents: true },
    limits: {
      tokens: { unit: "tokens", metering: "exact", soft: 950, hard: 1000 },
      cost: { unit: "currency", currency: "EUR", metering: "exact", soft: "9", hard: "10" },
      calls: { unit: "calls", metering: "estimated", soft: 100 },
    },
    ...overrides,
  };
}

function trustedMeterSource(adapter = "test-meter") {
  return {
    adapter,
    assurance: "trusted_attested",
    aggregation: "cumulative",
    attestation_ref: {
      id: `${adapter}-attestation`,
      path: `receipts/${adapter}-attestation.json`,
      hash: "a".repeat(64),
    },
  };
}

test("budget normalization is provider-neutral, hashed, and validates hard metering", () => {
  const budget = normalizeExecutionBudget(budgetInput());

  assert.equal(budget.schema_version, "execution-budget:v1");
  assert.deepEqual(budget.warning_thresholds_percent, [70, 90]);
  assert.equal(budget.completion_reserve_percent, 15);
  assert.equal(budget.limits.tokens.unit, "tokens");
  assert.equal(budget.limits.cost.currency, "EUR");
  assert.equal(validateExecutionBudgetIntegrity(budget).valid, true);
  assert.equal(Object.isFrozen(budget.limits.tokens), true);

  assert.throws(
    () => normalizeExecutionBudget({
      id: "invalid-hard",
      limits: { tokens: { unit: "tokens", metering: "estimated", hard: 100 } },
    }),
    /hard requires exact metering/,
  );
  assert.throws(
    () => normalizeExecutionBudget({
      id: "numeric-money",
      limits: { cost: { unit: "currency", currency: "EUR", metering: "exact", hard: 1.5 } },
    }),
    /decimal string/,
  );
  assert.throws(
    () => normalizeExecutionBudget(budgetInput({ completion_reserve_percent: 51 })),
    /0 to 50/,
  );
});

test("money quantities remain exact decimal strings", () => {
  const budget = normalizeExecutionBudget(budgetInput());
  const total = aggregateBudgetUsage(
    budget,
    { cost: "0.1" },
    { cost: "0.2" },
  );

  assert.equal(total.cost, "0.3");
  assert.equal(normalizeMoneyDecimal("10.5000"), "10.5");
  assert.throws(() => normalizeMoneyDecimal("1e-3"), /without exponent/);
});

test("budget decisions distinguish warnings, completion reserve, soft and hard limits", () => {
  const budget = normalizeExecutionBudget(budgetInput());

  const atWarning = evaluateBudgetUsage(budget, [{ usage: { tokens: 700 }, metering: { tokens: "exact" } }]);
  assert.equal(atWarning.status, "warning");
  assert.deepEqual(atWarning.warnings[0].thresholds_reached_percent, [70]);
  assert.equal(atWarning.allowed_to_start_next, true);

  const inReserve = evaluateBudgetUsage(budget, [{ usage: { tokens: 850 }, metering: { tokens: "exact" } }]);
  assert.equal(inReserve.status, "completion_reserve");
  assert.equal(inReserve.completion_reserve.active, true);
  assert.equal(inReserve.allowed_for_completion_only, true);
  assert.equal(inReserve.requires_checkpoint, true);

  const atSoft = evaluateBudgetUsage(budget, [{ usage: { tokens: 950 }, metering: { tokens: "exact" } }]);
  assert.equal(atSoft.status, "soft_limit");
  assert.equal(atSoft.requires_checkpoint, true);
  assert.equal(atSoft.allowed_to_start_next, false);

  const atHard = evaluateBudgetUsage(budget, [{ usage: { tokens: 1000 }, metering: { tokens: "exact" } }]);
  assert.equal(atHard.status, "hard_limit");
  assert.equal(atHard.allowed_to_start_next, false);
  assert.equal(atHard.hard_limits[0].metric, "tokens");
});

test("usage aggregation reports non-exact hard-limit metering as a stop decision", () => {
  const budget = normalizeExecutionBudget(budgetInput());
  const decision = evaluateBudgetUsage(budget, [{
    id: "usage-1",
    usage: { tokens: 1 },
    metering: { tokens: "estimated" },
  }]);

  assert.equal(decision.status, "metering_violation");
  assert.equal(decision.allowed_to_start_next, false);
  assert.deepEqual(decision.metering_violations, [{
    metric: "tokens",
    required: "exact",
    actual: "estimated",
    receipt_id: "usage-1",
  }]);

  const missingMeter = evaluateBudgetUsage(budget, [{ id: "usage-2", usage: { tokens: 1 } }]);
  assert.equal(missingMeter.status, "metering_violation");
  assert.equal(missingMeter.metering_violations[0].actual, "missing");
});

test("execution usage receipts are immutable and budget-bound", () => {
  const budget = normalizeExecutionBudget(budgetInput());
  const receipt = buildExecutionUsageReceipt({
    id: "usage-001",
    execution_id: "execution-001",
    budget,
    usage: { tokens: 20, cost: "0.1", calls: 1 },
    metering: { tokens: "exact", cost: "exact", calls: "estimated" },
    started_at: "2026-07-14T08:00:00.000Z",
    ended_at: "2026-07-14T09:00:00.000Z",
    source: trustedMeterSource(),
  });

  assert.equal(receipt.schema_version, "execution-usage-receipt:v1");
  assert.equal(validateExecutionUsageReceipt(receipt, budget).valid, true);
  const tampered = structuredClone(receipt);
  tampered.usage.tokens = 21;
  assert.equal(validateExecutionUsageReceipt(tampered, budget).valid, false);

  assert.throws(
    () => buildExecutionUsageReceipt({
      id: "usage-manual-exact",
      execution_id: "execution-001",
      budget,
      usage: { tokens: 1 },
      metering: { tokens: "exact" },
      started_at: "2026-07-14T08:00:00.000Z",
      ended_at: "2026-07-14T09:00:00.000Z",
      source: { adapter: "manual", assurance: "manual_declared", aggregation: "delta", attestation_ref: null },
    }),
    /trusted_attested/,
  );
});

test("advisory observations for hard metrics are recorded but fail closed at evaluation", () => {
  const budget = normalizeExecutionBudget(budgetInput());
  const receipt = buildExecutionUsageReceipt({
    id: "usage-codeburn-advisory",
    execution_id: "execution-001",
    budget,
    usage: { tokens: 20 },
    metering: { tokens: "estimated" },
    started_at: "2026-07-14T08:00:00.000Z",
    ended_at: "2026-07-14T09:00:00.000Z",
    source: {
      adapter: "codeburn",
      assurance: "advisory_observed",
      aggregation: "delta",
      attestation_ref: null,
    },
  });

  assert.equal(validateExecutionUsageReceipt(receipt, budget).valid, true);
  const decision = evaluateBudgetUsage(budget, [receipt]);
  assert.equal(decision.status, "metering_violation");
  assert.equal(decision.allowed_to_start_next, false);
  assert.equal(decision.metering_violations[0].actual, "estimated");
});

test("amended budgets preserve immutable receipts from their approved ancestor lineage", () => {
  const base = normalizeExecutionBudget({
    id: "budget-lineage",
    limits: { steps: { unit: "steps", metering: "exact", soft: 10, hard: 20 } },
  });
  const receipt = buildExecutionUsageReceipt({
    id: "usage-before-amendment",
    execution_id: "execution-lineage",
    budget: base,
    usage: { steps: 10 },
    metering: { steps: "exact" },
    started_at: "2026-07-14T08:00:00.000Z",
    ended_at: "2026-07-14T09:00:00.000Z",
    source: trustedMeterSource("lineage-meter"),
  });
  const amendment = buildBudgetAmendment(
    base,
    { limits: { steps: { soft: 20, hard: 30 } } },
    {
      id: "amendment-lineage",
      reason: "Approve the remaining steps without rewriting historical usage",
      created_at: "2026-07-14T09:30:00.000Z",
    },
  );
  const effective = applyBudgetAmendment(base, amendment);

  assert.throws(
    () => evaluateBudgetUsage(effective, [receipt]),
    /outside the approved budget lineage/,
  );
  const decision = evaluateBudgetUsage(effective, [receipt], {
    accepted_receipt_budgets: [base, effective],
  });
  assert.equal(decision.usage.steps, 10);
  assert.equal(decision.status, "within_budget");
});

test("reservations are atomic, idempotent, conflict-aware, and commit actual usage", () => {
  const budget = normalizeExecutionBudget(budgetInput());
  const first = reserveBudget(budget, {}, { tokens: 100 }, { reservation_id: "reserve-1" });
  assert.equal(first.accepted, true);
  assert.equal(first.status, "reserved");

  const replay = reserveBudget(budget, first.state, { tokens: 100 }, { reservation_id: "reserve-1" });
  assert.equal(replay.accepted, true);
  assert.equal(replay.status, "idempotent_replay");

  const conflict = reserveBudget(budget, first.state, { tokens: 101 }, { reservation_id: "reserve-1" });
  assert.equal(conflict.accepted, false);
  assert.equal(conflict.status, "conflict");

  const overflow = reserveBudget(budget, {}, { tokens: 1000 }, { reservation_id: "reserve-overflow" });
  assert.equal(overflow.accepted, false);
  assert.equal(overflow.status, "hard_limit");

  const committed = commitBudgetReservation(budget, first.state, "reserve-1", { tokens: 80 });
  assert.equal(committed.state.usage.tokens, 80);
  assert.equal(committed.state.reservations["reserve-1"], undefined);
});

test("budget amendments bind base and result without mutating the original", () => {
  const budget = normalizeExecutionBudget(budgetInput());
  const amendment = buildBudgetAmendment(
    budget,
    { limits: { tokens: { hard: 1200 } } },
    {
      id: "amendment-001",
      reason: "Verified remaining work needs more token headroom",
      created_at: "2026-07-14T09:30:00.000Z",
      requested_by: { type: "human", id: "antonio" },
      approved_by: { type: "human", id: "antonio" },
      approval_source: "explicit-user",
      approval_evidence: [{ id: "host-message-001", hash: "a".repeat(64) }],
      proposal_ref: { id: "proposal-001", hash: "b".repeat(64) },
    },
  );

  assert.equal(amendment.schema_version, "budget-amendment:v1");
  assert.equal(amendment.base_budget_hash, budget.budget_hash);
  assert.equal(amendment.proposal_ref.id, "proposal-001");
  assert.equal(amendment.approval_source, "explicit-user");
  assert.equal(amendment.result_budget.limits.tokens.hard, 1200);
  assert.equal(amendment.result_budget.version, budget.version + 1);
  assert.equal(budget.limits.tokens.hard, 1000);
  assert.equal(applyBudgetAmendment(budget, amendment).budget_hash, amendment.result_budget_hash);

  const tampered = structuredClone(amendment);
  tampered.reason = "Changed after approval";
  assert.throws(() => applyBudgetAmendment(budget, tampered), /amendment_hash/);

  const unrelatedResult = normalizeExecutionBudget({
    ...structuredClone(omitKeys(budget, ["budget_hash", "hash_algorithm"])),
    version: budget.version + 1,
    limits: {
      ...structuredClone(budget.limits),
      tokens: { ...structuredClone(budget.limits.tokens), hard: 1300 },
    },
  });
  const forged = {
    ...structuredClone(amendment),
    result_budget: unrelatedResult,
    result_budget_hash: unrelatedResult.budget_hash,
  };
  forged.amendment_hash = computeStableHash(omitKeys(forged, ["amendment_hash", "hash_algorithm"]));
  assert.throws(() => applyBudgetAmendment(budget, forged), /does not match amendment.changes/);

  assert.throws(
    () => buildBudgetAmendment(
      budget,
      { provider_price: "1.23" },
      {
        id: "amendment-unsupported",
        reason: "Unsupported price mutation",
        created_at: "2026-07-14T09:31:00.000Z",
      },
    ),
    /unsupported field/,
  );
  assert.throws(
    () => buildBudgetAmendment(
      budget,
      { limits: { tokens: { hard: 990 } } },
      {
        id: "amendment-lower",
        reason: "Attempt a decrease",
        created_at: "2026-07-14T09:31:00.000Z",
      },
    ),
    /cannot lower hard limit/,
  );
  assert.throws(
    () => buildBudgetAmendment(
      budget,
      { completion_reserve_percent: budget.completion_reserve_percent - 1 },
      {
        id: "amendment-lower-reserve",
        reason: "Attempt to consume completion reserve",
        created_at: "2026-07-14T09:31:00.000Z",
      },
    ),
    /cannot lower completion_reserve_percent/,
  );
});

test("soft limits get advance warnings and unreported metrics are marked unmeasured", () => {
  const budget = normalizeExecutionBudget({
    id: "budget-soft",
    limits: {
      tokens: { unit: "tokens", metering: "estimated", soft: 1000 },
      cost: { unit: "money", currency: "USD", metering: "estimated", soft: "5" },
    },
  });
  const empty = evaluateBudgetUsage(budget, []);
  assert.deepEqual(empty.unmeasured_metrics, ["cost", "tokens"]);

  const decision = evaluateBudgetUsage(budget, [{ usage: { tokens: 750 }, metering: { tokens: "estimated" } }]);
  assert.equal(decision.status, "within_budget", "soft warnings never change the recorded decision status");
  assert.deepEqual(decision.unmeasured_metrics, ["cost"]);
  assert.deepEqual(decision.soft_warnings, [{ metric: "tokens", thresholds_reached_percent: [70], used: 750, soft: 1000 }]);
  assert.deepEqual(decision.warnings, []);

  assert.equal(formatBudgetQuantity(budget.limits.cost, "5"), "USD 5.00");
  assert.equal(formatBudgetQuantity(budget.limits.cost, "0.125"), "USD 0.125");
  assert.equal(formatBudgetQuantity(budget.limits.tokens, 1000), "1000 tokens");
  assert.equal(budgetUtilizationPercent(budget.limits.tokens, 750, 1000), "75.0");
  assert.equal(budgetUtilizationPercent(budget.limits.cost, "1.5", "5"), "30.0");
  assert.equal(budgetUtilizationPercent(budget.limits.tokens, 1, null), null);
});

test("budget input policy rejects unusable metrics, units, limits, actions, and maxima", () => {
  const valid = normalizeExecutionBudget({
    id: "budget-valid",
    limits: {
      tokens: { unit: "tokens", metering: "estimated", soft: 1000 },
      cost: { unit: "money", currency: "USD", metering: "estimated", soft: "5" },
      quality_checks: { unit: "checks", metering: "estimated", soft: 20 },
    },
  });
  assert.deepEqual(budgetInputPolicyErrors(valid, { maxima: { tokens: 1000, cost: "5.00" } }), []);
  assert.match(
    budgetInputPolicyErrors(valid, { maxima: { cost: "4.99" } }).join("\n"),
    /limits\.cost\.soft 5 exceeds the project maximum 4\.99/u,
  );
  const invalid = normalizeExecutionBudget({
    id: "budget-invalid",
    limits: {
      hasOwnProperty: { unit: "tokens", metering: "estimated", soft: 1 },
      steps: { unit: "steps", metering: "estimated", soft: 0 },
      cost: { unit: "money", metering: "estimated", currency: "EUR", soft: "0" },
      calls: { unit: "currency", currency: "EUR", metering: "estimated", soft: "1" },
    },
    limit_policy: { on_warning: "page" },
    extensions: { on_limit: "auto_raise" },
  });
  const problems = budgetInputPolicyErrors(invalid).join("\n");
  assert.match(problems, /metric 'hasOwnProperty' must be a simple lowercase identifier/u);
  assert.match(problems, /limits\.steps\.soft must be greater than 0/u);
  assert.match(problems, /limits\.cost\.soft must be greater than 0/u);
  assert.match(problems, /unit 'currency' is not a known unit/u);
  assert.match(problems, /limits\.calls declares currency EUR, so its unit must be 'money'/u);
  assert.match(problems, /limit_policy\.on_warning must be 'notify'/u);
  assert.match(problems, /extensions\.on_limit must be 'request_extension'/u);
});

test("cumulative aggregation is reserved for trusted attested sources", () => {
  const budget = normalizeExecutionBudget(budgetInput());
  for (const assurance of ["manual_declared", "advisory_observed"]) {
    assert.throws(
      () => buildExecutionUsageReceipt({
        id: `usage-${assurance}-cumulative`,
        execution_id: "execution-001",
        budget,
        usage: { calls: 5 },
        metering: { calls: "estimated" },
        ended_at: "2026-07-14T09:00:00.000Z",
        source: { adapter: "manual", assurance, aggregation: "cumulative", attestation_ref: null },
      }),
      /'cumulative' requires trusted_attested assurance/,
    );
  }
});

test("stored history with an advisory cumulative receipt stays readable, but a new one is refused", () => {
  const budget = normalizeExecutionBudget(budgetInput());
  const delta = buildExecutionUsageReceipt({
    id: "usage-stored-cumulative",
    execution_id: "execution-001",
    budget,
    usage: { calls: 5 },
    metering: { calls: "estimated" },
    ended_at: "2026-07-14T09:00:00.000Z",
    source: { adapter: "codeburn", assurance: "advisory_observed", aggregation: "delta", attestation_ref: null },
  });
  // A receipt recorded by an earlier version, before the rule existed.
  const stored = { ...structuredClone(delta), source: { ...delta.source, aggregation: "cumulative" } };
  stored.receipt_hash = computeStableHash(omitKeys(stored, ["receipt_hash", "hash_algorithm"]));

  assert.equal(validateExecutionUsageReceipt(stored, budget).valid, true);
  assert.equal(evaluateBudgetUsage(budget, [stored]).usage.calls, 5);
  const incoming = validateExecutionUsageReceipt(stored, budget, { incoming: true });
  assert.equal(incoming.valid, false);
  assert.match(incoming.errors.join("\n"), /'cumulative' requires trusted_attested assurance/u);

  const tampered = { ...structuredClone(stored), usage: { calls: 6 } };
  assert.throws(
    () => evaluateBudgetUsage(budget, [tampered]),
    (error) => /receipts\[0\] \(usage-stored-cumulative\) failed execution usage receipt validation: .*receipt_hash does not match/u.test(error.message),
  );
});

test("a completion records not_measured instead of a clean result for unmeasured metrics", () => {
  const budget = normalizeExecutionBudget({
    id: "budget-completion",
    limits: {
      tokens: { unit: "tokens", metering: "estimated", soft: 1000 },
      steps: { unit: "steps", metering: "estimated", soft: 10 },
    },
  });
  assert.equal(completionBudgetStatus(evaluateBudgetUsage(budget, [])), "not_measured");
  const partial = evaluateBudgetUsage(budget, [{ usage: { tokens: 10 }, metering: { tokens: "estimated" } }]);
  assert.equal(partial.status, "within_budget");
  assert.equal(completionBudgetStatus(partial), "not_measured");
  const full = evaluateBudgetUsage(budget, [{ usage: { tokens: 10, steps: 1 }, metering: { tokens: "estimated", steps: "estimated" } }]);
  assert.equal(completionBudgetStatus(full), "within_budget");
  const warned = evaluateBudgetUsage(budget, [{ usage: { tokens: 10, steps: 9 }, metering: { tokens: "estimated", steps: "estimated" } }]);
  assert.equal(completionBudgetStatus(warned), warned.status);
});

test("an amendment records the approver's decision only when one is given", () => {
  const budget = normalizeExecutionBudget(budgetInput());
  const base = { id: "amendment-summary", reason: "More calls are needed", created_at: "2026-07-14T09:31:00.000Z" };
  const withSummary = buildBudgetAmendment(budget, { limits: { calls: { soft: 200 } } }, { ...base, approval_summary: "I approve 200 calls" });
  assert.equal(withSummary.approval_summary, "I approve 200 calls");
  const legacy = buildBudgetAmendment(budget, { limits: { calls: { soft: 200 } } }, base);
  assert.equal(Object.hasOwn(legacy, "approval_summary"), false);
  assert.notEqual(withSummary.amendment_hash, legacy.amendment_hash);
  assert.equal(applyBudgetAmendment(budget, withSummary).budget_hash, applyBudgetAmendment(budget, legacy).budget_hash);
});

test("a regressing cumulative receipt is rejected before it can join the history", () => {
  const budget = normalizeExecutionBudget({
    id: "budget-cumulative",
    limits: { steps: { unit: "steps", metering: "exact", soft: 10, hard: 20 } },
  });
  const cumulative = (id, steps, endedAt) => buildExecutionUsageReceipt({
    id,
    execution_id: "execution-001",
    budget,
    usage: { steps },
    metering: { steps: "exact" },
    started_at: "2026-07-14T08:00:00.000Z",
    ended_at: endedAt,
    source: trustedMeterSource(),
  });
  const first = cumulative("usage-first", 6, "2026-07-14T09:00:00.000Z");
  const regressed = cumulative("usage-regressed", 4, "2026-07-14T09:10:00.000Z");
  assert.equal(evaluateBudgetUsage(budget, [first]).usage.steps, 6);
  assert.throws(
    () => evaluateBudgetUsage(budget, [first, regressed]),
    /regressed below previously recorded usage/,
  );
});

test("only a delivery meter plan may measure a metric without limiting it", () => {
  const scope = { kind: DELIVERY_METER_PLAN_SCOPE_KIND, profile_id: "AUT-ONE", delivery_id: "LOCAL-ONE", delivery_kind: "local_release" };
  const plan = normalizeExecutionBudget({
    id: "DELIVERY-METER-AUT-ONE-USD",
    scope,
    completion_reserve_percent: 0,
    limits: {
      tokens: { unit: "tokens", metering: "estimated", measure_only: true },
      cost: { unit: "money", currency: "usd", metering: "estimated", measure_only: true },
    },
  });
  assert.equal(plan.limits.cost.measure_only, true);
  assert.equal(plan.limits.cost.currency, "USD");
  assert.equal(validateExecutionBudgetIntegrity(plan).valid, true);
  const receipt = buildExecutionUsageReceipt({
    id: "USAGE-1",
    execution_id: "AUT-ONE",
    budget: plan,
    usage: { tokens: 10, cost: { amount: "0.25", currency: "USD" } },
    ended_at: "2026-10-01T10:00:00.000Z",
    source: { adapter: "manual-runtime-adapter", assurance: "manual_declared", aggregation: "delta", attestation_ref: null },
  });
  const decision = evaluateBudgetUsage(plan, [receipt]);
  assert.equal(decision.status, "within_budget");
  assert.deepEqual(decision.usage, { cost: "0.25", tokens: 10 });
  assert.deepEqual(decision.hard_limits, []);

  // An assessment budget, or any budget outside a delivery plan, always limits its metrics.
  assert.throws(
    () => normalizeExecutionBudget({ id: "b", limits: { tokens: { unit: "tokens", metering: "estimated", measure_only: true } } }),
    /measure_only is allowed only in a delivery meter plan/u,
  );
  assert.throws(
    () => normalizeExecutionBudget({ id: "b", scope, limits: { tokens: { unit: "tokens", metering: "estimated", soft: 5, measure_only: true } } }),
    /measure-only and cannot set soft or hard/u,
  );
  assert.throws(
    () => normalizeExecutionBudget({ id: "b", scope, limits: { tokens: { unit: "tokens", metering: "estimated", measure_only: false } } }),
    /measure_only must be true when present/u,
  );
  assert.match(budgetInputPolicyErrors(plan).join("\n"), /limits\.cost is measure-only, which only a delivery meter plan may use/u);
  // Budgets without measure-only metrics keep their shape and hash.
  const assessment = normalizeExecutionBudget(budgetInput());
  assert.equal(Object.values(assessment.limits).some((spec) => Object.hasOwn(spec, "measure_only")), false);
  assert.equal(normalizeExecutionBudget(budgetInput()).budget_hash, assessment.budget_hash);
});

test("money amounts add and compare exactly", () => {
  assert.equal(addMoneyAmounts("0.1", "0.2"), "0.3");
  assert.equal(addMoneyAmounts("1.10", "2"), "3.1");
  assert.equal(compareMoneyAmounts("2.20", "2.2"), 0);
  assert.equal(compareMoneyAmounts("2.21", "2.2"), 1);
  assert.equal(compareMoneyAmounts("0.05", "0.5"), -1);
});
