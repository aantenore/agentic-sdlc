import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeStableHash, immutableJson, isPlainRecord } from "../canonical.mjs";
import { validateAgainstSchema } from "../json-schema-validator.mjs";
import {
  createCommandSubject,
  normalizeActorIdentity,
  normalizeExactRefs,
} from "./command-subject.mjs";
import {
  createGovernanceUseReceipt,
  evaluateGovernancePolicy,
  validateGovernanceDecisionIntegrity,
  validateGovernancePolicyIntegrity,
  validateGovernanceRevocationIntegrity,
} from "./policy-engine.mjs";

export const MUTATION_GOVERNANCE_MODES = Object.freeze(["disabled", "audit", "enforce"]);
export const DEFAULT_GOVERNANCE_POLICY_MAX_BYTES = 256 * 1024;
export const MAX_EXACT_MUTATION_BATCH = 2048;
// Operational audit evidence deliberately lives outside `.sdlc`: identity
// migration replaces that tree atomically, while these immutable events must
// remain durable throughout the transaction.
export const DEFAULT_GOVERNANCE_AUDIT_EVENTS_ROOT = ".sdlc-governance/audit-events";
export const MAX_GOVERNANCE_AUDIT_EVENT_BYTES = 64 * 1024;
export const MAX_GOVERNANCE_AUDIT_EVENT_FILES = 1024;
export const MAX_GOVERNANCE_AUDIT_TOTAL_BYTES = 16 * 1024 * 1024;

const MODE_RANK = Object.freeze({ disabled: 0, audit: 1, enforce: 2 });
const ACTION_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;
const OPERATION_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024;
const MAX_REVOCATION_BYTES = 256 * 1024;
const MAX_REVOCATION_FILES = 512;
const MAX_REVOCATION_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_APPROVALS = 512;
const MAX_APPROVAL_BYTES = 4 * 1024 * 1024;
const GOVERNANCE_AUDIT_EVENT_SCHEMA = "governance-mutation-audit-event:v1";
const PLUGIN_SCHEMA_DIR = fileURLToPath(new URL("../../schemas", import.meta.url));
const NO_FOLLOW_FLAG = fs.constants.O_NOFOLLOW || 0;
const storage = new AsyncLocalStorage();
const bootstrapGrantRegistry = new WeakMap();
const bootstrapGrantIds = new Map();
const bootstrapContextRegistry = new WeakMap();
let decisionSequence = 0;

export class MutationGovernanceError extends Error {
  constructor(message, code = "MUTATION_GOVERNANCE_DENIED", details = {}) {
    super(message);
    this.name = "MutationGovernanceError";
    this.code = code;
    this.details = immutableJson(details);
  }
}

/**
 * Runs one command inside an isolated mutation-governance context. The context
 * is inherited by asynchronous work spawned by the command, while concurrent
 * invocations remain isolated by AsyncLocalStorage. A nested invocation may
 * tighten the mode but cannot silently downgrade an active parent policy.
 */
export function runWithMutationGovernance(context, callback) {
  if (typeof callback !== "function") {
    throw new TypeError("mutation governance callback must be a function");
  }
  const normalized = normalizeRuntimeContext(context);
  const parent = storage.getStore();
  if (parent && MODE_RANK[normalized.mode] < MODE_RANK[parent.context.mode]) {
    throw new MutationGovernanceError(
      "Nested mutation governance cannot reduce the active protection mode",
      "MUTATION_GOVERNANCE_DOWNGRADE",
      { parent_mode: parent.context.mode, requested_mode: normalized.mode },
    );
  }
  if (parent
    && normalized.mode !== "disabled"
    && MODE_RANK[normalized.mode] === MODE_RANK[parent.context.mode]) {
    throw new MutationGovernanceError(
      "Nested mutation governance cannot replace an active policy context at the same protection level",
      "MUTATION_GOVERNANCE_CONTEXT_REPLACEMENT",
      { parent_mode: parent.context.mode, requested_mode: normalized.mode },
    );
  }
  return storage.run({ context: normalized, authorizations: Object.freeze([]) }, callback);
}

export function currentMutationGovernance() {
  return storage.getStore()?.context ?? null;
}

/**
 * Synchronously decides one logical mutation before the callback can write its
 * first byte. The callback executes with one exact authorization in scope so
 * lower-level gateways can prove that they are part of the decided operation.
 */
export function withGovernedMutation(request, callback) {
  if (typeof callback !== "function") {
    throw new TypeError("governed mutation callback must be a function");
  }
  const store = storage.getStore();
  if (!store || store.context.mode === "disabled") return callback();
  const authorization = decideMutationAuthorization(store, request);
  return runWithMutationAuthorizations(store, [authorization], callback);
}

function decideMutationAuthorization(store, request) {
  const normalizedRequest = normalizeMutationRequest(store.context, request);
  const outcome = decideMutation(store.context, normalizedRequest);
  recordOutcome(store.context, outcome);
  if (store.context.mode === "enforce" && outcome.allowed !== true) {
    throw denialError(outcome);
  }
  if (outcome.allowed === true) {
    const persistenceFailure = callSynchronousHook(
      store.context.on_authorization,
      { outcome },
      "mutation.decision_receipt_persistence_failed",
      normalizedRequest,
    );
    if (persistenceFailure) {
      recordOutcome(store.context, persistenceFailure);
      if (store.context.mode === "enforce") throw denialError(persistenceFailure);
    }
  }
  const token = {
    active: true,
    used: false,
    decision: outcome.decision ?? null,
    valid_until: outcome.decision?.valid_until ?? null,
  };
  const authorization = Object.freeze({
    request: normalizedRequest,
    allowed: outcome.allowed === true,
    audited: store.context.mode === "audit",
    decision_hash: outcome.decision?.decision_hash ?? null,
    token,
  });
  return authorization;
}

function runWithMutationAuthorizations(store, authorizations, callback) {
  const tokens = authorizations.map((authorization) => authorization.token);
  let result;
  try {
    result = storage.run({
      context: store.context,
      authorizations: Object.freeze([...store.authorizations, ...authorizations]),
    }, callback);
  } catch (error) {
    for (const token of tokens) token.active = false;
    throw error;
  }
  try {
    if (result && typeof result.then === "function") {
      return Promise.resolve(result).finally(() => {
        for (const token of tokens) token.active = false;
      });
    }
  } catch (error) {
    for (const token of tokens) token.active = false;
    throw error;
  }
  for (const token of tokens) token.active = false;
  return result;
}

/**
 * Decides a finite set of exact mutations before the callback can perform its
 * first effect. Every authorization remains active for the callback lifetime;
 * lower-level writers must still prove the same exact operation and path.
 */
export function withGovernedMutationBatch(requests, callback) {
  if (
    !Array.isArray(requests)
    || requests.length === 0
    || requests.length > MAX_EXACT_MUTATION_BATCH
  ) {
    throw new MutationGovernanceError(
      `An exact mutation batch must contain between 1 and ${MAX_EXACT_MUTATION_BATCH} operations`,
      "MUTATION_BATCH_INVALID",
    );
  }
  if (typeof callback !== "function") {
    throw new TypeError("governed mutation batch callback must be a function");
  }
  const store = storage.getStore();
  if (!store || store.context.mode === "disabled") return callback();
  const authorizations = [];
  try {
    for (const request of requests) {
      authorizations.push(decideMutationAuthorization(store, request));
    }
  } catch (error) {
    for (const authorization of authorizations) authorization.token.active = false;
    throw error;
  }
  return runWithMutationAuthorizations(store, authorizations, callback);
}

