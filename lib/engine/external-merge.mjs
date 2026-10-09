import path from "node:path";
import {
  runsInsideAgentHost,
} from "../agent-host.mjs";
import {
  fail,
} from "../cli/user-error.mjs";
import {
  observePullRequestMerge,
} from "../delivery/providers/github-cli.mjs";
import {
  autonomyLifecycleReceiptHash,
  parsePullRequestUrlIdentity,
  requireFormalApprovalActor,
} from "../lifecycle/authorization.mjs";
import {
  getOptionString,
  normalizeId,
  requireOption,
  samePullRequestUrl,
} from "../lifecycle/common.mjs";
import {
  compareDeliveryAuthorizationOrder,
  deliveryActionReceiptRef,
  deliveryAutonomyPath,
  deliveryAutonomyRoot,
  deliveryCloseReceiptPath,
  deliveryExecutionRoot,
  deliveryStartReceiptRef,
} from "../lifecycle/delivery.mjs";
import {
  humanGuidanceLocale,
} from "../lifecycle/guidance.mjs";
import {
  toProjectPath,
} from "../lifecycle/project.mjs";
import {
  orchestrationPolicy,
} from "../story-claim-shared-state.mjs";
import {
  buildApprovalRecord,
} from "./authorization.mjs";
import {
  assertRecordSchema,
  buildAttribution,
  enforceMergeCodeReview,
  now,
  validateRecordSchema,
} from "./common.mjs";
import {
  codeReviewRequirement,
} from "./code-review-requirement.mjs";
import {
  allDeliveryActionReceipts,
  currentDeliveryExecutionState,
  deliveryActionReceipts,
  effectiveDeliveryProfileStatus,
  readDeliveryAutonomyProfile,
} from "./delivery.mjs";
import {
  ensureInitialized,
} from "./migration.mjs";
import {
  output,
} from "./output.mjs";
import {
  firstLine,
  runGit,
} from "./shared-refs.mjs";
import {
  acquireFileLock,
  readProjectJson,
  safeReadDir,
  writeJsonFile,
} from "./storage.mjs";
import {
  appendTraceEvent,
} from "./story.mjs";
import {
  Date,
  fs,
} from "../runtime/host.mjs";

/**
 * A pull request a person merged outside the plugin, acknowledged afterwards.
 *
 * The plugin merges a pull request only through an authorized
 * pull_request.merge. When a person merges it on GitHub instead, the story
 * would stay half delivered. `autonomy delivery reconcile` lets a person (or
 * CI) acknowledge that merge, after the plugin has checked it on GitHub: the
 * PR is merged, after the last action the plugin recorded, at exactly the
 * head the plugin's receipts cover, on the approved branches, and with any
 * required code review of that head. The result is never the same as a
 * governed merge: a started delivery ends as `merged_externally`, and a
 * delivery already closed as ready_for_review keeps that close and gains the
 * acknowledgement next to it.
 */

export const EXTERNAL_MERGE_TERMINAL_STATUS = "merged_externally";
const RECEIPT_KIND = "delivery_external_merge_receipt";
const RECEIPT_SCHEMA = "delivery-external-merge-receipt.schema.json";
const RECEIPT_VERSION = "delivery-external-merge-receipt:v1";
const COVERING_ACTIONS = new Set(["git.push", "pull_request.create", "pull_request.update"]);
const SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

export function externalMergeReceiptPath(context, profileId) {
  return path.join(deliveryExecutionRoot(context, profileId), "external-merge.json");
}

/**
 * The acknowledgement of an external merge for this exact profile, or null.
 * A record that fails its schema, hash, or profile binding is reported as
 * invalid instead of being trusted.
 */
export function readExternalMergeReceipt(context, profile) {
  const receiptPath = externalMergeReceiptPath(context, profile.id);
  if (!fs.existsSync(receiptPath)) return { receipt: null, path: null, errors: [] };
  const projectPath = toProjectPath(context, receiptPath);
  let record;
  try {
    record = readProjectJson(context, receiptPath);
  } catch (error) {
    return { receipt: null, path: projectPath, errors: [`${projectPath} cannot be read: ${error.message}`] };
  }
  const errors = [];
  const schema = validateRecordSchema(record, RECEIPT_SCHEMA);
  if (!schema.valid) errors.push(`${projectPath} does not match its schema`);
  if (record?.receipt_hash !== autonomyLifecycleReceiptHash(record)) errors.push(`${projectPath} changed after it was recorded`);
  if (record?.profile_ref?.id !== profile.id || record?.profile_ref?.hash !== profile.profile_hash) {
    errors.push(`${projectPath} belongs to a different delivery profile`);
  }
  return { receipt: errors.length === 0 ? record : null, path: projectPath, errors };
}

