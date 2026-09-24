import assert from "node:assert/strict";
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildAuthorizationUsageReceipt,
  buildHostApprovalReceipt,
  computeAuthorizationHash,
  computeAuthorizationSubjectHash,
  createAuthorizationRevocation,
  createAuthorizationSnapshot,
  validateAuthorizationRevocationIntegrity,
  validateAuthorizationSnapshotIntegrity,
  validateAuthorizationUsageReceipt,
} from "../../lib/authorization-receipts.mjs";
import { computeStableHash, omitKeys } from "../../lib/canonical.mjs";
import {
  applyIdentityMigration,
  planIdentityMigration,
  prepareIdentityMigrationRecovery,
  publicIdentityMigrationPlan,
  recoverIdentityMigration,
  validateIdentityMigrationReceipt,
} from "../../lib/identity-migration.mjs";

const SOURCE_EMAIL = "legacy@example.invalid";
const TARGET_EMAIL = "current@example.test";

test("identity migration routes every physical mutation through the injected gateway", (t) => {
  const project = fixtureProject(t);
  const plan = planIdentityMigration({
    projectRoot: project,
    mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
  });
  const mutations = [];
  const revalidated = [];
  let preparedDescriptor = null;
  const mutationGateway = (request, effect) => {
    mutations.push(request);
    return effect();
  };
  mutationGateway.prepare = (descriptor, effect) => {
    preparedDescriptor = descriptor;
    return effect();
  };
  mutationGateway.revalidate = (request) => {
    revalidated.push(request);
    return true;
  };
  const applied = applyIdentityMigration(plan, {
    mutationGateway,
    rebuildDerived: ({ sdlcRoot }) => {
      writeJson(path.join(sdlcRoot, "cache", "kb-cache.json"), { search_text: TARGET_EMAIL });
      writeJson(path.join(sdlcRoot, "indexes", "kb-index.json"), { search_text: TARGET_EMAIL });
    },
  });

  assert.equal(applied.status, "applied");
  const operations = new Set(mutations.map(({ operation }) => operation));
  for (const operation of [
    "directory.copy",
    "directory.create",
    "directory.remove",
    "file.append",
    "file.remove",
    "file.truncate",
    "file.write",
    "lock.release",
    "path.chmod",
    "path.link.source",
    "path.link.target",
    "path.rename.source",
    "path.rename.target",
  ]) {
    assert.ok(operations.has(operation), `missing governed identity operation ${operation}`);
  }
  assert.ok(mutations.every(({ path: mutationPath }) => path.isAbsolute(mutationPath)));
  assert.ok(preparedDescriptor, "prepared gateway must receive the reviewed execution descriptor");
  const canonicalRoot = fs.realpathSync.native(project);
  const exact = new Set(preparedDescriptor.exact_mutations.map(({ operation, path: mutationPath }) =>
    `${operation}\0${mutationPath}`));
  for (const request of mutations) {
    const projectPath = path.relative(canonicalRoot, request.path).split(path.sep).join("/");
    assert.ok(exact.has(`${request.operation}\0${projectPath}`), `unprepared physical mutation ${request.operation} ${projectPath}`);
    if (projectPath.endsWith(".tmp")) {
      assert.match(projectPath, /\.identity-[a-f0-9]{24}\.tmp$|identity-migration-(?:lock|journal)[.-]/u);
      assert.doesNotMatch(projectPath, /\.\d+\.[a-f0-9]{12}\.tmp$/u);
    }
  }
  for (const operation of [
    "path.link.source",
    "path.link.target",
    "path.rename.source",
    "path.rename.target",
  ]) {
    assert.ok(revalidated.some((request) => request.operation === operation));
  }
});

for (const dualPathOperation of ["link", "rename"]) {
  test(`identity ${dualPathOperation} revalidates an expired source after deciding its target`, (t) => {
    const project = fixtureProject(t);
    const plan = planIdentityMigration({
      projectRoot: project,
      mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
    });
    const prefix = `path.${dualPathOperation}`;
    const active = [];
    let clockMinutes = 0;
    let targetEvaluatedAt = null;
    let sourceRevalidatedAt = null;
    let armed = true;
    const mutationGateway = (request, effect) => {
      const authorization = {
        request,
        validUntilMinutes: request.operation === `${prefix}.source` && armed ? 10 : Number.POSITIVE_INFINITY,
      };
      active.push(authorization);
      if (request.operation === `${prefix}.target` && armed) {
        clockMinutes = 11;
        targetEvaluatedAt = clockMinutes;
      }
      try {
        return effect();
      } finally {
        active.pop();
      }
    };
    mutationGateway.revalidate = (request) => {
      const authorization = [...active].reverse().find((candidate) =>
        candidate.request.operation === request.operation && candidate.request.path === request.path);
      assert.ok(authorization, `missing active ${request.operation} authorization`);
      if (request.operation === `${prefix}.source` && armed) {
        sourceRevalidatedAt = clockMinutes;
      }
      if (clockMinutes >= authorization.validUntilMinutes) {
        throw new Error(`${dualPathOperation} source authorization expired`);
      }
      return true;
    };

    const syscallName = dualPathOperation === "link" ? "linkSync" : "renameSync";
    const originalSyscall = fs[syscallName];
    let syscallCount = 0;
    fs[syscallName] = function countedDualPathSyscall(...args) {
      syscallCount += 1;
      return originalSyscall.apply(fs, args);
    };
    try {
      assert.throws(
        () => applyIdentityMigration(plan, { mutationGateway }),
        new RegExp(`${dualPathOperation} source authorization expired`, "u"),
      );
    } finally {
      fs[syscallName] = originalSyscall;
    }

    assert.equal(targetEvaluatedAt, 11);
    assert.equal(sourceRevalidatedAt, 11);
    assert.equal(syscallCount, 0, `${dualPathOperation} ran after its source authorization expired`);
  });
}

test("identity migration gateway denial happens before the first physical byte", (t) => {
  const project = fixtureProject(t);
  const before = snapshotTree(path.join(project, ".sdlc"));
  const plan = planIdentityMigration({
    projectRoot: project,
    mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
  });
  const denied = [];

  assert.throws(() => applyIdentityMigration(plan, {
    mutationGateway(request) {
      denied.push(request);
      throw new Error("gateway denied before effect");
    },
  }), /gateway denied before effect/u);
  assert.equal(denied[0].operation, "file.write");
  assert.deepEqual(snapshotTree(path.join(project, ".sdlc")), before);
  assert.deepEqual(
    fs.readdirSync(project).filter((name) => name.startsWith(".sdlc-identity-migration")),
    [],
  );
});

test("identity migration rejects a tampered execution descriptor before its first byte", (t) => {
  const project = fixtureProject(t);
  const plan = planIdentityMigration({
    projectRoot: project,
    mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
  });
  const before = snapshotTree(path.join(project, ".sdlc"));
  const tamperedDescriptor = structuredClone(plan.execution_descriptor);
  tamperedDescriptor.lock_temporary_path = ".tampered-identity-lock.tmp";
  const tamperedPlan = { ...plan, execution_descriptor: tamperedDescriptor };
  const mutationGateway = (request, effect) => effect();
  mutationGateway.prepare = (_descriptor, effect) => effect();

  assert.throws(
    () => applyIdentityMigration(tamperedPlan, { mutationGateway }),
    /execution descriptor is missing or changed/u,
  );
  assert.deepEqual(snapshotTree(path.join(project, ".sdlc")), before);
  assert.deepEqual(
    fs.readdirSync(project).filter((name) => name.startsWith(".sdlc-identity-migration")),
    [],
  );
});

test("identity migration never removes a pre-existing deterministic lock temp", (t) => {
  const project = fixtureProject(t);
  const plan = planIdentityMigration({
    projectRoot: project,
    mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
  });
  const canonicalRoot = fs.realpathSync.native(project);
  const lockTempPath = path.join(canonicalRoot, ...plan.execution_descriptor.lock_temporary_path.split("/"));
  fs.writeFileSync(lockTempPath, "pre-existing-owner\n", { flag: "wx", mode: 0o600 });

  assert.throws(() => applyIdentityMigration(plan), /Cannot acquire identity migration lock/u);
  assert.equal(fs.readFileSync(lockTempPath, "utf8"), "pre-existing-owner\n");
  assert.equal(fs.existsSync(path.join(canonicalRoot, plan.execution_descriptor.lock_path)), false);
});

test("identity migration preserves a replaced journal temp and never publishes it", {
  skip: process.platform === "win32"
    ? "Windows does not portably allow replacing an open journal file"
    : false,
}, (t) => {
  const project = fixtureProject(t);
  const before = snapshotTree(path.join(project, ".sdlc"));
  const plan = planIdentityMigration({
    projectRoot: project,
    mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
  });
  const canonicalRoot = fs.realpathSync.native(project);
  const journalPath = path.join(canonicalRoot, ...plan.execution_descriptor.journal_path.split("/"));
  const journalTempPath = path.join(
    canonicalRoot,
    ...plan.execution_descriptor.journal_temporary_path.split("/"),
  );
  let replaced = false;
  const mutationGateway = (request, effect) => {
    if (!replaced && request.operation === "path.rename.target" && request.path === journalPath) {
      fs.rmSync(journalTempPath);
      fs.writeFileSync(journalTempPath, "replacement-not-owned\n", { flag: "wx", mode: 0o600 });
      replaced = true;
    }
    return effect();
  };
  mutationGateway.revalidate = () => true;

  assert.throws(
    () => applyIdentityMigration(plan, { mutationGateway }),
    /temporary-file ownership changed/u,
  );
  assert.equal(replaced, true);
  assert.equal(fs.readFileSync(journalTempPath, "utf8"), "replacement-not-owned\n");
  assert.equal(fs.existsSync(journalPath), false);
  assert.deepEqual(snapshotTree(path.join(project, ".sdlc")), before);
});

test("identity migration keeps the journal temp handle open through its rename", (t) => {
  const project = fixtureProject(t);
  const plan = planIdentityMigration({
    projectRoot: project,
    mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
  });
  const canonicalRoot = fs.realpathSync.native(project);
  const journalPath = path.join(canonicalRoot, ...plan.execution_descriptor.journal_path.split("/"));
  const journalTempPath = path.join(
    canonicalRoot,
    ...plan.execution_descriptor.journal_temporary_path.split("/"),
  );
  const originalOpenSync = fs.openSync;
  let journalDescriptor = null;
  let observedOpenRename = false;
  fs.openSync = function trackedOpenSync(filePath, ...args) {
    const descriptor = originalOpenSync.call(fs, filePath, ...args);
    if (path.resolve(filePath) === journalTempPath) journalDescriptor = descriptor;
    return descriptor;
  };
  const mutationGateway = (request, effect) => {
    if (request.operation === "path.rename.target" && request.path === journalPath) {
      assert.notEqual(journalDescriptor, null, "journal temp descriptor was not captured");
      assert.doesNotThrow(() => fs.fstatSync(journalDescriptor));
      observedOpenRename = true;
    }
    return effect();
  };
  mutationGateway.revalidate = () => true;

  try {
    assert.equal(applyIdentityMigration(plan, {
      mutationGateway,
      rebuildDerived: ({ sdlcRoot }) => {
        writeJson(path.join(sdlcRoot, "cache", "kb-cache.json"), { search_text: TARGET_EMAIL });
        writeJson(path.join(sdlcRoot, "indexes", "kb-index.json"), { search_text: TARGET_EMAIL });
      },
    }).status, "applied");
  } finally {
    fs.openSync = originalOpenSync;
  }
  assert.equal(observedOpenRename, true);
});

test("identity execution nonce changes with migrated content, not policy-only plan inputs", (t) => {
  const project = fixtureProject(t);
  const first = planIdentityMigration({
    projectRoot: project,
    mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
  });
  const projectPath = path.join(project, ".sdlc", "project.json");
  const projectRecord = readJson(projectPath);
  projectRecord.audit.review_marker = "content-changed-after-first-preview";
  writeJson(projectPath, projectRecord);
  const second = planIdentityMigration({
    projectRoot: project,
    mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
  });
  assert.notEqual(first.execution_descriptor.nonce, second.execution_descriptor.nonce);
});

test("identity migration preserves approval and authorization lineage without retaining source identity", (t) => {
  const project = fixtureProject(t);
  const before = snapshotTree(path.join(project, ".sdlc"));
  const plan = planIdentityMigration({
    projectRoot: project,
    mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL, name: "Current User" } },
    createdAt: "2026-07-17T12:00:00.000Z",
  });
  const publicPlan = publicIdentityMigrationPlan(plan);

  assert.equal(publicPlan.status, "ready");
  assert.ok(publicPlan.source_occurrences_before >= 5);
  assert.equal(publicPlan.source_occurrences_after, 0);
  assert.ok(publicPlan.hash_rewrites.some((item) => item.kind === "authorization"));
  assert.ok(publicPlan.hash_rewrites.some((item) => item.kind === "approval"));
  assert.ok(publicPlan.hash_rewrites.some((item) => item.kind === "receipt"));
  assert.deepEqual(snapshotTree(path.join(project, ".sdlc")), before, "dry-run changed the project");

  const applied = applyIdentityMigration(plan, {
    rebuildDerived: ({ sdlcRoot }) => {
      writeJson(path.join(sdlcRoot, "cache", "kb-cache.json"), { search_text: TARGET_EMAIL });
      writeJson(path.join(sdlcRoot, "indexes", "kb-index.json"), { search_text: TARGET_EMAIL });
    },
  });
  assert.equal(applied.status, "applied");
  assert.deepEqual(applied.derived_artifacts, { cache: "rebuilt", indexes: "rebuilt" });
  assert.equal(readTreeText(path.join(project, ".sdlc")).includes(SOURCE_EMAIL), false);

  const authorization = readJson(path.join(project, ".sdlc", "authorizations", "AUTH-1.json"));
  assert.equal(authorization.granted_by.email, TARGET_EMAIL);
  assert.equal(authorization.approved_content_hash, hashLegacyAuthorization(authorization));
  const usage = readJson(path.join(project, ".sdlc", "authorization-uses", "AUTH-1", "USE-1.json"));
  assert.equal(usage.authorization_hash, authorization.approved_content_hash);
  assert.equal(
    usage.receipt_hash,
    computeStableHash(omitKeys(usage, ["receipt_hash", "hash_algorithm"])),
  );

  const contract = readJson(path.join(project, ".sdlc", "contracts", "CONTRACT-1.json"));
  assert.equal(contract.contextualization.context_sources[0].excerpt, TARGET_EMAIL);
  assert.equal(contract.approvals[0].approved_content_hash, hashApprovalSubject(contract));
  const report = readJson(path.join(project, ".sdlc", "reports", "task-start.json"));
  assert.equal(report.contract_approval_hash, contract.approvals[0].approved_content_hash);

  const receipt = readJson(path.join(project, plan.receipt_path));
  assert.equal(JSON.stringify(receipt).includes(SOURCE_EMAIL), false);
  assert.equal(receipt.plan_hash, plan.plan_hash);
  assert.equal(receipt.source_identity_digest, sha256(SOURCE_EMAIL.toLowerCase()));
  assert.equal(validateIdentityMigrationReceipt(receipt).valid, true);

  const receiptWithoutPlanHash = structuredClone(receipt);
  delete receiptWithoutPlanHash.plan_hash;
  receiptWithoutPlanHash.receipt_hash = computeStableHash(
    omitKeys(receiptWithoutPlanHash, ["receipt_hash", "hash_algorithm"]),
  );
  assert.equal(validateIdentityMigrationReceipt(receiptWithoutPlanHash).valid, false);

  const semanticallyTamperedReceipt = structuredClone(receipt);
  semanticallyTamperedReceipt.target_identity.email_digest = "f".repeat(64);
  semanticallyTamperedReceipt.receipt_hash = computeStableHash(
    omitKeys(semanticallyTamperedReceipt, ["receipt_hash", "hash_algorithm"]),
  );
  const semanticValidation = validateIdentityMigrationReceipt(semanticallyTamperedReceipt);
  assert.equal(semanticValidation.valid, false);
  assert.ok(semanticValidation.errors.some((error) => error.includes("target identity digest does not match")));

  const repeated = publicIdentityMigrationPlan(planIdentityMigration({
    projectRoot: project,
    mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
  }));
  assert.equal(repeated.status, "already_applied");
  assert.equal(repeated.plan_hash, receipt.plan_hash);
  assert.equal(repeated.changed_files.length, 0);

  assert.throws(
    () => planIdentityMigration({
      projectRoot: project,
      mapping: {
        source: { email: SOURCE_EMAIL },
        target: { email: TARGET_EMAIL, name: "Different Target Name" },
      },
    }),
    /does not match the requested source and target/u,
  );

  writeJson(path.join(project, ".sdlc", "cache", "kb-cache.json"), { search_text: SOURCE_EMAIL });
  assert.throws(
    () => planIdentityMigration({
      projectRoot: project,
      mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
    }),
    /remains in derived or unsupported SDLC files/u,
  );
});

