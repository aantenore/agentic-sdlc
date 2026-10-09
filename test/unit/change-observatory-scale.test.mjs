import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { orderKnowledgeBaseEntries } from "../../lib/change-observatory/constants.mjs";
import { compactEdges, readDependencyEdges } from "../../lib/change-observatory/dependency-edges.mjs";
import { readTrackedSharedClaims } from "../../lib/change-observatory/shared-claims.mjs";
import { renderPrimary } from "../../ui/change-observatory/components.js";
import { setLocale } from "../../ui/change-observatory/i18n.js";
import {
  INSIGHT_SETTINGS,
  applyDependencies,
  applySharedClaims,
  changeRequestLinks,
  normalizeSearchText,
  planLayout,
  relatedChain,
  searchScore,
  storyInsights,
} from "../../ui/change-observatory/insights.js";
import { normalizeViewModel } from "../../ui/change-observatory/model.js";
import { defaultExploreState } from "../../ui/change-observatory/visuals.js";
import { BrowserNode, createChangeObservatoryBrowser } from "../helpers/change-observatory-browser-dom.mjs";

const FIXTURE = new URL("../fixtures/change-observatory/view-model.json", import.meta.url);

function useBrowserDocument(t) {
  const previousDocument = globalThis.document;
  const originalAppend = BrowserNode.prototype.append;
  globalThis.document = createChangeObservatoryBrowser("http://127.0.0.1/").document;
  BrowserNode.prototype.append = function strictAppend(...children) {
    assert.ok(children.every((child) => child !== null && child !== undefined));
    return originalAppend.apply(this, children);
  };
  t.after(() => {
    BrowserNode.prototype.append = originalAppend;
    globalThis.document = previousDocument;
    setLocale("en");
  });
}

// The fixture project repeated until it holds `count` stories.
async function largeModel(count) {
  const raw = JSON.parse(await readFile(FIXTURE, "utf8"));
  const template = raw.iterations[0];
  raw.iterations = Array.from({ length: count }, (_, index) => ({
    ...template,
    id: `ST-BULK-${String(index).padStart(4, "0")}`,
    storyId: `ST-BULK-${String(index).padStart(4, "0")}`,
    title: `Bulk story ${index}`,
  }));
  return normalizeViewModel(raw);
}

function story(id, state, extra = {}) {
  return { id, state, iteration: { id, title: id, ...extra.iteration }, lastActivity: null, ...extra };
}

test("search ignores accents, case, and ID punctuation and ranks the ID first", () => {
  assert.equal(normalizeSearchText("  Città-Già  ST_REPLAN-001 "), "citta gia st replan 001");
  const exact = { id: "ST-REPLAN-001", title: "Riprogrammazione" };
  const mention = { id: "ST-REPLAN-003", title: "CR su REQ-REPLAN-001: imprevisti" };
  const text = { id: "ST-OTHER", title: "Altro", summary: "riguarda replan 001" };
  assert.equal(searchScore(exact, "replan 001"), 4);
  assert.equal(searchScore(mention, "replan 001"), 3);
  assert.equal(searchScore(text, "replan 001"), 1);
  assert.equal(searchScore(exact, "riprogrammazione"), 3);
  assert.equal(searchScore(exact, "RIPROGRAMMAZIONÉ"), 3);
  assert.equal(searchScore(exact, "missing"), 0);
});

test("claims from other computers mark stories as being worked on or finished", () => {
  const stories = [story("ST-A", "idle"), story("ST-B", "open"), story("ST-C", "delivered"), story("ST-D", "idle")];
  const result = applySharedClaims(stories, [
    { storyId: "ST-A", state: "claimed", agent: "agent" },
    { storyId: "ST-B", state: "completed", completion: "closed" },
    { storyId: "ST-C", state: "claimed" },
  ]);
  assert.equal(result[0].state, "live");
  assert.equal(result[0].holder.agent, "agent");
  assert.equal(result[1].state, "stopped");
  assert.equal(result[2].state, "delivered", "a delivered story keeps its recorded state");
  assert.equal(result[3], stories[3]);
  assert.equal(applySharedClaims(stories, []), stories);
});

test("a change request links to the stories that delivered its requirement", () => {
  const stories = changeRequestLinks([
    story("ST-REPLAN-001", "delivered", { iteration: { dossier: { links: { requirementIds: ["REQ-REPLAN-001"] } } } }),
    story("ST-REPLAN-003", "live", { iteration: { title: "CR su REQ-REPLAN-001: imprevisti", dossier: { links: { requirementIds: ["REQ-REPLAN-003"] } } } }),
  ]);
  assert.deepEqual(stories[0].changedBy, ["ST-REPLAN-003"]);
  assert.deepEqual(stories[1].changes, ["ST-REPLAN-001"]);
});

