import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { validateAgainstSchema } from "../../lib/json-schema-validator.mjs";
import {
  calculateCodexSessionMeteringDelta,
  collectCodexSessionMeteringSnapshot,
  mapCodexSessionUsage,
  normalizeCodexSessionQuery,
  validateCodexSessionMeteringDelta,
  validateCodexSessionMeteringSnapshot,
} from "../../lib/codex-session-metering-adapter.mjs";

const THREAD_ID = "019fa7f0-d150-7fb1-aad8-d10a2243521a";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-sdlc-codex-meter-"));
  const codexHome = path.join(root, ".codex");
  const projectRoot = path.join(root, "project");
  const sessionRoot = path.join(codexHome, "sessions", "2026", "07", "28");
  const sessionFile = path.join(sessionRoot, `rollout-2026-07-28-${THREAD_ID}.jsonl`);
  fs.mkdirSync(sessionRoot, { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });
  return { root, codexHome, projectRoot, sessionFile };
}

function removeFixture(root) {
  fs.rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  });
}

function sessionMeta(projectRoot, threadId = THREAD_ID) {
  return {
    timestamp: "2026-07-28T08:00:00.000Z",
    type: "session_meta",
    payload: {
      id: threadId,
      cwd: projectRoot,
      source: "codex_desktop",
    },
  };
}

function tokenCount({
  timestamp,
  input,
  output,
  cacheRead = 0,
  cacheWrite = 0,
  reasoning = 0,
  rateLimits = null,
}) {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: input,
          cached_input_tokens: cacheRead,
          cache_write_input_tokens: cacheWrite,
          output_tokens: output,
          reasoning_output_tokens: reasoning,
          total_tokens: input + output,
        },
      },
      rate_limits: rateLimits,
    },
  };
}

