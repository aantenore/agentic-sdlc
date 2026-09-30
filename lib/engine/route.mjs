import path from "node:path";
import {
  UserError,
  fail,
} from "../cli/user-error.mjs";
import {
  hasFreshApprovedContractApproval,
} from "../lifecycle/authorization.mjs";
import {
  assertNotDerivedArtifact,
  getOptionString,
  getRoutingPolicy,
  isApprovedRecordFresh,
  normalizeId,
  normalizeListValue,
  pushAllUnique,
} from "../lifecycle/common.mjs";
import {
  ROUTE_REQUIRED_INTENT_FIELDS,
  SDLC_DIR,
} from "../lifecycle/constants.mjs";
import {
  deliveryAutonomyPath,
} from "../lifecycle/delivery.mjs";
import {
  attachAssistantMessagePresentation,
  humanGuidanceLocale,
} from "../lifecycle/guidance.mjs";
import {
  collectOutputArtifactTypes,
  formatRouteDecision,
} from "../lifecycle/output.mjs";
import {
  toProjectPath,
} from "../lifecycle/project.mjs";
import {
  addRouteCheck,
  applyRouteConfidenceGate,
  canonicalIntentCommand,
  canonicalIntentQuestion,
  decideInitProjectRoute,
  decideIntakeRequirementRoute,
  dedupeRouteDecision,
  emptyRouteIntent,
  finalizeAskRoute,
  finalizeConcreteRoute,
  inferTaskPhase,
  isAssessmentRouteIntent,
  normalizeIntentArray,
  normalizeIntentArtifactType,
  normalizeRoutePhase,
  normalizeRouteToken,
  nullableRoutePhase,
  routeActionConfig,
  routeEntityId,
  routeQuestionFromContext,
  routeStoryId,
  taskRouteRequiresContract,
  taskStartAutonomyCopy,
} from "../lifecycle/route.mjs";
import {
  contractNegotiationCommands,
  defaultStoryBranch,
  newestContract,
  storyAcceptanceCriteria,
} from "../lifecycle/story.mjs";
import {
  fs,
  process,
} from "../runtime/host.mjs";
import {
  assessmentNextAction,
  readAssessmentProposal,
  readAssessmentWorkflow,
} from "./assessment.mjs";
import {
  collectTaskStartApprovalRequests,
  contractApprovalGovernanceErrors,
  validatePreviousTaskStartReceiptChain,
  validateTaskStartReceipt,
} from "./authorization.mjs";
import {
  addCapabilityDiscoveryRouteChecks,
  decideCapabilityDiscoveryRoute,
} from "./capability.mjs";
import {
  buildActor,
  buildAttribution,
  collectJsonFiles,
  now,
  prepareExecutionContextPreflight,
} from "./common.mjs";
import {
  VERSION,
} from "./definitions.mjs";
import {
  applyDeliveryAutonomyToTaskStart,
  currentDeliveryExecutionState,
  readDeliveryAutonomyProfile,
} from "./delivery.mjs";
import {
  decideOnboardExistingProjectRoute,
  isKbInitialized,
} from "./migration.mjs";
import {
  addOutputRefChecks,
  output,
  readOutputRegistry,
  renderTaskStartAssistantMessage,
} from "./output.mjs";
import {
  resolveProjectFilePath,
} from "./project.mjs";
import {
  acquireFileLock,
  readStableRegularFileBuffer,
  startTaskLocked,
} from "./storage.mjs";
import {
  assertRequirementReadyForDownstream,
  assertStoryOpenForWork,
  collectContractDependencyFreshnessGaps,
  collectContractReadinessGaps,
  contractNegotiationQuestion,
  inspectStoryContract,
  isClaimExpired,
  readContractById,
  readRequirement,
  readRequirementAutonomyProfile,
  readStory,
  readStoryClaim,
  readTraceEvents,
  selectActiveBaselines,
  validateBaselineSourceHashes,
} from "./story.mjs";

export function decideRoute(context, options) {
  const decision = buildRouteDecision(context, options);
  output(options, decision, formatRouteDecision(decision, options));
}

export function preflightTask(context, options) {
  const decision = buildTaskStartDecision(context, {
    ...options,
    "confirm-start": true,
  });
  if (
    !decision.execution_allowed
    || !decision.story_id
    || !decision.contract_id
    || !decision.delivery_profile_id
  ) {
    process.exitCode = 1;
    output(options, {
      status: "failed",
      execution_allowed: false,
      story_id: decision.story_id || null,
      contract_id: decision.contract_id || null,
      delivery_profile_id: decision.delivery_profile_id || null,
      blocking_reasons: decision.blocking_reasons,
      recovery: [
        "Restore every approved context source to the reviewed content before task start, or create and approve a new requirement/work brief when the context changed intentionally.",
        "No pre-change receipt was written and no source evolution is authorized by this failed preflight.",
      ],
      task_start: decision,
    }, [
      "Execution context preflight failed; no task was started and no source evolution was authorized.",
      ...decision.questions.map((question) => `- ${question}`),
      "Recovery: restore the reviewed pre-start context or approve a new immutable revision, then rerun task preflight.",
    ]);
    return;
  }
  const attribution = buildAttribution(context, options, "task.preflight");
  const prepared = prepareExecutionContextPreflight(context, decision, attribution, { persist: false });
  output(options, {
    status: "passed",
    execution_allowed: true,
    story_id: decision.story_id,
    contract_id: decision.contract_id,
    delivery_profile_id: decision.delivery_profile_id,
    source_count: prepared.receipt.source_snapshots.length,
    authorized_evolution_paths: prepared.receipt.source_snapshots
      .filter((source) => source.disposition === "authorized_evolution")
      .map((source) => source.path),
    immutable_context_paths: prepared.receipt.source_snapshots
      .filter((source) => source.disposition === "immutable_context")
      .map((source) => source.path),
    preexisting_workspace_changes: prepared.receipt.workspace_changes,
    receipt_will_be_written_at_start: prepared.relativePath,
    recovery: [
      "If a listed immutable context path changes before start, restore it or create and approve a new revision.",
      "After start, only listed authorized_evolution_paths may differ from this snapshot; all other drift remains blocked.",
    ],
  }, [
    `Execution context preflight passed for ${decision.story_id}.`,
    `Planned mutable context: ${prepared.receipt.source_snapshots
      .filter((source) => source.disposition === "authorized_evolution")
      .map((source) => source.path)
      .join(", ") || "none"}.`,
    `Immutable context: ${prepared.receipt.source_snapshots
      .filter((source) => source.disposition === "immutable_context")
      .map((source) => source.path)
      .join(", ") || "none"}.`,
    "Task start will rerun this check and atomically seal the pre-change receipt.",
  ]);
}

export function startTask(context, options) {
  const storyOption = getOptionString(options, "story");
  if (storyOption && fs.existsSync(context.sdlcRoot)) {
    assertStoryOpenForWork(context, normalizeId(storyOption), "task start");
  }
  const explicitProfileId = getOptionString(options, "delivery-profile");
  const profilePath = explicitProfileId ? deliveryAutonomyPath(context, normalizeId(explicitProfileId)) : null;
  const releaseLock = profilePath && fs.existsSync(context.sdlcRoot)
    ? acquireFileLock(`${profilePath}.lock`)
    : () => {};
  try {
    return startTaskLocked(context, options);
  } finally {
    releaseLock();
  }
}

export function inspectTaskStartReplacementBoundary(context, receiptPath, candidate = {}) {
  const snapshot = readStableRegularFileBuffer(receiptPath, context.root);
  let receipt;
  try {
    receipt = JSON.parse(snapshot.content.toString("utf8"));
  } catch {
    fail(`Existing task-start boundary is not valid canonical JSON: ${toProjectPath(context, receiptPath)}.`);
  }
  const historyIssues = validatePreviousTaskStartReceiptChain(context, receipt);
  if (historyIssues.length > 0) {
    return {
      allowed: false,
      reason: `its preserved history is invalid (${historyIssues.join("; ")})`,
      snapshot,
      receipt,
    };
  }
  if (receipt.workflow_instance_ref) {
    return {
      allowed: false,
      reason: "the existing run is bound to a story workflow; a successor delivery needs a new story and workflow",
      snapshot,
      receipt,
    };
  }
  const previousProfileId = receipt.delivery_profile_ref?.id
    ? normalizeId(String(receipt.delivery_profile_ref.id))
    : null;
  const previousContractId = receipt.contract_id
    ? normalizeId(String(receipt.contract_id))
    : null;
  const candidateProfileId = candidate.delivery_profile_id
    ? normalizeId(String(candidate.delivery_profile_id))
    : null;
  const candidateContractId = candidate.contract_id
    ? normalizeId(String(candidate.contract_id))
    : null;
  if (!previousProfileId) {
    return {
      allowed: false,
      reason: "the existing run has no terminal delivery boundary",
      snapshot,
      receipt,
    };
  }
  const previousProfile = readDeliveryAutonomyProfile(context, previousProfileId, {
    missingOk: true,
  });
  if (!previousProfile) {
    return {
      allowed: false,
      reason: `the previous delivery choice ${previousProfileId} is missing`,
      snapshot,
      receipt,
    };
  }
  const previousExecution = currentDeliveryExecutionState(context, previousProfile);
  if (previousExecution.lifecycle_status !== "terminal") {
    return {
      allowed: false,
      reason: `delivery ${previousProfileId} is ${previousExecution.lifecycle_status}`,
      snapshot,
      receipt,
    };
  }
  if (!candidateProfileId || candidateProfileId === previousProfileId) {
    return {
      allowed: false,
      reason: "a successor run needs a different delivery choice",
      snapshot,
      receipt,
    };
  }
  if (!candidateContractId || candidateContractId === previousContractId) {
    return {
      allowed: false,
      reason: "a successor run needs a different contract",
      snapshot,
      receipt,
    };
  }
  return {
    allowed: true,
    reason: `terminal predecessor ${previousProfileId} is preserved`,
    snapshot,
    receipt,
  };
}

