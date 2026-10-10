import { lifecycleEventsAfterCertification } from "./certification-freshness.mjs";
import { duplicateRegistryIds } from "../story-sync-plan.mjs";
import { VERIFIED_DELEGATION_USE } from "../approval-delegation.mjs";
import { applyApprovalDelegation, delegatedRecordFields } from "./delegation.mjs";
import { validateTestTriageEvidence } from "./test-triage.mjs";
import path from "node:path";
import { findEvidenceSupersedeForPath } from "./evidence-supersede-records.mjs";
import { validateDerivedVerificationEvidence } from "./derived-verification.mjs";
import { isActiveOutputLink } from "../output-link-selection.mjs";
import {
  UserError,
  fail,
} from "../cli/user-error.mjs";
import {
  inspectJpegEvidence,
  inspectPdfEvidence,
  inspectPngEvidence,
  inspectWebpEvidence,
} from "../evidence-formats.mjs";
import {
  assessmentProposalPath,
  buildApprovalRecordScope,
  formalApprovalActorDescription,
  hasFormalApprovalAttribution,
  hasFreshApprovedContractApproval,
  hashApprovalSubject,
  humanApprovalFields,
  normalizeApprovalSource,
  outputLinkAuthorizationId,
  requireFormalApprovalActor,
  validateApprovalSourceForActor,
  verificationReceiptPath,
} from "../lifecycle/authorization.mjs";
import {
  capabilitySuggestionPrimaryLines,
} from "../lifecycle/capability-suggestion.mjs";
import {
  assertNotDerivedArtifact,
  getOptionString,
  hashBuffer,
  inferTitle,
  inspectZipContainer,
  normalizeArtifactType,
  normalizeId,
  normalizeListOption,
  normalizeListValue,
  normalizeRawListOption,
  overlaps,
  readZipEntry,
  requireOption,
  shortHash,
  shortHashFull,
  shouldIndexFile,
  stableJson,
  upsertById,
  verifyOoxmlSemanticContent,
} from "../lifecycle/common.mjs";
import {
  CERTIFIED_TERMINAL_LIFECYCLE_SOURCES,
  OUTPUT_LINK_MODES,
  OUTPUT_VISUAL_FORMATS,
  SDLC_DIR,
  TRACE_EVIDENCE_POLICY_BINDING_SCHEMA,
  TRACE_EVIDENCE_POLICY_REF_SCHEMA,
  TRACE_EVIDENCE_POLICY_SOURCE_ROOT,
} from "../lifecycle/constants.mjs";
import {
  formatOutputDeliveryForHuman,
  validateArtifactDeliveryPath,
} from "../lifecycle/delivery.mjs";
import {
  assistantMessagePresentationFields,
  humanGuidanceLines,
  humanGuidanceLocale,
  userFriendlyTaskQuestion,
} from "../lifecycle/guidance.mjs";
import {
  assertTraceEvidencePolicySourceSafety,
  buildHistoricalOperationalEvidenceV1RedactionPolicy,
  buildOperationalBaselineEvidenceRedactionPolicy,
  buildLegacyEvidenceV1RedactionPolicy,
  buildOutputLinkDecisionSubject,
  collectOutputArtifactTypes,
  effectiveOutputDecisions,
  evidenceRepresentationMatchesRef,
  findOutputTemplate,
  findRelatedOutputLinks,
  formatLimitedList,
  hasApprovedOutputDecision,
  isHumanGuidanceOutput,
  legacyOutputGuidance,
  outputLinkHasMatchingApprovedDecision,
  outputRegistryPairKey,
  outputRenderEvidenceOptions,
  outputResolutionFingerprint,
  outputResolutionGuidance,
  outputResolutionKey,
  relatedOutputLinksFromIndex,
  safeEvidenceExcerpt,
  shouldVerifyTraceEvidence,
  traceEvidencePolicyBindingKey,
  traceEvidenceRefHash,
  verificationArtifactFormat,
  verificationArtifactSha256,
  verificationDimensionStatus,
} from "../lifecycle/output.mjs";
import {
  assertNoSymlinkPathSegments,
  isDerivedArtifactPath,
  isInsidePath,
  testRunsRoot,
  toProjectPath,
} from "../lifecycle/project.mjs";
import {
  addRouteCheck,
} from "../lifecycle/route.mjs";
import {
  buildTraceRedactionPolicy,
  configuredPhaseOrder,
  failTraceIntegrityWrite,
  latestTraceEvent,
  storyLifecycleCertificationLockPath,
} from "../lifecycle/story.mjs";
import {
  workflowFinalGateReceiptPath,
} from "../lifecycle/workflow.mjs";
import {
  createRedactionPolicyFromSource,
  describeRedactionPolicy,
  redactValueInChunks,
  redactValueWithMetadata,
} from "../observability/redaction.mjs";
import {
  Date,
  console,
  crypto,
  fs,
  process,
} from "../runtime/host.mjs";
import {
  withTraceIntegritySnapshot,
} from "../trace-integrity.mjs";
import {
  buildVerificationReceipt,
  validateVerificationReceiptIntegrity,
} from "../verification-levels.mjs";
import {
  WORKFLOW_CANONICAL_EVIDENCE_SCHEMA,
  WORKFLOW_LEGACY_CANONICAL_EVIDENCE_SCHEMA,
  hasValidWorkflowReceiptHash,
  selectRequiredOutputRefsForPhase,
} from "../workflow-canonical-evidence.mjs";
import {
  workflowCanonicalEvidenceSchema,
} from "../workflow-engine.mjs";
import {
  readAssessmentProposal,
} from "./assessment.mjs";
import {
  approvalAssistantMessageLinesForLocale,
  authorizationUseErrors,
  buildApprovalEvidence,
  buildOutputTemplateApprovalRequest,
  buildTraceAuthorityMetadata,
  contractMatchesStoryApprovalScope,
  outputTemplateNeedsApproval,
  readArtifactGeneratorReceipt,
  readAuthorization,
  recordOrReuseAuthorizationUse,
  renderApprovalRequestsAssistantMessage,
  requireAutomationAuthorization,
  validateFormalApprovalRecord,
  validateTaskStartReceipt,
} from "./authorization.mjs";
import {
  appendRecordSchemaIssues,
  assertRecordSchema,
  buildAttribution,
  collectJsonFiles,
  compactTimestamp,
  now,
  readSecretScanRecords,
  readTestRunRecords,
  refreshDerivedCache,
  secretScanCoversDeliveryBase,
  secretScanDeliveryBase,
  secretScanMatchesWorkspace,
  secretScanWorkspaceStateHash,
  sleepSync,
  uniqueRecordSuffix,
} from "./common.mjs";
import {
  CLI_OPERATION_CONTEXT,
} from "./definitions.mjs";
import {
  buildOutputDelivery,
  effectiveOutputDelivery,
} from "./delivery.mjs";
import {
  execGit,
  execGitOutput,
} from "./git.mjs";
import {
  getCacheStatus,
  statusCliCommand,
  userFriendlyTaskStartIntro,
} from "./guidance.mjs";
import {
  captureDirectoryIdentity,
  ensureInitialized,
  initializeOutputContracts,
} from "./migration.mjs";
import {
  pathEntryExistsNoFollow,
  resolveProjectFilePath,
} from "./project.mjs";
import {
  isTaskContractApproved,
  taskDecisionExampleAnswer,
} from "./route.mjs";
import {
  acquireFileLock,
  copyFileGoverned,
  ensureDir,
  hashFile,
  prepareGovernedTraceEvent,
  prepareGovernedTraceMutation,
  readFileFromStableParent,
  readProjectJson,
  readStableRegularFileBuffer,
  readStableTemplateAsset,
  removeEmptyDirectoryGoverned,
  removePathGoverned,
  sealPreparedTraceEventLocked,
  selectStableTemplateAsset,
  stableContextSourceSnapshot,
  userFriendlyBlockingReason,
  walkFiles,
  withOutputRegistryLock,
  writeJsonFile,
  writeTextFile,
} from "./storage.mjs";
import {
  appendTraceEvent,
  assertStoryOpenForWork,
  collectContractDependencyFreshnessGaps,
  collectContractReadinessGaps,
  consumeStoryActionCheckpoint,
  contractIsActiveStoryContract,
  effectiveStoryLifecycleProjection,
  inspectStoryContract,
  readContractById,
  readRequirement,
  readStory,
  readTraceEvents,
  storyActionCheckpointPolicy,
  storyDeliveryMergeCommit,
  traceIntegrityOptions,
  validateCurrentStrictStory,
  validateStoryActionCheckpoint,
} from "./story.mjs";
import {
  assertNoPendingWorkflowTraceTransaction,
  deriveCurrentStoryWorkflowScope,
} from "./workflow.mjs";

export function renderTaskStartAssistantMessage(decision) {
  const message = renderTaskStartDecisionMessage(decision);
  const suggestion = capabilitySuggestionPrimaryLines(decision.capability_suggestion);
  return suggestion.length > 0 ? `${message}\n\n${suggestion.join("\n")}` : message;
}

function renderTaskStartDecisionMessage(decision) {
  const locale = decision.__human_locale || "en";
  const italian = locale === "it";
  if (decision.approval_requests?.length > 0) {
    return renderApprovalRequestsAssistantMessage(decision.approval_requests);
  }
  if (decision.status === "ready_to_execute") {
    return [
      italian ? "Il lavoro è pronto per iniziare." : "The work is ready to start.",
      decision.phase ? `${italian ? "Tipo di lavoro" : "Work type"}: ${decision.phase}.` : null,
      decision.story_id ? `${italian ? "Attività" : "Work item"}: ${decision.story_id}.` : null,
      decision.contract_id ? `${italian ? "Incarico concordato" : "Work brief"}: ${decision.contract_id}.` : null,
    ].filter(Boolean).join("\n");
  }
  const explanations = Array.from(new Set(
    (decision.blocking_reasons || []).map((reason) => userFriendlyBlockingReason(reason, locale, decision)),
  )).filter(Boolean);
  const lines = [
    italian ? "Mi serve una decisione rapida prima di continuare." : "I need one quick decision before I continue.",
    userFriendlyTaskStartIntro(decision, locale),
    "",
    explanations.length ? (italian ? "In parole semplici:" : "In plain language:") : null,
    ...explanations.map((explanation) => `- ${explanation}`),
    decision.questions?.length ? (italian ? "Cosa mi serve da te:" : "What I need from you:") : null,
    ...(decision.questions || []).flatMap((question, index) => [
      `- ${italian ? "Domanda" : "Question"} ${index + 1}: ${userFriendlyTaskQuestion(decision, question, locale)}`,
      `  ${italian ? "Perché" : "Why"}: ${explanations[index] || explanations[0] || (italian
        ? "La risposta definisce il perimetro esatto senza lasciare che il plugin lo indovini."
        : "Your answer fixes the exact scope or boundary I must follow instead of guessing.")}`,
      `  ${italian ? "Esempio di risposta" : "Example answer"}: ${taskDecisionExampleAnswer(decision, locale)}`,
      italian
        ? "  Effetto: registrerò la risposta nell’incarico applicabile e controllerò che il lavoro successivo la rispetti."
        : "  Effect: I will record the answer in the applicable context or work brief and validate later work against it.",
    ]),
    "",
    italian
      ? 'Puoi rispondere normalmente, per esempio: "usa README.md e src/ come contesto", "il formato proposto va bene" oppure "includi anche X".'
      : 'You can answer naturally, for example "use README.md and src/ as context", "the proposed format is fine", or "change the scope to include X".',
  ];
  return lines.filter(Boolean).join("\n");
}

export function validateApprovedStoryContractForPhaseOutput(context, story, action, expectations = [], options = {}) {
  if (story.contract_review_required) {
    const staleContractId = story.contract_review_required.contract_id || story.contract_id || "the previous contract";
    fail(
      [
        `${action} cannot use contract ${staleContractId} because story ${story.id} acceptance criteria changed after it was prepared.`,
        "Create and approve a new exact contract ID with --replace-story-contract before producing, linking, or completing governed phase output.",
        "The migration override cannot bypass this story-definition review boundary.",
      ].join("\n"),
    );
  }
  if (options["allow-unapproved-contract-output"]) {
    return null;
  }
  const storyId = normalizeId(story.id || options.story || options.id || "unknown");
  const contractState = inspectStoryContract(context, story);
  if (!contractState.exists) {
    fail(
      [
        `${action} requires an approved story contract before producing or linking phase output for ${storyId}.`,
        contractState.message,
        `Run contract create/approve for story ${storyId}, then retry.`,
        "Use --allow-unapproved-contract-output only for explicit migration or recovery of pre-existing artifacts.",
      ].join("\n"),
    );
  }
  const contract = contractState.contract;
  const errors = [];
  if (contract.story_id !== storyId) {
    errors.push(`contract.story_id is '${contract.story_id || "project"}', expected '${storyId}'`);
  }
  if (contract.status !== "approved") {
    errors.push(`contract.status is '${contract.status || "unknown"}'`);
  }
  if (!hasFreshApprovedContractApproval(contract)) {
    errors.push("contract approval is missing, stale, or lacks approved_content_hash");
  }
  for (const gap of collectContractDependencyFreshnessGaps(context, contract)) {
    errors.push(`contract dependency freshness gap: ${gap.summary}`);
  }
  for (const gap of collectContractReadinessGaps(context, contract)) {
    errors.push(`contract readiness gap: ${gap.summary}`);
  }

  const refs = Array.isArray(contract.output_contract_refs) ? contract.output_contract_refs : [];
  const registry = readOutputRegistry(context, { missingOk: true });
  const requiresStartReceipt = refs.some((ref) =>
    (registry?.templates || []).some((template) => template.id === ref.template_id && template.preset === "technical-assessment"),
  );
  const taskStartReceiptPath = path.join(context.sdlcRoot, "stories", storyId, "task-start.json");
  const actionRequiresStartReceipt = ["output.link", "story.complete-step"].includes(action);
  if (actionRequiresStartReceipt || requiresStartReceipt || fs.existsSync(taskStartReceiptPath)) {
    for (const issue of validateTaskStartReceipt(context, storyId, contract)) {
      errors.push(issue);
    }
  }
  for (const expectation of expectations) {
    if (!expectation.artifact_type) {
      continue;
    }
    const matchingRef = refs.find(
      (ref) =>
        ref.artifact_type === expectation.artifact_type &&
        (!expectation.template_id || ref.template_id === expectation.template_id) &&
        (!expectation.mode || ref.mode === expectation.mode) &&
        (!expectation.phase || !ref.phase || ref.phase === expectation.phase),
    );
    if (!matchingRef) {
      const expected = [
        expectation.artifact_type,
        expectation.template_id || "<any-template>",
        expectation.mode || "<any-mode>",
      ].join(":");
      errors.push(`output ${expected} is not covered by approved contract output refs`);
    }
  }

  if (errors.length > 0) {
    fail(
      [
        `${action} is blocked because story ${storyId} contract ${story.contract_id} is not ready for phase output.`,
        ...errors.map((error) => `- ${error}`),
        "Ask the user to approve or revise the contract before producing, linking, or completing phase output.",
        "Use --allow-unapproved-contract-output only for explicit migration or recovery of pre-existing artifacts.",
      ].join("\n"),
    );
  }
  return contract;
}

export function addOutputRefChecks(context, decision, story, contract) {
  const refs = Array.isArray(contract.output_contract_refs) ? contract.output_contract_refs : [];
  addRouteCheck(
    decision,
    "contract_output_refs",
    refs.length > 0 ? "passed" : "warning",
    refs.length > 0 ? `${refs.length} output ref(s)` : "No output refs on the story contract",
  );
  if (refs.length === 0) {
    return;
  }
  const registry = readOutputRegistry(context, { missingOk: true });
  for (const ref of refs) {
    const template = (registry?.templates || []).find((candidate) => candidate.id === ref.template_id);
    addRouteCheck(
      decision,
      `output_ref_template:${ref.artifact_type}`,
      template?.status === "approved" ? "passed" : "failed",
      template ? `${template.id} is ${template.status}` : `Missing template ${ref.template_id}`,
    );
    const link = (registry?.links || []).find(
      (candidate) =>
        candidate.story_id === story.id &&
        candidate.artifact_type === ref.artifact_type &&
        candidate.template_id === ref.template_id &&
        candidate.mode === ref.mode,
    );
    addRouteCheck(
      decision,
      `output_ref_link:${ref.artifact_type}`,
      link ? "passed" : "warning",
      link ? link.artifact_path : `No output link satisfies ${ref.artifact_type}:${ref.template_id}:${ref.mode}`,
    );
  }
}

export function buildActionEvidence(context, values) {
  return normalizeRawListOption(values).map((rawPath) => {
    const evidencePath = resolveProjectFilePath(context, rawPath, { mustExist: true, fileOnly: true });
    assertNotDerivedArtifact(context, evidencePath, "Delivery action evidence");
    return { path: toProjectPath(context, evidencePath), sha256: hashFile(evidencePath) };
  });
}

