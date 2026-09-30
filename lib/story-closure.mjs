import {
  DomainValidationError,
  immutableJson,
  normalizeIsoInstant,
  requireNonEmptyString,
  requirePlainRecord,
} from "./canonical.mjs";

export const STORY_CLOSURE_SCHEMA = "story-closure:v1";
export const STORY_CLOSURE_EVENTS = Object.freeze(["superseded", "cancelled"]);

const SHA256 = /^[a-f0-9]{64}$/u;

// The approval of a closure binds this exact subject: which never-started
// stories are closed, why, by which replacement, and from which breakdown.
export function buildStoryClosureSubject(input) {
  requirePlainRecord(input, "story_closure.subject");
  const event = normalizeStoryClosureEvent(input.event);
  const stories = normalizeRefList(input.stories, "story_closure.subject.stories");
  if (stories.length === 0) {
    throw new DomainValidationError("story_closure.subject.stories must name at least one story");
  }
  const replacement = input.replacement === null || input.replacement === undefined
    ? null
    : normalizeRef(input.replacement, "story_closure.subject.replacement");
  if (event === "superseded" && !replacement) {
    throw new DomainValidationError("A superseded story closure must name its replacement story");
  }
  if (event === "cancelled" && replacement) {
    throw new DomainValidationError("A cancelled story closure cannot name a replacement story");
  }
  if (replacement && stories.some((ref) => ref.id === replacement.id)) {
    throw new DomainValidationError("A story cannot be superseded by itself");
  }
  const breakdown = input.breakdown === null || input.breakdown === undefined
    ? null
    : normalizeRef(input.breakdown, "story_closure.subject.breakdown");
  return immutableJson({
    event,
    stories,
    replacement,
    breakdown,
    reason: requireNonEmptyString(input.reason, "story_closure.subject.reason"),
  });
}

export function buildStoryClosure(input) {
  requirePlainRecord(input, "story_closure");
  const subject = buildStoryClosureSubject(input.subject);
  const storyId = requireNonEmptyString(input.story_id, "story_closure.story_id");
  if (!subject.stories.some((ref) => ref.id === storyId)) {
    throw new DomainValidationError(`story_closure.subject does not include story ${storyId}`);
  }
  return immutableJson({
    id: requireNonEmptyString(input.id, "story_closure.id"),
    kind: "story_closure",
    schema_version: STORY_CLOSURE_SCHEMA,
    event: subject.event,
    story_id: storyId,
    replacement_id: subject.replacement?.id || null,
    subject,
    approval: input.approval ?? {},
    created_at: normalizeIsoInstant(input.created_at, "story_closure.created_at"),
    audit: input.audit ?? {},
  });
}

export function normalizeStoryClosureEvent(value) {
  const event = String(value || "").trim().toLowerCase();
  if (!STORY_CLOSURE_EVENTS.includes(event)) {
    throw new DomainValidationError(
      `story closure event must be one of ${STORY_CLOSURE_EVENTS.join(", ")}`,
    );
  }
  return event;
}

function normalizeRefList(value, label) {
  if (!Array.isArray(value)) {
    throw new DomainValidationError(`${label} must be an array`);
  }
  const refs = value.map((item, index) => normalizeRef(item, `${label}[${index}]`));
  const ids = new Set();
  for (const ref of refs) {
    if (ids.has(ref.id)) {
      throw new DomainValidationError(`${label} names ${ref.id} more than once`);
    }
    ids.add(ref.id);
  }
  return refs.sort((left, right) => left.id.localeCompare(right.id, "en"));
}

function normalizeRef(value, label) {
  requirePlainRecord(value, label);
  const contentHash = requireNonEmptyString(value.content_hash, `${label}.content_hash`);
  if (!SHA256.test(contentHash)) {
    throw new DomainValidationError(`${label}.content_hash must be a lowercase SHA-256 digest`);
  }
  return {
    id: requireNonEmptyString(value.id, `${label}.id`),
    path: requireNonEmptyString(value.path, `${label}.path`),
    content_hash: contentHash,
  };
}
