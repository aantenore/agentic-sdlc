import { childProcess, crypto, fs, os, process } from "../runtime/host.mjs";
import { UserError } from "../cli/user-error.mjs";
import { localMessagingPath, writeLocalMessaging } from "./config.mjs";

/**
 * Who a computer is in the channel. Every message carries the same author:
 *
 *   name      readable and unique in the channel ("Antonio · pc-b7b5ff"); set with
 *             `message identity --name`, else "<git user.name> · <host>", else the host id
 *   host      stable id of the computer (AGENTIC_SDLC_HOST_LABEL, else a short hash of the host name)
 *   git_user  git user.name of the clone
 *   gh_login  GitHub login the gh CLI is signed in as (looked up once, then kept)
 *
 * Only what is explicit or learned from GitHub is stored, in the clone's local
 * messaging file under `identity`; the default name follows git and the host.
 */
export const HOST_LABEL_ENV = "AGENTIC_SDLC_HOST_LABEL";
export const LABEL_PATTERN = /^[A-Za-z0-9._-]{1,64}$/u;
// Names appear in a bold markdown header: letters, digits, spaces and a few separators only.
export const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._'·-]{0,63}$/u;
// What `--to` accepts: a name, a host id or a GitHub login.
export const TARGET_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._'·@-]{0,63}$/u;
const SEPARATOR = " · ";

/** The stable id of this computer. */
export function hostId(env = process.env) {
  const explicit = String(env[HOST_LABEL_ENV] ?? "").trim();
  if (LABEL_PATTERN.test(explicit)) return explicit;
  return `pc-${crypto.createHash("sha256").update(os.hostname()).digest("hex").slice(0, 6)}`;
}

export function gitUserName(root) {
  try {
    const value = String(childProcess.execFileSync("git", ["config", "user.name"], {
      cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000,
    })).trim();
    return value || null;
  } catch {
    return null;
  }
}

/** "<git user.name> · <host>", or the host alone when git has no (usable) user name. */
export function defaultName(gitUser, host) {
  const clean = String(gitUser ?? "").replace(/[^\p{L}\p{N} ._'-]/gu, "").replace(/\s+/gu, " ").trim().slice(0, 40);
  return clean ? `${clean}${SEPARATOR}${host}` : host;
}

export function validateName(value) {
  const name = String(value ?? "").replace(/\s+/gu, " ").trim();
  if (!NAME_PATTERN.test(name)) {
    throw new UserError("The name must be 1-64 characters: letters, digits, spaces and . _ ' · - (for example \"Antonio · PC3\").");
  }
  return name;
}

function readStored(root) {
  const file = localMessagingPath(root);
  if (!file) return {};
  try {
    const identity = JSON.parse(fs.readFileSync(file, "utf8"))?.identity;
    return identity && typeof identity === "object" && !Array.isArray(identity) ? identity : {};
  } catch {
    return {};
  }
}

/** Saves identity fields in the clone's local messaging file (merged with what is there). */
export function storeIdentity(root, patch) {
  const file = localMessagingPath(root);
  if (!file) return null;
  return writeLocalMessaging(file, { identity: { ...readStored(root), ...patch } });
}

export function resolveIdentity(root, env = process.env) {
  const stored = readStored(root);
  const host = hostId(env);
  const gitUser = gitUserName(root);
  const explicit = typeof stored.name === "string" && NAME_PATTERN.test(stored.name) ? stored.name : null;
  return {
    name: explicit ?? defaultName(gitUser, host),
    named: explicit !== null,
    host,
    git_user: gitUser,
    gh_login: typeof stored.gh_login === "string" && stored.gh_login ? stored.gh_login : null,
    joined: stored.joined && typeof stored.joined === "object" ? stored.joined : null,
  };
}

/** Every way the others may address this computer: name, host id and GitHub login. */
export function selfNamesOf(identity) {
  return new Set([identity.name, identity.host, identity.gh_login].filter(Boolean));
}

/** The author fields every message carries. */
export function authorOf(identity) {
  return { from: identity.name, host: identity.host, ghLogin: identity.gh_login };
}

/**
 * `--sender` is deprecated: a message is always signed with this computer's name. The old flag is
 * accepted only when it repeats the name (or the host id); anything else is refused.
 */
export function checkSender(sender, identity) {
  if (sender === undefined || sender === true) return;
  const given = String(sender).trim();
  if (given === identity.name || given === identity.host) return;
  throw new UserError(
    `--sender '${given}' is not accepted: every message is signed with this computer's name '${identity.name}'. `
    + "Change it with 'agentic-sdlc message identity --name \"<name>\"'.",
    null,
    "MESSAGING_SENDER_REFUSED",
  );
}

/** Learns the GitHub login once through the provider (null when unknown or unavailable). */
export async function learnGhLogin(root, identity, provider, signal) {
  if (identity.gh_login || typeof provider?.whoami !== "function") return identity;
  try {
    const login = await provider.whoami({ signal });
    if (login) {
      storeIdentity(root, { gh_login: login });
      return { ...identity, gh_login: login };
    }
  } catch {
    // Unknown for now; asked again next time.
  }
  return identity;
}
