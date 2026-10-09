import {
  computeStableHash,
} from "../canonical.mjs";
import {
  childProcess,
  process,
} from "../runtime/host.mjs";

/**
 * Git side of every coordination record agentic-sdlc shares through a
 * project's remote (used standing-approval slots and revocations, story
 * claims and their releases). Lock files serialize processes on one checkout
 * only; a ref created on the remote only if it does not exist yet is the one
 * arbiter every clone reaches.
 *
 * Every call runs git without prompts, hooks, or signing, in the C locale,
 * bounded by the configured timeout, and reports failures as data with
 * credential-free messages. Records are only ever added: fetched records stay
 * in local tracking refs (never pruned or overwritten), so a record seen once
 * is never forgotten and a record that later disappears from or changes on
 * the remote is reported.
 */

const SHARED_IDENTITY = Object.freeze({
  GIT_AUTHOR_NAME: "agentic-sdlc",
  GIT_AUTHOR_EMAIL: "agentic-sdlc@users.noreply.invalid",
  GIT_COMMITTER_NAME: "agentic-sdlc",
  GIT_COMMITTER_EMAIL: "agentic-sdlc@users.noreply.invalid",
});
const NO_SUCH_REMOTE = /no such remote/iu;
// Unseen records are fetched in batches so a long backlog stays within command-line limits.
const FETCH_BATCH = 50;

export function runGit(root, args, { timeoutSeconds, input = null, env = {} } = {}) {
  const result = childProcess.spawnSync("git", [
    "-C", root,
    "-c", "commit.gpgSign=false",
    "-c", "push.gpgSign=false",
    "-c", "push.negotiate=false",
    "-c", "core.hooksPath=/dev/null",
    ...args,
  ], {
    encoding: "utf8",
    input: input ?? "",
    timeout: timeoutSeconds * 1000,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      // Messages are matched in English whatever the user's language.
      LC_ALL: "C",
      LANG: "C",
      LANGUAGE: "C",
      GIT_ASKPASS: "",
      SSH_ASKPASS: "",
      // A remote that accepts the connection but never answers ends the HTTP helper too.
      GIT_HTTP_LOW_SPEED_LIMIT: "1",
      GIT_HTTP_LOW_SPEED_TIME: String(Math.max(1, timeoutSeconds - 1)),
      ...env,
    },
    windowsHide: true,
  });
  const timedOut = result.error?.code === "ETIMEDOUT";
  return {
    ok: result.status === 0 && !result.error,
    status: result.status,
    timedOut,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
    error: timedOut ? `no answer within ${timeoutSeconds} seconds` : result.error?.message || null,
  };
}

export function firstLine(text) {
  return String(text || "").split(/\r?\n/u).map((line) => line.trim()).find(Boolean) || "";
}

/** A short, credential-free reason; remote URLs and local paths are never echoed. */
export function gitFailure(result) {
  if (result.error) return result.error;
  const lines = String(result.stderr || "").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const line = (lines.find((candidate) => /^(fatal|error|remote|!)/iu.test(candidate)) || lines[0] || "")
    .replace(/^(fatal|error):\s*/iu, "")
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/giu, "the remote")
    .replace(/(\/\/)[^/\s@]+@/gu, "$1")
    .replace(/'[^']*'/gu, (quoted) => (/[/\\@:]/u.test(quoted) ? "the remote" : quoted));
  return line ? line.slice(0, 200) : `git exited with status ${result.status}`;
}

/**
 * Credential-free identity of a remote URL, kept only as a hash. The scheme,
 * user, default port, `www.`, letter case, and a trailing `.git` do not
 * matter, so the https, ssh, and scp-like forms of one repository match.
 */
