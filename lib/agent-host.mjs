import { process } from "./runtime/host.mjs";
import { fail } from "./cli/user-error.mjs";

/**
 * Agent hosts that can run this CLI, and the environment variables each one
 * sets. When a record carries no explicit --actor or --agent, the detected
 * host names the default agent actor and supplies run metadata. The first
 * host with a marker variable set wins; the override variable selects one by
 * id. With no marker set, the default host keeps the historical attribution.
 */
export const AGENT_HOST_OVERRIDE_ENV = "AGENTIC_SDLC_AGENT_HOST";
export const DEFAULT_AGENT_HOST_ID = "codex";

export const AGENT_HOSTS = Object.freeze([
  Object.freeze({
    id: "codex",
    name: "Codex",
    markers: Object.freeze(["CODEX_AGENT_NAME", "CODEX_THREAD_ID"]),
    env: Object.freeze({
      agent_name: "CODEX_AGENT_NAME",
      run_id: "CODEX_RUN_ID",
      thread_id: "CODEX_THREAD_ID",
      session_id: "CODEX_SESSION_ID",
    }),
  }),
  Object.freeze({
    id: "claude-code",
    name: "Claude Code",
    markers: Object.freeze(["CLAUDECODE"]),
    env: Object.freeze({
      agent_name: null,
      run_id: null,
      thread_id: null,
      session_id: "CLAUDE_CODE_SESSION_ID",
    }),
  }),
]);

function envValue(env, name) {
  if (!name) return null;
  const value = String(env[name] ?? "").trim();
  return value || null;
}

/** The agent host this process runs under, with `detected` false for the fallback. */
export function detectAgentHost(env = process.env) {
  const override = envValue(env, AGENT_HOST_OVERRIDE_ENV);
  if (override) {
    const selected = AGENT_HOSTS.find((host) => host.id === override.toLowerCase());
    if (!selected) {
      fail(`${AGENT_HOST_OVERRIDE_ENV} must be one of: ${AGENT_HOSTS.map((host) => host.id).join(", ")}.`);
    }
    return { ...selected, detected: true };
  }
  const marked = AGENT_HOSTS.find((host) => host.markers.some((name) => envValue(env, name)));
  if (marked) return { ...marked, detected: true };
  return { ...AGENT_HOSTS.find((host) => host.id === DEFAULT_AGENT_HOST_ID), detected: false };
}

/**
 * True when this process runs inside an agent host's own session, judged by
 * the markers the host sets (never by the override, which a person may set
 * to choose a host for metering in their own terminal).
 */
export function runsInsideAgentHost(env = process.env) {
  return AGENT_HOSTS.some((host) => host.markers.some((name) => envValue(env, name)));
}

/** One host-provided value (agent_name, run_id, thread_id, session_id), or null. */
export function agentHostEnvValue(host, field, env = process.env) {
  return envValue(env, host.env[field]);
}

/** True when an actor id names a known agent host, as in "codex" or "claude-code-reviewer". */
export function namesAgentHost(actorId) {
  const normalized = String(actorId || "").toLowerCase();
  return AGENT_HOSTS.some((host) => normalized.includes(host.id));
}
