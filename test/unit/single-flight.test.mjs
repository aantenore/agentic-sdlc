import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { reapStaleLocks } from "../../lib/runtime/run-registry.mjs";
import {
  acquireSingleFlight,
  busyMessage,
  classifyCommand,
  lockFileFor,
  tryAcquireLock,
  waitSeconds,
} from "../../lib/runtime/single-flight.mjs";

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-flight-"));
  fs.mkdirSync(path.join(root, ".git"));
  return root;
}

const live = { alive: () => true, commandLine: () => "node /x/agentic-sdlc/bin/agentic-sdlc.mjs gate check" };

test("classification: story, repo and free commands", () => {
  const a = classifyCommand("gate.check", { story: "st-a-001" }, "/r");
  assert.equal(a.scope, "story");
  assert.equal(a.story, "st-a-001");
  assert.equal(a.key, classifyCommand("test.record", { story: "ST-A-001" }, "/r").key);
  assert.notEqual(a.key, classifyCommand("gate.check", { story: "ST-B-001" }, "/r").key);
  assert.equal(classifyCommand("story.claim", { id: "ST-A-001" }, "/r").story, "ST-A-001");
  const profile = classifyCommand("autonomy.delivery.action", { id: "DELIVERY-1" }, "/r");
  assert.equal(profile.story, null);
  assert.match(profile.key, /autonomy\.delivery\.action/u);
  assert.equal(classifyCommand("trace.rebase", {}, "/r").scope, "repo");
  assert.equal(classifyCommand("story.publish-records", { story: "ST-A-001" }, "/r").scope, "repo");
  for (const action of ["status", "story.list", "help", "message.send", "runs.list", "observe", "gate.status"]) {
    assert.equal(classifyCommand(action, { story: "ST-A-001" }, "/r"), null, action);
  }
});

test("acquire, refuse while held, release", () => {
  const root = repo();
  const first = acquireSingleFlight({ action: "gate.check", options: { story: "ST-A-001" }, root, env: {} });
  assert.ok(first.file && fs.existsSync(first.file));
  const file = first.file;
  const other = tryAcquireLock(file, { pid: 999_999_1, started_at: new Date().toISOString() }, live);
  assert.equal(other.acquired, false);
  assert.equal(other.holder.pid, process.pid);
  assert.equal(acquireSingleFlight({ action: "gate.check", options: { story: "ST-B-001" }, root, env: {} }).busy, undefined);
  first.release();
  assert.equal(fs.existsSync(file), false);
});

test("a dead, foreign or over-limit holder is taken over", () => {
  const root = repo();
  const file = lockFileFor(path.join(root, ".git"), "k");
  const mine = { pid: 4242, started_at: new Date().toISOString() };
  for (const [holder, options] of [
    [{ pid: 7, started_at: new Date().toISOString() }, { ...live, alive: () => false }],
    [{ pid: 7, started_at: new Date().toISOString() }, { ...live, commandLine: () => "vim notes.txt" }],
    [{ pid: 7, started_at: new Date(Date.now() - 3 * 3_600_000).toISOString() }, live],
  ]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(holder));
    const result = tryAcquireLock(file, mine, options);
    assert.equal(result.acquired, true);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).pid, 4242);
    fs.rmSync(file);
  }
  fs.writeFileSync(file, JSON.stringify({ pid: 7, started_at: new Date().toISOString() }));
  assert.equal(tryAcquireLock(file, mine, live).acquired, false);
});

test("busy message, wait setting and reaper", () => {
  const text = busyMessage({ command: "gate check", story: "ST-A-001", holder: { pid: 12, started_at: new Date(Date.now() - 180_000).toISOString() } });
  assert.match(text, /^gate check for ST-A-001 is already running \(pid 12, started 3 min ago\); wait for it, or 'agentic-sdlc runs stop --pid 12' if stuck\.$/u);
  assert.equal(waitSeconds({}), 0);
  assert.equal(waitSeconds({ AGENTIC_SDLC_WAIT_FOR_LOCK_SECONDS: "5" }), 5);
  const root = repo();
  const commonDir = path.join(root, ".git");
  const dead = lockFileFor(commonDir, "dead");
  const held = lockFileFor(commonDir, "held");
  fs.mkdirSync(path.dirname(dead), { recursive: true });
  fs.writeFileSync(dead, JSON.stringify({ pid: 99, started_at: new Date().toISOString() }));
  fs.writeFileSync(held, JSON.stringify({ pid: 98, started_at: new Date().toISOString() }));
  reapStaleLocks(commonDir, { alive: (pid) => pid === 98, commandLine: live.commandLine });
  assert.equal(fs.existsSync(dead), false);
  assert.equal(fs.existsSync(held), true);
});

test("waits for the holder when asked, then refuses", () => {
  const root = repo();
  const file = lockFileFor(path.join(root, ".git"), classifyCommand("trace.rebase", {}, root).key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pid: 7, started_at: new Date().toISOString() }));
  let clock = 0;
  const waits = [];
  const second = acquireSingleFlight({
    action: "trace.rebase", root, env: { AGENTIC_SDLC_WAIT_FOR_LOCK_SECONDS: "1" },
    now: () => clock, wait: (ms) => { waits.push(ms); clock += ms; }, staleOptions: live,
  });
  assert.ok(waits.length >= 2);
  assert.match(second.busy, /trace rebase for this repository is already running \(pid 7/u);
});
