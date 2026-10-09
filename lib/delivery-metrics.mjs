import {
  addMoneyAmounts,
  compareMoneyAmounts,
  normalizeMoneyDecimal,
} from "./execution-budget.mjs";
import { Date } from "./runtime/host.mjs";

/**
 * Lead time and usage of one delivery, derived only from records that the
 * lifecycle already wrote: the delivery choice, its approval, the start, close,
 * and action receipts, the story trace, and the delivery's usage receipts.
 * Everything here is pure; reading the records lives in the engine and in the
 * Change Observatory, which share these rules so both show the same numbers.
 */

export const DELIVERY_MILESTONES = Object.freeze([
  "proposed",
  "approved",
  "task_started",
  "first_action",
  "finished",
]);

/** Metrics a delivery meter plan measures; cost is added with its currency. */
export const DELIVERY_METER_METRICS = Object.freeze({
  active_time_seconds: "seconds",
  steps: "steps",
  tokens: "tokens",
  input_tokens: "tokens",
  output_tokens: "tokens",
  cache_read_tokens: "tokens",
  cache_write_tokens: "tokens",
  model_calls: "calls",
  tool_calls: "calls",
});

const STANDING_FALLBACK_ACTION = "autonomy.standing.fallback";
const PERSON_APPROVAL_SOURCES = new Set(["explicit-user"]);
const METERED_ASSURANCES = new Set(["advisory_observed", "trusted_attested"]);

