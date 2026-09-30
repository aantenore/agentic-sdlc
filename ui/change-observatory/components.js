import {
  DOSSIER_LANES,
  PHASES,
  filterIterations,
  firstSummaryItem,
  formatTimestamp,
  groupChangesByIntent,
  narrativeFor,
  preferredDossierIteration,
  rawHrefForPath,
  rawTargetFor,
  readable,
  recordSelectionKey,
  sentenceCase,
} from "./model.js";
import {
  displayKindForItem,
  displayTextForItem,
  humanGuidanceForItem,
  isAutonomyRecord,
  localizePlaceholder,
  localizeUiText,
  localizedErrorGuidance,
  sharedRecordGuidance,
  t,
  usesSharedRecordGuidance,
} from "./i18n.js";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

function node(tag, options = {}, children = []) {
  const element = document.createElement(tag);
  if (options.className) element.className = options.className;
  if (options.text !== undefined) {
    element.textContent = options.i18n
      ? localizeUiText(options.text)
      : String(options.text ?? "");
  }
  for (const [name, value] of Object.entries(options.attrs ?? {})) {
    if (value !== null && value !== undefined) {
      const rendered = options.i18n && (name === "title" || name.startsWith("aria-"))
        ? localizeUiText(value)
        : value;
      element.setAttribute(name, String(rendered));
    }
  }
  for (const [name, value] of Object.entries(options.dataset ?? {})) {
    if (value !== null && value !== undefined) element.dataset[name] = String(value);
  }
  element.append(...children.filter(Boolean));
  return element;
}

function icon(name, className = "") {
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  if (className) svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(SVG_NAMESPACE, "use");
  use.setAttribute("href", `#icon-${name}`);
  svg.append(use);
  return svg;
}

function provenanceBadge(provenance) {
  return node("span", {
    className: "provenance",
    text: sentenceCase(provenance),
    i18n: true,
    dataset: { provenance },
  });
}

function sourceButtonFor(item, label = "Source records", portfolioProjectId = null) {
  const target = rawTargetFor(item, { portfolioProjectId });
  if (!target) return null;
  const display = displayTextForItem(item);
  return node(
    "button",
    {
      className: "source-button",
      attrs: { type: "button", "aria-label": `${t(label)}: ${display.title}` },
      dataset: { action: "open-raw", rawHref: target.href, rawPath: target.path },
    },
    [icon("source"), node("span", { text: label, i18n: true })],
  );
}

function emptyInline(message) {
  return node("p", { className: "empty-inline", text: message, i18n: true });
}

function statusKey(status) {
  return readable(status, "missing").replace(/[^a-z]/gi, "").toLowerCase();
}

function statusText(status) {
  return node("span", {
    className: "status-text",
    text: sentenceCase(status),
    i18n: true,
    dataset: { state: statusKey(status) },
  });
}

function sectionHeading(title, description, actions = []) {
  const copy = node("div", {}, [
    node("h2", { text: title, i18n: true }),
    description ? node("p", { text: description, i18n: true }) : null,
  ]);
  return node("header", { className: "section-heading" }, [
    copy,
    actions.length ? node("div", { className: "section-heading-actions" }, actions) : null,
  ]);
}

function selectControl(label, name, values, selectedValue) {
  const select = node("select", {
    className: "compact-select",
    attrs: { "aria-label": t(label) },
    dataset: { filter: name },
  });
  select.append(node("option", { text: `${label}: All`, i18n: true, attrs: { value: "" } }));
  for (const value of values) {
    const option = node("option", {
      text: name === "phase" ? sentenceCase(value.label ?? value) : String(value.label ?? value),
      i18n: name === "phase",
      attrs: { value: value.value ?? value },
    });
    if ((value.value ?? value) === selectedValue) option.selected = true;
    select.append(option);
  }
  return select;
}

export function renderProjectControls(model) {
  const projectSelect = document.querySelector("#project-select");
  const snapshotSelect = document.querySelector("#snapshot-select");
  projectSelect.replaceChildren(
    node("option", { text: localizePlaceholder(model.project.name), attrs: { value: model.project.id } }),
  );
  snapshotSelect.replaceChildren(
    node("option", {
      text: model.project.branch || model.project.snapshot || t("Current evidence"),
      attrs: { value: "current" },
    }),
  );
}

function renderSummaryAnswer(question, items, portfolioProjectId = null, sharedGuidance = null) {
  const item = firstSummaryItem(items);
  const article = node("article", { className: "summary-answer" }, [
    node("h2", { text: question, i18n: true }),
  ]);
  if (!item) {
    article.append(humanGuidanceSection({
      outcome: "No recorded evidence answers this question yet.",
      impact: "This part of the project history may be incomplete.",
      decision: "Do not treat missing evidence as approval or completed work.",
      protection: "This view remains read-only and does not invent missing facts.",
      nextAction: "Return to the Codex chat and describe the missing evidence in natural language; after it is recorded, refresh this view.",
    }));
    article.append(
      node("div", { className: "summary-meta" }, [provenanceBadge("missing")]),
    );
    return article;
  }
  article.append(
    recordedAnswerForItem(item),
    cardGuidanceBlock(item, sharedGuidance),
    technicalDetailsForItem(item, [], portfolioProjectId),
  );
  return article;
}

