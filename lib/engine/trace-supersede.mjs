import fs from "node:fs";

export const TRACE_SUPERSEDES_VERSION = "trace-supersedes:v1";

function hasEvidence(event) {
  return Array.isArray(event?.evidence) && event.evidence.some(Boolean);
}

/** True for a release event that carries no evidence path at all. */
export function isEvidenceLessRelease(event) {
  return event?.type === "release" && !hasEvidence(event);
}

/**
 * A later release of the same story that names this exact earlier release as
 * the one it supersedes and carries evidence. Only an evidence-less release is
 * ever covered; any other defect of a trace stays an error.
 */
export function findReleaseSupersedingLine(records, record) {
  if (!isEvidenceLessRelease(record?.event)) return null;
  return records.find((candidate) => {
    const event = candidate?.valid ? candidate.event : null;
    const ref = event?.supersedes;
    return Boolean(
      event
      && candidate.line > record.line
      && event.type === "release"
      && event.story_id === record.event.story_id
      && hasEvidence(event)
      && ref?.schema_version === TRACE_SUPERSEDES_VERSION
      && ref.line === record.line
      && ref.event_id === record.event.id
      && (
        !record.event._trace_integrity?.event_hash
        || ref.event_hash === record.event._trace_integrity.event_hash
      ),
    );
  }) || null;
}

/**
 * Resolves the explicit reference stored in a corrective release. The target
 * must be an evidence-less release of the same story that no earlier
 * correction already covers.
 */
export function resolveReleaseSupersedeTarget(tracePath, storyId, rawLine) {
  const line = Number(rawLine);
  if (!Number.isSafeInteger(line) || line < 1 || String(rawLine).trim() !== String(line)) {
    return { error: `--supersedes-line must be a positive trace line number, found '${rawLine}'.` };
  }
  const text = fs.existsSync(tracePath) ? fs.readFileSync(tracePath, "utf8") : "";
  const records = text.split(/\r?\n/u).map((raw, index) => {
    if (!raw) return { line: index + 1, valid: false };
    try {
      return { line: index + 1, valid: true, event: JSON.parse(raw) };
    } catch {
      return { line: index + 1, valid: false };
    }
  });
  const target = records[line - 1];
  if (!target?.valid) return { error: `Trace line ${line} of story ${storyId} does not exist.` };
  if (target.event.story_id !== storyId) {
    return { error: `Trace line ${line} does not belong to story ${storyId}.` };
  }
  if (!isEvidenceLessRelease(target.event)) {
    return {
      error: `Trace line ${line} is not a release trace without evidence; only that defect can be superseded.`,
    };
  }
  if (findReleaseSupersedingLine(records, target)) {
    return { error: `Trace line ${line} is already superseded by a later release trace.` };
  }
  return {
    reference: {
      schema_version: TRACE_SUPERSEDES_VERSION,
      line,
      event_id: target.event.id,
      event_hash: target.event._trace_integrity?.event_hash || null,
    },
  };
}
