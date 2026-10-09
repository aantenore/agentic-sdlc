// Visual views of the Change Observatory: a dashboard, a story board, an
// activity timeline, and a lineage map. They only read the normalized view
// model through insights.js and reuse the existing selection, inspector, and
// raw-source actions, so every record stays one click away from its evidence.
import { PHASES, recordSelectionKey } from "./model.js";
import {
  displayKindForItem,
  displayTextForItem,
  isAutonomyRecord,
  localizePlaceholder,
  t,
} from "./i18n.js";
import { icon, node, svgNode } from "./dom.js";
import {
  EVENT_KINDS,
  INSIGHT_SETTINGS,
  STORY_STATES,
  actionLabel,
  activityBuckets,
  checkHealth,
  checkOutcome,
  filterEvents,
  formatDay,
  lineageGraph,
  matchesQuery,
  phaseTotals,
  projectEvents,
  relativeTime,
  sortStories,
  storyInsights,
  storyStateCounts,
} from "./insights.js";

const KIND_BY_KEY = new Map(EVENT_KINDS.map((kind) => [kind.key, kind]));
const STATE_BY_KEY = new Map(STORY_STATES.map((state) => [state.key, state]));
const PHASE_STATUS_LABELS = Object.freeze({
  complete: "Complete",
  inProgress: "In Progress",
  blocked: "Blocked",
  missing: "Not recorded",
});

export function defaultExploreState() {
  return {
    query: "",
    kinds: null,
    range: null,
    storyId: "",
    storyState: "all",
    sort: "recent",
    expanded: new Set(),
    mapStoryId: null,
    mapZoom: 1,
    pages: 1,
  };
}

// Projections are cached per model object so re-rendering on every keystroke
// or selection does not rebuild them.
const insightCache = new WeakMap();

export function insightsFor(model) {
  let cached = insightCache.get(model);
  if (!cached) {
    const events = projectEvents(model);
    const stories = storyInsights(model, events);
    cached = {
      events,
      stories,
      storiesById: new Map(stories.map((story) => [story.id, story])),
      health: checkHealth(events),
      phases: phaseTotals(stories),
      stateCounts: storyStateCounts(stories),
    };
    insightCache.set(model, cached);
  }
  return cached;
}

function explore(state) {
  if (!state.explore) state.explore = defaultExploreState();
  return state.explore;
}

function countText(count, singular, plural) {
  return `${count} ${t(count === 1 ? singular : plural)}`;
}

function storyTitle(story) {
  return displayTextForItem(story.iteration).title;
}

function panel(title, description, body, { className = "", actions = [] } = {}) {
  return node("section", { className: `section-panel viz-panel ${className}`.trim() }, [
    node("header", { className: "section-heading" }, [
      node("div", {}, [
        node("h2", { text: title, i18n: true }),
        description ? node("p", { text: description, i18n: true }) : null,
      ]),
      actions.length ? node("div", { className: "section-heading-actions" }, actions) : null,
    ]),
    node("div", { className: "viz-panel-body" }, [body]),
  ]);
}

function linkButton(label, dataset, extraClass = "") {
  return node("button", {
    className: `text-button ${extraClass}`.trim(),
    text: label,
    i18n: true,
    attrs: { type: "button" },
    dataset,
  });
}

function stateDot(stateKey) {
  return node("span", {
    className: `state-dot${stateKey === "live" ? " is-live" : ""}`,
    attrs: { "aria-hidden": "true" },
    dataset: { state: stateKey },
  });
}

function stateBadge(stateKey) {
  return node("span", { className: "state-badge", dataset: { state: stateKey } }, [
    stateDot(stateKey),
    node("span", { text: STATE_BY_KEY.get(stateKey)?.label ?? stateKey, i18n: true }),
  ]);
}

function phaseTrack(story, { labels = false } = {}) {
  const list = node("ol", {
    className: `phase-track${labels ? " has-labels" : ""}`,
    attrs: {
      "aria-label": `${t("Progress")}: ${story.completed}/${PHASES.length}`,
    },
  });
  for (const phase of story.phases) {
    const status = PHASE_STATUS_LABELS[phase.status] ? phase.status : "missing";
    const label = `${t(phase.phase.charAt(0).toUpperCase() + phase.phase.slice(1))}: ${t(PHASE_STATUS_LABELS[status])}`;
    list.append(node("li", {
      className: `phase-seg${status === "inProgress" ? " is-live" : ""}`,
      attrs: { title: label },
      dataset: { status },
    }, [
      labels ? node("span", { className: "phase-seg-label", text: phase.phase.charAt(0).toUpperCase() + phase.phase.slice(1), i18n: true }) : null,
      node("span", { className: "sr-only", text: label }),
    ]));
  }
  return list;
}

function kindChip(kindKey) {
  const kind = KIND_BY_KEY.get(kindKey);
  return node("span", { className: "kind-chip", dataset: { kind: kindKey } }, [
    node("span", { className: "kind-swatch", attrs: { "aria-hidden": "true" } }),
    node("span", { text: kind?.singular ?? kindKey, i18n: true }),
  ]);
}

function outcomeBadge(item) {
  const outcome = checkOutcome(item);
  if (outcome === "recorded") return null;
  const label = { passed: "Passed", failed: "Failed", pending: "Pending" }[outcome];
  return node("span", { className: "outcome-badge", text: label, i18n: true, dataset: { outcome } });
}

