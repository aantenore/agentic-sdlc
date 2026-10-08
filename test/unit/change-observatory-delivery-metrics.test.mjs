import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildObservatoryViewModel } from "../../lib/change-observatory/index.mjs";
import { normalizeItem } from "../../ui/change-observatory/model.js";
import { deliveryMetricsTexts, setLocale, standingBudgetText, t as translate } from "../../ui/change-observatory/i18n.js";
import { renderInspector, renderPrimary } from "../../ui/change-observatory/components.js";

const FIXED_TIME = "2026-10-08T09:00:00.000Z";
const TECHNICAL_ONLY = /\b(?:bounded-autonomous|checkpoint(?:ed|_required)|audit_only|host_verified|profile|receipt|ceiling|schema|hash|reason[ _-]?code|AUT-[A-Z0-9-]+)\b/iu;

async function createProject(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "change-observatory-delivery-metrics-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function writeJson(root, relativePath, value) {
  const target = path.join(root, ...relativePath.split("/"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeJsonLines(root, relativePath, values) {
  const target = path.join(root, ...relativePath.split("/"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${values.map((value) => JSON.stringify(value)).join("\n")}\n`, "utf8");
}

/** One released delivery under a standing approval, with a metered cost. */
async function deliveryProject(t) {
  const root = await createProject(t);
  const hash = (character) => character.repeat(64);
  await writeJson(root, ".sdlc/project.json", { schema_version: "0.1.0", project_id: "metrics", project_name: "Metrics" });
  await writeJson(root, ".sdlc/autonomy/deliveries/AUT-ONE.json", {
    kind: "delivery_execution_profile",
    schema_version: "delivery-execution-profile:v2",
    id: "AUT-ONE",
    status: "active",
    delivery_id: "LOCAL-ONE",
    delivery_kind: "local_release",
    story_refs: [{ id: "ST-ONE", hash: hash("1") }],
    approval_ref: { id: "AUT-APR-1", path: ".sdlc/autonomy/approvals/AUT-APR-1.json", hash: hash("2") },
    created_at: "2026-10-01T09:00:00.000Z",
    updated_at: "2026-10-01T09:05:00.000Z",
    extensions: { standing_approval_ref: { id: "SA-1", record_hash: hash("3") } },
  });
  await writeJson(root, ".sdlc/autonomy/approvals/AUT-APR-1.json", {
    kind: "autonomy_profile_approval",
    approval: { approval_source: "standing-approval", created_at: "2026-10-01T09:05:00.000Z" },
    created_at: "2026-10-01T09:05:00.000Z",
  });
  await writeJson(root, ".sdlc/autonomy/executions/AUT-ONE/start.json", { started_at: "2026-10-01T09:10:00.000Z" });
  await writeJson(root, ".sdlc/autonomy/executions/AUT-ONE/close.json", { closed_at: "2026-10-01T10:31:00.000Z", terminal_status: "closed" });
  await writeJson(root, ".sdlc/autonomy/actions/AUT-ACT-1.json", {
    profile_ref: { id: "AUT-ONE" },
    action: "build.local",
    status: "authorized",
    checkpoint_required: true,
    approval: { approval_source: "explicit-user" },
    authorized_at: "2026-10-01T09:30:00.000Z",
  });
  await writeJson(root, ".sdlc/autonomy/actions/AUT-ACT-2.json", {
    profile_ref: { id: "AUT-ONE" },
    action: "release.local",
    status: "completed",
    outcome: "passed",
    authorized_at: "2026-10-01T10:30:00.000Z",
  });
  await writeJsonLines(root, ".sdlc/traces/ST-ONE.jsonl", [{
    id: "TR-1",
    story_id: "ST-ONE",
    type: "gate",
    action: "autonomy.standing.fallback",
    summary: "Standing approval SA-1 does not cover build.local",
    related: ["SA-1", "AUT-ONE", "LOCAL-ONE"],
    request: { id: "standing-approval:SA-1:fallback:AUT-ONE:build.local:20261001-aa" },
    created_at: "2026-10-01T09:20:00.000Z",
  }]);
  await writeJson(root, ".sdlc/autonomy/metering/AUT-ONE/plans/DELIVERY-METER-AUT-ONE-USD.json", {
    kind: "execution_budget",
    id: "DELIVERY-METER-AUT-ONE-USD",
    budget_hash: hash("a"),
    limits: { tokens: { unit: "tokens", measure_only: true }, cost: { unit: "money", currency: "USD", measure_only: true } },
  });
  await writeJson(root, ".sdlc/autonomy/metering/AUT-ONE/usage/USAGE-1.json", {
    kind: "execution_usage_receipt",
    id: "USAGE-1",
    execution_id: "AUT-ONE",
    budget_hash: hash("a"),
    usage: { tokens: 1200, cost: "0.4" },
    ended_at: "2026-10-01T09:25:00.000Z",
    source: { adapter: "codeburn", assurance: "advisory_observed", aggregation: "delta" },
  });
  await writeJson(root, ".sdlc/autonomy/standing/SA-1/proposal.json", {
    kind: "standing_approval",
    id: "SA-1",
    work_kind: { recipe_id: "flag-cleanup", description: "Remove one retired flag" },
    max_deliveries: 2,
    expires_at: "2026-10-20T00:00:00.000Z",
    budget: { currency: "USD", per_delivery_amount: "1.5", total_amount: "2" },
  });
  await writeJson(root, ".sdlc/autonomy/standing/SA-1/approval.json", { kind: "standing_approval_decision", decision: "approved" });
  await writeJson(root, ".sdlc/autonomy/standing/SA-1/uses/0001.json", {
    kind: "standing_approval_use",
    slot: 1,
    max_deliveries: 2,
    delivery: { id: "LOCAL-ONE", kind: "local_release" },
    profile_ref: { id: "AUT-ONE", hash: hash("4") },
  });
  return root;
}

test("the observatory derives each delivery's lead time and cost from its records", async (t) => {
  const root = await deliveryProject(t);
  const model = await buildObservatoryViewModel(root, { clock: () => new Date(FIXED_TIME) });
  const delivery = model.decisions.find((item) => item.type === "delivery-execution-profile" && item.id === "AUT-ONE");
  assert.deepEqual(delivery.deliveryMetrics, {
    leadTime: {
      status: "finished",
      finish: "released",
      stages: [
        { from: "proposed", to: "approved", seconds: 300 },
        { from: "approved", to: "task_started", seconds: 300 },
        { from: "task_started", to: "first_action", seconds: 1200 },
        { from: "first_action", to: "finished", seconds: 3600 },
      ],
      totalSeconds: 5400,
      waitingSeconds: 600,
      waitingConfirmations: 1,
      unrecordedRequests: 0,
    },
    // The Observatory verifies no meter evidence, so the meter's figure is labelled unverified.
    cost: { status: "unverified", amount: "0.4", currency: "USD", tokens: 1200, receipts: 1, sources: [] },
  });
  const standing = model.decisions.find((item) => item.type === "standing-approval");
  assert.deepEqual(standing.standingBudget, {
    currency: "USD",
    perDelivery: "1.5",
    total: "2",
    spent: "0.4",
    deliveries: 1,
    notMeasured: 0,
    verified: false,
  });
  assert.match(standing.summary, /1 of 2 deliveries used, 1 left; [\s\S]*Cost recorded so far, not verified here: USD 0\.40 of USD 2\.00\./u);
});

test("a delivery without usage shows its cost as not measured", async (t) => {
  const root = await deliveryProject(t);
  await fs.rm(path.join(root, ".sdlc", "autonomy", "metering"), { recursive: true, force: true });
  const model = await buildObservatoryViewModel(root, { clock: () => new Date(FIXED_TIME) });
  const delivery = model.decisions.find((item) => item.id === "AUT-ONE");
  assert.equal(delivery.deliveryMetrics.cost.status, "not_measured");
  assert.equal(delivery.deliveryMetrics.cost.amount, null);
  const standing = model.decisions.find((item) => item.type === "standing-approval");
  assert.equal(standing.standingBudget.spent, "0");
  assert.equal(standing.standingBudget.notMeasured, 1);
  assert.match(standing.summary, /USD 0\.00 of USD 2\.00; 1 without a meter reading\./u);
});

class FakeNode {
  constructor(tagName = null, text = "") {
    this.tagName = tagName;
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.className = "";
    this._text = String(text ?? "");
  }

  append(...children) {
    this.children.push(...children.filter((child) => child !== null && child !== undefined));
  }

  replaceChildren(...children) {
    for (const child of children) assert.notEqual(child, null, "no empty inspector section is rendered");
    this.children = children;
    this._text = "";
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  get textContent() {
    return `${this._text}${this.children.map((child) => child.textContent ?? "").join("")}`;
  }

  set textContent(value) {
    this._text = String(value ?? "");
    this.children = [];
  }
}

function fakeDocument() {
  return {
    createElement: (tagName) => new FakeNode(tagName),
    createElementNS: (_namespace, tagName) => new FakeNode(tagName),
    createTextNode: (text) => new FakeNode(null, text),
  };
}

function primaryText(root) {
  const read = (current) => {
    if (current?.tagName === "details") return "";
    return `${current?._text ?? ""}${(current?.children ?? []).map(read).join("")}`;
  };
  return read(root);
}

function descendants(root, predicate) {
  const found = [];
  const visit = (current) => {
    if (predicate(current)) found.push(current);
    for (const child of current?.children ?? []) visit(child);
  };
  visit(root);
  return found;
}

test("the browser shows lead time and cost in English and Italian, as plain text", async (t) => {
  const root = await deliveryProject(t);
  const model = await buildObservatoryViewModel(root, { clock: () => new Date(FIXED_TIME) });
  const delivery = normalizeItem(model.decisions.find((item) => item.id === "AUT-ONE"));
  const standing = normalizeItem(model.decisions.find((item) => item.type === "standing-approval"));
  const previousDocument = globalThis.document;
  globalThis.document = fakeDocument();
  t.after(() => {
    globalThis.document = previousDocument;
    setLocale("en");
  });

  setLocale("en");
  assert.deepEqual(deliveryMetricsTexts(delivery.deliveryMetrics), {
    leadTime: "1h 30m",
    stages: [
      "proposed → approved: 5m 00s",
      "approved → work started: 5m 00s",
      "work started → first action: 20m 00s",
      "first action → released: 1h 00m",
    ],
    waiting: "10m 00s over 1 confirmation",
    cost: "USD 0.40 · reported by a meter, not verified here",
    tokens: "1200 tokens",
    compact: "Lead time: 1h 30m · Cost: USD 0.40",
  });
  assert.equal(standingBudgetText(standing.standingBudget), "Recorded so far, not verified here, USD 0.40 over 1 delivery; limit USD 1.50 per delivery and USD 2.00 in total.");
  assert.equal(standingBudgetText({ ...standing.standingBudget, verified: true }), "Spent so far USD 0.40 over 1 delivery; limit USD 1.50 per delivery and USD 2.00 in total.");
  setLocale("it");
  assert.equal(deliveryMetricsTexts(delivery.deliveryMetrics).compact, "Tempo di consegna: 1h 30m · Costo: USD 0.40");
  assert.equal(deliveryMetricsTexts(delivery.deliveryMetrics).stages[3], "prima azione → rilasciata: 1h 00m");
  assert.equal(standingBudgetText(standing.standingBudget), "Registrato finora, non verificato qui, USD 0.40 su 1 consegna; limite USD 1.50 per consegna e USD 2.00 in tutto.");
  assert.match(deliveryMetricsTexts(delivery.deliveryMetrics).cost, /riportato da un contatore, non verificato qui/u);

  for (const locale of ["en", "it"]) {
    setLocale(locale);
    const inspector = new FakeNode("aside");
    renderInspector(inspector, delivery);
    const text = primaryText(inspector);
    assert.match(text, new RegExp(translate("Delivery time and cost"), "u"), locale);
    assert.match(text, locale === "it" ? /Tempo di consegna1h 30m/u : /Lead time1h 30m/u, locale);
    assert.match(text, /USD 0\.40/u, locale);
    assert.doesNotMatch(text, TECHNICAL_ONLY, locale);

    const standingInspector = new FakeNode("aside");
    renderInspector(standingInspector, standing);
    assert.match(primaryText(standingInspector), locale === "it" ? /Registrato finora, non verificato qui, USD 0\.40/u : /Recorded so far, not verified here, USD 0\.40/u, locale);

    const list = new FakeNode("main");
    renderPrimary(list, { decisions: [delivery, standing] }, { view: "decisions", selectedId: null, filters: {} });
    const metrics = descendants(list, (current) => String(current.className).split(/\s+/u).includes("record-metrics"));
    assert.equal(metrics.length, 2, locale);
    for (const row of metrics) assert.doesNotMatch(row.textContent, TECHNICAL_ONLY, locale);
  }
});

test("malformed metrics are dropped or neutralized before rendering", () => {
  const item = normalizeItem({
    id: "AUT-X",
    type: "delivery-execution-profile",
    deliveryMetrics: {
      leadTime: { status: "bogus", stages: [{ from: "proposed", to: "<script>", seconds: 5 }], totalSeconds: -1 },
      cost: { status: "metered", amount: "1e3", currency: "usd", tokens: 1.5 },
    },
    standingBudget: { currency: "not a code" },
  });
  assert.deepEqual(item.deliveryMetrics.leadTime.stages, []);
  assert.equal(item.deliveryMetrics.leadTime.status, "unknown");
  assert.equal(item.deliveryMetrics.leadTime.totalSeconds, null);
  assert.equal(item.deliveryMetrics.cost.amount, null);
  assert.equal(item.deliveryMetrics.cost.currency, null);
  assert.equal(item.deliveryMetrics.cost.tokens, null);
  assert.equal(item.standingBudget, undefined);
  setLocale("en");
  assert.equal(deliveryMetricsTexts(item.deliveryMetrics).cost, "Not measured");
});