/**
 * Where a delivery's merged code is, when it is merged: through the plugin
 * (`merged`), or outside it and acknowledged (`merged_externally`, or an
 * acknowledgement next to a ready_for_review close). null when not merged.
 */
export function externalMergeEvidence(context, profile, state) {
  if (profile.delivery_kind !== "pull_request") return null;
  if (state.lifecycle_status !== "terminal") return null;
  if (![EXTERNAL_MERGE_TERMINAL_STATUS, "ready_for_review"].includes(state.status)) return null;
  const { receipt } = readExternalMergeReceipt(context, profile);
  if (!receipt) return null;
  if (state.status === EXTERNAL_MERGE_TERMINAL_STATUS && (
    state.close_receipt?.terminal_action_receipt_ref?.id !== receipt.id
    || state.close_receipt?.terminal_action_receipt_ref?.hash !== receipt.receipt_hash
  )) return null;
  return {
    merge_commit_sha: receipt.pull_request.merge_commit_sha,
    merged_at: receipt.pull_request.merged_at,
    receipt,
  };
}

/**
 * The head the plugin's own receipts cover: the source of the latest passing
 * git.push or pull-request create/update, or the reviewed head an existing
 * pull request was pinned to. null when nothing covers a head.
 */
export function coveredPullRequestHead(profile, actions) {
  const latest = actions
    .filter((receipt) => COVERING_ACTIONS.has(receipt.action)
      && receipt.status === "completed"
      && receipt.outcome === "passed")
    .sort(compareDeliveryAuthorizationOrder)
    .at(-1) || null;
  if (latest) {
    const sha = latest.action === "git.push"
      ? latest.action_details?.push?.source_sha
      : latest.action_details?.pull_request?.source_sha;
    return SHA_PATTERN.test(String(sha || "")) ? { sha: String(sha).toLowerCase(), receipt: latest } : null;
  }
  const pinned = profile.pull_request_target?.reviewed_head_sha;
  return SHA_PATTERN.test(String(pinned || "")) ? { sha: String(pinned).toLowerCase(), receipt: null } : null;
}

/** The PR URL the plugin verified for this delivery, when one is recorded. */
function verifiedPullRequestUrl(profile, actions) {
  if (profile.pull_request_target?.pr_url) return profile.pull_request_target.pr_url;
  const verified = actions
    .filter((receipt) => ["pull_request.create", "pull_request.update"].includes(receipt.action)
      && receipt.status === "completed"
      && receipt.outcome === "passed")
    .sort(compareDeliveryAuthorizationOrder)
    .map((receipt) => receipt.action_details?.provider_operation?.completion_receipt?.proof?.pr_url
      || receipt.action_details?.pull_request?.pr_url)
    .filter(Boolean);
  return verified.at(-1) || null;
}

function latestPluginActionAt(state, actions) {
  const times = [
    state.start_receipt?.started_at,
    ...actions.map((receipt) => receipt.authorized_at),
  ].map((value) => Date.parse(value || "")).filter(Number.isFinite);
  return times.length > 0 ? Math.max(...times) : null;
}

const REFUSAL = {
  en: {
    result: "The merge was not acknowledged.",
    protection_boundary: "Nothing was recorded; the delivery and its story are unchanged.",
  },
  it: {
    result: "Il merge non è stato preso in carico.",
    protection_boundary: "Nulla è stato registrato; la consegna e la sua storia sono invariate.",
  },
};

function refuse(message, en, it) {
  fail(message, {
    en: { ...REFUSAL.en, ...en },
    it: { ...REFUSAL.it, ...it },
  });
}