/**
 * Used by physical writer helpers. It never evaluates prefixes or globs: the
 * exact operation and normalized project path must match an active logical
 * authorization. In audit mode a missing authorization is recorded; enforce
 * mode fails before the helper opens or mutates a filesystem entry.
 */
export function assertMutationExecutionAuthorized(request) {
  const store = storage.getStore();
  if (!store || store.context.mode === "disabled") return true;
  const normalized = normalizeMutationRequest(store.context, request);
  const match = [...store.authorizations].reverse().find((entry) => (
    entry.request.canonical_action === normalized.canonical_action
    && entry.request.operation === normalized.operation
    && entry.request.project_path === normalized.project_path
    && computeStableHash(entry.request.evidence_refs) === computeStableHash(normalized.evidence_refs)
  ));
  if (match && (match.allowed || store.context.mode === "audit")) {
    const authorizationFailure = validateActiveAuthorization(store.context, match, normalized);
    if (!authorizationFailure) return true;
    recordOutcome(store.context, authorizationFailure);
    if (store.context.mode === "enforce") throw denialError(authorizationFailure);
    return false;
  }
  const outcome = immutableJson({
    allowed: false,
    request: normalized,
    reason_codes: ["mutation.no_exact_active_authorization"],
    decision: null,
    error: null,
  });
  recordOutcome(store.context, outcome);
  if (store.context.mode === "enforce") throw denialError(outcome);
  return false;
}

function validateActiveAuthorization(context, authorization, request) {
  if (authorization.token?.active !== true) {
    return deniedOutcome(request, null, "mutation.authorization_inactive");
  }
  const checkedAt = resolveNow(context.now);
  if (authorization.token.valid_until !== null && checkedAt >= authorization.token.valid_until) {
    authorization.token.active = false;
    return deniedOutcome(request, null, "mutation.authorization_expired");
  }
  const revalidationFailure = callSynchronousHook(
    context.decision_revalidator,
    { authorization, request, checked_at: checkedAt },
    "mutation.authorization_revalidation_failed",
    request,
    { requireTrue: true },
  );
  if (revalidationFailure) {
    authorization.token.active = false;
    return revalidationFailure;
  }
  if (authorization.token.used !== true) {
    const useFailure = callSynchronousHook(
      context.on_use,
      { authorization, request, used_at: checkedAt },
      "mutation.use_receipt_persistence_failed",
      request,
    );
    if (useFailure) {
      authorization.token.active = false;
      return useFailure;
    }
    authorization.token.used = true;
  }
  return null;
}

function callSynchronousHook(hook, input, reason, request, options = {}) {
  if (typeof hook !== "function") return null;
  try {
    const result = hook(input);
    if (result && typeof result.then === "function") {
      return deniedOutcome(request, null, `${reason}.async_forbidden`);
    }
    if (options.requireTrue === true && result !== true) {
      return deniedOutcome(request, null, reason);
    }
    return null;
  } catch (error) {
    return deniedOutcome(request, null, reason, error?.message ?? String(error));
  }
}

/**
 * Converts the optional project config into a runtime guard. Inline policies
 * are enforced directly. Pointer policies and revocations are re-read through
 * bounded, no-follow readers before physical use. Decision and use receipts go
 * only to their exact configured roots through the private receipt sink below;
 * that sink is not exposed to project writers and cannot authorize another path.
 */
export function createProjectMutationGovernance(input) {
  if (!isPlainRecord(input)) throw new TypeError("project mutation governance input must be an object");
  const root = normalizeRoot(input.root);
  const configured = input.governance_policy;
  const observations = [];
  if (configured === undefined || configured === null) {
    return normalizeRuntimeContext({
      mode: "disabled",
      root,
      observations,
      canonical_action: input.canonical_action,
      command_path: input.command_path,
    });
  }

  let mode;
  let failClosed;
  let policy;
  let policyLoader;
  let revocationLoader;
  let receiptRoots = null;
  let setupError = null;
  let evidenceRefs = immutableJson([]);
  let approvals = immutableJson([]);
  let actor = null;
  try {
    if (configured.kind === "governance_policy") {
      mode = "enforce";
      failClosed = true;
      policy = configured;
      policyLoader = () => policy;
      revocationLoader = () => normalizeInputRevocations(input.revocations ?? []);
    } else {
      mode = normalizeMode(configured.mode);
      if (mode === "disabled") {
        throw new MutationGovernanceError(
          "Configured governance_policy cannot disable governance; remove it for 0.11 compatibility",
          "MUTATION_GOVERNANCE_CONFIG_INVALID",
        );
      }
      failClosed = configured.fail_closed === true;
      if (mode === "enforce" && !failClosed) {
        throw new MutationGovernanceError(
          "Enforced governance requires fail_closed=true",
          "MUTATION_GOVERNANCE_CONFIG_INVALID",
        );
      }
      const policyPath = normalizeProjectMutationPath(root, configured.policy_file);
      receiptRoots = normalizeReceiptRoots(root, configured);
      policyLoader = () => readBoundedProjectJson(root, policyPath, {
        maxBytes: input.max_policy_bytes ?? DEFAULT_GOVERNANCE_POLICY_MAX_BYTES,
        label: "governance policy",
      });
      revocationLoader = () => mergeRevocations(
        normalizeInputRevocations(input.revocations ?? []),
        readBoundedRevocations(root, receiptRoots.revocations),
      );
      policy = policyLoader();
    }
    const integrity = validateGovernancePolicyIntegrity(policy);
    if (!integrity.valid) {
      throw new MutationGovernanceError(
        `Governance policy integrity failed: ${integrity.errors.join("; ")}`,
        "MUTATION_GOVERNANCE_POLICY_INVALID",
      );
    }
    evidenceRefs = collectEvidenceRefs(root, input.evidence_paths ?? []);
    approvals = normalizeInputApprovals(input.approvals ?? []);
    actor = mode === "enforce"
      ? normalizeVerifiedActor(input.verified_actor)
      : normalizeActorIdentity(input.verified_actor?.actor ?? input.actor ?? { type: "system", id: "local-cli" });
    revocationLoader();
  } catch (error) {
    setupError = error instanceof Error ? error : new Error(String(error));
    if (mode === undefined) mode = configured?.mode === "audit" ? "audit" : "enforce";
    failClosed = mode === "enforce";
  }
  const decisionProvider = setupError
    ? () => { throw setupError; }
    : ({ subject }) => evaluateGovernancePolicy({
        policy: policyLoader(),
        subject,
        actor: actor ?? { type: "system", id: "invalid-governance-identity" },
        approvals,
        revocations: revocationLoader(),
        evaluated_at: resolveNow(input.now),
        decision_id: nextDecisionId(input.id),
      });
  const decisionRevalidator = setupError
    ? () => false
    : ({ authorization, checked_at: checkedAt }) => {
        if (authorization.allowed !== true || authorization.token?.decision === null) return false;
        const currentPolicy = policyLoader();
        const decision = authorization.token.decision;
        if (currentPolicy.policy_hash !== decision.policy_ref.hash) return false;
        const currentRevocations = revocationLoader();
        createGovernanceUseReceipt({
          policy: currentPolicy,
          decision,
          approvals,
          revocations: currentRevocations,
          receipt_id: nextRecordId(input.id, "revalidation"),
          used_at: checkedAt,
          evidence_refs: authorization.request.evidence_refs,
        });
        const replay = evaluateGovernancePolicy({
          policy: currentPolicy,
          subject: decision.subject,
          actor,
          approvals,
          revocations: currentRevocations,
          evaluated_at: checkedAt,
          decision_id: nextDecisionId(input.id),
        });
        return replay.decision === "allow";
      };
  const onAuthorization = setupError || !receiptRoots
    ? null
    : ({ outcome }) => persistGovernanceReceipt(
        root,
        receiptRoots.decisions,
        "decision",
        outcome.decision.decision_hash,
        outcome.decision,
        "governance-policy-decision.schema.json",
      );
  const onUse = setupError || !receiptRoots
    ? null
    : ({ authorization, used_at: usedAt }) => {
        const decision = authorization.token.decision;
        const receipt = createGovernanceUseReceipt({
          policy: policyLoader(),
          decision,
          approvals,
          revocations: revocationLoader(),
          receipt_id: nextRecordId(input.id, "use-receipt"),
          used_at: usedAt,
          evidence_refs: authorization.request.evidence_refs,
        });
        persistGovernanceReceipt(
          root,
          receiptRoots.uses,
          "use",
          receipt.receipt_hash,
          receipt,
          "governance-policy-use-receipt.schema.json",
        );
      };
  const onAuditOutcome = mode !== "audit"
    ? null
    : receiptRoots
      ? ({ outcome, recorded_at: recordedAt }) => persistGovernanceAuditEvent(
          root,
          receiptRoots.auditEvents,
          outcome,
          recordedAt,
        )
      : () => {
          throw new MutationGovernanceError(
            "Governance audit event store is not coherently configured",
            "MUTATION_GOVERNANCE_AUDIT_CONFIG_INVALID",
          );
        };
  return normalizeRuntimeContext({
    mode,
    fail_closed: failClosed,
    root,
    canonical_action: input.canonical_action,
    command_path: input.command_path,
    evidence_refs: evidenceRefs,
    decision_provider: decisionProvider,
    decision_revalidator: decisionRevalidator,
    on_authorization: onAuthorization,
    on_use: onUse,
    on_audit_outcome: onAuditOutcome,
    now: input.now,
    observations,
    configuration_error: setupError?.message ?? null,
  });
}

