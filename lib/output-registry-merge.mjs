// Three-way merge of .sdlc/output-contracts/registry.json. Every computer adds
// templates, links and decisions to the same file, so two clones that both
// recorded something conflict in Git although their entries never overlap.
// Entries are matched by id: an entry only one side has is kept, an entry
// only one side changed since the common version takes that side, and an
// entry both sides changed differently is a conflict for a person to resolve.

import { stableJson } from "./lifecycle/common.mjs";

export const REGISTRY_ENTRY_LISTS = Object.freeze(["templates", "links", "decisions"]);
const DERIVED_KEYS = new Set(["updated_at", "audit"]);

function same(left, right) {
  return stableJson(left ?? null) === stableJson(right ?? null);
}

function entryKey(entry) {
  return entry && typeof entry === "object" && typeof entry.id === "string" && entry.id
    ? `id:${entry.id}`
    : `value:${stableJson(entry)}`;
}

function byKey(list) {
  const map = new Map();
  for (const entry of Array.isArray(list) ? list : []) map.set(entryKey(entry), entry);
  return map;
}

function pick(base, local, remote, label, conflicts) {
  if (same(local, remote)) return remote;
  if (local === undefined) return remote;
  if (remote === undefined) return local;
  if (same(local, base)) return remote;
  if (same(remote, base)) return local;
  conflicts.push(label);
  return remote;
}

function mergeList(baseList, localList, remoteList, name, conflicts) {
  const base = byKey(baseList);
  const local = byKey(localList);
  const merged = [];
  const seen = new Set();
  for (const remoteEntry of Array.isArray(remoteList) ? remoteList : []) {
    const key = entryKey(remoteEntry);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(pick(base.get(key), local.get(key), remoteEntry, `${name} ${key.slice(key.indexOf(":") + 1)}`, conflicts));
  }
  for (const [key, localEntry] of local) {
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(localEntry);
  }
  return merged;
}

/**
 * Merges this clone's registry (local) onto another branch's (remote), with
 * their common version (base, or null). Returns { registry, changed,
 * conflicts }; registry is null when there are conflicts.
 */
export function mergeOutputRegistries({ base = null, local, remote }) {
  const conflicts = [];
  const result = {};
  const keys = new Set([...Object.keys(remote || {}), ...Object.keys(local || {})]);
  for (const key of keys) {
    if (REGISTRY_ENTRY_LISTS.includes(key) || DERIVED_KEYS.has(key)) continue;
    const value = pick(base?.[key], local?.[key], remote?.[key], `field ${key}`, conflicts);
    if (value !== undefined) result[key] = value;
  }
  for (const name of REGISTRY_ENTRY_LISTS) {
    if (local?.[name] === undefined && remote?.[name] === undefined) continue;
    result[name] = mergeList(base?.[name], local?.[name], remote?.[name], name, conflicts);
  }
  // The latest write names when and by whom the registry last changed.
  const localTime = String(local?.updated_at || "");
  const remoteTime = String(remote?.updated_at || "");
  const latest = localTime > remoteTime ? local : remote;
  for (const key of DERIVED_KEYS) {
    if (latest?.[key] !== undefined) result[key] = latest[key];
  }
  if (conflicts.length > 0) return { registry: null, changed: false, conflicts };
  return { registry: result, changed: !same(result, local), conflicts };
}