// Only text the record itself carries (or the autonomy projection) is shown
// as a summary; generic fallback sentences would repeat on every row.
function recordedText(item) {
  const display = displayTextForItem(item);
  if (isAutonomyRecord(item)) return { title: display.title, summary: display.summary };
  const title = String(item?.title ?? "").trim();
  const summary = String(item?.summary ?? "").trim();
  return {
    title: title && display.title === localizePlaceholder(title) ? display.title : "",
    summary: summary && display.summary === localizePlaceholder(summary) ? display.summary : "",
  };
}

function kindName(kindKey, item) {
  if (isAutonomyRecord(item)) return displayKindForItem(item);
  return t(KIND_BY_KEY.get(kindKey)?.singular ?? "Project record");
}

function eventHeadline(event) {
  const label = actionLabel(event.item);
  if (label) return t(label);
  return recordedText(event.item).title || kindName(event.kind, event.item);
}

function eventRow(event, state, { showStory = true, storiesById = null, showDate = false } = {}) {
  const recorded = recordedText(event.item);
  const key = event.key;
  const selected = state.selectedId === key;
  const story = showStory && event.storyId ? storiesById?.get(event.storyId) : null;
  const headline = eventHeadline(event);
  const summary = [recorded.summary, recorded.title]
    .find((text) => text && text !== headline) ?? "";
  return node("li", { className: "event-row", dataset: { kind: event.kind } }, [
    node("span", { className: "event-marker", attrs: { "aria-hidden": "true" } }),
    node("button", {
      className: `event-card${selected ? " is-selected" : ""}`,
      attrs: {
        type: "button",
        "aria-pressed": String(selected),
        "aria-label": summary ? `${headline}: ${summary}` : headline,
      },
      dataset: { action: "select-record", selectId: key },
    }, [
      node("span", { className: "event-meta" }, [
        node("time", {
          className: "event-time",
          text: event.time === null
            ? t("Time not recorded")
            : formatDay(event.time, showDate
              ? { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }
              : { hour: "2-digit", minute: "2-digit" }),
          attrs: event.time === null ? {} : { datetime: new Date(event.time).toISOString() },
        }),
        kindChip(event.kind),
        event.kind === "check" ? outcomeBadge(event.item) : null,
      ]),
      node("strong", { className: "event-title", text: headline }),
      summary ? node("span", { className: "event-summary", text: summary }) : null,
      story ? node("span", { className: "event-story" }, [
        stateDot(story.state),
        node("span", { text: storyTitle(story) }),
      ]) : null,
    ]),
  ]);
}

function emptyMessage(message, detail = null) {
  return node("div", { className: "viz-empty" }, [
    node("strong", { text: message, i18n: true }),
    detail ? node("p", { text: detail, i18n: true }) : null,
  ]);
}

// ---------------------------------------------------------------- charts

function niceMax(value) {
  if (value <= 4) return Math.max(1, value);
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const steps = [1, 2, 2.5, 5, 10];
  return steps.map((step) => step * magnitude).find((candidate) => candidate >= value);
}

function bucketLabel(bucket, unit) {
  return unit === "day"
    ? formatDay(bucket.start, { day: "numeric", month: "short" })
    : `${t("Week of")} ${formatDay(bucket.start, { day: "numeric", month: "short" })}`;
}

