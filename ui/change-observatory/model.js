export const VIEW_MODEL_SCHEMA = "change-observatory:view:v1";
export const DOSSIER_SCHEMA = "change-observatory:iteration-dossier:v1";

export const DOSSIER_LANES = Object.freeze([
  Object.freeze({ key: "asked", label: "Asked" }),
  Object.freeze({ key: "decided", label: "Decided" }),
  Object.freeze({ key: "contract", label: "Contract" }),
  Object.freeze({ key: "done", label: "Done" }),
  Object.freeze({ key: "verified", label: "Verified" }),
]);

export const PHASES = Object.freeze([
  "discovery",
  "analysis",
  "design",
  "implementation",
  "validation",
  "release",
  "operations",
]);

// Fallback text the browser model substitutes for absent fields. It is UI
// copy, not recorded evidence, so the presentation layer localizes it.
export const MODEL_PLACEHOLDERS = Object.freeze([
  "Not recorded",
  "Unidentified record",
  "Untitled record",
  "No recorded summary.",
  "Unknown project",
  "Intent not recorded",
  "Time not recorded",
  "The evidence API reported an unspecified diagnostic.",
]);
export const ITERATION_PLACEHOLDER_PATTERN = /^Iteration (\d+)$/u;

const PROVENANCE = new Set(["recorded", "inferred", "missing", "malformed"]);
const PHASE_STATES = new Set(["complete", "inProgress", "blocked", "missing"]);
const INTENTABI_OUTCOME_REASONS = new Map([
  ["candidate-observed", new Set(["CANDIDATE_ATTESTED"])],
  ["identity", new Set(["IDENTITY_ATTESTED"])],
  ["bypass", new Set(["NON_TEXT_INPUT", "REQUEST_ID_INVALID", "INPUT_LIMIT_EXCEEDED"])],
  ["preparer-fault", new Set(["PREPARER_FAULT"])],
  ["preparer-timeout", new Set(["PREPARATION_TIMEOUT_UNCANCELLED"])],
  ["invalid-preparer-result", new Set(["PREPARER_RESULT_INVALID"])],
]);
const INTENTABI_PROOFS = new Set(["present-unverified", "not-observed"]);
const INTENTABI_EVENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const INTENTABI_LINK_POINTER_PATTERN = /^\/evidence\/[0-9]+$/u;
const INTENTABI_OBSERVATION_PATH_PREFIX = ".sdlc/observations/intentabi/";
const INTENTABI_OBSERVATION_PATH_PATTERN =
  /^\.sdlc\/observations\/intentabi\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/u;

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function recordSelectionKey(value) {
  const item = objectOrEmpty(value);
  const type = readable(item.type, "");
  const id = readable(item.id, "");
  if (!type || !id) return "";
  const primarySource = type === "phase-state"
    ? {}
    : objectOrEmpty(arrayOrEmpty(item.sourceRefs)[0]);
  return JSON.stringify([
    type,
    id,
    readable(primarySource.path, ""),
    Number.isSafeInteger(primarySource.line) ? primarySource.line : null,
    readable(primarySource.pointer, ""),
  ]);
}

export function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

export function readable(value, fallback = "Not recorded") {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

export function sentenceCase(value) {
  const text = readable(value, "");
  if (!text) return "Not recorded";
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/^./, (character) => character.toUpperCase());
}

export function normalizeProvenance(value) {
  return PROVENANCE.has(value) ? value : "missing";
}

function normalizeSourceRef(value) {
  const source = objectOrEmpty(value);
  const path = readable(source.path, "");
  if (!path) return null;
  const normalized = {
    path,
    pointer: readable(source.pointer, "") || null,
  };
  if (source.rawAvailable === false) normalized.rawAvailable = false;
  if (Number.isSafeInteger(source.line) && source.line > 0) normalized.line = source.line;
  return normalized;
}

function normalizeNarrative(value) {
  const narrative = objectOrEmpty(value);
  const inputSummaries = arrayOrEmpty(narrative.input_summaries ?? narrative.inputSummaries)
    .map(normalizeNarrativeEntry)
    .filter(Boolean);
  const outputSummaries = arrayOrEmpty(narrative.output_summaries ?? narrative.outputSummaries)
    .map(normalizeNarrativeEntry)
    .filter(Boolean);
  return {
    inputSummary: readable(narrative.input_summary ?? narrative.inputSummary, "") || null,
    outputSummary: readable(narrative.output_summary ?? narrative.outputSummary, "") || null,
    inputSummaries,
    outputSummaries,
    rationaleSummary:
      readable(
        narrative.rationale_summary ?? narrative.rationaleSummary ?? narrative.rationale,
        "",
      ) || null,
    generatedExplanation:
      readable(narrative.generated_explanation ?? narrative.generatedExplanation, "") || null,
    explanationSource:
      readable(narrative.explanation_source ?? narrative.explanationSource, "") || null,
    provenance: normalizeProvenance(narrative.provenance),
    sourceRefs: arrayOrEmpty(narrative.sourceRefs).map(normalizeSourceRef).filter(Boolean),
    truncated: narrative.truncated === true,
    alternatives: arrayOrEmpty(narrative.alternatives).map(normalizeNarrativeEntry).filter(Boolean),
    evidence: arrayOrEmpty(narrative.evidence).map(normalizeNarrativeEntry).filter(Boolean),
    chainOfThoughtIncluded: narrative.chain_of_thought_included === true,
  };
}