/** Strictly validates the only three recovery/bootstrap shapes. */
export function createBootstrapMutationGrant(input) {
  if (!isPlainRecord(input)) throw new TypeError("bootstrap mutation grant input must be an object");
  const action = normalizeAction(input.canonical_action);
  if (!new Set(["init", "config.migrate", "migration.identity"]).has(action)) {
    throw new MutationGovernanceError("Unsupported bootstrap action", "MUTATION_BOOTSTRAP_DENIED", { action });
  }
  if (action === "init" && input.first_time !== true) {
    throw new MutationGovernanceError("Initialization bootstrap is only valid before project initialization", "MUTATION_BOOTSTRAP_DENIED");
  }
  if (action === "config.migrate") {
    assertExactHashPair(input.plan_hash, input.expected_plan_hash, "configuration migration plan");
  }
  if (action === "migration.identity") {
    if (input.recover !== true || !safeExactToken(input.nonce) || input.nonce !== input.expected_nonce) {
      throw new MutationGovernanceError("Identity recovery requires its exact transaction nonce", "MUTATION_BOOTSTRAP_DENIED");
    }
    assertExactHashPair(input.plan_hash, input.expected_plan_hash, "identity recovery plan");
  }
  const exactMutations = normalizeBootstrapMutations(input.root, action, input.exact_mutations);
  const root = normalizeRoot(input.root);
  const binding = {
    root,
    canonical_action: action,
    exact_mutations: exactMutations,
  };
  const grantId = crypto.randomBytes(24).toString("hex");
  const bindingHash = computeStableHash(binding);
  const grant = immutableJson({
    kind: "mutation_bootstrap_grant",
    grant_id: grantId,
    ...binding,
    binding_hash: bindingHash,
  });
  bootstrapGrantRegistry.set(grant, Object.freeze({ grantId, bindingHash }));
  bootstrapGrantIds.set(grantId, bindingHash);
  return grant;
}

/**
 * Consumes one validated bootstrap grant exactly once. The callback is the
 * independently transactional init/config/recovery routine; this gate does not
 * provide a reusable writer bypass and cannot be nested around another action.
 */
export function consumeBootstrapMutationGrant(grant, callback) {
  if (typeof callback !== "function") throw new TypeError("bootstrap mutation callback must be a function");
  if (!isPlainRecord(grant) || grant.kind !== "mutation_bootstrap_grant") {
    throw new MutationGovernanceError("Bootstrap grant is missing or invalid", "MUTATION_BOOTSTRAP_DENIED");
  }
  const binding = {
    root: normalizeRoot(grant.root),
    canonical_action: normalizeAction(grant.canonical_action),
    exact_mutations: normalizeBootstrapMutations(grant.root, grant.canonical_action, grant.exact_mutations),
  };
  const expectedBindingHash = computeStableHash(binding);
  const registered = bootstrapGrantRegistry.get(grant);
  if (!registered
    || !safeExactBootstrapGrantId(grant.grant_id)
    || registered.grantId !== grant.grant_id
    || registered.bindingHash !== expectedBindingHash
    || grant.binding_hash !== expectedBindingHash
    || bootstrapGrantIds.get(grant.grant_id) !== expectedBindingHash) {
    throw new MutationGovernanceError("Bootstrap grant is invalid or was already consumed", "MUTATION_BOOTSTRAP_DENIED");
  }
  const parent = storage.getStore();
  if (parent && parent.context.mode !== "disabled") {
    throw new MutationGovernanceError(
      "A bootstrap transaction cannot replace active mutation governance",
      "MUTATION_GOVERNANCE_CONTEXT_REPLACEMENT",
    );
  }
  bootstrapGrantRegistry.delete(grant);
  bootstrapGrantIds.delete(grant.grant_id);
  const context = normalizeRuntimeContext({
    mode: "enforce",
    fail_closed: true,
    root: binding.root,
    canonical_action: binding.canonical_action,
    command_path: binding.canonical_action.replaceAll(".", " "),
    observations: [],
  });
  const lifetime = {
    active: true,
    exactMutationHashes: new Set(binding.exact_mutations.map((mutation) => computeStableHash(mutation))),
  };
  bootstrapContextRegistry.set(context, lifetime);
  let result;
  try {
    result = storage.run({ context, authorizations: Object.freeze([]) }, callback);
  } catch (error) {
    lifetime.active = false;
    throw error;
  }
  try {
    if (result && typeof result.then === "function") {
      return Promise.resolve(result).finally(() => {
        lifetime.active = false;
      });
    }
  } catch (error) {
    lifetime.active = false;
    throw error;
  }
  lifetime.active = false;
  return result;
}

