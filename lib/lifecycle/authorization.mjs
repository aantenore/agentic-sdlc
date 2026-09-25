import path from "node:path";
import {
  computeAuthorizationSubjectHash,
  validateAuthorizationUsageReceipt as validateCanonicalAuthorizationUsageReceipt,
} from "../authorization-receipts.mjs";
import {
  computeStableHash,
} from "../canonical.mjs";
import {
  fail,
} from "../cli/user-error.mjs";
import {
  buildContextOptimizationLineageDelta,
} from "../context-optimization.mjs";
import {
  sameFileIdentityValues,
} from "../file-identity.mjs";
import {
  MutationGovernanceError,
  assertMutationExecutionAuthorized,
  withGovernedMutation,
} from "../governance/mutation-guard.mjs";
import {
  assertSafeSdlcRelativeDirectory,
  canonicalAbsoluteUrl,
  getOptionString,
  localTargetBuildCompletionDetails,
  normalizeAuthorizedActions,
  normalizeId,
  normalizeListOption,
  normalizeListValue,
  shortHashFull,
  stableJson,
} from "./common.mjs";
import {
  APPROVAL_SOURCES,
} from "./constants.mjs";
import {
  deliveryActionReceiptRef,
  formatDeliveryFormatOption,
  normalizeDeliveryFormatOptions,
  normalizeGitRepositoryIdentity,
} from "./delivery.mjs";
import {
  humanGuidanceLocale,
} from "./guidance.mjs";
import {
  verificationDimensionStatus,
} from "./output.mjs";
import {
  autonomyRoot,
  configuredSdlcDirectory,
  dependenciesRoot,
  toProjectPath,
} from "./project.mjs";
import {
  normalizeRoutePhase,
} from "./route.mjs";
import {
  assessmentWorkflowDirectory,
} from "./workflow.mjs";

export function profileTaskStartReceiptSchemaName(receipt) {
  return receipt?.schema_version === "profile-task-start-receipt:v1"
    ? "profile-task-start-receipt-v1.schema.json"
    : "profile-task-start-receipt.schema.json";
}

export function validateApprovalPolicy(policy) {
  if (policy === undefined) {
    return;
  }
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    fail("approval_policy must be an object");
  }
  if (policy.accepted_sources !== undefined) {
    if (!Array.isArray(policy.accepted_sources)) {
      fail("approval_policy.accepted_sources must be an array");
    }
    for (const source of policy.accepted_sources) {
      if (!APPROVAL_SOURCES.has(String(source))) {
        fail(`approval_policy.accepted_sources contains invalid source '${source}'`);
      }
    }
  }
  if (
    policy.legacy_approval_behavior !== undefined &&
    !["warn", "error"].includes(String(policy.legacy_approval_behavior))
  ) {
    fail("approval_policy.legacy_approval_behavior must be 'warn' or 'error'");
  }
}

export function projectBootstrapInitialIdentityHash(projectId, projectName) {
  return computeStableHash({
    project_id: String(projectId),
    project_name: String(projectName),
  });
}

export function baselineProposalIntent(baseline) {
  const {
    audit: _audit,
    created_at: _createdAt,
    updated_at: _updatedAt,
    proposal_intent_hash: _proposalIntentHash,
    proposal_intent_hash_algorithm: _proposalIntentHashAlgorithm,
    ...intent
  } = baseline || {};
  const repositorySnapshot = intent.repository_snapshot || {};
  const repositoryGit = repositorySnapshot.git || {};
  return {
    ...intent,
    repository_snapshot: {
      ...repositorySnapshot,
      git: {
        is_git_repo: repositoryGit.is_git_repo ?? false,
        branch: repositoryGit.branch ?? null,
        head_sha: repositoryGit.head_sha ?? null,
        remotes: Array.isArray(repositoryGit.remotes) ? repositoryGit.remotes : [],
      },
    },
  };
}

export function baselineProposalIntentHash(baseline) {
  return computeStableHash(baselineProposalIntent(baseline));
}

export function failBaselineProposalResume(id, reason) {
  fail(
    `Baseline ${id} cannot be resumed safely: ${reason}. No files were changed. `
    + "Keep the existing proposal and use a new --id, or review it and explicitly decide whether to replace it with --force; replacement is never implicit.",
  );
}

export function assertBaselineProposalCanResume(existing, candidate) {
  const id = candidate.id;
  if (
    existing.id !== id
    || existing.status !== "proposed"
    || !Array.isArray(existing.approvals)
    || existing.approvals.length !== 0
  ) {
    failBaselineProposalResume(id, "the existing record has a different identity or has already progressed");
  }
  if (
    existing.proposal_intent_hash_algorithm !== "sha256:stable-json:v1"
    || !/^[a-f0-9]{64}$/u.test(String(existing.proposal_intent_hash || ""))
    || existing.proposal_intent_hash !== baselineProposalIntentHash(existing)
  ) {
    failBaselineProposalResume(id, "the existing proposal has no valid immutable request fingerprint");
  }
  if (existing.proposal_intent_hash !== candidate.proposal_intent_hash) {
    failBaselineProposalResume(
      id,
      "the existing record represents a different onboarding request or its source evidence changed",
    );
  }
  if (
    typeof existing.created_at !== "string"
    || !existing.audit?.proposed_by
    || typeof existing.audit.proposed_by !== "object"
  ) {
    failBaselineProposalResume(id, "the existing proposal is missing the audit data required for deterministic recovery");
  }
}

export function buildBaselineProposalTraceEvent(context, baseline, baselinePath, reportPath) {
  const traceFingerprint = computeStableHash({
    baseline_id: baseline.id,
    proposal_intent_hash: baseline.proposal_intent_hash,
    created_at: baseline.created_at,
  });
  return {
    id: `TR-BASELINE-${traceFingerprint.slice(0, 24)}`,
    story_id: null,
    type: "decision",
    summary: `Proposed project baseline ${baseline.id}`,
    outcome: null,
    actor: baseline.audit.proposed_by,
    requested_by: null,
    authorized_by: null,
    request: null,
    authorization_ref: null,
    action: "baseline.propose",
    evidence: [
      toProjectPath(context, baselinePath),
      toProjectPath(context, reportPath),
      ...(baseline.imported_documents || []).map((item) => item.path),
    ],
    related: [baseline.id],
    git: baseline.audit.git || {},
    run: baseline.audit.run || {},
    created_at: baseline.created_at,
  };
}

export function autonomyApprovalsRoot(context) {
  return path.join(autonomyRoot(context), "approvals");
}

