import path from "node:path";
import {
  validateAssessmentWorkflowIntegrity,
} from "../assessment-workflow.mjs";
import {
  DomainValidationError,
  computeStableHash,
} from "../canonical.mjs";
import {
  UserError,
  fail,
} from "../cli/user-error.mjs";
import {
  CANONICAL_WORKFLOW_GUARD_CHECKS,
  WORKFLOW_CANONICAL_EVIDENCE_SCHEMA,
} from "../workflow-canonical-evidence.mjs";
import {
  replayWorkflowEvents,
  validateWorkflowCheckpoint,
  validateWorkflowDefinition,
  validateWorkflowOverlay,
} from "../workflow-engine.mjs";
import {
  assertSafeSdlcRelativeDirectory,
  getOptionString,
  normalizeId,
  shortHashFull,
  stableJson,
} from "./common.mjs";
import {
  SDLC_DIR,
  WORKFLOW_FINAL_GIT_SCOPE_SCHEMA,
  WORKFLOW_HASH_LIKE_VALUE,
  WORKFLOW_HUMAN_VALUE_LIMITS,
  WORKFLOW_ITALIAN_PRESENTATION,
  WORKFLOW_UNSAFE_UNICODE,
  WORKFLOW_UUID_LIKE_VALUE,
} from "./constants.mjs";
import {
  humanGuidanceLocale,
} from "./guidance.mjs";
import {
  assessmentsRoot,
  toProjectPath,
} from "./project.mjs";
import {
  configuredPhaseOrder,
} from "./story.mjs";

export function workflowsRoot(context) {
  return path.join(context.sdlcRoot, "workflows");
}

export function workflowDefinitionsRoot(context) {
  return path.join(workflowsRoot(context), "definitions");
}

export function workflowOverlaysRoot(context) {
  return path.join(workflowsRoot(context), "overlays");
}

export function workflowInstancesRoot(context) {
  return path.join(workflowsRoot(context), "instances");
}

export function workflowFinalGatesRoot(context) {
  return path.join(context.sdlcRoot, "gates");
}

export function workflowFinalGateReceiptPath(context, storyId) {
  return path.join(workflowFinalGatesRoot(context), `${normalizeId(storyId)}-final.json`);
}

export function workflowStrictGateReceiptPath(context, storyId) {
  return path.join(workflowFinalGatesRoot(context), `${normalizeId(storyId)}-strict.json`);
}

export function workflowFinalFreshnessRecordContains(value, ids) {
  if (typeof value === "string") return ids.has(value);
  if (Array.isArray(value)) {
    return value.some((item) => workflowFinalFreshnessRecordContains(item, ids));
  }
  if (!value || typeof value !== "object") return false;
  return Object.values(value)
    .some((item) => workflowFinalFreshnessRecordContains(item, ids));
}

export function workflowFinalFreshnessReferencedPaths(
  value,
  paths = new Set(),
  {
    field = null,
    scopeDeclaration = false,
  } = {},
) {
  const scopeFields = new Set([
    "allowed_write_paths",
    "kb_writes",
    "read_paths",
    "scope_paths",
    "write_paths",
  ]);
  if (typeof value === "string") {
    const pathField = field === "path"
      || field === "source_paths"
      || field === "evidence"
      || field === "evidence_paths"
      || String(field || "").endsWith("_path")
      || String(field || "").endsWith("_ref");
    if (
      !scopeDeclaration
      && pathField
      && value.startsWith(`${SDLC_DIR}/`)
    ) {
      paths.add(value);
    }
    return paths;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      workflowFinalFreshnessReferencedPaths(item, paths, {
        field,
        scopeDeclaration,
      });
    }
    return paths;
  }
  if (!value || typeof value !== "object") return paths;
  for (const [key, item] of Object.entries(value)) {
    workflowFinalFreshnessReferencedPaths(item, paths, {
      field: key,
      scopeDeclaration: scopeDeclaration || scopeFields.has(key),
    });
  }
  return paths;
}

export function workflowFinalGitArguments(context, args) {
  return ["--no-replace-objects", "-C", context.root, ...args];
}

export function workflowFinalMissingGitIdentity() {
  return {
    present: false,
    file_type: "missing",
    mode: null,
    content_sha256: null,
    object_id: null,
  };
}

export function workflowFinalGitObjectIdentity(mode, objectId, label) {
  let fileType;
  if (mode === "100644" || mode === "100755") {
    fileType = "regular";
  } else if (mode === "120000") {
    fileType = "symlink";
  } else {
    fail(`Final lifecycle freshness does not support ${label} Git mode ${mode}.`);
  }
  if (!/^[a-f0-9]{40,64}$/iu.test(String(objectId || ""))) {
    fail(`Final lifecycle freshness received an invalid Git object ID for ${label}.`);
  }
  return {
    present: true,
    file_type: fileType,
    mode: Number.parseInt(mode, 8) & 0o7777,
    content_sha256: null,
    object_id: String(objectId).toLowerCase(),
  };
}

export function workflowFinalGitLayerIdentityEqual(left, right) {
  return stableJson(left) === stableJson(right);
}

export function workflowFinalWorkingTreeIdentity(snapshot) {
  return {
    present: snapshot.file_type !== "missing",
    file_type: snapshot.file_type,
    mode: snapshot.mode,
    content_sha256: snapshot.content_sha256,
    object_id: null,
  };
}

export function sealWorkflowFinalFreshnessGitScope(observation) {
  const {
    observed_head_sha: certificationHeadSha,
    history_touched_paths: ignoredHistoryTouchedPaths,
    ...scope
  } = observation;
  return {
    ...scope,
    schema_version: WORKFLOW_FINAL_GIT_SCOPE_SCHEMA,
    certification_head_sha: certificationHeadSha,
  };
}

export function buildLegacyWorkflowStrictGateReceipt(report, strictReceiptPath) {
  const receipt = {
    ...report,
    kind: "workflow_strict_gate_receipt",
    schema_version: "workflow-strict-gate-receipt:v1",
    strict_receipt_path: strictReceiptPath,
    hash_algorithm: "sha256:stable-json:v1",
  };
  const {
    hash_algorithm: ignoredHashAlgorithm,
    receipt_hash: ignoredReceiptHash,
    ...subject
  } = receipt;
  return {
    ...receipt,
    receipt_hash: computeStableHash(subject),
  };
}

export function normalizeWorkflowVersion(value, optionName) {
  const normalized = String(value ?? "").trim();
  if (!/^[1-9][0-9]*$/u.test(normalized)) {
    fail(`Invalid --${optionName} '${value}'. Use a positive whole number, for example 1 or 2.`);
  }
  return normalized;
}

export function workflowDefinitionPath(context, id, version) {
  return path.join(
    workflowDefinitionsRoot(context),
    normalizeId(id),
    `v${normalizeWorkflowVersion(version, "definition-version")}.json`,
  );
}

