import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  PLUGIN_VERSION,
  buildRequirementRecord,
  comparePluginVersions,
  evaluateRequirements,
  pluginUpdateCommand,
  requiresNewerPlugin,
} from "../lib/plugin-compatibility.mjs";
import {
  buildSharedClaimPayload,
  buildSharedReleasePayload,
  interpretSharedClaimRecords,
  sharedClaimRef,
} from "../lib/story-claim-shared-state.mjs";
import { sealSharedPayload } from "../lib/shared-ref-records.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(repoRoot, "bin", "agentic-sdlc.mjs");
const hook = path.join(repoRoot, "hooks", "agentic-sdlc-guard.mjs");
const tempPaths = new Set();

after(() => {
  for (const entry of tempPaths) fs.rmSync(entry, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function run(args, cwd) {
  const env = { ...process.env };
  for (const key of ["CI", "GITHUB_ACTIONS", "GITHUB_ACTOR", "CODEX_AGENT_NAME", "CODEX_THREAD_ID", "CODEX_USER_ID", "CLAUDECODE", "AGENTIC_SDLC_AGENT_HOST", "AGENTIC_SDLC_HOST_LABEL"]) delete env[key];
  return spawnSync(process.execPath, [bin, ...args], { cwd, encoding: "utf8", env, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
}

function git(project, args) {
  const result = spawnSync("git", ["-C", project, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}\n${result.stderr}`);
  return result.stdout;
}

function initializedProject() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-plugin-compat-"));
  tempPaths.add(project);
  git(project, ["init", "-q"]);
  git(project, ["config", "user.name", "Compat"]);
  git(project, ["config", "user.email", "compat@example.invalid"]);
  const init = run(["init", "--root", project, "--project-name", "Compat"], project);
  assert.equal(init.status, 0, init.stdout + init.stderr);
  return project;
}

function requireVersion(project, version) {
  const directory = path.join(project, ".sdlc", "compatibility");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "future-feature.json"), `${JSON.stringify({
    schema_version: "plugin-compatibility-requirement:v1",
    feature: "future-feature",
    minimum_plugin_version: version,
    summary: "A feature this plugin predates",
  }, null, 2)}\n`);
}

test("versions compare numerically and a malformed minimum counts as newer", () => {
  assert.equal(comparePluginVersions("0.10.0", "0.9.9"), 1);
  assert.equal(comparePluginVersions("1.0.0-rc.1", "1.0.0"), -1);
  assert.equal(comparePluginVersions("x", "1.0.0"), null);
  assert.equal(requiresNewerPlugin(undefined), false);
  assert.equal(requiresNewerPlugin(PLUGIN_VERSION), false);
  assert.equal(requiresNewerPlugin("999.0.0"), true);
  assert.equal(requiresNewerPlugin("not-a-version"), true);
});

test("requirement files decide whether this plugin can work on the project", () => {
  const known = { path: "a.json", record: buildRequirementRecord("shared-claim-completed") };
  assert.equal(evaluateRequirements([known]).satisfied, true);
  const future = { path: "b.json", record: { ...known.record, feature: "future", minimum_plugin_version: "999.0.0" } };
  const verdict = evaluateRequirements([known, future]);
  assert.equal(verdict.satisfied, false);
  assert.equal(verdict.required_plugin_version, "999.0.0");
  assert.deepEqual(verdict.newer_features.map((item) => item.feature), ["future"]);
  const unreadable = evaluateRequirements([{ path: "c.json", record: { schema_version: "plugin-compatibility-requirement:v9" } }]);
  assert.equal(unreadable.satisfied, false);
  assert.deepEqual(unreadable.unreadable, ["c.json"]);
  assert.match(pluginUpdateCommand(), /^claude plugin marketplace update \S+ && claude plugin update agentic-sdlc@\S+$/u);
});

test("an older plugin refuses changes, keeps reads working, and says how to update", () => {
  const project = initializedProject();
  requireVersion(project, "999.0.0");

  const write = run(["cache", "rebuild", "--root", project, "--json"], project);
  assert.notEqual(write.status, 0);
  assert.match(write.stdout + write.stderr, /PLUGIN_UPDATE_REQUIRED/u);
  assert.match(write.stdout + write.stderr, /claude plugin update agentic-sdlc@/u);

  const status = run(["status", "--root", project, "--json"], project);
  assert.equal(status.status, 0, status.stderr);
  const payload = JSON.parse(status.stdout);
  assert.equal(payload.plugin_compatibility.required_plugin_version, "999.0.0");
  assert.equal(payload.plugin_compatibility.satisfied, false);

  const human = run(["status", "--root", project, "--locale", "it"], project);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /Aggiorna il plugin: claude plugin marketplace update/u);

  const doctor = JSON.parse(run(["doctor", "--root", project, "--json"], project).stdout);
  const check = doctor.checks.find((item) => item.id === "plugin-compatibility");
  assert.equal(check.status, "failed");
  assert.match(check.details, /999\.0\.0/u);

  const session = spawnSync(process.execPath, [hook, "session-start"], {
    input: JSON.stringify({ cwd: project }),
    encoding: "utf8",
  });
  assert.equal(session.status, 0);
  assert.match(session.stdout, /Update the plugin: claude plugin marketplace update/u);
});

test("a project whose records this plugin understands runs normally and its cache follows the plugin version", () => {
  const project = initializedProject();
  requireVersion(project, PLUGIN_VERSION);
  const rebuild = run(["cache", "rebuild", "--root", project, "--json"], project);
  assert.equal(rebuild.status, 0, rebuild.stdout + rebuild.stderr);
  const cachePath = path.join(project, ".sdlc", "cache", "kb-cache.json");
  const cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  assert.equal(cache.plugin_version, PLUGIN_VERSION);
  const doctor = JSON.parse(run(["doctor", "--root", project, "--json"], project).stdout);
  assert.equal(doctor.checks.find((item) => item.id === "plugin-compatibility").status, "passed");

  // A cache written by another plugin version is derived data: it is reported stale, not trusted.
  fs.writeFileSync(cachePath, `${JSON.stringify({ ...cache, plugin_version: "0.0.1" }, null, 2)}\n`);
  const cacheStatus = JSON.parse(run(["cache", "status", "--root", project, "--json"], project).stdout);
  assert.equal(cacheStatus.valid, false);
  assert.equal(cacheStatus.plugin_version_mismatch, true);
});

test("a shared record that declares a newer plugin is not interpreted and asks for the update", () => {
  const release = buildSharedReleasePayload({
    storyId: "ST-1", epoch: 1, claimantId: "c1", status: "completed", releasedAt: "2026-10-09T00:00:00Z",
  });
  assert.equal(release.minimum_plugin_version, "0.32.0");
  const { payload_hash: _hash, ...plain } = buildSharedClaimPayload({
    storyId: "ST-1", epoch: 1, claimantId: "c1", agent: "a", branch: "b", actor: null, claimedAt: "2026-10-09T00:00:00Z",
  });
  const claim = sealSharedPayload({ ...plain, minimum_plugin_version: "999.0.0" });
  const interpreted = interpretSharedClaimRecords([
    { ref: sharedClaimRef("ST-1", 1), message: JSON.stringify(claim) },
  ]);
  const problems = [...interpreted.stories.values()].flatMap((state) => state.problems);
  assert.ok(problems.some((text) => /newer plugin version \(999\.0\.0 or later\); update the plugin: claude plugin/u.test(text)), problems.join("\n"));
});
