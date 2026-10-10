import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { createProviderRegistry } from "../../lib/delivery/provider-registry.mjs";
import { createGitHubCliProvider } from "../../lib/delivery/providers/github-cli.mjs";
import { mergeResultBaseAdvanceAcceptor, pullRequestBaseBehindReason, recordedRuntimeTargetAccepted } from "../../lib/engine/delivery.mjs";
import { baselineDriftFromBase, validatePullRequestMergeRuntimeTransition } from "../../lib/engine/common.mjs";
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
  }), /differs from the local base/u);
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

test("merge recorded after the base advanced past the proven merge: accepted by ancestry, unrelated base refused", () => {
  const f = fixture();
  git(f.root, "checkout", "-q", "-b", "feature/ST-1", f.base0);
  const source = commit(f.root, { "app/x.js": "feature\n" }, "feature");
  git(f.root, "checkout", "-q", "main");
  git(f.root, "reset", "-q", "--hard", f.base0);
  const merged = commit(f.root, { "app/x.js": "feature\n" }, "squash");
  const records = commit(f.root, { ".sdlc/traces/project.jsonl": "{\"n\":2}\n" }, "records");
  const outside = commit(f.root, { "docs/y.md": "3\n" }, "outside");
  const inside = commit(f.root, { "app/x.js": "other\n" }, "inside");
  const runtime = (baseSha) => ({ branch: "feature/ST-1", head_sha: source, base_ref: "main", base_sha: baseSha, remotes: [] });
  const authorization = {
    runtime_target: runtime(f.base0),
    action_details: {
      merge: { source_sha: source, base_sha: f.base0 },
      provider_operation: { precondition_receipt: { subject: { base_sha: f.base0 }, proof: { base_sha: f.base0 } } },
    },
  };
  const proof = { merge_commit_sha: merged, base_sha: f.base0 };
  const options = { acceptBaseAdvance: mergeResultBaseAdvanceAcceptor(f.context, f.profile) };
  const check = (baseSha, opts = options) => validatePullRequestMergeRuntimeTransition(f.context, authorization, runtime(baseSha), proof, opts);

  assert.deepEqual(check(merged), { valid: true, mode: "squash", errors: [] });
  const recordsOnly = check(records);
  assert.equal(recordsOnly.valid, true);
  assert.equal(recordsOnly.base_advance.reason, "base_advanced_after_merge_ancestry");
  assert.equal(check(outside).base_advance.reason, "base_advanced_after_merge_ancestry");
  // Later commits inside the write paths cannot alter the completed merge.
  const insideAdvance = check(inside);
  assert.equal(insideAdvance.valid, true);
  assert.equal(insideAdvance.base_advance.reason, "base_advanced_after_merge_ancestry");
  assert.equal(insideAdvance.base_advance.local_base_sha, inside);
  // A local base that does not contain the proven merge is refused.
  git(f.root, "checkout", "-q", "-b", "unrelated", f.base0);
  const unrelated = commit(f.root, { "docs/z.md": "1\n" }, "unrelated");
  assert.equal(check(unrelated).valid, false);
  assert.equal(check(records, {}).valid, false);
  assert.equal(check(f.base0).mode, "base-tracking-stale");
});

test("stored pull_request.create receipt over an accepted base advance re-validates; inside-scope advance does not", () => {
  const f = fixture();
  const target = (baseSha) => ({ branch: "feature/ST-1", head_sha: "c".repeat(40), base_ref: "main", base_sha: baseSha });
  const accepted = (from, to, outside, action = "pull_request.create") => recordedRuntimeTargetAccepted(
    f.context, f.profile, action, target(from), target(to), outside,
  );
  assert.equal(accepted(f.base0, f.base0, undefined), true);
  assert.equal(accepted(f.base0, f.base0, ["docs/y.md"]), false);
  assert.equal(accepted(f.base0, f.records, undefined), true);
  assert.equal(accepted(f.base0, f.outside, ["docs/y.md", "evidence/ST-2-shot.txt"]), true);
  assert.equal(accepted(f.base0, f.outside, ["app/x.js"]), false);
  assert.equal(accepted(f.outside, f.inside, undefined), false);
  assert.equal(accepted(f.base0, f.records, undefined, "pull_request.update"), false);
});

test("git.push completed after the base advanced: records/outside accepted, inside or unrelated base refused", () => {
  const f = fixture();
  const target = (baseSha) => ({ branch: "feature/ST-1", head_sha: "c".repeat(40), base_ref: "main", base_sha: baseSha });
  const accepted = (from, to, outside) => recordedRuntimeTargetAccepted(f.context, f.profile, "git.push", target(from), target(to), outside);
  assert.equal(accepted(f.base0, f.records, undefined), true);
  assert.equal(accepted(f.base0, f.outside, ["docs/y.md", "evidence/ST-2-shot.txt"]), true);
  assert.equal(accepted(f.base0, f.inside, undefined), false);
  assert.equal(accepted(f.inside, f.base0, undefined), false);
  // A different head is never a base advance.
  assert.equal(recordedRuntimeTargetAccepted(f.context, f.profile, "git.push", target(f.base0), { ...target(f.records), head_sha: "d".repeat(40) }, undefined), false);
});

