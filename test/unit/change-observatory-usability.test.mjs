import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { ObservatoryApiError } from "../../ui/change-observatory/api.js";
import {
  renderDiagnostics,
  renderInspector,
  renderKnowledgeBaseMissing,
  renderPrimary,
  renderSummary,
} from "../../ui/change-observatory/components.js";
import {
  displayTextForItem,
  localizedErrorGuidance,
  setLocale,
  t,
} from "../../ui/change-observatory/i18n.js";
import { normalizeViewModel } from "../../ui/change-observatory/model.js";
import {
  createChangeObservatoryBrowser,
  waitForBrowser,
} from "../helpers/change-observatory-browser-dom.mjs";

const UI_ROOT = new URL("../../ui/change-observatory/", import.meta.url);

function withBrowser(t_, url = "http://127.0.0.1:43127/#overview") {
  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    fetch: globalThis.fetch,
  };
  const browser = createChangeObservatoryBrowser(url);
  globalThis.document = browser.document;
  globalThis.window = browser.window;
  t_.after(() => {
    globalThis.document = previous.document;
    globalThis.window = previous.window;
    globalThis.fetch = previous.fetch;
    setLocale("en");
  });
  return browser;
}

function viewPayload(overrides = {}) {
  const path = ".sdlc/changes/CHANGE-ONE.json";
  const change = {
    id: "CHANGE-ONE",
    type: "implementation",
    title: "First change",
    summary: "One recorded change.",
    status: "recorded",
    provenance: "recorded",
    sourceRefs: [{ path }],
  };
  return {
    schemaVersion: "change-observatory:view:v1",
    generatedAt: "2026-07-19T12:00:00.000Z",
    project: { id: "usability", name: "Usability Project" },
    snapshots: { counts: {}, phaseCounts: {} },
    summary: { asked: [], changed: [change], decided: [] },
    iterations: [],
    contracts: [],
    decisions: [],
    changes: [change],
    verification: [],
    records: [{
      path,
      kind: "implementation",
      provenance: "recorded",
      rawHref: `/api/v1/source?path=${encodeURIComponent(path)}`,
    }],
    diagnostics: [],
    ...overrides,
  };
}

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function textOf(node) {
  return node.textContent;
}

test("the diagnostics banner is worded by its highest severity", (t_) => {
  withBrowser(t_);
  const container = document.querySelector("#diagnostics-region");
  const note = (severity) => ({
    code: `${severity}_code`,
    severity,
    message: `A ${severity} diagnostic.`,
    occurrences: 1,
  });

  renderDiagnostics(container, [note("info"), note("info")]);
  assert.equal(container.hidden, false);
  assert.match(textOf(container), /Evidence notes/u);
  assert.match(textOf(container), /Nothing is wrong and no action is needed/u);
  assert.doesNotMatch(textOf(container), /Evidence needs attention|could not be read safely|omitted/u);

  renderDiagnostics(container, [note("info"), note("warning")]);
  assert.match(textOf(container), /Evidence warnings/u);
  assert.match(textOf(container), /read with warnings/u);
  assert.doesNotMatch(textOf(container), /Evidence needs attention/u);

  renderDiagnostics(container, [note("warning"), note("error")]);
  assert.match(textOf(container), /Evidence needs attention/u);

  setLocale("it");
  renderDiagnostics(container, [note("info")]);
  assert.match(textOf(container), /Note sulle prove/u);
  assert.match(textOf(container), /non serve alcuna azione/u);
  assert.doesNotMatch(textOf(container), /Evidence notes/u);
});

test("human-facing wording stays host-neutral and keeps both languages in step", async () => {
  const sources = await Promise.all(
    ["components.js", "i18n.js", "app.js", "portfolio-components.js"].map(
      (name) => readFile(new URL(name, UI_ROOT), "utf8"),
    ),
  );
  for (const source of sources) {
    assert.doesNotMatch(source, /\b[A-Z][a-z]+ chat\b|\bchat di [A-Z]\w+/u, "no product-specific chat wording");
  }
  setLocale("it");
  for (const english of [
    "Return to your agent conversation and describe the missing evidence in natural language; after it is recorded, refresh this view.",
    "Evidence notes",
    "Evidence warnings",
    "Nothing has been recorded yet",
    "No Agentic SDLC records were found in this folder",
    "No status recorded",
    "No contract evolution was recorded.",
    "No intent evidence has been recorded for this project.",
    "This project's folder was not found. Check its path in the portfolio file.",
  ]) {
    assert.notEqual(t(english), english, english);
  }
  setLocale("en");
  assert.equal(t("Evidence notes"), "Evidence notes");
});

