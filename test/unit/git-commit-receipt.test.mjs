import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { validateCompletedGitCommitReceipt } from "../../lib/engine/git.mjs";

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function repository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-commit-receipt-"));
  git(root, ["init", "--quiet", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["config", "core.autocrlf", "false"]);
  fs.writeFileSync(path.join(root, "a.txt"), "a\n");
  git(root, ["add", "a.txt"]);
  git(root, ["commit", "--quiet", "-m", "base"]);
  return root;
}

function receiptPair(beforeSha, afterSha, changedPaths) {
  const details = { changed_paths: changedPaths, allowed_write_paths: ["src"] };
  const runtime = { kind: "git", head_sha: beforeSha };
  return {
    authorization: { action_details: details, runtime_target: runtime },
    receipt: {
      action_details: { ...details, commit: { before_sha: beforeSha, after_sha: afterSha, committed_paths: changedPaths } },
      runtime_target: { ...runtime, head_sha: afterSha },
    },
  };
}

test("a commit receipt whose commits are not in this clone is reported, not refused", () => {
  const root = repository();
  try {
    const before = git(root, ["rev-parse", "HEAD"]);
    const { authorization, receipt } = receiptPair(before, "e".repeat(40), ["src/x.mjs"]);
    const report = { errors: [], warnings: [] };
    validateCompletedGitCommitReceipt({ root }, report, receipt, authorization, "Action A");
    assert.deepEqual(report.errors, []);
    assert.match(report.warnings.join("\n"), /Action A commit e{40} is not in this clone/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a commit receipt whose commit exists but holds other files is still refused", () => {
  const root = repository();
  try {
    const before = git(root, ["rev-parse", "HEAD"]);
    fs.writeFileSync(path.join(root, "b.txt"), "b\n");
    git(root, ["add", "b.txt"]);
    git(root, ["commit", "--quiet", "-m", "other"]);
    const after = git(root, ["rev-parse", "HEAD"]);
    const { authorization, receipt } = receiptPair(before, after, ["src/x.mjs"]);
    const report = { errors: [], warnings: [] };
    validateCompletedGitCommitReceipt({ root }, report, receipt, authorization, "Action B");
    assert.match(report.errors.join("\n"), /Action B does not prove one exact non-merge commit/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
