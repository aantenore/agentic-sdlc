import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { dependencyBaseCertification } from "../../lib/engine/dependency-base.mjs";
import { buildContext } from "../../lib/engine/common.mjs";

function git(root, ...args) {
  return childProcess.execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function repoWithBase(withReceipt) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dep-base-unit-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.invalid");
  fs.writeFileSync(path.join(root, "README.md"), "base\n");
  if (withReceipt) {
    fs.mkdirSync(path.join(root, ".sdlc", "gates"), { recursive: true });
    fs.writeFileSync(path.join(root, ".sdlc", "gates", "ST-A-final.json"), "{}\n");
  }
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  const sha = git(root, "rev-parse", "HEAD");
  git(root, "update-ref", "refs/remotes/origin/main", sha);
  git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  git(root, "checkout", "-q", "-b", "feature/ST-B");
  git(root, "rm", "-q", "-r", "--cached", ".sdlc", "--ignore-unmatch");
  fs.rmSync(path.join(root, ".sdlc"), { recursive: true, force: true });
  git(root, "commit", "-q", "--allow-empty", "-m", "branch without the records");
  return { root, sha };
}

test("a certification on the base tip is judged on a checkout outside the working tree", () => {
  const { root, sha } = repoWithBase(true);
  const before = git(root, "status", "--porcelain");
  let seen = null;
  const verdict = dependencyBaseCertification(buildContext({ root }), { to: "ST-A", from: "ST-B" }, (baseContext) => {
    seen = baseContext.root;
    assert.notEqual(baseContext.root, root);
    assert.equal(fs.existsSync(path.join(baseContext.root, ".sdlc", "gates", "ST-A-final.json")), true);
    return true;
  });
  assert.equal(verdict.sha, sha);
  assert.equal(verdict.ref, "refs/remotes/origin/main");
  assert.equal(git(root, "status", "--porcelain"), before);
  assert.equal(fs.existsSync(path.join(root, ".sdlc")), false);
  assert.ok(seen);
  fs.rmSync(root, { recursive: true, force: true });
});

test("base records that do not verify leave the dependency blocked", () => {
  const { root } = repoWithBase(true);
  const verdict = dependencyBaseCertification(buildContext({ root }), { to: "ST-A", from: "ST-C" }, () => false);
  assert.equal(verdict, null);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a story without a final receipt on the base is not even checked out", () => {
  const { root } = repoWithBase(false);
  let called = false;
  const verdict = dependencyBaseCertification(buildContext({ root }), { to: "ST-A", from: "ST-D" }, () => {
    called = true;
    return true;
  });
  assert.equal(verdict, null);
  assert.equal(called, false);
  fs.rmSync(root, { recursive: true, force: true });
});