test("errors caused by the link, a settings change, or a stopped server give the right next step", () => {
  const denied = new ObservatoryApiError("A valid per-run access token is required", {
    status: 401,
    code: "access_denied",
  });
  const changed = new ObservatoryApiError("Restart it to apply the reviewed privacy settings safely.", {
    status: 503,
    code: "observability_configuration_changed",
  });
  const stopped = new ObservatoryApiError("The local Change Observatory API is unavailable.", {
    code: "API_UNAVAILABLE",
  });

  for (const locale of ["en", "it"]) {
    setLocale(locale);
    const deniedGuidance = localizedErrorGuidance(denied);
    const changedGuidance = localizedErrorGuidance(changed);
    const stoppedGuidance = localizedErrorGuidance(stopped);
    if (locale === "en") {
      assert.match(deniedGuidance.nextAction, /full link printed in the terminal.*after the # sign/u);
      assert.doesNotMatch(deniedGuidance.outcome + deniedGuidance.impact, /connection|lost/iu);
      assert.match(changedGuidance.nextAction, /Stop the observe command.*start it again/u);
      assert.doesNotMatch(changedGuidance.nextAction, /^Refresh the page/u);
      assert.match(stoppedGuidance.nextAction, /terminal running Change Observatory is still open/u);
    } else {
      assert.match(deniedGuidance.nextAction, /indirizzo completo.*simbolo #/u);
      assert.match(changedGuidance.nextAction, /Ferma il comando observe/u);
      assert.match(stoppedGuidance.nextAction, /terminale/u);
    }
  }
  setLocale("en");
  const generic = localizedErrorGuidance(new ObservatoryApiError("Boom", { code: "API_RESPONSE_ERROR", status: 500 }));
  assert.match(generic.nextAction, /Refresh the page/u);
});

test("an access-denied page asks for the full link instead of reporting a lost connection", async (t_) => {
  const browser = withBrowser(t_);
  globalThis.fetch = async () => jsonResponse({
    schemaVersion: "change-observatory:error:v1",
    status: "error",
    correlationId: "corr-00000000-0000-4000-8000-000000000001",
    error: { code: "access_denied", message: "A valid per-run access token is required", retryable: false },
  }, 401, { "x-correlation-id": "corr-00000000-0000-4000-8000-000000000001" });

  await import(`../../ui/change-observatory/app.js?usability-denied=${Date.now()}`);
  await waitForBrowser(
    () => /full link/u.test(textOf(browser.document.querySelector("#primary-view"))),
    "the access-denied guidance was not rendered",
  );
  const primary = textOf(browser.document.querySelector("#primary-view"));
  assert.match(primary, /after the # sign/u);
  assert.doesNotMatch(primary, /connection is restored/u);
});

test("Escape closes the raw drawer, focus enters it on open and returns on close", async (t_) => {
  const browser = withBrowser(t_);
  globalThis.fetch = async (url) => {
    if (String(url).startsWith("/api/v1/source")) return jsonResponse({ data: { ok: true } });
    return jsonResponse(viewPayload());
  };
  await import(`../../ui/change-observatory/app.js?usability-escape=${Date.now()}`);
  await waitForBrowser(
    () => /First change/u.test(textOf(browser.document.querySelector("#primary-view"))),
    "the project did not load",
  );

  const opener = browser.document.querySelector('[data-action="open-first-raw"]');
  opener.focus();
  browser.document.dispatch("click", opener);
  const drawer = browser.document.querySelector("#raw-content");
  await waitForBrowser(() => drawer.hidden === false, "the raw drawer did not open");
  assert.equal(browser.document.activeElement.tagName, "pre", "focus moves into the raw record");

  browser.document.dispatchEvent({
    type: "keydown",
    key: "Escape",
    target: browser.document.activeElement,
    preventDefault() {},
  });
  assert.equal(drawer.hidden, true);
  assert.equal(
    browser.document.querySelector("#raw-drawer").dataset.expanded,
    "false",
  );
  assert.equal(browser.document.activeElement, opener, "focus returns to the opener");

  // Other keys and a closed drawer are ignored.
  browser.document.dispatchEvent({ type: "keydown", key: "Escape", target: opener, preventDefault() {} });
  browser.document.dispatchEvent({ type: "keydown", key: "a", target: opener, preventDefault() {} });
  assert.equal(drawer.hidden, true);
});

test("a folder without a knowledge base gets one clear empty state", async (t_) => {
  const browser = withBrowser(t_);
  const missing = viewPayload({
    project: { id: null, name: null },
    summary: { asked: [], changed: [], decided: [] },
    changes: [],
    records: [],
    diagnostics: [{
      code: "knowledge_base_missing",
      severity: "warning",
      message: "No .sdlc knowledge base is recorded for this project.",
      provenance: "missing",
      occurrences: 1,
      sourceRefs: [{ path: ".sdlc" }],
    }],
  });
  globalThis.fetch = async () => jsonResponse(missing);
  await import(`../../ui/change-observatory/app.js?usability-empty=${Date.now()}`);
  await waitForBrowser(
    () => /No Agentic SDLC records were found/u.test(textOf(browser.document.querySelector("#primary-view"))),
    "the empty state was not rendered",
  );
  const primary = textOf(browser.document.querySelector("#primary-view"));
  assert.match(primary, /Checked path: \.sdlc/u);
  assert.match(primary, /agentic-sdlc init/u);
  assert.match(primary, /ask your agent to initialize/u);
  assert.equal(browser.document.querySelector("#summary-region").hidden, true, "no repeated empty answers");
  assert.equal(browser.document.querySelector("#diagnostics-region").hidden, true);
  assert.equal(
    browser.document.querySelector(".snapshot-control").hidden,
    true,
    "the always-disabled snapshot select is hidden when there is nothing to choose",
  );
});

test("three identical empty answers collapse into one explanation", (t_) => {
  withBrowser(t_);
  const container = document.querySelector("#summary-region");
  const model = normalizeViewModel(viewPayload({
    summary: { asked: [], changed: [], decided: [] },
    changes: [],
  }));
  renderSummary(container, model);
  assert.equal(container.children.length, 1);
  assert.match(textOf(container), /Nothing has been recorded yet/u);
  assert.equal(
    (textOf(container).match(/No recorded evidence answers/gu) ?? []).length,
    1,
    "the guidance appears once, not three times",
  );

  const filled = normalizeViewModel(viewPayload());
  renderSummary(container, filled);
  assert.equal(container.children.length >= 3, true);

  renderKnowledgeBaseMissing(document.querySelector("#primary-view"), {
    diagnostics: [{ code: "knowledge_base_missing", sourceRefs: [{ path: ".sdlc" }] }],
  });
  assert.match(textOf(document.querySelector("#primary-view")), /inside the project folder shown in your terminal/u);
});

test("grammar and empty views explain themselves in plain words", (t_) => {
  withBrowser(t_);
  const primary = document.querySelector("#primary-view");
  const model = normalizeViewModel(viewPayload({ contracts: [] }));
  const baseState = {
    filters: { iteration: "", phase: "" },
    selectedIterationId: null,
    selectedId: null,
  };

  renderPrimary(primary, model, { ...baseState, view: "contracts" });
  assert.match(textOf(primary), /No contract evolution was recorded\./u);
  assert.doesNotMatch(textOf(primary), /were recorded/u);

  renderPrimary(primary, model, { ...baseState, view: "intent-evidence" });
  assert.match(textOf(primary), /No intent evidence has been recorded for this project/u);
  assert.match(textOf(primary), /does not mean anything is missing or wrong/u);

  setLocale("it");
  renderPrimary(primary, model, { ...baseState, view: "contracts" });
  assert.match(textOf(primary), /Non è stata registrata alcuna evoluzione del contratto/u);
});

test("a record without a status says so, and the inspector keeps its labels apart", (t_) => {
  withBrowser(t_);
  const item = { id: "REC-1", type: "note", title: "A note", summary: "Recorded text.", provenance: "recorded", sourceRefs: [] };
  assert.equal(displayTextForItem(item).status, "No status recorded");
  setLocale("it");
  assert.equal(displayTextForItem(item).status, "Nessuno stato registrato");
  setLocale("en");

  const inspector = document.querySelector("#inspector");
  renderInspector(inspector, { ...item, status: "missing" });
  const header = inspector.querySelectorAll(".inspector-status")[0];
  assert.ok(header, "status header rendered");
  assert.doesNotMatch(textOf(header), /MissingRead-only|statusRead-only/u);
  assert.match(textOf(header), /No status recorded\s*·\s*Read-only/u);
});

test("link methods are translated for Italian readers", () => {
  setLocale("it");
  const rendered = t("Linked by evidence path, story id");
  assert.doesNotMatch(rendered, /evidence path|story id/u);
  assert.match(rendered, /percorso della prova/u);
  assert.match(rendered, /ID della story/u);
  setLocale("en");
  assert.equal(t("Linked by evidence path, story id"), "Linked by evidence path, story id");
});

test("a project without a readable name keeps its portfolio identifier", async (t_) => {
  const browser = withBrowser(t_, "http://127.0.0.1:43127/?mode=portfolio&project=alpha#overview");
  const counts = {
    asked: 0, changed: 0, decided: 0, iterations: 0, contracts: 0,
    decisions: 0, changes: 0, verification: 0, diagnostics: 1,
  };
  globalThis.fetch = async (url) => {
    if (String(url) === "/api/v1/portfolio") {
      return jsonResponse({
        schemaVersion: "change-observatory:portfolio:v1",
        generatedAt: "2026-07-19T12:00:00.000Z",
        status: "degraded",
        health: "needs_attention",
        projectCount: 2,
        availableProjectCount: 1,
        unavailableProjectCount: 1,
        needsAttentionProjectCount: 0,
        reviewProjectCount: 0,
        projects: [
          { id: "alpha", status: "available", health: "ready", name: "alpha", counts, previews: [] },
          {
            id: "gone",
            status: "unavailable",
            health: "unavailable",
            name: "gone",
            counts,
            previews: [],
            errorCode: "project_folder_missing",
            message: "This project's folder was not found. Check its path in the portfolio file.",
          },
        ],
      });
    }
    return jsonResponse(viewPayload({ project: { id: null, name: null } }));
  };
  await import(`../../ui/change-observatory/app.js?usability-portfolio=${Date.now()}`);
  await waitForBrowser(
    () => /First change/u.test(textOf(browser.document.querySelector("#primary-view"))),
    "the portfolio project did not load",
  );
  assert.equal(browser.document.querySelector("#workspace-heading").textContent, "alpha · Overview");
  assert.doesNotMatch(browser.document.querySelector("#project-select").textContent, /Unknown project/u);

  browser.window.replaceAndDispatch("/?mode=portfolio&project=gone#overview", "popstate");
  await waitForBrowser(
    () => /folder was not found/u.test(textOf(browser.document.querySelector("#primary-view"))),
    "the unavailable project card did not explain why",
  );
});

test("the shipped UI has a visible focus ring, readable text, and its own icon", async () => {
  const [css, html] = await Promise.all([
    readFile(new URL("styles.css", UI_ROOT), "utf8"),
    readFile(new URL("index.html", UI_ROOT), "utf8"),
  ]);

  const focusRule = css.match(/button:focus-visible,[^{]*\{([^}]*)\}/u)?.[1] ?? "";
  assert.match(focusRule, /outline:\s*2px solid var\(--focus-ring\)/u);
  assert.doesNotMatch(focusRule, /outline:\s*none/u);

  const tokens = Object.fromEntries(
    [...css.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})\s*;/giu)].map((match) => [match[1], match[2]]),
  );
  const backgrounds = ["canvas", "surface", "surface-muted", "surface-selected"].map((name) => tokens[name]);
  for (const background of backgrounds) {
    assert.ok(contrast(tokens["ink-muted"], background) >= 4.5, `ink-muted on ${background}`);
    assert.ok(contrast(tokens["focus-ring"], background) >= 3, `focus ring on ${background}`);
  }

  const sizes = [...css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/gu)].map((match) => Number(match[1]));
  assert.ok(sizes.length > 0);
  assert.ok(sizes.every((size) => size >= 12), `font sizes below 12px: ${sizes.filter((size) => size < 12)}`);

  assert.match(html, /<link rel="icon" href="data:image\/svg\+xml,/u);
  assert.doesNotMatch(html, /https?:\/\//u, "the page stays self-contained");
});

function contrast(foreground, background) {
  const luminance = (hex) => {
    const [r, g, b] = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255)
      .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [high, low] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (high + 0.05) / (low + 0.05);
}
