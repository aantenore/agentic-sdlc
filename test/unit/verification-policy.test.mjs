import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  computeDerivedVerification,
  pathMatchesPattern,
  resolveVerificationPolicy,
  uncoveredDerivedCriteria,
} from "../../lib/verification-policy.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULTS = JSON.parse(fs.readFileSync(path.join(ROOT, "templates", "verification-policy.json"), "utf8"));
const policy = (override) => resolveVerificationPolicy(DEFAULTS, override);
const ids = (result) => result.derived_acceptance.map((item) => item.rule_id);

test("path patterns match whole segments and globs, not substrings", () => {
  assert.equal(pathMatchesPattern("apps/web", "apps/web/src/index.ts"), true);
  assert.equal(pathMatchesPattern("pages", "apps/web/pages"), true);
  assert.equal(pathMatchesPattern("pages", "homepages/a.ts"), false);
  assert.equal(pathMatchesPattern("*.tsx", "src/ui/Button.tsx"), true);
  assert.equal(pathMatchesPattern("README*", "docs/README.md"), true);
  assert.equal(pathMatchesPattern("src/app", "web/src/app/page.ts"), true);
  assert.equal(pathMatchesPattern("src/app", "src/application/a.ts"), false);
});

test("a back-end scope derives only unit tests", () => {
  const result = computeDerivedVerification(policy(), { writePaths: ["src", "test"] });
  assert.deepEqual(ids(result), ["unit-tests"]);
  const [criterion] = result.derived_acceptance;
  assert.equal(criterion.source, "derived");
  assert.equal(criterion.priority, "secondary");
  assert.equal(criterion.id, "DV-unit-tests");
  assert.equal(result.derived_verification.enforce, "block");
});

test("a UI scope adds end-to-end usability and accessibility checks", () => {
  const result = computeDerivedVerification(policy(), { writePaths: ["apps/web", "evidence"] });
  assert.deepEqual(ids(result), ["unit-tests", "ui-e2e", "ui-accessibility"]);
});

test("API, integrations, and docs scopes add their own rules", () => {
  assert.deepEqual(ids(computeDerivedVerification(policy(), { writePaths: ["src/api"] })), ["unit-tests", "api-integration"]);
  assert.deepEqual(ids(computeDerivedVerification(policy(), { writePaths: ["src"], hasIntegrations: true })), ["unit-tests", "api-integration"]);
  assert.deepEqual(ids(computeDerivedVerification(policy(), { writePaths: ["docs", "README.md"] })), ["unit-tests", "docs-executable"]);
});

test("an explicit criterion of the same verification type is not duplicated", () => {
  const result = computeDerivedVerification(policy(), {
    writePaths: ["components"],
    explicit: ["A Playwright end-to-end test completes the checkout", "Unit tests cover the cart"],
  });
  assert.deepEqual(ids(result), ["ui-accessibility"]);
  assert.deepEqual(result.derived_verification.covered_by_explicit.map((item) => item.rule_id), ["unit-tests", "ui-e2e"]);
});

test("opt-out and a disabled policy derive nothing and record why", () => {
  const optedOut = computeDerivedVerification(policy(), { writePaths: ["apps/web"], disabledReason: "--no-derived-verification" });
  assert.deepEqual(optedOut.derived_acceptance, []);
  assert.equal(optedOut.derived_verification.disabled, true);
  assert.equal(optedOut.derived_verification.reason, "--no-derived-verification");
  const off = computeDerivedVerification(policy({ enabled: false }), { writePaths: ["apps/web"] });
  assert.equal(off.derived_verification.reason, "policy_disabled");
});

test("a project override replaces fields, drops rules, adds rules, and sets enforcement", () => {
  const custom = policy({
    enforce: "warn",
    rules: [
      { id: "ui-accessibility", enabled: false },
      { id: "ui-e2e", when: { write_paths: ["frontend"] } },
      { id: "perf", verification_type: "performance", when: { write_paths: ["src/hot"] }, criterion: "A benchmark stays within budget." },
    ],
  });
  assert.deepEqual(ids(computeDerivedVerification(custom, { writePaths: ["apps/web"] })), ["unit-tests"]);
  assert.deepEqual(ids(computeDerivedVerification(custom, { writePaths: ["frontend", "src/hot"] })), ["unit-tests", "ui-e2e", "perf"]);
  assert.equal(computeDerivedVerification(custom, {}).derived_verification.enforce, "warn");
  assert.equal(computeDerivedVerification(custom, { mode: "backfill" }).derived_verification.enforce, "warn");
  assert.equal(computeDerivedVerification(policy(), { mode: "backfill" }).derived_verification.enforce, "warn");
  assert.throws(() => policy({ enforce: "maybe" }), /enforce/u);
});

test("evidence covers a criterion by named id or by matching command", () => {
  const { derived_acceptance: derived } = computeDerivedVerification(policy(), { writePaths: ["apps/web"] });
  const run = (overrides) => ({ record: { outcome: "passed", acceptance_criteria: [], command: { argv: ["npm", "test"] }, ...overrides } });
  assert.deepEqual(uncoveredDerivedCriteria(derived, []).map((item) => item.rule_id), ["unit-tests", "ui-e2e", "ui-accessibility"]);
  assert.deepEqual(uncoveredDerivedCriteria(derived, [run({})]).map((item) => item.rule_id), ["ui-e2e", "ui-accessibility"]);
  assert.deepEqual(
    uncoveredDerivedCriteria(derived, [run({}), run({ command: { argv: ["npx", "playwright", "test"] } }), run({ acceptance_criteria: ["DV-ui-accessibility"] })]),
    [],
  );
  assert.equal(uncoveredDerivedCriteria(derived.slice(0, 1), [run({ outcome: "failed" })]).length, 1);
});
