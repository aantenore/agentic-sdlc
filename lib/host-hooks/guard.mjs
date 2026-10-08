/**
 * Decisions of the plugin's host hooks. The same hooks/hooks.json runs in
 * both supported agent hosts; this module only interprets the hook payload,
 * so it holds no I/O. A hook is a second line of defence: the CLI refuses a
 * standing approval approved, or a story claim taken over, from inside an
 * agent session, records are hash-sealed, and a hook that fails lets the tool
 * call through. The shared refs under refs/agentic-sdlc/ (standing approvals
 * and story claims) are protected by one prefix rule.
 */

const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const PATCH_PATH = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gmu;
const CLI_INVOCATION = /(?:^|[\s/\\])agentic-sdlc(?:\.mjs)?(?=\s|$)/u;
const STANDING_APPROVE = /\bautonomy\s+standing\s+approve\b/u;
// Any reference to the standing-approval or delivery usage records, including globs such as standing*.
const GLOBBED = "[^\\s/\\\\]*[?*[{][^\\s/\\\\]*";
const STANDING_RECORDS = new RegExp(
  `\\.sdlc[\\\\/]+(?:autonomy|${GLOBBED})[\\\\/]+(?:standing|metering|${GLOBBED})`
  // The refs that keep revocations, used slots, and claims, stored by git itself (also per worktree).
  + `|\\.git[\\\\/]+(?:worktrees[\\\\/]+[^\\s\\\\/]+[\\\\/]+)?(?:logs[\\\\/]+)?refs[\\\\/]+(?:worktree[\\\\/]+)?agentic|\\.git[\\\\/]+packed-refs`,
  "iu",
);
// The whole record tree or its autonomy branch as a target (restore it, delete it).
const RECORD_TREE = /(?:^|[\s=:])(?:\.[\\/])?\.sdlc(?:[\\/]+autonomy)?[\\/]*(?=\s|$)/iu;
const SHARED_REFS = /\brefs\/(?:worktree\/)?agentic-sdlc(?:-shared|-local)?\b/u;
// Refs only the CLI writes in this repository: what it has seen, and the secret-backed proof of its own claims.
const LOCAL_ONLY_REFS = /\brefs\/(?:agentic-sdlc-(?:local|shared)|worktree\/agentic-sdlc)\b/u;
const REF_REWRITING_GIT = new Set(["push", "update-ref", "replace", "branch", "tag", "reflog", "gc", "prune", "filter-branch", "filter-repo", "fetch", "clone"]);
const GIT_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
const WRITE_COMMANDS = /^(?:rm|rmdir|mv|cp|ln|tee|truncate|unlink|touch|chmod|chown|dd|install|rsync|shred|remove-item|set-content|add-content|out-file|move-item|copy-item|new-item|clear-content|del|erase|move|copy|ren|rename)$/iu;
const INLINE_INTERPRETER = /^(?:node|python3?|ruby|perl|deno|bun|pwsh|powershell)$/iu;
// Clearing or overriding the variables that mark an agent session, in sh or PowerShell.
const MARKER_NAMES = /^(?:CLAUDECODE|CODEX_THREAD_ID|CODEX_AGENT_NAME)=/u;
// "proc(?:ess)" keeps this pattern from reading as a use of the global process object.
const MARKER_CHANGE = /(?:proc(?:ess)\.env|os\.environ|unsetenv|putenv|\bENV\[|\$env)[^;\n]*\b(?:CLAUDECODE|CODEX_THREAD_ID|CODEX_AGENT_NAME)\b|\b(?:CLAUDECODE|CODEX_THREAD_ID|CODEX_AGENT_NAME)\b[^;\n]*\b(?:pop|unsetenv|putenv)\b|\bunset\b[^;&|\n]*\b(?:CLAUDECODE|CODEX_THREAD_ID|CODEX_AGENT_NAME)\b|\benv\b[^;&|\n]*(?:-u\s*|--unset[= ])(?:CLAUDECODE|CODEX_THREAD_ID|CODEX_AGENT_NAME)\b|\$env:(?:CLAUDECODE|CODEX_THREAD_ID|CODEX_AGENT_NAME)\s*=|Env:[\\/]?(?:CLAUDECODE|CODEX_THREAD_ID|CODEX_AGENT_NAME)\b|SetEnvironmentVariable\s*\(\s*(?:CLAUDECODE|CODEX_THREAD_ID|CODEX_AGENT_NAME)/iu;
const WRITING_GIT = new Set(["rm", "mv", "checkout", "restore", "reset", "clean", "stash", "apply", "am", "cherry-pick", "revert", "switch", "merge", "rebase", "pull"]);

function deny(reason) {
  return { decision: "deny", reason };
}

/**
 * Joins line continuations and drops quoting and escapes, so quoting tricks do
 * not hide a command. Backslashes are either removed (shell escapes) or read as
 * path separators (Windows paths); both readings are checked.
 */
export function normalizeShellCommand(command, { backslashes = "remove" } = {}) {
  const joined = String(command || "")
    .replace(/\\\r?\n/gu, " ")
    .replace(/`\r?\n/gu, " ")
    .replace(/\$(?=['"])/gu, "")
    .replace(/["']/gu, "");
  return (backslashes === "remove" ? joined.replace(/\\/gu, "") : joined.replace(/\\/gu, "/"))
    .replace(/[ \t]+/gu, " ");
}

/** Simple command segments: split at ; && || | and newlines. */
function segments(command) {
  return command.split(/&&|\|\||[;|\n]/u).map((segment) => segment.trim()).filter(Boolean);
}

function words(segment) {
  return segment.split(/\s+/u).filter(Boolean);
}

/** The git subcommand of a segment, skipping global options, or null when it is not git. */
function gitSubcommand(segment) {
  const parts = words(segment);
  const start = parts.findIndex((word) => /(?:^|[\\/])git(?:\.exe)?$/iu.test(word));
  if (start === -1) return null;
  for (let index = start + 1; index < parts.length; index += 1) {
    const word = parts[index];
    if (GIT_OPTIONS_WITH_VALUE.has(word)) {
      index += 1;
      continue;
    }
    if (word.startsWith("-")) continue;
    return word.toLowerCase();
  }
  return null;
}

/** Output redirection targets of a segment, ignoring the null device and stream duplication. */
function redirectTargets(segment) {
  return [...segment.matchAll(/\d*>>?\s*(\S+)/gu)]
    .map((match) => match[1])
    .filter((target) => !/^(?:\/dev\/null|nul|\$null|&\d)$/iu.test(target));
}

/** True when a segment changes files other than through output redirection. */
function segmentWritesFiles(segment) {
  const parts = words(segment.replace(/\d*>>?\s*\S+/gu, " "));
  for (let index = 0; index < parts.length; index += 1) {
    const command = parts[index].split(/[\\/]/u).pop();
    if (WRITE_COMMANDS.test(command)) return true;
    if (/^(?:sed|perl)$/iu.test(command) && parts.slice(index + 1).some((word) => /^-\w*i/u.test(word))) return true;
    if (INLINE_INTERPRETER.test(command) && parts.slice(index + 1).some((word) => /^-(?:e|c|command)$/iu.test(word))
      && /unlink|rmSync|rmdir|remove|writeFile|appendFile|copyFile|rename|truncate|createWriteStream|open\([^)]*\b[wa]\b|os\.system|subprocess|shutil|spawn|exec|Set-Content|Remove-Item/iu.test(segment)) return true;
    if (command === "find" && parts.some((word) => /^-(?:delete|exec|execdir)$/u.test(word))) return true;
  }
  const subcommand = gitSubcommand(segment);
  // Unstaging only touches the index, never the files.
  if (subcommand === "restore" && /\s--staged\b/u.test(segment) && !/\s--worktree\b|\s-W\b/u.test(segment)) return false;
  return WRITING_GIT.has(subcommand);
}

/** Untracked records would be deleted by a forced clean or an untracked stash without a narrower path. */
function removesUntrackedRecords(segment) {
  const subcommand = gitSubcommand(segment);
  const parts = words(segment);
  const afterSubcommand = parts.slice(parts.findIndex((word) => word.toLowerCase() === subcommand) + 1);
  if (subcommand === "stash" && afterSubcommand[0] && /^(?:show|list|apply|pop|drop|branch|clear|create|store)$/u.test(afterSubcommand[0])) return false;
  // Paths after the options, with or without "--": the command is narrowed unless one of them covers the records.
  const pathspec = afterSubcommand.filter((word, index) => !word.startsWith("-") && !/^-e$|^--exclude$/u.test(afterSubcommand[index - 1] || ""));
  const coversRecords = (part) => /^(?::\/|\.\/?|\*+|\*\*.*|\.?\/?\.sdlc.*|:\/.*)$/u.test(part);
  const narrowed = pathspec.length > 0 && !pathspec.some(coversRecords);
  if (subcommand === "clean") {
    // Dry runs and ignored-files-only cleans never delete records.
    if (afterSubcommand.some((word) => /^(?:-\w*n\w*|--dry-run|-\w*X\w*)$/u.test(word))) return false;
    const excludesRecords = /\s(?:-e\s*|--exclude=)(?:\.\/)?\.sdlc\/?(?=\s|$)/u.test(segment);
    return !narrowed && !excludesRecords;
  }
  if (subcommand === "stash") return /\s(?:-u|-a|--include-untracked|--all)\b/u.test(segment) && !narrowed;
  return false;
}

/** Leading VAR=value assignments of a segment, plus export/set/env forms. */
function changesSessionMarker(segment) {
  const parts = words(segment);
  let index = 0;
  if (/^(?:export|set|declare|typeset|readonly|local)$/u.test(parts[0] || "")) index = 1;
  if (parts[0] === "env") {
    for (index = 1; index < parts.length && (parts[index].startsWith("-") || /^\w+=/u.test(parts[index])); index += 1) {
      if (MARKER_NAMES.test(parts[index])) return true;
    }
    return /\s(?:-u\s*|--unset[= ])(?:CLAUDECODE|CODEX_THREAD_ID|CODEX_AGENT_NAME)\b/u.test(segment);
  }
  for (; index < parts.length && /^\w+=/u.test(parts[index]); index += 1) {
    if (MARKER_NAMES.test(parts[index])) return true;
  }
  return false;
}

function standingApproveReason(command) {
  return "Only the user can approve a standing approval, because it lets later deliveries proceed without asking them. "
    + "Show the user its plain-language limits (autonomy standing explain) and ask them to run this exact command themselves, "
    + `in their own terminal: ${String(command).trim()}`;
}

const RECORDS_REASON = "Standing approval records under .sdlc/autonomy/standing and delivery usage records under .sdlc/autonomy/metering "
  + "are append-only and written only by the agentic-sdlc CLI (autonomy standing propose, revoke, sync; budget usage record, "
  + "budget meter start, and budget meter record with --delivery). Use those commands instead of changing the files.";
const REFS_REASON = "The refs under refs/agentic-sdlc/ hold the state every copy of the project shares: standing approvals "
  + "(used deliveries and revocations) and story claims (who works on which story, and when each claim ended); "
  + "refs/agentic-sdlc-shared/, refs/agentic-sdlc-local/, and refs/worktree/agentic-sdlc/ hold what this repository has seen and proof of its own claims. "
  + "They are created only by the agentic-sdlc CLI (story claim, story release, autonomy standing) and are never pushed, deleted, or rewritten by hand; "
  + "mirror or prune pushes would delete them on the remote.";
const MARKER_REASON = "The variables that mark this agent session (CLAUDECODE, CODEX_THREAD_ID, CODEX_AGENT_NAME) tell agentic-sdlc "
  + "that the agent, not the user, is running a command. Clearing or overriding them is not allowed.";
const CLEAN_REASON = "This would delete uncommitted project records under .sdlc (for example a standing approval's revocation or used deliveries). "
  + "Commit the records first, or limit the command to other paths (for example `git clean -fd -- src/` or `-e .sdlc`).";

function evaluateNormalizedShell(command, rawCommand) {
  if (!command.trim()) return null;
  if (MARKER_CHANGE.test(command)
    || segments(command).some(changesSessionMarker)
    || (/\benv\b[^;&|\n]*(?:\s-i\b|--ignore-environment)/u.test(command) && /agentic/iu.test(command))) {
    return deny(MARKER_REASON);
  }
  if (STANDING_APPROVE.test(command) && CLI_INVOCATION.test(command)) {
    return deny(standingApproveReason(rawCommand));
  }
  let insideRecords = false;
  for (const segment of segments(command)) {
    const cd = /^(?:cd|pushd|Set-Location|sl)\s+(\S+)/iu.exec(segment);
    if (cd) {
      insideRecords = /\.sdlc/iu.test(cd[1]) || (insideRecords && !/^[\\/~]|^[A-Za-z]:/u.test(cd[1]));
      continue;
    }
    // A path ending in agentic-sdlc (a ref folder) is not a CLI run when the segment deletes or writes files.
    if (CLI_INVOCATION.test(segment) && !segmentWritesFiles(segment)) continue;
    if (["clean", "stash"].includes(gitSubcommand(segment))) {
      if (removesUntrackedRecords(segment)) return deny(CLEAN_REASON);
      continue;
    }
    const touches = (text) => STANDING_RECORDS.test(text)
      || RECORD_TREE.test(` ${text} `)
      || (insideRecords && /autonomy|standing|metering|[?*[]/iu.test(text));
    if (segmentWritesFiles(segment) && touches(segment)) return deny(RECORDS_REASON);
    if (redirectTargets(segment).some(touches)) return deny(RECORDS_REASON);
  }
  // Refs written from a pipe or a file cannot be checked here, so a batch update-ref is refused with them.
  if (/\bupdate-ref\b[^;&|\n]*--stdin/u.test(command)
    && (/agentic/u.test(command) || /\|[^;&|\n]*\bupdate-ref\b[^;&|\n]*--stdin/u.test(command) || /\bupdate-ref\b[^;&|\n]*--stdin[^;&|\n]*</u.test(command))) {
    return deny(REFS_REASON);
  }
  const variableRefs = /\b\w+=\S*refs\/(?:worktree\/)?agentic/u.test(command);
  const rewritesSharedRefs = segments(command).some((segment) => {
    const subcommand = gitSubcommand(segment);
    if (!subcommand) return false;
    if (subcommand === "push" && /\s--(?:mirror|prune)\b/u.test(segment)) return true;
    // A ref name kept in a variable elsewhere in the command still counts.
    if (variableRefs && ["push", "update-ref"].includes(subcommand) && /\$/u.test(segment)) return true;
    if (!SHARED_REFS.test(segment) || !REF_REWRITING_GIT.has(subcommand)) return false;
    // Reading the refs stays allowed: a plain fetch to FETCH_HEAD, or listing branches and tags.
    // Fetching into the CLI's own seen or ownership refs would plant records there.
    if (subcommand === "fetch") return LOCAL_ONLY_REFS.test(segment) || /\s--(?:prune|force)\b|\s\+|\s-f\b/u.test(segment);
    if (subcommand === "clone") return /\s--mirror\b/u.test(segment);
    if (subcommand === "branch" || subcommand === "tag") return /\s-(?:d|D|f|m|M)\b|--delete|--force/u.test(segment);
    return true;
  });
  return rewritesSharedRefs ? deny(REFS_REASON) : null;
}

function evaluateShell(rawCommand) {
  return evaluateNormalizedShell(normalizeShellCommand(rawCommand), rawCommand)
    || evaluateNormalizedShell(normalizeShellCommand(rawCommand, { backslashes: "separator" }), rawCommand);
}

/** Normalizes a file path for matching: forward slashes, no `.`/`..` segments, lower case. */
export function normalizeEditedPath(filePath) {
  const parts = [];
  for (const part of String(filePath).replace(/\\/gu, "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`.toLowerCase();
}

/** Paths a file tool would write, in either host's payload shape. */
export function editedPaths(toolName, toolInput = {}) {
  if (FILE_TOOLS.has(toolName)) {
    return [toolInput.file_path, toolInput.notebook_path, toolInput.path].filter((value) => typeof value === "string");
  }
  if (toolName === "apply_patch") {
    const patch = String(toolInput.command ?? toolInput.patch ?? toolInput.input ?? "");
    return [...patch.matchAll(PATCH_PATH)].map((match) => match[1].trim());
  }
  return [];
}

/**
 * PreToolUse decision for one tool call, or null to let the host's normal
 * permission flow decide.
 */
export function evaluatePreToolUse(payload) {
  const toolName = String(payload?.tool_name || "");
  const toolInput = payload?.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};
  if (SHELL_TOOLS.has(toolName)) return evaluateShell(toolInput.command);
  const edited = editedPaths(toolName, toolInput);
  const protectedPaths = edited
    .filter((filePath) => /\/\.sdlc\/autonomy\/standing(?:\/|$)/u.test(normalizeEditedPath(filePath)));
  if (protectedPaths.length > 0) {
    return deny(
      `Standing approval records are immutable and written only by the agentic-sdlc CLI; this edit would change ${protectedPaths.join(", ")}. `
      + "Propose a new standing approval or revoke the existing one through the CLI instead.",
    );
  }
  const usagePaths = edited
    .filter((filePath) => /\/\.sdlc\/autonomy\/metering(?:\/|$)/u.test(normalizeEditedPath(filePath)));
  if (usagePaths.length > 0) {
    return deny(
      `Delivery usage records are append-only and written only by the agentic-sdlc CLI; this edit would change ${usagePaths.join(", ")}. `
      + "Record usage with budget usage record or budget meter record --delivery instead; removing or editing a record would hide spent cost.",
    );
  }
  return null;
}

/** Short context about standing approvals for the start of a session. */
export function sessionStartContext(status) {
  const approvals = Array.isArray(status?.standing_approvals) ? status.standing_approvals : [];
  if (approvals.length === 0) return "";
  const lines = approvals.slice(0, 10).map((item) => {
    const shared = item.shared_state?.scope === "shared"
      ? (item.shared_state.checked
          ? `shared through '${item.shared_state.remote}'`
          : `shared remote '${item.shared_state.remote}' unreachable, so it covers nothing right now`)
      : "kept on this computer only";
    const signed = item.assurance === "host_verified" ? "; approval signed by the trusted host" : "";
    return `- ${item.id}: ${item.status}, ${item.used} of ${item.max_deliveries} deliveries used, expires ${item.expires_at}; ${shared}${signed}.`;
  });
  if (approvals.length > lines.length) lines.push(`- and ${approvals.length - lines.length} more (autonomy standing status).`);
  return [
    "Agentic SDLC standing approvals in this project:",
    ...lines,
    "Rely on one only through `--standing-approval` on the CLI. When a step is not covered, show the reason and ask the user for the normal confirmation. Only the user approves a standing approval, in their own terminal.",
  ].join("\n");
}
