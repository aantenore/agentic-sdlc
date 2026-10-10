import path from "node:path";
import {
  autonomyLifecycleReceiptHash,
} from "../lifecycle/authorization.mjs";
import {
  deliveryExecutionRoot,
} from "../lifecycle/delivery.mjs";
import {
  readProjectJson,
  safeReadDir,
} from "./storage.mjs";

export const EVIDENCE_SUPERSEDE_KIND = "delivery_evidence_supersede_record";
export const EVIDENCE_SUPERSEDE_VERSION = "delivery-evidence-supersede:v1";

export function evidenceSupersedeHash(record) {
  const { record_hash: _hash, hash_algorithm: _algorithm, ...canonical } = record || {};
  return autonomyLifecycleReceiptHash(canonical);
}

export function evidenceSupersedeRoot(context, profileId) {
  return path.join(deliveryExecutionRoot(context, profileId), "evidence-supersede");
}

/**
 * The valid supersede record of a person for exactly this receipt, evidence
 * path and recorded hash, or null. A record that fails its hash or binding
 * is ignored, so it never relaxes a check.
 */
export function findEvidenceSupersede(context, receipt, evidence) {
  const profileId = receipt?.profile_ref?.id;
  if (!profileId || !evidence?.path) return null;
  let names;
  try {
    names = safeReadDir(evidenceSupersedeRoot(context, profileId)).filter((name) => name.endsWith(".json"));
  } catch {
    return null;
  }
  for (const name of names) {
    let record;
    try {
      record = readProjectJson(context, path.join(evidenceSupersedeRoot(context, profileId), name));
    } catch {
      continue;
    }
    if (
      record?.kind === EVIDENCE_SUPERSEDE_KIND
      && record.receipt_ref?.id === receipt.id
      && record.receipt_ref?.hash === receipt.receipt_hash
      && record.evidence?.path === evidence.path
      && record.evidence?.recorded_sha256 === evidence.sha256
      && record.recorded_by?.type === "human"
      && record.record_hash === evidenceSupersedeHash(record)
    ) return record;
  }
  return null;
}
