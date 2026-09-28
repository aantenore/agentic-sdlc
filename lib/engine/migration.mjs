import path from "node:path";
import {
  computeStableHash,
} from "../canonical.mjs";
import {
  UserError,
  fail,
} from "../cli/user-error.mjs";
import {
  buildConfigMigrationApplyData,
  buildEffectiveConfigLock,
  prepareConfigMigration,
  resolveEffectiveConfig,
  verifyConfigMigrationPlan,
} from "../effective-config.mjs";
import {
  IDENTITY_STAT_OPTIONS,
  fileIdentity,
  sameFileIdentityValues,
} from "../file-identity.mjs";
import {
  consumeBootstrapMutationGrant,
  createBootstrapMutationGrant,
} from "../governance/mutation-guard.mjs";
import {
  IdentityMigrationError,
  applyIdentityMigration,
  planIdentityMigration,
  prepareIdentityMigrationRecovery,
  publicIdentityMigrationPlan,
  recoverIdentityMigration,
  validateIdentityMigrationReceipt,
} from "../identity-migration.mjs";
import {
  executeIdentityMutation,
  executePreparedIdentityMutation,
  hasFormalApprovalAttribution,
  hashApprovalSubject,
  preparedIdentityWritePath,
  projectBootstrapInitialIdentityHash,
  requireFormalApprovalActor,
} from "../lifecycle/authorization.mjs";
import {
  arraysEqual,
  assertNotDerivedArtifact,
  buildLegacyDefaultsProfile,
  getOptionString,
  instanceDefinitionReference,
  instanceOverlayReference,
  normalizeId,
  normalizeListOption,
  referenceId,
  referenceVersion,
  requireOption,
  shortHashFull,
  shouldIndexFile,
  slugify,
  stableJson,
} from "../lifecycle/common.mjs";
import {
  CACHE_FILE_NAME,
  PROJECT_BOOTSTRAP_JOURNAL_FILE_NAME,
  PROJECT_BOOTSTRAP_JOURNAL_SCHEMA_VERSION,
  PROJECT_BOOTSTRAP_MANIFEST_FILE_NAME,
  PROJECT_BOOTSTRAP_MANIFEST_INTRODUCED_VERSION,
  PROJECT_BOOTSTRAP_MANIFEST_SCHEMA_VERSION,
  PROJECT_CONFIG_FILE_NAME,
  NEW_PROJECT_IGNORED_ENTRIES,
  PROJECT_CONFIG_LOCK_FILE_NAME,
  SDLC_DIR,
} from "../lifecycle/constants.mjs";
import {
  normalizeGitRepositoryIdentity,
} from "../lifecycle/delivery.mjs";
import {
  assistantMessagePresentationFields,
} from "../lifecycle/guidance.mjs";
import {
  formatConfigMigrationChange,
  renderTemplate,
} from "../lifecycle/output.mjs";
import {
  assertNoSymlinkPathSegments,
  configMigrationBootstrapMutations,
  configMigrationChangeSummary,
  configMigrationPlanPresentation,
  failIncompleteExistingBootstrap,
  isInsidePath,
  logicalArchiveRoot,
  normalizeRequestedAutonomyMode,
  projectBootstrapDirectoryAncestorClosure,
  projectBootstrapJournalPath,
  projectBootstrapJournalReference,
  projectBootstrapRecoveryResult,
  projectVersionRequiresBootstrapManifest,
  toProjectPath,
} from "../lifecycle/project.mjs";
import {
  addRouteCheck,
  finalizeConcreteRoute,
} from "../lifecycle/route.mjs";
import {
  dependencyGraphPath,
} from "../lifecycle/story.mjs";
import {
  callWorkflowDomain,
  normalizeWorkflowVersion,
  validateWorkflowDefinitionRecord,
  workflowApprovalForDomain,
  workflowDefinitionPath,
  workflowDefinitionSummary,
  workflowDefinitionsRoot,
  workflowPhaseOrderDifference,
} from "../lifecycle/workflow.mjs";
import {
  assertNoSymlinkSegmentsWithinBoundary,
} from "../project-path-safety.mjs";
import {
  crypto,
  fs,
  process,
} from "../runtime/host.mjs";
import {
  applyWorkflowOverlay,
  approveWorkflowDefinition,
  buildWorkflowDefinition,
} from "../workflow-engine.mjs";
import {
  buildWorkflowPreset,
  getWorkflowPreset,
  listWorkflowPresets,
} from "../workflow-presets.mjs";
import {
  buildApprovalRecord,
  buildBaselineApprovalRequest,
  createBaselineProposal,
  renderApprovalRequestsAssistantMessage,
  validateApprovalEvidenceIntegrity,
} from "./authorization.mjs";
import {
  assertRecordSchema,
  buildActor,
  buildAttribution,
  buildCache,
  buildIndex,
  buildRunMetadata,
  buildSourceHashMap,
  ensurePlanningDirectories,
  loadOptionalJsonInput,
  now,
  parseDateBoundary,
  uniqueRecordSuffix,
  validateActiveManifestRecordSchemas,
  validateRecordSchema,
} from "./common.mjs";
import {
  DEFAULT_TEMPLATE_DIR,
  VERSION,
} from "./definitions.mjs";
import {
  assertLatestReleasedManifestSelected,
  assertReleaseManifestIntegrity,
  collectHistoricalReleaseArtifacts,
  readReleaseManifest,
} from "./delivery.mjs";
import {
  buildGitMetadata,
} from "./git.mjs";
import {
  getCacheStatus,
  getIndexStatus,
} from "./guidance.mjs";
import {
  output,
  outputContractsRoot,
  outputRegistryPath,
  readTemplateFile,
} from "./output.mjs";
import {
  pathEntryExistsNoFollow,
  plannedRealPath,
  resolveProjectFilePath,
  validateSdlcConfig,
} from "./project.mjs";
import {
  acquireFileLock,
  ensureDir,
  hashFile,
  initBootstrapMutations,
  readJson,
  readProjectBootstrapJournal,
  readProjectJson,
  readProjectSafe,
  readProjectText,
  readStableRegularFileBuffer,
  removePathGoverned,
  renamePathGoverned,
  safeReadDir,
  walkFiles,
  writeJsonFile,
  writeTextFile,
} from "./storage.mjs";
import {
  appendTraceEvent,
  buildContract,
  readBaselines,
} from "./story.mjs";
import {
  listVersionedWorkflowRecords,
  outputWorkflowResult,
  parseWorkflowJsonInput,
  resolveWorkflowRecord,
  syncWorkflowDirectory,
  syncWorkflowFile,
  workflowHumanReviewLines,
} from "./workflow.mjs";

export function workflowFinalFreshnessLocalRootIdentity(rawPath) {
  const rootPath = path.resolve(String(rawPath));
  if (!fs.existsSync(rootPath)) {
    return {
      path: rootPath,
      present: false,
      kind: "missing",
      real_path: null,
      device: null,
      inode: null,
      mode: null,
    };
  }
  const snapshot = () => {
    const stat = fs.lstatSync(rootPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      fail(`Local release root must remain a real directory: ${rootPath}`);
    }
    return {
      path: rootPath,
      present: true,
      kind: "directory",
      real_path: fs.realpathSync.native(rootPath),
      device: String(stat.dev),
      inode: String(stat.ino),
      mode: stat.mode & 0o7777,
    };
  };
  const first = snapshot();
  const second = snapshot();
  if (stableJson(first) !== stableJson(second)) {
    fail(`Local release root identity changed while being snapshotted: ${rootPath}`);
  }
  return first;
}

export function listWorkflowDefinitionsCommand(context, options) {
  ensureInitialized(context);
  const projectRecords = listVersionedWorkflowRecords(context, workflowDefinitionsRoot(context));
  const presets = callWorkflowDomain("Unable to list included ways of working", () => listWorkflowPresets());
  const included = presets.map((preset) => {
    const id = typeof preset === "string" ? preset : preset.id;
    const descriptor = typeof preset === "string" ? getWorkflowPreset(preset) : preset;
    return {
      id,
      version: descriptor.version || "1",
      available_versions: descriptor.available_versions || [descriptor.version || "1"],
      status: descriptor.status || "included",
      name: descriptor.name || descriptor.title || descriptor.label || id,
      description: descriptor.description || descriptor.summary || null,
      journey: descriptor.journey || [],
      review_moments: descriptor.review_moments || [],
      governance_controls: descriptor.governance_controls || [],
      source: "included",
    };
  });
  const definitions = projectRecords.map(({ record, path: filePath }) => ({
    ...workflowDefinitionSummary(record),
    path: toProjectPath(context, filePath),
  }));
  outputWorkflowResult(options, {
    schema_version: "workflow-definition-list:v1",
    status: "ready",
    included,
    definitions,
  }, "listed", [
    `Included choices: ${included.map((entry) => entry.id).join(", ") || "none"}`,
    `Project definitions: ${definitions.length}`,
  ]);
}

export function showWorkflowDefinition(context, options) {
  ensureInitialized(context);
  const id = normalizeId(requireOption(options, "id"));
  const requestedVersion = getOptionString(options, "definition-version");
  let resolved;
  try {
    resolved = resolveWorkflowRecord(context, { kind: "definition", id, version: requestedVersion });
    validateWorkflowDefinitionRecord(resolved.record, `workflow definition ${id}`);
  } catch (error) {
    if (!(error instanceof UserError) || !/does not exist/u.test(error.message)) throw error;
    const preset = callWorkflowDomain(`Workflow definition ${id} does not exist`, () =>
      buildWorkflowPreset(id, {
        ...(requestedVersion ? { version: Number(normalizeWorkflowVersion(requestedVersion, "definition-version")) } : {}),
      }));
    resolved = { id, version: preset.version, path: null, record: preset, included: true };
  }
  const requiresConfirmation = resolved.record.status === "proposed";
  outputWorkflowResult(options, {
    schema_version: "workflow-definition-view:v1",
    status: resolved.record.status || "ready",
    source: resolved.included ? "included" : "project",
    path: resolved.path ? toProjectPath(context, resolved.path) : null,
    definition: resolved.record,
  }, requiresConfirmation ? "shown_proposed" : "shown_approved", [
    `Definition: ${resolved.record.id} version ${resolved.record.version}`,
    `Status: ${resolved.record.status || "included"}`,
    `Initial state: ${resolved.record.initial_state}`,
    `States: ${Array.isArray(resolved.record.states) ? resolved.record.states.map((state) => state.id || state).join(", ") : Object.keys(resolved.record.states || {}).join(", ")}`,
    ...(resolved.path ? [`Path: ${toProjectPath(context, resolved.path)}`] : ["Source: included preset"]),
  ], workflowHumanReviewLines(resolved.record, options, { requiresConfirmation }));
}

export function proposeWorkflowDefinition(context, options) {
  ensureInitialized(context);
  const id = normalizeId(requireOption(options, "id"));
  const version = normalizeWorkflowVersion(requireOption(options, "definition-version"), "definition-version");
  const presetId = getOptionString(options, "workflow-preset");
  const hasCustomInput = Boolean(getOptionString(options, "definition-file") || getOptionString(options, "definition-json"));
  if (Boolean(presetId) === hasCustomInput) {
    fail("Workflow definition proposal needs exactly one of --workflow-preset, --definition-file, or --definition-json.");
  }
  let input;
  if (presetId) {
    const preset = callWorkflowDomain(`Unknown workflow preset '${presetId}'`, () =>
      buildWorkflowPreset(presetId, { version: Number(version), created_at: now() }));
    const {
      definition_hash: ignoredHash,
      approval: ignoredApproval,
      approved_at: ignoredApprovedAt,
      approved_by: ignoredApprovedBy,
      ...presetInput
    } = preset;
    input = { ...presetInput, id, version: Number(version), status: "proposed" };
  } else {
    const custom = parseWorkflowJsonInput(context, options, {
      fileOption: "definition-file",
      jsonOption: "definition-json",
      label: "workflow definition",
    });
    if (!custom || typeof custom !== "object" || Array.isArray(custom)) fail("Workflow definition JSON must be an object.");
    input = { ...custom, id, version: Number(version), status: "proposed", created_at: custom.created_at || now() };
  }
  const summary = getOptionString(options, "summary");
  if (summary) input = { ...input, description: input.description || summary };
  const definition = callWorkflowDomain("Unable to prepare workflow definition", () => buildWorkflowDefinition(input));
  validateWorkflowDefinitionRecord(definition, `workflow definition ${id}`);
  const reviewLines = workflowHumanReviewLines(definition, options);
  assertRecordSchema(definition, "workflow-definition.schema.json", `Workflow definition ${id} version ${version}`);
  const filePath = workflowDefinitionPath(context, id, version);
  writeJsonFile(filePath, definition, { force: false });
  const attribution = buildAttribution(context, options, "workflow.definition.propose");
  appendTraceEvent(context, null, {
    type: "decision",
    outcome: "ready",
    summary: `Proposed workflow definition ${id} version ${version}`,
    action: "workflow.definition.propose",
    actor: attribution.actor,
    evidence: [toProjectPath(context, filePath)],
    related: [id],
    git: attribution.git,
    run: attribution.run,
  });
  outputWorkflowResult(options, {
    schema_version: "workflow-definition-proposal:v1",
    status: "proposed",
    path: toProjectPath(context, filePath),
    definition,
  }, "proposed", [
    `Definition: ${id} version ${version}`,
    `Path: ${toProjectPath(context, filePath)}`,
    `Content hash: ${definition.definition_hash}`,
    `Approve: agentic-sdlc workflow definition approve --id ${id} --definition-version ${version} --actor-type human --approval-source explicit-user --summary "Approved the displayed steps, checks, and limits"`,
  ], reviewLines);
}

