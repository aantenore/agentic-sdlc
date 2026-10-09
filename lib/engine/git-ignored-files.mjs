import { childProcess } from "../runtime/host.mjs";

// Files Git ignores (any .gitignore, nested ones included, .git/info/exclude,
// core.excludesFile) are not project files. These helpers ask Git itself, so
// the project sees exactly the rules `git status` applies, and ignored folders
// are never walked or read. baseline_policy.ignored_files: include keeps the
// earlier behaviour, where only the configured folder names were left out.

const GIT_IGNORED_OUTPUT_MAX_BYTES = 256 * 1024 * 1024;

export function baselineHonoursGitIgnore(context) {
  return (context?.config?.baseline_policy?.ignored_files ?? "exclude") !== "include";
}

function gitRecords(root, args, input = null) {
  try {
    const raw = childProcess.execFileSync("git", ["-C", root, ...args], {
      encoding: null,
      input: input ?? undefined,
      maxBuffer: GIT_IGNORED_OUTPUT_MAX_BYTES,
      stdio: [input === null ? "ignore" : "pipe", "pipe", "ignore"],
    });
    return raw.toString("utf8").split("\u0000").filter(Boolean);
  } catch (error) {
    // check-ignore exits 1 when no path is ignored.
    if (error?.status === 1 && error.stdout) {
      return error.stdout.toString("utf8").split("\u0000").filter(Boolean);
    }
    return null;
  }
}

function insideWorkTree(root) {
  const records = gitRecords(root, ["rev-parse", "--is-inside-work-tree"]);
  return records !== null && records.join("").trim() === "true";
}

/**
 * Files Git sees under the requested project paths: tracked files plus
 * untracked files no ignore rule matches, with every folder that holds one.
 * null when the project is not a Git worktree, Git cannot list it, or the
 * policy asks to include ignored files.
 */
export function gitVisibleProjectFiles(context, requestedPaths = ["."]) {
  if (!baselineHonoursGitIgnore(context) || !insideWorkTree(context.root)) return null;
  const pathspecs = (requestedPaths.length > 0 ? requestedPaths : ["."])
    .map((projectPath) => `:(literal)${String(projectPath).replace(/\\/gu, "/")}`);
  const records = gitRecords(context.root, [
    "-c", "core.quotePath=false",
    "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...pathspecs,
  ]);
  if (records === null) return null;
  const files = new Set(records);
  const directories = new Set(["."]);
  for (const filePath of files) {
    let index = filePath.lastIndexOf("/");
    while (index > 0) {
      const directory = filePath.slice(0, index);
      if (directories.has(directory)) break;
      directories.add(directory);
      index = directory.lastIndexOf("/");
    }
  }
  return { files, directories };
}

/**
 * The given project paths that Git ignores and does not track. Paths are only
 * matched against the rules; nothing is read. Empty when the project is not a
 * Git worktree or the policy asks to include ignored files.
 */
export function gitIgnoredUntrackedPaths(context, projectPaths) {
  const candidates = [...new Set(projectPaths || [])].filter(Boolean);
  if (candidates.length === 0 || !baselineHonoursGitIgnore(context) || !insideWorkTree(context.root)) {
    return new Set();
  }
  const records = gitRecords(
    context.root,
    ["check-ignore", "-z", "--stdin"],
    `${candidates.join("\u0000")}\u0000`,
  );
  return new Set(records || []);
}