export function remoteFingerprint(url) {
  const raw = String(url || "").trim();
  if (!raw) return null;
  let host = "";
  let repositoryPath = raw;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/([^/]*)(.*)$/iu.exec(raw);
  const scpLike = /^(?:[^@/\s]+@)?([^/:\s]+):(?!\/\/)(.*)$/u.exec(raw);
  if (scheme && scheme[1].toLowerCase() !== "file") {
    // Only the default ports of git's transports are dropped; another port is another server.
    host = scheme[2].replace(/^[^@]*@/u, "").replace(/:(?:22|80|443|9418)$/u, "");
    repositoryPath = scheme[3];
  } else if (scheme) {
    repositoryPath = scheme[3];
  } else if (scpLike && !/^[A-Za-z]$/u.test(scpLike[1])) {
    host = scpLike[1];
    repositoryPath = scpLike[2];
  }
  const canonicalPath = repositoryPath
    .replace(/\\/gu, "/")
    .split("/")
    .filter((part) => part && part !== ".")
    .join("/")
    .replace(/\.git$/iu, "");
  const canonicalHost = host.toLowerCase().replace(/^www\./u, "");
  // Hosting services that ignore letter case in repository paths; elsewhere case matters.
  const caseInsensitive = ["github.com", "gitlab.com", "bitbucket.org", "dev.azure.com", "ssh.dev.azure.com"].includes(canonicalHost);
  const canonical = `${canonicalHost}/${caseInsensitive ? canonicalPath.toLowerCase() : canonicalPath}`;
  return computeStableHash({ remote: canonical });
}

const repositories = new Map();
const resolvedRemotes = new Map();
const unreachableRemotes = new Map();

/** Forgets what this process learned about repositories and remotes, so the next read asks git again. */
export function forgetSharedRefState() {
  repositories.clear();
  resolvedRemotes.clear();
  unreachableRemotes.clear();
}

/** True when the project is inside a git work tree; a project without git simply has no remote. */
export function isGitRepository(context, timeoutSeconds) {
  if (repositories.has(context.root)) return repositories.get(context.root);
  const probe = runGit(context.root, ["rev-parse", "--git-dir"], { timeoutSeconds });
  const result = probe.ok ? true : (!probe.error && /not a git repository/iu.test(probe.stderr) ? false : null);
  repositories.set(context.root, result);
  return result;
}

function resolveRemote(context, coordination) {
  const key = `${context.root}\u0000${coordination.remote}`;
  if (resolvedRemotes.has(key)) return resolvedRemotes.get(key);
  const repository = isGitRepository(context, coordination.timeout_seconds);
  if (repository === false) {
    const resolved = { configured: false, repository: false };
    resolvedRemotes.set(key, resolved);
    return resolved;
  }
  const url = runGit(context.root, ["remote", "get-url", coordination.remote], { timeoutSeconds: coordination.timeout_seconds });
  let resolved;
  if (url.ok && firstLine(url.stdout)) {
    // The fetch address is also where records are pushed, so a separate push
    // address (a fork, for example) can never split what is written from what is read.
    resolved = { configured: true, url: firstLine(url.stdout), fingerprint: remoteFingerprint(firstLine(url.stdout)) };
  } else if (!url.error && (url.status === 2 || NO_SUCH_REMOTE.test(url.stderr))) {
    resolved = { configured: false };
  } else {
    // Any other failure (for example an untrusted repository owner) is not "no remote".
    resolved = { configured: null, error: gitFailure(url) };
  }
  resolvedRemotes.set(key, resolved);
  return resolved;
}

/**
 * Where coordination records are kept: `local` when sharing is off or (in
 * auto mode) no remote is configured; otherwise `shared`, possibly with
 * `unavailable` when the remote cannot be used. `setting` names the
 * configuration path in the notes.
 */
export function resolveSharedScope(context, coordination, setting) {
  if (coordination.mode === "local_only") {
    return { scope: "local", note: `sharing is turned off (${setting}.mode is local_only)` };
  }
  const remote = resolveRemote(context, coordination);
  if (remote.configured === true) {
    return { scope: "shared", remote: coordination.remote, url: remote.url, fingerprint: remote.fingerprint };
  }
  if (remote.configured === null) {
    return { scope: "shared", remote: coordination.remote, unavailable: `the git remote '${coordination.remote}' cannot be read (${remote.error})` };
  }
  if (coordination.mode === "required") {
    return {
      scope: "shared",
      remote: coordination.remote,
      unavailable: remote.repository === false
        ? "this project is not a git repository"
        : `the git remote '${coordination.remote}' is not configured`,
    };
  }
  return { scope: "local", note: `checked on this computer only: the git remote '${coordination.remote}' is not configured` };
}

