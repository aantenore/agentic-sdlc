// `story close`: everything a merged story still needs, in one step.
//
// One check of the git state and one fetch of the remote are shared by all
// phases (each phase skips its own fetch through SHARED_FETCH_ENV). Every phase
// is the existing command, run as its own process, so its rules and records
// stay exactly the ones of the single command. The run stops at the first
// block with that command's message and remembers what it finished in
// <git-common-dir>/agentic-sdlc/close/<story>.json: running it again resumes
// from there. Phases tied to the base branch (sync, gate, publication) run
// again when the base branch moved since they passed.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { failWithCode } from "../cli/user-error.mjs";
import { normalizeId, requireOption } from "../lifecycle/common.mjs";
import { EXIT_CODES } from "../lifecycle/constants.mjs";
import { humanGuidanceLocale } from "../lifecycle/guidance.mjs";
import { sendAutoAlert } from "../messaging/auto.mjs";
import { childProcess, Date, fs, process } from "../runtime/host.mjs";
import { orchestrationPolicy } from "../story-claim-shared-state.mjs";
import { AUTO_PUBLISH_ENV } from "../story-sync-plan.mjs";
import { remoteBaseRef } from "./merge-drift.mjs";
import { ensureInitialized } from "./migration.mjs";
import { output } from "./output.mjs";
import { SHARED_FETCH_ENV } from "./shared-fetch.mjs";
import { mergeReceiptEvidence } from "./merge-receipts.mjs";
import { readStory, storyBackfillPlan, storyDeliveryFinished } from "./story.mjs";
import { storyWorkflowDefinitionChoice } from "./workflow.mjs";
import { firstLine, runGit } from "./shared-refs.mjs";

const CLI_ENTRY = fileURLToPath(new URL("../../bin/agentic-sdlc.mjs", import.meta.url));
const STATE_SCHEMA = "story-close-state:v1";
const PHASE_TIMEOUT_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_SECONDS = 120;
export const AUTO_CLOSE_ENV = "AGENTIC_SDLC_AUTO_CLOSE";

/** Phases, in order. `base` phases run again when the base branch moved. */
export const CLOSE_PHASES = Object.freeze([
  { name: "sync", base: true },
  { name: "secret_scan", base: false },
  { name: "release_trace", base: false },
  { name: "release_steps", base: false },
  { name: "phase_backfill", base: false },
  { name: "workflow_backfill", base: false },
  { name: "claim_release", base: false },
  { name: "gate", base: true },
  { name: "publish_records", base: true },
]);

export function autoCloseEnabled(config = {}, env = process.env) {
  const value = String(env[AUTO_CLOSE_ENV] ?? "").trim().toLowerCase();
  if (["1", "true", "on", "yes"].includes(value)) return true;
  if (["0", "false", "off", "no"].includes(value)) return false;
  return config?.orchestration_policy?.auto_close === true;
}

function gitCommonDir(root) {
  const out = firstLine(runGit(root, ["rev-parse", "--git-common-dir"], { timeoutSeconds: 30 }).stdout);
  return out ? path.resolve(root, out) : null;
}

export function closeStateDir(root) {
  const common = gitCommonDir(root);
  return common ? path.join(common, "agentic-sdlc", "close") : null;
}

function readState(file, storyId) {
  try {
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    if (state?.schema === STATE_SCHEMA && state.story_id === storyId && state.phases && typeof state.phases === "object") return state;
  } catch {
    // No state yet: start from the first phase.
  }
  return { schema: STATE_SCHEMA, story_id: storyId, base_commit: null, phases: {} };
}

function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
}

/** Runs one CLI command as its own process and returns { ok, json, message }. */
export function runCliPhase(root, args, env) {
  const result = childProcess.spawnSync(process.execPath, [CLI_ENTRY, ...args, "--root", root, "--json"], {
    cwd: root,
    encoding: "utf8",
    env,
    timeout: PHASE_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  const parse = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };
  const json = parse(result.stdout);
  const errorJson = parse(result.stderr);
  const ok = result.status === 0 && !result.error;
  const findings = Array.isArray(json?.secret_scan?.findings) && json.secret_scan.findings.length > 0
    ? `${json.secret_scan.findings.length} credential match(es) in ${[...new Set(json.secret_scan.findings.map((item) => item.path))].join(", ")}; remove them, commit, rotate the credentials`
    : null;
  const blockers = Array.isArray(json?.human_blockers) ? json.human_blockers.map((item) => item?.message || item?.code || item).filter(Boolean).slice(0, 3).join("; ") : null;
  const errorText = errorJson?.error?.message || json?.error?.message || findings || blockers
    || json?.message || json?.errors?.[0]?.message || json?.errors?.[0]
    || String(result.stderr || "").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).slice(-3).join(" ")
    || result.error?.message || `exit code ${result.status}`;
  return { ok, status: result.status, json, message: ok ? null : String(typeof errorText === "string" ? errorText : JSON.stringify(errorText)) };
}

