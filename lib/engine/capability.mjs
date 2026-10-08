import path from "node:path";
import {
  capabilityInventoryPolicyFromConfig,
  collectCapabilityInventory,
} from "../capability-inventory.mjs";
import {
  deriveCapabilityTags,
  inventoryToAvailableCapabilities,
  matchInventoryCapabilities,
} from "../capability-matching.mjs";
import {
  fail,
} from "../cli/user-error.mjs";
import {
  approvalIssueSeverity,
  formalApprovalActorDescription,
  hasFormalApprovalAttribution,
  hashApprovalSubject,
  latestApprovedRecordApproval,
  requireFormalApprovalActor,
} from "../lifecycle/authorization.mjs";
import {
  buildCapabilityPolicy,
  buildDefaultCapabilityPolicyPatch,
  buildDefaultCapabilityRecommendations,
  capabilityDiscoveryRoot,
  capabilityProfilePath,
  capabilityProfilesRoot,
  capabilityRecommendationPath,
  capabilityRecommendationsRoot,
  capabilityRecordMatchesStory,
  capabilityTargetFilesystemPath,
  capabilityTargetValueIsConcrete,
  collectMissingRequiredCapabilityBindings,
  mergeCapabilityPolicies,
  normalizeCapabilityBinding,
  normalizeCapabilityBindings,
  normalizeCapabilityEvidence,
  normalizeCapabilityOpenQuestions,
  normalizeCapabilityRecommendationRefs,
  normalizeCapabilityRecommendations,
  normalizeCapabilitySubject,
  validateCapabilityPolicy,
  visitCapabilityTargetValues,
} from "../lifecycle/capability.mjs";
import {
  approvedRecordIssueSeverity,
  assertNotDerivedArtifact,
  getOptionString,
  isApprovedRecordFresh,
  mergeList,
  normalizeConfidence,
  normalizeExecutionPolicySuggestions,
  normalizeId,
  normalizeListOption,
  normalizeListValue,
  normalizeObject,
  normalizeRawListOption,
  pushAllUnique,
  requireOption,
} from "../lifecycle/common.mjs";
import {
  assistantMessagePresentationFields,
  executionContextRecoveryMessage,
  humanGuidanceLines,
  humanGuidanceLocale,
} from "../lifecycle/guidance.mjs";
import {
  safeEvidenceExcerpt,
} from "../lifecycle/output.mjs";
import {
  isDerivedArtifactPath,
  isInsidePath,
  toProjectPath,
} from "../lifecycle/project.mjs";
import {
  addRouteCheck,
  finalizeConcreteRoute,
  routeStoryId,
} from "../lifecycle/route.mjs";
import {
  contractExecutionContext,
} from "../lifecycle/story.mjs";
import {
  fs,
} from "../runtime/host.mjs";
import {
  approvalAssistantMessageLinesForLocale,
  buildApprovalRecord,
  buildCapabilityProfileApprovalRequest,
  buildCapabilityRecommendationApprovalRequest,
  renderApprovalRequestsAssistantMessage,
  validateFormalApprovalRecord,
} from "./authorization.mjs";
import {
  assertRecordSchema,
  buildAttribution,
  buildSourceHashes,
  executionContextSourceEvolution,
  loadOptionalJsonInput,
  now,
} from "./common.mjs";
import {
  ensureInitialized,
} from "./migration.mjs";
import {
  output,
} from "./output.mjs";
import {
  detectProjectStack,
  resolveProjectFilePath,
} from "./project.mjs";
import {
  acquireFileLock,
  ensureDir,
  readProjectJson,
  safeReadDir,
  stableContextSourceSnapshot,
  writeJsonFile,
} from "./storage.mjs";
import {
  appendTraceEvent,
  executionContextForStory,
} from "./story.mjs";

export function decideCapabilityDiscoveryRoute(context, decision, policy, actionConfig, confidenceOutcome) {
  decision.route = "discover_capabilities";
  const storyId = routeStoryId(decision.intent, policy);
  const phase = decision.intent.proposed_phase || "analysis";
  addCapabilityDiscoveryRouteChecks(context, decision, storyId, phase);
  const subject = storyId ? ` --story ${storyId}` : "";
  const phaseOption = phase ? ` --phase ${phase}` : "";
  decision.next_commands.push(
    `agentic-sdlc capability profile propose --id CAP-PROFILE-${storyId || "PROJECT"}${subject}${phaseOption} --context-file <path>`,
  );
  decision.next_commands.push(
    `agentic-sdlc capability recommend --id CAP-REC-${storyId || "PROJECT"} --profile CAP-PROFILE-${storyId || "PROJECT"} --from-inventory`,
  );
  return finalizeConcreteRoute(decision, policy, actionConfig, confidenceOutcome);
}

export function addCapabilityDiscoveryRouteChecks(context, decision, storyId, phase) {
  const profiles = findApprovedCapabilityProfiles(context, { storyId, phase });
  addRouteCheck(
    decision,
    "approved_capability_profile",
    profiles.length > 0 ? "passed" : "warning",
    profiles.length > 0 ? profiles.map((profile) => profile.id).join(", ") : "No approved capability profile for this subject",
  );
  if (profiles.length === 0) {
    pushAllUnique(decision.blocking_reasons, ["capability_profile_missing"]);
    const subject = storyId ? ` --story ${storyId}` : "";
    const phaseOption = phase ? ` --phase ${phase}` : "";
    decision.next_commands.push(
      `agentic-sdlc capability profile propose --id CAP-PROFILE-${storyId || "PROJECT"}${subject}${phaseOption} --context-file <path>`,
    );
  }
}

export function capabilityRecommendationMatchesStory(context, recommendation, storyId = null) {
  if (!storyId) {
    return true;
  }
  try {
    const profile = readCapabilityProfile(context, recommendation.profile_id);
    return capabilityRecordMatchesStory(context, profile, storyId);
  } catch {
    return true;
  }
}

