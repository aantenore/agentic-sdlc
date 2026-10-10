import fs from "node:fs";
import path from "node:path";
import {
  DELEGATION_USE_SCHEMA_VERSION,
  delegationHashValid,
} from "../approval-delegation.mjs";

/**
 * Where approval delegations live, and the read-only checks other modules run
 * on them. Kept free of engine imports so approval validation can use it.
 */

export { VERIFIED_DELEGATION_USE } from "../approval-delegation.mjs";

export function delegationsRoot(context) {
  return path.join(context.sdlcRoot, "autonomy", "delegations");
}

export function delegationDirectory(context, id) {
  return path.join(delegationsRoot(context), id);
}

export function delegationRecordPath(context, id) {
  return path.join(delegationDirectory(context, id), "delegation.json");
}

export function delegationRevocationPath(context, id) {
  return path.join(delegationDirectory(context, id), "revocation.json");
}

export function delegationUsesRoot(context, id) {
  return path.join(delegationDirectory(context, id), "uses");
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function readDelegationRecord(context, id) {
  return readJson(delegationRecordPath(context, id));
}

export function readDelegationRevocation(context, id) {
  return readJson(delegationRevocationPath(context, id));
}

export function listDelegationIds(context) {
  try {
    return fs.readdirSync(delegationsRoot(context), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

export function readDelegationUses(context, id) {
  try {
    return fs.readdirSync(delegationUsesRoot(context, id))
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => readJson(path.join(delegationUsesRoot(context, id), name)))
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Integrity of an approval recorded under a delegation: the delegation still
 * exists with the hash the approval names, and the use receipt it points to
 * exists, is intact and belongs to that delegation. Validity at use is what
 * the receipt recorded; a later expiry or revocation does not undo it.
 */
export function delegatedApprovalRecordErrors(context, approval, recordedActor = null) {
  const errors = [];
  const ref = approval?.delegation;
  if (!ref?.id || !ref.record_hash) return ["it names no delegation"];
  // Records that keep their actor elsewhere (an output decision's audit.decided_by) pass it as recordedActor.
  const actor = approval.approved_by || recordedActor;
  if (actor?.type !== "agent") errors.push("a delegated approval must be applied by an agent actor");
  const record = readDelegationRecord(context, ref.id);
  if (!record) return [...errors, `delegation ${ref.id} does not exist`];
  if (!delegationHashValid(record) || record.record_hash !== ref.record_hash) {
    errors.push(`delegation ${ref.id} no longer matches the hash recorded at use`);
  }
  const use = ref.use_path ? readJson(path.join(context.root, ref.use_path)) : null;
  if (!use || use.schema_version !== DELEGATION_USE_SCHEMA_VERSION) {
    errors.push(`the validity-at-use receipt of delegation ${ref.id} is missing`);
  } else if (!delegationHashValid(use) || use.record_hash !== ref.use_hash || use.delegation_ref?.id !== ref.id) {
    errors.push(`the validity-at-use receipt of delegation ${ref.id} was altered`);
  } else {
    const valid = use.valid_at_use || {};
    if (valid.hash_valid !== true || valid.revoked !== false || valid.action_covered !== true || valid.scope_covered !== true
      || (valid.expires_at && valid.checked_at && Date.parse(valid.checked_at) > Date.parse(valid.expires_at))) {
      errors.push(`delegation ${ref.id} was not valid for this action at use`);
    }
    if (ref.action && use.action !== ref.action) errors.push(`the receipt of delegation ${ref.id} covers ${use.action}, not ${ref.action}`);
    if (use.used_by?.type !== "agent") errors.push(`the receipt of delegation ${ref.id} was not recorded by an agent actor`);
    if (!approval.approved_by && recordedActor?.id && use.used_by?.id && recordedActor.id !== use.used_by.id) {
      errors.push(`the recorded actor ${recordedActor.id} is not the agent ${use.used_by.id} that used delegation ${ref.id}`);
    }
  }
  return errors;
}
