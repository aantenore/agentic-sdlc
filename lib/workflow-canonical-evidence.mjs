import {
  DomainValidationError,
  STABLE_JSON_HASH_ALGORITHM,
  computeStableHash,
  immutableJson,
  isPlainRecord,
  requireNonEmptyString,
  requirePlainRecord,
} from "./canonical.mjs";

export const WORKFLOW_LEGACY_CANONICAL_EVIDENCE_SCHEMA = "workflow-canonical-evidence:v1";
export const WORKFLOW_CANONICAL_EVIDENCE_SCHEMA = "workflow-canonical-evidence:v2";
export const WORKFLOW_LEGACY_STRICT_GATE_RECEIPT_SCHEMA = "workflow-strict-gate-receipt:v1";
export const WORKFLOW_STRICT_GATE_RECEIPT_SCHEMA = "workflow-strict-gate-receipt:v2";
export const WORKFLOW_LEGACY_FINAL_GATE_RECEIPT_SCHEMA = "workflow-final-gate-receipt:v1";
export const WORKFLOW_FINAL_GATE_RECEIPT_SCHEMA = "workflow-final-gate-receipt:v3";
export const WORKFLOW_FINAL_FRESHNESS_PROOF_SCHEMA = "workflow-final-freshness-proof:v2";

export const CANONICAL_WORKFLOW_GUARD_CHECKS = Object.freeze({
  "requirement-approved": "requirement_approved",
  "contract-approved": "contract_approved",
  "required-output-linked": "required_output_linked",
  "strict-gate-passed": "strict_gate_passed",
  "delivery-terminal": "delivery_terminal",
});

const SUCCESSFUL_DELIVERY_TERMINAL_STATUSES = new Set(["merged", "released"]);
const SHA256 = /^[a-f0-9]{64}$/u;

function validWorkflowFinalFreshnessProof(proof, storyId, instanceId) {
  if (
    !isPlainRecord(proof)
    || proof.schema_version !== WORKFLOW_FINAL_FRESHNESS_PROOF_SCHEMA
    || proof.story_id !== storyId
    || proof.workflow_instance_id !== instanceId
    || !Array.isArray(proof.governed_files)
    || !Array.isArray(proof.local_release_scope)
    || !("local_release_root" in proof)
    || !isPlainRecord(proof.output_registry_projection)
    || !isPlainRecord(proof.git_scope)
    || proof.hash_algorithm !== STABLE_JSON_HASH_ALGORITHM
    || !SHA256.test(String(proof.proof_hash || ""))
  ) {
    return false;
  }
  const { proof_hash: proofHash, ...subject } = proof;
  return proofHash === computeStableHash(subject);
}

export function selectRequiredOutputRefsForPhase(rawRefs, rawScope = null) {
  if (!Array.isArray(rawRefs)) {
    throw new DomainValidationError("output contract refs must be an array");
  }
  const refs = rawRefs.map((ref, index) => ({ ref, index }));
  if (rawScope === null || rawScope === undefined) {
    return immutableJson({
      valid: true,
      issues: [],
      scope_phase: null,
      require_all: true,
      total_required_count: refs.length,
      required_refs: refs,
      deferred_refs: [],
    });
  }
  requirePlainRecord(rawScope, "output_phase_scope");
  const phaseOrder = Array.isArray(rawScope.phase_order)
    ? rawScope.phase_order.map((phase) => String(phase || "").trim())
    : [];
  const currentPhase = String(rawScope.current_phase || "").trim();
  if (
    rawScope.require_all === true
    && (rawScope.current_phase === null || rawScope.current_phase === undefined)
    && phaseOrder.length === 0
  ) {
    return immutableJson({
      valid: true,
      issues: [],
      scope_phase: null,
      require_all: true,
      total_required_count: refs.length,
      required_refs: refs,
      deferred_refs: [],
    });
  }
  const issues = [];
  if (rawScope.require_all !== undefined && typeof rawScope.require_all !== "boolean") {
    issues.push("output phase scope require_all must be a boolean");
  }
  if (
    phaseOrder.length === 0
    || phaseOrder.some((phase) => !phase)
    || new Set(phaseOrder).size !== phaseOrder.length
  ) {
    issues.push("output phase scope has no valid unique phase order");
  }
  const cutoff = phaseOrder.indexOf(currentPhase);
  if (!currentPhase || cutoff < 0) {
    issues.push(`output phase scope '${currentPhase || "unknown"}' is not in the governed phase order`);
  }
  if (rawScope.require_all === true) {
    return immutableJson({
      valid: issues.length === 0,
      issues,
      scope_phase: currentPhase || null,
      require_all: true,
      total_required_count: refs.length,
      required_refs: refs,
      deferred_refs: [],
    });
  }
  if (issues.length > 0) {
    return immutableJson({
      valid: false,
      issues,
      scope_phase: currentPhase || null,
      require_all: false,
      total_required_count: refs.length,
      required_refs: refs,
      deferred_refs: [],
    });
  }

  const requiredRefs = [];
  const deferredRefs = [];
  for (const item of refs) {
    const phase = item.ref?.phase;
    if (phase === undefined || phase === null || String(phase).trim() === "") {
      // Legacy refs are intentionally all-due so old contracts never become
      // more permissive merely because a workflow phase scope is available.
      requiredRefs.push(item);
      continue;
    }
    const normalizedPhase = String(phase).trim();
    const phaseIndex = phaseOrder.indexOf(normalizedPhase);
    if (phaseIndex < 0) {
      issues.push(
        `output ref ${item.ref?.artifact_type || item.index + 1} has unknown phase '${normalizedPhase}'`,
      );
      requiredRefs.push(item);
      continue;
    }
    if (phaseIndex <= cutoff) {
      requiredRefs.push(item);
    } else {
      deferredRefs.push(item);
    }
  }
  return immutableJson({
    valid: issues.length === 0,
    issues,
    scope_phase: currentPhase,
    require_all: false,
    total_required_count: refs.length,
    required_refs: requiredRefs,
    deferred_refs: deferredRefs,
  });
}

export function buildWorkflowFinalGateReceipt(report, options = {}) {
  requirePlainRecord(report, "workflow_final_gate_report");
  if (
    report.status !== "passed"
    || report.strict !== true
    || report.scope !== "story"
    || report.lifecycle_complete !== true
    || report.certification_level !== "lifecycle_complete"
    || !isPlainRecord(report.lifecycle_workflow)
    || report.lifecycle_workflow.story_id !== report.story_id
    || !validWorkflowFinalFreshnessProof(
      report.freshness_proof,
      report.story_id,
      report.lifecycle_workflow.instance_id,
    )
    || !isPlainRecord(report.lifecycle_workflow.checkpoint_ref)
    || !isPlainRecord(report.lifecycle_workflow.terminal_event_ref)
    || !validLifecycleWorkflowProof(
      report.lifecycle_workflow,
      report.story_id,
      report.checked_at,
    )
    || !Array.isArray(report.errors)
    || report.errors.length > 0
  ) {
    throw new DomainValidationError(
      "A final workflow gate receipt requires one passing lifecycle-complete strict story gate with no blocking errors",
    );
  }
  const storyId = requireNonEmptyString(report.story_id, "workflow_final_gate_report.story_id");
  const finalReceiptPath = requireNonEmptyString(
    options.final_receipt_path,
    "workflow_final_gate_report.final_receipt_path",
  );
  if (finalReceiptPath !== `.sdlc/gates/${storyId}-final.json`) {
    throw new DomainValidationError(
      "A final workflow gate receipt path must bind the exact governed story",
    );
  }
  const receipt = {
    ...report,
    kind: "workflow_final_gate_receipt",
    schema_version: WORKFLOW_FINAL_GATE_RECEIPT_SCHEMA,
    story_id: storyId,
    final_receipt_path: finalReceiptPath,
    hash_algorithm: STABLE_JSON_HASH_ALGORITHM,
  };
  return immutableJson({
    ...receipt,
    receipt_hash: computeReceiptHash(receipt),
  });
}