function recordedAnswerForItem(item) {
  const display = displayTextForItem(item);
  const recordedStatus = String(item?.status ?? "").trim().toLowerCase().replace(/[-\s]+/gu, "_");
  const hasMeaningfulStatus = display.status
    && !["", "missing", "not_recorded"].includes(recordedStatus);
  return node("section", {
    className: "summary-recorded-answer",
    attrs: { "aria-label": t("Recorded answer") },
  }, [
    node("span", { className: "summary-answer-label", text: "Recorded answer", i18n: true }),
    node("strong", { text: display.title }),
    node("p", { text: display.summary }),
    hasMeaningfulStatus ? statusText(display.status) : null,
  ]);
}

export function renderSummary(container, model, { portfolioProjectId = null } = {}) {
  const sharedGuidance = sharedGuidanceTracker();
  container.replaceChildren(
    renderSummaryAnswer("What was asked?", model.summary.asked, portfolioProjectId, sharedGuidance),
    renderSummaryAnswer("What changed?", model.summary.changed, portfolioProjectId, sharedGuidance),
    renderSummaryAnswer("Why was it decided?", model.summary.decided, portfolioProjectId, sharedGuidance),
    sharedGuidanceSection(sharedGuidance, "summary-shared-guidance"),
  );
}

export function renderDiagnostics(container, diagnostics) {
  if (!diagnostics.length) {
    container.hidden = true;
    container.replaceChildren();
    return;
  }
  container.hidden = false;
  const occurrenceTotal = diagnostics.reduce(
    (total, diagnostic) => total + diagnostic.occurrences,
    0,
  );
  const disclosure = node("details", {
    className: "diagnostics-disclosure",
    attrs: { open: diagnostics.some((diagnostic) => diagnostic.severity === "error") ? "" : null },
  });
  disclosure.append(
    node("summary", {}, [
      icon("alert"),
      node("strong", { text: "Evidence diagnostics", i18n: true }),
      node("span", {
        text: `${diagnostics.length} ${diagnostics.length === 1 ? "category" : "categories"} · ${occurrenceTotal} ${occurrenceTotal === 1 ? "record" : "records"}`,
        i18n: true,
      }),
    ]),
    node("div", { className: "diagnostics-human-summary" }, [
      node("strong", { text: "Evidence needs attention", i18n: true }),
      node("dl", { className: "human-guidance-grid" }, [
        guidanceField("Outcome", "Some recorded evidence could not be read safely.", { i18nText: true }),
        guidanceField("Impact", "Related views may be incomplete until the evidence is corrected.", { i18nText: true }),
        guidanceField("Decision", "Do not make a decision from the affected view alone.", { i18nText: true }),
        guidanceField("Protection", "Unsafe or unsupported evidence is omitted and no project file is changed.", { i18nText: true }),
        guidanceField("Next action", "Open technical details, then return to the Codex chat and describe the correction in natural language; after it is recorded, refresh this view.", { i18nText: true }),
      ]),
    ]),
    node("details", { className: "technical-details diagnostics-technical" }, [
      node("summary", { text: "Technical details (optional)", i18n: true }),
      node("div", { className: "diagnostics-list" }, diagnostics.map((diagnostic) =>
        node(
          "div",
          {
            className: "diagnostic",
            attrs: { role: diagnostic.severity === "error" ? "alert" : "status" },
            dataset: { severity: diagnostic.severity },
          },
          [
            icon("alert"),
            node("div", { className: "diagnostic-copy" }, [
              node("strong", { text: `${diagnostic.code}: ` }),
              document.createTextNode(diagnostic.message),
              diagnostic.occurrences > 1
                ? node("span", {
                  className: "diagnostic-count",
                  text: `${diagnostic.occurrences} records`,
                  i18n: true,
                  attrs: { title: "Equivalent diagnostics grouped" },
                })
                : null,
            ]),
          ],
        ),
      )),
    ]),
  );
  container.replaceChildren(disclosure);
}

function phaseStateIcon(status) {
  const iconName = {
    complete: "check",
    inProgress: "clock",
    blocked: "blocked",
    missing: "minus",
  }[status] ?? "minus";
  return node("span", { className: "state-icon", dataset: { state: status } }, [icon(iconName)]);
}

export function phaseSelectionId(iterationId, phase) {
  return `phase:${iterationId}:${phase}`;
}

export function phaseSelectionItem(iteration, phaseState, portfolioProjectId = null) {
  const primarySource = phaseState.sourceRefs[0];
  const rawAvailable = primarySource?.rawAvailable !== false;
  return {
    id: phaseSelectionId(iteration.id, phaseState.phase),
    type: "phase-state",
    title: `${localizePlaceholder(iteration.title)} · ${t(sentenceCase(phaseState.phase))}`,
    summary: t(`${sentenceCase(phaseState.phase)} is ${sentenceCase(phaseState.status).toLowerCase()} for ${localizePlaceholder(iteration.title)}.`),
    status: phaseState.status,
    phase: phaseState.phase,
    timestamp: iteration.timestamp,
    provenance: phaseState.provenance,
    sourceRefs: phaseState.sourceRefs,
    rawHref: rawAvailable && primarySource
      ? rawHrefForPath(primarySource.path, portfolioProjectId)
      : null,
    ...(rawAvailable ? {} : { rawAvailable: false }),
    narrative: {
      inputSummary: null,
      outputSummary: null,
      rationale: null,
      generatedExplanation: null,
      explanationSource: null,
      alternatives: [],
      evidence: [],
      chainOfThoughtIncluded: false,
    },
    explanation: {},
    inputs: [],
    outputs: [],
    alternatives: [],
    evidence: [],
  };
}