function parseRefRecords(output) {
  // Records are "<ref>\0<object>\0<message>\0" followed by the newline for-each-ref adds.
  const fields = output.split("\u0000");
  const refs = [];
  for (let index = 0; index + 2 < fields.length; index += 3) {
    refs.push({ trackingRef: fields[index].replace(/^\r?\n/u, ""), objectName: fields[index + 1], message: fields[index + 2] });
  }
  return refs;
}

/** Refs of this repository under the given prefixes, each with its object and commit message. */
export function listLocalRefs(context, prefixes, timeoutSeconds) {
  const listed = runGit(context.root, [
    "for-each-ref", "--format=%(refname)%00%(objectname)%00%(contents)%00", ...prefixes,
  ], { timeoutSeconds });
  return listed.ok ? { refs: parseRefRecords(listed.stdout) } : { error: gitFailure(listed) };
}

function remoteKey(context, remote) {
  return `${context.root}\u0000${remote}`;
}

/** Why the remote was found unreachable earlier in this process, or null; it is not asked again. */
/** Remembers, for this process, that a remote did not answer, so later reads do not wait for it again. */
export function markRemoteUnreachable(context, remote, error) {
  unreachableRemotes.set(remoteKey(context, remote), error);
}

export function knownUnreachableRemote(context, remote) {
  return unreachableRemotes.get(remoteKey(context, remote)) ?? null;
}

/**
 * Reads the shared refs under `<sharedRoot>/<prefix>` with one listing of the
 * remote, one fetch (in batches) of the records not seen here yet, and one
 * local listing. Fetched records go to `<trackingRoot>/<prefix>` without "+"
 * and without pruning, so a record seen once is never replaced or removed
 * here. Returns `{ available: false, error }` or `{ available: true, records,
 * problems }`, where records are `{ ref, objectName, message }` under their
 * shared names and problems are `{ ref, message }` for records seen before
 * that are gone from or changed on the remote. `describe(ref)` names a record
 * in those messages.
 */
export function readSharedRefs(context, { remote, sharedRoot, trackingRoot, prefix = "", timeoutSeconds, describe }) {
  const sharedPrefix = `${sharedRoot}/${prefix}`;
  const trackingPrefix = `${trackingRoot}/${prefix}`;
  const key = remoteKey(context, remote);
  const listing = runGit(context.root, ["ls-remote", "--refs", remote, `${sharedPrefix}*`], { timeoutSeconds });
  if (!listing.ok) {
    const error = gitFailure(listing);
    unreachableRemotes.set(key, error);
    return { available: false, error };
  }
  const remoteRefs = new Map(listing.stdout.split(/\r?\n/u).filter(Boolean)
    .map((line) => line.split(/\s+/u))
    .filter(([, ref]) => ref?.startsWith(sharedPrefix))
    .map(([objectName, ref]) => [ref, objectName]));
  const sharedName = (trackingRef) => `${sharedRoot}/${trackingRef.slice(trackingRoot.length + 1)}`;
  let tracked = listLocalRefs(context, [trackingPrefix], timeoutSeconds);
  if (tracked.error) return { available: false, error: tracked.error };
  const problems = [];
  const seen = new Map(tracked.refs.map((item) => [sharedName(item.trackingRef), item.objectName]));
  for (const [ref, objectName] of seen) {
    if (!remoteRefs.has(ref)) problems.push({ ref, message: `${describe(ref)}, recorded before, is gone from the remote` });
    else if (remoteRefs.get(ref) !== objectName) problems.push({ ref, message: `${describe(ref)} changed on the remote after it was recorded` });
  }
  const unseen = [...remoteRefs.keys()].filter((ref) => !seen.has(ref));
  if (unseen.length > 0) {
    for (let start = 0; start < unseen.length; start += FETCH_BATCH) {
      // No "+" and no prune: a record already seen is never replaced or removed here.
      const fetched = runGit(context.root, [
        "fetch", "--quiet", "--no-tags", "--no-recurse-submodules", remote,
        ...unseen.slice(start, start + FETCH_BATCH).map((ref) => `${ref}:${trackingRoot}/${ref.slice(sharedRoot.length + 1)}`),
      ], { timeoutSeconds });
      if (!fetched.ok) {
        const error = gitFailure(fetched);
        if (fetched.timedOut) unreachableRemotes.set(key, error);
        return { available: false, error };
      }
    }
    tracked = listLocalRefs(context, [trackingPrefix], timeoutSeconds);
    if (tracked.error) return { available: false, error: tracked.error };
  }
  return {
    available: true,
    records: tracked.refs.map((item) => ({ ref: sharedName(item.trackingRef), objectName: item.objectName, message: item.message })),
    problems,
  };
}