function normalizeNarrativeEntry(value) {
  if (typeof value === "string") {
    const text = readable(value, "");
    return text ? { title: text, summary: null, sourceRefs: [] } : null;
  }

  const entry = objectOrEmpty(value);
  const title = readable(entry.title ?? entry.id ?? entry.summary, "");
  if (!title) return null;
  return {
    title,
    summary: readable(entry.summary, "") || null,
    sourceRefs: arrayOrEmpty(entry.sourceRefs).map(normalizeSourceRef).filter(Boolean),
  };
}

function normalizeMappedEntry(value) {
  return normalizeNarrativeEntry(value);
}

function normalizeLinkage(value) {
  const linkage = objectOrEmpty(value);
  const status = linkage.status === "linked" ? "linked" : "unlinked";
  return {
    status,
    storyId: status === "linked" ? readable(linkage.storyId ?? linkage.story_id, "") || null : null,
    via: status === "linked"
      ? [...new Set(arrayOrEmpty(linkage.via).map((entry) => readable(entry, "")).filter(Boolean))]
      : [],
    sourceRefs: status === "linked"
      ? arrayOrEmpty(linkage.sourceRefs).map(normalizeSourceRef).filter(Boolean)
      : [],
  };
}

export function normalizeSemanticObservation(value) {
  const observation = objectOrEmpty(value);
  const id = readable(observation.id, "");
  const outcome = readable(observation.outcome, "");
  const reason = readable(observation.reason, "");
  const proof = readable(observation.proof, "");

  if (
    observation.type !== "intentabi-codex-shadow"
    || !INTENTABI_EVENT_ID_PATTERN.test(id)
    || observation.mode !== "shadow"
    || observation.submitted !== "original"
    || !INTENTABI_OUTCOME_REASONS.get(outcome)?.has(reason)
    || !INTENTABI_PROOFS.has(proof)
    || observation.macStatus !== "present-not-verified"
  ) {
    return null;
  }

  if (
    (outcome === "candidate-observed" && proof !== "present-unverified")
    || (["bypass", "preparer-fault", "preparer-timeout", "invalid-preparer-result"].includes(outcome)
      && proof !== "not-observed")
  ) {
    return null;
  }

  const sourceRefs = arrayOrEmpty(observation.sourceRefs)
    .map(normalizeSourceRef)
    .filter((source) => source
      && source.path.toLowerCase().startsWith(INTENTABI_OBSERVATION_PATH_PREFIX)
      && isCanonicalEvidencePath(source.path));
  const pathMatch = sourceRefs[0]?.path.match(INTENTABI_OBSERVATION_PATH_PATTERN);
  if (sourceRefs.length !== 1 || pathMatch?.[1] !== id) return null;
  const rawLink = objectOrEmpty(observation.link);
  const storyId = readable(rawLink.storyId, "") || null;
  const projectedTraceIds = [
    ...new Set(arrayOrEmpty(rawLink.traceIds).map((traceId) => readable(traceId, "")).filter(Boolean)),
  ];
  const projectedLinkSourceRefs = arrayOrEmpty(rawLink.sourceRefs)
    .map(normalizeSourceRef)
    .filter((source) => source
      && source.path.startsWith(".sdlc/traces/")
      && isCanonicalEvidencePath(source.path)
      && INTENTABI_LINK_POINTER_PATTERN.test(source.pointer ?? ""));
  const linkStatus = rawLink.status === "linked"
    && storyId
    && projectedTraceIds.length > 0
    && projectedLinkSourceRefs.length > 0
    ? "linked"
    : "unlinked";

  // This is an intentionally closed projection. Never forward upstream titles,
  // summaries, digests, identifiers, or optimization claims to the rendered UI.
  return {
    id,
    type: "intentabi-codex-shadow",
    provenance: normalizeProvenance(observation.provenance),
    sourceRefs,
    rawHref: rawHrefForPath(sourceRefs[0].path),
    mode: "shadow",
    submitted: "original",
    outcome,
    reason,
    proof,
    macStatus: "present-not-verified",
    link: {
      status: linkStatus,
      storyId: linkStatus === "linked" ? storyId : null,
      traceIds: linkStatus === "linked" ? projectedTraceIds : [],
      sourceRefs: linkStatus === "linked" ? projectedLinkSourceRefs : [],
    },
  };
}

