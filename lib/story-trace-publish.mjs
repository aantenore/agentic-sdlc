/**
 * Publication helpers for a story's own append-only trace: how the local copy
 * relates to the base branch copy, and which files its events reference.
 */

function eventLines(text) {
  return String(text ?? "").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

/**
 * "same" | "superset" (every base event is also here: publishing loses
 * nothing) | "diverged" (the base branch holds events this copy lacks).
 */
export function compareStoryTrace(baseText, localText) {
  const local = new Set(eventLines(localText));
  const base = eventLines(baseText);
  if (!base.some((line) => !local.has(line))) {
    return base.length === eventLines(localText).length ? "same" : "superset";
  }
  return "diverged";
}

function collectStrings(value, found) {
  if (typeof value === "string") found.add(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, found);
  else if (value && typeof value === "object") for (const item of Object.values(value)) collectStrings(item, found);
}

/**
 * Relative file paths the trace events mention that name the story (for
 * example evidence/<story>/log/x.txt), in sorted order. Existence and
 * ownership are checked by the caller.
 */
export function storyTraceFileReferences(traceText, storyId) {
  const strings = new Set();
  for (const line of eventLines(traceText)) {
    try {
      collectStrings(JSON.parse(line), strings);
    } catch {
      // A line that is not JSON references nothing.
    }
  }
  const id = String(storyId).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const names = new RegExp(`(^|[^A-Za-z0-9])${id}($|[^A-Za-z0-9])`, "u");
  return [...strings]
    .map((value) => value.replace(/\\/gu, "/").replace(/^\.\//u, ""))
    .filter((value) => value.length < 400 && /^[\w.@-][\w.@/ -]*\.[A-Za-z0-9]+$/u.test(value)
      && !value.split("/").includes("..") && names.test(value))
    .sort();
}