export function buildTaskStartDecision(context, options) {
  const routeDecision = buildRouteDecision(context, {
    ...options,
    __task_start_preflight: true,
  });
  const policy = getRoutingPolicy(context);
  const intentStoryId = routeDecision.intent ? routeStoryId(routeDecision.intent, policy) : null;
  const explicitStoryId = getOptionString(options, "story")
    ? normalizeId(getOptionString(options, "story"))
    : null;
  const storyId = explicitStoryId || intentStoryId;
  const phase = inferTaskPhase(routeDecision, options);
  const explicitContractId = getOptionString(options, "contract-id") ||
    (routeDecision.intent ? routeEntityId(routeDecision.intent, policy, "contract") : null);
  const result = {
    kind: "task_start",
    schema_version: context.config.schema_version || context.templateConfig.schema_version,
    sdlc_version: VERSION,
    generated_at: now(),
    root: context.root,
    status: "needs_user_input",
    execution_allowed: false,
    route: routeDecision.route,
    phase,
    story_id: storyId,
    contract_id: explicitContractId || null,
    contract_action: null,
    requires_confirmation: routeDecision.requires_confirmation && !options["confirm-start"],
    blocking_reasons: [],
    questions: [],
    deterministic_checks: [],
    next_commands: [],
    approval_requests: [],
    delivery_profile_id: getOptionString(options, "delivery-profile")
      ? normalizeId(getOptionString(options, "delivery-profile"))
      : null,
    delivery_kind: null,
    delivery_profile_path: null,
    autonomy_decision: null,
    autonomy_decision_path: null,
    route_decision: routeDecision,
  };
  Object.defineProperty(result, "__human_locale", {
    value: humanGuidanceLocale(options),
    enumerable: false,
  });
  pushAllUnique(result.blocking_reasons, routeDecision.blocking_reasons);
  pushAllUnique(result.questions, routeDecision.questions);
  pushAllUnique(result.next_commands, routeDecision.next_commands);

  if (explicitStoryId && intentStoryId && explicitStoryId !== intentStoryId) {
    result.status = "needs_user_input";
    result.contract_action = "normalize_request";
    pushAllUnique(result.blocking_reasons, ["story_reference_mismatch"]);
    pushAllUnique(result.questions, [
      `The command names story ${explicitStoryId}, but the normalized request names ${intentStoryId}. Confirm the one story this task should use.`,
    ]);
    result.deterministic_checks.push({
      check: "story_reference_consistency",
      status: "failed",
      details: `${explicitStoryId} != ${intentStoryId}`,
    });
    return dedupeTaskStartDecision(result);
  }

  if (routeDecision.route === "ask_clarification" || routeDecision.status === "needs_normalization") {
    result.status = routeDecision.status === "needs_normalization" ? "needs_normalization" : "needs_user_input";
    result.contract_action = "normalize_request";
    return dedupeTaskStartDecision(result);
  }

  if (!isKbInitialized(context)) {
    result.status = "needs_user_input";
    result.contract_action = "initialize_sdlc";
    pushAllUnique(result.blocking_reasons, ["kb_not_initialized"]);
    pushAllUnique(result.questions, ["Initialize or onboard the project SDLC before starting task work."]);
    return dedupeTaskStartDecision(result);
  }

  const taskStory = storyId ? readStory(context, storyId) : null;
  if (taskStory?.contract_review_required) {
    const staleContractId = taskStory.contract_review_required.contract_id
      || taskStory.contract_id
      || null;
    const staleContract = staleContractId
      ? readContractById(context, staleContractId, { missingOk: true })
      : null;
    result.status = "contract_revision_required";
    result.execution_allowed = false;
    result.contract_action = "replace_contract_after_story_revision";
    result.contract_id = staleContractId;
    result.blocking_reasons = ["story_definition_changed_after_contract"];
    result.questions = [
      `Story ${storyId} acceptance criteria changed after contract ${staleContractId || "the previous work brief"} was prepared. `
      + "Review the revised success conditions and approve a new exact contract before task start.",
    ];
    result.next_commands = [
      `agentic-sdlc contract create --story ${storyId} --phase ${taskStory.phase || "implementation"} `
      + `--id <new-contract-id> --replace-story-contract`
      + `${staleContract?.delivery_execution_profile_id ? " --delivery-profile <new-delivery-profile-id>" : ""} `
      + `--context-summary "<work brief covering the revised acceptance criteria>" --validation "<observable validation>"`,
    ];
    return dedupeTaskStartDecision(result);
  }

  if (routeDecision.route === "init_project" || routeDecision.route === "onboard_existing_project") {
    result.status = "needs_user_input";
    result.contract_action = routeDecision.route;
    pushAllUnique(result.blocking_reasons, [`${routeDecision.route}_required`]);
    pushAllUnique(result.questions, ["Complete the project baseline step before starting phase work."]);
    return dedupeTaskStartDecision(result);
  }

  if (routeDecision.route === "intake_requirement") {
    result.status = "needs_user_input";
    result.contract_action = "agree_requirement";
    pushAllUnique(result.blocking_reasons, ["requirement_agreement_required"]);
    return dedupeTaskStartDecision(result);
  }

  if (routeDecision.route === "decompose_stories") {
    result.status = "needs_user_input";
    result.execution_allowed = false;
    result.contract_action = routeDecision.blocking_reasons.length > 0
      ? "approve_requirement"
      : "record_decomposition";
    if (routeDecision.blocking_reasons.length === 0) {
      pushAllUnique(result.blocking_reasons, ["decomposition_precedes_task_start"]);
      pushAllUnique(result.questions, [
        "Review and record the proposed stories and dependencies first. Task execution starts only after the output, work brief, and delivery-specific autonomy choice are agreed.",
      ]);
    }
    return dedupeTaskStartDecision(result);
  }

  if (isAssessmentRouteIntent(context, routeDecision)) {
    const activeBaselines = selectActiveBaselines(context, storyId);
    if (activeBaselines.length === 0) {
      result.status = "needs_user_input";
      result.contract_action = "approve_or_refresh_project_context";
      pushAllUnique(result.blocking_reasons, ["baseline_missing"]);
      pushAllUnique(result.questions, [
        "Checkpoint 1 of 2 — Which current project files should I inspect and treat as evidence for this assessment? What I need: the source paths and any exclusions. Why: the combined proposal must be based on an approved current-state snapshot, not assumptions. Example answer: “Use README.md, package.json, src/ and tests/; exclude node_modules/, generated files and secrets.” Effect: I will prepare a baseline summary for correction or approval before proposing scope, deliverable, tools and budget.",
      ]);
      pushAllUnique(result.next_commands, [
        "agentic-sdlc baseline propose --id BASELINE-<id> --source README.md --source package.json --source src --summary \"<observable current project context>\"",
      ]);
      return dedupeTaskStartDecision(result);
    }
    const unreadyBaselines = activeBaselines.filter(
      (baseline) =>
        baseline.status !== "approved" ||
        !isApprovedRecordFresh(baseline) ||
        validateBaselineSourceHashes(context, baseline, `baseline ${baseline.id}`, { collectOnly: true }).length > 0,
    );
    if (unreadyBaselines.length > 0) {
      result.status = "needs_user_input";
      result.contract_action = "approve_or_refresh_project_context";
      pushAllUnique(result.blocking_reasons, ["baseline_not_ready"]);
      pushAllUnique(result.questions, [
        `Checkpoint 1 of 2 — Review the current-state summary for ${unreadyBaselines.map((baseline) => baseline.id).join(", ")}. What I need: approve it or name the exact correction. Why: every scope and budget choice at checkpoint 2 is derived from this context. Example answer: “The stack and source list are correct; also include docs/architecture.md, and do not treat examples/ as production code.” Effect: approval makes this snapshot the immutable context reference for the proposal.`,
      ]);
      result.approval_requests = collectTaskStartApprovalRequests(context, result);
      return dedupeTaskStartDecision(result);
    }
    const proposalId = getOptionString(options, "proposal");
    if (!proposalId) {
      result.status = "needs_user_input";
      result.contract_action = "prepare_assessment_proposal";
      pushAllUnique(result.blocking_reasons, ["assessment_proposal_required"]);
      pushAllUnique(result.questions, [
        "Checkpoint 2 of 2 — I must show one combined proposal containing the exact assessment scope, requirement/story reservation, output path and sections, allowed capabilities, contract boundaries, write set, active-time/step limits, and advisory token/cost limits. What I need: approve that exact hash, request a precise change, or reject it. Why: a generic “start” must not silently authorize later files, tools or spend. Example answer: “Approve the exact proposal; hard limit 3,600 active seconds and 60 steps, token estimate advisory only, no production or external access.” Effect: one bounded authorization can materialize and run the approved tranche without repeated confirmations.",
      ]);
      pushAllUnique(result.next_commands, [
        "agentic-sdlc assessment proposal prepare --id ASSESS-<id> --scope-title \"<title>\" --scope-summary \"<exact scope>\" --budget-file <budget.json>",
      ]);
      return dedupeTaskStartDecision(result);
    }
    const assessmentId = normalizeId(proposalId);
    const proposal = readAssessmentProposal(context, assessmentId);
    const assessmentWorkflow = readAssessmentWorkflow(context, assessmentId);
    result.assessment_proposal_id = assessmentId;
    result.assessment_proposal_hash = proposal.proposal_hash;
    result.story_id = proposal.story_reservation?.id || result.story_id;
    result.contract_id = proposal.contract_draft?.id || result.contract_id;
    if (["running", "verifying"].includes(assessmentWorkflow.state)) {
      result.status = "ready_to_execute";
      result.execution_allowed = true;
      result.requires_confirmation = false;
      result.contract_action = "use_assessment_workflow";
      result.blocking_reasons = [];
      result.questions = [];
      result.next_commands = [`agentic-sdlc assessment proposal status --id ${assessmentId}`];
      return dedupeTaskStartDecision(result);
    }
    result.status = "needs_user_input";
    result.contract_action = `assessment_${assessmentWorkflow.state}`;
    pushAllUnique(result.blocking_reasons, [`assessment_${assessmentWorkflow.state}`]);
    const nextAction = assessmentNextAction(assessmentWorkflow.state, assessmentId);
    pushAllUnique(result.questions, [
      `Assessment proposal ${assessmentId} is '${assessmentWorkflow.state}'. What I need: ${nextAction}. Why: only the content-bound assessment workflow may create or start this tranche. Example answer: “Approve ${assessmentId} exactly as shown” or “Change the output path to docs/review.md before approval.” Effect: the workflow advances only when its recorded precondition is satisfied.`,
    ]);
    pushAllUnique(result.next_commands, [nextAction]);
    return dedupeTaskStartDecision(result);
  }

  if (explicitContractId && storyId) {
    const explicitContract = readContractById(context, explicitContractId, { missingOk: true });
    if (explicitContract && explicitContract.story_id !== storyId) {
      result.status = "contract_revision_required";
      result.contract_action = "revise_contract";
      result.contract_id = explicitContract.id;
      result.contract = summarizeTaskContract(context, explicitContract);
      pushAllUnique(result.blocking_reasons, ["contract_story_mismatch"]);
      pushAllUnique(result.questions, [
        `Contract ${explicitContract.id} belongs to ${explicitContract.story_id || "the project"}, not story ${storyId}. Select or create a contract bound to the requested story.`,
      ]);
      result.deterministic_checks.push({
        check: "contract_story_consistency",
        status: "failed",
        details: `${explicitContract.story_id || "PROJECT"} != ${storyId}`,
      });
      pushAllUnique(result.next_commands, contractNegotiationCommands(phase, storyId, null));
      return dedupeTaskStartDecision(result);
    }
  }

  if (routeDecision.route === "confirm_phase_skip") {
    result.status = "needs_user_input";
    result.contract_action = "confirm_phase_skip";
    pushAllUnique(result.blocking_reasons, ["phase_skip_requires_confirmation"]);
    pushAllUnique(result.questions, ["Confirm the requested phase skip explicitly before continuing."]);
    return dedupeTaskStartDecision(result);
  }

  if (routeDecision.route === "create_contract") {
    result.status = "needs_user_input";
    result.contract_action = "create_or_revise_contract";
    pushAllUnique(result.blocking_reasons, ["contract_negotiation_required"]);
    pushAllUnique(result.questions, [contractNegotiationQuestion(phase, storyId)]);
    pushAllUnique(result.next_commands, contractNegotiationCommands(phase, storyId, explicitContractId));
    result.approval_requests = collectTaskStartApprovalRequests(context, result);
    return dedupeTaskStartDecision(result);
  }

  const activeBaselines = selectActiveBaselines(context, storyId);
  const unreadyBaselines = activeBaselines.filter(
    (baseline) =>
      baseline.status !== "approved" ||
      !isApprovedRecordFresh(baseline) ||
      validateBaselineSourceHashes(context, baseline, `baseline ${baseline.id}`, { collectOnly: true }).length > 0,
  );
  if (unreadyBaselines.length > 0) {
    result.status = "needs_user_input";
    result.contract_action = "approve_or_refresh_project_context";
    pushAllUnique(result.blocking_reasons, ["baseline_not_ready"]);
    pushAllUnique(result.questions, ["Refresh or approve the active project context before phase work starts."]);
    result.approval_requests = collectTaskStartApprovalRequests(context, result);
    return dedupeTaskStartDecision(result);
  }

  if (!phase || !taskRouteRequiresContract(routeDecision.route)) {
    return finalizeTaskStartExecution(context, result, routeDecision, options);
  }

  const contractState = findApplicableTaskContract(context, {
    phase,
    storyId,
    contractId: explicitContractId,
  });
  result.contract_id = contractState.contract?.id || explicitContractId || null;
  result.contract = contractState.contract
    ? summarizeTaskContract(context, contractState.contract)
    : null;
  for (const check of contractState.checks) {
    result.deterministic_checks.push(check);
  }

  if (!contractState.contract) {
    result.status = "needs_user_input";
    result.contract_action = "create_contract";
    pushAllUnique(result.blocking_reasons, ["missing_contract"]);
    pushAllUnique(result.questions, [contractNegotiationQuestion(phase, storyId)]);
    pushAllUnique(result.next_commands, contractNegotiationCommands(phase, storyId, explicitContractId));
    result.approval_requests = collectTaskStartApprovalRequests(context, result);
    return dedupeTaskStartDecision(result);
  }

  if (storyId && contractState.bindingMismatch) {
    result.status = "contract_revision_required";
    result.execution_allowed = false;
    result.contract_action = "use_current_story_contract";
    pushAllUnique(result.blocking_reasons, ["contract_not_current_story_binding"]);
    pushAllUnique(result.questions, [
      `Contract ${contractState.contract.id} is historical or unlinked. `
      + `Story ${storyId} currently uses ${contractState.linkedContractId || "no contract"}.`,
    ]);
    result.deterministic_checks.push({
      check: "contract_current_story_binding",
      status: "failed",
      details: `${contractState.contract.id} != ${contractState.linkedContractId || "(none)"}`,
    });
    if (contractState.linkedContractId) {
      pushAllUnique(result.next_commands, [
        `agentic-sdlc task start --story ${storyId} --contract-id ${contractState.linkedContractId} `
        + "--intent-json '<normalized-intent>'",
      ]);
    } else {
      pushAllUnique(result.next_commands, contractNegotiationCommands(phase, storyId, null));
    }
    return dedupeTaskStartDecision(result);
  }

  if (storyId && contractState.contract.story_id !== storyId) {
    result.status = "contract_revision_required";
    result.contract_action = "revise_contract";
    pushAllUnique(result.blocking_reasons, ["contract_story_mismatch"]);
    pushAllUnique(result.questions, [
      `Contract ${contractState.contract.id} belongs to ${contractState.contract.story_id || "the project"}, not story ${storyId}. Select or create a contract bound to the requested story.`,
    ]);
    result.deterministic_checks.push({
      check: "contract_story_consistency",
      status: "failed",
      details: `${contractState.contract.story_id || "PROJECT"} != ${storyId}`,
    });
    pushAllUnique(result.next_commands, contractNegotiationCommands(phase, storyId, null));
    return dedupeTaskStartDecision(result);
  }

  if (options["revise-contract"]) {
    result.status = "contract_revision_required";
    result.contract_action = "revise_contract";
    pushAllUnique(result.blocking_reasons, ["contract_revision_requested"]);
    pushAllUnique(result.questions, [`What should change in contract ${contractState.contract.id} before this task starts?`]);
    pushAllUnique(result.next_commands, contractNegotiationCommands(phase, storyId, contractState.contract.id, { force: true }));
    result.approval_requests = collectTaskStartApprovalRequests(context, result);
    return dedupeTaskStartDecision(result);
  }

  if (contractState.phaseMismatch) {
    result.status = "contract_revision_required";
    result.contract_action = "revise_contract";
    pushAllUnique(result.blocking_reasons, ["contract_phase_mismatch"]);
    pushAllUnique(result.questions, [
      `Contract ${contractState.contract.id} is for ${contractState.contract.phase}; confirm whether to revise it or create a ${phase} contract.`,
    ]);
    pushAllUnique(result.next_commands, contractNegotiationCommands(phase, storyId, contractState.contract.id, { force: true }));
    applyRequirementWriteScopeToTaskStart(context, result, contractState.contract);
    return dedupeTaskStartDecision(result);
  }

  const gaps = collectContractReadinessGaps(context, contractState.contract);
  if (gaps.length > 0) {
    result.status = "needs_user_input";
    result.contract_action = "clarify_contract";
    pushAllUnique(result.blocking_reasons, ["contract_incomplete"]);
    pushAllUnique(result.questions, gaps.map((gap) => gap.question));
    result.approval_requests = collectTaskStartApprovalRequests(context, result);
    return dedupeTaskStartDecision(result);
  }

  const freshnessGaps = collectContractDependencyFreshnessGaps(context, contractState.contract);
  if (freshnessGaps.length > 0) {
    result.status = "contract_revision_required";
    result.contract_action = "refresh_contract_dependencies";
    pushAllUnique(result.blocking_reasons, ["contract_dependencies_stale"]);
    pushAllUnique(result.questions, freshnessGaps.map((gap) => gap.question));
    pushAllUnique(result.next_commands, contractNegotiationCommands(phase, storyId, contractState.contract.id, { force: true }));
    result.approval_requests = collectTaskStartApprovalRequests(context, result);
    return dedupeTaskStartDecision(result);
  }

  if (!isTaskContractApproved(context, contractState.contract)) {
    result.status = "needs_user_input";
    result.contract_action = "approve_contract";
    pushAllUnique(result.blocking_reasons, ["contract_not_approved"]);
    pushAllUnique(result.questions, [
      `Review contract ${contractState.contract.id}. Do you approve it for this ${phase} task, or should it be changed?`,
    ]);
    pushAllUnique(result.next_commands, [
      `agentic-sdlc approval requests${storyId ? ` --story ${storyId}` : ""}`,
    ]);
    result.approval_requests = collectTaskStartApprovalRequests(context, result);
    return dedupeTaskStartDecision(result);
  }

  if (!applyRequirementWriteScopeToTaskStart(context, result, contractState.contract)) {
    return dedupeTaskStartDecision(result);
  }

  if (!applyDeliveryAutonomyToTaskStart(context, result, contractState.contract, options)) {
    return dedupeTaskStartDecision(result);
  }

  return finalizeTaskStartExecution(context, result, routeDecision, options);
}

