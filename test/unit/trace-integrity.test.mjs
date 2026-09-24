import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  TraceIntegrityError,
  recoverTraceIntegrity,
  sealTraceEvent,
  verifyTraceIntegrity,
  withTraceIntegritySnapshot,
} from "../../lib/trace-integrity.mjs";

function fixture(t, { legacy = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trace-integrity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  const tracePath = path.join(root, "trace.jsonl");
  const checkpointPath = path.join(root, ".integrity", "trace.checkpoint.json");
  if (legacy) {
    fs.writeFileSync(tracePath, '{"type":"legacy","value":1}\n{"type":"legacy","value":2}\n');
  }
  return { root, tracePath, checkpointPath };
}

function options(paths, extra = {}) {
  return {
    boundaryRoot: paths.root,
    tracePath: paths.tracePath,
    checkpointPath: paths.checkpointPath,
    ...extra,
  };
}

function jsonLines(tracePath) {
  return fs.readFileSync(tracePath, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
}

function writeLines(tracePath, records) {
  fs.writeFileSync(tracePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

function sealedFixture(t) {
  const paths = fixture(t);
  sealTraceEvent(options(paths, { event: { type: "command", id: "one", value: 1 } }));
  sealTraceEvent(options(paths, { event: { type: "command", id: "two", value: 2 } }));
  return paths;
}

function errorCodes(report) {
  return new Set(report.errors.map((entry) => entry.code));
}

test("seals a legacy prefix and returns synchronous, locally verifiable events", (t) => {
  const paths = fixture(t);
  const first = sealTraceEvent(options(paths, {
    event: { type: "command", id: "one", nested: { ok: true } },
    dependencies: { now: () => new Date("2026-07-18T10:00:00.000Z") },
  }));

  assert.equal(first.mode, "local_tamper_evidence");
  assert.equal(first.authenticity_claimed, false);
  assert.equal(first.event.type, "command");
  assert.equal(first.event._trace_integrity.sequence, 1);
  assert.equal(first.event._trace_integrity.authenticity_claimed, false);
  assert.equal(first.checkpoint.legacy_prefix.line_count, 2);
  assert.equal(first.checkpoint.new_writes.count, 1);
  assert.equal(first.recovery.recovered, false);
  assert.throws(() => { first.event.type = "changed"; }, TypeError);

  const second = sealTraceEvent(options(paths, { event: { type: "command", id: "two" } }));
  assert.equal(second.event._trace_integrity.sequence, 2);
  assert.equal(
    second.event._trace_integrity.previous_hash,
    first.event._trace_integrity.event_hash,
  );

  const report = verifyTraceIntegrity(options(paths));
  assert.equal(report.valid, true);
  assert.equal(report.initialized, true);
  assert.equal(report.legacy_prefix.status, "verified");
  assert.equal(report.legacy_prefix.line_count, 2);
  assert.equal(report.new_writes.status, "verified");
  assert.equal(report.new_writes.count, 2);
  assert.equal(report.checkpoint.status, "verified");
  assert.equal(report.authenticity_claimed, false);
});

test("reports an intact legacy-only trace as unsealed rather than authenticated", (t) => {
  const paths = fixture(t);
  const report = verifyTraceIntegrity(options(paths));
  assert.equal(report.valid, true);
  assert.equal(report.initialized, false);
  assert.equal(report.legacy_prefix.status, "unsealed");
  assert.equal(report.new_writes.status, "not_initialized");
  assert.equal(report.checkpoint.status, "missing");
  assert.equal(report.authenticity_claimed, false);
  assert.equal(fs.existsSync(path.dirname(paths.checkpointPath)), false);
});

test("fails closed when a trace is swapped between integrity and semantic snapshot stages", (t) => {
  const paths = fixture(t, { legacy: false });
  sealTraceEvent(options(paths, { event: { type: "command", id: "one" } }));
  let semanticInspectionRan = false;

  assert.throws(
    () => withTraceIntegritySnapshot(options(paths, {
      hooks: {
        after_snapshot_verified() {
          if (process.platform === "win32") {
            fs.appendFileSync(paths.tracePath, " ");
            return;
          }
          const replacement = `${paths.tracePath}.replacement`;
          fs.copyFileSync(paths.tracePath, replacement);
          fs.renameSync(replacement, paths.tracePath);
        },
      },
    }), ({ integrity, records, present }) => {
      semanticInspectionRan = true;
      assert.equal(integrity.valid, true);
      assert.equal(present, true);
      assert.equal(records.length, 1);
      assert.equal(records[0].event.id, "one");
    }),
    (error) => error instanceof TraceIntegrityError
      && ["file_replaced", "trace_changed_during_read", "trace_snapshot_changed"].includes(error.code),
  );
  assert.equal(semanticInspectionRan, true);
});

test("bounds trace snapshot reads before integrity or semantic inspection", (t) => {
  const paths = fixture(t, { legacy: false });
  fs.writeFileSync(paths.tracePath, `${"x".repeat(32)}\n`);
  let semanticInspectionRan = false;
  assert.throws(
    () => withTraceIntegritySnapshot(options(paths, {
      maxVerificationTraceBytes: 16,
    }), () => {
      semanticInspectionRan = true;
    }),
    (error) => error instanceof TraceIntegrityError && error.code === "trace_too_large",
  );
  assert.equal(semanticInspectionRan, false);
});

test("applies the trace read bound to direct verification, recovery, and sealing", (t) => {
  const paths = fixture(t, { legacy: false });
  fs.writeFileSync(paths.tracePath, `${JSON.stringify({ legacy: "x".repeat(64) })}\n`);
  const limited = options(paths, { maxVerificationTraceBytes: 16 });

  for (const operation of [
    () => verifyTraceIntegrity(limited),
    () => recoverTraceIntegrity(limited),
    () => sealTraceEvent({ ...limited, event: { type: "must-not-append" } }),
  ]) {
    assert.throws(
      operation,
      (error) => error instanceof TraceIntegrityError && error.code === "trace_too_large",
    );
  }
});

test("bounds checkpoint, backup, and lock reads", (t) => {
  const checkpointPaths = fixture(t, { legacy: false });
  sealTraceEvent(options(checkpointPaths, { event: { type: "first" } }));
  for (const operation of [
    () => verifyTraceIntegrity(options(checkpointPaths, { maxCheckpointBytes: 16 })),
    () => recoverTraceIntegrity(options(checkpointPaths, { maxCheckpointBytes: 16 })),
    () => sealTraceEvent(options(checkpointPaths, {
      maxCheckpointBytes: 16,
      event: { type: "second" },
    })),
  ]) {
    assert.throws(
      operation,
      (error) => error instanceof TraceIntegrityError && error.code === "checkpoint_too_large",
    );
  }

  const backupPaths = fixture(t, { legacy: false });
  sealTraceEvent(options(backupPaths, { event: { type: "first" } }));
  fs.renameSync(backupPaths.checkpointPath, `${backupPaths.checkpointPath}.previous`);
  assert.throws(
    () => verifyTraceIntegrity(options(backupPaths, { maxCheckpointBytes: 16 })),
    (error) => error instanceof TraceIntegrityError && error.code === "checkpoint_backup_too_large",
  );

  const lockPaths = fixture(t, { legacy: false });
  fs.mkdirSync(path.dirname(lockPaths.checkpointPath), { recursive: true });
  fs.writeFileSync(`${lockPaths.checkpointPath}.lock`, "x".repeat(32));
  assert.throws(
    () => sealTraceEvent(options(lockPaths, {
      maxLockBytes: 16,
      lockTimeoutMs: 0,
      event: { type: "blocked" },
    })),
    (error) => error instanceof TraceIntegrityError && error.code === "lock_too_large",
  );
});

test("preflights generated lock and checkpoint caps before creating durable files", (t) => {
  const lockPaths = fixture(t, { legacy: false });
  assert.throws(
    () => sealTraceEvent(options(lockPaths, {
      maxLockBytes: 16,
      event: { type: "must-not-create-lock" },
    })),
    (error) => error instanceof TraceIntegrityError && error.code === "lock_too_large",
  );
  assert.equal(fs.existsSync(lockPaths.tracePath), false);
  assert.equal(fs.existsSync(lockPaths.checkpointPath), false);
  assert.equal(fs.existsSync(`${lockPaths.checkpointPath}.lock`), false);

  const checkpointPaths = fixture(t, { legacy: false });
  assert.throws(
    () => sealTraceEvent(options(checkpointPaths, {
      maxCheckpointBytes: 16,
      event: { type: "must-not-create-checkpoint" },
    })),
    (error) => error instanceof TraceIntegrityError && error.code === "checkpoint_too_large",
  );
  assert.equal(fs.existsSync(checkpointPaths.tracePath), false);
  assert.equal(fs.existsSync(checkpointPaths.checkpointPath), false);
  assert.equal(fs.existsSync(`${checkpointPaths.checkpointPath}.lock`), false);
  assert.equal(
    fs.readdirSync(path.dirname(checkpointPaths.checkpointPath)).some((name) => name.endsWith(".tmp")),
    false,
  );
});

test("preflights the next checkpoint before appending a trace event", (t) => {
  const paths = fixture(t, { legacy: false });
  const fixedNow = () => new Date("2026-07-18T12:00:00.000Z");
  sealTraceEvent(options(paths, {
    event: { type: "first" },
    dependencies: { now: fixedNow },
  }));
  const beforeTrace = fs.readFileSync(paths.tracePath);
  const beforeCheckpoint = fs.readFileSync(paths.checkpointPath);

  assert.throws(
    () => sealTraceEvent(options(paths, {
      maxCheckpointBytes: beforeCheckpoint.length,
      event: { type: "second", payload: "x".repeat(8_192) },
      dependencies: { now: fixedNow },
    })),
    (error) => error instanceof TraceIntegrityError && error.code === "checkpoint_too_large",
  );
  assert.deepEqual(fs.readFileSync(paths.tracePath), beforeTrace);
  assert.deepEqual(fs.readFileSync(paths.checkpointPath), beforeCheckpoint);
  assert.equal(fs.existsSync(`${paths.checkpointPath}.lock`), false);
});

test("preserves a primary snapshot failure when cleanup also detects a changed boundary", (t) => {
  if (process.platform === "win32") return;
  const paths = sealedFixture(t);
  const integrityDirectory = path.dirname(paths.checkpointPath);
  const movedDirectory = `${integrityDirectory}.primary-error`;
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "trace-integrity-cleanup-error-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true, maxRetries: 3 }));

  assert.throws(
    () => verifyTraceIntegrity(options(paths, {
      hooks: {
        after_snapshot_directory_capture() {
          fs.renameSync(integrityDirectory, movedDirectory);
          fs.symlinkSync(outside, integrityDirectory, "dir");
          throw new Error("primary snapshot failure");
        },
      },
    })),
    (error) => error.message === "primary snapshot failure"
      && Array.isArray(error.cleanup_errors)
      && error.cleanup_errors.some((entry) => entry?.code === "directory_boundary_changed"),
  );
});

test("fails closed when the verified checkpoint is swapped before semantic inspection completes", (t) => {
  const paths = fixture(t, { legacy: false });
  sealTraceEvent(options(paths, { event: { type: "command", id: "one" } }));
  let semanticInspectionRan = false;

  assert.throws(
    () => withTraceIntegritySnapshot(options(paths, {
      hooks: {
        after_snapshot_verified() {
          if (process.platform === "win32") {
            fs.appendFileSync(paths.checkpointPath, " ");
            return;
          }
          const replacement = `${paths.checkpointPath}.replacement`;
          fs.copyFileSync(paths.checkpointPath, replacement);
          fs.renameSync(replacement, paths.checkpointPath);
        },
      },
    }), ({ integrity, records }) => {
      semanticInspectionRan = true;
      assert.equal(integrity.valid, true);
      assert.equal(records[0].event.id, "one");
    }),
    (error) => error instanceof TraceIntegrityError
      && ["file_replaced", "checkpoint_changed_during_read", "checkpoint_snapshot_changed"].includes(error.code),
  );
  assert.equal(semanticInspectionRan, true);
});

test("pins every parent directory for the complete verification snapshot", (t) => {
  if (process.platform === "win32") return;
  const paths = fixture(t, { legacy: false });
  sealTraceEvent(options(paths, { event: { type: "command", id: "one" } }));
  const integrityDirectory = path.dirname(paths.checkpointPath);
  const movedDirectory = `${integrityDirectory}.original`;
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "trace-integrity-parent-swap-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true, maxRetries: 3 }));

  assert.throws(
    () => verifyTraceIntegrity(options(paths, {
      hooks: {
        after_snapshot_directory_capture() {
          fs.renameSync(integrityDirectory, movedDirectory);
          fs.symlinkSync(outside, integrityDirectory, "dir");
        },
      },
    })),
    (error) => error instanceof TraceIntegrityError && error.code === "directory_boundary_changed",
  );
});

test("detects modification of the immutable legacy prefix", (t) => {
  const paths = sealedFixture(t);
  const bytes = fs.readFileSync(paths.tracePath);
  const marker = bytes.indexOf(Buffer.from("legacy"));
  bytes[marker] = "L".charCodeAt(0);
  fs.writeFileSync(paths.tracePath, bytes);

  const report = verifyTraceIntegrity(options(paths));
  assert.equal(report.valid, false);
  assert.equal(report.legacy_prefix.valid, false);
  assert.equal(errorCodes(report).has("legacy_prefix_modified"), true);
});

test("detects modification of a sealed event, including exact JSONL byte drift", (t) => {
  const paths = sealedFixture(t);
  const records = jsonLines(paths.tracePath);
  records[2].value = 99;
  writeLines(paths.tracePath, records);

  const report = verifyTraceIntegrity(options(paths));
  assert.equal(report.valid, false);
  assert.equal(report.new_writes.valid, false);
  assert.equal(errorCodes(report).has("event_hash_mismatch"), true);
  assert.equal(errorCodes(report).has("rolling_hash_mismatch"), true);
});

test("detects deletion of a sealed record", (t) => {
  const paths = sealedFixture(t);
  const records = jsonLines(paths.tracePath);
  records.splice(2, 1);
  writeLines(paths.tracePath, records);

  const report = verifyTraceIntegrity(options(paths));
  assert.equal(report.valid, false);
  assert.equal(errorCodes(report).has("trace_truncated"), true);
  assert.equal(errorCodes(report).has("event_deleted_or_missing"), true);
});

test("detects reordered sealed records", (t) => {
  const paths = sealedFixture(t);
  const records = jsonLines(paths.tracePath);
  [records[2], records[3]] = [records[3], records[2]];
  writeLines(paths.tracePath, records);

  const report = verifyTraceIntegrity(options(paths));
  assert.equal(report.valid, false);
  assert.equal(errorCodes(report).has("event_reordered"), true);
  assert.equal(errorCodes(report).has("previous_hash_mismatch"), true);
});

test("detects duplicated sealed records", (t) => {
  const paths = sealedFixture(t);
  const records = jsonLines(paths.tracePath);
  records.splice(3, 0, structuredClone(records[2]));
  writeLines(paths.tracePath, records);

  const report = verifyTraceIntegrity(options(paths));
  assert.equal(report.valid, false);
  assert.equal(errorCodes(report).has("duplicate_event"), true);
});

test("detects trace truncation and an incomplete committed record", (t) => {
  const paths = sealedFixture(t);
  const bytes = fs.readFileSync(paths.tracePath);
  fs.writeFileSync(paths.tracePath, bytes.subarray(0, bytes.length - 13));

  const report = verifyTraceIntegrity(options(paths));
  assert.equal(report.valid, false);
  assert.equal(errorCodes(report).has("trace_truncated"), true);
});

test("detects bytes appended beyond the checkpoint without silently adopting them", (t) => {
  const paths = sealedFixture(t);
  fs.appendFileSync(paths.tracePath, '{"foreign":true}\n');

  const report = verifyTraceIntegrity(options(paths));
  assert.equal(report.valid, false);
  assert.equal(report.recovery_needed, true);
  assert.equal(errorCodes(report).has("checkpoint_drift"), true);
  assert.throws(
    () => recoverTraceIntegrity(options(paths)),
    (error) => error instanceof TraceIntegrityError && error.code === "unexpected_complete_tail",
  );
});

test("detects checkpoint field drift through its self-hash and trace comparison", (t) => {
  const paths = sealedFixture(t);
  const checkpoint = JSON.parse(fs.readFileSync(paths.checkpointPath, "utf8"));
  checkpoint.new_writes.rolling_hash = "0".repeat(64);
  fs.writeFileSync(paths.checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);

  const report = verifyTraceIntegrity(options(paths));
  assert.equal(report.valid, false);
  assert.equal(report.checkpoint.valid, false);
  assert.equal(errorCodes(report).has("checkpoint_hash_mismatch"), true);
  assert.equal(errorCodes(report).has("rolling_hash_mismatch"), true);
});

test("reports a malformed checkpoint as invalid without hiding the sealed trace", (t) => {
  const paths = sealedFixture(t);
  fs.writeFileSync(paths.checkpointPath, "{not-json\n");

  const report = verifyTraceIntegrity(options(paths));
  assert.equal(report.valid, false);
  assert.equal(report.initialized, true);
  assert.equal(report.checkpoint.status, "invalid");
  assert.equal(errorCodes(report).has("checkpoint_invalid_json"), true);
  assert.equal(errorCodes(report).has("checkpoint_missing"), true);
});

test("does not re-baseline sealed events when their checkpoint is deleted", (t) => {
  const paths = sealedFixture(t);
  fs.unlinkSync(paths.checkpointPath);

  const report = verifyTraceIntegrity(options(paths));
  assert.equal(report.valid, false);
  assert.equal(errorCodes(report).has("checkpoint_missing"), true);
  assert.throws(
    () => sealTraceEvent(options(paths, { event: { type: "third" } })),
    (error) => error instanceof TraceIntegrityError && error.code === "checkpoint_missing",
  );
});

test("adopts a complete fsynced event after a crash before checkpoint commit", (t) => {
  const paths = fixture(t, { legacy: false });
  sealTraceEvent(options(paths, { event: { type: "first" } }));
  assert.throws(
    () => sealTraceEvent(options(paths, {
      event: { type: "recover-me" },
      hooks: {
        after_append_fsync() {
          throw new Error("simulated process crash after append fsync");
        },
      },
    })),
    /simulated process crash/,
  );

  const before = verifyTraceIntegrity(options(paths));
  assert.equal(before.valid, false);
  assert.equal(before.recovery_needed, true);
  const recovered = recoverTraceIntegrity(options(paths));
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.adopted_events, 1);
  assert.equal(recovered.truncated_bytes, 0);
  assert.equal(recovered.checkpoint.new_writes.count, 2);
  assert.equal(verifyTraceIntegrity(options(paths)).valid, true);
});

test("canonical event hashes cover own __proto__ data, including recovery tails", (t) => {
  const paths = fixture(t, { legacy: false });
  const first = JSON.parse('{"type":"first","__proto__":{"value":"one"}}');
  const sealed = sealTraceEvent(options(paths, { event: first }));
  assert.equal(Object.hasOwn(sealed.event, "__proto__"), true);
  assert.equal(sealed.event.__proto__.value, "one");

  assert.throws(
    () => sealTraceEvent(options(paths, {
      event: JSON.parse('{"type":"tail","__proto__":{"value":"one"}}'),
      hooks: {
        after_append_fsync() {
          throw new Error("simulated crash with proto tail");
        },
      },
    })),
    /simulated crash with proto tail/u,
  );
  const before = fs.readFileSync(paths.tracePath, "utf8");
  const tampered = before.replace(
    '"type":"tail","__proto__":{"value":"one"}',
    '"type":"tail","__proto__":{"value":"two"}',
  );
  assert.notEqual(tampered, before);
  fs.writeFileSync(paths.tracePath, tampered);
  assert.throws(
    () => recoverTraceIntegrity(options(paths)),
    (error) => error instanceof TraceIntegrityError && error.code === "unexpected_complete_tail",
  );
});

test("truncates only an incomplete append and retains the last durable checkpoint", (t) => {
  const paths = fixture(t, { legacy: false });
  sealTraceEvent(options(paths, { event: { type: "first" } }));
  let injected = false;
  const partialWriter = (descriptor, buffer, offset, length, position) => {
    if (!injected) {
      injected = true;
      const partialLength = Math.max(1, Math.floor(length / 2));
      fs.writeSync(descriptor, buffer, offset, partialLength, position);
      const error = new Error("simulated partial append");
      error.code = "EIO";
      throw error;
    }
    return fs.writeSync(descriptor, buffer, offset, length, position);
  };
  assert.throws(
    () => sealTraceEvent(options(paths, {
      event: { type: "partial" },
      dependencies: { appendWriteSync: partialWriter },
    })),
    /simulated partial append/,
  );

  const recovered = recoverTraceIntegrity(options(paths));
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.adopted_events, 0);
  assert.ok(recovered.truncated_bytes > 0);
  const report = verifyTraceIntegrity(options(paths));
  assert.equal(report.valid, true);
  assert.equal(report.new_writes.count, 1);
});

test("refuses an incomplete legacy prefix rather than modifying it", (t) => {
  const paths = fixture(t, { legacy: false });
  fs.writeFileSync(paths.tracePath, '{"legacy":true}');
  assert.throws(
    () => sealTraceEvent(options(paths, { event: { type: "first" } })),
    (error) => error instanceof TraceIntegrityError && error.code === "legacy_prefix_incomplete",
  );
  assert.equal(fs.readFileSync(paths.tracePath, "utf8"), '{"legacy":true}');
});

test("removes its owned lock when lock write or durability fails", async (t) => {
  const scenarios = [
    {
      name: "write",
      dependencies(failure) {
        return {
          writeSync() {
            throw failure;
          },
        };
      },
    },
    {
      name: "file fsync",
      dependencies(failure) {
        let calls = 0;
        return {
          fsyncSync(descriptor) {
            calls += 1;
            if (calls === 1) throw failure;
            return fs.fsyncSync(descriptor);
          },
        };
      },
    },
    {
      name: "directory fsync",
      dependencies(failure) {
        let calls = 0;
        return {
          fsyncSync(descriptor) {
            calls += 1;
            if (calls === 2) throw failure;
            return fs.fsyncSync(descriptor);
          },
        };
      },
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, (scenarioTest) => {
      const paths = fixture(scenarioTest, { legacy: false });
      const lockPath = `${paths.checkpointPath}.lock`;
      const failure = new Error(`simulated lock ${scenario.name} failure`);
      failure.code = "EIO";

      assert.throws(
        () => sealTraceEvent(options(paths, {
          event: { type: "must-not-append" },
          dependencies: scenario.dependencies(failure),
        })),
        (error) => error === failure,
      );
      assert.equal(fs.existsSync(lockPath), false);

      const retry = sealTraceEvent(options(paths, { event: { type: "retry" } }));
      assert.equal(retry.event._trace_integrity.sequence, 1);
      assert.equal(fs.existsSync(lockPath), false);
    });
  }
});

test("does not delete a replacement installed after creating its lock", (t) => {
  const paths = fixture(t, { legacy: false });
  const lockPath = `${paths.checkpointPath}.lock`;
  const displacedPath = `${lockPath}.displaced`;
  const replacement = `${JSON.stringify({ pid: process.pid, token: "replacement" })}\n`;
  const failure = new Error("simulated write failure after lock replacement");
  failure.code = "EIO";
  let replaced = false;

  const writeSync = (descriptor) => {
    if (!replaced) {
      replaced = true;
      fs.closeSync(descriptor);
      fs.renameSync(lockPath, displacedPath);
      fs.writeFileSync(lockPath, replacement, { mode: 0o600 });
    }
    throw failure;
  };

  assert.throws(
    () => sealTraceEvent(options(paths, {
      event: { type: "must-not-append" },
      dependencies: { writeSync },
    })),
    (error) => error === failure,
  );
  assert.equal(replaced, true);
  assert.equal(fs.readFileSync(lockPath, "utf8"), replacement);
  assert.equal(fs.existsSync(displacedPath), true);
});

test("does not treat a replacement lock as owned when 64-bit inodes collide as Number", (t) => {
  const paths = fixture(t, { legacy: false });
  const lockPath = `${paths.checkpointPath}.lock`;
  const displacedPath = `${lockPath}.displaced`;
  const replacement = `${JSON.stringify({ pid: process.pid, token: "replacement" })}\n`;
  const failure = new Error("simulated write failure after lock replacement");
  failure.code = "EIO";
  let replaced = false;

  // Every real file gets a distinct 64-bit inode above 2^53 (as NTFS file ids
  // do), spaced closely enough that adjacent ids round to the same Number.
  const wideInoBase = 2n ** 60n;
  const wideInos = new Map();
  assert.equal(Number(wideInoBase + 1n), Number(wideInoBase + 2n));
  const widen = (stat, options) => {
    const realIno = BigInt(stat.ino);
    if (!wideInos.has(realIno)) wideInos.set(realIno, wideInoBase + BigInt(wideInos.size + 1));
    const wide = wideInos.get(realIno);
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
      ino: options?.bigint ? wide : Number(wide),
    });
  };
  const fstatSync = (descriptor, options) => widen(fs.fstatSync(descriptor, options), options);
  const lstatSync = (filePath, options) => widen(fs.lstatSync(filePath, options), options);
  const writeSync = (descriptor) => {
    if (!replaced) {
      replaced = true;
      fs.closeSync(descriptor);
      fs.renameSync(lockPath, displacedPath);
      fs.writeFileSync(lockPath, replacement, { mode: 0o600 });
    }
    throw failure;
  };

  assert.throws(
    () => sealTraceEvent(options(paths, {
      event: { type: "must-not-append" },
      dependencies: { fstatSync, lstatSync, writeSync },
    })),
    (error) => error === failure,
  );
  assert.equal(replaced, true);
  assert.equal(fs.readFileSync(lockPath, "utf8"), replacement);
  assert.equal(fs.existsSync(displacedPath), true);
});