export function collectCapabilityBindingReadinessGaps(context, contract) {
  const label = `contract ${contract.id || contract.phase || "work brief"}`;
  const gaps = [];
  const rawBindings = contract.capability_bindings;
  if (rawBindings !== undefined && !Array.isArray(rawBindings)) {
    gaps.push({
      code: "invalid_capability_binding",
      summary: `${label} capability_bindings must be an array`,
      question: "Replace capability_bindings with an array of concrete, structurally valid capability bindings.",
    });
    return { bindings: [], gaps };
  }
  const bindings = [];
  for (const [index, binding] of (rawBindings || []).entries()) {
    try {
      bindings.push(normalizeCapabilityBinding(binding, index));
    } catch (error) {
      gaps.push({
        code: "invalid_capability_binding",
        summary: `${label} ${error.message}`,
        question: `Replace capability binding ${index + 1} with a concrete type, name, non-empty target object, and valid binding id.`,
        binding_index: index,
      });
    }
  }
  const targetReport = { errors: [] };
  validateCapabilityBindingTargets(context, bindings, label, targetReport);
  for (const error of targetReport.errors) {
    gaps.push({
      code: "invalid_capability_binding_target",
      summary: error,
      question: "Move this capability target to canonical project evidence or an explicit external target; derived cache and index paths cannot govern work.",
    });
  }
  return { bindings, gaps };
}

export function loadCapabilityPolicy(context, options) {
  const inline = getOptionString(options, "capability-policy-json");
  const file = getOptionString(options, "capability-policy-file");
  if (inline && file) {
    fail("Use only one of --capability-policy-json or --capability-policy-file.");
  }
  if (!inline && !file) {
    return null;
  }
  try {
    if (file) {
      const policyPath = resolveProjectFilePath(context, file, { mustExist: true, fileOnly: true });
      assertNotDerivedArtifact(context, policyPath, "Capability policy file");
      return JSON.parse(fs.readFileSync(policyPath, "utf8"));
    }
    return JSON.parse(inline);
  } catch (error) {
    fail(`Invalid capability policy JSON: ${error.message}`);
  }
}

export function loadCapabilityBindings(context, options) {
  const bindingJson = normalizeRawListOption(options["capability-binding-json"]);
  const bindingFiles = normalizeRawListOption(options["capability-binding-file"]).map((rawPath) => {
    const bindingPath = resolveProjectFilePath(context, rawPath, { mustExist: true, fileOnly: true });
    assertNotDerivedArtifact(context, bindingPath, "Capability binding file");
    return fs.readFileSync(bindingPath, "utf8");
  });
  return [...bindingJson, ...bindingFiles].map((rawValue) => {
    try {
      return JSON.parse(rawValue);
    } catch (error) {
      fail(`Invalid capability binding JSON: ${error.message}`);
    }
  });
}

export function validateCapabilityBindings(context, contract, label, report) {
  const policy = contract.capability_policy || buildCapabilityPolicy(null);
  validateCapabilityPolicy(policy, `${label} capability_policy`, report);
  const bindings = Array.isArray(contract.capability_bindings) ? contract.capability_bindings : [];
  if (!Array.isArray(contract.capability_bindings)) {
    report.errors.push(`${label} capability_bindings must be an array`);
  }
  const normalizedBindings = [];
  for (const [index, binding] of bindings.entries()) {
    try {
      normalizedBindings.push(normalizeCapabilityBinding(binding, index));
    } catch (error) {
      report.errors.push(`${label} ${error.message}`);
    }
  }
  if (!report.strict) {
    return;
  }
  for (const missing of collectMissingRequiredCapabilityBindings(contract, {
    bindings: normalizedBindings,
  })) {
    report.errors.push(
      `${label} requires ${missing.type} capability '${missing.name}' but has no binding or open contract question`,
    );
  }
  validateCapabilityBindingTargets(context, normalizedBindings, label, report);
}

export function validateCapabilityBindingTargets(context, bindings, label, report) {
  for (const binding of bindings) {
    const target = binding.target || {};
    if (!capabilityTargetValueIsConcrete(target)) {
      report.errors.push(
        `${label} capability binding ${binding.binding_id} target has no concrete recursive value`,
      );
      continue;
    }
    visitCapabilityTargetValues(target, (value, location) => {
      let targetPath;
      try {
        targetPath = capabilityTargetFilesystemPath(value, location.pathLike);
      } catch (error) {
        report.errors.push(
          `${label} capability binding ${binding.binding_id} target.${location.trail.join(".")} `
          + `has an invalid filesystem target: ${error.message}`,
        );
        return;
      }
      if (!targetPath) {
        return;
      }
      if (path.win32.isAbsolute(targetPath) && !path.isAbsolute(targetPath)) {
        // A Windows absolute target is external to this non-Windows project
        // runtime. It is still explicit, but cannot be classified against the
        // current project's derived directories here.
        return;
      }
      let candidate;
      try {
        candidate = path.isAbsolute(targetPath)
          ? path.resolve(targetPath)
          : path.resolve(context.root, targetPath);
      } catch (error) {
        report.errors.push(
          `${label} capability binding ${binding.binding_id} target.${location.trail.join(".")} `
          + `has an invalid filesystem target: ${error.message}`,
        );
        return;
      }
      if (!isInsidePath(context.root, candidate)) {
        return;
      }
      try {
        const resolved = resolveProjectFilePath(context, targetPath, {
          mustExist: false,
        });
        if (isDerivedArtifactPath(context, resolved)) {
          report.errors.push(
            `${label} capability binding ${binding.binding_id} `
            + `target.${location.trail.join(".")} points to derived cache/index path ${value}`,
          );
        }
      } catch (error) {
        report.errors.push(
          `${label} capability binding ${binding.binding_id} target.${location.trail.join(".")} `
          + `is not a safe project path: ${error.message}`,
        );
      }
    });
  }
}

