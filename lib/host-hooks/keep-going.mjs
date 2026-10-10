import path from "node:path";

import { crypto, Date, fs, process } from "../runtime/host.mjs";

/**
 * "Keep going": at the end of a turn, tells the agent the next step while
 * this computer still has work in the project, so it does not stop early.
 * Reads local files only (story records, gate reports, the messages already
 * fetched by the throttled poll); it never reaches the network.
 *
 *   AGENTIC_SDLC_KEEP_GOING=off   disables it
 *
 * Loop safety: when the host says the turn already continued because of this
 * hook (`stop_hook_active`) and the next step is the same as last time, the
 * stop is allowed after MAX_IDENTICAL_BLOCKS identical blocks in a row. The
 * counter lives in <git-common-dir>/agentic-sdlc/keep-going.json.
 */
export const KEEP_GOING_ENV = "AGENTIC_SDLC_KEEP_GOING";
export const KEEP_GOING_STATE_FILE = "keep-going.json";
export const MAX_IDENTICAL_BLOCKS = 3;
export const LIFECYCLE_STEPS = Object.freeze(["discovery", "analysis", "design", "implementation", "validation", "release", "operations"]);
const OFF_VALUES = new Set(["0", "false", "no", "off", "disabled"]);
const CLOSED_CLAIM_STATUSES = new Set(["released", "transferred", "completed", "cancelled", "expired"]);
const CLOSED_STORY_STATUSES = new Set(["done", "blocked", "draft", "cancelled", "superseded"]);
const REPLY_KINDS = new Set(["answer", "ack"]);
const ASK_KINDS = new Set(["question", "request"]);
const MAX_ITEMS = 5;

const STEP_LABELS = Object.freeze({
  discovery: "completa la discovery",
  analysis: "completa l'analisi",
  design: "completa il design",
  implementation: "completa l'implementazione",
  validation: "completa la validazione",
  release: "completa il rilascio (commit, push, PR)",
  operations: "completa le operations",
});

export function keepGoingDisabled(env = process.env) {
  return OFF_VALUES.has(String(env[KEEP_GOING_ENV] ?? "").trim().toLowerCase());
}

function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function listDir(directory) {
  try {
    return fs.readdirSync(directory);
  } catch {
    return [];
  }
}

/**
 * Next lifecycle step of a claimed story, from the steps already completed
 * and whether the strict gate report exists. Pure.
 */
export function nextStoryStep({ storyId, completedSteps = [], strictGate = false }) {
  const done = new Set(completedSteps);
  const missing = LIFECYCLE_STEPS.find((step) => !done.has(step));
  if (missing) {
    return {
      label: STEP_LABELS[missing],
      command: `agentic-sdlc story complete-step --id ${storyId} --step ${missing} --summary "<esito>"`,
    };
  }
  if (!strictGate) {
    return {
      label: "esegui il gate strict e certifica il ciclo di vita",
      command: `agentic-sdlc gate check --story ${storyId} --scope story --strict --lifecycle-complete`,
    };
  }
  return {
    label: "pubblica i record e rilascia la claim",
    command: `agentic-sdlc status --root .`,
  };
}

/**
 * Pure decision. Inputs are the work found locally; returns whether to block
 * the stop, the reason shown to the agent, a note for the person, and the
 * new loop-safety state.
 *   claims     [{ storyId, next: {label, command} }] active claims of this computer, not certified
 *   questions  [{ id, from, text }] unanswered questions/requests addressed to this computer
 *   available  [storyId] stories without claim, not done
 *   human      [text] items waiting on a person (never block on these)
 */
export function decideKeepGoing({ claims = [], questions = [], available = [], human = [], previous = {}, stopHookActive = false, disabled = false } = {}) {
  const note = human.length > 0 ? `In attesa di una decisione umana: ${human.slice(0, MAX_ITEMS).join("; ")}` : null;
  if (disabled) return { block: false, reason: null, note: null, state: previous };
  const lines = [];
  for (const claim of claims.slice(0, MAX_ITEMS)) lines.push(`- ${claim.storyId}: ${claim.next.label} -> \`${claim.next.command}\``);
  for (const question of questions.slice(0, MAX_ITEMS)) {
    lines.push(`- rispondi a ${question.from || "un altro computer"} (${question.text}) -> \`agentic-sdlc message send --kind answer --reply-to ${question.id} --text "<risposta>"\``);
  }
  if (lines.length === 0 && available.length > 0) {
    lines.push(`- nessuna claim attiva; story disponibili: ${available.slice(0, MAX_ITEMS).join(", ")} -> verifica dipendenze con \`agentic-sdlc status\`, poi \`agentic-sdlc story claim --id <story-id> --agent <nome>\``);
  }
  if (lines.length === 0) return { block: false, reason: null, note, state: {} };
  const reason = `C'e' ancora lavoro su questo computer, continua con il prossimo passo:\n${lines.join("\n")}`
    + (note ? `\n${note} (non bloccante).` : "");
  const hash = crypto.createHash("sha256").update(reason).digest("hex");
  const count = stopHookActive && previous.hash === hash ? Number(previous.count || 0) + 1 : 1;
  if (count > MAX_IDENTICAL_BLOCKS) return { block: false, reason, note, state: { hash, count } };
  return { block: true, reason, note, state: { hash, count } };
}