test("preserves a lock acquisition failure when owned-lock cleanup also fails", (t) => {
  const paths = fixture(t, { legacy: false });
  const lockPath = `${paths.checkpointPath}.lock`;
  const primary = new Error("simulated lock write failure");
  primary.code = "EIO";
  const cleanup = new Error("simulated lock cleanup failure");
  cleanup.code = "EACCES";

  assert.throws(
    () => sealTraceEvent(options(paths, {
      event: { type: "must-not-append" },
      dependencies: {
        writeSync() {
          throw primary;
        },
        unlinkSync() {
          throw cleanup;
        },
      },
    })),
    (error) => error === primary
      && Array.isArray(error.cleanup_errors)
      && error.cleanup_errors.length === 1
      && error.cleanup_errors[0] === cleanup,
  );
  assert.equal(fs.existsSync(lockPath), true);
});

test("serializes writers with an owned lock and reclaims a proven dead owner", (t) => {
  const paths = fixture(t, { legacy: false });
  fs.mkdirSync(path.dirname(paths.checkpointPath), { recursive: true });
  const lockPath = `${paths.checkpointPath}.lock`;
  fs.writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, token: "live" })}\n`);
  assert.throws(
    () => sealTraceEvent(options(paths, {
      event: { type: "blocked" },
      lockTimeoutMs: 0,
    })),
    (error) => error instanceof TraceIntegrityError && error.code === "lock_timeout",
  );

  fs.writeFileSync(lockPath, `${JSON.stringify({ pid: 999_999_999, token: "dead" })}\n`);
  const result = sealTraceEvent(options(paths, {
    event: { type: "after-dead-owner" },
    dependencies: { processAlive: () => false },
  }));
  assert.equal(result.event._trace_integrity.sequence, 1);
  assert.equal(fs.existsSync(lockPath), false);
});

test("retries when a live lock disappears or changes during its bounded read", (t) => {
  const paths = fixture(t, { legacy: false });
  fs.mkdirSync(path.dirname(paths.checkpointPath), { recursive: true });
  const lockPath = `${paths.checkpointPath}.lock`;
  fs.writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, token: "live" })}\n`);
  let injected = false;
  const readSync = (descriptor, buffer, offset, length, position) => {
    if (!injected) {
      injected = true;
      fs.appendFileSync(lockPath, "changed-during-read");
      fs.unlinkSync(lockPath);
    }
    return fs.readSync(descriptor, buffer, offset, length, position);
  };

  const result = sealTraceEvent(options(paths, {
    event: { type: "after-transient-lock" },
    dependencies: { readSync },
  }));
  assert.equal(injected, true);
  assert.equal(result.event._trace_integrity.sequence, 1);
  assert.equal(fs.existsSync(lockPath), false);
});