export function buildWorkflowStrictGateReceipt(report, options = {}) {
  requirePlainRecord(report, "workflow_strict_gate_report");
  if (
    report.status !== "passed"
    || report.strict !== true
    || report.scope !== "story"
    || report.lifecycle_complete !== false
    || report.certification_level !== "strict_intermediate"
    || !Array.isArray(report.errors)
    || report.errors.length > 0
  ) {
    throw new DomainValidationError(
      "An intermediate workflow gate receipt requires one passing non-final strict story gate with no blocking errors",
    );
  }
  const storyId = requireNonEmptyString(report.story_id, "workflow_strict_gate_report.story_id");
  const workflowScope = normalizeWorkflowScope(
    report.workflow_scope,
    "workflow_strict_gate_report.workflow_scope",
    {
      require_durable_checkpoint: true,
      require_phase_order: true,
    },
  );
  if (workflowScope.story_id !== storyId) {
    throw new DomainValidationError(
      "An intermediate workflow gate receipt scope must bind the exact governed story",
    );
  }
  const checkedAt = requireIsoInstant(
    report.checked_at,
    "workflow_strict_gate_report.checked_at",
  );
  if (checkedAt < workflowScope.checkpoint_ref.updated_at) {
    throw new DomainValidationError(
      "An intermediate workflow gate receipt cannot predate its bound workflow checkpoint",
    );
  }
  const strictReceiptPath = requireNonEmptyString(
    options.strict_receipt_path,
    "workflow_strict_gate_report.strict_receipt_path",
  );
  if (strictReceiptPath !== `.sdlc/gates/${storyId}-strict.json`) {
    throw new DomainValidationError(
      "An intermediate workflow gate receipt path must bind the exact governed story",
    );
  }
  const receipt = {
    ...report,
    checked_at: checkedAt,
    workflow_scope: workflowScope,
    kind: "workflow_strict_gate_receipt",
    schema_version: WORKFLOW_STRICT_GATE_RECEIPT_SCHEMA,
    story_id: storyId,
    strict_receipt_path: strictReceiptPath,
    hash_algorithm: STABLE_JSON_HASH_ALGORITHM,
  };
  return immutableJson({
    ...receipt,
    receipt_hash: computeReceiptHash(receipt),
  });
}

/**
 * Build one integrity-sealed snapshot from records already loaded through the
 * host's governed project reader. This function deliberately performs no file
 * access: callers retain responsibility for path and symlink safety.
 */
export function buildWorkflowCanonicalEvidence(input) {
  return buildWorkflowCanonicalEvidenceForSchema(
    input,
    WORKFLOW_CANONICAL_EVIDENCE_SCHEMA,
  );
}

/**
 * Compatibility-only builder for workflow definitions already pinned to the
 * historical v1 evidence contract. New definitions must pin and use v2.
 */
export function buildLegacyWorkflowCanonicalEvidence(input) {
  return buildWorkflowCanonicalEvidenceForSchema(
    input,
    WORKFLOW_LEGACY_CANONICAL_EVIDENCE_SCHEMA,
  );
}

function buildWorkflowCanonicalEvidenceForSchema(input, schemaVersion) {
  requirePlainRecord(input, "workflow_canonical_evidence_input");
  const instance = requirePlainRecord(input.instance, "workflow_canonical_evidence_input.instance");
  const instanceId = requireNonEmptyString(instance.id, "workflow_canonical_evidence_input.instance.id");
  const binding = canonicalBinding(instance);
  const story = optionalRecord(input.story, "workflow_canonical_evidence_input.story");
  const requirements = normalizeRecordList(input.requirements, "workflow_canonical_evidence_input.requirements");
  const contract = optionalRecord(input.contract, "workflow_canonical_evidence_input.contract");
  const outputRegistry = optionalRecord(input.output_registry, "workflow_canonical_evidence_input.output_registry");
  const legacy = schemaVersion === WORKFLOW_LEGACY_CANONICAL_EVIDENCE_SCHEMA;
  const outputScope = legacy
    ? null
    : normalizeCanonicalOutputScope(input.output_scope, {
        allow_legacy_absent: false,
      });
  const workflowScope = legacy
    ? null
    : normalizeWorkflowScope(
        input.workflow_scope,
        "workflow_canonical_evidence_input.workflow_scope",
        { require_phase_order: true },
      );
  const gateReport = optionalRecord(input.gate_report, "workflow_canonical_evidence_input.gate_report");
  const deliveryProfile = optionalRecord(input.delivery_profile, "workflow_canonical_evidence_input.delivery_profile");
  const deliveryCloseReceipt = optionalRecord(
    input.delivery_close_receipt,
    "workflow_canonical_evidence_input.delivery_close_receipt",
  );

  const storyCheck = storyBindingCheck(story, binding.story_id);
  const requirementCheck = requirementApprovalCheck(story, requirements, storyCheck.satisfied);
  const contractCheck = contractApprovalCheck(story, contract, binding.story_id, storyCheck.satisfied);
  const outputCheck = requiredOutputLinkCheck(
    contract,
    outputRegistry,
    binding.story_id,
    contractCheck.satisfied,
    outputScope,
  );
  const deliveryCheck = deliveryTerminalCheck(
    story,
    contract,
    deliveryProfile,
    deliveryCloseReceipt,
    binding.story_id,
    contractCheck.satisfied,
  );
  const observedAt = normalizeObservedAt(input.observed_at);
  if (
    workflowScope
    && observedAt < workflowScope.checkpoint_ref.updated_at
  ) {
    throw new DomainValidationError(
      "Workflow canonical evidence cannot predate its bound workflow checkpoint",
    );
  }
  const gateCheck = legacy
    ? legacyStrictGateCheck(
        gateReport,
        binding.story_id,
        outputCheck,
        deliveryCheck,
      )
    : strictGateCheck(
        gateReport,
        binding.story_id,
        outputCheck,
        deliveryCheck,
        outputScope,
        workflowScope,
        observedAt,
      );
  const evidence = {
    kind: "workflow_canonical_evidence",
    schema_version: schemaVersion,
    instance_id: instanceId,
    story_id: binding.story_id,
    observed_at: observedAt,
    ...(!legacy
      ? {
          output_scope: outputScope,
          workflow_scope: workflowScope,
        }
      : {}),
    checks: {
      requirement_approved: requirementCheck,
      contract_approved: contractCheck,
      required_output_linked: outputCheck,
      strict_gate_passed: gateCheck,
      delivery_terminal: deliveryCheck,
    },
    hash_algorithm: STABLE_JSON_HASH_ALGORITHM,
  };
  return immutableJson({
    ...evidence,
    evidence_hash: computeWorkflowCanonicalEvidenceHash(evidence),
  });
}

