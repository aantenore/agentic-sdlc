// Answers of expensive verifications (record file hashes, trace hash chains)
// kept between runs in .git/agentic-sdlc/verify-cache.json, so a gate re-checks
// only what changed since the previous one.
//
// Correctness first:
// - an entry is reused only when its key matches exactly: a file hash by
//   path + size + mtime + ctime + inode, a trace verification by the sha256 of
//   every byte it read;
// - a file modified in the last RACY_WINDOW_MS is always hashed again, because
//   a second write within the same timestamp tick would keep the same stat;
// - only successful verifications are stored, never a failure;
// - a plugin version change, a corrupt cache file, or
//   AGENTIC_SDLC_VERIFY_CACHE=off means everything is verified again.

import path from "node:path";

import { PLUGIN_VERSION } from "../plugin-compatibility.mjs";
import { childProcess, Date, fs, process } from "../runtime/host.mjs";

export const VERIFY_CACHE_ENV = "AGENTIC_SDLC_VERIFY_CACHE";
export const VERIFY_CACHE_FILE = "verify-cache.json";
const SCHEMA = "agentic-sdlc-verify-cache:v1";
const RACY_WINDOW_MS = 2000;
const MAX_ENTRIES = 50_000;

let active = null;
let exitHookInstalled = false;

export function verifyCacheEnabled(env = process.env) {
  return String(env[VERIFY_CACHE_ENV] || "on").trim().toLowerCase() !== "off";
}

function gitCommonDir(root) {
  try {
    const out = childProcess.execFileSync("git", ["-C", root, "rev-parse", "--git-common-dir"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
    }).trim();
    return out ? path.resolve(root, out) : null;
  } catch {
    return null;
  }
}

export function verifyCachePath(root) {
  const common = gitCommonDir(root);
  return common ? path.join(common, "agentic-sdlc", VERIFY_CACHE_FILE) : null;
}

function emptyStore(file, version) {
  return { file, version, files: new Map(), traces: new Map(), dirty: false, hits: 0, misses: 0 };
}

function loadStore(file, version) {
  const store = emptyStore(file, version);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed?.schema !== SCHEMA || parsed.plugin_version !== version) return store;
    for (const [key, value] of Object.entries(parsed.files || {})) {
      if (typeof value === "string" && /^[a-f0-9]{64}$/u.test(value)) store.files.set(key, value);
    }
    for (const [key, value] of Object.entries(parsed.traces || {})) {
      if (value && typeof value === "object" && value.valid === true) store.traces.set(key, value);
    }
  } catch {
    // Missing or unreadable: start empty, everything is verified.
  }
  return store;
}

/**
 * Turns the cache on for the repository holding `root` for the rest of this
 * process. Returns the cache file path, or null when it stays off.
 */
export function activateVerifyCache(root, { env = process.env, version = PLUGIN_VERSION } = {}) {
  if (!verifyCacheEnabled(env)) return null;
  const file = verifyCachePath(root);
  if (!file) return null;
  if (active?.file === file) return file;
  saveVerifyCache();
  active = loadStore(file, version);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", () => saveVerifyCache());
  }
  return file;
}

export function deactivateVerifyCache() {
  saveVerifyCache();
  active = null;
}

export function verifyCacheStats() {
  return active ? { hits: active.hits, misses: active.misses, file: active.file } : null;
}

export function saveVerifyCache() {
  if (!active?.dirty) return;
  const trim = (map) => [...map.entries()].slice(-MAX_ENTRIES);
  const body = {
    schema: SCHEMA,
    plugin_version: active.version,
    saved_at: new Date().toISOString(),
    files: Object.fromEntries(trim(active.files)),
    traces: Object.fromEntries(trim(active.traces)),
  };
  try {
    fs.mkdirSync(path.dirname(active.file), { recursive: true });
    const temporary = `${active.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(body)}\n`, "utf8");
    fs.renameSync(temporary, active.file);
    active.dirty = false;
  } catch {
    // The cache is an optimization: failing to save only costs time later.
  }
}

function statKey(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath, { bigint: true });
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const mtimeMs = Number(stat.mtimeNs / 1_000_000n);

  // Too recent: a same-size rewrite in the same tick would look unchanged.
  if (Date.now() - mtimeMs < RACY_WINDOW_MS) return null;
  return [path.resolve(filePath), stat.size, stat.mtimeNs, stat.ctimeNs, stat.ino].join("\u0000");
}

/** sha256 of a file, reused while its size, times and inode are unchanged. */
export function cachedFileHash(filePath, compute) {
  if (!active) return compute();
  const key = statKey(filePath);
  if (key && active.files.has(key)) {
    active.hits += 1;
    return active.files.get(key);
  }
  active.misses += 1;
  const value = compute();
  // Stat again after reading: a write in between leaves no entry.
  if (key && key === statKey(filePath) && typeof value === "string" && /^[a-f0-9]{64}$/u.test(value)) {
    active.files.set(key, value);
    active.dirty = true;
  }
  return value;
}

/**
 * A trace verification report, reused when the exact same bytes (trace,
 * checkpoint and its backup, by sha256) were verified valid before.
 */
export function cachedTraceVerification(keyParts, compute) {
  if (!active || keyParts.some((part) => part === undefined)) return compute();
  const key = JSON.stringify(keyParts);
  const hit = active.traces.get(key);
  if (hit) {
    active.hits += 1;
    return hit.report;
  }
  active.misses += 1;
  const report = compute();
  if (report?.valid === true) {
    active.traces.set(key, { valid: true, report: JSON.parse(JSON.stringify(report)) });
    active.dirty = true;
  }
  return report;
}
