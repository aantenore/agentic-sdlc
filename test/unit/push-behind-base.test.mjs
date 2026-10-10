import "../helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildGitCommitCoverageProof,
  coverageBaseDrift,
  gitCommitReceiptCoverageErrors,
  isBaseRecordsSyncMerge,
  validateGitCommitCoverageProof,
} from "../../lib/engine/git.mjs";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Fixture Author",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture Author",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

const PROFILE = Object.freeze({
  id: "DP-FIXTURE",
  profile_hash: "fixture",
  delivery_id: "DEL-FIXTURE",
  delivery_kind: "pull_request",
  pull_request_target: { repository: null, base_branch: "main", head_branch: "feature" },
  story_refs: [],
  requirement_profile_refs: [],
});

function git(root, args) {
  return childProcess.execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: GIT_ENV,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function commitFile(root, relativePath, content, message) {
  fs.mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true });
  fs.writeFileSync(path.join(root, relativePath), content);
  git(root, ["add", relativePath]);
  git(root, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]);
}

// main: start -> (more commits); story branch forks at start.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "push-behind-base-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, ["init", "-q", "-b", "main"]);
  const start = commitFile(root, "src/app.txt", "app\n", "start");
  return { root, start, context: { root, sdlcRoot: path.join(root, ".sdlc"), config: {} } };
}

test("a head behind a base that only gained project records keeps its coverage", (t) => {
  const { root, start, context } = fixture(t);
  const base = commitFile(root, ".sdlc/stories/ST-OTHER/story.json", "{}\n", "records from another computer");
  assert.deepEqual(coverageBaseDrift(root, start, start), { mergeBaseSha: null });
  assert.deepEqual(coverageBaseDrift(root, base, start), { mergeBaseSha: start });

  const runtimeTarget = { base_sha: base, head_sha: start };
  const built = buildGitCommitCoverageProof(context, PROFILE, runtimeTarget);
  assert.deepEqual(built.errors, []);
  assert.equal(built.proof.schema_version, "git-commit-coverage:v2");
  assert.equal(built.proof.merge_base_sha, start);
  assert.deepEqual(validateGitCommitCoverageProof(context, PROFILE, runtimeTarget, built.proof), []);
  assert.deepEqual(gitCommitReceiptCoverageErrors(context, PROFILE, runtimeTarget, []), []);
});

test("a head behind a base that gained code is still refused", (t) => {
  const { root, start, context } = fixture(t);
  commitFile(root, ".sdlc/traces/project.jsonl", "{}\n", "records");
  const base = commitFile(root, "src/other.txt", "other\n", "code from another story");
  const drift = coverageBaseDrift(root, base, start);
  assert.match(drift.error, /not descended from the approved base .*changed more than project records .*src\/other\.txt/u);
  const built = buildGitCommitCoverageProof(context, PROFILE, { base_sha: base, head_sha: start });
  assert.equal(built.proof, null);
});

test("a merge that only brings base records needs no commit receipt", (t) => {
  const { root, start, context } = fixture(t);
  const base = commitFile(root, ".sdlc/stories/ST-OTHER/story.json", "{}\n", "records");
  git(root, ["checkout", "-q", "-b", "feature", start]);
  git(root, ["-c", "commit.gpgsign=false", "merge", "-q", "--no-ff", "-m", "sync records", "main"]);
  const merge = git(root, ["rev-parse", "HEAD"]);
  assert.equal(isBaseRecordsSyncMerge(root, merge, base), true);

  const runtimeTarget = { base_sha: base, head_sha: merge };
  const built = buildGitCommitCoverageProof(context, PROFILE, runtimeTarget);
  assert.deepEqual(built.errors, []);
  assert.equal(built.proof.schema_version, "git-commit-coverage:v2");
  assert.deepEqual(built.proof.entries, [{ commit_sha: merge, kind: "base_records_sync" }]);
  assert.deepEqual(validateGitCommitCoverageProof(context, PROFILE, runtimeTarget, built.proof), []);
  assert.deepEqual(gitCommitReceiptCoverageErrors(context, PROFILE, runtimeTarget, []), []);

  // An ordinary unmediated commit after it is still refused.
  const unmediated = commitFile(root, "src/app.txt", "changed\n", "unmediated");
  assert.equal(isBaseRecordsSyncMerge(root, unmediated, base), false);
  const refused = buildGitCommitCoverageProof(context, PROFILE, { base_sha: base, head_sha: unmediated });
  assert.equal(refused.proof, null);
  assert.match(refused.errors.join("\n"), new RegExp(`Commit ${unmediated} requires exactly one`, "u"));
});

test("a merge that also brings code from the base is not a records sync", (t) => {
  const { root, start } = fixture(t);
  const base = commitFile(root, "src/other.txt", "other\n", "code");
  git(root, ["checkout", "-q", "-b", "feature", start]);
  commitFile(root, "src/mine.txt", "mine\n", "story work");
  git(root, ["-c", "commit.gpgsign=false", "merge", "-q", "--no-ff", "-m", "sync", "main"]);
  assert.equal(isBaseRecordsSyncMerge(root, git(root, ["rev-parse", "HEAD"]), base), false);
});

test("a v1 proof keeps its exact shape when the head descends from the base", (t) => {
  const { root, start, context } = fixture(t);
  const built = buildGitCommitCoverageProof(context, PROFILE, { base_sha: start, head_sha: start });
  assert.equal(built.proof.schema_version, "git-commit-coverage:v1");
  assert.equal("merge_base_sha" in built.proof, false);
  assert.equal(root.length > 0, true);
});