export function normalizeProjectMutationPath(rootValue, targetValue) {
  const root = normalizeRoot(rootValue);
  if (typeof targetValue !== "string" || !targetValue.trim() || targetValue.includes("\0")) {
    throw new MutationGovernanceError("Mutation path must be a non-empty filesystem path", "MUTATION_PATH_INVALID");
  }
  if (/[*?\[\]{}]/u.test(targetValue)) {
    throw new MutationGovernanceError("Mutation paths must be exact and cannot contain glob syntax", "MUTATION_PATH_INVALID");
  }
  let boundary = root;
  let target = path.resolve(root, targetValue);
  let relative = path.relative(boundary, target);
  if (pathIsOutsideBoundary(relative)) {
    const canonicalRoot = fs.realpathSync.native?.(root) ?? fs.realpathSync(root);
    const canonicalRelative = path.relative(canonicalRoot, target);
    if (!pathIsOutsideBoundary(canonicalRelative)) {
      boundary = canonicalRoot;
      relative = canonicalRelative;
      target = path.resolve(canonicalRoot, canonicalRelative);
    }
  }
  if (relative === "" || relative === "." || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new MutationGovernanceError("Mutation path must identify one entry inside the project root", "MUTATION_PATH_OUTSIDE_ROOT");
  }
  assertNoSymlinkSegments(boundary, target);
  return relative.split(path.sep).join("/");
}

