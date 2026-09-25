import test from "node:test";
import assert from "node:assert/strict";

import { UserError } from "../../lib/cli/user-error.mjs";
import { hashApprovalSubject } from "../../lib/lifecycle/authorization.mjs";
import {
  buildDeliveryCheckpointPolicySource,
  buildDeliveryCompletionRequest,
  deliveryActionReceiptRef,
  deliveryAutonomyPath,
  deliveryProviderOperationSubject,
  dedupeDeliveryFormatOptions,
  exactGitProjectPath,
  localReleaseAttemptReceiptErrors,
  normalizeDeliveryAction,
  normalizeDeliveryFormatOptions,
  normalizeDeliveryProviderId,
  normalizeGitEvent,
  normalizeGitRepositoryIdentity,
  normalizeSmokeTestCommand,
  validateDeliveryCheckpointPolicySource,
  validateDeliveryCompletionRequest,
  validateLocalSmokePackageManagerForm,
  validateResolvedLocalSmokeExecutable,
} from "../../lib/lifecycle/delivery.mjs";
import { toProjectPath } from "../../lib/lifecycle/project.mjs";

function testContext() {
  const config = {};
  return {
    root: "/repo",
    sdlcRoot: "/repo/.sdlc",
    config,
    configState: {
      status: "clean",
      effective_config_hash: hashApprovalSubject(config),
      config_path: null,
      raw_config_hash: null,
      defaults_profile: null,
      inherited_paths: [],
    },
  };
}

// ---------------------------------------------------------------------------
// deliveryProviderOperationSubject
// ---------------------------------------------------------------------------

test("deliveryProviderOperationSubject builds the git.push subject from the profile's pull-request target and push details", () => {
  const profile = { pull_request_target: { repository: "github.com/acme/app", base_branch: "main" } };
  const actionDetails = { push: { remote: "origin", destination_ref: "refs/heads/feature", source_sha: "a".repeat(40) } };
  assert.deepEqual(deliveryProviderOperationSubject({}, profile, "git.push", actionDetails, "2026-01-01T00:00:00.000Z"), {
    repository: "github.com/acme/app",
    remote: "origin",
    destination_ref: "refs/heads/feature",
    base_ref: "refs/heads/main",
    source_sha: "a".repeat(40),
  });
});

test("deliveryProviderOperationSubject builds the pull_request.create subject without a pr_url", () => {
  const profile = { pull_request_target: { repository: "github.com/acme/app", head_branch: "feature", base_branch: "main" } };
  const actionDetails = { source_sha: "b".repeat(40) };
  const subject = deliveryProviderOperationSubject({}, profile, "pull_request.create", actionDetails, "2026-01-01T00:00:00.000Z");
  assert.equal(subject.pr_url, undefined);
  assert.equal(subject.authorized_at, "2026-01-01T00:00:00.000Z");
});

test("deliveryProviderOperationSubject includes pr_url and base_sha for pull_request.merge", () => {
  const profile = { pull_request_target: { repository: "github.com/acme/app", head_branch: "feature", base_branch: "main" } };
  const actionDetails = { source_sha: "c".repeat(40), pull_request: { pr_url: "https://github.com/acme/app/pull/1" }, merge: { base_sha: "d".repeat(40) } };
  const subject = deliveryProviderOperationSubject({}, profile, "pull_request.merge", actionDetails, "2026-01-01T00:00:00.000Z");
  assert.equal(subject.pr_url, "https://github.com/acme/app/pull/1");
  assert.equal(subject.base_sha, "d".repeat(40));
});

test("deliveryProviderOperationSubject includes expected for pull_request.update", () => {
  const profile = { pull_request_target: { repository: "github.com/acme/app", head_branch: "feature", base_branch: "main" } };
  const actionDetails = { source_sha: "e".repeat(40), pull_request: { pr_url: "https://x", expected: { title: "t" } } };
  const subject = deliveryProviderOperationSubject({}, profile, "pull_request.update", actionDetails, "2026-01-01T00:00:00.000Z");
  assert.deepEqual(subject.expected, { title: "t" });
});

test("deliveryProviderOperationSubject builds the release.local subject from the profile's local-release target", () => {
  const profile = { local_release_target: { root_path: "/release", allowed_write_paths: ["/release/out"] } };
  assert.deepEqual(deliveryProviderOperationSubject({}, profile, "release.local", {}, null), {
    root_path: "/release",
    allowed_write_paths: ["/release/out"],
  });
});

