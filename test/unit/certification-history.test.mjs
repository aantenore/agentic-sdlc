import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { computeStableHash } from "../../lib/canonical.mjs";
import { localReleaseArtifactMatchesCompletion } from "../../lib/engine/delivery.mjs";
import { workflowFinalFreshnessGitScopeMatches } from "../../lib/engine/git.mjs";
import {
  WORKFLOW_FINAL_GIT_OBSERVATION_SCHEMA,
  WORKFLOW_FINAL_GIT_SCOPE_SCHEMA,
} from "../../lib/lifecycle/constants.mjs";
import {
  workflowFinalGitPathSuperseded,
  workflowFinalLocalReleasePathSuperseded,
  workflowFinalLocalReleaseScopeMatches,
} from "../../lib/lifecycle/workflow.mjs";

const ROOTS = [];
after(() => {
  for (const root of ROOTS) fs.rmSync(root, { recursive: true, force: true });
});

function workingTree(content) {
  return content === null
    ? { present: false, file_type: "missing", mode: null, content_sha256: null, object_id: null }
    : {
        present: true,
        file_type: "regular",
        mode: 0o644,
        content_sha256: computeStableHash(content),
        object_id: null,
      };
}

function scopedChange(filePath, content) {
  const missing = workingTree(null);
  return {
    path: filePath,
    working_tree: workingTree(content),
    index: missing,
    head: missing,
    index_matches_worktree: content === null,
    index_matches_head: true,
    index_flags: { assume_unchanged: false, skip_worktree: false },
  };
}

function gitRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-sdlc-certification-history-"));
  ROOTS.push(root);
  const git = (args) => childProcess.execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Fixture Author",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture Author",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  }).trim();
  git(["init", "-q"]);
  fs.writeFileSync(path.join(root, "README.md"), "fixture\n");
  git(["add", "README.md"]);
  git(["commit", "-q", "-m", "fixture"]);
  return { context: { root }, head: git(["rev-parse", "HEAD"]) };
}

function certifiedScope(head, changes) {
  return {
    schema_version: WORKFLOW_FINAL_GIT_SCOPE_SCHEMA,
    available: true,
    baseline_head_sha: head,
    certification_head_sha: head,
    scoped_changes: changes,
    scoped_state_hash: computeStableHash(changes),
    scoped_head_tree_hash: computeStableHash(
      changes.map((entry) => ({ path: entry.path, head: entry.head })),
    ),
  };
}

function observedScope(head, changes) {
  return {
    schema_version: WORKFLOW_FINAL_GIT_OBSERVATION_SCHEMA,
    available: true,
    baseline_head_sha: head,
    observed_head_sha: head,
    scoped_state_hash: computeStableHash(changes),
    scoped_head_tree_hash: null,
    scoped_changes: changes,
    history_touched_paths: [],
  };
}

test("a Git path is superseded only by the exact content a later certification binds", () => {
  const observed = scopedChange("src/app.mjs", "later");
  assert.equal(
    workflowFinalGitPathSuperseded(new Map([["src/app.mjs", workingTree("later")]]), "src/app.mjs", observed),
    true,
  );
  assert.equal(
    workflowFinalGitPathSuperseded(new Map([["src/app.mjs", workingTree("other")]]), "src/app.mjs", observed),
    false,
  );
  assert.equal(workflowFinalGitPathSuperseded(new Map(), "src/app.mjs", observed), false);
  assert.equal(workflowFinalGitPathSuperseded(null, "src/app.mjs", observed), false);
  assert.equal(
    workflowFinalGitPathSuperseded(new Map([["src/app.mjs", workingTree("later")]]), "src/app.mjs", null),
    false,
  );
});