export function workflowOverlayPath(context, id, version) {
  return path.join(
    workflowOverlaysRoot(context),
    normalizeId(id),
    `v${normalizeWorkflowVersion(version, "overlay-version")}.json`,
  );
}

export function workflowInstanceRoot(context, id) {
  return path.join(workflowInstancesRoot(context), normalizeId(id));
}

export function workflowInstancePath(context, id) {
  return path.join(workflowInstanceRoot(context, id), "instance.json");
}

export function workflowEventsPath(context, id) {
  return path.join(workflowInstanceRoot(context, id), "events.jsonl");
}

export function workflowCheckpointPath(context, id) {
  return path.join(workflowInstanceRoot(context, id), "checkpoint.json");
}

export function workflowPendingTransitionPath(context, id) {
  return path.join(workflowInstanceRoot(context, id), "pending-transition.json");
}

export function workflowInstanceCreationLockPath(context, id) {
  return path.join(workflowInstancesRoot(context), ".locks", `${normalizeId(id)}.lock`);
}

export function workflowInstanceStartTransactionsRoot(context) {
  return path.join(workflowInstancesRoot(context), ".starts");
}

export function workflowInstanceStartTransactionPath(context, id) {
  return path.join(workflowInstanceStartTransactionsRoot(context), `${normalizeId(id)}.json`);
}

export function workflowInstanceStagingRoot(context, id) {
  return path.join(workflowInstancesRoot(context), ".staging", normalizeId(id));
}

export function workflowVersionFromFileName(fileName) {
  const match = /^v(.+)\.json$/u.exec(fileName);
  return match ? match[1] : null;
}

export function compareWorkflowVersions(left, right) {
  return String(left).localeCompare(String(right), "en", { numeric: true, sensitivity: "base" });
}

export function assertWorkflowValidation(result, label) {
  if (result === true || result?.valid === true) return;
  const errors = Array.isArray(result) ? result : result?.errors;
  fail(`${label} is invalid: ${Array.isArray(errors) && errors.length > 0 ? errors.join("; ") : "validation failed"}`);
}

export function validateWorkflowDefinitionRecord(definition, label) {
  const result = callWorkflowDomain(`Unable to validate ${label}`, () => validateWorkflowDefinition(definition));
  assertWorkflowValidation(result, label);
}

export function validateWorkflowOverlayRecord(overlay, definition, label) {
  const result = callWorkflowDomain(`Unable to validate ${label}`, () => validateWorkflowOverlay(overlay, { definition }));
  assertWorkflowValidation(result, label);
}

export function workflowApprovalForDomain(approval) {
  return {
    id: approval.id,
    approved_at: approval.created_at,
    approved_by: approval.approved_by,
    approval_source: approval.approval_source,
    summary: approval.summary,
    evidence: approval.evidence,
    authorization_ref: approval.authorization_ref,
  };
}

export function callWorkflowDomain(label, callback) {
  try {
    return callback();
  } catch (error) {
    if (error instanceof UserError) throw error;
    const issues = error instanceof DomainValidationError && Array.isArray(error.issues)
      ? error.issues
          .filter((issue) => issue?.allowed !== true)
          .flatMap((issue) => {
            if (typeof issue === "string") return [issue];
            if (issue?.guard_id) {
              const guardIssues = Array.isArray(issue.issues)
                ? issue.issues.map((item) => String(item || "").trim()).filter(Boolean)
                : [];
              return guardIssues.length > 0
                ? guardIssues.map((item) => `${issue.guard_id}: ${item}`)
                : [`${issue.guard_id}: ${issue.reason || "guard denied"}`];
            }
            return [issue?.message || issue?.reason || null].filter(Boolean);
          })
          .filter(Boolean)
      : [];
    fail(
      [
        `${label}: ${error.message}`,
        ...issues.map((issue) => `- ${issue}`),
      ].join("\n"),
    );
  }
}

export function workflowDefinitionSummary(definition, source = "project") {
  return {
    id: definition.id,
    version: definition.version,
    status: definition.status,
    name: definition.name || definition.title || definition.label || definition.id,
    description: definition.description || definition.summary || null,
    initial_state: definition.initial_state,
    state_count: Array.isArray(definition.states) ? definition.states.length : Object.keys(definition.states || {}).length,
    transition_count: Array.isArray(definition.transitions) ? definition.transitions.length : 0,
    source,
    definition_hash: definition.definition_hash,
  };
}

export function humanizeWorkflowIdentifier(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  return text
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function workflowItalianPresentation(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replaceAll("_", "-")
    .replace(/\s+/gu, "-");
  return WORKFLOW_ITALIAN_PRESENTATION.get(normalized) || null;
}

export function workflowHumanDisplayIdentifier(value, key, italian) {
  if (value === undefined || value === null || String(value).trim() === "") return "";
  // Reuse the exact same fail-closed validation used for descriptive values,
  // then keep the familiar unquoted label used by the process summary.
  workflowHumanSafeValue(String(value), italian, { key });
  if (italian) {
    const localized = workflowItalianPresentation(value);
    if (localized) return localized;
  }
  return humanizeWorkflowIdentifier(value);
}

export function workflowHumanStateName(definition, stateId, italian = false) {
  const state = (Array.isArray(definition?.states) ? definition.states : [])
    .find((candidate) => (candidate?.id ?? candidate) === stateId);
  if (state?.id) workflowHumanDisplayIdentifier(state.id, "state_id", italian);
  return workflowHumanDisplayIdentifier(
    state?.label ?? state?.name ?? state?.title ?? state?.id ?? state ?? stateId,
    "state_label",
    italian,
  );
}

export function workflowHumanMainSequence(definition, italian) {
  if (Array.isArray(definition?.phase_order) && definition.phase_order.length > 0) {
    return definition.phase_order.map((stateId) => workflowHumanStateName(definition, stateId, italian));
  }
  const transitions = Array.isArray(definition?.transitions) ? definition.transitions : [];
  const stateIds = (Array.isArray(definition?.states) ? definition.states : [])
    .map((state) => state?.id ?? state)
    .filter(Boolean);
  if (!definition?.initial_state || transitions.length === 0) {
    return stateIds.map((stateId) => workflowHumanStateName(definition, stateId, italian));
  }
  const sequence = [definition.initial_state];
  const visited = new Set(sequence);
  let current = definition.initial_state;
  while (sequence.length <= stateIds.length) {
    const next = transitions.find((transition) => transition.from === current && !visited.has(transition.to));
    if (!next) break;
    sequence.push(next.to);
    visited.add(next.to);
    current = next.to;
  }
  return sequence.map((stateId) => workflowHumanStateName(definition, stateId, italian));
}

export function workflowHumanAllSteps(definition, italian) {
  return (definition?.states ?? []).map((state) => {
    const name = workflowHumanStateName(definition, state.id, italian);
    const roles = [];
    if (state.id === definition.initial_state) roles.push(italian ? "iniziale" : "starting");
    if (state.terminal === true) roles.push(italian ? "finale" : "final");
    return roles.length > 0 ? `${name} (${roles.join(", ")})` : name;
  });
}

export function failWorkflowHumanValue(reason, italian) {
  fail(italian
    ? `Il processo o adattamento non può essere approvato in modo completo e leggibile: ${reason}. Riduci o suddividi il contenuto, quindi riproponilo.`
    : `The process or adjustment cannot be reviewed completely and readably: ${reason}. Shorten or split the content, then propose it again.`);
}

export function workflowHumanKeyParts(key) {
  return String(key)
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

export function assertWorkflowHumanSafeCharacters(value, italian) {
  const text = String(value);
  if (WORKFLOW_UNSAFE_UNICODE.test(text) || [...text].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint >= 0xD800 && codePoint <= 0xDFFF;
  })) {
    failWorkflowHumanValue(italian
      ? "un testo contiene caratteri di controllo, direzione o invisibili non sicuri"
      : "text contains unsafe control, direction, or invisible characters", italian);
  }
}