test("identity migration restores the complete SDLC tree when post-write work fails", (t) => {
  const project = fixtureProject(t);
  const sdlcRoot = path.join(project, ".sdlc");
  const before = snapshotTree(sdlcRoot);
  const plan = planIdentityMigration({
    projectRoot: project,
    mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
  });

  assert.throws(
    () => applyIdentityMigration(plan, { rebuildDerived: () => { throw new Error("derived rebuild failed"); } }),
    /rolled back/u,
  );
  assert.deepEqual(snapshotTree(sdlcRoot), before);
  assert.equal(fs.existsSync(path.join(project, ".sdlc-identity-migration.lock")), false);
  assert.equal(fs.existsSync(path.join(project, plan.receipt_path)), false);
});

test("identity migration plan hash binds the target name even when no source record has a name", (t) => {
  const project = isolatedProject(t, "identity-target-name-binding-");
  writeJson(path.join(project, ".sdlc", "project.json"), {
    id: "PROJECT-TARGET-NAME-BINDING",
    actor: { id: "legacy-user", type: "human", email: SOURCE_EMAIL },
  });
  const alice = planIdentityMigration({
    projectRoot: project,
    mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL, name: "Alice" } },
  });
  const mallory = planIdentityMigration({
    projectRoot: project,
    mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL, name: "Mallory" } },
  });

  assert.deepEqual(alice.changed_files, mallory.changed_files);
  assert.deepEqual(alice.hash_rewrites, mallory.hash_rewrites);
  assert.notEqual(alice.plan_hash, mallory.plan_hash);
});

test("identity migration rejects a target name that would retain the source identity", (t) => {
  const project = isolatedProject(t, "identity-source-in-target-name-");
  writeJson(path.join(project, ".sdlc", "project.json"), {
    id: "PROJECT-SOURCE-IN-TARGET-NAME",
    actor: { email: SOURCE_EMAIL },
  });

  assert.throws(
    () => planIdentityMigration({
      projectRoot: project,
      mapping: {
        source: { email: SOURCE_EMAIL },
        target: { email: TARGET_EMAIL, name: SOURCE_EMAIL },
      },
    }),
    /Target name must not retain the source identity/u,
  );
  assert.equal(fs.existsSync(path.join(project, ".sdlc", "migrations")), false);
});

test("identity migration refuses a stale plan without overwriting the newer project state", (t) => {
  const project = fixtureProject(t);
  const plan = planIdentityMigration({
    projectRoot: project,
    mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
  });
  const projectPath = path.join(project, ".sdlc", "project.json");
  const changed = `${fs.readFileSync(projectPath, "utf8").trimEnd()}\n\n`;
  fs.writeFileSync(projectPath, changed);

  assert.throws(() => applyIdentityMigration(plan), /changed after planning/u);
  assert.equal(fs.readFileSync(projectPath, "utf8"), changed);
  assert.equal(fs.existsSync(path.join(project, plan.receipt_path)), false);
  assert.deepEqual(
    fs.readdirSync(project).filter((name) => name.startsWith(".sdlc-identity-migration")),
    [],
    "stale state must fail before the deterministic lock temp is created",
  );
});

test("identity migration fails closed on unsupported matches and pre-existing hash corruption", (t) => {
  assert.throws(
    () => planIdentityMigration({
      projectRoot: fixtureProject(t),
      mapping: { source: { email: SOURCE_EMAIL, unexpected: true }, target: { email: TARGET_EMAIL } },
    }),
    /source contains unsupported field/u,
  );

  const unsupportedProject = fixtureProject(t);
  const note = path.join(unsupportedProject, ".sdlc", "notes", "legacy.txt");
  fs.mkdirSync(path.dirname(note), { recursive: true });
  fs.writeFileSync(note, `Do not migrate ${SOURCE_EMAIL} as opaque text.\n`);
  assert.throws(
    () => planIdentityMigration({
      projectRoot: unsupportedProject,
      mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
    }),
    /unsupported non-JSON SDLC files/u,
  );

  const corruptProject = fixtureProject(t);
  const usagePath = path.join(corruptProject, ".sdlc", "authorization-uses", "AUTH-1", "USE-1.json");
  const usage = readJson(usagePath);
  usage.receipt_hash = "0".repeat(64);
  writeJson(usagePath, usage);
  assert.throws(
    () => planIdentityMigration({
      projectRoot: corruptProject,
      mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
    }),
    /Authorization receipt integrity failed/u,
  );
});

test("identity migration preserves canonical v2 lineage across two embedded authorization copies", (t) => {
  const project = isolatedProject(t, "identity-canonical-v2-");
  const subject = identitySubject(SOURCE_EMAIL);
  const authorization = canonicalAuthorization({
    id: "AUTH-CANONICAL-V2",
    subject,
    actions: ["assessment.execute", "assessment.verify"],
  });
  const receipts = [
    buildAuthorizationUsageReceipt(authorization, {
      id: "USE-CANONICAL-V2-EXECUTE",
      action: "assessment.execute",
      subject,
      used_at: "2026-07-17T10:00:00.000Z",
      evidence: [],
    }),
    buildAuthorizationUsageReceipt(authorization, {
      id: "USE-CANONICAL-V2-VERIFY",
      action: "assessment.verify",
      subject,
      used_at: "2026-07-17T10:01:00.000Z",
      evidence: [],
    }),
  ];
  const authorizationPath = path.join(project, ".sdlc", "authorizations", `${authorization.id}.json`);
  const receiptPaths = receipts.map((receipt) =>
    path.join(project, ".sdlc", "authorization-uses", authorization.id, `${receipt.id}.json`));
  writeJson(authorizationPath, authorization);
  receipts.forEach((receipt, index) => writeJson(receiptPaths[index], receipt));

  assert.equal(validateAuthorizationSnapshotIntegrity(authorization).valid, true);
  assert.ok(receipts.every((receipt) => validateAuthorizationUsageReceipt(receipt).valid));

  const plan = planIdentityMigration({
    projectRoot: project,
    mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL, name: "Current User" } },
  });
  const applied = applyIdentityMigration(plan);
  assert.equal(applied.status, "applied");
  assert.deepEqual(applied.derived_artifacts, { cache: "rebuild_required", indexes: "rebuild_required" });

  const migratedAuthorization = readJson(authorizationPath);
  const migratedReceipts = receiptPaths.map(readJson);
  const migratedSubject = identitySubject(TARGET_EMAIL, "Current User");
  const migratedSubjectHash = computeAuthorizationSubjectHash(migratedSubject);
  assert.equal(validateAuthorizationSnapshotIntegrity(migratedAuthorization).valid, true);
  assert.deepEqual(migratedAuthorization.allowed_subject_hashes, [migratedSubjectHash]);
  assert.equal(new Set(migratedAuthorization.allowed_uses.map((item) => item.use_hash)).size, 2);
  for (const receipt of migratedReceipts) {
    assert.equal(receipt.subject_hash, migratedSubjectHash);
    assert.equal(receipt.authorization_hash, migratedAuthorization.authorization_hash);
    assert.equal(receipt.authorization_snapshot.authorization_hash, migratedAuthorization.authorization_hash);
    assert.equal(validateAuthorizationUsageReceipt(receipt).valid, true);
  }
  const authorizationRewrites = plan.hash_rewrites.filter((item) =>
    item.kind === "authorization" && item.before_hash === authorization.authorization_hash);
  assert.equal(authorizationRewrites.length, 1, "duplicate copies produced divergent authorization lineage");
});

test("identity migration preserves an unambiguous canonical v1 authorization and receipt", (t) => {
  const project = isolatedProject(t, "identity-canonical-v1-");
  const subject = identitySubject(SOURCE_EMAIL);
  const modern = canonicalAuthorization({
    id: "AUTH-CANONICAL-V1",
    subject,
    actions: ["assessment.execute", "assessment.verify"],
  });
  const authorization = asCanonicalV1Authorization(modern);
  const modernReceipt = buildAuthorizationUsageReceipt(authorization, {
    id: "USE-CANONICAL-V1",
    action: "assessment.execute",
    subject,
    used_at: "2026-07-17T10:00:00.000Z",
    evidence: [],
  });
  const receipt = asCanonicalV1Receipt(modernReceipt);
  const authorizationPath = path.join(project, ".sdlc", "authorizations", `${authorization.id}.json`);
  const receiptPath = path.join(project, ".sdlc", "authorization-uses", authorization.id, `${receipt.id}.json`);
  writeJson(authorizationPath, authorization);
  writeJson(receiptPath, receipt);

  assert.equal(validateAuthorizationSnapshotIntegrity(authorization).valid, true);
  assert.equal(validateAuthorizationUsageReceipt(receipt).valid, true);
  const plan = planIdentityMigration({
    projectRoot: project,
    mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
  });
  applyIdentityMigration(plan);

  const migratedAuthorization = readJson(authorizationPath);
  const migratedReceipt = readJson(receiptPath);
  assert.equal(migratedAuthorization.schema_version, "content-authorization:v1");
  assert.equal(Object.hasOwn(migratedAuthorization, "allowed_uses"), false);
  assert.equal(migratedReceipt.schema_version, "authorization-usage-receipt:v1");
  assert.equal(Object.hasOwn(migratedReceipt, "use_hash"), false);
  assert.equal(validateAuthorizationSnapshotIntegrity(migratedAuthorization).valid, true);
  assert.equal(validateAuthorizationUsageReceipt(migratedReceipt).valid, true);
});

test("identity migration rewrites canonical revocation lineage before the enclosing receipt", (t) => {
  const project = isolatedProject(t, "identity-revocation-");
  const subject = identitySubject(SOURCE_EMAIL);
  const authorization = canonicalAuthorization({
    id: "AUTH-REVOKED",
    subject,
    actions: ["assessment.execute"],
  });
  const revocation = createAuthorizationRevocation({
    id: "REVOCATION-1",
    authorization_id: authorization.id,
    authorization_hash: authorization.authorization_hash,
    effective_at: "2026-07-17T10:30:00.000Z",
    reason: "Fixture revocation",
    revoked_by: { id: "legacy-user", type: "human", name: "Legacy User", email: SOURCE_EMAIL },
  });
  const receipt = buildAuthorizationUsageReceipt(authorization, {
    id: "USE-REVOKED",
    action: "assessment.execute",
    subject,
    used_at: "2026-07-17T10:31:00.000Z",
    evidence: [],
  }, [revocation]);
  const authorizationPath = path.join(project, ".sdlc", "authorizations", `${authorization.id}.json`);
  const revocationPath = path.join(project, ".sdlc", "authorizations", `${revocation.id}.json`);
  const receiptPath = path.join(project, ".sdlc", "authorization-uses", authorization.id, `${receipt.id}.json`);
  writeJson(authorizationPath, authorization);
  writeJson(revocationPath, revocation);
  writeJson(receiptPath, receipt);

  assert.equal(receipt.decision, "deny");
  assert.equal(validateAuthorizationRevocationIntegrity(revocation).valid, true);
  assert.equal(validateAuthorizationUsageReceipt(receipt).valid, true);
  const plan = planIdentityMigration({
    projectRoot: project,
    mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
  });
  applyIdentityMigration(plan);

  const migratedAuthorization = readJson(authorizationPath);
  const migratedRevocation = readJson(revocationPath);
  const migratedReceipt = readJson(receiptPath);
  assert.equal(migratedRevocation.authorization_hash, migratedAuthorization.authorization_hash);
  assert.equal(migratedReceipt.authorization_hash, migratedAuthorization.authorization_hash);
  assert.equal(migratedReceipt.effective_revocation.revocation_hash, migratedRevocation.revocation_hash);
  assert.equal(validateAuthorizationRevocationIntegrity(migratedRevocation).valid, true);
  assert.equal(validateAuthorizationUsageReceipt(migratedReceipt).valid, true);
});