export function approveWorkflowDefinitionCommand(context, options) {
  ensureInitialized(context);
  const id = normalizeId(requireOption(options, "id"));
  const version = normalizeWorkflowVersion(requireOption(options, "definition-version"), "definition-version");
  const resolved = resolveWorkflowRecord(context, { kind: "definition", id, version });
  if (resolved.record.status !== "proposed") {
    fail(`Workflow definition ${id} version ${version} is '${resolved.record.status}', expected proposed.`);
  }
  validateWorkflowDefinitionRecord(resolved.record, `workflow definition ${id}`);
  workflowHumanReviewLines(resolved.record, options);
  const attribution = buildAttribution(context, options, "workflow.definition.approve");
  requireFormalApprovalActor(context, options, attribution, "Approving a workflow definition");
  const approval = buildApprovalRecord(context, options, attribution, {
    subject: resolved.record,
    subject_id_field: "definition_id",
    subject_id: id,
    scope: "workflow-definition-version",
    label: `workflow definition ${id} version ${version}`,
    artifact_types: ["workflow-definition"],
  });
  const approved = callWorkflowDomain("Unable to approve workflow definition", () =>
    approveWorkflowDefinition(resolved.record, { approval: workflowApprovalForDomain(approval) }));
  validateWorkflowDefinitionRecord(approved, `approved workflow definition ${id}`);
  const reviewLines = workflowHumanReviewLines(approved, options, { requiresConfirmation: false });
  writeJsonFile(resolved.path, approved, { force: true });
  appendTraceEvent(context, null, {
    type: "gate",
    outcome: "passed",
    summary: approval.summary || `Approved workflow definition ${id} version ${version}`,
    action: "workflow.definition.approve",
    actor: attribution.actor,
    authorization_ref: approval.authorization_ref,
    evidence: [toProjectPath(context, resolved.path), ...approval.evidence.map((entry) => entry.path)],
    related: [id, approval.id],
    git: attribution.git,
    run: attribution.run,
  });
  outputWorkflowResult(options, {
    schema_version: "workflow-definition-approval:v1",
    status: "approved",
    path: toProjectPath(context, resolved.path),
    definition: approved,
    approval,
  }, "approved", [
    `Definition: ${id} version ${version}`,
    `Approval: ${approval.id}`,
    `Path: ${toProjectPath(context, resolved.path)}`,
  ], reviewLines);
}

export function workflowDefinitionForOverlay(context, overlay) {
  const ref = overlay.definition_ref || overlay.base_definition_ref || overlay.definition;
  const id = ref?.id || ref?.definition_id || overlay.definition_id;
  const version = ref?.version || ref?.definition_version || overlay.definition_version;
  if (!id || !version) fail(`Workflow overlay ${overlay.id || "unknown"} does not identify its base definition.`);
  const resolved = resolveWorkflowDefinitionForRuntime(context, id, String(version));
  const expectedDefinitionHash = ref?.hash || ref?.definition_hash;
  if (expectedDefinitionHash && resolved.record.definition_hash !== expectedDefinitionHash) {
    fail(`Workflow overlay ${overlay.id || "unknown"} no longer matches its approved base definition.`);
  }
  return resolved;
}

export function resolveWorkflowDefinitionForRuntime(context, id, version) {
  try {
    return resolveWorkflowRecord(context, { kind: "definition", id, version });
  } catch (error) {
    if (!(error instanceof UserError) || !/does not exist/u.test(error.message)) throw error;
    const record = callWorkflowDomain(`Workflow definition ${id} version ${version} does not exist`, () =>
      buildWorkflowPreset(id, { version: Number(normalizeWorkflowVersion(version, "definition-version")) }));
    return { id: record.id, version: record.version, path: null, record, included: true };
  }
}

export function loadEffectiveDefinitionForInstance(context, instance) {
  const definitionRef = instanceDefinitionReference(instance);
  const definitionId = referenceId(definitionRef, "definition");
  const definitionVersion = referenceVersion(definitionRef, "definition");
  if (!definitionId || !definitionVersion) fail(`Workflow instance ${instance.id || "unknown"} is missing its pinned definition reference.`);
  const definitionEntry = resolveWorkflowDefinitionForRuntime(
    context,
    definitionId,
    String(definitionVersion),
  );
  const expectedDefinitionHash = definitionRef.hash || definitionRef.definition_hash;
  if (expectedDefinitionHash && definitionEntry.record.definition_hash !== expectedDefinitionHash) {
    fail(`Workflow instance ${instance.id} definition changed after start.`);
  }
  const overlayRef = instanceOverlayReference(instance);
  if (!overlayRef) {
    const effectiveDefinition = callWorkflowDomain("Unable to reconstruct the pinned way of working", () =>
      applyWorkflowOverlay(definitionEntry.record, null));
    const expectedEffectiveHash = instance.effective_hash
      || instance.effective_definition_hash
      || instance.effective_definition_ref?.hash;
    if (expectedEffectiveHash && effectiveDefinition.effective_hash !== expectedEffectiveHash) {
      fail(`Workflow instance ${instance.id} effective definition no longer matches its start record.`);
    }
    return { definitionEntry, overlayEntry: null, effectiveDefinition };
  }
  const overlayId = referenceId(overlayRef, "overlay");
  const overlayVersion = referenceVersion(overlayRef, "overlay");
  if (!overlayId || !overlayVersion) fail(`Workflow instance ${instance.id} has an incomplete overlay reference.`);
  const overlayEntry = resolveWorkflowRecord(context, { kind: "overlay", id: overlayId, version: String(overlayVersion) });
  const expectedOverlayHash = overlayRef.hash || overlayRef.overlay_hash;
  if (expectedOverlayHash && overlayEntry.record.overlay_hash !== expectedOverlayHash) {
    fail(`Workflow instance ${instance.id} overlay changed after start.`);
  }
  const effectiveDefinition = callWorkflowDomain("Unable to reconstruct the pinned way of working", () =>
    applyWorkflowOverlay(definitionEntry.record, overlayEntry.record));
  const expectedEffectiveHash = instance.effective_hash
    || instance.effective_definition_hash
    || instance.effective_definition_ref?.hash;
  if (expectedEffectiveHash && effectiveDefinition.effective_hash !== expectedEffectiveHash) {
    fail(`Workflow instance ${instance.id} effective definition no longer matches its start record.`);
  }
  return { definitionEntry, overlayEntry, effectiveDefinition };
}

export function prepareProjectConfigMigration(context, projectConfig, projectLock, autonomyMode = null) {
  let plan;
  const migrationInput = {
    project_config: projectConfig,
    legacy_defaults: context.templateConfig,
    defaults_profile: context.templateDefaultsProfile,
    lock: projectLock,
    config_path: `${SDLC_DIR}/${PROJECT_CONFIG_FILE_NAME}`,
    lock_path: `${SDLC_DIR}/${PROJECT_CONFIG_LOCK_FILE_NAME}`,
  };
  try {
    plan = prepareConfigMigration(migrationInput);
    if (autonomyMode) {
      const targetConfig = structuredClone(plan.target_config);
      targetConfig.autonomy_policy = {
        ...targetConfig.autonomy_policy,
        mode: autonomyMode,
      };
      plan = prepareConfigMigration({
        ...migrationInput,
        target_config: targetConfig,
      });
    }
    legacyBootstrapAdoptionSubject(context, projectConfig, projectLock, plan);
  } catch (error) {
    if (error instanceof TypeError) {
      fail([
        "A safe configuration migration plan could not be created; no files were changed.",
        "Impact: governed writes remain blocked because the current lock is structurally invalid.",
        `Next: inspect or restore ${SDLC_DIR}/${PROJECT_CONFIG_LOCK_FILE_NAME}, then run the preview again.`,
        `Technical detail: ${error.message}`,
      ].join("\n"));
    }
    throw error;
  }
  try {
    validateSdlcConfig(plan.target_config);
  } catch (error) {
    if (!(error instanceof UserError)) throw error;
    fail([
      "A safe configuration migration plan could not be created; no applicable plan or plan hash was emitted.",
      "Impact: governed writes remain blocked because the target configuration is invalid.",
      `Next: correct ${SDLC_DIR}/${PROJECT_CONFIG_FILE_NAME}, then run the preview again.`,
      `Technical detail: target configuration is invalid: ${error.message}`,
    ].join("\n"));
  }
  return plan;
}

export function legacyBootstrapAdoptionSubject(
  context,
  projectConfig,
  projectLock,
  plan,
) {
  if (projectLock) return null;
  const manifestPath = path.join(context.sdlcRoot, PROJECT_BOOTSTRAP_MANIFEST_FILE_NAME);
  if (pathEntryExistsNoFollow(manifestPath)) {
    const entry = fs.lstatSync(manifestPath);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new TypeError("The existing bootstrap manifest is not a stable regular file");
    }
    return null;
  }
  const projectPath = path.join(context.sdlcRoot, "project.json");
  if (!pathEntryExistsNoFollow(projectPath)) {
    throw new TypeError("A first configuration lock requires an initialized project record");
  }
  const project = readProjectJson(context, projectPath);
  const legacyConfig = validateSdlcConfig(
    readJson(path.join(DEFAULT_TEMPLATE_DIR, "config-compat", "sdlc-config-v1-0.11.0.json")),
  );
  const exactLegacyBootstrap = project.sdlc_version === "0.11.0"
    && !project.bootstrap_manifest
    && !project.bootstrap_journal
    && !pathEntryExistsNoFollow(projectBootstrapJournalPath(context))
    && !pathEntryExistsNoFollow(path.join(context.sdlcRoot, ".gitattributes"))
    && computeStableHash(projectConfig) === computeStableHash(legacyConfig)
    && ["materialize_legacy_defaults", "adopt_lock"].includes(plan.mode);
  if (!exactLegacyBootstrap) {
    throw new TypeError(
      "The missing bootstrap manifest does not match the exact supported v0.11 bootstrap evidence; "
      + "a normal configuration migration cannot recreate legacy provenance for an incomplete newer bootstrap",
    );
  }
  return {
    schema_version: "legacy-bootstrap-adoption:v1",
    status: "approved",
    project_ref: {
      id: project.project_id,
      path: `${SDLC_DIR}/project.json`,
      sdlc_version: project.sdlc_version,
      content_sha256: computeStableHash(project),
    },
    source_config_sha256: computeStableHash(projectConfig),
    legacy_defaults_profile: buildLegacyDefaultsProfile(legacyConfig),
    plan_hash: plan.plan_hash,
  };
}

export function attachLegacyBootstrapAdoption(context, options, application, adoptionSubject) {
  if (!adoptionSubject || application.status === "already_applied") return application;
  if (options["confirm-legacy-bootstrap"] !== true) {
    fail([
      "The first configuration lock was not created because this manifestless v0.11 bootstrap needs a separate explicit adoption.",
      "Impact: the legacy files remain unchanged and no migration receipt was written.",
      "Next: review the exact legacy adoption shown by the preview, then repeat the apply command with --confirm-legacy-bootstrap, --actor-type human|ci, --approval-source explicit-user|ci, and --summary.",
    ].join("\n"));
  }
  const source = getOptionString(options, "approval-source");
  if (!["explicit-user", "ci"].includes(source)) {
    fail(
      "Legacy bootstrap adoption requires direct --approval-source explicit-user or ci; "
      + "automation and bootstrap attribution cannot adopt historical project state.",
    );
  }
  const approvalSummary = getOptionString(options, "summary");
  const approvalEvidence = normalizeListOption(options["approval-evidence"]);
  if (!approvalSummary && approvalEvidence.length === 0) {
    fail([
      "The first configuration lock was not created because legacy bootstrap adoption requires --summary or --approval-evidence, including for CI approval.",
      "Impact: the legacy files remain unchanged and no migration receipt was written.",
      "Next: describe the exact reviewed adoption with --summary, or bind a stable project file with --approval-evidence, then retry the same reviewed plan.",
    ].join("\n"));
  }
  const attribution = buildAttribution(context, options, "config.migrate.legacy-bootstrap-adopt");
  const approval = buildApprovalRecord(context, options, attribution, {
    label: "Legacy bootstrap adoption",
    subject: adoptionSubject,
    subject_id: adoptionSubject.project_ref.id,
    scope: {
      adoption_only: true,
      project_id: adoptionSubject.project_ref.id,
      plan_hash: adoptionSubject.plan_hash,
      does_not_approve_future_migrations: true,
    },
  });
  const adoptionBase = {
    ...adoptionSubject,
    approval,
    hash_algorithm: "sha256:stable-json:v1",
  };
  const legacyBootstrapAdoption = {
    ...adoptionBase,
    adoption_hash: computeStableHash(adoptionBase),
  };
  const { receipt_hash: _priorReceiptHash, ...receiptBase } = application.receipt;
  const receiptSubject = {
    ...receiptBase,
    legacy_bootstrap_adoption: legacyBootstrapAdoption,
  };
  return {
    ...application,
    receipt: {
      ...receiptSubject,
      receipt_hash: computeStableHash(receiptSubject),
    },
  };
}

