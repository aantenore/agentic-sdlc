import path from "node:path";
import {
  fail,
} from "../cli/user-error.mjs";
import {
  isApprovedRecordFresh,
  normalizeId,
} from "../lifecycle/common.mjs";
import {
  CACHE_FILE_NAME,
  PROJECT_CONFIG_FILE_NAME,
  PROJECT_CONFIG_LOCK_FILE_NAME,
  SDLC_DIR,
} from "../lifecycle/constants.mjs";
import {
  buildCompactCacheStatus,
  humanGuidanceLines,
  humanGuidanceLocale,
} from "../lifecycle/guidance.mjs";
import {
  openProjectQuerySession,
  toProjectPath,
} from "../lifecycle/project.mjs";
import {
  dependencyGraphPath,
  findBlockingDependencyCycles,
  isHardDependencyEdge,
  isIntactBootstrapPhaseContract,
} from "../lifecycle/story.mjs";
import {
  fs,
  process,
} from "../runtime/host.mjs";
import {
  PLUGIN_ROOT,
} from "../runtime/paths.mjs";
import {
  collectApprovalRequests,
} from "./authorization.mjs";
import {
  buildOrchestrationSnapshot,
  collectJsonFiles,
  collectKnowledgeSourceSnapshot,
  countCanonicalRecords,
  now,
  validateCacheMetadata,
} from "./common.mjs";
import {
  effectiveOutputDelivery,
} from "./delivery.mjs";
import {
  gitConfigValue,
} from "./git.mjs";
import {
  ensureInitialized,
} from "./migration.mjs";
import {
  output,
  readOutputRegistry,
} from "./output.mjs";
import {
  detectProjectStack,
  discoverExistingProjectDocuments,
} from "./project.mjs";
import {
  readProjectFileExcerpt,
  readProjectJson,
} from "./storage.mjs";
import {
  inspectDependencyEdge,
  readBaselines,
  readBreakdowns,
  readDependencyGraph,
  requirementSupersessionEvents,
  requirementSupersessionGovernanceErrors,
  validateBaselineSourceHashes,
} from "./story.mjs";
import {
  buildStoryWorkflowNextAction,
} from "./workflow.mjs";

// Recovery command that the config guidance refers to as "the command in the optional details".
export function configStatusCommand(status) {
  if (status === "legacy_compat" || status === "drifted") return { label: "Preview command", command: "agentic-sdlc config migrate" };
  if (status === "uninitialized") return { label: "Initialization command", command: "agentic-sdlc init" };
  return null;
}

export function configStatusGuidance(context, locale = "en") {
  const italian = locale === "it";
  const status = context.configState?.status || "invalid";
  if (status === "locked") {
    return {
      result: italian ? "Le regole del progetto sono confermate e pronte all’uso." : "The project's rules are confirmed and ready to use.",
      impact: italian ? "Un aggiornamento del programma non può cambiare di nascosto il modo in cui questo progetto viene gestito." : "A software update cannot silently change how this project is governed.",
      required_decision: italian ? "Non devi decidere nulla adesso." : "You do not need to decide anything now.",
      protection_boundary: italian ? "Questo controllo ha soltanto letto le regole; non ha modificato file né avviato lavoro." : "This check only read the rules; it did not change files or start work.",
      next_action: italian ? "Puoi continuare con l’attività concordata." : "You can continue with the agreed work.",
    };
  }
  if (status === "legacy_compat") {
    return {
      result: italian ? "Il progetto continua a usare in sicurezza le regole precedenti." : "The project is safely using its previous compatible behavior.",
      impact: italian ? "Il comportamento attuale resta invariato, ma le regole non sono ancora state confermate nel nuovo formato." : "Current behavior stays unchanged, but the rules have not yet been confirmed in the new format.",
      required_decision: italian ? "Prima di aggiornarle, dovrai controllare che il riepilogo delle differenze sia corretto." : "Before updating them, you will need to confirm that the change summary is correct.",
      protection_boundary: italian ? "La semplice anteprima non modifica alcun file e il programma non sostituirà le regole in automatico." : "The preview changes no files, and the software will not replace the rules automatically.",
      next_action: italian ? "Crea l’anteprima indicata nei dettagli facoltativi e controlla le differenze." : "Create the preview shown in the optional details and review the differences.",
    };
  }
  if (status === "drifted") {
    return {
      result: italian ? "Le regole sono cambiate dopo l’ultima conferma, quindi le modifiche controllate sono in pausa." : "The rules changed after their last confirmation, so governed changes are paused.",
      impact: italian ? "Il programma non presume che il cambiamento fosse intenzionale e non continuerà da solo." : "The software will not assume the change was intentional or continue on its own.",
      required_decision: italian ? "Dovrai esaminare le differenze e confermare soltanto quelle desiderate." : "You will need to review the differences and confirm only the intended ones.",
      protection_boundary: italian ? "Nessuna regola nuova viene accettata e nessun file di lavoro viene modificato durante questo controllo." : "No new rule is accepted and no work file is changed during this check.",
      next_action: italian ? "Crea una nuova anteprima con il comando nei dettagli facoltativi, poi applica soltanto quella approvata." : "Create a fresh preview with the command in the optional details, then apply only the reviewed result.",
    };
  }
  if (status === "uninitialized") {
    return {
      result: italian ? "Questo progetto non è ancora stato preparato per il flusso di lavoro guidato." : "This project has not been initialized for Agentic SDLC yet.",
      impact: italian ? "Non è attiva alcuna regola del progetto e nessun file è stato modificato." : "No project policy is active and no project files were changed.",
      required_decision: italian ? "Decidi se vuoi preparare questo progetto adesso." : "Decide whether you want to prepare this project now.",
      protection_boundary: italian ? "Questo controllo non ha creato cartelle, modificato file o avviato attività." : "This check did not create folders, change files, or start work.",
      next_action: italian ? "Se vuoi procedere, usa il comando di inizializzazione indicato nei dettagli facoltativi." : "If you want to proceed, use the initialization command in the optional details.",
    };
  }
  return {
    result: italian ? "Le regole salvate non possono essere verificate, quindi le modifiche controllate sono bloccate." : "The saved rules cannot be verified, so governed changes are blocked.",
    impact: italian ? "Il programma non eseguirà attività che dipendono da queste regole finché il problema non viene corretto." : "The software will not perform work that depends on these rules until the problem is corrected.",
    required_decision: italian ? "Non devi approvare nulla finché le regole non sono state ripristinate o corrette." : "You do not need to approve anything until the rules are restored or corrected.",
    protection_boundary: italian ? "Nessuna regola dubbia viene usata e nessun file di lavoro viene modificato." : "No untrusted rule is used and no work file is changed.",
    next_action: italian ? "Consulta la diagnosi facoltativa e ripristina l’ultima versione valida prima di continuare." : "Review the optional diagnosis and restore the last valid version before continuing.",
  };
}