test("retries a transient exclusive-open permission race without weakening the lock", (t) => {
  const paths = fixture(t, { legacy: false });
  const lockPath = `${paths.checkpointPath}.lock`;
  let injected = false;
  let inspectionInjected = false;
  const openSync = (filePath, flags, mode) => {
    if (!injected && filePath.endsWith(".lock")) {
      injected = true;
      const error = new Error("simulated transient exclusive-open collision");
      error.code = "EPERM";
      throw error;
    }
    return fs.openSync(filePath, flags, mode);
  };
  const lstatSync = (filePath, options) => {
    if (injected && !inspectionInjected && filePath.endsWith(".lock")) {
      inspectionInjected = true;
      const error = new Error("simulated transient lock inspection collision");
      error.code = "EPERM";
      throw error;
    }
    return fs.lstatSync(filePath, options);
  };

  const result = sealTraceEvent(options(paths, {
    event: { type: "after-transient-open-collision" },
    dependencies: { lstatSync, openSync, platform: "win32" },
  }));

  assert.equal(injected, true);
  assert.equal(inspectionInjected, true);
  assert.equal(result.event._trace_integrity.sequence, 1);
  assert.equal(verifyTraceIntegrity(options(paths)).valid, true);
  assert.equal(fs.existsSync(lockPath), false);
});

