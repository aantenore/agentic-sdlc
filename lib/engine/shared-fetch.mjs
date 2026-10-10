// `story close` fetches the remote once and runs its phases as separate
// commands; this variable tells them the remote is already fresh, so each
// phase skips its own `git fetch`. A retry after a refused push still fetches.

import { process } from "../runtime/host.mjs";

export const SHARED_FETCH_ENV = "AGENTIC_SDLC_FETCHED_REMOTES";

export function remoteAlreadyFetched(remote, env = process.env) {
  return String(env[SHARED_FETCH_ENV] || "").split(",").map((item) => item.trim()).filter(Boolean).includes(String(remote));
}
