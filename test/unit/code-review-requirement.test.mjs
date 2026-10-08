import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { normalizeCodeReviewDecision } from "../../lib/autonomy-policy.mjs";
import {
  codeReviewChoiceFromOptions,
  codeReviewRequirement,
  codeReviewRequirementSentence,
} from "../../lib/engine/code-review-requirement.mjs";
import { standingCodeReviewReasons } from "../../lib/standing-approvals.mjs";

const DECIDED_AT = "2026-10-08T10:00:00.000Z";

function context(projectRequires) {
  const sdlcRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-review-requirement-"));
  return {
    root: sdlcRoot,
    sdlcRoot,
    config: { gate_policy: projectRequires === undefined ? {} : { merge_requires_code_review: projectRequires } },
  };
}

function profile(choice) {
  return {
    id: "AUT-1",
    profile_hash: "a".repeat(64),
    delivery_kind: "pull_request",
    pull_request_target: choice ? { code_review: choice } : {},
  };
}

const userChoice = (decision) => ({
  decision,
  source: "explicit-user",
  actor_id: "user",
  user_words: "answer",
  standing_approval_id: null,
  decided_at: DECIDED_AT,
});

test("the per-story choice decides, the project policy is a floor, and legacy profiles follow the default", () => {
  assert.equal(codeReviewRequirement(context(false), profile(userChoice("required"))).required, true);
  assert.equal(codeReviewRequirement(context(false), profile(userChoice("not-required"))).required, false);
  const floor = codeReviewRequirement(context(true), profile(userChoice("not-required")));
  assert.equal(floor.required, true);
  assert.equal(floor.source, "project_policy");
  const legacy = codeReviewRequirement(context(undefined), profile(null));
  assert.equal(legacy.required, false);
  assert.equal(legacy.source, "project_default");
  assert.equal(codeReviewRequirement(context(true), profile(null)).source, "project_policy");
  assert.equal(codeReviewRequirement(context(true), { ...profile(null), delivery_kind: "local_release" }).required, false);
});

test("the requirement is explained in English and Italian", () => {
  const required = codeReviewRequirement(context(false), profile(userChoice("required")));
  assert.match(codeReviewRequirementSentence(required), /^Code review before merge: required \(chosen by the user for this story\)/u);
  assert.match(codeReviewRequirementSentence(required, { italian: true }), /^Revisione del codice prima del merge: richiesta/u);
});

test("only a person's explicit answer is recorded; a local release takes none", () => {
  const ctx = context(false);
  assert.throws(() => codeReviewChoiceFromOptions(ctx, {}, "pull_request"), /needs the user's answer/u);
  assert.throws(() => codeReviewChoiceFromOptions(ctx, {
    "code-review": "required",
    "code-review-actor-type": "agent",
    "code-review-approval-source": "explicit-user",
    "code-review-summary": "x",
  }, "pull_request"), /An agent or system cannot make it/u);
  assert.throws(() => codeReviewChoiceFromOptions(ctx, { "code-review": "required" }, "local_release"), /only to pull-request deliveries/u);
  assert.equal(codeReviewChoiceFromOptions(ctx, {}, "local_release"), null);
  const choice = codeReviewChoiceFromOptions(ctx, {
    "code-review": "not-required",
    "code-review-actor-type": "human",
    "code-review-approval-source": "explicit-user",
    "code-review-summary": "No, in automatico",
  }, "pull_request");
  assert.equal(choice.source, "explicit-user");
  assert.equal(choice.user_words, "No, in automatico");
  const fromStanding = codeReviewChoiceFromOptions(ctx, {}, "pull_request", {
    standing: { id: "SA-1", proposal: { destination: { code_review: "required" } } },
  });
  assert.equal(fromStanding.source, "standing-approval");
  assert.equal(fromStanding.decision, "required");
  assert.throws(() => codeReviewChoiceFromOptions(ctx, {}, "pull_request", {
    standing: { id: "SA-OLD", proposal: { destination: {} } },
  }), /needs the user's answer/u);
});

test("the recorded choice is validated before it is hashed into the profile", () => {
  assert.deepEqual(normalizeCodeReviewDecision(userChoice("required")), userChoice("required"));
  assert.throws(() => normalizeCodeReviewDecision({ ...userChoice("maybe") }), /decision must be one of/u);
  assert.throws(() => normalizeCodeReviewDecision({ ...userChoice("required"), user_words: "" }), /user_words/u);
  assert.throws(() => normalizeCodeReviewDecision({ ...userChoice("required"), source: "agent" }), /source must be one of/u);
});

test("a standing approval covers only deliveries whose review choice matches its bound", () => {
  const bound = { id: "SA-1", destination: { code_review: "not-required" } };
  assert.deepEqual(standingCodeReviewReasons(bound, userChoice("not-required")), []);
  assert.match(standingCodeReviewReasons(bound, userChoice("required"))[0], /covers only pull requests with code review not-required/u);
  const legacy = { id: "SA-OLD", destination: {} };
  assert.deepEqual(standingCodeReviewReasons(legacy, userChoice("required")), []);
  assert.match(
    standingCodeReviewReasons(legacy, { decision: "required", source: "standing-approval", standing_approval_id: "SA-OLD" })[0],
    /records no code review choice/u,
  );
  assert.match(
    standingCodeReviewReasons(bound, { decision: "not-required", source: "standing-approval", standing_approval_id: "SA-2" })[0],
    /comes from standing approval SA-2/u,
  );
});