const DELIVERY_MILESTONES = new Set(["proposed", "approved", "task_started", "first_action", "finished"]);
const DELIVERY_FINISHES = new Set(["released", "ready_for_review", "closed"]);
const LEAD_TIME_STATUSES = new Set(["finished", "in_progress", "approved", "awaiting_approval", "unknown"]);
const COST_STATUSES = new Set(["metered", "unverified", "declared", "not_measured", "mixed_currencies"]);
const DECIMAL_AMOUNT = /^(?:0|[1-9]\d*)(?:\.\d+)?$/u;
const CURRENCY_CODE = /^[A-Z][A-Z0-9]{2,7}$/u;

function countOrNull(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function amountOrNull(value) {
  return typeof value === "string" && DECIMAL_AMOUNT.test(value) ? value : null;
}

function currencyOrNull(value) {
  return typeof value === "string" && CURRENCY_CODE.test(value) ? value : null;
}

/** Lead time and cost of one delivery, kept only when every value has the expected shape. */
export function normalizeDeliveryMetrics(value) {
  const metrics = objectOrEmpty(value);
  const leadTime = objectOrEmpty(metrics.leadTime);
  const cost = objectOrEmpty(metrics.cost);
  return {
    leadTime: {
      status: LEAD_TIME_STATUSES.has(leadTime.status) ? leadTime.status : "unknown",
      finish: DELIVERY_FINISHES.has(leadTime.finish) ? leadTime.finish : null,
      stages: arrayOrEmpty(leadTime.stages)
        .map(objectOrEmpty)
        .filter((stage) => DELIVERY_MILESTONES.has(stage.from) && DELIVERY_MILESTONES.has(stage.to))
        .map((stage) => ({ from: stage.from, to: stage.to, seconds: countOrNull(stage.seconds) })),
      totalSeconds: countOrNull(leadTime.totalSeconds),
      waitingSeconds: countOrNull(leadTime.waitingSeconds) ?? 0,
      waitingConfirmations: countOrNull(leadTime.waitingConfirmations) ?? 0,
      unrecordedRequests: countOrNull(leadTime.unrecordedRequests) ?? 0,
    },
    cost: {
      status: COST_STATUSES.has(cost.status) ? cost.status : "not_measured",
      amount: amountOrNull(cost.amount),
      currency: currencyOrNull(cost.currency),
      tokens: countOrNull(cost.tokens),
      receipts: countOrNull(cost.receipts) ?? 0,
      sources: arrayOrEmpty(cost.sources).map((entry) => readable(entry, "")).filter(Boolean),
    },
  };
}

/** Recorded spend of a standing approval budget. */
export function normalizeStandingBudget(value) {
  const budget = objectOrEmpty(value);
  const currency = currencyOrNull(budget.currency);
  if (!currency) return null;
  return {
    currency,
    perDelivery: amountOrNull(budget.perDelivery),
    total: amountOrNull(budget.total),
    spent: amountOrNull(budget.spent) ?? "0",
    deliveries: countOrNull(budget.deliveries) ?? 0,
    notMeasured: countOrNull(budget.notMeasured) ?? 0,
    verified: budget.verified === true,
  };
}

export function normalizeItem(value) {
  const item = objectOrEmpty(value);
  const sourceRefs = arrayOrEmpty(item.sourceRefs).map(normalizeSourceRef).filter(Boolean);
  const rawAvailable = item.rawAvailable !== false
    && sourceRefs.every((source) => source.rawAvailable !== false);
  const narrative = normalizeNarrative(item.narrative);
  const explanation = objectOrEmpty(item.explanation);
  const rationale = objectOrEmpty(item.rationale);
  const explicitRationale = readable(
    item.rationaleSummary
      ?? item.rationale_summary
      ?? (typeof item.rationale === "string" ? item.rationale : rationale.text),
    "",
  ) || null;
  const explicitGeneratedExplanation =
    readable(item.generatedExplanation ?? item.generated_explanation, "") || null;
  if (!narrative.rationaleSummary && explicitRationale) {
    narrative.rationaleSummary = explicitRationale;
    narrative.provenance = normalizeProvenance(
      item.rationaleProvenance ?? rationale.provenance ?? item.provenance,
    );
    narrative.sourceRefs = arrayOrEmpty(rationale.sourceRefs)
      .map(normalizeSourceRef)
      .filter(Boolean);
  }
  if (!narrative.generatedExplanation && explicitGeneratedExplanation) {
    narrative.generatedExplanation = explicitGeneratedExplanation;
    narrative.explanationSource =
      readable(item.explanationSource ?? item.explanation_source, "") || null;
    narrative.provenance = normalizeProvenance(item.explanationProvenance ?? item.provenance);
  }

  return {
    id: readable(item.id, "Unidentified record"),
    type: readable(item.type, "record"),
    title: readable(item.title ?? item.summary, "Untitled record"),
    summary: readable(item.summary, "No recorded summary."),
    ...(readable(item.humanTitle ?? item.human_title, "") ? {
      humanTitle: readable(item.humanTitle ?? item.human_title, ""),
      humanSummary: readable(item.humanSummary ?? item.human_summary, ""),
      humanStatus: readable(item.humanStatus ?? item.human_status, ""),
    } : {}),
    status: readable(item.status, "missing"),
    phase: readable(item.phase, "") || null,
    action: readable(item.action, "") || null,
    timestamp: readable(item.timestamp, "") || null,
    provenance: normalizeProvenance(item.provenance),
    sourceRefs,
    rawHref: rawAvailable ? safeRawHref(item.rawHref) : null,
    ...(rawAvailable ? {} : { rawAvailable: false }),
    intent: readable(item.intent, "") || null,
    storyId: readable(item.storyId ?? item.story_id, "") || null,
    requirementId: readable(item.requirementId ?? item.requirement_id, "") || null,
    requirementIds: arrayOrEmpty(item.requirementIds ?? item.requirement_ids)
      .map((entry) => readable(entry, ""))
      .filter(Boolean),
    contractId: readable(item.contractId ?? item.contract_id, "") || null,
    related: arrayOrEmpty(item.related).map((entry) => readable(entry, "")).filter(Boolean),
    linkage: normalizeLinkage(item.linkage),
    narrative,
    explanation: {
      text: readable(explanation.text, "") || null,
      authoring: readable(explanation.authoring, "") || null,
      provenance: normalizeProvenance(explanation.provenance),
      sourceRefs: arrayOrEmpty(explanation.sourceRefs).map(normalizeSourceRef).filter(Boolean),
    },
    inputs: arrayOrEmpty(item.inputs).map(normalizeMappedEntry).filter(Boolean),
    outputs: arrayOrEmpty(item.outputs).map(normalizeMappedEntry).filter(Boolean),
    alternatives: arrayOrEmpty(item.alternatives).map(normalizeMappedEntry).filter(Boolean),
    evidence: arrayOrEmpty(item.evidence).map(normalizeMappedEntry).filter(Boolean),
    ...(item.deliveryMetrics ? { deliveryMetrics: normalizeDeliveryMetrics(item.deliveryMetrics) } : {}),
    ...(normalizeStandingBudget(item.standingBudget) ? { standingBudget: normalizeStandingBudget(item.standingBudget) } : {}),
  };
}

function normalizeDossierLane(value) {
  const lane = Array.isArray(value) ? { items: value } : objectOrEmpty(value);
  const items = arrayOrEmpty(lane.items).map(normalizeItem);
  const explicitStatus = ["recorded", "missing", "malformed"].includes(lane.status)
    ? lane.status
    : null;
  const explicitProvenance = PROVENANCE.has(lane.provenance) ? lane.provenance : null;
  return {
    status: explicitStatus ?? (items.length ? "recorded" : "missing"),
    provenance: explicitProvenance ?? (items.length ? "recorded" : "missing"),
    sourceRefs: arrayOrEmpty(lane.sourceRefs).map(normalizeSourceRef).filter(Boolean),
    items,
    declaredStatus: explicitStatus,
    declaredProvenance: explicitProvenance,
    statusWasPresent: Object.hasOwn(lane, "status"),
    provenanceWasPresent: Object.hasOwn(lane, "provenance"),
  };
}

function normalizeDossierLinks(value) {
  const links = objectOrEmpty(value);
  return {
    requirementIds: arrayOrEmpty(links.requirementIds ?? links.requirement_ids)
      .map((entry) => readable(entry, ""))
      .filter(Boolean),
    contractIds: arrayOrEmpty(links.contractIds ?? links.contract_ids)
      .map((entry) => readable(entry, ""))
      .filter(Boolean),
  };
}

function enforceDossierLaneOwnership(lane, dossierStoryId, laneKey, diagnostics) {
  const {
    declaredStatus,
    declaredProvenance,
    statusWasPresent,
    provenanceWasPresent,
    ...publicLane
  } = lane;
  const rejected = [];
  const items = lane.items.filter((item) => {
    const owned = Boolean(
      dossierStoryId
      && item.linkage?.status === "linked"
      && item.linkage.storyId === dossierStoryId
      && (!item.storyId || item.storyId === dossierStoryId),
    );
    if (!owned) rejected.push(item);
    return owned;
  });
  if (rejected.length) {
    diagnostics.push(normalizeDiagnostic({
      code: "dossier_item_ownership_mismatch",
      severity: "error",
      message: `${rejected.length} ${laneKey} ${rejected.length === 1 ? "item was" : "items were"} excluded because explicit story ownership did not match the dossier.`,
      occurrences: rejected.length,
      provenance: "malformed",
      sourceRefs: rejected.flatMap((item) => item.sourceRefs).slice(0, 12),
    }));
  }
  const expectedState = items.length ? "recorded" : "missing";
  const stateContradiction = declaredStatus === "malformed"
    || (statusWasPresent && declaredStatus !== expectedState)
    || (provenanceWasPresent && declaredProvenance !== expectedState);
  if (stateContradiction) {
    diagnostics.push(normalizeDiagnostic({
      code: "dossier_lane_state_inconsistent",
      severity: "error",
      message: `The ${laneKey} lane declared status or provenance that contradicts its accepted items.`,
      provenance: "malformed",
      sourceRefs: publicLane.sourceRefs,
    }));
  }
  const malformed = rejected.length > 0 || stateContradiction;
  return {
    ...publicLane,
    status: malformed ? "malformed" : expectedState,
    provenance: malformed ? "malformed" : expectedState,
    items,
  };
}

export function normalizeDossier(value) {
  const dossier = objectOrEmpty(value);
  const lanes = objectOrEmpty(dossier.lanes);
  const schemaVersion = readable(dossier.schemaVersion ?? dossier.schema_version, "") || null;
  const sourceRefs = arrayOrEmpty(dossier.sourceRefs).map(normalizeSourceRef).filter(Boolean);
  const status = ["complete", "partial", "missing", "malformed"].includes(dossier.status)
    ? dossier.status
    : "malformed";
  const storyId = readable(dossier.storyId ?? dossier.story_id, "") || null;
  const diagnostics = arrayOrEmpty(dossier.diagnostics).map(normalizeDiagnostic);
  const normalizedLanes = {
    asked: normalizeDossierLane(lanes.asked),
    decided: normalizeDossierLane(lanes.decided),
    contract: normalizeDossierLane(lanes.contract),
    done: normalizeDossierLane(lanes.done),
    verified: normalizeDossierLane(lanes.verified),
    release: normalizeDossierLane(lanes.release),
  };
  const ownedLanes = Object.fromEntries(
    Object.entries(normalizedLanes).map(([laneKey, lane]) => [
      laneKey,
      enforceDossierLaneOwnership(lane, storyId, laneKey, diagnostics),
    ]),
  );
  const canonicalLaneStates = DOSSIER_LANES.map(({ key }) => ownedLanes[key].status);
  const derivedStatus = canonicalLaneStates.includes("malformed") || status === "malformed"
    ? "malformed"
    : canonicalLaneStates.every((laneStatus) => laneStatus === "recorded")
      ? "complete"
      : "partial";

  return {
    schemaVersion,
    schemaSupported: schemaVersion === DOSSIER_SCHEMA,
    storyId,
    iterationId: readable(dossier.iterationId ?? dossier.iteration_id, "") || null,
    title: readable(dossier.title, "") || null,
    summary: readable(dossier.summary, "") || null,
    status: derivedStatus,
    provenance: derivedStatus === "malformed"
      ? "malformed"
      : normalizeProvenance(dossier.provenance),
    sourceRefs,
    rawHref: safeRawHref(dossier.rawHref),
    links: normalizeDossierLinks(dossier.links),
    lanes: ownedLanes,
    diagnostics,
  };
}

function normalizePhase(value, fallbackPhase) {
  const phase = objectOrEmpty(value);
  const status = PHASE_STATES.has(phase.status) ? phase.status : "missing";
  return {
    phase: readable(phase.phase, fallbackPhase),
    status,
    provenance: normalizeProvenance(phase.provenance),
    sourceRefs: arrayOrEmpty(phase.sourceRefs).map(normalizeSourceRef).filter(Boolean),
  };
}

function normalizeIteration(value, index, dossier = null) {
  const iteration = normalizeItem(value);
  const byPhase = new Map(
    arrayOrEmpty(value?.phases).map((phase) => [readable(phase?.phase, "").toLowerCase(), phase]),
  );
  return {
    ...iteration,
    title: readable(value?.title, `Iteration ${index + 1}`),
    currentPhase: readable(value?.currentPhase, "") || null,
    phases: PHASES.map((phase) => normalizePhase(byPhase.get(phase), phase)),
    claimed: value?.claimed === true,
    closure: normalizeClosure(value?.closure),
    dossier,
  };
}

// Older servers send no closure; a story is then never shown as replaced.
function normalizeClosure(value) {
  const closure = objectOrEmpty(value);
  if (!["superseded", "cancelled"].includes(closure.event)) return null;
  const replacementId = readable(closure.replacementId, "") || null;
  const replacementIds = Array.isArray(closure.replacementIds)
    ? closure.replacementIds.map((id) => readable(id, "")).filter(Boolean)
    : [];
  return {
    event: closure.event,
    replacementId,
    replacementIds: replacementIds.length ? replacementIds : replacementId ? [replacementId] : [],
  };
}

function normalizeRecord(value) {
  const record = objectOrEmpty(value);
  const path = readable(record.path, "");
  const rawAvailable = record.rawAvailable !== false && isCanonicalEvidencePath(path);
  return {
    path,
    kind: readable(record.kind, "record"),
    provenance: normalizeProvenance(record.provenance),
    rawHref: rawAvailable ? safeRawHref(record.rawHref) ?? rawHrefForPath(path) : null,
    ...(rawAvailable ? {} : { rawAvailable: false }),
  };
}

function normalizeDiagnostic(value) {
  const diagnostic = objectOrEmpty(value);
  const severity = ["info", "warning", "error"].includes(diagnostic.severity)
    ? diagnostic.severity
    : "warning";
  const occurrences = Number.isSafeInteger(diagnostic.occurrences) && diagnostic.occurrences > 0
    ? diagnostic.occurrences
    : 1;
  return {
    code: readable(diagnostic.code, "OBSERVATORY_DIAGNOSTIC"),
    severity,
    message: readable(diagnostic.message, "The evidence API reported an unspecified diagnostic."),
    occurrences,
    provenance: normalizeProvenance(diagnostic.provenance),
    sourceRefs: arrayOrEmpty(diagnostic.sourceRefs).map(normalizeSourceRef).filter(Boolean),
  };
}

function normalizeDiagnostics(values) {
  const grouped = new Map();
  for (const value of arrayOrEmpty(values)) {
    const diagnostic = normalizeDiagnostic(value);
    const fingerprint = JSON.stringify([
      diagnostic.code,
      diagnostic.severity,
      diagnostic.message,
      diagnostic.provenance,
    ]);
    const existing = grouped.get(fingerprint);
    if (!existing) {
      grouped.set(fingerprint, diagnostic);
      continue;
    }
    existing.occurrences += diagnostic.occurrences;
    const seen = new Set(existing.sourceRefs.map((ref) => `${ref.path}\u0000${ref.pointer ?? ""}`));
    for (const ref of diagnostic.sourceRefs) {
      const key = `${ref.path}\u0000${ref.pointer ?? ""}`;
      if (!seen.has(key) && existing.sourceRefs.length < 12) {
        existing.sourceRefs.push(ref);
        seen.add(key);
      }
    }
  }
  return [...grouped.values()];
}

export function normalizeViewModel(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("The observatory API returned a non-object payload.");
  }
  if (payload.schemaVersion !== VIEW_MODEL_SCHEMA) {
    throw new TypeError(
      `Unsupported observatory schema ${readable(payload.schemaVersion, "(missing)")}; expected ${VIEW_MODEL_SCHEMA}.`,
    );
  }

  const summary = objectOrEmpty(payload.summary);
  const project = objectOrEmpty(payload.project);
  const snapshots = objectOrEmpty(payload.snapshots);
  const rawIterations = arrayOrEmpty(payload.iterations);
  const iterationIds = new Set(rawIterations.map((iteration) => readable(
    iteration?.id ?? iteration?.storyId ?? iteration?.story_id,
    "",
  )).filter(Boolean));
  const topLevelDossiers = arrayOrEmpty(payload.dossiers).map(normalizeDossier);
  const ownershipDiagnostics = [];
  for (const dossier of topLevelDossiers) {
    if (!dossier.storyId || dossier.storyId !== dossier.iterationId) {
      ownershipDiagnostics.push({
        code: "dossier_iteration_ownership_mismatch",
        severity: "error",
        message: "A top-level dossier was not associated because its story and iteration IDs do not match exactly.",
        provenance: "malformed",
        sourceRefs: dossier.sourceRefs,
      });
    } else if (!iterationIds.has(dossier.iterationId)) {
      ownershipDiagnostics.push({
        code: "dossier_iteration_not_found",
        severity: "warning",
        message: "A top-level dossier references an iteration that is not present in this view and remains unassociated.",
        provenance: "missing",
        sourceRefs: dossier.sourceRefs,
      });
    }
  }
  const iterations = rawIterations.map((iteration, index) => {
    const explicitIterationId = readable(
      iteration?.id ?? iteration?.storyId ?? iteration?.story_id,
      "",
    );
    let dossier = null;
    if (iteration?.dossier && typeof iteration.dossier === "object") {
      const inlineDossier = normalizeDossier(iteration.dossier);
      if (
        inlineDossier.storyId === explicitIterationId
        && inlineDossier.iterationId === explicitIterationId
      ) {
        dossier = inlineDossier;
      } else {
        ownershipDiagnostics.push({
          code: "dossier_iteration_ownership_mismatch",
          severity: "error",
          message: "An inline dossier was not associated because its story and iteration IDs do not match the owning iteration exactly.",
          provenance: "malformed",
          sourceRefs: inlineDossier.sourceRefs,
        });
      }
    }
    if (!dossier) {
      const candidates = topLevelDossiers.filter((candidate) =>
        candidate.storyId === explicitIterationId
        && candidate.iterationId === explicitIterationId);
      if (candidates.length === 1) dossier = candidates[0];
      if (candidates.length > 1) {
        ownershipDiagnostics.push({
          code: "dossier_iteration_ownership_ambiguous",
          severity: "error",
          message: "Multiple top-level dossiers claim the same iteration, so none was associated.",
          provenance: "malformed",
          sourceRefs: candidates.flatMap((candidate) => candidate.sourceRefs).slice(0, 12),
        });
      }
    }
    return normalizeIteration(iteration, index, dossier);
  });
  const inlineDossiers = iterations.map((iteration) => iteration.dossier).filter(Boolean);
  const dossierKeys = new Set(
    inlineDossiers.map((dossier) => `${dossier.storyId ?? ""}\u0000${dossier.iterationId ?? ""}`),
  );
  const dossiers = [
    ...inlineDossiers,
    ...topLevelDossiers.filter((dossier) =>
      !dossierKeys.has(`${dossier.storyId ?? ""}\u0000${dossier.iterationId ?? ""}`)),
  ];

  return {
    schemaVersion: VIEW_MODEL_SCHEMA,
    generatedAt: readable(payload.generatedAt, "") || null,
    project: {
      id: readable(project.id ?? project.projectId, "Unknown project"),
      name: readable(project.name ?? project.projectName ?? project.id, "Unknown project"),
      root: readable(project.root, "") || null,
      branch: readable(project.branch, "") || null,
      snapshot: readable(project.snapshot, "") || null,
    },
    snapshots: {
      counts: objectOrEmpty(snapshots.counts),
      phaseCounts: objectOrEmpty(snapshots.phaseCounts),
    },
    summary: {
      asked: arrayOrEmpty(summary.asked).map(normalizeItem),
      changed: arrayOrEmpty(summary.changed).map(normalizeItem),
      decided: arrayOrEmpty(summary.decided).map(normalizeItem),
    },
    iterations,
    dossiers,
    contracts: arrayOrEmpty(payload.contracts).map(normalizeItem),
    decisions: arrayOrEmpty(payload.decisions).map(normalizeItem),
    changes: arrayOrEmpty(payload.changes).map(normalizeItem),
    verification: arrayOrEmpty(payload.verification).map(normalizeItem),
    semanticObservations: arrayOrEmpty(payload.semanticObservations)
      .map(normalizeSemanticObservation)
      .filter(Boolean),
    unlinkedLineage: arrayOrEmpty(payload.unlinked ?? payload.unlinkedLineage).map(normalizeItem),
    records: arrayOrEmpty(payload.records).map(normalizeRecord).filter((record) => record.path),
    diagnostics: normalizeDiagnostics([
      ...arrayOrEmpty(payload.diagnostics),
      ...ownershipDiagnostics,
    ]),
  };
}

