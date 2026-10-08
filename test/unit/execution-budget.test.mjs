import test from "node:test";
import assert from "node:assert/strict";

import {
  aggregateBudgetUsage,
  applyBudgetAmendment,
  buildBudgetAmendment,
  buildExecutionUsageReceipt,
  commitBudgetReservation,
  evaluateBudgetUsage,
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