export function applyRequirementWriteScopeToTaskStart(context, result, contract) {
  if (!result.story_id) return true;
  const outputRefs = Array.isArray(contract.output_contract_refs)
    ? contract.output_contract_refs
    : [];
  const productOrEvidenceRoute = [
    "claim_and_implement",
    "validate_story",
    "release_story",
  ].includes(result.route);
  const productOrEvidencePhase = ["implementation", "validation", "release"].includes(
    result.phase || contract.phase,
  );
  if (!productOrEvidenceRoute && !productOrEvidencePhase && outputRefs.length === 0) {
    result.deterministic_checks.push({
      check: "requirement_write_scope",
      status: "passed",
      details: "Not required for this governance-only task with no durable output.",
    });
    return true;
  }

  const profileRefs = Array.isArray(contract.requirement_execution_profile_refs)
    ? contract.requirement_execution_profile_refs
    : [];
  if (profileRefs.length === 0) {
    // Preserve the configured legacy rollout behavior. enforce_all already
    // blocks this later as an explicit migration; observe/enforce_new_only may
    // still apply their documented supervised fallback.
    return true;
  }
  const profiles = profileRefs.map((ref) => readRequirementAutonomyProfile(context, ref.id));
  const writePaths = [...new Set(profiles.flatMap(
    (profile) => profile.constraints?.allowed_write_paths || [],
  ))].sort();
  result.requirement_write_scope = {
    profile_ids: profiles.map((profile) => profile.id).sort(),
    allowed_write_paths: writePaths,
    required_for_phase: result.phase || contract.phase || null,
    required_for_output_refs: outputRefs.map((ref) => ref.artifact_type).filter(Boolean),
  };
  if (writePaths.length > 0) {
    result.deterministic_checks.push({
      check: "requirement_write_scope",
      status: "passed",
      details: `${writePaths.length} approved project-relative path(s) across ${profiles.length} requirement profile(s).`,
    });
    return true;
  }

  const requirementIds = Array.isArray(contract.requirement_refs)
    ? contract.requirement_refs.map((ref) => ref.id).filter(Boolean)
    : [];
  result.status = "needs_user_input";
  result.execution_allowed = false;
  result.contract_action = "revise_requirement_write_scope";
  pushAllUnique(result.blocking_reasons, ["requirement_write_scope_required"]);
  pushAllUnique(result.questions, [
    "The approved requirement does not name any project code, test, documentation, or evidence area that this story may change. Which project-relative paths should be allowed?",
  ]);
  pushAllUnique(
    result.next_commands,
    requirementIds.length > 0
      ? requirementIds.map((id) =>
          `agentic-sdlc requirement revise --id ${id} --new-id <new-id> `
          + "--write-path <project-relative-path> [--write-path <another-project-relative-path>]")
      : [
          "agentic-sdlc requirement revise --id <requirement-id> --new-id <new-id> "
          + "--write-path <project-relative-path> [--write-path <another-project-relative-path>]",
        ],
  );
  result.deterministic_checks.push({
    check: "requirement_write_scope",
    status: "failed",
    details: "Product or durable-evidence work requires at least one approved project-relative requirement write path.",
  });
  return false;
}

