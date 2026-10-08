import path from "node:path";
import {
  runsInsideAgentHost,
} from "../agent-host.mjs";
import {
  AUTONOMY_LEVEL_RANK,
} from "../autonomy-policy.mjs";
import {
  computeStableHash,
} from "../canonical.mjs";
import {
  fail,
} from "../cli/user-error.mjs";
import {
  contractDirectApprovalRequirements,
  hashApprovalSubject,
  requireFormalApprovalActor,
} from "../lifecycle/authorization.mjs";
import {
  getOptionString,
  normalizeId,
  normalizeListOption,
  normalizeRawListOption,
  requireOption,
} from "../lifecycle/common.mjs";
import {
  deliveryTargetAllowedActions,
} from "../lifecycle/delivery.mjs";
import {
  taskStartGitBase,
} from "../lifecycle/git-base.mjs";
import {
  humanGuidanceLines,
  humanGuidanceLocale,
} from "../lifecycle/guidance.mjs";
import {
  autonomyRoot,
  toProjectPath,
} from "../lifecycle/project.mjs";
import {
  Date,
  crypto,
  fs,
} from "../runtime/host.mjs";
import {
  sumAmounts,
} from "../delivery-metrics.mjs";
import {
  STANDING_APPROVAL_LEVEL,
  STANDING_APPROVAL_SOURCE,
  StandingApprovalError,
  buildStandingApprovalDecision,
  buildStandingApprovalProposal,
  buildStandingApprovalUse,
  deriveStandingApprovalState,
  formatStandingAmount,
  formatStandingBudget,
  standingActionReasons,
  standingApprovalIntegrityErrors,
  standingApprovalPolicy,
  standingBudgetReasons,
  standingChangeReasons,
  standingContractBoundReasons,
  standingDeliveryBoundReasons,
  standingDeliveryUseResolution,
  standingDerivedApprovalErrors,
} from "../standing-approvals.mjs";
import {
  nextStandingSlot,
  sharedSlotMatches,
  sharedStateReasons,
  sharedStateSummary,
} from "../standing-shared-state.mjs";
import {
  buildApprovalRecord,
} from "./authorization.mjs";
import {
  claimSharedStandingSlot,
  publishSharedStandingRevocation,
  readSharedStandingState,
  recordLocalStandingRevocation,
  recordLocalStandingSlot,
  resolveStandingScope,
  standingCoordinationRecord,
} from "./standing-shared.mjs";
import {
  assertRecordSchema,
  buildAttribution,
  compactTimestamp,
  now,
  validateRecordSchema,
} from "./common.mjs";
import {
  execGitOutput,
} from "./git.mjs";
import {
  ensureInitialized,
} from "./migration.mjs";
import {
  output,
} from "./output.mjs";
import {
  acquireFileLock,
  readProjectJson,
  readProjectSafe,
  safeReadDir,
  writeJsonFile,
} from "./storage.mjs";
import {
  readDeliveryAutonomyProfile,
} from "./delivery.mjs";
import {
  deliveryCostReading,
  deliveryCostSources,
  deliveryUsageSummary,
} from "./delivery-metering.mjs";
import {
  appendTraceEvent,
  assertRequirementReadyForDownstream,
  readRequirement,
  readStory,
} from "./story.mjs";

const PROPOSAL_FILE = "proposal.json";
const APPROVAL_FILE = "approval.json";
const REVOCATION_FILE = "revocation.json";
const USES_DIRECTORY = "uses";
const SDLC_PREFIX = ".sdlc/";
const BINARY_PROBE_BYTES = 8000;
const MAX_UNTRACKED_FILE_BYTES = 4 * 1024 * 1024;
const STANDING_ACTOR_TYPES = Object.freeze(["agent", "system", "ci", "human"]);
const MIXED_APPROVAL_OPTIONS = Object.freeze([
  "actor-type",
  "approval-source",
  "summary",
  "approval-evidence",
  "authorization",
  "host-receipt-file",
  "confirm-action",
]);

export function standingApprovalsRoot(context) {
  return path.join(autonomyRoot(context), "standing");
}

function standingDirectory(context, id) {
  return path.join(standingApprovalsRoot(context), normalizeId(id));
}

function standingLockPath(context, id) {
  return path.join(standingApprovalsRoot(context), `.${normalizeId(id)}.lock`);
}

export function withStandingApprovalLock(context, id, callback) {
  const release = acquireFileLock(standingLockPath(context, id));
  try {
    return callback();
  } finally {
    release();
  }
}

/** Holds the standing-approval lock until the returned release function runs. */
export function holdStandingApprovalLock(context, id) {
  return acquireFileLock(standingLockPath(context, id));
}

export function standingPolicy(context) {
  try {
    return standingApprovalPolicy(context.config);
  } catch (error) {
    fail(`The standing approval configuration is invalid: ${error.message}`);
  }
  return null;
}

/** Shared state of one standing approval, fetched from the git remote when sharing applies. */
function sharedStandingState(context, loaded) {
  if (!loaded?.proposal) return null;
  return readSharedStandingState(context, loaded.proposal, standingPolicy(context).coordination);
}

function sharedReasons(context, loaded, options = {}) {
  const shared = sharedStandingState(context, loaded);
  return shared ? sharedStateReasons(loaded.proposal, shared, { localUses: loaded.uses, ...options }) : [];
}

/**
 * The policy a standing approval is bound to. Sharing settings count only once
 * a project configures them, so adding the setting with its defaults to the
 * shipped template does not suspend standing approvals approved before it.
 */
function standingPolicyForBinding(context) {
  const { coordination, ...policy } = standingPolicy(context);
  return context.config?.standing_approval_policy?.coordination === undefined ? policy : { ...policy, coordination };
}

function realRoot(context) {
  try {
    return fs.realpathSync.native(context.root);
  } catch {
    return path.resolve(context.root);
  }
}

/** Hashes a standing approval binds at proposal time and re-checks on every use. */
export function currentStandingBindings(context) {
  const project = readProjectSafe(context) || {};
  return {
    config_hash: context.configState?.effective_config_hash || computeStableHash(context.config),
    policy_hash: computeStableHash({
      approval_policy: context.config.approval_policy ?? null,
      authority_policy: context.config.authority_policy ?? null,
      autonomy_policy: context.config.autonomy_policy ?? null,
      gate_policy: context.config.gate_policy ?? null,
      governance_policy: context.config.governance_policy ?? null,
      standing_approval_policy: standingPolicyForBinding(context),
    }),
    project_hash: computeStableHash({
      project_id: project.project_id ?? null,
      project_root: realRoot(context),
    }),
  };
}

function readOptionalRecord(context, filePath, schemaName, label, errors) {
  if (!fs.existsSync(filePath)) return null;
  let record;
  try {
    record = readProjectJson(context, filePath);
  } catch (error) {
    errors.push(`${label} cannot be read: ${error.message}`);
    return null;
  }
  const validation = validateRecordSchema(record, schemaName);
  if (!validation.valid) {
    errors.push(`${label} does not match ${schemaName}`);
  }
  return record;
}

function formalApprovalErrors(decision, subject, label) {
  if (!decision) return [];
  const errors = [];
  const approval = decision.approval || {};
  if (approval.approved_content_hash !== hashApprovalSubject(subject)) {
    errors.push(`the ${label} approval does not bind its exact subject`);
  }
  const source = approval.approval_source;
  const actorType = approval.approved_by?.type;
  if (!((source === "explicit-user" && actorType === "human") || (source === "ci" && actorType === "ci"))) {
    errors.push(`the ${label} was not approved by a person or an approved CI actor`);
  }
  return errors;
}

export function standingRevocationSubject(proposal, reason) {
  return {
    standing_approval_id: proposal.id,
    standing_approval_hash: proposal.record_hash,
    reason,
  };
}

/** Reads every record of one standing approval and derives its current state. */
export function loadStandingApproval(context, id, { missingOk = false } = {}) {
  const normalizedId = normalizeId(id);
  const directory = standingDirectory(context, normalizedId);
  const proposalPath = path.join(directory, PROPOSAL_FILE);
  if (!fs.existsSync(proposalPath)) {
    if (missingOk) return null;
    fail(`Standing approval ${normalizedId} does not exist.`);
  }
  const errors = [];
  const proposal = readOptionalRecord(context, proposalPath, "standing-approval.schema.json", "The standing approval record", errors);
  const approval = readOptionalRecord(
    context,
    path.join(directory, APPROVAL_FILE),
    "standing-approval-decision.schema.json",
    "The standing approval decision",
    errors,
  );
  const revocation = readOptionalRecord(
    context,
    path.join(directory, REVOCATION_FILE),
    "standing-approval-decision.schema.json",
    "The standing approval revocation",
    errors,
  );
  const usesRoot = path.join(directory, USES_DIRECTORY);
  const uses = safeReadDir(usesRoot)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => readOptionalRecord(
      context,
      path.join(usesRoot, name),
      "standing-approval-use.schema.json",
      `Standing approval use ${name}`,
      errors,
    ))
    .filter(Boolean);
  if (proposal && proposal.id !== normalizedId) errors.push("the standing approval record is stored under another id");
  const integrityErrors = proposal
    ? [
        ...errors,
        ...standingApprovalIntegrityErrors({ proposal, approval, revocation, uses }),
        ...formalApprovalErrors(approval, proposal, "standing approval"),
        ...(revocation ? formalApprovalErrors(revocation, standingRevocationSubject(proposal, revocation.reason), "revocation") : []),
      ]
    : errors;
  const policy = standingPolicy(context);
  const state = proposal
    ? deriveStandingApprovalState({
        proposal,
        approval,
        revocation,
        uses,
        integrityErrors,
        nowMs: Date.now(),
        currentBindings: currentStandingBindings(context),
        policy,
      })
    : {
        status: "invalid",
        covers: false,
        used: uses.length,
        remaining: 0,
        max_deliveries: 0,
        expires_at: null,
        reasons: integrityErrors,
        warnings: [],
      };
  return {
    id: normalizedId,
    directory,
    proposal,
    approval,
    revocation,
    uses,
    integrity_errors: integrityErrors,
    state,
  };
}