function lineagePanel(model, state) {
  const iterationValues = model.iterations.map((iteration) => ({
    value: iteration.id,
    label: localizePlaceholder(iteration.title),
  }));
  const actions = [
    selectControl("Iteration", "iteration", iterationValues, state.filters.iteration),
    selectControl("Phase", "phase", PHASES, state.filters.phase),
  ];
  const panel = node("section", { className: "section-panel", attrs: { "aria-labelledby": "lineage-heading" } }, [
    sectionHeading(
      "Project lineage",
      "Iteration-by-phase reconstruction from canonical evidence",
      actions,
    ),
  ]);
  panel.querySelector("h2").id = "lineage-heading";

  const iterations = filterIterations(model.iterations, state.filters);
  if (!iterations.length) {
    panel.append(emptyInline("No recorded iterations match the selected filters."));
    return panel;
  }

  const table = node("table", { className: "lineage-table" });
  const headRow = node("tr", {}, [node("th", { text: "Iteration", i18n: true, attrs: { scope: "col" } })]);
  PHASES.forEach((phase, index) => {
    headRow.append(
      node("th", { attrs: { scope: "col" } }, [
        node("span", { className: "phase-heading" }, [
          node("span", { className: "phase-number", text: String(index + 1) }),
          node("span", { text: sentenceCase(phase), i18n: true }),
        ]),
      ]),
    );
  });
  table.append(node("thead", {}, [headRow]));

  const body = node("tbody");
  for (const iteration of iterations) {
    const row = node("tr", { dataset: { current: Boolean(iteration.currentPhase) } });
    row.append(
      node("th", { className: "iteration-heading", attrs: { scope: "row" } }, [
        node("button", {
          className: "iteration-select-button",
          attrs: {
            type: "button",
            "aria-pressed": String(state.selectedIterationId === iteration.id),
          },
          dataset: { action: "select-iteration", iterationId: iteration.id },
        }, [
          node("strong", { text: localizePlaceholder(iteration.title) }),
          node("span", { text: iteration.timestamp ? formatTimestamp(iteration.timestamp) : iteration.id }),
        ]),
      ]),
    );
    for (const phase of iteration.phases) {
      const selectionId = recordSelectionKey(phaseSelectionItem(
        iteration,
        phase,
        state.portfolioProjectId,
      ));
      const associatedSelection =
        state.selectedIterationId === iteration.id
        && state.selectedItem?.phase === phase.phase
        && iteration.currentPhase === phase.phase;
      row.append(
        node("td", {}, [
          node(
            "button",
            {
              className: "cell-button",
              attrs: {
                type: "button",
                "aria-pressed": String(state.selectedId === selectionId || associatedSelection),
                "aria-label": `${localizePlaceholder(iteration.title)}, ${t(sentenceCase(phase.phase))}: ${t(sentenceCase(phase.status))}, ${t(sentenceCase(phase.provenance))}`,
              },
              dataset: {
                action: "select-phase",
                iterationId: iteration.id,
                phase: phase.phase,
              },
            },
            [
              phaseStateIcon(phase.status),
              node("span", { className: "state-label", text: sentenceCase(phase.status), i18n: true }),
              provenanceBadge(phase.provenance),
            ],
          ),
        ]),
      );
    }
    body.append(row);
  }
  table.append(body);
  panel.append(
    node("div", { className: "lineage-scroll", i18n: true, attrs: { tabindex: "0", "aria-label": "Scrollable lineage matrix" } }, [table]),
    node("footer", { className: "lineage-legend", i18n: true, attrs: { "aria-label": "Lineage status legend" } }, [
      ...[
        ["complete", "Complete"],
        ["inProgress", "In progress"],
        ["blocked", "Blocked"],
        ["missing", "Missing"],
      ].map(([status, label]) =>
        node("span", { className: "legend-item" }, [
          node("span", { className: "legend-dot", dataset: { state: status } }),
          document.createTextNode(t(label)),
        ]),
      ),
      node("span", { className: "legend-item" }, [provenanceBadge("recorded")]),
      node("span", { className: "legend-item" }, [provenanceBadge("inferred")]),
    ]),
  );
  return panel;
}

function dossierLaneItems(dossier, laneKey) {
  const laneItems = dossier.lanes[laneKey]?.items ?? [];
  if (laneKey !== "verified") return laneItems.map((item) => ({ item, sourceLane: laneKey }));
  return [
    ...laneItems.map((item) => ({ item, sourceLane: "verified" })),
    ...(dossier.lanes.release?.items ?? []).map((item) => ({ item, sourceLane: "release" })),
  ];
}

function dossierLaneState(dossier, laneKey, items) {
  const lane = dossier.lanes[laneKey];
  if (laneKey !== "verified") return lane;
  const releaseLane = dossier.lanes.release;
  if (items.length) {
    return {
      status: "recorded",
      provenance:
        lane.provenance === "recorded" || releaseLane.provenance === "recorded"
          ? "recorded"
          : lane.provenance,
    };
  }
  return lane.status !== "missing" ? lane : releaseLane;
}

function linkageLabel(item) {
  if (item.linkage?.status !== "linked") return "Link metadata missing";
  if (!item.linkage.via.length) return "Link method not recorded";
  return `Linked by ${item.linkage.via.map(sentenceCase).join(", ").toLowerCase()}`;
}

