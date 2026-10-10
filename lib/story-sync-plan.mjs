// Pure rules behind story sync, story handoff export/import and the automatic
// publication of a story's records. Git and the file system live in
// lib/engine/story-sync.mjs; everything here works on plain values.

import { stableJson } from "./lifecycle/common.mjs";
import { REGISTRY_ENTRY_LISTS } from "./output-registry-merge.mjs";
import { classifyStoryRecordPath } from "./story-records.mjs";

export const AUTO_PUBLISH_ENV = "AGENTIC_SDLC_AUTO_PUBLISH";
const OFF_VALUES = new Set(["0", "false", "no", "off", "disabled"]);

function folderOf(sdlcFolder) {
  return String(sdlcFolder || ".sdlc").replace(/\\/gu, "/").replace(/\/$/u, "");
}

function normalizePath(filePath) {
  return String(filePath || "").replace(/\\/gu, "/").replace(/^\.\//u, "");
}

/**
 * The shared append-only records every computer writes to: the project
 * history and its integrity checkpoint. A plain git merge of two copies never
 * verifies, so sync and publication rebuild them instead of merging them.
 */
export function appendOnlyRecordPaths(sdlcFolder = ".sdlc") {
  const folder = folderOf(sdlcFolder);
  return Object.freeze([
    `${folder}/traces/project.jsonl`,
    `${folder}/traces/.integrity/project.jsonl.checkpoint.json`,
  ]);
}

/** Shared-history files, relative to the records folder, when host_policy.records.shared_history_paths is not set. */
export const DEFAULT_SHARED_HISTORY_PATHS = Object.freeze([
  "traces/project.jsonl",
  "traces/.integrity/project.jsonl.checkpoint.json",
]);

/**
 * The shared-history files every publication by anyone changes
 * (host_policy.records.shared_history_paths, relative to the records folder;
 * default: the project history and its checkpoint). They never travel in a
 * story's commits: story publish-records merges them onto the base branch,
 * and story sync takes the base copy when they conflict.
 */
export function sharedHistoryPaths(sdlcFolder = ".sdlc", config = null) {
  const folder = folderOf(sdlcFolder);
  const configured = config?.host_policy?.records?.shared_history_paths;
  const list = Array.isArray(configured)
    ? configured.filter((item) => typeof item === "string" && item.trim())
    : DEFAULT_SHARED_HISTORY_PATHS;
  return [...new Set(list.map((item) => `${folder}/${normalizePath(item.trim()).replace(/^\/+/u, "")}`))];
}

export function outputRegistryRecordPath(sdlcFolder = ".sdlc") {
  return `${folderOf(sdlcFolder)}/output-contracts/registry.json`;
}

/** Records sync and publication rebuild (append-only history and output registry). */
export function rebuiltRecordPaths(sdlcFolder = ".sdlc") {
  return [...appendOnlyRecordPaths(sdlcFolder), outputRegistryRecordPath(sdlcFolder)];
}

/** Identity of a registry entry: its id, else its JSON content. */
export function registryEntryKey(entry) {
  return entry && typeof entry === "object" && typeof entry.id === "string" && entry.id
    ? `id:${entry.id}`
    : `value:${stableJson(entry)}`;
}

/** True when `candidate` supersedes `current` (later updated_at, then created_at; ties keep `current`). */
export function newerRegistryEntry(candidate, current) {
  const stamp = (entry) => String(entry?.updated_at || entry?.created_at || "");
  return stamp(candidate) > stamp(current);
}

/** Ids that appear more than once in the registry entry lists: [{ list, id, count }]. */
export function duplicateRegistryIds(registry) {
  const found = [];
  for (const name of REGISTRY_ENTRY_LISTS) {
    const counts = new Map();
    for (const entry of Array.isArray(registry?.[name]) ? registry[name] : []) {
      if (entry && typeof entry.id === "string" && entry.id) counts.set(entry.id, (counts.get(entry.id) || 0) + 1);
    }
    for (const [id, count] of counts) if (count > 1) found.push({ list: name, id, count });
  }
  return found;
}

/**
 * Union of two output registries: every entry of `remote`, then every entry
 * of `local` that `remote` does not hold with the same JSON content, so an
 * output link recorded here is never lost. Other fields come from `remote`,
 * with the fields only `local` has added; `updated_at`/`audit` follow the
 * newer side. Returns { registry, changed, added } where `added` counts the
 * local entries appended per list and `changed` compares with `remote`.
 */
export function unionOutputRegistries(local, remote) {
  if (!remote || typeof remote !== "object") {
    return { registry: local ?? null, changed: Boolean(local), added: {} };
  }
  if (!local || typeof local !== "object") return { registry: remote, changed: false, added: {} };
  const registry = { ...local, ...remote };
  const added = {};
  for (const name of REGISTRY_ENTRY_LISTS) {
    const remoteList = Array.isArray(remote[name]) ? remote[name] : [];
    const localList = Array.isArray(local[name]) ? local[name] : [];
    if (!Array.isArray(remote[name]) && !Array.isArray(local[name])) continue;
    // Entries are identified by id (JSON content when they have none); on the
    // same id the most recently updated version wins, so a repeated merge or
    // publication never leaves two versions of one link.
    const index = new Map();
    const merged = [];
    let count = 0;
    const take = (entry, fromLocal) => {
      const key = registryEntryKey(entry);
      if (!index.has(key)) {
        index.set(key, merged.length);
        merged.push(entry);
        if (fromLocal) count += 1;
        return;
      }
      const position = index.get(key);
      if (newerRegistryEntry(entry, merged[position])) {
        merged[position] = entry;
        if (fromLocal) count += 1;
      }
    };
    for (const entry of remoteList) take(entry, false);
    for (const entry of localList) take(entry, true);
    registry[name] = merged;
    if (count > 0) added[name] = count;
  }
  const newer = String(local.updated_at || "") > String(remote.updated_at || "") ? local : remote;
  for (const key of ["updated_at", "audit"]) {
    if (newer[key] !== undefined) registry[key] = newer[key];
  }
  return { registry, changed: stableJson(registry) !== stableJson(remote), added };
}

/**
 * Record files an output registry relies on besides itself: the delegation
 * record and the validity-at-use receipt of every delegated decision. A
 * registry merged from the base branch must bring them along, or a gate here
 * reads a decision whose receipt is missing.
 */
export function registryDelegationRecordPaths(registry, sdlcFolder = ".sdlc") {
  const paths = new Set();
  for (const name of REGISTRY_ENTRY_LISTS) {
    for (const entry of Array.isArray(registry?.[name]) ? registry[name] : []) {
      const ref = entry?.delegation;
      if (!ref || typeof ref !== "object") continue;
      if (typeof ref.id === "string" && ref.id && !ref.id.includes("/") && !ref.id.includes("..")) {
        paths.add(`${sdlcFolder}/autonomy/delegations/${ref.id}/delegation.json`);
      }
      if (typeof ref.use_path === "string" && ref.use_path.startsWith(`${sdlcFolder}/autonomy/delegations/`) && !ref.use_path.includes("..")) {
        paths.add(ref.use_path);
      }
    }
  }
  return [...paths].sort();
}

/** The fixed folder in front of a write-path pattern ("src/app/**" -> "src/app"). */
export function writePathPrefix(pattern) {
  return normalizePath(pattern).replace(/[*?[{].*$/u, "").replace(/\/+$/u, "");
}

/** True when a project path is inside one of the story's write paths. */
export function pathInWritePaths(filePath, writePaths = []) {
  const normalized = normalizePath(filePath);
  return writePaths.some((pattern) => {
    const prefix = writePathPrefix(pattern);
    if (!prefix) return false;
    return normalized === prefix || normalized.startsWith(`${prefix}/`);
  });
}

/**
 * Which changed paths travel with a story's handoff. `paths` are project
 * paths. Story records (own and shared, see story-records.mjs) and files
 * inside the story's write paths are included; another story's records, the
 * project configuration and caches, and anything else (untracked junk,
 * editor files, unrelated edits) are excluded. Returns { include, exclude },
 * each sorted, where every excluded item carries its reason.
 */
export function selectHandoffFiles(paths, { sdlcFolder = ".sdlc", storyId, storyIds = [], writePaths = [] }) {
  const include = [];
  const exclude = [];
  for (const raw of [...new Set(paths.map(normalizePath))].sort()) {
    if (!raw) continue;
    const kind = classifyStoryRecordPath(raw, { sdlcFolder, storyId, storyIds });
    if (kind === "own" || kind === "shared") include.push(raw);
    else if (kind === "other_story") exclude.push({ path: raw, reason: "other_story_record" });
    else if (kind === "excluded") exclude.push({ path: raw, reason: "project_configuration_or_cache" });
    else if (pathInWritePaths(raw, writePaths)) include.push(raw);
    else exclude.push({ path: raw, reason: "outside_write_paths" });
  }
  return { include, exclude };
}

/**
 * Conflicted paths of a sync, split into the ones sync rebuilds by itself
 * (append-only history, output registry) and the ones a person resolves.
 */
export function classifySyncConflicts(paths, sdlcFolder = ".sdlc", sharedHistory = sharedHistoryPaths(sdlcFolder)) {
  const rebuilt = new Set([...rebuiltRecordPaths(sdlcFolder), ...sharedHistory]);
  const automatic = [];
  const blocking = [];
  for (const raw of [...new Set(paths.map(normalizePath))].filter(Boolean).sort()) {
    (rebuilt.has(raw) ? automatic : blocking).push(raw);
  }
  return { automatic, blocking };
}

/**
 * What to do with one local record saved before the branch moved:
 * "reapply" when the base did not change it (or has the same content),
 * "rebuilt" for the history and registry (merged separately), "conflict" when
 * both sides changed it differently. Blob ids are null for missing files.
 */
export function reapplyDecision(filePath, { sdlcFolder = ".sdlc", localBlob, oldHeadBlob, newHeadBlob, ownExtends = false }) {
  if (rebuiltRecordPaths(sdlcFolder).includes(normalizePath(filePath))) return "rebuilt";
  if (localBlob === newHeadBlob) return "same";
  if (oldHeadBlob === newHeadBlob) return "reapply";
  if (localBlob === oldHeadBlob) return "same";
  return ownExtends ? "reapply" : "conflict";
}

const RECORD_TIME_KEYS = ["checked_at", "updated_at", "recorded_at", "completed_at", "released_at", "claimed_at", "created_at", "timestamp"];
const CLAIM_ENDED_STATUSES = new Set(["released", "completed"]);

function parseRecord(bytes) {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return null;
  }
}

function recordTime(value) {
  if (!value || typeof value !== "object") return "";
  return RECORD_TIME_KEYS.map((key) => (typeof value[key] === "string" ? value[key] : "")).sort().pop();
}

/** True for a gate or report file the tool regenerates (`.sdlc/gates/*`, `.sdlc/reports/*`): the base copy may replace a local one. */
export function isGeneratedGateRecord(filePath, sdlcFolder = ".sdlc") {
  const normalized = normalizePath(filePath);
  return ["gates", "reports"].some((name) => normalized.startsWith(`${folderOf(sdlcFolder)}/${name}/`));
}

/** True when the path is a record of this story alone (see classifyStoryRecordPath), including its autonomy executions. */
export function isOwnStoryRecordPath(filePath, { sdlcFolder = ".sdlc", storyId, storyIds = [] }) {
  if (classifyStoryRecordPath(filePath, { sdlcFolder, storyId, storyIds }) === "own") return true;
  const suffix = String(storyId || "").replace(/^ST-/u, "");
  if (!suffix) return false;
  const inside = normalizePath(filePath).slice(folderOf(sdlcFolder).length + 1);
  return inside.startsWith(`autonomy/executions/AUT-PR-${suffix}/`);
}

/**
 * True when this computer's copy of a story's own record supersedes the base
 * version: the base bytes are a prefix of the local ones (append-only files),
 * or both are JSON and the local one is newer (more integrity-checkpoint
 * writes, or a later recorded timestamp). Anything else is a real conflict.
 */
export function localRecordExtendsBase(localBytes, baseBytes) {
  if (!localBytes || !baseBytes) return false;
  const local = Buffer.from(localBytes);
  const base = Buffer.from(baseBytes);
  if (local.length >= base.length && local.subarray(0, base.length).equals(base)) return true;
  const localJson = parseRecord(local);
  const baseJson = parseRecord(base);
  if (!localJson || !baseJson) return false;
  const localCount = localJson.new_writes?.count;
  const baseCount = baseJson.new_writes?.count;
  if (Number.isFinite(localCount) && Number.isFinite(baseCount)) return localCount > baseCount;
  // A claim released or completed locally is a later state than the same claim still active on the base.
  if (CLAIM_ENDED_STATUSES.has(localJson.status) && baseJson.status === "active") return true;
  const localTime = recordTime(localJson);
  return Boolean(localTime) && localTime > recordTime(baseJson);
}

/** Untracked files whose bytes equal the base version: duplicates a handoff left behind. */
export function identicalUntrackedFiles(entries) {
  return entries
    .filter((entry) => entry.localBlob && entry.baseBlob && entry.localBlob === entry.baseBlob)
    .map((entry) => normalizePath(entry.path))
    .sort();
}

/**
 * Whether the project on the git target is another project than the one being
 * published. A target that carries no project record yet is accepted; one that
 * names a different project_id (or a local project with no identity) is not.
 * Returns null when publishing may go on, otherwise the reason.
 */
export function publishTargetMismatch({ localProject, baseProject }) {
  const baseId = baseProject && typeof baseProject.project_id === "string" ? baseProject.project_id : null;
  if (!baseId) return null;
  const localId = localProject && typeof localProject.project_id === "string" ? localProject.project_id : null;
  if (!localId) return `the target repository holds the project '${baseId}' and this project has no identity`;
  return localId === baseId ? null : `this project is '${localId}' but the target repository holds the project '${baseId}'`;
}

export function autoPublishEnabled(env = {}) {
  return !OFF_VALUES.has(String(env[AUTO_PUBLISH_ENV] ?? "").trim().toLowerCase());
}

/**
 * The event that publishes a story's records after a finished command, or
 * null: a passed pull_request.merge completion, or a lifecycle-complete gate
 * that passed. `exitCode` is the code the command set (0 or undefined when it
 * succeeded).
 */
export function autoPublishEvent(action, options = {}, exitCode = 0) {
  if ((Number(exitCode) || 0) !== 0) return null;
  if (action === "autonomy.delivery.action"
    && options.action === "pull_request.merge"
    && options.outcome === "passed") return "pull_request.merge";
  if (action === "gate.check" && options["lifecycle-complete"] === true && options.story) return "lifecycle-complete";
  return null;
}

/** The handoff branch of a story. */
export function handoffBranch(storyId) {
  return `handoff/${storyId}`;
}