export function listStandingApprovals(context) {
  return safeReadDir(standingApprovalsRoot(context))
    .filter((name) => !name.startsWith(".") && fs.existsSync(path.join(standingApprovalsRoot(context), name, PROPOSAL_FILE)))
    .sort()
    .map((name) => loadStandingApproval(context, name));
}

/**
 * Display-only spend of a standing approval budget: the recorded cost of each
 * delivery that used it on this computer. Coverage decisions never rely on
 * this summary; they re-measure at every step.
 */
function standingBudgetUsage(context, loaded) {
  const budget = loaded.proposal?.budget;
  if (!budget) return null;
  const deliveries = loaded.uses.map((use) => {
    const profileId = use.profile_ref?.id;
    try {
      const profile = readDeliveryAutonomyProfile(context, profileId, { missingOk: true });
      if (!profile) return { profile_id: profileId, delivery_id: use.delivery?.id ?? null, amount: null, status: "not_on_this_computer" };
      const usage = deliveryUsageSummary(context, profile);
      if (usage.currency && usage.currency !== budget.currency) {
        return { profile_id: profileId, delivery_id: profile.delivery_id, amount: null, status: "other_currency" };
      }
      return {
        profile_id: profileId,
        delivery_id: profile.delivery_id,
        amount: usage.cost?.amount ?? null,
        status: usage.metered_cost_receipts > 0 ? "metered" : usage.cost ? "declared" : "not_measured",
      };
    } catch {
      return { profile_id: profileId, delivery_id: use.delivery?.id ?? null, amount: null, status: "unreadable" };
    }
  });
  const spent = sumAmounts(deliveries.map((entry) => entry.amount).filter((amount) => amount !== null));
  return {
    currency: budget.currency,
    per_delivery_amount: budget.per_delivery_amount ?? null,
    total_amount: budget.total_amount ?? null,
    spent,
    measured: deliveries.filter((entry) => entry.status === "metered").length,
    not_measured: deliveries.filter((entry) => entry.status !== "metered").length,
    deliveries,
  };
}

function standingBudgetUsageLine(usage, { italian = false } = {}) {
  if (!usage) return null;
  const spent = formatStandingAmount(usage.currency, usage.spent ?? "0");
  const notMeasured = usage.not_measured > 0
    ? (italian ? `, ${usage.not_measured} senza costo misurato` : `, ${usage.not_measured} without a metered cost`)
    : "";
  return italian
    ? `budget ${formatStandingBudget(usage)}; speso ${spent} su ${usage.measured + usage.not_measured} consegne${notMeasured}`
    : `budget ${formatStandingBudget(usage)}; spent ${spent} over ${usage.measured + usage.not_measured} deliveries${notMeasured}`;
}

function standingSummary(loaded, context = null) {
  const proposal = loaded.proposal || {};
  return {
    id: loaded.id,
    status: loaded.state.status,
    covers_new_work: loaded.state.covers,
    recipe_id: proposal.work_kind?.recipe_id ?? null,
    description: proposal.work_kind?.description ?? null,
    destination: proposal.destination?.kind ?? null,
    requirement_ids: (proposal.requirement_refs || []).map((ref) => ref.id),
    allowed_write_paths: proposal.allowed_write_paths || [],
    limits: proposal.limits || null,
    budget: proposal.budget ?? null,
    ...(context && proposal.budget ? { budget_usage: standingBudgetUsage(context, loaded) } : {}),
    max_deliveries: loaded.state.max_deliveries,
    used: loaded.state.used,
    remaining: loaded.state.remaining,
    expires_at: loaded.state.expires_at,
    reasons: loaded.state.reasons,
    warnings: loaded.state.warnings,
    record_hash: proposal.record_hash ?? null,
    uses: loaded.uses.map((use) => ({
      id: use.id,
      slot: use.slot,
      delivery_id: use.delivery?.id ?? null,
      delivery_kind: use.delivery?.kind ?? null,
      profile_id: use.profile_ref?.id ?? null,
      story_id: use.story_id,
      contract_id: use.contract_id,
      used_at: use.created_at,
    })),
  };
}

/** Summary plus the shared state, which status and explain fetch from the remote. */
function withSharedSummary(context, loaded) {
  const summary = standingSummary(loaded, context);
  let shared = null;
  try {
    shared = sharedStandingState(context, loaded);
  } catch (error) {
    shared = { scope: "shared", remote: null, available: false, error: error.message, slots: [], errors: [] };
  }
  summary.shared_state = sharedStateSummary(shared);
  if ((summary.shared_state.revoked || summary.shared_state.revoked_here) && summary.status !== "invalid") summary.status = "revoked";
  return summary;
}

function sharedStateLine(state) {
  if (!state || state.scope !== "shared") return state?.note || "checked on this computer only";
  if (!state.checked) return `remote '${state.remote}' cannot be reached (${state.error}); nothing is covered until it can`;
  return `remote '${state.remote}': ${state.shared_slots.length} deliveries recorded${state.revoked ? ", revoked" : ""}${state.problems.length > 0 ? `; problems: ${state.problems.join("; ")}` : ""}`;
}

/** Compact view for status and the observatory. */
export function standingApprovalOverview(context) {
  let loaded;
  try {
    loaded = listStandingApprovals(context);
  } catch (error) {
    return { approvals: [], warnings: [`Standing approvals cannot be read: ${error.message}`] };
  }
  const approvals = loaded.map((item) => standingSummary(item, context));
  const warnings = approvals.flatMap((item) => [
    ...item.warnings.map((warning) => `Standing approval ${item.id} ${warning}.`),
    ...(item.status === "invalid" ? [`Standing approval ${item.id} is invalid and covers nothing: ${item.reasons.join("; ")}.`] : []),
  ]);
  return { approvals, warnings };
}

function assertStandingOnlyOptions(options, command) {
  const mixed = MIXED_APPROVAL_OPTIONS.filter((name) => options[name] !== undefined && options[name] !== false);
  if (mixed.length > 0) {
    fail(
      `${command} with --standing-approval records a derived approval; it cannot be combined with `
      + `${mixed.map((name) => `--${name}`).join(", ")}. Use either the standing approval or a direct approval.`,
    );
  }
}

/** A derived approval names who applied it; an unidentified actor cannot. */
export function requireStandingActor(attribution, command) {
  if (!STANDING_ACTOR_TYPES.includes(attribution?.actor?.type)) {
    fail(
      `${command} with --standing-approval needs an identified agent, system, CI, or human actor; `
      + `the current actor type is '${attribution?.actor?.type || "unknown"}'. Set --actor or run from the agent host.`,
    );
  }
}

function coverageFailure(loaded, reasons, fallback) {
  const id = loaded?.id || "unknown";
  return [
    `Standing approval ${id} does not cover this step: ${reasons.join("; ")}.`,
    `Nothing was approved. Fall back to the normal confirmation: ${fallback}`,
  ].join(" ");
}

function activeReasons(loaded, { holdsSlot = false } = {}) {
  // Using up the last slot stops new deliveries, not the ones holding a slot.
  if (loaded.state.covers || (holdsSlot && loaded.state.status === "exhausted")) return [];
  return [`it is ${loaded.state.status} (${loaded.state.reasons.join("; ") || "not active"})`];
}

function requirementDriftReasons(context, loaded, requirementIds) {
  const reasons = [];
  const byId = new Map(loaded.proposal.requirement_refs.map((ref) => [ref.id, ref]));
  for (const requirementId of requirementIds) {
    const ref = byId.get(requirementId);
    if (!ref) continue;
    let profile = null;
    try {
      profile = assertRequirementReadyForDownstream(context, readRequirement(context, requirementId)).profile;
    } catch (error) {
      reasons.push(`requirement ${requirementId} is not ready: ${error.message}`);
      continue;
    }
    if (!profile || profile.id !== ref.profile_id || profile.profile_hash !== ref.profile_hash) {
      reasons.push(`requirement ${requirementId} changed after the standing approval was granted`);
    }
  }
  return reasons;
}

