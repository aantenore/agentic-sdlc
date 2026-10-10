// workflow instance repair-traces: a workflow run keeps its transition events
// (events.jsonl, hash chained, with a durable checkpoint) next to one audit
// trace per event in the shared project history. When records are published
// from a temporary checkout the traces can be lost while the events survive.
// This command rebuilds exactly the missing traces from the verified events,
// binds them in the checkpoint, and records who repaired what.

import path from "node:path";
import { computeStableHash } from "../canonical.mjs";
import { fail } from "../cli/user-error.mjs";
import { normalizeId, requireOption } from "../lifecycle/common.mjs";
import { humanGuidanceLocale } from "../lifecycle/guidance.mjs";
import { toProjectPath } from "../lifecycle/project.mjs";
import {
  buildWorkflowTransitionTraceRecord,
  extendWorkflowTraceChain,
  workflowCheckpointPath,
  workflowEventsPath,
} from "../lifecycle/workflow.mjs";
import {
  createWorkflowCheckpoint,
  replayWorkflowEvents,
  validateWorkflowCheckpoint,
} from "../workflow-engine.mjs";
import { assertRecordSchema, buildAttribution } from "./common.mjs";
import { ensureInitialized, loadEffectiveDefinitionForInstance } from "./migration.mjs";
import { output } from "./output.mjs";
import {
  acquireFileLock,
  ensureWorkflowTraceRecordLocked,
  prepareGovernedTraceEvent,
  workflowTraceIntegritySnapshotLocked,
} from "./storage.mjs";
import {
  readCompletedWorkflowInstance,
  readWorkflowCheckpoint,
  readWorkflowEvents,
  readWorkflowPendingTransition,
  workflowTraceAnchor,
  writeWorkflowJsonDurably,
} from "./workflow.mjs";

const REPAIR_ACTION = "workflow.instance.repair-traces";
const TRANSITION_ACTION = "workflow.instance.transition";

function refuse(instanceId, reason) {
  fail(`Workflow instance ${instanceId} traces were not repaired: ${reason}`);
}

/**
 * The trace of one transition, rebuilt only from the verified event: the actor
 * is the event's, and the git/run blocks say the record was regenerated, so
 * the same event always yields the same trace.
 */
function regeneratedTransitionTrace(context, instanceId, event) {
  const record = buildWorkflowTransitionTraceRecord(
    context,
    instanceId,
    event.to,
    event,
    {
      actor: event.actor,
      git: { is_git_repo: null, branch: null, head_sha: null, regenerated: true },
      run: { tool: "agentic-sdlc-cli", regenerated: true },
    },
    `Transitioned workflow instance ${instanceId} to ${event.to} (trace regenerated from verified event ${event.event_hash.slice(0, 12)})`,
  );
  return prepareGovernedTraceEvent(context, record);
}

function isRegenerated(trace) {
  return trace?.run?.regenerated === true && trace?.git?.regenerated === true;
}

/**
 * Splits the instance's events into those whose trace is in the verified
 * project history and those without one, or reports why the history cannot be
 * repaired (a trace that is duplicated, out of order, or not about an event).
 */
function classifyTraces(instanceId, instance, events, traces) {
  const startId = `TR-WF-START-${String(instance.instance_hash || "").slice(0, 24)}`;
  const starts = traces.filter((entry) => entry?.id === startId
    || (entry?.action === "workflow.instance.start" && Array.isArray(entry?.related) && entry.related[0] === instanceId));
  if (starts.length !== 1 || starts[0].id !== startId) {
    refuse(instanceId, "its start trace is not present exactly once; only transition traces can be rebuilt.");
  }
  const expectedIds = new Set(events.map((event) => `TR-WF-${event.event_hash}`));
  const unexpected = traces.filter((entry) => entry?.action === TRANSITION_ACTION
    && Array.isArray(entry?.related) && entry.related[0] === instanceId && !expectedIds.has(entry.id));
  if (unexpected.length > 0) refuse(instanceId, "the history holds transition traces that are not in the event history.");
  const ordered = [starts[0]];
  const missing = [];
  let lastPosition = traces.indexOf(starts[0]);
  for (const event of events) {
    const id = `TR-WF-${event.event_hash}`;
    const matching = traces.filter((entry) => entry?.id === id);
    if (matching.length > 1) refuse(instanceId, `event ${event.event_hash} has more than one trace.`);
    if (matching.length === 0) {
      missing.push(event);
      continue;
    }
    const [trace] = matching;
    if (
      trace.action !== TRANSITION_ACTION
      || trace.created_at !== event.timestamp
      || !trace.related?.includes(instanceId)
      || !trace.related?.includes(event.event_hash)
    ) {
      refuse(instanceId, `the trace of event ${event.event_hash} does not match the event.`);
    }
    if (missing.length > 0) refuse(instanceId, "a trace exists after a missing one, so the order of the audit chain cannot be kept.");
    const position = traces.indexOf(trace);
    if (position <= lastPosition) refuse(instanceId, "the existing traces are not in the order of the event history.");
    lastPosition = position;
    ordered.push(trace);
  }
  return { ordered, missing };
}