function instantMs(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoOrNull(value) {
  const ms = instantMs(value);
  return ms === null ? null : new Date(ms).toISOString();
}

function secondsBetween(fromIso, toIso) {
  const from = instantMs(fromIso);
  const to = instantMs(toIso);
  if (from === null || to === null || to < from) return null;
  return Math.floor((to - from) / 1000);
}

function earliest(values) {
  return values
    .map(isoOrNull)
    .filter(Boolean)
    .sort()[0] || null;
}

function latest(values) {
  return values
    .map(isoOrNull)
    .filter(Boolean)
    .sort()
    .at(-1) || null;
}

/** The action a standing-approval fallback event asked a person to confirm. */
function fallbackActionFor(event, profileId) {
  const requestId = String(event?.request?.id || "");
  const marker = `:fallback:${profileId}:`;
  const start = requestId.indexOf(marker);
  if (start < 0) return null;
  const rest = requestId.slice(start + marker.length);
  const end = rest.indexOf(":");
  return end > 0 ? rest.slice(0, end) : null;
}

/**
 * Lead time of one delivery. Inputs are the recorded objects, all optional
 * except the profile:
 * - approval: the approval envelope the active profile references
 * - start, close: the delivery start and close receipts
 * - actions: every delivery action receipt of this profile
 * - events: trace events of the delivery's story (only standing-approval
 *   fallback events are read, as the time a confirmation was requested)
 */
export function deriveDeliveryLeadTime({
  profile,
  approval = null,
  start = null,
  close = null,
  actions = [],
  events = [],
} = {}) {
  const profileId = String(profile?.id || "");
  const approvedAt = isoOrNull(approval?.created_at)
    || (profile?.status === "active" ? isoOrNull(profile?.updated_at) : null);
  const ownActions = (Array.isArray(actions) ? actions : [])
    .filter((receipt) => receipt?.profile_ref?.id === profileId);
  const released = ownActions
    .filter((receipt) => receipt.action === "release.local" && receipt.status === "completed" && receipt.outcome === "passed")
    .map((receipt) => receipt.authorized_at);
  const releasedAt = earliest(released);
  const closedAt = isoOrNull(close?.closed_at);
  const terminalStatus = close?.terminal_status || null;
  let finish = null;
  if (releasedAt && (!closedAt || releasedAt <= closedAt)) {
    finish = { milestone: "released", at: releasedAt, terminal_status: terminalStatus };
  } else if (closedAt) {
    finish = {
      milestone: ["ready_for_review", "merged_externally"].includes(terminalStatus) ? terminalStatus : "closed",
      at: closedAt,
      terminal_status: terminalStatus,
    };
  }
  const milestones = {
    proposed: isoOrNull(profile?.created_at),
    approved: approvedAt,
    task_started: isoOrNull(start?.started_at),
    first_action: earliest(ownActions.map((receipt) => receipt.authorized_at)),
    finished: finish?.at || null,
  };
  const present = DELIVERY_MILESTONES
    .filter((id) => milestones[id])
    .map((id) => ({ id, at: milestones[id] }));
  const stages = [];
  for (let index = 1; index < present.length; index += 1) {
    const from = present[index - 1];
    const to = present[index];
    stages.push({ from: from.id, to: to.id, seconds: secondsBetween(from.at, to.at) });
  }
  const totalSeconds = milestones.proposed && finish ? secondsBetween(milestones.proposed, finish.at) : null;
  const status = finish
    ? "finished"
    : milestones.approved
      ? (milestones.task_started ? "in_progress" : "approved")
      : milestones.proposed
        ? "awaiting_approval"
        : "unknown";
  return {
    status,
    milestones,
    finish,
    stages,
    total_seconds: totalSeconds,
    waiting_for_person: deriveWaitingForPerson({ profileId, milestones, approval, actions: ownActions, events }),
  };
}

/**
 * Time the delivery waited for a person: from the delivery proposal to its
 * approval when a person approved it directly, and from each recorded
 * confirmation request (a standing approval that did not cover a step) to the
 * person's confirmation of that same step. A confirmation whose request time
 * was never recorded is counted, not guessed.
 */
function deriveWaitingForPerson({ profileId, milestones, approval, actions, events }) {
  const intervals = [];
  const approvalSource = approval?.approval?.approval_source || null;
  if (PERSON_APPROVAL_SOURCES.has(approvalSource) && milestones.proposed && milestones.approved) {
    intervals.push({
      kind: "delivery_approval",
      action: null,
      requested_at: milestones.proposed,
      confirmed_at: milestones.approved,
      seconds: secondsBetween(milestones.proposed, milestones.approved),
    });
  }
  const requests = (Array.isArray(events) ? events : [])
    .filter((event) => event?.action === STANDING_FALLBACK_ACTION
      && (event.related || []).includes(profileId)
      && instantMs(event.created_at) !== null)
    .map((event) => ({ action: fallbackActionFor(event, profileId), at: isoOrNull(event.created_at) }))
    .filter((request) => request.action)
    .sort((left, right) => (left.at < right.at ? -1 : left.at > right.at ? 1 : 0));
  const confirmations = actions
    .filter((receipt) => receipt.status === "authorized"
      && receipt.checkpoint_required === true
      && PERSON_APPROVAL_SOURCES.has(receipt.approval?.approval_source)
      && instantMs(receipt.authorized_at) !== null)
    .sort((left, right) => String(left.authorized_at).localeCompare(String(right.authorized_at)));
  let unrecordedRequests = 0;
  const previousByAction = new Map();
  for (const receipt of confirmations) {
    const confirmedAt = isoOrNull(receipt.authorized_at);
    const after = previousByAction.get(receipt.action) || "";
    const request = requests.find((candidate) => candidate.action === receipt.action
      && candidate.at > after
      && candidate.at <= confirmedAt);
    previousByAction.set(receipt.action, confirmedAt);
    if (!request) {
      unrecordedRequests += 1;
      continue;
    }
    intervals.push({
      kind: "action_confirmation",
      action: receipt.action,
      requested_at: request.at,
      confirmed_at: confirmedAt,
      seconds: secondsBetween(request.at, confirmedAt),
    });
  }
  return {
    seconds: intervals.reduce((total, interval) => total + (interval.seconds || 0), 0),
    intervals,
    unrecorded_requests: unrecordedRequests,
  };
}

/** "2d 3h 05m", "3h 05m", "12m 30s", "45s"; Italian uses "g" for days. */
export function formatDuration(seconds, { italian = false } = {}) {
  if (!Number.isFinite(seconds) || seconds < 0) return italian ? "non registrato" : "not recorded";
  const whole = Math.floor(seconds);
  const days = Math.floor(whole / 86_400);
  const hours = Math.floor((whole % 86_400) / 3_600);
  const minutes = Math.floor((whole % 3_600) / 60);
  const rest = whole % 60;
  const pad = (value) => String(value).padStart(2, "0");
  if (days > 0) return `${days}${italian ? "g" : "d"} ${hours}h ${pad(minutes)}m`;
  if (hours > 0) return `${hours}h ${pad(minutes)}m`;
  if (minutes > 0) return `${minutes}m ${pad(rest)}s`;
  return `${rest}s`;
}

const MILESTONE_LABELS = Object.freeze({
  proposed: ["proposed", "proposta"],
  approved: ["approved", "approvata"],
  task_started: ["work started", "lavoro avviato"],
  first_action: ["first action", "prima azione"],
  finished: ["finished", "conclusa"],
  released: ["released", "rilasciata"],
  ready_for_review: ["ready for review", "pronta per la revisione"],
  merged_externally: ["merged outside the plugin", "unita fuori dal plugin"],
  closed: ["closed", "chiusa"],
});

function milestoneLabel(id, italian, finish = null) {
  const key = id === "finished" && finish ? finish.milestone : id;
  return (MILESTONE_LABELS[key] || [key, key])[italian ? 1 : 0];
}

/** Human lines for one delivery's lead time, in English or Italian. */
export function describeDeliveryLeadTime(leadTime, { italian = false } = {}) {
  if (!leadTime || leadTime.status === "unknown") {
    return [italian ? "Tempo di consegna: non registrato." : "Lead time: not recorded."];
  }
  const stages = leadTime.stages
    .map((stage) => `${milestoneLabel(stage.from, italian, leadTime.finish)} → ${milestoneLabel(stage.to, italian, leadTime.finish)} ${formatDuration(stage.seconds, { italian })}`)
    .join("; ");
  const total = leadTime.total_seconds !== null
    ? (italian ? `totale ${formatDuration(leadTime.total_seconds, { italian })}` : `total ${formatDuration(leadTime.total_seconds)}`)
    : (italian ? "ancora in corso" : "still in progress");
  const lines = [
    `${italian ? "Tempo di consegna" : "Lead time"}: ${stages || (italian ? "solo proposta" : "proposed only")}; ${total}.`,
  ];
  const waiting = leadTime.waiting_for_person;
  if (waiting) {
    const unrecorded = waiting.unrecorded_requests > 0
      ? (italian
        ? ` (${waiting.unrecorded_requests} ${waiting.unrecorded_requests === 1 ? "conferma senza" : "conferme senza"} ora di richiesta registrata)`
        : ` (${waiting.unrecorded_requests} ${waiting.unrecorded_requests === 1 ? "confirmation" : "confirmations"} without a recorded request time)`)
      : "";
    lines.push(italian
      ? `In attesa di una persona: ${formatDuration(waiting.seconds, { italian })} su ${waiting.intervals.length} ${waiting.intervals.length === 1 ? "conferma" : "conferme"}${unrecorded}.`
      : `Waiting for a person: ${formatDuration(waiting.seconds)} over ${waiting.intervals.length} ${waiting.intervals.length === 1 ? "confirmation" : "confirmations"}${unrecorded}.`);
  }
  return lines;
}

function canonicalAmount(value) {
  try {
    return normalizeMoneyDecimal(typeof value === "number" ? String(value) : value);
  } catch {
    return null;
  }
}

function quantityValue(value) {
  if (Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^(?:0|[1-9]\d*)$/u.test(value)) {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : null;
  }
  return null;
}

/**
 * Totals of a delivery's usage receipts, following the budget rules: receipts
 * are taken in time order, a delta adds to the running value and a cumulative
 * reading replaces it. `plans` are the delivery's meter plans, which carry the
 * cost currency. A cost counts as metered only when its receipt claims a
 * meter (an adapter observation or a trusted signed source) and its id is in
 * `verifiedReceiptIds`, the receipts whose evidence the caller verified. A
 * claim nobody verified is reported as unverified, and a manual declaration
 * as declared.
 */
export function summarizeDeliveryUsage(receipts = [], plans = [], { verifiedReceiptIds = null } = {}) {
  const verified = verifiedReceiptIds instanceof Set ? verifiedReceiptIds : new Set();
  const currencyByPlan = new Map((Array.isArray(plans) ? plans : [])
    .filter((plan) => plan?.budget_hash)
    .map((plan) => [plan.budget_hash, plan.limits?.cost?.currency || null]));
  const ordered = [...(Array.isArray(receipts) ? receipts : [])]
    .filter((receipt) => receipt && typeof receipt === "object")
    .sort((left, right) => String(left.ended_at || "").localeCompare(String(right.ended_at || ""))
      || String(left.id || "").localeCompare(String(right.id || "")));
  const metrics = {};
  let cost = null;
  const currencies = new Set();
  let unreadable = false;
  let costReceipts = 0;
  let meteredCostReceipts = 0;
  let unverifiedCostReceipts = 0;
  let latestMeteredCostAt = null;
  let latestMeteredReceipt = null;
  const meteredSources = new Set();
  for (const receipt of ordered) {
    const usage = receipt.usage && typeof receipt.usage === "object" ? receipt.usage : {};
    const cumulative = receipt.source?.aggregation === "cumulative";
    for (const [metric, raw] of Object.entries(usage)) {
      if (metric === "cost") {
        const amount = canonicalAmount(raw);
        const currency = currencyByPlan.get(receipt.budget_hash) || receipt.pricing_ref?.currency || null;
        if (amount === null || !currency) {
          unreadable = true;
          continue;
        }
        currencies.add(currency);
        costReceipts += 1;
        cost = cumulative || cost === null ? amount : addMoneyAmounts(cost, amount);
        if (METERED_ASSURANCES.has(receipt.source?.assurance) && verified.has(receipt.id)) {
          meteredCostReceipts += 1;
          meteredSources.add(String(receipt.source?.adapter || "unknown"));
          const endedAt = isoOrNull(receipt.ended_at);
          if (endedAt && (!latestMeteredCostAt || endedAt > latestMeteredCostAt)) {
            latestMeteredCostAt = endedAt;
            latestMeteredReceipt = receipt;
          }
        } else if (METERED_ASSURANCES.has(receipt.source?.assurance)) {
          unverifiedCostReceipts += 1;
        }
        continue;
      }
      const value = quantityValue(raw);
      if (value === null) {
        unreadable = true;
        continue;
      }
      metrics[metric] = cumulative || metrics[metric] === undefined ? value : metrics[metric] + value;
    }
  }
  const mixedCurrencies = currencies.size > 1;
  return {
    receipt_count: ordered.length,
    latest_receipt_at: latest(ordered.map((receipt) => receipt.ended_at)),
    metrics,
    tokens: metrics.tokens ?? (metrics.input_tokens !== undefined || metrics.output_tokens !== undefined
      ? (metrics.input_tokens || 0) + (metrics.output_tokens || 0)
      : null),
    cost: cost !== null && !mixedCurrencies ? { amount: cost, currency: [...currencies][0] } : null,
    cost_status: costReceipts === 0
      ? "not_measured"
      : mixedCurrencies
        ? "mixed_currencies"
        : meteredCostReceipts > 0 ? "metered" : unverifiedCostReceipts > 0 ? "unverified" : "declared",
    cost_receipts: costReceipts,
    metered_cost_receipts: meteredCostReceipts,
    unverified_cost_receipts: unverifiedCostReceipts,
    latest_metered_cost_at: latestMeteredCostAt,
    latest_metered_receipt_id: latestMeteredReceipt?.id ?? null,
    metered_sources: [...meteredSources].sort(),
    unreadable_values: unreadable,
  };
}

/** "USD 1.25", with at least two decimals. */
export function formatCostAmount(cost) {
  if (!cost?.amount || !cost?.currency) return null;
  const [whole, fraction = ""] = String(cost.amount).split(".");
  return `${cost.currency} ${whole}.${fraction.padEnd(2, "0")}`;
}

/** Human line for one delivery's recorded usage, in English or Italian. */
export function describeDeliveryUsage(summary, { italian = false } = {}) {
  if (!summary || summary.receipt_count === 0) {
    return [italian
      ? "Costo: non misurato (nessun utilizzo registrato per questa consegna)."
      : "Cost: not measured (no usage recorded for this delivery)."];
  }
  const tokens = summary.tokens !== null && summary.tokens !== undefined
    ? (italian ? `; token ${summary.tokens}` : `; ${summary.tokens} tokens`)
    : (italian ? "; token non misurati" : "; tokens not measured");
  const receipts = italian
    ? `${summary.receipt_count} ${summary.receipt_count === 1 ? "ricevuta" : "ricevute"}`
    : `${summary.receipt_count} ${summary.receipt_count === 1 ? "receipt" : "receipts"}`;
  let cost;
  if (summary.cost_status === "not_measured") {
    cost = italian ? "non misurato" : "not measured";
  } else if (summary.cost_status === "mixed_currencies") {
    cost = italian ? "registrato in più valute, quindi non sommabile" : "recorded in more than one currency, so it cannot be added up";
  } else {
    const how = summary.cost_status === "metered"
      ? (italian ? `misurato da ${summary.metered_sources.join(", ")}` : `measured by ${summary.metered_sources.join(", ")}`)
      : summary.cost_status === "unverified"
        ? (italian ? "riportato da un contatore, non verificato" : "reported by a meter, not verified")
        : (italian ? "dichiarato a mano, non misurato da un contatore" : "declared by hand, not measured by a meter");
    cost = `${formatCostAmount(summary.cost)} (${how})`;
  }
  return [`${italian ? "Costo" : "Cost"}: ${cost}${tokens}; ${receipts}.`];
}

/** Exact sum of decimal amounts; null when any amount cannot be read exactly. */
export function sumAmounts(amounts) {
  let total = "0";
  for (const amount of amounts) {
    const canonical = canonicalAmount(amount);
    if (canonical === null) return null;
    total = addMoneyAmounts(total, canonical);
  }
  return total;
}

/** Exact comparison of two amounts given as decimal strings or plain numbers; null when unreadable. */
export function compareAmounts(left, right) {
  const leftAmount = canonicalAmount(left);
  const rightAmount = canonicalAmount(right);
  if (leftAmount === null || rightAmount === null) return null;
  return compareMoneyAmounts(leftAmount, rightAmount);
}

export { canonicalAmount };