/** Proposes one standing approval. Nothing is covered until a person approves it. */
export function proposeStandingApproval(context, options) {
  ensureInitialized(context);
  const policy = standingPolicy(context);
  if (!policy.enabled) fail("Standing approvals are disabled by standing_approval_policy.enabled.");
  if ((context.config.authority_policy?.mode || "audit_only") === "host_verified") {
    fail("This project requires a trusted signed approval for each decision, which a standing approval cannot provide.");
  }
  const id = normalizeId(requireOption(options, "id"));
  const budgetFlags = ["budget-per-delivery", "budget-total", "currency"].filter((key) => options[key] !== undefined);
  if (budgetFlags.length > 0) {
    if (options["budget-per-delivery"] === undefined && options["budget-total"] === undefined) {
      fail("--currency names the currency of a cost budget; add --budget-per-delivery or --budget-total, or leave it out. Nothing was recorded.");
    }
    // A budget is accepted only when delivery cost can be measured; otherwise
    // every step would fall back and the standing approval would cover nothing.
    if (deliveryCostSources(context).length === 0) {
      fail([
        `A standing approval can carry a cost budget (${budgetFlags.map((key) => `--${key}`).join(", ")}) only when this project has a meter that reports delivery cost, and none is configured.`,
        "Without one every step would fall back to a normal confirmation, so the standing approval would never cover anything.",
        "Enable one first: set budget_policy.metering_adapters.codeburn.enabled to true with its cost mapping (and install CodeBurn 0.9.x), or add a trusted signed source for cost to budget_policy.exact_metering.trusted_sources; then run config migrate and apply its plan.",
        "Or propose it again without the budget options; the file, line, delivery-count, and expiry limits still bound it. Nothing was recorded.",
      ].join("\n"));
    }
  }
  const requirementIds = normalizeListOption(options.requirement).map(normalizeId);
  const requirementRefs = requirementIds.map((requirementId) => {
    const ready = assertRequirementReadyForDownstream(
      context,
      readRequirement(context, requirementId),
      `Requirement ${requirementId}`,
    );
    if (ready.legacy || !ready.profile) {
      fail(`Requirement ${requirementId} is legacy; approve a requirement:v2 revision before delegating its deliveries.`);
    }
    return { id: requirementId, profile_id: ready.profile.id, profile_hash: ready.profile.profile_hash };
  });
  const attribution = buildAttribution(context, options, "autonomy.standing.propose");
  const project = readProjectSafe(context) || {};
  let proposal;
  try {
    proposal = buildStandingApprovalProposal({
      id,
      recipe_id: getOptionString(options, "recipe"),
      description: getOptionString(options, "description"),
      destination: getOptionString(options, "destination"),
      repository: getOptionString(options, "repository"),
      head_branch_prefix: getOptionString(options, "head-branch-prefix"),
      requirement_refs: requirementRefs,
      allowed_write_paths: normalizeRawListOption(options["write-path"]),
      max_changed_files: getOptionString(options, "max-changed-files"),
      max_changed_lines: getOptionString(options, "max-changed-lines"),
      max_deliveries: getOptionString(options, "max-deliveries"),
      expires_at: getOptionString(options, "expires-at"),
      budget: {
        currency: getOptionString(options, "currency"),
        per_delivery_amount: getOptionString(options, "budget-per-delivery"),
        total_amount: getOptionString(options, "budget-total"),
      },
      scope: { project_id: project.project_id || path.basename(context.root), project_root: realRoot(context) },
      coordination: standingCoordinationRecord(context, policy.coordination),
      bindings: currentStandingBindings(context),
      actor: attribution.actor,
    }, { now: now(), policy });
  } catch (error) {
    if (error instanceof StandingApprovalError) fail(error.message);
    throw error;
  }
  assertRecordSchema(proposal, "standing-approval.schema.json", `Standing approval ${id}`);
  const proposalPath = path.join(standingDirectory(context, id), PROPOSAL_FILE);
  withStandingApprovalLock(context, id, () => {
    if (fs.existsSync(proposalPath)) {
      fail(`Standing approval ${id} already exists; records are immutable. Choose a new --id to propose different bounds.`);
    }
    writeJsonFile(proposalPath, proposal, { atomicCreate: true });
  });
  appendTraceEvent(context, null, {
    type: "decision",
    summary: `Proposed standing approval ${id} for ${proposal.work_kind.recipe_id}`,
    action: "autonomy.standing.propose",
    actor: attribution.actor,
    evidence: [toProjectPath(context, proposalPath)],
    related: [id, ...requirementIds],
    request: { id: `standing-approval:${id}:propose`, source: "autonomy.standing.propose", standing_approval_id: id, standing_approval_hash: proposal.record_hash },
    git: attribution.git,
    run: attribution.run,
  });
  const italian = humanGuidanceLocale(options) === "it";
  output(options, {
    status: "proposed",
    standing_approval: proposal,
    standing_approval_path: toProjectPath(context, proposalPath),
    plain_language: standingPlainLanguage(proposal, { italian }),
  }, humanGuidanceLines({
    result: italian
      ? "È pronta una proposta di approvazione permanente; non copre ancora nulla."
      : "A standing approval is proposed; it covers nothing yet.",
    impact: standingPlainLanguage(proposal, { italian }),
    required_decision: italian
      ? "Conferma esplicitamente questi limiti se vuoi che le prossime consegne simili procedano senza chiederti ogni volta."
      : "Explicitly confirm these limits if you want similar deliveries to proceed without asking you each time.",
    protection_boundary: italian
      ? "Merge, produzione, deploy, migrazioni di dati e cancellazioni fuori dai percorsi restano sempre esclusi; test e controlli continuano a girare."
      : "Merges, production, deploys, data migrations, and deletions outside the paths stay excluded; every test and check still runs.",
    next_action: italian
      ? "Mostra la proposta all’utente e registra la sua approvazione solo se la conferma."
      : "Show the proposal to the user and record their approval only if they confirm it.",
  }, [
    `Standing approval: ${id}`,
    `Recipe: ${proposal.work_kind.recipe_id}`,
    `Destination: ${proposal.destination.kind}`,
    `Requirements: ${requirementIds.join(", ")}`,
    `Allowed write paths: ${proposal.allowed_write_paths.join(", ")}`,
    `Per delivery: at most ${proposal.limits.max_changed_files} files and ${proposal.limits.max_changed_lines} lines`,
    `Deliveries: ${proposal.max_deliveries}; expires at ${proposal.expires_at}`,
    `Budget: ${formatStandingBudget(proposal.budget)}`,
    `Record hash: ${proposal.record_hash}`,
  ], options));
}

export function standingPlainLanguage(proposal, { italian = false } = {}) {
  const destination = proposal.destination.kind === "pull_request"
    ? (italian
      ? `aprire o aggiornare una pull request su ${proposal.destination.repository}, solo da branch che iniziano con ${proposal.destination.head_branch_prefix}, senza unirla`
      : `open or update a pull request on ${proposal.destination.repository}, only from branches starting with ${proposal.destination.head_branch_prefix}, without merging it`)
    : (italian ? "rilasciare in una destinazione locale" : "release to a local destination");
  const base = italian
    ? `Per il lavoro "${proposal.work_kind.description}" posso ${destination} fino a ${proposal.max_deliveries} volte entro ${proposal.expires_at}, toccando solo ${proposal.allowed_write_paths.join(", ")} e al massimo ${proposal.limits.max_changed_files} file e ${proposal.limits.max_changed_lines} righe per consegna, senza chiederti conferma ogni volta. Se qualcosa esce da questi limiti mi fermo e ti chiedo.`
    : `For "${proposal.work_kind.description}" I may ${destination} up to ${proposal.max_deliveries} times until ${proposal.expires_at}, touching only ${proposal.allowed_write_paths.join(", ")} and at most ${proposal.limits.max_changed_files} files and ${proposal.limits.max_changed_lines} lines per delivery, without asking you each time. If anything goes outside these limits I stop and ask you.`;
  return proposal.budget ? `${base} ${standingBudgetSentence(proposal.budget, { italian })}` : base;
}

function standingBudgetSentence(budget, { italian = false } = {}) {
  const perDelivery = formatStandingAmount(budget.currency, budget.per_delivery_amount);
  const total = formatStandingAmount(budget.currency, budget.total_amount);
  const limits = [
    perDelivery ? (italian ? `${perDelivery} per consegna` : `${perDelivery} per delivery`) : null,
    total ? (italian ? `${total} in tutto` : `${total} in total`) : null,
  ].filter(Boolean).join(italian ? " e " : " and ");
  return italian
    ? `Il costo misurato da un contatore resta entro ${limits}; prima di ogni passo il costo della consegna deve essere stato misurato dopo il passo precedente, altrimenti ti chiedo conferma.`
    : `The cost measured by a meter stays within ${limits}; before each step the delivery's cost must have been measured after its previous step, otherwise I ask you.`;
}

function requireStandingDecisionActor(context, options, attribution, label) {
  const source = String(getOptionString(options, "approval-source") || "").trim().toLowerCase();
  if (source === "automation" || source === "bootstrap" || ["agent", "system", "unknown"].includes(attribution.actor.type)) {
    fail(
      `${label} needs the user's explicit approval (--actor-type human --approval-source explicit-user) `
      + "or an approved CI actor; an agent can never create, widen, or revoke one on its own authority.",
    );
  }
  requireFormalApprovalActor(context, options, attribution, label);
}