export function computeWorkflowCanonicalEvidenceHash(evidence) {
  requirePlainRecord(evidence, "workflow_canonical_evidence");
  const {
    evidence_hash: ignoredEvidenceHash,
    hash_algorithm: ignoredHashAlgorithm,
    ...subject
  } = evidence;
  return computeStableHash(subject);
}

export function validateWorkflowCanonicalEvidence(evidence, options = {}) {
  const errors = [];
  if (!isPlainRecord(evidence)) {
    return immutableJson({
      valid: false,
      errors: ["workflow canonical evidence must be a plain object"],
      expected_hash: null,
      actual_hash: null,
    });
  }
  if (evidence.kind !== "workflow_canonical_evidence") {
    errors.push("workflow canonical evidence kind is invalid");
  }
  const expectedSchema = options.expected_schema_version
    ?? WORKFLOW_CANONICAL_EVIDENCE_SCHEMA;
  const supportedSchemas = new Set([
    WORKFLOW_LEGACY_CANONICAL_EVIDENCE_SCHEMA,
    WORKFLOW_CANONICAL_EVIDENCE_SCHEMA,
  ]);
  if (!supportedSchemas.has(expectedSchema)) {
    errors.push(`unsupported expected workflow canonical evidence schema '${expectedSchema}'`);
  }
  const isCurrentSchema =
    evidence.schema_version === WORKFLOW_CANONICAL_EVIDENCE_SCHEMA
    && expectedSchema === WORKFLOW_CANONICAL_EVIDENCE_SCHEMA;
  const isLegacySchema =
    evidence.schema_version === WORKFLOW_LEGACY_CANONICAL_EVIDENCE_SCHEMA
    && expectedSchema === WORKFLOW_LEGACY_CANONICAL_EVIDENCE_SCHEMA;
  if (!isCurrentSchema && !isLegacySchema) {
    errors.push(`workflow canonical evidence schema must be '${expectedSchema}'`);
  }
  if (typeof evidence.instance_id !== "string" || evidence.instance_id.trim() === "") {
    errors.push("workflow canonical evidence instance_id is required");
  }
  if (typeof evidence.story_id !== "string" || evidence.story_id.trim() === "") {
    errors.push("workflow canonical evidence story_id is required");
  }
  if (options.instance_id !== undefined && evidence.instance_id !== options.instance_id) {
    errors.push("workflow canonical evidence belongs to a different workflow instance");
  }
  if (options.story_id !== undefined && evidence.story_id !== options.story_id) {
    errors.push("workflow canonical evidence belongs to a different story");
  }
  const observedAt = validInstant(evidence.observed_at);
  if (!observedAt) {
    errors.push("workflow canonical evidence observed_at must be an ISO instant");
  }
  let eventTimestamp = null;
  if (options.event_timestamp !== undefined) {
    eventTimestamp = validInstant(options.event_timestamp);
    if (!eventTimestamp) {
      errors.push("workflow canonical evidence expected event_timestamp must be an ISO instant");
    } else if (observedAt && observedAt > eventTimestamp) {
      errors.push("workflow canonical evidence observation postdates its transition event");
    }
  }
  let outputScope = null;
  let workflowScope = null;
  if (isLegacySchema) {
    if (Object.hasOwn(evidence, "output_scope") || Object.hasOwn(evidence, "workflow_scope")) {
      errors.push(
        "legacy workflow canonical evidence v1 must not contain v2 phase or workflow scopes",
      );
    }
  } else if (isCurrentSchema) {
    try {
      outputScope = normalizeCanonicalOutputScope(evidence.output_scope, {
        allow_legacy_absent: false,
      });
    } catch (error) {
      errors.push(...domainErrorMessages("workflow canonical evidence output_scope is invalid", error));
    }
    try {
      workflowScope = normalizeWorkflowScope(
        evidence.workflow_scope,
        "workflow_canonical_evidence.workflow_scope",
        { require_phase_order: true },
      );
    } catch (error) {
      errors.push(...domainErrorMessages("workflow canonical evidence workflow_scope is invalid", error));
    }
  }
  if (outputScope) {
    if (
      options.current_phase !== undefined
      && outputScope.current_phase !== options.current_phase
    ) {
      errors.push(
        `workflow canonical evidence output_scope current_phase must be '${options.current_phase}'`,
      );
    }
    if (
      options.phase_order !== undefined
      && !sameStringList(outputScope.phase_order, options.phase_order)
    ) {
      errors.push("workflow canonical evidence output_scope phase_order does not match the effective workflow");
    }
  }
  if (workflowScope) {
    if (workflowScope.instance_id !== evidence.instance_id) {
      errors.push("workflow canonical evidence workflow_scope belongs to a different workflow instance");
    }
    if (workflowScope.story_id !== evidence.story_id) {
      errors.push("workflow canonical evidence workflow_scope belongs to a different story");
    }
    if (observedAt && observedAt < workflowScope.checkpoint_ref.updated_at) {
      errors.push("workflow canonical evidence predates its bound workflow checkpoint");
    }
    if (
      outputScope
      && (
        workflowScope.current_phase !== outputScope.current_phase
        || !sameStringList(workflowScope.phase_order, outputScope.phase_order)
      )
    ) {
      errors.push("workflow canonical evidence workflow_scope does not match its output_scope");
    }
    if (options.workflow_scope !== undefined) {
      try {
        const expectedWorkflowScope = normalizeWorkflowScope(
          options.workflow_scope,
          "expected_workflow_scope",
        );
        if (computeStableHash(workflowScope) !== computeStableHash(expectedWorkflowScope)) {
          errors.push("workflow canonical evidence workflow_scope does not match the active workflow stream");
        }
      } catch (error) {
        errors.push(...domainErrorMessages("expected workflow scope is invalid", error));
      }
    }
  }
  if (!isPlainRecord(evidence.checks)) {
    errors.push("workflow canonical evidence checks must be an object");
  } else {
    for (const checkId of Object.values(CANONICAL_WORKFLOW_GUARD_CHECKS)) {
      const check = evidence.checks[checkId];
      if (!isPlainRecord(check) || typeof check.satisfied !== "boolean") {
        errors.push(`workflow canonical evidence check '${checkId}' must include a boolean satisfied result`);
      }
    }
  }
  if (evidence.hash_algorithm !== STABLE_JSON_HASH_ALGORITHM) {
    errors.push(`workflow canonical evidence hash_algorithm must be '${STABLE_JSON_HASH_ALGORITHM}'`);
  }
  let expectedHash = null;
  try {
    expectedHash = computeWorkflowCanonicalEvidenceHash(evidence);
  } catch (error) {
    errors.push(`workflow canonical evidence cannot be hashed: ${error.message}`);
  }
  if (!SHA256.test(String(evidence.evidence_hash || ""))) {
    errors.push("workflow canonical evidence evidence_hash is invalid");
  } else if (expectedHash !== evidence.evidence_hash) {
    errors.push("workflow canonical evidence evidence_hash does not match its content");
  }
  return immutableJson({
    valid: errors.length === 0,
    errors,
    expected_hash: expectedHash,
    actual_hash: typeof evidence.evidence_hash === "string" ? evidence.evidence_hash : null,
  });
}

