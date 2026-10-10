// Freshness rule of a final lifecycle certification: test or release records
// of the story created after the certification (or without a readable time)
// make it stale. Shared by the CLI validation and the Change Observatory.
import { Date } from "../runtime/host.mjs";

export const CERTIFICATION_FRESHNESS_EVENT_TYPES = Object.freeze(["test", "release"]);

export function lifecycleEventsAfterCertification(events, checkedAt) {
  const checkedAtMs = Date.parse(String(checkedAt || ""));
  if (!Number.isFinite(checkedAtMs)) return null;
  return (Array.isArray(events) ? events : [])
    .filter((event) => CERTIFICATION_FRESHNESS_EVENT_TYPES.includes(event?.type))
    .filter((event) => {
      const createdAt = Date.parse(String(event.created_at || ""));
      return !Number.isFinite(createdAt) || createdAt > checkedAtMs;
    });
}
