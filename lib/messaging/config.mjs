import path from "node:path";
import { childProcess, fs, process } from "../runtime/host.mjs";
import { UserError } from "../cli/user-error.mjs";

/**
 * Cross-machine messaging settings.
 *
 * The topic is a secret shared through other channels, so it is kept per
 * clone in the git folder (<git-common-dir>/agentic-sdlc/messaging.json),
 * which is never committed and is shared by the clone's worktrees. A
 * committed .sdlc/messaging.json may set provider and server for everyone;
 * a topic in it is still read (0.52.0 wrote it there) but reported as public.
 * None of this is in .sdlc/config.json: plugins that predate messaging
 * validate config.json strictly and would reject a new section.
 *
 * Precedence for each setting: environment, local file, committed file.
 *   AGENTIC_SDLC_MESSAGING=off             turns messaging off on this computer
 *   AGENTIC_SDLC_MESSAGING_TOPIC=<topic>   replaces the topic
 *   AGENTIC_SDLC_MESSAGING_SERVER=<url>    replaces the server
 */
export const MESSAGING_CONFIG_PATH = ".sdlc/messaging.json";
export const LOCAL_MESSAGING_DIR = "agentic-sdlc";
export const LOCAL_MESSAGING_FILE = "messaging.json";
export const MESSAGING_ENV = Object.freeze({
  switch: "AGENTIC_SDLC_MESSAGING",
  topic: "AGENTIC_SDLC_MESSAGING_TOPIC",
  server: "AGENTIC_SDLC_MESSAGING_SERVER",
});
export const DEFAULT_MESSAGING = Object.freeze({
  provider: "ntfy",
  server: "https://ntfy.sh",
});
const MAX_CONFIG_BYTES = 16 * 1024;
const TOPIC_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const OFF_VALUES = new Set(["0", "false", "no", "off", "disabled"]);

export function isValidTopic(value) {
  return typeof value === "string" && TOPIC_PATTERN.test(value);
}

export function normalizeServer(value, source) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new UserError(`Messaging server '${value}' from ${source} is not a valid URL.`);
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new UserError(`Messaging server '${value}' from ${source} must use https.`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new UserError(`Messaging server '${value}' from ${source} must be a plain address without credentials, query or fragment.`);
  }
  return url.toString().replace(/\/+$/u, "");
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

/**
 * Resolve the effective messaging settings for a project root. Unknown keys in
 * the files are ignored so newer files stay readable by this version.
 */
export function resolveMessagingConfig(root, env = process.env) {
  const shared = readConfigFile(path.join(root, MESSAGING_CONFIG_PATH), MESSAGING_CONFIG_PATH);
  const localPath = localMessagingPath(root);
  const local = localPath ? readConfigFile(localPath, "the local messaging settings") : null;
  const envSwitch = String(env[MESSAGING_ENV.switch] ?? "").trim().toLowerCase();
  const envTopic = String(env[MESSAGING_ENV.topic] ?? "").trim();
  const envServer = String(env[MESSAGING_ENV.server] ?? "").trim();
  const base = {
    config_path: MESSAGING_CONFIG_PATH,
    local_path: localPath,
    file_present: shared !== null,
    local_present: local !== null,
  };
  if (OFF_VALUES.has(envSwitch)) {
    return { ...base, enabled: false, reason: `${MESSAGING_ENV.switch}=${envSwitch}` };
  }
  if (!envTopic && (local?.enabled === false || (local === null && shared?.enabled === false))) {
    return { ...base, enabled: false, reason: "messaging is turned off in its settings" };
  }
  const sources = [
    [envTopic, `environment ${MESSAGING_ENV.topic}`],
    [local?.topic, "local settings"],
    [shared?.topic, MESSAGING_CONFIG_PATH],
  ];
  const [topic, topicSource] = sources.find(([value]) => value) ?? [];
  if (!topic) {
    return {
      ...base,
      enabled: false,
      reason: "no topic configured on this computer",
    };
  }
  if (!isValidTopic(topic)) {
    throw new UserError(
      `The messaging topic from ${topicSource} must be 1-64 letters, digits, '-' or '_'.`,
    );
  }
  const provider = String(local?.provider ?? shared?.provider ?? DEFAULT_MESSAGING.provider);
  const [serverValue, serverSource] = [
    [envServer, `environment ${MESSAGING_ENV.server}`],
    [local?.server, "local settings"],
    [shared?.server, MESSAGING_CONFIG_PATH],
  ].find(([value]) => value) ?? [DEFAULT_MESSAGING.server, "default"];
  return {
    ...base,
    enabled: true,
    provider,
    server: normalizeServer(serverValue, serverSource),
    topic,
    topic_source: topicSource,
    server_source: serverSource,
    topic_in_git: topicSource === MESSAGING_CONFIG_PATH,
  };
}
