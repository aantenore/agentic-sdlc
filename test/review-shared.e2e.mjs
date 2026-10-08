import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { AGENT_HOSTS, AGENT_HOST_OVERRIDE_ENV } from "../lib/agent-host.mjs";
import { computeStableHash } from "../lib/canonical.mjs";
import { sealSharedPayload, serializeSharedPayload } from "../lib/shared-ref-records.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(repoRoot, "bin", "agentic-sdlc.mjs");
const tempPaths = new Set();

const PROFILE_ID = "AUT-REVIEW";
const STORY_ID = "ST-REVIEW";
const HEAD_BRANCH = "codex/pr-review";
const AUTHOR = Object.freeze({ name: "Review Author", email: "author@example.invalid" });
const REVIEWER = Object.freeze({ actor: "luca", name: "Luca Reviewer", email: "luca@example.invalid" });
const REVIEWS_ROOT = "refs/agentic-sdlc/reviews/";
const ISOLATED_ENVIRONMENT_KEYS = [
  "CI",
  "GITHUB_ACTIONS",
  "GITHUB_ACTOR",
  AGENT_HOST_OVERRIDE_ENV,
  ...AGENT_HOSTS.flatMap((host) => [...host.markers, ...Object.values(host.env).filter(Boolean)]),
];

