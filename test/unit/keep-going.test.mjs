import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { collectWork, decideKeepGoing, heldClaimRefs, MAX_IDENTICAL_BLOCKS, nextStoryStep, pendingQuestions, unpublishedRecords } from "../../lib/host-hooks/keep-going.mjs";

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

test("claims this clone cannot prove are not its work", async () => {
  const { collectWork } = await import("../../lib/host-hooks/keep-going.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "keep-going-claims-"));
  for (const id of ["ST-A", "ST-B"]) {
    fs.mkdirSync(path.join(root, ".sdlc", "stories", id), { recursive: true });
    fs.writeFileSync(path.join(root, ".sdlc", "stories", id, "claim.json"), JSON.stringify({ status: "active", story_id: id }));
  }
  assert.deepEqual(collectWork(root, {}).claims.map((c) => c.storyId), ["ST-A", "ST-B"]);
  const mine = collectWork(root, { ownsClaim: (claim) => claim.story_id === "ST-B" });
  assert.deepEqual(mine.claims.map((c) => c.storyId), ["ST-B"]);
});

test("claims of sibling worktrees are this computer's work; only truly free stories are available", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keep-going-worktrees-"));
  try {
    const main = path.join(dir, "main");
    const sibling = path.join(dir, "sibling");
    const put = (root, file, value) => {
      fs.mkdirSync(path.dirname(path.join(root, ".sdlc", file)), { recursive: true });
      fs.writeFileSync(path.join(root, ".sdlc", file), JSON.stringify(value));
    };
    const story = (id, extra = {}) => put(main, `stories/${id}/story.json`, { id, status: "ready", requirement_refs: [{ id: `REQ-${id}` }], ...extra });
    for (const id of ["ST-FREE", "ST-CLOSED", "ST-PARENT", "ST-PARENTA", "ST-OLD", "ST-HELD", "ST-DONE", "ST-MINE", "ST-ELSE"]) story(id);
    story("ST-OLD", { requirement_refs: [{ id: "REQ-OLD" }] });
    put(main, "requirements/REQ-OLD.json", { id: "REQ-OLD", logical_id: "REQ-OLD", revision: 1 });
    put(main, "requirements/REQ-OLD-R2.json", { id: "REQ-OLD-R2", logical_id: "REQ-OLD", revision: 2 });
    put(main, "stories/ST-CLOSED/closure.json", { status: "superseded" });
    put(main, "reports/ST-DONE-lifecycle-complete.json", {});
    put(sibling, "stories/ST-MINE/claim.json", { story_id: "ST-MINE", status: "active" });
    put(sibling, "stories/ST-MINE/steps/discovery.json", { status: "completed" });
    put(sibling, "stories/ST-ELSE/claim.json", { story_id: "ST-ELSE", status: "active", shared_claim: { scope: "shared" } });
    const work = collectWork(main, {
      roots: [main, sibling],
      ownsClaim: (claim) => claim.story_id !== "ST-ELSE",
      heldRefs: new Set(["ST-HELD"]),
      base: { closed: ["ST-FREE-GONE"], claims: [{ claim: { story_id: "ST-BASE", status: "active" }, completedSteps: [] }] },
    });
    assert.deepEqual(work.claims.map((c) => c.storyId), ["ST-BASE", "ST-MINE"]);
    assert.match(work.claims[1].next.command, /--step analysis/u);
    assert.deepEqual(work.available, ["ST-FREE", "ST-PARENTA"]);
    assert.equal(decideKeepGoing({ available: work.available }).block, true);
    assert.equal(decideKeepGoing({ available: [] }).block, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("claim refs: a story is held while its latest claim has no release", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keep-going-refs-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main", dir]);
    const git = (...args) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" } }).toString().trim();
    git("commit", "-q", "--allow-empty", "-m", "x");
    const head = git("rev-parse", "HEAD");
    const base = "refs/agentic-sdlc-shared/claims/0123456789abcdef";
    for (const ref of ["ST-A/000001/claim", "ST-A/000001/release", "ST-B/000001/claim", "ST-B/000001/release", "ST-B/000002/claim", "ST-C/000001/claim"]) git("update-ref", `${base}/${ref}`, head);
    assert.deepEqual([...heldClaimRefs(dir)].sort(), ["ST-B", "ST-C"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