export function finalizeTaskStartExecution(context, result, routeDecision, options) {
  if (result.blocking_reasons.length > 0) {
    result.status = "needs_user_input";
    result.execution_allowed = false;
    result.contract_action = "resolve_route_blockers";
    result.approval_requests = result.approval_requests.length
      ? result.approval_requests
      : collectTaskStartApprovalRequests(context, result);
    return dedupeTaskStartDecision(result);
  }
  const effectiveAutonomy = result.autonomy_decision?.effective_level || result.autonomy?.effective_level || "supervised";
  const preset = context.config.autonomy_policy?.presets?.[effectiveAutonomy] || {};
  const automaticPhases = normalizeListValue(preset.automatic_phases, []);
  const checkpoints = normalizeListValue(preset.checkpoints, []);
  const phaseIsAutomatic = effectiveAutonomy !== "supervised"
    && Boolean(result.phase)
    && automaticPhases.includes(result.phase);
  const autonomyRequiresConfirmation = effectiveAutonomy === "supervised" || !phaseIsAutomatic;
  const routeRequiresConfirmation = routeDecision.requires_confirmation && !phaseIsAutomatic;
  result.autonomy = {
    ...(result.autonomy || {}),
    automatic_phases: automaticPhases,
    checkpoints,
    task_start_automatic: !autonomyRequiresConfirmation && !routeRequiresConfirmation,
  };
  result.requires_confirmation = autonomyRequiresConfirmation || routeRequiresConfirmation;
  if ((autonomyRequiresConfirmation || routeRequiresConfirmation) && !options["confirm-start"]) {
    result.status = "needs_user_input";
    result.execution_allowed = false;
    result.contract_action = "confirm_start";
    pushAllUnique(result.blocking_reasons, [
      ...(routeDecision.requires_confirmation ? ["route_requires_confirmation"] : []),
      effectiveAutonomy === "checkpointed"
        ? "autonomy_checkpoint_required"
        : "autonomy_human_approval_required",
    ]);
    pushAllUnique(result.questions, [
      `Confirm task start for route ${routeDecision.route}${result.contract_id ? ` under contract ${result.contract_id}` : ""}; effective autonomy is ${effectiveAutonomy}.`,
    ]);
    return dedupeTaskStartDecision(result);
  }
  result.status = "ready_to_execute";
  result.execution_allowed = true;
  result.requires_confirmation = false;
  result.contract_action = "use_contract";
  return dedupeTaskStartDecision(result);
}

export function findApplicableTaskContract(context, options = {}) {
  const checks = [];
  const phase = options.phase || null;
  const storyId = options.storyId || null;
  const contractId = options.contractId ? normalizeId(options.contractId) : null;
  const story = storyId ? readStory(context, storyId) : null;
  const linkedContractId = story?.contract_id
    ? normalizeId(String(story.contract_id))
    : null;
  if (contractId) {
    const explicit = readContractById(context, contractId);
    checks.push({
      check: "explicit_contract",
      status: explicit ? "passed" : "failed",
      details: explicit ? contractId : `Missing contract ${contractId}`,
    });
    const bindingMismatch = Boolean(
      storyId
      && (!linkedContractId || linkedContractId !== contractId),
    );
    if (storyId) {
      checks.push({
        check: "story_current_contract",
        status: bindingMismatch ? "failed" : "passed",
        details: bindingMismatch
          ? `Story ${storyId} currently links ${linkedContractId || "no contract"}, not ${contractId}`
          : contractId,
      });
    }
    return {
      contract: explicit,
      phaseMismatch: Boolean(explicit && phase && explicit.phase !== phase),
      bindingMismatch,
      linkedContractId,
      checks,
    };
  }

  if (storyId) {
    const linkedContract = linkedContractId
      ? readContractById(context, linkedContractId, { missingOk: true })
      : null;
    checks.push({
      check: "story_current_contract",
      status: linkedContract ? "passed" : "failed",
      details: linkedContract
        ? linkedContractId
        : `Story ${storyId} has no readable current contract binding`,
    });
    return {
      contract: linkedContract,
      phaseMismatch: Boolean(linkedContract && phase && linkedContract.phase !== phase),
      bindingMismatch: false,
      linkedContractId,
      checks,
    };
  }

  const contracts = collectJsonFiles(context, path.join(context.sdlcRoot, "contracts"));
  const phaseContracts = contracts.filter((contract) => !contract.story_id && (!phase || contract.phase === phase));
  checks.push({
    check: "phase_contract",
    status: phaseContracts.length > 0 ? "passed" : "failed",
    details: phaseContracts.length > 0 ? phaseContracts.map((contract) => contract.id).join(", ") : `No project-level ${phase || "phase"} contract`,
  });
  return {
    contract: phaseContracts.length > 0 ? newestContract(phaseContracts) : null,
    phaseMismatch: false,
    checks,
  };
}

export function summarizeTaskContract(context, contract) {
  const gaps = collectContractReadinessGaps(context, contract);
  const freshnessGaps = collectContractDependencyFreshnessGaps(context, contract);
  return {
    id: contract.id,
    phase: contract.phase || null,
    story_id: contract.story_id || null,
    status: contract.status || null,
    approved: isTaskContractApproved(context, contract),
    readiness_gaps: gaps.map((gap) => gap.code),
    freshness_gaps: freshnessGaps.map((gap) => gap.code),
    path: contract.__relative_path || (contract.__path ? toProjectPath(context, contract.__path) : null),
  };
}