export function validateContractCapabilityRecommendations(context, report, contract, label) {
  const refs = Array.isArray(contract.capability_recommendation_refs) ? contract.capability_recommendation_refs : [];
  const executionContext = contractExecutionContext(contract);
  if (refs.length === 0) {
    return;
  }
  for (const rawRef of refs) {
    let ref;
    try {
      ref = normalizeCapabilityRecommendationRefs([rawRef])[0];
    } catch (error) {
      report.errors.push(`${label} ${error.message}`);
      continue;
    }
    const recommendationPath = capabilityRecommendationPath(context, ref.id);
    if (!fs.existsSync(recommendationPath)) {
      report.errors.push(`${label} references missing capability recommendation ${ref.id}`);
      continue;
    }
    const recommendation = readProjectJson(context, recommendationPath);
    const recommendationLabel = `capability recommendation ${ref.id}`;
    if (recommendation.status !== "approved") {
      report.errors.push(`${label} references ${recommendationLabel} but it is not approved`);
    }
    const latestApproval = latestApprovedRecordApproval(recommendation);
    const recommendationSeverity = approvalIssueSeverity(context, report, latestApproval);
    if (!isApprovedRecordFresh(recommendation)) {
      report[recommendationSeverity].push(`${label} references ${recommendationLabel} but its approval is stale`);
    }
    if (ref.approved_content_hash && latestApproval?.approved_content_hash !== ref.approved_content_hash) {
      report[recommendationSeverity].push(`${label} references ${recommendationLabel} with an outdated approved_content_hash`);
    }
    for (const issue of validateCapabilityRecordSourceHashes(context, recommendation, recommendationLabel, {
      collectOnly: true,
      executionContext,
      bindingKind: "capability_recommendation",
    })) {
      const severity = approvedRecordIssueSeverity(context, report, recommendation);
      report[severity].push(issue);
    }
    const profilePath = capabilityProfilePath(context, recommendation.profile_id);
    if (!recommendation.profile_id || !fs.existsSync(profilePath)) {
      report.errors.push(`${label} ${recommendationLabel} references missing profile ${recommendation.profile_id || "unknown"}`);
    } else {
      const profile = readProjectJson(context, profilePath);
      if (profile.status !== "approved") {
        report.errors.push(`${label} ${recommendationLabel} profile ${profile.id} is not approved or is stale`);
      } else if (!isApprovedRecordFresh(profile)) {
        report[approvedRecordIssueSeverity(context, report, profile)].push(`${label} ${recommendationLabel} profile ${profile.id} is not approved or is stale`);
      }
      for (const issue of validateCapabilityRecordSourceHashes(context, profile, `capability profile ${profile.id}`, {
        collectOnly: true,
        executionContext,
        bindingKind: "capability_profile",
      })) {
        const severity = approvedRecordIssueSeverity(context, report, profile);
        report[severity].push(issue);
      }
    }
    for (const item of recommendation.recommendations || []) {
      if (item.install_required && !item.install_approved) {
        const severity = report.strict ? "errors" : "warnings";
        report[severity].push(`${label} uses install-required capability ${item.type}:${item.name} without install approval`);
      }
    }
    report.checked.push(`${label} capability recommendation ${ref.id}`);
  }
}

export function loadCapabilityRecommendationsForContract(context, options) {
  const ids = normalizeRawListOption(options["capability-recommendation"]).map(normalizeId);
  const result = {
    refs: [],
    policy_patch: null,
    bindings: [],
    open_questions: [],
    execution_policy_suggestions: {
      model: undefined,
      reasoning: undefined,
      notes: [],
    },
  };
  for (const id of ids) {
    const recommendationPath = capabilityRecommendationPath(context, id);
    if (!fs.existsSync(recommendationPath)) {
      fail(`Capability recommendation ${id} does not exist`);
    }
    const recommendation = readProjectJson(context, recommendationPath);
    validateApprovedCapabilityRecommendationForUse(context, recommendation, `capability recommendation ${id}`);
    result.refs.push({
      id,
      profile_id: recommendation.profile_id || null,
      path: toProjectPath(context, recommendationPath),
      approved_content_hash: latestApprovedRecordApproval(recommendation)?.approved_content_hash || null,
    });
    result.policy_patch = mergeCapabilityPolicies(result.policy_patch, recommendation.policy_patch || recommendation.capability_policy || null);
    result.bindings.push(...normalizeCapabilityBindings(recommendation.bindings || recommendation.capability_bindings || []));
    pushAllUnique(result.open_questions, normalizeCapabilityOpenQuestions(recommendation.open_questions, id));
    const suggestions = normalizeExecutionPolicySuggestions(recommendation.execution_policy_suggestions || {});
    result.execution_policy_suggestions.model = result.execution_policy_suggestions.model || suggestions.model;
    result.execution_policy_suggestions.reasoning = result.execution_policy_suggestions.reasoning || suggestions.reasoning;
    pushAllUnique(result.execution_policy_suggestions.notes, suggestions.notes);
  }
  return result;
}

export function proposeCapabilityProfile(context, options) {
  ensureInitialized(context);
  ensureCapabilityDiscoveryDirectories(context);
  const id = normalizeId(requireOption(options, "id"));
  const input = loadOptionalJsonInput(context, options, "profile-json", "profile-file", "Capability profile");
  const contextFiles = normalizeRawListOption(options["context-file"]);
  const attribution = buildAttribution(context, options, "capability.profile.propose");
  const detectedStack = Array.isArray(input.detected_stack) && input.detected_stack.length > 0
    ? input.detected_stack
    : detectProjectStack(context);
  const evidence = [
    ...normalizeCapabilityEvidence(input.evidence),
    ...buildCapabilityEvidenceFromContextFiles(context, contextFiles),
    ...detectedStack.map((item) => ({
      type: "detected_stack",
      path: item.source_path || null,
      summary: `${item.type || "technology"}:${item.name || "unknown"}`,
    })),
  ];
  const sourcePaths = normalizeCapabilitySourcePaths(context, [
    ...normalizeListValue(input.source_paths, []),
    ...evidence.map((item) => item.path).filter(Boolean),
  ]);
  const profile = {
    id,
    schema_version: context.config.schema_version,
    status: "proposed",
    subject: normalizeCapabilitySubject(options, input.subject || {}),
    application_profile: normalizeObject(input.application_profile),
    detected_stack: detectedStack,
    constraints: mergeList(normalizeListValue(input.constraints, []), normalizeListOption(options.constraint)),
    integrations: normalizeListValue(input.integrations, []),
    evidence,
    confidence: normalizeConfidence(input.confidence ?? options.confidence ?? 0.7),
    source_paths: sourcePaths,
    source_hashes: buildSourceHashes(context, sourcePaths),
    approvals: [],
    created_at: now(),
    updated_at: now(),
    audit: {
      proposed_by: attribution.actor,
      git: attribution.git,
      run: attribution.run,
    },
  };
  assertRecordSchema(profile, "capability-profile.schema.json", `Capability profile ${id}`);
  const profilePath = capabilityProfilePath(context, id);
  const releaseLock = acquireFileLock(`${profilePath}.lock`);
  try {
    writeJsonFile(profilePath, profile, { force: Boolean(options.force), forceOption: true });
  } finally {
    releaseLock();
  }
  appendTraceEvent(context, profile.subject.story_id || null, {
    type: "decision",
    summary: `Proposed capability profile ${id}`,
    action: "capability.profile.propose",
    actor: attribution.actor,
    evidence: [toProjectPath(context, profilePath), ...sourcePaths],
    related: [id, profile.subject.story_id, ...(profile.subject.requirement_ids || [])].filter(Boolean),
    git: attribution.git,
    run: attribution.run,
  });
  const approvalRequest = buildCapabilityProfileApprovalRequest(context, profile);
  const assistantMessage = renderApprovalRequestsAssistantMessage([approvalRequest]);
  const localizedAssistantLines = approvalAssistantMessageLinesForLocale(
    [approvalRequest],
    options,
    assistantMessage,
  );
  output(
    options,
    {
      status: "proposed",
      profile_path: profilePath,
      profile,
      assistant_message: assistantMessage,
      ...assistantMessagePresentationFields(),
      approval_request: approvalRequest,
    },
    [
      humanGuidanceLocale(options) === "it"
        ? `Proposto il perimetro di evidenze e strumenti ${id}`
        : `Proposed capability profile ${id}`,
      "",
      ...localizedAssistantLines,
    ],
  );
}

