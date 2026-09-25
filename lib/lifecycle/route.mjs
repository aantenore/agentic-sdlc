import path from "node:path";
import {
  normalizeArtifactType,
  normalizeId,
  normalizeListValue,
  normalizeStringArray,
  pushAllUnique,
} from "./common.mjs";
import {
  ROUTE_REQUIRED_INTENT_FIELDS,
} from "./constants.mjs";
import {
  autonomyRoot,
} from "./project.mjs";

export function isAssessmentRouteIntent(context, routeDecision) {
  const configured = normalizeListValue(context.config.assessment_workflow?.requested_actions, [
    "functional_analysis",
    "technical_analysis",
    "technical_assessment",
    "initial_technical_assessment",
    "project_technical_assessment",
    "project_assessment",
    "architecture_assessment",
    "technical_review",
  ]).map(normalizeRouteToken);
  return configured.includes(normalizeRouteToken(routeDecision.intent?.requested_action || ""));
}

export function inferTaskPhase(routeDecision, options = {}) {
  const explicitPhase = options.phase ? normalizeRoutePhase(options.phase) : null;
  if (explicitPhase) {
    return explicitPhase;
  }
  const intentPhase = routeDecision.intent?.proposed_phase || null;
  if (intentPhase) {
    return intentPhase;
  }
  switch (routeDecision.route) {
    case "intake_requirement":
      return "discovery";
    case "decompose_stories":
      return "design";
    case "classify_artifact":
    case "discover_capabilities":
    case "technical_decision":
      return "analysis";
    case "claim_and_implement":
      return "implementation";
    case "validate_story":
      return "validation";
    case "release_story":
      return "release";
    default:
      return null;
  }
}

export function taskRouteRequiresContract(route) {
  return [
    "classify_artifact",
    "discover_capabilities",
    "technical_decision",
    "claim_and_implement",
    "validate_story",
    "release_story",
  ].includes(route);
}

export function taskStartAutonomyCopy(deliveryKind, locale = "en") {
  const italian = locale === "it";
  const localRelease = deliveryKind === "local_release";
  return italian
    ? {
        question: localRelease
          ? "Per questo rilascio locale, quanto vuoi che lavori in autonomia?"
          : "Per questa PR, quanto vuoi che lavori in autonomia?",
        choices: [
          "Guidato: ti chiedo conferma prima dei passaggi importanti.",
          "Autonomia con controlli: procedo da solo, ma mi fermo prima delle azioni delicate concordate.",
          localRelease
            ? "Autonomia completa entro questi limiti: completo questo rilascio locale senza pause ordinarie."
            : "Autonomia completa entro questi limiti: completo questa PR senza pause ordinarie.",
        ],
        scope: localRelease
          ? "Questa scelta vale solo per questo rilascio locale e non sarà riutilizzata."
          : "Questa scelta vale solo per questa PR e non sarà riutilizzata.",
      }
    : {
        question: localRelease
          ? "For this local release, how independently should I work?"
          : "For this pull request, how independently should I work?",
        choices: [
          "Guided: I ask for confirmation before important steps.",
          "Autonomy with checks: I proceed independently, but stop before the sensitive actions we agree.",
          localRelease
            ? "Full autonomy within these limits: I complete this local release without routine pauses."
            : "Full autonomy within these limits: I complete this pull request without routine pauses.",
        ],
        scope: localRelease
          ? "This choice applies only to this local release and will not be reused."
          : "This choice applies only to this pull request and will not be reused.",
      };
}

export function taskStartAutonomyChoiceLines(decision, italian) {
  if (decision.contract_action !== "select_delivery_autonomy") return [];
  const locale = italian ? "it" : "en";
  const choiceLines = (kind) => {
    const copy = taskStartAutonomyCopy(kind, locale);
    return [
      copy.question,
      ...copy.choices.map((choice, index) => `${index + 1}. ${choice}`),
      copy.scope,
    ];
  };
  if (decision.delivery_kind) return ["", ...choiceLines(decision.delivery_kind)];
  return [
    "",
    italian
      ? "Prima indica la destinazione esatta di questa consegna. Dopo che sarà definita, ti mostrerò una sola domanda con le tre scelte applicabili."
      : "First identify this delivery's exact destination. Once it is defined, I will show one question with the three applicable choices.",
  ];
}