/** Writes one serialized payload as a parentless commit with an empty tree and returns its object name. */
export function writeRecordCommit(context, timeoutSeconds, message) {
  const tree = runGit(context.root, ["hash-object", "-t", "tree", "-w", "--stdin"], { timeoutSeconds });
  if (!tree.ok) return { error: gitFailure(tree) };
  const commit = runGit(context.root, ["commit-tree", firstLine(tree.stdout), "-F", "-"], {
    timeoutSeconds,
    input: message,
    env: SHARED_IDENTITY,
  });
  return commit.ok ? { objectName: firstLine(commit.stdout) } : { error: gitFailure(commit) };
}

/** Creates a ref in this repository only if it does not exist yet. */
export function createLocalRef(context, ref, objectName, timeoutSeconds) {
  const updated = runGit(context.root, ["update-ref", ref, objectName, ""], { timeoutSeconds });
  return updated.ok ? { created: true } : { error: gitFailure(updated) };
}

/**
 * Pushes one record to the remote's fetch address (never to a separate push
 * address), where it is accepted only if the ref does not exist yet. On
 * success the record is also kept as seen under `trackingRef`, so it is
 * checked like any other shared record. Returns `{ pushed: true }` or
 * `{ pushed: false, error, timedOut }`; a refusal is never read as success.
 */
export function pushCreateOnlyRef(context, { url, ref, objectName, trackingRef, timeoutSeconds }) {
  // An empty expected value makes the remote accept the update only if the ref does not exist.
  const pushed = runGit(context.root, [
    "push", "--porcelain", "--no-verify", `--force-with-lease=${ref}:`, url, `${objectName}:${ref}`,
  ], { timeoutSeconds });
  if (pushed.ok) {
    runGit(context.root, ["update-ref", trackingRef, objectName, ""], { timeoutSeconds });
    return { pushed: true };
  }
  return { pushed: false, error: gitFailure(pushed), timedOut: pushed.timedOut };
}

/** Points a ref of this repository at an object, replacing what it held. */
export function setLocalRef(context, ref, objectName, timeoutSeconds) {
  const updated = runGit(context.root, ["update-ref", ref, objectName], { timeoutSeconds });
  return updated.ok ? { set: true } : { error: gitFailure(updated) };
}

/** Removes a ref of this repository; a missing ref is not an error. */
export function deleteLocalRef(context, ref, timeoutSeconds) {
  const deleted = runGit(context.root, ["update-ref", "-d", ref], { timeoutSeconds });
  return deleted.ok ? { deleted: true } : { error: gitFailure(deleted) };
}

/**
 * What one ref on the remote holds right now: `{ objectName }` (null when it
 * does not exist) or `{ error }` when the remote cannot be read. Used after a
 * push whose outcome is unknown, so a record is never assumed written or lost.
 */
export function remoteRefObject(context, url, ref, timeoutSeconds) {
  const listing = runGit(context.root, ["ls-remote", "--refs", url, ref], { timeoutSeconds });
  if (!listing.ok) return { error: gitFailure(listing) };
  const line = listing.stdout.split(/\r?\n/u).map((item) => item.split(/\s+/u)).find(([, name]) => name === ref);
  return { objectName: line ? line[0] : null };
}