function dossierNarrative(item, laneKey) {
  const narrative = narrativeFor(item);
  if (laneKey !== "decided" && !narrative.rationale && !narrative.generatedExplanation) return null;
  return node("div", { className: "dossier-narrative" }, [
    node("div", {
      className: "dossier-narrative-part",
      dataset: { state: narrative.rationale ? "recorded" : "missing" },
    }, [
      node("span", { text: "Recorded rationale", i18n: true }),
      node("p", { text: narrative.rationale || t("Not recorded.") }),
    ]),
    node("div", {
      className: "dossier-narrative-part",
      dataset: { state: narrative.generatedExplanation ? "generated" : "missing" },
    }, [
      node("span", {
        text: narrative.generatedExplanation
          ? `Generated explanation · ${sentenceCase(narrative.explanationLabel || "source recorded")}`
          : "Generated explanation",
        i18n: true,
      }),
      node("p", { text: narrative.generatedExplanation || t("Not recorded.") }),
    ]),
  ]);
}

function dossierItem(item, sourceLane, laneKey, state, iterationId, sharedGuidance = null) {
  const selectionId = recordSelectionKey(item);
  const display = displayTextForItem(item);
  const itemKind = sourceLane === "release" || item.type === "release"
    ? t("Release evidence")
    : displayKindForItem(item);
  return node("article", {
    className: "dossier-item",
    dataset: { sourceLane, provenance: item.provenance },
  }, [
    node("button", {
      className: "dossier-item-select",
      attrs: {
        type: "button",
        "aria-pressed": String(selectionId === state.selectedId),
        "aria-label": t(`Inspect ${display.title}`),
      },
      dataset: {
        action: "select-record",
        selectId: selectionId,
        iterationId,
      },
    }, [
      node("span", { className: "dossier-item-title", text: display.title }),
      node("span", { className: "dossier-item-summary", text: display.summary }),
    ]),
    cardGuidanceBlock(item, sharedGuidance),
    technicalDetailsForItem(
      item,
      isAutonomyRecord(item) ? [] : [dossierNarrative(item, laneKey)],
      state.portfolioProjectId,
    ),
    node("footer", { className: "dossier-item-footer" }, [
      node("span", { className: "dossier-item-kind", text: itemKind }),
      statusText(display.status),
      provenanceBadge(item.provenance),
      node("span", {
        className: "dossier-linkage",
        text: isAutonomyRecord(item)
          ? (item.linkage?.status === "linked"
              ? "Linked to related recorded evidence"
              : "Related evidence link not recorded")
          : linkageLabel(item),
        i18n: true,
      }),
    ]),
  ]);
}

function dossierMissingLane(laneState) {
  return node("div", { className: "dossier-missing", attrs: { role: "status" } }, [
    node("strong", { text: "No linked evidence", i18n: true }),
    node("p", { text: "No explicitly linked canonical record was provided for this lane.", i18n: true }),
    provenanceBadge(laneState?.provenance ?? "missing"),
  ]);
}

function dossierLane(dossier, definition, state, iterationId, index, sharedGuidance = null) {
  const items = dossierLaneItems(dossier, definition.key);
  const laneState = dossierLaneState(dossier, definition.key, items);
  return node("section", {
    className: "dossier-lane",
    attrs: { "aria-labelledby": `dossier-lane-${definition.key}` },
    dataset: { state: items.length ? laneState.status : "missing" },
  }, [
    node("header", { className: "dossier-lane-header" }, [
      node("span", { className: "dossier-step", text: String(index + 1), attrs: { "aria-hidden": "true" } }),
      node("div", {}, [
        node("h3", { text: definition.label, i18n: true, attrs: { id: `dossier-lane-${definition.key}` } }),
        node("span", { text: items.length ? `${items.length} linked ${items.length === 1 ? "record" : "records"}` : "Evidence missing", i18n: true }),
      ]),
      provenanceBadge(items.length ? laneState.provenance : "missing"),
    ]),
    node("div", { className: "dossier-lane-body" }, items.length
      ? items.map(({ item, sourceLane }) =>
        dossierItem(item, sourceLane, definition.key, state, iterationId, sharedGuidance))
      : [dossierMissingLane(laneState)]),
  ]);
}

function unlinkedLineageDisclosure(items, state, sharedGuidance = null) {
  if (!items.length) return null;
  return node("details", { className: "unlinked-lineage" }, [
    node("summary", {}, [
      node("strong", { text: "Unlinked project evidence", i18n: true }),
      node("span", { text: `${items.length} ${items.length === 1 ? "record" : "records"}`, i18n: true }),
    ]),
    node("p", {
      text: "These canonical records are visible, but no explicit story link assigns them to an iteration dossier.",
      i18n: true,
    }),
    node("div", { className: "unlinked-lineage-list" }, items.map((item) =>
      dossierItem(item, "unlinked", "unlinked", state, null, sharedGuidance),
    )),
  ]);
}

function selectedDossierIteration(model, state) {
  const requested = state.selectedIterationId || state.filters.iteration;
  return model.iterations.find((iteration) => iteration.id === requested)
    || preferredDossierIteration(model.iterations);
}

