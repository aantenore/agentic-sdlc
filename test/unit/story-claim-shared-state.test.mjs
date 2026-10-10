import "../helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { serializeSharedPayload } from "../../lib/shared-ref-records.mjs";
import {
  buildSharedClaimPayload,
  buildSharedReleasePayload,
  claimNamespace,
  describeSharedHolder,
  holderIdentityText,
  interpretSharedClaimRecords,
  sharedClaimHolder,
  orchestrationPolicy,
  sharedClaimIsStale,
  sharedClaimRef,
  sharedClaimView,
  sharedReleaseRef,
  storySharedClaimState,
} from "../../lib/story-claim-shared-state.mjs";

const NOW = Date.parse("2026-10-08T12:00:00.000Z");
const HASH = "a".repeat(64);
const PROOF = "b".repeat(64);

function claimRecord(storyId, epoch, overrides = {}) {
  return {
    ref: sharedClaimRef(storyId, epoch),
    message: serializeSharedPayload(buildSharedClaimPayload({
      storyId,
      epoch,
      claimantId: `CLM-${epoch}`,
      agent: `agent-${epoch}`,
      branch: `feature/${storyId}`,
      actor: { id: `person-${epoch}`, type: "human" },
      contract: { id: `contract-${storyId}`, approval_hash: HASH },
      taskStart: { id: `START-${storyId}`, hash: HASH },
      claimedAt: "2026-10-08T10:00:00.000Z",
      expiresAt: "2026-10-09T10:00:00.000Z",
      ownerProof: PROOF,
      ...overrides,
    })),
  };
}

function releaseRecord(storyId, epoch, overrides = {}) {
  return {
    ref: sharedReleaseRef(storyId, epoch),
    message: serializeSharedPayload(buildSharedReleasePayload({
      storyId,
      epoch,
      claimantId: `CLM-${epoch}`,
      status: "released",
      reason: "done",
      releasedAt: "2026-10-08T11:00:00.000Z",
      agent: `agent-${epoch}`,
      actor: { id: `person-${epoch}`, type: "human" },
      ...overrides,
    })),
  };
}

function stateOf(records, storyId, problems = []) {
  return storySharedClaimState(interpretSharedClaimRecords(records, { problems }), storyId);
}

test("orchestration policy shares claims through origin by default and validates its values", () => {
  assert.deepEqual(orchestrationPolicy({}), {
    coordination: { mode: "auto", remote: "origin", timeout_seconds: 20 },
    stale_claim_after_seconds: null,
    delivered_overlap: { write_scope: "confirm", context: "warn", confirmation_actor: "any", claim: "warn" },
    status_sync: { mode: "fetch" },
    merge_drift: { mode: "git", base_branch: null, match_commit_subject: true, max_commits_scanned: 500, open_state: "merged_open" },
    story_records: { in_branch: "include", before_pull_request: "warn", publish_branch_prefix: "sdlc-records/", publish_pull_request: "off" },
    status_list_limit: 5,
    claim_identity: { git_user: false, host_label_env: "AGENTIC_SDLC_HOST_LABEL" },
    claim_activity: { mode: "git", idle_after_seconds: 14_400 },
    reservation: { default_expires_in_seconds: 86_400, max_expires_in_seconds: 2_592_000 },
    unclaimed_remote_work: { mode: "git", pull_requests: "off", recent_within_seconds: null },
    workflow_history: { check: "workflow", divergence: "warn" },
    certification_drift: { mode: "stale", ignored_files: "exclude" },
  });
  const configured = orchestrationPolicy({
    orchestration_policy: { stale_claim_after_seconds: 3600, coordination: { mode: "required", remote: "upstream", timeout_seconds: 5 } },
  });
  assert.equal(configured.coordination.mode, "required");
  assert.equal(configured.coordination.remote, "upstream");
  assert.equal(configured.stale_claim_after_seconds, 3600);
  for (const value of [
    { coordination: { mode: "off" } },
    { coordination: { remote: "-x" } },
    { coordination: { remote: "a/../b" } },
    { coordination: { timeout_seconds: 0 } },
    { stale_claim_after_seconds: 30 },
    { stale_claim_after_seconds: "3600" },
    { delivered_overlap: "confirm" },
    { delivered_overlap: { write_scope: "block" } },
    { delivered_overlap: { confirmation_actor: "agent" } },
    { delivered_overlap: { claim: "confirm" } },
    { status_sync: "pull" },
    { status_sync: { mode: "rebase" } },
    { merge_drift: { mode: "provider" } },
    { merge_drift: { base_branch: "../main" } },
    { merge_drift: { match_commit_subject: "yes" } },
    { merge_drift: { max_commits_scanned: 0 } },
    { status_list_limit: 0 },
    { status_list_limit: 101 },
    { claim_identity: { git_user: "yes" } },
    { claim_identity: { host_label_env: "host label" } },
    { claim_activity: { mode: "heartbeat" } },
    { claim_activity: { idle_after_seconds: 10 } },
    { reservation: { default_expires_in_seconds: 10 } },
    { reservation: { default_expires_in_seconds: 7200, max_expires_in_seconds: 3600 } },
    { unclaimed_remote_work: { mode: "provider" } },
    { unclaimed_remote_work: { pull_requests: "gitlab" } },
    { unclaimed_remote_work: { recent_within_seconds: 5 } },
    { workflow_history: { check: "none" } },
    { workflow_history: "workflow" },
    { workflow_history: { divergence: "block" } },
    { certification_drift: { mode: "ignore" } },
  ]) {
    assert.throws(() => orchestrationPolicy({ orchestration_policy: value }), /orchestration_policy\./u, JSON.stringify(value));
  }
});

