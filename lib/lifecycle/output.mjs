import path from "node:path";
import {
  fail,
} from "../cli/user-error.mjs";
import {
  EvidenceFormatError,
} from "../evidence-formats.mjs";
import {
  findForbiddenHumanGuidanceTerms,
} from "../human-guidance.mjs";
import {
  createHistoricalOperationalEvidenceV1RedactionPolicy,
  createLegacyEvidenceV1RedactionPolicy,
  createOperationalRedactionPolicy,
  describeRedactionPolicy,
} from "../observability/redaction.mjs";
import {
  formatMarkdownApprovalRequest,
  hashApprovalSubject,
} from "./authorization.mjs";
import {
  compactText,
  hashBuffer,
  listOrNone,
  normalizeArtifactType,
  normalizeListOption,
  normalizeListValue,
  normalizeRawListOption,
  normalizeText,
  overlaps,
  redactSensitiveText,
  stableJson,
} from "./common.mjs";
import {
  OUTPUT_FORMATS,
  SDLC_DIR,
} from "./constants.mjs";
import {
  humanGuidanceLocale,
} from "./guidance.mjs";
import {
  taskStartAutonomyChoiceLines,
} from "./route.mjs";
import {
  businessImpactForTrace,
  createTraceRedactionPolicy,
} from "./story.mjs";

export function mutationGovernanceEvidencePaths(options) {
  return [
    ...normalizeRawListOption(options.evidence),
    ...normalizeRawListOption(options["approval-evidence"]),
  ];
}

export function formatConfigMigrationChange(change) {
  const before = Object.hasOwn(change, "before") ? change.before : undefined;
  const after = Object.hasOwn(change, "after") ? change.after : undefined;
  const scalar = (value) => value === null || ["string", "number", "boolean"].includes(typeof value);
  if (change.operation === "replace" && scalar(before) && scalar(after)) {
    return `- replace ${change.path || "/"}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`;
  }
  if (change.operation === "add" && scalar(after)) {
    return `- add ${change.path || "/"}: ${JSON.stringify(after)}`;
  }
  if (change.operation === "remove" && scalar(before)) {
    return `- remove ${change.path || "/"}: ${JSON.stringify(before)}`;
  }
  return `- ${change.operation} ${change.path || "/"}`;
}

export function formatTaskStartDecision(decision) {
  const italian = decision.__human_locale === "it";
  const ready = decision.status === "ready_to_execute" && decision.execution_allowed;
  const revisedAgreementRequired =
    decision.contract_action === "replace_contract_after_story_revision";
  const autonomyChoiceLines = taskStartAutonomyChoiceLines(decision, italian);
  const lines = [
    `${italian ? "Risultato" : "Outcome"}: ${revisedAgreementRequired
      ? (italian
          ? "I criteri di riuscita sono cambiati e il lavoro resta fermo."
          : "The success criteria changed, so the work remains paused.")
      : ready
        ? (italian ? "Il lavoro concordato è pronto per iniziare." : "The agreed work is ready to start.")
        : (italian ? "Il lavoro non è ancora iniziato." : "The work has not started yet.")}`,
    `${italian ? "Cosa cambia in pratica" : "What this changes in practice"}: ${revisedAgreementRequired
      ? (italian
          ? "L’accordo precedente non viene riutilizzato per un risultato diverso."
          : "The previous agreement will not be reused for a different outcome.")
      : ready
        ? (italian ? "Posso procedere con l’attività entro i limiti già concordati." : "I can proceed with the work inside the limits already agreed.")
        : (italian ? "Nessuna modifica verrà avviata finché non viene chiarito il punto in attesa." : "No changes will begin until the pending point is clarified.")}`,
    `${italian ? "Cosa devi decidere" : "What you need to decide"}: ${revisedAgreementRequired
      ? (italian
          ? "Conferma che i criteri aggiornati descrivano correttamente il risultato."
          : "Confirm that the revised criteria correctly describe the intended outcome.")
      : ready
        ? (italian ? "Non devi prendere un’altra decisione per avviare questa attività." : "You do not need to make another decision to start this work.")
        : (italian ? "Rispondi alla scelta descritta sotto oppure indica cosa deve cambiare." : "Answer the choice described below, or say what should change.")}`,
    `${italian ? "Cosa resta protetto" : "What remains protected"}: ${italian
      ? "Questo controllo non ha eseguito modifiche, pubblicazioni, rilasci o merge; quei passaggi restano separati."
      : "This check did not change files, publish, release, or merge anything; those steps remain separate."}`,
    `${italian ? "Prossimo passo" : "Next step"}: ${revisedAgreementRequired
      ? (italian
          ? "Prepara un nuovo accordo sui criteri aggiornati e chiedine l’approvazione prima di iniziare."
          : "Prepare a new agreement for the revised criteria and obtain approval before starting.")
      : ready
        ? (italian ? "Inizia soltanto il lavoro già concordato." : "Begin only the work already agreed.")
        : (italian ? "Leggi la spiegazione facoltativa e chiarisci il punto in attesa." : "Review the optional explanation and clarify the pending point.")}`,
    ...autonomyChoiceLines,
    "",
    italian ? "Dettagli tecnici (facoltativi):" : "Technical details (optional):",
    ...(decision.assistant_message
      ? decision.assistant_message.split("\n").map((line) => line ? `- ${line}` : "-")
      : []),
    `- ${italian ? "Stato di avvio" : "Task start"}: ${decision.status}`,
    `- ${italian ? "Esecuzione consentita" : "Execution allowed"}: ${decision.execution_allowed ? (italian ? "sì" : "yes") : "no"}`,
    `- Route: ${decision.route}`,
    `- ${italian ? "Fase" : "Phase"}: ${decision.phase || "n/a"}`,
    `- ${italian ? "Attività" : "Story"}: ${decision.story_id || "n/a"}`,
    `- ${italian ? "Incarico" : "Contract"}: ${decision.contract_id || "n/a"}`,
    `- ${italian ? "Azione sull’incarico" : "Contract action"}: ${decision.contract_action || "n/a"}`,
    decision.lifecycle_certification_warning
      ? `- ${italian ? "Avviso certificazione lifecycle" : "Lifecycle certification warning"}: ${decision.lifecycle_certification_warning}`
      : null,
  ];
  lines.push(
    decision.blocking_reasons.length
      ? `- ${italian ? "Codici di blocco" : "Blocking reason codes"}: ${decision.blocking_reasons.join(", ")}`
      : `- ${italian ? "Codici di blocco" : "Blocking reason codes"}: ${italian ? "nessuno" : "none"}`,
  );
  if (decision.questions.length > 0) {
    lines.push(`- ${italian ? "Domande tecniche" : "Technical questions"}:`);
    lines.push(...decision.questions.map((question) => `  - ${question}`));
  }
  if (decision.approval_requests.length > 0) {
    lines.push(`- ${italian ? "Richieste di decisione" : "Human input requests"}:`);
    lines.push(...decision.approval_requests.map((request) => `  - ${request.title || request.summary}: ${request.user_prompt || request.summary}`));
  }
  if (decision.next_commands.length > 0) {
    lines.push(`- ${italian ? "Prossimi comandi tecnici" : "Next technical commands"}:`);
    lines.push(...decision.next_commands.map((command) => `  - ${command}`));
  }
  return lines.filter((line) => line !== null && line !== undefined);
}

