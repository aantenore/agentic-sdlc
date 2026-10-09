// Plain explanations for a blocked story lifecycle projection: what blocks
// the story (by source and reason), the first concrete error, and the
// correction to try. Read-only: nothing here changes a record.

const MAX_ERROR_CHARS = 300;

const FINAL_RECEIPT_CHECK_PREFIX = "final_receipt_check:";

function firstError(lifecycle) {
  const error = (lifecycle?.errors || []).find((entry) => String(entry || "").trim());
  if (!error) return "";
  const text = String(error).replace(/\s+/gu, " ").trim();
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS - 1)}…` : text;
}

function workflowCause(reason) {
  switch (reason) {
    case "project_history_integrity":
      return "story workflow records cannot be trusted because the shared project history (.sdlc/traces/project.jsonl) no longer verifies as one chain";
    case "project_history_unreadable":
      return "story workflow records cannot be checked because the shared project history is unreadable";
    case "workflow_trace_missing":
      return "story workflow has no project history file";
    case "workflow_trace_coverage":
      return "story workflow records are missing, duplicated, or out of order in the project history";
    case "task_start_binding":
      return "story workflow does not match the story's task-start record";
    case "workflow_selection":
      return "the current story workflow cannot be selected";
    case "workflow_start_trace":
      return "the story workflow start record in the project history does not match the workflow";
    case "workflow_checkpoint":
      return "story workflow checkpoint is missing or does not match its records";
    case "workflow_history_replay":
      return "story workflow event history does not replay";
    case "workflow_transition_interrupted":
      return "a story workflow transition was interrupted";
    case "workflow_story_binding":
      return "story workflow is not bound to this story";
    case "workflow_instance_identity":
      return "story workflow instance records a different id";
    default:
      return "invalid story workflow records";
  }
}

function finalReceiptCause(reason) {
  if (String(reason || "").startsWith(FINAL_RECEIPT_CHECK_PREFIX)) {
    const check = reason.slice(FINAL_RECEIPT_CHECK_PREFIX.length);
    if (check === "story_record_changed") {
      return "a record of the story itself changed after certification";
    }
    if (check === "certified_commit_missing") {
      return "the commit this story was certified on is not in this clone";
    }
    if (check === "certified_history_rewritten") {
      return "the git history was rewritten after certification: the certified commit is no longer an ancestor of HEAD";
    }
    if (check === "workflowFinalFreshnessProofMatches") {
      return "final lifecycle receipt no longer matches the certified files (they changed after certification)";
    }
    if (check === "integrity.valid") {
      return "final lifecycle receipt cannot be checked because its workflow records do not verify";
    }
    if (check === "currentCertifiedLifecycleEvidenceMatches") {
      return "final lifecycle receipt no longer matches the current lifecycle evidence";
    }
    if (check === "taskStartBinding.valid" || check.startsWith("proof.task_start_ref")) {
      return "final lifecycle receipt does not match the story's task-start record";
    }
    return `final lifecycle receipt does not match its workflow (${check})`;
  }
  if (reason === "final_receipt_unreadable") return "final lifecycle receipt is unreadable";
  return "invalid or unreadable final lifecycle receipt";
}

// The first story record a certification found changed, when known.
function firstChangedRecordPath(lifecycle) {
  const record = (lifecycle?.changed_records || []).find((entry) => entry?.path);
  return record ? String(record.path) : null;
}

/** Short English cause for a blocked lifecycle, with its first concrete error. */
export function lifecycleBlockerText(lifecycle) {
  if (!lifecycle?.blocked) return null;
  if (lifecycle.reason === `${FINAL_RECEIPT_CHECK_PREFIX}story_record_changed`) {
    const changedPath = firstChangedRecordPath(lifecycle);
    return changedPath
      ? `a record of the story itself changed after certification: ${changedPath}`
      : "a record of the story itself changed after certification";
  }
  if (
    lifecycle.reason === `${FINAL_RECEIPT_CHECK_PREFIX}certified_commit_missing`
    || lifecycle.reason === `${FINAL_RECEIPT_CHECK_PREFIX}certified_history_rewritten`
  ) {
    return finalReceiptCause(lifecycle.reason);
  }
  let cause;
  switch (lifecycle.source) {
    case "invalid_story_closure":
      cause = "invalid or unapproved story closure record";
      break;
    case "invalid_story_workflow":
      cause = workflowCause(lifecycle.reason);
      break;
    case "invalid_workflow_final_receipt":
      cause = finalReceiptCause(lifecycle.reason);
      break;
    case "missing_workflow_final_receipt":
      cause = "story workflow finished but its final lifecycle receipt is missing";
      break;
    case "story_workflow_lifecycle_conflict":
      cause = "story record is closed but its workflow is still open";
      break;
    default:
      cause = "invalid story lifecycle records";
  }
  const error = firstError(lifecycle);
  return error ? `${cause}: ${error}` : cause;
}

/**
 * The correction to try for a blocked lifecycle, as { en, it, command }.
 * command is a CLI line without the executable name, or null.
 */
export function lifecycleRemedy(lifecycle) {
  if (!lifecycle?.blocked) return null;
  const instance = lifecycle.workflow_instance_id;
  const inspect = instance ? `workflow instance status --id ${instance}` : "trace verify";
  const reason = String(lifecycle.reason || "");
  if (lifecycle.source === "invalid_story_closure") {
    return {
      en: "Restore the story's approved closure record exactly as it was approved.",
      it: "Ripristina il record di chiusura approvato della story esattamente com'era.",
      command: null,
    };
  }
  if (reason === "project_history_integrity" || reason === "project_history_unreadable") {
    return {
      en: "The shared project history no longer chains, usually because records from several computers were copied onto one branch. Check it with trace verify; to check each workflow on its own records set orchestration_policy.workflow_history.check to workflow.",
      it: "La cronologia di progetto condivisa non è più una catena unica, di solito perché i record di più computer sono stati copiati su un solo branch. Controllala con trace verify; per verificare ogni workflow sui propri record imposta orchestration_policy.workflow_history.check a workflow.",
      command: "trace verify",
    };
  }
  if (reason === "workflow_trace_coverage" || reason === "workflow_trace_missing") {
    return {
      en: "Copy every record line of this workflow from the computer that ran it into .sdlc/traces/project.jsonl, unchanged and in order, then check again.",
      it: "Copia in .sdlc/traces/project.jsonl tutte le righe di questo workflow dal computer che lo ha eseguito, invariate e in ordine, poi ricontrolla.",
      command: inspect,
    };
  }
  if (reason === "task_start_binding" || reason.startsWith(`${FINAL_RECEIPT_CHECK_PREFIX}proof.task_start_ref`)) {
    return {
      en: "Copy the story's task-start record from the computer that started the work, unchanged.",
      it: "Copia senza modifiche il record di avvio della story dal computer che ha iniziato il lavoro.",
      command: inspect,
    };
  }
  if (reason === `${FINAL_RECEIPT_CHECK_PREFIX}story_record_changed`) {
    const changedPath = firstChangedRecordPath(lifecycle) || "the changed record";
    return {
      en: `Restore ${changedPath} exactly as it was certified (for example from git history). A story's own records never change after its final certification.`,
      it: `Ripristina ${changedPath} esattamente com'era alla certificazione (per esempio dalla cronologia git). I record propri di una storia non cambiano dopo la certificazione finale.`,
      command: null,
    };
  }
  if (reason === `${FINAL_RECEIPT_CHECK_PREFIX}certified_commit_missing`) {
    return {
      en: "Fetch the base branch (git fetch) so the certified commit is available, then check again.",
      it: "Scarica il branch di base (git fetch) così il commit certificato è disponibile, poi ricontrolla.",
      command: null,
    };
  }
  if (reason === `${FINAL_RECEIPT_CHECK_PREFIX}certified_history_rewritten`) {
    return {
      en: "Restore the history that contains the certified commit; a rewritten history voids the certification.",
      it: "Ripristina la cronologia che contiene il commit certificato; una cronologia riscritta annulla la certificazione.",
      command: "trace verify",
    };
  }
  if (reason === `${FINAL_RECEIPT_CHECK_PREFIX}workflowFinalFreshnessProofMatches`) {
    return {
      en: "Files certified at closure changed before the delivery finished. Certify this story again on the current files, or restore them.",
      it: "I file certificati alla chiusura sono cambiati prima che la consegna finisse. Certifica di nuovo questa storia sui file attuali, oppure ripristinali.",
      command: null,
    };
  }
  if (lifecycle.source === "missing_workflow_final_receipt") {
    return {
      en: "Certify the finished workflow, or copy its final gate receipt from the computer that certified it.",
      it: "Certifica il workflow concluso, oppure copia la sua ricevuta finale dal computer che lo ha certificato.",
      command: null,
    };
  }
  return {
    en: "Inspect the story workflow and restore its records exactly as they were written.",
    it: "Controlla il workflow della story e ripristina i suoi record esattamente come sono stati scritti.",
    command: inspect,
  };
}