export function migrateProjectConfig(context, options) {
  if (!context.rawProjectConfig) {
    fail([
      "There is no project configuration to migrate; no files were changed.",
      "Impact: this project remains uninitialized.",
      "Next: run `agentic-sdlc init` instead.",
    ].join("\n"));
  }
  const autonomyMode = normalizeRequestedAutonomyMode(options);

  if (options.apply && options.__bootstrapGrantConsumed !== true) {
    const expectedPlanHash = getOptionString(options, "plan-hash");
    if (expectedPlanHash) {
      const currentPlan = prepareProjectConfigMigration(
        context,
        context.rawProjectConfig,
        context.projectConfigLock,
        autonomyMode,
      );
      if (expectedPlanHash !== currentPlan.plan_hash) {
        fail([
          "The configuration was not changed because the reviewed plan no longer matches.",
          "Impact: the existing config and lock remain untouched.",
          "Next: run `agentic-sdlc config migrate` again and review the new plan.",
        ].join("\n"));
      }
      const grant = createBootstrapMutationGrant({
        root: context.root,
        canonical_action: "config.migrate",
        plan_hash: expectedPlanHash,
        expected_plan_hash: currentPlan.plan_hash,
        exact_mutations: configMigrationBootstrapMutations(context, currentPlan),
      });
      return consumeBootstrapMutationGrant(
        grant,
        () => migrateProjectConfig(context, { ...options, __bootstrapGrantConsumed: true }),
      );
    }
  }

  if (!options.apply) {
    const plan = prepareProjectConfigMigration(
      context,
      context.rawProjectConfig,
      context.projectConfigLock,
      autonomyMode,
    );
    const verification = verifyConfigMigrationPlan(plan);
    if (!verification.valid) {
      fail(`Configuration migration plan failed its integrity check: ${verification.errors.join(", ")}`);
    }
    const impact = configMigrationChangeSummary(plan);
    const autonomyModeArgument = autonomyMode ? ` --autonomy-mode ${autonomyMode}` : "";
    const legacyAdoption = legacyBootstrapAdoptionSubject(
      context,
      context.rawProjectConfig,
      context.projectConfigLock,
      plan,
    );
    const legacyAdoptionArgument = legacyAdoption
      ? " --confirm-legacy-bootstrap --actor-type human --approval-source explicit-user --summary \"I adopt this exact legacy bootstrap\""
      : "";
    const planPresentation = configMigrationPlanPresentation(plan, {
      full: options.full === true,
    });
    output(options, {
      status: "planned",
      files_changed: 0,
      impact,
      requested_autonomy_mode: autonomyMode,
      semantic_diff: plan.changes,
      legacy_bootstrap_adoption: legacyAdoption
        ? { required: true, subject: legacyAdoption }
        : { required: false },
      next_action: plan.status === "already_applied"
        ? "No action is required."
        : legacyAdoption
          ? `Review the changes and the exact legacy bootstrap, then explicitly adopt and apply plan ${plan.plan_hash}.`
          : `Review the changes, then apply plan ${plan.plan_hash}.`,
      detail_level: planPresentation.detail_level,
      omitted_fields: planPresentation.omitted_fields,
      plan_complete: planPresentation.plan_complete,
      plan_hash_verification: planPresentation.plan_hash_verification,
      full_details: planPresentation.omitted_fields.length > 0
        ? "Repeat this read-only preview with --json --full to inspect and independently verify the complete v1 plan."
        : null,
      plan: planPresentation.plan,
    }, [
      "Configuration migration preview is ready; no files were changed.",
      `Impact: ${impact}`,
      plan.status === "already_applied"
        ? "Next: no action is required."
        : `Next: review the changes, then run \`agentic-sdlc config migrate${autonomyModeArgument} --apply --plan-hash ${plan.plan_hash}${legacyAdoptionArgument}\`.`,
      "",
      "Details:",
      `- Plan: ${plan.plan_hash}`,
      `- Mode: ${plan.mode}`,
      ...(legacyAdoption ? ["- Legacy bootstrap adoption: separate direct approval required"] : []),
      `- Reviewed changes: ${plan.changes.length}`,
      ...plan.changes.map(formatConfigMigrationChange),
    ]);
    return;
  }

  const expectedPlanHash = getOptionString(options, "plan-hash");
  if (!expectedPlanHash) {
    fail([
      "The configuration was not changed because an exact reviewed plan is required.",
      "Impact: the existing config and lock remain untouched.",
      "Next: run `agentic-sdlc config migrate`, review the preview, then rerun with `--apply --plan-hash <displayed-hash>`.",
    ].join("\n"));
  }

  const transactionRelease = acquireFileLock(path.join(context.sdlcRoot, "locks", "config-migration.lock"));
  let configBefore;
  let lockBefore = null;
  let lockExisted = false;
  let receiptPath = null;
  let receiptWritten = false;
  let application;
  let plan;
  let traceWarning = null;
  try {
    configBefore = readProjectText(context, context.projectConfigPath);
    const currentConfig = JSON.parse(configBefore);
    lockExisted = fs.existsSync(context.configLockPath);
    if (lockExisted) {
      lockBefore = readProjectText(context, context.configLockPath);
    }
    const currentLock = lockExisted ? JSON.parse(lockBefore) : null;
    plan = prepareProjectConfigMigration(context, currentConfig, currentLock, autonomyMode);
    const legacyAdoption = legacyBootstrapAdoptionSubject(
      context,
      currentConfig,
      currentLock,
      plan,
    );
    try {
      application = buildConfigMigrationApplyData({
        plan,
        current_project_config: currentConfig,
        current_lock: currentLock,
        expected_plan_hash: expectedPlanHash,
        applied_at: now(),
        audit: buildAttribution(context, options, "config.migrate"),
      });
      application = attachLegacyBootstrapAdoption(
        context,
        options,
        application,
        legacyAdoption,
      );
    } catch (error) {
      if (error instanceof TypeError) {
        fail([
          "The configuration was not changed because the reviewed plan no longer matches.",
          "Impact: the existing config and lock remain untouched.",
          "Next: run `agentic-sdlc config migrate` again and review the new plan.",
          `Technical detail: ${error.message}`,
        ].join("\n"));
      }
      throw error;
    }

    assertRecordSchema(application.lock, "effective-config-lock.schema.json", "Effective config lock");
    if (application.receipt) {
      assertRecordSchema(application.receipt, "config-migration-receipt.schema.json", "Config migration receipt");
    }
    if (application.status !== "already_applied") {
      writeJsonFile(context.projectConfigPath, application.config, { force: true });
      writeJsonFile(context.configLockPath, application.lock, { force: true });
      receiptPath = path.join(
        context.sdlcRoot,
        "migrations",
        "config",
        `${application.receipt.id}.json`,
      );
      writeJsonFile(receiptPath, application.receipt, { atomicCreate: true });
      receiptWritten = true;
    }
  } catch (error) {
    if (application?.status !== "already_applied" && configBefore !== undefined) {
      try {
        writeTextFile(context.projectConfigPath, configBefore, { force: true });
        if (lockExisted) {
          writeTextFile(context.configLockPath, lockBefore, { force: true });
        } else if (fs.existsSync(context.configLockPath)) {
          removePathGoverned(context.configLockPath, { force: true });
        }
        if (receiptWritten && receiptPath && fs.existsSync(receiptPath)) {
          removePathGoverned(receiptPath, { force: true });
        }
      } catch (rollbackError) {
        fail(`Configuration migration failed and rollback also failed: ${rollbackError.message}`);
      }
    }
    throw error;
  } finally {
    transactionRelease();
  }

  if (application.status !== "already_applied") {
    context.config = application.config;
    try {
      appendTraceEvent(context, null, {
        type: "decision",
        outcome: "passed",
        summary: "Pinned the reviewed effective project configuration",
        action: "config.migrate",
        actor: buildActor(options, context.root),
        evidence: [
          `${SDLC_DIR}/${PROJECT_CONFIG_FILE_NAME}`,
          `${SDLC_DIR}/${PROJECT_CONFIG_LOCK_FILE_NAME}`,
          toProjectPath(context, receiptPath),
        ],
        related: [application.receipt.id],
      });
    } catch (error) {
      traceWarning = `The migration was committed, but its optional trace could not be appended: ${error.message}`;
    }
  }

  output(options, {
    status: application.status === "already_applied" ? "already_applied" : "applied",
    plan_hash: plan.plan_hash,
    autonomy_mode: application.config.autonomy_policy?.mode || null,
    config_hash: application.lock.config_hash,
    lock_hash: application.lock.lock_hash,
    receipt: application.receipt
      ? { id: application.receipt.id, path: toProjectPath(context, receiptPath), hash: application.receipt.receipt_hash }
      : null,
    trace_warning: traceWarning,
  }, [
    application.status === "already_applied"
      ? "Configuration is already pinned; no files were changed."
      : "The reviewed configuration was pinned successfully.",
    application.status === "already_applied"
      ? "Impact: plugin updates still cannot change this project's policy silently."
      : "Impact: future plugin updates cannot change this project's effective policy silently.",
    "Next: continue with the governed project command you intended to run.",
    "",
    "Details:",
    `- Plan: ${plan.plan_hash}`,
    `- Autonomy mode: ${application.config.autonomy_policy?.mode || "not configured"}`,
    `- Config hash: ${application.lock.config_hash}`,
    `- Lock hash: ${application.lock.lock_hash}`,
    ...(application.receipt ? [`- Receipt: ${toProjectPath(context, receiptPath)}`] : []),
    ...(traceWarning ? [`- Warning: ${traceWarning}`] : []),
  ]);
}

export function decideOnboardExistingProjectRoute(context, decision, policy, actionConfig, confidenceOutcome) {
  decision.route = "onboard_existing_project";
  const baselines = readBaselines(context);
  addRouteCheck(
    decision,
    "baseline_exists",
    baselines.length > 0 ? "passed" : "failed",
    baselines.length > 0 ? baselines.map((baseline) => `${baseline.id}:${baseline.status}`).join(", ") : "No baseline records found",
  );
  if (baselines.length === 0) {
    decision.next_commands.push(`agentic-sdlc baseline propose --id BASELINE-INITIAL --document <path> --question "Which inferred facts are canonical?"`);
  } else {
    const latest = baselines.at(-1);
    decision.next_commands.push(`agentic-sdlc baseline status --id ${latest.id}`);
    if (latest.status === "proposed") {
      decision.next_commands.push(`agentic-sdlc baseline approve --id ${latest.id} --actor-type human --approval-source explicit-user --summary "<user-confirmed baseline>"`);
    }
  }
  return finalizeConcreteRoute(decision, policy, actionConfig, confidenceOutcome);
}

export function isKbInitialized(context) {
  return fs.existsSync(path.join(context.sdlcRoot, "project.json"));
}

export function initProject(context, options) {
  if (!fs.existsSync(context.sdlcRoot)) {
    const exactMutations = initBootstrapMutations(context);
    const grant = createBootstrapMutationGrant({
      root: context.root,
      canonical_action: "init",
      first_time: true,
      exact_mutations: exactMutations,
    });
    return consumeBootstrapMutationGrant(grant, () => {
      const result = initializeProject(context, options);
      output(options, result.payload, result.messages);
    });
  }
  const result = recoverInterruptedProjectBootstrap(context, options);
  output(options, result.payload, result.messages);
}

export function projectBootstrapDirectoryPaths(context) {
  const configuredDirectories = context.config.kb_directories.map((directory) =>
    path.resolve(
      context.sdlcRoot,
      ...String(directory).replaceAll("\\", "/").split("/"),
    ));
  const artifactParents = projectBootstrapArtifactSpecifications(context)
    .map((artifact) => path.dirname(artifact.path));
  return projectBootstrapDirectoryAncestorClosure(context, [
    ...configuredDirectories,
    path.join(context.sdlcRoot, "output-contracts", "templates"),
    path.join(context.sdlcRoot, "output-contracts", "decisions"),
    path.join(context.sdlcRoot, "work-items", "epics"),
    path.join(context.sdlcRoot, "work-items", "tasks"),
    ...artifactParents,
  ]);
}

export function projectBootstrapArtifactSpecifications(context) {
  return [
    { role: "config", path: path.join(context.sdlcRoot, PROJECT_CONFIG_FILE_NAME) },
    { role: "config_lock", path: path.join(context.sdlcRoot, PROJECT_CONFIG_LOCK_FILE_NAME) },
    { role: "project", path: path.join(context.sdlcRoot, "project.json") },
    { role: "readme", path: path.join(context.sdlcRoot, "README.md") },
    { role: "git_attributes", path: path.join(context.sdlcRoot, ".gitattributes") },
    { role: "git_ignore", path: path.join(context.sdlcRoot, ".gitignore") },
    {
      role: "output_contract_registry",
      path: path.join(context.sdlcRoot, "output-contracts", "registry.json"),
    },
    { role: "dependency_graph", path: path.join(context.sdlcRoot, "dependencies", "graph.json") },
    ...context.config.phase_order.map((phase) =>
      ({
        role: "phase_contract",
        id: `contract-${phase}-v1`,
        phase,
        path: path.join(context.sdlcRoot, "contracts", `contract-${phase}-v1.json`),
      })),
  ];
}

export function buildProjectBootstrapJournalRequest(context, options) {
  const projectName = String(options["project-name"] || path.basename(context.root));
  const projectId = String(options["project-id"] || slugify(projectName));
  const config = context.templateConfig || context.config;
  return {
    initial_project_identity_sha256: projectBootstrapInitialIdentityHash(
      projectId,
      projectName,
    ),
    plugin_version: VERSION,
    config_sha256: computeStableHash(config),
    phase_order: [...config.phase_order],
    kb_directories: [...config.kb_directories],
  };
}

export function sealProjectBootstrapJournal(journalBase) {
  const { journal_hash: _priorHash, ...hashSubject } = journalBase;
  const journal = {
    ...hashSubject,
    journal_hash: computeStableHash(hashSubject),
  };
  assertRecordSchema(
    journal,
    "project-bootstrap-journal.schema.json",
    "Project bootstrap journal",
  );
  return journal;
}

export function buildPreparedProjectBootstrapJournal(context, options) {
  const request = buildProjectBootstrapJournalRequest(context, options);
  const createdAt = now();
  return sealProjectBootstrapJournal({
    kind: "project_bootstrap_journal",
    schema_version: PROJECT_BOOTSTRAP_JOURNAL_SCHEMA_VERSION,
    version: 1,
    status: "prepared",
    request,
    request_hash: computeStableHash(request),
    prepared_manifest: null,
    completed_manifest_ref: null,
    previous_journal_hash: null,
    created_at: createdAt,
    updated_at: createdAt,
    hash_algorithm: "sha256:stable-json:v1",
  });
}

export function transitionProjectBootstrapJournal(journal, status, preparedManifest = null) {
  if (!["manifest_ready", "completed"].includes(status)) {
    fail(`Unsupported project bootstrap journal transition: ${status}`);
  }
  const manifest = preparedManifest || journal.prepared_manifest;
  if (!manifest) {
    fail("Project bootstrap journal transition requires its exact prepared manifest.");
  }
  const completedManifestRef = status === "completed"
    ? {
        path: `${SDLC_DIR}/${PROJECT_BOOTSTRAP_MANIFEST_FILE_NAME}`,
        schema_version: PROJECT_BOOTSTRAP_MANIFEST_SCHEMA_VERSION,
        manifest_hash: manifest.manifest_hash,
        hash_algorithm: "sha256:stable-json:v1",
      }
    : null;
  return sealProjectBootstrapJournal({
    ...journal,
    status,
    prepared_manifest: manifest,
    completed_manifest_ref: completedManifestRef,
    previous_journal_hash: journal.journal_hash,
    updated_at: now(),
  });
}

export function writeProjectBootstrapJournal(context, journal, options = {}) {
  const journalPath = projectBootstrapJournalPath(context);
  writeJsonFile(journalPath, journal, options);
  if (options.force) {
    // Forced journal transitions use an atomic rename. Flush the renamed file
    // and its directory explicitly so the recovery marker cannot lag the
    // manifest state after a crash.
    syncWorkflowFile(journalPath);
  }
}

