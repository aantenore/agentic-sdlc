/**
 * Decisions of the plugin's host hooks. The same hooks/hooks.json runs in
 * both supported agent hosts; this module only interprets the hook payload,
 * so it holds no I/O. A hook is a second line of defence: the CLI enforces
 * every rule itself, and a hook that fails lets the tool call through.
 */

const STANDING_RECORDS = /(?:^|[\s"'=:\\/])\.sdlc[\\/]+autonomy[\\/]+standing(?:[\\/\s"']|$)/u;
const SHARED_REFS = /\brefs\/agentic-sdlc(?:-shared)?\//u;
const CLI_INVOCATION = /(?:^|[\s"'/\\])(?:agentic-sdlc(?:\.mjs)?)(?=["'\s]|$)/u;
const STANDING_APPROVE = /\bautonomy\s+standing\s+approve\b/u;
const REF_REWRITE = /\bgit\b[^\n;&|]*\b(?:push|update-ref|replace|branch|tag|reflog|gc|prune|filter-branch|filter-repo)\b/u;
const MIRROR_PUSH = /\bgit\b[^\n;&|]*\bpush\b[^\n;&|]*\s--(?:mirror|prune)\b/u;
// Shell operations that change files; reading, staging, and committing records stay allowed.
const SHELL_WRITE = /(?:^|[\s;&|(`])(?:rm|rmdir|mv|cp|ln|tee|truncate|unlink|touch|chmod|chown|dd|install|rsync|Remove-Item|Set-Content|Add-Content|Out-File|Move-Item|Copy-Item|New-Item|sed\s+-\S*i|perl\s+-\S*i|git\s+(?:rm|mv|checkout|restore|reset|clean|stash|apply|am|cherry-pick|revert))(?=[\s;&|)]|$)|>|\b(?:node|python3?|ruby|perl|deno|bun|pwsh|powershell)\s+-(?:e|c|Command)\b/u;
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const PATCH_PATH = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gmu;

function deny(reason) {
  return { decision: "deny", reason };
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

function standingApproveReason(command) {
  return "Only the user can approve a standing approval, because it lets later deliveries proceed without asking them. "
    + "Show the user its plain-language limits (autonomy standing explain) and ask them to run this exact command themselves, "
    + "in their own terminal: "
    + command.trim();
}

/**
 * PreToolUse decision for one tool call, or null to let the host's normal
 * permission flow decide.
 */
export function evaluatePreToolUse(payload) {
  const toolName = String(payload?.tool_name || "");
  const toolInput = payload?.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};
  if (SHELL_TOOLS.has(toolName)) {
    const command = String(toolInput.command || "");
    if (!command.trim()) return null;
    if (STANDING_APPROVE.test(command) && CLI_INVOCATION.test(command)) {
      return deny(standingApproveReason(command));
    }
    if (STANDING_RECORDS.test(command) && SHELL_WRITE.test(command) && !CLI_INVOCATION.test(command)) {
      return deny(
        "Standing approval records under .sdlc/autonomy/standing are immutable and written only by the agentic-sdlc CLI "
        + "(autonomy standing propose, revoke, sync). Use those commands instead of changing the files.",
      );
    }
    if ((SHARED_REFS.test(command) && REF_REWRITE.test(command)) || MIRROR_PUSH.test(command)) {
      return deny(
        "The refs under refs/agentic-sdlc/ hold the shared state of standing approvals (used deliveries and revocations). "
        + "They are created only by the agentic-sdlc CLI and are never pushed, deleted, or rewritten by hand; "
        + "mirror or prune pushes would delete them on the remote.",
      );
    }
    return null;
  }
  const protectedPaths = editedPaths(toolName, toolInput).filter((filePath) => STANDING_RECORDS.test(filePath));
  if (protectedPaths.length > 0) {
    return deny(
      `Standing approval records are immutable and written only by the agentic-sdlc CLI; this edit would change ${protectedPaths.join(", ")}. `
      + "Propose a new standing approval or revoke the existing one through the CLI instead.",
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
    return `- ${item.id}: ${item.status}, ${item.used} of ${item.max_deliveries} deliveries used, expires ${item.expires_at}; ${shared}.`;
  });
  if (approvals.length > lines.length) lines.push(`- and ${approvals.length - lines.length} more (autonomy standing status).`);
  return [
    "Agentic SDLC standing approvals in this project:",
    ...lines,
    "Rely on one only through `--standing-approval` on the CLI. When a step is not covered, show the reason and ask the user for the normal confirmation. Only the user approves a standing approval.",
  ].join("\n");
}