function pathIsOutsideBoundary(relative) {
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

/**
 * Performs one no-follow O_APPEND write. Callers must hold their exact file
 * lock before invoking it; one JSON record is issued as one write syscall so a
 * cooperating set of locked writers cannot interleave record fragments.
 */
export function appendJsonLineNoFollow(filePath, value) {
  const absolutePath = path.resolve(String(filePath ?? ""));
  const parent = path.dirname(absolutePath);
  const parentEntry = fs.lstatSync(parent);
  if (parentEntry.isSymbolicLink() || !parentEntry.isDirectory()) {
    throw new MutationGovernanceError("JSONL parent must be a real directory", "MUTATION_PATH_SYMLINK");
  }
  if (fs.existsSync(absolutePath) && fs.lstatSync(absolutePath).isSymbolicLink()) {
    throw new MutationGovernanceError("Mutation path cannot traverse a symbolic link", "MUTATION_PATH_SYMLINK");
  }
  const parentBefore = fs.statSync(parent);
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  let descriptor;
  try {
    assertMutationExecutionAuthorized({ operation: "file.append", path: absolutePath });
    descriptor = fs.openSync(
      absolutePath,
      fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | NO_FOLLOW_FLAG,
      0o600,
    );
    const descriptorStat = fs.fstatSync(descriptor);
    const pathStat = fs.lstatSync(absolutePath);
    const parentAfter = fs.statSync(parent);
    if (!descriptorStat.isFile()
      || pathStat.isSymbolicLink()
      || descriptorStat.dev !== pathStat.dev
      || descriptorStat.ino !== pathStat.ino
      || parentBefore.dev !== parentAfter.dev
      || parentBefore.ino !== parentAfter.ino) {
      throw new MutationGovernanceError("JSONL target changed while opening it", "MUTATION_PATH_UNSTABLE");
    }
    assertMutationExecutionAuthorized({ operation: "file.append", path: absolutePath });
    const written = fs.writeSync(descriptor, bytes, 0, bytes.length, null);
    if (written !== bytes.length) {
      throw new MutationGovernanceError("JSONL append did not commit one complete record", "MUTATION_APPEND_INCOMPLETE");
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  return bytes.length;
}

function normalizeRuntimeContext(raw) {
  if (!isPlainRecord(raw)) throw new TypeError("mutation governance context must be an object");
  if (raw.bootstrap_mutations !== undefined && raw.bootstrap_mutations !== null) {
    throw new MutationGovernanceError(
      "Bootstrap mutation contexts can only be created by consuming an original one-shot grant",
      "MUTATION_BOOTSTRAP_DENIED",
    );
  }
  const mode = normalizeMode(raw.mode ?? "disabled");
  const root = normalizeRoot(raw.root);
  const observations = Array.isArray(raw.observations) ? raw.observations : [];
  const context = {
    mode,
    fail_closed: mode === "enforce" ? raw.fail_closed !== false : raw.fail_closed === true,
    root,
    canonical_action: raw.canonical_action === undefined || raw.canonical_action === null
      ? null
      : normalizeAction(raw.canonical_action),
    command_path: raw.command_path === undefined || raw.command_path === null
      ? null
      : normalizeCommandPath(raw.command_path),
    evidence_refs: normalizeExactRefs(raw.evidence_refs ?? [], "mutation_context.evidence_refs", { requireHash: true }),
    decision_provider: raw.decision_provider,
    decision_revalidator: typeof raw.decision_revalidator === "function" ? raw.decision_revalidator : null,
    on_authorization: typeof raw.on_authorization === "function" ? raw.on_authorization : null,
    on_use: typeof raw.on_use === "function" ? raw.on_use : null,
    on_audit_outcome: typeof raw.on_audit_outcome === "function" ? raw.on_audit_outcome : null,
    now: typeof raw.now === "function" ? raw.now : null,
    bootstrap_mutations: null,
    observations,
    on_decision: typeof raw.on_decision === "function" ? raw.on_decision : null,
    configuration_error: raw.configuration_error ?? null,
  };
  if (mode === "enforce" && context.fail_closed !== true) {
    throw new MutationGovernanceError("Enforce mode must be fail closed", "MUTATION_GOVERNANCE_CONFIG_INVALID");
  }
  return Object.freeze(context);
}

function normalizeMutationRequest(context, raw) {
  if (!isPlainRecord(raw)) {
    throw new MutationGovernanceError("Mutation metadata is missing", "MUTATION_METADATA_MISSING");
  }
  const canonicalAction = normalizeAction(raw.canonical_action ?? context.canonical_action);
  const commandPath = normalizeCommandPath(raw.command_path ?? context.command_path);
  const operation = normalizeOperation(raw.operation);
  const projectPath = normalizeProjectMutationPath(context.root, raw.path ?? raw.project_path);
  const evidenceRefs = normalizeExactRefs(
    raw.evidence_refs ?? context.evidence_refs,
    "mutation_request.evidence_refs",
    { requireHash: true },
  );
  return immutableJson({
    canonical_action: canonicalAction,
    command_path: commandPath,
    operation,
    project_path: projectPath,
    evidence_refs: evidenceRefs,
  });
}

function decideMutation(context, request) {
  let subject;
  try {
    subject = createCommandSubject({
      command_path: request.command_path,
      canonical_action: request.canonical_action,
      scope_refs: [
        { kind: "mutation_operation", id: request.operation },
        { kind: "project_path", id: request.project_path },
      ],
      evidence_refs: request.evidence_refs,
    });
    const bootstrap = bootstrapContextRegistry.get(context);
    if (bootstrap) {
      if (bootstrap.active !== true) {
        return deniedOutcome(request, subject, "mutation.bootstrap_context_inactive");
      }
      const exact = {
        canonical_action: request.canonical_action,
        operation: request.operation,
        project_path: request.project_path,
      };
      const allowed = bootstrap.exactMutationHashes.has(computeStableHash(exact));
      return allowed
        ? immutableJson({
            allowed: true,
            request,
            subject,
            decision: null,
            reason_codes: [],
            error: null,
            bootstrap: true,
          })
        : deniedOutcome(request, subject, "mutation.bootstrap_exact_grant_miss");
    }
    if (typeof context.decision_provider !== "function") {
      return deniedOutcome(request, subject, "mutation.decision_provider_missing");
    }
    const decision = context.decision_provider({ request, subject });
    if (decision && typeof decision.then === "function") {
      return deniedOutcome(request, subject, "mutation.async_decision_forbidden");
    }
    const integrity = validateGovernanceDecisionIntegrity(decision);
    if (!integrity.valid) {
      return deniedOutcome(request, subject, "mutation.decision_invalid", integrity.errors.join("; "));
    }
    if (decision.subject_hash !== subject.subject_hash
      || decision.subject.command.action !== request.canonical_action
      || decision.subject.command.path !== request.command_path) {
      return deniedOutcome(request, subject, "mutation.decision_subject_mismatch");
    }
    if (decision.decision !== "allow") {
      return immutableJson({
        allowed: false,
        request,
        subject,
        decision,
        reason_codes: decision.reason_codes.length > 0 ? decision.reason_codes : ["mutation.policy_denied"],
        error: null,
      });
    }
    return immutableJson({ allowed: true, request, subject, decision, reason_codes: [], error: null });
  } catch (error) {
    return deniedOutcome(request, subject ?? null, "mutation.decision_error", error?.message ?? String(error));
  }
}

function deniedOutcome(request, subject, reason, error = null) {
  return immutableJson({
    allowed: false,
    request,
    subject,
    decision: null,
    reason_codes: [reason],
    error,
  });
}

function denialError(outcome) {
  return new MutationGovernanceError(
    "The change was not made because this project has no approval for this exact action and file",
    "MUTATION_GOVERNANCE_DENIED",
    {
      canonical_action: outcome.request?.canonical_action ?? null,
      operation: outcome.request?.operation ?? null,
      project_path: outcome.request?.project_path ?? null,
      reason_codes: outcome.reason_codes ?? ["mutation.unknown_denial"],
    },
  );
}

function recordOutcome(context, outcome) {
  context.observations.push(outcome);
  if (context.mode === "audit" && outcome.allowed !== true && context.on_audit_outcome) {
    try {
      const result = context.on_audit_outcome({
        outcome,
        recorded_at: resolveNow(context.now),
      });
      if (result && typeof result.then === "function") {
        throw new TypeError("audit outcome sink must be synchronous");
      }
    } catch (error) {
      context.observations.push(immutableJson({
        allowed: false,
        reason_codes: ["mutation.audit_sink_unavailable"],
        request: outcome.request,
        subject: null,
        decision: null,
        error: null,
        error_digest: crypto.createHash("sha256")
          .update(error?.message ?? String(error))
          .digest("hex"),
      }));
    }
  }
  if (context.on_decision) {
    try {
      const result = context.on_decision(outcome);
      if (result && typeof result.then === "function") {
        context.observations.push(immutableJson({
          allowed: false,
          reason_codes: ["mutation.async_observer_ignored"],
          request: outcome.request,
          subject: outcome.subject ?? null,
          decision: null,
          error: null,
        }));
      }
    } catch (error) {
      context.observations.push(immutableJson({
        allowed: false,
        reason_codes: ["mutation.observer_error"],
        request: outcome.request,
        subject: outcome.subject ?? null,
        decision: null,
        error: error?.message ?? String(error),
      }));
    }
  }
}

function collectEvidenceRefs(root, values) {
  if (!Array.isArray(values)) throw new TypeError("governance evidence paths must be an array");
  return normalizeExactRefs(values.map((value) => {
    const projectPath = normalizeProjectMutationPath(root, value);
    const absolutePath = path.join(root, ...projectPath.split("/"));
    const bytes = readBoundedProjectFile(root, absolutePath, {
      maxBytes: MAX_EVIDENCE_BYTES,
      label: "governance evidence",
    });
    return {
      kind: "project_evidence",
      id: projectPath,
      hash: crypto.createHash("sha256").update(bytes).digest("hex"),
    };
  }), "mutation_context.evidence_refs", { requireHash: true });
}

function readBoundedProjectJson(root, projectPath, options) {
  const normalized = normalizeProjectMutationPath(root, projectPath);
  const absolutePath = path.join(root, ...normalized.split("/"));
  const bytes = readBoundedProjectFile(root, absolutePath, options);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new MutationGovernanceError(
      `${options.label} is not valid JSON: ${error.message}`,
      "MUTATION_GOVERNANCE_POLICY_INVALID",
    );
  }
}

function readBoundedProjectFile(root, absolutePath, { maxBytes, label }) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError(`${label} maxBytes must be positive`);
  normalizeProjectMutationPath(root, absolutePath);
  const parent = path.dirname(absolutePath);
  const parentBefore = fs.statSync(parent);
  let descriptor;
  try {
    descriptor = fs.openSync(absolutePath, fs.constants.O_RDONLY | NO_FOLLOW_FLAG);
    const before = fs.fstatSync(descriptor);
    if (!before.isFile()) throw new MutationGovernanceError(`${label} must be a regular file`, "MUTATION_PATH_INVALID");
    if (before.size > maxBytes) throw new MutationGovernanceError(`${label} exceeds its bounded read limit`, "MUTATION_GOVERNANCE_POLICY_TOO_LARGE");
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    const parentAfter = fs.statSync(parent);
    if (bytes.length > maxBytes
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || parentBefore.dev !== parentAfter.dev
      || parentBefore.ino !== parentAfter.ino) {
      throw new MutationGovernanceError(`${label} changed while it was read`, "MUTATION_GOVERNANCE_POLICY_UNSTABLE");
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function normalizeVerifiedActor(value) {
  if (!isPlainRecord(value)
    || value.verified !== true
    || !new Set(["host_verified", "ci_verified", "host_os_identity"]).has(value.assurance)) {
    throw new MutationGovernanceError(
      "Enforced mutation governance needs an identity verified by the host or CI; CLI actor names are not identity proof",
      "MUTATION_GOVERNANCE_IDENTITY_UNVERIFIED",
    );
  }
  return normalizeActorIdentity(value.actor, "verified mutation governance actor");
}

function normalizeReceiptRoots(root, configured) {
  const result = {
    decisions: normalizeProjectMutationPath(root, configured.decision_receipts_root),
    uses: normalizeProjectMutationPath(root, configured.use_receipts_root),
    revocations: normalizeProjectMutationPath(root, configured.revocations_root),
    auditEvents: normalizeProjectMutationPath(
      root,
      configured.audit_events_root ?? DEFAULT_GOVERNANCE_AUDIT_EVENTS_ROOT,
    ),
  };
  const entries = Object.entries(result);
  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
      const [leftName, leftPath] = entries[leftIndex];
      const [rightName, rightPath] = entries[rightIndex];
      if (leftPath === rightPath
        || leftPath.startsWith(`${rightPath}/`)
        || rightPath.startsWith(`${leftPath}/`)) {
        throw new MutationGovernanceError(
          `Governance ${leftName} and ${rightName} roots must be separate, non-nested directories`,
          "MUTATION_GOVERNANCE_CONFIG_INVALID",
        );
      }
    }
  }
  return Object.freeze(result);
}

function normalizeInputRevocations(values) {
  if (!Array.isArray(values)) {
    throw new MutationGovernanceError(
      "Mutation governance revocations must be an array",
      "MUTATION_GOVERNANCE_REVOCATIONS_INVALID",
    );
  }
  for (const [index, value] of values.entries()) {
    const integrity = validateGovernanceRevocationIntegrity(value);
    if (!integrity.valid) {
      throw new MutationGovernanceError(
        `Governance revocation ${index} is invalid: ${integrity.errors.join("; ")}`,
        "MUTATION_GOVERNANCE_REVOCATIONS_INVALID",
      );
    }
  }
  return immutableJson(values);
}

function normalizeInputApprovals(values) {
  if (!Array.isArray(values) || values.length > MAX_APPROVALS) {
    throw new MutationGovernanceError(
      `Mutation governance approvals must be an array of at most ${MAX_APPROVALS} records`,
      "MUTATION_GOVERNANCE_APPROVALS_INVALID",
    );
  }
  let encoded;
  try {
    encoded = JSON.stringify(values);
  } catch (error) {
    throw new MutationGovernanceError(
      `Mutation governance approvals are not bounded JSON: ${error.message}`,
      "MUTATION_GOVERNANCE_APPROVALS_INVALID",
    );
  }
  if (Buffer.byteLength(encoded, "utf8") > MAX_APPROVAL_BYTES) {
    throw new MutationGovernanceError(
      "Mutation governance approvals exceed their bounded total size",
      "MUTATION_GOVERNANCE_APPROVALS_INVALID",
    );
  }
  return immutableJson(values);
}

function readBoundedRevocations(root, projectRoot) {
  const absoluteRoot = path.join(root, ...projectRoot.split("/"));
  assertNoSymlinkSegments(root, absoluteRoot);
  let entry;
  try {
    entry = fs.lstatSync(absoluteRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return immutableJson([]);
    throw error;
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new MutationGovernanceError(
      "Governance revocations root must be a real directory",
      "MUTATION_GOVERNANCE_REVOCATIONS_INVALID",
    );
  }
  const before = fs.statSync(absoluteRoot);
  const names = fs.readdirSync(absoluteRoot).sort();
  if (names.length > MAX_REVOCATION_FILES) {
    throw new MutationGovernanceError(
      "Governance revocations root exceeds its bounded file count",
      "MUTATION_GOVERNANCE_REVOCATIONS_INVALID",
    );
  }
  const revocations = [];
  let totalBytes = 0;
  for (const name of names) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/u.test(name)) {
      throw new MutationGovernanceError(
        `Governance revocation filename '${name}' is not an exact JSON record`,
        "MUTATION_GOVERNANCE_REVOCATIONS_INVALID",
      );
    }
    const fileEntry = fs.lstatSync(path.join(absoluteRoot, name));
    if (fileEntry.isSymbolicLink() || !fileEntry.isFile()) {
      throw new MutationGovernanceError(
        `Governance revocation '${name}' must be a real regular file`,
        "MUTATION_GOVERNANCE_REVOCATIONS_INVALID",
      );
    }
    totalBytes += fileEntry.size;
    if (totalBytes > MAX_REVOCATION_TOTAL_BYTES) {
      throw new MutationGovernanceError(
        "Governance revocations exceed their bounded total size",
        "MUTATION_GOVERNANCE_REVOCATIONS_INVALID",
      );
    }
    revocations.push(readBoundedProjectJson(root, path.join(projectRoot, name), {
      maxBytes: MAX_REVOCATION_BYTES,
      label: `governance revocation ${name}`,
    }));
  }
  const after = fs.statSync(absoluteRoot);
  if (before.dev !== after.dev || before.ino !== after.ino) {
    throw new MutationGovernanceError(
      "Governance revocations root changed while it was read",
      "MUTATION_GOVERNANCE_REVOCATIONS_INVALID",
    );
  }
  return normalizeInputRevocations(revocations);
}

function mergeRevocations(left, right) {
  const byId = new Map();
  for (const revocation of [...left, ...right]) {
    const existing = byId.get(revocation.id);
    if (existing && existing.revocation_hash !== revocation.revocation_hash) {
      throw new MutationGovernanceError(
        `Governance revocation '${revocation.id}' has conflicting immutable records`,
        "MUTATION_GOVERNANCE_REVOCATIONS_INVALID",
      );
    }
    byId.set(revocation.id, revocation);
  }
  return immutableJson([...byId.values()].sort((leftValue, rightValue) =>
    leftValue.id.localeCompare(rightValue.id, "en")));
}

function assertGovernanceRecordSchema(value, schemaName, label) {
  const validation = validateAgainstSchema(value, schemaName, { schemaDir: PLUGIN_SCHEMA_DIR });
  if (!validation.valid) {
    throw new MutationGovernanceError(
      `${label} does not match ${schemaName}: ${validation.errors.slice(0, 8).map((error) => `${error.instance_path}: ${error.message}`).join("; ")}`,
      "MUTATION_GOVERNANCE_RECORD_SCHEMA_INVALID",
    );
  }
}

function persistGovernanceReceipt(root, receiptRoot, kind, contentHash, value, schemaName) {
  if (!SHA256_PATTERN.test(contentHash)) {
    throw new MutationGovernanceError(
      `Governance ${kind} receipt has no valid content hash`,
      "MUTATION_GOVERNANCE_RECEIPT_INVALID",
    );
  }
  assertGovernanceRecordSchema(value, schemaName, `Governance ${kind} receipt`);
  const absoluteRoot = ensurePrivateDirectoryTree(root, receiptRoot);
  const target = path.join(absoluteRoot, `${kind}-${contentHash}.json`);
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  writeExclusiveStableFile(root, absoluteRoot, target, bytes, `governance ${kind} receipt`);
  return target;
}

function persistGovernanceAuditEvent(root, auditRoot, outcome, recordedAt) {
  const request = outcome?.request ?? {};
  const reasonCodes = Array.isArray(outcome?.reason_codes)
    ? outcome.reason_codes.slice(0, 16).map((value) => String(value).slice(0, 128))
    : ["mutation.audit_denied"];
  const decision = outcome?.decision;
  const base = {
    kind: "governance_mutation_audit_event",
    schema_version: GOVERNANCE_AUDIT_EVENT_SCHEMA,
    version: 1,
    recorded_at: recordedAt,
    summary: "Audit observed a denied or failed mutation decision; the configured audit mode allowed execution to continue.",
    canonical_action: request.canonical_action ?? null,
    command_path: request.command_path ?? null,
    operation: request.operation ?? null,
    project_path: request.project_path ?? null,
    reason_codes: reasonCodes,
    decision_ref: decision?.decision_hash && decision?.id
      ? { id: decision.id, hash: decision.decision_hash, result: decision.decision }
      : null,
    error_digest: outcome?.error === null || outcome?.error === undefined
      ? null
      : crypto.createHash("sha256").update(String(outcome.error)).digest("hex"),
  };
  const eventHash = computeStableHash(base);
  const event = immutableJson({
    ...base,
    event_hash: eventHash,
    hash_algorithm: "sha256:stable-json:v1",
  });
  assertGovernanceRecordSchema(event, "governance-mutation-audit-event.schema.json", "Governance mutation audit event");
  const bytes = Buffer.from(`${JSON.stringify(event, null, 2)}\n`, "utf8");
  if (bytes.length > MAX_GOVERNANCE_AUDIT_EVENT_BYTES) {
    throw new MutationGovernanceError(
      "Governance audit event exceeds its bounded record size",
      "MUTATION_GOVERNANCE_AUDIT_EVENT_TOO_LARGE",
    );
  }

  const absoluteRoot = ensurePrivateDirectoryTree(root, auditRoot);
  const targetName = `event-${eventHash}.json`;
  const target = path.join(absoluteRoot, targetName);
  return withGovernanceAuditStoreLock(root, absoluteRoot, ({ assertOwned }) => {
    assertOwned();
    const inventory = inspectGovernanceAuditEvents(root, absoluteRoot);
    assertOwned();
    if (!inventory.names.has(targetName)
      && (inventory.count >= MAX_GOVERNANCE_AUDIT_EVENT_FILES
        || inventory.totalBytes + bytes.length > MAX_GOVERNANCE_AUDIT_TOTAL_BYTES)) {
      throw new MutationGovernanceError(
        "Governance audit event store reached its bounded capacity",
        "MUTATION_GOVERNANCE_AUDIT_STORE_FULL",
      );
    }
    assertOwned();
    writeExclusiveStableFile(root, absoluteRoot, target, bytes, "governance audit event");
    assertOwned();
    fsyncStablePrivateDirectory(root, absoluteRoot, "governance audit event");
    assertOwned();
    return target;
  });
}

/**
 * Serializes the capacity check and immutable create across cooperating
 * processes. Contention is deliberately non-blocking: audit mode must let the
 * command continue and surface the unavailable sink through its observation.
 * A stale lock is never guessed or reclaimed because ownership cannot be
 * proven safely from age or process id alone.
 */
function withGovernanceAuditStoreLock(root, absoluteRoot, callback) {
  const label = "governance audit event store lock";
  const lockPath = `${absoluteRoot}.lock`;
  const lockParent = path.dirname(lockPath);
  const directoryChain = captureStableDirectoryChain(root, lockParent, label);
  let descriptor;
  let callbackError;
  let acquired = false;
  try {
    assertStableDirectoryChain(directoryChain, label);
    try {
      descriptor = fs.openSync(
        lockPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW_FLAG,
        0o600,
      );
      acquired = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      throw new MutationGovernanceError(
        "Governance audit event store is busy; the audited command will continue without persisting this event",
        "MUTATION_GOVERNANCE_AUDIT_STORE_BUSY",
      );
    }
    const assertOwned = () => assertOpenTargetStable(descriptor, lockPath, directoryChain, label);
    assertOwned();
    return callback(Object.freeze({ assertOwned }));
  } catch (error) {
    callbackError = error;
    throw error;
  } finally {
    if (descriptor !== undefined) {
      let cleanupError;
      try {
        if (acquired) {
          assertOpenTargetStable(descriptor, lockPath, directoryChain, label);
          fs.unlinkSync(lockPath);
          assertStableDirectoryChain(directoryChain, label);
          fsyncStablePrivateDirectory(root, lockParent, label);
        }
      } catch (releaseError) {
        // Never unlink a replacement whose identity cannot be proven. If the
        // critical section already failed, its diagnostic remains primary.
        cleanupError = releaseError;
      }
      try {
        fs.closeSync(descriptor);
      } catch (closeError) {
        cleanupError ??= closeError;
      }
      // Cleanup must never mask a failure from the capacity/create critical
      // section. With no primary failure, it still makes the sink unavailable
      // so audit mode can report the degraded persistence path.
      if (callbackError === undefined && cleanupError !== undefined) throw cleanupError;
    }
  }
}

function inspectGovernanceAuditEvents(root, absoluteRoot) {
  const label = "governance audit event store";
  const directoryChain = captureStableDirectoryChain(root, absoluteRoot, label);
  const before = fs.statSync(absoluteRoot);
  const names = new Set();
  let count = 0;
  let totalBytes = 0;
  let directory;
  try {
    directory = fs.opendirSync(absoluteRoot);
    let entry;
    while ((entry = directory.readSync()) !== null) {
      count += 1;
      if (count > MAX_GOVERNANCE_AUDIT_EVENT_FILES) {
        throw new MutationGovernanceError(
          "Governance audit event store exceeds its bounded file count",
          "MUTATION_GOVERNANCE_AUDIT_STORE_FULL",
        );
      }
      if (!/^event-[a-f0-9]{64}\.json$/u.test(entry.name)) {
        throw new MutationGovernanceError(
          "Governance audit event store contains an unsupported entry",
          "MUTATION_GOVERNANCE_AUDIT_STORE_INVALID",
        );
      }
      const eventPath = path.join(absoluteRoot, entry.name);
      const eventEntry = fs.lstatSync(eventPath);
      if (eventEntry.isSymbolicLink()
        || !eventEntry.isFile()
        || eventEntry.size > MAX_GOVERNANCE_AUDIT_EVENT_BYTES) {
        throw new MutationGovernanceError(
          "Governance audit event store contains an unsafe or oversized record",
          "MUTATION_GOVERNANCE_AUDIT_STORE_INVALID",
        );
      }
      totalBytes += eventEntry.size;
      if (totalBytes > MAX_GOVERNANCE_AUDIT_TOTAL_BYTES) {
        throw new MutationGovernanceError(
          "Governance audit event store exceeds its bounded total size",
          "MUTATION_GOVERNANCE_AUDIT_STORE_FULL",
        );
      }
      names.add(entry.name);
    }
  } finally {
    directory?.closeSync();
  }
  assertStableDirectoryChain(directoryChain, label);
  const after = fs.statSync(absoluteRoot);
  if (before.dev !== after.dev || before.ino !== after.ino) {
    throw new MutationGovernanceError(
      "Governance audit event store changed while it was inspected",
      "MUTATION_PATH_UNSTABLE",
    );
  }
  return Object.freeze({ names, count, totalBytes });
}

function fsyncStablePrivateDirectory(root, absoluteRoot, label) {
  const directoryChain = captureStableDirectoryChain(root, absoluteRoot, label);
  let descriptor;
  try {
    descriptor = fs.openSync(absoluteRoot, fs.constants.O_RDONLY | NO_FOLLOW_FLAG);
    const opened = fs.fstatSync(descriptor);
    const expected = directoryChain.at(-1);
    if (!opened.isDirectory() || opened.dev !== expected.dev || opened.ino !== expected.ino) {
      throw new MutationGovernanceError(`${label} directory changed before fsync`, "MUTATION_PATH_UNSTABLE");
    }
    fs.fsyncSync(descriptor);
    assertStableDirectoryChain(directoryChain, label);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function ensurePrivateDirectoryTree(root, projectRoot) {
  const normalized = normalizeProjectMutationPath(root, projectRoot);
  let current = root;
  for (const segment of normalized.split("/")) {
    const next = path.join(current, segment);
    const currentEntry = fs.lstatSync(current);
    if (currentEntry.isSymbolicLink() || !currentEntry.isDirectory()) {
      throw new MutationGovernanceError(
        "Governance receipt parent must remain a real directory",
        "MUTATION_PATH_UNSTABLE",
      );
    }
    const parentBefore = fs.statSync(current);
    try {
      fs.mkdirSync(next, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const entry = fs.lstatSync(next);
    const parentAfter = fs.statSync(current);
    if (entry.isSymbolicLink()
      || !entry.isDirectory()
      || parentBefore.dev !== parentAfter.dev
      || parentBefore.ino !== parentAfter.ino) {
      throw new MutationGovernanceError(
        "Governance receipt directory changed while it was prepared",
        "MUTATION_PATH_UNSTABLE",
      );
    }
    current = next;
  }
  return current;
}

function writeExclusiveStableFile(root, parent, target, bytes, label) {
  const directoryChain = captureStableDirectoryChain(root, parent, label);
  let descriptor;
  let created = false;
  try {
    try {
      assertStableDirectoryChain(directoryChain, label);
      descriptor = fs.openSync(
        target,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW_FLAG,
        0o600,
      );
      created = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      assertStableDirectoryChain(directoryChain, label);
      const existing = readBoundedProjectFile(root, target, {
        maxBytes: Math.max(bytes.length, 1),
        label,
      });
      assertStableDirectoryChain(directoryChain, label);
      if (!existing.equals(bytes)) {
        throw new MutationGovernanceError(
          `${label} hash path already contains different bytes`,
          "MUTATION_GOVERNANCE_RECEIPT_CONFLICT",
        );
      }
      return;
    }
    assertOpenTargetStable(descriptor, target, directoryChain, label);
    let offset = 0;
    while (offset < bytes.length) {
      assertOpenTargetStable(descriptor, target, directoryChain, label);
      const written = fs.writeSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (!Number.isInteger(written) || written <= 0) {
        throw new MutationGovernanceError(`${label} write was incomplete`, "MUTATION_APPEND_INCOMPLETE");
      }
      offset += written;
    }
    fs.fsyncSync(descriptor);
    assertOpenTargetStable(descriptor, target, directoryChain, label);
  } catch (error) {
    if (created && descriptor !== undefined) {
      try {
        // Only unlink through the original project path when every directory
        // name still identifies the exact non-symlink chain captured before
        // O_EXCL. Once instability is observed, preserve the zero-byte inode
        // instead of attempting cleanup through an attacker-controlled name.
        assertOpenTargetStable(descriptor, target, directoryChain, label);
        fs.unlinkSync(target);
      } catch { /* preserve an unstable target instead of deleting an entry we cannot prove we created */ }
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function captureStableDirectoryChain(root, parent, label) {
  const resolvedRoot = path.resolve(root);
  const resolvedParent = path.resolve(parent);
  const relative = path.relative(resolvedRoot, resolvedParent);
  if (pathIsOutsideBoundary(relative)) {
    throw new MutationGovernanceError(`${label} parent escapes the project root`, "MUTATION_PATH_UNSTABLE");
  }
  const paths = [resolvedRoot];
  let current = resolvedRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    paths.push(current);
  }
  return Object.freeze(paths.map((directoryPath) => {
    const entry = fs.lstatSync(directoryPath);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new MutationGovernanceError(`${label} parent chain is not a real directory`, "MUTATION_PATH_UNSTABLE");
    }
    return Object.freeze({
      path: directoryPath,
      dev: entry.dev,
      ino: entry.ino,
      realpath: fs.realpathSync.native?.(directoryPath) ?? fs.realpathSync(directoryPath),
    });
  }));
}

function assertStableDirectoryChain(directoryChain, label) {
  for (const expected of directoryChain) {
    const entry = fs.lstatSync(expected.path);
    const realpath = fs.realpathSync.native?.(expected.path) ?? fs.realpathSync(expected.path);
    if (entry.isSymbolicLink()
      || !entry.isDirectory()
      || entry.dev !== expected.dev
      || entry.ino !== expected.ino
      || realpath !== expected.realpath) {
      throw new MutationGovernanceError(`${label} parent chain changed while it was written`, "MUTATION_PATH_UNSTABLE");
    }
  }
}

function assertOpenTargetStable(descriptor, target, directoryChain, label) {
  assertStableDirectoryChain(directoryChain, label);
  const descriptorStat = fs.fstatSync(descriptor);
  const pathStat = fs.lstatSync(target);
  if (!descriptorStat.isFile()
    || pathStat.isSymbolicLink()
    || descriptorStat.dev !== pathStat.dev
    || descriptorStat.ino !== pathStat.ino) {
    throw new MutationGovernanceError(`${label} target changed while it was written`, "MUTATION_PATH_UNSTABLE");
  }
}

function normalizeBootstrapMutations(root, action, values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new MutationGovernanceError("Bootstrap grants require exact mutations", "MUTATION_BOOTSTRAP_DENIED");
  }
  const normalized = values.map((value) => {
    if (!isPlainRecord(value)) throw new MutationGovernanceError("Bootstrap mutation is invalid", "MUTATION_BOOTSTRAP_DENIED");
    return immutableJson({
      canonical_action: action,
      operation: normalizeOperation(value.operation),
      project_path: normalizeProjectMutationPath(root, value.path ?? value.project_path),
    });
  });
  const byHash = new Map(normalized.map((value) => [computeStableHash(value), value]));
  if (byHash.size !== normalized.length) {
    throw new MutationGovernanceError("Bootstrap mutations must be unique", "MUTATION_BOOTSTRAP_DENIED");
  }
  return immutableJson([...byHash.values()].sort((left, right) => (
    `${left.operation}\u0000${left.project_path}`.localeCompare(`${right.operation}\u0000${right.project_path}`, "en")
  )));
}

function assertExactHashPair(value, expected, label) {
  if (!SHA256_PATTERN.test(String(value ?? "")) || value !== expected) {
    throw new MutationGovernanceError(`${label} hash does not match exactly`, "MUTATION_BOOTSTRAP_DENIED");
  }
}

function safeExactToken(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{7,255}$/u.test(value);
}

function safeExactBootstrapGrantId(value) {
  return typeof value === "string" && /^[a-f0-9]{48}$/u.test(value);
}

function normalizeMode(value) {
  const mode = String(value ?? "").trim().toLowerCase();
  if (!MUTATION_GOVERNANCE_MODES.includes(mode)) {
    throw new MutationGovernanceError(`Unsupported mutation governance mode '${mode || "(missing)"}'`, "MUTATION_GOVERNANCE_CONFIG_INVALID");
  }
  return mode;
}

function normalizeAction(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!ACTION_PATTERN.test(normalized)) {
    throw new MutationGovernanceError("Mutation canonical action is missing or invalid", "MUTATION_METADATA_MISSING");
  }
  return normalized;
}

function normalizeCommandPath(value) {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/\s+/gu, " ");
  if (!normalized || !/^[a-z0-9][a-z0-9._-]*(?: [a-z0-9][a-z0-9._-]*)*$/u.test(normalized)) {
    throw new MutationGovernanceError("Mutation command path is missing or invalid", "MUTATION_METADATA_MISSING");
  }
  return normalized;
}

function normalizeOperation(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!OPERATION_PATTERN.test(normalized)) {
    throw new MutationGovernanceError("Mutation operation is missing or invalid", "MUTATION_METADATA_MISSING");
  }
  return normalized;
}

function normalizeRoot(value) {
  const root = path.resolve(String(value ?? ""));
  if (!value || !fs.existsSync(root)) {
    throw new MutationGovernanceError("Mutation governance root must exist", "MUTATION_ROOT_INVALID");
  }
  const entry = fs.lstatSync(root);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new MutationGovernanceError("Mutation governance root must be a real directory", "MUTATION_ROOT_INVALID");
  }
  return root;
}

function assertNoSymlinkSegments(root, target) {
  let current = root;
  const relative = path.relative(root, target);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new MutationGovernanceError("Mutation path cannot traverse a symbolic link", "MUTATION_PATH_SYMLINK");
      }
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
  }
}

function resolveNow(provider) {
  const value = typeof provider === "function" ? provider() : new Date().toISOString();
  return value;
}

function nextDecisionId(provider) {
  return nextRecordId(provider, "decision");
}

function nextRecordId(provider, kind) {
  if (typeof provider === "function") return provider(kind);
  decisionSequence += 1;
  return `${kind}-${process.pid}-${decisionSequence}`;
}
