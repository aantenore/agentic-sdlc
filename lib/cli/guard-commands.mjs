import { spawnSync } from "node:child_process";
import path from "node:path";

import { runsInsideAgentHost } from "../agent-host.mjs";
import { recordTrustedRemote, validRemoteUrl } from "../host-hooks/trusted-remotes.mjs";
import { console, process } from "../runtime/host.mjs";
import { fail, failUsage } from "./user-error.mjs";

/**
 * `guard trust-remote --root <repo> --url <url> --actor-type human --approval-source explicit-user`:
 * the person records the remote URL the merge and push guard reads the base branch from.
 * Refused inside an agent session; the guard also refuses it to agents.
 */
export function guardTrustRemote(options) {
  if (runsInsideAgentHost()) {
    fail("guard trust-remote is the person's own decision and cannot run inside an agent session. The user runs the command in their own terminal.");
  }
  if (String(options["actor-type"] ?? "").toLowerCase() !== "human" || options["approval-source"] !== "explicit-user") {
    failUsage("guard trust-remote needs --actor-type human and --approval-source explicit-user.");
  }
  const url = String(options.url ?? "");
  if (!validRemoteUrl(url)) failUsage("guard trust-remote needs --url <remote URL>: one word, not starting with '-'.");
  const start = path.resolve(String(options.root || process.cwd()));
  const listed = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: start, encoding: "utf8", timeout: 5000, windowsHide: true });
  const top = listed.status === 0 ? listed.stdout.trim() : "";
  if (!top) fail(`${start} is not inside a git repository.`);
  const actor = { type: "human", name: String(options["actor-name"] || process.env.USER || process.env.USERNAME || "") || null };
  const { file, key, entry } = recordTrustedRemote(top, url, actor);
  if (options.json) {
    console.log(JSON.stringify({ repository: key, url: entry.url, trusted_at: entry.trusted_at, file }, null, 2));
    return;
  }
  console.log(`Trusted remote for ${key}: ${entry.url}`);
  console.log(`Recorded in ${file}. The merge and push guard reads the base branch only from this URL; 'origin' must point exactly at it.`);
}