export function showConfigStatus(context, options) {
  const locale = humanGuidanceLocale(options);
  const guidance = configStatusGuidance(context, locale);
  const verificationErrors = context.configState?.lock_verification?.errors || [];
  const recovery = configStatusCommand(context.configState.status);
  const payload = {
    status: context.configState.status,
    outcome: guidance.result,
    impact: guidance.impact,
    required_decision: guidance.required_decision,
    protection_boundary: guidance.protection_boundary,
    next_action: guidance.next_action,
    human_guidance: guidance,
    mutation_allowed: context.configState.mutation_allowed,
    migration_required: context.configState.migration_required,
    config_path: context.projectConfigPath
      ? toProjectPath(context, context.projectConfigPath)
      : `${SDLC_DIR}/${PROJECT_CONFIG_FILE_NAME}`,
    lock_path: context.configLockPath
      ? toProjectPath(context, context.configLockPath)
      : `${SDLC_DIR}/${PROJECT_CONFIG_LOCK_FILE_NAME}`,
    effective_config_hash: context.configState.effective_config_hash,
    defaults_profile: context.configState.defaults_profile,
    inherited_paths: context.configState.inherited_paths || [],
    validation_error: context.configValidationError,
    lock_errors: verificationErrors,
  };
  output(options, payload, humanGuidanceLines(guidance, [
    `- Status: ${context.configState.status}`,
    `- Effective config: ${context.configState.effective_config_hash || "not created"}`,
    `- Defaults profile: ${context.configState.defaults_profile?.id || "not selected"}`,
    ...(recovery ? [`- ${recovery.label}: ${recovery.command}`] : []),
    ...(context.configValidationError ? [`- Config validation: ${context.configValidationError}`] : []),
    ...verificationErrors.map((issue) => `- Lock check: ${issue.message}`),
  ].map((line) => line.replace(/^- /u, "")), options));
}

export function userFriendlyTaskStartIntro(decision, locale = "en") {
  const italian = locale === "it";
  switch (decision.contract_action) {
    case "normalize_request":
      return italian
        ? "Devo tradurre la richiesta in un’azione precisa prima di usare il processo del progetto."
        : "I need to translate the request into a precise action before using the project workflow.";
    case "initialize_sdlc":
      return italian
        ? "Il progetto non è ancora preparato: prima devo creare o confermare il contesto iniziale."
        : "This project has not been prepared yet, so I need to create or confirm its starting context first.";
    case "agree_requirement":
      return italian
        ? "Prima di creare storie o incarichi dobbiamo concordare il risultato, le prove di completamento, le esclusioni e il limite massimo di autonomia."
        : "Before creating stories or work briefs, we need to agree the outcome, completion evidence, exclusions, and maximum autonomy boundary.";
    case "approve_requirement":
      return italian
        ? "La scomposizione può partire soltanto da un requisito approvato, corrente e collegato al proprio limite di autonomia."
        : "Decomposition can start only from a current approved requirement linked to its autonomy boundary.";
    case "record_decomposition":
      return italian
        ? "La scomposizione è ancora pianificazione: prima dell’unico avvio devo registrare storie e dipendenze, poi concordare output, incarico e autonomia della consegna."
        : "Decomposition is still planning: before the single task start, I must record stories and dependencies, then agree the output, work brief, and delivery autonomy.";
    case "create_or_revise_contract":
    case "create_contract":
      return italian
        ? "Per questo passo non esiste ancora un incarico concordato: devo confermare cosa posso fare e cosa devo produrre."
        : "There is no agreed work brief for this step yet, so I need to confirm what I am allowed to do and what I should produce.";
    case "replace_contract_after_story_revision":
      return italian
        ? "I criteri di riuscita sono cambiati: prima di iniziare devo preparare e farti approvare un nuovo accordo di lavoro coerente con il risultato aggiornato."
        : "The success criteria changed, so before starting I must prepare a new work agreement that matches the revised outcome and show it for approval.";
    case "revise_requirement_write_scope":
      return italian
        ? "Il risultato può modificare codice o evidenze, ma il requisito approvato non indica ancora alcuna area di file del progetto: devo correggere quel limite prima di iniziare."
        : "This result may change product files or durable evidence, but the approved requirement names no project file area yet, so that boundary must be corrected before work starts.";
    case "clarify_contract":
      return italian
        ? "L’incarico è incompleto: prima di produrre il risultato devo sapere quali file o informazioni del progetto devono guidare il lavoro."
        : "The work brief is incomplete, so I need the project context or files that should guide the work before I produce an output.";
    case "approve_contract":
      return italian
        ? "Ho trovato un incarico, ma non hai ancora confermato che corrisponda a ciò che vuoi."
        : "I found a work brief, but you have not confirmed that it matches what you want me to do.";
    case "confirm_start":
      return italian
        ? "Il lavoro è definito, ma prima di iniziare serve la tua conferma esplicita."
        : "The work is defined, but I need your explicit go-ahead before starting it.";
    case "select_delivery_autonomy":
      if (!decision.delivery_kind) {
        return italian
          ? "Il lavoro è definito, ma la destinazione di questa consegna e il relativo modo di lavorare devono ancora essere scelti."
          : "The work is defined, but this delivery's destination and working mode still need to be chosen.";
      }
      return decision.delivery_kind === "local_release"
        ? (italian
            ? "Il lavoro è definito, ma questo rilascio locale deve ancora avere una scelta propria che non sarà riutilizzata."
            : "The work is defined, but this local release still needs its own choice, which will not be reused.")
        : (italian
            ? "Il lavoro è definito, ma questa PR deve ancora avere una scelta propria che non sarà riutilizzata."
            : "The work is defined, but this pull request still needs its own choice, which will not be reused.");
    case "repair_delivery_autonomy":
      return italian
        ? "La scelta di autonomia non corrisponde più al perimetro o allo stato esatto della consegna e deve essere corretta prima di continuare."
        : "The autonomy choice for this delivery no longer matches its exact scope or current state, so it must be corrected before work continues.";
    case "revise_contract":
      return italian
        ? "L’incarico deve essere modificato prima di avviare questa attività."
        : "The work brief needs to be changed before this task can start.";
    default:
      return italian
        ? "Mi fermo per non inventare contesto, scegliere un formato o iniziare il lavoro senza la tua decisione."
        : "I am pausing so I do not invent context, choose an output format, or start work without your decision.";
  }
}

