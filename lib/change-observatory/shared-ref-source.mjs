import childProcess from "node:child_process";
import path from "node:path";

import { fs, process } from "../runtime/host.mjs";
import { remoteBaseRef } from "../engine/merge-drift.mjs";
import { firstLine, runGit } from "../engine/shared-refs.mjs";
import { orchestrationPolicy } from "../story-claim-shared-state.mjs";

/**
 * The Change Observatory shows the records published on the shared base
 * branch (origin/<base> by default), not the files of the local checkout,
 * which may be on a story branch or behind. The records are read from Git
 * objects into a private copy under the Git directory, kept up to date by a
 * periodic fetch of that one ref. The checkout itself is never changed.
 */
export const OBSERVE_FETCH_SECONDS_ENV = "AGENTIC_SDLC_OBSERVE_FETCH_SECONDS";
const DEFAULT_FETCH_SECONDS = 60;
const GIT_TIMEOUT_SECONDS = 10;
const FETCH_TIMEOUT_SECONDS = 20;
const RECORD_ROOT = ".sdlc";
// Derived local files: never part of the shared records, kept by the copy.
const LOCAL_ONLY_PREFIX = `${RECORD_ROOT}/cache/`;
const SNAPSHOT_DIRECTORY = path.join("agentic-sdlc", "observatory");
const BLOB_MODES = new Set(["100644", "100755"]);
const MAX_BATCH_BYTES = 1024 * 1024 * 1024;

export function observeFetchSeconds(environment = process.env) {
  const raw = environment[OBSERVE_FETCH_SECONDS_ENV];
  if (raw === undefined || String(raw).trim() === "") return DEFAULT_FETCH_SECONDS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_FETCH_SECONDS;
}

/**
 * Which ref the observatory shows: the explicit one, or the remote base
 * branch from the project configuration. Returns null when the project has
 * no such ref (no Git, no remote, nothing fetched yet).
 * { ref, commit, remote, branch } — remote/branch are set when the ref is a
 * remote-tracking branch that can be fetched.
 */
export function resolveObservatoryRef(projectRoot, {
  ref = null,
  timeoutSeconds = GIT_TIMEOUT_SECONDS,
  git = (args) => runGit(projectRoot, args, { timeoutSeconds }),
} = {}) {
  if (ref) {
    const full = firstLine(git(["rev-parse", "--verify", "--quiet", "--symbolic-full-name", ref]).stdout) || ref;
    const commit = firstLine(git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).stdout);
    if (!commit) return null;
    const tracking = remoteTracking(full, git);
    return { ref, commit, ...tracking };
  }
  let policy = null;
  try {
    policy = orchestrationPolicy(readConfig(projectRoot));
  } catch {
    policy = null;
  }
  const remote = policy?.coordination?.remote || "origin";
  const configured = policy?.merge_drift?.base_branch ?? null;
  const base = remoteBaseRef({ root: projectRoot }, remote, configured, timeoutSeconds)
    ?? fetchThenResolve(projectRoot, remote, configured, timeoutSeconds);
  if (!base) return null;
  const commit = firstLine(git(["rev-parse", "--verify", "--quiet", `${base.ref}^{commit}`]).stdout);
  if (!commit) return null;
  return { ref: `${remote}/${base.branch}`, commit, remote, branch: base.branch };
}

/** Files under .sdlc at a commit: [{ path, oid }], symlinks and submodules left out. */
export function listRecordsAtCommit(projectRoot, commit, {
  git = (args) => runGit(projectRoot, args, { timeoutSeconds: GIT_TIMEOUT_SECONDS }),
} = {}) {
  const listed = git(["ls-tree", "-r", "-z", "--full-tree", commit, "--", RECORD_ROOT]);
  if (!listed.ok) return [];
  const entries = [];
  for (const line of String(listed.stdout ?? "").split("\0")) {
    const match = line.match(/^(\d+) blob ([0-9a-f]+)\t(.+)$/u);
    if (!match || !BLOB_MODES.has(match[1])) continue;
    const relative = match[3];
    if (relative.startsWith(LOCAL_ONLY_PREFIX) || !safeRelative(relative)) continue;
    entries.push({ path: relative, oid: match[2] });
  }
  return entries;
}

/** Contents of blobs, read with one `git cat-file --batch`: Map oid -> Buffer. */
export function readBlobs(projectRoot, oids) {
  const wanted = [...new Set(oids)];
  const contents = new Map();
  if (wanted.length === 0) return contents;
  const stdout = childProcess.execFileSync("git", ["-C", projectRoot, "cat-file", "--batch"], {
    input: wanted.map((oid) => `${oid}\n`).join(""),
    stdio: ["pipe", "pipe", "ignore"],
    maxBuffer: MAX_BATCH_BYTES,
    timeout: GIT_TIMEOUT_SECONDS * 6 * 1000,
  });
  let offset = 0;
  for (const oid of wanted) {
    const end = stdout.indexOf(0x0a, offset);
    if (end < 0) break;
    const header = stdout.subarray(offset, end).toString("utf8");
    offset = end + 1;
    const match = header.match(/^[0-9a-f]+ (\S+) (\d+)$/u);
    if (!match) continue;
    const size = Number(match[2]);
    if (match[1] === "blob") contents.set(oid, stdout.subarray(offset, offset + size));
    offset += size + 1;
  }
  return contents;
}

