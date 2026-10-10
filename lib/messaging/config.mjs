import path from "node:path";
import { childProcess, fs, process } from "../runtime/host.mjs";
import { UserError } from "../cli/user-error.mjs";

/**
 * Cross-machine messaging settings.
 *
 * The channel is one GitHub issue in the project's repository. Nothing secret
 * is stored: the repository and the issue number are kept per clone in the git
 * folder (<git-common-dir>/agentic-sdlc/messaging.json, never committed, shared
 * by the clone's worktrees); a committed .sdlc/messaging.json may set the same
 * keys for everyone. Access is the `gh` CLI the person is already signed in
 * with. None of this is in .sdlc/config.json: plugins that predate messaging
 * validate config.json strictly and would reject a new section.
 *
 * Precedence for each setting: environment, local file, committed file.
 *   AGENTIC_SDLC_MESSAGING=off              turns messaging off on this computer
 *   AGENTIC_SDLC_MESSAGING_REPO=owner/name  replaces the repository (default: the origin remote)
 *   AGENTIC_SDLC_MESSAGING_ISSUE=<number>   replaces the channel issue (default: found or created on first use)
 *
 * A clone still configured with the removed ntfy provider (a topic or server in
 * its files) is converted to GitHub here, on first use, keeping its outbox and
 * the state that still means something.
 */
export const MESSAGING_CONFIG_PATH = ".sdlc/messaging.json";
export const LOCAL_MESSAGING_DIR = "agentic-sdlc";
export const LOCAL_MESSAGING_FILE = "messaging.json";
export const AUTO_STATE_FILE_NAME = "messaging-auto.json";
export const MESSAGING_ENV = Object.freeze({
  switch: "AGENTIC_SDLC_MESSAGING",
  repo: "AGENTIC_SDLC_MESSAGING_REPO",
  issue: "AGENTIC_SDLC_MESSAGING_ISSUE",
  poll: "AGENTIC_SDLC_MESSAGING_POLL_SECONDS",
});
export const DEFAULT_MESSAGING = Object.freeze({
  provider: "github",
  label: "agentic-sdlc-channel",
  title: "Agentic SDLC · canale tra computer",
});
const MAX_CONFIG_BYTES = 16 * 1024;
const REPO_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u;
const OFF_VALUES = new Set(["0", "false", "no", "off", "disabled"]);
// State that only made sense with the removed server: its read positions and message ids.
const LEGACY_ATTENTION_KEYS = ["cursor", "window", "digested", "escalated"];

export function normalizeRepo(value, source) {
  const text = String(value ?? "").trim();
  const match = /^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)?([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/u.exec(text);
  const repo = match?.[1] ?? "";
  if (!REPO_PATTERN.test(repo)) {
    throw new UserError(`Messaging repository '${text}' from ${source} must look like owner/name.`);
  }
  return repo;
}

export function normalizeIssue(value, source) {
  const text = String(value ?? "").trim();
  if (!/^[1-9][0-9]{0,8}$/u.test(text)) throw new UserError(`Messaging issue '${text}' from ${source} must be an issue number.`);
  return Number(text);
}

/** owner/name of the project's origin remote, or null when it is missing or not on GitHub. */
export function originRepo(root) {
  try {
    const url = String(childProcess.execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })).trim();
    if (!/github\.com[:/]/u.test(url)) return null;
    return normalizeRepo(url, "the origin remote");
  } catch {
    return null;
  }
}

/** The clone's local messaging file, or null outside a git clone. */
export function localMessagingPath(root) {
  let commonDir;
  try {
    commonDir = String(childProcess.execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })).trim();
  } catch {
    return null;
  }
  if (!commonDir) return null;
  return path.join(path.resolve(root, commonDir), LOCAL_MESSAGING_DIR, LOCAL_MESSAGING_FILE);
}

