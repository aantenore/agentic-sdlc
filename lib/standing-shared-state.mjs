import {
  COORDINATION_DEFAULTS,
  COORDINATION_MODES,
  coordinationPolicy,
  parseSharedPayload,
  sealSharedPayload,
  serializeSharedPayload,
} from "./shared-ref-records.mjs";

export { serializeSharedPayload };

/**
 * Shared state of standing approvals. Lock files serialize processes on one
 * checkout only, so the slots a standing approval has used and its
 * revocation are also published as refs on a git remote that every clone
 * reaches. A ref is created only if it does not exist yet, which makes the
 * remote the single arbiter of which delivery holds which slot. This module
 * holds the pure rules (policy, ref names, payloads, and coverage reasons);
 * running git lives in the engine.
 */

export const STANDING_SHARED_REF_ROOT = "refs/agentic-sdlc/standing";
export const STANDING_SHARED_TRACKING_ROOT = "refs/agentic-sdlc-shared/standing";
export const STANDING_COORDINATION_MODES = COORDINATION_MODES;
export const STANDING_COORDINATION_DEFAULTS = COORDINATION_DEFAULTS;

const SLOT_KIND = "standing_approval_shared_slot";
const REVOCATION_KIND = "standing_approval_shared_revocation";
const PAYLOAD_VERSION = 1;
const SLOT_REF_PATTERN = /\/slots\/([0-9]{4})$/u;

export class StandingCoordinationError extends Error {
  constructor(message) {
    super(message);
    this.name = "StandingCoordinationError";
  }
}

function invalid(message) {
  throw new StandingCoordinationError(message);
}

/** Effective coordination policy: configured values over the documented fallbacks. */
export function standingCoordinationPolicy(value) {
  return coordinationPolicy(value, { setting: "standing_approval_policy.coordination", invalid });
}

/**
 * One namespace per standing approval content: the id keeps refs readable and
 * the record hash keeps two clones that reuse an id for different bounds apart.
 */
export function standingSharedNamespace(proposal) {
  const id = String(proposal.id).replace(/[^A-Za-z0-9_-]/gu, "_");
  return `${id}/${String(proposal.record_hash).slice(0, 16)}`;
}

export function standingSharedSlotRef(proposal, slot) {
  return `${STANDING_SHARED_REF_ROOT}/${standingSharedNamespace(proposal)}/slots/${String(slot).padStart(4, "0")}`;
}

export function standingSharedRevocationRef(proposal) {
  return `${STANDING_SHARED_REF_ROOT}/${standingSharedNamespace(proposal)}/revoked`;
}

/** Fetch refspec mirroring one standing approval's shared refs into local tracking refs. */
export function standingSharedFetchRefspec(proposal) {
  const namespace = standingSharedNamespace(proposal);
  return `+${STANDING_SHARED_REF_ROOT}/${namespace}/*:${STANDING_SHARED_TRACKING_ROOT}/${namespace}/*`;
}

export function standingSharedTrackingPrefix(proposal) {
  return `${STANDING_SHARED_TRACKING_ROOT}/${standingSharedNamespace(proposal)}/`;
}

/** Maps a tracking ref back to the shared ref name it mirrors. */
export function standingSharedRefForTracking(trackingRef) {
  return trackingRef.startsWith(`${STANDING_SHARED_TRACKING_ROOT}/`)
    ? `${STANDING_SHARED_REF_ROOT}/${trackingRef.slice(STANDING_SHARED_TRACKING_ROOT.length + 1)}`
    : null;
}

function sealedPayload(record) {
  return sealSharedPayload(record);
}

export function buildSharedSlotPayload({ proposal, slot, delivery, profileRef }) {
  return sealedPayload({
    kind: SLOT_KIND,
    version: PAYLOAD_VERSION,
    standing_approval_id: proposal.id,
    record_hash: proposal.record_hash,
    slot,
    delivery: { id: String(delivery.id), kind: String(delivery.kind) },
    profile_ref: { id: String(profileRef.id), hash: String(profileRef.hash) },
  });
}

export function buildSharedRevocationPayload({ proposal, revocation }) {
  return sealedPayload({
    kind: REVOCATION_KIND,
    version: PAYLOAD_VERSION,
    standing_approval_id: proposal.id,
    record_hash: proposal.record_hash,
    revocation_hash: String(revocation.record_hash || ""),
    reason: String(revocation.reason || ""),
  });
}

function parsePayload(message) {
  return parseSharedPayload(message);
}

/**
 * Interprets the fetched refs of one standing approval. `refs` lists
 * `{ ref, message }` with shared ref names. Anything unexpected is reported,
 * because a malformed shared state cannot be trusted to bound anything.
 */
