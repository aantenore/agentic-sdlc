import assert from "node:assert/strict";
import test from "node:test";

import {
  displayTextForItem,
  localizePlaceholder,
  setLocale,
  t as translate,
} from "../../ui/change-observatory/i18n.js";
import {
  renderInspector,
  renderPrimary,
  renderSummary,
} from "../../ui/change-observatory/components.js";
import {
  DOSSIER_SCHEMA,
  MODEL_PLACEHOLDERS,
  PHASES,
  VIEW_MODEL_SCHEMA,
  normalizeViewModel,
} from "../../ui/change-observatory/model.js";
import {
  BrowserNode,
  createChangeObservatoryBrowser,
} from "../helpers/change-observatory-browser-dom.mjs";

const SHARED_SENTENCE = {
  en: "This project item is available as recorded project information.",
  it: "Questa voce è disponibile come informazione registrata sul progetto.",
};

function useBrowserDocument(t) {
  const previousDocument = globalThis.document;
  const originalAppend = BrowserNode.prototype.append;
  globalThis.document = createChangeObservatoryBrowser("http://127.0.0.1/").document;
  // A real DOM renders a null child as the text "null"; fail instead.
  BrowserNode.prototype.append = function strictAppend(...children) {
    assert.ok(
      children.every((child) => child !== null && child !== undefined),
      "components must not append null or undefined children",
    );
    return originalAppend.apply(this, children);
  };
  t.after(() => {
    BrowserNode.prototype.append = originalAppend;
    globalThis.document = previousDocument;
    setLocale("en");
  });
}

function occurrences(text, fragment) {
  return text.split(fragment).length - 1;
}

function hasClass(node, className) {
  return String(node?.className ?? "").split(/\s+/u).includes(className);
}

function linkedItem(id, type, title, status = "approved") {
  return {
    id,
    type,
    title,
    summary: `${title} summary.`,
    status,
    provenance: "recorded",
    storyId: "ST-MVP",
    sourceRefs: [{ path: `.sdlc/evidence/${id}.json` }],
    linkage: {
      status: "linked",
      storyId: "ST-MVP",
      via: ["story_id"],
      sourceRefs: [{ path: `.sdlc/evidence/${id}.json` }],
    },
  };
}

function modelWithDossier(lanes) {
  return normalizeViewModel({
    schemaVersion: VIEW_MODEL_SCHEMA,
    project: { id: "travelops", name: "TravelOps" },
    summary: { asked: [], changed: [], decided: [] },
    iterations: [{
      id: "ST-MVP",
      type: "iteration",
      title: "Delivered story",
      summary: "Delivered story summary.",
      status: "ready",
      provenance: "recorded",
      currentPhase: "release",
      timestamp: "2026-09-30T10:12:00.000Z",
      sourceRefs: [{ path: ".sdlc/stories/ST-MVP/story.json" }],
      phases: PHASES.map((phase) => ({ phase, status: "complete", provenance: "recorded", sourceRefs: [] })),
      dossier: {
        schemaVersion: DOSSIER_SCHEMA,
        storyId: "ST-MVP",
        iterationId: "ST-MVP",
        status: "complete",
        provenance: "recorded",
        sourceRefs: [{ path: ".sdlc/stories/ST-MVP/story.json" }],
        lanes,
        diagnostics: [],
      },
    }],
    contracts: [],
    decisions: [],
    changes: [],
    verification: [],
    records: [],
    diagnostics: [],
  });
}

function recordedLane(items) {
  return { status: "recorded", provenance: "recorded", items };
}

