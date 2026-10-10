import assert from "node:assert/strict";
import test from "node:test";

import {
  appendOnlyRecordPaths,
  autoPublishEnabled,
  autoPublishEvent,
  classifySyncConflicts,
  identicalUntrackedFiles,
  isOwnStoryRecordPath,
  localRecordExtendsBase,
  pathInWritePaths,
  reapplyDecision,
  selectHandoffFiles,
  unionOutputRegistries,
  writePathPrefix,
} from "../../lib/story-sync-plan.mjs";

test("registry union keeps every entry of both sides, deduplicated by JSON content", () => {
  const remote = {
    schema_version: "1",
    updated_at: "2026-01-02",
    links: [{ id: "L1", path: "a.md" }, { id: "L2", path: "b.md" }],
    decisions: [],
    templates: [{ id: "T1" }],
  };
  const local = {
    schema_version: "1",
    updated_at: "2026-01-03",
    links: [{ path: "b.md", id: "L2" }, { id: "L3", path: "c.md" }],
    decisions: [{ id: "D1" }],
    templates: [{ id: "T1" }],
  };
  const { registry, changed, added } = unionOutputRegistries(local, remote);
  assert.deepEqual(registry.links.map((entry) => entry.id), ["L1", "L2", "L3"]);
  assert.deepEqual(registry.decisions, [{ id: "D1" }]);
  assert.deepEqual(registry.templates, [{ id: "T1" }]);
  assert.equal(registry.updated_at, "2026-01-03");
  assert.equal(changed, true);
  assert.deepEqual(added, { links: 1, decisions: 1 });
});

test("registry union never drops a local link changed on one side", () => {
  const remote = { links: [{ id: "L1", path: "a.md", status: "approved" }] };
  const local = { links: [{ id: "L1", path: "a.md", status: "draft" }] };
  const { registry } = unionOutputRegistries(local, remote);
  assert.equal(registry.links.length, 2);
  assert.deepEqual(unionOutputRegistries(remote, remote), { registry: { ...remote }, changed: false, added: {} });
  assert.equal(unionOutputRegistries(null, remote).registry, remote);
  assert.equal(unionOutputRegistries(local, null).registry, local);
});

test("write path prefixes match folders and files, not neighbours", () => {
  assert.equal(writePathPrefix("src/app/**"), "src/app");
  assert.equal(writePathPrefix("./docs/"), "docs");
  assert.equal(pathInWritePaths("src/app/x.ts", ["src/app/**"]), true);
  assert.equal(pathInWritePaths("src/application/x.ts", ["src/app/**"]), false);
  assert.equal(pathInWritePaths("README.md", ["README.md"]), true);
  assert.equal(pathInWritePaths("anything", ["**"]), false);
  assert.equal(pathInWritePaths("src\\app\\y.ts", ["src/app"]), true);
});

test("handoff selection takes story records and write-path files only", () => {
  const { include, exclude } = selectHandoffFiles([
    "src/app/x.ts",
    "notes.txt",
    ".DS_Store",
    ".sdlc/stories/ST-A-001/claim.json",
    ".sdlc/stories/ST-B-001/claim.json",
    ".sdlc/config.json",
    ".sdlc/traces/project.jsonl",
    "src/app/x.ts",
  ], { storyId: "ST-A-001", storyIds: ["ST-A-001", "ST-B-001"], writePaths: ["src/app/**"] });
  assert.deepEqual(include, [".sdlc/stories/ST-A-001/claim.json", ".sdlc/traces/project.jsonl", "src/app/x.ts"]);
  assert.deepEqual(exclude, [
    { path: ".DS_Store", reason: "outside_write_paths" },
    { path: ".sdlc/config.json", reason: "project_configuration_or_cache" },
    { path: ".sdlc/stories/ST-B-001/claim.json", reason: "other_story_record" },
    { path: "notes.txt", reason: "outside_write_paths" },
  ]);
});

test("sync conflicts on the history and registry are rebuilt, others block", () => {
  const [trace, checkpoint] = appendOnlyRecordPaths();
  assert.deepEqual(classifySyncConflicts([trace, "src/a.ts", ".sdlc/output-contracts/registry.json", checkpoint]), {
    automatic: [".sdlc/output-contracts/registry.json", checkpoint, trace],
    blocking: ["src/a.ts"],
  });
  assert.deepEqual(classifySyncConflicts([".records/traces/project.jsonl"], ".records").automatic, [".records/traces/project.jsonl"]);
});

