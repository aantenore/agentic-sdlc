import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { annotateIds, resetStoryLabelCache, storyLabel } from "../../lib/engine/story-label.mjs";
import { decideKeepGoing } from "../../lib/host-hooks/keep-going.mjs";

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "story-label-"));
  const write = (relative, value) => {
    const file = path.join(root, ".sdlc", relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  };
  write("stories/ST-A/story.json", { id: "ST-A", title: "Login page" });
  write("stories/ST-B/story.json", { id: "ST-B", summary: "Only a summary here" });
  write("stories/ST-C/story.json", { id: "ST-C", title: "A very long title that keeps going well past the sixty character limit set" });
  write("requirements/REQ-1.json", { id: "REQ-1", title: "Export data" });
  resetStoryLabelCache();
  return root;
}

test("storyLabel: title, summary fallback, requirement, missing ID, truncation", () => {
  const root = project();
  try {
    assert.equal(storyLabel(root, "ST-A"), "ST-A (Login page)");
    assert.equal(storyLabel(root, "ST-B"), "ST-B (Only a summary here)");
    assert.equal(storyLabel(root, "REQ-1"), "REQ-1 (Export data)");
    assert.equal(storyLabel(root, "ST-NONE"), "ST-NONE");
    const long = storyLabel(root, "ST-C");
    assert.match(long, /^ST-C \(.+…\)$/u);
    assert.ok(long.length <= "ST-C ()".length + 60);
    assert.equal(storyLabel(root, "ST-C", { AGENTIC_SDLC_LABEL_MAX_LENGTH: "20" }).length <= "ST-C ()".length + 20, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("annotateIds: first mention only, no double annotation, opt-out", () => {
  const root = project();
  try {
    assert.equal(annotateIds(root, "ST-A done, then ST-A again and REQ-1"), "ST-A (Login page) done, then ST-A again and REQ-1 (Export data)");
    assert.equal(annotateIds(root, "ST-A (already described) ok"), "ST-A (already described) ok");
    assert.equal(annotateIds(root, "ST-A ok", { AGENTIC_SDLC_LABEL_IDS: "0" }), "ST-A ok");
    assert.equal(annotateIds(root, "ST-NONE ok"), "ST-NONE ok");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("keep-going reason names the story with its description", () => {
  const root = project();
  try {
    const claims = [{ storyId: "ST-A", next: { label: "implementa", command: "agentic-sdlc status", phase: "implementation" } }];
    const decision = decideKeepGoing({ claims, label: (id) => storyLabel(root, id) });
    assert.match(decision.reason, /- ST-A \(Login page\): implementa -> `agentic-sdlc status`/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