test("dossier cards explain each kind of recorded state once per view in English and Italian", (t) => {
  useBrowserDocument(t);
  const model = modelWithDossier({
    asked: recordedLane([linkedItem("REQ-001", "requirement", "Plan trips")]),
    decided: recordedLane([
      linkedItem("DEC-001", "decision", "Use local providers"),
      linkedItem("DEC-002", "decision", "Pending choice", "proposed"),
      linkedItem("DEC-003", "decision", "Second pending choice", "proposed"),
      {
        ...linkedItem("AUT-DEL-001", "delivery-execution-profile", "Delivery agreement", "active"),
      },
    ]),
    contract: recordedLane([linkedItem("CONTRACT-001", "contract", "Delivery contract")]),
    done: recordedLane([
      linkedItem("CHANGE-001", "implementation", "Build planner", "completed"),
      { ...linkedItem("TRACE-001", "trace", "Untracked status"), status: undefined },
      { ...linkedItem("TRACE-002", "trace", "Another untracked status"), status: undefined },
    ]),
    verified: recordedLane([linkedItem("TEST-001", "test", "Planner tests", "passed")]),
    release: recordedLane([linkedItem("REL-001", "release", "Local release", "released")]),
  });
  const proposalOutcome = {
    en: "This project item is a proposal and has not been accepted yet.",
    it: "Questa voce del progetto è una proposta e non è ancora stata accettata.",
  };
  const missingStatusOutcome = {
    en: "A recorded answer is available, but this item does not declare a current status.",
    it: "È disponibile una risposta registrata, ma questa voce non dichiara uno stato corrente.",
  };

  for (const locale of ["en", "it"]) {
    setLocale(locale);
    const container = globalThis.document.createElement("main");
    renderPrimary(container, model, { view: "timeline", selectedId: null, filters: {} });

    const shared = container.querySelectorAll(".human-guidance-shared");
    assert.equal(shared.length, 1, `${locale}/one shared explanation`);
    assert.equal(shared[0].tagName, "details", `${locale}/shared explanation is collapsible`);
    assert.deepEqual(
      shared[0].querySelectorAll(".human-guidance-kind").map((kind) => kind.dataset.guidance),
      ["recorded", "proposed", "status_missing"],
      locale,
    );
    for (const kind of shared[0].querySelectorAll(".human-guidance-kind")) {
      assert.equal(kind.querySelectorAll("dt").length, 5, `${locale}/${kind.dataset.guidance}/five fields`);
    }
    assert.equal(occurrences(container.textContent, SHARED_SENTENCE[locale]), 1, locale);

    const cards = container.querySelectorAll(".dossier-item");
    assert.equal(cards.length, 11, locale);
    const fullGuidance = cards.filter((card) => card.querySelector(".human-guidance"));
    assert.equal(fullGuidance.length, 1, `${locale}/only the delivery agreement keeps full guidance`);
    assert.match(fullGuidance[0].textContent, /Delivery agreement|consegna|delivery/iu, locale);

    const notices = cards
      .map((card) => card.querySelector(".human-guidance-notice"))
      .filter(Boolean);
    assert.deepEqual(
      notices.map((notice) => notice.dataset.guidance).sort(),
      ["proposed", "proposed", "status_missing", "status_missing"],
      `${locale}/cautionary states keep a visible notice on the card`,
    );
    for (const notice of notices) {
      const expected = notice.dataset.guidance === "proposed" ? proposalOutcome : missingStatusOutcome;
      assert.equal(notice.textContent, expected[locale], locale);
    }
    // Each full explanation appears once (shared block) plus the one-line notices.
    assert.equal(occurrences(container.textContent, proposalOutcome[locale]), 3, locale);
    for (const card of cards) {
      assert.ok(card.querySelector(".dossier-item-title").textContent, `${locale}/title stays visible`);
      assert.ok(card.querySelector(".dossier-item-summary").textContent, `${locale}/summary stays visible`);
    }
  }
});

test("dossier with only delivery-control records renders no shared explanation", (t) => {
  useBrowserDocument(t);
  setLocale("en");
  const model = modelWithDossier({
    decided: recordedLane([linkedItem("AUT-DEL-001", "delivery-execution-profile", "Agreement", "proposed")]),
  });
  const container = globalThis.document.createElement("main");
  renderPrimary(container, model, { view: "timeline", selectedId: null, filters: {} });
  assert.equal(container.querySelectorAll(".human-guidance-shared").length, 0);
  const cards = container.querySelectorAll(".dossier-item");
  assert.equal(cards.length, 1);
  assert.ok(cards[0].querySelector(".human-guidance"), "the agreement keeps its own guidance");
});

