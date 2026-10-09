import path from "node:path";
import {
  validateAutonomyDecisionIntegrity,
} from "../autonomy-policy.mjs";
import {
  computeStableHash,
} from "../canonical.mjs";
import {
  UserError,
  fail,
} from "../cli/user-error.mjs";
import {
  buildPullRequestCommitLineage,
} from "../delivery/pull-request-lineage.mjs";
import {
  hashApprovalSubject,
} from "../lifecycle/authorization.mjs";
import {
  canonicalAbsoluteUrl,
  samePullRequestUrl,
  shortHashFull,
  stableJson,
  validateCommitCoverageProfileRef,
} from "../lifecycle/common.mjs";
import {
  GIT_COMMAND_MAX_OUTPUT_BYTES,
  SDLC_DIR,
  WORKFLOW_FINAL_GIT_OBSERVATION_SCHEMA,
  WORKFLOW_FINAL_GIT_SCOPE_MAX_COMMITS,
  WORKFLOW_FINAL_GIT_SCOPE_MAX_COMMIT_PATHS,
  WORKFLOW_FINAL_GIT_SCOPE_MAX_PATHS,
  WORKFLOW_FINAL_GIT_SCOPE_SCHEMA,
} from "../lifecycle/constants.mjs";
import {
  deliveryActionReceiptRef,
  deliveryAutonomyPath,
  deliveryStartReceiptRef,
  exactGitProjectPath,
  gitRuntimeWithoutHead,
  normalizeGitRepositoryIdentity,
} from "../lifecycle/delivery.mjs";
import {
  isGitObjectId,
  taskStartGitBase,
  unbornGitBase,
} from "../lifecycle/git-base.mjs";
import {
  labelForCommit,
} from "../lifecycle/guidance.mjs";
import {
  assertPathInsideRoot,
  isInsidePath,
  pathMatchesApprovedWriteScope,
  toProjectPath,
} from "../lifecycle/project.mjs";
import {
  workflowFinalGitArguments,
  workflowFinalGitLayerIdentityEqual,
  workflowFinalGitObjectIdentity,
  workflowFinalGitPathSuperseded,
  workflowFinalIgnoredCertifiedPaths,
  workflowFinalMissingGitIdentity,
  workflowFinalWorkingTreeIdentity,
} from "../lifecycle/workflow.mjs";
import {
  Date,
  childProcess,
  fs,
  process,
} from "../runtime/host.mjs";
import {
  cachedGitObjectAnswer,
} from "./git-object-cache.mjs";
import {
  readSnapshotActive,
  readSnapshotValue,
} from "./read-snapshot.mjs";
import {
  validateApprovalEvidenceIntegrity,
  validateAutonomyApprovalRef,
  validateFormalApprovalRecord,
} from "./authorization.mjs";
import {
  nearestExistingParent,
  now,
  validatePullRequestMergeRuntimeTransition,
} from "./common.mjs";
import {
  allDeliveryActionReceipts,
  currentDeliveryExecutionState,
  deliveryActionReceipts,
  effectiveDeliveryProfileStatus,
  readDeliveryAutonomyProfile,
  validateCompletedProviderActionReceipt,
  validateDeliveryActionCheckpointPolicySnapshot,
  validateDeliveryActionHostAuthority,
} from "./delivery.mjs";
import {
  output,
} from "./output.mjs";
import {
  pathEntryExistsNoFollow,
  resolveProjectFilePath,
} from "./project.mjs";
import {
  readProjectJson,
  stableWorkspacePathSnapshot,
} from "./storage.mjs";
import {
  readRequirementAutonomyProfile,
  requirementByAutonomyProfileId,
} from "./story.mjs";

export function workflowFinalGitEnvironment() {
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^GIT_/iu.test(key)) {
      environment[key] = value;
    }
  }
  return {
    ...environment,
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
}

/** The read-snapshot key of one hardened Git query. */
function workflowFinalGitQueryKey(kind, context, args) {
  return `workflow-final-git:${kind}:${JSON.stringify(workflowFinalGitArguments(context, args))}`;
}

