import path from "node:path";
import {
  buildDeliveryExecutionProfileV2,
} from "../autonomy-policy.mjs";
import {
  fail,
} from "../cli/user-error.mjs";
import {
  deliveryProfileRevisionHistory,
  deliveryProfileRevisionNumber,
} from "../delivery-profile-revisions.mjs";
import {
  autonomyApprovalSubject,
  requireFormalApprovalActor,
} from "../lifecycle/authorization.mjs";
import {
  buildDomainRecord,
  getOptionString,
  normalizeId,
  normalizeRawListOption,
  requireOption,
} from "../lifecycle/common.mjs";
import {
  deliveryAutonomyPath,
  deliveryExecutionProfileSchemaName,
  deliveryMaterialScope,
  deliveryMergeAuthorization,
  deliveryProfileRevisionPath,
} from "../lifecycle/delivery.mjs";
import {
  autonomyDecisionsRoot,
  pathMatchesApprovedWriteScope,
  toProjectPath,
} from "../lifecycle/project.mjs";
import {
  loadAutonomyAuthorityAssurance,
  writeAutonomyApproval,
} from "./authorization.mjs";
import {
  assertRecordSchema,
  buildAttribution,
  now,
  uniqueRecordSuffix,
} from "./common.mjs";
import {
  currentDeliveryAutonomyInputs,
  currentDeliveryExecutionState,
  deliveryActionReceipts,
  effectiveDeliveryProfileStatus,
  evaluateDeliveryAutonomy,
  readDeliveryAutonomyProfile,
} from "./delivery.mjs";
import {
  mergeDecisionFromOptions,
} from "./merge-decision.mjs";
import {
  ensureInitialized,
} from "./migration.mjs";
import {
  output,
} from "./output.mjs";
import {
  resolveProjectFilePath,
} from "./project.mjs";
import {
  acquireFileLock,
  writeJsonFile,
} from "./storage.mjs";
import {
  appendTraceEvent,
} from "./story.mjs";

const MERGE_ACTION = "pull_request.merge";

/** Project-relative write paths named with --add-write-path, narrower than the repository root. */
function addedWritePathsFromOptions(context, options) {
  return [...new Set(normalizeRawListOption(options["add-write-path"]).map((rawPath) => {
    const relative = toProjectPath(context, resolveProjectFilePath(context, rawPath, { mustExist: false }));
    if (!relative || relative === ".") {
      fail("--add-write-path must be narrower than the repository root.");
    }
    return relative;
  }))].sort();
}

/** Git paths a completed commit receipt of the delivery already carried. */
function committedPaths(receipt) {
  return [
    ...(receipt.action_details?.commit?.committed_paths || []),
    ...(receipt.action_details?.changed_paths || []),
  ];
}

/**
 * `autonomy delivery amend`: a new revision of an approved pull-request
 * delivery profile that widens it. Same id and same contract; the earlier
 * revision stays in the history, and its receipts and steps stay valid
 * because a revision only ever adds to what the earlier one approved.
 */
export function amendDeliveryAutonomy(context, options) {
  ensureInitialized(context);
  const profileId = normalizeId(requireOption(options, "id"));
  const profilePath = deliveryAutonomyPath(context, profileId);
  const releaseLock = acquireFileLock(`${profilePath}.lock`);
  try {
    return amendDeliveryAutonomyLocked(context, options, profileId, profilePath);
  } finally {
    releaseLock();
  }
}

