// Keeping a story's checkout, its records and the other computers aligned:
// `story sync` (align the story branch with the base branch without losing
// local records) and the automatic publication of a
// story's records to the base branch after its merge or final gate.
// The rules that need no git live in lib/story-sync-plan.mjs.

import path from "node:path";
import { fail, failWithCode, UserError } from "../cli/user-error.mjs";
import { normalizeId, requireOption } from "../lifecycle/common.mjs";
import { humanGuidanceLocale } from "../lifecycle/guidance.mjs";
import { sendAutoAlert } from "../messaging/auto.mjs";
import { childProcess, Date, fs, os, process } from "../runtime/host.mjs";
import { orchestrationPolicy } from "../story-claim-shared-state.mjs";
import { storyBranchRecordPath } from "../story-records.mjs";
import {
  appendOnlyRecordPaths,
  autoPublishEnabled,
  AUTO_PUBLISH_ENV,
  classifySyncConflicts,
  identicalUntrackedFiles,
  isGeneratedGateRecord,
  isOwnStoryRecordPath,
  localRecordExtendsBase,
  outputRegistryRecordPath,
  reapplyDecision,
  rebuiltRecordPaths,
  unionOutputRegistries,
} from "../story-sync-plan.mjs";
import { recordedDeliveryCommitShas } from "./delivery-commits.mjs";
import { remoteBaseRef } from "./merge-drift.mjs";
import { ensureInitialized } from "./migration.mjs";
import { output, writeOutputRegistry } from "./output.mjs";
import { firstLine, runGit } from "./shared-refs.mjs";
import { planTraceRebase } from "./trace-rebase.mjs";

const NETWORK_TIMEOUT_SECONDS = 120;
const LOCAL_TIMEOUT_SECONDS = 60;
const MAX_BLOB_BYTES = 80 * 1024 * 1024;
const PUBLISH_ATTEMPTS = 2;

function refuse(code, message) {
  failWithCode(code, message);
}

function lines(result) {
  return result.ok ? result.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean) : [];
}

function gitRunner(context, timeoutSeconds = LOCAL_TIMEOUT_SECONDS) {
  return (args, extra = {}) => runGit(context.root, args, { timeoutSeconds, ...extra });
}

/** Raw bytes of `ref:filePath`, or null when the commit lacks it. */
function blobBytes(root, ref, filePath) {
  const result = childProcess.spawnSync("git", ["-C", root, "cat-file", "blob", `${ref}:${filePath}`], {
    encoding: "buffer",
    timeout: LOCAL_TIMEOUT_SECONDS * 1000,
    maxBuffer: MAX_BLOB_BYTES,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
    windowsHide: true,
  });
  return result.status === 0 && !result.error ? Buffer.from(result.stdout) : null;
}

function blobId(git, ref, filePath) {
  if (!ref) return null;
  return firstLine(git(["rev-parse", "--verify", "--quiet", `${ref}:${filePath}`]).stdout) || null;
}

function workingBlobId(git, root, filePath) {
  if (!fs.existsSync(absolute(root, filePath))) return null;
  return firstLine(git(["hash-object", "--", filePath]).stdout) || null;
}

function absolute(root, filePath) {
  return path.join(root, ...String(filePath).split("/"));
}

function sdlcFolderOf(context) {
  return path.relative(context.root, context.sdlcRoot).replace(/\\/gu, "/") || ".sdlc";
}

