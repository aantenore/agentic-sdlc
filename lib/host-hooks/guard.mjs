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
// The archives that command writes keep records that must never be deleted or rewritten by hand.
const ARCHIVE_TREE = /(?:^|[\s=:/\\])\.sdlc-archive(?=[\s\\/]|$)/iu;
// The acknowledgement of a merge made outside the plugin, kept next to the delivery's start and close.
const EXTERNAL_MERGE_RECORD = /\.sdlc[\\/]+autonomy[\\/]+executions[\\/]+[^\s\\/]+[\\/]+external-merge/iu;
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

// Subcommands only a person runs. They count only when a command actually invokes the CLI with them,
// never when the words sit inside a quoted argument (a message that mentions them, for example).
const PERSON_ONLY = [
  { words: ["autonomy", "standing", "approve"], reason: standingApproveReason },
  { words: ["autonomy", "delivery", "reconcile"], reason: deliveryReconcileReason },
  { words: ["autonomy", "delivery", "evidence", "supersede"], reason: deliveryEvidenceSupersedeReason },
  { words: ["story", "abandon"], reason: storyAbandonReason },
  // Moving the whole record tree aside is a person's decision; the plan (without --apply) stays open to agents.
  { words: ["project", "archive"], flag: "--apply", reason: projectArchiveReason },
];
const SHELL_INTERPRETERS = /^(?:sh|bash|zsh|dash|ksh|ash)(?:\.exe)?$/iu;
const CLI_WORD = /^(?:.*[\\/])?agentic-sdlc(?:\.mjs)?$/u;
const MAX_NESTING = 4;

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

function deliveryReconcileReason(command) {
  return "Only a person or CI can acknowledge a pull request merged outside the plugin, because it declares the story delivered without the plugin's own merge. "
    + `Explain what GitHub shows and ask the user to run this exact command themselves, in their own terminal: ${String(command).trim()}`;
}

function deliveryEvidenceSupersedeReason(command) {
  return "Only a person can declare a recorded evidence file lost or overwritten, because it excuses a change to evidence the audit trail depends on. "
    + `Explain what happened to the file and ask the user to run this exact command themselves, in their own terminal: ${String(command).trim()}`;
}

function storyAbandonReason(command) {
  return "Only a person can abandon a story, because it closes the story and cancels its workflow run for good. "
    + `Explain why the story is abandoned and ask the user to run this exact command themselves, in their own terminal: ${String(command).trim()}`;
}

function projectArchiveReason(command) {
  return "Only a person or CI can archive a project's .sdlc, because it moves the project's permanent approvals and history aside. "
    + "Show the user the plan ('agentic-sdlc project archive') and ask them to run this exact command themselves, "
    + `in their own terminal: ${String(command).trim()}`;
}