export function formatRouteDecision(decision, options = {}) {
  const italian = humanGuidanceLocale(options) === "it";
  const ready = ["ready", "needs_confirmation"].includes(decision.status)
    && decision.route !== "ask_clarification";
  const acceptanceMissing = decision.blocking_reasons.includes("missing_acceptance_criteria");
  const agreementRequested = decision.intent?.requested_action === "create_contract";
  const technicalLines = [
    `Route: ${decision.route}`,
    `Status: ${decision.status}`,
    `Confidence: ${Number(decision.confidence).toFixed(2)}`,
    `Requires confirmation: ${decision.requires_confirmation ? "yes" : "no"}`,
  ];
  technicalLines.push(
    decision.blocking_reasons.length
      ? `Blocking reasons: ${decision.blocking_reasons.join(", ")}`
      : "Blocking reasons: none",
  );
  if (decision.questions.length > 0) {
    technicalLines.push("Questions:");
    technicalLines.push(...decision.questions.map((question) => `- ${question}`));
  }
  if (decision.deterministic_checks.length > 0) {
    technicalLines.push("Deterministic checks:");
    technicalLines.push(
      ...decision.deterministic_checks.map((check) =>
        `- ${check.check}: ${check.status}${check.details ? ` (${check.details})` : ""}`,
      ),
    );
  }
  if (decision.next_commands.length > 0) {
    technicalLines.push("Next commands:");
    technicalLines.push(...decision.next_commands.map((command) => `- ${command}`));
  }
  return [
    `${italian ? "Risultato" : "Outcome"}: ${acceptanceMissing
      ? agreementRequested
        ? (italian
            ? "L’attività non definisce ancora un risultato verificabile, quindi il suo accordo di lavoro non può essere preparato."
            : "The work item does not yet define a verifiable result, so its work agreement cannot be prepared.")
        : (italian
            ? "L’attività non definisce ancora un risultato verificabile e non può essere avviata."
            : "The work item does not yet define a verifiable result and cannot be started.")
      : ready
        ? (italian ? "La richiesta è stata compresa e può essere indirizzata correttamente." : "The request is understood and can be directed correctly.")
        : (italian ? "La richiesta ha bisogno di un chiarimento prima di procedere." : "The request needs clarification before work can continue.")}`,
    `${italian ? "Cosa cambia in pratica" : "What this changes in practice"}: ${acceptanceMissing
      ? (italian
          ? "Il plugin resta fermo e non inventa al posto tuo come riconoscere il completamento."
          : "The plugin remains paused and will not invent how completion should be recognized.")
      : ready
        ? (italian ? "Il prossimo passaggio è stato individuato senza avviare modifiche." : "The next step was identified without starting any changes.")
        : (italian ? "Il plugin resta fermo per evitare di scegliere al posto tuo." : "The plugin remains paused so it does not guess on your behalf.")}`,
    `${italian ? "Cosa devi decidere" : "What you need to decide"}: ${acceptanceMissing
      ? (italian
          ? "Indica almeno un risultato osservabile che dimostri quando l’attività è completa."
          : "State at least one observable result that will show when the work is complete.")
      : decision.questions.length > 0
        ? (italian ? "Chiarisci la scelta descritta nei dettagli facoltativi." : "Clarify the choice described in the optional details.")
        : (italian ? "Non devi decidere altro per questo controllo." : "You do not need to decide anything else for this check.")}`,
    `${italian ? "Cosa resta protetto" : "What remains protected"}: ${italian
      ? "Questo controllo ha interpretato la richiesta ma non ha modificato file, pubblicato o eseguito merge."
      : "This check interpreted the request but did not change files, publish, or merge anything."}`,
    `${italian ? "Prossimo passo" : "Next step"}: ${acceptanceMissing
      ? (italian
          ? "Aggiungi il criterio osservabile e ripeti questo controllo."
          : "Add the observable criterion and run this check again.")
      : ready
        ? (italian ? "Prosegui soltanto con il passaggio individuato." : "Continue only with the identified next step.")
        : (italian ? "Fornisci il chiarimento richiesto e ripeti il controllo." : "Provide the requested clarification and run the check again.")}`,
    "",
    `${italian ? "Dettagli tecnici (facoltativi)" : "Technical details (optional)"}:`,
    ...technicalLines.map((line) => `- ${line}`),
  ];
}