export function approveStandingApproval(context, options) {
  ensureInitialized(context);
  const id = normalizeId(requireOption(options, "id"));
  if (runsInsideAgentHost()) {
    fail(
      `Standing approval ${id} can only be approved by the user, outside the agent's session. `
      + `Show them its limits (autonomy standing explain --id ${id}) and ask them to run this approve command in their own terminal.`,
    );
  }
  const attribution = buildAttribution(context, options, "autonomy.standing.approve");
  requireStandingDecisionActor(context, options, attribution, `Approving standing approval ${id}`);
  const result = withStandingApprovalLock(context, id, () => {
    const loaded = loadStandingApproval(context, id);
    if (loaded.integrity_errors.length > 0) {
      fail(`Standing approval ${id} is invalid and cannot be approved: ${loaded.integrity_errors.join("; ")}.`);
    }
    if (loaded.revocation) fail(`Standing approval ${id} was revoked; propose a new one instead.`);
    if (loaded.approval) return { loaded, decision: loaded.approval, idempotent: true };
    if (Date.parse(loaded.proposal.expires_at) <= Date.now()) {
      fail(`Standing approval ${id} expired before it was approved; propose a new one.`);
    }
    if (["stale", "disabled"].includes(loaded.state.status)) {
      fail(`Standing approval ${id} cannot be approved: ${loaded.state.reasons.join("; ")}. Propose it again for the current project rules.`);
    }
    const approval = buildApprovalRecord(context, options, attribution, {
      subject: loaded.proposal,
      subject_id_field: "standing_approval_id",
      subject_id: id,
      status: "approved",
      scope: "standing-approval",
      label: `standing approval ${id}`,
    });
    const decision = buildStandingApprovalDecision({
      id: `${id}-APPROVAL`,
      decision: "approved",
      proposal: loaded.proposal,
      approval,
      createdAt: now(),
      actor: attribution.actor,
    });
    assertRecordSchema(decision, "standing-approval-decision.schema.json", `Standing approval ${id} approval`);
    writeJsonFile(path.join(loaded.directory, APPROVAL_FILE), decision, { atomicCreate: true });
    return { loaded, decision, idempotent: false };
  });
  const approvalPath = path.join(result.loaded.directory, APPROVAL_FILE);
  if (!result.idempotent) {
    appendTraceEvent(context, null, {
      type: "gate",
      summary: `Approved standing approval ${id}: ${result.loaded.proposal.work_kind.description}`,
      action: "autonomy.standing.approve",
      actor: attribution.actor,
      evidence: [toProjectPath(context, approvalPath)],
      related: [id],
      request: {
        id: `standing-approval:${id}:approve`,
        source: "autonomy.standing.approve",
        standing_approval_id: id,
        standing_approval_hash: result.loaded.proposal.record_hash,
        approval_hash: result.decision.record_hash,
      },
      git: attribution.git,
      run: attribution.run,
    });
  }
  const italian = humanGuidanceLocale(options) === "it";
  output(options, {
    status: "active",
    idempotent: result.idempotent,
    standing_approval_id: id,
    approval: result.decision,
    approval_path: toProjectPath(context, approvalPath),
  }, humanGuidanceLines({
    result: italian ? "L’approvazione permanente è attiva." : "The standing approval is active.",
    impact: standingPlainLanguage(result.loaded.proposal, { italian }),
    required_decision: italian
      ? "Nessuna, finché le consegne restano nei limiti. Puoi revocarla in qualsiasi momento."
      : "None while deliveries stay inside the limits. You can revoke it at any time.",
    protection_boundary: italian
      ? "Ogni consegna esegue ancora test, scansione dei segreti, revisione e controlli finali; fuori dai limiti torno a chiederti conferma."
      : "Every delivery still runs tests, secret scanning, review, and the final checks; outside the limits I ask you again.",
    next_action: italian
      ? "Usa questa approvazione solo per lavoro che rientra esattamente nei limiti mostrati."
      : "Use it only for work that fits exactly inside the limits shown.",
  }, [
    `Standing approval: ${id}`,
    `Approval record: ${result.decision.id} (${result.decision.record_hash})`,
  ], options));
}

export function revokeStandingApproval(context, options) {
  ensureInitialized(context);
  const id = normalizeId(requireOption(options, "id"));
  const reason = String(requireOption(options, "reason")).trim();
  const attribution = buildAttribution(context, options, "autonomy.standing.revoke");
  requireStandingDecisionActor(context, options, attribution, `Revoking standing approval ${id}`);
  const result = withStandingApprovalLock(context, id, () => {
    const loaded = loadStandingApproval(context, id);
    if (!loaded.proposal) fail(`Standing approval ${id} cannot be read: ${loaded.integrity_errors.join("; ")}.`);
    if (loaded.revocation) {
      if (loaded.revocation.reason !== reason) {
        fail(`Standing approval ${id} is already revoked for a different reason.`);
      }
      return { loaded, decision: loaded.revocation, idempotent: true };
    }
    const approval = buildApprovalRecord(context, options, attribution, {
      subject: standingRevocationSubject(loaded.proposal, reason),
      subject_id_field: "standing_approval_id",
      subject_id: id,
      status: "approved",
      scope: "standing-approval-revocation",
      label: `standing approval revocation ${id}`,
    });
    const decision = buildStandingApprovalDecision({
      id: `${id}-REVOCATION`,
      decision: "revoked",
      proposal: loaded.proposal,
      approval,
      reason,
      createdAt: now(),
      actor: attribution.actor,
    });
    assertRecordSchema(decision, "standing-approval-decision.schema.json", `Standing approval ${id} revocation`);
    writeJsonFile(path.join(loaded.directory, REVOCATION_FILE), decision, { atomicCreate: true });
    return { loaded, decision, idempotent: false };
  });
  const revocationPath = path.join(result.loaded.directory, REVOCATION_FILE);
  const sharing = shareStandingRevocation(context, result.loaded.proposal, result.decision);
  if (!result.idempotent) {
    appendTraceEvent(context, null, {
      type: "gate",
      summary: `Revoked standing approval ${id}: ${reason}`,
      action: "autonomy.standing.revoke",
      actor: attribution.actor,
      evidence: [toProjectPath(context, revocationPath)],
      related: [id, ...result.loaded.uses.map((use) => use.delivery?.id).filter(Boolean)],
      request: {
        id: `standing-approval:${id}:revoke`,
        source: "autonomy.standing.revoke",
        standing_approval_id: id,
        standing_approval_hash: result.loaded.proposal.record_hash,
      },
      git: attribution.git,
      run: attribution.run,
    });
  }
  const italian = humanGuidanceLocale(options) === "it";
  output(options, {
    status: "revoked",
    idempotent: result.idempotent,
    standing_approval_id: id,
    revocation: result.decision,
    revocation_path: toProjectPath(context, revocationPath),
    affected_deliveries: result.loaded.uses.map((use) => use.delivery?.id).filter(Boolean),
    shared_revocation: sharing,
  }, humanGuidanceLines({
    result: italian ? "L’approvazione permanente è revocata." : "The standing approval is revoked.",
    impact: sharing.status === "failed"
      ? (italian
          ? `La revoca vale su questo computer, ma non è ancora arrivata al remote git '${sharing.remote}' (${sharing.error}): chi usa un’altra copia del progetto può ancora appoggiarsi all’approvazione finché non esegui autonomy standing sync --id ${id}.`
          : `The revocation applies on this computer, but it has not reached the git remote '${sharing.remote}' yet (${sharing.error}): anyone using another copy of the project can still rely on it until you run autonomy standing sync --id ${id}.`)
      : (italian
          ? `Da subito nessun passo nuovo si basa su di essa${sharing.status === "shared" ? ", anche nelle altre copie del progetto" : ""}; le consegne in corso tornano alle conferme normali al passo successivo.`
          : `From now on no new step relies on it${sharing.status === "shared" ? ", in every copy of the project too" : ""}; deliveries in progress fall back to normal confirmations at their next step.`),
    required_decision: italian ? "Nessuna." : "None.",
    protection_boundary: italian
      ? "Le consegne già completate restano registrate e verificabili."
      : "Deliveries already completed stay recorded and verifiable.",
    next_action: italian
      ? "Per lavoro simile futuro, chiedi una nuova conferma per ogni consegna o proponi nuovi limiti."
      : "For similar future work, ask for confirmation per delivery or propose new limits.",
  }, [`Standing approval: ${id}`, `Reason: ${reason}`], options));
}

/** Publishes a revocation to the shared state when sharing applies. */
function shareStandingRevocation(context, proposal, revocation) {
  const coordination = standingPolicy(context).coordination;
  recordLocalStandingRevocation(context, coordination, { proposal, revocation });
  const scope = resolveStandingScope(context, coordination);
  if (scope.scope !== "shared") return { status: "local", note: scope.note };
  if (scope.unavailable) return { status: "failed", remote: scope.remote, error: scope.unavailable };
  const published = publishSharedStandingRevocation(context, coordination, scope.remote, { proposal, revocation });
  return published.error
    ? { status: "failed", remote: scope.remote, error: published.error }
    : { status: "shared", remote: scope.remote };
}

/**
 * Brings the shared state up to date: publishes a local revocation and any
 * local slot the remote does not record yet, then reports what is shared.
 */
