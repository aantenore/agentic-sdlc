import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  runsInsideAgentHost,
} from "../agent-host.mjs";
import {
  DELEGATED_APPROVAL_SOURCE,
  DELIVERY_POLICY_ACTION,
  DELEGATION_GRANT_ACTION,
  DELEGATION_ID_PATTERN,
  DELEGATION_NEVER_DELEGABLE,
  DELEGATION_REVOCATION_SCHEMA_VERSION,
  DELEGATION_REVOKE_ACTION,
  DELEGATION_SCHEMA_VERSION,
  DELEGATION_USE_SCHEMA_VERSION,
  classifyDelegation,
  delegatedApprovalStatement,
  delegatedChoiceStatement,
  delegationGrantorName,
  evaluateDelegationUse,
  formatDelegationScope,
  formatDeliveryPolicy,
  normalizeDelegationActions,
  parseDelegationScope,
  parseDelegationUntil,
  parseDeliveryPolicy,
  sealDelegationRecord,
} from "../approval-delegation.mjs";
import {
  fail,
} from "../cli/user-error.mjs";
import {
  requireFormalApprovalActor,
} from "../lifecycle/authorization.mjs";
import {
  getOptionString,
  normalizeId,
  requireOption,
} from "../lifecycle/common.mjs";
import {
  humanGuidanceLocale,
} from "../lifecycle/guidance.mjs";
import {
  toProjectPath,
} from "../lifecycle/project.mjs";
import {
  buildApprovalRecord,
  loadAutonomyAuthorityAssurance,
} from "./authorization.mjs";
import {
  buildAttribution,
  now,
  uniqueRecordSuffix,
} from "./common.mjs";
import {
  VERIFIED_DELEGATION_USE,
  delegationDirectory,
  delegationRecordPath,
  delegationRevocationPath,
  delegationUsesRoot,
  listDelegationIds,
  readDelegationRecord,
  readDelegationRevocation,
  readDelegationUses,
} from "./delegation-records.mjs";
import {
  ensureInitialized,
} from "./migration.mjs";
import {
  output,
} from "./output.mjs";
import {
  acquireFileLock,
  ensureDir,
  writeJsonFile,
} from "./storage.mjs";
import {
  appendTraceEvent,
} from "./story.mjs";

const DEFAULT_EXPIRY_WARNING_HOURS = 72;

function warningHours(context) {
  const value = Number(context.config?.delegation_policy?.expiry_warning_hours);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_EXPIRY_WARNING_HOURS;
}

