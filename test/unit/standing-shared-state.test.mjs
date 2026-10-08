import assert from "node:assert/strict";
import test from "node:test";

import {
  STANDING_APPROVAL_POLICY_DEFAULTS,
  buildStandingApprovalProposal,
} from "../../lib/standing-approvals.mjs";
import { remoteFingerprint } from "../../lib/engine/standing-shared.mjs";
import {
  buildSharedRevocationPayload,
  buildSharedSlotPayload,
  interpretSharedRefs,
  nextStandingSlot,
  serializeSharedPayload,
  sharedStateReasons,
  sharedStateSummary,
  standingCoordinationPolicy,
  standingSharedFetchRefspec,
  standingSharedRefForTracking,
  standingSharedRevocationRef,
  standingSharedSlotRef,
} from "../../lib/standing-shared-state.mjs";

const HASH = "a".repeat(64);
const NOW = "2026-10-06T10:00:00.000Z";

function proposal(overrides = {}) {
  return buildStandingApprovalProposal({
    id: "SA-DEPS",
    recipe_id: "dependency-bump",
    description: "Bump patch versions",
    destination: "local_release",
    requirement_refs: [{ id: "REQ-DEPS", profile_id: "AUT-REQ-DEPS", profile_hash: HASH }],
    allowed_write_paths: ["package.json"],
    max_changed_files: 3,
    max_changed_lines: 50,
    max_deliveries: 2,
    expires_at: "2026-10-10T10:00:00.000Z",
    scope: { project_id: "demo", project_root: "/work/demo" },
    bindings: { config_hash: HASH, policy_hash: "b".repeat(64), project_hash: "c".repeat(64) },
    ...overrides,
  }, { now: NOW, policy: STANDING_APPROVAL_POLICY_DEFAULTS });
}

function slotRef(record, slot, delivery = "LOCAL-1", profile = "AUT-1") {
  return {
    ref: standingSharedSlotRef(record, slot),
    message: serializeSharedPayload(buildSharedSlotPayload({
      proposal: record,
      slot,
      delivery: { id: delivery, kind: "local_release" },
      profileRef: { id: profile, hash: "d".repeat(64) },
    })),
  };
}

function shared(record, refs) {
  return { scope: "shared", remote: "origin", available: true, error: null, ...interpretSharedRefs(record, refs) };
}

test("coordination policy defaults to sharing when a remote exists and validates its values", () => {
  assert.deepEqual(standingCoordinationPolicy(undefined), { mode: "auto", remote: "origin", timeout_seconds: 20 });
  assert.equal(standingCoordinationPolicy({ mode: "required", remote: "upstream" }).remote, "upstream");
  for (const value of [{ mode: "off" }, { remote: "-x" }, { remote: "a/../b" }, { timeout_seconds: 0 }, { timeout_seconds: 301 }, { timeout_seconds: "5" }]) {
    assert.throws(() => standingCoordinationPolicy(value), /coordination/u, JSON.stringify(value));
  }
});

test("shared refs live in one namespace per standing approval content", () => {
  const record = proposal();
  const other = proposal({ max_deliveries: 3 });
  assert.match(standingSharedSlotRef(record, 1), /^refs\/agentic-sdlc\/standing\/SA-DEPS\/[a-f0-9]{16}\/slots\/0001$/u);
  assert.notEqual(standingSharedSlotRef(record, 1), standingSharedSlotRef(other, 1));
  assert.match(standingSharedRevocationRef(record), /\/revoked$/u);
  const [source, target] = standingSharedFetchRefspec(record).slice(1).split(":");
  assert.equal(standingSharedRefForTracking(target.replace("*", "slots/0002")), source.replace("*", "slots/0002"));
});

test("shared slots and revocations are read only when intact and bound to this standing approval", () => {
  const record = proposal();
  const revocation = {
    ref: standingSharedRevocationRef(record),
    message: serializeSharedPayload(buildSharedRevocationPayload({ proposal: record, revocation: { record_hash: HASH, reason: "stop" } })),
  };
  const state = interpretSharedRefs(record, [slotRef(record, 1), revocation]);
  assert.deepEqual(state.slots.map((slot) => slot.slot), [1]);
  assert.equal(state.revoked.reason, "stop");
  assert.deepEqual(state.errors, []);

  const tampered = slotRef(record, 2);
  tampered.message = tampered.message.replace("LOCAL-1", "LOCAL-9");
  const foreign = slotRef(proposal({ max_deliveries: 3 }), 2);
  foreign.ref = standingSharedSlotRef(record, 2);
  const beyond = slotRef(record, 3);
  const bad = interpretSharedRefs(record, [tampered, foreign, beyond, { ref: `${standingSharedSlotRef(record, 1)}x`, message: "" }]);
  assert.equal(bad.slots.length, 0);
  assert.equal(bad.errors.length, 4);
});