const SUPERSEDED_ITERATION_STATUSES = new Set([
  "superseded",
  "cancelled",
  "canceled",
  "abandoned",
  "withdrawn",
  "obsolete",
  "rejected",
]);
const DELIVERED_ITERATION_STATUSES = new Set([
  "released",
  "delivered",
  "certified",
  "done",
  "complete",
  "completed",
  "closed",
  "merged",
  "merged_externally",
]);

function iterationStatusKey(iteration) {
  return readable(iteration?.status, "").toLowerCase().replace(/[-\s]+/gu, "_");
}

function iterationTime(iteration) {
  const time = Date.parse(iteration?.timestamp ?? "");
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
}

function mostRecentIteration(iterations) {
  let selected = null;
  for (const iteration of iterations) {
    if (!selected || iterationTime(iteration) >= iterationTime(selected)) selected = iteration;
  }
  return selected;
}

export function iterationRelevance(iteration) {
  if (SUPERSEDED_ITERATION_STATUSES.has(iterationStatusKey(iteration))) return "superseded";
  const phases = arrayOrEmpty(iteration?.phases);
  const releasePhase = phases.find((phase) => phase.phase === "release");
  if (
    DELIVERED_ITERATION_STATUSES.has(iterationStatusKey(iteration))
    || releasePhase?.status === "complete"
  ) {
    return "delivered";
  }
  if (phases.some((phase) => phase.status !== "missing")) return "active";
  return "idle";
}

