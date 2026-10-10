import { storyLabel } from "../engine/story-label.mjs";
import { safeGitRemoteName } from "../engine/git-remote-name.mjs";
import path from "node:path";

import { childProcess, crypto, Date, fs, process } from "../runtime/host.mjs";
import { classifyStoryRecordPath } from "../story-records.mjs";
import { VERSION } from "../engine/definitions.mjs";
import { identityOf, newerVersionSeen, unansweredForMe } from "../messaging/kinds.mjs";
import { activeWorking } from "./working-marker.mjs";

/**
 * "Keep going": at the end of a turn, tells the agent the next step while
 * this computer still has work in the project, so it does not stop early.
 * Reads local files and local git only (story records, gate reports, the
 * messages already fetched by the throttled poll); it never reaches the network.
 *
 *   AGENTIC_SDLC_KEEP_GOING=off   disables it
 *   AGENTIC_SDLC_KEEP_GOING_FOREIGN_HOURS=<n>   switch for not proposing a story created
 *                                 by another computer (default on, whatever its age); 0 proposes it
 *
 * Loop safety: when the next step is the same as last time within 10 minutes,
 * the stop is allowed after MAX_IDENTICAL_BLOCKS identical blocks in a row
 * (whatever `stop_hook_active` says). The
 * counter lives in <git-common-dir>/agentic-sdlc/keep-going.json.
 */
export const KEEP_GOING_ENV = "AGENTIC_SDLC_KEEP_GOING";
export const KEEP_GOING_STATE_FILE = "keep-going.json";
export const FOREIGN_HOURS_ENV = "AGENTIC_SDLC_KEEP_GOING_FOREIGN_HOURS";
export const DEFAULT_FOREIGN_HOURS = 3;
export const MAX_IDENTICAL_BLOCKS = 2;
export const MAX_SUGGESTION_BLOCKS = 3;
export const IDENTICAL_BLOCKS_WINDOW_MS = 10 * 60 * 1000;
export const LIFECYCLE_STEPS = Object.freeze(["discovery", "analysis", "design", "implementation", "validation", "release", "operations"]);
const OFF_VALUES = new Set(["0", "false", "no", "off", "disabled"]);
export const CLOSED_CLAIM_STATUSES = new Set(["released", "transferred", "completed", "cancelled", "expired"]);
const CLOSED_STORY_STATUSES = new Set(["done", "blocked", "draft", "cancelled", "superseded"]);
const WAITING_CLAIM_STATUSES = new Set(["waiting", "parked", "blocked", "paused"]);
const BEHIND_PHASES = new Set(["implementation", "validation", "release", "operations", "gate", "publish"]);
const LOOK_AHEAD_PHASES = new Set(["release", "operations", "gate", "publish"]);
export const UPDATE_COMMAND = "claude plugin marketplace update aantenore && claude plugin update agentic-sdlc@aantenore";
const MAX_ITEMS = 5;
const GIT_TIMEOUT_MS = 5000;

const STEP_LABELS = Object.freeze({
  discovery: "completa la discovery",
  analysis: "completa l'analisi",
  design: "completa il design",
  implementation: "completa l'implementazione",
  validation: "completa la validazione",
  release: "completa il rilascio (prima `story sync` se la base e' avanzata, poi git.commit, push; per la PR fai authorize e `gh pr create` subito di seguito, senza passi in mezzo: se la base avanza in mezzo la PR e' rifiutata; dopo complete-step validation rilancia `gate check --strict` e poi `workflow instance transition --request-id`)",
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
      phase: missing,
      label: STEP_LABELS[missing],
      command: `agentic-sdlc story complete-step --id ${storyId} --step ${missing} --summary "<esito>"`,
    };
  }
  if (!strictGate) {
    return {
      phase: "gate",
      label: "esegui il gate strict e certifica il ciclo di vita",
      command: `agentic-sdlc gate check --story ${storyId} --scope story --strict --lifecycle-complete`,
    };
  }
  return {
    phase: "publish",
    label: "pubblica i record e rilascia la claim",
    command: `agentic-sdlc status --root .`,
  };
}

/**
 * Pure decision. Inputs are the work found locally; returns whether to block
 * the stop, the reason shown to the agent, a note for the person, and the
 * new loop-safety state. Priority: questions, unpublished records, plugin
 * update, own claims' next step, parallel work, available stories.
 *   claims     [{ storyId, next, waiting?, delegated?, behind? }] active claims of this computer, not certified
 *              waiting: why the claim waits; delegated: { until, reason } local marker (`story working`);
 *              behind: commits the story worktree lacks from the fetched base
 *   questions  [{ id, from, text }] unanswered questions/requests addressed to this computer
 *   outbox     { count, reason, notified } messages kept in the local outbox; mentioned once, never blocking
 *   available  [storyId] stories nobody holds, not closed, delivered, superseded or parent
 *   ready      [storyId] subset of available whose dependencies are satisfied (defaults to available)
 *   update     { version, from } newer plugin announced by another computer
 *   joined     [text] computers that joined the channel recently ("<name> si è unito al canale (versione X)"); noted, never blocking
 *   human      [text] items waiting on a person (never block on these)
 *   unpublished [{ storyId, base, files, command }] local records not on the remote base
 */
