// Pure navigation logic: history entries, breadcrumb levels and the target of
// "back". No DOM access, so it is testable without a browser.

export const MAIN_VIEW = "overview";

/** History state written by the app for every view or selection change. */
export function navEntry({ selectedId = null } = {}) {
  return selectedId ? { nav: true, sel: selectedId } : { nav: true };
}

export function entrySelection(historyState) {
  return typeof historyState?.sel === "string" && historyState.sel ? historyState.sel : null;
}

export function isAppEntry(historyState) {
  return historyState?.nav === true;
}

/**
 * Breadcrumb levels, outermost first. The last level is the current page.
 * action: "project" (main view), "view" (current view, details closed) or null.
 */
export function buildBreadcrumb({ projectName, view, viewLabel, detailLabel = null, detailOpen = false }) {
  const levels = [];
  if (projectName) levels.push({ key: "project", label: projectName, action: "project" });
  if (view !== MAIN_VIEW || (detailOpen && detailLabel)) {
    levels.push({ key: "view", label: viewLabel, action: "view" });
  }
  if (detailOpen && detailLabel) levels.push({ key: "detail", label: detailLabel, action: null });
  if (levels.length > 0) levels[levels.length - 1] = { ...levels[levels.length - 1], action: null };
  return levels;
}

export function canGoBack({ view, detailOpen }) {
  return view !== MAIN_VIEW || Boolean(detailOpen);
}

/**
 * What "back" (button or Escape) does: step through browser history when the
 * app created the current entry, otherwise close the detail or return to the
 * main view directly.
 */
export function backTarget({ view, detailOpen, historyState }) {
  if (!canGoBack({ view, detailOpen })) return "none";
  if (isAppEntry(historyState)) return "history";
  return detailOpen ? "close-detail" : "main-view";
}
