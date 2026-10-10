import {
  fail,
} from "../cli/user-error.mjs";
import {
  normalizeId,
  normalizeListOption,
  requireOption,
} from "../lifecycle/common.mjs";
import {
  deliveryTargetAllowedActions,
} from "../lifecycle/delivery.mjs";
import {
  normalizeProjectPathInput,
  pathMatchesApprovedWriteScope,
} from "../lifecycle/project.mjs";
import {
  contractExecutionContext,
} from "../lifecycle/story.mjs";
import {
  storyBranchRecordPath,
} from "../story-records.mjs";
import {
  readDeliveryAutonomyProfile,
  storyRecordsContext,
} from "./delivery.mjs";
import {
  readExactGitWorkspaceStatus,
} from "./git.mjs";
import {
  ensureInitialized,
} from "./migration.mjs";
import {
  output,
} from "./output.mjs";
import {
  readContractById,
  readRequirementAutonomyProfile,
  readStory,
} from "./story.mjs";

const MAX_LISTED_PATHS = 8;
const CHAIN_ACTIONS = ["git.push", "pull_request.create", "pull_request.merge"];

/**
 * Whether the delivery profile allows the actions the delivery chain will ask
 * for. Only pull request profiles have this chain; others return an empty list.
 * `pull_request.create` is not required when the profile targets an existing pull request.
 */
export function deliveryActionAccess(profile) {
  if (profile?.delivery_kind !== "pull_request" || !profile.pull_request_target) return [];
  const target = profile.pull_request_target;
  const allowed = new Set(deliveryTargetAllowedActions(profile));
  const forbidden = new Set(profile.constraints?.forbidden_actions || []);
  return CHAIN_ACTIONS
    .filter((action) => action !== "pull_request.create" || target.mode !== "existing")
    .map((action) => {
      if (forbidden.has(action)) return { action, allowed: false, reason: "forbidden by the profile" };
      if (!allowed.has(action)) return { action, allowed: false, reason: "not in the profile's allowed actions" };
      if (action === "pull_request.merge" && target.merge_allowed !== true) {
        return { action, allowed: false, reason: "merge_allowed is false" };
      }
      return { action, allowed: true, reason: null };
    });
}

function actionRemedy(item, profileId) {
  return item.action === "pull_request.merge" && item.reason !== "forbidden by the profile"
    ? `${item.action}: ${item.reason} in ${profileId}; widen it in place, before the pull request is merged and without a new contract: autonomy delivery amend --id ${profileId} --merge-allowed --actor-type human --approval-source explicit-user --summary "<your words>".`
    : `${item.action}: ${item.reason} in ${profileId}; propose a new delivery profile that allows it (--allow-action ${item.action}) and bind it to the contract.`;
}

/** The write paths the story's delivery profile and requirements allow; null when it has no delivery profile yet. */
export function storyWriteScopes(context, storyId) {
  const story = readStory(context, storyId);
  if (!story?.contract_id) return null;
  const contract = readContractById(context, story.contract_id, { missingOk: true });
  const executionContext = contractExecutionContext(contract);
  if (!executionContext) return null;
  const profile = readDeliveryAutonomyProfile(context, executionContext.profileId, { missingOk: true });
  if (!profile) return null;
  const requirements = [];
  for (const ref of profile.requirement_profile_refs || []) {
    try {
      const requirement = readRequirementAutonomyProfile(context, ref.id);
      requirements.push({ id: ref.id, paths: requirement.constraints?.allowed_write_paths || [] });
    } catch {
      // An unreadable requirement scope is reported by the governed commit, not here.
    }
  }
  return { profile, profile_id: profile.id, profile_paths: profile.constraints?.allowed_write_paths || [], requirements };
}

/** Files of the worktree (modified, staged, new) that no approved write path covers. Pure given its inputs. */
export function pathsOutsideWriteScope(paths, { profilePaths, requirements = [], isStoryRecord = () => false }) {
  const outside = [];
  for (const filePath of paths) {
    if (isStoryRecord(filePath)) continue;
    const reasons = [];
    if (!pathMatchesApprovedWriteScope(filePath, profilePaths)) reasons.push("delivery profile");
    for (const requirement of requirements) {
      if (!pathMatchesApprovedWriteScope(filePath, requirement.paths)) reasons.push(`requirement ${requirement.id}`);
    }
    if (reasons.length > 0) outside.push({ path: filePath, outside: reasons });
  }
  return outside;
}

