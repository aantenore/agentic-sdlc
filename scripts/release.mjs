#!/usr/bin/env node
// Fast release: rebase on origin/main, bump version, commit, push, PR, merge, update plugin.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const VERSION_PATHSPECS = [
  "package.json",
  "package-lock.json",
  ".claude-plugin/*.json",
  ".codex-plugin/*.json",
  "README.md",
  "docs/*.md",
];

export function parseVersion(text) {
  const m = SEMVER.exec(String(text).trim().replace(/^v/, ""));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

// Next version = minor+1 (patch reset) of the max between the main version and the tags.
export function computeNextVersion(mainVersion, tags = []) {
  const candidates = [mainVersion, ...tags].filter((v) => parseVersion(v));
  if (!parseVersion(mainVersion)) throw new Error(`Invalid main version: ${mainVersion}`);
  const max = candidates.map((v) => String(v).trim().replace(/^v/, "")).reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b));
  const [major, minor] = parseVersion(max);
  return `${major}.${minor + 1}.0`;
}

// True when the branch already carries the version bump commit for `version`.
export function hasVersionCommit(subjects, version) {
  return String(subjects).split("\n").some((s) => s.trim() === `Versione ${version}`);
}

// True when `gh pr view --json state` output reports the PR as merged.
export function isMergedState(viewJson) {
  try {
    return JSON.parse(viewJson)?.state === "MERGED";
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  const opts = { update: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--no-update") opts.update = false;
    else if (["--version", "--title", "--body"].includes(arg)) {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      opts[arg.slice(2)] = argv[++i];
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

function run(cmd, args, { allowFail = false } = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) {
    throw new Error(`${cmd} ${args.join(" ")} failed:\n${(r.stderr || r.stdout).trim()}`);
  }
  return { ok: r.status === 0, out: r.stdout.trim(), err: r.stderr.trim() };
}

const git = (...args) => run("git", args).out;
const step = (msg) => console.log(`> ${msg}`);

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const root = git("rev-parse", "--show-toplevel");
  process.chdir(root);

  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch === "main" || branch === "HEAD") throw new Error("Run from a feature branch, not main or detached HEAD.");
  if (git("status", "--porcelain")) throw new Error("Working tree not clean: commit or stash changes first.");

  step("fetch origin");
  git("fetch", "origin", "--tags", "--prune");
  const oldVersion = JSON.parse(git("show", "origin/main:package.json")).version;
  const tags = git("tag", "--list", "v*").split("\n").filter((t) => /^v\d+\.\d+\.\d+$/.test(t));
  const newVersion = opts.version ?? computeNextVersion(oldVersion, tags);
  if (!parseVersion(newVersion)) throw new Error(`Invalid version: ${newVersion}`);
  if (newVersion === oldVersion) throw new Error(`Version ${newVersion} equals origin/main version.`);
  if (tags.includes(`v${newVersion}`)) throw new Error(`Tag v${newVersion} already exists.`);

  step(`rebase onto origin/main (${oldVersion} -> ${newVersion})`);
  const rb = run("git", ["rebase", "origin/main"], { allowFail: true });
  if (!rb.ok) {
    run("git", ["rebase", "--abort"], { allowFail: true });
    throw new Error(`Rebase onto origin/main failed (conflicts). Rebase aborted; resolve manually.\n${rb.err}`);
  }

  if (hasVersionCommit(git("log", "--format=%s", "origin/main..HEAD"), newVersion)) {
    step(`version commit ${newVersion} already present, skip bump`);
  } else {
    step("update version strings");
    const files = git("ls-files", "--", ...VERSION_PATHSPECS).split("\n").filter(Boolean);
    const re = new RegExp(`(?<![\\d.])${oldVersion.replace(/\./g, "\\.")}(?![\\d]|\\.\\d)`, "g");
    const changed = [];
    for (const f of files) {
      const text = fs.readFileSync(f, "utf8");
      if (!re.test(text)) continue;
      re.lastIndex = 0;
      fs.writeFileSync(f, text.replace(re, newVersion));
      changed.push(f);
    }
    if (!changed.length) throw new Error(`No file contains version ${oldVersion}.`);
    console.log(`  ${changed.length} files: ${changed.join(", ")}`);

    step("commit");
    git("add", "--", ...changed);
    git("commit", "-m", `Versione ${newVersion}`);
  }

  step("push");
  git("push", "-u", "origin", branch);

  const title = opts.title ?? branch;
  const body = opts.body ?? git("log", "--format=- %s", "origin/main..HEAD");
  step("create PR");
  const prUrl = run("gh", ["pr", "create", "--base", "main", "--head", branch, "--title", title, "--body", body]).out.split("\n").pop();

  step("merge PR");
  // No --delete-branch: gh would try to check out local main, which fails when main lives in another worktree.
  const merge = run("gh", ["pr", "merge", prUrl, "--merge"], { allowFail: true });
  const view = run("gh", ["pr", "view", prUrl, "--json", "state,mergeCommit"], { allowFail: true });
  if (!merge.ok && !isMergedState(view.out)) throw new Error(`Merge failed. PR: ${prUrl}\n${merge.err}`);
  run("git", ["push", "origin", "--delete", branch], { allowFail: true });
  let mergeCommit = "unknown";
  try {
    mergeCommit = JSON.parse(view.out).mergeCommit?.oid ?? "unknown";
  } catch {}

  if (opts.update) {
    const marketplace = JSON.parse(fs.readFileSync(path.join(".claude-plugin", "marketplace.json"), "utf8")).name;
    const plugin = JSON.parse(fs.readFileSync(path.join(".claude-plugin", "plugin.json"), "utf8")).name;
    step("update plugin");
    run("claude", ["plugin", "marketplace", "update", marketplace]);
    run("claude", ["plugin", "update", `${plugin}@${marketplace}`]);
  }

  console.log(`PR: ${prUrl}\nMerge commit: ${mergeCommit}\nVersion: ${newVersion}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`release: ${error.message}`);
    process.exit(1);
  }
}
