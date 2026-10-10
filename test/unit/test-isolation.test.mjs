import "../helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  assertNoRealRemote,
  createBareOrigin,
  createFixtureDir,
  insideGitRepository,
  isolationEnv,
  NON_LOCAL_REMOTE,
} from "../helpers/test-isolation.mjs";

function git(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8", env: process.env });
}

function fixtureRepository() {
  const project = createFixtureDir("sdlc-isolation-test-");
  assert.equal(git(project, ["init", "--quiet", "-b", "main"]).status, 0);
  git(project, ["config", "user.name", "Isolation"]);
  git(project, ["config", "user.email", "isolation@example.invalid"]);
  git(project, ["commit", "--allow-empty", "--quiet", "-m", "base"]);
  return project;
}

test("importing the helper turns automatic publication off and confines git to the temp directory", () => {
  assert.equal(process.env.AGENTIC_SDLC_AUTO_PUBLISH, "off");
  assert.ok(process.env.GIT_CEILING_DIRECTORIES);
  assert.ok(fs.existsSync(process.env.GIT_CONFIG_GLOBAL));
  assert.equal(isolationEnv().env.AGENTIC_SDLC_AUTO_PUBLISH, "off");
});

test("fixture directories are outside any git repository", () => {
  const project = createFixtureDir("sdlc-isolation-test-");
  assert.equal(insideGitRepository(project), false);
  assert.equal(git(project, ["rev-parse", "--show-toplevel"]).status !== 0, true);
  fs.rmSync(project, { recursive: true, force: true });
});

test("a fixture keeping a real URL still pushes only to its local bare repository", () => {
  const project = fixtureRepository();
  const bare = createBareOrigin(project, { urlAlias: "https://github.com/example/never-pushed.git" });
  assertNoRealRemote(project);
  assert.equal(git(project, ["push", "--quiet", "origin", "main"]).status, 0);
  assert.equal(git(bare, ["rev-parse", "--verify", "refs/heads/main"]).status, 0);
  fs.rmSync(project, { recursive: true, force: true });
  fs.rmSync(bare, { recursive: true, force: true });
});

test("the pre-push guard refuses any non-local remote and a fixture cannot authenticate", () => {
  const project = fixtureRepository();
  const hook = path.join(git(project, ["config", "core.hooksPath"]).stdout.trim(), "pre-push");
  assert.equal(spawnSync("sh", [hook, "origin", "https://github.com/example/never-pushed.git"], { encoding: "utf8" }).status, 1);
  assert.equal(spawnSync("sh", [hook, "origin", "git@github.com:example/never-pushed.git"], { encoding: "utf8" }).status, 1);
  assert.equal(spawnSync("sh", [hook, "origin", "/tmp/local.git"], { encoding: "utf8" }).status, 0);
  git(project, ["remote", "add", "origin", "https://github.com/example/never-pushed.git"]);
  assert.notEqual(git(project, ["push", "origin", "main"]).status, 0);
  assert.throws(() => assertNoRealRemote(project), /non-local remote/u);
  fs.rmSync(project, { recursive: true, force: true });
});

test("remote URL classification separates local paths from network remotes", () => {
  for (const url of ["https://github.com/a/b.git", "ssh://git@host/a.git", "git@github.com:a/b.git"]) assert.equal(NON_LOCAL_REMOTE.test(url), true, url);
  for (const url of ["/tmp/origin.git", "C:\\tmp\\origin.git", path.join("a", "b.git")]) assert.equal(NON_LOCAL_REMOTE.test(url), false, url);
});