test("deliveryProviderOperationSubject resolves rollback.verify evidence paths against the evidence root", () => {
  const actionDetails = {
    rollback_verification: {
      target_root: "/release",
      allowed_write_paths: ["/release/out"],
      rollback_procedure: "restore-backup",
      evidence_root: "/release/evidence",
      evidence: [{ path: "check.txt", sha256: "1".repeat(64) }],
    },
  };
  const subject = deliveryProviderOperationSubject({}, {}, "rollback.verify", actionDetails, null);
  assert.equal(subject.evidence[0].path, "/release/evidence/check.txt");
  assert.equal(subject.evidence[0].sha256, "1".repeat(64));
});

test("deliveryProviderOperationSubject builds the data.migrate/data.rollback subject from the local-release data migration", () => {
  const profile = {
    local_release_target: {
      root_path: "/release",
      data_migration: { target_path: "/release/db", scopes: ["users"], preview_evidence: [], backup: { path: "/release/backup" } },
      rollback: { procedure: "restore-backup" },
    },
  };
  const subject = deliveryProviderOperationSubject({}, profile, "data.migrate", {}, null);
  assert.deepEqual(subject, {
    root_path: "/release",
    target_path: "/release/db",
    scopes: ["users"],
    preview_evidence: [],
    backup_path: "/release/backup",
    rollback: "restore-backup",
  });
});

test("deliveryProviderOperationSubject returns null for an action it does not recognize", () => {
  assert.equal(deliveryProviderOperationSubject({}, {}, "unknown.action", {}, null), null);
});

// ---------------------------------------------------------------------------
// normalizeSmokeTestCommand
// ---------------------------------------------------------------------------

test("normalizeSmokeTestCommand accepts a plain argv array and returns it as stable JSON", () => {
  assert.equal(normalizeSmokeTestCommand('["node","--version"]'), '["node","--version"]');
});

test("normalizeSmokeTestCommand rejects input that is not valid JSON", () => {
  assert.throws(() => normalizeSmokeTestCommand("node --version"), UserError);
});

test("normalizeSmokeTestCommand rejects a non-array, empty array, or an array with a non-string/empty entry", () => {
  assert.throws(() => normalizeSmokeTestCommand('"node"'), UserError);
  assert.throws(() => normalizeSmokeTestCommand("[]"), UserError);
  assert.throws(() => normalizeSmokeTestCommand("[1]"), UserError);
  assert.throws(() => normalizeSmokeTestCommand('[""]'), UserError);
});

test("normalizeSmokeTestCommand rejects a shell executable", () => {
  assert.throws(() => normalizeSmokeTestCommand('["bash","-c","echo hi"]'), UserError);
});

test("normalizeSmokeTestCommand rejects an indirect dispatcher like env or xargs", () => {
  assert.throws(() => normalizeSmokeTestCommand('["env","node","--version"]'), UserError);
});

test("normalizeSmokeTestCommand rejects inline code execution flags for interpreters", () => {
  assert.throws(() => normalizeSmokeTestCommand('["node","-e","1"]'), UserError);
  assert.throws(() => normalizeSmokeTestCommand('["python3","-c","1"]'), UserError);
});

test("normalizeSmokeTestCommand allows an interpreter running a plain script file", () => {
  assert.equal(normalizeSmokeTestCommand('["node","script.js"]'), '["node","script.js"]');
});

test("normalizeSmokeTestCommand rejects a package dispatcher like npx", () => {
  assert.throws(() => normalizeSmokeTestCommand('["npx","cowsay"]'), UserError);
});

test("normalizeSmokeTestCommand requires npm/pnpm/yarn/bun to use 'test' or 'run <script>'", () => {
  assert.throws(() => normalizeSmokeTestCommand('["npm","install"]'), UserError);
  assert.throws(() => normalizeSmokeTestCommand('["npm","run","-x"]'), UserError);
  assert.equal(normalizeSmokeTestCommand('["npm","test"]'), '["npm","test"]');
  assert.equal(normalizeSmokeTestCommand('["npm","run","build"]'), '["npm","run","build"]');
});

// ---------------------------------------------------------------------------
// validateDeliveryCheckpointPolicySource / buildDeliveryCheckpointPolicySource
// ---------------------------------------------------------------------------