function storyFile(context, ...parts) {
  return path.join(context.sdlcRoot, ...parts);
}

function hasPassingReleaseTrace(context, storyId) {
  let text = "";
  try {
    text = fs.readFileSync(storyFile(context, "traces", `${storyId}.jsonl`), "utf8");
  } catch {
    return false;
  }
  return text.split(/\r?\n/u).some((line) => {
    if (!line.includes("\"release\"")) return false;
    try {
      const event = JSON.parse(line);
      return event.type === "release" && event.outcome === "passed";
    } catch {
      return false;
    }
  });
}

/** Evidence of the release: the files passed with --evidence, else the merge receipt and its evidence. */
function releaseEvidence(context, storyId, options) {
  const given = [options.evidence].flat().filter((item) => typeof item === "string" && item);
  if (given.length > 0) return given;
  return mergeReceiptEvidence(context, storyId)?.evidence || [];
}

function stepDone(context, storyId, step) {
  return fs.existsSync(storyFile(context, "stories", storyId, "steps", `${step}.json`));
}

const NO_CLAIM = /no (?:active )?claim|not claimed|is not claimed|already released|nessun claim|non .*assegnat/iu;


/** The story-bound workflow instances of a story: [{ id, instance, state }]. */
function storyWorkflowInstances(context, storyId) {
  const root = path.join(context.sdlcRoot, "workflows", "instances");
  let names = [];
  try {
    names = fs.readdirSync(root).filter((name) => !name.startsWith("."));
  } catch {
    return [];
  }
  const found = [];
  for (const name of names) {
    try {
      const instance = JSON.parse(fs.readFileSync(path.join(root, name, "instance.json"), "utf8"));
      if (instance?.metadata?.governance_binding?.story_id !== storyId) continue;
      let state = instance.initial_state;
      try {
        state = JSON.parse(fs.readFileSync(path.join(root, name, "checkpoint.json"), "utf8")).current_state || state;
      } catch {
        // No checkpoint yet: the run is at its initial state.
      }
      found.push({ id: name, instance, state });
    } catch {
      // Unreadable instances are not this story's run.
    }
  }
  return found;
}

/**
 * A delivered story without a story-bound workflow (started too late, after
 * task start) gets one recorded after the fact: started with --backfill and
 * the reason, then moved through the phases its records already completed.
 * A run started before task start, or a story whose delivery is not
 * finished, is left to the gate as it is.
 */
function workflowBackfillPhase(context, storyId, run) {
  const instances = storyWorkflowInstances(context, storyId);
  const preTask = instances.filter((entry) => !entry.instance.metadata?.backfill);
  if (preTask.length > 0) return { ok: true, already: true };
  let current = instances.find((entry) => entry.instance.metadata?.backfill) || null;
  if (!current) {
    if (!storyDeliveryFinished(context, readStory(context, storyId))) return { ok: true, already: true };
    const definition = storyWorkflowDefinitionChoice(context);
    if (!definition) {
      return { ok: false, message: `${storyId} has no story-bound workflow and no workflow definition matches the configured phases; start one by hand with workflow instance start --backfill` };
    }
    const id = `DELIVERY-${storyId}`;
    const started = run([
      "workflow", "instance", "start", "--id", id,
      "--definition", definition.id, "--definition-version", definition.version,
      "--story", storyId, "--backfill",
      "--reason", `Delivery of ${storyId} finished without a story-bound workflow started before task start; recorded by story close from the merged delivery`,
    ]);
    if (!started.ok) return started;
    current = storyWorkflowInstances(context, storyId).find((entry) => entry.id === id);
    if (!current) return { ok: false, message: `workflow instance ${id} was not recorded` };
  }
  const phases = Array.isArray(context.config?.phase_order) ? context.config.phase_order : [];
  let index = phases.indexOf(current.state);
  if (index < 0) return { ok: false, message: `workflow instance ${current.id} is in '${current.state}', not a configured phase` };
  for (; index < phases.length - 1; index += 1) {
    const to = phases[index + 1];
    const transition = (suffix = "") => run([
      "workflow", "instance", "transition", "--id", current.id, "--to", to,
      "--request-id", `${current.id}-backfill-${phases[index]}-to-${to}${suffix}`,
    ]);
    let result = transition();
    if (!result.ok && /strict gate/iu.test(result.message || "")) {
      // The intermediate strict gate must be bound to this run: seal it now,
      // with a secret scan of the current head when the gate asks for one.
      if (/secret scan/iu.test(result.message || "")) {
        const scan = run(["secret", "scan", "--story", storyId]);
        if (!scan.ok) return scan;
      }
      const gate = run(["gate", "check", "--strict", "--story", storyId]);
      if (!gate.ok) return gate;
      result = transition("-after-gate");
    }
    if (!result.ok) return result;
  }
  return { ok: true, already: false };
}

