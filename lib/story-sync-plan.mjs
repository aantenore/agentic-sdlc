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

export function outputRegistryRecordPath(sdlcFolder = ".sdlc") {
  return `${folderOf(sdlcFolder)}/output-contracts/registry.json`;
}

/** Records sync and publication rebuild (append-only history and output registry). */
export function rebuiltRecordPaths(sdlcFolder = ".sdlc") {
  return [...appendOnlyRecordPaths(sdlcFolder), outputRegistryRecordPath(sdlcFolder)];
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
    const seen = new Set();
    const merged = [];
    for (const entry of remoteList) {
      const key = stableJson(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(entry);
    }
    let count = 0;
    for (const entry of localList) {
      const key = stableJson(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(entry);
      count += 1;
    }
    registry[name] = merged;
    if (count > 0) added[name] = count;
  }
  const newer = String(local.updated_at || "") > String(remote.updated_at || "") ? local : remote;
  for (const key of ["updated_at", "audit"]) {
    if (newer[key] !== undefined) registry[key] = newer[key];
  }
  return { registry, changed: stableJson(registry) !== stableJson(remote), added };
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
export function classifySyncConflicts(paths, sdlcFolder = ".sdlc") {
  const rebuilt = new Set(rebuiltRecordPaths(sdlcFolder));
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

const RECORD_TIME_KEYS = ["updated_at", "recorded_at", "completed_at", "created_at", "timestamp"];

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
