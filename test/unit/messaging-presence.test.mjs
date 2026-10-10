import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { alertFor } from "../../lib/messaging/auto.mjs";
import { heartbeatMinutes, localActiveClaims, selectPresence } from "../../lib/messaging/presence.mjs";

const NOW = Date.parse("2026-10-10T12:00:00Z");

test("status while claims are active, at most once per heartbeat", () => {
  const claims = [{ story: "ST-A-001", phase: "implement", phaseSince: NOW - 20 * 60_000 }];
  const status = selectPresence({ claims, now: NOW });
  assert.equal(status.kind, "info");
  assert.equal(status.text, "[auto] stato: ST-A-001 in fase implement da 20 min");
  assert.equal(selectPresence({ claims, presence: { last_status: NOW - 5 * 60_000 }, now: NOW }), null);
  assert.ok(selectPresence({ claims, presence: { last_status: NOW - 16 * 60_000 }, now: NOW }));
  assert.equal(selectPresence({ claims, now: NOW, heartbeatMs: 0 }), null);
});

test("offer when free, at most once an hour", () => {
  const offer = selectPresence({ claims: [], now: NOW });
  assert.equal(offer.kind, "offer");
  assert.match(offer.text, /libero: posso prendere lavoro o aiutare/u);
  assert.equal(selectPresence({ claims: [], presence: { last_offer: NOW - 30 * 60_000 }, now: NOW }), null);
  assert.ok(selectPresence({ claims: [], presence: { last_offer: NOW - 61 * 60_000 }, now: NOW }));
  assert.equal(heartbeatMinutes({}), 15);
  assert.equal(heartbeatMinutes({ AGENTIC_SDLC_MESSAGING_HEARTBEAT_MINUTES: "0" }), 0);
});

test("local claims: active, unexpired, on a branch of this clone, with the workflow phase", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-presence-"));
  const claim = (id, extra) => {
    fs.mkdirSync(path.join(root, ".sdlc", "stories", id), { recursive: true });
    fs.writeFileSync(path.join(root, ".sdlc", "stories", id, "claim.json"), JSON.stringify({
      story_id: id, status: "active", branch: `b/${id}`, claimed_at: new Date(NOW - 60 * 60_000).toISOString(),
      expires_at: new Date(NOW + 60_000).toISOString(), ...extra,
    }));
  };
  claim("ST-A-001");
  claim("ST-B-001", { status: "released" });
  claim("ST-C-001", { expires_at: new Date(NOW - 1).toISOString() });
  claim("ST-D-001");
  const instance = path.join(root, ".sdlc", "workflows", "instances", "DELIVERY-ST-A-001");
  fs.mkdirSync(instance, { recursive: true });
  fs.writeFileSync(path.join(instance, "instance.json"), JSON.stringify({ metadata: { governance_binding: { story_id: "ST-A-001" } } }));
  fs.writeFileSync(path.join(instance, "checkpoint.json"), JSON.stringify({ current_state: "verify", updated_at: new Date(NOW - 10 * 60_000).toISOString() }));
  const claims = localActiveClaims(root, { now: NOW, branchExists: (branch) => branch !== "b/ST-D-001" });
  assert.deepEqual(claims.map((item) => [item.story, item.phase]), [["ST-A-001", "verify"]]);
  assert.match(selectPresence({ claims, now: NOW }).text, /ST-A-001 in fase verify da 10 min/u);
});

test("[auto] notices for phase, delivery steps, tests and strict gate", () => {
  assert.equal(alertFor("workflow.instance.transition", { id: "W-1", to: "verify" }, { exitCode: 0, extra: { story: "ST-A-001" } }).text, "ST-A-001 entered phase verify.");
  const pr = alertFor("autonomy.delivery.action", { id: "D-1", action: "pull_request.create", outcome: "passed", "pr-url": "https://example.test/pr/1" }, { exitCode: 0, extra: { story: "ST-A-001" } });
  assert.equal(pr.text, "pull request create done for ST-A-001. https://example.test/pr/1");
  assert.equal(alertFor("autonomy.delivery.action", { id: "D-1", action: "git.push", outcome: "failed" }, { exitCode: 0 }), null);
  assert.equal(alertFor("test.record", { story: "ST-A-001", "exit-code": "0", passed: "12", failed: "0" }, { exitCode: 0 }).text, "tests for ST-A-001 passed (12 passed, 0 failed).");
  assert.equal(alertFor("gate.check", { story: "ST-A-001", strict: true }, { exitCode: 0 }).text, "ST-A-001 strict gate passed.");
  assert.equal(alertFor("gate.check", { story: "ST-A-001" }, { exitCode: 0 }), null);
});
