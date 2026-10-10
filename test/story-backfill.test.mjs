import "./helpers/test-isolation.mjs";

import test from "node:test";
import assert from "node:assert/strict";

import { backfillRecordIssues, planStoryBackfill, stepEffectiveAt } from "../lib/engine/story-backfill.mjs";

const ORDER = ["discovery", "analysis", "design", "implementation", "validation", "release", "operations"];
const at = (minute) => `2026-10-10T12:${String(minute).padStart(2, "0")}:00.000Z`;
const TRACE = [
  { id: "TR-1", type: "gate", action: "contract.approve", outcome: "passed", created_at: at(1) },
  { id: "TR-2", type: "decision", action: "task.start.confirm", created_at: at(2) },
  { id: "TR-3", type: "gate", action: "git.commit", outcome: "passed", created_at: at(10) },
  { id: "TR-4", type: "decision", action: "output.link", created_at: at(11) },
  { id: "TR-5", type: "test", action: "test.record", outcome: "passed", created_at: at(12) },
  { id: "TR-6", type: "gate", action: "git.commit", outcome: "passed", created_at: at(40) },
];
const step = (phase, minute, extra = {}) => ({ story_id: "ST-1", step: phase, phase, status: "completed", completed_at: at(minute), ...extra });

function orderErrors(steps) {
  const ordered = ORDER.map((phase) => steps.find((record) => record.phase === phase)).filter(Boolean);
  return ordered.some((record, index) => index > 0
    && Date.parse(stepEffectiveAt(record)) < Date.parse(stepEffectiveAt(ordered[index - 1])));
}

test("backfill with evidence is planned from evidence older than the next phase, and the gate order passes", () => {
  const steps = [step("release", 30), step("operations", 31)];
  const plan = planStoryBackfill({ phaseOrder: ORDER, steps, traceEvents: TRACE });
  assert.deepEqual(plan.missing, []);
  const byPhase = Object.fromEntries(plan.candidates.map((entry) => [entry.phase, entry]));
  assert.equal(byPhase.validation.effective_at, at(12));
  // The commit at :40 came after release and is not evidence of implementation.
  assert.equal(byPhase.implementation.effective_at, at(10));
  assert.deepEqual(byPhase.implementation.evidence_refs.map((ref) => ref.trace_event_id), ["TR-3"]);
  assert.equal(byPhase.design.effective_at, at(2));
  // output.link is not planning evidence.
  assert.ok(!byPhase.design.evidence_refs.some((ref) => ref.trace_event_id === "TR-4"));

  // Recorded now, after release: without effective_at the order fails; with it the gate passes.
  const recorded = plan.candidates.map((entry) => step(entry.phase, 50, {
    completion_mode: "backfill",
    effective_at: entry.effective_at,
    backfill: { reason: "phase not recorded when done", evidence_refs: entry.evidence_refs },
  }));
  const all = [...steps, ...recorded];
  assert.equal(orderErrors(all), false);
  assert.equal(orderErrors(all.map(({ completion_mode, ...rest }) => rest)), true);
  for (const record of recorded) assert.deepEqual(backfillRecordIssues(record, TRACE), [], record.phase);
});

test("backfill without evidence of the phase is refused", () => {
  const trace = TRACE.filter((event) => event.action !== "git.commit");
  const plan = planStoryBackfill({ phaseOrder: ORDER, steps: [step("release", 30)], traceEvents: trace });
  assert.deepEqual(plan.missing.map((entry) => entry.phase), ["implementation"]);
  assert.match(plan.missing[0].need, /git\.commit/u);
  assert.ok(!plan.candidates.some((entry) => entry.phase === "implementation"));
  const noTests = planStoryBackfill({ phaseOrder: ORDER, steps: [step("release", 30)], traceEvents: TRACE.filter((event) => event.type !== "test") });
  assert.ok(noTests.missing.some((entry) => entry.phase === "validation"));
});

test("a backfilled record that cites unknown or wrong evidence fails the gate", () => {
  const forged = step("implementation", 50, {
    completion_mode: "backfill",
    effective_at: at(11),
    backfill: { reason: "x", evidence_refs: [{ trace_event_id: "TR-4", at: at(11) }, { trace_event_id: "TR-404", at: at(9) }] },
  });
  const issues = backfillRecordIssues(forged, TRACE);
  assert.ok(issues.some((issue) => /not evidence of phase 'implementation'/u.test(issue)));
  assert.ok(issues.some((issue) => /TR-404 that is not in the story trace/u.test(issue)));
  assert.ok(backfillRecordIssues({ ...forged, backfill: { reason: "", evidence_refs: [] } }, TRACE).some((issue) => /no reason/u.test(issue)));
});

test("phases not yet reached are not backfilled", () => {
  const plan = planStoryBackfill({ phaseOrder: ORDER, steps: [step("discovery", 1)], traceEvents: TRACE, workflowPhase: "analysis" });
  assert.deepEqual(plan.candidates, []);
  assert.deepEqual(plan.missing, []);
});

test("keep-going suggests recording a phase whose work already left evidence", async () => {
  const { nextStoryStep } = await import("../lib/host-hooks/keep-going.mjs");
  const next = nextStoryStep({ storyId: "ST-1", completedSteps: ["discovery", "analysis", "design"], evidencedPhases: ["implementation"] });
  assert.equal(next.phase, "implementation");
  assert.match(next.label, /ha gia' prove/u);
  assert.match(next.command, /story complete-step --id ST-1 --step implementation/u);
  const plain = nextStoryStep({ storyId: "ST-1", completedSteps: ["discovery", "analysis", "design"] });
  assert.doesNotMatch(plain.label, /prove/u);
});