export function activityChart(events, { range = null, compact = false } = {}) {
  const { unit, buckets } = activityBuckets(events);
  if (!buckets.length) return emptyMessage("No dated activity was recorded yet.");
  const width = 720;
  const height = compact ? 170 : 200;
  const pad = { top: 12, right: 8, bottom: 26, left: 32 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const max = niceMax(Math.max(...buckets.map((bucket) => bucket.total), 1));
  const slot = plotWidth / buckets.length;
  const barWidth = Math.max(4, Math.min(34, slot * 0.68));
  const total = buckets.reduce((sum, bucket) => sum + bucket.total, 0);
  const svg = svgNode("svg", {
    className: "activity-chart",
    viewBox: `0 0 ${width} ${height}`,
    role: "group",
    "aria-label": `${t("Activity over time")}: ${countText(total, "event", "events")}`,
    preserveAspectRatio: "none",
  });
  for (const fraction of [0, 0.5, 1]) {
    const y = pad.top + plotHeight * (1 - fraction);
    svg.append(
      svgNode("line", { className: "chart-grid", x1: pad.left, x2: width - pad.right, y1: y, y2: y }),
      svgNode("text", { className: "chart-axis", x: pad.left - 6, y: y + 4, "text-anchor": "end", text: Math.round(max * fraction) }),
    );
  }
  const labelEvery = Math.ceil(buckets.length / (compact ? 4 : 6));
  buckets.forEach((bucket, index) => {
    const x = pad.left + slot * index + (slot - barWidth) / 2;
    const active = range && range.start === bucket.start;
    const dimmed = range && !active;
    const label = `${bucketLabel(bucket, unit)}: ${countText(bucket.total, "event", "events")}`;
    const group = svgNode("g", {
      className: `chart-bar${active ? " is-active" : ""}${dimmed ? " is-dimmed" : ""}`,
      role: "button",
      tabindex: bucket.total ? "0" : "-1",
      "aria-label": label,
      "aria-pressed": active ? "true" : "false",
      dataset: {
        action: "select-range",
        rangeStart: bucket.start,
        rangeEnd: bucket.end,
      },
    }, [svgNode("title", { text: label })]);
    group.append(svgNode("rect", {
      className: "chart-hit",
      x: pad.left + slot * index,
      y: pad.top,
      width: slot,
      height: plotHeight,
    }));
    let offset = 0;
    for (const kind of EVENT_KINDS) {
      const count = bucket.counts[kind.key];
      if (!count) continue;
      const barHeight = (count / max) * plotHeight;
      offset += barHeight;
      group.append(svgNode("rect", {
        className: "chart-segment",
        x,
        y: pad.top + plotHeight - offset,
        width: barWidth,
        height: Math.max(1, barHeight),
        rx: 2,
        dataset: { kind: kind.key },
      }));
    }
    svg.append(group);
    if (index % labelEvery === 0 || index === buckets.length - 1) {
      svg.append(svgNode("text", {
        className: "chart-axis",
        x: pad.left + slot * index + slot / 2,
        y: height - 8,
        "text-anchor": "middle",
        text: formatDay(bucket.start, { day: "numeric", month: "short" }),
      }));
    }
  });
  return node("figure", { className: "chart-figure" }, [svg, kindLegend()]);
}

function kindLegend(counts = null) {
  return node("figcaption", { className: "chart-legend" }, EVENT_KINDS.map((kind) =>
    node("span", { className: "legend-item", dataset: { kind: kind.key } }, [
      node("span", { className: "kind-swatch", attrs: { "aria-hidden": "true" } }),
      node("span", { text: kind.label, i18n: true }),
      counts ? node("strong", { text: counts[kind.key] ?? 0 }) : null,
    ])));
}

function healthDonut(health) {
  const size = 132;
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  const segments = [
    ["passed", "Passed"],
    ["failed", "Failed"],
    ["pending", "Pending"],
    ["recorded", "No result recorded"],
  ];
  const svg = svgNode("svg", {
    className: "health-donut",
    viewBox: `0 0 ${size} ${size}`,
    role: "img",
    "aria-label": segments.map(([key, label]) => `${t(label)}: ${health[key]}`).join(", "),
  });
  svg.append(svgNode("circle", { className: "donut-track", cx: size / 2, cy: size / 2, r: radius }));
  let offset = 0;
  if (health.total) {
    for (const [key] of segments) {
      const share = health[key] / health.total;
      if (!share) continue;
      const length = share * circumference;
      svg.append(svgNode("circle", {
        className: "donut-segment",
        cx: size / 2,
        cy: size / 2,
        r: radius,
        "stroke-dasharray": `${length} ${circumference - length}`,
        "stroke-dashoffset": -offset,
        transform: `rotate(-90 ${size / 2} ${size / 2})`,
        dataset: { outcome: key },
      }));
      offset += length;
    }
  }
  const rate = health.passed + health.failed
    ? Math.round((health.passed / (health.passed + health.failed)) * 100)
    : null;
  svg.append(
    svgNode("text", { className: "donut-value", x: size / 2, y: size / 2 + 2, "text-anchor": "middle", text: rate === null ? "–" : `${rate}%` }),
    svgNode("text", { className: "donut-caption", x: size / 2, y: size / 2 + 20, "text-anchor": "middle", text: t("passed") }),
  );
  const legend = node("ul", { className: "donut-legend" }, segments.map(([key, label]) =>
    node("li", { dataset: { outcome: key } }, [
      node("span", { className: "outcome-swatch", attrs: { "aria-hidden": "true" } }),
      node("span", { text: label, i18n: true }),
      node("strong", { text: health[key] }),
    ])));
  return node("div", { className: "health-figure" }, [svg, legend]);
}

function phaseFunnel(totals, storyCount) {
  const rows = node("ul", { className: "phase-funnel" });
  for (const entry of totals) {
    const name = entry.phase.charAt(0).toUpperCase() + entry.phase.slice(1);
    const bar = svgNode("svg", {
      className: "funnel-bar",
      viewBox: "0 0 100 10",
      preserveAspectRatio: "none",
      "aria-hidden": "true",
    });
    let x = 0;
    for (const status of ["complete", "inProgress", "blocked"]) {
      const share = storyCount ? (entry[status] / storyCount) * 100 : 0;
      if (!share) continue;
      bar.append(svgNode("rect", {
        className: `funnel-segment${status === "inProgress" ? " is-live" : ""}`,
        x,
        y: 0,
        width: share,
        height: 10,
        dataset: { status },
      }));
      x += share;
    }
    rows.append(node("li", {
      attrs: {
        "aria-label": `${t(name)}: ${entry.complete} ${t("complete")}, ${entry.inProgress} ${t("in progress")}, ${entry.blocked} ${t("blocked")}`,
      },
    }, [
      node("span", { className: "funnel-name", text: name, i18n: true }),
      node("span", { className: "funnel-track" }, [bar]),
      node("span", { className: "funnel-count" }, [
        node("strong", { text: entry.complete }),
        node("span", { text: `/ ${storyCount}` }),
        entry.inProgress
          ? node("span", { className: "funnel-live" }, [stateDot("live"), node("span", { text: entry.inProgress })])
          : null,
      ]),
    ]));
  }
  return node("div", {}, [
    rows,
    node("p", { className: "funnel-legend" }, [
      node("span", { dataset: { status: "complete" } }, [node("span", { className: "status-swatch" }), node("span", { text: "Complete", i18n: true })]),
      node("span", { dataset: { status: "inProgress" } }, [node("span", { className: "status-swatch" }), node("span", { text: "In Progress", i18n: true })]),
      node("span", { dataset: { status: "blocked" } }, [node("span", { className: "status-swatch" }), node("span", { text: "Blocked", i18n: true })]),
    ]),
  ]);
}

// ---------------------------------------------------------------- dashboard

function kpiTile({ label, value, hint, tone = "neutral", live = false, dataset = null }) {
  const content = [
    node("span", { className: "kpi-label" }, [
      live ? stateDot("live") : null,
      node("span", { text: label, i18n: true }),
    ]),
    node("strong", { className: "kpi-value", text: value }),
    hint ? node("span", { className: "kpi-hint", text: hint }) : null,
  ];
  return dataset
    ? node("button", { className: "kpi-tile", attrs: { type: "button" }, dataset: { tone, ...dataset } }, content)
    : node("div", { className: "kpi-tile", dataset: { tone } }, content);
}

function storyCard(story, state) {
  return node("li", { className: "now-card", dataset: { state: story.state } }, [
    node("button", {
      className: "now-card-button",
      attrs: { type: "button", "aria-label": `${storyTitle(story)}: ${t(STATE_BY_KEY.get(story.state).label)}` },
      dataset: { action: "open-story", storyId: story.id },
    }, [
      node("span", { className: "now-card-head" }, [
        stateBadge(story.state),
        node("span", { className: "now-card-time", text: relativeTime(story.lastActivity) }),
      ]),
      node("strong", { className: "now-card-title", text: storyTitle(story) }),
      phaseTrack(story),
      node("span", { className: "now-card-foot" }, [
        node("span", {
          text: story.livePhase
            ? `${t("Now")}: ${t(story.livePhase.charAt(0).toUpperCase() + story.livePhase.slice(1))}`
            : `${t("Progress")}: ${story.completed}/${PHASES.length}`,
        }),
        node("span", { text: countText(story.events.length, "event", "events") }),
      ]),
    ]),
  ]);
}

export function dashboardView(model, state) {
  const insight = insightsFor(model);
  const { stories, stateCounts, health, events } = insight;
  const lastEvent = events.find((event) => event.time !== null);
  const liveCount = stateCounts.live + stateCounts.blocked;
  const decisions = events.filter((event) => event.kind === "decision").length;
  const changes = events.filter((event) => event.kind === "change").length;

  const headline = node("section", { className: "dash-hero" }, [
    node("div", { className: "dash-hero-copy" }, [
      node("p", { className: "dash-hero-status" }, [
        stateDot(stateCounts.live ? "live" : (stateCounts.blocked ? "blocked" : "idle")),
        node("strong", {
          text: stateCounts.live
            ? countText(stateCounts.live, "story in progress", "stories in progress")
            : t("No story is in progress right now"),
        }),
      ]),
      node("p", {
        className: "dash-hero-detail",
        text: [
          countText(stateCounts.delivered, "delivered", "delivered"),
          stateCounts.blocked ? countText(stateCounts.blocked, "blocked", "blocked") : null,
          lastEvent ? `${t("Last activity")} ${relativeTime(lastEvent.time)}` : null,
        ].filter(Boolean).join(" · "),
      }),
    ]),
    node("div", { className: "dash-hero-actions" }, [
      linkButton("See all stories", { action: "go-view", targetView: "stories" }, "is-primary"),
      linkButton("Open timeline", { action: "go-view", targetView: "activity" }),
    ]),
  ]);

  const passRate = health.passed + health.failed
    ? `${Math.round((health.passed / (health.passed + health.failed)) * 100)}%`
    : "–";
  const kpis = node("div", { className: "kpi-row" }, [
    kpiTile({ label: "Stories", value: stories.length, hint: countText(stateCounts.open, "started", "started"), dataset: { action: "go-view", targetView: "stories", storyState: "all" } }),
    kpiTile({ label: "In progress", value: stateCounts.live, tone: "live", live: stateCounts.live > 0, hint: stateCounts.blocked ? countText(stateCounts.blocked, "blocked", "blocked") : t("Nothing blocked"), dataset: { action: "go-view", targetView: "stories", storyState: "live" } }),
    kpiTile({ label: "Delivered stories", value: stateCounts.delivered, tone: "success", hint: `${stories.length ? Math.round((stateCounts.delivered / stories.length) * 100) : 0}% ${t("of stories")}`, dataset: { action: "go-view", targetView: "stories", storyState: "delivered" } }),
    kpiTile({ label: "Checks passed", value: passRate, tone: health.failed ? "warning" : "success", hint: `${health.passed} ${t("passed")} · ${health.failed} ${t("failed")}`, dataset: { action: "go-view", targetView: "activity", kinds: "check" } }),
    kpiTile({ label: "Decisions", value: decisions, hint: countText(changes, "change", "changes"), dataset: { action: "go-view", targetView: "activity", kinds: "decision" } }),
  ]);

  const nowStories = sortStories(
    stories.filter((story) => ["live", "blocked", "open"].includes(story.state)),
    "state",
  ).slice(0, INSIGHT_SETTINGS.dashboardActiveStoryLimit);
  const now = panel(
    "Happening now",
    liveCount ? "Stories with work under way; a pulsing dot means a step is in progress" : "Most recent stories",
    nowStories.length
      ? node("ul", { className: "now-grid" }, nowStories.map((story) => storyCard(story, state)))
      : node("ul", { className: "now-grid" }, sortStories(stories, "recent").slice(0, 3).map((story) => storyCard(story, state))),
    { className: "dash-now", actions: [linkButton("All stories", { action: "go-view", targetView: "stories" })] },
  );

  const recent = events.slice(0, INSIGHT_SETTINGS.recentEventCount);
  const recentPanel = panel(
    "Latest activity",
    "What was recorded most recently",
    recent.length
      ? node("ol", { className: "event-list is-compact" }, recent.map((event) =>
        eventRow(event, state, { storiesById: insight.storiesById, showDate: true })))
      : emptyMessage("Nothing has been recorded yet"),
    { actions: [linkButton("Full timeline", { action: "go-view", targetView: "activity" })] },
  );

  return node("div", { className: "view-stack dashboard" }, [
    headline,
    kpis,
    node("div", { className: "dash-grid" }, [
      panel("Activity over time", "Click a bar to see what happened in that period", activityChart(events, { compact: true }), { className: "dash-activity" }),
      panel("Check results", "Outcome of recorded tests and gates", healthDonut(health), { className: "dash-health" }),
    ]),
    now,
    node("div", { className: "dash-grid is-even" }, [
      panel("Where the stories are", "How many stories completed each step", phaseFunnel(insight.phases, stories.length)),
      recentPanel,
    ]),
  ]);
}

// ---------------------------------------------------------------- stories

function searchBox(value, placeholder) {
  return node("label", { className: "search-box" }, [
    node("span", { className: "sr-only", text: placeholder, i18n: true }),
    node("input", {
      attrs: {
        type: "search",
        value,
        placeholder: t(placeholder),
        autocomplete: "off",
        spellcheck: "false",
      },
      dataset: { explore: "query" },
    }),
  ]);
}

function chip(label, { active, count = null, dataset, live = false }) {
  return node("button", {
    className: `filter-chip${active ? " is-active" : ""}`,
    attrs: { type: "button", "aria-pressed": String(Boolean(active)) },
    dataset,
  }, [
    live ? stateDot("live") : null,
    node("span", { text: label, i18n: true }),
    count === null ? null : node("span", { className: "chip-count", text: count }),
  ]);
}

function sortSelect(value) {
  const select = node("select", {
    className: "compact-select",
    attrs: { "aria-label": t("Sort stories") },
    dataset: { explore: "sort" },
  });
  for (const [key, label] of [
    ["recent", "Latest activity"],
    ["state", "Status"],
    ["progress", "Progress"],
    ["title", "Title"],
  ]) {
    const option = node("option", { text: label, i18n: true, attrs: { value: key } });
    if (key === value) option.selected = true;
    select.append(option);
  }
  return select;
}

function storyRow(story, state, insight) {
  const exploreState = explore(state);
  const expanded = exploreState.expanded.has(story.id);
  const bodyId = `story-body-${story.id.replace(/[^A-Za-z0-9_-]/gu, "-")}`;
  const counts = node("span", { className: "story-counts" }, ["decision", "change", "check"].map((kind) =>
    node("span", { className: "story-count", dataset: { kind }, attrs: { title: t(KIND_BY_KEY.get(kind).label) } }, [
      node("span", { className: "kind-swatch", attrs: { "aria-hidden": "true" } }),
      node("span", { text: story.counts[kind] }),
      node("span", { className: "sr-only", text: KIND_BY_KEY.get(kind).label, i18n: true }),
    ])));
  const header = node("button", {
    className: "story-row-head",
    attrs: { type: "button", "aria-expanded": String(expanded), "aria-controls": bodyId },
    dataset: { action: "toggle-story", storyId: story.id },
  }, [
    icon("chevron", "story-chevron"),
    node("span", { className: "story-main" }, [
      node("strong", { className: "story-title", text: storyTitle(story) }),
      node("span", { className: "story-sub" }, [
        stateBadge(story.state),
        node("span", { text: relativeTime(story.lastActivity) }),
      ]),
    ]),
    phaseTrack(story),
    counts,
  ]);
  const article = node("li", {
    className: `story-row${expanded ? " is-expanded" : ""}`,
    dataset: { state: story.state, storyId: story.id },
  }, [header]);
  if (!expanded) return article;

  const summary = recordedText(story.iteration).summary;
  const preview = story.events.slice(0, INSIGHT_SETTINGS.storyEventPreviewCount);
  article.append(node("div", { className: "story-body", attrs: { id: bodyId } }, [
    summary ? node("p", { className: "story-summary", text: summary }) : null,
    phaseTrack(story, { labels: true }),
    node("div", { className: "story-actions" }, [
      linkButton("Show on the map", { action: "open-map", storyId: story.id }, "is-primary"),
      linkButton("Show in the timeline", { action: "go-view", targetView: "activity", storyId: story.id }),
      linkButton("Open the step-by-step dossier", { action: "open-dossier", iterationId: story.id }),
      linkButton("Details", { action: "select-record", selectId: recordSelectionKey(story.iteration) }),
    ]),
    preview.length
      ? node("ol", { className: "event-list is-compact" }, preview.map((event) =>
        eventRow(event, state, { showStory: false, showDate: true })))
      : emptyMessage("No activity is linked to this story yet."),
    story.events.length > preview.length
      ? linkButton(`${t("Show all")} (${story.events.length})`, { action: "go-view", targetView: "activity", storyId: story.id })
      : null,
  ]));
  return article;
}

export function storiesView(model, state) {
  const insight = insightsFor(model);
  const exploreState = explore(state);
  const visible = sortStories(insight.stories.filter((story) =>
    (exploreState.storyState === "all" || story.state === exploreState.storyState)
    && (!exploreState.query || matchesQuery(story.iteration, exploreState.query)
      || story.events.some((event) => matchesQuery(event.item, exploreState.query)))), exploreState.sort);
  const chips = node("div", { className: "chip-row", attrs: { role: "group", "aria-label": t("Filter by status") } }, [
    chip("All", { active: exploreState.storyState === "all", count: insight.stories.length, dataset: { action: "set-story-state", storyState: "all" } }),
    ...STORY_STATES.filter((entry) => insight.stateCounts[entry.key]).map((entry) => chip(entry.label, {
      active: exploreState.storyState === entry.key,
      count: insight.stateCounts[entry.key],
      live: entry.key === "live",
      dataset: { action: "set-story-state", storyState: entry.key },
    })),
  ]);
  return node("div", { className: "view-stack" }, [
    node("div", { className: "explore-toolbar" }, [
      searchBox(exploreState.query, "Search stories and their activity"),
      sortSelect(exploreState.sort),
    ]),
    chips,
    panel(
      "Stories",
      "Each row is one piece of work; open it to see its steps and activity",
      visible.length
        ? node("ul", { className: "story-list" }, visible.map((story) => storyRow(story, state, insight)))
        : emptyMessage("No story matches these filters.", "Clear the search or pick another status."),
      { actions: [node("span", { className: "panel-count", text: `${visible.length} / ${insight.stories.length}` })] },
    ),
  ]);
}

// ---------------------------------------------------------------- timeline

function storyFilterSelect(stories, value, filterName, label) {
  const select = node("select", {
    className: "compact-select story-select",
    attrs: { "aria-label": t(label) },
    dataset: { explore: filterName },
  });
  if (filterName === "storyId") select.append(node("option", { text: "All stories", i18n: true, attrs: { value: "" } }));
  for (const story of sortStories(stories, "recent")) {
    const option = node("option", { text: storyTitle(story), attrs: { value: story.id } });
    if (story.id === value) option.selected = true;
    select.append(option);
  }
  return select;
}

function dayKey(time) {
  return time === null ? "none" : formatDay(time, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

export function activityView(model, state) {
  const insight = insightsFor(model);
  const exploreState = explore(state);
  const scoped = filterEvents(insight.events, {
    query: exploreState.query,
    kinds: exploreState.kinds,
    storyId: exploreState.storyId,
  });
  const visible = exploreState.range
    ? scoped.filter((event) => event.time !== null
      && event.time >= exploreState.range.start && event.time < exploreState.range.end)
    : scoped;
  const kindCounts = Object.fromEntries(EVENT_KINDS.map((kind) => [kind.key, 0]));
  for (const event of filterEvents(insight.events, { query: exploreState.query, storyId: exploreState.storyId })) {
    kindCounts[event.kind] += 1;
  }
  const limit = INSIGHT_SETTINGS.timelinePageSize * exploreState.pages;
  const shown = visible.slice(0, limit);
  const groups = new Map();
  for (const event of shown) {
    const key = dayKey(event.time);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }
  const anyFilter = exploreState.query || exploreState.kinds || exploreState.range || exploreState.storyId;
  const stream = node("div", { className: "day-stream" });
  for (const [day, dayEvents] of groups) {
    stream.append(node("section", { className: "day-group" }, [
      node("h3", { className: "day-heading" }, [
        node("span", { text: day === "none" ? t("Time not recorded") : day }),
        node("span", { className: "day-count", text: countText(dayEvents.length, "event", "events") }),
      ]),
      node("ol", { className: "event-list" }, dayEvents.map((event) =>
        eventRow(event, state, { storiesById: insight.storiesById }))),
    ]));
  }
  return node("div", { className: "view-stack" }, [
    node("div", { className: "explore-toolbar" }, [
      searchBox(exploreState.query, "Search the timeline"),
      storyFilterSelect(insight.stories, exploreState.storyId, "storyId", "Filter by story"),
      anyFilter ? linkButton("Clear filters", { action: "clear-filters" }) : null,
    ]),
    node("div", { className: "chip-row", attrs: { role: "group", "aria-label": t("Filter by type") } },
      EVENT_KINDS.map((kind) => chip(kind.label, {
        active: !exploreState.kinds || exploreState.kinds.has(kind.key),
        count: kindCounts[kind.key],
        dataset: { action: "toggle-kind", kind: kind.key },
      }))),
    panel(
      "Activity over time",
      exploreState.range
        ? "Showing one period; click the bar again to see everything"
        : "Click a bar to focus on one period",
      activityChart(scoped, { range: exploreState.range }),
    ),
    panel(
      "Timeline",
      "Everything that was recorded, newest first; select an entry to see its evidence",
      shown.length
        ? node("div", {}, [
          stream,
          visible.length > shown.length
            ? node("div", { className: "stream-more" }, [
              linkButton(`${t("Show more")} (${visible.length - shown.length})`, { action: "timeline-more" }),
            ])
            : null,
        ])
        : emptyMessage("Nothing matches these filters.", "Clear the filters to see the whole timeline."),
      { actions: [node("span", { className: "panel-count", text: `${visible.length} / ${insight.events.length}` })] },
    ),
  ]);
}

// ---------------------------------------------------------------- map

const MAP_LAYOUT = Object.freeze({
  columnWidth: 196,
  nodeWidth: 168,
  nodeHeight: 46,
  storyHeight: 74,
  rowGap: 12,
  headerHeight: 34,
  padding: 18,
  labelLength: 22,
});

function truncate(text, length) {
  const value = String(text ?? "");
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

function mapNodeLabel(entry, kind) {
  if (entry.story) return displayTextForItem(entry.item).title;
  const action = actionLabel(entry.item);
  return action ? t(action) : (recordedText(entry.item).title || kindName(kind, entry.item));
}

function mapNodeDetail(entry, label) {
  const recorded = recordedText(entry.item);
  const text = [recorded.summary, recorded.title].find((value) => value && value !== label);
  return text || formatDay(Date.parse(entry.item.timestamp ?? "") || null);
}

const COLUMN_KIND = Object.freeze({
  asked: "request",
  decided: "decision",
  contract: "agreement",
  done: "change",
  verified: "check",
});

// Tree layout: the story sits on the left, each lane hangs from one spine
// through a bracket, and related-record links appear only for the selection.
// That keeps a story with dozens of records readable.
export function mapView(model, state) {
  const insight = insightsFor(model);
  const exploreState = explore(state);
  const stories = insight.stories;
  if (!stories.length) return emptyMessage("No story has been recorded yet.");
  const story = insight.storiesById.get(exploreState.mapStoryId)
    ?? insight.storiesById.get(state.selectedIterationId)
    ?? sortStories(stories, "state")[0];
  const graph = lineageGraph(story, model);
  const layout = MAP_LAYOUT;
  const step = layout.nodeHeight + layout.rowGap;
  const spineY = layout.padding + layout.headerHeight;
  const nodeTop = spineY + 20;
  const tallest = Math.max(...graph.columns.map((column) =>
    column.nodes.length + (column.overflow ? 1 : 0)), 1);
  const width = layout.padding * 2 + graph.columns.length * layout.columnWidth - (layout.columnWidth - layout.nodeWidth);
  const height = nodeTop + Math.max(layout.storyHeight, tallest * step) + layout.padding;
  const columnX = (index) => layout.padding + index * layout.columnWidth;
  const storyIndex = graph.columns.findIndex((column) => column.key === "story");
  const storyX = columnX(storyIndex);
  const storyCenter = nodeTop + layout.storyHeight / 2;
  const selectedKey = state.selectedId;
  const positions = new Map();
  const edgeLayer = svgNode("g", { className: "map-edges" });
  const nodesLayer = svgNode("g", { className: "map-nodes" });
  const headerLayer = svgNode("g", { className: "map-headers" });
  let lastBracketX = null;

  graph.columns.forEach((column, columnIndex) => {
    const x = columnX(columnIndex);
    headerLayer.append(svgNode("text", {
      className: "map-column-label",
      x: x + layout.nodeWidth / 2,
      y: layout.padding + 14,
      "text-anchor": "middle",
      text: `${t(column.label)}${column.key === "story" ? "" : ` · ${column.nodes.length + column.overflow}`}`,
    }));
    if (!column.nodes.length) {
      nodesLayer.append(svgNode("text", {
        className: "map-empty",
        x: x + layout.nodeWidth / 2,
        y: nodeTop + 18,
        "text-anchor": "middle",
        text: t("Not recorded"),
      }));
    }
    let y = nodeTop;
    const centers = [];
    for (const entry of column.nodes) {
      const nodeHeight = entry.story ? layout.storyHeight : layout.nodeHeight;
      positions.set(entry.key, { x, y, height: nodeHeight });
      centers.push({ key: entry.key, y: y + nodeHeight / 2 });
      const selected = selectedKey === entry.key;
      const kind = entry.story ? "story" : COLUMN_KIND[column.key];
      const label = mapNodeLabel(entry, kind);
      const detail = entry.story
        ? `${t(STATE_BY_KEY.get(story.state).label)} · ${story.completed}/${PHASES.length}`
        : mapNodeDetail(entry, label);
      const live = entry.story && story.state === "live";
      const group = svgNode("g", {
        className: `map-node${selected ? " is-selected" : ""}${live ? " is-live" : ""}`,
        role: "button",
        tabindex: "0",
        "aria-label": `${t(column.label)}: ${label}. ${detail}`,
        dataset: {
          action: "select-record",
          selectId: entry.key,
          kind,
          outcome: kind === "check" ? checkOutcome(entry.item) : null,
        },
        transform: `translate(${x} ${y})`,
      }, [svgNode("title", { text: `${label}\n${detail}` })]);
      if (live) {
        group.append(svgNode("rect", { className: "map-pulse", x: -4, y: -4, width: layout.nodeWidth + 8, height: nodeHeight + 8, rx: 12 }));
      }
      group.append(
        svgNode("rect", { className: "map-node-box", width: layout.nodeWidth, height: nodeHeight, rx: 8 }),
        svgNode("rect", { className: "map-node-stripe", width: 5, height: nodeHeight, rx: 2 }),
        svgNode("text", { className: "map-node-title", x: 14, y: entry.story ? 22 : 19, text: truncate(label, entry.story ? 20 : layout.labelLength) }),
        svgNode("text", { className: "map-node-detail", x: 14, y: entry.story ? 40 : 35, text: truncate(detail, layout.labelLength + 3) }),
      );
      if (entry.story) {
        const segment = (layout.nodeWidth - 28) / PHASES.length;
        story.phases.forEach((phase, index) => {
          group.append(svgNode("rect", {
            className: `map-phase${phase.status === "inProgress" ? " is-live" : ""}`,
            x: 14 + index * segment,
            y: 52,
            width: segment - 3,
            height: 8,
            rx: 2,
            dataset: { status: phase.status },
          }));
        });
      }
      nodesLayer.append(group);
      y += nodeHeight + layout.rowGap;
    }
    if (column.overflow) {
      centers.push({ key: null, y: y + layout.nodeHeight / 2 });
      nodesLayer.append(svgNode("g", {
        className: "map-node is-overflow",
        role: "button",
        tabindex: "0",
        "aria-label": `${column.overflow} ${t("more")}: ${t("Show in the timeline")}`,
        dataset: { action: "go-view", targetView: "activity", storyId: story.id, kinds: COLUMN_KIND[column.key] },
        transform: `translate(${x} ${y})`,
      }, [
        svgNode("rect", { className: "map-node-box", width: layout.nodeWidth, height: layout.nodeHeight, rx: 8 }),
        svgNode("text", { className: "map-node-title", x: layout.nodeWidth / 2, y: 28, "text-anchor": "middle", text: `+${column.overflow} ${t("more")}` }),
      ]));
    }
    if (column.key === "story" || !centers.length) return;
    const tick = (center, fromX, toX) => edgeLayer.append(svgNode("path", {
      className: `map-edge${center.key && center.key === selectedKey ? " is-highlighted" : ""}`,
      d: `M${fromX} ${center.y} H${toX}`,
    }));
    if (columnIndex < storyIndex) {
      const bracketX = x + layout.nodeWidth + (layout.columnWidth - layout.nodeWidth) / 2;
      const top = Math.min(centers[0].y, storyCenter);
      const bottom = Math.max(centers[centers.length - 1].y, storyCenter);
      edgeLayer.append(svgNode("path", { className: "map-edge", d: `M${bracketX} ${top} V${bottom} M${bracketX} ${storyCenter} H${storyX}` }));
      for (const center of centers) tick(center, x + layout.nodeWidth, bracketX);
      return;
    }
    const bracketX = x - (layout.columnWidth - layout.nodeWidth) / 2;
    lastBracketX = bracketX;
    edgeLayer.append(svgNode("path", { className: "map-edge", d: `M${bracketX} ${spineY} V${centers[centers.length - 1].y}` }));
    for (const center of centers) tick(center, bracketX, x);
  });
  if (lastBracketX !== null) {
    edgeLayer.append(svgNode("path", {
      className: "map-edge is-spine",
      d: `M${storyX + layout.nodeWidth / 2} ${nodeTop} V${spineY} H${lastBracketX}`,
    }));
  }
  for (const edge of graph.edges) {
    if (edge.kind !== "related" || (selectedKey !== edge.from && selectedKey !== edge.to)) continue;
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) continue;
    const [left, right] = from.x <= to.x ? [from, to] : [to, from];
    const startX = left.x === right.x ? left.x + layout.nodeWidth : left.x + layout.nodeWidth;
    const endX = left.x === right.x ? right.x + layout.nodeWidth : right.x;
    const startY = left.y + left.height / 2;
    const endY = right.y + right.height / 2;
    const bend = left.x === right.x ? 40 : Math.max(30, (endX - startX) / 2);
    edgeLayer.append(svgNode("path", {
      className: "map-edge is-related is-highlighted",
      d: left.x === right.x
        ? `M${startX} ${startY} C${startX + bend} ${startY}, ${endX + bend} ${endY}, ${endX} ${endY}`
        : `M${startX} ${startY} C${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`,
    }));
  }
  const zoom = Math.min(2.5, Math.max(0.5, exploreState.mapZoom || 1));
  const svg = svgNode("svg", {
    className: "lineage-map",
    viewBox: `0 0 ${width} ${height}`,
    width: Math.round(width * zoom),
    height: Math.round(height * zoom),
    role: "group",
    "aria-label": `${t("Lineage map")}: ${storyTitle(story)}`,
  }, [edgeLayer, headerLayer, nodesLayer]);

  return node("div", { className: "view-stack" }, [
    node("div", { className: "explore-toolbar" }, [
      storyFilterSelect(stories, story.id, "mapStoryId", "Choose a story"),
      node("div", { className: "zoom-controls", attrs: { role: "group", "aria-label": t("Zoom") } }, [
        node("button", { className: "icon-text-button", text: "−", attrs: { type: "button", "aria-label": t("Zoom out") }, dataset: { action: "map-zoom", zoom: "out" } }),
        node("span", { className: "zoom-value", text: `${Math.round(zoom * 100)}%` }),
        node("button", { className: "icon-text-button", text: "+", attrs: { type: "button", "aria-label": t("Zoom in") }, dataset: { action: "map-zoom", zoom: "in" } }),
        node("button", { className: "text-button", text: "Reset", i18n: true, attrs: { type: "button" }, dataset: { action: "map-zoom", zoom: "reset" } }),
      ]),
    ]),
    panel(
      "Lineage map",
      "From the request to the checks: every line is a recorded link. Select a box to see its evidence.",
      node("div", { className: "map-scroll", attrs: { tabindex: "0", "aria-label": t("Lineage map") } }, [svg]),
      { actions: [stateBadge(story.state)] },
    ),
    node("div", { className: "map-legend" }, [
      kindLegend(),
      node("span", { className: "legend-item" }, [node("span", { className: "legend-line" }), node("span", { text: "Recorded link", i18n: true })]),
      node("span", { className: "legend-item" }, [node("span", { className: "legend-line is-related" }), node("span", { text: "Related records (shown for the selected box)", i18n: true })]),
    ]),
  ]);
}