export function canonicalWorkflowGuardResult(guardId, evidence) {
  const checkId = CANONICAL_WORKFLOW_GUARD_CHECKS[guardId];
  if (!checkId) throw new DomainValidationError(`Unknown canonical workflow guard '${guardId}'`);
  if (!evidence) {
    const issues = [
      `${humanCheckName(checkId)} must be established from canonical project records`,
    ];
    return Object.freeze({
      allowed: false,
      reason: issues[0],
      issues: Object.freeze(issues),
    });
  }
  const integrity = validateWorkflowCanonicalEvidence(evidence, {
    expected_schema_version: evidence?.schema_version,
  });
  if (!integrity.valid) {
    const issues = integrity.errors.map((issue) => String(issue));
    return Object.freeze({
      allowed: false,
      reason: `${humanCheckName(checkId)} cannot be trusted because the canonical evidence snapshot is invalid`,
      issues: Object.freeze(issues),
    });
  }
  const check = evidence.checks[checkId];
  const issues = check.satisfied === true
    ? []
    : Array.isArray(check.issues) && check.issues.length > 0
      ? check.issues.map((issue) => String(issue))
      : [`${humanCheckName(checkId)} is not established by canonical project records`];
  return Object.freeze({
    allowed: check.satisfied === true,
    reason: check.satisfied === true
      ? `${humanCheckName(checkId)} is established by canonical project records`
      : issues[0],
    issues: Object.freeze(issues),
  });
}

export function computeGovernedApprovalSubjectHash(record) {
  requirePlainRecord(record, "governed_record");
  return computeStableHash(stripApprovalVolatileFields(record));
}

function canonicalBinding(instance) {
  const binding = instance.metadata?.governance_binding;
  requirePlainRecord(binding, "workflow_instance.metadata.governance_binding");
  return {
    story_id: requireNonEmptyString(
      binding.story_id,
      "workflow_instance.metadata.governance_binding.story_id",
    ),
  };
}

function storyBindingCheck(story, storyId) {
  const issues = [];
  if (!story) issues.push(`story ${storyId} is missing`);
  else if (story.id !== storyId) issues.push(`story ${storyId} does not match the workflow binding`);
  return checkResult(issues, {
    story_ref: story?.id === storyId ? { id: story.id, hash: computeGovernedApprovalSubjectHash(story) } : null,
  });
}

function requirementApprovalCheck(story, requirements, storySatisfied) {
  const issues = [];
  const refs = Array.isArray(story?.requirement_refs) ? story.requirement_refs : [];
  if (!storySatisfied) issues.push("the bound story is unavailable or inconsistent");
  if (refs.length === 0) issues.push("the bound story has no requirement references");
  const records = new Map(requirements.map((record) => [record.id, record]));
  const verifiedRefs = [];
  for (const ref of refs) {
    const id = typeof ref?.id === "string" ? ref.id : null;
    if (!id) {
      issues.push("a story requirement reference has no id");
      continue;
    }
    const requirement = records.get(id);
    if (!requirement) {
      issues.push(`requirement ${id} is missing`);
      continue;
    }
    const approval = freshApprovedRecord(requirement);
    if (!approval.fresh) issues.push(`requirement ${id} is not currently approved with fresh content`);
    if (ref.revision !== undefined && requirement.revision !== ref.revision) {
      issues.push(`requirement ${id} revision no longer matches the story`);
    }
    if (ref.content_hash !== approval.content_hash) {
      issues.push(`requirement ${id} content no longer matches the story`);
    }
    verifiedRefs.push({
      id,
      revision: requirement.revision ?? null,
      content_hash: approval.content_hash,
      approval_id: approval.approval?.id ?? null,
    });
  }
  return checkResult(issues, { requirement_refs: verifiedRefs });
}

function contractApprovalCheck(story, contract, storyId, storySatisfied) {
  const issues = [];
  if (!storySatisfied) issues.push("the bound story is unavailable or inconsistent");
  const expectedId = typeof story?.contract_id === "string" && story.contract_id.trim()
    ? story.contract_id
    : null;
  if (!expectedId) issues.push(`story ${storyId} has no contract binding`);
  if (!contract) issues.push(`contract ${expectedId || "for the bound story"} is missing`);
  if (contract && expectedId && contract.id !== expectedId) {
    issues.push(`contract ${contract.id || "unknown"} does not match story contract ${expectedId}`);
  }
  if (contract && contract.story_id !== storyId) {
    issues.push(`contract ${contract.id || "unknown"} belongs to a different story`);
  }
  const approval = contract ? freshApprovedRecord(contract) : { fresh: false, content_hash: null, approval: null };
  if (contract && !approval.fresh) {
    issues.push(`contract ${contract.id || "unknown"} is not currently approved with fresh content`);
  }
  return checkResult(issues, {
    contract_ref: contract
      ? {
          id: contract.id ?? null,
          content_hash: approval.content_hash,
          approval_id: approval.approval?.id ?? null,
        }
      : null,
  });
}

function requiredOutputLinkCheck(contract, registry, storyId, contractSatisfied, outputScope = null) {
  const issues = [];
  if (!contractSatisfied) issues.push("the approved contract is unavailable or inconsistent");
  const allRefs = Array.isArray(contract?.output_contract_refs) ? contract.output_contract_refs : [];
  const selection = selectRequiredOutputRefsForPhase(allRefs, outputScope);
  issues.push(...selection.issues);
  const refs = selection.required_refs.map((item) => item.ref);
  if (allRefs.length === 0) issues.push("the approved contract declares no required outputs");
  const links = Array.isArray(registry?.links) ? registry.links : [];
  const matched = [];
  for (const ref of refs) {
    const matches = links.filter((link) =>
      link?.story_id === storyId
      && link?.artifact_type === ref?.artifact_type
      && link?.template_id === ref?.template_id
      && link?.mode === ref?.mode);
    if (matches.length !== 1) {
      issues.push(
        matches.length === 0
          ? `required output ${ref?.artifact_type || "unknown"} is not linked`
          : `required output ${ref?.artifact_type || "unknown"} has ambiguous canonical links`,
      );
      continue;
    }
    const link = matches[0];
    const verification = link.verification_receipt;
    if (
      verification?.passed !== true
      || verification?.status !== "passed"
      || verification?.subject_ref?.id !== link.id
    ) {
      issues.push(`required output ${ref?.artifact_type || "unknown"} has no passing bound verification`);
    }
    if (verification && !hasValidWorkflowReceiptHash(verification)) {
      issues.push(`required output ${ref?.artifact_type || "unknown"} verification failed integrity validation`);
    }
    if (
      verification
      && (
        link.verification_receipt_ref?.id !== verification.id
        || link.verification_receipt_ref?.hash !== verification.receipt_hash
      )
    ) {
      issues.push(`required output ${ref?.artifact_type || "unknown"} verification reference is stale`);
    }
    matched.push({
      id: link.id,
      artifact_type: link.artifact_type,
      template_id: link.template_id,
      mode: link.mode,
      artifact_hash: link.fingerprints?.artifact_sha256 ?? null,
      verification_receipt_id: verification?.id ?? null,
      updated_at: link.updated_at ?? link.created_at ?? null,
    });
  }
  return checkResult(issues, {
    scope_phase: selection.scope_phase,
    require_all: selection.require_all,
    total_required_count: selection.total_required_count,
    required_count: refs.length,
    deferred_count: selection.deferred_refs.length,
    deferred_refs: selection.deferred_refs.map(({ ref }) => ({
      artifact_type: ref?.artifact_type ?? null,
      template_id: ref?.template_id ?? null,
      mode: ref?.mode ?? null,
      phase: ref?.phase ?? null,
    })),
    linked_count: matched.length,
    link_refs: matched,
  });
}

