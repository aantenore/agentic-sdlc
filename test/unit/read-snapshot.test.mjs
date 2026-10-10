import "../helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  readSnapshotActive,
  readSnapshotFastChecks,
  readSnapshotValue,
  withReadSnapshot,
} from "../../lib/engine/read-snapshot.mjs";
import {
  workflowFinalExecGit,
  workflowFinalGitTouchedPathsSince,
} from "../../lib/engine/git.mjs";
import { compactGateReport } from "../../lib/engine/story.mjs";

test("a read snapshot answers each question once and only while it is open", () => {
  let calls = 0;
  const compute = () => {
    calls += 1;
    return `answer-${calls}`;
  };
  assert.equal(readSnapshotActive(), false);
  assert.equal(readSnapshotValue("q", compute), "answer-1");
  assert.equal(readSnapshotValue("q", compute), "answer-2", "outside a snapshot nothing is reused");
  withReadSnapshot(() => {
    assert.equal(readSnapshotActive(), true);
    assert.equal(readSnapshotValue("q", compute), "answer-3");
    assert.equal(readSnapshotValue("q", compute), "answer-3");
    withReadSnapshot(() => assert.equal(readSnapshotValue("q", compute), "answer-3", "a nested snapshot joins the outer one"));
  });
  assert.equal(readSnapshotValue("q", compute), "answer-4");
});

test("a failed question fails the same way for every caller in the snapshot", () => {
  let calls = 0;
  const failing = () => {
    calls += 1;
    throw new Error(`failure ${calls}`);
  };
  withReadSnapshot(() => {
    assert.throws(() => readSnapshotValue("broken", failing), /failure 1/u);
    assert.throws(() => readSnapshotValue("broken", failing), /failure 1/u);
  });
  assert.equal(calls, 1);
});

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}\n${result.stderr}`);
  return result.stdout.trim();
}

function commitFile(root, relativePath, contents, message) {
  fs.mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true });
  fs.writeFileSync(path.join(root, relativePath), contents);
  git(root, ["add", "--", relativePath]);
  git(root, ["commit", "-q", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]);
}

function perCommitTouchedPaths(root, range) {
  const touched = new Set();
  for (const commit of git(root, ["rev-list", range]).split("\n").filter(Boolean)) {
    const listed = git(root, ["diff-tree", "--root", "-m", "--no-commit-id", "--name-only", "-r", "-z", "--no-renames", commit, "--"]);
    for (const entry of listed.split("\u0000").filter(Boolean)) touched.add(entry);
  }
  return touched;
}

test("paths touched after a boundary match a per-commit diff, merges and the root commit included", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-sdlc-touched-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Touched"]);
  git(root, ["config", "user.email", "touched@example.invalid"]);
  git(root, ["config", "commit.gpgSign", "false"]);
  git(root, ["config", "core.autocrlf", "false"]);
  git(root, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  const first = commitFile(root, "src/a.mjs", "a\n", "first");
  git(root, ["checkout", "-q", "-b", "side"]);
  commitFile(root, "src/side one.mjs", "side\n", "side");
  git(root, ["checkout", "-q", "main"]);
  commitFile(root, "docs/b.md", "b\n", "main");
  git(root, ["merge", "-q", "--no-ff", "-m", "merge", "side"]);
  commitFile(root, "src/a.mjs", "a2\n", "edit");
  const head = git(root, ["rev-parse", "HEAD"]);
  const context = { root };

  assert.deepEqual(
    [...workflowFinalGitTouchedPathsSince(context, first, head)].sort(),
    [...perCommitTouchedPaths(root, `${first}..${head}`)].sort(),
  );
  assert.deepEqual(
    [...workflowFinalGitTouchedPathsSince(context, null, head)].sort(),
    [...perCommitTouchedPaths(root, head)].sort(),
  );
  assert.equal(workflowFinalGitTouchedPathsSince(context, head, head).size, 0);
});

test("inside a read snapshot a Git query runs once even when the repository changes", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-sdlc-snapshot-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Snapshot"]);
  git(root, ["config", "user.email", "snapshot@example.invalid"]);
  git(root, ["config", "commit.gpgSign", "false"]);
  const first = commitFile(root, "a.txt", "a\n", "first");
  const context = { root };
  withReadSnapshot(() => {
    assert.equal(workflowFinalExecGit(context, ["rev-parse", "HEAD"]), first);
    const second = commitFile(root, "a.txt", "b\n", "second");
    assert.notEqual(second, first);
    assert.equal(workflowFinalExecGit(context, ["rev-parse", "HEAD"]), first);
  });
  assert.notEqual(workflowFinalExecGit(context, ["rev-parse", "HEAD"]), first, "outside the snapshot Git is asked live");
});

test("a saved lifecycle-complete report points to the receipt instead of copying the proof", () => {
  const report = {
    status: "passed",
    final_receipt_path: ".sdlc/gates/ST-1-final.json",
    freshness_proof: {
      schema_version: "proof:v1",
      story_id: "ST-1",
      workflow_instance_id: "delivery-1",
      proof_hash: "a".repeat(64),
      governed_files: [{ path: "a" }, { path: "b" }],
      git_scope: { scoped_changes: [{ path: "src/a.mjs" }] },
    },
  };
  assert.deepEqual(compactGateReport(report).freshness_proof, {
    schema_version: "proof:v1",
    story_id: "ST-1",
    workflow_instance_id: "delivery-1",
    proof_hash: "a".repeat(64),
    governed_file_count: 2,
    certified_path_count: 1,
    details_path: ".sdlc/gates/ST-1-final.json",
  });
  assert.equal(report.freshness_proof.governed_files.length, 2, "the report itself is unchanged");
  const withoutReceipt = { status: "failed", freshness_proof: report.freshness_proof };
  assert.equal(compactGateReport(withoutReceipt), withoutReceipt);
});

test("fast checks are on only for a snapshot opened with them", () => {
  assert.equal(readSnapshotFastChecks(), false);
  withReadSnapshot(() => assert.equal(readSnapshotFastChecks(), false));
  withReadSnapshot(() => {
    assert.equal(readSnapshotFastChecks(), true);
    withReadSnapshot(() => assert.equal(readSnapshotFastChecks(), true), { fastChecks: false });
  }, { fastChecks: true });
});
