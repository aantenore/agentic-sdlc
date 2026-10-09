// Read-only projections that turn the normalized view model into the shapes
// the visual views draw: an activity stream, per-story progress, activity
// buckets, phase totals, check health, and an explicit-link lineage map.
// Nothing here infers a link or a state that the records do not carry.
import {
  PHASES,
  arrayOrEmpty,
  iterationRelevance,
  recordSelectionKey,
} from "./model.js";
import { displayTextForItem, getLocale, t } from "./i18n.js";

// Presentation tunables live in one place so they can be adjusted without
// touching the renderers.
export const INSIGHT_SETTINGS = Object.freeze({
  activityBucketCount: 16,
  dailyBucketThresholdDays: 21,
  recentEventCount: 8,
  timelinePageSize: 60,
  storyEventPreviewCount: 12,
  mapColumnLimit: 8,
  liveRefreshSeconds: 30,
  dashboardActiveStoryLimit: 6,
});

// Order decides which kind keeps an entry that two collections share.
export const EVENT_KINDS = Object.freeze([
  Object.freeze({ key: "request", label: "Requests", singular: "Request" }),
  Object.freeze({ key: "agreement", label: "Agreements", singular: "Agreement" }),
  Object.freeze({ key: "change", label: "Changes", singular: "Change" }),
  Object.freeze({ key: "decision", label: "Decisions", singular: "Decision" }),
  Object.freeze({ key: "check", label: "Checks", singular: "Check" }),
]);

const KIND_COLLECTIONS = Object.freeze({
  request: (model) => model.summary?.asked,
  agreement: (model) => model.contracts,
  change: (model) => model.changes,
  decision: (model) => model.decisions,
  check: (model) => model.verification,
});

export const STORY_STATES = Object.freeze([
  Object.freeze({ key: "live", label: "In progress" }),
  Object.freeze({ key: "blocked", label: "Blocked" }),
  Object.freeze({ key: "open", label: "Started" }),
  Object.freeze({ key: "delivered", label: "Delivered" }),
  Object.freeze({ key: "idle", label: "Not started" }),
  Object.freeze({ key: "stopped", label: "Stopped" }),
]);

// Plain-language names for recorded actions. Unknown actions fall back to the
// kind of record, never to the raw action identifier.
export const ACTION_LABELS = Object.freeze({
  "authorization.grant": "Permission granted",
  "autonomy.delivery.approve": "Way of working approved",
  "autonomy.delivery.close": "Way of working closed",
  "autonomy.delivery.propose": "Way of working proposed",
  "autonomy.delivery.revoke": "Way of working revoked",
  "baseline.approve": "Starting point approved",
  "baseline.propose": "Starting point proposed",
  "capability.approve": "Tool approved",
  "capability.profile.approve": "Tool set approved",
  "capability.profile.propose": "Tool set proposed",
  "capability.recommend": "Tool suggested",
  "contract.approve": "Agreement approved",
  "contract.story-link": "Agreement linked to the work",
  "git.commit": "Change saved",
  "git.push": "Change shared",
  "implementation": "Change made",
  "output.link": "Result attached",
  "pull_request.create": "Review requested",
  "pull_request.merge": "Change merged",
  "pull_request.update": "Review updated",
  "requirement.approve": "Request approved",
  "requirement.create": "Request created",
  "requirement.propose": "Request proposed",
  "requirement.revise": "Request revised",
  "requirement.supersede": "Request replaced",
  "story.complete-step": "Step completed",
  "story.release": "Work released",
  "task.start.confirm": "Work started",
  "test": "Tests run",
  "test.local": "Tests run",
  "test.run": "Tests run",
  "validation": "Validation run",
  "workflow.instance.start": "Workflow started",
  "workflow.instance.transition": "Workflow moved on",
});

export function eventTime(item) {
  const time = Date.parse(item?.timestamp ?? "");
  return Number.isFinite(time) ? time : null;
}

function sourceIdentity(item) {
  const ref = arrayOrEmpty(item?.sourceRefs)[0];
  if (!ref?.path) return null;
  return `${item.id ?? ""}\u0000${ref.path}\u0000${ref.line ?? ""}`;
}

export function actionLabel(item) {
  const action = String(item?.action ?? "");
  return Object.hasOwn(ACTION_LABELS, action) ? ACTION_LABELS[action] : null;
}

