import path from "node:path";
import {
  runsInsideAgentHost,
} from "../agent-host.mjs";
import {
  computeStableHash,
} from "../canonical.mjs";
import {
  fail,
} from "../cli/user-error.mjs";
import {
  getOptionString,
  normalizeId,
  normalizeOptionalDateTime,
  requireCoordinationOverrideActor,
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
  buildAttribution,
  buildOrchestrationSnapshot,
  now,
  uniqueRecordSuffix,
} from "./common.mjs";
import {
  releaseStoryClaimRecord,
} from "./delivery.mjs";
import {
  ensureInitialized,
} from "./migration.mjs";
import {
  output,
} from "./output.mjs";
import {
  recordProjectPluginRequirement,
} from "./plugin-compatibility.mjs";
import {
  acquireFileLock,
  writeJsonFile,
} from "./storage.mjs";
import {
  acquireSharedStoryReservation,
  releaseSharedReservation,
  resolveClaimScope,
  sharedStoryOverview,
  storyClaimPolicy,
} from "./story-claim-shared.mjs";
import {
  STORY_PARKING_SCHEMA,
  readStoryParking,
  storyParkingRoot,
} from "./story-parking-records.mjs";
import {
  parseDurationSeconds,
} from "./story-reservation.mjs";
import {
  appendTraceEvent,
  effectiveStoryLifecycleProjection,
  readStory,
  readStoryClaim,
  storyOrchestrationNextAction,
} from "./story.mjs";

/**
 * Parking and resuming are a person's decisions: a human (or approved CI)
 * actor and a reason. Inside an agent's session the agent runs them only
 * when the user asked, recorded as --approval-source explicit-user.
 */
function personDecision(context, options, action, storyId) {
  const reason = getOptionString(options, "reason");
  if (!reason) fail(`story ${action} requires --reason: why story ${storyId} is ${action === "park" ? "set aside" : "brought back"}.`);
  const attribution = buildAttribution(context, options, `story.${action}`);
  requireCoordinationOverrideActor(attribution, `${action === "park" ? "Parking" : "Resuming"} story ${storyId}`);
  const approvalSource = getOptionString(options, "approval-source");
  if (runsInsideAgentHost() && approvalSource !== "explicit-user") {
    fail(
      `${action === "park" ? "Parking" : "Resuming"} story ${storyId} is the user's decision. Run it only when the user asked for it, `
      + `with --actor-type human --approval-source explicit-user and their reason; never on your own initiative.`,
    );
  }
  return { reason, attribution, approvalSource: approvalSource || null };
}

/** When a person should look at a parked story again (--review-at: a time or 12h, 3d, 1w), or null. */
function parkReviewAt(options) {
  const value = getOptionString(options, "review-at");
  if (!value) return null;
  const nowMs = Date.now();
  const seconds = parseDurationSeconds(value);
  const reviewMs = seconds !== null ? nowMs + seconds * 1000 : Date.parse(normalizeOptionalDateTime(value, "review-at"));
  if (!(reviewMs > nowMs)) fail("--review-at must be in the future.");
  return new Date(reviewMs).toISOString();
}

function sharedScope(context) {
  const policy = storyClaimPolicy(context);
  const target = resolveClaimScope(context, policy.coordination);
  return { policy, target, shared: target.scope === "shared" };
}

function errorText(error) {
  return String(error?.message || error).split("\n")[0];
}

function writeParkingRecord(context, storyId, record) {
  const sealed = { ...record, record_hash: computeStableHash(record) };
  const root = storyParkingRoot(context, storyId);
  fs.mkdirSync(root, { recursive: true });
  const recordPath = path.join(root, `${record.id}.json`);
  writeJsonFile(recordPath, sealed);
  return { record: sealed, recordPath, projectPath: path.relative(context.root, recordPath).split(path.sep).join("/") };
}

/** The first story agents can take next, with the command that starts it; null when none is available. */
function nextAvailableStory(context, excludeId) {
  try {
    const snapshot = buildOrchestrationSnapshot(context, { sharedClaims: true });
    const story = snapshot.stories.find((item) => item.orchestration_state === "available" && item.id !== excludeId);
    if (!story) return null;
    const next = storyOrchestrationNextAction(context, story);
    return { story_id: story.id, title: story.title, suggested_action: next.action, suggested_command: next.command };
  } catch (error) {
    return { error: errorText(error) };
  }
}

function nextStoryLine(next, italian) {
  if (!next) {
    return italian
      ? "Nessun'altra story è pronta ora: controlla 'orchestrate status'."
      : "No other story is ready now: check 'orchestrate status'.";
  }
  if (next.error) return italian ? `Prossima story non calcolata: ${next.error}` : `Next story not computed: ${next.error}`;
  return italian
    ? `Prossima story disponibile: ${next.story_id} (${next.title}) -> ${next.suggested_command}`
    : `Next available story: ${next.story_id} (${next.title}) -> ${next.suggested_command}`;
}