export function showBaselineStatus(context, options) {
  ensureInitialized(context);
  const id = options.id ? normalizeId(String(options.id)) : null;
  const baselines = readBaselines(context).filter((baseline) => !id || baseline.id === id);
  if (id && baselines.length === 0) {
    fail(`Baseline ${id} does not exist`);
  }
  const status = baselines.map((baseline) => {
    const staleSources = validateBaselineSourceHashes(context, baseline, `baseline ${baseline.id}`, { collectOnly: true });
    const approvalFresh = isApprovedRecordFresh(baseline);
    const sourceFresh = staleSources.length === 0;
    const approved = baseline.status === "approved" && approvalFresh && sourceFresh;
    return {
      id: baseline.id,
      status: baseline.status,
      effective_status: approved ? "approved" : baseline.status === "approved" ? "needs_refresh" : baseline.status,
      kind: baseline.kind,
      source_paths: baseline.source_paths || [],
      stale: !sourceFresh,
      stale_sources: staleSources,
      open_questions: Array.isArray(baseline.open_questions) ? baseline.open_questions.length : 0,
      approved,
      next_action: !sourceFresh || (baseline.status === "approved" && !approvalFresh)
        ? `Refresh the project snapshot before starting new work from ${baseline.id}.`
        : approved
          ? "Describe the next required outcome, success checks, exclusions, and autonomy ceiling."
          : "Review and approve the proposed project context, or state the exact correction.",
      next_action_details: !sourceFresh || (baseline.status === "approved" && !approvalFresh)
        ? {
            kind: "refresh_project_context",
            label: "Refresh the saved project context from current evidence.",
            command: `agentic-sdlc baseline propose --id ${baseline.id} --source <current-path> --summary "<updated observable context>" --force`,
          }
        : approved
          ? {
              kind: "describe_requirement",
              label: "Describe the next required outcome, success checks, exclusions, and autonomy ceiling.",
              command: null,
            }
          : {
              kind: "approve_project_context",
              label: "Review and approve the proposed project context, or state the exact correction.",
              command: `agentic-sdlc baseline approve --id ${baseline.id} --actor-type human --approval-source explicit-user --summary "<what the user confirmed>"`,
            },
    };
  });
  const nextAction = status[0]?.next_action_details || {
    kind: "propose_project_context",
    label: "Create a current project context proposal before planning work.",
    command: "agentic-sdlc baseline propose --id BASELINE-INITIAL --summary \"<observable current project context>\"",
  };
  output(
    options,
    { baselines: status, next_action: nextAction },
    status.length
      ? status.flatMap((item) => item.stale || item.effective_status === "needs_refresh"
        ? [
            `${item.id}: the saved project snapshot no longer matches the current files.`,
            `Next: ${item.next_action} Technical status: ${item.effective_status}.`,
          ]
        : item.approved
          ? [
              `${item.id}: approved project context is ready to use; open questions ${item.open_questions}.`,
              `Next: ${item.next_action}`,
            ]
          : [
              `${item.id}: proposed project context is waiting for review; open questions ${item.open_questions}.`,
              `Next: ${item.next_action}`,
            ])
      : ["No project context proposals found.", `Next: ${nextAction.label}`],
  );
}

export function effectiveRequirementStatus(context, requirement) {
  const event = requirementSupersessionEvents(context)
    .filter((item) =>
      item.event === "superseded"
      && item.requirement_ref?.id === requirement.id
      && requirementSupersessionGovernanceErrors(context, item).length === 0)
    .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)))
    .at(-1);
  return event ? { status: "superseded", event } : { status: requirement.status, event: null };
}

export function describeContractForHuman(context, contract) {
  const contextualization = contract.contextualization || {};
  const contextSources = Array.isArray(contextualization.context_sources)
    ? contextualization.context_sources.map((source) => source.path).filter(Boolean)
    : [];
  const answeredQuestions = Array.isArray(contextualization.questions)
    ? contextualization.questions
        .filter((question) => question.status === "answered")
        .map((question) => `${question.question}: ${question.answer}`)
    : [];
  const openQuestions = Array.isArray(contextualization.questions)
    ? contextualization.questions
        .filter((question) => question.status !== "answered")
        .map((question) => question.question)
    : [];
  const registry = readOutputRegistry(context, { missingOk: true });
  const outputRefs = Array.isArray(contract.output_contract_refs)
    ? contract.output_contract_refs.map((ref) => {
        if (!ref || typeof ref !== "object" || Array.isArray(ref)) {
          return "invalid output ref (must be corrected before approval)";
        }
        const template = (registry?.templates || []).find((item) => item.id === ref.template_id);
        const delivery = template ? effectiveOutputDelivery(template) : null;
        const duePhase = Object.hasOwn(ref, "phase")
          ? `phase: ${ref.phase}`
          : "phase: legacy all-due";
        return `${ref.artifact_type}:${ref.template_id}:${ref.mode} (${duePhase})${delivery ? ` -> ${delivery.label} ${delivery.extension}, ${delivery.mode}` : ""}`;
      })
    : [];
  const sourceEvidence = contextSources
    .slice(0, 8)
    .map((sourcePath) => {
      const excerpt = readProjectFileExcerpt(context, sourcePath, 220);
      return excerpt ? `${sourcePath}: ${excerpt}` : `${sourcePath}: unavailable or non-text evidence`;
    });
  return [
    contract.story_id ? `Story: ${contract.story_id}` : "Scope: project",
    contract.purpose ? `Purpose: ${contract.purpose}` : null,
    contextualization.summary ? `Context: ${contextualization.summary}` : null,
    contextSources.length ? `Context sources: ${contextSources.join(", ")}` : null,
    sourceEvidence.length ? `What those sources say: ${sourceEvidence.join(" | ")}` : null,
    answeredQuestions.length ? `Recorded answers: ${answeredQuestions.join("; ")}` : null,
    openQuestions.length ? `Open questions: ${openQuestions.join("; ")}` : null,
    outputRefs.length ? `Expected outputs: ${outputRefs.join(", ")}` : null,
    contract.validation?.length ? `Validation: ${contract.validation.slice(0, 4).join("; ")}` : null,
    contract.allowed_tools?.length ? `Allowed tools: ${contract.allowed_tools.slice(0, 6).join(", ")}` : null,
  ].filter(Boolean);
}

export function defaultHumanActorId(root) {
  return process.env.CODEX_USER_ID || process.env.USER || process.env.GIT_AUTHOR_NAME || gitConfigValue(root, "user.name") || "human";
}

