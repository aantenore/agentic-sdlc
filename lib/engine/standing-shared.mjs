import {
  computeStableHash,
} from "../canonical.mjs";
import {
  childProcess,
  process,
} from "../runtime/host.mjs";
import {
  buildSharedRevocationPayload,
  buildSharedSlotPayload,
  interpretSharedRefs,
  serializeSharedPayload,
  standingSharedRefForTracking,
  standingSharedRevocationRef,
  standingSharedSlotRef,
  standingSharedTrackingPrefix,
  STANDING_SHARED_REF_ROOT,
  STANDING_SHARED_TRACKING_ROOT,
  standingSharedNamespace,
} from "../standing-shared-state.mjs";

/**
 * Git side of the shared standing-approval state. Every call runs git without
 * prompts, hooks, or signing, bounded by the configured timeout, and reports
 * failures as data so the caller can fall back to the normal confirmation.
 *
 * Shared records are only ever added: fetched records stay in local tracking
 * refs (never pruned or overwritten), so a revocation or a used slot seen once
 * is never forgotten, and a record that later disappears from or changes on
 * the remote makes the shared state untrustworthy.
 */

const SHARED_IDENTITY = Object.freeze({
  GIT_AUTHOR_NAME: "agentic-sdlc",
  GIT_AUTHOR_EMAIL: "agentic-sdlc@users.noreply.invalid",
  GIT_COMMITTER_NAME: "agentic-sdlc",
  GIT_COMMITTER_EMAIL: "agentic-sdlc@users.noreply.invalid",
});
const NO_SUCH_REMOTE = /no such remote/iu;

function runGit(root, args, { timeoutSeconds, input = null, env = {} } = {}) {
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

function firstLine(text) {
  return String(text || "").split(/\r?\n/u).map((line) => line.trim()).find(Boolean) || "";
}

/** A short, credential-free reason; remote URLs and local paths are never echoed. */
function gitFailure(result) {
  if (result.error) return result.error;
  const lines = String(result.stderr || "").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const line = (lines.find((candidate) => /^(fatal|error|remote|!)/iu.test(candidate)) || lines[0] || "")
    .replace(/^(fatal|error):\s*/iu, "")
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/giu, "the remote")
    .replace(/(\/\/)[^/\s@]+@/gu, "$1")
    .replace(/'[^']*'/gu, (quoted) => (/[/\\@:]/u.test(quoted) ? "the remote" : quoted));
  return line ? line.slice(0, 200) : `git exited with status ${result.status}`;
}

/** Credential-free identity of a remote URL, kept only as a hash. */
export function remoteFingerprint(url) {
  const normalized = String(url || "").trim()
    .replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/iu, "$1")
    .replace(/^[^/@\s:]+@([^/:\s]+):/u, "ssh://$1/")
    .replace(/^([a-z][a-z0-9+.-]*:\/\/[^/]+)/iu, (prefix) => prefix.toLowerCase())
    .replace(/\\/gu, "/")
    .replace(/\/+$/u, "")
    .replace(/\.git$/iu, "");
  return normalized ? computeStableHash({ remote_url: normalized }) : null;
}

const resolvedRemotes = new Map();
const unreachableRemotes = new Map();
const fetchedState = new Map();

/** Forgets everything learned in this process, so the next read asks git again. */
export function forgetSharedStandingState() {
  resolvedRemotes.clear();
  unreachableRemotes.clear();
  fetchedState.clear();
}

function resolveRemote(context, coordination) {
  const key = `${context.root}\u0000${coordination.remote}`;
  if (resolvedRemotes.has(key)) return resolvedRemotes.get(key);
  const url = runGit(context.root, ["remote", "get-url", coordination.remote], { timeoutSeconds: coordination.timeout_seconds });
  let resolved;
  if (url.ok && firstLine(url.stdout)) {
    resolved = { configured: true, fingerprint: remoteFingerprint(firstLine(url.stdout)) };
  } else if (!url.error && NO_SUCH_REMOTE.test(url.stderr)) {
    resolved = { configured: false };
  } else {
    // Any other failure (for example an untrusted repository owner) is not "no remote".
    resolved = { configured: null, error: gitFailure(url) };
  }
  resolvedRemotes.set(key, resolved);
  return resolved;
}

/**
 * Where this project shares standing-approval state: `local` when sharing is
 * off or (in auto mode) no remote is configured; otherwise `shared`, possibly
 * with `unavailable` when the remote cannot be used.
 */
