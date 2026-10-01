import { execFileSync } from "node:child_process";

const SHA = /^[0-9a-f]{40}$/u;
const NULL_SHA = /^0{40}$/u;

// A change set is "docs only" when every changed path is a Markdown document
// that no runtime behaviour or test fixture can depend on by location: a
// top-level *.md file or a *.md file under docs/. Markdown that ships behaviour
// (skills/, commands/) or lives anywhere else (templates, .sdlc, ...) never
// qualifies, and neither does any non-Markdown file.
export const CHANGE_SCOPE_POLICY = Object.freeze({
  // Only these events may skip; schedule and manual runs always run everything.
  events: Object.freeze(["pull_request", "push"]),
  extension: ".md",
  docsDirectories: Object.freeze(["docs/"]),
  protectedDirectories: Object.freeze(["skills/", "commands/"]),
});


export function isDocsOnlyPath(path, policy = CHANGE_SCOPE_POLICY) {
  if (typeof path !== "string" || path === "" || path.startsWith("/") || path.includes("\\")
    || path.split("/").some((segment) => segment === ".." || segment === "." || segment === "")) {
    return false;
  }
  if (policy.protectedDirectories.some((directory) => path.startsWith(directory))) return false;
  if (!path.endsWith(policy.extension)) return false;
  return !path.includes("/") || policy.docsDirectories.some((directory) => path.startsWith(directory));
}


// An empty change set is not docs-only: nothing proves that skipping is safe.
export function isDocsOnlyChange(paths, policy = CHANGE_SCOPE_POLICY) {
  return Array.isArray(paths)
    && paths.length > 0
    && paths.every((path) => isDocsOnlyPath(path, policy));
}


function runGit(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
    windowsHide: true,
  });
}


// Decides whether the suite may be skipped. Fails closed: every doubt (other
// event, missing or malformed base, git failure, empty diff) means "run it".
export function decideDocsOnly({ env, git = runGit, policy = CHANGE_SCOPE_POLICY }) {
  const event = env.CI_EVENT_NAME;
  if (!policy.events.includes(event)) {
    return { docsOnly: false, reason: `event ${JSON.stringify(event)} always runs the full suite` };
  }
  const base = event === "pull_request" ? env.CI_BASE_SHA : env.CI_BEFORE_SHA;
  if (!SHA.test(base ?? "") || NULL_SHA.test(base)) {
    return { docsOnly: false, reason: "no usable base commit to compare against" };
  }
  let paths;
  try {
    git(["fetch", "--no-tags", "--depth=1", "origin", base]);
    paths = git(["diff", "--name-only", "--no-renames", "-z", base, "HEAD"])
      .split("\0")
      .filter((path) => path !== "");
  } catch {
    return { docsOnly: false, reason: "the changed files could not be computed" };
  }
  if (!isDocsOnlyChange(paths, policy)) {
    return { docsOnly: false, reason: `${paths.length} changed file(s) include code or non-documentation content` };
  }
  return { docsOnly: true, reason: `${paths.length} changed file(s), all documentation` };
}
