import path from "node:path";
import {
  failWithCode,
} from "../cli/user-error.mjs";
import {
  createRecordsPullRequest,
} from "../delivery/providers/github-cli.mjs";
import {
  normalizeId,
  requireOption,
} from "../lifecycle/common.mjs";
import {
  humanGuidanceLocale,
} from "../lifecycle/guidance.mjs";
import {
  fs,
  os,
} from "../runtime/host.mjs";
import {
  orchestrationPolicy,
} from "../story-claim-shared-state.mjs";
import {
  storyBranchRecordPath,
} from "../story-records.mjs";
import {
  remoteBaseRef,
} from "./merge-drift.mjs";
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

const PUSH_TIMEOUT_SECONDS = 120;

function refuse(code, message) {
  failWithCode(code, message);
}

function gitLines(result) {
  return result.ok ? result.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean) : [];
}

/**
 * story publish-records: brings the records a story's work left on this
 * computer to the remote base branch without touching this checkout. It
 * builds one commit on top of the remote base branch with only the story's
 * records (and the shared records its work added) that the base branch does
 * not have, pushes it as its own branch, and opens a pull request when the
 * project names a provider (orchestration_policy.story_records). A record
 * the base branch also changed since this checkout's work started is left
 * out and listed: merging it is a person's decision.
 */
