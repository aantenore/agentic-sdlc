// One project history across computers. Every computer appends to the same
// hash-chained history files under .sdlc/traces, so two clones that both
// recorded events fork the chain, and a git merge of the two files no longer
// verifies. `trace rebase` moves this clone's own events after another
// branch's history (their original fingerprints stay verifiable), and status
// and doctor warn before publishing while the fork exists.

import path from "node:path";
import { fail, UserError } from "../cli/user-error.mjs";
import { humanGuidanceLocale } from "../lifecycle/guidance.mjs";
import { childProcess, fs, process } from "../runtime/host.mjs";
import { orchestrationPolicy } from "../story-claim-shared-state.mjs";
import {
  compareTraceHistories,
  rebaseTraceIntegrity,
  TraceIntegrityError,
} from "../trace-integrity.mjs";
import { mergeOutputRegistries } from "../output-registry-merge.mjs";
import { remoteBaseRef } from "./merge-drift.mjs";
import { ensureInitialized } from "./migration.mjs";
import { output, outputRegistryPath, writeOutputRegistry } from "./output.mjs";
import { traceIntegrityOptions } from "./story.mjs";

const DEFAULT_TRACE_FILE = "project.jsonl";
const TRACE_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.jsonl$/u;
const GIT_TIMEOUT_SECONDS = 30;
// Above the verification read limit of a history file, with room for a checkpoint.
const GIT_MAX_BUFFER = 80 * 1024 * 1024;

function projectRelative(context, filePath) {
  return path.relative(context.root, filePath).split(path.sep).join("/");
}

function historyPaths(context, file) {
  const tracePath = path.join(context.sdlcRoot, "traces", file);
  const checkpointPath = path.join(context.sdlcRoot, "traces", ".integrity", `${file}.checkpoint.json`);
  return {
    tracePath,
    checkpointPath,
    trace: projectRelative(context, tracePath),
    checkpoint: projectRelative(context, checkpointPath),
  };
}

function git(context, args, { buffer = false, timeoutSeconds = GIT_TIMEOUT_SECONDS } = {}) {
  const result = childProcess.spawnSync("git", ["-C", context.root, ...args], {
    encoding: buffer ? "buffer" : "utf8",
    timeout: timeoutSeconds * 1000,
    maxBuffer: GIT_MAX_BUFFER,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", LANG: "C", LANGUAGE: "C" },
    windowsHide: true,
  });
  return {
    ok: result.status === 0 && !result.error,
    stdout: result.stdout,
    stderr: String(result.stderr || ""),
  };
}

function resolveCommit(context, ref) {
  const resolved = git(context, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
  return resolved.ok ? String(resolved.stdout).trim() : null;
}

/** The bytes of one file at a commit, or null when the commit lacks it. */
function fileAtCommit(context, commit, relativePath) {
  const listed = git(context, ["ls-tree", "--name-only", commit, "--", relativePath]);
  if (!listed.ok || String(listed.stdout).trim() !== relativePath) return null;
  const shown = git(context, ["cat-file", "blob", `${commit}:${relativePath}`], { buffer: true });
  if (!shown.ok) fail(`Cannot read ${relativePath} at ${commit.slice(0, 12)}: ${shown.stderr.trim() || "git failed"}`);
  return Buffer.from(shown.stdout);
}

function parseCheckpoint(bytes, label) {
  if (bytes === null) return null;
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(`The ${label} history checkpoint is not valid JSON; resolve it before rebasing.`);
  }
  return null;
}

function readableHistory(bytes) {
  try {
    compareTraceHistories(bytes, Buffer.alloc(0));
    return true;
  } catch (error) {
    if (error instanceof TraceIntegrityError) return false;
    throw error;
  }
}

function traceFileOption(options) {
  const file = options.file ?? DEFAULT_TRACE_FILE;
  if (typeof file !== "string" || !TRACE_FILE_PATTERN.test(file)) {
    fail("--file must name one history file in .sdlc/traces, for example project.jsonl.");
  }
  return file;
}

function parseJsonOrNull(bytes) {
  if (bytes === null) return null;
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * The output registry merged by entry id onto <ref>'s (see
 * lib/output-registry-merge.mjs), or null when either side has none. This
 * clone's side is the working copy, or HEAD while it holds an unresolved merge.
 * Fails on entries both sides changed, before anything is written.
 */