export function resolveStandingScope(context, coordination) {
  if (coordination.mode === "local_only") {
    return { scope: "local", note: "sharing is turned off (standing_approval_policy.coordination.mode is local_only)" };
  }
  const remote = resolveRemote(context, coordination);
  if (remote.configured === true) {
    return { scope: "shared", remote: coordination.remote, fingerprint: remote.fingerprint };
  }
  if (remote.configured === null) {
    return { scope: "shared", remote: coordination.remote, unavailable: `the git remote '${coordination.remote}' cannot be read (${remote.error})` };
  }
  if (coordination.mode === "required") {
    return { scope: "shared", remote: coordination.remote, unavailable: `the git remote '${coordination.remote}' is not configured` };
  }
  return { scope: "local", note: `checked on this computer only: the git remote '${coordination.remote}' is not configured` };
}

/** The sharing scope recorded on a standing approval when it is proposed. */
export function standingCoordinationRecord(context, coordination) {
  const scope = resolveStandingScope(context, coordination);
  return scope.scope === "shared" && !scope.unavailable
    ? { scope: "shared", remote: scope.remote, remote_fingerprint: scope.fingerprint }
    : { scope: "local", remote: null, remote_fingerprint: null };
}

function parseTrackedRefs(output) {
  // Records are "<ref>\0<object>\0<message>\0" followed by the newline for-each-ref adds.
  const fields = output.split("\u0000");
  const refs = [];
  for (let index = 0; index + 2 < fields.length; index += 3) {
    refs.push({ trackingRef: fields[index].replace(/^\r?\n/u, ""), objectName: fields[index + 1], message: fields[index + 2] });
  }
  return refs;
}

function listTrackedRefs(context, proposal, timeoutSeconds) {
  const listed = runGit(context.root, [
    "for-each-ref", "--format=%(refname)%00%(objectname)%00%(contents)%00", standingSharedTrackingPrefix(proposal),
  ], { timeoutSeconds });
  return listed.ok ? { refs: parseTrackedRefs(listed.stdout) } : { error: gitFailure(listed) };
}

function sharedRecordLabel(ref) {
  const slot = /\/slots\/([0-9]{4})$/u.exec(ref);
  return slot ? `slot ${Number(slot[1])}` : "the revocation";
}

/**
 * Reads the shared refs of one standing approval: one listing of the remote,
 * one fetch when it holds records not seen here yet, and one local listing.
 * The result is cached for the rest of this command; publishing clears it.
 */
export function readSharedStandingState(context, proposal, coordination) {
  const target = resolveStandingScope(context, coordination);
  const recorded = proposal.coordination || null;
  if (target.scope !== "shared") {
    if (recorded?.scope === "shared" && coordination.mode !== "local_only") {
      return {
        scope: "shared",
        remote: recorded.remote || coordination.remote,
        available: false,
        error: `the git remote it was approved with is no longer configured as '${coordination.remote}'`,
        slots: [],
        revoked: null,
        errors: [],
      };
    }
    return target;
  }
  const base = { scope: "shared", remote: target.remote, slots: [], revoked: null, errors: [] };
  if (target.unavailable) return { ...base, available: false, error: target.unavailable };
  if (recorded?.scope === "shared" && recorded.remote_fingerprint && recorded.remote_fingerprint !== target.fingerprint) {
    return { ...base, available: false, error: `the git remote '${target.remote}' is not the one this standing approval was approved with` };
  }
  const remoteKey = `${context.root}\u0000${target.remote}`;
  if (unreachableRemotes.has(remoteKey)) return { ...base, available: false, error: unreachableRemotes.get(remoteKey) };
  const key = `${remoteKey}\u0000${proposal.id}\u0000${proposal.record_hash}`;
  if (fetchedState.has(key)) return fetchedState.get(key);
  const timeoutSeconds = coordination.timeout_seconds;
  const namespace = standingSharedNamespace(proposal);
  const sharedPrefix = `${STANDING_SHARED_REF_ROOT}/${namespace}/`;
  const listing = runGit(context.root, ["ls-remote", "--refs", target.remote, `${sharedPrefix}*`], { timeoutSeconds });
  if (!listing.ok) {
    const error = gitFailure(listing);
    unreachableRemotes.set(remoteKey, error);
    return { ...base, available: false, error };
  }
  const remoteRefs = new Map(listing.stdout.split(/\r?\n/u).filter(Boolean)
    .map((line) => line.split(/\s+/u))
    .filter(([, ref]) => ref?.startsWith(sharedPrefix))
    .map(([objectName, ref]) => [ref, objectName]));
  let tracked = listTrackedRefs(context, proposal, timeoutSeconds);
  if (tracked.error) return { ...base, available: false, error: tracked.error };
  const errors = [];
  const seen = new Map(tracked.refs.map((item) => [standingSharedRefForTracking(item.trackingRef), item.objectName]));
  for (const [ref, objectName] of seen) {
    if (!remoteRefs.has(ref)) errors.push(`${sharedRecordLabel(ref)}, recorded before, is gone from the remote`);
    else if (remoteRefs.get(ref) !== objectName) errors.push(`${sharedRecordLabel(ref)} changed on the remote after it was recorded`);
  }
  const unseen = [...remoteRefs.keys()].filter((ref) => !seen.has(ref));
  if (unseen.length > 0) {
    // No "+" and no prune: a record already seen is never replaced or removed here.
    const trackingRoot = `${STANDING_SHARED_TRACKING_ROOT}/${namespace}/`;
    const fetched = runGit(context.root, [
      "fetch", "--quiet", "--no-tags", "--no-recurse-submodules", target.remote,
      ...unseen.map((ref) => `${ref}:${trackingRoot}${ref.slice(sharedPrefix.length)}`),
    ], { timeoutSeconds });
    if (!fetched.ok) {
      const error = gitFailure(fetched);
      if (fetched.timedOut) unreachableRemotes.set(remoteKey, error);
      return { ...base, available: false, error };
    }
    tracked = listTrackedRefs(context, proposal, timeoutSeconds);
    if (tracked.error) return { ...base, available: false, error: tracked.error };
  }
  const interpreted = interpretSharedRefs(proposal, tracked.refs.map((item) => ({
    ref: standingSharedRefForTracking(item.trackingRef),
    message: item.message,
  })));
  const state = {
    ...base,
    available: true,
    error: null,
    slots: interpreted.slots,
    revoked: interpreted.revoked,
    errors: [...errors, ...interpreted.errors],
  };
  fetchedState.set(key, state);
  return state;
}

