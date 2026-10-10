import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { renderPrimary } from "../../ui/change-observatory/components.js";
import { setLocale } from "../../ui/change-observatory/i18n.js";
import {
  activityBuckets,
  applyDependencies,
  checkOutcome,
  filterEvents,
  lineageGraph,
  normalizeDependencyEdges,
  planLayout,
  projectEvents,
  relatedChain,
  storyInsights,
  storyState,
} from "../../ui/change-observatory/insights.js";
import { displayTextForItem, humanizeRecordedText, readableRecordedTitle } from "../../ui/change-observatory/i18n.js";
import { isActionableDiagnostic } from "../../ui/change-observatory/components.js";
import { normalizeViewModel, recordSelectionKey } from "../../ui/change-observatory/model.js";
import { defaultExploreState } from "../../ui/change-observatory/visuals.js";
import {
  BrowserNode,
  createChangeObservatoryBrowser,
} from "../helpers/change-observatory-browser-dom.mjs";

const FIXTURE = new URL("../fixtures/change-observatory/view-model.json", import.meta.url);

async function fixtureModel() {
  return normalizeViewModel(JSON.parse(await readFile(FIXTURE, "utf8")));
}

function useBrowserDocument(t) {
  const previousDocument = globalThis.document;
  const originalAppend = BrowserNode.prototype.append;
  globalThis.document = createChangeObservatoryBrowser("http://127.0.0.1/").document;
  BrowserNode.prototype.append = function strictAppend(...children) {
    assert.ok(
      children.every((child) => child !== null && child !== undefined),
      "visual views must not append null or undefined children",
    );
    return originalAppend.apply(this, children);
  };
  t.after(() => {
    BrowserNode.prototype.append = originalAppend;
    globalThis.document = previousDocument;
    setLocale("en");
  });
}

function item(id, type, extra = {}) {
  return {
    id,
    type,
    title: id,
    summary: null,
    status: null,
    timestamp: null,
    provenance: "recorded",
    sourceRefs: [{ path: `.sdlc/traces/${id}.jsonl`, line: 1 }],
    related: [],
    storyId: null,
    ...extra,
  };
}

function phases(statuses) {
  return ["discovery", "analysis", "design", "implementation", "validation", "release", "operations"]
    .map((phase, index) => ({ phase, status: statuses[index] ?? "missing", provenance: "recorded", sourceRefs: [] }));
}

