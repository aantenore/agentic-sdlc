import "../helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildGitCommitCoverageProof,
  baseAdvanceChangedPaths,
  coverageBaseDrift,
  gitCommitReceiptCoverageErrors,
  isBaseRecordsOnlyAdvance,
  isBaseRecordsSyncMerge,
  validateGitCommitCoverageProof,
} from "../../lib/engine/git.mjs";
import { namesOtherStory } from "../../lib/story-records.mjs";

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

test("commits already on the remote story branch are not checked again", (t) => {
  const { root, start, context } = fixture(t);
  git(root, ["checkout", "-q", "-b", "feature", start]);
  const pushed = commitFile(root, "src/pushed.txt", "pushed\n", "already on the remote branch");
  const head = commitFile(root, "src/new.txt", "new\n", "new commit");

  // Without the remote tip both commits lack a receipt.
  const all = buildGitCommitCoverageProof(context, PROFILE, { base_sha: start, head_sha: head });
  assert.equal(all.proof, null);
  assert.equal(all.errors.length, 2);

  // With the remote tip only the new commit is checked, and still refused.
  const runtimeTarget = { base_sha: start, head_sha: head, remote_branch_sha: pushed };
  const built = buildGitCommitCoverageProof(context, PROFILE, runtimeTarget);
  assert.equal(built.proof, null);
  assert.equal(built.errors.length, 1);
  assert.match(built.errors[0], new RegExp(`Commit ${head} requires exactly one`, "u"));
  assert.doesNotMatch(built.errors[0], new RegExp(pushed, "u"));
  const legacy = gitCommitReceiptCoverageErrors(context, PROFILE, runtimeTarget, []);
  assert.equal(legacy.length, 1);
  assert.match(legacy[0], new RegExp(head, "u"));
});

test("a push with nothing new beyond the remote branch keeps the v1 proof", (t) => {
  const { root, start, context } = fixture(t);
  git(root, ["checkout", "-q", "-b", "feature", start]);
  const pushed = commitFile(root, "src/pushed.txt", "pushed\n", "already on the remote branch");
  const runtimeTarget = { base_sha: start, head_sha: pushed, remote_branch_sha: pushed };
  const built = buildGitCommitCoverageProof(context, PROFILE, runtimeTarget);
  assert.deepEqual(built.errors, []);
  assert.equal(built.proof.schema_version, "git-commit-coverage:v1");
  assert.equal(built.proof.remote_branch_sha, pushed);
  assert.deepEqual(built.proof.entries, []);
  assert.deepEqual(validateGitCommitCoverageProof(context, PROFILE, runtimeTarget, built.proof), []);
  assert.deepEqual(
    validateGitCommitCoverageProof(context, PROFILE, { ...runtimeTarget, remote_branch_sha: start }, built.proof),
    ["Git commit coverage proof is stale or invalid."],
  );
});

test("a remote branch tip missing from this clone excludes nothing", (t) => {
  const { root, start, context } = fixture(t);
  git(root, ["checkout", "-q", "-b", "feature", start]);
  const head = commitFile(root, "src/new.txt", "new\n", "new commit");
  const runtimeTarget = { base_sha: start, head_sha: head, remote_branch_sha: "f".repeat(40) };
  const built = buildGitCommitCoverageProof(context, PROFILE, runtimeTarget);
  assert.equal(built.proof, null);
  assert.match(built.errors.join("\n"), new RegExp(`Commit ${head} requires exactly one`, "u"));
  assert.equal(root.length > 0, true);
});

test("pull_request.create completion tolerates a base that only gained project records", (t) => {
  const { root, start } = fixture(t);
  const target = (baseSha, extra = {}) => ({ head_sha: "h".repeat(40), base_ref: "origin/main", base_sha: baseSha, ...extra });
  const records = commitFile(root, ".sdlc/stories/ST-X/record.json", "{}\n", "records");
  assert.equal(isBaseRecordsOnlyAdvance(root, target(start), target(records)), true);
  assert.equal(isBaseRecordsOnlyAdvance(root, target(start), target(start)), false);
  // Any other difference in the target still counts as a change.
  assert.equal(isBaseRecordsOnlyAdvance(root, target(start), target(records, { head_sha: "i".repeat(40) })), false);
  // A base that gained code is a real change.
  const code = commitFile(root, "src/app.txt", "app2\n", "code");
  assert.equal(isBaseRecordsOnlyAdvance(root, target(start), target(code)), false);
  assert.equal(isBaseRecordsOnlyAdvance(root, target(records), target(code)), false);
  // A base that moved backwards or sideways is not an advance.
  assert.equal(isBaseRecordsOnlyAdvance(root, target(records), target(start)), false);
});

test("baseAdvanceChangedPaths lists the sorted delta of a fast-forward base advance", (t) => {
  const { root, start } = fixture(t);
  const target = (baseSha, extra = {}) => ({ head_sha: "h".repeat(40), base_ref: "origin/main", base_sha: baseSha, ...extra });
  const records = commitFile(root, ".sdlc/stories/ST-X/record.json", "{}\n", "records");
  assert.deepEqual(baseAdvanceChangedPaths(root, target(start), target(records)), [".sdlc/stories/ST-X/record.json"]);
  commitFile(root, "evidence/ST-OTHER/report.md", "r\n", "other story evidence");
  const mixed = commitFile(root, "docs/a.md", "a\n", "docs");
  assert.deepEqual(
    baseAdvanceChangedPaths(root, target(start), target(mixed)),
    [".sdlc/stories/ST-X/record.json", "docs/a.md", "evidence/ST-OTHER/report.md"],
  );
  assert.equal(baseAdvanceChangedPaths(root, target(start), target(start)), null);
  assert.equal(baseAdvanceChangedPaths(root, target(mixed), target(start)), null);
  assert.equal(baseAdvanceChangedPaths(root, target(start), target(mixed, { head_sha: "i".repeat(40) })), null);
});

test("namesOtherStory separates another story's path from this story's", () => {
  const known = ["ST-1", "ST-1-A", "ST-QA-001D"];
  assert.equal(namesOtherStory("evidence/ST-QA-001D/report.md", ["ST-1"], known), true);
  assert.equal(namesOtherStory("evidence/ST-1/report.md", ["ST-1"], known), false);
  assert.equal(namesOtherStory("evidence/ST-1-A/report.md", ["ST-1"], known), false);
  assert.equal(namesOtherStory("evidence/ST-1-A/report.md", ["ST-1-A"], known), false);
  assert.equal(namesOtherStory("evidence/ST-1-A/report.md", ["ST-QA-001D"], known), true);
  assert.equal(namesOtherStory("evidence/shared.md", ["ST-1"], known), false);
});
