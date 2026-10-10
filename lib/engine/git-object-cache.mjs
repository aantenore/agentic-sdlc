import path from "node:path";
import {
  SDLC_DIR,
} from "../lifecycle/constants.mjs";
import {
  fs,
  process,
} from "../runtime/host.mjs";

/**
 * Answers to Git questions that name commits only by their full object ID
 * never change: whether a commit exists, whether one is an ancestor of
 * another, which paths a commit or a range between two commits touched, what
 * a commit's tree holds. They are kept in the project's local cache
 * (.sdlc/cache/git-objects.json, derived and ignored by Git), so a later run
 * of status, a gate, or the Observatory asks Git only about new commits.
 *
 * Only successful answers are kept: a commit that is missing now may be
 * fetched later, so a failure is always asked again.
 */
export const GIT_OBJECT_CACHE_FILE = "git-objects.json";
const GIT_OBJECT_CACHE_SCHEMA = "agentic-sdlc-git-object-cache:v1";
const GIT_OBJECT_CACHE_MAX_ENTRIES = 50_000;
const GIT_OBJECT_CACHE_MAX_VALUE_BYTES = 256 * 1024;

const CACHEABLE_SUBCOMMANDS = new Set([
  "cat-file",
  "diff",
  "diff-tree",
  "log",
  "ls-tree",
  "merge-base",
  "rev-list",
  "rev-parse",
]);
// rev-parse is kept only when it resolves full object IDs (`<id>^{tree}`).
const REV_PARSE_OPTIONS = new Set(["--verify", "--quiet", "-q", "--end-of-options"]);
const OBJECT_TYPES = new Set(["blob", "commit", "tag", "tree"]);
const OBJECT_ID ="[0-9a-f]{40}(?:[0-9a-f]{24})?";
const SUFFIX = "(?:\\^\\{commit\\}|\\^\\{tree\\}|\\^@|\\^[12]?|~1)?";
const REVISION = new RegExp(
  `^\\^?${OBJECT_ID}${SUFFIX}(?:\\.\\.\\.?${OBJECT_ID}${SUFFIX})?$|^${OBJECT_ID}:.+$`,
  "u",
);
// Options that change what Git reads instead of how it prints are refused.
const REFUSED_OPTIONS = /^--(?:all|branches|tags|remotes|glob|exclude|stdin|not|reflog|alternate-refs)\b/u;

const stores = new Map();
let exitHookInstalled = false;

/**
 * Whether these arguments (after any leading `-c` pairs and global flags)
 * read only objects named by full IDs, so their answer can be kept.
 */
export function gitArgsAreContentAddressed(args) {
  let index = 0;
  while (index < args.length && (args[index] === "-c" || args[index] === "--no-replace-objects")) {
    index += args[index] === "-c" ? 2 : 1;
  }
  const [subcommand, ...rest] = args.slice(index);
  if (!CACHEABLE_SUBCOMMANDS.has(subcommand)) return false;
  let revisions = 0;
  let ranged = false;
  for (let position = 0; position < rest.length; position += 1) {
    const argument = rest[position];
    if (argument === "--") break;
    if (subcommand === "rev-parse" && argument.startsWith("-") && !REV_PARSE_OPTIONS.has(argument)) return false;
    // A count limit (`-n 1`) bounds the output of a fixed commit.
    if (argument === "-n" && /^[0-9]+$/u.test(rest[position + 1] || "")) {
      position += 1;
      continue;
    }
    if (argument.startsWith("-")) {
      if (REFUSED_OPTIONS.test(argument) || argument === "--cached" || argument === "--staged") return false;
      continue;
    }
    if (subcommand === "cat-file" && OBJECT_TYPES.has(argument)) continue;
    if (!REVISION.test(argument)) return false;
    if (argument.includes("..")) ranged = true;
    revisions += 1;
  }
  // `git diff <commit>` alone compares with the working tree, which changes.
  if (subcommand === "diff") return ranged || revisions >= 2;
  return revisions > 0;
}

function cachePathFor(root) {
  return path.join(root, SDLC_DIR, "cache", GIT_OBJECT_CACHE_FILE);
}

function storeFor(root) {
  const key = path.resolve(root);
  if (stores.has(key)) return stores.get(key);
  const store = { root: key, entries: new Map(), dirty: false, usable: false };
  stores.set(key, store);
  try {
    if (!fs.statSync(path.join(key, SDLC_DIR)).isDirectory()) return store;
    store.usable = true;
    const raw = JSON.parse(fs.readFileSync(cachePathFor(key), "utf8"));
    if (raw?.schema_version === GIT_OBJECT_CACHE_SCHEMA && raw.entries && typeof raw.entries === "object") {
      for (const [entryKey, value] of Object.entries(raw.entries)) {
        if (typeof value === "string" || typeof value === "boolean") store.entries.set(entryKey, value);
      }
    }
  } catch {
    // Missing or unreadable: start empty and rewrite it.
  }
  installExitHook();
  return store;
}

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", flushGitObjectCaches);
}

/** Writes every changed cache; a cache that cannot be written is skipped. */
export function flushGitObjectCaches() {
  for (const store of stores.values()) {
    if (!store.usable || !store.dirty) continue;
    try {
      const cachePath = cachePathFor(store.root);
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      const kept = [...store.entries].slice(-GIT_OBJECT_CACHE_MAX_ENTRIES);
      const body = `${JSON.stringify({
        schema_version: GIT_OBJECT_CACHE_SCHEMA,
        entries: Object.fromEntries(kept),
      })}\n`;
      const temporary = `${cachePath}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, body, "utf8");
      fs.renameSync(temporary, cachePath);
      store.dirty = false;
    } catch {
      // Derived data only: the next run asks Git again.
    }
  }
}

/**
 * The kept answer for a content-addressed Git query, computing it with `run`
 * on first use. `run` returns the answer, or null/false when Git failed;
 * failures are never kept.
 */
export function cachedGitObjectAnswer(root, kind, args, run) {
  if (!root || !gitArgsAreContentAddressed(args)) return run();
  const store = storeFor(root);
  if (!store.usable) return run();
  const key = `${kind}\u0000${args.join("\u0000")}`;
  if (store.entries.has(key)) return store.entries.get(key);
  const value = run();
  if (
    (typeof value === "string" && value.length <= GIT_OBJECT_CACHE_MAX_VALUE_BYTES)
    || value === true
  ) {
    store.entries.set(key, value);
    store.dirty = true;
  }
  return value;
}

/** Forget every loaded cache (tests). */
export function resetGitObjectCaches() {
  stores.clear();
}
