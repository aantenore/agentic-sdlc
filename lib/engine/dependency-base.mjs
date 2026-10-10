import os from "node:os";
import path from "node:path";
import { fs } from "../runtime/host.mjs";
import { orchestrationPolicy } from "../story-claim-shared-state.mjs";
import { buildContext } from "./common.mjs";
import { remoteBaseRef } from "./merge-drift.mjs";
import { runGit } from "./shared-refs.mjs";

// A story whose final certification reached the base branch but not this
// branch: its records are read from a throw-away checkout of the base tip,
// outside the working tree, and judged by the same checks used locally.
const GIT_TIMEOUT_SECONDS = 120;
const baseCheckouts = new Map();
const verdicts = new Map();
let cleanupRegistered = false;

function removeCheckouts() {
  for (const checkout of baseCheckouts.values()) {
    if (checkout.root) fs.rmSync(checkout.root, { recursive: true, force: true });
  }
  baseCheckouts.clear();
}

function resolveBase(context) {
  try {
    const policy = orchestrationPolicy(context.config);
    const base = remoteBaseRef(context, policy.coordination.remote, policy.merge_drift.base_branch, GIT_TIMEOUT_SECONDS);
    if (!base) return null;
    const resolved = runGit(context.root, ["rev-parse", "--verify", "--quiet", `${base.ref}^{commit}`], {
      timeoutSeconds: GIT_TIMEOUT_SECONDS,
    });
    const sha = resolved.stdout.trim();
    return resolved.ok && sha ? { sha, ref: base.ref } : null;
  } catch {
    return null;
  }
}

function baseHasFinalReceipt(context, sha, storyId) {
  const entry = `${sha}:.sdlc/gates/${storyId}-final.json`;
  return runGit(context.root, ["cat-file", "-e", entry], { timeoutSeconds: GIT_TIMEOUT_SECONDS }).ok;
}

function baseCheckout(context, base) {
  const key = `${context.root}\0${base.sha}`;
  if (baseCheckouts.has(key)) return baseCheckouts.get(key).context;
  const record = { root: null, context: null };
  baseCheckouts.set(key, record);
  if (!cleanupRegistered) {
    cleanupRegistered = true;
    process.on("exit", removeCheckouts);
  }
  try {
    record.root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-sdlc-base-"));
    const git = (args, root = record.root) => runGit(root, args, { timeoutSeconds: GIT_TIMEOUT_SECONDS });
    const cloned = git(["clone", "--quiet", "--shared", "--no-checkout", context.root, record.root], path.dirname(record.root));
    if (!cloned.ok) return null;
    if (!git(["update-ref", base.ref, base.sha]).ok) return null;
    if (!git(["checkout", "--quiet", "--detach", base.sha]).ok) return null;
    record.context = buildContext({ root: record.root, "template-dir": context.templateDir });
    record.context.dependencyBaseProbe = true;
  } catch {
    record.context = null;
  }
  return record.context;
}

/**
 * Where a dependency on `edge.to` is satisfied by the base branch although
 * this branch lacks the story's certification: { sha, ref } when the story's
 * records at the base tip pass `isSatisfied` (the local check, run on the
 * base checkout), else null. Never writes to the working tree.
 */
export function dependencyBaseCertification(context, edge, isSatisfied) {
  if (context.dependencyBaseProbe || !edge?.to) return null;
  const base = resolveBase(context);
  if (!base) return null;
  const key = `${context.root}\0${base.sha}\0${JSON.stringify(edge)}`;
  if (verdicts.has(key)) return verdicts.get(key);
  let verdict = null;
  try {
    if (baseHasFinalReceipt(context, base.sha, edge.to)) {
      const baseContext = baseCheckout(context, base);
      if (baseContext && isSatisfied(baseContext)) verdict = base;
    }
  } catch {
    verdict = null;
  }
  verdicts.set(key, verdict);
  return verdict;
}
