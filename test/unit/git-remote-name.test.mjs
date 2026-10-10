import "../helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { safeGitRemoteName } from "../../lib/engine/git-remote-name.mjs";
import { remoteBaseRef } from "../../lib/host-hooks/keep-going.mjs";

function repo(remotes) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remote-name-"));
  spawnSync("git", ["init", "-q", root]);
  for (const name of remotes) spawnSync("git", ["-C", root, "remote", "add", name, root]);
  return root;
}

test("a hostile remote name is rejected and runs nothing", () => {
  const root = repo(["origin"]);
  const marker = path.join(root, "pwned");
  const hostile = `--upload-pack=touch ${marker}`;
  const picked = safeGitRemoteName(hostile, root);
  assert.equal(picked.remote, "origin");
  assert.equal(picked.fallback, true);
  assert.match(picked.warning, /not safe/u);
  spawnSync("git", ["-C", root, "fetch", "--quiet", picked.remote]);
  assert.equal(fs.existsSync(marker), false);
});

test("a hostile remote with no origin is skipped", () => {
  const root = repo(["upstream"]);
  const picked = safeGitRemoteName("--upload-pack=touch /tmp/x", root);
  assert.equal(picked.remote, null);
  assert.ok(picked.warning);
});

test("a well-formed remote that is not configured falls back to origin", () => {
  const root = repo(["origin"]);
  assert.equal(safeGitRemoteName("fork", root).remote, "origin");
});

test("a configured remote is used as is; missing value means origin", () => {
  const root = repo(["origin", "team/up-1"]);
  assert.deepEqual(safeGitRemoteName("team/up-1", root), { remote: "team/up-1", fallback: false, warning: null });
  assert.equal(safeGitRemoteName(undefined, root).remote, "origin");
  assert.equal(safeGitRemoteName("a..b", root).fallback, true);
  assert.equal(safeGitRemoteName(42, root).remote, "origin");
});

test("keep-going base ref reader ignores a hostile config remote", () => {
  const root = repo(["origin"]);
  fs.mkdirSync(path.join(root, ".sdlc"));
  fs.writeFileSync(path.join(root, ".sdlc", "config.json"), JSON.stringify({ orchestration_policy: { coordination: { remote: "--upload-pack=x" } } }));
  assert.equal(remoteBaseRef(root), null);
});
