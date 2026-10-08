import {
  capabilityInventoryPolicyFromConfig,
  collectCapabilityInventory,
} from "../capability-inventory.mjs";
import {
  deriveCapabilityTags,
  matchInventoryCapabilities,
} from "../capability-matching.mjs";
import {
  buildCapabilitySuggestionRecord,
} from "../lifecycle/capability-suggestion.mjs";
import {
  capabilityRecordMatchesStory,
} from "../lifecycle/capability.mjs";
import {
  findApprovedCapabilityProfiles,
  readCapabilityProfiles,
  readCapabilityRecommendations,
} from "./capability.mjs";
import {
  detectProjectStack,
} from "./project.mjs";
import {
  readContractById,
} from "./story.mjs";

// One scan per command run: task start builds its decision twice, and status
// may look at several stories.
const inventoryByContext = new WeakMap();

function installedInventory(context, policy) {
  let inventory = inventoryByContext.get(context);
  if (!inventory) {
    inventory = collectCapabilityInventory({ projectRoot: context.root, policy });
    inventoryByContext.set(context, inventory);
  }
  return inventory;
}

// The capability records are read once per command run: status may look at
// several stories, and each look needs the same two lists.
const recordsByContext = new WeakMap();

function capabilityRecords(context) {
  let records = recordsByContext.get(context);
  if (!records) {
    records = {
      profiles: readCapabilityProfiles(context),
      recommendations: readCapabilityRecommendations(context),
    };
    recordsByContext.set(context, records);
  }
  return records;
}

function storyAlreadyHandled(context, storyId, contractId, { profiles, recommendations }) {
  const contract = contractId ? readContractById(context, contractId, { missingOk: true }) : null;
  if (Array.isArray(contract?.capability_recommendation_refs) && contract.capability_recommendation_refs.length > 0) {
    return true;
  }
  // A proposed recommendation is already a pending decision, and a second
  // proposal for the same story would only collide with it. A recommendation
  // whose profile cannot be found is treated as covering the story.
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  return recommendations.some((recommendation) => (
    ["approved", "proposed"].includes(recommendation.status)
    && capabilityRecordMatchesStory(context, profileById.get(recommendation.profile_id) ?? {}, storyId)
  ));
}

function declaredTechnology(profiles) {
  return {
    detectedStack: profiles.flatMap((profile) => (Array.isArray(profile.detected_stack) ? profile.detected_stack : [])),
    integrations: profiles.flatMap((profile) => (Array.isArray(profile.integrations) ? profile.integrations : [])),
  };
}

function suggestionCommands(storyId, phase, profile, taken, contextFile) {
  const profileId = `CAP-PROFILE-${storyId}`;
  const recommendationId = `CAP-REC-${storyId}`;
  const recommend = `agentic-sdlc capability recommend --id ${recommendationId} --profile ${profile ? profile.id : profileId} --from-inventory${taken.recommendations.has(recommendationId) ? " --force" : ""}`;
  if (profile) return [recommend];
  return [
    `agentic-sdlc capability profile propose --id ${profileId} --story ${storyId}${phase ? ` --phase ${phase}` : ""}${contextFile ? ` --context-file ${contextFile}` : ""}${taken.profiles.has(profileId) ? " --force" : ""}`,
    recommend,
  ];
}

function collect(context, { storyId, phase, contractId, locale }) {
  const policy = capabilityInventoryPolicyFromConfig(context.config);
  if (!policy.enabled || !policy.suggest || !storyId) return null;
  const records = capabilityRecords(context);
  const { profiles, recommendations } = records;
  if (storyAlreadyHandled(context, storyId, contractId, records)) return null;

  const storyProfiles = profiles.filter((profile) => capabilityRecordMatchesStory(context, profile, storyId));
  if (storyProfiles.some((profile) => profile.status === "proposed")) return null;

  // Declared technology comes from the approved evidence when there is some
  // (the stack does not change with the phase, so a profile approved for
  // another phase of the same story still counts); before that, from the same
  // deterministic detection a profile starts from. A request's own wording is
  // never used.
  const rank = (left, right) => (
    Number(right.subject?.story_id === storyId) - Number(left.subject?.story_id === storyId)
    || String(left.id).localeCompare(String(right.id))
  );
  const forPhase = findApprovedCapabilityProfiles(context, { storyId, phase }, profiles);
  const approved = (forPhase.length > 0 ? forPhase : findApprovedCapabilityProfiles(context, { storyId }, profiles)).sort(rank);
  const basis = approved.length > 0 ? "approved_profile" : "project_detection";
  const technology = approved.length > 0
    ? declaredTechnology(approved)
    : { detectedStack: detectProjectStack(context), integrations: [] };
  const tags = deriveCapabilityTags(technology, policy.matching);
  if (tags.length === 0) return null;

  const inventory = installedInventory(context, policy);
  const matches = matchInventoryCapabilities(inventory, tags, { phase, matching: policy.matching });
  if (matches.length === 0) return null;

  return buildCapabilitySuggestionRecord({
    storyId,
    phase,
    basis,
    profileId: approved[0]?.id ?? null,
    tags: tags.map((entry) => entry.tag),
    matches: matches.slice(0, policy.matching.max_suggestions),
    totalMatches: matches.length,
    commands: suggestionCommands(storyId, phase, approved[0] ?? null, {
      profiles: new Set(profiles.map((profile) => profile.id)),
      recommendations: new Set(recommendations.map((recommendation) => recommendation.id)),
    }, technology.detectedStack.find((item) => typeof item?.source_path === "string" && item.source_path)?.source_path ?? null),
    locale,
  });
}

/**
 * A short suggestion of installed skills, plugins, and servers that name the
 * technology a story declares, offered while the story has no recommendation
 * yet. Returns null when there is nothing worth saying: no inventory match, a
 * recommendation or profile already recorded for the story, or the inventory
 * turned off. A suggestion never changes, binds, or approves anything, and a
 * failure to build one never interrupts the command that asked for it.
 */
export function collectCapabilitySuggestion(context, input) {
  try {
    return collect(context, input);
  } catch {
    return null;
  }
}