function dossierPanel(model, state) {
  const selectedIteration = selectedDossierIteration(model, state);
  const iterationValues = model.iterations.map((iteration) => ({
    value: iteration.id,
    label: localizePlaceholder(iteration.title),
  }));
  const actions = iterationValues.length
    ? [selectControl(
      "Dossier iteration",
      "dossier",
      iterationValues,
      selectedIteration?.id ?? "",
    )]
    : [];
  const panel = node("section", {
    className: "section-panel dossier-panel",
    attrs: { "aria-labelledby": "dossier-heading" },
  }, [
    sectionHeading(
      "Iteration dossier",
      "The recorded path from request to verification; links are never inferred in the browser",
      actions,
    ),
  ]);
  panel.querySelector("h2").id = "dossier-heading";

  if (!selectedIteration) {
    panel.append(emptyInline("No recorded iteration is available for a lineage dossier."));
    const unlinked = unlinkedLineageDisclosure(model.unlinkedLineage, state);
    if (unlinked) panel.append(unlinked);
    return panel;
  }

  const dossier = selectedIteration.dossier;
  const dossierMeta = node("header", { className: "dossier-meta", attrs: { "aria-live": "polite" } }, [
    node("div", {}, [
      node("span", { className: "dossier-label", text: "Selected iteration", i18n: true }),
      node("h3", { text: localizePlaceholder(selectedIteration.title) }),
      node("p", { text: localizePlaceholder(dossier?.summary || selectedIteration.summary) }),
    ]),
    node("div", { className: "dossier-meta-actions" }, [
      statusText(dossier?.status ?? "missing"),
      provenanceBadge(dossier?.provenance ?? "missing"),
      dossier
        ? sourceButtonFor(
            { ...dossier, title: selectedIteration.title },
            "Open dossier source",
            state.portfolioProjectId,
          )
        : null,
    ]),
  ]);
  panel.append(dossierMeta);

  if (!dossier) {
    panel.append(node("div", { className: "dossier-unavailable", attrs: { role: "status" } }, [
      node("strong", { text: "Dossier not recorded", i18n: true }),
      node("p", { text: "This iteration has no proof-bound dossier. Project-level or unlinked evidence is not assigned here.", i18n: true }),
      provenanceBadge("missing"),
    ]));
    const unlinked = unlinkedLineageDisclosure(model.unlinkedLineage, state);
    if (unlinked) panel.append(unlinked);
    return panel;
  }

  if (!dossier.schemaSupported) {
    panel.append(node("div", { className: "diagnostic", attrs: { role: "alert" }, dataset: { severity: "warning" } }, [
      icon("alert"),
      node("div", { className: "diagnostic-copy" }, [
        node("strong", { text: "Unsupported dossier schema: ", i18n: true }),
        document.createTextNode(dossier.schemaVersion || t("Not recorded")),
      ]),
    ]));
    const unlinked = unlinkedLineageDisclosure(model.unlinkedLineage, state);
    if (unlinked) panel.append(unlinked);
    return panel;
  }

  const sharedGuidance = sharedGuidanceTracker();
  const flow = node("div", {
    className: "dossier-flow-scroll",
    attrs: {
      tabindex: "0",
      "aria-label": t(`Five-lane dossier for ${localizePlaceholder(selectedIteration.title)}`),
    },
  }, [
    node("div", { className: "dossier-flow" }, DOSSIER_LANES.map((definition, index) =>
      dossierLane(dossier, definition, state, selectedIteration.id, index, sharedGuidance),
    )),
  ]);
  const unlinked = unlinkedLineageDisclosure(model.unlinkedLineage, state, sharedGuidance);
  const shared = sharedGuidanceSection(sharedGuidance, "dossier-shared-guidance");
  if (shared) panel.append(shared);
  panel.append(flow);
  if (unlinked) panel.append(unlinked);

  if (dossier.diagnostics.length) {
    panel.append(node("details", { className: "dossier-diagnostics" }, [
      node("summary", { text: `Dossier diagnostics · ${dossier.diagnostics.length}`, i18n: true }),
      node("div", { className: "diagnostics-list" }, dossier.diagnostics.map((diagnostic) =>
        node("div", { className: "diagnostic", dataset: { severity: diagnostic.severity } }, [
          icon("alert"),
          node("div", { className: "diagnostic-copy" }, [
            node("strong", { text: `${diagnostic.code}: ` }),
            document.createTextNode(diagnostic.message),
          ]),
        ]),
      )),
    ]));
  }
  return panel;
}

function recordRow(item, selectedId) {
  const selectionId = recordSelectionKey(item);
  const display = displayTextForItem(item);
  return node(
    "button",
    {
      className: "list-row",
      attrs: {
        type: "button",
        "aria-pressed": String(selectedId === selectionId),
      },
      dataset: { action: "select-record", selectId: selectionId },
    },
    [
      node("span", { className: "record-main" }, [
        node("span", { className: "record-title", text: display.title }),
        node("span", { className: "record-summary", text: display.summary }),
      ]),
      node("span", { className: "record-meta" }, [
        statusText(display.status),
        provenanceBadge(item.provenance),
      ]),
    ],
  );
}

function recordsPanel(title, description, items, state, options = {}) {
  const panel = node("section", { className: "section-panel" }, [sectionHeading(title, description)]);
  if (!items.length) {
    panel.append(emptyInline(options.emptyMessage ?? `No ${title.toLowerCase()} were recorded.`));
    return panel;
  }
  const list = node("div", { className: "record-list", attrs: { role: "list" } });
  const visibleItems = options.limit ? items.slice(0, options.limit) : items;
  visibleItems.forEach((item) => {
    const row = recordRow(item, state.selectedId);
    list.append(node("div", { attrs: { role: "listitem" } }, [row]));
  });
  panel.append(list);
  if (visibleItems.length < items.length) {
    panel.append(node("footer", {
      className: "panel-note",
      text: `Showing ${visibleItems.length} of ${items.length}. Open the dedicated view for the complete history.`,
      i18n: true,
    }));
  }
  return panel;
}