const ARCHIVE_REASON = "Archives under .sdlc-archive hold the moved project records and their manifest, and are written only by 'agentic-sdlc project archive'. "
  + "They are never deleted, moved, or edited by hand.";

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
      || EXTERNAL_MERGE_RECORD.test(text)
      || RECORD_TREE.test(` ${text} `)
      || (insideRecords && /autonomy|standing|metering|[?*[]/iu.test(text));
    if (segmentWritesFiles(segment) && ARCHIVE_TREE.test(` ${segment}`)) return deny(ARCHIVE_REASON);
    if (redirectTargets(segment).some((target) => ARCHIVE_TREE.test(` ${target}`))) return deny(ARCHIVE_REASON);
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

/**
 * Splits a shell command into simple commands, each a list of words with quotes
 * resolved. Command substitutions inside double quotes are returned as extra commands.
 */
export function parseShellCommands(command, { escapes = true } = {}) {
  const text = String(command || "");
  const commands = [];
  const nested = [];
  let words = [];
  let word = "";
  let started = false;
  const endWord = () => {
    if (started) words.push(word);
    word = "";
    started = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\" && escapes) {
      if (text[index + 1] === "\n") index += 1;
      else if (index + 1 < text.length) {
        word += text[index + 1];
        started = true;
        index += 1;
      }
    } else if (char === "'") {
      const close = text.indexOf("'", index + 1);
      const end = close === -1 ? text.length : close;
      word += text.slice(index + 1, end);
      started = true;
      index = end;
    } else if (char === '"') {
      started = true;
      let inner = "";
      for (index += 1; index < text.length && text[index] !== '"'; index += 1) {
        if (text[index] === "\\" && escapes && index + 1 < text.length) {
          index += 1;
          if (text[index] !== "\n") inner += /[$`"\\]/u.test(text[index]) ? text[index] : `\\${text[index]}`;
        } else inner += text[index];
      }
      for (const match of inner.matchAll(/\$\(([^)]*)\)|`([^`]*)`/gu)) nested.push(match[1] ?? match[2]);
      word += inner;
    } else if (/\s/u.test(char) && char !== "\n") {
      endWord();
    } else if (/[\n;&|(){}`]/u.test(char)) {
      endCommand();
    } else {
      word += char;
      started = true;
    }
  }
  endCommand();
  return { commands, nested };
}

function containsSequence(words, sequence) {
  return words.some((_, start) => sequence.every((item, offset) => words[start + offset]?.toLowerCase() === item));
}

/** The person-only reason when one simple command, or a shell string it runs, invokes a person-only subcommand. */
function personOnlyInvocation(rawCommand, escapes, depth = 0) {
  if (depth > MAX_NESTING) return null;
  const { commands, nested } = parseShellCommands(rawCommand, { escapes });
  for (const inner of nested) {
    const found = personOnlyInvocation(inner, escapes, depth + 1);
    if (found) return found;
  }
  for (const argv of commands) {
    const cli = argv.findIndex((word) => CLI_WORD.test(word));
    if (cli !== -1) {
      const args = argv.slice(cli + 1);
      const match = PERSON_ONLY.find((item) => containsSequence(args, item.words) && (!item.flag || args.includes(item.flag)));
      if (match) return match.reason(rawCommand);
    }
    // A shell run with -c, or eval, executes the string it is given.
    const program = (argv[0] || "").split(/[\\/]/u).pop();
    const script = SHELL_INTERPRETERS.test(program)
      ? argv[argv.findIndex((word) => /^-[a-z]*c[a-z]*$/u.test(word)) + 1]
      : (program === "eval" ? argv.slice(1).join(" ") : null);
    if (script) {
      const found = personOnlyInvocation(script, escapes, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

const MERGE_ESCAPE_VARIABLE = "AGENTIC_SDLC_ALLOW_UNGOVERNED_MERGE";
const GIT_ESCAPE_VARIABLE = "AGENTIC_SDLC_ALLOW_UNGOVERNED_GIT";
const PROTECTED_BASE_BRANCHES = new Set(["main", "master"]);
const COMMAND_WRAPPERS = new Set(["env", "command", "exec", "time", "nohup", "sudo", "rtk"]);
const GH_FLAGS_WITH_VALUE = new Set(["-R", "--repo", "-b", "--body", "-t", "--subject", "-F", "--body-file", "-A", "--author-email", "--match-head-commit"]);
const GH_API_MERGE_PATH = /\/pulls\/(\d+)\/merge(?:[/?#]|$)/u;
const PR_URL_NUMBER = /\/pull\/(\d+)(?:[/?#]|$)/u;

/** The program of one simple command, and its arguments, after variable assignments and wrappers such as env. */
function programOf(argv) {
  let index = 0;
  while (index < argv.length) {
    const word = argv[index];
    if (/^[A-Za-z_]\w*=/u.test(word) || (index > 0 && word.startsWith("-")) || COMMAND_WRAPPERS.has(word.split(/[\\/]/u).pop())) index += 1;
    else break;
  }
  const name = (argv[index] || "").split(/[\\/]/u).pop().replace(/\.exe$/iu, "");
  return { name, args: argv.slice(index + 1) };
}

function pullRequestReference(value) {
  const text = String(value ?? "");
  const url = PR_URL_NUMBER.exec(text);
  if (url) return { number: Number(url[1]), branch: null };
  if (/^\d+$/u.test(text)) return { number: Number(text), branch: null };
  return text ? { number: null, branch: text.replace(/^[^:]+:/u, "") } : { number: null, branch: null };
}

/** The directories named by `git -C <dir>` options before the subcommand, in order (empty when none). */
function gitDirectories(args) {
  const dirs = [];
  for (let index = 0; index < args.length && args[index] !== "push"; index += 1) {
    if (args[index] === "-C" && args[index + 1] !== undefined) dirs.push(args[index + 1]);
    if (GIT_OPTIONS_WITH_VALUE.has(args[index])) index += 1;
  }
  return dirs;
}

function pushedBranches(args) {
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    if (["-o", "--push-option", "--repo", "--receive-pack", "--exec"].includes(args[index])) index += 1;
    else if (!args[index].startsWith("-")) positional.push(args[index]);
  }
  return positional.slice(1).map((spec) => {
    const target = spec.includes(":") ? spec.slice(spec.lastIndexOf(":") + 1) : spec;
    return target.replace(/^\+/u, "").replace(/^refs\/heads\//u, "");
  });
}

/**
 * The merges one command would perform outside the governed action: gh pr merge, a PUT on the
 * merge endpoint of the API, and a git push to the protected base branch. Quoted mentions are not commands.
 */
export function ungovernedMergeAttempts(rawCommand, depth = 0) {
  if (depth > MAX_NESTING) return [];
  const attempts = [];
  for (const escapes of [true, false]) {
    const { commands, nested } = parseShellCommands(rawCommand, { escapes });
    for (const inner of nested) attempts.push(...ungovernedMergeAttempts(inner, depth + 1));
    for (const argv of commands) {
      const { name, args } = programOf(argv);
      if (SHELL_INTERPRETERS.test(name) || name === "eval") {
        const script = name === "eval" ? args.join(" ") : args[args.findIndex((word) => /^-[a-z]*c[a-z]*$/u.test(word)) + 1];
        if (script) attempts.push(...ungovernedMergeAttempts(script, depth + 1));
      } else if (name === "gh" && containsSequence(args, ["pr", "merge"])) {
        const rest = args.slice(args.findIndex((word, at) => word === "merge" && args[at - 1] === "pr") + 1);
        const positional = rest.find((word, at) => !word.startsWith("-") && !GH_FLAGS_WITH_VALUE.has(rest[at - 1]));
        attempts.push({ kind: "gh pr merge", ...pullRequestReference(positional) });
      } else if (name === "gh" && args.includes("api")) {
        const path = args.map((word) => GH_API_MERGE_PATH.exec(word)).find(Boolean);
        const method = args.findIndex((word) => /^(?:-X|--method)$/iu.test(word));
        const put = (method !== -1 && /^put$/iu.test(args[method + 1] || "")) || args.some((word) => /^(?:-X|--method)=?put$/iu.test(word));
        if (path && put) attempts.push({ kind: "gh api merge", number: Number(path[1]), branch: null });
      } else if (name === "git" && args.includes("push") && !args.includes("--delete")) {
        const push = args.slice(args.indexOf("push") + 1);
        const branches = pushedBranches(push);
        const base = branches.find((branch) => PROTECTED_BASE_BRANCHES.has(branch));
        const dirs = gitDirectories(args);
        attempts.push({ kind: "git push", storyPush: true, branches, dirs });
        // A push with no refspec sends the current branch; the checker resolves it.
        if (base) attempts.push({ kind: `git push to ${base}`, number: null, branch: null, direct: true, dirs });
        else if (branches.length === 0) attempts.push({ kind: "git push", number: null, branch: null, direct: true, currentBranchOnly: true, dirs });
      }
    }
  }
  return attempts;
}

function ungovernedMergeReason(attempt) {
  const target = attempt.kind.startsWith("git push")
    ? `${attempt.kind} sends commits to the protected base branch without a reviewed pull request`
    : `${attempt.kind} merges a pull request outside the governed action`;
  return `${target}, and no approved, not yet completed 'pull_request.merge' authorization covers it. `
    + "Run 'agentic-sdlc autonomy delivery action --action pull_request.merge ...' first and launch gh pr merge only after the authorization is granted. "
    + "If the governed action was refused, the merge must not happen: report it to the user instead. "
    + `A person can allow an ungoverned merge deliberately by setting ${MERGE_ESCAPE_VARIABLE}=1 in their own environment; an agent must never set it.`;
}

function humanEscape(options) {
  return options?.env?.[MERGE_ESCAPE_VARIABLE] === "1" || options?.env?.[GIT_ESCAPE_VARIABLE] === "1";
}

/** True when the repository the attempt acts on is one the person opted out of the guard (see merge-authorization.mjs). */
function repoOptedOut(options, attempt) {
  return typeof options?.isUngovernedRepo === "function" && options.isUngovernedRepo(attempt) === true;
}

function evaluateUngovernedMerge(rawCommand, options) {
  if (typeof options?.isMergeAuthorized !== "function") return null;
  const attempts = ungovernedMergeAttempts(rawCommand);
  if (attempts.length === 0) return null;
  if (humanEscape(options)) return null;
  const unauthorized = attempts.find((attempt) => !attempt.storyPush && !repoOptedOut(options, attempt) && !options.isMergeAuthorized(attempt));
  return unauthorized ? deny(ungovernedMergeReason(unauthorized)) : null;
}

function storyPushReason(branches) {
  return `git push to ${branches.length ? branches.join(", ") : "the current branch"} sends a story branch outside the governed action, and no approved, not yet completed 'git.push' authorization covers it. `
    + "Run 'agentic-sdlc autonomy delivery action --action git.push ...' first and push only after the authorization is granted. "
    + "If the governed action was refused or failed, the push must not happen: report it to the user instead. "
    + `A person can allow an ungoverned push deliberately by setting ${GIT_ESCAPE_VARIABLE}=1 in their own environment; an agent must never set it.`;
}

function evaluateStoryPush(rawCommand, options) {
  if (typeof options?.isStoryPushAuthorized !== "function" || humanEscape(options)) return null;
  const blocked = ungovernedMergeAttempts(rawCommand).find((attempt) => attempt.storyPush && !repoOptedOut(options, attempt) && !options.isStoryPushAuthorized(attempt));
  return blocked ? deny(storyPushReason(blocked.branches)) : null;
}

// Files git keeps its own state in: written only by git commands, never by hand.
const GIT_INTERNAL = /(?:^|[\\/=:])\.git[\\/]+(?:worktrees[\\/]+[^\\/\s]+[\\/]+)?(?:(?:MERGE_HEAD|MERGE_MSG|MERGE_MODE|HEAD|ORIG_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|AUTO_MERGE|packed-refs|index)(?![\w.-])|refs[\\/])|(?:^|[\\/=:])(?:MERGE_HEAD|MERGE_MSG|MERGE_MODE)$/iu;
const REDIRECT_WORD = /^\d*>>?\|?(.*)$/u;

function gitInternalReason(target) {
  return `Writing ${target} by hand fakes git's own state (an agent did this to fake a merge). Use the git command that owns it (git merge, git merge --abort, git checkout, git update-ref through the governed flow) `
    + `and the governed delivery actions. A person can allow it deliberately by setting ${GIT_ESCAPE_VARIABLE}=1 in their own environment; an agent must never set it.`;
}

/** The git-internal file one command would write by redirection or a write command, or null. */
function gitInternalWrite(rawCommand, depth = 0) {
  if (depth > MAX_NESTING) return null;
  for (const escapes of [true, false]) {
    const { commands, nested } = parseShellCommands(rawCommand, { escapes });
    for (const inner of nested) {
      const found = gitInternalWrite(inner, depth + 1);
      if (found) return found;
    }
    for (const argv of commands) {
      const { name, args } = programOf(argv);
      for (let index = 0; index < argv.length; index += 1) {
        const redirect = REDIRECT_WORD.exec(argv[index]);
        if (!redirect || /^\d*>&/u.test(argv[index])) continue;
        const target = redirect[1] || argv[index + 1] || "";
        if (GIT_INTERNAL.test(target)) return target;
      }
      if (SHELL_INTERPRETERS.test(name) || name === "eval") {
        const script = name === "eval" ? args.join(" ") : args[args.findIndex((word) => /^-[a-z]*c[a-z]*$/u.test(word)) + 1];
        const found = script ? gitInternalWrite(script, depth + 1) : null;
        if (found) return found;
      } else if (name !== "git" && (WRITE_COMMANDS.test(name) || (/^(?:sed|perl)$/iu.test(name) && args.some((word) => /^-\w*i/u.test(word))))) {
        const hit = args.find((word) => GIT_INTERNAL.test(word));
        if (hit) return hit;
      }
    }
  }
  return null;
}

function evaluateGitInternalWrite(rawCommand, options) {
  if (humanEscape(options)) return null;
  const target = gitInternalWrite(rawCommand);
  return target ? deny(gitInternalReason(target)) : null;
}

function evaluateShell(rawCommand, options) {
  const reason = personOnlyInvocation(rawCommand, true) || personOnlyInvocation(rawCommand, false);
  if (reason) return deny(reason);
  return evaluateNormalizedShell(normalizeShellCommand(rawCommand), rawCommand)
    || evaluateNormalizedShell(normalizeShellCommand(rawCommand, { backslashes: "separator" }), rawCommand)
    || evaluateUngovernedMerge(rawCommand, options)
    || evaluateStoryPush(rawCommand, options)
    || evaluateGitInternalWrite(rawCommand, options);
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
export function evaluatePreToolUse(payload, options = {}) {
  const toolName = String(payload?.tool_name || "");
  const toolInput = payload?.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};
  if (SHELL_TOOLS.has(toolName)) return evaluateShell(toolInput.command, options);
  const edited = editedPaths(toolName, toolInput);
  const protectedPaths = edited
    .filter((filePath) => /\/\.sdlc\/autonomy\/standing(?:\/|$)/u.test(normalizeEditedPath(filePath)));
  if (protectedPaths.length > 0) {
    return deny(
      `Standing approval records are immutable and written only by the agentic-sdlc CLI; this edit would change ${protectedPaths.join(", ")}. `
      + "Propose a new standing approval or revoke the existing one through the CLI instead.",
    );
  }
  const archivePaths = edited.filter((filePath) => /\/\.sdlc-archive(?:\/|$)/u.test(normalizeEditedPath(filePath)));
  if (archivePaths.length > 0) {
    return deny(`Archived project records are written only by 'agentic-sdlc project archive'; this edit would change ${archivePaths.join(", ")}.`);
  }
  const externalMergePaths = edited
    .filter((filePath) => /\/\.sdlc\/autonomy\/executions\/[^/]+\/external-merge/u.test(normalizeEditedPath(filePath)));
  if (externalMergePaths.length > 0) {
    return deny(
      `The acknowledgement of a merge made outside the plugin is written only by 'autonomy delivery reconcile', run by a person or CI; this edit would change ${externalMergePaths.join(", ")}.`,
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

const MAIN_THREAD_MODES = new Set(["free", "orchestrator"]);
const ORCHESTRATOR_EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

/** The configured main-thread mode (`host_policy.main_thread`): "orchestrator", or "free" when absent or unknown. */
export function mainThreadMode(config) {
  const value = config?.host_policy?.main_thread;
  return MAIN_THREAD_MODES.has(value) ? value : "free";
}

/** Session instruction for the orchestrator mode, or "" in any other mode. */
export function orchestratorSessionContext(mode) {
  if (mode !== "orchestrator") return "";
  return [
    "Agentic SDLC orchestrator mode (host_policy.main_thread): this main thread only coordinates.",
    "It reads messages and notifications, sends short messages, decides, and checks results; a single quick read-only command is fine inline.",
    "The main thread must never block: any command that might take more than about 10 seconds (tests, builds, plugin updates, publish, fetch) is launched in the background (Claude Code: Bash run_in_background, Codex: the equivalent) or delegated to a subagent; only quick read-only commands run in the foreground.",
    "Work that needs reasoning (code, fixes, story delivery, review) goes to background subagents.",
    "Mechanical work (builds, test suites, dev servers, long commands) goes to controlled background processes: an explicit deadline (for example a 10-minute timeout), no orphaned nohup or &, output in a file the main thread reads at the end, and a final check that no process is left running.",
  ].join("\n");
}

/**
 * Warning (never a block) for a file edit made from the main thread in the
 * orchestrator mode, or "" otherwise. The host adds `agent_id` to the payload
 * of a hook that fires inside a subagent and leaves it out on the main thread.
 */
export function orchestratorEditWarning(payload, mode) {
  if (mode !== "orchestrator") return "";
  if (!ORCHESTRATOR_EDIT_TOOLS.has(String(payload?.tool_name || ""))) return "";
  if (payload?.agent_id) return "";
  return "Agentic SDLC orchestrator mode: this edit runs on the main thread, which only coordinates. Hand the change to a background subagent instead.";
}
