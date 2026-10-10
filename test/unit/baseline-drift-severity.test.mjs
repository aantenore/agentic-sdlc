import assert from "node:assert/strict";
import test from "node:test";

import { staleBaselineSeverity, taskStartBaselineDriftVerdict } from "../../lib/engine/story.mjs";

const base = { scope: "story", strict: true, active: true, status: "approved", declaredByStory: false };

test("story scope: baseline drift is a warning, also in strict mode", () => {
  assert.equal(staleBaselineSeverity(base), "warnings");
});

test("project scope: baseline drift stays a blocker in strict mode", () => {
  assert.equal(staleBaselineSeverity({ ...base, scope: "project" }), "errors");
  assert.equal(staleBaselineSeverity({ ...base, scope: "project", strict: false }), "warnings");
});

test("story that declares the baseline as context source keeps the blocker", () => {
  assert.equal(staleBaselineSeverity({ ...base, declaredByStory: true }), "errors");
});

test("task start: drift fully explained by delivered stories is a warning", () => {
  const rawIssues = ["baseline B source a.js is missing or changed"];
  assert.equal(taskStartBaselineDriftVerdict({ rawIssues, unexplainedIssues: [] }), "warning");
  assert.equal(taskStartBaselineDriftVerdict({ rawIssues: [], unexplainedIssues: [] }), "ready");
});

test("task start: unattributed changes or a declared baseline keep the blocker", () => {
  const rawIssues = ["a", "b"];
  assert.equal(taskStartBaselineDriftVerdict({ rawIssues, unexplainedIssues: ["b"] }), "blocked");
  assert.equal(taskStartBaselineDriftVerdict({ rawIssues, unexplainedIssues: [], declaredByStory: true }), "blocked");
});