export function decideKeepGoing(input = {}) {
  const track = { counts: {}, blocks: {} };
  const decision = decideKeepGoingInner(input, track);
  if (input.disabled) return decision;
  // Per-story memory for the unpublished-records step: record counts (growth between Stops
  // means someone is producing them) and consecutive blocks (anti-loop).
  return { ...decision, state: { ...decision.state, unpublishedCounts: track.counts, unpublishedBlocks: track.blocks } };
}

function decideKeepGoingInner({ unpublished = [], claims = [], questions = [], outbox = null, available = [], ready = null, update = null, joined = [], human = [], previous = {}, now = Date.now(), disabled = false, label = (id) => id } = {}, track = { counts: {}, blocks: {} }) {
  if (disabled) return { block: false, reason: null, note: null, state: previous };
  const notes = [];
  if (human.length > 0) notes.push(`In attesa di una decisione umana: ${human.slice(0, MAX_ITEMS).join("; ")}`);
  if (outbox?.count > 0 && outbox.notified !== true) {
    notes.push(`${outbox.count} messaggi in coda, non ancora inviati (${outbox.reason ?? "GitHub non raggiungibile"}); controlla 'gh auth status' e la rete, oppure 'agentic-sdlc message outbox --flush'`);
  }
  if (joined.length > 0) notes.push(joined.slice(0, MAX_ITEMS).join("; "));
  const candidates = ready ?? available;
  const lines = [];
  for (const question of questions.slice(0, MAX_ITEMS)) {
    lines.push(`- rispondi a ${question.from || "un altro computer"} (${question.text}) -> \`agentic-sdlc message send --kind answer --reply-to ${question.id} --text "<risposta>"\``);
  }
  for (const item of unpublished.slice(0, MAX_ITEMS)) {
    const count = item.files.length;
    const before = previous.unpublishedCounts?.[item.storyId];
    track.counts[item.storyId] = count;
    // Delegated story (active `story working` marker) or records changing between Stops:
    // whoever works on it publishes them; publishing in parallel causes conflicts.
    const delegated = claims.some((claim) => claim.storyId === item.storyId && claim.delegated);
    const changing = before !== undefined && before !== count;
    if (delegated || changing) {
      notes.push(`${label(item.storyId)}: ${count} record non pubblicati su ${item.base}, lavoro delegato: li pubblica chi ci lavora`);
      continue;
    }
    // Anti-loop: the same story blocked MAX_IDENTICAL_BLOCKS times in a row stops blocking.
    const blocked = Number(previous.unpublishedBlocks?.[item.storyId] || 0);
    if (blocked >= MAX_IDENTICAL_BLOCKS) {
      track.blocks[item.storyId] = blocked;
      notes.push(`${label(item.storyId)}: ${count} record non pubblicati su ${item.base} (gia' segnalato, non blocco di nuovo) -> \`${item.command}\``);
      continue;
    }
    track.blocks[item.storyId] = blocked + 1;
    lines.push(`- ${label(item.storyId)}: record non pubblicati su ${item.base} (${count}), pubblicali prima di tutto -> \`${item.command}\``);
  }
  if (update) {
    lines.push(`- plugin ${update.version} disponibile (annunciato da ${update.from || "un altro computer"}; installato ${VERSION}): l'aggiornamento ha priorita', aggiorna prima di proseguire -> \`${UPDATE_COMMAND}\` poi \`/reload-plugins\``);
  }
  const idle = [];
  for (const claim of claims.slice(0, MAX_ITEMS)) {
    if (claim.delegated) {
      idle.push(claim);
      notes.push(`${label(claim.storyId)}: lavoro delegato in corso fino a ${claim.delegated.until}${claim.delegated.reason ? ` (${claim.delegated.reason})` : ""}, nessun passo da fare per ora`);
      continue;
    }
    if (claim.waiting) {
      idle.push(claim);
      notes.push(`${label(claim.storyId)}: in attesa (${claim.waiting})`);
      continue;
    }
    if (claim.awaitingPerson) {
      idle.push(claim);
      notes.push(`${label(claim.storyId)}: in attesa di una persona: ${claim.awaitingPerson.command}`);
      continue;
    }
    if (claim.behind > 0) {
      lines.push(`- ${label(claim.storyId)}: il worktree e' indietro di ${claim.behind} commit rispetto alla base, allinea PRIMA del git.commit governato (un rebase dopo il commit ne cambia lo SHA e invalida la ricevuta) -> \`agentic-sdlc story sync --id ${claim.storyId}\``);
    }
    lines.push(`- ${label(claim.storyId)}: ${claim.next.label} -> \`${claim.next.command}\``);
    if (claim.derived?.length > 0) {
      lines.push(`- ${label(claim.storyId)}: oltre ai criteri espliciti produci le verifiche derivate (${claim.derived.join(", ")}) e registrale con \`agentic-sdlc test record --story ${claim.storyId} --acceptance <id> ...\``);
    }
  }
  // Everything above needs this computer; what follows is only a suggestion.
  const firmLines = lines.length;
  // Waiting or delegated is not idle: take parallel work.
  const parallel = candidates[0];
  if (idle.length > 0 && parallel) {
    lines.push(`- ${idle.map((claim) => label(claim.storyId)).sort().join(", ")} non richiede te adesso: lavora in parallelo su ${label(parallel)} -> \`agentic-sdlc story claim --id ${parallel} --agent <nome>\``);
  }
  // Look-ahead: reserve the next story while the current one is being released.
  const reserve = candidates.find((id) => !(idle.length > 0 && id === parallel));
  const releasing = claims.some((claim) => !claim.waiting && !claim.delegated && LOOK_AHEAD_PHASES.has(claim.next?.phase));
  if (releasing && reserve) {
    lines.push(`- la story in corso e' al rilascio: prenota la prossima (${label(reserve)}) per continuare subito dopo la certificazione -> \`agentic-sdlc story reserve --id ${reserve} --agent <nome>\``);
  }
  if (lines.length === 0 && claims.length === 0 && available.length > 0) {
    lines.push(`- nessuna claim attiva; story disponibili: ${(candidates.length > 0 ? candidates : available).slice(0, MAX_ITEMS).map(label).join(", ")} -> verifica dipendenze con \`agentic-sdlc status\`, poi \`agentic-sdlc story claim --id <story-id> --agent <nome>\``);
  }
  const note = notes.length > 0 ? notes.join("; ") : null;
  if (lines.length === 0) return { block: false, reason: null, note, state: {} };
  const reason = `C'e' ancora lavoro su questo computer, continua con il prossimo passo:\n${lines.join("\n")}`
    + (note ? `\n${note} (non bloccante).` : "");
  const hash = crypto.createHash("sha256").update(normalizeReason(reason)).digest("hex");
  // Only suggestions (nothing firm): compare the normalized, sorted SET of them with the last Stop.
  // Same set within the window -> inform and let the turn end, whatever the number of suggestions.
  // The same set blocked MAX_SUGGESTION_BLOCKS times in a row lets the turn end even beyond the window.
  if (firmLines === 0) {
    const suggestions = lines.map((line) => normalizeReason(line)).sort();
    const setHash = crypto.createHash("sha256").update(suggestions.join("\n")).digest("hex");
    const sameSet = previous.setHash === setHash;
    const summary = `Passi in attesa, non blocco di nuovo:\n${lines.join("\n")}`;
    if (sameSet && now - Number(previous.at || 0) < IDENTICAL_BLOCKS_WINDOW_MS) {
      return { block: false, reason, note: summary, state: previous };
    }
    const setCount = sameSet ? Number(previous.setCount || 0) + 1 : 1;
    if (setCount > MAX_SUGGESTION_BLOCKS) return { block: false, reason, note: summary, state: { setHash, setCount, at: now } };
    return { block: true, reason, note, state: { setHash, setCount, at: now } };
  }
  // Loop safety, independent of what the host reports: the same reason blocked
  // MAX_IDENTICAL_BLOCKS times within the window lets the turn end.
  const repeated = previous.hash === hash && now - Number(previous.at || 0) < IDENTICAL_BLOCKS_WINDOW_MS;
  const count = repeated ? Number(previous.count || 0) + 1 : 1;
  if (count > MAX_IDENTICAL_BLOCKS) return { block: false, reason, note, state: { hash, count, at: repeated ? previous.at : now } };
  return { block: true, reason, note, state: { hash, count, at: now } };
}

