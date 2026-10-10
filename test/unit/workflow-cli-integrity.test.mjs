import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { verifyTraceIntegrity } from "../../lib/trace-integrity.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = path.join(ROOT, "bin", "agentic-sdlc.mjs");
const TEMPORARY_DIRECTORIES = new Set();

after(() => {
  for (const directory of TEMPORARY_DIRECTORIES) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryProject(label) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `agentic-sdlc-workflow-integrity-${label}-`));
  TEMPORARY_DIRECTORIES.add(directory);
  return directory;
}

function sanitizedEnvironment(overrides = {}) {
  const env = { ...process.env, ...overrides };
  for (const key of ["CI", "GITHUB_ACTIONS", "GITHUB_ACTOR", "CODEX_AGENT_NAME", "CODEX_USER_ID", "CLAUDECODE", "AGENTIC_SDLC_AGENT_HOST"]) delete env[key];
  return env;
}

function run(args, cwd, envOverrides = {}, options = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: sanitizedEnvironment(envOverrides),
    timeout: options.timeout ?? 30_000,
  });
}

function runConcurrently(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: sanitizedEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

function mustRun(args, cwd) {
  const result = run(args, cwd);
  assert.equal(result.status, 0, `${args.join(" ")}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result.stdout;
}

function mustRunJson(args, cwd) {
  return JSON.parse(mustRun([...args, "--json"], cwd));
}

function instanceFiles(project, instanceId) {
  const root = path.join(project, ".sdlc", "workflows", "instances", instanceId);
  return {
    root,
    events: path.join(root, "events.jsonl"),
    checkpoint: path.join(root, "checkpoint.json"),
    pending: path.join(root, "pending-transition.json"),
    startTransaction: path.join(project, ".sdlc", "workflows", "instances", ".starts", `${instanceId}.json`),
    trace: path.join(project, ".sdlc", "traces", "project.jsonl"),
  };
}

function projectTraceEvents(project) {
  const tracePath = path.join(project, ".sdlc", "traces", "project.jsonl");
  if (!fs.existsSync(tracePath)) return [];
  return fs.readFileSync(tracePath, "utf8").split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}

function replaceOwnedJsonLineWithPartial(filePath, anchor, value, bytesToKeep = 11) {
  const current = fs.existsSync(filePath) ? fs.readFileSync(filePath) : Buffer.alloc(0);
  assert.ok(current.length >= anchor.size_bytes);
  const expectedLine = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  const partialLength = Math.max(1, Math.min(bytesToKeep, expectedLine.length - 1));
  fs.writeFileSync(filePath, Buffer.concat([
    current.subarray(0, anchor.size_bytes),
    expectedLine.subarray(0, partialLength),
  ]));
}

function startChangeRequest(project, instanceId) {
  mustRun(["init", "--root", project, "--project-name", `Integrity ${instanceId}`], project);
  return mustRunJson([
    "workflow", "instance", "start",
    "--root", project,
    "--id", instanceId,
    "--definition", "change-request",
    "--definition-version", "1",
  ], project);
}

function transition(project, instanceId, requestId, extra = []) {
  return run([
    "workflow", "instance", "transition",
    "--root", project,
    "--id", instanceId,
    "--to", "impact-review",
    "--request-id", requestId,
    ...extra,
  ], project);
}

test("concurrent starts for one id create exactly one complete instance", async () => {
  const project = temporaryProject("concurrent-start");
  const instanceId = "change-created-once";
  mustRun(["init", "--root", project, "--project-name", "Concurrent workflow start"], project);
  const args = [
    "workflow", "instance", "start",
    "--root", project,
    "--id", instanceId,
    "--definition", "change-request",
    "--definition-version", "1",
    "--json",
  ];

  const results = await Promise.all([
    runConcurrently(args, project),
    runConcurrently(args, project),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [0, 1], JSON.stringify(results, null, 2));
  const winner = JSON.parse(results.find((result) => result.status === 0).stdout);
  assert.equal(winner.status, "started");

  const files = instanceFiles(project, instanceId);
  assert.equal(fs.existsSync(files.root), true);
  assert.equal(fs.readFileSync(files.events, "utf8"), "");
  const checkpoint = JSON.parse(fs.readFileSync(files.checkpoint, "utf8"));
  assert.equal(checkpoint.sequence, 0);
  assert.equal(checkpoint.current_state, "intake");
  assert.equal(fs.existsSync(files.pending), false);
  assert.equal(
    projectTraceEvents(project).filter((event) =>
      event.action === "workflow.instance.start" && event.related?.includes(instanceId)).length,
    1,
  );

  const status = mustRunJson([
    "workflow", "instance", "status", "--root", project, "--id", instanceId,
  ], project);
  assert.equal(status.status, "ready");
  assert.equal(status.current_state, "intake");
});

test("trace ownership does not confuse an instance id with a definition id", () => {
  const project = temporaryProject("trace-ownership-collision");
  mustRun(["init", "--root", project, "--project-name", "Trace ownership collision"], project);
  for (const instanceId of ["change-request", "another-change"]) {
    mustRunJson([
      "workflow", "instance", "start",
      "--root", project,
      "--id", instanceId,
      "--definition", "change-request",
      "--definition-version", "1",
    ], project);
  }
  const status = mustRunJson([
    "workflow", "instance", "status", "--root", project, "--id", "change-request",
  ], project);
  assert.equal(status.status, "ready");
  assert.equal(status.current_state, "intake");
});

test("sealed trace append, workflow start and transition remain one strict chain before another append", () => {
  const project = temporaryProject("sealed-writer-chain");
  const instanceId = "change-sealed-writer-chain";
  mustRun(["init", "--root", project, "--project-name", "Sealed writer chain"], project);
  const first = mustRunJson([
    "trace", "append",
    "--root", project,
    "--type", "decision",
    "--summary", "Initial sealed audit event",
  ], project);
  assert.equal(first.event._trace_integrity.sequence, 1);

  mustRunJson([
    "workflow", "instance", "start",
    "--root", project,
    "--id", instanceId,
    "--definition", "change-request",
    "--definition-version", "1",
  ], project);
  const secret = `github_pat_${"A".repeat(32)}`;
  const moved = mustRunJson([
    "workflow", "instance", "transition",
    "--root", project,
    "--id", instanceId,
    "--to", "impact-review",
    "--request-id", "sealed-writer-transition",
    "--summary", `credential=${secret}`,
  ], project);
  assert.equal(moved.status, "transitioned");

  const files = instanceFiles(project, instanceId);
  const integrityOptions = {
    boundaryRoot: path.join(project, ".sdlc"),
    tracePath: files.trace,
  };
  assert.equal(verifyTraceIntegrity(integrityOptions).valid, true);
  let traces = projectTraceEvents(project);
  assert.deepEqual(traces.map((event) => event._trace_integrity?.sequence), [1, 2, 3]);
  assert.equal(traces.some((event) => JSON.stringify(event).includes(secret)), false);
  assert.equal(
    traces.find((event) => event.action === "workflow.instance.transition").summary,
    "[REDACTED]",
  );

  const strictGate = run(["gate", "check", "--root", project, "--strict", "--json"], project);
  const strictReport = JSON.parse(strictGate.stdout);
  assert.equal(strictReport.checked.includes("trace traces/project.jsonl local integrity checkpoint"), true);
  assert.equal(strictReport.errors.some((error) => /trace traces\/project\.jsonl integrity/u.test(error)), false);

  const last = mustRunJson([
    "trace", "append",
    "--root", project,
    "--type", "decision",
    "--summary", "Post-workflow sealed audit event",
  ], project);
  assert.equal(last.event._trace_integrity.sequence, 4);
  assert.equal(verifyTraceIntegrity(integrityOptions).valid, true);
  traces = projectTraceEvents(project);
  assert.deepEqual(traces.map((event) => event._trace_integrity?.sequence), [1, 2, 3, 4]);
});

test("completed 0.11 workflow traces remain immutable as a verified legacy prefix", () => {
  const project = temporaryProject("legacy-completed-trace");
  const instanceId = "change-legacy-completed-trace";
  startChangeRequest(project, instanceId);
  assert.equal(transition(project, instanceId, "legacy-completed-transition", ["--json"]).status, 0);
  const files = instanceFiles(project, instanceId);
  const legacyEvents = projectTraceEvents(project).map((event) => {
    const { _trace_integrity: _integrityEnvelope, ...legacyEvent } = event;
    return legacyEvent;
  });
  const legacyBytes = Buffer.from(`${legacyEvents.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  fs.writeFileSync(files.trace, legacyBytes);
  fs.rmSync(path.join(project, ".sdlc", "traces", ".integrity"), { recursive: true, force: true });

  const status = mustRunJson([
    "workflow", "instance", "status", "--root", project, "--id", instanceId,
  ], project);
  assert.equal(status.status, "ready");
  assert.equal(status.current_state, "impact-review");
  assert.deepEqual(fs.readFileSync(files.trace), legacyBytes);

  const integrityOptions = {
    boundaryRoot: path.join(project, ".sdlc"),
    tracePath: files.trace,
  };
  const legacyIntegrity = verifyTraceIntegrity(integrityOptions);
  assert.equal(legacyIntegrity.valid, true);
  assert.equal(legacyIntegrity.initialized, false);
  const appended = mustRunJson([
    "trace", "append",
    "--root", project,
    "--type", "decision",
    "--summary", "Seal after the verified workflow legacy prefix",
  ], project);
  assert.equal(appended.event._trace_integrity.sequence, 1);
  assert.deepEqual(fs.readFileSync(files.trace).subarray(0, legacyBytes.length), legacyBytes);
  assert.equal(verifyTraceIntegrity(integrityOptions).valid, true);
  assert.equal(mustRunJson([
    "workflow", "instance", "status", "--root", project, "--id", instanceId,
  ], project).current_state, "impact-review");
});

test("a pending 0.11 raw trace suffix is replaced by one sealed record only when it is exact", () => {
  const project = temporaryProject("legacy-pending-exact");
  const instanceId = "change-legacy-pending-exact";
  startChangeRequest(project, instanceId);
  const files = instanceFiles(project, instanceId);
  const startTrace = projectTraceEvents(project)[0];
  const { _trace_integrity: _startIntegrity, ...legacyStartTrace } = startTrace;
  fs.writeFileSync(files.trace, `${JSON.stringify(legacyStartTrace)}\n`);
  fs.rmSync(path.join(project, ".sdlc", "traces", ".integrity"), { recursive: true, force: true });
  const requestId = "legacy-pending-exact";
  const interrupted = run([
    "workflow", "instance", "transition",
    "--root", project,
    "--id", instanceId,
    "--to", "impact-review",
    "--request-id", requestId,
    "--json",
  ], project, {
    NODE_ENV: "test",
    AGENTIC_SDLC_TEST_WORKFLOW_FAILURE_PHASE: "after-checkpoint-before-trace",
  });
  assert.equal(interrupted.status, 1, interrupted.stderr);
  const journal = JSON.parse(fs.readFileSync(files.pending, "utf8"));
  fs.appendFileSync(files.trace, `${JSON.stringify(journal.trace_event)}\n`);

  const recovered = transition(project, instanceId, requestId, ["--json"]);
  assert.equal(recovered.status, 0, `${recovered.stdout}\n${recovered.stderr}`);
  assert.equal(JSON.parse(recovered.stdout).idempotent, true);
  assert.equal(fs.existsSync(files.pending), false);
  const workflowTraces = projectTraceEvents(project).filter((event) =>
    event.action === "workflow.instance.transition" && event.related?.[0] === instanceId);
  assert.equal(workflowTraces.length, 1);
  assert.equal(workflowTraces[0]._trace_integrity.schema_version, "trace-integrity-event:v1");
  assert.equal(projectTraceEvents(project)[0]._trace_integrity, undefined);
  assert.equal(verifyTraceIntegrity({
    boundaryRoot: path.join(project, ".sdlc"),
    tracePath: files.trace,
  }).valid, true);
});

test("a pending 0.11 raw trace with later records is preserved and blocked", () => {
  const project = temporaryProject("legacy-pending-later-record");
  const instanceId = "change-legacy-pending-later-record";
  startChangeRequest(project, instanceId);
  const files = instanceFiles(project, instanceId);
  const requestId = "legacy-pending-later-record";
  const interrupted = run([
    "workflow", "instance", "transition",
    "--root", project,
    "--id", instanceId,
    "--to", "impact-review",
    "--request-id", requestId,
    "--json",
  ], project, {
    NODE_ENV: "test",
    AGENTIC_SDLC_TEST_WORKFLOW_FAILURE_PHASE: "after-checkpoint-before-trace",
  });
  assert.equal(interrupted.status, 1, interrupted.stderr);
  const journal = JSON.parse(fs.readFileSync(files.pending, "utf8"));
  fs.appendFileSync(files.trace, [
    JSON.stringify(journal.trace_event),
    JSON.stringify({ id: "TR-LATER-LEGACY", type: "decision", summary: "must be preserved" }),
    "",
  ].join("\n"));
  const traceBytes = fs.readFileSync(files.trace);
  const pendingBytes = fs.readFileSync(files.pending);

  const retry = transition(project, instanceId, requestId, ["--json"]);
  assert.equal(retry.status, 1, `${retry.stdout}\n${retry.stderr}`);
  assert.deepEqual(fs.readFileSync(files.trace), traceBytes);
  assert.deepEqual(fs.readFileSync(files.pending), pendingBytes);
  assert.match(JSON.parse(retry.stderr).error.message, /later audit records must be preserved/u);
});

test("start refuses an orphaned legitimate audit trace that already claims the instance id", () => {
  const project = temporaryProject("start-trace-ownership-conflict");
  const instanceId = "reserved-workflow-instance";
  mustRun(["init", "--root", project, "--project-name", "Start trace ownership conflict"], project);
  mustRunJson([
    "workflow", "instance", "start",
    "--root", project,
    "--id", instanceId,
    "--definition", "change-request",
    "--definition-version", "1",
  ], project);
  const files = instanceFiles(project, instanceId);
  const traceBytes = fs.readFileSync(files.trace);
  fs.rmSync(files.root, { recursive: true });

  const start = run([
    "workflow", "instance", "start",
    "--root", project,
    "--id", instanceId,
    "--definition", "change-request",
    "--definition-version", "1",
    "--json",
  ], project);
  assert.equal(start.status, 1, `${start.stdout}\n${start.stderr}`);
  assert.match(`${start.stdout}\n${start.stderr}`, /conflicting audit ownership/u);
  assert.equal(fs.existsSync(files.root), false);
  assert.equal(fs.existsSync(files.startTransaction), false);
  assert.deepEqual(fs.readFileSync(files.trace), traceBytes);
});

test("a start trace failure exposes no usable partial instance and the same start can be retried", () => {
  for (const phase of ["before-append", "after-append-before-sync"]) {
    const project = temporaryProject(`start-trace-${phase}`);
    const instanceId = `change-start-trace-${phase}`;
    mustRun(["init", "--root", project, "--project-name", `Start trace ${phase}`], project);
    const args = [
      "workflow", "instance", "start",
      "--root", project,
      "--id", instanceId,
      "--definition", "change-request",
      "--definition-version", "1",
      "--json",
    ];
    const interrupted = run(args, project, {
      NODE_ENV: "test",
      AGENTIC_SDLC_TEST_WORKFLOW_START_TRACE_FAILURE: phase,
    });
    const files = instanceFiles(project, instanceId);
    assert.equal(interrupted.status, 1, `${interrupted.stdout}\n${interrupted.stderr}`);
    assert.equal(fs.existsSync(files.root), true);
    assert.equal(fs.existsSync(files.startTransaction), true);
    const blocked = run([
      "workflow", "instance", "status", "--root", project, "--id", instanceId, "--json",
    ], project);
    assert.equal(blocked.status, 1, `${blocked.stdout}\n${blocked.stderr}`);
    const blockedPayload = JSON.parse(blocked.stderr);
    assert.equal(Object.hasOwn(blockedPayload, "current_state"), false);
    if (phase === "before-append") {
      assert.equal(projectTraceEvents(project).some((event) =>
        event.action === "workflow.instance.start" && event.related?.includes(instanceId)), false);
      const journal = JSON.parse(fs.readFileSync(files.startTransaction, "utf8"));
      replaceOwnedJsonLineWithPartial(files.trace, journal.trace_anchor, journal.trace_event);
    }
    const retried = run(args, project);
    assert.equal(retried.status, 0, `${retried.stdout}\n${retried.stderr}`);
    assert.equal(JSON.parse(retried.stdout).recovered, true);
    assert.equal(fs.existsSync(files.startTransaction), false);
    assert.equal(fs.existsSync(files.root), true);
    assert.equal(fs.readFileSync(files.events, "utf8"), "");
    assert.equal(JSON.parse(fs.readFileSync(files.checkpoint, "utf8")).sequence, 0);
    assert.equal(projectTraceEvents(project).filter((event) =>
      event.action === "workflow.instance.start" && event.related?.includes(instanceId)).length, 1);
  }
});

test("an actual process termination during start is recovered from durable staging exactly once", () => {
  for (const phase of [
    "during-staging-instance.json",
    "after-staging-before-publish",
    "after-publish-before-trace",
  ]) {
    const project = temporaryProject(`start-crash-${phase}`);
    const instanceId = `change-start-crash-${phase}`;
    mustRun(["init", "--root", project, "--project-name", `Start crash ${phase}`], project);
    const args = [
      "workflow", "instance", "start",
      "--root", project,
      "--id", instanceId,
      "--definition", "change-request",
      "--definition-version", "1",
      "--json",
    ];
    const crashed = run(args, project, {
      NODE_ENV: "test",
      AGENTIC_SDLC_TEST_WORKFLOW_START_CRASH_PHASE: phase,
    }, { timeout: 90_000 });
    assert.notEqual(crashed.status, 0, `${crashed.stdout}\n${crashed.stderr}`);
    assert.equal(
      crashed.error,
      undefined,
      `${phase} reached the subprocess timeout instead of the requested crash point: `
        + `${crashed.error?.message || "unknown timeout error"}\n`
        + `${crashed.stdout}\n${crashed.stderr}`,
    );
    if (process.platform !== "win32") {
      assert.equal(
        crashed.signal,
        "SIGKILL",
        `${phase} exited without the requested SIGKILL crash: ${crashed.signal || "no signal"}`,
      );
    }

    const files = instanceFiles(project, instanceId);
    const staging = path.join(project, ".sdlc", "workflows", "instances", ".staging", instanceId);
    assert.equal(fs.existsSync(files.startTransaction), true, phase);
    assert.equal(fs.existsSync(files.root), phase === "after-publish-before-trace", phase);
    assert.equal(fs.existsSync(staging), phase !== "after-publish-before-trace", phase);

    const retried = run(args, project);
    assert.equal(retried.status, 0, `${phase}\n${retried.stdout}\n${retried.stderr}`);
    assert.equal(JSON.parse(retried.stdout).recovered, true);
    assert.equal(fs.existsSync(files.startTransaction), false);
    assert.equal(fs.existsSync(staging), false);
    assert.equal(fs.existsSync(files.root), true);
    assert.equal(fs.readFileSync(files.events, "utf8"), "");
    assert.equal(JSON.parse(fs.readFileSync(files.checkpoint, "utf8")).sequence, 0);
    assert.equal(projectTraceEvents(project).filter((event) =>
      event.action === "workflow.instance.start" && event.related?.includes(instanceId)).length, 1);
  }
});

test("start recovery preserves divergent staging bytes and fails closed", () => {
  const project = temporaryProject("start-staging-divergent");
  const instanceId = "change-start-staging-divergent";
  mustRun(["init", "--root", project, "--project-name", "Divergent start staging"], project);
  const args = [
    "workflow", "instance", "start",
    "--root", project,
    "--id", instanceId,
    "--definition", "change-request",
    "--definition-version", "1",
    "--json",
  ];
  const crashed = run(args, project, {
    NODE_ENV: "test",
    AGENTIC_SDLC_TEST_WORKFLOW_START_CRASH_PHASE: "after-staging-before-publish",
  });
  assert.notEqual(crashed.status, 0);
  const files = instanceFiles(project, instanceId);
  const stagedInstance = path.join(
    project,
    ".sdlc", "workflows", "instances", ".staging", instanceId, "instance.json",
  );
  fs.writeFileSync(stagedInstance, "{\"divergent\":true}\n");
  const divergentBytes = fs.readFileSync(stagedInstance);
  const journalBytes = fs.readFileSync(files.startTransaction);

  const retry = run(args, project);
  assert.equal(retry.status, 1, `${retry.stdout}\n${retry.stderr}`);
  assert.deepEqual(fs.readFileSync(stagedInstance), divergentBytes);
  assert.deepEqual(fs.readFileSync(files.startTransaction), journalBytes);
  assert.equal(fs.existsSync(files.root), false);
});

test("the same request recovers every interrupted persistence boundary exactly once", () => {
  for (const phase of [
    "after-event-before-checkpoint",
    "after-checkpoint-before-trace",
    "after-trace-before-journal-clear",
  ]) {
    const project = temporaryProject(`recovery-${phase}`);
    const instanceId = `change-recovery-${phase}`;
    startChangeRequest(project, instanceId);
    const files = instanceFiles(project, instanceId);
    const requestId = `recover-${phase}`;
    const interrupted = run([
      "workflow", "instance", "transition",
      "--root", project,
      "--id", instanceId,
      "--to", "impact-review",
      "--request-id", requestId,
      "--json",
    ], project, {
      NODE_ENV: "test",
      AGENTIC_SDLC_TEST_WORKFLOW_FAILURE_PHASE: phase,
    });
    assert.equal(interrupted.status, 1, `${phase}\n${interrupted.stdout}\n${interrupted.stderr}`);
    assert.equal(fs.existsSync(files.pending), true, phase);

    const beforeStatus = {
      events: fs.readFileSync(files.events),
      checkpoint: fs.readFileSync(files.checkpoint),
      pending: fs.readFileSync(files.pending),
      trace: fs.readFileSync(files.trace),
    };
    const blockedStatus = run([
      "workflow", "instance", "status",
      "--root", project,
      "--id", instanceId,
      "--json",
    ], project);
    assert.equal(blockedStatus.status, 1, `${phase}\n${blockedStatus.stdout}\n${blockedStatus.stderr}`);
    const blockedPayload = JSON.parse(blockedStatus.stdout);
    assert.equal(blockedPayload.status, "blocked");
    assert.deepEqual(blockedPayload.recovery, {
      available: true,
      request_id: requestId,
      target_state: "impact-review",
    });
    assert.deepEqual(fs.readFileSync(files.events), beforeStatus.events);
    assert.deepEqual(fs.readFileSync(files.checkpoint), beforeStatus.checkpoint);
    assert.deepEqual(fs.readFileSync(files.pending), beforeStatus.pending);
    assert.deepEqual(fs.readFileSync(files.trace), beforeStatus.trace);

    const humanBlocked = run([
      "workflow", "instance", "status",
      "--root", project,
      "--id", instanceId,
      "--locale", "en",
    ], project);
    assert.equal(humanBlocked.status, 1, humanBlocked.stderr);
    const humanPrimary = humanBlocked.stdout.split("Technical details (optional):")[0];
    assert.match(humanPrimary, /same transition toward the same destination/u);
    assert.match(humanPrimary, /should not restore files manually/u);

    const recovered = transition(project, instanceId, requestId, ["--json"]);
    assert.equal(recovered.status, 0, `${phase}\n${recovered.stdout}\n${recovered.stderr}`);
    const recoveredPayload = JSON.parse(recovered.stdout);
    assert.equal(recoveredPayload.status, "unchanged");
    assert.equal(recoveredPayload.idempotent, true);
    assert.equal(recoveredPayload.current_state, "impact-review");
    assert.equal(fs.existsSync(files.pending), false);
    assert.equal(fs.readFileSync(files.events, "utf8").trim().split(/\r?\n/u).length, 1);
    const checkpoint = JSON.parse(fs.readFileSync(files.checkpoint, "utf8"));
    assert.equal(checkpoint.sequence, 1);
    assert.equal(checkpoint.current_state, "impact-review");
    const transitionTraces = projectTraceEvents(project).filter((event) =>
      event.action === "workflow.instance.transition" && event.related?.includes(instanceId));
    assert.equal(transitionTraces.length, 1, phase);

    const eventBytes = fs.readFileSync(files.events);
    const checkpointBytes = fs.readFileSync(files.checkpoint);
    const traceBytes = fs.readFileSync(files.trace);
    const secondRetry = transition(project, instanceId, requestId, ["--json"]);
    assert.equal(secondRetry.status, 0, secondRetry.stderr);
    assert.equal(JSON.parse(secondRetry.stdout).idempotent, true);
    assert.deepEqual(fs.readFileSync(files.events), eventBytes);
    assert.deepEqual(fs.readFileSync(files.checkpoint), checkpointBytes);
    assert.deepEqual(fs.readFileSync(files.trace), traceBytes);
  }
});

test("recovery repairs only the exact partial event or trace line owned by its journal", () => {
  for (const target of ["event", "trace"]) {
    const project = temporaryProject(`partial-${target}`);
    const instanceId = `change-partial-${target}`;
    startChangeRequest(project, instanceId);
    const files = instanceFiles(project, instanceId);
    const requestId = `partial-${target}`;
    const phase = target === "event"
      ? "after-event-before-checkpoint"
      : "after-checkpoint-before-trace";
    const interrupted = run([
      "workflow", "instance", "transition",
      "--root", project,
      "--id", instanceId,
      "--to", "impact-review",
      "--request-id", requestId,
      "--json",
    ], project, {
      NODE_ENV: "test",
      AGENTIC_SDLC_TEST_WORKFLOW_FAILURE_PHASE: phase,
    });
    assert.equal(interrupted.status, 1, interrupted.stderr);
    const journal = JSON.parse(fs.readFileSync(files.pending, "utf8"));
    if (target === "event") {
      replaceOwnedJsonLineWithPartial(files.events, journal.event_anchor, journal.event);
    } else {
      replaceOwnedJsonLineWithPartial(files.trace, journal.trace_anchor, journal.trace_event);
    }

    const recovered = transition(project, instanceId, requestId, ["--json"]);
    assert.equal(recovered.status, 0, `${target}\n${recovered.stdout}\n${recovered.stderr}`);
    assert.equal(JSON.parse(recovered.stdout).idempotent, true);
    assert.equal(fs.existsSync(files.pending), false);
    assert.equal(fs.readFileSync(files.events, "utf8").trim().split(/\r?\n/u).length, 1);
    assert.equal(JSON.parse(fs.readFileSync(files.checkpoint, "utf8")).sequence, 1);
    assert.equal(projectTraceEvents(project).filter((event) =>
      event.action === "workflow.instance.transition" && event.related?.includes(instanceId)).length, 1);
  }
});

test("an unrelated trace writer cannot append behind a pending partial trace", () => {
  const project = temporaryProject("partial-trace-interleaving");
  const instanceId = "change-partial-trace-interleaving";
  startChangeRequest(project, instanceId);
  const files = instanceFiles(project, instanceId);
  const requestId = "partial-trace-interleaving";
  const interrupted = run([
    "workflow", "instance", "transition",
    "--root", project,
    "--id", instanceId,
    "--to", "impact-review",
    "--request-id", requestId,
    "--json",
  ], project, {
    NODE_ENV: "test",
    AGENTIC_SDLC_TEST_WORKFLOW_FAILURE_PHASE: "after-checkpoint-before-trace",
  });
  assert.equal(interrupted.status, 1, interrupted.stderr);
  const journal = JSON.parse(fs.readFileSync(files.pending, "utf8"));
  replaceOwnedJsonLineWithPartial(files.trace, journal.trace_anchor, journal.trace_event);
  const partialBytes = fs.readFileSync(files.trace);

  const unrelated = run([
    "trace", "append",
    "--root", project,
    "--type", "decision",
    "--summary", "An unrelated audit event",
    "--actor-type", "agent",
    "--json",
  ], project);
  assert.equal(unrelated.status, 1, `${unrelated.stdout}\n${unrelated.stderr}`);
  assert.deepEqual(fs.readFileSync(files.trace), partialBytes);

  const recovered = transition(project, instanceId, requestId, ["--json"]);
  assert.equal(recovered.status, 0, `${recovered.stdout}\n${recovered.stderr}`);
  assert.equal(JSON.parse(recovered.stdout).idempotent, true);
  assert.equal(fs.existsSync(files.pending), false);
  assert.equal(projectTraceEvents(project).filter((event) =>
    event.action === "workflow.instance.transition" && event.related?.[0] === instanceId).length, 1);
});

test("transition commit revalidates prior trace coverage after a concurrent writer", () => {
  const project = temporaryProject("trace-commit-race");
  const instanceId = "change-trace-commit-race";
  startChangeRequest(project, instanceId);
  const files = instanceFiles(project, instanceId);
  const eventBytes = fs.readFileSync(files.events);
  const checkpointBytes = fs.readFileSync(files.checkpoint);

  const raced = run([
    "workflow", "instance", "transition",
    "--root", project,
    "--id", instanceId,
    "--to", "impact-review",
    "--request-id", "trace-commit-race",
    "--json",
  ], project, {
    NODE_ENV: "test",
    AGENTIC_SDLC_TEST_WORKFLOW_TRACE_INTERLEAVING: "conflicting-transition-trace",
  });
  assert.equal(raced.status, 1, `${raced.stdout}\n${raced.stderr}`);
  assert.deepEqual(fs.readFileSync(files.events), eventBytes);
  assert.deepEqual(fs.readFileSync(files.checkpoint), checkpointBytes);
  assert.equal(fs.existsSync(files.pending), false);
  assert.equal(projectTraceEvents(project).filter((entry) =>
    entry.action === "workflow.instance.transition" && entry.related?.[0] === instanceId).length, 1);

  const status = run([
    "workflow", "instance", "status", "--root", project, "--id", instanceId, "--json",
  ], project);
  assert.equal(status.status, 1, `${status.stdout}\n${status.stderr}`);
  assert.equal(JSON.parse(status.stdout).status, "blocked");
});

test("recovery preserves a divergent partial suffix and fails closed", () => {
  const project = temporaryProject("partial-divergent");
  const instanceId = "change-partial-divergent";
  startChangeRequest(project, instanceId);
  const files = instanceFiles(project, instanceId);
  const requestId = "partial-divergent";
  const interrupted = run([
    "workflow", "instance", "transition",
    "--root", project,
    "--id", instanceId,
    "--to", "impact-review",
    "--request-id", requestId,
    "--json",
  ], project, {
    NODE_ENV: "test",
    AGENTIC_SDLC_TEST_WORKFLOW_FAILURE_PHASE: "after-event-before-checkpoint",
  });
  assert.equal(interrupted.status, 1, interrupted.stderr);
  const journal = JSON.parse(fs.readFileSync(files.pending, "utf8"));
  const prefix = fs.readFileSync(files.events).subarray(0, journal.event_anchor.size_bytes);
  fs.writeFileSync(files.events, Buffer.concat([prefix, Buffer.from("{\"not_the_owned_event\":", "utf8")]));
  const divergentBytes = fs.readFileSync(files.events);
  const pendingBytes = fs.readFileSync(files.pending);

  const retry = transition(project, instanceId, requestId, ["--json"]);
  assert.equal(retry.status, 1, `${retry.stdout}\n${retry.stderr}`);
  assert.deepEqual(fs.readFileSync(files.events), divergentBytes);
  assert.deepEqual(fs.readFileSync(files.pending), pendingBytes);
  assert.equal(JSON.parse(fs.readFileSync(files.checkpoint, "utf8")).sequence, 0);
  assert.equal(projectTraceEvents(project).filter((event) =>
    event.action === "workflow.instance.transition" && event.related?.includes(instanceId)).length, 0);
});

test("a retry is a visible no-op and writes neither event nor trace", () => {
  const project = temporaryProject("retry");
  const instanceId = "change-retry-safe";
  const started = startChangeRequest(project, instanceId);
  const files = instanceFiles(project, instanceId);

  assert.equal(fs.existsSync(files.checkpoint), true);
  assert.equal(started.checkpoint.sequence, 0);
  assert.equal(started.checkpoint.current_state, "intake");

  const first = transition(project, instanceId, "impact-review-once", ["--json"]);
  assert.equal(first.status, 0, first.stderr);
  const firstPayload = JSON.parse(first.stdout);
  assert.equal(firstPayload.status, "transitioned");
  assert.equal(firstPayload.idempotent, false);
  assert.equal(firstPayload.current_state, "impact-review");
  const eventBytes = fs.readFileSync(files.events);
  const traceBytes = fs.readFileSync(files.trace);
  const checkpointBytes = fs.readFileSync(files.checkpoint);

  const retryJson = transition(project, instanceId, "impact-review-once", ["--json"]);
  assert.equal(retryJson.status, 0, retryJson.stderr);
  const retryPayload = JSON.parse(retryJson.stdout);
  assert.equal(retryPayload.status, "unchanged");
  assert.equal(retryPayload.idempotent, true);
  assert.equal(retryPayload.current_state, "impact-review");
  assert.equal(retryPayload.replay.current_state, "impact-review");
  assert.deepEqual(fs.readFileSync(files.events), eventBytes);
  assert.deepEqual(fs.readFileSync(files.trace), traceBytes);
  assert.deepEqual(fs.readFileSync(files.checkpoint), checkpointBytes);

  const english = transition(project, instanceId, "impact-review-once", ["--locale", "en"]);
  assert.equal(english.status, 0, english.stderr);
  assert.match(english.stdout.split("Technical details (optional):")[0], /already been applied; no change was made/u);

  const italian = transition(project, instanceId, "impact-review-once", ["--locale", "it"]);
  assert.equal(italian.status, 0, italian.stderr);
  assert.match(italian.stdout.split("Dettagli tecnici (facoltativi):")[0], /già stata applicata; non è stato apportato alcun cambiamento/u);
  assert.deepEqual(fs.readFileSync(files.events), eventBytes);
  assert.deepEqual(fs.readFileSync(files.trace), traceBytes);
});

test("status, explain, and transition fail closed after the last event is deleted", () => {
  const project = temporaryProject("truncated");
  const instanceId = "change-truncated";
  startChangeRequest(project, instanceId);
  const first = transition(project, instanceId, "impact-review-recorded", ["--json"]);
  assert.equal(first.status, 0, first.stderr);
  const files = instanceFiles(project, instanceId);
  const traceBytes = fs.readFileSync(files.trace);
  fs.writeFileSync(files.events, "");

  for (const command of ["status", "explain"]) {
    const result = run([
      "workflow", "instance", command,
      "--root", project,
      "--id", instanceId,
      "--json",
    ], project);
    assert.equal(result.status, 1, `${command}\n${result.stdout}\n${result.stderr}`);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "blocked");
    assert.equal(payload.integrity, "invalid");
    assert.equal(payload.error_code, "WORKFLOW_HISTORY_INTEGRITY_FAILED");
    assert.equal(Object.hasOwn(payload, "current_state"), false);
    assert.equal(Object.hasOwn(payload, "next_states"), false);
  }

  const blockedTransition = transition(project, instanceId, "must-not-run", ["--json"]);
  assert.equal(blockedTransition.status, 1, blockedTransition.stderr);
  const blockedPayload = JSON.parse(blockedTransition.stdout);
  assert.equal(blockedPayload.status, "blocked");
  assert.equal(Object.hasOwn(blockedPayload, "current_state"), false);
  assert.equal(fs.readFileSync(files.events, "utf8"), "");
  assert.deepEqual(fs.readFileSync(files.trace), traceBytes);

  const human = run([
    "workflow", "instance", "status",
    "--root", project,
    "--id", instanceId,
    "--locale", "en",
  ], project);
  assert.equal(human.status, 1, human.stderr);
  const primary = human.stdout.split("Technical details (optional):")[0];
  assert.match(primary, /recorded history cannot be trusted/u);
  assert.match(primary, /no next step is offered/u);

  const humanItalian = run([
    "workflow", "instance", "status",
    "--root", project,
    "--id", instanceId,
    "--locale", "it",
  ], project);
  assert.equal(humanItalian.status, 1, humanItalian.stderr);
  const primaryItalian = humanItalian.stdout.split("Dettagli tecnici (facoltativi):")[0];
  assert.match(primaryItalian, /cronologia registrata non è affidabile/u);
  assert.match(primaryItalian, /non viene proposto alcun passaggio successivo/u);
});

test("a coordinated event and checkpoint rollback is blocked while its audit trace remains", () => {
  const project = temporaryProject("coordinated-rollback");
  const instanceId = "change-coordinated-rollback";
  startChangeRequest(project, instanceId);
  const files = instanceFiles(project, instanceId);
  const baseEvents = fs.readFileSync(files.events);
  const baseCheckpoint = fs.readFileSync(files.checkpoint);
  assert.equal(transition(project, instanceId, "rollback-detection", ["--json"]).status, 0);
  const traceBytes = fs.readFileSync(files.trace);

  fs.writeFileSync(files.events, baseEvents);
  fs.writeFileSync(files.checkpoint, baseCheckpoint);
  const status = run([
    "workflow", "instance", "status",
    "--root", project,
    "--id", instanceId,
    "--json",
  ], project);
  assert.equal(status.status, 1, `${status.stdout}\n${status.stderr}`);
  const payload = JSON.parse(status.stdout);
  assert.equal(payload.status, "blocked");
  assert.equal(payload.integrity, "invalid");
  assert.equal(Object.hasOwn(payload, "current_state"), false);

  const blocked = transition(project, instanceId, "must-not-follow-rollback", ["--json"]);
  assert.equal(blocked.status, 1, `${blocked.stdout}\n${blocked.stderr}`);
  assert.deepEqual(fs.readFileSync(files.events), baseEvents);
  assert.deepEqual(fs.readFileSync(files.checkpoint), baseCheckpoint);
  assert.deepEqual(fs.readFileSync(files.trace), traceBytes);
});

test("changing audit attribution alone is detected by the checkpointed trace chain", () => {
  const project = temporaryProject("trace-attribution-tamper");
  const instanceId = "change-trace-attribution-tamper";
  startChangeRequest(project, instanceId);
  assert.equal(transition(project, instanceId, "trace-attribution", ["--json"]).status, 0);
  const files = instanceFiles(project, instanceId);
  const eventBytes = fs.readFileSync(files.events);
  const checkpointBytes = fs.readFileSync(files.checkpoint);
  const traces = projectTraceEvents(project);
  const owned = traces.find((entry) =>
    entry.action === "workflow.instance.transition" && entry.related?.[0] === instanceId);
  assert.ok(owned);
  owned.actor = { ...owned.actor, name: "Altered audit actor" };
  fs.writeFileSync(files.trace, `${traces.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  const traceBytes = fs.readFileSync(files.trace);

  const status = run([
    "workflow", "instance", "status", "--root", project, "--id", instanceId, "--json",
  ], project);
  assert.equal(status.status, 1, `${status.stdout}\n${status.stderr}`);
  assert.equal(JSON.parse(status.stdout).status, "blocked");
  assert.deepEqual(fs.readFileSync(files.events), eventBytes);
  assert.deepEqual(fs.readFileSync(files.checkpoint), checkpointBytes);
  assert.deepEqual(fs.readFileSync(files.trace), traceBytes);
});

test("a missing or corrupted durable checkpoint blocks every runtime view and transition", () => {
  for (const corruption of ["missing", "corrupt"]) {
    const project = temporaryProject(corruption);
    const instanceId = `change-checkpoint-${corruption}`;
    startChangeRequest(project, instanceId);
    const files = instanceFiles(project, instanceId);
    if (corruption === "missing") {
      fs.rmSync(files.checkpoint);
    } else {
      const checkpoint = JSON.parse(fs.readFileSync(files.checkpoint, "utf8"));
      checkpoint.current_state = "closed";
      fs.writeFileSync(files.checkpoint, `${JSON.stringify(checkpoint, null, 2)}\n`);
    }
    const eventBytes = fs.readFileSync(files.events);
    const traceBytes = fs.readFileSync(files.trace);

    for (const command of ["status", "explain"]) {
      const result = run([
        "workflow", "instance", command,
        "--root", project,
        "--id", instanceId,
        "--json",
      ], project);
      assert.equal(result.status, 1, `${corruption} ${command}\n${result.stdout}\n${result.stderr}`);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.status, "blocked");
      assert.equal(Object.hasOwn(payload, "current_state"), false);
      assert.equal(Object.hasOwn(payload, "next_states"), false);
    }

    const blockedTransition = transition(project, instanceId, `blocked-${corruption}`, ["--json"]);
    assert.equal(blockedTransition.status, 1, blockedTransition.stderr);
    const payload = JSON.parse(blockedTransition.stdout);
    assert.equal(payload.status, "blocked");
    assert.equal(payload.idempotent, undefined);
    assert.deepEqual(fs.readFileSync(files.events), eventBytes);
    assert.deepEqual(fs.readFileSync(files.trace), traceBytes);
  }
});

test("an invalid middle event cannot produce a trusted status or further transition", () => {
  const project = temporaryProject("middle-event");
  const instanceId = "change-invalid-middle";
  startChangeRequest(project, instanceId);
  assert.equal(transition(project, instanceId, "impact-review-valid", ["--json"]).status, 0);
  mustRunJson([
    "workflow", "instance", "transition",
    "--root", project,
    "--id", instanceId,
    "--to", "approval",
    "--request-id", "approval-valid",
  ], project);
  const files = instanceFiles(project, instanceId);
  const events = fs.readFileSync(files.events, "utf8").trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  assert.equal(events.length, 2);
  events[0].context_hash = "0".repeat(64);
  fs.writeFileSync(files.events, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  const eventBytes = fs.readFileSync(files.events);
  const traceBytes = fs.readFileSync(files.trace);

  for (const command of ["status", "explain"]) {
    const result = run([
      "workflow", "instance", command,
      "--root", project,
      "--id", instanceId,
      "--json",
    ], project);
    assert.equal(result.status, 1, `${command}\n${result.stdout}\n${result.stderr}`);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "blocked");
    assert.equal(Object.hasOwn(payload, "current_state"), false);
    assert.equal(Object.hasOwn(payload, "next_states"), false);
  }

  const blocked = run([
    "workflow", "instance", "transition",
    "--root", project,
    "--id", instanceId,
    "--to", "implementation",
    "--request-id", "must-not-follow-corruption",
    "--json",
  ], project);
  assert.equal(blocked.status, 1, blocked.stderr);
  assert.equal(JSON.parse(blocked.stdout).status, "blocked");
  assert.deepEqual(fs.readFileSync(files.events), eventBytes);
  assert.deepEqual(fs.readFileSync(files.trace), traceBytes);
});

const TRACE_CHECKPOINT = path.join(".sdlc", "traces", ".integrity", "project.jsonl.checkpoint.json");

/** The records of a run survive but the shared project history is the one from before its transition: its traces are gone. */
function startAndLoseTransitionTrace(label) {
  const project = temporaryProject(label);
  const instanceId = `change-${label}`;
  startChangeRequest(project, instanceId);
  const files = instanceFiles(project, instanceId);
  const savedTrace = fs.readFileSync(files.trace);
  const savedCheckpoint = fs.readFileSync(path.join(project, TRACE_CHECKPOINT));
  assert.equal(transition(project, instanceId, `${label}-1`, ["--json"]).status, 0);
  fs.writeFileSync(files.trace, savedTrace);
  fs.writeFileSync(path.join(project, TRACE_CHECKPOINT), savedCheckpoint);
  return { project, instanceId, files, savedTrace };
}

const statusOf = (project, instanceId) => run(["workflow", "instance", "status", "--root", project, "--id", instanceId, "--json"], project);

test("repair-traces rebuilds the traces a run lost from its verified events, binds them, and records the repair", () => {
  const { project, instanceId, files, savedTrace } = startAndLoseTransitionTrace("repair-lost");
  assert.equal(statusOf(project, instanceId).status, 1, "the lost trace blocks the run");
  const eventHash = JSON.parse(fs.readFileSync(files.events, "utf8").trim().split("\n")[0]).event_hash;
  const checkpointBefore = fs.readFileSync(files.checkpoint);

  const planned = mustRunJson(["workflow", "instance", "repair-traces", "--root", project, "--id", instanceId, "--dry-run"], project);
  assert.equal(planned.status, "planned");
  assert.deepEqual(planned.events_without_trace, [eventHash]);
  assert.deepEqual(fs.readFileSync(files.trace), savedTrace, "a dry run changes nothing");
  assert.deepEqual(fs.readFileSync(files.checkpoint), checkpointBefore);

  const repaired = mustRunJson(["workflow", "instance", "repair-traces", "--root", project, "--id", instanceId], project);
  assert.equal(repaired.status, "repaired");
  assert.deepEqual(repaired.traces, [`TR-WF-${eventHash}`]);
  assert.notEqual(repaired.trace_chain_hash, repaired.previous_trace_chain_hash);
  const ok = statusOf(project, instanceId);
  assert.equal(ok.status, 0, `${ok.stdout}\n${ok.stderr}`);
  assert.equal(run(["trace", "verify", "--root", project, "--json"], project).status, 0);

  const traces = projectTraceEvents(project);
  const rebuilt = traces.find((entry) => entry.id === `TR-WF-${eventHash}`);
  assert.equal(rebuilt.action, "workflow.instance.transition");
  assert.equal(rebuilt.run.regenerated, true);
  assert.deepEqual(rebuilt.related, [instanceId, eventHash]);
  const repair = traces.find((entry) => entry.action === "workflow.instance.repair-traces");
  assert.equal(repair.id, repaired.repair_trace);
  assert.deepEqual(repair.repair.events, [eventHash]);
  assert.equal(repair.repair.previous_trace_chain_hash, repaired.previous_trace_chain_hash);
  assert.ok(repair.actor);

  const again = mustRunJson(["workflow", "instance", "repair-traces", "--root", project, "--id", instanceId], project);
  assert.equal(again.status, "nothing_to_repair");
  assert.equal(projectTraceEvents(project).filter((entry) => entry.action === "workflow.instance.repair-traces").length, 1);
});

test("repair-traces rebuilds the same traces from the same events", () => {
  const first = startAndLoseTransitionTrace("repair-determinism-a");
  const eventLine = fs.readFileSync(first.files.events, "utf8").trim().split("\n")[0];
  const hash = JSON.parse(eventLine).event_hash;
  mustRunJson(["workflow", "instance", "repair-traces", "--root", first.project, "--id", first.instanceId], first.project);
  const { _trace_integrity: _a, ...one } = projectTraceEvents(first.project).find((entry) => entry.id === `TR-WF-${hash}`);
  assert.equal(one.created_at, JSON.parse(eventLine).timestamp);
  assert.deepEqual(one.actor, JSON.parse(eventLine).actor);
  assert.equal(one.git.branch, null);
});

test("repair-traces refuses when the events no longer verify and writes nothing", () => {
  const { project, instanceId, files, savedTrace } = startAndLoseTransitionTrace("repair-tampered-events");
  const tampered = fs.readFileSync(files.events, "utf8").replace("\"to\":\"impact-review\"", "\"to\":\"closed\"");
  assert.notEqual(tampered, fs.readFileSync(files.events, "utf8"));
  fs.writeFileSync(files.events, tampered);
  const checkpointBefore = fs.readFileSync(files.checkpoint);
  const refused = run(["workflow", "instance", "repair-traces", "--root", project, "--id", instanceId, "--json"], project);
  assert.notEqual(refused.status, 0, refused.stdout);
  assert.match(`${refused.stdout}${refused.stderr}`, /traces were not repaired/u);
  assert.deepEqual(fs.readFileSync(files.trace), savedTrace);
  assert.deepEqual(fs.readFileSync(files.checkpoint), checkpointBefore);
});

test("repair-traces refuses a trace whose content was altered: only missing traces are rebuilt", () => {
  const project = temporaryProject("repair-altered-trace");
  const instanceId = "change-repair-altered-trace";
  startChangeRequest(project, instanceId);
  assert.equal(transition(project, instanceId, "altered-1", ["--json"]).status, 0);
  const files = instanceFiles(project, instanceId);
  const traces = projectTraceEvents(project);
  const owned = traces.find((entry) => entry.action === "workflow.instance.transition");
  owned.actor = { ...owned.actor, name: "Altered audit actor" };
  fs.writeFileSync(files.trace, `${traces.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  const traceBytes = fs.readFileSync(files.trace);
  const refused = run(["workflow", "instance", "repair-traces", "--root", project, "--id", instanceId, "--json"], project);
  assert.notEqual(refused.status, 0, refused.stdout);
  assert.deepEqual(fs.readFileSync(files.trace), traceBytes);
});

test("repair-traces on a healthy run changes nothing", () => {
  const project = temporaryProject("repair-healthy");
  const instanceId = "change-repair-healthy";
  startChangeRequest(project, instanceId);
  assert.equal(transition(project, instanceId, "healthy-1", ["--json"]).status, 0);
  const files = instanceFiles(project, instanceId);
  const before = fs.readFileSync(files.trace);
  const result = mustRunJson(["workflow", "instance", "repair-traces", "--root", project, "--id", instanceId], project);
  assert.equal(result.status, "nothing_to_repair");
  assert.deepEqual(fs.readFileSync(files.trace), before);
});
