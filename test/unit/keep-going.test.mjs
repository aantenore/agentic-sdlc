import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { decideKeepGoing, MAX_IDENTICAL_BLOCKS, nextStoryStep, pendingQuestions, unpublishedRecords } from "../../lib/host-hooks/keep-going.mjs";

const claim = { storyId: "ST-1", next: nextStoryStep({ storyId: "ST-1", completedSteps: ["discovery", "analysis", "design", "implementation"] }) };

test("next step follows the lifecycle, then the strict gate", () => {
  assert.match(claim.next.command, /complete-step --id ST-1 --step validation/u);
  const all = ["discovery", "analysis", "design", "implementation", "validation", "release", "operations"];
  assert.match(nextStoryStep({ storyId: "ST-1", completedSteps: all }).command, /gate check --story ST-1 .*--strict --lifecycle-complete/u);
});

test("blocks with the next step while there is work, stays silent without work", () => {
  const blocked = decideKeepGoing({ claims: [claim] });
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /ST-1/u);
  assert.equal(decideKeepGoing({}).block, false);
  assert.equal(decideKeepGoing({ claims: [claim], disabled: true }).block, false);
});

test("human decisions never block, they are only mentioned", () => {
  const result = decideKeepGoing({ human: ["claim di ST-2 scaduta"] });
  assert.equal(result.block, false);
  assert.match(result.note, /ST-2/u);
});

test("available stories only when no claim or question", () => {
  assert.match(decideKeepGoing({ available: ["ST-3"] }).reason, /ST-3/u);
  assert.doesNotMatch(decideKeepGoing({ claims: [claim], available: ["ST-3"] }).reason, /ST-3/u);
});

test("allows the stop after identical consecutive blocks", () => {
  let state = {};
  const blocks = [];
  for (let index = 0; index < MAX_IDENTICAL_BLOCKS + 1; index += 1) {
    const result = decideKeepGoing({ claims: [claim], previous: state, stopHookActive: index > 0 });
    blocks.push(result.block);
    state = result.state;
  }
  assert.deepEqual(blocks, [...Array(MAX_IDENTICAL_BLOCKS).fill(true), false]);
  assert.equal(decideKeepGoing({ claims: [claim], previous: state, stopHookActive: false }).block, true);
});

test("pending questions are those to this computer not yet answered", () => {
  const state = { own: [], attention: { window: [
    { id: "a", kind: "question", from: "pc-2", text: "pronto?" },
    { id: "b", kind: "question", from: "pc-2", to: "pc-3", text: "altro" },
    { id: "c", kind: "request", from: "pc-2", text: "fatto" },
    { id: "d", kind: "answer", from: "pc-1", reply_to: "c" },
  ] } };
  assert.deepEqual(pendingQuestions(state, "pc-1").map((q) => q.id), ["a"]);
});

test("unpublished records: local .sdlc changes of a story not on the remote base come first", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keep-going-unpublished-"));
  try {
    const remote = path.join(dir, "remote.git");
    const root = path.join(dir, "clone");
    const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" } }).toString();
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
    execFileSync("git", ["init", "-q", "-b", "main", root]);
    git(root, "remote", "add", "origin", remote);
    const write = (file, text) => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    };
    write(".sdlc/stories/ST-1/story.json", "{}\n");
    write(".sdlc/stories/ST-2/story.json", "{}\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "base");
    git(root, "push", "-q", "origin", "main");
    git(root, "remote", "set-head", "origin", "main");
    assert.deepEqual(unpublishedRecords(root), []);

    write(".sdlc/gates/ST-1-final.json", "{}\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "final gate");
    write(".sdlc/stories/ST-2/steps/design.json", "{}\n");
    const found = unpublishedRecords(root);
    assert.deepEqual(found.map((item) => [item.storyId, item.files]), [
      ["ST-1", [".sdlc/gates/ST-1-final.json"]],
      ["ST-2", [".sdlc/stories/ST-2/steps/design.json"]],
    ]);
    assert.equal(found[0].base, "origin/main");
    assert.match(found[0].command, /story publish-records --id ST-1 --to-base/u);

    const decision = decideKeepGoing({ unpublished: found, claims: [claim] });
    assert.equal(decision.block, true);
    assert.match(decision.reason.split("\n")[1], /ST-1: record non pubblicati/u);

    git(root, "push", "-q", "origin", "main");
    assert.deepEqual(unpublishedRecords(root).map((item) => item.storyId), ["ST-2"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
