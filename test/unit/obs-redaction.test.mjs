import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  REDACTION_LIMIT_PLACEHOLDER,
  REDACTION_PLACEHOLDER,
  createLegacyEvidenceV1RedactionPolicy,
  createHistoricalOperationalEvidenceV1RedactionPolicy,
  createRedactionPolicy,
  createRedactionPolicyFromSource,
  createOperationalRedactionPolicy,
  describeRedactionPolicy,
  isAllowedIdentifier,
  redactText,
  redactValue,
  redactValueWithMetadata,
} from "../../lib/observability/redaction.mjs";

test("legacy evidence v1 compatibility preserves historical entropy and allowlist semantics", () => {
  const legacy = createLegacyEvidenceV1RedactionPolicy();
  const current = createOperationalRedactionPolicy();
  const entropyOnly = "Z9_".repeat(16);
  const sha = "a".repeat(64);
  const actionId = "AUT-ACT-20260718112254904-6a4356";

  assert.equal(redactText(entropyOnly, current), entropyOnly);
  assert.equal(redactText(entropyOnly, legacy), REDACTION_PLACEHOLDER);
  assert.equal(redactText("owner@example.com", legacy), REDACTION_PLACEHOLDER);
  assert.equal(redactText(sha, legacy), sha);
  assert.equal(redactText(actionId, legacy), actionId);
  const frozenEmailExpression = /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/giu;
  for (const input of [
    ".b@-_..a.@!b_-_.b",
    "-@a中@_é!._!_bK-_bbK",
    "prefix owner@example.com suffix",
  ]) {
    assert.equal(
      redactText(input, legacy),
      input.replace(frozenEmailExpression, REDACTION_PLACEHOLDER),
      input,
    );
  }
});

test("content-addressable policy sources round-trip the exact effective semantics", () => {
  const policy = createOperationalRedactionPolicy({
    sensitiveKeys: ["employee_pin"],
    piiPatterns: [{ name: "employee", pattern: /EMP-[0-9]{6}/giu }],
    identifierAllowPatterns: [{ name: "case", pattern: /^CASE-[0-9]{4}$/u }],
    limits: { maxMatches: 123 },
  });
  const source = describeRedactionPolicy(policy);
  const rebuilt = createRedactionPolicyFromSource(JSON.parse(JSON.stringify(source)));
  const sample = "employee=EMP-123456 case=CASE-1234 token=abcdefghijklmnopqrstuvwxyz012345";

  assert.deepEqual(describeRedactionPolicy(rebuilt), source);
  assert.equal(redactText(sample, rebuilt), redactText(sample, policy));
  const tampered = JSON.parse(JSON.stringify(source));
  tampered.semantics.credential_assignments = false;
  assert.throws(() => createRedactionPolicyFromSource(tampered), /algorithm and semantics disagree/u);
});

test("operational key aliases do not change the frozen legacy v1 policy source", () => {
  const operational = createOperationalRedactionPolicy();
  const legacy = createLegacyEvidenceV1RedactionPolicy();
  const historicalOperational = createHistoricalOperationalEvidenceV1RedactionPolicy();
  const legacySource = describeRedactionPolicy(legacy);

  assert.deepEqual(redactValue({ passwd: "new-alias-secret" }, operational), {
    passwd: REDACTION_PLACEHOLDER,
  });
  assert.deepEqual(redactValue({ passwd: "historically-visible" }, legacy), {
    passwd: "historically-visible",
  });
  assert.deepEqual(redactValue({ passwd: "historically-visible" }, historicalOperational), {
    passwd: "historically-visible",
  });
  assert.equal(
    describeRedactionPolicy(historicalOperational).algorithm,
    "operational_evidence_v1",
  );
  assert.equal(legacySource.sensitive_keys.includes("passwd"), false);
  assert.deepEqual(
    describeRedactionPolicy(createRedactionPolicyFromSource(JSON.parse(JSON.stringify(legacySource)))),
    legacySource,
  );
});

