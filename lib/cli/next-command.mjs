import { storyLabel } from "../engine/story-label.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { childProcess, console, process } from "../runtime/host.mjs";
import { storyScopeWarningLines } from "../engine/story-scope.mjs";
import { decideKeepGoing, keepGoingWork } from "../host-hooks/keep-going.mjs";

const SCOPE_CHECK_TIMEOUT_MS = 20000;
const CLI_ENTRY = fileURLToPath(new URL("../../bin/agentic-sdlc.mjs", import.meta.url));

/**
 * Warnings for the claims in implementation: the same read-only check as
 * `story scope check`, so a file outside the approved write paths, or a
 * delivery action the profile does not allow, shows up now and not at the
 * governed git.commit or at the merge.
 */
export function implementationScopeWarnings(root, claims = []) {
  const active = claims.filter((claim) => claim.next?.phase === "implementation" && !claim.waiting && !claim.delegated);
  if (active.length === 0) return [];
  const warnings = [];
  for (const claim of active) {
    try {
      const stdout = childProcess.execFileSync(process.execPath, [CLI_ENTRY, "story", "scope", "check", "--id", claim.storyId, "--root", root, "--json"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: SCOPE_CHECK_TIMEOUT_MS,
      });
      const result = JSON.parse(stdout);
      if (result.status === "out_of_scope" || result.status === "action_not_allowed") warnings.push(result);
    } catch {
      // The advisory check never blocks `next`.
    }
  }
  return warnings;
}

/** Read-only: the next step while this computer has work, with the same decision as the end-of-turn hook. */
export async function nextCommand(options) {
  const root = path.resolve(String(options.root || process.cwd()));
  const work = await keepGoingWork(root);
  const decision = decideKeepGoing({ ...work, label: (id) => storyLabel(root, id) });
  const scopeWarnings = implementationScopeWarnings(root, work.claims);
  const result = { work_pending: decision.block, next: decision.reason, human_decision: decision.note, ...work, ...(scopeWarnings.length > 0 ? { scope_warnings: scopeWarnings } : {}) };
  if (options.json === true) console.log(JSON.stringify(result, null, 2));
  else if (decision.block) {
    console.log(decision.reason);
    for (const warning of scopeWarnings) console.log(`\n${storyScopeWarningLines(warning).join("\n")}`);
  }
  else console.log(decision.note ? `Nessun lavoro per l'agente. ${decision.note}` : "Nessun lavoro in sospeso: il turno puo' chiudersi.");
  return result;
}