export function syncStandingApproval(context, options) {
  ensureInitialized(context);
  const id = normalizeId(requireOption(options, "id"));
  const result = withStandingApprovalLock(context, id, () => {
    const loaded = loadStandingApproval(context, id);
    if (!loaded.proposal) fail(`Standing approval ${id} cannot be read: ${loaded.integrity_errors.join("; ")}.`);
    const actions = [];
    const coordination = standingPolicy(context).coordination;
    let shared = sharedStandingState(context, loaded);
    if (shared?.scope === "shared" && shared.available) {
      if (loaded.revocation && !shared.revoked) {
        const published = publishSharedStandingRevocation(context, coordination, shared.remote, { proposal: loaded.proposal, revocation: loaded.revocation });
        actions.push(published.error ? `revocation not shared: ${published.error}` : "revocation shared");
      }
      for (const use of loaded.uses) {
        if (shared.slots.some((slot) => slot.slot === use.slot)) continue;
        const claim = claimSharedStandingSlot(context, coordination, shared.remote, {
          proposal: loaded.proposal,
          slot: use.slot,
          delivery: use.delivery,
          profileRef: use.profile_ref,
        });
        actions.push(claim.published
          ? `slot ${use.slot} shared`
          : `slot ${use.slot} not shared: ${claim.error || `delivery ${claim.holder?.delivery?.id} holds it on the remote`}`);
      }
      if (actions.length > 0) shared = sharedStandingState(context, loaded);
    }
    return { loaded, shared, actions };
  });
  const summary = sharedStateSummary(result.shared);
  const italian = humanGuidanceLocale(options) === "it";
  const failedActions = result.actions.filter((action) => / not shared: /u.test(action));
  const unsharedRevocation = summary.scope === "shared" && Boolean(result.loaded.revocation) && !summary.revoked;
  const problems = (summary.scope === "shared" && (!summary.checked || summary.problems.length > 0))
    || failedActions.length > 0
    || unsharedRevocation;
  output(options, {
    status: problems ? "attention" : "ok",
    standing_approval_id: id,
    shared_state: summary,
    actions: result.actions,
  }, humanGuidanceLines({
    result: summary.scope !== "shared"
      ? (italian ? "Lo stato di questa approvazione permanente resta su questo computer." : "This standing approval's state stays on this computer.")
      : problems && summary.checked
        ? (italian
            ? `Lo stato condiviso sul remote git '${summary.remote}' NON è aggiornato: ${failedActions.join("; ") || "la revoca non risulta condivisa"}.`
            : `The shared state on the git remote '${summary.remote}' is NOT up to date: ${failedActions.join("; ") || "the revocation is not shared"}.`)
      : summary.checked
        ? (italian ? `Lo stato condiviso sul remote git '${summary.remote}' è aggiornato.` : `The shared state on the git remote '${summary.remote}' is up to date.`)
        : (italian ? `Il remote git '${summary.remote}' non risponde: ${summary.error}.` : `The git remote '${summary.remote}' cannot be reached: ${summary.error}.`),
    impact: summary.scope !== "shared"
      ? (italian ? `Nota: ${summary.note}.` : `Note: ${summary.note}.`)
      : (italian
          ? `Consegne registrate per tutti: ${summary.shared_slots.length}; revocata: ${summary.revoked ? "sì" : "no"}.`
          : `Deliveries recorded for everyone: ${summary.shared_slots.length}; revoked: ${summary.revoked ? "yes" : "no"}.`),
    required_decision: italian ? "Nessuna." : "None.",
    protection_boundary: italian
      ? "Se lo stato condiviso non è verificabile, l’approvazione permanente non copre nulla e ogni passo chiede la conferma normale."
      : "When the shared state cannot be checked, the standing approval covers nothing and every step asks for the normal confirmation.",
    next_action: problems
      ? (italian ? "Ripristina la connessione al remote e riesegui sync." : "Restore access to the remote and run sync again.")
      : (italian ? "Nessuna." : "None."),
  }, [...result.actions, ...(summary.problems || []).map((problem) => `problem: ${problem}`)], options));
}

export function showStandingApprovals(context, options) {
  ensureInitialized(context);
  const id = getOptionString(options, "id");
  const loaded = id ? [loadStandingApproval(context, id)] : listStandingApprovals(context);
  const approvals = loaded.map((item) => withSharedSummary(context, item));
  const italian = humanGuidanceLocale(options) === "it";
  const active = approvals.filter((item) => item.status === "active");
  output(options, { status: "ok", standing_approvals: approvals }, humanGuidanceLines({
    result: approvals.length === 0
      ? (italian ? "Non ci sono approvazioni permanenti." : "There are no standing approvals.")
      : (italian
          ? `${active.length} approvazioni permanenti attive su ${approvals.length}.`
          : `${active.length} of ${approvals.length} standing approvals are active.`),
    impact: italian
      ? "Solo le approvazioni attive possono sostituire le conferme di una consegna, e solo entro i loro limiti."
      : "Only active standing approvals can replace a delivery's confirmations, and only inside their limits.",
    required_decision: approvals.some((item) => item.warnings.length > 0)
      ? (italian ? "Alcune approvazioni scadono presto o sono quasi esaurite: decidi se rinnovarle." : "Some approvals expire soon or are nearly used up: decide whether to renew them.")
      : (italian ? "Nessuna." : "None."),
    protection_boundary: italian
      ? "Merge, produzione e deploy non sono mai coperti."
      : "Merges, production, and deploys are never covered.",
    next_action: italian
      ? "Usa explain per i dettagli o revoke per fermarne una."
      : "Use explain for details or revoke to stop one.",
  }, approvals.flatMap((item) => [
    `${item.id}: ${item.status}; ${item.used}/${item.max_deliveries} used, ${item.remaining} left; expires ${item.expires_at}`,
    `  ${item.id} shared state: ${sharedStateLine(item.shared_state)}`,
    ...(item.budget_usage ? [`  ${item.id} ${standingBudgetUsageLine(item.budget_usage, { italian })}`] : []),
    ...item.uses.map((use) => `  ${item.id} use ${use.slot}: ${use.delivery_kind} ${use.delivery_id} (story ${use.story_id || "-"})`),
    ...item.warnings.map((warning) => `  warning: ${warning}`),
    ...(item.status !== "active" ? item.reasons.map((reason) => `  reason: ${reason}`) : []),
  ]), options));
}

export function explainStandingApproval(context, options) {
  ensureInitialized(context);
  const loaded = loadStandingApproval(context, requireOption(options, "id"));
  const italian = humanGuidanceLocale(options) === "it";
  const summary = withSharedSummary(context, loaded);
  if (!loaded.proposal) {
    fail(`Standing approval ${loaded.id} cannot be explained: ${loaded.integrity_errors.join("; ")}.`);
  }
  const statusText = {
    active: italian ? "è attiva" : "is active",
    proposed: italian ? "attende la tua approvazione" : "is waiting for your approval",
    revoked: italian ? "è revocata" : "is revoked",
    expired: italian ? "è scaduta" : "has expired",
    exhausted: italian ? "ha esaurito le consegne" : "has no deliveries left",
    stale: italian ? "è sospesa perché le regole del progetto sono cambiate" : "is suspended because the project rules changed",
    disabled: italian ? "è disattivata dalla configurazione" : "is disabled by the configuration",
    invalid: italian ? "non è valida" : "is not valid",
  }[summary.status];
  output(options, {
    status: "ok",
    standing_approval: summary,
    plain_language: standingPlainLanguage(loaded.proposal, { italian }),
  }, humanGuidanceLines({
    result: italian ? `L’approvazione permanente ${statusText}.` : `The standing approval ${statusText}.`,
    impact: standingPlainLanguage(loaded.proposal, { italian }),
    required_decision: summary.status === "proposed"
      ? (italian ? "Approvala solo se questi limiti sono esattamente ciò che vuoi." : "Approve it only if these limits are exactly what you want.")
      : (italian ? "Nessuna." : "None."),
    protection_boundary: italian
      ? "Merge, produzione, deploy, migrazioni di dati e cancellazioni fuori dai percorsi non sono mai coperti; ogni controllo continua a girare."
      : "Merges, production, deploys, data migrations, and deletions outside the paths are never covered; every check still runs.",
    next_action: italian
      ? `Consegne usate: ${summary.used} di ${summary.max_deliveries}; scadenza ${summary.expires_at}.`
      : `Deliveries used: ${summary.used} of ${summary.max_deliveries}; expires ${summary.expires_at}.`,
  }, [
    `Standing approval: ${summary.id}`,
    `Recipe: ${summary.recipe_id}`,
    `Status: ${summary.status}${summary.reasons.length > 0 ? ` (${summary.reasons.join("; ")})` : ""}`,
    `Shared state: ${sharedStateLine(summary.shared_state)}`,
    ...(summary.budget_usage ? [`${italian ? "Costo" : "Cost"}: ${standingBudgetUsageLine(summary.budget_usage, { italian })}`] : []),
    ...summary.uses.map((use) => `Use ${use.slot}: ${use.delivery_kind} ${use.delivery_id} at ${use.used_at}`),
  ], options));
}

function storyRequirementIds(context, storyId) {
  const story = storyId ? readStory(context, storyId) : null;
  return [...new Set(story?.links?.requirements || [])].map(normalizeId);
}

/**
 * Contract (work brief) approval under a standing approval: the story must
 * stay inside the delegated requirements and the brief must allow the
 * delegated working level. The person's approval of the standing approval is
 * what stands in for their approval of each matching brief.
 */
export function requireStandingContractCoverage(context, options, contract, attribution) {
  const id = normalizeId(getOptionString(options, "standing-approval"));
  assertStandingOnlyOptions(options, "contract approve");
  requireStandingActor(attribution, "contract approve");
  const loaded = loadStandingApproval(context, id);
  const reasons = [...activeReasons(loaded)];
  if (loaded.proposal) {
    const requirementIds = storyRequirementIds(context, contract.story_id);
    const allowed = new Set(loaded.proposal.requirement_refs.map((ref) => ref.id));
    if (!contract.story_id) reasons.push("the work brief is not bound to a story");
    if (requirementIds.length === 0) reasons.push("the story is not bound to an approved requirement");
    const extra = requirementIds.filter((requirementId) => !allowed.has(requirementId));
    if (extra.length > 0) reasons.push(`requirement ${extra.join(", ")} is outside the standing approval`);
    reasons.push(...requirementDriftReasons(context, loaded, requirementIds));
    if (!contract.delivery_execution_profile_id) {
      reasons.push("the work brief does not name the exact delivery it belongs to");
    } else {
      reasons.push(...standingContractProfileReasons(context, loaded, contract));
    }
    reasons.push(...standingContractBoundReasons(contract));
    reasons.push(...sharedReasons(context, loaded));
    const directApprovals = contractDirectApprovalRequirements(contract);
    if (directApprovals.length > 0) {
      reasons.push(`the work brief requires a direct approval for ${directApprovals.join(", ")}`);
    }
    if ((context.config.authority_policy?.mode || "audit_only") === "host_verified") {
      reasons.push("this project requires a trusted signed approval, which a standing approval cannot provide");
    }
    const level = String(contract.autonomy_level || "supervised");
    if ((AUTONOMY_LEVEL_RANK[level] ?? -1) < AUTONOMY_LEVEL_RANK[STANDING_APPROVAL_LEVEL]) {
      reasons.push(`the work brief allows only ${level} work, below the delegated ${STANDING_APPROVAL_LEVEL} level`);
    }
  }
  const requestedStatus = String(getOptionString(options, "status") || "approved").trim().toLowerCase();
  if (requestedStatus !== "approved") {
    reasons.push("a standing approval can only approve, never reject or request changes");
  }
  if (reasons.length > 0) {
    fail(coverageFailure(loaded, reasons, `show the work brief to the user and run contract approve with their explicit approval.`));
  }
  return { loaded, use: null };
}

