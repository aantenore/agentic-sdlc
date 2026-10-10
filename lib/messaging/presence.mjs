import path from "node:path";
import { Date, fs, process } from "../runtime/host.mjs";
import { parseLimitSeconds } from "../runtime/bounded-child-process.mjs";
import { VERSION } from "../engine/definitions.mjs";
import { AUTO_ENV } from "./auto.mjs";
import { settingsFor } from "./attention.mjs";
import { hostLabel, PROVIDERS, resolveProvider, senderLabel } from "./commands.mjs";
import { findGitCommonDir } from "../runtime/run-registry.mjs";

/**
 * Periodic presence from the host hook, so the other computers know what this
 * one is doing without asking. While this clone holds active story claims it
 * sends one `[auto]` status (kind info) per heartbeat interval; with no claim
 * it offers help (kind offer) at most once an hour. Read from local records
 * only (claims and workflow checkpoints); best effort and silent.
 *
 *   AGENTIC_SDLC_MESSAGING_HEARTBEAT_MINUTES   gap between two status messages (default 15, 0 = off)
 *
 * The state lives under `presence` in <git-common-dir>/agentic-sdlc/messaging-auto.json.
 */
export const HEARTBEAT_ENV = "AGENTIC_SDLC_MESSAGING_HEARTBEAT_MINUTES";
export const DEFAULT_HEARTBEAT_MINUTES = 15;
export const OFFER_EVERY_MS = 60 * 60_000;
const MAX_TIMEOUT_MS = 3000;
const LISTED = 3;

export function heartbeatMinutes(env = process.env) {
  const raw = String(env?.[HEARTBEAT_ENV] ?? "").trim();
  if (raw === "") return DEFAULT_HEARTBEAT_MINUTES;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_HEARTBEAT_MINUTES;
}

function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function localBranchExists(commonDir, branch) {
  if (!commonDir || !branch) return false;
  if (fs.existsSync(path.join(commonDir, "refs", "heads", ...String(branch).split("/")))) return true;
  try {
    return fs.readFileSync(path.join(commonDir, "packed-refs"), "utf8").includes(` refs/heads/${branch}\n`);
  } catch {
    return false;
  }
}

/**
 * Active, unexpired claims whose branch exists in this clone (claim records
 * are shared through git, the branch is what ties a claim to this computer),
 * each with its workflow phase and when it was entered.
 */
export function localActiveClaims(root, { now = Date.now(), branchExists } = {}) {
  const commonDir = findGitCommonDir(root);
  const hasBranch = branchExists ?? ((branch) => localBranchExists(commonDir, branch));
  const storiesDir = path.join(root, ".sdlc", "stories");
  let names = [];
  try {
    names = fs.readdirSync(storiesDir);
  } catch {
    return [];
  }
  const claims = [];
  for (const name of names) {
    const claim = readJson(path.join(storiesDir, name, "claim.json"));
    if (!claim || claim.status !== "active") continue;
    const expires = Date.parse(claim.expires_at ?? "");
    if (Number.isFinite(expires) && expires <= now) continue;
    if (!hasBranch(claim.branch)) continue;
    claims.push({ story: String(claim.story_id || name), since: Date.parse(claim.claimed_at ?? "") || null, phase: null });
  }
  if (claims.length === 0) return claims;
  const instancesDir = path.join(root, ".sdlc", "workflows", "instances");
  let instances = [];
  try {
    instances = fs.readdirSync(instancesDir);
  } catch {
    instances = [];
  }
  const byStory = new Map(claims.map((claim) => [claim.story.toUpperCase(), claim]));
  for (const id of instances) {
    const instance = readJson(path.join(instancesDir, id, "instance.json"));
    const claim = byStory.get(String(instance?.metadata?.governance_binding?.story_id ?? "").toUpperCase());
    if (!claim) continue;
    const checkpoint = readJson(path.join(instancesDir, id, "checkpoint.json"));
    if (!checkpoint?.current_state) continue;
    const updated = Date.parse(checkpoint.updated_at ?? "");
    if (claim.phaseSince && Number.isFinite(updated) && updated < claim.phaseSince) continue;
    claim.phase = String(checkpoint.current_state);
    claim.phaseSince = Number.isFinite(updated) ? updated : null;
  }
  return claims.sort((a, b) => a.story.localeCompare(b.story));
}

function describe(claim, now) {
  const since = claim.phaseSince ?? claim.since;
  const minutes = Number.isFinite(since) ? Math.max(0, Math.floor((now - since) / 60_000)) : null;
  return `${claim.story}${claim.phase ? ` in fase ${claim.phase}` : ""}${minutes !== null ? ` da ${minutes} min` : ""}`;
}

/**
 * Pure choice of the presence message, or null. `presence` is the stored
 * state: `last_status` and `last_offer` times.
 */
export function selectPresence({ claims, presence = {}, now = Date.now(), heartbeatMs = DEFAULT_HEARTBEAT_MINUTES * 60_000, offerMs = OFFER_EVERY_MS }) {
  if (claims.length > 0) {
    if (!(heartbeatMs > 0)) return null;
    if (Number.isFinite(presence.last_status) && now - presence.last_status < heartbeatMs) return null;
    const listed = claims.slice(0, LISTED).map((claim) => describe(claim, now)).join("; ");
    const more = claims.length > LISTED ? ` e altre ${claims.length - LISTED}` : "";
    return { kind: "info", story: claims.length === 1 ? claims[0].story : null, text: `[auto] stato: ${listed}${more}`, field: "last_status" };
  }
  if (Number.isFinite(presence.last_offer) && now - presence.last_offer < offerMs) return null;
  return { kind: "offer", story: null, text: "[auto] libero: posso prendere lavoro o aiutare", field: "last_offer" };
}

/** One throttled presence step for the host hook; returns what was sent or null. */
export async function checkPresence(root, { env = process.env, providers = PROVIDERS, now = Date.now(), branchExists } = {}) {
  const settings = settingsFor(root, env);
  if (!settings?.statePath) return null;
  const state = readJson(settings.statePath) ?? {};
  const presence = state.presence && typeof state.presence === "object" ? state.presence : {};
  const choice = selectPresence({
    claims: localActiveClaims(root, { now, branchExists }),
    presence,
    now,
    heartbeatMs: heartbeatMinutes(env) * 60_000,
  });
  if (!choice) return null;
  // Claim the slot first, so parallel hooks do not all send.
  const latest = readJson(settings.statePath) ?? {};
  fs.mkdirSync(path.dirname(settings.statePath), { recursive: true });
  fs.writeFileSync(settings.statePath, `${JSON.stringify({ ...latest, presence: { ...presence, [choice.field]: now } }, null, 2)}\n`, { mode: 0o600 });
  const seconds = parseLimitSeconds(env[AUTO_ENV.timeout]);
  const timeout = Math.min((seconds && seconds > 0 ? seconds : 3) * 1000, MAX_TIMEOUT_MS);
  try {
    const sent = await resolveProvider(settings.config, providers).publish({
      config: settings.config,
      message: { from: senderLabel({}, env), host: hostLabel(env), version: VERSION, kind: choice.kind, story: choice.story, text: choice.text },
      signal: AbortSignal.timeout(timeout),
    });
    if (sent?.id) {
      const after = readJson(settings.statePath) ?? {};
      const own = Array.isArray(after.own) ? after.own.map(String) : [];
      fs.writeFileSync(settings.statePath, `${JSON.stringify({ ...after, own: [...own, String(sent.id)].slice(-200) }, null, 2)}\n`, { mode: 0o600 });
    }
  } catch {
    return null;
  }
  return choice;
}