export function collectOutputLinkActionRequests(context, scope = {}) {
  const registry = readOutputRegistry(context, { missingOk: true });
  const links = registry?.links || [];
  const requests = [];
  for (const contract of collectJsonFiles(context, path.join(context.sdlcRoot, "contracts"))) {
    if (
      !contractMatchesStoryApprovalScope(context, contract, scope) ||
      !contractIsActiveStoryContract(context, contract)
    ) {
      continue;
    }
    if (!isTaskContractApproved(context, contract) || collectContractReadinessGaps(context, contract).length > 0) {
      continue;
    }
    const candidates = contract.story_id ? findUnlinkedStoryOutputCandidates(context, contract.story_id) : [];
    if (candidates.length === 0) {
      continue;
    }
    const workflowScopeReport = { errors: [] };
    const workflow = contract.story_id
      ? deriveCurrentStoryWorkflowScope(
          context,
          contract.story_id,
          workflowScopeReport,
        )
      : null;
    if (workflowScopeReport.errors.length > 0) {
      // A request generated from an untrusted phase position could expose a
      // future obligation too early. The workflow integrity diagnostics remain
      // available through status and gate checks.
      continue;
    }
    const outputScope = workflow
      && workflowCanonicalEvidenceSchema(workflow.effective_definition)
        === WORKFLOW_CANONICAL_EVIDENCE_SCHEMA
      ? {
          current_phase: workflow.scope.current_phase,
          phase_order: workflow.scope.phase_order,
          require_all: false,
        }
      : null;
    const selection = selectRequiredOutputRefsForPhase(
      contract.output_contract_refs || [],
      outputScope,
    );
    if (!selection.valid) {
      continue;
    }
    for (const { ref } of selection.required_refs) {
      if (!ref.artifact_type || !ref.template_id || !ref.mode || !contract.story_id) {
        continue;
      }
      const matchingLink = links.find(
        (link) =>
          link.story_id === contract.story_id &&
          link.artifact_type === ref.artifact_type &&
          link.template_id === ref.template_id &&
          link.mode === ref.mode,
      );
      if (!matchingLink) {
        const phaseLabel = Object.hasOwn(ref, "phase")
          ? ref.phase
          : "legacy-all-due";
        const requestIdentity = [
          contract.story_id,
          ref.artifact_type,
          ref.template_id,
          ref.mode,
          phaseLabel,
        ].map((part) => String(part).replace(/[^A-Za-z0-9._-]+/gu, "-")).join("-");
        requests.push({
          id: `link-output-${requestIdentity}`,
          type: "output_link_required",
          status: "needs_canonical_output_link",
          summary:
            `Link the ${ref.artifact_type} artifact for ${contract.story_id} `
            + `when its ${phaseLabel} obligation is due and the agreed output exists.`,
          subject_id: contract.id,
          story_id: contract.story_id,
          artifact_type: ref.artifact_type,
          template_id: ref.template_id,
          mode: ref.mode,
          phase: Object.hasOwn(ref, "phase") ? ref.phase : null,
          due_phase_label: phaseLabel,
          sources: [contract.__relative_path],
          ...humanApprovalFields({
            title: `Canonical ${ref.artifact_type} output for ${contract.story_id}`,
            why_needed: "The contract requires a durable output, but the canonical file representing the phase result is not linked yet.",
            review_items: [
              `Story: ${contract.story_id}`,
              `Output type: ${ref.artifact_type}`,
              `Required template: ${ref.template_id}`,
              `Mode: ${ref.mode}`,
              `Due phase: ${phaseLabel}`,
              `Contract: ${contract.id}`,
              `Available unlinked result files: ${formatLimitedList(candidates, 8)}`,
            ],
            approval_meaning: "Choosing the canonical file makes that artifact verifiable by later gates.",
            approve_if: "Provide the file only when the output exists and is the official source you want to use.",
            change_if: "Ask for changes if the output does not exist yet, does not follow the template, or does not represent the correct result.",
            after_approval: "After the link, the gate can verify hashes, template, mode, and covered requirements.",
            user_prompt: `Which file should be the canonical ${ref.artifact_type} output for ${contract.story_id}?`,
          }),
          suggested_question: `Which ${ref.artifact_type} artifact should be canonical for ${contract.story_id}?`,
          suggested_command: `agentic-sdlc output link --story ${contract.story_id} --type ${ref.artifact_type} --artifact ${candidates[0]} --template ${ref.template_id} --mode ${ref.mode} --requirement <REQ-ID>`,
        });
      }
    }
  }
  return requests;
}

export function humanOutputLabel(value) {
  const normalized = String(value || "").trim().toLowerCase();
  const labels = {
    "functional-analysis": "functional analysis",
    "technical-analysis": "technical assessment",
    "technical-decision-matrix": "technical decision matrix",
    "test-strategy": "test strategy",
    "test-plan": "test plan",
    "implementation-summary": "implementation summary",
    "release-evidence": "release evidence",
  };
  return labels[normalized] || String(value || "this output").replace(/[-_]+/g, " ");
}

export function collectStoryTemplateIds(context, storyId, registry = null) {
  const ids = new Set();
  for (const contract of collectJsonFiles(context, path.join(context.sdlcRoot, "contracts"))) {
    if (contract.story_id === storyId) {
      for (const ref of contract.output_contract_refs || []) {
        if (ref.template_id) {
          ids.add(ref.template_id);
        }
      }
    }
  }
  for (const link of registry?.links || []) {
    if (link.story_id === storyId && link.template_id) {
      ids.add(link.template_id);
    }
  }
  return ids;
}

export function collectOutputContractRefReadinessGaps(context, contract) {
  const gaps = [];
  const rawRefs = contract.output_contract_refs;
  if (rawRefs !== undefined && !Array.isArray(rawRefs)) {
    gaps.push({
      code: "invalid_output_refs",
      summary: "output_contract_refs must be an array",
      question: "Replace output_contract_refs with the agreed list of canonical output obligations.",
    });
    return gaps;
  }
  const refs = rawRefs || [];
  const phaseOrder = configuredPhaseOrder(context);
  if (
    typeof contract.phase !== "string"
    || !phaseOrder.includes(contract.phase)
  ) {
    gaps.push({
      code: "invalid_contract_phase",
      summary:
        `contract phase '${String(contract.phase || "unknown")}' is not configured`,
      question: `Choose one configured contract phase: ${phaseOrder.join(", ")}.`,
    });
  }
  const identities = new Set();
  for (const [index, ref] of refs.entries()) {
    if (!ref || typeof ref !== "object" || Array.isArray(ref)) {
      gaps.push({
        code: "invalid_output_ref",
        summary: `output ref ${index + 1} must be an object`,
        question: "Replace the malformed output ref with artifact_type, template_id, mode, and an optional configured phase.",
      });
      continue;
    }
    const artifactType = String(ref.artifact_type || "").trim();
    const templateId = String(ref.template_id || "").trim();
    const mode = String(ref.mode || "").trim();
    if (!artifactType || !templateId || !mode || !OUTPUT_LINK_MODES.has(mode)) {
      gaps.push({
        code: "invalid_output_ref",
        summary:
          `output ref ${index + 1} must declare artifact_type, template_id, `
          + "and mode reuse, delta, or new",
        question: "Correct the malformed output reference before approving this work brief.",
      });
    } else {
      const identity = [artifactType, templateId, mode].join("\u0000");
      if (identities.has(identity)) {
        gaps.push({
          code: "duplicate_output_ref",
          summary:
            `output ref ${artifactType}:${templateId}:${mode} is duplicated; `
            + "one canonical link cannot satisfy multiple phase obligations",
          question: "Keep only one phase obligation for this exact artifact, template, and mode.",
        });
      }
      identities.add(identity);
    }
    if (Object.hasOwn(ref, "phase")) {
      const phase = typeof ref.phase === "string" ? ref.phase.trim() : "";
      if (!phase || !phaseOrder.includes(phase)) {
        gaps.push({
          code: "invalid_output_ref_phase",
          summary:
            `output ref ${artifactType || index + 1} has unknown phase `
            + `'${phase || String(ref.phase ?? "") || "empty"}'`,
          question: `Use one configured phase: ${phaseOrder.join(", ")}; omit phase only for an intentional legacy all-due obligation.`,
        });
      }
    }
  }

  const phaseTemplate = context.config.phases[contract.phase] || {};
  const phaseHasOutputs =
    Array.isArray(phaseTemplate.outputs)
    && phaseTemplate.outputs.length > 0;
  const requiresOutputCoverage =
    context.config.gate_policy?.strict_mode?.requires_output_contract_coverage !== false;
  if (contract.story_id && phaseHasOutputs && requiresOutputCoverage) {
    if (refs.length === 0) {
      gaps.push({
        code: "missing_output_ref",
        summary: "missing agreed output format for this story",
        question: "What output should this work produce, and should it be a new document or an update to an existing one?",
      });
    } else if (!refs.some((ref) =>
      ref
      && typeof ref === "object"
      && !Array.isArray(ref)
      && (
        !Object.hasOwn(ref, "phase")
        || ref.phase === contract.phase
      ))) {
      gaps.push({
        code: "missing_phase_output_ref",
        summary:
          `story contract phase '${contract.phase}' has no output due in that phase; `
          + "all declared outputs are assigned elsewhere",
        question:
          `Which canonical output is due in '${contract.phase}'? `
          + "Assign at least one output ref to that exact phase, or intentionally use a legacy unphased all-due ref.",
      });
    }
  }
  return gaps;
}

export function storyOutputResolveHint(contract) {
  if (!contract.story_id) {
    return null;
  }
  return `Resolve output first with: agentic-sdlc output resolve --story ${contract.story_id} --type <artifact-type>`;
}

export function validateContractOutputRefsForCreate(context, rawRefs, options = {}) {
  if (rawRefs.length === 0 || options["allow-unapproved-output-ref"]) {
    return;
  }
  const refs = buildOutputContractRefs(rawRefs, configuredPhaseOrder(context));
  const registry = readOutputRegistry(context, { missingOk: true });
  const templates = new Map((registry?.templates || []).map((template) => [template.id, template]));
  const errors = [];
  for (const ref of refs) {
    const template = templates.get(ref.template_id);
    if (!template) {
      errors.push(`${ref.artifact_type}:${ref.template_id}:${ref.mode} references missing output template ${ref.template_id}`);
      continue;
    }
    if (template.type !== ref.artifact_type) {
      errors.push(`${ref.artifact_type}:${ref.template_id}:${ref.mode} uses template type '${template.type}'`);
    }
    if (template.status !== "approved") {
      errors.push(`${ref.artifact_type}:${ref.template_id}:${ref.mode} uses ${template.status || "unknown"} template ${ref.template_id}`);
    } else if (outputTemplateNeedsApproval(context, template)) {
      errors.push(`${ref.artifact_type}:${ref.template_id}:${ref.mode} uses stale structure or delivery metadata for template ${ref.template_id}`);
    }
  }
  if (errors.length > 0) {
    fail(
      [
        "Contract output refs require approved output templates before contract creation.",
        ...errors.map((error) => `- ${error}`),
        "First agree the output format with the user, then run output template approve with --approval-source explicit-user.",
        "Use --allow-unapproved-output-ref only for explicit migration or recovery work.",
      ].join("\n"),
    );
  }
}

export function buildOutputContractRefs(rawRefs, phaseOrder = []) {
  const refs = rawRefs.map((rawRef) => {
    const parts = String(rawRef).split(":").map((part) => part.trim());
    if (![3, 4].includes(parts.length) || parts.some((part) => !part)) {
      fail(
        "Output refs must use --output-ref "
        + "artifact-type:template-id:reuse|delta|new[:phase]",
      );
    }
    const [artifactType, templateId, mode, phase] = parts;
    if (phase && !phaseOrder.includes(phase)) {
      fail(
        `Output ref phase '${phase}' is not configured. Valid phases: `
        + `${phaseOrder.join(", ") || "(none)"}`,
      );
    }
    return {
      artifact_type: normalizeArtifactType(artifactType),
      template_id: normalizeId(templateId),
      mode: normalizeOutputMode(mode),
      ...(phase ? { phase } : {}),
    };
  });
  const identities = new Set();
  for (const ref of refs) {
    const identity = [ref.artifact_type, ref.template_id, ref.mode].join("\u0000");
    if (identities.has(identity)) {
      fail(
        `Output ref ${ref.artifact_type}:${ref.template_id}:${ref.mode} is duplicated; `
        + "one canonical output link cannot satisfy multiple phase obligations.",
      );
    }
    identities.add(identity);
  }
  return refs;
}