test("one recorded entry shared by two collections appears once in the activity stream", () => {
  const shared = { sourceRefs: [{ path: ".sdlc/traces/ST-A.jsonl", line: 4 }], storyId: "ST-A" };
  const events = projectEvents({
    summary: { asked: [] },
    contracts: [],
    changes: [],
    decisions: [item("TR-1", "approval", { ...shared, timestamp: "2026-07-01T10:00:00Z" })],
    verification: [item("TR-1", "gate", { ...shared, timestamp: "2026-07-01T10:00:00Z" })],
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "decision");
});

test("story state follows recorded phases and never invents progress", () => {
  assert.equal(storyState({ status: "ready", phases: phases(["complete", "inProgress"]) }), "live");
  assert.equal(storyState({ status: "ready", phases: phases(["complete", "blocked"]) }), "blocked");
  assert.equal(storyState({ status: "released", phases: phases(["complete"]) }), "delivered");
  assert.equal(storyState({ status: "ready", phases: phases(["complete"]) }), "open");
  assert.equal(storyState({ status: "draft", phases: phases([]) }), "idle");
  assert.equal(storyState({ status: "superseded", phases: phases(["inProgress"]) }), "stopped");
});

test("check outcomes read the recorded status conservatively", () => {
  assert.equal(checkOutcome({ status: "passed" }), "passed");
  assert.equal(checkOutcome({ status: "failed" }), "failed");
  assert.equal(checkOutcome({ status: "passed_locally_pending_remote_matrix" }), "pending");
  assert.equal(checkOutcome({ status: "checkpoint_required" }), "pending");
  assert.equal(checkOutcome({ status: null }), "recorded");
});

test("activity buckets end at the latest event and pick hours, days, or weeks by span", () => {
  const at = (iso, kind = "decision") => ({ kind, time: Date.parse(iso) });
  const hourly = activityBuckets([at("2026-07-01T10:05:00Z"), at("2026-07-01T13:40:00Z", "check")]);
  assert.equal(hourly.unit, "hour");
  assert.equal(hourly.buckets.length, 4, "one bar per hour, so a single busy day never collapses");
  assert.equal(hourly.buckets.at(-1).counts.check, 1);
  const daily = activityBuckets([at("2026-07-01T10:00:00Z"), at("2026-07-06T09:00:00Z", "check")]);
  assert.equal(daily.unit, "day");
  assert.ok(daily.buckets.length >= 5 && daily.buckets.length <= 7);
  assert.equal(daily.buckets.at(-1).counts.check, 1);
  const long = activityBuckets([at("2026-01-01T00:00:00Z"), at("2026-07-03T09:00:00Z")], { count: 4 });
  assert.equal(long.unit, "week");
  assert.equal(long.buckets.length, 4);
  assert.equal(long.buckets.reduce((sum, bucket) => sum + bucket.total, 0), 1, "older events fall outside the window");
  assert.deepEqual(activityBuckets([]).buckets, []);
});

test("recorded dependencies add a waiting state, a plan order, and a highlightable chain", () => {
  const edges = normalizeDependencyEdges({
    edges: [
      { from: "ST-B", to: "ST-A", type: "blocks", required_state: "merged" },
      { from: "ST-C", to: "ST-B" },
      { from: "ST-C", to: "ST-B" },
      { from: "ST-D", to: "ST-D" },
      { from: "ST-E", to: "ST-A", status: "rejected" },
    ],
  });
  assert.deepEqual(edges.map((edge) => `${edge.from}>${edge.to}`), ["ST-B>ST-A", "ST-C>ST-B"]);
  const now = Date.parse("2026-07-01T12:00:00Z");
  const base = (id, state, lastActivity = null) => ({ id, state, lastActivity, iteration: { id, title: id }, phases: [] });
  const stories = applyDependencies([
    base("ST-A", "live", now - 3_600_000),
    base("ST-B", "idle"),
    base("ST-C", "idle"),
    base("ST-D", "delivered"),
  ], edges, { now, recentHours: 6 });
  const byId = new Map(stories.map((story) => [story.id, story]));
  assert.equal(byId.get("ST-B").state, "waiting");
  assert.deepEqual(byId.get("ST-B").waitingOn, ["ST-A"]);
  assert.deepEqual(byId.get("ST-A").dependents, ["ST-B"]);
  assert.equal(byId.get("ST-A").recent, true);
  assert.equal(byId.get("ST-D").state, "delivered", "a delivered story never becomes waiting");
  const plan = planLayout(stories, edges);
  assert.deepEqual(plan.columns.map((column) => column.map((story) => story.id).sort()), [["ST-A", "ST-D"], ["ST-B"], ["ST-C"]]);
  assert.deepEqual([...relatedChain("ST-B", edges)].sort(), ["ST-A", "ST-B", "ST-C"]);
});

test("recorded text drops or translates only its technical fragments", () => {
  assert.equal(
    humanizeRecordedText("Approved checkpointed autonomy for pull_request PR-UX-001 on main"),
    "Approved step-by-step autonomy for pull request on main",
  );
  assert.equal(humanizeRecordedText("Use npm test before continuing."), "Use a command before continuing.");
  assert.equal(humanizeRecordedText("Completed git.push for exact delivery PR-CAT-001"), "Completed push for exact delivery");
  assert.equal(humanizeRecordedText("APR-20261009155944347-f4a10d"), null);
});

test("closed and claimed stories follow the same rules as status", () => {
  const phasesOf = (statuses) => phases(statuses);
  assert.equal(storyState({ status: "ready", closure: { event: "superseded", replacementId: "ST-B" }, phases: phasesOf(["complete", "inProgress"]) }), "replaced");
  assert.equal(storyState({ status: "ready", closure: { event: "cancelled" }, phases: phasesOf([]) }), "stopped");
  assert.equal(storyState({ status: "ready", claimed: true, phases: phasesOf(["complete", "complete", "complete"]) }), "live");
});

test("a recorded closure keeps its reason and the headline counts closed stories apart", async (t) => {
  useBrowserDocument(t);
  const raw = JSON.parse(await readFile(FIXTURE, "utf8"));
  raw.iterations[0] = { ...raw.iterations[0], closure: { event: "cancelled", reason: "Abbandonata: sostituita da ST-B" } };
  const model = normalizeViewModel(raw);
  assert.equal(model.iterations[0].closure.reason, "Abbandonata: sostituita da ST-B");
  setLocale("it");
  const container = globalThis.document.createElement("main");
  renderPrimary(container, model, { view: "overview", selectedId: null, filters: {}, explore: defaultExploreState() });
  setLocale("en");
  assert.match(container.textContent, /\d+ consegnate · 1 chiuse · \d+ in corso\/da fare/u);
});

test("only diagnostics a reader can act on raise the evidence banner", () => {
  assert.equal(isActionableDiagnostic({ code: "schema_version_missing", severity: "info" }), false);
  assert.equal(isActionableDiagnostic({ code: "dossier_link_target_missing", severity: "warning" }), false);
  assert.equal(isActionableDiagnostic({ code: "invalid_json", severity: "warning" }), true);
  assert.equal(isActionableDiagnostic({ code: "file_too_large", severity: "error" }), true);
});

test("titles that start with record IDs keep their readable part", () => {
  assert.equal(readableRecordedTitle("CR su REQ-EDIT-001: modifiche richieste ampliate"), "Modifiche richieste ampliate");
  assert.equal(readableRecordedTitle("Preferenze del viaggio"), "Preferenze del viaggio");
  assert.equal(readableRecordedTitle("REQ-EDIT-001"), null);
});

test("timeline filters combine search, kind, story, and period", () => {
  const events = projectEvents({
    summary: { asked: [] },
    contracts: [],
    changes: [item("CH-1", "implementation", { summary: "Add login page", storyId: "ST-A", timestamp: "2026-07-02T00:00:00Z" })],
    decisions: [item("DE-1", "decision", { summary: "Use local providers", storyId: "ST-B", timestamp: "2026-07-05T00:00:00Z" })],
    verification: [],
  });
  assert.equal(filterEvents(events, { query: "login" }).length, 1);
  assert.equal(filterEvents(events, { kinds: new Set(["decision"]) })[0].item.id, "DE-1");
  assert.equal(filterEvents(events, { storyId: "ST-A" })[0].item.id, "CH-1");
  const range = { start: Date.parse("2026-07-04T00:00:00Z"), end: Date.parse("2026-07-06T00:00:00Z") };
  assert.deepEqual(filterEvents(events, { range }).map((event) => event.item.id), ["DE-1"]);
});

test("the lineage map draws only recorded links", () => {
  const decision = item("DE-1", "decision", { storyId: "ST-A", related: ["CH-1", "NOT-IN-GRAPH"] });
  const change = item("CH-1", "implementation", { storyId: "ST-A" });
  const unrelated = item("CH-2", "implementation", { storyId: "ST-B" });
  const model = {
    summary: { asked: [] },
    contracts: [],
    changes: [change, unrelated],
    decisions: [decision],
    verification: [],
    iterations: [{ id: "ST-A", type: "story", title: "Story A", status: "ready", phases: phases(["complete"]), requirementIds: [], sourceRefs: [] }],
  };
  const [story] = storyInsights(model);
  const graph = lineageGraph(story, model);
  const keys = graph.columns.flatMap((column) => column.nodes.map((entry) => entry.key));
  assert.ok(keys.includes(recordSelectionKey(decision)));
  assert.ok(keys.includes(recordSelectionKey(change)));
  assert.ok(!keys.includes(recordSelectionKey(unrelated)), "another story's change stays off the map");
  assert.deepEqual(
    graph.edges.filter((edge) => edge.kind === "related"),
    [{ from: recordSelectionKey(decision), to: recordSelectionKey(change), kind: "related" }],
  );
});

test("dashboard, stories, timeline, and map render in English and Italian", async (t) => {
  useBrowserDocument(t);
  const model = await fixtureModel();
  for (const locale of ["en", "it"]) {
    setLocale(locale);
    for (const view of ["overview", "stories", "activity", "map"]) {
      const container = globalThis.document.createElement("main");
      const state = { view, selectedId: null, filters: {}, explore: defaultExploreState() };
      renderPrimary(container, model, state);
      assert.ok(container.textContent.length > 0, `${locale}/${view}`);
      if (locale === "it") {
        assert.doesNotMatch(
          container.textContent,
          /Happening now|Latest activity|Search the timeline|Lineage map|Each row is one piece of work|Cosa devi decidere/u,
          `${locale}/${view} has no untranslated chrome`,
        );
      }
    }
  }
});

test("the map opens on the project plan when dependencies are recorded", async (t) => {
  useBrowserDocument(t);
  const model = await fixtureModel();
  const [first, second] = storyInsights(model);
  const dependencies = [{ from: second.id, to: first.id, blocks: "analysis", requiredState: "merged" }];
  for (const locale of ["en", "it"]) {
    setLocale(locale);
    const explore = defaultExploreState();
    const container = globalThis.document.createElement("main");
    renderPrimary(container, model, { view: "map", selectedId: null, filters: {}, explore, dependencies });
    assert.equal(container.querySelectorAll(".plan-node").length, storyInsights(model).length, locale);
    assert.equal(container.querySelectorAll(".plan-edge").length, 1);
    explore.planFocus = second.id;
    renderPrimary(container, model, { view: "map", selectedId: null, filters: {}, explore, dependencies });
    assert.ok(container.querySelector(".plan-focus"), "the selected story gets its own action bar");
    explore.mapMode = "story";
    renderPrimary(container, model, { view: "map", selectedId: null, filters: {}, explore, dependencies });
    assert.equal(container.querySelectorAll(".plan-node").length, 0);
    assert.ok(container.querySelectorAll(".map-node").length > 0);
  }
});

test("work in progress pulses and an expanded story lists its own activity", async (t) => {
  useBrowserDocument(t);
  setLocale("en");
  const model = await fixtureModel();
  const explore = defaultExploreState();
  const container = globalThis.document.createElement("main");
  renderPrimary(container, model, { view: "overview", selectedId: null, filters: {}, explore });
  assert.ok(container.querySelectorAll(".is-live").length > 0, "an in-progress phase is marked live");

  const live = storyInsights(model).find((story) => story.state === "live");
  explore.expanded.add(live.id);
  renderPrimary(container, model, { view: "stories", selectedId: null, filters: {}, explore });
  const row = container.querySelectorAll(".story-row").find((entry) => entry.dataset.storyId === live.id);
  assert.ok(row.querySelector(".story-body"), "the expanded story shows its body");
  assert.ok(row.querySelector('[data-action="open-map"]'));
  assert.ok(row.querySelector('[data-action="open-dossier"]'));
});

test("navigation adds the visual views and keeps every existing view address", async () => {
  const html = await readFile(new URL("../../ui/change-observatory/index.html", import.meta.url), "utf8");
  for (const view of [
    "overview", "stories", "activity", "map",
    "timeline", "contracts", "decisions", "changes", "intent-evidence", "verification",
  ]) {
    assert.match(html, new RegExp(`data-view="${view}"`, "u"), view);
  }
  assert.match(html, /data-action="toggle-live"[^>]*aria-pressed="false"/u);
});

test("summaries keep story and request IDs and records without a title still say what happened", () => {
  assert.equal(
    humanizeRecordedText("Riviste le modifiche di ST-WEB-003 (merge 77e2440) in evidence/ST-WEB-003.md", { keepWorkIds: true }),
    "Riviste le modifiche di ST-WEB-003 (merge 77e2440) in a file",
  );
  assert.equal(humanizeRecordedText("Linked story ST-A to contract contract-ST-A-implementation"), "Linked story to contract");
  assert.equal(humanizeRecordedText("Ended (AUT-PR-A cancelled)"), "Ended (cancelled)");
  const titleOf = (record) => displayTextForItem({ status: "missing", provenance: "recorded", ...record });
  assert.equal(titleOf({ id: "OVR-1", title: "OVR-1", summary: "Riviste le modifiche di ST-B." }).title, "Changes from other stories reviewed");
  assert.equal(titleOf({ id: "STEP-ST-A-validation-1", type: "story-step", phase: "validation", title: "STEP-ST-A-validation-1" }).title, "Step completed: Validation");
  assert.equal(titleOf({ id: "TR-1", type: "gate", action: "git.push", title: "TR-1" }).title, "Change shared");
  const artifact = titleOf({
    id: "story-artifact:.sdlc/stories/ST-A/evidence/AUT-PR-A-pr-merge.json",
    type: "story-artifact",
    title: null,
    summary: "No recorded summary.",
    sourceRefs: [{ path: ".sdlc/stories/ST-A/evidence/AUT-PR-A-pr-merge.json" }],
  });
  assert.deepEqual([artifact.title, artifact.summary], ["Change merged", ""]);
});
