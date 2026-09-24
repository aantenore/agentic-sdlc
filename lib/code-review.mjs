/**
 * Code review evidence rules shared by `review record` and the
 * pull_request.merge gate.
 *
 * Everything here is pure: callers read the repository and the stored records,
 * and these functions decide. A review is bound to one exact head commit, and
 * its reviewer must be independent of every author of the reviewed range.
 */

export const CODE_REVIEW_VERDICTS = Object.freeze(["approved", "changes_requested"]);
export const CODE_REVIEW_FINDING_SEVERITIES = Object.freeze(["blocking", "major", "minor", "note"]);

function comparable(value) {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * Parse `git log --format=%an%x00%ae` output into unique author identities,
 * sorted so the same range always yields the same list.
 */
export function parseCommitAuthors(logOutput) {
  const seen = new Map();
  for (const line of String(logOutput || "").split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const [name = "", email = ""] = line.split("\u0000");
    const identity = { name: name.trim(), email: email.trim() };
    seen.set(`${comparable(identity.name)}\u0000${comparable(identity.email)}`, identity);
  }
  return [...seen.values()].sort((left, right) =>
    left.email.localeCompare(right.email, "en") || left.name.localeCompare(right.name, "en"));
}

/**
 * List every way the reviewer overlaps an author of the reviewed range.
 *
 * The reviewer's git email must differ from every author email, and the
 * reviewer's actor id must match neither an author email nor an author name.
 * Comparison ignores case and surrounding space, so a reviewer cannot become
 * independent by changing capitalization.
 */
export function reviewerAuthorConflicts(reviewer, authors) {
  const conflicts = [];
  const actorId = comparable(reviewer?.actor_id);
  const email = comparable(reviewer?.git_email);
  for (const author of authors || []) {
    const authorEmail = comparable(author.email);
    const authorName = comparable(author.name);
    if (email && email === authorEmail) {
      conflicts.push({ field: "git_email", author });
    }
    if (actorId && (actorId === authorEmail || actorId === authorName)) {
      conflicts.push({ field: "actor_id", author });
    }
  }
  return conflicts;
}

/**
 * Validate and normalize review findings supplied as JSON objects.
 * Throws a TypeError naming the first invalid finding.
 */
export function normalizeCodeReviewFindings(rawFindings) {
  return (rawFindings || []).map((raw, index) => {
    let finding = raw;
    if (typeof raw === "string") {
      try {
        finding = JSON.parse(raw);
      } catch {
        throw new TypeError(`finding ${index + 1} is not valid JSON`);
      }
    }
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
      throw new TypeError(`finding ${index + 1} must be a JSON object`);
    }
    const unknown = Object.keys(finding).filter((key) => !["severity", "summary", "path", "line"].includes(key));
    if (unknown.length > 0) {
      throw new TypeError(`finding ${index + 1} has unsupported field(s): ${unknown.join(", ")}`);
    }
    if (!CODE_REVIEW_FINDING_SEVERITIES.includes(finding.severity)) {
      throw new TypeError(`finding ${index + 1} severity must be one of ${CODE_REVIEW_FINDING_SEVERITIES.join(", ")}`);
    }
    if (typeof finding.summary !== "string" || !finding.summary.trim()) {
      throw new TypeError(`finding ${index + 1} needs a non-empty summary`);
    }
    if (finding.line !== undefined && finding.line !== null
      && (!Number.isSafeInteger(finding.line) || finding.line < 1)) {
      throw new TypeError(`finding ${index + 1} line must be a positive integer`);
    }
    return {
      severity: finding.severity,
      summary: finding.summary.trim(),
      path: typeof finding.path === "string" && finding.path.trim() ? finding.path.trim() : null,
      line: finding.line ?? null,
    };
  });
}

/**
 * Decide whether stored reviews allow merging one delivery at one head.
 *
 * Only reviews for this delivery profile and this exact head count. Among
 * them, the latest verdict of an independent reviewer decides: a later
 * `changes_requested` withdraws an earlier approval. Reviews by an author of
 * the range are reported but never counted.
 *
 * @returns {{ allowed: boolean, reason: string, review: object|null, conflicts: object[] }}
 */
export function evaluateMergeReviews(records, { deliveryProfileId, headSha, authors }) {
  const forHead = (records || []).filter((record) =>
    record?.kind === "code_review"
    && record.delivery_profile_id === deliveryProfileId
    && comparable(record.reviewed_head_sha) === comparable(headSha));
  if (forHead.length === 0) {
    return { allowed: false, reason: "no_review_for_head", review: null, conflicts: [] };
  }
  const independent = [];
  let lastConflict = null;
  for (const record of forHead) {
    const conflicts = reviewerAuthorConflicts(record.reviewer, authors);
    if (conflicts.length > 0) lastConflict = { record, conflicts };
    else independent.push(record);
  }
  if (independent.length === 0) {
    return { allowed: false, reason: "reviewer_is_author", review: lastConflict.record, conflicts: lastConflict.conflicts };
  }
  const latest = independent
    .slice()
    .sort((left, right) =>
      String(left.reviewed_at || "").localeCompare(String(right.reviewed_at || ""), "en")
      || String(left.id || "").localeCompare(String(right.id || ""), "en"))
    .at(-1);
  if (latest.verdict !== "approved") {
    return { allowed: false, reason: "changes_requested", review: latest, conflicts: [] };
  }
  return { allowed: true, reason: "approved", review: latest, conflicts: [] };
}
