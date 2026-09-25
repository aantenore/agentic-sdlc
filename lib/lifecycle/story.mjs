import path from "node:path";
import {
  fail,
} from "../cli/user-error.mjs";
import {
  MutationGovernanceError,
} from "../governance/mutation-guard.mjs";
import {
  createOperationalRedactionPolicy,
} from "../observability/redaction.mjs";
import {
  authorizationArtifactTypes,
} from "./authorization.mjs";
import {
  getOptionString,
  hasActorAttribution,
  normalizeId,
  normalizeListOption,
  normalizeListValue,
  normalizeWorkItemType,
  shortHash,
  shortHashFull,
  stableJson,
} from "./common.mjs";
import {
  DEPENDENCY_BLOCK_SCOPES,
  DEPENDENCY_TYPES,
  LEGACY_STORY_STEP_PHASE_ALIASES,
  STORY_COMMAND_COMMON_OPTIONS,
  STORY_STATUSES,
  TRACE_OUTCOMES,
  WORK_ITEM_TYPES,
} from "./constants.mjs";
import {
  autonomyRoot,
  budgetMeterRoot,
  dependenciesRoot,
} from "./project.mjs";

export function storyLifecycleCertificationLockPath(context, storyId) {
  return path.join(
    context.sdlcRoot,
    "stories",
    normalizeId(storyId),
    "lifecycle-certification.lock",
  );
}

export function validateStoryLifecyclePolicy(policy = {}) {
  if (policy.terminal_statuses === undefined) {
    return;
  }
  if (!Array.isArray(policy.terminal_statuses) || policy.terminal_statuses.length === 0) {
    fail("story_lifecycle.terminal_statuses must be a non-empty array");
  }
  for (const status of policy.terminal_statuses) {
    if (!STORY_STATUSES.has(String(status || "").toLowerCase())) {
      fail(`story_lifecycle.terminal_statuses contains unknown story status '${status}'`);
    }
  }
}

export function validateClaimPolicy(policy = {}) {
  const ttlSeconds = policy.default_ttl_seconds;
  if (ttlSeconds !== undefined && ttlSeconds !== null && (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0)) {
    fail("claim_policy.default_ttl_seconds must be a positive integer or null");
  }
}

export function validateWorkBreakdownPolicy(policy) {
  if (policy === undefined) {
    return;
  }
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    fail("work_breakdown_policy must be a JSON object");
  }
  for (const field of ["levels", "claimable_units"]) {
    if (policy[field] !== undefined) {
      if (!Array.isArray(policy[field])) {
        fail(`work_breakdown_policy.${field} must be an array`);
      }
      for (const value of policy[field]) {
        const type = normalizeWorkItemType(value, { allowStory: true });
        if (!WORK_ITEM_TYPES.has(type)) {
          fail(`work_breakdown_policy.${field} contains unknown work item type '${value}'`);
        }
      }
    }
  }
  for (const field of ["delivery_unit", "strict_gate_unit"]) {
    if (policy[field] !== undefined) {
      normalizeWorkItemType(policy[field], { allowStory: true });
    }
  }
  if (policy.task_gate !== undefined && !["light", "strict", "none"].includes(String(policy.task_gate))) {
    fail("work_breakdown_policy.task_gate must be light, strict, or none");
  }
}

export function newestContract(contracts) {
  return [...contracts].sort((left, right) => String(right.updated_at || right.created_at || "").localeCompare(String(left.updated_at || left.created_at || "")))[0] || null;
}

export function contractNegotiationCommands(phase, storyId, contractId = null, options = {}) {
  const normalizedPhase = phase || "<phase>";
  const id = contractId || (storyId ? `contract-${storyId}-${normalizedPhase}` : `contract-${normalizedPhase}-<id>`);
  return [
    `agentic-sdlc contract create --phase ${normalizedPhase}${storyId ? ` --story ${storyId}` : ""} --id ${id} --context-summary <summary> --qa "<question>|<answer>"${options.force ? " --force" : ""}`,
    `agentic-sdlc approval requests${storyId ? ` --story ${storyId}` : ""}`,
  ];
}