test("legacy v1 reproduces historical __proto__ omission without prototype mutation", () => {
  const legacy = createLegacyEvidenceV1RedactionPolicy();
  const source = JSON.parse('{"safe":"kept","__proto__":{"polluted":true}}');
  const output = redactValue(source, legacy);

  assert.deepEqual(output, { safe: "kept" });
  assert.equal(Object.getPrototypeOf(output), Object.prototype);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(JSON.stringify(output), '{"safe":"kept"}');
});

test("recursive redaction is immutable, idempotent, and preserves approved identifiers", () => {
  const policy = createRedactionPolicy({
    secrets: ["sk_live_very-secret"],
    piiPatterns: [{ name: "email", pattern: /owner@example\.com/iu }],
  });
  const sha = "a".repeat(64);
  const uuid = "123e4567-e89b-12d3-a456-426614174000";
  const correlationId = `corr-${uuid}`;
  const actionId = "AUT-ACT-20260718112254904-6a4356";
  const source = {
    contact: "owner@example.com",
    nested: [{ password: "do-not-persist", note: "uses sk_live_very-secret" }],
    sha,
    uuid,
    correlation_id: correlationId,
    authorization_receipt: actionId,
  };

  const result = redactValue(source, policy);
  assert.deepEqual(result, {
    contact: REDACTION_PLACEHOLDER,
    nested: [{ password: REDACTION_PLACEHOLDER, note: `uses ${REDACTION_PLACEHOLDER}` }],
    sha,
    uuid,
    correlation_id: correlationId,
    authorization_receipt: actionId,
  });
  assert.equal(source.contact, "owner@example.com");
  assert.equal(source.nested[0].password, "do-not-persist");
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.nested[0]), true);
  assert.deepEqual(redactValue(result, policy), result);
  assert.equal(isAllowedIdentifier(sha, policy), true);
  assert.equal(isAllowedIdentifier(uuid, policy), true);
  assert.equal(isAllowedIdentifier(correlationId, policy), true);
  assert.equal(isAllowedIdentifier(actionId, policy), true);
});

