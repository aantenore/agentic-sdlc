import path from "node:path";
import { fs } from "./runtime/host.mjs";
import { PLUGIN_ROOT } from "./runtime/paths.mjs";

/**
 * Which plugin version a project's records need. Several computers can share
 * one project while running different plugin versions; a record written by a
 * newer version must never be misread by an older one. Every feature whose
 * records an older plugin would misread is listed in
 * config/plugin-compatibility.json with the version that introduced it.
 * A project that uses such a feature keeps a requirement file under
 * .sdlc/compatibility/, and a shared record carries `minimum_plugin_version`.
 * An older plugin then asks for an update instead of guessing.
 *
 * This module holds the pure rules; reading and writing project files lives in
 * lib/engine/plugin-compatibility.mjs.
 */

export const COMPATIBILITY_DIRECTORY = "compatibility";
export const REQUIREMENT_KIND = "plugin-compatibility-requirement:v1";
const SETTINGS_KIND = "plugin-compatibility:v1";
const FEATURE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u;

function readPluginJson(relativePath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8"));
  } catch {
    return null;
  }
}

/** The running plugin's version. */
export const PLUGIN_VERSION = String(readPluginJson("package.json")?.version || "0.0.0");
const PLUGIN_NAME = String(readPluginJson("package.json")?.name || "agentic-sdlc");

function loadSettings() {
  const raw = readPluginJson(path.join("config", "plugin-compatibility.json"));
  if (!raw || raw.schema_version !== SETTINGS_KIND) {
    throw new Error("config/plugin-compatibility.json is missing or has an unsupported format");
  }
  const features = {};
  for (const [id, feature] of Object.entries(raw.features || {})) {
    if (!FEATURE_ID_PATTERN.test(id) || !VERSION_PATTERN.test(String(feature?.since || ""))) {
      throw new Error(`config/plugin-compatibility.json lists an invalid feature '${id}'`);
    }
    features[id] = Object.freeze({ id, since: feature.since, summary: String(feature.summary || id) });
  }
  // The marketplace the plugin was installed from names itself; the setting is the fallback.
  const marketplace = String(readPluginJson(path.join(".claude-plugin", "marketplace.json"))?.name || raw.marketplace || "");
  return Object.freeze({
    update_command: String(raw.update_command || "")
      .replaceAll("{marketplace}", marketplace)
      .replaceAll("{plugin}", PLUGIN_NAME),
    features: Object.freeze(features),
  });
}

export const PLUGIN_COMPATIBILITY = loadSettings();

/** The command that updates the plugin on this computer. */
export function pluginUpdateCommand() {
  return PLUGIN_COMPATIBILITY.update_command;
}

/** A registered feature, or throws: a requirement always names a known feature. */
export function compatibilityFeature(featureId) {
  const feature = PLUGIN_COMPATIBILITY.features[featureId];
  if (!feature) throw new Error(`Unknown plugin compatibility feature '${featureId}'`);
  return feature;
}

/** -1, 0 or 1 like a comparator; null when either side is not a version. */
export function comparePluginVersions(left, right) {
  const a = VERSION_PATTERN.exec(String(left ?? ""));
  const b = VERSION_PATTERN.exec(String(right ?? ""));
  if (!a || !b) return null;
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  if (a[4] === b[4]) return 0;
  if (!a[4]) return 1;
  if (!b[4]) return -1;
  return a[4] < b[4] ? -1 : 1;
}

/**
 * True when a record that declares `minimumVersion` needs a newer plugin than
 * `running`. A declared value that is not a version also needs one: only a
 * newer plugin could have written it.
 */
export function requiresNewerPlugin(minimumVersion, running = PLUGIN_VERSION) {
  if (minimumVersion === undefined || minimumVersion === null) return false;
  const comparison = comparePluginVersions(minimumVersion, running);
  return comparison === null || comparison > 0;
}

/** The requirement file content for one feature: the same bytes on every computer, so merges never conflict. */
export function buildRequirementRecord(featureId) {
  const feature = compatibilityFeature(featureId);
  return {
    schema_version: REQUIREMENT_KIND,
    feature: feature.id,
    minimum_plugin_version: feature.since,
    summary: feature.summary,
  };
}

/** File name of a feature's requirement under .sdlc/compatibility/. */
export function requirementFileName(featureId) {
  return `${compatibilityFeature(featureId).id}.json`;
}

/**
 * Verdict over the requirement files of a project. `entries` holds
 * `{ path, record }` (record null when unreadable). Returns the highest
 * version required, the features this plugin is too old for, and the files
 * it cannot read; `satisfied` is false when either list is not empty.
 */
export function evaluateRequirements(entries, running = PLUGIN_VERSION) {
  let required = null;
  const newer = [];
  const unreadable = [];
  for (const { path: filePath, record } of entries) {
    const readable = record
      && record.schema_version === REQUIREMENT_KIND
      && typeof record.feature === "string"
      && comparePluginVersions(record.minimum_plugin_version, record.minimum_plugin_version) === 0;
    if (!readable) {
      unreadable.push(filePath);
      continue;
    }
    if (required === null || comparePluginVersions(record.minimum_plugin_version, required) > 0) {
      required = record.minimum_plugin_version;
    }
    if (requiresNewerPlugin(record.minimum_plugin_version, running)) {
      newer.push({ feature: record.feature, minimum_plugin_version: record.minimum_plugin_version, path: filePath });
    }
  }
  return {
    running_plugin_version: running,
    required_plugin_version: required,
    satisfied: newer.length === 0 && unreadable.length === 0,
    newer_features: newer,
    unreadable,
    update_command: pluginUpdateCommand(),
  };
}

/** One plain line asking for the update, in English or Italian. */
export function pluginUpdateLine(requiredVersion, { italian = false, running = PLUGIN_VERSION } = {}) {
  const needed = requiredVersion ? ` ${requiredVersion}` : "";
  return italian
    ? `Questo progetto contiene dati scritti da una versione più recente del plugin (serve${needed || " una versione più recente"}, qui c'è ${running}). Aggiorna il plugin: ${pluginUpdateCommand()}`
    : `This project holds records written by a newer plugin version (needs${needed || " a newer version"}, this computer runs ${running}). Update the plugin: ${pluginUpdateCommand()}`;
}