export function projectEvents(model) {
  const events = [];
  const seenKeys = new Set();
  const seenSources = new Set();
  for (const kind of EVENT_KINDS) {
    for (const item of arrayOrEmpty(KIND_COLLECTIONS[kind.key](model ?? {}))) {
      const key = recordSelectionKey(item);
      if (!key || seenKeys.has(key)) continue;
      const source = sourceIdentity(item);
      if (source && seenSources.has(source)) continue;
      seenKeys.add(key);
      if (source) seenSources.add(source);
      events.push({ key, kind: kind.key, item, time: eventTime(item), storyId: item.storyId ?? null });
    }
  }
  return events.sort(compareEventsNewestFirst);
}

export function compareEventsNewestFirst(left, right) {
  if (left.time === right.time) return 0;
  if (left.time === null) return 1;
  if (right.time === null) return -1;
  return right.time - left.time;
}

const FAILED_CHECK = /fail|error|reject|block|denied|invalid/u;
const PENDING_CHECK = /pending|running|progress|queued|waiting|required/u;
const PASSED_CHECK = /^(pass|ready|approved|success|succeeded|green|ok|complete|verified|certified)/u;

export function checkOutcome(item) {
  const status = String(item?.status ?? "").toLowerCase();
  if (!status) return "recorded";
  if (FAILED_CHECK.test(status)) return "failed";
  if (PASSED_CHECK.test(status) && !status.includes("pending")) return "passed";
  if (PENDING_CHECK.test(status)) return "pending";
  if (PASSED_CHECK.test(status)) return "pending";
  return "recorded";
}

export function checkHealth(events) {
  const health = { passed: 0, failed: 0, pending: 0, recorded: 0, total: 0 };
  for (const event of events) {
    if (event.kind !== "check") continue;
    health[checkOutcome(event.item)] += 1;
    health.total += 1;
  }
  return health;
}

export function storyState(iteration) {
  const phases = arrayOrEmpty(iteration?.phases);
  const relevance = iterationRelevance(iteration);
  if (relevance === "superseded") return "stopped";
  if (phases.some((phase) => phase.status === "blocked")) return "blocked";
  if (relevance === "delivered") return "delivered";
  if (phases.some((phase) => phase.status === "inProgress")) return "live";
  if (relevance === "active") return "open";
  return "idle";
}

function dossierItemKeys(iteration) {
  const keys = new Set();
  for (const lane of Object.values(iteration?.dossier?.lanes ?? {})) {
    for (const item of arrayOrEmpty(lane?.items)) {
      const key = recordSelectionKey(item);
      if (key) keys.add(key);
    }
  }
  return keys;
}

export function storyInsights(model, events = projectEvents(model)) {
  const byStory = new Map();
  for (const event of events) {
    if (!event.storyId) continue;
    if (!byStory.has(event.storyId)) byStory.set(event.storyId, []);
    byStory.get(event.storyId).push(event);
  }
  const byKey = new Map(events.map((event) => [event.key, event]));
  return arrayOrEmpty(model?.iterations).map((iteration) => {
    const own = new Map((byStory.get(iteration.id) ?? []).map((event) => [event.key, event]));
    for (const key of dossierItemKeys(iteration)) {
      const event = byKey.get(key);
      if (event && !own.has(key)) own.set(key, event);
    }
    const storyEvents = [...own.values()].sort(compareEventsNewestFirst);
    const counts = Object.fromEntries(EVENT_KINDS.map((kind) => [kind.key, 0]));
    for (const event of storyEvents) counts[event.kind] += 1;
    const phases = PHASES.map((phase) =>
      arrayOrEmpty(iteration.phases).find((entry) => entry.phase === phase)
      ?? { phase, status: "missing", provenance: "missing", sourceRefs: [] });
    const lastActivity = storyEvents.find((event) => event.time !== null)?.time
      ?? eventTime(iteration);
    return {
      id: iteration.id,
      iteration,
      state: storyState(iteration),
      phases,
      completed: phases.filter((phase) => phase.status === "complete").length,
      livePhase: phases.find((phase) => phase.status === "inProgress")?.phase ?? null,
      counts,
      events: storyEvents,
      lastActivity,
    };
  });
}

