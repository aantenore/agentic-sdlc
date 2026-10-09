/**
 * Child processes that cannot hang a command forever.
 *
 * Every synchronous git call made through the host gets a time limit when the
 * caller set none, never waits at a credential prompt, and, when it runs out
 * of time, fails with an error that names the git command and its likely
 * cause. Commands that take longer than a few seconds say on stderr that they
 * are still working (stdout, and so --json output, is never touched), and a
 * slow command ends with its slowest git steps.
 *
 * Limits come from the environment so they reach every computer and every
 * command, including the ones that run before a project is read:
 *   AGENTIC_SDLC_GIT_TIMEOUT_SECONDS  limit for one local git call (default 300, 0 = none)
 *   AGENTIC_SDLC_PROGRESS             "off" silences the progress lines
 */

export const GIT_TIMEOUT_ENV = "AGENTIC_SDLC_GIT_TIMEOUT_SECONDS";
export const PROGRESS_ENV = "AGENTIC_SDLC_PROGRESS";
export const DEFAULT_GIT_TIMEOUT_SECONDS = 300;
// Progress starts once the command has run this long, and repeats no more often.
const PROGRESS_AFTER_MS = 5_000;
const PROGRESS_EVERY_MS = 5_000;
// A command this slow ends with its slowest git steps.
const SUMMARY_AFTER_MS = 30_000;
const SLOWEST_KEPT = 3;

let quiet = false;

/** Long-running commands (the Observatory server) call this: their git calls are never "still working". */
export function silenceProgress() {
  quiet = true;
}

const DURATION_UNITS = Object.freeze({ s: 1, m: 60, h: 3_600, d: 86_400, w: 604_800 });

/** Seconds in a duration such as 90s, 10m, 2h, or a plain number of seconds; 0 turns a limit off; null when unreadable. */
export function parseLimitSeconds(value) {
  const match = /^\s*([0-9]{1,9})\s*([smhdw]?)\s*$/iu.exec(String(value ?? ""));
  if (!match) return null;
  const seconds = Number(match[1]) * DURATION_UNITS[(match[2] || "s").toLowerCase()];
  return Number.isSafeInteger(seconds) ? seconds : null;
}

export function gitTimeoutSeconds(env) {
  const configured = env?.[GIT_TIMEOUT_ENV];
  if (configured === undefined || configured === "") return DEFAULT_GIT_TIMEOUT_SECONDS;
  return parseLimitSeconds(configured) ?? DEFAULT_GIT_TIMEOUT_SECONDS;
}

export function formatSeconds(ms) {
  const seconds = Math.round(ms / 1000);
  return seconds < 120 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

/** "git status --porcelain" without the -C/-c plumbing every call carries. */
export function describeGitCall(args) {
  const shown = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    if (arg === "-C" || arg === "-c") {
      index += 1;
      continue;
    }
    shown.push(arg.length > 40 ? `${arg.slice(0, 37)}...` : arg);
    if (shown.length === 4) break;
  }
  return `git ${shown.join(" ")}`.trim();
}

/** Why a git call that ran out of time probably did, in one sentence. */
export function gitHangHint(args) {
  const command = args.find((arg, index) => !String(arg).startsWith("-") && !["-C", "-c"].includes(args[index - 1]));
  if (["fetch", "push", "ls-remote", "pull", "clone"].includes(command)) {
    return "the remote did not answer: check the network or the credentials of this computer";
  }
  return "another git process may hold the repository (look for a running git or a .git/index.lock left behind), or the repository is very large";
}

function isGit(file) {
  const name = String(file || "").split(/[\\/]/u).pop().toLowerCase();
  return name === "git" || name === "git.exe";
}

/**
 * Wraps a child_process implementation. Only git calls are bounded; every
 * other member is the original. `stderr` and `clock` are injectable for tests.
 */
export function boundChildProcess(real, {
  env = () => globalThis.process.env,
  stderr = (line) => globalThis.process.stderr.write(line),
  clock = () => globalThis.Date.now(),
  startedAt = null,
  label = () => globalThis.process.argv.slice(2, 4).filter((arg) => !String(arg).startsWith("-")).join(" "),
} = {}) {
  const slowest = [];
  // When this process started, read on first use (the host clock is not ready while the host is built).
  let origin = startedAt;
  const startOf = () => {
    if (origin === null) origin = clock() - Math.round(globalThis.process.uptime() * 1000);
    return origin;
  };
  let lastProgressAt = null;
  let summaryArmed = false;

  const prepare = (args, options) => {
    const currentEnv = env();
    const limit = gitTimeoutSeconds(currentEnv);
    const prepared = { ...(options || {}) };
    if (prepared.timeout === undefined && limit > 0) prepared.timeout = limit * 1000;
    const baseEnv = prepared.env || currentEnv;
    if (baseEnv.GIT_TERMINAL_PROMPT === undefined) prepared.env = { ...baseEnv, GIT_TERMINAL_PROMPT: "0" };
    return prepared;
  };

  const progressOff = () => quiet
    || String(env()[PROGRESS_ENV] || "").toLowerCase() === "off"
    || Boolean(env().AGENTIC_SDLC_OBSERVATORY_WORKER);

  const record = (args, began) => {
    const ended = clock();
    const took = ended - began;
    slowest.push({ step: describeGitCall(args), took });
    slowest.sort((left, right) => right.took - left.took);
    slowest.length = Math.min(slowest.length, SLOWEST_KEPT);
    const elapsed = ended - startOf();
    if (progressOff() || elapsed < PROGRESS_AFTER_MS || ended - (lastProgressAt ?? startOf()) < PROGRESS_EVERY_MS) return;
    lastProgressAt = ended;
    const name = label();
    stderr(`agentic-sdlc${name ? ` ${name}` : ""}: still working (${formatSeconds(elapsed)}; last step ${describeGitCall(args)} ${formatSeconds(took)})\n`);
    if (!summaryArmed) {
      summaryArmed = true;
      globalThis.process.once("exit", () => {
        const total = clock() - startOf();
        if (progressOff() || total < SUMMARY_AFTER_MS || slowest.length === 0) return;
        stderr(`agentic-sdlc${name ? ` ${name}` : ""}: took ${formatSeconds(total)}; slowest steps: ${slowest.map((item) => `${item.step} (${formatSeconds(item.took)})`).join(", ")}\n`);
      });
    }
  };

  const explain = (error, args, options) => {
    if (error?.code !== "ETIMEDOUT" || !options?.timeout) return error;
    error.message = `${describeGitCall(args)} did not finish within ${formatSeconds(options.timeout)}: ${gitHangHint(args)}. `
      + `Set ${GIT_TIMEOUT_ENV} to change the limit (0 turns it off). (${error.message})`;
    return error;
  };

  return new Proxy(real, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === "execFileSync") {
        return function execFileSync(file, args = [], options) {
          if (!isGit(file) || !Array.isArray(args)) return value.apply(target, arguments);
          const prepared = prepare(args, options);
          const began = clock();
          try {
            return value.call(target, file, args, prepared);
          } catch (error) {
            throw explain(error, args, prepared);
          } finally {
            record(args, began);
          }
        };
      }
      if (property === "spawnSync") {
        return function spawnSync(file, args = [], options) {
          if (!isGit(file) || !Array.isArray(args)) return value.apply(target, arguments);
          const prepared = prepare(args, options);
          const began = clock();
          const result = value.call(target, file, args, prepared);
          if (result?.error) explain(result.error, args, prepared);
          record(args, began);
          return result;
        };
      }
      return value;
    },
  });
}