export function interpretSharedRefs(proposal, refs) {
  const slots = [];
  const errors = [];
  let revoked = null;
  const revocationRef = standingSharedRevocationRef(proposal);
  for (const { ref, message } of refs) {
    const payload = parsePayload(message);
    const bound = payload
      && payload.version === PAYLOAD_VERSION
      && payload.standing_approval_id === proposal.id
      && payload.record_hash === proposal.record_hash;
    if (ref === revocationRef) {
      if (bound && payload.kind === REVOCATION_KIND) revoked = payload;
      else errors.push("the shared revocation record cannot be read");
      continue;
    }
    const match = SLOT_REF_PATTERN.exec(ref);
    if (!match) {
      errors.push(`unexpected shared record ${ref.split("/").slice(-2).join("/")}`);
      continue;
    }
    const slot = Number(match[1]);
    if (!bound || payload.kind !== SLOT_KIND || payload.slot !== slot) {
      errors.push(`the shared record of slot ${slot} cannot be read`);
      continue;
    }
    if (slot < 1 || slot > proposal.max_deliveries) {
      errors.push(`the shared state records slot ${slot}, beyond the ${proposal.max_deliveries} deliveries allowed`);
      continue;
    }
    slots.push(payload);
  }
  slots.sort((left, right) => left.slot - right.slot);
  return { slots, revoked, errors };
}

/** True when a shared slot records exactly this delivery profile. */
export function sharedSlotMatches(sharedSlot, { deliveryId, deliveryKind, profileId, profileHash }) {
  return sharedSlot.delivery?.id === deliveryId
    && sharedSlot.delivery?.kind === deliveryKind
    && sharedSlot.profile_ref?.id === profileId
    && sharedSlot.profile_ref?.hash === profileHash;
}

/** Next free slot number across local and shared records, or null when all are used. */
export function nextStandingSlot(proposal, localUses, sharedSlots) {
  const used = new Set([...localUses.map((use) => use.slot), ...sharedSlots.map((slot) => slot.slot)]);
  for (let slot = 1; slot <= proposal.max_deliveries; slot += 1) {
    if (!used.has(slot)) return slot;
  }
  return null;
}

/**
 * Reasons the shared state does not let the standing approval cover a step.
 * `shared` is the engine's view: `{ scope: "local" }` when nothing is shared,
 * otherwise `{ scope: "shared", remote, available, error, slots, revoked, errors }`.
 * `use` is the local slot record the delivery holds, if any.
 */
export function sharedStateReasons(proposal, shared, { use = null, localUses = [] } = {}) {
  if (!shared) return [];
  const here = shared.localRevoked
    ? [`it was revoked on this computer (${shared.localRevoked.reason || "no reason given"})`]
    : [];
  const localSlots = shared.localSlots || [];
  if (shared.scope !== "shared") {
    // Slots kept in this repository's refs still count when their record files are gone.
    if (!use && localSlots.length > 0 && nextStandingSlot(proposal, localUses, localSlots) === null) {
      here.push(`all ${proposal.max_deliveries} deliveries were used`);
    }
    return here;
  }
  if (!shared.available) {
    return [...here, `its shared state on the git remote '${shared.remote}' cannot be checked (${shared.error}), so its limits cannot be confirmed for everyone using this project`];
  }
  const reasons = [...here, ...shared.errors.map((error) => `its shared state on '${shared.remote}' is not trustworthy: ${error}`)];
  if (shared.revoked) {
    reasons.push(`it was revoked (recorded on the git remote '${shared.remote}': ${shared.revoked.reason || "no reason given"})`);
  }
  if (use) {
    const recorded = shared.slots.find((slot) => slot.slot === use.slot);
    if (!recorded) {
      reasons.push(`slot ${use.slot} of this delivery is not recorded on the git remote '${shared.remote}'`);
    } else if (!sharedSlotMatches(recorded, {
      deliveryId: use.delivery?.id,
      deliveryKind: use.delivery?.kind,
      profileId: use.profile_ref?.id,
      profileHash: use.profile_ref?.hash,
    })) {
      reasons.push(`slot ${use.slot} on the git remote '${shared.remote}' belongs to delivery ${recorded.delivery?.id}, not to this one`);
    }
  } else if (nextStandingSlot(proposal, localUses, [...shared.slots, ...localSlots]) === null) {
    reasons.push(`all ${proposal.max_deliveries} deliveries were used (counted across everyone using this project)`);
  }
  return reasons;
}

/** Plain summary of the shared state for status output. */
export function sharedStateSummary(shared) {
  if (!shared || shared.scope !== "shared") {
    return {
      scope: "local",
      remote: null,
      checked: false,
      note: shared?.note || "checked on this computer only",
      revoked_here: Boolean(shared?.localRevoked),
    };
  }
  return {
    scope: "shared",
    remote: shared.remote,
    checked: shared.available === true,
    error: shared.available ? null : shared.error,
    shared_slots: shared.available ? shared.slots.map((slot) => ({ slot: slot.slot, delivery_id: slot.delivery?.id })) : [],
    revoked: Boolean(shared.revoked),
    revoked_here: Boolean(shared.localRevoked),
    problems: shared.available ? shared.errors : [],
  };
}