function strictGateCheck(
  gate,
  storyId,
  outputCheck,
  deliveryCheck,
  outputScope,
  workflowScope,
  observedAt,
) {
  const issues = [];
  if (outputCheck?.satisfied !== true) {
    const outputIssues = Array.isArray(outputCheck?.issues)
      ? outputCheck.issues.map((issue) => String(issue))
      : [];
    issues.push(
      ...(outputIssues.length > 0
        ? outputIssues
        : ["required outputs due for the current workflow phase are not satisfied"]),
    );
  }
  if (!gate) issues.push(`strict gate result for story ${storyId} is missing`);
  const intermediate = gate?.kind === "workflow_strict_gate_receipt"
    && gate?.schema_version === WORKFLOW_STRICT_GATE_RECEIPT_SCHEMA;
  const legacyIntermediate = gate?.kind === "workflow_strict_gate_receipt"
    && gate?.schema_version === WORKFLOW_LEGACY_STRICT_GATE_RECEIPT_SCHEMA;
  const legacyFinal = gate?.kind === "workflow_final_gate_receipt"
    && [
      WORKFLOW_LEGACY_FINAL_GATE_RECEIPT_SCHEMA,
      WORKFLOW_FINAL_GATE_RECEIPT_SCHEMA,
    ].includes(gate?.schema_version);
  if (gate && !intermediate && !legacyIntermediate && !legacyFinal) {
    issues.push("strict gate result is not a governed intermediate or final gate receipt");
  }
  if (legacyIntermediate) {
    issues.push("legacy intermediate strict gate receipt is not bound to the active workflow phase");
  }
  if (legacyFinal) {
    issues.push("final gate receipt cannot replace a fresh phase-bound intermediate strict gate receipt");
  }
  if (
    intermediate
    && (
      gate.lifecycle_complete !== false
      || gate.certification_level !== "strict_intermediate"
      || gate.strict_receipt_path !== `.sdlc/gates/${storyId}-strict.json`
    )
  ) {
    issues.push("intermediate strict gate receipt does not bind the exact non-final story gate");
  }
  if (intermediate) {
    let receiptScope = null;
    try {
      receiptScope = normalizeWorkflowScope(
        gate.workflow_scope,
        "workflow_strict_gate_receipt.workflow_scope",
        {
          require_durable_checkpoint: true,
          require_phase_order: true,
        },
      );
    } catch (error) {
      issues.push(...domainErrorMessages("intermediate strict gate workflow_scope is invalid", error));
    }
    if (!workflowScope) {
      issues.push("canonical evidence has no active workflow scope for the intermediate strict gate");
    } else if (
      receiptScope
      && computeStableHash(receiptScope) !== computeStableHash(workflowScope)
    ) {
      issues.push("intermediate strict gate receipt belongs to a different workflow stream position");
    }
    if (
      receiptScope
      && (
        receiptScope.current_phase !== outputScope.current_phase
        || !sameStringList(receiptScope.phase_order, outputScope.phase_order)
      )
    ) {
      issues.push("intermediate strict gate receipt does not match the canonical output phase scope");
    }
  }
  if (
    gate?.schema_version === WORKFLOW_FINAL_GATE_RECEIPT_SCHEMA
    && (
      gate.lifecycle_complete !== true
      || gate.certification_level !== "lifecycle_complete"
      || gate.final_receipt_path !== `.sdlc/gates/${storyId}-final.json`
      || !validLifecycleWorkflowProof(gate.lifecycle_workflow, storyId, gate.checked_at)
    )
  ) {
    issues.push("final v3 gate receipt lacks a complete terminal workflow proof");
  }
  if (gate && !hasValidWorkflowReceiptHash(gate)) {
    issues.push("strict gate receipt failed integrity validation");
  }
  if (gate && gate.story_id !== storyId) issues.push("strict gate result belongs to a different story");
  if (gate && gate.scope !== "story") issues.push("strict gate result is not story-scoped");
  if (gate && gate.strict !== true) issues.push("gate result was not produced in strict mode");
  if (gate && gate.status !== "passed") issues.push("strict gate did not pass");
  if (gate && Array.isArray(gate.errors) && gate.errors.length > 0) {
    issues.push("strict gate contains blocking errors");
  }
  const checkedAt = validInstant(gate?.checked_at);
  if (gate && !checkedAt) issues.push("strict gate has no valid checked_at timestamp");
  if (
    intermediate
    && checkedAt
    && workflowScope
    && checkedAt < workflowScope.checkpoint_ref.updated_at
  ) {
    issues.push("strict gate result predates the active workflow checkpoint");
  }
  if (intermediate && checkedAt && observedAt && checkedAt > observedAt) {
    issues.push("strict gate result postdates the canonical evidence observation");
  }
  const latestDependency = latestInstant([
    ...((outputCheck.link_refs || []).map((ref) => ref.updated_at)),
    deliveryCheck.closed_at,
  ]);
  if (checkedAt && latestDependency && checkedAt < latestDependency) {
    issues.push("strict gate result predates required output or delivery evidence");
  }
  return checkResult(issues, {
    checked_at: checkedAt,
    status: gate?.status ?? null,
    receipt_kind: gate?.kind ?? null,
    receipt_schema: gate?.schema_version ?? null,
    receipt_path: gate?.strict_receipt_path ?? gate?.final_receipt_path ?? null,
    receipt_hash: gate?.receipt_hash ?? null,
  });
}