export function requirementsRoot(context) {
  return path.join(context.sdlcRoot, "requirements");
}

export function requirementPath(context, id) {
  return path.join(requirementsRoot(context), `${normalizeId(id)}.json`);
}

export function requirementAutonomyRoot(context) {
  return path.join(autonomyRoot(context), "requirements");
}

export function requirementLifecycleRoot(context) {
  return path.join(requirementsRoot(context), "lifecycle");
}

export function requirementAutonomyPath(context, profileId) {
  return path.join(requirementAutonomyRoot(context), `${normalizeId(profileId)}.json`);
}

export function rejectLegacyRequirementWriteScope(requirementId, profileId, reason) {
  fail(
    `Requirement ${requirementId} has a non-canonical write scope in profile ${profileId}: ${reason}. `
    + "Approval was refused without rewriting either proposal. Create a new immutable requirement revision "
    + "and pass project-internal --write-path values; the CLI will store them as Git-relative paths.",
    {
      en: {
        result: "This requirement cannot be approved because its file boundary uses an older or invalid path format.",
        impact: "The requirement and its proposed working limits were left byte-for-byte unchanged.",
        required_decision: "Create a new immutable revision that names the intended project file areas.",
        protection_boundary: "No approval, implementation, delivery, external access, or wider file access was created.",
        next_action: `Revise ${requirementId}, supplying the project-internal file areas that may change, then approve the new revision.`,
        details: { requirement_id: requirementId, profile_id: profileId, reason },
      },
      it: {
        result: "Questo requisito non può essere approvato perché il limite dei file usa un formato di percorso precedente o non valido.",
        impact: "Il requisito e i limiti di lavoro proposti sono rimasti invariati byte per byte.",
        required_decision: "Crea una nuova revisione immutabile indicando le aree di file del progetto previste.",
        protection_boundary: "Non sono stati creati approvazioni, implementazioni, consegne, accessi esterni o accessi più ampi ai file.",
        next_action: `Revisiona ${requirementId}, indicando le aree interne al progetto che potranno cambiare, poi approva la nuova revisione.`,
        details: { requirement_id: requirementId, profile_id: profileId, reason },
      },
    },
  );
}

export function requirementMaterialScope(requirement, options = {}, canonicalWritePaths = null) {
  const environments = normalizeListOption(options.environment).length > 0
    ? normalizeListOption(options.environment)
    : ["local"];
  const capabilities = [...new Set([
    ...normalizeListOption(options.capability),
    ...normalizeListOption(options.tool),
  ])];
  return {
    objective: requirement.summary,
    scope: requirement.summary,
    non_goals: requirement.non_goals,
    acceptance_criteria: requirement.acceptance_criteria,
    nfrs: requirement.non_functional_requirements,
    integrations: requirement.integrations,
    environment: environments.sort(),
    write_paths: canonicalWritePaths || normalizeListOption(options["write-path"]).sort(),
    capabilities: capabilities.sort(),
    budget: null,
    release_target: null,
    requirement_constraints: requirement.constraints,
  };
}

export function budgetMeterBaselinePath(context, proposalId, adapterId, baselineId) {
  return path.join(budgetMeterRoot(context, proposalId, adapterId), "baselines", `${normalizeId(baselineId)}.json`);
}

export function buildBudgetMeterBaseline(context, proposal, budget, adapterId, baselineId, mapping, snapshot) {
  const body = {
    kind: "budget_meter_baseline",
    schema_version: "budget-meter-baseline:v1",
    id: baselineId,
    proposal_ref: { id: proposal.id, hash: proposal.proposal_hash },
    budget_ref: { id: budget.id, hash: budget.budget_hash },
    adapter: adapterId,
    metric_mapping: mapping,
    snapshot,
    created_at: snapshot.captured_at,
  };
  return { ...body, baseline_hash: shortHashFull(stableJson(body)), hash_algorithm: "sha256:stable-json:v1" };
}