test("identity migration keeps a precomputed subject binding stable when receipt.subject is null", (t) => {
  const project = isolatedProject(t, "identity-null-subject-");
  const subject = { kind: "assessment_proposal", id: "SUBJECT-WITHOUT-IDENTITY", hash: "d".repeat(64) };
  const authorization = canonicalAuthorization({
    id: "AUTH-NULL-SUBJECT",
    subject,
    actions: ["assessment.execute"],
  });
  const receipt = buildAuthorizationUsageReceipt(authorization, {
    id: "USE-NULL-SUBJECT",
    action: "assessment.execute",
    subject_hash: computeAuthorizationSubjectHash(subject),
    used_at: "2026-07-17T10:00:00.000Z",
    evidence: [],
  });
  const authorizationPath = path.join(project, ".sdlc", "authorizations", `${authorization.id}.json`);
  const receiptPath = path.join(project, ".sdlc", "authorization-uses", authorization.id, `${receipt.id}.json`);
  writeJson(authorizationPath, authorization);
  writeJson(receiptPath, receipt);

  const beforeSubjectHash = receipt.subject_hash;
  const beforeUseHash = receipt.use_hash;
  assert.equal(receipt.subject, null);
  const plan = planIdentityMigration({
    projectRoot: project,
    mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
  });
  applyIdentityMigration(plan);

  const migratedAuthorization = readJson(authorizationPath);
  const migratedReceipt = readJson(receiptPath);
  assert.equal(migratedReceipt.subject, null);
  assert.equal(migratedReceipt.subject_hash, beforeSubjectHash);
  assert.equal(migratedReceipt.use_hash, beforeUseHash);
  assert.notEqual(migratedAuthorization.authorization_hash, authorization.authorization_hash);
  assert.equal(migratedReceipt.authorization_hash, migratedAuthorization.authorization_hash);
  assert.equal(validateAuthorizationUsageReceipt(migratedReceipt).valid, true);
});

test("identity migration fails closed without touching a signed host approval receipt", (t) => {
  const project = isolatedProject(t, "identity-signed-host-");
  const subject = { kind: "assessment_proposal", id: "PROPOSAL-SIGNED", hash: "e".repeat(64) };
  const keyPair = crypto.generateKeyPairSync("ed25519");
  const receipt = buildHostApprovalReceipt({
    id: "HOST-APPROVAL-SIGNED",
    action: "assessment.proposal.approve",
    subject,
    subject_ref: { kind: "assessment_proposal", id: subject.id, hash: subject.hash },
    checkpoint: { type: "proposal", normal_checkpoint: 2 },
    question_contract: {
      asked: "Approve this exact fixture?",
      why: "The test requires signed authority evidence.",
      authorizes: ["The exact fixture proposal"],
      does_not_authorize: ["Any other proposal"],
      examples: { en: ["Approve this proposal"] },
    },
    decision: "approved",
    decided_at: "2026-07-17T10:00:00.000Z",
    expires_at: "2026-07-17T12:00:00.000Z",
    decided_by: { id: "legacy-user", type: "human", name: "Legacy User", email: SOURCE_EMAIL },
    constraints: {
      subject_hash: computeAuthorizationSubjectHash(subject),
      no_scope_expansion: true,
    },
    signing: { key_id: "host-test-key", private_key: keyPair.privateKey },
  });
  const receiptPath = path.join(project, ".sdlc", "receipts", "host", `${receipt.id}.json`);
  writeJson(receiptPath, receipt);
  const before = snapshotTree(path.join(project, ".sdlc"));

  assert.throws(
    () => planIdentityMigration({
      projectRoot: project,
      mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
    }),
    /signed lineage/u,
  );
  assert.deepEqual(snapshotTree(path.join(project, ".sdlc")), before);
});

test("identity migration fails closed when a transitive hash rewrite reaches signed evidence", (t) => {
  const project = fixtureProject(t);
  const authorization = readJson(path.join(project, ".sdlc", "authorizations", "AUTH-1.json"));
  const subject = {
    kind: "content_authorization",
    id: authorization.id,
    hash: authorization.approved_content_hash,
  };
  const keyPair = crypto.generateKeyPairSync("ed25519");
  const receipt = buildHostApprovalReceipt({
    id: "HOST-APPROVAL-TRANSITIVE",
    action: "contract.approve",
    subject,
    subject_ref: subject,
    checkpoint: { type: "contract", normal_checkpoint: 2 },
    question_contract: {
      asked: "Approve this exact authorization snapshot?",
      why: "The test binds signed evidence to the pre-migration authorization hash.",
      authorizes: ["The exact authorization snapshot"],
      does_not_authorize: ["A rewritten authorization snapshot"],
      examples: { en: ["Approve this snapshot"] },
    },
    decision: "approved",
    decided_at: "2026-07-17T10:00:00.000Z",
    expires_at: "2026-07-17T12:00:00.000Z",
    decided_by: { id: "independent-approver", type: "human", email: "approver@example.test" },
    constraints: {
      subject_hash: computeAuthorizationSubjectHash(subject),
      no_scope_expansion: true,
    },
    signing: { key_id: "host-transitive-key", private_key: keyPair.privateKey },
  });
  writeJson(path.join(project, ".sdlc", "receipts", "host", `${receipt.id}.json`), receipt);
  const before = snapshotTree(path.join(project, ".sdlc"));

  assert.throws(
    () => planIdentityMigration({
      projectRoot: project,
      mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
    }),
    /immutable lineage/u,
  );
  assert.deepEqual(snapshotTree(path.join(project, ".sdlc")), before);
});

test("identity migration fails closed when a transitive rewrite reaches an unknown integrity envelope", (t) => {
  const project = fixtureProject(t);
  const authorization = readJson(path.join(project, ".sdlc", "authorizations", "AUTH-1.json"));
  const receiptBody = {
    id: "CUSTOM-RECEIPT-1",
    kind: "custom_receipt",
    schema_version: "custom-receipt:v1",
    linked_hash: authorization.approved_content_hash,
    issued_by: { id: "external-system", type: "system" },
  };
  const receipt = {
    ...receiptBody,
    receipt_hash: computeStableHash(receiptBody),
    hash_algorithm: "sha256:stable-json:v1",
  };
  writeJson(path.join(project, ".sdlc", "receipts", "custom", `${receipt.id}.json`), receipt);
  const before = snapshotTree(path.join(project, ".sdlc"));

  assert.throws(
    () => planIdentityMigration({
      projectRoot: project,
      mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
    }),
    /unsupported or signed immutable lineage/u,
  );
  assert.deepEqual(snapshotTree(path.join(project, ".sdlc")), before);
});

test("identity migration rekeys exact hash lineage stored as mutable JSON object keys", (t) => {
  const project = fixtureProject(t);
  const contract = readJson(path.join(project, ".sdlc", "contracts", "CONTRACT-1.json"));
  const beforeHash = contract.approvals[0].approved_content_hash;
  const indexPath = path.join(project, ".sdlc", "approval-index.json");
  writeJson(indexPath, { by_hash: { [beforeHash]: { kind: "approval" } } });

  const plan = planIdentityMigration({
    projectRoot: project,
    mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
  });
  let expectedHash = beforeHash;
  const seen = new Set();
  while (!seen.has(expectedHash)) {
    seen.add(expectedHash);
    const rewrite = plan.hash_rewrites.find((item) => item.kind === "approval" && item.before_hash === expectedHash);
    if (!rewrite) break;
    expectedHash = rewrite.after_hash;
  }
  assert.notEqual(expectedHash, beforeHash);
  applyIdentityMigration(plan, {
    rebuildDerived: ({ sdlcRoot }) => {
      writeJson(path.join(sdlcRoot, "cache", "kb-cache.json"), { search_text: TARGET_EMAIL });
      writeJson(path.join(sdlcRoot, "indexes", "kb-index.json"), { search_text: TARGET_EMAIL });
    },
  });

  const migrated = readJson(indexPath);
  assert.equal(Object.hasOwn(migrated.by_hash, beforeHash), false);
  assert.deepEqual(migrated.by_hash[expectedHash], { kind: "approval" });
});

test("identity migration detects mapped hash keys inside opaque and signed nested envelopes", (t) => {
  for (const kind of ["opaque", "signed"]) {
    const project = fixtureProject(t);
    const contract = readJson(path.join(project, ".sdlc", "contracts", "CONTRACT-1.json"));
    const beforeHash = contract.approvals[0].approved_content_hash;
    const body = {
      schema_version: `custom-${kind}:v1`,
      by_hash: { [beforeHash]: { kind: "approval" } },
    };
    const envelope = kind === "opaque"
      ? {
        ...body,
        receipt_hash: computeStableHash(body),
        hash_algorithm: "sha256:stable-json:v1",
      }
      : {
        ...body,
        signatures: [{ algorithm: "EdDSA", value: "detached-signature" }],
      };
    writeJson(path.join(project, ".sdlc", `${kind}-hash-index.json`), { envelope });
    const before = snapshotTree(path.join(project, ".sdlc"));

    assert.throws(
      () => planIdentityMigration({
        projectRoot: project,
        mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
      }),
      /immutable lineage/u,
    );
    assert.deepEqual(snapshotTree(path.join(project, ".sdlc")), before);
  }
});

test("identity migration preserves file-hash approval metadata while correcting its audit actor", (t) => {
  const project = isolatedProject(t, "identity-file-hash-metadata-");
  const approvedContentHash = "1".repeat(64);
  const approvedDeliveryHash = "2".repeat(64);
  const registryPath = path.join(project, ".sdlc", "output-contracts", "registry.json");
  writeJson(registryPath, {
    id: "OUTPUT-REGISTRY",
    template: {
      id: "OUTPUT-TEMPLATE-1",
      approved_content_hash: approvedContentHash,
      approved_delivery_hash: approvedDeliveryHash,
      hash_algorithm: "sha256:file:v1",
    },
    audit: { git: { user: { email: SOURCE_EMAIL } } },
  });

  const plan = planIdentityMigration({
    projectRoot: project,
    mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
  });
  applyIdentityMigration(plan);
  const migrated = readJson(registryPath);
  assert.equal(migrated.audit.git.user.email, TARGET_EMAIL);
  assert.equal(migrated.template.approved_content_hash, approvedContentHash);
  assert.equal(migrated.template.approved_delivery_hash, approvedDeliveryHash);
  assert.equal(migrated.template.hash_algorithm, "sha256:file:v1");
});

test("identity migration corrects mutable siblings without entering a nested opaque receipt", (t) => {
  const project = isolatedProject(t, "identity-opaque-sibling-");
  const receiptBody = {
    id: "VERIFY-OPAQUE-SIBLING",
    schema_version: "verification-receipt:v1",
    subject_ref: { hash: "3".repeat(64) },
    verifier: { email: "independent@example.test" },
  };
  const opaqueReceipt = {
    ...receiptBody,
    receipt_hash: computeStableHash(receiptBody),
    hash_algorithm: "sha256:stable-json:v1",
  };
  const registryPath = path.join(project, ".sdlc", "output-contracts", "registry.json");
  writeJson(registryPath, {
    schema_version: "0.1.0",
    audit: { git: { user: { email: SOURCE_EMAIL } } },
    link: { verification_receipt: opaqueReceipt },
  });

  const plan = planIdentityMigration({
    projectRoot: project,
    mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
  });
  applyIdentityMigration(plan);

  const migrated = readJson(registryPath);
  assert.equal(migrated.audit.git.user.email, TARGET_EMAIL);
  assert.deepEqual(migrated.link.verification_receipt, opaqueReceipt);
});

test("identity migration fails closed when the source identity is inside a nested opaque receipt", (t) => {
  const project = isolatedProject(t, "identity-opaque-source-");
  const receiptBody = {
    id: "VERIFY-OPAQUE-SOURCE",
    schema_version: "verification-receipt:v1",
    verifier: { email: SOURCE_EMAIL },
  };
  writeJson(path.join(project, ".sdlc", "registry.json"), {
    schema_version: "0.1.0",
    verification_receipt: {
      ...receiptBody,
      receipt_hash: computeStableHash(receiptBody),
      hash_algorithm: "sha256:stable-json:v1",
    },
  });
  const before = snapshotTree(path.join(project, ".sdlc"));

  assert.throws(
    () => planIdentityMigration({
      projectRoot: project,
      mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
    }),
    /unsupported immutable lineage/u,
  );
  assert.deepEqual(snapshotTree(path.join(project, ".sdlc")), before);
});

test("identity migration never rewrites an approval hash stored inside an opaque envelope", (t) => {
  const project = isolatedProject(t, "identity-opaque-approval-");
  const record = {
    id: "PARENT-WITH-OPAQUE-APPROVAL",
    owner_email: SOURCE_EMAIL,
    approvals: [{
      id: "OPAQUE-APPROVAL",
      schema_version: "custom-approval-receipt:v1",
      approved_content_hash: null,
      receipt_hash: null,
      hash_algorithm: "sha256:stable-json:v1",
    }],
  };
  record.approvals[0].approved_content_hash = hashApprovalSubject(record);
  record.approvals[0].receipt_hash = computeStableHash(
    omitKeys(record.approvals[0], ["receipt_hash", "hash_algorithm"]),
  );
  const recordPath = path.join(project, ".sdlc", "opaque-approval.json");
  writeJson(recordPath, record);
  const before = snapshotTree(path.join(project, ".sdlc"));

  assert.throws(
    () => planIdentityMigration({
      projectRoot: project,
      mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
    }),
    /approval hash inside unsupported or signed immutable lineage/u,
  );
  assert.deepEqual(snapshotTree(path.join(project, ".sdlc")), before);
});

test("identity migration treats unknown stable-json self hashes as opaque at root and nested boundaries", (t) => {
  for (const nested of [false, true]) {
    const project = isolatedProject(t, `identity-generic-self-hash-${nested ? "nested" : "root"}-`);
    const body = {
      schema_version: "custom-integrity:v1",
      owner_email: SOURCE_EMAIL,
    };
    const envelope = {
      ...body,
      integrity_hash: computeStableHash(body),
      hash_algorithm: "sha256:stable-json:v1",
    };
    writeJson(path.join(project, ".sdlc", "integrity.json"), nested ? { id: "PARENT", envelope } : envelope);
    const before = snapshotTree(path.join(project, ".sdlc"));

    assert.throws(
      () => planIdentityMigration({
        projectRoot: project,
        mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
      }),
      /unsupported immutable lineage/u,
    );
    assert.deepEqual(snapshotTree(path.join(project, ".sdlc")), before);
  }
});

test("identity migration recognizes plural signature envelopes at root and nested boundaries", (t) => {
  for (const nested of [false, true]) {
    const project = isolatedProject(t, `identity-plural-signature-${nested ? "nested" : "root"}-`);
    const envelope = {
      schema_version: "external-signed:v1",
      owner_email: SOURCE_EMAIL,
      payload_hash: "5".repeat(64),
      signatures: [{ algorithm: "EdDSA", value: "detached-signature" }],
    };
    writeJson(path.join(project, ".sdlc", "signed.json"), nested ? { id: "PARENT", envelope } : envelope);
    const before = snapshotTree(path.join(project, ".sdlc"));

    assert.throws(
      () => planIdentityMigration({
        projectRoot: project,
        mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
      }),
      /signed lineage/u,
    );
    assert.deepEqual(snapshotTree(path.join(project, ".sdlc")), before);
  }
});