function legacyStrictGateCheck(gate, storyId, outputCheck, deliveryCheck) {
  const issues = [];
  if (!gate) issues.push(`strict gate result for story ${storyId} is missing`);
  const intermediate = gate?.kind === "workflow_strict_gate_receipt"
    && gate?.schema_version === WORKFLOW_LEGACY_STRICT_GATE_RECEIPT_SCHEMA;
  const final = gate?.kind === "workflow_final_gate_receipt"
    && [
      WORKFLOW_LEGACY_FINAL_GATE_RECEIPT_SCHEMA,
      WORKFLOW_FINAL_GATE_RECEIPT_SCHEMA,
    ].includes(gate?.schema_version);
  if (gate && !intermediate && !final) {
    issues.push(
      "legacy workflow evidence requires a v1 intermediate or governed final gate receipt",
    );
  }
  if (
    intermediate
    && (
      gate.lifecycle_complete !== false
      || gate.certification_level !== "strict_intermediate"
      || gate.strict_receipt_path !== `.sdlc/gates/${storyId}-strict.json`
    )
  ) {
    issues.push("legacy intermediate strict gate receipt does not bind the exact non-final story gate");
  }
  if (
    gate?.schema_version === WORKFLOW_FINAL_GATE_RECEIPT_SCHEMA
    && (
      gate.lifecycle_complete !== true
      || gate.certification_level !== "lifecycle_complete"
      || gate.final_receipt_path !== `.sdlc/gates/${storyId}-final.json`
      || !validLifecycleWorkflowProof(gate.lifecycle_workflow, storyId, gate.checked_at)
    )
  ) {
    issues.push("final v3 gate receipt lacks a complete terminal workflow proof");
  }
  if (gate && !hasValidWorkflowReceiptHash(gate)) {
    issues.push("strict gate receipt failed integrity validation");
  }
  if (gate && gate.story_id !== storyId) issues.push("strict gate result belongs to a different story");
  if (gate && gate.scope !== "story") issues.push("strict gate result is not story-scoped");
  if (gate && gate.strict !== true) issues.push("gate result was not produced in strict mode");
  if (gate && gate.status !== "passed") issues.push("strict gate did not pass");
  if (gate && Array.isArray(gate.errors) && gate.errors.length > 0) {
    issues.push("strict gate contains blocking errors");
  }
  const checkedAt = validInstant(gate?.checked_at);
  if (gate && !checkedAt) issues.push("strict gate has no valid checked_at timestamp");
  const latestDependency = latestInstant([
    ...((outputCheck.link_refs || []).map((ref) => ref.updated_at)),
    deliveryCheck.closed_at,
  ]);
  if (checkedAt && latestDependency && checkedAt < latestDependency) {
    issues.push("strict gate result predates required output or delivery evidence");
  }
  return checkResult(issues, {
    checked_at: checkedAt,
    status: gate?.status ?? null,
    receipt_kind: gate?.kind ?? null,
    receipt_schema: gate?.schema_version ?? null,
    receipt_path: gate?.strict_receipt_path ?? gate?.final_receipt_path ?? null,
    receipt_hash: gate?.receipt_hash ?? null,
  });
}

function validLifecycleWorkflowProof(proof, storyId, checkedAt) {
  if (!isPlainRecord(proof)) return false;
  const checkpoint = proof.checkpoint_ref;
  const terminalEvent = proof.terminal_event_ref;
  const taskStart = proof.task_start_ref;
  const phaseTimeline = proof.phase_timeline;
  const expectedKeys = [
    "checkpoint_ref",
    "delivery_closed_at",
    "effective_hash",
    "event_count",
    "instance_hash",
    "instance_id",
    "phase_timeline",
    "release_trace_at",
    "selection_policy",
    "story_id",
    "task_start_ref",
    "terminal_event_ref",
    "terminal_state",
  ];
  const checkpointKeys = [
    "checkpoint_hash",
    "last_event_hash",
    "path",
    "sequence",
    "trace_chain_hash",
  ];
  const terminalEventKeys = ["event_hash", "sequence", "timestamp"];
  const taskStartKeys = ["confirmed_at", "hash", "id", "path"];
  const phaseKeys = [
    "completed_at",
    "completion_record_id",
    "entered_at",
    "entry_event_hash",
    "phase",
  ];
  if (
    !isPlainRecord(checkpoint)
    || !isPlainRecord(terminalEvent)
    || !isPlainRecord(taskStart)
    || !Array.isArray(phaseTimeline)
    || phaseTimeline.length === 0
    || phaseTimeline.some((phase) =>
      !isPlainRecord(phase)
      || Object.keys(phase).sort().join("\n") !== phaseKeys.join("\n"))
    || Object.keys(proof).sort().join("\n") !== expectedKeys.join("\n")
    || Object.keys(checkpoint).sort().join("\n") !== checkpointKeys.join("\n")
    || Object.keys(terminalEvent).sort().join("\n") !== terminalEventKeys.join("\n")
    || Object.keys(taskStart).sort().join("\n") !== taskStartKeys.join("\n")
  ) {
    return false;
  }
  const instanceId = String(proof.instance_id || "");
  const terminalAt = Date.parse(String(terminalEvent.timestamp || ""));
  const gateAt = Date.parse(String(checkedAt || ""));
  const taskStartedAt = Date.parse(String(taskStart.confirmed_at || ""));
  const releaseTraceAt = Date.parse(String(proof.release_trace_at || ""));
  const deliveryClosedAt = Date.parse(String(proof.delivery_closed_at || ""));
  const timelineValid = phaseTimeline.every((phase, index) => {
    const enteredAt = Date.parse(String(phase.entered_at || ""));
    const completedAt = Date.parse(String(phase.completed_at || ""));
    const previousCompletedAt = index > 0
      ? Date.parse(String(phaseTimeline[index - 1].completed_at || ""))
      : null;
    return (
      String(phase.phase || "").length > 0
      && String(phase.completion_record_id || "").length > 0
      && Number.isFinite(enteredAt)
      && Number.isFinite(completedAt)
      && enteredAt <= completedAt
      && (
        index === 0
          ? phase.entry_event_hash === null
          : SHA256.test(String(phase.entry_event_hash || ""))
      )
      && (index === 0 || enteredAt >= previousCompletedAt)
    );
  });
  const firstPhase = phaseTimeline[0];
  const finalPhase = phaseTimeline.at(-1);
  // Release evidence (the release trace, the terminal delivery close) must be
  // produced during or after the release phase specifically. Comparing
  // against `terminalAt` assumed release was always the terminal phase; a
  // phase configured after release (such as operations) makes that comparison
  // wrong, since operations is entered only after release evidence exists.
  const releasePhaseEntry = phaseTimeline.find((phase) => phase.phase === "release") || null;
  const releasePhaseEnteredAt = releasePhaseEntry
    ? Date.parse(String(releasePhaseEntry.entered_at || ""))
    : terminalAt;
  const firstTransitionAt = phaseTimeline.length > 1
    ? Date.parse(String(phaseTimeline[1].entered_at || ""))
    : Number.NaN;
  const earliestPhaseCompletionAt = Math.min(
    ...phaseTimeline.map((phase) => Date.parse(String(phase.completed_at || ""))),
  );
  return (
    proof.selection_policy === "latest-created-at-then-instance-id:v1"
    && proof.story_id === storyId
    && instanceId.length > 0
    && SHA256.test(String(proof.instance_hash || ""))
    && SHA256.test(String(proof.effective_hash || ""))
    && checkpoint.path === `.sdlc/workflows/instances/${instanceId}/checkpoint.json`
    && SHA256.test(String(checkpoint.checkpoint_hash || ""))
    && Number.isInteger(checkpoint.sequence)
    && checkpoint.sequence >= 1
    && SHA256.test(String(checkpoint.last_event_hash || ""))
    && SHA256.test(String(checkpoint.trace_chain_hash || ""))
    && String(proof.terminal_state || "").length > 0
    && SHA256.test(String(terminalEvent.event_hash || ""))
    && terminalEvent.event_hash === checkpoint.last_event_hash
    && terminalEvent.sequence === checkpoint.sequence
    && Number.isInteger(proof.event_count)
    && proof.event_count === checkpoint.sequence
    && String(taskStart.id || "").length > 0
    && taskStart.path === `.sdlc/stories/${storyId}/task-start.json`
    && SHA256.test(String(taskStart.hash || ""))
    && Number.isFinite(taskStartedAt)
    && timelineValid
    && taskStartedAt >= Date.parse(String(firstPhase.entered_at || ""))
    && Number.isFinite(firstTransitionAt)
    && taskStartedAt <= firstTransitionAt
    && Number.isFinite(earliestPhaseCompletionAt)
    && taskStartedAt <= earliestPhaseCompletionAt
    && terminalEvent.event_hash === finalPhase.entry_event_hash
    && terminalAt === Date.parse(String(finalPhase.entered_at || ""))
    && Number.isFinite(releaseTraceAt)
    && Number.isFinite(deliveryClosedAt)
    && releaseTraceAt >= releasePhaseEnteredAt
    && deliveryClosedAt >= releasePhaseEnteredAt
    && Number.isFinite(terminalAt)
    && Number.isFinite(gateAt)
    && gateAt >= Math.max(terminalAt, releaseTraceAt, deliveryClosedAt)
  );
}

