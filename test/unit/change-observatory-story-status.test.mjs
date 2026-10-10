import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildObservatoryViewModel } from "../../lib/change-observatory/index.mjs";
import { lifecycleEventsAfterCertification } from "../../lib/engine/certification-freshness.mjs";
import { storyInsights, storyStatus } from "../../ui/change-observatory/insights.js";
import { setLocale } from "../../ui/change-observatory/i18n.js";

const FIXED_TIME = "2026-10-10T09:00:00.000Z";

async function writeFile(root, relativePath, content) {
  const target = path.join(root, ...relativePath.split("/"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
}
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const lines = (values) => `${values.map((value) => JSON.stringify(value)).join("\n")}\n`;

async function writeStory(root, id, { finalAt = null, traces = [], released = true } = {}) {
  await writeFile(root, `.sdlc/stories/${id}/story.json`, json({
    id, title: `Story ${id}`, status: released ? "released" : "in_progress", phase: released ? "operations" : "implementation",
  }));
  if (released) {
    await writeFile(root, `.sdlc/stories/${id}/steps/release.json`, json({
      id: `STEP-${id}-release`, story_id: id, step: "release", phase: "release", status: "completed", completed_at: "2026-10-10T01:00:00.000Z",
    }));
  }
  if (traces.length) await writeFile(root, `.sdlc/traces/${id}.jsonl`, lines(traces.map((trace) => ({ story_id: id, ...trace }))));
  if (finalAt) {
    await writeFile(root, `.sdlc/gates/${id}-final.json`, json({
      kind: "workflow_final_gate_receipt", story_id: id, status: "passed", lifecycle_complete: true, checked_at: finalAt,
    }));
  }
}

test("certification freshness: later test or release records make the final report stale", () => {
  const events = [
    { type: "release", created_at: "2026-10-10T01:00:00.000Z" },
    { type: "gate", created_at: "2026-10-10T03:00:00.000Z" },
  ];
  assert.deepEqual(lifecycleEventsAfterCertification(events, "2026-10-10T02:00:00.000Z"), []);
  assert.equal(lifecycleEventsAfterCertification(events, "2026-10-10T00:30:00.000Z").length, 1);
  assert.equal(lifecycleEventsAfterCertification(events, "not a time"), null);
});

test("each story gets its status from the records: certified, to recertify, merged, in progress, parked, reserved", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "change-observatory-story-status-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeFile(root, ".sdlc/project.json", json({ schema_version: "0.1.0", project_id: "status", project_name: "Status" }));
  const release = { id: "TR-REL", type: "release", created_at: "2026-10-10T01:00:00.000Z" };
  await writeStory(root, "ST-CERT", { finalAt: "2026-10-10T02:00:00.000Z", traces: [release] });
  await writeStory(root, "ST-STALE", {
    finalAt: "2026-10-10T02:00:00.000Z",
    traces: [release, { id: "TR-REL-2", type: "release", created_at: "2026-10-10T03:00:00.000Z" }],
  });
  await writeStory(root, "ST-MERGED", { traces: [release] });
  await writeStory(root, "ST-LIVE", { released: false });
  await writeFile(root, ".sdlc/stories/ST-LIVE/claim.json", json({
    story_id: "ST-LIVE", status: "active", agent: "codex", expires_at: "2026-10-11T00:00:00.000Z",
  }));

  const model = await buildObservatoryViewModel(root, { clock: () => new Date(FIXED_TIME) });
  const byId = new Map(model.iterations.map((iteration) => [iteration.id, iteration]));
  assert.equal(byId.get("ST-CERT").certification.state, "current");
  assert.equal(byId.get("ST-STALE").certification.state, "stale");
  assert.equal(byId.get("ST-STALE").certification.newerRecord.id, "TR-REL-2");
  assert.equal(byId.get("ST-MERGED").certification, undefined);

  const stories = new Map(storyInsights(model).map((story) => [story.id, story]));
  setLocale("it");
  try {
    assert.deepEqual(
      ["ST-CERT", "ST-STALE", "ST-MERGED", "ST-LIVE"].map((id) => storyStatus(stories.get(id)).key),
      ["certified", "recertify", "merged", "live"],
    );
    assert.equal(storyStatus(stories.get("ST-CERT")).label, "Certificata");
    assert.equal(storyStatus(stories.get("ST-STALE")).label, "Certificazione da rifare");
    assert.match(storyStatus(stories.get("ST-STALE")).reason, /TR-REL-2/u);
    assert.equal(storyStatus(stories.get("ST-MERGED")).label, "Mergiata");
    assert.match(storyStatus(stories.get("ST-LIVE")).reason, /^Ora: /u);
    const base = { iteration: { id: "ST-X" }, phases: [] };
    assert.equal(storyStatus({ ...base, state: "parked", holder: { reason: "conflitto" } }).reason, "Messa da parte da una persona finché non viene ripresa: conflitto");
    assert.equal(storyStatus({ ...base, state: "idle", holder: { state: "reserved", agent: "codex", expired: false } }).label, "Prenotata");
  } finally {
    setLocale("en");
  }
  assert.equal(storyStatus(stories.get("ST-STALE")).label, "Certification to redo");
});