function knownStoryIds(context) {
  try {
    return fs.readdirSync(path.join(context.sdlcRoot, "stories"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

function writeBytes(root, filePath, bytes) {
  const target = absolute(root, filePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
}

function readWorking(root, filePath) {
  const target = absolute(root, filePath);
  return fs.existsSync(target) && fs.statSync(target).isFile() ? fs.readFileSync(target) : null;
}

function removeFile(root, filePath) {
  fs.rmSync(absolute(root, filePath), { force: true });
}

function parseJson(bytes) {
  if (!bytes) return null;
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return null;
  }
}

function policyOf(context) {
  const policy = orchestrationPolicy(context.config);
  return {
    remote: policy.coordination.remote,
    configuredBase: policy.merge_drift.base_branch,
    timeoutSeconds: policy.coordination.timeout_seconds,
  };
}

function requireStory(context, storyId) {
  if (!fs.existsSync(path.join(context.sdlcRoot, "stories", storyId, "story.json"))) {
    refuse("STORY_NOT_FOUND", `Story ${storyId} does not exist.`);
  }
}

/** Fetches the remote and returns { ref, branch, display } of the base branch. */
function fetchBase(context, git, { remote, configuredBase }, label) {
  const fetched = git(["fetch", "--quiet", "--no-tags", remote], { timeoutSeconds: NETWORK_TIMEOUT_SECONDS });
  if (!fetched.ok) {
    refuse("STORY_SYNC_REMOTE_UNAVAILABLE", `${label}: the git remote '${remote}' cannot be reached (${firstLine(fetched.stderr) || "git fetch failed"}).`);
  }
  const base = remoteBaseRef(context, remote, configuredBase, LOCAL_TIMEOUT_SECONDS);
  return base ? { ...base, display: `${remote}/${base.branch}` } : null;
}

/** Paths under `folder` changed in the working tree or index, with porcelain status. */
function changedUnder(git, folder) {
  const result = git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--", folder]);
  if (!result.ok) return [];
  return result.stdout.split("\0").filter(Boolean).map((entry) => ({ status: entry.slice(0, 2), path: entry.slice(3) }));
}

function sdlcExclude(folder) {
  return `:(exclude)${folder}`;
}

/** Commits a rebase onto `ontoCommit` would rewrite that a git.commit receipt names and no remote holds. */
function unpushedReceiptCommits(context, git, ontoCommit) {
  const receipted = new Set(recordedDeliveryCommitShas(context));
  if (receipted.size === 0) return [];
  const local = lines(git(["rev-list", "HEAD", "--not", ontoCommit, "--remotes"]));
  return local.filter((sha) => receipted.has(sha));
}

/** Rebuild the shared history and the output registry on top of `onto`; never throws. */
export function rebuildSharedRecords(context, options, onto, savedRegistry, { stopOnTraceError = false } = {}) {
  const report = { trace: null, trace_error: null, registry: null };
  try {
    const { payload } = planTraceRebase(context, { ...options, onto, apply: true, file: undefined }, { registry: false });
    report.trace = { changed: payload.changed, base_events: payload.base_events, moved_events: payload.moved_events };
  } catch (error) {
    if (!(error instanceof UserError)) throw error;
    report.trace_error = error.message;
    // A publication needs both merged or neither: the registry is left untouched.
    if (stopOnTraceError) return report;
  }
  const registryPath = path.join(context.sdlcRoot, "output-contracts", "registry.json");
  const current = fs.existsSync(registryPath) ? parseJson(fs.readFileSync(registryPath)) : null;
  const ontoRegistry = parseJson(blobBytes(context.root, onto, outputRegistryRecordPath(sdlcFolderOf(context))));
  // Every link this computer had, plus everything the base branch and this checkout have.
  let merged = unionOutputRegistries(current, ontoRegistry);
  if (savedRegistry) merged = unionOutputRegistries(savedRegistry, merged.registry);
  if (merged.registry && JSON.stringify(merged.registry) !== JSON.stringify(current)) {
    writeOutputRegistry(context, merged.registry);
    report.registry = { changed: true, added: merged.added };
  } else {
    report.registry = { changed: false, added: {} };
  }
  return report;
}

/**
 * story sync --id <story> [--onto <ref>] [--dry-run]: brings the story's
 * checkout up to date with the base branch without losing anything recorded
 * here. Local uncommitted records are set aside, the branch is fast-forwarded
 * or rebased (refused, with the files, when code conflicts), the records are
 * put back, the shared history is rebuilt like trace rebase --apply, the
 * output registry keeps every link of both sides, and untracked copies of
 * files the base branch now has with the same bytes are removed.
 */
export function syncStory(context, options) {
  ensureInitialized(context);
  const storyId = normalizeId(requireOption(options, "id"));
  requireStory(context, storyId);
  const italian = humanGuidanceLocale(options) === "it";
  const dryRun = options["dry-run"] === true;
  const settings = policyOf(context);
  const git = gitRunner(context);
  const folder = sdlcFolderOf(context);
  const base = fetchBase(context, git, settings, `Story ${storyId} was not synced`);
  const onto = typeof options.onto === "string" && options.onto.trim() ? options.onto.trim() : base?.display;
  if (!onto || onto.startsWith("-")) {
    refuse("STORY_SYNC_NO_BASE_BRANCH", `Story ${storyId} was not synced: the base branch is unknown. Pass --onto <remote>/<branch>, for example --onto origin/main.`);
  }
  const ontoCommit = firstLine(git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${onto}^{commit}`]).stdout);
  if (!ontoCommit) refuse("STORY_SYNC_NO_BASE_BRANCH", `Story ${storyId} was not synced: ${onto} is not a commit in this clone.`);
  const head = firstLine(git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).stdout);
  if (!head) refuse("STORY_SYNC_NO_HEAD", `Story ${storyId} was not synced: this checkout has no commit yet.`);
  const branch = firstLine(git(["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout);
  for (const marker of ["rebase-merge", "rebase-apply", "MERGE_HEAD"]) {
    const markerPath = firstLine(git(["rev-parse", "--git-path", marker]).stdout);
    if (markerPath && fs.existsSync(path.resolve(context.root, markerPath))) {
      refuse("STORY_SYNC_OPERATION_IN_PROGRESS", `Story ${storyId} was not synced: a git ${marker.startsWith("rebase") ? "rebase" : "merge"} is in progress here; finish or abort it first.`);
    }
  }
  const codeChanges = lines(git(["diff", "--name-only", "--no-renames", "HEAD", "--", ".", sdlcExclude(folder)]));
  const upToDate = git(["merge-base", "--is-ancestor", ontoCommit, head]).ok;
  const fastForward = !upToDate && git(["merge-base", "--is-ancestor", head, ontoCommit]).ok;
  const mode = upToDate ? "none" : fastForward ? "fast-forward" : "rebase";
  const ahead = Number(firstLine(git(["rev-list", "--count", `${ontoCommit}..${head}`]).stdout)) || 0;
  const behind = Number(firstLine(git(["rev-list", "--count", `${head}..${ontoCommit}`]).stdout)) || 0;
  // Files the base branch added that sit here untracked: identical copies go, different ones block.
  const addedOnBase = mode === "none" ? [] : lines(git(["diff", "--name-only", "--no-renames", "--diff-filter=A", head, ontoCommit]));
  const untrackedOnBase = addedOnBase
    .filter((filePath) => fs.existsSync(absolute(context.root, filePath)))
    .map((filePath) => ({ path: filePath, localBlob: workingBlobId(git, context.root, filePath), baseBlob: blobId(git, ontoCommit, filePath) }));
  const duplicates = identicalUntrackedFiles(untrackedOnBase);
  // The story's own records stay the local ones when they extend or supersede the base copy.
  const ownRecordOptions = { sdlcFolder: folder, storyId, storyIds: knownStoryIds(context) };
  const localOwnRecord = (filePath, ref = ontoCommit, localBytes = readWorking(context.root, filePath)) => isOwnStoryRecordPath(filePath, ownRecordOptions)
    && localRecordExtendsBase(localBytes, blobBytes(context.root, ref, filePath));
  const differentUntracked = untrackedOnBase.map((entry) => entry.path)
    // Regenerated gate/report files never block: the newer copy wins and the other is kept in the backup.
    .filter((filePath) => !duplicates.includes(filePath) && !localOwnRecord(filePath) && !isGeneratedGateRecord(filePath, folder));
  const localRecords = changedUnder(git, folder);
  const plan = {
    schema_version: "story-sync:v1",
    story_id: storyId,
    onto,
    onto_commit: ontoCommit,
    branch: branch || null,
    mode,
    ahead,
    behind,
    local_records: localRecords.map((entry) => entry.path),
    // Uncommitted changes to tracked code are set aside and put back around the move.
    code_changes: mode === "none" ? [] : codeChanges,
    duplicates_removed: duplicates,
    dry_run: dryRun,
  };
  const blockers = [];
  // A rebase gives every commit a new SHA: a governed commit not pushed yet would lose its receipt.
  const committedUnpushed = mode === "rebase" && options["allow-rebase-committed"] !== true
    ? unpushedReceiptCommits(context, git, ontoCommit)
    : [];
  if (committedUnpushed.length > 0) {
    blockers.push(
      `commit(s) ${committedUnpushed.map((sha) => sha.slice(0, 12)).join(", ")} carry a git.commit receipt and are not pushed: the rebase would change their SHA and git.push would refuse them. `
      + "Run story sync before the governed git.commit; to keep going now, pass --allow-rebase-committed and then make the governed commit again (git reset --soft "
      + `${onto}, then git.commit)`,
    );
  }
  if (differentUntracked.length > 0) blockers.push(`untracked files that ${onto} adds with different content: ${differentUntracked.join(", ")}`);
  if (dryRun) {
    output(options, { ...plan, status: "planned", blockers }, [
      italian
        ? `${storyId}: piano di allineamento con ${onto}: ${mode === "none" ? "il branch contiene già la base" : mode === "fast-forward" ? `avanzamento rapido di ${behind} commit` : `rebase di ${ahead} commit su ${behind} nuovi commit della base`}.`
        : `${storyId}: plan to align with ${onto}: ${mode === "none" ? "the branch already contains the base" : mode === "fast-forward" ? `fast-forward by ${behind} commit(s)` : `rebase ${ahead} commit(s) onto ${behind} new base commit(s)`}.`,
      ...(localRecords.length > 0 ? [italian ? `Record locali messi da parte e riapplicati: ${plan.local_records.join(", ")}` : `Local records set aside and re-applied: ${plan.local_records.join(", ")}`] : []),
      ...(plan.code_changes.length > 0 ? [italian ? `Modifiche di codice non committate messe da parte e riapplicate: ${plan.code_changes.join(", ")}` : `Uncommitted code changes set aside and re-applied: ${plan.code_changes.join(", ")}`] : []),
      ...(duplicates.length > 0 ? [italian ? `Copie non tracciate identiche alla base, da rimuovere: ${duplicates.join(", ")}` : `Untracked copies identical to the base, to remove: ${duplicates.join(", ")}`] : []),
      ...blockers.map((blocker) => (italian ? `Bloccante: ${blocker}` : `Blocking: ${blocker}`)),
      italian ? "Nessuna modifica eseguita (--dry-run)." : "Nothing was changed (--dry-run).",
    ]);
    return;
  }
  if (blockers.length > 0) {
    refuse("STORY_SYNC_BLOCKED", `Story ${storyId} was not synced with ${onto}: ${blockers.join("; ")}.`);
  }

  // 1. Set local records aside (a copy also stays next to the git data until the sync ends well).
  const saved = new Map();
  for (const filePath of new Set([...localRecords.map((entry) => entry.path), ...rebuiltRecordPaths(folder)])) {
    const target = absolute(context.root, filePath);
    saved.set(filePath, {
      bytes: fs.existsSync(target) && fs.statSync(target).isFile() ? fs.readFileSync(target) : null,
      oldHeadBlob: blobId(git, head, filePath),
      localBlob: workingBlobId(git, context.root, filePath),
    });
  }
  const commonDir = path.resolve(context.root, firstLine(git(["rev-parse", "--git-common-dir"]).stdout) || ".git");
  const backupRoot = path.join(commonDir, "agentic-sdlc", "sync-backup", `${storyId}-${new Date().toISOString().replace(/[:.]/gu, "-")}`);
  const restoreSaved = () => {
    for (const [filePath, entry] of saved) {
      if (entry.bytes) writeBytes(context.root, filePath, entry.bytes);
    }
  };
  let report = { trace: null, trace_error: null, registry: null };
  const reapplied = [];
  const conflicts = [];
  const autoResolved = new Set();
  let codeStash = plan.code_changes.length > 0 ? { status: "set_aside", ref: null } : null;
  // Puts the set-aside code changes back; a conflict keeps them in the stash and leaves the tree clean.
  const restoreCode = () => {
    if (!codeStash?.ref) return;
    const index = lines(git(["stash", "list", "--format=%H"])).indexOf(codeStash.ref);
    const popped = index >= 0 ? git(["stash", "pop", "--quiet", `stash@{${index}}`]) : { ok: false, stderr: "the stash entry is gone" };
    if (popped.ok) {
      codeStash = { status: "restored", ref: null };
      return;
    }
    git(["checkout", "--quiet", "HEAD", "--", ...plan.code_changes.filter((filePath) => blobId(git, "HEAD", filePath))]);
    codeStash = { status: "kept", ref: codeStash.ref, error: firstLine(popped.stderr) || "git stash pop failed" };
  };
  if (mode !== "none") {
    for (const [filePath, entry] of saved) {
      if (entry.bytes) writeBytes(backupRoot, filePath, entry.bytes);
    }
    if (codeStash) {
      const stashed = git(["stash", "push", "--quiet", "--message", `agentic-sdlc story sync ${storyId}`, "--", ...plan.code_changes]);
      const ref = stashed.ok ? firstLine(git(["rev-parse", "--verify", "--quiet", "refs/stash"]).stdout) : "";
      if (!ref) refuse("STORY_SYNC_FAILED", `Story ${storyId} was not synced: the uncommitted code changes could not be set aside (${firstLine(stashed.stderr) || "git stash failed"}). Nothing changed.`);
      codeStash = { status: "set_aside", ref };
    }
    git(["reset", "--quiet", "--", folder]);
    const tracked = localRecords.filter((entry) => !entry.status.startsWith("??")).map((entry) => entry.path)
      .filter((filePath) => blobId(git, head, filePath));
    if (tracked.length > 0) git(["checkout", "--quiet", "HEAD", "--", ...tracked]);
    for (const entry of localRecords) {
      if (!blobId(git, head, entry.path)) removeFile(context.root, entry.path);
    }
    for (const filePath of duplicates) removeFile(context.root, filePath);

    // 2. Move the branch.
    if (mode === "fast-forward") {
      const moved = git(["merge", "--ff-only", "--quiet", ontoCommit]);
      if (!moved.ok) {
        restoreSaved();
        restoreCode();
        refuse("STORY_SYNC_FAILED", `Story ${storyId} was not synced: the fast-forward to ${onto} failed (${firstLine(moved.stderr)}). Local records are unchanged.`);
      }
    } else {
      let step = git(["-c", "core.editor=true", "rebase", "--quiet", ontoCommit], { timeoutSeconds: NETWORK_TIMEOUT_SECONDS });
      for (let round = 0; !step.ok && round <= ahead; round += 1) {
        const unmerged = lines(git(["diff", "--name-only", "--diff-filter=U"]));
        const { automatic, blocking } = classifySyncConflicts(unmerged, folder);
        if (unmerged.length === 0 || blocking.length > 0) {
          git(["rebase", "--abort"]);
          restoreSaved();
          restoreCode();
          refuse(
            "STORY_SYNC_CONFLICT",
            `Story ${storyId} was not synced: rebasing onto ${onto} conflicts in ${blocking.length > 0 ? blocking.join(", ") : firstLine(step.stderr) || "git rebase"}. `
              + "Nothing changed: the branch and the local records are as before. Resolve those files with a person (git rebase "
              + `${onto}), then run story sync again.`,
          );
        }
        // The rebuilt records take the base side now; local events and links come back below.
        git(["checkout", "--ours", "--", ...automatic]);
        git(["add", "--", ...automatic]);
        for (const filePath of automatic) autoResolved.add(filePath);
        step = git(["-c", "core.editor=true", "rebase", "--continue"], { timeoutSeconds: NETWORK_TIMEOUT_SECONDS });
      }
      if (!step.ok) {
        git(["rebase", "--abort"]);
        restoreSaved();
        restoreCode();
        refuse("STORY_SYNC_FAILED", `Story ${storyId} was not synced: git rebase onto ${onto} did not finish (${firstLine(step.stderr)}). Nothing changed.`);
      }
    }
    const newHead = firstLine(git(["rev-parse", "HEAD"]).stdout);

    // 3. Put the local records back.
    for (const [filePath, entry] of saved) {
      const decision = reapplyDecision(filePath, {
        sdlcFolder: folder,
        localBlob: entry.localBlob,
        oldHeadBlob: entry.oldHeadBlob,
        newHeadBlob: blobId(git, newHead, filePath),
        ownExtends: entry.bytes ? localOwnRecord(filePath, newHead, entry.bytes) : false,
      });
      if (decision === "rebuilt") {
        // The history is rebuilt from this computer's copy; the registry is merged below.
        if (appendOnlyRecordPaths(folder).includes(filePath) && entry.bytes) writeBytes(context.root, filePath, entry.bytes);
      } else if (decision === "reapply") {
        if (entry.bytes) writeBytes(context.root, filePath, entry.bytes);
        else removeFile(context.root, filePath);
        if (entry.localBlob !== entry.oldHeadBlob) reapplied.push(filePath);
      } else if (decision === "conflict") {
        conflicts.push(filePath);
      }
    }
  }

  restoreCode();

  // 4. Shared history and output registry.
  const registryPath = outputRegistryRecordPath(folder);
  report = rebuildSharedRecords(context, options, onto, parseJson(saved.get(registryPath)?.bytes ?? null));
  const keptBackup = conflicts.length > 0 || report.trace_error;
  if (!keptBackup && fs.existsSync(backupRoot)) fs.rmSync(backupRoot, { recursive: true, force: true });
  const newHead = firstLine(git(["rev-parse", "HEAD"]).stdout);
  const rewritten = mode === "rebase" && ahead > 0;
  const added = Object.entries(report.registry?.added ?? {}).map(([name, count]) => `${count} ${name}`).join(", ");
  output(options, {
    ...plan,
    status: "synced",
    head_before: head,
    head_after: newHead,
    reapplied,
    conflicts,
    auto_resolved: [...autoResolved].sort(),
    trace: report.trace,
    trace_error: report.trace_error,
    output_registry: report.registry,
    backup: keptBackup ? backupRoot : null,
    branch_rewritten: rewritten,
    code_changes_stash: codeStash,
  }, [
    italian
      ? `${storyId}: allineata con ${onto} (${mode === "none" ? "il branch conteneva già la base" : mode === "fast-forward" ? `avanzamento rapido di ${behind} commit` : `rebase di ${ahead} commit`}).`
      : `${storyId}: aligned with ${onto} (${mode === "none" ? "the branch already contained the base" : mode === "fast-forward" ? `fast-forward by ${behind} commit(s)` : `rebased ${ahead} commit(s)`}).`,
    ...(reapplied.length > 0 ? [italian ? `Record locali riapplicati: ${reapplied.join(", ")}` : `Local records re-applied: ${reapplied.join(", ")}`] : []),
    ...(autoResolved.size > 0 ? [italian ? `Ricostruiti invece di unirli: ${[...autoResolved].join(", ")}` : `Rebuilt instead of merged: ${[...autoResolved].join(", ")}`] : []),
    ...(report.trace?.changed ? [italian ? `Cronologia: ${report.trace.base_events} eventi della base, poi ${report.trace.moved_events} solo di questo computer.` : `History: ${report.trace.base_events} base events, then ${report.trace.moved_events} only this computer had.`] : []),
    ...(report.trace_error ? [italian ? `Cronologia non ricostruita: ${report.trace_error} Copia di sicurezza: ${backupRoot}` : `History not rebuilt: ${report.trace_error} Backup copy: ${backupRoot}`] : []),
    ...(report.registry?.changed ? [italian ? `Registro degli output unito${added ? ` (${added} di questo computer)` : ""}.` : `Output registry merged${added ? ` (${added} from this computer)` : ""}.`] : []),
    ...(codeStash?.status === "restored" ? [italian ? `Modifiche di codice non committate riapplicate: ${plan.code_changes.join(", ")}` : `Uncommitted code changes re-applied: ${plan.code_changes.join(", ")}`] : []),
    ...(codeStash?.status === "kept" ? [italian ? `Le modifiche di codice non committate non si riapplicano senza conflitti e restano nello stash (${codeStash.error}): git stash pop, poi risolvi.` : `The uncommitted code changes do not re-apply cleanly and stay in the stash (${codeStash.error}): run git stash pop, then resolve.`] : []),
    ...(duplicates.length > 0 ? [italian ? `Copie duplicate rimosse: ${duplicates.join(", ")}` : `Duplicate copies removed: ${duplicates.join(", ")}`] : []),
    ...(conflicts.length > 0 ? [italian ? `Cambiati anche sulla base, tenuta la versione della base (la tua copia è in ${backupRoot}): ${conflicts.join(", ")}` : `Changed on the base too; the base version was kept (your copy is in ${backupRoot}): ${conflicts.join(", ")}`] : []),
    ...(rewritten && branch ? [italian ? `Il branch ${branch} è stato riscritto: pubblicalo con git push --force-with-lease origin ${branch}.` : `Branch ${branch} was rewritten: publish it with git push --force-with-lease origin ${branch}.`] : []),
  ]);
}

function manualPublishCommand(storyId) {
  return `agentic-sdlc story publish-records --id ${storyId}`;
}

/**
 * Publishes the story's .sdlc records straight to the remote base branch
 * after its merge or final gate: one commit with only those records (the
 * shared history and output registry rebuilt on the base first), authored by
 * the configured git identity, pushed on top of the base branch and rebuilt
 * once when another computer pushed first. Best effort: never throws; a
 * failure prints the manual command and asks the other computers for help.
 * Off with AGENTIC_SDLC_AUTO_PUBLISH=off.
 */
export async function autoPublishStoryRecords(context, { storyId, event, options = {}, env = process.env, stderr = (text) => process.stderr.write(text) }) {
  if (!storyId || !autoPublishEnabled(env)) return { status: "off" };
  const italian = (() => {
    try {
      return humanGuidanceLocale(options) === "it";
    } catch {
      return false;
    }
  })();
  let problem = null;
  try {
    const settings = policyOf(context);
    const git = gitRunner(context);
    const folder = sdlcFolderOf(context);
    const recordOptions = { sdlcFolder: folder, storyId, storyIds: knownStoryIds(context) };
    for (let attempt = 1; attempt <= PUBLISH_ATTEMPTS; attempt += 1) {
      const base = fetchBase(context, git, settings, `The records of ${storyId} were not published`);
      if (!base) throw new UserError(`the base branch of '${settings.remote}' is unknown`);
      const rebuilt = rebuildSharedRecords(context, { ...options, json: false }, base.ref, null, { stopOnTraceError: true });
      // Publishing without the shared history would leave events out for good: nothing is published.
      if (rebuilt.trace_error) throw new UserError(`the shared history cannot be merged onto ${base.display} (${rebuilt.trace_error}); nothing was published`);
      const appendOnly = new Set(appendOnlyRecordPaths(folder));
      const registryFile = outputRegistryRecordPath(folder);
      const candidates = [...new Set([
        ...lines(git(["diff", "--name-only", "--no-renames", "--diff-filter=AM", base.ref, "--", folder])),
        ...lines(git(["ls-files", "--others", "--exclude-standard", "--", folder])),
      ])].filter((filePath) => storyBranchRecordPath(filePath, recordOptions)).sort();
      const forkPoint = firstLine(git(["merge-base", "HEAD", base.ref]).stdout) || null;
      const publish = [];
      const skipped = [];
      for (const filePath of candidates) {
        if (appendOnly.has(filePath)) {
          publish.push(filePath);
          continue;
        }
        if (filePath === registryFile) {
          publish.push(filePath);
          continue;
        }
        const onBase = blobId(git, base.ref, filePath);
        if (onBase && onBase === workingBlobId(git, context.root, filePath)) continue;
        if (onBase && onBase !== blobId(git, forkPoint, filePath)) skipped.push(filePath);
        else publish.push(filePath);
      }
      if (publish.length === 0) {
        stderr(`agentic-sdlc: ${italian ? `i record di ${storyId} sono già su ${base.display}.` : `the records of ${storyId} are already on ${base.display}.`}\n`);
        return { status: "nothing_to_publish", skipped };
      }
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-sdlc-publish-"));
      const indexEnv = { GIT_INDEX_FILE: path.join(scratch, "index") };
      let commit;
      try {
        const step = (args, label) => {
          const result = git(args, { env: indexEnv });
          if (!result.ok) throw new UserError(`${label} failed (${firstLine(result.stderr)})`);
          return firstLine(result.stdout);
        };
        step(["read-tree", base.ref], "reading the base branch");
        for (const filePath of publish) {
          const blob = step(["hash-object", "-w", "--", filePath], `storing ${filePath}`);
          step(["update-index", "--add", "--cacheinfo", `100644,${blob},${filePath}`], `adding ${filePath}`);
        }
        const tree = step(["write-tree"], "writing the tree");
        if (tree === firstLine(git(["rev-parse", `${base.ref}^{tree}`]).stdout)) {
          stderr(`agentic-sdlc: ${italian ? `i record di ${storyId} sono già su ${base.display}.` : `the records of ${storyId} are already on ${base.display}.`}\n`);
          return { status: "nothing_to_publish", skipped };
        }
        commit = step(["commit-tree", tree, "-p", base.ref, "-m", `sdlc: record di ${storyId} (${event})`], "creating the commit");
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
      }
      const pushed = git(["push", "--quiet", settings.remote, `${commit}:refs/heads/${base.branch}`], { timeoutSeconds: NETWORK_TIMEOUT_SECONDS });
      if (pushed.ok) {
        stderr(`agentic-sdlc: ${italian
          ? `${publish.length} record di ${storyId} pubblicati su ${base.display} (${commit.slice(0, 12)}).`
          : `${publish.length} record(s) of ${storyId} published to ${base.display} (${commit.slice(0, 12)}).`}${skipped.length > 0
          ? (italian ? ` Non pubblicati, cambiati anche sulla base: ${skipped.join(", ")}.` : ` Not published, the base changed them too: ${skipped.join(", ")}.`)
          : ""}\n`);
        await sendAutoAlert(context.root, {
          key: `autopublish:${storyId}:${event}`,
          story: storyId,
          kind: "info",
          text: `records of ${storyId} published to ${base.display} after ${event}: pull ${base.branch} to see them.`,
        }, { env, stderr }).catch(() => null);
        return { status: "published", commit, published: publish, skipped, attempt };
      }
      problem = `'${settings.remote}' refused the push to ${base.branch} (${firstLine(pushed.stderr) || "git push failed"})`;
      // Another computer pushed first: fetch again and rebuild on top once.
    }
  } catch (error) {
    if (!(error instanceof UserError)) problem = `unexpected error: ${error?.message ?? error}`;
    else problem = error.message;
  }
  const manual = manualPublishCommand(storyId);
  stderr(`agentic-sdlc: ${italian
    ? `pubblicazione automatica dei record di ${storyId} non riuscita: ${problem}. Esegui a mano: ${manual}`
    : `automatic publication of the records of ${storyId} failed: ${problem}. Run by hand: ${manual}`} (${AUTO_PUBLISH_ENV}=off disables it)\n`);
  await sendAutoAlert(context.root, {
    key: `autopublish-failed:${storyId}:${event}`,
    story: storyId,
    kind: "question",
    text: `need help: automatic publication of the records of ${storyId} after ${event} failed (${problem}); reply with --kind answer --reply-to <id>`,
    next: manual,
  }, { env, stderr }).catch(() => null);
  return { status: "failed", problem, manual_command: manual };
}