export function workflowHumanSecretLikeKey(key) {
  const words = workflowHumanKeyParts(key).map((part) => part.toLowerCase());
  const joined = words.join(" ");
  return words.some((word) => ["secret", "password", "passwd", "credential", "credentials", "token", "cookie"].includes(word))
    || ["api key", "access key", "client secret", "private key"].some((phrase) => joined.includes(phrase));
}

export function workflowHumanHashLikeKey(key) {
  return workflowHumanKeyParts(key).some((part) => ["hash", "checksum", "digest"].includes(part.toLowerCase()));
}

export function workflowHumanMetadataLabel(key, italian) {
  assertWorkflowHumanSafeCharacters(key, italian);
  if (workflowHumanSecretLikeKey(key)) {
    failWorkflowHumanValue(italian
      ? "le informazioni descrittive contengono una chiave che potrebbe custodire un segreto"
      : "the descriptive information contains a key that could hold a secret", italian);
  }
  if (workflowHumanHashLikeKey(key)) {
    failWorkflowHumanValue(italian
      ? "un valore tecnico di verifica deve restare fuori dalle informazioni da approvare"
      : "a technical verification value must stay outside the information being approved", italian);
  }
  const italianExactLabels = new Map([
    ["normal_checkpoint_count", "Numero di momenti ordinari di conferma"],
    ["workflow_kind", "Tipo di processo"],
    ["phase_order", "Ordine dei passaggi"],
    ["retention_days", "Giorni di conservazione"],
    ["review_days", "Giorni per la revisione"],
    ["after_days", "Dopo quanti giorni"],
    ["audience", "Destinatari"], ["owners", "Responsabili"], ["owner", "Responsabile"],
    ["review_settings", "Impostazioni di revisione"], ["mode", "Modalità"],
    ["required", "Obbligatorio"], ["channels", "Canali"], ["policy", "Regole"],
    ["mandatory", "Obbligatorio"], ["regions", "Aree"], ["region", "Area"],
    ["approval_note", "Nota di approvazione"], ["team_authorized", "Autorizzazione del team"],
  ]);
  if (italian && italianExactLabels.has(String(key))) return italianExactLabels.get(String(key));
  const replacements = italian
    ? new Map([
        ["id", "Riferimento"], ["identifier", "Riferimento"], ["path", "Posizione"],
        ["workflow", "Processo"], ["overlay", "Adattamento"], ["definition", "Modello del processo"],
        ["checkpoint", "Momento di revisione"], ["schema", "Formato dei dati"],
        ["profile", "Scelta operativa"], ["receipt", "Prova"], ["metadata", "Informazioni"],
        ["order", "Ordine"], ["count", "Numero"], ["kind", "Tipo"],
      ])
    : new Map([
        ["id", "Reference"], ["identifier", "Reference"], ["path", "Location"],
        ["workflow", "Process"], ["overlay", "Adjustment"], ["definition", "Process model"],
        ["checkpoint", "Review moment"], ["schema", "Data format"],
        ["profile", "Working choice"], ["receipt", "Proof"], ["metadata", "Information"],
      ]);
  return workflowHumanKeyParts(key)
    .map((part) => replacements.get(part.toLowerCase()) ?? humanizeWorkflowIdentifier(part))
    .join(" ");
}

export function workflowHumanFriendlyString(value, key, italian) {
  assertWorkflowHumanSafeCharacters(value, italian);
  if (value.length > WORKFLOW_HUMAN_VALUE_LIMITS.textCharacters) {
    failWorkflowHumanValue(italian
      ? `un testo supera ${WORKFLOW_HUMAN_VALUE_LIMITS.textCharacters} caratteri`
      : `one text value exceeds ${WORKFLOW_HUMAN_VALUE_LIMITS.textCharacters} characters`, italian);
  }
  if (WORKFLOW_HASH_LIKE_VALUE.test(value) || WORKFLOW_UUID_LIKE_VALUE.test(value)) {
    failWorkflowHumanValue(italian
      ? "un riferimento tecnico non ha un nome comprensibile per la revisione umana"
      : "a technical reference has no human-readable name for review", italian);
  }
  if (/(?:^|\s)--[a-z]|(?:^|\s)(?:\.{0,2}|~)\/[A-Za-z0-9]|^[A-Za-z]:\\/iu.test(value)) {
    failWorkflowHumanValue(italian
      ? "un comando o una posizione tecnica è stato inserito nelle informazioni descrittive"
      : "a command or technical location was placed in the descriptive information", italian);
  }
  const italianExactCopy = new Map([
    ["Software project governed workflow preset.", "Processo governato predefinito per un progetto software."],
    ["Change request governed workflow preset.", "Processo governato predefinito per una richiesta di modifica."],
    ["Technical assessment governed workflow preset.", "Processo governato predefinito per una valutazione tecnica."],
    ["Generic governed process governed workflow preset.", "Processo governato generico predefinito."],
  ]);
  const presentationValue = (italian ? italianExactCopy.get(value) : null)
    ?? (italian ? workflowItalianPresentation(value) : null)
    ?? value;
  const identifierKey = workflowHumanKeyParts(key).some((part) => ["id", "identifier"].includes(part.toLowerCase()));
  const identifierValue = /^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)+$/u.test(value);
  let friendly = presentationValue === value && (identifierKey || identifierValue)
    ? humanizeWorkflowIdentifier(value)
    : presentationValue;
  const contentIsItalian = /\b(?:il|lo|la|gli|le|un|una|di|del|della|per|con|senza|approvazione|revisione)\b/iu.test(value);
  const vocabulary = italian || contentIsItalian
    ? [
        [/\bbounded[-_ ]autonomous\b/giu, "completamento entro i limiti approvati"],
        [/\bcheckpointed\b/giu, "avanzamento tra i momenti di revisione concordati"],
        [/\baudit[-_ ]only\b/giu, "approvazione registrata ma non verificata esternamente"],
        [/\bworkflow\b/giu, "processo"], [/\boverlay\b/giu, "adattamento"],
        [/\bdefinition\b/giu, "modello del processo"], [/\bcheckpoint\b/giu, "momento di revisione"],
        [/\bschema\b/giu, "formato dei dati"], [/\bprofile\b/giu, "scelta operativa"],
        [/\breceipt\b/giu, "prova"],
      ]
    : [
        [/\bbounded[-_ ]autonomous\b/giu, "completion within the approved limits"],
        [/\bcheckpointed\b/giu, "progress between the agreed review moments"],
        [/\baudit[-_ ]only\b/giu, "approval recorded but not externally verified"],
        [/\bworkflow\b/giu, "process"], [/\boverlay\b/giu, "adjustment"],
        [/\bdefinition\b/giu, "process model"], [/\bcheckpoint\b/giu, "review moment"],
        [/\bschema\b/giu, "data format"], [/\bprofile\b/giu, "working choice"],
        [/\breceipt\b/giu, "proof"],
      ];
  for (const [pattern, replacement] of vocabulary) friendly = friendly.replace(pattern, replacement);
  const escaped = friendly
    .replaceAll("\\", "\\\\")
    .replaceAll("“", "\\“")
    .replaceAll("”", "\\”");
  return `“${escaped}”`;
}

