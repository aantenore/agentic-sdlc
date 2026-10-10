import assert from "node:assert/strict";
import test from "node:test";

import {
  backTarget,
  buildBreadcrumb,
  canGoBack,
  entrySelection,
  isAppEntry,
  navEntry,
} from "../../ui/change-observatory/navigation.js";

test("history entries carry the selection and are recognised as app entries", () => {
  assert.deepEqual(navEntry(), { nav: true });
  assert.equal(entrySelection(navEntry({ selectedId: "story:ST-X" })), "story:ST-X");
  assert.equal(entrySelection(null), null);
  assert.equal(isAppEntry(navEntry()), true);
  assert.equal(isAppEntry(null), false);
});

test("back is offered only away from the main view or with a detail open", () => {
  assert.equal(canGoBack({ view: "overview", detailOpen: false }), false);
  assert.equal(canGoBack({ view: "map", detailOpen: false }), true);
  assert.equal(canGoBack({ view: "overview", detailOpen: true }), true);
});

test("back uses browser history for app entries and falls back otherwise", () => {
  assert.equal(backTarget({ view: "overview", detailOpen: false, historyState: null }), "none");
  assert.equal(backTarget({ view: "map", detailOpen: true, historyState: navEntry() }), "history");
  assert.equal(backTarget({ view: "map", detailOpen: true, historyState: null }), "close-detail");
  assert.equal(backTarget({ view: "map", detailOpen: false, historyState: null }), "main-view");
});

test("breadcrumb has clickable ancestors and a non-clickable current level", () => {
  const levels = buildBreadcrumb({
    projectName: "Proj", view: "map", viewLabel: "Mappa", detailLabel: "ST-X", detailOpen: true,
  });
  assert.deepEqual(levels.map((l) => [l.label, l.action]), [["Proj", "project"], ["Mappa", "view"], ["ST-X", null]]);
  const noDetail = buildBreadcrumb({ projectName: "Proj", view: "map", viewLabel: "Mappa" });
  assert.deepEqual(noDetail.map((l) => l.action), ["project", null]);
  const main = buildBreadcrumb({ projectName: "Proj", view: "overview", viewLabel: "Overview" });
  assert.equal(main.length, 1);
});
