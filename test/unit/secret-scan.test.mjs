import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SECRET_RULES,
  REDACTION_PREFIX_LENGTH,
  SecretScanConfigurationError,
  compilePathGlob,
  isPathExcluded,
  redactMatch,
  resolveRuleSet,
  ruleSetHash,
  scanFiles,
} from "../../lib/secret-scan.mjs";

// Fixtures are assembled at runtime so no credential-shaped literal exists in
// this file: a repository's own secret scanning must not flag the scanner's
// tests, and a test for a secret scanner must never contain a real-looking key.
const fixture = (...parts) => parts.join("");
const AWS_KEY_ID = fixture("AKIA", "IOSFODNN7", "EXAMPLE");
const AWS_SECRET = fixture("wJalrXUtnFEMI/K7MDENG", "/bPxRfiCYEXAMPLEKEY");
const GITHUB_TOKEN = fixture("gh", "p_", "a1B2c3D4e5F6g7H8i9J0kLmNoPqRsTuVwXyZ".slice(0, 36));
const GITHUB_PAT = fixture("github", "_pat_", "1".repeat(22), "_", "2".repeat(59));
const SLACK_TOKEN = fixture("xo", "xb-", "12345678901-98765432109-", "AbCdEfGhIjKlMnOpQrStUvWx");
const PRIVATE_KEY_RSA = fixture("-----BEGIN RSA ", "PRIVATE KEY-----");
const PRIVATE_KEY_PKCS8 = fixture("-----BEGIN ", "PRIVATE KEY-----");

function file(path, content) {
  return { path, content };
}

function ruleIds(result) {
  return result.findings.map((finding) => finding.rule).sort();
}

test("every default rule matches a credential of its own shape", () => {
  const cases = [
    ["aws_access_key_id", `const id = "${AWS_KEY_ID}";`],
    ["aws_secret_access_key", `aws_secret_access_key = "${AWS_SECRET}"`],
    ["github_token", `TOKEN=${GITHUB_TOKEN}`],
    ["github_token", `TOKEN=${GITHUB_PAT}`],
    ["slack_token", `slack: ${SLACK_TOKEN}`],
    ["private_key_block", PRIVATE_KEY_RSA],
    ["private_key_block", PRIVATE_KEY_PKCS8],
    ["assigned_credential_literal", "password = \"correct-horse-battery\""],
    ["assigned_credential_literal", "api_key: 'abcdefghijkl'"],
  ];
  for (const [rule, content] of cases) {
    const result = scanFiles([file("src/app.js", content)]);
    assert.equal(result.outcome, "findings", `no finding for ${rule} in ${content}`);
    assert.ok(ruleIds(result).includes(rule), `${rule} did not match: ${content}`);
  }
});

test("look-alikes that are not credentials produce no finding", () => {
  const negatives = [
    "const region = \"AKIA\"; // truncated prefix only",
    "AKIAIOSFODNN7EXAM", // too short for an access key id
    "const label = \"ghp_short\";",
    "xoxb-1",
    "// -----BEGIN CERTIFICATE-----",
    "password = os.environ[\"APP_PASSWORD\"]",
    "const secret = buildSecret(name);",
    "token: \"\"",
    "api_key: 'short'",
  ];
  for (const content of negatives) {
    const result = scanFiles([file("src/app.js", content)]);
    assert.equal(result.outcome, "clean", `unexpected finding for: ${content} -> ${JSON.stringify(result.findings)}`);
  }
});

test("a finding names the file and line and never carries the matched value", () => {
  const result = scanFiles([file("config/prod.env", `unused\nAWS_ID=${AWS_KEY_ID}\n`)]);
  assert.equal(result.findings.length, 1);
  const [finding] = result.findings;
  assert.equal(finding.path, "config/prod.env");
  assert.equal(finding.line, 2);
  assert.equal(finding.rule, "aws_access_key_id");
  assert.equal(finding.redacted_match, "AKIA…");
  assert.equal(finding.redacted_match.length, REDACTION_PREFIX_LENGTH + 1);
  assert.ok(!JSON.stringify(result).includes(AWS_KEY_ID), "the scan result leaked the matched credential");
});

test("redaction keeps at most four characters and never the whole value", () => {
  assert.equal(redactMatch("ghp_abcdefghijkl"), "ghp_…");
  assert.equal(redactMatch("ab"), "ab…");
  assert.equal(redactMatch(""), "…");
});