export function workflowHumanSafeValue(value, italian, { key = "value", depth = 0 } = {}) {
  if (depth > WORKFLOW_HUMAN_VALUE_LIMITS.nestingLevels) {
    failWorkflowHumanValue(italian
      ? `un valore supera ${WORKFLOW_HUMAN_VALUE_LIMITS.nestingLevels} livelli di dettaglio`
      : `one value exceeds ${WORKFLOW_HUMAN_VALUE_LIMITS.nestingLevels} levels of detail`, italian);
  }
  if (typeof value === "string") return workflowHumanFriendlyString(value, key, italian);
  if (value === null) return italian ? "vuoto" : "empty";
  if (value === true) return italian ? "sì" : "yes";
  if (value === false) return "no";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : (italian ? "numero non valido" : "invalid number");
  if (Array.isArray(value)) {
    if (value.length > WORKFLOW_HUMAN_VALUE_LIMITS.collectionItems) {
      failWorkflowHumanValue(italian
        ? `un elenco contiene più di ${WORKFLOW_HUMAN_VALUE_LIMITS.collectionItems} valori`
        : `one list contains more than ${WORKFLOW_HUMAN_VALUE_LIMITS.collectionItems} values`, italian);
    }
    const items = value.map((item) => workflowHumanSafeValue(item, italian, { key, depth: depth + 1 }));
    return `${italian ? "elenco" : "list"} (${items.join(", ")})`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length > WORKFLOW_HUMAN_VALUE_LIMITS.collectionItems) {
      failWorkflowHumanValue(italian
        ? `un gruppo contiene più di ${WORKFLOW_HUMAN_VALUE_LIMITS.collectionItems} valori`
        : `one group contains more than ${WORKFLOW_HUMAN_VALUE_LIMITS.collectionItems} values`, italian);
    }
    const rendered = entries.map(([nestedKey, nestedValue]) =>
      `${workflowHumanMetadataLabel(nestedKey, italian)} = ${workflowHumanSafeValue(nestedValue, italian, { key: nestedKey, depth: depth + 1 })}`);
    return `${italian ? "dettagli" : "details"} (${rendered.join("; ")})`;
  }
  failWorkflowHumanValue(italian ? "un valore non è descrivibile" : "one value cannot be described", italian);
}

export function workflowHumanValuesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function workflowHumanMetadataChanges(before, after, patch, italian) {
  const entries = Object.entries(patch ?? {});
  if (entries.length > WORKFLOW_HUMAN_VALUE_LIMITS.collectionItems) {
    failWorkflowHumanValue(italian
      ? `un gruppo contiene più di ${WORKFLOW_HUMAN_VALUE_LIMITS.collectionItems} modifiche`
      : `one group contains more than ${WORKFLOW_HUMAN_VALUE_LIMITS.collectionItems} changes`, italian);
  }
  return entries.flatMap(([key, requestedValue]) => {
    const nextValue = Object.hasOwn(after ?? {}, key) ? after[key] : requestedValue;
    const hadPrevious = Object.hasOwn(before ?? {}, key);
    if (hadPrevious && workflowHumanValuesEqual(before[key], nextValue)) return [];
    const label = workflowHumanMetadataLabel(key, italian);
    const next = workflowHumanSafeValue(nextValue, italian, { key });
    if (!hadPrevious) return [italian ? `${label} viene impostato su ${next}` : `${label} is set to ${next}`];
    const previous = workflowHumanSafeValue(before[key], italian, { key });
    return [italian ? `${label} cambia da ${previous} a ${next}` : `${label} changes from ${previous} to ${next}`];
  });
}

export function workflowHumanMetadataDifference(scope, before, after, patch, italian) {
  const changes = workflowHumanMetadataChanges(before, after, patch, italian);
  if (changes.length === 0) return null;
  return italian ? `${scope}: ${changes.join("; ")}` : `${scope}: ${changes.join("; ")}`;
}

export function workflowHumanDefinitionDetails(definition, italian) {
  const details = [];
  const name = definition?.label ?? definition?.name ?? definition?.title;
  if (name) {
    details.push(italian
      ? `nome mostrato: ${workflowHumanSafeValue(name, italian, { key: "name" })}`
      : `displayed name: ${workflowHumanSafeValue(name, italian, { key: "name" })}`);
  }
  if (definition?.description) {
    details.push(italian
      ? `scopo: ${workflowHumanSafeValue(definition.description, italian, { key: "description" })}`
      : `purpose: ${workflowHumanSafeValue(definition.description, italian, { key: "description" })}`);
  }
  const general = workflowHumanMetadataDifference(
    italian ? "informazioni generali" : "general information",
    {}, definition?.metadata, definition?.metadata, italian,
  );
  if (general) details.push(general);
  for (const state of definition?.states ?? []) {
    const stateName = workflowHumanStateName(definition, state.id, italian);
    if (state.description) {
      details.push(italian
        ? `descrizione del passaggio “${stateName}”: ${workflowHumanSafeValue(state.description, italian, { key: "description" })}`
        : `description of the “${stateName}” step: ${workflowHumanSafeValue(state.description, italian, { key: "description" })}`);
    }
    const metadata = workflowHumanMetadataDifference(
      italian ? `informazioni del passaggio “${stateName}”` : `information for the “${stateName}” step`,
      {}, state.metadata, state.metadata, italian,
    );
    if (metadata) details.push(metadata);
  }
  for (const transition of definition?.transitions ?? []) {
    const from = workflowHumanStateName(definition, transition.from, italian);
    const to = workflowHumanStateName(definition, transition.to, italian);
    if (transition.description) {
      details.push(italian
        ? `descrizione del collegamento da “${from}” a “${to}”: ${workflowHumanSafeValue(transition.description, italian, { key: "description" })}`
        : `description of the route from “${from}” to “${to}”: ${workflowHumanSafeValue(transition.description, italian, { key: "description" })}`);
    }
    const metadata = workflowHumanMetadataDifference(
      italian ? `informazioni del collegamento da “${from}” a “${to}”` : `information for the route from “${from}” to “${to}”`,
      {}, transition.metadata, transition.metadata, italian,
    );
    if (metadata) details.push(metadata);
  }
  return details;
}

