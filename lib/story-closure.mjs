import {
  DomainValidationError,
  immutableJson,
  normalizeIsoInstant,
  requireNonEmptyString,
  requirePlainRecord,
} from "./canonical.mjs";

export const STORY_CLOSURE_SCHEMA = "story-closure:v1";
// A story split into several replacements. Version 1 records stay readable;
// a single replacement is still written as version 1.
export const STORY_CLOSURE_SCHEMA_V2 = "story-closure:v2";
export const STORY_CLOSURE_EVENTS = Object.freeze(["superseded", "cancelled"]);

const SHA256 = /^[a-f0-9]{64}$/u;

// Terminal outcomes that leave no delivered work behind. A released, merged,
// or ready-for-review delivery is finished through lifecycle certification.
export const STARTED_CLOSURE_DELIVERY_STATUSES = Object.freeze([
  "cancelled",
  "closed",
  "revoked",
  "rolled_back",
  "superseded",
]);

// The approval of a closure binds this exact subject: which stories are
// closed, why, by which replacement, from which breakdown, and, for a story
// whose work already started, the terminal evidence that let it close.
export function buildStoryClosureSubject(input) {
  requirePlainRecord(input, "story_closure.subject");
  const event = normalizeStoryClosureEvent(input.event);
  const stories = normalizeRefList(input.stories, "story_closure.subject.stories");
  if (stories.length === 0) {
    throw new DomainValidationError("story_closure.subject.stories must name at least one story");
  }
  const replacements = normalizeReplacements(input);
  if (event === "superseded" && replacements.length === 0) {
    throw new DomainValidationError("A superseded story closure must name its replacement story");
  }
  if (event === "cancelled" && replacements.length > 0) {
    throw new DomainValidationError("A cancelled story closure cannot name a replacement story");
  }
  if (replacements.some((replacement) => stories.some((ref) => ref.id === replacement.id))) {
    throw new DomainValidationError("A story cannot be superseded by itself");
  }
  const breakdown = input.breakdown === null || input.breakdown === undefined
    ? null
    : normalizeRef(input.breakdown, "story_closure.subject.breakdown");
  const startedWork = input.started_work === null || input.started_work === undefined
    ? null
    : normalizeStartedWork(input.started_work, "story_closure.subject.started_work");
  if (startedWork && (stories.length !== 1 || stories[0].id !== startedWork.story_id)) {
    throw new DomainValidationError("A started story is closed on its own, with its own started-work evidence");
  }
  if (startedWork && breakdown) {
    throw new DomainValidationError("A started story cannot be closed together with a breakdown");
  }
  return immutableJson({
    event,
    stories,
    ...(replacements.length > 1
      ? { replacements }
      : { replacement: replacements[0] || null }),
    breakdown,
    reason: requireNonEmptyString(input.reason, "story_closure.subject.reason"),
    ...(startedWork ? { started_work: startedWork } : {}),
  });
}

// One replacement is kept as `replacement`; several become `replacements`,
// sorted, which only a version 2 closure carries.
function normalizeReplacements(input) {
  const single = input.replacement === null || input.replacement === undefined ? null : input.replacement;
  const several = input.replacements === null || input.replacements === undefined ? null : input.replacements;
  if (single && several) {
    throw new DomainValidationError("story_closure.subject names both replacement and replacements");
  }
  if (several) {
    const refs = normalizeRefList(several, "story_closure.subject.replacements");
    if (refs.length === 1) {
      throw new DomainValidationError("story_closure.subject.replacements needs at least two stories; use replacement for one");
    }
    return refs;
  }
  return single ? [normalizeRef(single, "story_closure.subject.replacement")] : [];
}

/** The replacement stories of a closure subject or record, in id order. */
export function storyClosureReplacementIds(value) {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value.replacement_ids)) return [...value.replacement_ids];
  if (Array.isArray(value.replacements)) return value.replacements.map((ref) => ref.id);
  if (value.replacement && typeof value.replacement === "object") return [value.replacement.id];
  return typeof value.replacement_id === "string" && value.replacement_id ? [value.replacement_id] : [];
}