/** What each phase runs; returns { status, message?, detail? }. */
function phaseRunners(context, storyId, options, run) {
  const authorization = [...(typeof options.authorization === "string" && options.authorization ? ["--authorization", options.authorization] : [])];
  if (options["allow-unapproved-contract-output"] === true) authorization.push("--allow-unapproved-contract-output");
  const agent = typeof options.agent === "string" && options.agent ? options.agent : null;
  return {
    sync: () => run(["story", "sync", "--id", storyId]),
    secret_scan: () => run(["secret", "scan", "--story", storyId, ...(options.full === true ? [] : ["--incremental"])]),
    release_trace: () => {
      if (hasPassingReleaseTrace(context, storyId)) return { ok: true, already: true };
      const evidence = releaseEvidence(context, storyId, options);
      if (evidence.length === 0) {
        return {
          ok: false,
          message: `${storyId} has no passing release trace and no pull_request.merge receipt to prove it: pass the file that proves the release, story close --id ${storyId} --evidence <path>`,
        };
      }
      return run([
        "trace", "append", "--story", storyId, "--type", "release", "--outcome", "passed",
        "--summary", `Release of ${storyId} confirmed by the merge of its delivery`,
        ...evidence.flatMap((item) => ["--evidence", item]),
      ]);
    },
    release_steps: () => {
      let ran = false;
      // The same evidence that proves the release trace (the merge receipt of the
      // story's delivery, or --evidence) completes the steps through the governed command.
      const evidence = releaseEvidence(context, storyId, options);
      for (const step of ["release", "operations"]) {
        if (stepDone(context, storyId, step)) continue;
        ran = true;
        const result = run([
          "story", "complete-step", "--id", storyId, "--step", step,
          "--summary", `${step} completed after the merge of ${storyId}`,
          ...evidence.flatMap((item) => ["--evidence", item]),
          ...authorization,
        ]);
        if (!result.ok) {
          return {
            ...result,
            message: `${result.message} (the governed chain does not allow completing the ${step} step yet: `
              + `complete it by hand, for example agentic-sdlc story complete-step --id ${storyId} --step ${step} --authorization <id>, then run story close again)`,
          };
        }
      }
      return { ok: true, already: !ran };
    },
    // Phases whose work was done (commits, tests, strict gate) but never
    // recorded: complete them retroactively with their evidence, or stop and
    // name the evidence that is missing.
    phase_backfill: () => {
      const plan = storyBackfillPlan(context, storyId);
      if (plan.missing.length > 0) {
        return {
          ok: false,
          message: `${storyId} has skipped phases without evidence: `
            + plan.missing.map((entry) => `${entry.phase} (needed: ${entry.need})`).join("; ")
            + `; record the evidence or complete the phase by hand, then run story close again`,
        };
      }
      const backfilled = [];
      for (const candidate of plan.candidates) {
        const result = run([
          "story", "complete-step", "--id", storyId, "--step", candidate.phase, "--backfill",
          "--summary", `${candidate.phase} completata a posteriori da story close`,
          "--reason", `Phase ${candidate.phase} was not recorded when its work was done; completed by story close from ${candidate.evidence_refs.length} trace evidence ref(s)`,
          ...authorization,
        ]);
        if (!result.ok) return { ...result, backfilled };
        backfilled.push({ phase: candidate.phase, effective_at: candidate.effective_at });
      }
      return { ok: true, already: backfilled.length === 0, backfilled };
    },
    workflow_backfill: () => workflowBackfillPhase(context, storyId, run),
    claim_release: () => {
      const result = run([
        "story", "release", "--id", storyId,
        ...(agent ? ["--agent", agent] : []),
        "--reason", "Release the completed lane before final certification (story close).",
      ]);
      return !result.ok && NO_CLAIM.test(result.message || "") ? { ok: true, already: true } : result;
    },
    gate: () => run(["gate", "check", "--strict", "--story", storyId, "--lifecycle-complete"]),
    publish_records: () => run(["story", "publish-records", "--id", storyId, "--to-base"]),
  };
}