export function defaultRouteActions() {
  const technicalAnalysisAction = () => ({
    route: "classify_artifact",
    confirmation_key: "create_canonical_artifact",
    default_artifact_type: "technical-analysis",
    requires_artifact_type: true,
  });
  return {
    initialize_project: { route: "init_project" },
    init_project: { route: "init_project" },
    onboard_existing_project: { route: "onboard_existing_project" },
    existing_project_onboarding: { route: "onboard_existing_project" },
    create_baseline: { route: "onboard_existing_project", confirmation_key: "create_canonical_artifact" },
    intake_requirement: { route: "intake_requirement" },
    classify_artifact: { route: "classify_artifact", requires_artifact_type: true },
    decompose_stories: { route: "decompose_stories", confirmation_key: "create_story" },
    create_story: { route: "decompose_stories", confirmation_key: "create_story" },
    create_contract: { route: "create_contract" },
    discover_capabilities: {
      route: "discover_capabilities",
      confirmation_key: "discover_capabilities",
    },
    capability_discovery: {
      route: "discover_capabilities",
      confirmation_key: "discover_capabilities",
    },
    technical_decision: {
      route: "technical_decision",
      confirmation_key: "create_canonical_artifact",
      default_artifact_type: "technical-decision-matrix",
    },
    implement_story: {
      route: "claim_and_implement",
      confirmation_key: "start_implementation",
      requires_story: true,
      requires_contract: true,
    },
    start_implementation: {
      route: "claim_and_implement",
      confirmation_key: "start_implementation",
      requires_story: true,
      requires_contract: true,
    },
    validate_story: { route: "validate_story", requires_story: true },
    release_story: { route: "release_story", requires_story: true },
    skip_phase: { route: "confirm_phase_skip", confirmation_key: "skip_phase" },
    functional_analysis: {
      route: "classify_artifact",
      confirmation_key: "create_canonical_artifact",
      default_artifact_type: "functional-analysis",
      requires_artifact_type: true,
    },
    technical_analysis: technicalAnalysisAction(),
    technical_assessment: technicalAnalysisAction(),
    initial_technical_assessment: technicalAnalysisAction(),
    project_technical_assessment: technicalAnalysisAction(),
    project_assessment: technicalAnalysisAction(),
    architecture_assessment: technicalAnalysisAction(),
    technical_review: technicalAnalysisAction(),
    create_canonical_artifact: {
      route: "classify_artifact",
      confirmation_key: "create_canonical_artifact",
      requires_artifact_type: true,
    },
    new_output_template: {
      route: "classify_artifact",
      confirmation_key: "new_output_template",
      requires_artifact_type: true,
    },
    duplicate_output: {
      route: "classify_artifact",
      confirmation_key: "duplicate_output",
      requires_artifact_type: true,
    },
  };
}

export function normalizeRouteActionMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const result = {};
  for (const [rawAction, rawConfig] of Object.entries(value)) {
    const action = normalizeRouteToken(rawAction);
    if (!action) {
      continue;
    }
    if (typeof rawConfig === "string") {
      result[action] = { route: normalizeRouteToken(rawConfig) };
    } else if (rawConfig && typeof rawConfig === "object" && !Array.isArray(rawConfig)) {
      result[action] = {
        ...rawConfig,
        route: normalizeRouteToken(rawConfig.route),
        confirmation_key: rawConfig.confirmation_key ? normalizeRouteToken(rawConfig.confirmation_key) : undefined,
        default_artifact_type: rawConfig.default_artifact_type
          ? normalizeRouteArtifactTypeValue(rawConfig.default_artifact_type)
          : undefined,
      };
    }
  }
  return result;
}

export function routeActionConfig(policy, action) {
  const config = policy.canonical_actions[normalizeRouteToken(action)] || null;
  if (!config || !policy.routes.has(config.route)) {
    return null;
  }
  return config;
}

export function emptyRouteIntent() {
  return {
    requested_action: null,
    confidence: 0,
    referenced_entities: [],
    provided_artifacts: [],
    missing_context: [],
    proposed_phase: null,
    artifact_type: null,
    skip_phases: [],
  };
}

export function decideInitProjectRoute(decision, policy, actionConfig, confidenceOutcome) {
  decision.route = "init_project";
  decision.next_commands.push(`agentic-sdlc init --root ${decision.root}`);
  return finalizeConcreteRoute(decision, policy, actionConfig, confidenceOutcome);
}

export function decideIntakeRequirementRoute(decision, policy, actionConfig, confidenceOutcome) {
  decision.route = "intake_requirement";
  const requirementId = routeEntityId(decision.intent, policy, "requirement") || "<requirement-id>";
  pushAllUnique(decision.blocking_reasons, ["requirement_agreement_required"]);
  pushAllUnique(decision.questions, [
    "Describe the outcome you need, at least one observable acceptance criterion, explicit non-goals or things the solution must not do, and the maximum independence allowed: supervised, checkpointed, or bounded-autonomous.",
  ]);
  decision.next_commands.push(
    `agentic-sdlc requirement propose --id ${requirementId} --title "<short title>" --summary "<required outcome>" --acceptance "<observable acceptance criterion>" --non-goal "<explicit exclusion>" --autonomy-ceiling <supervised|checkpointed|bounded-autonomous>`,
  );
  return finalizeConcreteRoute(decision, policy, actionConfig, confidenceOutcome);
}

