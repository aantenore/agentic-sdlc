import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildObservatoryViewModel } from "../../lib/change-observatory/index.mjs";
import { applyDependencies, checkOutcome, storyStatus } from "../../ui/change-observatory/insights.js";
import { setLocale } from "../../ui/change-observatory/i18n.js";
import { iterationRelevance, normalizeViewModel } from "../../ui/change-observatory/model.js";

const FIXED_TIME = "2026-10-10T18:00:00.000Z";

async function write(root, relativePath, value) {
  const target = path.join(root, ...relativePath.split("/"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  const text = typeof value === "string"
    ? value
    : Array.isArray(value)
      ? `${value.map((entry) => JSON.stringify(entry)).join("\n")}\n`
      : `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(target, text, "utf8");
}

async function project(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "change-observatory-brief-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await write(root, ".sdlc/project.json", { schema_version: "0.1.0", project_id: "brief", project_name: "Brief" });
  return root;
}

const trace = (fields) => ({ story_id: "ST-A", created_at: "2026-10-10T10:00:00.000Z", ...fields });

async function deliveredStory(root) {
  await write(root, ".sdlc/requirements/REQ-A.json", {
    schema_version: "requirement:v1", id: "REQ-A", title: "Day map", summary: "Show the day on a map.",
  });
  await write(root, ".sdlc/stories/ST-A/story.json", {
    schema_version: "0.1.0",
    id: "ST-A",
    title: "Map tiles without 403",
    status: "ready",
    phase: "design",
    links: { requirements: ["REQ-A"] },
    audit: {
      created_by: { id: "agent", type: "agent", name: "Claude Code" },
      git: { user: { name: "Antonio Antenore", email: "someone@example.com" } },
    },
  });
  await write(root, ".sdlc/stories/ST-A/claim.json", { story_id: "ST-A", agent: "pc3", status: "released" });
  await write(root, ".sdlc/stories/ST-A/evidence/merge.json", {
    number: 70,
    url: "https://github.com/example/app/pull/70",
    headRefName: "feature/ST-A",
    mergeCommit: { oid: "65737682de838def045249fdffc7200083ce7620" },
    mergedAt: "2026-10-10T15:50:54Z",
    state: "MERGED",
  });
  await write(root, ".sdlc/tests/ST-A-run-1.json", {
    kind: "test_run", id: "ST-A-run-1", story_id: "ST-A", summary: "Unit suite", outcome: "passed",
    totals: { passed: 12, failed: 0, skipped: 0 }, created_at: "2026-10-10T11:00:00.000Z",
  });
  await write(root, ".sdlc/tests/ST-A-run-2.json", {
    kind: "test_run", id: "ST-A-run-2", story_id: "ST-A", summary: "Browser check", outcome: "blocked",
    created_at: "2026-10-10T11:01:00.000Z",
  });
  await write(root, ".sdlc/traces/ST-A.jsonl", [
    trace({ id: "TR-1", type: "test", action: "test.record", summary: "Unit suite", outcome: "passed", evidence: [".sdlc/tests/ST-A-run-1.json"] }),
    trace({ id: "TR-2", type: "test", action: "test.record", summary: "Browser check", outcome: "blocked", evidence: [".sdlc/tests/ST-A-run-2.json"] }),
    trace({ id: "TR-3", type: "test", action: "test.record", summary: "Manual check", outcome: "failed-minor" }),
    trace({ id: "TR-4", type: "gate", action: "autonomy.delivery.approve", summary: "Approved", actor: { type: "human", name: "Alice Gibellato" } }),
    trace({ id: "TR-5", type: "gate", action: "pull_request.create", outcome: "passed", summary: "Completed pull_request.create", git: { branch: "feature/ST-A" } }),
    trace({ id: "TR-6", type: "gate", action: "pull_request.merge", outcome: "passed", summary: "Completed pull_request.merge", evidence: [".sdlc/stories/ST-A/evidence/merge.json"], created_at: "2026-10-10T15:51:00.000Z" }),
  ]);
}

test("the story brief reads what was asked, the merged pull request, the checks and who", async (t) => {
  const root = await project(t);
  await deliveredStory(root);
  const model = await buildObservatoryViewModel(root, { clock: () => new Date(FIXED_TIME) });
  const story = model.iterations.find((iteration) => iteration.id === "ST-A");

  assert.deepEqual(story.brief.asked, {
    title: "Map tiles without 403",
    summary: "Show the day on a map.",
    requirementId: "REQ-A",
    requirementTitle: "Day map",
  });
  assert.equal(story.brief.delivery.state, "merged");
  assert.equal(story.brief.delivery.number, 70);
  assert.equal(story.brief.delivery.mergeSha, "65737682de838def045249fdffc7200083ce7620");
  assert.equal(story.brief.delivery.branch, "feature/ST-A");
  assert.equal(story.brief.delivery.at, "2026-10-10T15:50:54.000Z");
  // Two traces cite their test-run records, so each check counts once.
  assert.deepEqual(story.brief.tests, { passed: 1, failed: 1, notRun: 1, total: 3 });
  assert.deepEqual(story.brief.who, {
    person: "Antonio Antenore", agent: "Claude Code", computer: "pc3", approvers: ["Alice Gibellato"],
  });
  assert.doesNotMatch(JSON.stringify(story.brief), /@example\.com/u);

  // A check that could not run does not block every phase of the story.
  assert.equal(story.phases.some((phase) => phase.status === "blocked"), false);

  // Each check appears once, with its verdict and counters.
  const checks = model.verification.filter((item) => item.storyId === "ST-A" && item.type !== "gate");
  assert.deepEqual(checks.map((item) => item.summary).sort(), ["Browser check", "Manual check", "Unit suite"]);
  const unit = checks.find((item) => item.summary === "Unit suite");
  assert.equal(unit.verdict, "passed");
  assert.deepEqual(unit.testTotals, { passed: 12, failed: 0, skipped: 0 });
  const verified = model.dossiers.find((dossier) => dossier.storyId === "ST-A").lanes.verified.items;
  assert.equal(verified.filter((item) => item.summary === "Unit suite").length, 1);

  // The browser reads a merged pull request as delivered and says so in one status.
  setLocale("en");
  const view = normalizeViewModel(model);
  const iteration = view.iterations.find((entry) => entry.id === "ST-A");
  assert.equal(iterationRelevance(iteration), "delivered");
  const status = storyStatus({ state: "delivered", iteration });
  assert.equal(status.label, "Merged");
  assert.match(status.reason, /^PR #70 merged on /u);
  assert.equal(checkOutcome({ status: "blocked" }), "notRun");
  assert.equal(checkOutcome({ status: "failed-minor" }), "failed");
});

test("every dossier keeps its evidence when the shared collection limit is small", async (t) => {
  const root = await project(t);
  for (const id of ["ST-A", "ST-B", "ST-C"]) {
    await write(root, `.sdlc/stories/${id}/story.json`, { schema_version: "0.1.0", id, title: `Story ${id}`, status: "ready" });
    await write(root, `.sdlc/traces/${id}.jsonl`, [1, 2, 3].map((n) => ({
      id: `TR-${id}-${n}`, story_id: id, type: "implementation", summary: `Change ${n}`,
    })));
  }
  const model = await buildObservatoryViewModel(root, {
    clock: () => new Date(FIXED_TIME),
    limits: { maxCollectionItems: 4, maxDossierItems: 100, maxDossierLaneItems: 2 },
  });
  for (const dossier of model.dossiers) {
    assert.equal(dossier.lanes.done.status, "recorded", dossier.storyId);
    assert.equal(dossier.lanes.done.items.length, 2, dossier.storyId);
    assert.equal(dossier.lanes.done.total, 3, dossier.storyId);
  }
});

test("a delivered or replaced prerequisite no longer holds a story up", () => {
  const stories = [
    { id: "ST-A", state: "idle", lastActivity: null },
    { id: "ST-B", state: "delivered", lastActivity: null },
    { id: "ST-C", state: "replaced", lastActivity: null },
    { id: "ST-D", state: "open", lastActivity: null },
  ];
  const edges = [
    { from: "ST-A", to: "ST-B" },
    { from: "ST-A", to: "ST-C" },
    { from: "ST-D", to: "ST-A" },
  ];
  const result = new Map(applyDependencies(stories, edges).map((story) => [story.id, story]));
  assert.equal(result.get("ST-A").state, "idle");
  assert.deepEqual(result.get("ST-A").waitingOn, []);
  assert.equal(result.get("ST-D").state, "waiting");
  assert.deepEqual(result.get("ST-D").waitingOn, ["ST-A"]);
});