export function publishStoryRecords(context, options) {
  ensureInitialized(context);
  const storyId = normalizeId(requireOption(options, "id"));
  if (!fs.existsSync(path.join(context.sdlcRoot, "stories", storyId, "story.json"))) {
    refuse("STORY_NOT_FOUND", `Story ${storyId} does not exist.`);
  }
  const italian = humanGuidanceLocale(options) === "it";
  const policy = orchestrationPolicy(context.config);
  const recordsPolicy = policy.story_records;
  const remote = policy.coordination.remote;
  const timeoutSeconds = policy.coordination.timeout_seconds;
  const git = (args, extra = {}) => runGit(context.root, args, { timeoutSeconds, ...extra });
  const configuredBase = policy.merge_drift.base_branch;
  const fetched = git(["fetch", "--quiet", "--no-tags", remote, ...(configuredBase ? [configuredBase] : [])], { timeoutSeconds: PUSH_TIMEOUT_SECONDS });
  if (!fetched.ok) {
    refuse("STORY_RECORDS_REMOTE_UNAVAILABLE", `The records of story ${storyId} were not published: the git remote '${remote}' cannot be reached (${firstLine(fetched.stderr) || "git fetch failed"}).`);
  }
  const base = remoteBaseRef(context, remote, configuredBase, timeoutSeconds);
  if (!base) {
    refuse(
      "STORY_RECORDS_NO_BASE_BRANCH",
      `The records of story ${storyId} were not published: the base branch of '${remote}' is unknown. `
        + `Set orchestration_policy.merge_drift.base_branch, or run git remote set-head ${remote} --auto.`,
    );
  }
  const sdlcFolder = path.relative(context.root, context.sdlcRoot).replace(/\\/gu, "/") || ".sdlc";
  let storyIds = [];
  try {
    storyIds = fs.readdirSync(path.join(context.sdlcRoot, "stories"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    storyIds = [];
  }
  const recordOptions = { sdlcFolder, storyId, storyIds };
  // Records added or changed here compared with the base branch; nothing is ever deleted there.
  const candidates = [...new Set([
    ...gitLines(git(["diff", "--name-only", "--no-renames", "--diff-filter=AM", base.ref, "--", sdlcFolder])),
    ...gitLines(git(["ls-files", "--others", "--exclude-standard", "--", sdlcFolder])),
  ])].filter((filePath) => storyBranchRecordPath(filePath, recordOptions)).sort();
  const forkPoint = firstLine(git(["merge-base", "HEAD", base.ref]).stdout) || null;
  const publish = [];
  const skipped = [];
  for (const filePath of candidates) {
    const onBase = firstLine(git(["rev-parse", "--verify", "--quiet", `${base.ref}:${filePath}`]).stdout) || null;
    const atFork = forkPoint ? firstLine(git(["rev-parse", "--verify", "--quiet", `${forkPoint}:${filePath}`]).stdout) || null : null;
    // A record the base branch changed after this work started would be overwritten: a person merges it.
    if (onBase && onBase !== atFork) skipped.push(filePath);
    else publish.push(filePath);
  }
  const branch = `${recordsPolicy.publish_branch_prefix}${storyId}`;
  if (publish.length === 0) {
    output(options, { status: "nothing_to_publish", story_id: storyId, base_branch: base.branch, skipped }, [
      italian
        ? `${storyId}: ${remote}/${base.branch} ha già tutti i record di questa story presenti qui.`
        : `${storyId}: ${remote}/${base.branch} already has every record of this story found here.`,
      ...skippedLines(skipped, italian),
    ]);
    return;
  }
  // An earlier publication still waiting to be merged is continued, so its branch only moves forward.
  const existing = firstLine(git(["ls-remote", "--heads", remote, `refs/heads/${branch}`]).stdout).split(/\s+/u)[0] || null;
  let start = base.ref;
  if (existing) {
    const fetchedBranch = git(["fetch", "--quiet", "--no-tags", remote, `refs/heads/${branch}`], { timeoutSeconds: PUSH_TIMEOUT_SECONDS });
    if (fetchedBranch.ok) start = existing;
  }
  // A private index builds the commit: the checkout, its index, and its branches stay untouched.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-sdlc-records-"));
  const env = { GIT_INDEX_FILE: path.join(scratch, "index") };
  let commit;
  try {
    const step = (args, label) => {
      const result = git(args, { env });
      if (!result.ok) refuse("STORY_RECORDS_COMMIT_FAILED", `The records of story ${storyId} were not published: ${label} failed (${firstLine(result.stderr)}).`);
      return firstLine(result.stdout);
    };
    step(["read-tree", start], "reading the base branch");
    for (const filePath of publish) {
      const blob = step(["hash-object", "-w", "--", filePath], `storing ${filePath}`);
      step(["update-index", "--add", "--cacheinfo", `100644,${blob},${filePath}`], `adding ${filePath}`);
    }
    const tree = step(["write-tree"], "writing the tree");
    // Nothing new since the last publication: the branch stays where it is.
    commit = start !== base.ref && tree === firstLine(git(["rev-parse", `${start}^{tree}`]).stdout) ? start : step([
      "commit-tree", tree, "-p", start,
      "-m", `Records of story ${storyId}\n\nThe project records this story's work left outside its pull request.`,
    ], "creating the commit");
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  const pushed = git(["push", "--quiet", remote, `${commit}:refs/heads/${branch}`], { timeoutSeconds: PUSH_TIMEOUT_SECONDS });
  if (!pushed.ok) {
    refuse(
      "STORY_RECORDS_PUSH_REFUSED",
      `The records of story ${storyId} were not published: '${remote}' refused branch ${branch} (${firstLine(pushed.stderr) || "git push failed"}). `
        + `If an earlier ${branch} was merged or is obsolete, delete it on the remote and run this again.`,
    );
  }
  const pullRequest = recordsPolicy.publish_pull_request === "github-cli"
    ? createRecordsPullRequest({
        cwd: context.root,
        base: base.branch,
        head: branch,
        title: `Records of story ${storyId}`,
        body: `Project records of story ${storyId} that its pull request did not carry.\n\n${publish.map((item) => `- ${item}`).join("\n")}`,
      })
    : null;
  output(options, {
    status: "published",
    story_id: storyId,
    remote,
    base_branch: base.branch,
    branch,
    commit,
    published: publish,
    skipped,
    ...(pullRequest ? { pull_request: pullRequest } : {}),
  }, [
    italian
      ? `${storyId}: ${publish.length} record pubblicati su ${remote}, nel branch ${branch} (basato su ${base.branch}).`
      : `${storyId}: ${publish.length} records published to ${remote}, on branch ${branch} (based on ${base.branch}).`,
    pullRequest?.url
      ? (italian ? `Pull request aperta: ${pullRequest.url}` : `Pull request opened: ${pullRequest.url}`)
      : pullRequest?.error
        ? (italian ? `Pull request non aperta (${pullRequest.error}): aprila da ${branch} verso ${base.branch}.` : `Pull request not opened (${pullRequest.error}): open one from ${branch} into ${base.branch}.`)
        : (italian ? `Apri una pull request da ${branch} verso ${base.branch}; unita quella, ogni computer ha i record.` : `Open a pull request from ${branch} into ${base.branch}; once it is merged, every computer has the records.`),
    ...skippedLines(skipped, italian),
  ]);
}

function skippedLines(skipped, italian) {
  if (skipped.length === 0) return [];
  return [italian
    ? `Non pubblicati perché cambiati anche sul branch base (da unire a mano): ${skipped.join(", ")}`
    : `Not published because the base branch changed them too (merge them by hand): ${skipped.join(", ")}`];
}