export function approveCapabilityProfile(context, options) {
  ensureInitialized(context);
  const id = normalizeId(requireOption(options, "id"));
  const profilePath = capabilityProfilePath(context, id);
  if (!fs.existsSync(profilePath)) {
    fail(`Capability profile ${id} does not exist`);
  }
  const attribution = buildAttribution(context, options, "capability.profile.approve");
  requireFormalApprovalActor(context, options, attribution, "Approving a capability profile");
  let profile;
  let approval;
  const releaseLock = acquireFileLock(`${profilePath}.lock`);
  try {
    profile = readProjectJson(context, profilePath);
    validateCapabilityRecordSourceHashes(context, profile, `capability profile ${id}`, { failOnStale: true });
    approval = buildApprovalRecord(context, options, attribution, {
      subject: profile,
      subject_id_field: "profile_id",
      subject_id: id,
      scope: options.scope || "capability-profile",
      label: `capability profile ${id}`,
    });
    profile.status = "approved";
    profile.approvals = Array.isArray(profile.approvals) ? profile.approvals : [];
    profile.approvals.push(approval);
    profile.updated_at = now();
    profile.audit = {
      ...(profile.audit || {}),
      approved_by: attribution.actor,
      git: attribution.git,
      run: attribution.run,
    };
    writeJsonFile(profilePath, profile, { force: true });
  } finally {
    releaseLock();
  }
  appendTraceEvent(context, profile.subject?.story_id || null, {
    type: "gate",
    summary: `Approved capability profile ${id}`,
    action: "capability.profile.approve",
    actor: attribution.actor,
    evidence: [toProjectPath(context, profilePath)],
    related: [id, profile.subject?.story_id].filter(Boolean),
    git: attribution.git,
    run: attribution.run,
  });
  output(options, { status: "approved", profile_path: profilePath, approval, profile }, [`Approved capability profile ${id}`]);
}

export function proposeCapabilityRecommendation(context, options) {
  ensureInitialized(context);
  ensureCapabilityDiscoveryDirectories(context);
  const id = normalizeId(requireOption(options, "id"));
  const profileId = normalizeId(requireOption(options, "profile"));
  const profilePath = capabilityProfilePath(context, profileId);
  if (!fs.existsSync(profilePath)) {
    fail(`Capability profile ${profileId} does not exist`);
  }
  const profile = readProjectJson(context, profilePath);
  const input = loadOptionalJsonInput(context, options, "recommendation-json", "recommendation-file", "Capability recommendation");
  const { availableCapabilities, inventoryMatch } = resolveAvailableCapabilities(context, options, profile);
  const attribution = buildAttribution(context, options, "capability.recommend");
  const recommendations = normalizeCapabilityRecommendations(
    input.recommendations || buildDefaultCapabilityRecommendations(profile, availableCapabilities),
  );
  const policyPatch = mergeCapabilityPolicies(
    buildDefaultCapabilityPolicyPatch(recommendations),
    input.policy_patch || input.capability_policy || null,
  );
  const bindings = normalizeCapabilityBindings(input.bindings || input.capability_bindings || []);
  const profileProjectPath = toProjectPath(context, profilePath);
  const sourcePaths = normalizeCapabilitySourcePaths(context, normalizeListValue(input.source_paths, []));
  const recommendation = {
    id,
    schema_version: context.config.schema_version,
    status: "proposed",
    profile_id: profileId,
    profile_ref: {
      path: profileProjectPath,
      approved_content_hash: latestApprovedRecordApproval(profile)?.approved_content_hash || null,
      current_content_hash: hashApprovalSubject(profile),
    },
    recommendations,
    available_capabilities: normalizeObject(availableCapabilities),
    policy_patch: policyPatch,
    bindings,
    execution_policy_suggestions: normalizeExecutionPolicySuggestions(input.execution_policy_suggestions || {}),
    decision_matrix: Array.isArray(input.decision_matrix) ? input.decision_matrix : [],
    open_questions: Array.isArray(input.open_questions) ? input.open_questions : [],
    source_paths: sourcePaths,
    source_hashes: buildSourceHashes(context, sourcePaths),
    approvals: [],
    created_at: now(),
    updated_at: now(),
    audit: {
      proposed_by: attribution.actor,
      git: attribution.git,
      run: attribution.run,
    },
  };
  assertRecordSchema(recommendation, "capability-recommendation.schema.json", `Capability recommendation ${id}`);
  const recommendationPath = capabilityRecommendationPath(context, id);
  const releaseLock = acquireFileLock(`${recommendationPath}.lock`);
  try {
    writeJsonFile(recommendationPath, recommendation, { force: Boolean(options.force), forceOption: true });
  } finally {
    releaseLock();
  }
  appendTraceEvent(context, profile.subject?.story_id || null, {
    type: "decision",
    summary: `Proposed capability recommendation ${id}`,
    action: "capability.recommend",
    actor: attribution.actor,
    evidence: [toProjectPath(context, recommendationPath), toProjectPath(context, profilePath)],
    related: [id, profileId, profile.subject?.story_id].filter(Boolean),
    git: attribution.git,
    run: attribution.run,
  });
  const approvalRequest = buildCapabilityRecommendationApprovalRequest(context, recommendation);
  const assistantMessage = renderApprovalRequestsAssistantMessage([approvalRequest]);
  const localizedAssistantLines = approvalAssistantMessageLinesForLocale(
    [approvalRequest],
    options,
    assistantMessage,
  );
  output(
    options,
    {
      status: "proposed",
      recommendation_path: recommendationPath,
      recommendation,
      ...(inventoryMatch ? { inventory_match: inventoryMatch } : {}),
      assistant_message: assistantMessage,
      ...assistantMessagePresentationFields(),
      approval_request: approvalRequest,
    },
    [
      humanGuidanceLocale(options) === "it"
        ? `Proposta la selezione di strumenti ${id}`
        : `Proposed capability recommendation ${id}`,
      ...(inventoryMatch ? inventoryMatchLines(inventoryMatch, humanGuidanceLocale(options) === "it") : []),
      "",
      ...localizedAssistantLines,
    ],
  );
}

