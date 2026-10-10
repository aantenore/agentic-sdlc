import "./helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { computeStableHash } from "../lib/canonical.mjs";
import { validateAgainstSchema } from "../lib/json-schema-validator.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repoRoot, "bin", "agentic-sdlc.mjs");
const sourceEmail = "former@example.invalid";
const targetEmail = "current@example.test";

test("migration identity CLI is dry-run-first, rebuilds derived state, and is idempotent", (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "identity-migration-cli-"));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  git(project, "init");
  git(project, "config", "user.name", "Former User");
  git(project, "config", "user.email", sourceEmail);
  run(
    project,
    "init",
    "--project-id",
    "identity-fixture",
    "--project-name",
    `Identity Fixture ${sourceEmail}`,
    "--run-id",
    sourceEmail,
  );

  const projectFile = path.join(project, ".sdlc", "project.json");
  const bootstrapManifestFile = path.join(project, ".sdlc", "bootstrap-manifest.json");
  const bootstrapJournalFile = path.join(project, ".sdlc", "bootstrap-journal.json");
  const collisionFile = path.join(project, ".sdlc", "identity-collision.json");
  // Markdown migration is intentionally outside the identity workflow. Remove
  // the generated display name from that separate surface so this regression
  // isolates JSON identity lineage and the immutable bootstrap manifest.
  fs.writeFileSync(path.join(project, ".sdlc", "README.md"), "# Identity Fixture\n");
  const bootstrapManifestBefore = fs.readFileSync(bootstrapManifestFile, "utf8");
  const parsedBootstrapManifestBefore = JSON.parse(bootstrapManifestBefore);
  const { manifest_hash: bootstrapManifestHashBefore, ...bootstrapManifestSubjectBefore } =
    parsedBootstrapManifestBefore;
  assert.equal(bootstrapManifestHashBefore, computeStableHash(bootstrapManifestSubjectBefore));
  assert.equal(Object.hasOwn(parsedBootstrapManifestBefore, "project"), false);
  assert.equal(Object.hasOwn(parsedBootstrapManifestBefore.audit, "git"), false);
  assert.equal(Object.hasOwn(parsedBootstrapManifestBefore.audit, "run"), false);
  assert.equal(bootstrapManifestBefore.includes(sourceEmail), false);
  assert.equal(
    validateAgainstSchema(parsedBootstrapManifestBefore, "project-bootstrap-manifest.schema.json", {
      schemaDir: path.join(repoRoot, "schemas"),
    }).valid,
    true,
  );
  const bootstrapJournalBefore = fs.readFileSync(bootstrapJournalFile, "utf8");
  const parsedBootstrapJournalBefore = JSON.parse(bootstrapJournalBefore);
  assert.equal(bootstrapJournalBefore.includes(sourceEmail), false);
  assert.equal(Object.hasOwn(parsedBootstrapJournalBefore.request, "project_id"), false);
  assert.equal(Object.hasOwn(parsedBootstrapJournalBefore.request, "project_name"), false);
  assert.equal(
    parsedBootstrapJournalBefore.request.initial_project_identity_sha256,
    computeStableHash({
      project_id: "identity-fixture",
      project_name: `Identity Fixture ${sourceEmail}`,
    }),
  );
  assert.equal(
    validateAgainstSchema(parsedBootstrapJournalBefore, "project-bootstrap-journal.schema.json", {
      schemaDir: path.join(repoRoot, "schemas"),
    }).valid,
    true,
  );
  assert.equal(Object.hasOwn(parsedBootstrapJournalBefore.completed_manifest_ref, "hash"), false);
  assert.equal(
    parsedBootstrapJournalBefore.completed_manifest_ref.hash_algorithm,
    "sha256:stable-json:v1",
  );
  const ambiguousManifestReferenceJournal = structuredClone(parsedBootstrapJournalBefore);
  ambiguousManifestReferenceJournal.completed_manifest_ref.hash =
    ambiguousManifestReferenceJournal.completed_manifest_ref.manifest_hash;
  delete ambiguousManifestReferenceJournal.completed_manifest_ref.manifest_hash;
  assert.equal(
    validateAgainstSchema(
      ambiguousManifestReferenceJournal,
      "project-bootstrap-journal.schema.json",
      { schemaDir: path.join(repoRoot, "schemas") },
    ).valid,
    false,
  );
  fs.writeFileSync(collisionFile, `${JSON.stringify({
    exact: sourceEmail,
    near_collision: `not${sourceEmail}`,
  }, null, 2)}\n`);
  const before = fs.readFileSync(projectFile, "utf8");
  const dryRun = runJson(project,
    "migration", "identity",
    "--from-email", sourceEmail,
    "--to-email", targetEmail,
    "--to-name", "Current User",
  );
  assert.equal(dryRun.status, "ready");
  assert.match(dryRun.plan_hash, /^[a-f0-9]{64}$/u);
  assert.ok(dryRun.source_occurrences_before > 0);
  assert.equal(fs.readFileSync(projectFile, "utf8"), before);

  const applied = runJson(project,
    "migration", "identity",
    "--from-email", sourceEmail,
    "--to-email", targetEmail,
    "--to-name", "Current User",
    "--apply",
    "--plan-hash", dryRun.plan_hash,
  );
  assert.equal(applied.status, "applied");
  assert.equal(containsIdentityToken(readTree(path.join(project, ".sdlc")), sourceEmail), false);
  assert.equal(JSON.parse(fs.readFileSync(projectFile, "utf8")).audit.git.user.email, targetEmail);
  assert.equal(fs.readFileSync(bootstrapManifestFile, "utf8"), bootstrapManifestBefore);
  assert.equal(fs.readFileSync(bootstrapJournalFile, "utf8"), bootstrapJournalBefore);
  const parsedBootstrapManifestAfter = JSON.parse(fs.readFileSync(bootstrapManifestFile, "utf8"));
  const { manifest_hash: bootstrapManifestHashAfter, ...bootstrapManifestSubjectAfter } =
    parsedBootstrapManifestAfter;
  assert.equal(bootstrapManifestHashAfter, computeStableHash(bootstrapManifestSubjectAfter));
  assert.equal(
    validateAgainstSchema(parsedBootstrapManifestAfter, "project-bootstrap-manifest.schema.json", {
      schemaDir: path.join(repoRoot, "schemas"),
    }).valid,
    true,
  );
  assert.equal(
    validateAgainstSchema(
      JSON.parse(fs.readFileSync(bootstrapJournalFile, "utf8")),
      "project-bootstrap-journal.schema.json",
      { schemaDir: path.join(repoRoot, "schemas") },
    ).valid,
    true,
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(collisionFile, "utf8")), {
    exact: targetEmail,
    near_collision: `not${sourceEmail}`,
  });
  assert.equal(runJson(project, "cache", "status").valid, true);
  assert.equal(fs.existsSync(path.join(project, ".sdlc", "indexes", "kb-index.json")), true);

  const repeated = runJson(project,
    "migration", "identity",
    "--from-email", sourceEmail,
    "--to-email", targetEmail,
    "--apply",
  );
  assert.equal(repeated.status, "already_applied");
  assert.equal(repeated.changed_files.length, 0);
  assert.equal(Object.hasOwn(repeated, "_internal"), false);
  const repeatedKeys = collectKeys(repeated);
  for (const internalKey of ["_internal", "sourceEmail", "root", "sdlcRoot", "writes"]) {
    assert.equal(repeatedKeys.has(internalKey), false, `idempotent JSON leaked key ${internalKey}`);
  }
  const repeatedJson = JSON.stringify(repeated);
  for (const secret of [sourceEmail, project, "_internal", "sourceEmail", "sdlcRoot"]) {
    assert.equal(repeatedJson.includes(secret), false, `idempotent JSON leaked ${secret}`);
  }

  const recovery = runJson(
    project,
    "migration", "identity", "--recover",
    "--recovery-nonce", "0".repeat(24),
    "--plan-hash", "0".repeat(64),
  );
  assert.equal(recovery.status, "no_recovery_needed");
  assert.equal(recovery.recovered, false);
});