function readConfigFile(filePath, label) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
  if (!stat.isFile()) throw new UserError(`${label} must be a regular file.`);
  if (stat.size > MAX_CONFIG_BYTES) throw new UserError(`${label} is larger than ${MAX_CONFIG_BYTES} bytes.`);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    throw new UserError(`${label} is not valid JSON. Fix or remove it, then run the command again.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UserError(`${label} must contain a JSON object.`);
  }
  return parsed;
}

/** Merge `patch` into the clone's local messaging file (mode 0600, atomic). Returns the stored object. */
export function writeLocalMessaging(filePath, patch) {
  if (!filePath) return null;
  let current = {};
  try {
    current = readConfigFile(filePath, "the local messaging settings") ?? {};
  } catch {
    current = {};
  }
  const next = { ...current, ...patch };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, filePath);
  return next;
}

function hasLegacyKeys(file) {
  return Boolean(file) && (file.provider === "ntfy" || file.topic !== undefined || file.server !== undefined);
}

/** Drops from the automatic-message state what belonged to the removed server; the rest is kept. */
function cleanLegacyState(localPath) {
  const statePath = path.join(path.dirname(localPath), AUTO_STATE_FILE_NAME);
  try {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (!state || typeof state !== "object" || Array.isArray(state)) return;
    delete state.cursor;
    delete state.own;
    if (state.attention && typeof state.attention === "object") {
      for (const key of LEGACY_ATTENTION_KEYS) delete state.attention[key];
    }
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // No state yet, or unreadable: nothing to carry over.
  }
}

/**
 * Resolve the effective messaging settings for a project root. Unknown keys in
 * the files are ignored so newer files stay readable by this version.
 */
export function resolveMessagingConfig(root, env = process.env) {
  const shared = readConfigFile(path.join(root, MESSAGING_CONFIG_PATH), MESSAGING_CONFIG_PATH);
  const localPath = localMessagingPath(root);
  const local = localPath ? readConfigFile(localPath, "the local messaging settings") : null;
  const envSwitch = String(env[MESSAGING_ENV.switch] ?? "").trim().toLowerCase();
  const envRepo = String(env[MESSAGING_ENV.repo] ?? "").trim();
  const envIssue = String(env[MESSAGING_ENV.issue] ?? "").trim();
  const base = {
    config_path: MESSAGING_CONFIG_PATH,
    local_path: localPath,
    file_present: shared !== null,
    local_present: local !== null,
  };
  if (OFF_VALUES.has(envSwitch)) {
    return { ...base, enabled: false, reason: `${MESSAGING_ENV.switch}=${envSwitch}` };
  }
  if (!envRepo && (local?.enabled === false || (local === null && shared?.enabled === false))) {
    return { ...base, enabled: false, reason: "messaging is turned off in its settings" };
  }
  const localIsGithub = local?.provider === DEFAULT_MESSAGING.provider;
  const legacy = !localIsGithub && (hasLegacyKeys(local) || hasLegacyKeys(shared));
  const provider = legacy ? DEFAULT_MESSAGING.provider : String(local?.provider ?? shared?.provider ?? DEFAULT_MESSAGING.provider);
  const sources = [
    [envRepo, `environment ${MESSAGING_ENV.repo}`],
    [localIsGithub || !legacy ? local?.repo : null, "local settings"],
    [shared?.repo, MESSAGING_CONFIG_PATH],
  ];
  let [repo, repoSource] = sources.find(([value]) => value) ?? [];
  if (!repo && legacy) {
    repo = originRepo(root);
    repoSource = "the origin remote (converted from the removed ntfy settings)";
  }
  if (!repo) {
    return {
      ...base,
      enabled: false,
      reason: legacy
        ? "ntfy is no longer supported and the origin remote is not a GitHub repository"
        : "no repository configured on this computer",
    };
  }
  repo = normalizeRepo(repo, repoSource);
  const [issueValue, issueSource] = [
    [envIssue, `environment ${MESSAGING_ENV.issue}`],
    [localIsGithub || !legacy ? local?.issue : null, "local settings"],
    [shared?.issue, MESSAGING_CONFIG_PATH],
  ].find(([value]) => value) ?? [];
  const issue = issueValue ? normalizeIssue(issueValue, issueSource) : null;
  let migrated = false;
  if (legacy && localPath && !envRepo) {
    // The channel issue is found or created at the first send or read; only the repository is fixed here.
    writeLocalMessaging(localPath, { provider: DEFAULT_MESSAGING.provider, repo, migrated_from: "ntfy", topic: undefined, server: undefined });
    cleanLegacyState(localPath);
    migrated = true;
  }
  return {
    ...base,
    enabled: true,
    provider,
    repo,
    repo_source: repoSource,
    issue,
    issue_source: issueSource ?? null,
    migrated,
  };
}
