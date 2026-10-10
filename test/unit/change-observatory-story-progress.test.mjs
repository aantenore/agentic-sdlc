import assert from "node:assert/strict";
import test from "node:test";

import { buildNowModel } from "../../lib/change-observatory/now-panel.mjs";
import { channelIdentityFor, readStoryProgress, resolveStoryProgress } from "../../lib/change-observatory/story-progress.mjs";

const NOW = Date.parse("2026-10-10T11:00:00Z");
const at = (minutesAgo) => new Date(NOW - minutesAgo * 60_000).toISOString();
const base = { kind: "base", ref: "local base checkout" };
const codes = (result) => result.issues.map((issue) => issue.code).sort();

const CLAIM = {
  storyId: "ST-UX-003A",
  state: "claimed",
  agent: "pc2-claude-code",
  branch: "feature/ST-UX-003A",
  claimedAt: at(55),
  contractId: "contract-ST-UX-003A-implementation",
};

/** Fake read-only git: refs is a map ref -> { files: { path: text } , mergedInto?: bool }. */
function fakeGit(refs) {
  return (args) => {
    if (args[0] === "rev-parse") return { ok: Boolean(refs[args[3]]), stdout: "" };
    if (args[0] === "merge-base") return { ok: refs[args[2]]?.merged === true, stdout: "" };
    if (args[0] === "show") {
      const [ref, file] = args[1].split(":");
      const text = refs[ref]?.files?.[file];
      return text === undefined ? { ok: false, stdout: "" } : { ok: true, stdout: text };
    }
    return { ok: false, stdout: "" };
  };
}

test("the fresher claim contract wins over an old base checkpoint, and the gap is reported", () => {
  const result = resolveStoryProgress({
    claim: CLAIM,
    candidates: [
      { phase: "design", status: "draft", updatedAt: at(380), source: base },
      { phase: "discovery", updatedAt: at(380), source: base },
      { phase: "implementation", updatedAt: CLAIM.claimedAt, source: { kind: "claim", ref: CLAIM.contractId } },
    ],
    nowMs: NOW,
  });
  assert.equal(result.phase, "implementation");
  assert.equal(result.source.kind, "claim");
  assert.deepEqual(codes(result), ["phase-mismatch", "source-behind"]);
});

test("the story branch on the remote is preferred when it is newer than the base", () => {
  const story = (phase, updated) => JSON.stringify({ id: "ST-UX-003A", phase, status: "in_progress", updated_at: updated });
  const result = readStoryProgress("/nonexistent", { ...CLAIM, contractId: null }, {
    nowMs: NOW,
    git: fakeGit({ "refs/remotes/origin/feature/ST-UX-003A": { files: { ".sdlc/stories/ST-UX-003A/story.json": story("verification", at(3)) } } }),
  });
  assert.equal(result.phase, "verification");
  assert.deepEqual(result.source, { kind: "branch", ref: "origin/feature/ST-UX-003A" });
  assert.equal(result.since, at(3));
});

test("a claim whose branch is gone or merged is flagged", () => {
  const missing = readStoryProgress("/nonexistent", CLAIM, { nowMs: NOW, git: fakeGit({}) });
  assert.ok(codes(missing).includes("branch-missing"));
  const merged = readStoryProgress("/nonexistent", CLAIM, {
    nowMs: NOW,
    git: fakeGit({ "refs/remotes/origin/feature/ST-UX-003A": { merged: true, files: {} } }),
  });
  assert.ok(codes(merged).includes("branch-merged"));
});

test("a claim on a released story, an expired claim and an expired working marker are stale", () => {
  const result = resolveStoryProgress({
    claim: { ...CLAIM, expired: true, wait: { until: at(10) } },
    candidates: [{ phase: "release", status: "released", updatedAt: at(30), source: base }],
    nowMs: NOW,
  });
  assert.deepEqual(codes(result), ["claim-expired", "stale-claim", "working-marker-expired"]);
});

test("records dated in the future are not trusted as fresh", () => {
  const result = resolveStoryProgress({
    claim: { ...CLAIM, claimedAt: new Date(NOW + 3_600_000).toISOString() },
    candidates: [
      { phase: "release", updatedAt: new Date(NOW + 3_600_000).toISOString(), source: { kind: "branch", ref: "origin/x" } },
      { phase: "design", updatedAt: at(60), source: base },
    ],
    nowMs: NOW,
  });
  assert.equal(result.phase, "design");
  assert.deepEqual(codes(result), ["future-timestamp", "future-timestamp"]);
});

test("the panel shows the channel identity, the source, and marks double claims inconsistent", () => {
  const messages = [{ id: "m1", from: "vriso94", host: "pc-1203a2", kind: "info", story: "ST-UX-003A", text: "[auto] stato: ST-UX-003A in implementation", time: at(2) }];
  assert.equal(channelIdentityFor(CLAIM, messages), "vriso94 · pc-1203a2");
  const progress = new Map([["ST-UX-003A", resolveStoryProgress({
    claim: CLAIM,
    candidates: [{ phase: "implementation", updatedAt: CLAIM.claimedAt, source: { kind: "claim", ref: CLAIM.contractId } }],
    nowMs: NOW,
  })]]);
  const single = buildNowModel({ claims: [CLAIM], progress, messages, messaging: "on", nowMs: NOW }).work[0];
  assert.equal(single.who, "vriso94 · pc-1203a2");
  assert.equal(single.phase, "implementation");
  assert.equal(single.phaseSource.kind, "claim");
  assert.equal(single.freshness, "fresh");
  const twice = buildNowModel({ claims: [CLAIM, { ...CLAIM, agent: "pc1-codex" }], progress, nowMs: NOW }).work;
  assert.ok(twice.every((row) => row.freshness === "inconsistent" && row.issues.some((issue) => issue.code === "claimed-twice")));
});
