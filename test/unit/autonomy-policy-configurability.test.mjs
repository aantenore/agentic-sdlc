import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Autonomy policy entries the software actually reads from a project's
 * effective configuration. A project can change these and autonomy negotiation
 * will behave differently.
 */
const CONFIGURABLE = Object.freeze([
  "allowed_levels",
  "default_requirement_ceiling",
  "delivery_kinds",
  "delivery_providers",
  "enabled",
  "exception_triggers",
  "legacy_default",
  "local_release.machine_global_changes_require_checkpoint",
  "local_release.writes_outside_workspace_require_checkpoint",
  "mode",
  "presets",
  "require_explicit_delivery_selection",
  "storage_root",
]);

/**
 * Entries that record what autonomy always does. They are declared so the
 * guarantee is legible in the project's own configuration, and the software
 * deliberately does not read them: the schema names record which shipped schema
 * validates each record, an unrecognised level is refused, bounded-autonomous
 * is capped to checkpointed unless authority_policy.mode is host_verified, and
 * a delivery target is always fully identified, never reused for another
 * delivery, and always carries a rollback procedure. An autonomy ceiling the
 * delivery it authorizes could raise from inside would not be a ceiling.
 *
 * This list is a ratchet. A new autonomy_policy entry must be either wired up
 * and listed as configurable, or listed here as an invariant and documented in
 * the template's `principle`. It may move from invariant to configurable; it
 * must never appear in neither list.
 */
const DECLARED_INVARIANTS = Object.freeze([
  "bounded_autonomous_requires_host_verified",
  "decision_schema",
  "delivery_profile_schema",
  "delivery_profile_schema_v2",
  "fail_closed_on_unknown",
  "local_release.require_rollback",
  "local_release.require_target_root",
  "pull_request.never_reuse_for_another_delivery",
  "pull_request.require_base_branch",
  "pull_request.require_head_branch",
  "pull_request.require_repository",
  "requirement_profile_schema",
]);

/** Prose entries, in the same class as the other blocks' `principle`. */
const NARRATIVE = Object.freeze(["principle"]);

/**
 * Objects the software reads whole rather than entry by entry; their inner keys
 * are data for the entry itself, not separate policy switches.
 */
const WHOLE_OBJECTS = Object.freeze(["delivery_providers", "presets"]);

function templateAutonomyPolicyKeys() {
  const template = JSON.parse(fs.readFileSync(path.join(repoRoot, "templates/sdlc-config.json"), "utf8"));
  const keys = [];
  for (const [name, value] of Object.entries(template.autonomy_policy)) {
    if (NARRATIVE.includes(name)) continue;
    if (!WHOLE_OBJECTS.includes(name) && value && typeof value === "object" && !Array.isArray(value)) {
      for (const nested of Object.keys(value)) keys.push(`${name}.${nested}`);
    } else {
      keys.push(name);
    }
  }
  return keys.sort();
}

function sourceCorpus() {
  const contents = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { encoding: "utf8", withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile() && [".mjs", ".js", ".cjs"].includes(path.extname(entry.name))) {
        contents.push(fs.readFileSync(entryPath, "utf8"));
      }
    }
  };
  visit(path.join(repoRoot, "bin"));
  visit(path.join(repoRoot, "lib"));
  return contents.join("\n");
}

test("every declared autonomy policy entry is either read by the software or a documented invariant", () => {
  const declared = templateAutonomyPolicyKeys();
  const accounted = [...CONFIGURABLE, ...DECLARED_INVARIANTS].sort();

  assert.deepEqual(
    declared,
    accounted,
    "autonomy_policy changed. A new entry must be wired up and added to CONFIGURABLE, or "
      + "recorded in DECLARED_INVARIANTS and explained in the template's autonomy_policy principle.",
  );
});

test("entries listed as configurable are actually read from the project configuration", () => {
  const corpus = sourceCorpus();
  for (const entry of CONFIGURABLE) {
    const leaf = entry.split(".").pop();
    assert.ok(
      corpus.includes(`autonomy_policy.${leaf}`) || corpus.includes(`autonomy_policy?.${leaf}`)
        || corpus.includes(`policy.${leaf}`) || corpus.includes(`policy?.${leaf}`),
      `autonomy_policy.${entry} is listed as configurable but no source file reads it`,
    );
  }
});

test("the template explains which entries are policy and which are invariants", () => {
  const template = JSON.parse(fs.readFileSync(path.join(repoRoot, "templates/sdlc-config.json"), "utf8"));
  const principle = template.autonomy_policy.principle;
  assert.equal(typeof principle, "string");
  assert.match(principle, /does not turn the check off/u);
  for (const entry of CONFIGURABLE) {
    const leaf = entry.split(".").pop();
    assert.ok(principle.includes(leaf), `autonomy_policy principle does not name the configurable entry ${leaf}`);
  }
});

test("the integration-review template records the same principle", () => {
  const variant = JSON.parse(fs.readFileSync(
    path.join(repoRoot, "templates/workflow-software-project-v3-integration-review/sdlc-config.json"),
    "utf8",
  ));
  const template = JSON.parse(fs.readFileSync(path.join(repoRoot, "templates/sdlc-config.json"), "utf8"));
  assert.equal(variant.autonomy_policy.principle, template.autonomy_policy.principle);
});