export function validateBudgetMeterBaseline(baseline, proposal, budget, adapter, mapping) {
  const { baseline_hash: hash, hash_algorithm: algorithm, ...body } = baseline || {};
  if (algorithm !== "sha256:stable-json:v1" || hash !== shortHashFull(stableJson(body))) {
    fail("Budget meter baseline failed immutable content validation.");
  }
  if (baseline.proposal_ref?.id !== proposal.id || baseline.proposal_ref?.hash !== proposal.proposal_hash ||
      baseline.budget_ref?.id !== budget.id || baseline.budget_ref?.hash !== budget.budget_hash || baseline.adapter !== adapter.id) {
    fail("Budget meter baseline is not bound to the current proposal, effective budget, and adapter.");
  }
  if (stableJson(baseline.metric_mapping) !== stableJson(mapping)) {
    fail(`${adapter.label} metric mapping changed after baseline capture; create a new named baseline before recording usage.`);
  }
  const integrity = adapter.validateSnapshot(baseline.snapshot);
  if (!integrity.valid) {
    fail(`Budget meter baseline snapshot is invalid: ${integrity.errors.join("; ")}`);
  }
  return baseline;
}

export function contractArtifactTypes(contract = {}) {
  return authorizationArtifactTypes({
    artifact_types: (Array.isArray(contract.output_contract_refs) ? contract.output_contract_refs : [])
      .map((reference) => reference?.artifact_type),
  });
}

export function storyActionCheckpointSubjectId(storyId, action, settings = {}) {
  if (action === "story.complete-step" && settings.step) {
    return normalizeId(`${storyId}.step.${normalizeId(settings.step)}`);
  }
  return storyId;
}

export function isIntactBootstrapPhaseContract(context, contract) {
  const phase = String(contract?.phase || "");
  if (
    !phase
    || !context.config.phase_order.includes(phase)
    || contract.id !== `contract-${phase}-v1`
    || contract.story_id
  ) {
    return false;
  }
  const contextualization = contract.contextualization || {};
  return (
    contract.status === "draft"
    && (!Array.isArray(contract.approvals) || contract.approvals.length === 0)
    && (!Array.isArray(contract.output_contract_refs) || contract.output_contract_refs.length === 0)
    && (!Array.isArray(contract.capability_bindings) || contract.capability_bindings.length === 0)
    && (!Array.isArray(contract.capability_recommendation_refs) || contract.capability_recommendation_refs.length === 0)
    && (!Array.isArray(contract.requirement_refs) || contract.requirement_refs.length === 0)
    && (!Array.isArray(contract.requirement_execution_profile_refs) || contract.requirement_execution_profile_refs.length === 0)
    && !contract.delivery_execution_profile_id
    && !String(contextualization.summary || "").trim()
    && (!Array.isArray(contextualization.context_sources) || contextualization.context_sources.length === 0)
    && (!Array.isArray(contextualization.questions) || contextualization.questions.length === 0)
    && (!Array.isArray(contextualization.constraints) || contextualization.constraints.length === 0)
    && (!Array.isArray(contextualization.assumptions) || contextualization.assumptions.length === 0)
    && Number(contextualization.open_questions || 0) === 0
  );
}

export function contractExecutionContext(contract) {
  return contract?.story_id && contract?.id && contract?.delivery_execution_profile_id
    ? {
        storyId: contract.story_id,
        contractId: contract.id,
        profileId: contract.delivery_execution_profile_id,
      }
    : null;
}

export function buildTraceRequestMetadata(options = {}, attribution = null) {
  const request = {
    id: getOptionString(options, "request-id") || null,
    summary: getOptionString(options, "request-summary") || null,
    source: getOptionString(options, "request-source") || null,
    thread_id: getOptionString(options, "request-thread-id") || attribution?.run?.thread_id || null,
    run_id: getOptionString(options, "request-run-id") || attribution?.run?.run_id || null,
    session_id: getOptionString(options, "request-session-id") || attribution?.run?.session_id || null,
  };
  return Object.values(request).some((value) => value !== null && value !== "") ? request : null;
}

export function storyMutationLockPath(context, storyId) {
  return path.join(
    context.sdlcRoot,
    "contracts",
    `.story-${shortHash(normalizeId(storyId))}.lock`,
  );
}

