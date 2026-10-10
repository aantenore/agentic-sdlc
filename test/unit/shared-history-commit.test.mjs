import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { leaveSharedHistoryOutOfCommit } from "../../lib/engine/delivery.mjs";

const TRACE = ".sdlc/traces/project.jsonl";
const CHECKPOINT = ".sdlc/traces/.integrity/project.jsonl.checkpoint.json";

function git(root, ...args) {
  return childProcess.execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function write(root, file, content) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
}

function fixture(config = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shared-history-commit-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.invalid");
  git(root, "config", "user.name", "t");
  write(root, TRACE, "{}\n");
  write(root, CHECKPOINT, "{}\n");
  write(root, "src/a.js", "1\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  write(root, TRACE, "{}\n{\"n\":1}\n");
  write(root, CHECKPOINT, "{\"n\":1}\n");
  write(root, "src/a.js", "2\n");
  write(root, ".sdlc/stories/ST-1/claim.json", "{}\n");
  git(root, "add", "-A");
  return { root, context: { root, sdlcRoot: path.join(root, ".sdlc"), config } };
}

const stagedPaths = (root) => git(root, "diff", "--cached", "--name-only").split("\n").filter(Boolean).sort();

test("git.commit leaves the shared history out of a story commit and keeps the working copy", () => {
  const f = fixture();
  const options = leaveSharedHistoryOutOfCommit(f.context, { staged: true });
  assert.equal(options.staged, true);
  assert.deepEqual(stagedPaths(f.root), [".sdlc/stories/ST-1/claim.json", "src/a.js"]);
  assert.equal(fs.readFileSync(path.join(f.root, TRACE), "utf8"), "{}\n{\"n\":1}\n");
  assert.equal(git(f.root, "diff", "--name-only", "--", TRACE), TRACE);
});

test("git.commit drops an explicit shared-history scope path and refuses a scope of only shared history", () => {
  const f = fixture();
  const options = leaveSharedHistoryOutOfCommit(f.context, { "scope-path": ["src/a.js", TRACE, ".sdlc/stories/ST-1/claim.json", CHECKPOINT] });
  assert.deepEqual(options["scope-path"], ["src/a.js", ".sdlc/stories/ST-1/claim.json"]);
  assert.deepEqual(stagedPaths(f.root), [".sdlc/stories/ST-1/claim.json", "src/a.js"]);

  const only = fixture();
  assert.throws(() => leaveSharedHistoryOutOfCommit(only.context, { "scope-path": [TRACE] }), /publish-records/u);
});

test("git.commit shared-history paths follow host_policy.records.shared_history_paths", () => {
  const f = fixture({ host_policy: { records: { shared_history_paths: ["traces/.integrity/project.jsonl.checkpoint.json"] } } });
  leaveSharedHistoryOutOfCommit(f.context, { staged: true });
  assert.deepEqual(stagedPaths(f.root), [".sdlc/stories/ST-1/claim.json", TRACE, "src/a.js"]);
  // Nothing shared staged: options are returned unchanged.
  const untouched = { "scope-path": ["src/a.js"] };
  assert.equal(leaveSharedHistoryOutOfCommit(f.context, untouched), untouched);
});