/**
 * story park: a person sets a story aside because it is stuck (a conflict or
 * any other problem), so agents stop working on it and take other work. The
 * active claim of this computer is released (on the remote too), a parked
 * reservation without expiry tells every computer to leave the story alone,
 * and a sealed record keeps the decision. Nothing about the story's own work
 * changes: no step is completed and no check is bypassed; story resume brings
 * it back exactly as it was.
 */
export function parkStory(context, options) {
  ensureInitialized(context);
  const id = normalizeId(requireOption(options, "id"));
  const story = readStory(context, id);
  if (!story) fail(`Story ${id} does not exist.`);
  const lifecycle = effectiveStoryLifecycleProjection(context, story);
  if (lifecycle.terminal || lifecycle.closed) fail(`Story ${id} is ${lifecycle.status}; there is nothing to park.`);
  const { reason, attribution, approvalSource } = personDecision(context, options, "park", id);
  const reviewAt = parkReviewAt(options);
  const italian = humanGuidanceLocale(options) === "it";
  // Older plugins would offer the story again: they are asked to update first.
  recordProjectPluginRequirement(context, "story-parking");
  const releaseLock = acquireFileLock(path.join(storyParkingRoot(context, id), "..", "parking.lock"));
  let result;
  try {
    const current = readStoryParking(context, id);
    const parkedAt = now();
    const parkId = current.parked ? current.record.id : `PARK-${uniqueRecordSuffix()}`;
    // 1. This computer's active claim is released, here and on the remote.
    let releasedClaim = null;
    const claim = readStoryClaim(context, id);
    if (String(claim?.status || "").toLowerCase() === "active") {
      const released = releaseStoryClaimRecord(context, { ...options, id, reason: `Parked by a person: ${reason}` });
      releasedClaim = {
        agent: released.claim.agent,
        branch: released.claim.branch,
        ...(released.shared_release ? { shared_release: released.shared_release.status } : {}),
      };
    }
    // 2. Every computer is told through the remote, when claims are shared.
    const scope = sharedScope(context);
    let shared = current.parked ? current.record.shared || null : null;
    let sharedError = null;
    if (scope.shared && !shared) {
      try {
        const reserved = acquireSharedStoryReservation(context, {
          storyId: id,
          newClaimantId: () => `PRK-${uniqueRecordSuffix()}-${crypto.randomBytes(6).toString("hex")}`,
          agent: `parked:${attribution.actor.id}`,
          branch: String(claim?.branch || defaultStoryBranch(context, id)),
          actor: attribution.actor,
          reservedAt: parkedAt,
          expiresAt: null,
          parked: { reason, parked_at: parkedAt, park_id: parkId, ...(reviewAt ? { review_at: reviewAt } : {}) },
        });
        shared = { remote: reserved.remote, epoch: reserved.epoch };
      } catch (error) {
        if (error?.errorCode === "STORY_PARKED") {
          shared = { remote: scope.target.remote, epoch: null, parked_elsewhere: true };
        } else {
          sharedError = errorText(error);
        }
      }
    }
    // 3. The decision itself, kept with the story's records.
    let written = null;
    if (!current.parked) {
      written = writeParkingRecord(context, id, {
        schema: STORY_PARKING_SCHEMA,
        id: parkId,
        story_id: id,
        action: "park",
        reason,
        approval_source: approvalSource,
        actor: attribution.actor,
        released_claim: releasedClaim,
        shared: shared && Number.isSafeInteger(shared.epoch) ? { remote: shared.remote, epoch: shared.epoch } : null,
        // Older plugins ignore it: the story stays parked either way.
        ...(reviewAt ? { review_at: reviewAt } : {}),
        git: attribution.git,
        created_at: parkedAt,
      });
      appendTraceEvent(context, id, {
        type: "decision",
        action: "story.park",
        summary: `Story ${id} parked by a person: ${reason}`,
        actor: attribution.actor,
        evidence: [written.projectPath],
        related: [id],
        git: attribution.git,
        run: attribution.run,
      });
    }
    result = {
      status: current.parked ? "already_parked" : "parked",
      story_id: id,
      reason: current.parked ? current.record.reason : reason,
      ...(written ? { parking_path: written.recordPath, parking: written.record } : { parking: current.record }),
      ...(releasedClaim ? { released_claim: releasedClaim } : {}),
      shared_parking: scope.shared
        ? (sharedError ? { status: "not_shared", remote: scope.target.remote, error: sharedError } : { status: "shared", ...shared })
        : { status: "local", note: scope.target.note || null },
    };
  } finally {
    releaseLock();
  }
  const next = nextAvailableStory(context, id);
  result.next_story = next;
  const shared = result.shared_parking;
  output(options, result, [
    italian
      ? `Story ${id} ${result.status === "already_parked" ? "era già parcheggiata" : "parcheggiata"}: ${result.reason}`
      : `Story ${id} ${result.status === "already_parked" ? "was already parked" : "parked"}: ${result.reason}`,
    ...(result.parking?.review_at
      ? [italian
        ? `Da riguardare dal ${result.parking.review_at}: da allora status la elenca da rivedere.`
        : `To review from ${result.parking.review_at}: from then on status lists it to review.`]
      : []),
    ...(result.released_claim
      ? [italian
        ? `Assegnazione rilasciata (${result.released_claim.agent} sul branch ${result.released_claim.branch}); il branch e il lavoro restano com'erano.`
        : `Claim released (${result.released_claim.agent} on branch ${result.released_claim.branch}); the branch and its work stay as they are.`]
      : []),
    shared.status === "shared"
      ? (italian
        ? `Condivisa tramite '${shared.remote}': gli altri computer non la propongono e la loro story claim viene rifiutata.`
        : `Shared through '${shared.remote}': other computers do not offer it and refuse their story claim.`)
      : shared.status === "not_shared"
        ? (italian
          ? `NON condivisa tramite '${shared.remote}' (${shared.error}); rilancia story park --id ${id} quando il remote è raggiungibile.`
          : `NOT shared through '${shared.remote}' (${shared.error}); run story park --id ${id} again when the remote can be reached.`)
        : (italian ? "Registrata su questo progetto." : "Recorded in this project."),
    italian
      ? "Gli agenti la saltano: nessun controllo è stato aggirato e niente risulta completato. Per riprenderla: story resume --id " + id + " --reason \"<motivo>\" --actor-type human"
      : "Agents skip it: no check was bypassed and nothing is marked done. To bring it back: story resume --id " + id + " --reason \"<why>\" --actor-type human",
    nextStoryLine(next, italian),
  ]);
}