export function repairWorkflowTraces(context, options) {
  ensureInitialized(context);
  const instanceId = normalizeId(requireOption(options, "id"));
  const dryRun = options["dry-run"] === true;
  const italian = humanGuidanceLocale(options) === "it";
  const { instance } = readCompletedWorkflowInstance(context, instanceId);
  const { effectiveDefinition } = loadEffectiveDefinitionForInstance(context, instance);
  const eventsPath = workflowEventsPath(context, instanceId);
  const checkpointPath = workflowCheckpointPath(context, instanceId);
  const tracePath = path.join(context.sdlcRoot, "traces", "project.jsonl");
  const releaseEventLock = acquireFileLock(`${eventsPath}.lock`);
  const releaseTraceLock = acquireFileLock(`${tracePath}.lock`);
  try {
    if (readWorkflowPendingTransition(context, instanceId).exists) {
      refuse(instanceId, "a transition was interrupted; repeat that transition request first.");
    }
    const events = readWorkflowEvents(context, instanceId);
    const checkpointRead = readWorkflowCheckpoint(context, instanceId);
    if (!checkpointRead.valid) refuse(instanceId, checkpointRead.errors.join("; "));
    const checkpoint = checkpointRead.checkpoint;
    // The events and their checkpoint must verify on their own: nothing is rebuilt from an untrusted history.
    const checked = validateWorkflowCheckpoint(checkpoint, { instance, effective_definition: effectiveDefinition });
    if (checked?.valid !== true) refuse(instanceId, `its checkpoint is not valid (${(checked?.errors || []).join("; ")}).`);
    const replay = replayWorkflowEvents(
      { instance, effective_definition: effectiveDefinition, events, checkpoint },
      { require_checkpoint: true },
    );
    if (replay?.valid !== true) refuse(instanceId, `its event history does not verify (${(replay?.errors || []).join("; ")}).`);

    const snapshot = workflowTraceIntegritySnapshotLocked(context, tracePath);
    if (!snapshot.integrity.valid) {
      refuse(instanceId, "the project history does not verify; run story sync (or trace rebase --onto <remote>/<branch> --apply) first.");
    }
    const traces = snapshot.records.filter((entry) => entry.valid === true).map((entry) => entry.event);
    const { ordered, missing } = classifyTraces(instanceId, instance, events, traces);
    const chainOf = (list) => list.reduce((previous, trace) => extendWorkflowTraceChain(previous, trace), null);
    const regenerated = missing.map((event) => regeneratedTransitionTrace(context, instanceId, event));
    const finalChain = chainOf([...ordered, ...regenerated]);
    const rebuiltPresent = ordered.some(isRegenerated);
    if (missing.length === 0) {
      if (finalChain === checkpoint.trace_chain_hash) {
        output(options, { status: "nothing_to_repair", instance_id: instanceId, events: events.length }, [
          italian ? `${instanceId}: ogni evento ha già la sua trace; niente da riparare.` : `${instanceId}: every event already has its trace; nothing to repair.`,
        ]);
        return;
      }
      // Only an interrupted earlier repair leaves rebuilt traces the checkpoint does not bind yet.
      if (!rebuiltPresent) {
        refuse(instanceId, "its checkpoint no longer matches the audit traces, which repair-traces does not rebuild.");
      }
    }

    const nextCheckpoint = createWorkflowCheckpoint({
      instance,
      effective_definition: effectiveDefinition,
      events,
      trace_chain_hash: finalChain,
    });
    assertRecordSchema(nextCheckpoint, "workflow-checkpoint.schema.json", `Workflow checkpoint for instance ${instanceId}`);
    const rebuiltIds = new Set([...ordered.filter(isRegenerated), ...regenerated].map((trace) => trace.id));
    const repairedEvents = (missing.length > 0 ? missing : events.filter((event) => rebuiltIds.has(`TR-WF-${event.event_hash}`)))
      .map((event) => event.event_hash);
    const repairId = `TR-WFREPAIR-${computeStableHash({ instance_id: instanceId, checkpoint_hash: nextCheckpoint.checkpoint_hash }).slice(0, 32)}`;
    const payload = {
      status: dryRun ? "planned" : "repaired",
      instance_id: instanceId,
      dry_run: dryRun,
      events: events.length,
      events_without_trace: repairedEvents,
      traces: repairedEvents.map((hash) => `TR-WF-${hash}`),
      previous_trace_chain_hash: checkpoint.trace_chain_hash,
      trace_chain_hash: finalChain,
      repair_trace: repairId,
    };
    if (dryRun) {
      output(options, payload, [
        italian
          ? `${instanceId}: ${repairedEvents.length} eventi senza trace collegata, ricostruibili dagli eventi verificati: ${repairedEvents.map((hash) => hash.slice(0, 12)).join(", ")}.`
          : `${instanceId}: ${repairedEvents.length} event(s) without a bound trace, rebuildable from the verified events: ${repairedEvents.map((hash) => hash.slice(0, 12)).join(", ")}.`,
        italian ? "Nessuna modifica eseguita (--dry-run)." : "Nothing was changed (--dry-run).",
      ]);
      return;
    }

    // Traces first (each is idempotent by id), then the repair record, then the checkpoint that binds them: an interrupted run resumes from the first missing step.
    for (const trace of regenerated) {
      ensureWorkflowTraceRecordLocked(context, tracePath, trace, workflowTraceAnchor(tracePath));
    }
    const attribution = buildAttribution(context, options, REPAIR_ACTION);
    const alreadyRecorded = snapshot.records.some((entry) => entry.valid === true && entry.event?.id === repairId);
    if (!alreadyRecorded) {
      const record = prepareGovernedTraceEvent(context, {
        id: repairId,
        story_id: null,
        type: "implementation",
        summary: `Rebuilt ${repairedEvents.length} missing audit trace(s) of workflow instance ${instanceId} from its verified events`,
        outcome: "passed",
        actor: attribution.actor,
        requested_by: null,
        authorized_by: null,
        request: null,
        authorization_ref: null,
        action: REPAIR_ACTION,
        evidence: [toProjectPath(context, eventsPath), toProjectPath(context, checkpointPath)],
        related: [instanceId, ...repairedEvents],
        repair: {
          events: repairedEvents,
          traces: payload.traces,
          previous_trace_chain_hash: checkpoint.trace_chain_hash,
          trace_chain_hash: finalChain,
          checkpoint_hash: nextCheckpoint.checkpoint_hash,
        },
        git: attribution.git,
        run: attribution.run,
        created_at: attribution.recorded_at,
      });
      ensureWorkflowTraceRecordLocked(context, tracePath, record, workflowTraceAnchor(tracePath));
    }
    writeWorkflowJsonDurably(checkpointPath, nextCheckpoint, { force: true });
    output(options, payload, [
      italian
        ? `${instanceId}: ricostruite ${repairedEvents.length} trace dagli eventi verificati e registrata la riparazione (${repairId}).`
        : `${instanceId}: rebuilt ${repairedEvents.length} trace(s) from the verified events and recorded the repair (${repairId}).`,
      italian ? "Poi: agentic-sdlc workflow instance status e gate check --strict devono risultare validi." : "Next: workflow instance status and gate check --strict should now verify.",
    ]);
  } finally {
    releaseTraceLock();
    releaseEventLock();
  }
}