export function buildBaselineDocumentEvidence(context, rawPath) {
  const snapshot = stableContextSourceSnapshot(context, rawPath, "Baseline document");
  const resolved = snapshot.filePath;
  const content = snapshot.content;
  const text = content.toString("utf8");
  return {
    type: "document",
    path: snapshot.projectPath,
    sha256: snapshot.sha256,
    size_bytes: content.length,
    title: inferTitle(resolved, text),
    headings: text
      .split(/\r?\n/)
      .map((line) => line.match(/^#{1,4}\s+(.+)$/)?.[1]?.trim())
      .filter(Boolean)
      .slice(0, 12),
    excerpt: safeEvidenceExcerpt(resolved, text, 800),
    trust: "untrusted_project_evidence",
  };
}

export function storyHasOutputLink(context, storyId, query = null) {
  if (query?.registry_index) {
    return (query.registry_index.links_by_story.get(storyId) || []).length > 0;
  }
  const registry = readOutputRegistry(context, { missingOk: true });
  return (registry?.links || []).some((link) => link.story_id === storyId);
}

export function snapshotManualTraceEvidence(context, event) {
  if (!["test", "release"].includes(event.type) || !Array.isArray(event.evidence) || event.evidence.length === 0) {
    return event;
  }
  const redactionPolicy = buildTraceRedactionPolicy(context);
  const mappings = [];
  const evidence = event.evidence.map((projectPath, index) => {
    const sourcePath = resolveProjectFilePath(context, projectPath, { mustExist: true, fileOnly: true });
    assertNotDerivedArtifact(context, sourcePath, "Trace evidence");
    const safeName = path.basename(sourcePath)
      .replace(/[^A-Za-z0-9._-]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "evidence.txt";
    const snapshotRelativePath = [
      SDLC_DIR,
      "traces",
      "evidence",
      normalizeId(event.id),
      `${String(index + 1).padStart(2, "0")}-${safeName}`,
    ].join("/");
    const snapshotPath = resolveProjectFilePath(context, snapshotRelativePath, { mustExist: false });
    const representation = redactedEvidenceRepresentation(context, sourcePath, redactionPolicy);
    writeTextFile(snapshotPath, representation, { atomicCreate: true, durable: true });
    mappings.push({
      source_path: projectPath,
      snapshot_path: snapshotRelativePath,
    });
    return snapshotRelativePath;
  });
  return {
    ...event,
    evidence,
    evidence_sources: mappings,
  };
}

export function bindHistoricalTraceEvidencePolicy(context, options) {
  ensureInitialized(context);
  const storyId = options.story ? normalizeId(String(options.story)) : null;
  if (storyId && !readStory(context, storyId)) {
    fail(`Story ${storyId} does not exist`);
  }
  const targetIds = [...new Set(normalizeListOption(options["target-event"]).map(String))];
  if (targetIds.length === 0) fail("Provide at least one --target-event to bind.");
  const policyName = String(requireOption(options, "redaction-policy"));
  if (!["legacy_evidence_v1", "operational_evidence_v1", "operational_v2"].includes(policyName)) {
    fail("--redaction-policy must be legacy_evidence_v1, operational_evidence_v1, or operational_v2.");
  }
  // operational_v2 evidence may predate later built-in detectors, so both the
  // current detector set and the original one (each with the project's own
  // patterns) are candidates; the one that reproduces the stored fingerprint
  // is bound, and its exact source is recorded.
  const candidatePolicies = policyName === "legacy_evidence_v1"
    ? [buildLegacyEvidenceV1RedactionPolicy(context)]
    : policyName === "operational_evidence_v1"
      ? [buildHistoricalOperationalEvidenceV1RedactionPolicy(context)]
      : [buildTraceRedactionPolicy(context), buildOperationalBaselineEvidenceRedactionPolicy(context)];
  const policySourceRefs = new Map();
  let policySourceRef;
  const traceFile = storyId ? `${storyId}.jsonl` : "project.jsonl";
  const tracePath = path.join(context.sdlcRoot, "traces", traceFile);
  const bindUnderLock = () => {
    let records;
    try {
      records = withTraceIntegritySnapshot(
        traceIntegrityOptions(context, tracePath),
        ({ integrity, records: snapshotRecords, present }) => {
          if (!present || !integrity.valid || !integrity.initialized) {
            fail("Historical evidence policy binding requires a valid sealed trace.");
          }
          return snapshotRecords;
        },
      );
    } catch (error) {
      if (error instanceof UserError) throw error;
      failTraceIntegrityWrite(error);
    }
    if (
      process.env.NODE_ENV === "test"
      && /^\d{1,4}$/u.test(process.env.AGENTIC_SDLC_TEST_TRACE_BIND_DELAY_MS || "")
    ) {
      sleepSync(Math.min(Number(process.env.AGENTIC_SDLC_TEST_TRACE_BIND_DELAY_MS), 1_000));
    }
    const events = records.filter((record) => record.valid).map((record) => record.event);
    const byId = new Map();
    for (const event of events) {
      if (byId.has(event.id)) fail(`Trace contains duplicate event id ${event.id}.`);
      byId.set(event.id, event);
    }
    const alreadyBound = new Set();
    for (const event of events) {
      for (const binding of Array.isArray(event.evidence_policy_bindings) ? event.evidence_policy_bindings : []) {
        const key = traceEvidencePolicyBindingKey(binding?.target);
        if (key) alreadyBound.add(key);
      }
    }
    const bindings = [];
    for (const targetId of targetIds) {
      const target = byId.get(targetId);
      if (!target || target?._trace_integrity?.schema_version !== "trace-integrity-event:v1") {
        fail(`Target trace event ${targetId} is missing or unsealed.`);
      }
      const refs = Array.isArray(target.evidence_refs)
        ? target.evidence_refs.filter((ref) => ref?.representation === "redacted_utf8_v1")
        : [];
      if (refs.length === 0) fail(`Target trace event ${targetId} has no historical v1 evidence refs.`);
      for (const ref of refs) {
        const bindingTarget = {
          event_id: target.id,
          event_hash: target._trace_integrity.event_hash,
          evidence_path: ref.path,
          evidence_sha256: ref.sha256,
          evidence_ref_sha256: traceEvidenceRefHash(ref),
        };
        const key = traceEvidencePolicyBindingKey(bindingTarget);
        if (alreadyBound.has(key)) fail(`Historical evidence ref ${target.id}:${ref.path} is already bound.`);
        const filePath = resolveProjectFilePath(context, ref.path, { mustExist: true, fileOnly: true });
        const policy = candidatePolicies.find((candidate) => evidenceRepresentationMatchesRef(
          redactedEvidenceRepresentation(context, filePath, candidate),
          ref,
        ));
        if (!policy) {
          fail(`Selected redaction policy does not reproduce ${target.id}:${ref.path}.`);
        }
        if (!policySourceRefs.has(policy)) policySourceRefs.set(policy, traceEvidencePolicySourceRef(context, policy));
        const bindingPolicySourceRef = policySourceRefs.get(policy);
        policySourceRef ||= bindingPolicySourceRef;
        alreadyBound.add(key);
        bindings.push({
          schema_version: TRACE_EVIDENCE_POLICY_BINDING_SCHEMA,
          target: bindingTarget,
          policy_source_ref: bindingPolicySourceRef,
        });
      }
    }
    const attribution = buildAttribution(context, options, "trace.evidence-policy.bind");
    const event = sealPreparedTraceEventLocked(
      context,
      tracePath,
      prepareGovernedTraceEvent(context, {
        id: `TR-${compactTimestamp()}-${crypto.randomBytes(3).toString("hex")}`,
        story_id: storyId,
        type: "decision",
        summary: getOptionString(options, "summary")
          || `Bound ${bindings.length} historical evidence reference${bindings.length === 1 ? "" : "s"} to ${policyName}`,
        outcome: "passed",
        actor: attribution.actor,
        ...buildTraceAuthorityMetadata(context, options, attribution),
        action: "trace.evidence-policy.bind",
        evidence: [...new Set([...policySourceRefs.values()].map((ref) => ref.path))],
        evidence_policy_bindings: bindings,
        related: targetIds,
        git: attribution.git,
        run: attribution.run,
        correlation_id: CLI_OPERATION_CONTEXT.correlation_id,
        created_at: now(),
      }),
    );
    return { bindings, event };
  };
  const releaseTraceLock = acquireFileLock(`${tracePath}.lock`);
  let result;
  try {
    assertNoPendingWorkflowTraceTransaction(context, tracePath);
    result = bindUnderLock();
  } finally {
    releaseTraceLock();
  }
  const { bindings, event } = result;
  output(options, {
    status: "bound",
    trace_path: tracePath,
    policy_source_ref: policySourceRef,
    binding_count: bindings.length,
    event,
  }, [`Bound ${bindings.length} historical evidence references to ${policyName}`]);
}

function evidenceOutsideProject(context, rawPath) {
  const value = String(rawPath || "").trim();
  if (!value) return null;
  const resolved = path.isAbsolute(value) ? path.resolve(value) : path.resolve(context.root, value);
  if (!isInsidePath(context.root, resolved)) return resolved;
  try {
    return isInsidePath(fs.realpathSync.native(context.root), fs.realpathSync.native(resolved)) ? null : resolved;
  } catch {
    return null;
  }
}

/** The project path a test-run evidence file outside the project is copied to. */
function copiedEvidencePath(context, storyId, sourcePath) {
  return path.join(testRunsRoot(context), `${storyId}-${path.basename(sourcePath)}`);
}

function refuseEvidenceOutsideProject(context, storyId, sourcePath) {
  const target = toProjectPath(context, copiedEvidencePath(context, storyId, sourcePath));
  const folder = toProjectPath(context, testRunsRoot(context));
  fail(
    `test record --evidence ${sourcePath} is outside the project root. Copy it into ${folder}/ (for example ${target}) and pass that path, `
    + "or add --copy-evidence to copy and register it there.",
    {
      en: {
        result: "The test run was not recorded because an evidence file is outside the project.",
        impact: "No record was written, and the story history is unchanged.",
        required_decision: "Choose whether the file is copied into the project's test evidence folder.",
        protection_boundary: "No file outside the project was read into a record and nothing was copied.",
        next_action: `Copy the file to ${target}, or rerun test record with --copy-evidence.`,
        details: { evidence: sourcePath, copy_to: target },
      },
      it: {
        result: "L’esecuzione dei test non è stata registrata perché un file di prova è fuori dal progetto.",
        impact: "Nessun record è stato scritto e la cronologia della story resta invariata.",
        required_decision: "Decidi se copiare il file nella cartella delle prove di test del progetto.",
        protection_boundary: "Nessun file esterno al progetto è stato letto in un record e nulla è stato copiato.",
        next_action: `Copia il file in ${target}, oppure rilancia test record con --copy-evidence.`,
        details: { evidence: sourcePath, copy_to: target },
      },
    },
  );
}

export function buildTestRunEvidence(context, options) {
  const storyId = String(options.story || "").trim();
  const evidence = normalizeListOption(options.evidence).map((rawPath) => {
    const outside = evidenceOutsideProject(context, rawPath);
    let evidenceInput = rawPath;
    if (outside) {
      if (options["copy-evidence"] !== true) refuseEvidenceOutsideProject(context, storyId, outside);
      if (!fs.existsSync(outside) || !fs.statSync(outside).isFile()) fail(`Path is not an existing file: ${outside}`);
      const target = copiedEvidencePath(context, storyId, outside);
      if (fs.existsSync(target)) {
        if (hashFile(target) !== hashFile(outside)) {
          fail(`Evidence copy target already holds different content: ${toProjectPath(context, target)}. Rename the source file and retry.`);
        }
      } else {
        copyFileGoverned(outside, target);
      }
      evidenceInput = target;
    }
    const evidencePath = resolveProjectFilePath(context, evidenceInput, { mustExist: true, fileOnly: true });
    assertNotDerivedArtifact(context, evidencePath, "Test run evidence");
    return {
      path: toProjectPath(context, evidencePath),
      size_bytes: fs.statSync(evidencePath).size,
      sha256: hashFile(evidencePath),
    };
  });
  if (evidence.length === 0) {
    fail(
      "test record needs at least one --evidence file holding the output of the run.",
      {
        en: {
          result: "The test run was not recorded because no output file was attached.",
          impact: "No record was written, and the story history is unchanged.",
          required_decision: "Decide which file holds the output a reviewer would read to confirm the result.",
          protection_boundary: "No approval, delivery, release, or wider file access was created.",
          next_action: "Save the test runner output to a file inside the project, then pass it with --evidence.",
          details: {},
        },
        it: {
          result: "L’esecuzione dei test non è stata registrata perché non è stato allegato alcun file di output.",
          impact: "Nessun record è stato scritto e la cronologia della story resta invariata.",
          required_decision: "Decidi quale file contiene l’output che una persona leggerebbe per confermare il risultato.",
          protection_boundary: "Non sono stati creati approvazioni, consegne, rilasci o accessi più ampi ai file.",
          next_action: "Salva l’output dello strumento di test in un file dentro il progetto, poi passalo con --evidence.",
          details: {},
        },
      },
    );
  }
  return evidence;
}

export function buildFeedbackEvidence(context, options) {
  return normalizeListOption(options.evidence).map((rawPath) => {
    const evidencePath = resolveProjectFilePath(context, rawPath, { mustExist: true, fileOnly: true });
    assertNotDerivedArtifact(context, evidencePath, "Feedback evidence");
    return {
      path: toProjectPath(context, evidencePath),
      size_bytes: fs.statSync(evidencePath).size,
      sha256: hashFile(evidencePath),
    };
  });
}

export function proposeOutputTemplate(context, options) {
  ensureInitialized(context);
  const artifactType = normalizeArtifactType(requireOption(options, "type"));
  const id = normalizeId(options.id || `${artifactType}-v1`);
  const delivery = buildOutputDelivery(options);
  const attribution = buildAttribution(context, options, "output.template.propose");
  const content = buildOutputTemplateContent(context, options, artifactType, id);
  return withOutputRegistryLock(context, () => {
  const registry = readOutputRegistry(context, { create: true, options, action: "output.template.propose" });
  if (findOutputTemplate(registry, id) && !options.force) {
    fail(`Output template ${id} already exists. Use --force to replace its proposal metadata.`);
  }

  const templatePath = path.join(outputContractsRoot(context), "templates", `${id}.md`);
  writeTextFile(templatePath, content.text, { force: Boolean(options.force), forceOption: true });

  const relativeTemplatePath = toProjectPath(context, templatePath);
  const templateRecord = {
    id,
    type: artifactType,
    status: "draft",
    path: relativeTemplatePath,
    summary: getOptionString(options, "summary") || null,
    preset: content.preset || null,
    delivery,
    source_paths: content.source_paths,
    proposed_at: now(),
    approved_at: null,
    approved_by: null,
    audit: {
      proposed_by: attribution.actor,
      git: attribution.git,
      run: attribution.run,
    },
  };

  upsertById(registry.templates, templateRecord);
  registry.updated_at = now();
  registry.audit = {
    ...(registry.audit || {}),
    updated_by: attribution.actor,
    git: attribution.git,
    run: attribution.run,
  };
  writeOutputRegistry(context, registry);
  appendTraceEvent(context, null, {
    type: "decision",
    summary: `Proposed output template ${id} for ${artifactType}`,
    action: "output.template.propose",
    actor: attribution.actor,
    evidence: [relativeTemplatePath, toProjectPath(context, outputRegistryPath(context))],
    related: [id, artifactType],
    git: attribution.git,
    run: attribution.run,
  });
  const approvalRequest = buildOutputTemplateApprovalRequest(context, templateRecord);
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
      template_path: templatePath,
      template: templateRecord,
      assistant_message: assistantMessage,
      ...assistantMessagePresentationFields(),
      approval_request: approvalRequest,
    },
    [
      humanGuidanceLocale(options) === "it"
        ? `Proposto il formato di risultato ${id} per ${artifactType}`
        : `Proposed output template ${id} for ${artifactType}`,
      "",
      ...localizedAssistantLines,
    ],
  );
  });
}

export function approveOutputTemplate(context, options) {
  ensureInitialized(context);
  return withOutputRegistryLock(context, () => {
  const id = normalizeId(requireOption(options, "id"));
  const registry = readOutputRegistry(context, { create: true, options, action: "output.template.approve" });
  const template = findOutputTemplate(registry, id);
  if (!template) {
    fail(`Output template ${id} does not exist`);
  }

  const attribution = buildAttribution(context, options, "output.template.approve");
  requireFormalApprovalActor(context, options, attribution, "Approving an output template");

  const decisionId = normalizeId(String(options["decision-id"] || `DEC-output-template-${id}-${uniqueRecordSuffix()}`));
  const templatePath = resolveProjectFilePath(context, template.path, { mustExist: true, fileOnly: true });
  assertNotDerivedArtifact(context, templatePath, "Output template");
  const approvedContentHash = hashFile(templatePath);
  const delivery = effectiveOutputDelivery(template);
  const approvedDeliveryHash = hashApprovalSubject(delivery);
  const approvalEvidence = buildApprovalEvidence(context, options);
  const approvalSummaryOption = getOptionString(options, "summary") || null;
  const approvalSummary = approvalSummaryOption || template.approval_summary || null;
  const approvalSource = normalizeApprovalSource(context, options, attribution, `output template ${id}`, "approved");
  validateApprovalSourceForActor(context, {
    source: approvalSource,
    status: "approved",
    summary: approvalSummaryOption,
    evidence: approvalEvidence,
    actor: attribution.actor,
    label: `output template ${id}`,
  });
  const authorization = approvalSource === "automation"
    ? requireAutomationAuthorization(context, options, attribution.action, { label: `output template ${id}`, subject_id: id, artifact_type: template.type })
    : null;
  const approvalScope = buildApprovalRecordScope(approvalSource, {
    subject_id: id,
    artifact_type: template.type,
    label: `output template ${id}`,
    scope: String(options.scope || "output_template"),
    authorization,
  });
  template.status = "approved";
  template.approved_at = now();
  template.approved_by = attribution.actor;
  template.approval_summary = approvalSummary;
  template.approved_content_hash = approvedContentHash;
  template.approved_delivery_hash = approvedDeliveryHash;
  template.hash_algorithm = "sha256:file:v1";
  template.approval_evidence = approvalEvidence;
  template.approval_source = approvalSource;
  template.authorization_ref = authorization?.id || null;
  template.authorization_use_ref = authorization?.__use_receipt?.path || null;
  template.authorization_action = authorization ? attribution.action : null;
  template.approval_scope = approvalScope;
  template.explicit_user_confirmation = approvalSource === "explicit-user";
  template.provisional = approvalSource === "bootstrap";
  template.audit = {
    ...(template.audit || {}),
    approved_by: attribution.actor,
    git: attribution.git,
    run: attribution.run,
  };

  const decision = {
    id: decisionId,
    type: "template_approved",
    template_id: id,
    artifact_type: template.type,
    summary: template.approval_summary,
    status: "approved",
    evidence: template.approval_evidence,
    approval_source: approvalSource,
    authorization_ref: authorization?.id || null,
    authorization_use_ref: authorization?.__use_receipt?.path || null,
    authorization_action: authorization ? attribution.action : null,
    approval_scope: approvalScope,
    explicit_user_confirmation: approvalSource === "explicit-user",
    provisional: approvalSource === "bootstrap",
    approved_content_hash: approvedContentHash,
    approved_delivery_hash: approvedDeliveryHash,
    delivery,
    hash_algorithm: "sha256:file:v1",
    created_at: now(),
    audit: {
      decided_by: attribution.actor,
      git: attribution.git,
      run: attribution.run,
    },
  };
  upsertById(registry.decisions, decision);
  registry.updated_at = now();
  registry.audit = {
    ...(registry.audit || {}),
    updated_by: attribution.actor,
    git: attribution.git,
    run: attribution.run,
  };
  writeOutputRegistry(context, registry);
  appendTraceEvent(context, null, {
    type: "gate",
    summary: `Approved output template ${id}`,
    action: "output.template.approve",
    actor: attribution.actor,
    evidence: [template.path, toProjectPath(context, outputRegistryPath(context))],
    related: [id, decisionId],
    git: attribution.git,
    run: attribution.run,
  });

  output(options, { status: "approved", template, decision }, [`Approved output template ${id}`]);
  });
}

export function resolveOutput(context, options) {
  ensureInitialized(context);
  const storyId = normalizeId(requireOption(options, "story"));
  const artifactType = normalizeArtifactType(requireOption(options, "type"));
  const explicitRequirements = normalizeListOption(options.requirement);
  const cacheStatus = getCacheStatus(context);
  const canonicalResolution = buildOutputResolution(context, storyId, artifactType, {
    requirements: explicitRequirements,
    cache_used: false,
  });
  let resolution = canonicalResolution;

  if (explicitRequirements.length === 0 && cacheStatus.valid && cacheStatus.cache?.output_resolutions) {
    const cachedResolution = cacheStatus.cache.output_resolutions[outputResolutionKey(storyId, artifactType)] || null;
    if (cachedResolution) {
      if (outputResolutionFingerprint(cachedResolution) !== outputResolutionFingerprint(canonicalResolution)) {
        fail("Local cache output resolution differs from canonical KB files. Run 'agentic-sdlc cache rebuild'.");
      }
      resolution = { ...canonicalResolution, cache_used: true };
    }
  }

  const decisionRequired = ["template_required", "reuse_delta"].includes(resolution.recommendation);
  const payload = {
    ...resolution,
    status: decisionRequired ? "needs_user_input" : "resolved",
    decision_required: decisionRequired,
    human_guidance: outputResolutionGuidance(resolution, options),
  };
  output(
    options,
    payload,
    humanGuidanceLines(payload.human_guidance, [
      `Output resolution for ${storyId}/${artifactType}: ${resolution.recommendation}`,
      resolution.template_id ? `Template: ${resolution.template_id}` : "Template: missing approved template",
      resolution.delivery ? `Canonical delivery: ${formatOutputDeliveryForHuman(resolution.delivery)}` : null,
      resolution.base_artifact ? `Base artifact: ${resolution.base_artifact}` : "Base artifact: none",
      resolution.next_action,
    ].filter(Boolean), options),
  );
}

/**
 * Governed replacement of an earlier output link of the same story and type,
 * for example the evidence linked by a cancelled delivery. The earlier link
 * stays in the registry, marked superseded, so the history remains auditable.
 */
function resolveSupersededOutputLink(registry, options, { id, storyId, artifactType, actor }) {
  const rawId = getOptionString(options, "supersedes");
  if (!rawId) {
    return null;
  }
  const supersededId = normalizeId(rawId);
  const target = (registry.links || []).find((link) => link.id === supersededId);
  if (!target) {
    fail(`Output link ${supersededId} does not exist; check 'output status --story ${storyId}'.`);
  }
  if (supersededId === id) {
    fail(`Output link ${id} cannot supersede itself; re-run 'output link' without --supersedes to refresh it in place.`);
  }
  if (target.story_id !== storyId || target.artifact_type !== artifactType) {
    fail(
      `Output link ${supersededId} belongs to ${target.story_id}/${target.artifact_type}; `
      + `--supersedes can replace only a link of ${storyId}/${artifactType}.`,
    );
  }
  if (target.superseded_by) {
    fail(`Output link ${supersededId} is already superseded by ${target.superseded_by}.`);
  }
  if (!getOptionString(options, "rationale")) {
    fail("--supersedes requires --rationale explaining why the earlier output link is replaced.");
  }
  if (!options[VERIFIED_DELEGATION_USE] && !["human", "ci"].includes(actor?.type)) {
    fail("Superseding an output link requires --actor-type human or an approved CI actor.");
  }
  return target;
}

export function linkOutputArtifact(context, options) {
  ensureInitialized(context);
  const storyId = normalizeId(requireOption(options, "story"));
  if (!readStory(context, storyId)) {
    fail(`Story ${storyId} does not exist`);
  }
  const releaseTaskStartBoundaryLock = acquireFileLock(
    path.join(context.sdlcRoot, "stories", storyId, "task-start-boundary.lock"),
  );
  let releaseLifecycleLock = () => {};
  try {
    releaseLifecycleLock = acquireFileLock(
      storyLifecycleCertificationLockPath(context, storyId),
    );
    const story = readStory(context, storyId);
    if (!story) {
      fail(`Story ${storyId} does not exist`);
    }
    assertStoryOpenForWork(context, storyId, "output link");
    return withOutputRegistryLock(context, () => {
  const registryPath = outputRegistryPath(context);
  const priorRegistrySnapshot = pathEntryExistsNoFollow(registryPath)
    ? readStableRegularFileBuffer(registryPath, context.root)
    : null;
  const finalReceiptExists = fs.existsSync(
    workflowFinalGateReceiptPath(context, storyId),
  );
  const lifecycle = effectiveStoryLifecycleProjection(context, story);
  if (lifecycle.terminal && CERTIFIED_TERMINAL_LIFECYCLE_SOURCES.includes(lifecycle.source)) {
    fail(
      `Story ${storyId} already has a valid terminal lifecycle certification. `
      + "Create a new governed story for later output changes instead of changing the certified run.",
    );
  }
  const artifactType = normalizeArtifactType(requireOption(options, "type"));
  const mode = normalizeOutputMode(requireOption(options, "mode"));
  const templateId = normalizeId(requireOption(options, "template"));
  const linkContract = validateApprovedStoryContractForPhaseOutput(
    context,
    story,
    "output.link",
    [{ artifact_type: artifactType, template_id: templateId, mode }],
    options,
  );
  const registry = readOutputRegistry(context, { create: true, options, action: "output.link" });
  const template = findOutputTemplate(registry, templateId);
  if (!template) {
    fail(`Output template ${templateId} does not exist`);
  }
  if (template.type !== artifactType) {
    fail(`Output template ${templateId} is for '${template.type}', not '${artifactType}'`);
  }
  if (template.status !== "approved") {
    fail(`Output template ${templateId} is '${template.status}'. Approve it before linking output artifacts.`);
  }

  const delivery = effectiveOutputDelivery(template);

  const artifactPath = resolveProjectFilePath(context, requireOption(options, "artifact"), {
    mustExist: true,
    fileOnly: true,
  });
  assertNotDerivedArtifact(context, artifactPath, "Output artifact");
  validateArtifactDeliveryPath(artifactPath, delivery, `Output template ${templateId}`);
  const relativeArtifactPath = toProjectPath(context, artifactPath);
  const id = normalizeId(
    options.id || `OUT-${storyId}-${artifactType}-${shortHash(`${relativeArtifactPath}:${mode}`)}`,
  );
  const existingStoryLink = (registry.links || [])
    .find((link) => link.story_id === storyId && link.id === id);
  if (
    finalReceiptExists
    && (
      !existingStoryLink
      || existingStoryLink.artifact_type !== artifactType
      || existingStoryLink.artifact_path !== relativeArtifactPath
      || existingStoryLink.template_id !== templateId
      || existingStoryLink.mode !== mode
    )
  ) {
    fail(
      `Story ${storyId} already has a terminal lifecycle receipt. `
      + "An invalidated receipt permits only an in-place refresh of the exact existing output link; "
      + "create a new governed story for replacement or additional outputs.",
    );
  }
  let verificationReceipt = verifyOutputArtifact(context, artifactPath, delivery, {
    evidence: outputRenderEvidenceOptions(options),
    requireVisualEvidence: true,
    receiptFile: getOptionString(options, "receipt-file"),
    id: `VERIFY-${id}-${hashFile(artifactPath).slice(0, 8)}`,
    subjectRef: {
      kind: "output_link",
      id,
      hash: shortHashFull(stableJson({
        story_id: storyId,
        artifact_type: artifactType,
        artifact_path: relativeArtifactPath,
        template_id: templateId,
        mode,
      })),
    },
  });
  const verificationFile = verificationReceiptPath(context, verificationReceipt.id);
  let verificationReceiptRef = {
    id: verificationReceipt.id,
    path: toProjectPath(context, verificationFile),
    hash: verificationReceipt.receipt_hash,
  };
  if (fs.existsSync(verificationFile)) {
    const persistedReceipt = readProjectJson(context, verificationFile);
    const persistedIntegrity = validateVerificationReceiptIntegrity(persistedReceipt);
    if (
      !persistedIntegrity.valid ||
      verificationArtifactSha256(persistedReceipt) !== hashFile(artifactPath) ||
      persistedReceipt.subject_ref?.id !== verificationReceipt.subject_ref?.id
    ) {
      fail(`Verification receipt ${verificationReceiptRef.path} already exists but is not valid for this exact output link and artifact.`);
    }
    verificationReceipt = persistedReceipt;
    verificationReceiptRef = {
      id: persistedReceipt.id,
      path: toProjectPath(context, verificationFile),
      hash: persistedReceipt.receipt_hash,
    };
  }

  const baseArtifact = options["base-artifact"]
    ? resolveProjectFilePath(context, options["base-artifact"], { mustExist: true, fileOnly: true })
    : null;
  if (mode === "delta" && !baseArtifact) {
    fail("Mode 'delta' requires --base-artifact.");
  }
  if (baseArtifact) {
    assertNotDerivedArtifact(context, baseArtifact, "Base artifact");
  }

  const requirements = normalizeListOption(options.requirement);
  const storyRequirements = Array.isArray(story.links?.requirements) ? story.links.requirements : [];
  const linkedRequirements = requirements.length > 0 ? requirements : storyRequirements;
  if (story.proposal_ref && linkedRequirements.length === 0) {
    fail(`Proposal-bound story ${storyId} must link its canonical requirement before an output can be accepted.`);
  }
  for (const requirementId of linkedRequirements) {
    const requirement = readRequirement(context, requirementId, { missingOk: true });
    if (!requirement) {
      fail(`Output link references missing requirement ${requirementId}. Create or restore the canonical requirement before linking the artifact.`);
    }
    if (
      story.proposal_ref &&
      (requirement.proposal_ref?.id !== story.proposal_ref.id || requirement.proposal_ref?.hash !== story.proposal_ref.hash)
    ) {
      fail(`Requirement ${requirementId} is not bound to the same immutable proposal as story ${storyId}.`);
    }
  }
  const relativeBaseArtifact = baseArtifact ? toProjectPath(context, baseArtifact) : null;
  const delegated = applyApprovalDelegation(context, options, "output.link", { story: storyId });
  const attribution = buildAttribution(context, options, "output.link");
  const decisionId = getOptionString(options, "decision-id");
  const existingDecision = decisionId
    ? (registry.decisions || []).find((decision) => decision.id === normalizeId(decisionId))
    : null;
  if (existingDecision && !hasApprovedOutputDecision(registry.decisions || [], decisionId)) {
    fail(`Decision ${decisionId} already exists but is not an approved output override decision.`);
  }
  if (decisionId && !hasApprovedOutputDecision(registry.decisions || [], decisionId)) {
    if (!delegated && !["human", "ci"].includes(attribution.actor.type)) {
      fail("Creating an output override decision requires --actor-type human or an approved CI actor.");
    }
    const decisionEvidence = buildApprovalEvidence(context, options);
    const decisionSummary = getOptionString(options, "rationale");
    if (!decisionSummary && decisionEvidence.length === 0) {
      fail("Creating an output override decision requires --rationale or --approval-evidence describing the approved exception.");
    }
    const approvalSource = normalizeApprovalSource(context, options, attribution, `output override ${decisionId}`, "approved");
    validateApprovalSourceForActor(context, {
      source: approvalSource,
      status: "approved",
      summary: decisionSummary,
      evidence: decisionEvidence,
      actor: attribution.actor,
      label: `output override ${decisionId}`,
      delegated,
    });
    const authorization = approvalSource === "automation"
      ? requireAutomationAuthorization(context, options, attribution.action, { label: `output override ${decisionId}`, subject_id: normalizeId(decisionId), artifact_type: artifactType })
      : null;
    const decisionSubject = buildOutputLinkDecisionSubject({
      story_id: storyId,
      artifact_type: artifactType,
      artifact_path: relativeArtifactPath,
      template_id: templateId,
      mode,
      base_artifact: relativeBaseArtifact,
      requirements: linkedRequirements,
      rationale: getOptionString(options, "rationale") || null,
    });
    const decision = {
      id: normalizeId(decisionId),
      type: "output_link_override",
      story_id: storyId,
      artifact_type: artifactType,
      status: "approved",
      summary: decisionSummary,
      subject: decisionSubject,
      evidence: decisionEvidence,
      approval_source: approvalSource,
      authorization_ref: authorization?.id || null,
      authorization_use_ref: authorization?.__use_receipt?.path || null,
      authorization_action: authorization ? attribution.action : null,
      explicit_user_confirmation: approvalSource === "explicit-user",
      ...(delegated ? delegatedRecordFields(delegated) : {}),
      provisional: approvalSource === "bootstrap",
      approved_content_hash: hashApprovalSubject(decisionSubject),
      hash_algorithm: "sha256:stable-json:v1",
      created_at: now(),
      audit: {
        decided_by: attribution.actor,
        git: attribution.git,
        run: attribution.run,
      },
    };
    upsertById(registry.decisions, decision);
  }
  const existing = registry.links.find((link) => link.id === id);
  const supersededLink = resolveSupersededOutputLink(registry, options, {
    id,
    storyId,
    artifactType,
    actor: attribution.actor,
  });
  const link = {
    id,
    story_id: storyId,
    artifact_type: artifactType,
    artifact_path: relativeArtifactPath,
    template_id: templateId,
    mode,
    base_artifact: relativeBaseArtifact,
    requirements: linkedRequirements,
    decision_id: decisionId ? normalizeId(decisionId) : null,
    rationale: getOptionString(options, "rationale") || null,
    contract_id: linkContract?.id || null,
    supersedes: supersededLink?.id || existing?.supersedes || null,
    delivery_format: delivery.format,
    delivery_extension: delivery.extension,
    media_type: delivery.media_type,
    generator: delivery.generator,
    delivery_mode: delivery.mode,
    verification_receipt: verificationReceipt,
    verification_receipt_ref: verificationReceiptRef,
    source_paths: [
      relativeArtifactPath,
      relativeBaseArtifact,
      template.path,
      verificationReceiptRef.path,
      ...verificationReceipt.evidence.map((item) => item.path),
    ].filter(Boolean),
    fingerprints: {
      artifact_sha256: hashFile(artifactPath),
      base_artifact_sha256: baseArtifact ? hashFile(baseArtifact) : null,
      template_sha256: template.path
        ? hashFile(resolveProjectFilePath(context, template.path, { mustExist: true, fileOnly: true }))
        : null,
      hash_algorithm: "sha256:file:v1",
    },
    created_at: existing?.created_at || now(),
    updated_at: now(),
    audit: {
      ...(existing?.audit || {}),
      linked_by: attribution.actor,
      git: attribution.git,
      run: attribution.run,
    },
  };

  const duplicateHints = findRelatedOutputLinks(registry, link)
    .filter((related) => related.id !== id && isActiveOutputLink(related) && related.id !== supersededLink?.id);
  if (mode === "new" && duplicateHints.length > 0 && !outputLinkHasMatchingApprovedDecision(registry.decisions || [], link)) {
    const related = duplicateHints.map((item) => `${item.story_id}:${item.artifact_path}`).join(", ");
    const requirementFlags = (linkedRequirements || []).map((requirement) => ` --requirement ${requirement}`).join("");
    fail([
      `Output ${storyId}/${artifactType} duplicates requirements already covered by ${related}.`,
      `Options: (1) --mode delta with --base-artifact <path of the existing output> to record only the change; (2) --mode reuse to reuse the existing output; (3) keep --mode new and record an approved exception in this same output link call.`,
      `To record the exception, add a new --decision-id, --rationale <why a separate artifact is needed> (or --approval-evidence <path>), --actor-type human and --approval-source explicit-user with --summary <text>.`,
      `Example: agentic-sdlc output link --story ${storyId} --type ${artifactType} --artifact ${relativeArtifactPath} --template ${templateId} --mode new${requirementFlags} --decision-id DEC-output-override-001 --rationale "<why a separate artifact is needed>" --actor-type human --approval-source explicit-user --summary "<approval summary>"`,
      ...duplicateHints.filter((item) => item.story_id === storyId).map((item) =>
        `To replace this story's earlier link instead, add --supersedes ${item.id} --rationale "<why it is replaced>" --actor-type human.`),
    ].join("\n"));
  }

  if (story.proposal_ref) {
    const proposal = readAssessmentProposal(context, story.proposal_ref.id);
    if (proposal.proposal_hash !== story.proposal_ref.hash) {
      fail(`Story ${storyId} is bound to a stale assessment proposal hash.`);
    }
    const authorizationId = getOptionString(options, "authorization");
    if (!authorizationId) {
      fail([
        `Output link ${id} is part of proposal ${proposal.id} and requires --authorization <id>.`,
        "What I need: the content authorization created when you approved checkpoint 2.",
        "Why: linking the canonical artifact is a write from the approved tranche and must leave a historical authorization-use receipt.",
        `Example: agentic-sdlc output link --story ${storyId} --type ${artifactType} --artifact ${relativeArtifactPath} --template ${templateId} --mode ${mode} --authorization AUTH-${proposal.id}-${proposal.proposal_hash.slice(0, 8)}.`,
        "Effect: only this exact proposal/story/artifact-type link is consumed; no additional scope or budget is granted.",
      ].join("\n"));
    }
    const authorization = readAuthorization(context, normalizeId(authorizationId));
    const proposalRef = {
      id: proposal.id,
      path: toProjectPath(context, assessmentProposalPath(context, proposal.id)),
      hash: proposal.proposal_hash,
    };
    const authorizationSettings = {
      proposal_ref: proposalRef,
      subject_id: storyId,
      artifact_types: [artifactType],
    };
    const authorizationErrors = authorizationUseErrors(authorization, "output.link", authorizationSettings);
    if (authorizationErrors.length > 0) {
      fail(authorizationErrors[0]);
    }
    const authorizationUse = recordOrReuseAuthorizationUse(
      context,
      authorization,
      "output.link",
      authorizationSettings,
    );
    link.authorization_ref = authorization.id;
    link.authorization_use_ref = authorizationUse.path;
    link.authorization_action = "output.link";
    link.source_paths = Array.from(new Set([...link.source_paths, authorizationUse.path]));
  }
  const checkpointPolicy = storyActionCheckpointPolicy(
    context,
    storyId,
    "output.link",
  );
  const checkpoint = story.proposal_ref && link.authorization_ref
    ? (
        checkpointPolicy.required
          ? {
              authorization_ref: link.authorization_ref,
              authorization_use_ref: link.authorization_use_ref,
              authorization_action: link.authorization_action,
              checkpoint_profile_ref: checkpointPolicy.profile_ref,
            }
          : null
      )
    : consumeStoryActionCheckpoint(
        context,
        storyId,
        "output.link",
        options,
        { artifact_types: [artifactType] },
      );
  if (checkpoint) {
    link.authorization_ref = checkpoint.authorization_ref;
    link.authorization_use_ref = checkpoint.authorization_use_ref;
    link.authorization_action = checkpoint.authorization_action;
    link.checkpoint_profile_ref = checkpoint.checkpoint_profile_ref;
    link.source_paths = Array.from(new Set([
      ...link.source_paths,
      checkpoint.authorization_use_ref,
      checkpoint.checkpoint_profile_ref?.path,
    ].filter(Boolean)));
  }

  const priorVerificationSnapshot = pathEntryExistsNoFollow(verificationFile)
    ? readStableRegularFileBuffer(verificationFile, context.root)
    : null;
  const verificationDirectory = path.dirname(verificationFile);
  const verificationDirectoryExisted = pathEntryExistsNoFollow(verificationDirectory);
  let verificationWritten = false;
  let registryWritten = false;
  let traceMutation;
  let traceEvent;
  try {
    ensureDir(verificationDirectory);
    if (pathEntryExistsNoFollow(verificationFile)) {
      const existingReceipt = readProjectJson(context, verificationFile);
      if (existingReceipt.receipt_hash !== verificationReceipt.receipt_hash) {
        fail(`Verification receipt ${verificationReceiptRef.path} already exists with different immutable content.`);
      }
    } else {
      writeJsonFile(verificationFile, verificationReceipt);
      verificationWritten = true;
    }

    if (supersededLink) {
      upsertById(registry.links, {
        ...supersededLink,
        superseded_by: id,
        superseded_at: now(),
        superseded_reason: getOptionString(options, "rationale"),
        audit: {
          ...(supersededLink.audit || {}),
          superseded_by_actor: attribution.actor,
        },
      });
    }
    upsertById(registry.links, link);
    registry.updated_at = now();
    registry.audit = {
      ...(registry.audit || {}),
      updated_by: attribution.actor,
      git: attribution.git,
      run: attribution.run,
    };
    writeOutputRegistry(context, registry);
    registryWritten = true;
    traceMutation = prepareGovernedTraceMutation(context, storyId, {
      type: "decision",
      summary: supersededLink
        ? `Linked ${artifactType} output ${relativeArtifactPath} as ${mode}, superseding ${supersededLink.id}`
        : `Linked ${artifactType} output ${relativeArtifactPath} as ${mode}`,
      action: "output.link",
      actor: attribution.actor,
      evidence: [
        relativeArtifactPath,
        toProjectPath(context, registryPath),
        link.authorization_use_ref,
        link.checkpoint_profile_ref?.path,
      ].filter(Boolean),
      related: [storyId, artifactType, templateId, id, supersededLink?.id].filter(Boolean),
      git: attribution.git,
      run: attribution.run,
    });
    try {
      traceEvent = traceMutation.commit();
    } catch (error) {
      traceEvent = traceMutation.recoverCommitted();
      if (!traceEvent) throw error;
    }
  } catch (error) {
    if (!traceEvent) {
      const rollbackFailures = [];
      const restore = (label, filePath, snapshot, written) => {
        if (!written) return;
        try {
          if (snapshot) {
            writeTextFile(filePath, snapshot.content.toString("utf8"), { force: true });
          } else if (pathEntryExistsNoFollow(filePath)) {
            removePathGoverned(filePath, { force: true });
          }
        } catch (rollbackError) {
          rollbackFailures.push(`${label}: ${rollbackError.message}`);
        }
      };
      restore("output registry", registryPath, priorRegistrySnapshot, registryWritten);
      restore(
        "output verification receipt",
        verificationFile,
        priorVerificationSnapshot,
        verificationWritten,
      );
      if (
        !verificationDirectoryExisted
        && pathEntryExistsNoFollow(verificationDirectory)
        && fs.readdirSync(verificationDirectory).length === 0
      ) {
        try {
          removeEmptyDirectoryGoverned(verificationDirectory);
        } catch (rollbackError) {
          rollbackFailures.push(`output verification directory: ${rollbackError.message}`);
        }
      }
      if (rollbackFailures.length > 0) {
        fail(
          `Output link ${id} transaction could not restore exact prior state `
          + `(${rollbackFailures.join("; ")}). Original failure: ${error.message}`,
        );
      }
    }
    throw error;
  } finally {
    traceMutation?.release();
  }

  output(
    options,
    { status: "linked", link, related_outputs: duplicateHints, trace_event: traceEvent },
    [
      `Linked ${artifactType} output for ${storyId} as ${mode}`,
      duplicateHints.length > 0
        ? `Related outputs found: ${duplicateHints.map((item) => `${item.story_id}:${item.artifact_path}`).join(", ")}`
        : "No related outputs found",
    ],
  );
    });
  } finally {
    releaseLifecycleLock();
    releaseTaskStartBoundaryLock();
  }
}

export function showOutputStatus(context, options) {
  ensureInitialized(context);
  const storyId = normalizeId(requireOption(options, "story"));
  const story = readStory(context, storyId);
  if (!story) {
    fail(`Story ${storyId} does not exist`);
  }
  const registry = readOutputRegistry(context, { missingOk: true });
  const types = outputStatusTypes(context, registry, { ...options, story });
  const links = registry ? registry.links.filter((link) => link.story_id === storyId) : [];
  const resolutions = types.map((type) => buildOutputResolution(context, storyId, type, { registry }));

  output(
    options,
    { story_id: storyId, links, resolutions },
    [
      `Output status for ${storyId}`,
      ...links.map((link) => `${link.artifact_type}: ${link.mode} ${link.artifact_path} (${link.template_id})`),
      ...resolutions.map((resolution) => `${resolution.artifact_type}: ${resolution.recommendation}`),
    ],
  );
}

export function collectOutputQueryRecords(context, registry = null) {
  const registrySource = fs.existsSync(outputRegistryPath(context)) ? [{ path: toProjectPath(context, outputRegistryPath(context)), line: 1 }] : [];
  const templateRecords = (registry?.templates || []).map((template) => ({
    kind: "outputs",
    id: template.id,
    summary: `Output template ${template.id} for ${template.type}`,
    created_at: template.proposed_at || template.created_at || null,
    updated_at: template.approved_at || template.proposed_at || null,
    actor: template.audit?.approved_by || template.audit?.proposed_by || template.approved_by || null,
    requested_by: null,
    authorized_by: null,
    request: null,
    action: template.status === "approved" ? "output.template.approve" : "output.template.propose",
    event_type: "decision",
    story_id: null,
    artifact_type: template.type || null,
    requirements: [],
    phase: null,
    status: template.status || null,
    text: stableJson(template),
    sources: registrySource,
    raw: template,
  }));
  const linkRecords = (registry?.links || []).map((link) => ({
    kind: "outputs",
    id: link.id,
    summary: `${link.artifact_type} output ${link.artifact_path} linked as ${link.mode}`,
    created_at: link.created_at || null,
    updated_at: link.updated_at || link.created_at || null,
    actor: link.audit?.linked_by || null,
    requested_by: null,
    authorized_by: null,
    request: null,
    action: "output.link",
    event_type: "decision",
    story_id: link.story_id || null,
    artifact_type: link.artifact_type || null,
    requirements: Array.isArray(link.requirements) ? link.requirements : [],
    phase: null,
    status: link.mode || null,
    text: stableJson(link),
    sources: registrySource,
    raw: link,
  }));
  return [...templateRecords, ...linkRecords];
}

export function buildOutputTemplateContent(context, options, artifactType, id) {
  const from = getOptionString(options, "from");
  const body = getOptionString(options, "body");
  const preset = getOptionString(options, "preset");
  const contentSources = [from, body, preset].filter(Boolean);
  if (contentSources.length > 1) {
    fail("Use only one of --from, --body, or --preset when proposing an output template.");
  }
  if (from) {
    const sourcePath = resolveProjectFilePath(context, from, { mustExist: true, fileOnly: true });
    assertNotDerivedArtifact(context, sourcePath, "Template source");
    return {
      text: fs.readFileSync(sourcePath, "utf8"),
      source_paths: [toProjectPath(context, sourcePath)],
      preset: null,
    };
  }

  if (body) {
    return {
      text: `${body.trim()}\n`,
      source_paths: [],
      preset: null,
    };
  }

  if (preset) {
    const normalizedPreset = String(preset).trim().toLowerCase();
    if (normalizedPreset !== "technical-assessment") {
      fail(`Unknown output template preset '${preset}'. Valid presets: technical-assessment`);
    }
    return {
      text: readTemplateFile(context, "technical-assessment.md"),
      source_paths: [],
      preset: normalizedPreset,
    };
  }

  const summary = getOptionString(options, "summary") || `Project-approved structure for ${artifactType} outputs.`;
  return {
    text: [
      `# ${id}`,
      "",
      "## Purpose",
      summary,
      "",
      "## Context",
      "- Linked story",
      "- Linked requirement or source artifact",
      "- Reused base artifact when this output is a delta",
      "",
      "## Output",
      "- Canonical content agreed with the user",
      "- Explicit delta from the base artifact when applicable",
      "",
      "## Validation",
      "- Acceptance criteria or gate evidence",
      "- Open questions and follow-up decisions",
      "",
    ].join("\n"),
    source_paths: [],
    preset: null,
  };
}

export function buildOutputResolution(context, storyId, artifactType, options = {}) {
  const story = options.story || readStory(context, storyId);
  if (!story) {
    fail(`Story ${storyId} does not exist`);
  }
  const registry = options.registry || readOutputRegistry(context, { missingOk: true });
  const registryIndex = options.registry_index || null;
  const storyRequirements = Array.isArray(story.links?.requirements) ? story.links.requirements : [];
  const requirements = options.requirements?.length > 0 ? options.requirements : storyRequirements;
  const templates = registryIndex
    ? registryIndex.templates_by_type.get(artifactType) || []
    : registry ? registry.templates.filter((template) => template.type === artifactType) : [];
  const approvedTemplates = templates.filter((template) => template.status === "approved");
  const existingLinks = registryIndex
    ? registryIndex.links_by_story_and_type.get(outputRegistryPairKey(storyId, artifactType)) || []
    : registry
      ? registry.links.filter((link) => link.story_id === storyId && link.artifact_type === artifactType)
      : [];
  const relatedLinks = registryIndex
    ? relatedOutputLinksFromIndex(registryIndex, storyId, artifactType, requirements)
    : registry
      ? registry.links.filter(
          (link) =>
            link.story_id !== storyId &&
            link.artifact_type === artifactType &&
            overlaps(link.requirements || [], requirements),
        )
      : [];
  const preferredRelated = relatedLinks[0] || null;
  const preferredTemplate = approvedTemplates.find((template) => template.id === preferredRelated?.template_id) || approvedTemplates[0] || null;
  const delivery = preferredTemplate ? effectiveOutputDelivery(preferredTemplate) : null;
  let recommendation = "template_required";
  let nextAction = `Propose and approve a template: agentic-sdlc output template propose --type ${artifactType}`;
  let baseArtifact = null;

  if (existingLinks.length > 0) {
    recommendation = "linked";
    nextAction = "No new artifact is required unless the user agrees on a delta or structure change.";
    baseArtifact = existingLinks[0].base_artifact || existingLinks[0].artifact_path || null;
  } else if (preferredRelated) {
    recommendation = "reuse_delta";
    baseArtifact = preferredRelated.artifact_path;
    nextAction = [
      `Reuse ${preferredRelated.artifact_path} and create only a delta if needed.`,
      `Link it with: agentic-sdlc output link --story ${storyId} --type ${artifactType}`,
      `--artifact <delta-path> --template ${preferredRelated.template_id} --mode delta --base-artifact ${preferredRelated.artifact_path}`,
    ].join(" ");
  } else if (preferredTemplate) {
    recommendation = "new";
    nextAction = [
      "No related approved artifact was found.",
      `Create the ${delivery.label} artifact (${delivery.extension}) with template ${preferredTemplate.id}${delivery.generator ? ` using ${delivery.generator}` : ""}, then link it with mode new.`,
    ].join(" ");
  }

  return {
    story_id: storyId,
    artifact_type: artifactType,
    requirements,
    recommendation,
    template_id: preferredTemplate?.id || existingLinks[0]?.template_id || null,
    delivery,
    approved_templates: approvedTemplates.map((template) => template.id),
    existing_links: existingLinks,
    related_links: relatedLinks,
    base_artifact: baseArtifact,
    cache_used: Boolean(options.cache_used),
    next_action: nextAction,
  };
}

export function outputContractsRoot(context) {
  return path.join(context.sdlcRoot, "output-contracts");
}

export function outputRegistryPath(context) {
  return path.join(outputContractsRoot(context), "registry.json");
}

export function readOutputRegistry(context, options = {}) {
  const registryPath = outputRegistryPath(context);
  if (!fs.existsSync(registryPath)) {
    if (options.create) {
      return initializeOutputContracts(context, {
        force: false,
        attribution: buildAttribution(context, options.options || {}, options.action || "output.registry.init"),
      });
    }
    if (options.missingOk) {
      return null;
    }
    fail("Output registry does not exist. Run 'agentic-sdlc init' or create it with output template propose.");
  }
  const registry = readProjectJson(context, registryPath);
  registry.templates = Array.isArray(registry.templates) ? registry.templates : [];
  registry.links = Array.isArray(registry.links) ? registry.links : [];
  registry.decisions = Array.isArray(registry.decisions) ? registry.decisions : [];
  return registry;
}

export function writeOutputRegistry(context, registry) {
  writeJsonFile(outputRegistryPath(context), registry, { force: true });
}

export function normalizeOutputMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!OUTPUT_LINK_MODES.has(normalized)) {
    fail(`Invalid output mode '${value}'. Valid modes: ${Array.from(OUTPUT_LINK_MODES).join(", ")}`);
  }
  return normalized;
}