/** The reason without the counts that change between stops ("indietro di 4 commit", "(3) file"), to compare suggestions. */
export function normalizeReason(reason) {
  return String(reason).replace(/indietro di \d+ commit/gu, "indietro di N commit").replace(/\(\d+\)/gu, "(N)");
}

const PARENT_KINDS = new Set(["epic", "parent", "umbrella"]);

function isSuperseded(requirements, id) {
  const requirement = requirements.get(id);
  if (!requirement) return false;
  if (String(requirement.status ?? "").toLowerCase() === "superseded") return true;
  const logical = requirement.logical_id ?? id;
  return [...requirements.values()].some((other) => (other.logical_id ?? other.id) === logical && Number(other.revision) > Number(requirement.revision));
}

/**
 * Claims, questions, and available stories of this computer, from local files
 * only. `roots` lists every worktree of the repository (the first is `root`):
 * a claim made from a sibling worktree is this computer's work too. `base`
 * carries what the remote base branch records ({ closed: Set, claims: [{ claim, completedSteps }] })
 * and `heldRefs` the stories with an active claim ref (any holder).
 */
export function collectWork(root, { env = process.env, now = Date.now(), messagingState = null, self = null, selfHost = null, selfEmail = null, ownsClaim = null, roots = [], base = null, heldRefs = null, working = {}, behind = null, update = null, outbox = null } = {}) {
  const allRoots = [root, ...roots.filter((other) => other && other !== root)];
  const entries = new Map();
  const gates = new Set();
  const edges = [];
  const delivered = new Set();
  const requirements = new Map();
  for (const current of allRoots) {
    const sdlc = path.join(current, ".sdlc");
    for (const name of listDir(path.join(sdlc, "gates"))) gates.add(name);
    for (const edge of readJson(path.join(sdlc, "dependencies", "graph.json"))?.edges ?? []) edges.push(edge);
    for (const name of listDir(path.join(sdlc, "reports"))) if (name.endsWith("-lifecycle-complete.json")) delivered.add(name.slice(0, -"-lifecycle-complete.json".length));
    for (const name of listDir(path.join(sdlc, "requirements"))) {
      const record = name.endsWith(".json") ? readJson(path.join(sdlc, "requirements", name)) : null;
      if (record?.id && !requirements.has(record.id)) requirements.set(record.id, record);
    }
    for (const storyId of listDir(path.join(sdlc, "stories"))) {
      const storyDir = path.join(sdlc, "stories", storyId);
      if (!entries.has(storyId)) entries.set(storyId, { story: null, claims: [], closed: false });
      const entry = entries.get(storyId);
      entry.story ||= readJson(path.join(storyDir, "story.json"));
      entry.closed ||= fs.existsSync(path.join(storyDir, "closure.json"));
      const claim = readJson(path.join(storyDir, "claim.json"));
      if (claim) {
        const completedSteps = listDir(path.join(storyDir, "steps"))
          .filter((name) => name.endsWith(".json"))
          .filter((name) => String(readJson(path.join(storyDir, "steps", name))?.status ?? "") === "completed")
          .map((name) => name.slice(0, -".json".length));
        entry.claims.push({ claim, completedSteps, root: current });
      }
    }
  }
  for (const storyId of base?.closed ?? []) {
    if (!entries.has(storyId)) entries.set(storyId, { story: null, claims: [], closed: false });
    entries.get(storyId).closed = true;
  }
  for (const item of base?.claims ?? []) {
    const storyId = item.claim?.story_id;
    if (!storyId) continue;
    if (!entries.has(storyId)) entries.set(storyId, { story: null, claims: [], closed: false });
    entries.get(storyId).claims.push(item);
  }
  const ids = [...entries.keys()];
  // Cheap dependency check: every blocking dependency of the story is closed or certified.
  const unmetDependency = (storyId) => edges.find((edge) => edge.from === storyId && edge.type !== "relates"
    && !entries.get(edge.to)?.closed && !gates.has(`${edge.to}-final.json`));
  const claims = [];
  const available = [];
  const human = [];
  for (const storyId of ids.sort()) {
    const { story, claims: records, closed } = entries.get(storyId);
    const certified = gates.has(`${storyId}-final.json`);
    const live = records.filter((item) => !CLOSED_CLAIM_STATUSES.has(String(item.claim.status ?? "").toLowerCase()));
    if (live.length > 0) {
      if (certified || closed) continue;
      // The story advances in its own worktree: the most advanced record wins (main first on a tie).
      const mine = live.filter((item) => !ownsClaim || ownsClaim(item.claim))
        .reduce((best, item) => (!best || item.completedSteps.length > best.completedSteps.length ? item : best), null);
      if (!mine) continue;
      const expires = Date.parse(mine.claim.expires_at ?? "");
      if (Number.isFinite(expires) && expires < now) {
        human.push(`claim di ${storyId} scaduta: serve una persona per rinnovarla o forzarla`);
        continue;
      }
      const next = nextStoryStep({ storyId, completedSteps: mine.completedSteps, strictGate: gates.has(`${storyId}-strict.json`) });
      const unmet = unmetDependency(storyId);
      const status = String(mine.claim.status ?? "").toLowerCase();
      const waiting = WAITING_CLAIM_STATUSES.has(status) ? `claim ${status}`
        : unmet ? `dipendenza ${unmet.to} non ancora mergiata` : null;
      const derived = (story?.derived_acceptance ?? []).map((criterion) => criterion?.id).filter(Boolean);
      const item = { storyId, next, ...(mine.root ? { root: mine.root } : {}), ...(derived.length > 0 ? { derived } : {}), ...(waiting ? { waiting } : {}) };
      const delegated = working?.[storyId];
      if (delegated) item.delegated = delegated;
      if (behind?.[storyId] > 0 && BEHIND_PHASES.has(next.phase)) item.behind = behind[storyId];
      claims.push(item);
      continue;
    }
    if (!story || certified || closed || delivered.has(storyId) || gates.has(`${storyId}-strict.json`) || heldRefs?.has(storyId)) continue;
    if (!isOpenStoryKind(story)) continue;
    if (ids.some((other) => other !== storyId && other.startsWith(storyId) && /^[A-Za-z]{1,2}$/u.test(other.slice(storyId.length)))) continue;
    if ((story.requirement_refs ?? []).some((ref) => isSuperseded(requirements, ref?.id))) continue;
    if (isFreshForeignStory(story, { selfHost: selfHost ?? self, selfEmail, now, windowMs: foreignWindowMs(env) })) continue;
    available.push(storyId);
  }
  const ready = available.filter((storyId) => !unmetDependency(storyId)).sort();
  return { claims, questions: pendingQuestions(messagingState, self, outbox?.items), outbox: outbox && outbox.items?.length > 0 ? { count: outbox.items.length, reason: outbox.reason, notified: outbox.notified } : null, available: available.sort(), ready, update, joined: recentJoins(messagingState, self, now), human };
}

