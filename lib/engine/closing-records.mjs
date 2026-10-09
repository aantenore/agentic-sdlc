import {
  toProjectPath,
} from "../lifecycle/project.mjs";
import {
  workflowFinalGateReceiptPath,
} from "../lifecycle/workflow.mjs";
import {
  orchestrationPolicy,
} from "../story-claim-shared-state.mjs";
import {
  remoteBaseRef,
} from "./merge-drift.mjs";
import {
  isGitRepository,
  runGit,
} from "./shared-refs.mjs";

/**
 * Whether a finished story's closing record (its final lifecycle receipt)
 * is on the remote base branch, as the last fetch left it. Until it is,
 * other computers learn that the story is finished only from its shared
 * claim. Read-only: nothing is fetched. Returns `{ checked, on_remote,
 * remote, branch, path }`; `checked` is false when claims are kept on this
 * computer only or the base branch is unknown.
 */
export function closingRecordsOnRemote(context, storyId) {
  let policy;
  try {
    policy = orchestrationPolicy(context.config);
  } catch {
    return { checked: false };
  }
  if (policy.coordination.mode === "local_only") return { checked: false };
  const timeoutSeconds = policy.coordination.timeout_seconds;
  if (isGitRepository(context, timeoutSeconds) !== true) return { checked: false };
  const remote = policy.coordination.remote;
  const base = remoteBaseRef(context, remote, policy.merge_drift.base_branch, timeoutSeconds);
  if (!base) return { checked: false };
  const recordPath = toProjectPath(context, workflowFinalGateReceiptPath(context, storyId));
  const found = runGit(context.root, ["cat-file", "-e", `${base.ref}:./${recordPath}`], { timeoutSeconds });
  return { checked: true, on_remote: found.ok, remote, branch: base.branch, path: recordPath, story_id: storyId };
}

/** Human line warning that a finished story's closing records are not on the remote yet, or null. */
export function closingRecordsLine(closing, { italian = false } = {}) {
  if (!closing?.checked || closing.on_remote) return null;
  return italian
    ? `Avviso: i record di chiusura (${closing.path}) non sono ancora su ${closing.remote}/${closing.branch}: pubblicali con story publish-records --id ${closing.story_id} e unisci la sua pull request; fino ad allora gli altri computer la vedono conclusa solo tramite l’assegnazione condivisa`
    : `Warning: the closing records (${closing.path}) are not on ${closing.remote}/${closing.branch} yet: publish them with story publish-records --id ${closing.story_id} and merge its pull request; until then other computers see the story finished only through its shared claim`;
}