test("indexed dependency helpers keep their results on a large plan", () => {
  const stories = Array.from({ length: 2000 }, (_, index) => story(`ST-${index}`, index % 3 ? "idle" : "delivered"));
  const edges = stories.slice(1).map((entry, index) => ({ from: entry.id, to: stories[Math.floor(index / 2)].id }));
  const started = performance.now();
  const linked = applyDependencies(stories, edges);
  const plan = planLayout(linked, edges);
  const chain = relatedChain("ST-0", edges);
  assert.ok(performance.now() - started < 2000, "a 2000-story plan is laid out quickly");
  assert.deepEqual(linked[3].prerequisites, ["ST-1"]);
  assert.deepEqual(linked[1].dependents, ["ST-3", "ST-4"]);
  assert.equal(plan.columns.flat().length, 2000);
  assert.equal(chain.size, 2000);
});

test("long story lists render one page at a time", async (t) => {
  useBrowserDocument(t);
  const model = await largeModel(INSIGHT_SETTINGS.storyPageSize * 2 + 5);
  const explore = defaultExploreState();
  const container = globalThis.document.createElement("main");
  renderPrimary(container, model, { view: "stories", selectedId: null, filters: {}, explore });
  assert.equal(container.querySelectorAll(".story-row").length, INSIGHT_SETTINGS.storyPageSize);
  assert.ok(container.querySelector('[data-action="timeline-more"]'));
  explore.pages = 3;
  renderPrimary(container, model, { view: "stories", selectedId: null, filters: {}, explore });
  assert.equal(container.querySelectorAll(".story-row").length, storyInsights(model).length);
  assert.equal(container.querySelector('[data-action="timeline-more"]'), null);
});

test("a very large plan hides finished work until asked", async (t) => {
  useBrowserDocument(t);
  const model = await largeModel(INSIGHT_SETTINGS.planStoryLimit + 10);
  const ids = storyInsights(model).map((entry) => entry.id);
  const dependencies = ids.slice(1).map((id) => ({ from: id, to: ids[0] }));
  const explore = defaultExploreState();
  const container = globalThis.document.createElement("main");
  renderPrimary(container, model, { view: "map", selectedId: null, filters: {}, explore, dependencies });
  const shown = container.querySelectorAll(".plan-node").length;
  assert.ok(shown > 0 && shown <= ids.length);
  explore.planAll = true;
  renderPrimary(container, model, { view: "map", selectedId: null, filters: {}, explore, dependencies });
  assert.equal(container.querySelectorAll(".plan-node").length, ids.length);
});

test("the knowledge base is read stories first so limits never hide them", () => {
  const names = ["autonomy", "gates", "reports", "stories", "project.json", "traces", "requirements"];
  const ordered = orderKnowledgeBaseEntries(names.map((name) => ({ name }))).map((entry) => entry.name);
  assert.deepEqual(ordered, ["project.json", "stories", "requirements", "traces", "autonomy", "gates", "reports"]);
});

test("dependency edges are served compactly and survive graphs above the preview limit", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "observatory-deps-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal((await readDependencyEdges(root).catch((error) => error)).statusCode, 404, "no knowledge base");
  await mkdir(path.join(root, ".sdlc", "dependencies"), { recursive: true });
  assert.deepEqual((await readDependencyEdges(root)).found, false);
  const padding = "x".repeat(2_000);
  const edges = Array.from({ length: 800 }, (_, index) => ({ from: `ST-${index + 1}`, to: `ST-${index}`, status: "approved", rationale: padding }));
  edges.push({ from: "ST-A", to: "ST-A" }, { from: "ST-B", to: "ST-C", status: "rejected" }, { from: "ST-1", to: "ST-0" });
  await writeFile(path.join(root, ".sdlc", "dependencies", "graph.json"), JSON.stringify({ edges }));
  const result = await readDependencyEdges(root);
  assert.equal(result.found, true);
  assert.equal(result.edges.length, 800);
  assert.deepEqual(result.edges[0], { from: "ST-1", to: "ST-0", status: "approved" });
  assert.deepEqual(compactEdges({ edges: [{ from: " ST-X ", to: "ST-Y" }] }), [{ from: "ST-X", to: "ST-Y" }]);
  await writeFile(path.join(root, ".sdlc", "dependencies", "graph.json"), "{");
  assert.match((await readDependencyEdges(root)).error, /not valid JSON/);
});

test("shared claims are read from local tracking refs only", () => {
  const empty = readTrackedSharedClaims("/nowhere", { listRefs: () => ({ refs: [] }) });
  assert.deepEqual(empty.claims, []);
  const failed = readTrackedSharedClaims("/nowhere", { listRefs: () => ({ error: "boom" }) });
  assert.deepEqual(failed.claims, []);
  assert.ok(failed.error);
});
