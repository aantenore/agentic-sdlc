import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeStableHash } from "../canonical.mjs";
import { fail } from "../cli/user-error.mjs";
import { getOptionString, normalizeId, requireOption } from "../lifecycle/common.mjs";
import { humanGuidanceLocale } from "../lifecycle/guidance.mjs";
import { toProjectPath } from "../lifecycle/project.mjs";
import { sendAutoAlert } from "../messaging/auto.mjs";
import { childProcess, fs, process } from "../runtime/host.mjs";
import { buildAttribution, assertRecordSchema, readTestRunRecords, uniqueRecordSuffix } from "./common.mjs";
import { buildTraceAuthorityMetadata } from "./authorization.mjs";
import { ensureInitialized } from "./migration.mjs";
import { output } from "./output.mjs";
import { readProjectJson, safeReadDir, writeJsonFile } from "./storage.mjs";
import { appendTraceEvent, readStory } from "./story.mjs";
import { autoPublishStoryRecords } from "./story-sync.mjs";

/**
 * Test triage. A test case that fails must not be forgotten: each failed or
 * failed-minor case of a story gets a decision (fixable, not-fixable,
 * by-design) and a fixable one can open a fix story, free for any computer,
 * whose acceptance criterion is that the case passes again. The strict gate
 * refuses a story with undecided failures, and a fix story closes only when
 * its case passed after the fix was decided.
 */

const CLI_ENTRY = fileURLToPath(new URL("../../bin/agentic-sdlc.mjs", import.meta.url));
const STEP_TIMEOUT_MS = 120000;
const FAILING = new Set(["failed", "failed-minor"]);
export const TRIAGE_DECISIONS = Object.freeze(["fixable", "not-fixable", "by-design"]);
const PRIORITIES = Object.freeze(["P1", "P2", "P3"]);

export function testTriageRoot(context) {
  return path.join(context.sdlcRoot, "test-triage");
}

export function readTriageRecords(context, storyId = null) {
  const records = [];
  for (const name of safeReadDir(testTriageRoot(context))) {
    if (!name.endsWith(".json")) continue;
    const recordPath = path.join(testTriageRoot(context), name);
    let record;
    try {
      record = readProjectJson(context, recordPath);
    } catch {
      continue;
    }
    if (record?.kind !== "test_triage") continue;
    if (storyId && record.story_id !== storyId) continue;
    records.push({ path: toProjectPath(context, recordPath), record });
  }
  return records.sort((left, right) => String(left.record.created_at).localeCompare(String(right.record.created_at), "en"));
}

/** The latest run of every case of the story, in recording order. */
function latestRunPerCase(context, storyId) {
  const latest = new Map();
  for (const entry of readTestRunRecords(context, storyId)) {
    if (entry.record.case_id) latest.set(entry.record.case_id, entry);
  }
  return [...latest.values()];
}

/** Failed or failed-minor cases (their latest run) with no decision on that run yet. */
export function pendingFailures(context, storyId, { runId = null } = {}) {
  const decided = new Set(readTriageRecords(context, storyId).map(({ record }) => `${record.case_id}|${record.run_id}`));
  const runs = runId
    ? readTestRunRecords(context, storyId).filter(({ record }) => record.id === runId && record.case_id)
    : latestRunPerCase(context, storyId);
  return runs.filter(({ record }) => FAILING.has(record.outcome) && !decided.has(`${record.case_id}|${record.id}`));
}

function triageCommand(storyId) {
  return `agentic-sdlc test triage --story ${storyId}`;
}

/**
 * Strict-gate check. The story's failed cases need a decision; a fix story
 * opened from a case needs that case to have passed after the decision.
 */
export function validateTestTriageEvidence(context, storyId, report) {
  const pending = pendingFailures(context, storyId);
  if (pending.length > 0) {
    report.errors.push(
      `Story ${storyId} has failed test cases without a triage decision: `
      + `${pending.map(({ record }) => `${record.case_id} (${record.outcome}, run ${record.id})`).join(", ")}; `
      + `decide each with '${triageCommand(storyId)} --case <case-id> --decision <fixable|not-fixable|by-design> --reason "<why>"' `
      + `(list them with '${triageCommand(storyId)}')`,
    );
  }
  const opened = readTriageRecords(context).filter(({ record }) => record.fix_story_id === storyId && record.decision === "fixable");
  if (opened.length > 0) report.checked.push(`test triage fix evidence for story ${storyId}`);
  for (const { record } of opened) {
    const runs = [...readTestRunRecords(context, record.story_id), ...readTestRunRecords(context, storyId)];
    const passedAfter = runs.some((entry) => entry.record.case_id === record.case_id
      && entry.record.outcome === "passed"
      && String(entry.record.finished_at) >= String(record.created_at));
    if (!passedAfter) {
      report.errors.push(
        `Fix story ${storyId} cannot close: test case ${record.case_id} has not passed in a run recorded after the fix was decided (${record.created_at}); `
        + `run it and record it with 'agentic-sdlc test record --story ${record.story_id} --case ${record.case_id} ...'`,
      );
    }
  }
}

