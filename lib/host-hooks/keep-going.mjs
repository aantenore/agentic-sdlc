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
 *   AGENTIC_SDLC_KEEP_GOING_FOREIGN_HOURS=<n>   hours a story created by another computer
 *                                 is not proposed (default 3); 0 proposes it at once
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
export const IDENTICAL_BLOCKS_WINDOW_MS = 10 * 60 * 1000;
export const LIFECYCLE_STEPS = Object.freeze(["discovery", "analysis", "design", "implementation", "validation", "release", "operations"]);
const OFF_VALUES = new Set(["0", "false", "no", "off", "disabled"]);
const CLOSED_CLAIM_STATUSES = new Set(["released", "transferred", "completed", "cancelled", "expired"]);
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
 *   available  [storyId] stories nobody holds, not closed, delivered, superseded or parent
 *   ready      [storyId] subset of available whose dependencies are satisfied (defaults to available)
 *   update     { version, from } newer plugin announced by another computer
 *   human      [text] items waiting on a person (never block on these)
 *   unpublished [{ storyId, base, files, command }] local records not on the remote base
 */
export function decideKeepGoing({ unpublished = [], claims = [], questions = [], available = [], ready = null, update = null, human = [], previous = {}, now = Date.now(), disabled = false } = {}) {
  if (disabled) return { block: false, reason: null, note: null, state: previous };
  const notes = [];
  if (human.length > 0) notes.push(`In attesa di una decisione umana: ${human.slice(0, MAX_ITEMS).join("; ")}`);
  const candidates = ready ?? available;
  const lines = [];
  for (const question of questions.slice(0, MAX_ITEMS)) {
    lines.push(`- rispondi a ${question.from || "un altro computer"} (${question.text}) -> \`agentic-sdlc message send --kind answer --reply-to ${question.id} --text "<risposta>"\``);
  }
  for (const item of unpublished.slice(0, MAX_ITEMS)) {
    lines.push(`- ${item.storyId}: record non pubblicati su ${item.base} (${item.files.length}), pubblicali prima di tutto -> \`${item.command}\``);
  }
  if (update) {
    lines.push(`- plugin ${update.version} disponibile (annunciato da ${update.from || "un altro computer"}; installato ${VERSION}): l'aggiornamento ha priorita', aggiorna prima di proseguire -> \`${UPDATE_COMMAND}\` poi \`/reload-plugins\``);
  }
  const idle = [];
  for (const claim of claims.slice(0, MAX_ITEMS)) {
    if (claim.delegated) {
      idle.push(claim);
      notes.push(`${claim.storyId}: lavoro delegato in corso fino a ${claim.delegated.until}${claim.delegated.reason ? ` (${claim.delegated.reason})` : ""}, nessun passo da fare per ora`);
      continue;
    }
    if (claim.waiting) {
      idle.push(claim);
      notes.push(`${claim.storyId}: in attesa (${claim.waiting})`);
      continue;
    }
    if (claim.behind > 0) {
      lines.push(`- ${claim.storyId}: il worktree e' indietro di ${claim.behind} commit rispetto alla base, allinea PRIMA del git.commit governato (un rebase dopo il commit ne cambia lo SHA e invalida la ricevuta) -> \`agentic-sdlc story sync --id ${claim.storyId}\``);
    }
    lines.push(`- ${claim.storyId}: ${claim.next.label} -> \`${claim.next.command}\``);
    if (claim.derived?.length > 0) {
      lines.push(`- ${claim.storyId}: oltre ai criteri espliciti produci le verifiche derivate (${claim.derived.join(", ")}) e registrale con \`agentic-sdlc test record --story ${claim.storyId} --acceptance <id> ...\``);
    }
  }
  // Everything above needs this computer; what follows is only a suggestion.
  const firmLines = lines.length;
  // Waiting or delegated is not idle: take parallel work.
  const parallel = candidates[0];
  if (idle.length > 0 && parallel) {
    lines.push(`- ${idle.map((claim) => claim.storyId).join(", ")} non richiede te adesso: lavora in parallelo su ${parallel} -> \`agentic-sdlc story claim --id ${parallel} --agent <nome>\``);
  }
  // Look-ahead: reserve the next story while the current one is being released.
  const reserve = candidates.find((id) => !(idle.length > 0 && id === parallel));
  const releasing = claims.some((claim) => !claim.waiting && !claim.delegated && LOOK_AHEAD_PHASES.has(claim.next?.phase));
  if (releasing && reserve) {
    lines.push(`- la story in corso e' al rilascio: prenota la prossima (${reserve}) per continuare subito dopo la certificazione -> \`agentic-sdlc story reserve --id ${reserve} --agent <nome>\``);
  }
  if (lines.length === 0 && claims.length === 0 && available.length > 0) {
    lines.push(`- nessuna claim attiva; story disponibili: ${candidates.slice(0, MAX_ITEMS).join(", ") || available.slice(0, MAX_ITEMS).join(", ")} -> verifica dipendenze con \`agentic-sdlc status\`, poi \`agentic-sdlc story claim --id <story-id> --agent <nome>\``);
  }
  const note = notes.length > 0 ? notes.join("; ") : null;
  if (lines.length === 0) return { block: false, reason: null, note, state: {} };
  const reason = `C'e' ancora lavoro su questo computer, continua con il prossimo passo:\n${lines.join("\n")}`
    + (note ? `\n${note} (non bloccante).` : "");
  const hash = crypto.createHash("sha256").update(reason).digest("hex");
  // Only a suggestion, already shown at the last Stop: inform, do not block again.
  if (firmLines === 0 && previous.hash === hash && now - Number(previous.at || 0) < IDENTICAL_BLOCKS_WINDOW_MS) {
    return { block: false, reason, note: `Suggerimento gia' mostrato, non blocco di nuovo:\n${lines.join("\n")}`, state: previous };
  }
  // Loop safety, independent of what the host reports: the same reason blocked
  // MAX_IDENTICAL_BLOCKS times within the window lets the turn end.
  const repeated = previous.hash === hash && now - Number(previous.at || 0) < IDENTICAL_BLOCKS_WINDOW_MS;
  const count = repeated ? Number(previous.count || 0) + 1 : 1;
  if (count > MAX_IDENTICAL_BLOCKS) return { block: false, reason, note, state: { hash, count, at: repeated ? previous.at : now } };
  return { block: true, reason, note, state: { hash, count, at: now } };
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
export function collectWork(root, { env = process.env, now = Date.now(), messagingState = null, self = null, selfHost = null, selfEmail = null, ownsClaim = null, roots = [], base = null, heldRefs = null, working = {}, behind = null, update = null } = {}) {
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
        entry.claims.push({ claim, completedSteps });
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
      const mine = live.find((item) => !ownsClaim || ownsClaim(item.claim));
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
      const item = { storyId, next, ...(derived.length > 0 ? { derived } : {}), ...(waiting ? { waiting } : {}) };
      const delegated = working?.[storyId];
      if (delegated) item.delegated = delegated;
      if (behind?.[storyId] > 0 && BEHIND_PHASES.has(next.phase)) item.behind = behind[storyId];
      claims.push(item);
      continue;
    }
    if (!story || certified || closed || delivered.has(storyId) || gates.has(`${storyId}-strict.json`) || heldRefs?.has(storyId)) continue;
    if (CLOSED_STORY_STATUSES.has(String(story.status ?? "").toLowerCase()) || PARENT_KINDS.has(String(story.kind ?? story.type ?? "").toLowerCase())) continue;
    if (ids.some((other) => other !== storyId && other.startsWith(storyId) && /^[A-Za-z]{1,2}$/u.test(other.slice(storyId.length)))) continue;
    if ((story.requirement_refs ?? []).some((ref) => isSuperseded(requirements, ref?.id))) continue;
    if (isFreshForeignStory(story, { selfHost: selfHost ?? self, selfEmail, now, windowMs: foreignWindowMs(env) })) continue;
    available.push(storyId);
  }
  const ready = available.filter((storyId) => !unmetDependency(storyId)).sort();
  return { claims, questions: pendingQuestions(messagingState, self), available: available.sort(), ready, update, human };
}

