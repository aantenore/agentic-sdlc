import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fail,
} from "../cli/user-error.mjs";
import {
  getOptionString,
  normalizeId,
  requireOption,
} from "../lifecycle/common.mjs";
import {
  humanGuidanceLocale,
} from "../lifecycle/guidance.mjs";
import {
  operationsRoot,
} from "../lifecycle/project.mjs";
import {
  configuredPhaseOrder,
} from "../lifecycle/story.mjs";
import {
  Date,
  childProcess,
  fs,
  process,
} from "../runtime/host.mjs";
import {
  SOFTWARE_PROJECT_PHASES,
} from "../workflow-presets.mjs";
import {
  ensureInitialized,
  matchingApprovedStoryWorkflowDefinition,
} from "./migration.mjs";
import {
  output,
} from "./output.mjs";
import {
  readProjectJson,
} from "./storage.mjs";
import {
  readStory,
} from "./story.mjs";

/**
 * Fix stories. A story created with `--fixes` (or from an incident with
 * `--incident`) records which delivered story it corrects in `story.fixes`.
 * Its discovery and analysis already happened in the fixed story, so the
 * short cycle completes those two steps as inherited and moves the workflow
 * to design. It runs the ordinary commands, so every record is the same kind
 * an older plugin already reads and all checks still apply.
 */

const CLI_ENTRY = fileURLToPath(new URL("../../bin/agentic-sdlc.mjs", import.meta.url));
const STEP_TIMEOUT_MS = 60000;
const SKIPPED_PHASES = Object.freeze(["discovery", "analysis"]);
const TARGET_PHASE = "design";

function readIncident(context, incidentId) {
  const recordPath = path.join(operationsRoot(context), `${incidentId}.json`);
  if (!fs.existsSync(recordPath)) return null;
  const record = readProjectJson(context, recordPath);
  return record?.kind === "incident" ? record : null;
}

/** The fix link requested on `story create`, validated; null for an ordinary story. */
export function resolveStoryFixLink(context, options, newStoryId) {
  const fixesInput = getOptionString(options, "fixes");
  const incidentInput = getOptionString(options, "incident");
  if (!fixesInput && !incidentInput) return null;
  let incident = null;
  if (incidentInput) {
    const incidentId = normalizeId(incidentInput);
    incident = readIncident(context, incidentId);
    if (!incident) {
      fail(`Incident ${incidentId} does not exist; record it with 'incident record' first.`);
    }
  }
  const fixedStoryId = normalizeId(fixesInput || incident.story_id);
  if (incident && incident.story_id !== fixedStoryId) {
    fail(`Incident ${incident.id} belongs to story ${incident.story_id}, not ${fixedStoryId}.`);
  }
  if (fixedStoryId === newStoryId) {
    fail(`Story ${newStoryId} cannot fix itself.`);
  }
  const fixedStory = readStory(context, fixedStoryId);
  if (!fixedStory) {
    fail(`Story ${fixedStoryId} does not exist; --fixes must name the story being corrected.`);
  }
  return {
    story_id: fixedStoryId,
    incident_id: incident?.id || null,
    requirement_ids: Array.isArray(fixedStory.links?.requirements) ? fixedStory.links.requirements : [],
  };
}

function runStep(context, args) {
  const result = childProcess.spawnSync(
    process.execPath,
    [CLI_ENTRY, ...args, "--root", context.root, "--json"],
    { encoding: "utf8", timeout: STEP_TIMEOUT_MS, env: process.env },
  );
  if (result.status === 0) return { ok: true };
  for (const stream of [result.stdout, result.stderr]) {
    try {
      const message = JSON.parse(stream || "").error?.message;
      if (message) return { ok: false, message: String(message).split("\n- Retry")[0] };
    } catch {
      // Not the JSON error envelope; try the other stream.
    }
  }
  const tail = `${result.stdout || ""}\n${result.stderr || ""}`.trim().split("\n").slice(-3).join(" ");
  return { ok: false, message: tail || `exit ${result.status ?? result.signal}` };
}

function workflowInstanceDir(context, instanceId) {
  return path.join(context.sdlcRoot, "workflows", "instances", instanceId);
}

function workflowCurrentState(context, instanceId) {
  if (!instanceId) return null;
  const dir = workflowInstanceDir(context, instanceId);
  let state = null;
  try {
    state = JSON.parse(fs.readFileSync(path.join(dir, "instance.json"), "utf8")).initial_state || null;
  } catch {
    return null;
  }
  const eventsPath = path.join(dir, "events.jsonl");
  if (!fs.existsSync(eventsPath)) return state;
  for (const line of fs.readFileSync(eventsPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.kind === "workflow_transition_event" && event.to) state = event.to;
    } catch {
      // A torn line is reported by the workflow commands themselves.
    }
  }
  return state;
}

function storyWorkflowInstanceId(context, storyId) {
  const root = path.join(context.sdlcRoot, "workflows", "instances");
  const expected = `DELIVERY-${storyId}`;
  if (fs.existsSync(path.join(root, expected, "instance.json"))) return expected;
  for (const name of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    const instancePath = path.join(root, name, "instance.json");
    if (!fs.existsSync(instancePath)) continue;
    try {
      const instance = JSON.parse(fs.readFileSync(instancePath, "utf8"));
      if (instance?.metadata?.governance_binding?.story_id === storyId) return name;
    } catch {
      // Unreadable instances are reported by the workflow commands.
    }
  }
  return null;
}