function cliJson(context, args) {
  const result = childProcess.spawnSync(
    process.execPath,
    [CLI_ENTRY, ...args, "--root", context.root, "--json"],
    { encoding: "utf8", timeout: STEP_TIMEOUT_MS, env: process.env },
  );
  if (result.status !== 0) {
    let message = null;
    for (const stream of [result.stdout, result.stderr]) {
      try {
        message = JSON.parse(stream || "").error?.message || message;
      } catch {
        // Not the JSON error envelope.
      }
    }
    fail(`${args.slice(0, 2).join(" ")} failed: ${String(message || `${result.stdout}\n${result.stderr}`.trim().split("\n").slice(-3).join(" ")).split("\n- Retry")[0]}`);
  }
  return JSON.parse(result.stdout);
}

function freeFixStoryId(context, fixesId, caseId) {
  const base = normalizeId(`${fixesId}-FIX-${caseId}`);
  let id = base;
  for (let n = 2; fs.existsSync(path.join(context.sdlcRoot, "stories", id)); n += 1) id = `${base}-${n}`;
  return id;
}

function createFixStory(context, options, { testStory, entry, fixesId, priority }) {
  const caseId = entry.record.case_id;
  const id = freeFixStoryId(context, fixesId, caseId);
  const title = `${priority ? `[${priority}] ` : ""}${getOptionString(options, "title") || `Fix ${caseId} (${testStory})`}`;
  const args = [
    "story", "create", "--id", id, "--title", title, "--fixes", fixesId,
    "--acceptance", `Il caso ${caseId} passa di nuovo`,
    "--status", "ready", "--free",
    "--origin-test-story", testStory, "--origin-case", caseId, "--origin-run", entry.record.id,
    ...(priority ? ["--priority", priority] : []),
  ];
  cliJson(context, args);
  return id;
}

function listLines(storyId, pending, italian) {
  if (pending.length === 0) return [italian ? `Nessun caso fallito senza decisione per ${storyId}.` : `No failed case without a decision for ${storyId}.`];
  return [
    italian ? `Casi falliti senza decisione per ${storyId}:` : `Failed cases without a decision for ${storyId}:`,
    ...pending.map(({ record }) => `- ${record.case_id} (${record.outcome}, run ${record.id})`),
    italian
      ? `Decidi: ${triageCommand(storyId)} --case <id> --decision <fixable|not-fixable|by-design> --reason "<perché>" [--create-fix --fixes <story-consegnata>]`
      : `Decide: ${triageCommand(storyId)} --case <id> --decision <fixable|not-fixable|by-design> --reason "<why>" [--create-fix --fixes <delivered-story>]`,
  ];
}

