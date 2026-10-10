import fs from "node:fs";
import path from "node:path";
import {
  runsInsideAgentHost,
} from "../agent-host.mjs";
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
  deliveryAutonomyPath,
} from "../lifecycle/delivery.mjs";
import {
  humanGuidanceLocale,
} from "../lifecycle/guidance.mjs";
import {
  toProjectPath,
} from "../lifecycle/project.mjs";
import {
  buildApprovalRecord,
} from "./authorization.mjs";
import {
  buildAttribution,
  now,
} from "./common.mjs";
import {
  deliveryActionReceipts,
  readDeliveryAutonomyProfile,
} from "./delivery.mjs";
import {
  EVIDENCE_SUPERSEDE_KIND,
  EVIDENCE_SUPERSEDE_VERSION,
  evidenceSupersedeHash,
  evidenceSupersedeRoot,
  findEvidenceSupersede,
  findEvidenceSupersedeForPath,
  traceEvidenceSupersedeRoot,
} from "./evidence-supersede-records.mjs";
import {
  ensureInitialized,
} from "./migration.mjs";
import {
  readTraceEvents,
} from "./story.mjs";
import {
  output,
} from "./output.mjs";
import {
  acquireFileLock,
  hashFile,
  writeJsonFile,
} from "./storage.mjs";
import {
  resolveProjectFilePath,
} from "./project.mjs";

/**
 * `autonomy delivery evidence supersede`: a person declares that an evidence
 * file of an existing action receipt was lost or overwritten. It appends one
 * immutable record; the receipt and the file are never edited.
 */
