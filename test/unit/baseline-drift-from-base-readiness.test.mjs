import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { stableContextSourceSnapshot } from "../../lib/engine/storage.mjs";
import { validateBaselineSourceHashes } from "../../lib/engine/story.mjs";

function git(root, ...args) {
  return childProcess.execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function commit(root, files, message) {
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
}

test("baseline readiness accepts sources changed on the base branch, never local changes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baseline-readiness-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.invalid");
  git(root, "config", "user.name", "t");
  commit(root, { "app/page.tsx": "1\n", "app/other.tsx": "1\n" }, "base");
  const context = { root, sdlcRoot: path.join(root, ".sdlc"), config: {} };
  const hash = (file) => stableContextSourceSnapshot(context, file, "test").sha256;
  const baseline = {
    id: "BASELINE-R1",
    source_paths: ["app/page.tsx", "app/other.tsx"],
    source_hashes: { "app/page.tsx": hash("app/page.tsx"), "app/other.tsx": hash("app/other.tsx") },
  };
  // Another story changed page.tsx on main; the story branch is synced to it.
  commit(root, { "app/page.tsx": "2\n" }, "other story merged");
  git(root, "checkout", "-q", "-b", "feature/ST-1");
  const profile = { pull_request_target: { base_branch: "main" } };
  const issues = (options = {}) => validateBaselineSourceHashes(context, baseline, "baseline BASELINE-R1", { collectOnly: true, ...options });

  assert.equal(issues().length, 1, "without a base branch the drift still blocks");
  assert.deepEqual(issues({ deliveryProfile: profile }), []);

  // A local edit (uncommitted, or committed only here) still blocks.
  fs.writeFileSync(path.join(root, "app/page.tsx"), "local\n");
  assert.match(issues({ deliveryProfile: profile }).join("\n"), /app\/page\.tsx is missing or changed outside its approved pre-change snapshot/u);
  commit(root, {}, "local page edit");
  commit(root, { "app/other.tsx": "local\n" }, "local work");
  assert.equal(issues({ deliveryProfile: profile }).length, 2);
});
