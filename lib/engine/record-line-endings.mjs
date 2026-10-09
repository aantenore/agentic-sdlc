// Line-ending check for project records. Several records and evidence files
// are bound by the exact bytes they had when they were written; git line-ending
// conversion (a `text` attribute, core.autocrlf) can change those bytes on
// commit or checkout, so a record valid on one computer no longer matches on
// another. Read-only: it asks git how each file is stored and checked out.

import path from "node:path";
import { SDLC_DIR } from "../lifecycle/constants.mjs";
import { runGit } from "./shared-refs.mjs";

const TIMEOUT_SECONDS = 30;
const MAX_LISTED_PATHS = 10;

function parseEolEntries(stdout) {
  return String(stdout || "").split("\0").filter(Boolean).map((entry) => {
    const tab = entry.indexOf("\t");
    const [index, worktree, ...attributes] = entry.slice(0, tab).trim().split(/\s+/u);
    return {
      path: entry.slice(tab + 1),
      index: String(index || "").replace(/^i\//u, ""),
      worktree: String(worktree || "").replace(/^w\//u, ""),
      attributes: attributes.join(" ").replace(/^attr\//u, ""),
    };
  });
}

function textConverted(attributes) {
  // "text", "text=auto", "text eol=lf" convert; "-text" and binary do not.
  return /(^|\s)text(=auto)?(\s|$)/u.test(attributes) && !/(^|\s)-text(\s|$)/u.test(attributes);
}

/**
 * { applicable, altered, will_change } for tracked files under the project
 * records folder: altered lists files whose checked-out line endings differ
 * from the committed ones; will_change lists files git converts on commit
 * that now contain CRLF line endings.
 */
export function inspectRecordLineEndings(context) {
  const relative = path.relative(context.root, context.sdlcRoot).split(path.sep).join("/") || SDLC_DIR;
  const listed = runGit(context.root, ["ls-files", "--eol", "-z", "--", relative], {
    timeoutSeconds: TIMEOUT_SECONDS,
  });
  if (!listed.ok) return { applicable: false, altered: [], will_change: [] };
  const entries = parseEolEntries(listed.stdout);
  const known = (value) => ["lf", "crlf", "mixed"].includes(value);
  return {
    applicable: true,
    files_checked: entries.length,
    altered: entries
      .filter((entry) => known(entry.index) && known(entry.worktree) && entry.index !== entry.worktree)
      .map((entry) => entry.path),
    will_change: entries
      .filter((entry) => textConverted(entry.attributes) && ["crlf", "mixed"].includes(entry.worktree))
      .map((entry) => entry.path),
  };
}

/** The doctor check for record line endings: { status, warning, details }. */
export function recordLineEndingsCheck(context) {
  let result;
  try {
    result = inspectRecordLineEndings(context);
  } catch (error) {
    return { status: "not_applicable", warning: false, details: `Line endings not checked: ${error.message}` };
  }
  if (!result.applicable) {
    return { status: "not_applicable", warning: false, details: "Not a git checkout; line endings not checked." };
  }
  const listed = (paths) => `${paths.slice(0, MAX_LISTED_PATHS).join(", ")}${paths.length > MAX_LISTED_PATHS ? ` and ${paths.length - MAX_LISTED_PATHS} more` : ""}`;
  const problems = [];
  if (result.altered.length > 0) {
    problems.push(`${result.altered.length} record file(s) are checked out with different line endings than committed, so their bytes differ from the recorded ones: ${listed(result.altered)}.`);
  }
  if (result.will_change.length > 0) {
    problems.push(`${result.will_change.length} record file(s) contain CRLF line endings that git will convert on commit: ${listed(result.will_change)}.`);
  }
  if (problems.length === 0) {
    return {
      status: "passed",
      warning: false,
      details: `${result.files_checked} tracked record file(s) keep their exact line endings.`,
    };
  }
  return {
    status: "passed",
    warning: true,
    details: `${problems.join(" ")} Keep record bytes exact: set git config core.autocrlf false in this clone, mark the files -text in ${SDLC_DIR}/.gitattributes, and check them out again (git checkout -- <path>); a file committed after conversion must be restored from the computer that wrote it.`,
  };
}