const JOIN_NOTE_MS = 15 * 60_000;

/** Computers that joined the channel in the last minutes (not this one), as notes. */
export function recentJoins(messagingState, self, now = Date.now()) {
  const window = Array.isArray(messagingState?.attention?.window) ? messagingState.attention.window : [];
  const own = new Set(Array.isArray(messagingState?.own) ? messagingState.own.map(String) : []);
  return window
    .filter((m) => m.kind === "join" && m.from !== self && !own.has(String(m.id)) && now - Date.parse(m.time ?? "") < JOIN_NOTE_MS)
    .map((m) => `${m.from ?? m.host ?? "un computer"} si è unito al canale (versione ${m.version ?? "?"})`);
}

/** True when the story is neither closed/blocked/draft nor a parent container. */
export function isOpenStoryKind(story) {
  return !CLOSED_STORY_STATUSES.has(String(story?.status ?? "").toLowerCase()) && !PARENT_KINDS.has(String(story?.kind ?? story?.type ?? "").toLowerCase());
}

/** Switch of the foreign-story check (env hours: default 3, any positive value keeps it on, 0 disables). */
export function foreignWindowMs(env = process.env) {
  const raw = String(env[FOREIGN_HOURS_ENV] ?? "").trim();
  const hours = raw === "" ? DEFAULT_FOREIGN_HOURS : Number(raw);
  return (Number.isFinite(hours) && hours >= 0 ? hours : DEFAULT_FOREIGN_HOURS) * 3600 * 1000;
}