export function isTaskContractApproved(context, contract) {
  return (
    contract.status === "approved" &&
    hasFreshApprovedContractApproval(contract) &&
    contractApprovalGovernanceErrors(context, contract).length === 0 &&
    collectContractReadinessGaps(context, contract).length === 0 &&
    collectContractDependencyFreshnessGaps(context, contract).length === 0
  );
}

export function dedupeTaskStartDecision(decision) {
  decision.blocking_reasons = Array.from(new Set(decision.blocking_reasons));
  decision.questions = Array.from(new Set(decision.questions));
  decision.next_commands = Array.from(new Set(decision.next_commands));
  decision.assistant_message = renderTaskStartAssistantMessage(decision);
  attachAssistantMessagePresentation(decision);
  return decision;
}

export function taskDecisionExampleAnswer(decision, locale = "en") {
  const italian = locale === "it";
  switch (decision.contract_action) {
    case "initialize_sdlc":
      return italian
        ? '“Usa README.md, package.json e src/ come prove di progetto; ignora i file generati.”'
        : '“Use README.md, package.json and src/ as project evidence; ignore generated files.”';
    case "agree_requirement":
      return italian
        ? '“Voglio ridurre a meno di due minuti la creazione di un itinerario; è completo quando l’utente può salvarlo e riaprirlo; non deve acquistare nulla; lavora in autonomia con checkpoint prima di accessi esterni.”'
        : '“I need itinerary creation to take under two minutes; it is complete when a user can save and reopen it; it must not purchase anything; work independently with a checkpoint before external access.”';
    case "approve_requirement":
      return italian
        ? '“Usa il requisito REQ-001 approvato; se non è corrente o manca il limite di autonomia, fermati e fammelo correggere prima della scomposizione.”'
        : '“Use approved requirement REQ-001; if it is not current or lacks its autonomy ceiling, stop and let me correct it before decomposition.”';
    case "record_decomposition":
      return italian
        ? '“La scomposizione proposta è corretta: registra le storie e le dipendenze, poi mostrami output, incarico e scelta di autonomia prima dell’unico avvio.”'
        : '“The proposed breakdown is correct: record the stories and dependencies, then show the output, work brief, and autonomy choice before the single task start.”';
    case "create_or_revise_contract":
    case "create_contract":
    case "clarify_contract":
      return italian
        ? '“Analizza solo il modulo checkout, usa README.md e src/checkout, produci una valutazione tecnica Markdown e non modificare il codice di produzione.”'
        : '“Analyze only the checkout module, use README.md and src/checkout as inputs, deliver a Markdown technical assessment, and do not change production code.”';
    case "replace_contract_after_story_revision":
      return italian
        ? '“I nuovi criteri descrivono correttamente il risultato: prepara un nuovo accordo di lavoro che li includa e fammelo approvare prima di iniziare.”'
        : '“The revised criteria correctly describe the outcome; prepare a new work agreement that includes them and show it for approval before starting.”';
    case "revise_requirement_write_scope":
      return italian
        ? '“Crea una nuova revisione del requisito includendo src/, test/, docs/ ed evidence/ se sono davvero le aree che potranno cambiare; non ampliare oltre il necessario.”'
        : '“Create a new requirement revision that includes src/, test/, docs/, and evidence/ if those are truly the areas that may change; do not widen it further.”';
    case "approve_contract":
      return italian
        ? `“Approvo l’incarico ${decision.contract_id || "mostrato sopra"} esattamente come descritto, senza ampliarne l’ambito.”`
        : `“Approve work brief ${decision.contract_id || "shown above"} exactly as described; do not expand its scope.”`;
    case "confirm_start":
      return italian
        ? `“Avvia ${decision.story_id || "questa attività"} secondo ${decision.contract_id || "l’incarico approvato"}; fermati se devono cambiare ambito o budget.”`
        : `“Start ${decision.story_id || "this task"} under ${decision.contract_id || "the approved brief"}; stop and ask if scope or budget must change.”`;
    case "select_delivery_autonomy":
      if (!decision.delivery_kind) {
        return italian
          ? "“Indica prima la destinazione di questa consegna; poi scegli Guidato, Autonomia con controlli oppure Autonomia completa entro i limiti mostrati.”"
          : "“Name this delivery's destination first, then choose Guided, Autonomy with checks, or Full autonomy within the displayed limits.”";
      }
      return `“${taskStartAutonomyCopy(decision.delivery_kind, locale).choices.join(" / ")}”`;
    case "repair_delivery_autonomy":
      return italian
        ? '“Mantieni separata questa consegna, correggi repository, branch, ambito o checkpoint esatti e rivalutala senza riutilizzare un’approvazione precedente.”'
        : `“Keep this delivery separate, update its exact repository, branch, scope or checkpoint limits, then re-evaluate it without reusing an earlier approval.”`;
    default:
      return italian
        ? '“Usa l’API esistente, mantieni la compatibilità e chiedi prima di aggiungere dipendenze o accessi esterni.”'
        : '“Use the existing API, preserve backward compatibility, and ask before adding dependencies or external access.”';
  }
}

export function buildRouteDecision(context, options) {
  const policy = getRoutingPolicy(context);
  const intentLoad = loadRouteIntent(context, options);
  const decision = createRouteDecision(context, {
    intent_source: intentLoad.source,
    confidence: intentLoad.intent?.confidence,
  });
  decision.requesting_actor = buildActor(options, context.root);

  if (intentLoad.parse_error) {
    addRouteCheck(decision, "canonical_intent", "failed", intentLoad.parse_error);
    return finalizeAskRoute(decision, {
      status: "needs_normalization",
      blocking_reasons: ["invalid_intent_json"],
      questions: [canonicalIntentQuestion()],
      next_commands: [canonicalIntentCommand()],
    });
  }

  if (!intentLoad.intent) {
    addRouteCheck(decision, "canonical_intent", "failed", "No --intent-json or --intent-file provided");
    if (options.text !== undefined) {
      addRouteCheck(decision, "raw_text", "ignored", "Raw text is untrusted and is not classified by the router");
    }
    return finalizeAskRoute(decision, {
      status: "needs_normalization",
      blocking_reasons: ["needs_normalization"],
      questions: [canonicalIntentQuestion()],
      next_commands: [canonicalIntentCommand()],
    });
  }

  const normalized = normalizeRouteIntent(intentLoad.intent, policy, context);
  decision.intent = normalized.intent;
  decision.confidence = normalized.intent.confidence;
  addRouteCheck(
    decision,
    "canonical_intent",
    normalized.errors.length ? "failed" : "passed",
    normalized.errors.length ? normalized.errors.join("; ") : "Canonical JSON intent accepted",
  );
  if (options.text !== undefined) {
    addRouteCheck(decision, "raw_text", "ignored", "Raw text is untrusted; canonical JSON controls routing");
  }
  if (normalized.errors.length) {
    return finalizeAskRoute(decision, {
      status: "needs_normalization",
      blocking_reasons: ["invalid_canonical_intent"],
      questions: normalized.questions.length ? normalized.questions : [canonicalIntentQuestion()],
      next_commands: [canonicalIntentCommand()],
    });
  }

  const confidenceOutcome = applyRouteConfidenceGate(decision, policy);
  if (confidenceOutcome === "ask") {
    return finalizeAskRoute(decision, {
      status: "low_confidence",
      blocking_reasons: ["low_confidence"],
      questions: ["Confirm the canonical intent with higher confidence before routing."],
      next_commands: [canonicalIntentCommand()],
    });
  }

  const preInitActionConfig = routeActionConfig(policy, decision.intent.requested_action);
  const kbInitialized = isKbInitialized(context);
  addRouteCheck(
    decision,
    "kb_initialized",
    kbInitialized ? "passed" : "failed",
    kbInitialized ? `${SDLC_DIR}/project.json exists` : `${SDLC_DIR}/project.json is missing`,
  );
  if (!kbInitialized) {
    if (preInitActionConfig?.route === "onboard_existing_project") {
      decision.route = "onboard_existing_project";
      decision.next_commands.push(`agentic-sdlc onboard existing-project --root ${context.root} --project-name <name> --document <path>`);
      return finalizeConcreteRoute(decision, policy, preInitActionConfig, confidenceOutcome);
    }
    decision.route = "init_project";
    decision.next_commands.push(`agentic-sdlc init --root ${context.root}`);
    return finalizeConcreteRoute(decision, policy, preInitActionConfig?.route === "init_project" ? preInitActionConfig : routeActionConfig(policy, "init_project"), confidenceOutcome);
  }

  if (decision.intent.missing_context.length > 0) {
    return finalizeAskRoute(decision, {
      status: "needs_clarification",
      blocking_reasons: ["missing_context"],
      questions: decision.intent.missing_context.map(routeQuestionFromContext),
      next_commands: [canonicalIntentCommand()],
    });
  }

  if (decision.intent.skip_phases.length > 0) {
    decision.route = "confirm_phase_skip";
    decision.requires_confirmation = true;
    decision.next_commands.push(
      `agentic-sdlc trace append --type decision --summary "Approved phase skip: ${decision.intent.skip_phases.join(", ")}" --actor-type human`,
    );
    return finalizeConcreteRoute(decision, policy, { confirmation_key: "skip_phase" }, confidenceOutcome);
  }

  const actionConfig = routeActionConfig(policy, decision.intent.requested_action);
  if (!actionConfig) {
    return finalizeAskRoute(decision, {
      status: "needs_normalization",
      blocking_reasons: ["unknown_requested_action"],
      questions: [`Use one of the configured requested_action values: ${Object.keys(policy.canonical_actions).sort().join(", ")}.`],
      next_commands: [canonicalIntentCommand()],
    });
  }

  switch (actionConfig.route) {
    case "init_project":
      return decideInitProjectRoute(decision, policy, actionConfig, confidenceOutcome);
    case "onboard_existing_project":
      return decideOnboardExistingProjectRoute(context, decision, policy, actionConfig, confidenceOutcome);
    case "intake_requirement":
      return decideIntakeRequirementRoute(decision, policy, actionConfig, confidenceOutcome);
    case "decompose_stories":
      return decideDecomposeStoriesRoute(context, decision, policy, actionConfig, confidenceOutcome);
    case "create_contract":
      return decideCreateContractRoute(context, decision, policy, actionConfig, confidenceOutcome);
    case "claim_and_implement":
      return decideClaimAndImplementRoute(
        context,
        decision,
        policy,
        actionConfig,
        confidenceOutcome,
        options,
      );
    case "classify_artifact":
      return decideClassifyArtifactRoute(context, decision, policy, actionConfig, confidenceOutcome);
    case "discover_capabilities":
      return decideCapabilityDiscoveryRoute(context, decision, policy, actionConfig, confidenceOutcome);
    case "technical_decision":
      return decideTechnicalDecisionRoute(context, decision, policy, actionConfig, confidenceOutcome);
    case "validate_story":
      return decideStoryGateRoute(context, decision, policy, actionConfig, confidenceOutcome, "validate_story");
    case "release_story":
      return decideStoryGateRoute(context, decision, policy, actionConfig, confidenceOutcome, "release_story");
    case "confirm_phase_skip":
      decision.route = "confirm_phase_skip";
      decision.requires_confirmation = true;
      decision.next_commands.push(
        `agentic-sdlc trace append --type decision --summary "Approved phase skip" --actor-type human`,
      );
      return finalizeConcreteRoute(decision, policy, actionConfig, confidenceOutcome);
    default:
      return finalizeAskRoute(decision, {
        status: "needs_normalization",
        blocking_reasons: ["unknown_route"],
        questions: [`Configured route '${actionConfig.route}' is not supported by this CLI version.`],
        next_commands: [canonicalIntentCommand()],
      });
  }
}