test("identity migration refuses to reserialize a document containing a plural signature envelope", (t) => {
  const project = isolatedProject(t, "identity-signature-sibling-");
  const envelope = {
    schema_version: "external-signed:v1",
    owner_email: "external@example.test",
    payload_hash: "6".repeat(64),
    signatures: [{ algorithm: "EdDSA", value: "detached-signature" }],
  };
  const recordPath = path.join(project, ".sdlc", "signed-sibling.json");
  writeJson(recordPath, {
    audit: { git: { user: { email: SOURCE_EMAIL } } },
    envelope,
  });
  const before = snapshotTree(path.join(project, ".sdlc"));

  assert.throws(
    () => planIdentityMigration({
      projectRoot: project,
      mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
    }),
    /signed|immutable.*(?:document|lineage)|reserializ/u,
  );
  assert.deepEqual(snapshotTree(path.join(project, ".sdlc")), before);
});

test("identity migration preserves an explicitly historical context snapshot while migrating its sibling audit", (t) => {
  const project = isolatedProject(t, "identity-historical-context-");
  writeJson(path.join(project, ".sdlc", "source.json"), { id: "SOURCE-NOW" });
  const registryPath = path.join(project, ".sdlc", "registry.json");
  const historical = {
    path: ".sdlc/source.json",
    sha256: "4".repeat(64),
    size_bytes: 42,
    excerpt: "Point-in-time evidence from an earlier source revision.",
    trust: "untrusted_project_evidence",
  };
  writeJson(registryPath, {
    audit: { git: { user: { email: SOURCE_EMAIL } } },
    contextualization: { context_sources: [historical] },
  });

  const plan = planIdentityMigration({
    projectRoot: project,
    mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
  });
  applyIdentityMigration(plan);

  const migrated = readJson(registryPath);
  assert.equal(migrated.audit.git.user.email, TARGET_EMAIL);
  assert.deepEqual(migrated.contextualization.context_sources[0], historical);
});

test("identity migration uses original four-space bytes for sha256/hash refs and ignores near-collisions", (t) => {
  const project = isolatedProject(t, "identity-raw-refs-");
  const sourcePath = path.join(project, ".sdlc", "evidence", "identity.json");
  const sourceRecord = {
    exact: SOURCE_EMAIL,
    prose: `Owner: ${SOURCE_EMAIL}.`,
    near_collision: `not${SOURCE_EMAIL}`,
  };
  writeJsonWithIndent(sourcePath, sourceRecord, 4);
  const beforeBytes = fs.readFileSync(sourcePath);
  const beforeHash = sha256(beforeBytes);
  const referencesPath = path.join(project, ".sdlc", "evidence", "references.json");
  writeJson(referencesPath, {
    by_sha256: {
      path: ".sdlc/evidence/identity.json",
      sha256: beforeHash,
      size_bytes: beforeBytes.length,
    },
    by_hash: {
      path: ".sdlc/evidence/identity.json",
      hash: beforeHash,
      size_bytes: beforeBytes.length,
    },
  });

  const plan = planIdentityMigration({
    projectRoot: project,
    mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
  });
  const sourceChange = plan.changed_files.find((item) => item.path === ".sdlc/evidence/identity.json");
  assert.equal(sourceChange.before_sha256, beforeHash);
  applyIdentityMigration(plan);

  const migratedSource = readJson(sourcePath);
  const migratedReferences = readJson(referencesPath);
  const afterBytes = fs.readFileSync(sourcePath);
  const afterHash = sha256(afterBytes);
  assert.equal(migratedSource.exact, TARGET_EMAIL);
  assert.equal(migratedSource.prose, `Owner: ${TARGET_EMAIL}.`);
  assert.equal(migratedSource.near_collision, `not${SOURCE_EMAIL}`);
  assert.equal(migratedReferences.by_sha256.sha256, afterHash);
  assert.equal(migratedReferences.by_sha256.size_bytes, afterBytes.length);
  assert.equal(migratedReferences.by_hash.hash, afterHash);
});

test("identity migration rejects aliased and escaping file-reference paths before planning writes", (t) => {
  for (const referencePath of [
    ".sdlc/evidence/../evidence/identity.json",
    "../outside.json",
    "/absolute/outside.json",
    "C:\\outside.json",
  ]) {
    const project = isolatedProject(t, "identity-reference-path-");
    const sourcePath = path.join(project, ".sdlc", "evidence", "identity.json");
    writeJson(sourcePath, { owner_email: SOURCE_EMAIL });
    const bytes = fs.readFileSync(sourcePath);
    writeJson(path.join(project, ".sdlc", "references.json"), {
      evidence: {
        path: referencePath,
        sha256: sha256(bytes),
        size_bytes: bytes.length,
      },
    });
    const before = snapshotTree(path.join(project, ".sdlc"));

    assert.throws(
      () => planIdentityMigration({
        projectRoot: project,
        mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
      }),
      /canonical relative project path without dot segments/u,
    );
    assert.deepEqual(snapshotTree(path.join(project, ".sdlc")), before);
  }
});

test("identity migration rejects a tampered prior migration receipt", (t) => {
  const project = isolatedProject(t, "identity-tampered-receipt-");
  writeJson(path.join(project, ".sdlc", "project.json"), {
    id: "PROJECT-TAMPER",
    actor: { id: "legacy-user", type: "human", email: SOURCE_EMAIL },
  });
  const plan = planIdentityMigration({
    projectRoot: project,
    mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
  });
  applyIdentityMigration(plan);
  const receiptPath = path.join(project, plan.receipt_path);
  const receipt = readJson(receiptPath);
  receipt.reason = `${receipt.reason} Tampered.`;
  writeJson(receiptPath, receipt);

  assert.throws(
    () => planIdentityMigration({
      projectRoot: project,
      mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
    }),
    /Existing identity migration receipt is invalid/u,
  );
});

test("identity migration never launders a tampered receipt from an earlier mapping", (t) => {
  const project = isolatedProject(t, "identity-prior-receipt-");
  const firstSource = "first-owner@example.invalid";
  const secondSource = "second-owner@example.invalid";
  const projectPath = path.join(project, ".sdlc", "project.json");
  writeJson(projectPath, {
    id: "PROJECT-PRIOR-RECEIPT",
    actors: [{ id: "first-owner", type: "human", email: firstSource }],
  });
  const firstPlan = planIdentityMigration({
    projectRoot: project,
    mapping: { source: { email: firstSource }, target: { email: TARGET_EMAIL } },
  });
  applyIdentityMigration(firstPlan);
  const firstReceiptPath = path.join(project, firstPlan.receipt_path);
  const firstReceipt = readJson(firstReceiptPath);
  firstReceipt.reason = `${firstReceipt.reason} Tampered without rehashing.`;
  writeJson(firstReceiptPath, firstReceipt);
  const projectRecord = readJson(projectPath);
  projectRecord.actors.push({ id: "second-owner", type: "human", email: secondSource });
  writeJson(projectPath, projectRecord);
  const before = snapshotTree(path.join(project, ".sdlc"));

  assert.throws(
    () => planIdentityMigration({
      projectRoot: project,
      mapping: { source: { email: secondSource }, target: { email: "second-current@example.test" } },
    }),
    /Historical identity migration receipt integrity failed/u,
  );
  assert.deepEqual(snapshotTree(path.join(project, ".sdlc")), before);
  assert.equal(validateIdentityMigrationReceipt(readJson(firstReceiptPath)).valid, false);
});

test("identity migration never reclaims an apparently stale lock", (t) => {
  const project = isolatedProject(t, "identity-stale-lock-");
  writeJson(path.join(project, ".sdlc", "project.json"), {
    id: "PROJECT-LOCK",
    actor: { id: "legacy-user", type: "human", email: SOURCE_EMAIL },
  });
  const plan = planIdentityMigration({
    projectRoot: project,
    mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
  });
  const before = snapshotTree(path.join(project, ".sdlc"));
  const lockPath = path.join(project, ".sdlc-identity-migration.lock");
  const lockContent = `${JSON.stringify({
    migration_id: "OLD-MIGRATION",
    pid: 2_147_483_647,
    host: os.hostname(),
    nonce: "externally-owned-lock",
    created_at: "2000-01-01T00:00:00.000Z",
  })}\n`;
  fs.writeFileSync(lockPath, lockContent, { flag: "wx" });

  assert.throws(() => applyIdentityMigration(plan), /Cannot acquire identity migration lock/u);
  assert.equal(fs.readFileSync(lockPath, "utf8"), lockContent);
  assert.deepEqual(snapshotTree(path.join(project, ".sdlc")), before);
  assert.equal(fs.existsSync(path.join(project, plan.receipt_path)), false);
});

test("identity migration never discards a concurrent write at the directory-swap boundary", (t) => {
  const project = isolatedProject(t, "identity-swap-drift-");
  const liveRoot = path.join(project, ".sdlc");
  writeJson(path.join(liveRoot, "project.json"), {
    id: "PROJECT-SWAP-DRIFT",
    actor: { id: "legacy-user", type: "human", email: SOURCE_EMAIL },
  });
  const plan = planIdentityMigration({
    projectRoot: project,
    mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
  });

  assert.throws(
    () => applyIdentityMigration(plan, {
      transactionObserver: ({ phase }) => {
        if (phase === "swap_intent") {
          writeJson(path.join(liveRoot, "concurrent.json"), { preserved: true });
        }
      },
    }),
    /durable recovery is required/u,
  );

  const lock = readMigrationLock(path.join(project, ".sdlc-identity-migration.lock"));
  const backupRoot = path.join(project, lock.transaction_root, "original");
  assert.equal(fs.existsSync(liveRoot), false, "unverified shadow must not be activated");
  assert.deepEqual(readJson(path.join(backupRoot, "concurrent.json")), { preserved: true });
  assert.equal(fs.existsSync(path.join(backupRoot, "migrations")), false);
});

test("identity migration recovery restores a durable backup after an interrupted directory swap", (t) => {
  const project = isolatedProject(t, "identity-crash-recovery-");
  const liveRoot = path.join(project, ".sdlc");
  writeJson(path.join(liveRoot, "project.json"), { id: "BEFORE", owner_email: SOURCE_EMAIL });
  const before = snapshotTree(liveRoot);

  const nonce = "a".repeat(24);
  const planHash = "1".repeat(64);
  const migrationId = `MIG-IDENTITY-${"b".repeat(12)}-${"c".repeat(12)}`;
  const transactionName = `.sdlc-identity-migration-txn-${nonce}`;
  const journalName = `.sdlc-identity-migration-journal-${nonce}.json`;
  const transactionRoot = path.join(project, transactionName);
  const backupRoot = path.join(transactionRoot, "original");
  fs.mkdirSync(transactionRoot, { recursive: true });
  fs.cpSync(liveRoot, backupRoot, { recursive: true, errorOnExist: true });
  writeJson(path.join(liveRoot, "project.json"), { id: "INTERRUPTED", owner_email: TARGET_EMAIL });
  const lock = {
    schema_version: "identity-migration-lock:v1",
    migration_id: migrationId,
    plan_hash: planHash,
    pid: 2_147_483_647,
    host: os.hostname(),
    nonce,
    transaction_root: transactionName,
    journal_path: journalName,
    phase: "acquired",
    generation: 0,
    created_at: "2026-07-17T12:00:00.000Z",
  };
  writeJson(path.join(project, ".sdlc-identity-migration.lock"), lock);
  const journal = {
    ...lock,
    phase: "shadow_activated",
    generation: 1,
    updated_at: "2026-07-17T12:00:01.000Z",
  };
  journal.journal_hash = computeStableHash(journal);
  writeJson(path.join(project, journalName), journal);
  const interrupted = snapshotTree(liveRoot);

  assert.throws(
    () => recoverIdentityMigration({
      projectRoot: project,
      recoveryNonce: "0".repeat(24),
      planHash,
    }),
    /recovery nonce does not match/u,
  );
  assert.throws(
    () => recoverIdentityMigration({
      projectRoot: project,
      recoveryNonce: nonce,
      planHash: "0".repeat(64),
    }),
    /recovery plan hash does not match/u,
  );
  assert.deepEqual(snapshotTree(liveRoot), interrupted);

  const preparation = prepareIdentityMigrationRecovery({
    projectRoot: project,
    recoveryNonce: nonce,
    planHash,
  });
  const lockBeforeDeniedRecovery = fs.readFileSync(path.join(project, ".sdlc-identity-migration.lock"));
  assert.throws(() => recoverIdentityMigration({
    projectRoot: project,
    recoveryNonce: nonce,
    planHash,
    recoveryPreparation: preparation,
    mutationGateway() {
      throw new Error("recovery mutation denied before effect");
    },
  }), /denied before effect/u);
  assert.deepEqual(snapshotTree(liveRoot), interrupted);
  assert.deepEqual(
    fs.readFileSync(path.join(project, ".sdlc-identity-migration.lock")),
    lockBeforeDeniedRecovery,
  );
  assert.equal(findRecoveryClaims(project).length, 0);
  const exactMutations = new Set(preparation.exact_mutations.map(({ operation, path: mutationPath }) =>
    `${operation}\u0000${mutationPath}`));
  const observedMutations = [];
  const recoveryMutationGateway = (request, effect) => {
    const exactKey = `${request.operation}\u0000${request.path}`;
    assert.ok(exactMutations.has(exactKey), `recovery attempted an unprepared mutation: ${exactKey}`);
    observedMutations.push(exactKey);
    return effect();
  };
  recoveryMutationGateway.revalidate = (request) => {
    const exactKey = `${request.operation}\u0000${request.path}`;
    assert.ok(exactMutations.has(exactKey), `recovery revalidated an unprepared mutation: ${exactKey}`);
    return true;
  };
  const recovered = recoverIdentityMigration({
    projectRoot: project,
    recoveryNonce: nonce,
    planHash,
    recoveryPreparation: preparation,
    mutationGateway: recoveryMutationGateway,
  });
  assert.equal(recovered.status, "rolled_back");
  assert.ok(observedMutations.length > 0);
  assert.equal(observedMutations.some((item) => item.startsWith("transaction.execute\u0000")), false);
  assert.deepEqual(snapshotTree(liveRoot), before);
  assert.equal(fs.existsSync(path.join(project, ".sdlc-identity-migration.lock")), false);
  assert.equal(fs.existsSync(path.join(project, journalName)), false);
  assert.equal(fs.existsSync(transactionRoot), false);
});

