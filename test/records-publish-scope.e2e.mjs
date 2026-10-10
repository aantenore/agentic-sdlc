import "./helpers/test-isolation.mjs";

// A records publication only ever adds or updates the publishing story's own
// records (and the merged shared history) on top of the remote base tip of
// that moment: never code, never another story's records or evidence, never
// a deletion, whatever state the local copy of the base branch is in.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  assertRecordsCommitScope,
  buildRecordsCommit,
  RECORDS_SCOPE_ERROR,
  storyPublishPermission,
} from "../lib/engine/records-commit.mjs";
import { runGit } from "../lib/engine/shared-refs.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(repoRoot, "bin", "agentic-sdlc.mjs");
const tempPaths = new Set();
const STORY = "ST-PUB-001";
const OTHER = "ST-PUB-002";

after(() => {
  if (process.env.AGENTIC_SDLC_KEEP_TEST_TMP === "1") return;
  for (const entry of tempPaths) fs.rmSync(entry, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function tmpDirectory(name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `sdlc-publish-scope-${name}-`));
  tempPaths.add(directory);
  return directory;
}

function run(args) {
  const env = { ...process.env, AGENTIC_SDLC_MESSAGING_AUTO: "off" };
  for (const key of ["CI", "GITHUB_ACTIONS", "GITHUB_ACTOR", "CODEX_AGENT_NAME", "CODEX_THREAD_ID", "CODEX_USER_ID", "CLAUDECODE", "AGENTIC_SDLC_AGENT_HOST"]) delete env[key];
  return spawnSync(process.execPath, [bin, ...args], { cwd: repoRoot, encoding: "utf8", env, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
}

function mustRun(args) {
  const result = run(args);
  assert.equal(result.status, 0, `${args.join(" ")}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result;
}

function git(project, args) {
  const result = spawnSync("git", ["-C", project, ...args], { encoding: "utf8", timeout: 60_000 });
  assert.equal(result.status, 0, `git ${args.join(" ")}\n${result.stderr}`);
  return result.stdout.trim();
}

function write(project, file, text) {
  fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
  fs.writeFileSync(path.join(project, file), text);
}

function configureClone(project, name) {
  git(project, ["config", "user.email", `${name}@example.invalid`]);
  git(project, ["config", "user.name", name]);
  git(project, ["config", "core.autocrlf", "false"]);
}

function twoComputers(name) {
  const root = tmpDirectory(name);
  const remote = path.join(root, "remote.git");
  git(root, ["init", "--quiet", "--bare", "-b", "main", remote]);
  const first = path.join(root, "first");
  fs.mkdirSync(first);
  mustRun(["init", "--root", first, "--project-name", "Publish scope"]);
  git(first, ["init", "--quiet", "-b", "main"]);
  configureClone(first, "first");
  for (const id of [STORY, OTHER]) {
    mustRun(["story", "create", "--no-derived-verification", "--root", first, "--id", id, "--title", `Story ${id}`, "--phase", "implementation", "--status", "ready", "--acceptance", "Records stay scoped."]);
  }
  write(first, "src/app.txt", "v1\n");
  git(first, ["add", "-A"]);
  git(first, ["commit", "--quiet", "-m", "Start"]);
  git(first, ["remote", "add", "origin", remote]);
  git(first, ["push", "--quiet", "-u", "origin", "main"]);
  git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  const second = path.join(root, "second");
  git(root, ["clone", "--quiet", remote, second]);
  configureClone(second, "second");
  git(second, ["checkout", "--quiet", "-b", `feature/${STORY}`]);
  return { root, remote, first, second };
}

// The base branch moves on with code, another story's records and evidence the second computer never fetched.
function advanceBase(first) {
  write(first, "src/app.txt", "v2\n");
  write(first, "src/new-feature.txt", "new\n");
  write(first, `.sdlc/stories/${OTHER}/closure.json`, "{\"other\":true}\n");
  write(first, ".sdlc/autonomy/actions/AUT-ACT-OTHER.json", "{\"story\":\"other\"}\n");
  write(first, `evidence/${OTHER}.md`, "other evidence\n");
  git(first, ["add", "-A"]);
  git(first, ["commit", "--quiet", "-m", "Base moves on"]);
  git(first, ["push", "--quiet"]);
  return git(first, ["rev-parse", "HEAD"]);
}

function autoPublish(project, env = {}) {
  const script = `
    import { buildContext } from ${JSON.stringify(path.join(repoRoot, "lib/engine/common.mjs"))};
    import { autoPublishStoryRecords } from ${JSON.stringify(path.join(repoRoot, "lib/engine/story-sync.mjs"))};
    const context = buildContext({ root: ${JSON.stringify(project)} });
    const result = await autoPublishStoryRecords(context, { storyId: ${JSON.stringify(STORY)}, event: "publish-records" });
    console.log(JSON.stringify(result));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: repoRoot, encoding: "utf8", timeout: 60_000,
    env: { ...process.env, AGENTIC_SDLC_MESSAGING_AUTO: "off", AGENTIC_SDLC_AUTO_PUBLISH: "on", ...env },
  });
  assert.equal(result.status, 0, result.stderr);
  return { ...JSON.parse(result.stdout.trim().split("\n").at(-1)), stderr: result.stderr };
}

function changes(project, from, to) {
  return git(project, ["diff-tree", "-r", "--no-renames", "--name-status", from, to]).split("\n").filter(Boolean)
    .map((line) => line.split("\t"));
}

test("a stale local base branch: the publication builds on the fresh remote tip and only adds the story's records", () => {
  const { remote, first, second } = twoComputers("stale");
  write(second, `.sdlc/stories/${STORY}/final.json`, "{}\n");
  write(second, `evidence/${STORY}.md`, "own evidence\n");
  write(second, "src/app.txt", "local edit that must never travel\n");
  const staleTip = git(second, ["rev-parse", "refs/remotes/origin/main"]);
  const freshTip = advanceBase(first);
  assert.notEqual(staleTip, freshTip);

  // The shared-fetch marker says "already fetched": the publication must fetch anyway.
  const published = autoPublish(second, { AGENTIC_SDLC_FETCHED_REMOTES: "origin" });
  assert.equal(published.status, "published", published.stderr);
  // Built on the fresh tip at once, not after a refused push.
  assert.equal(published.attempt, 1);
  const tip = git(remote, ["rev-parse", "refs/heads/main"]);
  assert.equal(tip, published.commit);
  assert.equal(git(remote, ["rev-parse", `${tip}^1`]), freshTip);
  const diff = changes(remote, freshTip, tip);
  assert.ok(diff.length > 0);
  for (const [status, file] of diff) {
    assert.ok(status === "A" || status === "M", `${status} ${file}`);
    assert.ok(file.startsWith(".sdlc/"), file);
    assert.ok(!file.includes(OTHER), file);
  }
  assert.ok(diff.some(([, file]) => file === `.sdlc/stories/${STORY}/final.json`));
  // Everything the base gained is still there, untouched.
  for (const file of ["src/new-feature.txt", `.sdlc/stories/${OTHER}/closure.json`, ".sdlc/autonomy/actions/AUT-ACT-OTHER.json", `evidence/${OTHER}.md`]) {
    assert.equal(git(remote, ["cat-file", "-t", `${tip}:${file}`]), "blob", file);
  }
  assert.equal(git(remote, ["show", `${tip}:src/app.txt`]), "v2");
});

test("a commit built from a stale tree on top of the fresh tip is refused before any push", () => {
  const { first, second } = twoComputers("race");
  const staleTip = git(second, ["rev-parse", "refs/remotes/origin/main"]);
  const freshTip = advanceBase(first);
  git(second, ["fetch", "--quiet", "origin"]);
  write(second, `.sdlc/stories/${STORY}/final.json`, "{}\n");
  const runner = (args, extra = {}) => runGit(second, args, { timeoutSeconds: 30, ...extra });
  const scratch = tmpDirectory("index");
  // The incident: tree read from the stale tip, parent taken from the fresh one.
  const stale = buildRecordsCommit(runner, { baseSha: staleTip, files: [`.sdlc/stories/${STORY}/final.json`], message: "stale", indexFile: path.join(scratch, "index") });
  const mixed = git(second, ["commit-tree", stale.tree, "-p", freshTip, "-m", "mixed"]);
  const permission = (file) => storyPublishPermission(file, { sdlcFolder: ".sdlc", storyId: STORY, storyIds: [STORY, OTHER] });
  assert.throws(
    () => assertRecordsCommitScope(runner, { baseSha: freshTip, commit: mixed, permission, label: "test" }),
    (error) => error.errorCode === RECORDS_SCOPE_ERROR && /deletes src\/new-feature\.txt/u.test(error.message) && /Nothing was pushed/u.test(error.message),
  );
  // Built on the stale tip: refused for its parent, whatever its tree.
  assert.throws(
    () => assertRecordsCommitScope(runner, { baseSha: freshTip, commit: stale.commit, permission, label: "test" }),
    (error) => error.errorCode === RECORDS_SCOPE_ERROR && /not built on the base tip/u.test(error.message),
  );
});

test("a foreign path in a records commit is refused: code, another story's records, another story's evidence", () => {
  const { second } = twoComputers("foreign");
  const runner = (args, extra = {}) => runGit(second, args, { timeoutSeconds: 30, ...extra });
  const baseSha = git(second, ["rev-parse", "HEAD"]);
  const permission = (file) => storyPublishPermission(file, { sdlcFolder: ".sdlc", storyId: STORY, storyIds: [STORY, OTHER] });
  for (const foreign of ["src/injected.txt", `.sdlc/stories/${OTHER}/closure.json`, `evidence/${OTHER}.md`, ".sdlc/config.json"]) {
    write(second, foreign, "foreign\n");
    write(second, `.sdlc/stories/${STORY}/final.json`, "{}\n");
    const scratch = tmpDirectory("foreign-index");
    const built = buildRecordsCommit(runner, { baseSha, files: [`.sdlc/stories/${STORY}/final.json`, foreign], message: "x", indexFile: path.join(scratch, "index") });
    assert.throws(
      () => assertRecordsCommitScope(runner, { baseSha, commit: built.commit, permission, label: "test" }),
      (error) => error.errorCode === RECORDS_SCOPE_ERROR && error.message.includes(foreign),
      foreign,
    );
  }
  // A shared record the base already holds may be added, never rewritten.
  assert.equal(permission(".sdlc/autonomy/actions/AUT-ACT-NEW.json"), "add");
  assert.equal(permission(`.sdlc/stories/${STORY}/story.json`), "add-or-modify");
  assert.equal(permission(`evidence/${STORY}/test.log`), "add");
  assert.equal(permission(`src/${STORY}.ts`), null);
});

test("automatic publication never carries a code file the story's trace names", () => {
  const { remote, second } = twoComputers("trace-code");
  write(second, `.sdlc/stories/${STORY}/final.json`, "{}\n");
  write(second, `src/${STORY}.ts`, "export const leak = 1;\n");
  write(second, `evidence/${STORY}.md`, "own evidence\n");
  for (const file of [`src/${STORY}.ts`, `evidence/${STORY}.md`]) {
    mustRun(["trace", "append", "--root", second, "--story", STORY, "--type", "decision", "--summary", `Touched ${file}`, "--actor-type", "human", "--evidence", file]);
  }
  const base = git(remote, ["rev-parse", "refs/heads/main"]);
  const published = autoPublish(second);
  assert.equal(published.status, "published", published.stderr);
  assert.ok(!published.published.includes(`src/${STORY}.ts`), JSON.stringify(published));
  assert.ok(published.published.includes(`evidence/${STORY}.md`), JSON.stringify(published));
  const diff = changes(remote, base, published.commit);
  assert.ok(diff.every(([status, file]) => (status === "A" || status === "M") && !file.startsWith("src/")), JSON.stringify(diff));
});

test("publishing named record files refuses a path outside the records folder and pushes nothing", () => {
  const { remote, second } = twoComputers("files");
  write(second, "src/injected.txt", "x\n");
  const before = git(remote, ["rev-parse", "refs/heads/main"]);
  const script = `
    import { buildContext } from ${JSON.stringify(path.join(repoRoot, "lib/engine/common.mjs"))};
    import { publishRecordFilesToBase } from ${JSON.stringify(path.join(repoRoot, "lib/engine/story-sync.mjs"))};
    const context = buildContext({ root: ${JSON.stringify(second)} });
    try {
      publishRecordFilesToBase(context, { files: ["src/injected.txt"], message: "x", label: "Test publication" });
      console.log("published");
    } catch (error) {
      console.log(error.errorCode + " " + error.message);
    }
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: repoRoot, encoding: "utf8", timeout: 60_000, env: { ...process.env, AGENTIC_SDLC_MESSAGING_AUTO: "off" } });
  assert.match(result.stdout, /RECORDS_PUBLISH_SCOPE_VIOLATION/u, result.stderr);
  assert.equal(git(remote, ["rev-parse", "refs/heads/main"]), before);
});

function rejectPushes(remote, times) {
  const counter = path.join(remote, "rejections");
  const hook = path.join(remote, "hooks", "pre-receive");
  fs.writeFileSync(hook, `#!/bin/sh
n=$(cat "${counter}" 2>/dev/null || echo 0)
if [ "$n" -lt ${times} ]; then echo $((n + 1)) > "${counter}"; echo "busy: another publication is running" >&2; exit 1; fi
exit 0
`);
  fs.chmodSync(hook, 0o755);
  // The isolated global config points hooks elsewhere; the remote uses its own.
  git(remote, ["config", "core.hooksPath", path.join(remote, "hooks")]);
  return () => Number(fs.readFileSync(counter, "utf8").trim() || 0);
}

test("a refused push is retried on the fresh tip up to four times, and the reason shown is the remote's", async () => {
  const { publishBackoffMs } = await import("../lib/engine/story-sync.mjs");
  assert.deepEqual([1, 2, 3, 4].map((attempt) => publishBackoffMs(attempt, {})), [0, 1000, 2000, 4000]);
  assert.deepEqual([1, 2, 3].map((attempt) => publishBackoffMs(attempt, { AGENTIC_SDLC_PUBLISH_BACKOFF_MS: "5" })), [0, 5, 10]);

  const { remote, second } = twoComputers("retry");
  write(second, `.sdlc/stories/${STORY}/final.json`, "{}\n");
  const rejections = rejectPushes(remote, 3);
  const published = autoPublish(second, { AGENTIC_SDLC_PUBLISH_BACKOFF_MS: "0" });
  assert.equal(published.status, "published", published.stderr);
  assert.equal(published.attempt, 4);
  assert.equal(rejections(), 3);
  assert.equal(git(remote, ["rev-parse", "refs/heads/main"]), published.commit);

  const again = twoComputers("refused");
  write(again.second, `.sdlc/stories/${STORY}/final.json`, "{}\n");
  const refused = rejectPushes(again.remote, 99);
  const failed = autoPublish(again.second, { AGENTIC_SDLC_PUBLISH_BACKOFF_MS: "0" });
  assert.equal(failed.status, "failed");
  assert.equal(refused(), 4);
  assert.match(failed.problem, /refused the push to main \((?:remote: busy|.*rejected|error:)/u);
  assert.doesNotMatch(failed.problem, /\(To /u);
});
