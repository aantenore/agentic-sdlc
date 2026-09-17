import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Claim policy entries the software actually reads from a project's effective
 * configuration. A project can change these and claiming will behave
 * differently.
 */
const CONFIGURABLE = Object.freeze([
  "default_ttl_seconds",
  "require_branch_pattern",
]);

/**
 * Entries that record what claiming always enforces. They are declared so the
 * guarantee is legible in the project's own configuration, and the software
 * deliberately does not read them: single ownership of a claimed story is what
 * keeps parallel tracks safe, so it cannot be waived from inside the project it
 * protects.
 *
 * This list is a ratchet. A new claim_policy entry must be either wired up and
 * listed as configurable, or listed here as an invariant and documented in the
 * template's `principle`. It may move from invariant to configurable; it must
 * never appear in neither list.
 */
const DECLARED_INVARIANTS = Object.freeze([
  "one_active_claim_per_story",
  "release_before_reclaim",
]);

/** Extra spellings under which the software reads an entry. */
const READ_ALIASES = Object.freeze({
  default_ttl_seconds: ["effectiveClaimPolicy(context).default_ttl_seconds"],
});

function templateClaimPolicyKeys() {
  const template = JSON.parse(fs.readFileSync(path.join(repoRoot, "templates/sdlc-config.json"), "utf8"));
  const keys = [];
  for (const [name, value] of Object.entries(template.claim_policy)) {
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

test("every declared claim policy entry is either read by the software or a documented invariant", () => {
  const declared = templateClaimPolicyKeys();
  const accounted = [...CONFIGURABLE, ...DECLARED_INVARIANTS].sort();

  assert.deepEqual(
    declared,
    accounted,
    "claim_policy changed. A new entry must be wired up and added to CONFIGURABLE, or "
      + "recorded in DECLARED_INVARIANTS and explained in the template's claim_policy principle.",
  );
});

test("entries listed as configurable are actually read from the project configuration", () => {
  const corpus = sourceCorpus();
  for (const entry of CONFIGURABLE) {
    const leaf = entry.split(".").pop();
    const spellings = [`claim_policy.${leaf}`, `claim_policy?.${leaf}`, ...(READ_ALIASES[leaf] || [])];
    assert.ok(
      spellings.some((spelling) => corpus.includes(spelling)),
      `claim_policy.${entry} is listed as configurable but no source file reads it`,
    );
  }
});

test("the template explains which entries are policy and which are invariants", () => {
  const template = JSON.parse(fs.readFileSync(path.join(repoRoot, "templates/sdlc-config.json"), "utf8"));
  const principle = template.claim_policy.principle;
  assert.equal(typeof principle, "string");
  assert.match(principle, /does not turn the check off/u);
  for (const entry of CONFIGURABLE) {
    const leaf = entry.split(".").pop();
    assert.ok(principle.includes(leaf), `claim_policy principle does not name the configurable entry ${leaf}`);
  }
});

test("the integration-review template records the same principle", () => {
  const variant = JSON.parse(fs.readFileSync(
    path.join(repoRoot, "templates/workflow-software-project-v3-integration-review/sdlc-config.json"),
    "utf8",
  ));
  const template = JSON.parse(fs.readFileSync(path.join(repoRoot, "templates/sdlc-config.json"), "utf8"));
  assert.equal(variant.claim_policy.principle, template.claim_policy.principle);
});