function maxValidityDays(context) {
  const value = Number(context.config?.delegation_policy?.max_validity_days);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function delegationId(options) {
  const id = normalizeId(requireOption(options, "id"));
  if (!DELEGATION_ID_PATTERN.test(id)) fail(`--id must start with DLG- (for example DLG-TRAVELOPS-001); got ${id}.`);
  return id;
}

function usageError(error) {
  if (error?.code === "DELEGATION_INVALID") fail(error.message);
  throw error;
}

/**
 * Only the person, in their own terminal, grants or revokes a delegation: the
 * same authority as every other person-only approval (outside an agent
 * session, --actor-type human, --approval-source explicit-user, and the
 * trusted host receipt where the project requires signed approvals).
 */
function requirePersonAuthority(context, options, action, label, subject) {
  if (runsInsideAgentHost()) {
    fail(
      `${label} is the person's own decision and cannot run inside an agent session. `
      + "An agent never creates or changes the delegation it would use. The user runs the command in their own terminal.",
    );
  }
  const attribution = buildAttribution(context, options, action);
  requireFormalApprovalActor(context, options, attribution, label);
  if (attribution.actor.type !== "human" || getOptionString(options, "approval-source") !== "explicit-user") {
    fail(`${label} needs --actor-type human and --approval-source explicit-user.`);
  }
  const assurance = loadAutonomyAuthorityAssurance(context, options, action, subject);
  return { attribution, assurance };
}

export function grantDelegation(context, options) {
  ensureInitialized(context);
  const id = delegationId(options);
  const summary = getOptionString(options, "summary");
  if (!summary) fail("--summary must say, in the person's own words, why the agent may apply these approvals.");
  let scope;
  let actions;
  let expiresAt;
  const grantedAt = now();
  try {
    scope = parseDelegationScope(requireOption(options, "scope"));
    actions = normalizeDelegationActions(requireOption(options, "actions"));
    expiresAt = parseDelegationUntil(requireOption(options, "until"), { now: grantedAt, maxDays: maxValidityDays(context) });
  } catch (error) {
    usageError(error);
  }
  const deliveryPolicy = grantedDeliveryPolicy(options, actions);
  const subject = {
    kind: "approval_delegation", id, scope, actions, expires_at: expiresAt,
    ...(deliveryPolicy ? { delivery_policy: deliveryPolicy } : {}),
  };
  const { attribution, assurance } = requirePersonAuthority(context, options, DELEGATION_GRANT_ACTION, "Granting a delegation", subject);
  const recordPath = delegationRecordPath(context, id);
  ensureDir(delegationDirectory(context, id));
  const releaseLock = acquireFileLock(`${recordPath}.lock`);
  let record;
  try {
    if (readDelegationRecord(context, id)) fail(`Delegation ${id} already exists; grant a new id to change its limits.`);
    const approval = buildApprovalRecord(context, options, attribution, {
      subject,
      subject_id_field: "delegation_id",
      subject_id: id,
      status: "approved",
      scope: "approval-delegation",
      label: `delegation ${id}`,
    });
    record = sealDelegationRecord({
      id,
      kind: "approval_delegation",
      schema_version: DELEGATION_SCHEMA_VERSION,
      status: "approved",
      scope,
      actions,
      ...(deliveryPolicy ? { delivery_policy: deliveryPolicy } : {}),
      never_delegable: DELEGATION_NEVER_DELEGABLE.map((item) => ({ id: item.id, reason: item.reason })),
      summary,
      valid_from: grantedAt,
      expires_at: expiresAt,
      grantor: { ...attribution.actor, host: os.hostname() },
      approval,
      authority_assurance: assurance,
      grant_receipt: {
        id: `DLGR-${uniqueRecordSuffix()}`,
        action: DELEGATION_GRANT_ACTION,
        granted_at: grantedAt,
        git: attribution.git,
        run: attribution.run,
      },
      created_at: grantedAt,
    });
    writeJsonFile(recordPath, record, { atomicCreate: true });
  } finally {
    releaseLock();
  }
  appendTraceEvent(context, null, {
    type: "decision",
    action: DELEGATION_GRANT_ACTION,
    summary: `${delegationGrantorName(record)} delegated to the agent ${actions.join(", ")}${deliveryPolicy ? ` (delivery policy ${formatDeliveryPolicy(deliveryPolicy)})` : ""} on ${formatDelegationScope(scope)} until ${expiresAt}: ${summary}`,
    actor: attribution.actor,
    evidence: [toProjectPath(context, recordPath)],
    related: [id],
    git: attribution.git,
    run: attribution.run,
  });
  const italian = humanGuidanceLocale(options) === "it";
  output(options, { status: "granted", delegation: record, delegation_path: toProjectPath(context, recordPath) }, italian
    ? [
        `Delega ${id} concessa da ${delegationGrantorName(record)}.`,
        `Ambito: ${formatDelegationScope(scope)}. Azioni: ${actions.join(", ")}. Scade: ${expiresAt}.`,
        ...(deliveryPolicy ? [`Scelte di consegna per ogni nuova pull request: ${formatDeliveryPolicy(deliveryPolicy)}.`] : []),
        "Mai delegabili: push/merge di branch protetti fuori dalla catena governata, variabili AGENTIC_SDLC_ALLOW_UNGOVERNED_*, deploy/produzione, segreti, installazioni.",
        `Revoca in qualsiasi momento: agentic-sdlc autonomy delegation revoke --id ${id} --reason "<perché>" --actor-type human --approval-source explicit-user --summary "<parole tue>"`,
      ]
    : [
        `Delegation ${id} granted by ${delegationGrantorName(record)}.`,
        `Scope: ${formatDelegationScope(scope)}. Actions: ${actions.join(", ")}. Expires: ${expiresAt}.`,
        ...(deliveryPolicy ? [`Delivery choices for every new pull request: ${formatDeliveryPolicy(deliveryPolicy)}.`] : []),
        "Never delegable: protected-branch push/merge outside the governed chain, AGENTIC_SDLC_ALLOW_UNGOVERNED_* variables, deploy/production, secrets, installs.",
        `Revoke at any time: agentic-sdlc autonomy delegation revoke --id ${id} --reason "<why>" --actor-type human --approval-source explicit-user --summary "<your words>"`,
      ]);
  return record;
}

/** --delivery-policy: required with delivery.policy, refused without it. */
function grantedDeliveryPolicy(options, actions) {
  const raw = getOptionString(options, "delivery-policy");
  const covers = actions.includes(DELIVERY_POLICY_ACTION);
  if (!covers) {
    if (raw) fail(`--delivery-policy is recorded only with the action ${DELIVERY_POLICY_ACTION}.`);
    return null;
  }
  if (!raw) {
    fail(`${DELIVERY_POLICY_ACTION} needs --delivery-policy with the person's answers, for example --delivery-policy code-review=not-required,merge=automatic.`);
  }
  try {
    return parseDeliveryPolicy(raw);
  } catch (error) {
    return usageError(error);
  }
}

/**
 * The person's delivery answers for `autonomy delivery propose`, from a
 * delegation covering delivery.policy. Returns null without
 * --approval-source delegated, so the usual question applies. Refuses a
 * delegation that is missing, expired, revoked, altered, outside its scope,
 * or that does not cover delivery.policy. The answers are only those the
 * person signed; nothing is inferred from earlier stories.
 */
export function delegatedDeliveryPolicy(context, options, { kind, storyId }) {
  const source = String(getOptionString(options, "approval-source") || "").trim().toLowerCase();
  if (source !== DELEGATED_APPROVAL_SOURCE && !getOptionString(options, "delegation")) return null;
  if (source === DELEGATED_APPROVAL_SOURCE && kind !== "pull_request") {
    fail(`A ${DELIVERY_POLICY_ACTION} delegation answers the pull-request questions (code review, merge); a local release has none.`);
  }
  // An explicit answer for a question the delegation already answers is refused before any use is recorded.
  const requested = getOptionString(options, "delegation");
  const signed = requested ? readDelegationRecord(context, normalizeId(requested))?.delivery_policy : null;
  for (const [field, option] of [["code_review", "code-review"], ["merge", "merge"]]) {
    if (signed?.[field] && getOptionString(options, option)) {
      fail(`Delegation ${normalizeId(requested)} already gives the person's answer on ${option} (${signed[field]}); drop --${option} or the delegation.`);
    }
  }
  const delegated = applyApprovalDelegation(context, options, DELIVERY_POLICY_ACTION, { story: storyId });
  if (!delegated) return null;
  const policy = delegated.record.delivery_policy;
  if (!policy || (!policy.code_review && !policy.merge)) {
    fail(`Delegation ${delegated.record.id} covers ${DELIVERY_POLICY_ACTION} but records no --delivery-policy answers; the person grants a new delegation with them.`);
  }
  return {
    id: delegated.record.id,
    policy,
    actor_id: delegated.record.grantor?.id || delegated.record.grantor?.name || "user",
    statement: delegatedChoiceStatement(delegated.record),
    use_path: delegated.use_path,
  };
}

export function revokeDelegation(context, options) {
  ensureInitialized(context);
  const id = delegationId(options);
  const reason = getOptionString(options, "reason");
  if (!reason) fail("--reason must say why the delegation ends.");
  const record = readDelegationRecord(context, id);
  if (!record) fail(`Delegation ${id} does not exist.`);
  const { attribution } = requirePersonAuthority(context, options, DELEGATION_REVOKE_ACTION, "Revoking a delegation", {
    kind: "approval_delegation_revocation",
    id,
    record_hash: record.record_hash,
  });
  const revocationPath = delegationRevocationPath(context, id);
  const releaseLock = acquireFileLock(`${revocationPath}.lock`);
  let revocation;
  try {
    const existing = readDelegationRevocation(context, id);
    if (existing) fail(`Delegation ${id} was already revoked on ${existing.revoked_at}.`);
    revocation = sealDelegationRecord({
      id: `DLGREV-${uniqueRecordSuffix()}`,
      schema_version: DELEGATION_REVOCATION_SCHEMA_VERSION,
      delegation_ref: { id, record_hash: record.record_hash },
      reason,
      summary: getOptionString(options, "summary") || null,
      revoked_by: { ...attribution.actor, host: os.hostname() },
      revoked_at: now(),
      git: attribution.git,
    });
    writeJsonFile(revocationPath, revocation, { atomicCreate: true });
  } finally {
    releaseLock();
  }
  appendTraceEvent(context, null, {
    type: "decision",
    action: DELEGATION_REVOKE_ACTION,
    summary: `Delegation ${id} revoked: ${reason}`,
    actor: attribution.actor,
    evidence: [toProjectPath(context, revocationPath)],
    related: [id],
    git: attribution.git,
    run: attribution.run,
  });
  output(options, { status: "revoked", delegation_id: id, revocation }, [
    humanGuidanceLocale(options) === "it" ? `Delega ${id} revocata: ${reason}` : `Delegation ${id} revoked: ${reason}`,
  ]);
  return revocation;
}

/** Every delegation with its state (active, expiring, expired, revoked, invalid) and its uses. */
export function delegationOverview(context, { at = now() } = {}) {
  return listDelegationIds(context).map((id) => {
    const record = readDelegationRecord(context, id);
    const revocation = readDelegationRevocation(context, id);
    const uses = readDelegationUses(context, id);
    return {
      id,
      state: record ? classifyDelegation(record, { now: at, revocation, warningHours: warningHours(context) }) : "invalid",
      scope: record ? formatDelegationScope(record.scope) : null,
      actions: record?.actions || [],
      expires_at: record?.expires_at || null,
      granted_by: record ? delegationGrantorName(record) : null,
      uses: uses.length,
      last_used_at: uses.at(-1)?.used_at || null,
      revoked_at: revocation?.revoked_at || null,
    };
  });
}

/** Lines for status and the strict gate: delegations in use and those expiring. */
export function delegationStatusLines(context, { italian = false } = {}) {
  const live = delegationOverview(context).filter((item) => ["active", "expiring", "invalid"].includes(item.state));
  return live.map((item) => {
    if (item.state === "invalid") {
      return italian ? `Delega ${item.id}: NON VALIDA (hash alterato), nessuna azione delegata è accettata.` : `Delegation ${item.id}: INVALID (altered hash); no delegated action is accepted.`;
    }
    const expiring = item.state === "expiring";
    return italian
      ? `Delega ${item.id} di ${item.granted_by}: ${item.actions.join(", ")} su ${item.scope}, ${item.uses} usi, scade ${item.expires_at}${expiring ? " (IN SCADENZA)" : ""}.`
      : `Delegation ${item.id} by ${item.granted_by}: ${item.actions.join(", ")} on ${item.scope}, ${item.uses} uses, expires ${item.expires_at}${expiring ? " (EXPIRING SOON)" : ""}.`;
  });
}

export function listDelegations(context, options) {
  ensureInitialized(context);
  const italian = humanGuidanceLocale(options) === "it";
  const delegations = delegationOverview(context);
  output(options, { delegations }, delegations.length
    ? delegations.map((item) => (italian
        ? `${item.id}: ${item.state}, ${item.scope}, ${item.actions.join(", ")}, scade ${item.expires_at}, ${item.uses} usi, di ${item.granted_by}`
        : `${item.id}: ${item.state}, ${item.scope}, ${item.actions.join(", ")}, expires ${item.expires_at}, ${item.uses} uses, by ${item.granted_by}`))
    : [italian ? "Nessuna delega registrata." : "No delegations recorded."]);
  return delegations;
}

/**
 * The delegation an agent applies on a person-only command, verified now.
 * Returns null when the command does not use --approval-source delegated, so
 * the command keeps its person-only rules. Otherwise checks the delegation,
 * writes a validity-at-use receipt, marks the parsed options as verified, and
 * returns the use.
 */
export function applyApprovalDelegation(context, options, action, target = {}) {
  const source = String(getOptionString(options, "approval-source") || "").trim().toLowerCase();
  const requested = getOptionString(options, "delegation");
  if (source !== DELEGATED_APPROVAL_SOURCE) {
    if (requested) fail("--delegation is used only with --approval-source delegated.");
    return null;
  }
  if (options[VERIFIED_DELEGATION_USE]) return options[VERIFIED_DELEGATION_USE];
  if (!requested) {
    fail(`--approval-source delegated needs --delegation <DLG-id>: the delegation the person granted for ${action}.`);
  }
  const actorType = String(getOptionString(options, "actor-type") || "agent").toLowerCase();
  if (actorType !== "agent") {
    fail("A delegated approval is applied by the agent (--actor-type agent). A person approves directly with --approval-source explicit-user.");
  }
  const id = normalizeId(requested);
  const record = readDelegationRecord(context, id);
  if (!record) fail(`Delegation ${id} does not exist; the person grants it with 'autonomy delegation grant'.`);
  const revocation = readDelegationRevocation(context, id);
  const checkedAt = now();
  const resolvedTarget = resolveStoryRequirements(context, typeof target === "function" ? target() : target);
  const decision = evaluateDelegationUse(record, { action, target: resolvedTarget, now: checkedAt, revocation });
  const hostVerified = (context.config.authority_policy?.mode || "audit_only") === "host_verified";
  if (hostVerified && record.authority_assurance?.mode !== "host_verified") {
    decision.errors.push("this project requires signed approvals and the delegation was granted without a trusted host receipt");
  }
  if (decision.errors.length > 0) {
    fail(`Delegation ${id} cannot approve ${action}: ${decision.errors.join("; ")}. Nothing was approved; ask the person to run the command, or to grant a delegation that covers it.`);
  }
  const statement = delegatedApprovalStatement(record);
  const attribution = buildAttribution(context, { ...options, "actor-type": "agent" }, `delegation.use.${action}`);
  const use = sealDelegationRecord({
    id: `DLGUSE-${uniqueRecordSuffix()}`,
    schema_version: DELEGATION_USE_SCHEMA_VERSION,
    delegation_ref: { id, record_hash: record.record_hash, grantor: record.grantor, scope: record.scope },
    action,
    target: resolvedTarget,
    statement,
    valid_at_use: {
      checked_at: checkedAt,
      expires_at: record.expires_at,
      revoked: false,
      hash_valid: true,
      action_covered: true,
      scope_covered: true,
    },
    used_by: attribution.actor,
    used_at: checkedAt,
    git: attribution.git,
    run: attribution.run,
  });
  const usePath = path.join(delegationUsesRoot(context, id), `${use.id}.json`);
  ensureDir(path.dirname(usePath));
  writeJsonFile(usePath, use, { atomicCreate: true });
  const verified = { record, use, use_path: toProjectPath(context, usePath), statement };
  Object.defineProperty(options, VERIFIED_DELEGATION_USE, { value: verified, enumerable: true });
  appendTraceEvent(context, resolvedTarget.story || null, {
    type: "decision",
    action: `delegation.use.${action}`,
    summary: `${action}: ${statement}`,
    actor: attribution.actor,
    evidence: [verified.use_path],
    related: [id, ...(resolvedTarget.story ? [resolvedTarget.story] : []), ...(resolvedTarget.requirement ? [resolvedTarget.requirement] : [])],
    git: attribution.git,
    run: attribution.run,
  });
  return verified;
}

function resolveStoryRequirements(context, target) {
  const result = {
    ...(target.story ? { story: normalizeId(target.story) } : {}),
    ...(target.requirement ? { requirement: normalizeId(target.requirement) } : {}),
  };
  if (!result.story) return result;
  const storyPath = path.join(context.sdlcRoot, "stories", result.story, "story.json");
  try {
    const story = JSON.parse(fs.readFileSync(storyPath, "utf8"));
    const ids = (story.requirement_refs || []).map((ref) => ref?.id).filter(Boolean);
    if (ids.length > 0) result.requirements = ids;
  } catch {
    // A story without readable requirements is covered only by its own or a project scope.
  }
  return result;
}

/** Fields a record written without an approval envelope carries when the agent applied a delegation. */
export function delegatedRecordFields(delegated) {
  return {
    approval_source: DELEGATED_APPROVAL_SOURCE,
    delegation: {
      id: delegated.record.id,
      record_hash: delegated.record.record_hash,
      granted_by: delegated.record.grantor,
      action: delegated.use.action,
      statement: delegated.statement,
      use_id: delegated.use.id,
      use_path: delegated.use_path,
      use_hash: delegated.use.record_hash,
      valid_at_use: delegated.use.valid_at_use,
    },
  };
}
