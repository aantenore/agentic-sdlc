import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
  `\\.sdlc[\\\\/]+(?:autonomy|${GLOBBED})[\\\\/]+(?:standing|metering|delegations|${GLOBBED})`
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
  { words: ["autonomy", "delivery", "evidence", "supersede"], reason: deliveryEvidenceSupersedeReason, delegable: true },
  { words: ["story", "abandon"], reason: storyAbandonReason, delegable: true },
  { words: ["story", "retire"], reason: storyRetireReason, delegable: true },
  // A delegation is granted and revoked only by the person; the agent never writes the authority it would use.
  { words: ["autonomy", "delegation", "grant"], reason: delegationReason },
  { words: ["autonomy", "delegation", "revoke"], reason: delegationReason },
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

function storyRetireReason(command) {
  return "Only a person can retire a story, because it closes the story for good as superseded by its child stories. "
    + `Explain which child stories delivered its work and ask the user to run this exact command themselves, in their own terminal: ${String(command).trim()}`;
}

function delegationReason(command) {
  return "Only the user can grant or revoke an approval delegation, because it lets the agent apply person-only approvals on their behalf. "
    + `Explain the scope, actions and expiry and ask the user to run this exact command themselves, in their own terminal: ${String(command).trim()}`;
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

const RECORDS_REASON = "Standing approval records under .sdlc/autonomy/standing, approval delegations under .sdlc/autonomy/delegations and delivery usage records under .sdlc/autonomy/metering "
  + "are append-only and written only by the agentic-sdlc CLI (autonomy standing propose, revoke, sync; budget usage record, "
  + "budget meter start, and budget meter record with --delivery). Use those commands instead of changing the files.";
const REFS_REASON = "The refs under refs/agentic-sdlc/ hold the state every copy of the project shares: standing approvals "
  + "(used deliveries and revocations) and story claims (who works on which story, and when each claim ended); "
  + "refs/agentic-sdlc-shared/, refs/agentic-sdlc-local/, and refs/worktree/agentic-sdlc/ hold what this repository has seen and proof of its own claims. "
  + "They are created only by the agentic-sdlc CLI (story claim, story release, autonomy standing) and are never pushed, deleted, or rewritten by hand; "
  + "mirror or prune pushes would delete them on the remote.";
const MARKER_REASON = "The variables that mark this agent session (CLAUDECODE, CODEX_THREAD_ID, CODEX_AGENT_NAME) tell agentic-sdlc "
  + "that the agent, not the user, is running a command. Clearing or overriding them is not allowed.";
// The project configuration and the keys that switch the merge and push guard.
const PROJECT_CONFIG = /(?:^|[\s=:/\\])\.sdlc[\\/]+config\.json(?=[\s"'\\/;&|)]|$)/iu;
const GUARD_POLICY_KEYS = /protect_base_branch|\bguard\b/u;
// A shell write cannot be compared key by key, so any host_policy change there counts.
const SHELL_GUARD_POLICY_KEYS = /protect_base_branch|host_policy|\bguard\b/u;
const GUARD_POLICY_REASON = "host_policy.guard in .sdlc/config.json decides whether the merge and push guard applies; an agent never changes it. "
  + "Only a person changes it, in a reviewed commit on the base branch.";
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
    if (SHELL_GUARD_POLICY_KEYS.test(command)
      && ((segmentWritesFiles(segment) && PROJECT_CONFIG.test(` ${segment}`)) || redirectTargets(segment).some((target) => PROJECT_CONFIG.test(` ${target}`)))) {
      return deny(GUARD_POLICY_REASON);
    }
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

const HEREDOC_WORD_END = /[\s;&|<>()]/u;

/**
 * The here-document that starts at `index` (the first `<` of `<<`), read like the shell reads it:
 * an optional `-`, blanks, then one whole word up to an unquoted metacharacter; the delimiter is
 * the word with quotes and backslashes removed, and the body is quoted when any part of the word
 * is. Returns null when the word cannot be read exactly (empty, an unclosed quote, an expansion),
 * so the lines that follow are read as commands.
 */
function readHeredoc(text, index) {
  let at = index + 2;
  const stripTabs = text[at] === "-";
  if (stripTabs) at += 1;
  while (text[at] === " " || text[at] === "\t") at += 1;
  let delimiter = "";
  let quoted = false;
  const start = at;
  while (at < text.length && !HEREDOC_WORD_END.test(text[at])) {
    const char = text[at];
    if (char === "'") {
      const close = text.indexOf("'", at + 1);
      if (close === -1 || text.slice(at + 1, close).includes("\n")) return null;
      delimiter += text.slice(at + 1, close);
      quoted = true;
      at = close + 1;
    } else if (char === '"') {
      let close = at + 1;
      let inner = "";
      for (; close < text.length && text[close] !== '"'; close += 1) {
        const current = text[close];
        if (current === "\n" || current === "`" || current === "$") return null;
        if (current === "\\") {
          const next = text[close + 1];
          if (next === undefined || next === "\n") return null;
          inner += /[$`"\\]/u.test(next) ? next : `\\${next}`;
          close += 1;
        } else inner += current;
      }
      if (close >= text.length) return null;
      delimiter += inner;
      quoted = true;
      at = close + 1;
    } else if (char === "\\") {
      const next = text[at + 1];
      if (next === undefined || next === "\n") return null;
      delimiter += next;
      quoted = true;
      at += 2;
    } else if (char === "$" || char === "`") {
      return null;
    } else {
      delimiter += char;
      at += 1;
    }
  }
  if (at === start || delimiter === "") return null;
  return { delimiter, stripTabs, quoted, length: at - index };
}

/**
 * Skips the bodies of the pending here-documents starting at `start` and returns the index after
 * the last delimiter line (or the end of the text when one is never closed, as the shell does).
 * Substitutions in a body with an unquoted delimiter are kept as nested commands.
 */
function skipHeredocBodies(text, start, pending, nested) {
  let index = start;
  for (const { delimiter, stripTabs, quoted } of pending) {
    while (index < text.length) {
      const newline = text.indexOf("\n", index);
      const end = newline === -1 ? text.length : newline;
      const line = text.slice(index, end);
      index = end + 1;
      if ((stripTabs ? line.replace(/^\t+/u, "") : line) === delimiter) break;
      if (!quoted) for (const match of line.matchAll(/\$\(([^)]*)\)|`([^`]*)`/gu)) nested.push(match[1] ?? match[2]);
    }
  }
  return Math.min(index, text.length);
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
  const heredocs = [];
  let arithmetic = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    // `<<` is a here-document only outside quotes and arithmetic, where it is a shift.
    const heredoc = char === "<" && text[index + 1] === "<" && text[index + 2] !== "<" && arithmetic === 0 ? readHeredoc(text, index) : null;
    if (heredoc) {
      // The body is data for the command, not commands; an unquoted body still runs its substitutions.
      heredocs.push(heredoc);
      endWord();
      index += heredoc.length - 1;
    } else if (char === "(" && text[index + 1] === "(") {
      arithmetic += 1;
      endCommand();
      index += 1;
    } else if (char === ")" && text[index + 1] === ")" && arithmetic > 0) {
      arithmetic -= 1;
      endCommand();
      index += 1;
    } else if (char === "\n" && heredocs.length > 0) {
      endCommand();
      index = skipHeredocBodies(text, index + 1, heredocs.splice(0), nested) - 1;
    } else if (char === "\\" && escapes) {
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

/** The agent applies a person's delegation; the CLI verifies it before anything is recorded. */
function appliesDelegation(args) {
  const source = args.indexOf("--approval-source");
  return source !== -1 && args[source + 1] === "delegated" && args.some((word) => word === "--delegation" || word.startsWith("--delegation="));
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
      const match = PERSON_ONLY.find((item) => containsSequence(args, item.words)
        && (!item.flag || args.includes(item.flag))
        && !(item.delegable && appliesDelegation(args)));
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
        if (base) attempts.push({ kind: `git push to ${base}`, number: null, branch: null, direct: true, base, dirs });
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

function guardPolicyOf(file) {
  try {
    return JSON.stringify(JSON.parse(fs.readFileSync(file, "utf8"))?.host_policy?.guard ?? null);
  } catch {
    return null;
  }
}

/**
 * True when a file tool would change host_policy.guard in .sdlc/config.json: an edit whose old or
 * new text names the keys, or a whole-file write whose guard policy differs from the file's own
 * (or cannot be compared and names the keys).
 */
function editsGuardPolicy(toolName, toolInput, edited, cwd) {
  const configs = edited.filter((filePath) => /\/\.sdlc\/config\.json$/u.test(normalizeEditedPath(filePath)));
  if (configs.length === 0) return false;
  if (toolName === "apply_patch") return GUARD_POLICY_KEYS.test(String(toolInput.command ?? toolInput.patch ?? toolInput.input ?? ""));
  const edits = Array.isArray(toolInput.edits) ? toolInput.edits : [toolInput];
  if (edits.some((edit) => GUARD_POLICY_KEYS.test(`${edit?.old_string ?? ""}\n${edit?.new_string ?? ""}`))) return true;
  if (typeof toolInput.content !== "string") return false;
  let next = null;
  try {
    next = JSON.stringify(JSON.parse(toolInput.content)?.host_policy?.guard ?? null);
  } catch {
    return GUARD_POLICY_KEYS.test(toolInput.content);
  }
  return configs.some((filePath) => {
    const current = guardPolicyOf(path.resolve(String(cwd || process.cwd()), filePath));
    return current === null ? next !== "null" : current !== next;
  });
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
  if (editsGuardPolicy(toolName, toolInput, edited, payload?.cwd)) return deny(GUARD_POLICY_REASON);
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

const MAIN_THREAD_MODES = new Set(["free", "orchestrator", "strict"]);
const ORCHESTRATOR_EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);
const STRICT_DENY_REASON = "Agentic SDLC strict main-thread mode: the main thread only coordinates; delega a un subagent (Agent tool) o lancia il comando in background (run_in_background).";

const GIT_PREFIX = String.raw`git(?:\s+-C\s+\S+)?\s+`;
const CLI_PREFIX = String.raw`(?:rtk\s+)?(?:agentic-sdlc|node\s+\S*agentic-sdlc\.mjs)\s+`;
/** Segments (one simple command) that the strict main thread may run in the foreground. */
export const STRICT_DEFAULT_ALLOW = [
  String.raw`(?:ls|cat|head|tail|wc|grep|rg|jq|ps|pwd|echo|date|which)(?:\s|$)`,
  String.raw`find(?!.*\s(?:-exec|-execdir|-delete|-ok|-fprint\w*)\b)(?:\s|$)`,
  String.raw`${GIT_PREFIX}(?:status|log|diff|show|fetch|rev-parse|ls-tree)(?:\s|$)`,
  String.raw`${GIT_PREFIX}branch(?!.*\s(?:-[dDmMcC]|--delete|--move|--copy|--set-upstream-to|--unset-upstream)\b)(?:\s|$)`,
  String.raw`${GIT_PREFIX}worktree\s+list(?:\s|$)`,
  String.raw`gh\s+pr\s+(?:view|list|checks)(?:\s|$)`,
  String.raw`${CLI_PREFIX}(?:message\s+(?:send|read|who)|story\s+working|status)(?:\s|$)`,
  String.raw`claude\s+plugin(?:s)?(?:\s|$)`,
];

/** The effective main-thread mode: AGENTIC_SDLC_MAIN_THREAD (user level) wins over `host_policy.main_thread`; "free" when absent or unknown. */
export function mainThreadMode(config, env = {}) {
  const fromEnv = String(env?.AGENTIC_SDLC_MAIN_THREAD || "").trim().toLowerCase();
  if (MAIN_THREAD_MODES.has(fromEnv)) return fromEnv;
  const value = config?.host_policy?.main_thread;
  return MAIN_THREAD_MODES.has(value) ? value : "free";
}

function strictAllowPatterns(env) {
  const extra = String(env?.AGENTIC_SDLC_MAIN_THREAD_ALLOW || "").split(/\n|;;/u).map((item) => item.trim()).filter(Boolean);
  const patterns = [];
  for (const source of [...STRICT_DEFAULT_ALLOW.map((item) => `^(?:[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+)*(?:${item})`), ...extra]) {
    try {
      patterns.push(new RegExp(source, "u"));
    } catch {
      // an invalid custom pattern allows nothing
    }
  }
  return patterns;
}

/**
 * Splits a shell command into simple-command segments on |, ||, && and ;,
 * outside quotes. Returns null when it holds anything not statically
 * checkable: command substitution, a background `&`, or a redirection to
 * anything but /dev/null.
 */
function shellSegments(command) {
  const text = String(command || "").replace(/(?:&>|\d?>>?)\s*\/dev\/null\b|\d?>&\d\b/gu, " ");
  const segments = [];
  let current = "";
  let quote = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (quote) {
      if (char === "\\" && quote === '"') {
        current += char + (next ?? "");
        index += 1;
        continue;
      }
      if (quote === '"' && (char === "`" || (char === "$" && next === "("))) return null;
      if (char === quote) quote = "";
      current += char;
      continue;
    }
    if (char === "\\") {
      current += char + (next ?? "");
      index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === "`" || (char === "$" && next === "(") || char === ">" || char === "<" || char === "(" || char === ")") return null;
    if (char === "&" && next !== "&") return null;
    if (char === "&" || char === "|" || char === ";" || char === "\n") {
      if ((char === "&" || char === "|") && next === char) index += 1;
      segments.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (quote) return null;
  segments.push(current);
  return segments.map((item) => item.trim()).filter(Boolean);
}

/** True when a Bash command is read-only or quick enough for the strict main thread. */
export function strictShellAllowed(command, env = {}) {
  const segments = shellSegments(command);
  if (!segments || segments.length === 0) return false;
  const patterns = strictAllowPatterns(env);
  return segments.every((segment) => patterns.some((pattern) => pattern.test(segment)));
}

function realPathOf(target) {
  let current = path.resolve(target);
  const tail = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...tail.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * True when an edit targets a file outside the governed project and its
 * worktrees (`roots`), for example the agent's own memory files under
 * ~/.claude or the session scratchpad. Without `roots` nothing is outside.
 */
function editOutsideGovernedTree(payload, roots, env) {
  if (!Array.isArray(roots) || roots.length === 0) return false;
  const input = payload?.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};
  const file = input.file_path ?? input.notebook_path;
  if (typeof file !== "string" || file === "") return false;
  const target = realPathOf(path.resolve(String(payload?.cwd || process.cwd()), file));
  const home = String(env?.HOME || os.homedir() || "");
  if (home && isInside(realPathOf(path.join(home, ".claude")), target)) return true;
  return !roots.some((root) => isInside(realPathOf(root), target));
}

/**
 * Strict mode verdict for the main thread (no `agent_id`): a deny for file
 * edits and for foreground shell commands that are not on the allowlist,
 * null otherwise. Subagents and every other tool are never touched.
 */
export function strictMainThreadVerdict(payload, mode, env = {}, { roots = null } = {}) {
  if (mode !== "strict" || payload?.agent_id) return null;
  const toolName = String(payload?.tool_name || "");
  if (ORCHESTRATOR_EDIT_TOOLS.has(toolName)) return editOutsideGovernedTree(payload, roots, env) ? null : deny(STRICT_DENY_REASON);
  if (!SHELL_TOOLS.has(toolName)) return null;
  const input = payload?.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};
  if (input.run_in_background === true) return null;
  return strictShellAllowed(input.command, env) ? null : deny(STRICT_DENY_REASON);
}

/** Session instruction for the orchestrator mode, or "" in any other mode. */
export const STORY_LABEL_INSTRUCTION = "Quando nomini una story o un requisito, aggiungi una breve descrizione (es. ST-X (cosa fa)).";

/** Session instruction, in every main-thread mode, for commands that can outlive the work. */
export const PROCESS_HYGIENE_INSTRUCTION = "Comandi lunghi: usa `agentic-sdlc run --timeout <durata> -- <cmd>` oppure lanciali in background con una scadenza; mai `nohup` o `&` senza scadenza. A fine lavoro esegui `agentic-sdlc processes reap`.";

/** Session instruction, in every main-thread mode: an idle agent keeps a background watch armed. */
export const WATCH_INSTRUCTION = "Quando resti senza lavoro, tieni sempre armato `agentic-sdlc watch --timeout 30m` in background (Claude Code: Bash run_in_background; altri host: un processo in background con scadenza) e riarmalo a ogni uscita: ti risveglia per nuovi messaggi, story libere e release del plugin.";

export function orchestratorSessionContext(mode) {
  if (mode !== "orchestrator" && mode !== "strict") return "";
  const strict = mode === "strict";
  return [
    strict
      ? "Agentic SDLC strict main-thread mode (AGENTIC_SDLC_MAIN_THREAD or host_policy.main_thread), enforced: on the main thread Edit, Write, NotebookEdit and any foreground Bash command outside a read-only allowlist are denied; delegate to a subagent (Agent tool) or run the command with run_in_background."
      : "",
    "Agentic SDLC orchestrator mode (host_policy.main_thread): this main thread only coordinates.",
    STORY_LABEL_INSTRUCTION,
    "It reads messages and notifications, sends short messages, decides, and checks results; a single quick read-only command is fine inline.",
    "The main thread must never block: any command that might take more than about 10 seconds (tests, builds, plugin updates, publish, fetch) is launched in the background (Claude Code: Bash run_in_background, Codex: the equivalent) or delegated to a subagent; only quick read-only commands run in the foreground.",
    "Work that needs reasoning (code, fixes, story delivery, review) goes to background subagents.",
    "Mechanical work (builds, test suites, dev servers, long commands) goes to controlled background processes: an explicit deadline (for example a 10-minute timeout), no orphaned nohup or &, output in a file the main thread reads at the end, and a final check that no process is left running.",
  ].filter(Boolean).join("\n");
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