test("bounds a persistent Windows permission collision without creating trace state", (t) => {
  const paths = fixture(t, { legacy: false });
  const lockPath = `${paths.checkpointPath}.lock`;
  const permissionError = () => {
    const error = new Error("simulated persistent lock permission collision");
    error.code = "EPERM";
    return error;
  };

  assert.throws(
    () => sealTraceEvent(options(paths, {
      event: { type: "must-not-be-written" },
      lockRetryMs: 1,
      lockTimeoutMs: 2,
      dependencies: {
        platform: "win32",
        openSync(filePath, flags, mode) {
          if (filePath.endsWith(".lock")) throw permissionError();
          return fs.openSync(filePath, flags, mode);
        },
        lstatSync(filePath, options) {
          if (filePath.endsWith(".lock")) throw permissionError();
          return fs.lstatSync(filePath, options);
        },
      },
    })),
    (error) => error instanceof TraceIntegrityError && error.code === "lock_timeout",
  );

  assert.equal(fs.existsSync(paths.tracePath), false);
  assert.equal(fs.existsSync(paths.checkpointPath), false);
  assert.equal(fs.existsSync(lockPath), false);
});

test("does not reinterpret a permanent POSIX permission failure as lock contention", (t) => {
  const paths = fixture(t, { legacy: false });
  let lockInspectionCalls = 0;
  const error = new Error("simulated permanent lock permission failure");
  error.code = "EACCES";

  assert.throws(
    () => sealTraceEvent(options(paths, {
      event: { type: "must-fail-immediately" },
      dependencies: {
        platform: "darwin",
        openSync(filePath, flags, mode) {
          if (filePath.endsWith(".lock")) throw error;
          return fs.openSync(filePath, flags, mode);
        },
        lstatSync(filePath, options) {
          if (filePath.endsWith(".lock")) lockInspectionCalls += 1;
          return fs.lstatSync(filePath, options);
        },
      },
    })),
    (actual) => actual === error,
  );

  assert.equal(lockInspectionCalls, 0);
  assert.equal(fs.existsSync(paths.tracePath), false);
  assert.equal(fs.existsSync(paths.checkpointPath), false);
});