/**
 * A brief approved under a standing approval names a delivery that is either
 * not proposed yet or proposed under this same standing approval, and the
 * deliveries those briefs name never outnumber the standing approval's count.
 */
function standingContractProfileReasons(context, loaded, contract) {
  const reasons = [];
  const profileId = normalizeId(contract.delivery_execution_profile_id);
  const profile = readDeliveryAutonomyProfile(context, profileId, { missingOk: true });
  if (profile) {
    const ref = standingApprovalRefForProfile(profile);
    if (!ref || ref.id !== loaded.id || ref.record_hash !== loaded.proposal.record_hash) {
      reasons.push(`delivery ${profileId} was not proposed under this standing approval`);
    }
  }
  const profiles = new Set([profileId]);
  for (const name of safeReadDir(path.join(context.sdlcRoot, "contracts"))) {
    if (!name.endsWith(".json")) continue;
    let other = null;
    try {
      other = readProjectJson(context, path.join(context.sdlcRoot, "contracts", name));
    } catch {
      continue;
    }
    if (!other || other.id === contract.id || !other.delivery_execution_profile_id) continue;
    const covered = (other.approvals || []).some((approval) => approval?.status === "approved"
      && approval?.standing_approval_ref?.id === loaded.id);
    if (covered) profiles.add(normalizeId(other.delivery_execution_profile_id));
  }
  if (profiles.size > loaded.proposal.max_deliveries) {
    reasons.push(`work briefs approved under it already name ${profiles.size - 1} deliveries, the most it allows is ${loaded.proposal.max_deliveries}`);
  }
  return reasons;
}

function relativeProjectPath(context, absolutePath) {
  const root = realRoot(context);
  // A not-yet-created release path is judged by the real path of its nearest
  // existing ancestor plus the planned remainder.
  let existing = path.resolve(String(absolutePath));
  const remainder = [];
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) {
    remainder.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  let resolved;
  try {
    resolved = path.join(fs.realpathSync.native(existing), ...remainder);
  } catch {
    return null;
  }
  const relative = path.relative(root, resolved);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null;
  }
  return relative.split(path.sep).join("/");
}

/** The static shape of one delivery, as the standing approval bounds read it. */
export function standingDeliveryDescriptor(context, profile) {
  const writeRoots = [];
  const outside = [];
  if (profile.delivery_kind === "local_release") {
    const target = profile.local_release_target || {};
    for (const rawPath of [
      ...(target.allowed_write_paths || []),
      ...(target.data_migration?.target_path ? [target.data_migration.target_path] : []),
      ...(target.data_migration?.backup?.path ? [target.data_migration.backup.path] : []),
    ]) {
      const relative = relativeProjectPath(context, rawPath);
      if (relative === null) outside.push(String(rawPath));
      else writeRoots.push(relative);
    }
  } else {
    writeRoots.push(...(profile.constraints?.allowed_write_paths || []));
  }
  return {
    kind: profile.delivery_kind,
    merge_allowed: profile.pull_request_target?.merge_allowed === true,
    ...(profile.delivery_kind === "pull_request"
      ? {
        repository: profile.pull_request_target?.repository || null,
        head_branch: profile.pull_request_target?.head_branch || null,
        base_branch: profile.pull_request_target?.base_branch || null,
      }
      : {}),
    level: profile.requested_level,
    requirement_ids: (profile.extensions?.requirement_ids || []).map(normalizeId),
    allowed_actions: deliveryTargetAllowedActions(profile),
    write_roots: [...new Set(writeRoots)].sort(),
    outside_project_paths: [...new Set(outside)].sort(),
    authority_mode: profile.authority_assurance?.mode === "host_verified"
      ? "host_verified"
      : context.config.authority_policy?.mode || "audit_only",
  };
}

/**
 * Proposal-time check: the profile records which standing approval it relies
 * on, and every delivery action becomes a confirmation point, so each step is
 * either covered by the standing approval or confirmed by a person.
 */
export function standingProfileProposalExtension(context, options, profileInput) {
  const id = normalizeId(getOptionString(options, "standing-approval"));
  const loaded = loadStandingApproval(context, id);
  const descriptor = standingDeliveryDescriptor(context, profileInput);
  const reasons = [...activeReasons(loaded)];
  if (loaded.proposal) {
    reasons.push(...standingDeliveryBoundReasons(loaded.proposal, descriptor));
    reasons.push(...requirementDriftReasons(context, loaded, descriptor.requirement_ids));
    const shared = sharedStandingState(context, loaded);
    reasons.push(...standingBudgetReasons(loaded.proposal, measureStandingDeliveryCost(context, profileInput, { loaded, shared, stage: "before_start" })));
    reasons.push(...(shared ? sharedStateReasons(loaded.proposal, shared, { localUses: loaded.uses }) : []));
  }
  if (reasons.length > 0) {
    fail(coverageFailure(loaded, reasons, "propose this delivery without --standing-approval and ask the user to choose how I should work."));
  }
  return {
    standing_approval_ref: { id: loaded.id, record_hash: loaded.proposal.record_hash },
    checkpoints: [...new Set([...(profileInput.checkpoints || []), ...descriptor.allowed_actions])].sort(),
  };
}

export function standingApprovalRefForProfile(profile) {
  const ref = profile?.extensions?.standing_approval_ref;
  return ref?.id && ref?.record_hash ? ref : null;
}

/** The slot held by this exact delivery profile, matched on profile id and delivery identity. */
function profileUse(loaded, profile) {
  return loaded.uses.find((use) => use.profile_ref?.id === profile.id
    && use.delivery?.id === profile.delivery_id
    && use.delivery?.kind === profile.delivery_kind) || null;
}

function deliveryUseResolution(loaded, profile) {
  return standingDeliveryUseResolution(loaded, {
    profile_id: profile.id,
    profile_hash: profile.profile_hash,
    delivery_id: profile.delivery_id,
    delivery_kind: profile.delivery_kind,
  });
}

/**
 * Delivery choice under a standing approval: re-checks every bound and then
 * consumes one delivery slot atomically. The caller holds the profile lock.
 */
export function consumeStandingDeliveryApproval(context, options, profile, attribution) {
  const id = normalizeId(getOptionString(options, "standing-approval"));
  assertStandingOnlyOptions(options, "autonomy delivery approve");
  requireStandingActor(attribution, "autonomy delivery approve");
  const ref = standingApprovalRefForProfile(profile);
  if (!ref || ref.id !== id) {
    fail(
      `Delivery ${profile.delivery_id} was not proposed under standing approval ${id}. `
      + "Propose the delivery again with --standing-approval so each of its steps stays checkable, or ask the user to approve it directly.",
    );
  }
  // The caller holds the standing approval lock until the derived approval
  // and the active delivery are written, so a revocation cannot land between.
  return (() => {
    const loaded = loadStandingApproval(context, id);
    const resolution = loaded.proposal ? deliveryUseResolution(loaded, profile) : { existing: null, reasons: [] };
    const holdsSlot = Boolean(resolution.existing);
    const reasons = [...activeReasons(loaded, { holdsSlot })];
    if (loaded.proposal && loaded.proposal.record_hash !== ref.record_hash) {
      reasons.push("the standing approval content differs from the one the delivery was proposed under");
    }
    if (loaded.proposal) {
      const descriptor = standingDeliveryDescriptor(context, profile);
      reasons.push(...standingDeliveryBoundReasons(loaded.proposal, descriptor));
      reasons.push(...requirementDriftReasons(context, loaded, descriptor.requirement_ids));
    }
    // A recorded slot is reused only for an exact retry; any mismatch is refused.
    reasons.push(...resolution.reasons);
    const existing = resolution.existing;
    const shared = sharedStandingState(context, loaded);
    if (loaded.proposal) {
      reasons.push(...standingBudgetReasons(loaded.proposal, measureStandingDeliveryCost(context, profile, { loaded, shared, stage: "before_start" })));
    }
    const profileIdentity = {
      deliveryId: profile.delivery_id,
      deliveryKind: profile.delivery_kind,
      profileId: profile.id,
      profileHash: profile.profile_hash,
    };
    // A slot this exact delivery already claimed on the remote (for example
    // before an interrupted run wrote its local record) is taken over, never claimed twice.
    const adopted = !existing && shared?.scope === "shared" && shared.available
      ? shared.slots.find((slot) => sharedSlotMatches(slot, profileIdentity)) || null
      : null;
    if (adopted && loaded.uses.some((use) => use.slot === adopted.slot)) {
      reasons.push(`slot ${adopted.slot} is recorded on this computer for another delivery`);
    }
    if (loaded.proposal && shared) {
      reasons.push(...sharedStateReasons(loaded.proposal, shared, { use: existing || adopted, localUses: loaded.uses }));
    }
    const fallback = "show the delivery limits to the user and run autonomy delivery approve with their explicit approval.";
    if (reasons.length > 0) fail(coverageFailure(loaded, [...new Set(reasons)], fallback));
    if (existing) return { loaded, use: existing, use_path: usePath(context, loaded, existing) };
    const nextSlot = adopted
      ? adopted.slot
      : claimStandingSlot(context, loaded, shared, profile, fallback);
    const use = buildStandingApprovalUse({
      proposal: loaded.proposal,
      approvalDecision: loaded.approval,
      slot: nextSlot,
      delivery: { id: profile.delivery_id, kind: profile.delivery_kind },
      profileRef: { id: profile.id, hash: profile.profile_hash },
      storyId: profile.story_refs?.[0]?.id || null,
      contractId: profile.contract_refs?.[0]?.id || null,
      createdAt: now(),
      actor: attribution.actor,
    });
    assertRecordSchema(use, "standing-approval-use.schema.json", `Standing approval use ${use.id}`);
    // The slot file name is the slot number: an exclusive create can succeed
    // for one delivery only, even if two processes raced past the lock.
    writeJsonFile(path.join(loaded.directory, USES_DIRECTORY, `${String(nextSlot).padStart(4, "0")}.json`), use, { atomicCreate: true });
    recordLocalStandingSlot(context, standingPolicy(context).coordination, {
      proposal: loaded.proposal,
      slot: nextSlot,
      delivery: use.delivery,
      profileRef: use.profile_ref,
    });
    return { loaded: { ...loaded, uses: [...loaded.uses, use] }, use, use_path: usePath(context, loaded, use) };
  })();
}