export function supersedeDeliveryEvidence(context, options) {
  ensureInitialized(context);
  const traceId = getOptionString(options, "trace");
  if (traceId && (getOptionString(options, "receipt") || getOptionString(options, "id"))) {
    fail("--trace is an alternative to --id/--receipt; give one or the other.");
  }
  const profileId = traceId ? null : normalizeId(requireOption(options, "id"));
  const receiptId = traceId ? null : String(requireOption(options, "receipt")).trim();
  const evidenceOption = String(requireOption(options, "path")).trim();
  const target = traceId ? `--trace ${traceId}` : `--id ${profileId} --receipt ${receiptId}`;
  const userCommand = `autonomy delivery evidence supersede ${target} `
    + `--path ${evidenceOption} --reason "<why>" --actor-type human --approval-source explicit-user --summary "<your words>"`;
  if (runsInsideAgentHost()) {
    fail(
      "Declaring a recorded evidence file lost is a person's decision and cannot run inside an agent session. "
      + `The user runs '${userCommand}' in their own terminal.`,
      {
        en: {
          result: "The evidence was not superseded.",
          protection_boundary: "Nothing was recorded; the receipt and its evidence are unchanged.",
          impact: "An agent cannot excuse a change to evidence the audit trail depends on.",
          required_decision: "The person who knows what happened to the file declares it from their own terminal.",
          next_action: `Run '${userCommand}' outside the agent session.`,
        },
        it: {
          result: "L’evidenza non è stata sostituita.",
          protection_boundary: "Nulla è stato registrato; la ricevuta e la sua evidenza sono invariate.",
          impact: "Un agente non può giustificare la modifica di un’evidenza da cui dipende la traccia di audit.",
          required_decision: "La persona che sa cosa è successo al file lo dichiara dal proprio terminale.",
          next_action: `Esegui '${userCommand}' fuori dalla sessione dell’agente.`,
        },
      },
    );
  }
  const reason = getOptionString(options, "reason");
  if (!reason) fail("--reason must say why the evidence file was lost or overwritten.");
  const summary = getOptionString(options, "summary");
  if (!summary) fail("--summary must give, in the person's own words, why the evidence is superseded.");
  const italian = humanGuidanceLocale(options) === "it";
  if (traceId) return supersedeTraceEvidence(context, options, { traceId, evidenceOption, reason, italian });
  const profilePath = deliveryAutonomyPath(context, profileId);
  const releaseLock = acquireFileLock(`${profilePath}.lock`);
  try {
    const profile = readDeliveryAutonomyProfile(context, profileId);
    const receipt = deliveryActionReceipts(context, profile.id).find((item) => item.id === receiptId);
    if (!receipt) fail(`Delivery profile ${profile.id} has no action receipt ${receiptId}.`);
    const projectPath = toProjectPath(context, resolveProjectFilePath(context, evidenceOption, { mustExist: false }));
    const evidence = (receipt.evidence || []).find((item) => item.path === projectPath || item.path === evidenceOption);
    if (!evidence) fail(`${evidenceOption} is not an evidence path of receipt ${receiptId}.`);
    let currentHash;
    try {
      currentHash = hashFile(resolveProjectFilePath(context, evidence.path, { mustExist: true, fileOnly: true }));
    } catch {
      currentHash = null;
    }
    if (currentHash === evidence.sha256) {
      fail(`Evidence ${evidence.path} still matches receipt ${receiptId}; there is nothing to supersede.`);
    }
    if (findEvidenceSupersede(context, receipt, evidence)) {
      fail(`Evidence ${evidence.path} of receipt ${receiptId} is already superseded.`);
    }
    const attribution = buildAttribution(context, options, "autonomy.delivery.evidence.supersede");
    requireFormalApprovalActor(context, options, attribution, "Superseding recorded evidence");
    if (attribution.actor.type !== "human" || getOptionString(options, "approval-source") !== "explicit-user") {
      fail("Superseding recorded evidence needs --actor-type human and --approval-source explicit-user.");
    }
    const subject = {
      profile_id: profile.id,
      receipt_id: receipt.id,
      receipt_hash: receipt.receipt_hash,
      path: evidence.path,
      recorded_sha256: evidence.sha256,
      current_sha256: currentHash,
      reason,
    };
    const approval = buildApprovalRecord(context, options, attribution, {
      subject,
      subject_id_field: "profile_id",
      subject_id: profile.id,
      status: "approved",
      scope: "delivery-evidence-supersede",
      label: `evidence supersede ${profile.id}`,
    });
    const recordedAt = now();
    const base = {
      id: `AUT-EVSUP-${normalizeId(receipt.id)}-${recordedAt.replace(/\D/gu, "").slice(0, 17)}`,
      kind: EVIDENCE_SUPERSEDE_KIND,
      schema_version: EVIDENCE_SUPERSEDE_VERSION,
      profile_ref: { id: profile.id, hash: profile.profile_hash },
      receipt_ref: { id: receipt.id, hash: receipt.receipt_hash },
      evidence: { path: evidence.path, recorded_sha256: evidence.sha256, current_sha256: currentHash },
      reason,
      approval,
      recorded_by: attribution.actor,
      recorded_at: recordedAt,
      audit: { git: attribution.git, run: attribution.run },
    };
    const record = { ...base, record_hash: evidenceSupersedeHash(base), hash_algorithm: "sha256:stable-json:v1" };
    const recordPath = path.join(evidenceSupersedeRoot(context, profile.id), `${record.id}.json`);
    writeJsonFile(recordPath, record, { atomicCreate: true });
    const storyId = profile.story_refs?.[0]?.id || null;
    const payload = {
      status: "superseded",
      story_id: storyId,
      publish_required: "Publish the .sdlc records on main so the other computers see this record.",
      evidence_supersede: record,
      evidence_supersede_path: toProjectPath(context, recordPath),
    };
    output(options, {
      status: "superseded",
      story_id: storyId,
      publish_required: payload.publish_required,
      evidence_supersede: record,
      evidence_supersede_path: toProjectPath(context, recordPath),
    }, italian
      ? [`Evidenza ${evidence.path} della ricevuta ${receipt.id} dichiarata sostituita da una persona: ${reason}`, `Record: ${toProjectPath(context, recordPath)}`, "Pubblica i record .sdlc su main perché gli altri computer vedano questo record."]
      : [`Evidence ${evidence.path} of receipt ${receipt.id} declared superseded by a person: ${reason}`, `Record: ${toProjectPath(context, recordPath)}`, "Publish the .sdlc records on main so the other computers see this record."]);
    return payload;
  } finally {
    releaseLock();
  }
}