/** Explicit release of a story to any computer: `unassigned: true` or `free: true` on the story record. */
function isMarkedFree(story) {
  return story?.unassigned === true || story?.free === true;
}

/**
 * True when the story was created by another computer, however long ago (unless
 * the record is marked `unassigned`/`free`): it belongs to its creator, so it is
 * not offered here. `windowMs` only switches the check on (0 turns it off). The creator
 * is the host recorded at creation (audit.run.host), else the git e-mail of the
 * author; with neither (or no own identity to compare, or no creation time) the
 * story is not treated as foreign. Nothing is claimed or reserved for anyone.
 */
export function isFreshForeignStory(story, { selfHost = null, selfEmail = null, now = Date.now(), windowMs = 0 } = {}) {
  if (!(windowMs > 0)) return false;
  if (isMarkedFree(story)) return false;
  const host = story?.audit?.run?.host;
  if (typeof host === "string" && host && selfHost) return host !== selfHost;
  const email = story?.audit?.git?.user?.email;
  if (typeof email === "string" && email && selfEmail) return email.toLowerCase() !== String(selfEmail).toLowerCase();
  return false;
}

/** Questions/requests to this computer (or everyone) not yet answered by it, from the cached message window. */
export function pendingQuestions(messagingState, self, queued = []) {
  // An answer waiting in the outbox settles its question: it is being answered.
  const answering = new Set((queued ?? []).map((item) => item?.message?.replyTo).filter(Boolean).map(String));
  const window = Array.isArray(messagingState?.attention?.window) ? messagingState.attention.window : [];
  const own = new Set(Array.isArray(messagingState?.own) ? messagingState.own.map(String) : []);
  // Every name this computer has sent under, including manual --sender names.
  const names = new Set([self, ...window.filter((m) => own.has(String(m.id))).flatMap((m) => [m.from, m.host, m.gh_login])].filter(Boolean));
  return unansweredForMe(window, { names, own })
    .filter((m) => !answering.has(String(m.id)))
    .map((m) => ({ id: m.id, from: m.from, text: String(m.text ?? "").replace(/\s+/gu, " ").trim().slice(0, 120) }));
}

async function ownHost(env) {
  try {
    return (await import("../messaging/commands.mjs")).hostLabel(env);
  } catch {
    return null;
  }
}

async function messagingContext(root, env) {
  try {
    const { settingsFor } = await import("../messaging/attention.mjs");
    const { senderLabel } = await import("../messaging/commands.mjs");
    const settings = settingsFor(root, env);
    if (!settings) return { messagingState: null, self: null, update: null, outbox: null };
    const messagingState = readJson(settings.statePath);
    const window = Array.isArray(messagingState?.attention?.window) ? messagingState.attention.window : [];
    const self = senderLabel({ root }, env);
    const own = new Set(Array.isArray(messagingState?.own) ? messagingState.own.map(String) : []);
    const update = newerVersionSeen(window.filter((m) => identityOf(m) !== self && m.from !== self && !own.has(String(m.id))), VERSION);
    const { readOutbox } = await import("../messaging/outbox.mjs");
    return { messagingState, self, update, outbox: readOutbox(root) };
  } catch {
    return { messagingState: null, self: null, update: null, outbox: null };
  }
}

