import assert from "node:assert/strict";
import test from "node:test";

import { claimMadeOnThisComputer } from "../../lib/engine/story-claim-shared.mjs";

const me = { host: "pc-aaaaaa", email: "Me@Example.com" };
const claimOf = (host, email) => ({ audit: { run: host ? { host } : {}, git: { user: { email } } } });

test("same host counts as this computer, whatever the e-mail", () => {
  assert.equal(claimMadeOnThisComputer(claimOf("pc-aaaaaa", "other@example.com"), me), true);
});

test("a different host never counts, even with the same e-mail", () => {
  assert.equal(claimMadeOnThisComputer(claimOf("pc-bbbbbb", "me@example.com"), me), false);
});

test("a claim without host falls back to the author e-mail, case-insensitively", () => {
  assert.equal(claimMadeOnThisComputer(claimOf(null, "me@example.com"), me), true);
  assert.equal(claimMadeOnThisComputer(claimOf(null, "other@example.com"), me), false);
});

test("without any identity to compare the claim is not this computer's", () => {
  assert.equal(claimMadeOnThisComputer(claimOf(null, null), me), false);
  assert.equal(claimMadeOnThisComputer(claimOf("pc-aaaaaa", null), {}), false);
  assert.equal(claimMadeOnThisComputer(claimOf(null, "me@example.com"), {}), false);
});