// The default dossier follows recorded evidence rather than list order:
// work with lineage in progress first, then the most recent delivery.
// Superseded iterations are only chosen when nothing else exists.
export function preferredDossierIteration(iterations) {
  const candidates = arrayOrEmpty(iterations);
  const byRelevance = (relevance) =>
    candidates.filter((iteration) => iterationRelevance(iteration) === relevance);
  const current = candidates.filter((iteration) =>
    iterationRelevance(iteration) !== "superseded");
  return mostRecentIteration(byRelevance("active"))
    || mostRecentIteration(byRelevance("delivered"))
    || current.find((iteration) =>
      iteration.currentPhase && iteration.dossier?.status === "partial")
    || current.find((iteration) => iteration.currentPhase && iteration.dossier)
    || current.find((iteration) => iteration.dossier)
    || current[0]
    || candidates[0]
    || null;
}

export function filterIterations(iterations, filters = {}) {
  return arrayOrEmpty(iterations).filter((iteration) => {
    const iterationMatch = !filters.iteration || iteration.id === filters.iteration;
    const phaseMatch =
      !filters.phase ||
      iteration.currentPhase === filters.phase ||
      iteration.phases.some(
        (phase) => phase.phase === filters.phase && phase.status !== "missing",
      );
    return iterationMatch && phaseMatch;
  });
}