export function normalizeOutputExtension(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const extension = String(value).trim().toLowerCase();
  if (!/^\.[a-z0-9][a-z0-9._-]*$/.test(extension)) {
    fail(`Invalid output extension '${value}'. Use a value such as .md, .xlsx, or .drawio.`);
  }
  return extension;
}

export function verifyOutputArtifact(context, artifactPath, delivery, options = {}) {
  const stat = fs.statSync(artifactPath);
  if (!stat.isFile() || stat.size === 0) {
    fail(`Output artifact ${path.basename(artifactPath)} is empty or is not a file.`);
  }
  const containerChecks = [`non-empty file (${stat.size} bytes)`, `extension ${delivery.extension}`];
  const contentChecks = [];
  let verifier = "file-structure-v1";

  if (["docx", "xlsx", "pptx"].includes(delivery.format)) {
    verifier = "ooxml-content-v2";
    const requiredEntries = {
      docx: ["[Content_Types].xml", "word/document.xml"],
      xlsx: ["[Content_Types].xml", "xl/workbook.xml"],
      pptx: ["[Content_Types].xml", "ppt/presentation.xml"],
    }[delivery.format];
    const entries = inspectZipContainer(artifactPath, requiredEntries);
    containerChecks.push(`valid OOXML ZIP container with ${entries.size} entries`);
    containerChecks.push(...requiredEntries.map((entry) => `contains ${entry}`));
    const rootEntry = requiredEntries[1];
    const xml = readZipEntry(artifactPath, entries.get(rootEntry)).toString("utf8");
    const rootPatterns = {
      docx: /<(?:\w+:)?document\b/i,
      xlsx: /<(?:\w+:)?workbook\b/i,
      pptx: /<(?:\w+:)?presentation\b/i,
    };
    if (!rootPatterns[delivery.format].test(xml)) {
      fail(`${delivery.label} artifact has ${rootEntry}, but it does not contain the expected XML root.`);
    }
    containerChecks.push(`valid ${rootEntry} root`);
    contentChecks.push(...verifyOoxmlSemanticContent(artifactPath, entries, delivery.format, xml));
  } else if (delivery.format === "pdf") {
    verifier = "pdf-content-v2";
    const bytes = fs.readFileSync(artifactPath);
    const pdfText = bytes.toString("latin1");
    if (!bytes.subarray(0, 8).toString("latin1").startsWith("%PDF-")) {
      fail("PDF artifact is missing a valid %PDF header.");
    }
    if (!bytes.subarray(Math.max(0, bytes.length - 2048)).toString("latin1").includes("%%EOF")) {
      fail("PDF artifact is missing its %%EOF marker.");
    }
    if (!/startxref\s+\d+\s+%%EOF\s*$/s.test(pdfText.slice(-4096))) {
      fail("PDF artifact is missing a valid startxref/EOF trailer.");
    }
    if (!/\/Type\s*\/Pages?\b/.test(pdfText)) {
      fail("PDF artifact has no page tree or page object, so it cannot be content-verified.");
    }
    containerChecks.push("valid PDF header, page objects, startxref, and EOF marker");
    contentChecks.push("contains at least one PDF page object");
  } else if (delivery.format === "json") {
    verifier = "json-parse-v1";
    try {
      const parsed = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
      if (parsed === null || (Array.isArray(parsed) && parsed.length === 0) || (!Array.isArray(parsed) && typeof parsed === "object" && Object.keys(parsed).length === 0)) {
        fail("JSON output is structurally valid but contains no content.");
      }
    } catch (error) {
      if (error instanceof UserError) {
        throw error;
      }
      fail(`JSON output is not valid: ${error.message}`);
    }
    containerChecks.push("valid JSON syntax");
    contentChecks.push("non-empty JSON value");
  } else if (delivery.format === "html") {
    verifier = "html-structure-v1";
    const html = fs.readFileSync(artifactPath, "utf8");
    if (!/<(?:!doctype\s+html|html|body|main)\b/i.test(html)) {
      fail("HTML output does not contain an HTML document structure.");
    }
    const visibleText = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (visibleText.length < 20) {
      fail("HTML output has document markup but no meaningful visible content.");
    }
    containerChecks.push("recognizable HTML document structure");
    contentChecks.push("meaningful visible HTML text");
  } else if (delivery.format === "csv") {
    verifier = "csv-structure-v1";
    const csv = fs.readFileSync(artifactPath, "utf8");
    const rows = csv.split(/\r?\n/).filter((row) => row.trim());
    if (csv.includes("\u0000") || !/[;,\t]/.test(rows[0] || "")) {
      fail("CSV output does not contain a valid text header with a delimiter.");
    }
    if (rows.length < 2) {
      fail("CSV output has a header but no content row.");
    }
    containerChecks.push("text CSV header with delimiter");
    contentChecks.push(`${rows.length - 1} data row(s)`);
  } else if (["markdown", "custom"].includes(delivery.format)) {
    const bytes = fs.readFileSync(artifactPath);
    if (bytes.includes(0)) {
      fail(`${delivery.label} output contains binary NUL bytes.`);
    }
    const text = bytes.toString("utf8").trim();
    if (text.length < 20) {
      fail(`${delivery.label} output is structurally readable but has too little content to verify.`);
    }
    containerChecks.push("non-binary text content");
    contentChecks.push("non-empty meaningful text content");
  }

  const evidence = normalizeListValue(options.evidence, []).map((rawPath) => {
    const evidencePath = resolveProjectFilePath(context, rawPath, { mustExist: true, fileOnly: true });
    assertNotDerivedArtifact(context, evidencePath, "Output verification evidence");
    if (fs.realpathSync.native(evidencePath) === fs.realpathSync.native(artifactPath)) {
      fail("Render verification evidence must be a separate render or visual-inspection record, not the output artifact itself.");
    }
    const extension = path.extname(evidencePath).toLowerCase();
    const visualExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".pdf"]);
    let evidenceKind = "render";
    if (extension === ".json") {
      const record = readProjectJson(context, evidencePath);
      assertRecordSchema(
        record,
        "render-verification-receipt.schema.json",
        `Render verification receipt ${toProjectPath(context, evidencePath)}`,
      );
      const { receipt_hash: receiptHash, hash_algorithm: algorithm, ...hashSubject } = record;
      if (algorithm !== "sha256:stable-json:v1" || receiptHash !== shortHashFull(stableJson(hashSubject))) {
        fail(`Render verification receipt ${toProjectPath(context, evidencePath)} failed immutable content validation.`);
      }
      if (
        record.kind !== "render_verification_receipt" ||
        record.status !== "passed" ||
        record.artifact_sha256 !== hashFile(artifactPath) ||
        record.artifact_path !== toProjectPath(context, artifactPath)
      ) {
        fail(`Render verification receipt ${toProjectPath(context, evidencePath)} must be passed and bound to the current artifact path and hash.`);
      }
      if (record.render_ref) {
        const renderPath = resolveProjectFilePath(context, record.render_ref.path, { mustExist: true, fileOnly: true });
        assertNotDerivedArtifact(context, renderPath, "Rendered verification evidence");
        if (hashFile(renderPath) !== record.render_ref.sha256) {
          fail(`Render verification receipt ${toProjectPath(context, evidencePath)} references stale render evidence.`);
        }
        const renderExtension = path.extname(renderPath).toLowerCase();
        if (!visualExtensions.has(renderExtension)) {
          fail(`Render verification receipt ${toProjectPath(context, evidencePath)} references a non-visual render file.`);
        }
        verifyVisualEvidenceFile(renderPath, renderExtension);
      }
      evidenceKind = "typed_render_receipt";
    } else if (!visualExtensions.has(extension)) {
      fail(`Render verification evidence ${toProjectPath(context, evidencePath)} is not a render. Use --render-evidence with a PNG/JPEG/WebP/PDF render or a typed render-verification-receipt:v1 JSON file; a functional test result or text assertion is not sufficient.`);
    } else {
      verifyVisualEvidenceFile(evidencePath, extension);
    }
    return {
      path: toProjectPath(context, evidencePath),
      sha256: hashFile(evidencePath),
      kind: evidenceKind,
    };
  });
  if (options.requireVisualEvidence && OUTPUT_VISUAL_FORMATS.has(delivery.format) && evidence.length === 0) {
    fail(
      `${delivery.label} output requires --render-evidence <render-or-visual-check-file> before it can be linked as canonical. `
      + "This flag is only for render or visual verification; record functional and test evidence with story complete-step or trace append. "
      + "The legacy --evidence name remains accepted for compatibility.",
    );
  }
  const generatorReceipt = delivery.generator
    ? readArtifactGeneratorReceipt(context, options.receiptFile, artifactPath, delivery)
    : null;

  const verifiedAt = now();
  const visual = OUTPUT_VISUAL_FORMATS.has(delivery.format);
  const artifactSha256 = hashFile(artifactPath);
  const receiptId = normalizeId(
    options.id || `VERIFY-${shortHash(`${toProjectPath(context, artifactPath)}:${artifactSha256}`)}`,
  );
  const dimension = (status, checks, dimensionEvidence = [], dimensionVerifier = verifier, reason = null) => ({
    status,
    verifier: dimensionVerifier,
    checks,
    evidence: dimensionEvidence,
    verified_at: status === "verified" ? verifiedAt : null,
    reason,
  });
  const receipt = buildVerificationReceipt({
    id: receiptId,
    subject_ref: options.subjectRef || {
      kind: "output_artifact",
      id: `ARTIFACT-${shortHash(toProjectPath(context, artifactPath))}`,
      path: toProjectPath(context, artifactPath),
      hash: artifactSha256,
    },
    artifact: {
      path: toProjectPath(context, artifactPath),
      sha256: artifactSha256,
      format: delivery.format,
      media_type: delivery.media_type,
    },
    generator_receipt: generatorReceipt,
    required_level: visual ? "rendered" : "semantic",
    dimensions: {
      existence: dimension("verified", [`non-empty file (${stat.size} bytes)`], [], "file-existence-v1"),
      container: dimension("verified", containerChecks),
      content: dimension("verified", contentChecks.length ? contentChecks : ["non-empty content"]),
      render: visual
        ? dimension("verified", [`${evidence.length} typed or visual render evidence file(s)`], evidence, "render-evidence-v1")
        : dimension("not-required", [], [], "render-evidence-v1", "Approved format does not require rendered verification."),
      independent: dimension(
        "not-required",
        [],
        [],
        null,
        "Independent verification is outside the approved verification level.",
      ),
    },
    evidence,
    limitations: visual ? [] : ["Rendered and independent verification were not required by this output contract."],
    verified_at: verifiedAt,
    verifier,
    extensions: {
      delivery_label: delivery.label,
      delivery_mode: delivery.mode,
      size_bytes: stat.size,
    },
  });
  const integrity = validateVerificationReceiptIntegrity(receipt);
  if (!integrity.valid) {
    fail(`Generated verification receipt is invalid: ${integrity.errors.join("; ")}`);
  }
  return receipt;
}