export function workflowDefinitionRef(definition) {
  return {
    id: definition.id,
    version: definition.version,
    definition_hash: definition.definition_hash,
  };
}

export function workflowOverlayChanges(overlay) {
  if (Array.isArray(overlay.operations)) return overlay.operations;
  if (Array.isArray(overlay.changes)) return overlay.changes;
  if (overlay.patch && typeof overlay.patch === "object") {
    return Object.keys(overlay.patch).sort().map((field) => ({ field, value: overlay.patch[field] }));
  }
  const ignored = new Set([
    "id", "version", "status", "schema_version", "kind", "definition_ref", "base_definition_ref",
    "overlay_hash", "hash_algorithm", "approval", "created_at", "updated_at", "summary",
  ]);
  return Object.entries(overlay)
    .filter(([key]) => !ignored.has(key))
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([field, value]) => ({ field, value }));
}

export function workflowDefinitionUsesCanonicalEvidence(definition) {
  return (definition?.transitions || []).some((transition) =>
    (transition?.guards || []).some((guard) =>
      Object.hasOwn(CANONICAL_WORKFLOW_GUARD_CHECKS, guard?.id)));
}

export function workflowPhaseOrderDifference(context, definition) {
  const configured = configuredPhaseOrder(context);
  const selected = Array.isArray(definition?.phase_order)
    ? definition.phase_order.map((phase) => String(phase))
    : [];
  const exact = configured.length === selected.length
    && configured.every((phase, index) => phase === selected[index]);
  return {
    exact,
    configured,
    selected,
    missing: configured.filter((phase) => !selected.includes(phase)),
    extra: selected.filter((phase) => !configured.includes(phase)),
  };
}

export function assertStoryBoundWorkflowPhaseOrder(context, definition) {
  const difference = workflowPhaseOrderDifference(context, definition);
  if (difference.exact) return;
  const details = [
    `configured phase order: ${difference.configured.join(", ")}`,
    `workflow phase order: ${difference.selected.join(", ") || "(empty)"}`,
    ...(difference.missing.length > 0
      ? [`missing configured phases: ${difference.missing.join(", ")}`]
      : []),
    ...(difference.extra.length > 0
      ? [`unconfigured workflow phases: ${difference.extra.join(", ")}`]
      : []),
  ];
  fail(
    "A story-bound workflow must use the exact configured phase order; "
    + `${details.join("; ")}.`,
  );
}

export function workflowTransitionJournalHash(journal) {
  const { transaction_hash: _transactionHash, ...hashInput } = journal;
  return computeStableHash(hashInput);
}

export function buildWorkflowStartTraceRecord(context, instance, definition, overlayEntry, attribution, paths) {
  const workflowStoryId =
    instance.metadata?.governance_binding?.story_id || null;
  return {
    id: `TR-WF-START-${instance.instance_hash.slice(0, 24)}`,
    story_id: null,
    workflow_story_id: workflowStoryId,
    type: "implementation",
    summary: `Started workflow instance ${instance.id}`,
    outcome: "ready",
    actor: attribution.actor,
    requested_by: null,
    authorized_by: null,
    request: null,
    authorization_ref: null,
    action: "workflow.instance.start",
    evidence: paths.map((filePath) => toProjectPath(context, filePath)),
    related: [
      instance.id,
      definition.id,
      ...(overlayEntry ? [overlayEntry.record.id] : []),
      ...(workflowStoryId ? [workflowStoryId] : []),
    ],
    git: attribution.git,
    run: attribution.run,
    created_at: instance.created_at,
  };
}

export function extendWorkflowTraceChain(previousTraceChainHash, traceEvent) {
  if (
    previousTraceChainHash !== null
    && (typeof previousTraceChainHash !== "string" || !/^[a-f0-9]{64}$/u.test(previousTraceChainHash))
  ) {
    fail("Workflow trace chain has an invalid previous digest.");
  }
  return computeStableHash({
    previous_trace_chain_hash: previousTraceChainHash,
    trace_event: workflowTraceIntent(traceEvent),
  });
}

export function workflowTraceIntent(traceEvent) {
  if (!traceEvent || typeof traceEvent !== "object" || Array.isArray(traceEvent)) return traceEvent;
  const { _trace_integrity: _integrityEnvelope, ...intent } = traceEvent;
  return intent;
}

export function workflowTraceIntentMatches(storedEvent, expectedIntent) {
  return stableJson(workflowTraceIntent(storedEvent)) === stableJson(workflowTraceIntent(expectedIntent));
}

export function workflowStartRequestHash(request) {
  const { intent_hash: _intentHash, ...hashInput } = request;
  return computeStableHash(hashInput);
}

export function buildWorkflowStartRequest(
  id,
  definition,
  overlayEntry,
  effectiveDefinition,
  actor,
  summary,
  governanceBinding = null,
) {
  const request = {
    instance_id: id,
    definition_ref: workflowDefinitionRef(definition),
    overlay_ref: overlayEntry
      ? {
          id: overlayEntry.record.id,
          version: overlayEntry.record.version,
          hash: overlayEntry.record.overlay_hash,
        }
      : null,
    effective_hash: effectiveDefinition.effective_hash,
    actor,
    summary: summary || null,
    ...(governanceBinding ? { governance_binding: governanceBinding } : {}),
  };
  return { ...request, intent_hash: workflowStartRequestHash(request) };
}

export function workflowStartTransactionHash(journal) {
  const { transaction_hash: _TransactionHash, ...hashInput } = journal;
  return computeStableHash(hashInput);
}

export function buildWorkflowStartTransaction({ request, instance, checkpoint, trace_event, trace_anchor }) {
  const journal = {
    kind: "workflow_instance_start_transaction",
    schema_version: "workflow-instance-start-transaction:v1",
    request,
    instance,
    checkpoint,
    trace_event,
    trace_anchor,
  };
  return { ...journal, transaction_hash: workflowStartTransactionHash(journal) };
}