export function formatBaselineCurrentStateSummary(baseline, fallback = null) {
  const stack = (baseline.repository_snapshot?.detected_stack || [])
    .slice(0, 6)
    .map((item) => item.name || item.type)
    .filter(Boolean);
  const keyFiles = (baseline.repository_snapshot?.key_files || [])
    .slice(0, 8)
    .map((item) => item.path)
    .filter(Boolean);
  const documents = (baseline.imported_documents || [])
    .slice(0, 5)
    .map((item) => item.path)
    .filter(Boolean);
  const caveats = normalizeListValue(baseline.inferred_context?.caveats || [], []).slice(0, 2);
  const questions = normalizeListValue(baseline.open_questions || [], []).slice(0, 3);
  const parts = [
    baseline.summary ? `summary: ${baseline.summary}` : null,
    baseline.inferred_context?.product_signal ? `product signal: ${compactText(baseline.inferred_context.product_signal, 260)}` : null,
    baseline.inferred_context?.component_roots?.length ? `component roots: ${baseline.inferred_context.component_roots.join(", ")}` : null,
    stack.length ? `detected stack: ${stack.join(", ")}` : null,
    keyFiles.length ? `key files: ${keyFiles.join(", ")}` : null,
    documents.length ? `documents: ${documents.join(", ")}` : null,
    questions.length ? `open questions: ${questions.join(" ")}` : null,
    caveats.length ? `caveats: ${caveats.join(" ")}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" | ") : fallback;
}

export function formatBaselineDetectedStack(baseline) {
  const stack = baseline.repository_snapshot?.detected_stack || [];
  if (!stack.length) {
    return null;
  }
  const entries = stack
    .slice(0, 8)
    .map((item) => [item.name || item.type, item.source_path ? `from ${item.source_path}` : null].filter(Boolean).join(" "))
    .filter(Boolean);
  return entries.length ? `Technology signals I found: ${formatLimitedList(entries, 8)}` : null;
}

export function formatBaselineImportedDocuments(baseline) {
  const documents = Array.isArray(baseline.imported_documents) ? baseline.imported_documents : [];
  if (!documents.length) {
    return null;
  }
  const entries = documents
    .slice(0, 5)
    .map((document) => document.excerpt ? `${document.path}: ${compactText(document.excerpt, 180)}` : document.path)
    .filter(Boolean);
  return entries.length ? `Documents I read: ${formatLimitedList(entries, 5)}` : null;
}

export function formatBaselineKeyFiles(baseline) {
  const keyFiles = baseline.repository_snapshot?.key_files || [];
  if (!keyFiles.length) {
    return null;
  }
  const entries = keyFiles.slice(0, 10).map((item) => item.path).filter(Boolean);
  return entries.length ? `Important project files or folders detected: ${formatLimitedList(entries, 10)}` : null;
}

export function formatLimitedList(values, maxItems = 8) {
  const items = normalizeListValue(values, []).filter(Boolean);
  const visible = items.slice(0, maxItems);
  const hidden = Math.max(0, items.length - visible.length);
  return `${visible.join(", ")}${hidden ? `, plus ${hidden} more` : ""}`;
}

export function formatDetectedStackForUser(stack = []) {
  const entries = stack
    .slice(0, 10)
    .map((item) => [item.name || item.type, item.source_path ? `from ${item.source_path}` : null].filter(Boolean).join(" "))
    .filter(Boolean);
  return entries.length ? formatLimitedList(entries, 10) : "none detected";
}

export function canonicalOutputFormatOptions() {
  return Object.entries(OUTPUT_FORMATS)
    .filter(([format]) => format !== "custom")
    .map(([format, descriptor]) => ({
      id: format,
      label: `${descriptor.label} (${descriptor.extension})`,
      description: descriptor.generator
        ? `Canonical file generated and verified with the ${descriptor.generator} artifact capability.`
        : "Canonical file stored in the project and verified by the SDLC gate.",
    }));
}

export function formatExplainedOpenQuestion(explanation, index = null) {
  const prefix = index === null ? "Open question" : `Open question ${index}`;
  return [
    `${prefix}: ${explanation.question}`,
    `What I need: ${explanation.what_is_requested}`,
    `Why: ${explanation.why_needed}`,
    `Example answer: ${explanation.example_answers[0]}`,
    `Effect: ${explanation.effect_of_answer}`,
  ].join(" ");
}

export function renderBaselineReport(baseline) {
  return [
    `# ${baseline.id} Current State`,
    "",
    `Status: ${baseline.status}`,
    `Kind: ${baseline.kind}`,
    "",
    "## Summary",
    baseline.summary || "No summary provided.",
    "",
    "## Product Signal",
    baseline.inferred_context?.product_signal || "Not evidenced.",
    "",
    "## Architecture And Component Signals",
    ...listOrNone([
      ...(baseline.inferred_context?.component_roots || []).map((root) => `Source root: ${root}`),
      ...(baseline.inferred_context?.architecture_signals || []).map((item) => `${item.path}: ${(item.headings || []).join(" > ") || item.summary || "architecture evidence"}`),
    ]),
    "",
    "## Detected Stack",
    ...listOrNone((baseline.repository_snapshot?.detected_stack || []).map((item) => `${item.type}: ${item.name}${item.source_path ? ` (${item.source_path})` : ""}`)),
    "",
    "## Key Files",
    ...listOrNone((baseline.repository_snapshot?.key_files || []).map((item) => `${item.path} (${item.sha256})`)),
    "",
    "## Imported Documents",
    ...listOrNone((baseline.imported_documents || []).map((item) => `${item.path}: ${item.title || "Untitled"}; sections ${(item.headings || []).join(" > ") || "not detected"}; evidence ${item.sha256}`)),
    "",
    "## Open Questions",
    ...listOrNone(baseline.open_questions || []),
    "",
    "## Caveats",
    ...listOrNone(baseline.inferred_context?.caveats || []),
    "",
    "## Approval Guidance",
    "Approve this baseline only after the user confirms which inferred facts are canonical. Use bootstrap only for migration/provisional records.",
    "",
  ].join("\n");
}