function writeJsonl(file, entries, newline = "\n") {
  fs.writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join(newline)}${newline}`);
}

test("exact local Codex thread counters become advisory snapshots without prompt content", async (t) => {
  const current = fixture();
  t.after(() => removeFixture(current.root));
  writeJsonl(current.sessionFile, [
    sessionMeta(current.projectRoot),
    { timestamp: "2026-07-28T08:00:01.000Z", type: "response_item", payload: { prompt: "secret" } },
    tokenCount({
      timestamp: "2026-07-28T08:01:00.000Z",
      input: 100,
      output: 20,
      cacheRead: 60,
      cacheWrite: 10,
      reasoning: 4,
      rateLimits: {
        limit_id: "codex",
        primary: { used_percent: 12.5, window_minutes: 300, resets_at: 1785229200 },
        secondary: null,
        credits: { has_credits: true, unlimited: false, balance: 42 },
        spend_control_reached: false,
        rate_limit_reached_type: null,
      },
    }),
  ]);

  const snapshot = await collectCodexSessionMeteringSnapshot(
    { id: "METER-START", query: { thread_id: THREAD_ID } },
    { codex_home: current.codexHome, project_root: current.projectRoot },
  );

  assert.deepEqual(snapshot.cumulative.tokens, {
    total: 120,
    input: 30,
    output: 20,
    cache_read: 60,
    cache_write: 10,
    reasoning_output: 4,
  });
  assert.equal(snapshot.cumulative.calls, 1);
  assert.equal(snapshot.cumulative.sessions, 1);
  assert.equal(snapshot.source.session_id, THREAD_ID);
  assert.equal(snapshot.source.shell, false);
  assert.equal(snapshot.source.authentication_required, false);
  assert.equal(snapshot.source.rate_limits.primary.used_percent, 12.5);
  assert.equal(JSON.stringify(snapshot).includes("secret"), false);
  assert.equal(validateCodexSessionMeteringSnapshot(snapshot).valid, true);
  assert.equal(
    validateAgainstSchema(snapshot, "metering-snapshot.schema.json").valid,
    true,
  );
});

test("Codex session deltas are monotonic, cache-safe, and map to approved budget metrics", async (t) => {
  const current = fixture();
  t.after(() => removeFixture(current.root));
  const first = tokenCount({
    timestamp: "2026-07-28T08:01:00.000Z",
    input: 100,
    output: 20,
    cacheRead: 60,
    cacheWrite: 10,
    reasoning: 4,
  });
  writeJsonl(current.sessionFile, [sessionMeta(current.projectRoot), first]);
  const baseline = await collectCodexSessionMeteringSnapshot(
    { id: "BASELINE", query: { thread_id: THREAD_ID } },
    { codex_home: current.codexHome, project_root: current.projectRoot },
  );

  writeJsonl(current.sessionFile, [
    sessionMeta(current.projectRoot),
    first,
    tokenCount({
      timestamp: "2026-07-28T08:02:00.000Z",
      input: 180,
      output: 40,
      cacheRead: 100,
      cacheWrite: 20,
      reasoning: 8,
    }),
  ], "\r\n");
  const latest = await collectCodexSessionMeteringSnapshot(
    { id: "LATEST", query: { thread_id: THREAD_ID } },
    { codex_home: current.codexHome, project_root: current.projectRoot },
  );
  const delta = calculateCodexSessionMeteringDelta(baseline, latest, { id: "DELTA" });

  assert.deepEqual(delta.usage.tokens, {
    total: 100,
    input: 30,
    output: 20,
    cache_read: 40,
    cache_write: 10,
    reasoning_output: 4,
  });
  assert.equal(delta.usage.calls, 1);
  assert.equal(validateCodexSessionMeteringDelta(delta).valid, true);
  assert.equal(
    validateAgainstSchema(delta, "metering-delta.schema.json").valid,
    true,
  );
  assert.deepEqual(
    mapCodexSessionUsage(delta, { limits: {} }, {
      tokens: "tokens.total",
      input_tokens: "tokens.input",
      output_tokens: "tokens.output",
      cache_read_tokens: "tokens.cache_read",
      model_calls: "calls",
    }),
    {
      tokens: 100,
      input_tokens: 30,
      output_tokens: 20,
      cache_read_tokens: 40,
      model_calls: 1,
    },
  );

  const tampered = structuredClone(latest);
  tampered.cumulative.tokens.total += 1;
  assert.equal(validateCodexSessionMeteringSnapshot(tampered).valid, false);
});

test("Codex session selection rejects project drift, linked files, and counter resets", async (t) => {
  const current = fixture();
  t.after(() => removeFixture(current.root));
  const first = tokenCount({
    timestamp: "2026-07-28T08:01:00.000Z",
    input: 100,
    output: 20,
  });
  writeJsonl(current.sessionFile, [
    sessionMeta(current.projectRoot),
    first,
    tokenCount({
      timestamp: "2026-07-28T08:02:00.000Z",
      input: 90,
      output: 20,
    }),
  ]);

  await assert.rejects(
    collectCodexSessionMeteringSnapshot(
      { id: "RESET", query: { thread_id: THREAD_ID } },
      { codex_home: current.codexHome, project_root: current.projectRoot },
    ),
    /counter regressed/u,
  );

  writeJsonl(current.sessionFile, [sessionMeta(current.projectRoot), first]);
  await assert.rejects(
    collectCodexSessionMeteringSnapshot(
      { id: "WRONG-PROJECT", query: { thread_id: THREAD_ID } },
      { codex_home: current.codexHome, project_root: path.join(current.root, "other") },
    ),
    /cwd does not match/u,
  );

  if (process.platform !== "win32") {
    const linked = path.join(path.dirname(current.sessionFile), "linked.jsonl");
    fs.symlinkSync(current.sessionFile, linked);
    await assert.rejects(
      collectCodexSessionMeteringSnapshot(
        { id: "LINKED", query: { thread_id: THREAD_ID } },
        {
          codex_home: current.codexHome,
          project_root: current.projectRoot,
          session_file: linked,
        },
      ),
      /Refusing linked/u,
    );
  }
});

test("an invalid token_count event fails closed instead of being skipped", async (t) => {
  const current = fixture();
  t.after(() => removeFixture(current.root));
  const valid = tokenCount({ timestamp: "2026-07-28T08:01:00.000Z", input: 100, output: 20 });
  const rateLimitOnly = {
    timestamp: "2026-07-28T08:00:30.000Z",
    type: "event_msg",
    payload: { type: "token_count", info: null, rate_limits: null },
  };
  writeJsonl(current.sessionFile, [sessionMeta(current.projectRoot), rateLimitOnly, valid]);
  const snapshot = await collectCodexSessionMeteringSnapshot(
    { id: "RATE-LIMIT-ONLY", query: { thread_id: THREAD_ID } },
    { codex_home: current.codexHome, project_root: current.projectRoot },
  );
  assert.equal(snapshot.cumulative.tokens.total, 120);

  const negative = tokenCount({ timestamp: "2026-07-28T08:02:00.000Z", input: 100, output: 20 });
  negative.payload.info.total_token_usage.output_tokens = -1;
  const fractional = tokenCount({ timestamp: "2026-07-28T08:02:00.000Z", input: 100, output: 20 });
  fractional.payload.info.total_token_usage.input_tokens = 100.5;
  const badTimestamp = tokenCount({ timestamp: "yesterday", input: 150, output: 20 });
  for (const [label, invalid] of [["negative", negative], ["fractional", fractional], ["timestamp", badTimestamp]]) {
    writeJsonl(current.sessionFile, [sessionMeta(current.projectRoot), valid, invalid]);
    await assert.rejects(
      collectCodexSessionMeteringSnapshot(
        { id: `INVALID-${label.toUpperCase()}`, query: { thread_id: THREAD_ID } },
        { codex_home: current.codexHome, project_root: current.projectRoot },
      ),
      (error) => error.code === "malformed_codex_session_event" && /invalid token_count event/u.test(error.message),
      label,
    );
  }
});

test("Codex session query accepts only an exact option-safe thread identifier", () => {
  assert.deepEqual(normalizeCodexSessionQuery({ thread_id: THREAD_ID }), {
    thread_id: THREAD_ID,
  });
  assert.throws(
    () => normalizeCodexSessionQuery({ thread_id: THREAD_ID, provider: "codex" }),
    /unsupported field/u,
  );
  assert.throws(
    () => normalizeCodexSessionQuery({ thread_id: "--all" }),
    /option-safe/u,
  );
});