/**
 * A private copy of the records of one ref, refreshed when the ref moves.
 * root: the directory to open as the project (it holds `.sdlc`).
 */
export function createSharedRefSource(projectRoot, {
  ref = null,
  fetchSeconds = observeFetchSeconds(),
  now = () => new Date(),
  snapshotRoot = null,
} = {}) {
  const resolved = resolveObservatoryRef(projectRoot, { ref });
  if (!resolved) return null;
  const root = snapshotRoot ?? path.join(gitCommonDirectory(projectRoot), SNAPSHOT_DIRECTORY, safeName(resolved.ref));
  const written = new Map();
  let commit = null;
  let updatedAt = null;
  let fetchedAt = null;
  let fetchError = null;
  let timer = null;
  let fetching = false;

  function sync(target) {
    if (target === commit) return false;
    const entries = listRecordsAtCommit(projectRoot, target);
    const changed = entries.filter((entry) => written.get(entry.path) !== entry.oid
      || !fs.existsSync(path.join(root, entry.path)));
    const blobs = readBlobs(projectRoot, changed.map((entry) => entry.oid));
    for (const entry of changed) {
      const content = blobs.get(entry.oid);
      if (!content) continue;
      writeAtomically(path.join(root, entry.path), content);
      written.set(entry.path, entry.oid);
    }
    const keep = new Set(entries.map((entry) => entry.path));
    removeStale(root, path.join(root, RECORD_ROOT), keep);
    for (const known of [...written.keys()]) if (!keep.has(known)) written.delete(known);
    commit = target;
    updatedAt = now().toISOString();
    return true;
  }

  async function refresh({ fetch = true } = {}) {
    if (fetching) return false;
    fetching = true;
    try {
      if (fetch && resolved.remote && resolved.branch) {
        const fetched = await fetchRef(projectRoot, resolved.remote, resolved.branch);
        fetchedAt = now().toISOString();
        fetchError = fetched ? null : "fetch_failed";
      }
      const current = firstLine(runGit(projectRoot, ["rev-parse", "--verify", "--quiet", `${resolved.ref}^{commit}`], {
        timeoutSeconds: GIT_TIMEOUT_SECONDS,
      }).stdout);
      return current ? sync(current) : false;
    } finally {
      fetching = false;
    }
  }

  sync(resolved.commit);

  return {
    root,
    ref: resolved.ref,
    refresh,
    start() {
      if (timer || !(fetchSeconds > 0) || !resolved.remote) return;
      timer = setInterval(() => {
        refresh().catch(() => {});
      }, fetchSeconds * 1000);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    info() {
      return {
        mode: "ref",
        ref: resolved.ref,
        commit,
        updatedAt,
        fetchedAt,
        fetchSeconds: resolved.remote ? fetchSeconds : 0,
        fetchError,
      };
    },
  };
}

function remoteTracking(fullName, git) {
  const match = /^refs\/remotes\/([^/]+)\/(.+)$/u.exec(fullName);
  if (!match) return { remote: null, branch: null };
  const remotes = String(git(["remote"]).stdout ?? "").split("\n").map((line) => line.trim());
  return remotes.includes(match[1]) ? { remote: match[1], branch: match[2] } : { remote: null, branch: null };
}

function fetchThenResolve(projectRoot, remote, configured, timeoutSeconds) {
  if (!configured) return null;
  const fetched = runGit(projectRoot, fetchArgs(remote, configured), { timeoutSeconds: FETCH_TIMEOUT_SECONDS });
  return fetched.ok ? remoteBaseRef({ root: projectRoot }, remote, configured, timeoutSeconds) : null;
}

function fetchArgs(remote, branch) {
  return ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", remote,
    `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`];
}

// Asynchronous, so a slow remote never blocks the viewer's requests.
function fetchRef(projectRoot, remote, branch) {
  return new Promise((resolve) => {
    childProcess.execFile("git", ["-C", projectRoot, ...fetchArgs(remote, branch)], {
      timeout: FETCH_TIMEOUT_SECONDS * 1000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" },
    }, (error) => resolve(!error));
  });
}

function gitCommonDirectory(projectRoot) {
  const shown = runGit(projectRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    timeoutSeconds: GIT_TIMEOUT_SECONDS,
  });
  const directory = firstLine(shown.stdout);
  if (!shown.ok || !directory) throw new Error("The project is not a Git repository");
  return directory;
}

function readConfig(projectRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(projectRoot, RECORD_ROOT, "config.json"), "utf8"));
  } catch {
    return {};
  }
}

function safeRelative(relative) {
  return !relative.split("/").some((part) => part === "" || part === "." || part === "..");
}

function safeName(ref) {
  return ref.replace(/[^A-Za-z0-9._-]+/gu, "_");
}

function writeAtomically(target, content) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, content);
  fs.renameSync(temporary, target);
}

function removeStale(root, directory, keep) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    if (`${relative}/`.startsWith(LOCAL_ONLY_PREFIX)) continue;
    if (entry.isDirectory()) {
      removeStale(root, absolute, keep);
      try {
        fs.rmdirSync(absolute);
      } catch {
        // Not empty: still holds records.
      }
    } else if (!keep.has(relative)) {
      fs.rmSync(absolute, { force: true });
    }
  }
}