export function traceEvidenceRefHash(ref) {
  return hashBuffer(Buffer.from(stableJson(ref), "utf8"));
}

export function traceEvidencePolicyBindingKey(target) {
  if (!target || typeof target !== "object") return null;
  const values = [
    target.event_id,
    target.event_hash,
    target.evidence_path,
    target.evidence_sha256,
    target.evidence_ref_sha256,
  ];
  return values.every((value) => typeof value === "string" && value.length > 0)
    ? values.join("\u0000")
    : null;
}

export function outputResolutionGuidance(resolution, options = {}) {
  const italian = humanGuidanceLocale(options) === "it";
  if (resolution.recommendation === "template_required") {
    return {
      result: italian
        ? "Manca ancora un formato governato per questo risultato."
        : "A governed format for this result is still missing.",
      impact: italian
        ? "Il risultato non può essere creato o collegato finché struttura e formato canonico non sono stati concordati."
        : "The result cannot be created or linked until its structure and canonical file format are agreed.",
      required_decision: italian
        ? "Esamina la struttura proposta e approvala, oppure chiedi di cambiare sezioni o formato del file."
        : "Review and approve the proposed structure, or ask to change its sections or file format.",
      protection_boundary: italian
        ? "Questa verifica non crea documenti, non approva formati e non autorizza una consegna."
        : "This lookup creates no document, approves no format, and authorizes no delivery.",
      next_action: italian
        ? "Proponi il formato, esamina la struttura mostrata e approvala prima di scrivere il risultato."
        : "Propose the format, review the displayed structure, and approve it before writing the result.",
      details: {},
    };
  }
  if (resolution.recommendation === "reuse_delta") {
    return {
      result: italian
        ? "Esiste già un risultato approvato che può essere riutilizzato."
        : "An approved result already exists and can be reused.",
      impact: italian
        ? "È sufficiente produrre solo le differenze necessarie, senza duplicare tutto il documento."
        : "Only the necessary differences need to be produced instead of duplicating the whole document.",
      required_decision: italian
        ? "Conferma che il risultato precedente sia ancora una base valida, oppure richiedi un nuovo documento completo."
        : "Confirm that the earlier result is still a valid base, or request a complete new document.",
      protection_boundary: italian
        ? "La base esistente non viene modificata e nessun nuovo risultato viene collegato da questa verifica."
        : "The existing base is not modified, and this lookup links no new result.",
      next_action: italian
        ? "Conferma il riuso; poi crea e collega soltanto le differenze concordate."
        : "Confirm reuse, then create and link only the agreed differences.",
      details: {},
    };
  }
  return {
    result: resolution.recommendation === "linked"
      ? (italian ? "Il risultato ufficiale è già collegato." : "The official result is already linked.")
      : (italian ? "È disponibile un formato approvato per creare il risultato." : "An approved format is available for creating the result."),
    impact: resolution.recommendation === "linked"
      ? (italian ? "I controlli successivi useranno il file già registrato." : "Later checks will use the file already recorded.")
      : (italian ? "Il risultato può essere scritto nel formato concordato e poi collegato ai controlli." : "The result can be written in the agreed format and then linked for checks."),
    required_decision: italian
      ? "Non serve una nuova decisione, salvo che tu voglia cambiare formato o sostituire il risultato."
      : "No new decision is needed unless you want to change the format or replace the result.",
    protection_boundary: italian
      ? "Questa verifica non crea, modifica o collega alcun file."
      : "This lookup creates, changes, or links no file.",
    next_action: resolution.recommendation === "linked"
      ? (italian ? "Continua con il prossimo controllo concordato." : "Continue with the next agreed check.")
      : (italian ? "Crea il file nel formato approvato e collegalo come risultato ufficiale." : "Create the file in the approved format and link it as the official result."),
    details: {},
  };
}