export function assertStoryCommandOptions(options, command, allowed) {
  const permitted = new Set([...STORY_COMMAND_COMMON_OPTIONS, ...allowed]);
  const unsupported = Object.keys(options).filter((name) => !permitted.has(name)).sort();
  if (unsupported.length > 0) {
    fail(
      `${command} does not accept ${unsupported.map((name) => `--${name}`).join(", ")}. `
      + "Use the dedicated contract, workflow, breakdown, or lifecycle command for governed changes.",
    );
  }
}

export function workBreakdownRoot(context) {
  return path.join(context.sdlcRoot, "work-breakdown");
}

export function baselineRoot(context) {
  return path.join(context.sdlcRoot, "baseline");
}

export function baselinePathById(context, id) {
  return path.join(baselineRoot(context), `${normalizeId(id)}.json`);
}

export function breakdownPathById(context, id) {
  return path.join(workBreakdownRoot(context), `${id}.json`);
}

export function dependencyGraphPath(context) {
  return path.join(dependenciesRoot(context), "graph.json");
}

export function parseBreakdownItemRef(value) {
  const parts = String(value || "").split(":").map((part) => part.trim());
  if (parts.length !== 2 || parts.some((part) => !part)) {
    fail("Breakdown items must use --item type:id");
  }
  return {
    type: normalizeWorkItemType(parts[0], { allowStory: true }),
    id: normalizeId(parts[1]),
  };
}

export function parseDependencyEdge(value) {
  const parts = String(value || "").split(":").map((part) => part.trim());
  if (parts.length !== 5 || parts.some((part) => !part)) {
    fail("Dependency edges must use --edge from:to:type:blocks:required_state");
  }
  const [from, to, type, blocks, requiredState] = parts;
  const normalizedType = String(type).trim().toLowerCase();
  const normalizedBlocks = String(blocks).trim().toLowerCase();
  if (!DEPENDENCY_TYPES.has(normalizedType)) {
    fail(`Unknown dependency type '${type}'. Valid values: ${Array.from(DEPENDENCY_TYPES).join(", ")}`);
  }
  if (!DEPENDENCY_BLOCK_SCOPES.has(normalizedBlocks)) {
    fail(`Unknown dependency blocking scope '${blocks}'. Valid values: ${Array.from(DEPENDENCY_BLOCK_SCOPES).join(", ")}`);
  }
  return {
    from: normalizeId(from),
    to: normalizeId(to),
    type: normalizedType,
    blocks: normalizedBlocks,
    required_state: String(requiredState).trim().toLowerCase(),
  };
}

export function upsertDependencyEdge(graph, edge) {
  graph.edges = Array.isArray(graph.edges) ? graph.edges : [];
  const key = dependencyEdgeKey(edge);
  const index = graph.edges.findIndex((candidate) => dependencyEdgeKey(candidate) === key);
  if (index >= 0) {
    graph.edges[index] = edge;
  } else {
    graph.edges.push(edge);
  }
}

export function dependencyEdgeKey(edge) {
  return [edge.from, edge.to, edge.type, edge.blocks].join("::");
}

export function isHardDependencyEdge(edge) {
  return edge.blocks !== "none" && ["blocks", "requires_artifact", "requires_contract"].includes(edge.type);
}

export function phaseRank(value) {
  const order = ["discovery", "analysis", "design", "implementation", "validation", "release"];
  if (["in_progress", "review"].includes(value)) {
    return order.indexOf("implementation");
  }
  if (value === "done") {
    return order.indexOf("release");
  }
  const index = order.indexOf(value);
  return index >= 0 ? index : order.indexOf("design");
}

export function findBlockingDependencyCycles(edges) {
  const graph = new Map();
  for (const edge of edges.filter(isHardDependencyEdge)) {
    if (!graph.has(edge.from)) {
      graph.set(edge.from, []);
    }
    graph.get(edge.from).push(edge.to);
  }
  const cycles = [];
  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  function visit(node) {
    if (visiting.has(node)) {
      const start = stack.indexOf(node);
      cycles.push([...stack.slice(start), node]);
      return;
    }
    if (visited.has(node)) {
      return;
    }
    visiting.add(node);
    stack.push(node);
    for (const next of graph.get(node) || []) {
      visit(next);
    }
    stack.pop();
    visiting.delete(node);
    visited.add(node);
  }
  for (const node of graph.keys()) {
    visit(node);
  }
  return cycles;
}

