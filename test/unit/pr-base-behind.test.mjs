import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { createProviderRegistry } from "../../lib/delivery/provider-registry.mjs";
import { createGitHubCliProvider } from "../../lib/delivery/providers/github-cli.mjs";
import { pullRequestBaseBehindReason } from "../../lib/engine/delivery.mjs";
import { baselineDriftFromBase } from "../../lib/engine/common.mjs";
import { deliveryProviderOperationSubject } from "../../lib/lifecycle/delivery.mjs";

function git(root, ...args) {
  return childProcess.execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function commit(root, files, message) {
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-base-behind-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.invalid");
  git(root, "config", "user.name", "t");
  const base0 = commit(root, { "app/x.js": "1\n", "docs/y.md": "1\n" }, "base");
  const records = commit(root, { ".sdlc/traces/project.jsonl": "{}\n" }, "records");
  const outside = commit(root, { "docs/y.md": "2\n", "evidence/ST-2-shot.txt": "x\n" }, "outside");
  const inside = commit(root, { "app/x.js": "2\n" }, "inside");
  const context = { root, sdlcRoot: path.join(root, ".sdlc"), config: {} };
  const profile = { constraints: { allowed_write_paths: ["app", "evidence"] }, story_refs: [{ id: "ST-1" }] };
  return { root, context, profile, base0, records, outside, inside };
}

test("PR base behind the local base: records-only and outside write paths accepted, inside refused", () => {
  const f = fixture();
  assert.equal(pullRequestBaseBehindReason(f.context, f.profile, f.base0, f.records), "pr_base_behind_records_only");
  assert.equal(pullRequestBaseBehindReason(f.context, f.profile, f.records, f.outside), "pr_base_behind_outside_write_paths");
  assert.equal(pullRequestBaseBehindReason(f.context, f.profile, f.outside, f.inside), null);
  assert.equal(pullRequestBaseBehindReason(f.context, f.profile, f.inside, f.base0), null);

  let merged = false;
  const open = {
    url: "https://github.com/acme/app/pull/74",
    state: "OPEN",
    isDraft: false,
    headRefOid: "c".repeat(40),
    headRefName: "feature/ST-1",
    baseRefName: "main",
    baseRefOid: f.base0,
  };
  const registry = createProviderRegistry([createGitHubCliProvider({
    commandRunner: () => JSON.stringify(merged
      ? { ...open, state: "MERGED", mergedAt: "2026-07-18T10:00:30.000Z", mergeCommit: { oid: "d".repeat(40) } }
      : open),
  })]);
  const subject = {
    repository: "github.com/acme/app",
    pr_url: open.url,
    head_branch: "feature/ST-1",
    base_branch: "main",
    base_sha: f.records,
    source_sha: open.headRefOid,
    authorized_at: "2026-07-18T10:00:00.000Z",
  };
  const op = (observedAt) => ({ id: "PR-MERGE-74", action: "pull_request.merge", subject, observed_at: observedAt });
  const accept = (prBase, localBase) => pullRequestBaseBehindReason(f.context, f.profile, prBase, localBase);
  const precondition = registry.observePrecondition("github-cli", op("2026-07-18T10:00:01.000Z"), { acceptPullRequestBaseBehind: accept });
  assert.equal(precondition.proof.base_sha, f.records);
  assert.deepEqual(precondition.proof.base_behind, {
    reason: "pr_base_behind_records_only", pr_base_sha: f.base0, local_base_sha: f.records,
  });
  merged = true;
  const completion = registry.verifyCompletion("github-cli", op("2026-07-18T10:01:00.000Z"), precondition);
  assert.equal(completion.proof.base_sha, f.records);
  assert.equal(completion.proof.base_behind.pr_base_sha, f.base0);

  merged = false;
  assert.throws(() => registry.observePrecondition("github-cli", op("2026-07-18T10:00:01.000Z"), {
    acceptPullRequestBaseBehind: () => null,
  }), /exact open GitHub PR/u);
});

test("pull_request.create carries an explicit --pr-url into the provider subject", () => {
  const profile = { pull_request_target: { repository: "github.com/acme/app", head_branch: "f", base_branch: "main" } };
  const url = "https://github.com/acme/app/pull/74";
  const withUrl = deliveryProviderOperationSubject({}, profile, "pull_request.create", { source_sha: "c".repeat(40), pull_request: { pr_url: url } }, "t");
  const without = deliveryProviderOperationSubject({}, profile, "pull_request.create", { source_sha: "c".repeat(40), pull_request: { pr_url: null } }, "t");
  assert.equal(withUrl.pr_url, url);
  assert.equal(Object.hasOwn(without, "pr_url"), false);
});

test("baseline drift is accepted only when the committed file matches the base branch", () => {
  const f = fixture();
  const profile = { pull_request_target: { base_branch: "main" } };
  assert.deepEqual(baselineDriftFromBase(f.context, profile, "app/x.js")?.base_ref, "main");
  fs.writeFileSync(path.join(f.root, "app/x.js"), "local\n");
  assert.equal(baselineDriftFromBase(f.context, profile, "app/x.js"), null);
});