export function outputResolutionFingerprint(resolution) {
  const comparable = { ...resolution };
  delete comparable.cache_used;
  return stableJson(comparable);
}

export function outputRenderEvidenceOptions(options) {
  return Array.from(new Set([
    ...normalizeListOption(options["render-evidence"]),
    ...normalizeListOption(options.evidence),
  ]));
}

export function formatReportQueryRecord(record) {
  return {
    kind: record.kind,
    id: record.id,
    summary: record.summary,
    created_at: record.created_at,
    updated_at: record.updated_at,
    actor: record.actor,
    action: record.action,
    event_type: record.event_type,
    story_id: record.story_id,
    artifact_type: record.artifact_type,
    artifact_types: record.artifact_types || [],
    requirements: record.requirements || [],
    phase: record.phase,
    status: record.status,
    requested_by: record.requested_by || null,
    authorized_by: record.authorized_by || null,
    request: record.request || null,
    sources: record.sources || [],
  };
}

export function renderReportQueryMarkdown(report) {
  return [
    "# SDLC Query Report",
    "",
    `- Intent: ${report.query.intent}`,
    `- Subjects: ${report.query.subjects.join(", ")}`,
    `- Results: ${report.summary.result_count}`,
    "",
    "## Results",
    ...(report.results.length
      ? report.results.map((item) => {
          const source = item.sources?.[0] ? ` (${item.sources[0].path}:${item.sources[0].line})` : "";
          return `- ${item.created_at || item.updated_at || "unknown"} ${item.kind} ${item.id}: ${item.summary}${source}`;
        })
      : ["- No canonical KB records matched this query"]),
    "",
    "## Sources",
    ...(report.source_paths.length ? report.source_paths.map((sourcePath) => `- ${sourcePath}`) : ["- None"]),
    "",
  ].join("\n");
}

export function formatActivityEventForView(event, view) {
  const base = {
    created_at: event.created_at || null,
    story_id: event.story_id || null,
    type: event.type || null,
    action: event.action || event.type || null,
    summary: event.summary || null,
    actor: event.actor || null,
    sources: [event.source].filter(Boolean),
  };
  if (view === "business") {
    return {
      ...base,
      impact: businessImpactForTrace(event),
      evidence_count: Array.isArray(event.evidence) ? event.evidence.length : 0,
      related: Array.isArray(event.related) ? event.related : [],
    };
  }
  if (view === "dev") {
    return {
      ...base,
      evidence: Array.isArray(event.evidence) ? event.evidence : [],
      related: Array.isArray(event.related) ? event.related : [],
      git: {
        branch: event.git?.branch || null,
        head_sha: event.git?.head_sha || null,
        event: event.git?.event || null,
        remote: event.git?.remote || null,
        after_sha: event.git?.after_sha || null,
      },
    };
  }
  return {
    ...base,
    evidence: Array.isArray(event.evidence) ? event.evidence : [],
    related: Array.isArray(event.related) ? event.related : [],
    git: event.git || null,
    run: event.run || null,
    raw: event,
  };
}

export function renderActivityReportMarkdown(report) {
  return [
    "# SDLC Activity Report",
    "",
    `- View: ${report.view}`,
    `- Window: ${report.window.since} -> ${report.window.until}`,
    `- Events: ${report.summary.event_count}`,
    `- Stories: ${report.summary.story_count}`,
    "",
    "## Summary",
    ...Object.entries(report.summary.by_type).map(([type, count]) => `- ${type}: ${count}`),
    "",
    "## Activity",
    ...(report.items.length
      ? report.items.map((item) => {
          const source = item.sources?.[0] ? ` (${item.sources[0].path}:${item.sources[0].line})` : "";
          return `- ${item.created_at || "unknown"} ${item.story_id || "project"} ${item.action}: ${item.summary}${source}`;
        })
      : ["- No canonical trace events in this window"]),
    "",
    "## Sources",
    ...(report.source_paths.length ? report.source_paths.map((sourcePath) => `- ${sourcePath}`) : ["- None"]),
    "",
  ].join("\n");
}

export function createOutputRegistryQueryIndex(registry) {
  const templatesByType = new Map();
  const linksByStory = new Map();
  const linksByStoryAndType = new Map();
  const linksByRequirementAndType = new Map();
  const linkOrder = new Map();

  for (const template of registry?.templates || []) {
    const templates = templatesByType.get(template.type) || [];
    templates.push(template);
    templatesByType.set(template.type, templates);
  }
  for (let index = 0; index < (registry?.links || []).length; index += 1) {
    const link = registry.links[index];
    linkOrder.set(link, index);
    const linksForStory = linksByStory.get(link.story_id) || [];
    linksForStory.push(link);
    linksByStory.set(link.story_id, linksForStory);
    const storyKey = outputRegistryPairKey(link.story_id, link.artifact_type);
    const storyLinks = linksByStoryAndType.get(storyKey) || [];
    storyLinks.push(link);
    linksByStoryAndType.set(storyKey, storyLinks);
    for (const requirement of new Set(link.requirements || [])) {
      const requirementKey = outputRegistryPairKey(requirement, link.artifact_type);
      const requirementLinks = linksByRequirementAndType.get(requirementKey) || [];
      requirementLinks.push(link);
      linksByRequirementAndType.set(requirementKey, requirementLinks);
    }
  }

  return {
    templates_by_type: templatesByType,
    links_by_story: linksByStory,
    links_by_story_and_type: linksByStoryAndType,
    links_by_requirement_and_type: linksByRequirementAndType,
    link_order: linkOrder,
  };
}