function changesPanel(model, state, options = {}) {
  const visibleChanges = options.limit ? model.changes.slice(0, options.limit) : model.changes;
  const groups = groupChangesByIntent(visibleChanges);
  const panel = node("section", { className: "section-panel" }, [
    sectionHeading("Recorded changes", "Implementation and sync evidence grouped by recorded intent"),
  ]);
  if (!groups.length) {
    panel.append(emptyInline("No change records were found."));
    return panel;
  }
  const list = node("div", { className: "group-list" });
  for (const group of groups) {
    list.append(
      node("div", { className: "group-heading" }, [
        node("span", { text: localizePlaceholder(sentenceCase(group.intent)) }),
        node("span", { className: "group-count", text: String(group.items.length) }),
      ]),
    );
    group.items.forEach((item) => list.append(recordRow(item, state.selectedId)));
  }
  panel.append(list);
  if (visibleChanges.length < model.changes.length) {
    panel.append(node("footer", {
      className: "panel-note",
      text: `Showing ${visibleChanges.length} of ${model.changes.length}. Open Changes for the complete history.`,
      i18n: true,
    }));
  }
  return panel;
}

function verificationPanel(model, state, options = {}) {
  const panel = node("section", { className: "section-panel" }, [
    sectionHeading("Verification evidence", "Tests, gates, and validation outcomes"),
  ]);
  if (!model.verification.length) {
    panel.append(emptyInline("No verification evidence was recorded."));
    return panel;
  }
  const list = node("div", { className: "record-list", attrs: { role: "list" } });
  const visibleItems = options.limit
    ? model.verification.slice(0, options.limit)
    : model.verification;
  for (const item of visibleItems) {
    const display = displayTextForItem(item);
    list.append(
      node("div", { className: "verification-row", attrs: { role: "listitem" } }, [
        recordRow(item, state.selectedId),
        statusText(display.status),
      ]),
    );
  }
  panel.append(list);
  if (visibleItems.length < model.verification.length) {
    panel.append(node("footer", {
      className: "panel-note",
      text: `Showing ${visibleItems.length} of ${model.verification.length}. Open Verification for the complete history.`,
      i18n: true,
    }));
  }
  return panel;
}

const INTENT_EVIDENCE_LABELS = Object.freeze({
  shadow: "Shadow",
  original: "Original",
  "candidate-observed": "Candidate observed",
  identity: "Identity",
  bypass: "Bypass",
  "preparer-fault": "Preparer fault",
  "preparer-timeout": "Preparer timeout",
  "invalid-preparer-result": "Invalid preparer result",
  "present-unverified": "Present · unverified",
  "not-observed": "Not observed",
  "present-not-verified": "Present · not verified",
});

function intentEvidenceValue(label, value, { code = false } = {}) {
  return node("div", { className: "intent-evidence-field" }, [
    node("dt", { text: label, i18n: true }),
    code
      ? node("dd", {}, [node("code", { text: INTENT_EVIDENCE_LABELS[value] ?? value })])
      : node("dd", { text: INTENT_EVIDENCE_LABELS[value] ?? value, i18n: true }),
  ]);
}

function intentEvidenceDetails(item) {
  return node("dl", { className: "intent-evidence-grid" }, [
    intentEvidenceValue("Event ID", item.id, { code: true }),
    intentEvidenceValue("Mode", item.mode),
    intentEvidenceValue("Submitted", item.submitted),
    intentEvidenceValue("Outcome", item.outcome),
    intentEvidenceValue("Reason", item.reason, { code: true }),
    intentEvidenceValue("Proof", item.proof),
    intentEvidenceValue("MAC", item.macStatus),
  ]);
}

function intentEvidenceLink(item) {
  const linked = item.link.status === "linked";
  const section = node("section", { className: "intent-evidence-link" }, [
    node("h3", { text: "Project link", i18n: true }),
  ]);

  if (!linked) {
    section.append(node("p", { text: "Unlinked. No complete explicit story and trace link was recorded.", i18n: true }));
    return section;
  }

  section.append(
    node("p", {}, [
      document.createTextNode(`${t("Story")} `),
      node("code", { text: item.link.storyId }),
    ]),
  );
  if (item.link.traceIds.length) {
    section.append(
      node("div", { className: "intent-trace-list", i18n: true, attrs: { "aria-label": "Linked traces" } },
        item.link.traceIds.map((traceId) => node("code", { className: "intent-trace", text: traceId })),
      ),
    );
  } else {
    section.append(node("p", { className: "intent-evidence-muted", text: "No trace link was recorded.", i18n: true }));
  }
  return section;
}

function intentEvidenceCard(item, state) {
  const selectionId = recordSelectionKey(item);
  return node("article", { className: "intent-evidence-card" }, [
    node("header", { className: "intent-evidence-card-header" }, [
      node("div", {}, [
        node("span", { className: "intent-evidence-kicker", text: "IntentABI · Codex shadow", i18n: true }),
        node("button", {
          className: "intent-evidence-select",
          text: item.id,
          attrs: {
            type: "button",
            "aria-label": t(`Inspect IntentABI event ${item.id}`),
            "aria-pressed": String(state.selectedId === selectionId),
          },
          dataset: { action: "select-record", selectId: selectionId },
        }),
      ]),
      node("span", { className: "intent-evidence-readonly", text: "Read-only", i18n: true }),
    ]),
    intentEvidenceDetails(item),
    intentEvidenceLink(item),
    node("p", {
      className: "intent-evidence-note",
      text: "Content-free evidence only. MAC present · not verified by Change Observatory.",
      i18n: true,
    }),
  ]);
}

function intentEvidencePanel(model, state) {
  const panel = node("section", {
    className: "section-panel",
    attrs: { "aria-labelledby": "intent-evidence-heading" },
  }, [
    sectionHeading(
      "Intent evidence",
      "Content-free IntentABI shadow observations; integrity is shown without asserting verification",
    ),
  ]);
  panel.querySelector("h2").id = "intent-evidence-heading";

  if (!model.semanticObservations.length) {
    panel.append(emptyInline("No IntentABI shadow observations were recorded."));
    return panel;
  }

  panel.append(
    node("div", { className: "intent-evidence-list" },
      model.semanticObservations.map((item) => intentEvidenceCard(item, state)),
    ),
  );
  return panel;
}

