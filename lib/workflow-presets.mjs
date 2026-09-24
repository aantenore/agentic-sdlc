import { immutableJson } from "./canonical.mjs";
import {
  WORKFLOW_CANONICAL_EVIDENCE_SCHEMA,
  WORKFLOW_LEGACY_CANONICAL_EVIDENCE_SCHEMA,
} from "./workflow-canonical-evidence.mjs";
import { approveWorkflowDefinition, buildWorkflowDefinition } from "./workflow-engine.mjs";

export const SOFTWARE_PROJECT_PHASES = Object.freeze([
  "discovery", "analysis", "design", "implementation", "validation", "release", "operations",
]);

const SOFTWARE_PROJECT_V1 = preset(
  "software-project",
  "Software project",
  SOFTWARE_PROJECT_PHASES,
  sequential(SOFTWARE_PROJECT_PHASES),
  { compatibility: { phase_order: SOFTWARE_PROJECT_PHASES } },
  { phase_order: SOFTWARE_PROJECT_PHASES },
);

const SOFTWARE_PROJECT_V2 = governedSoftwareProjectPreset(
  WORKFLOW_LEGACY_CANONICAL_EVIDENCE_SCHEMA,
);
const SOFTWARE_PROJECT_V3 = governedSoftwareProjectPreset(
  WORKFLOW_CANONICAL_EVIDENCE_SCHEMA,
);

const PRESETS = Object.freeze({
  "software-project": SOFTWARE_PROJECT_V3,
  "change-request": preset(
    "change-request",
    "Change request",
    ["intake", "impact-review", "approval", "implementation", "validation", "closed"],
  ),
  "technical-assessment": preset(
    "technical-assessment",
    "Technical assessment",
    [
      "context_pending", "proposal_pending", "authorized", "running", "verifying", "completed",
      "exception_pending", "failed", "cancelled",
    ],
    [
      transition("confirm-context", "context_pending", "proposal_pending", [{ id: "checkpoint-approved", parameters: { checkpoint: "context" } }]),
      transition("cancel-from-context", "context_pending", "cancelled"),
      transition("authorize-proposal", "proposal_pending", "authorized", [{ id: "checkpoint-approved", parameters: { checkpoint: "combined-proposal" } }]),
      transition("cancel-from-proposal", "proposal_pending", "cancelled"),
      transition("revise-proposal", "authorized", "proposal_pending"),
      transition("start-assessment", "authorized", "running"),
      transition("cancel-authorized", "authorized", "cancelled"),
      transition("start-verification", "running", "verifying"),
      transition("request-exception", "running", "exception_pending"),
      transition("fail-running", "running", "failed"),
      transition("cancel-running", "running", "cancelled"),
      transition("resume-verification", "verifying", "running"),
      transition("complete-assessment", "verifying", "completed"),
      transition("request-verification-exception", "verifying", "exception_pending"),
      transition("fail-verification", "verifying", "failed"),
      transition("cancel-verification", "verifying", "cancelled"),
      transition("reauthorize-exception", "exception_pending", "authorized"),
      transition("resume-exception", "exception_pending", "running"),
      transition("fail-exception", "exception_pending", "failed"),
      transition("cancel-exception", "exception_pending", "cancelled"),
      transition("retry-failed", "failed", "authorized"),
      transition("cancel-failed", "failed", "cancelled"),
    ],
    { workflow_kind: "technical_assessment", normal_checkpoint_count: 2 },
    { normal_checkpoints: ["context", "combined-proposal"], terminal_states: ["completed", "cancelled"] },
  ),
  "generic-governed-process": preset(
    "generic-governed-process",
    "Generic governed process",
    ["draft", "review", "approved", "execution", "verification", "completed"],
    [
      transition("submit-for-review", "draft", "review"),
      transition("approve", "review", "approved", [{ id: "context-equals", parameters: { key: "authorized", value: true } }]),
      transition("start-execution", "approved", "execution"),
      transition("start-verification", "execution", "verification"),
      transition("complete", "verification", "completed"),
    ],
  ),
});

const PRESET_VERSIONS = Object.freeze({
  "software-project": Object.freeze({
    "1": SOFTWARE_PROJECT_V1,
    "2": SOFTWARE_PROJECT_V2,
    "3": SOFTWARE_PROJECT_V3,
  }),
  "change-request": Object.freeze({ "1": PRESETS["change-request"] }),
  "technical-assessment": Object.freeze({ "1": PRESETS["technical-assessment"] }),
  "generic-governed-process": Object.freeze({ "1": PRESETS["generic-governed-process"] }),
});

