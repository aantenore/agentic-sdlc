import "../helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { claimOwnership, collectWork, decideKeepGoing, deliveryProgress, personRequests, withPersonRequest, withWorktreeProgress, isFreshForeignStory, heldClaimRefs, IDENTICAL_BLOCKS_WINDOW_MS, DEFAULT_MAX_CONSECUTIVE_BLOCKS, MAX_BLOCKS_ENV, maxConsecutiveBlocks, storyWorktreeResolver, nextStoryStep, pendingQuestions, unpublishedRecords } from "../../lib/host-hooks/keep-going.mjs";

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

test("dedupe: an identical list never blocks twice in a session, however much time passed", () => {
  const first = decideKeepGoing({ claims: [claim], session: "s1", now: 1000 });
  assert.equal(first.block, true);
  const later = decideKeepGoing({ claims: [claim], previous: first.state, session: "s1", now: 1000 + 10 * IDENTICAL_BLOCKS_WINDOW_MS });
  assert.equal(later.block, false);
  assert.match(later.note, /gia' segnalati, non blocco di nuovo/u);
  // Same list after a Stop without work: still not news.
  const empty = decideKeepGoing({ previous: later.state, session: "s1" });
  assert.equal(decideKeepGoing({ claims: [claim], previous: empty.state, session: "s1" }).block, false);
  // New content or a new session blocks again.
  assert.equal(decideKeepGoing({ claims: [claim, { ...claim, storyId: "ST-9" }], previous: later.state, session: "s1" }).block, true);
  assert.equal(decideKeepGoing({ claims: [claim], previous: later.state, session: "s2" }).block, true);
});

test("cap: the same set of items with changing text blocks at most maxBlocks times in a row per session", () => {
  const behind = (n) => ({ ...claim, next: { ...claim.next, phase: "release" }, behind: n });
  const run = (maxBlocks) => {
    let state = {};
    const blocks = [];
    for (let n = 1; n <= 4; n += 1) {
      // "indietro di N" is normalized away; the label changes so the text differs each time.
      const result = decideKeepGoing({ claims: [{ ...behind(n), next: { ...behind(n).next, label: `passo ${n}` } }], previous: state, session: "s1", maxBlocks });
      blocks.push(result.block);
      state = result.state;
    }
    return blocks;
  };
  assert.deepEqual(run(DEFAULT_MAX_CONSECUTIVE_BLOCKS), [true, true, false, false]);
  assert.deepEqual(run(3), [true, true, true, false]);
});

test("max consecutive blocks: env, then host_policy.keep_going, then the default", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keep-going-cap-"));
  try {
    assert.equal(maxConsecutiveBlocks(dir, {}), DEFAULT_MAX_CONSECUTIVE_BLOCKS);
    fs.mkdirSync(path.join(dir, ".sdlc"));
    fs.writeFileSync(path.join(dir, ".sdlc", "config.json"), JSON.stringify({ host_policy: { keep_going: { max_consecutive_blocks: 4 } } }));
    assert.equal(maxConsecutiveBlocks(dir, {}), 4);
    assert.equal(maxConsecutiveBlocks(dir, { [MAX_BLOCKS_ENV]: "1" }), 1);
    assert.equal(maxConsecutiveBlocks(dir, { [MAX_BLOCKS_ENV]: "x" }), 4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("priority: questions, unpublished, plugin update, claims, then available", () => {
  const reason = decideKeepGoing({
    claims: [claim],
    questions: [{ id: "q1", from: "pc-2", text: "ok?" }],
    unpublished: [{ storyId: "ST-1", base: "origin/main", files: ["a"], command: "publish" }],
    update: { version: "9.9.9", from: "pc-2" },
  }).reason.split("\n").slice(1);
  const order = ["rispondi", "record non pubblicati", "plugin 9.9.9", "completa"].map((word) => reason.findIndex((line) => line.includes(word)));
  assert.deepEqual(order, [0, 1, 2, 3]);
  assert.match(reason[2], /claude plugin update agentic-sdlc@aantenore/u);
  assert.match(reason[2], /priorita/u);
});

test("a waiting or delegated claim is not idle: parallel story and no blocking step", () => {
  const waiting = { ...claim, waiting: "dipendenza ST-0 non ancora mergiata" };
  const result = decideKeepGoing({ claims: [waiting], available: ["ST-5", "ST-6"], ready: ["ST-6"] });
  assert.equal(result.block, true);
  assert.match(result.reason, /lavora in parallelo su ST-6 -> `agentic-sdlc story claim --id ST-6/u);
  assert.doesNotMatch(result.reason, /complete-step/u);
  const none = decideKeepGoing({ claims: [waiting], available: ["ST-5"], ready: [] });
  assert.equal(none.block, false);
  assert.match(none.note, /in attesa/u);
  const delegated = decideKeepGoing({ claims: [{ ...claim, delegated: { until: "2099-01-01T00:00:00Z", reason: "subagente" } }] });
  assert.equal(delegated.block, false);
  assert.match(delegated.note, /delegato/u);
});

test("look-ahead reserves the next story at release; sync when behind the base", () => {
  const release = { storyId: "ST-1", next: nextStoryStep({ storyId: "ST-1", completedSteps: ["discovery", "analysis", "design", "implementation", "validation"] }) };
  const result = decideKeepGoing({ claims: [release], available: ["ST-7"], ready: ["ST-7"] });
  assert.match(result.reason, /story reserve --id ST-7/u);
  assert.doesNotMatch(decideKeepGoing({ claims: [claim], ready: ["ST-7"], available: ["ST-7"] }).reason, /story reserve/u);
  const behind = decideKeepGoing({ claims: [{ ...release, behind: 3 }] }).reason;
  assert.ok(behind.indexOf("story sync --id ST-1") < behind.indexOf("complete-step"));
});

test("collectWork: unmet dependency marks the claim waiting and the story not ready; working marker delegates", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keep-going-deps-"));
  const write = (rel, data) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), JSON.stringify(data));
  };
  for (const id of ["ST-A", "ST-B", "ST-C"]) write(`.sdlc/stories/${id}/story.json`, { id });
  write(".sdlc/stories/ST-A/claim.json", { status: "active", agent: "x" });
  write(".sdlc/dependencies/graph.json", { edges: [{ from: "ST-A", to: "ST-B", type: "blocks" }, { from: "ST-C", to: "ST-B", type: "blocks" }] });
  const work = collectWork(dir, { working: { "ST-A": { until: "2099-01-01T00:00:00Z" } } });
  assert.match(work.claims[0].waiting, /ST-B/u);
  assert.ok(work.claims[0].delegated);
  assert.deepEqual(work.available, ["ST-B", "ST-C"]);
  assert.deepEqual(work.ready, ["ST-B"]);
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

test("pending questions: host identity, manual names and answered reminders", () => {
  const state = { own: ["m1"], attention: { window: [
    { id: "m1", kind: "answer", from: "PC3", host: "pc-1", reply_to: "q" },
    { id: "q", kind: "question", from: "pc-2", host: "pc-2", text: "pronto?" },
    { id: "r", kind: "request", from: "pc-2", host: "pc-2", reply_to: "q", text: "[auto] reminder" },
    { id: "z", kind: "question", from: "pc-2", host: "pc-2", to: "PC3", text: "a me" },
    { id: "own", kind: "question", from: "PC3", host: "pc-1", text: "mia" },
  ] } };
  assert.deepEqual(pendingQuestions(state, "pc-1").map((q) => q.id), ["z"]);
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

test("claim ownership: host of this computer, any agent name or worktree; e-mail for claims without host", async () => {
  const owns = await claimOwnership(["/nonexistent"], { selfHost: "pc-a", selfEmail: "Me@Example.com" });
  const shared = { scope: "shared", remote_fingerprint: "x", epoch: 1, ref: "refs/agentic-sdlc/claims/ST-1/000001/claim" };
  assert.equal(owns({ agent: "other-name", branch: "x", shared_claim: shared, audit: { run: { host: "pc-a" } } }), true);
  assert.equal(owns({ shared_claim: shared, audit: { run: { host: "pc-b" }, git: { user: { email: "me@example.com" } } } }), false);
  assert.equal(owns({ shared_claim: shared, audit: { git: { user: { email: "me@example.com" } } } }), true);
  assert.equal(owns({ shared_claim: shared, audit: { git: { user: { email: "else@example.com" } } } }), false);
  assert.equal(owns({ shared_claim: shared }), false);
  assert.equal(owns({ status: "active" }), true);
});

test("own claims of this computer show their next step, or delegated work with the marker", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "keep-going-own-"));
  try {
    for (const id of ["ST-A", "ST-B"]) {
      fs.mkdirSync(path.join(root, ".sdlc", "stories", id), { recursive: true });
      fs.writeFileSync(path.join(root, ".sdlc", "stories", id, "claim.json"), JSON.stringify({ status: "active", story_id: id }));
    }
    const work = collectWork(root, { working: { "ST-B": { until: "2099-01-01T00:00:00Z", reason: "subagent" } } });
    const decision = decideKeepGoing(work);
    assert.match(decision.reason, /ST-A: .*agentic-sdlc story complete-step/u);
    assert.match(decision.note, /ST-B: lavoro delegato/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
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

test("story working marker: local to the git common dir, expires by itself, clearable", async () => {
  const { activeWorking, storyWorking } = await import("../../lib/host-hooks/working-marker.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keep-going-working-"));
  execFileSync("git", ["init", "-q", dir]);
  const quiet = (fn) => { const log = console.log; console.log = () => {}; try { return fn(); } finally { console.log = log; } };
  quiet(() => storyWorking({ root: dir, id: "ST-1", until: "30m", reason: "subagente" }, { now: 1000 }));
  assert.equal(activeWorking(dir, 2000)["ST-1"].reason, "subagente");
  assert.deepEqual(activeWorking(dir, 1000 + 31 * 60 * 1000), {});
  quiet(() => storyWorking({ root: dir, id: "ST-1", clear: true }, { now: 2000 }));
  assert.deepEqual(activeWorking(dir, 2000), {});
  assert.throws(() => storyWorking({ root: dir, id: "ST-1" }));
});

test("stories created by another computer are never proposed, however old, unless marked free; own stories are", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keep-going-foreign-"));
  const now = Date.parse("2026-01-01T12:00:00Z");
  const hoursAgo = (h) => new Date(now - h * 3600 * 1000).toISOString();
  const write = (id, host, createdAt, extra = {}) => {
    fs.mkdirSync(path.join(dir, ".sdlc", "stories", id), { recursive: true });
    fs.writeFileSync(path.join(dir, ".sdlc", "stories", id, "story.json"), JSON.stringify({ id, created_at: createdAt, audit: { run: host ? { host } : {} }, ...extra }));
  };
  write("ST-OTHER", "alice-pc", hoursAgo(1));
  write("ST-OLD", "alice-pc", hoursAgo(5));
  write("ST-MINE", "my-pc", hoursAgo(1));
  write("ST-NOHOST", null, hoursAgo(1));
  write("ST-FREE", "alice-pc", hoursAgo(1), { unassigned: true });
  write("ST-FREE2", "alice-pc", hoursAgo(50), { free: true });
  write("ST-ANCIENT", "alice-pc", hoursAgo(500));
  const work = collectWork(dir, { now, selfHost: "my-pc" });
  assert.deepEqual(work.available, ["ST-FREE", "ST-FREE2", "ST-MINE", "ST-NOHOST"]);
  assert.deepEqual(collectWork(dir, { now, selfHost: "my-pc", env: { AGENTIC_SDLC_KEEP_GOING_FOREIGN_HOURS: "0" } }).available, ["ST-ANCIENT", "ST-FREE", "ST-FREE2", "ST-MINE", "ST-NOHOST", "ST-OLD", "ST-OTHER"]);
  assert.equal(collectWork(dir, { now }).available.includes("ST-OTHER"), true, "no own identity: current behavior");
});

test("foreign check falls back to the git author e-mail, else current behavior", () => {
  const now = Date.now();
  const story = (email) => ({ created_at: new Date(now - 60_000).toISOString(), audit: { git: { user: { email } } } });
  const window = 3 * 3600 * 1000;
  assert.equal(isFreshForeignStory(story("a@x.it"), { selfEmail: "b@x.it", now, windowMs: window }), true);
  assert.equal(isFreshForeignStory(story("A@x.it"), { selfEmail: "a@x.it", now, windowMs: window }), false);
  assert.equal(isFreshForeignStory(story("a@x.it"), { now, windowMs: window }), false);
  assert.equal(isFreshForeignStory({ audit: { run: { host: "h" } } }, { selfHost: "me", now, windowMs: window }), true, "no creation time needed");
  assert.equal(isFreshForeignStory({ unassigned: true, audit: { run: { host: "h" } } }, { selfHost: "me", now, windowMs: window }), false);
  assert.equal(isFreshForeignStory({ audit: { run: { host: "h" } } }, { selfHost: "me", now, windowMs: 0 }), false);
});

test("anti-loop: the same bare suggestion is not blocked twice, new content still is", () => {
  const first = decideKeepGoing({ available: ["ST-3"], now: 1000 });
  assert.equal(first.block, true);
  const second = decideKeepGoing({ available: ["ST-3"], previous: first.state, now: 2000 });
  assert.equal(second.block, false);
  assert.equal(decideKeepGoing({ available: ["ST-4"], previous: first.state, now: 2000 }).block, true);
  assert.equal(decideKeepGoing({ available: ["ST-3"], previous: first.state, now: 1000 + IDENTICAL_BLOCKS_WINDOW_MS + 1 }).block, false);
});

test("the release step names the sync-before-commit, strict gate and transition order", () => {
  const release = nextStoryStep({ storyId: "ST-1", completedSteps: ["discovery", "analysis", "design", "implementation", "validation"] });
  assert.match(release.label, /story sync.*git\.commit/u);
  assert.match(release.label, /gate check --strict.*workflow instance transition --request-id/u);
  assert.match(release.label, /authorize e `gh pr create` subito di seguito/u);
  const behind = decideKeepGoing({ claims: [{ ...claim, behind: 2 }] }).reason;
  assert.match(behind, /PRIMA del git\.commit governato/u);
});

test("the most advanced record wins: the story worktree is ahead of main", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keep-going-advanced-"));
  try {
    const main = path.join(dir, "main");
    const wt = path.join(dir, "wt");
    const put = (root, file, value) => {
      fs.mkdirSync(path.dirname(path.join(root, ".sdlc", file)), { recursive: true });
      fs.writeFileSync(path.join(root, ".sdlc", file), JSON.stringify(value));
    };
    for (const root of [main, wt]) put(root, "stories/ST-A/claim.json", { story_id: "ST-A", status: "active" });
    for (const step of ["discovery", "analysis"]) put(main, `stories/ST-A/steps/${step}.json`, { status: "completed" });
    for (const step of ["discovery", "analysis", "design", "implementation", "validation"]) put(wt, `stories/ST-A/steps/${step}.json`, { status: "completed" });
    const work = collectWork(main, { roots: [main, wt] });
    assert.match(work.claims[0].next.command, /--step release/u);
    assert.equal(work.claims[0].root, wt);
    // Worktree gone: main is used.
    assert.match(collectWork(main, { roots: [main] }).claims[0].next.command, /--step design/u);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a governed commit already made: no sync, the real next release step", () => {
  const release = { storyId: "ST-1", next: nextStoryStep({ storyId: "ST-1", completedSteps: ["discovery", "analysis", "design", "implementation", "validation"] }) };
  assert.equal(withWorktreeProgress({ ...release, behind: 4 }, { behind: 4, progress: { committed: false } }).behind, 4);
  const pending = withWorktreeProgress(release, { behind: 4, progress: { committed: true, pushed: false, pullRequest: false, profile: "AUT-PR-1" } });
  assert.equal(pending.behind, undefined);
  assert.match(pending.next.command, /--id AUT-PR-1 --action git\.push/u);
  assert.doesNotMatch(decideKeepGoing({ claims: [pending] }).reason, /story sync --id|PRIMA del git\.commit/u);
  assert.match(withWorktreeProgress(release, { progress: { committed: true, pushed: true, pullRequest: false } }).next.command, /pull_request\.create/u);
  assert.match(withWorktreeProgress(release, { progress: { committed: true, pushed: true, pullRequest: true } }).next.label, /PR gia' fatti/u);
  // Other phases keep their step; only the stale sync goes away.
  assert.match(withWorktreeProgress(claim, { behind: 3, progress: { committed: true } }).next.command, /--step validation/u);
});

test("delivery progress reads the completed git.commit receipt for the current head", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keep-going-progress-"));
  try {
    const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
    git("init", "-q", "-b", "feature/ST-1");
    git("config", "user.email", "t@example.test");
    git("config", "user.name", "T");
    fs.writeFileSync(path.join(dir, "a.txt"), "a");
    git("add", "a.txt");
    git("commit", "-q", "-m", "a");
    const head = git("rev-parse", "HEAD");
    const actions = path.join(dir, ".sdlc", "autonomy", "actions");
    fs.mkdirSync(actions, { recursive: true });
    const receipt = (name, value) => fs.writeFileSync(path.join(actions, `${name}.json`), JSON.stringify({ status: "completed", outcome: "passed", profile_ref: { id: "AUT-PR-1" }, runtime_target: { branch: "feature/ST-1", head_sha: head }, ...value }));
    receipt("AUT-ACT-1", { action: "git.commit", action_details: { commit: { before_sha: "0".repeat(40), after_sha: "1".repeat(40) } } });
    assert.equal(deliveryProgress(dir).committed, false);
    receipt("AUT-ACT-2", { action: "git.commit", action_details: { commit: { before_sha: "0".repeat(40), after_sha: head } } });
    assert.deepEqual(deliveryProgress(dir), { committed: true, pushed: false, pullRequest: false, profile: "AUT-PR-1" });
    receipt("AUT-ACT-3", { action: "pull_request.create" });
    assert.equal(deliveryProgress(dir).pullRequest, true);
    git("update-ref", "refs/remotes/origin/feature/ST-1", head);
    assert.equal(deliveryProgress(dir).pushed, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("delivery progress names only a delivery profile that covers the story", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keep-going-profile-"));
  try {
    const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
    git("init", "-q", "-b", "feature/ST-D4");
    git("config", "user.email", "t@example.test");
    git("config", "user.name", "T");
    fs.writeFileSync(path.join(dir, "a.txt"), "a");
    git("add", "a.txt");
    git("commit", "-q", "-m", "a");
    const head = git("rev-parse", "HEAD");
    const deliveries = path.join(dir, ".sdlc", "autonomy", "deliveries");
    const actions = path.join(dir, ".sdlc", "autonomy", "actions");
    fs.mkdirSync(deliveries, { recursive: true });
    fs.mkdirSync(actions, { recursive: true });
    const profile = (id, storyId) => fs.writeFileSync(path.join(deliveries, `${id}.json`), JSON.stringify({ id, story_refs: [{ id: storyId }] }));
    profile("AUT-PR-D4", "ST-D4");
    profile("AUT-PR-D6", "ST-D6");
    const receipt = (name, id) => fs.writeFileSync(path.join(actions, `${name}.json`), JSON.stringify({ status: "completed", outcome: "passed", action: "git.commit", profile_ref: { id, path: `.sdlc/autonomy/deliveries/${id}.json` }, runtime_target: { branch: "feature/ST-D4", head_sha: head }, action_details: { commit: { after_sha: head } } }));
    receipt("AUT-ACT-1", "AUT-PR-D4");
    receipt("AUT-ACT-2", "AUT-PR-D6");
    assert.equal(deliveryProgress(dir, { storyId: "ST-D4" }).profile, "AUT-PR-D4");
    assert.equal(deliveryProgress(dir, { storyId: "ST-X" }).profile, null);
    const next = withWorktreeProgress({ storyId: "ST-X", next: { phase: "release", label: "x" } }, { progress: deliveryProgress(dir, { storyId: "ST-X" }) }).next;
    assert.match(next.command, /--id <profile-id> --action git\.push/u);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("each story resolves to its own worktree by branch pattern, not the main checkout", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keep-going-wt-"));
  try {
    fs.mkdirSync(path.join(dir, ".sdlc"));
    fs.writeFileSync(path.join(dir, ".sdlc", "config.json"), JSON.stringify({ parallel_work: { branch_patterns: ["feature/<story-id>"] } }));
    const branches = [{ dir: "/main", branch: "feature/ST-D6" }, { dir: "/wt-d4", branch: "feature/ST-D4" }];
    const resolve = await storyWorktreeResolver(dir, { branches });
    assert.equal(resolve("ST-D4"), "/wt-d4");
    assert.equal(resolve("ST-D6"), "/main");
    assert.equal(resolve("ST-OTHER"), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("anti-loop compares suggestions without the changing counts", () => {
  const behind = (n) => ({ ...claim, behind: n });
  let state = {};
  const blocks = [];
  for (const [index, n] of [4, 5, 5, 6].entries()) {
    const result = decideKeepGoing({ claims: [behind(n)], previous: state, now: 1000 + index });
    blocks.push(result.block);
    state = result.state;
  }
  assert.deepEqual(blocks, [true, false, false, false]);
});

test("a step that needs a person with an open request is shown as waiting and does not block", () => {
  const release = { storyId: "ST-1", next: nextStoryStep({ storyId: "ST-1", completedSteps: ["discovery", "analysis", "design", "implementation", "validation"] }) };
  const state = { own: ["m1"], attention: { window: [
    { id: "m1", kind: "request", text: "ST-1: serve `agentic-sdlc autonomy delivery reconcile --id AUT-PR-1` da una persona" },
    { id: "m2", kind: "request", text: "ST-9 `agentic-sdlc autonomy delivery amend --id X`" },
  ] } };
  const requests = personRequests(state);
  assert.equal(requests.length, 1);
  const waiting = withPersonRequest(release, requests);
  const result = decideKeepGoing({ claims: [waiting] });
  assert.equal(result.block, false);
  assert.match(result.note, /ST-1: in attesa di una persona: agentic-sdlc autonomy delivery reconcile --id AUT-PR-1/u);
  // Answered request: the step is proposed again.
  const answered = personRequests({ ...state, attention: { window: [...state.attention.window, { id: "m3", kind: "answer", reply_to: "m1", text: "ok" }] } });
  assert.equal(withPersonRequest(release, answered).awaitingPerson, undefined);
});

test("suggestion-only stops: the same set in any order passes with a short note, a new set blocks", () => {
  const w1 = { ...claim, storyId: "ST-1", waiting: "attesa umana" };
  const w2 = { ...claim, storyId: "ST-2", awaitingPerson: { command: "agentic-sdlc approve" } };
  const first = decideKeepGoing({ claims: [w1, w2], available: ["ST-5"], now: 1000 });
  assert.equal(first.block, true);
  const second = decideKeepGoing({ claims: [w2, w1], available: ["ST-5"], previous: first.state, now: 2000 });
  assert.equal(second.block, false);
  assert.match(second.note, /gia' segnalati/u);
  const other = decideKeepGoing({ claims: [w1, w2], available: ["ST-6"], previous: first.state, now: 3000 });
  assert.equal(other.block, true);
  const firm = decideKeepGoing({ claims: [w1, claim], available: ["ST-5"], previous: first.state, now: 4000 });
  assert.equal(firm.block, true);
});


test("unpublished records of a delegated story (working marker) do not block", () => {
  const unpublished = [{ storyId: "ST-D", base: "origin/main", files: ["a", "b"], command: "publish" }];
  const claim = { storyId: "ST-D", next: { phase: "implementation", label: "x", command: "y" }, delegated: { until: "t", reason: "agente" } };
  const decision = decideKeepGoing({ unpublished, claims: [claim] });
  assert.equal(decision.block, false);
  assert.match(decision.note, /lavoro delegato: li pubblica chi ci lavora/u);
});

test("unpublished records growing between checks do not block", () => {
  const item = (n) => ({ storyId: "ST-G", base: "origin/main", files: Array.from({ length: n }, (_, i) => `f${i}`), command: "publish" });
  const first = decideKeepGoing({ unpublished: [item(4)] });
  assert.equal(first.block, true);
  const second = decideKeepGoing({ unpublished: [item(13)], previous: first.state });
  assert.equal(second.block, false);
  assert.match(second.note, /lavoro delegato/u);
});

test("unpublished records, no marker and stable: block once, then dedupe", () => {
  const unpublished = [{ storyId: "ST-S", base: "origin/main", files: ["a"], command: "publish" }];
  const decision = decideKeepGoing({ unpublished });
  assert.equal(decision.block, true);
  assert.match(decision.reason, /pubblicali prima di tutto/u);
  assert.equal(decideKeepGoing({ unpublished, previous: decision.state }).block, false);
});