test("merge commit whose base advanced before the merge: first parent from an accepted advance, second the authorized head", () => {
  const build = (otherFiles) => {
    const f = fixture();
    git(f.root, "checkout", "-q", "-b", "feature/ST-1", f.base0);
    const source = commit(f.root, { "app/z.js": "feature\n" }, "feature");
    git(f.root, "checkout", "-q", "main");
    git(f.root, "reset", "-q", "--hard", f.base0);
    const firstParent = commit(f.root, otherFiles, "other PR");
    git(f.root, "merge", "-q", "--no-ff", "-m", "merge PR", source);
    const merged = git(f.root, "rev-parse", "HEAD");
    const runtime = (baseSha) => ({ branch: "feature/ST-1", head_sha: source, base_ref: "main", base_sha: baseSha, remotes: [] });
    const authorization = {
      runtime_target: runtime(f.base0),
      action_details: {
        merge: { source_sha: source, base_sha: f.base0 },
        provider_operation: { precondition_receipt: { subject: { base_sha: f.base0 }, proof: { base_sha: f.base0 } } },
      },
    };
    const check = (proof = { merge_commit_sha: merged, base_sha: f.base0 }, opts = { acceptBaseAdvance: mergeResultBaseAdvanceAcceptor(f.context, f.profile) }) =>
      validatePullRequestMergeRuntimeTransition(f.context, authorization, runtime(merged), proof, opts);
    return { f, check, merged, firstParent };
  };
  const records = build({ ".sdlc/stories/ST-2/claim.json": "{}\n" });
  const ok = records.check();
  assert.equal(ok.valid, true);
  assert.equal(ok.mode, "merge-commit");
  assert.equal(ok.base_advance_before_merge.reason, "base_advanced_before_merge_records_only");
  assert.equal(ok.base_advance_before_merge.first_parent_sha, records.firstParent);
  assert.equal(build({ "docs/y.md": "9\n" }).check().base_advance_before_merge.reason, "base_advanced_before_merge_outside_write_paths");
  assert.equal(build({ "app/x.js": "9\n" }).check().valid, false);
  assert.equal(records.check(undefined, {}).valid, false);
});

test("merge commit whose base gained code inside the write paths before the merge: accepted only with an overlap review", async () => {
  const { computeStableHash } = await import("../../lib/canonical.mjs");
  const f = fixture();
  git(f.root, "checkout", "-q", "-b", "feature/ST-1", f.base0);
  const source = commit(f.root, { "app/z.js": "feature\n" }, "feature");
  git(f.root, "checkout", "-q", "-b", "feature/ST-2", f.base0);
  const otherHead = commit(f.root, { "app/x.js": "other story\n" }, "ST-2 work");
  git(f.root, "checkout", "-q", "main");
  git(f.root, "reset", "-q", "--hard", f.base0);
  git(f.root, "merge", "-q", "--no-ff", "-m", "Merge pull request #79 from acme/feature/ST-2", otherHead);
  const firstParent = git(f.root, "rev-parse", "HEAD");
  git(f.root, "merge", "-q", "--no-ff", "-m", "merge PR", source);
  const merged = git(f.root, "rev-parse", "HEAD");
  // A merge whose second parent is not the authorized head.
  git(f.root, "checkout", "-q", "-b", "wrong", firstParent);
  git(f.root, "merge", "-q", "--no-ff", "-m", "wrong", git(f.root, "rev-parse", "feature/ST-1~1"));
  const wrongMerge = git(f.root, "rev-parse", "HEAD");
  const runtime = (baseSha) => ({ branch: "feature/ST-1", head_sha: source, base_ref: "main", base_sha: baseSha, remotes: [] });
  const authorization = {
    runtime_target: runtime(f.base0),
    action_details: {
      merge: { source_sha: source, base_sha: f.base0 },
      provider_operation: { precondition_receipt: { subject: { base_sha: f.base0 }, proof: { base_sha: f.base0 } } },
    },
  };
  const check = (mergeSha = merged) => validatePullRequestMergeRuntimeTransition(
    f.context, authorization, runtime(mergeSha), { merge_commit_sha: mergeSha, base_sha: f.base0 },
    { acceptBaseAdvance: mergeResultBaseAdvanceAcceptor(f.context, f.profile) },
  );

  const refused = check();
  assert.equal(refused.valid, false);
  assert.match(refused.errors.join("; "), /app\/x\.js/u);
  assert.match(refused.errors.join("; "), /story overlap confirm --id ST-1/u);

  const writeReview = (overlap) => {
    const review = {
      schema: "story-overlap-review:v1", id: "OVR-1", story_id: "ST-1", summary: "checked",
      overlaps: [{ kind: "write_scope", delivery_profile_id: "AUT-2", sha256: "a".repeat(64), ...overlap }],
      created_at: "2026-10-10T00:00:00.000Z",
    };
    review.review_hash = computeStableHash(review);
    const dir = path.join(f.root, ".sdlc/stories/ST-1/overlap-reviews");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "OVR-1.json"), JSON.stringify(review));
  };
  // A review of an unrelated file and delivery covers nothing.
  writeReview({ path: "app/other.js", story_id: "ST-9", merge_commit_sha: "e".repeat(40) });
  assert.equal(check().valid, false);
  // Covered by the story that introduced it.
  writeReview({ path: "app/other.js", story_id: "ST-2", merge_commit_sha: "e".repeat(40) });
  const byStory = check();
  assert.equal(byStory.valid, true);
  assert.equal(byStory.mode, "merge-commit");
  assert.equal(byStory.base_advance_before_merge.reason, "base_advanced_before_merge_overlap_confirmed");
  // Covered by the commit, and by the file itself.
  writeReview({ path: "app/other.js", story_id: "ST-9", merge_commit_sha: firstParent });
  assert.equal(check().valid, true);
  writeReview({ path: "app/x.js", story_id: "ST-9", merge_commit_sha: "e".repeat(40) });
  assert.equal(check().valid, true);
  // A wrong second parent stays refused even with the review.
  assert.equal(check(wrongMerge).valid, false);
});