/** Work and next steps for a project root (used by the Stop hook and `agentic-sdlc next`). */
export async function keepGoingWork(root, { env = process.env, now = Date.now() } = {}) {
  const roots = worktreeRoots(root);
  const selfHost = await ownHost(env);
  const selfEmail = gitLines(root, ["config", "user.email"])?.[0] ?? null;
  const ownsClaim = await claimOwnership(roots.length > 0 ? roots : [root], { selfHost, selfEmail });
  const base = baseRecords(root);
  const messaging = await messagingContext(root, env);
  const work = collectWork(root, { env, now, ownsClaim, roots, base, heldRefs: heldClaimRefs(root), working: activeWorking(root, now), selfHost, selfEmail, ...messaging });
  const requests = personRequests(messaging.messagingState);
  work.claims = work.claims.map((claim) => {
    const dir = claim.root ?? root;
    return withPersonRequest(withWorktreeProgress(claim, { behind: commitsBehindDir(dir), progress: deliveryProgress(dir) }), requests);
  });
  return { unpublished: unpublishedRecords(root), ...work };
}

const PERSON_COMMAND = /agentic-sdlc\s+autonomy\s+delivery\s+(?:reconcile|amend)\b[^`\n]*|agentic-sdlc\s+[a-z -]*evidence\s+supersede\b[^`\n]*/iu;

/**
 * Requests this computer already sent to a person and nobody answered yet,
 * naming a step only a person runs (reconcile, evidence supersede, amend).
 * [{ text, command }]
 */
export function personRequests(messagingState) {
  const window = Array.isArray(messagingState?.attention?.window) ? messagingState.attention.window : [];
  const own = new Set(Array.isArray(messagingState?.own) ? messagingState.own.map(String) : []);
  const answered = new Set(window.filter((m) => m.reply_to && (m.kind === "answer" || m.kind === "ack")).map((m) => String(m.reply_to)));
  return window
    .filter((m) => m.kind === "request" && own.has(String(m.id)) && !answered.has(String(m.id)))
    .map((m) => ({ text: String(m.text ?? ""), command: PERSON_COMMAND.exec(String(m.text ?? ""))?.[0]?.trim() }))
    .filter((request) => request.command);
}

/** A claim whose step needs a person and already has an open request waits for that person; it does not block. */
export function withPersonRequest(claim, requests = []) {
  if (!/^(?:validation|release|operations)$/u.test(claim.next?.phase ?? "")) return claim;
  const found = requests.find((request) => request.text.includes(claim.storyId));
  return found ? { ...claim, awaitingPerson: { command: found.command } } : claim;
}

/**
 * Governed delivery state of the story's worktree: whether a completed
 * git.commit receipt exists for the current head on the current branch,
 * and whether it was pushed and a pull request opened. Local files and git only.
 */
