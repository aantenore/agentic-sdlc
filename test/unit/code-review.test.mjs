import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateMergeReviews,
  normalizeCodeReviewFindings,
  parseCommitAuthors,
  reviewerAuthorConflicts,
} from "../../lib/code-review.mjs";

const HEAD = "c".repeat(40);
const AUTHORS = [{ name: "Maria Rossi", email: "maria@example.test" }];

function review(overrides = {}) {
  return {
    kind: "code_review",
    id: "R-1",
    delivery_profile_id: "DAP-1",
    reviewed_head_sha: HEAD,
    reviewer: { actor_id: "luca", actor_type: "human", git_name: "Luca", git_email: "luca@example.test" },
    verdict: "approved",
    reviewed_at: "2026-09-16T10:00:00.000Z",
    ...overrides,
  };
}

test("commit authors are parsed, deduplicated, and sorted", () => {
  const log = "Maria Rossi\u0000maria@example.test\nAnna\u0000anna@example.test\nMaria Rossi\u0000maria@example.test\n";
  assert.deepEqual(parseCommitAuthors(log), [
    { name: "Anna", email: "anna@example.test" },
    { name: "Maria Rossi", email: "maria@example.test" },
  ]);
  assert.deepEqual(parseCommitAuthors(""), []);
});

test("a reviewer sharing an author's email or naming an author as actor is not independent", () => {
  assert.deepEqual(reviewerAuthorConflicts(review().reviewer, AUTHORS), []);
  const sameEmail = { ...review().reviewer, git_email: " MARIA@example.test " };
  assert.equal(reviewerAuthorConflicts(sameEmail, AUTHORS)[0].field, "git_email");
  const actorIsAuthor = { ...review().reviewer, actor_id: "maria@example.test" };
  assert.equal(reviewerAuthorConflicts(actorIsAuthor, AUTHORS)[0].field, "actor_id");
});

test("only an approval of the exact head by an independent reviewer allows a merge", () => {
  const context = { deliveryProfileId: "DAP-1", headSha: HEAD, authors: AUTHORS };
  assert.equal(evaluateMergeReviews([], context).reason, "no_review_for_head");
  assert.equal(evaluateMergeReviews([review({ reviewed_head_sha: "d".repeat(40) })], context).reason, "no_review_for_head");
  assert.equal(evaluateMergeReviews([review({ delivery_profile_id: "DAP-2" })], context).reason, "no_review_for_head");
  const selfReview = review({ reviewer: { ...review().reviewer, git_email: "maria@example.test" } });
  assert.equal(evaluateMergeReviews([selfReview], context).reason, "reviewer_is_author");
  assert.equal(evaluateMergeReviews([review()], context).allowed, true);
  assert.equal(evaluateMergeReviews([selfReview, review()], context).allowed, true);
});

test("the latest independent verdict decides", () => {
  const context = { deliveryProfileId: "DAP-1", headSha: HEAD, authors: AUTHORS };
  const withdrawn = [
    review(),
    review({ id: "R-2", verdict: "changes_requested", reviewed_at: "2026-09-16T11:00:00.000Z" }),
  ];
  assert.equal(evaluateMergeReviews(withdrawn, context).reason, "changes_requested");
  const reapproved = [...withdrawn, review({ id: "R-3", reviewed_at: "2026-09-16T12:00:00.000Z" })];
  assert.equal(evaluateMergeReviews(reapproved, context).allowed, true);
});

test("findings are validated and normalized", () => {
  assert.deepEqual(normalizeCodeReviewFindings(['{"severity":"minor","summary":" Rename "}']), [
    { severity: "minor", summary: "Rename", path: null, line: null },
  ]);
  assert.throws(() => normalizeCodeReviewFindings(["not json"]), /not valid JSON/u);
  assert.throws(() => normalizeCodeReviewFindings(['{"severity":"urgent","summary":"x"}']), /severity/u);
  assert.throws(() => normalizeCodeReviewFindings(['{"severity":"note","summary":"x","line":0}']), /line/u);
  assert.throws(() => normalizeCodeReviewFindings(['{"severity":"note","summary":"x","extra":1}']), /unsupported/u);
});
