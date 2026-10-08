import {
  computeStableHash,
  isPlainRecord,
} from "./canonical.mjs";
import {
  reviewerAuthorConflicts,
} from "./code-review.mjs";
import {
  sealSharedPayload,
} from "./shared-ref-records.mjs";
import {
  plainSharedText,
} from "./story-claim-shared-state.mjs";

/**
 * Code reviews shared between computers. A `code-review:v1` record is written
 * on the computer where the reviewer ran `review record`; `review publish`
 * shares it, only when someone runs that command, as a ref on the project's
 * git remote:
 *
 *   refs/agentic-sdlc/reviews/<profile id>/<profile hash>/<review id>
 *
 * The ref points at a parentless commit with an empty tree whose message is
 * the sealed payload, so publishing never touches a branch, and in particular
 * never the pull request's head branch. Each ref is created only if it does
 * not exist yet. Received reviews are kept in local tracking refs under
 * refs/agentic-sdlc-shared/reviews/, never pruned or overwritten.
 *
 * A received review is accepted for the merge evaluation only when it is
 * valid here: readable, matching the code-review:v1 schema and its own record
 * hash, bound to this exact delivery profile revision and repository, made at
 * the head being merged, and by a reviewer independent of the authors of the
 * range as read from this repository (the record's own commit_authors are
 * ignored). Its verdict is not a reason to ignore it: a valid independent
 * `changes_requested` is accepted too, so the merge evaluation, which decides
 * by the latest independent verdict, can see it.
 *
 * This module holds the pure rules (ref names, payload, acceptance); running
 * git lives in lib/engine/review-shared.mjs.
 */

export const REVIEW_SHARED_REF_ROOT = "refs/agentic-sdlc/reviews";
export const REVIEW_SHARED_TRACKING_ROOT = "refs/agentic-sdlc-shared/reviews";
export const REVIEW_SHARED_KIND = "code_review_shared";
export const REVIEW_SHARED_VERSION = 1;

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;

function comparable(value) {
  return String(value ?? "").trim().toLowerCase();
}

/** One ref folder segment: safe ids as they are, others spelled safely and kept apart by a short hash. */
function refSegment(value, label) {
  const text = String(value);
  if (SAFE_SEGMENT.test(text)) return text;
  return `${text.replace(/[^A-Za-z0-9_-]/gu, "_")}-${computeStableHash({ [label]: text }).slice(0, 12)}`;
}

/**
 * One namespace per delivery profile revision: the id keeps refs readable and
 * the first 16 hex digits of the profile hash keep two revisions apart.
 */
export function reviewProfileNamespace(profile) {
  const hash = String(profile?.profile_hash || "").replace(/^sha256:/u, "").replace(/[^0-9a-f]/giu, "").slice(0, 16);
  return `${refSegment(profile?.id, "delivery_profile_id")}/${hash || "unknown"}`;
}

/** The last ref segment that names one review. */
export function reviewRefSegment(reviewId) {
  return refSegment(reviewId, "review_id");
}

/** Path below the reviews root that holds every shared review of one delivery profile revision. */
export function sharedReviewPrefix(profile) {
  return `${reviewProfileNamespace(profile)}/`;
}

export function sharedReviewRef(profile, reviewId) {
  return `${REVIEW_SHARED_REF_ROOT}/${reviewProfileNamespace(profile)}/${reviewRefSegment(reviewId)}`;
}

/** Maps a shared review ref to the tracking ref that keeps it here. */
export function sharedReviewTrackingRef(ref) {
  return `${REVIEW_SHARED_TRACKING_ROOT}/${String(ref).slice(REVIEW_SHARED_REF_ROOT.length + 1)}`;
}

/** Tracking-ref prefix of one delivery profile revision. */
export function sharedReviewTrackingPrefix(profile) {
  return `${REVIEW_SHARED_TRACKING_ROOT}/${sharedReviewPrefix(profile)}`;
}

/** The review segment of a shared or tracking ref. */
export function sharedReviewRefId(ref) {
  return String(ref || "").split("/").pop();
}

