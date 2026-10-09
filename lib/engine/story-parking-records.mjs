import path from "node:path";
import {
  computeStableHash,
} from "../canonical.mjs";
import {
  readProjectJson,
  safeReadDir,
} from "./storage.mjs";

// A person may set a story aside (story park) when it is stuck on a conflict
// or any other problem, so agents move on to other work, and bring it back
// later (story resume). Each decision is one sealed record under the story's
// parking/ folder; records are only ever added. The latest one decides.

export const STORY_PARKING_SCHEMA = "story-parking:v1";
export const STORY_PARKING_DIRECTORY = "parking";
const ACTIONS = new Set(["park", "resume"]);

export function storyParkingRoot(context, storyId) {
  return path.join(context.sdlcRoot, "stories", storyId, STORY_PARKING_DIRECTORY);
}

/** The park and resume records of one story, oldest first; unreadable or altered records count for nothing. */
export function readStoryParkingRecords(context, storyId) {
  const records = [];
  for (const name of safeReadDir(storyParkingRoot(context, storyId)).sort()) {
    if (!name.endsWith(".json")) continue;
    try {
      const record = readProjectJson(context, path.join(storyParkingRoot(context, storyId), name));
      const { record_hash: recordHash, ...content } = record;
      if (record.schema !== STORY_PARKING_SCHEMA || record.story_id !== storyId || !ACTIONS.has(record.action)) continue;
      if (recordHash !== computeStableHash(content)) continue;
      records.push(record);
    } catch {
      // A record that cannot be read parks nothing.
    }
  }
  return records.sort((left, right) =>
    String(left.created_at).localeCompare(String(right.created_at)) || String(left.id).localeCompare(String(right.id)));
}

/**
 * Whether this checkout's records keep the story parked: `{ parked, record }`
 * with the latest park record while it is not followed by a resume.
 */
export function readStoryParking(context, storyId) {
  const latest = readStoryParkingRecords(context, storyId).at(-1) || null;
  return latest?.action === "park" ? { parked: true, record: latest } : { parked: false, record: latest };
}

/**
 * Whether a story is parked, combining this checkout's records with what
 * every computer sees on the remote (`sharedView`, or null when claims are
 * not shared or the remote was not read). A parked reservation on the remote
 * always parks it; a park shared through the remote that the remote no
 * longer shows was resumed on another computer whose records have not
 * arrived yet.
 */
export function effectiveStoryParking(local, sharedView) {
  if (sharedView?.holder?.parked) {
    const reviewAt = sharedView.holder.parked.review_at || (local?.parked ? local.record.review_at : null) || null;
    return {
      parked: true,
      source: "remote",
      reason: sharedView.holder.parked.reason,
      parked_at: sharedView.holder.parked.parked_at,
      here: Boolean(local?.parked),
      ...(reviewAt ? { review_at: reviewAt } : {}),
    };
  }
  if (!local?.parked) return { parked: false };
  const sharedEpoch = local.record.shared?.epoch;
  if (sharedView && Number.isSafeInteger(sharedEpoch) && sharedView.state !== "untrustworthy") {
    return { parked: false, resumed_elsewhere: true };
  }
  return {
    parked: true,
    source: "local",
    reason: local.record.reason,
    parked_at: local.record.created_at,
    here: true,
    ...(local.record.review_at ? { review_at: local.record.review_at } : {}),
  };
}
