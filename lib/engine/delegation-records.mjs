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
export function delegatedApprovalRecordErrors(context, approval) {
  const errors = [];
  const ref = approval?.delegation;
  if (!ref?.id || !ref.record_hash) return ["it names no delegation"];
  if (approval.approved_by?.type !== "agent") errors.push("a delegated approval must be applied by an agent actor");
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
  }
  return errors;
}