test("local records are re-applied only where the base did not change them", () => {
  const decide = (blobs) => reapplyDecision(".sdlc/stories/ST-A-001/steps/x.json", blobs);
  assert.equal(decide({ localBlob: "l", oldHeadBlob: "o", newHeadBlob: "o" }), "reapply");
  assert.equal(decide({ localBlob: "l", oldHeadBlob: null, newHeadBlob: null }), "reapply");
  assert.equal(decide({ localBlob: "n", oldHeadBlob: "o", newHeadBlob: "n" }), "same");
  assert.equal(decide({ localBlob: "o", oldHeadBlob: "o", newHeadBlob: "n" }), "same");
  assert.equal(decide({ localBlob: "l", oldHeadBlob: "o", newHeadBlob: "n" }), "conflict");
  assert.equal(reapplyDecision(".sdlc/traces/project.jsonl", { localBlob: "l", oldHeadBlob: "o", newHeadBlob: "n" }), "rebuilt");
});

test("only untracked copies identical to the base are dropped", () => {
  assert.deepEqual(identicalUntrackedFiles([
    { path: "b.ts", localBlob: "1", baseBlob: "1" },
    { path: "a.ts", localBlob: "1", baseBlob: "2" },
    { path: "c.ts", localBlob: null, baseBlob: null },
  ]), ["b.ts"]);
});

test("records are published after a passed merge completion or final gate, unless switched off", () => {
  assert.equal(autoPublishEvent("autonomy.delivery.action", { action: "pull_request.merge", outcome: "passed" }), "pull_request.merge");
  assert.equal(autoPublishEvent("autonomy.delivery.action", { action: "pull_request.merge", outcome: "failed" }), null);
  assert.equal(autoPublishEvent("autonomy.delivery.action", { action: "git.push", outcome: "passed" }), null);
  assert.equal(autoPublishEvent("gate.check", { "lifecycle-complete": true, story: "ST-A-001" }), "lifecycle-complete");
  assert.equal(autoPublishEvent("gate.check", { "lifecycle-complete": true, story: "ST-A-001" }, 1), null);
  assert.equal(autoPublishEvent("gate.check", { strict: true, story: "ST-A-001" }), null);
  assert.equal(autoPublishEnabled({}), true);
  assert.equal(autoPublishEnabled({ AGENTIC_SDLC_AUTO_PUBLISH: "off" }), false);
  assert.equal(autoPublishEnabled({ AGENTIC_SDLC_AUTO_PUBLISH: "0" }), false);
});

test("a story's own records stay local when they extend or supersede the base copy", () => {
  const options = { storyId: "ST-X", storyIds: ["ST-X", "ST-Y"] };
  for (const own of [".sdlc/stories/ST-X/claim.json", ".sdlc/traces/ST-X.jsonl", ".sdlc/workflows/instances/DELIVERY-ST-X/state.json",
    ".sdlc/autonomy/executions/AUT-PR-X/run.json", ".sdlc/gates/ST-X-final.json", ".sdlc/tests/ST-X-unit.json"]) {
    assert.equal(isOwnStoryRecordPath(own, options), true, own);
  }
  assert.equal(isOwnStoryRecordPath(".sdlc/stories/ST-Y/claim.json", options), false);
  assert.equal(isOwnStoryRecordPath(".sdlc/contracts/shared.json", options), false);
  assert.equal(localRecordExtendsBase('{"a":1}\n{"b":2}\n', '{"a":1}\n'), true);
  assert.equal(localRecordExtendsBase('{"a":1}\n', '{"a":1}\n{"b":2}\n'), false);
  assert.equal(localRecordExtendsBase('{"a":9}\n{"c":3}\n', '{"a":1}\n'), false);
  assert.equal(localRecordExtendsBase('{"new_writes":{"count":5}}', '{"new_writes":{"count":3}}'), true);
  assert.equal(localRecordExtendsBase('{"new_writes":{"count":2}}', '{"new_writes":{"count":3}}'), false);
  assert.equal(localRecordExtendsBase('{"s":"b","updated_at":"2026-02-01"}', '{"s":"a","updated_at":"2026-01-01"}'), true);
  assert.equal(localRecordExtendsBase('{"s":"b","updated_at":"2026-01-01"}', '{"s":"a","updated_at":"2026-02-01"}'), false);
  assert.equal(localRecordExtendsBase(null, "x"), false);
  const decide = (extra) => reapplyDecision(".sdlc/stories/ST-X/claim.json", { localBlob: "l", oldHeadBlob: null, newHeadBlob: "n", ...extra });
  assert.equal(decide({}), "conflict");
  assert.equal(decide({ ownExtends: true }), "reapply");
});
