import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DELIVERY_COMMIT_TRACKING_ROOT, pinDeliveryCommits } from "../../lib/engine/delivery-commits.mjs";
import { forgetSharedRefState } from "../../lib/engine/shared-refs.mjs";
import { statusSyncLine, syncProjectForStatus } from "../../lib/engine/status-sync.mjs";
import { parseAheadBehind, statusSyncPolicy } from "../../lib/status-sync.mjs";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commit(cwd, file, content) {
  fs.writeFileSync(path.join(cwd, file), content);
  git(cwd, "add", file);
  git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", file);
}

/** A bare remote with two clones: `a` is the clone status runs in, `b` publishes other work. */
function twoClones(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "status-sync-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, "remote.git");
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  const a = path.join(root, "a");
  const b = path.join(root, "b");
  git(root, "clone", "-q", remote, a);
  git(a, "checkout", "-q", "-b", "main");
  commit(a, "README.md", "one\n");
  git(a, "push", "-q", "-u", "origin", "main");
  git(root, "clone", "-q", remote, b);
  forgetSharedRefState();
  return { a, b, context: { root: a, config: {} } };
}

test("the status sync policy fetches by default and validates its mode", () => {
  assert.deepEqual(statusSyncPolicy(undefined, () => {}), { mode: "fetch" });
  assert.deepEqual(statusSyncPolicy({ mode: "pull" }, () => {}), { mode: "pull" });
  for (const value of ["pull", { mode: "rebase" }, []]) {
    assert.throws(() => statusSyncPolicy(value, (message) => { throw new Error(message); }), /status_sync/u);
  }
  assert.deepEqual(parseAheadBehind("2\t5\n"), { ahead: 2, behind: 5 });
  assert.equal(parseAheadBehind("x"), null);
});

test("fetch reports work merged elsewhere without changing the checkout", (t) => {
  const { a, b, context } = twoClones(t);
  commit(b, "other.txt", "merged elsewhere\n");
  git(b, "push", "-q", "origin", "main");
  const head = git(a, "rev-parse", "HEAD");
  const sync = syncProjectForStatus(context, {}, {});
  assert.equal(sync.mode, "fetch");
  assert.equal(sync.outcome, "fetched");
  assert.equal(sync.upstream, "origin/main");
  assert.equal(sync.behind, 1);
  assert.equal(sync.head_changed, false);
  assert.equal(git(a, "rev-parse", "HEAD"), head);
  assert.match(statusSyncLine(sync, { italian: true }), /indietro di 1 commit/u);
});

test("pull fast-forwards only a branch that is strictly behind", (t) => {
  const { a, b, context } = twoClones(t);
  commit(b, "other.txt", "merged elsewhere\n");
  git(b, "push", "-q", "origin", "main");
  const pulled = syncProjectForStatus(context, { sync: "pull" }, {});
  assert.equal(pulled.outcome, "pulled");
  assert.equal(pulled.pulled_commits, 1);
  assert.equal(pulled.head_changed, true);
  assert.equal(fs.existsSync(path.join(a, "other.txt")), true);

  // Local commits not yet published: never merged or rebased by status.
  commit(b, "third.txt", "3\n");
  git(b, "push", "-q", "origin", "main");
  commit(a, "local.txt", "local\n");
  const head = git(a, "rev-parse", "HEAD");
  const diverged = syncProjectForStatus(context, { sync: "pull" }, {});
  assert.equal(diverged.outcome, "fetched");
  assert.equal(diverged.reason, "diverged");
  assert.equal(git(a, "rev-parse", "HEAD"), head);
});

test("an unreachable remote is a warning and off reads the clone as it is", (t) => {
  const { a, context } = twoClones(t);
  git(a, "remote", "set-url", "origin", path.join(a, "missing.git"));
  const failed = syncProjectForStatus(context, {}, {});
  assert.equal(failed.outcome, "failed");
  assert.match(statusSyncLine(failed), /cannot be reached/u);
  assert.equal(syncProjectForStatus(context, { sync: "off" }).outcome, "skipped");
  assert.throws(() => syncProjectForStatus(context, { sync: "rebase" }), /--sync/u);
  assert.equal(syncProjectForStatus(context, {}, { AGENTIC_SDLC_STATUS_SYNC: "off" }).outcome, "skipped");
  assert.throws(() => syncProjectForStatus(context, {}, { AGENTIC_SDLC_STATUS_SYNC: "rebase" }), /AGENTIC_SDLC_STATUS_SYNC/u);
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "status-sync-plain-"));
  t.after(() => fs.rmSync(plain, { recursive: true, force: true }));
  assert.equal(syncProjectForStatus({ root: plain, config: {} }, {}, {}).reason, "not_a_git_repository");
});

