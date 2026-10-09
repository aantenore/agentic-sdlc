import path from "node:path";
import {
  humanApprovalFields,
} from "../lifecycle/authorization.mjs";
import {
  deliveryAutonomyRoot,
} from "../lifecycle/delivery.mjs";
import {
  toProjectPath,
} from "../lifecycle/project.mjs";
import {
  requirementsRoot,
  workBreakdownRoot,
} from "../lifecycle/story.mjs";
import {
  workflowDefinitionsRoot,
  workflowOverlaysRoot,
} from "../lifecycle/workflow.mjs";
import {
  fs,
} from "../runtime/host.mjs";
import {
  readDependencyProposals,
} from "./authorization.mjs";
import {
  standingApprovalOverview,
} from "./standing.mjs";
import {
  readProjectJson,
  safeReadDir,
} from "./storage.mjs";
import {
  listVersionedWorkflowRecords,
} from "./workflow.mjs";

const APPROVE_FLAGS = "--actor-type human --approval-source explicit-user --summary \"<your decision>\"";

/**
 * Proposals recorded by the CLI that wait for a person's approval: proposed
 * requirements, breakdowns, dependency graphs, delivery autonomy profiles,
 * workflow definitions and overlays, and standing approvals. They are listed
 * by status and approval requests; a record that cannot be read is skipped
 * here because doctor and gate checks report it with its exact cause.
 */
export function collectPendingProposalRequests(context, { storyId = null } = {}) {
  const requests = [
    ...safeRecords(() => readJsonRecords(context, requirementsRoot(context)))
      .filter(({ record }) => record.status === "proposed")
      .map(({ record, filePath }) => proposalRequest(context, {
        type: "requirement_approval",
        id: record.id,
        filePath,
        title: `Requirement (${record.id})${record.title ? `: ${record.title}` : ""}`,
        why: "Stories and work can be planned only from an approved requirement.",
        review: [
          record.summary || record.scope_summary ? `Outcome: ${record.summary || record.scope_summary}` : null,
          Array.isArray(record.acceptance_criteria) && record.acceptance_criteria.length
            ? `Completion checks: ${record.acceptance_criteria.map((item) => item.text || item.description || item).join("; ")}`
            : null,
          record.autonomy_profile_id ? `Independence limits: ${record.autonomy_profile_id}` : null,
        ],
        command: `agentic-sdlc requirement approve --id ${record.id} ${APPROVE_FLAGS}`,
      })),
    ...safeRecords(() => readJsonRecords(context, workBreakdownRoot(context), ["project-policy.json"]))
      .filter(({ record }) => record.status === "proposed")
      .map(({ record, filePath }) => proposalRequest(context, {
        type: "breakdown_approval",
        id: record.id,
        filePath,
        title: `Work breakdown (${record.id})`,
        why: "The proposed split of a requirement into deliverable work is not used until it is approved.",
        review: [
          record.requirement_id ? `Requirement: ${record.requirement_id}` : null,
          Array.isArray(record.stories) ? `Proposed work items: ${record.stories.length}` : null,
        ],
        command: `agentic-sdlc breakdown approve --id ${record.id} ${APPROVE_FLAGS}`,
      })),
    ...safeRecords(() => readDependencyProposals(context).map((record) => ({ record, filePath: null })))
      .filter(({ record }) => record.status === "proposed")
      .map(({ record }) => proposalRequest(context, {
        type: "dependency_approval",
        id: record.id,
        filePath: null,
        title: record.kind === "dependency_revision"
          ? `Change to the approved work order (${record.id})`
          : `Work order and dependencies (${record.id})`,
        why: record.kind === "dependency_revision"
          ? "The approved dependencies keep applying unchanged until this change is approved."
          : "The proposed order between work items is not enforced until it is approved.",
        review: [
          Array.isArray(record.retire) && record.retire.length > 0 ? `Dependencies to retire: ${record.retire.length}` : null,
          Array.isArray(record.edges) ? `Proposed dependencies: ${record.edges.length}` : null,
        ],
        command: `agentic-sdlc dependency approve --id ${record.id} ${APPROVE_FLAGS}`,
      })),
    ...safeRecords(() => readJsonRecords(context, deliveryAutonomyRoot(context)))
      .filter(({ record }) => record.status === "proposed")
      .filter(({ record }) => !storyId || record.story_id === storyId || record.target?.story_id === storyId)
      .map(({ record, filePath }) => proposalRequest(context, {
        type: "delivery_autonomy_approval",
        id: record.id,
        filePath,
        storyId: record.story_id || record.target?.story_id || null,
        title: `Independence for one delivery (${record.id})`,
        why: "The proposed limits for this delivery apply only after you approve them.",
        review: [
          record.kind || record.delivery_kind ? `Delivery kind: ${record.kind || record.delivery_kind}` : null,
          record.requested_level || record.autonomy_level ? `Requested independence: ${record.requested_level || record.autonomy_level}` : null,
          record.effective_level && record.effective_level !== record.requested_level
            ? `Capped by the approved ceiling to: ${record.effective_level}`
            : null,
        ],
        command: `agentic-sdlc autonomy delivery approve --id ${record.id} ${APPROVE_FLAGS}`,
      })),
    ...workflowProposalRequests(context, "definition"),
    ...workflowProposalRequests(context, "overlay"),
    ...standingApprovalOverview(context).approvals
      .filter((approval) => approval.status === "proposed")
      .map((approval) => proposalRequest(context, {
        type: "standing_approval_approval",
        id: approval.id,
        filePath: null,
        title: `Standing approval (${approval.id})${approval.description ? `: ${approval.description}` : ""}`,
        why: "A standing approval covers repeated deliveries of one kind only after you approve it.",
        review: [
          approval.max_deliveries ? `Maximum deliveries: ${approval.max_deliveries}` : null,
          approval.expires_at ? `Expires: ${approval.expires_at}` : null,
          approval.allowed_write_paths?.length ? `Allowed paths: ${approval.allowed_write_paths.join(", ")}` : null,
          approval.signed_approval_required ? "Approval: needs a receipt signed by the trusted host for this exact proposal" : null,
        ],
        command: `agentic-sdlc autonomy standing approve --id ${approval.id} ${APPROVE_FLAGS}`
          + (approval.signed_approval_required ? " --host-receipt-file <receipt-signed-by-the-trusted-host.json>" : ""),
      })),
  ];
  return storyId
    ? requests.filter((request) => request.story_id === storyId)
    : requests;
}