export function sortStories(stories, order = "recent") {
  const list = [...stories];
  const byTitle = (left, right) =>
    String(left.iteration.title ?? "").localeCompare(String(right.iteration.title ?? ""));
  const stateRank = new Map(STORY_STATES.map((state, index) => [state.key, index]));
  if (order === "title") return list.sort(byTitle);
  if (order === "progress") {
    return list.sort((left, right) => right.completed - left.completed || byTitle(left, right));
  }
  if (order === "state") {
    return list.sort((left, right) =>
      stateRank.get(left.state) - stateRank.get(right.state)
      || (right.lastActivity ?? 0) - (left.lastActivity ?? 0));
  }
  return list.sort((left, right) => (right.lastActivity ?? -Infinity) - (left.lastActivity ?? -Infinity));
}

export function storyStateCounts(stories) {
  const counts = Object.fromEntries(STORY_STATES.map((state) => [state.key, 0]));
  for (const story of stories) counts[story.state] += 1;
  return counts;
}

export function phaseTotals(stories) {
  return PHASES.map((phase) => {
    const totals = { phase, complete: 0, inProgress: 0, blocked: 0, missing: 0 };
    for (const story of stories) {
      const status = story.phases.find((entry) => entry.phase === phase)?.status ?? "missing";
      totals[Object.hasOwn(totals, status) ? status : "missing"] += 1;
    }
    return totals;
  });
}

const DAY = 86_400_000;

function startOfUtcDay(time) {
  const date = new Date(time);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function startOfUtcWeek(time) {
  const day = startOfUtcDay(time);
  const weekday = (new Date(day).getUTCDay() + 6) % 7;
  return day - weekday * DAY;
}

// Buckets end at the latest recorded event, not at the clock, so an older
// project still shows its real activity instead of an empty chart.
export function activityBuckets(events, {
  count = INSIGHT_SETTINGS.activityBucketCount,
  dailyThresholdDays = INSIGHT_SETTINGS.dailyBucketThresholdDays,
} = {}) {
  const timed = events.filter((event) => event.time !== null);
  if (!timed.length) return { unit: "week", buckets: [] };
  const latest = Math.max(...timed.map((event) => event.time));
  const earliest = Math.min(...timed.map((event) => event.time));
  const unit = latest - earliest <= dailyThresholdDays * DAY ? "day" : "week";
  const size = unit === "day" ? DAY : 7 * DAY;
  const lastStart = unit === "day" ? startOfUtcDay(latest) : startOfUtcWeek(latest);
  const span = unit === "day"
    ? Math.min(count, Math.max(1, Math.round((lastStart - startOfUtcDay(earliest)) / DAY) + 1))
    : count;
  const buckets = [];
  for (let index = span - 1; index >= 0; index -= 1) {
    const start = lastStart - index * size;
    buckets.push({
      start,
      end: start + size,
      total: 0,
      counts: Object.fromEntries(EVENT_KINDS.map((kind) => [kind.key, 0])),
    });
  }
  const first = buckets[0].start;
  for (const event of timed) {
    if (event.time < first) continue;
    const bucket = buckets[Math.min(buckets.length - 1, Math.floor((event.time - first) / size))];
    bucket.counts[event.kind] += 1;
    bucket.total += 1;
  }
  return { unit, buckets };
}

export function searchableText(item) {
  const display = displayTextForItem(item);
  return [
    display.title,
    display.summary,
    item?.title,
    item?.summary,
    item?.id,
    item?.storyId,
    t(actionLabel(item) ?? ""),
  ].filter(Boolean).join(" ").toLowerCase();
}

export function matchesQuery(item, query) {
  const terms = String(query ?? "").toLowerCase().split(/\s+/u).filter(Boolean);
  if (!terms.length) return true;
  const text = searchableText(item);
  return terms.every((term) => text.includes(term));
}

export function filterEvents(events, {
  query = "",
  kinds = null,
  range = null,
  storyId = "",
} = {}) {
  return events.filter((event) =>
    (!kinds || kinds.has(event.kind))
    && (!storyId || event.storyId === storyId)
    && (!range || (event.time !== null && event.time >= range.start && event.time < range.end))
    && matchesQuery(event.item, query));
}

export function relativeTime(time, now = Date.now()) {
  if (time === null || time === undefined) return t("Time not recorded");
  const seconds = Math.round((time - now) / 1000);
  const units = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["week", 604_800],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  const format = new Intl.RelativeTimeFormat(getLocale(), { numeric: "auto" });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  }
  return format.format(0, "minute");
}

