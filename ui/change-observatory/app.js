import { ObservatoryApi, accessTokenFromHash } from "./api.js";
import { mountNowPanel } from "./now-panel.js";
import {
  phaseSelectionId,
  phaseSelectionItem,
  hasMissingKnowledgeBase,
  renderDiagnostics,
  renderFatalError,
  renderInspector,
  renderKnowledgeBaseMissing,
  renderPrimary,
  renderProjectControls,
  renderSummary,
} from "./components.js";
import {
  preferredDossierIteration,
  rawHrefForPath,
  rawTargetFor,
  recordSelectionKey,
} from "./model.js";
import {
  LatestRequestCoordinator,
  portfolioModeFromLocation,
  portfolioProjectRouteFromLocation,
  portfolioRouteHref,
} from "./portfolio.js";
import {
  applyWorkspaceContext,
  renderPortfolioControls,
  renderPortfolioOverview,
  renderPortfolioProjectLoading,
  renderPortfolioSummary,
  renderPortfolioUnavailable,
} from "./portfolio-components.js";
import {
  applyDocumentLocale,
  getLocale,
  localeFromLocation,
  localizedErrorGuidance,
  setLocale,
  t,
} from "./i18n.js";
import { defaultExploreState } from "./visuals.js";
import { INSIGHT_SETTINGS, normalizeDependencyEdges } from "./insights.js";

const locale = setLocale(localeFromLocation(window.location));
applyDocumentLocale(document, locale);
const portfolioMode = portfolioModeFromLocation(window.location);

const UNKNOWN_PROJECT = "Unknown project";

const VALID_VIEWS = new Set([
  "overview",
  "stories",
  "activity",
  "map",
  "timeline",
  "contracts",
  "decisions",
  "changes",
  "intent-evidence",
  "verification",
]);
// Visual views keep the evidence inspector closed until a record is chosen,
// so charts and maps get the full width.
const VISUAL_VIEWS = new Set(["overview", "stories", "activity", "map"]);
const VIEW_LABELS = Object.freeze({
  overview: "Overview",
  stories: "Stories",
  activity: "Timeline",
  map: "Map",
  timeline: "Story dossier",
  contracts: "Contracts",
  decisions: "Decisions",
  changes: "Changes",
  "intent-evidence": "Intent evidence",
  verification: "Verification",
});

const elements = {
  app: document.querySelector("#app"),
  navigation: document.querySelector("#primary-navigation"),
  navToggle: document.querySelector('[data-action="toggle-navigation"]'),
  summary: document.querySelector("#summary-region"),
  diagnostics: document.querySelector("#diagnostics-region"),
  primary: document.querySelector("#primary-view"),
  inspector: document.querySelector("#inspector"),
  apiStatus: document.querySelector("#api-status"),
  rawDrawer: document.querySelector("#raw-drawer"),
  rawToggle: document.querySelector('[data-action="toggle-raw"]'),
  rawContent: document.querySelector("#raw-content"),
  rawCode: document.querySelector("#raw-code"),
  rawPath: document.querySelector("#raw-path"),
};

const endpoint =
  document.querySelector('meta[name="change-observatory-api"]')?.getAttribute("content") || undefined;
const fragmentToken = accessTokenFromHash(window.location.hash);
if (fragmentToken) {
  window.sessionStorage.setItem("change-observatory-access-token", fragmentToken);
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
}
const accessToken = fragmentToken
  || window.sessionStorage.getItem("change-observatory-access-token");
const api = new ObservatoryApi({
  ...(endpoint ? { endpoint } : {}),
  accessToken,
});

function readExpertPreference() {
  try {
    return window.localStorage?.getItem("observatory.expertOpen") === "1";
  } catch {
    return false;
  }
}

const state = {
  model: null,
  view: viewFromHash(),
  filters: { iteration: "", phase: "" },
  explore: defaultExploreState(),
  live: false,
  expertOpen: readExpertPreference(),
  inspectorOpen: false,
  liveTimer: null,
  quietLoading: false,
  selectedIterationId: null,
  selectedId: null,
  selectedItem: null,
  records: new Map(),
  portfolioSummary: null,
  selectedProjectId: "",
  portfolioProjectId: null,
  modelProjectId: null,
  rawController: null,
  rawGeneration: 0,
  rawExpanded: false,
  rawReturnFocus: null,
  dependencies: null,
  dependencyKey: null,
  sharedClaims: null,
  sharedClaimsKey: null,
  remoteStories: null,
  remoteStoriesKey: null,
};
const loadCoordinator = new LatestRequestCoordinator();