export async function triageTestCases(context, options) {
  ensureInitialized(context);
  const storyId = normalizeId(requireOption(options, "story"));
  if (!readStory(context, storyId)) fail(`Story ${storyId} does not exist`);
  const italian = humanGuidanceLocale(options) === "it";
  const runInput = getOptionString(options, "run");
  const runId = runInput ? normalizeId(runInput) : null;
  const pending = pendingFailures(context, storyId, { runId });
  const caseInput = getOptionString(options, "case");
  const decision = getOptionString(options, "decision");
  if (!caseInput && !decision) {
    output(options, {
      status: "pending",
      story_id: storyId,
      pending: pending.map(({ record }) => ({ case_id: record.case_id, outcome: record.outcome, run_id: record.id })),
    }, listLines(storyId, pending, italian));
    return;
  }
  if (!caseInput || !decision) fail("--case and --decision go together.");
  if (!TRIAGE_DECISIONS.includes(decision)) fail(`--decision must be one of: ${TRIAGE_DECISIONS.join(", ")}`);
  const reason = requireOption(options, "reason");
  const caseId = normalizeId(caseInput);
  const entry = pending.find(({ record }) => record.case_id === caseId);
  if (!entry) {
    fail(`Story ${storyId} has no failed or failed-minor run of case ${caseId} without a decision${runId ? ` in run ${runId}` : ""}.`);
  }
  const createFix = options["create-fix"] === true;
  if (createFix && decision !== "fixable") fail("--create-fix applies only to --decision fixable.");
  const priority = getOptionString(options, "priority") || null;
  if (priority && !PRIORITIES.includes(priority)) fail(`--priority must be one of: ${PRIORITIES.join(", ")}`);
  const fixesInput = getOptionString(options, "fixes");
  if (createFix && !fixesInput) {
    fail("--create-fix needs --fixes <story>: the story that delivered the feature (not the test story), so the fix inherits its requirements and write paths.");
  }
  if (!createFix && fixesInput) fail("--fixes is used only with --create-fix.");
  let fixStoryId = null;
  if (createFix) {
    const fixesId = normalizeId(fixesInput);
    if (fixesId === storyId) fail(`--fixes must name the story that delivered the feature, not the test story ${storyId}.`);
    if (!readStory(context, fixesId)) fail(`Story ${fixesId} does not exist; --fixes must name the delivered story.`);
    fixStoryId = createFixStory(context, options, { testStory: storyId, entry, fixesId, priority });
  }

  const attribution = buildAttribution(context, options, "test.triage");
  const createdAt = new Date().toISOString();
  const id = normalizeId(`${storyId}-triage-${caseId}-${uniqueRecordSuffix()}`);
  const record = {
    kind: "test_triage",
    schema_version: "test-triage:v1",
    id,
    story_id: storyId,
    case_id: caseId,
    run_id: entry.record.id,
    run_outcome: entry.record.outcome,
    decision,
    reason,
    fix_story_id: fixStoryId,
    priority,
    actor: attribution.actor,
    git: attribution.git,
    run: attribution.run,
    created_at: createdAt,
    audit: { created_by: attribution.actor, git: attribution.git, run: attribution.run },
    hash_algorithm: "sha256:stable-json:v1",
  };
  record.record_hash = computeStableHash(record);
  assertRecordSchema(record, "test-triage.schema.json", `Test triage ${id}`);
  const recordPath = path.join(testTriageRoot(context), `${id}.json`);
  writeJsonFile(recordPath, record);
  const projectPath = toProjectPath(context, recordPath);
  const traceEvent = appendTraceEvent(context, storyId, {
    type: "decision",
    summary: `Test case ${caseId} triaged as ${decision}: ${reason}`,
    action: "test.triage",
    actor: attribution.actor,
    ...buildTraceAuthorityMetadata(context, options, attribution),
    evidence: [projectPath],
    related: [`case:${caseId}`, ...(fixStoryId ? [fixStoryId] : [])],
    git: attribution.git,
    run: attribution.run,
  });

  let published = null;
  if (fixStoryId) {
    // Other computers see the fix story only once its records are on the base branch.
    const publishOptions = { ...options, json: false };
    published = {
      fix_story: (await autoPublishStoryRecords(context, { storyId: fixStoryId, event: "test.triage", options: publishOptions })).status,
      test_story: (await autoPublishStoryRecords(context, { storyId, event: "test.triage", options: publishOptions })).status,
    };
    await sendAutoAlert(context.root, {
      key: `triage-fix:${fixStoryId}`,
      story: fixStoryId,
      kind: "offer",
      text: `nuova story di fix libera: ${fixStoryId}${priority ? ` (${priority})` : ""}, caso ${caseId} di ${storyId}.`,
      next: `agentic-sdlc story availability --id ${fixStoryId}, then story claim --id ${fixStoryId} --agent <name>`,
    }, { stderr: (text) => process.stderr.write(text) }).catch(() => null);
  }
  output(options, {
    status: "recorded",
    triage_path: projectPath,
    triage: record,
    fix_story_id: fixStoryId,
    published,
    event: traceEvent,
  }, [
    italian ? `Caso ${caseId} di ${storyId}: ${decision}` : `Case ${caseId} of ${storyId}: ${decision}`,
    ...(fixStoryId ? [italian ? `Story di fix libera creata: ${fixStoryId}` : `Free fix story created: ${fixStoryId}`] : []),
    `Path: ${projectPath}`,
  ]);
}
