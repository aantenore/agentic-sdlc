import {
  UserError,
  fail,
} from "../cli/user-error.mjs";
import {
  findForbiddenHumanGuidanceTerms,
} from "../human-guidance.mjs";
import {
  compactText,
  getOptionString,
  normalizeListValue,
} from "./common.mjs";
import {
  CLAIM_STATUSES,
  HANDOFF_STATUSES,
  LOCK_STATUSES,
  STORY_STATUSES,
  TERMINAL_STORY_STATUSES,
} from "./constants.mjs";
import {
  buildContextOptimizationMetadata,
} from "./project.mjs";
import {
  taskStartAutonomyCopy,
} from "./route.mjs";
import {
  effectiveStoryLifecyclePolicy,
  storyAcceptanceCriteria,
} from "./story.mjs";

export function userErrorHumanGuidance(error, italian) {
  if (!(error instanceof UserError) || !error.humanGuidance) {
    return null;
  }
  return italian
    ? error.humanGuidance.it || error.humanGuidance.en || null
    : error.humanGuidance.en || error.humanGuidance.it || null;
}

export function executionContextRecoveryMessage(sourcePath) {
  return (
    `${sourcePath} changed outside a valid pre-change execution snapshot. `
    + "If the change happened before task start, restore the reviewed content or approve a new requirement/work brief. "
    + "If task start was interrupted, restore the immutable preflight snapshot and rerun task preflight; do not bypass freshness."
  );
}

export function userFriendlyTaskQuestion(decision, originalQuestion, locale = "en") {
  const italian = locale === "it";
  switch (decision.contract_action) {
    case "agree_requirement":
      return italian
        ? "Quale risultato osservabile vuoi ottenere, come verifichiamo che sia completo, cosa deve restare escluso e qual è la massima autonomia consentita?"
        : "What observable outcome do you need, how will we know it is complete, what must remain excluded, and what is the maximum independence allowed?";
    case "approve_requirement":
      return italian
        ? "Quale requisito approvato e corrente devo scomporre in storie?"
        : "Which current, approved requirement should I decompose into stories?";
    case "record_decomposition":
      return italian
        ? "La scomposizione proposta rappresenta correttamente il requisito e le dipendenze?"
        : "Does the proposed story breakdown accurately represent the requirement and its dependencies?";
    case "select_delivery_autonomy":
      if (!decision.delivery_kind) {
        return italian
          ? "Qual è la destinazione di questa consegna? Dopo averla definita, scegli quanto vuoi che lavori in autonomia."
          : "What is this delivery's destination? Once it is defined, choose how independently I should work.";
      }
      return taskStartAutonomyCopy(decision.delivery_kind, locale).question;
    case "repair_delivery_autonomy":
      return italian
        ? "Confermi di correggere i limiti esatti di questa consegna e di rivalutarla senza riusare approvazioni precedenti?"
        : "Should I correct this delivery’s exact limits and evaluate it again without reusing an earlier approval?";
    case "confirm_start":
      return italian ? "Confermi l’avvio di questa attività entro l’incarico e i limiti mostrati?" : originalQuestion;
    case "approve_contract":
      return italian ? "Confermi che l’incarico mostrato descrive correttamente ciò che deve essere fatto e prodotto?" : originalQuestion;
    case "replace_contract_after_story_revision":
      return italian
        ? "I criteri aggiornati descrivono correttamente il risultato e posso usarli per preparare un nuovo accordo di lavoro?"
        : "Do the revised criteria correctly describe the outcome so I can prepare a new work agreement?";
    case "revise_requirement_write_scope":
      return italian
        ? "Quali percorsi interni al progetto potranno cambiare per codice, test, documentazione ed evidenze di questa attività?"
        : "Which project-internal paths may change for this work's code, tests, documentation, and evidence?";
    case "initialize_sdlc":
      return italian ? "Quali file e informazioni devo usare come contesto iniziale affidabile del progetto?" : originalQuestion;
    default:
      return italian ? "Conferma la decisione descritta sopra oppure indica cosa deve cambiare." : originalQuestion;
  }
}

export function labelForCommit(commitSha) {
  return `Commit ${commitSha}`;
}