const LATEST_PRESET_VERSIONS = Object.freeze({
  "software-project": "3",
  "change-request": "1",
  "technical-assessment": "1",
  "generic-governed-process": "1",
});

/** Return stable preset identifiers suitable for CLI discovery. */
export function listWorkflowPresets() {
  return immutableJson(Object.values(PRESETS).map(({
    id,
    label,
    description,
    states,
    transitions,
    normal_checkpoints: normalCheckpoints,
    metadata,
  }) => ({
    id,
    version: LATEST_PRESET_VERSIONS[id],
    available_versions: Object.keys(PRESET_VERSIONS[id]),
    status: "included",
    label,
    description,
    state_count: states.length,
    journey: states.map((state) => state.id),
    review_moments: normalCheckpoints,
    governance_controls: Array.from(new Set(
      transitions.flatMap((transition) => transition.guards.map((guard) => guard.id)),
    )),
    metadata,
  })));
}

/** Return a template without lifecycle timestamps or hashes. */
export function getWorkflowPreset(id, version = undefined) {
  const versions = PRESET_VERSIONS[id];
  if (!versions) throw new Error(`Unknown workflow preset '${id}'`);
  const selectedVersion = version === undefined || version === null
    ? LATEST_PRESET_VERSIONS[id]
    : String(version);
  const candidate = versions[selectedVersion];
  if (!candidate) {
    throw new Error(
      `Unknown workflow preset '${id}' version '${selectedVersion}'; available versions: ${Object.keys(versions).join(", ")}`,
    );
  }
  return immutableJson(candidate);
}

/** Materialize an approved immutable definition from a built-in preset. */
export function buildWorkflowPreset(id, options = {}) {
  const version = options.version ?? Number(LATEST_PRESET_VERSIONS[id] || 1);
  const source = getWorkflowPreset(id, version);
  const createdAt = options.created_at ?? "1970-01-01T00:00:00.000Z";
  const proposed = buildWorkflowDefinition({
    ...source,
    id: options.id ?? source.id,
    version,
    created_at: createdAt,
    status: "proposed",
    approval: null,
  }, options);
  return approveWorkflowDefinition(proposed, {
    ...options,
    approved_at: options.approved_at ?? createdAt,
    actor: options.actor ?? { id: "builtin-preset", type: "system", name: "Agentic SDLC" },
    approval_source: options.approval_source ?? "bootstrap",
    summary: options.summary ?? `Built-in ${id} workflow preset`,
  });
}

function preset(id, label, stateIds, transitions = sequential(stateIds), metadata = {}, options = {}) {
  const terminalStates = new Set(options.terminal_states ?? [stateIds.at(-1)]);
  return {
    id,
    label,
    description: `${label} governed workflow preset.`,
    initial_state: stateIds[0],
    states: stateIds.map((stateId, index) => ({ id: stateId, label: words(stateId), terminal: terminalStates.has(stateId), metadata: { order: index + 1 } })),
    transitions,
    phase_order: options.phase_order ?? [],
    normal_checkpoints: options.normal_checkpoints ?? [],
    metadata,
  };
}

function governedSoftwareProjectPreset(canonicalEvidenceSchema) {
  return preset(
    "software-project",
    "Software project",
    SOFTWARE_PROJECT_PHASES,
    [
      transition("discovery-to-analysis", "discovery", "analysis", [
        canonicalGuard("requirement-approved"),
      ]),
      transition("analysis-to-design", "analysis", "design"),
      transition("design-to-implementation", "design", "implementation", [
        canonicalGuard("contract-approved"),
      ]),
      transition("implementation-to-validation", "implementation", "validation", [
        canonicalGuard("required-output-linked"),
      ]),
      transition("validation-to-release", "validation", "release", [
        canonicalGuard("strict-gate-passed"),
      ]),
      transition("release-to-operations", "release", "operations"),
    ],
    {
      compatibility: { phase_order: SOFTWARE_PROJECT_PHASES },
      governance_binding: "story",
      canonical_evidence_schema: canonicalEvidenceSchema,
    },
    { phase_order: SOFTWARE_PROJECT_PHASES },
  );
}

function sequential(states) {
  return states.slice(0, -1).map((from, index) => transition(`${from}-to-${states[index + 1]}`, from, states[index + 1]));
}

function transition(id, from, to, guards = []) { return { id, from, to, label: `${words(from)} to ${words(to)}`, guards, metadata: {} }; }
function canonicalGuard(id) { return { id, parameters: {} }; }
function words(value) { return value.split(/[-_]/u).map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(" "); }