test("a standing approval covers nothing when its shared state is unknown, revoked, or exhausted elsewhere", () => {
  const record = proposal();
  assert.deepEqual(sharedStateReasons(record, { scope: "local" }), []);
  assert.match(
    sharedStateReasons(record, { scope: "shared", remote: "origin", available: false, error: "no answer within 20 seconds" }).join(),
    /cannot be checked \(no answer within 20 seconds\)/u,
  );
  const revoked = {
    ref: standingSharedRevocationRef(record),
    message: serializeSharedPayload(buildSharedRevocationPayload({ proposal: record, revocation: { record_hash: HASH, reason: "stop" } })),
  };
  assert.match(sharedStateReasons(record, shared(record, [revoked])).join(), /it was revoked/u);
  // Another clone used both slots: a new delivery here is not covered.
  const full = shared(record, [slotRef(record, 1), slotRef(record, 2, "LOCAL-2", "AUT-2")]);
  assert.match(sharedStateReasons(record, full).join(), /all 2 deliveries were used/u);
  assert.equal(nextStandingSlot(record, [], full.slots), null);
  // A delivery holding a slot must find the same slot, for itself, on the remote.
  const use = { slot: 1, delivery: { id: "LOCAL-1", kind: "local_release" }, profile_ref: { id: "AUT-1", hash: "d".repeat(64) } };
  assert.deepEqual(sharedStateReasons(record, full, { use }), []);
  assert.match(sharedStateReasons(record, full, { use: { ...use, delivery: { id: "LOCAL-3", kind: "local_release" } } }).join(), /belongs to delivery LOCAL-1/u);
  assert.match(sharedStateReasons(record, shared(record, []), { use }).join(), /not recorded on the git remote/u);
});

test("the next slot is the first one free across this computer and the remote", () => {
  const record = proposal({ max_deliveries: 3 });
  assert.equal(nextStandingSlot(record, [], []), 1);
  assert.equal(nextStandingSlot(record, [{ slot: 1 }], [{ slot: 2 }]), 3);
  assert.equal(nextStandingSlot(record, [{ slot: 2 }], []), 1);
});

test("the shared state summary is plain and never claims a check that did not happen", () => {
  assert.equal(sharedStateSummary({ scope: "local", note: "sharing is turned off" }).note, "sharing is turned off");
  const unreachable = sharedStateSummary({ scope: "shared", remote: "origin", available: false, error: "offline", slots: [], errors: [] });
  assert.equal(unreachable.checked, false);
  assert.equal(unreachable.error, "offline");
});

test("one repository has one fingerprint whatever the address form, and credentials never count", () => {
  const forms = [
    "https://github.com/Acme/Shop.git",
    "https://user:secret@github.com/acme/shop",
    "https://www.github.com/acme/shop/",
    "ssh://git@github.com:22/acme/shop.git",
    "git@github.com:acme/shop.git",
    "git@github.com:/acme/shop",
    "git://github.com/acme//shop.git",
  ];
  const fingerprints = new Set(forms.map(remoteFingerprint));
  assert.equal(fingerprints.size, 1, forms.join(" "));
  assert.notEqual(remoteFingerprint("https://github.com/acme/shop"), remoteFingerprint("https://github.com/acme/shop-fork"));
  assert.notEqual(remoteFingerprint("https://github.com/acme/shop"), remoteFingerprint("https://gitlab.com/acme/shop"));
  assert.notEqual(remoteFingerprint("/srv/git/shop.git"), remoteFingerprint("/srv/git/other.git"));
  assert.equal(remoteFingerprint("C:\\repos\\shop.git"), remoteFingerprint("C:/repos/shop"));
});

test("a revocation or a slot kept in this repository's refs still counts in local scope", () => {
  const record = proposal({ max_deliveries: 1 });
  const local = { scope: "local", note: "no remote", localRevoked: { reason: "stop" }, localSlots: [] };
  assert.match(sharedStateReasons(record, local).join(), /revoked on this computer \(stop\)/u);
  const used = { scope: "local", note: "no remote", localRevoked: null, localSlots: [{ slot: 1 }] };
  assert.match(sharedStateReasons(record, used).join(), /all 1 deliveries were used/u);
  assert.deepEqual(sharedStateReasons(record, used, { use: { slot: 1 } }), []);
});