/** Claims, questions, and available stories of this computer, from local files only. */
export function collectWork(root, { env = process.env, now = Date.now(), messagingState = null, self = null } = {}) {
  const sdlc = path.join(root, ".sdlc");
  const storiesDir = path.join(sdlc, "stories");
  const gatesDir = path.join(sdlc, "gates");
  const gates = new Set(listDir(gatesDir));
  const claims = [];
  const available = [];
  const human = [];
  for (const storyId of listDir(storiesDir)) {
    const storyDir = path.join(storiesDir, storyId);
    const claim = readJson(path.join(storyDir, "claim.json"));
    const story = readJson(path.join(storyDir, "story.json"));
    const certified = gates.has(`${storyId}-final.json`);
    if (claim) {
      const status = String(claim.status ?? "").toLowerCase();
      if (CLOSED_CLAIM_STATUSES.has(status) || certified) continue;
      const expires = Date.parse(claim.expires_at ?? "");
      if (Number.isFinite(expires) && expires < now) {
        human.push(`claim di ${storyId} scaduta: serve una persona per rinnovarla o forzarla`);
        continue;
      }
      const completedSteps = listDir(path.join(storyDir, "steps"))
        .filter((name) => name.endsWith(".json"))
        .filter((name) => String(readJson(path.join(storyDir, "steps", name))?.status ?? "") === "completed")
        .map((name) => name.slice(0, -".json".length));
      claims.push({ storyId, next: nextStoryStep({ storyId, completedSteps, strictGate: gates.has(`${storyId}-strict.json`) }) });
    } else if (story && !certified && !CLOSED_STORY_STATUSES.has(String(story.status ?? "").toLowerCase())) {
      available.push(storyId);
    }
  }
  return { claims, questions: pendingQuestions(messagingState, self), available: available.sort(), human };
}

/** Questions/requests to this computer (or everyone) not yet answered by it, from the cached message window. */
export function pendingQuestions(messagingState, self) {
  const window = Array.isArray(messagingState?.attention?.window) ? messagingState.attention.window : [];
  const own = new Set(Array.isArray(messagingState?.own) ? messagingState.own.map(String) : []);
  const mine = (message) => message.from === self || own.has(String(message.id));
  const answered = new Set(window.filter((m) => REPLY_KINDS.has(m.kind) && m.reply_to && mine(m)).map((m) => m.reply_to));
  return window
    .filter((m) => ASK_KINDS.has(m.kind) && !mine(m) && !answered.has(m.id) && (!m.to || m.to === self))
    .map((m) => ({ id: m.id, from: m.from, text: String(m.text ?? "").replace(/\s+/gu, " ").trim().slice(0, 120) }));
}

async function messagingContext(root, env) {
  try {
    const { settingsFor } = await import("../messaging/attention.mjs");
    const { senderLabel } = await import("../messaging/commands.mjs");
    const settings = settingsFor(root, env);
    if (!settings) return { messagingState: null, self: null };
    return { messagingState: readJson(settings.statePath), self: senderLabel({}, env) };
  } catch {
    return { messagingState: null, self: null };
  }
}

/** Work and next steps for a project root (used by the Stop hook and `agentic-sdlc next`). */
export async function keepGoingWork(root, { env = process.env, now = Date.now() } = {}) {
  return collectWork(root, { env, now, ...(await messagingContext(root, env)) });
}

/** Stop hook: returns the host output object, or null to let the turn end. */
export async function keepGoingStop(root, payload = {}, { env = process.env, commonDir = null } = {}) {
  if (keepGoingDisabled(env)) return null;
  const work = await keepGoingWork(root, { env });
  const statePath = commonDir ? path.join(commonDir, "agentic-sdlc", KEEP_GOING_STATE_FILE) : null;
  const previous = (statePath && readJson(statePath)) || {};
  const decision = decideKeepGoing({ ...work, previous, stopHookActive: payload.stop_hook_active === true });
  if (statePath) {
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, `${JSON.stringify(decision.state)}\n`, { mode: 0o600 });
    } catch {
      // loop safety is best effort; the host's own limits still apply
    }
  }
  if (decision.block) return { decision: "block", reason: decision.reason };
  if (decision.note) return { systemMessage: decision.note };
  return null;
}
