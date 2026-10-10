import "../helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { computeStableHash, omitKeys } from "../../lib/canonical.mjs";
import { createCommandSubject } from "../../lib/governance/command-subject.mjs";
import { validateAgainstSchema } from "../../lib/json-schema-validator.mjs";
import {
  MAX_EXACT_MUTATION_BATCH,
  DEFAULT_GOVERNANCE_AUDIT_EVENTS_ROOT,
  MAX_GOVERNANCE_AUDIT_EVENT_BYTES,
  MAX_GOVERNANCE_AUDIT_EVENT_FILES,
  MutationGovernanceError,
  appendJsonLineNoFollow,
  assertMutationExecutionAuthorized,
  consumeBootstrapMutationGrant,
  createBootstrapMutationGrant,
  createProjectMutationGovernance,
  currentMutationGovernance,
  normalizeProjectMutationPath,
  runWithMutationGovernance,
  withGovernedMutation,
  withGovernedMutationBatch,
} from "../../lib/governance/mutation-guard.mjs";
import {
  createGovernancePolicy,
  createGovernanceRevocation,
  evaluateGovernancePolicy,
} from "../../lib/governance/policy-engine.mjs";
import { requireSymlinkSupport } from "../helpers/symlink-support.mjs";

const ACTOR = Object.freeze({ type: "agent", id: "writer-1" });
const NOW = "2026-07-18T12:00:00.000Z";
const EVIDENCE_HASH = computeStableHash({ contract: "exact" });
const EXACT_EVIDENCE = Object.freeze([{ kind: "contract", id: "CONTRACT-1", hash: EVIDENCE_HASH }]);

