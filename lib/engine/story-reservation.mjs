import path from "node:path";
import {
  fail,
} from "../cli/user-error.mjs";
import {
  normalizeId,
  normalizeOptionalDateTime,
  requireOption,
} from "../lifecycle/common.mjs";
import {
  humanGuidanceLocale,
} from "../lifecycle/guidance.mjs";
import {
  defaultStoryBranch,
} from "../lifecycle/story.mjs";
import {
  Date,
  crypto,
  fs,
} from "../runtime/host.mjs";
import {
  holderIdentityText,
} from "../story-claim-shared-state.mjs";
import {
  unclaimedRemoteWorkLines,
} from "../remote-work.mjs";
import {
  buildAttribution,
  now,
  uniqueRecordSuffix,
} from "./common.mjs";
import {
  ensureInitialized,
} from "./migration.mjs";
import {
  output,
} from "./output.mjs";
import {
  detectUnclaimedRemoteWork,
  fetchForRemoteWork,
} from "./remote-work.mjs";
import {
  acquireSharedStoryReservation,
  sharedStoryOverview,
  storyClaimPolicy,
} from "./story-claim-shared.mjs";
import {
  effectiveStoryLifecycleProjection,
  readStory,
  readStoryClaim,
} from "./story.mjs";

const DURATION_UNITS = Object.freeze({ s: 1, m: 60, h: 3_600, d: 86_400, w: 604_800 });

/** Seconds in a duration such as 90m, 12h, 3d, 1w, or a plain number of seconds; null when it cannot be read. */
export function parseDurationSeconds(value) {
  const match = /^\s*([0-9]{1,9})\s*([smhdw]?)\s*$/iu.exec(String(value ?? ""));
  if (!match) return null;
  const seconds = Number(match[1]) * DURATION_UNITS[(match[2] || "s").toLowerCase()];
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null;
}

function reservationExpiry(options, reservedAt, policy) {
  const reservedMs = Date.parse(reservedAt);
  const limits = policy.reservation;
  if (options["expires-in"] !== undefined && options["expires-at"] !== undefined) {
    fail("Use either --expires-in or --expires-at, not both.");
  }
  let expiresMs;
  if (options["expires-at"] !== undefined) {
    expiresMs = Date.parse(normalizeOptionalDateTime(options["expires-at"], "expires-at"));
  } else if (options["expires-in"] !== undefined) {
    const seconds = parseDurationSeconds(options["expires-in"]);
    if (seconds === null) fail("--expires-in must be a duration such as 90m, 12h, 3d, or 1w.");
    expiresMs = reservedMs + seconds * 1000;
  } else {
    expiresMs = reservedMs + limits.default_expires_in_seconds * 1000;
  }
  if (!(expiresMs > reservedMs)) fail("A reservation must end in the future.");
  if (expiresMs - reservedMs > limits.max_expires_in_seconds * 1000) {
    fail(
      `A reservation lasts at most ${limits.max_expires_in_seconds} seconds (orchestration_policy.reservation.max_expires_in_seconds). `
      + "Choose a shorter one; it can be renewed by releasing and reserving again.",
    );
  }
  return new Date(expiresMs).toISOString();
}

/**
 * story reserve: books a story for one agent before it can start, through
 * the shared remote. No task start and no satisfied dependency is needed,
 * nothing is written in the project, and no starting point is fixed: the
 * delivery's perimeter and base stay those of its later task start.
 */
export function reserveStory(context, options) {
  ensureInitialized(context);
  const id = normalizeId(requireOption(options, "id"));
  const agent = String(requireOption(options, "agent"));
  if (!fs.existsSync(path.join(context.sdlcRoot, "stories", id, "story.json"))) {
    fail(`Story ${id} does not exist. Create it with 'story create' first.`);
  }
  const story = readStory(context, id);
  const lifecycle = effectiveStoryLifecycleProjection(context, story);
  if (lifecycle.terminal || lifecycle.closed) {
    fail(`Story ${id} is ${lifecycle.status} and cannot be reserved.`);
  }
  const policy = storyClaimPolicy(context);
  const reservedAt = now();
  const expiresAt = reservationExpiry(options, reservedAt, policy);
  const attribution = buildAttribution(context, options, "story.reserve");
  const branch = String(options.branch || defaultStoryBranch(context, id));
  const reserved = acquireSharedStoryReservation(context, {
    storyId: id,
    newClaimantId: () => `RSV-${uniqueRecordSuffix()}-${crypto.randomBytes(6).toString("hex")}`,
    agent,
    branch,
    actor: attribution.actor,
    reservedAt,
    expiresAt,
  });
  output(
    options,
    {
      status: "reserved",
      story_id: id,
      agent,
      planned_branch: branch,
      reserved_at: reservedAt,
      expires_at: expiresAt,
      shared_reservation: reserved,
    },
    [
      `Reserved story ${id} for ${agent} until ${expiresAt}, through the git remote '${reserved.remote}': other computers see it and their story claim is refused.`,
      "Nothing was written in the project and no starting point was fixed. When the story can start, run task start and story claim from this computer: the claim replaces the reservation.",
      ...(reserved.expired_reservation
        ? [`The previous reservation by ${reserved.expired_reservation.agent} had expired and was closed.`]
        : []),
    ],
  );
}

