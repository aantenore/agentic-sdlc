import path from "node:path";
import {
  autonomyActionsRoot,
} from "../lifecycle/project.mjs";
import {
  fs,
} from "../runtime/host.mjs";
import {
  gitFailure,
  runGit,
} from "./shared-refs.mjs";

/**
 * Keeps the commits a story delivered readable by every clone. A git.commit
 * receipt is re-checked against its own commits (parent, file set, tree);
 * a squash or rebase merge, or a deleted branch, leaves those commits on no
 * branch, so other clones never receive them and the receipt can no longer
 * be re-checked there.
 *
 *   refs/agentic-sdlc/commits/<sha>          on the remote: pins a delivered commit
 *   refs/agentic-sdlc-shared/commits/<sha>   here: a pinned commit fetched from the remote
 *
 * The finishing computer pins its story's commits when the story's
 * completion is shared; status fetches the commits its receipts name and
 * this clone lacks, from those pins or by object ID (which GitHub and most
 * servers answer for commits still reachable from a pull-request ref).
 * Everything here is best effort: a failure leaves the receipt reported as
 * not re-checkable, never as invalid.
 */
export const DELIVERY_COMMIT_SHARED_ROOT = "refs/agentic-sdlc/commits";
export const DELIVERY_COMMIT_TRACKING_ROOT = "refs/agentic-sdlc-shared/commits";

const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
// Bounds a fallback that asks the remote one commit at a time.
const SINGLE_FETCH_LIMIT = 20;

/** The commits (before and after) of the git.commit completion receipts given, deduplicated. */
export function gitCommitReceiptShas(receipts) {
  const shas = new Set();
  for (const receipt of receipts || []) {
    if (receipt?.action !== "git.commit") continue;
    const commit = receipt.action_details?.commit;
    for (const sha of [commit?.before_sha, commit?.after_sha]) {
      if (typeof sha === "string" && OBJECT_ID.test(sha)) shas.add(sha);
    }
  }
  return [...shas].sort();
}

/** Commits named by every git.commit receipt on disk, read without validating the receipts. */
export function recordedDeliveryCommitShas(context) {
  let root;
  let names;
  try {
    root = autonomyActionsRoot(context);
    names = fs.readdirSync(root).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const receipts = [];
  for (const name of names) {
    try {
      receipts.push(JSON.parse(fs.readFileSync(path.join(root, name), "utf8")));
    } catch {
      // Unreadable receipts are reported by the validators, not here.
    }
  }
  return gitCommitReceiptShas(receipts);
}

/** Which of these commits this clone does not hold, asked with one git process. */
export function missingCommitObjects(context, shas, timeoutSeconds) {
  if (shas.length === 0) return [];
  const checked = runGit(context.root, ["cat-file", "--batch-check"], {
    timeoutSeconds,
    input: shas.map((sha) => `${sha}^{commit}\n`).join(""),
  });
  if (!checked.ok) return [];
  const missing = new Set(checked.stdout.split(/\r?\n/u)
    .map((line) => /^(\S+)\^\{commit\} missing$/u.exec(line.trim())?.[1])
    .filter(Boolean));
  return shas.filter((sha) => missing.has(sha));
}

function fetchInto(context, remote, refspecs, timeoutSeconds) {
  return runGit(context.root, [
    "fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", remote, ...refspecs,
  ], { timeoutSeconds });
}

/**
 * Fetches from `remote` the delivered commits this clone lacks. Returns null
 * when no receipt names a commit, otherwise `{ checked, missing, recovered,
 * unavailable, error }`: `unavailable` lists the commits still missing.
 */
export function recoverDeliveryCommits(context, { remote, timeoutSeconds }) {
  const shas = recordedDeliveryCommitShas(context);
  if (shas.length === 0) return null;
  const missing = missingCommitObjects(context, shas, timeoutSeconds);
  const result = { checked: shas.length, missing: missing.length, recovered: 0, unavailable: [], error: null };
  if (missing.length === 0) return result;
  const listing = runGit(context.root, ["ls-remote", "--refs", remote, `${DELIVERY_COMMIT_SHARED_ROOT}/*`], { timeoutSeconds });
  if (!listing.ok) return { ...result, unavailable: missing, error: gitFailure(listing) };
  const pinned = new Set(listing.stdout.split(/\r?\n/u)
    .map((line) => line.trim().split(/\s+/u))
    .filter(([objectName, ref]) => ref === `${DELIVERY_COMMIT_SHARED_ROOT}/${objectName}`)
    .map(([objectName]) => objectName));
  const tracking = (sha) => `${DELIVERY_COMMIT_TRACKING_ROOT}/${sha}`;
  // Pinned commits by their ref; the others by object ID, kept under the same tracking refs.
  const byRef = missing.filter((sha) => pinned.has(sha));
  const byId = missing.filter((sha) => !pinned.has(sha));
  let error = null;
  if (byRef.length > 0) {
    const fetched = fetchInto(context, remote, byRef.map((sha) => `${DELIVERY_COMMIT_SHARED_ROOT}/${sha}:${tracking(sha)}`), timeoutSeconds);
    if (!fetched.ok) error = gitFailure(fetched);
  }
  if (byId.length > 0) {
    const fetched = fetchInto(context, remote, byId.map((sha) => `${sha}:${tracking(sha)}`), timeoutSeconds);
    if (!fetched.ok && !fetched.timedOut) {
      // One commit the remote no longer has fails the whole request: ask for each alone.
      for (const sha of byId.slice(0, SINGLE_FETCH_LIMIT)) {
        const single = fetchInto(context, remote, [`${sha}:${tracking(sha)}`], timeoutSeconds);
        if (single.timedOut) break;
      }
    } else if (!fetched.ok) {
      error = gitFailure(fetched);
    }
  }
  const unavailable = missingCommitObjects(context, missing, timeoutSeconds);
  return { ...result, recovered: missing.length - unavailable.length, unavailable, error };
}

/**
 * Pins these commits on the remote under refs/agentic-sdlc/commits/, each
 * ref created only if it does not exist yet. Commits this clone lacks are
 * skipped. Returns `{ pinned, error }`; a refusal of an existing pin is not
 * an error.
 */
export function pinDeliveryCommits(context, { url, shas, timeoutSeconds }) {
  const absent = new Set(missingCommitObjects(context, shas, timeoutSeconds));
  const present = shas.filter((sha) => !absent.has(sha));
  if (!url || present.length === 0) return { pinned: 0, error: null };
  const listing = runGit(context.root, ["ls-remote", "--refs", url, `${DELIVERY_COMMIT_SHARED_ROOT}/*`], { timeoutSeconds });
  if (!listing.ok) return { pinned: 0, error: gitFailure(listing) };
  const existing = new Set(listing.stdout.split(/\r?\n/u).map((line) => line.trim().split(/\s+/u)[1]).filter(Boolean));
  const toPin = present.filter((sha) => !existing.has(`${DELIVERY_COMMIT_SHARED_ROOT}/${sha}`));
  if (toPin.length === 0) return { pinned: 0, error: null };
  const pushed = runGit(context.root, [
    "push", "--porcelain", "--no-verify",
    ...toPin.map((sha) => `--force-with-lease=${DELIVERY_COMMIT_SHARED_ROOT}/${sha}:`),
    url,
    ...toPin.map((sha) => `${sha}:${DELIVERY_COMMIT_SHARED_ROOT}/${sha}`),
  ], { timeoutSeconds });
  return pushed.ok ? { pinned: toPin.length, error: null } : { pinned: 0, error: gitFailure(pushed) };
}