export function safePrimaryGuidanceText(value, request = {}) {
  const text = compactText(value, 260);
  if (!text || findForbiddenHumanGuidanceTerms(text).length > 0) return null;
  if (
    /--[a-z]|(?:^|\s)\/(?:[^\s/]+\/)*[^\s]*|(?:^|\s)[A-Za-z]:\\[^\s]+|(?:^|\s)\\\\[^\\\s]+\\[^\s]+|(?:^|\s)\.?[A-Za-z0-9_-]+[\\/][A-Za-z0-9_.\\/-]+|\.(?:json|jsonl|md|ya?ml)\b/iu.test(text)
    || /(?:^|\s)(?:npm|npx|node|python3?|pip3?|git|gh|rtk|codex|bash|zsh|fish|pwsh|powershell|sh)\s+(?:[^\s]+(?:\s+[^\s]+)*)/iu.test(text)
  ) {
    return null;
  }
  const technicalLiterals = [
    request.id,
    request.subject_id,
    request.story_id,
    request.template_id,
    request.artifact_type,
    ...(request.sources || []),
  ].map((item) => String(item || "").trim()).filter((item) => item.length > 2);
  if (technicalLiterals.some((literal) => text.includes(literal))) return null;
  return text;
}

export function assistantMessagePresentationFields() {
  const preservedLiterals = [
    "record IDs",
    "file paths",
    "CLI commands",
    "status and reason codes",
    "schema keys",
  ];
  return {
    assistant_message_source_language: "en",
    assistant_message_presentation: {
      translate_to_chat_language: true,
      contextualize_for_user: true,
      presenter: "codex",
      preserve_literals: preservedLiterals,
      preserve_literals_in_technical_details_only: preservedLiterals,
      instruction:
        "Before showing assistant_message to a human, translate and contextualize it in the active chat language. Use plain product language and begin with outcome, practical impact, the decision needed or an explicit statement that none is needed, what remains protected, and one next action. Do not place record IDs, internal autonomy terms, status or reason codes, hashes, schema keys, file paths, or CLI commands in that primary explanation. Preserve those literals exactly only after an optional Technical details or Dettagli tecnici divider. If an internal freshness check needs a refresh but the user-approved scope has not changed, explain that the internal reference will be updated and work will continue inside the same scope; do not present it as a new product decision. Summarize relevant contents directly instead of sending the user to inspect files. State what approval covers and what it does not cover. A yes or ok applies only to the displayed decision unless the user explicitly grants a broader approval level; later delegated approvals must be recorded as automation, not misattributed as direct user actions.",
    },
  };
}

export function attachAssistantMessagePresentation(payload) {
  Object.assign(payload, assistantMessagePresentationFields());
  return payload;
}

export function capitalizeLabel(value) {
  const text = String(value || "phase");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function storyCreationGuidance(options, story) {
  const italian = humanGuidanceLocale(options) === "it";
  const missingAcceptance = storyAcceptanceCriteria(story).length === 0;
  return {
    result: missingAcceptance
      ? (italian
          ? "È pronta una nuova story in bozza, ancora senza un criterio di successo osservabile."
          : "A new draft story is ready, but it does not yet have an observable success criterion.")
      : (italian
          ? "È pronta una nuova story con criteri di successo osservabili."
          : "A new story with observable success criteria is ready."),
    impact: missingAcceptance
      ? (italian
          ? "Titolo e spazio di lavoro sono registrati, ma non è ancora possibile preparare l’accordo di lavoro."
          : "Its title and workspace are recorded, but the work agreement cannot be prepared yet.")
      : (italian
          ? "Il risultato atteso è registrato e può guidare la preparazione dell’accordo di lavoro."
          : "The expected result is recorded and can guide preparation of the work agreement."),
    required_decision: missingAcceptance
      ? (italian
          ? "Indica almeno un risultato verificabile che dimostri quando il lavoro è riuscito."
          : "State at least one verifiable result that will show when the work has succeeded.")
      : (italian
          ? "Non serve una nuova decisione, salvo che tu voglia correggere i criteri prima di proseguire."
          : "No new decision is needed unless you want to correct the criteria before continuing."),
    protection_boundary: italian
      ? "La creazione della story non avvia il lavoro e non approva modifiche, merge, rilasci, produzione o segreti."
      : "Creating the story does not start work or approve changes, merges, releases, production, or secrets.",
    next_action: missingAcceptance
      ? (italian
          ? "Aggiungi il risultato osservabile, poi prepara l’accordo di lavoro."
          : "Add the observable result, then prepare the work agreement.")
      : (italian
          ? "Esamina i criteri e prepara l’accordo di lavoro governato."
          : "Review the criteria and prepare the governed work agreement."),
    details: {
      story_id: story.id,
      lifecycle_status: story.status,
      acceptance_criteria_count: storyAcceptanceCriteria(story).length,
      acceptance_required_before_contract: missingAcceptance,
    },
  };
}

export function terminalStoryStatuses(context) {
  return normalizeListValue(
    effectiveStoryLifecyclePolicy(context).terminal_statuses,
    Array.from(TERMINAL_STORY_STATUSES),
  )
    .map((item) => String(item).toLowerCase())
    .filter(Boolean);
}

export function normalizeHandoffCloseStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  const allowed = ["accepted", "closed", "cancelled"];
  if (!allowed.includes(normalized)) {
    fail(`Unknown handoff status '${value}'. Valid values: ${allowed.join(", ")}`);
  }
  return normalized;
}