test("recursive redaction preserves an own __proto__ data property without prototype pollution", () => {
  const source = JSON.parse(
    '{"safe":"value","__proto__":{"polluted":true,"nested":{"kept":"yes"}}}',
  );

  const output = redactValue(source);
  const descriptor = Object.getOwnPropertyDescriptor(output, "__proto__");

  assert.equal(Object.getPrototypeOf(output), Object.prototype);
  assert.equal(Object.hasOwn(output, "__proto__"), true);
  assert.equal(descriptor?.enumerable, true);
  assert.equal(Object.hasOwn(descriptor, "value"), true);
  assert.equal(descriptor?.get, undefined);
  assert.equal(descriptor?.set, undefined);
  assert.deepEqual(descriptor?.value, {
    polluted: true,
    nested: { kept: "yes" },
  });
  assert.equal(output.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(Object.isFrozen(output), true);
  assert.equal(Object.isFrozen(output.__proto__), true);
  assert.equal(Object.isFrozen(output.__proto__.nested), true);
});

test("explicit secrets and sensitive keys take precedence over identifier allowlisting", () => {
  const actionId = "AUT-ACT-20260718112254904-6a4356";
  const policy = createRedactionPolicy({ secrets: [actionId] });

  assert.equal(redactText(actionId, policy), REDACTION_PLACEHOLDER);
  assert.deepEqual(redactValue({ token: "a".repeat(64) }, policy), {
    token: REDACTION_PLACEHOLDER,
  });
});

test("operational credential context overrides SHA-shaped identifier allowlisting", () => {
  const shaShapedSecret = "a".repeat(64);
  const policy = createOperationalRedactionPolicy();

  assert.equal(redactText(shaShapedSecret, policy), shaShapedSecret);
  assert.equal(redactText(`token=${shaShapedSecret}`, policy), REDACTION_PLACEHOLDER);
  assert.equal(redactText(`Bearer ${shaShapedSecret}`, policy), REDACTION_PLACEHOLDER);
});

test("broad custom identifier allowlists cannot bypass credentials or configured PII", () => {
  const token = `ghp_${"A".repeat(36)}`;
  const uuid = "550e8400-e29b-41d4-a716-446655440000";
  const policy = createOperationalRedactionPolicy({
    identifierAllowPatterns: [{ name: "unsafe_broad_allow", pattern: "^.{1,256}$" }],
    piiPatterns: [{ name: "configured_uuid", pattern: "[a-f0-9-]{36}" }],
  });

  assert.equal(redactText(token, policy), REDACTION_PLACEHOLDER);
  assert.equal(redactText(uuid, policy), REDACTION_PLACEHOLDER);
});

test("operational policy preserves a realistic governed model without false positives", () => {
  const policy = createOperationalRedactionPolicy();
  const requirementId = "REQ-ENT-OBSERVABILITY-001";
  const contractId = "contract-ST-ENT-OBSERVABILITY-implementation";
  const storyId = "ST-ENT-OBSERVABILITY";
  const artifactPath = `.sdlc/stories/${storyId}/outputs/${contractId}.md`;
  const rawHref = `/api/v1/source?path=${encodeURIComponent(artifactPath)}`;
  const gitSha = "0123456789abcdef0123456789abcdef01234567";
  const sha = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const uuid = "550e8400-e29b-41d4-a716-446655440000";
  const correlationId = `corr-${uuid}`;
  const actionId = "AUT-ACT-20260718123456789-abcdef";
  const model = {
    schema_version: "change-observatory-model:v1",
    requirement: { id: requirementId, story_ids: [storyId] },
    contract: { id: contractId, requirement_id: requirementId, story_id: storyId },
    source: { file: artifactPath, rawHref },
    lineage: {
      git_sha: gitSha,
      sha256: sha,
      uuid,
      correlation_id: correlationId,
      authorization_receipt: actionId,
    },
  };

  const result = redactValueWithMetadata(model, policy);
  assert.deepEqual(result.value, model);
  assert.equal(result.redactions, 0);
  assert.equal(result.limited, false);
  for (const identifier of [
    requirementId,
    contractId,
    storyId,
    artifactPath,
    rawHref,
    gitSha,
    sha,
    uuid,
    correlationId,
    actionId,
  ]) {
    assert.equal(JSON.stringify(result.value).includes(identifier), true, `${identifier} was incorrectly redacted`);
  }
});

test("operational policy redacts known tokens, credential assignments, and Bearer credentials", () => {
  const policy = createOperationalRedactionPolicy();
  const knownTokens = [
    `github_pat_${"A".repeat(32)}`,
    `ghp_${"B".repeat(36)}`,
    `ghr_${"R".repeat(36)}`,
    `AKIA${"C".repeat(16)}`,
    `glpat-${"d".repeat(24)}`,
    `sk_live_${"e".repeat(24)}`,
    `sk-${"O".repeat(32)}`,
    `sk-proj-${"P".repeat(32)}`,
    `xoxb-${"1".repeat(20)}`,
    [`eyJ${"H".repeat(20)}`, "P".repeat(32), "S".repeat(43)].join("."),
  ];

  for (const token of knownTokens) {
    assert.equal(redactText(token, policy), REDACTION_PLACEHOLDER, token.slice(0, 8));
  }
  assert.equal(
    redactText(`client_secret=${"S".repeat(32)}`, policy),
    REDACTION_PLACEHOLDER,
  );
  assert.equal(
    redactText(`Bearer ${"a".repeat(40)}`, policy),
    REDACTION_PLACEHOLDER,
  );
  assert.equal(
    redactText(`Basic ${Buffer.from("user:password").toString("base64")}`, policy),
    REDACTION_PLACEHOLDER,
  );
  for (const assignment of [
    `AWS_SECRET_ACCESS_KEY=${"A".repeat(40)}`,
    `GOOGLE_API_KEY=${"B".repeat(39)}`,
    `AZURE_STORAGE_ACCOUNT_KEY=${"C".repeat(44)}`,
    `MY_CLIENT_SECRET=${"E".repeat(32)}`,
    'password="p@ssw0rd!"',
    'client_secret: "correct horse battery staple"',
    '"password":"p@ssw0rd!"',
    '"client_secret":"correct horse battery staple"',
    `authorization: Basic ${Buffer.from("user:password").toString("base64")}`,
    'password="escaped \\" quote"',
    'account_key="account key material"',
    'credential="opaque credential material"',
    'credentials="opaque credential collection"',
    'passphrase="correct horse battery staple"',
    'passwd="alternate password material"',
    'pwd="short password alias"',
  ]) {
    assert.equal(redactText(assignment, policy), REDACTION_PLACEHOLDER, assignment.slice(0, 16));
  }
  assert.equal(
    redactText('password="p@ssw0rd!" status=failed', policy),
    `${REDACTION_PLACEHOLDER} status=failed`,
  );
  for (const header of [
    "Cookie: sessionid=abcdefghijklmnop",
    "Set-Cookie: sid=abcdefghijklmnop; HttpOnly; Secure",
  ]) {
    assert.equal(redactText(header, policy), REDACTION_PLACEHOLDER);
  }
  assert.equal(
    redactText('payload {"password":"p@ssw0rd!"}', policy).includes("p@ssw0rd!"),
    false,
  );
  assert.equal(
    redactText(
      `-----BEGIN ENCRYPTED PRIVATE KEY-----\n${"A".repeat(64)}\n-----END ENCRYPTED PRIVATE KEY-----`,
      policy,
    ),
    REDACTION_PLACEHOLDER,
  );
  for (const longCredential of [
    `token=${"A".repeat(250_000)}`,
    `ghp_${"A".repeat(250_000)}`,
    `Bearer ${"A".repeat(250_000)}`,
  ]) {
    assert.equal(redactText(longCredential, policy), REDACTION_PLACEHOLDER);
  }
});

test("operational policy redacts complete URL userinfo without consuming the host or resource", () => {
  const policy = createOperationalRedactionPolicy();
  const cases = [
    {
      input: "https://user:password@example.test/path",
      expected: `${REDACTION_PLACEHOLDER}example.test/path`,
    },
    {
      input: "https://user:p@ss@localhost/path@visible",
      expected: `${REDACTION_PLACEHOLDER}localhost/path@visible`,
    },
    {
      input: "ssh://us@er:p@ss@host.test/resource",
      expected: `${REDACTION_PLACEHOLDER}host.test/resource`,
    },
    {
      input: "x://:password@host.test/resource",
      expected: `${REDACTION_PLACEHOLDER}host.test/resource`,
    },
    {
      input: "https://user:@host.test/resource",
      expected: `${REDACTION_PLACEHOLDER}host.test/resource`,
    },
    {
      input: "https://user:p@ss@localhost?next=handle@localhost#fragment",
      expected: `${REDACTION_PLACEHOLDER}localhost?next=handle@localhost#fragment`,
    },
  ];

  for (const { input, expected } of cases) {
    assert.equal(redactText(input, policy), expected, input);
  }
  assert.equal(
    redactText("https://public.example:443?next=handle@localhost", policy),
    "https://public.example:443?next=handle@localhost",
  );
});

test("redacts credential and configured PII property names without collisions", () => {
  const token = `github_pat_${"A".repeat(32)}`;
  const policy = createOperationalRedactionPolicy({
    piiPatterns: [{ name: "employee", pattern: "EMP-[0-9]{6}" }],
  });
  const source = {
    [token]: "credential-key",
    "EMP-123456": "pii-key",
    "[REDACTED]": "literal-placeholder-key",
  };

  const result = redactValue(source, policy);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(token), false);
  assert.equal(serialized.includes("EMP-123456"), false);
  assert.equal(Object.keys(result).length, 3);
  assert.deepEqual(Object.values(result).sort(), [
    "credential-key",
    "literal-placeholder-key",
    "pii-key",
  ]);
  assert.equal(new Set(Object.keys(result)).size, 3);
});

