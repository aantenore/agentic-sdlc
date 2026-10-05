import assert from "node:assert/strict";
import test from "node:test";

import {
  isGitObjectId,
  isUnbornGitBase,
  taskStartGitBase,
  unbornGitBase,
} from "../../lib/lifecycle/git-base.mjs";

const EMPTY_TREE_SHA1 = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const EMPTY_TREE_SHA256 = "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321";

test("the unborn base names no commit and the empty tree of either object format", () => {
  for (const tree of [EMPTY_TREE_SHA1, EMPTY_TREE_SHA256]) {
    const base = unbornGitBase(tree);
    assert.deepEqual(base, { base_sha: null, base_tree: tree });
    assert.equal(isUnbornGitBase(base), true);
  }
});

test("only an exact null base with a full tree id is an unborn base", () => {
  for (const value of [
    null,
    undefined,
    [],
    { base_sha: null },
    { base_tree: EMPTY_TREE_SHA1 },
    { base_sha: "a".repeat(40), base_tree: EMPTY_TREE_SHA1 },
    { base_sha: null, base_tree: "4b825dc" },
    { base_sha: null, base_tree: EMPTY_TREE_SHA1, extra: true },
  ]) {
    assert.equal(isUnbornGitBase(value), false, JSON.stringify(value));
  }
  assert.equal(isGitObjectId("A".repeat(40)), false);
});

test("a task-start receipt classifies as commit, unborn or no verifiable base", () => {
  const sha = "1".repeat(40);
  assert.deepEqual(
    taskStartGitBase({ audit: { git: { head_sha: sha } } }),
    { kind: "commit", sha },
  );
  assert.deepEqual(
    taskStartGitBase({
      audit: { git: { head_sha: null } },
      git_base: unbornGitBase(EMPTY_TREE_SHA1),
    }),
    { kind: "unborn", tree: EMPTY_TREE_SHA1 },
  );
  // A recorded commit always wins; a malformed marker is no base at all.
  assert.equal(
    taskStartGitBase({
      audit: { git: { head_sha: sha } },
      git_base: unbornGitBase(EMPTY_TREE_SHA1),
    }).kind,
    "commit",
  );
  assert.equal(taskStartGitBase({ audit: { git: { head_sha: null } } }).kind, "none");
  assert.equal(
    taskStartGitBase({ audit: { git: { head_sha: null } }, git_base: { base_sha: null } }).kind,
    "none",
  );
  assert.equal(taskStartGitBase(null).kind, "none");
});
