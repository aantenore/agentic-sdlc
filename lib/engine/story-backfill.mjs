// Completion "a posteriori" of lifecycle phases that were skipped.
//
// Agents often do the work of a phase (commits, tests, a strict gate) without
// recording the explicit `story complete-step`. Once a later phase is
// recorded, completing the earlier one normally lands after it and the
// lifecycle gate rejects the order. A backfill records that completion
// honestly: it names a reason, cites trace events that already exist and
// predate the next phase, and takes as effective time the latest of them.
// Without such evidence there is nothing to backfill.

import path from "node:path";

import { fs } from "../runtime/host.mjs";

export const BACKFILL_MODE = "backfill";
export const BACKFILL_LABEL = { it: "completata a posteriori", en: "completed retroactively" };

// Which sealed trace events prove that a phase happened. A project can
// replace the rules of one phase with `story_backfill.evidence.<phase>` in
// its config: a list of { type?, action?, outcome? } matchers.
// `trace append --type decision` records action "decision"; `action: null`
// matches an event without an action.
const PLANNING = Object.freeze([
  { type: "decision", action: "decision" },
  { type: "decision", action: null },
  { action: "contract.story-link" },
  { action: "contract.approve" },
  { action: "requirement.approve" },
  { action: "baseline.approve" },
]);
export const DEFAULT_BACKFILL_EVIDENCE = Object.freeze({
  discovery: PLANNING,
  analysis: PLANNING,
  design: [...PLANNING, { action: "task.start.confirm" }],
  implementation: [{ action: "git.commit", outcome: "passed" }, { type: "implementation", outcome: "passed" }],
  validation: [{ type: "test", outcome: "passed" }, { action: "gate.check", outcome: "passed" }],
});

const EVIDENCE_NEEDS = Object.freeze({
  discovery: "a recorded decision or an approved contract/requirement in the story trace",
  analysis: "a recorded decision or an approved contract/requirement in the story trace",
  design: "a recorded decision, an approved contract or a confirmed task start in the story trace",
  implementation: "a passed git.commit (or implementation trace) in the story trace",
  validation: "a passed test record or a passed strict gate in the story trace",
});

export function backfillEvidenceRules(config = {}) {
  const overrides = config?.story_backfill?.evidence;
  const rules = { ...DEFAULT_BACKFILL_EVIDENCE };
  if (overrides && typeof overrides === "object") {
    for (const [phase, matchers] of Object.entries(overrides)) {
      if (Array.isArray(matchers)) rules[phase] = matchers.filter((m) => m && typeof m === "object");
    }
  }
  return rules;
}

export function backfillEvidenceNeed(phase) {
  return EVIDENCE_NEEDS[phase] || `trace evidence configured in story_backfill.evidence.${phase}`;
}

function eventTime(event) {
  const value = Date.parse(String(event?.created_at || event?.timestamp || ""));
  return Number.isFinite(value) ? value : null;
}

export function eventMatchesPhase(event, phase, rules) {
  return (rules[phase] || []).some((matcher) =>
    ["type", "action", "outcome"].every((key) => matcher[key] === undefined
      || (matcher[key] === null ? event?.[key] == null : event?.[key] === matcher[key])));
}

/** The time a completed step counts at: its effective time when backfilled. */
export function stepEffectiveAt(record) {
  return record?.completion_mode === BACKFILL_MODE && record.effective_at
    ? record.effective_at
    : record?.completed_at;
}