export function storyAcceptanceRecoveryGuidance(options, storyId, {
  changed,
  contractReviewRequired,
  previousContractId,
  deliveryProfileIds,
} = {}) {
  const italian = humanGuidanceLocale(options) === "it";
  const reviewRequired = contractReviewRequired || deliveryProfileIds.length > 0;
  const result = changed
    ? (italian
        ? "La story richiesta ora include i criteri di successo aggiunti."
        : "The requested story now includes the added success criteria.")
    : (italian
        ? "La story richiesta conteneva già tutti i criteri indicati."
        : "The requested story already contained every supplied criterion.");
  return {
    result,
    impact: reviewRequired
      ? (italian
          ? "La definizione è cambiata: il precedente accordo di lavoro e ogni scelta di consegna precedente non autorizzano più l’avvio."
          : "The definition changed, so the previous work agreement and every earlier delivery choice no longer authorize work.")
      : (italian
          ? "Non esistono accordi di lavoro o scelte di consegna precedenti da rinnovare."
          : "There is no earlier work agreement or delivery choice to renew."),
    required_decision: reviewRequired
      ? (italian
          ? "Rivedi i nuovi criteri, quindi approva un nuovo accordo di lavoro e, se richiesto, fai una nuova scelta per questa consegna."
          : "Review the new criteria, then approve a new work agreement and, when requested, make a new choice for this delivery.")
      : (italian
          ? "Non serve una nuova decisione prima di preparare l’accordo di lavoro."
          : "No new decision is needed before preparing the work agreement."),
    protection_boundary: italian
      ? "Il lavoro resta bloccato; requisiti, suddivisione, fase, stato, piano e diario non sono stati riscritti."
      : "Work remains blocked; requirements, breakdown, phase, status, plan, and log were not rewritten.",
    next_action: reviewRequired
      ? (italian
          ? "Prepara e approva un nuovo accordo, rinnova la scelta di consegna quando richiesto, poi prova di nuovo ad avviare il lavoro."
          : "Prepare and approve a new agreement, renew the delivery choice when requested, then try starting the work again.")
      : (italian
          ? "Continua preparando l’accordo di lavoro governato."
          : "Continue by preparing the governed work agreement."),
    details: {
      story_id: storyId,
      contract_review_required: Boolean(contractReviewRequired),
      previous_contract_id: previousContractId || null,
      stale_delivery_profile_ids: deliveryProfileIds,
    },
  };
}

export function showBreakdownStatus(context, options) {
  ensureInitialized(context);
  const requirementId = options.requirement ? normalizeId(String(options.requirement)) : null;
  const breakdowns = readBreakdowns(context).filter(
    (breakdown) => !requirementId || breakdown.requirement_id === requirementId,
  );
  output(
    options,
    { breakdowns },
    breakdowns.length
      ? breakdowns.map((breakdown) => `${breakdown.id}: ${breakdown.status} (${breakdown.requirement_id})`)
      : ["No breakdown records found."],
  );
}

export function showDependencyStatus(context, options) {
  ensureInitialized(context);
  const storyId = options.story ? normalizeId(String(options.story)) : null;
  const status = buildDependencyStatus(context, storyId);
  output(
    options,
    status,
    storyId
      ? [`Dependencies for ${storyId}: ${status.edges.length}`, ...status.blockers.map((item) => `BLOCKER ${item}`), ...status.warnings.map((item) => `WARN ${item}`)]
      : [`Dependency edges: ${status.edges.length}`, `Blockers: ${status.blockers.length}`, `Warnings: ${status.warnings.length}`],
  );
}

export function buildDependencyStatus(context, storyId = null, query = null) {
  const graph = query?.graph || readDependencyGraph(context, { missingOk: true });
  const edges = query?.edges_by_story && storyId
    ? query.edges_by_story.get(storyId) || []
    : (graph.edges || []).filter((edge) => !storyId || edge.from === storyId || edge.to === storyId);
  const blockers = [];
  const warnings = [];
  for (const edge of edges) {
    if (storyId && edge.from !== storyId) {
      warnings.push(`${edge.from} depends on ${edge.to} via ${edge.type}`);
      continue;
    }
    // Status and orchestration expose blockers for upcoming phases. Phase-aware
    // enforcement is applied by the story gate, which passes the current story.
    const state = inspectDependencyEdge(context, edge, null, query);
    if (state.blocking && !state.satisfied) {
      blockers.push(state.message);
    } else if (!state.satisfied) {
      warnings.push(state.message);
    } else if (!isHardDependencyEdge(edge)) {
      warnings.push(state.message);
    }
  }
  const cycles = query?.cycles || findBlockingDependencyCycles(graph.edges || []);
  for (const cycle of cycles) {
    blockers.push(`blocking dependency cycle: ${cycle.join(" -> ")}`);
  }
  return {
    graph_path: dependencyGraphPath(context),
    story_id: storyId,
    edges,
    blockers,
    warnings,
    cycles,
  };
}

export function showCacheStatus(context, options) {
  ensureInitialized(context);
  const status = getCacheStatus(context);
  output(
    options,
    options.full ? status : buildCompactCacheStatus(status),
    [
      status.exists ? `Cache: ${status.valid ? "valid" : "stale"}` : "Cache: missing",
      `Path: ${status.cache_path}`,
      `Changed: ${status.changed.length}`,
      `Missing: ${status.missing.length}`,
      `Added: ${status.added.length}`,
      status.valid ? "No rebuild required" : "Run: agentic-sdlc cache rebuild",
    ],
  );
}

export function buildReportQueryNormalizationGuidance(options, queryLoad) {
  return {
    kind: "report_query_normalization",
    status: "needs_normalization",
    schema_version: "report-query:v1",
    raw_text: queryLoad.raw_text,
    rule: "Codex or another LLM must normalize natural language into canonical query JSON. The CLI never keyword-matches raw user language.",
    required_shape: {
      intent: "find_records",
      confidence: 0.0,
      subjects: ["activity"],
      time: { since: "10d", until: "now", field: "created_at" },
      filters: {
        actor: ["actor-id-or-email"],
        executor: ["agent-or-human-who-ran-the-action"],
        requester: ["human-or-system-who-requested-the-action"],
        authorizer: ["human-or-ci-who-authorized-the-action"],
        story_id: ["ST-001"],
        artifact_type: ["functional-analysis"],
        event_type: ["decision"],
        action: ["story.create"],
        phase: ["analysis"],
        status: ["draft"],
        requirement: ["REQ-001"],
        text: ["search term"],
      },
      sort: "created_at_desc",
      limit: 50,
    },
    examples: [
      {
        natural_language: "all changes made by me",
        query: {
          intent: "find_changes",
          confidence: 0.9,
          subjects: ["activity", "stories", "outputs", "contracts", "approvals"],
          filters: { requester: ["<current-user-id-or-email>"] },
          sort: "created_at_desc",
        },
      },
      {
        natural_language: "all new functional stories from the last 10 days",
        query: {
          intent: "find_new_functional_stories",
          confidence: 0.9,
          subjects: ["stories"],
          time: { since: "10d", until: "now", field: "created_at" },
          filters: { artifact_type: ["functional-analysis"], text: ["functional"] },
          sort: "created_at_desc",
        },
      },
    ],
  };
}

