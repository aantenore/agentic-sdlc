import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildObservatoryViewModel } from "../../lib/change-observatory/index.mjs";
import { deriveStoryLifecycle } from "../../lib/change-observatory/story-progress.mjs";
import { checkoutBehindBase } from "../../lib/change-observatory/shared-ref-source.mjs";
import { storyInsights, storyStatus } from "../../ui/change-observatory/insights.js";
import { setLocale } from "../../ui/change-observatory/i18n.js";
import { staleCheckoutMessage } from "../../ui/change-observatory/source-freshness.js";

const FIXED_TIME = "2026-10-10T09:00:00.000Z";
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

async function writeFile(root, relativePath, content) {
  const target = path.join(root, ...relativePath.split("/"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
}

test("lifecycle precedence: closure > closed > merged > pull request > in progress > not started", () => {
  const all = {
    closureEvent: "superseded", finalGatePassed: true, workflowState: "operations",
    deliveryState: "merged", taskStarted: true, claimed: true, receipts: 3,
  };
  assert.equal(deriveStoryLifecycle(all).key, "superseded");
  assert.equal(deriveStoryLifecycle({ ...all, closureEvent: "cancelled" }).key, "abandoned");
  assert.equal(deriveStoryLifecycle({ ...all, closureEvent: null }).key, "closed");
  assert.equal(deriveStoryLifecycle({ ...all, closureEvent: null, finalGatePassed: false }).evidence, "workflow");
  assert.equal(deriveStoryLifecycle({ ...all, closureEvent: null, finalGatePassed: false, workflowState: "release" }).key, "merged");
  assert.equal(deriveStoryLifecycle({ deliveryState: "open", taskStarted: true }).key, "prOpen");
  assert.equal(deriveStoryLifecycle({ taskStarted: true }).key, "inProgress");
  assert.equal(deriveStoryLifecycle({ claimed: true }).key, "inProgress");
  assert.equal(deriveStoryLifecycle({ receipts: 1 }).key, "inProgress");
  assert.equal(deriveStoryLifecycle({}).key, "notStarted");
});

test("closed stories whose story.json still says ready/design are never shown as not started", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "change-observatory-lifecycle-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeFile(root, ".sdlc/project.json", json({ schema_version: "0.1.0", project_id: "life", project_name: "Life" }));
  const story = (id) => writeFile(root, `.sdlc/stories/${id}/story.json`, json({ id, title: `Story ${id}`, status: "ready", phase: "design" }));
  const taskStart = (id) => writeFile(root, `.sdlc/stories/${id}/task-start.json`, json({ story_id: id, phase: "design", status: "confirmed", created_at: "2026-10-10T01:00:00.000Z" }));
  for (const id of ["ST-WF", "ST-MRG", "ST-TS", "ST-NONE"]) await story(id);
  for (const id of ["ST-WF", "ST-MRG", "ST-TS"]) await taskStart(id);
  await writeFile(root, ".sdlc/workflows/instances/DELIVERY-ST-WF/checkpoint.json", json({
    kind: "workflow_checkpoint", instance_id: "DELIVERY-ST-WF", current_state: "operations", updated_at: "2026-10-10T02:00:00.000Z",
  }));
  await writeFile(root, ".sdlc/traces/ST-MRG.jsonl", `${JSON.stringify({
    id: "TR-MRG", story_id: "ST-MRG", action: "pull_request.merge", outcome: "passed", created_at: "2026-10-10T02:00:00.000Z",
  })}\n`);

  const model = await buildObservatoryViewModel(root, { clock: () => new Date(FIXED_TIME) });
  const byId = new Map(model.iterations.map((iteration) => [iteration.id, iteration]));
  assert.deepEqual(["ST-WF", "ST-MRG", "ST-TS", "ST-NONE"].map((id) => byId.get(id).lifecycle.key),
    ["closed", "merged", "inProgress", "notStarted"]);

  const stories = new Map(storyInsights(model).map((item) => [item.id, item]));
  setLocale("it");
  try {
    assert.deepEqual(["ST-WF", "ST-MRG", "ST-TS", "ST-NONE"].map((id) => storyStatus(stories.get(id)).label),
      ["Chiusa", "Unita, chiusura in corso", "In corso", "Non iniziata"]);
  } finally {
    setLocale("en");
  }
  assert.equal(storyStatus(stories.get("ST-WF")).label, "Closed");
});

test("a local checkout behind its base shows a stale-data warning", () => {
  const git = (behind) => () => ({ ok: true, stdout: `${behind}\n` });
  const resolveBase = () => ({ ref: "refs/remotes/origin/main", name: "origin/main" });
  assert.deepEqual(checkoutBehindBase("/x", { git: git(7), resolveBase }), { base: "origin/main", behind: 7 });
  assert.equal(checkoutBehindBase("/x", { git: git(0), resolveBase: () => null }), null);
  assert.equal(checkoutBehindBase("/x", { git: () => ({ ok: false, stdout: "" }), resolveBase }), null);

  setLocale("it");
  try {
    assert.equal(staleCheckoutMessage({ mode: "worktree", base: "main", behind: 12 }),
      "Questa vista è indietro di 12 commit rispetto a main: i dati possono essere vecchi");
  } finally {
    setLocale("en");
  }
  assert.equal(staleCheckoutMessage({ mode: "worktree", base: "origin/main", behind: 1 }),
    "This view is 1 commit behind origin/main: the data may be old");
  assert.equal(staleCheckoutMessage({ mode: "worktree", behind: 0 }), null);
  assert.equal(staleCheckoutMessage({ mode: "ref", behind: 4 }), null);
  assert.equal(staleCheckoutMessage({ mode: "worktree" }), null);
});