test("serializes concurrent subprocess writers into one complete hash chain", async (t) => {
  const paths = fixture(t, { legacy: false });
  const writerCount = 8;
  const moduleUrl = pathToFileURL(path.resolve("lib/trace-integrity.mjs")).href;
  const source = [
    `import { sealTraceEvent } from ${JSON.stringify(moduleUrl)};`,
    "sealTraceEvent({",
    "  boundaryRoot: process.env.TRACE_BOUNDARY_ROOT,",
    "  tracePath: process.env.TRACE_FILE,",
    "  checkpointPath: process.env.TRACE_CHECKPOINT,",
    "  event: { type: 'concurrent-writer', writer: process.env.TRACE_WRITER },",
    "  lockTimeoutMs: 15000,",
    "});",
  ].join("\n");

  const results = await Promise.all(Array.from({ length: writerCount }, (_, index) => new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
      env: {
        ...process.env,
        TRACE_BOUNDARY_ROOT: paths.root,
        TRACE_FILE: paths.tracePath,
        TRACE_CHECKPOINT: paths.checkpointPath,
        TRACE_WRITER: String(index + 1),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("exit", (code, signal) => resolve({ code, signal, stderr }));
  })));

  for (const result of results) {
    assert.equal(result.code, 0, result.stderr || `writer exited via ${result.signal}`);
  }
  const report = verifyTraceIntegrity(options(paths));
  assert.equal(report.valid, true);
  assert.equal(report.new_writes.count, writerCount);
  const records = jsonLines(paths.tracePath);
  assert.deepEqual(
    records.map((record) => record._trace_integrity.sequence),
    Array.from({ length: writerCount }, (_, index) => index + 1),
  );
  const integrityDirectory = path.dirname(paths.checkpointPath);
  assert.equal(fs.existsSync(`${paths.checkpointPath}.lock`), false);
  assert.equal(fs.existsSync(`${paths.checkpointPath}.previous`), false);
  assert.equal(
    fs.readdirSync(integrityDirectory).some((name) => name.endsWith(".tmp")),
    false,
  );
});