export function loadRouteIntent(context, options) {
  const inline = getOptionString(options, "intent-json");
  const file = getOptionString(options, "intent-file");
  if (inline && file) {
    return { source: "conflict", intent: null, parse_error: "Use only one of --intent-json or --intent-file" };
  }
  if (!inline && !file) {
    return { source: options.text !== undefined ? "raw_text" : "none", intent: null, parse_error: null };
  }
  try {
    if (file) {
      const intentPath = resolveProjectFilePath(context, file, { mustExist: true, fileOnly: true });
      assertNotDerivedArtifact(context, intentPath, "Route intent file");
      return {
        source: toProjectPath(context, intentPath),
        intent: JSON.parse(fs.readFileSync(intentPath, "utf8")),
        parse_error: null,
      };
    }
    return {
      source: "inline",
      intent: JSON.parse(inline),
      parse_error: null,
    };
  } catch (error) {
    return {
      source: file ? "file" : "inline",
      intent: null,
      parse_error: error.message,
    };
  }
}

export function normalizeRouteIntent(rawIntent, policy, context) {
  const errors = [];
  const questions = [];
  const intent = rawIntent && typeof rawIntent === "object" && !Array.isArray(rawIntent) ? rawIntent : null;
  if (!intent) {
    return {
      intent: emptyRouteIntent(),
      errors: ["Canonical intent must be a JSON object"],
      questions: [canonicalIntentQuestion()],
    };
  }

  for (const field of ROUTE_REQUIRED_INTENT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(intent, field)) {
      errors.push(`Missing canonical field '${field}'`);
    }
  }

  const requestedAction = normalizeRouteToken(intent.requested_action);
  if (!requestedAction) {
    errors.push("requested_action must be a configured enum value");
  } else if (!policy.canonical_actions[requestedAction]) {
    errors.push(`requested_action '${intent.requested_action}' is not configured`);
  }

  const confidence = Number(intent.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    errors.push("confidence must be a number between 0 and 1");
  }

  const proposedPhase = nullableRoutePhase(intent.proposed_phase);
  if (proposedPhase && !context.config.phases[proposedPhase]) {
    errors.push(`proposed_phase '${intent.proposed_phase}' is not configured`);
  }

  const actionConfig = policy.canonical_actions[requestedAction] || null;
  const artifactType = normalizeIntentArtifactType(
    intent.artifact_type || actionConfig?.default_artifact_type || null,
    errors,
  );
  if (actionConfig?.requires_artifact_type && !artifactType) {
    errors.push("artifact_type is required for this requested_action");
  }

  const allowedArtifactTypes = new Set(
    collectOutputArtifactTypes(context, readOutputRegistry(context, { missingOk: true })),
  );
  if (artifactType && allowedArtifactTypes.size > 0 && !allowedArtifactTypes.has(artifactType)) {
    errors.push(`artifact_type '${artifactType}' is not configured`);
  }

  const skipPhases = normalizeIntentArray(intent.skip_phases, "skip_phases", errors)
    .map((phase) => normalizeRoutePhase(phase))
    .filter(Boolean);
  for (const phase of skipPhases) {
    if (!context.config.phases[phase]) {
      errors.push(`skip_phases includes unknown phase '${phase}'`);
    }
  }

  const missingContext = normalizeIntentArray(intent.missing_context, "missing_context", errors);
  if (missingContext.length > 0) {
    questions.push(...missingContext.map(routeQuestionFromContext));
  }

  return {
    intent: {
      ...intent,
      requested_action: requestedAction,
      confidence: Number.isFinite(confidence) ? confidence : 0,
      referenced_entities: normalizeIntentArray(intent.referenced_entities, "referenced_entities", errors),
      provided_artifacts: normalizeIntentArray(intent.provided_artifacts, "provided_artifacts", errors),
      missing_context: missingContext,
      proposed_phase: proposedPhase,
      artifact_type: artifactType,
      skip_phases: Array.from(new Set(skipPhases)),
    },
    errors: Array.from(new Set(errors)),
    questions: Array.from(new Set(questions)),
  };
}

export function decideDecomposeStoriesRoute(context, decision, policy, actionConfig, confidenceOutcome) {
  decision.route = "decompose_stories";
  const requirementId = routeEntityId(decision.intent, policy, "requirement");
  const storyId = routeStoryId(decision.intent, policy);
  if (!requirementId) {
    addRouteCheck(decision, "approved_requirement_reference", "failed", "No requirement reference was provided");
    pushAllUnique(decision.blocking_reasons, ["requirement_reference_required"]);
    pushAllUnique(decision.questions, [
      "Which approved requirement should be decomposed? Reference its requirement id so every resulting story stays linked to the agreed outcome, acceptance criteria, exclusions, and autonomy ceiling.",
    ]);
    decision.next_commands.push(canonicalIntentCommand());
    return finalizeConcreteRoute(decision, policy, actionConfig, confidenceOutcome);
  }

  const requirement = readRequirement(context, requirementId, { missingOk: true });
  addRouteCheck(
    decision,
    "requirement_exists",
    requirement ? "passed" : "failed",
    requirement ? requirementId : `${requirementId} not found`,
  );
  if (!requirement) {
    pushAllUnique(decision.blocking_reasons, ["requirement_not_found"]);
    pushAllUnique(decision.questions, [
      `Requirement ${requirementId} does not exist yet. Agree its outcome, acceptance criteria, non-goals, and autonomy ceiling before decomposing it.`,
    ]);
    decision.next_commands.push(
      `agentic-sdlc requirement propose --id ${requirementId} --title "<short title>" --summary "<required outcome>" --acceptance "<observable acceptance criterion>" --non-goal "<explicit exclusion>" --autonomy-ceiling <supervised|checkpointed|bounded-autonomous>`,
    );
    return finalizeConcreteRoute(decision, policy, actionConfig, confidenceOutcome);
  }

  let requirementReady = false;
  let readinessDetails = `${requirementId}:${requirement.status || "unknown"}`;
  try {
    if (requirement.schema_version !== "requirement:v2") {
      fail(`Requirement ${requirementId} must use requirement:v2 before decomposition.`);
    }
    assertRequirementReadyForDownstream(context, requirement, `Requirement ${requirementId}`);
    requirementReady = true;
    readinessDetails = `${requirementId}:approved and current`;
  } catch (error) {
    if (!(error instanceof UserError)) throw error;
    readinessDetails = error.message;
  }
  addRouteCheck(decision, "approved_requirement_ready", requirementReady ? "passed" : "failed", readinessDetails);
  if (!requirementReady) {
    pushAllUnique(decision.blocking_reasons, ["requirement_not_approved"]);
    pushAllUnique(decision.questions, [
      `Requirement ${requirementId} must be a current, approved requirement:v2 with an active autonomy profile before stories can be derived from it.`,
    ]);
    decision.next_commands.push(`agentic-sdlc requirement status --id ${requirementId}`);
    if (requirement.status === "proposed") {
      decision.next_commands.push(
        `agentic-sdlc requirement approve --id ${requirementId} --actor-type human --approval-source explicit-user --summary "<approve this exact requirement and autonomy ceiling>"`,
      );
    }
    return finalizeConcreteRoute(decision, policy, actionConfig, confidenceOutcome);
  }

  if (storyId) {
    const story = readStory(context, storyId);
    addRouteCheck(decision, "story_exists", story ? "passed" : "warning", story ? storyId : `${storyId} not found`);
    if (story) {
      const linkedRequirementIds = new Set([
        ...(story.links?.requirements || []),
        ...(story.requirement_refs || []).map((ref) => ref?.id).filter(Boolean),
      ]);
      const linked = linkedRequirementIds.has(requirementId);
      addRouteCheck(
        decision,
        "story_requirement_link",
        linked ? "passed" : "failed",
        linked ? `${storyId} -> ${requirementId}` : `${storyId} is not linked to ${requirementId}`,
      );
      if (!linked) {
        pushAllUnique(decision.blocking_reasons, ["story_requirement_mismatch"]);
        pushAllUnique(decision.questions, [
          `Story ${storyId} already exists but is not linked to approved requirement ${requirementId}. Revise the story relationship before treating it as part of this decomposition.`,
        ]);
        return finalizeConcreteRoute(decision, policy, actionConfig, confidenceOutcome);
      }
    }
  }

  const targetStoryId = storyId || "<story-id>";
  if (!storyId || !readStory(context, storyId)) {
    decision.next_commands.push(
      `agentic-sdlc story create --id ${targetStoryId} --title "<story outcome>" --requirement ${requirementId} --acceptance "<story-level observable criterion>"`,
    );
  }
  decision.next_commands.push(
    `agentic-sdlc breakdown propose --id BD-${requirementId} --requirement ${requirementId} --item story:${targetStoryId}`,
  );
  return finalizeConcreteRoute(decision, policy, actionConfig, confidenceOutcome);
}