test("each story has its own ref folder, and every ref name is one git accepts", () => {
  assert.equal(claimNamespace("ST-001"), "ST-001");
  assert.equal(sharedClaimRef("ST-001", 1), "refs/agentic-sdlc/claims/ST-001/000001/claim");
  assert.equal(sharedReleaseRef("ST-001", 12), "refs/agentic-sdlc/claims/ST-001/000012/release");
  const dotted = claimNamespace("ST.1");
  assert.match(dotted, /^ST_1-[a-f0-9]{12}$/u);
  assert.notEqual(dotted, claimNamespace("ST_1"));
  assert.notEqual(claimNamespace("A..B"), claimNamespace("A__B"));
  for (const id of ["ST-001", "ST.1", "A..B", "story.lock", "x_y"]) {
    const checked = spawnSync("git", ["check-ref-format", sharedClaimRef(id, 1)], { encoding: "utf8" });
    assert.equal(checked.status, 0, `${id}: ${checked.stderr}`);
  }
});

test("the latest unreleased claim is active; a released story is free and gets the next number", () => {
  const free = stateOf([], "ST-1");
  assert.equal(free.active, null);
  assert.equal(free.next_epoch, 1);

  const held = stateOf([claimRecord("ST-1", 1)], "ST-1");
  assert.equal(held.active.agent, "agent-1");
  assert.equal(held.active.contract.approval_hash, HASH);
  assert.equal(held.next_epoch, 2);
  assert.deepEqual(held.problems, []);
  assert.match(describeSharedHolder(held.active), /agent-1 \(human person-1\) on branch feature\/ST-1, since 2026-10-08T10:00:00\.000Z/u);

  const released = stateOf([claimRecord("ST-1", 1), releaseRecord("ST-1", 1)], "ST-1");
  assert.equal(released.active, null);
  assert.equal(released.latest.epoch, 1);
  assert.equal(released.next_epoch, 2);

  const reclaimed = stateOf([claimRecord("ST-1", 1), releaseRecord("ST-1", 1), claimRecord("ST-1", 2)], "ST-1");
  assert.equal(reclaimed.active.claimant_id, "CLM-2");
  assert.equal(reclaimed.next_epoch, 3);
  // Other stories are interpreted on their own.
  assert.equal(stateOf([claimRecord("ST-2", 1), claimRecord("ST-1", 1)], "ST-2").active.story_id, "ST-2");
});

test("records that are changed, misplaced, or inconsistent make the story's shared state untrustworthy", () => {
  const tampered = claimRecord("ST-1", 1);
  tampered.message = tampered.message.replace("agent-1", "agent-9");
  assert.match(stateOf([tampered], "ST-1").problems.join("\n"), /claim record 1 cannot be read/u);

  const misplaced = { ...claimRecord("ST-1", 1), ref: sharedClaimRef("ST-1", 2) };
  assert.match(stateOf([misplaced], "ST-1").problems.join("\n"), /claim record 2 cannot be read/u);

  const otherStory = { ...claimRecord("ST-2", 1), ref: sharedClaimRef("ST-1", 1) };
  assert.match(stateOf([otherStory], "ST-1").problems.join("\n"), /cannot be read/u);

  assert.match(stateOf([releaseRecord("ST-1", 1)], "ST-1").problems.join("\n"), /release record 1 has no claim record/u);
  assert.match(
    stateOf([claimRecord("ST-1", 1), releaseRecord("ST-1", 1, { claimantId: "CLM-OTHER" })], "ST-1").problems.join("\n"),
    /belongs to another claim/u,
  );
  const unexpected = { ref: "refs/agentic-sdlc/claims/ST-1/notes", message: "" };
  assert.match(stateOf([unexpected], "ST-1").problems.join("\n"), /unexpected shared claim record/u);

  const gone = stateOf([claimRecord("ST-1", 1)], "ST-1", [
    { ref: sharedReleaseRef("ST-1", 1), message: "the shared release record 1 of ST-1, recorded before, is gone from the remote" },
  ]);
  assert.match(gone.problems.join("\n"), /gone from the remote/u);

  const unreleased = stateOf([claimRecord("ST-1", 1), claimRecord("ST-1", 2)], "ST-1");
  assert.equal(unreleased.active.epoch, 2);
  assert.match(unreleased.warnings.join("\n"), /claim 1 was never released before claim 2/u);
});

