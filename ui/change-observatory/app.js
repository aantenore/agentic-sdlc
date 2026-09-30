import { ObservatoryApi, accessTokenFromHash } from "./api.js";
import {
  phaseSelectionId,
  phaseSelectionItem,
  renderDiagnostics,
  renderFatalError,
  renderInspector,
  renderPrimary,
  renderProjectControls,
  renderSummary,
} from "./components.js";
import {
  preferredDossierIteration,
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
  localeFromLocation,
  localizedErrorGuidance,
  setLocale,
  t,
} from "./i18n.js";

const locale = setLocale(localeFromLocation(window.location));
applyDocumentLocale(document, locale);
const portfolioMode = portfolioModeFromLocation(window.location);

const VALID_VIEWS = new Set([
  "overview",
  "timeline",
  "contracts",
  "decisions",
  "changes",
  "intent-evidence",
  "verification",
]);
const VIEW_LABELS = Object.freeze({
  overview: "Overview",
  timeline: "Timeline",
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

const state = {
  model: null,
  view: viewFromHash(),
  filters: { iteration: "", phase: "" },
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

function updateNavigation() {
  document.querySelectorAll("[data-view]").forEach((button) => {
    const active = button.dataset.view === state.view;
    button.classList.toggle("is-active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
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
  renderPrimary(elements.primary, state.model, state);
  renderInspector(elements.inspector, state.selectedItem, {
    portfolioProjectId: state.portfolioProjectId,
  });
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
}

function captureProjectSelection(portfolioProjectId) {
  if (!state.model || state.modelProjectId !== portfolioProjectId) return null;
  return {
    selectedIterationId: state.selectedIterationId,
    selectedId: state.selectedId,
  };
}

function clearProjectModel() {
  state.model = null;
  state.modelProjectId = null;
  state.selectedItem = null;
  state.selectedId = null;
  state.selectedIterationId = null;
  state.records = new Map();
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
    const model = await api.loadProject(project.id, { signal: request.signal });
    if (!request.isCurrent() || state.selectedProjectId !== project.id) return;
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
  state.view = view;
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

function setRawExpanded(expanded) {
  state.rawExpanded = expanded;
  elements.rawDrawer.dataset.expanded = String(expanded);
  elements.rawToggle.setAttribute("aria-expanded", String(expanded));
  elements.rawContent.hidden = !expanded;
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
      state.rawController?.abort();
      state.rawGeneration += 1;
      setRawExpanded(false);
      break;
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

document.addEventListener("click", handleClick);
document.addEventListener("change", handleChange);
elements.navigation.addEventListener("keydown", handleNavigationKeydown);
function synchronizeLocation() {
  state.view = viewFromHash();
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
}
