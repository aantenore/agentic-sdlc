/**
 * One heavy command at a time per story (or per repository).
 *
 * Mutating commands that contend on the same story files or on git take a
 * lock file under `<git-common-dir>/agentic-sdlc/locks/` created with O_EXCL.
 * A second identical start is refused at once (exit 5) while the holder is a
 * live agentic-sdlc process; a dead, foreign or over-limit holder is taken
 * over. AGENTIC_SDLC_WAIT_FOR_LOCK_SECONDS (default 0) waits instead.
 * Read-only commands are never classified, so they are never blocked.
 */
import crypto from "node:crypto";
import path from "node:path";

import { Date, fs, process } from "../runtime/host.mjs";
import { ageMinutes, findGitCommonDir, isLockStale, locksDirectory } from "./run-registry.mjs";

export const WAIT_FOR_LOCK_ENV = "AGENTIC_SDLC_WAIT_FOR_LOCK_SECONDS";
export const LOCK_BUSY_EXIT_CODE = 5;

export const STORY_EXCLUSIVE_ACTIONS = Object.freeze([
  "gate.check",
  "story.complete-step",
  "workflow.instance.transition",
  "workflow.instance.start",
  "autonomy.delivery.action",
  "autonomy.delivery.propose",
  "autonomy.delivery.approve",
  "autonomy.delivery.amend",
  "autonomy.delivery.evidence.supersede",
  "task.start",
  "story.claim",
  "story.release",
  "output.link",
  "test.record",
  "secret.scan",
  "story.overlap.confirm",
]);

export const REPO_EXCLUSIVE_ACTIONS = Object.freeze([
  "trace.rebase",
  "baseline.refresh",
  "baseline.approve",
  "story.publish-records",
  "story.sync",
]);

const STORY_ID = /^ST-[A-Z0-9][A-Z0-9._-]*$/iu;

function storyFromOptions(options = {}) {
  for (const value of [options.story, options.id]) {
    if (typeof value === "string" && STORY_ID.test(value.trim())) return value.trim();
  }
  return null;
}

/**
 * The single-flight scope of a command, or null when it runs freely.
 * `{ scope: "story" | "repo", key, story }`.
 */
export function classifyCommand(action, options = {}, root = process.cwd()) {
  const base = path.resolve(String(root));
  if (REPO_EXCLUSIVE_ACTIONS.includes(action)) return { scope: "repo", key: `${base}\0repo`, story: null };
  if (!STORY_EXCLUSIVE_ACTIONS.includes(action)) return null;
  const story = storyFromOptions(options);
  return story
    ? { scope: "story", key: `${base}\0story\0${story.toUpperCase()}`, story }
    : { scope: "story", key: `${base}\0command\0${action}`, story: null };
}

export function lockFileFor(commonDir, key) {
  return path.join(locksDirectory(commonDir), `${crypto.createHash("sha1").update(key).digest("hex")}.lock`);
}

function createExclusive(file, holder) {
  const fd = fs.openSync(file, "wx");
  try {
    fs.writeFileSync(fd, `${JSON.stringify(holder)}\n`);
  } finally {
    fs.closeSync(fd);
  }
}

function readHolder(file) {
  try {
    const holder = JSON.parse(fs.readFileSync(file, "utf8"));
    return holder && typeof holder === "object" ? holder : null;
  } catch (error) {
    return error?.code === "ENOENT" ? undefined : null;
  }
}

/**
 * One attempt to take the lock. Returns `{ acquired: true, release }` or
 * `{ acquired: false, holder }`. A stale holder is replaced.
 */
export function tryAcquireLock(file, holder, staleOptions = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      createExclusive(file, holder);
      let held = true;
      const release = () => {
        if (!held) return;
        held = false;
        try {
          if (Number(readHolder(file)?.pid) === Number(holder.pid)) fs.rmSync(file, { force: true });
        } catch {
          // best effort
        }
      };
      return { acquired: true, release };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const current = readHolder(file);
    if (current === undefined) continue;
    if (current && Number(current.pid) === Number(holder.pid)) return { acquired: true, release: () => {} };
    if (!isLockStale(current, staleOptions)) return { acquired: false, holder: current };
    try {
      fs.rmSync(file, { force: true });
    } catch {
      return { acquired: false, holder: current };
    }
  }
  return { acquired: false, holder: readHolder(file) || null };
}

export function waitSeconds(env = process.env) {
  const parsed = Number(String(env?.[WAIT_FOR_LOCK_ENV] ?? "").trim() || 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function busyMessage({ command, story, holder, now = Date.now() }) {
  const minutes = Math.floor(ageMinutes(holder, now));
  const ago = Number.isFinite(minutes) ? `${minutes} min ago` : "at an unknown time";
  const target = story || "this repository";
  return `${command} for ${target} is already running (pid ${holder?.pid ?? "?"}, started ${ago}); `
    + `wait for it, or 'agentic-sdlc runs stop --pid ${holder?.pid ?? "<pid>"}' if stuck.`;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Take the single-flight lock for this command. Returns `{ release }` (a no-op
 * when the command is not classified or outside a repository) or
 * `{ busy: message }` when another live run holds it.
 */
export function acquireSingleFlight({ action, options = {}, root, env = process.env, now = () => Date.now(), wait = sleep, staleOptions = {} }) {
  const none = { release: () => {} };
  const scope = classifyCommand(action, options, root);
  if (!scope) return none;
  const commonDir = findGitCommonDir(root);
  if (!commonDir) return none;
  const file = lockFileFor(commonDir, scope.key);
  const command = action.replaceAll(".", " ");
  const holder = { pid: process.pid, command, story: scope.story, scope: scope.scope, started_at: new Date(now()).toISOString() };
  const deadline = now() + waitSeconds(env) * 1_000;
  for (;;) {
    let result;
    try {
      result = tryAcquireLock(file, holder, { env, ...staleOptions });
    } catch {
      return none;
    }
    if (result.acquired) return { release: result.release, file };
    if (now() >= deadline) return { busy: busyMessage({ command, story: scope.story, holder: result.holder, now: now() }) };
    wait(Math.min(500, Math.max(1, deadline - now())));
  }
}