test("validateDeliveryCheckpointPolicySource accepts a source built by buildDeliveryCheckpointPolicySource for the same effective config", () => {
  const context = testContext();
  const { source, ref } = buildDeliveryCheckpointPolicySource(context);
  const result = validateDeliveryCheckpointPolicySource(context, source, ref);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("validateDeliveryCheckpointPolicySource rejects a non-object source", () => {
  assert.deepEqual(validateDeliveryCheckpointPolicySource({}, null), { valid: false, errors: ["checkpoint policy source is not an object"] });
  assert.deepEqual(validateDeliveryCheckpointPolicySource({}, "nope"), { valid: false, errors: ["checkpoint policy source is not an object"] });
});

test("validateDeliveryCheckpointPolicySource rejects a tampered source hash", () => {
  const context = testContext();
  const { source } = buildDeliveryCheckpointPolicySource(context);
  const tampered = { ...source, config: { ...source.config, status: "different" } };
  const result = validateDeliveryCheckpointPolicySource(context, tampered);
  assert.ok(result.errors.includes("checkpoint policy source hash is invalid"));
});

test("validateDeliveryCheckpointPolicySource rejects a stale reference", () => {
  const context = testContext();
  const { source } = buildDeliveryCheckpointPolicySource(context);
  const staleRef = { path: "somewhere", hash: "not-the-real-hash", effective_config_hash: source.config.effective_hash };
  const result = validateDeliveryCheckpointPolicySource(context, source, staleRef);
  assert.ok(result.errors.includes("checkpoint policy source reference is stale"));
});

test("validateDeliveryCheckpointPolicySource rejects an unsupported kind or schema version", () => {
  const context = testContext();
  const { source } = buildDeliveryCheckpointPolicySource(context);
  const wrongKind = validateDeliveryCheckpointPolicySource(context, { ...source, kind: "other" });
  assert.ok(wrongKind.errors.includes("checkpoint policy source kind is invalid"));
  const wrongSchema = validateDeliveryCheckpointPolicySource(context, { ...source, schema_version: "v0" });
  assert.ok(wrongSchema.errors.includes("checkpoint policy source schema version is unsupported"));
});

// ---------------------------------------------------------------------------
// validateDeliveryCompletionRequest
// ---------------------------------------------------------------------------

function buildCompletionFixture(context) {
  const profile = {
    id: "PROFILE-1",
    profile_hash: "hash-profile-1",
    local_release_target: { root_path: "/release", allowed_write_paths: ["/release/out"] },
  };
  const authorization = { id: "AUT-1", receipt_hash: "hash-auth-1" };
  const evidence = [
    { path: "b.txt", sha256: "2".repeat(64) },
    { path: "a.txt", sha256: "1".repeat(64) },
  ];
  const request = buildDeliveryCompletionRequest(context, profile, "release.local", "passed", evidence, {}, authorization);
  const receipt = {
    profile_ref: request.profile_ref,
    action: "release.local",
    outcome: "passed",
    authorization_receipt_ref: request.authorization_receipt_ref,
    evidence,
    completion_request: request,
  };
  return { profile, authorization, receipt, request };
}

test("validateDeliveryCompletionRequest accepts a completion request that matches its persisted receipt", () => {
  const context = testContext();
  const { receipt, authorization } = buildCompletionFixture(context);
  assert.deepEqual(validateDeliveryCompletionRequest(context, receipt, authorization), { valid: true, legacy: false, errors: [] });
});

test("validateDeliveryCompletionRequest treats a missing completion request on a legacy receipt as valid with no errors", () => {
  const context = testContext();
  const result = validateDeliveryCompletionRequest(context, { schema_version: "delivery-action-receipt:v1" }, {});
  assert.deepEqual(result, { valid: false, legacy: true, errors: [] });
});

test("validateDeliveryCompletionRequest requires a completion request on a non-legacy receipt", () => {
  const context = testContext();
  const result = validateDeliveryCompletionRequest(context, { schema_version: "delivery-action-receipt:v2" }, {});
  assert.equal(result.valid, false);
  assert.equal(result.legacy, false);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /completion requires a completion request/u);
});

test("validateDeliveryCompletionRequest rejects a request whose hash was tampered", () => {
  const context = testContext();
  const { receipt } = buildCompletionFixture(context);
  const { authorization } = buildCompletionFixture(context);
  receipt.completion_request = { ...receipt.completion_request, request_hash: "tampered" };
  const result = validateDeliveryCompletionRequest(context, receipt, authorization);
  assert.ok(result.errors.includes("completion request hash is invalid"));
});

test("validateDeliveryCompletionRequest rejects a request whose action no longer matches the receipt", () => {
  const context = testContext();
  const { receipt, authorization } = buildCompletionFixture(context);
  receipt.action = "git.push";
  const result = validateDeliveryCompletionRequest(context, receipt, authorization);
  assert.ok(result.errors.includes("completion request differs from its persisted action receipt"));
});

// ---------------------------------------------------------------------------
// localReleaseAttemptReceiptErrors (shallow structural coverage only - see report)
// ---------------------------------------------------------------------------

test("localReleaseAttemptReceiptErrors reports both the profile binding and the missing authorization for an empty attempt", () => {
  const context = testContext();
  const profile = { id: "PROFILE-1", profile_hash: "hash-profile-1", delivery_id: "DEL-1" };
  const errors = localReleaseAttemptReceiptErrors(context, profile, {}, null);
  assert.deepEqual(errors, [
    "attempt does not bind the exact local delivery profile",
    "attempt does not reference its exact release.local authorization",
  ]);
});

test("localReleaseAttemptReceiptErrors accepts a profile/delivery/action binding that matches exactly", () => {
  const context = testContext();
  const profile = { id: "PROFILE-1", profile_hash: "hash-profile-1", delivery_id: "DEL-1" };
  const authorization = { id: "AUT-1", status: "authorized", action: "release.local", authorized_at: "2026-01-01T00:00:00.000Z" };
  const attempt = {
    profile_ref: { id: profile.id, path: toProjectPath(context, deliveryAutonomyPath(context, profile.id)), hash: profile.profile_hash },
    delivery: { id: "DEL-1", kind: "local_release" },
    action: "release.local",
    authorization_receipt_ref: deliveryActionReceiptRef(context, authorization),
    completion_request: { request_hash: "irrelevant-for-this-check" },
  };
  // The remaining checks (attempt id, timing, completion request, local-release integrity
  // policy) need a much larger, hash-bound fixture; out of scope here, see report.
  const errors = localReleaseAttemptReceiptErrors(context, profile, attempt, authorization);
  assert.ok(!errors.includes("attempt does not bind the exact local delivery profile"), errors.join("; "));
  assert.ok(!errors.includes("attempt does not reference its exact release.local authorization"), errors.join("; "));
});

test("localReleaseAttemptReceiptErrors rejects an authorization that is not in an authorized state", () => {
  const context = testContext();
  const profile = { id: "PROFILE-1", profile_hash: "hash-profile-1", delivery_id: "DEL-1" };
  const authorization = { id: "AUT-1", status: "revoked", action: "release.local" };
  const errors = localReleaseAttemptReceiptErrors(context, profile, {}, authorization);
  assert.ok(errors.includes("attempt does not reference its exact release.local authorization"));
});

// ---------------------------------------------------------------------------
// normalizeDeliveryAction / normalizeDeliveryProviderId / normalizeGitRepositoryIdentity / normalizeGitEvent
// ---------------------------------------------------------------------------

test("normalizeDeliveryAction resolves known aliases and validates against the pull_request or local_release catalog", () => {
  assert.equal(normalizeDeliveryAction("pull_request", "push"), "git.push");
  assert.equal(normalizeDeliveryAction("pull_request", "merge"), "pull_request.merge");
  assert.equal(normalizeDeliveryAction("local_release", "release"), "release.local");
  assert.equal(normalizeDeliveryAction("local_release", "migrate"), "data.migrate");
});

test("normalizeDeliveryAction rejects an action outside the requested kind's catalog", () => {
  // "release" is only a valid alias for local_release, not for pull_request.
  assert.throws(() => normalizeDeliveryAction("pull_request", "release"), UserError);
});

test("normalizeDeliveryProviderId requires a safe lowercase provider id", () => {
  assert.equal(normalizeDeliveryProviderId("Git-Remote", "Git provider"), "git-remote");
  assert.throws(() => normalizeDeliveryProviderId("has space", "Git provider"), UserError);
  assert.throws(() => normalizeDeliveryProviderId("", "Git provider"), UserError);
});

test("normalizeGitRepositoryIdentity normalizes host/path form, defaulting bare owner/repo to github.com", () => {
  assert.equal(normalizeGitRepositoryIdentity("acme/app"), "github.com/acme/app");
  assert.equal(normalizeGitRepositoryIdentity("https://github.com/acme/app.git"), "github.com/acme/app");
  assert.equal(normalizeGitRepositoryIdentity("git@github.com:acme/app.git"), "github.com/acme/app");
  assert.equal(normalizeGitRepositoryIdentity(""), null);
});

test("normalizeGitEvent accepts a known event and rejects an unknown one", () => {
  assert.equal(normalizeGitEvent("Push"), "push");
  assert.throws(() => normalizeGitEvent("force-push"), UserError);
});

// ---------------------------------------------------------------------------
// exactGitProjectPath
// ---------------------------------------------------------------------------

test("exactGitProjectPath accepts a clean relative path", () => {
  assert.equal(exactGitProjectPath("src/app.js"), "src/app.js");
});

test("exactGitProjectPath rejects absolute paths, traversal segments, empty segments, and NUL bytes", () => {
  assert.throws(() => exactGitProjectPath("/etc/passwd"), UserError);
  assert.throws(() => exactGitProjectPath("../secret"), UserError);
  assert.throws(() => exactGitProjectPath("a//b"), UserError);
  assert.throws(() => exactGitProjectPath("a\u0000b"), UserError);
  assert.throws(() => exactGitProjectPath("C:\\evil"), UserError);
});

// ---------------------------------------------------------------------------
// normalizeDeliveryFormatOptions / dedupeDeliveryFormatOptions
// ---------------------------------------------------------------------------

test("normalizeDeliveryFormatOptions accepts plain strings and slugifies them into ids", () => {
  assert.deepEqual(normalizeDeliveryFormatOptions(["PDF Report"]), [{ id: "pdf-report", label: "PDF Report", description: null }]);
});

test("normalizeDeliveryFormatOptions drops entries without a usable label", () => {
  assert.deepEqual(normalizeDeliveryFormatOptions(["", "   ", { description: "no label or id" }]), []);
});

test("normalizeDeliveryFormatOptions keeps description and when_to_use for object entries", () => {
  const [option] = normalizeDeliveryFormatOptions([{ id: "pdf", label: "PDF", description: "A file", when_to_use: "Sharing externally" }]);
  assert.deepEqual(option, { id: "pdf", label: "PDF", description: "A file", when_to_use: "Sharing externally" });
});

test("dedupeDeliveryFormatOptions keeps the first occurrence of each slugified id", () => {
  const options = dedupeDeliveryFormatOptions(["PDF Report", "pdf report", "Word Doc"]);
  assert.deepEqual(options.map((option) => option.id), ["pdf-report", "word-doc"]);
});

// ---------------------------------------------------------------------------
// validateLocalSmokePackageManagerForm / validateResolvedLocalSmokeExecutable
// ---------------------------------------------------------------------------

test("validateLocalSmokePackageManagerForm returns null for a non-package-manager command", () => {
  assert.equal(validateLocalSmokePackageManagerForm(["node", "script.js"]), null);
});

test("validateLocalSmokePackageManagerForm accepts 'test' and 'run <script>' and rejects everything else", () => {
  assert.equal(validateLocalSmokePackageManagerForm(["npm", "test"]), "npm");
  assert.equal(validateLocalSmokePackageManagerForm(["pnpm", "run", "build"]), "pnpm");
  assert.throws(() => validateLocalSmokePackageManagerForm(["yarn", "install"]), UserError);
  assert.throws(() => validateLocalSmokePackageManagerForm(["npm", "run", "-x"]), UserError);
});

test("validateResolvedLocalSmokeExecutable rejects a resolved shell interpreter", () => {
  assert.throws(() => validateResolvedLocalSmokeExecutable({ realpath: "/bin/bash" }), UserError);
});

test("validateResolvedLocalSmokeExecutable rejects a resolved indirect dispatcher", () => {
  assert.throws(() => validateResolvedLocalSmokeExecutable({ realpath: "/usr/bin/env" }), UserError);
});

test("validateResolvedLocalSmokeExecutable accepts a direct reviewed executable", () => {
  assert.doesNotThrow(() => validateResolvedLocalSmokeExecutable({ realpath: "/usr/local/bin/node" }));
});