export function verifyVisualEvidenceFile(filePath, extension) {
  const bytes = fs.readFileSync(filePath);
  if (bytes.length < 32) {
    fail(`Visual evidence ${path.basename(filePath)} is empty or truncated.`);
  }
  try {
    if (extension === ".png") {
      inspectPngEvidence(bytes);
    } else if ([".jpg", ".jpeg"].includes(extension)) {
      inspectJpegEvidence(bytes);
    } else if (extension === ".webp") {
      inspectWebpEvidence(bytes);
    } else if (extension === ".pdf") {
      inspectPdfEvidence(bytes);
    } else {
      fail(`Unsupported visual evidence extension ${extension}.`);
    }
  } catch (error) {
    if (error instanceof UserError) {
      throw error;
    }
    fail(`Visual evidence ${path.basename(filePath)} is not a structurally valid ${extension} render: ${error.message}`);
  }
}

export function outputStatusTypes(context, registry, options = {}) {
  const explicitTypes = normalizeListOption(options.type).map(normalizeArtifactType);
  if (explicitTypes.length > 0) {
    return explicitTypes;
  }
  const story = options.story || null;
  if (story) {
    const activeTypes = new Set(
      (registry?.links || [])
        .filter((link) => link.story_id === story.id)
        .map((link) => link.artifact_type)
        .filter(Boolean)
        .map(normalizeArtifactType),
    );
    const contract = story.contract_id
      ? readContractById(context, story.contract_id, { missingOk: true })
      : null;
    for (const ref of contract?.output_contract_refs || []) {
      if (ref.artifact_type) activeTypes.add(normalizeArtifactType(ref.artifact_type));
    }
    if (activeTypes.size > 0) {
      return Array.from(activeTypes).sort();
    }
  }
  return collectOutputArtifactTypes(context, registry);
}