test("redaction limits and cycles fail closed without retaining partial values", () => {
  const depthPolicy = createRedactionPolicy({ limits: { maxDepth: 2 } });
  const result = redactValueWithMetadata({ a: { b: { c: "must-not-leak" } } }, depthPolicy);
  assert.deepEqual(result, {
    value: REDACTION_LIMIT_PLACEHOLDER,
    redactions: 0,
    limited: true,
    limit: "maxDepth",
  });

  const cycle = { safe: "prefix", secret: "must-not-leak" };
  cycle.self = cycle;
  assert.equal(redactValue(cycle), REDACTION_LIMIT_PLACEHOLDER);

  const throwingGetter = {};
  Object.defineProperty(throwingGetter, "value", {
    enumerable: true,
    get() {
      throw new Error("raw getter failure");
    },
  });
  assert.deepEqual(redactValueWithMetadata(throwingGetter), {
    value: REDACTION_LIMIT_PLACEHOLDER,
    redactions: 0,
    limited: true,
    limit: "redactionFailure",
  });

  const stringPolicy = createRedactionPolicy({ limits: { maxStringLength: 4 } });
  assert.equal(redactText("12345", stringPolicy), REDACTION_LIMIT_PLACEHOLDER);
});

test("policy construction rejects unsafe or unbounded configuration", () => {
  assert.throws(
    () => createRedactionPolicy({ piiPatterns: [/(?:)/u] }),
    /must not match an empty string/u,
  );
  assert.throws(
    () => createRedactionPolicy({ limits: { unknown: 10 } }),
    /Unknown redaction limit/u,
  );
  assert.throws(
    () => createRedactionPolicy({ secrets: [REDACTION_PLACEHOLDER] }),
    /conflicts with a redaction placeholder/u,
  );
  assert.throws(
    () => createRedactionPolicy({ piiPatterns: ["(a+)+$"] }),
    /unbounded quantifier|nested or ambiguous quantified group/u,
  );
  assert.throws(
    () => createRedactionPolicy({ secretPatterns: ["(a|aa)+$"] }),
    /unbounded quantifier|nested or ambiguous quantified group/u,
  );
  assert.throws(
    () => createRedactionPolicy({ secretPatterns: ["(a)\\1"] }),
    /backreferences/u,
  );
  assert.throws(
    () => createRedactionPolicy({ piiPatterns: ["a+a+$"] }),
    /unbounded quantifier/u,
  );
  assert.throws(
    () => createRedactionPolicy({ piiPatterns: [".*.*x"] }),
    /unbounded quantifier/u,
  );
  assert.throws(
    () => createRedactionPolicy({
      piiPatterns: ["[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}"],
    }),
    /unbounded quantifier/u,
  );
  assert.throws(
    () => createRedactionPolicy({ piiPatterns: ["a+$"] }),
    /unbounded quantifier/u,
  );
  assert.throws(
    () => createRedactionPolicy({ piiPatterns: ["a{1,4096}$"] }),
    /safe maximum/u,
  );
});