export function relatedOutputLinksFromIndex(index, storyId, artifactType, requirements) {
  const related = new Set();
  for (const requirement of new Set(requirements || [])) {
    const key = outputRegistryPairKey(requirement, artifactType);
    for (const link of index.links_by_requirement_and_type.get(key) || []) {
      if (link.story_id !== storyId) related.add(link);
    }
  }
  return [...related].sort((left, right) => index.link_order.get(left) - index.link_order.get(right));
}

export function outputRegistryPairKey(left, right) {
  return `${left ?? ""}\u0000${right ?? ""}`;
}

export function findOutputTemplate(registry, id) {
  return (registry.templates || []).find((template) => template.id === id) || null;
}

export function verificationArtifactSha256(receipt = {}) {
  return receipt.artifact?.sha256 || receipt.artifact_sha256 || null;
}

export function verificationArtifactFormat(receipt = {}) {
  return receipt.artifact?.format || receipt.format || null;
}

export function verificationDimensionStatus(receipt = {}, dimension) {
  const value = receipt[dimension]?.status;
  if (value === "passed") {
    return "verified";
  }
  if (value === "not_required") {
    return "not-required";
  }
  return value || null;
}

export function withEvidenceFormatFailure(operation) {
  try {
    return operation();
  } catch (error) {
    if (error instanceof EvidenceFormatError) fail(error.message);
    throw error;
  }
}

export function collectOutputArtifactTypes(context, registry) {
  const types = new Set();
  for (const type of context.config.output_consistency_policy?.artifact_types || []) {
    types.add(normalizeArtifactType(type));
  }
  if (registry) {
    for (const template of registry.templates || []) {
      if (template.type) {
        types.add(normalizeArtifactType(template.type));
      }
    }
    for (const link of registry.links || []) {
      if (link.artifact_type) {
        types.add(normalizeArtifactType(link.artifact_type));
      }
    }
  }
  return Array.from(types).sort();
}

export function outputResolutionKey(storyId, artifactType) {
  return `${storyId}::${artifactType}`;
}

export function buildTemplateResolution(registry) {
  const result = {};
  for (const template of registry?.templates || []) {
    const type = template.type || "unknown";
    result[type] = result[type] || {
      approved_template_ids: [],
      draft_template_ids: [],
      default_template_id: null,
    };
    if (template.status === "approved") {
      result[type].approved_template_ids.push(template.id);
      result[type].default_template_id = result[type].default_template_id || template.id;
    } else {
      result[type].draft_template_ids.push(template.id);
    }
  }
  return result;
}

export function findRelatedOutputLinks(registry, link) {
  const requirements = link.requirements || [];
  return (registry.links || []).filter((candidate) => {
    if (candidate.id === link.id || candidate.artifact_type !== link.artifact_type) {
      return false;
    }
    if (overlaps(candidate.requirements || [], requirements)) {
      return true;
    }
    if (link.base_artifact && candidate.artifact_path === link.base_artifact) {
      return true;
    }
    return candidate.artifact_path && candidate.artifact_path === link.artifact_path;
  });
}

export function hasApprovedOutputDecision(decisions, decisionId) {
  if (!decisionId) {
    return false;
  }
  return decisions.some(
    (decision) =>
      decision.id === decisionId &&
      decision.status === "approved" &&
      ["output_link_override", "duplicate_output_approved"].includes(decision.type),
  );
}

export function buildLegacyEvidenceV1RedactionPolicy(context) {
  return createTraceRedactionPolicy(context, createLegacyEvidenceV1RedactionPolicy);
}

export function buildHistoricalOperationalEvidenceV1RedactionPolicy(context) {
  return createTraceRedactionPolicy(context, createHistoricalOperationalEvidenceV1RedactionPolicy);
}