test("rejects a symbolic-link trace at the no-follow append boundary", (t) => {
  if (process.platform === "win32") return;
  const paths = fixture(t, { legacy: false });
  const target = path.join(paths.root, "target.jsonl");
  fs.writeFileSync(target, "");
  fs.symlinkSync(target, paths.tracePath);

  assert.throws(
    () => sealTraceEvent(options(paths, { event: { type: "first" } })),
    (error) => error instanceof TraceIntegrityError && error.code === "symlink_forbidden",
  );
});

test("rejects symbolic-link parent directories and paths outside the trusted boundary", (t) => {
  if (process.platform === "win32") return;
  const paths = fixture(t, { legacy: false });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "trace-integrity-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true, maxRetries: 3 }));

  const traceDirectory = path.join(paths.root, "traces");
  fs.symlinkSync(outside, traceDirectory, "dir");
  const escapedTrace = path.join(traceDirectory, "project.jsonl");
  assert.throws(
    () => sealTraceEvent({
      boundaryRoot: paths.root,
      tracePath: escapedTrace,
      checkpointPath: paths.checkpointPath,
      event: { type: "first" },
    }),
    (error) => error instanceof TraceIntegrityError && error.code === "symlink_forbidden",
  );
  assert.equal(fs.existsSync(path.join(outside, "project.jsonl")), false);

  fs.unlinkSync(traceDirectory);
  const checkpointDirectory = path.dirname(paths.checkpointPath);
  fs.symlinkSync(outside, checkpointDirectory, "dir");
  assert.throws(
    () => sealTraceEvent(options(paths, { event: { type: "first" } })),
    (error) => error instanceof TraceIntegrityError && error.code === "symlink_forbidden",
  );
  assert.equal(fs.readdirSync(outside).length, 0);

  assert.throws(
    () => sealTraceEvent({
      boundaryRoot: paths.root,
      tracePath: path.join(outside, "escaped.jsonl"),
      event: { type: "first" },
    }),
    (error) => error instanceof TraceIntegrityError && error.code === "path_outside_boundary",
  );
});

