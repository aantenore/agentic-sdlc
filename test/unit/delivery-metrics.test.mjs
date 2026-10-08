import assert from "node:assert/strict";
import test from "node:test";

import {
  compareAmounts,
  deriveDeliveryLeadTime,
  describeDeliveryLeadTime,
  describeDeliveryUsage,
  formatCostAmount,
  formatDuration,
  summarizeDeliveryUsage,
  sumAmounts,
} from "../../lib/delivery-metrics.mjs";

const PROFILE = Object.freeze({
  id: "AUT-ONE",
  delivery_id: "LOCAL-ONE",
  delivery_kind: "local_release",
  status: "active",
  created_at: "2026-10-01T09:00:00.000Z",
  updated_at: "2026-10-01T09:20:00.000Z",
});

function action(overrides) {
  return {
    profile_ref: { id: "AUT-ONE" },
    action: "build.local",
    status: "authorized",
    outcome: null,
    checkpoint_required: true,
    approval: { approval_source: "standing-approval" },
    authorized_at: "2026-10-01T10:00:00.000Z",
    ...overrides,
  };
}

test("lead time lists each recorded stage up to the release and the total", () => {
  const leadTime = deriveDeliveryLeadTime({
    profile: PROFILE,
    approval: { created_at: "2026-10-01T09:30:00.000Z", approval: { approval_source: "explicit-user" } },
    start: { started_at: "2026-10-01T09:45:00.000Z" },
    actions: [
      action({ authorized_at: "2026-10-01T10:00:00.000Z" }),
      action({ action: "release.local", status: "completed", outcome: "passed", authorized_at: "2026-10-01T11:30:00.000Z" }),
      action({ profile_ref: { id: "AUT-OTHER" }, authorized_at: "2026-10-01T09:31:00.000Z" }),
    ],
    close: { closed_at: "2026-10-01T11:31:00.000Z", terminal_status: "closed" },
  });
  assert.equal(leadTime.status, "finished");
  assert.deepEqual(leadTime.finish, { milestone: "released", at: "2026-10-01T11:30:00.000Z", terminal_status: "closed" });
  assert.deepEqual(leadTime.stages, [
    { from: "proposed", to: "approved", seconds: 1800 },
    { from: "approved", to: "task_started", seconds: 900 },
    { from: "task_started", to: "first_action", seconds: 900 },
    { from: "first_action", to: "finished", seconds: 5400 },
  ]);
  assert.equal(leadTime.total_seconds, 9000);
  // A person approved the delivery directly: proposal to approval is waiting time.
  assert.equal(leadTime.waiting_for_person.seconds, 1800);
  assert.equal(leadTime.waiting_for_person.intervals[0].kind, "delivery_approval");
});

test("a pull request finishes when it is ready for review, and an open delivery has no total", () => {
  const ready = deriveDeliveryLeadTime({
    profile: { ...PROFILE, delivery_kind: "pull_request" },
    close: { closed_at: "2026-10-01T12:00:00.000Z", terminal_status: "ready_for_review" },
  });
  assert.equal(ready.finish.milestone, "ready_for_review");
  assert.equal(ready.total_seconds, 10_800);
  const open = deriveDeliveryLeadTime({ profile: PROFILE, start: { started_at: "2026-10-01T09:45:00.000Z" } });
  assert.equal(open.status, "in_progress");
  assert.equal(open.total_seconds, null);
  assert.equal(deriveDeliveryLeadTime({ profile: { ...PROFILE, status: "proposed", updated_at: null } }).status, "awaiting_approval");
  assert.equal(deriveDeliveryLeadTime({ profile: {} }).status, "unknown");
});

test("waiting for a person runs from a recorded confirmation request to that person's confirmation", () => {
  const fallback = (at, actionName) => ({
    action: "autonomy.standing.fallback",
    related: ["SA-1", "AUT-ONE", "LOCAL-ONE"],
    request: { id: `standing-approval:SA-1:fallback:AUT-ONE:${actionName}:20261001-abc` },
    created_at: at,
  });
  const leadTime = deriveDeliveryLeadTime({
    profile: PROFILE,
    approval: { created_at: "2026-10-01T09:30:00.000Z", approval: { approval_source: "standing-approval" } },
    actions: [
      action({ authorized_at: "2026-10-01T10:30:00.000Z", approval: { approval_source: "explicit-user" } }),
      action({ action: "rollback.verify", authorized_at: "2026-10-01T11:00:00.000Z", approval: { approval_source: "explicit-user" } }),
    ],
    events: [
      fallback("2026-10-01T10:10:00.000Z", "build.local"),
      fallback("2026-10-01T10:20:00.000Z", "build.local"),
      fallback("2026-10-01T09:59:00.000Z", "release.local"),
      { ...fallback("2026-10-01T10:05:00.000Z", "build.local"), related: ["SA-1", "AUT-OTHER"] },
    ],
  });
  // The earliest request after the previous confirmation counts, and the
  // standing-approval derived delivery approval is not a person's wait.
  assert.deepEqual(leadTime.waiting_for_person.intervals, [{
    kind: "action_confirmation",
    action: "build.local",
    requested_at: "2026-10-01T10:10:00.000Z",
    confirmed_at: "2026-10-01T10:30:00.000Z",
    seconds: 1200,
  }]);
  assert.equal(leadTime.waiting_for_person.unrecorded_requests, 1, "rollback.verify had no recorded request");
  assert.equal(leadTime.waiting_for_person.seconds, 1200);
});

