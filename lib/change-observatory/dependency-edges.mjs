import { redactText } from "../observability/redaction.mjs";

import { ObservatoryPathError, resolveExistingFileWithin, resolveKnowledgeBaseBoundary } from "./path-safety.mjs";
import { readResolvedFileBounded } from "./bounded-file-reader.mjs";

export const OBSERVATORY_DEPENDENCIES_SCHEMA_VERSION = "change-observatory:dependencies:v1";
export const DEPENDENCY_GRAPH_RELATIVE_PATH = "dependencies/graph.json";
const DEFAULT_MAX_GRAPH_BYTES = 32 * 1024 * 1024;
const KEPT_STATUSES = new Set(["approved", "active"]);

/**
 * The approved dependency edges of the project plan, reduced to the story IDs
 * at both ends. The full graph record can outgrow the source preview limit on
 * large projects; this compact projection keeps the plan available there.
 */
export async function readDependencyEdges(projectRoot, {
  redactionPolicy,
  maxBytes = DEFAULT_MAX_GRAPH_BYTES,
} = {}) {
  const boundary = await resolveKnowledgeBaseBoundary(projectRoot);
  let resolved;
  try {
    resolved = await resolveExistingFileWithin(boundary.knowledgeBaseRoot, DEPENDENCY_GRAPH_RELATIVE_PATH);
  } catch (error) {
    if (error instanceof ObservatoryPathError && error.statusCode === 404) return dependencyResult({ found: false });
    throw error;
  }
  const buffer = await readResolvedFileBounded(resolved, {
    maxBytes,
    boundaryCode: "source_boundary_changed",
    tooLargeCode: "dependency_graph_too_large",
    tooLargeMessage: "The dependency graph exceeds the configured response limit",
  });
  let data;
  try {
    data = JSON.parse(buffer.toString("utf8"));
  } catch {
    return dependencyResult({ found: true, error: "The dependency graph is not valid JSON." });
  }
  return dependencyResult({ found: true, edges: compactEdges(data, redactionPolicy) });
}

export function compactEdges(data, redactionPolicy) {
  const edges = [];
  const seen = new Set();
  const plain = (value) => {
    const text = typeof value === "string" ? value.trim() : "";
    return text && redactionPolicy ? redactText(text, redactionPolicy) : text;
  };
  for (const edge of Array.isArray(data?.edges) ? data.edges : []) {
    const from = plain(edge?.from);
    const to = plain(edge?.to);
    if (!from || !to || from === to) continue;
    const status = typeof edge?.status === "string" ? edge.status : null;
    if (status && !KEPT_STATUSES.has(status)) continue;
    const key = `${from}\u0000${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push(status ? { from, to, status } : { from, to });
  }
  return edges;
}

function dependencyResult({ found, edges = [], error = null }) {
  return { schemaVersion: OBSERVATORY_DEPENDENCIES_SCHEMA_VERSION, found, error, edges };
}
