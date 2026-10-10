// Commits that reached the base branch outside any delivery (pushed straight
// to main by a person, say) while a story was in progress. Picking them up
// would charge their files to the story, so git.commit and git.push stop.
// A person may accept one such commit for one story: its files then stay out
// of the story's perimeter, as for a merged delivery, and any of them inside
// the story's write scope or context still goes through story overlap confirm
// before the merge.
import { applyApprovalDelegation, delegatedRecordFields } from "./delegation.mjs";
import path from "node:path";
import {
  runsInsideAgentHost,
} from "../agent-host.mjs";
import {
  computeStableHash,
} from "../canonical.mjs";
import {
  fail,
} from "../cli/user-error.mjs";
import {
  getOptionString,
  normalizeId,
  requireCoordinationOverrideActor,
  requireOption,
} from "../lifecycle/common.mjs";
import {
  taskStartGitBase,
} from "../lifecycle/git-base.mjs";
import {
  fs,
} from "../runtime/host.mjs";
import {
  storyOriginalTaskStart,
} from "./authorization.mjs";
import {
  buildAttribution,
  now,
  uniqueRecordSuffix,
} from "./common.mjs";
import {
  execGit,
  gitCommandSucceeds,
} from "./git.mjs";
import {
  ensureInitialized,
} from "./migration.mjs";
import {
  output,
} from "./output.mjs";
import {
  acquireFileLock,
  readProjectJson,
  safeReadDir,
  writeJsonFile,
} from "./storage.mjs";
import {
  appendTraceEvent,
  readStory,
} from "./story.mjs";

export const STORY_BASE_ACKNOWLEDGEMENT_SCHEMA = "story-base-acknowledgement:v1";
const DIRECTORY = "base-acknowledgements";
const COMMIT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

function acknowledgementRoot(context, storyId) {
  return path.join(context.sdlcRoot, "stories", storyId, DIRECTORY);
}

/** The base commits a person accepted for one story, with their paths; unreadable or altered records count for nothing. */
export function readStoryBaseAcknowledgements(context, storyId) {
  const root = acknowledgementRoot(context, storyId);
  const records = [];
  for (const name of safeReadDir(root).sort()) {
    if (!name.endsWith(".json")) continue;
    try {
      const record = readProjectJson(context, path.join(root, name));
      const { record_hash: recordHash, ...content } = record;
      if (record.schema !== STORY_BASE_ACKNOWLEDGEMENT_SCHEMA || record.story_id !== storyId) continue;
      if (!COMMIT_ID.test(String(record.commit_sha || "")) || recordHash !== computeStableHash(content)) continue;
      records.push(record);
    } catch {
      // A record that cannot be read accepts nothing.
    }
  }
  return records;
}

/** Paths a single commit changed, compared with its first parent (or the empty tree for a root commit). */
export function commitChangedPaths(context, commitSha) {
  const listed = execGit(context.root, [
    "diff-tree", "--root", "--no-commit-id", "-r", "--no-renames", "--name-only", "--diff-merges=first-parent", commitSha, "--",
  ]);
  return listed === null ? [] : [...new Set(listed.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean))].sort();
}

function shellQuote(value) {
  return `"${String(value).replace(/["\\$`]/gu, "\\$&")}"`;
}

export function baseAcknowledgeCommand(storyId, commitSha) {
  return `agentic-sdlc story base acknowledge --id ${storyId} --commit ${commitSha.slice(0, 12)} --reason "<why this commit belongs on main>" --actor-type human`;
}

/**
 * story base acknowledge: a person accepts one commit that reached the base
 * branch outside any delivery after the story started. Refused inside an
 * agent's session and for agent actors; the commit must exist, come after the
 * story's task start, and not be one the story itself started from.
 */
export function acknowledgeStoryBaseCommit(context, options) {
  ensureInitialized(context);
  const id = normalizeId(requireOption(options, "id"));
  const commitInput = String(requireOption(options, "commit")).trim();
  const reason = getOptionString(options, "reason");
  if (!reason) fail("story base acknowledge requires --reason: why the commit belongs on the base branch.");
  if (!readStory(context, id)) fail(`Story ${id} does not exist.`);
  const delegated = applyApprovalDelegation(context, options, "base.acknowledge", { story: id });
  if (!delegated && runsInsideAgentHost()) {
    fail(
      `Accepting a commit on the base branch for story ${id} is a person's decision. `
      + `Ask them to run, in their own terminal: ${baseAcknowledgeCommand(id, commitInput)}`,
    );
  }
  const attribution = buildAttribution(context, options, "story.base.acknowledge");
  if (!delegated) requireCoordinationOverrideActor(attribution, `Accepting a base commit for story ${id}`);
  const commitSha = String(execGit(context.root, ["rev-parse", "--verify", "--quiet", `${commitInput}^{commit}`]) || "").toLowerCase();
  if (!COMMIT_ID.test(commitSha)) fail(`--commit must name a commit in this clone: ${commitInput}`);
  const original = storyOriginalTaskStart(context, id);
  if (original.invalid || !original.receipt) fail(`Story ${id} has no valid task start; there is no base to compare with.`);
  const startBase = taskStartGitBase(original.receipt);
  const baseSha = startBase.kind === "commit" ? String(startBase.sha).toLowerCase() : null;
  if (baseSha && gitCommandSucceeds(context.root, ["merge-base", "--is-ancestor", commitSha, baseSha])) {
    fail(`Commit ${commitSha.slice(0, 12)} is already part of what story ${id} started from; there is nothing to accept.`);
  }
  const releaseLock = acquireFileLock(path.join(context.sdlcRoot, "stories", id, "base-acknowledgement.lock"));
  try {
    const existing = readStoryBaseAcknowledgements(context, id).find((record) => record.commit_sha === commitSha);
    if (existing) {
      output(options, { status: "already_acknowledged", story_id: id, acknowledgement: existing }, [
        `Commit ${commitSha.slice(0, 12)} was already accepted for story ${id} (${existing.id}).`,
      ]);
      return;
    }
    const record = {
      schema: STORY_BASE_ACKNOWLEDGEMENT_SCHEMA,
      id: `BACK-${uniqueRecordSuffix()}`,
      story_id: id,
      commit_sha: commitSha,
      subject: execGit(context.root, ["log", "-1", "--format=%s", commitSha]) || "",
      paths: commitChangedPaths(context, commitSha),
      reason,
      acknowledged_by: attribution.actor,
      ...(delegated ? delegatedRecordFields(delegated) : {}),
      git: attribution.git,
      created_at: now(),
    };
    record.record_hash = computeStableHash(record);
    const root = acknowledgementRoot(context, id);
    fs.mkdirSync(root, { recursive: true });
    const recordPath = path.join(root, `${record.id}.json`);
    writeJsonFile(recordPath, record);
    appendTraceEvent(context, id, {
      type: "decision",
      action: "story.base.acknowledge",
      summary: `Accepted base commit ${commitSha.slice(0, 12)} for ${id}, outside its perimeter: ${reason}${delegated ? ` (${delegated.statement})` : ""}`,
      actor: attribution.actor,
      evidence: [path.relative(context.root, recordPath).split(path.sep).join("/")],
      related: [id],
      git: attribution.git,
      run: attribution.run,
    });
    output(options, { status: "acknowledged", story_id: id, acknowledgement_path: recordPath, acknowledgement: record }, [
      `Accepted commit ${commitSha.slice(0, 12)} for story ${id}: its ${record.paths.length} file(s) stay out of the story's perimeter.`,
      "Files it changed inside the story's write scope or context still need story overlap confirm before the merge.",
    ]);
  } finally {
    releaseLock();
  }
}