test("durations and lead time read the same in English and Italian", () => {
  assert.equal(formatDuration(45), "45s");
  assert.equal(formatDuration(750), "12m 30s");
  assert.equal(formatDuration(3 * 3600 + 5 * 60), "3h 05m");
  assert.equal(formatDuration(2 * 86_400 + 3600), "2d 1h 00m");
  assert.equal(formatDuration(2 * 86_400 + 3600, { italian: true }), "2g 1h 00m");
  assert.equal(formatDuration(null), "not recorded");
  assert.equal(formatDuration(null, { italian: true }), "non registrato");
  const leadTime = deriveDeliveryLeadTime({
    profile: PROFILE,
    approval: { created_at: "2026-10-01T09:30:00.000Z", approval: { approval_source: "explicit-user" } },
    close: { closed_at: "2026-10-01T10:00:00.000Z", terminal_status: "ready_for_review" },
  });
  assert.deepEqual(describeDeliveryLeadTime(leadTime), [
    "Lead time: proposed → approved 30m 00s; approved → ready for review 30m 00s; total 1h 00m.",
    "Waiting for a person: 30m 00s over 1 confirmation.",
  ]);
  assert.deepEqual(describeDeliveryLeadTime(leadTime, { italian: true }), [
    "Tempo di consegna: proposta → approvata 30m 00s; approvata → pronta per la revisione 30m 00s; totale 1h 00m.",
    "In attesa di una persona: 30m 00s su 1 conferma.",
  ]);
});

const PLAN_USD = Object.freeze({ budget_hash: "a".repeat(64), limits: { tokens: {}, cost: { currency: "USD" } } });
const PLAN_BASE = Object.freeze({ budget_hash: "b".repeat(64), limits: { tokens: {} } });

function receipt(id, usage, overrides = {}) {
  return {
    id,
    budget_hash: PLAN_USD.budget_hash,
    usage,
    ended_at: `2026-10-01T10:0${id.at(-1)}:00.000Z`,
    source: { adapter: "manual-runtime-adapter", assurance: "manual_declared", aggregation: "delta" },
    ...overrides,
  };
}

test("usage adds deltas exactly, takes cumulative readings as they are, and tells metered from declared cost", () => {
  const summary = summarizeDeliveryUsage([
    receipt("R2", { tokens: 100, cost: "0.2" }, { source: { adapter: "codeburn", assurance: "advisory_observed", aggregation: "delta" } }),
    receipt("R1", { tokens: 50, cost: "0.1" }),
    receipt("R3", { tokens: 10 }, { budget_hash: PLAN_BASE.budget_hash }),
  ], [PLAN_USD, PLAN_BASE]);
  assert.deepEqual(summary.cost, { amount: "0.3", currency: "USD" });
  assert.equal(summary.tokens, 160);
  assert.equal(summary.cost_status, "metered");
  assert.equal(summary.metered_cost_receipts, 1);
  assert.deepEqual(summary.metered_sources, ["codeburn"]);
  assert.equal(summary.latest_metered_cost_at, "2026-10-01T10:02:00.000Z");
  const cumulative = summarizeDeliveryUsage([
    receipt("R1", { cost: "0.5" }),
    receipt("R2", { cost: "1.25" }, { source: { adapter: "signed", assurance: "trusted_attested", aggregation: "cumulative" } }),
  ], [PLAN_USD]);
  assert.equal(cumulative.cost.amount, "1.25");
  const declared = summarizeDeliveryUsage([receipt("R1", { cost: "2" })], [PLAN_USD]);
  assert.equal(declared.cost_status, "declared");
  assert.equal(declared.metered_cost_receipts, 0);
  const none = summarizeDeliveryUsage([], []);
  assert.equal(none.cost_status, "not_measured");
  assert.equal(none.cost, null);
  // A cost whose currency is unknown is not added up.
  const unknown = summarizeDeliveryUsage([receipt("R1", { cost: "2" }, { budget_hash: "c".repeat(64) })], [PLAN_USD]);
  assert.equal(unknown.cost, null);
  assert.equal(unknown.unreadable_values, true);
});

test("usage lines name the cost, how it was measured, and what is not measured", () => {
  const summary = summarizeDeliveryUsage([
    receipt("R1", { tokens: 1500, cost: "0.3" }, { source: { adapter: "codeburn", assurance: "advisory_observed", aggregation: "delta" } }),
  ], [PLAN_USD]);
  assert.deepEqual(describeDeliveryUsage(summary), ["Cost: USD 0.30 (measured by codeburn); 1500 tokens; 1 receipt."]);
  assert.deepEqual(describeDeliveryUsage(summary, { italian: true }), ["Costo: USD 0.30 (misurato da codeburn); token 1500; 1 ricevuta."]);
  assert.deepEqual(describeDeliveryUsage(summarizeDeliveryUsage([], [])), ["Cost: not measured (no usage recorded for this delivery)."]);
  assert.deepEqual(
    describeDeliveryUsage(summarizeDeliveryUsage([receipt("R1", { tokens: 5 }, { budget_hash: PLAN_BASE.budget_hash })], [PLAN_BASE]), { italian: true }),
    ["Costo: non misurato; token 5; 1 ricevuta."],
  );
});

test("amounts are added and compared as exact decimals", () => {
  assert.equal(sumAmounts(["0.1", "0.2"]), "0.3");
  assert.equal(sumAmounts(["1.005", 2, "0"]), "3.005");
  assert.equal(sumAmounts(["1e3"]), null);
  assert.equal(compareAmounts("0.30", 0.3), 0);
  assert.equal(compareAmounts("2.2", "2"), 1);
  assert.equal(compareAmounts("-1", "2"), null);
  assert.equal(formatCostAmount({ amount: "1.5", currency: "EUR" }), "EUR 1.50");
  assert.equal(formatCostAmount(null), null);
});
