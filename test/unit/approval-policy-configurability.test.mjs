import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Approval policy entries the software actually reads from a project's
 * effective configuration. A project can change these and approvals will behave
 * differently.
 */
const CONFIGURABLE = Object.freeze([
  "accepted_sources",
  "allow_bootstrap_approvals_in_strict_gate",
  "formal_approval_requires_explicit_source",
  "legacy_approval_behavior",
  "require_summary_or_evidence_for_automation",
  "require_summary_or_evidence_for_explicit_user",
]);

/**
 * Entries that record what approvals always do. They are declared so the
 * guarantee is legible in the project's own configuration, and the software
 * deliberately does not read them: the schema names record which shipped schema
 * validates each record, and the requirements are always enforced. An approval
 * rule a project could relax from inside the project it governs would not be a
 * rule.
 *
 * This list is a ratchet. A new approval_policy entry must be either wired up
 * and listed as configurable, or listed here as an invariant and documented in
 * the template's `principle`. It may move from invariant to configurable; it
 * must never appear in neither list.
 */
const DECLARED_INVARIANTS = Object.freeze([
  "authorization_usage_receipt_schema",
  "close_authorization_on_workflow_terminal",
  "content_authorization_schema",
  "host_approval_receipt_schema",
  "require_proposal_bound_authorization_for_assessments",
  "require_usage_receipt_for_automation",
]);

/**
 * Prose entries: guidance for whoever records an approval, in the same class as
 * `principle`. They are not switches and carry no enforcement of their own.
 */

/**
 * Declared and unread, and kept on purpose. Each of these also exists in the
 * frozen 0.11.0 defaults that the effective-config merge fills missing keys
 * from, so dropping one from the template would not remove it: the merge
 * would put it straight back, and the two hash paths that agree today would
 * stop agreeing. They stay until that legacy baseline is retired.
 */
const COMPATIBILITY = Object.freeze([
  "authorization_usage_receipt_directory",
  "host_approval_receipt_directory",
  "require_host_assurance_for_direct_human_or_ci_approval",
]);

const NARRATIVE = Object.freeze(["agent_rules", "principle"]);

function templateApprovalPolicyKeys() {
  const template = JSON.parse(fs.readFileSync(path.join(repoRoot, "templates/sdlc-config.json"), "utf8"));
  const keys = [];
  for (const [name, value] of Object.entries(template.approval_policy)) {
    if (NARRATIVE.includes(name)) continue;
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

test("every declared approval policy entry is either read by the software or a documented invariant", () => {
  const declared = templateApprovalPolicyKeys();
  const accounted = [...CONFIGURABLE, ...DECLARED_INVARIANTS, ...COMPATIBILITY].sort();

  assert.deepEqual(
    declared,
    accounted,
    "approval_policy changed. A new entry must be wired up and added to CONFIGURABLE, or "
      + "recorded in DECLARED_INVARIANTS and explained in the template's approval_policy principle.",
  );
});

test("entries listed as configurable are actually read from the project configuration", () => {
  const corpus = sourceCorpus();
  for (const entry of CONFIGURABLE) {
    const leaf = entry.split(".").pop();
    assert.ok(
      corpus.includes(`approval_policy.${leaf}`) || corpus.includes(`approval_policy?.${leaf}`)
        || corpus.includes(`policy.${leaf}`),
      `approval_policy.${entry} is listed as configurable but no source file reads it`,
    );
  }
});

test("the template explains which entries are policy and which are invariants", () => {
  const template = JSON.parse(fs.readFileSync(path.join(repoRoot, "templates/sdlc-config.json"), "utf8"));
  const principle = template.approval_policy.principle;
  assert.equal(typeof principle, "string");
  assert.match(principle, /does not turn the check off/u);
  for (const entry of CONFIGURABLE) {
    const leaf = entry.split(".").pop();
    assert.ok(principle.includes(leaf), `approval_policy principle does not name the configurable entry ${leaf}`);
  }
  assert.ok(Array.isArray(template.approval_policy.agent_rules), "agent_rules must stay a list of guidance strings");
});

test("the integration-review template records the same principle", () => {
  const variant = JSON.parse(fs.readFileSync(
    path.join(repoRoot, "templates/workflow-software-project-v3-integration-review/sdlc-config.json"),
    "utf8",
  ));
  const template = JSON.parse(fs.readFileSync(path.join(repoRoot, "templates/sdlc-config.json"), "utf8"));
  assert.equal(variant.approval_policy.principle, template.approval_policy.principle);
});