export function workflowFinalGitNullRecords(context, args, label) {
  const decoded = readSnapshotValue(workflowFinalGitQueryKey("records", context, args), () => cachedGitObjectAnswer(context.root, "final-records", ["--no-replace-objects", ...args], () => {
    let raw;
    try {
      raw = childProcess.execFileSync(
        "git",
        workflowFinalGitArguments(context, args),
        {
          encoding: null,
          env: workflowFinalGitEnvironment(),
          windowsHide: true,
          maxBuffer: 64 * 1024 * 1024,
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
    } catch {
      fail(`Final lifecycle freshness could not inspect ${label}.`);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      fail(`Final lifecycle freshness cannot safely represent a non-UTF-8 path in ${label}.`);
    }
  }));
  return decoded.split("\u0000").filter((entry) => entry !== "");
}

export function workflowFinalExecGit(context, args) {
  return readSnapshotValue(
    workflowFinalGitQueryKey("output", context, args),
    () => cachedGitObjectAnswer(
      context.root,
      "final-output",
      ["--no-replace-objects", ...args],
      () => workflowFinalExecGitLive(context, args),
    ),
  );
}

function workflowFinalExecGitLive(context, args) {
  try {
    return childProcess.execFileSync(
      "git",
      workflowFinalGitArguments(context, args),
      {
        encoding: "utf8",
        env: workflowFinalGitEnvironment(),
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim() || null;
  } catch {
    return null;
  }
}

export function workflowFinalGitCommandSucceeds(context, args) {
  return readSnapshotValue(
    workflowFinalGitQueryKey("succeeds", context, args),
    () => cachedGitObjectAnswer(
      context.root,
      "final-succeeds",
      ["--no-replace-objects", ...args],
      () => workflowFinalGitCommandSucceedsLive(context, args),
    ),
  );
}

function workflowFinalGitCommandSucceedsLive(context, args) {
  try {
    childProcess.execFileSync(
      "git",
      workflowFinalGitArguments(context, args),
      {
        encoding: "utf8",
        env: workflowFinalGitEnvironment(),
        windowsHide: true,
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
    return true;
  } catch {
    return false;
  }
}

export function assertWorkflowFinalGitHasNoGrafts(context) {
  const rawGraftsPath = workflowFinalExecGit(
    context,
    ["rev-parse", "--git-path", "info/grafts"],
  );
  if (!rawGraftsPath) {
    fail("Final lifecycle freshness could not resolve the repository grafts path.");
  }
  const graftsPath = path.isAbsolute(rawGraftsPath)
    ? path.resolve(rawGraftsPath)
    : path.resolve(context.root, rawGraftsPath);
  let stat;
  try {
    stat = fs.lstatSync(graftsPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!stat.isFile() || stat.size > 0) {
    fail(
      "Final lifecycle freshness refuses Git grafts or a non-regular info/grafts path; "
      + "remove the local history override and reseal the lifecycle receipt.",
    );
  }
}

export function assertWorkflowFinalGitHistoryIsComplete(context) {
  assertWorkflowFinalGitHasNoGrafts(context);
  if (
    workflowFinalExecGit(context, ["rev-parse", "--is-shallow-repository"])
    !== "false"
  ) {
    fail(
      "Final lifecycle freshness requires complete Git history and refuses a shallow "
      + "repository; fetch or restore full ancestry, review it, and reseal the lifecycle receipt.",
    );
  }
}

// HEAD names a branch with no commit yet. Judged through the same hardened Git
// invocation as the rest of the final freshness capture.
export function workflowFinalGitHeadIsUnborn(context) {
  if (workflowFinalExecGit(context, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])) {
    return false;
  }
  const branchRef = workflowFinalExecGit(context, ["symbolic-ref", "--quiet", "HEAD"]);
  return Boolean(branchRef)
    && !workflowFinalExecGit(context, ["rev-parse", "--verify", "--quiet", branchRef]);
}

export function workflowFinalGitEmptyTreeId(context) {
  const treeId = workflowFinalExecGit(context, ["hash-object", "-t", "tree", "--stdin"]);
  return isGitObjectId(treeId) ? treeId : null;
}

export function workflowFinalGitIndexEntries(context, includePath = () => true) {
  const entries = new Map();
  for (const record of workflowFinalGitNullRecords(
    context,
    ["ls-files", "--stage", "-z", "--"],
    "the Git index",
  )) {
    const separator = record.indexOf("\t");
    if (separator < 0) {
      fail("Final lifecycle freshness received an unsupported Git index record.");
    }
    const header = record.slice(0, separator);
    const match = /^([0-7]{6}) ([a-f0-9]{40,64}) ([0-3])$/iu.exec(header);
    if (!match) {
      fail("Final lifecycle freshness received an unsupported Git index identity.");
    }
    const projectPath = exactGitProjectPath(record.slice(separator + 1));
    if (!includePath(projectPath)) continue;
    if (match[3] !== "0" || entries.has(projectPath)) {
      fail(
        `Final lifecycle freshness cannot certify an unmerged or duplicate Git index path: `
        + `${JSON.stringify(projectPath)}.`,
      );
    }
    entries.set(
      projectPath,
      workflowFinalGitObjectIdentity(match[1], match[2], `index path ${projectPath}`),
    );
  }
  return entries;
}

export function workflowFinalGitHeadEntries(context, includePath = () => true, treeish = "HEAD") {
  const entries = new Map();
  // An unborn HEAD has no tree: every path is absent from it.
  if (treeish === "HEAD" && workflowFinalGitHeadIsUnborn(context)) return entries;
  for (const record of workflowFinalGitNullRecords(
    context,
    ["ls-tree", "-r", "-z", treeish, "--"],
    `the Git tree of ${treeish}`,
  )) {
    const separator = record.indexOf("\t");
    if (separator < 0) {
      fail("Final lifecycle freshness received an unsupported Git tree record.");
    }
    const header = record.slice(0, separator);
    const match = /^([0-7]{6}) ([a-z]+) ([a-f0-9]{40,64})$/iu.exec(header);
    if (!match) {
      fail("Final lifecycle freshness received an unsupported Git tree identity.");
    }
    const projectPath = exactGitProjectPath(record.slice(separator + 1));
    if (!includePath(projectPath)) continue;
    if (match[2] !== "blob") {
      fail("Final lifecycle freshness cannot certify a non-blob Git tree entry.");
    }
    if (entries.has(projectPath)) {
      fail(`Final lifecycle freshness received duplicate HEAD path ${JSON.stringify(projectPath)}.`);
    }
    entries.set(
      projectPath,
      workflowFinalGitObjectIdentity(match[1], match[3], `HEAD path ${projectPath}`),
    );
  }
  return entries;
}

export function workflowFinalGitIndexFlags(context, includePath = () => true) {
  const flags = new Map();
  for (const record of workflowFinalGitNullRecords(
    context,
    ["ls-files", "-v", "-z", "--"],
    "Git index flags",
  )) {
    if (record.length < 3 || record[1] !== " ") {
      fail("Final lifecycle freshness received an unsupported Git index flag record.");
    }
    const tag = record[0];
    const projectPath = exactGitProjectPath(record.slice(2));
    if (!includePath(projectPath)) continue;
    flags.set(projectPath, {
      assume_unchanged: tag !== "?" && tag === tag.toLowerCase(),
      skip_worktree: tag.toUpperCase() === "S",
    });
  }
  return flags;
}

export function workflowFinalGitPathSet(context, args, label) {
  return new Set(
    workflowFinalGitNullRecords(context, args, label)
      .map((projectPath) => exactGitProjectPath(projectPath)),
  );
}

// `boundarySha` null is the empty tree an unborn certification started from:
// every commit reachable from the observed head came after it.
export function workflowFinalGitCommitGraphSince(context, boundarySha, observedHeadSha) {
  if (boundarySha === observedHeadSha) return [];
  if (!observedHeadSha) {
    fail("Final lifecycle freshness could not inspect the post-certification commit graph.");
  }
  const graphArgs = [
    "rev-list",
    "--reverse",
    "--topo-order",
    "--parents",
    boundarySha ? `${boundarySha}..${observedHeadSha}` : observedHeadSha,
  ];
  const raw = readSnapshotValue(workflowFinalGitQueryKey("graph", context, graphArgs), () => cachedGitObjectAnswer(context.root, "final-graph", ["--no-replace-objects", ...graphArgs], () => {
    try {
      return childProcess.execFileSync(
        "git",
        workflowFinalGitArguments(context, graphArgs),
        {
          encoding: "utf8",
          env: workflowFinalGitEnvironment(),
          windowsHide: true,
          maxBuffer: GIT_COMMAND_MAX_OUTPUT_BYTES,
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
    } catch {
      // An unreadable graph must not pass as "no commits since certification".
      fail("Final lifecycle freshness could not inspect the post-certification commit graph.");
    }
  }));
  const commits = raw
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((line) => {
      const [commitSha, ...parentShas] = line.split(/\s+/u);
      if (
        !/^[a-f0-9]{40,64}$/iu.test(commitSha)
        || parentShas.some((value) => !/^[a-f0-9]{40,64}$/iu.test(value))
      ) {
        fail("Final lifecycle freshness received an invalid post-certification commit graph.");
      }
      return {
        commit_sha: commitSha.toLowerCase(),
        parent_shas: parentShas.map((value) => value.toLowerCase()),
      };
    });
  if (commits.length > WORKFLOW_FINAL_GIT_SCOPE_MAX_COMMITS) {
    fail(
      `Final lifecycle freshness refuses more than ${WORKFLOW_FINAL_GIT_SCOPE_MAX_COMMITS} `
      + "post-certification commits; reseal the lifecycle receipt.",
    );
  }
  return commits;
}

export function workflowFinalGitCommitsSince(context, boundarySha, observedHeadSha) {
  return workflowFinalGitCommitGraphSince(
    context,
    boundarySha,
    observedHeadSha,
  ).map((entry) => entry.commit_sha);
}

export function workflowFinalGitTreeIdentities(context, treeish, projectPaths) {
  const paths = [...new Set(projectPaths.map((value) => exactGitProjectPath(value)))].sort();
  const identities = new Map(
    paths.map((projectPath) => [projectPath, workflowFinalMissingGitIdentity()]),
  );
  const chunkSize = 256;
  for (let offset = 0; offset < paths.length; offset += chunkSize) {
    const chunk = paths.slice(offset, offset + chunkSize);
    const requested = new Set(chunk);
    for (const record of workflowFinalGitNullRecords(
      context,
      ["ls-tree", "-z", treeish, "--", ...chunk],
      `the Git tree for commit ${treeish}`,
    )) {
      const separator = record.indexOf("\t");
      if (separator < 0) {
        fail("Final lifecycle freshness received an unsupported historical Git tree record.");
      }
      const header = record.slice(0, separator);
      const match = /^([0-7]{6}) ([a-z]+) ([a-f0-9]{40,64})$/iu.exec(header);
      const projectPath = exactGitProjectPath(record.slice(separator + 1));
      if (
        !match
        || match[2] !== "blob"
        || !requested.has(projectPath)
        || identities.get(projectPath)?.present === true
      ) {
        fail(
          "Final lifecycle freshness received an unsupported or duplicate historical "
          + `Git tree identity for ${JSON.stringify(projectPath)}.`,
        );
      }
      identities.set(
        projectPath,
        workflowFinalGitObjectIdentity(
          match[1],
          match[3],
          `historical path ${projectPath}`,
        ),
      );
    }
  }
  return identities;
}

// Every path any commit after the boundary touched, against each of its
// parents (a root commit against the empty tree), read with one `git log`
// instead of one `diff-tree` per commit.
export function workflowFinalGitTouchedPathsSince(context, boundarySha, observedHeadSha) {
  const commits = workflowFinalGitCommitsSince(context, boundarySha, observedHeadSha);
  const touched = new Set();
  if (commits.length === 0) return touched;
  for (const projectPath of workflowFinalGitNullRecords(
    context,
    [
      "-c", "log.showRoot=true",
      "-c", "log.diffMerges=separate",
      "log",
      "-m",
      "--format=",
      "--name-only",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "-z",
      boundarySha ? `${boundarySha}..${observedHeadSha}` : observedHeadSha,
      "--",
    ],
    "paths touched by commits after certification",
  )) {
    touched.add(exactGitProjectPath(projectPath));
  }
  return touched;
}

export const WORKFLOW_FINAL_MERGE_COMMIT_ANCHOR = "merge_commit";

function failWorkflowFinalGitHistory(code, message) {
  const error = new UserError(message);
  error.code = code;
  throw error;
}

/**
 * A commit a certification depends on must exist in this clone
 * (certified_commit_missing) and be an ancestor of HEAD
 * (certified_history_rewritten).
 */
function assertWorkflowFinalCertifiedCommit(context, commitSha, observedHeadSha, label) {
  if (!workflowFinalGitCommandSucceeds(context, ["cat-file", "-e", `${commitSha}^{commit}`])) {
    failWorkflowFinalGitHistory(
      "certified_commit_missing",
      `Final lifecycle freshness cannot find ${label} (${commitSha.slice(0, 12)}) in this clone; fetch the base branch.`,
    );
  }
  if (!workflowFinalGitCommandSucceeds(context, ["merge-base", "--is-ancestor", commitSha, observedHeadSha])) {
    failWorkflowFinalGitHistory(
      "certified_history_rewritten",
      `Final lifecycle freshness found ${label} (${commitSha.slice(0, 12)}) outside the history of HEAD; `
      + "the history was rewritten after certification.",
    );
  }
}

/**
 * The story's files as its merge commit holds them. A certification anchored
 * to the merge commit binds the merged content, never the working tree, the
 * index, or later commits on the base branch, which belong to other work.
 */
function captureWorkflowFinalAnchoredGitScope(context, {
  requirementProfiles,
  certifiedPaths,
  anchorSha,
  observedHeadSha,
  baselineSha,
  baselineTree,
}) {
  if (!/^[a-f0-9]{40,64}$/iu.test(String(anchorSha)) || !observedHeadSha) {
    fail("Final lifecycle freshness cannot bind the story to its merge commit.");
  }
  assertWorkflowFinalCertifiedCommit(context, anchorSha, observedHeadSha, "the story's merge commit");
  const approvedWritePaths = [...new Set(requirementProfiles.flatMap(
    (profile) => profile.constraints?.allowed_write_paths || [],
  ))].sort();
  const includedGitPath = (filePath) =>
    filePath !== SDLC_DIR
    && !filePath.startsWith(`${SDLC_DIR}/`)
    && approvedWritePaths.length > 0
    && pathMatchesApprovedWriteScope(filePath, approvedWritePaths);
  const anchorEntries = workflowFinalGitHeadEntries(context, includedGitPath, anchorSha);
  const baselineChangedPaths = workflowFinalGitPathSet(
    context,
    ["diff", "--name-only", "--no-renames", "-z", `${baselineSha || baselineTree}..${anchorSha}`, "--"],
    "paths changed between the task start and the merge commit",
  );
  const scopedPaths = [...new Set([
    ...anchorEntries.keys(),
    ...baselineChangedPaths,
    ...certifiedPaths.map((value) => exactGitProjectPath(value)),
  ])]
    .filter((filePath) => includedGitPath(filePath))
    .sort();
  if (scopedPaths.length > WORKFLOW_FINAL_GIT_SCOPE_MAX_PATHS) {
    fail(
      `Final lifecycle freshness scope exceeds ${WORKFLOW_FINAL_GIT_SCOPE_MAX_PATHS} Git paths.`,
    );
  }
  const scopedChanges = scopedPaths.map((filePath) => {
    const identity = anchorEntries.get(filePath) || workflowFinalMissingGitIdentity();
    return {
      path: filePath,
      working_tree: identity,
      index: identity,
      head: identity,
      index_matches_worktree: true,
      index_matches_head: true,
      index_flags: { assume_unchanged: false, skip_worktree: false },
    };
  });
  return {
    schema_version: WORKFLOW_FINAL_GIT_OBSERVATION_SCHEMA,
    available: true,
    baseline_head_sha: baselineSha,
    ...(baselineTree ? { baseline_tree: baselineTree } : {}),
    observed_head_sha: anchorSha,
    anchor: { kind: WORKFLOW_FINAL_MERGE_COMMIT_ANCHOR, sha: anchorSha },
    scoped_state_hash: computeStableHash(scopedChanges),
    scoped_head_tree_hash: computeStableHash(
      scopedChanges.map((entry) => ({
        path: entry.path,
        head: entry.head,
      })),
    ),
    scoped_changes: scopedChanges,
    history_touched_paths: [],
  };
}

export function captureWorkflowFinalFreshnessGitScopeOnce(
  context,
  storyId,
  requirementProfiles,
  {
    certifiedPaths = [],
    historyBoundarySha = null,
    historyBoundaryUnborn = false,
    anchorSha = null,
    excludeIgnored = false,
  } = {},
) {
  if (workflowFinalExecGit(context, ["rev-parse", "--is-inside-work-tree"]) !== "true") {
    return {
      schema_version: WORKFLOW_FINAL_GIT_OBSERVATION_SCHEMA,
      available: false,
      baseline_head_sha: null,
      observed_head_sha: null,
      scoped_state_hash: null,
      scoped_head_tree_hash: null,
      scoped_changes: [],
      history_touched_paths: [],
    };
  }
  assertWorkflowFinalGitHistoryIsComplete(context);
  // An unborn HEAD is a verifiable state of its own: there is no commit yet,
  // so the observation names no head and every path is absent from HEAD.
  const headUnborn = workflowFinalGitHeadIsUnborn(context);
  const observedHeadSha = headUnborn
    ? null
    : workflowFinalExecGit(context, ["rev-parse", "--verify", "HEAD"]);
  if (!headUnborn && (!observedHeadSha || !/^[a-f0-9]{40,64}$/iu.test(observedHeadSha))) {
    fail("Final lifecycle freshness requires a verifiable Git HEAD.");
  }
  const taskStartPath = path.join(
    context.sdlcRoot,
    "stories",
    storyId,
    "task-start.json",
  );
  const taskStart = fs.existsSync(taskStartPath)
    ? readProjectJson(context, taskStartPath)
    : null;
  // The baseline is the commit the task start recorded, or the empty tree when
  // the delivery started before the repository's first commit.
  const startBase = taskStartGitBase(taskStart);
  const baselineSha = startBase.kind === "commit" ? startBase.sha : null;
  const baselineTree = startBase.kind === "unborn" ? startBase.tree : null;
  if (
    startBase.kind === "none"
    || (baselineTree !== null && baselineTree !== workflowFinalGitEmptyTreeId(context))
    || (baselineSha !== null && (headUnborn || !/^[a-f0-9]{40,64}$/iu.test(baselineSha)))
  ) {
    fail("Final lifecycle freshness cannot bind the current HEAD to the task-start Git baseline.");
  }
  if (baselineSha !== null) {
    assertWorkflowFinalCertifiedCommit(
      context,
      baselineSha,
      observedHeadSha,
      "the task-start Git baseline",
    );
  }
  if (historyBoundarySha) {
    if (headUnborn || !/^[a-f0-9]{40,64}$/iu.test(historyBoundarySha)) {
      fail(
        "Final lifecycle freshness observed a rewritten or non-descendant HEAD after certification; "
        + "reseal the lifecycle receipt.",
      );
    }
    assertWorkflowFinalCertifiedCommit(
      context,
      historyBoundarySha,
      observedHeadSha,
      "the commit this story was certified on",
    );
  }
  if (anchorSha) {
    return captureWorkflowFinalAnchoredGitScope(context, {
      requirementProfiles,
      certifiedPaths,
      anchorSha,
      observedHeadSha,
      baselineSha,
      baselineTree,
    });
  }
  const approvedWritePaths = [...new Set(requirementProfiles.flatMap(
    (profile) => profile.constraints?.allowed_write_paths || [],
  ))].sort();
  const allowedByStoryRequirements = (filePath) =>
    approvedWritePaths.length > 0
    && pathMatchesApprovedWriteScope(filePath, approvedWritePaths);
  const includedGitPath = (filePath) =>
    filePath !== SDLC_DIR
    && !filePath.startsWith(`${SDLC_DIR}/`)
    && allowedByStoryRequirements(filePath);
  const headEntries = workflowFinalGitHeadEntries(context, includedGitPath);
  const indexEntries = workflowFinalGitIndexEntries(context, includedGitPath);
  const indexFlags = workflowFinalGitIndexFlags(context, includedGitPath);
  const scopePathspecs = approvedWritePaths.map((projectPath) => `:(literal)${projectPath}`);
  // Files Git ignores (any .gitignore, .git/info/exclude, core.excludesFile)
  // are not project files: they are neither listed nor read, unless
  // certification_drift.ignored_files is include.
  const untrackedPaths = approvedWritePaths.length > 0
    ? workflowFinalGitPathSet(
        context,
        [
          "ls-files",
          "--others",
          ...(excludeIgnored ? ["--exclude-standard"] : []),
          "-z",
          "--",
          ...scopePathspecs,
        ],
        excludeIgnored
          ? "in-scope untracked paths Git does not ignore"
          : "all in-scope untracked paths, including ignored paths",
      )
    : new Set();
  // Ignored untracked paths and directories, listed without descending into
  // them, so an earlier certification that still names such files can set
  // them aside without reading them.
  const ignoredEntries = excludeIgnored && approvedWritePaths.length > 0
    ? workflowFinalGitNullRecords(
        context,
        [
          "ls-files",
          "--others",
          "--ignored",
          "--exclude-standard",
          "--directory",
          "-z",
          "--",
          ...scopePathspecs,
        ],
        "in-scope paths Git ignores",
      )
    : [];
  const gitIgnoresPath = (filePath) => ignoredEntries.some((entry) =>
    entry.endsWith("/") ? filePath.startsWith(entry) : filePath === entry);
  const baselineChangedPaths = headUnborn
    ? new Set()
    : workflowFinalGitPathSet(
      context,
      [
        "diff", "--name-only", "--no-renames", "-z",
        `${baselineSha || baselineTree}..${observedHeadSha}`, "--",
      ],
      "paths changed since task start",
    );
  const indexWorktreeDifferences = workflowFinalGitPathSet(
    context,
    [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--ignore-submodules=none",
      "--name-only",
      "--no-renames",
      "-z",
      "--",
    ],
    "working-tree differences from the Git index",
  );
  // An unborn certification has no boundary commit: every commit that exists
  // now came after it.
  const historyTouchedPaths = (historyBoundarySha || (historyBoundaryUnborn && !headUnborn))
    ? workflowFinalGitTouchedPathsSince(context, historyBoundarySha || null, observedHeadSha)
    : new Set();
  // A path only an earlier certification names, which Git now ignores and
  // neither tracks nor ever committed since the task start, is set aside.
  const ignoredCertifiedPaths = [];
  const certifiedScopePaths = certifiedPaths
    .map((value) => exactGitProjectPath(value))
    .filter((filePath) => {
      if (
        ignoredEntries.length === 0
        || headEntries.has(filePath)
        || indexEntries.has(filePath)
        || indexFlags.has(filePath)
        || baselineChangedPaths.has(filePath)
        || historyTouchedPaths.has(filePath)
        || !gitIgnoresPath(filePath)
      ) {
        return true;
      }
      ignoredCertifiedPaths.push(filePath);
      return false;
    });
  const scopedPaths = [...new Set([
    ...headEntries.keys(),
    ...indexEntries.keys(),
    ...indexFlags.keys(),
    ...untrackedPaths,
    ...baselineChangedPaths,
    ...historyTouchedPaths,
    ...certifiedScopePaths,
  ])]
    .filter((filePath) => includedGitPath(filePath))
    .sort();
  if (scopedPaths.length > WORKFLOW_FINAL_GIT_SCOPE_MAX_PATHS) {
    fail(
      `Final lifecycle freshness scope exceeds ${WORKFLOW_FINAL_GIT_SCOPE_MAX_PATHS} Git paths.`,
    );
  }
  const scopedChanges = scopedPaths.map((filePath) => {
    const flags = indexFlags.get(filePath) || {
      assume_unchanged: false,
      skip_worktree: false,
    };
    if (flags.assume_unchanged || flags.skip_worktree) {
      fail(
        `Final lifecycle freshness refuses hidden Git index flags for in-scope path `
        + `${JSON.stringify(filePath)} (assume-unchanged=${flags.assume_unchanged}, `
        + `skip-worktree=${flags.skip_worktree}).`,
      );
    }
    const workingTree = workflowFinalWorkingTreeIdentity(
      readSnapshotValue(
        `workspace-path:${JSON.stringify([context.root, filePath])}`,
        () => Object.freeze(stableWorkspacePathSnapshot(context, { path: filePath, status: "  " })),
      ),
    );
    const index = indexEntries.get(filePath) || workflowFinalMissingGitIdentity();
    const head = headEntries.get(filePath) || workflowFinalMissingGitIdentity();
    const indexWorktreeStructureMatches = (
      index.present === workingTree.present
      && (
        !index.present
        || (
          index.file_type === workingTree.file_type
          && (
            index.file_type !== "regular"
            || (index.mode & 0o111) === (workingTree.mode & 0o111)
          )
        )
      )
    );
    const indexMatchesWorktree = (
      indexWorktreeStructureMatches
      && !indexWorktreeDifferences.has(filePath)
    );
    const indexMatchesHead = workflowFinalGitLayerIdentityEqual(index, head);
    if (!indexMatchesHead && !indexMatchesWorktree) {
      fail(
        `Final lifecycle freshness refuses partially staged three-way identity for `
        + `${JSON.stringify(filePath)}; restore the certified index or stage the exact working tree.`,
      );
    }
    return {
      path: filePath,
      working_tree: workingTree,
      index,
      head,
      index_matches_worktree: indexMatchesWorktree,
      index_matches_head: indexMatchesHead,
      index_flags: flags,
    };
  });
  const scopedHistoryTouchedPaths = [...historyTouchedPaths]
    .filter((filePath) => scopedPaths.includes(filePath))
    .sort();
  return {
    schema_version: WORKFLOW_FINAL_GIT_OBSERVATION_SCHEMA,
    available: true,
    baseline_head_sha: baselineSha,
    ...(baselineTree ? { baseline_tree: baselineTree } : {}),
    observed_head_sha: observedHeadSha,
    scoped_state_hash: computeStableHash(scopedChanges),
    scoped_head_tree_hash: computeStableHash(
      scopedChanges.map((entry) => ({
        path: entry.path,
        head: entry.head,
      })),
    ),
    scoped_changes: scopedChanges,
    history_touched_paths: scopedHistoryTouchedPaths,
    ...(ignoredCertifiedPaths.length > 0
      ? { ignored_certified_paths: [...new Set(ignoredCertifiedPaths)].sort() }
      : {}),
  };
}

export function captureWorkflowFinalFreshnessGitScope(
  context,
  storyId,
  requirementProfiles,
  options = {},
) {
  const first = captureWorkflowFinalFreshnessGitScopeOnce(
    context,
    storyId,
    requirementProfiles,
    options,
  );
  const second = captureWorkflowFinalFreshnessGitScopeOnce(
    context,
    storyId,
    requirementProfiles,
    options,
  );
  if (stableJson(first) !== stableJson(second)) {
    fail(
      "Final lifecycle Git scope changed while being snapshotted; "
      + "retry after filesystem and Git activity settles.",
    );
  }
  return second;
}

export function workflowFinalGitHistoryMatchesCertifiedTransition(
  context,
  certificationHeadSha,
  observedHeadSha,
  certifiedByPath,
  observedByPath,
  touchedPaths,
) {
  assertWorkflowFinalGitHistoryIsComplete(context);
  const governedTouchedPaths = [...touchedPaths].sort();
  if (
    governedTouchedPaths.some((filePath) =>
      !certifiedByPath.has(filePath) || !observedByPath.has(filePath))
  ) {
    return false;
  }
  if (governedTouchedPaths.length === 0) return true;
  const commitGraph = workflowFinalGitCommitGraphSince(
    context,
    certificationHeadSha,
    observedHeadSha,
  );
  if (
    commitGraph.length * governedTouchedPaths.length
    > WORKFLOW_FINAL_GIT_SCOPE_MAX_COMMIT_PATHS
  ) {
    fail(
      "Final lifecycle freshness refuses an oversized post-certification "
      + "commit/path history; reseal the lifecycle receipt.",
    );
  }
  const identitiesByCommit = new Map();
  for (const entry of commitGraph) {
    identitiesByCommit.set(
      entry.commit_sha,
      workflowFinalGitTreeIdentities(
        context,
        entry.commit_sha,
        governedTouchedPaths,
      ),
    );
  }
  for (const filePath of governedTouchedPaths) {
    const certifiedIdentity = certifiedByPath.get(filePath).head;
    const materializedIdentity = observedByPath.get(filePath).head;
    const transitionChangesIdentity = !workflowFinalGitLayerIdentityEqual(
      certifiedIdentity,
      materializedIdentity,
    );
    for (const entry of commitGraph) {
      const commitIdentity = identitiesByCommit.get(entry.commit_sha).get(filePath);
      if (
        !workflowFinalGitLayerIdentityEqual(commitIdentity, certifiedIdentity)
        && !workflowFinalGitLayerIdentityEqual(commitIdentity, materializedIdentity)
      ) {
        return false;
      }
      for (const parentSha of entry.parent_shas) {
        let parentIdentity;
        if (parentSha === certificationHeadSha) {
          parentIdentity = certifiedIdentity;
        } else {
          parentIdentity = identitiesByCommit.get(parentSha)?.get(filePath);
        }
        if (
          parentIdentity
          && transitionChangesIdentity
          && workflowFinalGitLayerIdentityEqual(parentIdentity, materializedIdentity)
          && workflowFinalGitLayerIdentityEqual(commitIdentity, certifiedIdentity)
        ) {
          return false;
        }
      }
    }
  }
  assertWorkflowFinalGitHistoryIsComplete(context);
  return true;
}

// A scope anchored to the story's merge commit binds what that commit holds:
// the commit must still be in the history of HEAD and hold the certified
// content. The index, the working tree, and untracked files are other work.
function workflowFinalAnchoredGitScopeMatches(context, certified, observed) {
  const anchorSha = certified.anchor?.sha;
  if (
    certified.anchor?.kind !== WORKFLOW_FINAL_MERGE_COMMIT_ANCHOR
    || !/^[a-f0-9]{40,64}$/iu.test(String(anchorSha || ""))
    || certified.available !== true
    || certified.certification_head_sha !== anchorSha
    || observed.anchor?.kind !== WORKFLOW_FINAL_MERGE_COMMIT_ANCHOR
    || observed.anchor?.sha !== anchorSha
    || certified.scoped_state_hash !== computeStableHash(certified.scoped_changes)
    || certified.scoped_head_tree_hash !== computeStableHash(
      certified.scoped_changes.map((entry) => ({
        path: entry.path,
        head: entry.head,
      })),
    )
    || !workflowFinalGitCommandSucceeds(context, ["cat-file", "-e", `${anchorSha}^{commit}`])
    || !workflowFinalGitCommandSucceeds(context, ["merge-base", "--is-ancestor", anchorSha, "HEAD"])
  ) {
    return false;
  }
  const anchoredByPath = new Map(
    observed.scoped_changes.map((entry) => [entry.path, entry.head]),
  );
  return certified.scoped_changes.every((entry) =>
    anchoredByPath.has(entry.path)
    && workflowFinalGitLayerIdentityEqual(entry.head, anchoredByPath.get(entry.path)));
}

export function workflowFinalFreshnessGitScopeMatches(
  context,
  certified,
  observed,
  { supersededPaths = null } = {},
) {
  if (
    certified?.schema_version !== WORKFLOW_FINAL_GIT_SCOPE_SCHEMA
    || observed?.schema_version !== WORKFLOW_FINAL_GIT_OBSERVATION_SCHEMA
    || certified.available !== observed.available
    || certified.baseline_head_sha !== observed.baseline_head_sha
    || (certified.baseline_tree ?? null) !== (observed.baseline_tree ?? null)
  ) {
    return false;
  }
  if (certified.anchor !== undefined) {
    return workflowFinalAnchoredGitScopeMatches(context, certified, observed);
  }
  if (!certified.available) {
    return (
      certified.certification_head_sha === null
      && observed.observed_head_sha === null
      && certified.scoped_changes.length === 0
      && observed.scoped_changes.length === 0
    );
  }
  // A certification sealed on an unborn HEAD names no commit: it started from
  // the empty tree, so any later head descends from it, and a head that is
  // still unborn has not moved.
  const certifiedOnUnbornHead = certified.certification_head_sha === null
    && typeof certified.baseline_tree === "string";
  if (
    (certifiedOnUnbornHead
      ? false
      : (
        !certified.certification_head_sha
        || !observed.observed_head_sha
        || !workflowFinalGitCommandSucceeds(
          context,
          [
            "merge-base",
            "--is-ancestor",
            certified.certification_head_sha,
            observed.observed_head_sha,
          ],
        )
      ))
    || certified.scoped_state_hash !== computeStableHash(certified.scoped_changes)
    || certified.scoped_head_tree_hash !== computeStableHash(
      certified.scoped_changes.map((entry) => ({
        path: entry.path,
        head: entry.head,
      })),
    )
  ) {
    return false;
  }
  const certifiedByPath = new Map(
    certified.scoped_changes.map((entry) => [entry.path, entry]),
  );
  const observedByPath = new Map(
    observed.scoped_changes.map((entry) => [entry.path, entry]),
  );
  if (
    certifiedByPath.size !== certified.scoped_changes.length
    || observedByPath.size !== observed.scoped_changes.length
  ) {
    return false;
  }
  const supersededByPath = new Set(
    [...observedByPath].filter(([filePath, observedEntry]) =>
      workflowFinalGitPathSuperseded(supersededPaths, filePath, observedEntry))
      .map(([filePath]) => filePath),
  );
  for (const filePath of supersededByPath) {
    certifiedByPath.delete(filePath);
    observedByPath.delete(filePath);
  }
  // Files an earlier certification read before Git ignored them: certified
  // as untracked, now ignored and still untracked, so not project files.
  for (const filePath of workflowFinalIgnoredCertifiedPaths(certified, observed)) {
    certifiedByPath.delete(filePath);
  }
  if (certifiedByPath.size !== observedByPath.size) {
    return false;
  }
  const touchedPaths = new Set(
    (observed.history_touched_paths || [])
      .filter((filePath) => !supersededByPath.has(filePath)),
  );
  for (const [filePath, certifiedEntry] of certifiedByPath) {
    const observedEntry = observedByPath.get(filePath);
    if (
      !observedEntry
      || !workflowFinalGitLayerIdentityEqual(
        certifiedEntry.working_tree,
        observedEntry.working_tree,
      )
      || observedEntry.index_flags?.assume_unchanged === true
      || observedEntry.index_flags?.skip_worktree === true
    ) {
      return false;
    }
    const indexStayedCertified = workflowFinalGitLayerIdentityEqual(
      certifiedEntry.index,
      observedEntry.index,
    );
    if (!indexStayedCertified && observedEntry.index_matches_worktree !== true) {
      return false;
    }
    if (touchedPaths.has(filePath)) {
      if (
        observedEntry.index_matches_worktree !== true
        || !workflowFinalGitLayerIdentityEqual(observedEntry.head, observedEntry.index)
      ) {
        return false;
      }
    } else if (!workflowFinalGitLayerIdentityEqual(
      certifiedEntry.head,
      observedEntry.head,
    )) {
      return false;
    }
  }
  return workflowFinalGitHistoryMatchesCertifiedTransition(
    context,
    certified.certification_head_sha,
    observed.observed_head_sha,
    certifiedByPath,
    observedByPath,
    touchedPaths,
  );
}

export function readExactGitWorkspaceStatus(context) {
  let raw;
  try {
    raw = childProcess.execFileSync(
      "git",
      [
        "-C",
        context.root,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--ignore-submodules=none",
        "--no-renames",
        "-z",
      ],
      {
        encoding: null,
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
  } catch {
    fail("Execution context preflight could not inspect the current Git workspace.");
  }
  let decoded;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    fail("Execution context preflight cannot safely represent a non-UTF-8 Git path.");
  }
  return decoded.split("\u0000").filter(Boolean).map((entry) => {
    if (entry.length < 4 || entry[2] !== " ") {
      fail("Execution context preflight received an unsupported Git porcelain record.");
    }
    const status = entry.slice(0, 2);
    const projectPath = exactGitProjectPath(entry.slice(3));
    return { path: projectPath, status };
  }).filter((entry) => (
    entry.path !== SDLC_DIR && !entry.path.startsWith(`${SDLC_DIR}/`)
  )).sort((left, right) => (
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  ));
}

export function resolveExactGitWorkspacePath(context, projectPath) {
  const normalized = exactGitProjectPath(projectPath);
  const filePath = path.resolve(context.root, ...normalized.split("/"));
  assertPathInsideRoot(context, filePath, normalized);
  const existingParent = pathEntryExistsNoFollow(filePath)
    ? path.dirname(filePath)
    : nearestExistingParent(filePath);
  const realRoot = fs.realpathSync.native(context.root);
  const realParent = fs.realpathSync.native(existingParent);
  if (!isInsidePath(realRoot, realParent)) {
    fail(`Git workspace path parent resolves outside the project: ${JSON.stringify(normalized)}`);
  }
  return filePath;
}

export function reviewedPullRequestHeadSha(context, headBranch, explicitSha) {
  if (explicitSha && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(explicitSha)) {
    fail("--pr-head-sha must be a full lowercase Git commit SHA.");
  }
  const revision = explicitSha || `refs/heads/${headBranch}`;
  const resolved = execGit(context.root, [
    "rev-parse",
    "--verify",
    "--quiet",
    "--end-of-options",
    `${revision}^{commit}`,
  ]);
  if (explicitSha && !resolved) {
    fail("--pr-head-sha must identify a commit available in the local Git repository.");
  }
  return resolved ? resolved.toLowerCase() : null;
}

export function buildCompletedGitCommitDetails(context, authorization, runtimeTarget) {
  const beforeSha = authorization.runtime_target?.head_sha;
  const afterSha = runtimeTarget?.head_sha;
  if (!beforeSha || !afterSha || beforeSha === afterSha) {
    fail("git.commit completion requires exactly one new commit after its authorization checkpoint.");
  }
  if (stableJson(gitRuntimeWithoutHead(authorization.runtime_target)) !== stableJson(gitRuntimeWithoutHead(runtimeTarget))) {
    fail("git.commit runtime boundary changed outside the authorized HEAD transition.");
  }
  const parentLine = execGit(context.root, ["rev-list", "--parents", "-n", "1", afterSha]);
  const commitAndParents = String(parentLine || "").split(/\s+/u).filter(Boolean);
  if (commitAndParents.length !== 2 || commitAndParents[0] !== afterSha || commitAndParents[1] !== beforeSha) {
    fail("git.commit completion must be one non-merge commit whose exact parent is the authorized source SHA.");
  }
  const committedPaths = [...new Set(String(
    execGit(context.root, ["diff", "--name-only", "--no-renames", beforeSha, afterSha]) || "",
  ).split(/\r?\n/u).map((item) => item.trim()).filter(Boolean))].sort();
  const authorizedPaths = [...(authorization.action_details?.changed_paths || [])].sort();
  if (committedPaths.length === 0 || stableJson(committedPaths) !== stableJson(authorizedPaths)) {
    fail("git.commit completion file set differs from the exact authorized --scope-path set.");
  }
  const commitSnapshot = authorization.action_details?.commit_snapshot;
  const requiresCommitSnapshot = Boolean(authorization.action_details?.checkpoint_policy?.policy_source_ref);
  if (requiresCommitSnapshot && !commitSnapshot) {
    fail("git.commit authorization is missing its required staged index snapshot.");
  }
  if (commitSnapshot) {
    const committedTreeOid = String(
      execGit(context.root, ["rev-parse", `${afterSha}^{tree}`]) || "",
    ).trim();
    const objectFormat = String(execGit(context.root, ["rev-parse", "--show-object-format"]) || "").trim();
    if (
      commitSnapshot.schema_version !== "git-commit-index-snapshot:v1"
      || commitSnapshot.object_format !== objectFormat
      || commitSnapshot.source_head_sha !== beforeSha
      || stableJson(commitSnapshot.staged_paths) !== stableJson(authorizedPaths)
      || commitSnapshot.index_tree_oid !== committedTreeOid
    ) {
      fail("git.commit commit tree differs from the exact staged index authorized at the checkpoint.");
    }
  }
  const allowedPaths = authorization.action_details?.allowed_write_paths || [];
  // The story's own records authorized with the commit travel outside the code's write scope.
  const storyRecordPaths = new Set(authorization.action_details?.story_record_paths || []);
  const outOfScope = committedPaths.filter((filePath) => !pathMatchesApprovedWriteScope(filePath, allowedPaths)
    && !storyRecordPaths.has(filePath));
  if (outOfScope.length > 0) {
    fail(`git.commit completed paths escaped the approved write scope: ${outOfScope.join(", ")}.`);
  }
  return {
    ...authorization.action_details,
    commit: {
      before_sha: beforeSha,
      after_sha: afterSha,
      committed_paths: committedPaths,
    },
  };
}

export function verifyLegacyCompletedGitPush(context, authorization) {
  const push = authorization.action_details?.push;
  const precondition = authorization.action_details?.push_precondition;
  if (!push?.remote || !push.destination_ref || !push.source_sha) {
    fail(`git.push authorization ${authorization.id} lacks an exact remote operation.`);
  }
  if (
    !precondition
    || precondition.remote !== push.remote
    || precondition.destination_ref !== push.destination_ref
    || precondition.observed_sha === push.source_sha
  ) {
    fail(`git.push authorization ${authorization.id} lacks a distinct pre-action remote-ref observation.`);
  }
  let output;
  try {
    output = childProcess.execFileSync(
      "git",
      ["-C", context.root, "ls-remote", "--heads", push.remote, push.destination_ref],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  } catch (error) {
    fail(`git.push remote verification failed: ${String(error.stderr || error.message).trim()}`);
  }
  const matches = output.split(/\r?\n/u).map((line) => line.trim().split(/\s+/u)).filter((parts) =>
    parts.length >= 2 && parts[1] === push.destination_ref);
  if (matches.length !== 1 || matches[0][0] !== push.source_sha) {
    fail(`git.push completion is not proven: ${push.destination_ref} does not resolve to ${push.source_sha}.`);
  }
  return {
    provider: "git-remote",
    remote: push.remote,
    destination_ref: push.destination_ref,
    observed_sha: matches[0][0],
    verified_at: now(),
  };
}

export function verifyLegacyCompletedGitHubMerge(profile, authorization) {
  const merge = authorization.action_details?.merge;
  const precondition = authorization.action_details?.merge_precondition;
  if (!merge?.pr_url || !merge.source_sha) {
    fail(`pull_request.merge authorization ${authorization.id} lacks an exact GitHub PR operation.`);
  }
  if (
    precondition?.provider !== "github-cli"
    || precondition.state !== "OPEN"
    || !samePullRequestUrl(precondition.pr_url, merge.pr_url)
    || precondition.head_sha !== merge.source_sha
  ) {
    fail(`pull_request.merge authorization ${authorization.id} lacks an exact open-PR precondition.`);
  }
  let raw;
  try {
    raw = childProcess.execFileSync(
      "gh",
      ["pr", "view", merge.pr_url, "--json", "url,state,isDraft,mergedAt,mergeCommit,headRefOid,headRefName,baseRefName,baseRefOid"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    fail(`pull_request.merge provider verification requires authenticated GitHub CLI access: ${String(error.stderr || error.message).trim()}`);
  }
  let observed;
  try {
    observed = JSON.parse(raw);
  } catch {
    fail("pull_request.merge provider returned invalid JSON.");
  }
  const authorizedAt = Date.parse(authorization.authorized_at || "");
  const mergedAt = Date.parse(observed.mergedAt || "");
  if (
    observed.state !== "MERGED"
    || observed.isDraft === true
    || !observed.mergedAt
    || !observed.mergeCommit?.oid
    || observed.headRefOid !== merge.source_sha
    || observed.headRefName !== profile.pull_request_target.head_branch
    || observed.baseRefName !== profile.pull_request_target.base_branch
    || (merge.base_sha !== undefined && observed.baseRefOid !== merge.base_sha)
    || !samePullRequestUrl(observed.url, merge.pr_url)
    || !Number.isFinite(authorizedAt)
    || !Number.isFinite(mergedAt)
    || mergedAt < authorizedAt
  ) {
    fail("pull_request.merge completion is not proven by the exact GitHub PR, head SHA, branches, and merged state.");
  }
  return {
    provider: "github-cli",
    pr_url: canonicalAbsoluteUrl(observed.url),
    state: observed.state,
    is_draft: false,
    head_sha: observed.headRefOid,
    head_branch: observed.headRefName,
    base_branch: observed.baseRefName,
    ...(typeof observed.baseRefOid === "string" ? { base_sha: observed.baseRefOid } : {}),
    merge_commit_sha: observed.mergeCommit.oid,
    merged_at: observed.mergedAt,
    verified_at: now(),
  };
}

export function validatePullRequestGitBoundary(context, target) {
  const metadata = buildGitMetadata(context.root);
  if (!metadata.is_git_repo) {
    fail("Pull-request delivery requires the target root to be a Git worktree.");
  }
  for (const [label, branch] of [["base", target?.base_branch], ["head", target?.head_branch]]) {
    if (!branch || execGit(context.root, ["check-ref-format", "--branch", String(branch)]) !== String(branch)) {
      fail(`Pull-request ${label} branch is invalid: ${branch || "missing"}.`);
    }
  }
  const currentBranch = execGit(context.root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (!currentBranch) {
    fail("Pull-request delivery cannot start from a detached HEAD.");
  }
  if (currentBranch !== target.head_branch) {
    fail(`Pull-request delivery head mismatch: current branch is ${currentBranch}, expected ${target.head_branch}.`);
  }
  if (target.mode === "existing" && target.reviewed_head_sha) {
    if (
      !gitCommandSucceeds(context.root, ["cat-file", "-e", `${target.reviewed_head_sha}^{commit}`])
      || !gitCommandSucceeds(
        context.root,
        ["merge-base", "--is-ancestor", target.reviewed_head_sha, metadata.head_sha],
      )
    ) {
      fail(
        `Existing pull-request delivery head is no longer descended from the reviewed commit ${target.reviewed_head_sha}. `
        + "Create and approve a new delivery profile before changing the PR target lineage.",
      );
    }
  }
  const expectedRepository = normalizeGitRepositoryIdentity(target.repository);
  const matchingRemotes = [];
  const matchingRemoteFingerprints = [];
  for (const remote of metadata.remotes || []) {
    const fetchUrls = (execGit(context.root, ["remote", "get-url", "--all", remote]) || "")
      .split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
    const pushUrls = (execGit(context.root, ["remote", "get-url", "--push", "--all", remote]) || "")
      .split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
    const fetchMatches = fetchUrls.length > 0
      && fetchUrls.every((url) => normalizeGitRepositoryIdentity(url) === expectedRepository);
    const pushIsRequired = (target.allowed_actions || []).includes("git.push");
    const pushMatches = pushUrls.length > 0
      && pushUrls.every((url) => normalizeGitRepositoryIdentity(url) === expectedRepository);
    if (fetchMatches && (!pushIsRequired || pushMatches)) {
      matchingRemotes.push(remote);
      matchingRemoteFingerprints.push({
        remote,
        fetch: shortHashFull(stableJson(fetchUrls.map(normalizeGitRepositoryIdentity).filter(Boolean).sort())),
        push: shortHashFull(stableJson(pushUrls.map(normalizeGitRepositoryIdentity).filter(Boolean).sort())),
      });
    }
  }
  if (!expectedRepository || matchingRemotes.length === 0) {
    fail(`Pull-request delivery has no Git remote matching repository ${target.repository}.`);
  }
  const baseCandidates = matchingRemotes.map((remote) => `refs/remotes/${remote}/${target.base_branch}`);
  const baseRef = baseCandidates.find((candidate) =>
    Boolean(execGit(context.root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${candidate}^{commit}`])),
  );
  if (!baseRef) {
    fail(`Pull-request delivery base branch ${target.base_branch} has no local tracking ref for a matching remote; fetch it before task start.`);
  }
  return {
    branch: currentBranch,
    head_sha: metadata.head_sha,
    base_ref: baseRef,
    base_sha: execGit(context.root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${baseRef}^{commit}`]),
    matching_remotes: matchingRemotes.sort(),
    remote_fingerprint: shortHashFull(stableJson(matchingRemoteFingerprints.sort((left, right) =>
      left.remote.localeCompare(right.remote)))),
  };
}

export function pullRequestCommitLineage(context, profile) {
  return buildPullRequestCommitLineage(profile, {
    repository: normalizeGitRepositoryIdentity(profile.pull_request_target?.repository),
    resolveRequirementLogicalId: (ref) => {
      const requirementProfile = readRequirementAutonomyProfile(context, ref.id);
      if (requirementProfile.profile_hash !== ref.hash) {
        fail(`Delivery profile ${profile.id} has a stale requirement profile reference ${ref.id}.`);
      }
      const requirement = requirementByAutonomyProfileId(context, requirementProfile.id);
      if (!requirement) {
        fail(`Delivery profile ${profile.id} references a requirement profile without its immutable requirement.`);
      }
      return requirement.logical_id || requirement.id;
    },
  });
}

export function validateCommitMediationCandidate(
  context,
  currentProfile,
  commitSha,
  completion,
  authorization,
  candidateProfile,
) {
  const errors = [];
  const label = `Commit ${commitSha}`;
  if (
    stableJson(pullRequestCommitLineage(context, candidateProfile))
    !== stableJson(pullRequestCommitLineage(context, currentProfile))
  ) {
    return { compatible: false, errors: [] };
  }
  if (candidateProfile.status !== "active") {
    errors.push(`${label} mediation profile is not approved and active`);
  }
  try {
    validateAutonomyApprovalRef(context, candidateProfile, `${label} mediation profile`);
  } catch (error) {
    errors.push(`${label} mediation profile approval is invalid: ${error.message}`);
  }
  let executionState = null;
  try {
    executionState = currentDeliveryExecutionState(context, candidateProfile);
  } catch (error) {
    errors.push(`${label} mediation execution state is invalid: ${error.message}`);
  }
  const startReceipt = executionState?.start_receipt || null;
  const profileStoryRef = (candidateProfile.story_refs || []).find((ref) => ref.id === startReceipt?.story_ref?.id);
  const profileContractRef = (candidateProfile.contract_refs || []).find((ref) => ref.id === startReceipt?.contract_ref?.id);
  if (
    !startReceipt
    || !profileStoryRef
    || !profileContractRef
    || stableJson(startReceipt.story_ref) !== stableJson(profileStoryRef)
    || stableJson(startReceipt.contract_ref) !== stableJson(profileContractRef)
  ) {
    errors.push(`${label} mediation profile has no matching immutable delivery start`);
  } else {
    try {
      const decisionPath = resolveProjectFilePath(
        context,
        startReceipt.autonomy_decision_ref.path,
        { mustExist: true, fileOnly: true },
      );
      const startDecision = readProjectJson(context, decisionPath);
      const integrity = validateAutonomyDecisionIntegrity(startDecision);
      if (
        !integrity.valid
        || startDecision.id !== startReceipt.autonomy_decision_ref.id
        || startDecision.decision_hash !== startReceipt.autonomy_decision_ref.hash
        || startDecision.delivery?.profile_id !== candidateProfile.id
        || startDecision.delivery?.profile_hash !== candidateProfile.profile_hash
        || startDecision.effective_level !== startReceipt.effective_level
      ) {
        errors.push(`${label} mediation delivery start decision is stale or invalid`);
      }
    } catch (error) {
      errors.push(`${label} mediation delivery start decision is unavailable: ${error.message}`);
    }
  }
  errors.push(...validateCommitCoverageProfileRef(context, candidateProfile, completion.profile_ref, label));
  errors.push(...validateCommitCoverageProfileRef(context, candidateProfile, authorization?.profile_ref, label));
  if (
    !authorization
    || authorization.action !== "git.commit"
    || authorization.status !== "authorized"
    || authorization.receipt_hash !== completion.authorization_receipt_ref?.hash
    || authorization.id !== completion.authorization_receipt_ref?.id
    || completion.action !== "git.commit"
    || completion.status !== "completed"
    || completion.outcome !== "passed"
    || completion.delivery?.id !== candidateProfile.delivery_id
    || authorization.delivery?.id !== candidateProfile.delivery_id
    || completion.delivery?.kind !== candidateProfile.delivery_kind
    || authorization.delivery?.kind !== candidateProfile.delivery_kind
    || completion.effective_level !== authorization.effective_level
    || completion.action_details?.commit?.after_sha !== commitSha
  ) {
    errors.push(`${label} receipt pair is not an exact passing git.commit mediation`);
  }
  const checkpointPolicy = authorization?.action_details?.checkpoint_policy || null;
  if (checkpointPolicy) {
    const checkpointValidation = validateDeliveryActionCheckpointPolicySnapshot(
      context,
      checkpointPolicy,
      candidateProfile,
      authorization.effective_level,
      "git.commit",
    );
    if (!checkpointValidation.valid || authorization.checkpoint_required !== checkpointPolicy.required) {
      errors.push(`${label} authorization has an invalid immutable checkpoint policy`);
    }
  }
  if (authorization?.checkpoint_required === true) {
    const approvalReport = { strict: true, errors: [], warnings: [], checked: [] };
    validateFormalApprovalRecord(
      context,
      approvalReport,
      authorization.approval,
      `${label} authorization approval`,
      authorization.approval?.approved_by,
      { subject_id: candidateProfile.id },
    );
    const approvalSubject = {
      profile_id: candidateProfile.id,
      profile_hash: candidateProfile.profile_hash,
      delivery_id: candidateProfile.delivery_id,
      action: authorization.action,
      runtime_target: authorization.runtime_target,
      action_details: authorization.action_details,
    };
    if (
      authorization.approval?.status !== "approved"
      || authorization.approval?.approved_content_hash !== hashApprovalSubject(approvalSubject)
    ) {
      approvalReport.errors.push(`${label} authorization approval is missing or bound to a different action`);
    }
    try {
      validateApprovalEvidenceIntegrity(context, authorization.approval, `${label} authorization approval`);
      validateDeliveryActionHostAuthority(context, candidateProfile, authorization);
    } catch (error) {
      approvalReport.errors.push(`${label} authorization approval evidence is invalid: ${error.message}`);
    }
    errors.push(...approvalReport.errors);
  }
  const startAt = Date.parse(startReceipt?.started_at || "");
  const authorizedAt = Date.parse(authorization?.authorized_at || "");
  const completedAt = Date.parse(completion?.authorized_at || "");
  const closedAt = executionState?.close_receipt
    ? Date.parse(executionState.close_receipt.closed_at || "")
    : Number.POSITIVE_INFINITY;
  const effectiveProfileStatus = effectiveDeliveryProfileStatus(context, candidateProfile);
  const revokedAt = effectiveProfileStatus.revocation
    ? Date.parse(effectiveProfileStatus.revocation.created_at || "")
    : Number.POSITIVE_INFINITY;
  if (
    !Number.isFinite(startAt)
    || !Number.isFinite(authorizedAt)
    || !Number.isFinite(completedAt)
    || (executionState?.close_receipt && !Number.isFinite(closedAt))
    || (effectiveProfileStatus.revocation && !Number.isFinite(revokedAt))
    || authorizedAt < startAt
    || completedAt < authorizedAt
    || completedAt > closedAt
    || completedAt > revokedAt
  ) {
    errors.push(`${label} mediation receipts fall outside the immutable delivery execution window`);
  }
  const target = candidateProfile.pull_request_target || {};
  for (const receipt of [authorization, completion].filter(Boolean)) {
    if (
      normalizeGitRepositoryIdentity(receipt.action_details?.repository) !== normalizeGitRepositoryIdentity(target.repository)
      || receipt.action_details?.base_branch !== target.base_branch
      || receipt.action_details?.head_branch !== target.head_branch
    ) {
      errors.push(`${label} receipt pair is bound to a different pull-request target`);
      break;
    }
  }
  if (authorization && errors.length === 0) {
    const validation = { errors: [], warnings: [] };
    validateCompletedGitCommitReceipt(context, validation, completion, authorization, label);
    errors.push(...validation.errors);
  }
  return { compatible: true, errors, startReceipt };
}

export function buildGitCommitCoverageProof(context, profile, runtimeTarget) {
  const errors = [];
  const baseSha = runtimeTarget?.base_sha;
  const headSha = runtimeTarget?.head_sha;
  if (!baseSha || !headSha) {
    return { errors: ["Git commit coverage requires exact base and head SHAs."], proof: null };
  }
  if (execGit(context.root, ["merge-base", baseSha, headSha]) !== baseSha) {
    return { errors: [`Git head ${headSha} is not descended from the approved base ${baseSha}.`], proof: null };
  }
  const commitShas = gitCommitRange(context.root, baseSha, headSha);
  if (!commitShas) {
    return { errors: [gitCommitRangeUnavailable(baseSha, headSha)], proof: null };
  }
  const receipts = allDeliveryActionReceipts(context);
  const receiptById = new Map(receipts.map((receipt) => [receipt.id, receipt]));
  const profileCache = new Map();
  const entries = [];
  for (const commitSha of commitShas) {
    const candidates = [];
    const invalidCandidates = [];
    for (const completion of receipts.filter((receipt) =>
      receipt.action === "git.commit"
      && receipt.status === "completed"
      && receipt.outcome === "passed"
      && receipt.action_details?.commit?.after_sha === commitSha)) {
      const profileId = completion.profile_ref?.id;
      if (!profileId) continue;
      let candidateProfile = profileCache.get(profileId);
      if (!candidateProfile) {
        candidateProfile = readDeliveryAutonomyProfile(context, profileId);
        profileCache.set(profileId, candidateProfile);
      }
      const authorization = receiptById.get(completion.authorization_receipt_ref?.id) || null;
      const validation = validateCommitMediationCandidate(
        context,
        profile,
        commitSha,
        completion,
        authorization,
        candidateProfile,
      );
      if (!validation.compatible) continue;
      if (validation.errors.length > 0) {
        invalidCandidates.push(...validation.errors);
        continue;
      }
      candidates.push({
        completion,
        authorization,
        candidateProfile,
        startReceipt: validation.startReceipt,
      });
    }
    if (candidates.length !== 1) {
      errors.push(
        candidates.length === 0 && invalidCandidates.length > 0
          ? `${labelForCommit(commitSha)} has invalid mediation: ${invalidCandidates.join("; ")}`
          : `Commit ${commitSha} requires exactly one passing completed git.commit receipt from the same pull-request lineage before git.push.`,
      );
      continue;
    }
    const { completion, authorization, candidateProfile, startReceipt } = candidates[0];
    entries.push({
      commit_sha: commitSha,
      profile_ref: {
        id: candidateProfile.id,
        path: toProjectPath(context, deliveryAutonomyPath(context, candidateProfile.id)),
        hash: candidateProfile.profile_hash,
      },
      start_receipt_ref: deliveryStartReceiptRef(context, candidateProfile, startReceipt),
      authorization_receipt_ref: deliveryActionReceiptRef(context, authorization),
      completion_receipt_ref: deliveryActionReceiptRef(context, completion),
    });
  }
  if (errors.length > 0) return { errors, proof: null };
  const proofBase = {
    schema_version: "git-commit-coverage:v1",
    base_sha: baseSha,
    head_sha: headSha,
    lineage_hash: hashApprovalSubject(pullRequestCommitLineage(context, profile)),
    entries,
  };
  return {
    errors: [],
    proof: { ...proofBase, coverage_hash: hashApprovalSubject(proofBase) },
  };
}

export function validateGitCommitCoverageProof(context, profile, runtimeTarget, proof) {
  const errors = [];
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) {
    return ["Git commit coverage proof is missing."];
  }
  const { coverage_hash: coverageHash, ...proofBase } = proof;
  if (
    proof.schema_version !== "git-commit-coverage:v1"
    || coverageHash !== hashApprovalSubject(proofBase)
    || proof.base_sha !== runtimeTarget?.base_sha
    || proof.head_sha !== runtimeTarget?.head_sha
    || proof.lineage_hash !== hashApprovalSubject(pullRequestCommitLineage(context, profile))
    || !Array.isArray(proof.entries)
  ) {
    return ["Git commit coverage proof is stale or invalid."];
  }
  if (!proof.entries.every((entry) =>
    entry
    && typeof entry === "object"
    && !Array.isArray(entry)
    && /^[a-f0-9]{40,64}$/u.test(entry.commit_sha || "")
    && typeof entry.profile_ref?.id === "string"
    && typeof entry.start_receipt_ref?.id === "string"
    && typeof entry.authorization_receipt_ref?.id === "string"
    && typeof entry.completion_receipt_ref?.id === "string")) {
    return ["Git commit coverage proof contains an invalid entry."];
  }
  if (execGit(context.root, ["merge-base", proof.base_sha, proof.head_sha]) !== proof.base_sha) {
    return [`Git head ${proof.head_sha} is not descended from the approved base ${proof.base_sha}.`];
  }
  const expectedCommits = gitCommitRange(context.root, proof.base_sha, proof.head_sha);
  if (!expectedCommits) {
    return [gitCommitRangeUnavailable(proof.base_sha, proof.head_sha)];
  }
  if (stableJson(proof.entries.map((entry) => entry.commit_sha)) !== stableJson(expectedCommits)) {
    errors.push("Git commit coverage proof does not cover the exact ordered commit range.");
  }
  const receipts = allDeliveryActionReceipts(context);
  const receiptById = new Map(receipts.map((receipt) => [receipt.id, receipt]));
  for (const entry of proof.entries) {
    let candidateProfile;
    try {
      candidateProfile = readDeliveryAutonomyProfile(context, entry.profile_ref.id);
    } catch (error) {
      errors.push(`${labelForCommit(entry.commit_sha)} coverage profile is unavailable: ${error.message}`);
      continue;
    }
    const authorization = receiptById.get(entry.authorization_receipt_ref?.id) || null;
    const completion = receiptById.get(entry.completion_receipt_ref?.id) || null;
    errors.push(...validateCommitCoverageProfileRef(
      context,
      candidateProfile,
      entry.profile_ref,
      labelForCommit(entry.commit_sha),
    ));
    if (
      !authorization
      || !completion
      || stableJson(deliveryActionReceiptRef(context, authorization)) !== stableJson(entry.authorization_receipt_ref)
      || stableJson(deliveryActionReceiptRef(context, completion)) !== stableJson(entry.completion_receipt_ref)
    ) {
      errors.push(`${labelForCommit(entry.commit_sha)} coverage references are missing or stale`);
      continue;
    }
    const validation = validateCommitMediationCandidate(
      context,
      profile,
      entry.commit_sha,
      completion,
      authorization,
      candidateProfile,
    );
    if (
      !validation.startReceipt
      || stableJson(deliveryStartReceiptRef(context, candidateProfile, validation.startReceipt))
        !== stableJson(entry.start_receipt_ref)
    ) {
      errors.push(`${labelForCommit(entry.commit_sha)} coverage start receipt is missing or stale`);
    }
    if (!validation.compatible) {
      errors.push(`${labelForCommit(entry.commit_sha)} coverage comes from a different pull-request lineage`);
    } else {
      errors.push(...validation.errors);
    }
  }
  return errors;
}

export function gitCommitReceiptCoverageErrors(context, profile, runtimeTarget, actions = null, coverageProof = null) {
  if (coverageProof) {
    return validateGitCommitCoverageProof(context, profile, runtimeTarget, coverageProof);
  }
  const errors = [];
  const baseSha = runtimeTarget?.base_sha;
  const headSha = runtimeTarget?.head_sha;
  if (!baseSha || !headSha) {
    return ["Git commit coverage requires exact base and head SHAs."];
  }
  if (execGit(context.root, ["merge-base", baseSha, headSha]) !== baseSha) {
    return [`Git head ${headSha} is not descended from the approved base ${baseSha}.`];
  }
  const commitShas = gitCommitRange(context.root, baseSha, headSha);
  if (!commitShas) {
    return [gitCommitRangeUnavailable(baseSha, headSha)];
  }
  const receipts = actions || deliveryActionReceipts(context, profile.id);
  const completions = receipts.filter((receipt) =>
    receipt.action === "git.commit"
    && receipt.status === "completed"
    && receipt.outcome === "passed"
    && receipt.profile_ref?.hash === profile.profile_hash
    && receipt.delivery?.id === profile.delivery_id
    && receipt.delivery?.kind === profile.delivery_kind);
  for (const commitSha of commitShas) {
    const matchingCompletions = completions.filter((receipt) => receipt.action_details?.commit?.after_sha === commitSha);
    if (matchingCompletions.length !== 1) {
      errors.push(`Commit ${commitSha} requires exactly one passing completed git.commit receipt before git.push.`);
      continue;
    }
    const completion = matchingCompletions[0];
    const authorization = receipts.find((receipt) =>
      receipt.id === completion.authorization_receipt_ref?.id
      && receipt.receipt_hash === completion.authorization_receipt_ref?.hash
      && receipt.action === "git.commit"
      && receipt.status === "authorized"
      && receipt.profile_ref?.hash === profile.profile_hash);
    if (!authorization) {
      errors.push(`Commit ${commitSha} completion lacks its exact git.commit authorization receipt.`);
      continue;
    }
    const validation = { errors: [] };
    validateCompletedGitCommitReceipt(
      context,
      validation,
      completion,
      authorization,
      `Commit ${commitSha}`,
    );
    errors.push(...validation.errors);
  }
  return errors;
}

/**
 * Commits in `baseSha..headSha`, oldest first, or null when Git cannot list
 * them completely. A failed listing must never read as an empty range:
 * coverage built on it would approve commits that were never checked.
 */
export function gitCommitRange(root, baseSha, headSha) {
  const output = execGitOutput(root, ["rev-list", "--reverse", "--topo-order", `${baseSha}..${headSha}`]);
  if (output === null) return null;
  return output.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean);
}

function gitCommitRangeUnavailable(baseSha, headSha) {
  return `Git could not list the commit range ${baseSha}..${headSha}; commit coverage cannot be proven.`;
}

export function assertGitCommitReceiptCoverage(context, profile, runtimeTarget) {
  const { errors, proof } = buildGitCommitCoverageProof(context, profile, runtimeTarget);
  if (errors.length > 0) {
    fail(`git.push cannot authorize unmediated commits: ${errors.join("; ")}`);
  }
  return proof;
}

export function buildGitMetadata(root) {
  const isGitRepo = execGit(root, ["rev-parse", "--is-inside-work-tree"]) === "true";
  if (!isGitRepo) {
    return {
      is_git_repo: false,
      branch: null,
      head_sha: null,
      is_dirty: null,
      user: {
        name: null,
        email: null,
      },
      remotes: [],
    };
  }

  return {
    is_git_repo: true,
    branch: execGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    head_sha: execGit(root, ["rev-parse", "HEAD"]),
    is_dirty: gitWorktreeIsDirty(root),
    user: {
      name: gitConfigValue(root, "user.name"),
      email: gitConfigValue(root, "user.email"),
    },
    remotes: (execGit(root, ["remote"]) || "")
      .split(/\r?\n/)
      .map((remote) => remote.trim())
      .filter(Boolean),
  };
}

/**
 * The empty tree of the repository's object format (SHA-1 or SHA-256), or null
 * when Git cannot compute it. It is the base an unborn HEAD is compared with.
 */
export function gitEmptyTreeId(root) {
  const treeId = execGit(root, ["hash-object", "-t", "tree", "--stdin"]);
  return isGitObjectId(treeId) ? treeId : null;
}

/**
 * True only when HEAD names a branch that has no commit yet. Any other reason
 * for a missing HEAD commit (corruption, a detached or broken HEAD) is not an
 * unborn repository and stays unverifiable.
 */
export function gitHeadIsUnborn(root) {
  if (execGit(root, ["rev-parse", "--is-inside-work-tree"]) !== "true") return false;
  if (execGit(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])) return false;
  const branchRef = execGit(root, ["symbolic-ref", "--quiet", "HEAD"]);
  return Boolean(branchRef)
    && !execGit(root, ["rev-parse", "--verify", "--quiet", branchRef]);
}

/**
 * The explicit base a task start records on an unborn HEAD, or null when HEAD
 * is a commit (or cannot be classified), which the audit head already names.
 */
export function currentUnbornGitBase(root) {
  if (!gitHeadIsUnborn(root)) return null;
  const emptyTree = gitEmptyTreeId(root);
  return emptyTree ? unbornGitBase(emptyTree) : null;
}

/**
 * Whether `git status` reports any change, or null when Git cannot tell. An
 * unknown state is never reported as clean; status output beyond the buffer
 * limit is itself proof of changes.
 */
export function gitWorktreeIsDirty(root) {
  try {
    return childProcess.execFileSync("git", ["-C", root, "status", "--porcelain"], {
      encoding: "utf8",
      maxBuffer: GIT_COMMAND_MAX_OUTPUT_BYTES,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim().length > 0;
  } catch (error) {
    return error?.code === "ENOBUFS" ? true : null;
  }
}

export function gitConfigValue(root, key) {
  return execGit(root, ["config", "--get", key]);
}

// Git subcommands that only read. Inside a read snapshot (status and the
// other read-only reports) the same read is answered once.
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "cat-file", "diff", "diff-tree", "for-each-ref", "log", "ls-files", "ls-tree",
  "merge-base", "rev-list", "rev-parse", "show", "symbolic-ref",
]);

function snapshotGitRead(kind, root, args, live) {
  // Answers about commits named by full IDs are kept across runs.
  const run = () => cachedGitObjectAnswer(root, `plain-${kind}`, args, live);
  if (!readSnapshotActive() || !READ_ONLY_GIT_SUBCOMMANDS.has(args[0])) return run();
  return readSnapshotValue(`git:${kind}:${JSON.stringify([root, ...args])}`, run);
}

export function execGit(root, args) {
  return snapshotGitRead("trimmed", root, args, () => execGitLive(root, args));
}

function execGitLive(root, args) {
  try {
    return childProcess
      .execFileSync("git", ["-C", root, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      })
      .trim() || null;
  } catch {
    return null;
  }
}

/**
 * Complete stdout of a Git command, or null when it fails or its output
 * exceeds the buffer limit. Unlike execGit, empty output stays "" so callers
 * can tell an empty result from a failure.
 */
export function execGitOutput(root, args) {
  return snapshotGitRead("output", root, args, () => execGitOutputLive(root, args));
}

function execGitOutputLive(root, args) {
  try {
    return childProcess.execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      maxBuffer: GIT_COMMAND_MAX_OUTPUT_BYTES,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
  } catch {
    return null;
  }
}

export function gitCommandSucceeds(root, args) {
  return snapshotGitRead("succeeds", root, args, () => gitCommandSucceedsLive(root, args));
}

function gitCommandSucceedsLive(root, args) {
  try {
    childProcess.execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

export function resolveSecretScanCommit(context, ref, label) {
  const sha = execGit(context.root, ["rev-parse", "--verify", `${ref}^{commit}`]);
  if (!sha || !/^[a-f0-9]{40,64}$/iu.test(sha)) {
    fail(`--${label} must name a commit that exists in this repository: ${ref}`);
  }
  return sha.toLowerCase();
}

export function secretScanGitPaths(context, args) {
  return String(execGit(context.root, args) || "")
    .split(/\r?\n/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * The bytes of `projectPath` as `commitSha` holds it, or null when the commit
 * has no such blob. A blob over `maxBytes` is reported as oversized unread.
 */
export function readGitBlobAt(context, commitSha, projectPath, maxBytes) {
  const spec = `${commitSha}:${projectPath}`;
  if (execGit(context.root, ["cat-file", "-t", spec]) !== "blob") return null;
  const size = Number(execGit(context.root, ["cat-file", "-s", spec]));
  if (!Number.isSafeInteger(size) || size > maxBytes) return { oversized: true, content: null };
  const content = childProcess.execFileSync("git", ["-C", context.root, "cat-file", "blob", spec], {
    encoding: null,
    maxBuffer: maxBytes + 1,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return { oversized: false, content };
}

export function validateCompletedGitCommitReceipt(context, report, receipt, authorization, label) {
  const commit = receipt.action_details?.commit;
  const { commit: _commit, ...authorizedProjection } = receipt.action_details || {};
  if (
    !commit
    || stableJson(authorizedProjection) !== stableJson(authorization.action_details)
    || stableJson(gitRuntimeWithoutHead(receipt.runtime_target))
      !== stableJson(gitRuntimeWithoutHead(authorization.runtime_target))
    || commit.before_sha !== authorization.runtime_target?.head_sha
    || commit.after_sha !== receipt.runtime_target?.head_sha
  ) {
    report.errors.push(`${label} commit transition differs from its exact authorization boundary`);
    return;
  }
  // A squash or rebase merge, or a deleted branch, leaves the story's own commits out of
  // other clones: the receipt stays sealed, but its tree can only be re-checked where they exist.
  const missingCommits = [commit.before_sha, commit.after_sha]
    .filter((sha) => !gitCommandSucceeds(context.root, ["cat-file", "-e", `${sha}^{commit}`]));
  if (missingCommits.length > 0) {
    const warning = `${label} commit ${missingCommits.join(", ")} is not in this clone, so its tree is not re-checked here `
      + "(the branch was squashed, rebased or deleted, or not fetched; status fetches it from the remote when it can)";
    report.warnings ??= [];
    if (!report.warnings.includes(warning)) report.warnings.push(warning);
    return;
  }
  const parentLine = execGit(context.root, ["rev-list", "--parents", "-n", "1", commit.after_sha]);
  const commitAndParents = String(parentLine || "").split(/\s+/u).filter(Boolean);
  const committedPaths = [...new Set(String(
    execGit(context.root, ["diff", "--name-only", "--no-renames", commit.before_sha, commit.after_sha]) || "",
  ).split(/\r?\n/u).map((item) => item.trim()).filter(Boolean))].sort();
  const expectedPaths = [...(authorization.action_details?.changed_paths || [])].sort();
  const commitSnapshot = authorization.action_details?.commit_snapshot;
  const requiresCommitSnapshot = Boolean(authorization.action_details?.checkpoint_policy?.policy_source_ref);
  let snapshotValid = true;
  if (requiresCommitSnapshot && !commitSnapshot) {
    snapshotValid = false;
  } else if (commitSnapshot) {
    const committedTreeOid = String(
      execGit(context.root, ["rev-parse", `${commit.after_sha}^{tree}`]) || "",
    ).trim();
    const objectFormat = String(execGit(context.root, ["rev-parse", "--show-object-format"]) || "").trim();
    snapshotValid = commitSnapshot.schema_version === "git-commit-index-snapshot:v1"
      && commitSnapshot.object_format === objectFormat
      && commitSnapshot.source_head_sha === commit.before_sha
      && stableJson(commitSnapshot.staged_paths) === stableJson(expectedPaths)
      && commitSnapshot.index_tree_oid === committedTreeOid;
  } else {
    const warning = `${label} uses a legacy git.commit authorization without a staged index snapshot`;
    if (!report.warnings.includes(warning)) report.warnings.push(warning);
  }
  if (
    commitAndParents.length !== 2
    || commitAndParents[0] !== commit.after_sha
    || commitAndParents[1] !== commit.before_sha
    || stableJson(commit.committed_paths) !== stableJson(expectedPaths)
    || stableJson(committedPaths) !== stableJson(expectedPaths)
    || !snapshotValid
  ) {
    report.errors.push(`${label} does not prove one exact non-merge commit with the authorized staged tree and file set`);
  }
}

export function validateCompletedRemoteActionReceipt(context, report, profile, receipt, authorization, label) {
  if (validateCompletedProviderActionReceipt(context, report, profile, receipt, authorization, label)) return;
  if (!["git.push", "pull_request.merge"].includes(receipt.action)) {
    if (
      stableJson(receipt.runtime_target) !== stableJson(authorization.runtime_target)
      || stableJson(receipt.action_details) !== stableJson(authorization.action_details)
    ) {
      report.errors.push(`${label} completion differs from its exact authorization boundary`);
    }
    return;
  }
  const verificationField = receipt.action === "git.push" ? "remote_verification" : "provider_verification";
  const { [verificationField]: verification, ...authorizedProjection } = receipt.action_details || {};
  const runtimeTransition = receipt.action === "pull_request.merge" && verification
    ? validatePullRequestMergeRuntimeTransition(context, authorization, receipt.runtime_target, verification)
    : null;
  if (
    (runtimeTransition
      ? !runtimeTransition.valid
      : stableJson(receipt.runtime_target) !== stableJson(authorization.runtime_target))
    || stableJson(authorizedProjection) !== stableJson(authorization.action_details)
    || !verification
  ) {
    report.errors.push(`${label} remote completion differs from its exact authorization boundary`);
    return;
  }
  if (receipt.action === "git.push") {
    const push = authorization.action_details?.push;
    const precondition = authorization.action_details?.push_precondition;
    const basePrecondition = authorization.action_details?.base_precondition;
    if (
      verification.provider !== "git-remote"
      || verification.remote !== push?.remote
      || verification.destination_ref !== push?.destination_ref
      || verification.observed_sha !== push?.source_sha
      || precondition?.provider !== "git-remote"
      || precondition.remote !== push?.remote
      || precondition.destination_ref !== push?.destination_ref
      || precondition.observed_sha === push?.source_sha
      || basePrecondition?.provider !== "git-remote"
      || basePrecondition.remote !== push?.remote
      || basePrecondition.base_ref !== `refs/heads/${authorization.action_details?.base_branch}`
      || !/^[a-f0-9]{40,64}$/u.test(basePrecondition.observed_sha || "")
      || !Number.isFinite(Date.parse(verification.verified_at || ""))
    ) {
      report.errors.push(`${label} lacks exact remote-ref proof for the authorized push`);
    }
    return;
  }
  const merge = authorization.action_details?.merge;
  const precondition = authorization.action_details?.merge_precondition;
  const authorizedAt = Date.parse(authorization.authorized_at || "");
  const mergedAt = Date.parse(verification.merged_at || "");
  if (
    verification.provider !== "github-cli"
    || verification.state !== "MERGED"
    || verification.is_draft !== false
    || !samePullRequestUrl(verification.pr_url, merge?.pr_url)
    || verification.head_sha !== merge?.source_sha
    || !verification.merge_commit_sha
    || !verification.merged_at
    || precondition?.provider !== "github-cli"
    || precondition.state !== "OPEN"
    || precondition.is_draft !== false
    || !samePullRequestUrl(precondition.pr_url, merge?.pr_url)
    || precondition.head_sha !== merge?.source_sha
    || (merge?.base_sha !== undefined && (
      precondition.base_sha !== merge.base_sha
      || verification.base_sha !== merge.base_sha
    ))
    || !Number.isFinite(authorizedAt)
    || !Number.isFinite(mergedAt)
    || mergedAt < authorizedAt
  ) {
    report.errors.push(`${label} lacks exact GitHub provider proof for the authorized merge`);
  }
}