test("adversarial configurable patterns are rejected within a child-process deadline", () => {
  const moduleUrl = new URL("../../lib/observability/redaction.mjs", import.meta.url).href;
  for (const pattern of ["a+a+$", ".*.*x", "a+$", "a{1,4096}$"]) {
    const script = [
      `import { createRedactionPolicy, redactText } from ${JSON.stringify(moduleUrl)};`,
      "try {",
      `  const policy = createRedactionPolicy({ piiPatterns: [${JSON.stringify(pattern)}] });`,
      "  redactText(`${\"a\".repeat(50_000)}!`, policy);",
      "  process.stdout.write('accepted');",
      "} catch {",
      "  process.stdout.write('rejected');",
      "}",
    ].join("\n");
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      encoding: "utf8",
      timeout: 2_000,
    });
    assert.equal(result.error, undefined, `${pattern} exceeded the safety deadline`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "rejected");
  }
});

test("the default bounded email detector completes on maximum-size non-email input", () => {
  const moduleUrl = new URL("../../lib/observability/redaction.mjs", import.meta.url).href;
  const script = [
    `import { createOperationalRedactionPolicy, redactText } from ${JSON.stringify(moduleUrl)};`,
    "const policy = createOperationalRedactionPolicy();",
    "redactText('a'.repeat(262_144), policy);",
    "process.stdout.write('completed');",
  ].join("\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8",
    timeout: 2_000,
  });
  assert.equal(result.error, undefined, "default email detection exceeded the safety deadline");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "completed");
});