function workflowProposalRequests(context, kind) {
  const root = kind === "definition" ? workflowDefinitionsRoot(context) : workflowOverlaysRoot(context);
  const versionFlag = kind === "definition" ? "--definition-version" : "--overlay-version";
  return safeRecords(() => listVersionedWorkflowRecords(context, root))
    .filter(({ record }) => record?.status === "proposed")
    .map(({ id, version, path: filePath, record }) => proposalRequest(context, {
      type: `workflow_${kind}_approval`,
      id: record.id || id,
      filePath,
      version,
      title: `Workflow ${kind} (${record.id || id} version ${version})`,
      why: `The proposed workflow ${kind} is not used until it is approved.`,
      review: [
        Array.isArray(record.phases) ? `Phases: ${record.phases.map((phase) => phase.id || phase).join(", ")}` : null,
      ],
      command: `agentic-sdlc workflow ${kind} approve --id ${record.id || id} ${versionFlag} ${version} ${APPROVE_FLAGS}`,
    }));
}

function proposalRequest(context, { type, id, filePath, storyId = null, title, why, review, command, version = null }) {
  return {
    id: `approve-${type.replace(/_approval$/u, "").replaceAll("_", "-")}-${id}${version ? `-v${version}` : ""}`,
    type,
    status: "needs_explicit_user_approval",
    summary: `${title} is proposed and waits for your approval.`,
    subject_id: id,
    subject_status: "proposed",
    ...(version ? { subject_version: String(version) } : {}),
    story_id: storyId,
    sources: filePath ? [toProjectPath(context, filePath)] : [],
    ...humanApprovalFields({
      title,
      why_needed: why,
      review_items: review,
      approval_meaning: "Approving records your decision for this item only; it does not approve other items or start work by itself.",
      after_approval: "The next planned step can use the approved item.",
    }),
    suggested_command: command,
  };
}

function readJsonRecords(context, root, excluded = []) {
  if (!fs.existsSync(root)) return [];
  return safeReadDir(root)
    .filter((name) => name.endsWith(".json") && !excluded.includes(name))
    .sort()
    .map((name) => path.join(root, name))
    .filter((filePath) => fs.statSync(filePath).isFile())
    .map((filePath) => ({ filePath, record: safeRecords(() => readProjectJson(context, filePath), null) }))
    .filter(({ record }) => record && typeof record === "object" && !Array.isArray(record));
}

function safeRecords(load, fallback = []) {
  try {
    return load();
  } catch {
    return fallback;
  }
}