export function autonomyApprovalSubject(context, profile, profilePath) {
  return {
    kind: profile.kind,
    id: profile.id,
    path: toProjectPath(context, profilePath),
    hash: profile.profile_hash,
  };
}

export function autonomyProfileApprovalProjection(profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return null;
  const {
    approval_ref: _approvalRef,
    authority_assurance: _authorityAssurance,
    profile_hash: _profileHash,
    status: _status,
    updated_at: _updatedAt,
    extensions,
    ...immutable
  } = profile;
  const projectedExtensions = { ...(extensions || {}) };
  delete projectedExtensions.approved_profile_hash;
  return { ...immutable, extensions: projectedExtensions };
}

export function parsePullRequestUrlIdentity(value, expectedRepository, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${label} must be an absolute URL.`);
  }
  const segments = parsed.pathname.replace(/^\/+|\/+$/gu, "").split("/");
  const repository = segments.length >= 2
    ? `${parsed.hostname.toLowerCase()}/${segments[0].toLowerCase()}/${segments[1].replace(/\.git$/iu, "").toLowerCase()}`
    : null;
  if (
    parsed.protocol !== "https:"
    || parsed.search
    || parsed.hash
    || parsed.hostname.toLowerCase() !== "github.com"
    || repository !== normalizeGitRepositoryIdentity(expectedRepository)
    || segments[2] !== "pull"
    || !/^[1-9]\d*$/u.test(segments[3] || "")
    || segments.length !== 4
  ) {
    fail(`${label} must identify one exact pull request in the approved repository.`);
  }
  const number = Number(segments[3]);
  if (!Number.isSafeInteger(number)) {
    fail(`${label} pull-request number is outside the supported integer range.`);
  }
  parsed.pathname = `/${segments[0].toLowerCase()}/${segments[1].replace(/\.git$/iu, "").toLowerCase()}/pull/${number}`;
  return {
    number,
    url: canonicalAbsoluteUrl(parsed.toString()),
    repository,
  };
}

export function remoteAuthorizationProjection(action, actionDetails) {
  const { checkpoint_policy: _checkpointPolicy, ...operationDetails } = actionDetails || {};
  if (action === "git.push") {
    const {
      push_precondition: _pushPrecondition,
      base_precondition: _basePrecondition,
      commit_coverage: _commitCoverage,
      provider_operation: _providerOperation,
      remote_verification: _remoteVerification,
      ...projection
    } = operationDetails;
    return projection;
  }
  if (action === "pull_request.merge") {
    const {
      merge_precondition: _precondition,
      provider_operation: _providerOperation,
      provider_verification: _providerVerification,
      ...projection
    } = operationDetails;
    return projection;
  }
  return operationDetails;
}

export function autonomyLifecycleReceiptHash(record) {
  const canonical = { ...(record || {}) };
  delete canonical.receipt_hash;
  delete canonical.hash_algorithm;
  return shortHashFull(stableJson(canonical));
}

export function localTargetBuildReceiptRef(context, receipt) {
  return {
    source: "build.local",
    outcome: receipt.outcome,
    receipt_ref: deliveryActionReceiptRef(context, receipt),
    snapshot_hash: localTargetBuildCompletionDetails(receipt)?.snapshot?.snapshot_hash || null,
  };
}

export function assessmentProposalsRoot(context) {
  return assessmentWorkflowDirectory(context, "proposals", "proposals");
}

export function assessmentApprovalsRoot(context) {
  return assessmentWorkflowDirectory(context, "approvals", "approvals");
}

export function assessmentProposalPath(context, id) {
  return path.join(assessmentProposalsRoot(context), `${normalizeId(id)}.json`);
}

export function assessmentApprovalPath(context, id) {
  return path.join(assessmentApprovalsRoot(context), `${normalizeId(id)}.json`);
}

export function assessmentApprovalSubject(context, proposal) {
  return {
    kind: "assessment_proposal",
    id: proposal.id,
    path: toProjectPath(context, assessmentProposalPath(context, proposal.id)),
    hash: proposal.proposal_hash,
  };
}

export function buildProposalContextOptimizationDelta(observations) {
  return buildContextOptimizationLineageDelta(observations.map((item) => item.observation));
}

export function budgetAmendmentApprovalSubject(proposal, amendment) {
  return {
    kind: "budget_amendment",
    id: amendment.id,
    proposal_ref: { id: proposal.id, hash: proposal.proposal_hash },
    base_budget_ref: { id: amendment.base_budget_id, hash: amendment.base_budget_hash },
    result_budget_ref: { id: amendment.result_budget.id, hash: amendment.result_budget_hash },
    changes: amendment.changes,
    changes_hash: shortHashFull(stableJson(amendment.changes)),
    reason: amendment.reason,
    reason_hash: shortHashFull(amendment.reason),
    approved_by: amendment.approved_by,
  };
}

export function authorizationRoot(context) {
  return path.join(context.sdlcRoot, "authorizations");
}

export function authorizationPath(context, id) {
  return path.join(authorizationRoot(context), `${normalizeId(id)}.json`);
}

export function authorizationLifecycleRoot(context) {
  return path.join(context.sdlcRoot, "receipts", "authorization-lifecycle");
}

export function authorizationLifecyclePath(context, id) {
  return path.join(authorizationLifecycleRoot(context), `${normalizeId(id)}.json`);
}

export function authorizationUsesRoot(context, authorizationId = null) {
  const configured = context.config.authority_policy?.usage_receipts_root || "authorization-uses";
  assertSafeSdlcRelativeDirectory(configured, "authority_policy.usage_receipts_root");
  const root = path.join(context.sdlcRoot, configured);
  return authorizationId ? path.join(root, normalizeId(authorizationId)) : root;
}

export function authorizationUsePath(context, authorizationId, receiptId) {
  return path.join(authorizationUsesRoot(context, authorizationId), `${normalizeId(receiptId)}.json`);
}

export function buildLegacyAuthorizationUses(actions, subjects, options = {}) {
  const normalizedActions = Array.from(new Set((actions || []).map((action) => String(action).trim().toLowerCase()))).sort();
  const normalizedSubjects = Array.from(new Set((subjects || []).map((subject) => subject === null ? null : String(subject))));
  const bindingSubjects = normalizedSubjects.length > 0 ? normalizedSubjects : [null];
  if (normalizedActions.length === 0) {
    if (options.failOnAmbiguous) {
      fail(`${options.label || "Authorization"} has no allowed action.`);
    }
    return [];
  }
  if (normalizedActions.length > 1 && bindingSubjects.length > 1 && options.failOnAmbiguous) {
    fail(`${options.label || "Authorization"} cannot combine multiple --allow-action and multiple --allow-subject values without explicit action-subject pairs. Create separate grants so legacy compatibility remains fail-closed.`);
  }
  return normalizedActions
    .flatMap((action) => bindingSubjects.map((subjectId) => {
      const useSubject = { action, subject_id: subjectId };
      return { ...useSubject, use_hash: shortHashFull(stableJson(useSubject)) };
    }))
    .sort((left, right) => left.use_hash.localeCompare(right.use_hash));
}

export function parseLegacyAuthorizationUses(value) {
  const usesByHash = new Map();
  for (const [index, rawEntry] of normalizeListOption(value).entries()) {
    const separator = rawEntry.indexOf("=");
    if (separator <= 0 || separator === rawEntry.length - 1) {
      fail(`Invalid --allow-use value at position ${index + 1}. Use action=subject, for example contract.approve=contract-ST-001-implementation.`);
    }
    const action = normalizeAuthorizedActions([rawEntry.slice(0, separator)])[0];
    const rawSubject = rawEntry.slice(separator + 1).trim();
    const subjectId = rawSubject === "*" ? "*" : normalizeId(rawSubject);
    const use = { action, subject_id: subjectId };
    const normalized = { ...use, use_hash: shortHashFull(stableJson(use)) };
    usesByHash.set(normalized.use_hash, normalized);
  }
  return Array.from(usesByHash.values()).sort((left, right) => left.use_hash.localeCompare(right.use_hash));
}

export function sameLegacyAuthorizationProjection(left, right) {
  const normalize = (values) => Array.from(new Set(values || [])).sort();
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

export function legacyAuthorizationBindingErrors(record, action, subjectId) {
  const errors = [];
  const normalizedAction = String(action || "").trim().toLowerCase();
  const normalizedSubjectId = subjectId || null;
  let uses;
  if (Array.isArray(record?.allowed_uses) && record.allowed_uses.length > 0) {
    uses = record.allowed_uses;
    for (const [index, use] of uses.entries()) {
      const expectedHash = shortHashFull(stableJson({
        action: String(use?.action || "").trim().toLowerCase(),
        subject_id: use?.subject_id || null,
      }));
      if (!use || use.use_hash !== expectedHash) {
        errors.push(`authorization allowed_uses[${index}] has an invalid action-subject hash`);
      }
    }
    const projectedActions = uses.map((use) => String(use?.action || "").trim().toLowerCase());
    const projectedSubjects = uses.map((use) => use?.subject_id || null).filter((value) => value !== null);
    if (!sameLegacyAuthorizationProjection(record.allowed_actions, projectedActions)) {
      errors.push("authorization allowed_actions does not match the projection of allowed_uses");
    }
    if (!sameLegacyAuthorizationProjection(record.allowed_subjects, projectedSubjects)) {
      errors.push("authorization allowed_subjects does not match the projection of allowed_uses");
    }
  } else {
    if (record?.schema_version === "authorization:v3") {
      return ["authorization:v3 requires explicit allowed_uses action-subject pairs and must fail closed without them"];
    }
    const actions = Array.isArray(record?.allowed_actions) ? record.allowed_actions : [];
    const subjects = Array.isArray(record?.allowed_subjects) ? record.allowed_subjects : [];
    if (actions.length > 1 && subjects.length > 1) {
      return ["authorization has multiple actions and multiple subjects without explicit pairs and must fail closed"];
    }
    uses = buildLegacyAuthorizationUses(actions, subjects, { label: `Authorization ${record?.id || "unknown"}` });
  }
  const actionMatches = (use) => {
    const allowedAction = String(use?.action || "").trim().toLowerCase();
    return allowedAction === "*" || allowedAction === normalizedAction ||
      (allowedAction.endsWith(".*") && normalizedAction.startsWith(allowedAction.slice(0, -1)));
  };
  const subjectMatches = (use) => {
    const allowedSubject = use?.subject_id || null;
    return allowedSubject === "*" || allowedSubject === normalizedSubjectId;
  };
  const matches = uses.some((use) => actionMatches(use) && subjectMatches(use));
  if (!matches) {
    if (!uses.some(actionMatches)) {
      errors.push(`authorization does not allow action ${normalizedAction}`);
    } else if (!uses.some(subjectMatches)) {
      errors.push(`authorization does not allow subject ${normalizedSubjectId || "<none>"}`);
    } else {
      errors.push(`authorization does not allow action ${normalizedAction} for subject ${normalizedSubjectId || "<none>"}`);
    }
  }
  return errors;
}

export function authorizationAllowsAction(record, action) {
  const normalized = String(action || "").trim().toLowerCase();
  const allowedActions = Array.isArray(record.allowed_actions) ? record.allowed_actions : [];
  return allowedActions.some((allowed) =>
    allowed === "*" || allowed === normalized || (allowed.endsWith(".*") && normalized.startsWith(allowed.slice(0, -1))),
  );
}

export function authorizationArtifactTypes(settings = {}) {
  const values = [
    settings.artifact_type,
    ...(Array.isArray(settings.artifact_types) ? settings.artifact_types : []),
  ];
  return Array.from(new Set(values.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean)));
}

export function contractDirectApprovalRequirements(contract = {}) {
  const policyRequirements = Array.isArray(contract.capability_policy?.approval_required_for)
    ? contract.capability_policy.approval_required_for
    : [];
  const bindingRequirements = (Array.isArray(contract.capability_bindings) ? contract.capability_bindings : [])
    .flatMap((binding) => Array.isArray(binding?.requires_approval_for) ? binding.requires_approval_for : []);
  return Array.from(new Set([...policyRequirements, ...bindingRequirements].map((value) => String(value).trim()).filter(Boolean)));
}

export function authorizationAllowsSubject(record, subjectId) {
  if (isCanonicalContentAuthorization(record)) {
    const allowedSubjects = Array.isArray(record.scope?.allowed_subject_ids) ? record.scope.allowed_subject_ids : [];
    return !subjectId || allowedSubjects.includes(subjectId);
  }
  const allowedSubjects = Array.isArray(record.allowed_subjects) ? record.allowed_subjects : [];
  return !subjectId || allowedSubjects.includes("*") || allowedSubjects.includes(subjectId);
}

export function authorizationAllowsArtifactType(record, artifactType) {
  if (isCanonicalContentAuthorization(record)) {
    const allowedArtifactTypes = Array.isArray(record.scope?.allowed_artifact_types)
      ? record.scope.allowed_artifact_types
      : [];
    return !artifactType || allowedArtifactTypes.includes(artifactType);
  }
  const allowedArtifactTypes = Array.isArray(record.allowed_artifact_types) ? record.allowed_artifact_types : [];
  return !artifactType || allowedArtifactTypes.includes(artifactType);
}

export function authorizationApprovalBoundaries(settings = {}) {
  return Array.from(new Set(
    (Array.isArray(settings.approval_boundaries) ? settings.approval_boundaries : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  ));
}

export function canonicalAuthorizationUseSubject(settings = {}) {
  const proposalRef = settings.proposal_ref
    ? { id: settings.proposal_ref.id, hash: settings.proposal_ref.hash }
    : null;
  return {
    proposal_ref: proposalRef,
    subject_id: settings.subject_id || null,
    subject_hash: settings.subject_hash || null,
    artifact_types: authorizationArtifactTypes(settings).sort(),
    approval_boundaries: authorizationApprovalBoundaries(settings).sort(),
  };
}

export function isCanonicalContentAuthorization(record) {
  return record?.kind === "content_authorization" &&
    ["content-authorization:v1", "content-authorization:v2"].includes(record?.schema_version);
}

export function authorityAssuranceLabel(value) {
  return typeof value === "string" ? value : value?.mode || value?.source || "audit_only";
}

export function authorizationRecordHash(record) {
  return isCanonicalContentAuthorization(record) ? record.authorization_hash : record?.approved_content_hash;
}

export function authorizationReceiptAccepted(receipt) {
  return receipt?.valid_at_use === true && (receipt.status === "accepted" || receipt.decision === "allow");
}

export function authorizationAllowsApprovalBoundary(record, boundary) {
  const allowedBoundaries = Array.isArray(record.allowed_approval_boundaries)
    ? record.allowed_approval_boundaries
    : [];
  return allowedBoundaries.includes("*") || allowedBoundaries.includes(boundary);
}

export function hashAuthorizationRecord(record) {
  if (record?.hash_algorithm === "sha256:stable-json:v1") {
    return hashAuthorizationRecordV1(record);
  }
  const {
    approved_content_hash,
    hash_algorithm,
    status,
    updated_at,
    revoked_at,
    revocation_reason,
    consumed_at,
    closed_at,
    closed_reason,
    use_count,
    ...subject
  } = record || {};
  return hashApprovalSubject(subject);
}

export function hashAuthorizationRecordV1(record) {
  const { approved_content_hash, hash_algorithm, revoked_at, revocation_reason, ...subject } = record || {};
  return hashApprovalSubject(subject);
}

export function exactAuthorizationProposalRefMatch(actualRef, expectedRef) {
  const actual = actualRef ?? null;
  const expected = expectedRef ?? null;
  if (actual === null || expected === null) {
    return actual === null && expected === null;
  }
  return (
    typeof actual === "object"
    && !Array.isArray(actual)
    && typeof expected === "object"
    && !Array.isArray(expected)
    && typeof actual.id === "string"
    && actual.id.length > 0
    && typeof actual.hash === "string"
    && actual.hash.length > 0
    && typeof expected.id === "string"
    && expected.id.length > 0
    && typeof expected.hash === "string"
    && expected.hash.length > 0
    && actual.id === expected.id
    && actual.hash === expected.hash
  );
}

export function describeAuthorizationProposalRef(reference) {
  return reference === null
    ? "no proposal binding"
    : `proposal ${reference?.id || "<missing-id>"} at hash ${reference?.hash || "<missing-hash>"}`;
}

export function authorizationProposalBindingError(record, expectedRef) {
  const actual = record?.proposal_ref ?? null;
  const expected = expectedRef ?? null;
  if (exactAuthorizationProposalRefMatch(actual, expected)) {
    return null;
  }
  return (
    `Authorization ${record?.id || "unknown"} proposal binding mismatch: `
    + `grant has ${describeAuthorizationProposalRef(actual)}; `
    + `this action expects ${describeAuthorizationProposalRef(expected)}.`
  );
}

export function authorizationUseKey(action, settings = {}) {
  const proposalRef = canonicalAuthorizationUseSubject(settings).proposal_ref;
  return shortHashFull(stableJson({
    action: String(action || "").trim().toLowerCase(),
    subject_id: settings.subject_id || null,
    artifact_types: authorizationArtifactTypes(settings).sort(),
    approval_boundaries: authorizationApprovalBoundaries(settings).sort(),
    proposal_ref: proposalRef,
  }));
}

export function authorizationUseReceiptProposalBindingErrors(receipt, expectedRef) {
  const expected = expectedRef ?? null;
  const references = [
    {
      label: "recorded use",
      value: ["authorization-usage-receipt:v1", "authorization-usage-receipt:v2"]
        .includes(receipt?.schema_version)
        ? receipt?.subject?.proposal_ref ?? null
        : receipt?.proposal_ref ?? null,
    },
  ];
  if (["authorization-usage-receipt:v1", "authorization-usage-receipt:v2"]
    .includes(receipt?.schema_version)) {
    references.push(
      {
        label: "authorization snapshot",
        value: receipt?.authorization_snapshot?.proposal_ref ?? null,
      },
      {
        label: "receipt proposal reference",
        value: receipt?.proposal_ref ?? null,
      },
    );
  }
  return references
    .filter(({ value }) => !exactAuthorizationProposalRefMatch(value, expected))
    .map(({ label, value }) =>
      `authorization usage receipt ${receipt?.id || "unknown"} proposal binding mismatch: `
      + `${label} has ${describeAuthorizationProposalRef(value)}; `
      + `this action expects ${describeAuthorizationProposalRef(expected)}`);
}

export function validateAuthorizationUseReceipt(receipt, settings = {}) {
  const errors = [];
  if (!receipt || receipt.kind !== "authorization_usage_receipt") {
    return ["authorization usage receipt is missing or has the wrong kind"];
  }
  const hasExpectedProposalBinding = Object.hasOwn(settings, "proposal_ref");
  if (hasExpectedProposalBinding) {
    errors.push(...authorizationUseReceiptProposalBindingErrors(
      receipt,
      settings.proposal_ref ?? null,
    ));
  }
  if (["authorization-usage-receipt:v1", "authorization-usage-receipt:v2"].includes(receipt.schema_version)) {
    const integrity = validateCanonicalAuthorizationUsageReceipt(receipt);
    if (!integrity.valid) {
      errors.push(...integrity.errors.map((error) => `authorization usage receipt ${receipt.id || "unknown"}: ${error}`));
    }
    if (!receipt.valid_at_use || receipt.decision !== "allow") {
      errors.push(`authorization usage receipt ${receipt.id || "unknown"} was not allowed at use time`);
    }
    if (settings.authorization_id && receipt.authorization_id !== settings.authorization_id) {
      errors.push(`authorization usage receipt references ${receipt.authorization_id}, expected ${settings.authorization_id}`);
    }
    if (settings.action && receipt.action !== settings.action) {
      errors.push(`authorization usage receipt action is ${receipt.action}, expected ${settings.action}`);
    }
    const expectedSubject = canonicalAuthorizationUseSubject({
      ...settings,
      proposal_ref: hasExpectedProposalBinding
        ? settings.proposal_ref ?? null
        : receipt.subject?.proposal_ref ?? null,
      subject_id: settings.subject_id || receipt.subject?.subject_id || null,
      subject_hash: settings.subject_hash || receipt.subject?.subject_hash || null,
      artifact_types: authorizationArtifactTypes(settings).length > 0
        ? authorizationArtifactTypes(settings)
        : receipt.subject?.artifact_types || [],
      approval_boundaries: authorizationApprovalBoundaries(settings).length > 0
        ? authorizationApprovalBoundaries(settings)
        : receipt.subject?.approval_boundaries || [],
    });
    if (settings.subject_id && receipt.subject?.subject_id !== settings.subject_id) {
      errors.push(`authorization usage receipt subject is ${receipt.subject?.subject_id || "missing"}, expected ${settings.subject_id}`);
    }
    if (computeAuthorizationSubjectHash(receipt.subject) !== computeAuthorizationSubjectHash(expectedSubject)) {
      errors.push(`authorization usage receipt is not bound to the expected subject content`);
    }
    return errors;
  }
  const supportedLegacyVersions = [
    "authorization-usage-receipt:legacy-v1",
    "authorization-usage-receipt:legacy-v2",
  ];
  if (!supportedLegacyVersions.includes(receipt.schema_version)) {
    errors.push(`authorization usage receipt ${receipt.id || "unknown"} has unsupported schema version ${receipt.schema_version || "missing"}`);
  }
  if (receipt.schema_version === "authorization-usage-receipt:legacy-v1" &&
      Object.hasOwn(receipt.authorization_snapshot || {}, "allowed_uses")) {
    errors.push(`legacy-v1 authorization usage receipt ${receipt.id || "unknown"} must not declare allowed_uses`);
  }
  if (receipt.schema_version === "authorization-usage-receipt:legacy-v2" &&
      (!Array.isArray(receipt.authorization_snapshot?.allowed_uses) || receipt.authorization_snapshot.allowed_uses.length === 0)) {
    errors.push(`legacy-v2 authorization usage receipt ${receipt.id || "unknown"} requires allowed_uses`);
  }
  const { receipt_hash: receiptHash, hash_algorithm: _algorithm, ...subject } = receipt;
  if (!receiptHash || receiptHash !== shortHashFull(stableJson(subject))) {
    errors.push(`authorization usage receipt ${receipt.id || "unknown"} changed after use`);
  }
  if (receipt.status !== "accepted" || receipt.valid_at_use !== true) {
    errors.push(`authorization usage receipt ${receipt.id || "unknown"} was not accepted at use time`);
  }
  if (settings.authorization_id && receipt.authorization_id !== settings.authorization_id) {
    errors.push(`authorization usage receipt references ${receipt.authorization_id}, expected ${settings.authorization_id}`);
  }
  if (settings.action && receipt.action !== settings.action) {
    errors.push(`authorization usage receipt action is ${receipt.action}, expected ${settings.action}`);
  }
  if (settings.subject_id && receipt.subject_id !== settings.subject_id) {
    errors.push(`authorization usage receipt subject is ${receipt.subject_id}, expected ${settings.subject_id}`);
  }
  errors.push(...legacyAuthorizationBindingErrors({
    id: receipt.authorization_id,
    allowed_actions: receipt.authorization_snapshot?.allowed_actions,
    allowed_subjects: receipt.authorization_snapshot?.allowed_subjects,
    allowed_uses: receipt.authorization_snapshot?.allowed_uses,
  }, receipt.action, receipt.subject_id).map(
    (error) => `authorization usage receipt ${receipt.id || "unknown"}: ${error}`,
  ));
  for (const artifactType of authorizationArtifactTypes(settings)) {
    if (!receipt.artifact_types?.includes(artifactType)) {
      errors.push(`authorization usage receipt does not cover artifact type ${artifactType}`);
    }
  }
  if (receipt.authorization_snapshot?.status_at_use !== "active") {
    errors.push(`authorization was ${receipt.authorization_snapshot?.status_at_use || "unknown"} when used`);
  }
  if (receipt.authorization_snapshot?.expires_at && Date.parse(receipt.authorization_snapshot.expires_at) <= Date.parse(receipt.used_at)) {
    errors.push(`authorization was expired when receipt ${receipt.id || "unknown"} was created`);
  }
  return errors;
}

export function storyActionAuthorizationSettings(policy, subjectId, artifactTypes = []) {
  return {
    subject_id: subjectId,
    artifact_types: authorizationArtifactTypes({ artifact_types: artifactTypes }),
    proposal_ref: policy.story?.proposal_ref
      ? { id: policy.story.proposal_ref.id, hash: policy.story.proposal_ref.hash }
      : null,
  };
}

export function canRecoverConsumedLegacyAuthorizationUse(authorization, errors, existingUse) {
  return Boolean(
    existingUse
    && !isCanonicalContentAuthorization(authorization)
    && errors.length === 1
    && errors[0] === `Authorization ${authorization.id} is consumed.`,
  );
}

export function approvalRequestPrimaryCopy(request, italian = false) {
  const copies = {
    baseline_approval: italian
      ? { label: "Fatti del progetto da usare", decision: "Decidi se descrivono correttamente il progetto." }
      : { label: "Project facts to rely on", decision: "Decide whether they describe the project correctly." },
    capability_profile_approval: italian
      ? { label: "Fonti e limiti di accesso", decision: "Decidi se sono le fonti e i limiti corretti per questo lavoro." }
      : { label: "Evidence and access boundaries", decision: "Decide whether these are the right sources and limits for this work." },
    capability_profile_refresh_required: italian
      ? { label: "Fonti e limiti di accesso", decision: "Aggiornerò i riferimenti senza ampliare il lavoro concordato." }
      : { label: "Evidence and access boundaries", decision: "I will refresh the references without widening the agreed work." },
    capability_recommendation_approval: italian
      ? { label: "Strumenti e accessi", decision: "Decidi se posso usare soltanto gli strumenti e gli accessi descritti." }
      : { label: "Tools and access", decision: "Decide whether I may use only the tools and access described." },
    capability_recommendation_refresh_required: italian
      ? { label: "Strumenti e accessi", decision: "Aggiornerò i riferimenti senza aggiungere strumenti o permessi." }
      : { label: "Tools and access", decision: "I will refresh the references without adding tools or permissions." },
    output_template_approval: italian
      ? { label: "Struttura e formato del risultato", decision: "Decidi se sezioni, dettaglio e formato sono adatti." }
      : { label: "Result structure and format", decision: "Decide whether its sections, detail, and format are right." },
    contract_clarification: italian
      ? { label: "Informazioni mancanti sul lavoro", decision: "Fornisci i fatti o i vincoli mancanti prima che prepari la proposta." }
      : { label: "Missing work information", decision: "Provide the missing facts or limits before I prepare the proposal." },
    contract_approval: italian
      ? { label: "Proposta di lavoro", decision: "Decidi se obiettivo, contesto, limiti, strumenti e risultato atteso corrispondono a ciò che vuoi." }
      : { label: "Proposed work brief", decision: "Decide whether the goal, context, limits, tools, and expected result match what you want." },
    output_link_required: italian
      ? { label: "File da considerare come risultato ufficiale", decision: "Indica quale risultato completato deve essere riutilizzato e verificato in seguito." }
      : { label: "Official result file", decision: "Choose which completed result should be reused and verified later." },
  };
  return copies[request.type] || (italian
    ? { label: "Scelta in attesa", decision: "Conferma se va bene o spiega cosa deve cambiare." }
    : { label: "Pending choice", decision: "Confirm whether it is right or explain what should change." });
}

export function normalizeApprovalCollectionScope(options = {}) {
  return {
    storyId: options.storyId ? normalizeId(options.storyId) : null,
    phase: options.phase ? normalizeRoutePhase(options.phase) : null,
    contractId: options.contractId ? normalizeId(options.contractId) : null,
    activeOnly: options.activeOnly === true,
  };
}

export function approvalSubjectMatchesActiveScope(subject, scope) {
  if (!subject || typeof subject !== "object") {
    return false;
  }
  if (scope.storyId && subject.story_id !== scope.storyId) {
    return false;
  }
  if (scope.phase && subject.phase && subject.phase !== scope.phase) {
    return false;
  }
  return Boolean(
    (scope.storyId && subject.story_id === scope.storyId)
    || (scope.phase && subject.phase === scope.phase),
  );
}

export function capabilityRecommendationNeedsInstallApproval(recommendation) {
  return (recommendation.recommendations || []).some((item) => item.install_required && !item.install_approved);
}

export function humanApprovalFields(fields = {}) {
  const reviewItems = normalizeListValue(fields.review_items, [])
    .map((item) => (item === null || item === undefined ? null : String(item).trim()))
    .filter(Boolean);
  return {
    title: fields.title || null,
    why_needed: fields.why_needed || null,
    review_items: reviewItems,
    delivery_format_options: normalizeDeliveryFormatOptions(fields.delivery_format_options || []),
    recommended_delivery_format: fields.recommended_delivery_format || null,
    delivery_question: fields.delivery_question || null,
    approval_meaning: fields.approval_meaning || null,
    approval_scope: normalizeApprovalRequestScope(fields.approval_scope),
    approve_if: fields.approve_if || null,
    change_if: fields.change_if || null,
    after_approval: fields.after_approval || null,
    user_prompt: fields.user_prompt || null,
    approval_phrase: fields.approval_phrase || null,
  };
}

// The three statements shown to the person approving are fixed: a caller may
// add context, but cannot make the request claim a broader approval than the
// one enforced, which is always limited to the item presented.
export function normalizeApprovalRequestScope(scope = null) {
  return {
    ...(scope && typeof scope === "object" ? scope : {}),
    applies_only_to_presented_item: true,
    cannot_approve_future_artifacts: true,
    requires_fresh_confirmation_for_new_artifacts: true,
  };
}

export function contractProposalHumanGuidance(contract, options) {
  const italian = humanGuidanceLocale(options) === "it";
  return {
    result: italian ? "È pronta una bozza del lavoro da esaminare." : "A draft work brief is ready for review.",
    impact: italian ? "Nessun lavoro descritto nella bozza inizierà finché non confermi che corrisponde a ciò che vuoi." : "None of the work described in the draft will start until you confirm that it matches what you want.",
    required_decision: italian ? "Controlla obiettivo, contesto, risultato atteso, limiti e verifiche; approva la bozza oppure indica cosa cambiare." : "Review the goal, context, expected result, limits, and checks; approve the draft or say what should change.",
    protection_boundary: italian ? "La creazione della bozza non autorizza modifiche al prodotto, merge, rilasci, produzione, segreti o attività fuori dai limiti descritti." : "Creating the draft does not authorize product changes, merges, releases, production, secrets, or work outside the described limits.",
    next_action: italian ? "Leggi il riepilogo qui sotto e conferma la proposta, correggila o rifiutala prima di iniziare." : "Read the summary below and confirm, correct, or reject the proposal before work starts.",
    details: {
      contract_id: contract.id,
      lifecycle_status: contract.status,
      story_id: contract.story_id || null,
    },
  };
}

export function getApprovalPolicy(context) {
  const policy = context.config.approval_policy || {};
  return {
    principle:
      policy.principle ||
      "Implementation authorization is not formal SDLC approval. Formal approvals must record an explicit source, approver, summary or evidence, and immutable subject hash.",
    formal_approval_requires_explicit_source: policy.formal_approval_requires_explicit_source !== false,
    require_summary_or_evidence_for_explicit_user: policy.require_summary_or_evidence_for_explicit_user !== false,
    require_summary_or_evidence_for_automation: policy.require_summary_or_evidence_for_automation !== false,
    allow_bootstrap_approvals_in_strict_gate: Boolean(policy.allow_bootstrap_approvals_in_strict_gate),
    legacy_approval_behavior: policy.legacy_approval_behavior || "error",
    accepted_sources: Array.isArray(policy.accepted_sources)
      ? policy.accepted_sources
      : ["explicit-user", "ci", "automation", "bootstrap"],
  };
}

export function buildApprovalRecordScope(source, settings = {}) {
  const baseScope = defaultApprovalRecordScope(source, settings);
  const explicitScope = settings.scope;
  if (source === "automation" && settings.authorization) {
    return {
      ...baseScope,
      subject_scope: explicitScope ? String(explicitScope) : null,
    };
  }
  if (!explicitScope) {
    return baseScope;
  }
  if (source === "explicit-user" || source === "automation") {
    if (explicitScope && typeof explicitScope === "object" && !Array.isArray(explicitScope)) {
      return { ...baseScope, ...explicitScope };
    }
    return {
      ...baseScope,
      approval_level: String(explicitScope),
    };
  }
  return explicitScope || baseScope;
}

export function defaultApprovalRecordScope(source, settings = {}) {
  const artifactTypes = authorizationArtifactTypes(settings);
  const approvalBoundaries = authorizationApprovalBoundaries(settings);
  if (source === "explicit-user") {
    return {
      principle: "A human approval applies only to the specific artifact or decision shown to the user before the approval.",
      subject_id: settings.subject_id || null,
      subject_label: settings.label || "approval",
      applies_only_to_presented_subject: true,
      does_not_approve_future_artifacts: true,
      requires_fresh_user_confirmation_for_new_artifacts: true,
    };
  }
  if (source === "automation") {
    return {
      principle:
        "An automation approval is valid only under an explicit delegated approval level or configured automation policy recorded in the summary or evidence.",
      subject_id: settings.subject_id || null,
      subject_label: settings.label || "approval",
      delegated_approval: true,
      applies_to_declared_approval_level: true,
      must_stay_within_declared_scope: true,
      requires_summary_or_evidence_of_delegation: true,
      does_not_expand_to_installs_deploys_secrets_external_access_or_destructive_actions: true,
      ask_user_if_scope_changes: true,
      authorization_ref: settings.authorization?.id || null,
      approval_level: settings.authorization?.scope || null,
      allowed_actions: settings.authorization?.allowed_actions || [],
      ...(artifactTypes.length > 0 ? { artifact_types: artifactTypes } : {}),
      ...(approvalBoundaries.length > 0 ? { approval_boundaries: approvalBoundaries } : {}),
    };
  }
  return settings.scope || undefined;
}

export function normalizeApprovalSource(context, options, attribution, label, status) {
  if (status !== "approved") {
    return getOptionString(options, "approval-source") || null;
  }
  const source = getOptionString(options, "approval-source");
  if (!source && attribution.actor.type === "ci") {
    return "ci";
  }
  const policy = getApprovalPolicy(context);
  if (!source) {
    if (policy.formal_approval_requires_explicit_source) {
      fail(`${label} requires --approval-source explicit-user|ci|automation|bootstrap. Implementation permission is not formal SDLC approval.`);
    }
    return null;
  }
  const normalized = String(source).trim().toLowerCase();
  if (!APPROVAL_SOURCES.has(normalized) || !policy.accepted_sources.includes(normalized)) {
    fail(`Unknown approval source '${source}'. Valid sources: ${policy.accepted_sources.join(", ")}`);
  }
  return normalized;
}

export function validateApprovalSourceForActor(context, approval) {
  if (approval.status !== "approved") {
    return;
  }
  const policy = getApprovalPolicy(context);
  if (!approval.source && policy.formal_approval_requires_explicit_source) {
    fail(`${approval.label} requires --approval-source.`);
  }
  if (approval.source === "explicit-user" && approval.actor?.type !== "human") {
    fail(`${approval.label} uses approval_source explicit-user but actor type is '${approval.actor?.type || "unknown"}'.`);
  }
  if (approval.source === "ci" && approval.actor?.type !== "ci") {
    fail(`${approval.label} uses approval_source ci but actor type is '${approval.actor?.type || "unknown"}'.`);
  }
  if (approval.source === "automation" && !["agent", "system", "ci"].includes(approval.actor?.type)) {
    fail(`${approval.label} uses approval_source automation but actor type is '${approval.actor?.type || "unknown"}'.`);
  }
  if (
    approval.source === "explicit-user" &&
    policy.require_summary_or_evidence_for_explicit_user &&
    !approval.summary &&
    approval.evidence.length === 0
  ) {
    fail(`${approval.label} requires --summary or --approval-evidence when --approval-source explicit-user is used.`);
  }
  if (approval.source === "bootstrap" && !approval.summary && approval.evidence.length === 0) {
    fail(`${approval.label} bootstrap approval requires --summary or --approval-evidence so future readers can distinguish migration from user consent.`);
  }
  if (
    approval.source === "automation" &&
    policy.require_summary_or_evidence_for_automation &&
    !approval.summary &&
    approval.evidence.length === 0
  ) {
    fail(`${approval.label} requires --summary or --approval-evidence when --approval-source automation is used, including the delegated approval level and scope.`);
  }
}

export function approvalAuthorizationSettings(approval = {}, settings = {}) {
  const scope = approval.scope && typeof approval.scope === "object"
    ? approval.scope
    : approval.approval_scope && typeof approval.approval_scope === "object"
      ? approval.approval_scope
      : {};
  const subjectId = settings.subject_id || scope.subject_id || [
    "baseline_id",
    "contract_id",
    "breakdown_id",
    "dependency_id",
    "profile_id",
    "recommendation_id",
    "template_id",
    "story_id",
  ].map((field) => approval[field]).find(Boolean) || null;
  return {
    scope,
    subject_id: subjectId,
    proposal_ref: settings.proposal_ref || scope.proposal_ref || approval.proposal_ref || null,
    subject_hash: settings.subject_hash || scope.subject_hash || approval.subject_hash || null,
    artifact_types: authorizationArtifactTypes({
      artifact_type: settings.artifact_type || approval.artifact_type,
      artifact_types: [
        ...(Array.isArray(settings.artifact_types) ? settings.artifact_types : []),
        ...(Array.isArray(scope.artifact_types) ? scope.artifact_types : []),
      ],
    }),
    approval_boundaries: authorizationApprovalBoundaries({
      approval_boundaries: [
        ...(Array.isArray(settings.approval_boundaries) ? settings.approval_boundaries : []),
        ...(Array.isArray(scope.approval_boundaries) ? scope.approval_boundaries : []),
      ],
    }),
  };
}

export function approvalIssueSeverity(context, report, approval) {
  if (!report.strict) {
    return "warnings";
  }
  const policy = getApprovalPolicy(context);
  if (!approval?.approval_source && policy.legacy_approval_behavior === "warn") {
    return "warnings";
  }
  return "errors";
}

export function hashApprovalSubject(value) {
  return shortHashFull(stableJson(stripApprovalVolatileFields(value)));
}

export function stripApprovalVolatileFields(value, depth = 0) {
  if (Array.isArray(value)) {
    return value.map((item) => stripApprovalVolatileFields(item, depth + 1));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const stripped = {};
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
  for (const key of Object.keys(value).sort()) {
    if (!volatile.has(key)) {
      stripped[key] = stripApprovalVolatileFields(value[key], depth + 1);
    }
  }
  return stripped;
}

export function dependencyProposalPath(context, id) {
  return path.join(dependenciesRoot(context), `${id}.json`);
}

export function latestApprovedRecordApproval(record) {
  return [...(record.approvals || [])]
    .filter((approval) => approval?.status === "approved")
    .sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")))
    .at(-1);
}

export function requireFormalApprovalActor(context, options, attribution, action) {
  const source = getOptionString(options, "approval-source");
  if (String(source || "").trim().toLowerCase() === "automation") {
    if (!isAutomationApprovalActor(attribution.actor)) {
      fail(`${action} with --approval-source automation requires --actor-type agent, system, or ci.`);
    }
    return;
  }
  if (!["human", "ci"].includes(attribution.actor.type)) {
    fail(`${action} requires --actor-type human or an approved CI actor.`);
  }
}

export function isAutomationApprovalActor(actor) {
  return ["agent", "system", "ci"].includes(actor?.type);
}

export function hasFormalApprovalAttribution(actor, source = null) {
  if (source === "automation") {
    return isAutomationApprovalActor(actor);
  }
  return ["human", "ci"].includes(actor?.type);
}

export function formalApprovalActorDescription(source = null) {
  return source === "automation" ? "agent/system/CI delegated automation" : "human/CI";
}

export function verificationReceiptsRoot(context) {
  return configuredSdlcDirectory(
    context,
    context.config.verification_policy?.receipt_directory,
    "receipts/verification",
    "verification_policy.receipt_directory",
  );
}

export function verificationReceiptPath(context, id) {
  return path.join(verificationReceiptsRoot(context), `${normalizeId(id)}.json`);
}

export function verificationReceiptSatisfies(receipt, { visual = false } = {}) {
  if (!receipt || receipt.status !== "passed") {
    return false;
  }
  return (
    verificationDimensionStatus(receipt, "container_verified") === "verified" &&
    verificationDimensionStatus(receipt, "content_verified") === "verified" &&
    verificationDimensionStatus(receipt, "render_verified") === (visual ? "verified" : "not-required")
  );
}

export function formatMarkdownApprovalRequest(request, index = null) {
  const prefix = index === null ? "-" : `${index}.`;
  const lines = [
    `${prefix} ${request.title || request.summary}`,
    request.why_needed ? `   - Why: ${request.why_needed}` : null,
    request.review_items?.length ? "   - What to review:" : null,
    ...(request.review_items || []).slice(0, 6).map((item) => `     - ${item}`),
    request.delivery_format_options?.length ? "   - Delivery / presentation options:" : null,
    ...(request.delivery_format_options || []).slice(0, 10).map((option) => `     - ${formatDeliveryFormatOption(option)}`),
    request.recommended_delivery_format ? `   - Recommended delivery: ${request.recommended_delivery_format}` : null,
    request.delivery_question ? `   - Delivery question: ${request.delivery_question}` : null,
    request.approval_meaning ? `   - What approval means: ${request.approval_meaning}` : null,
    request.user_prompt ? `   - Question: ${request.user_prompt}` : null,
    request.suggested_command ? `   - Command: \`${request.suggested_command}\`` : null,
  ];
  return lines.filter(Boolean);
}