export function assertTraceEvidencePolicySourceSafety(source, allowedAlgorithms) {
  const permitted = new Set(allowedAlgorithms ?? [
    "legacy_evidence_v1",
    "operational_evidence_v1",
    "operational_v2",
  ]);
  if (!source || typeof source !== "object" || Array.isArray(source) || !permitted.has(source.algorithm)) {
    throw new TypeError("unsupported trace evidence redaction algorithm");
  }
  const baselinePolicy = source.algorithm === "legacy_evidence_v1"
    ? createLegacyEvidenceV1RedactionPolicy()
    : source.algorithm === "operational_evidence_v1"
      ? createHistoricalOperationalEvidenceV1RedactionPolicy()
      : createOperationalRedactionPolicy();
  const baseline = describeRedactionPolicy(baselinePolicy);
  if (
    stableJson(source.limits) !== stableJson(baseline.limits)
    || source.replacement !== baseline.replacement
    || stableJson(source.credential_assignment_detector)
      !== stableJson(baseline.credential_assignment_detector)
  ) {
    throw new TypeError("trace evidence redaction safety boundary changed");
  }
  if (
    !Array.isArray(source.sensitive_keys)
    || source.sensitive_keys.length > 256
    || source.sensitive_keys.some((key) => typeof key !== "string" || key.length === 0 || key.length > 128)
    || !Array.isArray(source.detectors)
    || !Array.isArray(source.identifier_allow_patterns)
    || source.detectors.length + source.identifier_allow_patterns.length > baseline.limits.maxPatterns
  ) {
    throw new TypeError("trace evidence redaction policy exceeds its immutable safety limits");
  }
  const hasCanonicalEntry = (entries, required) => {
    const serialized = new Set(entries.map((entry) => stableJson(entry)));
    return required.every((entry) => serialized.has(stableJson(entry)));
  };
  if (
    !baseline.sensitive_keys.every((key) => source.sensitive_keys.includes(key))
    || !hasCanonicalEntry(source.detectors, baseline.detectors)
    || !hasCanonicalEntry(source.identifier_allow_patterns, baseline.identifier_allow_patterns)
  ) {
    throw new TypeError("trace evidence redaction policy omits a mandatory privacy detector");
  }
}

export function shouldVerifyTraceEvidence(event, projectPath) {
  if (["test", "release"].includes(event.type)) return true;
  if ([
    "data.migrate",
    "data.rollback",
    "git.commit",
    "git.push",
    "pull_request.merge",
    "release.local",
    "rollback.verify",
  ].includes(event.action)) {
    return String(projectPath).replace(/\\/gu, "/").startsWith(`${SDLC_DIR}/autonomy/actions/`)
      || String(projectPath).replace(/\\/gu, "/").includes("/evidence/");
  }
  return false;
}

export function renderGateReportMarkdown(report) {
  return [
    `# SDLC Gate Report`,
    "",
    `- Status: ${report.status}`,
    `- Strict: ${report.strict}`,
    `- Scope: ${report.scope}`,
    `- Story: ${report.story_id || "all"}`,
    `- Checked at: ${report.checked_at}`,
    `- Checked items: ${report.checked.length}`,
    "",
    "## Errors",
    ...(report.errors.length ? report.errors.map((item) => `- ${item}`) : ["- None"]),
    "",
    "## Warnings",
    ...(report.warnings.length ? report.warnings.map((item) => `- ${item}`) : ["- None"]),
    "",
    "## Human Input Requests",
    ...(report.approval_requests?.length
      ? report.approval_requests.flatMap((item, index) => formatMarkdownApprovalRequest(item, index + 1))
      : ["- None"]),
    "",
    "## Checked",
    ...(report.checked.length ? report.checked.map((item) => `- ${item}`) : ["- None"]),
    "",
  ].join("\n");
}

export function collectStoryOutputLinksForStep(context, registry, storyId, outputTypes) {
  const typeFilter = new Set(outputTypes);
  return (registry?.links || [])
    .filter((link) => link.story_id === storyId)
    .filter((link) => typeFilter.size === 0 || typeFilter.has(link.artifact_type))
    .sort((a, b) => String(a.artifact_type || "").localeCompare(String(b.artifact_type || "")));
}

export function effectiveOutputDecisions(decisions) {
  const result = [];
  const latestTemplateDecision = new Map();
  for (const decision of decisions) {
    if (decision.type !== "template_approved" || !decision.template_id) {
      result.push(decision);
      continue;
    }
    const current = latestTemplateDecision.get(decision.template_id);
    const currentKey = `${current?.created_at || ""}\u0000${current?.id || ""}`;
    const candidateKey = `${decision.created_at || ""}\u0000${decision.id || ""}`;
    if (!current || candidateKey > currentKey) {
      latestTemplateDecision.set(decision.template_id, decision);
    }
  }
  result.push(...latestTemplateDecision.values());
  return result;
}

export function outputLinkHasMatchingApprovedDecision(decisions, link) {
  if (!link.decision_id || !hasApprovedOutputDecision(decisions, link.decision_id)) {
    return false;
  }
  const decision = decisions.find((candidate) => candidate.id === link.decision_id);
  if (!decision || !decision.subject || !decision.approved_content_hash) {
    return false;
  }
  const expectedSubject = buildOutputLinkDecisionSubject(link);
  return (
    decision.approved_content_hash === hashApprovalSubject(expectedSubject) &&
    stableJson(decision.subject) === stableJson(expectedSubject)
  );
}

export function buildOutputLinkDecisionSubject(link) {
  return {
    story_id: link.story_id,
    artifact_type: link.artifact_type,
    artifact_path: link.artifact_path,
    template_id: link.template_id,
    mode: link.mode,
    base_artifact: link.base_artifact || null,
    requirements: Array.isArray(link.requirements) ? link.requirements : [],
    rationale: link.rationale || null,
  };
}

export function evidenceRepresentationMatchesRef(representation, ref) {
  const bytes = Buffer.from(representation, "utf8");
  return bytes.length === ref.size_bytes && hashBuffer(bytes) === ref.sha256;
}

export function renderTemplate(template, variables) {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, key) => {
    if (variables[key] === undefined) {
      return "";
    }
    return String(variables[key]);
  });
}