test("summary answers share one explanation while the inspector keeps the full guidance", (t) => {
  useBrowserDocument(t);
  const items = [
    linkedItem("REQ-001", "requirement", "Plan trips"),
    linkedItem("CHANGE-001", "implementation", "Build planner", "completed"),
    linkedItem("DEC-001", "decision", "Use local providers"),
  ];
  for (const locale of ["en", "it"]) {
    setLocale(locale);
    const summary = globalThis.document.createElement("section");
    renderSummary(summary, { summary: { asked: [items[0]], changed: [items[1]], decided: [items[2]] } });
    const articles = summary.children.filter((child) => child.tagName === "article");
    assert.equal(articles.length, 3, locale);
    for (const article of articles) {
      assert.equal(article.querySelector(".human-guidance"), null, `${locale}/card guidance is shared`);
      assert.ok(article.querySelector(".summary-recorded-answer"), `${locale}/recorded answer stays prominent`);
    }
    const shared = summary.children.filter((child) => hasClass(child, "summary-shared-guidance"));
    assert.equal(shared.length, 1, locale);
    assert.equal(shared[0].querySelectorAll("dt").length, 5, `${locale}/all five fields remain available`);
    assert.equal(occurrences(summary.textContent, SHARED_SENTENCE[locale]), 1, locale);

    const inspector = globalThis.document.createElement("aside");
    renderInspector(inspector, items[0]);
    const guidance = inspector.querySelectorAll(".human-guidance");
    assert.equal(guidance.length, 1, `${locale}/inspector guidance`);
    assert.equal(inspector.querySelectorAll(".human-guidance-shared").length, 0, locale);
    assert.match(guidance[0].textContent, new RegExp(SHARED_SENTENCE[locale], "u"), locale);
  }
});

test("every browser-model placeholder has an Italian translation", (t) => {
  t.after(() => setLocale("en"));
  setLocale("it");
  for (const placeholder of MODEL_PLACEHOLDERS) {
    assert.notEqual(translate(placeholder), placeholder, placeholder);
    assert.equal(localizePlaceholder(placeholder), translate(placeholder), placeholder);
  }
  assert.equal(localizePlaceholder("Iteration 3"), "Iterazione 3");
  assert.equal(localizePlaceholder("Design"), "Design", "recorded values are never translated");
  setLocale("en");
  for (const placeholder of MODEL_PLACEHOLDERS) assert.equal(localizePlaceholder(placeholder), placeholder);
});

test("truncated-list notices are fully translated in Italian", (t) => {
  t.after(() => setLocale("en"));
  setLocale("it");
  for (const [english, italian] of [
    ["Showing 6 of 8. Open the dedicated view for the complete history.", "Visualizzati 6 di 8. Apri la vista dedicata per la cronologia completa."],
    ["Showing 6 of 8. Open Changes for the complete history.", "Visualizzati 6 di 8. Apri Modifiche per la cronologia completa."],
    ["Showing 6 of 27. Open Verification for the complete history.", "Visualizzati 6 di 27. Apri Verifica per la cronologia completa."],
    ["Showing 2 of 3.", "Visualizzati 2 di 3."],
  ]) {
    assert.equal(translate(english), italian);
  }
});

test("missing summaries and generated labels follow the Italian locale", (t) => {
  useBrowserDocument(t);
  const [item] = normalizeViewModel({
    schemaVersion: VIEW_MODEL_SCHEMA,
    summary: { asked: [{ id: "REQ-EMPTY", type: "requirement", title: "Empty request", status: "approved" }] },
  }).summary.asked;
  assert.equal(item.summary, "No recorded summary.");

  setLocale("en");
  assert.equal(displayTextForItem(item).summary, "No recorded summary.");
  setLocale("it");
  assert.equal(displayTextForItem(item).summary, "Nessun riepilogo registrato.");

  const summary = globalThis.document.createElement("section");
  renderSummary(summary, { summary: { asked: [item], changed: [], decided: [] } });
  assert.doesNotMatch(summary.textContent, /No recorded summary/u);
  assert.match(summary.textContent, /Nessun riepilogo registrato\./u);

  const model = modelWithDossier({
    decided: recordedLane([{
      ...linkedItem("DEC-001", "decision", "Use local providers"),
      narrative: {
        rationaleSummary: "Keep providers local.",
        generatedExplanation: "Local providers avoid tenant access.",
        explanationSource: "codex-generated",
        provenance: "recorded",
      },
    }]),
  });
  model.iterations[0].title = "TravelOps MVP";
  model.iterations[0].summary = "No recorded summary.";
  model.semanticObservations = [];
  const timeline = globalThis.document.createElement("main");
  renderPrimary(timeline, model, { view: "timeline", selectedId: null, filters: {} });
  const meta = timeline.querySelector(".dossier-meta");
  assert.match(meta.textContent, /TravelOps MVP/u, "recorded titles keep their spelling");
  assert.match(meta.textContent, /Nessun riepilogo registrato\./u);
  assert.doesNotMatch(timeline.textContent, /No recorded summary|Generated explanation|Source recorded/u);
  const options = timeline.querySelectorAll("option").map((option) => option.textContent);
  assert.ok(options.includes("TravelOps MVP"), "iteration options are not re-cased");
});