export function assertManualTraceActionIsSafe(event) {
  const generatedBy = {
    "data.migrate": "autonomy delivery action",
    "data.rollback": "autonomy delivery action",
    "git.commit": "autonomy delivery action",
    "git.push": "autonomy delivery action",
    "pull_request.merge": "autonomy delivery action",
    "release.local": "autonomy delivery action",
    "sync.commit": "sync record",
    "sync.merge": "sync record",
    "sync.push": "sync record",
    "workflow.instance.start": "workflow instance start",
    "workflow.instance.transition": "workflow instance transition",
  };
  const command = generatedBy[event.action];
  if (!command) return;
  fail(
    `Protected action '${event.action}' cannot be appended manually because one incomplete event would permanently block strict gates. `
    + `Run '${command}' for the exact action instead; it records the verified receipt and trace automatically.`,
  );
}

export function resolveIncidentFeedbackPhase(context, options, story) {
  const phase = getOptionString(options, "phase") || story.phase || null;
  if (phase && !context.config.phases[phase]) {
    fail(`Unknown phase '${phase}'. Use one of: ${Object.keys(context.config.phases).join(", ")}`);
  }
  return phase;
}

export function inferStoryArtifactType(story) {
  const text = stableJson(story).toLowerCase();
  if (text.includes("functional-analysis") || text.includes("functional")) {
    return "functional-analysis";
  }
  if (text.includes("technical-analysis") || text.includes("technical")) {
    return "technical-analysis";
  }
  return null;
}

export function inferStoryIdFromTraceFile(filePath) {
  const base = path.basename(filePath, ".jsonl");
  return base === "project" ? null : base;
}

export function traceActorMatches(actor, filter) {
  if (!filter) {
    return true;
  }
  if (typeof actor === "string") {
    return actor === filter;
  }
  return [actor?.id, actor?.name, actor?.email, actor?.type].filter(Boolean).some((value) => String(value) === filter);
}

export function businessImpactForTrace(event) {
  const action = String(event.action || event.type || "");
  if (event.type === "decision" || action.includes("approve")) {
    return "decision";
  }
  if (event.type === "test" || action.includes("validation")) {
    return "validation";
  }
  if (event.type === "release") {
    return "release";
  }
  if (event.type === "risk") {
    return "risk";
  }
  if (event.type === "handoff") {
    return "handoff";
  }
  if (event.type === "implementation") {
    return "implementation";
  }
  return "activity";
}

export function traceActorKey(actor) {
  if (typeof actor === "string") {
    return actor || "unknown";
  }
  return actor?.id || actor?.name || actor?.type || "unknown";
}

export function buildStoryRequirementGraph(stories) {
  return stories.map((story) => ({
    story_id: story.id,
    requirements: Array.isArray(story.links?.requirements) ? story.links.requirements : [],
  }));
}

export function buildStoryDependencyGraph(stories) {
  const nodes = stories.map((story) => story.id);
  const storyIndexesByRequirement = new Map();
  for (let storyIndex = 0; storyIndex < stories.length; storyIndex += 1) {
    const requirements = new Set(stories[storyIndex].links?.requirements || []);
    for (const requirement of requirements) {
      const indexes = storyIndexesByRequirement.get(requirement) || [];
      indexes.push(storyIndex);
      storyIndexesByRequirement.set(requirement, indexes);
    }
  }

  // Build only pairs that actually share a requirement. The previous
  // implementation compared every story with every other story even when the
  // graph was sparse, which became the dominant cache-build cost at scale.
  const sharedByPair = new Map();
  for (const [requirement, indexes] of storyIndexesByRequirement) {
    for (let leftOffset = 0; leftOffset < indexes.length; leftOffset += 1) {
      for (let rightOffset = leftOffset + 1; rightOffset < indexes.length; rightOffset += 1) {
        const left = indexes[leftOffset];
        const right = indexes[rightOffset];
        const key = `${left}\u0000${right}`;
        const shared = sharedByPair.get(key) || new Set();
        shared.add(requirement);
        sharedByPair.set(key, shared);
      }
    }
  }

  const edges = [...sharedByPair.entries()]
    .map(([key, shared]) => {
      const [left, right] = key.split("\u0000").map(Number);
      const requirements = [];
      const emitted = new Set();
      for (const requirement of stories[left].links?.requirements || []) {
        if (shared.has(requirement) && !emitted.has(requirement)) {
          requirements.push(requirement);
          emitted.add(requirement);
        }
      }
      return {
        left,
        right,
        edge: {
          from: stories[left].id,
          to: stories[right].id,
          reason: "shared_requirements",
          requirements,
        },
      };
    })
    .sort((first, second) => first.left - second.left || first.right - second.right)
    .map(({ edge }) => edge);
  return { nodes, edges };
}