/** Read-only result of the scope check for one story. */
export function storyScopeCheck(context, storyId, requestedPaths = []) {
  const scopes = storyWriteScopes(context, storyId);
  if (!scopes) return { status: "not_applicable", story_id: storyId, out_of_scope: [], checked: 0 };
  const paths = requestedPaths.length > 0
    ? [...new Set(requestedPaths.map((item) => normalizeProjectPathInput(item)))].sort()
    : readExactGitWorkspaceStatus(context).map((entry) => entry.path);
  const records = storyRecordsContext(context, scopes.profile);
  const isStoryRecord = records.policy.in_branch === "include" && records.storyId
    ? (filePath) => storyBranchRecordPath(filePath, records.options)
    : () => false;
  const deliveryActions = deliveryActionAccess(scopes.profile);
  const blockedActions = deliveryActions.filter((item) => !item.allowed);
  const outOfScope = pathsOutsideWriteScope(paths, {
    profilePaths: scopes.profile_paths,
    requirements: scopes.requirements,
    isStoryRecord,
  });
  return {
    status: outOfScope.length > 0 ? "out_of_scope" : blockedActions.length > 0 ? "action_not_allowed" : "clear",
    story_id: storyId,
    delivery_profile_id: scopes.profile_id,
    allowed_write_paths: scopes.profile_paths,
    requirement_write_paths: scopes.requirements,
    checked: paths.length,
    out_of_scope: outOfScope,
    delivery_actions: deliveryActions,
    blocked_actions: blockedActions.map((item) => ({ ...item, remedy: actionRemedy(item, scopes.profile_id) })),
  };
}

/** Human lines for a failing check, with the ways out. */
export function storyScopeWarningLines(result) {
  const lines = [];
  if (result.out_of_scope?.length > 0) {
    lines.push(
      `Write scope: ${result.out_of_scope.length} file(s) of ${result.story_id} are outside the approved write paths; a governed git.commit would refuse them.`,
      ...result.out_of_scope.slice(0, MAX_LISTED_PATHS * 2).map((item) => `- ${item.path} (outside ${item.outside.join(", ")})`),
      `Allowed: ${result.allowed_write_paths.join(", ") || "(none)"}`,
      "Fix: move these files inside an approved path, or revise the requirement or delivery profile write scope and approve it again.",
    );
  }
  if (result.blocked_actions?.length > 0) {
    lines.push(
      `Delivery actions: the active profile ${result.delivery_profile_id} does not allow what the delivery chain will ask for.`,
      ...result.blocked_actions.map((item) => `- ${item.remedy}`),
    );
  }
  return lines;
}

/** One-paragraph summary of the allowed write paths for task start and story claim output; empty when unknown. */
export function storyWriteScopeSummaryLines(context, storyId) {
  try {
    const scopes = storyWriteScopes(context, storyId);
    if (!scopes) return [];
    const paths = scopes.profile_paths;
    const shown = paths.slice(0, MAX_LISTED_PATHS).join(", ");
    const more = paths.length > MAX_LISTED_PATHS ? ` (+${paths.length - MAX_LISTED_PATHS} more)` : "";
    const blocked = deliveryActionAccess(scopes.profile).filter((item) => !item.allowed);
    return [
      `Allowed write paths for ${storyId}: ${shown || "(none)"}${more}. Anything outside them is refused at git.commit; check early with: story scope check --id ${storyId}`,
      ...blocked.map((item) => `Warning: ${actionRemedy(item, scopes.profile_id)}`),
    ];
  } catch {
    return [];
  }
}

export function showStoryScopeCheck(context, options) {
  ensureInitialized(context);
  const id = normalizeId(requireOption(options, "id"));
  if (!readStory(context, id)) fail(`Story ${id} does not exist.`);
  const result = storyScopeCheck(context, id, normalizeListOption(options.paths).flatMap((item) => item.split(",")).map((item) => item.trim()).filter(Boolean));
  output(options, result, result.status === "not_applicable"
    ? [`Story ${id} has no delivery profile yet, so there is no write scope to check.`]
    : result.status === "clear"
      ? [`Story ${id}: ${result.checked} changed file(s), all inside the approved write scope; push, pull request and merge are allowed.`]
      : [
          ...(result.out_of_scope.length === 0 ? [`Story ${id}: ${result.checked} changed file(s), all inside the approved write scope.`] : []),
          ...storyScopeWarningLines(result),
        ]);
}