function storyIdsOf(context) {
  try {
    return fs.readdirSync(path.join(context.sdlcRoot, "stories"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function availabilityVerdict(view, localClaim, remoteWork) {
  if (view?.problems?.length > 0) return "untrustworthy";
  const holder = view?.holder;
  if (holder && view.here) return holder.reservation ? "reserved_here" : "claimed_here";
  if (holder) return holder.reservation ? "reserved_elsewhere" : "claimed_elsewhere";
  if (String(localClaim?.status || "").toLowerCase() === "active" && !view?.local_claim_outdated) return "claimed_here";
  if (view?.completed) return "finished";
  if (remoteWork) return "remote_work_without_claim";
  return "free";
}

/**
 * story availability: read-only answer to "can this story be started here
 * without doubling someone's work?". It updates the remote-tracking branches
 * first (as status does), then reports the shared claim or reservation and,
 * for a story nobody holds, work on the remote that names it. It never
 * blocks and never changes a record.
 */
export function showStoryAvailability(context, options) {
  ensureInitialized(context);
  const id = normalizeId(requireOption(options, "id"));
  if (!fs.existsSync(path.join(context.sdlcRoot, "stories", id, "story.json"))) {
    fail(`Story ${id} does not exist.`);
  }
  const italian = humanGuidanceLocale(options) === "it";
  const nowMs = Date.now();
  const sync = fetchForRemoteWork(context);
  const localClaim = readStoryClaim(context, id);
  const shared = sharedStoryOverview(context, id, localClaim, { nowMs });
  const view = shared.view;
  const remoteWork = !view?.holder && !view?.completed
    ? detectUnclaimedRemoteWork(context, {
        stories: [{ id, orchestration_state: "available", claim: localClaim, ...(view ? { shared_claim: view } : {}) }],
      }, { nowMs, knownStoryIds: storyIdsOf(context) }).items[0] || null
    : null;
  const verdict = availabilityVerdict(view, localClaim, remoteWork);
  const holder = view?.holder || null;
  const who = holder ? `${holder.agent}${holderIdentityText(holder) ? ` (${holderIdentityText(holder)})` : ""}` : null;
  const lines = {
    free: italian ? `${id}: libera; nessun segno di lavoro sul remote.` : `${id}: free; no sign of work on the remote.`,
    claimed_here: italian ? `${id}: assegnata da questo computer.` : `${id}: claimed from this computer.`,
    reserved_here: italian
      ? `${id}: riservata da questo computer (${who}) fino a ${holder?.expires_at}; il task start e la story claim da qui la convertono in assegnazione.`
      : `${id}: reserved from this computer (${who}) until ${holder?.expires_at}; task start and story claim from here turn it into the claim.`,
    reserved_elsewhere: italian
      ? `${id}: riservata da ${who} fino a ${holder?.expires_at}. Non avviarla: la story claim da qui sarebbe rifiutata senza la decisione di una persona.`
      : `${id}: reserved by ${who} until ${holder?.expires_at}. Do not start it: a story claim from here is refused without a person's decision.`,
    claimed_elsewhere: italian
      ? `${id}: assegnata su un altro computer a ${who} sul branch ${holder?.branch} dal ${holder?.claimed_at}. Non avviarla.`
      : `${id}: claimed on another computer by ${who} on branch ${holder?.branch} since ${holder?.claimed_at}. Do not start it.`,
    untrustworthy: italian
      ? `${id}: le assegnazioni condivise di questa story non sono affidabili; non avviarla finché non sono ripristinate.`
      : `${id}: this story's shared claim records cannot be trusted; do not start it until they are restored.`,
    finished: italian
      ? `${id}: già conclusa (${view?.completed?.terminal_status || (view?.completed?.status === "closed" ? "chiusa" : "consegnata")} il ${view?.completed?.released_at}). Non avviarla: aggiorna questo checkout dal branch base.`
      : `${id}: already finished (${view?.completed?.terminal_status || (view?.completed?.status === "closed" ? "closed" : "delivered")} at ${view?.completed?.released_at}). Do not start it: update this checkout from the base branch.`,
    remote_work_without_claim: remoteWork ? unclaimedRemoteWorkLines([remoteWork], { nowMs, italian })[0] : "",
  };
  output(
    options,
    {
      story_id: id,
      verdict,
      safe_to_start: ["free", "claimed_here", "reserved_here"].includes(verdict),
      shared: {
        scope: shared.scope,
        remote: shared.remote,
        checked: shared.checked,
        ...(shared.error ? { error: shared.error } : {}),
        ...(shared.note ? { note: shared.note } : {}),
      },
      ...(holder ? { holder, here: view.here } : {}),
      ...(view?.expired_reservation ? { expired_reservation: view.expired_reservation } : {}),
      ...(view?.completed ? { completed: view.completed } : {}),
      ...(remoteWork ? { remote_work: remoteWork } : {}),
      ...(sync ? { workspace_sync: sync } : {}),
    },
    [
      lines[verdict],
      ...(view?.expired_reservation
        ? [italian
          ? `La riserva di ${view.expired_reservation.agent} è scaduta il ${view.expired_reservation.expires_at}.`
          : `The reservation by ${view.expired_reservation.agent} expired at ${view.expired_reservation.expires_at}.`]
        : []),
      ...(shared.scope === "shared" && !shared.checked
        ? [italian
          ? `Il remote git '${shared.remote}' non è raggiungibile (${shared.error}): le assegnazioni degli altri computer non sono visibili.`
          : `The git remote '${shared.remote}' cannot be reached (${shared.error}): other computers' claims are not visible.`]
        : []),
    ],
  );
}
