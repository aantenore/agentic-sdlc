// Keeps test fixtures away from every real repository and remote. Importing
// this module first in a test file makes the whole process safe, however the
// file is started (`node --test file`, the suite runner, an IDE):
//   - records are never published automatically (AGENTIC_SDLC_AUTO_PUBLISH=off);
//   - git never looks above the temp directory for a repository;
//   - git config comes from a private file whose pre-push hook refuses any
//     non-local remote, so a fixture that names a real URL still cannot push.
// Fixtures live in createFixtureDir() and use createBareOrigin() for a remote.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const ISOLATION_MARKER_ENV = "AGENTIC_SDLC_TEST_ISOLATION";
export const NON_LOCAL_REMOTE = /^(?:[a-z][a-z0-9+.-]*:\/\/|[^/\\\s]+@[^/\\\s]+:)/iu;
const HOOK = `#!/bin/sh
# Test isolation: fixtures may only push to local paths.
case "$2" in
  http://*|https://*|ssh://*|git://*|git+ssh://*|*@*:*)
    echo "test isolation: push to non-local remote '$2' refused" >&2
    exit 1
    ;;
esac
exit 0
`;

export function tempRoot() {
  return fs.realpathSync(os.tmpdir());
}

/** Whether `dir` or any directory above it holds a .git entry. */
export function insideGitRepository(dir) {
  let current = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(current, ".git"))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/** Builds the environment values that isolate git and publication. */
export function isolationEnv(baseDir = tempRoot()) {
  const dir = fs.mkdtempSync(path.join(baseDir, "sdlc-test-isolation-"));
  const hooks = path.join(dir, "hooks");
  fs.mkdirSync(hooks);
  fs.writeFileSync(path.join(hooks, "pre-push"), HOOK, { mode: 0o755 });
  const config = path.join(dir, "gitconfig");
  fs.writeFileSync(config, `[core]\n\thooksPath = ${hooks.replace(/\\/gu, "/")}\n[init]\n\tdefaultBranch = main\n`, "utf8");
  return {
    dir,
    env: {
      AGENTIC_SDLC_AUTO_PUBLISH: "off",
      GIT_CEILING_DIRECTORIES: tempRoot(),
      GIT_CONFIG_GLOBAL: config,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      [ISOLATION_MARKER_ENV]: "1",
    },
  };
}

/** Applies the isolation to this process (and so to every child it starts). Idempotent. */
export function applyTestIsolation() {
  if (process.env[ISOLATION_MARKER_ENV] === "1" && process.env.GIT_CONFIG_GLOBAL && fs.existsSync(process.env.GIT_CONFIG_GLOBAL)) return;
  const { dir, env } = isolationEnv();
  Object.assign(process.env, env);
  process.once("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
}

/** A new empty directory under the OS temp directory, outside any git repository. */
export function createFixtureDir(prefix = "sdlc-fixture-") {
  applyTestIsolation();
  const dir = fs.mkdtempSync(path.join(tempRoot(), prefix));
  if (insideGitRepository(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`Test fixtures must live outside any git repository; ${tempRoot()} is inside one.`);
  }
  return dir;
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: process.env });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/**
 * Creates a bare repository next to the fixture and points `remote` at it.
 * With `urlAlias` the remote keeps that fetch URL (for providers that match
 * the repository name) while every push goes to the local bare repository.
 */
export function createBareOrigin(project, { remote = "origin", urlAlias = null } = {}) {
  applyTestIsolation();
  const bare = fs.mkdtempSync(path.join(tempRoot(), "sdlc-fixture-origin-"));
  git(bare, ["init", "--quiet", "--bare", "--initial-branch=main"]);
  git(project, ["remote", "add", remote, urlAlias ?? bare]);
  if (urlAlias) git(project, ["remote", "set-url", "--push", remote, bare]);
  return bare;
}

/** Throws when any push URL of the fixture points at a non-local remote. */
export function assertNoRealRemote(project) {
  const urls = git(project, ["remote", "-v"]).split(/\r?\n/u).filter((line) => /\(push\)$/u.test(line));
  for (const line of urls) {
    const url = line.split(/\s+/u)[1] ?? "";
    if (NON_LOCAL_REMOTE.test(url)) throw new Error(`Fixture ${project} pushes to a non-local remote: ${line}`);
  }
}

applyTestIsolation();
