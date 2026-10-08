import assert from "node:assert/strict";
import test from "node:test";

import { computeStableHash } from "../../lib/canonical.mjs";
import {
  REVIEW_SHARED_KIND,
  REVIEW_SHARED_REF_ROOT,
  REVIEW_SHARED_TRACKING_ROOT,
  buildSharedReviewPayload,
  evaluateReceivedReview,
  reviewProfileNamespace,
  reviewRecordHashMatches,
  sharedReviewRef,
  sharedReviewTrackingRef,
} from "../../lib/code-review-shared-state.mjs";
import { parseSharedPayload, serializeSharedPayload } from "../../lib/shared-ref-records.mjs";

const HEAD = "c".repeat(40);
const REPOSITORY = "github.com/example/project";
const PROFILE = Object.freeze({
  id: "AUT-REVIEW",
  profile_hash: "0123456789abcdef".repeat(4),
  pull_request_target: { repository: REPOSITORY },
});
const AUTHORS = Object.freeze([{ name: "Review Author", email: "author@example.invalid" }]);

function review(overrides = {}) {
  const record = {
    kind: "code_review",
    schema_version: "code-review:v1",
    id: "ST-REVIEW-code-review-1",
    delivery_profile_id: PROFILE.id,
    repository: REPOSITORY,
    reviewed_head_sha: HEAD,
    commit_authors: [],
    reviewer: { actor_id: "luca", actor_type: "human", git_name: "Luca", git_email: "luca@example.invalid" },
    verdict: "approved",
    reviewed_at: "2026-10-08T12:00:00.000Z",
    ...overrides,
  };
  return { ...record, record_hash: computeStableHash(record) };
}

function received(record = review(), profile = PROFILE) {
  return parseSharedPayload(serializeSharedPayload(buildSharedReviewPayload({ profile, review: record })));
}

function evaluate(payload, overrides = {}) {
  return evaluateReceivedReview(payload, {
    profile: PROFILE,
    repository: REPOSITORY,
    headSha: HEAD,
    authors: AUTHORS,
    schemaValid: true,
    ref: sharedReviewRef(PROFILE, payload?.review?.id ?? "x"),
    ...overrides,
  });
}

test("shared review refs live in one namespace per delivery profile revision, never under refs/heads", () => {
  assert.equal(reviewProfileNamespace(PROFILE), "AUT-REVIEW/0123456789abcdef");
  const ref = sharedReviewRef(PROFILE, "ST-REVIEW-code-review-1");
  assert.equal(ref, `${REVIEW_SHARED_REF_ROOT}/AUT-REVIEW/0123456789abcdef/ST-REVIEW-code-review-1`);
  assert.equal(sharedReviewTrackingRef(ref), `${REVIEW_SHARED_TRACKING_ROOT}/AUT-REVIEW/0123456789abcdef/ST-REVIEW-code-review-1`);
  // Ids with characters git refuses in some positions are spelled safely and kept apart.
  const dotted = sharedReviewRef(PROFILE, "review.1");
  assert.match(dotted, /\/review_1-[0-9a-f]{12}$/u);
  assert.notEqual(dotted, sharedReviewRef(PROFILE, "review_1"));
  assert.notEqual(
    reviewProfileNamespace(PROFILE),
    reviewProfileNamespace({ ...PROFILE, profile_hash: "f".repeat(64) }),
  );
});

test("a valid independent review of the head is accepted, whatever its verdict", () => {
  const approved = evaluate(received());
  assert.equal(approved.accepted, true);
  assert.equal(approved.review.verdict, "approved");
  const changes = evaluate(received(review({ verdict: "changes_requested" })));
  assert.equal(changes.accepted, true, "a changes_requested review is left to the merge evaluation");
  assert.equal(received().kind, REVIEW_SHARED_KIND);
  assert.equal(reviewRecordHashMatches(received().review), true);
});

test("a received review is ignored with a specific reason when it is not valid here", () => {
  const cases = [
    [null, {}, /cannot be read/u],
    [{ ...received(), kind: "story_claim_shared_claim" }, {}, /not a code review/u],
    [{ ...received(), review: "nope" }, {}, /carries no review/u],
    [received(), { schemaValid: false }, /code-review:v1 schema/u],
    [{ ...received(), review: { ...review(), verdict: "changes_requested" } }, {}, /record_hash does not match/u],
    [received(), { ref: sharedReviewRef(PROFILE, "another-review") }, /does not match its shared ref name/u],
    [received(review({ delivery_profile_id: "AUT-OTHER" })), {}, /delivery profile AUT-OTHER, not AUT-REVIEW/u],
    [received(review(), { ...PROFILE, profile_hash: "f".repeat(64) }), {}, /another revision of delivery profile AUT-REVIEW/u],
    [received(review({ repository: "github.com/example/fork" })), {}, /repository github\.com\/example\/fork/u],
    [received(), { headSha: "d".repeat(40) }, /covers head cccccccccccc, not the current head dddddddddddd/u],
    [received(), { headSha: null }, /head commit being merged is unknown/u],
    [received(), { authors: null }, /independence cannot be proven/u],
    [received(review({ reviewer: { actor_id: "author", actor_type: "human", git_name: "A", git_email: "AUTHOR@example.invalid" } })), {}, /also authored commits/u],
    [received(review({ reviewer: { actor_id: "Review Author", actor_type: "human", git_name: "A", git_email: "other@example.invalid" } })), {}, /also authored commits/u],
  ];
  for (const [payload, overrides, reason] of cases) {
    const decision = evaluate(payload, overrides);
    assert.equal(decision.accepted, false, String(reason));
    assert.match(decision.reason, reason);
  }
});

test("independence is proven against the authors read here, not the record's own list", () => {
  const record = review({ commit_authors: [] });
  const decision = evaluate(received(record), { authors: [{ name: "Luca", email: "luca@example.invalid" }] });
  assert.equal(decision.accepted, false);
  assert.match(decision.reason, /also authored commits/u);
});

test("text from another computer is shown without control characters", () => {
  const decision = evaluate(received(review({ delivery_profile_id: "AUT-\u001b[31mRED" })));
  assert.equal(decision.accepted, false);
  assert.doesNotMatch(decision.reason, /\u001b/u);
});