export function workflowTraceAnchorErrors(anchor) {
  const errors = [];
  if (!anchor || typeof anchor !== "object" || Array.isArray(anchor)) {
    return ["trace anchor must be an object"];
  }
  const unknown = Object.keys(anchor).filter((key) => !["size_bytes", "prefix_hash"].includes(key));
  if (unknown.length > 0) errors.push(`trace anchor has unsupported fields: ${unknown.join(", ")}`);
  if (!Number.isSafeInteger(anchor.size_bytes) || anchor.size_bytes < 0) {
    errors.push("trace anchor size must be a non-negative whole number");
  }
  if (typeof anchor.prefix_hash !== "string" || !/^[a-f0-9]{64}$/u.test(anchor.prefix_hash)) {
    errors.push("trace anchor prefix hash is invalid");
  }
  return errors;
}

export function workflowStartTransactionErrors(journal, expectedRequest, effectiveDefinition) {
  const errors = [];
  if (!journal || typeof journal !== "object" || Array.isArray(journal)) {
    return ["start transaction must be a JSON object"];
  }
  const allowedKeys = new Set([
    "kind", "schema_version", "request", "instance", "checkpoint", "trace_event", "trace_anchor", "transaction_hash",
  ]);
  const unknown = Object.keys(journal).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) errors.push(`start transaction has unsupported fields: ${unknown.join(", ")}`);
  if (
    journal.kind !== "workflow_instance_start_transaction"
    || journal.schema_version !== "workflow-instance-start-transaction:v1"
  ) {
    errors.push("start transaction has an unsupported format");
  }
  if (stableJson(journal.request) !== stableJson(expectedRequest)) {
    errors.push("start intent differs from the interrupted request");
  }
  if (journal.request?.intent_hash !== workflowStartRequestHash(journal.request || {})) {
    errors.push("start intent hash does not match its content");
  }
  if (journal.transaction_hash !== workflowStartTransactionHash(journal)) {
    errors.push("start transaction hash does not match its content");
  }
  errors.push(...workflowTraceAnchorErrors(journal.trace_anchor));
  if (
    journal.instance?.id !== expectedRequest.instance_id
    || journal.instance?.effective_hash !== effectiveDefinition.effective_hash
  ) {
    errors.push("start transaction instance does not match the requested process");
  }
  if (
    stableJson(journal.instance?.metadata?.governance_binding || null)
    !== stableJson(expectedRequest.governance_binding || null)
  ) {
    errors.push("start transaction story binding does not match its immutable instance");
  }
  try {
    const checkpointValidation = validateWorkflowCheckpoint(journal.checkpoint, {
      instance: journal.instance,
      effective_definition: effectiveDefinition,
    });
    if (checkpointValidation?.valid !== true) {
      errors.push(...(checkpointValidation?.errors || ["start checkpoint is invalid"]));
    }
    const replay = replayWorkflowEvents({
      instance: journal.instance,
      effective_definition: effectiveDefinition,
      events: [],
      checkpoint: journal.checkpoint,
    }, { require_checkpoint: true });
    if (replay?.valid !== true) errors.push(...(replay?.errors || ["empty start history is invalid"]));
  } catch (error) {
    errors.push(`start checkpoint cannot be validated: ${error.message}`);
  }
  if (
    journal.trace_event?.id !== `TR-WF-START-${String(journal.instance?.instance_hash || "").slice(0, 24)}`
    || journal.trace_event?.action !== "workflow.instance.start"
    || journal.trace_event?.created_at !== journal.instance?.created_at
    || !Array.isArray(journal.trace_event?.related)
    || journal.trace_event.related[0] !== expectedRequest.instance_id
  ) {
    errors.push("start trace intent does not describe the pinned instance");
  }
  const expectedStoryId = expectedRequest.governance_binding?.story_id || null;
  const expectedRelated = [
    expectedRequest.instance_id,
    expectedRequest.definition_ref?.id,
    ...(expectedRequest.overlay_ref?.id ? [expectedRequest.overlay_ref.id] : []),
    ...(expectedStoryId ? [expectedStoryId] : []),
  ];
  if (
    stableJson(journal.trace_event?.related || []) !== stableJson(expectedRelated)
    || (
      journal.trace_event?.workflow_story_id !== undefined
      && (journal.trace_event.workflow_story_id || null) !== expectedStoryId
    )
  ) {
    errors.push("start trace intent does not match the immutable definition, overlay, and story binding");
  }
  try {
    if (journal.checkpoint?.trace_chain_hash !== extendWorkflowTraceChain(null, journal.trace_event)) {
      errors.push("start checkpoint does not bind the complete start trace");
    }
  } catch {
    errors.push("start checkpoint trace binding cannot be validated");
  }
  return Array.from(new Set(errors));
}

export function buildWorkflowTransitionTraceRecord(context, instanceId, targetState, event, attribution, summary) {
  return {
    id: `TR-WF-${event.event_hash}`,
    story_id: null,
    type: "implementation",
    summary: summary || `Transitioned workflow instance ${instanceId} to ${targetState}`,
    outcome: "passed",
    actor: attribution.actor,
    requested_by: null,
    authorized_by: null,
    request: null,
    authorization_ref: null,
    action: "workflow.instance.transition",
    evidence: [
      toProjectPath(context, workflowEventsPath(context, instanceId)),
      toProjectPath(context, workflowCheckpointPath(context, instanceId)),
    ],
    related: [instanceId, event.event_hash],
    git: attribution.git,
    run: attribution.run,
    created_at: event.timestamp,
  };
}

export function buildWorkflowTransitionJournal(
  instance,
  priorCheckpoint,
  event,
  nextCheckpoint,
  traceEvent,
  eventAnchor,
  traceAnchor,
) {
  const journal = {
    kind: "workflow_transition_transaction",
    schema_version: "workflow-transition-transaction:v1",
    instance_id: instance.id,
    instance_hash: instance.instance_hash,
    effective_hash: event.effective_hash,
    from_sequence: priorCheckpoint.sequence,
    from_checkpoint_hash: priorCheckpoint.checkpoint_hash,
    from_trace_chain_hash: priorCheckpoint.trace_chain_hash,
    event,
    checkpoint: nextCheckpoint,
    event_anchor: eventAnchor,
    trace_event: traceEvent,
    trace_anchor: traceAnchor,
    hash_algorithm: priorCheckpoint.hash_algorithm,
  };
  return { ...journal, transaction_hash: workflowTransitionJournalHash(journal) };
}

