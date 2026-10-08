import {
  computeStableHash,
  isPlainRecord,
} from "./canonical.mjs";

/**
 * Pure rules shared by every kind of coordination record that agentic-sdlc
 * keeps as git refs on a project's remote: the coordination setting and the
 * sealed one-line payload a record commit carries. Running git lives in
 * lib/engine/shared-refs.mjs; what each record means lives with its owner
 * (standing approvals, story claims).
 */

export const COORDINATION_MODES = Object.freeze(["auto", "required", "local_only"]);
export const COORDINATION_DEFAULTS = Object.freeze({
  mode: "auto",
  remote: "origin",
  timeout_seconds: 20,
});
export const REMOTE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

/**
 * Effective coordination setting: configured values over the documented
 * fallbacks. `setting` names the configuration path in messages; `invalid`
 * throws the caller's own error type.
 */
export function coordinationPolicy(value, { setting, invalid }) {
  const configured = isPlainRecord(value) ? value : {};
  const policy = { ...COORDINATION_DEFAULTS };
  for (const key of Object.keys(COORDINATION_DEFAULTS)) {
    if (configured[key] !== undefined) policy[key] = configured[key];
  }
  if (!COORDINATION_MODES.includes(policy.mode)) {
    invalid(`${setting}.mode must be one of ${COORDINATION_MODES.join(", ")}.`);
  }
  if (typeof policy.remote !== "string" || !REMOTE_NAME_PATTERN.test(policy.remote) || policy.remote.includes("..")) {
    invalid(`${setting}.remote must be a git remote name such as origin.`);
  }
  if (!Number.isSafeInteger(policy.timeout_seconds) || policy.timeout_seconds < 1 || policy.timeout_seconds > 300) {
    invalid(`${setting}.timeout_seconds must be an integer from 1 to 300.`);
  }
  return Object.freeze(policy);
}

/** Adds the hash that lets a reader detect a changed or truncated payload. */
export function sealSharedPayload(record) {
  return { ...record, payload_hash: computeStableHash(record) };
}

/** The commit message that carries a payload: one JSON line. */
export function serializeSharedPayload(payload) {
  return `${JSON.stringify(payload)}\n`;
}

/** The sealed payload of a record commit, or null when it is missing, malformed, or changed. */
export function parseSharedPayload(message) {
  try {
    const value = JSON.parse(String(message || "").trim());
    if (!isPlainRecord(value)) return null;
    const { payload_hash: payloadHash, ...record } = value;
    return payloadHash === computeStableHash(record) ? value : null;
  } catch {
    return null;
  }
}
