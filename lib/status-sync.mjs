// Bringing the local view up to date before status reports it. status reads
// the project's records from this clone; when other computers have merged
// work, the answer is stale until the clone sees it.

/** Environment override of the configured mode, for CI jobs and test runs. */
export const STATUS_SYNC_ENV = "AGENTIC_SDLC_STATUS_SYNC";
export const STATUS_SYNC_MODES = Object.freeze(["off", "fetch", "pull"]);

const DEFAULT_POLICY = Object.freeze({ mode: "fetch" });

/**
 * The validated status sync policy. `fetch` (the default) updates only the
 * remote-tracking branches, so files on disk never change; `pull` also
 * fast-forwards the current branch when it is strictly behind its upstream;
 * `off` reads the clone as it is. invalid(message) reports a wrong value.
 */
export function statusSyncPolicy(configured, invalid) {
  if (configured === undefined || configured === null) return DEFAULT_POLICY;
  if (typeof configured !== "object" || Array.isArray(configured)) {
    invalid("orchestration_policy.status_sync must be an object.");
  }
  const mode = configured.mode ?? DEFAULT_POLICY.mode;
  if (!STATUS_SYNC_MODES.includes(mode)) {
    invalid(`orchestration_policy.status_sync.mode must be one of ${STATUS_SYNC_MODES.join(", ")}.`);
  }
  return Object.freeze({ mode });
}

/** "3\t1" from rev-list --left-right --count as { ahead, behind }, or null. */
export function parseAheadBehind(output) {
  const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(String(output || ""));
  return match ? { ahead: Number(match[1]), behind: Number(match[2]) } : null;
}