function amendDeliveryAutonomyLocked(context, options, profileId, profilePath) {
  const current = readDeliveryAutonomyProfile(context, profileId);
  if (current.status !== "active") {
    fail(`Delivery autonomy profile ${profileId} is '${current.status}'; only an approved (active) profile can be amended.`);
  }
  if (current.delivery_kind !== "pull_request" || current.schema_version !== "delivery-execution-profile:v2") {
    fail("Only a pull-request delivery profile can be amended; a local release profile needs a new profile.");
  }
  if (getOptionString(options, "standing-approval") || current.extensions?.standing_approval_ref) {
    fail("A delivery approved under a standing approval cannot be amended; its limits come from the standing approval.");
  }
  if (effectiveDeliveryProfileStatus(context, current).status === "revoked") {
    fail(`Delivery autonomy profile ${profileId} is revoked and cannot be amended.`);
  }
  const target = current.pull_request_target;
  const wantsMerge = options["merge-allowed"] === true;
  const mergeDecision = mergeDecisionFromOptions(options, "pull_request");
  const addedPaths = addedWritePathsFromOptions(context, options);
  if (!wantsMerge && !mergeDecision && addedPaths.length === 0) {
    fail("Nothing to amend: pass --merge-allowed, --merge <mode>, or --add-write-path <path>.");
  }
  // allowed_actions is the source of truth; a profile whose merge_allowed flag
  // is true without the action is inconsistent and is repaired, not refused.
  const mergeAuthorization = deliveryMergeAuthorization(current);
  const repairsMerge = wantsMerge && mergeAuthorization?.merge_allowed === true && !mergeAuthorization.action_listed;
  if (wantsMerge && mergeAuthorization?.action_listed && mergeAuthorization.merge_allowed) {
    fail(`Delivery autonomy profile ${profileId} already allows pull_request.merge.`);
  }
  const newPaths = addedPaths.filter((item) => !(current.constraints.allowed_write_paths || []).includes(item));
  if (addedPaths.length > 0 && newPaths.length === 0 && !wantsMerge && !mergeDecision) {
    fail(`Delivery autonomy profile ${profileId} already allows the write paths: ${addedPaths.join(", ")}.`);
  }

  const state = currentDeliveryExecutionState(context, current);
  if (state.lifecycle_status === "terminal") {
    fail(`Delivery ${current.delivery_id} is already closed (${state.status}); a closed delivery is not amended.`);
  }
  const receipts = deliveryActionReceipts(context, profileId);
  if ((wantsMerge || mergeDecision) && receipts.some((receipt) => receipt.action === MERGE_ACTION)) {
    fail(`The merge of ${current.delivery_id} was already requested (${MERGE_ACTION} receipt exists); the merge limits are not amended after it.`);
  }

  // Never beyond what the approved requirement and contract allow.
  const inputs = currentDeliveryAutonomyInputs(context, current);
  const requirementBeyond = newPaths.flatMap((item) => inputs.requirementProfiles
    .filter((requirement) => !pathMatchesApprovedWriteScope(item, requirement.constraints?.allowed_write_paths || []))
    .map((requirement) => `${item} (requirement ${requirement.id})`));
  if (requirementBeyond.length > 0) {
    fail(`--add-write-path goes beyond the approved requirement write scope: ${requirementBeyond.join(", ")}. `
      + "Widen the requirement first (requirement revise), then amend.");
  }
  if (wantsMerge && (current.constraints.forbidden_actions || []).includes(MERGE_ACTION)) {
    fail(`${MERGE_ACTION} is forbidden by the profile's exception triggers, so merge_allowed cannot be turned on.`);
  }
  // A governed commit that already touched the new paths proves they were used outside the approved scope.
  const oldPaths = current.constraints.allowed_write_paths || [];
  const touched = receipts
    .filter((receipt) => receipt.action === "git.commit" && receipt.status === "completed")
    .flatMap(committedPaths)
    .filter((item) => pathMatchesApprovedWriteScope(item, newPaths) && !pathMatchesApprovedWriteScope(item, oldPaths));
  if (touched.length > 0) {
    fail(`A governed commit already touched ${[...new Set(touched)].sort().join(", ")} outside the approved write scope; `
      + "the write path is not added after the fact.");
  }
  const nextMergeAllowed = target.merge_allowed === true || wantsMerge;
  if (mergeDecision?.mode === "automatic") {
    if (current.effective_level === "supervised" || current.requested_level === "supervised") {
      fail("--merge automatic is not available at the supervised level, where every merge waits for confirmation.");
    }
    if (!nextMergeAllowed) fail("--merge automatic needs merge to be allowed: add --merge-allowed.");
  }

  const attribution = buildAttribution(context, options, "autonomy.delivery.amend");
  requireFormalApprovalActor(context, options, attribution, "Amending per-delivery autonomy");
  if (target.code_review && getOptionString(options, "approval-source") === "automation") {
    fail("A pull-request delivery carries the user's code review choice, so automation cannot amend it; the user approves it.");
  }

  const nextTarget = {
    ...target,
    merge_allowed: nextMergeAllowed,
    allowed_actions: [...new Set([...target.allowed_actions, ...(wantsMerge ? [MERGE_ACTION] : [])])].sort(),
    ...(mergeDecision ? { merge_decision: mergeDecision } : {}),
  };
  const nextConstraints = {
    ...current.constraints,
    allowed_write_paths: [...new Set([...oldPaths, ...newPaths])].sort(),
  };
  const materialScope = deliveryMaterialScope({
    profileId,
    deliveryId: current.delivery_id,
    deliveryKind: "pull_request",
    requirementProfiles: inputs.requirementProfiles,
    story: inputs.story,
    contract: inputs.contract,
    target: { pull_request_target: nextTarget, local_release_target: null },
    constraints: nextConstraints,
  });
  const number = deliveryProfileRevisionNumber(current);
  const { approved_profile_hash: _approved, ...baseExtensions } = current.extensions || {};
  const summary = getOptionString(options, "summary") || "see the approval evidence";
  const proposed = buildDomainRecord(`Cannot amend delivery autonomy ${profileId}`, () => buildDeliveryExecutionProfileV2({
    ...current,
    status: "proposed",
    pull_request_target: nextTarget,
    constraints: nextConstraints,
    material_scope: materialScope,
    authority_assurance: { mode: "audit_only" },
    approval_ref: null,
    updated_at: now(),
    extensions: {
      ...baseExtensions,
      revision: {
        number: number + 1,
        summary,
        amended_at: now(),
        previous: { revision: number, profile_hash: current.profile_hash },
        history: [...deliveryProfileRevisionHistory(current), { revision: number, profile_hash: current.profile_hash }],
        changes: {
          ...(wantsMerge ? { merge_allowed: true } : {}),
          ...(repairsMerge ? { merge_repaired: true } : {}),
          ...(mergeDecision ? { merge_decision: mergeDecision.mode } : {}),
          ...(newPaths.length > 0 ? { added_write_paths: newPaths } : {}),
        },
      },
    },
  }));
  assertRecordSchema(proposed, deliveryExecutionProfileSchemaName(proposed), `Delivery autonomy profile ${profileId}`);

  const approvalSubject = autonomyApprovalSubject(context, proposed, profilePath);
  const authorityAssurance = loadAutonomyAuthorityAssurance(context, options, "autonomy.delivery.amend", approvalSubject);
  const approval = writeAutonomyApproval(context, proposed, options, attribution, {
    profilePath,
    scope: `exact-${proposed.delivery_kind}:${proposed.delivery_id}`,
    label: `delivery autonomy profile ${profileId} revision ${number + 1}`,
    authorityAction: "autonomy.delivery.amend",
    authoritySubject: approvalSubject,
  });
  const active = buildDomainRecord(`Cannot activate amended delivery autonomy ${profileId}`, () => buildDeliveryExecutionProfileV2({
    ...proposed,
    status: "active",
    authority_assurance: authorityAssurance,
    approval_ref: approval.ref,
    updated_at: now(),
    extensions: { ...proposed.extensions, approved_profile_hash: proposed.profile_hash },
  }));
  assertRecordSchema(active, deliveryExecutionProfileSchemaName(active), `Delivery autonomy profile ${profileId}`);
  const { decision } = evaluateDeliveryAutonomy(context, active, {
    id: `AUT-DEC-${uniqueRecordSuffix()}`,
    phase: getOptionString(options, "phase") || undefined,
  });
  const decisionPath = path.join(autonomyDecisionsRoot(context), `${normalizeId(decision.id)}.json`);
  const revisionPath = deliveryProfileRevisionPath(context, profileId, number);
  writeJsonFile(revisionPath, current, { force: true });
  writeJsonFile(profilePath, active, { force: true });
  writeJsonFile(decisionPath, decision, { force: false });
  appendTraceEvent(context, active.story_refs[0]?.id || null, {
    type: "gate",
    summary: `Amended delivery autonomy ${profileId} to revision ${number + 1}: ${summary}`,
    action: "autonomy.delivery.amend",
    actor: attribution.actor,
    evidence: [toProjectPath(context, profilePath), approval.ref.path, toProjectPath(context, decisionPath), toProjectPath(context, revisionPath)],
    related: [profileId, active.delivery_id],
    git: attribution.git,
    run: attribution.run,
  });
  const changes = active.extensions.revision.changes;
  output(options, {
    status: "amended",
    revision: number + 1,
    previous_revision: number,
    previous_profile_hash: current.profile_hash,
    delivery_profile: active,
    changes,
    approval: approval.envelope,
    autonomy_decision: decision,
    decision_path: toProjectPath(context, decisionPath),
    previous_revision_path: toProjectPath(context, revisionPath),
  }, [
    `Profile: ${profileId} amended to revision ${number + 1} (was ${number}); the contract is unchanged.`,
    ...(changes.merge_repaired ? ["Merge: repaired (merge_allowed was true but pull_request.merge was missing from the allowed actions)."] : []),
    ...(changes.merge_allowed ? ["Merge: allowed (pull_request.merge added to the allowed actions)."] : []),
    ...(changes.merge_decision ? [`Merge decision: ${changes.merge_decision}.`] : []),
    ...(changes.added_write_paths ? [`Write paths added: ${changes.added_write_paths.join(", ")}.`] : []),
    "Receipts and steps recorded under the earlier revision stay valid; new actions use this revision.",
  ]);
}