function planRegistryMerge(context, onto, ontoCommit) {
  const registryPath = outputRegistryPath(context);
  const relative = projectRelative(context, registryPath);
  const remote = parseJsonOrNull(fileAtCommit(context, ontoCommit, relative));
  if (!remote) return null;
  let local = fs.existsSync(registryPath) ? parseJsonOrNull(fs.readFileSync(registryPath)) : null;
  const head = resolveCommit(context, "HEAD");
  if (!local && head) local = parseJsonOrNull(fileAtCommit(context, head, relative));
  if (!local) return null;
  const mergeBase = head ? git(context, ["merge-base", head, ontoCommit]) : null;
  const baseCommit = mergeBase?.ok ? String(mergeBase.stdout).trim() : null;
  const base = baseCommit ? parseJsonOrNull(fileAtCommit(context, baseCommit, relative)) : null;
  const merged = mergeOutputRegistries({ base, local, remote });
  if (merged.conflicts.length > 0) {
    fail(`${relative} has entries changed differently here and on ${onto}: ${merged.conflicts.join(", ")}; resolve them by hand, then run trace rebase again.`);
  }
  return { file: relative, changed: merged.changed, registry: merged.registry };
}

/**
 * trace rebase --onto <ref> [--file <name>] [--apply]: plan (default) or
 * write this clone's history as <ref>'s history followed by the events only
 * this clone has. When the working copy is not readable (an unresolved merge),
 * this clone's side is read from HEAD.
 */
export function rebaseTraceHistory(context, options) {
  ensureInitialized(context);
  const italian = humanGuidanceLocale(options) === "it";
  const onto = options.onto;
  if (typeof onto !== "string" || !onto.trim() || onto.startsWith("-")) {
    fail("trace rebase needs --onto <remote>/<branch>, for example --onto origin/main.");
  }
  const file = traceFileOption(options);
  const paths = historyPaths(context, file);
  const ontoCommit = resolveCommit(context, onto);
  if (!ontoCommit) fail(`${onto} is not a commit in this clone; fetch it first (git fetch).`);
  const remoteTrace = fileAtCommit(context, ontoCommit, paths.trace);
  const remoteCheckpointBytes = fileAtCommit(context, ontoCommit, paths.checkpoint);
  if (remoteTrace === null && remoteCheckpointBytes !== null) {
    fail(`${onto} has a checkpoint for ${paths.trace} but not the history itself.`);
  }

  let localSource = "working_tree";
  let localTrace = fs.existsSync(paths.tracePath) ? fs.readFileSync(paths.tracePath) : Buffer.alloc(0);
  if (!readableHistory(localTrace)) {
    const head = resolveCommit(context, "HEAD");
    const headTrace = head ? fileAtCommit(context, head, paths.trace) : null;
    if (headTrace === null || !readableHistory(headTrace)) {
      fail(`${paths.trace} is not readable here or at HEAD; restore it before rebasing.`);
    }
    localSource = "HEAD";
    localTrace = headTrace;
  }

  const registryMerge = planRegistryMerge(context, onto, ontoCommit);
  let result;
  try {
    result = rebaseTraceIntegrity(traceIntegrityOptions(context, paths.tracePath), {
      localTraceBytes: localTrace,
      remoteTraceBytes: remoteTrace ?? Buffer.alloc(0),
      remoteCheckpoint: parseCheckpoint(remoteCheckpointBytes, onto),
      apply: options.apply === true,
    });
  } catch (error) {
    if (error instanceof TraceIntegrityError) fail(`${error.message} (${error.code}).`);
    throw error;
  }
  const payload = {
    schema_version: "trace-rebase:v1",
    file: paths.trace,
    checkpoint: paths.checkpoint,
    onto,
    onto_commit: ontoCommit,
    local_source: localSource,
    applied: result.applied,
    changed: result.changed,
    base_events: result.base_events,
    moved_events: result.moved_events,
    already_present: result.already_present,
    event_count: result.event_count,
    output_registry: registryMerge
      ? { file: registryMerge.file, changed: registryMerge.changed, applied: options.apply === true && registryMerge.changed }
      : null,
  };
  if (registryMerge?.changed && options.apply === true) writeOutputRegistry(context, registryMerge.registry);
  const action = !result.changed
    ? (italian ? "La cronologia è già allineata: nessuna modifica." : "The history already matches: nothing to change.")
    : result.applied
      ? (italian
        ? `Cronologia riscritta: ${result.base_events} eventi di ${onto}, poi ${result.moved_events} eventi solo di questo computer, risigillati con l’impronta originale.`
        : `History rewritten: ${result.base_events} events from ${onto}, then ${result.moved_events} events only this computer had, sealed again with their original fingerprints.`)
      : (italian
        ? `Piano: ${result.base_events} eventi di ${onto}, poi ${result.moved_events} eventi solo di questo computer. Esegui di nuovo con --apply per scrivere.`
        : `Plan: ${result.base_events} events from ${onto}, then ${result.moved_events} events only this computer has. Run again with --apply to write it.`);
  const registryLine = registryMerge?.changed
    ? [options.apply === true
      ? (italian
        ? `${registryMerge.file} unito per id con ${onto}.`
        : `${registryMerge.file} merged by entry id with ${onto}.`)
      : (italian
        ? `${registryMerge.file} va unito per id con ${onto} (con --apply).`
        : `${registryMerge.file} needs merging by entry id with ${onto} (with --apply).`)]
    : [];
  const staged = [paths.trace, paths.checkpoint, ...(registryMerge?.changed ? [registryMerge.file] : [])].join(" ");
  const next = result.applied || (registryMerge?.changed && options.apply === true)
    ? [italian
      ? `Poi: git add ${staged} e completa il commit (o il merge); agentic-sdlc trace verify deve risultare valido su entrambi i computer.`
      : `Next: git add ${staged} and finish the commit (or merge); agentic-sdlc trace verify must pass on both computers.`]
    : [];
  output(options, payload, [
    action,
    ...registryLine,
    ...(result.already_present > 0
      ? [italian
        ? `Eventi già presenti in ${onto}: ${result.already_present} (non ripetuti).`
        : `Events ${onto} already has: ${result.already_present} (not repeated).`]
      : []),
    ...(localSource === "HEAD"
      ? [italian
        ? "La copia di lavoro non era leggibile (merge non risolto): il lato di questo computer è stato letto da HEAD."
        : "The working copy was not readable (unresolved merge), so this computer's side was read from HEAD."]
      : []),
    ...next,
  ]);
}