test("the exact legacy email engine is linear on adversarial maximum-size input", () => {
  const moduleUrl = new URL("../../lib/observability/redaction.mjs", import.meta.url).href;
  const script = [
    `import { createLegacyEvidenceV1RedactionPolicy, redactText } from ${JSON.stringify(moduleUrl)};`,
    "const policy = createLegacyEvidenceV1RedactionPolicy();",
    "redactText('a.'.repeat(131_000), policy);",
    "redactText(`${'a'.repeat(80_000)}@${'b'.repeat(80_000)}.${'c'.repeat(80_000)}`, policy);",
    "process.stdout.write('completed');",
  ].join("\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8",
    timeout: 2_000,
  });
  assert.equal(result.error, undefined, "legacy email compatibility exceeded the safety deadline");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "completed");
});

test("the bounded URL userinfo detector completes on maximum-size ambiguous input", () => {
  const moduleUrl = new URL("../../lib/observability/redaction.mjs", import.meta.url).href;
  const script = [
    `import { createOperationalRedactionPolicy, redactText } from ${JSON.stringify(moduleUrl)};`,
    "const policy = createOperationalRedactionPolicy();",
    "redactText(`https://user:${'a'.repeat(262_100)}/path`, policy);",
    "redactText(`https://user:${'a@'.repeat(120_000)}host.test/path`, policy);",
    "process.stdout.write('completed');",
  ].join("\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8",
    timeout: 2_000,
  });
  assert.equal(result.error, undefined, "default URL userinfo detection exceeded the safety deadline");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "completed");
});