function overview(model, state) {
  return node("div", { className: "view-stack" }, [
    dossierPanel(model, state),
    lineagePanel(model, state),
    node("div", { className: "overview-grid" }, [
      recordsPanel("Contract evolution", "Versions, approvals, and status", model.contracts, state, { limit: 6 }),
      changesPanel(model, state, { limit: 6 }),
      verificationPanel(model, state, { limit: 6 }),
    ]),
  ]);
}

export function renderPrimary(container, model, state) {
  let content;
  switch (state.view) {
    case "timeline":
      content = node("div", { className: "view-stack" }, [
        dossierPanel(model, state),
        lineagePanel(model, state),
      ]);
      break;
    case "contracts":
      content = recordsPanel(
        "Contract evolution",
        "Approved boundaries, versions, and source evidence",
        model.contracts,
        state,
      );
      break;
    case "decisions":
      content = recordsPanel(
        "Decisions",
        "Recorded rationale and alternatives across delivery",
        model.decisions,
        state,
      );
      break;
    case "changes":
      content = changesPanel(model, state);
      break;
    case "intent-evidence":
      content = intentEvidencePanel(model, state);
      break;
    case "verification":
      content = verificationPanel(model, state);
      break;
    default:
      content = overview(model, state);
  }
  container.replaceChildren(content);
}

function inspectorTextSection(title, text, tone = null, meta = null) {
  return node(
    "section",
    {
      className: "inspector-section",
      dataset: { tone },
    },
    [
      node("div", { className: "section-label-row" }, [
        node("h3", { text: title, i18n: true }),
        meta ? node("span", { className: "explanation-label", text: meta, i18n: true }) : null,
      ]),
      node("p", { text }),
    ],
  );
}

function inspectorEntriesSection(title, entries, tone = null) {
  const section = node("section", {
    className: "inspector-section",
    dataset: { tone: entries.length ? tone : "missing" },
  });
  section.append(node("h3", { text: title, i18n: true }));
  if (!entries.length) {
    section.append(node("p", { text: "Not recorded for this evidence item.", i18n: true }));
    return section;
  }
  section.append(
    node(
      "ul",
      { className: "inspector-list" },
      entries.map((entry) =>
        node("li", {}, [
          document.createTextNode(entry.title),
          entry.summary ? node("span", { text: ` — ${entry.summary}` }) : null,
        ]),
      ),
    ),
  );
  return section;
}

function evidenceSection(item, narrative, portfolioProjectId = null) {
  const entries = [
    ...narrative.evidence,
    ...item.sourceRefs.map((source) => ({
      title: source.path,
      summary: source.pointer,
      sourceRefs: [source],
    })),
  ];
  const unique = [...new Map(entries.map((entry) => [entry.title, entry])).values()];
  const section = node("section", {
    className: "inspector-section",
    dataset: { tone: unique.length ? null : "missing" },
  });
  section.append(node("h3", { text: "Evidence", i18n: true }));
  if (!unique.length) {
    section.append(node("p", { text: "No source evidence was linked to this item.", i18n: true }));
    return section;
  }
  unique.forEach((entry) => {
    const source = entry.sourceRefs?.find((candidate) =>
      candidate.rawAvailable !== false && candidate.path?.startsWith(".sdlc/"));
    const href = source ? rawHrefForPath(source.path, portfolioProjectId) : null;
    section.append(
      node("div", { className: "source-row" }, [
        node("span", { className: "source-path", text: entry.title }),
        href
          ? node(
              "button",
              {
                className: "source-button",
                attrs: { type: "button" },
                dataset: { action: "open-raw", rawHref: href, rawPath: source.path },
              },
              [icon("source"), node("span", { text: "Open", i18n: true })],
            )
          : null,
      ]),
    );
  });
  return section;
}

function guidanceField(label, text, { i18nText = false } = {}) {
  return node("div", { className: "human-guidance-field" }, [
    node("dt", { text: label, i18n: true }),
    node("dd", { text, i18n: i18nText }),
  ]);
}

function humanGuidanceSection(guidance) {
  if (!guidance) return null;
  return node("section", {
    className: "human-guidance",
    attrs: { "aria-label": t("Plain-language explanation") },
  }, [
    node("dl", { className: "human-guidance-grid" }, [
      guidanceField("Outcome", guidance.outcome, { i18nText: true }),
      guidanceField("Impact", guidance.impact, { i18nText: true }),
      guidanceField("Decision", guidance.decision, { i18nText: true }),
      guidanceField("Protection", guidance.protection, { i18nText: true }),
      guidanceField("Next action", guidance.nextAction, { i18nText: true }),
    ]),
  ]);
}

function humanGuidanceBlock(item) {
  return humanGuidanceSection(humanGuidanceForItem(item));
}

function sharedGuidanceTracker() {
  return { used: false };
}

// Cards in a list defer status-neutral guidance to one shared explanation per
// view; item-specific warnings are always rendered on the card itself.
function cardGuidanceBlock(item, sharedGuidance) {
  if (sharedGuidance && usesSharedRecordGuidance(item)) {
    sharedGuidance.used = true;
    return null;
  }
  return humanGuidanceBlock(item);
}