export function validatePreparedProjectBootstrapRecovery(context, journal) {
  const manifest = journal.prepared_manifest;
  assertRecordSchema(
    manifest,
    "project-bootstrap-manifest.schema.json",
    "Prepared project bootstrap manifest",
  );
  const problems = [];
  const projectPath = path.join(context.sdlcRoot, "project.json");
  const configLockPath = path.join(context.sdlcRoot, PROJECT_CONFIG_LOCK_FILE_NAME);
  let project = null;
  let configLock = null;
  try {
    project = readProjectJson(context, projectPath);
    assertRecordSchema(project, "project.schema.json", "Project bootstrap project record");
    configLock = readProjectJson(context, configLockPath);
    assertRecordSchema(
      configLock,
      "effective-config-lock.schema.json",
      "Project bootstrap effective config lock",
    );
  } catch (error) {
    problems.push(`a required core record is unavailable or invalid (${error.message})`);
  }
  if (project) {
    appendProjectBootstrapManifestProblems(context, manifest, project, problems);
  }
  const expectedJournalRef = projectBootstrapJournalReference(journal.request_hash);
  if (
    stableJson(project?.bootstrap_journal) !== stableJson(expectedJournalRef)
    || stableJson(manifest.bootstrap_journal) !== stableJson(expectedJournalRef)
    || journal.request.initial_project_identity_sha256
      !== projectBootstrapInitialIdentityHash(
        project?.project_id,
        project?.project_name,
      )
  ) {
    problems.push("the project, manifest, and recovery journal do not bind the same bootstrap request");
  }
  if (
    configLock
    && configLock.lock_hash !== manifest.initial_config?.lock_hash
  ) {
    problems.push("the current configuration lock differs from the prepared bootstrap manifest");
  }
  for (const artifact of manifest.artifacts || []) {
    try {
      const artifactPath = resolveProjectFilePath(
        context,
        artifact.path,
        { mustExist: true, fileOnly: true },
      );
      const snapshot = readStableRegularFileBuffer(artifactPath, context.root);
      if (snapshot.sha256 !== artifact.initial_content_sha256) {
        problems.push(`${artifact.path} differs from the prepared byte snapshot`);
      }
    } catch (error) {
      problems.push(`${artifact.path || "unknown bootstrap artifact"} is unavailable (${error.message})`);
    }
  }
  for (const directory of manifest.directories || []) {
    try {
      const directoryPath = resolveProjectFilePath(
        context,
        directory,
        { mustExist: true, directoryOnly: true },
      );
      assertNoSymlinkSegmentsWithinBoundary(context.root, directoryPath);
    } catch (error) {
      problems.push(`${directory || "unknown bootstrap directory"} is unavailable (${error.message})`);
    }
  }
  if (problems.length > 0) {
    fail(
      `Interrupted ${SDLC_DIR} bootstrap cannot be recovered safely: ${problems.join("; ")}. `
      + "No files were changed. Preserve useful evidence and archive the incomplete "
      + `${SDLC_DIR} before starting a different project bootstrap.`,
    );
  }
  return { manifest, project, configLock };
}

export function recoverInterruptedProjectBootstrap(context, options) {
  const manifestPath = path.join(context.sdlcRoot, PROJECT_BOOTSTRAP_MANIFEST_FILE_NAME);
  const journalPath = projectBootstrapJournalPath(context);
  const manifestExists = pathEntryExistsNoFollow(manifestPath);
  if (!pathEntryExistsNoFollow(journalPath)) {
    if (manifestExists) {
      fail(
        `Project bootstrap is already sealed by ${toProjectPath(context, manifestPath)}. `
        + "Use the governed configuration and migration commands instead of reinitializing this knowledge base.",
      );
    }
    fail(
      `Existing ${SDLC_DIR} has no completed bootstrap manifest or hash-bound recovery journal. `
      + "No files were changed. --force cannot reset or reseal existing project governance. "
      + "A manifestless v0.11 project must use the explicit config migration and legacy-adoption flow; "
      + "otherwise restore the canonical bootstrap from version control or archive the incomplete directory.",
    );
  }
  const journal = readProjectBootstrapJournal(context);
  if (journal.status === "completed" && manifestExists) {
    fail(
      `Project bootstrap is already sealed by ${toProjectPath(context, manifestPath)}. `
      + "Use the governed configuration and migration commands instead of reinitializing this knowledge base.",
    );
  }
  const currentRequest = buildProjectBootstrapJournalRequest(context, options);
  if (
    journal.request_hash !== computeStableHash(currentRequest)
    || stableJson(journal.request) !== stableJson(currentRequest)
  ) {
    fail(
      `Existing ${SDLC_DIR} bootstrap belongs to a different exact initialization request. `
      + "No files were changed. --force cannot change the project identity or regenerate core records.",
    );
  }
  if (journal.status === "completed") {
    fail(
      `Completed project bootstrap is missing ${toProjectPath(context, manifestPath)}. `
      + "No files were changed. Restore the exact manifest from version control; --force cannot reseal it.",
    );
  }
  if (journal.status !== "manifest_ready") {
    fail(
      `Interrupted ${SDLC_DIR} bootstrap stopped before an exact byte snapshot was prepared. `
      + "No files were changed. Preserve useful evidence and archive the incomplete directory before retrying.",
    );
  }
  const { manifest, project, configLock } = validatePreparedProjectBootstrapRecovery(
    context,
    journal,
  );
  if (manifestExists) {
    const currentManifest = readProjectJson(context, manifestPath);
    if (stableJson(currentManifest) !== stableJson(manifest)) {
      fail(
        `Existing ${SDLC_DIR} bootstrap manifest differs from its hash-bound recovery journal. `
        + "No files were changed. Restore the canonical records from version control.",
      );
    }
  }
  const exactMutations = [
    { operation: "file.write", path: journalPath },
    ...(!manifestExists ? [{ operation: "file.write", path: manifestPath }] : []),
  ];
  const grant = createBootstrapMutationGrant({
    root: context.root,
    canonical_action: "init",
    first_time: true,
    exact_mutations: exactMutations,
  });
  return consumeBootstrapMutationGrant(grant, () => {
    if (!manifestExists) {
      syncProjectBootstrapState(context);
      validatePreparedProjectBootstrapRecovery(context, journal);
      writeJsonFile(manifestPath, manifest, {
        atomicCreate: true,
        durable: true,
      });
    }
    const completedJournal = transitionProjectBootstrapJournal(
      journal,
      "completed",
      manifest,
    );
    writeProjectBootstrapJournal(context, completedJournal, {
      force: true,
      durable: true,
    });
    return projectBootstrapRecoveryResult(context, project, configLock, manifest);
  });
}

export function initializeProject(context, options) {
  const projectName = String(options["project-name"] || path.basename(context.root));
  const projectId = String(options["project-id"] || slugify(projectName));
  const force = Boolean(options.force);
  const attribution = buildAttribution(context, options, "project.init");
  const config = context.templateConfig || context.config;
  const kbReadmeTemplate = readTemplateFile(context, "kb-readme.md");
  const bootstrapManifestPath = path.join(context.sdlcRoot, PROJECT_BOOTSTRAP_MANIFEST_FILE_NAME);
  if (pathEntryExistsNoFollow(bootstrapManifestPath)) {
    fail(
      `Project bootstrap is already sealed by ${toProjectPath(context, bootstrapManifestPath)}. `
      + "Use the governed configuration and migration commands instead of reinitializing this knowledge base.",
    );
  }
  context.config = config;
  const bootstrapJournal = buildPreparedProjectBootstrapJournal(context, options);
  const bootstrapJournalPath = projectBootstrapJournalPath(context);
  if (pathEntryExistsNoFollow(bootstrapJournalPath)) {
    fail(
      `Existing ${SDLC_DIR} bootstrap journal requires exact recovery; `
      + "normal initialization cannot overwrite it.",
    );
  }
  ensureDir(context.sdlcRoot);
  writeProjectBootstrapJournal(context, bootstrapJournal, {
    atomicCreate: true,
    durable: true,
  });

  for (const directoryPath of projectBootstrapDirectoryPaths(context)) {
    ensureDir(directoryPath);
  }
  const configPath = path.join(context.sdlcRoot, PROJECT_CONFIG_FILE_NAME);
  const configLockPath = path.join(context.sdlcRoot, PROJECT_CONFIG_LOCK_FILE_NAME);
  const configLock = buildEffectiveConfigLock({
    effective_config: config,
    config_path: `${SDLC_DIR}/${PROJECT_CONFIG_FILE_NAME}`,
    defaults_profile: context.templateDefaultsProfile,
    inherited_paths: [],
    created_at: now(),
  });
  assertRecordSchema(configLock, "effective-config-lock.schema.json", "Effective config lock");
  writeJsonFile(configPath, config, { force });
  writeJsonFile(configLockPath, configLock, { force });
  context.projectConfigPath = configPath;
  context.configLockPath = configLockPath;
  context.rawProjectConfig = config;
  context.projectConfigLock = configLock;
  context.configState = resolveEffectiveConfig({
    project_config: config,
    legacy_defaults: context.legacyConfig || context.templateConfig,
    defaults_profile: context.legacyDefaultsProfile || context.templateDefaultsProfile,
    lock: configLock,
    config_path: `${SDLC_DIR}/${PROJECT_CONFIG_FILE_NAME}`,
  });

  const projectPath = path.join(context.sdlcRoot, "project.json");
  const project = {
    project_id: projectId,
    project_name: projectName,
    schema_version: context.config.schema_version,
    sdlc_version: VERSION,
    created_at: now(),
    knowledge_base: {
      storage: "git",
      canonical_path: SDLC_DIR,
      stateless_plugin: true,
      concurrency_model: "story-scoped workspaces with append-only traces",
      source_of_truth: "JSON and Markdown files under .sdlc",
      derived_artifacts: ["cache", "indexes"],
      output_contracts_registry: `${SDLC_DIR}/output-contracts/registry.json`,
      cache_policy_path: `${SDLC_DIR}/cache/${CACHE_FILE_NAME}`,
    },
    bootstrap_manifest: {
      path: `${SDLC_DIR}/${PROJECT_BOOTSTRAP_MANIFEST_FILE_NAME}`,
      schema_version: PROJECT_BOOTSTRAP_MANIFEST_SCHEMA_VERSION,
    },
    bootstrap_journal: projectBootstrapJournalReference(
      bootstrapJournal.request_hash,
    ),
    phase_order: context.config.phase_order,
    audit: {
      created_by: attribution.actor,
      updated_by: attribution.actor,
      git: attribution.git,
      run: attribution.run,
    },
  };
  writeJsonFile(projectPath, project, { force });

  writeTextFile(
    path.join(context.sdlcRoot, "README.md"),
    renderTemplate(kbReadmeTemplate, { PROJECT_NAME: projectName }),
    { force },
  );

  writeTextFile(path.join(context.sdlcRoot, ".gitignore"), ["cache/**/*", "indexes/*.json", "reports/*.tmp", ""].join("\n"), {
    force,
  });
  writeTextFile(
    path.join(context.sdlcRoot, ".gitattributes"),
    [
      "*.json text eol=lf",
      "*.jsonl text eol=lf",
      "*.md text eol=lf",
      "*.txt text eol=lf",
      "*.docx binary",
      "*.gif binary",
      "*.jpeg binary",
      "*.jpg binary",
      "*.pdf binary",
      "*.png binary",
      "*.pptx binary",
      "*.xlsx binary",
      "",
    ].join("\n"),
    { force },
  );

  initializeOutputContracts(context, {
    force,
    attribution,
    project_id: projectId,
  });
  initializeDependencyGraph(context, { force, attribution });

  const createdContracts = [];
  for (const phase of context.config.phase_order) {
    const contract = buildContract(context, phase, {
      id: `contract-${phase}-v1`,
      status: "draft",
      audit_options: options,
      audit_action: "contract.bootstrap",
    });
    const contractPath = path.join(context.sdlcRoot, "contracts", `${contract.id}.json`);
    if (!fs.existsSync(contractPath) || force) {
      writeJsonFile(contractPath, contract, { force });
      createdContracts.push(contract.id);
    }
  }

  syncProjectBootstrapState(context);
  const bootstrapManifest = buildProjectBootstrapManifest(context, {
    configLock,
    projectId,
    journalRequestHash: bootstrapJournal.request_hash,
  });
  const manifestReadyJournal = transitionProjectBootstrapJournal(
    bootstrapJournal,
    "manifest_ready",
    bootstrapManifest,
  );
  writeProjectBootstrapJournal(context, manifestReadyJournal, {
    force: true,
    durable: true,
  });
  writeJsonFile(bootstrapManifestPath, bootstrapManifest, {
    atomicCreate: true,
    durable: true,
  });
  const completedJournal = transitionProjectBootstrapJournal(
    manifestReadyJournal,
    "completed",
    bootstrapManifest,
  );
  writeProjectBootstrapJournal(context, completedJournal, {
    force: true,
    durable: true,
  });

  return {
    payload: {
      status: "initialized",
      root: context.root,
      sdlc_root: context.sdlcRoot,
      project,
      config_lock: {
        path: `${SDLC_DIR}/${PROJECT_CONFIG_LOCK_FILE_NAME}`,
        hash: configLock.lock_hash,
      },
      bootstrap_manifest: {
        path: `${SDLC_DIR}/${PROJECT_BOOTSTRAP_MANIFEST_FILE_NAME}`,
        hash: bootstrapManifest.manifest_hash,
      },
      contracts_created: createdContracts,
    },
    messages: [
      `Initialized Agentic SDLC at ${path.relative(context.root, context.sdlcRoot) || SDLC_DIR}`,
      `Project: ${projectName} (${projectId})`,
      "Configuration pinned: plugin updates cannot silently change this project's policy.",
      `Bootstrap completion sealed: ${SDLC_DIR}/${PROJECT_BOOTSTRAP_MANIFEST_FILE_NAME}`,
      `Phase contracts available: ${context.config.phase_order.join(", ")}`,
    ],
  };
}