export function groupChangesByIntent(changes) {
  const groups = new Map();
  for (const change of arrayOrEmpty(changes)) {
    const key = change.intent || change.phase || change.action || change.type || "Intent not recorded";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(change);
  }
  return [...groups.entries()].map(([intent, items]) => ({ intent, items }));
}

export function narrativeFor(item) {
  if (!item) {
    return {
      inputs: [],
      outputs: [],
      rationale: null,
      rationaleProvenance: "missing",
      generatedExplanation: null,
      explanationLabel: null,
      explanationProvenance: "missing",
      alternatives: [],
      evidence: [],
      chainOfThoughtIncluded: false,
    };
  }

  const narrative = item.narrative ?? normalizeNarrative(null);
  const generatedExplanation = narrative.generatedExplanation || item.explanation?.text || null;
  const explanationSource =
    narrative.explanationSource || item.explanation?.authoring || (generatedExplanation ? "recorded" : null);

  return {
    inputs: narrative.inputSummaries?.length
      ? narrative.inputSummaries
      : narrative.inputSummary
      ? [{ title: narrative.inputSummary, summary: null, sourceRefs: item.sourceRefs }]
      : item.inputs ?? [],
    outputs: narrative.outputSummaries?.length
      ? narrative.outputSummaries
      : narrative.outputSummary
      ? [{ title: narrative.outputSummary, summary: null, sourceRefs: item.sourceRefs }]
      : item.outputs ?? [],
    rationale: narrative.rationaleSummary,
    rationaleProvenance: narrative.rationaleSummary ? narrative.provenance : "missing",
    generatedExplanation,
    explanationLabel: explanationSource,
    explanationProvenance: generatedExplanation
      ? (item.explanation?.text ? item.explanation.provenance : narrative.provenance)
      : "missing",
    alternatives: narrative.alternatives.length ? narrative.alternatives : item.alternatives ?? [],
    evidence: narrative.evidence.length ? narrative.evidence : item.evidence ?? [],
    chainOfThoughtIncluded: narrative.chainOfThoughtIncluded,
  };
}

