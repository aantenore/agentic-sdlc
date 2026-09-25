import path from "node:path";
import {
  catalogOptionMetadata,
} from "../cli/dispatch.mjs";
import {
  createOperationalRedactionPolicy,
} from "../observability/redaction.mjs";

export const SDLC_DIR = ".sdlc";

export const CACHE_FILE_NAME = "kb-cache.json";

export const workflowStartTraceIndexCache = new WeakMap();

export const workflowStartTransactionIndexCache = new WeakMap();

export const PROJECT_CONFIG_FILE_NAME = "config.json";

export const MAX_CLI_ERROR_CONFIG_BYTES = 2 * 1024 * 1024;

export const MAX_TEMPLATE_ASSET_BYTES = 2 * 1024 * 1024;

export const PROJECT_CONFIG_LOCK_FILE_NAME = "config.lock.json";

export const PROJECT_BOOTSTRAP_MANIFEST_FILE_NAME = "bootstrap-manifest.json";

export const PROJECT_BOOTSTRAP_MANIFEST_SCHEMA_VERSION = "project-bootstrap-manifest:v1";

export const PROJECT_BOOTSTRAP_JOURNAL_FILE_NAME = "bootstrap-journal.json";

export const PROJECT_BOOTSTRAP_JOURNAL_SCHEMA_VERSION = "project-bootstrap-journal:v1";

export const PROJECT_BOOTSTRAP_MANIFEST_INTRODUCED_VERSION = "0.13.1";

export const LEGACY_CONFIG_PROFILE_ID = "sdlc-config-v1@0.11.0";

export const INTERNAL_LOCK_WAIT_MS = 5000;

export const INTERNAL_LOCK_STALE_MS = 30000;

export const INTERNAL_LOCK_REMOTE_STALE_MS = 300000;

export const DEFAULT_CODEX_SESSION_METERING_CONFIG = Object.freeze({
  enabled: true,
  metric_mapping: Object.freeze({
    tokens: "tokens.total",
    input_tokens: "tokens.input",
    output_tokens: "tokens.output",
    cache_read_tokens: "tokens.cache_read",
    cache_write_tokens: "tokens.cache_write",
    model_calls: "calls",
  }),
});

export const TRACE_EVIDENCE_POLICY_REF_SCHEMA = "trace-evidence-redaction-policy-ref:v1";

export const TRACE_EVIDENCE_POLICY_BINDING_SCHEMA = "trace-evidence-redaction-policy-binding:v1";

export const TRACE_EVIDENCE_POLICY_SOURCE_ROOT = `${SDLC_DIR}/evidence-redaction-policies`;

export const OUTPUT_LINK_MODES = new Set(["reuse", "delta", "new"]);

export const OUTPUT_DELIVERY_MODES = new Set(["artifact", "artifact-plus-chat-summary"]);

export const OUTPUT_VISUAL_FORMATS = new Set(["docx", "xlsx", "pdf", "pptx", "html"]);

export const OUTPUT_FORMATS = Object.freeze({
  markdown: Object.freeze({
    label: "Markdown document",
    extension: ".md",
    media_type: "text/markdown",
    generator: null,
  }),
  docx: Object.freeze({
    label: "Word document",
    extension: ".docx",
    media_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    generator: "documents",
  }),
  xlsx: Object.freeze({
    label: "Excel workbook",
    extension: ".xlsx",
    media_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    generator: "spreadsheets",
  }),
  pdf: Object.freeze({
    label: "PDF document",
    extension: ".pdf",
    media_type: "application/pdf",
    generator: "pdf",
  }),
  pptx: Object.freeze({
    label: "PowerPoint presentation",
    extension: ".pptx",
    media_type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    generator: "presentations",
  }),
  html: Object.freeze({
    label: "HTML document",
    extension: ".html",
    media_type: "text/html",
    generator: null,
  }),
  json: Object.freeze({
    label: "JSON document",
    extension: ".json",
    media_type: "application/json",
    generator: null,
  }),
  csv: Object.freeze({
    label: "CSV table",
    extension: ".csv",
    media_type: "text/csv",
    generator: "spreadsheets",
  }),
  custom: Object.freeze({
    label: "Custom artifact",
    extension: null,
    media_type: "application/octet-stream",
    generator: null,
  }),
});

export const OUTPUT_FORMAT_ALIASES = Object.freeze({
  md: "markdown",
  markdown: "markdown",
  word: "docx",
  doc: "docx",
  docx: "docx",
  excel: "xlsx",
  spreadsheet: "xlsx",
  workbook: "xlsx",
  xlsx: "xlsx",
  pdf: "pdf",
  powerpoint: "pptx",
  slides: "pptx",
  pptx: "pptx",
  html: "html",
  json: "json",
  csv: "csv",
  custom: "custom",
});