function deliveryTerminalCheck(story, contract, profile, close, storyId, contractSatisfied) {
  const issues = [];
  if (!contractSatisfied) issues.push("the approved contract is unavailable or inconsistent");
  const expectedProfileId = contract?.delivery_execution_profile_id || null;
  if (!expectedProfileId) issues.push("the approved contract has no exact delivery profile");
  if (!profile) issues.push(`delivery profile ${expectedProfileId || "for the bound story"} is missing`);
  if (profile && profile.id !== expectedProfileId) {
    issues.push(`delivery profile ${profile.id || "unknown"} does not match the approved contract`);
  }
  const storyRefs = Array.isArray(profile?.story_refs) ? profile.story_refs : [];
  const storyRef = storyRefs.find((ref) => ref?.id === storyId);
  const currentStoryHash = story ? computeGovernedApprovalSubjectHash(story) : null;
  if (profile && (!storyRef || storyRef.hash !== currentStoryHash)) {
    issues.push("delivery profile does not bind the current story content");
  }
  const contractRefs = Array.isArray(profile?.contract_refs) ? profile.contract_refs : [];
  const contractRef = contractRefs.find((ref) => ref?.id === contract?.id);
  const currentContractHash = contract ? computeGovernedApprovalSubjectHash(contract) : null;
  if (profile && (!contractRef || contractRef.hash !== currentContractHash)) {
    issues.push("delivery profile does not bind the current approved contract content");
  }
  if (!close) issues.push(`delivery ${profile?.delivery_id || "for the bound story"} has no terminal receipt`);
  if (close && close.profile_ref?.id !== profile?.id) {
    issues.push("delivery terminal receipt belongs to a different profile");
  }
  if (close && close.profile_ref?.hash !== profile?.profile_hash) {
    issues.push("delivery terminal receipt does not bind the current delivery profile");
  }
  if (
    close
    && (
      close.delivery?.id !== profile?.delivery_id
      || close.delivery?.kind !== profile?.delivery_kind
    )
  ) {
    issues.push("delivery terminal receipt belongs to a different delivery");
  }
  if (close && !SUCCESSFUL_DELIVERY_TERMINAL_STATUSES.has(close.terminal_status)) {
    issues.push(`delivery terminal outcome '${close.terminal_status || "unknown"}' is not successful`);
  }
  if (close && !hasValidWorkflowReceiptHash(close)) {
    issues.push("delivery terminal receipt failed integrity validation");
  }
  const closedAt = validInstant(close?.closed_at);
  if (close && !closedAt) issues.push("delivery terminal receipt has no valid closed_at timestamp");
  return checkResult(issues, {
    profile_id: profile?.id ?? null,
    delivery_id: profile?.delivery_id ?? null,
    delivery_kind: profile?.delivery_kind ?? null,
    close_receipt_id: close?.id ?? null,
    terminal_status: close?.terminal_status ?? null,
    closed_at: closedAt,
  });
}

function freshApprovedRecord(record) {
  const approvals = Array.isArray(record?.approvals) ? [...record.approvals] : [];
  const latest = approvals
    .sort((left, right) => String(left?.created_at || "").localeCompare(String(right?.created_at || "")))
    .at(-1) ?? null;
  const contentHash = computeGovernedApprovalSubjectHash(record);
  return {
    fresh: record.status === "approved"
      && latest?.status === "approved"
      && latest?.approved_content_hash === contentHash,
    content_hash: contentHash,
    approval: latest,
  };
}

export function hasValidWorkflowReceiptHash(receipt) {
  if (!SHA256.test(String(receipt?.receipt_hash || ""))) return false;
  return receipt.hash_algorithm === STABLE_JSON_HASH_ALGORITHM
    && computeReceiptHash(receipt) === receipt.receipt_hash;
}

function computeReceiptHash(receipt) {
  const {
    receipt_hash: ignoredReceiptHash,
    hash_algorithm: ignoredHashAlgorithm,
    ...subject
  } = receipt;
  return computeStableHash(subject);
}

function stripApprovalVolatileFields(value, depth = 0) {
  if (Array.isArray(value)) return value.map((item) => stripApprovalVolatileFields(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  const volatile = depth === 0
    ? new Set([
        "__path",
        "__relative_path",
        "approvals",
        "audit",
        "created_at",
        "updated_at",
        "approved_at",
        "approved_by",
        "status",
      ])
    : new Set();
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => !volatile.has(key))
      .map((key) => [key, stripApprovalVolatileFields(value[key], depth + 1)]),
  );
}

function checkResult(issues, details = {}) {
  return {
    satisfied: issues.length === 0,
    issues,
    ...details,
  };
}

function optionalRecord(value, label) {
  if (value === undefined || value === null) return null;
  return requirePlainRecord(value, label);
}

function normalizeRecordList(value, label) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new DomainValidationError(`${label} must be an array`);
  return value.map((record, index) => requirePlainRecord(record, `${label}[${index}]`));
}

function normalizeCanonicalOutputScope(value, options = {}) {
  if (value === undefined || value === null) {
    if (options.allow_legacy_absent === false) {
      throw new DomainValidationError("workflow canonical evidence output_scope is required");
    }
    // Historical callers had no phase scope. Keep their output requirement
    // selection fail-closed by treating every declared output as immediately due.
    return {
      current_phase: null,
      phase_order: [],
      require_all: true,
    };
  }
  requirePlainRecord(value, "workflow_canonical_evidence.output_scope");
  assertOnlyKeys(
    value,
    ["current_phase", "phase_order", "require_all"],
    "workflow_canonical_evidence.output_scope",
  );
  if (typeof value.require_all !== "boolean") {
    throw new DomainValidationError(
      "workflow_canonical_evidence.output_scope.require_all must be a boolean",
    );
  }
  if (!Array.isArray(value.phase_order)) {
    throw new DomainValidationError(
      "workflow_canonical_evidence.output_scope.phase_order must be an array",
    );
  }
  const phaseOrder = value.phase_order.map((phase, index) =>
    requireNonEmptyString(
      phase,
      `workflow_canonical_evidence.output_scope.phase_order[${index}]`,
    ));
  if (new Set(phaseOrder).size !== phaseOrder.length) {
    throw new DomainValidationError(
      "workflow_canonical_evidence.output_scope.phase_order must contain unique phases",
    );
  }
  const currentPhase = value.current_phase === null
    ? null
    : requireNonEmptyString(
        value.current_phase,
        "workflow_canonical_evidence.output_scope.current_phase",
      );
  if (currentPhase === null) {
    if (value.require_all !== true || phaseOrder.length !== 0) {
      throw new DomainValidationError(
        "A legacy all-due output scope must have null current_phase and an empty phase_order",
      );
    }
  } else if (phaseOrder.length > 0 && !phaseOrder.includes(currentPhase)) {
    throw new DomainValidationError(
      `workflow_canonical_evidence.output_scope current_phase '${currentPhase}' is not in phase_order`,
    );
  } else if (phaseOrder.length === 0 && value.require_all !== true) {
    throw new DomainValidationError(
      "An output scope without a governed phase_order must require all outputs",
    );
  }
  return {
    current_phase: currentPhase,
    phase_order: phaseOrder,
    require_all: value.require_all,
  };
}