test("identity migration recovery clears a pre-swap shadow without touching the live tree", (t) => {
  const project = isolatedProject(t, "identity-pre-swap-recovery-");
  const liveRoot = path.join(project, ".sdlc");
  writeJson(path.join(liveRoot, "project.json"), { id: "LIVE", owner_email: SOURCE_EMAIL });
  const before = snapshotTree(liveRoot);
  const nonce = "d".repeat(24);
  const planHash = "2".repeat(64);
  const migrationId = `MIG-IDENTITY-${"e".repeat(12)}-${"f".repeat(12)}`;
  const transactionName = `.sdlc-identity-migration-txn-${nonce}`;
  const journalName = `.sdlc-identity-migration-journal-${nonce}.json`;
  writeJson(path.join(project, transactionName, "shadow", ".sdlc", "project.json"), {
    id: "SHADOW",
    owner_email: TARGET_EMAIL,
  });
  const lock = {
    schema_version: "identity-migration-lock:v1",
    migration_id: migrationId,
    plan_hash: planHash,
    pid: 2_147_483_647,
    host: os.hostname(),
    nonce,
    transaction_root: transactionName,
    journal_path: journalName,
    phase: "acquired",
    generation: 0,
    created_at: "2026-07-17T12:00:00.000Z",
  };
  writeJson(path.join(project, ".sdlc-identity-migration.lock"), lock);
  const journal = {
    ...lock,
    phase: "shadow_prepared",
    generation: 1,
    updated_at: "2026-07-17T12:00:01.000Z",
  };
  journal.journal_hash = computeStableHash(journal);
  writeJson(path.join(project, journalName), journal);

  const claimPath = path.join(project, `.sdlc-identity-migration-recovery-${nonce}.lock`);
  const claim = {
    schema_version: "identity-migration-recovery-claim:v1",
    migration_id: migrationId,
    plan_hash: planHash,
    transaction_nonce: nonce,
    pid: process.pid,
    host: os.hostname(),
    claim_nonce: "3".repeat(24),
    created_at: "2026-07-17T12:00:02.000Z",
  };
  writeJson(claimPath, claim);
  assert.throws(
    () => recoverIdentityMigration({
      projectRoot: project,
      recoveryNonce: nonce,
      planHash,
    }),
    /recovery is already running/u,
  );
  assert.deepEqual(snapshotTree(liveRoot), before);

  writeJson(claimPath, { ...claim, pid: 2_147_483_647 });

  const recovered = recoverIdentityMigration({
    projectRoot: project,
    recoveryNonce: nonce,
    planHash,
  });
  assert.equal(recovered.status, "cleared_before_swap");
  assert.deepEqual(snapshotTree(liveRoot), before);
  assert.equal(fs.existsSync(path.join(project, transactionName)), false);
  assert.equal(fs.existsSync(claimPath), false);
});

test("identity migration recovery never removes a prepared claim temporary it did not create", (t) => {
  const project = isolatedProject(t, "identity-claim-temp-ownership-");
  writeJson(path.join(project, ".sdlc", "project.json"), {
    id: "CLAIM-TEMP-OWNERSHIP",
    owner: { name: "Legacy User", email: SOURCE_EMAIL },
  });
  const crashed = crashIdentityMigration(project, "shadow_activated");
  assert.equal(crashed.status, 86, crashed.stderr || crashed.stdout);
  const lock = readMigrationLock(path.join(project, ".sdlc-identity-migration.lock"));
  const preparation = prepareIdentityMigrationRecovery({
    projectRoot: project,
    recoveryNonce: lock.nonce,
    planHash: lock.plan_hash,
  });

  // Another recovery using the same preparation already holds every
  // temporary claim path this recovery will derive.
  const claimPath = path.join(project, `.sdlc-identity-migration-recovery-${lock.nonce}.lock`);
  const foreignTemporaries = preparation.claim_nonces.map((claimNonce) => {
    const temporaryPath = `${claimPath}.${process.pid}.${claimNonce}.tmp`;
    fs.writeFileSync(temporaryPath, `foreign ${claimNonce}\n`, { flag: "wx" });
    return temporaryPath;
  });

  assert.throws(() => recoverIdentityMigration({
    projectRoot: project,
    recoveryNonce: lock.nonce,
    planHash: lock.plan_hash,
    recoveryPreparation: preparation,
  }));
  for (const temporaryPath of foreignTemporaries) {
    assert.equal(
      fs.readFileSync(temporaryPath, "utf8"),
      `foreign ${path.basename(temporaryPath).split(".").at(-2)}\n`,
    );
  }
});

test("identity migration recovery restores byte-exact state after a real process crash before commit", (t) => {
  const project = isolatedProject(t, "identity-real-crash-rollback-");
  const liveRoot = path.join(project, ".sdlc");
  writeJson(path.join(liveRoot, "project.json"), {
    id: "REAL-CRASH-BEFORE-COMMIT",
    owner: { name: "Legacy User", email: SOURCE_EMAIL },
  });
  const before = snapshotTree(liveRoot);
  const crashed = crashIdentityMigration(project, "shadow_activated");

  assert.equal(crashed.status, 86, crashed.stderr || crashed.stdout);
  const lock = readMigrationLock(path.join(project, ".sdlc-identity-migration.lock"));
  const journal = readJson(path.join(project, lock.journal_path));
  assert.equal(journal.phase, "shadow_activated");
  assert.notDeepEqual(snapshotTree(liveRoot), before);

  const recovered = recoverIdentityMigration({
    projectRoot: project,
    recoveryNonce: lock.nonce,
    planHash: lock.plan_hash,
  });
  assert.equal(recovered.status, "rolled_back");
  assert.deepEqual(snapshotTree(liveRoot), before);
  assert.equal(findRecoveryClaims(project).length, 0);
});

test("identity migration recovery finalizes the exact committed tree after a real process crash", (t) => {
  const project = isolatedProject(t, "identity-real-crash-commit-");
  const expectedProject = isolatedProject(t, "identity-real-crash-expected-");
  const record = {
    id: "REAL-CRASH-AFTER-COMMIT",
    owner: { name: "Legacy User", email: SOURCE_EMAIL },
  };
  writeJson(path.join(project, ".sdlc", "project.json"), record);
  writeJson(path.join(expectedProject, ".sdlc", "project.json"), record);
  const createdAt = "2026-07-17T12:34:56.000Z";
  const expectedPlan = planIdentityMigration({
    projectRoot: expectedProject,
    mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL, name: "Current User" } },
    createdAt,
  });
  applyIdentityMigration(expectedPlan);
  const expected = snapshotTree(path.join(expectedProject, ".sdlc"));

  const crashed = crashIdentityMigration(project, "committed", createdAt);
  assert.equal(crashed.status, 86, crashed.stderr || crashed.stdout);
  const lock = readMigrationLock(path.join(project, ".sdlc-identity-migration.lock"));
  const journal = readJson(path.join(project, lock.journal_path));
  assert.equal(journal.phase, "committed");
  assert.deepEqual(snapshotTree(path.join(project, ".sdlc")), expected);

  const recovered = recoverIdentityMigration({
    projectRoot: project,
    recoveryNonce: lock.nonce,
    planHash: lock.plan_hash,
  });
  assert.equal(recovered.status, "committed");
  assert.deepEqual(snapshotTree(path.join(project, ".sdlc")), expected);
  assert.equal(findRecoveryClaims(project).length, 0);
});

test("identity migration preserves byte-exact noncanonical JSON that does not require migration", (t) => {
  const project = isolatedProject(t, "identity-byte-preserved-");
  writeJson(path.join(project, ".sdlc", "project.json"), {
    id: "PROJECT-BYTE-PRESERVED",
    actor: { email: SOURCE_EMAIL },
  });
  const untouchedPath = path.join(project, ".sdlc", "external-signed.json");
  writeJsonWithIndent(untouchedPath, {
    schema_version: "external-signed:v1",
    owner_email: "external@example.test",
    signatureValue: "detached-external-signature",
  }, 4);
  const beforeBytes = fs.readFileSync(untouchedPath);

  const plan = planIdentityMigration({
    projectRoot: project,
    mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
  });
  assert.equal(
    plan.changed_files.some((item) => item.path === ".sdlc/external-signed.json"),
    false,
  );

  applyIdentityMigration(plan);
  assert.deepEqual(fs.readFileSync(untouchedPath), beforeBytes);
});

test("identity migration recognizes camelCase signature markers and fails closed", (t) => {
  for (const marker of ["signatureValue", "proofValue", "jwsCompact"]) {
    const project = isolatedProject(t, `identity-camel-signature-${marker}-`);
    const signedPath = path.join(project, ".sdlc", `${marker}.json`);
    writeJson(signedPath, {
      schema_version: "external-signed:v1",
      owner_email: SOURCE_EMAIL,
      [marker]: "detached-signature-material",
    });
    const before = snapshotTree(path.join(project, ".sdlc"));

    assert.throws(
      () => planIdentityMigration({
        projectRoot: project,
        mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
      }),
      /signed lineage/u,
    );
    assert.deepEqual(snapshotTree(path.join(project, ".sdlc")), before);
  }
});

test("identity migration treats camelCase stable-json self hashes as immutable lineage", (t) => {
  const project = isolatedProject(t, "identity-camel-self-hash-");
  const body = {
    schema_version: "custom-integrity:v1",
    owner_email: SOURCE_EMAIL,
  };
  writeJson(path.join(project, ".sdlc", "integrity.json"), {
    ...body,
    integrityHash: computeStableHash(body),
    hashAlgorithm: "sha256:stable-json:v1",
  });
  const before = snapshotTree(path.join(project, ".sdlc"));

  assert.throws(
    () => planIdentityMigration({
      projectRoot: project,
      mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
    }),
    /unsupported immutable lineage/u,
  );
  assert.deepEqual(snapshotTree(path.join(project, ".sdlc")), before);
});

test("identity migration rejects source identity embedded inside target metadata", (t) => {
  const project = isolatedProject(t, "identity-source-in-target-metadata-");
  writeJson(path.join(project, ".sdlc", "project.json"), {
    id: "PROJECT-SOURCE-IN-TARGET-METADATA",
    actor: { email: SOURCE_EMAIL },
  });

  assert.throws(
    () => planIdentityMigration({
      projectRoot: project,
      mapping: {
        source: { email: SOURCE_EMAIL },
        target: { email: TARGET_EMAIL, name: `Canonical owner (${SOURCE_EMAIL})` },
      },
    }),
    /Target name must not retain the source identity/u,
  );
  assert.throws(
    () => planIdentityMigration({
      projectRoot: project,
      mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
      reason: `Correct-${SOURCE_EMAIL}-lineage`,
    }),
    /Migration reason must not retain the source identity/u,
  );
  assert.equal(fs.existsSync(path.join(project, ".sdlc", "migrations")), false);
});

test("identity migration receipt validator rejects unsafe and ambiguous lineage", (t) => {
  const project = isolatedProject(t, "identity-receipt-validation-");
  writeJson(path.join(project, ".sdlc", "project.json"), {
    id: "PROJECT-RECEIPT-VALIDATION",
    actor: { email: SOURCE_EMAIL },
  });
  const plan = planIdentityMigration({
    projectRoot: project,
    mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
  });
  const validReceipt = structuredClone(plan._internal.receipt);
  assert.equal(validateIdentityMigrationReceipt(validReceipt).valid, true);

  const traversal = structuredClone(validReceipt);
  traversal.changed_files[0].path = ".sdlc/../outside.json";
  rehashIdentityMigrationReceipt(traversal);
  const traversalValidation = validateIdentityMigrationReceipt(traversal);
  assert.equal(traversalValidation.valid, false);
  assert.ok(traversalValidation.errors.some((error) => /canonical|path|traversal/u.test(error)));

  const duplicate = structuredClone(validReceipt);
  duplicate.changed_files.push(structuredClone(duplicate.changed_files[0]));
  rehashIdentityMigrationReceipt(duplicate);
  const duplicateValidation = validateIdentityMigrationReceipt(duplicate);
  assert.equal(duplicateValidation.valid, false);
  assert.ok(duplicateValidation.errors.some((error) => /changed file.*duplicat/u.test(error)));

  const ambiguous = structuredClone(validReceipt);
  const historicalHash = "a".repeat(64);
  ambiguous.hash_rewrites.push(
    { kind: "approval", id: "AMBIGUOUS-A", before_hash: historicalHash, after_hash: "b".repeat(64) },
    { kind: "approval", id: "AMBIGUOUS-B", before_hash: historicalHash, after_hash: "c".repeat(64) },
  );
  rehashIdentityMigrationReceipt(ambiguous);
  const ambiguousValidation = validateIdentityMigrationReceipt(ambiguous);
  assert.equal(ambiguousValidation.valid, false);
  assert.ok(ambiguousValidation.errors.some((error) => /ambiguous|multiple|maps/u.test(error)));
});

test("identity migration fails before writes when excluded lock state retains the source identity", (t) => {
  const project = isolatedProject(t, "identity-excluded-lock-source-");
  writeJson(path.join(project, ".sdlc", "project.json"), {
    id: "PROJECT-EXCLUDED-LOCK-SOURCE",
    actor: { email: SOURCE_EMAIL },
  });
  writeJson(path.join(project, ".sdlc", "locks", "owner.json"), {
    owner: { email: SOURCE_EMAIL },
  });
  const before = snapshotTree(path.join(project, ".sdlc"));

  assert.throws(
    () => planIdentityMigration({
      projectRoot: project,
      mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
    }),
    /excluded SDLC state|locks/u,
  );
  assert.deepEqual(snapshotTree(path.join(project, ".sdlc")), before);
  assert.equal(fs.existsSync(path.join(project, ".sdlc", "migrations")), false);
});

test("identity migration does not treat API route descriptors as file references", (t) => {
  const project = isolatedProject(t, "identity-api-route-");
  const projectPath = path.join(project, ".sdlc", "project.json");
  writeJson(projectPath, {
    id: "PROJECT-API-ROUTE",
    actor: { email: SOURCE_EMAIL },
    route: { method: "GET", path: "/api/users" },
  });

  const plan = planIdentityMigration({
    projectRoot: project,
    mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
  });
  assert.equal(plan.status, "ready");
  applyIdentityMigration(plan);

  const migrated = readJson(projectPath);
  assert.equal(migrated.actor.email, TARGET_EMAIL);
  assert.deepEqual(migrated.route, { method: "GET", path: "/api/users" });
});

test("identity migration rejects canonical files injected by the derived rebuild callback", (t) => {
  const project = isolatedProject(t, "identity-rebuild-canonical-injection-");
  const sdlcRoot = path.join(project, ".sdlc");
  writeJson(path.join(sdlcRoot, "project.json"), {
    id: "PROJECT-REBUILD-CANONICAL-INJECTION",
    actor: { email: SOURCE_EMAIL },
  });
  const before = snapshotTree(sdlcRoot);
  const plan = planIdentityMigration({
    projectRoot: project,
    mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
  });

  assert.throws(
    () => applyIdentityMigration(plan, {
      rebuildDerived: ({ sdlcRoot: stagedRoot }) => {
        writeJson(path.join(stagedRoot, "unreviewed-canonical.json"), { injected: true });
      },
    }),
    /rolled back.*(?:canonical|rebuild|planned)/u,
  );
  assert.deepEqual(snapshotTree(sdlcRoot), before);
  assert.equal(fs.existsSync(path.join(sdlcRoot, "unreviewed-canonical.json")), false);
});