export function safeEvidenceExcerpt(filePath, value, maxLength) {
  const name = path.basename(filePath || "").toLowerCase();
  if (/^(?:\.env(?:\..*)?|credentials|secrets?)(?:\..*)?$/.test(name) || /(?:^|[-_.])(?:secret|credential|private[-_]?key)(?:[-_.]|$)/.test(name)) {
    return "[REDACTED:SENSITIVE_FILE_CONTENT]";
  }
  return normalizeText(redactSensitiveText(value)).slice(0, maxLength);
}

export function isHumanGuidanceOutput(lines) {
  const english = [
    "Outcome:",
    "What this changes in practice:",
    "What you need to decide:",
    "What remains protected:",
    "Next step:",
  ];
  const italian = [
    "Risultato:",
    "Cosa cambia in pratica:",
    "Cosa devi decidere:",
    "Cosa resta protetto:",
    "Prossimo passo:",
  ];
  const hasFiveFields = [english, italian].some((labels) =>
    labels.every((label, index) => lines[index]?.startsWith(label)));
  if (!hasFiveFields) return false;
  const dividerIndex = lines.findIndex((line) =>
    line === "Technical details (optional):" || line === "Dettagli tecnici (facoltativi):");
  if (dividerIndex < 5) return false;
  return findForbiddenHumanGuidanceTerms(lines.slice(0, dividerIndex).join("\n")).length === 0;
}

export function legacyOutputGuidance(payload, options = {}) {
  const italian = humanGuidanceLocale(options) === "it";
  const status = String(payload?.status || "").toLowerCase();
  const blocked = ["blocked", "failed", "invalid", "needs_repair", "exception_pending"].includes(status);
  const needsDecision = ["needs_user_input", "pending", "proposed", "awaiting_approval"].includes(status);
  if (blocked) {
    return {
      result: italian ? "Il controllo richiesto ha trovato un problema." : "The requested check found a problem.",
      impact: italian ? "Il lavoro che dipende da questo risultato non deve ancora proseguire." : "Work that depends on this result should not continue yet.",
      required_decision: italian ? "Non devi approvare nulla finché il problema non è stato corretto." : "You do not need to approve anything until the problem is corrected.",
      protection_boundary: italian ? "Questo risultato non autorizza modifiche, merge, rilasci, distribuzioni, produzione, segreti o lavoro fuori dai limiti concordati." : "This result does not authorize changes, merges, releases, deployments, production, secrets, or work outside the agreed limits.",
      next_action: italian ? "Leggi la diagnosi facoltativa, correggi il problema e ripeti il controllo." : "Review the optional diagnosis, correct the problem, and run the check again.",
      details: {},
    };
  }
  if (needsDecision) {
    return {
      result: italian ? "Serve una decisione prima del prossimo passo." : "A decision is needed before the next step.",
      impact: italian ? "Il lavoro resta in pausa finché la scelta mostrata non viene chiarita." : "Work remains paused until the displayed choice is clarified.",
      required_decision: italian ? "Esamina la scelta nei dettagli facoltativi e rispondi in linguaggio naturale." : "Review the choice in the optional details and answer in natural language.",
      protection_boundary: italian ? "Nessuna risposta viene interpretata come permesso per altre consegne, merge, rilasci, produzione, segreti o file non concordati." : "No answer is treated as permission for another delivery, merge, release, production, secrets, or unagreed files.",
      next_action: italian ? "Conferma, correggi o rifiuta soltanto la scelta mostrata." : "Confirm, correct, or reject only the displayed choice.",
      details: {},
    };
  }
  return {
    result: italian ? "Il risultato richiesto è pronto." : "The requested result is ready.",
    impact: italian ? "Puoi vedere cosa è stato controllato o registrato senza dover interpretare i termini interni." : "You can review what was checked or recorded without interpreting internal labels.",
    required_decision: italian ? "Questo risultato non richiede una nuova decisione, salvo che i dettagli facoltativi indichino esplicitamente una scelta in attesa." : "This result needs no new decision unless the optional details explicitly show a pending choice.",
    protection_boundary: italian ? "Il risultato non autorizza da solo merge, rilasci, distribuzioni, produzione, segreti o lavoro fuori dai limiti concordati." : "The result does not by itself authorize merges, releases, deployments, production, secrets, or work outside the agreed limits.",
    next_action: italian ? "Consulta i dettagli facoltativi e continua soltanto con il prossimo passo già concordato." : "Review the optional details and continue only with the next step already agreed.",
    details: {},
  };
}

export function autonomyVerificationTechnicalLines(guidance, options = {}) {
  if (!guidance?.details?.digital_approver_verification) return [];
  return humanGuidanceLocale(options) === "it"
    ? [
        "Verifica digitale dell'approvatore: non attiva; l'esecuzione effettiva resta checkpointed.",
        "Per abilitarla: imposta authority_policy.mode=host_verified, configura la chiave pubblica Ed25519 in authority_policy.trusted_host_keys e fornisci l'approvazione esterna firmata con --host-receipt-file.",
      ]
    : [
        "Digital approver verification: not active; effective execution remains checkpointed.",
        "To enable it: set authority_policy.mode=host_verified, configure the Ed25519 public key in authority_policy.trusted_host_keys, and supply the externally signed approval with --host-receipt-file.",
      ];
}
