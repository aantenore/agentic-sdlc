import "./helpers/test-isolation.mjs";

import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(repoRoot, "bin", "agentic-sdlc.mjs");
const tempPaths = new Set();
const TRACE = ".sdlc/traces/project.jsonl";
const STORY = "ST-SYNC-001";

after(() => {
  if (process.env.AGENTIC_SDLC_KEEP_TEST_TMP === "1") return;
  for (const entry of tempPaths) fs.rmSync(entry, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function tmpDirectory(name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `sdlc-story-sync-${name}-`));
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

function mustRunJson(args) {
  return JSON.parse(mustRun([...args, "--json"]).stdout);
}

function git(project, args, { allowFailure = false } = {}) {
  const result = spawnSync("git", ["-C", project, ...args], { encoding: "utf8", timeout: 60_000 });
  if (!allowFailure) assert.equal(result.status, 0, `git ${args.join(" ")}\n${result.stderr}`);
  return result;
}

function configureClone(project, name) {
  git(project, ["config", "user.email", `${name}@example.invalid`]);
  git(project, ["config", "user.name", name]);
  git(project, ["config", "core.autocrlf", "false"]);
}

function record(project, summary) {
  mustRun(["trace", "append", "--root", project, "--type", "decision", "--summary", summary, "--actor-type", "human"]);
}

function write(project, file, text) {
  fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
  fs.writeFileSync(path.join(project, file), text);
}

// The base branch moves on while the second computer works on the story.
function twoComputers(name) {
  const root = tmpDirectory(name);
  const remote = path.join(root, "remote.git");
  git(root, ["init", "--quiet", "--bare", "-b", "main", remote]);
  const first = path.join(root, "first");
  fs.mkdirSync(first);
  mustRun(["init", "--root", first, "--project-name", "Story sync"]);
  git(first, ["init", "--quiet", "-b", "main"]);
  configureClone(first, "first");
  mustRun(["story", "create", "--no-derived-verification", "--root", first, "--id", STORY, "--title", "Sync the story", "--phase", "implementation", "--status", "ready", "--acceptance", "The story stays aligned."]);
  write(first, "src/shared.txt", "one\n");
  record(first, "Common decision");
  git(first, ["add", "-A"]);
  git(first, ["commit", "--quiet", "-m", "Start the project"]);
  git(first, ["remote", "add", "origin", remote]);
  git(first, ["push", "--quiet", "-u", "origin", "main"]);
  git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  const second = path.join(root, "second");
  git(root, ["clone", "--quiet", remote, second]);
  configureClone(second, "second");
  git(second, ["checkout", "--quiet", "-b", `feature/${STORY}`]);
  return { root, first, second };
}

test("story sync rebases the story, keeps local records and history, and drops identical duplicates", () => {
  const { first, second } = twoComputers("sync");
  write(second, "src/story.txt", "story work\n");
  git(second, ["add", "src/story.txt"]);
  git(second, ["commit", "--quiet", "-m", "Story work"]);
  record(second, "Second computer decision");
  write(second, "docs/copy.md", "same bytes\n");

  record(first, "Base decision");
  write(first, "docs/copy.md", "same bytes\n");
  git(first, ["add", "-A"]);
  git(first, ["commit", "--quiet", "-m", "Base work"]);
  git(first, ["push", "--quiet"]);

  const planned = mustRunJson(["story", "sync", "--root", second, "--id", STORY, "--dry-run"]);
  assert.equal(planned.status, "planned");
  assert.equal(planned.mode, "rebase");
  assert.deepEqual(planned.duplicates_removed, ["docs/copy.md"]);
  assert.deepEqual(planned.blockers, []);

  const synced = mustRunJson(["story", "sync", "--root", second, "--id", STORY]);
  assert.equal(synced.status, "synced");
  assert.equal(synced.branch_rewritten, true);
  assert.equal(git(second, ["merge-base", "--is-ancestor", "origin/main", "HEAD"], { allowFailure: true }).status, 0);
  assert.equal(fs.readFileSync(path.join(second, "src/story.txt"), "utf8"), "story work\n");
  const summaries = fs.readFileSync(path.join(second, TRACE), "utf8").trimEnd().split("\n").map((line) => JSON.parse(line).summary);
  assert.ok(summaries.includes("Base decision"));
  assert.ok(summaries.includes("Second computer decision"));
  assert.equal(run(["trace", "verify", "--root", second, "--json"]).status, 0);
  assert.equal(git(second, ["status", "--porcelain", "--", "docs"]).stdout.trim(), "");

  const again = mustRunJson(["story", "sync", "--root", second, "--id", STORY]);
  assert.equal(again.mode, "none");
});

test("story sync refuses a code conflict, names the files, and changes nothing", () => {
  const { first, second } = twoComputers("conflict");
  write(second, "src/shared.txt", "second\n");
  git(second, ["commit", "--quiet", "-am", "Story edit"]);
  write(first, "src/shared.txt", "first\n");
  git(first, ["commit", "--quiet", "-am", "Base edit"]);
  git(first, ["push", "--quiet"]);
  const head = git(second, ["rev-parse", "HEAD"]).stdout.trim();
  const refused = run(["story", "sync", "--root", second, "--id", STORY]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr + refused.stdout, /conflicts in src\/shared\.txt/u);
  assert.equal(git(second, ["rev-parse", "HEAD"]).stdout.trim(), head);
  assert.equal(fs.readFileSync(path.join(second, "src/shared.txt"), "utf8"), "second\n");
});

function autoPublish(project, env = {}) {
  const script = `
    import { buildContext } from ${JSON.stringify(path.join(repoRoot, "lib/engine/common.mjs"))};
    import { autoPublishStoryRecords } from ${JSON.stringify(path.join(repoRoot, "lib/engine/story-sync.mjs"))};
    const context = buildContext({ root: ${JSON.stringify(project)} });
    const result = await autoPublishStoryRecords(context, { storyId: ${JSON.stringify(STORY)}, event: "lifecycle-complete" });
    console.log(JSON.stringify(result));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: repoRoot, encoding: "utf8", timeout: 60_000, env: { ...process.env, AGENTIC_SDLC_MESSAGING_AUTO: "off", AGENTIC_SDLC_AUTO_PUBLISH: "on", ...env },
  });
  assert.equal(result.status, 0, result.stderr);
  return { ...JSON.parse(result.stdout.trim().split("\n").at(-1)), stderr: result.stderr };
}

test("the story's records are published to the base branch with only .sdlc files, after rebuilding the history", () => {
  const { first, second } = twoComputers("publish");
  write(second, ".sdlc/stories/ST-SYNC-001/final.json", "{}\n");
  write(second, "src/unrelated.txt", "not a record\n");
  record(second, "Closing decision");
  record(first, "Base decision");
  git(first, ["commit", "--quiet", "-am", "Base work"]);
  git(first, ["push", "--quiet"]);

  assert.equal(autoPublish(second, { AGENTIC_SDLC_AUTO_PUBLISH: "off" }).status, "off");
  const published = autoPublish(second);
  assert.equal(published.status, "published", published.stderr);
  assert.ok(published.published.includes(".sdlc/stories/ST-SYNC-001/final.json"));
  assert.ok(published.published.includes(TRACE));
  assert.ok(published.published.every((file) => file.startsWith(".sdlc/")));
  git(first, ["pull", "--quiet", "--no-rebase"]);
  assert.equal(git(first, ["log", "-1", "--format=%s|%an"]).stdout.trim(), `sdlc: record di ${STORY} (lifecycle-complete)|second`);
  assert.equal(fs.existsSync(path.join(first, "src/unrelated.txt")), false);
  const summaries = fs.readFileSync(path.join(first, TRACE), "utf8").trimEnd().split("\n").map((line) => JSON.parse(line).summary);
  assert.deepEqual(summaries.slice(-2), ["Base decision", "Closing decision"]);
  assert.equal(run(["trace", "verify", "--root", first, "--json"]).status, 0);
  assert.equal(autoPublish(second).status, "nothing_to_publish");
});

function receiptFor(project, sha) {
  const file = path.join(project, ".sdlc", "autonomy", "actions", "ACT-SYNC-COMMIT.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ action: "git.commit", action_details: { commit: { before_sha: "0".repeat(40), after_sha: sha } } })}\n`);
}

test("story sync refuses to rebase a governed commit that is not pushed, unless told to", () => {
  const { first, second } = twoComputers("receipt");
  write(second, "src/story.txt", "story work\n");
  git(second, ["add", "src/story.txt"]);
  git(second, ["commit", "--quiet", "-m", "Story work"]);
  const head = git(second, ["rev-parse", "HEAD"]).stdout.trim();
  receiptFor(second, head);
  write(first, "src/base.txt", "base\n");
  git(first, ["add", "src/base.txt"]);
  git(first, ["commit", "--quiet", "-m", "Base work"]);
  git(first, ["push", "--quiet"]);

  const planned = mustRunJson(["story", "sync", "--root", second, "--id", STORY, "--dry-run"]);
  assert.equal(planned.blockers.length, 1);
  assert.match(planned.blockers[0], /git\.commit receipt.*--allow-rebase-committed/u);
  const refused = run(["story", "sync", "--root", second, "--id", STORY]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr + refused.stdout, /story sync before the governed git\.commit/u);
  assert.equal(git(second, ["rev-parse", "HEAD"]).stdout.trim(), head, "the refused sync moved the branch");

  const allowed = mustRunJson(["story", "sync", "--root", second, "--id", STORY, "--allow-rebase-committed"]);
  assert.equal(allowed.status, "synced");
  assert.notEqual(git(second, ["rev-parse", "HEAD"]).stdout.trim(), head);
});

test("story sync rebases freely once the governed commit is on the remote", () => {
  const { first, second } = twoComputers("receipt-pushed");
  write(second, "src/story.txt", "story work\n");
  git(second, ["add", "src/story.txt"]);
  git(second, ["commit", "--quiet", "-m", "Story work"]);
  git(second, ["push", "--quiet", "origin", `feature/${STORY}`]);
  receiptFor(second, git(second, ["rev-parse", "HEAD"]).stdout.trim());
  write(first, "src/base.txt", "base\n");
  git(first, ["add", "src/base.txt"]);
  git(first, ["commit", "--quiet", "-m", "Base work"]);
  git(first, ["push", "--quiet"]);
  const planned = mustRunJson(["story", "sync", "--root", second, "--id", STORY, "--dry-run"]);
  assert.deepEqual(planned.blockers, []);
});

test("story sync keeps the base copy of a regenerated gate file instead of failing", () => {
  const { first, second } = twoComputers("gate");
  const gate = `.sdlc/gates/${STORY}-strict.json`;
  write(second, gate, `${JSON.stringify({ checked_at: "2026-01-01T00:00:00.000Z", source: "second" })}\n`);
  write(first, gate, `${JSON.stringify({ checked_at: "2026-02-01T00:00:00.000Z", source: "base" })}\n`);
  git(first, ["add", "-f", gate]);
  git(first, ["commit", "--quiet", "-m", "Gate from main"]);
  git(first, ["push", "--quiet"]);
  write(second, "src/story.txt", "story work\n");
  git(second, ["add", "src/story.txt"]);
  git(second, ["commit", "--quiet", "-m", "Story work"]);
  const synced = mustRunJson(["story", "sync", "--root", second, "--id", STORY]);
  assert.equal(synced.status, "synced");
  assert.equal(JSON.parse(fs.readFileSync(path.join(second, gate), "utf8")).source, "base");
});

test("story sync sets uncommitted code changes aside and puts them back", () => {
  const { first, second } = twoComputers("code-stash");
  write(second, "src/story.txt", "story work\n");
  git(second, ["add", "src/story.txt"]);
  git(second, ["commit", "--quiet", "-m", "Story work"]);
  write(second, "src/shared.txt", "one\nlocal edit\n");
  write(first, "src/base.txt", "base\n");
  git(first, ["add", "src/base.txt"]);
  git(first, ["commit", "--quiet", "-m", "Base work"]);
  git(first, ["push", "--quiet"]);

  const planned = mustRunJson(["story", "sync", "--root", second, "--id", STORY, "--dry-run"]);
  assert.deepEqual(planned.blockers, []);
  assert.deepEqual(planned.code_changes, ["src/shared.txt"]);
  const synced = mustRunJson(["story", "sync", "--root", second, "--id", STORY]);
  assert.equal(synced.status, "synced");
  assert.equal(synced.code_changes_stash.status, "restored");
  assert.equal(fs.readFileSync(path.join(second, "src/shared.txt"), "utf8"), "one\nlocal edit\n");
  assert.equal(fs.readFileSync(path.join(second, "src/base.txt"), "utf8"), "base\n");
  assert.equal(git(second, ["stash", "list"]).stdout.trim(), "");
  assert.equal(git(second, ["merge-base", "--is-ancestor", "origin/main", "HEAD"], { allowFailure: true }).status, 0);
});

test("story sync keeps uncommitted code changes in the stash when they no longer apply, and leaves a clean tree", () => {
  const { first, second } = twoComputers("code-stash-conflict");
  write(second, "src/story.txt", "story work\n");
  git(second, ["add", "src/story.txt"]);
  git(second, ["commit", "--quiet", "-m", "Story work"]);
  write(second, "src/shared.txt", "local edit\n");
  write(first, "src/shared.txt", "base edit\n");
  git(first, ["commit", "--quiet", "-am", "Base edit"]);
  git(first, ["push", "--quiet"]);

  const synced = mustRunJson(["story", "sync", "--root", second, "--id", STORY]);
  assert.equal(synced.status, "synced");
  assert.equal(synced.code_changes_stash.status, "kept");
  assert.equal(fs.readFileSync(path.join(second, "src/shared.txt"), "utf8"), "base edit\n");
  assert.match(git(second, ["stash", "list"]).stdout, /agentic-sdlc story sync ST-SYNC-001/u);
  assert.equal(git(second, ["show", "stash@{0}:src/shared.txt"]).stdout, "local edit\n");
});

test("story sync puts uncommitted code changes back when the rebase conflicts", () => {
  const { first, second } = twoComputers("code-stash-refused");
  write(second, "src/shared.txt", "second\n");
  git(second, ["commit", "--quiet", "-am", "Story edit"]);
  write(second, "src/story.txt", "tracked later\n");
  git(second, ["add", "src/story.txt"]);
  write(second, "src/story.txt", "tracked later, edited\n");
  write(first, "src/shared.txt", "first\n");
  git(first, ["commit", "--quiet", "-am", "Base edit"]);
  git(first, ["push", "--quiet"]);
  const refused = run(["story", "sync", "--root", second, "--id", STORY]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr + refused.stdout, /conflicts in src\/shared\.txt/u);
  assert.equal(fs.readFileSync(path.join(second, "src/story.txt"), "utf8"), "tracked later, edited\n");
  assert.equal(git(second, ["stash", "list"]).stdout.trim(), "");
});

// Both computers recorded decisions and output links: the history forked and the registry differs.
function divergedPublication(name) {
  const { first, second } = twoComputers(name);
  const registry = ".sdlc/output-contracts/registry.json";
  const addDecision = (project, id) => {
    const file = path.join(project, registry);
    const content = JSON.parse(fs.readFileSync(file, "utf8"));
    content.decisions = [...(content.decisions || []), { id, type: "fixture", status: "recorded" }];
    content.updated_at = new Date().toISOString();
    fs.writeFileSync(file, `${JSON.stringify(content, null, 2)}\n`);
  };
  write(second, ".sdlc/stories/ST-SYNC-001/final.json", "{}\n");
  record(second, "Closing decision");
  addDecision(second, "DEC-SECOND");
  record(first, "Base decision");
  addDecision(first, "DEC-FIRST");
  git(first, ["commit", "--quiet", "-am", "Base work"]);
  git(first, ["push", "--quiet"]);
  return { first, second, registry };
}

test("publish-records merges the shared history and the output registry instead of leaving them out", () => {
  const { first, second, registry } = divergedPublication("publish-records-shared");
  const published = mustRunJson(["story", "publish-records", "--root", second, "--id", STORY]);
  assert.equal(published.status, "published");
  assert.ok(published.published.includes(TRACE), JSON.stringify(published));
  assert.ok(published.published.includes(".sdlc/traces/.integrity/project.jsonl.checkpoint.json"), JSON.stringify(published));
  assert.ok(published.published.includes(registry), JSON.stringify(published));
  assert.deepEqual(published.skipped, []);

  git(first, ["fetch", "--quiet", "origin", published.branch]);
  git(first, ["merge", "--quiet", "--no-edit", `origin/${published.branch}`]);
  const summaries = fs.readFileSync(path.join(first, TRACE), "utf8").trimEnd().split("\n").map((line) => JSON.parse(line).summary);
  assert.deepEqual(summaries.slice(-2), ["Base decision", "Closing decision"]);
  assert.equal(run(["trace", "verify", "--root", first, "--json"]).status, 0);
  const merged = JSON.parse(fs.readFileSync(path.join(first, registry), "utf8"));
  assert.deepEqual(merged.decisions.map((entry) => entry.id).filter((id) => id.startsWith("DEC-")).sort(), ["DEC-FIRST", "DEC-SECOND"]);
  assert.equal(fs.existsSync(path.join(first, ".sdlc/stories/ST-SYNC-001/final.json")), true);
});

test("publish-records publishes nothing when the shared history cannot be merged", () => {
  const { second } = divergedPublication("publish-records-unmergeable");
  const tracePath = path.join(second, TRACE);
  const tampered = fs.readFileSync(tracePath, "utf8").replace("Closing decision", "Edited decision");
  fs.writeFileSync(tracePath, tampered);
  const refused = run(["story", "publish-records", "--root", second, "--id", STORY, "--json"]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stdout + refused.stderr, /STORY_RECORDS_SHARED_HISTORY_UNMERGEABLE/u);
  assert.match(refused.stdout + refused.stderr, /Nothing was published/u);
  const heads = git(second, ["ls-remote", "--heads", "origin"]).stdout;
  assert.doesNotMatch(heads, /sdlc-records/u);
});

test("the automatic publication does not publish partially when the shared history cannot be merged", () => {
  const { second } = divergedPublication("auto-unmergeable");
  const tracePath = path.join(second, TRACE);
  fs.writeFileSync(tracePath, fs.readFileSync(tracePath, "utf8").replace("Closing decision", "Edited decision"));
  const result = autoPublish(second);
  assert.equal(result.status, "failed");
  assert.match(result.problem, /shared history cannot be merged/u);
  assert.doesNotMatch(git(second, ["ls-remote", "origin", "refs/heads/main"]).stdout, new RegExp(git(second, ["rev-parse", "HEAD"]).stdout.trim(), "u"));
});

test("records are never published into a repository that holds another project", () => {
  const { first, second } = twoComputers("foreign-target");
  const projectFile = path.join(first, ".sdlc", "project.json");
  const foreign = JSON.parse(fs.readFileSync(projectFile, "utf8"));
  foreign.project_id = "another-project";
  fs.writeFileSync(projectFile, `${JSON.stringify(foreign, null, 2)}\n`);
  git(first, ["commit", "--quiet", "-am", "Another project lives here"]);
  git(first, ["push", "--quiet"]);
  write(second, ".sdlc/stories/ST-SYNC-001/final.json", "{}\n");
  record(second, "Closing decision");
  const before = git(first, ["rev-parse", "HEAD"]).stdout.trim();
  const refused = autoPublish(second);
  assert.equal(refused.status, "failed");
  assert.match(refused.problem, /another-project/u);
  git(first, ["pull", "--quiet", "--no-rebase"]);
  assert.equal(git(first, ["rev-parse", "HEAD"]).stdout.trim(), before);
});

test("records are never published from a project that is not its git repository root", () => {
  const { second } = twoComputers("nested-project");
  const nested = path.join(second, "packages", "app");
  fs.mkdirSync(nested, { recursive: true });
  mustRun(["init", "--root", nested, "--project-name", "Nested"]);
  mustRun(["story", "create", "--no-derived-verification", "--root", nested, "--id", STORY, "--title", "Nested", "--phase", "implementation", "--status", "ready", "--acceptance", "Nested."]);
  const refused = autoPublish(nested);
  assert.equal(refused.status, "failed");
  assert.match(refused.problem, /not the root of its git repository/u);
});