function findTraceEvent(context, traceId) {
  const dir = path.join(context.sdlcRoot, "traces");
  let names;
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return null;
  }
  for (const name of names) {
    const event = readTraceEvents(context, name.slice(0, -".jsonl".length)).find((item) => item?.id === traceId);
    if (event) return event;
  }
  return null;
}

/** Same declaration as for a receipt, for evidence bound by a trace event. */
function supersedeTraceEvidence(context, options, { traceId, evidenceOption, reason, italian }) {
  const event = findTraceEvent(context, traceId);
  if (!event) fail(`No trace event ${traceId} exists in this project.`);
  const projectPath = toProjectPath(context, resolveProjectFilePath(context, evidenceOption, { mustExist: false }));
  const ref = (event.evidence_refs || []).find((item) => item.path === projectPath || item.path === evidenceOption);
  if (!ref) fail(`${evidenceOption} is not an evidence path of trace ${traceId}.`);
  let currentHash;
  try {
    currentHash = hashFile(resolveProjectFilePath(context, ref.path, { mustExist: true, fileOnly: true }));
  } catch {
    currentHash = null;
  }
  if (!currentHash) fail(`Evidence ${ref.path} of trace ${traceId} is missing; there is no current content to declare.`);
  if (findEvidenceSupersedeForPath(context, ref.path, currentHash)) {
    fail(`Evidence ${ref.path} with this content is already superseded.`);
  }
  const attribution = buildAttribution(context, options, "autonomy.delivery.evidence.supersede");
  requireFormalApprovalActor(context, options, attribution, "Superseding recorded evidence");
  if (attribution.actor.type !== "human" || getOptionString(options, "approval-source") !== "explicit-user") {
    fail("Superseding recorded evidence needs --actor-type human and --approval-source explicit-user.");
  }
  const subject = {
    trace_id: traceId,
    path: ref.path,
    recorded_sha256: ref.sha256,
    current_sha256: currentHash,
    reason,
  };
  const approval = buildApprovalRecord(context, options, attribution, {
    subject,
    subject_id_field: "trace_id",
    subject_id: traceId,
    status: "approved",
    scope: "delivery-evidence-supersede",
    label: `evidence supersede ${traceId}`,
  });
  const recordedAt = now();
  const base = {
    id: `AUT-EVSUP-${normalizeId(traceId)}-${recordedAt.replace(/\D/gu, "").slice(0, 17)}`,
    kind: EVIDENCE_SUPERSEDE_KIND,
    schema_version: EVIDENCE_SUPERSEDE_VERSION,
    trace_ref: { id: traceId, story_id: event.story_id || null },
    evidence: { path: ref.path, recorded_sha256: ref.sha256, current_sha256: currentHash },
    reason,
    approval,
    recorded_by: attribution.actor,
    recorded_at: recordedAt,
    audit: { git: attribution.git, run: attribution.run },
  };
  const record = { ...base, record_hash: evidenceSupersedeHash(base), hash_algorithm: "sha256:stable-json:v1" };
  const recordPath = path.join(traceEvidenceSupersedeRoot(context), `${record.id}.json`);
  const releaseLock = acquireFileLock(`${recordPath}.lock`);
  try {
    writeJsonFile(recordPath, record, { atomicCreate: true });
  } finally {
    releaseLock();
  }
  const storyId = event.story_id || null;
  const publishRequired = "Publish the .sdlc records on main so the other computers see this record.";
  const payload = {
    status: "superseded",
    story_id: storyId,
    publish_required: publishRequired,
    evidence_supersede: record,
    evidence_supersede_path: toProjectPath(context, recordPath),
  };
  output(options, payload, italian
    ? [`Evidenza ${ref.path} della trace ${traceId} dichiarata sostituita da una persona: ${reason}`, `Record: ${payload.evidence_supersede_path}`, "Pubblica i record .sdlc su main perché gli altri computer vedano questo record."]
    : [`Evidence ${ref.path} of trace ${traceId} declared superseded by a person: ${reason}`, `Record: ${payload.evidence_supersede_path}`, publishRequired]);
  return payload;
}