/** `autonomy delivery reconcile`: acknowledge a pull request merged outside the plugin. */
export function reconcileExternalMerge(context, options) {
  ensureInitialized(context);
  const profileId = normalizeId(requireOption(options, "id"));
  const prUrlOption = requireOption(options, "pr-url");
  const italian = humanGuidanceLocale(options) === "it";
  const userCommand = `autonomy delivery reconcile --id ${profileId} --pr-url ${prUrlOption} `
    + "--actor-type human --approval-source explicit-user --summary \"<your words>\"";
  if (runsInsideAgentHost()) {
    refuse(
      "Acknowledging a merge made outside the plugin is a person's decision and cannot run inside an agent session. "
      + `The user runs '${userCommand}' in their own terminal.`,
      {
        impact: "An agent cannot declare delivered a merge the plugin did not perform.",
        required_decision: "The person who knows about the merge acknowledges it from their own terminal.",
        next_action: `Run '${userCommand}' outside the agent session.`,
      },
      {
        impact: "Un agente non può dichiarare consegnato un merge che il plugin non ha eseguito.",
        required_decision: "La persona che conosce il merge lo prende in carico dal proprio terminale.",
        next_action: `Esegui '${userCommand}' fuori dalla sessione dell’agente.`,
      },
    );
  }
  const reason = getOptionString(options, "summary");
  if (!reason) fail("--summary must give, in the person's own words, why the merge made outside the plugin is acknowledged.");
  const profilePath = deliveryAutonomyPath(context, profileId);
  const releaseLock = acquireFileLock(`${profilePath}.lock`);
  try {
    const profile = readDeliveryAutonomyProfile(context, profileId);
    if (profile.delivery_kind !== "pull_request") {
      fail(`Delivery ${profile.delivery_id} is a ${profile.delivery_kind}; only a pull request can be merged outside the plugin.`);
    }
    if (effectiveDeliveryProfileStatus(context, profile).status === "revoked") {
      fail(`Delivery profile ${profile.id} is revoked; a revoked delivery cannot be reconciled.`);
    }
    const state = currentDeliveryExecutionState(context, profile);
    if (state.lifecycle_status === "available") {
      fail(`Delivery ${profile.delivery_id} was never started, so no plugin receipt covers what was merged.`);
    }
    const existing = readExternalMergeReceipt(context, profile);
    if (existing.errors.length > 0) {
      fail(`The recorded acknowledgement of delivery ${profile.delivery_id} is invalid: ${existing.errors.join("; ")}.`);
    }
    if (existing.receipt) {
      output(options, {
        status: "already_reconciled",
        idempotent: true,
        external_merge: existing.receipt,
        external_merge_path: existing.path,
        terminal_status: state.status,
      }, [italian
        ? `Il merge esterno di ${profile.delivery_id} è già stato preso in carico (${existing.path}).`
        : `The external merge of ${profile.delivery_id} is already acknowledged (${existing.path}).`]);
      return;
    }
    if (state.lifecycle_status === "terminal" && state.status !== "ready_for_review") {
      fail(`Delivery ${profile.delivery_id} is already terminal as ${state.status}; only a started delivery or one closed as ready_for_review can acknowledge an external merge.`);
    }
    const target = profile.pull_request_target;
    const identity = parsePullRequestUrlIdentity(prUrlOption, target.repository, "--pr-url");
    const actions = deliveryActionReceipts(context, profile.id);
    const verifiedUrl = verifiedPullRequestUrl(profile, actions);
    if (verifiedUrl && !samePullRequestUrl(verifiedUrl, identity.url)) {
      refuse(
        `--pr-url ${identity.url} is not the pull request the plugin verified for ${profile.delivery_id} (${verifiedUrl}).`,
        {
          impact: "Only the pull request this delivery created or was pinned to can be acknowledged.",
          required_decision: "Name the delivery's own pull request.",
          next_action: `Repeat with --pr-url ${verifiedUrl}.`,
        },
        {
          impact: "Si può prendere in carico solo la pull request creata o fissata da questa consegna.",
          required_decision: "Indica la pull request di questa consegna.",
          next_action: `Ripeti con --pr-url ${verifiedUrl}.`,
        },
      );
    }
    const covered = coveredPullRequestHead(profile, actions);
    if (!covered) {
      refuse(
        `No passing git.push or pull-request receipt of ${profile.delivery_id} covers a head, so the merged code cannot be tied to the plugin's records.`,
        {
          impact: "The plugin cannot tell which commits it verified.",
          required_decision: "Close the delivery another way, or deliver the change again through the plugin.",
          next_action: `Inspect the delivery with 'autonomy delivery explain --id ${profile.id}'.`,
        },
        {
          impact: "Il plugin non può sapere quali commit ha verificato.",
          required_decision: "Chiudi la consegna in un altro modo oppure consegna di nuovo la modifica tramite il plugin.",
          next_action: `Controlla la consegna con 'autonomy delivery explain --id ${profile.id}'.`,
        },
      );
    }
    let observed;
    try {
      observed = observePullRequestMerge(identity.url);
    } catch (error) {
      fail(`GitHub could not be asked about ${identity.url}: ${error.message}. The acknowledgement needs authenticated GitHub CLI access (gh).`);
    }
    const problems = [];
    if (observed.state !== "MERGED" || !observed.merge_commit_sha || !observed.merged_at) {
      refuse(
        `Pull request ${identity.url} is not merged on GitHub (state ${observed.state || "unknown"}).`,
        {
          impact: "Only a merge GitHub confirms can be acknowledged.",
          required_decision: "Merge the pull request, or let the plugin merge it.",
          next_action: "Repeat once GitHub shows the pull request as merged.",
        },
        {
          impact: "Si può prendere in carico solo un merge confermato da GitHub.",
          required_decision: "Esegui il merge della pull request, oppure lascialo al plugin.",
          next_action: "Ripeti quando GitHub mostra la pull request come unita.",
        },
      );
    }
    if (!samePullRequestUrl(observed.pr_url, identity.url)) problems.push("GitHub answered for a different pull request");
    if (observed.head_branch !== target.head_branch) {
      problems.push(`its head branch is ${observed.head_branch}, not the approved ${target.head_branch}`);
    }
    if (observed.base_branch !== target.base_branch) {
      problems.push(`it was merged into ${observed.base_branch}, not the approved ${target.base_branch}`);
    }
    const lastActionAt = latestPluginActionAt(state, actions);
    const mergedAt = Date.parse(observed.merged_at);
    if (!Number.isFinite(mergedAt) || (lastActionAt !== null && mergedAt < lastActionAt)) {
      problems.push("it was merged before the last action the plugin recorded for this delivery");
    }
    const uncovered = observed.head_sha !== covered.sha;
    if (uncovered) {
      problems.push(`its merged head ${String(observed.head_sha).slice(0, 12)} is not the head ${covered.sha.slice(0, 12)} covered by the plugin's receipts`);
    }
    if (problems.length > 0) {
      refuse(
        `The merge of ${identity.url} cannot be acknowledged for ${profile.delivery_id}: ${problems.join("; ")}.`,
        {
          impact: uncovered
            ? "The pull request contains commits no plugin receipt covers, so they were never verified."
            : "What was merged is not what this delivery approved.",
          required_decision: "Decide how to deliver the unverified part: a new delivery for it, or closing this one another way.",
          next_action: `Inspect the delivery with 'autonomy delivery explain --id ${profile.id}'.`,
        },
        {
          impact: uncovered
            ? "La pull request contiene commit che nessuna ricevuta del plugin copre, quindi non sono mai stati verificati."
            : "Ciò che è stato unito non è ciò che questa consegna ha approvato.",
          required_decision: "Decidi come consegnare la parte non verificata: una nuova consegna oppure la chiusura di questa in altro modo.",
          next_action: `Controlla la consegna con 'autonomy delivery explain --id ${profile.id}'.`,
        },
      );
    }
    const pushedBase = covered.receipt?.action === "git.push"
      ? actions.find((receipt) => receipt.id === covered.receipt.authorization_receipt_ref?.id)
        ?.action_details?.base_precondition?.observed_sha
      : null;
    const baseSha = SHA_PATTERN.test(String(pushedBase || "")) ? pushedBase : mergeBase(context, covered.sha, target.base_branch);
    // The same review rules as a governed merge, on the head that was merged.
    enforceMergeCodeReview(context, profile, { head_sha: covered.sha, base_sha: baseSha });
    const review = codeReviewRequirement(context, profile);

    const attribution = buildAttribution(context, options, "autonomy.delivery.reconcile");
    requireFormalApprovalActor(context, options, attribution, "Acknowledging a merge made outside the plugin");
    const approvalSource = getOptionString(options, "approval-source");
    if (!["human", "ci"].includes(attribution.actor.type) || !["explicit-user", "ci"].includes(approvalSource)) {
      fail("Acknowledging a merge made outside the plugin needs --actor-type human or ci and --approval-source explicit-user or ci.");
    }
    const startRef = deliveryStartReceiptRef(context, profile, state.start_receipt);
    const pullRequest = {
      url: identity.url,
      number: identity.number,
      repository: target.repository,
      head_branch: observed.head_branch,
      base_branch: observed.base_branch,
      head_sha: covered.sha,
      base_sha: baseSha || null,
      merge_commit_sha: observed.merge_commit_sha.toLowerCase(),
      merged_at: observed.merged_at,
      merged_by: observed.merged_by,
    };
    const subject = {
      profile_id: profile.id,
      profile_hash: profile.profile_hash,
      start_receipt_hash: state.start_receipt.receipt_hash,
      pull_request: pullRequest,
      reason,
    };
    const approval = buildApprovalRecord(context, options, attribution, {
      subject,
      subject_id_field: "profile_id",
      subject_id: profile.id,
      status: "approved",
      scope: "delivery-external-merge",
      label: `external merge ${profile.id}`,
    });
    const recordedAt = now();
    const receiptPath = externalMergeReceiptPath(context, profile.id);
    const base = {
      id: `AUT-EXTMERGE-${normalizeId(profile.id)}`,
      kind: RECEIPT_KIND,
      schema_version: RECEIPT_VERSION,
      profile_ref: { id: profile.id, path: toProjectPath(context, profilePath), hash: profile.profile_hash },
      delivery: { id: profile.delivery_id, kind: profile.delivery_kind },
      start_receipt_ref: startRef,
      covered_head_receipt_ref: covered.receipt ? deliveryActionReceiptRef(context, covered.receipt) : null,
      delivery_status_at_reconcile: state.status,
      pull_request: pullRequest,
      provider: { id: "github-cli", observed_at: recordedAt },
      code_review: { required: review.required, source: review.source },
      reason,
      approval,
      recorded_by: attribution.actor,
      recorded_at: recordedAt,
      audit: { git: attribution.git, run: attribution.run },
    };
    const receipt = { ...base, receipt_hash: autonomyLifecycleReceiptHash(base), hash_algorithm: "sha256:stable-json:v1" };
    assertRecordSchema(receipt, RECEIPT_SCHEMA, `External merge receipt ${profile.id}`);
    writeJsonFile(receiptPath, receipt, { atomicCreate: true });
    const receiptRef = { id: receipt.id, path: toProjectPath(context, receiptPath), hash: receipt.receipt_hash };

    let closeReceipt = null;
    if (state.lifecycle_status === "started") {
      const closeBase = {
        id: `AUT-CLOSE-${normalizeId(profile.id)}`,
        kind: "delivery_close_receipt",
        schema_version: "delivery-close-receipt:v1",
        profile_ref: receipt.profile_ref,
        delivery: receipt.delivery,
        start_receipt_ref: startRef,
        terminal_action_receipt_ref: receiptRef,
        terminal_status: EXTERNAL_MERGE_TERMINAL_STATUS,
        reason,
        approval,
        closed_by: attribution.actor,
        closed_at: recordedAt,
        audit: { git: attribution.git, run: attribution.run },
      };
      closeReceipt = { ...closeBase, receipt_hash: autonomyLifecycleReceiptHash(closeBase), hash_algorithm: "sha256:stable-json:v1" };
      assertRecordSchema(closeReceipt, "delivery-close-receipt.schema.json", `Delivery close receipt ${profile.id}`);
      writeJsonFile(deliveryCloseReceiptPath(context, profile.id), closeReceipt, { atomicCreate: true });
    }
    const event = appendTraceEvent(context, profile.story_refs[0]?.id || null, {
      type: "release",
      summary: `Acknowledged ${identity.url}, merged outside the plugin as ${pullRequest.merge_commit_sha.slice(0, 12)}`
        + `${pullRequest.merged_by ? ` by ${pullRequest.merged_by}` : ""}`,
      action: "autonomy.delivery.reconcile",
      actor: attribution.actor,
      outcome: "passed",
      evidence: [receiptRef.path, ...(closeReceipt ? [toProjectPath(context, deliveryCloseReceiptPath(context, profile.id))] : [])],
      related: [profile.id, profile.delivery_id],
      git: attribution.git,
      run: attribution.run,
    });
    const terminalStatus = closeReceipt ? EXTERNAL_MERGE_TERMINAL_STATUS : state.status;
    output(options, {
      status: "reconciled",
      terminal_status: terminalStatus,
      external_merge: receipt,
      external_merge_path: receiptRef.path,
      close_receipt: closeReceipt,
      event,
    }, italian
      ? [
          `Merge esterno preso in carico per ${profile.delivery_id}: ${identity.url} unita come ${pullRequest.merge_commit_sha.slice(0, 12)}${pullRequest.merged_by ? ` da ${pullRequest.merged_by}` : ""} il ${pullRequest.merged_at}.`,
          closeReceipt
            ? `La consegna è chiusa come ${EXTERNAL_MERGE_TERMINAL_STATUS}: unita fuori dal plugin e presa in carico dopo.`
            : "La consegna resta chiusa come ready_for_review; il merge esterno è registrato accanto alla chiusura.",
          `Ricevuta: ${receiptRef.path}`,
        ]
      : [
          `Acknowledged the external merge of ${profile.delivery_id}: ${identity.url} merged as ${pullRequest.merge_commit_sha.slice(0, 12)}${pullRequest.merged_by ? ` by ${pullRequest.merged_by}` : ""} at ${pullRequest.merged_at}.`,
          closeReceipt
            ? `The delivery is closed as ${EXTERNAL_MERGE_TERMINAL_STATUS}: merged outside the plugin and acknowledged afterwards.`
            : "The delivery stays closed as ready_for_review; the external merge is recorded next to that close.",
          `Receipt: ${receiptRef.path}`,
        ]);
  } finally {
    releaseLock();
  }
}