/**
 * Picks the next free slot and, when the state is shared, claims it on the
 * remote first: the remote accepts only one claim per slot, so two clones can
 * never both use the same slot or more slots than allowed.
 */
function claimStandingSlot(context, loaded, shared, profile, fallback) {
  const coordination = standingPolicy(context).coordination;
  let current = shared;
  if (current?.scope === "shared") {
    // Slots used here before the remote existed are shared first, so the
    // remote counts every delivery before a new one is claimed.
    for (const use of loaded.uses) {
      if (current.slots.some((slot) => slot.slot === use.slot)) continue;
      const claim = claimSharedStandingSlot(context, coordination, current.remote, {
        proposal: loaded.proposal,
        slot: use.slot,
        delivery: use.delivery,
        profileRef: use.profile_ref,
      });
      if (!claim.published) {
        const reason = claim.conflict
          ? `slot ${use.slot}, used on this computer by delivery ${use.delivery?.id}, is held by delivery ${claim.holder?.delivery?.id} on the git remote '${current.remote}'`
          : `slot ${use.slot}, used on this computer, could not be shared on the git remote '${current.remote}' (${claim.error})`;
        fail(coverageFailure(loaded, [reason], fallback));
      }
    }
    current = sharedStandingState(context, loaded);
    const reasons = sharedStateReasons(loaded.proposal, current, { localUses: loaded.uses });
    if (reasons.length > 0) fail(coverageFailure(loaded, reasons, fallback));
  }
  // Each conflict means another delivery took a slot, so at most every slot is tried once.
  for (let attempt = 0; attempt <= loaded.proposal.max_deliveries; attempt += 1) {
    const sharedSlots = current?.scope === "shared" && current.available ? current.slots : [];
    const slot = nextStandingSlot(loaded.proposal, loaded.uses, [...sharedSlots, ...(current?.localSlots || [])]);
    if (slot === null) {
      fail(coverageFailure(loaded, [`all ${loaded.proposal.max_deliveries} deliveries were used`], "ask the user to approve this delivery directly."));
    }
    if (current?.scope !== "shared") return slot;
    const claim = claimSharedStandingSlot(context, coordination, current.remote, {
      proposal: loaded.proposal,
      slot,
      delivery: { id: profile.delivery_id, kind: profile.delivery_kind },
      profileRef: { id: profile.id, hash: profile.profile_hash },
    });
    if (claim.published) return slot;
    if (claim.error) {
      fail(coverageFailure(loaded, [`slot ${slot} could not be recorded on the git remote '${current.remote}' (${claim.error})`], fallback));
    }
    current = sharedStandingState(context, loaded);
    const reasons = sharedStateReasons(loaded.proposal, current, { localUses: loaded.uses });
    if (reasons.length > 0) fail(coverageFailure(loaded, reasons, fallback));
  }
  fail(coverageFailure(loaded, ["other deliveries kept claiming the same slots at the same time"], "run the same command again, or ask the user to approve this delivery directly."));
  return null;
}

function usePath(context, loaded, use) {
  return toProjectPath(context, path.join(loaded.directory, USES_DIRECTORY, `${String(use.slot).padStart(4, "0")}.json`));
}

/** Builds the derived approval that stands in for a person's confirmation. */
export function buildStandingDerivedApproval(context, attribution, coverage, settings) {
  const { loaded, use } = coverage;
  const proposal = loaded.proposal;
  const approvedContentHash = hashApprovalSubject(settings.subject);
  return {
    id: `APR-${compactTimestamp()}-${crypto.randomBytes(3).toString("hex")}`,
    ...(settings.subject_id_field && settings.subject_id ? { [settings.subject_id_field]: settings.subject_id } : {}),
    status: "approved",
    summary: `Covered by standing approval ${proposal.id} (${proposal.work_kind.recipe_id}): ${proposal.work_kind.description}`,
    scope: {
      principle: "Derived from a user-approved standing approval; valid only inside its recorded bounds, before its expiry, and before any revocation.",
      subject_id: settings.subject_id || null,
      subject_label: settings.label || "approval",
      derived_from_standing_approval: true,
      standing_approval_id: proposal.id,
    },
    evidence: [],
    approval_source: STANDING_APPROVAL_SOURCE,
    standing_approval_ref: {
      id: proposal.id,
      record_hash: proposal.record_hash,
      approval_hash: loaded.approval.record_hash,
      use_ref: use ? { id: use.id, path: usePath(context, loaded, use), hash: use.record_hash } : null,
    },
    authorization_ref: null,
    authorization_use_ref: null,
    authorization_action: null,
    explicit_user_confirmation: false,
    provisional: false,
    approved_content_hash: approvedContentHash,
    hash_algorithm: "sha256:stable-json:v1",
    approved_by: attribution.actor,
    git: attribution.git,
    run: attribution.run,
    created_at: now(),
  };
}

/** Records, in the story trace, that a step ran under a standing approval. */
export function traceStandingApprovalEvent(context, storyId, attribution, { kind, coverage, summary, related = [], evidence = [] }) {
  const proposal = coverage.loaded.proposal;
  appendTraceEvent(context, storyId, {
    type: "gate",
    summary,
    action: `autonomy.standing.${kind}`,
    actor: attribution.actor,
    evidence,
    related: [proposal.id, ...related],
    request: {
      id: `standing-approval:${proposal.id}:${kind}:${related.join(":")}:${compactTimestamp()}`,
      source: `autonomy.standing.${kind}`,
      standing_approval_id: proposal.id,
      standing_approval_hash: proposal.record_hash,
      use_id: coverage.use?.id || null,
    },
    git: attribution.git,
    run: attribution.run,
  });
}

/**
 * Every changed path since the delivery's task start (governance records
 * excluded), with added and deleted line counts. Untracked files count as
 * fully added; binary content is flagged so the bound fails closed.
 */
