import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { implementationScopeWarnings } from "../../lib/cli/next-command.mjs";
import { deliveryActionAccess, pathsOutsideWriteScope, storyScopeWarningLines } from "../../lib/engine/story-scope.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = path.join(ROOT, "bin", "agentic-sdlc.mjs");
const TEMPORARY_DIRECTORIES = new Set();

after(() => {
  for (const directory of TEMPORARY_DIRECTORIES) fs.rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(label) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `agentic-sdlc-scope-${label}-`));
  TEMPORARY_DIRECTORIES.add(directory);
  return directory;
}

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: "utf8", env: process.env, timeout: 60_000 });
}

function mustRun(args) {
  const result = run(args);
  assert.equal(result.status, 0, `${args.join(" ")}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result;
}

function projectWithStory(label) {
  const project = temporaryDirectory(label);
  mustRun(["init", "--root", project, "--project-name", `Scope ${label}`]);
  mustRun([
    "story", "create", "--root", project, "--id", "ST-001", "--title", "Booking",
    "--phase", "validation", "--acceptance", "The suite passes", "--no-derived-verification",
  ]);
  return project;
}

test("files outside the profile or a requirement scope are listed with the reason", () => {
  const result = pathsOutsideWriteScope(
    ["src/a.ts", "docs/b.md", "scripts/c.sh", ".sdlc/stories/ST-1/claim.json"],
    {
      profilePaths: ["src", "docs", ".sdlc/stories"],
      requirements: [{ id: "REQ-1", paths: ["src"] }],
      isStoryRecord: (filePath) => filePath.startsWith(".sdlc/"),
    },
  );
  assert.deepEqual(result.map((item) => item.path), ["docs/b.md", "scripts/c.sh"]);
  assert.deepEqual(result[0].outside, ["requirement REQ-1"]);
  assert.deepEqual(result[1].outside, ["delivery profile", "requirement REQ-1"]);
  const lines = storyScopeWarningLines({ story_id: "ST-1", allowed_write_paths: ["src"], out_of_scope: result });
  assert.match(lines.join("\n"), /scripts\/c\.sh/u);
  assert.match(lines.join("\n"), /move these files inside an approved path/u);
  assert.deepEqual(storyScopeWarningLines({ out_of_scope: [] }), []);
});

test("a path covered by every scope is not reported", () => {
  assert.deepEqual(pathsOutsideWriteScope(["src/x/y.ts"], { profilePaths: ["src"], requirements: [{ id: "R", paths: ["src/x"] }] }), []);
});

test("next only checks claims in implementation", () => {
  const idle = [{ storyId: "ST-1", next: { phase: "design" } }, { storyId: "ST-2", next: { phase: "implementation" }, waiting: "claim parked" }];
  assert.deepEqual(implementationScopeWarnings(os.tmpdir(), idle), []);
  assert.deepEqual(implementationScopeWarnings(os.tmpdir(), []), []);
});

test("story scope check reports a story without delivery profile as not applicable", () => {
  const project = projectWithStory("check");
  const result = JSON.parse(mustRun(["story", "scope", "check", "--root", project, "--id", "ST-001", "--json"]).stdout);
  assert.equal(result.status, "not_applicable");
  assert.equal(run(["story", "scope", "check", "--root", project, "--id", "ST-404"]).status, 1);
});

test("test record names the destination for evidence outside the project, or copies it", () => {
  const project = projectWithStory("evidence");
  const outside = path.join(temporaryDirectory("outside"), "run.log");
  fs.writeFileSync(outside, "ok 1\n");
  const base = [
    "test", "record", "--root", project, "--story", "ST-001", "--command", '["npm","test"]',
    "--exit-code", "0", "--passed", "1", "--evidence", outside,
  ];
  const refused = run(base);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr + refused.stdout, /\.sdlc\/tests\/ST-001-run\.log/u);
  assert.match(refused.stderr + refused.stdout, /--copy-evidence/u);
  assert.equal(fs.existsSync(path.join(project, ".sdlc", "tests", "ST-001-run.log")), false);

  const recorded = JSON.parse(mustRun([...base, "--copy-evidence", "--json"]).stdout);
  assert.equal(fs.readFileSync(path.join(project, ".sdlc", "tests", "ST-001-run.log"), "utf8"), "ok 1\n");
  assert.match(JSON.stringify(recorded), /\.sdlc\/tests\/ST-001-run\.log/u);
});

test("delivery actions the chain needs are checked against the profile, merge_allowed included", () => {
  const profile = (target, forbidden = []) => ({
    delivery_kind: "pull_request",
    constraints: { forbidden_actions: forbidden },
    pull_request_target: { mode: "new", allowed_actions: ["git.push", "pull_request.create", "pull_request.merge"], merge_allowed: true, ...target },
  });
  assert.ok(deliveryActionAccess(profile({})).every((item) => item.allowed));
  const noMerge = deliveryActionAccess(profile({ merge_allowed: false })).find((item) => !item.allowed);
  assert.deepEqual([noMerge.action, noMerge.reason], ["pull_request.merge", "merge_allowed is false"]);
  const noPush = deliveryActionAccess(profile({ allowed_actions: ["pull_request.create"] })).filter((item) => !item.allowed).map((item) => item.action);
  assert.deepEqual(noPush, ["git.push", "pull_request.merge"]);
  assert.equal(deliveryActionAccess(profile({ mode: "existing", allowed_actions: ["git.push", "pull_request.merge"] })).every((item) => item.allowed), true);
  assert.equal(deliveryActionAccess(profile({}, ["git.push"])).find((item) => item.action === "git.push").allowed, false);
  assert.deepEqual(deliveryActionAccess({ delivery_kind: "local_release" }), []);
  const lines = storyScopeWarningLines({ story_id: "ST-1", delivery_profile_id: "AUT-1", out_of_scope: [], blocked_actions: [{ remedy: "pull_request.merge: x --merge-allowed" }] });
  assert.match(lines.join("\n"), /--merge-allowed/u);
});