/** Names one shared review in messages. */
export function describeSharedReviewRef(ref) {
  return `shared review ${sharedReviewRefId(ref)}`;
}

/** The sealed payload that carries one review record. */
export function buildSharedReviewPayload({ profile, review }) {
  return sealSharedPayload({
    kind: REVIEW_SHARED_KIND,
    version: REVIEW_SHARED_VERSION,
    delivery_profile_id: String(profile.id),
    delivery_profile_hash: String(profile.profile_hash),
    repository: String(profile.pull_request_target?.repository ?? review.repository),
    review,
  });
}

/** True when a record still matches its own record hash. */
export function reviewRecordHashMatches(review) {
  if (!isPlainRecord(review) || typeof review.record_hash !== "string") return false;
  const { record_hash: recordHash, ...unhashed } = review;
  return computeStableHash(unhashed) === recordHash;
}

/**
 * Decides whether one received review is valid evidence here.
 *
 * `payload` is the parsed sealed payload (null when unreadable). `schemaValid`
 * says whether `payload.review` matches code-review.schema.json (checked by
 * the engine, which reads the schema). `authors` are the authors of the range
 * being merged, read from this repository. `ref`, when given, is the shared
 * ref the payload came from; its last segment must name the review.
 *
 * Returns `{ accepted: true, review }` or `{ accepted: false, reason }`.
 * Reasons are only about validity: the verdict is left to evaluateMergeReviews.
 */
export function evaluateReceivedReview(payload, { profile, repository, headSha, authors, schemaValid = false, ref = null } = {}) {
  const reject = (reason) => ({ accepted: false, reason });
  if (!isPlainRecord(payload)) {
    return reject("the shared record cannot be read (it is missing, malformed, or was changed after it was written)");
  }
  if (payload.kind !== REVIEW_SHARED_KIND || payload.version !== REVIEW_SHARED_VERSION) {
    return reject("the shared record is not a code review this version can read");
  }
  const review = payload.review;
  if (!isPlainRecord(review)) return reject("the shared record carries no review");
  if (schemaValid !== true) return reject("the review does not match the code-review:v1 schema");
  if (!reviewRecordHashMatches(review)) return reject("the review's record_hash does not match its content");
  if (ref !== null && sharedReviewRefId(ref) !== reviewRefSegment(review.id)) {
    return reject(`the review id ${plainSharedText(review.id)} does not match its shared ref name`);
  }
  const profileId = String(profile?.id ?? "");
  if (payload.delivery_profile_id !== profileId || review.delivery_profile_id !== profileId) {
    return reject(`the review is for delivery profile ${plainSharedText(review.delivery_profile_id)}, not ${profileId}`);
  }
  if (payload.delivery_profile_hash !== profile?.profile_hash) {
    return reject(`the review was shared for another revision of delivery profile ${profileId} (profile hash ${plainSharedText(payload.delivery_profile_hash, 16)}…)`);
  }
  const expectedRepository = String(repository ?? "");
  if (payload.repository !== expectedRepository || review.repository !== expectedRepository) {
    return reject(`the review is for repository ${plainSharedText(review.repository)}, not ${expectedRepository}`);
  }
  if (!headSha) return reject("the head commit being merged is unknown");
  if (comparable(review.reviewed_head_sha) !== comparable(headSha)) {
    return reject(
      `the review covers head ${plainSharedText(review.reviewed_head_sha, 12)}, not the current head ${String(headSha).slice(0, 12)}`,
    );
  }
  if (!Array.isArray(authors)) {
    return reject("the authors of the reviewed range are unknown, so reviewer independence cannot be proven");
  }
  if (reviewerAuthorConflicts(review.reviewer, authors).length > 0) {
    return reject(
      `the reviewer ${plainSharedText(review.reviewer?.actor_id)} <${plainSharedText(review.reviewer?.git_email)}> `
      + "also authored commits in the reviewed range",
    );
  }
  return { accepted: true, review };
}