export function formatDay(time, options = { day: "numeric", month: "short", year: "numeric" }) {
  if (time === null || time === undefined) return t("Time not recorded");
  return new Intl.DateTimeFormat(getLocale(), { timeZone: "UTC", ...options }).format(new Date(time));
}

const MAP_COLUMNS = Object.freeze([
  Object.freeze({ key: "asked", label: "Asked" }),
  Object.freeze({ key: "story", label: "Story" }),
  Object.freeze({ key: "decided", label: "Decided" }),
  Object.freeze({ key: "contract", label: "Contract" }),
  Object.freeze({ key: "done", label: "Done" }),
  Object.freeze({ key: "verified", label: "Verified" }),
]);

const EVENT_KIND_TO_LANE = Object.freeze({
  request: "asked",
  decision: "decided",
  agreement: "contract",
  change: "done",
  check: "verified",
});

function laneItemsFromRecords(story, model) {
  const lanes = { asked: [], decided: [], contract: [], done: [], verified: [] };
  const requirementIds = new Set([
    ...arrayOrEmpty(story.iteration.requirementIds),
    story.iteration.requirementId,
  ].filter(Boolean));
  for (const item of arrayOrEmpty(model?.summary?.asked)) {
    if (requirementIds.has(item.requirementId ?? item.id)) lanes.asked.push(item);
  }
  for (const event of story.events) {
    const lane = EVENT_KIND_TO_LANE[event.kind];
    if (lane !== "asked") lanes[lane].push(event.item);
  }
  for (const item of arrayOrEmpty(model?.contracts)) {
    if (item.id === story.iteration.contractId && !lanes.contract.includes(item)) {
      lanes.contract.push(item);
    }
  }
  return lanes;
}

// Every edge comes from a recorded link: lane membership in the story dossier,
// an explicit story ID, or an item's recorded related IDs.
export function lineageGraph(story, model, { limit = INSIGHT_SETTINGS.mapColumnLimit } = {}) {
  if (!story) return { columns: [], edges: [] };
  const dossier = story.iteration.dossier;
  const lanes = dossier
    ? Object.fromEntries(["asked", "decided", "contract", "done", "verified"].map((key) =>
      [key, arrayOrEmpty(dossier.lanes?.[key]?.items)]))
    : laneItemsFromRecords(story, model);
  const storyKey = recordSelectionKey(story.iteration);
  const columns = MAP_COLUMNS.map((column) => {
    if (column.key === "story") {
      return { ...column, nodes: [{ key: storyKey, item: story.iteration, story: true }], overflow: 0 };
    }
    const unique = new Map();
    for (const item of lanes[column.key] ?? []) {
      const key = recordSelectionKey(item);
      if (key && !unique.has(key)) unique.set(key, item);
    }
    const sorted = [...unique.entries()]
      .map(([key, item]) => ({ key, item, time: eventTime(item) }))
      .sort(compareEventsNewestFirst);
    return {
      ...column,
      nodes: sorted.slice(0, limit).map(({ key, item }) => ({ key, item })),
      overflow: Math.max(0, sorted.length - limit),
    };
  });
  const nodesById = new Map();
  for (const column of columns) {
    for (const entry of column.nodes) {
      if (entry.item?.id && !nodesById.has(entry.item.id)) nodesById.set(entry.item.id, entry.key);
    }
  }
  const edges = [];
  const seen = new Set();
  const addEdge = (from, to, kind) => {
    const id = `${from}\u0000${to}`;
    if (from === to || seen.has(id) || seen.has(`${to}\u0000${from}`)) return;
    seen.add(id);
    edges.push({ from, to, kind });
  };
  for (const column of columns) {
    if (column.key === "story") continue;
    for (const entry of column.nodes) {
      if (column.key === "asked") addEdge(entry.key, storyKey, "story");
      else addEdge(storyKey, entry.key, "story");
    }
  }
  for (const column of columns) {
    for (const entry of column.nodes) {
      for (const relatedId of arrayOrEmpty(entry.item?.related)) {
        const target = nodesById.get(relatedId);
        if (target && target !== storyKey && entry.key !== storyKey) addEdge(entry.key, target, "related");
      }
    }
  }
  return { columns, edges };
}