export function routeStoryId(intent, policy) {
  const direct = routeScalar(intent.story_id);
  if (direct) {
    return normalizeRouteId(direct);
  }
  return routeEntityId(intent, policy, "story");
}

export function routeEntityId(intent, policy, type) {
  const aliases = new Set(normalizeStringArray(policy.entity_types[type] || [type]).map(normalizeRouteToken));
  for (const entity of intent.referenced_entities || []) {
    if (!entity || typeof entity !== "object" || Array.isArray(entity)) {
      continue;
    }
    const entityType = normalizeRouteToken(entity.type || entity.entity_type || entity.kind || entity.role);
    if (!aliases.has(entityType)) {
      continue;
    }
    const id = routeScalar(entity.id || entity.identifier || entity.value || entity[`${type}_id`]);
    if (id) {
      return normalizeRouteId(id);
    }
  }
  return null;
}

export function normalizeRouteId(value) {
  try {
    return normalizeId(value);
  } catch {
    return null;
  }
}

export function addRouteCheck(decision, check, status, details = null) {
  decision.deterministic_checks.push({
    check,
    status,
    details,
  });
}

export function applyRouteConfidenceGate(decision, policy) {
  const confidence = Number(decision.confidence);
  addRouteCheck(
    decision,
    "confidence_policy",
    confidence >= policy.confidence.confirm_min ? "passed" : "failed",
    `confidence=${confidence.toFixed(2)}, ask_below=${policy.confidence.ask_below}, confirm_min=${policy.confidence.confirm_min}, auto_route_min=${policy.confidence.auto_route_min}`,
  );
  if (confidence < policy.confidence.ask_below || confidence < policy.confidence.confirm_min) {
    return "ask";
  }
  if (confidence < policy.confidence.auto_route_min) {
    return "confirm";
  }
  return "auto";
}

export function finalizeAskRoute(decision, updates = {}) {
  decision.route = "ask_clarification";
  decision.status = updates.status || decision.status || "needs_clarification";
  pushAllUnique(decision.blocking_reasons, updates.blocking_reasons || []);
  pushAllUnique(decision.questions, updates.questions || []);
  pushAllUnique(decision.next_commands, updates.next_commands || []);
  decision.requires_confirmation = false;
  dedupeRouteDecision(decision);
  return decision;
}

export function finalizeConcreteRoute(decision, policy, actionConfig = {}, confidenceOutcome = "auto") {
  const confirmationKey = normalizeRouteToken(actionConfig?.confirmation_key || decision.intent?.requested_action || decision.route);
  const alwaysConfirm = policy.confidence.always_confirm.includes(confirmationKey);
  if (confidenceOutcome === "confirm" || alwaysConfirm || decision.route === "confirm_phase_skip") {
    decision.requires_confirmation = true;
  }
  decision.status = decision.requires_confirmation ? "needs_confirmation" : "ready";
  if (decision.blocking_reasons.length > 0 && !decision.requires_confirmation) {
    decision.status = "blocked";
  }
  dedupeRouteDecision(decision);
  return decision;
}

export function dedupeRouteDecision(decision) {
  decision.blocking_reasons = Array.from(new Set(decision.blocking_reasons));
  decision.questions = Array.from(new Set(decision.questions));
  decision.next_commands = Array.from(new Set(decision.next_commands));
}

export function canonicalIntentQuestion() {
  return `Provide canonical intent JSON with fields: ${ROUTE_REQUIRED_INTENT_FIELDS.join(", ")}.`;
}

export function canonicalIntentCommand() {
  return "agentic-sdlc route decide --intent-json '<canonical-intent-json>'";
}

export function normalizeIntentArray(value, field, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array`);
    return [];
  }
  return value;
}

export function normalizeIntentArtifactType(value, errors) {
  const raw = routeScalar(value);
  if (!raw) {
    return null;
  }
  try {
    return normalizeArtifactType(raw);
  } catch (error) {
    errors.push(error.message);
    return null;
  }
}

export function normalizeRouteArtifactTypeValue(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
}

export function routeQuestionFromContext(item) {
  if (typeof item === "string") {
    return `Provide missing context: ${item}.`;
  }
  if (item && typeof item === "object") {
    return routeScalar(item.question || item.prompt || item.label || item.id) || "Provide the missing canonical context.";
  }
  return "Provide the missing canonical context.";
}

export function nullableRoutePhase(value) {
  const scalar = routeScalar(value);
  return scalar ? normalizeRoutePhase(scalar) : null;
}

export function normalizeRouteToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function normalizeRoutePhase(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

export function routeScalar(value) {
  if (value === undefined || value === null || value === true) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.length === 1 ? routeScalar(value[0]) : null;
  }
  const text = String(value).trim();
  return text || null;
}

export function autonomyActionIntentsRoot(context) {
  return path.join(autonomyRoot(context), "action-intents");
}