test("a claim is stale once it expires or is older than the configured age", () => {
  const claim = JSON.parse(claimRecord("ST-1", 1).message);
  assert.equal(sharedClaimIsStale(claim, { nowMs: NOW }), false);
  assert.equal(sharedClaimIsStale(claim, { nowMs: NOW, staleAfterSeconds: 3600 }), true);
  assert.equal(sharedClaimIsStale(claim, { nowMs: NOW, staleAfterSeconds: 3 * 3600 }), false);
  assert.equal(sharedClaimIsStale(claim, { nowMs: Date.parse("2026-10-10T00:00:00.000Z") }), true);
  assert.equal(sharedClaimIsStale(null, { nowMs: NOW }), false);
});

test("the view tells this computer whether it holds the story and when its claim was taken over", () => {
  const records = [claimRecord("ST-1", 1)];
  const mine = { story_id: "ST-1", status: "active", shared_claim: { scope: "shared", epoch: 1, claimant_id: "CLM-1", owner_proof: PROOF } };
  const owned = new Map([["ST-1/000001", { claimant_id: "CLM-1", proof: PROOF, state: "confirmed" }]]);
  const here = sharedClaimView(stateOf(records, "ST-1"), mine, { nowMs: NOW, owned });
  assert.equal(here.state, "claimed");
  assert.equal(here.here, true);
  // A claim file that arrived with git does not make another computer's claim ours.
  const copied = sharedClaimView(stateOf(records, "ST-1"), mine, { nowMs: NOW });
  assert.equal(copied.here, false);
  assert.equal(copied.ended_here, undefined);
  // An ownership record without the secret behind the claim's proof proves nothing.
  const forged = sharedClaimView(stateOf(records, "ST-1"), mine, {
    nowMs: NOW,
    owned: new Map([["ST-1/000001", { claimant_id: "CLM-1", proof: "c".repeat(64), state: "confirmed" }]]),
  });
  assert.equal(forged.here, false);

  const elsewhere = sharedClaimView(stateOf(records, "ST-1"), null, { nowMs: NOW, staleAfterSeconds: 60 });
  assert.equal(elsewhere.here, false);
  assert.equal(elsewhere.state, "stale");
  assert.equal(elsewhere.holder.agent, "agent-1");

  const takenOver = sharedClaimView(stateOf([
    claimRecord("ST-1", 1),
    releaseRecord("ST-1", 1, {
      status: "taken_over",
      reason: "the laptop is gone",
      takenOverBy: { claimantId: "CLM-2", agent: "agent-2", branch: "feature/ST-1", actor: { id: "person-2", type: "human" } },
    }),
    claimRecord("ST-1", 2),
  ], "ST-1"), mine, { nowMs: NOW, owned });
  assert.equal(takenOver.here, false);
  assert.equal(takenOver.holder.claimant_id, "CLM-2");
  assert.equal(takenOver.ended_here.status, "taken_over");
  assert.equal(takenOver.ended_here.by.agent, "agent-2");
  assert.equal(takenOver.ended_here.reason, "the laptop is gone");

  const unshared = sharedClaimView(stateOf([], "ST-1"), { story_id: "ST-1", status: "active" }, { nowMs: NOW });
  assert.equal(unshared.state, "free");
  assert.equal(unshared.not_shared, true);

  const missing = sharedClaimView(stateOf([], "ST-1"), mine, { nowMs: NOW, owned });
  assert.equal(missing.state, "untrustworthy");
  assert.match(missing.problems.join("\n"), /this computer's claim 1 is not on the remote/u);
});

test("a release status outside the recorded set is refused", () => {
  assert.throws(() => buildSharedReleasePayload({
    storyId: "ST-1", epoch: 1, claimantId: "CLM-1", status: "active", releasedAt: "2026-10-08T11:00:00.000Z",
  }), /release status/u);
});

test("a claim gone from the remote stays a problem but no longer holds the story", () => {
  const gone = stateOf([claimRecord("ST-1", 1)], "ST-1", [
    { ref: sharedClaimRef("ST-1", 1), gone: true, message: "the shared claim record 1 of ST-1, recorded before, is gone from the remote" },
  ]);
  assert.equal(gone.active, null);
  assert.match(gone.problems.join("\n"), /gone from the remote/u);
  const view = sharedClaimView(gone, null, { nowMs: NOW });
  assert.equal(view.state, "untrustworthy");
  assert.equal(view.holder, null);
});

test("a claim file that came with git is outdated once the remote ended its claim", () => {
  const copied = { story_id: "ST-1", status: "active", shared_claim: { scope: "shared", epoch: 1, claimant_id: "CLM-1", owner_proof: PROOF } };
  const ended = sharedClaimView(stateOf([claimRecord("ST-1", 1), releaseRecord("ST-1", 1)], "ST-1"), copied, { nowMs: NOW });
  assert.equal(ended.state, "free");
  assert.equal(ended.local_claim_outdated, true);
  const missing = sharedClaimView(stateOf([], "ST-1"), copied, { nowMs: NOW });
  assert.equal(missing.local_claim_outdated, true);
  const current = sharedClaimView(stateOf([claimRecord("ST-1", 1)], "ST-1"), copied, { nowMs: NOW });
  assert.equal(current.local_claim_outdated, undefined);
});

test("a shared claim records who made it only when the project opted in", () => {
  const plain = JSON.parse(claimRecord("ST-1", 1).message);
  assert.equal("identity" in plain, false);
  assert.equal(holderIdentityText(sharedClaimHolder(plain)), null);
  const named = JSON.parse(claimRecord("ST-1", 1, { identity: { user: "Antonio\u0007", host: "mac-studio" } }).message);
  assert.deepEqual(named.identity, { user: "Antonio", host: "mac-studio" });
  assert.equal(holderIdentityText(sharedClaimHolder(named)), "Antonio, mac-studio");
  assert.match(describeSharedHolder(named), /^agent-1 \(Antonio, mac-studio\) on branch feature\/ST-1/u);
  const empty = JSON.parse(claimRecord("ST-1", 1, { identity: { user: " ", host: null } }).message);
  assert.equal("identity" in empty, false);
  // Records written with an identity stay readable as claims.
  assert.equal(stateOf([claimRecord("ST-1", 1, { identity: { host: "pc-2" } })], "ST-1").active.identity.host, "pc-2");
});

test("a reservation is a claim record that older readers also see as held, and it ends by itself when it expires", () => {
  const reservation = claimRecord("ST-1", 1, { reservation: true, contract: null, taskStart: null, expiresAt: "2026-10-08T13:00:00.000Z" });
  const state = stateOf([reservation], "ST-1");
  assert.equal(state.active.reservation, true);
  assert.deepEqual(state.problems, []);
  assert.match(describeSharedHolder(state.active), /^reserved by agent-1 .* until 2026-10-08T13:00:00\.000Z$/u);
  const held = sharedClaimView(state, null, { nowMs: NOW });
  assert.equal(held.state, "claimed");
  assert.equal(held.holder.reservation, true);
  const later = sharedClaimView(state, null, { nowMs: Date.parse("2026-10-08T13:00:01.000Z") });
  assert.equal(later.state, "free");
  assert.equal(later.holder, null);
  assert.equal(later.expired_reservation.agent, "agent-1");
  // An ordinary claim keeps its payload unchanged: no reservation key.
  assert.equal("reservation" in JSON.parse(claimRecord("ST-1", 1).message), false);
});

test("a release made after the story's delivery finished leaves the story completed, not free", () => {
  assert.equal("completion" in JSON.parse(releaseRecord("ST-1", 1).message), false, "plain releases keep their original shape");
  const completion = { delivery_id: "DEL-1", delivery_kind: "pull_request", terminal_status: "merged", merge_commit: "c".repeat(40), extra: "dropped" };
  const record = releaseRecord("ST-1", 1, { status: "completed", completion });
  assert.deepEqual(JSON.parse(record.message).completion, {
    delivery_id: "DEL-1", delivery_kind: "pull_request", terminal_status: "merged", closed_at: null, merge_commit: "c".repeat(40), close_receipt_hash: null,
  });
  const state = stateOf([claimRecord("ST-1", 1), record], "ST-1");
  assert.equal(state.active, null);
  assert.equal(state.completed.status, "completed");
  const view = sharedClaimView(state, null, { nowMs: NOW });
  assert.equal(view.state, "completed");
  assert.equal(view.completed.terminal_status, "merged");
  assert.equal(view.completed.agent, "agent-1");

  // A story closed by supersede or cancel is finished too; a later claim (a person's decision) holds it again.
  const closed = stateOf([claimRecord("ST-1", 1), releaseRecord("ST-1", 1, { status: "closed" })], "ST-1");
  assert.equal(sharedClaimView(closed, null, { nowMs: NOW }).completed.status, "closed");
  const reopened = stateOf([claimRecord("ST-1", 1), record, claimRecord("ST-1", 2)], "ST-1");
  assert.equal(reopened.completed, null);
  assert.equal(sharedClaimView(reopened, null, { nowMs: NOW }).state, "claimed");
});