test("operational policy redacts extended vendor tokens and command-line credentials", () => {
  const policy = createOperationalRedactionPolicy();
  // Credential-shaped values are assembled at runtime so the source tree never
  // contains a literal that a secret scanner would flag.
  const vendorTokens = [
    ["ASIA", "QW3RT7YU2IOPLASD"].join(""),
    ["ASIA", "QWERTYUIOPLKJHGF"].join(""),
    ["AIza", "Sy", "k".repeat(33)].join(""),
    ["npm", "_", "n".repeat(36)].join(""),
    ["hf", "_", "h".repeat(34)].join(""),
    ["rk", "_live_", "r".repeat(24)].join(""),
    ["rk", "_test_", "t".repeat(24)].join(""),
    ["SG", ".", "s".repeat(22), ".", "g".repeat(43)].join(""),
    ["gldt", "-", "d".repeat(24)].join(""),
    ["https://hooks.slack.com/", "services/", "T0000/B0000/", "w".repeat(24)].join(""),
  ];
  for (const token of vendorTokens) {
    assert.equal(redactText(token, policy), REDACTION_PLACEHOLDER, token.slice(0, 6));
    assert.equal(redactText(`value ${token} end`, policy), `value ${REDACTION_PLACEHOLDER} end`);
  }
  const spaced = ["mysql --password ", "hunter", "22 --host db"].join("");
  assert.equal(redactText(spaced, policy), `mysql --password ${REDACTION_PLACEHOLDER} --host db`);
  assert.equal(
    redactText(['cli --token "two ', 'words"'].join(""), policy),
    `cli --token ${REDACTION_PLACEHOLDER}`,
  );
  const curl = ["curl -u admin", ":", "s3cret https://example.test/"].join("");
  assert.equal(redactText(curl, policy), `curl -u ${REDACTION_PLACEHOLDER} https://example.test/`);
  for (const [input, expected] of [
    [["mysql --password ", "x"].join(""), `mysql --password ${REDACTION_PLACEHOLDER}`],
    [["vault --secret ", "s"].join(""), `vault --secret ${REDACTION_PLACEHOLDER}`],
    [['db --passwd "two ', 'words"'].join(""), `db --passwd ${REDACTION_PLACEHOLDER}`],
    [["deploy --token ", "abcdefgh"].join(""), `deploy --token ${REDACTION_PLACEHOLDER}`],
    [["deploy --api-key ", "12345678"].join(""), `deploy --api-key ${REDACTION_PLACEHOLDER}`],
    [["curl -s -u admin", ":", "1234 https://example.test/"].join(""), `curl -s -u ${REDACTION_PLACEHOLDER} https://example.test/`],
    [["CURL -u admin", ":", "secret https://example.test/"].join(""), `CURL -u ${REDACTION_PLACEHOLDER} https://example.test/`],
    [["lftp -u user", ":", "pw ftp.example.test"].join(""), `lftp -u ${REDACTION_PLACEHOLDER} ftp.example.test`],
    [["sftp -u user", ":", "pw host.example.test"].join(""), `sftp -u ${REDACTION_PLACEHOLDER} host.example.test`],
    [["ftp --user user", ":", "pw host.example.test"].join(""), `ftp --user ${REDACTION_PLACEHOLDER} host.example.test`],
  ]) {
    assert.equal(redactText(input, policy), expected, input.slice(0, 12));
  }
  const registryAuth = Buffer.from(["user", "pass"].join(":")).toString("base64");
  const dockerConfig = JSON.stringify({ auths: { "registry.test": { auth: registryAuth } } });
  assert.equal(
    redactText(dockerConfig, policy),
    `{"auths":{"registry.test":{"auth":"${REDACTION_PLACEHOLDER}"}}}`,
  );
  const helpersBefore = JSON.stringify({ credHelpers: { "gcr.io": "gcloud" }, legacy: { auth: registryAuth } });
  assert.doesNotMatch(redactText(helpersBefore, policy), new RegExp(registryAuth.replaceAll("+", "\\+"), "u"));
  const helpersAfter = JSON.stringify({ legacy: { auth: registryAuth }, credHelpers: { "gcr.io": "gcloud" } });
  assert.doesNotMatch(redactText(helpersAfter, policy), new RegExp(registryAuth.replaceAll("+", "\\+"), "u"));
});

test("extended detectors keep look-alike identifiers and options readable", () => {
  const policy = createOperationalRedactionPolicy();
  for (const benign of [
    "hf_hub_download",
    "ASIA trip report",
    "SG.config loaded",
    "npm_config_cache",
    "npm run test -- --pass",
    "--password-file secrets.txt",
    "--user alice",
    "tool -u origin",
    '{"auth":"required"}',
    "https://hooks.example.test/services/abcdefgh",
    "docker run -u 1000:1000 image",
    "pip install --user git+https://example.test/package",
    "use the --token flag",
    "pass --password <value> on the command line",
    "deploy --token $DEPLOY_TOKEN",
    'config {"auth": "bearerTokenAuthScheme"}',
    "ASIAPACIFICREGION012",
    "ASIA".padEnd(20, "Q"),
    ["curl -s -u admin", ":", "1234 https://example.test/"].join(""),
  ]) {
    assert.equal(redactText(benign, policy), benign, benign);
  }
});

