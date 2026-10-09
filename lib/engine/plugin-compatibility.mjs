import path from "node:path";
import { failWithCode } from "../cli/user-error.mjs";
import { commandMutationIntent } from "../cli/dispatch.mjs";
import {
  COMPATIBILITY_DIRECTORY,
  buildRequirementRecord,
  evaluateRequirements,
  pluginUpdateCommand,
  pluginUpdateLine,
  requirementFileName,
} from "../plugin-compatibility.mjs";
import { fs, process } from "../runtime/host.mjs";
import {
  ensureDir,
  writeJsonFile,
} from "./storage.mjs";

/**
 * Project side of the plugin version check: the requirement files under
 * .sdlc/compatibility/, the start-of-command check, and the doctor check.
 * Requirement files are only ever added, with the same content on every
 * computer; records stay immutable and nothing is migrated.
 */

function compatibilityRoot(context) {
  return path.join(context.sdlcRoot, COMPATIBILITY_DIRECTORY);
}

/** Requirement files of the project as `{ path, record }`; a file that cannot be parsed has record null. */
function readRequirementEntries(context) {
  const root = compatibilityRoot(context);
  let names;
  try {
    if (!fs.lstatSync(root).isDirectory()) return [{ path: `${COMPATIBILITY_DIRECTORY}`, record: null }];
    names = fs.readdirSync(root).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return [];
  }
  return names.map((name) => {
    const filePath = path.join(root, name);
    const projectPath = path.relative(context.root, filePath).split(path.sep).join("/");
    try {
      if (!fs.lstatSync(filePath).isFile()) return { path: projectPath, record: null };
      return { path: projectPath, record: JSON.parse(fs.readFileSync(filePath, "utf8")) };
    } catch {
      return { path: projectPath, record: null };
    }
  });
}

/** What the project's records need from the plugin (see evaluateRequirements). */
export function projectPluginCompatibility(context) {
  return evaluateRequirements(readRequirementEntries(context));
}

/**
 * Records that the project now uses `featureId`, so plugins older than the
 * feature ask for an update instead of misreading its records. Call it from
 * the command that writes the feature's first record, before that write.
 * Idempotent: the file is written once and never changed.
 */
export function recordProjectPluginRequirement(context, featureId) {
  const filePath = path.join(compatibilityRoot(context), requirementFileName(featureId));
  if (fs.existsSync(filePath)) return false;
  ensureDir(compatibilityRoot(context));
  writeJsonFile(filePath, buildRequirementRecord(featureId));
  return true;
}

function blockedMessage(verdict, italian) {
  return [
    pluginUpdateLine(verdict.required_plugin_version, { italian }),
    italian
      ? "Impatto: nessun file del progetto è stato modificato, così i dati più recenti non vengono letti o riscritti in modo errato."
      : "Impact: no project files were changed, so the newer records are not misread or overwritten.",
    italian
      ? "Dopo l'aggiornamento riapri la sessione (in Claude Code: /reload-plugins) e ripeti il comando."
      : "After the update, reload the session (in Claude Code: /reload-plugins) and run the command again.",
  ].join("\n");
}

/**
 * Start-of-command check. A command that changes the project stops when the
 * project needs a newer plugin; a read-only command runs and warns once on
 * stderr. Returns the verdict for callers that report it.
 */
export function assertPluginSatisfiesProject(context, resolution, options = {}) {
  const verdict = projectPluginCompatibility(context);
  if (verdict.satisfied) return verdict;
  const italian = String(options.locale || "").trim().toLowerCase().startsWith("it");
  // Unknown commands count as changes, like the configuration check.
  const mutation = !resolution || commandMutationIntent(resolution, options) !== false;
  if (mutation) {
    failWithCode("PLUGIN_UPDATE_REQUIRED", blockedMessage(verdict, italian));
  }
  // Status shows the same warning among its own lines.
  if (resolution?.canonical_action === "status") return verdict;
  const line = pluginUpdateLine(verdict.required_plugin_version, { italian });
  if (options.json) {
    process.stderr.write(`${JSON.stringify({
      kind: "agentic_sdlc_warning",
      code: "PLUGIN_UPDATE_REQUIRED",
      message: line,
      required_plugin_version: verdict.required_plugin_version,
      update_command: pluginUpdateCommand(),
    })}\n`);
  } else {
    process.stderr.write(`Warning: ${line}\n`);
  }
  return verdict;
}

/** The doctor check: passed, or failed with the update command. */
export function pluginCompatibilityDoctorCheck(context) {
  const verdict = projectPluginCompatibility(context);
  if (verdict.satisfied) {
    return {
      status: "passed",
      details: verdict.required_plugin_version
        ? `The project's records need plugin ${verdict.required_plugin_version} or later; this computer runs ${verdict.running_plugin_version}.`
        : `The project's records need no particular plugin version; this computer runs ${verdict.running_plugin_version}.`,
    };
  }
  const unreadable = verdict.unreadable.length > 0 ? ` Unreadable requirement files: ${verdict.unreadable.join(", ")}.` : "";
  return {
    status: "failed",
    details: `${pluginUpdateLine(verdict.required_plugin_version)}${unreadable}`,
  };
}