/**
 * The single shared check: no rebase or merge in progress, one fetch, the
 * current base commit. Throws a UserError on a block.
 */
function preflight(context, storyId, settings, { fetch = true } = {}) {
  const git = (args, timeoutSeconds = 60) => runGit(context.root, args, { timeoutSeconds });
  if (!git(["rev-parse", "--is-inside-work-tree"]).ok) {
    failWithCode("STORY_CLOSE_NOT_GIT", `Story ${storyId} was not closed: ${context.root} is not a git checkout.`);
  }
  for (const marker of ["rebase-merge", "rebase-apply", "MERGE_HEAD"]) {
    const markerPath = firstLine(git(["rev-parse", "--git-path", marker]).stdout);
    if (markerPath && fs.existsSync(path.resolve(context.root, markerPath))) {
      failWithCode("STORY_CLOSE_OPERATION_IN_PROGRESS", `Story ${storyId} was not closed: a git ${marker.startsWith("rebase") ? "rebase" : "merge"} is in progress; finish or abort it, then run story close again.`);
    }
  }
  const remote = settings.coordination.remote;
  if (fetch) {
    const fetched = git(["fetch", "--quiet", "--no-tags", remote], FETCH_TIMEOUT_SECONDS);
    if (!fetched.ok) {
      failWithCode("STORY_CLOSE_REMOTE_UNAVAILABLE", `Story ${storyId} was not closed: the git remote '${remote}' cannot be reached (${firstLine(fetched.stderr) || "git fetch failed"}). Nothing changed; run story close again when it is reachable.`);
    }
  }
  const base = remoteBaseRef(context, remote, settings.merge_drift.base_branch, 60);
  const baseCommit = base ? firstLine(git(["rev-parse", "--verify", "--quiet", `${base.ref}^{commit}`]).stdout) || null : null;
  return { remote, base, baseCommit };
}