/**
 * story resume: a person brings a parked story back. The parked reservation
 * on the remote is ended (wherever it was made) and a resume record follows
 * the park record; the story is then offered again like any other.
 */
export function resumeStory(context, options) {
  ensureInitialized(context);
  const id = normalizeId(requireOption(options, "id"));
  if (!readStory(context, id)) fail(`Story ${id} does not exist.`);
  const { reason, attribution, approvalSource } = personDecision(context, options, "resume", id);
  const italian = humanGuidanceLocale(options) === "it";
  const releaseLock = acquireFileLock(path.join(storyParkingRoot(context, id), "..", "parking.lock"));
  let result;
  try {
    const current = readStoryParking(context, id);
    const resumedAt = now();
    const scope = sharedScope(context);
    let sharedResume = null;
    if (scope.shared) {
      const overview = sharedStoryOverview(context, id, readStoryClaim(context, id), { nowMs: Date.parse(resumedAt) });
      if (!overview.checked) {
        fail(`Story ${id} was not resumed: the git remote '${overview.remote}' cannot be reached (${overview.error}), so other computers would keep it parked. Try again when it can be reached.`);
      }
      if (overview.view?.holder?.parked) {
        const released = releaseSharedReservation(context, {
          storyId: id,
          agent: null,
          actor: attribution.actor,
          reason: `Resumed by a person: ${reason}`,
          attribution,
          options,
          releasedAt: resumedAt,
          resume: true,
        });
        sharedResume = released ? { status: released.status, remote: released.remote, epoch: released.epoch } : null;
      }
    }
    if (!current.parked && !sharedResume) {
      result = { status: "not_parked", story_id: id };
    } else {
      const written = writeParkingRecord(context, id, {
        schema: STORY_PARKING_SCHEMA,
        id: `RESUME-${uniqueRecordSuffix()}`,
        story_id: id,
        action: "resume",
        reason,
        approval_source: approvalSource,
        actor: attribution.actor,
        resumes: current.parked ? current.record.id : null,
        shared: sharedResume,
        git: attribution.git,
        created_at: resumedAt,
      });
      appendTraceEvent(context, id, {
        type: "decision",
        action: "story.resume",
        summary: `Story ${id} resumed by a person: ${reason}`,
        actor: attribution.actor,
        evidence: [written.projectPath],
        related: [id],
        git: attribution.git,
        run: attribution.run,
      });
      result = { status: "resumed", story_id: id, reason, parking_path: written.recordPath, parking: written.record, ...(sharedResume ? { shared_resume: sharedResume } : {}) };
    }
  } finally {
    releaseLock();
  }
  output(options, result, result.status === "not_parked"
    ? [italian ? `Story ${id} non è parcheggiata.` : `Story ${id} is not parked.`]
    : [
        italian ? `Story ${id} ripresa: ${reason}` : `Story ${id} resumed: ${reason}`,
        ...(result.shared_resume
          ? [italian
            ? `Ripresa condivisa tramite '${result.shared_resume.remote}': ogni computer può riprenderla.`
            : `Resume shared through '${result.shared_resume.remote}': every computer can take it again.`]
          : []),
        italian
          ? `Per riprendere il lavoro: story claim --id ${id} --agent <agent> (vedi orchestrate plan).`
          : `To continue the work: story claim --id ${id} --agent <agent> (see orchestrate plan).`,
      ]);
}
