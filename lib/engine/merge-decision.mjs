import {
  fail,
} from "../cli/user-error.mjs";
import {
  MERGE_DECISION_MODES,
} from "../autonomy-policy.mjs";
import {
  getOptionString,
} from "../lifecycle/common.mjs";
import {
  now,
} from "./common.mjs";

/**
 * How a pull-request delivery is merged, chosen by the person per delivery
 * when it is proposed and recorded in the approved, hash-bound profile:
 *
 * - `manual`: the person merges the pull request on GitHub; the plugin never
 *   runs pull_request.merge and the delivery is reconciled afterwards.
 * - `after-confirmation`: the plugin merges after the merge confirmation the
 *   level's checkpoints require (the behaviour without a recorded choice).
 * - `automatic`: the plugin merges without a merge confirmation once every
 *   other gate passes (code review, CI, provider checks).
 *
 * A profile without a choice keeps its exact bytes and behaves as
 * `after-confirmation`.
 */

const MERGE_OPTION_KEYS = Object.freeze([
  "merge-actor-type",
  "merge-approval-source",
  "merge-summary",
  "merge-actor",
]);

/** The person's merge choice read from the propose options, or null. */
export function mergeDecisionFromOptions(options, kind, { delegated = null } = {}) {
  const raw = getOptionString(options, "merge");
  const delegatedMode = kind === "pull_request" ? delegated?.policy?.merge : null;
  if (delegatedMode) {
    const related = MERGE_OPTION_KEYS.filter((key) => getOptionString(options, key));
    if (raw || related.length > 0) {
      fail(`Delegation ${delegated.id} already gives the person's answer on merge (${delegatedMode}); drop --merge or the delegation.`);
    }
    if (delegatedMode === "automatic" && getOptionString(options, "standing-approval")) {
      fail("--merge automatic cannot be combined with --standing-approval: under a standing approval every "
        + "delivery action, the merge included, is covered by that approval or confirmed by a person.");
    }
    return {
      mode: delegatedMode,
      source: "delegation",
      actor_id: delegated.actor_id,
      user_words: delegated.statement,
      decided_at: now(),
      delegation_id: delegated.id,
    };
  }
  const related = MERGE_OPTION_KEYS.filter((key) => getOptionString(options, key));
  if (kind !== "pull_request") {
    if (raw || related.length > 0) {
      fail("--merge applies only to pull-request deliveries; a local release is never merged.");
    }
    return null;
  }
  if (!raw) {
    if (related.length > 0) {
      fail(`--${related[0]} records the user's merge choice and needs --merge ${MERGE_DECISION_MODES.join("|")}.`);
    }
    return null;
  }
  if (!MERGE_DECISION_MODES.includes(raw)) {
    fail(`--merge must be one of: ${MERGE_DECISION_MODES.join(", ")}.`);
  }
  const actorType = getOptionString(options, "merge-actor-type");
  const approvalSource = getOptionString(options, "merge-approval-source");
  if (actorType !== "human" || approvalSource !== "explicit-user") {
    fail(
      "The merge choice is the user's decision: record it with --merge-actor-type human "
      + "and --merge-approval-source explicit-user. An agent or system cannot make it.",
    );
  }
  if (raw === "automatic" && getOptionString(options, "standing-approval")) {
    fail(
      "--merge automatic cannot be combined with --standing-approval: under a standing approval every "
      + "delivery action, the merge included, is covered by that approval or confirmed by a person.",
    );
  }
  const userWords = getOptionString(options, "merge-summary");
  if (!userWords) {
    fail("--merge-summary must quote the user's answer to the merge question.");
  }
  return {
    mode: raw,
    source: "explicit-user",
    actor_id: getOptionString(options, "merge-actor") || "user",
    user_words: userWords,
    decided_at: now(),
  };
}

/** The merge mode in force: the recorded choice, or after-confirmation. */
export function mergeDecisionMode(profile) {
  if (profile?.delivery_kind !== "pull_request") return null;
  return profile.pull_request_target?.merge_decision?.mode || "after-confirmation";
}

/**
 * Whether the person chose automatic merge for this profile at a level that
 * allows it. Only then does pull_request.merge run without its checkpoint.
 */
export function automaticMergeChosen(profile, effectiveLevel) {
  return profile?.delivery_kind === "pull_request"
    && profile.pull_request_target?.merge_decision?.mode === "automatic"
    && effectiveLevel !== "supervised";
}

/** Refuse pull_request.merge when the person chose to merge by hand. */
export function assertMergeNotManual(profile, { italian = false } = {}) {
  if (profile?.pull_request_target?.merge_decision?.mode !== "manual") return;
  fail(italian
    ? `Per la consegna ${profile.delivery_id} l’utente ha scelto di fare il merge a mano, quindi il plugin non esegue pull_request.merge. `
      + "Fai il merge della pull request su GitHub, poi esegui 'autonomy delivery reconcile' per registrarlo."
    : `The user chose to merge ${profile.delivery_id} by hand, so the plugin does not run pull_request.merge. `
      + "Merge the pull request on GitHub, then run 'autonomy delivery reconcile' to record it.");
}

const MODE_TEXT = {
  manual: {
    en: "manual (the user merges on GitHub, then the delivery is reconciled)",
    it: "manuale (l’utente fa il merge su GitHub, poi la consegna viene riconciliata)",
  },
  "after-confirmation": {
    en: "after confirmation (the plugin merges once the merge is confirmed)",
    it: "dopo conferma (il plugin fa il merge dopo la conferma)",
  },
  automatic: {
    en: "automatic (the plugin merges once every other gate passes, without a merge confirmation)",
    it: "automatico (il plugin fa il merge quando tutti gli altri controlli passano, senza conferma del merge)",
  },
};

/** One plain sentence on the merge choice, in the reader's language. */
export function mergeDecisionSentence(profile, { italian = false } = {}) {
  const mode = mergeDecisionMode(profile);
  if (!mode) return null;
  const locale = italian ? "it" : "en";
  const decision = profile.pull_request_target?.merge_decision;
  const source = decision?.source === "delegation"
    ? decision.user_words
    : decision
      ? (italian ? "scelto dall’utente per questa consegna" : "chosen by the user for this delivery")
      : (italian ? "nessuna scelta registrata" : "no choice recorded");
  return `Merge: ${MODE_TEXT[mode][locale]}; ${source}.`;
}