test("built-in detectors do not count against the custom pattern limit", () => {
  const customPatterns = Array.from({ length: 60 }, (_, index) => ({
    name: `custom_${index}`,
    pattern: `CUSTOM${String(index).padStart(2, "0")}-[0-9]{4}`,
  }));
  const policy = createOperationalRedactionPolicy({ piiPatterns: customPatterns });
  assert.equal(redactText("CUSTOM07-1234", policy), REDACTION_PLACEHOLDER);
  assert.throws(
    () => createOperationalRedactionPolicy({
      piiPatterns: [...customPatterns, ...customPatterns.slice(0, 5).map((entry) => ({ ...entry, name: `${entry.name}_copy` }))],
    }),
    /maxPatterns/u,
  );
});

test("chunked presentation redaction keeps large payloads and fails loudly on an oversized value", async () => {
  const { redactValueInChunks, RedactionLimitError } = await import("../../lib/observability/redaction.mjs");
  const policy = createOperationalRedactionPolicy();
  const email = ["owner", "example.test"].join("@");
  const payload = {
    project: { project_name: "Large", owner: email },
    items: Array.from({ length: 3_000 }, (_, index) => ({ id: index, summary: `item ${index} ${email}`, tags: ["a", "b", "c"] })),
  };
  assert.equal(redactValueWithMetadata(payload, policy).limited, true, "fixture must exceed one global budget");
  const presented = redactValueInChunks(payload, policy);
  assert.equal(presented.project.project_name, "Large");
  assert.equal(presented.project.owner, REDACTION_PLACEHOLDER);
  assert.equal(presented.items.length, 3_000);
  assert.equal(presented.items[2_999].summary, `item 2999 ${REDACTION_PLACEHOLDER}`);
  assert.deepEqual(redactValueInChunks({ password: "x".repeat(10) }, policy), { password: REDACTION_PLACEHOLDER });
  assert.throws(
    () => redactValueInChunks({ huge: "x".repeat(300_000) }, policy),
    (error) => error instanceof RedactionLimitError && error.location === "$.huge",
  );
});

test("previously written operational_v2 policy sources stay verifiable after detector additions", async () => {
  const { assertTraceEvidencePolicySourceSafety } = await import("../../lib/lifecycle/output.mjs");
  const { createOperationalBaselineRedactionPolicy } = await import("../../lib/observability/redaction.mjs");
  const stored = JSON.parse(JSON.stringify(describeRedactionPolicy(createOperationalBaselineRedactionPolicy())));
  assert.doesNotThrow(() => assertTraceEvidencePolicySourceSafety(stored));
  const current = JSON.parse(JSON.stringify(describeRedactionPolicy(createOperationalRedactionPolicy())));
  assert.doesNotThrow(() => assertTraceEvidencePolicySourceSafety(current));
  assert.equal(current.detectors.length > stored.detectors.length, true);
  const historical = describeRedactionPolicy(createHistoricalOperationalEvidenceV1RedactionPolicy());
  assert.deepEqual(historical.detectors, stored.detectors);
});

test("extended detectors complete on maximum-size adversarial input", () => {
  const moduleUrl = new URL("../../lib/observability/redaction.mjs", import.meta.url).href;
  const script = [
    `import { createOperationalRedactionPolicy, redactText } from ${JSON.stringify(moduleUrl)};`,
    "const policy = createOperationalRedactionPolicy();",
    "redactText(' --password'.repeat(23_000), policy);",
    "redactText(' -u '.repeat(60_000), policy);",
    "redactText('\"auth\": \"'.repeat(25_000), policy);",
    "redactText('SG.' + 'a'.repeat(262_000), policy);",
    "process.stdout.write('completed');",
  ].join("\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8",
    timeout: 4_000,
  });
  assert.equal(result.error, undefined, "extended detection exceeded the safety deadline");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "completed");
});