function viewFromHash() {
  const requested = window.location.hash.replace(/^#/, "");
  return VALID_VIEWS.has(requested) ? requested : "overview";
}

function setApiStatus(label, status) {
  elements.apiStatus.textContent = t(label);
  elements.apiStatus.dataset.status = status;
}

function setPortfolioHomeContext() {
  applyWorkspaceContext({ portfolioOverview: true });
}

function setProjectWorkspaceContext(projectName, label = VIEW_LABELS[state.view]) {
  applyWorkspaceContext({ projectName, label });
}

function setGenericWorkspaceContext() {
  applyWorkspaceContext();
}

function indexRecords(model, portfolioProjectId = null) {
  const records = new Map();
  const collections = [
    model.summary.asked,
    model.summary.changed,
    model.summary.decided,
    model.iterations,
    model.contracts,
    model.decisions,
    model.changes,
    model.semanticObservations,
    model.unlinkedLineage,
    model.verification,
  ];
  collections.flat().forEach((item) => {
    const key = recordSelectionKey(item);
    if (key) records.set(key, item);
  });
  for (const iteration of model.iterations) {
    for (const phase of iteration.phases) {
      const item = phaseSelectionItem(iteration, phase, portfolioProjectId);
      records.set(recordSelectionKey(item), item);
    }
    if (iteration.dossier) {
      for (const lane of Object.values(iteration.dossier.lanes)) {
        for (const item of lane.items) {
          const key = recordSelectionKey(item);
          if (key) records.set(key, item);
        }
      }
    }
  }
  state.records = records;
}

function preferredIterationId(model, previousId = null) {
  if (previousId && model.iterations.some((iteration) => iteration.id === previousId)) {
    return previousId;
  }
  return preferredDossierIteration(model.iterations)?.id ?? null;
}

function preferredSelection(model, portfolioProjectId = null) {
  let selected = null;
  for (const iteration of model.iterations) {
    for (const phase of iteration.phases) {
      if (phase.status === "inProgress") {
        selected = phaseSelectionItem(iteration, phase, portfolioProjectId);
      }
    }
  }
  return (
    model.summary.changed[0] ||
    selected ||
    model.summary.decided[0] ||
    model.summary.asked[0] ||
    model.contracts[0] ||
    null
  );
}

// Views that need SDLC vocabulary sit in a "More details" group that stays
// closed unless the reader opens it or one of those views is showing.
const EVERYDAY_VIEWS = new Set(["overview", "stories", "activity", "map"]);

function updateNavigation() {
  document.querySelectorAll("[data-view]").forEach((button) => {
    const active = button.dataset.view === state.view;
    button.classList.toggle("is-active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  const expertOpen = state.expertOpen || !EVERYDAY_VIEWS.has(state.view);
  const group = document.querySelector("#nav-expert");
  if (group) group.hidden = !expertOpen;
  document.querySelector('[data-action="toggle-expert"]')?.setAttribute("aria-expanded", String(expertOpen));
}

function render() {
  if (!state.model) return;
  if (
    portfolioMode
    && (
      state.modelProjectId !== state.selectedProjectId
      || state.portfolioProjectId !== state.modelProjectId
    )
  ) return;
  setProjectWorkspaceContext(state.model.project.name);
  updateNavigation();
  elements.app.dataset.activeView = state.view;
  const focusedExplore = captureExploreFocus();
  if (hasMissingKnowledgeBase(state.model)) {
    renderKnowledgeBaseMissing(elements.primary, state.model);
  } else {
    renderPrimary(elements.primary, state.model, state);
  }
  restoreExploreFocus(focusedExplore);
  renderInspector(elements.inspector, state.selectedItem, {
    portfolioProjectId: state.portfolioProjectId,
  });
  const inspectorOpen = !VISUAL_VIEWS.has(state.view) || state.inspectorOpen;
  elements.app.dataset.inspector = inspectorOpen ? "open" : "closed";
  if (inspectorOpen && VISUAL_VIEWS.has(state.view)) {
    const close = document.createElement("button");
    close.className = "inspector-close";
    close.setAttribute("type", "button");
    close.dataset.action = "close-inspector";
    close.textContent = t("Close details");
    elements.inspector.append(close);
  }
}

async function loadModel({ preserveSelection = false } = {}) {
  const request = loadCoordinator.begin();
  elements.app.setAttribute("aria-busy", "true");
  setApiStatus("Connecting", "loading");

  try {
    const model = await api.load({ signal: request.signal });
    if (!request.isCurrent()) return;
    const preservedSelection = preserveSelection ? captureProjectSelection(null) : null;
    applyProjectModel(model, { preservedSelection });
    renderProjectControls(model);
    renderSummary(elements.summary, model);
    renderDiagnostics(elements.diagnostics, model.diagnostics);
    render();
    setApiStatus("Read-only · ready", "ready");
    document.title = `${model.project.name} · Change Observatory`;
  } catch (error) {
    if (error?.name === "AbortError") return;
    if (!request.isCurrent()) return;
    clearProjectModel();
    setGenericWorkspaceContext();
    renderFatalError(elements.primary, error);
    renderInspector(elements.inspector, null);
    elements.diagnostics.hidden = true;
    setApiStatus("Unavailable", "error");
  } finally {
    if (request.isCurrent()) elements.app.setAttribute("aria-busy", "false");
  }
}

// A project whose record has no readable name keeps the identifier chosen in
// the portfolio file instead of the generic placeholder.
function withManifestProjectName(model, project) {
  const unnamed = model.project.name === UNKNOWN_PROJECT;
  const unidentified = model.project.id === UNKNOWN_PROJECT;
  if (!unnamed && !unidentified) return model;
  return {
    ...model,
    project: {
      ...model.project,
      ...(unidentified ? { id: project.id } : {}),
      ...(unnamed ? { name: project.name } : {}),
    },
  };
}

function applyProjectModel(model, {
  portfolioProjectId = null,
  preservedSelection = null,
} = {}) {
  state.model = model;
  state.modelProjectId = portfolioProjectId;
  indexRecords(model, portfolioProjectId);
  state.selectedIterationId = preferredIterationId(
    model,
    preservedSelection?.selectedIterationId ?? null,
  );
  if (preservedSelection?.selectedId && state.records.has(preservedSelection.selectedId)) {
    state.selectedId = preservedSelection.selectedId;
    state.selectedItem = state.records.get(preservedSelection.selectedId);
  } else {
    state.selectedItem = preferredSelection(model, portfolioProjectId);
    state.selectedId = state.selectedItem ? recordSelectionKey(state.selectedItem) : null;
  }
  loadDependencies(model, portfolioProjectId);
  loadSharedClaims(portfolioProjectId);
  loadRemoteStories(portfolioProjectId);
  if (!portfolioMode) loadSourceRef();
}

// The branch the records come from (the shared base branch by default) and
// when they were last updated. When that branch moves, the model is reloaded.
const SOURCE_REF_POLL_SECONDS = 30;
let sourceRefTimer = null;
let sourceRefCommit = null;
async function loadSourceRef() {
  const target = document.querySelector("#source-ref");
  if (!target) return;
  if (!sourceRefTimer) {
    sourceRefTimer = setInterval(loadSourceRef, SOURCE_REF_POLL_SECONDS * 1000);
  }
  let source;
  try {
    source = await api.loadSourceRef();
  } catch {
    target.hidden = true;
    return;
  }
  if (source?.mode === "ref" && typeof source.ref === "string") {
    const when = source.updatedAt ? new Date(source.updatedAt) : null;
    const time = when && !Number.isNaN(when.getTime())
      ? when.toLocaleTimeString(getLocale(), { hour: "2-digit", minute: "2-digit" })
      : null;
    target.textContent = `${t("Records from")} ${source.ref}${time ? ` · ${t("updated")} ${time}` : ""}`;
    target.title = [source.commit ? source.commit.slice(0, 12) : null,
      source.fetchError ? t("Last update from the remote failed") : null].filter(Boolean).join(" · ");
    target.hidden = false;
    const moved = sourceRefCommit !== null && source.commit && source.commit !== sourceRefCommit;
    sourceRefCommit = source.commit ?? sourceRefCommit;
    if (moved) quietReload();
    return;
  }
  target.textContent = `${t("Records from")} ${t("Local files")}`;
  target.title = "";
  target.hidden = false;
}

// Who holds each story on the shared remote, as this computer last saw it.
// Optional: without it the views keep the recorded states.
async function loadSharedClaims(portfolioProjectId) {
  try {
    const claims = await api.loadClaims(portfolioProjectId);
    if (state.modelProjectId !== portfolioProjectId) return;
    const key = JSON.stringify(claims);
    if (key === state.sharedClaimsKey) return;
    state.sharedClaimsKey = key;
    state.sharedClaims = claims.length ? claims : null;
    render();
  } catch {
    // Older servers have no claims endpoint.
  }
}

async function loadRemoteStories(portfolioProjectId) {
  try {
    const stories = await api.loadRemoteStories(portfolioProjectId);
    if (state.modelProjectId !== portfolioProjectId) return;
    const key = JSON.stringify(stories);
    if (key === state.remoteStoriesKey) return;
    state.remoteStoriesKey = key;
    state.remoteStories = stories.length ? stories : null;
    render();
  } catch {
    // Older servers have no remote stories endpoint.
  }
}

// The recorded dependency graph feeds the project plan and the "waiting"
// state. It is optional: without it every view still works.
const DEPENDENCY_GRAPH_PATH = ".sdlc/dependencies/graph.json";

async function loadDependencies(model, portfolioProjectId) {
  // The record list is capped on large projects, so a missing graph record
  // does not prove the plan is missing; the compact endpoint decides.
  const record = model.records?.find((candidate) => candidate.path === DEPENDENCY_GRAPH_PATH);
  const key = `${portfolioProjectId ?? ""}|${record?.timestamp ?? ""}|${record?.sizeBytes ?? ""}|${model.generatedAt ?? ""}`;
  if (state.dependencyKey === key) return;
  state.dependencyKey = key;
  try {
    let edges = await api.loadDependencyEdges(portfolioProjectId);
    if (edges === null) {
      // Older server: read the graph record itself.
      const href = record ? rawHrefForPath(DEPENDENCY_GRAPH_PATH, portfolioProjectId) : null;
      edges = href ? await api.loadSourceData(href) : null;
      edges = edges ? normalizeDependencyEdges(edges) : [];
    } else {
      edges = normalizeDependencyEdges({ edges });
    }
    if (state.modelProjectId !== portfolioProjectId || state.dependencyKey !== key) return;
    // Keep the same array when nothing changed so cached plan work is reused.
    if (JSON.stringify(state.dependencies ?? []) === JSON.stringify(edges)) return;
    state.dependencies = edges.length ? edges : null;
    render();
  } catch {
    if (state.dependencyKey === key) state.dependencyKey = null;
  }
}

function captureProjectSelection(portfolioProjectId) {
  if (!state.model || state.modelProjectId !== portfolioProjectId) return null;
  return {
    selectedIterationId: state.selectedIterationId,
    selectedId: state.selectedId,
  };
}

// Re-rendering replaces the search box; keep typing uninterrupted.
function captureExploreFocus() {
  const active = document.activeElement;
  const name = active?.dataset?.explore;
  if (!name || !elements.primary.contains?.(active)) return null;
  return { name, start: active.selectionStart ?? null, end: active.selectionEnd ?? null };
}

function restoreExploreFocus(focused) {
  if (!focused) return;
  const target = elements.primary.querySelector(`[data-explore="${focused.name}"]`);
  if (!target) return;
  target.focus?.({ preventScroll: true });
  if (focused.start !== null && typeof target.setSelectionRange === "function") {
    target.setSelectionRange(focused.start, focused.end ?? focused.start);
  }
}

function clearProjectModel() {
  state.model = null;
  state.modelProjectId = null;
  state.selectedItem = null;
  state.selectedId = null;
  state.selectedIterationId = null;
  state.records = new Map();
  state.explore = defaultExploreState();
  state.dependencies = null;
  state.dependencyKey = null;
  state.sharedClaims = null;
  state.sharedClaimsKey = null;
  state.remoteStories = null;
  state.remoteStoriesKey = null;
}

function clearProjectPresentation() {
  clearProjectModel();
  renderInspector(elements.inspector, null);
  elements.diagnostics.hidden = true;
  elements.diagnostics.replaceChildren();
}

function currentLocationHref() {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function writePortfolioLocation(projectId, historyMode) {
  if (historyMode === "none") return;
  const href = portfolioRouteHref(window.location, {
    projectId: projectId || null,
    view: state.view,
  });
  if (href === currentLocationHref()) return;
  const method = historyMode === "replace" ? "replaceState" : "pushState";
  window.history[method](null, "", href);
}

function setDetailNavigationEnabled(enabled) {
  for (const button of document.querySelectorAll("[data-view]")) {
    button.disabled = !enabled;
  }
  document.querySelector('[data-action="open-first-raw"]').disabled = !enabled;
}

function disablePortfolioControls() {
  const projectSelect = document.querySelector("#project-select");
  const snapshotSelect = document.querySelector("#snapshot-select");
  projectSelect.disabled = true;
  const unavailable = document.createElement("option");
  unavailable.value = "";
  unavailable.textContent = t("Unavailable");
  projectSelect.replaceChildren(unavailable);
  snapshotSelect.disabled = true;
  snapshotSelect.replaceChildren(unavailable.cloneNode(true));
}

function resetRawForProjectChange() {
  state.rawController?.abort();
  state.rawController = null;
  state.rawGeneration += 1;
  elements.rawPath.textContent = t("Select a source record");
  elements.rawCode.textContent = t("No source record selected.");
  setRawExpanded(false);
}

function renderPortfolioHome({ focus = false, historyMode = "none" } = {}) {
  if (!state.portfolioSummary) return;
  loadCoordinator.cancel();
  clearProjectModel();
  state.selectedProjectId = "";
  state.portfolioProjectId = null;
  resetRawForProjectChange();
  state.view = "overview";
  delete elements.app.dataset.activeView;
  writePortfolioLocation(null, historyMode);
  setPortfolioHomeContext();
  renderPortfolioControls(state.portfolioSummary);
  renderPortfolioSummary(elements.summary, state.portfolioSummary);
  renderPortfolioOverview(elements.primary, state.portfolioSummary);
  renderInspector(elements.inspector, null);
  elements.diagnostics.hidden = true;
  elements.diagnostics.replaceChildren();
  setDetailNavigationEnabled(false);
  updateNavigation();
  setApiStatus("Portfolio · ready", "ready");
  document.title = `${t("Portfolio overview")} · Change Observatory`;
  elements.app.setAttribute("aria-busy", "false");
  if (focus) elements.primary.focus({ preventScroll: true });
}

async function loadPortfolioSummary({
  preserveProject = false,
  focus = false,
  requestedProjectId = undefined,
  canonicalizeFallback = false,
} = {}) {
  const projectId = requestedProjectId === undefined
    ? (preserveProject ? state.selectedProjectId : "")
    : (requestedProjectId ?? "");
  const request = loadCoordinator.begin();
  elements.app.setAttribute("aria-busy", "true");
  setApiStatus("Connecting", "loading");
  try {
    const summary = await api.loadPortfolio({ signal: request.signal });
    if (!request.isCurrent()) return;
    state.portfolioSummary = summary;
    const requestedProject = summary.projects.find(
      (project) => project.id === projectId,
    );
    if (requestedProject) {
      await loadPortfolioProject(requestedProject.id, {
        focus,
        preserveSelection: true,
      });
      return;
    }
    renderPortfolioHome({
      focus,
      historyMode: canonicalizeFallback || projectId ? "replace" : "none",
    });
  } catch (error) {
    if (error?.name === "AbortError" || !request.isCurrent()) return;
    state.portfolioSummary = null;
    state.selectedProjectId = "";
    state.portfolioProjectId = null;
    clearProjectModel();
    setPortfolioHomeContext();
    resetRawForProjectChange();
    disablePortfolioControls();
    elements.summary.replaceChildren();
    renderFatalError(elements.primary, error, {
      title: "Portfolio could not be loaded",
    });
    renderInspector(elements.inspector, null);
    elements.diagnostics.hidden = true;
    setDetailNavigationEnabled(false);
    setApiStatus("Unavailable", "error");
  } finally {
    if (request.isCurrent()) elements.app.setAttribute("aria-busy", "false");
  }
}

async function loadPortfolioProject(projectId, {
  focus = true,
  preserveSelection = false,
  historyMode = "none",
} = {}) {
  const project = state.portfolioSummary?.projects.find((item) => item.id === projectId);
  if (!project) {
    renderPortfolioHome({ focus, historyMode: "replace" });
    return;
  }
  const preservedSelection = preserveSelection
    ? captureProjectSelection(project.id)
    : null;
  state.selectedProjectId = project.id;
  state.portfolioProjectId = project.id;
  if (!preserveSelection) state.filters = { iteration: "", phase: "" };
  writePortfolioLocation(project.id, historyMode);
  resetRawForProjectChange();
  clearProjectPresentation();
  setProjectWorkspaceContext(project.name, "Loading project evidence");
  renderPortfolioControls(state.portfolioSummary, project.id);
  renderPortfolioSummary(elements.summary, state.portfolioSummary);

  if (project.status === "unavailable") {
    loadCoordinator.cancel();
    renderPortfolioUnavailable(elements.primary, project);
    setProjectWorkspaceContext(project.name, "Unavailable");
    setDetailNavigationEnabled(false);
    setApiStatus("Portfolio · partly available", "warning");
    elements.app.setAttribute("aria-busy", "false");
    document.title = `${project.name} · Change Observatory`;
    if (focus) elements.primary.focus({ preventScroll: true });
    return;
  }

  const request = loadCoordinator.begin();
  elements.app.setAttribute("aria-busy", "true");
  renderPortfolioProjectLoading(elements.primary, project);
  setDetailNavigationEnabled(false);
  setApiStatus("Loading project…", "loading");
  try {
    const loaded = await api.loadProject(project.id, { signal: request.signal });
    if (!request.isCurrent() || state.selectedProjectId !== project.id) return;
    const model = withManifestProjectName(loaded, project);
    applyProjectModel(model, {
      portfolioProjectId: project.id,
      preservedSelection,
    });
    renderPortfolioControls(state.portfolioSummary, project.id, model);
    renderSummary(elements.summary, model, {
      portfolioProjectId: project.id,
    });
    renderDiagnostics(elements.diagnostics, model.diagnostics);
    setDetailNavigationEnabled(true);
    render();
    setApiStatus("Read-only · ready", "ready");
    document.title = `${model.project.name} · Change Observatory`;
    if (focus) elements.primary.focus({ preventScroll: true });
  } catch (error) {
    if (error?.name === "AbortError" || !request.isCurrent()) return;
    clearProjectPresentation();
    setProjectWorkspaceContext(project.name, "Unavailable");
    renderFatalError(elements.primary, error);
    setDetailNavigationEnabled(false);
    setApiStatus("Unavailable", "error");
    if (focus) elements.primary.focus({ preventScroll: true });
  } finally {
    if (request.isCurrent()) elements.app.setAttribute("aria-busy", "false");
  }
}

function setView(view) {
  if (!VALID_VIEWS.has(view) || (portfolioMode && !state.model)) return;
  if (state.view !== view) state.explore.pages = 1;
  state.view = view;
  state.inspectorOpen = false;
  if (window.location.hash !== `#${view}`) window.history.pushState(null, "", `#${view}`);
  if (window.matchMedia("(max-width: 720px)").matches) setNavigationOpen(false);
  render();
  elements.primary.focus({ preventScroll: true });
}

function selectRecord(id) {
  const item = state.records.get(id);
  if (!item) return;
  state.selectedId = id;
  state.selectedItem = item;
  state.inspectorOpen = true;
  render();
}

function selectIteration(iterationId) {
  if (!state.model?.iterations.some((iteration) => iteration.id === iterationId)) return;
  state.selectedIterationId = iterationId;
  render();
}

function selectPhase(iterationId, phase) {
  state.selectedIterationId = iterationId;
  selectRecord(recordSelectionKey({
    id: phaseSelectionId(iterationId, phase),
    type: "phase-state",
    sourceRefs: [],
  }));
}

function setNavigationOpen(open) {
  elements.navigation.classList.toggle("is-open", open);
  elements.navToggle.setAttribute("aria-expanded", String(open));
}

function focusIsInsideRawDrawer() {
  return Boolean(document.activeElement?.closest?.("#raw-drawer"));
}

function setRawExpanded(expanded) {
  const wasExpanded = state.rawExpanded;
  if (expanded && !wasExpanded) {
    const active = document.activeElement;
    state.rawReturnFocus = active && !active.closest?.("#raw-drawer") ? active : elements.rawToggle;
  }
  const focusWasInside = focusIsInsideRawDrawer();
  state.rawExpanded = expanded;
  elements.rawDrawer.dataset.expanded = String(expanded);
  elements.rawToggle.setAttribute("aria-expanded", String(expanded));
  elements.rawContent.hidden = !expanded;
  if (expanded && !wasExpanded) {
    // Keyboard users land on the record so they can read and scroll it at once.
    elements.rawContent.querySelector("pre")?.focus?.({ preventScroll: true });
  } else if (!expanded && wasExpanded) {
    const target = state.rawReturnFocus ?? elements.rawToggle;
    state.rawReturnFocus = null;
    if (focusWasInside) target.focus?.({ preventScroll: true });
  }
}

function closeRaw() {
  state.rawController?.abort();
  state.rawGeneration += 1;
  setRawExpanded(false);
}

async function openRaw(href, path) {
  if (!href) return;
  state.rawController?.abort();
  const controller = new AbortController();
  state.rawController = controller;
  const generation = ++state.rawGeneration;
  elements.rawPath.textContent = path || t("Canonical source");
  elements.rawCode.textContent = t("Loading canonical source…");
  setRawExpanded(true);

  try {
    const raw = await api.loadRaw(href, { signal: controller.signal });
    if (controller.signal.aborted || generation !== state.rawGeneration) return;
    elements.rawCode.textContent = raw;
  } catch (error) {
    if (
      error?.name === "AbortError"
      || controller.signal.aborted
      || generation !== state.rawGeneration
    ) return;
    elements.rawCode.textContent = rawSourceErrorText(error);
  }
}

function rawSourceErrorText(error) {
  const guidance = localizedErrorGuidance(error);
  return [
    t("Raw source unavailable"),
    "",
    `${t("Outcome")}: ${guidance.outcome}`,
    `${t("Impact")}: ${guidance.impact}`,
    `${t("Decision")}: ${guidance.decision}`,
    `${t("Protection")}: ${guidance.protection}`,
    `${t("Next action")}: ${guidance.nextAction}`,
    "",
    `${t("Technical details (optional)")}:`,
    guidance.technical,
  ].join("\n");
}

function openFirstRaw() {
  const context = { portfolioProjectId: state.modelProjectId };
  const selectedTarget = rawTargetFor(state.selectedItem, context);
  if (selectedTarget) {
    openRaw(selectedTarget.href, selectedTarget.path);
    return;
  }
  const record = state.model?.records.find((candidate) => rawTargetFor(candidate, context));
  const recordTarget = rawTargetFor(record, context);
  if (recordTarget) openRaw(recordTarget.href, recordTarget.path);
}

function handleClick(event) {
  const viewButton = event.target.closest("[data-view]");
  if (viewButton) {
    setView(viewButton.dataset.view);
    return;
  }

  const actionElement = event.target.closest("[data-action]");
  if (!actionElement) return;
  switch (actionElement.dataset.action) {
    case "refresh":
      if (portfolioMode) loadPortfolioSummary({ preserveProject: true });
      else loadModel({ preserveSelection: true });
      break;
    case "select-project":
      if (portfolioMode) loadPortfolioProject(actionElement.dataset.projectId, {
        historyMode: "push",
      });
      break;
    case "toggle-navigation":
      setNavigationOpen(!elements.navigation.classList.contains("is-open"));
      break;
    case "select-record":
      if (actionElement.dataset.iterationId) {
        state.selectedIterationId = actionElement.dataset.iterationId;
      }
      selectRecord(actionElement.dataset.selectId);
      break;
    case "select-iteration":
      selectIteration(actionElement.dataset.iterationId);
      break;
    case "select-phase":
      selectPhase(actionElement.dataset.iterationId, actionElement.dataset.phase);
      break;
    case "open-raw":
      openRaw(actionElement.dataset.rawHref, actionElement.dataset.rawPath);
      break;
    case "open-first-raw":
      openFirstRaw();
      break;
    case "toggle-raw":
      setRawExpanded(!state.rawExpanded);
      break;
    case "close-raw":
      closeRaw();
      break;
    case "close-inspector":
      state.inspectorOpen = false;
      render();
      break;
    case "toggle-live":
      setLive(!state.live);
      break;
    case "toggle-expert":
      state.expertOpen = !(state.expertOpen || !EVERYDAY_VIEWS.has(state.view));
      try {
        window.localStorage?.setItem("observatory.expertOpen", state.expertOpen ? "1" : "0");
      } catch {
        // Storage may be unavailable; the choice then lasts for this visit.
      }
      updateNavigation();
      break;
    default:
      handleExploreAction(actionElement);
  }
}

function numberOrNull(value) {
  const number = Number(value);
  return value !== undefined && value !== "" && Number.isFinite(number) ? number : null;
}

function goToView(view, { storyId, storyState, kinds } = {}) {
  const explore = state.explore;
  explore.pages = 1;
  if (storyId !== undefined) explore.storyId = storyId;
  if (storyState !== undefined) explore.storyState = storyState;
  if (kinds !== undefined) explore.kinds = kinds ? new Set(kinds.split(",")) : null;
  if (view === state.view) render();
  else setView(view);
}

// Views added for visual exploration share one action vocabulary so every
// chart, chip, and card stays keyboard reachable through plain buttons.
function handleExploreAction(element) {
  if (!state.model) return;
  const explore = state.explore;
  const data = element.dataset;
  switch (data.action) {
    case "go-view":
      explore.range = null;
      explore.query = "";
      goToView(data.targetView, {
        storyId: data.storyId ?? (data.targetView === "activity" ? "" : undefined),
        storyState: data.storyState,
        kinds: data.kinds ?? (data.targetView === "activity" ? "" : undefined),
      });
      break;
    case "open-story":
      explore.expanded.add(data.storyId);
      explore.storyState = "all";
      explore.query = "";
      goToView("stories");
      [...elements.primary.querySelectorAll(".story-row")]
        .find((row) => row.dataset.storyId === data.storyId)
        ?.scrollIntoView?.({ block: "center", behavior: "smooth" });
      break;
    case "toggle-story":
      if (explore.expanded.has(data.storyId)) explore.expanded.delete(data.storyId);
      else explore.expanded.add(data.storyId);
      render();
      break;
    case "set-story-state":
      explore.storyState = data.storyState || "all";
      explore.pages = 1;
      render();
      break;
    case "toggle-kind": {
      const all = ["request", "agreement", "change", "decision", "check"];
      const kinds = new Set(explore.kinds ?? all);
      if (kinds.has(data.kind)) kinds.delete(data.kind);
      else kinds.add(data.kind);
      explore.kinds = kinds.size === all.length || kinds.size === 0 ? null : kinds;
      explore.pages = 1;
      render();
      break;
    }
    case "select-range": {
      const start = numberOrNull(data.rangeStart);
      const end = numberOrNull(data.rangeEnd);
      if (start === null || end === null) return;
      explore.range = explore.range?.start === start ? null : { start, end };
      explore.pages = 1;
      if (state.view !== "activity") goToView("activity");
      else render();
      break;
    }
    case "clear-filters":
      explore.query = "";
      explore.kinds = null;
      explore.range = null;
      explore.storyId = "";
      explore.pages = 1;
      render();
      break;
    case "timeline-more":
      explore.pages += 1;
      render();
      break;
    case "plan-all":
      explore.planAll = true;
      render();
      break;
    case "open-map":
      explore.mapStoryId = data.storyId;
      explore.mapMode = "story";
      goToView("map");
      break;
    case "map-mode":
      explore.mapMode = data.mapMode === "story" ? "story" : "plan";
      if (data.storyId) explore.mapStoryId = data.storyId;
      if (data.planFocus) explore.planFocus = data.planFocus;
      if (data.targetView && data.targetView !== state.view) goToView(data.targetView);
      else render();
      break;
    case "plan-focus":
      explore.planFocus = explore.planFocus === data.storyId ? null : data.storyId;
      render();
      break;
    case "open-dossier":
      state.selectedIterationId = data.iterationId;
      goToView("timeline");
      break;
    case "map-zoom": {
      const steps = { in: 1.25, out: 0.8 };
      explore.mapZoom = data.zoom === "reset"
        ? 1
        : Math.min(2.5, Math.max(0.5, (explore.mapZoom || 1) * (steps[data.zoom] ?? 1)));
      render();
      break;
    }
  }
}

function handleChange(event) {
  if (portfolioMode && event.target.id === "project-select") {
    if (event.target.value === "") {
      renderPortfolioHome({ focus: true, historyMode: "push" });
    } else {
      loadPortfolioProject(event.target.value, { historyMode: "push" });
    }
    return;
  }
  const exploreField = event.target.dataset?.explore;
  if (exploreField && exploreField !== "query" && state.model) {
    if (exploreField === "sort") {
      state.explore.sort = event.target.value;
      state.explore.pages = 1;
    }
    if (exploreField === "storyId") {
      state.explore.storyId = event.target.value;
      state.explore.pages = 1;
    }
    if (exploreField === "mapStoryId") state.explore.mapStoryId = event.target.value;
    render();
    return;
  }
  const filter = event.target.dataset.filter;
  if (filter === "dossier") {
    selectIteration(event.target.value);
    return;
  }
  if (!filter || !Object.hasOwn(state.filters, filter)) return;
  state.filters[filter] = event.target.value;
  if (filter === "iteration" && event.target.value) {
    state.selectedIterationId = event.target.value;
  }
  render();
}

function handleNavigationKeydown(event) {
  if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const buttons = [...elements.navigation.querySelectorAll("[data-view]")];
  const current = buttons.indexOf(document.activeElement);
  if (current < 0) return;

  event.preventDefault();
  let next = current;
  if (["ArrowDown", "ArrowRight"].includes(event.key)) next = (current + 1) % buttons.length;
  if (["ArrowUp", "ArrowLeft"].includes(event.key)) next = (current - 1 + buttons.length) % buttons.length;
  if (event.key === "Home") next = 0;
  if (event.key === "End") next = buttons.length - 1;
  buttons[next].focus();
}

let queryTimer = null;

function handleInput(event) {
  if (event.target?.dataset?.explore !== "query" || !state.model) return;
  const value = event.target.value;
  clearTimeout(queryTimer);
  queryTimer = setTimeout(() => {
    state.explore.query = value;
    state.explore.pages = 1;
    render();
  }, 160);
}

// Chart bars and map boxes are SVG groups with role="button"; give them the
// same Enter/Space behaviour as real buttons.
function activateRoleButton(event) {
  if (event.key !== "Enter" && event.key !== " ") return false;
  const target = event.target;
  if (target?.getAttribute?.("role") !== "button" || target.tagName === "BUTTON") return false;
  event.preventDefault?.();
  handleClick({ target });
  return true;
}

function setLive(enabled) {
  state.live = enabled;
  clearInterval(state.liveTimer);
  state.liveTimer = enabled
    ? setInterval(quietReload, INSIGHT_SETTINGS.liveRefreshSeconds * 1000)
    : null;
  const toggle = document.querySelector('[data-action="toggle-live"]');
  if (toggle) {
    toggle.setAttribute("aria-pressed", String(enabled));
    toggle.classList.toggle("is-on", enabled);
  }
  if (enabled) quietReload();
}

// Live updates re-read the evidence without loading screens or resets, so
// the reader keeps their place while new records appear.
async function quietReload() {
  if (state.quietLoading || !state.model || document.hidden) return;
  const projectId = state.modelProjectId;
  if (portfolioMode && !projectId) return;
  state.quietLoading = true;
  try {
    const loaded = portfolioMode ? await api.loadProject(projectId) : await api.load();
    if (!state.model || state.modelProjectId !== projectId) return;
    const project = state.portfolioSummary?.projects.find((item) => item.id === projectId);
    const model = project ? withManifestProjectName(loaded, project) : loaded;
    applyProjectModel(model, {
      portfolioProjectId: projectId,
      preservedSelection: captureProjectSelection(projectId),
    });
    if (!portfolioMode) renderSummary(elements.summary, model);
    renderDiagnostics(elements.diagnostics, model.diagnostics);
    render();
    setApiStatus("Read-only · live", "ready");
  } catch {
    setApiStatus("Live updates paused", "warning");
  } finally {
    state.quietLoading = false;
  }
}

function handleDocumentKeydown(event) {
  if (activateRoleButton(event)) return;
  if (event.key !== "Escape" || !state.rawExpanded) return;
  event.preventDefault?.();
  closeRaw();
}

document.addEventListener("click", handleClick);
document.addEventListener("keydown", handleDocumentKeydown);
document.addEventListener("change", handleChange);
document.addEventListener("input", handleInput);
elements.navigation.addEventListener("keydown", handleNavigationKeydown);
function synchronizeLocation() {
  const view = viewFromHash();
  if (view !== state.view) state.inspectorOpen = false;
  state.view = view;
  if (!portfolioMode) {
    render();
    return;
  }
  const route = portfolioProjectRouteFromLocation(window.location);
  if (!state.portfolioSummary) {
    loadPortfolioSummary({
      requestedProjectId: route.projectId,
      canonicalizeFallback: !route.valid,
    });
    return;
  }
  if (!route.valid) {
    renderPortfolioHome({ focus: true, historyMode: "replace" });
    return;
  }
  if (route.projectId === null) {
    if (state.selectedProjectId !== "" || state.model) {
      renderPortfolioHome({ focus: true });
    } else {
      updateNavigation();
    }
    return;
  }
  if (route.projectId !== state.selectedProjectId) {
    loadPortfolioProject(route.projectId, { focus: true });
    return;
  }
  updateNavigation();
  render();
}

window.addEventListener("hashchange", synchronizeLocation);
window.addEventListener("popstate", synchronizeLocation);

if (portfolioMode) {
  setPortfolioHomeContext();
  const initialRoute = portfolioProjectRouteFromLocation(window.location);
  loadPortfolioSummary({
    requestedProjectId: initialRoute.projectId,
    canonicalizeFallback: !initialRoute.valid,
  });
}
else {
  setGenericWorkspaceContext();
  loadModel();
  mountNowPanel({ api, anchor: elements.summary });
}