export function failTraceIntegrityWrite(error) {
  if (error instanceof MutationGovernanceError) throw error;
  const code = /^[a-z][a-z0-9_.-]{0,63}$/u.test(String(error?.code || ""))
    ? error.code
    : "trace_integrity_failed";
  fail(`Trace integrity blocked the write (${code}). Run the integrity check before retrying.`);
}

export function buildTraceRedactionPolicy(context) {
  return createTraceRedactionPolicy(context, createOperationalRedactionPolicy);
}

export function createTraceRedactionPolicy(context, factory) {
  const configured = context.config.observability?.redaction;
  const secretPatterns = normalizeTraceDetectorPatterns(configured?.secret_patterns, "secret_patterns", "configured_secret");
  const piiPatterns = normalizeTraceDetectorPatterns(configured?.pii_patterns, "pii_patterns", "configured_pii");
  const identifierAllowPatterns = normalizeTraceDetectorPatterns(
    configured?.identifier_allow_patterns,
    "identifier_allow_patterns",
    "configured_identifier",
  );
  const sensitiveKeys = configured?.sensitive_keys;
  if (sensitiveKeys !== undefined && (
    !Array.isArray(sensitiveKeys)
    || sensitiveKeys.some((value) => typeof value !== "string" || value.trim() === "")
  )) {
    fail("observability.redaction.sensitive_keys must be an array of non-empty strings");
  }
  try {
    return factory({
      secretPatterns,
      piiPatterns,
      identifierAllowPatterns,
      ...(sensitiveKeys === undefined ? {} : { sensitiveKeys }),
    });
  } catch {
    fail("The configured observability redaction policy is invalid.");
  }
}

export function normalizeTraceDetectorPatterns(value, fieldName, prefix) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(`observability.redaction.${fieldName} must be an array`);
  return value.map((entry, index) => {
    if (typeof entry === "string") return { name: `${prefix}_${index + 1}`, pattern: entry };
    if (entry && typeof entry === "object" && !Array.isArray(entry)) return entry;
    fail(`Observability redaction pattern ${prefix}_${index + 1} must be a string or object`);
  });
}

export function normalizeStoryRecord(story) {
  if (!story || typeof story !== "object") {
    return story;
  }
  const acceptanceCriteria = storyAcceptanceCriteria(story);
  return {
    ...story,
    acceptance: Array.isArray(story.acceptance) ? story.acceptance : acceptanceCriteria,
    acceptance_criteria: acceptanceCriteria,
  };
}

export function storyAcceptanceCriteria(story) {
  const canonical = Array.isArray(story?.acceptance_criteria) ? story.acceptance_criteria : [];
  if (canonical.length > 0) {
    return canonical;
  }
  return normalizeListValue(story?.acceptance, []);
}

export function configuredPhaseOrder(context) {
  return normalizeListValue(
    context?.config?.phase_order,
    Object.keys(context?.config?.phases || {}),
  );
}

export function configuredStorySteps(context) {
  const configuredPhases = configuredPhaseOrder(context);
  const configuredPhaseSet = new Set(configuredPhases);
  return [
    ...configuredPhases,
    ...Array.from(LEGACY_STORY_STEP_PHASE_ALIASES.entries())
      .filter(([, phase]) => configuredPhaseSet.has(phase))
      .map(([alias]) => alias),
  ];
}