export function findUnlinkedStoryOutputCandidates(context, storyId) {
  const storyDir = path.join(context.sdlcRoot, "stories", storyId);
  const outputsDir = path.join(storyDir, "outputs");
  if (!fs.existsSync(outputsDir)) {
    return [];
  }
  const registry = readOutputRegistry(context, { missingOk: true });
  const linked = new Set((registry?.links || []).filter((link) => link.story_id === storyId).map((link) => link.artifact_path));
  return walkFiles(outputsDir)
    .filter((filePath) => shouldIndexFile(context, filePath))
    .map((filePath) => toProjectPath(context, filePath))
    .filter((relativePath) => !linked.has(relativePath));
}

export function traceEvidencePolicySourceRef(context, policy) {
  let source;
  try {
    source = describeRedactionPolicy(policy);
    assertTraceEvidencePolicySourceSafety(source);
  } catch {
    fail("The trace evidence redaction policy cannot be represented safely.");
  }
  const bytes = `${JSON.stringify(source, null, 2)}\n`;
  const sha256 = hashBuffer(Buffer.from(bytes, "utf8"));
  const projectPath = `${TRACE_EVIDENCE_POLICY_SOURCE_ROOT}/${sha256}.json`;
  const filePath = resolveProjectFilePath(context, projectPath, { mustExist: false });
  const releaseLock = acquireFileLock(`${filePath}.lock`);
  try {
    writeTextFile(filePath, bytes, {
      atomicCreate: true,
      durable: true,
      maxExistingBytes: Buffer.byteLength(bytes, "utf8"),
    });
  } finally {
    releaseLock();
  }
  return {
    schema_version: TRACE_EVIDENCE_POLICY_REF_SCHEMA,
    path: projectPath,
    sha256,
  };
}

export function loadTraceEvidencePolicySource(context, ref, options = {}) {
  if (
    !ref
    || typeof ref !== "object"
    || Array.isArray(ref)
    || Object.keys(ref).sort().join("\u0000") !== ["path", "schema_version", "sha256"].sort().join("\u0000")
    || ref.schema_version !== TRACE_EVIDENCE_POLICY_REF_SCHEMA
    || !/^[a-f0-9]{64}$/u.test(String(ref.sha256 || ""))
    || ref.path !== `${TRACE_EVIDENCE_POLICY_SOURCE_ROOT}/${ref.sha256}.json`
  ) {
    fail("Trace evidence policy source reference is malformed.");
  }
  const filePath = resolveProjectFilePath(context, ref.path, { mustExist: true, fileOnly: true });
  assertNoSymlinkPathSegments(filePath, context.root);
  const parentIdentity = captureDirectoryIdentity(path.dirname(filePath));
  const bytes = readFileFromStableParent(filePath, parentIdentity, {
    maxBytes: 256 * 1024,
    tooLargeMessage: "Trace evidence policy source exceeds the 256 KiB limit.",
  });
  if (hashBuffer(Buffer.from(bytes, "utf8")) !== ref.sha256) {
    fail("Trace evidence policy source hash does not match its content address.");
  }
  let source;
  try {
    source = JSON.parse(bytes);
  } catch {
    fail("Trace evidence policy source is not valid JSON.");
  }
  try {
    assertTraceEvidencePolicySourceSafety(source, options.allowedAlgorithms);
    return createRedactionPolicyFromSource(source);
  } catch {
    fail("Trace evidence policy source is unsupported or non-canonical.");
  }
}

export function buildTraceEvidenceRefs(context, event, policy) {
  const refs = [];
  let policySourceRef;
  const evidence = Array.isArray(event.evidence) ? event.evidence : [];
  for (const projectPath of evidence) {
    let filePath;
    try {
      filePath = resolveProjectFilePath(context, projectPath, { mustExist: true, fileOnly: true });
    } catch {
      continue;
    }
    const representation = redactedEvidenceRepresentation(context, filePath, policy);
    policySourceRef ||= traceEvidencePolicySourceRef(context, policy);
    refs.push({
      path: projectPath,
      size_bytes: Buffer.byteLength(representation, "utf8"),
      sha256: hashBuffer(Buffer.from(representation, "utf8")),
      representation: "redacted_utf8_v2",
      policy_source_ref: policySourceRef,
      verification: shouldVerifyTraceEvidence(event, projectPath)
        ? "current_content"
        : "snapshot_only",
    });
  }
  return refs;
}

// A large record (a baseline holds a hash per project file) is redacted one
// section at a time, so its size alone never hits the redaction limits; the
// representation of a record within the limits is unchanged.
export function redactedEvidenceValue(value, policy) {
  try {
    return redactValueInChunks(value, policy);
  } catch {
    return fail("Trace evidence redaction reached its safety limit.");
  }
}

export function redactedEvidenceRepresentation(context, filePath, policy) {
  const maximumBytes = 16 * 1024 * 1024;
  assertNoSymlinkPathSegments(filePath, context.root);
  const parentIdentity = captureDirectoryIdentity(path.dirname(filePath));
  const source = readFileFromStableParent(filePath, parentIdentity, {
    maxBytes: maximumBytes,
    tooLargeMessage: "Trace evidence exceeds the 16 MiB integrity snapshot limit.",
  });
  const extension = path.extname(filePath).toLowerCase();
  try {
    if (extension === ".json") {
      const parsed = JSON.parse(source);
      if (
        parsed?.kind === "trace_evidence_manifest"
        || parsed?.schema_version === "trace-evidence-manifest:v1"
      ) {
        assertRecordSchema(
          parsed,
          "trace-evidence-manifest.schema.json",
          "Trace evidence manifest",
        );
      }
      return `${JSON.stringify(redactedEvidenceValue(parsed, policy))}\n`;
    }
    if (extension === ".jsonl") {
      const lines = source.split(/\r?\n/u);
      return lines.map((line) => {
        if (!line.trim()) return "";
        return JSON.stringify(redactedEvidenceValue(JSON.parse(line), policy));
      }).join("\n");
    }
  } catch (error) {
    if (error instanceof UserError) throw error;
    // Malformed text remains bounded and is redacted as text without persisting raw bytes.
  }
  const presented = redactValueWithMetadata(source, policy);
  if (presented.limited) fail("Trace evidence redaction reached its safety limit.");
  return presented.value;
}

export function currentCertifiedLifecycleEvidenceMatches(
  context,
  storyId,
  proof,
  checkedAt,
  { workflow = null, supersession = null, diagnostics = null, projectHistoryScope = null } = {},
) {
  if (!Number.isFinite(Date.parse(String(checkedAt || "")))) return false;
  try {
    if (lifecycleEventsAfterCertification(readTraceEvents(context, storyId), checkedAt).length > 0) {
      return false;
    }
    const freshness = {
      status: "passed",
      strict: true,
      scope: "story",
      lifecycle_complete: true,
      story_id: storyId,
      errors: [],
      warnings: [],
      checked: [],
      ...(projectHistoryScope ? { project_history_scope: projectHistoryScope } : {}),
    };
    validateCurrentStrictStory(
      context,
      storyId,
      freshness,
      {
        includeProject: true,
        workflow,
        skipChangedPathScope: true,
        supersededLocalReleasePaths: supersession?.local_release_paths || null,
      },
    );
    if (diagnostics) {
      diagnostics.errors = [...freshness.errors];
      if (freshness.errors.length === 0 && stableJson(freshness.lifecycle_workflow) !== stableJson(proof)) {
        diagnostics.errors.push(`Story ${storyId} workflow evidence no longer matches its final gate receipt.`);
      }
    }
    return (
      freshness.errors.length === 0
      && stableJson(freshness.lifecycle_workflow) === stableJson(proof)
    );
  } catch (error) {
    if (diagnostics) diagnostics.errors = [error.message];
    return false;
  }
}

export function outputLinkRepairCommand(link) {
  const args = [
    "output", "link",
    "--story", link.story_id,
    "--type", link.artifact_type,
    "--artifact", link.artifact_path,
    "--template", link.template_id,
    "--mode", link.mode,
    "--id", link.id,
  ];
  if (link.base_artifact) {
    args.push("--base-artifact", link.base_artifact);
  }
  for (const requirementId of link.requirements || []) {
    args.push("--requirement", requirementId);
  }
  for (const evidence of link.verification_receipt?.evidence || []) {
    const evidencePath = evidence?.path || evidence;
    if (evidencePath) args.push("--evidence", evidencePath);
  }
  const generatorReceiptPath =
    link.verification_receipt?.generator_receipt?.path;
  if (generatorReceiptPath) {
    args.push("--receipt-file", generatorReceiptPath);
  }
  const authorizationId = outputLinkAuthorizationId(link);
  if (authorizationId) {
    args.push("--authorization", authorizationId);
  }
  if (link.decision_id) {
    args.push("--decision-id", link.decision_id);
  }
  if (link.rationale) {
    args.push("--rationale", link.rationale);
  }
  return statusCliCommand(...args);
}

export function strictGateOutputRepair(context, storyId, issues) {
  const registry = readOutputRegistry(context, { missingOk: true });
  if (!registry) return null;
  const templates = Array.isArray(registry.templates)
    ? registry.templates
    : [];
  const links = Array.isArray(registry.links)
    ? registry.links.filter((link) => link.story_id === storyId)
    : [];
  const gateCommand = statusCliCommand(
    "gate", "check", "--strict", "--story", storyId,
  );
  const template = templates.find((candidate) =>
    candidate?.id
    && issues.some((issue) =>
      String(issue).includes(`template ${candidate.id}`)
      && /changed after approval|delivery format changed after approval|structure or delivery approval is stale/iu
        .test(String(issue))));
  if (template) {
    const approvalCommand = statusCliCommand(
      "output", "template", "approve",
      "--id", template.id,
      "--actor-type", "human",
      "--approval-source", "explicit-user",
      "--summary", "<user-approved output format>",
    );
    const affectedLinks = links
      .filter((link) => link.template_id === template.id)
      .sort((left, right) => String(left.id).localeCompare(String(right.id), "en"));
    return {
      kind: "reapprove_output_template",
      reason: "output_template_changed_after_approval",
      label:
        `Review and re-approve output template ${template.id}, then refresh its linked artifact before re-running the strict gate.`,
      command: approvalCommand,
      template_id: template.id,
      affected_output_link_ids: affectedLinks.map((link) => link.id),
      repair_steps: [
        {
          kind: "reapprove_output_template",
          command: approvalCommand,
        },
        ...affectedLinks.map((link) => ({
          kind: "repair_output_link",
          output_link_id: link.id,
          command: outputLinkRepairCommand(link),
        })),
        {
          kind: "seal_strict_gate",
          command: gateCommand,
        },
      ],
    };
  }
  const link = links.find((candidate) =>
    candidate?.id
    && issues.some((issue) =>
      String(issue).includes(`output link ${candidate.id}`)
      && /artifact|verification receipt|fingerprint|changed after the artifact was linked/iu
        .test(String(issue))));
  if (!link) return null;
  const repairCommand = outputLinkRepairCommand(link);
  return {
    kind: "repair_output_link",
    reason: "output_link_evidence_changed",
    label:
      `Refresh output link ${link.id} against the current artifact and approved template before re-running the strict gate.`,
    command: repairCommand,
    output_link_id: link.id,
    artifact_path: link.artifact_path,
    template_id: link.template_id,
    repair_steps: [
      {
        kind: "repair_output_link",
        output_link_id: link.id,
        command: repairCommand,
      },
      {
        kind: "seal_strict_gate",
        command: gateCommand,
      },
    ],
  };
}

export function buildCanonicalEvidence(context, rawPaths, label) {
  return rawPaths.map((rawPath) => {
    const filePath = resolveProjectFilePath(context, rawPath, { mustExist: true, fileOnly: true });
    assertNotDerivedArtifact(context, filePath, label);
    return {
      path: toProjectPath(context, filePath),
      sha256: hashFile(filePath),
      hash_algorithm: "sha256:file:v1",
    };
  });
}

export function validateOutputContracts(context, report, storyId = null) {
  const registryPath = outputRegistryPath(context);
  const cacheStatus = getCacheStatus(context);
  if (!cacheStatus.valid && refreshDerivedCache(context)) {
    // Rebuilt in place: the cache is local derived data, nothing to report.
  } else if (!cacheStatus.exists) {
    report.warnings.push("Local SDLC cache is missing; run 'agentic-sdlc cache rebuild' for faster output resolution");
  } else if (!cacheStatus.valid) {
    report.warnings.push("Local SDLC cache is stale; run 'agentic-sdlc cache rebuild'");
  }

  if (!fs.existsSync(registryPath)) {
    const severity = report.strict ? "errors" : "warnings";
    report[severity].push("Missing .sdlc/output-contracts/registry.json");
    return;
  }

  const registry = readOutputRegistry(context);
  const templates = Array.isArray(registry.templates) ? registry.templates : [];
  const links = Array.isArray(registry.links) ? registry.links : [];
  const decisions = Array.isArray(registry.decisions) ? registry.decisions : [];
  const linksToValidate = storyId ? links.filter((link) => link.story_id === storyId) : links;
  const templateById = new Map(templates.map((template) => [template.id, template]));

  if (!registry.schema_version) {
    report.errors.push("Output registry is missing schema_version");
  }
  if (!Array.isArray(registry.templates)) {
    report.errors.push("Output registry templates must be an array");
  }
  if (!Array.isArray(registry.links)) {
    report.errors.push("Output registry links must be an array");
  }

  for (const duplicate of duplicateRegistryIds({ templates, decisions, links: linksToValidate })) {
    const severity = report.strict ? "errors" : "warnings";
    report[severity].push(
      `Output registry ${duplicate.list} has ${duplicate.count} entries with id ${duplicate.id}; keep the most recent one (latest updated_at) and remove the others`,
    );
  }

  for (const template of templates) {
    const label = `output template ${template.id || "unknown"}`;
    if (!template.id || !template.type || !template.status || !template.path) {
      report.errors.push(`${label} is missing id, type, status, or path`);
      continue;
    }
    const templatePath = resolveProjectFilePath(context, template.path, { mustExist: false });
    if (!fs.existsSync(templatePath)) {
      report.errors.push(`${label} references missing file ${template.path}`);
    }
    if (isDerivedArtifactPath(context, templatePath)) {
      report.errors.push(`${label} cannot live under cache or indexes`);
    }
    let delivery = null;
    try {
      delivery = effectiveOutputDelivery(template);
    } catch (error) {
      report.errors.push(`${label} has invalid delivery metadata: ${error.message}`);
    }
    if (template.status === "approved") {
      if (!hasFormalApprovalAttribution(template.approved_by, template.approval_source)) {
        report.errors.push(`${label} approved template is missing ${formalApprovalActorDescription(template.approval_source)} approval attribution`);
      }
      validateFormalApprovalRecord(
        context,
        report,
        {
          status: "approved",
          summary: template.approval_summary,
          evidence: template.approval_evidence || [],
          approval_source: template.approval_source || null,
          authorization_ref: template.authorization_ref || null,
          authorization_use_ref: template.authorization_use_ref || null,
          authorization_action: template.authorization_action || null,
          scope: template.approval_scope || null,
          artifact_type: template.type,
          explicit_user_confirmation: template.explicit_user_confirmation,
          provisional: template.provisional,
        },
        `${label} approval`,
        template.approved_by,
      );
      if (!template.approved_content_hash) {
        const severity = report.strict ? "errors" : "warnings";
        report[severity].push(`${label} is approved but has no approved_content_hash; re-approve the template`);
      } else if (fs.existsSync(templatePath) && hashFile(templatePath) !== template.approved_content_hash) {
        report.errors.push(`${label} changed after approval; re-approve the template`);
      }
      if (template.delivery && (!template.approved_delivery_hash || !delivery || template.approved_delivery_hash !== hashApprovalSubject(delivery))) {
        report.errors.push(`${label} delivery format changed after approval; re-approve the template`);
      }
    }
    if (Array.isArray(template.source_paths)) {
      for (const sourcePath of template.source_paths) {
        const resolved = resolveProjectFilePath(context, sourcePath, { mustExist: false });
        if (isDerivedArtifactPath(context, resolved)) {
          report.errors.push(`${label} uses derived cache/index source ${sourcePath}`);
        }
      }
    }
    report.checked.push(label);
  }

  for (const decision of effectiveOutputDecisions(decisions)) {
    validateOutputDecision(context, report, decision);
  }

  for (const link of linksToValidate) {
    const label = `output link ${link.id || `${link.story_id || "unknown"}:${link.artifact_type || "unknown"}`}`;
    validateOutputLink(context, report, registry, templateById, decisions, link, label);
    report.checked.push(label);
  }

  if (storyId) {
    for (const candidate of findUnlinkedStoryOutputCandidates(context, storyId)) {
      const severity = report.strict ? "errors" : "warnings";
      report[severity].push(`Story ${storyId} output candidate ${candidate} is not linked in output-contracts registry`);
    }
  }
}

