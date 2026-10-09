import path from "node:path";
import { fs, process } from "../runtime/host.mjs";
import { UserError } from "../cli/user-error.mjs";

/**
 * Cross-machine messaging settings.
 *
 * Messaging is on when the project carries .sdlc/messaging.json or when the
 * topic comes from the environment. The file lives outside .sdlc/config.json
 * on purpose: plugins that predate messaging validate config.json strictly
 * and would reject a new section, while they never read this file.
 *
 * Environment variables override the file, so the topic can leave git later
 * without code changes:
 *   AGENTIC_SDLC_MESSAGING=off             turns messaging off on this computer
 *   AGENTIC_SDLC_MESSAGING_TOPIC=<topic>   replaces the topic
 *   AGENTIC_SDLC_MESSAGING_SERVER=<url>    replaces the server
 */
export const MESSAGING_CONFIG_PATH = ".sdlc/messaging.json";
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

function readConfigFile(root) {
  const filePath = path.join(root, MESSAGING_CONFIG_PATH);
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
  if (!stat.isFile()) throw new UserError(`${MESSAGING_CONFIG_PATH} must be a regular file.`);
  if (stat.size > MAX_CONFIG_BYTES) throw new UserError(`${MESSAGING_CONFIG_PATH} is larger than ${MAX_CONFIG_BYTES} bytes.`);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    throw new UserError(`${MESSAGING_CONFIG_PATH} is not valid JSON. Fix or remove it, then run the command again.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UserError(`${MESSAGING_CONFIG_PATH} must contain a JSON object.`);
  }
  return parsed;
}

/**
 * Resolve the effective messaging settings for a project root. Unknown keys in
 * the file are ignored so newer files stay readable by this version.
 */
export function resolveMessagingConfig(root, env = process.env) {
  const file = readConfigFile(root);
  const envSwitch = String(env[MESSAGING_ENV.switch] ?? "").trim().toLowerCase();
  const envTopic = String(env[MESSAGING_ENV.topic] ?? "").trim();
  const envServer = String(env[MESSAGING_ENV.server] ?? "").trim();
  const base = {
    config_path: MESSAGING_CONFIG_PATH,
    file_present: file !== null,
  };
  if (OFF_VALUES.has(envSwitch)) {
    return { ...base, enabled: false, reason: `${MESSAGING_ENV.switch}=${envSwitch}` };
  }
  if (file === null && !envTopic) {
    return { ...base, enabled: false, reason: `no ${MESSAGING_CONFIG_PATH} and no ${MESSAGING_ENV.topic}` };
  }
  if (file?.enabled === false && !envTopic) {
    return { ...base, enabled: false, reason: `${MESSAGING_CONFIG_PATH} sets enabled to false` };
  }
  const provider = String(file?.provider ?? DEFAULT_MESSAGING.provider);
  const topic = envTopic || file?.topic;
  const topicSource = envTopic ? `environment ${MESSAGING_ENV.topic}` : MESSAGING_CONFIG_PATH;
  if (!isValidTopic(topic)) {
    throw new UserError(
      `The messaging topic from ${topicSource} must be 1-64 letters, digits, '-' or '_'.`,
    );
  }
  const serverSource = envServer ? `environment ${MESSAGING_ENV.server}` : (file?.server ? MESSAGING_CONFIG_PATH : "default");
  const server = normalizeServer(envServer || file?.server || DEFAULT_MESSAGING.server, serverSource);
  return {
    ...base,
    enabled: true,
    provider,
    server,
    topic,
    topic_source: topicSource,
    server_source: serverSource,
  };
}