export function firstSummaryItem(items) {
  return arrayOrEmpty(items)[0] ?? null;
}

export function rawHrefForPath(path, portfolioProjectId = null) {
  const clean = readable(path, "");
  if (!isCanonicalEvidencePath(clean)) return null;
  if (portfolioProjectId !== null) {
    if (
      typeof portfolioProjectId !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(portfolioProjectId)
    ) {
      return null;
    }
    return `/api/v1/portfolio/source?project=${encodeURIComponent(portfolioProjectId)}&path=${encodeURIComponent(clean)}`;
  }
  return `/api/v1/source?path=${encodeURIComponent(clean)}`;
}

export function safeRawHref(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  let url;
  try {
    url = new URL(value, "http://observatory.local");
  } catch {
    return null;
  }
  if (url.origin !== "http://observatory.local" || url.hash !== "") return null;
  const keys = [...url.searchParams.keys()];
  if (url.pathname === "/api/v1/source") {
    if (
      keys.some((key) => key !== "path")
      || url.searchParams.getAll("path").length !== 1
    ) {
      return null;
    }
    return rawHrefForPath(url.searchParams.get("path"));
  }
  if (url.pathname === "/api/v1/portfolio/source") {
    if (
      keys.some((key) => !["project", "path"].includes(key))
      || url.searchParams.getAll("project").length !== 1
      || url.searchParams.getAll("path").length !== 1
    ) {
      return null;
    }
    return rawHrefForPath(
      url.searchParams.get("path"),
      url.searchParams.get("project"),
    );
  }
  return null;
}

export function rawTargetFor(item, { portfolioProjectId = null } = {}) {
  if (!item) return null;
  if (item.rawAvailable === false) return null;
  const safeItemHref = safeRawHref(item.rawHref);
  if (safeItemHref) {
    const sourcePath = new URL(
      safeItemHref,
      "http://observatory.local",
    ).searchParams.get("path");
    return {
      href: portfolioProjectId === null
        ? safeItemHref
        : rawHrefForPath(sourcePath, portfolioProjectId),
      path: sourcePath,
    };
  }
  const source = arrayOrEmpty(item.sourceRefs).find((ref) =>
    ref.rawAvailable !== false && isCanonicalEvidencePath(ref.path));
  if (!source) return null;
  return {
    href: rawHrefForPath(source.path, portfolioProjectId),
    path: source.path,
  };
}

export function isCanonicalEvidencePath(path) {
  if (typeof path !== "string" || !path.startsWith(".sdlc/")) return false;
  if (path.includes("\0") || path.includes("\\")) return false;
  if (path.includes("[REDACTED")) return false;
  return !path.split("/").some((segment) => segment === ".." || segment === ".");
}

export function formatTimestamp(value) {
  if (!value) return "Time not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