export function validateOutputDecision(context, report, decision) {
  const label = `output decision ${decision.id || "unknown"}`;
  if (decision.type === "template_approved_by_assessment_proposal") {
    if (!decision.id || !decision.template_id || !decision.proposal_ref?.id || !decision.proposal_ref?.hash) {
      report.errors.push(`${label} assessment-proposal marker is missing id, template_id, or immutable proposal_ref`);
    }
    if (!decision.status) {
      report.warnings.push(`${label} is a legacy assessment-proposal marker without status; treat it as recorded and regenerate it on the next proposal application`);
    } else if (decision.status !== "recorded") {
      report.errors.push(`${label} assessment-proposal marker must use status 'recorded', not '${decision.status}'`);
    }
    report.checked.push(label);
    return;
  }
  if (!decision.id || !decision.status) {
    report.errors.push(`${label} is missing id or status`);
  }
  if (decision.status === "approved") {
    const actor = decision.audit?.decided_by;
    if (!hasFormalApprovalAttribution(actor, decision.approval_source)) {
      report.errors.push(`${label} approved decision is missing ${formalApprovalActorDescription(decision.approval_source)} attribution`);
    }
    validateFormalApprovalRecord(context, report, decision, `${label} approval`, actor);
    for (const evidence of decision.evidence || []) {
      const evidencePath = resolveProjectFilePath(context, evidence.path || evidence, { mustExist: false });
      if (!fs.existsSync(evidencePath)) {
        report.errors.push(`${label} references missing approval evidence ${evidence.path || evidence}`);
      } else if (isDerivedArtifactPath(context, evidencePath)) {
        report.errors.push(`${label} uses derived cache/index evidence ${evidence.path || evidence}`);
      } else if (evidence.sha256 && evidence.sha256 !== hashFile(evidencePath)) {
        report.errors.push(`${label} approval evidence changed after decision: ${evidence.path || evidence}`);
      }
    }
    if (decision.subject && decision.approved_content_hash) {
      const currentHash = hashApprovalSubject(decision.subject);
      if (currentHash !== decision.approved_content_hash) {
        report.errors.push(`${label} subject changed after approval`);
      }
    } else if (report.strict && decision.type === "output_link_override") {
      report.errors.push(`${label} override approval must include subject and approved_content_hash`);
    }
  }
  report.checked.push(label);
}

export function validateOutputLink(context, report, registry, templateById, decisions, link, label) {
  for (const field of ["id", "story_id", "artifact_type", "artifact_path", "template_id", "mode"]) {
    if (!link[field]) {
      report.errors.push(`${label} is missing ${field}`);
    }
  }
  if (!OUTPUT_LINK_MODES.has(link.mode)) {
    report.errors.push(`${label} has invalid mode '${link.mode}'`);
  }
  if (link.story_id && !readStory(context, link.story_id)) {
    report.errors.push(`${label} references missing story ${link.story_id}`);
  }

  const template = templateById.get(link.template_id);
  if (!template) {
    report.errors.push(`${label} references missing template ${link.template_id}`);
  } else {
    if (template.type !== link.artifact_type) {
      report.errors.push(`${label} template ${link.template_id} type '${template.type}' does not match '${link.artifact_type}'`);
    }
    if (template.status !== "approved") {
      const severity = report.strict ? "errors" : "warnings";
      report[severity].push(`${label} template ${link.template_id} is not approved`);
    }
    try {
      const delivery = effectiveOutputDelivery(template);
      if (link.artifact_path) {
        const artifactPath = resolveProjectFilePath(context, link.artifact_path, { mustExist: false });
        if (delivery.extension && !String(artifactPath).toLowerCase().endsWith(delivery.extension.toLowerCase())) {
          report.errors.push(`${label} artifact must use approved ${delivery.extension} delivery format`);
        }
      }
      for (const [field, expected] of [
        ["delivery_format", delivery.format],
        ["delivery_extension", delivery.extension],
        ["media_type", delivery.media_type],
        ["generator", delivery.generator],
        ["delivery_mode", delivery.mode],
      ]) {
        if (link[field] !== undefined && link[field] !== expected) {
          report.errors.push(`${label} ${field} does not match approved template ${link.template_id}`);
        }
      }
    } catch (error) {
      report.errors.push(`${label} cannot validate delivery metadata: ${error.message}`);
    }
  }

  if (link.artifact_path) {
    const artifactPath = resolveProjectFilePath(context, link.artifact_path, { mustExist: false });
    if (!fs.existsSync(artifactPath)) {
      report.errors.push(`${label} references missing artifact ${link.artifact_path}`);
    }
    if (isDerivedArtifactPath(context, artifactPath)) {
      report.errors.push(`${label} uses derived cache/index artifact ${link.artifact_path} as canonical output`);
    }
    if (fs.existsSync(artifactPath) && link.fingerprints?.artifact_sha256 && hashFile(artifactPath) !== link.fingerprints.artifact_sha256) {
      report.errors.push(`${label} artifact ${link.artifact_path} changed after it was linked`);
    } else if (report.strict && fs.existsSync(artifactPath) && !link.fingerprints?.artifact_sha256) {
      report.errors.push(`${label} is missing artifact fingerprint; re-link the output artifact`);
    }
    if (template?.delivery && fs.existsSync(artifactPath)) {
      const receipt = link.verification_receipt;
      if (!receipt || receipt.status !== "passed") {
        report.errors.push(`${label} is missing a passed format verification receipt; re-link the output artifact`);
      } else {
        const receiptIntegrity = receipt.kind === "verification_receipt"
          ? validateVerificationReceiptIntegrity(receipt)
          : null;
        if (receiptIntegrity && !receiptIntegrity.valid) {
          report.errors.push(`${label} verification receipt failed integrity validation: ${receiptIntegrity.errors.join("; ")}`);
        } else if (!receiptIntegrity) {
          report.warnings.push(`${label} uses a legacy embedded verification receipt; re-link it to create a canonical versioned receipt file`);
        }
        try {
          const currentReceipt = verifyOutputArtifact(context, artifactPath, effectiveOutputDelivery(template), {
            evidence: [],
            requireVisualEvidence: false,
            receiptFile: receipt.generator_receipt?.path || null,
          });
          if (verificationArtifactFormat(receipt) !== verificationArtifactFormat(currentReceipt) || receipt.verifier !== currentReceipt.verifier) {
            report.errors.push(`${label} verification receipt does not match the approved artifact format`);
          }
          if (verificationArtifactSha256(receipt) !== hashFile(artifactPath)) {
            report.errors.push(`${label} verification receipt is stale for ${link.artifact_path}`);
          }
          for (const dimension of ["container_verified", "content_verified", "render_verified"]) {
            const expected = dimension === "render_verified" && !OUTPUT_VISUAL_FORMATS.has(effectiveOutputDelivery(template).format)
              ? "not-required"
              : "verified";
            if (verificationDimensionStatus(receipt, dimension) !== expected) {
              report.errors.push(`${label} ${dimension} must be ${expected}`);
            }
          }
        } catch (error) {
          report.errors.push(`${label} artifact format verification failed: ${error.message}`);
        }
        if (OUTPUT_VISUAL_FORMATS.has(effectiveOutputDelivery(template).format) && !(receipt.evidence || []).length) {
          report.errors.push(`${label} is missing render or visual verification evidence`);
        }
        for (const evidence of receipt.evidence || []) {
          const evidencePath = resolveProjectFilePath(context, evidence.path, { mustExist: false });
          if (!fs.existsSync(evidencePath) || (evidence.sha256 && hashFile(evidencePath) !== evidence.sha256)) {
            report.errors.push(`${label} verification evidence ${evidence.path} is missing or changed`);
          } else if (fs.realpathSync.native(evidencePath) === fs.realpathSync.native(artifactPath)) {
            report.errors.push(`${label} verification evidence must be separate from the output artifact`);
          }
        }
        if (link.verification_receipt_ref) {
          const receiptPath = resolveProjectFilePath(context, link.verification_receipt_ref.path, { mustExist: false });
          if (!fs.existsSync(receiptPath)) {
            report.errors.push(`${label} references missing verification receipt ${link.verification_receipt_ref.path}`);
          } else {
            const persistedReceipt = readProjectJson(context, receiptPath);
            const expectedHash = link.verification_receipt_ref.hash || link.verification_receipt_ref.receipt_hash;
            if (expectedHash !== persistedReceipt.receipt_hash || stableJson(persistedReceipt) !== stableJson(receipt)) {
              report.errors.push(`${label} embedded and persisted verification receipts differ or the receipt reference is stale`);
            }
          }
        } else if (report.strict && receipt.kind === "verification_receipt") {
          report.errors.push(`${label} canonical verification receipt is not persisted by reference`);
        }
      }
    }
  }

  if (link.mode === "delta") {
    if (!link.base_artifact) {
      report.errors.push(`${label} mode delta requires base_artifact`);
    } else {
      const basePath = resolveProjectFilePath(context, link.base_artifact, { mustExist: false });
      if (!fs.existsSync(basePath)) {
        report.errors.push(`${label} references missing base artifact ${link.base_artifact}`);
      }
      if (isDerivedArtifactPath(context, basePath)) {
        report.errors.push(`${label} uses derived cache/index base artifact ${link.base_artifact}`);
      }
      if (
        fs.existsSync(basePath) &&
        link.fingerprints?.base_artifact_sha256 &&
        hashFile(basePath) !== link.fingerprints.base_artifact_sha256
      ) {
        report.errors.push(`${label} base artifact ${link.base_artifact} changed after it was linked`);
      } else if (report.strict && fs.existsSync(basePath) && !link.fingerprints?.base_artifact_sha256) {
        report.errors.push(`${label} is missing base artifact fingerprint; re-link the output artifact`);
      }
    }
  }

  if (template?.path) {
    const templatePath = resolveProjectFilePath(context, template.path, { mustExist: false });
    if (
      fs.existsSync(templatePath) &&
      link.fingerprints?.template_sha256 &&
      hashFile(templatePath) !== link.fingerprints.template_sha256
    ) {
      report.errors.push(`${label} template ${link.template_id} changed after the artifact was linked`);
    }
  }

  const requirements = Array.isArray(link.requirements) ? link.requirements.filter(Boolean) : [];
  if (requirements.length === 0) {
    const severity = report.strict ? "errors" : "warnings";
    report[severity].push(`${label} has no linked requirements; duplicate detection and reuse/delta resolution are unsafe`);
  }

  const matchingDecision = validateOutputLinkDecision(context, report, decisions, link, label);
  const duplicateLinks = findRelatedOutputLinks(registry, link).filter((related) => related.id !== link.id);
  if (link.mode === "new" && duplicateLinks.length > 0 && !matchingDecision) {
    const related = duplicateLinks.map((item) => `${item.story_id}:${item.artifact_path}`).join(", ");
    const severity = report.strict ? "errors" : "warnings";
    report[severity].push(
      `${label} creates a new ${link.artifact_type} for requirements already covered by ${related}; use reuse/delta or record an approved decision`,
    );
  }
  validateStoryActionCheckpoint(
    context,
    link.story_id,
    "output.link",
    link,
    report,
    label,
    { artifact_types: link.artifact_type ? [link.artifact_type] : [] },
  );
}

export function validateOutputLinkDecision(context, report, decisions, link, label) {
  if (!link.decision_id) {
    return null;
  }
  const decision = decisions.find((candidate) => candidate.id === link.decision_id) || null;
  if (!decision) {
    report.errors.push(`${label} references missing decision ${link.decision_id}`);
    return null;
  }
  if (!hasApprovedOutputDecision(decisions, link.decision_id)) {
    report.errors.push(`${label} decision ${link.decision_id} is not an approved output override decision`);
    return null;
  }
  const expectedSubject = buildOutputLinkDecisionSubject(link);
  const expectedHash = hashApprovalSubject(expectedSubject);
  if (!decision.subject || !decision.approved_content_hash) {
    const severity = report.strict ? "errors" : "warnings";
    report[severity].push(`${label} decision ${link.decision_id} must include subject and approved_content_hash`);
    return null;
  }
  if (decision.approved_content_hash !== expectedHash || stableJson(decision.subject) !== stableJson(expectedSubject)) {
    report.errors.push(`${label} decision ${link.decision_id} was approved for a different output link subject`);
    return null;
  }
  return decision;
}

export function validateContractOutputRefs(
  context,
  report,
  contract,
  label,
  validationContext = {},
) {
  const refs = Array.isArray(contract.output_contract_refs) ? contract.output_contract_refs : [];
  const requiresCoverage = context.config.gate_policy?.strict_mode?.requires_output_contract_coverage !== false;
  if (report.strict && requiresCoverage && contract.story_id && refs.length === 0) {
    report.errors.push(`${label} strict gate requires output_contract_refs for story output coverage`);
    return;
  }
  if (refs.length === 0) {
    return;
  }
  const registry = readOutputRegistry(context, { missingOk: true });
  const templates = new Map((registry?.templates || []).map((template) => [template.id, template]));
  const links = registry?.links || [];
  const configuredPhases = configuredPhaseOrder(context);
  const identities = new Set();
  for (const ref of refs) {
    const identity = [ref?.artifact_type, ref?.template_id, ref?.mode].join("\u0000");
    if (identities.has(identity)) {
      report.errors.push(
        `${label} output ref ${ref?.artifact_type || "unknown"} duplicates the same template and mode; `
        + "one canonical link cannot satisfy multiple phase obligations",
      );
    }
    identities.add(identity);
    if (ref?.phase && !configuredPhases.includes(ref.phase)) {
      report.errors.push(
        `${label} output ref ${ref.artifact_type || "unknown"} has unconfigured phase '${ref.phase}'`,
      );
    }
  }
  const coverageScope = report.strict && requiresCoverage && contract.story_id
    ? storyOutputCoverageScope(
        context,
        report,
        contract.story_id,
        validationContext.workflow || null,
      )
    : null;
  const coverageSelection = selectRequiredOutputRefsForPhase(refs, coverageScope);
  for (const issue of coverageSelection.issues) {
    report.errors.push(`${label} ${issue}`);
  }
  const requiredCoverageIndexes = new Set(
    coverageSelection.required_refs.map((item) => item.index),
  );
  const requiresStartReceipt = refs.some((ref) => templates.get(ref.template_id)?.preset === "technical-assessment");
  const taskStartReceiptPath = contract.story_id
    ? path.join(context.sdlcRoot, "stories", contract.story_id, "task-start.json")
    : null;
  if (report.strict && contract.story_id && (requiresStartReceipt || fs.existsSync(taskStartReceiptPath))) {
    for (const issue of validateTaskStartReceipt(context, contract.story_id, contract)) {
      report.errors.push(`${label} ${issue}`);
    }
  }
  for (const [refIndex, ref] of refs.entries()) {
    const refLabel = `${label} output ref ${ref.artifact_type || "unknown"}`;
    if (!ref.artifact_type || !ref.template_id || !ref.mode) {
      report.errors.push(`${refLabel} is missing artifact_type, template_id, or mode`);
      continue;
    }
    if (!OUTPUT_LINK_MODES.has(ref.mode)) {
      report.errors.push(`${refLabel} has invalid mode '${ref.mode}'`);
    }
    const template = templates.get(ref.template_id);
    if (!template) {
      report.errors.push(`${refLabel} references missing output template ${ref.template_id}`);
    } else {
      if (template.type !== ref.artifact_type) {
        report.errors.push(`${refLabel} template ${ref.template_id} type '${template.type}' does not match '${ref.artifact_type}'`);
      }
      if (report.strict && template.status !== "approved") {
        report.errors.push(`${refLabel} template ${ref.template_id} is not approved`);
      } else if (report.strict && outputTemplateNeedsApproval(context, template)) {
        report.errors.push(`${refLabel} template ${ref.template_id} structure or delivery approval is stale`);
      }
    }
    if (
      report.strict
      && requiresCoverage
      && contract.story_id
      && requiredCoverageIndexes.has(refIndex)
    ) {
      const matchingLink = links.find(
        (link) =>
          link.story_id === contract.story_id &&
          link.artifact_type === ref.artifact_type &&
          link.template_id === ref.template_id &&
          link.mode === ref.mode,
      );
      if (!matchingLink) {
        report.errors.push(
          `${refLabel} is not satisfied by an output link for story ${contract.story_id}; run output link with the approved template and mode`,
        );
      }
    }
  }
}

export function storyOutputCoverageScope(
  context,
  report,
  storyId,
  currentWorkflow = null,
) {
  if (report.lifecycle_complete === true) {
    return {
      current_phase: configuredPhaseOrder(context).at(-1) || null,
      phase_order: configuredPhaseOrder(context),
      require_all: true,
    };
  }
  const workflow =
    currentWorkflow
    || deriveCurrentStoryWorkflowScope(context, storyId, report);
  if (!workflow) {
    // Legacy stories have no trustworthy phase cutoff. Keep every output due.
    return null;
  }
  if (
    workflowCanonicalEvidenceSchema(workflow.effective_definition)
    === WORKFLOW_LEGACY_CANONICAL_EVIDENCE_SCHEMA
  ) {
    // Definitions pinned to canonical evidence v1 preserve their original
    // all-due output semantics when resumed.
    return null;
  }
  return {
    current_phase: workflow.scope.current_phase,
    phase_order: workflow.scope.phase_order,
    require_all: false,
  };
}

export function validateTraceEvidence(context, report, event, label) {
  const evidence = Array.isArray(event.evidence) ? event.evidence.filter(Boolean) : [];
  if (evidence.length === 0) {
    report.errors.push(`${label} ${event.type} trace requires at least one evidence path`);
    return;
  }
  for (const evidencePathValue of evidence) {
    const evidencePath = resolveProjectFilePath(context, evidencePathValue, { mustExist: false });
    if (!fs.existsSync(evidencePath)) {
      report.errors.push(`${label} references missing evidence ${evidencePathValue}`);
    } else if (isDerivedArtifactPath(context, evidencePath)) {
      report.errors.push(`${label} uses derived cache/index evidence ${evidencePathValue}`);
    }
  }
}

