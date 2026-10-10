// pull_request.merge action receipts of a story: the evidence that its delivery merged.

import path from "node:path";

import { fs } from "../runtime/host.mjs";
import { storyBoundDeliveryProfiles } from "./delivery.mjs";

function projectPath(context, absolute) {
  return path.relative(context.root, absolute).split(path.sep).join("/");
}

/**
 * The newest pull_request.merge action receipt of the story, as
 * { receipt, evidence } project paths, or null. A passed receipt of one of the
 * story's delivery profiles wins; its recorded evidence files travel with it.
 */
export function mergeReceiptEvidence(context, storyId) {
  const dir = path.join(context.sdlcRoot, "autonomy", "actions");
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort().reverse();
  } catch {
    return null;
  }
  let profileIds = new Set();
  try {
    profileIds = new Set(storyBoundDeliveryProfiles(context, storyId).map((profile) => profile?.id).filter(Boolean));
  } catch {
    // Unreadable profiles: fall back to receipts naming the story.
  }
  let fallback = null;
  for (const name of names) {
    try {
      const text = fs.readFileSync(path.join(dir, name), "utf8");
      if (!text.includes("pull_request.merge")) continue;
      const receipt = JSON.parse(text);
      if (receipt?.action !== "pull_request.merge") continue;
      const boundToProfile = profileIds.has(receipt.profile_ref?.id);
      if (!boundToProfile && !JSON.stringify(receipt).includes(`"${storyId}"`)) continue;
      const receiptPath = projectPath(context, path.join(dir, name));
      if (receipt.outcome === "passed" && boundToProfile) {
        const evidence = (Array.isArray(receipt.evidence) ? receipt.evidence : [])
          .map((item) => (typeof item === "string" ? item : item?.path))
          .filter((item) => typeof item === "string" && item && fs.existsSync(path.resolve(context.root, item)));
        return { receipt: receiptPath, evidence: [receiptPath, ...evidence], passed: true };
      }
      fallback ||= { receipt: receiptPath, evidence: [receiptPath], passed: false };
    } catch {
      // Unreadable receipts are not evidence.
    }
  }
  return fallback;
}

/** True when a passed pull_request.merge receipt of one of the story's delivery profiles exists. */
export function storyMergePassed(context, storyId) {
  const found = mergeReceiptEvidence(context, storyId);
  return Boolean(found?.passed);
}