export function deliveryProgress(dir) {
  const branch = gitLines(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"])?.[0];
  const head = gitLines(dir, ["rev-parse", "--verify", "--quiet", "HEAD"])?.[0];
  if (!branch || !head) return { committed: false, pushed: false, pullRequest: false, profile: null };
  const receipts = [];
  const actions = path.join(dir, ".sdlc", "autonomy", "actions");
  for (const name of listDir(actions).filter((file) => file.endsWith(".json")).sort().slice(-600)) {
    const receipt = readJson(path.join(actions, name));
    if (receipt?.status === "completed" && receipt.outcome === "passed" && receipt.runtime_target?.branch === branch) receipts.push(receipt);
  }
  const profile = receipts.at(-1)?.profile_ref?.id ?? null;
  const committed = receipts.some((receipt) => receipt.action === "git.commit" && receipt.action_details?.commit?.after_sha === head);
  if (!committed) return { committed, pushed: false, pullRequest: false, profile };
  const pushed = (gitLines(dir, ["branch", "-r", "--contains", head]) ?? []).some((line) => line.endsWith(`/${branch}`));
  const pullRequest = receipts.some((receipt) => receipt.action === "pull_request.create" && receipt.runtime_target?.head_sha === head);
  return { committed, pushed, pullRequest, profile };
}

/**
 * Next step of a claim given its worktree: with the governed commit already
 * made for the current head, no sync is proposed (a rebase would change its
 * SHA) and the release step names what is really left. Pure.
 */
export function withWorktreeProgress(claim, { behind = 0, progress = null } = {}) {
  const { behind: _stale, ...rest } = claim;
  const committed = progress?.committed === true;
  const out = { ...rest };
  if (!committed && behind > 0 && BEHIND_PHASES.has(claim.next?.phase)) out.behind = behind;
  if (committed && claim.next?.phase === "release") {
    const profile = progress.profile ?? "<profile-id>";
    if (!progress.pushed) {
      out.next = { ...claim.next, label: "git.commit governato gia' fatto per l'head corrente (NON fare `story sync`): esegui il push governato", command: `agentic-sdlc autonomy delivery action --id ${profile} --action git.push` };
    } else if (!progress.pullRequest) {
      out.next = { ...claim.next, label: "commit e push gia' fatti (NON fare `story sync`): authorize e `gh pr create` subito di seguito, senza passi in mezzo", command: `agentic-sdlc autonomy delivery action --id ${profile} --action pull_request.create` };
    } else {
      out.next = { ...claim.next, label: "commit, push e PR gia' fatti (NON fare `story sync`): attendi review/merge, poi completa il rilascio (dopo complete-step validation rilancia `gate check --strict` e poi `workflow instance transition --request-id`)" };
    }
  }
  return out;
}

/** Commits one worktree lacks from the fetched remote base (0 when unknown). */
export function commitsBehindDir(dir) {
  const ref = remoteBaseRef(dir);
  return ref ? Number(gitLines(dir, ["rev-list", "--count", `HEAD..${ref}`])?.[0] ?? 0) : 0;
}

/**
 * Commits a worktree lacks from the fetched remote base, attributed to the
 * stories it holds a claim file for. Local git only. { storyId: count }
 */
export function commitsBehindBase(root, roots = []) {
  const result = {};
  for (const current of [root, ...roots.filter((other) => other !== root)]) {
    const ref = remoteBaseRef(current);
    if (!ref) continue;
    const stories = listDir(path.join(current, ".sdlc", "stories")).filter((id) => fs.existsSync(path.join(current, ".sdlc", "stories", id, "claim.json")));
    if (stories.length === 0) continue;
    const count = Number(gitLines(current, ["rev-list", "--count", `HEAD..${ref}`])?.[0] ?? 0);
    if (count > 0) for (const id of stories) result[id] ??= count;
  }
  return result;
}

/**
 * Predicate over a claim file: true when the claim is this computer's work,
 * whatever worktree, branch or agent name made it. In order: the host the
 * claim records (audit.run.host) equals this computer's; this clone holds the
 * ownership proof of the shared claim (looked for in every worktree); for a
 * claim that records no host, the git e-mail of its author equals this
 * computer's. A claim that records a different host is another computer's;
 * a local (never shared) claim without any identity is assumed to be ours.
 */
export async function claimOwnership(roots, { selfHost = null, selfEmail = null } = {}) {
  let ownsShared = null;
  try {
    ({ ownsSharedClaim: ownsShared } = await import("../engine/story-claim-shared.mjs"));
  } catch {
    ownsShared = null;
  }
  return (claim) => {
    const host = claim?.audit?.run?.host;
    const hasHost = typeof host === "string" && host !== "";
    if (hasHost && selfHost && host === selfHost) return true;
    if (claim?.shared_claim?.scope === "shared" && ownsShared && roots.some((root) => {
      try {
        return ownsShared({ root }, claim.shared_claim, GIT_TIMEOUT_MS / 1000) === true;
      } catch {
        return false;
      }
    })) return true;
    if (hasHost && selfHost) return false;
    const email = claim?.audit?.git?.user?.email;
    if (typeof email === "string" && email && selfEmail) return email.toLowerCase() === String(selfEmail).toLowerCase();
    return claim?.shared_claim?.scope !== "shared";
  };
}

/** Every worktree folder of the repository `root` belongs to (empty when git cannot say). */
function worktreeRoots(root) {
  const lines = gitLines(root, ["worktree", "list", "--porcelain"]) ?? [];
  return lines.filter((line) => line.startsWith("worktree ")).map((line) => line.slice("worktree ".length)).filter((dir) => fs.existsSync(dir));
}

export function remoteBaseRef(root, sdlcFolder = ".sdlc") {
  const config = readJson(path.join(root, sdlcFolder, "config.json")) ?? {};
  const remote = safeGitRemoteName(config.orchestration_policy?.coordination?.remote, root).remote;
  if (!remote) return null;
  const branch = config.orchestration_policy?.merge_drift?.base_branch || "main";
  const ref = `refs/remotes/${remote}/${branch}`;
  return gitLines(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]) ? ref : null;
}

export function gitShowJson(root, spec) {
  try {
    const result = childProcess.spawnSync("git", ["-C", root, "show", spec], { encoding: "utf8", timeout: GIT_TIMEOUT_MS, windowsHide: true });
    return result.status === 0 ? JSON.parse(result.stdout) : null;
  } catch {
    return null;
  }
}

/** Closed stories and claim records on the last fetched remote base branch (local git only). */
export function baseRecords(root, { sdlcFolder = ".sdlc" } = {}) {
  const ref = remoteBaseRef(root, sdlcFolder);
  if (!ref) return null;
  const files = gitLines(root, ["ls-tree", "-r", "--name-only", ref, "--", `${sdlcFolder}/stories`]) ?? [];
  const closed = [];
  const claims = [];
  for (const file of files) {
    const match = new RegExp(`^${sdlcFolder.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}/stories/([^/]+)/(closure|claim)\\.json$`, "u").exec(file);
    if (!match) continue;
    if (match[2] === "closure") {
      closed.push(match[1]);
      continue;
    }
    const claim = gitShowJson(root, `${ref}:${file}`);
    if (!claim || CLOSED_CLAIM_STATUSES.has(String(claim.status ?? "").toLowerCase())) continue;
    const prefix = `${sdlcFolder}/stories/${match[1]}/steps/`;
    const completedSteps = files.filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
      .filter((name) => String(gitShowJson(root, `${ref}:${name}`)?.status ?? "") === "completed")
      .map((name) => name.slice(prefix.length, -".json".length));
    claims.push({ claim: { story_id: match[1], ...claim }, completedSteps });
  }
  return { closed, claims };
}