export function collectTraceEvidencePolicyBindings(context, report, records, label) {
  const result = new Map();
  if (!report.strict) return result;
  const eventRecords = new Map();
  for (const record of records) {
    if (!record.valid || !record.event?.id) continue;
    const entries = eventRecords.get(record.event.id) || [];
    entries.push({ event: record.event, line: record.line });
    eventRecords.set(record.event.id, entries);
  }
  for (const record of records) {
    if (!record.valid) continue;
    const event = record.event;
    if (
      event.evidence_policy_bindings !== undefined
      && !Array.isArray(event.evidence_policy_bindings)
    ) {
      report.errors.push(`${label}:${record.line} evidence policy bindings must be an array`);
      continue;
    }
    const bindings = Array.isArray(event.evidence_policy_bindings)
      ? event.evidence_policy_bindings
      : [];
    if (bindings.length === 0) {
      if (event.action === "trace.evidence-policy.bind") {
        report.errors.push(`${label}:${record.line} evidence policy binding event has no bindings`);
      }
      continue;
    }
    if (event.action !== "trace.evidence-policy.bind") {
      report.errors.push(`${label}:${record.line} evidence policy bindings require action trace.evidence-policy.bind`);
      continue;
    }
    for (const binding of bindings) {
      const bindingLabel = `${label}:${record.line} evidence policy binding`;
      if (
        !binding
        || typeof binding !== "object"
        || Array.isArray(binding)
        || Object.keys(binding).sort().join("\u0000")
          !== ["policy_source_ref", "schema_version", "target"].sort().join("\u0000")
        || binding.schema_version !== TRACE_EVIDENCE_POLICY_BINDING_SCHEMA
      ) {
        report.errors.push(`${bindingLabel} is malformed`);
        continue;
      }
      const target = binding.target;
      if (
        !target
        || typeof target !== "object"
        || Array.isArray(target)
        || Object.keys(target).sort().join("\u0000") !== [
          "event_hash",
          "event_id",
          "evidence_path",
          "evidence_ref_sha256",
          "evidence_sha256",
        ].sort().join("\u0000")
        || !/^[a-f0-9]{64}$/u.test(String(target.event_hash || ""))
        || !/^[a-f0-9]{64}$/u.test(String(target.evidence_sha256 || ""))
        || !/^[a-f0-9]{64}$/u.test(String(target.evidence_ref_sha256 || ""))
      ) {
        report.errors.push(`${bindingLabel} target is malformed`);
        continue;
      }
      const targetRecords = eventRecords.get(target.event_id) || [];
      if (targetRecords.length !== 1 || targetRecords[0].line >= record.line) {
        report.errors.push(`${bindingLabel} target must be one earlier sealed event`);
        continue;
      }
      const targetEvent = targetRecords[0].event;
      // A binding made before trace rebase moved the event names its original seal.
      if (![
        targetEvent?._trace_integrity?.event_hash,
        targetEvent?._trace_integrity?.rebased_from?.event_hash,
      ].includes(target.event_hash)) {
        report.errors.push(`${bindingLabel} target event hash does not match`);
        continue;
      }
      const refs = (Array.isArray(targetEvent.evidence_refs) ? targetEvent.evidence_refs : [])
        .filter((ref) => (
          ref?.representation === "redacted_utf8_v1"
          && ref.path === target.evidence_path
          && ref.sha256 === target.evidence_sha256
          && traceEvidenceRefHash(ref) === target.evidence_ref_sha256
        ));
      if (refs.length !== 1) {
        report.errors.push(`${bindingLabel} does not identify one exact historical v1 ref`);
        continue;
      }
      const key = traceEvidencePolicyBindingKey(target);
      if (!key || result.has(key)) {
        report.errors.push(`${bindingLabel} conflicts with another binding for the same historical ref`);
        if (key) result.set(key, null);
        continue;
      }
      try {
        result.set(key, {
          binding,
          policy: loadTraceEvidencePolicySource(context, binding.policy_source_ref),
        });
      } catch {
        report.errors.push(`${bindingLabel} policy source cannot be verified`);
        result.set(key, null);
      }
    }
  }
  return result;
}

export function validateTraceEvidenceRefs(context, report, event, label, evidencePolicyBindings = new Map()) {
  const refs = Array.isArray(event.evidence_refs) ? event.evidence_refs : [];
  const evidence = Array.isArray(event.evidence) ? event.evidence.filter(Boolean) : [];
  const byPath = new Map();
  for (const ref of refs) {
    if (!ref || typeof ref !== "object" || Array.isArray(ref) || typeof ref.path !== "string") {
      report.errors.push(`${label} contains an invalid evidence integrity reference`);
      continue;
    }
    if (byPath.has(ref.path)) {
      report.errors.push(`${label} contains duplicate evidence integrity reference ${ref.path}`);
      continue;
    }
    byPath.set(ref.path, ref);
    if (!evidence.includes(ref.path)) {
      report.errors.push(`${label} evidence integrity reference ${ref.path} is not listed as evidence`);
    }
    if (
      !["redacted_utf8_v1", "redacted_utf8_v2"].includes(ref.representation)
      || !/^[a-f0-9]{64}$/u.test(String(ref.sha256 || ""))
      || !Number.isSafeInteger(ref.size_bytes)
      || ref.size_bytes < 0
      || !["snapshot_only", "current_content"].includes(ref.verification)
      || (ref.representation === "redacted_utf8_v1" && ref.policy_source_ref !== undefined)
      || Object.keys(ref).sort().join("\u0000") !== (
        ref.representation === "redacted_utf8_v2"
          ? ["path", "policy_source_ref", "representation", "sha256", "size_bytes", "verification"]
          : ["path", "representation", "sha256", "size_bytes", "verification"]
      ).sort().join("\u0000")
    ) {
      report.errors.push(`${label} evidence integrity reference ${ref.path} is malformed`);
      continue;
    }
    let policy;
    if (ref.representation === "redacted_utf8_v2") {
      try {
        policy = loadTraceEvidencePolicySource(context, ref.policy_source_ref, {
          allowedAlgorithms: ["operational_v2"],
        });
      } catch {
        report.errors.push(`${label} evidence policy source cannot be verified for ${ref.path}`);
        continue;
      }
    } else {
      const target = {
        event_id: event.id,
        event_hash: event?._trace_integrity?.event_hash,
        evidence_path: ref.path,
        evidence_sha256: ref.sha256,
        evidence_ref_sha256: traceEvidenceRefHash(ref),
      };
      const resolution = evidencePolicyBindings.get(traceEvidencePolicyBindingKey(target));
      if (!resolution?.policy) {
        report.errors.push(`${label} historical v1 evidence ${ref.path} requires one exact append-only policy binding`);
        continue;
      }
      policy = resolution.policy;
    }
    if (ref.verification !== "current_content") continue;
    try {
      const filePath = resolveProjectFilePath(context, ref.path, { mustExist: true, fileOnly: true });
      const currentRepresentation = redactedEvidenceRepresentation(context, filePath, policy);
      const matches = evidenceRepresentationMatchesRef(currentRepresentation, ref);
      if (!matches) {
        const superseded = findEvidenceSupersedeForPath(context, ref.path, hashFile(filePath));
        if (superseded) {
          const note = `${label} evidence ${ref.path} superseded by a person: ${superseded.reason}`;
          if (!report.warnings.includes(note)) report.warnings.push(note);
        } else {
          report.errors.push(`${label} evidence content drift detected for ${ref.path}`);
        }
      }
    } catch {
      report.errors.push(`${label} cannot verify evidence content for ${ref.path}`);
    }
  }
  if (["test", "release"].includes(event.type)) {
    for (const evidencePath of evidence) {
      if (byPath.get(evidencePath)?.verification !== "current_content") {
        report.errors.push(`${label} requires a current-content integrity reference for ${evidencePath}`);
      }
    }
  }
}

/**
 * Enforces gate_policy.validation_requires_test_trace.
 *
 * The flag is read from the effective project configuration and defaults to
 * enabled, which is the behaviour the validation gate already had. Two levels
 * of evidence satisfy it:
 *
 * - a passing `test` trace event, the mechanism projects have used so far, and
 * - a `test-run:v1` record, which additionally binds the executed command, its
 *   exit status, its counts, and hashed runner output.
 *
 * A project that has only the trace event keeps passing the gate and is told,
 * as a warning, which command upgrades that evidence. A recorded test run that
 * contradicts the story's validation state is an error, which can only affect
 * projects that hold such a record, and no project can hold one from before
 * this contract existed.
 */
export function validateStoryTestEvidence(
  context,
  storyId,
  story,
  traceEvents,
  report,
  { phases = new Set([story.phase, story.status]) } = {},
) {
  const requiresTestEvidence = context.config.gate_policy?.validation_requires_test_trace !== false;
  const inValidation = phases.has("validation");
  const latestTestTrace = latestTraceEvent(traceEvents, "test");
  const testRuns = readTestRunRecords(context, storyId);
  for (const { path: recordPath, record } of testRuns) {
    appendRecordSchemaIssues(report, record, "test-run.schema.json", `test run ${record.id || recordPath}`);
  }
  if (report.strict) {
    validateTestTriageEvidence(context, storyId, report);
  }
  if (inValidation || report.lifecycle_complete === true) {
    validateDerivedVerificationEvidence(context, storyId, story, report);
  }
  if (!requiresTestEvidence || !inValidation) {
    return;
  }
  report.checked.push(`validation test evidence for story ${storyId}`);
  if (latestTestTrace?.outcome !== "passed") {
    report.errors.push(`Story ${storyId} is in validation but has no passing test trace`);
    return;
  }
  const latestTestRun = testRuns.at(-1);
  if (!latestTestRun) {
    report.warnings.push(
      `Story ${storyId} satisfies validation_requires_test_trace with a trace event only; `
      + "record the executed command, its exit status, and its output with "
      + `'test record --story ${storyId}' to bind reviewable test evidence`,
    );
    return;
  }
  if (latestTestRun.record.outcome !== "passed") {
    report.errors.push(
      `Story ${storyId} is in validation but its latest test run ${latestTestRun.record.id} `
      + `recorded outcome '${latestTestRun.record.outcome}' with exit status ${latestTestRun.record.exit_code}`,
    );
    return;
  }
  for (const evidence of latestTestRun.record.evidence || []) {
    const evidencePath = path.resolve(context.root, ...String(evidence.path).split("/"));
    if (!isInsidePath(context.root, evidencePath) || !fs.existsSync(evidencePath)) {
      report.errors.push(
        `Test run ${latestTestRun.record.id} references missing evidence ${evidence.path}`,
      );
      continue;
    }
    if (hashFile(evidencePath) !== evidence.sha256) {
      report.errors.push(
        `Test run ${latestTestRun.record.id} evidence ${evidence.path} changed after it was recorded`,
      );
    }
  }
  report.checked.push(`test run ${latestTestRun.record.id}`);
}

/**
 * Enforces gate_policy.secret_scan.enabled.
 *
 * The flag is read as `=== true`. A project that never declared the block keeps
 * the gate it agreed to, so a plugin update cannot start blocking deliveries in
 * a project that did not opt in; the current template declares it, and an
 * existing project adopts it through the reviewed `config migrate` path.
 *
 * When the flag is on and the story is in validation, or `required` asks for
 * the check in a later phase, the gate requires a `secret-scan:v1` record whose
 * outcome is clean and whose scanned head commit is the project's current head.
 * A record for an older head says nothing about the content being validated
 * now, and neither does one whose range starts after the delivery's task-start
 * base: only records that cover the whole delivery are considered, so a later
 * narrower scan cannot replace a finding. The scan reads the working tree, so
 * a record also has to match the current uncommitted state. `phases` names the
 * story's current lifecycle phases, which for a workflow-bound story come from
 * the workflow instance rather than story.json.
 */
export function validateStorySecretScanEvidence(
  context,
  storyId,
  story,
  report,
  { phases = new Set([story.phase, story.status]), required = false } = {},
) {
  const records = readSecretScanRecords(context, storyId);
  for (const { path: recordPath, record } of records) {
    appendRecordSchemaIssues(report, record, "secret-scan.schema.json", `secret scan ${record.id || recordPath}`);
  }
  if (context.config.gate_policy?.secret_scan?.enabled !== true) {
    return;
  }
  const inValidation = phases.has("validation");
  if (!inValidation && !required) {
    return;
  }
  report.checked.push(`validation secret scan for story ${storyId}`);
  // A merged story is certified on its merge commit: the scan has to cover
  // that commit, and the working tree holds other work.
  const mergeSha = report.lifecycle_complete === true ? storyDeliveryMergeCommit(context, story) : null;
  const headSha = mergeSha || execGit(context.root, ["rev-parse", "HEAD"]) || null;
  const deliveryBase = secretScanDeliveryBase(context, storyId);
  const certifiedHeadSha = mergeSha ? secretScanCertifiedHead(context, storyId) : null;
  let workspaceStateHash = null;
  if (!mergeSha && execGit(context.root, ["rev-parse", "--is-inside-work-tree"]) === "true") {
    try {
      workspaceStateHash = secretScanWorkspaceStateHash(context);
    } catch (error) {
      report.errors.push(`Story ${storyId} secret scan cannot read the current workspace state: ${error.message}`);
      return;
    }
  }
  let currentHeadRecords = records.filter((entry) =>
    ((entry.record.head_sha || null) === headSha
      || (certifiedHeadSha !== null && entry.record.head_sha === certifiedHeadSha))
    && secretScanCoversDeliveryBase(context, entry.record, deliveryBase)
    && (workspaceStateHash === null || secretScanMatchesWorkspace(entry.record, workspaceStateHash)));
  if (currentHeadRecords.length === 0 && mergeSha) {
    // The scan made before the merge still covers the merged story when the
    // merge left every file it scanned exactly as scanned.
    currentHeadRecords = records.filter((entry) =>
      secretScanCoversDeliveryBase(context, entry.record, deliveryBase)
      && secretScanHeadMatchesMerge(context, entry.record, mergeSha));
  }
  if (currentHeadRecords.length === 0) {
    report.errors.push(
      `Story ${storyId} ${inValidation ? "is in validation but " : ""}has no secret scan for the current project state`
      + `${headSha ? ` (head ${headSha.slice(0, 12)}` : ""}`
      + `${headSha && deliveryBase ? `, from delivery base ${deliveryBase.slice(0, 12)})` : headSha ? ")" : ""}`
      + `; run 'secret scan --story ${storyId}' (no --base: a --base scan counts only when its base is already on the remote base branch and in this branch's history)`
      + (mergeSha ? ` (after the merge it scans the merge commit ${mergeSha.slice(0, 12)})` : ""),
    );
    return;
  }
  const latest = currentHeadRecords.at(-1);
  if (latest.record.outcome !== "clean") {
    report.errors.push(
      `Story ${storyId} secret scan ${latest.record.id} found ${latest.record.findings.length} credential match(es) `
      + `in ${[...new Set(latest.record.findings.map((finding) => finding.path))].join(", ")}`,
    );
    return;
  }
  report.checked.push(`secret scan ${latest.record.id}`);
}

/**
 * Whether a range scan made on the story branch before its merge (a merge
 * commit or a squash) still holds on the merge commit: every file the scanned range changed outside project
 * records has the same content at the merge commit. Project records that
 * other computers added on the base meanwhile are covered by their own scans.
 */
function secretScanHeadMatchesMerge(context, record, mergeSha) {
  const scannedHead = String(record.head_sha || "").toLowerCase();
  const scannedBase = String(record.base_sha || "").toLowerCase();
  if (record.source !== "git_range" || !/^[a-f0-9]{40,64}$/u.test(scannedHead) || !scannedBase || scannedHead === mergeSha) {
    return false;
  }
  const changedPaths = (from, to) => {
    const listed = execGitOutput(context.root, ["diff", "--name-only", "-z", "--no-renames", from, to, "--"]);
    return listed === null ? null : listed.split("\0").filter(Boolean);
  };
  const scanned = changedPaths(scannedBase, scannedHead);
  const sinceScan = changedPaths(scannedHead, mergeSha);
  if (scanned === null || sinceScan === null) return false;
  const moved = new Set(sinceScan);
  return scanned.every((item) => !moved.has(item) || item === SDLC_DIR || item.startsWith(`${SDLC_DIR}/`));
}

// The head the story's existing final receipt certified, when that receipt
// is authentic; a scan of that head still covers the merged story.
function secretScanCertifiedHead(context, storyId) {
  try {
    const receipt = readProjectJson(context, workflowFinalGateReceiptPath(context, storyId));
    if (!hasValidWorkflowReceiptHash(receipt)) return null;
    const sha = receipt.freshness_proof?.git_scope?.certification_head_sha;
    return typeof sha === "string" && sha ? sha : null;
  } catch {
    return null;
  }
}

export function readTemplateFile(context, templateName) {
  if (path.basename(templateName) !== templateName || templateName === "." || templateName === "..") {
    fail(`Invalid template asset name: ${templateName}`);
  }
  const customPath = path.join(context.templateDir, templateName);
  const bundledPath = path.join(context.bundledTemplateDir, templateName);
  const customIsBundled = context.templateDir === context.bundledTemplateDir;
  let selection = null;
  let selectedSource = customIsBundled ? "bundled fallback" : "custom overlay";
  let attemptedPath = customIsBundled ? bundledPath : customPath;
  try {
    if (!customIsBundled) {
      selection = selectStableTemplateAsset(customPath, {
        parentIdentity: context.templateDirIdentity,
        allowMissing: true,
        invalidMessage: `Custom template overlay asset must be a readable regular file, not a directory or symlink: ${customPath}`,
      });
    }
    if (!selection) {
      selectedSource = "bundled fallback";
      attemptedPath = bundledPath;
      selection = selectStableTemplateAsset(bundledPath, {
        parentIdentity: context.bundledTemplateDirIdentity,
        invalidMessage: `Bundled fallback template asset must be a readable regular file: ${bundledPath}`,
      });
    }
    return readStableTemplateAsset(selection);
  } catch (error) {
    if (error instanceof UserError) {
      throw error;
    }
    fail(`Unable to read ${selectedSource} template asset ${attemptedPath}: ${error.message}`);
  }
}

export function readRequiredTemplateConfig(templateDir, templateDirIdentity) {
  const configPath = path.join(templateDir, "sdlc-config.json");
  try {
    const selection = selectStableTemplateAsset(configPath, {
      parentIdentity: templateDirIdentity,
      invalidMessage: `Template overlay must contain sdlc-config.json as a readable regular file: ${configPath}`,
    });
    return JSON.parse(readStableTemplateAsset(selection));
  } catch (error) {
    if (error instanceof UserError) {
      throw error;
    }
    fail(`Unable to read required template configuration ${configPath}: ${error.message}`);
  }
}

export function output(options, jsonPayload, lines) {
  if (options.json) {
    const payload = jsonPayload && typeof jsonPayload === "object" && !Array.isArray(jsonPayload)
      ? { ...jsonPayload, correlation_id: jsonPayload.correlation_id ?? CLI_OPERATION_CONTEXT.correlation_id }
      : { status: "ok", value: jsonPayload, correlation_id: CLI_OPERATION_CONTEXT.correlation_id };
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  const requestedLines = Array.isArray(lines) ? lines.map((line) => String(line)) : [String(lines ?? "")];
  const renderedLines = isHumanGuidanceOutput(requestedLines)
    ? requestedLines
    : humanGuidanceLines(legacyOutputGuidance(jsonPayload, options), requestedLines, options);
  const correlationLabel = humanGuidanceLocale(options) === "it" ? "ID correlazione" : "Correlation ID";
  const finalLines = renderedLines.some((line) => line.includes(CLI_OPERATION_CONTEXT.correlation_id))
    ? renderedLines
    : [...renderedLines, `- ${correlationLabel}: ${CLI_OPERATION_CONTEXT.correlation_id}`];
  for (const line of finalLines) {
    console.log(line);
  }
}