/**
 * Read-only: whether this clone's project history has forked from the remote
 * base branch's. Null when the check is off or there is nothing to compare.
 * Returns { base, file, state, local_only, remote_only, command }.
 */
export function traceHistoryDivergence(context) {
  let policy;
  try {
    policy = orchestrationPolicy(context.config);
  } catch {
    return null;
  }
  if (policy.workflow_history.divergence === "off") return null;
  try {
    const remote = policy.coordination.remote;
    const base = remoteBaseRef(context, remote, policy.merge_drift.base_branch, policy.coordination.timeout_seconds);
    // Without a recorded remote default branch, the current branch's upstream.
    const upstream = base ? null : git(context, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
    const display = base ? `${remote}/${base.branch}` : upstream?.ok ? String(upstream.stdout).trim() : null;
    if (!display) return null;
    const paths = historyPaths(context, DEFAULT_TRACE_FILE);
    if (!fs.existsSync(paths.tracePath)) return null;
    const commit = resolveCommit(context, base ? base.ref : display);
    const remoteTrace = commit ? fileAtCommit(context, commit, paths.trace) : null;
    if (remoteTrace === null) return null;
    const comparison = compareTraceHistories(fs.readFileSync(paths.tracePath), remoteTrace);
    return {
      base: display,
      file: paths.trace,
      state: comparison.state,
      local_only: comparison.local_only,
      remote_only: comparison.remote_only,
      command: `trace rebase --onto ${display} --apply`,
    };
  } catch (error) {
    if (error instanceof TraceIntegrityError || error instanceof UserError) {
      return { base: null, file: null, state: "unreadable", local_only: null, remote_only: null, command: null, error: error.message };
    }
    throw error;
  }
}

/** Status lines for a forked history (none when the history has not forked). */
export function traceDivergenceLines(divergence, { italian = false } = {}) {
  if (!divergence || divergence.state !== "diverged") return [];
  return [italian
    ? `Cronologia di progetto biforcata rispetto a ${divergence.base}: ${divergence.local_only} eventi solo qui, ${divergence.remote_only} solo su ${divergence.base}. Prima di pubblicare esegui agentic-sdlc ${divergence.command}`
    : `Project history forked from ${divergence.base}: ${divergence.local_only} event(s) only here, ${divergence.remote_only} only on ${divergence.base}. Before publishing run agentic-sdlc ${divergence.command}`];
}