export function normalizeStoryStep(context, value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
  const validSteps = new Set(configuredStorySteps(context));
  if (!validSteps.has(normalized)) {
    fail(`Unknown story step '${value}'. Valid values: ${Array.from(validSteps).join(", ")}`);
  }
  return normalized;
}

export function storyStepPhase(context, step) {
  const aliasPhase = LEGACY_STORY_STEP_PHASE_ALIASES.get(step);
  return aliasPhase && configuredPhaseOrder(context).includes(aliasPhase)
    ? aliasPhase
    : step;
}

export function defaultNextStoryStep(context, step) {
  const configuredOrder = configuredPhaseOrder(context);
  const configuredIndex = configuredOrder.indexOf(step);
  if (configuredIndex >= 0) {
    return configuredIndex < configuredOrder.length - 1
      ? configuredOrder[configuredIndex + 1]
      : null;
  }
  if (
    step === "functional-analysis"
    && LEGACY_STORY_STEP_PHASE_ALIASES.get(step)
    && configuredOrder.includes("analysis")
  ) {
    return "technical-analysis";
  }
  if (
    step === "technical-analysis"
    && LEGACY_STORY_STEP_PHASE_ALIASES.get(step)
    && configuredOrder.includes("analysis")
  ) {
    const aliasPhaseIndex = configuredOrder.indexOf("analysis");
    return aliasPhaseIndex >= 0 && aliasPhaseIndex < configuredOrder.length - 1
      ? configuredOrder[aliasPhaseIndex + 1]
      : null;
  }
  return null;
}

export function effectiveStoryLifecyclePolicy(context) {
  return {
    ...(context.templateConfig?.story_lifecycle || {}),
    ...(context.config?.story_lifecycle || {}),
  };
}

export function storyRecordLifecycleProjection(rawStatus, rawPhase, rawTerminal, workflowInstanceId = null) {
  return {
    status: rawStatus,
    phase: rawPhase,
    terminal: rawTerminal,
    blocked: false,
    source: "story_record",
    workflow_instance_id: workflowInstanceId,
  };
}

export function effectiveClaimPolicy(context) {
  return {
    ...(context.templateConfig?.claim_policy || {}),
    ...(context.config?.claim_policy || {}),
  };
}

export function defaultClaimExpiration(context, claimedAt) {
  const ttlSeconds = effectiveClaimPolicy(context).default_ttl_seconds;
  const claimedAtMs = Date.parse(String(claimedAt || ""));
  if (ttlSeconds === null || ttlSeconds === undefined || !Number.isFinite(claimedAtMs)) {
    return null;
  }
  return new Date(claimedAtMs + ttlSeconds * 1_000).toISOString();
}

export function effectiveClaimExpiration(context, claim) {
  return claim?.expires_at || defaultClaimExpiration(context, claim?.claimed_at);
}

export function traceIntegrityCheckpointPath(tracePath) {
  return path.join(
    path.dirname(tracePath),
    ".integrity",
    `${path.basename(tracePath)}.checkpoint.json`,
  );
}

export function hasTraceActor(event) {
  return hasActorAttribution(event.actor);
}

export function storyBranchPatterns(context, storyId) {
  const configured = context.config.parallel_work?.branch_patterns;
  const patterns = Array.isArray(configured) && configured.length > 0
    ? configured
    : [context.config.parallel_work?.branch_pattern || "codex/<story-id>"];
  return Array.from(new Set(patterns.map((pattern) => String(pattern).replaceAll("<story-id>", storyId))));
}

export function defaultStoryBranch(context, storyId) {
  return storyBranchPatterns(context, storyId)[0];
}

export function latestTraceEvent(events, type) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === type) {
      return events[index];
    }
  }
  return null;
}

export function normalizeTraceOutcome(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!TRACE_OUTCOMES.has(normalized)) {
    fail(`Unknown trace outcome '${value}'. Valid values: ${Array.from(TRACE_OUTCOMES).join(", ")}`);
  }
  return normalized;
}