/** Stories whose latest claim ref (any holder, fetched locally) has no release: held by someone. */
export function heldClaimRefs(root) {
  const refs = gitLines(root, ["for-each-ref", "--format=%(refname)", "refs/agentic-sdlc-shared/claims", "refs/agentic-sdlc/claims"]) ?? [];
  const latest = new Map();
  for (const ref of refs) {
    const match = /\/claims\/(?:[0-9a-f]{16}\/)?([^/]+)\/([0-9]{6})\/(claim|release)$/u.exec(ref);
    if (!match) continue;
    const [, storyId, epoch, kind] = match;
    const seen = latest.get(storyId);
    if (!seen || epoch > seen.epoch) latest.set(storyId, { epoch, released: kind === "release" });
    else if (epoch === seen.epoch && kind === "release") seen.released = true;
  }
  return new Set([...latest].filter(([, item]) => !item.released).map(([storyId]) => storyId));
}

export function gitLines(root, args) {
  try {
    const result = childProcess.spawnSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
      windowsHide: true,
    });
    if (result.status !== 0 || result.error) return null;
    return String(result.stdout).split("\n").map((line) => line.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * Story records this clone has and the remote base branch does not: local
 * commits or uncommitted/untracked changes under the records folder whose
 * content differs from the last fetched remote base. Local git only (no
 * fetch), bounded by a short timeout. Returns [{ storyId, base, files, command }].
 */
export function unpublishedRecords(root, { sdlcFolder = ".sdlc" } = {}) {
  const config = readJson(path.join(root, sdlcFolder, "config.json")) ?? {};
  const remote = safeGitRemoteName(config.orchestration_policy?.coordination?.remote, root).remote;
  if (!remote) return [];
  let branch = config.orchestration_policy?.merge_drift?.base_branch || null;
  if (!branch) {
    const head = gitLines(root, ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`])?.[0] ?? "";
    branch = head.startsWith(`${remote}/`) ? head.slice(remote.length + 1) : "main";
  }
  const baseRef = `refs/remotes/${remote}/${branch}`;
  if (!gitLines(root, ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`])) return [];
  const forkPoint = gitLines(root, ["merge-base", "HEAD", baseRef])?.[0];
  if (!forkPoint) return [];
  // Changed here since the fork point and still different from the base.
  const sinceFork = new Set(gitLines(root, ["diff", "--name-only", "--no-renames", "--diff-filter=AM", forkPoint, "--", sdlcFolder]) ?? []);
  const vsBase = new Set(gitLines(root, ["diff", "--name-only", "--no-renames", baseRef, "--", sdlcFolder]) ?? []);
  const files = [...sinceFork].filter((file) => vsBase.has(file));
  const untracked = gitLines(root, ["ls-files", "--others", "--exclude-standard", "--", sdlcFolder]) ?? [];
  if (untracked.length > 0) {
    const onBase = new Set(gitLines(root, ["ls-tree", "-r", "--name-only", baseRef, "--", sdlcFolder]) ?? []);
    files.push(...untracked.filter((file) => !onBase.has(file)));
  }
  const storyIds = listDir(path.join(root, sdlcFolder, "stories"));
  const byStory = new Map();
  for (const file of files) {
    for (const storyId of storyIds) {
      if (classifyStoryRecordPath(file, { sdlcFolder, storyId, storyIds }) !== "own") continue;
      if (!byStory.has(storyId)) byStory.set(storyId, []);
      byStory.get(storyId).push(file);
    }
  }
  return [...byStory.keys()].sort().map((storyId) => ({
    storyId,
    base: `${remote}/${branch}`,
    files: byStory.get(storyId).sort(),
    command: `agentic-sdlc story publish-records --id ${storyId} --to-base`,
  }));
}

/** Stop hook: returns the host output object, or null to let the turn end. */
export async function keepGoingStop(root, payload = {}, { env = process.env, commonDir = null } = {}) {
  if (keepGoingDisabled(env)) return null;
  const work = await keepGoingWork(root, { env });
  const statePath = commonDir ? path.join(commonDir, "agentic-sdlc", KEEP_GOING_STATE_FILE) : null;
  const previous = (statePath && readJson(statePath)) || {};
  const decision = decideKeepGoing({ ...work, previous, label: (id) => storyLabel(root, id, env) });
  if (statePath) {
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, `${JSON.stringify(decision.state)}\n`, { mode: 0o600 });
    } catch {
      // loop safety is best effort; the host's own limits still apply
    }
  }
  if (work.outbox && work.outbox.notified !== true) {
    try {
      (await import("../messaging/outbox.mjs")).markNotified(root);
    } catch {
      // The notice may repeat; nothing else depends on it.
    }
  }
  if (decision.block) return { decision: "block", reason: decision.reason };
  // Idle: do not stop silently; ask once to arm a background watch (see watch.mjs).
  try {
    const { watchPromptDecision } = await import("./watch.mjs");
    const reason = watchPromptDecision(commonDir, { env });
    if (reason) return { decision: "block", reason };
  } catch {
    // advisory only: the stop goes through
  }
  if (decision.note) return { systemMessage: decision.note };
  return null;
}