export function decideCreateContractRoute(context, decision, policy, actionConfig, confidenceOutcome) {
  decision.route = "create_contract";
  const storyId = routeStoryId(decision.intent, policy);
  const phase = decision.intent.proposed_phase || "design";
  if (phase === "analysis" || phase === "design") {
    addCapabilityDiscoveryRouteChecks(context, decision, storyId, phase);
  }
  if (storyId) {
    const story = readStory(context, storyId);
    addRouteCheck(decision, "story_exists", story ? "passed" : "failed", story ? storyId : `${storyId} not found`);
    if (!story) {
      return finalizeAskRoute(decision, {
        status: "blocked",
        blocking_reasons: ["story_not_found"],
        questions: [`Create story ${storyId} or provide an existing story reference before creating its contract.`],
        next_commands: [`agentic-sdlc story create --id ${storyId} --title <title> --acceptance <criterion>`],
      });
    }
    const acceptanceReady = storyAcceptanceCriteria(story).length > 0;
    addRouteCheck(
      decision,
      "story_acceptance_criteria",
      acceptanceReady ? "passed" : "failed",
      acceptanceReady ? `${storyAcceptanceCriteria(story).length} criteria` : "No acceptance criteria",
    );
    if (!acceptanceReady) {
      return finalizeAskRoute(decision, {
        status: "blocked",
        blocking_reasons: ["missing_acceptance_criteria"],
        questions: [`Add an observable success criterion to story ${storyId} before defining its work brief.`],
        next_commands: [
          `agentic-sdlc story acceptance add --id ${storyId} --acceptance <criterion>`,
        ],
      });
    }
    decision.next_commands.push(`agentic-sdlc contract create --phase ${phase} --story ${storyId} --id contract-${storyId}-${phase}`);
    decision.next_commands.push(`agentic-sdlc approval requests --story ${storyId}`);
  } else {
    decision.next_commands.push(`agentic-sdlc contract create --phase ${phase} --context-summary <summary>`);
    decision.next_commands.push("agentic-sdlc approval requests");
  }
  return finalizeConcreteRoute(decision, policy, actionConfig, confidenceOutcome);
}

export function decideClaimAndImplementRoute(
  context,
  decision,
  policy,
  actionConfig,
  confidenceOutcome,
  options = {},
) {
  const storyId = routeStoryId(decision.intent, policy);
  if (!storyId) {
    return finalizeAskRoute(decision, {
      status: "needs_clarification",
      blocking_reasons: ["story_reference_required"],
      questions: ["Provide a referenced_entities item with type 'story' and the story id."],
      next_commands: [canonicalIntentCommand()],
    });
  }

  const story = readStory(context, storyId);
  addRouteCheck(decision, "story_exists", story ? "passed" : "failed", story ? storyId : `${storyId} not found`);
  if (!story) {
    return finalizeAskRoute(decision, {
      status: "blocked",
      blocking_reasons: ["story_not_found"],
      questions: [`Create story ${storyId} before implementation, or reference an existing story.`],
      next_commands: [`agentic-sdlc story create --id ${storyId} --title <title> --acceptance <criterion>`],
    });
  }

  const acceptanceReady = storyAcceptanceCriteria(story).length > 0;
  addRouteCheck(
    decision,
    "story_acceptance_criteria",
    acceptanceReady ? "passed" : "failed",
    acceptanceReady ? `${storyAcceptanceCriteria(story).length} criteria` : "No acceptance criteria",
  );
  if (!acceptanceReady) {
    return finalizeAskRoute(decision, {
      status: "blocked",
      blocking_reasons: ["missing_acceptance_criteria"],
      questions: [`Add acceptance criteria to story ${storyId} before implementation.`],
      next_commands: [
        `agentic-sdlc story acceptance add --id ${storyId} --acceptance <criterion>`,
      ],
    });
  }

  const contractState = inspectStoryContract(context, story);
  addRouteCheck(
    decision,
    "story_contract_exists",
    contractState.exists ? "passed" : "failed",
    contractState.message,
  );
  if (!contractState.exists) {
    decision.route = "create_contract";
    decision.blocking_reasons.push("story_contract_missing");
    decision.next_commands.push(
      `agentic-sdlc contract create --phase ${story.phase || "implementation"} --story ${storyId} --id contract-${storyId}-${story.phase || "implementation"}`,
    );
    decision.next_commands.push(`agentic-sdlc approval requests --story ${storyId}`);
    return finalizeConcreteRoute(decision, policy, { confirmation_key: "create_contract" }, confidenceOutcome);
  }
  if (contractState.review_required) {
    addRouteCheck(
      decision,
      "story_contract_current",
      "failed",
      contractState.message,
    );
    decision.route = "create_contract";
    decision.blocking_reasons.push("story_definition_changed_after_contract");
    decision.questions.push(
      `Review the revised success conditions for story ${storyId} and approve a new exact work brief.`,
    );
    decision.next_commands.push(
      `agentic-sdlc contract create --phase ${story.phase || "implementation"} --story ${storyId} `
      + "--id <new-contract-id> --replace-story-contract "
      + '--context-summary "<work brief covering the revised acceptance criteria>" '
      + '--validation "<observable validation>"',
    );
    return finalizeConcreteRoute(
      decision,
      policy,
      { confirmation_key: "create_contract" },
      confidenceOutcome,
    );
  }

  const readinessGaps = collectContractReadinessGaps(context, contractState.contract);
  if (readinessGaps.length > 0) {
    addRouteCheck(
      decision,
      "story_contract_ready",
      "failed",
      readinessGaps.map((gap) => gap.summary).join("; "),
    );
    return finalizeAskRoute(decision, {
      status: "blocked",
      blocking_reasons: ["contract_incomplete"],
      questions: readinessGaps.map((gap) => gap.question).filter(Boolean),
      next_commands: contractNegotiationCommands(
        contractState.contract.phase || story.phase || "implementation",
        storyId,
        contractState.contract.id,
        { force: true },
      ),
    });
  }

  addRouteCheck(
    decision,
    "story_contract_approved",
    contractState.approved ? "passed" : "failed",
    contractState.approved ? contractState.contract.id : `${contractState.contract.id} is not freshly approved`,
  );
  if (!contractState.approved) {
    return finalizeAskRoute(decision, {
      status: "blocked",
      blocking_reasons: ["contract_needs_approval"],
      questions: [`Approve or refresh contract ${contractState.contract.id} before implementation.`],
      next_commands: [
        `agentic-sdlc contract approve --id ${contractState.contract.id} --actor-type human --approval-source explicit-user --summary "<user-approved contract>"`,
      ],
    });
  }

  addOutputRefChecks(context, decision, story, contractState.contract);

  if (options.__task_start_preflight !== true) {
    let taskStartIssues;
    try {
      taskStartIssues = validateTaskStartReceipt(
        context,
        storyId,
        contractState.contract,
      );
    } catch (error) {
      taskStartIssues = [error.message];
    }
    addRouteCheck(
      decision,
      "story_task_start",
      taskStartIssues.length === 0 ? "passed" : "failed",
      taskStartIssues.length === 0
        ? `Current task start is bound to ${contractState.contract.id}`
        : taskStartIssues.join("; "),
    );
    if (taskStartIssues.length > 0) {
      decision.route = "claim_and_implement";
      pushAllUnique(decision.blocking_reasons, ["task_start_required"]);
      pushAllUnique(decision.questions, [
        `Record the immutable task start for current contract ${contractState.contract.id} before assigning story ${storyId}.`,
      ]);
      pushAllUnique(decision.next_commands, [
        `agentic-sdlc task start --story ${storyId} --contract-id ${contractState.contract.id} `
        + "--intent-json '<normalized implement_story intent>' --confirm-start",
      ]);
      decision.requires_confirmation = false;
      decision.status = "blocked";
      dedupeRouteDecision(decision);
      return decision;
    }
  }

  const claim = readStoryClaim(context, storyId);
  if (claim?.status === "active" && !isClaimExpired(context, claim)) {
    if (claim.agent && claim.agent === decision.requesting_actor?.id) {
      addRouteCheck(decision, "active_claim", "passed", `${storyId} is already claimed by the requesting actor ${claim.agent}`);
      decision.route = "claim_and_implement";
      decision.next_commands.push(`agentic-sdlc gate check --story ${storyId} --strict`);
      return finalizeConcreteRoute(decision, policy, actionConfig, confidenceOutcome);
    }
    addRouteCheck(decision, "active_claim", "failed", `${storyId} is already claimed by ${claim.agent || "unknown"}`);
    return finalizeAskRoute(decision, {
      status: "blocked",
      blocking_reasons: ["active_claim_exists"],
      questions: [`Coordinate with ${claim.agent || "the current claimant"} before implementation.`],
      next_commands: [`agentic-sdlc story release --id ${storyId} --agent ${claim.agent || "<agent>"} --reason <reason>`],
    });
  }
  if (claim?.status === "active" && isClaimExpired(context, claim)) {
    addRouteCheck(decision, "active_claim", "failed", `${storyId} has an expired active claim`);
    return finalizeAskRoute(decision, {
      status: "blocked",
      blocking_reasons: ["active_claim_expired"],
      questions: [`Release or renew the expired claim for story ${storyId}.`],
      next_commands: [`agentic-sdlc story release --id ${storyId} --force --reason "Expired claim cleanup"`],
    });
  }

  addRouteCheck(decision, "active_claim", "passed", "No active claim blocks implementation");
  decision.route = "claim_and_implement";
  decision.next_commands.push(`agentic-sdlc story claim --id ${storyId} --agent <agent> --branch ${defaultStoryBranch(context, storyId)}`);
  decision.next_commands.push(`agentic-sdlc gate check --story ${storyId} --strict`);
  return finalizeConcreteRoute(decision, policy, actionConfig, confidenceOutcome);
}