export async function closeStory(context, options, { runPhase = null, env = process.env, clock = () => Date.now() } = {}) {
  ensureInitialized(context);
  const storyId = normalizeId(requireOption(options, "id"));
  if (!fs.existsSync(storyFile(context, "stories", storyId))) {
    failWithCode("STORY_CLOSE_UNKNOWN_STORY", `Story ${storyId} does not exist.`);
  }
  const italian = humanGuidanceLocale(options) === "it";
  const started = clock();
  const settings = orchestrationPolicy(context.config);
  const check = preflight(context, storyId, settings, { fetch: options["no-fetch"] !== true });
  const preflightMs = clock() - started;
  const stateDir = closeStateDir(context.root);
  const stateFile = path.join(stateDir, `${storyId}.json`);
  const state = readState(stateFile, storyId);
  const baseMoved = Boolean(state.base_commit && check.baseCommit && state.base_commit !== check.baseCommit);
  if (baseMoved) {
    for (const phase of CLOSE_PHASES) if (phase.base) delete state.phases[phase.name];
  }
  if (options.restart === true) state.phases = {};
  state.base_commit = check.baseCommit;
  const childEnv = {
    ...env,
    [SHARED_FETCH_ENV]: [env[SHARED_FETCH_ENV], check.remote].filter(Boolean).join(","),
    // Publication is its own phase: the gate does not publish on its own.
    [AUTO_PUBLISH_ENV]: "off",
  };
  const run = runPhase ? (args) => runPhase(args, childEnv) : (args) => runCliPhase(context.root, args, childEnv);
  const runners = phaseRunners(context, storyId, options, run);
  const phases = [];
  let blocked = null;
  for (const phase of CLOSE_PHASES) {
    if (blocked) {
      phases.push({ name: phase.name, status: "not_run", duration_ms: 0 });
      continue;
    }
    if (state.phases[phase.name]?.status === "done") {
      phases.push({ name: phase.name, status: "resumed_done", duration_ms: 0, done_at: state.phases[phase.name].at });
      continue;
    }
    const phaseStart = clock();
    let result;
    try {
      result = runners[phase.name]();
    } catch (error) {
      result = { ok: false, message: error?.message || String(error) };
    }
    const duration = clock() - phaseStart;
    if (result.ok) {
      state.phases[phase.name] = { status: "done", at: new Date().toISOString(), duration_ms: duration };
      phases.push({
        name: phase.name,
        status: result.already ? "already_done" : "done",
        duration_ms: duration,
        ...(result.backfilled?.length ? { backfilled: result.backfilled } : {}),
      });
    } else {
      blocked = { phase: phase.name, message: result.message };
      state.phases[phase.name] = { status: "blocked", at: new Date().toISOString(), message: result.message };
      phases.push({ name: phase.name, status: "blocked", duration_ms: duration, message: result.message });
    }
    writeState(stateFile, state);
  }
  const totalMs = clock() - started;
  const payload = {
    schema_version: "story-close:v1",
    story_id: storyId,
    status: blocked ? "blocked" : "closed",
    base_commit: check.baseCommit,
    base_moved: baseMoved,
    preflight_ms: preflightMs,
    total_ms: totalMs,
    phases,
    backfilled_phases: phases.flatMap((phase) => phase.backfilled || []),
    blocked_phase: blocked?.phase ?? null,
    message: blocked?.message ?? null,
    state_file: stateFile,
  };
  const label = (phase) => `${phase.name}: ${phase.status}${phase.duration_ms ? ` (${(phase.duration_ms / 1000).toFixed(1)} s)` : ""}`
    + (phase.backfilled ? ` - ${italian ? "completate a posteriori" : "completed retroactively"}: ${phase.backfilled.map((entry) => entry.phase).join(", ")}` : "");
  output(options, payload, [
    blocked
      ? (italian
        ? `${storyId}: chiusura fermata alla fase ${blocked.phase}: ${blocked.message}. Risolvi e rilancia story close --id ${storyId}: riprende da qui.`
        : `${storyId}: close stopped at ${blocked.phase}: ${blocked.message}. Fix it and run story close --id ${storyId} again: it resumes from there.`)
      : (italian ? `${storyId}: chiusa in ${(totalMs / 1000).toFixed(1)} s.` : `${storyId}: closed in ${(totalMs / 1000).toFixed(1)} s.`),
    ...phases.map(label),
  ]);
  if (options.notify === true) {
    await sendAutoAlert(context.root, {
      key: `story-close:${storyId}:${payload.status}:${blocked?.phase ?? ""}`,
      story: storyId,
      kind: blocked ? "question" : "info",
      text: blocked
        ? `automatic close of ${storyId} stopped at ${blocked.phase}: ${String(blocked.message).slice(0, 300)}`
        : `${storyId} closed after its merge in ${(totalMs / 1000).toFixed(0)} s (sync, secret scan, release, gate, records published).`,
      ...(blocked ? { next: `agentic-sdlc story close --id ${storyId}` } : {}),
    }, { env, stderr: (text) => process.stderr.write(text) }).catch(() => null);
  }
  if (blocked) process.exitCode = EXIT_CODES.userError;
  return payload;
}

/**
 * After a passed pull_request.merge with auto close on: run story close in
 * the background, detached, logging to <git-common-dir>/agentic-sdlc/close/<story>.log.
 * Best effort; returns { started, log } or { started: false, reason }.
 */
export function startBackgroundClose(context, storyId, { env = process.env } = {}) {
  try {
    const dir = closeStateDir(context.root);
    if (!dir) return { started: false, reason: "not a git checkout" };
    fs.mkdirSync(dir, { recursive: true });
    const log = path.join(dir, `${storyId}.log`);
    const fd = fs.openSync(log, "a");
    fs.writeSync(fd, `\n# ${new Date().toISOString()} story close --id ${storyId} (automatic after merge)\n`);
    const child = childProcess.spawn(process.execPath, [CLI_ENTRY, "story", "close", "--id", storyId, "--root", context.root, "--notify", "--json"], {
      cwd: context.root,
      env: { ...env, [AUTO_CLOSE_ENV]: "0" },
      detached: true,
      stdio: ["ignore", fd, fd],
      windowsHide: true,
    });
    child.unref();
    fs.closeSync(fd);
    return { started: true, log, pid: child.pid };
  } catch (error) {
    return { started: false, reason: error?.message || String(error) };
  }
}