test("identity migration rejects mutation of the executable write set", (t) => {
  const project = isolatedProject(t, "identity-mutated-writes-");
  const sdlcRoot = path.join(project, ".sdlc");
  writeJson(path.join(sdlcRoot, "project.json"), {
    id: "PROJECT-MUTATED-WRITES",
    actor: { email: SOURCE_EMAIL },
  });
  const before = snapshotTree(sdlcRoot);
  const plan = planIdentityMigration({
    projectRoot: project,
    mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
  });
  plan._internal.writes.set(
    path.join(sdlcRoot, "unreviewed-canonical.json"),
    `${JSON.stringify({ injected: true })}\n`,
  );

  assert.throws(
    () => applyIdentityMigration(plan),
    /executable (?:snapshot|write set)|plan integrity|mutated/u,
  );
  assert.deepEqual(snapshotTree(sdlcRoot), before);
  assert.equal(fs.existsSync(path.join(project, ".sdlc-identity-migration.lock")), false);
});

test("identity migration recovery rejects a dangling lock symlink", (t) => {
  const project = isolatedProject(t, "identity-dangling-lock-");
  const lockPath = path.join(project, ".sdlc-identity-migration.lock");
  try {
    fs.symlinkSync("missing-identity-migration-lock", lockPath);
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
      t.skip(`symlink creation is unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  assert.throws(
    () => recoverIdentityMigration({ projectRoot: project }),
    /not a safe regular file|unsafe|symbolic/u,
  );
  assert.equal(fs.lstatSync(lockPath).isSymbolicLink(), true);
});

test("identity migration fails closed when the source identity occurs only in an SDLC path", (t) => {
  const project = isolatedProject(t, "identity-source-in-path-");
  const identityPath = path.join(project, ".sdlc", "evidence", `${SOURCE_EMAIL}.json`);
  writeJson(identityPath, { id: "PATH-ONLY-IDENTITY", owner: "external@example.test" });
  const before = snapshotTree(path.join(project, ".sdlc"));

  assert.throws(
    () => planIdentityMigration({
      projectRoot: project,
      mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
    }),
    /source identity.*(?:path|file name|filename)|explicit path migration/u,
  );
  assert.deepEqual(snapshotTree(path.join(project, ".sdlc")), before);
});

test("identity migration preserves a concurrent backup write after original_moved", (t) => {
  const project = isolatedProject(t, "identity-original-moved-drift-");
  const liveRoot = path.join(project, ".sdlc");
  writeJson(path.join(liveRoot, "project.json"), {
    id: "PROJECT-ORIGINAL-MOVED-DRIFT",
    actor: { email: SOURCE_EMAIL },
  });
  const plan = planIdentityMigration({
    projectRoot: project,
    mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
  });

  assert.throws(
    () => applyIdentityMigration(plan, {
      transactionObserver: ({ phase }) => {
        if (phase !== "original_moved") return;
        const transactionName = fs.readdirSync(project)
          .find((name) => name.startsWith(".sdlc-identity-migration-txn-"));
        assert.ok(transactionName, "transaction directory was not visible after original_moved");
        writeJson(path.join(project, transactionName, "original", "concurrent.json"), {
          preserved: true,
        });
      },
    }),
    /rolled back|durable recovery is required/u,
  );

  const liveConcurrent = path.join(liveRoot, "concurrent.json");
  const lockPath = path.join(project, ".sdlc-identity-migration.lock");
  let backupConcurrent = null;
  if (fs.existsSync(lockPath)) {
    const lock = readMigrationLock(lockPath);
    backupConcurrent = path.join(project, lock.transaction_root, "original", "concurrent.json");
  }
  assert.ok(
    fs.existsSync(liveConcurrent) || (backupConcurrent && fs.existsSync(backupConcurrent)),
    "the concurrent write must remain in the rolled-back tree or durable recovery backup",
  );
  const preservedPath = fs.existsSync(liveConcurrent) ? liveConcurrent : backupConcurrent;
  assert.deepEqual(readJson(preservedPath), { preserved: true });
});

test("identity migration preserves restrictive file modes and attests them in the plan and receipt", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX file modes are not enforceable on Windows");
    return;
  }
  const project = isolatedProject(t, "identity-mode-apply-");
  const projectPath = path.join(project, ".sdlc", "project.json");
  writeJson(projectPath, {
    id: "PROJECT-MODE-APPLY",
    actor: { email: SOURCE_EMAIL },
  });
  fs.chmodSync(projectPath, 0o600);

  const plan = planIdentityMigration({
    projectRoot: project,
    mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
  });
  const changed = plan.changed_files.find((item) => item.path === ".sdlc/project.json");
  assert.ok(changed, "the restricted file must be part of the reviewed write set");
  assert.equal(changed.before_mode, 0o600);
  assert.equal(changed.after_mode, 0o600);
  assert.equal(plan._internal.receipt.changed_files.find((item) => item.path === changed.path).before_mode, 0o600);
  assert.equal(plan._internal.receipt.changed_files.find((item) => item.path === changed.path).after_mode, 0o600);

  applyIdentityMigration(plan);
  assert.equal(fs.statSync(projectPath).mode & 0o7777, 0o600);
  const persistedReceipt = readJson(path.join(project, plan.receipt_path));
  const receiptChange = persistedReceipt.changed_files.find((item) => item.path === changed.path);
  assert.equal(receiptChange.before_mode, 0o600);
  assert.equal(receiptChange.after_mode, 0o600);
});

test("identity migration rollback restores the original restrictive file mode", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX file modes are not enforceable on Windows");
    return;
  }
  const project = isolatedProject(t, "identity-mode-rollback-");
  const liveRoot = path.join(project, ".sdlc");
  const projectPath = path.join(liveRoot, "project.json");
  writeJson(projectPath, {
    id: "PROJECT-MODE-ROLLBACK",
    actor: { email: SOURCE_EMAIL },
  });
  fs.chmodSync(projectPath, 0o600);
  const beforeBytes = fs.readFileSync(projectPath);
  const plan = planIdentityMigration({
    projectRoot: project,
    mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
  });

  assert.throws(
    () => applyIdentityMigration(plan, {
      validateAfter: () => {
        throw new Error("forced post-write validation failure");
      },
    }),
    /rolled back|durable recovery/u,
  );
  assert.deepEqual(fs.readFileSync(projectPath), beforeBytes);
  assert.equal(fs.statSync(projectPath).mode & 0o7777, 0o600);
  assert.equal(fs.existsSync(path.join(project, ".sdlc-identity-migration.lock")), false);
});

test("identity migration treats unknown content_hash records as immutable at root and nested boundaries", (t) => {
  for (const nested of [false, true]) {
    const project = isolatedProject(t, `identity-content-hash-${nested ? "nested" : "root"}-`);
    const body = {
      schema_version: "custom-content-envelope:v1",
      owner_email: SOURCE_EMAIL,
    };
    const envelope = {
      ...body,
      content_hash: computeStableHash(body),
    };
    writeJson(
      path.join(project, ".sdlc", "content-envelope.json"),
      nested ? { id: "PARENT-CONTENT-HASH", envelope } : envelope,
    );
    const before = snapshotTree(path.join(project, ".sdlc"));

    assert.throws(
      () => planIdentityMigration({
        projectRoot: project,
        mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
      }),
      /unsupported immutable lineage|content_hash/u,
    );
    assert.deepEqual(snapshotTree(path.join(project, ".sdlc")), before);
  }
});

test("identity migration recovery never rolls back a committed tree when an older journal is replayed", (t) => {
  const project = isolatedProject(t, "identity-committed-journal-replay-");
  const liveRoot = path.join(project, ".sdlc");
  const projectPath = path.join(liveRoot, "project.json");
  writeJson(projectPath, {
    id: "PROJECT-COMMITTED-JOURNAL-REPLAY",
    actor: { email: SOURCE_EMAIL },
  });
  const crashed = crashIdentityMigration(project, "committed");
  assert.equal(crashed.status, 86, crashed.stderr || crashed.stdout);

  const committedSnapshot = snapshotTree(liveRoot);
  assert.equal(readJson(projectPath).actor.email, TARGET_EMAIL);
  const lockPath = path.join(project, ".sdlc-identity-migration.lock");
  const lock = readMigrationLock(lockPath);
  const journalPath = path.join(project, lock.journal_path);
  const committedJournal = readJson(journalPath);
  assert.equal(committedJournal.phase, "committed");
  const staleJournal = {
    ...committedJournal,
    phase: "shadow_prepared",
    generation: Math.max(lock.generation + 1, committedJournal.generation - 1),
    updated_at: "2026-07-17T00:00:00.000Z",
  };
  delete staleJournal.journal_hash;
  staleJournal.journal_hash = computeStableHash(staleJournal);
  writeJson(journalPath, staleJournal);

  let recovered = null;
  let recoveryError = null;
  try {
    recovered = recoverIdentityMigration({
      projectRoot: project,
      recoveryNonce: lock.nonce,
      planHash: lock.plan_hash,
    });
  } catch (error) {
    recoveryError = error;
  }
  if (recoveryError) {
    assert.match(recoveryError.message, /stale|replay|journal|committed|ambiguous/u);
  } else {
    assert.equal(recovered.status, "committed");
  }
  assert.deepEqual(snapshotTree(liveRoot), committedSnapshot);
  assert.equal(readJson(projectPath).actor.email, TARGET_EMAIL);
});

test("identity migration refuses four-space JSON with a mutable sibling beside signed raw JSON", (t) => {
  const project = isolatedProject(t, "identity-signed-raw-sibling-");
  const recordPath = path.join(project, ".sdlc", "signed-raw-sibling.json");
  writeJsonWithIndent(recordPath, {
    audit: { git: { user: { email: SOURCE_EMAIL } } },
    envelope: {
      schema_version: "external-signed-raw:v1",
      raw_json: JSON.stringify({ subject: "external", sequence: 1 }),
      signatureValue: "detached-signature-over-raw-json",
    },
  }, 4);
  const beforeBytes = fs.readFileSync(recordPath);

  assert.throws(
    () => planIdentityMigration({
      projectRoot: project,
      mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
    }),
    /signed|immutable.*(?:document|lineage)|reserializ|raw JSON/u,
  );
  assert.deepEqual(fs.readFileSync(recordPath), beforeBytes);
});

test("identity migration fails closed before reserializing an unsafe integer literal", (t) => {
  const project = isolatedProject(t, "identity-unsafe-integer-");
  const recordPath = path.join(project, ".sdlc", "unsafe-integer.json");
  const raw = `{
  "id": "UNSAFE-INTEGER",
  "owner_email": "${SOURCE_EMAIL}",
  "sequence": 9007199254740993
}\n`;
  fs.writeFileSync(recordPath, raw);

  assert.throws(
    () => planIdentityMigration({
      projectRoot: project,
      mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
    }),
    /cannot be represented losslessly|unsafe integer|safe integer|precision/u,
  );
  assert.equal(fs.readFileSync(recordPath, "utf8"), raw);
  assert.equal(fs.existsSync(path.join(project, ".sdlc", "migrations")), false);
});

test("identity migration callbacks cannot replace the prepared SDLC root with an equivalent symlink", (t) => {
  if (process.platform === "win32") {
    t.skip("directory symlink semantics require POSIX permissions");
    return;
  }
  for (const callbackName of ["rebuildDerived", "validateAfter"]) {
    const project = isolatedProject(t, `identity-${callbackName}-root-symlink-`);
    const liveRoot = path.join(project, ".sdlc");
    writeJson(path.join(liveRoot, "project.json"), {
      id: `PROJECT-${callbackName.toUpperCase()}-ROOT-SYMLINK`,
      actor: { email: SOURCE_EMAIL },
    });
    const before = snapshotTree(liveRoot);
    const plan = planIdentityMigration({
      projectRoot: project,
      mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
    });
    const equivalentCopy = path.join(project, `.${callbackName}-equivalent-sdlc`);
    let callbackInvoked = false;
    const replacePreparedRoot = ({ sdlcRoot: stagedRoot }) => {
      callbackInvoked = true;
      fs.cpSync(stagedRoot, equivalentCopy, { recursive: true, errorOnExist: true });
      fs.rmSync(stagedRoot, { recursive: true, force: true });
      fs.symlinkSync(equivalentCopy, stagedRoot, "dir");
    };

    assert.throws(
      () => applyIdentityMigration(plan, { [callbackName]: replacePreparedRoot }),
      /rolled back|durable recovery|symbolic|symlink|prepared.*root|callback/u,
    );
    assert.equal(callbackInvoked, true);
    assert.equal(fs.lstatSync(liveRoot).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(liveRoot).isDirectory(), true);
    assert.deepEqual(snapshotTree(liveRoot), before);
    assert.equal(fs.existsSync(path.join(project, ".sdlc-identity-migration.lock")), false);
    assert.deepEqual(
      fs.readdirSync(project).filter((name) => name.startsWith(".sdlc-identity-migration-txn-")),
      [],
    );
  }
});

test("identity migration observers cannot mutate committed or finalized live state before backup cleanup", (t) => {
  for (const observedPhase of ["committed", "finalized"]) {
    const project = isolatedProject(t, `identity-observer-${observedPhase}-drift-`);
    const liveRoot = path.join(project, ".sdlc");
    writeJson(path.join(liveRoot, "project.json"), {
      id: `PROJECT-OBSERVER-${observedPhase.toUpperCase()}-DRIFT`,
      actor: { email: SOURCE_EMAIL },
    });
    const plan = planIdentityMigration({
      projectRoot: project,
      mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
    });
    const concurrentPath = path.join(liveRoot, `${observedPhase}-concurrent.json`);
    let observerInvoked = false;

    assert.throws(
      () => applyIdentityMigration(plan, {
        transactionObserver: ({ phase }) => {
          if (phase !== observedPhase) return;
          observerInvoked = true;
          writeJson(concurrentPath, { phase: observedPhase, preserved: true });
        },
      }),
      /backup|recovery|required|live.*changed|committ|finaliz/u,
    );
    assert.equal(observerInvoked, true);
    assert.deepEqual(readJson(concurrentPath), { phase: observedPhase, preserved: true });

    const lockPath = path.join(project, ".sdlc-identity-migration.lock");
    assert.equal(fs.existsSync(lockPath), true, "the authenticated recovery lock must survive");
    const lock = readMigrationLock(lockPath);
    const backupRoot = path.join(project, lock.transaction_root, "original");
    assert.equal(fs.lstatSync(backupRoot).isDirectory(), true, "the pre-migration backup must survive");
    assert.equal(readJson(path.join(backupRoot, "project.json")).actor.email, SOURCE_EMAIL);
  }
});

test("identity migration rejects unmaterialized file references except explicit historical snapshots", (t) => {
  const missingPath = ".sdlc/missing.json";
  const missingHash = "a".repeat(64);
  const project = isolatedProject(t, "identity-missing-file-reference-");
  const projectPath = path.join(project, ".sdlc", "project.json");
  writeJson(projectPath, {
    id: "PROJECT-MISSING-FILE-REFERENCE",
    actor: { email: SOURCE_EMAIL },
    evidence: { path: missingPath, sha256: missingHash },
  });
  const before = snapshotTree(path.join(project, ".sdlc"));

  assert.throws(
    () => planIdentityMigration({
      projectRoot: project,
      mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
    }),
    /not materialized|missing.*file reference|reference target/u,
  );
  assert.deepEqual(snapshotTree(path.join(project, ".sdlc")), before);

  const historicalProject = isolatedProject(t, "identity-missing-historical-reference-");
  const historicalPath = path.join(historicalProject, ".sdlc", "project.json");
  const historicalSnapshot = {
    path: missingPath,
    sha256: missingHash,
    size_bytes: 123,
    excerpt: "Point-in-time evidence retained from an unavailable source revision.",
    trust: "untrusted_project_evidence",
  };
  writeJson(historicalPath, {
    id: "PROJECT-MISSING-HISTORICAL-REFERENCE",
    actor: { email: SOURCE_EMAIL },
    historical_snapshot: historicalSnapshot,
  });
  const historicalPlan = planIdentityMigration({
    projectRoot: historicalProject,
    mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
  });
  applyIdentityMigration(historicalPlan);
  const migratedHistorical = readJson(historicalPath);
  assert.equal(migratedHistorical.actor.email, TARGET_EMAIL);
  assert.deepEqual(migratedHistorical.historical_snapshot, historicalSnapshot);
});

test("identity migration recognizes sig keys and signed schema names as immutable lineage", (t) => {
  const signedShapes = [
    { schema_version: "external-envelope:v1", owner_email: SOURCE_EMAIL, sig: "detached-signature" },
    { schema_version: "external-envelope:v1", owner_email: SOURCE_EMAIL, payload_sig: "detached-signature" },
    { schema_version: "external-signed:v1", owner_email: SOURCE_EMAIL, payload_hash: "d".repeat(64) },
  ];
  for (const [index, signed] of signedShapes.entries()) {
    const project = isolatedProject(t, `identity-sig-shape-${index}-`);
    const recordPath = path.join(project, ".sdlc", `signed-${index}.json`);
    writeJson(recordPath, signed);
    const before = fs.readFileSync(recordPath);

    assert.throws(
      () => planIdentityMigration({
        projectRoot: project,
        mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
      }),
      /signed lineage/u,
    );
    assert.deepEqual(fs.readFileSync(recordPath), before);
  }
});

test("identity migration does not infer signed canonicalization from an unrelated hash_algorithm sibling", (t) => {
  const project = isolatedProject(t, "identity-unrelated-signed-canonicalization-");
  const recordPath = path.join(project, ".sdlc", "signed-with-unrelated-hash-algorithm.json");
  writeJsonWithIndent(recordPath, {
    audit: { git: { user: { email: SOURCE_EMAIL } } },
    signed_envelope: {
      schema_version: "external-signed:v1",
      payload: { id: "EXTERNAL-PAYLOAD", owner: "external@example.test" },
      signatureValue: "detached-signature-over-provider-defined-bytes",
      unrelated_cache_metadata: {
        content_hash: "e".repeat(64),
        hash_algorithm: "sha256:stable-json:v1",
      },
    },
  }, 4);
  const before = fs.readFileSync(recordPath);

  assert.throws(
    () => planIdentityMigration({
      projectRoot: project,
      mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
    }),
    /cannot be reserialized|byte-sensitive signed lineage|signed.*canonical/u,
  );
  assert.deepEqual(fs.readFileSync(recordPath), before);
});

test("identity migration binds modes for untouched canonical inputs in the reviewed snapshot", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX file modes are not enforceable on Windows");
    return;
  }
  const project = isolatedProject(t, "identity-untouched-mode-snapshot-");
  const sourcePath = path.join(project, ".sdlc", "project.json");
  const untouchedPath = path.join(project, ".sdlc", "untouched.json");
  writeJson(sourcePath, { id: "PROJECT-MODE-SNAPSHOT", actor: { email: SOURCE_EMAIL } });
  writeJson(untouchedPath, { id: "UNTOUCHED-MODE-SNAPSHOT" });
  fs.chmodSync(untouchedPath, 0o600);
  const plan = planIdentityMigration({
    projectRoot: project,
    mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
  });
  fs.chmodSync(untouchedPath, 0o644);

  assert.throws(() => applyIdentityMigration(plan), /changed after planning|mode changed|snapshot/u);
  assert.equal(readJson(sourcePath).actor.email, SOURCE_EMAIL);
  assert.equal(fs.existsSync(path.join(project, plan.receipt_path)), false);
  assert.equal(fs.existsSync(path.join(project, ".sdlc-identity-migration.lock")), false);
});

test("identity migration rejects lossy decimals in files changed only by hash propagation", (t) => {
  const project = isolatedProject(t, "identity-transitive-lossy-decimal-");
  const sourcePath = path.join(project, ".sdlc", "source.json");
  writeJson(sourcePath, { id: "SOURCE-LOSSY-DECIMAL", actor: { email: SOURCE_EMAIL } });
  const beforeSource = fs.readFileSync(sourcePath, "utf8");
  const refPath = path.join(project, ".sdlc", "ref.json");
  const rawRef = `{
  "id": "REF-LOSSY-DECIMAL",
  "source": {
    "path": ".sdlc/source.json",
    "sha256": "${sha256(beforeSource)}"
  },
  "ratio": 0.123456789012345678901
}\n`;
  fs.writeFileSync(refPath, rawRef);

  assert.throws(
    () => planIdentityMigration({
      projectRoot: project,
      mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
    }),
    /cannot be represented losslessly|numeric literals|precision/u,
  );
  assert.equal(fs.readFileSync(refPath, "utf8"), rawRef);
  assert.equal(fs.readFileSync(sourcePath, "utf8"), beforeSource);
});

test("identity migration callbacks cannot replace the prepared root with an equivalent real directory", (t) => {
  const project = isolatedProject(t, "identity-root-inode-replacement-");
  const liveRoot = path.join(project, ".sdlc");
  writeJson(path.join(liveRoot, "project.json"), {
    id: "PROJECT-ROOT-INODE-REPLACEMENT",
    actor: { email: SOURCE_EMAIL },
  });
  const before = snapshotTree(liveRoot);
  const plan = planIdentityMigration({
    projectRoot: project,
    mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
  });

  assert.throws(
    () => applyIdentityMigration(plan, {
      rebuildDerived: ({ sdlcRoot }) => {
        const replacement = `${sdlcRoot}.replacement`;
        fs.cpSync(sdlcRoot, replacement, { recursive: true, errorOnExist: true });
        fs.rmSync(sdlcRoot, { recursive: true, force: true });
        fs.renameSync(replacement, sdlcRoot);
      },
    }),
    /rolled back|root|directory changed|callback/u,
  );
  assert.deepEqual(snapshotTree(liveRoot), before);
  assert.equal(fs.existsSync(path.join(project, ".sdlc-identity-migration.lock")), false);
});

test("identity migration recovery rejects a dangling journal symlink without changing either tree", (t) => {
  if (process.platform === "win32") {
    t.skip("directory recovery symlink semantics require POSIX permissions");
    return;
  }
  const project = isolatedProject(t, "identity-dangling-journal-");
  const liveRoot = path.join(project, ".sdlc");
  writeJson(path.join(liveRoot, "project.json"), {
    id: "PROJECT-DANGLING-JOURNAL",
    actor: { email: SOURCE_EMAIL },
  });
  const crashed = crashIdentityMigration(project, "shadow_activated");
  assert.equal(crashed.status, 86, crashed.stderr || crashed.stdout);
  const lockPath = path.join(project, ".sdlc-identity-migration.lock");
  const lock = readMigrationLock(lockPath);
  const journalPath = path.join(project, lock.journal_path);
  const backupRoot = path.join(project, lock.transaction_root, "original");
  const liveBefore = snapshotTree(liveRoot);
  const backupBefore = snapshotTree(backupRoot);
  fs.rmSync(journalPath);
  fs.symlinkSync(path.join(project, "missing-journal-target.json"), journalPath);

  assert.throws(
    () => recoverIdentityMigration({
      projectRoot: project,
      recoveryNonce: lock.nonce,
      planHash: lock.plan_hash,
    }),
    /journal is not a safe regular file|symbolic|symlink/u,
  );
  assert.deepEqual(snapshotTree(liveRoot), liveBefore);
  assert.deepEqual(snapshotTree(backupRoot), backupBefore);
  assert.equal(fs.lstatSync(journalPath).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(lockPath).isFile(), true);
});

test("identity migration fails closed before changing JSON that contains negative zero", (t) => {
  const project = isolatedProject(t, "identity-negative-zero-");
  const recordPath = path.join(project, ".sdlc", "negative-zero.json");
  const raw = `{
  "id": "NEGATIVE-ZERO",
  "owner_email": "${SOURCE_EMAIL}",
  "offset": -0
}\n`;
  fs.writeFileSync(recordPath, raw);

  assert.throws(
    () => planIdentityMigration({
      projectRoot: project,
      mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
    }),
    /cannot be represented losslessly|negative zero|numeric literal/u,
  );
  assert.equal(fs.readFileSync(recordPath, "utf8"), raw);
  assert.equal(fs.existsSync(path.join(project, ".sdlc", "migrations")), false);
});

test("identity migration receipt validator rejects incomplete occurrence accounting and control characters", (t) => {
  const project = isolatedProject(t, "identity-receipt-accounting-");
  writeJson(path.join(project, ".sdlc", "project.json"), {
    id: "PROJECT-RECEIPT-ACCOUNTING",
    actors: [{ email: SOURCE_EMAIL }, { email: SOURCE_EMAIL }],
  });
  const plan = planIdentityMigration({
    projectRoot: project,
    mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
  });
  const validReceipt = structuredClone(plan._internal.receipt);
  assert.equal(validateIdentityMigrationReceipt(validReceipt).valid, true);

  const undercounted = structuredClone(validReceipt);
  const accountedOccurrences = undercounted.changed_files
    .reduce((total, item) => total + item.identity_replacements, 0);
  undercounted.source_occurrences_before = accountedOccurrences + 1;
  rehashIdentityMigrationReceipt(undercounted);
  const undercountedValidation = validateIdentityMigrationReceipt(undercounted);
  assert.equal(undercountedValidation.valid, false);
  assert.ok(undercountedValidation.errors.some((error) => /account.*source|source.*occurrence|every source/u.test(error)));

  for (const codePoint of [0x00, 0x1f, 0x7f]) {
    const unsafePath = structuredClone(validReceipt);
    unsafePath.changed_files[0].path = `.sdlc/project${String.fromCharCode(codePoint)}.json`;
    rehashIdentityMigrationReceipt(unsafePath);
    const pathValidation = validateIdentityMigrationReceipt(unsafePath);
    assert.equal(pathValidation.valid, false, `control character U+${codePoint.toString(16)} was accepted`);
    assert.ok(pathValidation.errors.some((error) => /canonical|control|invalid.*path/u.test(error)));
  }
});

test("identity migration never exposes rollback phases to a mutating observer", (t) => {
  const project = isolatedProject(t, "identity-rollback-observer-");
  const liveRoot = path.join(project, ".sdlc");
  writeJson(path.join(liveRoot, "project.json"), {
    id: "PROJECT-ROLLBACK-OBSERVER",
    actor: { email: SOURCE_EMAIL },
  });
  const before = snapshotTree(liveRoot);
  const observedPhases = [];
  const illicitMutation = path.join(liveRoot, "observer-rollback-mutation.json");
  const plan = planIdentityMigration({
    projectRoot: project,
    mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
  });

  assert.throws(
    () => applyIdentityMigration(plan, {
      rebuildDerived: () => { throw new Error("force rollback for observer policy test"); },
      transactionObserver: ({ phase }) => {
        observedPhases.push(phase);
        if (["rolling_back", "rolled_back", "rollback_failed"].includes(phase)) {
          writeJson(illicitMutation, { phase, persisted: true });
        }
      },
    }),
    /rolled back/u,
  );
  assert.equal(
    observedPhases.some((phase) => ["rolling_back", "rolled_back", "rollback_failed"].includes(phase)),
    false,
  );
  assert.deepEqual(snapshotTree(liveRoot), before);
  assert.equal(fs.existsSync(illicitMutation), false);
  assert.equal(fs.existsSync(path.join(project, ".sdlc-identity-migration.lock")), false);
  assert.deepEqual(
    fs.readdirSync(project).filter((name) => name.startsWith(".sdlc-identity-migration-txn-")),
    [],
  );
});

test("identity migration does not infer signed canonicalization from unrelated nested metadata", (t) => {
  const project = isolatedProject(t, "identity-unrelated-nested-canonicalization-");
  const recordPath = path.join(project, ".sdlc", "signed-with-unrelated-canonicalization.json");
  writeJsonWithIndent(recordPath, {
    audit: { git: { user: { email: SOURCE_EMAIL } } },
    signed_envelope: {
      schema_version: "external-signed:v1",
      payload: { id: "EXTERNAL-PAYLOAD", owner: "external@example.test" },
      signatureValue: "provider-defined-detached-signature",
      unrelated_cache_metadata: {
        canonicalization: "stable-json",
        cache_key: "not-signature-metadata",
      },
    },
  }, 4);
  const before = fs.readFileSync(recordPath);

  assert.throws(
    () => planIdentityMigration({
      projectRoot: project,
      mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
    }),
    /cannot be reserialized|byte-sensitive signed lineage|signed.*canonical/u,
  );
  assert.deepEqual(fs.readFileSync(recordPath), before);
});

test("identity migration rejects unsupported raw-v2 hashes for materialized changing references", (t) => {
  const project = isolatedProject(t, "identity-unsupported-reference-algorithm-");
  const targetPath = path.join(project, ".sdlc", "evidence", "identity.json");
  writeJson(targetPath, { owner_email: SOURCE_EMAIL });
  const targetBytes = fs.readFileSync(targetPath);
  const registryPath = path.join(project, ".sdlc", "registry.json");
  writeJson(registryPath, {
    id: "REGISTRY-UNSUPPORTED-REFERENCE-ALGORITHM",
    audit: { owner_email: SOURCE_EMAIL },
    evidence: {
      path: ".sdlc/evidence/identity.json",
      sha256: sha256(targetBytes),
      hash_algorithm: "sha256:raw:v2",
    },
  });
  const before = snapshotTree(path.join(project, ".sdlc"));

  assert.throws(
    () => planIdentityMigration({
      projectRoot: project,
      mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
    }),
    /unsupported.*(?:hash|algorithm)|sha256:raw:v2|file reference|byte-sensitive opaque lineage/u,
  );
  assert.deepEqual(snapshotTree(path.join(project, ".sdlc")), before);
});

test("identity migration detects identities encoded with JSON unicode escapes", (t) => {
  const project = isolatedProject(t, "identity-json-escaped-email-");
  const recordPath = path.join(project, ".sdlc", "escaped-email.json");
  const escapedEmail = SOURCE_EMAIL.replace("@", "\\u0040");
  const raw = `{
  "id": "ESCAPED-EMAIL",
  "owner_email": "${escapedEmail}"
}\n`;
  fs.writeFileSync(recordPath, raw);

  const plan = planIdentityMigration({
    projectRoot: project,
    mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
  });
  assert.equal(plan.status, "ready");
  assert.ok(plan.source_occurrences_before >= 1);
  applyIdentityMigration(plan);
  assert.equal(readJson(recordPath).owner_email, TARGET_EMAIL);
  assert.equal(fs.readFileSync(recordPath, "utf8").includes(escapedEmail), false);
});

test("identity migration detects JSON-escaped source identities in excluded lock state", (t) => {
  const project = isolatedProject(t, "identity-json-escaped-lock-");
  writeJson(path.join(project, ".sdlc", "project.json"), {
    id: "PROJECT-ESCAPED-LOCK",
    actor: { email: SOURCE_EMAIL },
  });
  const lockStatePath = path.join(project, ".sdlc", "locks", "owner.json");
  fs.mkdirSync(path.dirname(lockStatePath), { recursive: true });
  const escapedEmail = SOURCE_EMAIL.replace("@", "\\u0040");
  fs.writeFileSync(lockStatePath, `{"owner_email":"${escapedEmail}"}\n`);
  const before = snapshotTree(path.join(project, ".sdlc"));

  assert.throws(
    () => planIdentityMigration({
      projectRoot: project,
      mapping: { source: { email: SOURCE_EMAIL }, target: { email: TARGET_EMAIL } },
    }),
    /excluded SDLC state|locks/u,
  );
  assert.deepEqual(snapshotTree(path.join(project, ".sdlc")), before);
});

test("identity migration WAL remains recoverable when the first durable anchor fsync reports EIO", (t) => {
  const project = isolatedProject(t, "identity-anchor-fsync-eio-");
  const projectPath = path.join(project, ".sdlc", "project.json");
  writeJson(projectPath, {
    id: "PROJECT-ANCHOR-FSYNC-EIO",
    actor: { email: SOURCE_EMAIL },
  });
  const before = snapshotTree(path.join(project, ".sdlc"));
  const moduleUrl = new URL("../../lib/identity-migration.mjs", import.meta.url).href;
  const script = `
    import fs from "node:fs";
    import { applyIdentityMigration, planIdentityMigration } from ${JSON.stringify(moduleUrl)};
    const originalWriteFileSync = fs.writeFileSync.bind(fs);
    const originalFsyncSync = fs.fsyncSync.bind(fs);
    let anchorPending = false;
    let injected = false;
    fs.writeFileSync = (...args) => {
      const value = typeof args[1] === "string" ? args[1] : String(args[1]);
      const result = originalWriteFileSync(...args);
      if (!injected && value.includes('"schema_version":"identity-migration-lock-anchor:v1"')) {
        anchorPending = true;
      }
      return result;
    };
    fs.fsyncSync = (descriptor) => {
      const result = originalFsyncSync(descriptor);
      if (anchorPending && !injected) {
        anchorPending = false;
        injected = true;
        const error = new Error("simulated durable anchor fsync EIO");
        error.code = "EIO";
        throw error;
      }
      return result;
    };
    let applyError = null;
    try {
      const plan = planIdentityMigration({
        projectRoot: ${JSON.stringify(project)},
        mapping: {
          source: { email: ${JSON.stringify(SOURCE_EMAIL)} },
          target: { email: ${JSON.stringify(TARGET_EMAIL)} },
        },
      });
      applyIdentityMigration(plan);
    } catch (error) {
      applyError = error.message;
    } finally {
      fs.writeFileSync = originalWriteFileSync;
      fs.fsyncSync = originalFsyncSync;
    }
    process.stdout.write(JSON.stringify({ injected, applyError }));
  `;
  const child = childProcess.spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const childResult = JSON.parse(child.stdout);
  assert.equal(childResult.injected, true);
  assert.match(childResult.applyError || "", /EIO|rolled back|recovery/u);

  const lockPath = path.join(project, ".sdlc-identity-migration.lock");
  if (fs.existsSync(lockPath)) {
    const lines = fs.readFileSync(lockPath, "utf8")
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const generations = [lines[0].generation, ...lines.slice(1).map((anchor) => anchor.record.generation)];
    assert.equal(new Set(generations).size, generations.length, "WAL generations must never repeat");
    for (let index = 1; index < generations.length; index += 1) {
      assert.equal(generations[index], generations[index - 1] + 1, "WAL generations must be contiguous");
    }
    const lock = readMigrationLock(lockPath);
    const recovered = recoverIdentityMigration({
      projectRoot: project,
      recoveryNonce: lock.nonce,
      planHash: lock.plan_hash,
    });
    assert.ok(["rolled_back", "cleared_before_swap"].includes(recovered.status));
  }
  assert.deepEqual(snapshotTree(path.join(project, ".sdlc")), before);
  assert.equal(readJson(projectPath).actor.email, SOURCE_EMAIL);
  assert.equal(fs.existsSync(lockPath), false);
  assert.deepEqual(
    fs.readdirSync(project).filter((name) =>
      name.startsWith(".sdlc-identity-migration-txn-")
      || name.startsWith(".sdlc-identity-migration-journal-")),
    [],
  );
});

function isolatedProject(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".sdlc"), { recursive: true });
  return root;
}

function crashIdentityMigration(project, crashPhase, createdAt = "2026-07-17T12:34:56.000Z") {
  const moduleUrl = new URL("../../lib/identity-migration.mjs", import.meta.url).href;
  const script = `
    import { applyIdentityMigration, planIdentityMigration } from ${JSON.stringify(moduleUrl)};
    const plan = planIdentityMigration({
      projectRoot: ${JSON.stringify(project)},
      mapping: {
        source: { email: ${JSON.stringify(SOURCE_EMAIL)} },
        target: { email: ${JSON.stringify(TARGET_EMAIL)}, name: "Current User" },
      },
      createdAt: ${JSON.stringify(createdAt)},
    });
    applyIdentityMigration(plan, {
      transactionObserver: ({ phase }) => {
        if (phase === ${JSON.stringify(crashPhase)}) process.exit(86);
      },
    });
  `;
  return childProcess.spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8",
  });
}

function findRecoveryClaims(project) {
  return fs.readdirSync(project).filter((name) => name.startsWith(".sdlc-identity-migration-recovery-"));
}

function identitySubject(email, name = "Legacy User") {
  return {
    kind: "assessment_proposal",
    id: "SUBJECT-IDENTITY",
    hash: "c".repeat(64),
    owner: { id: "identity-owner", type: "human", name, email },
  };
}

function canonicalAuthorization({ id, subject, actions }) {
  return createAuthorizationSnapshot({
    id,
    proposal_ref: {
      id: "PROPOSAL-CANONICAL",
      path: ".sdlc/proposals/PROPOSAL-CANONICAL.json",
      hash: "a".repeat(64),
    },
    allowed_uses: actions.map((action) => ({ action, subject })),
    scope: { project: "identity-migration-fixture" },
    use_policy: {
      mode: "bounded",
      max_uses: 10,
      close_on_workflow_terminal: true,
      require_usage_receipt: true,
      replay: "allow",
    },
    authority_assurance: {
      mode: "audit_only",
      source: "declared_cli_attribution",
      verified: false,
      receipt_ref: null,
      limitation: "Synthetic test fixture without host authority.",
    },
    valid_from: "2026-07-17T09:00:00.000Z",
    expires_at: "2026-07-17T18:00:00.000Z",
    granted_by: { id: "legacy-user", type: "human", name: "Legacy User", email: SOURCE_EMAIL },
    approval_source: "explicit-user",
  });
}

function asCanonicalV1Authorization(snapshot) {
  const authorization = structuredClone(snapshot);
  authorization.schema_version = "content-authorization:v1";
  authorization.version = 1;
  delete authorization.allowed_uses;
  delete authorization.authorization_hash;
  delete authorization.hash_algorithm;
  authorization.authorization_hash = computeAuthorizationHash(authorization);
  authorization.hash_algorithm = "sha256:stable-json:v1";
  return authorization;
}

function asCanonicalV1Receipt(value) {
  const receipt = structuredClone(value);
  receipt.schema_version = "authorization-usage-receipt:v1";
  receipt.version = 1;
  delete receipt.use_hash;
  delete receipt.receipt_hash;
  delete receipt.hash_algorithm;
  receipt.receipt_hash = computeStableHash(receipt);
  receipt.hash_algorithm = "sha256:stable-json:v1";
  return receipt;
}

function fixtureProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "identity-migration-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sdlc = path.join(root, ".sdlc");
  for (const directory of [
    "authorization-uses/AUTH-1",
    "authorizations",
    "baseline",
    "cache",
    "contracts",
    "indexes",
    "reports",
  ]) fs.mkdirSync(path.join(sdlc, directory), { recursive: true });

  writeJson(path.join(sdlc, "project.json"), {
    id: "PROJECT-1",
    audit: { git: { user: { name: "Legacy User", email: SOURCE_EMAIL } } },
  });
  const baselinePath = path.join(sdlc, "baseline", "BASELINE-1.json");
  const baseline = {
    id: "BASELINE-1",
    status: "approved",
    repository_snapshot: { git: { user: { name: "Legacy User", email: SOURCE_EMAIL } } },
    approvals: [{ id: "APPROVAL-BASELINE", approved_content_hash: null, hash_algorithm: "sha256:stable-json:v1" }],
    audit: { git: { user: { email: SOURCE_EMAIL } } },
  };
  baseline.approvals[0].approved_content_hash = hashApprovalSubject(baseline);
  writeJson(baselinePath, baseline);

  const authorization = {
    id: "AUTH-1",
    kind: "content_authorization",
    schema_version: "authorization:v3",
    status: "active",
    scope: "fixture",
    summary: "fixture",
    allowed_actions: ["contract.approve"],
    allowed_uses: [{ action: "contract.approve", subject_id: "CONTRACT-1", use_hash: computeStableHash({ action: "contract.approve", subject_id: "CONTRACT-1" }) }],
    allowed_artifact_types: [],
    allowed_approval_boundaries: [],
    allowed_subjects: ["CONTRACT-1"],
    proposal_ref: null,
    use_policy: { replay: "deny_same_action_subject", max_uses: null },
    authority_assurance: "audit_only",
    expires_at: null,
    approval_source: "explicit-user",
    approval_evidence: [],
    granted_by: { id: "user", type: "human", email: SOURCE_EMAIL },
    created_at: "2026-07-17T10:00:00.000Z",
    updated_at: "2026-07-17T10:00:00.000Z",
    audit: { git: { user: { email: SOURCE_EMAIL } } },
    hash_algorithm: "sha256:stable-json:v2",
  };
  authorization.approved_content_hash = hashLegacyAuthorization(authorization);
  writeJson(path.join(sdlc, "authorizations", "AUTH-1.json"), authorization);

  const usage = {
    id: "USE-1",
    kind: "authorization_usage_receipt",
    schema_version: "authorization-usage-receipt:legacy-v2",
    authorization_id: "AUTH-1",
    authorization_hash: authorization.approved_content_hash,
    action: "contract.approve",
    subject_id: "CONTRACT-1",
    authorization_snapshot: {
      status_at_use: "active",
      allowed_actions: ["contract.approve"],
      allowed_subjects: ["CONTRACT-1"],
      allowed_uses: authorization.allowed_uses,
    },
    status: "accepted",
    valid_at_use: true,
    used_at: "2026-07-17T10:01:00.000Z",
  };
  usage.receipt_hash = computeStableHash(usage);
  usage.hash_algorithm = "sha256:stable-json:v1";
  writeJson(path.join(sdlc, "authorization-uses", "AUTH-1", "USE-1.json"), usage);

  const baselineBytes = fs.readFileSync(baselinePath, "utf8");
  const contract = {
    id: "CONTRACT-1",
    status: "approved",
    contextualization: {
      context_sources: [{
        path: ".sdlc/baseline/BASELINE-1.json",
        sha256: sha256(baselineBytes),
        size_bytes: Buffer.byteLength(baselineBytes),
        excerpt: SOURCE_EMAIL,
      }],
    },
    approvals: [{ id: "APPROVAL-CONTRACT", approved_content_hash: null, hash_algorithm: "sha256:stable-json:v1" }],
    audit: { git: { user: { email: SOURCE_EMAIL } } },
  };
  contract.approvals[0].approved_content_hash = hashApprovalSubject(contract);
  writeJson(path.join(sdlc, "contracts", "CONTRACT-1.json"), contract);
  writeJson(path.join(sdlc, "reports", "task-start.json"), {
    contract_id: "CONTRACT-1",
    contract_approval_hash: contract.approvals[0].approved_content_hash,
  });
  writeJson(path.join(sdlc, "cache", "kb-cache.json"), { search_text: SOURCE_EMAIL });
  writeJson(path.join(sdlc, "indexes", "kb-index.json"), { search_text: SOURCE_EMAIL });
  return root;
}

function hashLegacyAuthorization(record) {
  const subject = omitKeys(record, [
    "approved_content_hash",
    "hash_algorithm",
    "status",
    "updated_at",
    "revoked_at",
    "revocation_reason",
    "consumed_at",
    "closed_at",
    "closed_reason",
    "use_count",
  ]);
  return hashApprovalSubject(subject);
}

function hashApprovalSubject(value) {
  return computeStableHash(stripApprovalVolatileFields(value));
}

function stripApprovalVolatileFields(value, depth = 0) {
  if (Array.isArray(value)) return value.map((item) => stripApprovalVolatileFields(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  const volatile = depth === 0
    ? new Set(["__path", "__relative_path", "approvals", "audit", "created_at", "updated_at", "approved_at", "approved_by", "status"])
    : new Set();
  return Object.fromEntries(
    Object.keys(value).sort().filter((key) => !volatile.has(key)).map((key) => [key, stripApprovalVolatileFields(value[key], depth + 1)]),
  );
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonWithIndent(filePath, value, spaces) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, spaces)}\n`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readMigrationLock(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  try {
    return JSON.parse(raw);
  } catch {
    const lines = raw.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
    return lines.slice(1).reduce((record, anchor) => anchor.record || record, lines[0]);
  }
}

function snapshotTree(root) {
  const snapshot = {};
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(filePath);
      else snapshot[path.relative(root, filePath)] = fs.readFileSync(filePath, "utf8");
    }
  };
  visit(root);
  return snapshot;
}

function readTreeText(root) {
  return Object.values(snapshotTree(root)).join("\n");
}

function rehashIdentityMigrationReceipt(receipt) {
  receipt.receipt_hash = computeStableHash(omitKeys(receipt, ["receipt_hash", "hash_algorithm"]));
  return receipt;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}