/**
 * The available capabilities for a recommendation: the ones the caller
 * supplied, or, with --from-inventory, the installed inventory. An inventory
 * lists everything installed, not what the work needs, so only the entries
 * that name a technology declared by the profile (its detected stack and
 * integrations) are left eligible for the proposal, at most
 * matching.max_suggestions of them; every other installed entry is recorded
 * as available but not recommended. The result is validated like any other
 * recommendation and still waits for approval.
 */
function resolveAvailableCapabilities(context, options, profile) {
  const fromInventory = options["from-inventory"] === true;
  const supplied = options["available-capabilities-json"] !== undefined
    || options["available-capabilities-file"] !== undefined;
  if (fromInventory && supplied) {
    fail("Use either --from-inventory or --available-capabilities-json/--available-capabilities-file, not both.");
  }
  if (!fromInventory) {
    return {
      availableCapabilities: loadOptionalJsonInput(
        context,
        options,
        "available-capabilities-json",
        "available-capabilities-file",
        "Available capabilities",
      ),
      inventoryMatch: null,
    };
  }
  const policy = capabilityInventoryPolicyFromConfig(context.config);
  if (!policy.enabled) {
    fail(
      "--from-inventory needs the installed-capability inventory, which is turned off by "
      + "capability_discovery_policy.inventory.enabled. Turn it on, or pass --available-capabilities-json "
      + "or --available-capabilities-file.",
    );
  }
  const inventory = collectCapabilityInventory({ projectRoot: context.root, policy });
  const tags = deriveCapabilityTags(
    { detectedStack: profile.detected_stack, integrations: profile.integrations },
    policy.matching,
  );
  const matches = matchInventoryCapabilities(inventory, tags, {
    phase: profile.subject?.phase ?? null,
    matching: policy.matching,
  });
  const chosen = matches.slice(0, policy.matching.max_suggestions);
  const available = inventoryToAvailableCapabilities(inventory, {
    recommend: new Set(chosen.map((match) => `${match.type}:${match.name}`)),
    matches,
  });
  return {
    availableCapabilities: { ...available, origin: inventory.schema_version },
    inventoryMatch: {
      origin: inventory.schema_version,
      counts: inventory.counts,
      truncated: inventory.truncated,
      tags: tags.map((entry) => entry.tag),
      matched_total: matches.length,
      proposed: chosen.map((match) => ({
        type: match.type,
        name: match.name,
        matched_tags: match.matched_tags,
        path: match.path,
      })),
    },
  };
}

function inventoryMatchLines(match, italian) {
  const considered = match.counts.skills + match.counts.plugins + match.counts.mcp;
  if (match.proposed.length === 0) {
    return [italian
      ? `Capacità installate esaminate: ${considered}; nessuna cita le tecnologie dichiarate dal contesto${match.tags.length === 0 ? " (il contesto non ne dichiara)" : ""}, quindi viene proposta solo la skill di governo integrata.`
      : `Installed capabilities examined: ${considered}; none names a technology the context declares${match.tags.length === 0 ? " (the context declares none)" : ""}, so only the built-in governance skill is proposed.`];
  }
  const list = match.proposed.map((item) => `${item.type}:${item.name}`).join(", ");
  return [italian
    ? `Capacità installate esaminate: ${considered}; proposte perché citano le tecnologie dichiarate (${match.tags.join(", ")}): ${list}.`
    : `Installed capabilities examined: ${considered}; proposed because they name the declared technology (${match.tags.join(", ")}): ${list}.`];
}

export function approveCapabilityRecommendation(context, options) {
  ensureInitialized(context);
  const id = normalizeId(requireOption(options, "id"));
  const recommendationPath = capabilityRecommendationPath(context, id);
  if (!fs.existsSync(recommendationPath)) {
    fail(`Capability recommendation ${id} does not exist`);
  }
  const attribution = buildAttribution(context, options, "capability.approve");
  requireFormalApprovalActor(context, options, attribution, "Approving a capability recommendation");
  const requestedApprovalSource = String(getOptionString(options, "approval-source") || "").trim().toLowerCase();
  const directInstallApproval =
    (requestedApprovalSource === "explicit-user" && attribution.actor.type === "human") ||
    ((requestedApprovalSource === "ci" || (!requestedApprovalSource && attribution.actor.type === "ci")) && attribution.actor.type === "ci");
  if (options["approve-install"] && !directInstallApproval) {
    fail("Approving capability installation requires direct explicit-user or CI approval; delegated automation cannot expand into installs.");
  }
  let recommendation;
  let profile;
  let approval;
  const releaseLock = acquireFileLock(`${recommendationPath}.lock`);
  try {
    recommendation = readProjectJson(context, recommendationPath);
    profile = readCapabilityProfile(context, recommendation.profile_id);
    validateApprovedCapabilityProfileForUse(context, profile, `capability profile ${recommendation.profile_id}`);
    validateCapabilityRecordSourceHashes(context, recommendation, `capability recommendation ${id}`, { failOnStale: true });
    if (options["approve-install"]) {
      recommendation.recommendations = (recommendation.recommendations || []).map((item) =>
        item.install_required ? { ...item, install_approved: true, install_approved_at: now(), install_approved_by: attribution.actor } : item,
      );
    }
    recommendation.profile_ref = {
      path: toProjectPath(context, capabilityProfilePath(context, recommendation.profile_id)),
      approved_content_hash: latestApprovedRecordApproval(profile)?.approved_content_hash || null,
      current_content_hash: hashApprovalSubject(profile),
    };
    approval = buildApprovalRecord(context, options, attribution, {
      subject: recommendation,
      subject_id_field: "recommendation_id",
      subject_id: id,
      scope: options.scope || "capability-recommendation",
      label: `capability recommendation ${id}`,
    });
    recommendation.status = "approved";
    recommendation.approvals = Array.isArray(recommendation.approvals) ? recommendation.approvals : [];
    recommendation.approvals.push(approval);
    recommendation.updated_at = now();
    recommendation.audit = {
      ...(recommendation.audit || {}),
      approved_by: attribution.actor,
      git: attribution.git,
      run: attribution.run,
    };
    writeJsonFile(recommendationPath, recommendation, { force: true });
  } finally {
    releaseLock();
  }
  appendTraceEvent(context, profile.subject?.story_id || null, {
    type: "gate",
    summary: `Approved capability recommendation ${id}`,
    action: "capability.approve",
    actor: attribution.actor,
    evidence: [toProjectPath(context, recommendationPath)],
    related: [id, recommendation.profile_id, profile.subject?.story_id].filter(Boolean),
    git: attribution.git,
    run: attribution.run,
  });
  output(options, { status: "approved", recommendation_path: recommendationPath, approval, recommendation }, [`Approved capability recommendation ${id}`]);
}