/** Hours a story created by another computer stays out of the suggestions (env, default 3; 0 disables). */
export function foreignWindowMs(env = process.env) {
  const raw = String(env[FOREIGN_HOURS_ENV] ?? "").trim();
  const hours = raw === "" ? DEFAULT_FOREIGN_HOURS : Number(raw);
  return (Number.isFinite(hours) && hours >= 0 ? hours : DEFAULT_FOREIGN_HOURS) * 3600 * 1000;
}

/**
 * True when the story was created by another computer less than `windowMs` ago:
 * its creator probably claims it next, so it is not offered here. The creator
 * is the host recorded at creation (audit.run.host), else the git e-mail of the
 * author; with neither (or no own identity to compare, or no creation time) the
 * story is not treated as foreign. Nothing is claimed or reserved for anyone.
 */
export function isFreshForeignStory(story, { selfHost = null, selfEmail = null, now = Date.now(), windowMs = 0 } = {}) {
  if (!(windowMs > 0)) return false;
  const created = Date.parse(story?.created_at ?? "");
  if (!Number.isFinite(created) || now - created >= windowMs) return false;
  const host = story?.audit?.run?.host;
  if (typeof host === "string" && host && selfHost) return host !== selfHost;
  const email = story?.audit?.git?.user?.email;
  if (typeof email === "string" && email && selfEmail) return email.toLowerCase() !== String(selfEmail).toLowerCase();
  return false;
}