test("rejects aliases and file-directory nesting across trace integrity paths", (t) => {
  const paths = fixture(t, { legacy: false });
  const aliases = [
    { checkpointPath: paths.tracePath },
    { lockPath: paths.tracePath },
    { lockPath: `${paths.checkpointPath}.previous` },
    {
      tracePath: paths.checkpointPath,
      checkpointPath: path.join(paths.checkpointPath, "nested.json"),
    },
  ];
  for (const override of aliases) {
    assert.throws(
      () => sealTraceEvent(options(paths, { ...override, event: { type: "first" } })),
      (error) => error instanceof TraceIntegrityError
        && ["invalid_path", "path_alias_forbidden"].includes(error.code),
    );
  }
  assert.equal(fs.existsSync(paths.tracePath), false);
  assert.equal(fs.existsSync(paths.checkpointPath), false);
});

test("uses the deterministic Windows checkpoint replacement fallback", (t) => {
  const paths = fixture(t, { legacy: false });
  sealTraceEvent(options(paths, { event: { type: "first" } }));
  const canonicalCheckpointPath = path.join(
    (fs.realpathSync.native ?? fs.realpathSync)(path.dirname(paths.checkpointPath)),
    path.basename(paths.checkpointPath),
  );
  let fallbackTriggered = false;
  const renameSync = (source, destination) => {
    const replacingCheckpoint = destination === canonicalCheckpointPath
      && path.basename(source).endsWith(".tmp")
      && fs.existsSync(canonicalCheckpointPath);
    if (replacingCheckpoint && !fallbackTriggered) {
      fallbackTriggered = true;
      const error = new Error("simulated Windows replacement denial");
      error.code = "EPERM";
      throw error;
    }
    return fs.renameSync(source, destination);
  };

  const result = sealTraceEvent(options(paths, {
    event: { type: "second" },
    dependencies: { platform: "win32", renameSync },
  }));
  assert.equal(fallbackTriggered, true);
  assert.equal(result.event._trace_integrity.sequence, 2);
  assert.equal(fs.existsSync(`${paths.checkpointPath}.previous`), false);
  assert.equal(verifyTraceIntegrity(options(paths)).valid, true);
});

test("rejects reserved metadata and non-JSON event values", (t) => {
  const paths = fixture(t, { legacy: false });
  assert.throws(
    () => sealTraceEvent(options(paths, { event: { _trace_integrity: {} } })),
    (error) => error instanceof TraceIntegrityError && error.code === "reserved_field",
  );
  assert.throws(
    () => sealTraceEvent(options(paths, { event: { invalid: undefined } })),
    (error) => error instanceof TraceIntegrityError && error.code === "non_json_value",
  );
});