export function showCapabilityStatus(context, options) {
  ensureInitialized(context);
  const storyId = options.story ? normalizeId(String(options.story)) : null;
  const profileId = options.profile ? normalizeId(String(options.profile)) : null;
  const profiles = readCapabilityProfiles(context).filter((profile) => {
    if (profileId && profile.id !== profileId) {
      return false;
    }
    return !storyId || profile.subject?.story_id === storyId;
  });
  const profileIds = new Set(profiles.map((profile) => profile.id));
  const recommendations = readCapabilityRecommendations(context).filter((recommendation) => {
    if (profileId && recommendation.profile_id !== profileId) {
      return false;
    }
    return !storyId || profileIds.has(recommendation.profile_id);
  });
  const scopedStoryId = storyId || (
    profiles.length === 1 ? profiles[0].subject?.story_id || null : null
  );
  const executionContext = scopedStoryId
    ? executionContextForStory(context, scopedStoryId)
    : null;
  const status = {
    profiles: profiles.map((profile) => capabilityRecordStatus(
      context,
      profile,
      `capability profile ${profile.id}`,
      { executionContext, bindingKind: "capability_profile" },
    )),
    recommendations: recommendations.map((recommendation) =>
      capabilityRecordStatus(
        context,
        recommendation,
        `capability recommendation ${recommendation.id}`,
        { executionContext, bindingKind: "capability_recommendation" },
      ),
    ),
  };
  output(
    options,
    status,
    [
      `Capability profiles: ${status.profiles.length}`,
      ...status.profiles.map((profile) => `${profile.id}: ${profile.status}${profile.fresh ? "" : " (stale)"}`),
      `Capability recommendations: ${status.recommendations.length}`,
      ...status.recommendations.map((recommendation) => `${recommendation.id}: ${recommendation.status}${recommendation.fresh ? "" : " (stale)"}`),
    ],
  );
}

const INVENTORY_GROUP_LINE_LIMIT = 25;

function inventoryGuidance(inventory, italian) {
  if (!inventory.enabled) {
    return italian
      ? {
          result: "L’elenco degli strumenti installati è disattivato nelle impostazioni di questo progetto.",
          impact: "Non è stato letto nulla e nulla è stato modificato, installato o approvato.",
          required_decision: "Per ora nulla. Riattivalo nelle impostazioni solo se vuoi che proponga gli strumenti già installati.",
          protection_boundary: "Nessuna cartella locale è stata aperta.",
          next_action: "Continua indicando tu stesso gli strumenti disponibili, oppure riattiva l’elenco nelle impostazioni.",
        }
      : {
          result: "The list of installed tools is turned off in this project's settings.",
          impact: "Nothing was read, and nothing was changed, installed, or approved.",
          required_decision: "Nothing right now. Turn it back on in the settings only if you want me to propose tools that are already installed.",
          protection_boundary: "No local folder was opened.",
          next_action: "Continue by naming the available tools yourself, or turn the list back on in the settings.",
        };
  }
  return italian
    ? {
        result: "Ho elencato le skill, i comandi, i plugin e i server di strumenti già installati per te e per questo progetto.",
        impact: "Nulla è stato modificato, installato o approvato: è solo un elenco di sola lettura.",
        required_decision: "Per ora nulla. Se alcuni strumenti servono per un lavoro, chiedimi di proporli alla tua revisione.",
        protection_boundary: "Sono state lette solo cartelle locali note e sono stati conservati solo nomi e brevi descrizioni; impostazioni dei server, chiavi e altri valori non sono stati conservati.",
        next_action: "Chiedimi di proporre gli strumenti installati adatti al lavoro, oppure apri i dettagli facoltativi per vedere ogni voce.",
      }
    : {
        result: "I listed the skills, commands, plugins, and tool servers that are already installed for you and this project.",
        impact: "Nothing was changed, installed, or approved; this is a read-only list.",
        required_decision: "Nothing right now. If some of these should be used for a piece of work, ask me to propose them for your review.",
        protection_boundary: "Only well-known local folders were read, and only names and short descriptions were kept; server settings, keys, and other values were not.",
        next_action: "Ask me to propose the installed tools that fit the work, or open the optional details to see every item.",
      };
}

