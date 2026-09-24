import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Gate policy entries the software actually reads from a project's effective
 * configuration. A project can change these and the gate will behave
 * differently.
 */
const CONFIGURABLE = Object.freeze([
  "contract_required_fields",
  "implementation_requires_acceptance_criteria",
  "implementation_requires_claim",
  "release_requires_release_trace",
  "secret_scan.enabled",
  "secret_scan.exclude_paths",
  "secret_scan.rules",
  "story_required_fields",
  "strict_mode.requires_output_contract_coverage",
  "strict_mode.requires_write_scope_integrity",
  "validation_requires_test_trace",
]);

/**
 * Entries that record what `--strict` always enforces. They are declared so the
 * guarantee is legible in the project's own configuration, and the software
 * deliberately does not read them: a gate that could be switched off from
 * inside the project it governs would not be a gate.
 *
 * This list is a ratchet. A new gate_policy entry must be either wired up and
 * listed as configurable, or listed here as an invariant and documented in the
 * template's `principle`. It may move from invariant to configurable; it must
 * never appear in neither list.
 */
const DECLARED_INVARIANTS = Object.freeze([
  "strict_mode.blocks_cache_as_primary_source",
  "strict_mode.blocks_unapproved_duplicate_outputs",
  "strict_mode.requires_active_claim_for_implementation",
  "strict_mode.requires_attributed_traces",
  "strict_mode.requires_contextualized_contracts",
  "strict_mode.requires_latest_human_gate_approval",
  "strict_mode.requires_zero_open_contract_questions",
]);

function templateGatePolicyKeys() {
  const template = JSON.parse(fs.readFileSync(path.join(repoRoot, "templates/sdlc-config.json"), "utf8"));
  const keys = [];
  for (const [name, value] of Object.entries(template.gate_policy)) {
    if (name === "principle") continue;
    if (value && typeof value === "object" && !Array.isArray(value)) {
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

test("every declared gate policy entry is either read by the software or a documented invariant", () => {
  const declared = templateGatePolicyKeys();
  const accounted = [...CONFIGURABLE, ...DECLARED_INVARIANTS].sort();

  assert.deepEqual(
    declared,
    accounted,
    "gate_policy changed. A new entry must be wired up and added to CONFIGURABLE, or "
      + "recorded in DECLARED_INVARIANTS and explained in the template's gate_policy principle.",
  );
});

test("entries listed as configurable are actually read from the project configuration", () => {
  // Optional chaining is normalized away so one nested entry is matched by its
  // full path: a source file that reads gate_policy?.secret_scan?.enabled
  // accounts for secret_scan.enabled and for nothing else.
  const corpus = sourceCorpus().replaceAll("?.", ".");
  for (const entry of CONFIGURABLE) {
    assert.ok(
      corpus.includes(`gate_policy.${entry}`),
      `gate_policy.${entry} is listed as configurable but no source file reads it`,
    );
  }
});

test("the template explains which entries are policy and which are invariants", () => {
  const template = JSON.parse(fs.readFileSync(path.join(repoRoot, "templates/sdlc-config.json"), "utf8"));
  const principle = template.gate_policy.principle;
  assert.equal(typeof principle, "string");
  assert.match(principle, /does not turn the check off/u);
  for (const entry of CONFIGURABLE) {
    const leaf = entry.split(".").pop();
    assert.ok(principle.includes(leaf), `gate_policy principle does not name the configurable entry ${leaf}`);
  }
});
