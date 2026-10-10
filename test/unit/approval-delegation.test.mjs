import "../helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import {
  DELEGATION_SCHEMA_VERSION,
  evaluateDelegationUse,
  normalizeDelegationActions,
  parseDeliveryPolicy,
  parseDelegationScope,
  parseDelegationUntil,
  sealDelegationRecord,
} from "../../lib/approval-delegation.mjs";
import { delegatedApprovalRecordErrors } from "../../lib/engine/delegation-records.mjs";
import { evaluatePreToolUse } from "../../lib/host-hooks/guard.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = path.join(ROOT, "bin", "agentic-sdlc.mjs");
const projects = new Set();
const AGENT_MARKERS = ["CODEX_AGENT_NAME", "CODEX_THREAD_ID", "CODEX_USER_ID", "CLAUDECODE", "AGENTIC_SDLC_AGENT_HOST", "CI", "GITHUB_ACTIONS", "GITHUB_ACTOR"];

after(() => {
  for (const project of projects) fs.rmSync(project, { recursive: true, force: true });
});

function run(args, { agent = false } = {}) {
  const env = { ...process.env };
  for (const key of AGENT_MARKERS) delete env[key];
  delete env.AGENTIC_SDLC_MAIN_THREAD;
  if (agent) env.CLAUDECODE = "1";
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env, timeout: 30_000 });
}