/**
 * Short cycle for a fix story: start its workflow when needed, complete
 * discovery and analysis as inherited from the fixed story, and stop in
 * design. Stops at the first refusal and says why; nothing is bypassed.
 */
export function fastTrackFixStory(context, storyId) {
  const story = readStory(context, storyId);
  const fixes = story?.fixes;
  if (!fixes?.story_id) {
    return { status: "not_a_fix", fixed_story_id: null, story_id: storyId, steps: [], message: `Story ${storyId} is not a fix story (no --fixes link).` };
  }
  const order = configuredPhaseOrder(context);
  if (order.slice(0, 3).join(",") !== [...SKIPPED_PHASES, TARGET_PHASE].join(",")) {
    return { status: "skipped", story_id: storyId, steps: [], message: `The configured phase order does not start with ${[...SKIPPED_PHASES, TARGET_PHASE].join(" -> ")}; the short cycle does not apply.` };
  }
  const steps = [];
  let instanceId = null;
  const stop = (message) => ({ status: "stopped", story_id: storyId, fixed_story_id: fixes.story_id, steps, phase: workflowCurrentState(context, instanceId) || null, message });
  instanceId = storyWorkflowInstanceId(context, storyId);
  if (!instanceId) {
    const stock = order.length === SOFTWARE_PROJECT_PHASES.length
      && order.every((phase, index) => phase === SOFTWARE_PROJECT_PHASES[index]);
    const definition = stock ? { id: "software-project", version: "3" } : matchingApprovedStoryWorkflowDefinition(context);
    if (!definition) {
      return stop(`Define and approve a story-bound workflow with the configured phase order first (workflow definition propose).`);
    }
    instanceId = `DELIVERY-${storyId}`;
    const started = runStep(context, [
      "workflow", "instance", "start", "--id", instanceId,
      "--definition", String(definition.id), "--definition-version", String(definition.version),
      "--story", storyId, "--summary", `Fix story for ${fixes.story_id}`,
    ]);
    if (!started.ok) return stop(started.message);
    steps.push("workflow.start");
  }
  const reason = `Inherited from fixed story ${fixes.story_id}${fixes.incident_id ? ` (incident ${fixes.incident_id})` : ""}`;
  for (const [index, phase] of SKIPPED_PHASES.entries()) {
    const next = index + 1 < SKIPPED_PHASES.length ? SKIPPED_PHASES[index + 1] : TARGET_PHASE;
    const current = workflowCurrentState(context, instanceId);
    if (current !== phase) {
      if (order.indexOf(current) > order.indexOf(phase)) continue;
      return stop(`Workflow ${instanceId} is in '${current || "unknown"}', expected '${phase}'.`);
    }
    if (!fs.existsSync(path.join(context.sdlcRoot, "stories", storyId, "steps", `${phase}.json`))) {
      // No phase output is produced: the fixed story's approved records stand for these phases.
      const completed = runStep(context, [
        "story", "complete-step", "--id", storyId, "--step", phase,
        "--summary", `${reason}: ${phase} not repeated for the fix`,
        "--next-step", next, "--allow-unapproved-contract-output",
      ]);
      if (!completed.ok) return stop(completed.message);
      steps.push(`${phase}.complete`);
    }
    const moved = runStep(context, [
      "workflow", "instance", "transition", "--id", instanceId, "--to", next,
      "--request-id", `${instanceId}-fix-${phase}-to-${next}-${Date.now().toString(36)}`, "--summary", reason,
    ]);
    if (!moved.ok) return stop(moved.message);
    steps.push(`${phase}->${next}`);
  }
  return { status: "in_design", story_id: storyId, fixed_story_id: fixes.story_id, workflow_instance_id: instanceId, steps, phase: TARGET_PHASE, message: `${reason}; workflow now in ${TARGET_PHASE}.` };
}

export function fastTrackLines(result, italian) {
  if (!result) return [];
  if (result.status === "in_design") {
    return [italian
      ? `Ciclo corto del fix: discovery e analysis ereditate da ${result.fixed_story_id}; workflow in design.`
      : `Fix short cycle: ${result.message}`];
  }
  const label = italian ? "Ciclo corto del fix non completato" : "Fix short cycle not completed";
  return [
    `${label}: ${result.message}`,
    ...(result.status === "stopped"
      ? [italian
          ? `Dopo aver risolto, riprova: agentic-sdlc story fast-track --id ${result.story_id}`
          : `After fixing that, retry: agentic-sdlc story fast-track --id ${result.story_id}`]
      : []),
  ];
}

/** `story fast-track --id <fix-story>`: run (or resume) the short cycle. */
export function fastTrackStoryCommand(context, options) {
  ensureInitialized(context);
  const storyId = normalizeId(requireOption(options, "id"));
  if (!readStory(context, storyId)) {
    fail(`Story ${storyId} does not exist.`);
  }
  const result = fastTrackFixStory(context, storyId);
  if (result.status === "not_a_fix") fail(result.message);
  output(options, result, fastTrackLines(result, humanGuidanceLocale(options) === "it"));
  if (result.status === "stopped") process.exitCode = 1;
}
