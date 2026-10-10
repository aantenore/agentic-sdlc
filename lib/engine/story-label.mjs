import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Readable story and requirement labels: "ST-X (short title)". The title comes
 * from .sdlc/stories/<ID>/story.json or .sdlc/requirements/<ID>.json on the
 * checkout, then from the same file on a remote branch named after the ID when
 * the story is not on the base yet. Without a title the bare ID is returned.
 * Settings (environment): AGENTIC_SDLC_LABEL_IDS=0 turns labels off,
 * AGENTIC_SDLC_LABEL_MAX_LENGTH changes the title limit (default 60).
 */
export const LABEL_DEFAULT_MAX_LENGTH = 60;
export const LABEL_ID_PATTERN = /\b(?:ST|REQ)-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\b/gu;
const GIT_TIMEOUT_MS = 5000;
const cache = new Map();

export function labelsEnabled(env = process.env) {
  return !["0", "false", "off", "no"].includes(String(env?.AGENTIC_SDLC_LABEL_IDS ?? "").trim().toLowerCase());
}

function maxLength(env) {
  const value = Number.parseInt(String(env?.AGENTIC_SDLC_LABEL_MAX_LENGTH ?? ""), 10);
  return Number.isInteger(value) && value >= 10 ? value : LABEL_DEFAULT_MAX_LENGTH;
}

export function truncateTitle(text, limit = LABEL_DEFAULT_MAX_LENGTH) {
  const clean = String(text ?? "").replace(/\s+/gu, " ").trim();
  if (clean.length <= limit) return clean;
  const cut = clean.slice(0, limit - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > limit / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/u, "")}…`;
}

function recordPaths(id) {
  return id.startsWith("REQ-")
    ? [`.sdlc/requirements/${id}.json`]
    : [`.sdlc/stories/${id}/story.json`];
}

function titleOf(record) {
  if (!record || typeof record !== "object") return "";
  for (const key of ["title", "summary"]) {
    if (typeof record[key] === "string" && record[key].trim()) return record[key];
  }
  return "";
}

function git(root, args) {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: GIT_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  } catch {
    return "";
  }
}

function fromCheckout(root, id) {
  for (const relative of recordPaths(id)) {
    try {
      const title = titleOf(JSON.parse(fs.readFileSync(path.join(root, relative), "utf8")));
      if (title) return title;
    } catch {
      // not on this checkout
    }
  }
  return "";
}

function fromRemoteBranches(root, id) {
  const refs = git(root, ["for-each-ref", "--format=%(refname)", "refs/remotes"]).split("\n").filter((ref) => ref.endsWith(`/${id}`));
  for (const ref of refs) {
    for (const relative of recordPaths(id)) {
      try {
        const title = titleOf(JSON.parse(git(root, ["show", `${ref}:${relative}`])));
        if (title) return title;
      } catch {
        // not on that branch
      }
    }
  }
  return "";
}

/** The short title of a story or requirement, or "" when none is recorded. */
export function storyTitle(root, id, env = process.env) {
  const key = `${path.resolve(String(root))}\u0000${id}\u0000${maxLength(env)}`;
  if (!cache.has(key)) {
    const raw = fromCheckout(root, id) || fromRemoteBranches(root, id);
    cache.set(key, truncateTitle(raw, maxLength(env)));
  }
  return cache.get(key);
}

/** "ST-X (short title)", or the bare ID when no title is available or labels are off. */
export function storyLabel(root, id, env = process.env) {
  const value = String(id ?? "");
  if (!labelsEnabled(env) || !/^(?:ST|REQ)-/u.test(value)) return value;
  const title = storyTitle(root, value, env);
  return title ? `${value} (${title})` : value;
}

/** Annotates the first mention of each ST-/REQ- ID in a text, unless a parenthesis already follows it or the ID is a command argument (after a --flag), which must stay runnable. */
export function annotateIds(root, text, env = process.env) {
  const source = String(text ?? "");
  if (!labelsEnabled(env)) return source;
  const seen = new Set();
  return source.replace(LABEL_ID_PATTERN, (match, offset) => {
    if (/--[A-Za-z][\w-]*(?:\s+|=)["']?$/u.test(source.slice(Math.max(0, offset - 40), offset))) return match;
    if (seen.has(match)) return match;
    seen.add(match);
    if (/^\s*\(/u.test(source.slice(offset + match.length))) return match;
    return storyLabel(root, match, env);
  });
}

/** Test hook: forget the per-process cache. */
export function resetStoryLabelCache() {
  cache.clear();
}