export function outputLinkAuthorizationId(link) {
  if (link?.authorization_ref) {
    return link.authorization_ref;
  }
  for (const sourcePath of link?.source_paths || []) {
    const match = String(sourcePath)
      .match(/^\.sdlc\/authorization-uses\/([^/]+)\//u);
    if (match?.[1]) return match[1];
  }
  return null;
}

export function hasApprovedContractApproval(contract) {
  if (!Array.isArray(contract.approvals) || contract.approvals.length === 0) {
    return false;
  }
  const latest = [...contract.approvals]
    .filter((approval) => approval && approval.status)
    .sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")))
    .at(-1);
  return latest?.status === "approved";
}

export function hasFreshApprovedContractApproval(contract) {
  if (!Array.isArray(contract.approvals) || contract.approvals.length === 0) {
    return false;
  }
  const latest = latestContractApproval(contract);
  if (!latest || latest.status !== "approved" || !latest.approved_content_hash) {
    return false;
  }
  return latest.approved_content_hash === hashApprovalSubject(contract);
}

export function latestContractApproval(contract) {
  return [...(contract.approvals || [])]
    .filter((approval) => approval && approval.status)
    .sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")))
    .at(-1);
}

export function executeIdentityMutation(request, effect) {
  return withGovernedMutation(request, () => {
    assertMutationExecutionAuthorized(request);
    return effect();
  });
}

export function executePreparedIdentityMutation(request, effect) {
  assertMutationExecutionAuthorized(request);
  return effect();
}

export function preparedIdentityWritePath(projectRoot, descriptor, targetPath) {
  const projectPath = path.relative(projectRoot, targetPath).split(path.sep).join("/");
  const prepared = descriptor?.prepared_writes?.find((entry) => entry.target_path === projectPath);
  if (!prepared) {
    throw new MutationGovernanceError(
      `Identity migration tried to write '${projectPath}' outside its reviewed execution descriptor`,
      "MUTATION_BATCH_MISS",
      { project_path: projectPath },
    );
  }
  return path.join(projectRoot, ...prepared.temporary_path.split("/"));
}

export function sameStableFileIdentity(left, right) {
  if (Number(left.ino) === 0 || Number(right.ino) === 0) return true;
  return sameFileIdentityValues(left, right);
}

export function normalizeApprovalStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  const allowed = ["approved", "changes_requested", "rejected"];
  if (!allowed.includes(normalized)) {
    fail(`Unknown approval status '${value}'. Valid values: ${allowed.join(", ")}`);
  }
  return normalized;
}