export function workflowTransitionJournalErrors(journal, instance, effectiveDefinition, expected = {}) {
  const errors = [];
  if (!journal || typeof journal !== "object" || Array.isArray(journal)) {
    return ["pending workflow transition must be a JSON object"];
  }
  const allowedKeys = new Set([
    "kind", "schema_version", "instance_id", "instance_hash", "effective_hash", "from_sequence",
    "from_checkpoint_hash", "from_trace_chain_hash", "event", "checkpoint", "event_anchor", "trace_event", "trace_anchor",
    "hash_algorithm", "transaction_hash",
  ]);
  const unknownKeys = Object.keys(journal).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) errors.push(`pending workflow transition has unsupported fields: ${unknownKeys.join(", ")}`);
  if (journal.kind !== "workflow_transition_transaction" || journal.schema_version !== "workflow-transition-transaction:v1") {
    errors.push("pending workflow transition has an unsupported format");
  }
  if (journal.instance_id !== instance.id || journal.instance_hash !== instance.instance_hash) {
    errors.push("pending workflow transition does not belong to this instance");
  }
  if (journal.effective_hash !== effectiveDefinition.effective_hash) {
    errors.push("pending workflow transition does not match the pinned workflow definition");
  }
  if (!Number.isSafeInteger(journal.from_sequence) || journal.from_sequence < 0) {
    errors.push("pending workflow transition has an invalid starting sequence");
  }
  if (typeof journal.from_checkpoint_hash !== "string" || !/^[a-f0-9]{64}$/u.test(journal.from_checkpoint_hash)) {
    errors.push("pending workflow transition has an invalid starting checkpoint hash");
  }
  if (typeof journal.from_trace_chain_hash !== "string" || !/^[a-f0-9]{64}$/u.test(journal.from_trace_chain_hash)) {
    errors.push("pending workflow transition has an invalid starting trace-chain hash");
  }
  if (typeof journal.transaction_hash !== "string" || journal.transaction_hash !== workflowTransitionJournalHash(journal)) {
    errors.push("pending workflow transition hash does not match its content");
  }
  if (journal.hash_algorithm !== "sha256:stable-json:v1") {
    errors.push("pending workflow transition hash algorithm is invalid");
  }
  if (!journal.event || typeof journal.event !== "object" || Array.isArray(journal.event)) {
    errors.push("pending workflow transition is missing its event");
  }
  if (!journal.checkpoint || typeof journal.checkpoint !== "object" || Array.isArray(journal.checkpoint)) {
    errors.push("pending workflow transition is missing its final checkpoint");
  }
  if (!journal.trace_event || typeof journal.trace_event !== "object" || Array.isArray(journal.trace_event)) {
    errors.push("pending workflow transition is missing its trace intent");
  }
  errors.push(...workflowTraceAnchorErrors(journal.event_anchor).map((error) => `event ${error}`));
  errors.push(...workflowTraceAnchorErrors(journal.trace_anchor).map((error) => `trace ${error}`));
  if (journal.event) {
    if (journal.event.instance_id !== instance.id || journal.event.instance_hash !== instance.instance_hash) {
      errors.push("pending workflow event does not belong to this instance");
    }
    if (journal.event.effective_hash !== effectiveDefinition.effective_hash) {
      errors.push("pending workflow event does not match the pinned workflow definition");
    }
    if (journal.event.sequence !== journal.from_sequence + 1) {
      errors.push("pending workflow event does not immediately follow the starting sequence");
    }
    if (expected.requestId && journal.event.idempotency_key !== expected.requestId) {
      errors.push("pending workflow transition belongs to a different request");
    }
    if (expected.targetState && journal.event.to !== expected.targetState) {
      errors.push("pending workflow transition targets a different state");
    }
  }
  if (journal.checkpoint && journal.event) {
    if (
      journal.checkpoint.sequence !== journal.event.sequence
      || journal.checkpoint.last_event_hash !== journal.event.event_hash
      || journal.checkpoint.current_state !== journal.event.to
      || journal.checkpoint.updated_at !== journal.event.timestamp
    ) {
      errors.push("pending workflow final checkpoint does not describe its event");
    }
    const checkpointValidation = validateWorkflowCheckpoint(journal.checkpoint, {
      instance,
      effective_definition: effectiveDefinition,
    });
    if (checkpointValidation?.valid !== true) errors.push(...(checkpointValidation?.errors || ["pending workflow final checkpoint is invalid"]));
  }
  if (journal.trace_event && journal.event) {
    if (
      journal.trace_event.id !== `TR-WF-${String(journal.event.event_hash || "")}`
      || journal.trace_event.action !== "workflow.instance.transition"
      || journal.trace_event.created_at !== journal.event.timestamp
      || !Array.isArray(journal.trace_event.related)
      || journal.trace_event.related[0] !== instance.id
      || journal.trace_event.related[1] !== journal.event.event_hash
    ) {
      errors.push("pending workflow trace intent does not describe its event");
    }
    try {
      if (
        journal.checkpoint?.trace_chain_hash
        !== extendWorkflowTraceChain(journal.from_trace_chain_hash, journal.trace_event)
      ) {
        errors.push("pending workflow checkpoint does not bind the complete transition trace");
      }
    } catch {
      errors.push("pending workflow checkpoint trace binding cannot be validated");
    }
  }
  return errors;
}

export function workflowIntegrityBlockedGuidance(options, integrity = {}) {
  const italian = humanGuidanceLocale(options) === "it";
  if (integrity.recovery_available === true) {
    const destination = integrity.recovery_target_state
      ? workflowHumanDisplayIdentifier(integrity.recovery_target_state, "state_id", italian)
      : (italian ? "già indicata" : "already shown");
    return italian
      ? {
          result: "Un avanzamento è stato interrotto prima di completare tutte le registrazioni, quindi l’esecuzione è ferma in sicurezza.",
          impact: "Lo stato non viene dichiarato valido e questa consultazione non modifica alcun file.",
          required_decision: "Non serve una nuova approvazione e non devi ripristinare file manualmente.",
          protection_boundary: "Per completare le registrazioni mancanti devi ripetere lo stesso avanzamento verso la stessa destinazione; un avanzamento diverso resta bloccato.",
          next_action: `Ripeti lo stesso avanzamento verso “${destination}”; il sistema verificherà e completerà una sola volta ciò che manca.`,
          details: {},
        }
      : {
          result: "A transition stopped before all records were completed, so the run is safely paused.",
          impact: "No state is declared valid, and this status check changes no file.",
          required_decision: "No new approval is needed, and you should not restore files manually.",
          protection_boundary: "To complete the missing records, repeat the same transition toward the same destination; a different transition remains blocked.",
          next_action: `Repeat the same transition toward “${destination}”; the system will verify it and complete each missing record once.`,
          details: {},
        };
  }
  return italian
    ? {
        result: "La cronologia registrata non è affidabile, quindi questa esecuzione è stata fermata in sicurezza.",
        impact: "Lo stato corrente non viene dichiarato valido e non viene proposto alcun passaggio successivo.",
        required_decision: "Non approvare né ripetere avanzamenti finché la cronologia non è stata ripristinata.",
        protection_boundary: "Nessun nuovo evento è stato registrato e i permessi già concordati restano invariati.",
        next_action: "Ripristina i file originali dell’esecuzione da una copia attendibile, quindi ripeti il controllo.",
        details: {},
      }
    : {
        result: "The recorded history cannot be trusted, so this run was stopped safely.",
        impact: "No current state is declared valid, and no next step is offered.",
        required_decision: "Do not approve or retry progress until the recorded history has been restored.",
        protection_boundary: "No new event was recorded, and the already agreed permissions remain unchanged.",
        next_action: "Restore the run’s original files from a trusted copy, then run the check again.",
        details: {},
      };
}