export function syncProjectBootstrapState(context) {
  const artifacts = projectBootstrapArtifactSpecifications(context);
  for (const artifact of artifacts) {
    syncWorkflowFile(artifact.path);
  }
  const directories = new Set([
    context.root,
    ...projectBootstrapDirectoryPaths(context),
  ].map((directoryPath) => path.resolve(directoryPath)));
  for (const directoryPath of [...directories].sort((left, right) => {
    const depthDifference = right.split(path.sep).length - left.split(path.sep).length;
    return depthDifference || right.localeCompare(left);
  })) {
    if (!isInsidePath(context.root, directoryPath)) {
      fail(`Project bootstrap durability path escapes the project root: ${directoryPath}`);
    }
    assertNoSymlinkSegmentsWithinBoundary(context.root, directoryPath);
    syncWorkflowDirectory(directoryPath);
  }
}

export function buildProjectBootstrapManifest(
  context,
  { configLock, projectId, journalRequestHash },
) {
  const artifacts = projectBootstrapArtifactSpecifications(context).map((artifact) => {
    const snapshot = readStableRegularFileBuffer(artifact.path, context.root);
    return {
      role: artifact.role,
      path: toProjectPath(context, artifact.path),
      initial_content_sha256: snapshot.sha256,
      ...(artifact.id ? { id: artifact.id } : {}),
      ...(artifact.phase ? { phase: artifact.phase } : {}),
    };
  });
  const configArtifact = artifacts.find((artifact) => artifact.role === "config");
  const configLockArtifact = artifacts.find((artifact) => artifact.role === "config_lock");
  if (!configArtifact || !configLockArtifact) {
    fail("Project bootstrap inventory is missing its configuration snapshots.");
  }
  const manifest = {
    kind: "project_bootstrap_manifest",
    schema_version: PROJECT_BOOTSTRAP_MANIFEST_SCHEMA_VERSION,
    version: 1,
    status: "completed",
    plugin_version: VERSION,
    project_binding_sha256: computeStableHash({ project_id: projectId }),
    bootstrap_journal: projectBootstrapJournalReference(journalRequestHash),
    initial_config: {
      path: `${SDLC_DIR}/${PROJECT_CONFIG_FILE_NAME}`,
      initial_content_sha256: configArtifact.initial_content_sha256,
      lock_path: `${SDLC_DIR}/${PROJECT_CONFIG_LOCK_FILE_NAME}`,
      initial_lock_content_sha256: configLockArtifact.initial_content_sha256,
      lock_hash: configLock.lock_hash,
    },
    phase_order: [...context.config.phase_order],
    kb_directories: [...context.config.kb_directories],
    directories: [...new Set(
      projectBootstrapDirectoryPaths(context)
        .map((directoryPath) => toProjectPath(context, directoryPath)),
    )],
    artifacts,
    completed_at: now(),
    audit: {
      actor: {
        id: "agentic-sdlc-bootstrap",
        type: "system",
        name: null,
        email: null,
        source: "bootstrap",
      },
    },
    hash_algorithm: "sha256:stable-json:v1",
  };
  manifest.manifest_hash = computeStableHash(manifest);
  assertRecordSchema(
    manifest,
    "project-bootstrap-manifest.schema.json",
    "Project bootstrap manifest",
  );
  return manifest;
}

export function onboardExistingProject(context, options) {
  const initializedBefore = pathEntryExistsNoFollow(context.sdlcRoot);
  let initialization = null;
  if (!initializedBefore) {
    initialization = initializeProject(context, options);
  } else {
    assertHealthyExistingBootstrapForOnboard(context);
    ensureInitialized(context);
  }

  const baseline = createBaselineProposal(context, {
    ...options,
    id: options.id || "BASELINE-INITIAL",
    kind: options.kind || "existing-project",
  });
  const baselineApprovalRequest = buildBaselineApprovalRequest(context, baseline.baseline);
  const assistantMessage = renderApprovalRequestsAssistantMessage([baselineApprovalRequest]);

  output(
    options,
    {
      status: "onboarded",
      initialized: !initializedBefore,
      init: initialization?.payload || null,
      baseline_path: baseline.baseline_path,
      report_path: baseline.report_path,
      baseline: baseline.baseline,
      assistant_message: assistantMessage,
      ...assistantMessagePresentationFields(),
      approval_request: baselineApprovalRequest,
      next_commands: [
        `agentic-sdlc baseline status --id ${baseline.baseline.id}`,
        `agentic-sdlc baseline approve --id ${baseline.baseline.id} --actor-type human --approval-source explicit-user --summary "<what the user confirmed>"`,
      ],
    },
    [
      initializedBefore ? "Existing SDLC KB found." : "Initialized SDLC KB.",
      `Proposed baseline ${baseline.baseline.id}`,
      "",
      ...assistantMessage.split("\n"),
    ],
  );
}

export function assertHealthyExistingBootstrapForOnboard(context) {
  const problems = [];
  const rootPath = context.sdlcRoot;
  const rootRelativePath = toProjectPath(context, rootPath);
  let rootEntry;
  try {
    rootEntry = fs.lstatSync(rootPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      problems.push(`${rootRelativePath} is missing`);
    } else {
      problems.push(`${rootRelativePath} cannot be inspected safely (${error.message})`);
    }
  }
  if (rootEntry && (rootEntry.isSymbolicLink() || !rootEntry.isDirectory())) {
    problems.push(`${rootRelativePath} is not a stable directory`);
  }
  if (problems.length > 0) {
    failIncompleteExistingBootstrap(problems);
  }

  const requireDirectory = (directoryPath) => {
    const relativePath = toProjectPath(context, directoryPath);
    try {
      const entry = fs.lstatSync(directoryPath);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        problems.push(`${relativePath} is not a stable directory`);
      }
    } catch (error) {
      if (error?.code === "ENOENT") {
        problems.push(`${relativePath} is missing`);
      } else {
        problems.push(`${relativePath} cannot be inspected safely (${error.message})`);
      }
    }
  };
  const readRequiredFile = (filePath) => {
    const relativePath = toProjectPath(context, filePath);
    try {
      const entry = fs.lstatSync(filePath);
      if (entry.isSymbolicLink() || !entry.isFile()) {
        problems.push(`${relativePath} is not a regular file`);
        return null;
      }
      return readProjectText(context, filePath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        problems.push(`${relativePath} is missing`);
      } else {
        problems.push(`${relativePath} cannot be read safely (${error.message})`);
      }
      return null;
    }
  };
  const readRequiredJson = (filePath, schemaName, label) => {
    const contents = readRequiredFile(filePath);
    if (contents === null) return null;
    const relativePath = toProjectPath(context, filePath);
    let record;
    try {
      record = JSON.parse(contents);
    } catch (error) {
      problems.push(`${relativePath} is not valid JSON (${error.message})`);
      return null;
    }
    const validation = validateRecordSchema(record, schemaName);
    if (!validation.valid) {
      const details = (validation.errors || [])
        .slice(0, 3)
        .map((issue) => `${issue.instance_path || "$"} ${issue.message}`)
        .join(", ");
      problems.push(`${relativePath} does not match ${label}${details ? ` (${details})` : ""}`);
      return null;
    }
    return record;
  };

  const configPath = path.join(rootPath, PROJECT_CONFIG_FILE_NAME);
  const configContents = readRequiredFile(configPath);
  let bootstrapConfig = null;
  if (configContents !== null) {
    try {
      bootstrapConfig = validateSdlcConfig(JSON.parse(configContents));
      if (
        context.projectConfigSnapshotHash === null
        || computeStableHash(bootstrapConfig) !== context.projectConfigSnapshotHash
      ) {
        problems.push(
          `${toProjectPath(context, configPath)} changed after the command context was loaded`,
        );
      }
    } catch (error) {
      problems.push(
        `${toProjectPath(context, configPath)} is not a valid SDLC configuration (${error.message})`,
      );
    }
  }

  const configLockPath = path.join(rootPath, PROJECT_CONFIG_LOCK_FILE_NAME);
  const configLock = readRequiredJson(
    configLockPath,
    "effective-config-lock.schema.json",
    "the effective configuration lock schema",
  );
  if (
    configLock
    && (
      context.projectConfigLockSnapshotHash === null
      || computeStableHash(configLock) !== context.projectConfigLockSnapshotHash
    )
  ) {
    problems.push(
      `${toProjectPath(context, configLockPath)} changed after the command context was loaded`,
    );
  }
  const projectPath = path.join(rootPath, "project.json");
  const project = readRequiredJson(projectPath, "project.schema.json", "the project schema");
  readRequiredFile(path.join(rootPath, "README.md"));

  if (bootstrapConfig && configLock) {
    try {
      const resolution = resolveEffectiveConfig({
        project_config: bootstrapConfig,
        lock: configLock,
        config_path: `${SDLC_DIR}/${PROJECT_CONFIG_FILE_NAME}`,
      });
      if (resolution.status !== "locked") {
        const details = (resolution.lock_verification?.errors || [])
          .slice(0, 3)
          .map((issue) => issue.message)
          .join(", ");
        problems.push(
          `${toProjectPath(context, configLockPath)} does not lock the current configuration`
          + `${details ? ` (${details})` : ""}`,
        );
      }
    } catch (error) {
      problems.push(
        `${toProjectPath(context, configLockPath)} cannot verify the current configuration (${error.message})`,
      );
    }
  }

  const effectiveConfig = bootstrapConfig || context.config;
  const registryPath = path.join(rootPath, "output-contracts", "registry.json");
  const registry = readRequiredJson(
    registryPath,
    "output-contract-registry.schema.json",
    "the output contract registry schema",
  );
  const dependencyGraphPath = path.join(rootPath, "dependencies", "graph.json");
  const dependencyGraph = readRequiredJson(
    dependencyGraphPath,
    "dependency-graph.schema.json",
    "the dependency graph schema",
  );

  if (project && bootstrapConfig) {
    if (!arraysEqual(project.phase_order, bootstrapConfig.phase_order)) {
      problems.push(
        `${toProjectPath(context, projectPath)} phase_order does not match the current configuration`,
      );
    }
    if (project.schema_version !== bootstrapConfig.schema_version) {
      problems.push(
        `${toProjectPath(context, projectPath)} schema_version does not match the current configuration`,
      );
    }
  }
  if (project) {
    if (project.knowledge_base?.canonical_path !== SDLC_DIR) {
      problems.push(`${toProjectPath(context, projectPath)} has an invalid canonical knowledge-base path`);
    }
    if (
      project.knowledge_base?.output_contracts_registry
      !== `${SDLC_DIR}/output-contracts/registry.json`
    ) {
      problems.push(`${toProjectPath(context, projectPath)} has an invalid output registry path`);
    }
  }
  if (project && registry) {
    if (registry.project_id !== project.project_id) {
      problems.push(
        `${toProjectPath(context, registryPath)} project_id does not match ${toProjectPath(context, projectPath)}`,
      );
    }
    if (bootstrapConfig && registry.schema_version !== bootstrapConfig.schema_version) {
      problems.push(
        `${toProjectPath(context, registryPath)} schema_version does not match the current configuration`,
      );
    }
  }
  if (
    dependencyGraph
    && bootstrapConfig
    && dependencyGraph.schema_version !== bootstrapConfig.schema_version
  ) {
    problems.push(
      `${toProjectPath(context, dependencyGraphPath)} schema_version does not match the current configuration`,
    );
  }

  const bootstrapManifestPath = path.join(rootPath, PROJECT_BOOTSTRAP_MANIFEST_FILE_NAME);
  if (pathEntryExistsNoFollow(bootstrapManifestPath)) {
    const manifest = readRequiredJson(
      bootstrapManifestPath,
      "project-bootstrap-manifest.schema.json",
      "the project bootstrap manifest schema",
    );
    if (manifest) {
      appendProjectBootstrapManifestProblems(context, manifest, project, problems);
      appendProjectBootstrapJournalProblems(
        context,
        manifest,
        project,
        problems,
        readRequiredJson,
      );
    }
    if (
      project
      && (
        project.bootstrap_manifest?.path !== `${SDLC_DIR}/${PROJECT_BOOTSTRAP_MANIFEST_FILE_NAME}`
        || project.bootstrap_manifest?.schema_version !== PROJECT_BOOTSTRAP_MANIFEST_SCHEMA_VERSION
      )
    ) {
      problems.push(
        `${toProjectPath(context, projectPath)} does not bind the canonical bootstrap manifest`,
      );
    }
  } else if (project?.bootstrap_manifest) {
    problems.push(
      `${toProjectPath(context, bootstrapManifestPath)} is missing even though the project expects the completed bootstrap record`,
    );
  } else if (project && projectVersionRequiresBootstrapManifest(project.sdlc_version)) {
    problems.push(
      `${toProjectPath(context, bootstrapManifestPath)} is missing for a project created by Agentic SDLC `
      + `${project.sdlc_version || "an unknown version"}; version `
      + `${PROJECT_BOOTSTRAP_MANIFEST_INTRODUCED_VERSION} and later require the completed bootstrap record`,
    );
  } else if (project && bootstrapConfig && configLock && registry && dependencyGraph) {
    if (!hasMatchingLegacyConfigMigrationReceipt(context, bootstrapConfig, configLock)) {
      problems.push(
        `${toProjectPath(context, bootstrapManifestPath)} is missing and no matching first-lock migration receipt proves a legacy bootstrap; changing the project version cannot bypass the completed bootstrap record`,
      );
    } else {
      appendLegacyBootstrapEvidenceProblems(context, effectiveConfig, {
        problems,
        readRequiredFile,
        readRequiredJson,
        requireDirectory,
      });
    }
  }

  if (problems.length === 0) return;
  failIncompleteExistingBootstrap(problems);
}

