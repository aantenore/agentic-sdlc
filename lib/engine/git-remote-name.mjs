import { childProcess, process } from "../runtime/host.mjs";

/** A remote name git cannot read as an option: starts alphanumeric, no spaces or control characters. */
export const SAFE_REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
export const DEFAULT_REMOTE_NAME = "origin";

function configuredRemotes(root) {
  const listed = childProcess.spawnSync("git", ["-C", root, "remote"], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (listed.status !== 0 || typeof listed.stdout !== "string") return [];
  return listed.stdout.split(/\r?\n/u).map((name) => name.trim()).filter(Boolean);
}

/**
 * The remote name a project's config asks for, only if it is safe to pass to git:
 * well-formed and actually configured in this clone. Otherwise "origin" when that
 * exists. Returns { remote, fallback, warning }; `remote` is null when nothing
 * usable exists (callers then skip the git call).
 */
export function safeGitRemoteName(name, root) {
  const requested = name === undefined || name === null || name === "" ? DEFAULT_REMOTE_NAME : name;
  const remotes = configuredRemotes(root);
  if (typeof requested === "string" && SAFE_REMOTE_NAME.test(requested) && !requested.includes("..") && remotes.includes(requested)) {
    return { remote: requested, fallback: false, warning: null };
  }
  const shown = JSON.stringify(String(requested)).slice(0, 80);
  if (remotes.includes(DEFAULT_REMOTE_NAME)) {
    return { remote: DEFAULT_REMOTE_NAME, fallback: true, warning: `git remote ${shown} from the config is not safe or not configured; using ${DEFAULT_REMOTE_NAME}.` };
  }
  return { remote: null, fallback: true, warning: `git remote ${shown} from the config is not safe or not configured and ${DEFAULT_REMOTE_NAME} does not exist; skipping.` };
}