export function decideClassifyArtifactRoute(context, decision, policy, actionConfig, confidenceOutcome) {
  const artifactType = decision.intent.artifact_type || actionConfig.default_artifact_type || null;
  if (!artifactType) {
    return finalizeAskRoute(decision, {
      status: "needs_clarification",
      blocking_reasons: ["artifact_type_required"],
      questions: ["Provide artifact_type as a configured output artifact enum."],
      next_commands: [canonicalIntentCommand()],
    });
  }
  decision.route = "classify_artifact";
  const storyId = routeStoryId(decision.intent, policy);
  if (artifactType === "technical-analysis" || artifactType === "technical-decision-matrix") {
    addCapabilityDiscoveryRouteChecks(context, decision, storyId, decision.intent.proposed_phase || "analysis");
  }
  if (storyId) {
    const story = readStory(context, storyId);
    addRouteCheck(decision, "story_exists", story ? "passed" : "failed", story ? storyId : `${storyId} not found`);
    if (!story) {
      return finalizeAskRoute(decision, {
        status: "blocked",
        blocking_reasons: ["story_not_found"],
        questions: [`Create story ${storyId} or reference an existing story before linking ${artifactType}.`],
        next_commands: [`agentic-sdlc story create --id ${storyId} --title <title> --acceptance <criterion>`],
      });
    }
  }

  const registry = readOutputRegistry(context, { missingOk: true });
  const approvedTemplates = (registry?.templates || []).filter(
    (template) => template.type === artifactType && template.status === "approved",
  );
  addRouteCheck(
    decision,
    "approved_template",
    approvedTemplates.length > 0 ? "passed" : "failed",
    approvedTemplates.length > 0 ? approvedTemplates.map((template) => template.id).join(", ") : `No approved ${artifactType} template`,
  );

  if (decision.intent.requested_action === "new_output_template") {
    decision.next_commands.push(`agentic-sdlc output template propose --type ${artifactType} --summary <summary>`);
    decision.next_commands.push(`agentic-sdlc output template approve --id ${artifactType}-v1 --actor-type human --approval-source explicit-user --summary "<user-approved template>"`);
    return finalizeConcreteRoute(decision, policy, actionConfig, confidenceOutcome);
  }

  if (approvedTemplates.length === 0) {
    decision.blocking_reasons.push("approved_template_missing");
    decision.next_commands.push(`agentic-sdlc output template propose --type ${artifactType} --summary <summary>`);
    decision.next_commands.push(`agentic-sdlc output template approve --id ${artifactType}-v1 --actor-type human --approval-source explicit-user --summary "<user-approved template>"`);
    return finalizeConcreteRoute(decision, policy, actionConfig, confidenceOutcome);
  }

  if (storyId) {
    const links = (registry?.links || []).filter((link) => link.story_id === storyId && link.artifact_type === artifactType);
    addRouteCheck(
      decision,
      "output_link",
      links.length > 0 ? "passed" : "warning",
      links.length > 0 ? `${links.length} existing link(s)` : "No existing output link for this story/artifact type",
    );
    if (links.length > 0 && decision.intent.requested_action !== "duplicate_output") {
      decision.blocking_reasons.push("output_already_linked");
      decision.questions.push(`Confirm whether ${storyId}/${artifactType} should reuse, delta, or duplicate the existing output.`);
      decision.next_commands.push(`agentic-sdlc output status --story ${storyId} --type ${artifactType}`);
      return finalizeConcreteRoute(decision, policy, { ...actionConfig, confirmation_key: "duplicate_output" }, confidenceOutcome);
    }
    decision.next_commands.push(
      `agentic-sdlc output resolve --story ${storyId} --type ${artifactType}`,
    );
    decision.next_commands.push(
      `agentic-sdlc output link --story ${storyId} --type ${artifactType} --artifact <artifact-path> --template ${approvedTemplates[0].id} --mode new`,
    );
  } else {
    decision.next_commands.push(`agentic-sdlc output template propose --type ${artifactType} --summary <summary>`);
  }

  return finalizeConcreteRoute(decision, policy, actionConfig, confidenceOutcome);
}

export function decideTechnicalDecisionRoute(context, decision, policy, actionConfig, confidenceOutcome) {
  decision.route = "technical_decision";
  const storyId = routeStoryId(decision.intent, policy);
  addCapabilityDiscoveryRouteChecks(context, decision, storyId, decision.intent.proposed_phase || "analysis");
  decision.next_commands.push("agentic-sdlc capability status --json");
  decision.next_commands.push("agentic-sdlc contract create --phase analysis --capability-recommendation <id>");
  return finalizeConcreteRoute(decision, policy, actionConfig, confidenceOutcome);
}

export function decideStoryGateRoute(context, decision, policy, actionConfig, confidenceOutcome, route) {
  const storyId = routeStoryId(decision.intent, policy);
  if (!storyId) {
    return finalizeAskRoute(decision, {
      status: "needs_clarification",
      blocking_reasons: ["story_reference_required"],
      questions: ["Provide a referenced_entities item with type 'story' and the story id."],
      next_commands: [canonicalIntentCommand()],
    });
  }
  const story = readStory(context, storyId);
  addRouteCheck(decision, "story_exists", story ? "passed" : "failed", story ? storyId : `${storyId} not found`);
  if (!story) {
    return finalizeAskRoute(decision, {
      status: "blocked",
      blocking_reasons: ["story_not_found"],
      questions: [`Create story ${storyId}, or reference an existing story before ${route}.`],
      next_commands: [`agentic-sdlc story create --id ${storyId} --title <title> --acceptance <criterion>`],
    });
  }
  decision.route = route;
  if (route === "validate_story") {
    const hasTestTrace = readTraceEvents(context, storyId).some((event) => event.type === "test");
    addRouteCheck(decision, "test_trace", hasTestTrace ? "passed" : "warning", hasTestTrace ? "Test trace exists" : "No test trace yet");
    decision.next_commands.push(`agentic-sdlc gate check --story ${storyId} --strict`);
  } else {
    const hasReleaseTrace = readTraceEvents(context, storyId).some((event) => event.type === "release");
    addRouteCheck(
      decision,
      "release_trace",
      hasReleaseTrace ? "passed" : "warning",
      hasReleaseTrace ? "Release trace exists" : "No release trace yet",
    );
    decision.next_commands.push(`agentic-sdlc trace append --story ${storyId} --type release --summary <summary> --evidence <path>`);
    decision.next_commands.push(`agentic-sdlc gate check --story ${storyId} --strict`);
  }
  return finalizeConcreteRoute(decision, policy, actionConfig, confidenceOutcome);
}

export function createRouteDecision(context, options = {}) {
  return {
    schema_version: context.config.schema_version || context.templateConfig.schema_version,
    sdlc_version: VERSION,
    decided_at: now(),
    root: context.root,
    intent_source: options.intent_source || "unknown",
    route: "ask_clarification",
    status: "needs_clarification",
    confidence: Number.isFinite(Number(options.confidence)) ? Number(options.confidence) : 0,
    requires_confirmation: false,
    blocking_reasons: [],
    questions: [],
    deterministic_checks: [],
    next_commands: [],
  };
}