function inventoryDetailLines(inventory, italian, full) {
  const label = italian
    ? { skills: "Skill", commands: "Comandi", plugins: "Plugin", mcp: "Server MCP", places: "Posizioni lette", more: "altre voci; usa --full o --json per l’elenco completo", warnings: "Avvisi", truncated: "Elenco troncato dai limiti configurati" }
    : { skills: "Skills", commands: "Commands", plugins: "Plugins", mcp: "MCP servers", places: "Locations read", more: "more; use --full or --json for the whole list", warnings: "Warnings", truncated: "List cut short by the configured limits" };
  const lines = [];
  const group = (title, entries, describe) => {
    lines.push(`${title}: ${entries.length}`);
    const shown = full ? entries : entries.slice(0, INVENTORY_GROUP_LINE_LIMIT);
    for (const entry of shown) lines.push(describe(entry));
    if (shown.length < entries.length) lines.push(`... ${entries.length - shown.length} ${label.more}`);
  };
  const withDescription = (text, description) => (description ? `${text} - ${description}` : text);
  group(label.skills, inventory.skills, (entry) => withDescription(
    `skill ${entry.name} [${entry.scope}${entry.plugin ? `, ${entry.plugin}` : ""}] ${entry.path}`,
    entry.description,
  ));
  group(label.commands, inventory.commands, (entry) => withDescription(
    `command ${entry.name} [${entry.scope}${entry.plugin ? `, ${entry.plugin}` : ""}] ${entry.path}`,
    entry.description,
  ));
  group(label.plugins, inventory.plugins, (entry) => withDescription(
    `plugin ${entry.name}${entry.version ? ` ${entry.version}` : ""} [${entry.scope}] ${entry.path}`,
    entry.description,
  ));
  group(label.mcp, inventory.mcp, (entry) => (
    `mcp ${entry.name} [${entry.scope}, ${entry.transport}${entry.enabled === false ? ", disabled" : ""}] ${entry.path}`
  ));
  const read = inventory.sources.filter((source) => source.status === "read");
  lines.push(`${label.places}: ${read.length}/${inventory.sources.length} (${inventory.sources.map((source) => `${source.id}=${source.status}`).join(", ") || "-"})`);
  if (inventory.truncated) lines.push(label.truncated);
  if (inventory.warnings.length > 0) lines.push(`${label.warnings}: ${inventory.warnings.join("; ")}`);
  return lines;
}

/**
 * `capability inventory`: list the skills, commands, plugins, and MCP servers
 * that are already installed for this user and project. Read-only: it opens
 * only the well-known local locations named by
 * capability_discovery_policy.inventory and keeps names and short
 * descriptions only.
 */
export function showCapabilityInventory(context, options) {
  const inventory = collectCapabilityInventory({
    projectRoot: context.root,
    policy: capabilityInventoryPolicyFromConfig(context.config),
  });
  const italian = humanGuidanceLocale(options) === "it";
  output(
    options,
    inventory,
    humanGuidanceLines(
      inventoryGuidance(inventory, italian),
      inventoryDetailLines(inventory, italian, options.full === true),
      options,
    ),
  );
}

export function ensureCapabilityDiscoveryDirectories(context) {
  ensureDir(capabilityDiscoveryRoot(context));
  ensureDir(capabilityProfilesRoot(context));
  ensureDir(capabilityRecommendationsRoot(context));
}

export function readCapabilityProfile(context, id) {
  const profilePath = capabilityProfilePath(context, id);
  if (!fs.existsSync(profilePath)) {
    fail(`Capability profile ${id} does not exist`);
  }
  return readProjectJson(context, profilePath);
}

