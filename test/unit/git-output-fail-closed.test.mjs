import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildGitCommitCoverageProof,
  buildGitMetadata,
  gitCommitRange,
  gitCommitReceiptCoverageErrors,
  pullRequestCommitLineage,
  validateGitCommitCoverageProof,
  workflowFinalGitCommitGraphSince,
} from "../../lib/engine/git.mjs";
import { codeReviewRangeAuthors } from "../../lib/engine/common.mjs";
import { hashApprovalSubject } from "../../lib/lifecycle/authorization.mjs";
import { setHost } from "../../lib/runtime/host.mjs";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Fixture Author",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture Author",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

function git(root, args) {
  return childProcess.execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: GIT_ENV,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function repositoryFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-fail-closed-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, ["init", "-q"]);
  fs.writeFileSync(path.join(root, "a.txt"), "a\n");
  git(root, ["add", "a.txt"]);
  git(root, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "base"]);
  const baseSha = git(root, ["rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(root, "b.txt"), "b\n");
  git(root, ["add", "b.txt"]);
  git(root, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "unmediated"]);
  const headSha = git(root, ["rev-parse", "HEAD"]);
  return { root, baseSha, headSha };
}

// Makes one Git subcommand fail the way an oversized output does, leaving
// every other Git call untouched.
function failingGit(t, subcommand, code = "ENOBUFS") {
  const realExecFileSync = childProcess.execFileSync;
  const restore = setHost({
    childProcess: {
      ...childProcess,
      execFileSync(file, args, options) {
        if (file === "git" && args.includes(subcommand)) {
          const error = new Error(`spawnSync git ${code}`);
          error.code = code;
          throw error;
        }
        return realExecFileSync(file, args, options);
      },
    },
  });
  t.after(restore);
}

const PROFILE = Object.freeze({
  id: "DP-FIXTURE",
  profile_hash: "fixture",
  delivery_id: "DEL-FIXTURE",
  delivery_kind: "pull_request",
  pull_request_target: { repository: null, base_branch: "main", head_branch: "feature" },
  story_refs: [],
  requirement_profile_refs: [],
});

test("gitCommitRange lists a range and tells an empty range from a failed listing", (t) => {
  const { root, baseSha, headSha } = repositoryFixture(t);
  assert.deepEqual(gitCommitRange(root, baseSha, headSha), [headSha]);
  assert.deepEqual(gitCommitRange(root, headSha, headSha), []);
  failingGit(t, "rev-list");
  assert.equal(gitCommitRange(root, baseSha, headSha), null);
});

test("git.push coverage refuses a range Git could not list", (t) => {
  const { root, baseSha, headSha } = repositoryFixture(t);
  const context = { root, sdlcRoot: path.join(root, ".sdlc") };
  const runtimeTarget = { base_sha: baseSha, head_sha: headSha };
  failingGit(t, "rev-list");

  const built = buildGitCommitCoverageProof(context, PROFILE, runtimeTarget);
  assert.equal(built.proof, null);
  assert.match(built.errors.join("\n"), /could not list the commit range/u);

  assert.match(
    gitCommitReceiptCoverageErrors(context, PROFILE, runtimeTarget, []).join("\n"),
    /could not list the commit range/u,
  );

  const proofBase = {
    schema_version: "git-commit-coverage:v1",
    base_sha: baseSha,
    head_sha: headSha,
    lineage_hash: hashApprovalSubject(pullRequestCommitLineage(context, PROFILE)),
    entries: [],
  };
  const emptyProof = { ...proofBase, coverage_hash: hashApprovalSubject(proofBase) };
  assert.match(
    validateGitCommitCoverageProof(context, PROFILE, runtimeTarget, emptyProof).join("\n"),
    /could not list the commit range/u,
  );
});

test("final lifecycle freshness refuses a commit graph Git could not list", (t) => {
  const { root, baseSha, headSha } = repositoryFixture(t);
  assert.deepEqual(
    workflowFinalGitCommitGraphSince({ root }, baseSha, headSha).map((entry) => entry.commit_sha),
    [headSha],
  );
  failingGit(t, "rev-list");
  assert.throws(
    () => workflowFinalGitCommitGraphSince({ root }, baseSha, headSha),
    /could not inspect the post-certification commit graph/u,
  );
});

test("git metadata never reports an unreadable worktree as clean", (t) => {
  const { root } = repositoryFixture(t);
  assert.equal(buildGitMetadata(root).is_dirty, false);
  fs.writeFileSync(path.join(root, "untracked.txt"), "c\n");
  assert.equal(buildGitMetadata(root).is_dirty, true);
  failingGit(t, "status", "ENOBUFS");
  assert.equal(buildGitMetadata(root).is_dirty, true);
});

test("git metadata reports an unknown worktree state when git status fails", (t) => {
  const { root } = repositoryFixture(t);
  failingGit(t, "status", "EIO");
  assert.equal(buildGitMetadata(root).is_dirty, null);
});

test("code review refuses to prove reviewer independence from an unreadable author list", (t) => {
  const { root, baseSha, headSha } = repositoryFixture(t);
  assert.deepEqual(
    codeReviewRangeAuthors({ root }, baseSha, headSha).map((author) => author.email),
    ["fixture@example.invalid"],
  );
  failingGit(t, "log");
  assert.throws(
    () => codeReviewRangeAuthors({ root }, baseSha, headSha),
    /reviewer independence cannot be proven/u,
  );
});