export function getCacheStatus(context) {
  const cachePath = path.join(context.sdlcRoot, "cache", CACHE_FILE_NAME);
  const exists = fs.existsSync(cachePath);
  if (!exists) {
    return {
      exists: false,
      valid: false,
      stale: true,
      cache_path: cachePath,
      changed: [],
      missing: [],
      added: [],
      schema_mismatch: false,
      cache: null,
    };
  }

  let cache;
  try {
    cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  } catch (error) {
    return {
      exists: true,
      valid: false,
      stale: true,
      cache_path: cachePath,
      changed: [],
      missing: [],
      added: [],
      schema_mismatch: false,
      parse_error: error.message,
      generated_at: null,
      cache: null,
    };
  }
  const currentHashes = collectKnowledgeSourceSnapshot(
    context,
    openProjectQuerySession(context),
  ).source_hashes;
  const cachedHashes = cache.source_hashes || {};
  const currentPaths = new Set(Object.keys(currentHashes));
  const cachedPaths = new Set(Object.keys(cachedHashes));
  const changed = [];
  const missing = [];
  const added = [];

  for (const cachedPath of cachedPaths) {
    if (!currentPaths.has(cachedPath)) {
      missing.push(cachedPath);
    } else if (cachedHashes[cachedPath] !== currentHashes[cachedPath]) {
      changed.push(cachedPath);
    }
  }
  for (const currentPath of currentPaths) {
    if (!cachedPaths.has(currentPath)) {
      added.push(currentPath);
    }
  }
  const schemaMismatch = cache.schema_version !== context.config.schema_version;
  const structureErrors = validateCacheMetadata(context, cache);
  const valid = changed.length === 0 && missing.length === 0 && added.length === 0 && !schemaMismatch && structureErrors.length === 0;
  return {
    exists: true,
    valid,
    stale: !valid,
    cache_path: cachePath,
    changed,
    missing,
    added,
    schema_mismatch: schemaMismatch,
    structure_errors: structureErrors,
    generated_at: cache.generated_at || null,
    cache,
  };
}

export function showStatus(context, options) {
  ensureInitialized(context);
  const counts = {};
  for (const directory of context.config.kb_directories) {
    const dirPath = path.join(context.sdlcRoot, directory);
    counts[directory] = directory === "contracts"
      ? collectJsonFiles(context, dirPath).filter((contract) => !isIntactBootstrapPhaseContract(context, contract)).length
      : countCanonicalRecords(directory, dirPath);
  }
  const project = readProjectJson(context, path.join(context.sdlcRoot, "project.json"));
  const orchestration = buildOrchestrationSnapshot(context);
  const approvalRequests = collectApprovalRequests(context);
  const pendingDecisions = approvalRequests.filter((request) =>
    request.status !== "needs_internal_refresh"
    && request.status !== "needs_refresh"
    && !String(request.type || "").endsWith("_refresh_required"));
  const internalRefreshes = approvalRequests.length - pendingDecisions.length;
  const summary = {
    pending_decisions: pendingDecisions.length,
    internal_refreshes: internalRefreshes,
    available_work: orchestration.summary.available,
    active_work: orchestration.summary.claimed,
    blocked_work: orchestration.summary.blocked,
    stale_claims: orchestration.summary.stale,
    completed_work: orchestration.summary.terminal,
  };
  const nextAction = buildStatusNextAction(context, summary, orchestration, counts, project);
  const italian = humanGuidanceLocale(options) === "it";
  const guidance = statusHumanGuidance(nextAction, summary, { italian });
  const payload = {
    schema_version: "cli-status:v1",
    project,
    counts,
    summary,
    next_action: nextAction,
    ...(options.full ? {
      pending_decision_items: pendingDecisions,
      internal_refresh_items: approvalRequests.filter((request) => !pendingDecisions.includes(request)),
      orchestration,
    } : {}),
  };
  output(
    options,
    payload,
    humanGuidanceLines(guidance, [
      `${italian ? "Progetto" : "Project"}: ${project.project_name} (${project.project_id})`,
      `${italian ? "Tipo di prossimo passo" : "Next-action kind"}: ${nextAction.kind}`,
      `${italian ? "Motivo tecnico" : "Technical reason"}: ${nextAction.reason}`,
      `${italian ? "Comando suggerito" : "Suggested command"}: ${nextAction.command || (italian ? "nessuno" : "none")}`,
      ...Object.entries(summary).map(([key, value]) => `${key}: ${value}`),
      ...(options.full ? Object.entries(counts).map(([key, value]) => `${key}: ${value}`) : []),
    ], options),
  );
}

export function statusCliCommand(...args) {
  const cliPath = path.join(PLUGIN_ROOT, "bin", "agentic-sdlc.mjs");
  return [
    "node",
    JSON.stringify(cliPath),
    ...args.map((value) => (
      /^[A-Za-z0-9._:@/=-]+$/u.test(String(value))
        ? String(value)
        : JSON.stringify(String(value))
    )),
  ].join(" ");
}