export function hasMatchingLegacyConfigMigrationReceipt(context, bootstrapConfig, configLock) {
  const migrationDirectory = path.join(context.sdlcRoot, "migrations", "config");
  const configHash = computeStableHash(bootstrapConfig);
  const project = readProjectJson(context, path.join(context.sdlcRoot, "project.json"));
  const legacyConfig = validateSdlcConfig(
    readJson(path.join(DEFAULT_TEMPLATE_DIR, "config-compat", "sdlc-config-v1-0.11.0.json")),
  );
  const expectedLegacyProfile = buildLegacyDefaultsProfile(legacyConfig);
  return safeReadDir(migrationDirectory)
    .filter((entry) => entry.endsWith(".json"))
    .some((entry) => {
      const receipt = readProjectJson(context, path.join(migrationDirectory, entry));
      const validation = validateRecordSchema(receipt, "config-migration-receipt.schema.json");
      if (!validation.valid) return false;
      const { receipt_hash: storedHash, ...hashSubject } = receipt;
      const adoption = receipt.legacy_bootstrap_adoption;
      if (!adoption) return false;
      const {
        approval,
        hash_algorithm: adoptionHashAlgorithm,
        adoption_hash: adoptionHash,
        ...adoptionSubject
      } = adoption;
      const approvalEvidencePresent = Boolean(approval?.summary)
        || (Array.isArray(approval?.evidence) && approval.evidence.length > 0);
      if (
        adoptionHashAlgorithm !== "sha256:stable-json:v1"
        || adoptionHash !== computeStableHash({
          ...adoptionSubject,
          approval,
          hash_algorithm: adoptionHashAlgorithm,
        })
        || adoptionSubject.project_ref?.id !== project.project_id
        || adoptionSubject.project_ref?.path !== `${SDLC_DIR}/project.json`
        || adoptionSubject.project_ref?.sdlc_version !== project.sdlc_version
        || adoptionSubject.project_ref?.content_sha256 !== computeStableHash(project)
        || adoptionSubject.source_config_sha256 !== receipt.source_config_hash
        || computeStableHash(adoptionSubject.legacy_defaults_profile)
          !== computeStableHash(expectedLegacyProfile)
        || adoptionSubject.plan_hash !== receipt.plan_hash
        || approval?.status !== "approved"
        || !["explicit-user", "ci"].includes(approval?.approval_source)
        || !hasFormalApprovalAttribution(approval?.approved_by, approval?.approval_source)
        || !approvalEvidencePresent
        || approval?.approved_content_hash !== hashApprovalSubject(adoptionSubject)
        || approval?.hash_algorithm !== "sha256:stable-json:v1"
      ) {
        return false;
      }
      try {
        validateApprovalEvidenceIntegrity(
          context,
          approval,
          `Legacy bootstrap adoption ${approval.id || "unknown"}`,
        );
      } catch {
        return false;
      }
      return storedHash === computeStableHash(hashSubject)
        && ["materialize_legacy_defaults", "adopt_lock"].includes(receipt.mode)
        && receipt.config_path === `${SDLC_DIR}/${PROJECT_CONFIG_FILE_NAME}`
        && receipt.lock_path === `${SDLC_DIR}/${PROJECT_CONFIG_LOCK_FILE_NAME}`
        && receipt.target_config_hash === configHash
        && receipt.effective_config_hash === configHash
        && receipt.lock_hash === configLock.lock_hash
        && receipt.applied_at === configLock.created_at
        && computeStableHash(receipt.defaults_profile) === computeStableHash(configLock.defaults_profile)
        && arraysEqual(receipt.inherited_paths, configLock.inherited_paths);
    });
}

export function appendProjectBootstrapManifestProblems(context, manifest, project, problems) {
  const { manifest_hash: storedHash, ...hashSubject } = manifest;
  if (storedHash !== computeStableHash(hashSubject)) {
    problems.push(
      `${SDLC_DIR}/${PROJECT_BOOTSTRAP_MANIFEST_FILE_NAME} manifest_hash does not match its content`,
    );
  }
  if (project) {
    if (manifest.plugin_version !== project.sdlc_version) {
      problems.push(
        `${SDLC_DIR}/${PROJECT_BOOTSTRAP_MANIFEST_FILE_NAME} SDLC version does not match ${SDLC_DIR}/project.json`,
      );
    }
    if (
      manifest.project_binding_sha256
      !== computeStableHash({ project_id: project.project_id })
    ) {
      problems.push(
        `${SDLC_DIR}/${PROJECT_BOOTSTRAP_MANIFEST_FILE_NAME} belongs to a different project`,
      );
    }
    if (!arraysEqual(manifest.phase_order, project.phase_order)) {
      problems.push(
        `${SDLC_DIR}/${PROJECT_BOOTSTRAP_MANIFEST_FILE_NAME} phase_order does not match ${SDLC_DIR}/project.json`,
      );
    }
  }

  const expectedArtifacts = [
    ["config", `${SDLC_DIR}/${PROJECT_CONFIG_FILE_NAME}`, null],
    ["config_lock", `${SDLC_DIR}/${PROJECT_CONFIG_LOCK_FILE_NAME}`, null],
    ["project", `${SDLC_DIR}/project.json`, null],
    ["readme", `${SDLC_DIR}/README.md`, null],
    ["git_attributes", `${SDLC_DIR}/.gitattributes`, null],
    ["git_ignore", `${SDLC_DIR}/.gitignore`, null],
    ["output_contract_registry", `${SDLC_DIR}/output-contracts/registry.json`, null],
    ["dependency_graph", `${SDLC_DIR}/dependencies/graph.json`, null],
    ...manifest.phase_order.map((phase) => [
      "phase_contract",
      `${SDLC_DIR}/contracts/contract-${phase}-v1.json`,
      phase,
    ]),
  ];
  if (manifest.artifacts.length !== expectedArtifacts.length) {
    problems.push(
      `${SDLC_DIR}/${PROJECT_BOOTSTRAP_MANIFEST_FILE_NAME} does not contain the exact initial artifact inventory`,
    );
  }
  for (const [role, artifactPath, phase] of expectedArtifacts) {
    const matches = manifest.artifacts.filter((artifact) =>
      artifact.role === role
      && artifact.path === artifactPath
      && (phase === null || (artifact.phase === phase && artifact.id === `contract-${phase}-v1`)));
    if (matches.length !== 1) {
      problems.push(
        `${SDLC_DIR}/${PROJECT_BOOTSTRAP_MANIFEST_FILE_NAME} does not prove initial artifact ${artifactPath}`,
      );
    }
  }
  const configArtifact = manifest.artifacts.find((artifact) => artifact.role === "config");
  const configLockArtifact = manifest.artifacts.find((artifact) => artifact.role === "config_lock");
  if (
    manifest.initial_config.path !== `${SDLC_DIR}/${PROJECT_CONFIG_FILE_NAME}`
    || manifest.initial_config.initial_content_sha256 !== configArtifact?.initial_content_sha256
    || manifest.initial_config.lock_path !== `${SDLC_DIR}/${PROJECT_CONFIG_LOCK_FILE_NAME}`
    || manifest.initial_config.initial_lock_content_sha256
      !== configLockArtifact?.initial_content_sha256
  ) {
    problems.push(
      `${SDLC_DIR}/${PROJECT_BOOTSTRAP_MANIFEST_FILE_NAME} initial configuration references are inconsistent`,
    );
  }

  const expectedDirectoryCandidates = [
    ...manifest.kb_directories.map((directory) =>
      path.resolve(
        context.sdlcRoot,
        ...String(directory).replaceAll("\\", "/").split("/"),
      )),
    path.join(context.sdlcRoot, "output-contracts", "templates"),
    path.join(context.sdlcRoot, "output-contracts", "decisions"),
    path.join(context.sdlcRoot, "work-items", "epics"),
    path.join(context.sdlcRoot, "work-items", "tasks"),
    ...expectedArtifacts.map(([, artifactPath]) =>
      path.dirname(path.resolve(context.root, ...artifactPath.split("/")))),
  ];
  let expectedDirectories = new Set();
  try {
    expectedDirectories = new Set(
      projectBootstrapDirectoryAncestorClosure(context, expectedDirectoryCandidates)
        .map((directoryPath) => toProjectPath(context, directoryPath)),
    );
  } catch (error) {
    problems.push(
      `${SDLC_DIR}/${PROJECT_BOOTSTRAP_MANIFEST_FILE_NAME} has an unsafe initial directory inventory (${error.message})`,
    );
  }
  const recordedDirectories = new Set(manifest.directories);
  if (
    expectedDirectories.size !== recordedDirectories.size
    || [...expectedDirectories].some((directory) => !recordedDirectories.has(directory))
  ) {
    problems.push(
      `${SDLC_DIR}/${PROJECT_BOOTSTRAP_MANIFEST_FILE_NAME} does not contain the exact initial directory inventory`,
    );
  }
}

export function appendProjectBootstrapJournalProblems(
  context,
  manifest,
  project,
  problems,
  readRequiredJson,
) {
  const journalPath = projectBootstrapJournalPath(context);
  const manifestRef = manifest.bootstrap_journal || null;
  const projectRef = project?.bootstrap_journal || null;
  const journalExists = pathEntryExistsNoFollow(journalPath);
  if (!manifestRef && !projectRef && !journalExists) {
    // Backward compatibility for projects sealed before the recovery journal
    // was introduced.
    return;
  }
  if (!manifestRef || !projectRef || stableJson(manifestRef) !== stableJson(projectRef)) {
    problems.push(
      `${SDLC_DIR}/${PROJECT_BOOTSTRAP_JOURNAL_FILE_NAME} is not bound consistently by the project and bootstrap manifest`,
    );
    return;
  }
  const expectedRef = projectBootstrapJournalReference(manifestRef.request_hash);
  if (stableJson(manifestRef) !== stableJson(expectedRef)) {
    problems.push(
      `${SDLC_DIR}/${PROJECT_BOOTSTRAP_JOURNAL_FILE_NAME} reference is invalid`,
    );
    return;
  }
  const journal = readRequiredJson(
    journalPath,
    "project-bootstrap-journal.schema.json",
    "the project bootstrap journal schema",
  );
  if (!journal) return;
  const { journal_hash: storedHash, ...hashSubject } = journal;
  if (
    storedHash !== computeStableHash(hashSubject)
    || journal.request_hash !== computeStableHash(journal.request)
  ) {
    problems.push(
      `${SDLC_DIR}/${PROJECT_BOOTSTRAP_JOURNAL_FILE_NAME} integrity hashes do not match its content`,
    );
  }
  if (
    journal.status !== "completed"
    || journal.request_hash !== manifestRef.request_hash
    || stableJson(journal.prepared_manifest) !== stableJson(manifest)
    || journal.completed_manifest_ref?.path
      !== `${SDLC_DIR}/${PROJECT_BOOTSTRAP_MANIFEST_FILE_NAME}`
    || journal.completed_manifest_ref?.schema_version
      !== PROJECT_BOOTSTRAP_MANIFEST_SCHEMA_VERSION
    || journal.completed_manifest_ref?.manifest_hash !== manifest.manifest_hash
    || journal.completed_manifest_ref?.hash_algorithm
      !== "sha256:stable-json:v1"
  ) {
    problems.push(
      `${SDLC_DIR}/${PROJECT_BOOTSTRAP_JOURNAL_FILE_NAME} does not prove completion of this exact bootstrap manifest`,
    );
  }
}

export function appendLegacyBootstrapEvidenceProblems(context, config, helpers) {
  const { problems, readRequiredFile, readRequiredJson, requireDirectory } = helpers;
  readRequiredFile(path.join(context.sdlcRoot, ".gitignore"));
  const legacyDirectories = [
    context.sdlcRoot,
    ...config.kb_directories.map((directory) => path.join(context.sdlcRoot, directory)),
    path.join(context.sdlcRoot, "output-contracts", "templates"),
    path.join(context.sdlcRoot, "output-contracts", "decisions"),
    path.join(context.sdlcRoot, "work-items", "epics"),
    path.join(context.sdlcRoot, "work-items", "tasks"),
  ];
  for (const directoryPath of new Set(legacyDirectories)) {
    requireDirectory(directoryPath);
  }
  for (const phase of config.phase_order) {
    const expectedId = `contract-${phase}-v1`;
    const contractPath = path.join(context.sdlcRoot, "contracts", `${expectedId}.json`);
    const contract = readRequiredJson(
      contractPath,
      "contract.schema.json",
      "the legacy bootstrap phase contract schema",
    );
    if (contract && (contract.id !== expectedId || contract.phase !== phase)) {
      problems.push(
        `${toProjectPath(context, contractPath)} is not the expected legacy bootstrap contract for phase '${phase}'`,
      );
    }
  }
}

export function deliveryConcreteIdentity(kind, target) {
  if (kind === "pull_request") {
    return {
      kind,
      repository: normalizeGitRepositoryIdentity(target.pull_request_target?.repository),
      base_branch: target.pull_request_target?.base_branch,
      head_branch: target.pull_request_target?.head_branch,
      mode: target.pull_request_target?.mode || "new",
      pr_number: target.pull_request_target?.pr_number ?? null,
      pr_url: target.pull_request_target?.pr_url ?? null,
    };
  }
  return {
    kind,
    root_path: plannedRealPath(target.local_release_target?.root_path),
  };
}

export function dataMigrationPreviewEvidenceErrors(context, migration) {
  const errors = [];
  if (!migration || !Array.isArray(migration.preview_evidence) || migration.preview_evidence.length === 0) {
    return ["declared local data migration has no immutable dry-run or preview evidence"];
  }
  for (const evidence of migration.preview_evidence) {
    try {
      const evidencePath = resolveProjectFilePath(
        context,
        evidence.path,
        { mustExist: true, fileOnly: true },
      );
      assertNotDerivedArtifact(context, evidencePath, "Data migration preview evidence");
      if (hashFile(evidencePath) !== evidence.sha256) {
        errors.push(`data migration preview evidence changed after approval: ${evidence.path}`);
      }
    } catch (error) {
      errors.push(`data migration preview evidence is unavailable: ${evidence?.path || "unknown"} (${error.message})`);
    }
  }
  return errors;
}

export function assertDataMigrationPreviewEvidenceCurrent(context, migration) {
  const errors = dataMigrationPreviewEvidenceErrors(context, migration);
  if (errors.length > 0) {
    fail(`Local data migration preview is invalid: ${errors.join("; ")}.`);
  }
}

export function initializeDependencyGraph(context, options = {}) {
  ensurePlanningDirectories(context);
  const graphPath = dependencyGraphPath(context);
  if (fs.existsSync(graphPath) && !options.force) {
    return readProjectJson(context, graphPath);
  }
  const attribution = options.attribution || buildAttribution(context, {}, "dependency.graph.init");
  const graph = {
    schema_version: context.config.schema_version,
    status: "approved",
    edges: [],
    updated_at: now(),
    audit: {
      created_by: attribution.actor,
      updated_by: attribution.actor,
      git: attribution.git,
      run: attribution.run,
    },
  };
  writeJsonFile(graphPath, graph, { force: true });
  return graph;
}