export function readCapabilityProfiles(context) {
  return safeReadDir(capabilityProfilesRoot(context))
    .filter((name) => name.endsWith(".json"))
    .map((name) => readProjectJson(context, path.join(capabilityProfilesRoot(context), name)))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

export function readCapabilityRecommendations(context) {
  return safeReadDir(capabilityRecommendationsRoot(context))
    .filter((name) => name.endsWith(".json"))
    .map((name) => readProjectJson(context, path.join(capabilityRecommendationsRoot(context), name)))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

export function buildCapabilityEvidenceFromContextFiles(context, contextFiles) {
  return contextFiles.map((rawPath) => {
    const snapshot = stableContextSourceSnapshot(context, rawPath, "Capability context file");
    const resolved = snapshot.filePath;
    const content = snapshot.content;
    return {
      type: "context_file",
      path: snapshot.projectPath,
      sha256: snapshot.sha256,
      size_bytes: content.length,
      excerpt: safeEvidenceExcerpt(resolved, content.toString("utf8"), 600),
      trust: "untrusted_project_evidence",
    };
  });
}

export function normalizeCapabilitySourcePaths(context, rawPaths) {
  const result = [];
  for (const rawPath of rawPaths) {
    if (!rawPath) {
      continue;
    }
    const snapshot = stableContextSourceSnapshot(context, rawPath, "Capability source path");
    result.push(snapshot.projectPath);
  }
  return Array.from(new Set(result)).sort();
}

export function findApprovedCapabilityProfiles(context, options = {}) {
  return readCapabilityProfiles(context).filter((profile) => {
    if (profile.status !== "approved" || !isApprovedRecordFresh(profile)) {
      return false;
    }
    if (validateCapabilityRecordSourceHashes(context, profile, `capability profile ${profile.id}`, { collectOnly: true }).length > 0) {
      return false;
    }
    if (options.storyId && profile.subject?.story_id && profile.subject.story_id !== options.storyId) {
      return false;
    }
    if (options.phase && profile.subject?.phase && profile.subject.phase !== options.phase) {
      return false;
    }
    return true;
  });
}

export function capabilityRecordStatus(context, record, label, options = {}) {
  const staleSources = validateCapabilityRecordSourceHashes(context, record, label, {
    collectOnly: true,
    executionContext: options.executionContext || null,
    bindingKind: options.bindingKind,
  });
  return {
    id: record.id,
    status: record.status || "unknown",
    fresh: staleSources.length === 0 && (record.status !== "approved" || isApprovedRecordFresh(record)),
    stale_sources: staleSources,
    source_paths: record.source_paths || [],
  };
}

export function validateCapabilityRecordSourceHashes(context, record, label, options = {}) {
  const issues = [];
  const sourceHashes = record.source_hashes || {};
  const sourcePaths = new Set([...(record.source_paths || []), ...Object.keys(sourceHashes)]);
  for (const sourcePath of sourcePaths) {
    const expectedHash = sourceHashes[sourcePath];
    if (!expectedHash) {
      issues.push(`${label} source ${sourcePath} has no recorded hash`);
    } else {
      let currentMatches = false;
      let safeSnapshot = false;
      let snapshotError = null;
      try {
        const snapshot = stableContextSourceSnapshot(context, sourcePath, "Capability source");
        safeSnapshot = true;
        currentMatches = snapshot.sha256 === expectedHash;
      } catch (error) {
        snapshotError = error.message;
      }
      if (currentMatches) continue;
      const evolution = safeSnapshot && options.executionContext
        ? executionContextSourceEvolution(context, {
            ...options.executionContext,
            sourcePath,
            expectedSha256: expectedHash,
            bindingKind: options.bindingKind || "capability_profile",
            bindingId: record.id,
          })
        : { allowed: false };
      if (!evolution.allowed) {
        issues.push(
          snapshotError
            ? `${label} source ${sourcePath} is unsafe: ${snapshotError}`
            : `${label} source ${sourcePath} changed after record creation and is missing or changed outside its approved pre-change snapshot. `
              + executionContextRecoveryMessage(sourcePath),
        );
      }
    }
  }
  if (options.failOnStale && issues.length > 0) {
    fail(issues.join("; "));
  }
  if (options.collectOnly) {
    return issues;
  }
  return issues;
}

export function validateApprovedCapabilityProfileForUse(context, profile, label, options = {}) {
  if (!profile || profile.status !== "approved" || !isApprovedRecordFresh(profile)) {
    fail(`${label} is not approved or its approval is stale`);
  }
  validateCapabilityRecordSourceHashes(context, profile, label, {
    failOnStale: true,
    executionContext: options.executionContext || null,
    bindingKind: "capability_profile",
  });
}

export function validateApprovedCapabilityRecommendationForUse(context, recommendation, label, options = {}) {
  if (!recommendation || recommendation.status !== "approved" || !isApprovedRecordFresh(recommendation)) {
    fail(`${label} is not approved or its approval is stale`);
  }
  validateCapabilityRecordSourceHashes(context, recommendation, label, {
    failOnStale: true,
    executionContext: options.executionContext || null,
    bindingKind: "capability_recommendation",
  });
  const profile = readCapabilityProfile(context, recommendation.profile_id);
  validateApprovedCapabilityProfileForUse(
    context,
    profile,
    `capability profile ${recommendation.profile_id}`,
    options,
  );
  for (const item of recommendation.recommendations || []) {
    if (item.install_required && !item.install_approved) {
      fail(`${label} requires installation of ${item.type}:${item.name} without install approval`);
    }
  }
}

export function validateCapabilityDiscovery(context, report, storyId = null) {
  const executionContext = storyId ? executionContextForStory(context, storyId) : null;
  const profiles = readCapabilityProfiles(context).filter((profile) => !storyId || profile.subject?.story_id === storyId);
  const profileIds = new Set(profiles.map((profile) => profile.id));
  const recommendations = readCapabilityRecommendations(context).filter((recommendation) => {
    if (!storyId) {
      return true;
    }
    return profileIds.has(recommendation.profile_id);
  });

  for (const profile of profiles) {
    const label = `capability profile ${profile.id || "unknown"}`;
    if (!profile.id || !profile.schema_version || !profile.status || !profile.subject) {
      report.errors.push(`${label} is missing id, schema_version, status, or subject`);
    }
    if (!Array.isArray(profile.detected_stack)) {
      report.errors.push(`${label} detected_stack must be an array`);
    }
    if (!Array.isArray(profile.evidence)) {
      report.errors.push(`${label} evidence must be an array`);
    }
    for (const sourcePath of profile.source_paths || []) {
      const resolved = resolveProjectFilePath(context, sourcePath, { mustExist: false });
      if (isDerivedArtifactPath(context, resolved)) {
        report.errors.push(`${label} uses derived source ${sourcePath}`);
      }
    }
    for (const issue of validateCapabilityRecordSourceHashes(context, profile, label, {
      collectOnly: true,
      executionContext,
      bindingKind: "capability_profile",
    })) {
      const severity = approvedRecordIssueSeverity(context, report, profile);
      report[severity].push(issue);
    }
    if (profile.status === "approved") {
      const approval = latestApprovedRecordApproval(profile);
      if (!approval || !hasFormalApprovalAttribution(approval.approved_by, approval.approval_source)) {
        report.errors.push(`${label} approval must be attributed to ${formalApprovalActorDescription(approval?.approval_source)}`);
      }
      validateFormalApprovalRecord(context, report, approval, `${label} approval ${approval?.id || "unknown"}`, approval?.approved_by);
      if (!isApprovedRecordFresh(profile)) {
        report[approvalIssueSeverity(context, report, approval)].push(`${label} approval is stale`);
      }
    }
    report.checked.push(label);
  }

  for (const recommendation of recommendations) {
    const label = `capability recommendation ${recommendation.id || "unknown"}`;
    if (!recommendation.id || !recommendation.schema_version || !recommendation.status || !recommendation.profile_id) {
      report.errors.push(`${label} is missing id, schema_version, status, or profile_id`);
    }
    if (!profileIds.has(recommendation.profile_id) && !fs.existsSync(capabilityProfilePath(context, recommendation.profile_id || "missing"))) {
      report.errors.push(`${label} references missing profile ${recommendation.profile_id || "unknown"}`);
    }
    if (!Array.isArray(recommendation.recommendations)) {
      report.errors.push(`${label} recommendations must be an array`);
    }
    for (const issue of validateCapabilityRecordSourceHashes(context, recommendation, label, {
      collectOnly: true,
      executionContext,
      bindingKind: "capability_recommendation",
    })) {
      const severity = approvedRecordIssueSeverity(context, report, recommendation);
      report[severity].push(issue);
    }
    if (recommendation.status === "approved") {
      const approval = latestApprovedRecordApproval(recommendation);
      if (!approval || !hasFormalApprovalAttribution(approval.approved_by, approval.approval_source)) {
        report.errors.push(`${label} approval must be attributed to ${formalApprovalActorDescription(approval?.approval_source)}`);
      }
      validateFormalApprovalRecord(context, report, approval, `${label} approval ${approval?.id || "unknown"}`, approval?.approved_by);
      if (!isApprovedRecordFresh(recommendation)) {
        report[approvalIssueSeverity(context, report, approval)].push(`${label} approval is stale`);
      }
      const profile = fs.existsSync(capabilityProfilePath(context, recommendation.profile_id))
        ? readProjectJson(context, capabilityProfilePath(context, recommendation.profile_id))
        : null;
      if (!profile || profile.status !== "approved") {
        report.errors.push(`${label} approved recommendation requires an approved fresh profile`);
      } else if (!isApprovedRecordFresh(profile)) {
        report[approvedRecordIssueSeverity(context, report, profile)].push(`${label} approved recommendation requires an approved fresh profile`);
      }
    }
    report.checked.push(label);
  }
}