export function buildStatusNextAction(context, summary, orchestration, counts, project) {
  if (summary.pending_decisions > 0) {
    for (const story of orchestration.stories.filter((item) =>
      ["available", "claimed"].includes(item.orchestration_state))) {
      const workflowNextAction = buildStoryWorkflowNextAction(context, story);
      if ([
        "seal_strict_gate",
        "repair_strict_gate_evidence",
        "repair_output_link",
        "reapprove_output_template",
      ].includes(workflowNextAction?.kind)) {
        return workflowNextAction;
      }
    }
    return {
      kind: "review_decision",
      reason: "pending_human_decision",
      label: "Review the pending project decision.",
      command: statusCliCommand("approval", "requests"),
      protected: true,
    };
  }
  if (summary.blocked_work > 0) {
    const story = orchestration.stories.find((item) => item.orchestration_state === "blocked");
    const workflowNextAction = story
      ? buildStoryWorkflowNextAction(context, story)
      : null;
    if (
      story?.lifecycle_source !== "story_record"
      && workflowNextAction
    ) {
      return workflowNextAction;
    }
    return {
      kind: "resolve_blocker",
      reason: "blocked_story",
      label: "Resolve the first blocked story.",
      command: story
        ? statusCliCommand("story", "deps", "--id", story.id)
        : statusCliCommand("orchestrate", "status"),
      protected: false,
      story_id: story?.id || null,
    };
  }
  if (summary.stale_claims > 0) {
    const story = orchestration.stories.find((item) => item.orchestration_state === "stale");
    return {
      kind: "repair_claim",
      reason: "stale_claim",
      label: "Repair the stale work reservation.",
      command: story
        ? statusCliCommand("story", "release", "--id", story.id)
        : statusCliCommand("orchestrate", "status"),
      protected: true,
      story_id: story?.id || null,
    };
  }
  const operationalStories = orchestration.stories.filter((item) =>
    ["available", "claimed"].includes(item.orchestration_state));
  for (const story of operationalStories) {
    const workflowNextAction = buildStoryWorkflowNextAction(context, story);
    if (workflowNextAction) return workflowNextAction;
  }
  if (summary.completed_work > 0) {
    return {
      kind: "none",
      reason: "completed_work_terminal",
      label:
        `${summary.completed_work} governed work item${summary.completed_work === 1 ? " is" : "s are"} `
        + "terminal; no operational work is waiting.",
      command: null,
      protected: false,
      terminal_work: summary.completed_work,
    };
  }
  const baselines = readBaselines(context);
  if (baselines.length === 0) {
    const hasExistingEvidence =
      discoverExistingProjectDocuments(context).length > 0
      || detectProjectStack(context).length > 0;
    if (hasExistingEvidence) {
      return {
        kind: "onboard_project",
        reason: "project_context_not_onboarded",
        label: "Onboard the existing project context, then review what was inferred.",
        command: statusCliCommand(
          "onboard", "existing-project",
          "--root", context.root,
          "--project-name", project.project_name,
        ),
        protected: true,
      };
    }
  }
  if ((counts.requirements || 0) === 0) {
    return {
      kind: "agree_requirement",
      reason: "requirement_not_described",
      label: "Describe the required outcome, observable success, exclusions, and maximum independence.",
      command: null,
      protected: true,
    };
  }
  return {
    kind: "none",
    reason: "no_operational_work",
    label: "No operational work is waiting.",
    command: null,
    protected: false,
  };
}