// Evidence that a started story ended without an active delivery: the exact
// task start, every bound delivery with its terminal close receipt, and the
// work assignment the closure released. The approval binds all of it.
function normalizeStartedWork(value, label) {
  requirePlainRecord(value, label);
  const storyId = requireNonEmptyString(value.story_id, `${label}.story_id`);
  const taskStart = value.task_start === null || value.task_start === undefined
    ? null
    : normalizeFileRef(value.task_start, `${label}.task_start`);
  // An abandoned story delivered nothing and names no delivery at all.
  if (!Array.isArray(value.deliveries)) {
    throw new DomainValidationError(`${label}.deliveries must name every terminal delivery of the story`);
  }
  const deliveries = value.deliveries.map((delivery, index) => {
    const itemLabel = `${label}.deliveries[${index}]`;
    requirePlainRecord(delivery, itemLabel);
    const terminalStatus = requireNonEmptyString(delivery.terminal_status, `${itemLabel}.terminal_status`);
    if (!STARTED_CLOSURE_DELIVERY_STATUSES.includes(terminalStatus)) {
      throw new DomainValidationError(
        `${itemLabel}.terminal_status must be one of ${STARTED_CLOSURE_DELIVERY_STATUSES.join(", ")}`,
      );
    }
    const profileHash = requireNonEmptyString(delivery.profile_hash, `${itemLabel}.profile_hash`);
    if (!SHA256.test(profileHash)) {
      throw new DomainValidationError(`${itemLabel}.profile_hash must be a lowercase SHA-256 digest`);
    }
    // A revoked delivery that never started has no close receipt; its
    // revocation record is the evidence instead.
    if (delivery.close_receipt === null || delivery.close_receipt === undefined) {
      if (terminalStatus !== "revoked") {
        throw new DomainValidationError(`${itemLabel}.close_receipt is required unless the delivery was revoked before it started`);
      }
      return {
        id: requireNonEmptyString(delivery.id, `${itemLabel}.id`),
        profile_hash: profileHash,
        terminal_status: terminalStatus,
        close_receipt: null,
        revocation: normalizeFileRef(delivery.revocation, `${itemLabel}.revocation`),
      };
    }
    return {
      id: requireNonEmptyString(delivery.id, `${itemLabel}.id`),
      profile_hash: profileHash,
      terminal_status: terminalStatus,
      close_receipt: normalizeFileRef(delivery.close_receipt, `${itemLabel}.close_receipt`),
    };
  }).sort((left, right) => left.id.localeCompare(right.id, "en"));
  if (new Set(deliveries.map((delivery) => delivery.id)).size !== deliveries.length) {
    throw new DomainValidationError(`${label}.deliveries names a delivery more than once`);
  }
  const claim = value.claim === null || value.claim === undefined
    ? null
    : (() => {
        requirePlainRecord(value.claim, `${label}.claim`);
        return {
          path: requireNonEmptyString(value.claim.path, `${label}.claim.path`),
          agent: value.claim.agent === null || value.claim.agent === undefined
            ? null
            : requireNonEmptyString(value.claim.agent, `${label}.claim.agent`),
          status_before: requireNonEmptyString(value.claim.status_before, `${label}.claim.status_before`),
        };
      })();
  return {
    story_id: storyId,
    task_start: taskStart,
    deliveries,
    claim,
  };
}

function normalizeFileRef(value, label) {
  requirePlainRecord(value, label);
  const hash = requireNonEmptyString(value.sha256, `${label}.sha256`);
  if (!SHA256.test(hash)) {
    throw new DomainValidationError(`${label}.sha256 must be a lowercase SHA-256 digest`);
  }
  return {
    path: requireNonEmptyString(value.path, `${label}.path`),
    sha256: hash,
  };
}

export function buildStoryClosure(input) {
  requirePlainRecord(input, "story_closure");
  const subject = buildStoryClosureSubject(input.subject);
  const storyId = requireNonEmptyString(input.story_id, "story_closure.story_id");
  if (!subject.stories.some((ref) => ref.id === storyId)) {
    throw new DomainValidationError(`story_closure.subject does not include story ${storyId}`);
  }
  const split = Array.isArray(subject.replacements);
  return immutableJson({
    id: requireNonEmptyString(input.id, "story_closure.id"),
    kind: "story_closure",
    schema_version: split ? STORY_CLOSURE_SCHEMA_V2 : STORY_CLOSURE_SCHEMA,
    event: subject.event,
    // Mirrors the event so readers that only look at `status` see a closed story.
    status: subject.event,
    story_id: storyId,
    // A split names no single replacement: version 1 readers must not follow one.
    replacement_id: split ? null : subject.replacement?.id || null,
    ...(split ? { replacement_ids: subject.replacements.map((ref) => ref.id) } : {}),
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