export const CATALOG_OPTION_METADATA = catalogOptionMetadata();

export const CATALOG_KNOWN_OPTIONS = new Set(CATALOG_OPTION_METADATA.known);

export const STORY_STATUSES = new Set(["draft", "ready", "analysis", "design", "implementation", "in_progress", "review", "validation", "release", "done", "blocked"]);

export const TERMINAL_STORY_STATUSES = new Set(["done"]);

export const CLAIM_STATUSES = new Set(["active", "released", "transferred", "cancelled"]);

export const LOCK_STATUSES = new Set(["active", "released", "cancelled", "expired"]);

export const HANDOFF_STATUSES = new Set(["open", "accepted", "closed", "rejected", "cancelled"]);

export const WORK_ITEM_TYPES = new Set(["requirement", "epic", "story", "task"]);

export const WORK_ITEM_CREATE_TYPES = new Set(["epic", "task"]);

export const CAPABILITY_TYPES = new Set(["skills", "mcp", "tools"]);

export const CAPABILITY_GROUPS = new Set(["required", "allowed", "forbidden"]);

export const DEPENDENCY_TYPES = new Set(["blocks", "requires_artifact", "requires_contract", "related", "same_requirement", "parent_epic"]);

export const DEPENDENCY_BLOCK_SCOPES = new Set(["analysis", "design", "implementation", "validation", "release", "none"]);

export const CAPABILITY_RECOMMENDATION_AVAILABILITY = new Set(["available", "missing", "unknown", "install_required"]);

export const APPROVAL_SOURCES = new Set(["explicit-user", "ci", "automation", "bootstrap"]);

export const DELIVERY_TERMINAL_STATUSES = new Set([
  "merged",
  "closed",
  "released",
  "rolled_back",
  "cancelled",
  "superseded",
  "revoked",
]);

export const PHASE_IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;

export const AUTONOMY_ROLLOUT_MODES = new Set([
  "off",
  "observe",
  "enforce_new_only",
  "enforce_all",
]);

export const LEGACY_STORY_STEP_PHASE_ALIASES = new Map([
  ["functional-analysis", "analysis"],
  ["technical-analysis", "analysis"],
]);

export const ACTIVITY_REPORT_VIEWS = new Set(["business", "dev", "agent-verbose"]);

export const REPORT_QUERY_SUBJECTS = new Set([
  "activity",
  "stories",
  "story_steps",
  "outputs",
  "contracts",
  "handoffs",
  "work_items",
  "approvals",
  "tests",
  "all",
]);

export const ROUTE_REQUIRED_INTENT_FIELDS = [
  "requested_action",
  "confidence",
  "referenced_entities",
  "provided_artifacts",
  "missing_context",
  "proposed_phase",
  "artifact_type",
  "skip_phases",
];

export const ROUTE_DEFAULT_CONFIDENCE = {
  auto_route_min: 0.85,
  confirm_min: 0.7,
  ask_below: 0.5,
  always_confirm: [
    "skip_phase",
    "create_story",
    "start_implementation",
    "create_canonical_artifact",
    "new_output_template",
    "duplicate_output",
  ],
};

export const ROUTE_DEFAULT_ROUTES = new Set([
  "init_project",
  "onboard_existing_project",
  "ask_clarification",
  "intake_requirement",
  "classify_artifact",
  "decompose_stories",
  "create_contract",
  "confirm_phase_skip",
  "claim_and_implement",
  "discover_capabilities",
  "technical_decision",
  "validate_story",
  "release_story",
]);

export const TRACE_TYPES = new Set([
  "assumption",
  "decision",
  "gate",
  "claim",
  "handoff",
  "implementation",
  "lock",
  "release",
  "risk",
  "sync",
  "test",
]);

export const TRACE_OUTCOMES = new Set(["passed", "failed", "blocked", "skipped", "ready"]);

export const OPERATIONAL_REDACTION_POLICY = createOperationalRedactionPolicy();

export const WORKFLOW_FINAL_FRESHNESS_PROOF_SCHEMA =
  "workflow-final-freshness-proof:v2";

export const WORKFLOW_FINAL_GIT_SCOPE_SCHEMA = "workflow-final-git-scope:v2";

export const WORKFLOW_FINAL_GIT_OBSERVATION_SCHEMA = "workflow-final-git-observation:v2";

export const WORKFLOW_FINAL_GIT_SCOPE_MAX_PATHS = 10_000;

export const WORKFLOW_FINAL_GIT_SCOPE_MAX_COMMITS = 1_000;

