import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { storyOwnCommitRange } from "../../lib/engine/story-branch-commits.mjs";

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" }).trim();

function commitFile(root, name, content, message) {
  fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  fs.writeFileSync(path.join(root, name), content);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-base-"));
  const root = path.join(dir, "work");
  fs.mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "remote", "add", "origin", dir);
  const start = commitFile(root, "a.txt", "a", "start");
  git(root, "update-ref", "refs/remotes/origin/main", start);
  git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  git(root, "checkout", "-q", "-b", "feature/story");
  return { dir, root, start, context: { root, sdlcRoot: path.join(root, ".sdlc"), config: {} } };
}

test("commits reachable from the remote base branch are not the story's own", () => {
  const { dir, root, start, context } = setup();
  try {
    const fromBase = commitFile(root, "packages/agents/x.txt", "x", "direct to main");
    git(root, "update-ref", "refs/remotes/origin/main", fromBase);
    const own = commitFile(root, "story.txt", "s", "story work");
    const range = storyOwnCommitRange(context, { storyId: "ST-X", baseSha: start, headSha: own });
    assert.deepEqual(range.commits, [own]);
    assert.ok(range.set_aside.some((item) => item.sha === fromBase && item.kind === "base"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a commit not on the remote base branch stays the story's", () => {
  const { dir, root, start, context } = setup();
  try {
    const foreign = commitFile(root, "packages/agents/x.txt", "x", "not on base");
    const own = commitFile(root, "story.txt", "s", "story work");
    const range = storyOwnCommitRange(context, { storyId: "ST-X", baseSha: start, headSha: own });
    assert.deepEqual(range.commits, [foreign, own]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