test("migration identity fails closed on self-hashed bootstrap journal reference tampering", (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "identity-migration-bootstrap-tamper-"));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  git(project, "init");
  git(project, "config", "user.name", "Former User");
  git(project, "config", "user.email", sourceEmail);
  run(
    project,
    "init",
    "--project-id",
    "identity-bootstrap-tamper",
    "--project-name",
    "Identity Bootstrap Tamper",
  );

  const sdlcRoot = path.join(project, ".sdlc");
  const journalFile = path.join(sdlcRoot, "bootstrap-journal.json");
  const journal = JSON.parse(fs.readFileSync(journalFile, "utf8"));
  journal.completed_manifest_ref.manifest_hash = "0".repeat(64);
  delete journal.journal_hash;
  journal.journal_hash = computeStableHash(journal);
  fs.writeFileSync(journalFile, `${JSON.stringify(journal, null, 2)}\n`);
  const treeBefore = readTree(sdlcRoot);

  const failure = runFailure(
    project,
    "migration", "identity",
    "--from-email", sourceEmail,
    "--to-email", targetEmail,
  );
  assert.match(
    failure,
    /bootstrap journal does not bind the exact immutable manifest/u,
  );
  assert.equal(readTree(sdlcRoot), treeBefore);
  assert.equal(fs.existsSync(path.join(sdlcRoot, "migrations", "identity")), false);
});