export function workflowIdempotentGuidance(options) {
  const italian = humanGuidanceLocale(options) === "it";
  return italian
    ? {
        result: "Questa richiesta era già stata applicata; non è stato apportato alcun cambiamento.",
        impact: "L’esecuzione resta allo stesso passo e non è stata aggiunta una nuova voce alla cronologia.",
        required_decision: "Non devi decidere nulla per questo nuovo tentativo.",
        protection_boundary: "Nessun permesso è stato ampliato e nessuna azione esterna è stata autorizzata.",
        next_action: "Consulta lo stato corrente e continua solo con un passaggio successivo consentito.",
        details: {},
      }
    : {
        result: "This request had already been applied; no change was made.",
        impact: "The run remains at the same step, and no new history entry was added.",
        required_decision: "You do not need to decide anything for this retry.",
        protection_boundary: "No permission was widened, and no external action was authorized.",
        next_action: "Review the current status and continue only with a permitted next step.",
        details: {},
      };
}

export function parseWorkflowGuardContext(options) {
  const raw = getOptionString(options, "guard-input-json");
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("--guard-input-json must contain one JSON object.");
    return parsed;
  } catch (error) {
    if (error instanceof UserError) throw error;
    fail(`Unable to read --guard-input-json: ${error.message}`);
  }
}

export function workflowTransitionUsesCanonicalEvidence(effectiveDefinition, currentState, targetState) {
  const transition = (effectiveDefinition?.transitions || []).find((candidate) =>
    candidate.from === currentState && candidate.to === targetState);
  return (transition?.guards || []).some((guard) =>
    Object.hasOwn(CANONICAL_WORKFLOW_GUARD_CHECKS, guard?.id));
}

export function workflowTransitionUsesStrictGate(effectiveDefinition, currentState, targetState) {
  const transition = (effectiveDefinition?.transitions || []).find((candidate) =>
    candidate.from === currentState && candidate.to === targetState);
  return (transition?.guards || []).some((guard) =>
    guard?.id === "strict-gate-passed");
}

export function workflowTargetUsesStrictGate(effectiveDefinition, targetState) {
  return (effectiveDefinition?.transitions || []).some((transition) =>
    transition.to === targetState
    && (transition.guards || []).some((guard) =>
      guard?.id === "strict-gate-passed"));
}

export function workflowRequiresCurrentPhaseCompletion(instance, effectiveDefinition) {
  return Boolean(instance?.metadata?.governance_binding?.story_id)
    && effectiveDefinition?.metadata?.canonical_evidence_schema
      === WORKFLOW_CANONICAL_EVIDENCE_SCHEMA;
}

export function workflowCurrentPhaseEntryAt(instance, events, currentState) {
  let enteredAt = currentState === instance.initial_state
    ? instance.created_at
    : null;
  for (const event of events || []) {
    if (event?.to === currentState) {
      enteredAt = event.timestamp;
    }
  }
  return Number.isFinite(Date.parse(String(enteredAt || "")))
    ? enteredAt
    : null;
}

export function workflowScopeFromRuntime(instance, effectiveDefinition, integrity, currentPhase) {
  const checkpoint = integrity?.checkpoint;
  if (!checkpoint) {
    fail(`Workflow instance ${instance?.id || "unknown"} has no durable integrity checkpoint.`);
  }
  return {
    instance_id: instance.id,
    instance_hash: instance.instance_hash,
    effective_hash: effectiveDefinition.effective_hash,
    story_id: instance.metadata?.governance_binding?.story_id,
    current_phase: currentPhase,
    phase_order: effectiveDefinition.phase_order,
    checkpoint_ref: {
      checkpoint_hash: checkpoint.checkpoint_hash,
      sequence: checkpoint.sequence,
      last_event_hash: checkpoint.last_event_hash,
      trace_chain_hash: checkpoint.trace_chain_hash,
      updated_at: checkpoint.updated_at,
    },
  };
}

export function workflowCurrentState(replay, instance, definition) {
  return replay.current_state || replay.state || replay.status?.current_state || instance.current_state || definition.initial_state;
}

export function workflowNextStates(definition, currentState) {
  return (definition.transitions || [])
    .filter((transition) => transition.from === currentState)
    .map((transition) => transition.to)
    .filter((state, index, all) => all.indexOf(state) === index)
    .sort((left, right) => String(left).localeCompare(String(right), "en"));
}

export function assessmentWorkflowDirectory(context, key, fallback) {
  const configured = context.config.assessment_workflow?.paths?.[key] || fallback;
  assertSafeSdlcRelativeDirectory(configured, `assessment_workflow.paths.${key}`);
  return path.join(assessmentsRoot(context), configured);
}

export function assessmentWorkflowsRoot(context) {
  return assessmentWorkflowDirectory(context, "workflows", "workflows");
}

export function assessmentWorkflowPath(context, id) {
  return path.join(assessmentWorkflowsRoot(context), `${normalizeId(id)}.json`);
}

export function workflowExecutionStartedAt(workflow) {
  return (workflow?.history || []).find((entry) => entry.to === "running")?.at || null;
}

export function rewindInterruptedCompletedWorkflow(workflow) {
  const integrity = validateAssessmentWorkflowIntegrity(workflow);
  if (!integrity.valid || workflow.state !== "completed") {
    fail(`Cannot rewind assessment workflow recovery state: ${integrity.errors.join("; ") || workflow.state}.`);
  }
  const history = [...workflow.history];
  const completedEntry = history.at(-1);
  if (!completedEntry || completedEntry.to !== "completed") {
    fail("Completed assessment workflow has no terminal completion transition to recover from.");
  }
  history.pop();
  const { workflow_hash: _hash, hash_algorithm: _algorithm, ...base } = workflow;
  const recovered = {
    ...base,
    state: completedEntry.from,
    revision: history.length,
    terminal: false,
    updated_at: history.at(-1)?.at || workflow.created_at,
    history,
  };
  recovered.workflow_hash = shortHashFull(stableJson(recovered));
  recovered.hash_algorithm = "sha256:stable-json:v1";
  const recoveredIntegrity = validateAssessmentWorkflowIntegrity(recovered);
  if (!recoveredIntegrity.valid) {
    fail(`Cannot recover interrupted completed workflow: ${recoveredIntegrity.errors.join("; ")}`);
  }
  return recovered;
}

export function blockedWorkflowLifecycleProjection(
  rawStatus,
  rawPhase,
  source,
  workflowInstanceId = null,
) {
  return {
    status: rawStatus,
    phase: rawPhase,
    terminal: false,
    blocked: true,
    source,
    workflow_instance_id: workflowInstanceId,
  };
}