export function statusHumanGuidance(nextAction, summary, options = {}) {
  const { italian = false } = options;
  const copy = italian
    ? {
        review_decision: {
          result: "C’è una decisione in attesa.",
          impact: "Il lavoro interessato resta fermo finché la scelta non viene chiarita.",
          decision: "Controlla la scelta proposta e approvala oppure chiedi una modifica.",
          next: "Apri il riepilogo della decisione in attesa.",
        },
        resolve_blocker: {
          result: "Alcune attività non possono ancora procedere.",
          impact: "Prima di continuare bisogna risolvere almeno un impedimento già rilevato.",
          decision: "Non serve approvare un’eccezione; scegli se correggere o chiarire l’impedimento.",
          next: "Esamina il primo impedimento e risolvilo.",
        },
        repair_claim: {
          result: "Una prenotazione di lavoro non è più attuale.",
          impact: "Nessun nuovo lavoro dovrebbe partire su quella prenotazione finché non viene sistemata.",
          decision: "Decidi se chiudere la prenotazione vecchia o riassegnare il lavoro.",
          next: "Controlla la prenotazione non più attuale.",
        },
        start_story_workflow: {
          result: "La storia è pronta, ma il suo processo governato non è ancora iniziato.",
          impact: "Avviandolo ora, ogni fase resterà collegata al task e alla certificazione finale.",
          decision: "Non serve cambiare l’ambito; conferma soltanto il processo proposto per questa storia.",
          next: "Avvia il workflow prima del task e del primo step completato.",
        },
        define_custom_workflow: {
          result: "Le fasi configurate non corrispondono al workflow software incluso.",
          impact: "Serve una definizione approvata con lo stesso ordine esatto, incluse le fasi personalizzate.",
          decision: "Rivedi e approva la definizione personalizzata prima di iniziare il task.",
          next: "Crea la definizione usando l’ordine delle fasi mostrato.",
        },
        advance_story_workflow: {
          result: "La fase corrente è completata e il workflow può avanzare.",
          impact: "La transizione conserva l’ordine verificabile tra completamento e ingresso nella fase successiva.",
          decision: "Non serve ampliare l’ambito; esegui soltanto la transizione indicata.",
          next: "Avanza alla fase successiva.",
        },
        repair_output_link: {
          result: "Il risultato collegato non corrisponde più al file o alla prova corrente.",
          impact: "Il gate strict resta bloccato finché il collegamento non viene rigenerato con fingerprint e verifica aggiornati.",
          decision: "Conferma che il file corrente è quello da consegnare; non cambia l’ambito approvato.",
          next: "Rigenera il collegamento indicato, poi riesegui il gate strict.",
        },
        repair_strict_gate_evidence: {
          result: "Una o più prove correnti del progetto non superano più la validazione strict.",
          impact: "Il workflow resta bloccato prima del release; il comando suggerito è diagnostico e mostrerà i blocker senza superarli.",
          decision: "Correggi soltanto i record o i file indicati, senza ampliare l’ambito approvato.",
          next: "Esegui la diagnosi strict, correggi i blocker elencati e solo dopo riesegui il gate.",
        },
        reapprove_output_template: {
          result: "Il formato di output approvato è cambiato.",
          impact: "La vecchia approvazione e i collegamenti basati su quel formato non sono più validi.",
          decision: "Rivedi il formato corrente e approvalo esplicitamente solo se è quello desiderato.",
          next: "Approva il template corrente, rigenera i collegamenti elencati e poi riesegui il gate strict.",
        },
        seal_strict_gate: {
          result: "La validazione è completata; manca il controllo intermedio prima del release.",
          impact: "La ricevuta strict consente l’ingresso governato nella fase release.",
          decision: "Correggi eventuali blocchi del gate; non chiudere ancora la delivery.",
          next: "Esegui il gate strict intermedio.",
        },
        certify_lifecycle: {
          result: "Il workflow è nella fase terminale.",
          impact: "La certificazione finale verificherà timeline, evidenze di release e delivery locale chiusa.",
          decision: "Eseguila solo quando release e rollback risultano verificati.",
          next: "Esegui la certificazione lifecycle-complete.",
        },
        recertify_lifecycle: {
          result: "La ricevuta finale esiste, ma non corrisponde più alle evidenze governate correnti.",
          impact: "La story resta bloccata e non torna terminale finché un nuovo gate non verifica e sigilla lo stato attuale.",
          decision: "Ripara soltanto le evidenze indicate dal gate; non ampliare l’ambito e non sostituire output certificati.",
          next: "Esegui il gate lifecycle-complete mostrato: diagnosticherà eventuali problemi e risigillerà solo se tutto è valido.",
        },
        complete_release_evidence: {
          result: "Il workflow è entrato in release, ma le prove finali non sono complete.",
          impact: "Il gate finale resta intenzionalmente bloccato finché delivery, trace e step di release non concordano.",
          decision: "Completa soltanto la consegna locale e le prove già approvate.",
          next: "Completa gli elementi di release indicati prima della certificazione.",
        },
        release_story_claim: {
          result: "La consegna e le prove di release sono complete; resta aperta la prenotazione della story.",
          impact: "La certificazione finale resta bloccata finché il lavoro completato risulta ancora assegnato come attivo.",
          decision: "Rilascia soltanto la prenotazione della story; non cambia l’ambito e non pubblica nulla.",
          next: "Rilascia la prenotazione, poi esegui la certificazione finale.",
        },
        continue_assessment: {
          result: "Questa attività appartiene a una assessment governata.",
          impact: "Scope, budget, verifiche e chiusura restano nel workflow della proposta approvata.",
          decision: "Non creare un workflow software retroattivo; continua soltanto la assessment già autorizzata.",
          next: "Controlla lo stato della proposta e segui il suo prossimo checkpoint.",
        },
        lifecycle_not_certifiable: {
          result: "Questo task legacy non ha un workflow collegato prima dell’avvio.",
          impact: "Il lavoro può restare leggibile, ma un replay creato ora non può ottenere la certificazione finale.",
          decision: "Decidi se conservare il percorso legacy o riavviare correttamente una nuova esecuzione governata.",
          next: "Non creare un workflow retroattivo.",
        },
        inspect_story_workflow: {
          result: "Il workflow esiste e richiede il prossimo passo della fase corrente.",
          impact: "Il controllo mostra stato, condizioni e transizione ammessa senza modificare il progetto.",
          decision: "Completa la fase corrente prima di avanzare.",
          next: "Controlla lo stato del workflow.",
        },
        start_available_work: {
          result: "C’è lavoro pronto per essere avviato.",
          impact: "È possibile preparare la prossima attività senza sovrapporsi a lavoro già in corso.",
          decision: "Non devi decidere altro per questo controllo; l’avvio applicherà le regole della singola consegna.",
          next: "Avvia la prima attività disponibile.",
        },
        continue_active_work: {
          result: "Il lavoro è già in corso.",
          impact: "La priorità è completare e verificare l’attività aperta prima di iniziarne un’altra.",
          decision: "Non devi prendere una nuova decisione per questo controllo.",
          next: "Continua l’attività aperta e verifica il prossimo risultato.",
        },
        onboard_project: {
          result: "Il progetto esiste, ma il suo contesto non è ancora stato confermato.",
          impact: "Posso leggere le prove locali e proporre un riepilogo senza inventare requisiti.",
          decision: "Dopo la proposta, conferma cosa è corretto o indica la correzione esatta.",
          next: "Prepara il contesto iniziale del progetto esistente.",
        },
        agree_requirement: {
          result: "Il progetto è pronto a ricevere il primo risultato richiesto.",
          impact: "Nessuna storia o attività viene inventata prima di aver concordato il bisogno.",
          decision: "Descrivi risultato osservabile, criteri di completamento, esclusioni e massima autonomia.",
          next: "Concorda il primo requisito prima della scomposizione.",
        },
        completed_work_terminal: {
          result: "Il lavoro governato è completo.",
          impact: "Tutto il lavoro registrato è terminale; non sono in attesa attività operative incomplete né un nuovo onboarding.",
          decision: "Non devi approvare nulla né ripetere l’onboarding per questa consegna completata.",
          next: "Apri un nuovo requisito solo quando vuoi ottenere un altro risultato.",
        },
        none: {
          result: "Non ci sono attività operative in attesa.",
          impact: "Il progetto non richiede un’azione immediata.",
          decision: "Non devi decidere nulla in questo momento.",
          next: "Ripeti il controllo quando cambia lo stato del progetto.",
        },
      }
    : {
        review_decision: {
          result: "A decision is waiting for review.",
          impact: "The affected work remains paused until the choice is clarified.",
          decision: "Review the proposed choice and either approve it or request a change.",
          next: "Open the pending decision summary.",
        },
        resolve_blocker: {
          result: "Some work cannot proceed yet.",
          impact: "At least one known obstacle must be resolved before work can continue.",
          decision: "Do not approve an exception; choose whether to correct or clarify the obstacle.",
          next: "Review and resolve the first obstacle.",
        },
        repair_claim: {
          result: "A work reservation is no longer current.",
          impact: "No new work should start on that reservation until it is repaired.",
          decision: "Choose whether to close the old reservation or reassign the work.",
          next: "Review the outdated work reservation.",
        },
        start_story_workflow: {
          result: "The story is ready, but its governed workflow has not started.",
          impact: "Starting it now binds every phase to task start and final certification.",
          decision: "No scope change is needed; confirm only this story workflow.",
          next: "Start the workflow before task start or the first completed step.",
        },
        define_custom_workflow: {
          result: "The configured phases do not match the included software workflow.",
          impact: "An approved definition with the exact same order must include every custom phase.",
          decision: "Review and approve that custom definition before task start.",
          next: "Define the workflow with the displayed phase order.",
        },
        advance_story_workflow: {
          result: "The current phase is complete and the workflow can advance.",
          impact: "The transition preserves verifiable ordering between phase completion and the next entry.",
          decision: "No scope expansion is needed; run only the indicated transition.",
          next: "Advance to the next phase.",
        },
        repair_output_link: {
          result: "The linked deliverable no longer matches the current file or verification evidence.",
          impact: "The strict gate remains blocked until the link is regenerated with current fingerprints and verification.",
          decision: "Confirm that the current file is the intended deliverable; this does not expand the approved scope.",
          next: "Refresh the indicated output link, then run the strict gate again.",
        },
        repair_strict_gate_evidence: {
          result: "One or more current project records no longer pass strict validation.",
          impact: "The workflow remains blocked before release; the suggested command is diagnostic and will show blockers rather than pass them.",
          decision: "Repair only the listed records or files without expanding the approved scope.",
          next: "Run the strict diagnostic, repair the listed blockers, and only then run the gate again.",
        },
        reapprove_output_template: {
          result: "The approved output format has changed.",
          impact: "The prior approval and links bound to that format are no longer current.",
          decision: "Review the current format and explicitly approve it only if it is the intended one.",
          next: "Approve the current template, refresh the listed links, then run the strict gate again.",
        },
        seal_strict_gate: {
          result: "Validation is complete; the intermediate release-entry check is pending.",
          impact: "Its strict receipt permits a governed transition into release.",
          decision: "Fix any gate blockers; do not close delivery yet.",
          next: "Run the intermediate strict gate.",
        },
        certify_lifecycle: {
          result: "The workflow is in its terminal phase.",
          impact: "Final certification will verify the timeline, release evidence, and closed local delivery.",
          decision: "Run it only after release and rollback evidence are verified.",
          next: "Run lifecycle-complete certification.",
        },
        recertify_lifecycle: {
          result: "The final receipt exists, but it no longer matches the current governed evidence.",
          impact: "The story remains blocked and cannot become terminal again until a new gate verifies and seals the current state.",
          decision: "Repair only the evidence reported by the gate; do not expand scope or replace certified outputs.",
          next: "Run the displayed lifecycle-complete gate; it diagnoses remaining issues and reseals only when everything is valid.",
        },
        complete_release_evidence: {
          result: "The workflow has entered release, but final evidence is incomplete.",
          impact: "The final gate remains intentionally blocked until delivery, release trace, and release step agree.",
          decision: "Complete only the already approved local delivery and evidence.",
          next: "Complete the listed release evidence before certification.",
        },
        release_story_claim: {
          result: "The delivery and release evidence are complete; the story reservation is still active.",
          impact: "Final certification remains blocked while completed work is still claimed as active.",
          decision: "Release only the story reservation; this does not change scope or publish anything.",
          next: "Release the reservation, then run final certification.",
        },
        continue_assessment: {
          result: "This work belongs to a governed assessment.",
          impact: "Scope, budget, verification, and completion remain in the approved proposal workflow.",
          decision: "Do not create a retroactive software workflow; continue only the already authorized assessment.",
          next: "Inspect the proposal status and follow its next checkpoint.",
        },
        lifecycle_not_certifiable: {
          result: "This legacy task has no workflow bound before start.",
          impact: "The work remains readable, but a workflow replay created now cannot earn final certification.",
          decision: "Choose whether to retain the legacy path or begin a new correctly governed run.",
          next: "Do not create a retroactive workflow.",
        },
        inspect_story_workflow: {
          result: "The workflow exists and awaits the current phase result.",
          impact: "Status shows its checks and allowed transition without changing the project.",
          decision: "Complete the current phase before advancing.",
          next: "Inspect the workflow state.",
        },
        start_available_work: {
          result: "Work is ready to start.",
          impact: "The next activity can be prepared without overlapping work already in progress.",
          decision: "You do not need to decide anything else for this check; starting will apply the rules for that one delivery.",
          next: "Start the first available activity.",
        },
        continue_active_work: {
          result: "Work is already in progress.",
          impact: "The priority is to complete and verify the open activity before starting another one.",
          decision: "You do not need to make a new decision for this check.",
          next: "Continue the open activity and verify its next result.",
        },
        onboard_project: {
          result: "The project exists, but its current context has not been confirmed yet.",
          impact: "I can inspect local evidence and propose a summary without inventing requirements.",
          decision: "After the proposal, confirm what is accurate or state the exact correction.",
          next: "Prepare the initial context for this existing project.",
        },
        agree_requirement: {
          result: "The project is ready for its first requested outcome.",
          impact: "No story or task is invented before the need is agreed.",
          decision: "Describe the observable outcome, completion checks, exclusions, and maximum independence.",
          next: "Agree the first requirement before decomposition.",
        },
        completed_work_terminal: {
          result: "Governed work is complete.",
          impact: "All recorded work is terminal; no unfinished operational work or new onboarding step is waiting.",
          decision: "You do not need to approve anything or repeat onboarding for this completed delivery.",
          next: "Open a new requirement only when you want another outcome.",
        },
        none: {
          result: "There is no operational work waiting.",
          impact: "The project does not need an immediate action.",
          decision: "You do not need to decide anything now.",
          next: "Check again when the project state changes.",
        },
      };
  const selected = nextAction.reason === "completed_work_terminal"
    ? copy.completed_work_terminal
    : copy[nextAction.kind] || copy.none;
  return Object.freeze({
    result: selected.result,
    impact: selected.impact,
    required_decision: selected.decision,
    protection_boundary: italian
      ? "Questo controllo ha letto lo stato del progetto; non ha modificato file, pubblicato, rilasciato o eseguito merge."
      : "This check only read project state; it did not change files, publish, release, or merge anything.",
    next_action: selected.next,
    details: Object.freeze({
      guidance_kind: "project_status",
      next_action: nextAction,
      summary,
    }),
  });
}

