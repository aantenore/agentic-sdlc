import { deliveryProfileStoryIds } from "../engine/delivery.mjs";
import {
  isDependencyEdgeInactive,
  isDependencySatisfied,
  readDependencyGraph,
  readStory,
} from "../engine/story.mjs";
import { readWorkflowInstance } from "../engine/workflow.mjs";

/**
 * Facts the automatic messages need and a finished command knows best: which
 * stories a completed story now lets start. Read-only and best effort; the
 * caller ignores any failure.
 */
const FINISHED = new Set(["done", "delivered", "cancelled", "superseded", "closed"]);
const DELIVERY_ACTIONS = new Set(["autonomy.delivery.action", "autonomy.delivery.reconcile"]);
const UNBLOCK_ACTIONS = new Set([
  "autonomy.delivery.action",
  "autonomy.delivery.reconcile",
  "story.publish-records",
  "story.release",
  "gate.check",
]);

/** Stories that depend on `storyId` and have every dependency satisfied now. */
export function dependentsNowUnblocked(context, storyId) {
  const graph = readDependencyGraph(context, { missingOk: true });
  const edges = graph.edges;
  const dependents = [...new Set(edges.filter((edge) => edge.to === storyId).map((edge) => edge.from))];
  return dependents.filter((dependent) => {
    const story = readStory(context, dependent);
    if (!story || FINISHED.has(String(story.status || "").toLowerCase())) return false;
    return edges
      .filter((edge) => edge.from === dependent)
      .every((edge) => isDependencyEdgeInactive(context, edge) || isDependencySatisfied(context, edge));
  }).sort();
}

// Delivery steps announced on success; the story comes from the delivery profile.
export const ANNOUNCED_DELIVERY_STEPS = Object.freeze(["git.commit", "git.push", "pull_request.create"]);

/** The extra facts for one finished command, or null. */
export function eventFacts(context, action, options) {
  if (action === "workflow.instance.transition") {
    const story = readWorkflowInstance(context, String(options?.id ?? "").trim()).instance?.metadata?.governance_binding?.story_id;
    return story ? { story: String(story).toUpperCase(), unblocked: [] } : null;
  }
  if (action === "autonomy.delivery.action" && ANNOUNCED_DELIVERY_STEPS.includes(options?.action) && options?.outcome === "passed") {
    return { story: deliveryProfileStoryIds(context, options)[0] ?? null, unblocked: [] };
  }
  if (!UNBLOCK_ACTIONS.has(action)) return null;
  if (action === "gate.check" && options?.["lifecycle-complete"] !== true) return null;
  if (action === "autonomy.delivery.action" && !(options?.action === "pull_request.merge" && options?.outcome === "passed")) return null;
  const story = DELIVERY_ACTIONS.has(action)
    ? deliveryProfileStoryIds(context, options)[0] ?? null
    : String(options?.story ?? options?.id ?? "").trim().toUpperCase() || null;
  if (!story) return null;
  // A released story frees itself, not its dependents.
  return { story, unblocked: action === "story.release" ? [] : dependentsNowUnblocked(context, story) };
}