function mustRun(args, options) {
  const result = run(args, options);
  assert.equal(result.status, 0, `${args.join(" ")}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result.stdout;
}

function mustFail(args, pattern, options) {
  const result = run(args, options);
  assert.notEqual(result.status, 0, `${args.join(" ")} unexpectedly succeeded:\n${result.stdout}`);
  assert.match(`${result.stdout}\n${result.stderr}`, pattern);
}

const HOUR = 3_600_000;
const GRANTED = "2026-10-01T00:00:00.000Z";

function sampleDelegation(overrides = {}) {
  return sealDelegationRecord({
    id: "DLG-T",
    kind: "approval_delegation",
    schema_version: DELEGATION_SCHEMA_VERSION,
    status: "approved",
    scope: { kind: "story", id: "ST-1" },
    actions: ["base.acknowledge", "breakdown.approve"],
    valid_from: GRANTED,
    expires_at: "2026-10-31T00:00:00.000Z",
    grantor: { id: "antonio", type: "human", name: "Antonio" },
    approval: { status: "approved", approval_source: "explicit-user" },
    ...overrides,
  });
}

const AT = new Date(Date.parse(GRANTED) + 24 * HOUR);

test("a valid delegation covers its action and scope", () => {
  const decision = evaluateDelegationUse(sampleDelegation(), { action: "base.acknowledge", target: { story: "ST-1" }, now: AT });
  assert.deepEqual(decision, { valid: true, errors: [] });
});

test("expired, revoked, uncovered action or scope, and tampered hash are rejected with a clear reason", () => {
  const record = sampleDelegation();
  const check = (options) => evaluateDelegationUse(options.record || record, {
    action: "base.acknowledge",
    target: { story: "ST-1" },
    now: AT,
    ...options,
  });
  assert.match(check({ now: new Date("2026-11-01T00:00:00Z") }).errors.join(), /expired on 2026-10-31/u);
  assert.match(check({ revocation: { revoked_at: GRANTED, revoked_by: { name: "Antonio" }, reason: "stop" } }).errors.join(), /revoked .* Antonio: stop/u);
  assert.match(check({ action: "contract.approve" }).errors.join(), /does not cover the action contract\.approve/u);
  assert.match(check({ target: { story: "ST-2" } }).errors.join(), /scope story:ST-1 does not cover story ST-2/u);
  const tampered = { ...record, actions: [...record.actions, "story.abandon"] };
  assert.match(check({ record: tampered, action: "story.abandon" }).errors.join(), /hash does not match/u);
  const projectOnly = evaluateDelegationUse(sampleDelegation({ scope: { kind: "requirement", id: "REQ-1" } }), {
    action: "breakdown.approve", target: {}, now: AT,
  });
  assert.match(projectOnly.errors.join(), /scope requirement:REQ-1 does not cover a project-wide subject/u);
});

test("excluded actions are never delegable, even when listed", () => {
  for (const action of ["git.push", "pull_request.merge", "deploy.remote", "production.access", "secrets.read",
    "capability.install", "AGENTIC_SDLC_ALLOW_UNGOVERNED_MERGE", "ungoverned.git", "delegation.grant"]) {
    assert.throws(() => normalizeDelegationActions(["breakdown.approve", action]), /Never delegable/u, action);
    assert.match(evaluateDelegationUse(sampleDelegation({ actions: [action] }), { action, target: { story: "ST-1" }, now: AT }).errors.join(), /never delegable/u);
  }
  assert.throws(() => normalizeDelegationActions("*"), /wildcards/u);
  assert.throws(() => normalizeDelegationActions("story.create"), /Unknown action class/u);
  assert.deepEqual(normalizeDelegationActions("output.link, breakdown.approve"), ["breakdown.approve", "output.link"]);
  assert.deepEqual(parseDelegationScope("requirement:req-1"), { kind: "requirement", id: "REQ-1" });
  assert.throws(() => parseDelegationScope("team"), /--scope must be/u);
  assert.equal(parseDelegationUntil("30d", { now: GRANTED }), "2026-10-31T00:00:00.000Z");
  assert.throws(() => parseDelegationUntil("2020-01-01", { now: GRANTED }), /in the past/u);
  assert.throws(() => parseDelegationUntil("400d", { now: GRANTED }), /maximum validity/u);
});

test("the agent cannot run grant or revoke; delegated person-only commands pass the hook for the CLI to verify", () => {
  const grant = evaluatePreToolUse({ tool_name: "Bash", tool_input: { command: "agentic-sdlc autonomy delegation grant --id DLG-X --scope project --actions breakdown.approve --until 30d --summary s --actor-type human --approval-source explicit-user" } });
  assert.equal(grant?.decision, "deny");
  assert.match(grant.reason, /Only the user can grant or revoke an approval delegation/u);
  assert.equal(evaluatePreToolUse({ tool_name: "Bash", tool_input: { command: "agentic-sdlc autonomy delegation revoke --id DLG-X --reason r" } })?.decision, "deny");
  assert.equal(evaluatePreToolUse({ tool_name: "Bash", tool_input: { command: "agentic-sdlc story abandon --id ST-1 --reason x --actor-type human" } })?.decision, "deny");
  assert.equal(evaluatePreToolUse({ tool_name: "Bash", tool_input: { command: "agentic-sdlc story abandon --id ST-1 --reason x --actor-type agent --approval-source delegated --delegation DLG-X" } }), null);
  assert.equal(evaluatePreToolUse({ tool_name: "Bash", tool_input: { command: "echo x > .sdlc/autonomy/delegations/DLG-X/delegation.json" } })?.decision, "deny");
});

test("a person grants once; the agent applies it and the record says so; revocation and tampering stop it", () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-delegation-")));
  projects.add(project);
  mustRun(["init", "--root", project, "--project-name", "Delegation fixture"]);
  const createdAt = new Date().toISOString();
  fs.writeFileSync(path.join(project, ".sdlc", "requirements", "REQ-001.json"), `${JSON.stringify({
    id: "REQ-001", kind: "requirement", schema_version: "requirement:v1", title: "Weekend itinerary",
    summary: "Plan a weekend", status: "active", acceptance_criteria: ["An itinerary exists"], source_paths: [],
    proposal_ref: null, created_at: createdAt, updated_at: createdAt, audit: { fixture: true },
  }, null, 2)}\n`);
  const propose = (id) => mustRun(["breakdown", "propose", "--root", project, "--id", id, "--requirement", "REQ-001", "--item", "story:ST-ONE"]);
  const agentApprove = (id, extra = ["--approval-source", "delegated", "--delegation", "DLG-T1"]) => [
    "breakdown", "approve", "--root", project, "--id", id, "--actor-type", "agent", ...extra, "--summary", "split ok",
  ];
  const grant = ["autonomy", "delegation", "grant", "--root", project, "--id", "DLG-T1", "--scope", "requirement:REQ-001",
    "--actions", "breakdown.approve,dependency.approve", "--until", "30d", "--summary", "Agent may approve planning",
    "--actor-type", "human", "--approval-source", "explicit-user", "--actor-name", "Antonio"];

  // The agent cannot produce the delegation it would use.
  mustFail(grant, /cannot run inside an agent session/u, { agent: true });
  mustFail([...grant.slice(0, -6), "--actor-type", "agent", "--approval-source", "explicit-user"], /human/u);
  mustFail([...grant.slice(0, 10), "deploy.remote,breakdown.approve", ...grant.slice(11)], /Never delegable/u);
  mustRun(grant);
  const record = JSON.parse(fs.readFileSync(path.join(project, ".sdlc/autonomy/delegations/DLG-T1/delegation.json"), "utf8"));
  assert.equal(record.grantor.type, "human");
  assert.equal(record.approval.approval_source, "explicit-user");
  assert.match(record.record_hash, /^[a-f0-9]{64}$/u);
  assert.ok(record.grant_receipt.id.startsWith("DLGR-"));

  // An agent without a delegation is still rejected as today.
  propose("BRK-1");
  mustFail(agentApprove("BRK-1", ["--approval-source", "explicit-user"]), /explicit-user|human/u, { agent: true });
  mustFail(agentApprove("BRK-1", ["--approval-source", "delegated"]), /needs --delegation/u, { agent: true });

  // With the delegation the agent's approval is accepted and marked as delegated.
  mustRun(agentApprove("BRK-1"), { agent: true });
  const breakdown = JSON.parse(fs.readFileSync(path.join(project, ".sdlc/work-breakdown/BRK-1.json"), "utf8"));
  const approval = breakdown.approvals.at(-1);
  assert.equal(approval.approval_source, "delegated");
  assert.equal(approval.explicit_user_confirmation, false);
  assert.equal(approval.approved_by.type, "agent");
  assert.match(approval.summary, /approvato dall'agente per delega DLG-T1 di Antonio/u);
  assert.equal(approval.delegation.valid_at_use.scope_covered, true);
  assert.ok(fs.existsSync(path.join(project, approval.delegation.use_path)));
  const list = JSON.parse(mustRun(["autonomy", "delegation", "list", "--root", project, "--json"]));
  assert.equal(list.delegations[0].uses, 1);
  assert.equal(list.delegations[0].state, "active");

  // A command outside the delegated actions is refused.
  mustFail(["story", "abandon", "--root", project, "--id", "ST-ONE", "--reason", "x", "--actor-type", "agent",
    "--approval-source", "delegated", "--delegation", "DLG-T1"], /does not cover the action story\.abandon/u, { agent: true });

  // Tampering with the delegation invalidates it.
  const recordPath = path.join(project, ".sdlc/autonomy/delegations/DLG-T1/delegation.json");
  const original = fs.readFileSync(recordPath, "utf8");
  fs.writeFileSync(recordPath, original.replace("\"dependency.approve\"", "\"story.abandon\""));
  propose("BRK-2");
  mustFail(agentApprove("BRK-2"), /hash does not match/u, { agent: true });
  fs.writeFileSync(recordPath, original);

  // Revoked: refused at the next use.
  mustFail(["autonomy", "delegation", "revoke", "--root", project, "--id", "DLG-T1", "--reason", "stop",
    "--actor-type", "human", "--approval-source", "explicit-user"], /agent session/u, { agent: true });
  mustRun(["autonomy", "delegation", "revoke", "--root", project, "--id", "DLG-T1", "--reason", "stop",
    "--actor-type", "human", "--approval-source", "explicit-user", "--summary", "Back to direct approvals"]);
  mustFail(agentApprove("BRK-2"), /revoked .*stop/u, { agent: true });
});

test("delivery.policy is delegable and its answers are parsed strictly", () => {
  assert.deepEqual(normalizeDelegationActions("delivery.policy"), ["delivery.policy"]);
  assert.deepEqual(parseDeliveryPolicy("code-review=not-required,merge=automatic"), { code_review: "not-required", merge: "automatic" });
  assert.throws(() => parseDeliveryPolicy(""), /at least one answer/u);
  assert.throws(() => parseDeliveryPolicy("merge=yes"), /merge must be one of/u);
  assert.throws(() => parseDeliveryPolicy("deploy=automatic"), /is not one of/u);
  assert.throws(() => parseDeliveryPolicy("merge=manual,merge=automatic"), /more than once/u);
  const record = sampleDelegation({ actions: ["delivery.policy"], scope: { kind: "project", id: null } });
  assert.deepEqual(evaluateDelegationUse(record, { action: "delivery.policy", target: { story: "ST-1" }, now: AT }), { valid: true, errors: [] });
  assert.match(evaluateDelegationUse(record, { action: "delivery.policy", now: new Date("2026-11-01T00:00:00.000Z") }).errors.join(), /expired/u);
  assert.match(evaluateDelegationUse(sampleDelegation(), { action: "delivery.policy", target: { story: "ST-1" }, now: AT }).errors.join(), /does not cover the action delivery\.policy/u);
});

test("delegated output decisions: legacy records rest on the recorded actor and the receipt, new ones on approved_by", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-delegated-record-")));
  projects.add(root);
  const context = { root, sdlcRoot: path.join(root, ".sdlc") };
  const agent = { id: "claude-code", type: "agent", name: "Claude Code" };
  const record = sampleDelegation({ actions: ["output.link"], scope: { kind: "project", id: null } });
  const dir = path.join(context.sdlcRoot, "autonomy", "delegations", record.id);
  fs.mkdirSync(path.join(dir, "uses"), { recursive: true });
  fs.writeFileSync(path.join(dir, "delegation.json"), JSON.stringify(record));
  const writeUse = (overrides = {}) => {
    const use = sealDelegationRecord({
      id: "DLGUSE-1", schema_version: "approval-delegation-use:v1",
      delegation_ref: { id: record.id, record_hash: record.record_hash }, action: "output.link",
      valid_at_use: { checked_at: AT.toISOString(), expires_at: record.expires_at, revoked: false, hash_valid: true, action_covered: true, scope_covered: true },
      used_by: agent, used_at: AT.toISOString(), ...overrides,
    });
    const usePath = path.join(".sdlc", "autonomy", "delegations", record.id, "uses", "DLGUSE-1.json");
    fs.writeFileSync(path.join(root, usePath), JSON.stringify(use));
    return { use_path: usePath, use_hash: use.record_hash };
  };
  const decision = (overrides = {}) => ({
    approval_source: "delegated",
    delegation: { id: record.id, record_hash: record.record_hash, action: "output.link", ...writeUse(overrides) },
  });
  const actorError = "a delegated approval must be applied by an agent actor";

  // Legacy: no approved_by, the agent is recorded in audit.decided_by and passed by the caller.
  assert.deepEqual(delegatedApprovalRecordErrors(context, decision(), agent), []);
  assert.ok(delegatedApprovalRecordErrors(context, decision()).includes(actorError));
  assert.ok(delegatedApprovalRecordErrors(context, decision(), { id: "antonio", type: "human" }).includes(actorError));
  assert.ok(delegatedApprovalRecordErrors(context, decision(), { id: "other-agent", type: "agent" }).some((e) => /is not the agent claude-code/u.test(e)));
  // New: approved_by is written and is the actor that counts.
  assert.deepEqual(delegatedApprovalRecordErrors(context, { ...decision(), approved_by: agent }), []);
  assert.ok(delegatedApprovalRecordErrors(context, { ...decision(), approved_by: { type: "human" } }, agent).includes(actorError));
  // The receipt must show the delegation valid for this action at use.
  const invalid = (overrides) => delegatedApprovalRecordErrors(context, decision(overrides), agent);
  assert.ok(invalid({ action: "story.abandon" }).some((e) => /covers story\.abandon, not output\.link/u.test(e)));
  for (const flag of [{ action_covered: false }, { revoked: true }, { scope_covered: false }, { checked_at: "2027-01-01T00:00:00.000Z" }]) {
    const valid_at_use = { checked_at: AT.toISOString(), expires_at: record.expires_at, revoked: false, hash_valid: true, action_covered: true, scope_covered: true, ...flag };
    assert.ok(invalid({ valid_at_use }).some((e) => /was not valid for this action at use/u.test(e)), JSON.stringify(flag));
  }
  assert.ok(invalid({ used_by: { id: "antonio", type: "human" } }).some((e) => /not recorded by an agent actor/u.test(e)));
  assert.ok(delegatedApprovalRecordErrors(context, { ...decision(), delegation: { ...decision().delegation, id: "DLG-NONE" } }, agent)
    .some((e) => /DLG-NONE does not exist/u.test(e)));
});
