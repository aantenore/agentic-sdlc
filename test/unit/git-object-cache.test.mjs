import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  cachedGitObjectAnswer,
  flushGitObjectCaches,
  gitArgsAreContentAddressed,
  resetGitObjectCaches,
} from "../../lib/engine/git-object-cache.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);

test("only questions about commits named by full IDs are kept", () => {
  assert.equal(gitArgsAreContentAddressed(["cat-file", "-e", `${A}^{commit}`]), true);
  assert.equal(gitArgsAreContentAddressed(["merge-base", "--is-ancestor", A, B]), true);
  assert.equal(gitArgsAreContentAddressed(["diff", "--name-only", "-z", `${A}..${B}`, "--", "src"]), true);
  assert.equal(gitArgsAreContentAddressed(["diff-tree", "--root", "-m", A, "--"]), true);
  assert.equal(gitArgsAreContentAddressed(["--no-replace-objects", "ls-tree", "-z", A, "--", "x"]), true);
  assert.equal(gitArgsAreContentAddressed(["cat-file", "blob", `${A}:docs/a.txt`]), true);
  assert.equal(gitArgsAreContentAddressed(["merge-base", "--is-ancestor", A, "HEAD"]), false);
  assert.equal(gitArgsAreContentAddressed(["diff", "--name-only", A, "--"]), false, "a commit against the working tree changes");
  assert.equal(gitArgsAreContentAddressed(["diff", "--cached", A, B]), false);
  assert.equal(gitArgsAreContentAddressed(["rev-parse", "--verify", A]), false);
  assert.equal(gitArgsAreContentAddressed(["rev-list", "--all"]), false);
  assert.equal(gitArgsAreContentAddressed(["log", "abc1234"]), false, "an abbreviated ID can become ambiguous");
  assert.equal(gitArgsAreContentAddressed(["update-ref", "refs/x", A]), false);
});

test("successful answers are kept across runs and failures are asked again", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-sdlc-git-objects-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".sdlc"));
  resetGitObjectCaches();
  let calls = 0;
  const ancestor = ["merge-base", "--is-ancestor", A, B];
  assert.equal(cachedGitObjectAnswer(root, "succeeds", ancestor, () => { calls += 1; return true; }), true);
  assert.equal(cachedGitObjectAnswer(root, "succeeds", ancestor, () => { calls += 1; return false; }), true);
  const missing = ["cat-file", "-e", `${B}^{commit}`];
  assert.equal(cachedGitObjectAnswer(root, "succeeds", missing, () => { calls += 1; return false; }), false);
  assert.equal(cachedGitObjectAnswer(root, "succeeds", missing, () => { calls += 1; return true; }), true);
  assert.equal(calls, 3);
  flushGitObjectCaches();
  assert.ok(fs.existsSync(path.join(root, ".sdlc", "cache", "git-objects.json")));
  resetGitObjectCaches();
  assert.equal(cachedGitObjectAnswer(root, "succeeds", ancestor, () => { throw new Error("asked again"); }), true);
  resetGitObjectCaches();
});

test("a folder that is not a project keeps nothing", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-sdlc-git-objects-none-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  resetGitObjectCaches();
  let calls = 0;
  const args = ["merge-base", "--is-ancestor", A, B];
  cachedGitObjectAnswer(root, "succeeds", args, () => { calls += 1; return true; });
  cachedGitObjectAnswer(root, "succeeds", args, () => { calls += 1; return true; });
  assert.equal(calls, 2);
  flushGitObjectCaches();
  assert.equal(fs.existsSync(path.join(root, ".sdlc")), false);
  resetGitObjectCaches();
});