export function observedDeliveryChanges(context, profile) {
  const storyId = profile.story_refs?.[0]?.id;
  const taskStartPath = storyId ? path.join(context.sdlcRoot, "stories", normalizeId(storyId), "task-start.json") : null;
  if (!taskStartPath || !fs.existsSync(taskStartPath)) {
    return { measurable: false, error: "the delivery has not started" };
  }
  const base = taskStartGitBase(readProjectJson(context, taskStartPath));
  const baseline = base.kind === "commit" ? base.sha : base.kind === "unborn" ? base.tree : null;
  if (!baseline) return { measurable: false, error: "the delivery start has no verifiable Git base" };
  const numstat = execGitOutput(context.root, ["diff", "--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", baseline, "--"]);
  const nameStatus = execGitOutput(context.root, ["diff", "--name-status", "-z", "--no-renames", "--no-ext-diff", baseline, "--"]);
  const untracked = execGitOutput(context.root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (numstat === null || nameStatus === null || untracked === null) {
    return { measurable: false, error: "Git could not compare the working tree with the delivery start" };
  }
  const files = new Map();
  const numstatFields = numstat.split("\0");
  for (const field of numstatFields) {
    const match = /^(-|\d+)\t(-|\d+)\t(.+)$/su.exec(field.replace(/^\n/u, ""));
    if (!match) continue;
    const filePath = match[3];
    files.set(filePath, {
      path: filePath,
      added: match[1] === "-" ? 0 : Number(match[1]),
      deleted: match[2] === "-" ? 0 : Number(match[2]),
      binary: match[1] === "-" || match[2] === "-",
      deleted_file: false,
    });
  }
  const statusFields = nameStatus.split("\0").filter((field) => field !== "");
  for (let index = 0; index + 1 < statusFields.length; index += 2) {
    const status = statusFields[index].replace(/^\n/u, "");
    const filePath = statusFields[index + 1];
    const entry = files.get(filePath) || { path: filePath, added: 0, deleted: 0, binary: false, deleted_file: false };
    entry.deleted_file = status.startsWith("D");
    files.set(filePath, entry);
  }
  for (const filePath of untracked.split("\0").filter(Boolean)) {
    if (files.has(filePath)) continue;
    const absolute = path.join(context.root, filePath);
    let stat;
    try {
      stat = fs.lstatSync(absolute);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > MAX_UNTRACKED_FILE_BYTES) {
      files.set(filePath, { path: filePath, added: 0, deleted: 0, binary: true, deleted_file: false });
      continue;
    }
    const content = fs.readFileSync(absolute);
    const binary = content.subarray(0, BINARY_PROBE_BYTES).includes(0);
    const text = binary ? "" : content.toString("utf8");
    const lines = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    files.set(filePath, { path: filePath, added: lines, deleted: 0, binary, deleted_file: false });
  }
  return {
    measurable: true,
    files: [...files.values()]
      .filter((file) => !file.path.startsWith(SDLC_PREFIX) && file.path !== ".sdlc")
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
  };
}

function unmeasurable(reason) {
  return { measurable: false, reason };
}

function firstLine(message) {
  return String(message || "").split("\n")[0].replace(/\.$/u, "");
}

/** Every delivery profile that used this standing approval, here or on the shared remote. */
function standingDeliveryProfileIds(loaded, shared) {
  const ids = new Set((loaded?.uses || []).map((use) => use.profile_ref?.id).filter(Boolean));
  if (shared?.scope === "shared" && shared.available) {
    for (const slot of shared.slots || []) if (slot.profile_ref?.id) ids.add(slot.profile_ref.id);
  }
  for (const slot of shared?.localSlots || []) if (slot.profile_ref?.id) ids.add(slot.profile_ref.id);
  return [...ids].sort();
}

/**
 * Delivery cost for a standing approval budget, from the delivery's recorded
 * usage. Only a cost a meter reported and the CLI verified (an adapter
 * observation that matches its stored delta, or a reading whose signature a
 * trusted key verifies) makes a delivery measured; a cost declared by hand
 * still counts toward the amounts. Before a delivery starts (its proposal
 * and approval) its cost so far counts, which may be nothing. For a delivery
 * step the reading must be fresh (see deliveryCostReading). The total adds
 * the cost of every delivery that used the standing approval, each with a
 * fresh verified reading; one without makes the total unmeasurable, and the
 * step is not covered.
 */
export function measureStandingDeliveryCost(context, profile, { loaded = null, shared = null, stage = "step" } = {}) {
  const budget = loaded?.proposal?.budget;
  if (!budget) return unmeasurable("no cost budget is set");
  if (deliveryCostSources(context).length === 0) {
    return unmeasurable("no meter that reports delivery cost is configured any more");
  }
  let own;
  try {
    own = deliveryCostReading(context, profile, { requireReading: stage === "step" });
  } catch (error) {
    return unmeasurable(`this delivery's usage records cannot be trusted: ${firstLine(error.message)}`);
  }
  if (own.summary.currency && own.summary.currency !== budget.currency) {
    return { measurable: true, currency: own.summary.currency, delivery_amount: own.summary.cost?.amount ?? "0", total_amount: null };
  }
  if (own.problems.length > 0) return unmeasurable(own.problems.join("; "));
  const deliveryAmount = own.summary.cost?.amount ?? "0";
  const deliveries = [{ profile_id: profile.id, amount: deliveryAmount }];
  let totalAmount = null;
  if (budget.total_amount !== null && budget.total_amount !== undefined) {
    for (const id of standingDeliveryProfileIds(loaded, shared).filter((candidate) => candidate !== profile.id)) {
      let other;
      try {
        other = readDeliveryAutonomyProfile(context, id, { missingOk: true });
      } catch (error) {
        return unmeasurable(`delivery ${id} used this standing approval, but its record cannot be read: ${firstLine(error.message)}`);
      }
      if (!other) {
        return unmeasurable(`delivery ${id} used this standing approval, but its records are not on this computer, so its cost is unknown here`);
      }
      let reading;
      try {
        reading = deliveryCostReading(context, other);
      } catch (error) {
        return unmeasurable(`the usage records of delivery ${id} cannot be trusted: ${firstLine(error.message)}`);
      }
      if (reading.problems.length > 0) {
        return unmeasurable(`delivery ${id} used this standing approval, but its cost is not freshly measured: ${reading.problems.join("; ")}`);
      }
      if (reading.summary.currency !== budget.currency) {
        return unmeasurable(`delivery ${id} recorded its cost in ${reading.summary.currency}, not ${budget.currency}`);
      }
      deliveries.push({ profile_id: id, amount: reading.summary.cost?.amount ?? "0" });
    }
    totalAmount = sumAmounts(deliveries.map((entry) => entry.amount));
    if (totalAmount === null) return unmeasurable("a recorded cost cannot be read as an exact amount");
  }
  return {
    measurable: true,
    currency: budget.currency,
    delivery_amount: deliveryAmount,
    total_amount: totalAmount,
    deliveries,
    metered_at: own.summary.latest_metered_cost_at,
  };
}

/**
 * Current coverage of one delivery step. Returns the reasons it is not
 * covered; an empty list means the standing approval may stand in for the
 * person's confirmation of this exact step.
 */
export function evaluateStandingStepCoverage(context, profile, action) {
  const ref = standingApprovalRefForProfile(profile);
  if (!ref) return null;
  const loaded = loadStandingApproval(context, ref.id, { missingOk: true });
  if (!loaded) {
    return { loaded: { id: ref.id }, use: null, reasons: ["the standing approval record is missing"] };
  }
  const use = loaded.proposal ? profileUse(loaded, profile) : null;
  const reasons = [...activeReasons(loaded, { holdsSlot: Boolean(use) })];
  if (loaded.proposal) {
    if (loaded.proposal.record_hash !== ref.record_hash) {
      reasons.push("the standing approval content differs from the one the delivery was proposed under");
    }
    if (!use) {
      reasons.push("this delivery was approved directly, not under the standing approval");
    } else if (use.profile_ref?.hash !== (profile.extensions?.approved_profile_hash || profile.profile_hash)) {
      // The slot binds the exact proposed content the standing approval approved.
      reasons.push("the delivery changed after it used the standing approval");
    }
    const descriptor = standingDeliveryDescriptor(context, profile);
    reasons.push(...standingDeliveryBoundReasons(loaded.proposal, descriptor));
    reasons.push(...requirementDriftReasons(context, loaded, descriptor.requirement_ids));
    reasons.push(...standingActionReasons(loaded.proposal, action));
    reasons.push(...standingChangeReasons(loaded.proposal, observedDeliveryChanges(context, profile)));
    const shared = sharedStandingState(context, loaded);
    reasons.push(...standingBudgetReasons(loaded.proposal, measureStandingDeliveryCost(context, profile, { loaded, shared, stage: "step" })));
    reasons.push(...(shared ? sharedStateReasons(loaded.proposal, shared, { use, localUses: loaded.uses }) : []));
  }
  return { loaded, use, reasons: [...new Set(reasons)] };
}

export function standingFallbackMessage(coverage, action) {
  return coverageFailure(
    coverage.loaded,
    coverage.reasons,
    `show the ${action} decision to the user and rerun with --confirm-action and their explicit approval.`,
  );
}

/**
 * Strict-gate check of one derived approval: the standing approval records
 * are intact, the derived approval was created while it was approved,
 * unexpired, and unrevoked, and any delivery slot it names is the exact one.
 */
export function standingDerivedApprovalRecordErrors(context, approval, settings = {}) {
  const ref = approval?.standing_approval_ref;
  if (!ref?.id) return ["it does not name its standing approval"];
  if (!approval.contract_id && !approval.profile_id) {
    return ["a standing approval can only confirm a work brief, a delivery choice, or a delivery action"];
  }
  let loaded;
  try {
    loaded = loadStandingApproval(context, ref.id, { missingOk: true });
  } catch (error) {
    return [`its standing approval cannot be read: ${error.message}`];
  }
  if (!loaded?.proposal) return [`its standing approval ${ref.id} is missing`];
  if (loaded.integrity_errors.length > 0) {
    return [`its standing approval ${ref.id} is invalid: ${loaded.integrity_errors.join("; ")}`];
  }
  if (!loaded.approval) return [`its standing approval ${ref.id} was never approved`];
  const errors = standingDerivedApprovalErrors({
    derived: approval,
    proposal: loaded.proposal,
    approval: loaded.approval,
    revocation: loaded.revocation,
  });
  if (ref.use_ref) {
    const use = loaded.uses.find((candidate) => candidate.id === ref.use_ref.id);
    if (!use || use.record_hash !== ref.use_ref.hash) {
      errors.push(`its delivery slot ${ref.use_ref.id} is missing or changed`);
    } else if (settings.subject_id && use.profile_ref?.id !== settings.subject_id) {
      errors.push(`its delivery slot belongs to ${use.profile_ref?.id}, not ${settings.subject_id}`);
    } else if (Date.parse(approval.created_at) < Date.parse(use.created_at)) {
      errors.push("it predates the delivery slot it names");
    }
  } else if (approval.profile_id || settings.require_use === true) {
    errors.push("it confirms a delivery but does not name the delivery slot that delivery consumed");
  }
  return errors;
}

export { STANDING_APPROVAL_SOURCE };