export function readStoryTraceEventsRaw(sdlcRoot, storyId) {
  let text = "";
  try {
    text = fs.readFileSync(path.join(sdlcRoot, "traces", `${storyId}.jsonl`), "utf8");
  } catch {
    return [];
  }
  return text.split(/\r?\n/u).filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function evidenceRef(event) {
  return {
    trace_event_id: event.id,
    type: event.type || null,
    action: event.action || null,
    outcome: event.outcome || null,
    at: new Date(eventTime(event)).toISOString(),
    summary: String(event.summary || "").slice(0, 200),
    ...(event.git?.head_sha ? { head_sha: event.git.head_sha } : {}),
  };
}

/**
 * Plan the backfill of every skipped phase. A phase is skipped when it is not
 * completed and a later phase is completed, or the workflow already moved past
 * it. Phases are planned from the last to the first, so each one takes only
 * evidence older than the phase that follows it.
 *
 * Returns { candidates: [{ phase, effective_at, boundary_phase, boundary_at, evidence_refs }],
 *           missing: [{ phase, need, boundary_phase, boundary_at }] }.
 */
export function planStoryBackfill({ phaseOrder, steps, traceEvents, config = {}, workflowPhase = null }) {
  const rules = backfillEvidenceRules(config);
  const completed = new Map();
  for (const record of steps) {
    if (record?.status !== "completed") continue;
    const at = Date.parse(String(stepEffectiveAt(record) || ""));
    if (!Number.isFinite(at)) continue;
    const current = completed.get(record.phase);
    if (current === undefined || at < current) completed.set(record.phase, at);
  }
  const lastCompletedIndex = Math.max(-1, ...phaseOrder.map((phase, index) => (completed.has(phase) ? index : -1)));
  const workflowIndex = workflowPhase ? phaseOrder.indexOf(workflowPhase) : -1;
  const horizon = Math.max(lastCompletedIndex, workflowIndex);
  const candidates = [];
  const missing = [];
  let boundary = null;
  let boundaryPhase = null;
  for (let index = phaseOrder.length - 1; index >= 0; index -= 1) {
    const phase = phaseOrder[index];
    if (completed.has(phase)) {
      const at = completed.get(phase);
      if (boundary === null || at < boundary) {
        boundary = at;
        boundaryPhase = phase;
      }
      continue;
    }
    if (index >= horizon || !rules[phase]) continue;
    const evidence = traceEvents
      .filter((event) => event?.id && eventMatchesPhase(event, phase, rules))
      .filter((event) => {
        const at = eventTime(event);
        return at !== null && (boundary === null || at <= boundary);
      })
      .sort((left, right) => eventTime(left) - eventTime(right));
    const boundaryAt = boundary === null ? null : new Date(boundary).toISOString();
    if (evidence.length === 0) {
      missing.push({ phase, need: backfillEvidenceNeed(phase), boundary_phase: boundaryPhase, boundary_at: boundaryAt });
      continue;
    }
    const effective = eventTime(evidence.at(-1));
    candidates.unshift({
      phase,
      effective_at: new Date(effective).toISOString(),
      boundary_phase: boundaryPhase,
      boundary_at: boundaryAt,
      evidence_refs: evidence.slice(-10).map(evidenceRef),
    });
    boundary = effective;
    boundaryPhase = phase;
  }
  return { candidates, missing: missing.reverse() };
}

/** Problems of one backfilled step record against the sealed trace; [] when sound. */
export function backfillRecordIssues(record, traceEvents, config = {}) {
  const rules = backfillEvidenceRules(config);
  const issues = [];
  const label = `backfilled step '${record.step}'`;
  if (!String(record.backfill?.reason || "").trim()) issues.push(`${label} has no reason`);
  const refs = Array.isArray(record.backfill?.evidence_refs) ? record.backfill.evidence_refs : [];
  if (refs.length === 0) issues.push(`${label} cites no evidence`);
  const byId = new Map(traceEvents.filter((event) => event?.id).map((event) => [event.id, event]));
  let latest = null;
  for (const ref of refs) {
    const event = byId.get(ref.trace_event_id);
    const at = event ? eventTime(event) : null;
    if (!event || at === null || at !== Date.parse(String(ref.at))) {
      issues.push(`${label} cites trace event ${ref.trace_event_id} that is not in the story trace`);
      continue;
    }
    if (!eventMatchesPhase(event, record.phase, rules)) {
      issues.push(`${label} cites trace event ${ref.trace_event_id} that is not evidence of phase '${record.phase}'`);
    }
    latest = latest === null ? at : Math.max(latest, at);
  }
  if (latest !== null && Date.parse(String(record.effective_at)) !== latest) {
    issues.push(`${label} effective_at must equal its latest evidence (${new Date(latest).toISOString()})`);
  }
  if (Date.parse(String(record.effective_at)) > Date.parse(String(record.completed_at))) {
    issues.push(`${label} effective_at is later than its recording`);
  }
  return issues;
}
