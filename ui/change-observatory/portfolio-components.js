import { sentenceCase } from "./model.js";
import { t } from "./i18n.js";

function node(tag, options = {}, children = []) {
  const element = document.createElement(tag);
  if (options.className) element.className = options.className;
  if (options.text !== undefined) element.textContent = String(options.text ?? "");
  for (const [name, value] of Object.entries(options.attrs ?? {})) {
    if (value !== null && value !== undefined) element.setAttribute(name, String(value));
  }
  for (const [name, value] of Object.entries(options.dataset ?? {})) {
    if (value !== null && value !== undefined) element.dataset[name] = String(value);
  }
  element.append(...children.filter(Boolean));
  return element;
}

export function applyWorkspaceContext({
  portfolioOverview = false,
  projectName = null,
  label = "Project evidence",
} = {}) {
  const heading = document.querySelector("#workspace-heading");
  const skipLink = document.querySelector("#skip-link");
  const workspace = document.querySelector("#workspace");
  const primary = document.querySelector("#primary-view");
  if (!heading || !skipLink || !workspace || !primary) {
    throw new TypeError("The Change Observatory workspace landmarks are incomplete.");
  }
  const headingText = portfolioOverview
    ? t("Portfolio overview")
    : (projectName ? `${projectName} · ${t(label)}` : t(label));
  const skipText = portfolioOverview
    ? t("Skip to portfolio overview")
    : `${t("Skip to project evidence")}${projectName ? `: ${projectName}` : ""}`;
  heading.textContent = headingText;
  skipLink.textContent = skipText;
  workspace.setAttribute("aria-labelledby", "workspace-heading");
  primary.setAttribute("aria-labelledby", "workspace-heading");
  return Object.freeze({ heading: headingText, skipLabel: skipText });
}

export function renderPortfolioControls(summary, selectedProjectId = "", model = null) {
  const projectSelect = document.querySelector("#project-select");
  const snapshotSelect = document.querySelector("#snapshot-select");
  const allProjects = node("option", {
    text: t("All projects"),
    attrs: { value: "" },
  });
  if (selectedProjectId === "") allProjects.selected = true;
  const options = summary.projects.map((project) => {
    const suffix = project.status === "unavailable" ? ` · ${t("Unavailable")}` : "";
    const option = node("option", {
      text: `${project.name}${suffix}`,
      attrs: { value: project.id },
    });
    if (project.id === selectedProjectId) option.selected = true;
    return option;
  });
  projectSelect.replaceChildren(allProjects, ...options);
  projectSelect.disabled = false;
  projectSelect.setAttribute("aria-label", t("Choose a portfolio project"));

  snapshotSelect.replaceChildren(node("option", {
    text: model?.project?.branch || model?.project?.snapshot || t("Current evidence"),
    attrs: { value: "current" },
  }));
  snapshotSelect.disabled = true;
}

export function renderPortfolioSummary(container, summary) {
  container.hidden = false;
  container.replaceChildren(
    summaryCard("Projects", summary.projectCount),
    summaryCard("Available projects", summary.availableProjectCount, "ready"),
    summaryCard("Unavailable projects", summary.unavailableProjectCount, (
      summary.unavailableProjectCount > 0 ? "warning" : "ready"
    )),
  );
}

export function renderPortfolioOverview(container, summary) {
  const cards = summary.projects.map(projectCard);
  const section = node("div", { className: "portfolio-view" }, [
    node("header", { className: "portfolio-heading" }, [
      node("div", {}, [
        node("p", { text: t("Choose a project to load its detailed evidence. Project details are read only when you open them.") }),
      ]),
      node("span", {
        className: "portfolio-readonly",
        text: t("Local · read-only"),
      }),
    ]),
    node("div", {
      className: "portfolio-grid",
      attrs: { "aria-label": t("Portfolio projects") },
    }, cards),
  ]);
  container.replaceChildren(section);
}

export function renderPortfolioUnavailable(container, project) {
  container.replaceChildren(node("section", {
    className: "portfolio-unavailable",
    attrs: { role: "status", "aria-label": project.name },
  }, [
    node("span", { className: "portfolio-status-mark", text: "!", attrs: { "aria-hidden": "true" } }),
    node("div", {}, [
      node("strong", { text: t("This project’s evidence is unavailable.") }),
      project.message ? node("p", { text: t(project.message) }) : null,
      node("p", { text: t("Other projects remain available. Choose All projects to continue browsing the portfolio.") }),
    ]),
  ]));
}

export function renderPortfolioProjectLoading(container, project) {
  container.replaceChildren(node("div", {
    className: "loading-state",
    attrs: { role: "status" },
  }, [
    node("span", { className: "loading-pulse", attrs: { "aria-hidden": "true" } }),
    node("div", {}, [
      node("strong", { text: t("Loading project evidence") }),
      node("p", { text: `${project.name} · ${t("The rest of the portfolio remains unchanged.")}` }),
    ]),
  ]));
}

function summaryCard(label, value, tone = "neutral") {
  return node("article", { className: "summary-answer", dataset: { tone } }, [
    node("h2", { text: t(label) }),
    node("strong", { className: "portfolio-summary-value", text: value }),
  ]);
}

function projectCard(project) {
  const available = project.status === "available";
  const previewItems = project.previews.slice(0, 3).map((preview) => node("li", {}, [
    node("span", { className: "portfolio-preview-kind", text: t(sentenceCase(preview.kind)) }),
    node("strong", { text: preview.title }),
    node("p", { text: preview.summary }),
  ]));
  const actionLabel = available ? "Open project details" : "Review unavailable project";
  return node("article", {
    className: "portfolio-card",
    dataset: { status: project.status, health: project.health },
  }, [
    node("header", {}, [
      node("div", {}, [
        node("h2", { text: project.name }),
      ]),
      node("span", {
        className: "portfolio-health",
        text: t(available ? sentenceCase(project.health) : "Unavailable"),
      }),
    ]),
    available
      ? node("dl", { className: "portfolio-counts" }, [
          count("Asked", project.counts.asked),
          count("Changed", project.counts.changed),
          count("Decided", project.counts.decided),
          count("Checks", project.counts.verification),
        ])
      : node("p", {
          className: "portfolio-card-message",
          text: t(project.message ?? "This project could not be read safely. Other projects are still available."),
        }),
    previewItems.length
      ? node("ul", { className: "portfolio-previews" }, previewItems)
      : null,
    node("button", {
      className: "outline-button portfolio-open",
      text: t(actionLabel),
      attrs: {
        type: "button",
        "aria-label": `${t(actionLabel)}: ${project.name}`,
      },
      dataset: { action: "select-project", projectId: project.id },
    }),
  ]);
}

function count(label, value) {
  return node("div", {}, [
    node("dt", { text: t(label) }),
    node("dd", { text: value }),
  ]);
}