export function normalizeHandoffStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!HANDOFF_STATUSES.has(normalized)) {
    fail(`Unknown handoff status '${value}'. Valid values: ${Array.from(HANDOFF_STATUSES).join(", ")}`);
  }
  return normalized;
}

export function normalizeStoryStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!STORY_STATUSES.has(normalized)) {
    fail(`Unknown story status '${value}'. Valid values: ${Array.from(STORY_STATUSES).join(", ")}`);
  }
  return normalized;
}

export function normalizeClaimStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!CLAIM_STATUSES.has(normalized)) {
    fail(`Unknown claim status '${value}'. Valid values: ${Array.from(CLAIM_STATUSES).join(", ")}`);
  }
  return normalized;
}

export function normalizeLockStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!LOCK_STATUSES.has(normalized)) {
    fail(`Unknown lock status '${value}'. Valid values: ${Array.from(LOCK_STATUSES).join(", ")}`);
  }
  return normalized;
}

export function humanGuidanceLocale(options = {}) {
  const requested = String(getOptionString(options, "locale") || "en").trim().toLowerCase();
  const locale = requested.split(/[-_]/u)[0];
  if (!["en", "it"].includes(locale)) {
    fail(`Unsupported human guidance locale '${requested}'. Use en or it.`);
  }
  return locale;
}

export function humanGuidanceLines(guidance, detailLines = [], options = {}, summaryLines = []) {
  const italian = humanGuidanceLocale(options) === "it";
  return [
    `${italian ? "Risultato" : "Outcome"}: ${guidance.result}`,
    `${italian ? "Cosa cambia in pratica" : "What this changes in practice"}: ${guidance.impact}`,
    `${italian ? "Cosa devi decidere" : "What you need to decide"}: ${guidance.required_decision}`,
    `${italian ? "Cosa resta protetto" : "What remains protected"}: ${guidance.protection_boundary}`,
    `${italian ? "Prossimo passo" : "Next step"}: ${guidance.next_action}`,
    ...summaryLines,
    "",
    italian ? "Dettagli tecnici (facoltativi):" : "Technical details (optional):",
    ...detailLines.map((line) => String(line).trim()).filter(Boolean).map((line) => `- ${line}`),
  ];
}

export function buildCompactCacheStatus(status) {
  const { cache, ...summary } = status;
  const omittedBytes = cache ? Buffer.byteLength(JSON.stringify(cache), "utf8") : 0;
  return {
    ...summary,
    cache_summary: cache ? {
      entries: Array.isArray(cache.full_text_index) ? cache.full_text_index.length : 0,
      source_paths: Array.isArray(cache.source_paths) ? cache.source_paths.length : 0,
      stories: Object.keys(cache.story_requirement_graph || {}).length,
      artifact_fingerprints: Object.keys(cache.artifact_fingerprints || {}).length,
      output_resolutions: Object.keys(cache.output_resolutions || {}).length,
    } : null,
    context_optimization: buildContextOptimizationMetadata({
      profile: "cache-status-compact:v1",
      omittedFields: cache ? ["cache"] : [],
      omittedBytes,
      fullPayloadFlag: "--full",
    }),
  };
}
