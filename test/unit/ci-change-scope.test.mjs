import assert from "node:assert/strict";
import test from "node:test";

import {
  CHANGE_SCOPE_POLICY,
  decideDocsOnly,
  isDocsOnlyChange,
  isDocsOnlyPath,
} from "../../lib/ci/change-scope.mjs";


const BASE = "a".repeat(40);


test("only top-level and docs/ Markdown is documentation", () => {
  for (const path of ["README.md", "AGENTS.md", "docs/architecture.md", "docs/guides/deep/setup.md"]) {
    assert.equal(isDocsOnlyPath(path), true, path);
  }
  for (const path of [
    "skills/agentic-sdlc/SKILL.md",
    "commands/deliver.md",
    "skills/x.md",
    "templates/prompt.md",
    ".sdlc/README.md",
    ".github/PULL_REQUEST_TEMPLATE.md",
    "lib/runtime/readme.md",
    "docs/diagram.png",
    "docs/script.mjs",
    "README.mdx",
    "README.md.bak",
    "package.json",
    "scripts/run-test-suite.mjs",
    ".github/workflows/ci.yml",
    "docs/../lib/x.md",
    "/README.md",
    "docs\\x.md",
    "docs//x.md",
    "",
    undefined,
  ]) {
    assert.equal(isDocsOnlyPath(path), false, String(path));
  }
});


test("one non-documentation file anywhere in the change set disables the skip", () => {
  assert.equal(isDocsOnlyChange(["README.md", "docs/a.md"]), true);
  assert.equal(isDocsOnlyChange(["README.md", "docs/a.md", "package.json"]), false);
  assert.equal(isDocsOnlyChange(["README.md", "skills/a/SKILL.md"]), false);
  assert.equal(isDocsOnlyChange(["README.md", "commands/a.md"]), false);
  assert.equal(isDocsOnlyChange([]), false);
  assert.equal(isDocsOnlyChange(undefined), false);
  assert.deepEqual(CHANGE_SCOPE_POLICY.protectedDirectories, ["skills/", "commands/"]);
});


function gitReturning(output, calls = []) {
  return (args) => {
    calls.push(args);
    return args[0] === "diff" ? output : "";
  };
}


test("pull requests compare against the base commit and may skip on a Markdown-only diff", () => {
  const calls = [];
  const decision = decideDocsOnly({
    env: { CI_EVENT_NAME: "pull_request", CI_BASE_SHA: BASE, CI_BEFORE_SHA: "" },
    git: gitReturning("README.md\0docs/a.md\0", calls),
  });
  assert.equal(decision.docsOnly, true);
  assert.deepEqual(calls[0], ["fetch", "--no-tags", "--depth=1", "origin", BASE]);
  assert.deepEqual(calls[1], ["diff", "--name-only", "--no-renames", "-z", BASE, "HEAD"]);
});


test("pushes compare against the previous tip of the pushed range", () => {
  const calls = [];
  const decision = decideDocsOnly({
    env: { CI_EVENT_NAME: "push", CI_BEFORE_SHA: BASE, CI_BASE_SHA: "" },
    git: gitReturning("docs/a.md\0", calls),
  });
  assert.equal(decision.docsOnly, true);
  assert.equal(calls[0][4], BASE);
});


test("schedule and manual runs never skip, even with a Markdown-only diff", () => {
  for (const event of ["schedule", "workflow_dispatch", "release", undefined]) {
    const decision = decideDocsOnly({
      env: { CI_EVENT_NAME: event, CI_BASE_SHA: BASE, CI_BEFORE_SHA: BASE },
      git: () => { throw new Error("must not run git"); },
    });
    assert.equal(decision.docsOnly, false, String(event));
  }
});


test("a code, skill, or command change runs the full suite", () => {
  for (const diff of ["README.md\0lib/x.mjs\0", "skills/a/SKILL.md\0", "docs/a.md\0commands/b.md\0", ""]) {
    const decision = decideDocsOnly({
      env: { CI_EVENT_NAME: "pull_request", CI_BASE_SHA: BASE },
      git: gitReturning(diff),
    });
    assert.equal(decision.docsOnly, false, JSON.stringify(diff));
  }
});


test("anything that prevents computing the diff fails closed", () => {
  const throwing = () => { throw new Error("fetch failed"); };
  for (const env of [
    { CI_EVENT_NAME: "pull_request", CI_BASE_SHA: BASE },
    { CI_EVENT_NAME: "pull_request", CI_BASE_SHA: "" },
    { CI_EVENT_NAME: "pull_request" },
    { CI_EVENT_NAME: "pull_request", CI_BASE_SHA: "main" },
    { CI_EVENT_NAME: "push", CI_BEFORE_SHA: "0".repeat(40) },
    { CI_EVENT_NAME: "push", CI_BEFORE_SHA: BASE.toUpperCase() },
  ]) {
    const decision = decideDocsOnly({ env, git: env.CI_BASE_SHA === BASE ? throwing : gitReturning("README.md\0") });
    assert.equal(decision.docsOnly, false, JSON.stringify(env));
  }
});
