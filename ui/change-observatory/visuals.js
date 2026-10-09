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
  applyDependencies,
  addRemoteStories,
  applySharedClaims,
  changeRequestLinks,
  planLayout,
  relatedChain,
  storyTitleText,
  activityBuckets,
  checkHealth,
  checkOutcome,
  filterEvents,
  formatDay,
  lineageGraph,
  matchesQuery,
  normalizeSearchText,
  queryTerms,
  searchScore,
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
    mapMode: null,
    planFocus: null,
    mapZoom: 1,
    pages: 1,
  };
}

// Projections are cached per model and dependency list so re-rendering on
// every keystroke or selection does not rebuild them.
const insightCache = new WeakMap();
const NO_EDGES = Object.freeze([]);

export function insightsFor(model, edges = NO_EDGES, claims = NO_EDGES, remote = NO_EDGES) {
  let cached = insightCache.get(model);
  if (!cached || cached.edges !== edges || cached.claims !== claims || cached.remote !== remote) {
    const events = projectEvents(model);
    const stories = changeRequestLinks(applyDependencies(
      applySharedClaims(addRemoteStories(storyInsights(model, events), remote), claims),
      edges,
    ));
    cached = {
      edges,
      claims,
      remote,
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
  return storyTitleText(story.iteration);
}

function edgesOf(state) {
  return state.dependencies ?? NO_EDGES;
}

function claimsOf(state) {
  return state.sharedClaims ?? NO_EDGES;
}

function remoteOf(state) {
  return state.remoteStories ?? NO_EDGES;
}

// Text with the searched words marked; matching ignores case and accents.
function highlighted(text, query, className = "") {
  const value = String(text ?? "");
  const terms = queryTerms(query);
  const element = node("span", { className });
  if (!terms.length || !value) {
    element.textContent = value;
    return element;
  }
  let folded = "";
  const origin = [];
  for (let index = 0; index < value.length; index += 1) {
    const part = normalizeSearchText(value[index]) || " ";
    for (const char of part) {
      folded += char;
      origin.push(index);
    }
  }
  const marked = new Array(value.length).fill(false);
  for (const term of terms) {
    let at = folded.indexOf(term);
    while (at !== -1) {
      for (let offset = 0; offset < term.length; offset += 1) marked[origin[at + offset]] = true;
      at = folded.indexOf(term, at + term.length);
    }
  }
  let start = 0;
  for (let index = 1; index <= value.length; index += 1) {
    if (index === value.length || marked[index] !== marked[start]) {
      const piece = value.slice(start, index);
      element.append(marked[start] ? node("mark", { text: piece }) : document.createTextNode(piece));
      start = index;
    }
  }
  return element;
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

function stateDot(stateKey, { recent = false } = {}) {
  return node("span", {
    className: `state-dot${stateKey === "live" || recent ? " is-live" : ""}`,
    attrs: { "aria-hidden": "true" },
    dataset: { state: stateKey },
  });
}

function stateBadge(stateKey, options = {}) {
  return node("span", { className: "state-badge", dataset: { state: stateKey } }, [
    stateDot(stateKey, options),
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

const PLACEHOLDER_SUMMARIES = new Set(["No recorded summary."]);

// Only text the record itself carries (or the autonomy projection) is shown
// as a summary; generic fallback sentences would repeat on every row.
function recordedText(item) {
  const display = displayTextForItem(item);
  if (isAutonomyRecord(item)) return { title: display.title, summary: display.summary };
  const title = String(item?.title ?? "").trim();
  const rawSummary = String(item?.summary ?? "").trim();
  const summary = PLACEHOLDER_SUMMARIES.has(rawSummary) ? "" : rawSummary;
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
      node("strong", { className: "event-title" }, [highlighted(headline, state.explore?.query)]),
      summary ? highlighted(summary, state.explore?.query, "event-summary") : null,
      story ? node("span", { className: "event-story" }, [
        stateDot(story.state),
        node("span", { text: storyTitle(story) }),
        node("span", { className: "story-id", text: story.id }),
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
  if (unit === "hour") return formatDay(bucket.start, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
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
        text: unit === "hour"
          ? formatDay(bucket.start, { hour: "2-digit", minute: "2-digit" })
          : formatDay(bucket.start, { day: "numeric", month: "short" }),
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

function storyCard(story, storiesById) {
  const live = story.state === "live" || story.recent;
  return node("li", { className: `now-card${live ? " is-active" : ""}`, dataset: { state: story.state } }, [
    node("button", {
      className: "now-card-button",
      attrs: { type: "button", "aria-label": `${storyTitle(story)}: ${t(STATE_BY_KEY.get(story.state).label)}` },
      dataset: { action: "open-story", storyId: story.id },
    }, [
      node("span", { className: "now-card-head" }, [
        stateBadge(story.state, { recent: story.recent }),
        node("span", { className: "now-card-time", text: relativeTime(story.lastActivity) }),
      ]),
      node("strong", { className: "now-card-title", text: storyTitle(story) }),
      node("span", { className: "story-id", text: story.id }),
      phaseTrack(story),
      node("span", { className: "now-card-foot" }, [
        node("span", { text: storyNextText(story, storiesById) }),
      ]),
    ]),
  ]);
}

// One plain sentence about where a story stands, in the reader's words.
function storyNextText(story, storiesById) {
  const changer = (story.changedBy ?? []).map((id) => storiesById?.get(id))
    .find((entry) => entry && !["delivered", "replaced", "stopped"].includes(entry.state));
  if (story.state === "delivered" && changer) {
    return `${t(changer.state === "live" ? "Being changed by" : "Change planned in")} ${storyTitle(changer)}`;
  }
  if (story.state === "live" && story.holder) {
    return `${t("Worked on by")} ${story.holder.holder ?? story.holder.agent ?? t("another computer")}`;
  }
  if (story.remoteOnly) return t("New on another computer: update this copy to see its details");
  const replacementId = story.iteration?.closure?.replacementId;
  if (story.state === "replaced" && replacementId) {
    const successor = storiesById?.get(replacementId);
    return `${t("Replaced by")} ${successor ? storyTitle(successor) : replacementId}`;
  }
  if (story.state === "waiting" && story.waitingOn?.length) {
    return `${t("Waiting for")} ${waitingNames(story, storiesById)}`;
  }
  if (story.livePhase) {
    return `${t("Now")}: ${t(story.livePhase.charAt(0).toUpperCase() + story.livePhase.slice(1))}`;
  }
  const next = story.phases.find((phase) => phase.status !== "complete");
  if (story.state === "delivered" || !next) return t("All steps done");
  return `${t("Next step")}: ${t(next.phase.charAt(0).toUpperCase() + next.phase.slice(1))}`;
}

function waitingNames(story, storiesById) {
  if (story.waitingOn.length > 1) return countText(story.waitingOn.length, "story", "stories");
  const [id] = story.waitingOn;
  return storiesById?.get(id) ? storyTitle(storiesById.get(id)) : id;
}

const PROGRESS_ORDER = Object.freeze(["delivered", "live", "blocked", "open", "waiting", "idle", "replaced", "stopped"]);

function progressBar(stateCounts, total) {
  const svg = svgNode("svg", {
    className: "progress-bar",
    viewBox: "0 0 100 10",
    preserveAspectRatio: "none",
    role: "img",
    "aria-label": PROGRESS_ORDER.filter((key) => stateCounts[key])
      .map((key) => `${t(STATE_BY_KEY.get(key).label)}: ${stateCounts[key]}`).join(", "),
  });
  svg.append(svgNode("rect", { className: "progress-track", x: 0, y: 0, width: 100, height: 10, rx: 5 }));
  let x = 0;
  for (const key of PROGRESS_ORDER) {
    const share = total ? (stateCounts[key] / total) * 100 : 0;
    if (!share) continue;
    svg.append(svgNode("rect", {
      className: `progress-segment${key === "live" ? " is-live" : ""}`,
      x,
      y: 0,
      width: share,
      height: 10,
      dataset: { state: key },
    }));
    x += share;
  }
  const legend = node("div", { className: "progress-legend", attrs: { role: "group", "aria-label": t("Filter by status") } },
    PROGRESS_ORDER.filter((key) => stateCounts[key]).map((key) => node("button", {
      className: "progress-key",
      attrs: { type: "button" },
      dataset: { action: "go-view", targetView: "stories", storyState: key, state: key },
    }, [
      node("span", { className: "progress-swatch", attrs: { "aria-hidden": "true" } }),
      node("span", { text: STATE_BY_KEY.get(key).label, i18n: true }),
      node("strong", { text: stateCounts[key] }),
    ])));
  return node("div", { className: "progress-figure" }, [svg, legend]);
}

export function dashboardView(model, state) {
  const insight = insightsFor(model, edgesOf(state), claimsOf(state), remoteOf(state));
  const { stories, stateCounts, health, events } = insight;
  const lastEvent = events.find((event) => event.time !== null);
  const active = stories.filter((story) => story.state === "live" || story.recent);
  const inProgress = stateCounts.live;
  const held = stateCounts.waiting + stateCounts.blocked;
  const delivered = stateCounts.delivered;
  const hasPlan = edgesOf(state).length > 0;

  const headline = node("section", { className: "dash-hero" }, [
    node("div", { className: "dash-hero-copy" }, [
      node("h2", {
        className: "dash-hero-title",
        text: stories.length
          ? t(stories.length === 1 ? "{done} of {total} story delivered" : "{done} of {total} stories delivered")
            .replace("{done}", delivered).replace("{total}", stories.length)
          : t("No story has been recorded yet."),
      }),
      node("p", { className: "dash-hero-status" }, [
        stateDot(active.length ? "live" : (stateCounts.blocked ? "blocked" : "idle")),
        node("span", {
          text: [
            inProgress
              ? countText(inProgress, "story in progress", "stories in progress")
              : t("No story is in progress right now"),
            stateCounts.waiting ? countText(stateCounts.waiting, "waiting for others", "waiting for others") : null,
            stateCounts.blocked ? countText(stateCounts.blocked, "blocked", "blocked") : null,
            stateCounts.replaced ? countText(stateCounts.replaced, "replaced", "replaced") : null,
            lastEvent ? `${t("Last activity")} ${relativeTime(lastEvent.time)}` : null,
          ].filter(Boolean).join(" · "),
        }),
      ]),
      stories.length ? progressBar(stateCounts, stories.length) : null,
    ]),
    node("div", { className: "dash-hero-actions" }, [
      linkButton("See all stories", { action: "go-view", targetView: "stories" }, "is-primary"),
      hasPlan
        ? linkButton("See the project plan", { action: "map-mode", mapMode: "plan", targetView: "map" })
        : linkButton("Open timeline", { action: "go-view", targetView: "activity" }),
    ]),
  ]);

  const passRate = health.passed + health.failed
    ? `${Math.round((health.passed / (health.passed + health.failed)) * 100)}%`
    : "–";
  const kpis = node("div", { className: "kpi-row" }, [
    kpiTile({ label: "In progress", value: inProgress, tone: "live", live: inProgress > 0, hint: active.length > inProgress ? `${active.length - inProgress} ${t("more worked on in the last few hours")}` : (inProgress ? t("Someone is working on them") : t("Nothing in progress")), dataset: { action: "go-view", targetView: "stories", storyState: "live" } }),
    kpiTile({ label: "Delivered stories", value: delivered, tone: "success", hint: `${stories.length ? Math.round((delivered / stories.length) * 100) : 0}% ${t("of stories")}`, dataset: { action: "go-view", targetView: "stories", storyState: "delivered" } }),
    hasPlan
      ? kpiTile({ label: "Waiting or blocked", value: held, tone: stateCounts.blocked ? "warning" : "neutral", hint: stateCounts.blocked ? countText(stateCounts.blocked, "blocked", "blocked") : t("Waiting for other stories"), dataset: { action: "go-view", targetView: "stories", storyState: stateCounts.blocked && !stateCounts.waiting ? "blocked" : "waiting" } })
      : kpiTile({ label: "Blocked", value: stateCounts.blocked, tone: stateCounts.blocked ? "warning" : "neutral", hint: stateCounts.blocked ? null : t("Nothing blocked"), dataset: { action: "go-view", targetView: "stories", storyState: "blocked" } }),
    kpiTile({ label: "Checks passed", value: passRate, tone: health.failed ? "warning" : "success", hint: `${health.passed} ${t("passed")} · ${health.failed} ${t("failed")}`, dataset: { action: "go-view", targetView: "activity", kinds: "check" } }),
  ]);

  const nowStories = sortStories(
    stories.filter((story) => ["live", "blocked", "open"].includes(story.state)
      || (story.recent && !["replaced", "stopped"].includes(story.state))),
    "recent",
  ).slice(0, INSIGHT_SETTINGS.dashboardActiveStoryLimit);
  const now = panel(
    "Happening now",
    active.length ? "A pulsing dot means someone is working on it right now" : "Most recent stories",
    node("ul", { className: "now-grid" }, (nowStories.length ? nowStories : sortStories(stories, "recent").slice(0, 3))
      .map((story) => storyCard(story, insight.storiesById))),
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
    now,
    node("div", { className: "dash-grid" }, [
      panel("Activity over time", "Click a bar to see what happened in that moment", activityChart(events, { compact: true }), { className: "dash-activity" }),
      panel("Check results", "Outcome of recorded tests and gates", healthDonut(health), { className: "dash-health" }),
    ]),
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

function storyLinks(label, ids, insight) {
  if (!ids?.length) return null;
  return node("p", { className: "story-links" }, [
    node("span", { className: "story-links-label", text: label, i18n: true }),
    ...ids.map((id) => {
      const linked = insight.storiesById.get(id);
      return node("button", {
        className: "story-link",
        attrs: { type: "button" },
        dataset: { action: "open-story", storyId: id },
      }, [stateDot(linked?.state ?? "idle"), node("span", { text: linked ? storyTitle(linked) : id })]);
    }),
  ]);
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
      node("strong", { className: "story-title" }, [highlighted(storyTitle(story), exploreState.query)]),
      node("span", { className: "story-sub" }, [
        stateBadge(story.state, { recent: story.recent }),
        node("span", { text: ["waiting", "replaced"].includes(story.state) || story.holder || story.changedBy?.length || story.remoteOnly
          ? storyNextText(story, insight.storiesById)
          : relativeTime(story.lastActivity) }),
        highlighted(story.id, exploreState.query, "story-id"),
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
    story.iteration?.closure?.replacementId
      ? storyLinks("Replaced by", [story.iteration.closure.replacementId], insight)
      : null,
    storyLinks("Changes the work of", story.changes, insight),
    storyLinks("Being changed by", story.changedBy, insight),
    storyLinks("Needs first", story.prerequisites, insight),
    storyLinks("Unlocks", story.dependents, insight),
    node("div", { className: "story-actions" }, [
      linkButton("Show on the map", { action: "open-map", storyId: story.id }, "is-primary"),
      story.prerequisites?.length || story.dependents?.length
        ? linkButton("Show in the project plan", { action: "map-mode", mapMode: "plan", planFocus: story.id, targetView: "map" })
        : null,
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
  const insight = insightsFor(model, edgesOf(state), claimsOf(state), remoteOf(state));
  const exploreState = explore(state);
  const query = exploreState.query;
  const scored = insight.stories
    .filter((story) => exploreState.storyState === "all" || story.state === exploreState.storyState)
    .map((story) => ({
      story,
      score: !query ? 1 : (searchScore(story.iteration, query) * 2
        || (story.events.some((event) => matchesQuery(event.item, query)) ? 1 : 0)),
    }))
    .filter((entry) => entry.score > 0);
  // With a search, stories whose own name matches come first.
  const ordered = sortStories(scored.map((entry) => entry.story), exploreState.sort);
  const scoreOf = new Map(scored.map((entry) => [entry.story.id, entry.score]));
  const visible = query
    ? ordered.map((story, index) => ({ story, index })).sort((left, right) =>
      scoreOf.get(right.story.id) - scoreOf.get(left.story.id) || left.index - right.index).map((entry) => entry.story)
    : ordered;
  // Rows are built a page at a time so very large projects stay responsive.
  const shownStories = visible.slice(0, INSIGHT_SETTINGS.storyPageSize * exploreState.pages);
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
        ? node("div", {}, [
          node("ul", { className: "story-list" }, shownStories.map((story) => storyRow(story, state, insight))),
          visible.length > shownStories.length
            ? node("div", { className: "stream-more" }, [
              linkButton(`${t("Show more")} (${visible.length - shownStories.length})`, { action: "timeline-more" }),
            ])
            : null,
        ])
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
  const insight = insightsFor(model, edgesOf(state), claimsOf(state), remoteOf(state));
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
  const time = Date.parse(entry.item.timestamp ?? "");
  return text || (Number.isFinite(time) ? formatDay(time) : "");
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
  const insight = insightsFor(model, edgesOf(state), claimsOf(state), remoteOf(state));
  const exploreState = explore(state);
  const stories = insight.stories;
  if (!stories.length) return emptyMessage("No story has been recorded yet.");
  const hasPlan = edgesOf(state).length > 0;
  const mode = hasPlan ? (exploreState.mapMode ?? "plan") : "story";
  if (mode === "plan") return planView(state, insight);
  return storyMapView(model, state, insight, hasPlan);
}

function mapModeSwitch(mode) {
  return node("div", { className: "segmented", attrs: { role: "group", "aria-label": t("What to show") } }, [
    ["plan", "Project plan"],
    ["story", "One story in detail"],
  ].map(([key, label]) => node("button", {
    className: `segmented-option${mode === key ? " is-active" : ""}`,
    text: label,
    i18n: true,
    attrs: { type: "button", "aria-pressed": String(mode === key) },
    dataset: { action: "map-mode", mapMode: key },
  })));
}

function zoomControls(zoom) {
  return node("div", { className: "zoom-controls", attrs: { role: "group", "aria-label": t("Zoom") } }, [
    node("button", { className: "icon-text-button", text: "−", attrs: { type: "button", "aria-label": t("Zoom out") }, dataset: { action: "map-zoom", zoom: "out" } }),
    node("span", { className: "zoom-value", text: `${Math.round(zoom * 100)}%` }),
    node("button", { className: "icon-text-button", text: "+", attrs: { type: "button", "aria-label": t("Zoom in") }, dataset: { action: "map-zoom", zoom: "in" } }),
    node("button", { className: "text-button", text: "Reset", i18n: true, attrs: { type: "button" }, dataset: { action: "map-zoom", zoom: "reset" } }),
  ]);
}

const PLAN_LAYOUT = Object.freeze({
  nodeWidth: 224,
  nodeHeight: 70,
  columnGap: 52,
  rowGap: 14,
  headerHeight: 30,
  padding: 18,
  labelLength: 27,
});

// The project plan: every story is a box, and a line runs from the work it
// needs to the work it unlocks. Selecting a box lights up its whole chain.
// A plan with hundreds of boxes is unreadable and slow to draw. Above the
// limit, finished work that unlocks nothing still open is left out.
function planStoriesFor(stories, showAll) {
  if (showAll || stories.length <= INSIGHT_SETTINGS.planStoryLimit) return { stories, hidden: 0 };
  const byId = new Map(stories.map((story) => [story.id, story]));
  const kept = stories.filter((story) => story.state !== "delivered"
    || story.changedBy?.length
    || story.dependents.some((id) => byId.get(id)?.state !== "delivered"));
  // When everything is finished there is nothing left to focus on.
  if (!kept.length) return { stories, hidden: 0 };
  return { stories: kept, hidden: stories.length - kept.length };
}

function planView(state, insight) {
  const exploreState = explore(state);
  const edges = edgesOf(state);
  const layout = PLAN_LAYOUT;
  const planStories = planStoriesFor(insight.stories, exploreState.planAll);
  const plan = planLayout(planStories.stories, edges);
  const focus = insight.storiesById.has(exploreState.planFocus) ? exploreState.planFocus : null;
  const chain = focus ? relatedChain(focus, plan.edges) : null;
  const step = layout.nodeHeight + layout.rowGap;
  const tallest = Math.max(...plan.columns.map((column) => column.length), 1);
  const width = layout.padding * 2 + plan.columns.length * (layout.nodeWidth + layout.columnGap) - layout.columnGap;
  const top = layout.padding + layout.headerHeight;
  const height = top + tallest * step + layout.padding;
  const positions = new Map();
  const titleCounts = new Map();
  for (const story of planStories.stories) titleCounts.set(storyTitle(story), (titleCounts.get(storyTitle(story)) ?? 0) + 1);
  const duplicateTitles = new Set([...titleCounts].filter(([, count]) => count > 1).map(([title]) => title));
  const headers = svgNode("g", { className: "map-headers" });
  const nodes = svgNode("g", { className: "map-nodes" });
  const lines = svgNode("g", { className: "map-edges" });

  plan.columns.forEach((column, columnIndex) => {
    const x = layout.padding + columnIndex * (layout.nodeWidth + layout.columnGap);
    const offset = ((tallest - column.length) * step) / 2;
    headers.append(svgNode("text", {
      className: "map-column-label",
      x: x + layout.nodeWidth / 2,
      y: layout.padding + 14,
      "text-anchor": "middle",
      text: `${t("Wave")} ${columnIndex + 1}${columnIndex === 0 ? ` · ${t("start here")}` : ""}`,
    }));
    column.forEach((story, rowIndex) => {
      const y = top + offset + rowIndex * step;
      positions.set(story.id, { x, y });
      const title = storyTitle(story);
      const shared = duplicateTitles.has(title);
      const detail = [
        shared ? story.id : null,
        (story.state === "delivered" && !story.changedBy?.length) || (story.state === "idle" && !story.waitingOn.length)
          ? t(STATE_BY_KEY.get(story.state).label)
          : storyNextText(story, insight.storiesById),
      ].filter(Boolean).join(" · ");
      const stateLabel = t(STATE_BY_KEY.get(story.state).label);
      const focused = story.id === focus;
      const dimmed = chain && !chain.has(story.id);
      const live = story.state === "live" || story.recent;
      const group = svgNode("g", {
        className: `map-node plan-node${focused ? " is-selected" : ""}${dimmed ? " is-dimmed" : ""}${live ? " is-live" : ""}`,
        role: "button",
        tabindex: "0",
        "aria-pressed": focused ? "true" : "false",
        "aria-label": `${title}. ${stateLabel}. ${detail}`,
        dataset: { action: "plan-focus", storyId: story.id, state: story.state },
        transform: `translate(${x} ${y})`,
      }, [svgNode("title", { text: `${title}\n${stateLabel} · ${detail}\n${story.id}` })]);
      if (live) {
        group.append(svgNode("rect", { className: "map-pulse", x: -4, y: -4, width: layout.nodeWidth + 8, height: layout.nodeHeight + 8, rx: 14 }));
      }
      group.append(
        svgNode("rect", { className: "map-node-box", width: layout.nodeWidth, height: layout.nodeHeight, rx: 10 }),
        svgNode("rect", { className: "plan-node-stripe", width: 5, height: layout.nodeHeight, rx: 2 }),
        svgNode("text", { className: "map-node-title", x: 14, y: 22, text: truncate(title, layout.labelLength) }),
        svgNode("text", { className: "map-node-detail", x: 14, y: 40, text: truncate(detail, layout.labelLength + 5) }),
      );
      const segment = (layout.nodeWidth - 28) / PHASES.length;
      story.phases.forEach((phase, index) => {
        group.append(svgNode("rect", {
          className: `map-phase${phase.status === "inProgress" ? " is-live" : ""}`,
          x: 14 + index * segment,
          y: 52,
          width: segment - 3,
          height: 7,
          rx: 2,
          dataset: { status: phase.status },
        }));
      });
      nodes.append(group);
    });
  });

  for (const edge of plan.edges) {
    const needed = positions.get(edge.to);
    const waiting = positions.get(edge.from);
    if (!needed || !waiting) continue;
    const startX = needed.x + layout.nodeWidth;
    const startY = needed.y + layout.nodeHeight / 2;
    const endX = waiting.x;
    const endY = waiting.y + layout.nodeHeight / 2;
    const bend = Math.max(30, (endX - startX) / 2);
    const inChain = chain && chain.has(edge.from) && chain.has(edge.to);
    const done = insight.storiesById.get(edge.to)?.state === "delivered";
    lines.append(svgNode("path", {
      className: `plan-edge${inChain ? " is-highlighted" : ""}${chain && !inChain ? " is-dimmed" : ""}${done ? " is-done" : ""}`,
      d: `M${startX} ${startY} C${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`,
    }));
  }

  const zoom = Math.min(2.5, Math.max(0.5, exploreState.mapZoom || 1));
  const svg = svgNode("svg", {
    className: "lineage-map plan-map",
    viewBox: `0 0 ${width} ${height}`,
    width: Math.round(width * zoom),
    height: Math.round(height * zoom),
    role: "group",
    "aria-label": t("Project plan"),
  }, [lines, headers, nodes]);

  const focused = focus ? insight.storiesById.get(focus) : null;
  const focusBar = focused
    ? node("div", { className: "plan-focus" }, [
      node("div", { className: "plan-focus-copy" }, [
        stateBadge(focused.state, { recent: focused.recent }),
        node("strong", { text: storyTitle(focused) }),
        node("span", { className: "plan-focus-detail", text: [
          focused.prerequisites.length ? countText(focused.prerequisites.length, "story needed first", "stories needed first") : t("Needs nothing else"),
          focused.dependents.length ? countText(focused.dependents.length, "story unlocked", "stories unlocked") : null,
        ].filter(Boolean).join(" · ") }),
      ]),
      node("div", { className: "story-actions" }, [
        linkButton("Open story", { action: "open-story", storyId: focused.id }, "is-primary"),
        linkButton("One story in detail", { action: "map-mode", mapMode: "story", storyId: focused.id }),
        linkButton("Clear selection", { action: "plan-focus", storyId: focused.id }),
      ]),
    ])
    : node("p", { className: "plan-hint", text: "Select a story to light up what it needs and what it unlocks.", i18n: true });

  return node("div", { className: "view-stack" }, [
    node("div", { className: "explore-toolbar" }, [mapModeSwitch("plan"), zoomControls(zoom)]),
    panel(
      "Project plan",
      "Read it left to right: each story starts when the ones before it are delivered.",
      node("div", {}, [
        focusBar,
        planStories.hidden
          ? node("p", { className: "plan-hint" }, [
            node("span", { text: `${t("Large plan: finished work is hidden.")} ${countText(planStories.hidden, "story hidden", "stories hidden")}. ` }),
            linkButton("Show everything", { action: "plan-all" }),
          ])
          : null,
        node("div", { className: "map-scroll", attrs: { tabindex: "0", "aria-label": t("Project plan") } }, [svg]),
      ]),
    ),
    node("div", { className: "map-legend" }, [
      node("span", { className: "legend-item" }, [node("span", { className: "legend-line is-plan" }), node("span", { text: "Needed before", i18n: true })]),
      node("span", { className: "legend-item" }, [node("span", { className: "legend-line is-plan is-done" }), node("span", { text: "Already delivered", i18n: true })]),
      ...["live", "waiting", "delivered"].map((key) => node("span", { className: "legend-item" }, [stateDot(key), node("span", { text: STATE_BY_KEY.get(key).label, i18n: true })])),
    ]),
  ]);
}

function storyMapView(model, state, insight, hasPlan) {
  const exploreState = explore(state);
  const stories = insight.stories;
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
        "aria-label": detail ? `${t(column.label)}: ${label}. ${detail}` : `${t(column.label)}: ${label}`,
        dataset: {
          action: "select-record",
          selectId: entry.key,
          kind,
          outcome: kind === "check" ? checkOutcome(entry.item) : null,
        },
        transform: `translate(${x} ${y})`,
      }, [svgNode("title", { text: detail ? `${label}\n${detail}` : label })]);
      if (live) {
        group.append(svgNode("rect", { className: "map-pulse", x: -4, y: -4, width: layout.nodeWidth + 8, height: nodeHeight + 8, rx: 12 }));
      }
      group.append(...[
        svgNode("rect", { className: "map-node-box", width: layout.nodeWidth, height: nodeHeight, rx: 8 }),
        svgNode("rect", { className: "map-node-stripe", width: 5, height: nodeHeight, rx: 2 }),
        svgNode("text", { className: "map-node-title", x: 14, y: entry.story ? 22 : (detail ? 19 : 28), text: truncate(label, entry.story ? 20 : layout.labelLength) }),
        detail ? svgNode("text", { className: "map-node-detail", x: 14, y: entry.story ? 40 : 35, text: truncate(detail, layout.labelLength + 3) }) : null,
      ].filter(Boolean));
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
    "aria-label": `${t("How this story was built")}: ${storyTitle(story)}`,
  }, [edgeLayer, headerLayer, nodesLayer]);

  return node("div", { className: "view-stack" }, [
    node("div", { className: "explore-toolbar" }, [
      hasPlan ? mapModeSwitch("story") : null,
      storyFilterSelect(stories, story.id, "mapStoryId", "Choose a story"),
      zoomControls(zoom),
    ]),
    panel(
      "How this story was built",
      "From the request to the checks. Select a box to see what was recorded.",
      node("div", { className: "map-scroll", attrs: { tabindex: "0", "aria-label": t("How this story was built") } }, [svg]),
      { actions: [stateBadge(story.state)] },
    ),
    node("div", { className: "map-legend" }, [
      kindLegend(),
      node("span", { className: "legend-item" }, [node("span", { className: "legend-line" }), node("span", { text: "Recorded link", i18n: true })]),
      node("span", { className: "legend-item" }, [node("span", { className: "legend-line is-related" }), node("span", { text: "Related records (shown for the selected box)", i18n: true })]),
    ]),
  ]);
}