/** Questions/requests to this computer (or everyone) not yet answered by it, from the cached message window. */
export function pendingQuestions(messagingState, self) {
  const window = Array.isArray(messagingState?.attention?.window) ? messagingState.attention.window : [];
  const own = new Set(Array.isArray(messagingState?.own) ? messagingState.own.map(String) : []);
  // Every name this computer has sent under, including manual --sender names.
  const names = new Set([self, ...window.filter((m) => own.has(String(m.id))).flatMap((m) => [m.from, m.host])].filter(Boolean));
  return unansweredForMe(window, { names, own })
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
    if (!settings) return { messagingState: null, self: null, update: null };
    const messagingState = readJson(settings.statePath);
    const window = Array.isArray(messagingState?.attention?.window) ? messagingState.attention.window : [];
    const self = senderLabel({}, env);
    const own = new Set(Array.isArray(messagingState?.own) ? messagingState.own.map(String) : []);
    const update = newerVersionSeen(window.filter((m) => identityOf(m) !== self && m.from !== self && !own.has(String(m.id))), VERSION);
    return { messagingState, self, update };
  } catch {
    return { messagingState: null, self: null, update: null };
  }
}

/** Work and next steps for a project root (used by the Stop hook and `agentic-sdlc next`). */
export async function keepGoingWork(root, { env = process.env, now = Date.now() } = {}) {
  const roots = worktreeRoots(root);
  const ownsClaim = await claimOwnership(roots.length > 0 ? roots : [root]);
  const base = baseRecords(root);
  const messaging = await messagingContext(root, env);
  return {
    unpublished: unpublishedRecords(root),
    ...collectWork(root, { env, now, ownsClaim, roots, base, heldRefs: heldClaimRefs(root), working: activeWorking(root, now), behind: commitsBehindBase(root, roots), selfHost: await ownHost(env), selfEmail: gitLines(root, ["config", "user.email"])?.[0] ?? null, ...messaging }),
  };
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
 * Predicate over a claim file: true when this clone made the shared claim it
 * records (same ownership proof the claim system uses). The proof lives per
 * worktree, so it is looked for in every worktree of the repository. Claims
 * that were never shared are local by nature; when the proof cannot be
 * checked, the claim is not assumed to be ours.
 */
async function claimOwnership(roots) {
  try {
    const { ownsSharedClaim } = await import("../engine/story-claim-shared.mjs");
    return (claim) => {
      if (claim?.shared_claim?.scope !== "shared") return true;
      return roots.some((root) => {
        try {
          return ownsSharedClaim({ root }, claim.shared_claim, GIT_TIMEOUT_MS / 1000) === true;
        } catch {
          return false;
        }
      });
    };
  } catch {
    return (claim) => claim?.shared_claim?.scope !== "shared";
  }
}

/** Every worktree folder of the repository `root` belongs to (empty when git cannot say). */
function worktreeRoots(root) {
  const lines = gitLines(root, ["worktree", "list", "--porcelain"]) ?? [];
  return lines.filter((line) => line.startsWith("worktree ")).map((line) => line.slice("worktree ".length)).filter((dir) => fs.existsSync(dir));
}

function remoteBaseRef(root, sdlcFolder = ".sdlc") {
  const config = readJson(path.join(root, sdlcFolder, "config.json")) ?? {};
  const remote = config.orchestration_policy?.coordination?.remote || "origin";
  const branch = config.orchestration_policy?.merge_drift?.base_branch || "main";
  const ref = `refs/remotes/${remote}/${branch}`;
  return gitLines(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]) ? ref : null;
}

function gitShowJson(root, spec) {
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

function gitLines(root, args) {
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
  const remote = config.orchestration_policy?.coordination?.remote || "origin";
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
  const decision = decideKeepGoing({ ...work, previous });
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