export function initializeOutputContracts(context, options = {}) {
  const root = outputContractsRoot(context);
  ensureDir(root);
  ensureDir(path.join(root, "templates"));
  ensureDir(path.join(root, "decisions"));

  const registryPath = outputRegistryPath(context);
  if (fs.existsSync(registryPath) && !options.force) {
    return readProjectJson(context, registryPath);
  }

  const project = readProjectSafe(context);
  const attribution = options.attribution || buildAttribution(context, {}, "output.registry.init");
  const registry = {
    schema_version: context.config.schema_version,
    project_id: options.project_id || project?.project_id || null,
    status: "active",
    policy: {
      template_registry_scope: "project",
      default_related_story_mode: "reuse+delta",
      approvals_required_for_new_templates: true,
      cache_is_source_of_truth: false,
    },
    templates: [],
    links: [],
    decisions: [],
    created_at: now(),
    updated_at: now(),
    audit: {
      created_by: attribution.actor,
      updated_by: attribution.actor,
      git: attribution.git,
      run: attribution.run,
    },
  };
  writeJsonFile(registryPath, registry, { force: Boolean(options.force) });
  return registry;
}

export function archiveClosedArtifacts(context, options) {
  ensureInitialized(context);
  const beforeDate = parseDateBoundary(options.before || "90d", "before");
  const candidates = collectArchiveCandidates(context, beforeDate);
  const planId = normalizeId(`ARCH-${uniqueRecordSuffix()}`);
  const plan = {
    id: planId,
    kind: "archive_plan",
    schema_version: context.config.schema_version,
    generated_at: now(),
    cutoff_before: beforeDate.toISOString(),
    apply_requested: Boolean(options.apply),
    applied: false,
    candidates,
    source_paths: candidates.map((candidate) => candidate.source_path),
    source_hashes: buildSourceHashMap(context, candidates.map((candidate) => candidate.source_path)),
    policy: "Only closed reports and trace compactions are eligible; live story, contract, trace JSONL, and approval files are not moved.",
    audit: {
      generated_by: buildAttribution(context, options, "archive.closed").actor,
      git: buildGitMetadata(context.root),
      run: buildRunMetadata(options),
    },
  };
  const planPath = options.out
    ? resolveProjectFilePath(context, options.out, { mustExist: false })
    : path.join(context.sdlcRoot, "archive", `${planId}.json`);
  assertNotDerivedArtifact(context, planPath, "Archive plan");
  if (fs.existsSync(planPath) && !options.force) {
    fail(`Archive plan already exists: ${toProjectPath(context, planPath)}. Use --force to overwrite it.`);
  }
  const reservedPaths = new Set(
    candidates.flatMap((candidate) => [candidate.source_path, candidate.target_path]).map((entry) =>
      resolveProjectFilePath(context, entry, { mustExist: false }),
    ),
  );
  if (reservedPaths.has(planPath)) {
    fail("Archive plan path must be separate from every archive source and target.");
  }
  if (options.apply) {
    plan.applied = true;
    applyArchiveCandidates(context, candidates, { force: Boolean(options.force) }, () => {
      writeJsonFile(planPath, plan, { force: Boolean(options.force) });
    });
  } else {
    writeJsonFile(planPath, plan, { force: Boolean(options.force) });
  }
  output(
    options,
    { status: plan.applied ? "archived" : "planned", plan_path: planPath, plan },
    [
      `${plan.applied ? "Archived" : "Planned archive for"} ${candidates.length} closed artifacts`,
      `Archive plan: ${toProjectPath(context, planPath)}`,
    ],
  );
}

