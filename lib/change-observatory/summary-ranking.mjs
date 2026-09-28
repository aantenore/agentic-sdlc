import { Date } from "../runtime/host.mjs";
const DEFAULT_POLICIES = Object.freeze({
  changed: Object.freeze({
    typeWeights: Object.freeze({ implementation: 120, sync: 0 }),
    actionWeights: Object.freeze({
      implementation: 40,
      "story.release": -100,
      "story.claim": -80,
    }),
    explanationBoost: 25,
    alternativesBoost: 10,
    evidenceBoost: 15,
  }),
  decided: Object.freeze({
    typeWeights: Object.freeze({ approval: 100, gate: 90, risk: 70, assumption: 60, decision: 40 }),
    actionWeights: Object.freeze({
      "contract.approve": 120,
      "authorization.grant": 90,
      "task.start.confirm": -120,
      "contract.story-link": -100,
    }),
    explanationBoost: 25,
    alternativesBoost: 25,
    evidenceBoost: 5,
  }),
});

export const DEFAULT_SUMMARY_RANKING = DEFAULT_POLICIES;

export function rankSummaryItems(items, role, overrides = {}) {
  if (!Array.isArray(items)) throw new TypeError("Summary items must be an array");
  const base = DEFAULT_POLICIES[role];
  if (!base) throw new TypeError(`Unknown summary ranking role: ${role}`);
  const policy = mergePolicy(base, overrides);
  return items
    .map((item, index) => ({ item, index, score: scoreItem(item, policy) }))
    .sort((left, right) => (
      right.score - left.score
      || timestampScore(right.item) - timestampScore(left.item)
      || left.index - right.index
    ))
    .map(({ item }) => item);
}

function mergePolicy(base, overrides) {
  if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new TypeError("Summary ranking overrides must be an object");
  }
  return {
    typeWeights: { ...base.typeWeights, ...normalizeWeightMap(overrides.typeWeights) },
    actionWeights: { ...base.actionWeights, ...normalizeWeightMap(overrides.actionWeights) },
    explanationBoost: normalizeWeight(overrides.explanationBoost, base.explanationBoost),
    alternativesBoost: normalizeWeight(overrides.alternativesBoost, base.alternativesBoost),
    evidenceBoost: normalizeWeight(overrides.evidenceBoost, base.evidenceBoost),
  };
}

function normalizeWeightMap(value) {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Summary ranking weight maps must be objects");
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, weight]) => [key, normalizeWeight(weight)]),
  );
}

function normalizeWeight(value, fallback = undefined) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError("Summary ranking weights must be finite numbers");
  }
  return value;
}

function scoreItem(item, policy) {
  const type = String(item?.type ?? "");
  const action = String(item?.action ?? "");
  return (policy.typeWeights[type] ?? 0)
    + (policy.actionWeights[action] ?? 0)
    + (item?.explanation?.text ? policy.explanationBoost : 0)
    + (item?.alternatives?.length ? policy.alternativesBoost : 0)
    + (item?.evidence?.length ? policy.evidenceBoost : 0);
}

function timestampScore(item) {
  const score = Date.parse(item?.timestamp ?? "");
  return Number.isFinite(score) ? score : 0;
}