function fixture(t, label = "guard") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `agentic-sdlc-${label}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function mutationSubject({ action = "story.update", commandPath = "story update", operation = "file.write", projectPath = ".sdlc/story.json", evidence = EXACT_EVIDENCE } = {}) {
  return createCommandSubject({
    command_path: commandPath,
    canonical_action: action,
    scope_refs: [
      { kind: "mutation_operation", id: operation },
      { kind: "project_path", id: projectPath },
    ],
    evidence_refs: evidence,
  });
}

function policyFor(subject) {
  return createGovernancePolicy({
    id: "POLICY-MUTATION-1",
    valid_from: "2026-07-18T00:00:00.000Z",
    expires_at: "2026-07-19T00:00:00.000Z",
    decision_ttl_seconds: 600,
    role_bindings: [{ id: "BIND-WRITER", role: "writer", actor: ACTOR }],
    rules: [{
      id: "ALLOW-EXACT-MUTATION",
      effect: "allow",
      action: subject.command.action,
      scope_refs: subject.scope_refs,
      evidence_refs: subject.evidence_refs,
      actor_roles: ["writer"],
    }],
  });
}

function guardedContext(root, overrides = {}) {
  const subject = mutationSubject(overrides);
  const policy = overrides.policy ?? policyFor(subject);
  let sequence = 0;
  return {
    mode: overrides.mode ?? "enforce",
    fail_closed: true,
    root,
    canonical_action: overrides.contextAction ?? "story.update",
    command_path: overrides.contextCommandPath ?? "story update",
    evidence_refs: overrides.contextEvidence ?? EXACT_EVIDENCE,
    observations: overrides.observations ?? [],
    now: overrides.now ?? (() => NOW),
    decision_provider: overrides.decisionProvider ?? (({ subject: actual }) => evaluateGovernancePolicy({
      policy,
      subject: actual,
      actor: ACTOR,
      evaluated_at: NOW,
      decision_id: `DECISION-${++sequence}`,
    })),
  };
}

test("enforce decides synchronously before the first byte and binds lower writer gateways", () => {
  const root = fixture(test, "before-byte");
  const target = path.join(root, ".sdlc", "story.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const context = guardedContext(root);

  runWithMutationGovernance(context, () => {
    withGovernedMutation({ operation: "file.write", path: target }, () => {
      assert.equal(assertMutationExecutionAuthorized({ operation: "file.write", path: target }), true);
      fs.writeFileSync(target, "allowed");
    });
  });
  assert.equal(fs.readFileSync(target, "utf8"), "allowed");

  const deniedTarget = path.join(root, ".sdlc", "denied.json");
  let callbackStarted = false;
  assert.throws(
    () => runWithMutationGovernance(context, () => withGovernedMutation(
      { operation: "file.write", path: deniedTarget },
      () => {
        callbackStarted = true;
        fs.writeFileSync(deniedTarget, "must-not-exist");
      },
    )),
    (error) => error instanceof MutationGovernanceError && error.code === "MUTATION_GOVERNANCE_DENIED",
  );
  assert.equal(callbackStarted, false);
  assert.equal(fs.existsSync(deniedTarget), false);
});

test("action, operation, path, and evidence must all match exactly", () => {
  const root = fixture(test, "exact-target");
  fs.mkdirSync(path.join(root, ".sdlc"), { recursive: true });
  const exactPath = path.join(root, ".sdlc", "story.json");
  const context = guardedContext(root);
  const variants = [
    { operation: "file.remove", path: exactPath },
    { canonical_action: "story.complete", operation: "file.write", path: exactPath },
    { operation: "file.write", path: path.join(root, ".sdlc", "other.json") },
    {
      operation: "file.write",
      path: exactPath,
      evidence_refs: [{ kind: "contract", id: "CONTRACT-1", hash: "0".repeat(64) }],
    },
  ];
  for (const variant of variants) {
    assert.throws(
      () => runWithMutationGovernance(context, () => withGovernedMutation(variant, () => assert.fail("denied callback ran"))),
      /no approval for this exact action and file/u,
    );
  }
});

test("disabled preserves 0.11 behavior, audit observes failures, and enforce blocks them", () => {
  const root = fixture(test, "modes");
  const target = path.join(root, "record.json");
  let disabledRan = false;
  runWithMutationGovernance({ mode: "disabled", root }, () => {
    withGovernedMutation(null, () => { disabledRan = true; });
  });
  assert.equal(disabledRan, true);

  const observations = [];
  let auditRan = false;
  runWithMutationGovernance(guardedContext(root, {
    mode: "audit",
    observations,
    decisionProvider: () => { throw new Error("unavailable evaluator"); },
  }), () => {
    withGovernedMutation({ operation: "file.write", path: target }, () => { auditRan = true; });
  });
  assert.equal(auditRan, true);
  assert.equal(observations.at(-1).allowed, false);
  assert.deepEqual(observations.at(-1).reason_codes, ["mutation.decision_error"]);

  let enforceRan = false;
  assert.throws(
    () => runWithMutationGovernance(guardedContext(root, {
      decisionProvider: () => { throw new Error("unavailable evaluator"); },
    }), () => withGovernedMutation({ operation: "file.write", path: target }, () => { enforceRan = true; })),
    /no approval for this exact action and file/u,
  );
  assert.equal(enforceRan, false);
});

test("missing, unknown, and asynchronous decisions fail closed", () => {
  const root = fixture(test, "metadata");
  const target = path.join(root, "record.json");
  assert.throws(
    () => runWithMutationGovernance({
      mode: "enforce",
      fail_closed: true,
      root,
      canonical_action: "story.update",
      command_path: "story update",
      decision_provider: () => Promise.resolve({ decision: "allow" }),
    }, () => withGovernedMutation({ operation: "file.write", path: target }, () => assert.fail("async allow ran"))),
    /no approval for this exact action and file/u,
  );
  assert.throws(
    () => runWithMutationGovernance(guardedContext(root), () => withGovernedMutation({}, () => assert.fail("missing ran"))),
    (error) => error.code === "MUTATION_METADATA_MISSING",
  );
  assert.throws(
    () => runWithMutationGovernance({
      mode: "enforce",
      root,
      canonical_action: "unknown command*",
      command_path: "unknown command",
    }, () => {}),
    (error) => error.code === "MUTATION_METADATA_MISSING",
  );
});

test("path normalization rejects traversal, globs, and root writes", () => {
  const root = fixture(test, "paths");
  fs.mkdirSync(path.join(root, "safe"));
  assert.equal(normalizeProjectMutationPath(root, path.join(root, "safe", "file.json")), "safe/file.json");
  assert.throws(() => normalizeProjectMutationPath(root, root), /inside the project root/u);
  assert.throws(() => normalizeProjectMutationPath(root, "../outside.json"), /inside the project root/u);
  assert.throws(() => normalizeProjectMutationPath(root, "safe/*.json"), /glob/u);
});

test("path normalization rejects symlink escapes", (t) => {
  if (!requireSymlinkSupport(t, "dir")) return;
  const root = fixture(t, "paths-symlink");
  const outside = fixture(t, "outside-symlink");
  fs.mkdirSync(path.join(root, "safe"));
  fs.symlinkSync(outside, path.join(root, "safe", "linked"), "dir");
  assert.throws(() => normalizeProjectMutationPath(root, path.join(root, "safe", "linked", "file.json")), /symbolic link/u);
});

test("AsyncLocalStorage isolates concurrent commands and prevents nested downgrades", async () => {
  const rootA = fixture(test, "concurrent-a");
  const rootB = fixture(test, "concurrent-b");
  const pathA = path.join(rootA, ".sdlc", "story.json");
  const pathB = path.join(rootB, ".sdlc", "story.json");
  fs.mkdirSync(path.dirname(pathA), { recursive: true });
  fs.mkdirSync(path.dirname(pathB), { recursive: true });
  const seen = [];
  await Promise.all([
    runWithMutationGovernance(guardedContext(rootA), async () => {
      await new Promise((resolve) => setImmediate(resolve));
      seen.push(currentMutationGovernance().root);
      withGovernedMutation({ operation: "file.write", path: pathA }, () => fs.writeFileSync(pathA, "A"));
    }),
    runWithMutationGovernance(guardedContext(rootB), async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      seen.push(currentMutationGovernance().root);
      withGovernedMutation({ operation: "file.write", path: pathB }, () => fs.writeFileSync(pathB, "B"));
    }),
  ]);
  assert.deepEqual(new Set(seen), new Set([rootA, rootB]));
  assert.equal(fs.readFileSync(pathA, "utf8"), "A");
  assert.equal(fs.readFileSync(pathB, "utf8"), "B");

  assert.throws(
    () => runWithMutationGovernance(guardedContext(rootA), () =>
      runWithMutationGovernance({ mode: "audit", root: rootA }, () => assert.fail("downgrade ran"))),
    (error) => error.code === "MUTATION_GOVERNANCE_DOWNGRADE",
  );

  const bypassTarget = path.join(rootA, ".sdlc", "nested-bypass.json");
  const outerDeny = guardedContext(rootA, {
    decisionProvider: () => { throw new Error("outer policy denies"); },
  });
  assert.throws(
    () => runWithMutationGovernance(outerDeny, () =>
      runWithMutationGovernance(guardedContext(rootA), () =>
        withGovernedMutation({ operation: "file.write", path: bypassTarget }, () => {
          fs.writeFileSync(bypassTarget, "bypassed");
        }))),
    (error) => error.code === "MUTATION_GOVERNANCE_CONTEXT_REPLACEMENT",
  );
  assert.equal(fs.existsSync(bypassTarget), false);
});

test("authorization tokens expire with their callback and remain active only until an async callback settles", async () => {
  const root = fixture(test, "authorization-lifecycle");
  const target = path.join(root, ".sdlc", "story.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let detachedResult;
  let settleDetached;
  const detached = new Promise((resolve) => { settleDetached = resolve; });

  await runWithMutationGovernance(guardedContext(root), async () => {
    await withGovernedMutation({ operation: "file.write", path: target }, async () => {
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(assertMutationExecutionAuthorized({ operation: "file.write", path: target }), true);
    });
    withGovernedMutation({ operation: "file.write", path: target }, () => {
      setImmediate(() => {
        try {
          assertMutationExecutionAuthorized({ operation: "file.write", path: target });
          detachedResult = null;
        } catch (error) {
          detachedResult = error;
        } finally {
          settleDetached();
        }
      });
    });
    await detached;
  });
  assert.equal(detachedResult?.code, "MUTATION_GOVERNANCE_DENIED");
  assert.deepEqual(detachedResult?.details?.reason_codes, ["mutation.authorization_inactive"]);
});

test("a gateway rechecks expiration before the first byte", () => {
  const root = fixture(test, "authorization-expiry");
  const target = path.join(root, ".sdlc", "story.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let checkedAt = NOW;
  const context = guardedContext(root, { now: () => checkedAt });
  assert.throws(
    () => runWithMutationGovernance(context, () => withGovernedMutation(
      { operation: "file.write", path: target },
      () => {
        checkedAt = "2026-07-18T12:10:00.000Z";
        assertMutationExecutionAuthorized({ operation: "file.write", path: target });
        fs.writeFileSync(target, "must-not-exist");
      },
    )),
    (error) => error.code === "MUTATION_GOVERNANCE_DENIED"
      && error.details.reason_codes.includes("mutation.authorization_expired"),
  );
  assert.equal(fs.existsSync(target), false);
});

test("pointer governance persists exact receipts and reloads revocations before use", () => {
  const root = fixture(test, "receipts-and-revocation");
  const governanceRoot = path.join(root, ".sdlc", "governance");
  const target = path.join(root, ".sdlc", "story.json");
  fs.mkdirSync(governanceRoot, { recursive: true });
  const subject = mutationSubject();
  const policy = policyFor(subject);
  fs.writeFileSync(path.join(governanceRoot, "policy.json"), `${JSON.stringify(policy)}\n`);
  const pointer = {
    mode: "enforce",
    policy_file: ".sdlc/governance/policy.json",
    decision_receipts_root: ".sdlc/governance/decisions",
    use_receipts_root: ".sdlc/governance/uses",
    revocations_root: ".sdlc/governance/revocations",
    fail_closed: true,
  };
  const governance = () => createProjectMutationGovernance({
    root,
    governance_policy: pointer,
    canonical_action: "story.update",
    command_path: "story update",
    verified_actor: { verified: true, assurance: "host_verified", actor: ACTOR },
    evidence_paths: [],
    now: () => NOW,
  });

  runWithMutationGovernance(governance(), () => {
    withGovernedMutation({ operation: "file.write", path: target, evidence_refs: EXACT_EVIDENCE }, () => {
      assertMutationExecutionAuthorized({ operation: "file.write", path: target, evidence_refs: EXACT_EVIDENCE });
      fs.writeFileSync(target, "allowed");
    });
  });
  const decisions = fs.readdirSync(path.join(governanceRoot, "decisions"));
  const uses = fs.readdirSync(path.join(governanceRoot, "uses"));
  assert.equal(decisions.length, 1);
  assert.equal(uses.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(governanceRoot, "decisions", decisions[0]), "utf8")).kind, "governance_policy_decision");
  assert.equal(JSON.parse(fs.readFileSync(path.join(governanceRoot, "uses", uses[0]), "utf8")).kind, "governance_policy_use_receipt");

  const deniedTarget = path.join(root, ".sdlc", "story-revoked.json");
  const revokedSubject = mutationSubject({ projectPath: ".sdlc/story-revoked.json" });
  const revokedPolicy = policyFor(revokedSubject);
  fs.writeFileSync(path.join(governanceRoot, "policy.json"), `${JSON.stringify(revokedPolicy)}\n`);
  const revocationsRoot = path.join(governanceRoot, "revocations");
  fs.mkdirSync(revocationsRoot);
  const revokedGovernance = createProjectMutationGovernance({
    root,
    governance_policy: pointer,
    canonical_action: "story.update",
    command_path: "story update",
    verified_actor: { verified: true, assurance: "host_verified", actor: ACTOR },
    evidence_paths: [],
    now: () => NOW,
  });
  assert.throws(
    () => runWithMutationGovernance(revokedGovernance, () => withGovernedMutation(
      { operation: "file.write", path: deniedTarget, evidence_refs: EXACT_EVIDENCE },
      () => {
        const issuedDecision = revokedGovernance.observations.at(-1).decision;
        const revocation = createGovernanceRevocation({
          id: "REVOKE-DECISION-BEFORE-USE",
          target: { kind: "decision", id: issuedDecision.id, hash: issuedDecision.decision_hash },
          effective_at: NOW,
          reason: "Revoke between decision and physical use",
          revoked_by: { type: "human", id: "security-1" },
        });
        fs.writeFileSync(path.join(revocationsRoot, "revoke-policy.json"), `${JSON.stringify(revocation)}\n`);
        assertMutationExecutionAuthorized({ operation: "file.write", path: deniedTarget, evidence_refs: EXACT_EVIDENCE });
        fs.writeFileSync(deniedTarget, "must-not-exist");
      },
    )),
    (error) => error.code === "MUTATION_GOVERNANCE_DENIED"
      && error.details.reason_codes.includes("mutation.authorization_revalidation_failed"),
  );
  assert.equal(fs.existsSync(deniedTarget), false);
});

test("audit pointer persists bounded immutable deny and error events but no allow event", () => {
  const root = fixture(test, "audit-events");
  const governanceRoot = path.join(root, ".sdlc", "governance");
  const allowedTarget = path.join(root, ".sdlc", "story.json");
  const deniedTarget = path.join(root, ".sdlc", "story-denied.json");
  const errorTarget = path.join(root, ".sdlc", "story-error.json");
  fs.mkdirSync(governanceRoot, { recursive: true });
  const policyPath = path.join(governanceRoot, "policy.json");
  fs.writeFileSync(policyPath, `${JSON.stringify(policyFor(mutationSubject()))}\n`);
  const pointer = {
    mode: "audit",
    policy_file: ".sdlc/governance/policy.json",
    decision_receipts_root: ".sdlc/governance/decisions",
    use_receipts_root: ".sdlc/governance/uses",
    revocations_root: ".sdlc/governance/revocations",
    fail_closed: false,
  };
  const createGovernance = () => createProjectMutationGovernance({
    root,
    governance_policy: pointer,
    canonical_action: "story.update",
    command_path: "story update",
    actor: ACTOR,
    evidence_paths: [],
    now: () => NOW,
  });
  const auditRoot = path.join(root, ...DEFAULT_GOVERNANCE_AUDIT_EVENTS_ROOT.split("/"));

  runWithMutationGovernance(createGovernance(), () => withGovernedMutation({
    operation: "file.write",
    path: deniedTarget,
    evidence_refs: EXACT_EVIDENCE,
  }, () => fs.writeFileSync(deniedTarget, "audit continued")));
  const afterDeny = fs.readdirSync(auditRoot);
  assert.equal(afterDeny.length, 1);

  runWithMutationGovernance(createGovernance(), () => withGovernedMutation({
    operation: "file.write",
    path: allowedTarget,
    evidence_refs: EXACT_EVIDENCE,
  }, () => {
    assertMutationExecutionAuthorized({
      operation: "file.write",
      path: allowedTarget,
      evidence_refs: EXACT_EVIDENCE,
    });
    fs.writeFileSync(allowedTarget, "allowed");
  }));
  assert.equal(fs.readdirSync(auditRoot).length, 1, "allowed decisions must not create audit-miss events");

  fs.writeFileSync(policyPath, "secret-token-must-not-be-persisted");
  runWithMutationGovernance(createGovernance(), () => withGovernedMutation({
    operation: "file.write",
    path: errorTarget,
    evidence_refs: EXACT_EVIDENCE,
  }, () => fs.writeFileSync(errorTarget, "audit continued after policy error")));
  const eventNames = fs.readdirSync(auditRoot).sort();
  assert.equal(eventNames.length, 2);
  assert.equal(eventNames.some((name) => name.endsWith(".lock")), false);
  assert.equal(fs.existsSync(`${auditRoot}.lock`), false);
  const events = eventNames.map((name) => {
    assert.match(name, /^event-[a-f0-9]{64}\.json$/u);
    const eventPath = path.join(auditRoot, name);
    assert.equal(fs.lstatSync(eventPath).isSymbolicLink(), false);
    // Node applies creation modes on POSIX. Windows reports synthesized mode
    // bits and protects files through ACLs, so 0600 is not observable there.
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(eventPath).mode & 0o777, 0o600);
    }
    assert.ok(fs.statSync(eventPath).size <= MAX_GOVERNANCE_AUDIT_EVENT_BYTES);
    return JSON.parse(fs.readFileSync(eventPath, "utf8"));
  });
  for (const event of events) {
    assert.equal(event.kind, "governance_mutation_audit_event");
    assert.equal(event.schema_version, "governance-mutation-audit-event:v1");
    assert.equal(event.hash_algorithm, "sha256:stable-json:v1");
    assert.equal(event.event_hash, computeStableHash(omitKeys(event, ["event_hash", "hash_algorithm"])));
    assert.equal(
      validateAgainstSchema(event, "governance-mutation-audit-event.schema.json").valid,
      true,
    );
    assert.match(event.summary, /audit mode allowed execution to continue/u);
  }
  assert.ok(events.some((event) => event.error_digest !== null));
  assert.equal(JSON.stringify(events).includes("secret-token-must-not-be-persisted"), false);

  runWithMutationGovernance(createGovernance(), () => withGovernedMutation({
    operation: "file.write",
    path: errorTarget,
    evidence_refs: EXACT_EVIDENCE,
  }, () => fs.writeFileSync(errorTarget, "same audit error remained non-blocking")));
  assert.equal(
    fs.readdirSync(auditRoot).length,
    2,
    "an identical immutable event must be idempotent instead of creating a duplicate",
  );
});

test("audit store lock contention is bounded and fail-open without reclaiming unknown ownership", (t) => {
  const root = fixture(t, "audit-lock-contention");
  const governanceRoot = path.join(root, ".sdlc", "governance");
  const auditRoot = path.join(root, ...DEFAULT_GOVERNANCE_AUDIT_EVENTS_ROOT.split("/"));
  const lockPath = `${auditRoot}.lock`;
  const target = path.join(root, ".sdlc", "story-denied.json");
  fs.mkdirSync(governanceRoot, { recursive: true });
  fs.mkdirSync(auditRoot, { recursive: true });
  fs.writeFileSync(
    path.join(governanceRoot, "policy.json"),
    `${JSON.stringify(policyFor(mutationSubject()))}\n`,
  );
  fs.writeFileSync(lockPath, "owned by another process", { mode: 0o600 });
  const governance = createProjectMutationGovernance({
    root,
    governance_policy: {
      mode: "audit",
      policy_file: ".sdlc/governance/policy.json",
      decision_receipts_root: ".sdlc/governance/decisions",
      use_receipts_root: ".sdlc/governance/uses",
      revocations_root: ".sdlc/governance/revocations",
      fail_closed: false,
    },
    canonical_action: "story.update",
    command_path: "story update",
    actor: ACTOR,
    now: () => NOW,
  });

  runWithMutationGovernance(governance, () => withGovernedMutation({
    operation: "file.write",
    path: target,
    evidence_refs: EXACT_EVIDENCE,
  }, () => fs.writeFileSync(target, "audit continued during contention")));

  assert.equal(fs.readFileSync(target, "utf8"), "audit continued during contention");
  assert.equal(fs.readFileSync(lockPath, "utf8"), "owned by another process");
  assert.deepEqual(fs.readdirSync(auditRoot), []);
  assert.equal(governance.observations.filter((outcome) =>
    outcome.reason_codes?.includes("mutation.audit_sink_unavailable")).length, 1);
});

test("audit lock cleanup preserves a replacement and the primary persistence error", {
  skip: process.platform === "win32"
    ? "Windows does not portably allow replacing an open lock file"
    : false,
}, (t) => {
  const root = fixture(t, "audit-lock-release-tamper");
  const governanceRoot = path.join(root, ".sdlc", "governance");
  const auditRoot = path.join(root, ...DEFAULT_GOVERNANCE_AUDIT_EVENTS_ROOT.split("/"));
  const lockPath = `${auditRoot}.lock`;
  const target = path.join(root, ".sdlc", "story-denied.json");
  const primaryMessage = "primary audit persistence failure";
  const replacementBytes = "replacement owned elsewhere";
  fs.mkdirSync(governanceRoot, { recursive: true });
  fs.mkdirSync(auditRoot, { recursive: true });
  fs.writeFileSync(
    path.join(governanceRoot, "policy.json"),
    `${JSON.stringify(policyFor(mutationSubject()))}\n`,
  );
  const governance = createProjectMutationGovernance({
    root,
    governance_policy: {
      mode: "audit",
      policy_file: ".sdlc/governance/policy.json",
      decision_receipts_root: ".sdlc/governance/decisions",
      use_receipts_root: ".sdlc/governance/uses",
      revocations_root: ".sdlc/governance/revocations",
      fail_closed: false,
    },
    canonical_action: "story.update",
    command_path: "story update",
    actor: ACTOR,
    now: () => NOW,
  });

  const originalOpenSync = fs.openSync;
  const originalCloseSync = fs.closeSync;
  let originalLockDescriptor;
  let eventCreateIntercepted = false;
  let lockCloseFailureInjected = false;
  fs.openSync = function tamperedAuditLockOpen(filePath, ...args) {
    const resolved = typeof filePath === "string" ? path.resolve(filePath) : "";
    if (!eventCreateIntercepted && resolved.startsWith(`${auditRoot}${path.sep}event-`)) {
      eventCreateIntercepted = true;
      fs.unlinkSync(lockPath);
      fs.writeFileSync(lockPath, replacementBytes, { mode: 0o600 });
      throw new Error(primaryMessage);
    }
    const descriptor = originalOpenSync.call(fs, filePath, ...args);
    if (resolved === lockPath && originalLockDescriptor === undefined) {
      originalLockDescriptor = descriptor;
    }
    return descriptor;
  };
  fs.closeSync = function failingOriginalLockClose(descriptor) {
    if (descriptor === originalLockDescriptor && !lockCloseFailureInjected) {
      lockCloseFailureInjected = true;
      originalCloseSync.call(fs, descriptor);
      throw new Error("secondary lock close failure");
    }
    return originalCloseSync.call(fs, descriptor);
  };
  try {
    runWithMutationGovernance(governance, () => withGovernedMutation({
      operation: "file.write",
      path: target,
      evidence_refs: EXACT_EVIDENCE,
    }, () => fs.writeFileSync(target, "audit continued after lock tamper")));
  } finally {
    fs.openSync = originalOpenSync;
    fs.closeSync = originalCloseSync;
  }

  assert.equal(eventCreateIntercepted, true);
  assert.equal(lockCloseFailureInjected, true);
  assert.equal(fs.readFileSync(target, "utf8"), "audit continued after lock tamper");
  assert.equal(fs.readFileSync(lockPath, "utf8"), replacementBytes);
  assert.deepEqual(fs.readdirSync(auditRoot), []);
  const sinkFailure = governance.observations.find((outcome) =>
    outcome.reason_codes?.includes("mutation.audit_sink_unavailable"));
  assert.ok(sinkFailure);
  assert.equal(
    sinkFailure.error_digest,
    crypto.createHash("sha256").update(primaryMessage).digest("hex"),
  );
});

test("concurrent audit writers cannot race past the hard event-count bound", async (t) => {
  const root = fixture(t, "audit-concurrent-capacity");
  const governanceRoot = path.join(root, ".sdlc", "governance");
  const auditRoot = path.join(root, ...DEFAULT_GOVERNANCE_AUDIT_EVENTS_ROOT.split("/"));
  const barrierRoot = path.join(root, "writer-barrier");
  fs.mkdirSync(governanceRoot, { recursive: true });
  fs.mkdirSync(auditRoot, { recursive: true });
  fs.mkdirSync(barrierRoot);
  fs.writeFileSync(
    path.join(governanceRoot, "policy.json"),
    `${JSON.stringify(policyFor(mutationSubject()))}\n`,
  );
  for (let index = 0; index < MAX_GOVERNANCE_AUDIT_EVENT_FILES - 1; index += 1) {
    fs.writeFileSync(path.join(auditRoot, `event-${index.toString(16).padStart(64, "0")}.json`), "");
  }

  const writerCount = 8;
  const guardModuleUrl = new URL("../../lib/governance/mutation-guard.mjs", import.meta.url).href;
  const childSource = String.raw`
    import fs from "node:fs";
    import path from "node:path";
    const [root, index, moduleUrl, evidenceJson] = process.argv.slice(1);
    const { createProjectMutationGovernance, runWithMutationGovernance, withGovernedMutation } = await import(moduleUrl);
    const auditRoot = path.join(root, ".sdlc-governance", "audit-events");
    const barrierRoot = path.join(root, "writer-barrier");
    const originalOpenSync = fs.openSync;
    let delayedEventCreate = false;
    fs.openSync = function delayedAuditEventCreate(filePath, ...args) {
      const resolved = typeof filePath === "string" ? path.resolve(filePath) : "";
      if (!delayedEventCreate && resolved.startsWith(auditRoot + path.sep + "event-")) {
        delayedEventCreate = true;
        const releaseAt = Date.now() + 250;
        while (Date.now() < releaseAt) { /* make an unlocked check/create race deterministic */ }
      }
      return originalOpenSync.call(fs, filePath, ...args);
    };
    fs.writeFileSync(path.join(barrierRoot, "ready-" + index), "");
    while (!fs.existsSync(path.join(barrierRoot, "go"))) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const evidenceRefs = JSON.parse(evidenceJson);
    const governance = createProjectMutationGovernance({
      root,
      governance_policy: {
        mode: "audit",
        policy_file: ".sdlc/governance/policy.json",
        decision_receipts_root: ".sdlc/governance/decisions",
        use_receipts_root: ".sdlc/governance/uses",
        revocations_root: ".sdlc/governance/revocations",
        fail_closed: false,
      },
      canonical_action: "story.update",
      command_path: "story update",
      actor: { type: "agent", id: "writer-1" },
      now: () => "2026-07-18T12:00:00." + String(index).padStart(3, "0") + "Z",
    });
    runWithMutationGovernance(governance, () => withGovernedMutation({
      operation: "file.write",
      path: path.join(root, ".sdlc", "concurrent-denied-" + index + ".json"),
      evidence_refs: evidenceRefs,
    }, () => {}));
  `;
  const children = [];
  t.after(() => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  });
  const childRuns = Array.from({ length: writerCount }, (_, index) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--input-type=module",
      "--eval",
      childSource,
      root,
      String(index),
      guardModuleUrl,
      JSON.stringify(EXACT_EVIDENCE),
    ], { stdio: ["ignore", "ignore", "pipe"] });
    children.push(child);
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`audit writer ${index} exited with ${code ?? signal}: ${stderr}`));
    });
  }));

  const readyDeadline = Date.now() + 15_000;
  while (fs.readdirSync(barrierRoot).filter((name) => name.startsWith("ready-")).length < writerCount) {
    if (Date.now() >= readyDeadline) throw new Error("concurrent audit writers did not reach the start barrier");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  fs.writeFileSync(path.join(barrierRoot, "go"), "go");
  await Promise.all(childRuns);

  const eventNames = fs.readdirSync(auditRoot);
  assert.equal(eventNames.length, MAX_GOVERNANCE_AUDIT_EVENT_FILES);
  assert.equal(eventNames.every((name) => /^event-[a-f0-9]{64}\.json$/u.test(name)), true);
  assert.equal(fs.existsSync(`${auditRoot}.lock`), false);
});

test("receipt persistence refuses a configured directory renamed behind an exact symlink", (t) => {
  if (!requireSymlinkSupport(t, "dir")) return;
  const root = fixture(t, "receipt-parent-race");
  const governanceRoot = path.join(root, ".sdlc", "governance");
  const decisionsPath = path.join(governanceRoot, "decisions");
  const target = path.join(root, ".sdlc", "story.json");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-sdlc-receipt-outside-"));
  const outsideDecisions = path.join(outside, "decisions");
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(governanceRoot, { recursive: true });
  fs.writeFileSync(
    path.join(governanceRoot, "policy.json"),
    `${JSON.stringify(policyFor(mutationSubject()))}\n`,
  );
  const governance = createProjectMutationGovernance({
    root,
    governance_policy: {
      mode: "enforce",
      policy_file: ".sdlc/governance/policy.json",
      decision_receipts_root: ".sdlc/governance/decisions",
      use_receipts_root: ".sdlc/governance/uses",
      revocations_root: ".sdlc/governance/revocations",
      fail_closed: true,
    },
    canonical_action: "story.update",
    command_path: "story update",
    verified_actor: { verified: true, assurance: "host_verified", actor: ACTOR },
    evidence_paths: [],
    now: () => NOW,
  });

  const originalOpenSync = fs.openSync;
  let raced = false;
  let callbackRan = false;
  fs.openSync = function racedReceiptOpen(filePath, ...args) {
    const resolved = typeof filePath === "string" ? path.resolve(filePath) : "";
    if (!raced && resolved.startsWith(`${decisionsPath}${path.sep}`)) {
      fs.renameSync(decisionsPath, outsideDecisions);
      fs.symlinkSync(outsideDecisions, decisionsPath, "dir");
      raced = true;
    }
    return originalOpenSync.call(fs, filePath, ...args);
  };
  try {
    assert.throws(
      () => runWithMutationGovernance(governance, () => withGovernedMutation({
        operation: "file.write",
        path: target,
        evidence_refs: EXACT_EVIDENCE,
      }, () => {
        callbackRan = true;
        fs.writeFileSync(target, "must-not-exist");
      })),
      (error) => error.code === "MUTATION_GOVERNANCE_DENIED"
        && error.details.reason_codes.includes("mutation.decision_receipt_persistence_failed"),
    );
  } finally {
    fs.openSync = originalOpenSync;
  }

  assert.equal(raced, true);
  assert.equal(callbackRan, false);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.lstatSync(decisionsPath).isSymbolicLink(), true);
  const outsideFiles = fs.readdirSync(outsideDecisions)
    .map((name) => path.join(outsideDecisions, name));
  assert.ok(outsideFiles.length <= 1);
  assert.equal(outsideFiles.some((filePath) => fs.statSync(filePath).size > 0), false);
});

test("audit event sink race is fail-open and never writes bytes through a swapped symlink", (t) => {
  if (!requireSymlinkSupport(t, "dir")) return;
  const root = fixture(t, "audit-event-race");
  const governanceRoot = path.join(root, ".sdlc", "governance");
  const auditRoot = path.join(root, ...DEFAULT_GOVERNANCE_AUDIT_EVENTS_ROOT.split("/"));
  const target = path.join(root, ".sdlc", "story-denied.json");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-sdlc-audit-outside-"));
  const outsideAudit = path.join(outside, "audit-events");
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(governanceRoot, { recursive: true });
  fs.mkdirSync(auditRoot, { recursive: true });
  fs.writeFileSync(
    path.join(governanceRoot, "policy.json"),
    `${JSON.stringify(policyFor(mutationSubject()))}\n`,
  );
  const governance = createProjectMutationGovernance({
    root,
    governance_policy: {
      mode: "audit",
      policy_file: ".sdlc/governance/policy.json",
      decision_receipts_root: ".sdlc/governance/decisions",
      use_receipts_root: ".sdlc/governance/uses",
      revocations_root: ".sdlc/governance/revocations",
      fail_closed: false,
    },
    canonical_action: "story.update",
    command_path: "story update",
    actor: ACTOR,
    now: () => NOW,
  });
  const originalOpenSync = fs.openSync;
  let raced = false;
  fs.openSync = function racedAuditOpen(filePath, ...args) {
    const resolved = typeof filePath === "string" ? path.resolve(filePath) : "";
    if (!raced && resolved.startsWith(`${auditRoot}${path.sep}event-`)) {
      fs.renameSync(auditRoot, outsideAudit);
      fs.symlinkSync(outsideAudit, auditRoot, "dir");
      raced = true;
    }
    return originalOpenSync.call(fs, filePath, ...args);
  };
  try {
    runWithMutationGovernance(governance, () => withGovernedMutation({
      operation: "file.write",
      path: target,
      evidence_refs: EXACT_EVIDENCE,
    }, () => fs.writeFileSync(target, "audit fail-open")));
  } finally {
    fs.openSync = originalOpenSync;
  }
  assert.equal(raced, true);
  assert.equal(fs.readFileSync(target, "utf8"), "audit fail-open");
  assert.equal(governance.observations.filter((outcome) =>
    outcome.reason_codes?.includes("mutation.audit_sink_unavailable")).length, 1);
  const outsideFiles = fs.readdirSync(outsideAudit).map((name) => path.join(outsideAudit, name));
  assert.ok(outsideFiles.length <= 1);
  assert.equal(outsideFiles.some((eventPath) => fs.statSync(eventPath).size > 0), false);
});

test("full and oversized audit stores stay bounded without blocking audited work", (t) => {
  const runCase = (label, prepareStore) => {
    const root = fixture(t, label);
    const governanceRoot = path.join(root, ".sdlc", "governance");
    const auditRoot = path.join(root, ...DEFAULT_GOVERNANCE_AUDIT_EVENTS_ROOT.split("/"));
    const target = path.join(root, ".sdlc", `${label}.json`);
    fs.mkdirSync(governanceRoot, { recursive: true });
    fs.mkdirSync(auditRoot, { recursive: true });
    fs.writeFileSync(
      path.join(governanceRoot, "policy.json"),
      `${JSON.stringify(policyFor(mutationSubject()))}\n`,
    );
    prepareStore(auditRoot);
    const beforeNames = fs.readdirSync(auditRoot).sort();
    const governance = createProjectMutationGovernance({
      root,
      governance_policy: {
        mode: "audit",
        policy_file: ".sdlc/governance/policy.json",
        decision_receipts_root: ".sdlc/governance/decisions",
        use_receipts_root: ".sdlc/governance/uses",
        revocations_root: ".sdlc/governance/revocations",
        fail_closed: false,
      },
      canonical_action: "story.update",
      command_path: "story update",
      actor: ACTOR,
      now: () => NOW,
    });
    runWithMutationGovernance(governance, () => withGovernedMutation({
      operation: "file.write",
      path: target,
      evidence_refs: EXACT_EVIDENCE,
    }, () => fs.writeFileSync(target, "bounded audit fail-open")));
    assert.equal(fs.readFileSync(target, "utf8"), "bounded audit fail-open");
    assert.deepEqual(fs.readdirSync(auditRoot).sort(), beforeNames);
    assert.equal(governance.observations.some((outcome) =>
      outcome.reason_codes?.includes("mutation.audit_sink_unavailable")), true);
  };

  runCase("audit-full", (auditRoot) => {
    for (let index = 0; index < MAX_GOVERNANCE_AUDIT_EVENT_FILES; index += 1) {
      fs.writeFileSync(path.join(auditRoot, `event-${index.toString(16).padStart(64, "0")}.json`), "");
    }
  });
  runCase("audit-oversized", (auditRoot) => {
    const oversized = path.join(auditRoot, `event-${"a".repeat(64)}.json`);
    fs.writeFileSync(oversized, Buffer.alloc(MAX_GOVERNANCE_AUDIT_EVENT_BYTES + 1));
  });
});

test("enforce rejects a self-asserted actor without verified host or CI identity", () => {
  const root = fixture(test, "unverified-identity");
  const subject = mutationSubject({ evidence: [] });
  const policy = policyFor(subject);
  const governance = createProjectMutationGovernance({
    root,
    governance_policy: policy,
    canonical_action: "story.update",
    command_path: "story update",
    actor: { type: "human", id: "self-asserted-name" },
  });
  assert.equal(governance.mode, "enforce");
  assert.match(governance.configuration_error, /identity verified by the host or CI/u);
});

test("project configuration is optional and pointer/inline policies are bounded", () => {
  const root = fixture(test, "config");
  fs.mkdirSync(path.join(root, ".sdlc", "governance"), { recursive: true });
  const disabled = createProjectMutationGovernance({ root });
  assert.equal(disabled.mode, "disabled");

  const subject = mutationSubject();
  const policy = policyFor(subject);
  const inline = createProjectMutationGovernance({
    root,
    governance_policy: policy,
    canonical_action: "story.update",
    command_path: "story update",
    verified_actor: { verified: true, assurance: "host_verified", actor: ACTOR },
    evidence_paths: [],
    now: () => NOW,
  });
  assert.equal(inline.mode, "enforce");

  const policyPath = path.join(root, ".sdlc", "governance", "policy.json");
  fs.writeFileSync(policyPath, `${JSON.stringify(policy)}\n`);
  const pointer = {
    mode: "audit",
    policy_file: ".sdlc/governance/policy.json",
    decision_receipts_root: ".sdlc/governance/decisions",
    use_receipts_root: ".sdlc/governance/uses",
    revocations_root: ".sdlc/governance/revocations",
    fail_closed: false,
  };
  assert.equal(createProjectMutationGovernance({
    root,
    governance_policy: pointer,
    canonical_action: "story.update",
    command_path: "story update",
    actor: ACTOR,
    now: () => NOW,
  }).mode, "audit");
});

test("project configuration refuses a symlinked policy file", (t) => {
  if (!requireSymlinkSupport(t, "file")) return;
  const root = fixture(t, "config-symlink");
  fs.mkdirSync(path.join(root, ".sdlc", "governance"), { recursive: true });
  const subject = mutationSubject();
  const policy = policyFor(subject);
  const pointer = {
    mode: "audit",
    policy_file: ".sdlc/governance/policy.json",
    decision_receipts_root: ".sdlc/governance/decisions",
    use_receipts_root: ".sdlc/governance/uses",
    revocations_root: ".sdlc/governance/revocations",
    fail_closed: false,
  };
  const policyPath = path.join(root, ".sdlc", "governance", "policy.json");
  const outside = path.join(root, "outside-policy.json");
  fs.writeFileSync(outside, `${JSON.stringify(policy)}\n`);
  fs.symlinkSync(outside, policyPath);
  const unsafe = createProjectMutationGovernance({
    root,
    governance_policy: { ...pointer, mode: "enforce", fail_closed: true },
    canonical_action: "story.update",
    command_path: "story update",
    actor: ACTOR,
  });
  assert.equal(unsafe.mode, "enforce");
  assert.match(unsafe.configuration_error, /symbolic link/u);
});

test("secure JSONL append writes complete records", () => {
  const root = fixture(test, "append");
  const target = path.join(root, "events.jsonl");
  for (let index = 0; index < 100; index += 1) appendJsonLineNoFollow(target, { index });
  const records = fs.readFileSync(target, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(records.length, 100);
  assert.deepEqual(records.map(({ index }) => index), Array.from({ length: 100 }, (_, index) => index));
});

test("secure JSONL append refuses a symlink target", (t) => {
  if (!requireSymlinkSupport(t, "file")) return;
  const root = fixture(t, "append-symlink");
  const outside = path.join(root, "outside.jsonl");
  const linked = path.join(root, "linked.jsonl");
  fs.writeFileSync(outside, "");
  fs.symlinkSync(outside, linked);
  assert.throws(() => appendJsonLineNoFollow(linked, { denied: true }), /symbolic link/u);
  assert.equal(fs.readFileSync(outside, "utf8"), "");
});

test("exact mutation batches reach their enforced hard boundary without recursion", () => {
  const root = fixture(test, "batch-boundary");
  const exactMutations = Array.from({ length: MAX_EXACT_MUTATION_BATCH }, (_, index) => ({
    operation: "file.write",
    path: `batch/item-${index}.json`,
  }));
  const grant = createBootstrapMutationGrant({
    root,
    canonical_action: "init",
    first_time: true,
    exact_mutations: exactMutations,
  });
  let callbackRan = false;
  consumeBootstrapMutationGrant(grant, () => withGovernedMutationBatch(exactMutations, () => {
    callbackRan = true;
    assert.equal(assertMutationExecutionAuthorized(exactMutations[0]), true);
    assert.equal(assertMutationExecutionAuthorized(exactMutations.at(-1)), true);
  }));
  assert.equal(callbackRan, true);
  assert.throws(
    () => withGovernedMutationBatch(
      [...exactMutations, { operation: "file.write", path: "batch/overflow.json" }],
      () => assert.fail("oversized batch callback ran"),
    ),
    (error) => error.code === "MUTATION_BATCH_INVALID",
  );
});

test("bootstrap grants are exact and limited to first init or bound recovery material", async () => {
  const root = fixture(test, "bootstrap");
  const hash = "a".repeat(64);
  const init = createBootstrapMutationGrant({
    root,
    canonical_action: "init",
    first_time: true,
    exact_mutations: [{ operation: "directory.create", path: ".sdlc" }],
  });
  assert.equal(init.canonical_action, "init");
  assert.deepEqual(init.exact_mutations, [{
    canonical_action: "init",
    operation: "directory.create",
    project_path: ".sdlc",
  }]);
  const clonedInit = structuredClone(init);
  assert.throws(
    () => consumeBootstrapMutationGrant(clonedInit, () => assert.fail("cloned grant ran")),
    /invalid/u,
  );
  let initConsumed = false;
  consumeBootstrapMutationGrant(init, () => withGovernedMutation({
    operation: "directory.create",
    path: ".sdlc",
  }, () => {
    assertMutationExecutionAuthorized({ operation: "directory.create", path: ".sdlc" });
    initConsumed = true;
  }));
  assert.equal(initConsumed, true);
  assert.throws(
    () => consumeBootstrapMutationGrant(clonedInit, () => assert.fail("cloned grant ran")),
    /invalid/u,
  );

  const detachedTarget = path.join(root, ".sdlc", "detached.json");
  const detached = createBootstrapMutationGrant({
    root,
    canonical_action: "init",
    first_time: true,
    exact_mutations: [{ operation: "file.write", path: detachedTarget }],
  });
  let detachedError = null;
  await new Promise((resolve) => {
    consumeBootstrapMutationGrant(detached, () => {
      setImmediate(() => {
        try {
          withGovernedMutation({ operation: "file.write", path: detachedTarget }, () => {
            assertMutationExecutionAuthorized({ operation: "file.write", path: detachedTarget });
            fs.writeFileSync(detachedTarget, "detached");
          });
        } catch (error) {
          detachedError = error;
        } finally {
          resolve();
        }
      });
    });
  });
  assert.equal(detachedError?.code, "MUTATION_GOVERNANCE_DENIED");
  assert.equal(fs.existsSync(detachedTarget), false);

  const throwingThenTarget = path.join(root, ".sdlc", "throwing-then.json");
  const throwingThen = createBootstrapMutationGrant({
    root,
    canonical_action: "init",
    first_time: true,
    exact_mutations: [{ operation: "file.write", path: throwingThenTarget }],
  });
  let throwingThenDetachedError = null;
  let resolveThrowingThenDetached;
  const throwingThenDetached = new Promise((resolve) => {
    resolveThrowingThenDetached = resolve;
  });
  assert.throws(() => consumeBootstrapMutationGrant(throwingThen, () => {
    setImmediate(() => {
      try {
        withGovernedMutation({ operation: "file.write", path: throwingThenTarget }, () => {
          assertMutationExecutionAuthorized({ operation: "file.write", path: throwingThenTarget });
          fs.writeFileSync(throwingThenTarget, "must-not-exist");
        });
      } catch (error) {
        throwingThenDetachedError = error;
      } finally {
        resolveThrowingThenDetached();
      }
    });
    return Object.defineProperty({}, "then", {
      get() {
        throw new Error("bootstrap then getter failed");
      },
    });
  }), /bootstrap then getter failed/u);
  await throwingThenDetached;
  assert.equal(throwingThenDetachedError?.code, "MUTATION_GOVERNANCE_DENIED");
  assert.equal(fs.existsSync(throwingThenTarget), false);

  const replayTarget = path.join(root, ".sdlc", "replay.json");
  const replay = createBootstrapMutationGrant({
    root,
    canonical_action: "init",
    first_time: true,
    exact_mutations: [{ operation: "file.write", path: replayTarget }],
  });
  let capturedContext;
  consumeBootstrapMutationGrant(replay, () => {
    capturedContext = currentMutationGovernance();
  });
  assert.throws(
    () => runWithMutationGovernance(capturedContext, () => withGovernedMutation({
      operation: "file.write",
      path: replayTarget,
    }, () => fs.writeFileSync(replayTarget, "replay"))),
    (error) => error.code === "MUTATION_GOVERNANCE_DENIED",
  );
  assert.equal(fs.existsSync(replayTarget), false);
  assert.throws(() => runWithMutationGovernance({
    ...capturedContext,
    bootstrap_mutations: [{ operation: "file.write", path: replayTarget }],
  }, () => assert.fail("forged bootstrap context ran")), (error) => error.code === "MUTATION_BOOTSTRAP_DENIED");

  const config = createBootstrapMutationGrant({
    root,
    canonical_action: "config.migrate",
    plan_hash: hash,
    expected_plan_hash: hash,
    exact_mutations: [{ operation: "file.write", path: ".sdlc/config.json" }],
  });
  assert.equal(consumeBootstrapMutationGrant(config, () => withGovernedMutation({
    operation: "file.write",
    path: ".sdlc/config.json",
  }, () => "config-consumed")), "config-consumed");

  const identity = createBootstrapMutationGrant({
    root,
    canonical_action: "migration.identity",
    recover: true,
    nonce: "transaction-a",
    expected_nonce: "transaction-a",
    plan_hash: hash,
    expected_plan_hash: hash,
    exact_mutations: [{ operation: "file.write", path: ".sdlc-identity-migration.lock" }],
  });
  assert.equal(consumeBootstrapMutationGrant(identity, () => withGovernedMutation({
    operation: "file.write",
    path: ".sdlc-identity-migration.lock",
  }, () => "identity-consumed")), "identity-consumed");

  const outOfGrant = createBootstrapMutationGrant({
    root,
    canonical_action: "init",
    first_time: true,
    exact_mutations: [{ operation: "directory.create", path: ".sdlc" }],
  });
  assert.throws(() => consumeBootstrapMutationGrant(outOfGrant, () => withGovernedMutation({
    operation: "file.write",
    path: ".sdlc/unlisted.json",
  }, () => assert.fail("out-of-grant mutation ran"))), (error) =>
    error.code === "MUTATION_GOVERNANCE_DENIED"
    && error.details.reason_codes.includes("mutation.bootstrap_exact_grant_miss"));
  assert.throws(() => createBootstrapMutationGrant({
    root,
    canonical_action: "init",
    first_time: false,
    exact_mutations: [{ operation: "directory.create", path: ".sdlc" }],
  }), /only valid before/u);
  assert.throws(() => createBootstrapMutationGrant({
    root,
    canonical_action: "config.migrate",
    plan_hash: hash,
    expected_plan_hash: "b".repeat(64),
    exact_mutations: [{ operation: "file.write", path: ".sdlc/config.json" }],
  }), /does not match/u);
  assert.throws(() => createBootstrapMutationGrant({
    root,
    canonical_action: "migration.identity",
    recover: true,
    nonce: "transaction-a",
    expected_nonce: "transaction-b",
    plan_hash: hash,
    expected_plan_hash: hash,
    exact_mutations: [{ operation: "file.write", path: ".sdlc/project.json" }],
  }), /exact transaction nonce/u);
  assert.throws(() => createBootstrapMutationGrant({
    root,
    canonical_action: "story.update",
    exact_mutations: [{ operation: "file.write", path: ".sdlc/story.json" }],
  }), /Unsupported bootstrap/u);
});