function mergeBase(context, headSha, baseBranch) {
  for (const ref of [`refs/remotes/origin/${baseBranch}`, `refs/heads/${baseBranch}`]) {
    const result = runGit(context.root, ["merge-base", headSha, ref], { timeoutSeconds: 20 });
    const sha = firstLine(result.stdout).toLowerCase();
    if (result.ok && SHA_PATTERN.test(sha)) return sha;
  }
  return null;
}

/**
 * Pull-request deliveries whose covered head is already on the remote base
 * branch although the plugin never merged them: merged outside the plugin
 * with a merge commit or a fast-forward. A squash or rebase merge leaves no
 * trace in git and shows up only through 'autonomy delivery reconcile'.
 * Read-only; status lists them with the command a person runs.
 */
export function detectExternalMerges(context) {
  let remote = "origin";
  try {
    remote = orchestrationPolicy(context.config).coordination.remote;
  } catch {
    // An invalid configuration is reported by status itself.
  }
  const found = [];
  let receiptsByProfile = null;
  for (const name of safeReadDir(deliveryAutonomyRoot(context)).sort()) {
    if (!name.endsWith(".json")) continue;
    try {
      const profile = readDeliveryAutonomyProfile(context, path.basename(name, ".json"));
      if (profile.delivery_kind !== "pull_request") continue;
      const state = currentDeliveryExecutionState(context, profile);
      const pending = state.lifecycle_status === "started"
        || (state.lifecycle_status === "terminal" && state.status === "ready_for_review");
      if (!pending) continue;
      if (readExternalMergeReceipt(context, profile).receipt) continue;
      if (receiptsByProfile === null) {
        // One read of the action receipts for every delivery.
        receiptsByProfile = new Map();
        for (const receipt of allDeliveryActionReceipts(context)) {
          const id = receipt.profile_ref?.id;
          if (!receiptsByProfile.has(id)) receiptsByProfile.set(id, []);
          receiptsByProfile.get(id).push(receipt);
        }
      }
      const covered = coveredPullRequestHead(profile, receiptsByProfile.get(profile.id) || []);
      if (!covered) continue;
      const baseRef = `refs/remotes/${remote}/${profile.pull_request_target.base_branch}`;
      const onBase = runGit(context.root, ["merge-base", "--is-ancestor", covered.sha, baseRef], { timeoutSeconds: 20 });
      if (!onBase.ok) continue;
      found.push({
        profile_id: profile.id,
        delivery_id: profile.delivery_id,
        story_id: profile.story_refs?.[0]?.id || null,
        base_branch: profile.pull_request_target.base_branch,
        head_sha: covered.sha,
        delivery_status: state.status,
        command: `autonomy delivery reconcile --id ${profile.id} --pr-url <pull-request-url> --actor-type human --approval-source explicit-user --summary "<your words>"`,
      });
    } catch {
      continue;
    }
  }
  return found;
}

/** Status lines for merges found outside the plugin. */
export function externalMergeStatusLines(items, { italian = false } = {}) {
  return items.map((item) => (italian
    ? `Merge fuori dal plugin: la consegna ${item.delivery_id} (storia ${item.story_id}) risulta già unita in ${item.base_branch} al commit ${item.head_sha.slice(0, 12)}. Una persona la prende in carico dal proprio terminale con: ${item.command}`
    : `Merged outside the plugin: delivery ${item.delivery_id} (story ${item.story_id}) is already in ${item.base_branch} at ${item.head_sha.slice(0, 12)}. A person acknowledges it from their own terminal with: ${item.command}`));
}