export const WORKFLOW_FINAL_GIT_SCOPE_MAX_COMMIT_PATHS = 100_000;

export const WORKFLOW_ITALIAN_PRESENTATION = new Map([
  ["software-project", "Progetto software"], ["change-request", "Richiesta di modifica"],
  ["technical-assessment", "Valutazione tecnica"], ["generic-governed-process", "Processo governato generico"],
  ["discovery", "Analisi iniziale"], ["analysis", "Analisi"], ["design", "Progettazione"],
  ["implementation", "Implementazione"], ["validation", "Verifica"], ["release", "Rilascio"],
  ["intake", "Raccolta della richiesta"], ["impact-review", "Valutazione dell’impatto"],
  ["approval", "Approvazione"], ["closed", "Chiuso"], ["draft", "Bozza"],
  ["review", "Revisione"], ["approved", "Approvato"], ["execution", "Esecuzione"],
  ["verification", "Verifica"], ["completed", "Completato"],
  ["context-pending", "Contesto da confermare"], ["proposal-pending", "Proposta da confermare"],
  ["authorized", "Autorizzato"], ["running", "In esecuzione"], ["verifying", "In verifica"],
  ["exception-pending", "Eccezione da decidere"], ["failed", "Non riuscito"], ["cancelled", "Annullato"],
  ["context", "Contesto"], ["combined-proposal", "Proposta completa"],
]);

export const WORKFLOW_HUMAN_VALUE_LIMITS = Object.freeze({
  textCharacters: 240,
  collectionItems: 10,
  nestingLevels: 3,
  renderedCharacters: 4_000,
});

export const WORKFLOW_HASH_LIKE_VALUE = /^(?:[a-f0-9]{32,}|[A-Za-z0-9+/]{40,}={0,2})$/u;

export const WORKFLOW_UUID_LIKE_VALUE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;

export const WORKFLOW_UNSAFE_UNICODE = /[\u0000-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFEFF\uFFA0\u{E0001}\u{E0020}-\u{E007F}]/u;

export const WORKFLOW_WINDOWS_DIRECTORY_SYNC_UNSUPPORTED = new Set([
  "EACCES", "EINVAL", "EISDIR", "ENOSYS", "ENOTSUP", "EPERM",
]);

/**
 * Exit codes. A gating pipeline has to tell these apart: a rejected input is
 * the author's problem, a governance denial is a decision someone has to make,
 * and an unreadable store is an operator problem. Every one of them used to
 * exit 1, which made all three indistinguishable to a script.
 *
 * 0   the command completed
 * 1   user error: the request was understood and refused on its merits
 * 2   usage error: the command or its options could not be resolved
 * 3   governance denial: the action was refused by an agreed limit or policy
 * 4   environment error: the host cannot run this software as installed
 * 70  internal error: the software failed in a way the caller cannot correct
 *
 * A command killed by a signal keeps the conventional 128+signal form.
 */
export const EXIT_CODES = Object.freeze({
  userError: 1,
  usageError: 2,
  governanceDenied: 3,
  environmentError: 4,
  internalError: 70,
});

// Only the closed, non-sensitive classifiers of an unexpected failure are
// surfaced: the original message and path may carry private project data.
export const INTERNAL_ERROR_CAUSE_FIELDS = Object.freeze({
  code: /^[A-Z][A-Z0-9_]{0,63}$/u,
  syscall: /^[a-z][a-z0-9_]{0,31}$/u,
});

export const DELIVERY_PROVIDER_ACTIONS = new Set([
  "data.migrate",
  "data.rollback",
  "git.push",
  "pull_request.create",
  "pull_request.merge",
  "pull_request.update",
  "release.local",
  "rollback.verify",
]);

export const GOVERNED_LOCAL_TARGET_ACTIONS = Object.freeze([
  "rollback.verify",
  "data.migrate",
  "data.rollback",
  "release.local",
]);

export const DELIVERY_BOUNDARY_CHECKPOINT_ACTIONS = Object.freeze(["deploy.remote", "pull_request.merge"]);

export const REVERSIBLE_DATA_ACTIONS = Object.freeze(["data.migrate", "data.rollback"]);

export const ROLLBACK_VERIFICATION_ACTIONS = Object.freeze(["rollback.verify"]);

export const STORY_COMMAND_COMMON_OPTIONS = new Set([
  "root",
  "locale",
  "json",
  "full",
  "view",
  "actor",
  "actor-type",
  "actor-name",
  "actor-email",
  "thread-id",
  "run-id",
  "session-id",
  "template-dir",
]);

/** Content above this size, or holding a NUL byte, is not text and is not scanned. */
export const SECRET_SCAN_MAX_FILE_BYTES = 4 * 1024 * 1024;