export function applyArchiveCandidates(context, candidates, options = {}, commit = () => {}) {
  const releaseLock = acquireFileLock(path.join(context.sdlcRoot, "archive", "archive.lock"));
  const operations = [];
  const completed = [];
  const backups = [];
  try {
    for (const candidate of candidates) {
      const sourcePath = resolveProjectFilePath(context, candidate.source_path, { mustExist: true, fileOnly: true });
      const targetPath = resolveProjectFilePath(context, candidate.target_path, { mustExist: false });
      assertNoSymlinkPathSegments(sourcePath, context.root);
      assertNoSymlinkPathSegments(targetPath, context.root);
      if (hashFile(sourcePath) !== candidate.sha256) {
        fail(`Archive source changed after planning: ${candidate.source_path}`);
      }
      if (fs.existsSync(targetPath)) {
        if (!options.force) {
          fail(`Archive target already exists: ${candidate.target_path}. Use --force to overwrite after review.`);
        }
        if (!fs.lstatSync(targetPath).isFile()) {
          fail(`Archive target is not a regular file: ${candidate.target_path}`);
        }
      }
      operations.push({ candidate, sourcePath, targetPath });
    }

    for (const operation of operations) {
      ensureDir(path.dirname(operation.targetPath));
      if (fs.existsSync(operation.targetPath)) {
        const backupPath = `${operation.targetPath}.backup-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
        renamePathGoverned(operation.targetPath, backupPath);
        backups.push({ targetPath: operation.targetPath, backupPath });
      }
      renamePathGoverned(operation.sourcePath, operation.targetPath);
      completed.push(operation);
    }
    for (const operation of completed) {
      operation.candidate.applied = true;
    }
    commit();
    for (const backup of backups) {
      try {
        removePathGoverned(backup.backupPath, { force: true });
      } catch {
        // The archive is committed; an orphaned backup is safer than rolling it back incompletely.
      }
    }
  } catch (error) {
    for (const operation of completed) {
      operation.candidate.applied = false;
    }
    for (const operation of [...completed].reverse()) {
      try {
        if (fs.existsSync(operation.targetPath) && !fs.existsSync(operation.sourcePath)) {
          ensureDir(path.dirname(operation.sourcePath));
          renamePathGoverned(operation.targetPath, operation.sourcePath);
        }
      } catch {
        // Continue restoring the remaining files; the final error reports the failed transaction.
      }
    }
    for (const backup of [...backups].reverse()) {
      try {
        if (fs.existsSync(backup.backupPath)) {
          renamePathGoverned(backup.backupPath, backup.targetPath);
        }
      } catch {
        // Best effort rollback for a filesystem-level failure.
      }
    }
    if (error instanceof UserError) {
      throw error;
    }
    fail(`Archive transaction failed and was rolled back: ${error.message}`);
  } finally {
    releaseLock();
  }
}

export function collectArchiveCandidates(context, beforeDate) {
  const eligibleRoots = [
    { root: path.join(context.sdlcRoot, "reports"), reason: "closed-report" },
    { root: path.join(context.sdlcRoot, "traces", "compactions"), reason: "trace-compaction" },
  ];
  const candidates = [];
  for (const entry of eligibleRoots) {
    for (const filePath of walkFiles(entry.root)) {
      if (!shouldIndexFile(context, filePath)) {
        continue;
      }
      const stat = fs.statSync(filePath);
      if (stat.mtime.getTime() >= beforeDate.getTime()) {
        continue;
      }
      const relativeSource = toProjectPath(context, filePath);
      const archiveRelative = path.posix.join(
        SDLC_DIR,
        "archive",
        String(stat.mtime.getUTCFullYear()),
        String(stat.mtime.getUTCMonth() + 1).padStart(2, "0"),
        path.relative(context.sdlcRoot, filePath).split(path.sep).join("/"),
      );
      candidates.push({
        source_path: relativeSource,
        target_path: archiveRelative,
        reason: entry.reason,
        size_bytes: stat.size,
        mtime: stat.mtime.toISOString(),
        sha256: hashFile(filePath),
        applied: false,
      });
    }
  }
  return candidates.sort((a, b) => a.source_path.localeCompare(b.source_path));
}

export function readLogicalArchiveRecords(context, releaseManifestId) {
  const root = logicalArchiveRoot(context);
  return safeReadDir(root)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const filePath = path.join(root, name);
      let record;
      try {
        record = readProjectJson(context, filePath);
      } catch {
        return null;
      }
      if (record.kind !== "archive_record" || record.release_manifest_ref?.id !== releaseManifestId) {
        return null;
      }
      assertRecordSchema(record, "archive-record.schema.json", `Logical archive record ${record.id}`);
      const { record_hash: actualHash, hash_algorithm: _algorithm, ...hashSubject } = record;
      if (actualHash !== shortHashFull(stableJson(hashSubject))) {
        fail(`Logical archive record ${record.id} failed integrity validation.`);
      }
      if (path.resolve(filePath) !== path.resolve(path.join(root, `${normalizeId(record.id)}.json`))) {
        fail(`Logical archive record ${record.id} is not stored at its canonical id-bound path.`);
      }
      const artifactPaths = (record.artifacts || []).map((artifact) => artifact.path).sort();
      const sourcePaths = [...(record.source_paths || [])].sort();
      const hashedPaths = Object.keys(record.source_hashes || {}).sort();
      if (stableJson(artifactPaths) !== stableJson(sourcePaths) || stableJson(sourcePaths) !== stableJson(hashedPaths)) {
        fail(`Logical archive record ${record.id} has an incomplete artifact/source path inventory.`);
      }
      for (const artifact of record.artifacts || []) {
        if (record.source_hashes?.[artifact.path] !== artifact.sha256) {
          fail(`Logical archive record ${record.id} has inconsistent hashes for ${artifact.path}.`);
        }
      }
      return { record, filePath };
    })
    .filter(Boolean)
    .sort((left, right) => String(left.record.generated_at).localeCompare(String(right.record.generated_at)));
}

export function prepareLogicalArchiveRecord(context, manifest, manifestFile, historical, attribution, reason, options = {}) {
  if (historical.artifacts.length === 0) {
    return { record: null, filePath: null, idempotent: true };
  }
  const prior = readLogicalArchiveRecords(context, manifest.id)
    .filter((entry) => entry.record.status === "active")
    .at(-1) || null;
  const sourcePaths = historical.artifacts.map((artifact) => artifact.path);
  const sourceHashes = Object.fromEntries(historical.artifacts.map((artifact) => [artifact.path, artifact.sha256]));
  if (
    prior &&
    prior.record.status === "active" &&
    prior.record.release_manifest_ref?.id === manifest.id &&
    prior.record.release_manifest_ref?.path === toProjectPath(context, manifestFile) &&
    prior.record.release_manifest_ref?.hash === manifest.manifest_hash &&
    (options.reason_explicit !== true || prior.record.reason === reason) &&
    stableJson(prior.record.artifacts) === stableJson(historical.artifacts) &&
    stableJson(prior.record.source_paths) === stableJson(sourcePaths) &&
    stableJson(prior.record.source_hashes) === stableJson(sourceHashes)
  ) {
    return { record: prior.record, filePath: prior.filePath, idempotent: true };
  }
  const id = normalizeId(`ARCH-${manifest.id}-${uniqueRecordSuffix()}`);
  const record = {
    id,
    kind: "archive_record",
    schema_version: "archive-record:v1",
    status: "active",
    release_manifest_ref: {
      id: manifest.id,
      path: toProjectPath(context, manifestFile),
      hash: manifest.manifest_hash,
    },
    legacy_history_policy: "logically_archived_out_of_release_scope",
    reason,
    artifacts: historical.artifacts,
    source_paths: sourcePaths,
    source_hashes: sourceHashes,
    supersedes_ref: prior
      ? { id: prior.record.id, path: toProjectPath(context, prior.filePath), hash: prior.record.record_hash }
      : null,
    generated_at: now(),
    audit: {
      generated_by: attribution.actor,
      git: attribution.git,
      run: attribution.run,
    },
  };
  record.record_hash = shortHashFull(stableJson(record));
  record.hash_algorithm = "sha256:stable-json:v1";
  assertRecordSchema(record, "archive-record.schema.json", `Logical archive record ${id}`);
  return { record, filePath: path.join(logicalArchiveRoot(context), `${id}.json`), idempotent: false };
}

export function prepareActiveReleaseMigration(context, options, manifestInput) {
  const { filePath: manifestFile, manifest } = readReleaseManifest(context, manifestInput);
  assertReleaseManifestIntegrity(context, manifest);
  const selection = assertLatestReleasedManifestSelected(context, manifest, manifestFile);
  const activeRecordCount = validateActiveManifestRecordSchemas(context, manifest);
  const historical = collectHistoricalReleaseArtifacts(context, manifest, manifestFile);
  historical.quarantined_releases = Array.from(new Map([
    ...(selection.quarantined_releases || []),
    ...(historical.quarantined_releases || []),
  ].map((entry) => [`${entry.id || ""}:${entry.path}`, entry])).values());
  const configPath = path.join(context.sdlcRoot, PROJECT_CONFIG_FILE_NAME);
  const rawConfig = readProjectJson(context, configPath);
  const migratedConfig = rawConfig;
  const configUpdateRequired = context.configState.status !== "locked";
  const attribution = buildAttribution(context, options, "migration.active");
  const explicitReason = getOptionString(options, "reason");
  const reason = explicitReason || `Retain evidence from releases older than ${manifest.id} while excluding it from the exact active release scope.`;
  const preparedArchive = prepareLogicalArchiveRecord(
    context,
    manifest,
    manifestFile,
    historical,
    attribution,
    reason,
    { reason_explicit: Boolean(explicitReason) },
  );
  return {
    manifestFile,
    manifest,
    activeRecordCount,
    historical,
    configPath,
    rawConfig,
    migratedConfig,
    configUpdateRequired,
    attribution,
    preparedArchive,
  };
}

export function migrateActiveReleaseScope(context, options) {
  ensureInitialized(context);
  const manifestInput = getOptionString(options, "release-manifest");
  if (!manifestInput) {
    fail([
      "Active-only migration needs --release-manifest <id-or-path>.",
      "What I need: the exact released scope that must remain active and be validated against current schemas.",
      "Why: without a manifest, completed history cannot be distinguished safely from other work that is still active.",
      "Example: agentic-sdlc migration active --release-manifest RELEASE-ASSESSMENT-20260714 --apply",
      "Effect: only configuration defaults are upgraded; immutable active records are validated, never silently rewritten; older released evidence is retained in place and listed in an archive-record:v1.",
    ].join("\n"));
  }
  let plan;
  let archiveWritten = false;
  let traceWarning = null;

  if (options.apply) {
    const releaseLock = acquireFileLock(path.join(context.sdlcRoot, "releases", "migration-active.lock"));
    let configWritten = false;
    try {
      plan = prepareActiveReleaseMigration(context, options, manifestInput);
      if (plan.configUpdateRequired) {
        fail([
          "The release migration was not applied because the project configuration is not pinned.",
          "Impact: no release, archive, or configuration files were changed.",
          "Next: run `agentic-sdlc config migrate`, review and apply its exact plan hash, then retry this release migration.",
        ].join("\n"));
      }
      if (plan.preparedArchive.record && !plan.preparedArchive.idempotent) {
        writeJsonFile(plan.preparedArchive.filePath, plan.preparedArchive.record);
        archiveWritten = true;
      }
      try {
        appendTraceEvent(context, null, {
          type: "decision",
          outcome: "passed",
          summary: `Applied active-only schema migration for release ${plan.manifest.id}`,
          action: "migration.active",
          actor: plan.attribution.actor,
          evidence: [
            toProjectPath(context, plan.manifestFile),
            plan.preparedArchive.filePath ? toProjectPath(context, plan.preparedArchive.filePath) : null,
          ].filter(Boolean),
          related: [plan.manifest.id, plan.preparedArchive.record?.id].filter(Boolean),
          git: plan.attribution.git,
          run: plan.attribution.run,
        });
      } catch (error) {
        traceWarning = `Migration committed, but its non-canonical trace could not be appended: ${error.message}`;
      }
    } catch (error) {
      if (archiveWritten && plan?.preparedArchive.filePath && fs.existsSync(plan.preparedArchive.filePath)) {
        removePathGoverned(plan.preparedArchive.filePath, { force: true });
      }
      if (configWritten) {
        writeJsonFile(plan.configPath, plan.rawConfig, { force: true });
      }
      throw error;
    } finally {
      releaseLock();
    }
    context.config = plan.migratedConfig;
  } else {
    plan = prepareActiveReleaseMigration(context, options, manifestInput);
  }

  const {
    manifestFile,
    manifest,
    activeRecordCount,
    historical,
    configUpdateRequired,
    preparedArchive,
  } = plan;

  const payload = {
    status: options.apply ? "applied" : "planned",
    mode: "active-only",
    release_manifest: { id: manifest.id, path: toProjectPath(context, manifestFile), hash: manifest.manifest_hash },
    active_records_validated: activeRecordCount,
    immutable_active_records_rewritten: 0,
    config_update_required: configUpdateRequired,
    config_updated: Boolean(options.apply && configUpdateRequired),
    historical_releases: historical.historical_release_count,
    historical_artifacts: historical.artifacts.length,
    quarantined_historical_releases: historical.quarantined_releases,
    trace_warning: traceWarning,
    logical_archive: preparedArchive.record
      ? {
          id: preparedArchive.record.id,
          path: toProjectPath(context, preparedArchive.filePath),
          hash: preparedArchive.record.record_hash,
          idempotent: preparedArchive.idempotent,
          written: archiveWritten,
        }
      : null,
    physical_files_moved: 0,
  };
  output(options, payload, [
    `${options.apply ? "Applied" : "Planned"} active-only migration for ${manifest.id}.`,
    `Active immutable records validated: ${activeRecordCount}; rewritten: 0.`,
    configUpdateRequired
      ? "Configuration must be reviewed and pinned separately before this migration can be applied."
      : "Configuration is already pinned; this migration will not modify it.",
    historical.artifacts.length > 0
      ? `${historical.artifacts.length} artifacts from ${historical.historical_release_count} older release(s) ${options.apply ? "are" : "will be"} logically archived; every file stays in place.`
      : "No older released evidence needs a logical archive record.",
    ...(historical.quarantined_releases.length > 0
      ? [`Warning: ${historical.quarantined_releases.length} corrupt/incomplete historical release(s) were quarantined from the archive inventory instead of blocking the active scope.`]
      : []),
    ...(traceWarning ? [`Warning: ${traceWarning}`] : []),
    options.apply
      ? "Effect: current release lineage remains canonical; historical evidence remains readable but is excluded from this release gate."
      : configUpdateRequired
        ? "Next: run `agentic-sdlc config migrate`, review its plan, and apply that exact hash first."
        : `Example to apply exactly this plan: agentic-sdlc migration active --release-manifest ${manifest.id} --apply`,
  ]);
}

export function migrateIdentity(context, options) {
  if (options.recover) {
    if (
      options.apply
      || getOptionString(options, "identity-map-json")
      || getOptionString(options, "identity-map-file")
      || getOptionString(options, "from-email")
      || getOptionString(options, "to-email")
      || getOptionString(options, "to-name")
      || getOptionString(options, "reason")
    ) {
      fail("Identity migration --recover cannot be combined with mapping, apply, or reason options.");
    }
    const recoveryNonce = getOptionString(options, "recovery-nonce");
    const recoveryPlanHash = getOptionString(options, "plan-hash");
    if (!recoveryNonce || !recoveryPlanHash) {
      fail("Identity migration --recover requires both --recovery-nonce and --plan-hash from the verified lock.");
    }
    try {
      const recoveryPreparation = prepareIdentityMigrationRecovery({
        projectRoot: context.root,
        recoveryNonce,
        planHash: recoveryPlanHash,
      });
      if (recoveryPreparation.status === "no_recovery_needed") {
        output(options, { status: "no_recovery_needed", recovered: false }, [
          "No interrupted identity migration requires recovery.",
        ]);
        return;
      }
      const grant = createBootstrapMutationGrant({
        root: context.root,
        canonical_action: "migration.identity",
        recover: true,
        nonce: recoveryNonce,
        expected_nonce: recoveryNonce,
        plan_hash: recoveryPlanHash,
        expected_plan_hash: recoveryPlanHash,
        exact_mutations: recoveryPreparation.exact_mutations,
      });
      const result = consumeBootstrapMutationGrant(grant, () => recoverIdentityMigration({
        projectRoot: context.root,
        recoveryNonce,
        planHash: recoveryPlanHash,
        recoveryPreparation,
        mutationGateway: executeIdentityMutation,
      }));
      output(options, result, [
        result.status === "rolled_back"
          ? `Recovered interrupted identity migration ${result.migration_id} by restoring the complete pre-migration tree.`
          : result.status === "committed"
            ? `Finalized already-validated identity migration ${result.migration_id} after interrupted cleanup.`
            : result.status === "cleared_before_swap"
              ? `Cleared interrupted identity migration ${result.migration_id}; the live tree was never swapped.`
              : "No interrupted identity migration requires recovery.",
      ]);
      return;
    } catch (error) {
      if (error instanceof IdentityMigrationError) fail(error.message);
      throw error;
    }
  }
  ensureInitialized(context);
  const inlineMapping = getOptionString(options, "identity-map-json");
  const fileMapping = getOptionString(options, "identity-map-file");
  const directSource = getOptionString(options, "from-email");
  const directTarget = getOptionString(options, "to-email");
  const directName = getOptionString(options, "to-name");
  const expectedPlanHash = getOptionString(options, "plan-hash");
  if ((inlineMapping || fileMapping) && (directSource || directTarget || directName)) {
    fail("Use either --identity-map-json/--identity-map-file or direct --from-email/--to-email options, not both.");
  }
  let mapping;
  if (inlineMapping || fileMapping) {
    mapping = loadOptionalJsonInput(
      context,
      options,
      "identity-map-json",
      "identity-map-file",
      "identity migration mapping",
    );
  } else {
    if (!directSource || !directTarget) {
      fail("Identity migration requires --from-email and --to-email, or a declarative --identity-map-json/--identity-map-file mapping.");
    }
    mapping = {
      source: { email: directSource },
      target: { email: directTarget, ...(directName ? { name: directName } : {}) },
    };
  }

  try {
    const governancePolicy = context.config?.governance_policy;
    if (
      options.apply
      && governancePolicy?.kind !== "governance_policy"
      && governancePolicy?.mode === "enforce"
    ) {
      fail(
        "This identity change was not started because its approval records could not be kept safely while the project data is replaced. "
        + "No files were changed. For now, use a reviewed policy embedded in the project configuration, or run the external policy in audit mode.",
      );
    }
    const plan = planIdentityMigration({
      projectRoot: context.root,
      mapping,
      reason: getOptionString(options, "reason"),
    });
    if (options.apply && plan.status === "ready") {
      if (!expectedPlanHash) {
        fail(`Identity migration apply requires --plan-hash ${plan.plan_hash} from the reviewed dry run.`);
      }
      if (expectedPlanHash !== plan.plan_hash) {
        fail(`Identity migration plan changed after preview; expected ${expectedPlanHash}, current ${plan.plan_hash}. Run a new dry run.`);
      }
    }
    const result = options.apply
      ? applyIdentityMigration(plan, {
          mutationGateway: governancePolicy?.kind === "governance_policy"
            ? executePreparedIdentityMutation
            : executeIdentityMutation,
          rebuildDerived: ({
            projectRoot,
            sdlcRoot,
            logicalProjectRoot,
            execution_descriptor: executionDescriptor,
          }) => {
            const stagedContext = { ...context, root: projectRoot, sdlcRoot };
            const cache = buildCache(stagedContext);
            const index = buildIndex(stagedContext);
            cache.root = context.root;
            index.root = context.root;
            const cachePath = path.join(sdlcRoot, "cache", CACHE_FILE_NAME);
            const indexPath = path.join(sdlcRoot, "indexes", "kb-index.json");
            writeJsonFile(cachePath, cache, {
              force: true,
              preparedTempPath: preparedIdentityWritePath(logicalProjectRoot, executionDescriptor, cachePath),
              preauthorizedMutation: governancePolicy?.kind === "governance_policy",
            });
            writeJsonFile(indexPath, index, {
              force: true,
              preparedTempPath: preparedIdentityWritePath(logicalProjectRoot, executionDescriptor, indexPath),
              preauthorizedMutation: governancePolicy?.kind === "governance_policy",
            });
          },
          validateAfter: ({ projectRoot, sdlcRoot }) => {
            const stagedContext = { ...context, root: projectRoot, sdlcRoot };
            const receiptPath = path.join(projectRoot, plan.receipt_path);
            const receipt = readProjectJson(stagedContext, receiptPath);
            const receiptValidation = validateIdentityMigrationReceipt(receipt);
            if (!receiptValidation.valid) {
              throw new IdentityMigrationError(`Migration receipt failed validation: ${receiptValidation.errors.join("; ")}`);
            }
            assertRecordSchema(receipt, "identity-migration-receipt.schema.json", `Identity migration ${receipt.id}`);
            const cacheStatus = getCacheStatus(stagedContext);
            const indexStatus = getIndexStatus(stagedContext);
            if (!cacheStatus.valid || !indexStatus.valid) {
              throw new IdentityMigrationError("Derived cache or index is stale after the migration rebuild.");
            }
          },
        })
      : publicIdentityMigrationPlan(plan);
    output(options, result, [
      result.status === "applied"
        ? `Applied identity migration ${result.id}.`
        : result.status === "ready"
          ? `Planned identity migration ${result.id}; no files were written.`
          : result.status === "already_applied"
            ? `Identity migration ${result.id} was already applied.`
            : "No matching canonical identity values require migration.",
      `Canonical source occurrences: ${result.source_occurrences_before} -> ${result.source_occurrences_after}.`,
      `Changed canonical files: ${result.changed_files.length}; integrity hash rewrites: ${result.hash_rewrites.length}.`,
      `Plan hash: ${result.plan_hash}.`,
      result.receipt_path ? `Lineage receipt: ${result.receipt_path}.` : "No lineage receipt was required.",
      result.status === "ready"
        ? `Re-run the same command with --apply --plan-hash ${result.plan_hash} to apply this reviewed canonical snapshot.`
        : null,
    ].filter(Boolean));
  } catch (error) {
    if (error instanceof IdentityMigrationError) fail(error.message);
    throw error;
  }
}

export function matchingApprovedStoryWorkflowDefinition(context) {
  return listVersionedWorkflowRecords(context, workflowDefinitionsRoot(context))
    .map(({ record }) => record)
    .filter((definition) =>
      definition.status === "approved"
      && definition.metadata?.governance_binding === "story"
      && workflowPhaseOrderDifference(context, definition).exact)
    .sort((left, right) =>
      String(left.id).localeCompare(String(right.id), "en")
      || String(left.version).localeCompare(String(right.version), "en"))
    .at(-1) || null;
}

export function ensureInitialized(context) {
  const projectPath = path.join(context.sdlcRoot, "project.json");
  if (!fs.existsSync(projectPath)) {
    const existingEntries = safeReadDir(context.root)
      .filter((name) => !NEW_PROJECT_IGNORED_ENTRIES.includes(name));
    if (existingEntries.length > 0) {
      fail(
        `No ${SDLC_DIR}/project.json found, but this folder already contains project files. `
        + "Run 'agentic-sdlc onboard existing-project --project-name <name>' to inspect them and prepare a reviewable baseline. "
        + "Use 'agentic-sdlc init' only for a genuinely new or empty project.",
      );
    }
    fail(`No ${SDLC_DIR}/project.json found. Run 'agentic-sdlc init' to start this new empty project.`);
  }
  resolveProjectFilePath(context, path.join(SDLC_DIR, "project.json"), { mustExist: true, fileOnly: true });
  assertNoSymlinkPathSegments(projectPath, context.root);
}

export function captureDirectoryIdentity(directoryPath) {
  const entry = fs.lstatSync(directoryPath);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    fail(`Refusing unstable write directory: ${directoryPath}`);
  }
  const stat = fs.statSync(directoryPath, IDENTITY_STAT_OPTIONS);
  return {
    ...fileIdentity(stat),
    realpath: fs.realpathSync.native(directoryPath),
  };
}

export function directoryIdentityMatches(directoryPath, expected) {
  try {
    const current = captureDirectoryIdentity(directoryPath);
    return sameFileIdentityValues(current, expected) && current.realpath === expected.realpath;
  } catch {
    return false;
  }
}

export function assertDirectoryIdentity(directoryPath, expected) {
  if (!directoryIdentityMatches(directoryPath, expected)) {
    fail(`Directory changed during filesystem operation: ${directoryPath}`);
  }
}