function sharedGuidanceSection(sharedGuidance, className) {
  if (!sharedGuidance?.used) return null;
  return node("details", { className: `human-guidance-shared ${className}` }, [
    node("summary", { text: "How to read these records", i18n: true }),
    node("p", {
      className: "human-guidance-scope",
      text: "Applies to every record in this view that has no explanation of its own.",
      i18n: true,
    }),
    humanGuidanceSection(sharedRecordGuidance()),
  ]);
}

function technicalDetailsForItem(item, sections = [], portfolioProjectId = null) {
  const source = sourceButtonFor(item, "Open raw source", portfolioProjectId);
  return node("details", { className: "technical-details" }, [
    node("summary", { text: "Technical details (optional)", i18n: true }),
    node("dl", { className: "technical-details-grid" }, [
      guidanceField("Type", item.type),
      guidanceField("ID", localizePlaceholder(item.id)),
      guidanceField("Status", item.status),
      guidanceField("Recorded title", localizePlaceholder(item.title)),
      guidanceField("Recorded summary", localizePlaceholder(item.summary)),
      guidanceField("Evidence", sentenceCase(item.provenance), { i18nText: true }),
    ]),
    source,
    ...sections,
  ]);
}

export function renderInspector(container, item, { portfolioProjectId = null } = {}) {
  if (!item) {
    container.replaceChildren(
      node("header", { className: "inspector-header" }, [
        node("h2", { text: "Inspector", i18n: true }),
        node("span", { text: "No record selected", i18n: true }),
      ]),
      node("div", { className: "inspector-empty" }, [
        icon("source"),
        node("p", {
          text: "Select a lineage state or evidence record to inspect its recorded inputs, outputs, rationale, alternatives, and sources.",
          i18n: true,
        }),
      ]),
    );
    return;
  }

  if (item.type === "intentabi-codex-shadow") {
    container.replaceChildren(
      node("header", { className: "inspector-header" }, [
        node("h2", { text: "Intent evidence", i18n: true }),
        node("span", { text: "Read-only", i18n: true }),
      ]),
      humanGuidanceBlock(item),
      technicalDetailsForItem(item, [
        node("section", { className: "inspector-section intent-evidence-inspector" }, [
          intentEvidenceDetails(item),
          intentEvidenceLink(item),
          node("p", {
            className: "intent-evidence-note",
            text: "Content-free evidence only. MAC present · not verified by Change Observatory.",
            i18n: true,
          }),
        ]),
      ], portfolioProjectId),
    );
    return;
  }

  if (isAutonomyRecord(item)) {
    const display = displayTextForItem(item);
    container.replaceChildren(
      node("header", { className: "inspector-header" }, [
        node("h2", { text: display.title }),
        node("span", { className: "inspector-status" }, [
          statusText(display.status),
          node("span", { text: "Read-only", i18n: true }),
        ]),
      ]),
      humanGuidanceBlock(item),
      technicalDetailsForItem(item, [], portfolioProjectId),
    );
    return;
  }

  const display = displayTextForItem(item);
  const narrative = narrativeFor(item);
  const generatedTone = narrative.generatedExplanation ? "generated" : "missing";
  const generatedText =
    narrative.generatedExplanation || t("No plain-language explanation was recorded for this evidence item.");
  const rationale = narrative.rationale || t("No rationale was recorded for this evidence item.");

  const sections = [
    node("header", { className: "inspector-header" }, [
      node("h2", { text: display.title }),
      node("span", { className: "inspector-status" }, [
        statusText(display.status),
        node("span", { text: "Read-only", i18n: true }),
      ]),
    ]),
    humanGuidanceBlock(item),
    technicalDetailsForItem(item, [
      inspectorTextSection(
        "Request / record",
        `${localizePlaceholder(item.title)}\n${localizePlaceholder(item.summary)}`,
      ),
      inspectorTextSection("Decision rationale", rationale, narrative.rationale ? null : "missing"),
      inspectorEntriesSection("Inputs", narrative.inputs),
      inspectorEntriesSection("Outputs", narrative.outputs),
      inspectorTextSection(
        "Plain-language explanation",
        generatedText,
        generatedTone,
        narrative.generatedExplanation
          ? sentenceCase(narrative.explanationLabel || "generated")
          : "not recorded",
      ),
      narrative.chainOfThoughtIncluded
        ? inspectorTextSection(
          "Private reasoning",
          "Hidden by design. Change Observatory never renders private chain-of-thought.",
          "missing",
          "not displayed",
        )
        : null,
      inspectorEntriesSection("Alternatives rejected", narrative.alternatives, "alternatives"),
      evidenceSection(item, narrative, portfolioProjectId),
    ], portfolioProjectId),
  ].filter(Boolean);
  container.replaceChildren(...sections);
}

export function renderFatalError(container, error, {
  title = "Project lineage could not be loaded",
} = {}) {
  const guidance = localizedErrorGuidance(error);
  container.replaceChildren(
    node("div", { className: "error-state", attrs: { role: "alert" } }, [
      icon("alert"),
      node("div", {}, [
        node("strong", { text: title, i18n: true }),
        node("dl", { className: "human-guidance-grid" }, [
          guidanceField("Outcome", guidance.outcome, { i18nText: true }),
          guidanceField("Impact", guidance.impact, { i18nText: true }),
          guidanceField("Decision", guidance.decision, { i18nText: true }),
          guidanceField("Protection", guidance.protection, { i18nText: true }),
          guidanceField("Next action", guidance.nextAction, { i18nText: true }),
        ]),
        node("details", { className: "technical-details" }, [
          node("summary", { text: "Technical details (optional)", i18n: true }),
          node("p", { text: guidance.technical }),
        ]),
      ]),
    ]),
  );
}