/**
 * Creates one shared ref only if it does not exist on the remote yet. Returns
 * `{ published: true }`; `{ existing }` with the record the remote already
 * holds there (re-read after the rejection, never assumed); or `{ error }`.
 */
function publishSharedRef(context, coordination, remote, proposal, ref, payload) {
  const timeoutSeconds = coordination.timeout_seconds;
  const tree = runGit(context.root, ["hash-object", "-t", "tree", "-w", "--stdin"], { timeoutSeconds });
  if (!tree.ok) return { error: gitFailure(tree) };
  const commit = runGit(context.root, ["commit-tree", firstLine(tree.stdout), "-F", "-"], {
    timeoutSeconds,
    input: serializeSharedPayload(payload),
    env: SHARED_IDENTITY,
  });
  if (!commit.ok) return { error: gitFailure(commit) };
  const objectName = firstLine(commit.stdout);
  // An empty expected value makes the remote accept the update only if the ref does not exist.
  const pushed = runGit(context.root, [
    "push", "--porcelain", "--no-verify", `--force-with-lease=${ref}:`, remote, `${objectName}:${ref}`,
  ], { timeoutSeconds });
  fetchedState.clear();
  if (pushed.ok) {
    // Record our own claim as seen, so it is checked like any other shared record.
    const trackingRef = `${STANDING_SHARED_TRACKING_ROOT}/${ref.slice(STANDING_SHARED_REF_ROOT.length + 1)}`;
    runGit(context.root, ["update-ref", trackingRef, objectName, ""], { timeoutSeconds });
    return { published: true };
  }
  const failure = gitFailure(pushed);
  if (pushed.timedOut) return { error: failure };
  const state = readSharedStandingState(context, proposal, coordination);
  if (!state.available) return { error: failure };
  const existing = ref.endsWith("/revoked")
    ? state.revoked
    : state.slots.find((slot) => standingSharedSlotRef(proposal, slot.slot) === ref) || null;
  return existing ? { existing } : { error: failure };
}

/**
 * Claims one slot on the remote for this exact delivery profile. A slot the
 * remote already holds for the same delivery profile counts as claimed.
 */
export function claimSharedStandingSlot(context, coordination, remote, { proposal, slot, delivery, profileRef }) {
  const result = publishSharedRef(
    context,
    coordination,
    remote,
    proposal,
    standingSharedSlotRef(proposal, slot),
    buildSharedSlotPayload({ proposal, slot, delivery, profileRef }),
  );
  if (!result.existing) return result;
  const same = result.existing.delivery?.id === delivery.id
    && result.existing.delivery?.kind === delivery.kind
    && result.existing.profile_ref?.id === profileRef.id
    && result.existing.profile_ref?.hash === profileRef.hash;
  return same ? { published: true, already: true } : { conflict: true, holder: result.existing };
}

/** Publishes a revocation; a valid shared revocation already on the remote counts as published. */
export function publishSharedStandingRevocation(context, coordination, remote, { proposal, revocation }) {
  const result = publishSharedRef(
    context,
    coordination,
    remote,
    proposal,
    standingSharedRevocationRef(proposal),
    buildSharedRevocationPayload({ proposal, revocation }),
  );
  return result.existing ? { published: true, already: true } : result;
}