test("status fetches a delivered commit that a squash merge left on no branch", (t) => {
  const { a, b } = twoClones(t);
  // b delivers on a feature branch, pushes it, then the branch is squashed and deleted.
  git(b, "checkout", "-q", "-b", "feature");
  commit(b, "feature.txt", "story work\n");
  const delivered = git(b, "rev-parse", "HEAD");
  const before = git(b, "rev-parse", "HEAD~1");
  git(b, "push", "-q", "origin", "feature");
  git(b, "push", "-q", "origin", "--delete", "feature");
  git(b, "checkout", "-q", "main");
  // The receipt is a record on main, so a sees it without the commit.
  const sdlcRoot = path.join(a, ".sdlc");
  fs.mkdirSync(path.join(sdlcRoot, "autonomy", "actions"), { recursive: true });
  fs.writeFileSync(path.join(sdlcRoot, "autonomy", "actions", "AUT-ACT-1.json"), JSON.stringify({
    action: "git.commit",
    action_details: { commit: { before_sha: before, after_sha: delivered } },
  }));
  const context = { root: a, sdlcRoot, config: {} };
  assert.throws(() => git(a, "cat-file", "-e", `${delivered}^{commit}`));
  // The finishing computer pins it; a fetches it from the pin.
  const pinned = pinDeliveryCommits({ root: b }, { url: git(b, "remote", "get-url", "origin"), shas: [delivered, before], timeoutSeconds: 20 });
  assert.equal(pinned.error, null);
  assert.equal(pinned.pinned, 2);
  assert.equal(pinDeliveryCommits({ root: b }, { url: git(b, "remote", "get-url", "origin"), shas: [delivered], timeoutSeconds: 20 }).pinned, 0);
  const sync = syncProjectForStatus(context, {}, {});
  assert.equal(sync.delivery_commits.missing, 1);
  assert.equal(sync.delivery_commits.recovered, 1);
  assert.deepEqual(sync.delivery_commits.unavailable, []);
  assert.equal(git(a, "rev-parse", `${DELIVERY_COMMIT_TRACKING_ROOT}/${delivered}`), delivered);
  assert.equal(syncProjectForStatus(context, {}, {}).delivery_commits.missing, 0);
});

test("status fetches an unpinned delivered commit by its ID while the remote still has it", (t) => {
  const { a, b } = twoClones(t);
  git(b, "checkout", "-q", "-b", "feature");
  commit(b, "feature.txt", "story work\n");
  const delivered = git(b, "rev-parse", "HEAD");
  // Still reachable on the remote (as a pull-request ref would keep it), but never fetched by a.
  git(b, "push", "-q", "origin", "HEAD:refs/pull/14/head");
  const sdlcRoot = path.join(a, ".sdlc");
  fs.mkdirSync(path.join(sdlcRoot, "autonomy", "actions"), { recursive: true });
  fs.writeFileSync(path.join(sdlcRoot, "autonomy", "actions", "AUT-ACT-1.json"), JSON.stringify({
    action: "git.commit",
    action_details: { commit: { before_sha: git(b, "rev-parse", "HEAD~1"), after_sha: delivered } },
  }));
  fs.writeFileSync(path.join(sdlcRoot, "autonomy", "actions", "AUT-ACT-2.json"), JSON.stringify({
    action: "git.commit",
    action_details: { commit: { before_sha: delivered, after_sha: "e".repeat(40) } },
  }));
  const sync = syncProjectForStatus({ root: a, sdlcRoot, config: {} }, {}, {});
  assert.equal(sync.delivery_commits.missing, 2);
  assert.equal(sync.delivery_commits.recovered, 1);
  assert.deepEqual(sync.delivery_commits.unavailable, ["e".repeat(40)]);
  assert.equal(git(a, "cat-file", "-t", delivered), "commit");
});