function normalizeWorkflowScope(value, label, options = {}) {
  requirePlainRecord(value, label);
  assertOnlyKeys(
    value,
    [
      "instance_id",
      "instance_hash",
      "effective_hash",
      "story_id",
      "current_phase",
      "phase_order",
      "checkpoint_ref",
    ],
    label,
  );
  if (!Array.isArray(value.phase_order)) {
    throw new DomainValidationError(`${label}.phase_order must be an array`);
  }
  const phaseOrder = value.phase_order.map((phase, index) =>
    requireNonEmptyString(phase, `${label}.phase_order[${index}]`));
  if (options.require_phase_order === true && phaseOrder.length === 0) {
    throw new DomainValidationError(`${label}.phase_order must contain at least one phase`);
  }
  if (new Set(phaseOrder).size !== phaseOrder.length) {
    throw new DomainValidationError(`${label}.phase_order must contain unique phases`);
  }
  const currentPhase = requireNonEmptyString(value.current_phase, `${label}.current_phase`);
  if (phaseOrder.length > 0 && !phaseOrder.includes(currentPhase)) {
    throw new DomainValidationError(
      `${label}.current_phase '${currentPhase}' is not in phase_order`,
    );
  }
  const checkpoint = requirePlainRecord(value.checkpoint_ref, `${label}.checkpoint_ref`);
  assertOnlyKeys(
    checkpoint,
    [
      "checkpoint_hash",
      "sequence",
      "last_event_hash",
      "trace_chain_hash",
      "updated_at",
    ],
    `${label}.checkpoint_ref`,
  );
  if (!Number.isSafeInteger(checkpoint.sequence) || checkpoint.sequence < 0) {
    throw new DomainValidationError(`${label}.checkpoint_ref.sequence must be a non-negative integer`);
  }
  const checkpointHash = normalizeOptionalHash(
    checkpoint.checkpoint_hash,
    `${label}.checkpoint_ref.checkpoint_hash`,
  );
  const lastEventHash = normalizeOptionalHash(
    checkpoint.last_event_hash,
    `${label}.checkpoint_ref.last_event_hash`,
  );
  const traceChainHash = normalizeOptionalHash(
    checkpoint.trace_chain_hash,
    `${label}.checkpoint_ref.trace_chain_hash`,
  );
  if (checkpoint.sequence === 0 && lastEventHash !== null) {
    throw new DomainValidationError(
      `${label}.checkpoint_ref.last_event_hash must be null at sequence 0`,
    );
  }
  if (checkpoint.sequence > 0 && lastEventHash === null) {
    throw new DomainValidationError(
      `${label}.checkpoint_ref.last_event_hash is required after the first event`,
    );
  }
  if ((checkpointHash === null) !== (traceChainHash === null)) {
    throw new DomainValidationError(
      `${label}.checkpoint_ref checkpoint_hash and trace_chain_hash must be present together`,
    );
  }
  if (options.require_durable_checkpoint === true && checkpointHash === null) {
    throw new DomainValidationError(
      `${label}.checkpoint_ref must bind a durable workflow checkpoint`,
    );
  }
  const normalized = {
    instance_id: requireNonEmptyString(value.instance_id, `${label}.instance_id`),
    instance_hash: requireHash(value.instance_hash, `${label}.instance_hash`),
    effective_hash: requireHash(value.effective_hash, `${label}.effective_hash`),
    story_id: requireNonEmptyString(value.story_id, `${label}.story_id`),
    current_phase: currentPhase,
    phase_order: phaseOrder,
    checkpoint_ref: {
      checkpoint_hash: checkpointHash,
      sequence: checkpoint.sequence,
      last_event_hash: lastEventHash,
      trace_chain_hash: traceChainHash,
      updated_at: requireIsoInstant(
        checkpoint.updated_at,
        `${label}.checkpoint_ref.updated_at`,
      ),
    },
  };
  if (checkpointHash !== null) {
    const expectedCheckpointHash = computeStableHash({
      kind: "workflow_checkpoint",
      schema_version: "workflow-checkpoint:v1",
      instance_id: normalized.instance_id,
      instance_hash: normalized.instance_hash,
      effective_hash: normalized.effective_hash,
      sequence: normalized.checkpoint_ref.sequence,
      last_event_hash: normalized.checkpoint_ref.last_event_hash,
      current_state: normalized.current_phase,
      updated_at: normalized.checkpoint_ref.updated_at,
      trace_chain_hash: normalized.checkpoint_ref.trace_chain_hash,
    });
    if (checkpointHash !== expectedCheckpointHash) {
      throw new DomainValidationError(
        `${label}.checkpoint_ref.checkpoint_hash does not match its bound workflow stream position`,
      );
    }
  }
  return normalized;
}

function normalizeOptionalHash(value, label) {
  if (value === undefined || value === null) return null;
  return requireHash(value, label);
}

function requireHash(value, label) {
  const normalized = requireNonEmptyString(value, label);
  if (!SHA256.test(normalized)) {
    throw new DomainValidationError(`${label} must be a lowercase SHA-256 digest`);
  }
  return normalized;
}

function requireIsoInstant(value, label) {
  const parsed = validInstant(value);
  if (!parsed) throw new DomainValidationError(`${label} must be an ISO instant`);
  return parsed;
}

function sameStringList(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function assertOnlyKeys(value, allowed, label) {
  const accepted = new Set(allowed);
  const extras = Object.keys(value).filter((key) => !accepted.has(key));
  if (extras.length > 0) {
    throw new DomainValidationError(
      `${label} contains unsupported fields: ${extras.join(", ")}`,
    );
  }
}

function domainErrorMessages(prefix, error) {
  if (error instanceof DomainValidationError) {
    return [
      `${prefix}: ${error.message}`,
      ...error.issues.map((issue) =>
        typeof issue === "string" ? issue : JSON.stringify(issue)),
    ];
  }
  return [`${prefix}: ${error?.message ?? String(error)}`];
}

function normalizeObservedAt(value) {
  const normalized = value ?? new Date().toISOString();
  const parsed = validInstant(normalized);
  if (!parsed) throw new DomainValidationError("workflow_canonical_evidence_input.observed_at must be an ISO instant");
  return parsed;
}

function validInstant(value) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function latestInstant(values) {
  return values
    .map(validInstant)
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;
}

function humanCheckName(checkId) {
  return {
    requirement_approved: "The approved requirement",
    contract_approved: "The approved work contract",
    required_output_linked: "The required canonical output",
    strict_gate_passed: "The strict story gate",
    delivery_terminal: "The exact delivery terminal receipt",
  }[checkId] ?? checkId;
}