test("migration identity CLI requires the reviewed plan hash and rejects snapshot drift", (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "identity-migration-plan-binding-"));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  git(project, "init");
  git(project, "config", "user.name", "Former User");
  git(project, "config", "user.email", sourceEmail);
  run(project, "init", "--project-id", "identity-plan-binding", "--project-name", "Identity Plan Binding");

  const preview = runJson(project,
    "migration", "identity",
    "--from-email", sourceEmail,
    "--to-email", targetEmail,
  );
  assert.equal(preview.status, "ready");
  assert.match(preview.plan_hash, /^[a-f0-9]{64}$/u);

  const missingHash = runFailure(project,
    "migration", "identity",
    "--from-email", sourceEmail,
    "--to-email", targetEmail,
    "--apply",
  );
  assert.match(missingHash, /requires --plan-hash/u);

  const latePath = path.join(project, ".sdlc", "late.json");
  fs.writeFileSync(latePath, `${JSON.stringify({ actor: { email: sourceEmail } }, null, 2)}\n`);
  const drift = runFailure(project,
    "migration", "identity",
    "--from-email", sourceEmail,
    "--to-email", targetEmail,
    "--apply",
    "--plan-hash", preview.plan_hash,
  );
  assert.match(drift, /plan changed after preview/u);
  assert.equal(JSON.parse(fs.readFileSync(latePath, "utf8")).actor.email, sourceEmail);
  assert.equal(fs.existsSync(path.join(project, ".sdlc", "migrations")), false);
});

test("migration identity CLI recovers only the prepared exact physical mutation set", (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "identity-migration-cli-recovery-"));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  run(project, "init", "--project-id", "identity-recovery", "--project-name", "Identity Recovery");

  const liveRoot = path.join(project, ".sdlc");
  const before = readTree(liveRoot);
  const nonce = "a".repeat(24);
  const planHash = "b".repeat(64);
  const transactionName = `.sdlc-identity-migration-txn-${nonce}`;
  const journalName = `.sdlc-identity-migration-journal-${nonce}.json`;
  const transactionRoot = path.join(project, transactionName);
  fs.mkdirSync(transactionRoot, { recursive: true });
  fs.cpSync(liveRoot, path.join(transactionRoot, "original"), {
    recursive: true,
    errorOnExist: true,
  });
  fs.writeFileSync(path.join(liveRoot, "project.json"), `${JSON.stringify({ interrupted: true })}\n`);
  const lock = {
    schema_version: "identity-migration-lock:v1",
    migration_id: `MIG-IDENTITY-${"c".repeat(12)}-${"d".repeat(12)}`,
    plan_hash: planHash,
    pid: 2_147_483_647,
    host: os.hostname(),
    nonce,
    transaction_root: transactionName,
    journal_path: journalName,
    phase: "acquired",
    generation: 0,
    created_at: "2026-07-18T10:00:00.000Z",
  };
  fs.writeFileSync(
    path.join(project, ".sdlc-identity-migration.lock"),
    `${JSON.stringify(lock, null, 2)}\n`,
  );
  const journal = {
    ...lock,
    phase: "shadow_activated",
    generation: 1,
    updated_at: "2026-07-18T10:01:00.000Z",
  };
  journal.journal_hash = computeStableHash(journal);
  fs.writeFileSync(path.join(project, journalName), `${JSON.stringify(journal, null, 2)}\n`);

  const recovered = runJson(
    project,
    "migration", "identity", "--recover",
    "--recovery-nonce", nonce,
    "--plan-hash", planHash,
  );
  assert.equal(recovered.status, "rolled_back");
  assert.deepEqual(readTree(liveRoot), before);
  assert.equal(fs.existsSync(transactionRoot), false);
  assert.equal(fs.existsSync(path.join(project, journalName)), false);
  assert.equal(fs.existsSync(path.join(project, ".sdlc-identity-migration.lock")), false);
  assert.deepEqual(
    fs.readdirSync(project).filter((name) => name.startsWith(".sdlc-identity-migration-recovery-")),
    [],
  );
});

test("identity migration lock blocks every non-recovery CLI command before project context reads", (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "identity-migration-cli-lock-"));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  fs.writeFileSync(path.join(project, ".sdlc-identity-migration.lock"), "incomplete-but-present\n");

  const blocked = runFailure(project, "doctor");
  assert.match(blocked, /identity migration transaction is active or interrupted/u);
  const missingRecoveryBinding = runFailure(project, "migration", "identity", "--recover");
  assert.match(missingRecoveryBinding, /requires both --recovery-nonce and --plan-hash/u);
});

function run(project, ...args) {
  return childProcess.execFileSync(process.execPath, [cli, ...args, "--root", project], {
    cwd: project,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runJson(project, ...args) {
  return JSON.parse(run(project, ...args, "--json"));
}

function runFailure(project, ...args) {
  try {
    run(project, ...args);
  } catch (error) {
    return `${error.message}\n${error.stderr || ""}`;
  }
  assert.fail("Expected the CLI command to fail.");
}

function git(project, ...args) {
  childProcess.execFileSync("git", args, { cwd: project, stdio: "ignore" });
}

function readTree(root) {
  const values = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(filePath);
      else values.push(fs.readFileSync(filePath, "utf8"));
    }
  };
  visit(root);
  return values.join("\n");
}

function containsIdentityToken(value, identity) {
  const emailTokenCharacter = "A-Z0-9.!#$%&'*+/=?^_`{|}~@-";
  const escaped = identity.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?<![${emailTokenCharacter}])${escaped}(?![${emailTokenCharacter}])`, "iu").test(value);
}

function collectKeys(value, keys = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectKeys(item, keys));
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      keys.add(key);
      collectKeys(item, keys);
    }
  }
  return keys;
}
