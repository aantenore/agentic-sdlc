import {
  childProcess,
  process,
} from "../runtime/host.mjs";
import {
  buildSharedRevocationPayload,
  buildSharedSlotPayload,
  interpretSharedRefs,
  serializeSharedPayload,
  standingSharedFetchRefspec,
  standingSharedRefForTracking,
  standingSharedRevocationRef,
  standingSharedSlotRef,
  standingSharedTrackingPrefix,
} from "../standing-shared-state.mjs";

/**
 * Git side of the shared standing-approval state. Every call runs git without
 * prompts, hooks, or signing, bounded by the configured timeout, and reports
 * failures as data so the caller can fall back to the normal confirmation.
 */

const EMPTY_INPUT = "";
const SHARED_IDENTITY = Object.freeze({
  GIT_AUTHOR_NAME: "agentic-sdlc",
  GIT_AUTHOR_EMAIL: "agentic-sdlc@users.noreply.invalid",
  GIT_COMMITTER_NAME: "agentic-sdlc",
  GIT_COMMITTER_EMAIL: "agentic-sdlc@users.noreply.invalid",
});

function runGit(root, args, { timeoutSeconds, input = null, env = {} } = {}) {
  const result = childProcess.spawnSync("git", [
    "-C", root,
    "-c", "commit.gpgSign=false",
    "-c", "core.hooksPath=/dev/null",
    ...args,
  ], {
    encoding: "utf8",
    input: input ?? EMPTY_INPUT,
    timeout: timeoutSeconds * 1000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "", ...env },
    windowsHide: true,
  });
  const timedOut = result.error?.code === "ETIMEDOUT";
  return {
    ok: result.status === 0 && !result.error,
    status: result.status,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
    error: timedOut ? `no answer within ${timeoutSeconds} seconds` : result.error?.message || null,
  };
}

function firstLine(text) {
  return String(text || "").split(/\r?\n/u).map((line) => line.trim()).find(Boolean) || "";
}

function gitFailure(result) {
  if (result.error) return result.error;
  // Remote URLs may carry credentials; only the host part is ever shown.
  const line = firstLine(result.stderr)
    .replace(/^(fatal|error):\s*/iu, "")
    .replace(/(\/\/)[^/\s@]+@/gu, "$1")
    .replace(/'[^']*'/gu, (quoted) => (/[/\\]/u.test(quoted) ? "the remote" : quoted));
  return line ? line.slice(0, 200) : `git exited with status ${result.status}`;
}

/**
 * Where this project shares standing-approval state. `auto` shares when the
 * configured remote exists; `required` refuses to proceed without it.
 */
export function resolveStandingScope(context, coordination) {
  if (coordination.mode === "local_only") {
    return { scope: "local", note: "sharing is turned off (standing_approval_policy.coordination.mode is local_only)" };
  }
  const url = runGit(context.root, ["remote", "get-url", coordination.remote], { timeoutSeconds: coordination.timeout_seconds });
  if (url.ok && firstLine(url.stdout)) {
    return { scope: "shared", remote: coordination.remote };
  }
  if (coordination.mode === "required") {
    return {
      scope: "shared",
      remote: coordination.remote,
      unavailable: `the git remote '${coordination.remote}' is not configured`,
    };
  }
  return { scope: "local", note: `checked on this computer only: the git remote '${coordination.remote}' is not configured` };
}

const fetchedState = new Map();

/** Forgets fetched state so the next read asks the remote again. */
export function forgetSharedStandingState() {
  fetchedState.clear();
}

/**
 * Fetches and interprets the shared refs of one standing approval. The result
 * is cached for the rest of this command; publishing clears the cache.
 */
export function readSharedStandingState(context, proposal, coordination) {
  const target = resolveStandingScope(context, coordination);
  if (target.scope !== "shared") return target;
  const key = `${context.root}\u0000${proposal.id}\u0000${proposal.record_hash}`;
  if (fetchedState.has(key)) return fetchedState.get(key);
  const base = { scope: "shared", remote: target.remote, slots: [], revoked: null, errors: [] };
  if (target.unavailable) return { ...base, available: false, error: target.unavailable };
  const timeoutSeconds = coordination.timeout_seconds;
  const fetched = runGit(context.root, [
    "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--prune", "--no-recurse-submodules",
    target.remote, standingSharedFetchRefspec(proposal),
  ], { timeoutSeconds });
  if (!fetched.ok) return { ...base, available: false, error: gitFailure(fetched) };
  const listed = runGit(context.root, [
    "for-each-ref", "--format=%(refname) %(objectname)", standingSharedTrackingPrefix(proposal),
  ], { timeoutSeconds });
  if (!listed.ok) return { ...base, available: false, error: gitFailure(listed) };
  const refs = [];
  for (const line of listed.stdout.split(/\r?\n/u).filter(Boolean)) {
    const [trackingRef, objectName] = line.split(" ");
    const message = runGit(context.root, ["log", "-1", "--format=%B", objectName], { timeoutSeconds });
    refs.push({ ref: standingSharedRefForTracking(trackingRef), message: message.ok ? message.stdout : "" });
  }
  const state = { ...base, available: true, error: null, ...interpretSharedRefs(proposal, refs) };
  fetchedState.set(key, state);
  return state;
}

/**
 * Creates one shared ref only if it does not exist on the remote yet. Returns
 * `{ published: true }`, `{ conflict: true }` when the ref already exists, or
 * `{ error }` when the remote could not be reached.
 */
function publishSharedRef(context, coordination, remote, ref, payload) {
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
  forgetSharedStandingState();
  if (pushed.ok) return { published: true };
  const rejected = /^!\s/mu.test(pushed.stdout) || /stale info|already exists|rejected/iu.test(`${pushed.stdout}\n${pushed.stderr}`);
  return rejected ? { conflict: true } : { error: gitFailure(pushed) };
}

/** Claims one slot on the remote for this exact delivery profile. */
export function claimSharedStandingSlot(context, coordination, remote, { proposal, slot, delivery, profileRef }) {
  return publishSharedRef(
    context,
    coordination,
    remote,
    standingSharedSlotRef(proposal, slot),
    buildSharedSlotPayload({ proposal, slot, delivery, profileRef }),
  );
}

/** Publishes a revocation; an existing shared revocation counts as published. */
export function publishSharedStandingRevocation(context, coordination, remote, { proposal, revocation }) {
  const result = publishSharedRef(
    context,
    coordination,
    remote,
    standingSharedRevocationRef(proposal),
    buildSharedRevocationPayload({ proposal, revocation }),
  );
  return result.conflict ? { published: true, already: true } : result;
}