test("certified Git scope accepts drift only on paths superseded with their current content", () => {
  const { context, head } = gitRepository();
  const certified = certifiedScope(head, [
    scopedChange("src/app.mjs", "first"),
    scopedChange("src/util.mjs", "first"),
  ]);
  const unchanged = observedScope(head, [
    scopedChange("src/app.mjs", "first"),
    scopedChange("src/util.mjs", "first"),
  ]);
  assert.equal(workflowFinalFreshnessGitScopeMatches(context, certified, unchanged), true);

  const evolved = observedScope(head, [
    scopedChange("src/app.mjs", "later"),
    scopedChange("src/new.mjs", "later"),
    scopedChange("src/util.mjs", "first"),
  ]);
  assert.equal(workflowFinalFreshnessGitScopeMatches(context, certified, evolved), false);
  const covered = new Map([
    ["src/app.mjs", workingTree("later")],
    ["src/new.mjs", workingTree("later")],
  ]);
  assert.equal(
    workflowFinalFreshnessGitScopeMatches(context, certified, evolved, { supersededPaths: covered }),
    true,
  );
  // A path added later but not certified by anyone keeps the receipt invalid.
  assert.equal(
    workflowFinalFreshnessGitScopeMatches(context, certified, evolved, {
      supersededPaths: new Map([["src/app.mjs", workingTree("later")]]),
    }),
    false,
  );
  // A later certification of other content does not cover the current content.
  assert.equal(
    workflowFinalFreshnessGitScopeMatches(context, certified, evolved, {
      supersededPaths: new Map([
        ["src/app.mjs", workingTree("other")],
        ["src/new.mjs", workingTree("later")],
      ]),
    }),
    false,
  );
  // Uncovered drift on another certified path stays invalid.
  const partial = observedScope(head, [
    scopedChange("src/app.mjs", "later"),
    scopedChange("src/util.mjs", "edited"),
  ]);
  assert.equal(
    workflowFinalFreshnessGitScopeMatches(context, certified, partial, {
      supersededPaths: new Map([["src/app.mjs", workingTree("later")]]),
    }),
    false,
  );
  // Supersession never repairs a tampered certified scope.
  const tampered = {
    ...certified,
    scoped_changes: [scopedChange("src/app.mjs", "later"), certified.scoped_changes[1]],
  };
  assert.equal(
    workflowFinalFreshnessGitScopeMatches(context, tampered, evolved, { supersededPaths: covered }),
    false,
  );
});

test("local release scopes accept only targets superseded with their exact snapshot", () => {
  const snapshot = (target, treeHash) => ({
    path: target,
    present: true,
    kind: "directory",
    file_count: 1,
    entry_count: 2,
    total_bytes: 10,
    tree_hash: treeHash,
  });
  const certified = [snapshot("/release/app", "a".repeat(64))];
  const observed = [snapshot("/release/app", "b".repeat(64))];
  assert.equal(workflowFinalLocalReleaseScopeMatches(certified, certified), true);
  assert.equal(workflowFinalLocalReleaseScopeMatches(certified, observed), false);
  const superseded = new Map([["/release/app", snapshot("/release/app", "b".repeat(64))]]);
  assert.equal(workflowFinalLocalReleaseScopeMatches(certified, observed, superseded), true);
  assert.equal(workflowFinalLocalReleasePathSuperseded(superseded, observed[0]), true);
  assert.equal(
    workflowFinalLocalReleaseScopeMatches(
      certified,
      observed,
      new Map([["/release/app", snapshot("/release/app", "c".repeat(64))]]),
    ),
    false,
  );
  assert.equal(
    workflowFinalLocalReleaseScopeMatches(
      certified,
      [snapshot("/release/other", "b".repeat(64))],
      new Map([["/release/other", snapshot("/release/other", "b".repeat(64))]]),
    ),
    false,
  );
  assert.equal(workflowFinalLocalReleaseScopeMatches(certified, [], superseded), false);
});

test("a released artifact matches its completion only through exact superseded snapshots", () => {
  const entry = (treeHash) => ({
    path: "/release/app",
    present: true,
    kind: "directory",
    file_count: 1,
    entry_count: 2,
    total_bytes: 10,
    tree_hash: treeHash,
  });
  const manifest = (treeHash, rootInode = "1") => ({
    schema_version: "local-release-artifact-manifest:v1",
    policy: { root_path: "/release", allowed_write_paths: ["/release/app"] },
    root_identity: { path: "/release", inode: rootInode },
    paths: [entry(treeHash)],
    hash_algorithm: "sha256:stable-json:v1",
    manifest_hash: computeStableHash({ treeHash, rootInode }),
  });
  const completed = manifest("a".repeat(64));
  const current = manifest("b".repeat(64));
  assert.equal(localReleaseArtifactMatchesCompletion(completed, completed), true);
  assert.equal(localReleaseArtifactMatchesCompletion(current, completed), false);
  const superseded = new Map([["/release/app", entry("b".repeat(64))]]);
  assert.equal(localReleaseArtifactMatchesCompletion(current, completed, superseded), true);
  assert.equal(
    localReleaseArtifactMatchesCompletion(
      current,
      completed,
      new Map([["/release/app", entry("c".repeat(64))]]),
    ),
    false,
  );
  // The release root identity and policy never change through supersession.
  assert.equal(
    localReleaseArtifactMatchesCompletion(manifest("b".repeat(64), "2"), completed, superseded),
    false,
  );
});