after(() => {
  if (process.env.AGENTIC_SDLC_KEEP_TEST_TMP === "1") return;
  for (const entry of tempPaths) fs.rmSync(entry, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function tmpDirectory(name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `sdlc-review-shared-${name}-`));
  tempPaths.add(directory);
  return directory;
}

function run(args, options = {}) {
  const env = { ...process.env };
  for (const key of ISOLATED_ENVIRONMENT_KEYS) delete env[key];
  Object.assign(env, options.env || {});
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function mustRun(args, options = {}) {
  const result = run(args, options);
  assert.equal(result.status, 0, `${args.join(" ")}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result;
}

function mustRunJson(args, options = {}) {
  return JSON.parse(mustRun([...args, "--json"], options).stdout);
}

function git(directory, args, input = undefined) {
  const result = spawnSync("git", ["-C", directory, ...args], { encoding: "utf8", timeout: 60_000, input });
  assert.equal(result.status, 0, `git ${args.join(" ")}\n${result.stderr}`);
  return result.stdout.trim();
}

function humanApproval(summary) {
  return ["--actor-type", "human", "--approval-source", "explicit-user", "--summary", summary];
}

/** Git identity override for one CLI invocation, without touching the fixture's config. */
function gitIdentityEnv(identity) {
  return {
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "user.name",
    GIT_CONFIG_VALUE_0: identity.name,
    GIT_CONFIG_KEY_1: "user.email",
    GIT_CONFIG_VALUE_1: identity.email,
  };
}

/** Every ref the remote holds, as "<object> <ref>" lines sorted by ref. */
function remoteRefs(remote) {
  return git(remote, ["for-each-ref", "--format=%(objectname) %(refname)"]).split("\n").filter(Boolean).sort();
}

function remoteReviewRefs(remote) {
  return remoteRefs(remote).filter((line) => line.split(" ")[1].startsWith(REVIEWS_ROOT));
}

function setCoordination(project, coordination) {
  const configPath = path.join(project, ".sdlc", "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.orchestration_policy = {
    ...config.orchestration_policy,
    coordination: { ...config.orchestration_policy?.coordination, ...coordination },
  };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  const preview = mustRunJson(["config", "migrate", "--root", project]);
  mustRunJson(["config", "migrate", "--root", project, "--apply", "--plan-hash", preview.plan.plan_hash, "--actor-type", "system"]);
}

/**
 * One pull-request delivery worked on from two computers. `origin` names the
 * GitHub repository the delivery targets (never written to); `team` is a
 * local bare repository standing in for the remote the team coordinates
 * through. The second computer is a copy of the first, so both hold the same
 * approved delivery profile.
 */
function sharedDelivery() {
  const first = tmpDirectory("first");
  const remote = tmpDirectory("remote");
  git(remote, ["init", "--quiet", "--bare"]);
  mustRun(["init", "--root", first, "--project-name", "Review Sharing E2E", "--force"]);
  setCoordination(first, { mode: "auto", remote: "team" });
  git(first, ["init", "--quiet"]);
  git(first, ["config", "user.name", AUTHOR.name]);
  git(first, ["config", "user.email", AUTHOR.email]);
  git(first, ["config", "commit.gpgSign", "false"]);
  git(first, ["commit", "--quiet", "--allow-empty", "-m", "test: establish PR base"]);
  git(first, ["branch", "-M", "main"]);
  git(first, ["remote", "add", "origin", "https://github.com/aantenore/agentic-sdlc.git"]);
  git(first, ["remote", "add", "team", remote]);
  git(first, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  git(first, ["checkout", "--quiet", "-b", HEAD_BRANCH]);

  mustRunJson([
    "requirement", "propose", "--root", first,
    "--id", "REQ-REVIEW",
    "--title", "Merge only reviewed diffs",
    "--summary", "Every pull request is reviewed by someone other than its author before it merges.",
    "--acceptance", "A merge without an independent review is refused.",
    "--autonomy-ceiling", "bounded-autonomous",
    "--write-path", "src",
  ]);
  mustRunJson(["requirement", "approve", "--root", first, "--id", "REQ-REVIEW", ...humanApproval("Approve the requirement")]);
  mustRun(["output", "template", "propose", "--root", first, "--type", "implementation-summary", "--summary", "Implementation evidence"]);
  mustRun(["output", "template", "approve", "--root", first, "--id", "implementation-summary-v1", ...humanApproval("Approve the format")]);
  mustRunJson([
    "story", "create", "--root", first,
    "--id", STORY_ID,
    "--title", "Implement the reviewed change",
    "--phase", "implementation",
    "--status", "ready",
    "--requirement", "REQ-REVIEW",
    "--acceptance", "The change is merged only after an independent review.",
  ]);
  mustRunJson([
    "contract", "create", "--root", first,
    "--phase", "implementation",
    "--story", STORY_ID,
    "--id", "CONTRACT-REVIEW",
    "--delivery-profile", PROFILE_ID,
    "--level", "bounded-autonomous",
    "--context-summary", "Implement the change inside the reviewed delivery boundary.",
    "--qa", "Who reviews the diff?|A reviewer who is not an author",
    "--output-ref", "implementation-summary:implementation-summary-v1:new",
    "--tool", "node",
  ]);
  mustRunJson(["contract", "approve", "--root", first, "--id", "CONTRACT-REVIEW", ...humanApproval("Approve the contract")]);
  mustRunJson([
    "autonomy", "delivery", "propose", "--root", first,
    "--id", PROFILE_ID,
    "--delivery", "PR-REVIEW",
    "--kind", "pull_request",
    "--story", STORY_ID,
    "--contract", "CONTRACT-REVIEW",
    "--requirement", "REQ-REVIEW",
    "--level", "checkpointed",
    "--repository", "aantenore/agentic-sdlc",
    "--base", "main",
    "--head", HEAD_BRANCH,
    "--write-path", "src",
    "--allow-action", "pull_request.merge",
    "--merge-allowed",
    "--code-review", "required",
    "--code-review-actor-type", "human",
    "--code-review-approval-source", "explicit-user",
    "--code-review-summary", "Yes, review before merge",
  ]);
  mustRunJson(["autonomy", "delivery", "approve", "--root", first, "--id", PROFILE_ID, ...humanApproval("Approve the merge delivery")]);

  fs.mkdirSync(path.join(first, "src"), { recursive: true });
  fs.writeFileSync(path.join(first, "src", "change.txt"), "reviewed change\n", "utf8");
  git(first, ["add", "--", "src"]);
  git(first, ["commit", "--quiet", "-m", "feat: the change under review"]);
  // The branches as the team sees them, so publishing can be shown to leave them alone.
  git(first, ["push", "--quiet", "team", "main", HEAD_BRANCH]);

  const second = tmpDirectory("second");
  fs.rmSync(second, { recursive: true, force: true });
  fs.cpSync(first, second, { recursive: true });
  return { first, second, remote };
}

function record(project, { verdict = "approved", identity = null, actor = null } = {}) {
  return mustRunJson([
    "review", "record", "--root", project,
    "--delivery", PROFILE_ID,
    "--verdict", verdict,
    ...(actor ? ["--actor", actor] : []),
    "--actor-type", "human",
  ], identity ? { env: gitIdentityEnv(identity) } : {});
}

function publish(project, extra = []) {
  return mustRunJson(["review", "publish", "--root", project, "--delivery", PROFILE_ID, ...extra]);
}

function fetchReviews(project) {
  return mustRunJson(["review", "fetch", "--root", project, "--delivery", PROFILE_ID]);
}

function traceEvents(project) {
  const tracePath = path.join(project, ".sdlc", "traces", `${STORY_ID}.jsonl`);
  return fs.readFileSync(tracePath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/** Pushes a hand-made record commit to the remote, as someone bypassing the CLI would. */
function pushForgedRecord(project, remote, ref, message) {
  const tree = git(project, ["hash-object", "-t", "tree", "-w", "--stdin"], "");
  const commit = git(project, ["commit-tree", tree, "-F", "-"], message);
  git(project, ["push", "--quiet", remote, `${commit}:${ref}`]);
}

test("a review reaches another computer only through review publish, and no branch is touched", () => {
  const { first, second, remote } = sharedDelivery();
  const headSha = git(first, ["rev-parse", "HEAD"]);

  // Recording a review shares nothing by itself.
  const recorded = record(second, { identity: REVIEWER, actor: REVIEWER.actor });
  assert.equal(recorded.independent, true);
  assert.deepEqual(remoteReviewRefs(remote), [], "review record never pushes");

  const before = remoteRefs(remote);
  const published = publish(second);
  assert.equal(published.status, "published");
  assert.equal(published.remote, "team");
  assert.deepEqual(published.reviews.map((item) => [item.review_id, item.status]), [[recorded.code_review.id, "published"]]);
  const ref = published.reviews[0].ref;
  assert.ok(ref.startsWith(`${REVIEWS_ROOT}${PROFILE_ID}/`), ref);
  assert.ok(ref.endsWith(`/${recorded.code_review.id}`), ref);

  // Only the review ref was added: every branch (the PR head included) and every other ref is unchanged.
  const afterPublish = remoteRefs(remote);
  assert.deepEqual(afterPublish.filter((line) => !line.split(" ")[1].startsWith(REVIEWS_ROOT)), before);
  assert.equal(remoteReviewRefs(remote).length, 1);
  assert.equal(git(remote, ["rev-parse", `refs/heads/${HEAD_BRANCH}`]), headSha);
  // The record is a parentless commit with an empty tree.
  assert.equal(git(remote, ["rev-list", "--parents", "-n", "1", ref]).split(" ").length, 1);
  assert.equal(git(remote, ["rev-parse", `${ref}^{tree}`]), git(remote, ["hash-object", "-t", "tree", "--stdin"]));
  const payload = JSON.parse(git(remote, ["log", "-1", "--format=%B", ref]));
  assert.equal(payload.kind, "code_review_shared");
  assert.equal(payload.delivery_profile_id, PROFILE_ID);
  assert.equal(payload.review.record_hash, recorded.code_review.record_hash);

  // The first computer receives it and accepts it for its current head.
  const fetched = fetchReviews(first);
  assert.equal(fetched.status, "fetched");
  assert.equal(fetched.source, "shared");
  assert.equal(fetched.remote, "team");
  assert.equal(fetched.head_sha, headSha);
  assert.deepEqual(fetched.accepted.map((item) => [item.review_id, item.verdict, item.reviewer.git_email]), [
    [recorded.code_review.id, "approved", REVIEWER.email],
  ]);
  assert.deepEqual(fetched.ignored, []);
  assert.equal(fs.existsSync(path.join(first, ".sdlc", "reviews", `${recorded.code_review.id}.json`)), false, "no record file is written");
  const fetchEvent = traceEvents(first).filter((event) => event.action === "review.fetch").at(-1);
  assert.ok(fetchEvent, "review fetch is traced");
  assert.ok(fetchEvent.narrative.input_summaries.includes("source: shared"));
  assert.ok(fetchEvent.narrative.input_summaries.includes("remote: team"));
  assert.deepEqual(remoteRefs(remote), afterPublish, "review fetch never pushes");

  // Publishing again changes nothing on the remote.
  const again = publish(second);
  assert.deepEqual(again.reviews.map((item) => item.status), ["already_present"]);
  assert.deepEqual(remoteRefs(remote), afterPublish);

  // A new commit on the head: the received review no longer covers what would be merged.
  fs.writeFileSync(path.join(first, "src", "later.txt"), "unreviewed follow-up\n", "utf8");
  git(first, ["add", "--", "src/later.txt"]);
  git(first, ["commit", "--quiet", "-m", "feat: an unreviewed follow-up"]);
  const moved = fetchReviews(first);
  assert.deepEqual(moved.accepted, []);
  assert.equal(moved.ignored.length, 1);
  assert.match(moved.ignored[0].reason, new RegExp(`covers head ${headSha.slice(0, 12)}, not the current head`, "u"));
});

test("received reviews that are not valid here are ignored with the reason, and an unreachable remote is reported", () => {
  const { first, second, remote } = sharedDelivery();
  const selfReview = record(second);
  assert.equal(selfReview.independent, false);
  const independent = record(second, { identity: REVIEWER, actor: REVIEWER.actor });
  const published = publish(second, ["--review", selfReview.code_review.id]);
  assert.deepEqual(published.reviews.map((item) => item.review_id), [selfReview.code_review.id]);
  const all = publish(second);
  assert.deepEqual(
    Object.fromEntries(all.reviews.map((item) => [item.review_id, item.status])),
    { [selfReview.code_review.id]: "already_present", [independent.code_review.id]: "published" },
  );

  const validRef = all.reviews.find((item) => item.review_id === independent.code_review.id).ref;
  const namespace = validRef.split("/").slice(0, -1).join("/");
  const valid = JSON.parse(git(remote, ["log", "-1", "--format=%B", validRef]));
  const { payload_hash: _payloadHash, ...unsealed } = valid;
  const reHashed = (review) => {
    const { record_hash: _recordHash, ...content } = review;
    return { ...content, record_hash: computeStableHash(content) };
  };

  // Edited after sealing: the payload no longer matches its own hash.
  pushForgedRecord(second, remote, `${namespace}/tampered`, `${JSON.stringify({
    ...valid,
    review: { ...valid.review, id: "tampered", summary: "edited on the way" },
  })}\n`);
  // Resealed, but the review's own record hash was not recomputed.
  pushForgedRecord(second, remote, `${namespace}/forged-hash`, serializeSharedPayload(sealSharedPayload({
    ...unsealed,
    review: { ...valid.review, id: "forged-hash" },
  })));
  // A review of another revision of the delivery profile.
  pushForgedRecord(second, remote, `${namespace}/other-profile`, serializeSharedPayload(sealSharedPayload({
    ...unsealed,
    delivery_profile_hash: "f".repeat(64),
    review: reHashed({ ...valid.review, id: "other-profile" }),
  })));

  const fetched = fetchReviews(first);
  assert.deepEqual(fetched.accepted.map((item) => item.review_id), [independent.code_review.id]);
  const reasons = Object.fromEntries(fetched.ignored.map((item) => [item.review_id, item.reason]));
  assert.match(reasons.tampered, /cannot be read/u);
  assert.match(reasons["forged-hash"], /record_hash does not match/u);
  assert.match(reasons["other-profile"], /another revision of delivery profile AUT-REVIEW/u);
  assert.match(reasons[selfReview.code_review.id], /also authored commits in the reviewed range/u);
  assert.equal(Object.keys(reasons).length, 4);

  // The remote cannot be reached: reported, not a crash, and reviews received earlier still count.
  git(first, ["remote", "set-url", "team", path.join(remote, "missing")]);
  const unreachable = run(["review", "fetch", "--root", first, "--delivery", PROFILE_ID, "--json"]);
  assert.equal(unreachable.status, 1, unreachable.stderr);
  const report = JSON.parse(unreachable.stdout);
  assert.equal(report.status, "unavailable");
  assert.equal(report.available, false);
  assert.match(report.error, /\S/u);
  assert.deepEqual(report.accepted.map((item) => item.review_id), [independent.code_review.id]);
  assert.doesNotMatch(unreachable.stderr, /\n\s+at /u, "no stack trace");

  git(second, ["remote", "set-url", "team", path.join(remote, "missing")]);
  const notPublished = run(["review", "publish", "--root", second, "--delivery", PROFILE_ID, "--json"]);
  assert.equal(notPublished.status, 1, notPublished.stderr);
  const publishReport = JSON.parse(notPublished.stdout);
  assert.equal(publishReport.status, "incomplete");
  assert.ok(publishReport.reviews.every((item) => item.status === "not_published"));

  // With sharing turned off, publishing is refused and says why, in both languages.
  setCoordination(second, { mode: "local_only" });
  const refused = run(["review", "publish", "--root", second, "--delivery", PROFILE_ID]);
  assert.equal(refused.status, 1);
  assert.match(`${refused.stdout}\n${refused.stderr}`, /sharing is turned off/u);
  const refusedIt = run(["review", "publish", "--root", second, "--delivery", PROFILE_ID, "--locale", "it"]);
  assert.match(`${refusedIt.stdout}\n${refusedIt.stderr}`, /non sono state condivise/u);
});