test("project rules override a default by id and extend the set", () => {
  const rules = resolveRuleSet([
    { id: "aws_access_key_id", pattern: "NEVER_MATCHES_ANYTHING", flags: "g" },
    { id: "internal_ticket_token", pattern: "\\bTKT-[0-9]{6}\\b" },
  ]);
  assert.equal(rules.length, DEFAULT_SECRET_RULES.length + 1);
  assert.equal(rules[0].id, "aws_access_key_id");
  assert.equal(rules[0].pattern, "NEVER_MATCHES_ANYTHING");
  assert.equal(rules.at(-1).id, "internal_ticket_token");

  const result = scanFiles([file("src/app.js", `${AWS_KEY_ID} TKT-123456`)], {
    rules: [
      { id: "aws_access_key_id", pattern: "NEVER_MATCHES_ANYTHING", flags: "g" },
      { id: "internal_ticket_token", pattern: "\\bTKT-[0-9]{6}\\b" },
    ],
  });
  assert.deepEqual(ruleIds(result), ["internal_ticket_token"]);
  assert.equal(result.findings[0].redacted_match, "TKT-…");
});

test("a rule set that cannot be compiled is refused instead of silently skipped", () => {
  assert.throws(() => resolveRuleSet([{ id: "broken", pattern: "([a-z" }]), SecretScanConfigurationError);
  assert.throws(() => resolveRuleSet([{ pattern: "x" }]), SecretScanConfigurationError);
  assert.throws(() => resolveRuleSet([{ id: "bad id", pattern: "x" }]), SecretScanConfigurationError);
  assert.throws(() => resolveRuleSet([{ id: "flags", pattern: "x", flags: "q" }]), SecretScanConfigurationError);
  assert.throws(() => resolveRuleSet("not-an-array"), SecretScanConfigurationError);
});

test("excluded paths are reported as skipped and never scanned", () => {
  const files = [
    file("test/fixtures/sample.env", `AWS=${AWS_KEY_ID}`),
    file("src/app.js", `AWS=${AWS_KEY_ID}`),
  ];
  const result = scanFiles(files, { excludePaths: ["test/fixtures/**"] });
  assert.deepEqual(result.scanned_paths, ["src/app.js"]);
  assert.deepEqual(result.skipped_paths, ["test/fixtures/sample.env"]);
  assert.deepEqual(result.findings.map((finding) => finding.path), ["src/app.js"]);
});

test("path globs match segment by segment", () => {
  assert.ok(compilePathGlob("docs/*.md").test("docs/guide.md"));
  assert.ok(!compilePathGlob("docs/*.md").test("docs/nested/guide.md"));
  assert.ok(compilePathGlob("docs/**/*.md").test("docs/nested/deep/guide.md"));
  assert.ok(compilePathGlob("**/*.lock").test("a/b/c.lock"));
  assert.ok(compilePathGlob("docs/**").test("docs/nested/guide.md"), "a trailing ** covers everything below");
  assert.ok(!compilePathGlob("docs/**").test("src/guide.md"));
  assert.ok(isPathExcluded("vendor\\bundle.js", ["vendor/*.js"]), "backslash paths are normalized before matching");
  assert.throws(() => compilePathGlob("  "), SecretScanConfigurationError);
});

test("the rule set hash distinguishes rule sets and repeats for the same one", () => {
  const base = resolveRuleSet([]);
  const changed = resolveRuleSet([{ id: "aws_access_key_id", pattern: "AKIA[A-Z0-9]{16}" }]);
  assert.equal(ruleSetHash(base), ruleSetHash(resolveRuleSet([])));
  assert.notEqual(ruleSetHash(base), ruleSetHash(changed));
  assert.match(ruleSetHash(base), /^[a-f0-9]{64}$/u);
  assert.equal(scanFiles([]).rule_set_hash, ruleSetHash(base));
  assert.equal(scanFiles([]).outcome, "clean");
});

test("a pathological line is scanned in time proportional to its length", () => {
  const long = `${"a".repeat(400_000)} ${"=".repeat(50_000)} ${"'".repeat(50_000)}`;
  const started = process.hrtime.bigint();
  const result = scanFiles([file("src/huge.txt", long)]);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(result.outcome, "clean");
  assert.ok(elapsedMs < 2000, `scanning one long line took ${elapsedMs.toFixed(0)}ms`);
});

test("findings are ordered by path, line, and rule so a record is reproducible", () => {
  const result = scanFiles([
    file("src/b.js", `x\n${AWS_KEY_ID}`),
    file("src/a.js", `token = "${GITHUB_TOKEN}"`),
  ]);
  assert.deepEqual(
    result.findings.map((finding) => [finding.path, finding.line, finding.rule]),
    [
      ["src/a.js", 1, "assigned_credential_literal"],
      ["src/a.js", 1, "github_token"],
      ["src/b.js", 2, "aws_access_key_id"],
    ],
  );
  assert.equal(result.file_count, undefined);
  assert.deepEqual(result.scanned_paths, ["src/a.js", "src/b.js"]);
});
