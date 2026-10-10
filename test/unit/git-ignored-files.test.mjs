import "../helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  gitIgnoredUntrackedPaths,
  gitVisibleProjectFiles,
} from "../../lib/engine/git-ignored-files.mjs";
import { workflowFinalIgnoredCertifiedPaths } from "../../lib/lifecycle/workflow.mjs";

function git(root, args, env = {}) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
  assert.equal(result.status, 0, result.stderr);
}

function repository(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-sdlc-git-ignored-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relativePath, content = relativePath) => {
    fs.mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true });
    fs.writeFileSync(path.join(root, relativePath), content);
  };
  git(root, ["init", "--quiet"]);
  return { root, write, context: { root, config: {} } };
}

test("Git ignore rules from nested files, info/exclude, and core.excludesFile all apply", (t) => {
  const project = repository(t);
  const excludes = path.join(project.root, "..", `${path.basename(project.root)}-excludes`);
  fs.writeFileSync(excludes, "*.local\n");
  t.after(() => fs.rmSync(excludes, { force: true }));
  git(project.root, ["config", "core.excludesFile", excludes]);
  project.write("apps/web/.gitignore", ".next/\nnext-env.d.ts\n");
  project.write("apps/web/page.tsx");
  project.write("apps/web/next-env.d.ts");
  project.write("apps/web/.next/BUILD_ID");
  project.write("apps/web/cache/data.json");
  project.write("apps/web/settings.local");
  project.write("apps/web/tracked.local");
  fs.appendFileSync(path.join(project.root, ".git", "info", "exclude"), "apps/web/cache/\n");
  git(project.root, ["add", "-f", "apps/web/tracked.local"]);

  const visible = gitVisibleProjectFiles(project.context);
  assert.deepEqual([...visible.files].sort(), ["apps/web/.gitignore", "apps/web/page.tsx", "apps/web/tracked.local"]);
  assert.deepEqual([...visible.directories].sort(), [".", "apps", "apps/web"]);

  const ignored = gitIgnoredUntrackedPaths(project.context, [
    "apps/web/page.tsx",
    "apps/web/next-env.d.ts",
    "apps/web/.next/BUILD_ID",
    "apps/web/cache/data.json",
    "apps/web/settings.local",
    "apps/web/tracked.local",
  ]);
  assert.deepEqual([...ignored].sort(), [
    "apps/web/.next/BUILD_ID",
    "apps/web/cache/data.json",
    "apps/web/next-env.d.ts",
    "apps/web/settings.local",
  ]);

  const include = { root: project.root, config: { baseline_policy: { ignored_files: "include" } } };
  assert.equal(gitVisibleProjectFiles(include), null);
  assert.equal(gitIgnoredUntrackedPaths(include, ["apps/web/next-env.d.ts"]).size, 0);
});

test("only the requested paths are listed", (t) => {
  const project = repository(t);
  project.write("src/app.js");
  project.write("other/notes.txt");
  git(project.root, ["add", "src/app.js"]);

  const visible = gitVisibleProjectFiles(project.context, ["src", path.join(project.root, "src")]);
  assert.deepEqual([...visible.files], ["src/app.js"]);
  assert.deepEqual([...gitVisibleProjectFiles(project.context, ["../elsewhere"]).files].sort(), ["other/notes.txt", "src/app.js"]);
});

test("outside a Git worktree nothing is ignored", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-sdlc-no-git-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const context = { root, config: {} };
  assert.equal(gitVisibleProjectFiles(context), null);
  assert.equal(gitIgnoredUntrackedPaths(context, ["a.txt"]).size, 0);
});

test("an earlier certification sets aside only untracked files Git now ignores", () => {
  const missing = { present: false };
  const present = { present: true };
  const certified = {
    scoped_changes: [
      { path: "apps/web/.next/BUILD_ID", head: missing, index: missing },
      { path: "apps/web/tracked.js", head: present, index: present },
      { path: "apps/web/page.tsx", head: missing, index: missing },
    ],
  };
  const observed = {
    scoped_changes: [{ path: "apps/web/page.tsx" }],
    ignored_certified_paths: ["apps/web/.next/BUILD_ID", "apps/web/tracked.js", "apps/web/page.tsx"],
  };
  assert.deepEqual(workflowFinalIgnoredCertifiedPaths(certified, observed), ["apps/web/.next/BUILD_ID"]);
  assert.deepEqual(workflowFinalIgnoredCertifiedPaths(certified, { scoped_changes: [] }), []);
});