export function showOrchestrationStatus(context, options) {
  ensureInitialized(context);
  const snapshot = buildOrchestrationSnapshot(context);
  output(
    options,
    snapshot,
    [
      `Stories: ${snapshot.summary.total}`,
      `Available: ${snapshot.summary.available}`,
      `Claimed: ${snapshot.summary.claimed}`,
      `Blocked: ${snapshot.summary.blocked}`,
      `Stale: ${snapshot.summary.stale}`,
      `Terminal: ${snapshot.summary.terminal}`,
      `Active locks: ${snapshot.summary.active_locks}`,
      ...snapshot.stories.map((story) => {
        const owner = story.claim?.agent ? ` by ${story.claim.agent}` : "";
        const branch = story.claim?.branch ? ` on ${story.claim.branch}` : "";
        return `${story.id}: ${story.orchestration_state}${owner}${branch} (${story.phase})`;
      }),
    ],
  );
}

export function getIndexStatus(context) {
  const indexPath = path.join(context.sdlcRoot, "indexes", "kb-index.json");
  if (!fs.existsSync(indexPath)) {
    return { exists: false, valid: false, index_path: indexPath, index: null };
  }
  let index;
  try {
    index = readProjectJson(context, indexPath);
  } catch {
    return { exists: true, valid: false, index_path: indexPath, index: null };
  }
  const currentHashes = collectKnowledgeSourceSnapshot(
    context,
    openProjectQuerySession(context),
  ).source_hashes;
  const cachedHashes = index.source_hashes || {};
  const valid =
    index.schema_version === context.config.schema_version &&
    Object.keys(currentHashes).length === Object.keys(cachedHashes).length &&
    Object.entries(currentHashes).every(([sourcePath, hash]) => cachedHashes[sourcePath] === hash);
  return { exists: true, valid, index_path: indexPath, index };
}
