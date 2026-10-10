import "../helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  buildCompletion,
  completionCandidates,
  generateCompletion,
  SUPPORTED_SHELLS,
} from "../../lib/cli/completion.mjs";

test("completion output is deterministic and content-addressed for every supported shell", () => {
  for (const shell of SUPPORTED_SHELLS) {
    const first = buildCompletion(shell);
    const second = buildCompletion(shell);
    assert.deepEqual(first, second);
    assert.equal(first.shell, shell);
    assert.equal(first.sha256, createHash("sha256").update(first.script, "utf8").digest("hex"));
    assert.match(first.script, /agentic-sdlc/u);
    assert.match(first.script, /autonomy/u);
    assert.match(first.script, /--cli-preset/u);
  }
});

test("generated completion is static and never evaluates or launches commands", () => {
  const forbidden = /(?:\beval\b|\bexec\b|Invoke-Expression|Start-Process|child_process|spawn\s*\(|`[^`]*`)/iu;
  for (const shell of SUPPORTED_SHELLS) {
    assert.doesNotMatch(generateCompletion(shell), forbidden, shell);
  }
});

test("completion JSON is a stable single envelope", () => {
  const first = generateCompletion("pwsh", { json: true });
  const second = generateCompletion("powershell", { json: true });
  assert.equal(first, second);
  const parsed = JSON.parse(first);
  assert.deepEqual(Object.keys(parsed), ["binary", "schema_version", "script", "sha256", "shell"]);
  assert.equal(parsed.shell, "powershell");
});

test("completion rejects unsupported shells and injectable binary names", () => {
  assert.throws(() => generateCompletion("tcsh"), /Unsupported shell/u);
  assert.throws(() => generateCompletion("bash", { binary: "agentic-sdlc; touch unsafe" }), /only letters/u);
});

test("completion follows the command hierarchy and never leaks leaf commands at the root", () => {
  const root = completionCandidates();
  assert.equal(root.includes("autonomy"), true);
  assert.equal(root.includes("status"), true);
  assert.equal(root.includes("approve"), false);
  assert.equal(root.includes("propose"), false);
  assert.equal(root.includes("action"), false);
  assert.equal(root.includes("en"), false);

  const delivery = completionCandidates(["autonomy", "delivery"]);
  assert.equal(delivery.includes("approve"), true);
  assert.equal(delivery.includes("propose"), true);
  assert.equal(delivery.includes("action"), true);
  assert.equal(delivery.includes("baseline"), false);
});

test("completion offers the current command options and bounded option values", () => {
  const propose = completionCandidates(["autonomy", "delivery", "propose"]);
  for (const flag of ["--id", "--delivery", "--kind", "--contract", "--repository", "--target-root", "--write-path"]) {
    assert.equal(propose.includes(flag), true, flag);
  }
  assert.equal(propose.includes("approve"), false);

  assert.deepEqual(
    completionCandidates(["autonomy", "delivery", "propose", "--kind"]),
    ["local_release", "pull_request"],
  );
  assert.deepEqual(
    completionCandidates(["autonomy", "delivery", "action", "--action"], { current: "git." }),
    ["git.commit", "git.push"],
  );
  assert.deepEqual(
    completionCandidates(["autonomy", "delivery", "action", "--outcome"]),
    ["failed", "passed"],
  );
  assert.deepEqual(
    completionCandidates(["trace", "append", "--outcome"]),
    ["blocked", "failed", "passed", "ready", "skipped"],
  );
  assert.deepEqual(completionCandidates(["status"], { current: "--loc" }), ["--locale"]);
  assert.deepEqual(completionCandidates([], { current: "--locale=i" }), ["--locale=it"]);
});

test("completion keeps capability and delivery profile selectors distinct", () => {
  for (const tokens of [["capability", "profile", "status"], ["capability", "recommend"], ["capability", "status"]]) {
    const candidates = completionCandidates(tokens);
    assert.equal(candidates.includes("--profile"), true, tokens.join(" "));
    assert.equal(candidates.includes("--delivery-profile"), false, tokens.join(" "));
  }
  const contract = completionCandidates(["contract", "create"]);
  assert.equal(contract.includes("--delivery-profile"), true);
  assert.equal(contract.includes("--profile"), false);
});
